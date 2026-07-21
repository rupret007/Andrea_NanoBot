import { createHash } from 'node:crypto';

import type {
  GroundedResponseContract,
  GroundedResponseEvaluation,
} from './grounded-response-intelligence.js';
import type {
  UnifiedGroundedCognitiveFrame,
  UnifiedOutcomeObservation,
} from './unified-grounded-cognition.js';

/**
 * Adaptive grounded intelligence reconciles evidence and proposes reviewed
 * response guidance. It is deliberately not an executive or action surface.
 */
export const ADAPTIVE_GROUNDED_INTELLIGENCE_VERSION = '1.0.0';
export const ADAPTIVE_MAX_EPISODE_OBSERVATIONS = 48;
export const ADAPTIVE_MAX_EPISODE_EVIDENCE_REFS = 48;
export const ADAPTIVE_MAX_LEARNING_CANDIDATES = 24;
export const ADAPTIVE_MAX_CANDIDATE_EVIDENCE_REFS = 24;
export const ADAPTIVE_MAX_APPLIED_LESSONS = 12;
export const ADAPTIVE_MAX_DIAGNOSTIC_CHARS = 16_000;
export const ADAPTIVE_EPISODE_RETENTION_DAYS = 90;
export const ADAPTIVE_EVENT_RETENTION_DAYS = 365;
export const ADAPTIVE_MIN_PROMOTION_RECURRENCE = 3;
export const ADAPTIVE_MIN_PROMOTION_CONFIDENCE = 0.75;

export type AdaptiveRunOrigin = 'live' | 'replay' | 'synthetic';

export type AdaptiveObservationSource =
  | 'response_evaluation'
  | 'tool_runtime'
  | 'provider_receipt'
  | 'goal_verification'
  | 'owner_feedback'
  | 'commitment'
  | 'memory_reconciliation'
  | 'outcome_review'
  | 'unified_frame';

export interface AdaptiveOutcomeFacts {
  responseProduced?: boolean;
  toolInvocationAttempted?: boolean;
  toolTechnicallySuccessful?: boolean;
  providerAccepted?: boolean;
  authoritativeReceiptObserved?: boolean;
  requestedOutcomeVerified?: boolean;
  goalAchieved?: boolean;
  outcomePartial?: boolean;
  outcomeFailed?: boolean;
  outcomeUnknown?: boolean;
}

export interface AdaptiveRecommendationFeedback {
  recommendationId: string;
  verdict: 'accepted' | 'rejected';
  reason: string | null;
}

export interface AdaptiveOutcomeObservation {
  observationId: string;
  episodeId: string;
  observedAt: string;
  origin: AdaptiveRunOrigin;
  source: AdaptiveObservationSource;
  authoritative: boolean;
  synthetic: boolean;
  facts: AdaptiveOutcomeFacts;
  evidenceRefs: string[];
  contradictsObservationIds: string[];
  resolvesCommitmentIds: string[];
  unresolvedCommitmentIds: string[];
  ownerCorrection: string | null;
  recommendationFeedback: AdaptiveRecommendationFeedback | null;
  summary: string;
}

export type AdaptiveOutcomeStatus =
  | 'achieved'
  | 'partial'
  | 'failed'
  | 'unknown';

export interface AdaptiveReconciledOutcome {
  reconciledAt: string;
  responseProduced: boolean;
  toolInvocationAttempted: boolean;
  toolTechnicallySuccessful: boolean | null;
  providerAccepted: boolean | null;
  authoritativeReceiptObserved: boolean;
  requestedOutcomeVerified: boolean;
  goalAchieved: boolean;
  status: AdaptiveOutcomeStatus;
  correctionObserved: boolean;
  recommendationAccepted: number;
  recommendationRejected: number;
  contradictedObservationIds: string[];
  unresolvedCommitmentIds: string[];
  evidenceRefs: string[];
  explanation: string;
  /** Structural invariant, not a confidence claim. */
  toolSuccessIsGoalSuccess: false;
}

export interface AdaptiveCognitiveEpisode {
  episodeId: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  turnId: string;
  frameId: string;
  conversationId: string;
  channel: string;
  groupFolder: string | null;
  scopeKey: string;
  runOrigin: AdaptiveRunOrigin;
  intentClauseRefs: Array<{
    intentId: string;
    target: string;
    actionClass: string;
  }>;
  responseContractId: string | null;
  responseEvaluationId: string | null;
  actionEvidenceRefs: string[];
  providerReceiptIds: string[];
  goalIds: string[];
  commitmentIds: string[];
  observations: AdaptiveOutcomeObservation[];
  outcome: AdaptiveReconciledOutcome;
  learningCandidateIds: string[];
  appliedLessonIds: string[];
  promotionEventIds: string[];
  rollbackEventIds: string[];
  retentionPolicy: 'standard_90d';
  bounds: {
    observationCount: number;
    observationLimit: number;
    evidenceRefCount: number;
    evidenceRefLimit: number;
    truncated: boolean;
  };
  invariants: {
    executionAuthority: false;
    approvalAuthority: false;
    deliveryAuthority: false;
    learningPromotionAuthority: false;
    rawPrivateContentPersisted: false;
    syntheticProductionEligible: false;
  };
}

export type AdaptiveLearningKind =
  | 'explicit_owner_correction'
  | 'misunderstood_intent_or_target'
  | 'omitted_intent_clause'
  | 'unnecessary_clarification'
  | 'repeated_clarification_failure'
  | 'stale_or_contradicted_memory'
  | 'failed_follow_through'
  | 'technical_success_unverified_goal'
  | 'verified_goal_failure'
  | 'partial_failure'
  | 'route_or_provider_unreliability'
  | 'unsupported_completion_claim'
  | 'rejected_recommendation'
  | 'accepted_recommendation'
  | 'poor_confidence_calibration'
  | 'repeated_response_repair'
  | 'unnecessary_repetition'
  | 'privacy_or_authority_near_miss';

export type AdaptiveLearningStatus =
  | 'proposed'
  | 'accumulating_evidence'
  | 'ready_for_review'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'rolled_back';

export type AdaptiveAffectedModule =
  | 'unified_frame'
  | 'response_contract'
  | 'response_evaluation'
  | 'grounded_executive'
  | 'grounded_memory'
  | 'context_selection'
  | 'goal_follow_through'
  | 'route_guidance'
  | 'confidence_calibration';

export interface AdaptiveLearningCandidate {
  candidateId: string;
  version: string;
  kind: AdaptiveLearningKind;
  createdAt: string;
  updatedAt: string;
  status: AdaptiveLearningStatus;
  subject: string;
  scopeKey: string;
  proposedLesson: string;
  supportingEvidenceRefs: string[];
  counterEvidenceRefs: string[];
  confidence: number;
  recurrenceCount: number;
  expectedBenefit: string;
  possibleHarm: string;
  affectedModules: AdaptiveAffectedModule[];
  expiresAt: string;
  reviewAfter: string;
  ownerReviewMandatory: true;
  rollbackPlan: string;
  supersessionPlan: string;
  syntheticEvidence: boolean;
  productionEligible: boolean;
  executionAuthority: false;
  evidenceFingerprint: string;
  rejectionEvidenceFingerprint: string | null;
  blockedPromotionReasons: string[];
  sourceEpisodeIds: string[];
  sourceTurnIds: string[];
  sourceFrameIds: string[];
  appliedCount: number;
  lastAppliedAt: string | null;
  supersedesCandidateId: string | null;
  supersededByCandidateId: string | null;
  ownerReview: {
    reviewerId: string;
    reviewedAt: string;
    decision: 'accepted' | 'rejected';
    note: string;
  } | null;
}

export type AdaptiveLearningEventKind =
  | 'proposed'
  | 'evidence_accumulated'
  | 'ready_for_review'
  | 'owner_accepted'
  | 'owner_rejected'
  | 'expired'
  | 'superseded'
  | 'applied'
  | 'rolled_back';

export interface AdaptiveLearningLifecycleEvent {
  eventId: string;
  candidateId: string;
  episodeId: string | null;
  createdAt: string;
  kind: AdaptiveLearningEventKind;
  fromStatus: AdaptiveLearningStatus | null;
  toStatus: AdaptiveLearningStatus;
  evidenceRefs: string[];
  actorId: string | null;
  explicitOwnerDecision: boolean;
  note: string;
  synthetic: boolean;
  executionAuthority: false;
}

