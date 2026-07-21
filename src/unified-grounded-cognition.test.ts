import { describe, expect, it } from 'vitest';

import {
  arbitrateUnifiedEvidence,
  attachUnifiedGroundedDecision,
  attachUnifiedResponseContract,
  attachUnifiedResponseEvaluation,
  buildUnifiedGroundedCognitiveFrame,
  observeUnifiedOutcome,
  projectUnifiedEvidenceToGroundedExecutive,
  resolveUnifiedGroundedCognitionMode,
  unifiedGroundedCognitionDiagnostics,
  unifiedLearningAsGroundedRecords,
  unifiedPersistedMetadata,
  validateUnifiedCognitionModes,
  type UnifiedEvidenceReference,
} from './unified-grounded-cognition.js';
import { buildGroundedDeliberationPacket } from './grounded-response-intelligence.js';
import type { GroundedContextBundle } from './grounded-memory.js';

const NOW = '2026-07-21T18:00:00.000Z';

function bundle(
  overrides: Partial<GroundedContextBundle> = {},
): GroundedContextBundle {
  return {
    bundleId: 'bundle:test',
    generatedAt: NOW,
    topics: ['test'],
    items: [],
    goals: [],
    terminalGoals: [],
    contradictions: [],
    uncertainties: [],
    excluded: [],
    budget: {
      maxItems: 10,
      maxChars: 5_000,
      usedChars: 0,
      truncated: false,
    },
    retrievalReasoning: [],
    ...overrides,
  };
}

function frame(
  overrides: Partial<
    Parameters<typeof buildUnifiedGroundedCognitiveFrame>[0]
  > = {},
) {
  return buildUnifiedGroundedCognitiveFrame({
    turnId: 'turn-1',
    conversationId: 'chat-1',
    channel: 'telegram',
    actorId: 'owner',
    groupFolder: 'main',
    text: 'Explain the current plan.',
    now: NOW,
    runOrigin: 'synthetic',
    taskFamily: 'general',
    mode: 'shadow',
    memoryBundle: bundle(),
    ...overrides,
  });
}

function evidence(
  id: string,
  overrides: Partial<UnifiedEvidenceReference> = {},
): UnifiedEvidenceReference {
  return {
    evidenceId: id,
    sourceClass: 'accepted_durable_memory',
    sourceRecordId: id,
    subject: 'preference:reply_style',
    scope: {
      actorId: 'owner',
      chatId: 'chat-1',
      groupFolder: 'main',
      channel: 'telegram',
    },
    claim: 'The owner prefers concise replies.',
    value: 'concise',
    epistemicStatus: 'accepted',
    confidence: 0.8,
    observedAt: NOW,
    expiresAt: null,
    freshness: 'fresh',
    provenanceRefs: [id],
    contradictsEvidenceIds: [],
    supersedesEvidenceIds: [],
    sensitivity: 'personal',
    mayStateToUser: true,
    mayInfluencePlanning: true,
    whatWouldChangeIt: 'A direct correction.',
    ...overrides,
  };
}

