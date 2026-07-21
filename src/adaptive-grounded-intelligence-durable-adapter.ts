import {
  insertAdaptiveLearningLifecycleEvent,
  isDatabaseInitialized,
  isIsolatedTestDatabase,
  listAdaptiveLearningLifecycleEvents,
  listCognitiveEpisodes,
  listGroundedLearningRecords,
  pruneAdaptiveGroundedLearningRecords,
  pruneAdaptiveLearningLifecycleEvents,
  pruneCognitiveEpisodes,
  upsertCognitiveEpisode,
  upsertGroundedLearningRecord,
} from './db.js';
import type {
  CognitiveEpisodeRecord,
  StoredAdaptiveLearningLifecycleEvent,
  StoredGroundedLearningRecord,
} from './types.js';
import {
  ADAPTIVE_EVENT_RETENTION_DAYS,
  type AdaptiveCognitiveEpisode,
  type AdaptiveLearningCandidate,
  type AdaptiveLearningGuidance,
  type AdaptiveLearningLifecycleEvent,
  type AdaptiveLearningStatus,
  type AdaptiveOutcomeObservation,
  appendAdaptiveOutcomeObservation,
  buildAdaptiveLearningGuidance,
  recordAdaptiveLessonApplication,
  reconcileAdaptiveOwnerFeedback,
  reconcileAdaptiveLearningWithLateOutcome,
  refreshAdaptiveLearningLifecycle,
  reviewAdaptiveLearningCandidate,
} from './adaptive-grounded-intelligence.js';
import type { UnifiedGroundedCognitiveFrame } from './unified-grounded-cognition.js';

const PRIVACY_JSON = JSON.stringify({
  rawPrivateContentPersisted: false,
  redactedMetadataOnly: true,
  executionAuthority: false,
});

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
    // Corrupt legacy metadata is intentionally treated as absent and cannot
    // become production-eligible learning evidence.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return fallback;
  }
}

function episodeResult(
  episode: AdaptiveCognitiveEpisode,
): CognitiveEpisodeRecord['result'] {
  if (episode.outcome.status === 'failed') return 'failed';
  if (episode.outcome.status === 'unknown') return 'deferred';
  if (episode.outcome.toolInvocationAttempted) return 'action_executed';
  return 'answered';
}

function toStoredEpisode(
  episode: AdaptiveCognitiveEpisode,
): CognitiveEpisodeRecord {
  const correction = episode.observations
    .filter((item) => Boolean(item.ownerCorrection))
    .map((item) => item.ownerCorrection)
    .filter((item): item is string => Boolean(item))
    .slice(-1)[0];
  const feedback = episode.observations
    .filter((item) => item.ownerCorrection || item.recommendationFeedback)
    .map((item) => ({
      observationId: item.observationId,
      ownerCorrection: item.ownerCorrection,
      recommendationFeedback: item.recommendationFeedback,
    }));
  return {
    episodeId: episode.episodeId,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
    schemaVersion: episode.version,
    unifiedFrameId: episode.frameId,
    turnId: episode.turnId,
    conversationId: episode.conversationId,
    groupFolder: episode.groupFolder,
    scopeKey: episode.scopeKey,
    runOrigin: episode.runOrigin,
    intentRefsJson: JSON.stringify(episode.intentClauseRefs),
    responseContractId: episode.responseContractId,
    responseEvaluationId: episode.responseEvaluationId,
    actionEvidenceRefsJson: JSON.stringify(episode.actionEvidenceRefs),
    providerReceiptIdsJson: JSON.stringify(episode.providerReceiptIds),
    goalIdsJson: JSON.stringify(episode.goalIds),
    commitmentIdsJson: JSON.stringify(episode.commitmentIds),
    observationsJson: JSON.stringify(episode.observations),
    reconciledOutcomeJson: JSON.stringify(episode.outcome),
    ownerFeedbackJson: JSON.stringify(feedback),
    learningCandidateIdsJson: JSON.stringify(episode.learningCandidateIds),
    appliedLessonIdsJson: JSON.stringify(episode.appliedLessonIds),
    lifecycleEventIdsJson: JSON.stringify(episode.promotionEventIds),
    rollbackEventIdsJson: JSON.stringify(episode.rollbackEventIds),
    expiresAt: episode.expiresAt,
    boundsJson: JSON.stringify(episode.bounds),
    askSummary:
      episode.intentClauseRefs
        .map((item) => `${item.actionClass}:${item.target}`)
        .join('; ')
        .slice(0, 240) || 'bounded unified turn',
    channel: episode.channel as CognitiveEpisodeRecord['channel'],
    goalId: episode.goalIds[0] || null,
    reasoningMode: 'unified_grounded_advisory',
    selectedContextSummary: `frame=${episode.frameId}; intents=${episode.intentClauseRefs.length}; observations=${episode.observations.length}`,
    actionId: null,
    result: episodeResult(episode),
    userCorrection: correction || null,
    confidence: episode.outcome.goalAchieved
      ? 1
      : episode.outcome.status === 'failed'
        ? 0.95
        : 0.5,
    lesson: episode.outcome.explanation,
    followUpNeeded:
      episode.outcome.unresolvedCommitmentIds.length > 0
        ? `Unresolved commitments: ${episode.outcome.unresolvedCommitmentIds.join(', ')}`
        : null,
    sensitivity: 'normal',
    retentionPolicy: episode.retentionPolicy,
    privacyJson: PRIVACY_JSON,
  };
}

