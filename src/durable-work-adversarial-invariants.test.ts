import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  getDurableWorkUnit,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  transitionDurableWorkUnitCAS,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  durableScopeHash,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
  recordDurableEffect,
  transitionDurableWork,
  type DurableNodeOrchestrationCallbacks,
} from './durable-work-continuity.js';

const NOW = '2026-07-13T12:00:00.000Z';
const binding = {
  ownerId: 'adversarial-owner',
  chatId: 'adversarial-chat',
  groupId: 'main',
  channel: 'telegram',
  targetScopeKey: 'repository-adversarial-fixture',
};

let testDirectory = '';
let databasePath = '';

beforeEach(() => {
  testDirectory = mkdtempSync(join(tmpdir(), 'andrea-durable-adversarial-'));
  databasePath = join(testDirectory, 'messages.db');
  _initTestDatabaseAtPath(databasePath);
});

afterEach(() => {
  _closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
});

function seedCheckpoint(input: {
  turnId: string;
  completedNodeIds?: string[];
  pendingNodeIds?: string[];
  uncertainNodeIds?: string[];
}) {
  const created = createOrLoadDurableWork({
    originTurnId: input.turnId,
    authorizedSurface: 'telegram',
    binding,
    goalSummary: 'Exercise one bounded durable continuity invariant.',
    status: 'ready',
    nextAction: 'Resume only after the durable state is proven safe.',
    now: NOW,
  });
  return commitDurableCheckpointCAS({
    workId: created.work.workId,
    expectedWorkVersion: created.work.version,
    completedNodeIds: input.completedNodeIds || [],
    pendingNodeIds: input.pendingNodeIds || [],
    uncertainNodeIds: input.uncertainNodeIds || [],
    executorScopeKey: 'host-executor-adversarial',
    targetScopeKey: binding.targetScopeKey,
    retryBudget: 3,
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Execute only the next dependency-ready node.',
    now: NOW,
  });
}

function acquireLease(input: {
  workId: string;
  suffix: string;
  processGeneration: string;
  leaseTtlMs?: number;
}) {
  const issued = issueDurableResumeGrant({
    workId: input.workId,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: `message-${input.suffix}`,
    now: '2026-07-13T12:01:00.000Z',
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass: 'repository_read',
    inboundMessageId: `message-${input.suffix}`,
    workerId: `worker-${input.suffix}`,
    processGeneration: input.processGeneration,
    leaseTtlMs: input.leaseTtlMs,
    now: '2026-07-13T12:01:00.000Z',
  });
  expect(consumed.status).toBe('consumed');
  if (consumed.status !== 'consumed' || !consumed.work || !consumed.lease) {
    throw new Error('The adversarial lease fixture could not be acquired.');
  }
  return { issued, work: consumed.work, lease: consumed.lease };
}

function callbacks(
  executeNode = vi.fn(() => ({
    status: 'succeeded' as const,
    postStateFingerprint: 'sha256:poststate',
  })),
): DurableNodeOrchestrationCallbacks<string> {
  return {
    loadPlan: ({ work }) => ({
      planId: 'plan-adversarial',
      planVersion: work.planVersion,
      nodes: [
        {
          nodeId: 'edit',
          position: 0,
          actionClass: 'repository_read',
          effectClass: 'read_only',
          dependsOnNodeIds: [],
          verificationRequirementIds: ['edit-proof'],
        },
      ],
    }),
    revalidateNode: () => ({
      dependencyState: 'fresh',
      targetState: 'fresh',
      preStateFingerprint: 'sha256:prestate',
      freshSignalIds: ['repository-state'],
      staleSignalIds: [],
      missingSignalIds: [],
    }),
    preflightScope: () => ({
      authorization: 'bounded-read-authorization',
      targetScopeHash: durableScopeHash('target', binding.targetScopeKey),
      preStateFingerprint: 'sha256:prestate',
      receiptIds: ['scope:preflight'],
    }),
    executeNode,
    completeScope: () => ({
      postStateFingerprint: 'sha256:poststate',
      receiptIds: ['scope:completion'],
    }),
    verifyNode: () => ({
      status: 'verified',
      verificationFingerprint: 'sha256:verified',
      postStateFingerprint: 'sha256:poststate',
      receiptIds: ['scope:verification'],
    }),
  };
}

