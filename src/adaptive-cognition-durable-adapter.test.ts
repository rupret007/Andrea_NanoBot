import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adaptiveEvidenceFromVerifiedReceipt,
  compileAdaptiveDurablePlan,
  createAdaptiveDurableWork,
  orchestrateAdaptiveDurableDirective,
  type AdaptiveDurableNodeBinding,
  type AdaptiveVerifiedReceiptObservationMapper,
} from './adaptive-cognition-durable-adapter.js';
import {
  buildAdaptivePlanGraph,
  createAdaptiveProblemFrame,
} from './adaptive-cognition-engine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  approveCognitiveApprovalPacketCAS,
  getDurableWorkUnit,
  listDurableEffectReceipts,
  upsertCognitiveRun,
} from './db.js';
import {
  _setDurableContinuityTestHook,
  consumeResumeGrantAndAcquireLease,
  durableScopeHash,
  issueDurableResumeGrant,
  orchestrateNextDurableNode,
  stageDurableWorkApproval,
  unresolvedDurableEffectReceipts,
  type DurableNodeOrchestrationCallbacks,
} from './durable-work-continuity.js';
import type { DurableEffectReceipt } from './types.js';

const NOW = '2026-07-19T18:00:00.000Z';
const TARGET = 'repository-fixture-adaptive';
const CRITERION_ID = 'criterion:verified-target';
const EXECUTOR_SCOPE = 'executor:adaptive-test';
const binding = {
  ownerId: 'owner-adaptive',
  chatId: 'chat-adaptive',
  groupId: 'main',
  channel: 'unit-test',
  targetScopeKey: TARGET,
};

beforeEach(() => _initTestDatabase());
afterEach(() => {
  _setDurableContinuityTestHook(null);
  _closeDatabase();
});

function fixture() {
  const frame = createAdaptiveProblemFrame({
    frameId: 'frame:durable-adapter',
    createdAt: NOW,
    objective: 'Inspect one bounded target and verify its post-state.',
    taskFamily: 'code',
    channel: 'unit-test',
    successCriteria: [
      {
        criterionId: CRITERION_ID,
        description: 'The exact target has a verified post-state.',
        requiredEvidenceClasses: ['observed'],
        minimumConfidence: 0.8,
      },
    ],
    authority: {
      actorScope: 'scope:adaptive-test',
      maximumActionClass: 'read_only',
    },
    contextRefs: [`target:${CRITERION_ID}:${TARGET}`],
  });
  const graph = buildAdaptivePlanGraph({
    graphId: 'adaptive:graph:durable-adapter',
    createdAt: NOW,
    frame,
    actions: [
      {
        actionId: 'adaptive:action:inspect',
        title: 'Inspect exact target',
        purpose: 'Collect verified metadata from the exact target.',
        toolId: 'repository-inspector',
        actionClass: 'read_only_integration',
        mutationClass: 'none',
        approvalRequired: false,
        requiredEvidence: ['registered_tool_policy', 'bounded_scope'],
        producesCriterionIds: [CRITERION_ID],
        expectedEvidenceClass: 'observed',
        priority: 0.9,
        maxAttempts: 1,
        timeoutMs: 2_000,
      },
    ],
  });
  const actionNode = graph.nodes.find(
    (node) => node.actionId === 'adaptive:action:inspect',
  )!;
  const bindings: AdaptiveDurableNodeBinding[] = [
    {
      graphId: graph.graphId,
      planContractDigest: graph.planContractDigest,
      nodeId: actionNode.nodeId,
      actionId: actionNode.actionId!,
      toolId: actionNode.toolId,
      durableActionClass: 'repository_read',
      effectClass: 'read_only',
      targetScopeKey: TARGET,
      evidenceSubject: TARGET,
      criterionIds: [...actionNode.producesCriterionIds],
      requiredEvidenceIds: [...actionNode.requiredEvidence],
      verifierRequirementIds: [...actionNode.verifier.requirementIds],
    },
  ];
  return { frame, graph, actionNode, bindings };
}

