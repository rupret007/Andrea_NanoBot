import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginAgentRuntimeSpineRun,
  finalizeAgentRuntimeSpineOutcome,
  reconcileInterruptedAgentRuntimeRuns,
  recordAgentRuntimeTruthAudit,
} from './agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getAgentOSEpisode,
  getAgentRuntimeRun,
  listAgentOSEpisodeSteps,
  listAgentOSTrajectoryEvals,
  listCognitiveApprovalPackets,
} from './db.js';
import { beginCognitiveKernelRun } from './cognitive-kernel.js';
import {
  consumeResumeGrantAndAcquireLease,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
} from './durable-work-continuity.js';
import { runTruthEngine } from './truth-engine.js';

describe('agent runtime spine lifecycle', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('closes the linked Agent OS episode without promoting an unreviewed runtime trajectory', () => {
    const generatedAt = '2026-07-12T12:00:00.000Z';
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-complete',
      channel: 'telegram',
      groupFolder: 'main',
      goal: 'Summarize the verified local status.',
      generatedAt,
      mode: 'assistive',
    });
    expect(runtime).not.toBeNull();

    const truth = runTruthEngine({
      text: `Runtime evidence ${runtime?.run.worldSnapshotId}.`,
      subject: runtime?.run.goalSummary || 'runtime status',
      generatedAt,
    });
    recordAgentRuntimeTruthAudit({
      runtime,
      truthVerdict: truth,
      generatedAt,
    });
    const completedAt = '2026-07-12T12:00:01.000Z';
    const finalized = finalizeAgentRuntimeSpineOutcome({
      runtime,
      generatedAt: completedAt,
      evaluationStatus: 'pass',
      routeUsed: 'local_status',
      answerClass: 'handled',
    });

    expect(finalized?.status).toBe('completed');
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode).toMatchObject({
      status: 'completed',
      completedAt,
    });
    expect(JSON.parse(episode?.linkedRunIdsJson || '[]')).toContain(
      runtime?.run.runtimeRunId,
    );
    expect(
      listAgentOSEpisodeSteps({ episodeId: episode?.episodeId }).at(-1),
    ).toMatchObject({ stepKind: 'outcome', status: 'completed' });
    const trajectory = listAgentOSTrajectoryEvals({
      episodeId: episode?.episodeId,
    })[0];
    expect(trajectory).toMatchObject({
      promotionEligible: false,
      verificationStrength: 0.86,
    });
    expect(trajectory.nextAction).toMatch(/owner-reviewed outcome/i);
  });

  it('marks prior-process active runs interrupted instead of inferring success', () => {
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-interrupted',
      channel: 'bluebubbles',
      groupFolder: 'main',
      goal: 'Show the current deferred message action.',
      generatedAt: '2026-07-12T12:10:00.000Z',
      mode: 'assistive',
    });
    expect(runtime?.run.status).toBe('active');

    const result = reconcileInterruptedAgentRuntimeRuns({
      generatedAt: '2026-07-12T12:11:00.000Z',
    });

    expect(result).toMatchObject({ interrupted: 1, episodeSynced: 1 });
    const storedRun = getAgentRuntimeRun(
      runtime?.run.runtimeRunId || 'missing',
    );
    expect(storedRun?.status).toBe('interrupted');
    expect(storedRun?.outcomeJson).toContain(
      'prior_process_ended_before_outcome_verification',
    );
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode).toMatchObject({
      status: 'interrupted',
      completedAt: null,
    });
    const trajectory = listAgentOSTrajectoryEvals({
      episodeId: episode?.episodeId,
    })[0];
    expect(trajectory).toMatchObject({
      status: 'fail',
      promotionEligible: false,
    });
    expect(trajectory.demotionSignalsJson).toContain(
      'interrupted_before_outcome_verification',
    );
  });

  it('preserves fresh approval boundaries as nonterminal', () => {
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-lifecycle-approval',
      channel: 'telegram',
      groupFolder: 'main',
      goal: 'Send this external message now.',
      generatedAt: '2026-07-12T12:20:00.000Z',
      mode: 'assistive',
    });
    expect(runtime?.run.status).toBe('awaiting_approval');
    expect(runtime?.report.interrupts[0]?.resumeTokenId).toBeNull();
    expect(runtime?.report.resumeTokens).toHaveLength(1);
    expect(runtime?.report.resumeTokens[0]).toMatchObject({
      status: 'revoked',
      expiresAt: '2026-07-12T12:20:00.000Z',
      usedAt: '2026-07-12T12:20:00.000Z',
    });
    expect(runtime?.report.resumeTokens[0]?.safeStateJson).toContain(
      'durable_grant_required',
    );
    const finalized = finalizeAgentRuntimeSpineOutcome({
      runtime,
      generatedAt: '2026-07-12T12:20:01.000Z',
      evaluationStatus: 'pass',
      routeUsed: 'message_action',
      answerClass: 'handled',
    });

    expect(finalized?.status).toBe('awaiting_approval');
    const episode = getAgentOSEpisode(
      runtime?.run.agentOSEpisodeId || 'missing',
    );
    expect(episode?.status).toBe('awaiting_approval');
    expect(
      listAgentOSTrajectoryEvals({ episodeId: episode?.episodeId }),
    ).toEqual([]);
  });

  it('does not stage authority from the broad channel-and-chat fallback', () => {
    const cognitive = beginCognitiveKernelRun({
      turnId: 'runtime-no-exact-target',
      channel: 'telegram',
      groupFolder: 'main',
      taskFamily: 'communication',
      goal: 'Send the message now.',
      requestRoute: 'message_action',
      selectedSkillId: 'communication.send',
      selectedSkillPurpose: 'Stage a message only for an exact target.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'strong',
    });
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-no-exact-target',
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'owner-no-exact-target',
      chatId: 'chat-no-exact-target',
      goal: 'Send the message now.',
      taskFamily: 'communication',
      requestRoute: 'message_action',
      cognitiveRun: cognitive,
      generatedAt: '2026-07-12T12:30:00.000Z',
      mode: 'assistive',
    });

    expect(runtime?.durableWork).toMatchObject({
      status: 'awaiting_approval',
      approvalPacketId: null,
      approvalVersion: null,
    });
    expect(
      listCognitiveApprovalPackets({ runId: cognitive.run.runId }).filter(
        (packet) => packet.durableWorkId === runtime?.durableWork?.workId,
      ),
    ).toEqual([]);
  });

  it('can complete Runtime Spine durable nodes through receipt-backed checkpoints', async () => {
    const targetScopeKey = 'runtime-spine-end-to-end-target';
    const binding = {
      ownerId: 'runtime-spine-owner',
      chatId: 'runtime-spine-chat',
      groupId: 'main',
      channel: 'telegram',
      targetScopeKey,
    };
    const runtime = beginAgentRuntimeSpineRun({
      turnId: 'runtime-spine-end-to-end',
      channel: binding.channel,
      groupFolder: binding.groupId,
      actorId: binding.ownerId,
      chatId: binding.chatId,
      targetScopeKey,
      explicitlyDurable: true,
      taskFamily: 'assistant',
      goal: 'Inspect and verify one bounded local mission.',
      generatedAt: '2026-07-12T12:40:00.000Z',
      mode: 'assistive',
    });
    expect(runtime?.durableWork).toBeTruthy();
    const workId = runtime!.durableWork!.workId;
    const planNodes = ['tool_step', 'verification', 'outcome'].map(
      (nodeId, position) => ({
        nodeId,
        position,
        actionClass: 'local_lookup',
        effectClass: 'read_only' as const,
        dependsOnNodeIds: position
          ? [['tool_step', 'verification', 'outcome'][position - 1]!]
          : [],
        verificationRequirementIds: [`${nodeId}-proof`],
      }),
    );

    let finalStatus = '';
    for (let index = 0; index < planNodes.length; index += 1) {
      const second = 10 + index * 10;
      const grant = issueDurableResumeGrant({
        workId,
        binding,
        actionClass: 'local_lookup',
        now: `2026-07-12T12:40:${String(second).padStart(2, '0')}.000Z`,
      });
      const consumed = consumeResumeGrantAndAcquireLease({
        token: grant.token,
        binding,
        actionClass: 'local_lookup',
        workerId: `runtime-spine-worker-${index}`,
        processGeneration: 'process:runtime-spine-end-to-end',
        leaseTtlMs: 60_000,
        now: `2026-07-12T12:40:${String(second + 1).padStart(2, '0')}.000Z`,
      });
      expect(consumed.status).toBe('consumed');
      if (consumed.status !== 'consumed' || !consumed.lease) {
        throw new Error('Runtime Spine fixture did not acquire its lease.');
      }
      const result = await orchestrateNextDurableNode({
        workId,
        leaseId: consumed.lease.leaseId,
        processGeneration: 'process:runtime-spine-end-to-end',
        executorScopeKey: 'runtime-spine:assistive',
        targetScopeKey,
        callbacks: {
          loadPlan: ({ work }) => ({
            planId: 'runtime-spine-end-to-end-plan',
            planVersion: work.planVersion,
            nodes: planNodes,
          }),
          revalidateNode: () => ({
            dependencyState: 'fresh',
            targetState: 'fresh',
            preStateFingerprint: 'sha256:runtime-spine-prestate',
          }),
          executeNode: ({ node }) => ({
            status: 'succeeded',
            postStateFingerprint: `sha256:${node.nodeId}-poststate`,
          }),
          verifyNode: ({ node }) => ({
            status: 'verified',
            verificationFingerprint: `sha256:${node.nodeId}-verified`,
            postStateFingerprint: `sha256:${node.nodeId}-poststate`,
          }),
        },
        now: `2026-07-12T12:40:${String(second + 2).padStart(2, '0')}.000Z`,
      });
      finalStatus = result.status;
      expect(result.executed).toBe(true);
      expect(result.leaseReleased).toBe(true);
      if (index < planNodes.length - 1) {
        expect(result.status).toBe('node_completed');
        expect(result.work.status).toBe('ready');
      } else {
        expect(result.status).toBe('work_completed');
        expect(result.work.status).toBe('completed');
        expect(JSON.parse(result.checkpoint!.completedNodeIdsJson)).toEqual(
          planNodes.map((node) => node.nodeId),
        );
      }
    }
    expect(finalStatus).toBe('work_completed');
  });
});
