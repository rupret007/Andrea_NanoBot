import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PreSendEvaluation } from './turn-agent-harness.js';

afterEach(async () => {
  const database = await import('./db.js');
  if (database.isDatabaseInitialized()) database._closeDatabase();
  vi.doUnmock('./personal-context-packet.js');
  vi.doUnmock('./verified-deep-work.js');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('production intelligence persistence boundary', () => {
  it('skips packet and deep-work persistence when the database is unavailable', async () => {
    const buildPacket = vi.fn();
    const beginDeepWork = vi.fn();
    vi.doMock('./personal-context-packet.js', () => ({
      buildPersonalContextPacket: buildPacket,
    }));
    vi.doMock('./verified-deep-work.js', () => ({
      beginVerifiedDeepWorkForTurn: beginDeepWork,
      reconcileVerifiedDeepWorkExecution: vi.fn(),
    }));

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    const context = await beginTurnAgentHarness({
      turnId: 'turn-no-database',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what am I forgetting tonight',
      requestRoute: 'direct_assistant',
    });

    expect(context).not.toBeNull();
    expect(context?.personalContextPacket).toBeNull();
    expect(context?.verifiedDeepWorkPacket).toBeNull();
    expect(buildPacket).not.toHaveBeenCalled();
    expect(beginDeepWork).not.toHaveBeenCalled();
  });

  it('propagates an unexpected personal-context persistence failure', async () => {
    const database = await import('./db.js');
    database._initTestDatabase();
    vi.doMock('./personal-context-packet.js', () => ({
      buildPersonalContextPacket: vi.fn(async () => {
        throw new Error('personal context persistence failed');
      }),
    }));
    vi.doMock('./verified-deep-work.js', () => ({
      beginVerifiedDeepWorkForTurn: vi.fn(),
      reconcileVerifiedDeepWorkExecution: vi.fn(),
    }));

    const { beginTurnAgentHarness } = await import('./turn-agent-harness.js');
    await expect(
      beginTurnAgentHarness({
        turnId: 'turn-context-failure',
        channel: 'telegram',
        groupFolder: 'main',
        text: 'what am I forgetting tonight',
        requestRoute: 'direct_assistant',
      }),
    ).rejects.toThrow('personal context persistence failed');
  });

  it('does not finalize deep work from reflection and propagates a runtime-evidence persistence failure', async () => {
    const database = await import('./db.js');
    database._initTestDatabase();
    const reconcile = vi.fn(() => {
      throw new Error('deep-work outcome persistence failed');
    });
    vi.doMock('./verified-deep-work.js', () => ({
      beginVerifiedDeepWorkForTurn: vi.fn(),
      reconcileVerifiedDeepWorkExecution: reconcile,
    }));

    const { reconcileTurnRuntimeEvidence, reflectTurnAgentOutcome } =
      await import('./turn-agent-harness.js');
    const context = {
      turnId: 'turn-runtime-evidence',
      verifiedDeepWorkPacket: { packetId: 'packet-failure' },
    } as never;
    const evaluation: PreSendEvaluation = {
      status: 'pass',
      evidenceLevel: 'strong',
      evidenceGap: 'none',
      evaluatorFlags: [],
      safeRewriteApplied: false,
      rewrittenText: 'Verified result.',
      approvalCorrectness: 'correct',
      memoryEffect: 'neutral',
      summary: 'Verified result.',
    };
    await expect(
      reflectTurnAgentOutcome({
        context,
        evaluation,
        routeUsed: 'research.live',
        answerClass: 'handled',
      }),
    ).resolves.toMatchObject({ reflection: null });
    expect(reconcile).not.toHaveBeenCalled();

    expect(() =>
      reconcileTurnRuntimeEvidence({
        context: {
          turnId: 'turn-runtime-evidence',
          verifiedDeepWorkPacket: { packetId: 'packet-failure' },
        } as never,
        evaluation,
        runtimeStatus: 'success',
        runtimeToolEvidence: undefined,
        routeUsed: 'research.live',
      }),
    ).toThrow('deep-work outcome persistence failed');
  });
});