function mutatingFixture() {
  const frame = createAdaptiveProblemFrame({
    frameId: 'frame:durable-mutating-adapter',
    createdAt: NOW,
    objective: 'Apply two separately approved changes to one exact target.',
    taskFamily: 'code',
    channel: 'unit-test',
    successCriteria: [
      {
        criterionId: CRITERION_ID,
        description: 'The exact target has verified write receipts.',
        requiredEvidenceClasses: ['observed'],
        minimumConfidence: 0.8,
      },
    ],
    authority: {
      actorScope: 'scope:adaptive-test',
      maximumActionClass: 'approval_gated_mutation',
    },
    contextRefs: [
      `target:${CRITERION_ID}:${TARGET}`,
      `receipt_required:${CRITERION_ID}`,
    ],
  });
  const graph = buildAdaptivePlanGraph({
    graphId: 'adaptive:graph:durable-mutating-adapter',
    createdAt: NOW,
    frame,
    actions: ['first', 'sibling'].map((suffix, index) => ({
      actionId: `adaptive:action:${suffix}`,
      title: `Apply ${suffix} exact change`,
      purpose: `Apply only the ${suffix} bounded repository change.`,
      toolId: `repository-writer-${suffix}`,
      actionClass: 'mutation' as const,
      mutationClass: 'local_reversible' as const,
      approvalRequired: true,
      requiredEvidence: ['exact_scope', 'effect_receipt'],
      producesCriterionIds: [CRITERION_ID],
      expectedEvidenceClass: 'observed' as const,
      priority: 1 - index * 0.1,
      maxAttempts: 1,
      timeoutMs: 2_000,
    })),
  });
  const actionNodes = graph.nodes.filter((node) => node.kind === 'act');
  const bindings: AdaptiveDurableNodeBinding[] = actionNodes.map((node) => ({
    graphId: graph.graphId,
    planContractDigest: graph.planContractDigest,
    nodeId: node.nodeId,
    actionId: node.actionId!,
    toolId: node.toolId,
    durableActionClass: 'repository_write',
    effectClass: 'repository_write',
    targetScopeKey: TARGET,
    evidenceSubject: TARGET,
    criterionIds: [...node.producesCriterionIds],
    requiredEvidenceIds: [...node.requiredEvidence],
    verifierRequirementIds: [...node.verifier.requirementIds],
  }));
  return { frame, graph, actionNodes, bindings };
}

function persistApprovalRun(runId: string): void {
  upsertCognitiveRun({
    runId,
    createdAt: NOW,
    updatedAt: NOW,
    groupFolder: 'main',
    channel: 'unit-test',
    taskFamily: 'code',
    turnId: 'turn:adaptive-mutating',
    runOrigin: 'synthetic',
    goalSummary: 'Approve one exact adaptive durable node.',
    selectedSkillId: 'adaptive.durable.test',
    status: 'awaiting_approval',
    autonomyLevel: 'plan_draft_only',
    cognitiveMode: 'approval_staged',
    taskGraphJson: '{}',
    evidenceContractJson: '{}',
    providerUsabilityJson: '{}',
    councilRunId: null,
    verificationJson: '{}',
    outcomeScore: 0,
    nextAction: 'Wait for exact-node approval.',
    privacyJson: '{"metadataOnly":true}',
    linkedSkillCardId: null,
  });
}

