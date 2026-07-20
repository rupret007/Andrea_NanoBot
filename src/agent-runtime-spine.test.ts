import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  beginAgentRuntimeSpineRun,
  finalizeAgentRuntimeSpineOutcome,
  reconcileInterruptedAgentRuntimeRuns,
  recordAgentRuntimeTruthAudit,
} from './agent-runtime-spine.js';
import type { AdaptiveDurableNodeBinding } from './adaptive-cognition-durable-adapter.js';
import {
  buildAdaptivePlanGraph,
  createAdaptiveProblemFrame,
} from './adaptive-cognition-engine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getAgentOSEpisode,
  getAgentRuntimeRun,
  getDurableWorkCheckpoint,
  listAgentOSEpisodeSteps,
  listAgentOSTrajectoryEvals,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
} from './db.js';
import { beginCognitiveKernelRun } from './cognitive-kernel.js';
import {
  consumeResumeGrantAndAcquireLease,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
} from './durable-work-continuity.js';
import { runTruthEngine } from './truth-engine.js';

function adaptiveRuntimeFixture(input: {
  targetScopeKey: string;
  effectful?: boolean;
}) {
  const criterionId = input.effectful
    ? 'criterion:runtime-effect'
    : 'criterion:runtime-read';
  const frame = createAdaptiveProblemFrame({
    frameId: input.effectful ? 'frame:runtime-effect' : 'frame:runtime-read',
    createdAt: '2026-07-12T12:00:00.000Z',
    objective: input.effectful
      ? 'Apply one explicitly bound effect and verify its receipt.'
      : 'Inspect one explicitly bound target and verify the observation.',
    taskFamily: input.effectful ? 'communication' : 'assistant',
    channel: 'telegram',
    successCriteria: [
      {
        criterionId,
        description: 'The exact target has independently verified evidence.',
        requiredEvidenceClasses: ['observed'],
        minimumConfidence: 0.8,
      },
    ],
    authority: {
      actorScope: 'telegram:main',
      maximumActionClass: input.effectful
        ? 'approval_gated_mutation'
        : 'read_only',
    },
    contextRefs: [
      `target:${criterionId}:${input.targetScopeKey}`,
      ...(input.effectful ? [`receipt_required:${criterionId}`] : []),
    ],
  });
  const graph = buildAdaptivePlanGraph({
    graphId: input.effectful
      ? 'adaptive:graph:runtime-effect'
      : 'adaptive:graph:runtime-read',
    createdAt: frame.createdAt,
    frame,
    actions: [
      {
        actionId: input.effectful
          ? 'adaptive:runtime:send'
          : 'adaptive:runtime:inspect',
        title: input.effectful
          ? 'Apply the exact approved effect'
          : 'Inspect the exact bounded target',
        purpose: input.effectful
          ? 'Use only the explicitly bound effect adapter.'
          : 'Use only the explicitly bound read adapter.',
        toolId: input.effectful
          ? 'runtime-effect-adapter'
          : 'runtime-read-adapter',
        actionClass: input.effectful ? 'mutation' : 'local_lookup',
        mutationClass: input.effectful ? 'external_irreversible' : 'none',
        approvalRequired: input.effectful === true,
        requiredEvidence: input.effectful
          ? ['effect_receipt', 'postcondition']
          : ['bounded_observation'],
        producesCriterionIds: [criterionId],
        expectedEvidenceClass: 'observed',
        priority: 1,
        maxAttempts: 1,
        timeoutMs: 2_000,
        verifier: {
          kind: input.effectful ? 'receipt' : 'postcondition',
          requirementIds: input.effectful
            ? ['effect_receipt', 'postcondition']
            : ['bounded_observation'],
        },
      },
    ],
  });
  const node = graph.nodes.find((candidate) =>
    ['act', 'recover'].includes(candidate.kind),
  )!;
  const bindings: AdaptiveDurableNodeBinding[] = [
    {
      graphId: graph.graphId,
      planContractDigest: graph.planContractDigest,
      nodeId: node.nodeId,
      actionId: node.actionId!,
      toolId: node.toolId,
      durableActionClass: input.effectful ? 'send' : 'local_lookup',
      effectClass: input.effectful ? 'external_effect' : 'read_only',
      targetScopeKey: input.targetScopeKey,
      evidenceSubject: input.targetScopeKey,
      criterionIds: [...node.producesCriterionIds],
      requiredEvidenceIds: [...node.requiredEvidence],
      verifierRequirementIds: [...node.verifier.requirementIds],
    },
  ];
  return { frame, graph, node, bindings };
}