export interface AdaptiveLearningSignals {
  explicitOwnerCorrection?: string | null;
  clarificationFailureCount?: number;
  responseRepairCount?: number;
  recommendationFeedback?: AdaptiveRecommendationFeedback[];
  confidencePrediction?: number | null;
  confidenceOutcome?: 0 | 1 | null;
  routeUsed?: string | null;
  privacyNearMiss?: boolean;
  authorityNearMiss?: boolean;
}

export interface AdaptiveLearningGenerationResult {
  candidates: AdaptiveLearningCandidate[];
  events: AdaptiveLearningLifecycleEvent[];
  suppressedRejectedCandidateIds: string[];
}

export interface AdaptiveLearningGuidance {
  generatedAt: string;
  scopeKey: string;
  appliedLessonIds: string[];
  responseGuidance: string[];
  planningGuidance: string[];
  routeGuidance: string[];
  prohibitedClaims: string[];
  uncertaintyDisclosures: string[];
  executionAuthority: false;
  approvalAuthority: false;
}

export type AdaptiveAssistiveReadinessStatus =
  | 'not_ready'
  | 'shadow_ready'
  | 'canary_candidate'
  | 'canary_paused'
  | 'rollback_required';

export interface AdaptiveAssistiveReadinessInput {
  evaluatedAt: string;
  baselineQualityScore: number;
  candidateQualityScore: number;
  learningRelevantImprovementPoints: number;
  sampleSize: number;
  minimumSampleSize: number;
  authorityViolations: number;
  privacyViolations: number;
  unsupportedCompletionClaims: number;
  lostIntentOrTargetCount: number;
  contradictionDisclosureRate: number;
  calibrationScore: number;
  repairRate: number;
  latencyP95Ms: number;
  contextWithinBounds: boolean;
  storageWithinBounds: boolean;
  promotionPrecision: number;
  rollbackTestPassed: boolean;
  unresolvedCriticalFailures: number;
  deterministicRunsIdentical: boolean;
  ownerApprovedCanary: boolean;
  canaryActive: boolean;
  priorCanaryCriticalFailure: boolean;
}

export interface AdaptiveAssistiveReadinessAssessment {
  assessmentId: string;
  evaluatedAt: string;
  status: AdaptiveAssistiveReadinessStatus;
  passedGates: string[];
  failedGates: string[];
  reasons: string[];
  canaryScope: {
    responsePlanningOnly: true;
    externalMutationAllowed: false;
    actionAuthorityExpanded: false;
    productionModeChanged: false;
  };
  rollbackRequired: boolean;
  ownerApprovalRequired: boolean;
}

const SECRET_RE =
  /\b(?:api[_ -]?key|password|secret|token|authorization|credential)\s*[:=]\s*\S+/gi;
const SENSITIVE_IDENTITY_RE =
  /\b(?:race|ethnicity|religion|sexual orientation|medical diagnosis|social security|ssn|passport)\b/i;
const AUTHORITY_EXPANSION_RE =
  /\b(?:bypass|skip approval|without approval|auto[- ]?send|always send|enable outbound|change credentials?|expand authority|grant permission)\b/i;
const EXTERNAL_INSTRUCTION_RE =
  /\b(?:retrieved content|web page|email|document|tool output)\b.*\b(?:instructs?|commands?|says to)\b/i;
const MESSAGE_TARGET_RE =
  /\b(?:message|text|email|send to|recipient|phone number|address)\b/i;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function bounded(value: unknown, limit = 420): string {
  const normalized = String(value ?? '')
    .replace(SECRET_RE, '[redacted secret]')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 1))}…`
    : normalized;
}

function unique(
  values: Array<string | null | undefined>,
  limit = ADAPTIVE_MAX_CANDIDATE_EVIDENCE_REFS,
): string[] {
  return Array.from(
    new Set(values.map((item) => bounded(item, 300)).filter(Boolean)),
  ).slice(0, limit);
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${createHash('sha256').update(input).digest('hex').slice(0, 24)}`;
}

function fingerprint(values: string[]): string {
  return createHash('sha256')
    .update([...values].sort().join('|'))
    .digest('hex')
    .slice(0, 24);
}

function plusDays(iso: string, days: number): string {
  const parsed = Date.parse(iso);
  const start = Number.isFinite(parsed) ? parsed : 0;
  return new Date(start + days * 24 * 60 * 60 * 1000).toISOString();
}

function canonicalScope(frame: UnifiedGroundedCognitiveFrame): string {
  return bounded(
    `${frame.channel}:${frame.groupFolder || frame.conversationId}`,
    240,
  );
}

function emptyOutcome(now: string): AdaptiveReconciledOutcome {
  return {
    reconciledAt: now,
    responseProduced: false,
    toolInvocationAttempted: false,
    toolTechnicallySuccessful: null,
    providerAccepted: null,
    authoritativeReceiptObserved: false,
    requestedOutcomeVerified: false,
    goalAchieved: false,
    status: 'unknown',
    correctionObserved: false,
    recommendationAccepted: 0,
    recommendationRejected: 0,
    contradictedObservationIds: [],
    unresolvedCommitmentIds: [],
    evidenceRefs: [],
    explanation:
      'No authoritative evidence has verified the requested outcome or goal.',
    toolSuccessIsGoalSuccess: false,
  };
}

export function createAdaptiveCognitiveEpisode(
  frame: UnifiedGroundedCognitiveFrame,
  now = frame.createdAt,
): AdaptiveCognitiveEpisode {
  return {
    episodeId: stableId('agi:episode', `${frame.frameId}|${frame.turnId}`),
    version: ADAPTIVE_GROUNDED_INTELLIGENCE_VERSION,
    createdAt: now,
    updatedAt: now,
    expiresAt: plusDays(now, ADAPTIVE_EPISODE_RETENTION_DAYS),
    turnId: frame.turnId,
    frameId: frame.frameId,
    conversationId: bounded(frame.conversationId, 240),
    channel: bounded(frame.channel, 80),
    groupFolder: frame.groupFolder ? bounded(frame.groupFolder, 160) : null,
    scopeKey: canonicalScope(frame),
    runOrigin: frame.runOrigin,
    intentClauseRefs: frame.intents.slice(0, 8).map((intent) => ({
      intentId: intent.intentId,
      target: bounded(intent.target, 240),
      actionClass: intent.actionClass,
    })),
    responseContractId: frame.trace.deliberationPacketId,
    responseEvaluationId: frame.trace.responseEvaluationId,
    actionEvidenceRefs: [],
    providerReceiptIds: [...frame.trace.providerReceiptIds].slice(0, 16),
    goalIds: [...frame.trace.goalIds].slice(0, 16),
    commitmentIds: [...frame.trace.commitmentIds].slice(0, 16),
    observations: [],
    outcome: emptyOutcome(now),
    learningCandidateIds: [],
    appliedLessonIds: [],
    promotionEventIds: [],
    rollbackEventIds: [],
    retentionPolicy: 'standard_90d',
    bounds: {
      observationCount: 0,
      observationLimit: ADAPTIVE_MAX_EPISODE_OBSERVATIONS,
      evidenceRefCount: 0,
      evidenceRefLimit: ADAPTIVE_MAX_EPISODE_EVIDENCE_REFS,
      truncated: false,
    },
    invariants: {
      executionAuthority: false,
      approvalAuthority: false,
      deliveryAuthority: false,
      learningPromotionAuthority: false,
      rawPrivateContentPersisted: false,
      syntheticProductionEligible: false,
    },
  };
}