function isAdaptiveEpisode(value: unknown): value is AdaptiveCognitiveEpisode {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<AdaptiveCognitiveEpisode>;
  return (
    typeof item.episodeId === 'string' &&
    typeof item.frameId === 'string' &&
    typeof item.turnId === 'string' &&
    Array.isArray(item.observations) &&
    Boolean(item.outcome) &&
    Boolean(item.bounds) &&
    Boolean(item.invariants)
  );
}

function fromStoredEpisode(
  record: CognitiveEpisodeRecord,
): AdaptiveCognitiveEpisode | null {
  if (!record.schemaVersion || !record.unifiedFrameId || !record.turnId) {
    return null;
  }
  const candidate: AdaptiveCognitiveEpisode = {
    episodeId: record.episodeId,
    version: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt || record.createdAt,
    expiresAt: record.expiresAt || record.createdAt,
    turnId: record.turnId,
    frameId: record.unifiedFrameId,
    conversationId: record.conversationId || record.turnId,
    channel: record.channel,
    groupFolder: record.groupFolder || null,
    scopeKey:
      record.scopeKey ||
      `${record.channel}:${record.groupFolder || record.turnId}`,
    runOrigin: record.runOrigin || 'replay',
    intentClauseRefs: parseJson(record.intentRefsJson, []),
    responseContractId: record.responseContractId || null,
    responseEvaluationId: record.responseEvaluationId || null,
    actionEvidenceRefs: parseJson(record.actionEvidenceRefsJson, []),
    providerReceiptIds: parseJson(record.providerReceiptIdsJson, []),
    goalIds: parseJson(record.goalIdsJson, []),
    commitmentIds: parseJson(record.commitmentIdsJson, []),
    observations: parseJson(record.observationsJson, []),
    outcome: parseJson(record.reconciledOutcomeJson, {
      reconciledAt: record.updatedAt || record.createdAt,
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
      explanation: 'Legacy adaptive episode lacks reconciled outcome metadata.',
      toolSuccessIsGoalSuccess: false,
    }),
    learningCandidateIds: parseJson(record.learningCandidateIdsJson, []),
    appliedLessonIds: parseJson(record.appliedLessonIdsJson, []),
    promotionEventIds: parseJson(record.lifecycleEventIdsJson, []),
    rollbackEventIds: parseJson(record.rollbackEventIdsJson, []),
    retentionPolicy: 'standard_90d',
    bounds: parseJson(record.boundsJson, {
      observationCount: 0,
      observationLimit: 48,
      evidenceRefCount: 0,
      evidenceRefLimit: 48,
      truncated: false,
    }),
    invariants: {
      executionAuthority: false,
      approvalAuthority: false,
      deliveryAuthority: false,
      learningPromotionAuthority: false,
      rawPrivateContentPersisted: false,
      syntheticProductionEligible: false,
    },
  };
  return isAdaptiveEpisode(candidate) ? candidate : null;
}

export function persistAdaptiveCognitiveEpisode(
  episode: AdaptiveCognitiveEpisode,
): boolean {
  if (!isDatabaseInitialized()) return false;
  // Evaluation and replay episodes are useful only in disposable stores. They
  // must never become durable production knowledge.
  if (episode.runOrigin !== 'live' && !isIsolatedTestDatabase()) return false;
  upsertCognitiveEpisode(toStoredEpisode(episode));
  return true;
}

