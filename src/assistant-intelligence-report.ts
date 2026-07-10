import {
  listDelegationRulesForGroup,
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
      : pendingCanary > 0
        ? 'Run one explicitly approved reversible canary for a fixture-passing routine.'
        : metrics.sampleCount === 0
          ? 'Use one daily recommendation and record its verified outcome to establish a baseline.'
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
    `Accepted recommendations: ${(report.metrics.acceptedRecommendationRate * 100).toFixed(1)}%`,
    `Verified completion: ${(report.metrics.verifiedCompletionRate * 100).toFixed(1)}%`,
    `Memory citation coverage: ${(report.metrics.retrievalCitationCoverage * 100).toFixed(1)}%`,
    `Tool reliability: ${(report.metrics.toolReliability * 100).toFixed(1)}%`,
    `Routines: ${report.routines.promoted}/${report.routines.total} promoted; ${report.routines.pendingCanary} pending canary; ${report.routines.paused} paused`,
    `Feedback fixtures: ${report.feedbackFixtures.open} open; ${report.feedbackFixtures.fixed} fixed; ${report.feedbackFixtures.verified} verified`,
    `Regressions: ${report.regressions.length ? report.regressions.join('; ') : 'none'}`,
    `Next: ${report.topNextImprovement}`,
    'Privacy: metadata-only; no raw conversation text.',
  ].join('\n');
}
