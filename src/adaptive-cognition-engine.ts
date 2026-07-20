import { createHash } from 'node:crypto';

import { redactCouncilText } from './council-safety.js';

/**
 * Canonical, policy-neutral cognition state machine.
 *
 * The engine decides what to do next, one node at a time. It deliberately does
 * not own credentials, transports, or mutation authority. Callers must execute
 * nodes through their existing policy/approval layer and return typed evidence.
 */

export const ADAPTIVE_COGNITION_VERSION = '1.0.0';

export type AdaptiveEvidenceClass =
  | 'observed'
  | 'user_attested'
  | 'inferred'
  | 'simulated'
  | 'model_generated';

export type AdaptiveEvidenceFreshness = 'fresh' | 'stale' | 'unknown';

export type AdaptiveEvidenceOrigin = 'live' | 'replay' | 'synthetic';

export type AdaptiveActionClass =
  | 'reasoning'
  | 'clarification'
  | 'local_lookup'
  | 'read_only_integration'
  | 'council'
  | 'draft'
  | 'approval_gate'
  | 'mutation'
  | 'verification'
  | 'completion';

export type AdaptiveMutationClass =
  | 'none'
  | 'local_reversible'
  | 'external_reversible'
  | 'external_irreversible';

export type AdaptivePlanNodeStatus =
  | 'dormant'
  | 'pending'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'blocked'
  | 'superseded'
  | 'awaiting_approval'
  | 'awaiting_clarification';

export type AdaptiveRunStatus =
  | 'active'
  | 'satisfied'
  | 'degraded'
  | 'awaiting_evidence'
  | 'awaiting_approval'
  | 'awaiting_clarification'
  | 'blocked'
  | 'budget_exhausted';

export type AdaptiveObservationStatus =
  | 'success'
  | 'degraded'
  | 'retryable_failure'
  | 'terminal_failure'
  | 'approval_required'
  | 'needs_clarification'
  | 'stale_evidence'
  | 'contradiction';

export interface AdaptivePrivacyBoundary {
  metadataOnly: true;
  rawPromptsStored: false;
  rawPrivateBodiesStored: false;
  hiddenReasoningStored: false;
  rawToolOutputStored: false;
  secretsRedacted: true;
}

export const ADAPTIVE_COGNITION_PRIVACY: AdaptivePrivacyBoundary = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  rawToolOutputStored: false,
  secretsRedacted: true,
};

export interface AdaptiveSuccessCriterion {
  criterionId: string;
  description: string;
  requiredEvidenceClasses: AdaptiveEvidenceClass[];
  minimumConfidence: number;
  required: boolean;
}

export interface AdaptiveUnknown {
  unknownId: string;
  description: string;
  impact: 'informational' | 'degrading' | 'blocking';
  resolvableBy: string[];
}

export interface AdaptiveAuthorityBoundary {
  actorScope: string;
  maximumActionClass:
    | 'reasoning_only'
    | 'read_only'
    | 'draft_only'
    | 'approval_gated_mutation';
  approvedActionIds: string[];
  mutationApprovalRequired: true;
  inheritedAuthorityForbidden: true;
}

export interface AdaptiveProblemFrame {
  frameId: string;
  createdAt: string;
  objective: string;
  taskFamily: string;
  channel: string;
  route: string | null;
  successCriteria: AdaptiveSuccessCriterion[];
  constraints: string[];
  evidenceRequirements: string[];
  assumptions: string[];
  unknowns: AdaptiveUnknown[];
  ambiguity: 'clear' | 'resolvable' | 'blocking';
  authority: AdaptiveAuthorityBoundary;
  risk: {
    level: 'low' | 'medium' | 'high' | 'critical';
    flags: string[];
  };
  budget: {
    maxNodeExecutions: number;
    maxRuntimeMs: number;
    maxCostUnits: number;
    maxRetries: number;
  };
  stopConditions: string[];
  contextRefs: string[];
  privacy: AdaptivePrivacyBoundary;
}

export interface AdaptiveEvidence {
  evidenceId: string;
  createdAt: string;
  evidenceClass: AdaptiveEvidenceClass;
  origin: AdaptiveEvidenceOrigin;
  source: string;
  claim: string;
  subject: string;
  predicate: string;
  value: string;
  confidence: number;
  freshness: AdaptiveEvidenceFreshness;
  scope: string;
  verification: 'unverified' | 'accepted' | 'verified' | 'rejected';
  supportsCriterionIds: string[];
  provenanceRefs: string[];
  privacy: AdaptivePrivacyBoundary;
}

export interface AdaptiveBeliefClaim {
  beliefId: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  predicate: string;
  value: string;
  scope: string;
  state:
    | 'hypothesis'
    | 'supported'
    | 'contradicted'
    | 'stale'
    | 'superseded'
    | 'unknown';
  confidence: number;
  freshness: AdaptiveEvidenceFreshness;
  testable: boolean;
  evidenceClass: AdaptiveEvidenceClass;
  provenanceRefs: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  contradictionIds: string[];
  supersedesBeliefId: string | null;
  privacy: AdaptivePrivacyBoundary;
}

export interface AdaptiveActionCandidate {
  actionId: string;
  title: string;
  purpose: string;
  toolId: string | null;
  actionClass: AdaptiveActionClass;
  mutationClass: AdaptiveMutationClass;
  approvalRequired: boolean;
  requiredEvidence: string[];
  producesCriterionIds: string[];
  expectedEvidenceClass: AdaptiveEvidenceClass;
  priority: number;
  maxAttempts: number;
  timeoutMs: number;
  preconditions?: string[];
  expectedObservation?: string;
  risk?: {
    level: 'low' | 'medium' | 'high' | 'critical';
    flags: string[];
  };
  verifier?: {
    kind: 'evidence_contract' | 'postcondition' | 'receipt';
    requirementIds: string[];
  };
  estimatedCostUnits?: number;
  alternativeForActionId?: string | null;
  recoveryForFailureClasses?: string[];
}

export interface AdaptivePlanNode {
  nodeId: string;
  createdAt: string;
  updatedAt: string;
  kind:
    | 'frame'
    | 'hypothesis'
    | 'clarify'
    | 'act'
    | 'recover'
    | 'resolve_contradiction'
    | 'verify'
    | 'finish';
  title: string;
  purpose: string;
  toolId: string | null;
  actionId: string | null;
  actionClass: AdaptiveActionClass;
  mutationClass: AdaptiveMutationClass;
  approvalRequired: boolean;
  dependencyIds: string[];
  status: AdaptivePlanNodeStatus;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  timeoutMs: number;
  preconditions: string[];
  expectedObservation: string;
  risk: {
    level: 'low' | 'medium' | 'high' | 'critical';
    flags: string[];
  };
  verifier: {
    kind: 'evidence_contract' | 'postcondition' | 'receipt';
    requirementIds: string[];
  };
  estimatedCostUnits: number;
  requiredEvidence: string[];
  producesCriterionIds: string[];
  expectedEvidenceClass: AdaptiveEvidenceClass;
  alternativeNodeIds: string[];
  recoveryForFailureClasses: string[];
  stopCondition: string;
  lastFailureClass: string | null;
  evidenceIds: string[];
}

export interface AdaptivePlanRevision {
  revisionId: string;
  createdAt: string;
  revision: number;
  kind:
    | 'initial'
    | 'retry'
    | 'replan'
    | 'clarify'
    | 'contradiction'
    | 'authority_stop'
    | 'budget_stop'
    | 'completion';
  reason: string;
  changedNodeIds: string[];
  evidenceRefs: string[];
}

export interface AdaptivePlanGraph {
  graphId: string;
  frameId: string;
  frameContractDigest: string;
  frameUnknownContractDigests: string[];
  planContractDigest: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  status: AdaptiveRunStatus;
  nodes: AdaptivePlanNode[];
  entryNodeId: string;
  verificationNodeId: string;
  completionNodeId: string;
  maxNodeExecutions: number;
  maxRuntimeMs: number;
  revisions: AdaptivePlanRevision[];
}

export interface AdaptiveNodeObservation {
  status: AdaptiveObservationStatus;
  summary: string;
  evidence: AdaptiveEvidence[];
  failureClass?: string | null;
  nextAction?: string | null;
  retryAfterMs?: number | null;
}

export interface AdaptiveNodeExecutionContext {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs: AdaptiveBeliefClaim[];
  evidence: AdaptiveEvidence[];
  executionIndex: number;
}

export type AdaptiveNodeExecutor = (
  node: Readonly<AdaptivePlanNode>,
  context: Readonly<AdaptiveNodeExecutionContext>,
) => AdaptiveNodeObservation;

export interface AdaptiveCriterionVerification {
  criterionId: string;
  satisfied: boolean;
  confidence: number;
  evidenceIds: string[];
  rejectedEvidenceIds: string[];
  reason: string;
}

export interface AdaptiveVerificationReport {
  status: 'pass' | 'warn' | 'block';
  criteria: AdaptiveCriterionVerification[];
  completionAuthorized: boolean;
  evidenceClassCounts: Record<AdaptiveEvidenceClass, number>;
  contradictions: string[];
  unsupportedCriterionIds: string[];
  reason: string;
}

export interface AdaptiveEngineTraceEvent {
  eventId: string;
  createdAt: string;
  eventKind:
    | 'frame'
    | 'select'
    | 'execute'
    | 'observe'
    | 'belief_update'
    | 'verify'
    | 'replan'
    | 'stop';
  nodeId: string | null;
  summary: string;
  refs: string[];
}

export interface AdaptiveCognitionRunResult {
  engineVersion: string;
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs: AdaptiveBeliefClaim[];
  evidence: AdaptiveEvidence[];
  verification: AdaptiveVerificationReport;
  trace: AdaptiveEngineTraceEvent[];
  status: AdaptiveRunStatus;
  nextAction: string;
  nodeExecutions: number;
  replans: number;
  retries: number;
  costUnitsUsed: number;
  unauthorizedMutationAttempts: number;
  falseCompletionPrevented: boolean;
  privacy: AdaptivePrivacyBoundary;
}

export interface CreateAdaptiveFrameInput {
  frameId?: string;
  createdAt?: string;
  objective: string;
  taskFamily: string;
  channel: string;
  route?: string | null;
  successCriteria?: Array<
    Partial<AdaptiveSuccessCriterion> &
      Pick<AdaptiveSuccessCriterion, 'description'>
  >;
  constraints?: string[];
  evidenceRequirements?: string[];
  assumptions?: string[];
  unknowns?: Array<
    Partial<AdaptiveUnknown> & Pick<AdaptiveUnknown, 'description'>
  >;
  authority?: Partial<AdaptiveAuthorityBoundary>;
  risk?: Partial<AdaptiveProblemFrame['risk']>;
  budget?: Partial<AdaptiveProblemFrame['budget']>;
  stopConditions?: string[];
  contextRefs?: string[];
}

export interface BuildAdaptivePlanInput {
  graphId?: string;
  createdAt?: string;
  frame: AdaptiveProblemFrame;
  actions: AdaptiveActionCandidate[];
  maxNodeExecutions?: number;
  maxRuntimeMs?: number;
}

