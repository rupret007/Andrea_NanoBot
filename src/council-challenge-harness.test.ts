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
  it('classifies challenge scenarios as synthetic council evidence', async () => {
    const runCouncil = vi.fn(async (_input: unknown) => null);

    await runCouncilChallengeHarness(
      {
        tier: 'small',
        runId: 'challenge-origin-proof',
        createRepairPlans: false,
      },
      {
        runCouncil,
        emitChallenge: vi.fn(async () => null),
      },
    );

    expect(runCouncil).toHaveBeenCalled();
    for (const [input] of runCouncil.mock.calls) {
      expect(input).toMatchObject({ runOrigin: 'synthetic' });
    }
  });

  function passingCouncil(extra: Record<string, unknown> = {}) {
    return {
      councilRunId: 'council-small',
      mode: 'single_model' as const,
      status: 'completed',
      observedMemberIds: ['openai_cloud'],
      observedRoles: ['planner'],
      eventIds: ['event-1'],
      evidenceIds: ['local:metadata'],
      providerFailures: [],
      estimatedCostTier: 'low' as const,
      structuredVerdict: {
        status: 'pass',
        recommendedAction: 'answer',
        confidence: 0.9,
        evidenceGrade: 'partial',
        approvalNeed: 'none',
        riskFlags: [],
        evidenceIds: ['local:metadata'],
        usableMemberCount: 1,
        blockedMemberCount: 0,
        quality: {
          ledgerVersion: 'v3',
          retention: '90d_or_1000_runs',
          rawPromptsStored: false,
          rawPrivateBodiesStored: false,
          outcomeSignalCount: 1,
        },
        calibration: {
          requestedMode: 'single_model',
          chosenMode: 'single_model',
          changedMode: false,
          protectedMode: false,
          reason: 'history_ok_default_route',
          recentRuns: 1,
          lowConfidenceRuns: 0,
          schemaInvalidRuns: 0,
          verifierBlockRuns: 0,
          negativeFeedbackRuns: 0,
          degradedProviderIds: [],
          providerReliability: [],
        },
      },
      ...extra,
    };
  }

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
          structuredVerdict: {
            status: 'pass',
            recommendedAction: 'answer',
            confidence: 0.9,
            evidenceGrade: 'partial',
            approvalNeed: 'none',
            riskFlags: [],
            evidenceIds: ['local:metadata'],
            usableMemberCount: 1,
            blockedMemberCount: 0,
            quality: {
              ledgerVersion: 'v3',
              retention: '90d_or_1000_runs',
              rawPromptsStored: false,
              rawPrivateBodiesStored: false,
              outcomeSignalCount: 1,
            },
            calibration: {
              requestedMode: 'single_model',
              chosenMode: 'single_model',
              changedMode: false,
              protectedMode: false,
              reason: 'history_ok_default_route',
              recentRuns: 1,
              lowConfidenceRuns: 0,
              schemaInvalidRuns: 0,
              verifierBlockRuns: 0,
              negativeFeedbackRuns: 0,
              degradedProviderIds: [],
              providerReliability: [],
            },
          },
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

    expect(listCouncilChallengeScenarios('small')).toHaveLength(3);
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
  }, 15000);

  it('allows generic secret-policy wording without treating it as leaked credentials', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'small',
        runId: 'challenge-small-policy-wording',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () =>
          passingCouncil({
            riskFlags: ['redaction policy mentions api key names only'],
          }),
        ),
      },
    );

    expect(report.status).toBe('pass');
    expect(
      report.results.flatMap((result) => result.criticalFailures),
    ).not.toContain('forbidden_leakage');
  });

  it('still fails on secret-shaped leakage in the sanitized council surface', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'small',
        runId: 'challenge-small-secret-leak',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () =>
          passingCouncil({
            riskFlags: ['sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'],
          }),
        ),
      },
    );

    expect(report.status).toBe('fail');
    expect(
      report.results.flatMap((result) => result.criticalFailures),
    ).toContain('forbidden_leakage');
  });

  it('does not treat provider-like prefixes as leaked secrets unless they are secret-shaped', async () => {
    const benign = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-benign-prefix',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () =>
          passingCouncil({
            mode: 'dual_review',
            observedMemberIds: [
              'brave_search',
              'openai_cloud',
              'minimax_cloud',
              'gemini_cloud',
            ],
            observedRoles: ['evidence_scout', 'planner', 'critic', 'verifier'],
            evidenceIds: ['brave:1:https://example.com/BSA-policy'],
            riskFlags: ['BSA-style policy label redacted safely'],
            estimatedCostTier: 'medium' as const,
          }),
        ),
      },
    );

    expect(
      benign.results.flatMap((result) => result.criticalFailures),
    ).not.toContain('forbidden_leakage');

    const leaked = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-secret-prefix',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () =>
          passingCouncil({
            mode: 'dual_review',
            observedMemberIds: [
              'brave_search',
              'openai_cloud',
              'minimax_cloud',
              'gemini_cloud',
            ],
            observedRoles: ['evidence_scout', 'planner', 'critic', 'verifier'],
            evidenceIds: ['brave:1:https://example.com'],
            riskFlags: ['BSA-abcdefghijklmnopqrstuvwxyz123456'],
            estimatedCostTier: 'medium' as const,
          }),
        ),
      },
    );

    expect(
      leaked.results.flatMap((result) => result.criticalFailures),
    ).toContain('forbidden_leakage');
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
  }, 15000);

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
  }, 15000);

  it('fails the role-coverage rubric when observed providers are skipped or blocked', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-unusable-observed',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-medium-unusable-observed',
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
          providerFailures: [],
          estimatedCostTier: 'medium' as const,
          structuredVerdict: {
            status: 'warn',
            recommendedAction: 'answer',
            confidence: 0.62,
            evidenceGrade: 'strong',
            approvalNeed: 'none',
            riskFlags: [],
            evidenceIds: ['brave:1:https://example.com'],
            usableMemberCount: 2,
            blockedMemberCount: 1,
            replayArtifact: {
              replaySummary:
                'MiniMax was skipped and Gemini was blocked; only Brave and OpenAI completed.',
              memberStatuses: [
                {
                  memberId: 'brave_search',
                  providerId: 'brave_search',
                  role: 'evidence_scout',
                  status: 'completed',
                  verdict: 'pass',
                  confidence: 0.82,
                  schemaStatus: 'valid',
                  schemaIssues: [],
                  evidenceIds: ['brave:1:https://example.com'],
                  riskFlags: [],
                },
                {
                  memberId: 'openai_cloud',
                  providerId: 'openai_cloud',
                  role: 'planner',
                  status: 'completed',
                  verdict: 'pass',
                  confidence: 0.86,
                  schemaStatus: 'valid',
                  schemaIssues: [],
                  evidenceIds: ['brave:1:https://example.com'],
                  riskFlags: [],
                },
                {
                  memberId: 'minimax_cloud',
                  providerId: 'minimax_cloud',
                  role: 'critic',
                  status: 'skipped',
                  verdict: 'warn',
                  confidence: 0,
                  schemaStatus: 'valid',
                  schemaIssues: [],
                  evidenceIds: [],
                  riskFlags: ['minimax_cloud_quota_or_rate_limit'],
                },
                {
                  memberId: 'gemini_cloud',
                  providerId: 'gemini_cloud',
                  role: 'verifier',
                  status: 'blocked',
                  verdict: 'block',
                  confidence: 0,
                  schemaStatus: 'valid',
                  schemaIssues: [],
                  evidenceIds: [],
                  riskFlags: ['gemini_cloud_quota_or_rate_limit'],
                },
              ],
            },
          },
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

    expect(report.status).toBe('fail');
    expect(report.results[0]).toMatchObject({
      status: 'fail',
      rolesObserved: ['brave_search', 'openai_cloud'],
      missingRoles: ['minimax_cloud', 'gemini_cloud'],
      criticalFailures: ['required_role_missing'],
    });
    expect(
      report.results[0]?.kpiBreakdown?.find(
        (component) => component.kpiId === 'role_coverage',
      ),
    ).toMatchObject({
      passed: false,
    });
  }, 15000);

  it('keeps quorum-satisfied transport blips visible without hard-failing medium council score', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-transient',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-medium-transient',
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
          providerFailures: ['anthropic_cloud_transport_error'],
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

    expect(report.results[0]).toMatchObject({
      status: 'pass',
      providerFailures: [],
      transientProviderFailures: ['anthropic_cloud_transport_error'],
    });
    expect(report.totalScore).toBe(1);
  }, 15000);

  it('does not hard-fail medium dual-review when a required provider has a transient transport miss and quorum is met', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-required-transient',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async (input) => ({
          councilRunId: `council-${input.metadata?.challenge_scenario_id}`,
          mode: 'dual_review' as const,
          status: 'completed',
          observedMemberIds:
            input.metadata?.challenge_scenario_id ===
            'medium.checkpoint_resume_interrupt'
              ? ['openai_cloud', 'anthropic_cloud', 'gemini_cloud']
              : input.metadata?.challenge_scenario_id ===
                  'medium.tool_failure_recovery'
                ? [
                    'brave_search',
                    'openai_cloud',
                    'minimax_cloud',
                    'gemini_cloud',
                  ]
                : ['brave_search', 'openai_cloud', 'gemini_cloud'],
          observedRoles:
            input.metadata?.challenge_scenario_id ===
            'medium.checkpoint_resume_interrupt'
              ? ['planner', 'critic', 'verifier']
              : input.metadata?.challenge_scenario_id ===
                  'medium.tool_failure_recovery'
                ? ['evidence_scout', 'planner', 'critic', 'verifier']
                : ['evidence_scout', 'planner', 'verifier'],
          eventIds: ['event-1'],
          evidenceIds:
            input.requiredEvidence === 'strong'
              ? ['brave:1:https://example.com']
              : [],
          providerFailures:
            input.metadata?.challenge_scenario_id ===
            'medium.tool_failure_recovery'
              ? []
              : ['minimax_cloud_transport_error'],
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

    expect(report.status).toBe('pass');
    expect(report.criticalFailureCount).toBe(0);
    expect(report.results[0]).toMatchObject({
      status: 'pass',
      missingRoles: [],
      providerFailures: [],
      transientProviderFailures: ['minimax_cloud_transport_error'],
    });
    expect(report.results[1]).toMatchObject({
      status: 'pass',
      missingRoles: [],
      providerFailures: [],
      transientProviderFailures: ['minimax_cloud_transport_error'],
    });
  }, 15000);

  it('does not misclassify human-review risk text as provider failure', async () => {
    const report = await runCouncilChallengeHarness(
      {
        tier: 'medium',
        runId: 'challenge-medium-human-review-risk',
        recordToPlatform: false,
        createRepairPlans: false,
      },
      {
        runCouncil: vi.fn(async () => ({
          councilRunId: 'council-medium-human-review-risk',
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
          providerFailures: [
            'human-review bottleneck if reviewers are unavailable or lack context',
            'repeated_failure_signature:3b635033cca3',
            'minimax_fast_fallback_used',
            'Provider health data present but not directly relevant to approval flow design',
            'Incomplete evidence pack (provider_health:brave_search truncated)',
            'vendor-authored evidence dominance',
            'system failures (Anthropic, council timeout) unaddressed in plan',
          ],
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

    expect(report.results[0]).toMatchObject({
      status: 'pass',
      providerFailures: [],
    });
  }, 15000);

  it('requires checkpoint approval timeout and approver-unavailable failure modes', () => {
    const checkpointScenario = listCouncilChallengeScenarios('medium').find(
      (scenario) =>
        scenario.scenarioId === 'medium.checkpoint_resume_interrupt',
    );

    expect(checkpointScenario?.successRubric.join(' ')).toMatch(
      /approval timeout/i,
    );
    expect(checkpointScenario?.successRubric.join(' ')).toMatch(
      /approver-unavailable/i,
    );
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
