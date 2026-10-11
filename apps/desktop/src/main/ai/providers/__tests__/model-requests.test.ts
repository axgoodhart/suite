/**
 * Request-level tests for model support.
 *
 * Drives the real AI SDK providers (no provider mocks) through createProvider()
 * and the model middleware, with a mocked fetch, and asserts the exact
 * requests that would reach OpenAI, Anthropic and Google.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText, streamText } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildThinkingProviderOptions, MODEL_ID_MAP, usesCodexRequestShape } from '../../config/types';
import { createProvider } from '../factory';
import { withApiKeyFallback, withFastMode } from '../subscription-middleware';
import { SupportedProvider } from '../types';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, any>;
}

let calls: Captured[] = [];
let respond: (call: Captured) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const openAIResponse = (model: string) =>
  json(200, {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    output: [
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });

const anthropicResponse = (model: string) =>
  json(200, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });

const geminiResponse = () =>
  json(200, {
    candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });

function tokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oauth-test-'));
  const file = join(dir, 'tokens.json');
  writeFileSync(
    file,
    JSON.stringify({ access_token: 'sub-token', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }),
  );
  return file;
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const call = { url, headers, body: init?.body ? JSON.parse(String(init.body)) : {} };
    calls.push(call);
    return respond(call);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const inputRoles = (body: Record<string, any>) =>
  (body.input as Array<{ role?: string }>).map((item) => item.role).filter(Boolean);

describe('Claude 5.5 shorthands', () => {
  it('resolve to the 5.5 model IDs', () => {
    expect(MODEL_ID_MAP.opus).toBe('claude-opus-5-5');
    expect(MODEL_ID_MAP['opus-1m']).toBe('claude-opus-5-5');
    expect(MODEL_ID_MAP.sonnet).toBe('claude-sonnet-5-5');
    expect(MODEL_ID_MAP.haiku).toBe('claude-haiku-5-5');
  });
});

describe('OpenAI GPT-6 on a ChatGPT subscription (OAuth)', () => {
  it('sends the system prompt as instructions with store:false to the Codex endpoint', async () => {
    respond = () => openAIResponse('gpt-6.1-sol');
    const model = createProvider({
      config: { provider: SupportedProvider.OpenAI, oauthTokenFilePath: tokenFile() },
      modelId: 'gpt-6.1-sol',
    });

    const result = await generateText({
      model,
      system: 'SYSTEM PROMPT',
      prompt: 'hello',
      providerOptions: buildThinkingProviderOptions('gpt-6.1-sol', 'high') as any,
    });

    expect(result.text).toBe('ok');
    const call = calls[0];
    expect(call.url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(call.headers.authorization).toBe('Bearer sub-token');
    expect(call.body.model).toBe('gpt-6.1-sol');
    expect(call.body.instructions).toBe('SYSTEM PROMPT');
    expect(call.body.store).toBe(false);
    expect(inputRoles(call.body)).not.toContain('system');
    expect(inputRoles(call.body)).not.toContain('developer');
    expect(call.body.reasoning?.effort).toBe('high');
    expect(call.body.temperature).toBeUndefined();
  });

  it('also applies when streaming', async () => {
    respond = () =>
      new Response(
        [
          `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-6-luna' } })}`,
          `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } })}`,
          `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'msg_1', delta: 'ok' })}`,
          `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } })}`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } } })}`,
          '',
        ].join('\n\n'),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const model = createProvider({
      config: { provider: SupportedProvider.OpenAI, oauthTokenFilePath: tokenFile() },
      modelId: 'gpt-6-luna',
    });

    const result = streamText({ model, system: 'SYS', prompt: 'hello' });
    expect(await result.text).toBe('ok');
    expect(calls[0].body.instructions).toBe('SYS');
    expect(calls[0].body.store).toBe(false);
    expect(calls[0].body.stream).toBe(true);
  });
});

describe('OpenAI GPT-6 with an API key', () => {
  it('uses the Responses API with a reasoning effort', async () => {
    respond = () => openAIResponse('gpt-6-luna');
    const model = createProvider({
      config: { provider: SupportedProvider.OpenAI, apiKey: 'sk-test' },
      modelId: 'gpt-6-luna',
    });

    await generateText({
      model,
      system: 'SYS',
      prompt: 'hello',
      providerOptions: buildThinkingProviderOptions('gpt-6-luna', 'xhigh') as any,
    });

    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].body.reasoning?.effort).toBe('xhigh');
    expect(usesCodexRequestShape('gpt-6-luna')).toBe(true);
  });
});

describe('Subscription first, API key fallback', () => {
  const build = () =>
    withApiKeyFallback(
      createProvider({
        config: { provider: SupportedProvider.OpenAI, oauthTokenFilePath: tokenFile() },
        modelId: 'gpt-6.1-sol',
      }),
      createProvider({
        config: { provider: SupportedProvider.OpenAI, apiKey: 'sk-fallback' },
        modelId: 'gpt-6.1-sol',
      }),
    );

  it.each([
    [429, { error: { message: 'You have hit your usage limit', type: 'usage_limit_reached' } }],
    [401, { error: { message: 'Unauthorized' } }],
    [400, { error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }],
  ])('retries on the API key when the subscription returns %s, then stays there', async (status, body) => {
    respond = (call) =>
      call.url.startsWith('https://chatgpt.com') ? json(status, body) : openAIResponse('gpt-6.1-sol');
    const model = build();

    const first = await generateText({ model, system: 'SYS', prompt: 'one', maxRetries: 0 });
    expect(first.text).toBe('ok');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['chatgpt.com', 'api.openai.com']);
    expect(calls[1].headers.authorization).toBe('Bearer sk-fallback');
    // The API request is a normal Responses request (system prompt in input)
    expect(calls[1].body.store).toBeUndefined();

    calls = [];
    await generateText({ model, system: 'SYS', prompt: 'two', maxRetries: 0 });
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['api.openai.com']);
  });

  it('does not fall back on unrelated errors', async () => {
    respond = () => json(500, { error: { message: 'internal error' } });
    await expect(generateText({ model: build(), prompt: 'x', maxRetries: 0 })).rejects.toThrow();
    expect(calls.every((c) => c.url.startsWith('https://chatgpt.com'))).toBe(true);
  });
});

describe('Claude Opus 5.5', () => {
  it('sends adaptive thinking with effort, never a budget', async () => {
    respond = () => anthropicResponse('claude-opus-5-5');
    const model = createProvider({
      config: { provider: SupportedProvider.Anthropic, apiKey: 'sk-ant-api03-test' },
      modelId: 'claude-opus-5-5',
    });

    await generateText({
      model,
      prompt: 'hello',
      providerOptions: buildThinkingProviderOptions('claude-opus-5-5', 'xhigh') as any,
    });

    const body = calls[0].body;
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config?.effort).toBe('max');
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
    expect(body.temperature).toBeUndefined();
  });

  it('sends fast mode, and drops to standard speed if it is refused', async () => {
    let refuseFast = true;
    respond = (call) => {
      if (refuseFast && call.body.speed === 'fast') {
        refuseFast = false;
        return json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Fast mode rate limit exceeded' } });
      }
      return anthropicResponse('claude-opus-5-5');
    };
    const model = withFastMode(
      createProvider({
        config: { provider: SupportedProvider.Anthropic, apiKey: 'sk-ant-api03-test' },
        modelId: 'claude-opus-5-5',
      }),
    );

    const result = await generateText({ model, prompt: 'hello', maxRetries: 0 });
    expect(result.text).toBe('ok');
    expect(calls[0].body.speed).toBe('fast');
    expect(calls[0].headers['anthropic-beta']).toContain('fast-mode-2026-02-01');
    expect(calls[1].body.speed).toBeUndefined();

    calls = [];
    await generateText({ model, prompt: 'again', maxRetries: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.speed).toBeUndefined();
  });

  it('keeps the subscription beta headers alongside fast mode (OAuth)', async () => {
    respond = () => anthropicResponse('claude-opus-5-5');
    const model = withFastMode(
      createProvider({
        config: { provider: SupportedProvider.Anthropic, apiKey: 'sk-ant-oat01-test' },
        modelId: 'claude-opus-5-5',
      }),
    );

    await generateText({ model, prompt: 'hello' });
    const betas = calls[0].headers['anthropic-beta'];
    expect(betas).toContain('oauth-2025-04-20');
    expect(betas).toContain('fast-mode-2026-02-01');
    expect(calls[0].headers.authorization).toBe('Bearer sk-ant-oat01-test');
  });
});

describe('Gemini', () => {
  it('sends thinkingLevel (not thinkingBudget) and no sampling params', async () => {
    respond = () => geminiResponse();
    const model = createProvider({
      config: { provider: SupportedProvider.Google, apiKey: 'g-test' },
      modelId: 'gemini-3.8-flash',
    });

    await generateText({
      model,
      prompt: 'hello',
      providerOptions: buildThinkingProviderOptions('gemini-3.8-flash', 'xhigh') as any,
    });

    expect(calls[0].url).toContain('/models/gemini-3.8-flash:generateContent');
    const config = calls[0].body.generationConfig ?? {};
    expect(config.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    expect(config.temperature).toBeUndefined();
    expect(config.topP).toBeUndefined();
    expect(config.topK).toBeUndefined();
  });
});