export function loadAdaptiveCognitiveEpisode(input: {
  episodeId?: string;
  turnId?: string;
  frameId?: string;
}): AdaptiveCognitiveEpisode | null {
  if (!isDatabaseInitialized()) return null;
  const records = listCognitiveEpisodes({
    turnId: input.turnId,
    unifiedFrameId: input.frameId,
    limit: 500,
  });
  const selected = input.episodeId
    ? records.find((record) => record.episodeId === input.episodeId)
    : records[0];
  return selected ? fromStoredEpisode(selected) : null;
}

export function reconcileAndPersistAdaptiveObservation(input: {
  episode: AdaptiveCognitiveEpisode;
  observation: AdaptiveOutcomeObservation;
}): AdaptiveCognitiveEpisode {
  const episode = appendAdaptiveOutcomeObservation(
    input.episode,
    input.observation,
  );
  const candidates = loadAdaptiveLearningCandidates({
    scopeKey: episode.scopeKey,
    limit: 500,
  });
  const reconciled = candidates.map((candidate) =>
    reconcileAdaptiveLearningWithLateOutcome({
      candidate,
      episode,
      observation: input.observation,
      now: input.observation.observedAt,
    }),
  );
  const changed = reconciled.filter((item) => Boolean(item.event));
  if (changed.length > 0) {
    persistAdaptiveLearning({
      candidates: changed.map((item) => item.candidate),
      events: changed
        .map((item) => item.event)
        .filter((item): item is AdaptiveLearningLifecycleEvent =>
          Boolean(item),
        ),
    });
  }
  persistAdaptiveCognitiveEpisode(episode);
  return episode;
}

export function reconcileAdaptiveOwnerFeedbackByTurn(input: {
  turnId: string | null | undefined;
  feedbackId: string;
  verdict: 'accepted' | 'rejected';
  routeKey?: string | null;
  completionVerified?: boolean;
  correction?: boolean;
  reason?: string | null;
  observedAt: string;
}): AdaptiveCognitiveEpisode | null {
  if (!input.turnId || !isDatabaseInitialized()) return null;
  const episode = loadAdaptiveCognitiveEpisode({ turnId: input.turnId });
  if (!episode || episode.runOrigin !== 'live') return null;
  const existingCandidates = loadAdaptiveLearningCandidates({
    scopeKey: episode.scopeKey,
    limit: 500,
  });
  const reconciled = reconcileAdaptiveOwnerFeedback({
    episode,
    feedbackId: input.feedbackId,
    verdict: input.verdict,
    routeKey: input.routeKey,
    completionVerified: input.completionVerified,
    correction: input.correction,
    reason: input.reason,
    existingCandidates,
    observedAt: input.observedAt,
  });
  persistAdaptiveLearning(reconciled);
  persistAdaptiveCognitiveEpisode(reconciled.episode);
  return reconciled.episode;
}

function baseKind(
  candidate: AdaptiveLearningCandidate,
): StoredGroundedLearningRecord['kind'] {
  if (candidate.kind === 'route_or_provider_unreliability') {
    return 'tool_reliability';
  }
  if (
    candidate.kind === 'poor_confidence_calibration' ||
    candidate.kind === 'stale_or_contradicted_memory'
  ) {
    return 'calibration';
  }
  if (candidate.kind === 'privacy_or_authority_near_miss') {
    return 'wrong_assumption';
  }
  return 'plan_pattern';
}

function baseStatus(
  status: AdaptiveLearningStatus,
): StoredGroundedLearningRecord['status'] {
  if (status === 'accepted') return 'accepted';
  if (['expired', 'superseded', 'rolled_back'].includes(status)) {
    return 'retired';
  }
  // Rejection is retained in adaptive_status while the compatibility status
  // stays proposed, allowing materially new evidence to reopen review without
  // violating the legacy one-way status transition.
  return 'proposed';
}

function toStoredCandidate(
  candidate: AdaptiveLearningCandidate,
): StoredGroundedLearningRecord {
  return {
    recordId: candidate.candidateId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
    kind: baseKind(candidate),
    status: baseStatus(candidate.status),
    subject: candidate.subject,
    contextKey: candidate.scopeKey,
    lesson: candidate.proposedLesson,
    evidenceRefsJson: JSON.stringify(candidate.supportingEvidenceRefs),
    counterEvidenceRefsJson: JSON.stringify(candidate.counterEvidenceRefs),
    appliesToAuthority: false,
    reviewNote:
      candidate.ownerReview?.note || 'Explicit owner review required.',
    sourceTurnId: candidate.sourceTurnIds[0] || null,
    adaptiveStatus: candidate.status,
    adaptiveKind: candidate.kind,
    adaptiveMetadataJson: JSON.stringify(candidate),
    expiresAt: candidate.expiresAt,
    reviewAfter: candidate.reviewAfter,
    ownerReviewRequired: true,
    productionEligible: candidate.productionEligible,
    appliedCount: candidate.appliedCount,
    lastAppliedAt: candidate.lastAppliedAt,
    privacyJson: PRIVACY_JSON,
  };
}