export function adaptiveObservation(input: {
  episodeId: string;
  observedAt: string;
  origin: AdaptiveRunOrigin;
  source: AdaptiveObservationSource;
  authoritative?: boolean;
  facts?: AdaptiveOutcomeFacts;
  evidenceRefs?: string[];
  contradictsObservationIds?: string[];
  resolvesCommitmentIds?: string[];
  unresolvedCommitmentIds?: string[];
  ownerCorrection?: string | null;
  recommendationFeedback?: AdaptiveRecommendationFeedback | null;
  summary: string;
}): AdaptiveOutcomeObservation {
  const facts = input.facts || {};
  const evidenceRefs = unique(
    input.evidenceRefs || [],
    ADAPTIVE_MAX_EPISODE_EVIDENCE_REFS,
  );
  const summary = bounded(input.summary, 700);
  return {
    observationId: stableId(
      'agi:observation',
      `${input.episodeId}|${input.observedAt}|${input.source}|${JSON.stringify(facts)}|${evidenceRefs.join(',')}|${summary}`,
    ),
    episodeId: input.episodeId,
    observedAt: input.observedAt,
    origin: input.origin,
    source: input.source,
    authoritative: input.authoritative === true,
    synthetic: input.origin === 'synthetic',
    facts,
    evidenceRefs,
    contradictsObservationIds: unique(
      input.contradictsObservationIds || [],
      16,
    ),
    resolvesCommitmentIds: unique(input.resolvesCommitmentIds || [], 16),
    unresolvedCommitmentIds: unique(input.unresolvedCommitmentIds || [], 16),
    ownerCorrection: input.ownerCorrection
      ? bounded(input.ownerCorrection, 500)
      : null,
    recommendationFeedback: input.recommendationFeedback
      ? {
          recommendationId: bounded(
            input.recommendationFeedback.recommendationId,
            180,
          ),
          verdict: input.recommendationFeedback.verdict,
          reason: input.recommendationFeedback.reason
            ? bounded(input.recommendationFeedback.reason, 360)
            : null,
        }
      : null,
    summary,
  };
}

function sortedObservations(
  observations: AdaptiveOutcomeObservation[],
): AdaptiveOutcomeObservation[] {
  return [...observations].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.observationId.localeCompare(right.observationId),
  );
}

function latestBoolean(
  observations: AdaptiveOutcomeObservation[],
  key: keyof AdaptiveOutcomeFacts,
  authoritativeOnly: boolean,
): boolean | null {
  const eligible = sortedObservations(observations).filter(
    (item) =>
      typeof item.facts[key] === 'boolean' &&
      (!authoritativeOnly || item.authoritative),
  );
  const last = eligible[eligible.length - 1];
  return last ? Boolean(last.facts[key]) : null;
}

export function reconcileAdaptiveOutcome(
  observations: AdaptiveOutcomeObservation[],
  now: string,
): AdaptiveReconciledOutcome {
  const ordered = sortedObservations(observations).slice(
    -ADAPTIVE_MAX_EPISODE_OBSERVATIONS,
  );
  const responseProduced =
    latestBoolean(ordered, 'responseProduced', false) === true;
  const toolInvocationAttempted =
    latestBoolean(ordered, 'toolInvocationAttempted', false) === true;
  const toolTechnicallySuccessful = latestBoolean(
    ordered,
    'toolTechnicallySuccessful',
    false,
  );
  const providerAccepted = latestBoolean(ordered, 'providerAccepted', true);
  const authoritativeReceiptObserved =
    latestBoolean(ordered, 'authoritativeReceiptObserved', true) === true;
  const requestedOutcomeVerified =
    latestBoolean(ordered, 'requestedOutcomeVerified', true) === true;
  const explicitGoalAchieved =
    latestBoolean(ordered, 'goalAchieved', true) === true;
  const goalAchieved = requestedOutcomeVerified && explicitGoalAchieved;
  const failed = latestBoolean(ordered, 'outcomeFailed', true) === true;
  const partial = latestBoolean(ordered, 'outcomePartial', true) === true;
  const explicitlyUnknown =
    latestBoolean(ordered, 'outcomeUnknown', true) === true;
  const status: AdaptiveOutcomeStatus = failed
    ? 'failed'
    : partial
      ? 'partial'
      : goalAchieved
        ? 'achieved'
        : 'unknown';

  const contradicted = new Set<string>();
  const unresolved = new Set<string>();
  for (const observation of ordered) {
    for (const id of observation.contradictsObservationIds)
      contradicted.add(id);
    for (const id of observation.unresolvedCommitmentIds) unresolved.add(id);
    for (const id of observation.resolvesCommitmentIds) unresolved.delete(id);
  }
  const recommendationAccepted = ordered.filter(
    (item) => item.recommendationFeedback?.verdict === 'accepted',
  ).length;
  const recommendationRejected = ordered.filter(
    (item) => item.recommendationFeedback?.verdict === 'rejected',
  ).length;
  const evidenceRefs = unique(
    ordered.flatMap((item) => item.evidenceRefs),
    ADAPTIVE_MAX_EPISODE_EVIDENCE_REFS,
  );
  const explanation = goalAchieved
    ? 'Authoritative evidence verified both the requested outcome and the user goal.'
    : failed
      ? 'Authoritative evidence verified failure; earlier technical or provider success remains historical but does not override it.'
      : partial
        ? 'Authoritative evidence verified only part of the requested outcome; unresolved work remains.'
        : explicitlyUnknown ||
            toolTechnicallySuccessful === true ||
            providerAccepted === true ||
            authoritativeReceiptObserved
          ? 'Technical or provider evidence exists, but authoritative evidence has not verified the requested outcome and user goal.'
          : 'No authoritative evidence has verified the requested outcome or user goal.';
  return {
    reconciledAt: now,
    responseProduced,
    toolInvocationAttempted,
    toolTechnicallySuccessful,
    providerAccepted,
    authoritativeReceiptObserved,
    requestedOutcomeVerified,
    goalAchieved,
    status,
    correctionObserved: ordered.some((item) => Boolean(item.ownerCorrection)),
    recommendationAccepted,
    recommendationRejected,
    contradictedObservationIds: [...contradicted].slice(0, 24),
    unresolvedCommitmentIds: [...unresolved].slice(0, 24),
    evidenceRefs,
    explanation,
    toolSuccessIsGoalSuccess: false,
  };
}

export function appendAdaptiveOutcomeObservation(
  episode: AdaptiveCognitiveEpisode,
  observation: AdaptiveOutcomeObservation,
): AdaptiveCognitiveEpisode {
  if (observation.episodeId !== episode.episodeId) {
    throw new Error('Adaptive outcome observation episode mismatch.');
  }
  const exists = episode.observations.some(
    (item) => item.observationId === observation.observationId,
  );
  const combined = exists
    ? [...episode.observations]
    : [...episode.observations, observation];
  const ordered = sortedObservations(combined);
  const truncated = ordered.length > ADAPTIVE_MAX_EPISODE_OBSERVATIONS;
  const observations = ordered.slice(-ADAPTIVE_MAX_EPISODE_OBSERVATIONS);
  const evidenceRefs = unique(
    observations.flatMap((item) => item.evidenceRefs),
    ADAPTIVE_MAX_EPISODE_EVIDENCE_REFS,
  );
  return {
    ...episode,
    updatedAt:
      observation.observedAt > episode.updatedAt
        ? observation.observedAt
        : episode.updatedAt,
    observations,
    outcome: reconcileAdaptiveOutcome(observations, observation.observedAt),
    actionEvidenceRefs: unique(
      [
        ...episode.actionEvidenceRefs,
        ...observations
          .filter((item) => item.source === 'tool_runtime')
          .flatMap((item) => item.evidenceRefs),
      ],
      24,
    ),
    providerReceiptIds: unique(
      [
        ...episode.providerReceiptIds,
        ...observations
          .filter((item) => item.source === 'provider_receipt')
          .flatMap((item) => item.evidenceRefs),
      ],
      16,
    ),
    bounds: {
      ...episode.bounds,
      observationCount: observations.length,
      evidenceRefCount: evidenceRefs.length,
      truncated: episode.bounds.truncated || truncated,
    },
  };
}

export function observationFromUnifiedOutcome(input: {
  episode: AdaptiveCognitiveEpisode;
  frame: UnifiedGroundedCognitiveFrame;
  outcome: UnifiedOutcomeObservation;
}): AdaptiveOutcomeObservation {
  const { episode, frame, outcome } = input;
  return adaptiveObservation({
    episodeId: episode.episodeId,
    observedAt: outcome.observedAt,
    origin: frame.runOrigin,
    source: 'unified_frame',
    authoritative:
      outcome.providerReceiptObserved ||
      outcome.requestedOutcomeVerified ||
      outcome.goalFailureVerified,
    facts: {
      responseProduced: true,
      toolInvocationAttempted: outcome.toolCallAccepted,
      toolTechnicallySuccessful: outcome.toolReturnedSuccess,
      authoritativeReceiptObserved: outcome.providerReceiptObserved,
      providerAccepted: outcome.providerReceiptObserved ? true : undefined,
      requestedOutcomeVerified: outcome.requestedOutcomeVerified,
      goalAchieved: outcome.goalAchieved,
      outcomePartial: outcome.partial,
      outcomeFailed: outcome.goalFailureVerified,
      outcomeUnknown:
        !outcome.requestedOutcomeVerified && !outcome.goalFailureVerified,
    },
    evidenceRefs: outcome.evidenceRefs,
    unresolvedCommitmentIds: outcome.goalAchieved
      ? []
      : frame.commitments
          .filter((item) => item.state === 'active')
          .map((item) => item.commitmentId),
    summary: outcome.explanation,
  });
}

