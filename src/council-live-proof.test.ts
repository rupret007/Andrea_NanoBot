import { describe, expect, it } from 'vitest';

import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import {
  assessCouncilLiveProof,
  buildCouncilLiveProofCostReservation,
  resolveCouncilLiveProofConfig,
  runRecordedCouncilLiveProof,
} from './council-live-proof.js';

function validResult(): AndreaPlatformProviderCouncilResult {
  const members = ['planner', 'critic', 'verifier'].map((role, index) => ({
    memberId: `${role}-${index}`,
    providerId: ['openai_cloud', 'minimax_cloud', 'gemini_cloud'][index]!,
    role,
    status: 'completed',
    verdict: 'pass',
    confidence: 0.8,
    schemaStatus: 'valid',
    schemaIssues: [],
    evidenceIds: ['intent:test'],
    riskFlags: [],
  }));
  return {
    councilRunId: 'local-council:test',
    mode: 'max_iq_council',
    status: 'local_only',
    approvalRequired: false,
    memberCount: 3,
    skippedMemberCount: 0,
    blockedMemberCount: 0,
    confidence: 0.64,
    riskFlags: ['platform_council_record_local_runtime'],
    providerFailures: [],
    answerGuidance: {
      status: 'warn',
      visibleVerdict: 'Proceed carefully with cited evidence.',
      answerDirection: 'Answer from cited evidence.',
      confidence: 0.64,
      uncertainty: 'Some uncertainty remains.',
      sourceMemberIds: members.map((member) => member.memberId),
      recommendedAction: 'answer',
      approvalNeed: 'none',
      evidenceGrade: 'partial',
      evidenceIds: ['intent:test'],
      riskFlags: [],
      actionDirectives: [
        {
          directive: 'answer_constraint',
          priority: 'low',
          reason: 'Answer from cited evidence.',
        },
        {
          directive: 'memory_learning_candidate',
          priority: 'low',
          reason: 'Retain only a sanitized confirmed lesson.',
        },
      ],
    },
    structuredVerdict: {
      status: 'warn',
      recommendedAction: 'answer',
      confidence: 0.64,
      evidenceGrade: 'partial',
      approvalNeed: 'none',
      riskFlags: [],
      evidenceIds: ['intent:test'],
      actionDirectives: [
        {
          directive: 'answer_constraint',
          priority: 'low',
          reason: 'Answer from cited evidence.',
        },
        {
          directive: 'memory_learning_candidate',
          priority: 'low',
          reason: 'Retain only a sanitized confirmed lesson.',
        },
      ],
      usableMemberCount: 3,
      blockedMemberCount: 0,
      confidenceMath: {
        base: 0.7,
        degradedParticipationPenalty: 0,
        providerFailurePenalty: 0,
        evidencePenalty: 0.06,
        verdictPenalty: 0,
        schemaPenalty: 0,
        final: 0.64,
      },
      schemaStatusSummary: { valid: 3, repaired: 0, invalid_fallback: 0 },
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
        gapCount: 0,
        gapIds: [],
        sourceClasses: ['provider_health'],
        confidencePenalty: 0.06,
      },
      budget: {
        mode: 'max_iq_council',
        maxRoles: 5,
        roleTimeoutMs: 45_000,
        maxRetries: 1,
        maxConcurrency: 2,
        fallbackAllowed: true,
        estimatedCostTier: 'high',
        usedRoles: 3,
        retryCount: 0,
        loopGuardTriggered: false,
        status: 'within_budget',
      },
      providerParticipation: {
        status: 'full',
        generatedAt: '2026-07-12T22:00:00.000Z',
        skippedProviderIds: [],
        substitutedRoles: [],
        riskFlags: [],
        nextAction: '',
        roles: members.map((member) => ({
          role: member.role,
          providerId: member.providerId,
          memberId: member.memberId,
          required: true,
          action: 'call',
          substituteProviderId: null,
          reason: 'Healthy configured provider.',
          riskFlag: '',
          healthState: 'healthy',
          failureClass: 'none',
        })),
      },
      replayArtifact: {
        replaySummary: 'Bounded proof.',
        memberStatuses: members,
      },
      ultrathinkTrace: {
        requested: true,
        trigger: 'ultrathink',
        mode: 'max_iq_council',
        adaptiveThinkingRequested: true,
        adaptiveThinkingSupported: true,
        display: 'omitted',
        rawThinkingStored: false,
        hiddenReasoningExposed: false,
      },
      quality: {
        ledgerVersion: 'v3',
        retention: '90d_or_1000_runs',
        rawPromptsStored: false,
        rawPrivateBodiesStored: false,
        outcomeSignalCount: 0,
      },
    },
  };
}

