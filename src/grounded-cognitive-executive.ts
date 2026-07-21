import { createHash } from 'node:crypto';

import {
  ADAPTIVE_COGNITION_PRIVACY,
  advanceAdaptiveCognition,
  adaptiveEvidence,
  applyAdaptiveNodeObservation,
  buildAdaptivePlanGraph,
  computeAdaptiveCalibration,
  createAdaptiveProblemFrame,
  reconcileAdaptiveBeliefs,
  reopenAdaptivePlanForEvidence,
  selectAdaptiveNextAction,
  verifyAdaptiveCompletion,
} from './adaptive-cognition-engine.js';
import type {
  AdaptiveActionCandidate,
  AdaptiveBeliefClaim,
  AdaptiveCalibrationReport,
  AdaptiveCalibrationSample,
  AdaptiveDecisionCandidate,
  AdaptiveEvidence,
  AdaptiveEvidenceClass,
  AdaptiveNodeObservation,
  AdaptivePlanGraph,
  AdaptivePlanNode,
  AdaptiveProblemFrame,
  AdaptiveVerificationReport,
  CreateAdaptiveFrameInput,
} from './adaptive-cognition-engine.js';

/**
 * Grounded cognitive executive: a closed observation → belief → plan →
 * precondition/risk check → action decision → outcome verification →
 * learning loop composed from adaptive-cognition-engine primitives.
 *
 * This module is pure and deterministic. It owns no credentials, transports,
 * approvals, or persistence; callers execute actions through their existing
 * policy layer and return typed observations. Learning artifacts produced
 * here describe planning truth only and can never grant action authority.
 */

export const GROUNDED_EXECUTIVE_VERSION = '1.0.0';

/** Operator-facing epistemic tier derived from a belief plus its evidence. */
export type GroundedBeliefTier =
  | 'unknown'
  | 'uncertain'
  | 'likely'
  | 'verified';

export type GroundedDecisionKind =
  | 'act'
  | 'research'
  | 'ask'
  | 'defer'
  | 'stop_safely';

export type GroundedOutcomeVerdict =
  | 'verified'
  | 'failed'
  | 'partial'
  | 'blocked'
  | 'uncertain';

export type GroundedBeliefChangeCause =
  | 'new_evidence'
  | 'contradiction'
  | 'staleness'
  | 'verification'
  | 'correction';

export type GroundedLearningKind =
  | 'missing_evidence'
  | 'wrong_assumption'
  | 'tool_reliability'
  | 'plan_pattern'
  | 'calibration';

export type GroundedLearningStatus = 'proposed' | 'accepted' | 'retired';

export interface GroundedEvidenceRecord {
  evidence: AdaptiveEvidence;
  /** Concrete observations that would disprove or force an update. */
  disproofConditions: string[];
  /** Evidence older than this is stale; null disables age-based staleness. */
  staleAfterMs: number | null;
}

export interface GroundedBeliefChange {
  changeId: string;
  createdAt: string;
  beliefId: string;
  subject: string;
  predicate: string;
  value: string;
  previousTier: GroundedBeliefTier | null;
  newTier: GroundedBeliefTier;
  previousConfidence: number | null;
  newConfidence: number;
  cause: GroundedBeliefChangeCause;
  explanation: string;
  evidenceRefs: string[];
}

export interface GroundedDecision {
  decisionId: string;
  createdAt: string;
  kind: GroundedDecisionKind;
  confidence: number;
  reason: string;
  whatWouldChangeMind: string[];
  targetNodeId: string | null;
  question: string | null;
  researchTarget: string | null;
  candidateScores: Array<{
    candidateId: string;
    action: string;
    score: number;
  }>;
  /** States that action authority stays with the existing approval layer. */
  authorityNote: string;
}

export interface GroundedOutcomeVerification {
  verificationId: string;
  createdAt: string;
  nodeId: string;
  verdict: GroundedOutcomeVerdict;
  expected: string;
  actual: string;
  causalExplanation: string;
  invalidatedBeliefIds: string[];
  replanTriggered: boolean;
  calibrationSampleId: string | null;
}

export interface GroundedCalibrationSample {
  sampleId: string;
  createdAt: string;
  contextKey: string;
  predictedConfidence: number;
  outcome: 0 | 1;
  verdict: GroundedOutcomeVerdict;
  source: 'outcome_verification' | 'correction';
  decisionId: string | null;
  verificationId: string | null;
}

export interface GroundedLearningRecord {
  recordId: string;
  createdAt: string;
  kind: GroundedLearningKind;
  status: GroundedLearningStatus;
  subject: string;
  contextKey: string;
  lesson: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  /**
   * Structurally pinned to false: learning records describe planning truth
   * and can never expand approvals, permissions, or messaging behavior.
   */
  appliesToAuthority: false;
  reviewNote: string | null;
  sourceTurnId: string | null;
}

export type GroundedExecutivePhase =
  | 'observe'
  | 'believe'
  | 'plan'
  | 'check'
  | 'act'
  | 'verify'
  | 'learn'
  | 'done';

export interface GroundedExecutiveState {
  stateId: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  phase: GroundedExecutivePhase;
  turnRef: string | null;
  contextKey: string;
  frame: AdaptiveProblemFrame;
  graph: AdaptivePlanGraph;
  beliefs: AdaptiveBeliefClaim[];
  evidenceRecords: GroundedEvidenceRecord[];
  contradictionIds: string[];
  decisions: GroundedDecision[];
  verifications: GroundedOutcomeVerification[];
  learning: GroundedLearningRecord[];
  calibrationSamples: GroundedCalibrationSample[];
  beliefJournal: GroundedBeliefChange[];
}

export type GroundedToolHealth = 'healthy' | 'degraded' | 'blocked' | 'unknown';

const BOUNDED_TEXT_LIMIT = 420;
const MAX_JOURNAL_ENTRIES = 200;
const VERIFIED_TIER_MINIMUM_CONFIDENCE = 0.85;

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function bounded(
  value: string | null | undefined,
  limit = BOUNDED_TEXT_LIMIT,
): string {
  const text = String(value ?? '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => bounded(value, 240)).filter(Boolean)),
  );
}

/** Evidence that may support (not merely suggest) a belief or completion. */
export function isAdmissibleGroundedEvidence(
  evidence: AdaptiveEvidence,
): boolean {
  return (
    ['observed', 'user_attested'].includes(evidence.evidenceClass) &&
    ['accepted', 'verified'].includes(evidence.verification) &&
    evidence.freshness === 'fresh'
  );
}

/**
 * Derived epistemic tier. This is a read-only view over the engine's belief
 * state; it never mutates or replaces the underlying belief entity.
 * Inferred, simulated, or model-generated evidence can never yield
 * `verified` — that requires fresh admissible observation or user attestation.
 */
