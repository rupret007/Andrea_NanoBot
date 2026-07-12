import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  buildAssistantMetricSnapshot,
  buildReviewedOutcomeProgress,
  compareAssistantMetricsToBaseline,
  createRegressionFixtureFromFeedback,
  formatReviewedOutcomeProgress,
  recordAssistantMetric,
  recordMemoryRetrievalJudgment,
  recordReviewedRecommendationOutcome,
  saveReviewedAssistantMetricBaseline,
  saveAssistantMetricBaseline,
} from './personal-assistant-metrics.js';
import type { ResponseFeedbackRecord } from './types.js';
import {
  buildAssistantIntelligenceReport,
  formatAssistantIntelligenceReport,
} from './assistant-intelligence-report.js';

describe('personal assistant metrics', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('establishes an outcome-led baseline and detects regressions', () => {
    for (const kind of [
      'recommendation_accepted',
      'completion_verified',
      'memory_retrieval',
      'memory_retrieval_reviewed',
      'retrieval_with_citation',
      'tool_attempt',
      'tool_success',
    ] as const) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind,
        metadata: ['recommendation_accepted', 'completion_verified'].includes(
          kind,
        )
          ? { metricClass: 'owner_review' }
          : {
              metricClass: 'assistant_interaction',
              ...(kind === 'memory_retrieval'
                ? { packetId: 'packet-baseline', resultCount: 1 }
                : {}),
            },
      });
    }
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 120,
      metadata: { latencyClass: 'interaction_delivery', runOrigin: 'live' },
    });
    const baseline = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    saveAssistantMetricBaseline(baseline);

    const current = {
      ...baseline,
      snapshotId: 'current',
      toolReliability: 0.5,
      memoryPrecision: 0.5,
    };
    expect(compareAssistantMetricsToBaseline(current).regressions).toEqual(
      expect.arrayContaining([
        expect.stringContaining('toolReliability'),
        expect.stringContaining('memoryPrecision'),
      ]),
    );
    expect(baseline).toMatchObject({
      acceptedRecommendationRate: 1,
      verifiedCompletionRate: 1,
      retrievalCitationCoverage: 1,
      retrievalCitationSampleCount: 1,
      memoryPrecision: 1,
      memoryPrecisionSampleCount: 1,
      memoryRetrievalSampleCount: 1,
      toolReliability: 1,
      toolReliabilitySampleCount: 1,
      averageLatencyMs: 120,
      interactionLatencySampleCount: 1,
    });
  });

  it('fails closed when evaluation or legacy telemetry lacks real-assistant provenance', () => {
    for (const kind of ['tool_attempt', 'tool_success'] as const) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind,
        metadata: { metricClass: 'live_evaluation' },
      });
    }
    for (const kind of [
      'memory_retrieval',
      'retrieval_with_citation',
    ] as const) {
      recordAssistantMetric({ groupFolder: 'main', kind });
    }

    const unproven = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(unproven).toMatchObject({
      memoryPrecision: 0,
      retrievalCitationCoverage: 0,
      memoryRetrievalSampleCount: 0,
      toolReliability: 0,
      toolReliabilitySampleCount: 0,
      sampleCount: 4,
    });
    expect(
      formatAssistantIntelligenceReport(
        buildAssistantIntelligenceReport({ groupFolder: 'main' }),
      ),
    ).toContain('Tool reliability: no comparable assistant-interaction');

    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'memory_retrieval',
      metadata: {
        metricClass: 'assistant_interaction',
        packetId: 'packet-real',
        resultCount: 1,
      },
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'retrieval_with_citation',
      metadata: { metricClass: 'assistant_interaction' },
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'tool_attempt',
      metadata: { metricClass: 'assistant_interaction' },
    });

    expect(buildAssistantMetricSnapshot({ groupFolder: 'main' })).toMatchObject(
      {
        retrievalCitationCoverage: 1,
        retrievalCitationSampleCount: 1,
        memoryPrecisionSampleCount: 0,
        memoryRetrievalSampleCount: 1,
        toolReliability: 0,
        toolReliabilitySampleCount: 1,
      },
    );
  });

  it('does not call absent comparable evidence a baseline regression', () => {
    for (const kind of [
      'recommendation_accepted',
      'memory_retrieval',
      'memory_retrieval_reviewed',
      'retrieval_with_citation',
      'tool_attempt',
      'tool_success',
    ] as const) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind,
        metadata: {
          metricClass:
            kind === 'recommendation_accepted'
              ? 'owner_review'
              : 'assistant_interaction',
          ...(kind === 'memory_retrieval'
            ? { packetId: 'packet-baseline', resultCount: 1 }
            : {}),
        },
      });
    }
    const baseline = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    saveAssistantMetricBaseline(baseline);

    expect(
      compareAssistantMetricsToBaseline({
        ...baseline,
        snapshotId: 'no-comparable-evidence',
        reviewedOutcomeCount: 0,
        memoryPrecision: 0,
        memoryPrecisionSampleCount: 0,
        retrievalCitationCoverage: 0,
        retrievalCitationSampleCount: 0,
        memoryRetrievalSampleCount: 0,
        toolReliability: 0,
        toolReliabilitySampleCount: 0,
      }).regressions,
    ).toEqual([]);
  });

  it('measures memory precision only from explicit packet-linked judgments', () => {
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'memory_retrieval',
      metadata: {
        metricClass: 'assistant_interaction',
        packetId: 'packet-judged',
        resultCount: 2,
      },
    });
    let snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot).toMatchObject({
      memoryRetrievalSampleCount: 1,
      memoryPrecision: 0,
      memoryPrecisionSampleCount: 0,
    });
    expect(
      formatAssistantIntelligenceReport(
        buildAssistantIntelligenceReport({ groupFolder: 'main' }),
      ),
    ).toContain('Memory precision: no explicit correctness judgments yet');

    expect(
      recordMemoryRetrievalJudgment({
        groupFolder: 'main',
        packetId: 'missing-packet',
        correct: true,
        reviewSource: 'operator',
      }),
    ).toBeUndefined();
    recordMemoryRetrievalJudgment({
      groupFolder: 'main',
      packetId: 'packet-judged',
      correct: false,
      reviewSource: 'natural_language',
    });
    snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot).toMatchObject({
      memoryPrecision: 0,
      memoryPrecisionSampleCount: 1,
    });

    recordMemoryRetrievalJudgment({
      groupFolder: 'main',
      packetId: 'packet-judged',
      correct: true,
      reviewSource: 'natural_language',
    });
    snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot).toMatchObject({
      memoryPrecision: 1,
      memoryPrecisionSampleCount: 1,
      sampleCount: 2,
    });
  });

  it('turns feedback into a traceable fixture without raw conversation text', () => {
    const fixture = createRegressionFixtureFromFeedback({
      feedbackId: 'feedback-1',
      classification: 'unsafe_claim',
      routeKey: 'assistant.daily',
      capabilityId: 'daily.guidance',
      blockerClass: 'provider_quota',
      originalUserText: 'private raw user message',
      assistantReplyText: 'private raw assistant reply',
    } as unknown as ResponseFeedbackRecord);

    expect(fixture).toMatchObject({
      sourceFeedbackId: 'feedback-1',
      remediationStatus: 'open',
      containsRawUserText: false,
    });
    expect(JSON.stringify(fixture)).not.toContain('private raw');
    const report = buildAssistantIntelligenceReport({ groupFolder: 'main' });
    expect(report.feedbackFixtures.open).toBe(1);
    expect(report.privacy).toEqual({
      metadataOnly: true,
      rawConversationTextIncluded: false,
    });
  });

  it('uses route coverage and fixed status for locally resolved feedback', () => {
    const fixture = createRegressionFixtureFromFeedback({
      feedbackId: 'feedback-model-inventory',
      status: 'resolved_locally',
      classification: 'repo_side_rough_edge',
      routeKey: 'direct_assistant',
      capabilityId: null,
      blockerClass: null,
      originalUserText: 'What LLMs do you have?',
      assistantReplyText: 'private old reply',
    } as unknown as ResponseFeedbackRecord);

    expect(fixture).toMatchObject({
      sourceFeedbackId: 'feedback-model-inventory',
      remediationStatus: 'fixed',
      containsRawUserText: false,
    });
    expect(fixture.expectedBehavior).toContain(
      'deterministic runtime inventory',
    );
    expect(JSON.stringify(fixture)).not.toContain('private old reply');
  });

  it('refuses to save an empty or premature reviewed baseline', () => {
    const snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(() => saveReviewedAssistantMetricBaseline(snapshot)).toThrow(
      'requires at least 5 reviewed outcomes',
    );
  });

  it('does not mistake live evaluation telemetry for reviewed outcomes', () => {
    for (let index = 0; index < 8; index += 1) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind: 'latency_sample',
        value: 100 + index,
      });
    }
    const snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot.sampleCount).toBe(8);
    expect(snapshot.reviewedOutcomeCount).toBe(0);
    expect(snapshot.averageLatencyMs).toBe(0);
    expect(snapshot.interactionLatencySampleCount).toBe(0);
    expect(() => saveReviewedAssistantMetricBaseline(snapshot)).toThrow(
      'reviewed outcomes; found 0',
    );
    expect(buildReviewedOutcomeProgress({ groupFolder: 'main' })).toMatchObject(
      {
        reviewedOutcomeCount: 0,
        remainingOutcomeCount: 5,
        baselineReady: false,
        baselineSaved: false,
      },
    );
  });

  it('requires explicit owner-review provenance and counts one bundle decision once', () => {
    for (let index = 0; index < 5; index += 1) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind: 'recommendation_accepted',
        metadata: {
          metricClass: index % 2 === 0 ? 'live_evaluation' : 'unclassified',
        },
      });
    }
    expect(buildAssistantMetricSnapshot({ groupFolder: 'main' })).toMatchObject(
      {
        reviewedOutcomeCount: 0,
        acceptedRecommendationRate: 0,
      },
    );

    for (let index = 0; index < 3; index += 1) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind: 'recommendation_accepted',
        metadata: {
          metricClass: 'owner_review',
          bundleId: 'bundle-1',
          actionId: `action-${index}`,
        },
      });
    }
    const snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot).toMatchObject({
      reviewedOutcomeCount: 1,
      acceptedRecommendationRate: 1,
      sampleCount: 8,
    });
    expect(() => saveReviewedAssistantMetricBaseline(snapshot)).toThrow(
      'reviewed outcomes; found 1',
    );
  });

  it('keeps replay and non-interaction timing out of live delivery latency', () => {
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 40_000,
      metadata: {
        latencyClass: 'interaction_delivery',
        runOrigin: 'replay',
      },
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 9_000,
      metadata: { latencyClass: 'live_evaluation' },
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 800,
      metadata: {
        latencyClass: 'interaction_delivery',
        runOrigin: 'live',
      },
    });

    expect(buildAssistantMetricSnapshot({ groupFolder: 'main' })).toMatchObject(
      {
        averageLatencyMs: 800,
        interactionLatencySampleCount: 1,
      },
    );
    expect(
      formatAssistantIntelligenceReport(
        buildAssistantIntelligenceReport({ groupFolder: 'main' }),
      ),
    ).toContain(
      'Interaction delivery latency: 800 ms across 1 comparable sample',
    );
  });

  it('shows truthful baseline progress and never saves a ready baseline automatically', () => {
    expect(
      formatReviewedOutcomeProgress(
        buildReviewedOutcomeProgress({ groupFolder: 'main' }),
      ),
    ).toContain('0/5 genuine owner-reviewed outcomes; 5 more needed');

    for (let index = 0; index < 5; index += 1) {
      recordReviewedRecommendationOutcome({
        feedbackId: `feedback-${index}`,
        groupFolder: 'main',
        verdict: index === 4 ? 'rejected' : 'accepted',
      });
    }
    const ready = buildReviewedOutcomeProgress({ groupFolder: 'main' });
    expect(ready).toMatchObject({
      reviewedOutcomeCount: 5,
      remainingOutcomeCount: 0,
      baselineReady: true,
      baselineSaved: false,
    });
    expect(formatReviewedOutcomeProgress(ready)).toContain(
      'ready for operator review, but I will not save it automatically',
    );

    saveReviewedAssistantMetricBaseline(
      buildAssistantMetricSnapshot({ groupFolder: 'main' }),
    );
    const saved = buildReviewedOutcomeProgress({ groupFolder: 'main' });
    expect(saved.baselineSaved).toBe(true);
    expect(formatReviewedOutcomeProgress(saved)).toContain(
      'operator-reviewed baseline is already saved',
    );
  });

  it('counts repeated review telemetry for one packet as one baseline outcome', () => {
    for (let index = 0; index < 6; index += 1) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind:
          index % 2 === 0
            ? 'recommendation_accepted'
            : 'recommendation_rejected',
        metadata: {
          metricClass: 'owner_review',
          packetId: 'same-packet',
        },
      });
    }
    expect(
      buildAssistantMetricSnapshot({ groupFolder: 'main' })
        .reviewedOutcomeCount,
    ).toBe(1);
  });

  it('counts linked response feedback and the mission verdict as one canonical outcome', () => {
    recordReviewedRecommendationOutcome({
      feedbackId: 'feedback-linked',
      groupFolder: 'main',
      verdict: 'accepted',
      metadata: { packetId: 'packet-linked' },
      now: new Date('2026-05-02T04:12:00.000Z'),
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'recommendation_rejected',
      metadata: {
        metricClass: 'owner_review',
        packetId: 'packet-linked',
        verdict: 'rejected',
      },
      now: new Date('2026-05-02T04:13:00.000Z'),
    });
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'override',
      metadata: {
        metricClass: 'owner_review',
        packetId: 'packet-linked',
      },
      now: new Date('2026-05-02T04:13:00.000Z'),
    });

    expect(
      buildAssistantMetricSnapshot({
        groupFolder: 'main',
        now: new Date('2026-05-02T04:14:00.000Z'),
      }),
    ).toMatchObject({
      reviewedOutcomeCount: 1,
      acceptedRecommendationRate: 0,
      correctionOverrideRate: 1,
    });
  });

  it('does not double-weight repeated correction and override signals for one outcome', () => {
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'recommendation_rejected',
      metadata: {
        metricClass: 'owner_review',
        packetId: 'packet-corrected',
      },
    });
    for (const kind of ['correction', 'override', 'correction'] as const) {
      recordAssistantMetric({
        groupFolder: 'main',
        kind,
        metadata: {
          metricClass: 'owner_review',
          packetId: 'packet-corrected',
        },
      });
    }

    expect(buildAssistantMetricSnapshot({ groupFolder: 'main' })).toMatchObject(
      {
        reviewedOutcomeCount: 1,
        correctionOverrideRate: 1,
      },
    );
  });

  it('upserts a stable review event instead of counting repeated button delivery twice', () => {
    for (let index = 0; index < 2; index += 1) {
      recordAssistantMetric({
        eventId: 'feedback:feedback-1:review',
        groupFolder: 'main',
        kind: 'recommendation_accepted',
        metadata: {
          metricClass: 'owner_review',
          outcomeId: 'feedback-1',
        },
      });
    }
    const snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot.sampleCount).toBe(1);
    expect(snapshot.reviewedOutcomeCount).toBe(1);
    expect(snapshot.acceptedRecommendationRate).toBe(1);
  });

  it('records explicit worked feedback as one reviewed outcome plus verified completion', () => {
    recordReviewedRecommendationOutcome({
      feedbackId: 'feedback-worked',
      groupFolder: 'main',
      verdict: 'accepted',
      completionVerified: true,
      metadata: { routeKey: 'assistant.daily' },
      now: new Date('2026-05-02T04:12:00.000Z'),
    });
    const snapshot = buildAssistantMetricSnapshot({
      groupFolder: 'main',
      now: new Date('2026-05-02T04:13:00.000Z'),
    });
    expect(snapshot).toMatchObject({
      sampleCount: 2,
      reviewedOutcomeCount: 1,
      acceptedRecommendationRate: 1,
      verifiedCompletionRate: 1,
    });
  });

  it('records rejected feedback and correction without inflating reviewed outcomes', () => {
    recordReviewedRecommendationOutcome({
      feedbackId: 'feedback-rejected',
      groupFolder: 'main',
      verdict: 'rejected',
      correction: true,
    });
    const snapshot = buildAssistantMetricSnapshot({ groupFolder: 'main' });
    expect(snapshot).toMatchObject({
      sampleCount: 2,
      reviewedOutcomeCount: 1,
      acceptedRecommendationRate: 0,
      correctionOverrideRate: 1,
    });
  });
});
