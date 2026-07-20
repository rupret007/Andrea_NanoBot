import { describe, expect, it, vi } from 'vitest';

import {
  ADAPTIVE_COGNITION_PRIVACY,
  advanceAdaptiveCognition,
  adaptiveEvidence,
  applyAdaptiveNodeObservation,
  buildAdaptivePlanGraph,
  computeAdaptiveCalibration,
  createAdaptiveProblemFrame,
  evaluateIsolatedAdaptiveImprovement,
  proposeIsolatedAdaptiveImprovement,
  reconcileAdaptiveBeliefs,
  reopenAdaptivePlanForEvidence,
  resumeAdaptivePlanForUpdatedFrame,
  runAdaptiveCognition,
  type AdaptiveActionCandidate,
  type AdaptiveEvidence,
  type AdaptiveImprovementCandidate,
  type AdaptiveNodeExecutor,
  type AdaptiveProblemFrame,
} from './adaptive-cognition-engine.js';

const CREATED_AT = '2026-07-19T12:00:00.000Z';
const CRITERION_ID = 'criterion:requested-outcome';
const TARGET = 'target-record-42';
const ACTOR_SCOPE = 'scope:current-user';

function deterministicClock(start = CREATED_AT): () => string {
  let tick = 0;
  const startMs = Date.parse(start);
  return () => new Date(startMs + tick++).toISOString();
}

function frameForTest(
  overrides: {
    frameId?: string;
    maximumActionClass?: AdaptiveProblemFrame['authority']['maximumActionClass'];
    approvedActionIds?: string[];
    contextRefs?: string[];
  } = {},
): AdaptiveProblemFrame {
  return createAdaptiveProblemFrame({
    frameId: overrides.frameId || 'frame:adaptive-engine-test',
    createdAt: CREATED_AT,
    objective: 'Produce the requested outcome and prove the exact result.',
    taskFamily: 'adaptive-engine-contract',
    channel: 'unit-test',
    route: 'local:test-route',
    successCriteria: [
      {
        criterionId: CRITERION_ID,
        description: 'The exact target has the requested postcondition.',
        requiredEvidenceClasses: ['observed', 'user_attested'],
        minimumConfidence: 0.8,
        required: true,
      },
    ],
    constraints: ['Do not exceed current authority.'],
    assumptions: ['The target identifier is canonical.'],
    unknowns: [
      {
        unknownId: 'unknown:provider-latency',
        description: 'Provider latency may vary.',
        impact: 'informational',
        resolvableBy: ['observed:provider-health'],
      },
    ],
    authority: {
      actorScope: ACTOR_SCOPE,
      maximumActionClass: overrides.maximumActionClass || 'read_only',
      approvedActionIds: overrides.approvedActionIds || [],
    },
    risk: {
      level: 'medium',
      flags: ['external-state'],
    },
    contextRefs: overrides.contextRefs || [
      `target:${TARGET}`,
      `receipt_required:${CRITERION_ID}`,
    ],
  });
}

function actionForTest(
  actionId: string,
  overrides: Partial<AdaptiveActionCandidate> = {},
): AdaptiveActionCandidate {
  return {
    actionId,
    title: `Execute ${actionId}`,
    purpose: `Gather typed evidence for ${actionId}.`,
    toolId: `tool:${actionId}`,
    actionClass: 'read_only_integration',
    mutationClass: 'none',
    approvalRequired: false,
    requiredEvidence: ['fresh-observation'],
    producesCriterionIds: [CRITERION_ID],
    expectedEvidenceClass: 'observed',
    priority: 0.8,
    maxAttempts: 1,
    timeoutMs: 2_000,
    ...overrides,
  };
}

type EvidenceInput = Parameters<typeof adaptiveEvidence>[0];

function evidenceForTest(
  overrides: Partial<EvidenceInput> = {},
): AdaptiveEvidence {
  return adaptiveEvidence({
    evidenceId: overrides.evidenceId || 'evidence:valid-receipt',
    createdAt: overrides.createdAt || CREATED_AT,
    evidenceClass: overrides.evidenceClass || 'observed',
    origin: overrides.origin || 'synthetic',
    source: overrides.source || 'test-executor',
    claim: overrides.claim || 'The requested postcondition was observed.',
    subject: overrides.subject ?? TARGET,
    predicate: overrides.predicate ?? 'postcondition',
    value: overrides.value ?? 'satisfied',
    confidence: overrides.confidence ?? 0.95,
    freshness: overrides.freshness || 'fresh',
    scope: overrides.scope ?? ACTOR_SCOPE,
    verification: overrides.verification || 'verified',
    supportsCriterionIds: overrides.supportsCriterionIds || [CRITERION_ID],
    provenanceRefs: overrides.provenanceRefs || [
      'fresh-observation',
      'receipt:test-effect-42',
    ],
  });
}