export function groundedBeliefTier(
  belief: AdaptiveBeliefClaim,
  evidence: AdaptiveEvidence[],
): GroundedBeliefTier {
  if (belief.state === 'unknown' || belief.state === 'superseded') {
    return 'unknown';
  }
  if (
    belief.state === 'contradicted' ||
    belief.state === 'stale' ||
    belief.state === 'hypothesis'
  ) {
    return 'uncertain';
  }
  const admissibleSupport = belief.supportingEvidenceIds.some((evidenceId) => {
    const record = evidence.find((item) => item.evidenceId === evidenceId);
    return record ? isAdmissibleGroundedEvidence(record) : false;
  });
  if (!admissibleSupport) return 'uncertain';
  return belief.confidence >= VERIFIED_TIER_MINIMUM_CONFIDENCE
    ? 'verified'
    : 'likely';
}

export interface CreateGroundedEvidenceInput {
  evidenceId?: string;
  createdAt?: string;
  evidenceClass: AdaptiveEvidenceClass;
  origin: AdaptiveEvidence['origin'];
  source: string;
  claim: string;
  subject?: string;
  predicate?: string;
  value?: string;
  confidence: number;
  freshness?: AdaptiveEvidence['freshness'];
  scope?: string;
  verification?: AdaptiveEvidence['verification'];
  supportsCriterionIds?: string[];
  provenanceRefs?: string[];
  disproofConditions?: string[];
  staleAfterMs?: number | null;
}

export function groundedEvidence(
  input: CreateGroundedEvidenceInput,
): GroundedEvidenceRecord {
  return {
    evidence: adaptiveEvidence(input),
    disproofConditions: dedupe(input.disproofConditions || []),
    staleAfterMs:
      typeof input.staleAfterMs === 'number' && input.staleAfterMs > 0
        ? Math.floor(input.staleAfterMs)
        : null,
  };
}

/** Flips fresh evidence past its staleness policy to stale. */
export function refreshGroundedFreshness(
  records: GroundedEvidenceRecord[],
  now: string,
): { records: GroundedEvidenceRecord[]; staleChangedEvidenceIds: string[] } {
  const nowMs = Date.parse(now);
  const staleChangedEvidenceIds: string[] = [];
  const next = records.map((record) => {
    if (
      record.staleAfterMs === null ||
      record.evidence.freshness !== 'fresh' ||
      !Number.isFinite(nowMs)
    ) {
      return record;
    }
    const createdMs = Date.parse(record.evidence.createdAt);
    if (
      !Number.isFinite(createdMs) ||
      nowMs - createdMs <= record.staleAfterMs
    ) {
      return record;
    }
    staleChangedEvidenceIds.push(record.evidence.evidenceId);
    return {
      ...record,
      evidence: { ...record.evidence, freshness: 'stale' as const },
    };
  });
  return { records: next, staleChangedEvidenceIds };
}

/**
 * Preconditions written as `precond:<subject>/<predicate>/<value>` are checked
 * against beliefs; such a precondition holds only when a matching belief is at
 * least `likely`. The characters used survive the engine's reference
 * normalization. Free-text preconditions are informational and not gated on.
 */
export function parseGroundedPrecondition(
  precondition: string,
): { subject: string; predicate: string; value: string } | null {
  const match = /^precond:([^/]+)\/([^/]+)\/(.+)$/.exec(precondition.trim());
  if (!match) return null;
  return {
    subject: match[1]!.trim(),
    predicate: match[2]!.trim(),
    value: match[3]!.trim(),
  };
}

function unmetParsedPreconditions(
  node: AdaptivePlanNode,
  beliefs: AdaptiveBeliefClaim[],
  evidence: AdaptiveEvidence[],
): string[] {
  return node.preconditions.filter((precondition) => {
    const parsed = parseGroundedPrecondition(precondition);
    if (!parsed) return false;
    return !beliefs.some(
      (belief) =>
        belief.subject === parsed.subject &&
        belief.predicate === parsed.predicate &&
        belief.value === parsed.value &&
        ['likely', 'verified'].includes(groundedBeliefTier(belief, evidence)),
    );
  });
}

export interface BeginGroundedExecutiveInput {
  objective: string;
  taskFamily: string;
  channel: string;
  route?: string | null;
  turnRef?: string | null;
  authority?: CreateAdaptiveFrameInput['authority'];
  evidence?: GroundedEvidenceRecord[];
  actions?: AdaptiveActionCandidate[];
  assumptions?: string[];
  unknowns?: CreateAdaptiveFrameInput['unknowns'];
  successCriteria?: CreateAdaptiveFrameInput['successCriteria'];
  constraints?: string[];
  risk?: CreateAdaptiveFrameInput['risk'];
  budget?: CreateAdaptiveFrameInput['budget'];
  stopConditions?: string[];
  now: string;
}

export function beginGroundedExecutive(
  input: BeginGroundedExecutiveInput,
): GroundedExecutiveState {
  // Mutating steps must verify through receipts: the engine rejects effect
  // nodes whose criteria lack an explicit receipt contract on the frame.
  const receiptContracts = (input.actions || [])
    .filter(
      (action) =>
        action.mutationClass !== 'none' || action.actionClass === 'mutation',
    )
    .flatMap((action) =>
      action.producesCriterionIds.map(
        (criterionId) => `receipt_required:${criterionId}`,
      ),
    );
  const frame = createAdaptiveProblemFrame({
    createdAt: input.now,
    objective: input.objective,
    taskFamily: input.taskFamily,
    channel: input.channel,
    route: input.route ?? null,
    authority: input.authority,
    successCriteria: input.successCriteria,
    constraints: input.constraints,
    assumptions: input.assumptions,
    unknowns: input.unknowns,
    risk: input.risk,
    budget: input.budget,
    stopConditions: input.stopConditions,
    contextRefs: receiptContracts,
  });
  const graph = buildAdaptivePlanGraph({
    frame,
    actions: input.actions || [],
  });
  const contextKey = `${frame.taskFamily}|${frame.channel}`;
  const state: GroundedExecutiveState = {
    stateId: hashId('grounded:state', `${frame.frameId}|${input.now}`),
    version: GROUNDED_EXECUTIVE_VERSION,
    createdAt: input.now,
    updatedAt: input.now,
    phase: 'observe',
    turnRef: input.turnRef ? bounded(input.turnRef, 180) : null,
    contextKey,
    frame,
    graph,
    beliefs: [],
    evidenceRecords: [],
    contradictionIds: [],
    decisions: [],
    verifications: [],
    learning: [],
    calibrationSamples: [],
    beliefJournal: [],
  };
  if (input.evidence?.length) {
    return observeGroundedEvidence(state, input.evidence, input.now).state;
  }
  return state;
}

function tierByBeliefId(
  beliefs: AdaptiveBeliefClaim[],
  evidence: AdaptiveEvidence[],
): Map<string, { tier: GroundedBeliefTier; confidence: number }> {
  return new Map(
    beliefs.map((belief) => [
      belief.beliefId,
      {
        tier: groundedBeliefTier(belief, evidence),
        confidence: belief.confidence,
      },
    ]),
  );
}

