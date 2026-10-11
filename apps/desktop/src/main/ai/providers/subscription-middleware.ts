/**
 * Language-model middleware for subscription (OAuth) accounts.
 *
 * - `codexSubscriptionMiddleware`: the ChatGPT/Codex subscription endpoint
 *   takes the system prompt as Responses `instructions` and requires
 *   `store: false`. Applying it at the model level covers every caller
 *   (agent sessions, runners, title/terminal naming, PR review, …) instead of
 *   relying on each call site to shape the request.
 * - `withApiKeyFallback`: when a subscription account rejects a request
 *   (usage/rate limit, auth, or model not on the plan), retry on the
 *   API-key account and stay on it for the rest of this model's lifetime.
 */

import { wrapLanguageModel } from 'ai';
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';

type ProviderOptions = NonNullable<LanguageModelV3CallOptions['providerOptions']>;

export const codexSubscriptionMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v3',
  transformParams: async ({ params }) => {
    const systemTexts = params.prompt
      .filter((m) => m.role === 'system')
      .map((m) => (m as { content: string }).content)
      .filter((text) => text.length > 0);
    const providerOptions: ProviderOptions = { ...(params.providerOptions ?? {}) };
    const openai = { ...((providerOptions.openai as Record<string, unknown> | undefined) ?? {}) };
    if (systemTexts.length > 0) {
      const existing = typeof openai.instructions === 'string' && openai.instructions.length > 0
        ? [openai.instructions as string]
        : [];
      openai.instructions = [...existing, ...systemTexts].join('\n\n');
    }
    openai.store = false;
    providerOptions.openai = openai as ProviderOptions[string];
    return {
      ...params,
      prompt: params.prompt.filter((m) => m.role !== 'system'),
      providerOptions,
    };
  },
};

/**
 * Whether an error from a subscription account means another account may
 * succeed: usage/rate limit (429), auth (401/403), or the plan not including
 * the model (400/404 mentioning the model).
 */
export function isSubscriptionRejection(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  const message = String(
    (error as { message?: string; responseBody?: string } | null)?.message ?? error,
  ).toLowerCase() + ' ' + String((error as { responseBody?: string } | null)?.responseBody ?? '').toLowerCase();

  if (status === 429 || status === 401 || status === 403) return true;
  if (/\b(429|401|403)\b/.test(message)) return true;
  if (
    message.includes('rate limit') ||
    message.includes('usage limit') ||
    message.includes('usage_limit') ||
    message.includes('quota') ||
    message.includes('unauthorized') ||
    message.includes('authentication')
  ) {
    return true;
  }
  const modelRejected =
    message.includes('model') &&
    ['not supported', 'not available', 'unsupported', 'does not exist', 'not found', 'do not have access', 'does not have access', 'not allowed']
      .some((p) => message.includes(p));
  return modelRejected && (status === undefined || status === 400 || status === 404 || /\b(400|404)\b/.test(message));
}

/**
 * Wrap a subscription-account model so a rejected request is retried on the
 * API-key fallback model. After the first rejection, all later calls go
 * straight to the fallback (no repeated failing subscription attempts).
 */
export function withApiKeyFallback(
  primary: LanguageModel,
  fallback: LanguageModel,
  onFallback?: (error: unknown) => void,
): LanguageModel {
  const fallbackModel = fallback as LanguageModelV3;
  let useFallback = false;
  const switchOver = (error: unknown) => {
    if (!useFallback) {
      useFallback = true;
      onFallback?.(error);
    }
  };

  return wrapLanguageModel({
    model: primary as LanguageModelV3,
    middleware: {
      specificationVersion: 'v3',
      wrapGenerate: async ({ doGenerate, params }) => {
        if (useFallback) return fallbackModel.doGenerate(params);
        try {
          return await doGenerate();
        } catch (error) {
          if (!isSubscriptionRejection(error)) throw error;
          switchOver(error);
          return fallbackModel.doGenerate(params);
        }
      },
      wrapStream: async ({ doStream, params }) => {
        if (useFallback) return fallbackModel.doStream(params);
        try {
          return await doStream();
        } catch (error) {
          if (!isSubscriptionRejection(error)) throw error;
          switchOver(error);
          return fallbackModel.doStream(params);
        }
      },
    },
  });
}

/** Claude models that accept `speed: "fast"` (fast-mode-2026-02-01). */
export const FAST_MODE_MODEL_IDS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
]);

function withoutFastSpeed(params: LanguageModelV3CallOptions): LanguageModelV3CallOptions {
  const anthropic = { ...((params.providerOptions?.anthropic as Record<string, unknown> | undefined) ?? {}) };
  delete anthropic.speed;
  return { ...params, providerOptions: { ...(params.providerOptions ?? {}), anthropic: anthropic as ProviderOptions[string] } };
}

/** Fast mode refused: rate/capacity limited, or not enabled for the account. */
function isFastModeRejection(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  const message = String((error as { message?: string } | null)?.message ?? error).toLowerCase();
  if (status === 429 || status === 529 || /\b(429|529)\b/.test(message)) return true;
  return message.includes('speed') || message.includes('fast mode') || message.includes('fast-mode');
}

/**
 * Run an Anthropic model in fast mode (`speed: "fast"`; the SDK adds the
 * beta header). If fast mode is refused, the request is retried at standard
 * speed and the model stays at standard speed afterwards.
 */
export function withFastMode(
  model: LanguageModel,
  onFallback?: (error: unknown) => void,
): LanguageModel {
  let standardOnly = false;
  const toStandard = (error: unknown) => {
    if (!standardOnly) {
      standardOnly = true;
      onFallback?.(error);
    }
  };
  return wrapLanguageModel({
    model: model as LanguageModelV3,
    middleware: {
      specificationVersion: 'v3',
      transformParams: async ({ params }) => {
        if (standardOnly) return params;
        const providerOptions: ProviderOptions = { ...(params.providerOptions ?? {}) };
        providerOptions.anthropic = {
          ...((providerOptions.anthropic as Record<string, unknown> | undefined) ?? {}),
          speed: 'fast',
        } as ProviderOptions[string];
        return { ...params, providerOptions };
      },
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        try {
          return await doGenerate();
        } catch (error) {
          if (standardOnly || !isFastModeRejection(error)) throw error;
          toStandard(error);
          return inner.doGenerate(withoutFastSpeed(params));
        }
      },
      wrapStream: async ({ doStream, params, model: inner }) => {
        try {
          return await doStream();
        } catch (error) {
          if (standardOnly || !isFastModeRejection(error)) throw error;
          toStandard(error);
          return inner.doStream(withoutFastSpeed(params));
        }
      },
    },
  });
}
