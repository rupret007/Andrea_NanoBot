import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  getDurableWorkUnit,
  insertDurableResumeGrant,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  upsertCognitiveApprovalPacket,
  upsertDurableEffectReceipt,
  upsertCognitiveRun,
} from './db.js';
import {
  buildDurableContinuityReport,
  chooseDurableAdaptiveDecision,
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  durableScopeHash,
  formatDurableContinuityForUser,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
  replanDurableWork,
  reconcileDurableWorkOnStartup,
  recordDurableEffect,
  revokeDurableGrant,
  shouldCreateDurableWork,
  stageDurableWorkApproval,
  transitionDurableDeliveryState,
  transitionDurableWork,
  type DurableNodeVerification,
  type DurableNodeOrchestrationCallbacks,
} from './durable-work-continuity.js';

const NOW = '2026-07-13T12:00:00.000Z';
const binding = {
  ownerId: 'owner-1',
  chatId: 'chat-1',
  groupId: 'main',
  channel: 'telegram',
  targetScopeKey: 'repository-fixture-1',
};

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function readyWork() {
  const created = createOrLoadDurableWork({
    originTurnId: 'turn-1',
    authorizedSurface: 'telegram',
    binding,
    goalSummary: 'Repair one bounded repository fixture and verify it.',
    status: 'ready',
    runtimeRunId: 'runtime:run:turn-1',
    agentOSEpisodeId: 'agentos:episode:turn-1',
    cognitiveRunId: 'cognitive:run:turn-1',
    nextAction: 'Commit a checkpoint before the first bounded action.',
    now: NOW,
  });
  const committed = commitDurableCheckpointCAS({
    workId: created.work.workId,
    expectedWorkVersion: created.work.version,
    completedNodeIds: ['inspect'],
    pendingNodeIds: ['edit', 'verify'],
    uncertainNodeIds: [],
    dependencyIds: ['inspect'],
    worldSignals: { fresh: ['repo-state'], stale: [], missing: [] },
    executorScopeKey: 'host-executor-1',
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: 'sha256:prestate',
    verificationRequirementIds: ['test-pass'],
    stopConditionIds: ['terminal-error', 'retry-budget'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Execute only the edit node, then verify.',
    now: NOW,
  });
  return committed;
}

function verifiedWork(ready = readyWork()) {
  const postStateFingerprint = `sha256:${'9'.repeat(64)}`;
  const receipts = ['inspect', 'edit', 'verify'].map((nodeId) =>
    recordDurableEffect({
      workId: ready.work.workId,
      checkpointId: ready.checkpoint.durableCheckpointId,
      planVersion: ready.work.planVersion,
      nodeId,
      invocationId: `invoke:verified-${nodeId}`,
      actionClass:
        nodeId === 'verify' ? 'verification_test' : 'repository_read',
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      postStateFingerprint:
        nodeId === 'verify'
          ? postStateFingerprint
          : `sha256:${nodeId}-poststate`,
      verificationFingerprint: `sha256:${nodeId}-verified`,
      now: '2026-07-13T12:01:00.000Z',
    }),
  );
  const receipt = receipts[2]!;
  const committed = commitDurableCheckpointCAS({
    workId: ready.work.workId,
    expectedWorkVersion: ready.work.version,
    completedNodeIds: ['inspect', 'edit', 'verify'],
    pendingNodeIds: [],
    uncertainNodeIds: [],
    executorScopeKey: 'host-executor-1',
    targetScopeKey: binding.targetScopeKey,
    verifiedPostStateFingerprint: postStateFingerprint,
    receiptIds: receipts.map((entry) => entry.receiptId),
    verificationRequirementIds: ['test-pass'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Complete only from the verified terminal checkpoint.',
    status: 'completed',
    now: '2026-07-13T12:01:30.000Z',
  });
  const verifying = transitionDurableWork({
    workId: committed.work.workId,
    expectedVersion: committed.work.version,
    toStatus: 'verifying',
    nextAction: 'Confirm the verified terminal checkpoint.',
    now: '2026-07-13T12:02:00.000Z',
  });
  return { ...committed, work: verifying, receipt };
}

function seedApprovedPacket(
  workId: string,
  actionClass = 'repository_write',
  ttlMs = 2 * 60 * 60 * 1000,
) {
  const work = getDurableWorkUnit(workId);
  if (!work?.cognitiveRunId || !work.checkpointHeadId) {
    throw new Error(
      'Approval fixture requires cognitive and checkpoint links.',
    );
  }
  upsertCognitiveRun({
    runId: work.cognitiveRunId,
    createdAt: NOW,
    updatedAt: NOW,
    groupFolder: 'main',
    channel: 'telegram',
    taskFamily: 'code',
    turnId: 'turn-approval-1',
    runOrigin: 'live',
    goalSummary: 'Approve one exact repository write.',
    selectedSkillId: 'code.repair',
    status: 'awaiting_approval',
    autonomyLevel: 'plan_draft_only',
    cognitiveMode: 'approval_staged',
    taskGraphJson: '{}',
    evidenceContractJson: '{}',
    providerUsabilityJson: '{}',
    councilRunId: null,
    verificationJson: '{}',
    outcomeScore: 0,
    nextAction: 'Wait for exact owner approval.',
    privacyJson: '{"metadataOnly":true}',
    linkedSkillCardId: null,
  });
  const stagedResult = stageDurableWorkApproval({
    workId,
    expectedWorkVersion: work.version,
    cognitiveRunId: work.cognitiveRunId,
    actionClass,
    summary: 'Approve one exact bounded repository write.',
    checkpointId: work.checkpointHeadId,
    ttlMs,
    now: NOW,
  });
  const staged = listCognitiveApprovalPackets({
    groupFolder: 'main',
    status: 'staged',
  }).find(
    (packet) =>
      packet.approvalPacketId === stagedResult.packet.approvalPacketId,
  )!;
  const result = approveCognitiveApprovalPacketCAS({
    approvalPacketId: staged.approvalPacketId,
    groupFolder: 'main',
    expectedSummary: staged.summary,
    expectedApprovalVersion: staged.approvalVersion || 1,
    expectedScopeDigest: staged.scopeDigest || null,
    now: '2026-07-13T12:01:00.000Z',
    approvalChannel: 'owner_cockpit',
  });
  expect(result).toEqual({ status: 'approved', approvalVersion: 2 });
  return {
    approvalPacketId: staged.approvalPacketId,
    approvalVersion: result.approvalVersion!,
    checkpointId: stagedResult.checkpoint.durableCheckpointId,
  };
}

function acquireReadLease(
  workId: string,
  suffix: string,
  actionClass = 'repository_read',
) {
  const issued = issueDurableResumeGrant({
    workId,
    binding,
    actionClass,
    inboundMessageId: `message-${suffix}`,
    now: '2026-07-13T12:01:00.000Z',
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass,
    inboundMessageId: `message-${suffix}`,
    workerId: `worker-${suffix}`,
    processGeneration: 'process:test',
    leaseTtlMs: 5 * 60_000,
    now: '2026-07-13T12:02:00.000Z',
  });
  expect(consumed.status).toBe('consumed');
  if (consumed.status !== 'consumed' || !consumed.work || !consumed.lease) {
    throw new Error('Failed to acquire the fixture lease.');
  }
  return { work: consumed.work, lease: consumed.lease };
}

function executionPlan(planVersion: number) {
  return {
    planId: 'plan-1',
    planVersion,
    nodes: [
      {
        nodeId: 'inspect',
        position: 0,
        actionClass: 'repository_read',
        effectClass: 'read_only' as const,
        dependsOnNodeIds: [],
        verificationRequirementIds: ['inspect-proof'],
      },
      {
        nodeId: 'edit',
        position: 1,
        actionClass: 'repository_read',
        effectClass: 'read_only' as const,
        dependsOnNodeIds: ['inspect'],
        verificationRequirementIds: ['edit-proof'],
      },
      {
        nodeId: 'verify',
        position: 2,
        actionClass: 'verification_test',
        effectClass: 'read_only' as const,
        dependsOnNodeIds: ['edit'],
        verificationRequirementIds: ['test-pass'],
      },
    ],
  };
}

function executionCallbacks(
  overrides: Partial<DurableNodeOrchestrationCallbacks<string>> = {},
): DurableNodeOrchestrationCallbacks<string> {
  return {
    loadPlan: ({ work }) => executionPlan(work.planVersion),
    revalidateNode: () => ({
      dependencyState: 'fresh',
      targetState: 'fresh',
      preStateFingerprint: 'sha256:prestate',
      freshSignalIds: ['repo-state'],
      staleSignalIds: [],
      missingSignalIds: [],
    }),
    preflightScope: () => ({
      authorization: 'scope-authorization',
      targetScopeHash: durableScopeHash('target', binding.targetScopeKey),
      preStateFingerprint: 'sha256:prestate',
      receiptIds: ['scope:preflight'],
    }),
    executeNode: () => ({
      status: 'succeeded',
      postStateFingerprint: 'sha256:poststate',
    }),
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
    ...overrides,
  };
}

describe('durable cognitive continuity', () => {
  it('deduplicates one originating turn into one canonical work identity', () => {
    const first = readyWork();
    const duplicate = createOrLoadDurableWork({
      originTurnId: 'turn-1',
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'A different summary may not fork the same work identity.',
      status: 'proposed',
      nextAction: 'Do not duplicate the work.',
      now: '2026-07-13T12:01:00.000Z',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.work.workId).toBe(first.work.workId);
    expect(duplicate.work.goalSummary).toContain('Repair one bounded');
  });

  it('never deduplicates one originating turn across target scopes', () => {
    const first = readyWork();
    const second = createOrLoadDurableWork({
      originTurnId: 'turn-1',
      authorizedSurface: 'telegram',
      binding: { ...binding, targetScopeKey: 'repository-fixture-2' },
      goalSummary: 'Inspect a different bounded repository target.',
      status: 'ready',
      nextAction: 'Keep this target isolated from the first work identity.',
      now: NOW,
    });
    expect(second.created).toBe(true);
    expect(second.work.workId).not.toBe(first.work.workId);
    expect(second.work.targetScopeHash).not.toBe(first.work.targetScopeHash);
  });

  it('rejects low-level grants and receipts that cross work/checkpoint identities', () => {
    const first = readyWork();
    const secondBinding = {
      ...binding,
      targetScopeKey: 'repository-fixture-2',
    };
    const created = createOrLoadDurableWork({
      originTurnId: 'turn-cross-checkpoint-2',
      authorizedSurface: 'telegram',
      binding: secondBinding,
      goalSummary: 'Inspect an isolated second repository fixture.',
      status: 'ready',
      nextAction: 'Commit the second bounded checkpoint.',
      now: NOW,
    });
    const second = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      pendingNodeIds: ['inspect'],
      executorScopeKey: 'host-executor-2',
      targetScopeKey: secondBinding.targetScopeKey,
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Inspect only the second target.',
      now: NOW,
    });
    const privacy = '{"metadataOnly":true}';
    expect(() =>
      insertDurableResumeGrant({
        grant: {
          grantId: 'grant:cross-checkpoint',
          tokenHash: 'a'.repeat(64),
          workId: second.work.workId,
          checkpointId: first.checkpoint.durableCheckpointId,
          workVersion: second.work.version,
          planVersion: second.work.planVersion,
          ownerScopeHash: second.work.ownerScopeHash,
          chatScopeHash: second.work.chatScopeHash,
          groupScopeHash: second.work.groupScopeHash,
          channel: second.work.channel,
          targetScopeHash: second.work.targetScopeHash,
          actionClass: 'repository_read',
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
          expiresAt: '2026-07-13T13:00:00.000Z',
          privacyJson: privacy,
        },
        event: {
          eventId: 'durable:event:cross-checkpoint-grant',
          workId: second.work.workId,
          createdAt: NOW,
          eventKind: 'grant_issued',
          workVersion: second.work.version,
          planVersion: second.work.planVersion,
          summary: 'Attempted a cross-checkpoint grant.',
          refsJson: '[]',
          privacyJson: privacy,
        },
      }),
    ).toThrow(/exact active work scope|checkpoint scope mismatch|foreign key/i);
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: {
          receiptId: 'receipt:cross-checkpoint',
          workId: second.work.workId,
          checkpointId: first.checkpoint.durableCheckpointId,
          planVersion: second.work.planVersion,
          nodeId: 'inspect',
          invocationId: 'invoke:cross-checkpoint',
          actionClass: 'repository_read',
          effectClass: 'read_only',
          status: 'started',
          targetScopeHash: second.work.targetScopeHash,
          createdAt: NOW,
          updatedAt: NOW,
          metadataJson: '{}',
          privacyJson: privacy,
        },
        event: {
          eventId: 'durable:event:cross-checkpoint-receipt',
          workId: second.work.workId,
          createdAt: NOW,
          eventKind: 'receipt',
          workVersion: second.work.version,
          planVersion: second.work.planVersion,
          summary: 'Attempted a cross-checkpoint receipt.',
          refsJson: '[]',
          privacyJson: privacy,
        },
      }),
    ).toThrow(/checkpoint scope mismatch|foreign key/i);
    expect(() =>
      upsertDurableEffectReceipt({
        receipt: {
          receiptId: 'receipt:unapproved-mutation',
          workId: first.work.workId,
          checkpointId: first.checkpoint.durableCheckpointId,
          planVersion: first.work.planVersion,
          nodeId: 'edit',
          invocationId: 'invoke:unapproved-mutation',
          actionClass: 'repository_write',
          effectClass: 'repository_write',
          status: 'started',
          targetScopeHash: first.work.targetScopeHash,
          createdAt: NOW,
          updatedAt: NOW,
          metadataJson: '{}',
          privacyJson: privacy,
        },
        event: {
          eventId: 'durable:event:unapproved-mutation',
          workId: first.work.workId,
          createdAt: NOW,
          eventKind: 'receipt',
          workVersion: first.work.version,
          planVersion: first.work.planVersion,
          summary: 'Attempted an unapproved mutation receipt.',
          refsJson: '[]',
          privacyJson: privacy,
        },
      }),
    ).toThrow(/active bound lease generation/i);
  });

  it('stores only a token hash and permits exactly one scoped consumption', () => {
    const { work } = readyWork();
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'repository_read',
      inboundMessageId: 'message-1',
      now: '2026-07-13T12:01:00.000Z',
    });
    const stored = listDurableResumeGrants({ workId: work.workId });
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(stored[0]?.tokenHash).toHaveLength(64);

    const first = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'repository_read',
      inboundMessageId: 'message-1',
      workerId: 'worker-1',
      now: '2026-07-13T12:02:00.000Z',
    });
    const replay = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'repository_read',
      inboundMessageId: 'message-1',
      workerId: 'worker-2',
      now: '2026-07-13T12:02:01.000Z',
    });
    expect(first.status).toBe('consumed');
    expect(replay.status).toBe('already_consumed');
  });

  it('rejects cross-owner, cross-chat, cross-channel, target, action, and inbound scope', () => {
    const { work } = readyWork();
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'repository_read',
      inboundMessageId: 'message-1',
      now: '2026-07-13T12:01:00.000Z',
    });
    const wrongBindings = [
      { ...binding, ownerId: 'owner-2' },
      { ...binding, chatId: 'chat-2' },
      { ...binding, channel: 'bluebubbles' },
      { ...binding, targetScopeKey: 'repository-fixture-2' },
    ];
    for (const [index, candidate] of wrongBindings.entries()) {
      const result = consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding: candidate,
        actionClass: 'repository_read',
        inboundMessageId: 'message-1',
        workerId: `wrong-worker-${index}`,
        now: '2026-07-13T12:02:00.000Z',
      });
      expect(result.status).toBe('scope_mismatch');
    }
    expect(
      consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding,
        actionClass: 'verification_test',
        inboundMessageId: 'message-1',
        workerId: 'wrong-action',
        now: '2026-07-13T12:02:00.000Z',
      }).status,
    ).toBe('scope_mismatch');
    expect(
      consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding,
        actionClass: 'repository_read',
        inboundMessageId: 'message-2',
        workerId: 'wrong-message',
        now: '2026-07-13T12:02:00.000Z',
      }).status,
    ).toBe('scope_mismatch');
  });

  it('requires fresh exact approval for mutation and invalidates stale approval versions', () => {
    const { work } = readyWork();
    expect(() =>
      issueDurableResumeGrant({
        workId: work.workId,
        binding,
        actionClass: 'repository_write',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/resume token is not approval/i);

    const approval = seedApprovedPacket(work.workId);
    expect(() =>
      issueDurableResumeGrant({
        workId: work.workId,
        binding,
        actionClass: 'repository_write',
        approvalPacketId: approval.approvalPacketId,
        approvalVersion: approval.approvalVersion - 1,
        now: '2026-07-13T12:02:00.000Z',
      }),
    ).toThrow(/current exact-scope approval/i);
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'repository_write',
      approvalPacketId: approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      now: '2026-07-13T12:02:00.000Z',
    });
    expect(
      consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding,
        actionClass: 'repository_write',
        workerId: 'writer-1',
        now: '2026-07-13T12:03:00.000Z',
      }).status,
    ).toBe('consumed');
  });

  it('enforces approval-bound local operator changes through receipt updates', () => {
    const { work } = readyWork();
    const approval = seedApprovedPacket(
      work.workId,
      'operator_change',
      120_000,
    );
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'operator_change',
      approvalPacketId: approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      now: '2026-07-13T12:01:05.000Z',
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'operator_change',
      workerId: 'operator-change-worker',
      processGeneration: 'process:operator-change',
      leaseTtlMs: 120_000,
      now: '2026-07-13T12:01:10.000Z',
    });
    expect(consumed.status).toBe('consumed');
    expect(consumed.lease).toBeTruthy();
    const started = recordDurableEffect({
      workId: work.workId,
      checkpointId: approval.checkpointId,
      planVersion: work.planVersion,
      nodeId: 'operator-setting',
      invocationId: 'operator-setting-invocation',
      actionClass: 'operator_change',
      authorizationGrantId: issued.grant.grantId,
      leaseId: consumed.lease!.leaseId,
      processGeneration: 'process:operator-change',
      leaseAssertionNow: '2026-07-13T12:01:20.000Z',
      effectClass: 'local_write',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint: 'sha256:operator-before',
      now: '2026-07-13T12:01:20.000Z',
    });
    expect(started).toMatchObject({
      actionClass: 'operator_change',
      approvalPacketId: approval.approvalPacketId,
      grantId: issued.grant.grantId,
    });

    expect(() =>
      recordDurableEffect({
        workId: work.workId,
        checkpointId: approval.checkpointId,
        planVersion: work.planVersion,
        nodeId: 'operator-setting',
        invocationId: 'operator-setting-invocation',
        actionClass: 'operator_change',
        leaseId: consumed.lease!.leaseId,
        processGeneration: 'process:operator-change',
        leaseAssertionNow: '2026-07-13T12:02:10.000Z',
        effectClass: 'local_write',
        status: 'succeeded',
        targetScopeKey: binding.targetScopeKey,
        preStateFingerprint: 'sha256:operator-before',
        postStateFingerprint: 'sha256:operator-after',
        verificationFingerprint: 'sha256:operator-verified',
        now: '2026-07-13T12:02:10.000Z',
      }),
    ).toThrow(/current exact-scope lease approval|current authority/i);
  });

  it('invalidates the old approval and active grant when the work is replanned', () => {
    const { work } = readyWork();
    const approval = seedApprovedPacket(work.workId);
    const approvedWork = getDurableWorkUnit(work.workId)!;
    const issued = issueDurableResumeGrant({
      workId: approvedWork.workId,
      binding,
      actionClass: 'repository_write',
      approvalPacketId: approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      inboundMessageId: 'message-before-replan',
      now: '2026-07-13T12:02:00.000Z',
    });

    const replanned = replanDurableWork({
      workId: approvedWork.workId,
      expectedVersion: approvedWork.version,
      preservedCompletedNodeIds: ['inspect'],
      reasonCode: 'target_changed',
      nextAction: 'Inspect the changed target and prepare a new plan.',
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(replanned).toMatchObject({
      status: 'planned',
      planVersion: approvedWork.planVersion + 1,
      approvalPacketId: null,
      approvalVersion: null,
    });
    expect(
      listCognitiveApprovalPackets({
        runId: approvedWork.cognitiveRunId!,
      }).find((packet) => packet.approvalPacketId === approval.approvalPacketId)
        ?.status,
    ).toBe('expired');
    expect(
      listDurableResumeGrants({ workId: approvedWork.workId }).find(
        (grant) => grant.grantId === issued.grant.grantId,
      )?.status,
    ).toBe('revoked');
    expect(
      consumeResumeGrantAndAcquireLease({
        token: issued.token,
        binding,
        actionClass: 'repository_write',
        inboundMessageId: 'message-before-replan',
        workerId: 'worker-after-replan',
        now: '2026-07-13T12:04:00.000Z',
      }).status,
    ).toBe('revoked');
  });

  it('rejects an alternate approval packet for the same work, target, and action', () => {
    const { work } = readyWork();
    const approval = seedApprovedPacket(work.workId);
    const approvedWork = getDurableWorkUnit(work.workId)!;
    const canonical = listCognitiveApprovalPackets({
      runId: approvedWork.cognitiveRunId!,
      limit: 100,
    }).find((packet) => packet.approvalPacketId === approval.approvalPacketId)!;
    upsertCognitiveApprovalPacket({
      ...canonical,
      approvalPacketId: 'approval:alternate-same-scope',
      approvalKey: 'alternate-same-scope',
      status: 'approved',
      approvalVersion: 2,
      scopeDigest: null,
      summaryDigest: null,
    });

    expect(() =>
      issueDurableResumeGrant({
        workId: approvedWork.workId,
        binding,
        actionClass: 'repository_write',
        approvalPacketId: 'approval:alternate-same-scope',
        approvalVersion: 2,
        now: '2026-07-13T12:02:00.000Z',
      }),
    ).toThrow(/current exact-scope approval/i);
  });

  it('restages after expiry with a successor checkpoint and preserves history', () => {
    const { work } = readyWork();
    const current = getDurableWorkUnit(work.workId)!;
    upsertCognitiveRun({
      runId: current.cognitiveRunId!,
      createdAt: NOW,
      updatedAt: NOW,
      groupFolder: 'main',
      channel: 'telegram',
      taskFamily: 'code',
      turnId: 'turn-restage-expired',
      runOrigin: 'live',
      goalSummary: 'Approve one expiring repository write.',
      selectedSkillId: 'code.repair',
      status: 'awaiting_approval',
      autonomyLevel: 'plan_draft_only',
      cognitiveMode: 'approval_staged',
      taskGraphJson: '{}',
      evidenceContractJson: '{}',
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0,
      nextAction: 'Wait for exact owner approval.',
      privacyJson: '{"metadataOnly":true}',
      linkedSkillCardId: null,
    });
    const first = stageDurableWorkApproval({
      workId: current.workId,
      expectedWorkVersion: current.version,
      cognitiveRunId: current.cognitiveRunId!,
      actionClass: 'repository_write',
      summary: 'Approve one expiring repository write.',
      checkpointId: current.checkpointHeadId,
      ttlMs: 1_000,
      now: NOW,
    });
    expect(
      approveCognitiveApprovalPacketCAS({
        approvalPacketId: first.packet.approvalPacketId,
        groupFolder: 'main',
        expectedSummary: first.packet.summary,
        expectedApprovalVersion: first.packet.approvalVersion || 1,
        expectedScopeDigest: first.packet.scopeDigest || null,
        now: '2026-07-13T12:00:02.000Z',
        approvalChannel: 'owner_cockpit',
      }).status,
    ).toBe('expired');
    const expiredWork = getDurableWorkUnit(current.workId)!;
    const second = stageDurableWorkApproval({
      workId: expiredWork.workId,
      expectedWorkVersion: expiredWork.version,
      cognitiveRunId: expiredWork.cognitiveRunId!,
      actionClass: 'repository_write',
      summary: 'Approve one freshly restaged repository write.',
      checkpointId: expiredWork.checkpointHeadId,
      now: '2026-07-13T12:00:03.000Z',
    });

    expect(second.packet.approvalPacketId).not.toBe(
      first.packet.approvalPacketId,
    );
    expect(second.checkpoint.parentCheckpointId).toBe(
      first.checkpoint.durableCheckpointId,
    );
    expect(second.work).toMatchObject({
      approvalPacketId: second.packet.approvalPacketId,
      approvalVersion: 1,
      checkpointHeadId: second.checkpoint.durableCheckpointId,
    });
    expect(
      listCognitiveApprovalPackets({
        runId: current.cognitiveRunId!,
        limit: 100,
      }).map((packet) => ({
        id: packet.approvalPacketId,
        status: packet.status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { id: first.packet.approvalPacketId, status: 'expired' },
        { id: second.packet.approvalPacketId, status: 'staged' },
      ]),
    );
  });

  it('fails closed for expired and revoked grants', () => {
    const first = readyWork();
    const expired = issueDurableResumeGrant({
      workId: first.work.workId,
      binding,
      actionClass: 'repository_read',
      ttlMs: 100,
      now: NOW,
    });
    expect(
      consumeResumeGrantAndAcquireLease({
        token: expired.token,
        binding,
        actionClass: 'repository_read',
        workerId: 'worker-expired',
        now: '2026-07-13T12:00:01.000Z',
      }).status,
    ).toBe('expired');

    const secondBinding = {
      ...binding,
      targetScopeKey: 'repository-fixture-2',
    };
    const second = createOrLoadDurableWork({
      originTurnId: 'turn-2',
      authorizedSurface: 'telegram',
      binding: secondBinding,
      goalSummary: 'Inspect a second bounded repository fixture.',
      status: 'ready',
      nextAction: 'Checkpoint before reading.',
      now: NOW,
    });
    const checkpoint = commitDurableCheckpointCAS({
      workId: second.work.workId,
      expectedWorkVersion: second.work.version,
      pendingNodeIds: ['inspect'],
      executorScopeKey: 'host-executor-1',
      targetScopeKey: secondBinding.targetScopeKey,
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Inspect once.',
      now: NOW,
    });
    const revoked = issueDurableResumeGrant({
      workId: checkpoint.work.workId,
      binding: secondBinding,
      actionClass: 'repository_read',
      now: NOW,
    });
    expect(
      revokeDurableGrant({ grantId: revoked.grant.grantId, now: NOW }),
    ).toBe(true);
    expect(
      consumeResumeGrantAndAcquireLease({
        token: revoked.token,
        binding: secondBinding,
        actionClass: 'repository_read',
        workerId: 'worker-revoked',
        now: '2026-07-13T12:01:00.000Z',
      }).status,
    ).toBe('revoked');
  });

  it('reconciles an expired external unknown effect without replaying it', () => {
    const { work } = readyWork();
    const approval = seedApprovedPacket(work.workId, 'external_effect');
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'external_effect',
      approvalPacketId: approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      now: NOW,
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'external_effect',
      workerId: 'worker-crashed',
      processGeneration: 'process:crashed',
      leaseTtlMs: 1_000,
      now: NOW,
    });
    expect(consumed.status).toBe('consumed');
    recordDurableEffect({
      workId: work.workId,
      checkpointId: approval.checkpointId,
      planVersion: work.planVersion,
      nodeId: 'send',
      invocationId: 'invoke-1',
      actionClass: 'external_effect',
      leaseId: consumed.lease!.leaseId,
      processGeneration: 'process:crashed',
      leaseAssertionNow: '2026-07-13T12:00:00.100Z',
      effectClass: 'external_effect',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      now: '2026-07-13T12:00:00.100Z',
    });
    const result = reconcileDurableWorkOnStartup({
      processGeneration: 'process:new',
      now: '2026-07-13T12:00:02.000Z',
    });
    expect(result).toMatchObject({ expired: 1, deliveryUnverified: 1 });
    expect(getDurableWorkUnit(work.workId)?.status).toBe('delivery_unverified');
  });

  it('reconciles an unexpired lease owned by a prior process generation', () => {
    const { work } = readyWork();
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'repository_read',
      now: NOW,
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'repository_read',
      workerId: 'worker-before-restart',
      processGeneration: 'process:before-restart',
      leaseTtlMs: 60_000,
      now: NOW,
    });
    expect(consumed.status).toBe('consumed');

    const result = reconcileDurableWorkOnStartup({
      processGeneration: 'process:after-restart',
      now: '2026-07-13T12:00:01.000Z',
    });

    expect(result).toMatchObject({
      inspected: 1,
      expired: 1,
      interrupted: 1,
      healthyLeaseSkipped: 0,
    });
    expect(getDurableWorkUnit(work.workId)).toMatchObject({
      status: 'interrupted',
      leaseId: null,
      leaseExpiresAt: null,
    });
  });

  it('keeps effect receipts monotonic after a verified success', () => {
    const { work, checkpoint } = readyWork();
    const common = {
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'inspect',
      invocationId: 'invoke-monotonic-1',
      actionClass: 'repository_read',
      effectClass: 'read_only' as const,
      targetScopeKey: binding.targetScopeKey,
    };
    recordDurableEffect({ ...common, status: 'started', now: NOW });
    recordDurableEffect({
      ...common,
      status: 'succeeded',
      postStateFingerprint: `sha256:${'2'.repeat(64)}`,
      now: '2026-07-13T12:00:01.000Z',
    });
    expect(() =>
      recordDurableEffect({
        ...common,
        status: 'unknown',
        now: '2026-07-13T12:00:02.000Z',
      }),
    ).toThrow(/monotonic status/i);
    expect(() =>
      recordDurableEffect({
        ...common,
        status: 'succeeded',
        postStateFingerprint: `sha256:${'3'.repeat(64)}`,
        now: '2026-07-13T12:00:03.000Z',
      }),
    ).toThrow(/immutable scope or monotonic status/i);
    expect(listDurableEffectReceipts({ workId: work.workId })[0]).toMatchObject(
      {
        status: 'succeeded',
        postStateFingerprint: `sha256:${'2'.repeat(64)}`,
      },
    );
  });

  it('atomically claims one non-approval local effect invocation', () => {
    const { work, checkpoint } = readyWork();
    const claim = {
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'save-local-result',
      invocationId: 'invoke-local-result-1',
      actionClass: 'local_save',
      effectClass: 'local_write' as const,
      status: 'started' as const,
      claimExecution: true,
      targetScopeKey: binding.targetScopeKey,
      now: NOW,
    };

    expect(recordDurableEffect(claim).status).toBe('started');
    expect(() =>
      recordDurableEffect({
        ...claim,
        invocationId: 'invoke-local-result-concurrent',
      }),
    ).toThrow(/execution claim is already held/i);
    expect(listDurableEffectReceipts({ workId: work.workId })).toHaveLength(1);
  });

  it('uses compare-and-set transitions and preserves the last verified checkpoint', () => {
    const { work } = readyWork();
    const verifying = transitionDurableWork({
      workId: work.workId,
      expectedVersion: work.version,
      toStatus: 'verifying',
      nextAction: 'Run the postcondition check.',
      now: '2026-07-13T12:02:00.000Z',
    });
    expect(() =>
      transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'completed',
        nextAction: 'This stale writer must fail.',
        now: '2026-07-13T12:03:00.000Z',
      }),
    ).toThrow(/changed/i);
    expect(() =>
      transitionDurableWork({
        workId: verifying.workId,
        expectedVersion: verifying.version,
        toStatus: 'completed',
        nextAction: 'This unverified completion must fail.',
        now: '2026-07-13T12:04:00.000Z',
      }),
    ).toThrow(/verified terminal checkpoint/i);
    expect(getDurableWorkUnit(work.workId)?.checkpointHeadId).toBe(
      work.checkpointHeadId,
    );
  });

  it('chooses inspection for stale state and replan for contradiction', () => {
    const inspect = chooseDurableAdaptiveDecision({
      workId: 'work:1',
      objectiveSummary: 'Resolve one stale repository assumption.',
      staleSignalIds: ['repo-head'],
      candidates: [
        {
          action: 'execute',
          usefulness: 1,
          successProbability: 0.8,
          cost: 0.1,
          latency: 0.1,
          risk: 0.5,
          reversibility: 0.5,
          informationGain: 0,
          verificationMethod: 'Run the focused test.',
          stopCondition: 'Stop on a changed repository identity.',
        },
        {
          action: 'inspect',
          usefulness: 0.7,
          successProbability: 1,
          cost: 0,
          latency: 0,
          risk: 0,
          reversibility: 1,
          informationGain: 1,
          verificationMethod: 'Compare the repository state fingerprint.',
          stopCondition: 'Stop when the stale signal is resolved.',
        },
      ],
      now: NOW,
    });
    expect(inspect.selectedAction).toBe('inspect');

    const replan = chooseDurableAdaptiveDecision({
      workId: 'work:1',
      objectiveSummary: 'Resolve contradicted evidence.',
      contradictionIds: ['contradiction-1'],
      candidates: [
        {
          action: 'execute',
          usefulness: 1,
          successProbability: 1,
          cost: 0,
          latency: 0,
          risk: 0,
          reversibility: 1,
          informationGain: 0,
          verificationMethod: 'Verify later.',
          stopCondition: 'Stop on failure.',
        },
        {
          action: 'replan',
          usefulness: 0.5,
          successProbability: 0.8,
          cost: 0,
          latency: 0,
          risk: 0,
          reversibility: 1,
          informationGain: 0.8,
          verificationMethod: 'Resolve the contradiction first.',
          stopCondition: 'Stop when evidence remains conflicted.',
        },
      ],
      now: NOW,
    });
    expect(replan.selectedAction).toBe('replan');
  });

  it('keeps ordinary conversation off the durable path and reports recovery calmly', () => {
    expect(
      shouldCreateDurableWork({
        taskFamily: 'assistant',
        requestRoute: 'direct_assistant',
      }),
    ).toBe(false);
    expect(
      shouldCreateDurableWork({
        taskFamily: 'code',
        requestRoute: 'code_plane',
      }),
    ).toBe(true);
    const { work } = readyWork();
    const report = buildDurableContinuityReport({
      workId: work.workId,
      now: NOW,
    });
    const text = formatDurableContinuityForUser(report);
    expect(text).toContain('Goal:');
    expect(text).toContain('Last verified checkpoint:');
    expect(text).not.toMatch(/token|chain-of-thought|\/Users\//i);
  });

  it('rejects secrets, raw execution content, and arbitrary paths in persisted summaries', () => {
    expect(() =>
      createOrLoadDurableWork({
        originTurnId: 'turn-secret',
        authorizedSurface: 'telegram',
        binding,
        goalSummary: 'Use password=sentinel-value to continue.',
        nextAction: 'Continue.',
        now: NOW,
      }),
    ).toThrow(/prohibited private execution data/i);
    expect(() =>
      createOrLoadDurableWork({
        originTurnId: 'turn-path',
        authorizedSurface: 'telegram',
        binding,
        goalSummary: 'Edit /Users/example/private/file.txt.',
        nextAction: 'Continue.',
        now: NOW,
      }),
    ).toThrow(/prohibited private execution data/i);
    expect(durableScopeHash('owner', 'private-owner')).not.toContain(
      'private-owner',
    );
  });

  it('executes exactly one dependency-ready node, verifies it, and releases the lease', async () => {
    const { work } = readyWork();
    const consumed = acquireReadLease(work.workId, 'one-node');
    const executeNode = vi.fn(() => ({
      status: 'succeeded' as const,
      postStateFingerprint: 'sha256:poststate',
    }));

    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({ executeNode }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'node_completed',
      nodeId: 'edit',
      executed: true,
      leaseReleased: true,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.checkpoint!.completedNodeIdsJson)).toEqual([
      'inspect',
      'edit',
    ]);
    expect(JSON.parse(result.checkpoint!.pendingNodeIdsJson)).toEqual([
      'verify',
    ]);
    expect(getDurableWorkUnit(work.workId)).toMatchObject({
      status: 'ready',
      leaseId: null,
      leaseExpiresAt: null,
    });
    await expect(
      orchestrateNextDurableNode({
        workId: work.workId,
        leaseId: consumed.lease.leaseId,
        processGeneration: 'process:test',
        executorScopeKey: 'host-executor-1',
        targetScopeKey: binding.targetScopeKey,
        callbacks: executionCallbacks({ executeNode }),
        now: '2026-07-13T12:04:00.000Z',
      }),
    ).rejects.toThrow(/active bound lease/i);
    expect(executeNode).toHaveBeenCalledTimes(1);
  });

  it('replans changed dependency state while preserving completed nodes', async () => {
    const { work } = readyWork();
    const consumed = acquireReadLease(work.workId, 'changed-state');
    const executeNode = vi.fn();
    const replan = vi.fn(() => ({
      pendingNodeIds: ['edit', 'verify'],
      dependencyIds: ['inspect', 'edit'],
      verificationRequirementIds: ['test-pass'],
      nextAction: 'Inspect the changed state before the revised edit.',
    }));

    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        executeNode,
        revalidateNode: () => ({
          dependencyState: 'changed',
          targetState: 'fresh',
          staleSignalIds: ['repo-state'],
        }),
        replan,
      }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result.status).toBe('replanned');
    expect(result.work).toMatchObject({
      status: 'ready',
      planVersion: 2,
      leaseId: null,
    });
    expect(result.leaseReleased).toBe(true);
    expect(executeNode).not.toHaveBeenCalled();
    expect(replan).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'dependency_changed',
        preservedCompletedNodeIds: ['inspect'],
        nextPlanVersion: 2,
      }),
    );
    expect(JSON.parse(result.checkpoint!.completedNodeIdsJson)).toEqual([
      'inspect',
    ]);
  });

  it('verifies a restart-uncertain effect without executing it again', async () => {
    const { work, checkpoint } = readyWork();
    recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'edit',
      invocationId: 'invoke:crashed',
      actionClass: 'repository_read',
      effectClass: 'read_only',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint: 'sha256:prestate',
      now: '2026-07-13T12:01:30.000Z',
    });
    const consumed = acquireReadLease(work.workId, 'uncertain');
    expect(consumed.work.status).toBe('verifying');
    const executeNode = vi.fn();
    const verifyNode = vi.fn(() => ({ status: 'unknown' as const }));

    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({ executeNode, verifyNode }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'verification_required',
      nodeId: 'edit',
      executed: false,
      leaseReleased: true,
    });
    expect(result.work.status).toBe('verification_failed');
    expect(executeNode).not.toHaveBeenCalled();
    expect(verifyNode).toHaveBeenCalledWith(
      expect.objectContaining({ recovery: true }),
    );
    expect(JSON.parse(result.checkpoint!.uncertainNodeIdsJson)).toContain(
      'edit',
    );
    expect(getDurableWorkUnit(work.workId)?.leaseId).toBeNull();
  });

  it('verifies only the selected uncertain node and keeps other uncertainty nonterminal', async () => {
    const { work, checkpoint } = readyWork();
    const editReceipt = recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'edit',
      invocationId: 'invoke:uncertain-edit',
      actionClass: 'repository_read',
      effectClass: 'read_only',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint: 'sha256:edit-prestate',
      now: '2026-07-13T12:01:10.000Z',
    });
    const verifyReceipt = recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'verify',
      invocationId: 'invoke:uncertain-verify',
      actionClass: 'verification_test',
      effectClass: 'read_only',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint: 'sha256:verify-prestate',
      now: '2026-07-13T12:01:20.000Z',
    });
    const uncertain = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      completedNodeIds: ['inspect'],
      pendingNodeIds: [],
      uncertainNodeIds: ['edit', 'verify'],
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      receiptIds: [editReceipt.receiptId, verifyReceipt.receiptId],
      recoveryPolicy: 'verify_unknown_effect',
      nextSafeAction: 'Verify each uncertain effect without replaying it.',
      status: 'verification_needed',
      now: '2026-07-13T12:01:30.000Z',
    });
    const consumed = acquireReadLease(uncertain.work.workId, 'multi-uncertain');
    const executeNode = vi.fn();
    const verifyNode = vi.fn(() => ({
      status: 'verified' as const,
      verificationFingerprint: 'sha256:edit-verified',
      postStateFingerprint: 'sha256:edit-poststate',
    }));

    const result = await orchestrateNextDurableNode({
      workId: uncertain.work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({ executeNode, verifyNode }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'node_completed',
      nodeId: 'edit',
      executed: false,
      leaseReleased: true,
    });
    expect(result.work.status).toBe('ready');
    expect(JSON.parse(result.checkpoint!.uncertainNodeIdsJson)).toEqual([
      'verify',
    ]);
    expect(result.checkpoint?.status).toBe('open');
    expect(executeNode).not.toHaveBeenCalled();
    expect(verifyNode).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: true,
        existingReceipt: expect.objectContaining({ nodeId: 'edit' }),
      }),
    );
  });

  it('fails closed on postcondition failure and releases the lease', async () => {
    const { work } = readyWork();
    const consumed = acquireReadLease(work.workId, 'failed-verification');
    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        verifyNode: () => ({ status: 'failed' }),
      }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'verification_failed',
      nodeId: 'edit',
      executed: true,
      leaseReleased: true,
    });
    expect(result.work).toMatchObject({
      status: 'verification_failed',
      leaseId: null,
    });
    expect(JSON.parse(result.checkpoint!.completedNodeIdsJson)).toEqual([
      'inspect',
    ]);
    expect(JSON.parse(result.checkpoint!.uncertainNodeIdsJson)).toContain(
      'edit',
    );
    expect(
      listDurableEffectReceipts({ workId: work.workId }).at(-1)?.status,
    ).toBe('failed');
  });

  it('treats a verifier claim without fingerprints as unknown evidence', async () => {
    const { work } = readyWork();
    const consumed = acquireReadLease(work.workId, 'missing-fingerprint');
    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        verifyNode: () =>
          ({ status: 'verified' }) as unknown as DurableNodeVerification,
      }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'verification_required',
      executed: true,
      leaseReleased: true,
    });
    expect(result.work.status).toBe('verification_failed');
    expect(result.receipt?.verificationFingerprint).toBeNull();
  });

  it('does not complete an empty checkpoint without referenced verified proof', async () => {
    const emptyBinding = {
      ...binding,
      targetScopeKey: 'repository-empty-terminal-fixture',
    };
    const created = createOrLoadDurableWork({
      originTurnId: 'turn-empty-terminal',
      authorizedSurface: 'telegram',
      binding: emptyBinding,
      goalSummary: 'Verify one empty terminal fixture without inventing proof.',
      status: 'ready',
      nextAction: 'Commit the bounded terminal checkpoint.',
      now: NOW,
    });
    const committed = commitDurableCheckpointCAS({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      completedNodeIds: ['inspect'],
      pendingNodeIds: [],
      uncertainNodeIds: [],
      executorScopeKey: 'host-executor-empty',
      targetScopeKey: emptyBinding.targetScopeKey,
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Require terminal verification evidence.',
      status: 'open',
      now: NOW,
    });
    const issued = issueDurableResumeGrant({
      workId: committed.work.workId,
      binding: emptyBinding,
      actionClass: 'repository_read',
      now: '2026-07-13T12:01:00.000Z',
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding: emptyBinding,
      actionClass: 'repository_read',
      workerId: 'worker-empty-terminal',
      processGeneration: 'process:test',
      leaseTtlMs: 5 * 60_000,
      now: '2026-07-13T12:02:00.000Z',
    });
    expect(consumed.status).toBe('consumed');
    if (consumed.status !== 'consumed' || !consumed.work || !consumed.lease) {
      throw new Error('Failed to acquire the empty terminal fixture lease.');
    }

    const result = await orchestrateNextDurableNode({
      workId: consumed.work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-empty',
      targetScopeKey: emptyBinding.targetScopeKey,
      callbacks: {
        ...executionCallbacks(),
        loadPlan: ({ work: current }) => executionPlan(current.planVersion),
      },
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'verification_required',
      executed: false,
      leaseReleased: true,
    });
    expect(result.work.status).toBe('verifying');
  });

  it('denies external effects by default before invoking the executor', async () => {
    const { work } = readyWork();
    const approval = seedApprovedPacket(work.workId, 'external_effect');
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'external_effect',
      approvalPacketId: approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      inboundMessageId: 'message-external-denied',
      now: '2026-07-13T12:01:00.000Z',
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'external_effect',
      inboundMessageId: 'message-external-denied',
      workerId: 'worker-external-denied',
      processGeneration: 'process:test',
      leaseTtlMs: 5 * 60_000,
      now: '2026-07-13T12:02:00.000Z',
    });
    expect(consumed.status).toBe('consumed');
    if (consumed.status !== 'consumed' || !consumed.lease) {
      throw new Error('Failed to acquire the external-effect fixture lease.');
    }
    const executeNode = vi.fn();
    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        loadPlan: ({ work: current }) => ({
          ...executionPlan(current.planVersion),
          nodes: executionPlan(current.planVersion).nodes.map((node) =>
            node.nodeId === 'edit'
              ? {
                  ...node,
                  actionClass: 'external_effect',
                  effectClass: 'external_effect' as const,
                }
              : node,
          ),
        }),
        executeNode,
      }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result.status).toBe('external_effect_denied');
    expect(result.work.status).toBe('blocked');
    expect(result.leaseReleased).toBe(true);
    expect(executeNode).not.toHaveBeenCalled();
    expect(listDurableEffectReceipts({ workId: work.workId })).toEqual([]);
  });

  it('requires current approval before issuing a repository-write alias grant', () => {
    const { work } = readyWork();
    expect(() =>
      acquireReadLease(work.workId, 'write-alias', 'edit_file'),
    ).toThrow(/fresh approval is required/i);
    expect(listDurableEffectReceipts({ workId: work.workId })).toEqual([]);
  });

  it('keeps capability sandbox writes out of generic grants and execution plans', async () => {
    const { work, checkpoint } = readyWork();
    expect(() =>
      issueDurableResumeGrant({
        workId: work.workId,
        binding,
        actionClass: 'sandbox_repository_write',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/capability-sandbox-only/i);
    expect(() =>
      recordDurableEffect({
        workId: work.workId,
        checkpointId: checkpoint.durableCheckpointId,
        planVersion: work.planVersion,
        nodeId: 'sandbox-write',
        invocationId: 'invoke:generic-sandbox-write',
        actionClass: 'sandbox_repository_write',
        effectClass: 'sandbox_repository_write',
        status: 'started',
        targetScopeKey: binding.targetScopeKey,
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/capability-sandbox-only/i);

    const consumed = acquireReadLease(
      work.workId,
      'sandbox-plan',
      'local_save',
    );
    const executeNode = vi.fn();
    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        loadPlan: ({ work: current }) => ({
          ...executionPlan(current.planVersion),
          nodes: executionPlan(current.planVersion).nodes.map((node) =>
            node.nodeId === 'edit'
              ? {
                  ...node,
                  actionClass: 'sandbox_repository_write',
                  effectClass: 'sandbox_repository_write' as const,
                }
              : node,
          ),
        }),
        executeNode,
      }),
      now: '2026-07-13T12:03:00.000Z',
    });
    expect(result.status).toBe('replan_required');
    expect(result.executed).toBe(false);
    expect(result.leaseReleased).toBe(true);
    expect(executeNode).not.toHaveBeenCalled();
    expect(listDurableEffectReceipts({ workId: work.workId })).toEqual([]);
  });

  it('rejects unknown mutation-like aliases and mismatched effects before execution', async () => {
    const { work, checkpoint } = readyWork();
    for (const actionClass of ['send_message', 'push_changes', 'delete_file']) {
      expect(() =>
        issueDurableResumeGrant({
          workId: work.workId,
          binding,
          actionClass,
          now: '2026-07-13T12:01:00.000Z',
        }),
      ).toThrow(/closed policy set/i);
    }
    expect(() =>
      recordDurableEffect({
        workId: work.workId,
        checkpointId: checkpoint.durableCheckpointId,
        planVersion: work.planVersion,
        nodeId: 'edit',
        invocationId: 'invoke:mislabeled-send',
        actionClass: 'send',
        effectClass: 'local_write',
        status: 'started',
        targetScopeKey: binding.targetScopeKey,
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/closed execution policy/i);

    const consumed = acquireReadLease(
      work.workId,
      'unknown-plan-action',
      'local_save',
    );
    const executeNode = vi.fn();
    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        loadPlan: ({ work: current }) => ({
          ...executionPlan(current.planVersion),
          nodes: executionPlan(current.planVersion).nodes.map((node) =>
            node.nodeId === 'edit'
              ? {
                  ...node,
                  actionClass: 'send_message',
                  effectClass: 'local_write' as const,
                }
              : node,
          ),
        }),
        executeNode,
      }),
      now: '2026-07-13T12:03:00.000Z',
    });
    expect(result.status).toBe('replan_required');
    expect(result.executed).toBe(false);
    expect(executeNode).not.toHaveBeenCalled();
  });

  it('does not downgrade a succeeded pre-crash receipt when verification remains unknown', async () => {
    const { work, checkpoint } = readyWork();
    recordDurableEffect({
      workId: work.workId,
      checkpointId: checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'edit',
      invocationId: 'invoke:precrash-success',
      actionClass: 'repository_read',
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: binding.targetScopeKey,
      preStateFingerprint: 'sha256:prestate',
      postStateFingerprint: 'sha256:poststate',
      now: '2026-07-13T12:01:30.000Z',
    });
    const consumed = acquireReadLease(work.workId, 'precrash-success');
    expect(consumed.work.status).toBe('verifying');
    const executeNode = vi.fn();

    const result = await orchestrateNextDurableNode({
      workId: work.workId,
      leaseId: consumed.lease.leaseId,
      processGeneration: 'process:test',
      executorScopeKey: 'host-executor-1',
      targetScopeKey: binding.targetScopeKey,
      callbacks: executionCallbacks({
        executeNode,
        verifyNode: () => ({ status: 'unknown' }),
      }),
      now: '2026-07-13T12:03:00.000Z',
    });

    expect(result.status).toBe('verification_required');
    expect(result.leaseReleased).toBe(true);
    expect(executeNode).not.toHaveBeenCalled();
    const receipt = listDurableEffectReceipts({ workId: work.workId }).find(
      (candidate) => candidate.nodeId === 'edit',
    );
    expect(receipt).toMatchObject({
      status: 'succeeded',
      verificationFingerprint: null,
    });
  });

  it('moves unexpected in-flight failures to recoverable truth before releasing the lease', async () => {
    const { work } = readyWork();
    const consumed = acquireReadLease(work.workId, 'callback-failure');
    const executeNode = vi.fn(() => ({ status: 'succeeded' as const }));

    await expect(
      orchestrateNextDurableNode({
        workId: work.workId,
        leaseId: consumed.lease.leaseId,
        processGeneration: 'process:test',
        executorScopeKey: 'host-executor-1',
        targetScopeKey: binding.targetScopeKey,
        callbacks: executionCallbacks({
          executeNode,
          completeScope: () => ({ receiptIds: ['unsafe/receipt'] }),
        }),
        now: '2026-07-13T12:03:00.000Z',
      }),
    ).rejects.toThrow(/unsafe durable scope receipt/i);

    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(getDurableWorkUnit(work.workId)).toMatchObject({
      status: 'verifying',
      leaseId: null,
      leaseExpiresAt: null,
    });
    expect(
      listDurableEffectReceipts({ workId: work.workId }).at(-1)?.status,
    ).toBe('started');
  });

  it('enforces replan transitions and tracks delivery separately from completion', () => {
    const ready = readyWork();
    const { work } = ready;
    expect(() =>
      replanDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        preservedCompletedNodeIds: ['inspect'],
        reasonCode: 'invalid_direct_replan',
        nextAction: 'This direct transition must be rejected.',
        now: '2026-07-13T12:01:00.000Z',
      }),
    ).toThrow(/ready -> planned/i);

    const terminal = verifiedWork(ready);
    const completed = transitionDurableWork({
      workId: terminal.work.workId,
      expectedVersion: terminal.work.version,
      toStatus: 'completed',
      nextAction: 'Deliver the verified result.',
      now: '2026-07-13T12:03:00.000Z',
    });
    const pendingDelivery = transitionDurableDeliveryState({
      workId: completed.workId,
      expectedVersion: completed.version,
      toState: 'pending',
      nextAction: 'Deliver the verified result once.',
      now: '2026-07-13T12:04:00.000Z',
    });
    expect(pendingDelivery).toMatchObject({
      status: 'completed',
      deliveryState: 'pending',
      ownerReviewId: null,
    });
    const delivered = transitionDurableDeliveryState({
      workId: completed.workId,
      expectedVersion: pendingDelivery.version,
      toState: 'delivered',
      nextAction: 'Await owner review before learning.',
      now: '2026-07-13T12:05:00.000Z',
    });
    expect(delivered).toMatchObject({
      status: 'completed',
      deliveryState: 'delivered',
      ownerReviewId: null,
    });
    expect(() =>
      transitionDurableDeliveryState({
        workId: delivered.workId,
        expectedVersion: delivered.version,
        toState: 'pending',
        nextAction: 'Do not regress delivered truth.',
        now: '2026-07-13T12:06:00.000Z',
      }),
    ).toThrow(/delivered -> pending/i);

    const uncertainDelivery = createOrLoadDurableWork({
      originTurnId: 'turn-delivery-unknown',
      authorizedSurface: 'telegram',
      binding,
      goalSummary: 'Track one delivery whose external outcome is unknown.',
      nextAction: 'Inspect delivery truth before any retry.',
      now: '2026-07-13T12:07:00.000Z',
    }).work;
    const unknown = transitionDurableDeliveryState({
      workId: uncertainDelivery.workId,
      expectedVersion: uncertainDelivery.version,
      toState: 'unknown',
      nextAction: 'Inspect delivery truth before any retry.',
      now: '2026-07-13T12:08:00.000Z',
    });
    expect(() =>
      transitionDurableDeliveryState({
        workId: unknown.workId,
        expectedVersion: unknown.version,
        toState: 'pending',
        nextAction: 'Do not retry an unknown delivery.',
        now: '2026-07-13T12:09:00.000Z',
      }),
    ).toThrow(/unknown -> pending/i);
  });
});
