import {
  listDelegationRulesForGroup,
  listRecentResponseFeedback,
  listRedactedRegressionFixtures,
} from './db.js';
import {
  buildAssistantMetricSnapshot,
  compareAssistantMetricsToBaseline,
} from './personal-assistant-metrics.js';
import { assessRoutinePromotion } from './routine-promotion.js';

export interface AssistantIntelligenceReport {
  generatedAt: string;
  groupFolder: string;
  metrics: ReturnType<typeof buildAssistantMetricSnapshot>;
  regressions: string[];
  routines: {
    total: number;
    promoted: number;
    pendingCanary: number;
    paused: number;
    assessments: ReturnType<typeof assessRoutinePromotion>[];
  };
  feedbackFixtures: {
    open: number;
    fixed: number;
    verified: number;
  };
  postDeliveryReflection: {
    pending: number;
    completed: number;
    failed: number;
  };
  topNextImprovement: string;
  privacy: {
    metadataOnly: true;
    rawConversationTextIncluded: false;
  };
}

export function buildAssistantIntelligenceReport(params: {
  groupFolder: string;
  now?: Date;
}): AssistantIntelligenceReport {
  const now = params.now || new Date();
  const metrics = buildAssistantMetricSnapshot({
    groupFolder: params.groupFolder,
    now,
  });
  const comparison = compareAssistantMetricsToBaseline(metrics);
  const rules = listDelegationRulesForGroup({
    groupFolder: params.groupFolder,
    limit: 200,
  });
  const assessments = rules.map((rule) =>
    assessRoutinePromotion(rule.ruleId, now),
  );
  const fixtures = listRedactedRegressionFixtures({ limit: 1000 });
  const reflectionFeedback = listRecentResponseFeedback({
    limit: 1_000,
  }).filter((record) => record.groupFolder === params.groupFolder);
  const promoted = assessments.filter(
    (assessment) => assessment.eligible,
  ).length;
  const pendingCanary = assessments.filter(
    (assessment) =>
      assessment.deterministicFixturePassed &&
      !assessment.approvedCanaryCompleted,
  ).length;
  const paused = rules.filter((rule) => rule.status === 'paused').length;
  const topNextImprovement = comparison.regressions[0]
    ? `Resolve metric regression: ${comparison.regressions[0]}`
    : fixtures.some((fixture) => fixture.remediationStatus === 'open')
      ? 'Verify or remediate the oldest open redacted regression fixture.'
      : metrics.interactionLatencyTargetBreaches > 0
        ? `Repair the worst target-breaching delivery route (${metrics.worstBreachingLatencyRoute || 'unknown'}) before adding capabilities; inspect ${metrics.slowestLatencyStage || 'the unattributed stage'} across current samples.`
        : pendingCanary > 0
          ? 'Run one explicitly approved reversible canary for a fixture-passing routine.'
          : metrics.reviewedOutcomeCount < 5
            ? `Record ${5 - metrics.reviewedOutcomeCount} more owner-reviewed recommendation outcome${5 - metrics.reviewedOutcomeCount === 1 ? '' : 's'} before saving a baseline. Use Helpful/Not helpful, a Messages tapback, or a fresh standalone “that worked”/“that didn't work” reply.`
            : 'Keep verified completion and citation coverage non-regressing.';
  return {
    generatedAt: now.toISOString(),
    groupFolder: params.groupFolder,
    metrics,
    regressions: comparison.regressions,
    routines: {
      total: rules.length,
      promoted,
      pendingCanary,
      paused,
      assessments,
    },
    feedbackFixtures: {
      open: fixtures.filter((fixture) => fixture.remediationStatus === 'open')
        .length,
      fixed: fixtures.filter((fixture) => fixture.remediationStatus === 'fixed')
        .length,
      verified: fixtures.filter(
        (fixture) => fixture.remediationStatus === 'verified',
      ).length,
    },
    postDeliveryReflection: {
      pending: reflectionFeedback.filter(
        (record) => record.linkedRefs.postDeliveryReflectionState === 'pending',
      ).length,
      completed: reflectionFeedback.filter(
        (record) =>
          record.linkedRefs.postDeliveryReflectionState === 'completed',
      ).length,
      failed: reflectionFeedback.filter(
        (record) => record.linkedRefs.postDeliveryReflectionState === 'failed',
      ).length,
    },
    topNextImprovement,
    privacy: {
      metadataOnly: true,
      rawConversationTextIncluded: false,
    },
  };
}