export interface RunAdaptiveCognitionInput {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  executor: AdaptiveNodeExecutor;
  beliefs?: AdaptiveBeliefClaim[];
  evidence?: AdaptiveEvidence[];
  now?: () => string;
  /** Internal adapter bound. Omit for the normal run-to-stop behavior. */
  maxExternalNodeExecutions?: number;
}

export interface AdaptiveCognitionDirective {
  kind: 'execute_node' | 'terminal';
  node: AdaptivePlanNode | null;
  result: AdaptiveCognitionRunResult;
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = Number.isFinite(value)
    ? Math.floor(value as number)
    : fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function safeText(value: string | null | undefined, limit = 520): string {
  const normalized = redactCouncilText(String(value || ''), limit * 2)
    .replace(
      /\b(?:api[_-]?key|secret|password|passwd|pwd|private[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?[_-]?token|credential)\s*[:=]\s*\[REDACTED_SECRET\]/gi,
      '[redacted-secret]',
    )
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[redacted-ssn]')
    .replace(
      /\b(?:ssn|social security number)\s*(?:is|[:=])?\s*\d[\d -]{7,}\d\b/gi,
      '[redacted-ssn]',
    )
    .replace(
      /\b(?:patient\s+)?(?:diagnosis|medical condition|health condition|medical record)\s*(?:is|[:=])\s*[^,;.]+/gi,
      '[redacted-sensitive-medical]',
    )
    .replace(
      /\b(?:chain[- ]of[- ]thought|hidden reasoning|raw private body)\b/gi,
      '[redacted-sensitive-content]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, limit);
}

function safeRefs(values: string[] | undefined, limit = 40): string[] {
  return Array.from(
    new Set(
      (values || [])
        .map((value) => safeText(value, 180).replace(/[^A-Za-z0-9:_./-]/g, '_'))
        .filter(Boolean),
    ),
  ).slice(0, limit);
}

function cloneGraph(graph: AdaptivePlanGraph): AdaptivePlanGraph {
  const revisions = (graph.revisions || []).map((revision) => ({
    ...revision,
    changedNodeIds: [...(revision.changedNodeIds || [])],
    evidenceRefs: [...(revision.evidenceRefs || [])],
  }));
  return {
    ...graph,
    frameUnknownContractDigests: [...(graph.frameUnknownContractDigests || [])],
    revision: Number.isFinite(graph.revision)
      ? Math.max(0, Math.floor(graph.revision))
      : revisions.reduce(
          (highest, revision) => Math.max(highest, revision.revision || 0),
          0,
        ),
    maxNodeExecutions: Number.isFinite(graph.maxNodeExecutions)
      ? graph.maxNodeExecutions
      : 0,
    maxRuntimeMs: Number.isFinite(graph.maxRuntimeMs) ? graph.maxRuntimeMs : 0,
    nodes: (graph.nodes || []).map((node) => ({
      ...node,
      dependencyIds: [...(node.dependencyIds || [])],
      requiredEvidence: [...(node.requiredEvidence || [])],
      preconditions: [...(node.preconditions || [])],
      risk: {
        level: node.risk?.level || 'medium',
        flags: [...(node.risk?.flags || [])],
      },
      verifier: {
        kind: node.verifier?.kind || 'evidence_contract',
        requirementIds: [...(node.verifier?.requirementIds || [])],
      },
      producesCriterionIds: [...(node.producesCriterionIds || [])],
      alternativeNodeIds: [...(node.alternativeNodeIds || [])],
      recoveryForFailureClasses: [...(node.recoveryForFailureClasses || [])],
      evidenceIds: [...(node.evidenceIds || [])],
    })),
    revisions,
  };
}

function sortedContractRefs(values: string[] | undefined): string[] {
  return [...new Set(values || [])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function unknownContractDigest(unknown: AdaptiveUnknown): string {
  return hashId(
    'adaptive:unknown-contract',
    JSON.stringify({
      unknownId: unknown.unknownId,
      description: unknown.description,
      impact: unknown.impact,
      resolvableBy: sortedContractRefs(unknown.resolvableBy),
    }),
  );
}

function frameContractDigestFor(frame: AdaptiveProblemFrame): string {
  const immutableContextRefs = (frame.contextRefs || []).filter((ref) =>
    /^(?:target:|receipt_required:)/.test(ref),
  );
  return hashId(
    'adaptive:frame-contract',
    JSON.stringify({
      frameId: frame.frameId,
      createdAt: frame.createdAt,
      objective: frame.objective,
      taskFamily: frame.taskFamily,
      channel: frame.channel,
      route: frame.route,
      successCriteria: [...(frame.successCriteria || [])]
        .sort((left, right) =>
          left.criterionId.localeCompare(right.criterionId),
        )
        .map((criterion) => ({
          criterionId: criterion.criterionId,
          description: criterion.description,
          requiredEvidenceClasses: sortedContractRefs(
            criterion.requiredEvidenceClasses,
          ),
          minimumConfidence: criterion.minimumConfidence,
          required: criterion.required,
        })),
      constraints: sortedContractRefs(frame.constraints || []),
      evidenceRequirements: sortedContractRefs(
        frame.evidenceRequirements || [],
      ),
      assumptions: sortedContractRefs(frame.assumptions || []),
      authority: {
        actorScope: frame.authority?.actorScope,
        maximumActionClass: frame.authority?.maximumActionClass,
        mutationApprovalRequired: frame.authority?.mutationApprovalRequired,
        inheritedAuthorityForbidden:
          frame.authority?.inheritedAuthorityForbidden,
      },
      risk: {
        level: frame.risk?.level,
        flags: sortedContractRefs(frame.risk?.flags || []),
      },
      budget: frame.budget,
      stopConditions: sortedContractRefs(frame.stopConditions || []),
      immutableContextRefs: sortedContractRefs(immutableContextRefs),
      privacy: frame.privacy,
    }),
  );
}

function planContractDigestFor(graph: AdaptivePlanGraph): string {
  return hashId(
    'adaptive:plan-contract',
    JSON.stringify({
      graphId: graph.graphId,
      frameId: graph.frameId,
      frameContractDigest: graph.frameContractDigest,
      frameUnknownContractDigests: sortedContractRefs(
        graph.frameUnknownContractDigests,
      ),
      entryNodeId: graph.entryNodeId,
      verificationNodeId: graph.verificationNodeId,
      completionNodeId: graph.completionNodeId,
      maxNodeExecutions: graph.maxNodeExecutions,
      maxRuntimeMs: graph.maxRuntimeMs,
      nodes: [...graph.nodes]
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
        .map((node) => ({
          nodeId: node.nodeId,
          kind: node.kind,
          title: node.title,
          purpose: node.purpose,
          toolId: node.toolId,
          actionId: node.actionId,
          actionClass: node.actionClass,
          mutationClass: node.mutationClass,
          approvalRequired: node.approvalRequired,
          dependencyIds: sortedContractRefs(node.dependencyIds),
          priority: node.priority,
          maxAttempts: node.maxAttempts,
          timeoutMs: node.timeoutMs,
          preconditions: sortedContractRefs(node.preconditions),
          expectedObservation: node.expectedObservation,
          risk: {
            level: node.risk.level,
            flags: sortedContractRefs(node.risk.flags),
          },
          verifier: {
            kind: node.verifier.kind,
            requirementIds: sortedContractRefs(node.verifier.requirementIds),
          },
          estimatedCostUnits: node.estimatedCostUnits,
          requiredEvidence: sortedContractRefs(node.requiredEvidence),
          producesCriterionIds: sortedContractRefs(node.producesCriterionIds),
          expectedEvidenceClass: node.expectedEvidenceClass,
          alternativeNodeIds: sortedContractRefs(node.alternativeNodeIds),
          recoveryForFailureClasses: sortedContractRefs(
            node.recoveryForFailureClasses,
          ),
          stopCondition: node.stopCondition,
        })),
    }),
  );
}

function validateGraphForFrame(
  frame: AdaptiveProblemFrame,
  graph: AdaptivePlanGraph,
): string[] {
  const issues: string[] = [];
  const successCriteria = Array.isArray(frame.successCriteria)
    ? frame.successCriteria
    : [];
  const requiredCriteria = successCriteria.filter(
    (criterion) => criterion.required,
  );
  if (requiredCriteria.length === 0) {
    issues.push('missing_required_success_criteria');
  }
  const criterionIds = successCriteria
    .map((criterion) => criterion.criterionId)
    .filter(Boolean);
  if (
    criterionIds.length !== frame.successCriteria.length ||
    new Set(criterionIds).size !== criterionIds.length
  ) {
    issues.push('invalid_or_duplicate_criterion_identity');
  }
  if (
    !frame.authority ||
    !frame.risk ||
    !Array.isArray(frame.evidenceRequirements) ||
    !Array.isArray(frame.stopConditions) ||
    !Array.isArray(frame.contextRefs)
  ) {
    issues.push('incomplete_frame_contract');
  }
  if (graph.frameContractDigest !== frameContractDigestFor(frame)) {
    issues.push('frame_contract_digest_mismatch');
  }
  const originalUnknownContracts = new Set(
    graph.frameUnknownContractDigests || [],
  );
  if (
    (frame.unknowns || []).some(
      (unknown) =>
        !originalUnknownContracts.has(unknownContractDigest(unknown)),
    )
  ) {
    issues.push('unknown_contract_expansion_or_mutation');
  }
  if (!graph.graphId) issues.push('missing_graph_id');
  if (graph.frameId !== frame.frameId) issues.push('frame_identity_mismatch');
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    issues.push('missing_plan_nodes');
    return issues;
  }
  if (!(graph.maxNodeExecutions > 0) || !(graph.maxRuntimeMs > 0)) {
    issues.push('invalid_execution_budget');
  }
  const frameBudget = frame.budget;
  if (
    !frameBudget ||
    !(frameBudget.maxNodeExecutions > 0) ||
    !(frameBudget.maxRuntimeMs > 0) ||
    !(frameBudget.maxCostUnits > 0) ||
    !(frameBudget.maxRetries >= 0)
  ) {
    issues.push('invalid_frame_budget');
  } else {
    if (
      graph.maxNodeExecutions > frameBudget.maxNodeExecutions ||
      graph.maxRuntimeMs > frameBudget.maxRuntimeMs
    ) {
      issues.push('plan_exceeds_frame_budget');
    }
  }
  const nodeIds = graph.nodes.map((node) => node.nodeId).filter(Boolean);
  const uniqueNodeIds = new Set(nodeIds);
  if (
    nodeIds.length !== graph.nodes.length ||
    uniqueNodeIds.size !== nodeIds.length
  ) {
    issues.push('invalid_or_duplicate_node_identity');
  }
  const entry = graph.nodes.find((node) => node.nodeId === graph.entryNodeId);
  const verifier = graph.nodes.find(
    (node) => node.nodeId === graph.verificationNodeId,
  );
  const completion = graph.nodes.find(
    (node) => node.nodeId === graph.completionNodeId,
  );
  if (!entry) issues.push('missing_entry_node');
  if (verifier?.kind !== 'verify') issues.push('invalid_verification_node');
  if (completion?.kind !== 'finish') issues.push('invalid_completion_node');
  for (const node of graph.nodes) {
    if (
      !node.expectedObservation ||
      !node.stopCondition ||
      !node.verifier ||
      !(node.estimatedCostUnits >= 0)
    ) {
      issues.push('incomplete_node_contract');
    }
    if (
      node.producesCriterionIds.some(
        (criterionId) => !criterionIds.includes(criterionId),
      )
    ) {
      issues.push('node_references_unknown_criterion');
    }
    if (
      (node.mutationClass !== 'none' || node.actionClass === 'mutation') &&
      node.producesCriterionIds.some(
        (criterionId) =>
          !(frame.contextRefs || []).includes(
            `receipt_required:${criterionId}`,
          ),
      )
    ) {
      issues.push('effect_node_missing_receipt_contract');
    }
    if (
      [...node.dependencyIds, ...node.alternativeNodeIds].some(
        (nodeId) => !uniqueNodeIds.has(nodeId),
      )
    ) {
      issues.push('dangling_node_reference');
      break;
    }
  }
  if (graph.planContractDigest !== planContractDigestFor(graph)) {
    issues.push('plan_contract_digest_mismatch');
  }
  return Array.from(new Set(issues));
}

/** Public fail-closed validation for persistence and execution adapters. */
export function validateAdaptivePlanGraph(
  frame: AdaptiveProblemFrame,
  graph: AdaptivePlanGraph,
): string[] {
  return validateGraphForFrame(frame, cloneGraph(graph));
}

function evidenceClassCounts(
  evidence: AdaptiveEvidence[],
): Record<AdaptiveEvidenceClass, number> {
  const result: Record<AdaptiveEvidenceClass, number> = {
    observed: 0,
    user_attested: 0,
    inferred: 0,
    simulated: 0,
    model_generated: 0,
  };
  for (const item of evidence) result[item.evidenceClass] += 1;
  return result;
}

function normalizedEvidence(
  evidence: AdaptiveEvidence,
  now: string,
): AdaptiveEvidence {
  return {
    evidenceId:
      safeText(evidence.evidenceId, 180) ||
      hashId(
        'adaptive:evidence',
        `${evidence.source}|${evidence.subject}|${evidence.predicate}|${evidence.value}|${now}`,
      ),
    createdAt: evidence.createdAt || now,
    evidenceClass: evidence.evidenceClass,
    origin: ['live', 'replay', 'synthetic'].includes(evidence.origin)
      ? evidence.origin
      : 'synthetic',
    source: safeText(evidence.source, 160),
    claim: safeText(evidence.claim, 360),
    subject: safeText(evidence.subject, 180),
    predicate: safeText(evidence.predicate, 180),
    value: safeText(evidence.value, 360),
    confidence: clamp01(evidence.confidence),
    freshness: evidence.freshness,
    scope: safeText(evidence.scope, 180),
    verification: evidence.verification,
    supportsCriterionIds: safeRefs(evidence.supportsCriterionIds),
    provenanceRefs: safeRefs(evidence.provenanceRefs),
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

function evidenceCanComplete(
  evidence: AdaptiveEvidence,
  criterion: AdaptiveSuccessCriterion,
  frame?: AdaptiveProblemFrame,
): boolean {
  if (!criterion.requiredEvidenceClasses.includes(evidence.evidenceClass)) {
    return false;
  }
  if (evidence.freshness !== 'fresh') return false;
  if (!['accepted', 'verified'].includes(evidence.verification)) return false;
  if (evidence.confidence < criterion.minimumConfidence) return false;
  if (frame) {
    const criterionTargetPrefix = `target:${criterion.criterionId}:`;
    const exactTarget =
      frame.contextRefs
        .find((ref) => ref.startsWith(criterionTargetPrefix))
        ?.slice(criterionTargetPrefix.length) ||
      frame.contextRefs
        .find(
          (ref) =>
            ref.startsWith('target:') &&
            !frame.successCriteria.some((item) =>
              ref.startsWith(`target:${item.criterionId}:`),
            ),
        )
        ?.slice('target:'.length);
    if (exactTarget) {
      if (evidence.subject !== exactTarget) return false;
      if (evidence.scope !== frame.authority.actorScope) return false;
    }
    const receiptRequired = frame.contextRefs.includes(
      `receipt_required:${criterion.criterionId}`,
    );
    if (
      receiptRequired &&
      !evidence.provenanceRefs.some((ref) =>
        /^(?:receipt|effect_receipt|verification_receipt):/i.test(ref),
      )
    ) {
      return false;
    }
  }
  return evidence.supportsCriterionIds.includes(criterion.criterionId);
}

export function createAdaptiveProblemFrame(
  input: CreateAdaptiveFrameInput,
): AdaptiveProblemFrame {
  const createdAt = input.createdAt || new Date().toISOString();
  const frameSeed = `${input.taskFamily}|${input.channel}|${input.route || ''}|${safeText(input.objective, 800)}|${createdAt}`;
  const successCriteria = (
    input.successCriteria?.length
      ? input.successCriteria
      : [
          {
            description:
              'The requested outcome is supported by fresh external or user-attested evidence.',
          },
          {
            description:
              'Safety, authority, and approval boundaries remain satisfied.',
          },
        ]
  ).map(
    (criterion, index): AdaptiveSuccessCriterion => ({
      criterionId:
        safeText(criterion.criterionId, 180) ||
        hashId(
          'adaptive:criterion',
          `${frameSeed}|${index}|${criterion.description}`,
        ),
      description: safeText(criterion.description, 420),
      requiredEvidenceClasses: criterion.requiredEvidenceClasses?.length
        ? Array.from(new Set(criterion.requiredEvidenceClasses))
        : ['observed', 'user_attested'],
      minimumConfidence: clamp01(criterion.minimumConfidence ?? 0.65),
      required: criterion.required ?? true,
    }),
  );
  const unknowns = (input.unknowns || []).map(
    (unknown, index): AdaptiveUnknown => ({
      unknownId:
        safeText(unknown.unknownId, 180) ||
        hashId(
          'adaptive:unknown',
          `${frameSeed}|${index}|${unknown.description}`,
        ),
      description: safeText(unknown.description, 360),
      impact: unknown.impact || 'degrading',
      resolvableBy: safeRefs(unknown.resolvableBy),
    }),
  );
  const ambiguity = unknowns.some((unknown) => unknown.impact === 'blocking')
    ? 'blocking'
    : unknowns.length > 0
      ? 'resolvable'
      : 'clear';
  const authority: AdaptiveAuthorityBoundary = {
    actorScope: safeText(input.authority?.actorScope || 'current_turn', 180),
    maximumActionClass: input.authority?.maximumActionClass || 'read_only',
    approvedActionIds: safeRefs(input.authority?.approvedActionIds),
    mutationApprovalRequired: true,
    inheritedAuthorityForbidden: true,
  };
  const budget: AdaptiveProblemFrame['budget'] = {
    maxNodeExecutions: boundedInteger(
      input.budget?.maxNodeExecutions,
      24,
      1,
      64,
    ),
    maxRuntimeMs: boundedInteger(
      input.budget?.maxRuntimeMs,
      15_000,
      500,
      120_000,
    ),
    maxCostUnits: boundedInteger(input.budget?.maxCostUnits, 100, 1, 10_000),
    maxRetries: boundedInteger(input.budget?.maxRetries, 6, 0, 16),
  };
  return {
    frameId: input.frameId || hashId('adaptive:frame', frameSeed),
    createdAt,
    objective: safeText(input.objective, 800),
    taskFamily: safeText(input.taskFamily, 120),
    channel: safeText(input.channel, 80),
    route: input.route ? safeText(input.route, 180) : null,
    successCriteria,
    constraints: (input.constraints || []).map((item) => safeText(item, 360)),
    evidenceRequirements:
      safeRefs(input.evidenceRequirements).length > 0
        ? safeRefs(input.evidenceRequirements)
        : ['fresh_typed_evidence', 'original_definition_of_done'],
    assumptions: (input.assumptions || []).map((item) => safeText(item, 360)),
    unknowns,
    ambiguity,
    authority,
    risk: {
      level: input.risk?.level || 'medium',
      flags: safeRefs(input.risk?.flags),
    },
    budget,
    stopConditions:
      safeRefs(input.stopConditions).length > 0
        ? safeRefs(input.stopConditions)
        : [
            'verified_definition_of_done',
            'authority_boundary',
            'budget_exhausted',
            'blocking_ambiguity',
          ],
    contextRefs: safeRefs(input.contextRefs),
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

function internalNode(input: {
  frame: AdaptiveProblemFrame;
  createdAt: string;
  suffix: string;
  kind: AdaptivePlanNode['kind'];
  title: string;
  purpose: string;
  actionClass: AdaptiveActionClass;
  dependencies?: string[];
  priority: number;
}): AdaptivePlanNode {
  return {
    nodeId: hashId('adaptive:node', `${input.frame.frameId}|${input.suffix}`),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    kind: input.kind,
    title: input.title,
    purpose: input.purpose,
    toolId: null,
    actionId: null,
    actionClass: input.actionClass,
    mutationClass: 'none',
    approvalRequired: false,
    dependencyIds: input.dependencies || [],
    status: 'pending',
    priority: input.priority,
    attemptCount: 0,
    maxAttempts: 1,
    timeoutMs: 1_000,
    preconditions: safeRefs(input.dependencies),
    expectedObservation:
      input.kind === 'verify'
        ? 'A criterion-by-criterion admissible evidence verdict.'
        : input.kind === 'finish'
          ? 'A completion authorization bound to the original frame contract.'
          : input.kind === 'clarify'
            ? 'A concrete answer or an explicit blocking ambiguity.'
            : 'A typed, privacy-safe cognition state transition.',
    risk: {
      level: input.frame.risk.level,
      flags: [...input.frame.risk.flags],
    },
    verifier: {
      kind: input.kind === 'finish' ? 'postcondition' : 'evidence_contract',
      requirementIds:
        input.kind === 'verify' || input.kind === 'finish'
          ? input.frame.successCriteria.map(
              (criterion) => criterion.criterionId,
            )
          : [],
    },
    estimatedCostUnits: input.kind === 'finish' ? 0 : 1,
    requiredEvidence: [],
    producesCriterionIds: [],
    expectedEvidenceClass: 'model_generated',
    alternativeNodeIds: [],
    recoveryForFailureClasses: [],
    stopCondition: 'Advance only after this node has an explicit result.',
    lastFailureClass: null,
    evidenceIds: [],
  };
}

export function buildAdaptivePlanGraph(
  input: BuildAdaptivePlanInput,
): AdaptivePlanGraph {
  const createdAt = input.createdAt || input.frame.createdAt;
  const normalizedActionIds = input.actions.map(
    (action) => safeRefs([action.actionId], 1)[0] || '',
  );
  if (
    normalizedActionIds.some((actionId) => !actionId) ||
    new Set(normalizedActionIds).size !== normalizedActionIds.length
  ) {
    throw new Error(
      'Adaptive plan action identifiers must be non-empty and unique after normalization.',
    );
  }
  const frameNode = internalNode({
    frame: input.frame,
    createdAt,
    suffix: 'frame',
    kind: 'frame',
    title: 'Frame objective, constraints, authority, and unknowns',
    purpose: 'Bind the request to an explicit problem frame before action.',
    actionClass: 'reasoning',
    priority: 1,
  });
  const hypothesisNode = internalNode({
    frame: input.frame,
    createdAt,
    suffix: 'hypothesis',
    kind: 'hypothesis',
    title: 'Form testable route hypotheses',
    purpose:
      'Choose evidence-gathering actions without treating inference as proof.',
    actionClass: 'reasoning',
    dependencies: [frameNode.nodeId],
    priority: 0.95,
  });
  const clarifyNode = input.frame.unknowns.some(
    (unknown) => unknown.impact === 'blocking',
  )
    ? internalNode({
        frame: input.frame,
        createdAt,
        suffix: 'clarify',
        kind: 'clarify',
        title: 'Resolve a blocking ambiguity',
        purpose:
          'Ask one concrete question before selecting a consequential target.',
        actionClass: 'clarification',
        dependencies: [hypothesisNode.nodeId],
        priority: 1,
      })
    : null;
  const actionRoot = clarifyNode?.nodeId || hypothesisNode.nodeId;
  const actionNodes = input.actions.map(
    (action, index): AdaptivePlanNode => ({
      nodeId: hashId(
        'adaptive:node',
        `${input.frame.frameId}|action|${normalizedActionIds[index]}|${index}`,
      ),
      createdAt,
      updatedAt: createdAt,
      kind: action.alternativeForActionId ? 'recover' : 'act',
      title: safeText(action.title, 300),
      purpose: safeText(action.purpose, 420),
      toolId: action.toolId ? safeText(action.toolId, 180) : null,
      actionId: normalizedActionIds[index],
      actionClass: action.actionClass,
      mutationClass: action.mutationClass,
      approvalRequired: action.approvalRequired,
      dependencyIds: [actionRoot],
      status: action.alternativeForActionId ? 'dormant' : 'pending',
      priority: clamp01(action.priority),
      attemptCount: 0,
      maxAttempts: Math.max(
        1,
        Math.min(3, Math.floor(action.maxAttempts || 1)),
      ),
      timeoutMs: Math.max(100, Math.min(120_000, action.timeoutMs || 10_000)),
      preconditions: safeRefs(action.preconditions),
      expectedObservation:
        safeText(action.expectedObservation, 420) ||
        'Fresh typed evidence, a named failure class, or an authority stop.',
      risk: {
        level: action.risk?.level || input.frame.risk.level,
        flags: safeRefs(action.risk?.flags || input.frame.risk.flags),
      },
      verifier: {
        kind:
          action.verifier?.kind ||
          (action.mutationClass !== 'none' ? 'receipt' : 'evidence_contract'),
        requirementIds:
          safeRefs(action.verifier?.requirementIds).length > 0
            ? safeRefs(action.verifier?.requirementIds)
            : safeRefs([
                ...action.requiredEvidence,
                ...action.producesCriterionIds,
              ]),
      },
      estimatedCostUnits: Math.max(
        0,
        Math.min(
          input.frame.budget.maxCostUnits,
          Number.isFinite(action.estimatedCostUnits)
            ? (action.estimatedCostUnits as number)
            : 5,
        ),
      ),
      requiredEvidence: safeRefs(action.requiredEvidence),
      producesCriterionIds: safeRefs(action.producesCriterionIds),
      expectedEvidenceClass: action.expectedEvidenceClass,
      alternativeNodeIds: [],
      recoveryForFailureClasses: safeRefs(action.recoveryForFailureClasses),
      stopCondition:
        action.approvalRequired || action.mutationClass !== 'none'
          ? 'Stop before mutation unless this exact action has current approval.'
          : 'Stop when fresh typed evidence is recorded or a named blocker is reached.',
      lastFailureClass: null,
      evidenceIds: [],
    }),
  );
  const byAction = new Map(
    actionNodes
      .filter((node) => node.actionId)
      .map((node) => [node.actionId as string, node]),
  );
  input.actions.forEach((action, index) => {
    if (!action.alternativeForActionId) return;
    const normalizedAlternativeFor =
      safeRefs([action.alternativeForActionId], 1)[0] || '';
    const primary = byAction.get(normalizedAlternativeFor);
    if (primary) primary.alternativeNodeIds.push(actionNodes[index].nodeId);
  });
  const primaryActionNodes = actionNodes.filter(
    (node) => node.status !== 'dormant',
  );
  const verificationNode = internalNode({
    frame: input.frame,
    createdAt,
    suffix: 'verify',
    kind: 'verify',
    title: 'Verify outcome against success criteria',
    purpose:
      'Reject unsupported completion and separate observation from inference.',
    actionClass: 'verification',
    dependencies: primaryActionNodes.length
      ? primaryActionNodes.map((node) => node.nodeId)
      : [actionRoot],
    priority: 0.9,
  });
  const completionNode = internalNode({
    frame: input.frame,
    createdAt,
    suffix: 'finish',
    kind: 'finish',
    title: 'Commit verified completion state',
    purpose:
      'Finish only when every required success criterion has admissible proof.',
    actionClass: 'completion',
    dependencies: [verificationNode.nodeId],
    priority: 0.8,
  });
  const nodes = [
    frameNode,
    hypothesisNode,
    ...(clarifyNode ? [clarifyNode] : []),
    ...actionNodes,
    verificationNode,
    completionNode,
  ];
  const graphId =
    input.graphId ||
    hashId('adaptive:graph', `${input.frame.frameId}|${createdAt}`);
  const requestedNodeBudget = boundedInteger(
    input.maxNodeExecutions,
    Math.max(12, nodes.length + 6),
    1,
    64,
  );
  const requestedRuntimeBudget = boundedInteger(
    input.maxRuntimeMs,
    15_000,
    500,
    120_000,
  );
  const graph: AdaptivePlanGraph = {
    graphId,
    frameId: input.frame.frameId,
    frameContractDigest: frameContractDigestFor(input.frame),
    frameUnknownContractDigests: input.frame.unknowns.map(
      unknownContractDigest,
    ),
    planContractDigest: '',
    createdAt,
    updatedAt: createdAt,
    revision: 1,
    status: 'active',
    nodes,
    entryNodeId: frameNode.nodeId,
    verificationNodeId: verificationNode.nodeId,
    completionNodeId: completionNode.nodeId,
    maxNodeExecutions: Math.min(
      input.frame.budget.maxNodeExecutions,
      Math.max(nodes.length, requestedNodeBudget),
    ),
    maxRuntimeMs: Math.min(
      input.frame.budget.maxRuntimeMs,
      requestedRuntimeBudget,
    ),
    revisions: [
      {
        revisionId: hashId('adaptive:revision', `${graphId}|initial`),
        createdAt,
        revision: 1,
        kind: 'initial',
        reason:
          'Initial dynamic plan compiled from the explicit problem frame.',
        changedNodeIds: nodes.map((node) => node.nodeId),
        evidenceRefs: [],
      },
    ],
  };
  graph.planContractDigest = planContractDigestFor(graph);
  return graph;
}

/** Reopens only the verifier/finalizer after new evidence is appended. */
export function reopenAdaptivePlanForEvidence(
  plan: AdaptivePlanGraph,
  updatedAt = new Date().toISOString(),
): AdaptivePlanGraph {
  const graph = cloneGraph(plan);
  const verifier = graph.nodes.find(
    (node) => node.nodeId === graph.verificationNodeId,
  );
  const finisher = graph.nodes.find(
    (node) => node.nodeId === graph.completionNodeId,
  );
  if (verifier) {
    verifier.status = 'pending';
    verifier.lastFailureClass = null;
    verifier.updatedAt = updatedAt;
  }
  if (finisher) {
    finisher.status = 'pending';
    finisher.lastFailureClass = null;
    finisher.updatedAt = updatedAt;
  }
  graph.status = 'active';
  addRevision(graph, {
    createdAt: updatedAt,
    kind: 'replan',
    reason:
      'Fresh evidence reopened the verifier without replaying completed action nodes.',
    changedNodeIds: [verifier?.nodeId, finisher?.nodeId].filter(
      (value): value is string => Boolean(value),
    ),
    evidenceRefs: [],
  });
  return graph;
}

/**
 * Resumes only stop nodes that an authoritative caller has already resolved
 * in an updated frame. This function does not add approval or remove an
 * unknown; it merely consumes those caller-supplied frame changes.
 */
export function resumeAdaptivePlanForUpdatedFrame(
  frame: AdaptiveProblemFrame,
  plan: AdaptivePlanGraph,
  updatedAt = new Date().toISOString(),
): AdaptivePlanGraph {
  const graph = cloneGraph(plan);
  const issues = validateGraphForFrame(frame, graph);
  if (issues.length > 0) {
    throw new Error(
      `Adaptive plan resume rejected invalid identity: ${issues.join(',')}.`,
    );
  }
  const changedNodeIds: string[] = [];
  const clarificationResolved =
    frame.ambiguity !== 'blocking' &&
    !frame.unknowns.some((unknown) => unknown.impact === 'blocking');
  for (const node of graph.nodes) {
    if (
      node.status === 'awaiting_approval' &&
      node.actionId &&
      frame.authority.approvedActionIds.includes(node.actionId)
    ) {
      node.status = 'pending';
      node.updatedAt = updatedAt;
      node.lastFailureClass = null;
      changedNodeIds.push(node.nodeId);
    } else if (
      node.status === 'awaiting_clarification' &&
      clarificationResolved
    ) {
      node.status = 'succeeded';
      node.updatedAt = updatedAt;
      node.lastFailureClass = null;
      changedNodeIds.push(node.nodeId);
    }
  }
  if (changedNodeIds.length > 0) {
    graph.status = 'active';
    addRevision(graph, {
      createdAt: updatedAt,
      kind: 'replan',
      reason:
        'An authoritative updated frame resolved an approval or clarification stop without replaying completed nodes.',
      changedNodeIds,
      evidenceRefs: [],
    });
  }
  return graph;
}

function addRevision(
  graph: AdaptivePlanGraph,
  input: Omit<AdaptivePlanRevision, 'revisionId' | 'revision'>,
): void {
  graph.revision += 1;
  graph.updatedAt = input.createdAt;
  graph.revisions.push({
    ...input,
    revision: graph.revision,
    revisionId: hashId(
      'adaptive:revision',
      `${graph.graphId}|${graph.revision}|${input.kind}|${input.reason}`,
    ),
  });
}

function traceEvent(
  trace: AdaptiveEngineTraceEvent[],
  input: Omit<AdaptiveEngineTraceEvent, 'eventId'>,
): void {
  trace.push({
    ...input,
    eventId: hashId(
      'adaptive:event',
      `${input.createdAt}|${input.eventKind}|${input.nodeId || ''}|${trace.length}|${input.summary}`,
    ),
    summary: safeText(input.summary, 420),
    refs: safeRefs(input.refs),
  });
}

function dependencySatisfied(status: AdaptivePlanNodeStatus): boolean {
  return ['succeeded', 'degraded', 'superseded'].includes(status);
}

function refreshReadyNodes(graph: AdaptivePlanGraph, now: string): void {
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  for (const node of graph.nodes) {
    if (node.status !== 'pending') continue;
    if (
      node.dependencyIds.every((dependencyId) => {
        const dependency = byId.get(dependencyId);
        return dependency ? dependencySatisfied(dependency.status) : false;
      })
    ) {
      node.status = 'ready';
      node.updatedAt = now;
    }
  }
}

function nextReadyNode(graph: AdaptivePlanGraph): AdaptivePlanNode | null {
  return (
    graph.nodes
      .filter((node) => node.status === 'ready')
      .sort(
        (a, b) =>
          b.priority - a.priority || a.createdAt.localeCompare(b.createdAt),
      )[0] || null
  );
}

function authorityAllows(
  frame: AdaptiveProblemFrame,
  node: AdaptivePlanNode,
): { allowed: boolean; approvalMissing: boolean; reason: string } {
  const exactApproval = Boolean(
    node.actionId && frame.authority.approvedActionIds.includes(node.actionId),
  );
  if (node.mutationClass !== 'none' || node.actionClass === 'mutation') {
    if (frame.authority.maximumActionClass !== 'approval_gated_mutation') {
      return {
        allowed: false,
        approvalMissing: false,
        reason: 'Mutation exceeds the frame authority boundary.',
      };
    }
    if (!exactApproval) {
      return {
        allowed: false,
        approvalMissing: true,
        reason: 'The exact mutating action lacks current explicit approval.',
      };
    }
  }
  if (node.approvalRequired && !exactApproval) {
    return {
      allowed: false,
      approvalMissing: true,
      reason: 'The exact action requires current explicit approval.',
    };
  }
  if (
    frame.authority.maximumActionClass === 'reasoning_only' &&
    !['reasoning', 'clarification', 'verification', 'completion'].includes(
      node.actionClass,
    )
  ) {
    return {
      allowed: false,
      approvalMissing: false,
      reason: 'Tool use exceeds reasoning-only authority.',
    };
  }
  if (
    frame.authority.maximumActionClass === 'read_only' &&
    ['draft', 'approval_gate', 'mutation'].includes(node.actionClass)
  ) {
    return {
      allowed: false,
      approvalMissing: node.approvalRequired,
      reason: 'Action exceeds read-only authority.',
    };
  }
  if (
    frame.authority.maximumActionClass === 'draft_only' &&
    ['approval_gate', 'mutation'].includes(node.actionClass)
  ) {
    return {
      allowed: false,
      approvalMissing: node.approvalRequired,
      reason: 'Action exceeds draft-only authority.',
    };
  }
  return { allowed: true, approvalMissing: false, reason: 'allowed' };
}

export function reconcileAdaptiveBeliefs(input: {
  beliefs: AdaptiveBeliefClaim[];
  evidence: AdaptiveEvidence[];
  now: string;
}): { beliefs: AdaptiveBeliefClaim[]; contradictionIds: string[] } {
  const beliefs = input.beliefs.map((belief) => ({
    ...belief,
    provenanceRefs: [...belief.provenanceRefs],
    supportingEvidenceIds: [...(belief.supportingEvidenceIds || [])],
    contradictingEvidenceIds: [...(belief.contradictingEvidenceIds || [])],
    contradictionIds: [...belief.contradictionIds],
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  }));
  const contradictionIds: string[] = [];
  for (const evidence of input.evidence) {
    if (!evidence.subject || !evidence.predicate) continue;
    const admissibleSupport =
      ['observed', 'user_attested'].includes(evidence.evidenceClass) &&
      ['accepted', 'verified'].includes(evidence.verification) &&
      evidence.freshness === 'fresh';
    const keyMatch = beliefs.filter(
      (belief) =>
        belief.subject === evidence.subject &&
        belief.predicate === evidence.predicate &&
        belief.scope === evidence.scope &&
        belief.state !== 'superseded',
    );
    const matching = keyMatch.find((belief) => belief.value === evidence.value);
    if (matching) {
      matching.updatedAt = input.now;
      matching.freshness = evidence.freshness;
      matching.evidenceClass = evidence.evidenceClass;
      matching.provenanceRefs = safeRefs([
        ...matching.provenanceRefs,
        evidence.evidenceId,
        ...evidence.provenanceRefs,
      ]);
      if (admissibleSupport) {
        matching.supportingEvidenceIds = safeRefs([
          ...matching.supportingEvidenceIds,
          evidence.evidenceId,
        ]);
        matching.confidence = clamp01(
          1 - (1 - matching.confidence) * (1 - evidence.confidence * 0.75),
        );
        if (matching.state !== 'contradicted') matching.state = 'supported';
      } else if (evidence.freshness === 'stale') {
        if (!['contradicted', 'superseded'].includes(matching.state)) {
          matching.state = 'stale';
        }
      } else if (evidence.verification === 'rejected') {
        matching.contradictingEvidenceIds = safeRefs([
          ...matching.contradictingEvidenceIds,
          evidence.evidenceId,
        ]);
        if (matching.state !== 'supported') matching.state = 'unknown';
      } else if (matching.state !== 'supported') {
        matching.state = 'hypothesis';
      }
      continue;
    }
    const beliefId = hashId(
      'adaptive:belief',
      `${evidence.scope}|${evidence.subject}|${evidence.predicate}|${evidence.value}|${evidence.evidenceId}`,
    );
    const contradictory = admissibleSupport
      ? keyMatch.filter(
          (belief) =>
            belief.value !== evidence.value &&
            belief.confidence >= 0.5 &&
            evidence.confidence >= 0.5,
        )
      : [];
    const belief: AdaptiveBeliefClaim = {
      beliefId,
      createdAt: input.now,
      updatedAt: input.now,
      subject: evidence.subject,
      predicate: evidence.predicate,
      value: evidence.value,
      scope: evidence.scope,
      state:
        contradictory.length > 0
          ? 'contradicted'
          : evidence.freshness === 'stale'
            ? 'stale'
            : admissibleSupport
              ? 'supported'
              : evidence.verification === 'rejected'
                ? 'unknown'
                : 'hypothesis',
      confidence: evidence.confidence,
      freshness: evidence.freshness,
      testable: Boolean(evidence.subject && evidence.predicate),
      evidenceClass: evidence.evidenceClass,
      provenanceRefs: safeRefs([
        evidence.evidenceId,
        ...evidence.provenanceRefs,
      ]),
      supportingEvidenceIds: admissibleSupport ? [evidence.evidenceId] : [],
      contradictingEvidenceIds: safeRefs(
        contradictory.flatMap((item) => item.supportingEvidenceIds || []),
      ),
      contradictionIds: contradictory.map((item) => item.beliefId),
      supersedesBeliefId: null,
      privacy: ADAPTIVE_COGNITION_PRIVACY,
    };
    for (const prior of contradictory) {
      prior.state = 'contradicted';
      prior.updatedAt = input.now;
      prior.contradictionIds = safeRefs([
        ...prior.contradictionIds,
        belief.beliefId,
      ]);
      prior.contradictingEvidenceIds = safeRefs([
        ...prior.contradictingEvidenceIds,
        evidence.evidenceId,
      ]);
      contradictionIds.push(prior.beliefId, belief.beliefId);
    }
    beliefs.push(belief);
  }
  return { beliefs, contradictionIds: Array.from(new Set(contradictionIds)) };
}

export function verifyAdaptiveCompletion(input: {
  frame: AdaptiveProblemFrame;
  evidence: AdaptiveEvidence[];
  beliefs: AdaptiveBeliefClaim[];
}): AdaptiveVerificationReport {
  const requiredCriteria = input.frame.successCriteria.filter(
    (criterion) => criterion.required,
  );
  const criterionIds = input.frame.successCriteria.map(
    (criterion) => criterion.criterionId,
  );
  const criterionIdentityValid =
    criterionIds.every(Boolean) &&
    new Set(criterionIds).size === criterionIds.length;
  const contradictions = input.beliefs
    .filter((belief) => belief.state === 'contradicted')
    .map((belief) => belief.beliefId);
  const criteria = input.frame.successCriteria.map(
    (criterion): AdaptiveCriterionVerification => {
      const supporting = input.evidence.filter((evidence) =>
        evidenceCanComplete(evidence, criterion, input.frame),
      );
      const rejected = input.evidence.filter(
        (evidence) =>
          evidence.supportsCriterionIds.includes(criterion.criterionId) &&
          !evidenceCanComplete(evidence, criterion, input.frame),
      );
      const confidence = supporting.length
        ? Math.max(...supporting.map((evidence) => evidence.confidence))
        : 0;
      const satisfied = supporting.length > 0;
      return {
        criterionId: criterion.criterionId,
        satisfied,
        confidence,
        evidenceIds: supporting.map((evidence) => evidence.evidenceId),
        rejectedEvidenceIds: rejected.map((evidence) => evidence.evidenceId),
        reason: satisfied
          ? 'Fresh admissible evidence satisfies this criterion.'
          : rejected.length > 0
            ? 'Available evidence is stale, unverified, weak, or from a non-completing evidence class.'
            : 'No evidence supports this criterion.',
      };
    },
  );
  const unsupportedCriterionIds = criteria
    .filter((criterion) => {
      const contract = input.frame.successCriteria.find(
        (item) => item.criterionId === criterion.criterionId,
      );
      return contract?.required && !criterion.satisfied;
    })
    .map((criterion) => criterion.criterionId);
  const completionAuthorized =
    requiredCriteria.length > 0 &&
    criterionIdentityValid &&
    unsupportedCriterionIds.length === 0 &&
    contradictions.length === 0;
  return {
    status: completionAuthorized
      ? 'pass'
      : input.evidence.length > 0
        ? 'warn'
        : 'block',
    criteria,
    completionAuthorized,
    evidenceClassCounts: evidenceClassCounts(input.evidence),
    contradictions,
    unsupportedCriterionIds,
    reason: completionAuthorized
      ? 'Every required criterion has fresh admissible evidence and no unresolved contradiction.'
      : requiredCriteria.length === 0
        ? 'Completion is blocked because the frame has no required success criterion.'
        : !criterionIdentityValid
          ? 'Completion is blocked because criterion identity is invalid or duplicated.'
          : contradictions.length > 0
            ? 'Completion is blocked by unresolved contradictory beliefs.'
            : 'Completion is blocked by unsupported required criteria.',
  };
}

function activateAlternative(input: {
  graph: AdaptivePlanGraph;
  failedNode: AdaptivePlanNode;
  failureClass: string;
  now: string;
  trace: AdaptiveEngineTraceEvent[];
}): boolean {
  const alternative = input.failedNode.alternativeNodeIds
    .map((id) => input.graph.nodes.find((node) => node.nodeId === id))
    .find(
      (node) =>
        node?.status === 'dormant' &&
        ((node.recoveryForFailureClasses || []).length === 0 ||
          node.recoveryForFailureClasses.includes(input.failureClass)),
    );
  if (!alternative) return false;
  alternative.status = 'pending';
  alternative.updatedAt = input.now;
  input.failedNode.status = 'superseded';
  input.failedNode.updatedAt = input.now;
  const verification = input.graph.nodes.find(
    (node) => node.nodeId === input.graph.verificationNodeId,
  );
  if (verification) {
    verification.dependencyIds = verification.dependencyIds.map((id) =>
      id === input.failedNode.nodeId ? alternative.nodeId : id,
    );
  }
  input.graph.planContractDigest = planContractDigestFor(input.graph);
  addRevision(input.graph, {
    createdAt: input.now,
    kind: 'replan',
    reason: `Activated a bounded alternative after ${safeText(input.failureClass, 120)}.`,
    changedNodeIds: [input.failedNode.nodeId, alternative.nodeId],
    evidenceRefs: input.failedNode.evidenceIds,
  });
  traceEvent(input.trace, {
    createdAt: input.now,
    eventKind: 'replan',
    nodeId: alternative.nodeId,
    summary:
      'Primary node failed; the graph activated its pre-authorized alternative.',
    refs: [input.failedNode.nodeId, alternative.nodeId],
  });
  return true;
}

function internalObservation(input: {
  node: AdaptivePlanNode;
  frame: AdaptiveProblemFrame;
  evidence: AdaptiveEvidence[];
  beliefs: AdaptiveBeliefClaim[];
  now: string;
}): AdaptiveNodeObservation {
  if (input.node.kind === 'clarify') {
    return {
      status: 'needs_clarification',
      summary: 'A blocking ambiguity requires one concrete user answer.',
      evidence: [],
      failureClass: 'blocking_ambiguity',
      nextAction: input.frame.unknowns.find(
        (unknown) => unknown.impact === 'blocking',
      )?.description,
    };
  }
  if (input.node.kind === 'verify') {
    const verification = verifyAdaptiveCompletion({
      frame: input.frame,
      evidence: input.evidence,
      beliefs: input.beliefs,
    });
    return {
      status: verification.completionAuthorized
        ? 'success'
        : verification.contradictions.length > 0
          ? 'contradiction'
          : 'terminal_failure',
      summary: verification.reason,
      evidence: [],
      failureClass: verification.completionAuthorized
        ? null
        : verification.contradictions.length > 0
          ? 'unresolved_contradiction'
          : 'insufficient_completion_evidence',
      nextAction: verification.completionAuthorized
        ? 'Commit verified completion.'
        : 'Gather fresh admissible evidence or report the named blocker.',
    };
  }
  return {
    status: 'success',
    summary:
      input.node.kind === 'finish'
        ? 'Verified completion state committed.'
        : 'Internal cognition node completed without producing external evidence.',
    evidence: [],
  };
}

function terminalResult(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs: AdaptiveBeliefClaim[];
  evidence: AdaptiveEvidence[];
  trace: AdaptiveEngineTraceEvent[];
  nodeExecutions: number;
  retries: number;
  replans: number;
  costUnitsUsed: number;
  unauthorizedMutationAttempts: number;
}): AdaptiveCognitionRunResult {
  const verification = verifyAdaptiveCompletion({
    frame: input.frame,
    evidence: input.evidence,
    beliefs: input.beliefs,
  });
  const completionNode = input.graph.nodes.find(
    (node) => node.nodeId === input.graph.completionNodeId,
  );
  const attemptedCompletion = Boolean(
    completionNode &&
    ['ready', 'running', 'succeeded', 'failed', 'blocked'].includes(
      completionNode.status,
    ),
  );
  if (
    input.graph.status === 'satisfied' &&
    !verification.completionAuthorized
  ) {
    input.graph.status = 'awaiting_evidence';
    if (completionNode?.status === 'succeeded') {
      completionNode.status = 'blocked';
    }
  }
  const falseCompletionPrevented =
    !verification.completionAuthorized &&
    completionNode?.status !== 'succeeded';
  let nextAction =
    'Gather fresh admissible evidence for the unsupported criteria.';
  if (input.graph.status === 'satisfied') {
    nextAction = 'Record metadata-only outcome feedback.';
  } else if (input.graph.status === 'awaiting_approval') {
    nextAction = 'Wait for explicit approval for the exact staged action.';
  } else if (input.graph.status === 'awaiting_clarification') {
    nextAction =
      input.frame.unknowns.find((unknown) => unknown.impact === 'blocking')
        ?.description || 'Ask one concrete clarifying question.';
  } else if (verification.contradictions.length > 0) {
    nextAction = 'Resolve contradictory evidence before claiming completion.';
  } else if (input.graph.status === 'budget_exhausted') {
    nextAction =
      'Checkpoint the graph and resume with a renewed bounded budget.';
  } else if (input.graph.status === 'blocked') {
    nextAction = 'Report the exact blocker without claiming completion.';
  }
  return {
    engineVersion: ADAPTIVE_COGNITION_VERSION,
    frame: input.frame,
    graph: input.graph,
    beliefs: input.beliefs,
    evidence: input.evidence,
    verification,
    trace: input.trace,
    status: input.graph.status,
    nextAction,
    nodeExecutions: input.nodeExecutions,
    replans: input.replans,
    retries: input.retries,
    costUnitsUsed: input.costUnitsUsed,
    unauthorizedMutationAttempts: input.unauthorizedMutationAttempts,
    falseCompletionPrevented:
      falseCompletionPrevented ||
      (attemptedCompletion && !verification.completionAuthorized),
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

export function runAdaptiveCognition(
  input: RunAdaptiveCognitionInput,
): AdaptiveCognitionRunResult {
  const graph = cloneGraph(input.graph);
  let beliefs = (input.beliefs || []).map((belief) => ({
    ...belief,
    provenanceRefs: [...(belief.provenanceRefs || [])],
    supportingEvidenceIds: [...(belief.supportingEvidenceIds || [])],
    contradictingEvidenceIds: [...(belief.contradictingEvidenceIds || [])],
    contradictionIds: [...(belief.contradictionIds || [])],
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  }));
  const evidence = (input.evidence || []).map((item) =>
    normalizedEvidence(item, input.frame.createdAt),
  );
  const initialUnreconciledEvidence = evidence.filter(
    (item) =>
      !beliefs.some((belief) =>
        belief.provenanceRefs.includes(item.evidenceId),
      ),
  );
  if (initialUnreconciledEvidence.length > 0) {
    beliefs = reconcileAdaptiveBeliefs({
      beliefs,
      evidence: initialUnreconciledEvidence,
      now: input.frame.createdAt,
    }).beliefs;
  }
  const trace: AdaptiveEngineTraceEvent[] = [];
  const now = input.now || (() => new Date().toISOString());
  const startedMs = Date.parse(now());
  const consumedNodeExecutions = graph.nodes.reduce(
    (total, node) => total + Math.max(0, node.attemptCount),
    0,
  );
  const consumedRetries = graph.revisions.filter(
    (revision) => revision.kind === 'retry',
  ).length;
  let nodeExecutions = 0;
  let retries = 0;
  let replans = 0;
  let costUnitsUsed = graph.nodes.reduce(
    (total, node) =>
      total + Math.max(0, node.attemptCount) * node.estimatedCostUnits,
    0,
  );
  let unauthorizedMutationAttempts = 0;
  let externalNodeExecutions = 0;
  const externalExecutionLimit =
    input.maxExternalNodeExecutions === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(input.maxExternalNodeExecutions));
  let stopped = false;
  traceEvent(trace, {
    createdAt: now(),
    eventKind: 'frame',
    nodeId: null,
    summary:
      'Adaptive cognition began from an explicit privacy-safe problem frame.',
    refs: [input.frame.frameId, graph.graphId],
  });
  const graphIssues = validateGraphForFrame(input.frame, graph);
  if (graphIssues.length > 0) {
    graph.status = 'blocked';
    traceEvent(trace, {
      createdAt: now(),
      eventKind: 'stop',
      nodeId: null,
      summary:
        'Adaptive cognition rejected an invalid or mismatched persisted plan.',
      refs: graphIssues,
    });
    return terminalResult({
      frame: input.frame,
      graph,
      beliefs,
      evidence,
      trace,
      nodeExecutions,
      replans,
      retries,
      costUnitsUsed,
      unauthorizedMutationAttempts,
    });
  }
  while (!stopped) {
    const currentNow = now();
    if (consumedNodeExecutions + nodeExecutions >= graph.maxNodeExecutions) {
      graph.status = 'budget_exhausted';
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'budget_stop',
        reason: 'Node execution budget exhausted before verified completion.',
        changedNodeIds: [],
        evidenceRefs: evidence.map((item) => item.evidenceId),
      });
      break;
    }
    const currentMs = Date.parse(currentNow);
    if (
      Number.isFinite(startedMs) &&
      Number.isFinite(currentMs) &&
      currentMs - startedMs > graph.maxRuntimeMs
    ) {
      graph.status = 'budget_exhausted';
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'budget_stop',
        reason: 'Runtime budget exhausted before verified completion.',
        changedNodeIds: [],
        evidenceRefs: evidence.map((item) => item.evidenceId),
      });
      break;
    }
    refreshReadyNodes(graph, currentNow);
    const node = nextReadyNode(graph);
    if (!node) {
      const completion = graph.nodes.find(
        (candidate) => candidate.nodeId === graph.completionNodeId,
      );
      if (completion?.status === 'succeeded') graph.status = 'satisfied';
      else if (
        graph.nodes.some(
          (candidate) => candidate.status === 'awaiting_approval',
        )
      ) {
        graph.status = 'awaiting_approval';
      } else if (
        graph.nodes.some(
          (candidate) => candidate.status === 'awaiting_clarification',
        )
      ) {
        graph.status = 'awaiting_clarification';
      } else if (
        graph.nodes.some((candidate) => candidate.status === 'blocked')
      ) {
        graph.status = evidence.length > 0 ? 'degraded' : 'blocked';
      } else {
        graph.status = 'awaiting_evidence';
      }
      break;
    }
    if (
      ['act', 'recover'].includes(node.kind) &&
      externalNodeExecutions >= externalExecutionLimit
    ) {
      graph.status = 'active';
      break;
    }
    traceEvent(trace, {
      createdAt: currentNow,
      eventKind: 'select',
      nodeId: node.nodeId,
      summary: 'Selected exactly one ready node from the dynamic plan graph.',
      refs: node.dependencyIds,
    });
    const authority = authorityAllows(input.frame, node);
    if (!authority.allowed) {
      node.updatedAt = currentNow;
      if (authority.approvalMissing) {
        node.status = 'awaiting_approval';
        graph.status = 'awaiting_approval';
      } else {
        node.status = 'blocked';
        graph.status = 'blocked';
        if (node.mutationClass !== 'none' || node.actionClass === 'mutation') {
          unauthorizedMutationAttempts += 1;
        }
      }
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'authority_stop',
        reason: authority.reason,
        changedNodeIds: [node.nodeId],
        evidenceRefs: [],
      });
      traceEvent(trace, {
        createdAt: currentNow,
        eventKind: 'stop',
        nodeId: node.nodeId,
        summary: authority.reason,
        refs: node.actionId ? [node.actionId] : [],
      });
      break;
    }
    if (
      costUnitsUsed + node.estimatedCostUnits >
      input.frame.budget.maxCostUnits
    ) {
      graph.status = 'budget_exhausted';
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'budget_stop',
        reason: 'Cost-unit budget exhausted before node execution.',
        changedNodeIds: [node.nodeId],
        evidenceRefs: node.evidenceIds,
      });
      traceEvent(trace, {
        createdAt: currentNow,
        eventKind: 'stop',
        nodeId: node.nodeId,
        summary: 'The next node would exceed the immutable frame cost budget.',
        refs: [String(input.frame.budget.maxCostUnits)],
      });
      break;
    }
    node.status = 'running';
    node.attemptCount += 1;
    node.updatedAt = currentNow;
    nodeExecutions += 1;
    costUnitsUsed += node.estimatedCostUnits;
    traceEvent(trace, {
      createdAt: currentNow,
      eventKind: 'execute',
      nodeId: node.nodeId,
      summary: `Executing adaptive node ${node.kind}; attempt ${node.attemptCount}.`,
      refs: node.toolId ? [node.toolId] : [],
    });
    let observation: AdaptiveNodeObservation;
    let executorElapsedMs = 0;
    if (
      ['frame', 'hypothesis', 'clarify', 'verify', 'finish'].includes(node.kind)
    ) {
      observation = internalObservation({
        node,
        frame: input.frame,
        evidence,
        beliefs,
        now: currentNow,
      });
    } else {
      externalNodeExecutions += 1;
      const executorStartedMs = Date.now();
      try {
        observation = input.executor(node, {
          frame: input.frame,
          graph,
          beliefs,
          evidence,
          executionIndex: nodeExecutions,
        });
        // Executor failures are observations for bounded retry/replan; raw
        // exception details are intentionally not persisted or rethrown.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        observation = {
          status: 'retryable_failure',
          summary: 'The node executor threw a bounded, redacted failure.',
          evidence: [],
          failureClass:
            error instanceof Error
              ? safeText(error.name || 'executor_error', 100)
              : 'executor_error',
          nextAction: 'Retry once, then activate a pre-authorized alternative.',
        };
      }
      executorElapsedMs = Math.max(0, Date.now() - executorStartedMs);
    }
    let observedEvidence = (observation.evidence || []).map((item) => {
      const normalized = normalizedEvidence(item, currentNow);
      if (!['act', 'recover'].includes(node.kind)) return normalized;
      const allowedCriteria = new Set(node.producesCriterionIds);
      return {
        ...normalized,
        supportsCriterionIds: normalized.supportsCriterionIds.filter(
          (criterionId) => allowedCriteria.has(criterionId),
        ),
      };
    });
    if (
      ['act', 'recover'].includes(node.kind) &&
      executorElapsedMs > node.timeoutMs
    ) {
      observation = {
        status: 'retryable_failure',
        summary:
          'The node exceeded its bounded timeout; late evidence was discarded.',
        evidence: [],
        failureClass: 'timeout',
        nextAction:
          'Retry only within the remaining budget or activate a timeout-specific alternative.',
      };
      observedEvidence = [];
    } else if (
      ['act', 'recover'].includes(node.kind) &&
      observation.status === 'success'
    ) {
      const evidenceRefs = new Set(
        observedEvidence.flatMap((item) => [
          item.evidenceId,
          item.source,
          item.predicate,
          ...item.provenanceRefs,
        ]),
      );
      const missingRequiredEvidence = node.requiredEvidence.filter(
        (required) => !evidenceRefs.has(required),
      );
      const expectedClassPresent =
        node.producesCriterionIds.length === 0 &&
        node.requiredEvidence.length === 0
          ? true
          : observedEvidence.some(
              (item) => item.evidenceClass === node.expectedEvidenceClass,
            );
      if (missingRequiredEvidence.length > 0 || !expectedClassPresent) {
        const staleEvidence = observedEvidence.some(
          (item) => item.freshness === 'stale',
        );
        observation = {
          status: staleEvidence ? 'stale_evidence' : 'retryable_failure',
          summary:
            'The node returned without the declared typed evidence contract.',
          evidence: observedEvidence,
          failureClass: staleEvidence
            ? 'stale_evidence'
            : !expectedClassPresent
              ? 'evidence_class_mismatch'
              : 'missing_evidence',
          nextAction:
            'Collect the declared evidence class and provenance before retrying or replanning.',
        };
      }
    }
    for (const item of observedEvidence) {
      if (
        !evidence.some((existing) => existing.evidenceId === item.evidenceId)
      ) {
        evidence.push(item);
      }
    }
    node.evidenceIds = safeRefs([
      ...node.evidenceIds,
      ...observedEvidence.map((item) => item.evidenceId),
    ]);
    const reconciliation = reconcileAdaptiveBeliefs({
      beliefs,
      evidence: observedEvidence,
      now: currentNow,
    });
    beliefs = reconciliation.beliefs;
    if (reconciliation.contradictionIds.length > 0) {
      traceEvent(trace, {
        createdAt: currentNow,
        eventKind: 'belief_update',
        nodeId: node.nodeId,
        summary:
          'Belief reconciliation found contradictory claims; completion remains blocked.',
        refs: reconciliation.contradictionIds,
      });
    }
    traceEvent(trace, {
      createdAt: currentNow,
      eventKind: 'observe',
      nodeId: node.nodeId,
      summary: observation.summary,
      refs: observedEvidence.map((item) => item.evidenceId),
    });
    const failureClass = safeText(
      observation.failureClass || observation.status,
      120,
    );
    node.lastFailureClass =
      observation.status === 'success' ? null : failureClass;
    if (observation.status === 'success') {
      if (node.kind === 'finish') {
        const verification = verifyAdaptiveCompletion({
          frame: input.frame,
          evidence,
          beliefs,
        });
        if (!verification.completionAuthorized) {
          node.status = 'blocked';
          graph.status = 'awaiting_evidence';
          stopped = true;
        } else {
          node.status = 'succeeded';
          graph.status = 'satisfied';
          addRevision(graph, {
            createdAt: currentNow,
            kind: 'completion',
            reason:
              'All required criteria passed strict evidence verification.',
            changedNodeIds: [node.nodeId],
            evidenceRefs: verification.criteria.flatMap(
              (criterion) => criterion.evidenceIds,
            ),
          });
          stopped = true;
        }
      } else {
        node.status = 'succeeded';
      }
    } else if (observation.status === 'degraded') {
      node.status = 'degraded';
    } else if (observation.status === 'approval_required') {
      node.status = 'awaiting_approval';
      graph.status = 'awaiting_approval';
      stopped = true;
    } else if (observation.status === 'needs_clarification') {
      node.status = 'awaiting_clarification';
      graph.status = 'awaiting_clarification';
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'clarify',
        reason: observation.nextAction || observation.summary,
        changedNodeIds: [node.nodeId],
        evidenceRefs: node.evidenceIds,
      });
      stopped = true;
    } else if (
      ['retryable_failure', 'stale_evidence'].includes(observation.status) &&
      node.attemptCount < node.maxAttempts &&
      consumedRetries + retries < input.frame.budget.maxRetries
    ) {
      node.status = 'ready';
      retries += 1;
      addRevision(graph, {
        createdAt: currentNow,
        kind: 'retry',
        reason: `Bounded retry after ${failureClass}.`,
        changedNodeIds: [node.nodeId],
        evidenceRefs: node.evidenceIds,
      });
    } else {
      const activated = activateAlternative({
        graph,
        failedNode: node,
        failureClass,
        now: currentNow,
        trace,
      });
      if (activated) {
        replans += 1;
      } else {
        node.status = 'blocked';
        graph.status =
          observation.status === 'contradiction'
            ? 'awaiting_evidence'
            : evidence.length > 0
              ? 'degraded'
              : 'blocked';
        stopped = true;
      }
    }
    node.updatedAt = currentNow;
    if (node.kind === 'verify') {
      traceEvent(trace, {
        createdAt: currentNow,
        eventKind: 'verify',
        nodeId: node.nodeId,
        summary: observation.summary,
        refs: node.evidenceIds,
      });
    }
    if (
      !stopped &&
      ['act', 'recover'].includes(node.kind) &&
      externalNodeExecutions >= externalExecutionLimit
    ) {
      graph.status = 'active';
      stopped = true;
    }
  }
  traceEvent(trace, {
    createdAt: now(),
    eventKind: 'stop',
    nodeId: null,
    summary: `Adaptive cognition stopped with status ${graph.status}.`,
    refs: [graph.graphId],
  });
  return terminalResult({
    frame: input.frame,
    graph,
    beliefs,
    evidence,
    trace,
    nodeExecutions,
    retries,
    replans,
    costUnitsUsed,
    unauthorizedMutationAttempts,
  });
}