function candidateBlockedReasons(input: {
  lesson: string;
  subject: string;
  origin: AdaptiveRunOrigin;
  evidenceAuthoritative: boolean;
  kind: AdaptiveLearningKind;
}): string[] {
  const text = `${input.subject} ${input.lesson}`;
  const reasons: string[] = [];
  if (input.origin !== 'live') reasons.push('non_live_evidence');
  if (!input.evidenceAuthoritative) reasons.push('unverified_evidence');
  if (SECRET_RE.test(text)) reasons.push('secret_or_credential');
  SECRET_RE.lastIndex = 0;
  if (SENSITIVE_IDENTITY_RE.test(text)) reasons.push('sensitive_identity');
  if (AUTHORITY_EXPANSION_RE.test(text)) reasons.push('authority_expansion');
  if (EXTERNAL_INSTRUCTION_RE.test(text)) reasons.push('external_instruction');
  if (MESSAGE_TARGET_RE.test(text)) reasons.push('messaging_target');
  if (
    input.kind === 'accepted_recommendation' &&
    !input.evidenceAuthoritative
  ) {
    reasons.push('unverified_recommendation_feedback');
  }
  return unique(reasons, 16);
}

interface CandidateSeed {
  kind: AdaptiveLearningKind;
  subject: string;
  lesson: string;
  evidenceRefs: string[];
  counterEvidenceRefs?: string[];
  confidence: number;
  expectedBenefit: string;
  possibleHarm: string;
  affectedModules: AdaptiveAffectedModule[];
  evidenceAuthoritative: boolean;
}

function candidateKey(seed: CandidateSeed, scopeKey: string): string {
  return `${seed.kind}|${bounded(seed.subject, 180).toLowerCase()}|${scopeKey}`;
}

function candidateFromSeed(input: {
  seed: CandidateSeed;
  episode: AdaptiveCognitiveEpisode;
  existing?: AdaptiveLearningCandidate;
  now: string;
}): { candidate: AdaptiveLearningCandidate; materiallyNewEvidence: boolean } {
  const { seed, episode, existing, now } = input;
  const supportingEvidenceRefs = unique(
    [...(existing?.supportingEvidenceRefs || []), ...seed.evidenceRefs],
    ADAPTIVE_MAX_CANDIDATE_EVIDENCE_REFS,
  );
  const counterEvidenceRefs = unique(
    [
      ...(existing?.counterEvidenceRefs || []),
      ...(seed.counterEvidenceRefs || []),
    ],
    ADAPTIVE_MAX_CANDIDATE_EVIDENCE_REFS,
  );
  const evidenceFingerprint = fingerprint([
    ...supportingEvidenceRefs,
    ...counterEvidenceRefs.map((item) => `counter:${item}`),
  ]);
  const materiallyNewEvidence =
    !existing || existing.evidenceFingerprint !== evidenceFingerprint;
  const blockedPromotionReasons = candidateBlockedReasons({
    lesson: seed.lesson,
    subject: seed.subject,
    origin: episode.runOrigin,
    evidenceAuthoritative: seed.evidenceAuthoritative,
    kind: seed.kind,
  });
  const recurrenceCount = existing
    ? existing.recurrenceCount + (materiallyNewEvidence ? 1 : 0)
    : 1;
  const baseStatus: AdaptiveLearningStatus = existing?.status || 'proposed';
  const nextEvidenceStatus: AdaptiveLearningStatus =
    blockedPromotionReasons.length > 0
      ? baseStatus
      : recurrenceCount >= ADAPTIVE_MIN_PROMOTION_RECURRENCE &&
          supportingEvidenceRefs.length >= 2 &&
          Math.max(existing?.confidence || 0, seed.confidence) >=
            ADAPTIVE_MIN_PROMOTION_CONFIDENCE
        ? 'ready_for_review'
        : recurrenceCount >= 2
          ? 'accumulating_evidence'
          : 'proposed';
  const status = ['accepted', 'superseded', 'rolled_back', 'expired'].includes(
    baseStatus,
  )
    ? baseStatus
    : baseStatus === 'rejected' && !materiallyNewEvidence
      ? 'rejected'
      : nextEvidenceStatus;
  const key = candidateKey(seed, episode.scopeKey);
  const candidateId = existing?.candidateId || stableId('agi:learning', key);
  return {
    materiallyNewEvidence,
    candidate: {
      candidateId,
      version: ADAPTIVE_GROUNDED_INTELLIGENCE_VERSION,
      kind: seed.kind,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      status,
      subject: bounded(seed.subject, 180),
      scopeKey: episode.scopeKey,
      proposedLesson: bounded(seed.lesson, 700),
      supportingEvidenceRefs,
      counterEvidenceRefs,
      confidence: clamp01(Math.max(existing?.confidence || 0, seed.confidence)),
      recurrenceCount,
      expectedBenefit: bounded(seed.expectedBenefit, 420),
      possibleHarm: bounded(seed.possibleHarm, 420),
      affectedModules: Array.from(
        new Set([
          ...(existing?.affectedModules || []),
          ...seed.affectedModules,
        ]),
      ).slice(0, 9),
      expiresAt: existing?.expiresAt || plusDays(now, 90),
      reviewAfter: existing?.reviewAfter || plusDays(now, 1),
      ownerReviewMandatory: true,
      rollbackPlan:
        existing?.rollbackPlan ||
        'Mark the lesson rolled_back; stop projecting its guidance immediately while retaining the review history.',
      supersessionPlan:
        existing?.supersessionPlan ||
        'Accept a narrower replacement and link this candidate as superseded; never rewrite the original evidence.',
      syntheticEvidence:
        existing?.syntheticEvidence === true || episode.runOrigin !== 'live',
      productionEligible:
        episode.runOrigin === 'live' && blockedPromotionReasons.length === 0,
      executionAuthority: false,
      evidenceFingerprint,
      rejectionEvidenceFingerprint:
        status === 'rejected'
          ? existing?.rejectionEvidenceFingerprint || evidenceFingerprint
          : existing?.rejectionEvidenceFingerprint || null,
      blockedPromotionReasons,
      sourceEpisodeIds: unique(
        [...(existing?.sourceEpisodeIds || []), episode.episodeId],
        16,
      ),
      sourceTurnIds: unique(
        [...(existing?.sourceTurnIds || []), episode.turnId],
        16,
      ),
      sourceFrameIds: unique(
        [...(existing?.sourceFrameIds || []), episode.frameId],
        16,
      ),
      appliedCount: existing?.appliedCount || 0,
      lastAppliedAt: existing?.lastAppliedAt || null,
      supersedesCandidateId: existing?.supersedesCandidateId || null,
      supersededByCandidateId: existing?.supersededByCandidateId || null,
      ownerReview: existing?.ownerReview || null,
    },
  };
}

