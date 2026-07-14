import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  listCognitiveApprovalPackets,
  upsertCognitiveRun,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  issueDurableResumeGrant,
  recordDurableEffect,
  stageDurableWorkApproval,
} from './durable-work-continuity.js';
import {
  buildDurableContinuityNaturalReply,
  formatPendingActionReminderDisambiguation,
  reconcileDurableContinuityBeforeAcceptingWork,
  resolvePendingActionReminderContinuation,
} from './index.js';
import { isAgencyConvergenceNaturalRequest } from './agency-convergence-loop.js';
import { isAgentOSNaturalRequest } from './agent-os.js';
import { isAgentRuntimeSpineNaturalRequest } from './agent-runtime-spine.js';
import { isSessionGraphNaturalRequest } from './session-graph.js';
import { isSupervisorNaturalRequest } from './supervisor-kernel.js';

const NOW = '2026-07-13T12:00:00.000Z';
const binding = {
  ownerId: 'owner-index-continuity',
  chatId: 'chat-index-continuity',
  groupId: 'main',
  channel: 'telegram',
  targetScopeKey: 'repository-index-continuity',
};

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function seedCheckpoint() {
  const created = createOrLoadDurableWork({
    originTurnId: 'turn-index-continuity',
    authorizedSurface: 'telegram',
    binding,
    goalSummary: 'Repair one bounded fixture and verify the result.',
    status: 'ready',
    cognitiveRunId: 'cognitive:index-continuity',
    nextAction: 'Resume from the edit step after inspecting repository state.',
    now: NOW,
  });
  return commitDurableCheckpointCAS({
    workId: created.work.workId,
    expectedWorkVersion: created.work.version,
    completedNodeIds: ['inspect'],
    pendingNodeIds: ['edit', 'verify'],
    uncertainNodeIds: [],
    dependencyIds: ['inspect'],
    worldSignals: { fresh: ['repository'], stale: [], missing: [] },
    executorScopeKey: 'host-executor-index-continuity',
    targetScopeKey: binding.targetScopeKey,
    preStateFingerprint: 'sha256:index-prestate',
    verificationRequirementIds: ['fixture-test'],
    stopConditionIds: ['terminal-error'],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction:
      'Inspect the target again, then execute only the edit step.',
    now: NOW,
  });
}