function acquireLease(
  workId: string,
  actionClass: 'repository_read' | 'verification_test',
  nodeId: string,
  suffix: string,
  issuedAt = '2026-07-19T18:01:00.000Z',
  consumedAt = '2026-07-19T18:02:00.000Z',
) {
  const issued = issueDurableResumeGrant({
    workId,
    binding,
    actionClass,
    nodeId,
    inboundMessageId: `message:${suffix}`,
    now: issuedAt,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding,
    actionClass,
    inboundMessageId: `message:${suffix}`,
    workerId: `worker:${suffix}`,
    processGeneration: 'process:adaptive-test',
    leaseTtlMs: 5 * 60_000,
    now: consumedAt,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error('Test could not acquire the durable lease.');
  }
  return consumed.lease;
}

function callbacks(
  executeNode: DurableNodeOrchestrationCallbacks['executeNode'] = vi.fn(() => ({
    status: 'succeeded' as const,
    postStateFingerprint: 'sha256:adaptive-poststate',
  })),
): Omit<DurableNodeOrchestrationCallbacks, 'loadPlan'> {
  return {
    revalidateNode: () => ({
      dependencyState: 'fresh',
      targetState: 'fresh',
      preStateFingerprint: 'sha256:adaptive-prestate',
      freshSignalIds: ['signal:target-fresh'],
    }),
    preflightScope: () => ({
      authorization: 'scope:adaptive-authorization',
      targetScopeHash: durableScopeHash('target', TARGET),
      preStateFingerprint: 'sha256:adaptive-prestate',
    }),
    executeNode,
    completeScope: () => ({
      postStateFingerprint: 'sha256:adaptive-poststate',
    }),
    verifyNode: () => ({
      status: 'verified',
      verificationFingerprint: 'sha256:adaptive-verified',
      postStateFingerprint: 'sha256:adaptive-poststate',
    }),
  };
}

async function orchestrateMappedVerifiedRead(
  suffix: string,
  mapVerifiedReceiptObservation: AdaptiveVerifiedReceiptObservationMapper,
) {
  const { frame, graph, actionNode, bindings } = fixture();
  const created = createAdaptiveDurableWork({
    originTurnId: `turn:adaptive-mapped-${suffix}`,
    authorizedSurface: 'unit-test',
    binding,
    goalSummary: 'Map an exact verified read receipt into a typed observation.',
    cognitiveRunId: `cognitive:adaptive-mapped-${suffix}`,
    frame,
    graph,
    bindings,
    executorScopeKey: EXECUTOR_SCOPE,
    targetScopeKey: TARGET,
    now: NOW,
  });
  const lease = acquireLease(
    created.work.workId,
    'repository_read',
    actionNode.nodeId,
    `mapped-${suffix}`,
  );
  const result = await orchestrateAdaptiveDurableDirective({
    snapshot: { frame, graph, beliefs: [], evidence: [] },
    bindings,
    planVersion: 1,
    workId: created.work.workId,
    leaseId: lease.leaseId,
    processGeneration: 'process:adaptive-test',
    executorScopeKey: EXECUTOR_SCOPE,
    targetScopeKey: TARGET,
    origin: 'synthetic',
    callbacks: callbacks(),
    mapVerifiedReceiptObservation,
    now: '2026-07-19T18:03:00.000Z',
  });
  return { result, actionNode };
}

describe('adaptive cognition durable adapter', () => {
  it('compiles adaptive node IDs plus a terminal adaptive verifier', () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const compiled = compileAdaptiveDurablePlan({
      frame,
      graph,
      bindings,
      targetScopeKey: TARGET,
      planVersion: 1,
    });

    expect(compiled.plan.planId).toBe(graph.graphId);
    expect(compiled.plan.nodes.map((node) => node.nodeId)).toEqual([
      actionNode.nodeId,
      graph.verificationNodeId,
    ]);
    expect(compiled.pendingNodeIds).toEqual([
      actionNode.nodeId,
      graph.verificationNodeId,
    ]);
    expect(compiled.dependencyIds).toContain(graph.frameContractDigest);
    expect(compiled.dependencyIds).toContain(graph.planContractDigest);
  });

  it('rejects a binding that changes target, effect, or plan identity', () => {
    const { frame, graph, bindings } = fixture();
    expect(() =>
      compileAdaptiveDurablePlan({
        frame,
        graph,
        bindings: [{ ...bindings[0]!, targetScopeKey: 'other-target' }],
        targetScopeKey: TARGET,
        planVersion: 1,
      }),
    ).toThrow(/target scope changed/);
    expect(() =>
      compileAdaptiveDurablePlan({
        frame,
        graph,
        bindings: [
          {
            ...bindings[0]!,
            durableActionClass: 'repository_write',
            effectClass: 'repository_write',
          },
        ],
        targetScopeKey: TARGET,
        planVersion: 1,
      }),
    ).toThrow(/exact approval|write effect/);
    expect(() =>
      compileAdaptiveDurablePlan({
        frame,
        graph,
        bindings: [{ ...bindings[0]!, planContractDigest: 'forged' }],
        targetScopeKey: TARGET,
        planVersion: 1,
      }),
    ).toThrow(/identity changed/);
  });

  it('rejects an expected-node mismatch before revalidation, execution, or receipt creation', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-node-mismatch',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Reject a changed durable node identity before execution.',
      cognitiveRunId: 'cognitive:adaptive-node-mismatch',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const lease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'node-mismatch',
    );
    const executeNode = vi.fn(() => ({ status: 'succeeded' as const }));
    const revalidateNode = vi.fn(() => ({
      dependencyState: 'fresh' as const,
      targetState: 'fresh' as const,
    }));

    const result = await orchestrateNextDurableNode({
      workId: created.work.workId,
      leaseId: lease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      expectedNodeId: graph.verificationNodeId,
      callbacks: {
        ...callbacks(executeNode),
        loadPlan: () => created.compiled.plan,
        revalidateNode,
      },
      now: '2026-07-19T18:03:00.000Z',
    });

    expect(result).toMatchObject({
      status: 'replan_required',
      executed: false,
      receipt: null,
    });
    expect(revalidateNode).not.toHaveBeenCalled();
    expect(executeNode).not.toHaveBeenCalled();
    expect(
      listDurableEffectReceipts({ workId: created.work.workId }),
    ).toHaveLength(0);
  });

  it('does not charge an adaptive node failure when durable plan sync stops before invocation', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-plan-sync',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Preserve the adaptive directive across durable plan sync.',
      cognitiveRunId: 'cognitive:adaptive-plan-sync',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const lease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'plan-sync',
    );
    const executeNode = vi.fn(() => ({ status: 'succeeded' as const }));
    const result = await orchestrateAdaptiveDurableDirective({
      snapshot: { frame, graph, beliefs: [], evidence: [] },
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: lease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: {
        ...callbacks(executeNode),
        revalidateNode: () => ({
          dependencyState: 'changed',
          targetState: 'fresh',
        }),
      },
      now: '2026-07-19T18:03:00.000Z',
    });

    expect(result.durable).toMatchObject({
      status: 'replan_required',
      executed: false,
      receipt: null,
    });
    expect(result.snapshot).toEqual({
      frame: result.directive.result.frame,
      graph: result.directive.result.graph,
      beliefs: result.directive.result.beliefs,
      evidence: result.directive.result.evidence,
    });
    expect(
      result.snapshot.graph.nodes.find(
        (node) => node.nodeId === actionNode.nodeId,
      ),
    ).toMatchObject({ status: 'ready', attemptCount: 0 });
    expect(executeNode).not.toHaveBeenCalled();
    expect(
      listDurableEffectReceipts({ workId: created.work.workId }),
    ).toHaveLength(0);
  });

  it('rejects wrong-node, wrong-target, and wrong-version receipt objects', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-receipt-binding',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Accept only the exact persisted durable receipt.',
      cognitiveRunId: 'cognitive:adaptive-receipt-binding',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const lease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'receipt-binding',
    );
    const result = await orchestrateAdaptiveDurableDirective({
      snapshot: { frame, graph, beliefs: [], evidence: [] },
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: lease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: callbacks(),
      now: '2026-07-19T18:03:00.000Z',
    });
    const receipt = result.durable?.receipt;
    if (!receipt) throw new Error('Fixture did not produce a receipt.');
    const exactEvidence = adaptiveEvidenceFromVerifiedReceipt({
      frame,
      work: result.durable!.work,
      binding: bindings[0]!,
      receipt,
      origin: 'synthetic',
    });
    expect(exactEvidence.provenanceRefs).toEqual(
      expect.arrayContaining([
        'registered_tool_policy',
        'bounded_scope',
        CRITERION_ID,
      ]),
    );

    const forgedReceipts: DurableEffectReceipt[] = [
      { ...receipt, nodeId: graph.verificationNodeId },
      {
        ...receipt,
        targetScopeHash: durableScopeHash('target', 'other-target'),
      },
      { ...receipt, planVersion: receipt.planVersion + 1 },
      { ...receipt, grantId: 'grant:forged-provenance' },
    ];
    for (const forged of forgedReceipts) {
      expect(() =>
        adaptiveEvidenceFromVerifiedReceipt({
          frame,
          work: result.durable!.work,
          binding: bindings[0]!,
          receipt: forged,
          origin: 'synthetic',
        }),
      ).toThrow(/not exact verified adaptive completion evidence/i);
    }
  });

  it('maps an exact verified read into degraded receipt evidence with zero criterion support', async () => {
    const mapper = vi.fn<AdaptiveVerifiedReceiptObservationMapper>(
      ({ receipt, defaultEvidence }) => {
        expect(defaultEvidence.source).toBe(receipt.receiptId);
        expect(defaultEvidence.provenanceRefs).toEqual(
          expect.arrayContaining([
            `effect_receipt:${receipt.receiptId}`,
            `verification_receipt:${receipt.verificationFingerprint}`,
          ]),
        );
        expect(defaultEvidence.supportsCriterionIds).toEqual([CRITERION_ID]);
        return {
          status: 'degraded',
          summary:
            'The exact read completed, but its verified result did not satisfy the criterion.',
          evidence: [{ ...defaultEvidence, supportsCriterionIds: [] }],
          failureClass: 'verified_negative_read',
        };
      },
    );
    const { result, actionNode } = await orchestrateMappedVerifiedRead(
      'degraded',
      mapper,
    );

    expect(mapper).toHaveBeenCalledTimes(1);
    expect(result.durable).toMatchObject({
      status: 'node_completed',
      nodeId: actionNode.nodeId,
      executed: true,
    });
    expect(
      result.snapshot.graph.nodes.find(
        (node) => node.nodeId === actionNode.nodeId,
      ),
    ).toMatchObject({
      status: 'degraded',
      lastFailureClass: 'verified_negative_read',
    });
    expect(result.snapshot.evidence).toHaveLength(1);
    expect(result.snapshot.evidence[0]).toMatchObject({
      source: result.durable?.receipt?.receiptId,
      supportsCriterionIds: [],
      verification: 'verified',
    });
    expect(result.snapshot.graph.status).not.toBe('satisfied');
  });

  it('maps an exact verified read to terminal failure without inventing criterion evidence', async () => {
    const { result, actionNode } = await orchestrateMappedVerifiedRead(
      'terminal-failure',
      ({ defaultEvidence }) => ({
        status: 'terminal_failure',
        summary:
          'The exact read was verified, but its result is a terminal negative outcome.',
        evidence: [{ ...defaultEvidence, supportsCriterionIds: [] }],
        failureClass: 'verified_negative_read',
      }),
    );

    expect(result.durable).toMatchObject({
      status: 'node_completed',
      executed: true,
    });
    expect(
      result.snapshot.graph.nodes.find(
        (node) => node.nodeId === actionNode.nodeId,
      ),
    ).toMatchObject({
      status: 'blocked',
      lastFailureClass: 'verified_negative_read',
    });
    expect(result.snapshot.graph.status).toBe('degraded');
    expect(result.snapshot.evidence[0]?.supportsCriterionIds).toEqual([]);
  });

  it('rejects retryable or approval-resumable mappings after durable completion', async () => {
    for (const status of ['retryable_failure', 'approval_required'] as const) {
      const replayUnsafeMapper = (({
        defaultEvidence,
      }: Parameters<AdaptiveVerifiedReceiptObservationMapper>[0]) => ({
        status,
        summary:
          'A completed durable node cannot be reopened by a mapped observation.',
        evidence: [{ ...defaultEvidence, supportsCriterionIds: [] }],
        failureClass: `unsafe_${status}`,
      })) as unknown as AdaptiveVerifiedReceiptObservationMapper;
      await expect(
        orchestrateMappedVerifiedRead(`unsafe-${status}`, replayUnsafeMapper),
      ).rejects.toThrow(/invalid or replay-unsafe typed observation/i);
    }
  });

  it('rejects mapped observations that forge receipt evidence or retain negative criterion support', async () => {
    await expect(
      orchestrateMappedVerifiedRead(
        'forged-evidence',
        ({ defaultEvidence }) => ({
          status: 'degraded',
          summary: 'A forged evidence source must be rejected.',
          evidence: [
            {
              ...defaultEvidence,
              source: 'receipt:forged',
              supportsCriterionIds: [],
            },
          ],
          failureClass: 'verified_negative_read',
        }),
      ),
    ).rejects.toThrow(/exact receipt-backed default evidence/i);

    await expect(
      orchestrateMappedVerifiedRead(
        'negative-criterion-support',
        ({ defaultEvidence }) => ({
          status: 'terminal_failure',
          summary: 'Negative observations cannot authorize completion.',
          evidence: [{ ...defaultEvidence }],
          failureClass: 'verified_negative_read',
        }),
      ),
    ).rejects.toThrow(
      /only adaptive success may retain exact criterion support/i,
    );
  });

  it('does not let approval for one node authorize a same-class sibling', () => {
    const cognitiveRunId = 'cognitive:adaptive-sibling-approval';
    persistApprovalRun(cognitiveRunId);
    const { frame, graph, actionNodes, bindings } = mutatingFixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-sibling-approval',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Keep same-class sibling approvals distinct.',
      cognitiveRunId,
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const approvedNode = actionNodes[0]!;
    const siblingNode = actionNodes[1]!;
    const staged = stageDurableWorkApproval({
      workId: created.work.workId,
      expectedWorkVersion: created.work.version,
      cognitiveRunId,
      actionClass: 'repository_write',
      nodeId: approvedNode.nodeId,
      summary: 'Approve only the first exact adaptive repository node.',
      checkpointId: created.checkpoint.durableCheckpointId,
      now: NOW,
    });
    const approval = approveCognitiveApprovalPacketCAS({
      approvalPacketId: staged.packet.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: staged.packet.summary,
      expectedApprovalVersion: staged.packet.approvalVersion || 1,
      expectedScopeDigest: staged.packet.scopeDigest || null,
      now: '2026-07-19T18:00:10.000Z',
      approvalChannel: 'unit-test',
    });
    expect(approval).toEqual({ status: 'approved', approvalVersion: 2 });
    const current = getDurableWorkUnit(created.work.workId)!;

    expect(() =>
      issueDurableResumeGrant({
        workId: current.workId,
        binding,
        actionClass: 'repository_write',
        nodeId: siblingNode.nodeId,
        approvalPacketId: staged.packet.approvalPacketId,
        approvalVersion: approval.approvalVersion,
        now: '2026-07-19T18:00:20.000Z',
      }),
    ).toThrow(/exact plan node/i);
    expect(() =>
      issueDurableResumeGrant({
        workId: current.workId,
        binding,
        actionClass: 'repository_write',
        nodeId: approvedNode.nodeId,
        approvalPacketId: staged.packet.approvalPacketId,
        approvalVersion: approval.approvalVersion,
        now: '2026-07-19T18:00:20.000Z',
      }),
    ).not.toThrow();
  });

  it('executes one adaptive node, accepts only its verified receipt, then durably verifies completion', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-durable',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Inspect one bounded adaptive target and verify it.',
      cognitiveRunId: 'cognitive:adaptive-durable',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    expect(JSON.parse(created.checkpoint.pendingNodeIdsJson)).toEqual([
      actionNode.nodeId,
      graph.verificationNodeId,
    ]);
    const executeNode = vi.fn(() => ({
      status: 'succeeded' as const,
      postStateFingerprint: 'sha256:adaptive-poststate',
    }));
    const actionLease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'action',
    );
    const first = await orchestrateAdaptiveDurableDirective({
      snapshot: { frame, graph, beliefs: [], evidence: [] },
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: actionLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: callbacks(executeNode),
      now: '2026-07-19T18:03:00.000Z',
    });
    expect(first.durable).toMatchObject({
      status: 'node_completed',
      nodeId: actionNode.nodeId,
      executed: true,
    });
    expect(first.snapshot.evidence).toHaveLength(1);
    expect(first.snapshot.evidence[0]).toMatchObject({
      origin: 'synthetic',
      subject: TARGET,
      supportsCriterionIds: [CRITERION_ID],
      verification: 'verified',
    });
    expect(first.snapshot.evidence[0]?.provenanceRefs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^effect_receipt:/),
        expect.stringMatching(/^verification_receipt:/),
        'registered_tool_policy',
        'bounded_scope',
        CRITERION_ID,
      ]),
    );

    const verifierLease = acquireLease(
      first.durable!.work.workId,
      'verification_test',
      graph.verificationNodeId,
      'verifier',
      '2026-07-19T18:03:10.000Z',
      '2026-07-19T18:03:20.000Z',
    );
    const terminal = await orchestrateAdaptiveDurableDirective({
      snapshot: first.snapshot,
      bindings,
      planVersion: 1,
      workId: first.durable!.work.workId,
      leaseId: verifierLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: callbacks(executeNode),
      now: '2026-07-19T18:04:00.000Z',
    });

    expect(terminal.directive.result).toMatchObject({
      status: 'satisfied',
      verification: { completionAuthorized: true },
    });
    expect(terminal.durable).toMatchObject({
      status: 'work_completed',
      nodeId: graph.verificationNodeId,
      executed: true,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(terminal.durable?.work.status).toBe('completed');
    expect(terminal.durable?.receipt?.targetScopeHash).toBe(
      durableScopeHash('target', TARGET),
    );
  });

  it('verifies an uncertain durable effect after restart without replaying it', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-recovery',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary: 'Recover one uncertain adaptive effect without replay.',
      cognitiveRunId: 'cognitive:adaptive-recovery',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const executeNode = vi.fn(() => ({ status: 'unknown' as const }));
    const verifyNode = vi.fn(({ recovery }: { recovery: boolean }) =>
      recovery
        ? {
            status: 'verified' as const,
            verificationFingerprint: 'sha256:recovery-verified',
            postStateFingerprint: 'sha256:recovery-poststate',
          }
        : { status: 'unknown' as const },
    );
    const uncertainCallbacks = {
      ...callbacks(executeNode),
      verifyNode,
    };
    const firstLease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'uncertain',
    );
    const uncertain = await orchestrateAdaptiveDurableDirective({
      snapshot: { frame, graph, beliefs: [], evidence: [] },
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: firstLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: uncertainCallbacks,
      now: '2026-07-19T18:03:00.000Z',
    });
    expect(uncertain.durable).toMatchObject({
      status: 'verification_required',
      executed: true,
      nodeId: actionNode.nodeId,
    });
    expect(
      uncertain.snapshot.graph.nodes.find(
        (node) => node.nodeId === actionNode.nodeId,
      )?.status,
    ).toBe('blocked');

    const recoveryLease = acquireLease(
      uncertain.durable!.work.workId,
      'repository_read',
      actionNode.nodeId,
      'recovery',
      '2026-07-19T18:04:00.000Z',
      '2026-07-19T18:05:00.000Z',
    );
    const recovered = await orchestrateAdaptiveDurableDirective({
      snapshot: uncertain.snapshot,
      bindings,
      planVersion: 1,
      workId: uncertain.durable!.work.workId,
      leaseId: recoveryLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: uncertainCallbacks,
      now: '2026-07-19T18:06:00.000Z',
    });

    expect(recovered.durable).toMatchObject({
      status: 'node_completed',
      nodeId: actionNode.nodeId,
      executed: false,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(verifyNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ recovery: true }),
    );
    expect(
      recovered.snapshot.graph.nodes.find(
        (node) => node.nodeId === actionNode.nodeId,
      )?.status,
    ).toBe('succeeded');
    expect(recovered.snapshot.evidence).toHaveLength(1);
    expect(recovered.snapshot.graph.status).toBe('satisfied');
    expect(
      unresolvedDurableEffectReceipts(
        listDurableEffectReceipts({ workId: created.work.workId }),
      ),
    ).toHaveLength(0);

    const verifierLease = acquireLease(
      created.work.workId,
      'verification_test',
      graph.verificationNodeId,
      'post-uncertain-verifier',
      '2026-07-19T18:07:00.000Z',
      '2026-07-19T18:08:00.000Z',
    );
    const terminal = await orchestrateAdaptiveDurableDirective({
      snapshot: recovered.snapshot,
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: verifierLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: uncertainCallbacks,
      now: '2026-07-19T18:09:00.000Z',
    });
    expect(terminal.durable).toMatchObject({
      status: 'work_completed',
      nodeId: graph.verificationNodeId,
      executed: true,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after the effect without replay and then completes the next node', async () => {
    const { frame, graph, actionNode, bindings } = fixture();
    const created = createAdaptiveDurableWork({
      originTurnId: 'turn:adaptive-crash-recovery',
      authorizedSurface: 'unit-test',
      binding,
      goalSummary:
        'Recover a completed effect after process loss without replay.',
      cognitiveRunId: 'cognitive:adaptive-crash-recovery',
      frame,
      graph,
      bindings,
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      now: NOW,
    });
    const restartSnapshot = structuredClone({
      frame,
      graph,
      beliefs: [],
      evidence: [],
    });
    const executeNode = vi.fn(() => ({
      status: 'succeeded' as const,
      postStateFingerprint: 'sha256:crash-poststate',
    }));
    const verifyNode = vi.fn(({ recovery }: { recovery: boolean }) =>
      recovery
        ? {
            status: 'verified' as const,
            verificationFingerprint: 'sha256:crash-recovery-verified',
            postStateFingerprint: 'sha256:crash-poststate',
          }
        : {
            status: 'verified' as const,
            verificationFingerprint: 'sha256:initial-verified',
            postStateFingerprint: 'sha256:crash-poststate',
          },
    );
    const crashLease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'crash-window',
    );
    let crashInjected = false;
    _setDurableContinuityTestHook((event) => {
      if (
        !crashInjected &&
        event.workId === created.work.workId &&
        event.boundary === 'after_effect_before_receipt'
      ) {
        crashInjected = true;
        throw new Error('synthetic process loss after effect');
      }
    });

    await expect(
      orchestrateAdaptiveDurableDirective({
        snapshot: structuredClone(restartSnapshot),
        bindings,
        planVersion: 1,
        workId: created.work.workId,
        leaseId: crashLease.leaseId,
        processGeneration: 'process:adaptive-test',
        executorScopeKey: EXECUTOR_SCOPE,
        targetScopeKey: TARGET,
        origin: 'synthetic',
        callbacks: { ...callbacks(executeNode), verifyNode },
        now: '2026-07-19T18:03:00.000Z',
      }),
    ).rejects.toThrow('synthetic process loss after effect');
    _setDurableContinuityTestHook(null);

    expect(crashInjected).toBe(true);
    expect(executeNode).toHaveBeenCalledTimes(1);
    const receiptsAfterCrash = listDurableEffectReceipts({
      workId: created.work.workId,
    });
    expect(receiptsAfterCrash).toHaveLength(1);
    expect(receiptsAfterCrash[0]).toMatchObject({
      nodeId: actionNode.nodeId,
      status: 'started',
    });
    expect(getDurableWorkUnit(created.work.workId)?.status).toBe('verifying');

    const recoveryLease = acquireLease(
      created.work.workId,
      'repository_read',
      actionNode.nodeId,
      'crash-recovery',
      '2026-07-19T18:04:00.000Z',
      '2026-07-19T18:05:00.000Z',
    );
    const recovered = await orchestrateAdaptiveDurableDirective({
      snapshot: restartSnapshot,
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: recoveryLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: { ...callbacks(executeNode), verifyNode },
      now: '2026-07-19T18:06:00.000Z',
    });

    expect(recovered.durable).toMatchObject({
      status: 'node_completed',
      nodeId: actionNode.nodeId,
      executed: false,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(verifyNode).toHaveBeenLastCalledWith(
      expect.objectContaining({ recovery: true }),
    );
    const recoveredReceipts = listDurableEffectReceipts({
      workId: created.work.workId,
    });
    expect(recoveredReceipts.map((receipt) => receipt.status).sort()).toEqual([
      'started',
      'succeeded',
    ]);
    expect(
      JSON.parse(
        recoveredReceipts.find((receipt) => receipt.status === 'succeeded')!
          .metadataJson,
      ),
    ).toMatchObject({
      recoveryOfReceiptId: receiptsAfterCrash[0]!.receiptId,
      recoveryOfCheckpointId: receiptsAfterCrash[0]!.checkpointId,
    });
    expect(unresolvedDurableEffectReceipts(recoveredReceipts)).toHaveLength(0);

    const verifierLease = acquireLease(
      created.work.workId,
      'verification_test',
      graph.verificationNodeId,
      'after-crash-verifier',
      '2026-07-19T18:06:10.000Z',
      '2026-07-19T18:06:20.000Z',
    );
    const terminal = await orchestrateAdaptiveDurableDirective({
      snapshot: recovered.snapshot,
      bindings,
      planVersion: 1,
      workId: created.work.workId,
      leaseId: verifierLease.leaseId,
      processGeneration: 'process:adaptive-test',
      executorScopeKey: EXECUTOR_SCOPE,
      targetScopeKey: TARGET,
      origin: 'synthetic',
      callbacks: { ...callbacks(executeNode), verifyNode },
      now: '2026-07-19T18:07:00.000Z',
    });

    expect(terminal.durable).toMatchObject({
      status: 'work_completed',
      nodeId: graph.verificationNodeId,
      executed: true,
    });
    expect(executeNode).toHaveBeenCalledTimes(1);
    expect(terminal.durable?.work.status).toBe('completed');
  });
});
