import { createHash } from 'node:crypto';

import {
  adaptiveEvidence,
  advanceAdaptiveCognition,
  applyAdaptiveNodeObservation,
  reconcileAdaptiveVerifiedRecovery,
  validateAdaptivePlanGraph,
  type AdaptiveBeliefClaim,
  type AdaptiveCognitionDirective,
  type AdaptiveCognitionRunResult,
  type AdaptiveEvidence,
  type AdaptiveEvidenceOrigin,
  type AdaptiveNodeObservation,
  type AdaptivePlanGraph,
  type AdaptivePlanNode,
  type AdaptiveProblemFrame,
} from './adaptive-cognition-engine.js';
import {
  getDurableWorkCheckpoint,
  getDurableWorkUnit,
  listDurableEffectReceipts,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  createOrLoadDurableWork,
  durableScopeHash,
  orchestrateNextDurableNode,
  stageDurableWorkApproval,
  transitionDurableWork,
  unresolvedDurableEffectReceipts,
  type DurableExecutionPlan,
  type DurableExecutionPlanNode,
  type DurableNodeOrchestrationCallbacks,
  type DurableNodeOrchestrationResult,
  type DurableWorkBindingInput,
} from './durable-work-continuity.js';
import {
  assertDurableActionEffectPolicy,
  assertDurableActionExecutionSurface,
  durableActionRequiresApproval,
  type DurableActionClass,
  type DurablePolicyEffectClass,
} from './durable-action-policy.js';
import type {
  CognitiveApprovalPacket,
  DurableEffectReceipt,
  DurableWorkCheckpoint,
  DurableWorkUnit,
} from './types.js';

/**
 * Closed, explicit binding between one adaptive node and one durable effect.
 * None of these fields may be inferred from objective, purpose, or tool text.
 */
export interface AdaptiveDurableNodeBinding {
  graphId: string;
  planContractDigest: string;
  nodeId: string;
  actionId: string;
  toolId: string | null;
  durableActionClass: DurableActionClass;
  effectClass: DurablePolicyEffectClass;
  targetScopeKey: string;
  evidenceSubject: string;
  criterionIds: string[];
  requiredEvidenceIds: string[];
  verifierRequirementIds: string[];
}

export interface AdaptiveCognitionSnapshot {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs: AdaptiveBeliefClaim[];
  evidence: AdaptiveEvidence[];
}

export interface AdaptiveDurableCompiledPlan {
  plan: DurableExecutionPlan;
  pendingNodeIds: string[];
  completedNodeIds: string[];
  verificationNodeId: string;
  dependencyIds: string[];
  verificationRequirementIds: string[];
  bindings: AdaptiveDurableNodeBinding[];
}

export interface AdaptiveDurableWorkCreationResult {
  work: DurableWorkUnit;
  checkpoint: DurableWorkCheckpoint;
  created: boolean;
  compiled: AdaptiveDurableCompiledPlan;
}

export interface AdaptiveDurableOrchestrationResult {
  directive: AdaptiveCognitionDirective;
  durable: DurableNodeOrchestrationResult | null;
  snapshot: AdaptiveCognitionSnapshot;
}

export interface AdaptiveVerifiedReceiptObservationInput {
  receipt: Readonly<DurableEffectReceipt>;
  defaultEvidence: Readonly<AdaptiveEvidence>;
}

export type AdaptiveVerifiedReceiptObservation = Omit<
  AdaptiveNodeObservation,
  'status'
> & {
  status: 'success' | 'degraded' | 'terminal_failure';
};

/** Maps a newly completed exact receipt; verified crash recovery stays proof-only. */
export type AdaptiveVerifiedReceiptObservationMapper = (
  input: AdaptiveVerifiedReceiptObservationInput,
) => AdaptiveVerifiedReceiptObservation;

type AdaptiveDurableCallbacks<TAuthorization> = Omit<
  DurableNodeOrchestrationCallbacks<TAuthorization>,
  'loadPlan'
>;

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  const normalizedRight = [...new Set(right)].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

const VERIFIED_RECEIPT_OBSERVATION_STATUSES: ReadonlySet<
  AdaptiveVerifiedReceiptObservation['status']
> = new Set(['success', 'degraded', 'terminal_failure']);

function cloneAdaptiveEvidence(evidence: AdaptiveEvidence): AdaptiveEvidence {
  return {
    ...evidence,
    supportsCriterionIds: [...evidence.supportsCriterionIds],
    provenanceRefs: [...evidence.provenanceRefs],
    privacy: { ...evidence.privacy },
  };
}

