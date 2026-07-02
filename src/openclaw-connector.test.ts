import fs from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  delegateToOpenClawAgent,
  formatOpenClawDebugStatusLines,
  getOpenClawStatusSummary,
  parseOpenClawDelegationRequest,
  parseOpenClawJsonOutput,
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
});
