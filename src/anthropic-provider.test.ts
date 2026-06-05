import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runAnthropicText } from './anthropic-provider.js';

const originalFetch = globalThis.fetch;

describe('anthropic provider', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('ANTHROPIC_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://anthropic.test');
    vi.stubEnv('ANTHROPIC_QUOTA_STATE', '');
    vi.stubEnv('ANTHROPIC_MODEL_FAST', 'claude-3-5-haiku-latest');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('sends adaptive thinking effort controls for max council Claude models without returning thinking text', async () => {
    vi.stubEnv('ANTHROPIC_MODEL_COMPLEX', 'claude-sonnet-4-6-test');
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.thinking).toEqual({
          type: 'adaptive',
          display: 'omitted',
        });
        expect(body.output_config).toEqual({ effort: 'max' });
        expect(body.temperature).toBeUndefined();
        return new Response(
          JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'hidden internal analysis' },
              { type: 'text', text: 'Claude final artifact.' },
            ],
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'request-id': 'anthropic-thinking-1',
            },
          },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runAnthropicText({
      prompt: 'reason independently',
      modelTier: 'complex',
      adaptiveThinking: true,
      reasoningEffort: 'max',
      temperature: 0.2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result && 'text' in result ? result.text : '').toBe(
      'Claude final artifact.',
    );
    expect(JSON.stringify(result)).not.toContain('hidden internal analysis');
  });

  it('omits adaptive thinking controls for older Claude models', async () => {
    vi.stubEnv('ANTHROPIC_MODEL_COMPLEX', 'claude-3-5-sonnet-latest');
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        expect(body.thinking).toBeUndefined();
        expect(body.output_config).toBeUndefined();
        expect(body.temperature).toBeGreaterThan(0);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Claude legacy artifact.' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      },
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await runAnthropicText({
      prompt: 'reason independently',
      modelTier: 'complex',
      adaptiveThinking: true,
      reasoningEffort: 'max',
      temperature: 0.2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result && 'text' in result ? result.text : '').toBe(
      'Claude legacy artifact.',
    );
  });
});