function exactAdaptivePrivacy(
  left: AdaptiveEvidence['privacy'],
  right: AdaptiveEvidence['privacy'],
): boolean {
  const leftKeys = Object.keys(left) as Array<keyof typeof left>;
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

function validateVerifiedReceiptObservation(input: {
  candidate: unknown;
  receipt: DurableEffectReceipt;
  defaultEvidence: AdaptiveEvidence;
}): AdaptiveVerifiedReceiptObservation {
  const candidate = input.candidate as Partial<AdaptiveNodeObservation> | null;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !VERIFIED_RECEIPT_OBSERVATION_STATUSES.has(
      candidate.status as AdaptiveVerifiedReceiptObservation['status'],
    ) ||
    typeof candidate.summary !== 'string' ||
    candidate.summary.trim().length === 0 ||
    candidate.summary.length > 360 ||
    !Array.isArray(candidate.evidence)
  ) {
    throw new Error(
      'Verified receipt observation mapper returned an invalid or replay-unsafe typed observation.',
    );
  }
  if (
    (candidate.failureClass !== undefined &&
      candidate.failureClass !== null &&
      (typeof candidate.failureClass !== 'string' ||
        candidate.failureClass.length === 0 ||
        candidate.failureClass.length > 120)) ||
    (candidate.nextAction !== undefined &&
      candidate.nextAction !== null &&
      (typeof candidate.nextAction !== 'string' ||
        candidate.nextAction.length === 0 ||
        candidate.nextAction.length > 360)) ||
    (candidate.retryAfterMs !== undefined &&
      candidate.retryAfterMs !== null &&
      (typeof candidate.retryAfterMs !== 'number' ||
        !Number.isFinite(candidate.retryAfterMs) ||
        candidate.retryAfterMs < 0 ||
        candidate.retryAfterMs > 86_400_000))
  ) {
    throw new Error(
      'Verified receipt observation mapper returned invalid bounded metadata.',
    );
  }
  const expectedReceiptRefs = [
    `effect_receipt:${input.receipt.receiptId}`,
    `verification_receipt:${input.receipt.verificationFingerprint}`,
    `post_state:${input.receipt.postStateFingerprint}`,
  ];
  if (
    input.defaultEvidence.source !== input.receipt.receiptId ||
    !expectedReceiptRefs.every((ref) =>
      input.defaultEvidence.provenanceRefs.includes(ref),
    ) ||
    candidate.evidence.length > 1
  ) {
    throw new Error(
      'Verified receipt observation is not bound to the exact durable receipt.',
    );
  }
  for (const evidence of candidate.evidence) {
    if (
      !evidence ||
      typeof evidence !== 'object' ||
      evidence.evidenceId !== input.defaultEvidence.evidenceId ||
      evidence.createdAt !== input.defaultEvidence.createdAt ||
      evidence.evidenceClass !== input.defaultEvidence.evidenceClass ||
      evidence.origin !== input.defaultEvidence.origin ||
      evidence.source !== input.defaultEvidence.source ||
      evidence.claim !== input.defaultEvidence.claim ||
      evidence.subject !== input.defaultEvidence.subject ||
      evidence.predicate !== input.defaultEvidence.predicate ||
      evidence.value !== input.defaultEvidence.value ||
      evidence.confidence !== input.defaultEvidence.confidence ||
      evidence.freshness !== input.defaultEvidence.freshness ||
      evidence.scope !== input.defaultEvidence.scope ||
      evidence.verification !== input.defaultEvidence.verification ||
      !Array.isArray(evidence.supportsCriterionIds) ||
      !Array.isArray(evidence.provenanceRefs) ||
      !evidence.privacy ||
      !exactSet(
        evidence.provenanceRefs,
        input.defaultEvidence.provenanceRefs,
      ) ||
      !exactAdaptivePrivacy(evidence.privacy, input.defaultEvidence.privacy)
    ) {
      throw new Error(
        'Verified receipt observation evidence must be the exact receipt-backed default evidence.',
      );
    }
  }
  const status =
    candidate.status as AdaptiveVerifiedReceiptObservation['status'];
  if (
    (status === 'success' &&
      (candidate.evidence.length !== 1 ||
        !exactSet(
          candidate.evidence[0]!.supportsCriterionIds,
          input.defaultEvidence.supportsCriterionIds,
        ))) ||
    (status !== 'success' &&
      candidate.evidence.some(
        (evidence) => evidence.supportsCriterionIds.length > 0,
      ))
  ) {
    throw new Error(
      'Only adaptive success may retain exact criterion support from a verified receipt.',
    );
  }
  return {
    status,
    summary: candidate.summary,
    evidence: candidate.evidence.map(cloneAdaptiveEvidence),
    failureClass: candidate.failureClass,
    nextAction: candidate.nextAction,
    retryAfterMs: candidate.retryAfterMs,
  };
}