describe('Andrea durable continuity runtime wiring', () => {
  it('requires an explicit target when multiple reminder drafts await timing', () => {
    const states = [
      {
        version: 1 as const,
        createdAt: NOW,
        label: 'call the pharmacy',
        status: 'awaiting_time' as const,
      },
      {
        version: 1 as const,
        createdAt: '2026-07-13T12:01:00.000Z',
        label: 'email the school',
        status: 'awaiting_time' as const,
      },
    ];
    expect(
      resolvePendingActionReminderContinuation(states, 'Friday afternoon'),
    ).toBeNull();
    expect(
      resolvePendingActionReminderContinuation(
        states,
        'call the pharmacy: Friday afternoon',
      ),
    ).toMatchObject({
      state: { label: 'call the pharmacy' },
      timingText: 'Friday afternoon',
    });
    expect(formatPendingActionReminderDisambiguation(states)).toContain(
      'call the pharmacy: Friday afternoon',
    );
  });

  it('leaves bare conversational continuation to the ordinary chat router', () => {
    const cognitionStatusPredicates = [
      isAgencyConvergenceNaturalRequest,
      isAgentOSNaturalRequest,
      isAgentRuntimeSpineNaturalRequest,
      isSessionGraphNaturalRequest,
      isSupervisorNaturalRequest,
    ];
    for (const predicate of cognitionStatusPredicates) {
      expect(predicate('resume that')).toBe(false);
      expect(predicate('keep going')).toBe(false);
    }
    expect(isAgentRuntimeSpineNaturalRequest('runtime spine status')).toBe(
      true,
    );
  });

  it('answers natural recovery requests locally from group-scoped durable truth', () => {
    seedCheckpoint();

    expect(
      buildDurableContinuityNaturalReply({
        text: 'hello there',
        groupFolder: 'main',
        now: NOW,
      }),
    ).toBeNull();

    const reply = buildDurableContinuityNaturalReply({
      text: 'what survived the restart?',
      groupFolder: 'main',
      now: NOW,
    });
    expect(reply).toContain(
      'Goal: Repair one bounded fixture and verify the result.',
    );
    expect(reply).toContain('Last verified checkpoint: 1 completed step(s)');
    expect(reply).toContain('Remaining work: 2 step(s)');
    expect(reply).not.toMatch(
      /\bwork:[A-Za-z0-9]|resume token|chain-of-thought/i,
    );

    expect(
      buildDurableContinuityNaturalReply({
        text: 'keep going',
        groupFolder: 'main',
        now: NOW,
      }),
    ).toBeNull();
    expect(
      buildDurableContinuityNaturalReply({
        text: 'resume the durable mission',
        groupFolder: 'main',
        now: NOW,
      }),
    ).toContain('Goal: Repair one bounded fixture');

    expect(
      buildDurableContinuityNaturalReply({
        text: 'where did you stop?',
        groupFolder: 'another-group',
        now: NOW,
      }),
    ).toBe('No durable mission is waiting for recovery.');
  });

  it('prefers recoverable work over a newer terminal history item', () => {
    seedCheckpoint();
    createOrLoadDurableWork({
      originTurnId: 'turn-index-terminal-history',
      authorizedSurface: 'telegram',
      binding: {
        ...binding,
        chatId: 'chat-index-terminal-history',
      },
      goalSummary: 'A newer terminal history item.',
      status: 'cancelled',
      nextAction: 'No action remains.',
      now: '2026-07-13T12:00:01.000Z',
    });

    const reply = buildDurableContinuityNaturalReply({
      text: 'what survived the restart?',
      groupFolder: 'main',
      now: '2026-07-13T12:00:02.000Z',
    });
    expect(reply).toContain(
      'Goal: Repair one bounded fixture and verify the result.',
    );
    expect(reply).not.toContain('A newer terminal history item.');
  });

  it('reconciles expired work before the host accepts another turn', () => {
    const { work, checkpoint } = seedCheckpoint();
    upsertCognitiveRun({
      runId: 'cognitive:index-continuity',
      createdAt: NOW,
      updatedAt: NOW,
      groupFolder: 'main',
      channel: 'telegram',
      taskFamily: 'code',
      turnId: 'turn-index-continuity',
      runOrigin: 'live',
      goalSummary: 'Approve one external continuity fixture effect.',
      selectedSkillId: 'continuity.fixture',
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
      workId: work.workId,
      expectedWorkVersion: work.version,
      cognitiveRunId: 'cognitive:index-continuity',
      actionClass: 'external_effect',
      summary: 'Approve one external continuity fixture effect.',
      checkpointId: checkpoint.durableCheckpointId,
      now: NOW,
    });
    const staged = listCognitiveApprovalPackets({
      runId: 'cognitive:index-continuity',
      status: 'staged',
    }).find(
      (packet) =>
        packet.approvalPacketId === stagedResult.packet.approvalPacketId,
    )!;
    const approval = approveCognitiveApprovalPacketCAS({
      approvalPacketId: staged.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: staged.summary,
      expectedApprovalVersion: staged.approvalVersion || 1,
      expectedScopeDigest: staged.scopeDigest || null,
      now: '2026-07-13T12:00:00.010Z',
      approvalChannel: 'owner_cockpit',
    });
    expect(approval.status).toBe('approved');
    const issued = issueDurableResumeGrant({
      workId: work.workId,
      binding,
      actionClass: 'external_effect',
      approvalPacketId: staged.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      now: '2026-07-13T12:00:00.020Z',
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding,
      actionClass: 'external_effect',
      workerId: 'worker-before-outage',
      processGeneration: 'process:before-outage',
      leaseTtlMs: 1_000,
      now: '2026-07-13T12:00:00.030Z',
    });
    expect(consumed.status).toBe('consumed');
    expect(consumed.lease).toBeTruthy();
    recordDurableEffect({
      workId: work.workId,
      checkpointId: stagedResult.checkpoint.durableCheckpointId,
      planVersion: work.planVersion,
      nodeId: 'external-check',
      invocationId: 'invoke-index-continuity',
      actionClass: 'external_effect',
      leaseId: consumed.lease!.leaseId,
      processGeneration: 'process:before-outage',
      leaseAssertionNow: '2026-07-13T12:00:00.100Z',
      effectClass: 'external_effect',
      status: 'started',
      targetScopeKey: binding.targetScopeKey,
      now: '2026-07-13T12:00:00.100Z',
    });

    expect(
      reconcileDurableContinuityBeforeAcceptingWork('2026-07-13T12:00:02.000Z'),
    ).toMatchObject({
      inspected: 1,
      expired: 1,
      deliveryUnverified: 1,
    });
  });
});