/**
 * Advances only privacy-safe internal nodes and returns the next exact external
 * node as a directive. No tool or effect callback can run through this API.
 */
export function advanceAdaptiveCognition(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs?: AdaptiveBeliefClaim[];
  evidence?: AdaptiveEvidence[];
  now?: () => string;
}): AdaptiveCognitionDirective {
  const result = runAdaptiveCognition({
    ...input,
    maxExternalNodeExecutions: 0,
    executor: () => {
      throw new Error('Adaptive directive generation cannot execute a node.');
    },
  });
  const node = result.status === 'active' ? nextReadyNode(result.graph) : null;
  return {
    kind:
      node && ['act', 'recover'].includes(node.kind)
        ? 'execute_node'
        : 'terminal',
    node: node && ['act', 'recover'].includes(node.kind) ? node : null,
    result,
  };
}

/** Applies one typed observation to the exact node selected by the reducer. */
export function applyAdaptiveNodeObservation(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  nodeId: string;
  observation: AdaptiveNodeObservation;
  beliefs?: AdaptiveBeliefClaim[];
  evidence?: AdaptiveEvidence[];
  now?: () => string;
}): AdaptiveCognitionRunResult {
  const directive = advanceAdaptiveCognition({
    frame: input.frame,
    graph: input.graph,
    beliefs: input.beliefs,
    evidence: input.evidence,
    now: input.now,
  });
  if (
    directive.kind !== 'execute_node' ||
    !directive.node ||
    directive.node.nodeId !== input.nodeId
  ) {
    throw new Error(
      'Adaptive observation does not match the exact next-node directive.',
    );
  }
  return runAdaptiveCognition({
    frame: input.frame,
    graph: directive.result.graph,
    beliefs: directive.result.beliefs,
    evidence: directive.result.evidence,
    now: input.now,
    maxExternalNodeExecutions: 1,
    executor: (node) => {
      if (node.nodeId !== input.nodeId) {
        throw new Error('Adaptive reducer selected a different node identity.');
      }
      return input.observation;
    },
  });
}