function targetForCriterion(
  frame: AdaptiveProblemFrame,
  criterionId: string,
): string | null {
  const exactPrefix = `target:${criterionId}:`;
  const exact = frame.contextRefs
    .find((ref) => ref.startsWith(exactPrefix))
    ?.slice(exactPrefix.length);
  if (exact) return exact;
  return (
    frame.contextRefs
      .find(
        (ref) =>
          ref.startsWith('target:') &&
          !frame.successCriteria.some((criterion) =>
            ref.startsWith(`target:${criterion.criterionId}:`),
          ),
      )
      ?.slice('target:'.length) || null
  );
}

function executableAdaptiveNodes(graph: AdaptivePlanGraph): AdaptivePlanNode[] {
  return graph.nodes.filter((node) => ['act', 'recover'].includes(node.kind));
}

function bindingForNode(
  bindings: readonly AdaptiveDurableNodeBinding[],
  nodeId: string,
): AdaptiveDurableNodeBinding {
  const binding = bindings.find((candidate) => candidate.nodeId === nodeId);
  if (!binding) {
    throw new Error('Adaptive durable execution lacks an exact node binding.');
  }
  return binding;
}

function assertBindingRiskCompatibility(
  node: AdaptivePlanNode,
  binding: AdaptiveDurableNodeBinding,
): void {
  assertDurableActionExecutionSurface(
    binding.durableActionClass,
    'generic_durable',
  );
  assertDurableActionEffectPolicy(
    binding.durableActionClass,
    binding.effectClass,
  );
  const effectful =
    binding.effectClass !== 'read_only' || node.mutationClass !== 'none';
  if (effectful) {
    if (
      !node.approvalRequired ||
      !durableActionRequiresApproval(binding.durableActionClass)
    ) {
      throw new Error(
        'Adaptive effectful node must declare exact approval in both contracts.',
      );
    }
    if (node.verifier.kind !== 'receipt') {
      throw new Error('Adaptive effectful node requires a receipt verifier.');
    }
  }
  if (
    [
      'local_lookup',
      'read_only_integration',
      'council',
      'approval_gate',
    ].includes(node.actionClass) &&
    binding.effectClass !== 'read_only'
  ) {
    throw new Error('Adaptive read-only action cannot bind to a write effect.');
  }
  if (
    node.actionClass === 'draft' &&
    !['read_only', 'local_write'].includes(binding.effectClass)
  ) {
    throw new Error('Adaptive draft action exceeds its local-write boundary.');
  }
}

/** Validates exact, complete bindings and returns defensive copies. */
export function validateAdaptiveDurableBindings(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  bindings: AdaptiveDurableNodeBinding[];
  targetScopeKey: string;
}): AdaptiveDurableNodeBinding[] {
  const graphIssues = validateAdaptivePlanGraph(input.frame, input.graph);
  if (graphIssues.length > 0) {
    throw new Error(
      `Adaptive durable binding rejected invalid graph: ${graphIssues.join(',')}.`,
    );
  }
  const nodes = executableAdaptiveNodes(input.graph);
  if (
    input.bindings.length !== nodes.length ||
    new Set(input.bindings.map((binding) => binding.nodeId)).size !==
      input.bindings.length
  ) {
    throw new Error(
      'Adaptive durable bindings must cover every executable node exactly once.',
    );
  }
  const criterionIds = new Set(
    input.frame.successCriteria.map((criterion) => criterion.criterionId),
  );
  return input.bindings.map((candidate) => {
    const node = nodes.find((entry) => entry.nodeId === candidate.nodeId);
    if (!node || !node.actionId) {
      throw new Error('Adaptive durable binding references an unknown node.');
    }
    if (
      candidate.graphId !== input.graph.graphId ||
      candidate.planContractDigest !== input.graph.planContractDigest ||
      candidate.actionId !== node.actionId ||
      candidate.toolId !== node.toolId
    ) {
      throw new Error('Adaptive durable binding identity changed.');
    }
    if (
      !candidate.targetScopeKey ||
      candidate.targetScopeKey !== input.targetScopeKey
    ) {
      throw new Error('Adaptive durable target scope changed.');
    }
    if (
      !exactSet(candidate.criterionIds, node.producesCriterionIds) ||
      candidate.criterionIds.some(
        (criterionId) => !criterionIds.has(criterionId),
      )
    ) {
      throw new Error('Adaptive durable criterion binding changed.');
    }
    if (
      !exactSet(candidate.requiredEvidenceIds, node.requiredEvidence) ||
      !exactSet(candidate.verifierRequirementIds, node.verifier.requirementIds)
    ) {
      throw new Error(
        'Adaptive durable required-evidence or verifier binding changed.',
      );
    }
    for (const criterionId of candidate.criterionIds) {
      const target = targetForCriterion(input.frame, criterionId);
      if (!target || target !== candidate.evidenceSubject) {
        throw new Error('Adaptive durable evidence subject changed.');
      }
    }
    assertBindingRiskCompatibility(node, candidate);
    return {
      ...candidate,
      criterionIds: [...candidate.criterionIds],
      requiredEvidenceIds: [...candidate.requiredEvidenceIds],
      verifierRequirementIds: [...candidate.verifierRequirementIds],
    };
  });
}