function beginAdaptiveRuntimeCognitive(input: {
  turnId: string;
  fixture: ReturnType<typeof adaptiveRuntimeFixture>;
  effectful?: boolean;
}) {
  const cognitive = beginCognitiveKernelRun({
    turnId: input.turnId,
    channel: 'telegram',
    groupFolder: 'main',
    taskFamily: input.effectful ? 'communication' : 'assistant',
    goal: input.fixture.frame.objective,
    requestRoute: input.effectful ? 'message_action' : 'local_status',
    selectedSkillId: input.effectful
      ? 'communication.send'
      : 'assistant.daily_guidance',
    selectedSkillPurpose: input.effectful
      ? 'Prepare one exact approval-gated effect.'
      : 'Inspect one exact read-only target.',
    selectedSkillApprovalNeed: input.effectful ? 'explicit' : 'none',
    selectedSkillSideEffectRisk: input.effectful ? 'high' : 'none',
    selectedSkillEvidenceLevel: 'strong',
    executionMode: 'prepare_only',
  });
  cognitive.taskGraph.adaptiveFrame = input.fixture.frame;
  cognitive.taskGraph.adaptivePlan = input.fixture.graph;
  cognitive.taskGraph.adaptiveBeliefs = [];
  cognitive.taskGraph.adaptiveEvidence = [];
  return cognitive;
}

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

  it('projects new durable work from the authoritative adaptive graph without executing it', () => {
    const turnId = 'runtime-adaptive-authoritative';
    const targetScopeKey = 'runtime-adaptive-read-target';
    const fixture = adaptiveRuntimeFixture({ targetScopeKey });
    const cognitive = beginAdaptiveRuntimeCognitive({ turnId, fixture });

    const runtime = beginAgentRuntimeSpineRun({
      turnId,
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'runtime-adaptive-owner',
      chatId: 'runtime-adaptive-chat',
      targetScopeKey,
      explicitlyDurable: true,
      taskFamily: 'assistant',
      requestRoute: 'local_status',
      goal: 'Inspect the exact bounded target.',
      cognitiveRun: cognitive,
      adaptiveDurable: { bindings: fixture.bindings },
      generatedAt: '2026-07-12T12:50:00.000Z',
      mode: 'assistive',
    });

    const expectedNodeIds = [
      fixture.node.nodeId,
      fixture.graph.verificationNodeId,
    ];
    expect(runtime?.adaptiveDurable).toMatchObject({
      disposition: 'authoritative',
      nextNodeId: fixture.node.nodeId,
    });
    expect(runtime?.durableWork).toMatchObject({
      planId: fixture.graph.graphId,
      status: 'ready',
      runtimeRunId: runtime?.run.runtimeRunId,
      cognitiveRunId: cognitive.run.runId,
    });
    expect(
      runtime?.adaptiveDurable?.compiled?.plan.nodes.map((node) => node.nodeId),
    ).toEqual(expectedNodeIds);
    expect(
      JSON.parse(
        runtime?.adaptiveDurable?.checkpoint?.pendingNodeIdsJson || '[]',
      ),
    ).toEqual(expectedNodeIds);
    expect(runtime?.adaptiveDurable?.checkpoint?.runtimeCheckpointId).toBe(
      runtime?.report.checkpoints[0]?.checkpointId,
    );
    expect(
      listDurableEffectReceipts({
        workId: runtime?.durableWork?.workId || 'missing',
      }),
    ).toEqual([]);
  });

  it('stages effectful adaptive approval for the exact bound node without executing it', () => {
    const turnId = 'runtime-adaptive-exact-approval';
    const targetScopeKey = 'runtime-adaptive-effect-target';
    const fixture = adaptiveRuntimeFixture({
      targetScopeKey,
      effectful: true,
    });
    const cognitive = beginAdaptiveRuntimeCognitive({
      turnId,
      fixture,
      effectful: true,
    });

    const runtime = beginAgentRuntimeSpineRun({
      turnId,
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'runtime-adaptive-owner',
      chatId: 'runtime-adaptive-chat',
      targetScopeKey,
      explicitlyDurable: true,
      taskFamily: 'communication',
      requestRoute: 'message_action',
      goal: 'Apply the exact bounded operation.',
      cognitiveRun: cognitive,
      adaptiveDurable: { bindings: fixture.bindings },
      generatedAt: '2026-07-12T13:00:00.000Z',
      mode: 'assistive',
    });

    expect(runtime?.adaptiveDurable).toMatchObject({
      disposition: 'authoritative',
      nextNodeId: fixture.node.nodeId,
    });
    expect(runtime?.durableWork).toMatchObject({
      planId: fixture.graph.graphId,
      status: 'awaiting_approval',
    });
    const packets = listCognitiveApprovalPackets({
      runId: cognitive.run.runId,
    }).filter(
      (packet) => packet.durableWorkId === runtime?.durableWork?.workId,
    );
    expect(packets).toHaveLength(1);
    expect(packets[0]).toMatchObject({
      actionClass: 'send',
      status: 'staged',
      durableCheckpointId:
        runtime?.adaptiveDurable?.checkpoint?.durableCheckpointId,
    });
    expect(JSON.parse(packets[0]!.decisionJson)).toMatchObject({
      nodeId: fixture.node.nodeId,
      externalActionExecuted: false,
      metadataOnly: true,
    });
    expect(
      listDurableEffectReceipts({
        workId: runtime?.durableWork?.workId || 'missing',
      }),
    ).toEqual([]);
  });

  it('keeps an existing legacy durable plan pinned during adaptive rollout', () => {
    const turnId = 'runtime-adaptive-legacy-pinned';
    const targetScopeKey = 'runtime-adaptive-pinned-target';
    const baseInput = {
      turnId,
      channel: 'telegram',
      groupFolder: 'main',
      actorId: 'runtime-adaptive-owner',
      chatId: 'runtime-adaptive-chat',
      targetScopeKey,
      explicitlyDurable: true,
      taskFamily: 'assistant',
      requestRoute: 'local_status',
      goal: 'Inspect and verify one bounded local mission.',
      mode: 'assistive' as const,
    };
    const legacy = beginAgentRuntimeSpineRun({
      ...baseInput,
      generatedAt: '2026-07-12T13:10:00.000Z',
    });
    const legacyPendingNodeIds = JSON.parse(
      legacy?.durableWork?.checkpointHeadId
        ? getDurableWorkCheckpoint(legacy.durableWork.checkpointHeadId)
            ?.pendingNodeIdsJson || '[]'
        : '[]',
    );
    const fixture = adaptiveRuntimeFixture({ targetScopeKey });
    const cognitive = beginAdaptiveRuntimeCognitive({ turnId, fixture });

    const adaptive = beginAgentRuntimeSpineRun({
      ...baseInput,
      cognitiveRun: cognitive,
      adaptiveDurable: { bindings: fixture.bindings },
      generatedAt: '2026-07-12T13:11:00.000Z',
    });

    expect(legacy?.durableWork?.planId).toBeNull();
    expect(adaptive?.durableWork).toMatchObject({
      workId: legacy?.durableWork?.workId,
      planId: null,
      checkpointHeadId: legacy?.durableWork?.checkpointHeadId,
    });
    expect(adaptive?.adaptiveDurable).toMatchObject({
      disposition: 'legacy_pinned',
      compiled: null,
      nextNodeId: null,
    });
    expect(
      JSON.parse(
        adaptive?.adaptiveDurable?.checkpoint?.pendingNodeIdsJson || '[]',
      ),
    ).toEqual(legacyPendingNodeIds);
    expect(legacyPendingNodeIds).toEqual([
      'tool_step',
      'verification',
      'outcome',
    ]);
    expect(
      listDurableEffectReceipts({
        workId: adaptive?.durableWork?.workId || 'missing',
      }),
    ).toEqual([]);
  });
});