function beliefChangeExplanation(
  belief: AdaptiveBeliefClaim,
  cause: GroundedBeliefChangeCause,
  previousTier: GroundedBeliefTier | null,
  newTier: GroundedBeliefTier,
): string {
  const claim = `"${belief.subject} ${belief.predicate} ${belief.value}"`;
  switch (cause) {
    case 'contradiction':
      return `Belief ${claim} moved from ${previousTier ?? 'new'} to ${newTier} because admissible evidence now contradicts it; both sides remain recorded.`;
    case 'staleness':
      return `Belief ${claim} moved from ${previousTier ?? 'new'} to ${newTier} because its supporting evidence exceeded its freshness window.`;
    case 'verification':
      return `Belief ${claim} moved from ${previousTier ?? 'new'} to ${newTier} after an outcome verification updated its evidence.`;
    case 'correction':
      return `Belief ${claim} moved from ${previousTier ?? 'new'} to ${newTier} after an attested correction of a prior outcome.`;
    default:
      return previousTier === null
        ? `Belief ${claim} entered at ${newTier} from newly recorded evidence.`
        : `Belief ${claim} moved from ${previousTier} to ${newTier} after new evidence arrived.`;
  }
}

function journalBeliefChanges(input: {
  beforeTiers: Map<string, { tier: GroundedBeliefTier; confidence: number }>;
  afterBeliefs: AdaptiveBeliefClaim[];
  afterEvidence: AdaptiveEvidence[];
  newContradictionIds: string[];
  staleChangedEvidenceIds: string[];
  cause: GroundedBeliefChangeCause;
  now: string;
}): GroundedBeliefChange[] {
  const changes: GroundedBeliefChange[] = [];
  for (const belief of input.afterBeliefs) {
    const before = input.beforeTiers.get(belief.beliefId) ?? null;
    const newTier = groundedBeliefTier(belief, input.afterEvidence);
    if (
      before &&
      before.tier === newTier &&
      Math.abs(before.confidence - belief.confidence) < 1e-9
    ) {
      continue;
    }
    const cause: GroundedBeliefChangeCause = input.newContradictionIds.includes(
      belief.beliefId,
    )
      ? 'contradiction'
      : belief.state === 'stale' ||
          belief.supportingEvidenceIds.some((id) =>
            input.staleChangedEvidenceIds.includes(id),
          )
        ? 'staleness'
        : input.cause;
    changes.push({
      changeId: hashId(
        'grounded:change',
        `${belief.beliefId}|${input.now}|${before?.tier ?? 'new'}|${newTier}|${belief.confidence}`,
      ),
      createdAt: input.now,
      beliefId: belief.beliefId,
      subject: belief.subject,
      predicate: belief.predicate,
      value: belief.value,
      previousTier: before?.tier ?? null,
      newTier,
      previousConfidence: before?.confidence ?? null,
      newConfidence: belief.confidence,
      cause,
      explanation: bounded(
        beliefChangeExplanation(belief, cause, before?.tier ?? null, newTier),
      ),
      evidenceRefs: dedupe([
        ...belief.supportingEvidenceIds,
        ...belief.contradictingEvidenceIds,
      ]),
    });
  }
  return changes;
}

export interface GroundedObservationResult {
  state: GroundedExecutiveState;
  changes: GroundedBeliefChange[];
  newContradictionIds: string[];
  staleChangedEvidenceIds: string[];
  planReopened: boolean;
}

/**
 * Folds new evidence into beliefs. Contradictory evidence stays attached to
 * the belief it contradicts instead of overwriting it, and every tier or
 * confidence movement is journaled with a one-sentence explanation.
 */
export function observeGroundedEvidence(
  state: GroundedExecutiveState,
  records: GroundedEvidenceRecord[],
  now: string,
  cause: GroundedBeliefChangeCause = 'new_evidence',
): GroundedObservationResult {
  const known = new Map(
    state.evidenceRecords.map((record) => [record.evidence.evidenceId, record]),
  );
  const incoming = records.filter(
    (record) => !known.has(record.evidence.evidenceId),
  );
  const merged = [...state.evidenceRecords, ...incoming];
  const { records: refreshed, staleChangedEvidenceIds } =
    refreshGroundedFreshness(merged, now);
  const evidence = refreshed.map((record) => record.evidence);
  const beforeTiers = tierByBeliefId(
    state.beliefs,
    state.evidenceRecords.map((record) => record.evidence),
  );
  const evidenceToReconcile = refreshed
    .filter(
      (record) =>
        incoming.some(
          (item) => item.evidence.evidenceId === record.evidence.evidenceId,
        ) || staleChangedEvidenceIds.includes(record.evidence.evidenceId),
    )
    .map((record) => record.evidence);
  const reconciliation = reconcileAdaptiveBeliefs({
    beliefs: state.beliefs,
    evidence: evidenceToReconcile,
    now,
  });
  const newContradictionIds = reconciliation.contradictionIds.filter(
    (id) => !state.contradictionIds.includes(id),
  );
  const changes = journalBeliefChanges({
    beforeTiers,
    afterBeliefs: reconciliation.beliefs,
    afterEvidence: evidence,
    newContradictionIds,
    staleChangedEvidenceIds,
    cause,
    now,
  });
  const verificationNode = state.graph.nodes.find(
    (node) => node.nodeId === state.graph.verificationNodeId,
  );
  const shouldReopen =
    verificationNode !== undefined &&
    ['succeeded', 'blocked', 'failed'].includes(verificationNode.status) &&
    (newContradictionIds.length > 0 ||
      staleChangedEvidenceIds.length > 0 ||
      evidenceToReconcile.some(isAdmissibleGroundedEvidence));
  const graph = shouldReopen
    ? reopenAdaptivePlanForEvidence(state.graph, now)
    : state.graph;
  const nextState: GroundedExecutiveState = {
    ...state,
    updatedAt: now,
    phase: 'believe',
    graph,
    beliefs: reconciliation.beliefs,
    evidenceRecords: refreshed,
    contradictionIds: Array.from(
      new Set([...state.contradictionIds, ...reconciliation.contradictionIds]),
    ),
    beliefJournal: [...state.beliefJournal, ...changes].slice(
      -MAX_JOURNAL_ENTRIES,
    ),
  };
  return {
    state: nextState,
    changes,
    newContradictionIds,
    staleChangedEvidenceIds,
    planReopened: shouldReopen,
  };
}

export interface DecideGroundedNextStepInput {
  toolHealthBySubject?: Record<string, GroundedToolHealth>;
  learning?: GroundedLearningRecord[];
  minimumActConfidence?: number;
  /** Higher bar for steps with external effects. */
  minimumMutationConfidence?: number;
  now: string;
}

