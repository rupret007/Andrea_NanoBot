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

function isLegacyCouncilCostReservation(
  event: AssistantMetricEventRecord,
): boolean {
  if (event.kind !== 'live_eval_cost') return false;
  const metadata = metricMetadata(event);
  // A short-lived pre-release candidate used this metadata label. Keep it
  // readable without treating the value as provider billing.
  if (metadata.costAccountingClass === 'conservative_upper_bound_reservation')
    return true;
  if (metadata.costAccountingClass === 'conservative_estimate_reservation')
    return true;
  if (metadata.costAccountingClass === 'fixed_estimate_reservation')
    return true;
  if (metadata.actualCostKnown === false) return true;
  return (
    metadata.surface === 'budgeted_live_council' &&
    typeof metadata.estimatedCostUsd === 'number' &&
    typeof metadata.actualCostUsd !== 'number'
  );
}

function sumMetricValues(events: AssistantMetricEventRecord[]): number {
  return events.reduce((sum, event) => sum + event.value, 0);
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const rank = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return Math.round(sorted[rank] || 0);
}

const DELIVERY_STAGE_KEYS_V2 = [
  ['request_preprocessing', 'preprocessingMs'],
  ['turn_harness', 'harnessMs'],
  ['response_preparation', 'responsePreparationMs'],
  ['channel_delivery', 'channelDeliveryMs'],
] as const;

const DELIVERY_STAGE_KEYS_V3 = [
  ['queue_wait', 'queueWaitMs'],
  ...DELIVERY_STAGE_KEYS_V2,
] as const;