export function formatAssistantIntelligenceReport(
  report: AssistantIntelligenceReport,
): string {
  return [
    'Andrea Assistant Intelligence',
    `Metrics samples: ${report.metrics.sampleCount}`,
    `Owner-reviewed outcomes: ${report.metrics.reviewedOutcomeCount}/5 required for baseline`,
    `Accepted recommendations: ${(report.metrics.acceptedRecommendationRate * 100).toFixed(1)}%`,
    `Verified completion: ${(report.metrics.verifiedCompletionRate * 100).toFixed(1)}%`,
    `Memory precision: ${report.metrics.memoryPrecisionSampleCount > 0 ? `${(report.metrics.memoryPrecision * 100).toFixed(1)}% across ${report.metrics.memoryPrecisionSampleCount} reviewed judgment${report.metrics.memoryPrecisionSampleCount === 1 ? '' : 's'}` : 'no explicit correctness judgments yet'}`,
    `Memory citation coverage: ${report.metrics.retrievalCitationSampleCount > 0 ? `${(report.metrics.retrievalCitationCoverage * 100).toFixed(1)}% across ${report.metrics.retrievalCitationSampleCount} citation-eligible retrieval${report.metrics.retrievalCitationSampleCount === 1 ? '' : 's'}` : 'no citation-eligible assistant retrievals yet'}`,
    `Tool reliability: ${report.metrics.toolReliabilitySampleCount > 0 ? `${(report.metrics.toolReliability * 100).toFixed(1)}% across ${report.metrics.toolReliabilitySampleCount} comparable attempt${report.metrics.toolReliabilitySampleCount === 1 ? '' : 's'}` : 'no comparable assistant-interaction samples yet'}`,
    `Interaction delivery latency: ${report.metrics.interactionLatencySampleCount > 0 ? `avg ${report.metrics.averageLatencyMs} ms · p50 ${report.metrics.p50LatencyMs} ms · p95 ${report.metrics.p95LatencyMs} ms across ${report.metrics.interactionLatencySampleCount} comparable sample${report.metrics.interactionLatencySampleCount === 1 ? '' : 's'}` : 'no comparable post-delivery-boundary samples yet'}`,
    `Slowest delivery stage: ${report.metrics.slowestLatencyStage || 'not yet attributed'}${report.metrics.slowestLatencyStage && report.metrics.slowestLatencyRoute ? ` on ${report.metrics.slowestLatencyRoute}` : ''}`,
    `Legacy delivery samples: ${report.metrics.legacyInteractionLatencySampleCount} retained for audit${report.metrics.interactionLatencySampleCount > 0 && report.metrics.slowestLatencyStage ? '; excluded from current attributed percentiles' : ''}; malformed stage samples excluded: ${report.metrics.invalidInteractionLatencySampleCount}`,
    `Host pressure at dequeue: ${report.metrics.hostPressureSampleCount > 0 ? `${report.metrics.latestHostPressureClass || 'unknown'} latest · ${report.metrics.highHostPressureSampleCount}/${report.metrics.hostPressureSampleCount} high-pressure sample${report.metrics.hostPressureSampleCount === 1 ? '' : 's'}` : 'not yet attributed'}`,
    `Degraded delivery outcomes: ${report.metrics.degradedInteractionDeliveryCount} total · ${report.metrics.partialInteractionDeliveryCount} partial · ${report.metrics.unknownInteractionDeliveryCount} unknown${report.metrics.latestDegradedDeliveryOutcome ? `; latest ${report.metrics.latestDegradedDeliveryOutcome} on ${report.metrics.latestDegradedDeliveryRoute || 'unknown route'}` : ''}`,
    `Latency routes: ${report.metrics.interactionLatencyByRoute.length ? report.metrics.interactionLatencyByRoute.map((route) => `${route.routeKey} p95=${route.p95Ms}ms target<=${route.targetMs}ms ${route.meetsTarget ? 'pass' : 'slow'} stage=${route.slowestStage || 'unknown'}`).join('; ') : 'none'}`,
    `Latency providers: ${report.metrics.interactionLatencyByProvider.length ? report.metrics.interactionLatencyByProvider.map((provider) => `${provider.providerId}${provider.modelId ? `/${provider.modelId}` : ''} role=${provider.providerRole} p95=${provider.p95Ms}ms stage=${provider.slowestStage || 'unknown'}`).join('; ') : 'none'}`,
    `Latency tools/capabilities: ${report.metrics.interactionLatencyByTool.length ? report.metrics.interactionLatencyByTool.map((tool) => `${tool.toolClass} p95=${tool.p95Ms}ms stage=${tool.slowestStage || 'unknown'}`).join('; ') : 'none'}`,
    `Live evaluation cost evidence: $${report.metrics.liveEvalRecordedCostEstimateUsd.toFixed(4)} recorded estimates; $${report.metrics.liveEvalCostReservationUsd.toFixed(4)} fixed estimated-cost reservation; provider billing is not available here`,
    `Routines: ${report.routines.promoted}/${report.routines.total} promoted; ${report.routines.pendingCanary} pending canary; ${report.routines.paused} paused`,
    `Feedback fixtures: ${report.feedbackFixtures.open} open; ${report.feedbackFixtures.fixed} fixed; ${report.feedbackFixtures.verified} verified`,
    `Post-delivery reflection: ${report.postDeliveryReflection.pending} pending; ${report.postDeliveryReflection.completed} completed; ${report.postDeliveryReflection.failed} failed`,
    `Regressions: ${report.regressions.length ? report.regressions.join('; ') : 'none'}`,
    `Next: ${report.topNextImprovement}`,
    'Privacy: metadata-only; no raw conversation text.',
  ].join('\n');
}
