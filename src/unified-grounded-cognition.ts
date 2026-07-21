import { createHash } from 'node:crypto';

import {
  groundedEvidence,
  type GroundedDecision,
  type GroundedDecisionKind,
  type GroundedEvidenceRecord,
  type GroundedLearningRecord,
} from './grounded-cognitive-executive.js';
import type {
  GroundedContextBundle,
  GroundedContextGoalItem,
} from './grounded-memory.js';
import {
  decomposeGroundedIntents,
  type GroundedIntentClause,
  type GroundedResponseContract,
  type GroundedResponseEvaluation,
} from './grounded-response-intelligence.js';
import type { PersonalContextPacket, RealitySensitivity } from './types.js';

/**
 * Unified Grounded Cognition is a coordinator, not another executive. It
 * selects and arbitrates one bounded evidence view, projects that view into
 * the existing grounded executive and response intelligence, and receives
 * their decisions and outcome evaluations back into one reviewable frame.
 * It owns no tools, approvals, credentials, routes, durable work, or delivery.
 */
export const UNIFIED_GROUNDED_COGNITION_VERSION = '1.0.0';
export const UNIFIED_MAX_EVIDENCE = 32;
export const UNIFIED_MAX_CONTEXT_CHARS = 10_000;
export const UNIFIED_MAX_EVIDENCE_PER_SOURCE = 10;
export const UNIFIED_MAX_GOALS = 12;
export const UNIFIED_MAX_COMMITMENTS = 10;
export const UNIFIED_MAX_DIAGNOSTIC_CHARS = 12_000;
export const UNIFIED_MAX_PERSISTED_METADATA_CHARS = 6_000;

export type UnifiedGroundedCognitionMode = 'off' | 'shadow' | 'assistive';
export type UnifiedCognitivePhase =
  | 'observe'
  | 'orient'
  | 'deliberate'
  | 'advise'
  | 'verify'
  | 'learn';
export type UnifiedEvidenceSourceClass =
  | 'current_user_statement'
  | 'recent_direct_observation'
  | 'verified_provider_receipt'
  | 'verified_goal_outcome'
  | 'accepted_durable_memory'
  | 'reviewed_inference'
  | 'unresolved_assumption'
  | 'tool_health_observation'
  | 'route_health_observation'
  | 'approval_record'
  | 'commitment_or_goal';
export type UnifiedEpistemicStatus =
  | 'direct'
  | 'observed'
  | 'verified'
  | 'accepted'
  | 'inferred'
  | 'assumed';
export type UnifiedEvidenceFreshness =
  | 'fresh'
  | 'stale'
  | 'expired'
  | 'unknown'
  | 'not_applicable';
export type UnifiedArbitrationOutcome =
  | 'accepted'
  | 'accepted_with_uncertainty'
  | 'superseded'
  | 'stale'
  | 'contradicted'
  | 'irrelevant'
  | 'privacy_excluded'
  | 'scope_excluded'
  | 'insufficient_evidence'
  | 'requires_user_clarification';
export type UnifiedResponsePosture =
  | 'answer_directly'
  | 'ask_clarification'
  | 'research_read_only'
  | 'present_plan'
  | 'request_approval'
  | 'defer_missing_precondition'
  | 'report_partial_progress'
  | 'report_verified_completion'
  | 'stop_safely';

export interface UnifiedEvidenceScope {
  actorId: string | null;
  chatId: string | null;
  groupFolder: string | null;
  channel: string;
}

export interface UnifiedEvidenceReference {
  evidenceId: string;
  sourceClass: UnifiedEvidenceSourceClass;
  sourceRecordId: string | null;
  subject: string;
  scope: UnifiedEvidenceScope;
  /** Bounded and secret-redacted. Never persist a raw message body. */
  claim: string;
  value: string;
  epistemicStatus: UnifiedEpistemicStatus;
  confidence: number;
  observedAt: string;
  expiresAt: string | null;
  freshness: UnifiedEvidenceFreshness;
  provenanceRefs: string[];
  contradictsEvidenceIds: string[];
  supersedesEvidenceIds: string[];
  sensitivity: RealitySensitivity;
  mayStateToUser: boolean;
  mayInfluencePlanning: boolean;
  whatWouldChangeIt: string;
}

export interface UnifiedEvidenceArbitration {
  arbitrationId: string;
  subject: string;
  evidenceIds: string[];
  outcome: UnifiedArbitrationOutcome;
  acceptedEvidenceId: string | null;
  reason: string;
  requiresDisclosure: boolean;
}

export interface UnifiedExcludedEvidence {
  ref: string;
  sourceClass: UnifiedEvidenceSourceClass | 'grounded_memory_policy';
  reason: string;
}

export interface UnifiedGoalProjection {
  goalId: string;
  parentGoalId: string | null;
  title: string;
  objective: string;
  state: GroundedContextGoalItem['state'];
  stateReason: string;
  owner: 'user' | 'andrea_proposed';
  nextAction: string | null;
  blockers: string[];
  approvalState: 'not_applicable';
  deadlineOrFollowupAt: string | null;
  supportingEvidenceRefs: string[];
  successCriteria: string[];
  verifiedProgress: string | null;
  verifiedCompletion: boolean;
  unresolvedUserDecision: string | null;
  executionAuthority: false;
}

export interface UnifiedCommitmentProjection {
  commitmentId: string;
  subject: string;
  summary: string;
  state: 'active' | 'blocked' | 'completed' | 'cancelled' | 'uncertain';
  evidenceRefs: string[];
  nextAction: string | null;
  followupAt: string | null;
}

export interface UnifiedModuleRecommendation {
  module:
    | 'platform_deliberation'
    | 'provider_council'
    | 'cognitive_kernel'
    | 'logic_kernel'
    | 'runtime_spine'
    | 'grounded_executive'
    | 'grounded_response_intelligence'
    | 'tool_reliability'
    | 'metacognition';
  posture: UnifiedResponsePosture;
  confidence: number;
  reason: string;
  evidenceRefs: string[];
  advisoryOnly: true;
}

export interface UnifiedModuleDisagreement {
  disagreementId: string;
  modules: UnifiedModuleRecommendation['module'][];
  postures: UnifiedResponsePosture[];
  resolution: UnifiedResponsePosture;
  reason: string;
}

export interface UnifiedOutcomeObservation {
  observedAt: string;
  routeUsed: string;
  blockerClass: string | null;
  toolCallAccepted: boolean;
  toolReturnedSuccess: boolean;
  providerReceiptObserved: boolean;
  requestedOutcomeVerified: boolean;
  goalAchieved: boolean;
  goalFailureVerified: boolean;
  responseStatus: 'pass' | 'warn' | 'block';
  partial: boolean;
  evidenceRefs: string[];
  explanation: string;
}

export type UnifiedLearningKind =
  | 'response_quality'
  | 'intent_coverage'
  | 'evidence_calibration'
  | 'tool_reliability'
  | 'goal_follow_through'
  | 'owner_correction'
  | 'clarification_efficiency'
  | 'recommendation_calibration';

export interface UnifiedLearningCandidate {
  candidateId: string;
  kind: UnifiedLearningKind;
  createdAt: string;
  subject: string;
  lesson: string;
  confidence: number;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
  scopeKey: string;
  reversible: true;
  reviewRequired: true;
  promotionStatus: 'proposed';
  syntheticProductionEligible: false;
  executionAuthority: false;
}

export interface UnifiedCognitiveTraceLinks {
  frameId: string;
  turnId: string;
  groundedExecutiveStateId: string | null;
  groundedDecisionId: string | null;
  deliberationPacketId: string | null;
  responseEvaluationId: string | null;
  cognitiveRunId: string | null;
  durableWorkId: string | null;
  providerReceiptIds: string[];
  goalIds: string[];
  commitmentIds: string[];
  learningCandidateIds: string[];
}

