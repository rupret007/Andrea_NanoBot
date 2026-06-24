import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
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
  getCouncilRunLedger,
  listCouncilOutcomeSignals,
} from './db.js';
import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import type { ProviderHealthSnapshot } from './provider-health.js';

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
          'Verdict mentions jeff@example.com and +14695405551 but not raw prompts.',
      }),
      providerFailures: ['token=sk-proj-abcdefghijklmnopqrstuvwx'],
      riskFlags: ['phone +14695405551'],
      now: '2026-06-04T10:00:00.000Z',
    });

    const stored = getCouncilRunLedger('council-secret');

    expect(stored?.providerFailuresJson).not.toContain('sk-proj-');
    expect(stored?.riskFlagsJson).not.toContain('+14695405551');
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
    expect(report.nextAction).toContain('test:council:medium');
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
    expect(JSON.stringify(report)).not.toContain('sk-proj-');
  });
});