export interface GroundedDecisionResult {
  state: GroundedExecutiveState;
  decision: GroundedDecision;
  directiveNodeId: string | null;
}

const AUTHORITY_NOTE =
  'Action authority is decided solely by the existing approval layer (autonomy governor, delivery authorization, outbound fences); this decision only proposes a next step and cannot grant or expand authority.';

function currentContradictionCount(state: GroundedExecutiveState): number {
  return state.beliefs.filter((belief) => belief.state === 'contradicted')
    .length;
}

function staleSignalCount(state: GroundedExecutiveState): number {
  return state.evidenceRecords.filter(
    (record) => record.evidence.freshness === 'stale',
  ).length;
}

function missingSignalCount(
  state: GroundedExecutiveState,
  excludeCriterionIds: string[] = [],
): number {
  const evidence = state.evidenceRecords.map((record) => record.evidence);
  return state.frame.successCriteria.filter(
    (criterion) =>
      criterion.required &&
      !excludeCriterionIds.includes(criterion.criterionId) &&
      !evidence.some(
        (item) =>
          item.supportsCriterionIds.includes(criterion.criterionId) &&
          isAdmissibleGroundedEvidence(item),
      ),
  ).length;
}

function whatWouldChangeMindFor(
  state: GroundedExecutiveState,
  targetNode: AdaptivePlanNode | null,
): string[] {
  const contradicted = state.beliefs.filter(
    (belief) => belief.state === 'contradicted',
  );
  const loadBearingDisproofs = state.evidenceRecords
    .filter((record) => isAdmissibleGroundedEvidence(record.evidence))
    .flatMap((record) => record.disproofConditions);
  const missingClasses = missingSignalCount(state)
    ? [
        'Fresh observed or user-attested evidence for the unmet required criteria.',
      ]
    : [];
  return dedupe([
    ...contradicted.map(
      (belief) =>
        `Resolving the contradiction on "${belief.subject} ${belief.predicate}" with fresh admissible evidence.`,
    ),
    ...loadBearingDisproofs,
    ...missingClasses,
    ...(targetNode
      ? unmetParsedPreconditions(
          targetNode,
          state.beliefs,
          state.evidenceRecords.map((record) => record.evidence),
        ).map((precondition) => `Establishing precondition ${precondition}.`)
      : []),
  ]).slice(0, 12);
}

function healthFor(
  node: AdaptivePlanNode,
  toolHealthBySubject: Record<string, GroundedToolHealth>,
): GroundedToolHealth {
  if (node.toolId && toolHealthBySubject[node.toolId]) {
    return toolHealthBySubject[node.toolId]!;
  }
  return 'unknown';
}

const RISK_SCORE: Record<AdaptivePlanNode['risk']['level'], number> = {
  low: 0.1,
  medium: 0.35,
  high: 0.7,
  critical: 1,
};

/**
 * Chooses the next step among act / research / ask / defer / stop_safely.
 * Prefers asking or researching whenever confidence or required evidence is
 * insufficient, and never proposes acting across an unresolved contradiction,
 * an unmet parsed precondition, or a blocked tool.
 */
export function decideGroundedNextStep(
  state: GroundedExecutiveState,
  input: DecideGroundedNextStepInput,
): GroundedDecisionResult {
  const minimumActConfidence = clamp01(input.minimumActConfidence ?? 0.6);
  const minimumMutationConfidence = clamp01(
    input.minimumMutationConfidence ?? 0.75,
  );
  const toolHealthBySubject = input.toolHealthBySubject || {};
  const nowFn = () => input.now;
  const directive = advanceAdaptiveCognition({
    frame: state.frame,
    graph: state.graph,
    beliefs: state.beliefs,
    evidence: state.evidenceRecords.map((record) => record.evidence),
    now: nowFn,
  });
  const graphStatus = directive.result.status;
  const targetNode = directive.kind === 'execute_node' ? directive.node : null;
  const contradictionCount = currentContradictionCount(state);
  const stale = staleSignalCount(state);
  // A ready act node that itself produces the missing criterion evidence is
  // the remedy, not the gap — don't count its own criteria as missing.
  const missing = missingSignalCount(
    state,
    directive.kind === 'execute_node' && directive.node
      ? directive.node.producesCriterionIds
      : [],
  );
  const evidence = state.evidenceRecords.map((record) => record.evidence);
  const learningAdjusted = applyGroundedLearningToPlanning(
    input.learning || [],
    buildDecisionCandidates({
      state,
      targetNode,
      toolHealthBySubject,
      stale,
      missing,
    }),
  );
  const selection = selectAdaptiveNextAction({
    candidates: learningAdjusted,
    staleSignalCount: stale,
    missingSignalCount: missing,
    contradictionCount,
  });
  let kind = actionToDecisionKind(selection.selectedAction);
  let reason = `Bounded scoring selected "${selection.selectedAction}" with confidence ${selection.confidence.toFixed(2)}.`;
  const executeScore = targetNode
    ? (selection.scores.find((score) => score.action === 'execute')?.score ??
      null)
    : null;
  const actConfidence =
    executeScore === null
      ? null
      : clamp01(0.5 + executeScore / 2 - contradictionCount * 0.1);
  const blockingUnknown = state.frame.unknowns.find(
    (unknown) => unknown.impact === 'blocking',
  );
  const anyUnknown = blockingUnknown || state.frame.unknowns[0] || null;
  const unmetPreconditions = targetNode
    ? unmetParsedPreconditions(targetNode, state.beliefs, evidence)
    : [];

  if (
    graphStatus === 'awaiting_clarification' ||
    state.frame.ambiguity === 'blocking'
  ) {
    kind = 'ask';
    reason =
      'A blocking ambiguity must be resolved by the user before any action is grounded.';
  } else if (graphStatus === 'awaiting_approval') {
    kind = 'defer';
    reason =
      'The next step is a staged mutation awaiting explicit approval; deferring until the approval layer decides.';
  } else if (
    graphStatus === 'budget_exhausted' ||
    graphStatus === 'blocked' ||
    graphStatus === 'degraded'
  ) {
    kind = 'stop_safely';
    reason = `The plan reached a stop condition (${graphStatus}); stopping safely instead of guessing.`;
  } else if (
    contradictionCount > 0 &&
    (kind === 'act' || kind === 'research')
  ) {
    kind = 'research';
    reason = `Acting is blocked by ${contradictionCount} unresolved contradictory belief(s); researching to resolve them first.`;
  } else if (kind === 'act' && unmetPreconditions.length > 0) {
    kind = 'research';
    reason = `Precondition ${unmetPreconditions[0]} is not established at "likely" or better; researching before acting.`;
  } else if (
    kind === 'act' &&
    targetNode &&
    healthFor(targetNode, toolHealthBySubject) === 'blocked'
  ) {
    kind = 'defer';
    reason = `Tool ${targetNode.toolId ?? targetNode.title} is blocked; deferring instead of attempting a doomed action.`;
  } else if (
    (kind === 'act' || kind === 'research') &&
    targetNode &&
    (targetNode.mutationClass !== 'none' || targetNode.approvalRequired) &&
    actConfidence !== null &&
    actConfidence < minimumMutationConfidence
  ) {
    kind = 'ask';
    reason = `Act confidence ${actConfidence.toFixed(2)} is below ${minimumMutationConfidence.toFixed(2)} for a step with external effects; asking before changing anything.`;
  } else if (kind === 'act' && targetNode && targetNode.approvalRequired) {
    kind = 'defer';
    reason =
      'The selected step requires explicit approval; deferring so the approval layer can stage it.';
  } else if (kind === 'act' && selection.confidence < minimumActConfidence) {
    if (anyUnknown) {
      kind = 'ask';
      reason = `Confidence ${selection.confidence.toFixed(2)} is below ${minimumActConfidence.toFixed(2)} and an unknown is user-resolvable; asking instead of acting.`;
    } else {
      kind = 'research';
      reason = `Confidence ${selection.confidence.toFixed(2)} is below ${minimumActConfidence.toFixed(2)}; researching to raise evidence quality before acting.`;
    }
  } else if (kind === 'act' && missing > 0 && !targetNode) {
    kind = 'research';
    reason =
      'Required criteria still lack admissible evidence and no action node is ready; researching.';
  }
  if (kind === 'act' && !targetNode) {
    kind = missing > 0 ? 'research' : 'stop_safely';
    reason =
      missing > 0
        ? 'No executable plan node is ready; researching the unmet criteria instead.'
        : 'No executable plan node is ready and no criterion is unmet; stopping safely.';
  }

  const decision: GroundedDecision = {
    decisionId: hashId(
      'grounded:decision',
      `${state.stateId}|${input.now}|${state.decisions.length}|${kind}`,
    ),
    createdAt: input.now,
    kind,
    confidence: selection.confidence,
    reason: bounded(reason),
    whatWouldChangeMind: whatWouldChangeMindFor(state, targetNode),
    targetNodeId: kind === 'act' ? (targetNode?.nodeId ?? null) : null,
    question:
      kind === 'ask'
        ? bounded(
            anyUnknown?.description ??
              'Which concrete outcome do you want before this step proceeds?',
          )
        : null,
    researchTarget:
      kind === 'research'
        ? bounded(
            contradictionCount > 0
              ? 'Fresh admissible evidence resolving the contradictory beliefs.'
              : (unmetPreconditions[0] ??
                  'Fresh admissible evidence for the unmet required criteria.'),
          )
        : null,
    candidateScores: selection.scores,
    authorityNote: AUTHORITY_NOTE,
  };
  return {
    state: {
      ...state,
      updatedAt: input.now,
      phase: 'check',
      decisions: [...state.decisions, decision],
    },
    decision,
    directiveNodeId: targetNode?.nodeId ?? null,
  };
}