function issueSeeds(
  frame: UnifiedGroundedCognitiveFrame,
  evaluation: GroundedResponseEvaluation | null,
): CandidateSeed[] {
  const seeds: CandidateSeed[] = [];
  for (const issue of evaluation?.issues || []) {
    const intent = issue.intentId
      ? frame.intents.find((item) => item.intentId === issue.intentId)
      : null;
    const common = {
      subject: intent?.target || issue.intentId || frame.taskFamily,
      lesson: issue.detail,
      evidenceRefs: unique(
        [issue.intentId, frame.trace.responseEvaluationId],
        12,
      ),
      confidence: issue.severity === 'block' ? 0.95 : 0.8,
      evidenceAuthoritative: true,
    };
    switch (issue.kind) {
      case 'intent_missing':
        seeds.push({
          ...common,
          kind: 'omitted_intent_clause',
          expectedBenefit:
            'Preserve every original user clause in response planning.',
          possibleHarm: 'Over-expanding unrelated prose into separate intents.',
          affectedModules: ['response_contract', 'response_evaluation'],
        });
        break;
      case 'target_missing':
        seeds.push({
          ...common,
          kind: 'misunderstood_intent_or_target',
          expectedBenefit: 'Keep the requested target attached to its intent.',
          possibleHarm: 'Overfitting a correction to unrelated targets.',
          affectedModules: ['unified_frame', 'response_contract'],
        });
        break;
      case 'unsupported_completion':
        seeds.push({
          ...common,
          kind: 'unsupported_completion_claim',
          expectedBenefit:
            'Prevent completion claims without authoritative outcome evidence.',
          possibleHarm:
            'Excessively cautious wording after genuinely verified completion.',
          affectedModules: ['response_contract', 'response_evaluation'],
        });
        break;
      case 'stale_memory_misuse':
      case 'contradiction_undisclosed':
        seeds.push({
          ...common,
          kind: 'stale_or_contradicted_memory',
          expectedBenefit:
            'Disclose stale or contradictory context instead of presenting it as fact.',
          possibleHarm:
            'Unnecessary uncertainty when newer evidence is authoritative.',
          affectedModules: [
            'grounded_memory',
            'context_selection',
            'response_contract',
          ],
        });
        break;
      case 'follow_through_missing':
        seeds.push({
          ...common,
          kind: 'failed_follow_through',
          expectedBenefit:
            'Carry unresolved work and commitments into the next response.',
          possibleHarm: 'Resurfacing completed or cancelled commitments.',
          affectedModules: ['goal_follow_through', 'response_contract'],
        });
        break;
      case 'partial_failure_hidden':
        seeds.push({
          ...common,
          kind: 'partial_failure',
          expectedBenefit:
            'State which clause succeeded, failed, or remains unknown.',
          possibleHarm: 'Verbose status reporting for simple direct answers.',
          affectedModules: ['response_contract', 'response_evaluation'],
        });
        break;
      case 'unnecessary_repetition':
        seeds.push({
          ...common,
          kind: 'unnecessary_repetition',
          expectedBenefit:
            'Avoid repeating confirmation or already-settled context.',
          possibleHarm: 'Omitting a brief recap needed for continuity.',
          affectedModules: ['response_contract', 'response_evaluation'],
        });
        break;
      case 'authority_violation':
      case 'privacy_violation':
      case 'approval_boundary':
        seeds.push({
          ...common,
          kind: 'privacy_or_authority_near_miss',
          expectedBenefit:
            'Preserve privacy, approval, and execution boundaries.',
          possibleHarm:
            'Blocking useful read-only work if applied too broadly.',
          affectedModules: ['response_contract', 'response_evaluation'],
        });
        break;
      default:
        break;
    }
  }
  return seeds;
}

export function generateAdaptiveLearningCandidates(input: {
  episode: AdaptiveCognitiveEpisode;
  frame: UnifiedGroundedCognitiveFrame;
  evaluation?: GroundedResponseEvaluation | null;
  existingCandidates?: AdaptiveLearningCandidate[];
  signals?: AdaptiveLearningSignals;
  now?: string;
}): AdaptiveLearningGenerationResult {
  const now = input.now || input.episode.updatedAt;
  const evaluation = input.evaluation ?? input.frame.responseEvaluation;
  const signals = input.signals || {};
  const seeds = issueSeeds(input.frame, evaluation);
  const outcome = input.episode.outcome;
  const evidenceRefs = outcome.evidenceRefs.length
    ? outcome.evidenceRefs
    : [`turn:${input.episode.turnId}`];
  if (signals.explicitOwnerCorrection || outcome.correctionObserved) {
    seeds.push({
      kind: 'explicit_owner_correction',
      subject: input.frame.taskFamily,
      lesson:
        signals.explicitOwnerCorrection ||
        'An explicit owner correction requires narrower interpretation on similar future turns.',
      evidenceRefs,
      confidence: 1,
      expectedBenefit:
        'Honor the owner’s explicit correction in similar scoped responses.',
      possibleHarm: 'Applying a turn-specific correction outside its scope.',
      affectedModules: [
        'unified_frame',
        'context_selection',
        'response_contract',
      ],
      evidenceAuthoritative: input.episode.runOrigin === 'live',
    });
  }
  if (
    signals.clarificationFailureCount &&
    signals.clarificationFailureCount >= 2
  ) {
    seeds.push({
      kind: 'repeated_clarification_failure',
      subject: input.frame.taskFamily,
      lesson:
        'Repeated clarification did not resolve the target; ask one narrower evidence-seeking question or defer safely.',
      evidenceRefs,
      confidence: Math.min(
        0.98,
        0.7 + signals.clarificationFailureCount * 0.08,
      ),
      expectedBenefit:
        'Reduce clarification loops while preserving ambiguity disclosure.',
      possibleHarm:
        'Deferring when one additional question would have resolved the request.',
      affectedModules: ['response_contract', 'response_evaluation'],
      evidenceAuthoritative: input.episode.runOrigin === 'live',
    });
  } else if (
    input.frame.chosenPosture === 'ask_clarification' &&
    input.frame.intents.length > 0 &&
    input.frame.arbitrations.every(
      (item) => item.outcome !== 'requires_user_clarification',
    )
  ) {
    seeds.push({
      kind: 'unnecessary_clarification',
      subject: input.frame.taskFamily,
      lesson:
        'The request had sufficient grounded context for a direct answer; avoid adding a clarification that does not unblock a material ambiguity.',
      evidenceRefs,
      confidence: 0.78,
      expectedBenefit: 'Answer direct requests with less friction.',
      possibleHarm:
        'Answering through a genuine ambiguity that was not represented in arbitration.',
      affectedModules: ['response_contract', 'response_evaluation'],
      evidenceAuthoritative: true,
    });
  }
  if (
    outcome.toolTechnicallySuccessful === true &&
    !outcome.requestedOutcomeVerified
  ) {
    seeds.push({
      kind: 'technical_success_unverified_goal',
      subject: signals.routeUsed || input.frame.taskFamily,
      lesson:
        'Technical success did not verify the requested outcome; retain follow-through and prohibit a goal-complete claim.',
      evidenceRefs,
      confidence: 0.98,
      expectedBenefit: 'Keep provider, outcome, and goal truth separate.',
      possibleHarm:
        'Unnecessary follow-up after authoritative verification was omitted from the episode.',
      affectedModules: [
        'goal_follow_through',
        'response_contract',
        'route_guidance',
      ],
      evidenceAuthoritative: true,
    });
  }
  if (outcome.status === 'failed') {
    seeds.push({
      kind: 'verified_goal_failure',
      subject: signals.routeUsed || input.frame.taskFamily,
      lesson:
        'The goal failed with authoritative evidence; preserve the blocker and do not close the goal from technical progress.',
      evidenceRefs,
      confidence: 0.98,
      expectedBenefit:
        'Improve replanning and truthful follow-through after verified failure.',
      possibleHarm:
        'Persisting a failure after later authoritative recovery without reconciliation.',
      affectedModules: [
        'goal_follow_through',
        'response_contract',
        'route_guidance',
      ],
      evidenceAuthoritative: true,
    });
  }
  if (outcome.status === 'partial') {
    seeds.push({
      kind: 'partial_failure',
      subject: input.frame.taskFamily,
      lesson:
        'Report completed, failed, and unresolved clauses separately and retain only the unresolved follow-through.',
      evidenceRefs,
      confidence: 0.92,
      expectedBenefit: 'Improve partial-failure honesty and continuity.',
      possibleHarm: 'Overly detailed status narration on low-impact requests.',
      affectedModules: ['response_contract', 'goal_follow_through'],
      evidenceAuthoritative: true,
    });
  }
  if (outcome.unresolvedCommitmentIds.length > 0 && !outcome.goalAchieved) {
    seeds.push({
      kind: 'failed_follow_through',
      subject: outcome.unresolvedCommitmentIds[0] || input.frame.taskFamily,
      lesson:
        'An unresolved commitment remained after the response; surface its next evidence-backed action without resurrecting terminal work.',
      evidenceRefs: unique([
        ...evidenceRefs,
        ...outcome.unresolvedCommitmentIds,
      ]),
      confidence: 0.9,
      expectedBenefit:
        'Maintain continuity across turns until verified resolution.',
      possibleHarm:
        'Resurfacing a commitment that was resolved outside the observed channel.',
      affectedModules: ['goal_follow_through', 'response_contract'],
      evidenceAuthoritative: true,
    });
  }
  for (const feedback of signals.recommendationFeedback || []) {
    const accepted = feedback.verdict === 'accepted';
    seeds.push({
      kind: accepted ? 'accepted_recommendation' : 'rejected_recommendation',
      subject: feedback.recommendationId,
      lesson: accepted
        ? `The owner accepted this recommendation${feedback.reason ? `: ${feedback.reason}` : '.'}`
        : `The owner rejected this recommendation${feedback.reason ? `: ${feedback.reason}` : '.'}`,
      evidenceRefs,
      confidence: 0.95,
      expectedBenefit: accepted
        ? 'Prefer similarly scoped recommendation framing when evidence remains comparable.'
        : 'Avoid repeating a rejected recommendation without materially new evidence.',
      possibleHarm:
        'Treating one recommendation verdict as a broad preference.',
      affectedModules: ['response_contract', 'confidence_calibration'],
      evidenceAuthoritative: input.episode.runOrigin === 'live',
    });
  }
  if (
    signals.confidencePrediction !== null &&
    signals.confidencePrediction !== undefined &&
    signals.confidenceOutcome !== null &&
    signals.confidenceOutcome !== undefined &&
    ((signals.confidencePrediction >= 0.8 && signals.confidenceOutcome === 0) ||
      (signals.confidencePrediction <= 0.35 && signals.confidenceOutcome === 1))
  ) {
    seeds.push({
      kind: 'poor_confidence_calibration',
      subject: input.frame.taskFamily,
      lesson: `Confidence ${signals.confidencePrediction.toFixed(2)} did not match the verified outcome; disclose uncertainty and recalibrate similar claims.`,
      evidenceRefs,
      confidence: 0.88,
      expectedBenefit: 'Align confidence language with observed correctness.',
      possibleHarm: 'Overcorrecting from an unrepresentative sample.',
      affectedModules: ['confidence_calibration', 'response_contract'],
      evidenceAuthoritative: true,
    });
  }
  if (signals.responseRepairCount && signals.responseRepairCount >= 2) {
    seeds.push({
      kind: 'repeated_response_repair',
      subject: input.frame.taskFamily,
      lesson:
        'Repeated repair indicates the initial response contract needs stricter clause, target, truth, or uncertainty coverage.',
      evidenceRefs,
      confidence: 0.85,
      expectedBenefit:
        'Reduce repairs by improving first-pass response planning.',
      possibleHarm:
        'Adding response constraints that make simple answers rigid.',
      affectedModules: ['response_contract', 'response_evaluation'],
      evidenceAuthoritative: true,
    });
  }
  if (signals.routeUsed && outcome.status === 'failed') {
    seeds.push({
      kind: 'route_or_provider_unreliability',
      subject: signals.routeUsed,
      lesson: `Route ${signals.routeUsed} has authoritative failure evidence; prefer verification or a proven read-only fallback before relying on it.`,
      evidenceRefs,
      confidence: 0.9,
      expectedBenefit:
        'Improve route selection and failure disclosure for read-only planning.',
      possibleHarm: 'Avoiding a route after a transient isolated failure.',
      affectedModules: ['route_guidance', 'grounded_executive'],
      evidenceAuthoritative: true,
    });
  }
  if (signals.privacyNearMiss || signals.authorityNearMiss) {
    seeds.push({
      kind: 'privacy_or_authority_near_miss',
      subject: input.frame.taskFamily,
      lesson:
        'A privacy or authority boundary was approached; keep future guidance scoped, redacted, approval-aware, and non-executing.',
      evidenceRefs,
      confidence: 0.98,
      expectedBenefit: 'Prevent future privacy or authority violations.',
      possibleHarm: 'Blocking safe read-only assistance if scoped too broadly.',
      affectedModules: ['response_contract', 'response_evaluation'],
      evidenceAuthoritative: true,
    });
  }

  const existingByKey = new Map<string, AdaptiveLearningCandidate>();
  for (const candidate of input.existingCandidates || []) {
    existingByKey.set(
      `${candidate.kind}|${candidate.subject.toLowerCase()}|${candidate.scopeKey}`,
      candidate,
    );
  }
  const candidates: AdaptiveLearningCandidate[] = [];
  const events: AdaptiveLearningLifecycleEvent[] = [];
  const suppressedRejectedCandidateIds: string[] = [];
  const dedupedSeeds = new Map<string, CandidateSeed>();
  for (const seed of seeds) {
    const key = candidateKey(seed, input.episode.scopeKey);
    if (!dedupedSeeds.has(key)) dedupedSeeds.set(key, seed);
  }
  for (const [key, seed] of dedupedSeeds) {
    const existing = existingByKey.get(key);
    const { candidate, materiallyNewEvidence } = candidateFromSeed({
      seed,
      episode: input.episode,
      existing,
      now,
    });
    if (
      existing?.status === 'rejected' &&
      !materiallyNewEvidence &&
      existing.rejectionEvidenceFingerprint === candidate.evidenceFingerprint
    ) {
      suppressedRejectedCandidateIds.push(existing.candidateId);
      continue;
    }
    candidates.push(candidate);
    const fromStatus = existing?.status || null;
    const kind: AdaptiveLearningEventKind = !existing
      ? 'proposed'
      : candidate.status === 'ready_for_review' &&
          existing.status !== 'ready_for_review'
        ? 'ready_for_review'
        : 'evidence_accumulated';
    events.push(
      lifecycleEvent({
        candidate,
        episodeId: input.episode.episodeId,
        createdAt: now,
        kind,
        fromStatus,
        toStatus: candidate.status,
        evidenceRefs: seed.evidenceRefs,
        note: materiallyNewEvidence
          ? 'Materially new bounded evidence was reconciled.'
          : 'Duplicate evidence was observed without increasing recurrence.',
        synthetic: input.episode.runOrigin !== 'live',
      }),
    );
  }
  return {
    candidates: candidates.slice(0, ADAPTIVE_MAX_LEARNING_CANDIDATES),
    events: events.slice(0, ADAPTIVE_MAX_LEARNING_CANDIDATES),
    suppressedRejectedCandidateIds,
  };
}