function graphForTest(
  frame: AdaptiveProblemFrame,
  actions: AdaptiveActionCandidate[],
) {
  return buildAdaptivePlanGraph({
    graphId: `graph:${frame.frameId}`,
    createdAt: CREATED_AT,
    frame,
    actions,
    maxNodeExecutions: 20,
    maxRuntimeMs: 5_000,
  });
}

function successfulObservation(evidence: AdaptiveEvidence) {
  return {
    status: 'success' as const,
    summary: 'The action returned typed evidence.',
    evidence: [evidence],
  };
}

describe('adaptive cognition engine contracts', () => {
  it('materializes an explicit problem frame and bounded plan graph contract', () => {
    const frame = frameForTest();
    const action = actionForTest('action:inspect-target', {
      maxAttempts: 2,
      timeoutMs: 3_500,
    });
    const graph = graphForTest(frame, [action]);
    const actionNode = graph.nodes.find(
      (node) => node.actionId === action.actionId,
    );

    expect(frame).toMatchObject({
      frameId: 'frame:adaptive-engine-test',
      objective: 'Produce the requested outcome and prove the exact result.',
      taskFamily: 'adaptive-engine-contract',
      channel: 'unit-test',
      route: 'local:test-route',
      ambiguity: 'resolvable',
      constraints: ['Do not exceed current authority.'],
      assumptions: ['The target identifier is canonical.'],
      authority: {
        actorScope: ACTOR_SCOPE,
        maximumActionClass: 'read_only',
        approvedActionIds: [],
        mutationApprovalRequired: true,
        inheritedAuthorityForbidden: true,
      },
      risk: { level: 'medium', flags: ['external-state'] },
      contextRefs: [`target:${TARGET}`, `receipt_required:${CRITERION_ID}`],
      privacy: ADAPTIVE_COGNITION_PRIVACY,
    });
    expect(frame.successCriteria).toEqual([
      {
        criterionId: CRITERION_ID,
        description: 'The exact target has the requested postcondition.',
        requiredEvidenceClasses: ['observed', 'user_attested'],
        minimumConfidence: 0.8,
        required: true,
      },
    ]);
    expect(frame.unknowns).toEqual([
      {
        unknownId: 'unknown:provider-latency',
        description: 'Provider latency may vary.',
        impact: 'informational',
        resolvableBy: ['observed:provider-health'],
      },
    ]);

    expect(graph.frameId).toBe(frame.frameId);
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'frame',
      'hypothesis',
      'act',
      'verify',
      'finish',
    ]);
    expect(actionNode).toMatchObject({
      kind: 'act',
      toolId: action.toolId,
      actionId: action.actionId,
      actionClass: 'read_only_integration',
      mutationClass: 'none',
      approvalRequired: false,
      maxAttempts: 2,
      timeoutMs: 3_500,
      requiredEvidence: ['fresh-observation'],
      producesCriterionIds: [CRITERION_ID],
      expectedEvidenceClass: 'observed',
      attemptCount: 0,
      status: 'pending',
    });
    expect(actionNode?.stopCondition).toContain('fresh typed evidence');
    expect(graph.verificationNodeId).toBe(
      graph.nodes.find((node) => node.kind === 'verify')?.nodeId,
    );
    expect(graph.completionNodeId).toBe(
      graph.nodes.find((node) => node.kind === 'finish')?.nodeId,
    );
    expect(graph.maxNodeExecutions).toBe(20);
    expect(graph.maxRuntimeMs).toBe(5_000);
    expect(graph.revision).toBe(1);
    expect(graph.revisions).toHaveLength(1);
    expect(graph.revisions[0]).toMatchObject({
      revision: 1,
      kind: 'initial',
    });
    expect(graph.revisions[0]?.changedNodeIds).toEqual(
      graph.nodes.map((node) => node.nodeId),
    );
    for (const node of graph.nodes) {
      expect(node.stopCondition.length).toBeGreaterThan(0);
      expect(node.maxAttempts).toBeGreaterThanOrEqual(1);
      expect(node.timeoutMs).toBeGreaterThanOrEqual(100);
    }
  });

  it('emits one exact external-node directive and applies one typed observation', () => {
    const frame = frameForTest({ frameId: 'frame:one-step-reducer' });
    const actionId = 'action:one-step';
    const graph = graphForTest(frame, [actionForTest(actionId)]);

    const directive = advanceAdaptiveCognition({
      frame,
      graph,
      now: deterministicClock(),
    });

    expect(directive.kind).toBe('execute_node');
    expect(directive.node).toMatchObject({ actionId, status: 'ready' });
    const observed = applyAdaptiveNodeObservation({
      frame,
      graph: directive.result.graph,
      beliefs: directive.result.beliefs,
      evidence: directive.result.evidence,
      nodeId: directive.node!.nodeId,
      observation: successfulObservation(
        evidenceForTest({ evidenceId: 'evidence:one-step' }),
      ),
      now: deterministicClock('2026-07-19T12:00:01.000Z'),
    });

    expect(
      observed.graph.nodes.find((node) => node.actionId === actionId)?.status,
    ).toBe('succeeded');
    expect(observed.status).toBe('active');
    const terminal = advanceAdaptiveCognition({
      frame,
      graph: observed.graph,
      beliefs: observed.beliefs,
      evidence: observed.evidence,
      now: deterministicClock('2026-07-19T12:00:02.000Z'),
    });
    expect(terminal.kind).toBe('terminal');
    expect(terminal.result.status).toBe('satisfied');
    expect(terminal.result.verification.completionAuthorized).toBe(true);
  });

  it('rejects an observation for any node other than the exact directive', () => {
    const frame = frameForTest({ frameId: 'frame:wrong-directive-node' });
    const graph = graphForTest(frame, [actionForTest('action:exact-node')]);

    expect(() =>
      applyAdaptiveNodeObservation({
        frame,
        graph,
        nodeId: 'adaptive:node:forged',
        observation: successfulObservation(evidenceForTest()),
        now: deterministicClock(),
      }),
    ).toThrow(/exact next-node directive/);
  });

  it('selects and executes exactly one node at a time in deterministic priority order', () => {
    const frame = frameForTest({ frameId: 'frame:single-node-ordering' });
    const low = actionForTest('action:low-priority', { priority: 0.2 });
    const high = actionForTest('action:high-priority', { priority: 0.95 });
    const graph = graphForTest(frame, [low, high]);
    const actionCalls: string[] = [];
    const runningNodeCounts: number[] = [];
    const executorImplementation: AdaptiveNodeExecutor = (node, context) => {
      actionCalls.push(node.actionId || 'missing-action');
      runningNodeCounts.push(
        context.graph.nodes.filter(
          (candidate) => candidate.status === 'running',
        ).length,
      );
      return successfulObservation(
        evidenceForTest({
          evidenceId: `evidence:${node.actionId}`,
          source: node.toolId || 'test-executor',
        }),
      );
    };
    const executor = vi.fn(executorImplementation);

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });
    const nodeById = new Map(
      result.graph.nodes.map((node) => [node.nodeId, node]),
    );
    const executionOrder = result.trace
      .filter((event) => event.eventKind === 'execute' && event.nodeId)
      .map((event) => {
        const node = nodeById.get(event.nodeId as string);
        return node?.actionId || node?.kind;
      });

    expect(result.status).toBe('satisfied');
    expect(actionCalls).toEqual([
      'action:high-priority',
      'action:low-priority',
    ]);
    expect(runningNodeCounts).toEqual([1, 1]);
    expect(executionOrder).toEqual([
      'frame',
      'hypothesis',
      'action:high-priority',
      'action:low-priority',
      'verify',
      'finish',
    ]);
    expect(result.nodeExecutions).toBe(6);
  });

  it.each(['inferred', 'simulated'] as const)(
    'does not treat %s evidence as completion proof',
    (evidenceClass) => {
      const frame = frameForTest({ frameId: `frame:${evidenceClass}` });
      const graph = graphForTest(frame, [actionForTest('action:reason-only')]);
      const evidence = evidenceForTest({
        evidenceId: `evidence:${evidenceClass}`,
        evidenceClass,
      });

      const result = runAdaptiveCognition({
        frame,
        graph,
        executor: () => successfulObservation(evidence),
        now: deterministicClock(),
      });

      expect(result.status).not.toBe('satisfied');
      expect(result.verification.completionAuthorized).toBe(false);
      expect(result.verification.unsupportedCriterionIds).toEqual([
        CRITERION_ID,
      ]);
      expect(result.verification.criteria[0]?.rejectedEvidenceIds).toContain(
        evidence.evidenceId,
      );
      expect(result.falseCompletionPrevented).toBe(true);
      expect(
        result.graph.nodes.find(
          (node) => node.nodeId === result.graph.completionNodeId,
        )?.status,
      ).not.toBe('succeeded');
    },
  );

  it.each([
    {
      label: 'wrong target',
      evidence: evidenceForTest({
        evidenceId: 'evidence:wrong-target',
        subject: 'target-record-99',
      }),
      authorized: false,
    },
    {
      label: 'wrong authority scope',
      evidence: evidenceForTest({
        evidenceId: 'evidence:wrong-scope',
        scope: 'scope:different-user',
      }),
      authorized: false,
    },
    {
      label: 'missing effect receipt',
      evidence: evidenceForTest({
        evidenceId: 'evidence:no-receipt',
        provenanceRefs: ['tool-call:without-receipt'],
      }),
      authorized: false,
    },
    {
      label: 'exact target, scope, and receipt',
      evidence: evidenceForTest({
        evidenceId: 'evidence:exact-binding',
        provenanceRefs: ['fresh-observation', 'effect_receipt:exact-target-42'],
      }),
      authorized: true,
    },
  ])('binds completion to the $label', ({ evidence, authorized }) => {
    const frame = frameForTest({ frameId: `frame:${evidence.evidenceId}` });
    const graph = graphForTest(frame, [actionForTest('action:exact-binding')]);

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor: () => successfulObservation(evidence),
      now: deterministicClock(),
    });

    expect(result.verification.completionAuthorized).toBe(authorized);
    expect(result.status === 'satisfied').toBe(authorized);
    if (!authorized) {
      expect(result.verification.criteria[0]?.rejectedEvidenceIds).toContain(
        evidence.evidenceId,
      );
      expect(result.falseCompletionPrevented).toBe(true);
    }
  });

  it('blocks an unapproved mutation before invoking its executor', () => {
    const actionId = 'action:mutate-external-record';
    const frame = frameForTest({
      frameId: 'frame:approval-boundary',
      maximumActionClass: 'approval_gated_mutation',
      approvedActionIds: [],
    });
    const graph = graphForTest(frame, [
      actionForTest(actionId, {
        actionClass: 'mutation',
        mutationClass: 'external_reversible',
        approvalRequired: true,
      }),
    ]);
    const executor = vi.fn(() =>
      successfulObservation(evidenceForTest({ evidenceId: 'evidence:never' })),
    );

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });
    const actionNode = result.graph.nodes.find(
      (node) => node.actionId === actionId,
    );

    expect(result.status).toBe('awaiting_approval');
    expect(executor).not.toHaveBeenCalled();
    expect(actionNode).toMatchObject({
      status: 'awaiting_approval',
      attemptCount: 0,
    });
    expect(result.unauthorizedMutationAttempts).toBe(0);
    expect(result.graph.revisions.at(-1)?.kind).toBe('authority_stop');
  });

  it('bounds retries and activates a predeclared alternative replan', () => {
    const primaryId = 'action:primary-provider';
    const fallbackId = 'action:fallback-provider';
    const frame = frameForTest({ frameId: 'frame:bounded-recovery' });
    const graph = graphForTest(frame, [
      actionForTest(primaryId, { maxAttempts: 2, priority: 0.9 }),
      actionForTest(fallbackId, {
        alternativeForActionId: primaryId,
        recoveryForFailureClasses: ['provider_unavailable'],
        maxAttempts: 1,
        priority: 0.8,
      }),
    ]);
    const calls: string[] = [];
    const executorImplementation: AdaptiveNodeExecutor = (node) => {
      calls.push(node.actionId || 'missing-action');
      if (node.actionId === primaryId) {
        return {
          status: 'retryable_failure',
          summary: 'The primary provider is temporarily unavailable.',
          evidence: [],
          failureClass: 'provider_unavailable',
          nextAction: 'Retry once, then use the declared fallback.',
        };
      }
      return successfulObservation(
        evidenceForTest({ evidenceId: 'evidence:fallback-receipt' }),
      );
    };
    const executor = vi.fn(executorImplementation);

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });
    const primary = result.graph.nodes.find(
      (node) => node.actionId === primaryId,
    );
    const fallback = result.graph.nodes.find(
      (node) => node.actionId === fallbackId,
    );

    expect(result.status).toBe('satisfied');
    expect(calls).toEqual([primaryId, primaryId, fallbackId]);
    expect(result.retries).toBe(1);
    expect(result.replans).toBe(1);
    expect(primary).toMatchObject({
      status: 'superseded',
      attemptCount: 2,
      lastFailureClass: 'provider_unavailable',
    });
    expect(fallback).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(result.graph.revisions.map((revision) => revision.kind)).toEqual([
      'initial',
      'retry',
      'replan',
      'completion',
    ]);
    expect(
      result.graph.nodes.find(
        (node) => node.nodeId === result.graph.verificationNodeId,
      )?.dependencyIds,
    ).toContain(fallback?.nodeId);
  });

  it('blocks completion when fresh observations contradict one another', () => {
    const frame = frameForTest({ frameId: 'frame:contradiction' });
    const graph = graphForTest(frame, [actionForTest('action:observe-state')]);
    const first = evidenceForTest({
      evidenceId: 'evidence:state-satisfied',
      value: 'satisfied',
    });
    const second = evidenceForTest({
      evidenceId: 'evidence:state-not-satisfied',
      value: 'not-satisfied',
    });

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor: () => ({
        status: 'contradiction',
        summary: 'Two fresh observations disagree about the same state.',
        evidence: [first, second],
        failureClass: 'conflicting_observations',
      }),
      now: deterministicClock(),
    });

    expect(result.status).toBe('awaiting_evidence');
    expect(result.verification.criteria[0]?.satisfied).toBe(true);
    expect(result.verification.contradictions).toHaveLength(2);
    expect(result.verification.completionAuthorized).toBe(false);
    expect(result.falseCompletionPrevented).toBe(true);
    expect(result.nextAction).toContain('Resolve contradictory evidence');
  });

  it('reopens only verification for fresh final evidence without replaying the action', () => {
    const frame = frameForTest({ frameId: 'frame:verifier-reopen' });
    const actionId = 'action:perform-once';
    const graph = graphForTest(frame, [
      actionForTest(actionId, { expectedEvidenceClass: 'inferred' }),
    ]);
    const executor = vi.fn(() =>
      successfulObservation(
        evidenceForTest({
          evidenceId: 'evidence:initial-inference',
          evidenceClass: 'inferred',
          provenanceRefs: ['fresh-observation', 'inference:initial-result'],
        }),
      ),
    );
    const first = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });

    expect(first.status).toBe('degraded');
    expect(first.verification.completionAuthorized).toBe(false);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(
      first.graph.nodes.find((node) => node.actionId === actionId),
    ).toMatchObject({ status: 'succeeded', attemptCount: 1 });

    const reopened = reopenAdaptivePlanForEvidence(
      first.graph,
      '2026-07-19T12:01:00.000Z',
    );
    const finalEvidence = evidenceForTest({
      evidenceId: 'evidence:fresh-final-receipt',
      createdAt: '2026-07-19T12:01:00.000Z',
      provenanceRefs: [
        'fresh-observation',
        'verification_receipt:final-observation',
      ],
    });
    const resumed = runAdaptiveCognition({
      frame,
      graph: reopened,
      executor,
      beliefs: first.beliefs,
      evidence: [...first.evidence, finalEvidence],
      now: deterministicClock('2026-07-19T12:01:00.001Z'),
    });

    expect(resumed.status).toBe('satisfied');
    expect(resumed.verification.completionAuthorized).toBe(true);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(resumed.nodeExecutions).toBe(2);
    expect(
      resumed.graph.nodes.find((node) => node.actionId === actionId),
    ).toMatchObject({ status: 'succeeded', attemptCount: 1 });
    expect(
      resumed.graph.revisions.some((revision) => revision.kind === 'replan'),
    ).toBe(true);
    expect(
      resumed.graph.revisions.find((revision) =>
        revision.reason.includes('without replaying completed action nodes'),
      ),
    ).toBeDefined();
  });

  it('computes Brier score and ten-bin calibration error from the samples', () => {
    const samples = [
      { confidence: 0.9, outcome: 1 as const },
      { confidence: 0.8, outcome: 1 as const },
      { confidence: 0.2, outcome: 0 as const },
      { confidence: 0.1, outcome: 0 as const },
    ];
    const report = computeAdaptiveCalibration(samples, 10);
    const independentBrier =
      samples.reduce(
        (sum, sample) => sum + (sample.confidence - sample.outcome) ** 2,
        0,
      ) / samples.length;
    const independentEce = report.bins.reduce(
      (sum, bin) =>
        sum +
        (bin.count / samples.length) *
          Math.abs(bin.meanConfidence - bin.accuracy),
      0,
    );

    expect(report.sampleCount).toBe(4);
    expect(report.brierScore).toBeCloseTo(0.025, 12);
    expect(report.brierScore).toBeCloseTo(independentBrier, 12);
    expect(report.expectedCalibrationError).toBeCloseTo(0.15, 12);
    expect(report.expectedCalibrationError).toBeCloseTo(independentEce, 12);
    expect(report.meanConfidence).toBeCloseTo(0.5, 12);
    expect(report.accuracy).toBeCloseTo(0.5, 12);
    expect(report.bins).toHaveLength(10);
    expect(report.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(4);
  });

  it('keeps proposed improvements isolated and unable to expand authority', () => {
    const candidate = proposeIsolatedAdaptiveImprovement({
      createdAt: CREATED_AT,
      scope: 'verification',
      hypothesis: 'Exact receipt binding reduces false completion.',
      changeSummary: 'Evaluate stricter verifier matching in isolation.',
      sourceRunIds: ['run:synthetic-1'],
    });
    const tamperedCandidate = {
      ...candidate,
      authorityExpansion: true,
      productionMutationAllowed: true,
    } as unknown as AdaptiveImprovementCandidate;
    const underpowered = evaluateIsolatedAdaptiveImprovement({
      candidate,
      heldOutScenarioCount: 39,
      baselineScore: 0.5,
      candidateScore: 0.9,
      safetyRegressions: 0,
      privacyRegressions: 0,
    });
    const eligible = evaluateIsolatedAdaptiveImprovement({
      candidate: tamperedCandidate,
      heldOutScenarioCount: 48,
      baselineScore: 0.5,
      candidateScore: 0.9,
      safetyRegressions: 0,
      privacyRegressions: 0,
    });
    const unsafe = evaluateIsolatedAdaptiveImprovement({
      candidate,
      heldOutScenarioCount: 48,
      baselineScore: 0.5,
      candidateScore: 0.9,
      safetyRegressions: 1,
      privacyRegressions: 0,
    });

    expect(candidate).toMatchObject({
      state: 'isolated',
      authorityExpansion: false,
      productionMutationAllowed: false,
      privacy: ADAPTIVE_COGNITION_PRIVACY,
    });
    expect(underpowered).toMatchObject({
      state: 'rejected',
      authorityExpansion: false,
      productionMutationAllowed: false,
      evaluation: { eligible: false, heldOutScenarioCount: 39 },
    });
    expect(eligible).toMatchObject({
      state: 'eligible',
      authorityExpansion: false,
      productionMutationAllowed: false,
      evaluation: { eligible: true, heldOutScenarioCount: 48 },
    });
    expect(unsafe).toMatchObject({
      state: 'rejected',
      authorityExpansion: false,
      productionMutationAllowed: false,
      evaluation: { eligible: false, safetyRegressions: 1 },
    });
  });

  it('fails closed when a persisted satisfied graph has no completion evidence', () => {
    const frame = frameForTest({ frameId: 'frame:corrupt-satisfied' });
    const graph = graphForTest(frame, [actionForTest('action:corrupt')]);
    for (const node of graph.nodes) node.status = 'succeeded';
    graph.status = 'satisfied';
    const executor = vi.fn();

    const result = runAdaptiveCognition({
      frame,
      graph,
      evidence: [],
      executor,
      now: deterministicClock(),
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.status).toBe('awaiting_evidence');
    expect(result.verification.completionAuthorized).toBe(false);
    expect(result.falseCompletionPrevented).toBe(true);
    expect(
      result.graph.nodes.find(
        (node) => node.nodeId === result.graph.completionNodeId,
      )?.status,
    ).toBe('blocked');
  });

  it.each([
    {
      label: 'removed definition of done',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        successCriteria: [],
      }),
    },
    {
      label: 'mutated success criterion',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        successCriteria: frame.successCriteria.map((criterion) => ({
          ...criterion,
          minimumConfidence: 0.1,
        })),
      }),
    },
    {
      label: 'changed exact target',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        contextRefs: frame.contextRefs.map((ref) =>
          ref.startsWith('target:') ? 'target:other-record' : ref,
        ),
      }),
    },
    {
      label: 'removed receipt contract',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        contextRefs: frame.contextRefs.filter(
          (ref) => !ref.startsWith('receipt_required:'),
        ),
      }),
    },
    {
      label: 'expanded authority ceiling',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        authority: {
          ...frame.authority,
          maximumActionClass: 'approval_gated_mutation',
        },
      }),
    },
    {
      label: 'changed immutable budget',
      tamper: (frame: AdaptiveProblemFrame): AdaptiveProblemFrame => ({
        ...frame,
        budget: { ...frame.budget, maxCostUnits: 1 },
      }),
    },
  ])('rejects a same-ID frame with $label', ({ tamper }) => {
    const frame = frameForTest({ frameId: 'frame:contract-tamper' });
    const graph = graphForTest(frame, [actionForTest('action:contract')]);
    const executor = vi.fn();

    const result = runAdaptiveCognition({
      frame: tamper(frame),
      graph,
      executor,
      now: deterministicClock(),
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    expect(result.verification.completionAuthorized).toBe(false);
    expect(result.trace.at(-1)?.refs).toContain(
      'frame_contract_digest_mismatch',
    );
  });

  it.each([
    {
      label: 'node verifier contract',
      mutate: (node: ReturnType<typeof graphForTest>['nodes'][number]) => ({
        ...node,
        verifier: { ...node.verifier, requirementIds: ['criterion:forged'] },
      }),
    },
    {
      label: 'node cost contract',
      mutate: (node: ReturnType<typeof graphForTest>['nodes'][number]) => ({
        ...node,
        estimatedCostUnits: 0,
      }),
    },
  ])('rejects a tampered persisted $label', ({ mutate }) => {
    const frame = frameForTest({ frameId: 'frame:plan-tamper' });
    const graph = graphForTest(frame, [actionForTest('action:plan-contract')]);
    const executor = vi.fn();
    const tamperedGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.actionId === 'action:plan-contract' ? mutate(node) : node,
      ),
    };

    const result = runAdaptiveCognition({
      frame,
      graph: tamperedGraph,
      executor,
      now: deterministicClock(),
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.status).toBe('blocked');
    expect(result.trace.at(-1)?.refs).toContain(
      'plan_contract_digest_mismatch',
    );
  });

  it('keeps a failure-specific fallback dormant for an unrelated failure', () => {
    const frame = frameForTest({ frameId: 'frame:fallback-mismatch' });
    const primaryId = 'action:permission-sensitive-primary';
    const fallbackId = 'action:provider-only-fallback';
    const graph = graphForTest(frame, [
      actionForTest(primaryId),
      actionForTest(fallbackId, {
        alternativeForActionId: primaryId,
        recoveryForFailureClasses: ['provider_unavailable'],
      }),
    ]);
    const executor: AdaptiveNodeExecutor = () => ({
      status: 'terminal_failure',
      summary: 'The current actor lacks permission.',
      failureClass: 'permission_denied',
      evidence: [],
    });

    const result = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });

    expect(result.replans).toBe(0);
    expect(
      result.graph.nodes.find((node) => node.actionId === fallbackId)?.status,
    ).toBe('dormant');
    expect(result.status).not.toBe('satisfied');
  });

  it('rejects duplicate normalized action identities before approval matching', () => {
    const frame = frameForTest({ frameId: 'frame:duplicate-actions' });
    expect(() =>
      graphForTest(frame, [
        actionForTest('action duplicate'),
        actionForTest('action_duplicate'),
      ]),
    ).toThrow(/non-empty and unique/);
  });

  it('never promotes rejected observed evidence into a supported belief', () => {
    const rejected = evidenceForTest({
      evidenceId: 'evidence:rejected-belief',
      verification: 'rejected',
    });
    const reconciled = reconcileAdaptiveBeliefs({
      beliefs: [],
      evidence: [rejected],
      now: CREATED_AT,
    });

    expect(reconciled.beliefs).toHaveLength(1);
    expect(reconciled.beliefs[0]?.state).toBe('unknown');
    expect(reconciled.beliefs[0]?.state).not.toBe('supported');
  });

  it('records verified stale evidence as stale rather than supported', () => {
    const stale = evidenceForTest({
      evidenceId: 'evidence:stale-belief',
      freshness: 'stale',
      verification: 'verified',
    });
    const reconciled = reconcileAdaptiveBeliefs({
      beliefs: [],
      evidence: [stale],
      now: CREATED_AT,
    });

    expect(reconciled.beliefs).toHaveLength(1);
    expect(reconciled.beliefs[0]).toMatchObject({
      state: 'stale',
      freshness: 'stale',
      supportingEvidenceIds: [],
    });
  });

  it('redacts common secrets and sensitive identifiers before persistence', () => {
    const frame = createAdaptiveProblemFrame({
      createdAt: CREATED_AT,
      objective: 'Patient diagnosis is HIV; password=cedar; SSN 123-45-6789.',
      taskFamily: 'privacy-test',
      channel: 'unit-test',
    });
    const evidence = adaptiveEvidence({
      createdAt: CREATED_AT,
      evidenceClass: 'observed',
      origin: 'synthetic',
      source: 'privacy-test',
      claim: 'password=opal; social security number: 987-65-4321',
      confidence: 0.9,
    });
    const serialized = JSON.stringify({ frame, evidence });

    expect(serialized).not.toMatch(/cedar|opal|123-45-6789|987-65-4321|HIV/i);
    expect(serialized).not.toContain('password=');
    expect(frame.privacy).toEqual(ADAPTIVE_COGNITION_PRIVACY);
    expect(evidence.privacy).toEqual(ADAPTIVE_COGNITION_PRIVACY);
  });

  it('resumes an approval stop only after the updated frame contains the exact action approval', () => {
    const actionId = 'action:approved-resume';
    const frame = frameForTest({
      frameId: 'frame:approval-resume',
      maximumActionClass: 'approval_gated_mutation',
    });
    const graph = graphForTest(frame, [
      actionForTest(actionId, {
        actionClass: 'mutation',
        mutationClass: 'external_reversible',
        approvalRequired: true,
      }),
    ]);
    const executor = vi.fn(() =>
      successfulObservation(
        evidenceForTest({ evidenceId: 'evidence:approved-resume' }),
      ),
    );
    const stopped = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });
    const unchanged = resumeAdaptivePlanForUpdatedFrame(
      frame,
      stopped.graph,
      '2026-07-19T12:02:00.000Z',
    );
    expect(unchanged.status).toBe('awaiting_approval');

    const approvedFrame: AdaptiveProblemFrame = {
      ...frame,
      authority: { ...frame.authority, approvedActionIds: [actionId] },
    };
    const resumedGraph = resumeAdaptivePlanForUpdatedFrame(
      approvedFrame,
      stopped.graph,
      '2026-07-19T12:03:00.000Z',
    );
    const resumed = runAdaptiveCognition({
      frame: approvedFrame,
      graph: resumedGraph,
      executor,
      now: deterministicClock('2026-07-19T12:03:00.001Z'),
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(resumed.status).toBe('satisfied');
    expect(resumed.verification.completionAuthorized).toBe(true);
  });

  it('resumes a clarification stop only after the updated frame removes the blocking unknown', () => {
    const frame = createAdaptiveProblemFrame({
      frameId: 'frame:clarification-resume',
      createdAt: CREATED_AT,
      objective: 'Resolve the target before inspecting it.',
      taskFamily: 'clarification-test',
      channel: 'unit-test',
      successCriteria: [
        {
          criterionId: CRITERION_ID,
          description: 'The resolved target has fresh evidence.',
          requiredEvidenceClasses: ['observed'],
          minimumConfidence: 0.8,
        },
      ],
      unknowns: [
        {
          description: 'The exact target is missing.',
          impact: 'blocking',
          resolvableBy: ['owner_clarification'],
        },
      ],
      authority: { actorScope: ACTOR_SCOPE, maximumActionClass: 'read_only' },
      contextRefs: [`target:${TARGET}`, `receipt_required:${CRITERION_ID}`],
    });
    const graph = graphForTest(frame, [
      actionForTest('action:after-clarification'),
    ]);
    const executor = vi.fn(() =>
      successfulObservation(
        evidenceForTest({ evidenceId: 'evidence:clarified-target' }),
      ),
    );
    const stopped = runAdaptiveCognition({
      frame,
      graph,
      executor,
      now: deterministicClock(),
    });
    expect(stopped.status).toBe('awaiting_clarification');
    expect(executor).not.toHaveBeenCalled();

    const resolvedFrame: AdaptiveProblemFrame = {
      ...frame,
      unknowns: [],
      ambiguity: 'clear',
    };
    const resumedGraph = resumeAdaptivePlanForUpdatedFrame(
      resolvedFrame,
      stopped.graph,
      '2026-07-19T12:04:00.000Z',
    );
    const resumed = runAdaptiveCognition({
      frame: resolvedFrame,
      graph: resumedGraph,
      executor,
      now: deterministicClock('2026-07-19T12:04:00.001Z'),
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(resumed.status).toBe('satisfied');
  });
});
