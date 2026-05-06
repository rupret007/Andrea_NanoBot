import { describe, expect, it, vi } from 'vitest';

import {
  listCouncilChallengeScenarios,
  runCouncilChallengeHarness,
} from './council-challenge-harness.js';
import {
  SOURCE_REPO_MANIFEST,
  compareCouncilChallengeScore,
  scoreIntelligenceAdvancement,
} from './agent-source-intelligence.js';

describe('council challenge harness', () => {
  it('selects scenarios by tier and records a passing observable council run', async () => {
    const emitChallenge = vi.fn(async () => ({
      runId: 'challenge-small',
      status: 'pass' as const,
      totalScore: 1,
      criticalFailureCount: 0,
      issueCount: 0,
    }));
    const report = await runCouncilChallengeHarness(
      {
        tier: 'small',
        runId: 'challenge-small',
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-small',
          mode: 'single_model' as const,
          status: 'completed',
          observedMemberIds: ['openai_cloud'],
          observedRoles: ['planner'],
          eventIds: ['event-1'],
          evidenceIds: ['local:metadata'],
          providerFailures: [],
          estimatedCostTier: 'low' as const,
        })),
        emitChallenge,
        now: (() => {
          let value = 0;
          return () => {
            value += 10;
            return value;
          };
        })(),
      },
    );

    expect(listCouncilChallengeScenarios('small')).toHaveLength(2);
    expect(report.status).toBe('pass');
    expect(report.totalScore).toBe(1);
    expect(report.results[0]).toMatchObject({
      scenarioId: 'small.observable_single_model',
      status: 'pass',
      rolesObserved: ['openai_cloud'],
      missingRoles: [],
      intelligenceAdvancementScore: 1,
    });
    expect(emitChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'challenge-small',
        tier: 'small',
        status: 'pass',
      }),
    );
  });

  it('turns failed challenge scenarios into one-approval repair plans', async () => {
    const emitDiagnosis = vi.fn(async () => ({
      diagnosisId: 'diagnosis-1',
      status: 'diagnosed',
    }));
    const emitRepairPlan = vi.fn(async () => ({
      repairPlanId: 'repair-plan-1',
      status: 'awaiting_approval',
      workerId: 'cursor_cloud',
    }));
    const report = await runCouncilChallengeHarness(
      {
        tier: 'large',
        runId: 'challenge-large',
        recordToPlatform: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-large',
          mode: 'max_iq_council' as const,
          status: 'completed',
          observedMemberIds: ['openai_cloud'],
          observedRoles: ['planner'],
          eventIds: ['event-1'],
          evidenceIds: [],
          providerFailures: ['minimax_critic_unavailable'],
          estimatedCostTier: 'high' as const,
        })),
        emitDiagnosis,
        emitRepairPlan,
        now: (() => {
          let value = 0;
          return () => {
            value += 10;
            return value;
          };
        })(),
      },
    );

    expect(report.status).toBe('fail');
    expect(report.criticalFailureCount).toBeGreaterThan(0);
    expect(report.results[0]?.repairPlanId).toBe('repair-plan-1');
    expect(emitDiagnosis).toHaveBeenCalledWith(
      expect.objectContaining({
        taskFamily: 'operator',
        metadata: expect.objectContaining({
          council_challenge_scenario_id: 'large.max_iq_architecture_review',
        }),
      }),
    );
    expect(emitRepairPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'cursor_cloud',
        deployAllowed: false,
        metadata: expect.objectContaining({
          one_approval_required_for_mutation: 'true',
          local_fallback_requires_explicit_approval: 'true',
        }),
      }),
    );
  });

  it('does not pass a degraded provider council as a full-score run', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-degraded',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-medium-degraded',
          mode: 'dual_review' as const,
          status: 'completed',
          observedMemberIds: [
            'brave_search',
            'openai_cloud',
            'minimax_cloud',
            'gemini_cloud',
          ],
          observedRoles: ['evidence_scout', 'planner', 'critic', 'verifier'],
          eventIds: ['event-1'],
          evidenceIds: ['brave:1:https://example.com'],
          providerFailures: ['minimax_critic_unavailable'],
          estimatedCostTier: 'medium' as const,
        })),
        now: (() => {
          let value = 0;
          return () => {
            value += 10;
            return value;
          };
        })(),
      },
    );

    expect(report.status).toBe('degraded');
    expect(report.totalScore).toBeLessThan(1);
    expect(report.results[0]).toMatchObject({
      status: 'degraded',
      providerFailures: ['minimax_critic_unavailable'],
    });
    expect(report.results[0]?.score).toBeLessThan(1);
  });

  it('tracks source-guided KPI coverage and detects score regressions', () => {
    const directCandidates = SOURCE_REPO_MANIFEST.filter(
      (repo) => repo.licensePolicy === 'direct_import_allowed_with_notice',
    );
    const score = scoreIntelligenceAdvancement({
      scenarioId: 'large.verifier_override_disagreement',
      expectedCouncilMode: 'max_iq_council',
      requiredRoles: [
        'brave_search',
        'openai_cloud',
        'minimax_cloud',
        'gemini_cloud',
      ],
      rolesObserved: [
        'brave_search',
        'openai_cloud',
        'minimax_cloud',
        'gemini_cloud',
      ],
      missingRoles: [],
      requiredEvidence: 'strong',
      evidenceLevel: 'strong',
      criticalFailures: [],
      providerFailures: [],
      eventIds: ['event-1'],
      councilRunId: 'council-1',
      status: 'pass',
      sideEffectPolicy: 'read_only',
      repairPolicy: 'one_approval',
      sourcePatternIds: ['agents_sdk.tracing_guardrails_handoffs'],
    });
    const regression = compareCouncilChallengeScore({
      latestTotalScore: 0.98,
      latestCriticalFailureCount: 0,
      baseline: {
        totalScore: 1,
        criticalFailureCount: 0,
        criticalScenarioIds: [],
      },
    });
    const providerDegradedScore = scoreIntelligenceAdvancement({
      scenarioId: 'medium.live_evidence_dual_review',
      expectedCouncilMode: 'dual_review',
      requiredRoles: [
        'brave_search',
        'openai_cloud',
        'minimax_cloud',
        'gemini_cloud',
      ],
      rolesObserved: [
        'brave_search',
        'openai_cloud',
        'minimax_cloud',
        'gemini_cloud',
      ],
      missingRoles: [],
      requiredEvidence: 'strong',
      evidenceLevel: 'strong',
      criticalFailures: [],
      providerFailures: ['minimax_critic_unavailable'],
      eventIds: ['event-1'],
      councilRunId: 'council-1',
      status: 'degraded',
      sideEffectPolicy: 'read_only',
      repairPolicy: 'one_approval',
      sourcePatternIds: ['crewai.role_specialization'],
    });

    expect(directCandidates.length).toBeGreaterThan(0);
    expect(score.totalScore).toBe(1);
    expect(providerDegradedScore.totalScore).toBeLessThan(1);
    expect(score.components.map((component) => component.kpiId)).toContain(
      'verifier_participation',
    );
    expect(regression.status).toBe('regressed');
  });
});
