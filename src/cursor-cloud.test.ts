import { describe, expect, it, vi } from 'vitest';

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
    expect(status.authMode).toBe('auto');
    expect(status.timeoutMs).toBe(20_000);
    expect(status.maxRetries).toBe(2);
    expect(status.retryBaseMs).toBe(800);
    expect(formatCursorCloudStatusMessage(status)).toContain(
      'Auth mode: auto (Bearer -> Basic fallback)',
    );
    expect(formatCursorCloudStatusMessage(status)).toContain('Next step:');
    expect(formatCursorCloudStatusMessage(status)).toContain('/cursor-create');
    expect(formatCursorCloudStatusMessage(status)).toContain('/cursor-results');
    expect(formatCursorCloudStatusMessage(status)).toContain(
      '/cursor-download',
    );
  });

  it('resolves cloud config from env', () => {
    const config = resolveCursorCloudConfig({
      env: {
        CURSOR_API_BASE_URL: 'https://api.cursor.com/',
        CURSOR_API_KEY: 'cursor-key',
        CURSOR_API_AUTH_MODE: 'bearer',
        CURSOR_WEBHOOK_SECRET: 'secret',
        CURSOR_API_TIMEOUT_MS: '12000',
        CURSOR_API_MAX_RETRIES: '3',
        CURSOR_API_RETRY_BASE_MS: '250',
      },
      envFileValues: {},
    });

    expect(config).toEqual({
      baseUrl: 'https://api.cursor.com',
      apiKey: 'cursor-key',
      authMode: 'bearer',
      webhookSecret: 'secret',
      timeoutMs: 12_000,
      maxRetries: 3,
      retryBaseMs: 250,
    });
  });

  it('accepts CURSOR_AUTH_MODE as a compatibility alias', () => {
    const status = getCursorCloudStatus({
      env: {
        CURSOR_API_KEY: 'cursor-key',
        CURSOR_AUTH_MODE: 'basic',
      },
      envFileValues: {},
    });

    expect(status.authMode).toBe('basic');
  });
});

describe('cursor-cloud client', () => {
  it('calls listModels with explicit basic auth', async () => {
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
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 0,
        retryBaseMs: 0,
      },
      { fetchImpl },
    );

    const models = await client.listModels();
    expect(models.models[0].id).toBe('default');
    expect(authHeader).toMatch(/^Basic\s+/);
  });

  it('falls back from bearer to basic auth in auto mode', async () => {
    const authHeaders: string[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const authHeader = String(
        (init?.headers as Record<string, string>).Authorization,
      );
      authHeaders.push(authHeader);
      if (authHeaders.length === 1) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
        });
      }
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
        authMode: 'auto',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 0,
        retryBaseMs: 0,
      },
      { fetchImpl },
    );

    const models = await client.listModels();
    expect(models.models[0].id).toBe('default');
    expect(authHeaders).toHaveLength(2);
    expect(authHeaders[0]).toBe('Bearer test-key');
    expect(authHeaders[1]).toMatch(/^Basic\s+/);
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
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 0,
        retryBaseMs: 0,
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

  it('normalizes conversation entries that use text/type fields', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          messages: [
            {
              id: 'm1',
              type: 'user_message',
              text: 'Do the thing',
              role: 'assistant',
              content: '',
            },
            {
              id: 'm2',
              type: 'assistant_message',
              text: 'Done.',
              content: '',
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'test-key',
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 0,
        retryBaseMs: 0,
      },
      { fetchImpl },
    );

    const conversation = await client.getConversation('bc_123');
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Do the thing',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Done.',
    });
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
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 0,
        retryBaseMs: 0,
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

  it('retries transient HTTP failures before succeeding', async () => {
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount += 1;
      if (callCount < 3) {
        return new Response(JSON.stringify({ error: 'try again' }), {
          status: 503,
        });
      }
      return new Response(
        JSON.stringify({
          models: [{ id: 'cu/default' }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'test-key',
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 2,
        retryBaseMs: 0,
      },
      { fetchImpl },
    );

    const response = await client.listModels();
    expect(response.models).toHaveLength(1);
    expect(callCount).toBe(3);
  });

  it('honors retry-after and exhausts retries on repeated 429 responses', async () => {
    let callCount = 0;
    const sleepSpy = vi.spyOn(globalThis, 'setTimeout');
    const fetchImpl = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ error: 'rate-limited' }), {
        status: 429,
        headers: { 'Retry-After': '0' },
      });
    }) as unknown as typeof fetch;

    const client = new CursorCloudClient(
      {
        baseUrl: 'https://api.cursor.com',
        apiKey: 'test-key',
        authMode: 'basic',
        webhookSecret: null,
        timeoutMs: 10_000,
        maxRetries: 1,
        retryBaseMs: 0,
      },
      { fetchImpl },
    );

    await expect(client.listModels()).rejects.toBeInstanceOf(
      CursorCloudApiError,
    );
    expect(callCount).toBe(2);
    expect(sleepSpy).toHaveBeenCalled();
    sleepSpy.mockRestore();
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