/** Compiles one durable plan from the authoritative adaptive graph. */
export function compileAdaptiveDurablePlan(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  bindings: AdaptiveDurableNodeBinding[];
  targetScopeKey: string;
  planVersion: number;
}): AdaptiveDurableCompiledPlan {
  const bindings = validateAdaptiveDurableBindings(input);
  const bindingIds = new Set(bindings.map((binding) => binding.nodeId));
  const graphPosition = new Map(
    input.graph.nodes.map((node, index) => [node.nodeId, index]),
  );
  const nodes: DurableExecutionPlanNode[] = bindings.map((binding) => {
    const node = input.graph.nodes.find(
      (candidate) => candidate.nodeId === binding.nodeId,
    )!;
    return {
      nodeId: node.nodeId,
      position: graphPosition.get(node.nodeId) || 0,
      actionClass: binding.durableActionClass,
      effectClass: binding.effectClass,
      dependsOnNodeIds: node.dependencyIds.filter((nodeId) =>
        bindingIds.has(nodeId),
      ),
      verificationRequirementIds: [...binding.verifierRequirementIds],
    };
  });
  const adaptiveVerifier = input.graph.nodes.find(
    (node) => node.nodeId === input.graph.verificationNodeId,
  );
  if (!adaptiveVerifier || adaptiveVerifier.kind !== 'verify') {
    throw new Error('Adaptive durable plan has no terminal verifier.');
  }
  const verificationNode: DurableExecutionPlanNode = {
    nodeId: adaptiveVerifier.nodeId,
    position: graphPosition.get(adaptiveVerifier.nodeId) || nodes.length,
    actionClass: 'verification_test',
    effectClass: 'read_only',
    dependsOnNodeIds: adaptiveVerifier.dependencyIds.filter((nodeId) =>
      bindingIds.has(nodeId),
    ),
    verificationRequirementIds: input.frame.successCriteria
      .filter((criterion) => criterion.required)
      .map((criterion) => criterion.criterionId),
  };
  nodes.push(verificationNode);
  const activeStatuses = new Set([
    'pending',
    'ready',
    'running',
    'awaiting_approval',
  ]);
  const pendingNodeIds = input.graph.nodes
    .filter(
      (node) => bindingIds.has(node.nodeId) && activeStatuses.has(node.status),
    )
    .map((node) => node.nodeId);
  if (!['succeeded', 'superseded'].includes(adaptiveVerifier.status)) {
    pendingNodeIds.push(adaptiveVerifier.nodeId);
  }
  const completedNodeIds = input.graph.nodes
    .filter(
      (node) => bindingIds.has(node.nodeId) && node.status === 'succeeded',
    )
    .map((node) => node.nodeId);
  return {
    plan: {
      planId: input.graph.graphId,
      planVersion: Math.max(1, Math.floor(input.planVersion)),
      nodes,
    },
    pendingNodeIds,
    completedNodeIds,
    verificationNodeId: adaptiveVerifier.nodeId,
    dependencyIds: [
      input.graph.frameContractDigest,
      input.graph.planContractDigest,
      ...nodes.flatMap((node) => node.dependsOnNodeIds),
    ],
    verificationRequirementIds: [
      ...input.frame.evidenceRequirements,
      ...input.frame.successCriteria
        .filter((criterion) => criterion.required)
        .map((criterion) => criterion.criterionId),
    ],
    bindings,
  };
}

