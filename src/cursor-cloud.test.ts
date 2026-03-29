import { describe, expect, it } from 'vitest';

import {
  computeCursorWebhookSignature,
  CursorCloudApiError,
  CursorCloudClient,
  formatCursorCloudStatusMessage,
  getCursorCloudStatus,
  resolveCursorCloudConfig,
  verifyCursorWebhookSignature,
} from './cursor-cloud.js';

describe('cursor-cloud status', () => {
  it('reports disabled when api key is missing', () => {
    const status = getCursorCloudStatus({ env: {}, envFileValues: {} });

    expect(status.enabled).toBe(false);
    expect(status.baseUrl).toBe('https://api.cursor.com');
    expect(status.hasApiKey).toBe(false);
    expect(status.timeoutMs).toBe(20_000);
    expect(formatCursorCloudStatusMessage(status)).toContain('Next step:');
  });

  it('resolves cloud config from env', () => {
    const config = resolveCursorCloudConfig({
      env: {
        CURSOR_API_BASE_URL: 'https://api.cursor.com/',
        CURSOR_API_KEY: 'cursor-key',
        CURSOR_WEBHOOK_SECRET: 'secret',
        CURSOR_API_TIMEOUT_MS: '12000',
      },
      envFileValues: {},
    });

    expect(config).toEqual({
      baseUrl: 'https://api.cursor.com',
      apiKey: 'cursor-key',
      webhookSecret: 'secret',
      timeoutMs: 12_000,
    });
  });
});

describe('cursor-cloud client', () => {
  it('calls listModels with basic auth', async () => {
    let authHeader = '';
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      authHeader = String(
        (init?.headers as Record<string, string>).Authorization,
      );
      return new Response(
        JSON.stringify({
          models: [{ id: 'default', name: 'Default' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'test-key',
        webhookSecret: null,
        timeoutMs: 10_000,
      },
      { fetchImpl },
    );

    const models = await client.listModels();
    expect(models.models[0].id).toBe('default');
    expect(authHeader).toMatch(/^Basic\s+/);
  });

  it('calls createAgent and serializes request body', async () => {
    let requestBody = '';
    let requestUrl = '';
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = String(init?.body || '');
      return new Response(
        JSON.stringify({
          id: 'bc_123',
          status: 'CREATING',
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'test-key',
        webhookSecret: null,
        timeoutMs: 10_000,
      },
      { fetchImpl },
    );

    const created = await client.createAgent({
      prompt: { text: 'Add README' },
      model: 'default',
      source: { repository: 'https://github.com/example/repo' },
    });

    expect(requestUrl).toBe('https://api.cursor.com/v0/agents');
    expect(requestBody).toContain('Add README');
    expect(created.id).toBe('bc_123');
  });

  it('throws typed api errors on non-2xx responses', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
      })) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'bad-key',
        webhookSecret: null,
        timeoutMs: 10_000,
      },
      { fetchImpl },
    );

    await expect(client.listModels()).rejects.toBeInstanceOf(
      CursorCloudApiError,
    );
    await expect(client.listModels()).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('cursor-cloud webhook signatures', () => {
  it('verifies valid signatures', () => {
    const payload = JSON.stringify({ id: 'bc_1', status: 'FINISHED' });
    const secret = 'my-webhook-secret';
    const signature = computeCursorWebhookSignature(secret, payload);

    expect(verifyCursorWebhookSignature(secret, payload, signature)).toBe(true);
  });

  it('rejects invalid signatures', () => {
    const payload = JSON.stringify({ id: 'bc_1', status: 'ERROR' });
    expect(
      verifyCursorWebhookSignature('my-webhook-secret', payload, 'sha256=bad'),
    ).toBe(false);
  });
});
