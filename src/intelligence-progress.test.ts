import { describe, expect, it } from 'vitest';

import {
  buildIntelligenceProgressReport,
  makeIntelligenceProgressBaseline,
  sanitizeIntelligenceProgressText,
  type IntelligenceProgressBaseline,
  type IntelligenceProgressInput,
} from './intelligence-progress.js';

function input(
  overrides: Partial<IntelligenceProgressInput> = {},
): IntelligenceProgressInput {
  const generatedAt = '2026-06-21T12:00:00.000Z';
  return {
    generatedAt,
    groupFolder: 'main',
    agiReport: {
      runId: 'agi-run',
      generatedAt,
      totalScore: 1,
      failingScenarios: [],
      weakestSubsystem: 'followthrough_learning',
      safetyRisks: [],
      recommendedNextImprovement: 'Approve one follow-through candidate.',
      results: [
        scenario('busy_evening', 1),
        scenario('ambiguous_action', 1),
        scenario('broken_tool', 1),
        scenario('recovery_problem', 1),
        scenario('safety_problem', 1),
        scenario('optional_surface_boundary', 1),
      ],
    },
    dailyAgentReport: {
      generatedAt,
      groupFolder: 'main',
      setupCompletenessScore: 0.92,
      memoryQualityScore: 0.9,
      contextGraphScore: 0.88,
      textReviewScore: 0.82,
      skillSystemScore: 0.83,
      councilHealthScore: 0.78,
      durableAutonomyScore: 0.72,
      overallScore: 0.88,
      profilePack: {} as any,
      installedSkillManifests: 6,
      deepWorkBlueprint: {} as any,
      topNextImprovement: 'Approve one proposed follow-through reminder.',
      contextGraph: {
        generatedAt,
        groupFolder: 'main',
        nodes: [],
        edges: [],
        readinessScore: 0.88,
        topGaps: ['Approve one proposed follow-through reminder.'],
        dailyIntelligenceQuestions: [],
        coverage: {
          activeProfile: true,
          people: 3,
          memoryFacts: 8,
          lifeThreads: 3,
          linkedLifeThreads: 3,
          communicationThreads: 4,
          linkedCommunicationThreads: 4,
          reminders: 1,
          followthroughCandidates: 4,
          listGroups: 3,
        },
        rankedInsights: [
          {
            insightId: 'insight-1',
            kind: 'prepare',
            title: 'Approved follow-through',
            reason: 'A local follow-through item is active.',
            priorityScore: 0.9,
            relatedNodeIds: [],
            nextAction: 'Review it today.',
            riskFlags: [],
          },
        ],
        privacy: {
          metadataOnly: true,
          rawPrivateBodiesStored: false,
          rawIdentifiersReturned: false,
          secretsRedacted: true,
        },
      },
      privacy: {
        metadataOnly: true,
        rawPromptsStored: false,
        rawPrivateBodiesStored: false,
        automaticSendsEnabled: false,
        calendarWritesEnabled: false,
      },
    },
    intelligenceRegressionReport: {
      runId: 'intel-run',
      mode: 'regression',
      status: 'pass',
      totalScore: 1,
      criticalScore: 1,
      scenarioCount: 10,
      criticalFailureCount: 0,
      scenarios: [],
      execution: {
        mode: 'deterministic',
        maxCostUsd: 0,
        estimatedCostUsd: 0,
        latencyMs: 0,
        outcome: 'pass',
      },
    },
    capabilityReport: {
      generatedAt,
      states: [],
      ready: 8,
      blocked: 0,
      needsSetup: 0,
      dailyCore: {
        total: 6,
        ready: 6,
        needsAttention: 0,
      },
      optionalSurfaces: {
        total: 1,
        ready: 0,
        needsAttention: 1,
      },
      operatorSupport: {
        total: 2,
        ready: 2,
        needsAttention: 0,
      },
    },
    proofReport: {
      generatedAt,
      entries: [
        proof('Telegram bot proof', 'live_proven', false),
        proof('Alexa signed IntentRequest proof', 'near_live_only', false),
        proof(
          'BlueBubbles same-thread message-action proof',
          'live_proven',
          false,
        ),
      ],
      liveProvenCount: 2,
      proofDebtCount: 1,
      dailyCoreLiveProvenCount: 2,
      dailyCoreProofDebtCount: 0,
      optionalProofDebtCount: 1,
      repoWorkRequiredCount: 0,
      nextAction: 'Alexa signed IntentRequest proof: manual device proof.',
      privacyJson: '{}',
    },
    cognitionTraceHealth: 1,
    ...overrides,
  };
}

function scenario(
  scenarioId: string,
  score: number,
  safetyRiskFlags: string[] = [],
) {
  return {
    scenarioId,
    scenarioTitle: scenarioId,
    passed: score >= 1 && safetyRiskFlags.length === 0,
    score,
    subsystem: 'test',
    safetyRiskFlags,
    detail: 'synthetic test fixture',
  };
}

