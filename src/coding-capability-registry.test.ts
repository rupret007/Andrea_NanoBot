import { describe, expect, it } from 'vitest';

import {
  CodingCapabilityRegistry,
  formatCodingCapabilityAnswer,
  isCodingCapabilityQuestion,
  type CodingCapabilityEvidence,
} from './coding-capability-registry.js';

function evidence(
  overrides: Partial<CodingCapabilityEvidence> = {},
): CodingCapabilityEvidence {
  return {
    observedAt: '2026-07-22T12:00:00.000Z',
    cursorCloud: {
      configured: false,
      probed: false,
      reachable: false,
      authenticated: false,
      detail: null,
    },
    cursorDesktop: {
      appInstalled: true,
      configured: false,
      probed: false,
      reachable: false,
      terminalAvailable: false,
      agentCompatibility: 'unknown',
      cliPath: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
      detail: null,
    },
    codexCli: {
      installed: true,
      binaryPath: '/Applications/ChatGPT.app/Contents/Resources/codex',
      version: 'codex-cli 0.145.0',
      authMaterialPresent: true,
      authProbed: true,
      authenticated: true,
      detail: null,
    },
    codexBackend: {
      enabled: false,
      configured: true,
      probed: false,
      reachable: false,
      authenticated: false,
      executionReady: false,
      version: null,
      detail: null,
    },
    openAiFallback: { configured: true },
    ...overrides,
  };
}

describe('CodingCapabilityRegistry', () => {
  it('does not equate installed Cursor.app with a ready desktop agent', () => {
    const registry = new CodingCapabilityRegistry(evidence());
    expect(registry.get('cursor_desktop_agent').state).toBe('needs-proof');
    expect(registry.get('cursor_desktop_terminal').state).toBe('needs-proof');
  });

  it('separates a ready Codex CLI from a policy-disabled dispatch backend', () => {
    const registry = new CodingCapabilityRegistry(evidence());
    expect(registry.get('codex_cli').state).toBe('ready');
    expect(registry.get('codex_local_backend').state).toBe('policy-block');
    expect(registry.readyFor('codex', ['code_edit'])).toEqual([]);
  });

  it('never silently substitutes an explicit unavailable lane', () => {
    const registry = new CodingCapabilityRegistry(
      evidence({
        cursorCloud: {
          configured: true,
          probed: true,
          reachable: true,
          authenticated: true,
          detail: null,
        },
      }),
    );
    expect(
      registry.selectLane({
        requestedLane: 'codex',
        preferredLane: 'codex',
        operations: ['code_edit'],
      }),
    ).toMatchObject({
      outcome: 'unavailable',
      lane: null,
      fallbackUsed: false,
    });
  });

  it('auto routing selects only a ready compatible lane and discloses fallback', () => {
    const registry = new CodingCapabilityRegistry(
      evidence({
        cursorCloud: {
          configured: true,
          probed: true,
          reachable: true,
          authenticated: true,
          detail: null,
        },
      }),
    );
    expect(
      registry.selectLane({
        requestedLane: 'auto',
        preferredLane: 'codex',
        operations: ['code_edit', 'test'],
      }),
    ).toMatchObject({
      outcome: 'selected',
      lane: 'cursor',
      capabilityId: 'cursor_cloud',
      fallbackUsed: true,
    });
  });

  it('refuses operations that the lane cannot perform even if the provider is ready', () => {
    const registry = new CodingCapabilityRegistry(
      evidence({
        cursorCloud: {
          configured: true,
          probed: true,
          reachable: true,
          authenticated: true,
          detail: null,
        },
        codexBackend: {
          enabled: true,
          configured: true,
          probed: true,
          reachable: true,
          authenticated: true,
          executionReady: true,
          version: '1',
          detail: null,
        },
      }),
    );
    expect(
      registry.selectLane({
        requestedLane: 'auto',
        operations: ['push'],
      }),
    ).toMatchObject({ outcome: 'unavailable', lane: null });
  });

  it('keeps OpenAI fallback analysis-only and non-ready until externally proven', () => {
    const registry = new CodingCapabilityRegistry(evidence());
    expect(registry.get('openai_fallback')).toMatchObject({
      state: 'configured',
      operations: ['analysis'],
      mutability: 'read_only',
    });
    expect(registry.readyFor('codex', ['analysis'])).toEqual([]);
  });

  it('answers coding capability questions from current registry truth without starting work', () => {
    const registry = new CodingCapabilityRegistry(evidence());
    expect(isCodingCapabilityQuestion('Can you use Codex to code?')).toBe(true);
    expect(isCodingCapabilityQuestion('Build me a game')).toBe(true);
    const reply = formatCodingCapabilityAnswer(registry, 'Build me a game');
    expect(reply).toContain('I have not started a job');
    expect(reply).toContain('Local Codex CLI: ready');
    expect(reply).toContain('Andrea Codex dispatch: policy-block');
    expect(reply).toContain('never silently includes');
  });
});