function actionToDecisionKind(action: string): GroundedDecisionKind {
  switch (action) {
    case 'execute':
      return 'act';
    case 'inspect':
      return 'research';
    case 'clarify':
      return 'ask';
    case 'defer':
      return 'defer';
    default:
      return 'stop_safely';
  }
}

function buildDecisionCandidates(input: {
  state: GroundedExecutiveState;
  targetNode: AdaptivePlanNode | null;
  toolHealthBySubject: Record<string, GroundedToolHealth>;
  stale: number;
  missing: number;
}): AdaptiveDecisionCandidate[] {
  const { state, targetNode } = input;
  const candidates: AdaptiveDecisionCandidate[] = [];
  if (targetNode) {
    candidates.push({
      candidateId: `execute:${targetNode.nodeId}`,
      action: 'execute',
      usefulness: clamp01(0.6 + targetNode.priority * 0.4),
      successProbability: 0.7,
      cost: clamp01(targetNode.estimatedCostUnits / 20),
      latency: 0.2,
      risk: RISK_SCORE[targetNode.risk.level],
      reversibility: targetNode.mutationClass === 'none' ? 1 : 0.3,
      informationGain: 0.4,
      approvalRequired: targetNode.approvalRequired,
      toolHealth: healthFor(targetNode, input.toolHealthBySubject),
    });
  }
  candidates.push(
    {
      candidateId: 'research:evidence',
      action: 'inspect',
      usefulness: clamp01(0.3 + input.missing * 0.2 + input.stale * 0.1),
      successProbability: 0.8,
      cost: 0.1,
      latency: 0.2,
      risk: 0.05,
      reversibility: 1,
      informationGain: clamp01(0.5 + input.missing * 0.2),
      approvalRequired: false,
      toolHealth: 'healthy',
    },
    {
      candidateId: 'ask:user',
      action: 'clarify',
      usefulness: clamp01(
        state.frame.ambiguity === 'blocking'
          ? 0.9
          : state.frame.ambiguity === 'resolvable'
            ? 0.55
            : 0.15,
      ),
      successProbability: 0.85,
      cost: 0.15,
      latency: 0.5,
      risk: 0.05,
      reversibility: 1,
      informationGain: state.frame.ambiguity === 'clear' ? 0.2 : 0.7,
      approvalRequired: false,
      toolHealth: 'healthy',
    },
    {
      candidateId: 'defer:step',
      action: 'defer',
      usefulness: 0.2,
      successProbability: 0.9,
      cost: 0.05,
      latency: 0.8,
      risk: 0.02,
      reversibility: 1,
      informationGain: 0.05,
      approvalRequired: false,
      toolHealth: 'healthy',
    },
    {
      candidateId: 'stop:safely',
      action: 'stop',
      usefulness: 0.1,
      successProbability: 1,
      cost: 0,
      latency: 0,
      risk: 0,
      reversibility: 1,
      informationGain: 0,
      approvalRequired: false,
      toolHealth: 'healthy',
    },
  );
  return candidates.slice(0, 20);
}

export interface ApplyGroundedOutcomeInput {
  observation: AdaptiveNodeObservation;
  now: string;
  decisionId?: string | null;
}

export interface GroundedOutcomeResult {
  state: GroundedExecutiveState;
  verification: GroundedOutcomeVerification;
}

/**
 * Verifies an executed step against its expected outcome. A technically
 * successful tool call is not treated as goal progress unless it produced
 * admissible evidence for the criteria the step was meant to satisfy.
 */