function proof(
  proofName: string,
  status: 'live_proven' | 'near_live_only' | 'failed',
  repoWorkRequired: boolean,
) {
  return {
    proofId: `proof-${proofName}`,
    proofName,
    status,
    lastProofAt: status === 'live_proven' ? '2026-06-21T12:00:00.000Z' : 'none',
    nextStep:
      status === 'live_proven' ? 'No action needed.' : 'Manual proof needed.',
    repoWorkRequired,
    blockerOwner: repoWorkRequired
      ? ('repo_side' as const)
      : ('external' as const),
    evidenceIdsJson: '[]',
    detail: 'redacted proof metadata',
    privacyJson: '{}',
  };
}

function baselineFrom(
  patch: Partial<IntelligenceProgressBaseline> = {},
): IntelligenceProgressBaseline {
  return {
    baselineId: 'baseline-1',
    createdAt: '2026-06-20T12:00:00.000Z',
    overallScore: 0.75,
    dimensionScores: {
      daily_usefulness: 0.75,
      memory_quality: 0.75,
      context_graph: 0.75,
      text_reply_intelligence: 0.75,
      followthrough_learning: 0.75,
      tool_truth_proof_honesty: 0.75,
      council_quality: 0.75,
      autonomy_safety: 0.75,
      privacy_redaction: 0.75,
      regression_stability: 0.75,
    },
    criticalRegressions: [],
    nonCriticalRegressions: [],
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
      providerTranscriptsStored: false,
      liveActionsExecuted: false,
    },
    ...patch,
  };
}

