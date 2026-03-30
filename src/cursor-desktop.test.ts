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
    expect(status.terminalAvailable).toBe(false);
    expect(status.agentJobCompatibility).toBe('unknown');
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
            terminalAvailable: true,
            agentJobCompatibility: 'failed',
            agentJobDetail:
              "Warning: 'p' is not in the list of known options, but still passed to Electron/Chromium.",
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    expect(status.enabled).toBe(true);
    expect(status.probeStatus).toBe('ok');
    expect(status.machineName).toBe('Jeff-Mac');
    expect(status.activeRuns).toBe(1);
    expect(status.terminalAvailable).toBe(true);
    expect(status.agentJobCompatibility).toBe('failed');
    expect(status.agentJobDetail).toContain('known options');
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
      terminalAvailable: true,
      agentJobCompatibility: 'unknown',
      agentJobDetail: null,
    });

    expect(message).toContain('*Cursor Desktop Bridge Status*');
    expect(message).toContain('Machine: Jeff-Mac');
    expect(message).toContain('Tracked sessions: 4');
    expect(message).toContain('Terminal control: available');
    expect(message).toContain('Desktop agent jobs: unknown');
  });

  it('formats unavailable desktop agent jobs when the bridge is disabled', () => {
    const message = formatCursorDesktopStatusMessage({
      enabled: false,
      baseUrl: null,
      hasToken: false,
      timeoutMs: 30000,
      label: null,
      probeStatus: 'skipped',
      probeDetail: 'Bridge URL is missing.',
      machineName: null,
      cliPath: null,
      activeRuns: null,
      trackedSessions: null,
      terminalAvailable: false,
      agentJobCompatibility: 'unknown',
      agentJobDetail: null,
    });

    expect(message).toContain('Terminal control: unavailable');
    expect(message).toContain('Desktop agent jobs: unavailable');
    expect(message).toContain('CURSOR_DESKTOP_BRIDGE_URL');
    expect(message).toContain('CURSOR_DESKTOP_BRIDGE_TOKEN');
    expect(message).toContain('Optional next step:');
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
                groupFolder: 'main',
                chatJid: 'tg:42',
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
                groupFolder: 'main',
                chatJid: 'tg:42',
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
                groupFolder: 'main',
                chatJid: 'tg:42',
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
      groupFolder: 'main',
      chatJid: 'tg:42',
    });
    expect(created.id).toBe('desk_123');
    expect(created.groupFolder).toBe('main');
    expect(created.chatJid).toBe('tg:42');

    const synced = await client.getSession('desk_123');
    expect(synced.status).toBe('COMPLETED');
    expect(synced.cursorSessionId).toBe('cursor-session-1');
    expect(synced.groupFolder).toBe('main');
    expect(synced.chatJid).toBe('tg:42');

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

  it('lists tracked bridge sessions with workspace metadata', async () => {
    const client = new CursorDesktopClient(
      {
        baseUrl: 'https://cursor-bridge.example.com',
        token: 'bridge-token',
        timeoutMs: 5000,
        label: null,
      },
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              sessions: [
                {
                  id: 'desk_existing',
                  status: 'RUNNING',
                  promptText: 'Review the open PR',
                  groupFolder: 'main',
                  chatJid: 'tg:42',
                  provider: 'desktop',
                  createdAt: '2026-03-29T20:00:00.000Z',
                  updatedAt: '2026-03-29T20:01:00.000Z',
                },
              ],
            }),
            { status: 200 },
          )) as unknown as typeof fetch,
      },
    );

    const sessions = await client.listSessions(20);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('desk_existing');
    expect(sessions[0].groupFolder).toBe('main');
    expect(sessions[0].chatJid).toBe('tg:42');
  });

  it('starts terminal commands and reads terminal status/output', async () => {
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
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/command' &&
            init?.method === 'POST'
          ) {
            return new Response(
              JSON.stringify({
                commandId: 'term_123',
                terminal: {
                  available: true,
                  status: 'RUNNING',
                  shell: '/bin/zsh',
                  cwd: '/Users/jeff/src/repo',
                  lastCommand: 'git status',
                  activeCommandId: 'term_123',
                  lastCompletedCommandId: null,
                  lastExitCode: null,
                  lastStartedAt: '2026-03-29T20:02:00.000Z',
                  lastFinishedAt: null,
                  activePid: 4444,
                  outputLineCount: 1,
                },
              }),
              { status: 200 },
            );
          }

          if (
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123/terminal' &&
            init?.method === 'GET'
          ) {
            return new Response(
              JSON.stringify({
                available: true,
                status: 'IDLE',
                shell: '/bin/zsh',
                cwd: '/Users/jeff/src/repo',
                lastCommand: 'git status',
                activeCommandId: null,
                lastCompletedCommandId: 'term_123',
                lastExitCode: 0,
                lastStartedAt: '2026-03-29T20:02:00.000Z',
                lastFinishedAt: '2026-03-29T20:02:01.000Z',
                activePid: null,
                outputLineCount: 3,
              }),
              { status: 200 },
            );
          }

          if (
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/output?limit=25&commandId=term_123' &&
            init?.method === 'GET'
          ) {
            return new Response(
              JSON.stringify({
                lines: [
                  {
                    commandId: 'term_123',
                    stream: 'system',
                    text: '$ git status',
                    createdAt: '2026-03-29T20:02:00.000Z',
                  },
                  {
                    commandId: 'term_123',
                    stream: 'stdout',
                    text: 'On branch main',
                    createdAt: '2026-03-29T20:02:01.000Z',
                  },
                ],
              }),
              { status: 200 },
            );
          }

          if (
            String(input) ===
              'https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/stop' &&
            init?.method === 'POST'
          ) {
            return new Response(
              JSON.stringify({
                available: true,
                status: 'STOPPED',
                shell: '/bin/zsh',
                cwd: '/Users/jeff/src/repo',
                lastCommand: 'npm test',
                activeCommandId: null,
                lastCompletedCommandId: 'term_456',
                lastExitCode: null,
                lastStartedAt: '2026-03-29T20:03:00.000Z',
                lastFinishedAt: '2026-03-29T20:03:05.000Z',
                activePid: null,
                outputLineCount: 5,
              }),
              { status: 200 },
            );
          }

          throw new Error(`unexpected request: ${String(input)}`);
        }) as unknown as typeof fetch,
      },
    );

    const started = await client.startTerminalCommand('desk_123', {
      commandText: 'git status',
    });
    expect(started.commandId).toBe('term_123');
    expect(started.terminal.status).toBe('RUNNING');

    const terminal = await client.getTerminalStatus('desk_123');
    expect(terminal.status).toBe('IDLE');
    expect(terminal.lastExitCode).toBe(0);

    const output = await client.listTerminalOutput('desk_123', {
      limit: 25,
      commandId: 'term_123',
    });
    expect(output).toHaveLength(2);
    expect(output[1].text).toContain('On branch main');

    const stopped = await client.stopTerminalCommand('desk_123');
    expect(stopped.status).toBe('STOPPED');

    expect(calls).toEqual([
      'POST https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/command',
      'GET https://cursor-bridge.example.com/v1/sessions/desk_123/terminal',
      'GET https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/output?limit=25&commandId=term_123',
      'POST https://cursor-bridge.example.com/v1/sessions/desk_123/terminal/stop',
    ]);
  });

  it('surfaces plain-text bridge errors without a JSON parse failure', async () => {
    const client = new CursorDesktopClient(
      {
        baseUrl: 'https://cursor-bridge.example.com',
        token: 'bridge-token',
        timeoutMs: 5000,
        label: null,
      },
      {
        fetchImpl: (async () =>
          new Response('bridge temporarily unavailable', {
            status: 502,
            statusText: 'Bad Gateway',
          })) as unknown as typeof fetch,
      },
    );

    await expect(client.health()).rejects.toThrow(
      'bridge temporarily unavailable',
    );
  });

  it('rejects successful bridge responses that are not valid JSON', async () => {
    const client = new CursorDesktopClient(
      {
        baseUrl: 'https://cursor-bridge.example.com',
        token: 'bridge-token',
        timeoutMs: 5000,
        label: null,
      },
      {
        fetchImpl: (async () =>
          new Response('OK', {
            status: 200,
          })) as unknown as typeof fetch,
      },
    );

    await expect(client.health()).rejects.toThrow(
      'Cursor desktop bridge returned an invalid JSON response.',
    );
  });
});