describe('durable continuity adversarial invariants', () => {
  it('rejects DB-level completion when a referenced predecessor receipt remains unresolved', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-db-unresolved-receipt',
      pendingNodeIds: ['verify'],
    });
    const unresolved = recordDurableEffect({
      workId: initial.work.workId,
      checkpointId: initial.checkpoint.durableCheckpointId,
      planVersion: initial.work.planVersion,
      nodeId: 'sidecar',
      invocationId: 'invoke:unresolved-sidecar',
      actionClass: 'repository_read',
      effectClass: 'read_only',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      now: '2026-07-13T12:01:00.000Z',
    });
    const verified = recordDurableEffect({
      workId: initial.work.workId,
      checkpointId: initial.checkpoint.durableCheckpointId,
      planVersion: initial.work.planVersion,
      nodeId: 'verify',
      invocationId: 'invoke:db-terminal-verify',
      actionClass: 'verification_test',
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      postStateFingerprint: 'sha256:db-terminal-poststate',
      verificationFingerprint: 'sha256:db-terminal-verified',
      now: '2026-07-13T12:01:10.000Z',
    });
    const terminal = commitDurableCheckpointCAS({
      workId: initial.work.workId,
      expectedWorkVersion: initial.work.version,
      completedNodeIds: ['verify'],
      pendingNodeIds: [],
      uncertainNodeIds: [],
      executorScopeKey: 'host-executor-adversarial',
      targetScopeKey: binding.targetScopeKey,
      verifiedPostStateFingerprint: 'sha256:db-terminal-poststate',
      receiptIds: [unresolved.receiptId, verified.receiptId],
      verificationRequirementIds: ['verify-proof'],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction:
        'Reject completion while any referenced receipt is unresolved.',
      status: 'completed',
      now: '2026-07-13T12:02:00.000Z',
    });
    const verifying = transitionDurableWorkUnitCAS({
      workId: terminal.work.workId,
      expectedVersion: terminal.work.version,
      allowedFrom: ['ready'],
      toStatus: 'verifying',
      updatedAt: '2026-07-13T12:02:10.000Z',
      nextAction: 'Exercise the database completion trigger.',
      event: {
        eventId: 'durable:event:db-unresolved-verifying',
        workId: terminal.work.workId,
        createdAt: '2026-07-13T12:02:10.000Z',
        eventKind: 'transition',
        fromStatus: 'ready',
        toStatus: 'verifying',
        workVersion: terminal.work.version + 1,
        planVersion: terminal.work.planVersion,
        summary: 'Entered verification for a database trigger test.',
        refsJson: '[]',
        privacyJson: '{"metadataOnly":true}',
      },
    });
    expect(verifying).not.toBeNull();
    expect(() =>
      transitionDurableWorkUnitCAS({
        workId: verifying!.workId,
        expectedVersion: verifying!.version,
        allowedFrom: ['verifying'],
        toStatus: 'completed',
        updatedAt: '2026-07-13T12:02:20.000Z',
        nextAction: 'This direct completion must fail closed.',
        completedAt: '2026-07-13T12:02:20.000Z',
        event: {
          eventId: 'durable:event:db-unresolved-completed',
          workId: verifying!.workId,
          createdAt: '2026-07-13T12:02:20.000Z',
          eventKind: 'verified',
          fromStatus: 'verifying',
          toStatus: 'completed',
          workVersion: verifying!.version + 1,
          planVersion: verifying!.planVersion,
          summary:
            'Attempted completion with an unresolved referenced receipt.',
          refsJson: '[]',
          privacyJson: '{"metadataOnly":true}',
        },
      }),
    ).toThrow(/completion lacks verified terminal evidence/i);
    expect(getDurableWorkUnit(initial.work.workId)?.status).toBe('verifying');
  });

  it('rejects terminal completion when any completed DAG node lacks a same-work, same-plan verified receipt', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-incomplete-proof',
      pendingNodeIds: ['inspect', 'edit', 'verify'],
    });
    const inspectReceipt = recordDurableEffect({
      workId: initial.work.workId,
      checkpointId: initial.checkpoint.durableCheckpointId,
      planVersion: initial.work.planVersion,
      nodeId: 'inspect',
      invocationId: 'invoke:inspect',
      actionClass: 'repository_read',
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      postStateFingerprint: 'sha256:inspect-poststate',
      verificationFingerprint: 'sha256:inspect-verified',
      now: '2026-07-13T12:01:00.000Z',
    });
    const terminalReceipt = recordDurableEffect({
      workId: initial.work.workId,
      checkpointId: initial.checkpoint.durableCheckpointId,
      planVersion: initial.work.planVersion,
      nodeId: 'verify',
      invocationId: 'invoke:verify',
      actionClass: 'verification_test',
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      postStateFingerprint: 'sha256:terminal-poststate',
      verificationFingerprint: 'sha256:terminal-verified',
      now: '2026-07-13T12:01:10.000Z',
    });

    expect(() => {
      const committed = commitDurableCheckpointCAS({
        workId: initial.work.workId,
        expectedWorkVersion: initial.work.version,
        completedNodeIds: ['inspect', 'edit', 'verify'],
        pendingNodeIds: [],
        uncertainNodeIds: [],
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        verifiedPostStateFingerprint: 'sha256:terminal-poststate',
        receiptIds: [inspectReceipt.receiptId, terminalReceipt.receiptId],
        verificationRequirementIds: [
          'inspect-proof',
          'edit-proof',
          'verify-proof',
        ],
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: 'Complete only if every node has verified proof.',
        status: 'completed',
        now: '2026-07-13T12:02:00.000Z',
      });
      const verifying = transitionDurableWork({
        workId: committed.work.workId,
        expectedVersion: committed.work.version,
        toStatus: 'verifying',
        nextAction: 'Check every completed node receipt.',
        now: '2026-07-13T12:02:10.000Z',
      });
      transitionDurableWork({
        workId: verifying.workId,
        expectedVersion: verifying.version,
        toStatus: 'completed',
        nextAction: 'Do not complete without the edit receipt.',
        now: '2026-07-13T12:02:20.000Z',
      });
    }).toThrow(/completed node|receipt|proof|verified terminal checkpoint/i);
    expect(getDurableWorkUnit(initial.work.workId)?.status).not.toBe(
      'completed',
    );
  });

  it('rejects orchestration and receipt persistence after the lease expires', async () => {
    const seeded = seedCheckpoint({
      turnId: 'turn-expired-lease',
      pendingNodeIds: ['edit'],
    });
    const acquired = acquireLease({
      workId: seeded.work.workId,
      suffix: 'expired',
      processGeneration: 'process:correct',
      leaseTtlMs: 1_000,
    });
    const executeNode = vi.fn(() => ({
      status: 'succeeded' as const,
      postStateFingerprint: 'sha256:poststate',
    }));

    await expect(
      orchestrateNextDurableNode({
        workId: seeded.work.workId,
        leaseId: acquired.lease.leaseId,
        processGeneration: 'process:correct',
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        callbacks: callbacks(executeNode),
        now: '2026-07-13T12:02:00.000Z',
      }),
    ).rejects.toThrow(/expired|active bound lease|lease generation/i);
    expect(executeNode).not.toHaveBeenCalled();
    expect(listDurableEffectReceipts({ workId: seeded.work.workId })).toEqual(
      [],
    );
  });

  it('rejects orchestration and receipt persistence from the wrong process generation', async () => {
    const seeded = seedCheckpoint({
      turnId: 'turn-wrong-generation',
      pendingNodeIds: ['edit'],
    });
    const acquired = acquireLease({
      workId: seeded.work.workId,
      suffix: 'wrong-generation',
      processGeneration: 'process:correct',
    });
    const executeNode = vi.fn(() => ({
      status: 'succeeded' as const,
      postStateFingerprint: 'sha256:poststate',
    }));

    await expect(
      orchestrateNextDurableNode({
        workId: seeded.work.workId,
        leaseId: acquired.lease.leaseId,
        processGeneration: 'process:wrong',
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        callbacks: callbacks(executeNode),
        now: '2026-07-13T12:02:00.000Z',
      }),
    ).rejects.toThrow(/generation|active bound lease/i);
    expect(executeNode).not.toHaveBeenCalled();
    expect(listDurableEffectReceipts({ workId: seeded.work.workId })).toEqual(
      [],
    );
  });

  it('does not let checkpoint CAS silently drop completed or uncertain nodes', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-drop-node-state',
      completedNodeIds: ['inspect'],
      pendingNodeIds: ['verify'],
      uncertainNodeIds: ['edit'],
    });

    expect(() =>
      commitDurableCheckpointCAS({
        workId: initial.work.workId,
        expectedWorkVersion: initial.work.version,
        completedNodeIds: [],
        pendingNodeIds: ['verify'],
        uncertainNodeIds: [],
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: 'Never erase prior completed or uncertain state.',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/drop|completed|uncertain|monotonic|proof/i);
    expect(getDurableWorkUnit(initial.work.workId)?.checkpointHeadId).toBe(
      initial.checkpoint.durableCheckpointId,
    );
  });

  it('does not let checkpoint CAS move a pending node to completed without verified proof', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-unproved-completion',
      pendingNodeIds: ['edit'],
    });

    expect(() =>
      commitDurableCheckpointCAS({
        workId: initial.work.workId,
        expectedWorkVersion: initial.work.version,
        completedNodeIds: ['edit'],
        pendingNodeIds: [],
        uncertainNodeIds: [],
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        verifiedPostStateFingerprint: 'sha256:invented-poststate',
        receiptIds: [],
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: 'Never infer node completion without proof.',
        status: 'completed',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/completed|receipt|proof|verification/i);
    expect(getDurableWorkUnit(initial.work.workId)?.checkpointHeadId).toBe(
      initial.checkpoint.durableCheckpointId,
    );
  });

  it('does not let checkpoint CAS silently erase a pending node', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-drop-pending-state',
      pendingNodeIds: ['edit'],
    });

    expect(() =>
      commitDurableCheckpointCAS({
        workId: initial.work.workId,
        expectedWorkVersion: initial.work.version,
        completedNodeIds: [],
        pendingNodeIds: [],
        uncertainNodeIds: [],
        executorScopeKey: 'host-executor-adversarial',
        targetScopeKey: binding.targetScopeKey,
        recoveryPolicy: 'inspect_then_resume',
        nextSafeAction: 'Never erase pending work without a replan.',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/drop pending|pending node|replan|proof/i);
    expect(getDurableWorkUnit(initial.work.workId)?.checkpointHeadId).toBe(
      initial.checkpoint.durableCheckpointId,
    );
  });

  it('fails closed on malformed stored checkpoint JSON without exposing its contents', () => {
    const initial = seedCheckpoint({
      turnId: 'turn-malformed-checkpoint',
      pendingNodeIds: ['edit'],
    });
    const issued = issueDurableResumeGrant({
      workId: initial.work.workId,
      binding,
      actionClass: 'repository_read',
      inboundMessageId: 'message-malformed',
      now: '2026-07-13T12:01:00.000Z',
    });
    const privateSentinel = 'PRIVATE_SENTINEL_DO_NOT_EXPOSE_7f1c';
    const mutator = new Database(databasePath);
    mutator
      .prepare(
        `UPDATE durable_work_checkpoints
         SET uncertain_node_ids_json = ?
         WHERE durable_checkpoint_id = ?`,
      )
      .run(
        `not-json ${privateSentinel}`,
        initial.checkpoint.durableCheckpointId,
      );
    mutator.close();

    let thrown: unknown;
    try {
      consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding,
        actionClass: 'repository_read',
        inboundMessageId: 'message-malformed',
        workerId: 'worker-malformed',
        processGeneration: 'process:correct',
        now: '2026-07-13T12:02:00.000Z',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const errorText =
      thrown instanceof Error
        ? `${thrown.name}: ${thrown.message}\n${thrown.stack || ''}`
        : String(thrown);
    expect(errorText).toMatch(/invalid durable .*checkpoint state/i);
    expect(errorText).not.toContain(privateSentinel);
    expect(listDurableResumeGrants({ workId: initial.work.workId })).toEqual([
      expect.objectContaining({ status: 'active' }),
    ]);
    expect(listDurableEffectReceipts({ workId: initial.work.workId })).toEqual(
      [],
    );
  });
});