function fromStoredCandidate(
  stored: StoredGroundedLearningRecord,
): AdaptiveLearningCandidate | null {
  const parsed = parseJson<AdaptiveLearningCandidate | null>(
    stored.adaptiveMetadataJson,
    null,
  );
  if (
    !parsed ||
    parsed.candidateId !== stored.recordId ||
    parsed.executionAuthority !== false ||
    !stored.adaptiveStatus
  ) {
    return null;
  }
  return {
    ...parsed,
    status: stored.adaptiveStatus,
    updatedAt: stored.updatedAt,
    productionEligible: stored.productionEligible === true,
    executionAuthority: false,
    appliedCount: stored.appliedCount || 0,
    lastAppliedAt: stored.lastAppliedAt || null,
  };
}

function toStoredEvent(
  event: AdaptiveLearningLifecycleEvent,
): StoredAdaptiveLearningLifecycleEvent {
  return {
    eventId: event.eventId,
    candidateId: event.candidateId,
    episodeId: event.episodeId,
    createdAt: event.createdAt,
    kind: event.kind,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    evidenceRefsJson: JSON.stringify(event.evidenceRefs),
    actorId: event.actorId,
    explicitOwnerDecision: event.explicitOwnerDecision,
    note: event.note,
    synthetic: event.synthetic,
    executionAuthority: false,
    privacyJson: PRIVACY_JSON,
  };
}

function fromStoredEvent(
  event: StoredAdaptiveLearningLifecycleEvent,
): AdaptiveLearningLifecycleEvent {
  return {
    eventId: event.eventId,
    candidateId: event.candidateId,
    episodeId: event.episodeId,
    createdAt: event.createdAt,
    kind: event.kind,
    fromStatus: event.fromStatus as AdaptiveLearningStatus | null,
    toStatus: event.toStatus as AdaptiveLearningStatus,
    evidenceRefs: parseJson(event.evidenceRefsJson, []),
    actorId: event.actorId,
    explicitOwnerDecision: event.explicitOwnerDecision,
    note: event.note,
    synthetic: event.synthetic,
    executionAuthority: false,
  };
}

export function persistAdaptiveLearning(input: {
  candidates: AdaptiveLearningCandidate[];
  events?: AdaptiveLearningLifecycleEvent[];
}): { candidatesPersisted: number; eventsPersisted: number } {
  if (!isDatabaseInitialized()) {
    return { candidatesPersisted: 0, eventsPersisted: 0 };
  }
  let candidatesPersisted = 0;
  for (const candidate of input.candidates) {
    if (candidate.syntheticEvidence && !isIsolatedTestDatabase()) continue;
    upsertGroundedLearningRecord(toStoredCandidate(candidate));
    candidatesPersisted += 1;
  }
  let eventsPersisted = 0;
  for (const event of input.events || []) {
    if (event.synthetic && !isIsolatedTestDatabase()) continue;
    // Foreign-key safety: an event is durable only after its candidate row.
    if (
      !input.candidates.some((item) => item.candidateId === event.candidateId)
    ) {
      const existing = listGroundedLearningRecords({ limit: 500 }).some(
        (item) => item.recordId === event.candidateId,
      );
      if (!existing) continue;
    }
    insertAdaptiveLearningLifecycleEvent(toStoredEvent(event));
    eventsPersisted += 1;
  }
  return { candidatesPersisted, eventsPersisted };
}

export function loadAdaptiveLearningCandidates(
  input: {
    status?: AdaptiveLearningStatus;
    scopeKey?: string;
    limit?: number;
  } = {},
): AdaptiveLearningCandidate[] {
  if (!isDatabaseInitialized()) return [];
  return listGroundedLearningRecords({
    adaptiveStatus: input.status,
    contextKey: input.scopeKey,
    limit: input.limit || 500,
  })
    .map(fromStoredCandidate)
    .filter((item): item is AdaptiveLearningCandidate => Boolean(item));
}

