import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assessCouncilRunQuality,
  buildCouncilReplayReport,
  buildCouncilDoctorReport,
  calibrateCouncilMode,
  formatCouncilDoctorReport,
  formatCouncilReplayReport,
  recordCouncilOutcomeSignal,
  recordCouncilRunLedger,
} from './council-quality.js';
import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  getCouncilRunLedger,
  listCouncilOutcomeSignals,
  listCouncilRunLedger,
} from './db.js';
import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import type { ProviderHealthSnapshot } from './provider-health.js';
import { writeProviderLiveHealthState } from './provider-live-health-state.js';

function providerHealth(
  providerId: string,
  state: ProviderHealthSnapshot['state'] = 'healthy',
  failureClass: ProviderHealthSnapshot['failureClass'] = 'none',
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: providerId === 'brave_search' ? 'search' : 'llm',
    state,
    lastHealthyAt: state === 'healthy' ? '2026-06-04T10:02:00.000Z' : null,
    lastCheckedAt: '2026-06-04T10:02:00.000Z',
    failureClass,
    quotaState: state === 'healthy' ? 'ok' : 'unknown',
    credentialState: state === 'healthy' ? 'configured' : 'unknown',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {},
  };
}

const healthyCoreProviders = [
  providerHealth('openai_cloud'),
  providerHealth('anthropic_cloud'),
  providerHealth('gemini_cloud'),
  providerHealth('minimax_cloud'),
  providerHealth('brave_search'),
];

function verdict(
  overrides: Partial<
    NonNullable<AndreaPlatformProviderCouncilResult['structuredVerdict']>
  > = {},
): NonNullable<AndreaPlatformProviderCouncilResult['structuredVerdict']> {
  return {
    status: 'warn',
    recommendedAction: 'answer',
    confidence: 0.72,
    evidenceGrade: 'partial',
    approvalNeed: 'none',
    riskFlags: [],
    evidenceIds: ['intent:test'],
    usableMemberCount: 2,
    blockedMemberCount: 0,
    confidenceMath: {
      base: 0.75,
      degradedParticipationPenalty: 0,
      providerFailurePenalty: 0,
      evidencePenalty: 0,
      verdictPenalty: 0.03,
      schemaPenalty: 0,
      final: 0.72,
    },
    schemaStatusSummary: {
      valid: 2,
      repaired: 0,
      invalid_fallback: 0,
    },
    evidenceScorecard: {
      requiredGrade: 'partial',
      availableGrade: 'partial',
      freshnessCoverage: {
        total: 1,
        fresh: 1,
        stale: 0,
        unknown: 0,
        notApplicable: 0,
      },
      sourceCoverage: { user_input: 1 },
      privateContentPolicy: 'sanitized_snippets',
      gapCount: 0,
      gapIds: [],
      sourceClasses: ['user_input'],
      confidencePenalty: 0,
    },
    budget: {
      mode: 'dual_review',
      maxRoles: 4,
      roleTimeoutMs: 20_000,
      maxRetries: 0,
      maxConcurrency: 2,
      fallbackAllowed: false,
      estimatedCostTier: 'medium',
      usedRoles: 2,
      retryCount: 0,
      loopGuardTriggered: false,
      status: 'within_budget',
    },
    replaySummary: 'Verdict=warn confidence=0.72',
    replayArtifact: {
      replaySummary: 'Verdict=warn confidence=0.72',
      memberStatuses: [
        {
          memberId: 'openai_cloud',
          providerId: 'openai_cloud',
          role: 'planner',
          status: 'completed',
          verdict: 'warn',
          confidence: 0.72,
          schemaStatus: 'valid',
          schemaIssues: [],
          evidenceIds: ['intent:test'],
          riskFlags: [],
        },
      ],
    },
    ...overrides,
  };
}

