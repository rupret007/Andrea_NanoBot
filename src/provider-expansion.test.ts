import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getBraveSearchStatus, searchBraveWeb } from './brave-search.js';
import {
  getMiniMaxProviderStatus,
  runMiniMaxAnthropicText,
} from './minimax-provider.js';
import {
  getGeminiProviderStatus,
  runGeminiOpenAiText,
} from './gemini-provider.js';
import {
  buildProviderAlertEvents,
  collectProviderHealthSnapshots,
  formatProviderHealthAlertMessage,
  resolveSystemAlertConfig,
} from './provider-health.js';

const originalFetch = globalThis.fetch;

describe('provider expansion', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_ENABLED;
    delete process.env.MINIMAX_QUOTA_STATE;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_ENABLED;
    delete process.env.GEMINI_QUOTA_STATE;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.BRACE_SEARCH_API_KEY;
    delete process.env.SYSTEM_ALERTS_ENABLED;
    delete process.env.SYSTEM_ALERT_CHANNELS;
    vi.stubEnv('MINIMAX_ENABLED', '');
    vi.stubEnv('MINIMAX_API_KEY', '');
    vi.stubEnv('MINIMAX_QUOTA_STATE', '');
    vi.stubEnv('GEMINI_ENABLED', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GEMINI_QUOTA_STATE', '');
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'false');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', '');
    vi.stubEnv('BRACE_SEARCH_API_KEY', '');
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
  });

  it('accepts the backward-compatible Brace Search env alias', () => {
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'true');
    vi.stubEnv('BRACE_SEARCH_API_KEY', 'test-brave-key');

    const status = getBraveSearchStatus();

    expect(status.configured).toBe(true);
    expect(status.aliasUsed).toBe('BRACE_SEARCH_API_KEY');
  });

  it('calls Brave Search with X-Subscription-Token and parses web results', async () => {
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'true');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-brave-key');
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toContain('/web/search');
      expect(
        (init?.headers as Record<string, string>)['X-Subscription-Token'],
      ).toBe('test-brave-key');
      return new Response(
        JSON.stringify({
          web: {
            results: [
              {
                title: 'Brave result',
                url: 'https://example.com/result',
                description: 'A grounded result.',
              },
            ],
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await searchBraveWeb('andrea provider test');

    expect(result && !('providerFailure' in result)).toBe(true);
    expect(result && 'results' in result ? result.results[0]?.title : '').toBe(
      'Brave result',
    );
  });

  it('parses MiniMax Anthropic-compatible text responses without exposing secrets', async () => {
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    globalThis.fetch = vi.fn(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-minimax-key');
      expect(headers['x-api-key']).toBeUndefined();
      const body = JSON.parse(String(init?.body || '{}')) as {
        messages?: Array<{ content?: unknown }>;
        temperature?: number;
      };
      expect(body.messages?.[0]?.content).toBe('test');
      expect(body.temperature).toBeGreaterThan(0);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'MiniMax grounded answer.' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await runMiniMaxAnthropicText({
      prompt: 'test',
      modelTier: 'complex',
      temperature: 0,
    });

    expect(result && !('providerFailure' in result)).toBe(true);
    expect(result && 'text' in result ? result.text : '').toContain('MiniMax');
  });

  it('parses Gemini OpenAI-compatible text responses without exposing secrets', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-gemini-key');
      const body = JSON.parse(String(init?.body || '{}')) as {
        model?: string;
        messages?: Array<{ role?: string; content?: unknown }>;
        temperature?: number;
      };
      expect(body.model).toBe('gemini-2.5-pro');
      expect(body.messages?.at(-1)?.content).toBe('critique this');
      expect(body.temperature).toBeGreaterThan(0);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Gemini independent critique.',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await runGeminiOpenAiText({
      prompt: 'critique this',
      modelTier: 'critic',
      temperature: 0,
    });

    expect(result && !('providerFailure' in result)).toBe(true);
    expect(result && 'text' in result ? result.text : '').toContain('Gemini');
  });

  it('reports provider and alert metadata without raw credential values', () => {
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.stubEnv('BRAVE_SEARCH_ENABLED', 'true');
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-brave-key');

    const providers = collectProviderHealthSnapshots(
      '2026-05-01T12:00:00.000Z',
    );
    const serialized = JSON.stringify({
      providers,
      alerts: buildProviderAlertEvents(providers, '2026-05-01T12:00:00.000Z'),
    });

    expect(
      providers.some((provider) => provider.providerId === 'minimax_cloud'),
    ).toBe(true);
    expect(
      providers.some((provider) => provider.providerId === 'gemini_cloud'),
    ).toBe(true);
    expect(
      providers.some((provider) => provider.providerId === 'brave_search'),
    ).toBe(true);
    expect(serialized).not.toContain('test-minimax-key');
    expect(serialized).not.toContain('test-gemini-key');
    expect(serialized).not.toContain('test-brave-key');
  });

  it('surfaces MiniMax configuration state separately from OpenAI', () => {
    vi.stubEnv('MINIMAX_ENABLED', 'true');

    const status = getMiniMaxProviderStatus();

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.missing).toContain('MINIMAX_API_KEY');
  });

  it('surfaces Gemini configuration state separately from OpenAI and MiniMax', () => {
    vi.stubEnv('GEMINI_ENABLED', 'true');

    const status = getGeminiProviderStatus();

    expect(status.enabled).toBe(true);
    expect(status.configured).toBe(false);
    expect(status.missing).toContain('GEMINI_API_KEY');
  });

  it('classifies MiniMax balance blockers as external quota blockers', () => {
    vi.stubEnv('MINIMAX_ENABLED', 'true');
    vi.stubEnv('MINIMAX_API_KEY', 'test-minimax-key');
    vi.stubEnv('MINIMAX_QUOTA_STATE', 'insufficient_balance');

    const provider = collectProviderHealthSnapshots(
      '2026-05-01T12:00:00.000Z',
    ).find((snapshot) => snapshot.providerId === 'minimax_cloud');

    expect(provider?.state).toBe('externally_blocked');
    expect(provider?.failureClass).toBe('quota_or_rate_limit');
    expect(provider?.quotaState).toBe('blocked');
    expect(JSON.stringify(provider)).not.toContain('test-minimax-key');
  });

  it('classifies Gemini quota blockers as external provider blockers', () => {
    vi.stubEnv('GEMINI_ENABLED', 'true');
    vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
    vi.stubEnv('GEMINI_QUOTA_STATE', 'rate_limited');

    const provider = collectProviderHealthSnapshots(
      '2026-05-01T12:00:00.000Z',
    ).find((snapshot) => snapshot.providerId === 'gemini_cloud');

    expect(provider?.state).toBe('externally_blocked');
    expect(provider?.failureClass).toBe('quota_or_rate_limit');
    expect(provider?.quotaState).toBe('blocked');
    expect(JSON.stringify(provider)).not.toContain('test-gemini-key');
  });

  it('formats proactive alerts without exposing secret material', () => {
    vi.stubEnv('SYSTEM_ALERT_CHANNELS', 'telegram,bluebubbles');
    vi.stubEnv('SYSTEM_ALERT_COOLDOWN_MINUTES', '15');
    vi.stubEnv('MINIMAX_ENABLED', 'true');

    const config = resolveSystemAlertConfig();
    const provider = collectProviderHealthSnapshots(
      '2026-05-01T12:00:00.000Z',
    ).find((snapshot) => snapshot.providerId === 'minimax_cloud');

    expect(config.channels).toEqual(['telegram', 'bluebubbles']);
    expect(config.cooldownMinutes).toBe(15);
    expect(provider).toBeDefined();

    const message = formatProviderHealthAlertMessage({
      provider: provider!,
      transition: 'down',
      severity: 'info',
    });

    expect(message).toContain('Andrea system alert');
    expect(message).toContain('MINIMAX_API_KEY');
    expect(message).not.toContain('test-minimax-key');
  });
});