/**
 * Reconciles proof for an uncertain prior invocation without executing or
 * replaying that node. Only fresh, verified, receipt-backed evidence is valid.
 */
export function reconcileAdaptiveVerifiedRecovery(input: {
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  nodeId: string;
  recoveredEvidence: AdaptiveEvidence[];
  beliefs?: AdaptiveBeliefClaim[];
  evidence?: AdaptiveEvidence[];
  now?: () => string;
}): AdaptiveCognitionRunResult {
  const graph = cloneGraph(input.graph);
  const issues = validateGraphForFrame(input.frame, graph);
  if (issues.length > 0) {
    throw new Error(
      `Adaptive recovery rejected invalid graph: ${issues.join(',')}.`,
    );
  }
  const node = graph.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (
    !node ||
    !['act', 'recover'].includes(node.kind) ||
    !['running', 'failed', 'blocked', 'degraded'].includes(node.status)
  ) {
    throw new Error(
      'Adaptive recovery does not match an uncertain action node.',
    );
  }
  const now = input.now || (() => new Date().toISOString());
  const recoveredAt = now();
  const recoveredEvidence = input.recoveredEvidence.map((item) =>
    normalizedEvidence(item, recoveredAt),
  );
  if (
    recoveredEvidence.length === 0 ||
    recoveredEvidence.some(
      (item) =>
        item.freshness !== 'fresh' ||
        item.verification !== 'verified' ||
        !['observed', 'user_attested'].includes(item.evidenceClass) ||
        !item.provenanceRefs.some((ref) =>
          /^(?:receipt|effect_receipt|verification_receipt):/i.test(ref),
        ) ||
        item.supportsCriterionIds.length === 0 ||
        item.supportsCriterionIds.some(
          (criterionId) =>
            !node.producesCriterionIds.includes(criterionId) ||
            !input.frame.successCriteria.some(
              (criterion) =>
                criterion.criterionId === criterionId &&
                evidenceCanComplete(item, criterion, input.frame),
            ),
        ),
    )
  ) {
    throw new Error(
      'Adaptive recovery requires fresh, verified, target-bound receipt evidence.',
    );
  }
  const evidence = Array.from(
    new Map(
      [...(input.evidence || []), ...recoveredEvidence].map((item) => [
        item.evidenceId,
        normalizedEvidence(item, recoveredAt),
      ]),
    ).values(),
  );
  const reconciliation = reconcileAdaptiveBeliefs({
    beliefs: input.beliefs || [],
    evidence: recoveredEvidence,
    now: recoveredAt,
  });
  node.status = 'succeeded';
  node.updatedAt = recoveredAt;
  node.lastFailureClass = null;
  node.evidenceIds = safeRefs([
    ...node.evidenceIds,
    ...recoveredEvidence.map((item) => item.evidenceId),
  ]);
  graph.status = 'active';
  addRevision(graph, {
    createdAt: recoveredAt,
    kind: 'replan',
    reason:
      'Verified durable recovery evidence resolved an uncertain invocation without replay.',
    changedNodeIds: [node.nodeId],
    evidenceRefs: recoveredEvidence.map((item) => item.evidenceId),
  });
  return runAdaptiveCognition({
    frame: input.frame,
    graph,
    beliefs: reconciliation.beliefs,
    evidence,
    now,
    maxExternalNodeExecutions: 0,
    executor: () => {
      throw new Error('Verified recovery cannot execute an action node.');
    },
  });
}