export function applyGroundedOutcome(
  state: GroundedExecutiveState,
  input: ApplyGroundedOutcomeInput,
): GroundedOutcomeResult {
  const nowFn = () => input.now;
  const evidence = state.evidenceRecords.map((record) => record.evidence);
  const directive = advanceAdaptiveCognition({
    frame: state.frame,
    graph: state.graph,
    beliefs: state.beliefs,
    evidence,
    now: nowFn,
  });
  if (directive.kind !== 'execute_node' || !directive.node) {
    const verification = buildVerification({
      state,
      nodeId: state.graph.verificationNodeId,
      verdict: 'blocked',
      expected: 'An executable plan node ready for an observation.',
      actual: `Plan status is ${directive.result.status}; no node was awaiting execution.`,
      causalExplanation:
        'The observation arrived while no plan step was executable, so it cannot verify any step.',
      invalidatedBeliefIds: [],
      replanTriggered: false,
      calibrationSampleId: null,
      now: input.now,
    });
    return {
      state: {
        ...state,
        updatedAt: input.now,
        verifications: [...state.verifications, verification],
      },
      verification,
    };
  }
  const node = directive.node;
  const revisionCountBefore = state.graph.revisions.length;
  const beforeTiers = tierByBeliefId(state.beliefs, evidence);
  const contradictedBefore = new Set(
    state.beliefs
      .filter((belief) => belief.state === 'contradicted')
      .map((belief) => belief.beliefId),
  );
  const result = applyAdaptiveNodeObservation({
    frame: state.frame,
    graph: directive.result.graph,
    nodeId: node.nodeId,
    observation: input.observation,
    beliefs: directive.result.beliefs,
    evidence: directive.result.evidence,
    now: nowFn,
  });
  const admissibleForGoal = input.observation.evidence.filter(
    (item) =>
      isAdmissibleGroundedEvidence(item) &&
      (node.producesCriterionIds.length === 0 ||
        item.supportsCriterionIds.some((criterionId) =>
          node.producesCriterionIds.includes(criterionId),
        )),
  );
  const verdict = outcomeVerdict(input.observation, admissibleForGoal.length);
  const invalidatedBeliefIds = result.beliefs
    .filter(
      (belief) =>
        belief.state === 'contradicted' &&
        !contradictedBefore.has(belief.beliefId),
    )
    .map((belief) => belief.beliefId);
  const replanTriggered = result.graph.revisions
    .slice(revisionCountBefore)
    .some((revision) => ['replan', 'retry'].includes(revision.kind));
  const decision =
    (input.decisionId
      ? state.decisions.find((item) => item.decisionId === input.decisionId)
      : null) ??
    [...state.decisions].reverse().find((item) => item.kind === 'act') ??
    null;
  const calibrationSample: GroundedCalibrationSample | null = decision
    ? {
        sampleId: hashId(
          'grounded:sample',
          `${state.stateId}|${node.nodeId}|${input.now}|${verdict}`,
        ),
        createdAt: input.now,
        contextKey: state.contextKey,
        predictedConfidence: decision.confidence,
        outcome: verdict === 'verified' ? 1 : 0,
        verdict,
        source: 'outcome_verification',
        decisionId: decision.decisionId,
        verificationId: null,
      }
    : null;
  const verification = buildVerification({
    state,
    nodeId: node.nodeId,
    verdict,
    expected: node.expectedObservation,
    actual: bounded(input.observation.summary),
    causalExplanation: causalExplanationFor({
      node,
      observation: input.observation,
      verdict,
      admissibleCount: admissibleForGoal.length,
      invalidatedBeliefIds,
      replanTriggered,
    }),
    invalidatedBeliefIds,
    replanTriggered,
    calibrationSampleId: calibrationSample?.sampleId ?? null,
    now: input.now,
  });
  if (calibrationSample) {
    calibrationSample.verificationId = verification.verificationId;
  }
  const observationRecords: GroundedEvidenceRecord[] =
    input.observation.evidence.map((item) => ({
      evidence: item,
      disproofConditions: [],
      staleAfterMs: null,
    }));
  const knownIds = new Set(
    state.evidenceRecords.map((record) => record.evidence.evidenceId),
  );
  const mergedEvidenceRecords = [
    ...state.evidenceRecords,
    ...observationRecords.filter(
      (record) => !knownIds.has(record.evidence.evidenceId),
    ),
  ];
  const changes = journalBeliefChanges({
    beforeTiers,
    afterBeliefs: result.beliefs,
    afterEvidence: result.evidence,
    newContradictionIds: invalidatedBeliefIds,
    staleChangedEvidenceIds: [],
    cause: 'verification',
    now: input.now,
  });
  const nextState: GroundedExecutiveState = {
    ...state,
    updatedAt: input.now,
    phase: 'verify',
    graph: result.graph,
    beliefs: result.beliefs,
    evidenceRecords: mergedEvidenceRecords,
    contradictionIds: Array.from(
      new Set([...state.contradictionIds, ...invalidatedBeliefIds]),
    ),
    verifications: [...state.verifications, verification],
    calibrationSamples: calibrationSample
      ? [...state.calibrationSamples, calibrationSample]
      : state.calibrationSamples,
    beliefJournal: [...state.beliefJournal, ...changes].slice(
      -MAX_JOURNAL_ENTRIES,
    ),
  };
  return { state: nextState, verification };
}

function outcomeVerdict(
  observation: AdaptiveNodeObservation,
  admissibleForGoalCount: number,
): GroundedOutcomeVerdict {
  switch (observation.status) {
    case 'success':
      return admissibleForGoalCount > 0 ? 'verified' : 'uncertain';
    case 'degraded':
      return 'partial';
    case 'retryable_failure':
    case 'terminal_failure':
    case 'contradiction':
      return 'failed';
    case 'approval_required':
    case 'needs_clarification':
      return 'blocked';
    default:
      return 'uncertain';
  }
}

function causalExplanationFor(input: {
  node: AdaptivePlanNode;
  observation: AdaptiveNodeObservation;
  verdict: GroundedOutcomeVerdict;
  admissibleCount: number;
  invalidatedBeliefIds: string[];
  replanTriggered: boolean;
}): string {
  const step = `Step "${input.node.title}"`;
  switch (input.verdict) {
    case 'verified':
      return `${step} succeeded and produced ${input.admissibleCount} admissible evidence item(s) for its target criteria.`;
    case 'uncertain':
      return `${step} completed technically, but produced no admissible evidence that its goal criteria were met, so goal achievement remains unverified.`;
    case 'partial':
      return `${step} partially succeeded: ${bounded(input.observation.summary, 200)}; the unmet portion still needs admissible evidence.`;
    case 'blocked':
      return `${step} stopped before effect: ${bounded(input.observation.summary, 200)}.`;
    default:
      return `${step} failed (${input.observation.failureClass ?? 'unnamed failure'})${
        input.invalidatedBeliefIds.length
          ? `, contradicting ${input.invalidatedBeliefIds.length} prior belief(s)`
          : ''
      }${input.replanTriggered ? '; the plan activated its bounded fallback' : ''}.`;
  }
}