describe('unified grounded cognition', () => {
  it('defaults to shadow and preserves the legacy mode only when unified is absent', () => {
    expect(resolveUnifiedGroundedCognitionMode({})).toBe('shadow');
    expect(
      resolveUnifiedGroundedCognitionMode({
        GROUNDED_ADVISORY_MODE: 'assistive',
      }),
    ).toBe('assistive');
    expect(
      resolveUnifiedGroundedCognitionMode({
        UNIFIED_GROUNDED_COGNITION_MODE: 'shadow',
        GROUNDED_ADVISORY_MODE: 'assistive',
      }),
    ).toBe('shadow');
  });

  it('rejects a legacy assistive mode that exceeds explicit unified shadow mode', () => {
    expect(
      validateUnifiedCognitionModes({
        unifiedMode: 'shadow',
        groundedAdvisoryMode: 'assistive',
      }),
    ).toMatchObject({ valid: false, effectiveAdvisoryMode: 'shadow' });
  });

  it('keeps direct current evidence above older memory', () => {
    const result = arbitrateUnifiedEvidence(
      [
        evidence('old'),
        evidence('current', {
          sourceClass: 'current_user_statement',
          sourceRecordId: 'turn-1',
          claim: 'I now prefer detailed replies.',
          value: 'detailed',
          epistemicStatus: 'direct',
          confidence: 1,
          observedAt: '2026-07-21T18:01:00.000Z',
        }),
      ],
      {
        now: NOW,
        scope: evidence('scope').scope,
      },
    );
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.evidenceId).toBe('current');
    expect(result.arbitrations).toContainEqual(
      expect.objectContaining({
        outcome: 'superseded',
        acceptedEvidenceId: 'current',
      }),
    );
  });

  it('surfaces equal-authority contradictions instead of choosing one', () => {
    const result = arbitrateUnifiedEvidence(
      [
        evidence('left', {
          sourceClass: 'recent_direct_observation',
          epistemicStatus: 'observed',
          value: 'complete',
          contradictsEvidenceIds: ['right'],
        }),
        evidence('right', {
          sourceClass: 'recent_direct_observation',
          epistemicStatus: 'observed',
          value: 'failed',
          contradictsEvidenceIds: ['left'],
        }),
      ],
      { now: NOW, scope: evidence('scope').scope },
    );
    expect(result.evidence).toHaveLength(0);
    expect(
      result.arbitrations.filter((item) => item.outcome === 'contradicted'),
    ).toHaveLength(2);
  });

  it('excludes secret, cross-scope, stale, and assumed evidence with reasons', () => {
    const result = arbitrateUnifiedEvidence(
      [
        evidence('secret', { sensitivity: 'secret' }),
        evidence('scope', {
          scope: { ...evidence('x').scope, actorId: 'someone-else' },
        }),
        evidence('stale', { freshness: 'stale' }),
        evidence('assumed', {
          sourceClass: 'unresolved_assumption',
          epistemicStatus: 'assumed',
        }),
      ],
      { now: NOW, scope: evidence('expected').scope },
    );
    expect(result.evidence).toHaveLength(0);
    expect(result.arbitrations.map((item) => item.outcome)).toEqual(
      expect.arrayContaining([
        'privacy_excluded',
        'scope_excluded',
        'stale',
        'insufficient_evidence',
      ]),
    );
  });

  it('builds one bounded frame with clauses, goals, terminal history, and no authority', () => {
    const built = frame({
      text: 'Check my calendar and send Sam the result.',
      approvalRequired: true,
      memoryBundle: bundle({
        goals: [
          {
            goalId: 'goal-active',
            title: 'Prepare the review',
            state: 'active',
            blockers: [],
            nextProposedStep: 'Read the latest notes.',
            inclusionReason: 'active',
          },
        ],
        terminalGoals: [
          {
            goalId: 'goal-cancelled',
            title: 'Old review',
            state: 'cancelled',
            blockers: [],
            nextProposedStep: 'Send the old review.',
            inclusionReason: 'terminal',
          },
        ],
      }),
    });
    expect(built.intents).toHaveLength(2);
    expect(built.goals.map((goal) => goal.state)).toEqual([
      'active',
      'cancelled',
    ]);
    expect(built.goals[1]?.nextAction).toBeNull();
    expect(built.chosenPosture).toBe('request_approval');
    expect(built.invariants).toMatchObject({
      executionAuthority: false,
      approvalAuthority: false,
      deliveryAuthority: false,
      learningPromotionAuthority: false,
    });
    expect(built.budgets.contextChars).toBeLessThanOrEqual(
      built.budgets.contextCharLimit,
    );
  });

  it('derives the response packet from the canonical frame', () => {
    const built = frame({ text: 'Research lunch and schedule a meeting.' });
    const packet = buildGroundedDeliberationPacket({
      turnId: built.turnId,
      text: built.originalRequest,
      now: NOW,
      unifiedFrame: built,
    });
    expect(packet.intents).toEqual(built.intents);
    expect(packet.selectedEvidence.map((item) => item.ref)).toEqual(
      built.evidence.map((item) => item.evidenceId),
    );
    expect(packet.executionAuthority).toBe(false);
  });

  it('links grounded decisions and response contracts without granting authority', () => {
    const built = frame();
    const decided = attachUnifiedGroundedDecision(
      built,
      'state-1',
      {
        decisionId: 'decision-1',
        createdAt: NOW,
        kind: 'research',
        confidence: 0.88,
        reason: 'Current evidence is stale.',
        whatWouldChangeMind: ['A fresh observation.'],
        targetNodeId: null,
        question: null,
        researchTarget: 'current state',
        candidateScores: [],
        authorityNote: 'No execution authority.',
      },
      NOW,
    );
    const packet = buildGroundedDeliberationPacket({
      turnId: built.turnId,
      text: built.originalRequest,
      now: NOW,
      unifiedFrame: decided,
    });
    const linked = attachUnifiedResponseContract(
      decided,
      packet.packetId,
      packet.responseContract,
      NOW,
    );
    expect(linked.trace).toMatchObject({
      groundedExecutiveStateId: 'state-1',
      groundedDecisionId: 'decision-1',
      deliberationPacketId: packet.packetId,
    });
    expect(linked.invariants.executionAuthority).toBe(false);
  });

  it('records material module disagreement and lets safety advice dominate', () => {
    const built = frame({
      moduleRecommendations: [
        {
          module: 'platform_deliberation',
          posture: 'answer_directly',
          confidence: 0.8,
          reason: 'A direct response appears possible.',
          evidenceRefs: [],
          advisoryOnly: true,
        },
        {
          module: 'grounded_executive',
          posture: 'stop_safely',
          confidence: 0.9,
          reason: 'A safety invariant requires stopping.',
          evidenceRefs: [],
          advisoryOnly: true,
        },
      ],
    });
    expect(built.chosenPosture).toBe('stop_safely');
    expect(built.moduleDisagreements).toEqual([
      expect.objectContaining({
        modules: ['platform_deliberation', 'grounded_executive'],
        postures: ['answer_directly', 'stop_safely'],
        resolution: 'stop_safely',
      }),
    ]);
    expect(built.invariants.executionAuthority).toBe(false);
  });

  it('keeps tool and provider success separate from goal achievement', () => {
    const observed = observeUnifiedOutcome(frame(), {
      observedAt: NOW,
      routeUsed: 'calendar',
      responseStatus: 'pass',
      toolCallAccepted: true,
      toolReturnedSuccess: true,
      providerReceiptIds: ['receipt-1'],
      requestedOutcomeVerified: false,
      goalAchieved: true,
    });
    expect(observed.outcome).toMatchObject({
      toolReturnedSuccess: true,
      providerReceiptObserved: true,
      requestedOutcomeVerified: false,
      goalAchieved: false,
    });
    expect(observed.followThrough).toContain(
      'Verify the requested real-world outcome before closing the goal.',
    );
  });

  it('requires explicit requested-outcome verification before goal success', () => {
    const observed = observeUnifiedOutcome(frame(), {
      observedAt: NOW,
      routeUsed: 'calendar',
      responseStatus: 'pass',
      toolReturnedSuccess: true,
      providerReceiptIds: ['receipt-1'],
      requestedOutcomeVerified: true,
      goalAchieved: true,
      evidenceRefs: ['goal-proof-1'],
    });
    expect(observed.outcome?.goalAchieved).toBe(true);
    expect(observed.outcome?.explanation).toMatch(/explicitly verified/i);
  });

  it('creates review-only learning candidates from response failures', () => {
    const built = frame();
    const evaluated = attachUnifiedResponseEvaluation(built, {
      status: 'repair',
      score: 70,
      coveredIntentIds: [],
      missedIntentIds: [built.intents[0]!.intentId],
      preservedTargetIds: [],
      issues: [
        {
          kind: 'intent_missing',
          severity: 'repair',
          intentId: built.intents[0]!.intentId,
          detail: 'The reply omitted the requested plan.',
        },
      ],
      metrics: {
        intentCoverage: 0,
        targetPreservation: 0,
        truthfulness: 1,
        approvalCorrectness: 1,
        continuity: 1,
        repetition: 1,
        calibration: 1,
        partialFailureHonesty: 1,
        evidenceCoverage: 1,
      },
      invariantResults: {
        noExecutionAuthority: true,
        noPrivacyViolation: true,
        noUnsupportedCompletion: true,
        allOriginalClausesRetained: true,
      },
      evaluatedChars: 20,
    });
    const learned = observeUnifiedOutcome(evaluated, {
      observedAt: NOW,
      routeUsed: 'direct',
      responseStatus: 'warn',
    });
    expect(learned.learningCandidates).toHaveLength(1);
    expect(learned.learningCandidates[0]).toMatchObject({
      kind: 'intent_coverage',
      reviewRequired: true,
      promotionStatus: 'proposed',
      syntheticProductionEligible: false,
      executionAuthority: false,
    });
    expect(unifiedLearningAsGroundedRecords(learned)[0]).toMatchObject({
      status: 'proposed',
      appliesToAuthority: false,
    });
  });

  it('projects only planning-admissible evidence into the grounded executive', () => {
    const built = frame({
      additionalEvidence: [
        evidence('secret', {
          subject: 'credential:test',
          sensitivity: 'secret',
        }),
        evidence('route', {
          sourceClass: 'route_health_observation',
          subject: 'route:research',
          value: 'healthy',
          epistemicStatus: 'observed',
          sensitivity: 'low',
        }),
      ],
    });
    const projected = projectUnifiedEvidenceToGroundedExecutive(built);
    expect(
      projected.some((item) => item.evidence.evidenceId === 'secret'),
    ).toBe(false);
    expect(projected.some((item) => item.evidence.evidenceId === 'route')).toBe(
      true,
    );
  });

  it('persists bounded metadata without raw request or evidence claims', () => {
    const built = frame({
      text: 'My password=do-not-store. Explain the plan.',
    });
    const metadata = unifiedPersistedMetadata(built);
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('do-not-store');
    expect(serialized).not.toContain('Explain the plan');
    expect(serialized.length).toBeLessThanOrEqual(6_000);
  });

  it('diagnostics omit raw request text and hidden reasoning', () => {
    const built = frame({ text: 'Private body that should not be journaled.' });
    const diagnostics = unifiedGroundedCognitionDiagnostics(built);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(
      'Private body that should not be journaled',
    );
    expect(serialized).not.toContain('chain-of-thought');
    expect(serialized.length).toBeLessThanOrEqual(12_000);
  });
});