export interface AdaptiveCalibrationSample {
  confidence: number;
  outcome: 0 | 1;
}

export interface AdaptiveDecisionCandidate {
  candidateId: string;
  action: string;
  usefulness: number;
  successProbability: number;
  cost: number;
  latency: number;
  risk: number;
  reversibility: number;
  informationGain: number;
  approvalRequired: boolean;
  toolHealth: 'healthy' | 'degraded' | 'blocked' | 'unknown';
}

export interface AdaptiveDecisionSelection {
  selectedCandidateId: string;
  selectedAction: string;
  confidence: number;
  scores: Array<{
    candidateId: string;
    action: string;
    score: number;
  }>;
}

/** Shared bounded scorer used by the durable one-node executor adapter. */
export function selectAdaptiveNextAction(input: {
  candidates: AdaptiveDecisionCandidate[];
  staleSignalCount: number;
  missingSignalCount: number;
  contradictionCount: number;
}): AdaptiveDecisionSelection {
  if (input.candidates.length === 0 || input.candidates.length > 20) {
    throw new Error(
      'Adaptive decision requires one to twenty bounded candidates.',
    );
  }
  const scores = input.candidates.map((candidate) => {
    const healthPenalty =
      candidate.toolHealth === 'blocked'
        ? 1
        : candidate.toolHealth === 'degraded'
          ? 0.3
          : candidate.toolHealth === 'unknown'
            ? 0.15
            : 0;
    let score =
      0.25 * candidate.usefulness +
      0.2 * candidate.successProbability +
      0.15 * candidate.informationGain +
      0.1 * candidate.reversibility -
      0.12 * candidate.risk -
      0.08 * candidate.cost -
      0.04 * candidate.latency -
      0.12 * healthPenalty -
      (candidate.approvalRequired ? 0.04 : 0);
    if (
      (input.staleSignalCount > 0 || input.missingSignalCount > 0) &&
      candidate.action === 'inspect'
    ) {
      score += 0.35;
    }
    if (input.contradictionCount > 0 && candidate.action === 'replan') {
      score += 0.4;
    }
    if (input.contradictionCount > 0 && candidate.action === 'execute') {
      score -= 0.8;
    }
    if (candidate.toolHealth === 'blocked' && candidate.action === 'execute') {
      score -= 1;
    }
    return {
      candidateId: safeText(candidate.candidateId, 180),
      action: safeText(candidate.action, 80),
      score: Math.max(-2, Math.min(2, score)),
    };
  });
  scores.sort((left, right) => right.score - left.score);
  const selected = scores[0]!;
  return {
    selectedCandidateId: selected.candidateId,
    selectedAction: selected.action,
    confidence: clamp01(
      0.5 + selected.score / 2 - input.contradictionCount * 0.1,
    ),
    scores,
  };
}