function buildVerification(input: {
  state: GroundedExecutiveState;
  nodeId: string;
  verdict: GroundedOutcomeVerdict;
  expected: string;
  actual: string;
  causalExplanation: string;
  invalidatedBeliefIds: string[];
  replanTriggered: boolean;
  calibrationSampleId: string | null;
  now: string;
}): GroundedOutcomeVerification {
  return {
    verificationId: hashId(
      'grounded:verification',
      `${input.state.stateId}|${input.nodeId}|${input.now}|${input.state.verifications.length}`,
    ),
    createdAt: input.now,
    nodeId: input.nodeId,
    verdict: input.verdict,
    expected: bounded(input.expected),
    actual: bounded(input.actual),
    causalExplanation: bounded(input.causalExplanation),
    invalidatedBeliefIds: input.invalidatedBeliefIds,
    replanTriggered: input.replanTriggered,
    calibrationSampleId: input.calibrationSampleId,
  };
}

/** Completion check bound to the original frame contract. */
export function verifyGroundedCompletion(state: GroundedExecutiveState): {
  state: GroundedExecutiveState;
  report: AdaptiveVerificationReport;
} {
  const report = verifyAdaptiveCompletion({
    frame: state.frame,
    evidence: state.evidenceRecords.map((record) => record.evidence),
    beliefs: state.beliefs,
  });
  return {
    state: report.completionAuthorized ? { ...state, phase: 'done' } : state,
    report,
  };
}

export interface ApplyGroundedCorrectionInput {
  verificationId: string;
  correctedOutcome: 0 | 1;
  evidence: GroundedEvidenceRecord[];
  reason: string;
  now: string;
}

/**
 * Records an attested correction of a prior outcome: the corrected result
 * becomes a new calibration sample (the original stays visible), the
 * corrective evidence flows through normal belief reconciliation, and a
 * calibration learning record is derived.
 */
export function applyGroundedCorrection(
  state: GroundedExecutiveState,
  input: ApplyGroundedCorrectionInput,
): GroundedObservationResult & {
  correctionSample: GroundedCalibrationSample | null;
} {
  const target = state.verifications.find(
    (item) => item.verificationId === input.verificationId,
  );
  const observed = observeGroundedEvidence(
    state,
    input.evidence,
    input.now,
    'correction',
  );
  if (!target) {
    return { ...observed, correctionSample: null };
  }
  const original = state.calibrationSamples.find(
    (sample) => sample.verificationId === target.verificationId,
  );
  const correctionSample: GroundedCalibrationSample = {
    sampleId: hashId(
      'grounded:sample',
      `${state.stateId}|correction|${target.verificationId}|${input.now}`,
    ),
    createdAt: input.now,
    contextKey: state.contextKey,
    predictedConfidence: original?.predictedConfidence ?? 0.5,
    outcome: input.correctedOutcome,
    verdict: input.correctedOutcome === 1 ? 'verified' : 'failed',
    source: 'correction',
    decisionId: original?.decisionId ?? null,
    verificationId: target.verificationId,
  };
  const lesson: GroundedLearningRecord = {
    recordId: hashId(
      'grounded:learning',
      `${state.stateId}|calibration|${target.verificationId}|${input.now}`,
    ),
    createdAt: input.now,
    kind: 'calibration',
    status: 'proposed',
    subject: bounded(target.nodeId, 180),
    contextKey: state.contextKey,
    lesson: bounded(
      `A ${target.verdict} verdict was corrected to ${correctionSample.verdict} by attested evidence: ${input.reason}`,
    ),
    evidenceRefs: dedupe(
      input.evidence.map((record) => record.evidence.evidenceId),
    ),
    counterEvidenceRefs: [],
    appliesToAuthority: false,
    reviewNote: null,
    sourceTurnId: state.turnRef,
  };
  return {
    ...observed,
    state: {
      ...observed.state,
      calibrationSamples: [
        ...observed.state.calibrationSamples,
        correctionSample,
      ],
      learning: [...observed.state.learning, lesson],
    },
    correctionSample,
  };
}

/** Derives reviewable, authority-free lessons from a verified outcome. */
export function deriveGroundedLearning(
  state: GroundedExecutiveState,
  verification: GroundedOutcomeVerification,
  now: string,
): GroundedLearningRecord[] {
  const node = state.graph.nodes.find(
    (item) => item.nodeId === verification.nodeId,
  );
  const records: GroundedLearningRecord[] = [];
  const push = (
    kind: GroundedLearningKind,
    subject: string,
    lesson: string,
  ): void => {
    records.push({
      recordId: hashId(
        'grounded:learning',
        `${state.stateId}|${kind}|${subject}|${verification.verificationId}|${now}`,
      ),
      createdAt: now,
      kind,
      status: 'proposed',
      subject: bounded(subject, 180),
      contextKey: state.contextKey,
      lesson: bounded(lesson),
      evidenceRefs: dedupe([verification.verificationId]),
      counterEvidenceRefs: [],
      appliesToAuthority: false,
      reviewNote: null,
      sourceTurnId: state.turnRef,
    });
  };
  if (verification.verdict === 'uncertain') {
    push(
      'missing_evidence',
      node?.toolId ?? verification.nodeId,
      `Technical success did not include admissible goal evidence; future plans should require evidence for ${node?.producesCriterionIds.join(', ') || 'the target criteria'} in the step contract.`,
    );
  }
  if (
    verification.verdict === 'failed' &&
    verification.invalidatedBeliefIds.length > 0
  ) {
    push(
      'wrong_assumption',
      verification.invalidatedBeliefIds[0]!,
      `An assumed belief was contradicted by the outcome: ${verification.causalExplanation}`,
    );
  }
  if (['failed', 'partial'].includes(verification.verdict) && node?.toolId) {
    push(
      'tool_reliability',
      node.toolId,
      `Tool ${node.toolId} produced a ${verification.verdict} outcome in context ${state.contextKey}.`,
    );
  }
  if (verification.replanTriggered) {
    push(
      'plan_pattern',
      node?.title ?? verification.nodeId,
      `The primary step failed and the bounded fallback path was activated; this dependency deserves a precondition check next time.`,
    );
  }
  return records;
}

/**
 * Learning may only reshape planning estimates (success probability, tool
 * health, information gain). Approval requirements and action identity pass
 * through untouched — learning can never expand authority.
 */
export function applyGroundedLearningToPlanning(
  records: GroundedLearningRecord[],
  candidates: AdaptiveDecisionCandidate[],
): AdaptiveDecisionCandidate[] {
  const accepted = records.filter((record) => record.status === 'accepted');
  if (accepted.length === 0) return candidates;
  return candidates.map((candidate) => {
    const toolLessons = accepted.filter(
      (record) =>
        record.kind === 'tool_reliability' &&
        candidate.candidateId.includes(record.subject),
    );
    const evidenceLessons = accepted.filter(
      (record) => record.kind === 'missing_evidence',
    );
    if (toolLessons.length === 0 && evidenceLessons.length === 0) {
      return candidate;
    }
    return {
      ...candidate,
      successProbability: clamp01(
        candidate.successProbability - toolLessons.length * 0.15,
      ),
      toolHealth:
        toolLessons.length > 0 && candidate.toolHealth === 'healthy'
          ? ('degraded' as const)
          : candidate.toolHealth,
      informationGain:
        candidate.action === 'inspect'
          ? clamp01(candidate.informationGain + evidenceLessons.length * 0.1)
          : candidate.informationGain,
    };
  });
}

