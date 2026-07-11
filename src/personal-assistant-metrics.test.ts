import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from './db.js';
import {
  buildAssistantMetricSnapshot,
  compareAssistantMetricsToBaseline,
  createRegressionFixtureFromFeedback,
  recordAssistantMetric,
  saveReviewedAssistantMetricBaseline,
  saveAssistantMetricBaseline,
} from './personal-assistant-metrics.js';
import type { ResponseFeedbackRecord } from './types.js';
import { buildAssistantIntelligenceReport } from './assistant-intelligence-report.js';

describe('personal assistant metrics', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('establishes an outcome-led baseline and detects regressions', () => {
    for (const kind of [
      'recommendation_accepted',
      'completion_verified',
      'memory_retrieval',
      'memory_retrieval_correct',
      'retrieval_with_citation',
      'tool_attempt',
      'tool_success',
    ] as const) {
      recordAssistantMetric({ groupFolder: 'main', kind });
    }
    recordAssistantMetric({
      groupFolder: 'main',
      kind: 'latency_sample',
      value: 120,
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
      averageLatencyMs: 120,
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
    expect(() => saveReviewedAssistantMetricBaseline(snapshot)).toThrow(
      'reviewed outcomes; found 0',
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
        metadata: { packetId: 'same-packet' },
      });
    }
    expect(
      buildAssistantMetricSnapshot({ groupFolder: 'main' })
        .reviewedOutcomeCount,
    ).toBe(1);
  });
});