export interface AdaptiveCalibrationReport {
  sampleCount: number;
  brierScore: number;
  expectedCalibrationError: number;
  meanConfidence: number;
  accuracy: number;
  bins: Array<{
    lower: number;
    upper: number;
    count: number;
    meanConfidence: number;
    accuracy: number;
    calibrationGap: number;
  }>;
}

export function computeAdaptiveCalibration(
  samples: AdaptiveCalibrationSample[],
  binCount = 10,
): AdaptiveCalibrationReport {
  const normalized = samples.map((sample) => ({
    confidence: clamp01(sample.confidence),
    outcome: sample.outcome,
  }));
  const count = normalized.length;
  const bins = Array.from(
    { length: Math.max(2, Math.min(20, binCount)) },
    (_, index) => {
      const lower = index / Math.max(2, Math.min(20, binCount));
      const upper = (index + 1) / Math.max(2, Math.min(20, binCount));
      const members = normalized.filter(
        (sample) =>
          sample.confidence >= lower &&
          (index === Math.max(2, Math.min(20, binCount)) - 1
            ? sample.confidence <= upper
            : sample.confidence < upper),
      );
      const meanConfidence = members.length
        ? members.reduce((sum, sample) => sum + sample.confidence, 0) /
          members.length
        : 0;
      const accuracy = members.length
        ? members.reduce((sum, sample) => sum + sample.outcome, 0) /
          members.length
        : 0;
      return {
        lower,
        upper,
        count: members.length,
        meanConfidence,
        accuracy,
        calibrationGap: Math.abs(meanConfidence - accuracy),
      };
    },
  );
  const brierScore = count
    ? normalized.reduce(
        (sum, sample) => sum + (sample.confidence - sample.outcome) ** 2,
        0,
      ) / count
    : 0;
  const expectedCalibrationError = count
    ? bins.reduce(
        (sum, bin) => sum + (bin.count / count) * bin.calibrationGap,
        0,
      )
    : 0;
  return {
    sampleCount: count,
    brierScore,
    expectedCalibrationError,
    meanConfidence: count
      ? normalized.reduce((sum, sample) => sum + sample.confidence, 0) / count
      : 0,
    accuracy: count
      ? normalized.reduce((sum, sample) => sum + sample.outcome, 0) / count
      : 0,
    bins,
  };
}

