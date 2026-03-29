import { describe, expect, it } from 'vitest';

import {
  CursorDesktopClient,
  formatCursorDesktopStatusMessage,
  getCursorDesktopStatus,
  resolveCursorDesktopConfig,
} from './cursor-desktop.js';

describe('cursor-desktop status', () => {
  it('returns disabled status when bridge env is absent', async () => {
    const status = await getCursorDesktopStatus({
      env: {},
      envFileValues: {},
      probe: true,
      fetchImpl: (async () => {
        throw new Error('should not fetch');
      }) as unknown as typeof fetch,
    });

    expect(status.enabled).toBe(false);
    expect(status.probeStatus).toBe('skipped');
    expect(status.probeDetail).toContain('Bridge URL is missing');
  });

  it('resolves desktop config from env', () => {
    const config = resolveCursorDesktopConfig({
      env: {
        CURSOR_DESKTOP_BRIDGE_URL: 'https://cursor-bridge.example.com/',
        CURSOR_DESKTOP_BRIDGE_TOKEN: 'bridge-token',
        CURSOR_DESKTOP_BRIDGE_TIMEOUT_MS: '45000',
        CURSOR_DESKTOP_BRIDGE_LABEL: 'MacBook Pro',
      },
      envFileValues: {},
    });

    expect(config).toEqual({
      baseUrl: 'https://cursor-bridge.example.com',
      token: 'bridge-token',
      timeoutMs: 45000,
      label: 'MacBook Pro',
    });
  });

  it('probes the desktop bridge health endpoint', async () => {
    const status = await getCursorDesktopStatus({
      env: {
        CURSOR_DESKTOP_BRIDGE_URL: 'https://cursor-bridge.example.com',
        CURSOR_DESKTOP_BRIDGE_TOKEN: 'bridge-token',
      },
      envFileValues: {},
      probe: true,
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe('https://cursor-bridge.example.com/health');
        expect(init?.headers).toMatchObject({
          authorization: 'Bearer bridge-token',
        });
        return new Response(
          JSON.stringify({
            ok: true,
            machineName: 'Jeff-Mac',
            cliPath: '/usr/local/bin/cursor-agent',
            activeRuns: 1,
            trackedSessions: 3,
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(status.enabled).toBe(true);
    expect(status.probeStatus).toBe('ok');
    expect(status.machineName).toBe('Jeff-Mac');
    expect(status.activeRuns).toBe(1);
  });

  it('formats a user-facing desktop status message', () => {
    const message = formatCursorDesktopStatusMessage({
      enabled: true,
      baseUrl: 'https://cursor-bridge.example.com',
      hasToken: true,
      timeoutMs: 30000,
      label: 'Mac',
      probeStatus: 'ok',
      probeDetail: null,
      machineName: 'Jeff-Mac',
      cliPath: '/usr/local/bin/cursor-agent',
      activeRuns: 0,
      trackedSessions: 4,
    });

    expect(message).toContain('*Cursor Desktop Bridge Status*');
    expect(message).toContain('Machine: Jeff-Mac');
    expect(message).toContain('Tracked sessions: 4');
  });
});

describe('CursorDesktopClient', () => {
  it('creates, retrieves, and follows up sessions through the bridge', async () => {
    const calls: string[] = [];

    const client = new CursorDesktopClient(
      {
        baseUrl: 'https://cursor-bridge.example.com',
        token: 'bridge-token',
        timeoutMs: 5000,
        label: null,
      },
      {
        fetchImpl: (async (input: unknown, init?: RequestInit) => {
          calls.push(`${init?.method || 'GET'} ${String(input)}`);

          if (
            String(input) === 'https://cursor-bridge.example.com/v1/sessions' &&
            init?.method === 'POST'
          ) {
            return new Response(
              JSON.stringify({
                id: 'desk_123',
                status: 'RUNNING',
                promptText: 'Fix the flaky test',
                provider: 'desktop',
                createdAt: '2026-03-29T20:00:00.000Z',
                updatedAt: '2026-03-29T20:00:00.000Z',
              }),
              { status: 200 },
            );
          }

          if (
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123' &&
            init?.method === 'GET'
          ) {
            return new Response(
              JSON.stringify({
                id: 'desk_123',
                status: 'COMPLETED',
                promptText: 'Fix the flaky test',
                summary: 'Patched the flaky path.',
                provider: 'desktop',
                cursorSessionId: 'cursor-session-1',
                createdAt: '2026-03-29T20:00:00.000Z',
                updatedAt: '2026-03-29T20:01:00.000Z',
              }),
              { status: 200 },
            );
          }

          if (
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123/followup' &&
            init?.method === 'POST'
          ) {
            return new Response(
              JSON.stringify({
                id: 'desk_123',
                status: 'RUNNING',
                promptText: 'Fix the flaky test',
                summary: 'Follow-up queued.',
                provider: 'desktop',
                cursorSessionId: 'cursor-session-1',
                createdAt: '2026-03-29T20:00:00.000Z',
                updatedAt: '2026-03-29T20:02:00.000Z',
              }),
              { status: 200 },
            );
          }

          throw new Error(`unexpected request: ${String(input)}`);
        }) as unknown as typeof fetch,
      },
    );

    const created = await client.createSession({
      promptText: 'Fix the flaky test',
    });
    expect(created.id).toBe('desk_123');

    const synced = await client.getSession('desk_123');
    expect(synced.status).toBe('COMPLETED');
    expect(synced.cursorSessionId).toBe('cursor-session-1');

    const followed = await client.followupSession('desk_123', {
      promptText: 'Now add the regression test',
    });
    expect(followed.summary).toContain('Follow-up');

    expect(calls).toEqual([
      'POST https://cursor-bridge.example.com/v1/sessions',
      'GET https://cursor-bridge.example.com/v1/sessions/desk_123',
      'POST https://cursor-bridge.example.com/v1/sessions/desk_123/followup',
    ]);
  });
});
