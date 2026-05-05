import { describe, expect, it, vi } from 'vitest';

import {
  listCouncilChallengeScenarios,
  runCouncilChallengeHarness,
} from './council-challenge-harness.js';

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

    expect(listCouncilChallengeScenarios('small')).toHaveLength(1);
    expect(report.status).toBe('pass');
    expect(report.totalScore).toBe(1);
    expect(report.results[0]).toMatchObject({
      scenarioId: 'small.observable_single_model',
      status: 'pass',
      rolesObserved: ['openai_cloud'],
      missingRoles: [],
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
});