/** Creates the durable projection and its first adaptive-node checkpoint. */
export function createAdaptiveDurableWork(input: {
  originTurnId: string;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  goalSummary: string;
  cognitiveRunId: string;
  runtimeRunId?: string | null;
  agentOSEpisodeId?: string | null;
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  bindings: AdaptiveDurableNodeBinding[];
  executorScopeKey: string;
  targetScopeKey: string;
  runtimeCheckpointId?: string | null;
  now?: Date | string;
}): AdaptiveDurableWorkCreationResult {
  const compiled = compileAdaptiveDurablePlan({
    frame: input.frame,
    graph: input.graph,
    bindings: input.bindings,
    targetScopeKey: input.targetScopeKey,
    planVersion: 1,
  });
  const created = createOrLoadDurableWork({
    originTurnId: input.originTurnId,
    authorizedSurface: input.authorizedSurface,
    binding: input.binding,
    goalSummary: input.goalSummary,
    cognitiveRunId: input.cognitiveRunId,
    runtimeRunId: input.runtimeRunId,
    agentOSEpisodeId: input.agentOSEpisodeId,
    planId: input.graph.graphId,
    nextAction: 'Commit the authoritative adaptive-node checkpoint.',
    now: input.now,
  });
  if (!created.created) {
    const checkpoint = created.work.checkpointHeadId
      ? getDurableWorkCheckpoint(created.work.checkpointHeadId)
      : null;
    if (!checkpoint) {
      throw new Error('Existing adaptive durable work has no checkpoint.');
    }
    if (
      created.work.planId !== input.graph.graphId ||
      checkpoint.planVersion !== compiled.plan.planVersion
    ) {
      throw new Error('Existing adaptive durable work changed plan identity.');
    }
    return { ...created, checkpoint, compiled };
  }
  let work = transitionDurableWork({
    workId: created.work.workId,
    expectedVersion: created.work.version,
    toStatus: 'inspecting',
    nextAction: 'Validate the exact adaptive graph and durable bindings.',
    now: input.now,
  });
  work = transitionDurableWork({
    workId: work.workId,
    expectedVersion: work.version,
    toStatus: 'planned',
    nextAction: 'Commit the bounded adaptive execution checkpoint.',
    now: input.now,
  });
  const committed = commitDurableCheckpointCAS({
    workId: work.workId,
    expectedWorkVersion: work.version,
    runtimeCheckpointId: input.runtimeCheckpointId || input.graph.graphId,
    completedNodeIds: [],
    pendingNodeIds: compiled.pendingNodeIds,
    uncertainNodeIds: [],
    dependencyIds: compiled.dependencyIds,
    worldSignals: { fresh: [], stale: [], missing: [] },
    executorScopeKey: input.executorScopeKey,
    targetScopeKey: input.targetScopeKey,
    receiptIds: [],
    verificationRequirementIds: compiled.verificationRequirementIds,
    retryBudget: input.frame.budget.maxRetries,
    attemptsUsed: 0,
    stopConditionIds: input.frame.stopConditions,
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Resume only the exact next adaptive node.',
    now: input.now,
  });
  work = transitionDurableWork({
    workId: committed.work.workId,
    expectedVersion: committed.work.version,
    toStatus: 'ready',
    nextAction: 'Issue a node-scoped grant for the exact next adaptive node.',
    now: input.now,
  });
  return {
    work,
    checkpoint: committed.checkpoint,
    created: true,
    compiled,
  };
}

/** Stages approval whose immutable identity includes the adaptive node ID. */
export function stageAdaptiveDurableApproval(input: {
  work: DurableWorkUnit;
  cognitiveRunId: string;
  directive: AdaptiveCognitionDirective;
  bindings: AdaptiveDurableNodeBinding[];
  summary: string;
  ttlMs?: number;
  now?: Date | string;
}): {
  packet: CognitiveApprovalPacket;
  work: DurableWorkUnit;
  checkpoint: DurableWorkCheckpoint;
} {
  if (input.directive.kind !== 'execute_node' || !input.directive.node) {
    throw new Error('Adaptive approval requires an execute-node directive.');
  }
  const binding = bindingForNode(input.bindings, input.directive.node.nodeId);
  if (!durableActionRequiresApproval(binding.durableActionClass)) {
    throw new Error('Adaptive node does not require durable approval.');
  }
  return stageDurableWorkApproval({
    workId: input.work.workId,
    expectedWorkVersion: input.work.version,
    cognitiveRunId: input.cognitiveRunId,
    actionClass: binding.durableActionClass,
    nodeId: input.directive.node.nodeId,
    summary: input.summary,
    ttlMs: input.ttlMs,
    now: input.now,
  });
}

function terminalFingerprints(result: AdaptiveCognitionRunResult): {
  postStateFingerprint: string;
  verificationFingerprint: string;
} {
  const evidenceIds = result.verification.criteria
    .flatMap((criterion) => criterion.evidenceIds)
    .sort();
  const seed = [
    result.graph.graphId,
    result.graph.planContractDigest,
    result.frame.frameId,
    result.verification.status,
    ...evidenceIds,
  ].join('|');
  return {
    postStateFingerprint: `adaptive_post:${createHash('sha256')
      .update(seed)
      .digest('hex')}`,
    verificationFingerprint: `adaptive_verify:${createHash('sha256')
      .update(`verified|${seed}`)
      .digest('hex')}`,
  };
}

