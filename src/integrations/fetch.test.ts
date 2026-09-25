import { describe, expect, it } from 'vitest';
import { fetchWithTimeout, INTEGRATION_FETCH_TIMEOUT_MS } from './_fetch.js';

describe('fetchWithTimeout', () => {
  it('exports a 30s default timeout', () => {
    expect(INTEGRATION_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it('returns response on successful fetch', async () => {
    const stubResp = new Response('{"ok":true}', { status: 200 });
    const stubFetch: typeof fetch = (async () => stubResp) as typeof fetch;
    const r = await fetchWithTimeout(
      'https://example.com',
      {},
      { fetchImpl: stubFetch },
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('throws timeout error when fetch never resolves', async () => {
    const ac = new AbortController();
    const stubFetch: typeof fetch = ((_url: unknown, init: unknown) =>
      new Promise<Response>((_, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as
          | AbortSignal
          | undefined;
        sig?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
        setTimeout(() => ac.abort(), 5);
      })) as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://example.com',
        {},
        { fetchImpl: stubFetch, timeoutMs: 10 },
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('respects custom timeout', async () => {
    let receivedSignal: AbortSignal | undefined;
    const stubFetch: typeof fetch = (async (_url: unknown, init: unknown) => {
      receivedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await fetchWithTimeout(
      'https://example.com',
      {},
      { fetchImpl: stubFetch, timeoutMs: 5000 },
    );
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  it('propagates non-timeout errors', async () => {
    const stubFetch: typeof fetch = (async () => {
      throw new Error('Network failure');
    }) as typeof fetch;

    await expect(
      fetchWithTimeout('https://example.com', {}, { fetchImpl: stubFetch }),
    ).rejects.toThrow('Network failure');
  });

  it('merges caller-provided signal with internal timeout signal', async () => {
    const callerAc = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const stubFetch: typeof fetch = (async (_url: unknown, init: unknown) => {
      receivedSignal = (init as RequestInit | undefined)?.signal ?? undefined;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await fetchWithTimeout(
      'https://example.com',
      { signal: callerAc.signal },
      { fetchImpl: stubFetch },
    );
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(callerAc.signal);
  });

  it('aborts when caller signal aborts', async () => {
    const callerAc = new AbortController();
    const stubFetch: typeof fetch = ((_url: unknown, init: unknown) =>
      new Promise<Response>((_, reject) => {
        const sig = (init as RequestInit | undefined)?.signal as
          | AbortSignal
          | undefined;
        sig?.addEventListener('abort', () => {
          const err = new Error('caller aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
        setTimeout(() => callerAc.abort(), 5);
      })) as typeof fetch;

    await expect(
      fetchWithTimeout(
        'https://example.com',
        { signal: callerAc.signal },
        { fetchImpl: stubFetch, timeoutMs: 10000 },
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('throws if no fetch implementation available', async () => {
    const original = globalThis.fetch;
    try {
      (globalThis as unknown as { fetch: typeof fetch | undefined }).fetch =
        undefined;
      await expect(
        fetchWithTimeout('https://example.com', {}, { fetchImpl: undefined }),
      ).rejects.toThrow('No fetch implementation available');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('passes through request init options', async () => {
    let receivedInit: RequestInit | undefined;
    const stubFetch: typeof fetch = (async (_url: unknown, init: unknown) => {
      receivedInit = init as RequestInit | undefined;
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    await fetchWithTimeout(
      'https://example.com',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"test":true}',
      },
      { fetchImpl: stubFetch },
    );

    expect(receivedInit?.method).toBe('POST');
    expect(
      (receivedInit?.headers as Record<string, string>)?.['Content-Type'],
    ).toBe('application/json');
    expect(receivedInit?.body).toBe('{"test":true}');
  });
});

describe('integration handlers use fetchWithTimeout', () => {
  it('GitHub integration imports fetchWithTimeout', async () => {
    const github = await import('./github.js');
    expect(github.GitHubIntegration).toBeDefined();
  });

  it('Linear integration imports fetchWithTimeout', async () => {
    const linear = await import('./linear.js');
    expect(linear.LinearIntegration).toBeDefined();
  });

  it('Notion integration imports fetchWithTimeout', async () => {
    const notion = await import('./notion.js');
    expect(notion.NotionIntegration).toBeDefined();
  });

  it('Home Assistant integration imports fetchWithTimeout', async () => {
    const ha = await import('./home-assistant.js');
    expect(ha.HomeAssistantIntegration).toBeDefined();
  });

  it('Spotify integration imports fetchWithTimeout', async () => {
    const spotify = await import('./spotify.js');
    expect(spotify.SpotifyIntegration).toBeDefined();
  });

  it('Google Drive integration imports fetchWithTimeout', async () => {
    const drive = await import('./google-drive.js');
    expect(drive.GoogleDriveIntegration).toBeDefined();
  });
});
