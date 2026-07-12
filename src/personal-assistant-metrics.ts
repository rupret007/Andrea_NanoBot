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
  return Number((numerator / denominator).toFixed(3));
}

function count(
  events: AssistantMetricEventRecord[],
  kind: AssistantMetricEventKind,
): number {
  return events
    .filter((event) => event.kind === kind)
    .reduce((sum, event) => sum + event.value, 0);
}

function reviewedOutcomeCount(events: AssistantMetricEventRecord[]): number {
  const reviewed = events.filter((event) =>
    ['recommendation_accepted', 'recommendation_rejected'].includes(event.kind),
  );
  return new Set(
    reviewed.map((event) => {
      try {
        const metadata = JSON.parse(event.metadataJson) as Record<
          string,
          unknown
        >;
        const identity =
          metadata.packetId ||
          metadata.bundleId ||
          metadata.ruleId ||
          metadata.outcomeId;
        return typeof identity === 'string' && identity
          ? `${event.groupFolder}:${identity}`
          : event.eventId;
      } catch {
        return event.eventId;
      }
    }),
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
    outcomeId: params.feedbackId,
    ...(params.metadata || {}),
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
  const accepted = count(events, 'recommendation_accepted');
  const rejected = count(events, 'recommendation_rejected');
  const verified = count(events, 'completion_verified');
  const corrections = count(events, 'correction');
  const overrides = count(events, 'override');
  const falseProactive = count(events, 'proactive_false_positive');
  const memoryRetrievals = count(events, 'memory_retrieval');
  const correctMemory = count(events, 'memory_retrieval_correct');
  const citedRetrievals = count(events, 'retrieval_with_citation');
  const toolAttempts = count(events, 'tool_attempt');
  const toolSuccesses = count(events, 'tool_success');
  const latency = events.filter((event) => event.kind === 'latency_sample');
  return {
    snapshotId: randomUUID(),
    groupFolder: params.groupFolder,
    generatedAt: now.toISOString(),
    acceptedRecommendationRate: ratio(accepted, accepted + rejected),
    verifiedCompletionRate: ratio(verified, accepted),
    correctionOverrideRate: ratio(corrections + overrides, accepted + rejected),
    falseProactiveSuggestionRate: ratio(falseProactive, accepted + rejected),
    memoryPrecision: ratio(correctMemory, memoryRetrievals),
    retrievalCitationCoverage: ratio(citedRetrievals, memoryRetrievals),
    toolReliability: ratio(toolSuccesses, toolAttempts),
    averageLatencyMs:
      latency.length > 0
        ? Math.round(
            latency.reduce((sum, event) => sum + event.value, 0) /
              latency.length,
          )
        : 0,
    liveEvalCostUsd: Number(count(events, 'live_eval_cost').toFixed(4)),
    sampleCount: events.length,
    reviewedOutcomeCount: reviewedOutcomeCount(events),
  };
}

export function saveAssistantMetricBaseline(
  snapshot: AssistantMetricSnapshot,
): void {
  insertAssistantMetricBaseline(snapshot);
}

export const MIN_REVIEWED_BASELINE_SAMPLES = 5;

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
    if (Number(current[key]) + 0.02 < Number(baseline[key])) {
      regressions.push(
        `${key} regressed from ${baseline[key]} to ${current[key]}`,
      );
    }
  }
  if (current.correctionOverrideRate > baseline.correctionOverrideRate + 0.02) {
    regressions.push('correctionOverrideRate increased');
  }
  if (
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
