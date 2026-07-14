import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildOpenClawChatSessionKey,
  buildOpenClawMediaGroundedPrompt,
  delegateToOpenClawAgent,
  formatOpenClawDelegationResponse,
  formatOpenClawDebugStatusLines,
  getOpenClawStatusSummary,
  isOpenClawOwnerControlSurface,
  parseOpenClawDelegationRequest,
  parseOpenClawJsonOutput,
  redactOpenClawText,
  resolveOpenClawDelegationRoute,
  type OpenClawAsyncRunner,
  type OpenClawConnectorConfig,
  type OpenClawSyncRunner,
} from './openclaw-connector.js';

const baseConfig: OpenClawConnectorConfig = {
  enabled: true,
  delegationEnabled: false,
  gatewayUrl: 'ws://127.0.0.1:18789',
  cli: 'openclaw',
  agentId: 'main',
  statusTimeoutMs: 5000,
};

function buildRunner(
  outputs: Record<string, string>,
  calls: string[][] = [],
): OpenClawSyncRunner {
  return (_file, args) => {
    calls.push([...args]);
    const key = args.join(' ');
    const output = outputs[key];
    if (output === undefined)
      throw new Error(`Unexpected OpenClaw call: ${key}`);
    return output;
  };
}

describe('OpenClaw connector', () => {
  it('grounds delegated media turns in a bounded summary or an honest blocker', () => {
    expect(
      buildOpenClawMediaGroundedPrompt({
        prompt: 'Can you see this meal plan?',
        mediaSummary: 'The image shows a seven-day meal schedule.',
      }),
    ).toContain('Verified attachment context prepared by Andrea');
    expect(
      buildOpenClawMediaGroundedPrompt({
        prompt: 'Can you see this meal plan?',
        mediaSummary: 'The image shows a seven-day meal schedule.',
      }),
    ).toContain('Do not claim direct access to image bytes');
    expect(
      buildOpenClawMediaGroundedPrompt({
        prompt: 'Can you see this?',
        mediaBlocker: 'The media cache is unavailable.',
      }),
    ).toContain('do not infer its contents');
  });

  it('summarizes a healthy gateway without leaking auth labels', () => {
    const calls: string[][] = [];
    const runner = buildRunner(
      {
        'health --json': '{"ok":true,"status":"live"}',
        'status --json --timeout 5000': [
          '[state-migrations] warning before JSON',
          JSON.stringify({
            runtimeVersion: '2026.6.11',
            gateway: {
              url: 'ws://127.0.0.1:18789',
              reachable: true,
              self: { version: '2026.6.11' },
            },
            gatewayService: {
              loadedText: 'loaded',
              runtime: { status: 'running', pid: 32159 },
            },
          }),
        ].join('\n'),
        'models status --json': JSON.stringify({
          defaultModel: 'openai/gpt-5.5',
          auth: {
            runtimeAuthRoutes: [
              {
                provider: 'openai',
                status: 'usable',
                label: 'openai:manual=sk-proj-super-secret',
              },
            ],
            providers: [
              {
                provider: 'openai',
                label: 'openai:manual=sk-proj-super-secret',
              },
            ],
          },
        }),
      },
      calls,
    );

    const summary = getOpenClawStatusSummary(baseConfig, runner);
    const statusText = formatOpenClawDebugStatusLines(summary).join('\n');

    expect(summary.gatewayState).toBe('live');
    expect(summary.gatewayReachable).toBe(true);
    expect(summary.version).toBe('2026.6.11');
    expect(summary.pid).toBe(32159);
    expect(summary.serviceState).toBe('running');
    expect(summary.defaultModel).toBe('openai/gpt-5.5');
    expect(summary.authUsable).toBe(true);
    expect(summary.authProviders).toEqual(['openai']);
    expect(statusText).toContain('OpenClaw gateway: live');
    expect(statusText).toContain('OpenClaw provider auth: usable (openai)');
    expect(statusText).not.toContain('sk-proj');
    expect(statusText).not.toContain('manual=');
    expect(calls).toEqual([
      ['health', '--json'],
      ['status', '--json', '--timeout', '5000'],
      ['models', 'status', '--json'],
    ]);
  });

  it('reports a missing OpenClaw CLI as offline', () => {
    const runner: OpenClawSyncRunner = () => {
      const error = new Error('spawn openclaw ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    };

    const summary = getOpenClawStatusSummary(baseConfig, runner);

    expect(summary.gatewayState).toBe('offline');
    expect(summary.cliAvailable).toBe(false);
    expect(summary.gatewayReachable).toBe(false);
    expect(summary.detail).toContain('OpenClaw CLI not found');
  });

  it('reports an unreachable gateway as offline', () => {
    const runner = buildRunner({
      'health --json': JSON.stringify({
        ok: false,
        status: 'offline',
        error: 'connect ECONNREFUSED 127.0.0.1:18789',
      }),
      'status --json --timeout 5000': JSON.stringify({
        gateway: {
          reachable: false,
          error: 'connect ECONNREFUSED 127.0.0.1:18789',
        },
      }),
      'models status --json': '{"auth":{"runtimeAuthRoutes":[]}}',
    });

    const summary = getOpenClawStatusSummary(baseConfig, runner);

    expect(summary.gatewayState).toBe('offline');
    expect(summary.gatewayReachable).toBe(false);
    expect(summary.detail).toContain('ECONNREFUSED');
  });

  it('extracts JSON after warning preambles', () => {
    expect(
      parseOpenClawJsonOutput('warning one\nwarning two\n{"ok":true}'),
    ).toEqual({ ok: true });
  });

  it('redacts bridge tokens, bearer values, and OpenClaw auth profile labels', () => {
    const redacted = redactOpenClawText(
      [
        'BLUEBUBBLES_CONTROL_TOKEN=bb-secret-token',
        'Authorization: Bearer bb-super-secret-bearer',
        'profile=openai:manual=sk-proj-super-secret',
        'OPENAI_API_KEY=sk-proj-another-secret',
      ].join(' '),
    );

    expect(redacted).toContain('BLUEBUBBLES_CONTROL_TOKEN=[redacted]');
    expect(redacted).toContain('Authorization=[redacted]');
    expect(redacted).toContain('profile=[redacted]');
    expect(redacted).not.toContain('bb-secret-token');
    expect(redacted).not.toContain('bb-super-secret-bearer');
    expect(redacted).not.toContain('manual=');
    expect(redacted).not.toContain('sk-proj');
  });

  it('detects explicit OpenClaw delegation requests only', () => {
    expect(parseOpenClawDelegationRequest('/openclaw hi')).toEqual({
      prompt: 'hi',
      command: 'slash',
    });
    expect(
      parseOpenClawDelegationRequest('ask OpenClaw: check status'),
    ).toEqual({
      prompt: 'check status',
      command: 'natural',
    });
    expect(parseOpenClawDelegationRequest('ordinary Andrea turn')).toBeNull();
  });

  it('treats substantive @openclaw mentions as delegation requests', () => {
    expect(
      parseOpenClawDelegationRequest(
        '@openclaw research the best flight prices for Friday',
      ),
    ).toEqual({
      prompt: 'research the best flight prices for Friday',
      command: 'mention',
    });
    expect(
      parseOpenClawDelegationRequest('@openclaw, summarize my open work'),
    ).toEqual({
      prompt: 'summarize my open work',
      command: 'mention',
    });
  });

  it('leaves presence pings and skill-catalog mentions to existing lanes', () => {
    expect(parseOpenClawDelegationRequest('@openclaw')).toBeNull();
    expect(
      parseOpenClawDelegationRequest('@openclaw are you there?'),
    ).toBeNull();
    expect(parseOpenClawDelegationRequest('@openclaw hello')).toBeNull();
    expect(
      parseOpenClawDelegationRequest('@openclaw enable skill weather-pro'),
    ).toBeNull();
    expect(
      parseOpenClawDelegationRequest('@openclaw search skills for calendars'),
    ).toBeNull();
    expect(
      parseOpenClawDelegationRequest('hey @openclaw can you help mid-sentence'),
    ).toBeNull();
  });

  it('builds sanitized per-chat session keys', () => {
    expect(buildOpenClawChatSessionKey('tg:100000001', 'main')).toBe(
      'agent:main:andrea-chat:tg-100000001',
    );
    expect(buildOpenClawChatSessionKey('', 'main')).toBe(
      'agent:main:andrea-chat:default',
    );
    expect(buildOpenClawChatSessionKey('123@g.us/weird chars!!', 'main')).toBe(
      'agent:main:andrea-chat:123-g.us-weird-chars',
    );
  });

  it('delegates through openclaw agent without direct delivery', async () => {
    const capturedCalls: {
      file: string;
      args: string[];
      options: { encoding: 'utf8'; timeout: number };
    }[] = [];
    const runner: OpenClawAsyncRunner = async (file, args, options) => {
      capturedCalls.push({ file, args: [...args], options });
      const messageFileIndex = args.indexOf('--message-file');
      expect(messageFileIndex).toBeGreaterThan(-1);
      expect(await fs.readFile(args[messageFileIndex + 1], 'utf8')).toBe(
        'cloud-capable check',
      );
      return '{"reply":"OpenClaw reply"}';
    };

    const result = await delegateToOpenClawAgent({
      message: 'cloud-capable check',
      config: { ...baseConfig, delegationEnabled: true },
      runner,
      timeoutMs: 1234,
      skipPreflight: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reply).toBe('OpenClaw reply');
    const captured = capturedCalls[0];
    expect(captured).toBeDefined();
    if (!captured) throw new Error('Expected OpenClaw runner to be called.');
    expect(captured.file).toBe('openclaw');
    expect(captured.args.slice(0, 7)).toEqual([
      'agent',
      '--json',
      '--agent',
      'main',
      '--session-key',
      'agent:main:andrea-bridge',
      '--message-file',
    ]);
    expect(captured.args).not.toContain('--deliver');
    expect(captured.options.timeout).toBe(1234);
  });

  it('uses the provided per-chat session key when delegating', async () => {
    const capturedArgs: string[][] = [];
    const runner: OpenClawAsyncRunner = async (_file, args) => {
      capturedArgs.push([...args]);
      return '{"reply":"OpenClaw reply"}';
    };

    const result = await delegateToOpenClawAgent({
      message: 'per-chat session check',
      config: { ...baseConfig, delegationEnabled: true },
      runner,
      sessionKey: buildOpenClawChatSessionKey('tg:100000001', 'main'),
      skipPreflight: true,
    });

    expect(result.ok).toBe(true);
    const args = capturedArgs[0];
    if (!args) throw new Error('Expected OpenClaw runner to be called.');
    const sessionKeyIndex = args.indexOf('--session-key');
    expect(args[sessionKeyIndex + 1]).toBe(
      'agent:main:andrea-chat:tg-100000001',
    );
  });

  it('captures OpenClaw agent payload replies', async () => {
    const runner: OpenClawAsyncRunner = async () =>
      JSON.stringify({
        status: 'ok',
        result: {
          payloads: [{ text: 'payload reply', mediaUrl: null }],
          meta: {
            finalPromptText: 'do not return this',
            finalAssistantVisibleText: 'visible reply',
          },
        },
      });

    const result = await delegateToOpenClawAgent({
      message: 'prompt',
      config: { ...baseConfig, delegationEnabled: true },
      runner,
      skipPreflight: true,
    });

    expect(result.ok).toBe(true);
    expect(result.reply).toBe('visible reply');
  });

  it('does not call OpenClaw when delegation is disabled', async () => {
    let called = false;
    const runner: OpenClawAsyncRunner = async () => {
      called = true;
      return '{"reply":"unexpected"}';
    };

    const result = await delegateToOpenClawAgent({
      message: 'ask cloud',
      config: { ...baseConfig, delegationEnabled: false },
      runner,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('delegation is disabled');
    expect(called).toBe(false);
  });

  it('formats mention-style replies without the Andrea wrapper', () => {
    expect(
      formatOpenClawDelegationResponse(
        {
          ok: true,
          reply: 'Tokyo is 9 hours ahead of UTC.',
          detail: '',
          agentId: 'main',
        },
        'mention',
      ),
    ).toBe('Tokyo is 9 hours ahead of UTC.');
  });

  it('formats operator-style replies with the Andrea wrapper', () => {
    const text = formatOpenClawDelegationResponse({
      ok: true,
      reply: 'Gateway is live.',
      detail: '',
      agentId: 'main',
    });
    expect(text).toContain('OpenClaw answered through Andrea:');
    expect(text).toContain('Gateway is live.');
  });

  it('maps delegation errors to actionable hints', () => {
    const cliMissing = formatOpenClawDelegationResponse({
      ok: false,
      reply: '',
      detail: 'OpenClaw CLI not found: openclaw',
      agentId: 'main',
    });
    expect(cliMissing).toContain('OPENCLAW_CLI');
    expect(cliMissing).toContain('which openclaw');

    const gatewayDown = formatOpenClawDelegationResponse({
      ok: false,
      reply: '',
      detail: 'OpenClaw gateway is not reachable; run openclaw health.',
      agentId: 'main',
    });
    expect(gatewayDown).toContain('openclaw health');

    const timeout = formatOpenClawDelegationResponse({
      ok: false,
      reply: '',
      detail: 'spawn openclaw ETIMEDOUT',
      agentId: 'main',
    });
    expect(timeout).toContain('took too long');
  });

  it('resolves delegation routes for main chat and fallthrough cases', () => {
    expect(
      resolveOpenClawDelegationRoute({
        rawMessage: '@openclaw research flights',
        mainControlChat: true,
        delegationEnabled: true,
      }),
    ).toEqual({
      action: 'delegate',
      request: {
        prompt: 'research flights',
        command: 'mention',
      },
    });

    expect(
      resolveOpenClawDelegationRoute({
        rawMessage: '@openclaw research flights',
        mainControlChat: true,
        delegationEnabled: false,
      }),
    ).toEqual({
      action: 'fallthrough',
      request: {
        prompt: 'research flights',
        command: 'mention',
      },
    });

    expect(
      resolveOpenClawDelegationRoute({
        rawMessage: '@openclaw are you there?',
        mainControlChat: true,
        delegationEnabled: true,
      }),
    ).toEqual({ action: 'none' });

    expect(
      resolveOpenClawDelegationRoute({
        rawMessage: '/openclaw status',
        mainControlChat: false,
        delegationEnabled: true,
      }),
    ).toEqual({
      action: 'restrict',
      request: { prompt: 'status', command: 'slash' },
    });

    expect(
      resolveOpenClawDelegationRoute({
        rawMessage: 'ask OpenClaw: summarize my week',
        mainControlChat: true,
        delegationEnabled: true,
      }),
    ).toEqual({
      action: 'delegate',
      request: { prompt: 'summarize my week', command: 'natural' },
    });
  });

  it('allows OpenClaw only on private owner-control surfaces', () => {
    expect(isOpenClawOwnerControlSurface({ mainControlChat: true })).toBe(true);
    expect(
      isOpenClawOwnerControlSurface({
        mainControlChat: false,
        channelName: 'bluebubbles',
        blueBubblesSelfThread: true,
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnerControlSurface({
        mainControlChat: false,
        channelName: 'bluebubbles',
        blueBubblesSelfThread: false,
      }),
    ).toBe(false);
    expect(
      isOpenClawOwnerControlSurface({
        mainControlChat: false,
        channelName: 'telegram',
        blueBubblesSelfThread: true,
      }),
    ).toBe(false);
  });

  it('fails fast when the gateway preflight is not live', async () => {
    const statusRunner: OpenClawSyncRunner = () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18789');
    };
    let agentCalled = false;
    const runner: OpenClawAsyncRunner = async () => {
      agentCalled = true;
      return '{"reply":"unexpected"}';
    };

    const result = await delegateToOpenClawAgent({
      message: 'preflight check',
      config: { ...baseConfig, delegationEnabled: true },
      runner,
      statusRunner,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not reachable');
    expect(agentCalled).toBe(false);
  });

  it('reports empty agent replies as delegation failures', async () => {
    const runner: OpenClawAsyncRunner = async () =>
      '{"status":"ok","result":{}}';

    const result = await delegateToOpenClawAgent({
      message: 'no reply body',
      config: { ...baseConfig, delegationEnabled: true },
      runner,
      skipPreflight: true,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('did not include reply text');
  });
});
