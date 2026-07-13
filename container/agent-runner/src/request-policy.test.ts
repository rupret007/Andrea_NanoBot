import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSdkMcpBoundaryConfig,
  buildSdkToolPolicy,
  normalizeRequestPolicy,
  type RuntimeRequestPolicy,
} from './request-policy.js';

function policy(
  overrides: Partial<RuntimeRequestPolicy> = {},
): RuntimeRequestPolicy {
  return {
    route: 'protected_assistant',
    reason: 'test',
    builtinTools: ['Read', 'WebSearch'],
    mcpTools: ['mcp__nanoclaw__schedule_task'],
    guidance: 'test guidance',
    ...overrides,
  };
}

describe('container agent request policy', () => {
  it('forces direct assistant turns to an empty tool surface', () => {
    const normalized = normalizeRequestPolicy(
      policy({
        route: 'direct_assistant',
        builtinTools: ['Bash', 'Read'],
        mcpTools: ['mcp__nanoclaw__send_message'],
      }),
    );
    assert.deepEqual(normalized.builtinTools, []);
    assert.deepEqual(normalized.mcpTools, []);
    assert.deepEqual(buildSdkToolPolicy(normalized), {
      tools: [],
      allowedTools: [],
      useMcpServer: false,
    });
  });

  it('uses the exact built-in list and only the explicitly allowed MCP tools', () => {
    assert.deepEqual(buildSdkToolPolicy(policy()), {
      tools: ['Read', 'WebSearch'],
      allowedTools: ['Read', 'WebSearch', 'mcp__nanoclaw__schedule_task'],
      useMcpServer: true,
    });
  });

  it('removes MCP tools during recovery without widening built-ins', () => {
    assert.deepEqual(buildSdkToolPolicy(policy(), { fallbackMode: true }), {
      tools: ['Read', 'WebSearch'],
      allowedTools: ['Read', 'WebSearch'],
      useMcpServer: false,
    });
  });

  it('always enables strict MCP configuration and exposes only the explicit server', () => {
    const server = {
      command: 'node',
      args: ['/tmp/ipc-mcp-stdio.js'],
      env: { NANOCLAW_ALLOWED_MCP_TOOLS: '[]' },
    };
    assert.deepEqual(buildSdkMcpBoundaryConfig(true, server), {
      strictMcpConfig: true,
      mcpServers: { nanoclaw: server },
    });
    assert.deepEqual(buildSdkMcpBoundaryConfig(false, server), {
      strictMcpConfig: true,
      mcpServers: undefined,
    });
  });

  it('fails closed on missing, malformed, unknown-route, and unknown-tool policies', () => {
    const candidates = [
      normalizeRequestPolicy(),
      normalizeRequestPolicy(policy({ route: 'untrusted' })),
      normalizeRequestPolicy(policy({ builtinTools: ['ShellOfDoom'] })),
      normalizeRequestPolicy(policy({ mcpTools: ['mcp__evil__send'] })),
      normalizeRequestPolicy({
        ...policy(),
        builtinTools: null,
      } as unknown as RuntimeRequestPolicy),
    ];
    for (const candidate of candidates) {
      assert.equal(candidate.route, 'direct_assistant');
      assert.deepEqual(candidate.builtinTools, []);
      assert.deepEqual(candidate.mcpTools, []);
    }
  });

  it('fails closed when a known tool crosses a protected or control route boundary', () => {
    for (const candidate of [
      normalizeRequestPolicy(policy({ builtinTools: ['Bash'] })),
      normalizeRequestPolicy(
        policy({
          route: 'control_plane',
          builtinTools: ['Write'],
          mcpTools: ['mcp__nanoclaw__list_tasks'],
        }),
      ),
      normalizeRequestPolicy(
        policy({
          route: 'protected_assistant',
          builtinTools: ['Read'],
          mcpTools: ['mcp__nanoclaw__send_message'],
        }),
      ),
      normalizeRequestPolicy(
        policy({
          route: 'advanced_helper',
          builtinTools: ['Bash'],
          mcpTools: ['mcp__nanoclaw__create_cursor_agent'],
        }),
      ),
      normalizeRequestPolicy(
        policy({
          route: 'code_plane',
          builtinTools: ['Bash'],
          mcpTools: ['mcp__nanoclaw__create_cursor_agent'],
        }),
      ),
    ]) {
      assert.equal(candidate.route, 'direct_assistant');
      assert.deepEqual(candidate.builtinTools, []);
      assert.deepEqual(candidate.mcpTools, []);
    }
  });

  it('accepts host maximums while keeping shell and host actions separate', () => {
    const protectedPolicy = normalizeRequestPolicy(
      policy({
        builtinTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
        mcpTools: ['mcp__nanoclaw__schedule_task'],
      }),
    );
    assert.deepEqual(protectedPolicy.builtinTools, [
      'Read',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
    ]);

    const controlPolicy = normalizeRequestPolicy(
      policy({
        route: 'control_plane',
        builtinTools: ['Read', 'Glob', 'Grep'],
        mcpTools: ['mcp__nanoclaw__list_cursor_agents'],
      }),
    );
    assert.equal(controlPolicy.route, 'control_plane');

    const advancedHostActionPolicy = normalizeRequestPolicy(
      policy({
        route: 'advanced_helper',
        builtinTools: [],
        mcpTools: ['mcp__nanoclaw__create_cursor_agent'],
      }),
    );
    assert.equal(advancedHostActionPolicy.route, 'advanced_helper');
    assert.deepEqual(advancedHostActionPolicy.builtinTools, []);
    assert.deepEqual(advancedHostActionPolicy.mcpTools, [
      'mcp__nanoclaw__create_cursor_agent',
    ]);

    const codePolicy = normalizeRequestPolicy(
      policy({
        route: 'code_plane',
        builtinTools: ['Bash', 'Read', 'Write', 'Edit'],
        mcpTools: [],
      }),
    );
    assert.equal(codePolicy.route, 'code_plane');
    assert.deepEqual(codePolicy.mcpTools, []);
  });
});