function deliveryStageKeys(metadata: Record<string, unknown>) {
  return Number(metadata.deliveryInstrumentationVersion) >= 3 ||
    metadata.queueWaitMs !== undefined
    ? DELIVERY_STAGE_KEYS_V3
    : DELIVERY_STAGE_KEYS_V2;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function deliveryAttributionState(
  event: AssistantMetricEventRecord,
): 'complete' | 'legacy' | 'invalid' {
  const metadata = metricMetadata(event);
  const stageKeys = deliveryStageKeys(metadata);
  const stageValues = stageKeys.map(([, key]) => metadata[key]);
  const presentStageCount = stageValues.filter(
    (value) => value !== undefined,
  ).length;
  if (presentStageCount === 0) return 'legacy';
  if (
    presentStageCount !== stageKeys.length ||
    !stageValues.every(isFiniteNonNegativeNumber) ||
    !isFiniteNonNegativeNumber(event.value)
  ) {
    return 'invalid';
  }
  const attributedTotal = (stageValues as number[]).reduce(
    (sum, value) => sum + value,
    0,
  );
  return Math.abs(attributedTotal - event.value) <= 1 ? 'complete' : 'invalid';
}

function slowestDeliveryStage(
  events: AssistantMetricEventRecord[],
): string | null {
  const totals = new Map<string, { total: number; samples: number }>();
  for (const event of events) {
    const metadata = metricMetadata(event);
    for (const [stage, key] of deliveryStageKeys(metadata)) {
      const value = metadata[key];
      if (!isFiniteNonNegativeNumber(value)) continue;
      const current = totals.get(stage) || { total: 0, samples: 0 };
      current.total += value;
      current.samples += 1;
      totals.set(stage, current);
    }
  }
  return (
    [...totals.entries()].sort(
      (a, b) => b[1].total / b[1].samples - a[1].total / a[1].samples,
    )[0]?.[0] || null
  );
}

function buildLatencyRouteBreakdown(events: AssistantMetricEventRecord[]) {
  const byRoute = new Map<string, AssistantMetricEventRecord[]>();
  for (const event of events) {
    const metadata = metricMetadata(event);
    const routeKey =
      typeof metadata.routeKey === 'string' && metadata.routeKey.trim()
        ? metadata.routeKey.trim().slice(0, 120)
        : 'unknown';
    const routeEvents = byRoute.get(routeKey) || [];
    routeEvents.push(event);
    byRoute.set(routeKey, routeEvents);
  }
  return [...byRoute.entries()]
    .map(([routeKey, routeEvents]) => {
      const values = routeEvents.map((event) => event.value);
      const localOnly = routeEvents.every(
        (event) => metricMetadata(event).latencyTargetClass === 'local_command',
      );
      const targetMs = localOnly ? 2_000 : 10_000;
      const p95Ms = percentile(values, 0.95);
      return {
        routeKey,
        sampleCount: routeEvents.length,
        averageMs: Math.round(
          values.reduce((sum, value) => sum + value, 0) / values.length,
        ),
        p50Ms: percentile(values, 0.5),
        p95Ms,
        slowestStage: slowestDeliveryStage(routeEvents),
        targetMs,
        meetsTarget: p95Ms <= targetMs,
      };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms || a.routeKey.localeCompare(b.routeKey));
}

function buildLatencyProviderBreakdown(events: AssistantMetricEventRecord[]) {
  const grouped = new Map<string, AssistantMetricEventRecord[]>();
  for (const event of events) {
    const metadata = metricMetadata(event);
    const hasRoutingProvider =
      typeof metadata.routingProviderId === 'string' &&
      metadata.routingProviderId.trim().length > 0;
    const providerId = hasRoutingProvider
      ? String(metadata.routingProviderId).trim().slice(0, 120)
      : typeof metadata.providerId === 'string' && metadata.providerId.trim()
        ? metadata.providerId.trim().slice(0, 120)
        : 'unknown';
    const modelValue = hasRoutingProvider
      ? metadata.routingModelId
      : metadata.modelId;
    const modelId =
      typeof modelValue === 'string' && modelValue.trim()
        ? modelValue.trim().slice(0, 160)
        : null;
    const providerRole = hasRoutingProvider ? 'routing' : 'response';
    const key = JSON.stringify([providerId, modelId, providerRole]);
    const providerEvents = grouped.get(key) || [];
    providerEvents.push(event);
    grouped.set(key, providerEvents);
  }
  return [...grouped.entries()]
    .map(([key, providerEvents]) => {
      const [providerId, modelId, providerRole] = JSON.parse(key) as [
        string,
        string | null,
        'response' | 'routing',
      ];
      const values = providerEvents.map((event) => event.value);
      return {
        providerId,
        modelId,
        providerRole,
        sampleCount: providerEvents.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        slowestStage: slowestDeliveryStage(providerEvents),
      };
    })
    .sort(
      (left, right) =>
        right.p95Ms - left.p95Ms ||
        left.providerId.localeCompare(right.providerId),
    );
}

function buildLatencyToolBreakdown(events: AssistantMetricEventRecord[]) {
  const grouped = new Map<string, AssistantMetricEventRecord[]>();
  for (const event of events) {
    const metadata = metricMetadata(event);
    const rawToolClass =
      typeof metadata.toolClass === 'string'
        ? metadata.toolClass
        : typeof metadata.capabilityId === 'string'
          ? metadata.capabilityId
          : typeof metadata.handlerKind === 'string'
            ? metadata.handlerKind
            : 'unknown';
    const toolClass = rawToolClass.trim().slice(0, 120) || 'unknown';
    const toolEvents = grouped.get(toolClass) || [];
    toolEvents.push(event);
    grouped.set(toolClass, toolEvents);
  }
  return [...grouped.entries()]
    .map(([toolClass, toolEvents]) => {
      const values = toolEvents.map((event) => event.value);
      return {
        toolClass,
        sampleCount: toolEvents.length,
        p50Ms: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        slowestStage: slowestDeliveryStage(toolEvents),
      };
    })
    .sort(
      (left, right) =>
        right.p95Ms - left.p95Ms ||
        left.toolClass.localeCompare(right.toolClass),
    );
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
  const allDeliveryLatency = events.filter((event) => {
    if (event.kind !== 'latency_sample') return false;
    const metadata = metricMetadata(event);
    return (
      metadata.latencyClass === 'interaction_delivery' &&
      metadata.runOrigin !== 'replay' &&
      metadata.runOrigin !== 'synthetic'
    );
  });
  const degradedDeliveryEvents = events.filter((event) => {
    if (event.kind !== 'latency_sample') return false;
    const metadata = metricMetadata(event);
    return (
      metadata.latencyClass === 'interaction_delivery_degraded' &&
      metadata.runOrigin !== 'replay' &&
      metadata.runOrigin !== 'synthetic'
    );
  });
  const partialInteractionDeliveryCount = degradedDeliveryEvents.filter(
    (event) => metricMetadata(event).deliveryOutcome === 'partial',
  ).length;
  const unknownInteractionDeliveryCount = degradedDeliveryEvents.filter(
    (event) => metricMetadata(event).deliveryOutcome === 'unknown',
  ).length;
  const latestDegradedDelivery = degradedDeliveryEvents
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const latestDegradedMetadata = latestDegradedDelivery
    ? metricMetadata(latestDegradedDelivery)
    : {};
  const latestDegradedDeliveryOutcome = ['partial', 'unknown'].includes(
    String(latestDegradedMetadata.deliveryOutcome),
  )
    ? (String(latestDegradedMetadata.deliveryOutcome) as 'partial' | 'unknown')
    : null;
  const attributedDeliveryLatency = allDeliveryLatency.filter(
    (event) => deliveryAttributionState(event) === 'complete',
  );
  const legacyDeliveryLatency = allDeliveryLatency.filter(
    (event) => deliveryAttributionState(event) === 'legacy',
  );
  const invalidDeliveryLatency = allDeliveryLatency.filter(
    (event) => deliveryAttributionState(event) === 'invalid',
  );
  const hostPressureSamples = attributedDeliveryLatency.filter((event) => {
    const pressureClass = metricMetadata(event).hostPressureClass;
    return ['normal', 'elevated', 'high', 'unknown'].includes(
      String(pressureClass),
    );
  });
  const highHostPressureSampleCount = hostPressureSamples.filter(
    (event) => metricMetadata(event).hostPressureClass === 'high',
  ).length;
  const latestHostPressureClass = hostPressureSamples
    .slice()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((event) => String(metricMetadata(event).hostPressureClass))
    .find((value) =>
      ['normal', 'elevated', 'high', 'unknown'].includes(value),
    ) as 'normal' | 'elevated' | 'high' | 'unknown' | undefined;
  const latency =
    attributedDeliveryLatency.length > 0
      ? attributedDeliveryLatency
      : legacyDeliveryLatency;
  const latencyValues = latency.map((event) => event.value);
  const interactionLatencyByRoute = buildLatencyRouteBreakdown(latency);
  const interactionLatencyByProvider = buildLatencyProviderBreakdown(latency);
  const interactionLatencyByTool = buildLatencyToolBreakdown(latency);
  const worstBreachingLatencyRoute = interactionLatencyByRoute
    .filter((route) => !route.meetsTarget)
    .sort(
      (a, b) =>
        b.p95Ms / b.targetMs - a.p95Ms / a.targetMs || b.p95Ms - a.p95Ms,
    )[0]?.routeKey;
  const legacyCouncilCostReservations = events.filter(
    isLegacyCouncilCostReservation,
  );
  const recordedLiveEvalCostEstimateEvents = events.filter(
    (event) =>
      event.kind === 'live_eval_cost' && !isLegacyCouncilCostReservation(event),
  );
  const explicitLiveEvalCostReservations = events.filter(
    (event) => event.kind === 'live_eval_cost_reservation',
  );
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
    p50LatencyMs: percentile(latencyValues, 0.5),
    p95LatencyMs: percentile(latencyValues, 0.95),
    slowestLatencyStage: slowestDeliveryStage(latency),
    slowestLatencyRoute: interactionLatencyByRoute[0]?.routeKey || null,
    slowestLatencyProvider: interactionLatencyByProvider[0]?.providerId || null,
    slowestLatencyTool: interactionLatencyByTool[0]?.toolClass || null,
    worstBreachingLatencyRoute: worstBreachingLatencyRoute || null,
    interactionLatencyTargetBreaches: interactionLatencyByRoute.filter(
      (route) => !route.meetsTarget,
    ).length,
    legacyInteractionLatencySampleCount: legacyDeliveryLatency.length,
    invalidInteractionLatencySampleCount: invalidDeliveryLatency.length,
    hostPressureSampleCount: hostPressureSamples.length,
    highHostPressureSampleCount,
    latestHostPressureClass: latestHostPressureClass || null,
    degradedInteractionDeliveryCount: degradedDeliveryEvents.length,
    partialInteractionDeliveryCount,
    unknownInteractionDeliveryCount,
    latestDegradedDeliveryOutcome,
    latestDegradedDeliveryRoute:
      typeof latestDegradedMetadata.routeKey === 'string'
        ? latestDegradedMetadata.routeKey
        : null,
    interactionLatencyByRoute,
    interactionLatencyByProvider,
    interactionLatencyByTool,
    interactionLatencySampleCount: latency.length,
    liveEvalRecordedCostEstimateUsd: Number(
      sumMetricValues(recordedLiveEvalCostEstimateEvents).toFixed(4),
    ),
    liveEvalCostReservationUsd: Number(
      sumMetricValues([
        ...explicitLiveEvalCostReservations,
        ...legacyCouncilCostReservations,
      ]).toFixed(4),
    ),
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