export interface AdaptiveImprovementCandidate {
  candidateId: string;
  createdAt: string;
  scope: 'framing' | 'planning' | 'routing' | 'verification' | 'calibration';
  state: 'isolated' | 'evaluated' | 'eligible' | 'rejected';
  hypothesis: string;
  changeSummary: string;
  sourceRunIds: string[];
  authorityExpansion: false;
  productionMutationAllowed: false;
  evaluation?: {
    heldOutScenarioCount: number;
    baselineScore: number;
    candidateScore: number;
    safetyRegressions: number;
    privacyRegressions: number;
    eligible: boolean;
  };
  privacy: AdaptivePrivacyBoundary;
}

export function proposeIsolatedAdaptiveImprovement(input: {
  createdAt?: string;
  scope: AdaptiveImprovementCandidate['scope'];
  hypothesis: string;
  changeSummary: string;
  sourceRunIds: string[];
}): AdaptiveImprovementCandidate {
  const createdAt = input.createdAt || new Date().toISOString();
  const hypothesis = safeText(input.hypothesis, 420);
  const changeSummary = safeText(input.changeSummary, 520);
  return {
    candidateId: hashId(
      'adaptive:improvement',
      `${createdAt}|${input.scope}|${hypothesis}|${changeSummary}`,
    ),
    createdAt,
    scope: input.scope,
    state: 'isolated',
    hypothesis,
    changeSummary,
    sourceRunIds: safeRefs(input.sourceRunIds),
    authorityExpansion: false,
    productionMutationAllowed: false,
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

export function evaluateIsolatedAdaptiveImprovement(input: {
  candidate: AdaptiveImprovementCandidate;
  heldOutScenarioCount: number;
  baselineScore: number;
  candidateScore: number;
  safetyRegressions: number;
  privacyRegressions: number;
}): AdaptiveImprovementCandidate {
  const eligible =
    input.heldOutScenarioCount >= 40 &&
    input.candidateScore > input.baselineScore &&
    input.safetyRegressions === 0 &&
    input.privacyRegressions === 0;
  return {
    ...input.candidate,
    state: eligible ? 'eligible' : 'rejected',
    authorityExpansion: false,
    productionMutationAllowed: false,
    evaluation: {
      heldOutScenarioCount: Math.max(0, Math.floor(input.heldOutScenarioCount)),
      baselineScore: clamp01(input.baselineScore),
      candidateScore: clamp01(input.candidateScore),
      safetyRegressions: Math.max(0, Math.floor(input.safetyRegressions)),
      privacyRegressions: Math.max(0, Math.floor(input.privacyRegressions)),
      eligible,
    },
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

export function adaptiveEvidence(input: {
  evidenceId?: string;
  createdAt?: string;
  evidenceClass: AdaptiveEvidenceClass;
  origin: AdaptiveEvidenceOrigin;
  source: string;
  claim: string;
  subject?: string;
  predicate?: string;
  value?: string;
  confidence: number;
  freshness?: AdaptiveEvidenceFreshness;
  scope?: string;
  verification?: AdaptiveEvidence['verification'];
  supportsCriterionIds?: string[];
  provenanceRefs?: string[];
}): AdaptiveEvidence {
  const createdAt = input.createdAt || new Date().toISOString();
  return normalizedEvidence(
    {
      evidenceId:
        input.evidenceId ||
        hashId(
          'adaptive:evidence',
          `${createdAt}|${input.source}|${input.claim}`,
        ),
      createdAt,
      evidenceClass: input.evidenceClass,
      origin: input.origin,
      source: input.source,
      claim: input.claim,
      subject: input.subject || '',
      predicate: input.predicate || '',
      value: input.value || '',
      confidence: input.confidence,
      freshness: input.freshness || 'fresh',
      scope: input.scope || 'current_turn',
      verification: input.verification || 'accepted',
      supportsCriterionIds: input.supportsCriterionIds || [],
      provenanceRefs: input.provenanceRefs || [],
      privacy: ADAPTIVE_COGNITION_PRIVACY,
    },
    createdAt,
  );
}