export interface UnifiedCognitiveBudgets {
  evidenceCount: number;
  evidenceLimit: number;
  contextChars: number;
  contextCharLimit: number;
  goalCount: number;
  goalLimit: number;
  commitmentCount: number;
  commitmentLimit: number;
  perSourceLimit: number;
  diagnosticCharLimit: number;
  persistedMetadataCharLimit: number;
  truncated: boolean;
}

export interface UnifiedGroundedCognitiveFrame {
  frameId: string;
  fingerprint: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  turnId: string;
  conversationId: string;
  channel: string;
  actorId: string | null;
  groupFolder: string | null;
  runOrigin: 'live' | 'replay' | 'synthetic';
  taskFamily: string;
  mode: UnifiedGroundedCognitionMode;
  /** In-memory only and bounded/redacted; diagnostics and metadata omit it. */
  originalRequest: string;
  completedPhases: UnifiedCognitivePhase[];
  intents: GroundedIntentClause[];
  evidence: UnifiedEvidenceReference[];
  excludedEvidence: UnifiedExcludedEvidence[];
  arbitrations: UnifiedEvidenceArbitration[];
  goals: UnifiedGoalProjection[];
  commitments: UnifiedCommitmentProjection[];
  moduleRecommendations: UnifiedModuleRecommendation[];
  moduleDisagreements: UnifiedModuleDisagreement[];
  chosenPosture: UnifiedResponsePosture;
  postureReason: string;
  responseRequirements: GroundedResponseContract | null;
  prohibitedCompletionClaims: string[];
  approvalBoundaries: string[];
  verificationRequirements: string[];
  responseEvaluation: GroundedResponseEvaluation | null;
  outcome: UnifiedOutcomeObservation | null;
  followThrough: string[];
  learningCandidates: UnifiedLearningCandidate[];
  /** Owner-accepted adaptive lessons projected as bounded advice only. */
  acceptedLearningGuidance: string[];
  appliedLearningCandidateIds: string[];
  trace: UnifiedCognitiveTraceLinks;
  budgets: UnifiedCognitiveBudgets;
  invariants: {
    executionAuthority: false;
    approvalAuthority: false;
    deliveryAuthority: false;
    learningPromotionAuthority: false;
    rawPrivateContentPersisted: false;
    toolSuccessIsGoalSuccess: false;
  };
  authorityStatement: string;
}

export interface BuildUnifiedGroundedCognitiveFrameInput {
  turnId: string;
  conversationId?: string | null;
  channel: string;
  actorId?: string | null;
  groupFolder?: string | null;
  text: string;
  now?: string;
  runOrigin?: 'live' | 'replay' | 'synthetic';
  taskFamily: string;
  requestRoute?: string | null;
  mode?: UnifiedGroundedCognitionMode;
  memoryBundle?: GroundedContextBundle | null;
  personalContextPacket?: PersonalContextPacket | null;
  routeHealth?: Array<{ route: string; status: string; detail?: string }>;
  toolHealth?: Array<{ tool: string; status: string; detail?: string }>;
  blockers?: string[];
  approvalRequired?: boolean;
  moduleRecommendations?: UnifiedModuleRecommendation[];
  additionalEvidence?: UnifiedEvidenceReference[];
  cognitiveRunId?: string | null;
  durableWorkId?: string | null;
}

const SECRET_PATTERN =
  /\b(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]\s*\S+/gi;
