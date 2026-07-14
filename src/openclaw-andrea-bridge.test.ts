import { describe, expect, it } from 'vitest';

import {
  ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS,
  ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
  buildAndreaBlueBubblesMcpConfig,
  buildAndreaBlueBubblesMcpSetConfig,
  formatOpenClawAndreaBridgeDebugStatusLines,
  getOpenClawAndreaBridgeStatusSummary,
  getOpenClawAndreaBridgeStatusSummaryWithHealth,
  resolveBlueBubblesBridgeEnvStatus,
} from './openclaw-andrea-bridge.js';
import type {
  OpenClawStatusSummary,
  OpenClawSyncRunner,
} from './openclaw-connector.js';

const healthyOpenClaw: OpenClawStatusSummary = {
  enabled: true,
  gatewayUrl: 'ws://127.0.0.1:18789',
  cli: 'openclaw',
  gatewayState: 'live',
  gatewayReachable: true,
  cliAvailable: true,
  detail: 'OpenClaw health check is ok.',
  version: '2026.6.11',
  pid: 32159,
  serviceState: 'running',
  defaultModel: 'openai/gpt-5.5',
  authUsable: true,
  authProviders: ['openai'],
  errors: [],
};

const configuredEnv = {
  BLUEBUBBLES_CONTROL_API_ENABLED: 'true',
  BLUEBUBBLES_CONTROL_HOST: '127.0.0.1',
  BLUEBUBBLES_CONTROL_PORT: '4315',
  BLUEBUBBLES_CONTROL_BASE_URL: 'http://127.0.0.1:4315',
  BLUEBUBBLES_CONTROL_TOKEN: 'local-token-for-tests',
};

function buildRunner(outputs: Record<string, string>): OpenClawSyncRunner {
  return (_file, args) => {
    const key = args.join(' ');
    const output = outputs[key];
    if (output === undefined) {
      throw new Error(`Unexpected OpenClaw call: ${key}`);
    }
    return output;
  };
}

function registeredList(repoRoot = '/Users/example/Andrea_NanoBot_AGI') {
  return JSON.stringify({
    [ANDREA_BLUEBUBBLES_MCP_SERVER_NAME]: buildAndreaBlueBubblesMcpSetConfig(
      buildAndreaBlueBubblesMcpConfig(repoRoot),
    ),
  });
}

function successfulProbe(
  toolNames: string[] = [...ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS],
) {
  return [
    '[state-migrations] warning before JSON',
    JSON.stringify({
      [ANDREA_BLUEBUBBLES_MCP_SERVER_NAME]: {
        tools: toolNames.map((name) => ({ name })),
      },
      tools: toolNames.map(
        (name) => `${ANDREA_BLUEBUBBLES_MCP_SERVER_NAME}__${name}`,
      ),
    }),
  ].join('\n');
}

describe('OpenClaw Andrea BlueBubbles bridge', () => {
  it('builds a local MCP config that excludes direct BlueBubbles sends', () => {
    const config = buildAndreaBlueBubblesMcpConfig(
      '/Users/example/Andrea_NanoBot_AGI',
    );

    expect(config.command).toBe('node');
    expect(config.cwd).toBe('/Users/example/Andrea_NanoBot_AGI');
    expect(config.args).toEqual([
      'scripts/run-with-pinned-node.mjs',
      './node_modules/tsx/dist/cli.mjs',
      'src/bluebubbles-control-mcp.ts',
    ]);
    expect(config.include).toEqual([...ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS]);
    expect(config.exclude).toEqual(['bluebubbles_send']);
  });

  it('reports missing BlueBubbles control API env distinctly', () => {
    const envStatus = resolveBlueBubblesBridgeEnvStatus({});

    expect(envStatus.configured).toBe(false);
    expect(envStatus.detail).toContain('BlueBubbles external config missing');
    expect(envStatus.missingValues).toContain(
      'BLUEBUBBLES_CONTROL_TOKEN=<local random token>',
    );
  });

  it('reports a missing OpenClaw MCP server as offline', () => {
    const status = getOpenClawAndreaBridgeStatusSummary({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': '{}',
      }),
      env: configuredEnv,
    });

    expect(status.state).toBe('offline');
    expect(status.registrationState).toBe('missing');
    expect(status.blocker).toContain('not registered');
  });

  it('reports missing BlueBubbles env after MCP registration', () => {
    const status = getOpenClawAndreaBridgeStatusSummary({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': registeredList(),
      }),
      env: {},
    });

    expect(status.state).toBe('degraded');
    expect(status.registrationState).toBe('registered');
    expect(status.blocker).toContain('BlueBubbles external config missing');
    expect(status.probeOk).toBeNull();
  });

  it('reports an MCP probe failure distinctly', () => {
    const status = getOpenClawAndreaBridgeStatusSummary({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': registeredList(),
        'mcp probe andrea-bluebubbles --json':
          'BLUEBUBBLES_CONTROL_TOKEN=super-secret failed',
      }),
      env: configuredEnv,
    });

    expect(status.state).toBe('degraded');
    expect(status.probeOk).toBe(false);
    expect(status.blocker).toContain('did not include a JSON object');
    expect(
      formatOpenClawAndreaBridgeDebugStatusLines(status).join('\n'),
    ).not.toContain('super-secret');
  });

  it('reports a configured probe without exposing direct send', () => {
    const status = getOpenClawAndreaBridgeStatusSummary({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': registeredList(),
        'mcp probe andrea-bluebubbles --json': successfulProbe(),
      }),
      env: configuredEnv,
    });

    expect(status.state).toBe('configured');
    expect(status.probeOk).toBe(true);
    expect(status.requiredToolsAvailable).toBe(true);
    expect(status.directSendExposed).toBe(false);
    expect(status.missingTools).toEqual([]);
  });

  it('reports live only after BlueBubbles control health succeeds', async () => {
    const status = await getOpenClawAndreaBridgeStatusSummaryWithHealth({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': registeredList(),
        'mcp probe andrea-bluebubbles --json': successfulProbe(),
      }),
      env: configuredEnv,
      controlHealthProbe: async () => ({
        checked: true,
        reachable: true,
        ok: true,
        statusCode: 200,
        connected: true,
        proofState: 'degraded_but_usable',
        detail: 'healthy',
      }),
    });

    expect(status.state).toBe('live');
    expect(status.controlHealth.ok).toBe(true);
  });

  it('degrades if OpenClaw exposes direct BlueBubbles send', () => {
    const status = getOpenClawAndreaBridgeStatusSummary({
      repoRoot: '/Users/example/Andrea_NanoBot_AGI',
      openClawSummary: healthyOpenClaw,
      runner: buildRunner({
        'mcp list --json': registeredList(),
        'mcp probe andrea-bluebubbles --json': successfulProbe([
          ...ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS,
          'bluebubbles_send',
        ]),
      }),
      env: configuredEnv,
    });

    expect(status.state).toBe('degraded');
    expect(status.directSendExposed).toBe(true);
    expect(status.blocker).toContain('bluebubbles_send');
  });
});