describe('estimate-only live council structural proof', () => {
  it('fails closed before execution without opt-in, budget, or a valid group', () => {
    expect(() => resolveCouncilLiveProofConfig([])).toThrow('--live');
    expect(() =>
      resolveCouncilLiveProofConfig(['--live', '--max-cost-usd=0.50']),
    ).toThrow('fixed estimate reservation');
    expect(() =>
      resolveCouncilLiveProofConfig([
        '--live',
        '--max-cost-usd=1',
        '--group=../../other',
      ]),
    ).toThrow('Invalid group folder');
    expect(() =>
      resolveCouncilLiveProofConfig(['--live', '--max-cost-usd=1']),
    ).toThrow('cannot enforce a provider billing cap');
  });

  it('accepts full verified participation in intentional local runtime mode', () => {
    expect(assessCouncilLiveProof(validResult())).toMatchObject({
      passed: true,
      terminal: 'completed',
      completedVerifier: true,
      providerProvenanceComplete: true,
      participationFull: true,
      evidenceSufficient: true,
      confidenceCalibrated: true,
      inputStructureValid: true,
      schemaConsistent: true,
      memberCountsConsistent: true,
      answerGuidanceConsistent: true,
      participationRolesClean: true,
      modeValid: true,
      verdictUsable: true,
      approvalBoundaryClean: true,
      privacyBoundaryClean: true,
      budgetValid: true,
      riskStateClean: true,
      platformRecordFallback: false,
      platformRecordLocalRuntime: true,
      evidenceGapIds: [],
      reasons: [],
    });
  });

  it('records the estimate reservation separately from recorded cost estimates', () => {
    const config = resolveCouncilLiveProofConfig([
      '--live',
      '--max-cost-usd=1',
      '--ack-estimate-only',
    ]);

    expect(
      buildCouncilLiveProofCostReservation({
        config,
        councilRunId: 'local-council:cost-proof',
        outcome: 'structural_pass',
        latencyMs: 1234,
      }),
    ).toEqual({
      kind: 'live_eval_cost_reservation',
      value: 0.75,
      metadata: {
        metricClass: 'live_evaluation',
        surface: 'budgeted_live_council',
        councilRunId: 'local-council:cost-proof',
        outcome: 'structural_pass',
        estimatedCostThresholdUsd: 1,
        estimatedCostReservationUsd: 0.75,
        actualCostKnown: false,
        actualBillingCapEnforced: false,
        acceptanceEligible: false,
        costControlStatus: 'estimate_only_proof_debt',
        costControlProofDebt:
          'provider_runner_has_no_pre_call_billing_cap_or_complete_reconciled_usage',
        costAccountingClass: 'fixed_estimate_reservation',
        latencyMs: 1234,
      },
    });
  });

  it('records a terminal result after the pre-call reservation', async () => {
    const config = resolveCouncilLiveProofConfig([
      '--live',
      '--max-cost-usd=1',
      '--ack-estimate-only',
    ]);
    const records: Array<{ outcome: unknown; failureClass?: unknown }> = [];
    const times = [100, 250];
    const proof = await runRecordedCouncilLiveProof({
      config,
      correlationId: 'live-proof-success',
      execute: async () => validResult(),
      record: (reservation) => {
        records.push({
          outcome: reservation.metadata.outcome,
          failureClass: reservation.metadata.failureClass,
        });
      },
      nowMs: () => times.shift() as number,
    });

    expect(proof).toMatchObject({
      latencyMs: 150,
      assessment: { passed: true, terminal: 'completed' },
    });
    expect(records).toEqual([
      { outcome: 'reserved', failureClass: undefined },
      { outcome: 'structural_pass', failureClass: undefined },
    ]);
  });

  it('replaces an interrupted reservation with a sanitized blocked result', async () => {
    const config = resolveCouncilLiveProofConfig([
      '--live',
      '--max-cost-usd=1',
      '--ack-estimate-only',
    ]);
    const records: Array<Record<string, unknown>> = [];
    const times = [1_000, 1_125];
    const execution = runRecordedCouncilLiveProof({
      config,
      correlationId: 'live-proof-failure',
      execute: async () => {
        throw new TypeError('provider secret sk-test-must-not-escape');
      },
      record: (reservation) => records.push(reservation.metadata),
      nowMs: () => times.shift() as number,
    });

    await expect(execution).rejects.toThrow(
      'Council live proof failed (TypeError).',
    );
    expect(JSON.stringify(records)).not.toContain('sk-test-must-not-escape');
    expect(records).toEqual([
      expect.objectContaining({ outcome: 'reserved' }),
      expect.objectContaining({
        outcome: 'blocked',
        failureClass: 'TypeError',
        latencyMs: 125,
      }),
    ]);
  });

  it('does not make a live call when the pre-call reservation cannot be stored', async () => {
    const config = resolveCouncilLiveProofConfig([
      '--live',
      '--max-cost-usd=1',
      '--ack-estimate-only',
    ]);
    let executed = false;
    await expect(
      runRecordedCouncilLiveProof({
        config,
        correlationId: 'live-proof-no-reservation',
        execute: async () => {
          executed = true;
          return validResult();
        },
        record: () => {
          throw new Error('database path /private/secret must not escape');
        },
      }),
    ).rejects.toThrow(
      'Council live proof could not reserve diagnostic evidence (Error).',
    );
    expect(executed).toBe(false);
  });

  it('allowlists diagnostic error classes instead of persisting a secret-bearing name', async () => {
    const config = resolveCouncilLiveProofConfig([
      '--live',
      '--max-cost-usd=1',
      '--ack-estimate-only',
    ]);
    const records: Array<Record<string, unknown>> = [];
    const secretNamedError = new Error('safe message');
    secretNamedError.name = 'sk-live-secret-must-not-escape';
    const execution = runRecordedCouncilLiveProof({
      config,
      correlationId: 'live-proof-secret-name',
      execute: async () => {
        throw secretNamedError;
      },
      record: (reservation) => records.push(reservation.metadata),
    });

    await expect(execution).rejects.toThrow(
      'Council live proof failed (unknown_error).',
    );
    expect(JSON.stringify(records)).not.toContain('sk-live-secret');
    expect(records.at(-1)).toEqual(
      expect.objectContaining({
        outcome: 'blocked',
        failureClass: 'unknown_error',
      }),
    );
  });

  it.each([
    [
      'wrong council mode',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.mode = 'dual_review';
      },
      'council_mode_invalid',
    ],
    [
      'contradictory blocking verdict',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.status = 'block';
      },
      'verdict_not_usable',
    ],
    [
      'fresh approval required',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.approvalRequired = true;
        result.structuredVerdict!.approvalNeed = 'explicit';
      },
      'approval_boundary_not_clean',
    ],
    [
      'privacy policy violation',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.evidenceScorecard!.privateContentPolicy =
          'sanitized_snippets';
      },
      'privacy_boundary_not_clean',
    ],
    [
      'unknown evidence grades',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.evidenceScorecard!.requiredGrade = 'unknown';
        result.structuredVerdict!.evidenceScorecard!.availableGrade = 'unknown';
      },
      'evidence_insufficient',
    ],
    [
      'empty participation provenance',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.providerParticipation!.roles = [];
      },
      'provider_participation_degraded',
    ],
    [
      'triggered budget loop guard',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.budget!.loopGuardTriggered = true;
      },
      'run_budget_not_clean',
    ],
    [
      'unsafe action directive',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.actionDirectives = [
          {
            directive: 'require_approval',
            priority: 'high',
            reason: 'Approval is required.',
          },
        ];
      },
      'verdict_not_usable',
    ],
    [
      'malformed participation arrays',
      (result: AndreaPlatformProviderCouncilResult) => {
        const participation = result.structuredVerdict!
          .providerParticipation as unknown as Record<string, unknown>;
        participation.skippedProviderIds = undefined;
      },
      'proof_shape_invalid',
    ],
    [
      'unknown member schema status',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.replayArtifact!.memberStatuses[0]!.schemaStatus =
          'garbage';
      },
      'proof_shape_invalid',
    ],
    [
      'impossible schema summary counts',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.schemaStatusSummary = {
          valid: -1,
          repaired: 999,
          invalid_fallback: 0,
        };
      },
      'schema_summary_inconsistent',
    ],
    [
      'contradictory usable and blocked member counts',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.usableMemberCount = 0;
        result.structuredVerdict!.blockedMemberCount = 2;
      },
      'member_counts_inconsistent',
    ],
    [
      'degraded participation role health',
      (result: AndreaPlatformProviderCouncilResult) => {
        const role = result.structuredVerdict!.providerParticipation!.roles[0]!;
        role.healthState = 'degraded';
        role.failureClass = 'auth_failure';
      },
      'participation_role_state_unclean',
    ],
    [
      'required planner mislabeled optional',
      (result: AndreaPlatformProviderCouncilResult) => {
        const planner =
          result.structuredVerdict!.providerParticipation!.roles.find(
            (role) => role.role === 'planner',
          )!;
        planner.required = false;
      },
      'participation_role_state_unclean',
    ],
    [
      'answer guidance requests approval against the verdict',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.answerGuidance!.approvalNeed = 'explicit';
      },
      'answer_guidance_inconsistent',
    ],
    [
      'unexpected council risk flag',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.riskFlags = ['provider_output_untrusted'];
      },
      'risk_state_not_clean',
    ],
    [
      'blocking verifier verdict',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.replayArtifact!.memberStatuses[2]!.verdict =
          'block';
      },
      'completed_verifier_missing',
    ],
    [
      'verifier without evidence',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.replayArtifact!.memberStatuses[2]!.evidenceIds =
          [];
      },
      'completed_verifier_missing',
    ],
    [
      'blocked verifier',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.replayArtifact!.memberStatuses[2]!.status =
          'blocked';
      },
      'completed_verifier_missing',
    ],
    [
      'skipped verifier',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.replayArtifact!.memberStatuses[2]!.status =
          'skipped';
      },
      'completed_verifier_missing',
    ],
    [
      'provider failure',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.providerFailures = ['minimax_cloud_transport_error'];
      },
      'provider_failure',
    ],
    [
      'substitution',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.providerParticipation!.status = 'degraded';
        result.structuredVerdict!.providerParticipation!.substitutedRoles = [
          'verifier:gemini_cloud->openai_cloud',
        ];
      },
      'provider_participation_degraded',
    ],
    [
      'platform fallback',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.riskFlags = ['platform_council_record_local_fallback'];
      },
      'platform_record_fallback',
    ],
    [
      'provider evidence gap',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.evidenceScorecard!.gapIds = [
          'provider_openai_cloud_unknown',
        ];
      },
      'evidence_insufficient',
    ],
    [
      'non-provider evidence gap',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.evidenceScorecard!.gapCount = 1;
        result.structuredVerdict!.evidenceScorecard!.gapIds = [
          'integration_calendar_stale',
        ];
      },
      'evidence_gaps_present',
    ],
    [
      'invalid calibration',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.confidenceMath!.final = 0.51;
      },
      'confidence_uncalibrated',
    ],
    [
      'internally inconsistent confidence math',
      (result: AndreaPlatformProviderCouncilResult) => {
        result.structuredVerdict!.confidenceMath!.base = 0.9;
      },
      'confidence_uncalibrated',
    ],
  ])('rejects %s', (_label, mutate, reason) => {
    const result = validResult();
    mutate(result);
    const assessment = assessCouncilLiveProof(result);
    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(reason);
  });
});
