import { describe, expect, it } from 'vitest';

import {
  buildAgiLabReadinessReport,
  formatAgiLabReadinessReport,
  type BuildAgiLabReadinessOptions,
} from './agi-lab-readiness.js';
import type { AutonomousImprovementLabReport } from './autonomous-improvement-lab.js';
import type { CognitiveDoctorReport } from './cognitive-kernel.js';
import type { CouncilReplayReport } from './council-quality.js';
import type { IntegrationDoctorReport } from './integration-doctor.js';
import type { IntelligenceProgressReport } from './intelligence-progress.js';
import type { PilotReviewDigest } from './pilot-mode.js';
import type { CouncilDoctorReport, LiveProofGauntletReport } from './types.js';

const generatedAt = '2026-07-08T17:00:00.000Z';

function intelligenceProgress(
  overrides: Record<string, unknown> = {},
): IntelligenceProgressReport {
  return {
    currentRunId: 'intel-run',
    generatedAt,
    groupFolder: 'main',
    overallScore: 0.96,
    dimensionScores: {
      daily_usefulness: 0.96,
      memory_quality: 0.95,
      context_graph: 0.95,
      text_reply_intelligence: 0.95,
      followthrough_learning: 0.96,
      tool_truth_proof_honesty: 1,
      council_quality: 0.95,
      autonomy_safety: 1,
      privacy_redaction: 1,
      regression_stability: 0.96,
    },
    criticalRegressions: [],
    nonCriticalRegressions: [],
    improvements: ['overall improved'],
    promotionDecision: 'advance',
    topNextImprovement: 'Promote one repeated workflow into the daily suite.',
    baselineId: null,
    baselineDelta: null,
    sourceScores: {
      syntheticWholeAssistant: 0.96,
      liveDailyAgentReadiness: 0.96,
      intelligenceRegressionCritical: 1,
      proofLiveRatio: 1,
      capabilityDailyCoreRatio: 1,
      dailyCommandCenterReadiness: 0.96,
      cognitionTraceHealth: 1,
    },
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
      providerTranscriptsStored: false,
      liveActionsExecuted: false,
    },
    ...overrides,
  } as unknown as IntelligenceProgressReport;
}

function integrationReport(
  overrides: Record<string, unknown> = {},
): IntegrationDoctorReport {
  return {
    generatedAt,
    summary: {
      total: 4,
      healthy: 4,
      actionNeeded: 0,
      needsProof: 0,
      manualOrExternal: 0,
    },
    statuses: [],
    secretsRedacted: true,
    ...overrides,
  } as unknown as IntegrationDoctorReport;
}

function proofReport(
  overrides: Record<string, unknown> = {},
): LiveProofGauntletReport {
  return {
    generatedAt,
    entries: [],
    liveProvenCount: 4,
    proofDebtCount: 0,
    dailyCoreLiveProvenCount: 4,
    dailyCoreProofDebtCount: 0,
    optionalProofDebtCount: 0,
    repoWorkRequiredCount: 0,
    nextAction: 'Keep proof freshness refreshed.',
    privacyJson: '{}',
    ...overrides,
  } as unknown as LiveProofGauntletReport;
}

function councilReport(
  overrides: Record<string, unknown> = {},
): CouncilDoctorReport {
  return {
    generatedAt,
    ok: true,
    summary: 'Council quality is healthy.',
    recent: {
      observedRuns: 5,
      totalRuns: 5,
      replayRuns: 0,
      syntheticRuns: 0,
      degradedRuns: 0,
      averageConfidence: 0.95,
      schemaInvalidRuns: 0,
      lowConfidenceRuns: 0,
      outcomeSignals: 5,
    },
    providerReliability: [],
    degradedReasons: [],
    evidenceGaps: [],
    nextAction: 'Keep council calibration refreshed.',
    privacy: {
      secretsRedacted: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
    },
    ...overrides,
  } as unknown as CouncilDoctorReport;
}

function councilReplay(
  overrides: Record<string, unknown> = {},
): CouncilReplayReport {
  return {
    generatedAt,
    latestRunId: 'council-run-1',
    taskFamily: 'assistant',
    mode: 'max_iq_council',
    finalStatus: 'completed',
    recommendedAction: 'ship',
    confidence: 0.95,
    evidenceGrade: 'A',
    approvalNeed: 'none',
    evidenceScorecard: {
      availableGrade: 'A',
      requiredGrade: 'B',
    },
    evidenceGaps: [],
    providerFailures: [],
    riskFlags: [],
    members: [],
    confidenceMath: {},
    budget: {},
    replaySummary: 'Council replay looked healthy.',
    privacy: {
      redactedMetadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
    },
    ...overrides,
  } as unknown as CouncilReplayReport;
}

