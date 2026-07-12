import { randomUUID } from 'node:crypto';

import {
  getLatestAssistantMetricBaseline,
  insertAssistantMetricBaseline,
  insertAssistantMetricEvent,
  listAssistantMetricEvents,
  upsertRedactedRegressionFixture,
} from './db.js';
import type {
  AssistantMetricEventKind,
  AssistantMetricEventRecord,
  AssistantMetricSnapshot,
  RedactedRegressionFixture,
  ResponseFeedbackRecord,
} from './types.js';
import { getResponseFeedbackRouteRegressionCoverage } from './response-feedback-route-coverage.js';

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(Math.max(0, Math.min(1, numerator / denominator)).toFixed(3));
}

function count(
  events: AssistantMetricEventRecord[],
  kind: AssistantMetricEventKind,
): number {
  return events
    .filter((event) => event.kind === kind)
    .reduce((sum, event) => sum + event.value, 0);
}

function metricMetadata(
  event: AssistantMetricEventRecord,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(event.metadataJson) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function reviewedOutcomeIdentity(event: AssistantMetricEventRecord): string {
  const metadata = metricMetadata(event);
  const identity =
    metadata.packetId ||
    metadata.bundleId ||
    metadata.ruleId ||
    metadata.outcomeId;
  return typeof identity === 'string' && identity
    ? `${event.groupFolder}:${identity}`
    : `${event.groupFolder}:event:${event.eventId}`;
}

function decisionIsNewer(
  candidate: AssistantMetricEventRecord,
  current: AssistantMetricEventRecord,
): boolean {
  const timestampOrder = candidate.createdAt.localeCompare(current.createdAt);
  if (timestampOrder !== 0) return timestampOrder > 0;
  const candidateHasMissionVerdict =
    typeof metricMetadata(candidate).verdict === 'string';
  const currentHasMissionVerdict =
    typeof metricMetadata(current).verdict === 'string';
  if (candidateHasMissionVerdict !== currentHasMissionVerdict) {
    return candidateHasMissionVerdict;
  }
  return candidate.eventId.localeCompare(current.eventId) > 0;
}

function latestReviewedDecisionEvents(
  events: AssistantMetricEventRecord[],
): AssistantMetricEventRecord[] {
  const latestByOutcome = new Map<string, AssistantMetricEventRecord>();
  for (const event of events) {
    if (
      event.kind !== 'recommendation_accepted' &&
      event.kind !== 'recommendation_rejected'
    ) {
      continue;
    }
    const identity = reviewedOutcomeIdentity(event);
    const current = latestByOutcome.get(identity);
    if (!current || decisionIsNewer(event, current)) {
      latestByOutcome.set(identity, event);
    }
  }
  return [...latestByOutcome.values()];
}

function distinctReviewedSignalCount(
  events: AssistantMetricEventRecord[],
  kinds: AssistantMetricEventKind[],
): number {
  const acceptedKinds = new Set(kinds);
  return new Set(
    events
      .filter((event) => acceptedKinds.has(event.kind))
      .map(reviewedOutcomeIdentity),
  ).size;
}

export function recordAssistantMetric(params: {
  eventId?: string;
  groupFolder: string;
  kind: AssistantMetricEventKind;
  value?: number;
  metadata?: Record<string, string | number | boolean>;
  now?: Date;
}): AssistantMetricEventRecord {
  const record: AssistantMetricEventRecord = {
    eventId: params.eventId || randomUUID(),
    groupFolder: params.groupFolder,
    kind: params.kind,
    value: Number.isFinite(params.value) ? Number(params.value) : 1,
    metadataJson: JSON.stringify(params.metadata || {}),
    createdAt: (params.now || new Date()).toISOString(),
  };
  insertAssistantMetricEvent(record);
  return record;
}

export function recordReviewedRecommendationOutcome(params: {
  feedbackId: string;
  groupFolder: string;
  verdict: 'accepted' | 'rejected';
  completionVerified?: boolean;
  correction?: boolean;
  metadata?: Record<string, string | number | boolean>;
  now?: Date;
}): AssistantMetricEventRecord[] {
  const now = params.now || new Date();
  const metadata = {
    ...(params.metadata || {}),
    outcomeId: params.feedbackId,
    metricClass: 'owner_review',
  };
  const events = [
    recordAssistantMetric({
      eventId: `feedback:${params.feedbackId}:review`,
      groupFolder: params.groupFolder,
      kind:
        params.verdict === 'accepted'
          ? 'recommendation_accepted'
          : 'recommendation_rejected',
      metadata,
      now,
    }),
  ];
  if (params.verdict === 'accepted' && params.completionVerified) {
    events.push(
      recordAssistantMetric({
        eventId: `feedback:${params.feedbackId}:completion`,
        groupFolder: params.groupFolder,
        kind: 'completion_verified',
        metadata,
        now,
      }),
    );
  }
  if (params.verdict === 'rejected' && params.correction) {
    events.push(
      recordAssistantMetric({
        eventId: `feedback:${params.feedbackId}:correction`,
        groupFolder: params.groupFolder,
        kind: 'correction',
        metadata,
        now,
      }),
    );
  }
  return events;
}

export function recordMemoryRetrievalJudgment(params: {
  groupFolder: string;
  packetId: string;
  correct: boolean;
  reviewSource: 'natural_language' | 'operator';
  now?: Date;
}): AssistantMetricEventRecord | undefined {
  const packetId = params.packetId.trim();
  if (!packetId) return undefined;
  const matchingRetrieval = listAssistantMetricEvents({
    groupFolder: params.groupFolder,
    limit: 10_000,
  }).find((event) => {
    if (event.kind !== 'memory_retrieval') return false;
    const metadata = metricMetadata(event);
    return (
      metadata.metricClass === 'assistant_interaction' &&
      metadata.packetId === packetId
    );
  });
  if (!matchingRetrieval) return undefined;
  return recordAssistantMetric({
    eventId: `memory:${packetId}:owner-judgment`,
    groupFolder: params.groupFolder,
    kind: 'memory_retrieval_reviewed',
    value: params.correct ? 1 : 0,
    metadata: {
      metricClass: 'assistant_interaction',
      packetId,
      reviewSource: params.reviewSource,
    },
    now: params.now,
  });
}

export function buildAssistantMetricSnapshot(params: {
  groupFolder: string;
  now?: Date;
  lookbackDays?: number;
}): AssistantMetricSnapshot {
  const now = params.now || new Date();
  const since = new Date(
    now.getTime() - (params.lookbackDays || 90) * 86_400_000,
  ).toISOString();
  const events = listAssistantMetricEvents({
    groupFolder: params.groupFolder,
    since,
  });
  const ownerReviewEvents = events.filter(
    (event) => metricMetadata(event).metricClass === 'owner_review',
  );
  const reviewedDecisions = latestReviewedDecisionEvents(ownerReviewEvents);
  const accepted = reviewedDecisions.filter(
    (event) => event.kind === 'recommendation_accepted',
  ).length;
  const rejected = reviewedDecisions.filter(
    (event) => event.kind === 'recommendation_rejected',
  ).length;
  const verified = distinctReviewedSignalCount(ownerReviewEvents, [
    'completion_verified',
  ]);
  const correctionOverrides = distinctReviewedSignalCount(ownerReviewEvents, [
    'correction',
    'override',
  ]);
  const falseProactive = distinctReviewedSignalCount(ownerReviewEvents, [
    'proactive_false_positive',
  ]);
  const comparableInteractionEvents = events.filter(
    (event) => metricMetadata(event).metricClass === 'assistant_interaction',
  );
  const memoryRetrievals = count(
    comparableInteractionEvents,
    'memory_retrieval',
  );
  const memoryJudgments = comparableInteractionEvents.filter(
    (event) => event.kind === 'memory_retrieval_reviewed',
  );
  const correctMemory = memoryJudgments.reduce(
    (sum, event) => sum + event.value,
    0,
  );
  const citationEligibleRetrievals = comparableInteractionEvents.filter(
    (event) =>
      event.kind === 'memory_retrieval' &&
      Number(metricMetadata(event).resultCount) > 0,
  );
  const citedRetrievals = count(
    comparableInteractionEvents,
    'retrieval_with_citation',
  );
  const toolAttempts = count(comparableInteractionEvents, 'tool_attempt');
  const toolSuccesses = count(comparableInteractionEvents, 'tool_success');
  const latency = events.filter((event) => {
    if (event.kind !== 'latency_sample') return false;
    const metadata = metricMetadata(event);
    return (
      metadata.latencyClass === 'interaction_delivery' &&
      metadata.runOrigin !== 'replay' &&
      metadata.runOrigin !== 'synthetic'
    );
  });
  return {
    snapshotId: randomUUID(),
    groupFolder: params.groupFolder,
    generatedAt: now.toISOString(),
    acceptedRecommendationRate: ratio(accepted, accepted + rejected),
    verifiedCompletionRate: ratio(verified, accepted),
    correctionOverrideRate: ratio(correctionOverrides, accepted + rejected),
    falseProactiveSuggestionRate: ratio(falseProactive, accepted + rejected),
    memoryPrecision: ratio(correctMemory, memoryJudgments.length),
    memoryPrecisionSampleCount: memoryJudgments.length,
    retrievalCitationCoverage: ratio(
      citedRetrievals,
      citationEligibleRetrievals.length,
    ),
    retrievalCitationSampleCount: citationEligibleRetrievals.length,
    memoryRetrievalSampleCount: memoryRetrievals,
    toolReliability: ratio(toolSuccesses, toolAttempts),
    toolReliabilitySampleCount: toolAttempts,
    averageLatencyMs:
      latency.length > 0
        ? Math.round(
            latency.reduce((sum, event) => sum + event.value, 0) /
              latency.length,
          )
        : 0,
    interactionLatencySampleCount: latency.length,
    liveEvalCostUsd: Number(count(events, 'live_eval_cost').toFixed(4)),
    sampleCount: events.length,
    reviewedOutcomeCount: reviewedDecisions.length,
  };
}

export function saveAssistantMetricBaseline(
  snapshot: AssistantMetricSnapshot,
): void {
  insertAssistantMetricBaseline(snapshot);
}

export const MIN_REVIEWED_BASELINE_SAMPLES = 5;

export interface ReviewedOutcomeProgress {
  reviewedOutcomeCount: number;
  requiredOutcomeCount: number;
  remainingOutcomeCount: number;
  baselineReady: boolean;
  baselineSaved: boolean;
}

export function buildReviewedOutcomeProgress(params: {
  groupFolder: string;
  now?: Date;
  minimumSamples?: number;
}): ReviewedOutcomeProgress {
  const requiredOutcomeCount = Math.max(
    1,
    params.minimumSamples || MIN_REVIEWED_BASELINE_SAMPLES,
  );
  const snapshot = buildAssistantMetricSnapshot({
    groupFolder: params.groupFolder,
    now: params.now,
  });
  return {
    reviewedOutcomeCount: snapshot.reviewedOutcomeCount,
    requiredOutcomeCount,
    remainingOutcomeCount: Math.max(
      0,
      requiredOutcomeCount - snapshot.reviewedOutcomeCount,
    ),
    baselineReady: snapshot.reviewedOutcomeCount >= requiredOutcomeCount,
    baselineSaved: Boolean(
      getLatestAssistantMetricBaseline(params.groupFolder),
    ),
  };
}

export function formatReviewedOutcomeProgress(
  progress: ReviewedOutcomeProgress,
): string {
  if (progress.baselineSaved) {
    return `Learning evidence: ${progress.reviewedOutcomeCount} genuine owner-reviewed outcome${progress.reviewedOutcomeCount === 1 ? '' : 's'} in the current window; an operator-reviewed baseline is already saved.`;
  }
  if (progress.baselineReady) {
    return `Learning evidence: ${progress.reviewedOutcomeCount}/${progress.requiredOutcomeCount} genuine owner-reviewed outcomes. The first baseline is ready for operator review, but I will not save it automatically.`;
  }
  return `Learning evidence: ${progress.reviewedOutcomeCount}/${progress.requiredOutcomeCount} genuine owner-reviewed outcomes; ${progress.remainingOutcomeCount} more needed before the first baseline can be reviewed.`;
}

export function saveReviewedAssistantMetricBaseline(
  snapshot: AssistantMetricSnapshot,
  minimumSamples = MIN_REVIEWED_BASELINE_SAMPLES,
): void {
  if (snapshot.reviewedOutcomeCount < minimumSamples) {
    throw new Error(
      `Assistant metric baseline requires at least ${minimumSamples} reviewed outcomes; found ${snapshot.reviewedOutcomeCount}.`,
    );
  }
  saveAssistantMetricBaseline(snapshot);
}

export function compareAssistantMetricsToBaseline(
  current: AssistantMetricSnapshot,
): { baseline?: AssistantMetricSnapshot; regressions: string[] } {
  const baseline = getLatestAssistantMetricBaseline(current.groupFolder);
  if (!baseline) return { regressions: [] };
  const regressions: string[] = [];
  const higherIsBetter: Array<keyof AssistantMetricSnapshot> = [
    'acceptedRecommendationRate',
    'verifiedCompletionRate',
    'memoryPrecision',
    'retrievalCitationCoverage',
    'toolReliability',
  ];
  for (const key of higherIsBetter) {
    const hasComparableSamples =
      key === 'memoryPrecision'
        ? current.memoryPrecisionSampleCount > 0
        : key === 'retrievalCitationCoverage'
          ? current.retrievalCitationSampleCount > 0
          : key === 'toolReliability'
            ? current.toolReliabilitySampleCount > 0
            : current.reviewedOutcomeCount > 0;
    if (!hasComparableSamples) continue;
    if (Number(current[key]) + 0.02 < Number(baseline[key])) {
      regressions.push(
        `${key} regressed from ${baseline[key]} to ${current[key]}`,
      );
    }
  }
  if (
    current.reviewedOutcomeCount > 0 &&
    current.correctionOverrideRate > baseline.correctionOverrideRate + 0.02
  ) {
    regressions.push('correctionOverrideRate increased');
  }
  if (
    current.reviewedOutcomeCount > 0 &&
    current.falseProactiveSuggestionRate >
      baseline.falseProactiveSuggestionRate + 0.02
  ) {
    regressions.push('falseProactiveSuggestionRate increased');
  }
  return { baseline, regressions };
}

export function createRegressionFixtureFromFeedback(
  feedback: ResponseFeedbackRecord,
  now = new Date(),
): RedactedRegressionFixture {
  const routeCoverage = getResponseFeedbackRouteRegressionCoverage(feedback);
  const expectedBehavior = [
    routeCoverage?.summary ||
      `Avoid feedback class ${feedback.classification}.`,
    feedback.blockerClass
      ? `Handle blocker class ${feedback.blockerClass} honestly.`
      : 'Preserve approval, privacy, and evidence gates.',
  ].join(' ');
  const fixture: RedactedRegressionFixture = {
    fixtureId: randomUUID(),
    sourceFeedbackId: feedback.feedbackId,
    classification: feedback.classification,
    routeKey: feedback.routeKey,
    capabilityId: feedback.capabilityId,
    expectedBehavior,
    remediationStatus:
      feedback.status === 'resolved_locally' ? 'fixed' : 'open',
    containsRawUserText: false,
    createdAt: now.toISOString(),
  };
  upsertRedactedRegressionFixture(fixture);
  return fixture;
}