const SOURCE_PRIORITY: Record<UnifiedEvidenceSourceClass, number> = {
  current_user_statement: 6,
  recent_direct_observation: 5,
  verified_provider_receipt: 5,
  verified_goal_outcome: 5,
  accepted_durable_memory: 4,
  commitment_or_goal: 4,
  reviewed_inference: 2,
  tool_health_observation: 3,
  route_health_observation: 3,
  approval_record: 4,
  unresolved_assumption: 1,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function bounded(value: unknown, limit = 360): string {
  const normalized = String(value ?? '')
    .replace(SECRET_PATTERN, '[redacted secret]')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
    : normalized;
}

function unique(
  values: Array<string | null | undefined>,
  limit = 32,
): string[] {
  return Array.from(
    new Set(values.map((value) => bounded(value, 300)).filter(Boolean)),
  ).slice(0, limit);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function scopeFor(
  input: BuildUnifiedGroundedCognitiveFrameInput,
): UnifiedEvidenceScope {
  return {
    actorId: input.actorId ?? null,
    chatId: input.conversationId ?? input.turnId,
    groupFolder: input.groupFolder ?? null,
    channel: input.channel,
  };
}

function evidence(
  input: Omit<UnifiedEvidenceReference, 'evidenceId'> & {
    evidenceId?: string;
  },
): UnifiedEvidenceReference {
  const claim = bounded(input.claim, 420);
  const value = bounded(input.value, 240);
  return {
    ...input,
    evidenceId:
      input.evidenceId ||
      stableId(
        'ugc:evidence',
        `${input.sourceClass}|${input.sourceRecordId || ''}|${input.subject}|${value}|${input.observedAt}`,
      ),
    claim,
    value,
    confidence: clamp01(input.confidence),
    provenanceRefs: unique(input.provenanceRefs, 16),
    contradictsEvidenceIds: unique(input.contradictsEvidenceIds, 16),
    supersedesEvidenceIds: unique(input.supersedesEvidenceIds, 16),
    whatWouldChangeIt: bounded(input.whatWouldChangeIt, 300),
  };
}

export function resolveUnifiedGroundedCognitionMode(
  env: NodeJS.ProcessEnv = process.env,
): UnifiedGroundedCognitionMode {
  const explicit = String(env.UNIFIED_GROUNDED_COGNITION_MODE || '')
    .trim()
    .toLowerCase();
  if (explicit === 'off' || explicit === 'assistive' || explicit === 'shadow') {
    return explicit;
  }
  // Backward-compatible transition: the legacy response mode is consulted
  // only when the unified setting is absent. Once the unified setting exists,
  // it is authoritative and validation prevents the legacy flag from being
  // more permissive.
  const legacy = String(env.GROUNDED_ADVISORY_MODE || '')
    .trim()
    .toLowerCase();
  if (legacy === 'off' || legacy === 'assistive' || legacy === 'shadow') {
    return legacy;
  }
  return 'shadow';
}

export function validateUnifiedCognitionModes(input: {
  unifiedMode: UnifiedGroundedCognitionMode;
  groundedAdvisoryMode: 'off' | 'shadow' | 'assistive';
}): {
  valid: boolean;
  reason: string;
  effectiveAdvisoryMode: 'off' | 'shadow' | 'assistive';
} {
  if (input.unifiedMode === 'off') {
    return {
      valid: input.groundedAdvisoryMode !== 'assistive',
      reason:
        input.groundedAdvisoryMode === 'assistive'
          ? 'Grounded response assistive mode cannot run while unified cognition is off.'
          : 'Unified cognition is off; grounded response remains non-assistive.',
      effectiveAdvisoryMode: 'off',
    };
  }
  if (
    input.unifiedMode === 'shadow' &&
    input.groundedAdvisoryMode === 'assistive'
  ) {
    return {
      valid: false,
      reason:
        'Grounded response assistive mode cannot exceed unified cognition shadow mode.',
      effectiveAdvisoryMode: 'shadow',
    };
  }
  return {
    valid: true,
    reason: 'Modes are compatible; the unified mode is authoritative.',
    effectiveAdvisoryMode: input.unifiedMode,
  };
}

function sourceCountWithinBudget(
  selected: UnifiedEvidenceReference[],
  sourceClass: UnifiedEvidenceSourceClass,
): boolean {
  return (
    selected.filter((item) => item.sourceClass === sourceClass).length <
    UNIFIED_MAX_EVIDENCE_PER_SOURCE
  );
}

function sameScope(
  evidenceScope: UnifiedEvidenceScope,
  expected: UnifiedEvidenceScope,
): boolean {
  if (
    evidenceScope.groupFolder &&
    expected.groupFolder &&
    evidenceScope.groupFolder !== expected.groupFolder
  ) {
    return false;
  }
  if (
    evidenceScope.actorId &&
    expected.actorId &&
    evidenceScope.actorId !== expected.actorId
  ) {
    return false;
  }
  return true;
}

function evidenceFreshnessAt(
  item: UnifiedEvidenceReference,
  now: string,
): UnifiedEvidenceFreshness {
  if (item.expiresAt && Date.parse(item.expiresAt) <= Date.parse(now)) {
    return 'expired';
  }
  return item.freshness;
}

export function arbitrateUnifiedEvidence(
  items: UnifiedEvidenceReference[],
  input: { now: string; scope: UnifiedEvidenceScope },
): {
  evidence: UnifiedEvidenceReference[];
  arbitrations: UnifiedEvidenceArbitration[];
} {
  const bySubject = new Map<string, UnifiedEvidenceReference[]>();
  for (const item of items) {
    const list = bySubject.get(item.subject) || [];
    list.push({ ...item, freshness: evidenceFreshnessAt(item, input.now) });
    bySubject.set(item.subject, list);
  }
  const arbitrations: UnifiedEvidenceArbitration[] = [];
  const selected: UnifiedEvidenceReference[] = [];
  for (const [subject, subjectItems] of Array.from(bySubject.entries()).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const ordered = [...subjectItems].sort(
      (left, right) =>
        SOURCE_PRIORITY[right.sourceClass] -
          SOURCE_PRIORITY[left.sourceClass] ||
        right.confidence - left.confidence ||
        Date.parse(right.observedAt) - Date.parse(left.observedAt) ||
        left.evidenceId.localeCompare(right.evidenceId),
    );
    const addArbitration = (
      item: UnifiedEvidenceReference,
      outcome: UnifiedArbitrationOutcome,
      reason: string,
      acceptedEvidenceId: string | null = null,
      requiresDisclosure = false,
    ): void => {
      arbitrations.push({
        arbitrationId: stableId(
          'ugc:arbitration',
          `${subject}|${item.evidenceId}|${outcome}|${reason}`,
        ),
        subject,
        evidenceIds: unique(
          [item.evidenceId, ...item.contradictsEvidenceIds],
          20,
        ),
        outcome,
        acceptedEvidenceId,
        reason: bounded(reason, 360),
        requiresDisclosure,
      });
    };
    const admissible: UnifiedEvidenceReference[] = [];
    for (const item of ordered) {
      if (item.sensitivity === 'secret') {
        addArbitration(
          item,
          'privacy_excluded',
          'Secret-sensitive evidence is excluded from the cognitive frame.',
        );
        continue;
      }
      if (
        /\b(?:ignore (?:all |the )?(?:previous|prior|system) instructions|reveal (?:the )?system prompt|bypass approval|send without approval|execute this tool call)\b/i.test(
          item.claim,
        )
      ) {
        addArbitration(
          item,
          'irrelevant',
          'Instruction-like retrieved content is treated as untrusted evidence, never as authority or executable guidance.',
        );
        continue;
      }
      if (!sameScope(item.scope, input.scope)) {
        addArbitration(
          item,
          'scope_excluded',
          'Evidence belongs to a different actor or group scope.',
        );
        continue;
      }
      if (item.freshness === 'expired' || item.freshness === 'stale') {
        addArbitration(
          item,
          'stale',
          `${item.freshness} evidence cannot establish current truth.`,
          null,
          true,
        );
        continue;
      }
      if (item.epistemicStatus === 'assumed') {
        addArbitration(
          item,
          'insufficient_evidence',
          'An unresolved assumption remains uncertainty and cannot establish fact.',
          null,
          true,
        );
        continue;
      }
      admissible.push(item);
    }
    if (admissible.length === 0) continue;
    const first = admissible[0]!;
    const explicitContradiction = admissible.some(
      (item) =>
        item.contradictsEvidenceIds.includes(first.evidenceId) ||
        first.contradictsEvidenceIds.includes(item.evidenceId),
    );
    const differingValues =
      new Set(admissible.map((item) => item.value.trim().toLowerCase())).size >
      1;
    const topPeers = admissible.filter(
      (item) =>
        SOURCE_PRIORITY[item.sourceClass] ===
          SOURCE_PRIORITY[first.sourceClass] &&
        Math.abs(item.confidence - first.confidence) <= 0.1,
    );
    if ((explicitContradiction || differingValues) && topPeers.length > 1) {
      for (const item of topPeers) {
        addArbitration(
          item,
          'contradicted',
          'Equally authoritative evidence disagrees; no value is silently selected.',
          null,
          true,
        );
      }
      const rest = admissible.filter((item) => !topPeers.includes(item));
      for (const item of rest) {
        addArbitration(
          item,
          'requires_user_clarification',
          'A higher-priority unresolved contradiction prevents this evidence from settling the subject.',
          null,
          true,
        );
      }
      continue;
    }
    const winner = first;
    const uncertain = ['inferred', 'assumed'].includes(winner.epistemicStatus);
    const acceptedWinner = {
      ...winner,
      mayStateToUser: winner.mayStateToUser && !uncertain,
    };
    selected.push(acceptedWinner);
    addArbitration(
      winner,
      uncertain ? 'accepted_with_uncertainty' : 'accepted',
      uncertain
        ? 'Best available evidence is an inference; it may guide bounded planning only with uncertainty disclosed.'
        : 'Highest-priority admissible evidence accepted for this subject.',
      winner.evidenceId,
      uncertain,
    );
    for (const item of admissible.slice(1)) {
      addArbitration(
        item,
        'superseded',
        `Higher-priority or newer evidence ${winner.evidenceId} governs this frame.`,
        winner.evidenceId,
      );
    }
  }
  return { evidence: selected, arbitrations };
}

function goalProjection(goal: GroundedContextGoalItem): UnifiedGoalProjection {
  const terminal = goal.state === 'completed' || goal.state === 'cancelled';
  return {
    goalId: goal.goalId,
    parentGoalId: goal.parentGoalId ?? null,
    title: bounded(goal.title, 240),
    objective: bounded(goal.objective || goal.title, 360),
    state: goal.state,
    stateReason: bounded(goal.stateReason || goal.inclusionReason, 300),
    owner: goal.owner || 'user',
    nextAction: terminal ? null : bounded(goal.nextProposedStep, 300) || null,
    blockers: unique(goal.blockers, 8),
    approvalState: goal.approvalState || 'not_applicable',
    deadlineOrFollowupAt: goal.reviewBy ?? null,
    supportingEvidenceRefs: unique(goal.evidenceRefs || [], 16),
    successCriteria: unique(goal.successCriteria || [], 8),
    verifiedProgress: bounded(goal.lastVerifiedOutcome, 300) || null,
    verifiedCompletion:
      goal.state === 'completed' && Boolean(goal.lastVerifiedOutcome),
    unresolvedUserDecision:
      goal.state === 'blocked'
        ? bounded(goal.blockers[0] || 'Resolve the active blocker.', 240)
        : null,
    executionAuthority: false,
  };
}

function postureFrom(input: {
  intents: GroundedIntentClause[];
  arbitrations: UnifiedEvidenceArbitration[];
  blockers: string[];
  recommendations: UnifiedModuleRecommendation[];
  goals?: UnifiedGoalProjection[];
  requestText?: string;
  approvalRequired?: boolean;
}): { posture: UnifiedResponsePosture; reason: string } {
  const stop = input.recommendations.find(
    (item) => item.posture === 'stop_safely' && item.confidence >= 0.6,
  );
  if (stop) return { posture: 'stop_safely', reason: stop.reason };
  if (
    input.arbitrations.some((item) =>
      ['contradicted', 'requires_user_clarification'].includes(item.outcome),
    )
  ) {
    return {
      posture: 'ask_clarification',
      reason:
        'Material evidence remains contradicted or requires user clarification.',
    };
  }
  const resumingTerminalGoal =
    /\b(?:continue|resume|restart|pick back up)\b/i.test(
      input.requestText || '',
    ) &&
    (input.goals || []).some((goal) =>
      ['completed', 'cancelled'].includes(goal.state),
    );
  if (resumingTerminalGoal) {
    return {
      posture: 'defer_missing_precondition',
      reason:
        'The referenced goal is terminal; a new explicit goal is required instead of silently resurrecting it.',
    };
  }
  if ((input.goals || []).some((goal) => goal.state === 'blocked')) {
    return {
      posture: 'defer_missing_precondition',
      reason:
        'An active goal is blocked and its precondition remains unresolved.',
    };
  }
  if ((input.goals || []).some((goal) => goal.state === 'stale')) {
    return {
      posture: 'research_read_only',
      reason:
        'The relevant goal is stale and needs fresh evidence before continuation.',
    };
  }
  if (input.blockers.length > 0) {
    return {
      posture: 'defer_missing_precondition',
      reason:
        'A documented blocker or missing precondition prevents completion.',
    };
  }
  if (
    input.intents.some(
      (intent) =>
        intent.actionClass === 'unknown' ||
        /^(?:it|that|them|something|the thing)$/i.test(intent.target) ||
        /^(?:(?:please\s+)?(?:send|cancel|delete|remove|move|change|update|use|handle)\s+)?(?:it|that|them|something|the thing)\b/i.test(
          intent.originalClause,
        ) ||
        /\b(?:which one|that thing|which thing)\b/i.test(intent.originalClause),
    )
  ) {
    return {
      posture: 'ask_clarification',
      reason:
        'At least one intent or target is not specific enough to preserve safely.',
    };
  }
  if (
    input.approvalRequired ||
    input.intents.some((intent) => intent.approvalRequired)
  ) {
    return {
      posture: 'request_approval',
      reason:
        'At least one mutating intent remains governed by its existing approval gate.',
    };
  }
  const outcomeReport = input.recommendations
    .filter(
      (item) =>
        item.confidence >= 0.6 &&
        ['report_partial_progress', 'report_verified_completion'].includes(
          item.posture,
        ),
    )
    .sort((left, right) => right.confidence - left.confidence)[0];
  if (outcomeReport) {
    return {
      posture: outcomeReport.posture,
      reason: `Bounded outcome recommendation from ${outcomeReport.module}: ${outcomeReport.reason}`,
    };
  }
  if (
    input.intents.some((intent) => intent.actionClass === 'research') ||
    input.arbitrations.some((item) => item.outcome === 'stale')
  ) {
    return {
      posture: 'research_read_only',
      reason:
        'The request needs current read-only evidence before a grounded answer.',
    };
  }
  const recommended = [...input.recommendations].sort(
    (left, right) => right.confidence - left.confidence,
  )[0];
  if (recommended) {
    return {
      posture: recommended.posture,
      reason: `Bounded recommendation from ${recommended.module}: ${recommended.reason}`,
    };
  }
  return {
    posture: 'answer_directly',
    reason: 'The request is sufficiently grounded for a direct response.',
  };
}

function identifyModuleDisagreements(
  recommendations: UnifiedModuleRecommendation[],
  resolution: UnifiedResponsePosture,
): UnifiedModuleDisagreement[] {
  const material = recommendations.filter((item) => item.confidence >= 0.55);
  const postures = unique(
    material.map((item) => item.posture),
  ) as UnifiedResponsePosture[];
  if (postures.length < 2) return [];
  const modules = Array.from(new Set(material.map((item) => item.module)));
  return [
    {
      disagreementId: stableId(
        'ugc:module-disagreement',
        `${modules.join(',')}|${postures.join(',')}|${resolution}`,
      ),
      modules,
      postures,
      resolution,
      reason:
        resolution === 'stop_safely'
          ? 'Safety-preserving stop advice dominates conflicting advisory recommendations.'
          : resolution === 'ask_clarification'
            ? 'Evidence ambiguity dominates lower-priority response preferences.'
            : 'The highest-confidence bounded recommendation governs; no recommendation grants execution authority.',
    },
  ];
}

function frameFingerprint(input: {
  turnId: string;
  intents: GroundedIntentClause[];
  evidence: UnifiedEvidenceReference[];
  arbitrations: UnifiedEvidenceArbitration[];
  goals: UnifiedGoalProjection[];
}): string {
  return stableId(
    'ugc:fingerprint',
    JSON.stringify({
      turnId: input.turnId,
      intents: input.intents.map((item) => [
        item.intentId,
        item.normalizedObjective,
        item.target,
      ]),
      evidence: input.evidence.map((item) => [
        item.evidenceId,
        item.sourceClass,
        item.subject,
        item.value,
      ]),
      arbitrations: input.arbitrations.map((item) => [
        item.subject,
        item.outcome,
        item.acceptedEvidenceId,
      ]),
      goals: input.goals.map((item) => [item.goalId, item.state]),
    }),
  );
}

export function buildUnifiedGroundedCognitiveFrame(
  input: BuildUnifiedGroundedCognitiveFrameInput,
): UnifiedGroundedCognitiveFrame {
  const now = input.now || new Date().toISOString();
  const mode = input.mode || resolveUnifiedGroundedCognitionMode();
  const scope = scopeFor(input);
  const intents = decomposeGroundedIntents(input.text);
  const candidates: UnifiedEvidenceReference[] = [];
  candidates.push(
    evidence({
      sourceClass: 'current_user_statement',
      sourceRecordId: input.turnId,
      subject: `turn:${input.turnId}:request`,
      scope,
      claim: input.text,
      value: input.text,
      epistemicStatus: 'direct',
      confidence: 1,
      observedAt: now,
      expiresAt: null,
      freshness: 'fresh',
      provenanceRefs: [`turn:${input.turnId}`],
      contradictsEvidenceIds: [],
      supersedesEvidenceIds: [],
      sensitivity: 'personal',
      mayStateToUser: true,
      mayInfluencePlanning: true,
      whatWouldChangeIt: 'A direct correction from the user in the same scope.',
    }),
  );
  const statedPreference = input.text.match(
    /\b(?:i|we)\s+(?:now\s+)?prefer\s+(.+?)(?:[.!?]|$)/i,
  )?.[1];
  if (statedPreference) {
    for (const prior of (input.memoryBundle?.items || [])
      .filter((item) => item.kind === 'preference')
      .slice(0, 4)) {
      candidates.push(
        evidence({
          sourceClass: 'current_user_statement',
          sourceRecordId: input.turnId,
          subject: prior.subjectKey,
          scope,
          claim: `The user now prefers ${statedPreference}.`,
          value: statedPreference,
          epistemicStatus: 'direct',
          confidence: 1,
          observedAt: now,
          expiresAt: null,
          freshness: 'fresh',
          provenanceRefs: [`turn:${input.turnId}`],
          contradictsEvidenceIds: [prior.recordId],
          supersedesEvidenceIds: [prior.recordId],
          sensitivity: 'personal',
          mayStateToUser: true,
          mayInfluencePlanning: true,
          whatWouldChangeIt: 'A later direct preference correction.',
        }),
      );
    }
  }
  for (const item of input.memoryBundle?.items || []) {
    const sourceClass: UnifiedEvidenceSourceClass =
      item.kind === 'commitment'
        ? 'commitment_or_goal'
        : item.sourceType === 'inference'
          ? 'reviewed_inference'
          : item.sourceType === 'assumption'
            ? 'unresolved_assumption'
            : item.sourceType === 'direct_observation'
              ? 'recent_direct_observation'
              : 'accepted_durable_memory';
    candidates.push(
      evidence({
        sourceClass,
        sourceRecordId: item.recordId,
        subject: item.subjectKey,
        scope,
        claim: item.statement,
        value: item.value,
        epistemicStatus:
          item.sourceType === 'inference'
            ? 'inferred'
            : item.sourceType === 'assumption'
              ? 'assumed'
              : item.sourceType === 'direct_observation'
                ? 'observed'
                : 'accepted',
        confidence: item.confidence,
        observedAt: item.observedAt,
        expiresAt: null,
        freshness: 'fresh',
        provenanceRefs: [item.recordId, ...item.provenanceRefs],
        contradictsEvidenceIds:
          input.memoryBundle?.contradictions
            .filter((entry) => entry.recordIds.includes(item.recordId))
            .flatMap((entry) =>
              entry.recordIds.filter((recordId) => recordId !== item.recordId),
            ) || [],
        supersedesEvidenceIds: [],
        sensitivity: 'personal',
        mayStateToUser: !['inference', 'assumption'].includes(item.sourceType),
        mayInfluencePlanning: true,
        whatWouldChangeIt:
          'Newer direct observation or a direct user correction for the same subject.',
      }),
    );
  }
  for (const item of (input.personalContextPacket?.items || []).slice(0, 12)) {
    candidates.push(
      evidence({
        sourceClass: 'accepted_durable_memory',
        sourceRecordId: item.itemId,
        subject: item.subjectKey || `context:${item.citation}`,
        scope: {
          ...scope,
          groupFolder:
            input.personalContextPacket?.groupFolder || scope.groupFolder,
        },
        claim: item.summary,
        value: item.summary,
        epistemicStatus: 'accepted',
        confidence: item.confidence,
        observedAt: input.personalContextPacket?.generatedAt || now,
        expiresAt: item.expiresAt || null,
        freshness: item.freshness === 'fresh' ? 'fresh' : 'stale',
        provenanceRefs: [item.citation],
        contradictsEvidenceIds:
          input.personalContextPacket?.conflicts
            .filter((conflict) => conflict.itemIds.includes(item.itemId))
            .flatMap((conflict) =>
              conflict.itemIds.filter((itemId) => itemId !== item.itemId),
            ) || [],
        supersedesEvidenceIds: [],
        sensitivity: 'personal',
        mayStateToUser: item.freshness === 'fresh' && item.confidence >= 0.65,
        mayInfluencePlanning: true,
        whatWouldChangeIt:
          'A fresher context observation or direct correction.',
      }),
    );
  }
  for (const route of (input.routeHealth || []).slice(0, 8)) {
    candidates.push(
      evidence({
        sourceClass: 'route_health_observation',
        sourceRecordId: `route:${route.route}`,
        subject: `route:${route.route}`,
        scope,
        claim: `${route.route} is ${route.status}${route.detail ? `: ${route.detail}` : ''}`,
        value: route.status,
        epistemicStatus: 'observed',
        confidence: 0.9,
        observedAt: now,
        expiresAt: null,
        freshness: 'fresh',
        provenanceRefs: [`route:${route.route}`],
        contradictsEvidenceIds: [],
        supersedesEvidenceIds: [],
        sensitivity: 'low',
        mayStateToUser: true,
        mayInfluencePlanning: true,
        whatWouldChangeIt: 'A newer route-health observation.',
      }),
    );
  }
  for (const tool of (input.toolHealth || []).slice(0, 8)) {
    candidates.push(
      evidence({
        sourceClass: 'tool_health_observation',
        sourceRecordId: `tool:${tool.tool}`,
        subject: `tool:${tool.tool}`,
        scope,
        claim: `${tool.tool} is ${tool.status}${tool.detail ? `: ${tool.detail}` : ''}`,
        value: tool.status,
        epistemicStatus: 'observed',
        confidence: 0.9,
        observedAt: now,
        expiresAt: null,
        freshness: 'fresh',
        provenanceRefs: [`tool:${tool.tool}`],
        contradictsEvidenceIds: [],
        supersedesEvidenceIds: [],
        sensitivity: 'low',
        mayStateToUser: true,
        mayInfluencePlanning: true,
        whatWouldChangeIt: 'A newer tool reliability observation.',
      }),
    );
  }
  if (input.approvalRequired) {
    candidates.push(
      evidence({
        sourceClass: 'approval_record',
        sourceRecordId: null,
        subject: `turn:${input.turnId}:approval`,
        scope,
        claim: 'The selected capability requires action-specific approval.',
        value: 'required_not_granted',
        epistemicStatus: 'observed',
        confidence: 1,
        observedAt: now,
        expiresAt: null,
        freshness: 'fresh',
        provenanceRefs: [],
        contradictsEvidenceIds: [],
        supersedesEvidenceIds: [],
        sensitivity: 'low',
        mayStateToUser: true,
        mayInfluencePlanning: true,
        whatWouldChangeIt:
          'Only the existing action-specific approval subsystem may record a valid approval.',
      }),
    );
  }
  const allGoalItems = [
    ...(input.memoryBundle?.goals || []),
    ...(input.memoryBundle?.terminalGoals || []),
  ];
  for (const goal of allGoalItems.slice(0, UNIFIED_MAX_GOALS)) {
    const terminal = goal.state === 'completed' || goal.state === 'cancelled';
    candidates.push(
      evidence({
        sourceClass: terminal ? 'verified_goal_outcome' : 'commitment_or_goal',
        sourceRecordId: goal.goalId,
        subject: `goal:${bounded(goal.title, 160).toLowerCase()}`,
        scope,
        claim: `${goal.title} is ${goal.state}${goal.stateReason ? `: ${goal.stateReason}` : ''}`,
        value: goal.state,
        epistemicStatus: terminal ? 'verified' : 'accepted',
        confidence: terminal ? 0.98 : 0.9,
        observedAt: input.memoryBundle?.generatedAt || now,
        expiresAt: null,
        freshness: goal.state === 'stale' ? 'stale' : 'fresh',
        provenanceRefs: unique([goal.goalId, ...(goal.evidenceRefs || [])], 16),
        contradictsEvidenceIds: [],
        supersedesEvidenceIds: [],
        sensitivity: 'personal',
        mayStateToUser: true,
        mayInfluencePlanning: true,
        whatWouldChangeIt:
          'A verified grounded-goal transition in the authoritative goal store.',
      }),
    );
  }
  candidates.push(
    ...(input.additionalEvidence || []).map((item) => evidence(item)),
  );
  const arbitrated = arbitrateUnifiedEvidence(candidates, { now, scope });
  const selected: UnifiedEvidenceReference[] = [];
  let contextChars = 0;
  let truncated = false;
  for (const item of arbitrated.evidence) {
    const cost = item.claim.length + item.subject.length + item.value.length;
    if (
      selected.length >= UNIFIED_MAX_EVIDENCE ||
      contextChars + cost > UNIFIED_MAX_CONTEXT_CHARS ||
      !sourceCountWithinBudget(selected, item.sourceClass)
    ) {
      truncated = true;
      continue;
    }
    selected.push(item);
    contextChars += cost;
  }
  const goals = allGoalItems.slice(0, UNIFIED_MAX_GOALS).map(goalProjection);
  const commitments = (input.memoryBundle?.items || [])
    .filter((item) => item.kind === 'commitment')
    .slice(0, UNIFIED_MAX_COMMITMENTS)
    .map(
      (item): UnifiedCommitmentProjection => ({
        commitmentId: item.recordId,
        subject: item.subjectKey,
        summary: bounded(item.statement, 300),
        state: 'active',
        evidenceRefs: unique([item.recordId, ...item.provenanceRefs], 12),
        nextAction: null,
        followupAt: null,
      }),
    );
  const recommendations = (input.moduleRecommendations || []).slice(0, 12);
  const posture = postureFrom({
    intents,
    arbitrations: arbitrated.arbitrations,
    blockers: input.blockers || [],
    recommendations,
    goals,
    requestText: input.text,
    approvalRequired: input.approvalRequired === true,
  });
  const moduleDisagreements = identifyModuleDisagreements(
    recommendations,
    posture.posture,
  );
  const excludedEvidence: UnifiedExcludedEvidence[] = [
    ...(input.memoryBundle?.excluded || []).map((item) => ({
      ref: item.recordId,
      sourceClass: 'grounded_memory_policy' as const,
      reason: item.reason,
    })),
    ...arbitrated.arbitrations
      .filter((item) =>
        [
          'stale',
          'privacy_excluded',
          'scope_excluded',
          'insufficient_evidence',
          'superseded',
          'irrelevant',
        ].includes(item.outcome),
      )
      .flatMap((item) =>
        item.evidenceIds.map((ref) => ({
          ref,
          sourceClass: 'grounded_memory_policy' as const,
          reason: item.outcome,
        })),
      ),
  ].slice(0, 48);
  const fingerprint = frameFingerprint({
    turnId: input.turnId,
    intents,
    evidence: selected,
    arbitrations: arbitrated.arbitrations,
    goals,
  });
  const frameId = stableId(
    'ugc:frame',
    `${input.turnId}|${now}|${fingerprint}`,
  );
  const terminalGoalNotes = goals
    .filter((goal) => ['completed', 'cancelled'].includes(goal.state))
    .map(
      (goal) =>
        `Do not reactivate ${goal.goalId}; it is terminal (${goal.state}).`,
    );
  return {
    frameId,
    fingerprint,
    version: UNIFIED_GROUNDED_COGNITION_VERSION,
    createdAt: now,
    updatedAt: now,
    turnId: input.turnId,
    conversationId: input.conversationId || input.turnId,
    channel: input.channel,
    actorId: input.actorId ?? null,
    groupFolder: input.groupFolder ?? null,
    runOrigin: input.runOrigin || 'live',
    taskFamily: input.taskFamily,
    mode,
    originalRequest: bounded(input.text, 2_000),
    completedPhases: ['observe', 'orient', 'deliberate', 'advise'],
    intents,
    evidence: selected,
    excludedEvidence,
    arbitrations: arbitrated.arbitrations,
    goals,
    commitments,
    moduleRecommendations: recommendations,
    moduleDisagreements,
    chosenPosture: posture.posture,
    postureReason: bounded(posture.reason, 400),
    responseRequirements: null,
    prohibitedCompletionClaims: [
      'Do not claim an external action completed without authoritative same-target evidence.',
      'Do not present inference, stale evidence, or contradiction as verified fact.',
      'Do not equate tool success or provider acceptance with goal achievement.',
      'Do not imply that this frame grants approval or execution authority.',
      ...terminalGoalNotes,
    ],
    approvalBoundaries: input.approvalRequired
      ? [
          'Action-specific approval remains required and can only be consumed by the existing approval subsystem.',
        ]
      : [],
    verificationRequirements: unique(
      intents.flatMap((intent) => intent.evidenceNeeded),
      16,
    ),
    responseEvaluation: null,
    outcome: null,
    followThrough: goals
      .filter((goal) => ['active', 'blocked', 'stale'].includes(goal.state))
      .flatMap((goal) => [
        goal.nextAction || '',
        goal.unresolvedUserDecision || '',
      ])
      .filter(Boolean)
      .slice(0, 12),
    learningCandidates: [],
    acceptedLearningGuidance: [],
    appliedLearningCandidateIds: [],
    trace: {
      frameId,
      turnId: input.turnId,
      groundedExecutiveStateId: null,
      groundedDecisionId: null,
      deliberationPacketId: null,
      responseEvaluationId: null,
      cognitiveRunId: input.cognitiveRunId ?? null,
      durableWorkId: input.durableWorkId ?? null,
      providerReceiptIds: [],
      goalIds: goals.map((goal) => goal.goalId),
      commitmentIds: commitments.map((item) => item.commitmentId),
      learningCandidateIds: [],
    },
    budgets: {
      evidenceCount: selected.length,
      evidenceLimit: UNIFIED_MAX_EVIDENCE,
      contextChars,
      contextCharLimit: UNIFIED_MAX_CONTEXT_CHARS,
      goalCount: goals.length,
      goalLimit: UNIFIED_MAX_GOALS,
      commitmentCount: commitments.length,
      commitmentLimit: UNIFIED_MAX_COMMITMENTS,
      perSourceLimit: UNIFIED_MAX_EVIDENCE_PER_SOURCE,
      diagnosticCharLimit: UNIFIED_MAX_DIAGNOSTIC_CHARS,
      persistedMetadataCharLimit: UNIFIED_MAX_PERSISTED_METADATA_CHARS,
      truncated:
        truncated ||
        allGoalItems.length > UNIFIED_MAX_GOALS ||
        commitments.length >= UNIFIED_MAX_COMMITMENTS,
    },
    invariants: {
      executionAuthority: false,
      approvalAuthority: false,
      deliveryAuthority: false,
      learningPromotionAuthority: false,
      rawPrivateContentPersisted: false,
      toolSuccessIsGoalSuccess: false,
    },
    authorityStatement:
      'This frame may understand, deliberate, advise, verify, and propose reviewable learning. It cannot call tools, authorize or consume approval, alter routes, create durable work, promote policy, or deliver anything.',
  };
}

function executivePosture(kind: GroundedDecisionKind): UnifiedResponsePosture {
  if (kind === 'ask') return 'ask_clarification';
  if (kind === 'research') return 'research_read_only';
  if (kind === 'defer') return 'defer_missing_precondition';
  if (kind === 'stop_safely') return 'stop_safely';
  return 'present_plan';
}

export function attachUnifiedGroundedDecision(
  frame: UnifiedGroundedCognitiveFrame,
  stateId: string,
  decision: GroundedDecision,
  now = frame.updatedAt,
): UnifiedGroundedCognitiveFrame {
  const recommendation: UnifiedModuleRecommendation = {
    module: 'grounded_executive',
    posture: executivePosture(decision.kind),
    confidence: decision.confidence,
    reason: bounded(decision.reason, 400),
    evidenceRefs: unique(
      frame.evidence
        .filter((item) => item.mayInfluencePlanning)
        .map((item) => item.evidenceId),
      16,
    ),
    advisoryOnly: true,
  };
  const recommendations = [
    ...frame.moduleRecommendations.filter(
      (item) => item.module !== 'grounded_executive',
    ),
    recommendation,
  ];
  const posture = postureFrom({
    intents: frame.intents,
    arbitrations: frame.arbitrations,
    blockers: frame.followThrough.filter((item) => /block/i.test(item)),
    recommendations,
    goals: frame.goals,
    requestText: frame.originalRequest,
    approvalRequired: frame.approvalBoundaries.length > 0,
  });
  const moduleDisagreements = identifyModuleDisagreements(
    recommendations,
    posture.posture,
  );
  return {
    ...frame,
    updatedAt: now,
    moduleRecommendations: recommendations,
    moduleDisagreements,
    chosenPosture: posture.posture,
    postureReason: posture.reason,
    trace: {
      ...frame.trace,
      groundedExecutiveStateId: stateId,
      groundedDecisionId: decision.decisionId,
    },
  };
}

export function attachUnifiedResponseContract(
  frame: UnifiedGroundedCognitiveFrame,
  packetId: string,
  contract: GroundedResponseContract,
  now = frame.updatedAt,
): UnifiedGroundedCognitiveFrame {
  return {
    ...frame,
    updatedAt: now,
    responseRequirements: contract,
    prohibitedCompletionClaims: unique(
      [...frame.prohibitedCompletionClaims, ...contract.prohibitedClaims],
      24,
    ),
    approvalBoundaries: unique(
      [...frame.approvalBoundaries, ...contract.approvalBoundaries],
      16,
    ),
    trace: { ...frame.trace, deliberationPacketId: packetId },
  };
}

export function attachUnifiedResponseEvaluation(
  frame: UnifiedGroundedCognitiveFrame,
  evaluation: GroundedResponseEvaluation,
  now = new Date().toISOString(),
): UnifiedGroundedCognitiveFrame {
  const evaluationId = stableId(
    'ugc:response-eval',
    `${frame.frameId}|${evaluation.status}|${evaluation.score}|${evaluation.issues.map((item) => item.kind).join(',')}`,
  );
  return {
    ...frame,
    updatedAt: now,
    completedPhases: unique([
      ...frame.completedPhases,
      'verify',
    ]) as UnifiedCognitivePhase[],
    responseEvaluation: evaluation,
    trace: { ...frame.trace, responseEvaluationId: evaluationId },
  };
}

export interface ObserveUnifiedOutcomeInput {
  observedAt?: string;
  routeUsed: string;
  blockerClass?: string | null;
  responseStatus: 'pass' | 'warn' | 'block';
  toolCallAccepted?: boolean;
  toolReturnedSuccess?: boolean;
  providerReceiptIds?: string[];
  requestedOutcomeVerified?: boolean;
  goalAchieved?: boolean;
  goalFailureVerified?: boolean;
  partial?: boolean;
  evidenceRefs?: string[];
  explicitOwnerCorrection?: string | null;
  explicitOwnerFeedback?: string | null;
  clarificationFailureCount?: number;
  recommendationFeedback?: Array<{
    recommendationId: string;
    outcome: 'accepted' | 'rejected';
    reason?: string | null;
    evidenceRefs?: string[];
  }>;
}

function learningCandidate(input: {
  frame: UnifiedGroundedCognitiveFrame;
  now: string;
  kind: UnifiedLearningKind;
  subject: string;
  lesson: string;
  confidence: number;
  evidenceRefs: string[];
}): UnifiedLearningCandidate {
  return {
    candidateId: stableId(
      'ugc:learning',
      `${input.frame.frameId}|${input.kind}|${input.subject}|${input.lesson}`,
    ),
    kind: input.kind,
    createdAt: input.now,
    subject: bounded(input.subject, 180),
    lesson: bounded(input.lesson, 420),
    confidence: clamp01(input.confidence),
    evidenceRefs: unique(input.evidenceRefs, 20),
    counterEvidenceRefs: [],
    scopeKey: `${input.frame.channel}:${input.frame.groupFolder || input.frame.conversationId}`,
    reversible: true,
    reviewRequired: true,
    promotionStatus: 'proposed',
    syntheticProductionEligible: false,
    executionAuthority: false,
  };
}

export function observeUnifiedOutcome(
  frame: UnifiedGroundedCognitiveFrame,
  input: ObserveUnifiedOutcomeInput,
): UnifiedGroundedCognitiveFrame {
  const now = input.observedAt || new Date().toISOString();
  const receiptIds = unique(input.providerReceiptIds || [], 16);
  const requestedOutcomeVerified = input.requestedOutcomeVerified === true;
  // Goal achievement requires explicit outcome verification; neither a tool
  // return nor a provider acceptance receipt is enough on its own.
  const goalAchieved = requestedOutcomeVerified && input.goalAchieved === true;
  const goalFailureVerified = input.goalFailureVerified === true;
  const outcome: UnifiedOutcomeObservation = {
    observedAt: now,
    routeUsed: bounded(input.routeUsed, 160),
    blockerClass: bounded(input.blockerClass, 160) || null,
    toolCallAccepted: input.toolCallAccepted === true,
    toolReturnedSuccess: input.toolReturnedSuccess === true,
    providerReceiptObserved: receiptIds.length > 0,
    requestedOutcomeVerified,
    goalAchieved,
    goalFailureVerified,
    responseStatus: input.responseStatus,
    partial: input.partial === true,
    evidenceRefs: unique([...(input.evidenceRefs || []), ...receiptIds], 24),
    explanation: goalAchieved
      ? 'The requested outcome and broader goal were explicitly verified.'
      : goalFailureVerified
        ? 'Authoritative outcome evidence verified that the broader goal failed.'
        : input.toolReturnedSuccess || receiptIds.length > 0
          ? 'Technical or provider success was observed, but broader goal achievement remains unverified.'
          : input.blockerClass
            ? `The outcome remains blocked by ${input.blockerClass}.`
            : 'No authoritative evidence established broader goal achievement.',
  };
  const candidates: UnifiedLearningCandidate[] = [];
  for (const issue of frame.responseEvaluation?.issues || []) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind:
          issue.kind === 'intent_missing' || issue.kind === 'target_missing'
            ? 'intent_coverage'
            : issue.kind === 'stale_memory_misuse' ||
                issue.kind === 'contradiction_undisclosed'
              ? 'evidence_calibration'
              : 'response_quality',
        subject: issue.intentId || frame.taskFamily,
        lesson: issue.detail,
        confidence: issue.severity === 'block' ? 0.9 : 0.75,
        evidenceRefs: [
          ...(issue.intentId ? [issue.intentId] : []),
          ...(frame.trace.responseEvaluationId
            ? [frame.trace.responseEvaluationId]
            : []),
        ],
      }),
    );
  }
  if (input.blockerClass) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'tool_reliability',
        subject: input.routeUsed,
        lesson: `Route ${input.routeUsed} encountered blocker ${input.blockerClass}; keep future planning evidence-gated.`,
        confidence: 0.8,
        evidenceRefs: outcome.evidenceRefs,
      }),
    );
  }
  if (
    (input.toolReturnedSuccess || receiptIds.length > 0) &&
    !requestedOutcomeVerified
  ) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'goal_follow_through',
        subject: input.routeUsed,
        lesson:
          'Technical or provider success did not verify the requested outcome; retain follow-through instead of closing the goal.',
        confidence: 0.95,
        evidenceRefs: outcome.evidenceRefs,
      }),
    );
  }
  if (input.explicitOwnerCorrection) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'owner_correction',
        subject: frame.taskFamily,
        lesson: input.explicitOwnerCorrection,
        confidence: 1,
        evidenceRefs: [`turn:${frame.turnId}`],
      }),
    );
  }
  if (input.explicitOwnerFeedback) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'response_quality',
        subject: frame.taskFamily,
        lesson: input.explicitOwnerFeedback,
        confidence: 0.95,
        evidenceRefs: [`turn:${frame.turnId}`],
      }),
    );
  }
  if ((input.clarificationFailureCount || 0) >= 2) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'clarification_efficiency',
        subject: frame.taskFamily,
        lesson:
          'Repeated clarification attempts did not resolve the target; ask one narrower evidence-seeking question or defer safely.',
        confidence: Math.min(
          0.95,
          0.65 + (input.clarificationFailureCount || 0) * 0.1,
        ),
        evidenceRefs: [`turn:${frame.turnId}`],
      }),
    );
  }
  for (const feedback of (input.recommendationFeedback || []).slice(0, 8)) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'recommendation_calibration',
        subject: feedback.recommendationId,
        lesson: `Recommendation was ${feedback.outcome}${feedback.reason ? `: ${feedback.reason}` : '.'}`,
        confidence: feedback.outcome === 'rejected' ? 0.9 : 0.8,
        evidenceRefs: unique(
          [...(feedback.evidenceRefs || []), `turn:${frame.turnId}`],
          20,
        ),
      }),
    );
  }
  if (goalFailureVerified) {
    candidates.push(
      learningCandidate({
        frame,
        now,
        kind: 'goal_follow_through',
        subject: input.routeUsed,
        lesson:
          'The broader goal failed with authoritative evidence; retain the failure and blocker instead of treating technical progress as completion.',
        confidence: 0.95,
        evidenceRefs: outcome.evidenceRefs,
      }),
    );
  }
  const deduped = Array.from(
    new Map(
      [...frame.learningCandidates, ...candidates].map((item) => [
        item.candidateId,
        item,
      ]),
    ).values(),
  ).slice(0, 16);
  const followThrough = unique([
    ...frame.followThrough,
    ...(!goalAchieved && (input.toolReturnedSuccess || receiptIds.length > 0)
      ? ['Verify the requested real-world outcome before closing the goal.']
      : []),
    ...(input.blockerClass
      ? [`Resolve blocker ${input.blockerClass} before retrying.`]
      : []),
  ]).slice(0, 16);
  return {
    ...frame,
    updatedAt: now,
    completedPhases: unique([
      ...frame.completedPhases,
      'verify',
      'learn',
    ]) as UnifiedCognitivePhase[],
    outcome,
    followThrough,
    learningCandidates: deduped,
    trace: {
      ...frame.trace,
      providerReceiptIds: receiptIds,
      learningCandidateIds: deduped.map((item) => item.candidateId),
    },
  };
}