function cognitiveReport(
  overrides: Record<string, unknown> = {},
): CognitiveDoctorReport {
  return {
    generatedAt,
    ok: true,
    summary: 'Cognitive trajectory is healthy.',
    activeRun: null,
    recent: {
      totalRuns: 5,
      blockedRuns: 0,
      approvalRuns: 0,
      averageOutcomeScore: 0.96,
      qualityScore: 0.96,
      decisionAppropriateRuns: 5,
      safeApprovalRuns: 0,
      appropriatelyBlockedRuns: 0,
      operationalFailureRuns: 0,
      finalizedRuns: 5,
      reviewedOutcomeRuns: 5,
      rewardSignals: 5,
      reflections: 5,
    },
    skills: {
      total: 5,
      promoted: 5,
      trustedPromoted: 5,
      unverifiedPromoted: 0,
      reviewEligibleCandidates: 0,
      candidates: 0,
      quarantined: 0,
      latestSkillId: 'skill-1',
    },
    providerUsability: {
      healthy: 3,
      degraded: 0,
      blocked: 0,
      degradedProviderIds: [],
    },
    checkpoints: {
      total: 5,
      open: 0,
      latestKind: 'outcome_review',
      latestNextAction: 'Keep cognitive outcomes verified.',
    },
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
    },
    ...overrides,
  } as unknown as CognitiveDoctorReport;
}

function improvementReport(
  overrides: Record<string, unknown> = {},
): AutonomousImprovementLabReport {
  return {
    generatedAt,
    hypotheses: [{ hypothesisId: 'hypothesis-1' }],
    experiments: [{ experimentId: 'experiment-1' }],
    patchPlans: [
      { planId: 'patch-1' },
      { planId: 'patch-2' },
      { planId: 'patch-3' },
    ],
    outcomes: [],
    topCandidates: [
      {
        hypothesisId: 'candidate-1',
        externalBlocker: false,
        nextAction: 'Turn strongest workflow into a skill.',
      },
      {
        hypothesisId: 'candidate-2',
        externalBlocker: false,
        nextAction: 'Add a focused regression.',
      },
      {
        hypothesisId: 'candidate-3',
        externalBlocker: false,
        nextAction: 'Close a pilot issue.',
      },
      {
        hypothesisId: 'candidate-4',
        externalBlocker: false,
        nextAction: 'Refresh proof evidence.',
      },
      {
        hypothesisId: 'candidate-5',
        externalBlocker: false,
        nextAction: 'Replay council route.',
      },
    ],
    selectedForExperiment: [],
    externalBlockers: [],
    patchPlanPolicy: {
      plansOnly: true,
      autoAppliesProductPatches: false,
      createsBranchesOrWorktrees: false,
      pushesWithoutValidation: false,
    },
    signalSummary: {
      pilotProofGaps: 0,
      repairAttempts: 0,
      reliabilityRollups: 0,
      executiveReflections: 0,
      learningDistillations: 0,
      skillRuns: 0,
      harnessProposals: 0,
      responseFeedback: 0,
    },
    nextAction: 'Turn strongest workflow into a skill.',
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
      providerDebatesStored: false,
      rawToolOutputStored: false,
    },
    ...overrides,
  } as unknown as AutonomousImprovementLabReport;
}

function pilotReview(
  overrides: Record<string, unknown> = {},
): PilotReviewDigest {
  return {
    loggingEnabled: true,
    recentEvents: [],
    openIssues: [],
    openIssueCount: 0,
    latestOpenIssue: null,
    liveProofCutoffIso: generatedAt,
    totalUsage24h: 3,
    totalUsage7d: 12,
    journeyDigests: {},
    recentProblemEvents: [],
    currentActionableProblemEvents: [],
    historicalRecurringFailures: [],
    ...overrides,
  } as unknown as PilotReviewDigest;
}