function lifecycleEvent(input: {
  candidate: AdaptiveLearningCandidate;
  episodeId: string | null;
  createdAt: string;
  kind: AdaptiveLearningEventKind;
  fromStatus: AdaptiveLearningStatus | null;
  toStatus: AdaptiveLearningStatus;
  evidenceRefs?: string[];
  actorId?: string | null;
  explicitOwnerDecision?: boolean;
  note: string;
  synthetic?: boolean;
}): AdaptiveLearningLifecycleEvent {
  return {
    eventId: stableId(
      'agi:learning-event',
      `${input.candidate.candidateId}|${input.createdAt}|${input.kind}|${input.toStatus}|${input.note}`,
    ),
    candidateId: input.candidate.candidateId,
    episodeId: input.episodeId,
    createdAt: input.createdAt,
    kind: input.kind,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    evidenceRefs: unique(input.evidenceRefs || [], 24),
    actorId: input.actorId ? bounded(input.actorId, 160) : null,
    explicitOwnerDecision: input.explicitOwnerDecision === true,
    note: bounded(input.note, 700),
    synthetic: input.synthetic === true,
    executionAuthority: false,
  };
}

export function refreshAdaptiveLearningLifecycle(
  candidate: AdaptiveLearningCandidate,
  now: string,
): {
  candidate: AdaptiveLearningCandidate;
  event: AdaptiveLearningLifecycleEvent | null;
} {
  if (
    ['accepted', 'rejected', 'expired', 'superseded', 'rolled_back'].includes(
      candidate.status,
    ) ||
    Date.parse(now) < Date.parse(candidate.expiresAt)
  ) {
    return { candidate, event: null };
  }
  const updated: AdaptiveLearningCandidate = {
    ...candidate,
    updatedAt: now,
    status: 'expired',
  };
  return {
    candidate: updated,
    event: lifecycleEvent({
      candidate: updated,
      episodeId: candidate.sourceEpisodeIds[0] || null,
      createdAt: now,
      kind: 'expired',
      fromStatus: candidate.status,
      toStatus: 'expired',
      note: 'The bounded review window expired before owner acceptance.',
      synthetic: candidate.syntheticEvidence,
    }),
  };
}