export interface GroundedBeliefExplanation {
  beliefId: string;
  statement: string;
  tier: GroundedBeliefTier;
  confidence: number;
  state: AdaptiveBeliefClaim['state'];
  supportingEvidence: Array<{
    evidenceId: string;
    evidenceClass: AdaptiveEvidenceClass;
    source: string;
    freshness: AdaptiveEvidence['freshness'];
    confidence: number;
  }>;
  contradictingEvidence: Array<{
    evidenceId: string;
    evidenceClass: AdaptiveEvidenceClass;
    source: string;
    freshness: AdaptiveEvidence['freshness'];
    confidence: number;
  }>;
  whatWouldChangeMind: string[];
  history: GroundedBeliefChange[];
}

/** "Why does Andrea believe this?" */
export function explainGroundedBelief(
  state: GroundedExecutiveState,
  beliefId: string,
): GroundedBeliefExplanation | null {
  const belief = state.beliefs.find((item) => item.beliefId === beliefId);
  if (!belief) return null;
  const evidence = state.evidenceRecords.map((record) => record.evidence);
  const describe = (evidenceId: string) => {
    const item = evidence.find((entry) => entry.evidenceId === evidenceId);
    return item
      ? {
          evidenceId: item.evidenceId,
          evidenceClass: item.evidenceClass,
          source: item.source,
          freshness: item.freshness,
          confidence: item.confidence,
        }
      : null;
  };
  const tier = groundedBeliefTier(belief, evidence);
  const disproofs = state.evidenceRecords
    .filter((record) =>
      belief.supportingEvidenceIds.includes(record.evidence.evidenceId),
    )
    .flatMap((record) => record.disproofConditions);
  return {
    beliefId,
    statement: `${belief.subject} ${belief.predicate} ${belief.value}`,
    tier,
    confidence: belief.confidence,
    state: belief.state,
    supportingEvidence: belief.supportingEvidenceIds
      .map(describe)
      .filter((item): item is NonNullable<typeof item> => item !== null),
    contradictingEvidence: belief.contradictingEvidenceIds
      .map(describe)
      .filter((item): item is NonNullable<typeof item> => item !== null),
    whatWouldChangeMind: dedupe([
      ...disproofs,
      ...(tier === 'verified'
        ? [
            'Fresh admissible evidence asserting a different value for this claim.',
          ]
        : [
            'Fresh observed or user-attested evidence confirming or refuting this claim.',
          ]),
    ]),
    history: state.beliefJournal.filter((entry) => entry.beliefId === beliefId),
  };
}

/** "Why did Andrea choose this?" */
export function explainGroundedDecision(
  state: GroundedExecutiveState,
  decisionId: string,
): GroundedDecision | null {
  return (
    state.decisions.find((decision) => decision.decisionId === decisionId) ??
    null
  );
}

export interface GroundedExecutiveDiagnostics {
  stateId: string;
  version: string;
  phase: GroundedExecutivePhase;
  objective: string;
  contextKey: string;
  beliefs: Array<{
    beliefId: string;
    statement: string;
    tier: GroundedBeliefTier;
    confidence: number;
    contradicted: boolean;
  }>;
  contradictionCount: number;
  staleEvidenceCount: number;
  decisions: GroundedDecision[];
  verifications: GroundedOutcomeVerification[];
  learningCount: number;
  calibration: AdaptiveCalibrationReport;
  privacy: typeof ADAPTIVE_COGNITION_PRIVACY;
}

export function groundedExecutiveDiagnostics(
  state: GroundedExecutiveState,
): GroundedExecutiveDiagnostics {
  const evidence = state.evidenceRecords.map((record) => record.evidence);
  return {
    stateId: state.stateId,
    version: state.version,
    phase: state.phase,
    objective: state.frame.objective,
    contextKey: state.contextKey,
    beliefs: state.beliefs.map((belief) => ({
      beliefId: belief.beliefId,
      statement: `${belief.subject} ${belief.predicate} ${belief.value}`,
      tier: groundedBeliefTier(belief, evidence),
      confidence: belief.confidence,
      contradicted: belief.state === 'contradicted',
    })),
    contradictionCount: currentContradictionCount(state),
    staleEvidenceCount: staleSignalCount(state),
    decisions: state.decisions,
    verifications: state.verifications,
    learningCount: state.learning.length,
    calibration: computeAdaptiveCalibration(
      state.calibrationSamples.map(
        (sample): AdaptiveCalibrationSample => ({
          confidence: sample.predictedConfidence,
          outcome: sample.outcome,
        }),
      ),
    ),
    privacy: ADAPTIVE_COGNITION_PRIVACY,
  };
}

export function formatGroundedDiagnostics(
  diagnostics: GroundedExecutiveDiagnostics,
): string {
  const lines: string[] = [
    `Grounded executive ${diagnostics.stateId} (v${diagnostics.version}) — phase ${diagnostics.phase}`,
    `Objective: ${diagnostics.objective}`,
    `Beliefs (${diagnostics.beliefs.length}):`,
    ...diagnostics.beliefs.map(
      (belief) =>
        `  [${belief.tier}${belief.contradicted ? ', contradicted' : ''}] ${belief.statement} (confidence ${belief.confidence.toFixed(2)})`,
    ),
    `Contradictions: ${diagnostics.contradictionCount}; stale evidence: ${diagnostics.staleEvidenceCount}`,
    `Decisions:`,
    ...diagnostics.decisions.map(
      (decision) =>
        `  [${decision.kind}] ${decision.reason} (confidence ${decision.confidence.toFixed(2)})`,
    ),
    `Verifications:`,
    ...diagnostics.verifications.map(
      (verification) =>
        `  [${verification.verdict}] ${verification.causalExplanation}`,
    ),
    `Learning records: ${diagnostics.learningCount}`,
    `Calibration: ${diagnostics.calibration.sampleCount} sample(s), Brier ${diagnostics.calibration.brierScore.toFixed(3)}, ECE ${diagnostics.calibration.expectedCalibrationError.toFixed(3)}`,
  ];
  return lines.join('\n');
}

/** Convenience wrapper for calibration over the state's samples. */
export function groundedCalibrationReport(
  state: GroundedExecutiveState,
): AdaptiveCalibrationReport {
  return computeAdaptiveCalibration(
    state.calibrationSamples.map(
      (sample): AdaptiveCalibrationSample => ({
        confidence: sample.predictedConfidence,
        outcome: sample.outcome,
      }),
    ),
  );
}