/** Converts only an exact verified durable receipt into completion evidence. */
export function adaptiveEvidenceFromVerifiedReceipt(input: {
  frame: AdaptiveProblemFrame;
  work: DurableWorkUnit;
  binding: AdaptiveDurableNodeBinding;
  receipt: DurableEffectReceipt;
  origin: AdaptiveEvidenceOrigin;
}): AdaptiveEvidence {
  const { receipt, binding, work } = input;
  const persistedReceipt = listDurableEffectReceipts({
    workId: work.workId,
    checkpointId: receipt.checkpointId,
    limit: 1_000,
  }).find((candidate) => candidate.receiptId === receipt.receiptId);
  const checkpoint = getDurableWorkCheckpoint(receipt.checkpointId);
  let checkpointDependencies: string[] = [];
  try {
    const parsed: unknown = checkpoint
      ? JSON.parse(checkpoint.dependencyIdsJson)
      : [];
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'string')
    ) {
      checkpointDependencies = parsed;
    }
  } catch {
    checkpointDependencies = [];
  }
  if (
    receipt.status !== 'succeeded' ||
    !persistedReceipt ||
    persistedReceipt.workId !== receipt.workId ||
    persistedReceipt.checkpointId !== receipt.checkpointId ||
    persistedReceipt.planVersion !== receipt.planVersion ||
    persistedReceipt.nodeId !== receipt.nodeId ||
    persistedReceipt.invocationId !== receipt.invocationId ||
    persistedReceipt.actionClass !== receipt.actionClass ||
    persistedReceipt.effectClass !== receipt.effectClass ||
    persistedReceipt.status !== receipt.status ||
    persistedReceipt.targetScopeHash !== receipt.targetScopeHash ||
    persistedReceipt.grantId !== receipt.grantId ||
    persistedReceipt.approvalPacketId !== receipt.approvalPacketId ||
    persistedReceipt.approvalVersion !== receipt.approvalVersion ||
    persistedReceipt.approvalScopeHash !== receipt.approvalScopeHash ||
    persistedReceipt.leaseId !== receipt.leaseId ||
    persistedReceipt.processGeneration !== receipt.processGeneration ||
    persistedReceipt.preStateFingerprint !== receipt.preStateFingerprint ||
    persistedReceipt.verificationFingerprint !==
      receipt.verificationFingerprint ||
    persistedReceipt.postStateFingerprint !== receipt.postStateFingerprint ||
    persistedReceipt.createdAt !== receipt.createdAt ||
    persistedReceipt.updatedAt !== receipt.updatedAt ||
    persistedReceipt.metadataJson !== receipt.metadataJson ||
    persistedReceipt.privacyJson !== receipt.privacyJson ||
    !receipt.verificationFingerprint ||
    !receipt.postStateFingerprint ||
    receipt.workId !== work.workId ||
    receipt.planVersion !== work.planVersion ||
    receipt.nodeId !== binding.nodeId ||
    receipt.actionClass !== binding.durableActionClass ||
    receipt.effectClass !== binding.effectClass ||
    work.planId !== binding.graphId ||
    !checkpoint ||
    checkpoint.workId !== work.workId ||
    checkpoint.planVersion !== receipt.planVersion ||
    checkpoint.targetScopeHash !== receipt.targetScopeHash ||
    !checkpointDependencies.includes(binding.planContractDigest) ||
    receipt.targetScopeHash !== work.targetScopeHash ||
    receipt.targetScopeHash !==
      durableScopeHash('target', binding.targetScopeKey)
  ) {
    throw new Error(
      'Durable receipt is not exact verified adaptive completion evidence.',
    );
  }
  if (
    durableActionRequiresApproval(binding.durableActionClass) &&
    (!receipt.grantId ||
      !receipt.approvalPacketId ||
      !receipt.approvalVersion ||
      !receipt.approvalScopeHash)
  ) {
    throw new Error('Durable receipt lacks exact approval provenance.');
  }
  return adaptiveEvidence({
    evidenceId: `adaptive:durable:${receipt.receiptId}`,
    createdAt: receipt.updatedAt,
    evidenceClass: 'observed',
    origin: input.origin,
    source: receipt.receiptId,
    claim: 'A durable node reached an independently verified post-state.',
    subject: binding.evidenceSubject,
    predicate: `verified_effect:${binding.nodeId}`,
    value: 'verified',
    confidence: 0.98,
    freshness: 'fresh',
    scope: input.frame.authority.actorScope,
    verification: 'verified',
    supportsCriterionIds: [...binding.criterionIds],
    provenanceRefs: [
      `effect_receipt:${receipt.receiptId}`,
      `verification_receipt:${receipt.verificationFingerprint}`,
      `post_state:${receipt.postStateFingerprint}`,
      receipt.workId,
      receipt.checkpointId,
      binding.nodeId,
      ...binding.requiredEvidenceIds,
      ...binding.verifierRequirementIds,
    ],
  });
}