export function reviewAdaptiveLearningCandidate(input: {
  candidate: AdaptiveLearningCandidate;
  decision: 'accept' | 'reject' | 'supersede' | 'rollback';
  reviewerId: string;
  explicitOwnerDecision: boolean;
  note: string;
  now: string;
  replacementCandidateId?: string | null;
}): {
  candidate: AdaptiveLearningCandidate;
  event: AdaptiveLearningLifecycleEvent;
} {
  const { candidate } = input;
  if (!input.explicitOwnerDecision) {
    throw new Error(
      'Adaptive learning review requires an explicit owner decision.',
    );
  }
  let status: AdaptiveLearningStatus;
  let kind: AdaptiveLearningEventKind;
  if (input.decision === 'accept') {
    if (candidate.status !== 'ready_for_review') {
      throw new Error('Only ready_for_review lessons can be accepted.');
    }
    if (
      !candidate.productionEligible ||
      candidate.blockedPromotionReasons.length
    ) {
      throw new Error(
        'This adaptive lesson is not eligible for production acceptance.',
      );
    }
    if (candidate.syntheticEvidence) {
      throw new Error(
        'Synthetic or replay evidence can never be accepted as production learning.',
      );
    }
    status = 'accepted';
    kind = 'owner_accepted';
  } else if (input.decision === 'reject') {
    if (['expired', 'superseded', 'rolled_back'].includes(candidate.status)) {
      throw new Error(`Cannot reject a ${candidate.status} lesson.`);
    }
    status = 'rejected';
    kind = 'owner_rejected';
  } else if (input.decision === 'supersede') {
    if (!input.replacementCandidateId) {
      throw new Error('Supersession requires a replacement candidate ID.');
    }
    status = 'superseded';
    kind = 'superseded';
  } else {
    if (candidate.status !== 'accepted') {
      throw new Error('Only an accepted lesson can be rolled back.');
    }
    status = 'rolled_back';
    kind = 'rolled_back';
  }
  const updated: AdaptiveLearningCandidate = {
    ...candidate,
    status,
    updatedAt: input.now,
    rejectionEvidenceFingerprint:
      status === 'rejected'
        ? candidate.evidenceFingerprint
        : candidate.rejectionEvidenceFingerprint,
    supersededByCandidateId:
      status === 'superseded'
        ? input.replacementCandidateId || null
        : candidate.supersededByCandidateId,
    ownerReview:
      input.decision === 'accept' || input.decision === 'reject'
        ? {
            reviewerId: bounded(input.reviewerId, 160),
            reviewedAt: input.now,
            decision: input.decision === 'accept' ? 'accepted' : 'rejected',
            note: bounded(input.note, 700),
          }
        : candidate.ownerReview,
  };
  return {
    candidate: updated,
    event: lifecycleEvent({
      candidate: updated,
      episodeId: candidate.sourceEpisodeIds[0] || null,
      createdAt: input.now,
      kind,
      fromStatus: candidate.status,
      toStatus: status,
      evidenceRefs: candidate.supportingEvidenceRefs,
      actorId: input.reviewerId,
      explicitOwnerDecision: true,
      note: input.note,
      synthetic: candidate.syntheticEvidence,
    }),
  };
}

function guidanceForCandidate(candidate: AdaptiveLearningCandidate): {
  response: string | null;
  planning: string | null;
  route: string | null;
  prohibited: string | null;
  uncertainty: string | null;
} {
  const lesson = bounded(candidate.proposedLesson, 500);
  switch (candidate.kind) {
    case 'unsupported_completion_claim':
    case 'technical_success_unverified_goal':
      return {
        response: lesson,
        planning:
          'Keep requested-outcome and goal verification open until authoritative evidence arrives.',
        route: null,
        prohibited:
          'Do not claim goal completion from tool success or provider acceptance.',
        uncertainty:
          'Disclose that the requested outcome or goal remains unverified.',
      };
    case 'stale_or_contradicted_memory':
    case 'poor_confidence_calibration':
      return {
        response: lesson,
        planning:
          'Prefer current authoritative evidence and retain unresolved contradictions.',
        route: null,
        prohibited: null,
        uncertainty: 'State material uncertainty or contradiction explicitly.',
      };
    case 'route_or_provider_unreliability':
      return {
        response: lesson,
        planning:
          'Use route reliability only as advisory evidence for read-only planning.',
        route: lesson,
        prohibited: null,
        uncertainty:
          'Disclose degraded route evidence when it affects the answer.',
      };
    case 'failed_follow_through':
    case 'verified_goal_failure':
    case 'partial_failure':
      return {
        response: lesson,
        planning:
          'Preserve unresolved commitments and verified blockers without resurrecting terminal goals.',
        route: null,
        prohibited: 'Do not close unresolved or partially completed work.',
        uncertainty: null,
      };
    case 'privacy_or_authority_near_miss':
      return {
        response: lesson,
        planning: 'Keep all guidance redacted, scoped, and advisory.',
        route: null,
        prohibited:
          'Do not infer permission, expose sensitive context, or expand action authority.',
        uncertainty: null,
      };
    default:
      return {
        response: lesson,
        planning: lesson,
        route: null,
        prohibited: null,
        uncertainty: null,
      };
  }
}

export function buildAdaptiveLearningGuidance(input: {
  frame: UnifiedGroundedCognitiveFrame;
  candidates: AdaptiveLearningCandidate[];
  now?: string;
}): AdaptiveLearningGuidance {
  const now = input.now || input.frame.updatedAt;
  const scopeKey = canonicalScope(input.frame);
  const applicable = input.candidates
    .filter(
      (candidate) =>
        candidate.status === 'accepted' &&
        candidate.productionEligible &&
        !candidate.syntheticEvidence &&
        candidate.executionAuthority === false &&
        candidate.blockedPromotionReasons.length === 0 &&
        (candidate.scopeKey === scopeKey || candidate.scopeKey === 'global') &&
        Date.parse(candidate.expiresAt) > Date.parse(now),
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        left.candidateId.localeCompare(right.candidateId),
    )
    .slice(0, ADAPTIVE_MAX_APPLIED_LESSONS);
  const mapped = applicable.map(guidanceForCandidate);
  return {
    generatedAt: now,
    scopeKey,
    appliedLessonIds: applicable.map((item) => item.candidateId),
    responseGuidance: unique(
      mapped.map((item) => item.response),
      12,
    ),
    planningGuidance: unique(
      mapped.map((item) => item.planning),
      12,
    ),
    routeGuidance: unique(
      mapped.map((item) => item.route),
      8,
    ),
    prohibitedClaims: unique(
      mapped.map((item) => item.prohibited),
      12,
    ),
    uncertaintyDisclosures: unique(
      mapped.map((item) => item.uncertainty),
      12,
    ),
    executionAuthority: false,
    approvalAuthority: false,
  };
}

export function applyAdaptiveGuidanceToResponseContract(
  contract: GroundedResponseContract,
  guidance: AdaptiveLearningGuidance,
): GroundedResponseContract {
  return {
    ...contract,
    uncertaintyDisclosures: unique(
      [...contract.uncertaintyDisclosures, ...guidance.uncertaintyDisclosures],
      24,
    ),
    prohibitedClaims: unique(
      [...contract.prohibitedClaims, ...guidance.prohibitedClaims],
      24,
    ),
    usefulReadOnlyWork: unique(
      [...contract.usefulReadOnlyWork, ...guidance.routeGuidance],
      16,
    ),
  };
}

export function recordAdaptiveLessonApplication(input: {
  candidate: AdaptiveLearningCandidate;
  episodeId: string;
  now: string;
}): {
  candidate: AdaptiveLearningCandidate;
  event: AdaptiveLearningLifecycleEvent;
} {
  if (input.candidate.status !== 'accepted') {
    throw new Error('Only accepted adaptive lessons can be applied.');
  }
  const candidate: AdaptiveLearningCandidate = {
    ...input.candidate,
    updatedAt: input.now,
    appliedCount: input.candidate.appliedCount + 1,
    lastAppliedAt: input.now,
  };
  return {
    candidate,
    event: lifecycleEvent({
      candidate,
      episodeId: input.episodeId,
      createdAt: input.now,
      kind: 'applied',
      fromStatus: 'accepted',
      toStatus: 'accepted',
      evidenceRefs: [input.episodeId],
      note: 'Accepted lesson contributed bounded response/planning guidance only.',
      synthetic: false,
    }),
  };
}