export function reviewAdaptiveLearningCandidateDurably(input: {
  candidateId: string;
  decision: 'accept' | 'reject' | 'supersede' | 'rollback';
  reviewerId: string;
  explicitOwnerDecision: boolean;
  note: string;
  now: string;
  replacementCandidateId?: string | null;
}): AdaptiveLearningCandidate | null {
  const candidate = loadAdaptiveLearningCandidates({ limit: 500 }).find(
    (item) => item.candidateId === input.candidateId,
  );
  if (!candidate) return null;
  const reviewed = reviewAdaptiveLearningCandidate({
    candidate,
    decision: input.decision,
    reviewerId: input.reviewerId,
    explicitOwnerDecision: input.explicitOwnerDecision,
    note: input.note,
    now: input.now,
    replacementCandidateId: input.replacementCandidateId,
  });
  persistAdaptiveLearning({
    candidates: [reviewed.candidate],
    events: [reviewed.event],
  });
  return reviewed.candidate;
}

export function loadAdaptiveGuidanceForFrame(
  frame: UnifiedGroundedCognitiveFrame,
  now = frame.updatedAt,
): {
  guidance: AdaptiveLearningGuidance;
  candidates: AdaptiveLearningCandidate[];
  expirationEvents: AdaptiveLearningLifecycleEvent[];
} {
  const accepted = loadAdaptiveLearningCandidates({
    status: 'accepted',
    limit: 500,
  });
  const current: AdaptiveLearningCandidate[] = [];
  const expirationEvents: AdaptiveLearningLifecycleEvent[] = [];
  for (const candidate of accepted) {
    const refreshed = refreshAdaptiveLearningLifecycle(candidate, now);
    current.push(refreshed.candidate);
    if (refreshed.event) expirationEvents.push(refreshed.event);
  }
  if (expirationEvents.length > 0) {
    persistAdaptiveLearning({
      candidates: current.filter((item) => item.status === 'expired'),
      events: expirationEvents,
    });
  }
  const candidates = current.filter((item) => item.status === 'accepted');
  return {
    guidance: buildAdaptiveLearningGuidance({ frame, candidates, now }),
    candidates,
    expirationEvents,
  };
}

export function persistAdaptiveLessonApplications(input: {
  episode: AdaptiveCognitiveEpisode;
  candidates: AdaptiveLearningCandidate[];
  guidance: AdaptiveLearningGuidance;
  now: string;
}): {
  episode: AdaptiveCognitiveEpisode;
  candidates: AdaptiveLearningCandidate[];
  events: AdaptiveLearningLifecycleEvent[];
} {
  const candidateById = new Map(
    input.candidates.map((candidate) => [candidate.candidateId, candidate]),
  );
  const candidates: AdaptiveLearningCandidate[] = [];
  const events: AdaptiveLearningLifecycleEvent[] = [];
  for (const candidateId of input.guidance.appliedLessonIds) {
    const candidate = candidateById.get(candidateId);
    if (!candidate) continue;
    const applied = recordAdaptiveLessonApplication({
      candidate,
      episodeId: input.episode.episodeId,
      now: input.now,
    });
    candidates.push(applied.candidate);
    events.push(applied.event);
  }
  const episode: AdaptiveCognitiveEpisode = {
    ...input.episode,
    updatedAt: input.now,
    appliedLessonIds: Array.from(
      new Set([
        ...input.episode.appliedLessonIds,
        ...input.guidance.appliedLessonIds,
      ]),
    ).slice(0, 24),
    promotionEventIds: Array.from(
      new Set([
        ...input.episode.promotionEventIds,
        ...events.map((event) => event.eventId),
      ]),
    ).slice(0, 48),
  };
  persistAdaptiveLearning({ candidates, events });
  persistAdaptiveCognitiveEpisode(episode);
  return { episode, candidates, events };
}

export function listAdaptiveLearningEvents(
  input: {
    candidateId?: string;
    episodeId?: string;
    limit?: number;
  } = {},
): AdaptiveLearningLifecycleEvent[] {
  return listAdaptiveLearningLifecycleEvents(input).map(fromStoredEvent);
}

export function pruneAdaptiveGroundedIntelligence(
  now = new Date().toISOString(),
): { episodes: number; learningRecords: number; lifecycleEvents: number } {
  if (!isDatabaseInitialized()) {
    return { episodes: 0, learningRecords: 0, lifecycleEvents: 0 };
  }
  const cutoff = new Date(
    Date.parse(now) - ADAPTIVE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  return {
    episodes: pruneCognitiveEpisodes({ now }),
    learningRecords: pruneAdaptiveGroundedLearningRecords({
      cutoffIso: cutoff,
      retainLimit: 2_000,
    }),
    lifecycleEvents: pruneAdaptiveLearningLifecycleEvents({
      cutoffIso: cutoff,
      retainLimit: 5_000,
    }),
  };
}