export function projectUnifiedEvidenceToGroundedExecutive(
  frame: UnifiedGroundedCognitiveFrame,
): GroundedEvidenceRecord[] {
  return frame.evidence
    .filter((item) => item.mayInfluencePlanning)
    .map((item) =>
      groundedEvidence({
        evidenceId: item.evidenceId,
        evidenceClass:
          item.sourceClass === 'current_user_statement'
            ? 'user_attested'
            : ['reviewed_inference', 'unresolved_assumption'].includes(
                  item.sourceClass,
                )
              ? 'inferred'
              : 'observed',
        origin: frame.runOrigin,
        source: item.sourceClass,
        claim: item.claim,
        subject: item.subject,
        predicate: 'unified_evidence',
        value: item.value,
        confidence: item.confidence,
        verification:
          item.epistemicStatus === 'verified' ? 'verified' : 'accepted',
        provenanceRefs: item.provenanceRefs,
        createdAt: item.observedAt,
        freshness: item.freshness === 'fresh' ? 'fresh' : 'stale',
      }),
    );
}

export function unifiedLearningAsGroundedRecords(
  frame: UnifiedGroundedCognitiveFrame,
): GroundedLearningRecord[] {
  return frame.learningCandidates.map((candidate) => ({
    recordId: candidate.candidateId,
    createdAt: candidate.createdAt,
    kind:
      candidate.kind === 'tool_reliability'
        ? 'tool_reliability'
        : candidate.kind === 'evidence_calibration'
          ? 'calibration'
          : 'plan_pattern',
    status: 'proposed',
    subject: candidate.subject,
    contextKey: candidate.scopeKey,
    lesson: candidate.lesson,
    evidenceRefs: candidate.evidenceRefs,
    counterEvidenceRefs: candidate.counterEvidenceRefs,
    appliesToAuthority: false,
    reviewNote: 'Unified cognition candidate; owner review required.',
    sourceTurnId: frame.turnId,
  }));
}