export function assessAdaptiveAssistiveReadiness(
  input: AdaptiveAssistiveReadinessInput,
): AdaptiveAssistiveReadinessAssessment {
  const gates: Array<[string, boolean]> = [
    ['sample_size', input.sampleSize >= input.minimumSampleSize],
    ['quality_improvement', input.learningRelevantImprovementPoints >= 8],
    [
      'quality_not_regressed',
      input.candidateQualityScore >= input.baselineQualityScore,
    ],
    ['authority', input.authorityViolations === 0],
    ['privacy', input.privacyViolations === 0],
    ['unsupported_completion', input.unsupportedCompletionClaims === 0],
    ['intent_target_preservation', input.lostIntentOrTargetCount === 0],
    ['contradiction_disclosure', input.contradictionDisclosureRate >= 0.95],
    ['calibration', input.calibrationScore >= 0.8],
    ['repair_rate', input.repairRate <= 0.2],
    ['latency', input.latencyP95Ms <= 300],
    ['context_bounds', input.contextWithinBounds],
    ['storage_bounds', input.storageWithinBounds],
    ['promotion_precision', input.promotionPrecision >= 0.95],
    ['rollback_ready', input.rollbackTestPassed],
    ['critical_failures', input.unresolvedCriticalFailures === 0],
    ['determinism', input.deterministicRunsIdentical],
  ];
  const passedGates = gates.filter(([, pass]) => pass).map(([name]) => name);
  const failedGates = gates.filter(([, pass]) => !pass).map(([name]) => name);
  const criticalFailure =
    input.authorityViolations > 0 ||
    input.privacyViolations > 0 ||
    input.unsupportedCompletionClaims > 0 ||
    input.lostIntentOrTargetCount > 0 ||
    input.unresolvedCriticalFailures > 0 ||
    input.priorCanaryCriticalFailure;
  let status: AdaptiveAssistiveReadinessStatus;
  if (input.canaryActive && criticalFailure) status = 'rollback_required';
  else if (input.canaryActive && failedGates.length > 0)
    status = 'canary_paused';
  else if (criticalFailure) status = 'not_ready';
  else if (failedGates.length > 0) status = 'not_ready';
  else if (input.ownerApprovedCanary) status = 'canary_candidate';
  else status = 'shadow_ready';
  const reasons = failedGates.map((gate) => `Gate ${gate} did not pass.`);
  if (failedGates.length === 0 && !input.ownerApprovedCanary) {
    reasons.push(
      'Deterministic gates pass, but explicit owner canary approval is still required.',
    );
  }
  if (status === 'canary_candidate') {
    reasons.push(
      'All deterministic gates and explicit owner approval pass for a response-planning-only canary.',
    );
  }
  if (status === 'rollback_required') {
    reasons.unshift(
      'A safety-critical canary condition requires immediate rollback to shadow.',
    );
  }
  return {
    assessmentId: stableId(
      'agi:readiness',
      `${input.evaluatedAt}|${status}|${passedGates.join(',')}|${failedGates.join(',')}`,
    ),
    evaluatedAt: input.evaluatedAt,
    status,
    passedGates,
    failedGates,
    reasons,
    canaryScope: {
      responsePlanningOnly: true,
      externalMutationAllowed: false,
      actionAuthorityExpanded: false,
      productionModeChanged: false,
    },
    rollbackRequired: status === 'rollback_required',
    ownerApprovalRequired: !input.ownerApprovedCanary,
  };
}

export function adaptiveGroundedIntelligenceDiagnostics(input: {
  episode: AdaptiveCognitiveEpisode;
  candidates?: AdaptiveLearningCandidate[];
  events?: AdaptiveLearningLifecycleEvent[];
  guidance?: AdaptiveLearningGuidance | null;
  readiness?: AdaptiveAssistiveReadinessAssessment | null;
}): Record<string, unknown> {
  const candidates = input.candidates || [];
  const events = input.events || [];
  const diagnostic = {
    version: input.episode.version,
    episodeId: input.episode.episodeId,
    turnId: input.episode.turnId,
    frameId: input.episode.frameId,
    whatAndreaThoughtHappened: input.episode.outcome.explanation,
    toolSuccessful: input.episode.outcome.toolTechnicallySuccessful,
    requestedOutcomeVerified: input.episode.outcome.requestedOutcomeVerified,
    userGoalAchieved: input.episode.outcome.goalAchieved,
    outcomeStatus: input.episode.outcome.status,
    unresolved: input.episode.outcome.unresolvedCommitmentIds,
    contradictions: input.episode.outcome.contradictedObservationIds,
    observations: input.episode.observations.map((item) => ({
      id: item.observationId,
      at: item.observedAt,
      source: item.source,
      authoritative: item.authoritative,
      synthetic: item.synthetic,
      evidenceRefs: item.evidenceRefs,
      summary: item.summary,
    })),
    proposedLessons: candidates.map((candidate) => ({
      id: candidate.candidateId,
      kind: candidate.kind,
      status: candidate.status,
      subject: candidate.subject,
      lesson: candidate.proposedLesson,
      supportingEvidence: candidate.supportingEvidenceRefs,
      counterEvidence: candidate.counterEvidenceRefs,
      recurrenceCount: candidate.recurrenceCount,
      confidence: candidate.confidence,
      readyReason:
        candidate.status === 'ready_for_review'
          ? 'Evidence, recurrence, confidence, and eligibility thresholds pass; explicit owner review remains mandatory.'
          : candidate.blockedPromotionReasons.length
            ? `Blocked: ${candidate.blockedPromotionReasons.join(', ')}`
            : `Status ${candidate.status}; recurrence ${candidate.recurrenceCount}/${ADAPTIVE_MIN_PROMOTION_RECURRENCE}.`,
      affectedModules: candidate.affectedModules,
      appliedCount: candidate.appliedCount,
      lastAppliedAt: candidate.lastAppliedAt,
      rollbackPlan: candidate.rollbackPlan,
      supersededBy: candidate.supersededByCandidateId,
      ownerReviewMandatory: candidate.ownerReviewMandatory,
      executionAuthority: candidate.executionAuthority,
    })),
    lifecycleEvents: events.map((event) => ({
      id: event.eventId,
      candidateId: event.candidateId,
      kind: event.kind,
      from: event.fromStatus,
      to: event.toStatus,
      explicitOwnerDecision: event.explicitOwnerDecision,
      note: event.note,
    })),
    appliedGuidance: input.guidance
      ? {
          lessonIds: input.guidance.appliedLessonIds,
          responseGuidance: input.guidance.responseGuidance,
          planningGuidance: input.guidance.planningGuidance,
          authority: 'none',
        }
      : null,
    assistiveReadiness: input.readiness
      ? {
          status: input.readiness.status,
          failedGates: input.readiness.failedGates,
          reasons: input.readiness.reasons,
          rollbackRequired: input.readiness.rollbackRequired,
        }
      : null,
    bounds: input.episode.bounds,
    authority: input.episode.invariants,
  };
  if (JSON.stringify(diagnostic).length <= ADAPTIVE_MAX_DIAGNOSTIC_CHARS) {
    return diagnostic;
  }
  return {
    version: input.episode.version,
    episodeId: input.episode.episodeId,
    truncated: true,
    whatAndreaThoughtHappened: input.episode.outcome.explanation,
    outcomeStatus: input.episode.outcome.status,
    unresolved: input.episode.outcome.unresolvedCommitmentIds,
    proposedLessonIds: candidates.map((item) => item.candidateId).slice(0, 24),
    assistiveReadiness: input.readiness?.status || null,
    bounds: input.episode.bounds,
    authority: input.episode.invariants,
  };
}

export function adaptivePersistedMetadata(input: {
  episode: AdaptiveCognitiveEpisode;
  guidance?: AdaptiveLearningGuidance | null;
  readiness?: AdaptiveAssistiveReadinessAssessment | null;
}): Record<string, string> {
  return {
    adaptive_grounded_version: input.episode.version,
    adaptive_episode_id: input.episode.episodeId,
    adaptive_outcome_status: input.episode.outcome.status,
    adaptive_tool_success: String(
      input.episode.outcome.toolTechnicallySuccessful,
    ),
    adaptive_requested_outcome_verified: String(
      input.episode.outcome.requestedOutcomeVerified,
    ),
    adaptive_goal_achieved: String(input.episode.outcome.goalAchieved),
    adaptive_unresolved_commitments: String(
      input.episode.outcome.unresolvedCommitmentIds.length,
    ),
    adaptive_observation_count: String(input.episode.bounds.observationCount),
    adaptive_learning_candidates: String(
      input.episode.learningCandidateIds.length,
    ),
    adaptive_applied_lessons: String(
      input.guidance?.appliedLessonIds.length || 0,
    ),
    adaptive_readiness: input.readiness?.status || 'not_assessed',
    adaptive_execution_authority: 'none',
    adaptive_raw_private_content_persisted: 'false',
    adaptive_synthetic_production_eligible: 'false',
  };
}
