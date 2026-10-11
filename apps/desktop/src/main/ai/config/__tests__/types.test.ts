import { describe, it, expect } from 'vitest';
import { buildThinkingProviderOptions } from '../types';
import type { ThinkingLevel } from '../types';

describe('buildThinkingProviderOptions', () => {
  it('should return Anthropic thinking options for Claude models', () => {
    const result = buildThinkingProviderOptions('claude-sonnet-4-6', 'high');
    expect(result).toEqual({
      anthropic: {
        thinking: { type: 'enabled', budgetTokens: 16384 },
      },
    });
  });

  it('should handle Anthropic adaptive thinking models', () => {
    const result = buildThinkingProviderOptions('claude-opus-4-6', 'high');
    expect(result).toBeDefined();
    expect(result?.anthropic?.thinking).toBeDefined();
  });

  it('should return OpenAI reasoning options for o-series models', () => {
    const result = buildThinkingProviderOptions('o3-mini', 'medium');
    expect(result).toEqual({
      openai: { reasoningEffort: 'medium' },
    });
  });

  it('should map xhigh to high for OpenAI', () => {
    const result = buildThinkingProviderOptions('o4-mini', 'xhigh');
    expect(result).toEqual({
      openai: { reasoningEffort: 'high' },
    });
  });

  it('should return Google thinking_level options for Gemini models', () => {
    const result = buildThinkingProviderOptions('gemini-2.5-pro', 'medium');
    expect(result).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'medium' } },
    });
    // Gemini's highest level is 'high'
    expect(buildThinkingProviderOptions('gemini-3.8-flash', 'xhigh')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'high' } },
    });
  });

  it('should return adaptive thinking + effort for Claude 5.5 models (no budget)', () => {
    expect(buildThinkingProviderOptions('claude-opus-5-5', 'high')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    expect(buildThinkingProviderOptions('claude-haiku-5-5', 'xhigh')).toEqual({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'max' },
    });
  });

  it('should force reasoning with an effort for GPT-6 models', () => {
    expect(buildThinkingProviderOptions('gpt-6.1-sol', 'xhigh')).toEqual({
      openai: { forceReasoning: true, reasoningEffort: 'xhigh' },
    });
  });

  it('should return undefined for non-reasoning OpenAI models', () => {
    const result = buildThinkingProviderOptions('gpt-4o', 'high');
    expect(result).toBeUndefined();
  });

  it('should return undefined for providers without thinking support', () => {
    expect(buildThinkingProviderOptions('mistral-large', 'high')).toBeUndefined();
    expect(buildThinkingProviderOptions('llama-3.1-70b', 'high')).toBeUndefined();
  });

  it('should return undefined for unknown model IDs', () => {
    expect(buildThinkingProviderOptions('unknown-model', 'high')).toBeUndefined();
  });

  it('should use correct budget for each thinking level', () => {
    const levels: ThinkingLevel[] = ['low', 'medium', 'high', 'xhigh'];
    const budgets = [1024, 4096, 16384, 32768];

    for (let i = 0; i < levels.length; i++) {
      const result = buildThinkingProviderOptions('claude-sonnet-4-6', levels[i]);
      expect((result?.anthropic?.thinking as { budgetTokens: number })?.budgetTokens).toBe(budgets[i]);
    }
  });
});