export function unifiedGroundedCognitionDiagnostics(
  frame: UnifiedGroundedCognitiveFrame,
): Record<string, unknown> {
  const diagnostic = {
    version: frame.version,
    frameId: frame.frameId,
    fingerprint: frame.fingerprint,
    turnId: frame.turnId,
    mode: frame.mode,
    phases: frame.completedPhases,
    authority: frame.invariants,
    believedIntents: frame.intents.map((intent) => ({
      id: intent.intentId,
      objectiveClass: `${intent.actionClass}:${intent.mutability}`,
      target: intent.target,
      actionClass: intent.actionClass,
      mutability: intent.mutability,
    })),
    evidence: frame.evidence.map((item) => ({
      ref: item.evidenceId,
      source: item.sourceClass,
      subject: item.subject,
      epistemicStatus: item.epistemicStatus,
      confidence: item.confidence,
      freshness: item.freshness,
      mayStateToUser: item.mayStateToUser,
      mayInfluencePlanning: item.mayInfluencePlanning,
    })),
    excludedEvidence: frame.excludedEvidence,
    arbitrations: frame.arbitrations,
    goals: frame.goals.map((goal) => ({
      id: goal.goalId,
      state: goal.state,
      nextAction: goal.nextAction,
      blockers: goal.blockers,
      verifiedCompletion: goal.verifiedCompletion,
    })),
    commitments: frame.commitments.map((item) => ({
      id: item.commitmentId,
      state: item.state,
      nextAction: item.nextAction,
    })),
    moduleRecommendations: frame.moduleRecommendations,
    moduleDisagreements: frame.moduleDisagreements,
    chosenPosture: frame.chosenPosture,
    postureReason: frame.postureReason,
    prohibitedClaims: frame.prohibitedCompletionClaims,
    approvalBoundaries: frame.approvalBoundaries,
    verificationRequirements: frame.verificationRequirements,
    responseEvaluation: frame.responseEvaluation
      ? {
          status: frame.responseEvaluation.status,
          score: frame.responseEvaluation.score,
          issues: frame.responseEvaluation.issues,
        }
      : null,
    outcome: frame.outcome,
    followThrough: frame.followThrough,
    learningCandidates: frame.learningCandidates.map((item) => ({
      id: item.candidateId,
      kind: item.kind,
      subject: item.subject,
      confidence: item.confidence,
      reviewRequired: item.reviewRequired,
      executionAuthority: item.executionAuthority,
    })),
    acceptedLearningGuidance: frame.acceptedLearningGuidance,
    appliedLearningCandidateIds: frame.appliedLearningCandidateIds,
    trace: frame.trace,
    budgets: frame.budgets,
  };
  const serialized = JSON.stringify(diagnostic);
  if (serialized.length <= UNIFIED_MAX_DIAGNOSTIC_CHARS) return diagnostic;
  return {
    version: frame.version,
    frameId: frame.frameId,
    mode: frame.mode,
    truncated: true,
    believedIntents: diagnostic.believedIntents,
    chosenPosture: frame.chosenPosture,
    trace: frame.trace,
    budgets: frame.budgets,
    authority: frame.invariants,
  };
}