function durableFailureObservation(
  result: DurableNodeOrchestrationResult,
): AdaptiveNodeObservation {
  if (result.status === 'approval_required') {
    return {
      status: 'approval_required',
      summary: 'The exact durable node requires current owner approval.',
      evidence: [],
      failureClass: 'approval_required',
    };
  }
  if (
    result.status === 'verification_required' ||
    result.status === 'verification_failed'
  ) {
    return {
      status: 'stale_evidence',
      summary: 'The durable effect remains uncertain and cannot be replayed.',
      evidence: [],
      failureClass: 'durable_verification_required',
    };
  }
  if (result.status === 'replanned' || result.status === 'replan_required') {
    return {
      status: 'retryable_failure',
      summary: 'Durable orchestration requires a bounded structural replan.',
      evidence: [],
      failureClass: 'durable_replan_required',
    };
  }
  return {
    status: 'terminal_failure',
    summary: 'Durable orchestration stopped before verified completion.',
    evidence: [],
    failureClass: `durable_${result.status}`,
  };
}

/**
 * Runs at most one exact durable node and reconciles its verified receipt into
 * the same adaptive graph. Unknown effects stay verification-only.
 */
export async function orchestrateAdaptiveDurableDirective<
  TAuthorization = unknown,
>(input: {
  snapshot: AdaptiveCognitionSnapshot;
  bindings: AdaptiveDurableNodeBinding[];
  planVersion: number;
  workId: string;
  leaseId: string;
  processGeneration?: string;
  executorScopeKey: string;
  targetScopeKey: string;
  origin: AdaptiveEvidenceOrigin;
  callbacks: AdaptiveDurableCallbacks<TAuthorization>;
  mapVerifiedReceiptObservation?: AdaptiveVerifiedReceiptObservationMapper;
  now?: Date | string;
}): Promise<AdaptiveDurableOrchestrationResult> {
  const nowIso =
    input.now instanceof Date
      ? input.now.toISOString()
      : input.now || new Date().toISOString();
  const directive = advanceAdaptiveCognition({
    ...input.snapshot,
    now: () => nowIso,
  });
  const compiled = compileAdaptiveDurablePlan({
    frame: directive.result.frame,
    graph: directive.result.graph,
    bindings: input.bindings,
    targetScopeKey: input.targetScopeKey,
    planVersion: input.planVersion,
  });
  const persistedWork = getDurableWorkUnit(input.workId);
  const persistedCheckpoint = persistedWork?.checkpointHeadId
    ? getDurableWorkCheckpoint(persistedWork.checkpointHeadId)
    : null;
  let uncertainNodeIds: string[] = [];
  try {
    const parsed: unknown = persistedCheckpoint
      ? JSON.parse(persistedCheckpoint.uncertainNodeIdsJson)
      : [];
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'string')
    ) {
      uncertainNodeIds = parsed;
    }
  } catch {
    uncertainNodeIds = [];
  }
  const unresolvedReceiptNodeId = persistedWork
    ? unresolvedDurableEffectReceipts(
        listDurableEffectReceipts({
          workId: persistedWork.workId,
          limit: 1_000,
        }).filter(
          (receipt) => receipt.planVersion === persistedWork.planVersion,
        ),
      )[0]?.nodeId || null
    : null;
  const recoveryNodeId = uncertainNodeIds[0] || unresolvedReceiptNodeId;
  const recovering = Boolean(recoveryNodeId);
  const terminal =
    !recovering &&
    directive.kind === 'terminal' &&
    directive.result.status === 'satisfied' &&
    directive.result.verification.completionAuthorized;
  const expectedNodeId =
    recoveryNodeId ||
    (terminal ? compiled.verificationNodeId : directive.node?.nodeId || null);
  if (!expectedNodeId) {
    return {
      directive,
      durable: null,
      snapshot: {
        frame: directive.result.frame,
        graph: directive.result.graph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
      },
    };
  }
  const terminalFingerprintsValue = terminal
    ? terminalFingerprints(directive.result)
    : null;
  const callbacks: DurableNodeOrchestrationCallbacks<TAuthorization> = {
    ...input.callbacks,
    loadPlan: () => compiled.plan,
    revalidateNode: (args) =>
      args.node.nodeId === compiled.verificationNodeId
        ? {
            dependencyState: 'fresh',
            targetState: 'fresh',
            freshSignalIds: [directive.result.graph.planContractDigest],
          }
        : input.callbacks.revalidateNode(args),
    executeNode: (args) =>
      args.node.nodeId === compiled.verificationNodeId
        ? {
            status: terminal ? 'succeeded' : 'failed',
            postStateFingerprint:
              terminalFingerprintsValue?.postStateFingerprint || null,
          }
        : input.callbacks.executeNode(args),
    verifyNode: (args) =>
      args.node.nodeId === compiled.verificationNodeId
        ? terminal && terminalFingerprintsValue
          ? {
              status: 'verified',
              ...terminalFingerprintsValue,
            }
          : { status: 'failed' }
        : input.callbacks.verifyNode(args),
  };
  const durable = await orchestrateNextDurableNode({
    workId: input.workId,
    leaseId: input.leaseId,
    processGeneration: input.processGeneration,
    executorScopeKey: input.executorScopeKey,
    targetScopeKey: input.targetScopeKey,
    expectedNodeId,
    callbacks,
    now: nowIso,
  });
  if (terminal) {
    return {
      directive,
      durable,
      snapshot: {
        frame: directive.result.frame,
        graph: directive.result.graph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
      },
    };
  }
  if (
    !durable.executed &&
    ['replanned', 'replan_required'].includes(durable.status)
  ) {
    // Durable scope/plan synchronization stopped before the selected adaptive
    // node crossed the invocation boundary. Do not invent a node failure or
    // consume its adaptive retry budget.
    return {
      directive,
      durable,
      snapshot: {
        frame: directive.result.frame,
        graph: directive.result.graph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
      },
    };
  }
  const binding = bindingForNode(compiled.bindings, expectedNodeId);
  let observation: AdaptiveNodeObservation;
  if (
    durable.receipt &&
    durable.receipt.status === 'succeeded' &&
    durable.receipt.verificationFingerprint &&
    durable.receipt.postStateFingerprint
  ) {
    const evidence = adaptiveEvidenceFromVerifiedReceipt({
      frame: directive.result.frame,
      work: durable.work,
      binding,
      receipt: durable.receipt,
      origin: input.origin,
    });
    const defaultObservation: AdaptiveNodeObservation = {
      status: 'success',
      summary: 'The exact durable node has verified receipt evidence.',
      evidence: [evidence],
    };
    observation =
      input.mapVerifiedReceiptObservation && !recovering
        ? validateVerifiedReceiptObservation({
            candidate: input.mapVerifiedReceiptObservation({
              receipt: { ...durable.receipt },
              defaultEvidence: cloneAdaptiveEvidence(evidence),
            }),
            receipt: durable.receipt,
            defaultEvidence: evidence,
          })
        : defaultObservation;
  } else {
    observation = durableFailureObservation(durable);
  }
  if (recovering && observation.status !== 'success') {
    return {
      directive,
      durable,
      snapshot: {
        frame: directive.result.frame,
        graph: directive.result.graph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
      },
    };
  }
  const recoveryGraph = directive.result.graph;
  if (recovering) {
    const recoveryNode = recoveryGraph.nodes.find(
      (node) => node.nodeId === expectedNodeId,
    );
    if (recoveryNode && ['pending', 'ready'].includes(recoveryNode.status)) {
      // A same-work, same-plan durable started receipt proves that this node
      // crossed the invocation boundary even if the adaptive snapshot was not
      // persisted before the process stopped.
      recoveryNode.status = 'running';
      recoveryNode.attemptCount = Math.max(1, recoveryNode.attemptCount);
      recoveryNode.updatedAt = nowIso;
    }
  }
  const reconciled = recovering
    ? reconcileAdaptiveVerifiedRecovery({
        frame: directive.result.frame,
        graph: recoveryGraph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
        nodeId: expectedNodeId,
        recoveredEvidence: observation.evidence,
        now: () => nowIso,
      })
    : applyAdaptiveNodeObservation({
        frame: directive.result.frame,
        graph: directive.result.graph,
        beliefs: directive.result.beliefs,
        evidence: directive.result.evidence,
        nodeId: expectedNodeId,
        observation,
        now: () => nowIso,
      });
  return {
    directive,
    durable,
    snapshot: {
      frame: reconciled.frame,
      graph: reconciled.graph,
      beliefs: reconciled.beliefs,
      evidence: reconciled.evidence,
    },
  };
}