function sources(
  overrides: Partial<BuildAgiLabReadinessOptions> = {},
): BuildAgiLabReadinessOptions {
  return {
    now: new Date(generatedAt),
    providers: [],
    integrationReport: integrationReport(),
    proofReport: proofReport(),
    councilReport: councilReport(),
    councilReplay: councilReplay(),
    cognitiveReport: cognitiveReport(),
    intelligenceProgress: intelligenceProgress(),
    improvementReport: improvementReport(),
    pilotReview: pilotReview(),
    ...overrides,
  };
}

describe('agi lab readiness', () => {
  it('separates integration operability from stale proof and prioritizes real action items', async () => {
    const report = await buildAgiLabReadinessReport(
      sources({
        integrationReport: integrationReport({
          summary: {
            total: 4,
            healthy: 1,
            actionNeeded: 1,
            needsProof: 0,
            manualOrExternal: 1,
          },
          statuses: [
            {
              integrationId: 'telegram',
              state: 'near_live_only',
              nextAction: 'Refresh Telegram proof.',
            },
            {
              integrationId: 'openai_cloud',
              state: 'near_live_only',
              nextAction: 'Probe the provider.',
            },
            {
              integrationId: 'runtime_backend',
              state: 'healthy',
              nextAction: '',
            },
            {
              integrationId: 'alexa',
              state: 'manual_action_required',
              nextAction: 'Complete the Alexa checklist.',
            },
          ],
        }),
      }),
    );

    expect(
      report.gates.find((gate) => gate.gateId === 'integration_health'),
    ).toMatchObject({
      label: 'Integration operability',
      status: 'warn',
      score: 0.75,
      summary:
        '3/4 integrations operationally available; 1 action-needed; 2 evidence-limited.',
      nextAction: 'Complete the Alexa checklist.',
    });
  });

  it('advances when all readiness gates are clean', async () => {
    const report = await buildAgiLabReadinessReport(sources());

    expect(report.decision).toBe('advance');
    expect(report.privacy.liveActionsExecuted).toBe(false);
    expect(report.gates.every((gate) => gate.status === 'pass')).toBe(true);
    expect(formatAgiLabReadinessReport(report)).toContain('AGI Lab Readiness');
  });

  it('holds for proof debt without turning it into a repo regression', async () => {
    const report = await buildAgiLabReadinessReport(
      sources({
        proofReport: proofReport({
          liveProvenCount: 3,
          proofDebtCount: 1,
          dailyCoreLiveProvenCount: 3,
          dailyCoreProofDebtCount: 1,
          nextAction: 'Refresh Alexa and BlueBubbles proof evidence.',
        }),
      }),
    );

    expect(report.decision).toBe('hold');
    expect(
      report.gates.find((gate) => gate.gateId === 'live_proof'),
    ).toMatchObject({
      status: 'warn',
      nextAction: 'Refresh Alexa and BlueBubbles proof evidence.',
    });
    expect(
      report.gates.find((gate) => gate.gateId === 'regression_stability'),
    ).toMatchObject({
      status: 'pass',
    });
  });

  it('scores correct cautious council decisions separately from operational degradation', async () => {
    const report = await buildAgiLabReadinessReport(
      sources({
        councilReport: councilReport({
          ok: false,
          recent: {
            ...councilReport().recent,
            totalRuns: 4,
            liveRuns: 4,
            degradedRuns: 4,
            lowConfidenceRuns: 3,
            averageConfidence: 0.5,
            qualityScore: 0.92,
            decisionAppropriateRuns: 4,
            appropriatelyCautiousRuns: 3,
            operationallyDegradedRuns: 4,
            uncalibratedRuns: 0,
          },
        }),
      }),
    );

    expect(
      report.gates.find((gate) => gate.gateId === 'council_quality'),
    ).toMatchObject({
      status: 'warn',
      score: 0.92,
    });
  });

  it('blocks on critical regressions or repo-work proof issues', async () => {
    const report = await buildAgiLabReadinessReport(
      sources({
        intelligenceProgress: intelligenceProgress({
          dimensionScores: {
            ...intelligenceProgress().dimensionScores,
            regression_stability: 0.4,
          },
          criticalRegressions: ['approval safety regressed'],
          promotionDecision: 'block',
        }),
        proofReport: proofReport({
          repoWorkRequiredCount: 1,
          proofDebtCount: 1,
        }),
      }),
    );

    expect(report.decision).toBe('block');
    expect(report.topRisks.join(' ')).toMatch(
      /approval safety regressed|repo-work/i,
    );
  });
});