export function unifiedPersistedMetadata(
  frame: UnifiedGroundedCognitiveFrame,
): Record<string, string> {
  const metadata: Record<string, string> = {
    unified_cognition_version: frame.version,
    unified_cognition_mode: frame.mode,
    unified_cognition_frame_id: frame.frameId,
    unified_cognition_fingerprint: frame.fingerprint,
    unified_cognition_phases: frame.completedPhases.join(','),
    unified_cognition_intent_count: String(frame.intents.length),
    unified_cognition_evidence_count: String(frame.evidence.length),
    unified_cognition_excluded_count: String(frame.excludedEvidence.length),
    unified_cognition_arbitration_count: String(frame.arbitrations.length),
    unified_cognition_module_disagreements: String(
      frame.moduleDisagreements.length,
    ),
    unified_cognition_contradictions: String(
      frame.arbitrations.filter((item) => item.outcome === 'contradicted')
        .length,
    ),
    unified_cognition_goal_count: String(frame.goals.length),
    unified_cognition_commitment_count: String(frame.commitments.length),
    unified_cognition_posture: frame.chosenPosture,
    unified_cognition_response_status:
      frame.responseEvaluation?.status || 'not_evaluated',
    unified_cognition_outcome_verified: String(
      frame.outcome?.requestedOutcomeVerified === true,
    ),
    unified_cognition_goal_achieved: String(
      frame.outcome?.goalAchieved === true,
    ),
    unified_cognition_learning_candidates: String(
      frame.learningCandidates.length,
    ),
    unified_cognition_applied_learning: String(
      frame.appliedLearningCandidateIds.length,
    ),
    unified_cognition_context_chars: String(frame.budgets.contextChars),
    unified_cognition_budget_truncated: String(frame.budgets.truncated),
    unified_cognition_authority: 'none',
    unified_cognition_raw_private_content_persisted: 'false',
    unified_cognition_trace_ids: unique(
      [
        frame.trace.groundedExecutiveStateId,
        frame.trace.groundedDecisionId,
        frame.trace.deliberationPacketId,
        frame.trace.responseEvaluationId,
        frame.trace.cognitiveRunId,
        frame.trace.durableWorkId,
      ],
      12,
    ).join(','),
  };
  let size = 0;
  const boundedMetadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const next = bounded(value, 500);
    if (size + key.length + next.length > UNIFIED_MAX_PERSISTED_METADATA_CHARS)
      break;
    boundedMetadata[key] = next;
    size += key.length + next.length;
  }
  return boundedMetadata;
}