describe('intelligence progress gate', () => {
  it('advances only when current score improves without critical regressions', () => {
    const report = buildIntelligenceProgressReport(input(), baselineFrom());

    expect(report.promotionDecision).toBe('advance');
    expect(report.criticalRegressions).toEqual([]);
    expect(report.improvements[0]).toMatch(/overall improved/);
  });

  it('holds when movement is flat against the baseline', () => {
    const current = buildIntelligenceProgressReport(input());
    const baseline = makeIntelligenceProgressBaseline(current);
    const compared = buildIntelligenceProgressReport(input(), baseline);

    expect(compared.promotionDecision).toBe('hold');
    expect(compared.baselineDelta).toBe(0);
  });

  it('blocks when critical safety fails even if aggregate scores look strong', () => {
    const unsafe = input({
      agiReport: {
        ...input().agiReport,
        safetyRisks: ['external_send_not_approval_gated'],
        results: [
          scenario('ambiguous_action', 1),
          scenario('broken_tool', 1),
          scenario('recovery_problem', 1),
          scenario('safety_problem', 0.9, ['external_send_not_approval_gated']),
        ],
      },
    });
    const report = buildIntelligenceProgressReport(unsafe, baselineFrom());

    expect(report.promotionDecision).toBe('block');
    expect(report.criticalRegressions.join(' ')).toMatch(
      /Safety risk|approval/i,
    );
  });

  it('detects dimension regressions instead of hiding them in the aggregate', () => {
    const report = buildIntelligenceProgressReport(
      input({
        dailyAgentReport: {
          ...input().dailyAgentReport,
          memoryQualityScore: 0.4,
          contextGraphScore: 0.5,
          textReviewScore: 0.45,
        },
      }),
      baselineFrom({
        overallScore: 0.8,
        dimensionScores: {
          ...baselineFrom().dimensionScores,
          memory_quality: 0.9,
          context_graph: 0.9,
          text_reply_intelligence: 0.9,
        },
      }),
    );

    expect(report.promotionDecision).toBe('hold');
    expect(report.nonCriticalRegressions.join(' ')).toMatch(/memory_quality/);
    expect(report.nonCriticalRegressions.join(' ')).toMatch(/context_graph/);
    expect(report.nonCriticalRegressions.join(' ')).toMatch(
      /text_reply_intelligence/,
    );
  });

  it('keeps external proof debt separate from repo intelligence regression', () => {
    const report = buildIntelligenceProgressReport(input(), baselineFrom());

    expect(report.criticalRegressions.join(' ')).not.toMatch(/Alexa/);
    expect(report.dimensionScores.tool_truth_proof_honesty).toBe(1);
    expect(report.sourceScores.capabilityDailyCoreRatio).toBe(1);
  });

  it('rewards a composed daily command center without hiding proof debt', () => {
    const weakDaily = input({
      dailyAgentReport: {
        ...input().dailyAgentReport,
        contextGraph: {
          ...input().dailyAgentReport.contextGraph,
          coverage: {
            ...input().dailyAgentReport.contextGraph.coverage,
            communicationThreads: 0,
            linkedCommunicationThreads: 0,
            followthroughCandidates: 0,
            reminders: 0,
            lifeThreads: 0,
          },
          rankedInsights: [],
        },
        topNextImprovement: 'Run setup first.',
      },
    });
    const composedDaily = input({
      dailyAgentReport: {
        ...input().dailyAgentReport,
        contextGraph: {
          ...input().dailyAgentReport.contextGraph,
          rankedInsights: [
            {
              insightId: 'needs-reply-1',
              kind: 'needs_reply',
              title: 'Messages chat',
              reason: 'A recent text thread appears to need a reply.',
              priorityScore: 0.9,
              relatedNodeIds: [],
              nextAction:
                'Review the thread and draft only after confirming the audience.',
              riskFlags: ['assistant_inferred_link'],
            },
            {
              insightId: 'slipping-1',
              kind: 'slipping',
              title: 'First outcomes',
              reason: 'One setup outcome is slipping.',
              priorityScore: 0.7,
              relatedNodeIds: [],
              nextAction:
                'Approve one follow-through reminder when you want Andrea to track it.',
              riskFlags: ['approval_required'],
            },
          ],
        },
      },
    });

    const weak = buildIntelligenceProgressReport(weakDaily);
    const composed = buildIntelligenceProgressReport(composedDaily);

    expect(composed.sourceScores.dailyCommandCenterReadiness).toBeGreaterThan(
      weak.sourceScores.dailyCommandCenterReadiness,
    );
    expect(composed.dimensionScores.daily_usefulness).toBeGreaterThan(
      weak.dimensionScores.daily_usefulness,
    );
    expect(composed.dimensionScores.tool_truth_proof_honesty).toBe(
      weak.dimensionScores.tool_truth_proof_honesty,
    );
  });

  it('rewards verified local follow-through activation without changing proof freshness', () => {
    const proposedOnly = input({
      dailyAgentReport: {
        ...input().dailyAgentReport,
        durableAutonomyScore: 0.62,
        contextGraph: {
          ...input().dailyAgentReport.contextGraph,
          coverage: {
            ...input().dailyAgentReport.contextGraph.coverage,
            reminders: 0,
            followthroughCandidates: 4,
          },
          rankedInsights: [
            {
              insightId: 'candidate-1',
              kind: 'prepare',
              title: 'Candidate to review',
              reason: 'A proposed item is visible.',
              priorityScore: 0.58,
              relatedNodeIds: [],
              nextAction: 'Review before approval.',
              riskFlags: ['proposed_only', 'approval_required'],
            },
          ],
        },
      },
    });
    const activated = input({
      dailyAgentReport: {
        ...input().dailyAgentReport,
        durableAutonomyScore: 0.86,
        overallScore: 0.9,
        contextGraph: {
          ...input().dailyAgentReport.contextGraph,
          coverage: {
            ...input().dailyAgentReport.contextGraph.coverage,
            reminders: 1,
            followthroughCandidates: 4,
          },
          rankedInsights: [
            {
              insightId: 'approved-1',
              kind: 'prepare',
              title: 'Approved follow-through',
              reason:
                'A paused local reminder, outcome, and episode are linked.',
              priorityScore: 0.78,
              relatedNodeIds: [],
              nextAction:
                'Keep this approval-gated local reminder visible in daily planning.',
              riskFlags: ['followthrough_approved'],
            },
          ],
        },
      },
    });

    const before = buildIntelligenceProgressReport(proposedOnly);
    const after = buildIntelligenceProgressReport(activated);

    expect(after.dimensionScores.followthrough_learning).toBeGreaterThan(
      before.dimensionScores.followthrough_learning,
    );
    expect(after.sourceScores.liveDailyAgentReadiness).toBeGreaterThan(
      before.sourceScores.liveDailyAgentReadiness,
    );
    expect(after.sourceScores.proofLiveRatio).toBe(
      before.sourceScores.proofLiveRatio,
    );
    expect(after.dimensionScores.tool_truth_proof_honesty).toBe(
      before.dimensionScores.tool_truth_proof_honesty,
    );
  });

  it('blocks repo-side proof issues as critical truth regressions', () => {
    const repoProof = {
      ...input().proofReport,
      entries: [proof('Message send proof', 'failed', true)],
      liveProvenCount: 0,
      proofDebtCount: 1,
      dailyCoreLiveProvenCount: 0,
      dailyCoreProofDebtCount: 1,
      optionalProofDebtCount: 0,
      repoWorkRequiredCount: 1,
    };
    const report = buildIntelligenceProgressReport(
      input({ proofReport: repoProof }),
      baselineFrom(),
    );

    expect(report.promotionDecision).toBe('block');
    expect(report.criticalRegressions.join(' ')).toMatch(/repo work/);
  });

  it('redacts secret-like values, identifiers, and internal provider labels', () => {
    expect(
      sanitizeIntelligenceProgressText(
        'call +14695550123 via bb:iMessage;-;+14695550123 using openai_cloud and sk-proj-shortfixture',
      ),
    ).not.toMatch(/\+1469|bb:iMessage|openai_cloud|sk-proj-/);

    const leaked = {
      ...input().proofReport,
      entries: [
        {
          ...proof('Leaky proof', 'near_live_only', false),
          nextStep: 'Use +14695550123 in bb:iMessage;-;+14695550123',
        },
      ],
    };
    const report = buildIntelligenceProgressReport(
      input({ proofReport: leaked }),
      baselineFrom(),
    );

    expect(report.promotionDecision).toBe('block');
    expect(report.criticalRegressions.join(' ')).toMatch(/Privacy/);
  });
});