describe('council quality ledger', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('stores redacted metadata only for council runs', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-secret',
      taskFamily: 'assistant',
      channel: 'telegram',
      requestedMode: 'dual_review',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({
        riskFlags: ['provider key sk-proj-abcdefghijklmnopqrstuvwx'],
        replaySummary:
          'Verdict mentions jeff@example.com and +12025550101 but not raw prompts.',
      }),
      providerFailures: ['token=sk-proj-abcdefghijklmnopqrstuvwx'],
      riskFlags: ['phone +12025550101'],
      now: '2026-06-04T10:00:00.000Z',
    });

    const stored = getCouncilRunLedger('council-secret');

    expect(stored?.providerFailuresJson).not.toContain('sk-proj-');
    expect(stored?.riskFlagsJson).not.toContain('+12025550101');
    expect(stored?.replaySummary).toContain('[redacted-email]');
    expect(stored?.replaySummary).toContain('[redacted-phone]');
    expect(stored?.memberStatusesJson).not.toContain('raw prompt');
  });

  it('attaches outcome signals and updates run aggregates', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-outcome',
      taskFamily: 'assistant',
      channel: 'telegram',
      requestedMode: 'dual_review',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict(),
      now: '2026-06-04T10:00:00.000Z',
    });

    const recorded = recordCouncilOutcomeSignal({
      councilRunId: 'council-outcome',
      signalKind: 'answer_sent',
      channel: 'telegram',
      routeKey: 'assistant.daily',
      flags: ['provider_council_guidance_applied'],
      summary: 'Council outcome attached without private text.',
      now: '2026-06-04T10:01:00.000Z',
    });

    expect(recorded).toBe(true);
    expect(
      listCouncilOutcomeSignals({ councilRunId: 'council-outcome' }),
    ).toHaveLength(1);
    expect(getCouncilRunLedger('council-outcome')).toMatchObject({
      outcomeSignalCount: 1,
      outcomeStatus: 'answer_sent',
      latestOutcomeAt: '2026-06-04T10:01:00.000Z',
    });
  });

  it('treats evidence-backed clarification as calibrated caution, not failed reasoning', () => {
    const baseScorecard = verdict().evidenceScorecard!;
    recordCouncilRunLedger({
      councilRunId: 'council-calibrated-clarification',
      runOrigin: 'live',
      taskFamily: 'assistant',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({
        status: 'clarify',
        recommendedAction: 'ask_clarifying_question',
        confidence: 0.42,
        evidenceScorecard: {
          ...baseScorecard,
          gapCount: 1,
          gapIds: ['missing_message_context'],
        },
      }),
      riskFlags: ['missing_message_context'],
      now: '2026-06-04T10:00:00.000Z',
    });

    const run = getCouncilRunLedger('council-calibrated-clarification')!;
    const assessment = assessCouncilRunQuality(run);
    const doctor = buildCouncilDoctorReport('2026-06-04T10:01:00.000Z', {
      providerHealth: healthyCoreProviders,
    });

    expect(assessment).toMatchObject({
      decisionAppropriate: true,
      appropriatelyCautious: true,
      confidenceCalibrated: true,
      operationallyDegraded: false,
    });
    expect(assessment.score).toBeGreaterThanOrEqual(0.9);
    expect(doctor.recent.degradedRuns).toBe(0);
    expect(doctor.recent.appropriatelyCautiousRuns).toBe(1);
    expect(doctor.recent.uncalibratedRuns).toBe(0);
  });

  it('penalizes unsupported low-confidence answers', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-unsupported-answer',
      runOrigin: 'live',
      taskFamily: 'assistant',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({
        status: 'warn',
        recommendedAction: 'answer',
        confidence: 0.32,
      }),
      now: '2026-06-04T10:00:00.000Z',
    });

    const assessment = assessCouncilRunQuality(
      getCouncilRunLedger('council-unsupported-answer')!,
    );
    expect(assessment.decisionAppropriate).toBe(false);
    expect(assessment.confidenceCalibrated).toBe(false);
    expect(assessment.score).toBeLessThan(0.6);
  });

  it('does not escalate mode merely because repeated clarifications are appropriately cautious', () => {
    const baseScorecard = verdict().evidenceScorecard!;
    for (const id of ['a', 'b']) {
      recordCouncilRunLedger({
        councilRunId: `council-cautious-${id}`,
        runOrigin: 'live',
        taskFamily: 'assistant',
        chosenMode: 'dual_review',
        calibration: calibrateCouncilMode({
          taskFamily: 'assistant',
          requestedMode: 'dual_review',
        }),
        structuredVerdict: verdict({
          status: 'clarify',
          recommendedAction: 'ask_clarifying_question',
          confidence: 0.4,
          evidenceScorecard: {
            ...baseScorecard,
            gapCount: 1,
            gapIds: ['missing_message_context'],
          },
        }),
        riskFlags: ['missing_message_context'],
      });
    }

    expect(
      calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
    ).toMatchObject({
      chosenMode: 'dual_review',
      changedMode: false,
      lowConfidenceRuns: 0,
      verifierBlockRuns: 0,
    });
  });

  it('separates correct blocking from operational provider degradation', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-provider-block',
      runOrigin: 'live',
      taskFamily: 'operator',
      chosenMode: 'max_iq_council',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'max_iq_council',
      }),
      structuredVerdict: verdict({
        status: 'block',
        recommendedAction: 'block',
        confidence: 0.4,
      }),
      providerFailures: ['anthropic_cloud_transport_error'],
      now: '2026-06-04T10:00:00.000Z',
    });

    const assessment = assessCouncilRunQuality(
      getCouncilRunLedger('council-provider-block')!,
    );
    expect(assessment.decisionAppropriate).toBe(true);
    expect(assessment.appropriatelyCautious).toBe(true);
    expect(assessment.confidenceCalibrated).toBe(true);
    expect(assessment.operationallyDegraded).toBe(true);
    expect(assessment.score).toBeGreaterThan(0.7);
  });

  it('excludes replay and synthetic runs from live promotion signals', () => {
    for (const runOrigin of ['replay', 'synthetic'] as const) {
      recordCouncilRunLedger({
        councilRunId: `council-${runOrigin}`,
        runOrigin,
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
        chosenMode: 'dual_review',
        calibration: calibrateCouncilMode({
          taskFamily: 'assistant',
          requestedMode: 'dual_review',
        }),
        structuredVerdict: verdict({ confidence: 0.1, status: 'block' }),
      });
    }

    const calibration = calibrateCouncilMode({
      taskFamily: 'assistant',
      requestedMode: 'dual_review',
    });
    const doctor = buildCouncilDoctorReport('2026-06-04T10:02:00.000Z', {
      providerHealth: healthyCoreProviders,
    });

    expect(calibration).toMatchObject({
      recentRuns: 0,
      chosenMode: 'dual_review',
      reason: 'no_history_default_route',
    });
    expect(doctor.recent).toMatchObject({
      totalRuns: 0,
      liveRuns: 0,
      replayRuns: 1,
      syntheticRuns: 1,
    });
  });

  it('treats legacy challenge run ids as synthetic even when mislabeled live', () => {
    recordCouncilRunLedger({
      councilRunId:
        'local-council:council-challenge-medium-legacy:scenario-one',
      runOrigin: 'live',
      taskFamily: 'operator',
      requestedMode: 'dual_review',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({ confidence: 0.1, status: 'block' }),
    });

    const calibration = calibrateCouncilMode({
      taskFamily: 'operator',
      requestedMode: 'dual_review',
    });
    const doctor = buildCouncilDoctorReport('2026-06-04T10:02:00.000Z', {
      providerHealth: healthyCoreProviders,
    });

    expect(calibration.recentRuns).toBe(0);
    expect(doctor.recent).toMatchObject({
      liveRuns: 0,
      syntheticRuns: 1,
    });
  });

  it('separates current evidence gaps from historical proof debt', () => {
    const baseEvidenceScorecard = verdict().evidenceScorecard;
    expect(baseEvidenceScorecard).toBeDefined();
    for (const [index, gap] of [
      'integration_bluebubbles_needs_proof',
      'integration_alexa_manual_action_required',
    ].entries()) {
      recordCouncilRunLedger({
        councilRunId: `council-gap-${index}`,
        runOrigin: 'live',
        taskFamily: 'operator',
        requestedMode: 'dual_review',
        chosenMode: 'dual_review',
        calibration: calibrateCouncilMode({
          taskFamily: 'operator',
          requestedMode: 'dual_review',
        }),
        structuredVerdict: verdict({
          evidenceScorecard: {
            ...baseEvidenceScorecard!,
            gapCount: 1,
            gapIds: [gap],
          },
        }),
        now: `2026-06-04T10:0${index}:00.000Z`,
      });
    }

    const report = buildCouncilDoctorReport('2026-06-04T10:02:00.000Z', {
      providerHealth: healthyCoreProviders,
      integrationHealth: [
        { integrationId: 'bluebubbles', state: 'healthy' },
        { integrationId: 'alexa', state: 'manual_action_required' },
      ],
    });

    expect(report.evidenceGaps).toEqual([
      'integration_alexa_manual_action_required',
    ]);
    expect(report.historicalEvidenceGaps).toEqual([]);
    expect(report.resolvedEvidenceGaps).toEqual([
      'integration_bluebubbles_needs_proof',
    ]);
  });

  it('migrates legacy council rows as replay provenance', () => {
    _closeDatabase();
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-council-migration-'),
    );
    try {
      const dbPath = path.join(dir, 'legacy.sqlite');
      const legacy = new Database(dbPath);
      legacy.exec(`
      CREATE TABLE council_run_ledger (
        council_run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, group_folder TEXT, task_family TEXT NOT NULL,
        channel TEXT, requested_mode TEXT, chosen_mode TEXT NOT NULL,
        calibration_reason TEXT NOT NULL, calibration_changed INTEGER NOT NULL,
        protected_mode INTEGER NOT NULL, status TEXT NOT NULL,
        final_status TEXT NOT NULL, recommended_action TEXT NOT NULL,
        confidence REAL NOT NULL, evidence_grade TEXT NOT NULL,
        approval_need TEXT NOT NULL, member_statuses_json TEXT NOT NULL,
        provider_failures_json TEXT NOT NULL, schema_status_json TEXT NOT NULL,
        evidence_scorecard_json TEXT NOT NULL, confidence_math_json TEXT NOT NULL,
        budget_json TEXT NOT NULL, replay_summary TEXT NOT NULL,
        risk_flags_json TEXT NOT NULL, outcome_signal_count INTEGER NOT NULL,
        latest_outcome_at TEXT, outcome_status TEXT
      );
      INSERT INTO council_run_ledger VALUES (
        'legacy-run', '2026-01-01', '2026-01-01', NULL, 'assistant', NULL,
        'dual_review', 'dual_review', 'legacy', 0, 0, 'completed', 'warn',
        'answer', 0.5, 'weak', 'none', '[]', '[]', '{}', '{}', '{}', '{}',
        'legacy replay', '[]', 0, NULL, NULL
      );
      `);
      legacy.close();
      _initTestDatabaseAtPath(dbPath);
      expect(listCouncilRunLedger({ limit: 1 })[0]?.runOrigin).toBe('replay');
    } finally {
      try {
        _closeDatabase();
      } catch {
        // The migration may fail before the disposable database opens.
      }
      fs.rmSync(dir, { recursive: true, force: true });
      _initTestDatabase();
    }
  });

  it('promotes weak histories but protects explicit deep routes from downshift', () => {
    for (const id of ['a', 'b']) {
      recordCouncilRunLedger({
        councilRunId: `council-low-${id}`,
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
        chosenMode: 'dual_review',
        calibration: calibrateCouncilMode({
          taskFamily: 'assistant',
          requestedMode: 'dual_review',
        }),
        structuredVerdict: verdict({
          confidence: 0.32,
          status: 'block',
          schemaStatusSummary: {
            valid: 0,
            repaired: 0,
            invalid_fallback: 1,
          },
        }),
      });
    }

    expect(
      calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
    ).toMatchObject({
      chosenMode: 'max_iq_council',
      changedMode: true,
    });
    expect(
      calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'repair_council',
        allowedSideEffects: 'approval_required',
      }),
    ).toMatchObject({
      chosenMode: 'repair_council',
      protectedMode: true,
      changedMode: false,
    });
  });

  it('builds a redacted doctor report with actionable next steps', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-doctor',
      taskFamily: 'assistant',
      requestedMode: 'dual_review',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'assistant',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({
        confidence: 0.41,
        replaySummary: 'Bad provider token=sk-proj-abcdefghijklmnopqrstuvwx',
      }),
      providerFailures: ['provider token=sk-proj-abcdefghijklmnopqrstuvwx'],
    });

    const report = buildCouncilDoctorReport('2026-06-04T10:02:00.000Z', {
      providerHealth: healthyCoreProviders,
    });
    const formatted = formatCouncilDoctorReport(report);

    expect(report.ok).toBe(false);
    expect(report.nextAction).toContain('test:council:tasks');
    expect(formatted).toContain('Current providers:');
    expect(formatted).toContain('openai_cloud=healthy');
    expect(formatted).toContain('Historical degraded providers:');
    expect(JSON.stringify(report)).not.toContain('sk-proj-');
    expect(formatted).toContain('Council Status');
    expect(formatted).not.toContain('sk-proj-');
  });

  it('treats historical provider degradation as stale when current providers are healthy', () => {
    for (const id of ['a', 'b', 'c']) {
      recordCouncilRunLedger({
        councilRunId: `council-historical-provider-${id}`,
        taskFamily: 'operator',
        requestedMode: 'max_iq_council',
        chosenMode: 'max_iq_council',
        calibration: calibrateCouncilMode({
          taskFamily: 'operator',
          requestedMode: 'max_iq_council',
        }),
        structuredVerdict: verdict({
          replayArtifact: {
            replaySummary: 'Historical provider participation degraded.',
            memberStatuses: [
              {
                memberId: 'anthropic_cloud',
                providerId: 'anthropic_cloud',
                role: 'synthesizer',
                status: 'skipped',
                verdict: 'inconclusive',
                confidence: 0,
                schemaStatus: 'invalid_fallback',
                schemaIssues: ['transport unavailable'],
                evidenceIds: ['intent:test'],
                riskFlags: ['anthropic_cloud_transport_error'],
              },
            ],
          },
          replaySummary: 'Historical provider participation degraded.',
        }),
        providerFailures: ['anthropic_cloud_transport_error'],
      });
    }

    const report = buildCouncilDoctorReport('2026-06-04T10:02:00.000Z', {
      providerHealth: healthyCoreProviders,
    });
    const formatted = formatCouncilDoctorReport(report);

    expect(
      report.providerReliability.some((provider) => provider.degraded),
    ).toBe(true);
    expect(report.nextAction).toContain('Providers are currently healthy');
    expect(report.providerParticipation?.nextAction).toContain(
      'providers are currently healthy',
    );
    expect(formatted).toContain('Historical degraded providers:');
    expect(formatted).not.toContain('Repair required provider health');
  });

  it('formats a redacted replay report without raw prompts or secret values', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-replay-secret',
      taskFamily: 'operator',
      requestedMode: 'dual_review',
      chosenMode: 'dual_review',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'dual_review',
      }),
      structuredVerdict: verdict({
        confidence: 0.66,
        evidenceScorecard: {
          requiredGrade: 'strong',
          availableGrade: 'partial',
          freshnessCoverage: {
            total: 1,
            fresh: 1,
            stale: 0,
            unknown: 0,
            notApplicable: 0,
          },
          sourceCoverage: { provider_health: 1 },
          privateContentPolicy: 'metadata_only',
          gapCount: 1,
          gapIds: ['integration_alexa_manual_action_required'],
          sourceClasses: ['provider_health'],
          confidencePenalty: 0.1,
        },
        replaySummary:
          'Council replay mentions token=sk-proj-abcdefghijklmnopqrstuvwx but stores metadata only.',
      }),
      providerFailures: ['provider token=sk-proj-abcdefghijklmnopqrstuvwx'],
      riskFlags: ['raw_prompt_not_stored'],
    });

    const report = buildCouncilReplayReport(
      '2026-06-04T10:02:00.000Z',
      'council-replay-secret',
    );
    const formatted = formatCouncilReplayReport(report);

    expect(formatted).toContain('Council Replay');
    expect(formatted).toContain('Members:');
    expect(formatted).toContain('integration_alexa_manual_action_required');
    expect(formatted).not.toContain('sk-proj-');
    expect(JSON.stringify(report)).not.toContain('sk-proj-');
    expect(report.privacy.rawPromptsStored).toBe(false);
    expect(report.privacy.rawPrivateBodiesStored).toBe(false);
  });

  it('surfaces provider participation skips and verifier substitutions in doctor output', () => {
    recordCouncilRunLedger({
      councilRunId: 'council-provider-participation',
      taskFamily: 'operator',
      requestedMode: 'max_iq_council',
      chosenMode: 'max_iq_council',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'max_iq_council',
      }),
      structuredVerdict: verdict({
        replayArtifact: {
          replaySummary:
            'Verdict=warn confidence=0.70 Provider participation degraded.',
          memberStatuses: [
            {
              memberId: 'openai_cloud',
              providerId: 'openai_cloud',
              role: 'planner',
              status: 'completed',
              verdict: 'pass',
              confidence: 0.82,
              schemaStatus: 'valid',
              schemaIssues: [],
              evidenceIds: ['intent:test'],
              riskFlags: [],
            },
            {
              memberId: 'minimax_cloud',
              providerId: 'minimax_cloud',
              role: 'critic',
              status: 'skipped',
              verdict: 'inconclusive',
              confidence: 0,
              schemaStatus: 'invalid_fallback',
              schemaIssues: ['provider unavailable'],
              evidenceIds: ['intent:test'],
              riskFlags: ['minimax_cloud_quota_or_rate_limit'],
            },
            {
              memberId: 'gemini_cloud',
              providerId: 'gemini_cloud',
              role: 'verifier',
              status: 'blocked',
              verdict: 'inconclusive',
              confidence: 0,
              schemaStatus: 'invalid_fallback',
              schemaIssues: ['provider unavailable'],
              evidenceIds: ['intent:test'],
              riskFlags: ['gemini_cloud_quota_or_rate_limit'],
            },
            {
              memberId: 'openai_verifier_fallback',
              providerId: 'openai_cloud',
              role: 'verifier',
              status: 'completed',
              verdict: 'warn',
              confidence: 0.7,
              schemaStatus: 'valid',
              schemaIssues: [],
              evidenceIds: ['intent:test'],
              riskFlags: [
                'verifier_substituted_openai_for_gemini',
                'provider_independence_reduced',
              ],
            },
          ],
        },
        replaySummary:
          'Verdict=warn confidence=0.70 Provider participation degraded.',
      }),
      providerFailures: [
        'minimax_cloud_quota_or_rate_limit',
        'gemini_cloud_quota_or_rate_limit',
        'verifier_substituted_openai_for_gemini',
      ],
    });

    const report = buildCouncilDoctorReport('2026-06-04T10:03:00.000Z');
    const formatted = formatCouncilDoctorReport(report);

    expect(report.providerParticipation).toMatchObject({
      status: 'degraded',
      skippedProviderIds: expect.arrayContaining([
        'gemini_cloud',
        'minimax_cloud',
      ]),
      substitutedRoles: ['verifier:gemini_cloud->openai_cloud'],
    });
    expect(formatted).toContain('Provider participation: degraded');
    expect(formatted).toContain('verifier:gemini_cloud->openai_cloud');
    expect(report.degradationClasses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'provider_failure', runs: 1 }),
        expect.objectContaining({ kind: 'substitution', runs: 1 }),
      ]),
    );
    expect(formatted).toContain('Degradation classes:');
    expect(JSON.stringify(report)).not.toContain('sk-proj-');
  });

  it('classifies a platform record fallback without treating healthy providers as unknown', () => {
    recordCouncilRunLedger({
      councilRunId: 'local-council:record-fallback',
      taskFamily: 'operator',
      requestedMode: 'max_iq_council',
      chosenMode: 'max_iq_council',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'max_iq_council',
      }),
      structuredVerdict: verdict({
        evidenceScorecard: {
          requiredGrade: 'partial',
          availableGrade: 'partial',
          freshnessCoverage: {
            total: 1,
            fresh: 1,
            stale: 0,
            unknown: 0,
            notApplicable: 0,
          },
          sourceCoverage: { provider_health: 1 },
          privateContentPolicy: 'metadata_only',
          gapCount: 1,
          gapIds: ['provider_openai_cloud_unknown'],
          sourceClasses: ['provider_health'],
          confidencePenalty: 0.05,
        },
      }),
      riskFlags: ['platform_council_record_local_fallback'],
    });

    const report = buildCouncilDoctorReport('2026-06-04T10:03:00.000Z', {
      providerHealth: healthyCoreProviders,
      platformCoordinatorExpected: true,
    });
    expect(report.degradationClasses).toContainEqual({
      kind: 'local_fallback',
      runs: 1,
    });
    expect(report.evidenceGaps).not.toContain('provider_openai_cloud_unknown');
    expect(report.resolvedEvidenceGaps).toContain(
      'provider_openai_cloud_unknown',
    );
    expect(report.nextAction).toContain('platform council record handoff');
  });

  it('treats intentional local runtime recording as healthy rather than fallback degradation', () => {
    recordCouncilRunLedger({
      councilRunId: 'local-council:intentional-local-runtime',
      taskFamily: 'operator',
      requestedMode: 'max_iq_council',
      chosenMode: 'max_iq_council',
      calibration: calibrateCouncilMode({
        taskFamily: 'operator',
        requestedMode: 'max_iq_council',
      }),
      structuredVerdict: verdict(),
      riskFlags: ['platform_council_record_local_runtime'],
    });

    const report = buildCouncilDoctorReport('2026-06-04T10:03:00.000Z', {
      providerHealth: healthyCoreProviders,
      platformCoordinatorExpected: false,
    });
    expect(report.platformRecordMode).toBe('local_runtime');
    expect(report.degradationClasses).not.toContainEqual(
      expect.objectContaining({ kind: 'local_fallback' }),
    );
    expect(report.nextAction).not.toContain('platform council record handoff');
  });

  it('uses recent live provider evidence without rewriting degraded run history', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'council-provider-health-'),
    );
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousDisableEnv =
      process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE = '1';

    try {
      writeProviderLiveHealthState(
        [
          {
            ...providerHealth('openai_cloud'),
            metadata: {
              healthEvidence: 'live_probe',
              liveProbe: 'ok',
              liveModel: 'gpt-test',
            },
          },
        ],
        '2026-07-12T08:00:00.000Z',
        projectRoot,
      );
      recordCouncilRunLedger({
        councilRunId: 'council-cached-provider-health',
        taskFamily: 'operator',
        requestedMode: 'dual_review',
        chosenMode: 'dual_review',
        calibration: calibrateCouncilMode({
          taskFamily: 'operator',
          requestedMode: 'dual_review',
        }),
        structuredVerdict: verdict({
          replayArtifact: {
            replaySummary: 'Verdict=warn with degraded participation.',
            memberStatuses: [
              {
                memberId: 'openai_cloud',
                providerId: 'openai_cloud',
                role: 'planner',
                status: 'completed',
                verdict: 'warn',
                confidence: 0.7,
                schemaStatus: 'valid',
                schemaIssues: [],
                evidenceIds: ['intent:test'],
                riskFlags: [],
              },
              {
                memberId: 'gemini_cloud',
                providerId: 'gemini_cloud',
                role: 'verifier',
                status: 'blocked',
                verdict: 'inconclusive',
                confidence: 0,
                schemaStatus: 'invalid_fallback',
                schemaIssues: ['provider unavailable'],
                evidenceIds: ['intent:test'],
                riskFlags: ['gemini_cloud_unavailable'],
              },
            ],
          },
        }),
        providerFailures: ['gemini_cloud_unavailable'],
        now: '2026-07-12T08:01:00.000Z',
      });

      const report = buildCouncilDoctorReport('2026-07-12T08:05:00.000Z', {
        projectRoot,
      });

      expect(report.currentProviderHealth).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            providerId: 'openai_cloud',
            state: 'healthy',
            failureClass: 'none',
          }),
        ]),
      );
      expect(report.providerParticipation).toMatchObject({
        status: 'degraded',
        skippedProviderIds: ['gemini_cloud'],
      });
      expect(report.recent.degradedRuns).toBe(1);
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousDisableEnv === undefined) {
        delete process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE;
      } else {
        process.env.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE = previousDisableEnv;
      }
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
