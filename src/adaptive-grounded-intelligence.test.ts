import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_MAX_EPISODE_OBSERVATIONS,
  adaptiveGroundedIntelligenceDiagnostics,
  adaptiveObservation,
  appendAdaptiveOutcomeObservation,
  applyAdaptiveGuidanceToResponseContract,
  assessAdaptiveAssistiveReadiness,
  buildAdaptiveLearningGuidance,
  createAdaptiveCognitiveEpisode,
  generateAdaptiveLearningCandidates,
  observationFromUnifiedOutcome,
  reviewAdaptiveLearningCandidate,
  type AdaptiveLearningCandidate,
} from './adaptive-grounded-intelligence.js';
import {
  attachUnifiedResponseContract,
  attachUnifiedResponseEvaluation,
  buildUnifiedGroundedCognitiveFrame,
  observeUnifiedOutcome,
  type UnifiedGroundedCognitiveFrame,
} from './unified-grounded-cognition.js';
import type {
  GroundedResponseContract,
  GroundedResponseEvaluation,
} from './grounded-response-intelligence.js';

const NOW = '2026-07-21T18:00:00.000Z';
const LATER = '2026-07-21T18:05:00.000Z';

const CONTRACT: GroundedResponseContract = {
  requiredIntentIds: [],
  responseOrder: [],
  allowedFacts: [],
  uncertaintyDisclosures: [],
  prohibitedClaims: [],
  approvalBoundaries: [],
  usefulReadOnlyWork: [],
  nextUserDecision: null,
  maxRepairAttempts: 1,
};

const PASS_EVALUATION: GroundedResponseEvaluation = {
  status: 'pass',
  score: 100,
  coveredIntentIds: [],
  missedIntentIds: [],
  preservedTargetIds: [],
  issues: [],
  metrics: {
    intentCoverage: 1,
    targetPreservation: 1,
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
  evaluatedChars: 40,
};

function frame(
  turnId = 'turn-1',
  origin: 'live' | 'replay' | 'synthetic' = 'live',
): UnifiedGroundedCognitiveFrame {
  let built = buildUnifiedGroundedCognitiveFrame({
    turnId,
    conversationId: 'chat-1',
    channel: 'telegram',
    actorId: 'owner',
    groupFolder: 'main',
    text: 'Explain the deployment status and the remaining work.',
    now: NOW,
    runOrigin: origin,
    taskFamily: 'project_status',
    mode: 'shadow',
  });
  built = attachUnifiedResponseContract(
    built,
    `packet:${turnId}`,
    CONTRACT,
    NOW,
  );
  return attachUnifiedResponseEvaluation(built, PASS_EVALUATION, NOW);
}

function technicalSuccessFrame(): UnifiedGroundedCognitiveFrame {
  return observeUnifiedOutcome(frame(), {
    observedAt: LATER,
    routeUsed: 'repository.push',
    responseStatus: 'pass',
    toolCallAccepted: true,
    toolReturnedSuccess: true,
    providerReceiptIds: ['receipt:git'],
    requestedOutcomeVerified: false,
    goalAchieved: false,
    evidenceRefs: ['tool:push-ok'],
  });
}

function readyCandidate(): AdaptiveLearningCandidate {
  let existing: AdaptiveLearningCandidate[] = [];
  for (let index = 1; index <= 3; index += 1) {
    const currentFrame = frame(`turn-${index}`);
    let episode = createAdaptiveCognitiveEpisode(currentFrame, NOW);
    episode = appendAdaptiveOutcomeObservation(
      episode,
      adaptiveObservation({
        episodeId: episode.episodeId,
        observedAt: `2026-07-21T18:0${index}:00.000Z`,
        origin: 'live',
        source: 'owner_feedback',
        authoritative: true,
        evidenceRefs: [`owner-correction:${index}`],
        ownerCorrection: 'Preserve every requested status target.',
        summary: 'The owner explicitly corrected target preservation.',
      }),
    );
    existing = generateAdaptiveLearningCandidates({
      episode,
      frame: currentFrame,
      existingCandidates: existing,
      signals: {
        explicitOwnerCorrection: 'Preserve every requested status target.',
      },
      now: `2026-07-21T18:0${index}:30.000Z`,
    }).candidates;
  }
  const candidate = existing.find(
    (item) => item.kind === 'explicit_owner_correction',
  );
  if (!candidate) throw new Error('expected correction candidate');
  return candidate;
}

describe('adaptive grounded intelligence', () => {
  it('keeps tool, provider, requested-outcome, and goal truth separate', () => {
    const unified = technicalSuccessFrame();
    let episode = createAdaptiveCognitiveEpisode(unified, NOW);
    episode = appendAdaptiveOutcomeObservation(
      episode,
      observationFromUnifiedOutcome({
        episode,
        frame: unified,
        outcome: unified.outcome!,
      }),
    );
    expect(episode.outcome).toMatchObject({
      toolInvocationAttempted: true,
      toolTechnicallySuccessful: true,
      providerAccepted: true,
      authoritativeReceiptObserved: true,
      requestedOutcomeVerified: false,
      goalAchieved: false,
      status: 'unknown',
      toolSuccessIsGoalSuccess: false,
    });
    expect(episode.outcome.explanation).toContain('has not verified');
  });

  it('reconciles late and contradictory evidence without deleting history', () => {
    const unified = technicalSuccessFrame();
    let episode = createAdaptiveCognitiveEpisode(unified, NOW);
    const technical = observationFromUnifiedOutcome({
      episode,
      frame: unified,
      outcome: unified.outcome!,
    });
    episode = appendAdaptiveOutcomeObservation(episode, technical);
    const verified = adaptiveObservation({
      episodeId: episode.episodeId,
      observedAt: '2026-07-21T18:10:00.000Z',
      origin: 'live',
      source: 'goal_verification',
      authoritative: true,
      facts: { requestedOutcomeVerified: true, goalAchieved: true },
      evidenceRefs: ['goal:verified'],
      summary: 'The requested result and goal were verified.',
    });
    episode = appendAdaptiveOutcomeObservation(episode, verified);
    expect(episode.outcome.status).toBe('achieved');

    const contradicted = adaptiveObservation({
      episodeId: episode.episodeId,
      observedAt: '2026-07-21T18:12:00.000Z',
      origin: 'live',
      source: 'goal_verification',
      authoritative: true,
      facts: {
        requestedOutcomeVerified: false,
        goalAchieved: false,
        outcomeFailed: true,
      },
      evidenceRefs: ['goal:late-failure'],
      contradictsObservationIds: [verified.observationId],
      summary:
        'Later authoritative evidence showed the requested outcome failed.',
    });
    episode = appendAdaptiveOutcomeObservation(episode, contradicted);
    expect(episode.observations.map((item) => item.observationId)).toEqual([
      technical.observationId,
      verified.observationId,
      contradicted.observationId,
    ]);
    expect(episode.outcome).toMatchObject({
      status: 'failed',
      requestedOutcomeVerified: false,
      goalAchieved: false,
      toolTechnicallySuccessful: true,
    });
    expect(episode.outcome.contradictedObservationIds).toContain(
      verified.observationId,
    );
  });

  it('bounds episode history and retains the newest observations', () => {
    let episode = createAdaptiveCognitiveEpisode(frame(), NOW);
    for (
      let index = 0;
      index < ADAPTIVE_MAX_EPISODE_OBSERVATIONS + 10;
      index += 1
    ) {
      episode = appendAdaptiveOutcomeObservation(
        episode,
        adaptiveObservation({
          episodeId: episode.episodeId,
          observedAt: new Date(Date.parse(NOW) + index * 1000).toISOString(),
          origin: 'live',
          source: 'tool_runtime',
          facts: { toolInvocationAttempted: true },
          evidenceRefs: [`evidence:${index}`],
          summary: `bounded observation ${index}`,
        }),
      );
    }
    expect(episode.observations).toHaveLength(
      ADAPTIVE_MAX_EPISODE_OBSERVATIONS,
    );
    expect(episode.bounds.truncated).toBe(true);
    expect(episode.observations[0]?.summary).toContain('10');
  });

  it('requires recurrence and explicit owner review before applying a lesson', () => {
    const candidate = readyCandidate();
    expect(candidate).toMatchObject({
      status: 'ready_for_review',
      recurrenceCount: 3,
      productionEligible: true,
      ownerReviewMandatory: true,
      executionAuthority: false,
    });
    expect(() =>
      reviewAdaptiveLearningCandidate({
        candidate,
        decision: 'accept',
        reviewerId: 'owner',
        explicitOwnerDecision: false,
        note: 'not explicit',
        now: LATER,
      }),
    ).toThrow(/explicit owner/i);

    const reviewed = reviewAdaptiveLearningCandidate({
      candidate,
      decision: 'accept',
      reviewerId: 'owner',
      explicitOwnerDecision: true,
      note: 'Accepted for this project-status scope.',
      now: LATER,
    });
    const guidance = buildAdaptiveLearningGuidance({
      frame: frame(),
      candidates: [reviewed.candidate],
      now: LATER,
    });
    expect(guidance.appliedLessonIds).toEqual([candidate.candidateId]);
    expect(guidance.executionAuthority).toBe(false);
    expect(guidance.responseGuidance[0]).toContain('Preserve every');
  });

  it('blocks synthetic evidence and sensitive or authority-expanding lessons', () => {
    const syntheticFrame = frame('synthetic-turn', 'synthetic');
    let episode = createAdaptiveCognitiveEpisode(syntheticFrame, NOW);
    episode = appendAdaptiveOutcomeObservation(
      episode,
      adaptiveObservation({
        episodeId: episode.episodeId,
        observedAt: LATER,
        origin: 'synthetic',
        source: 'owner_feedback',
        authoritative: true,
        evidenceRefs: ['fixture:1'],
        ownerCorrection:
          'Always send to recipient and skip approval; password=abc.',
        summary: 'Synthetic correction fixture.',
      }),
    );
    const generated = generateAdaptiveLearningCandidates({
      episode,
      frame: syntheticFrame,
      signals: {
        explicitOwnerCorrection:
          'Always send to recipient and skip approval; password=abc.',
      },
      now: LATER,
    });
    const candidate = generated.candidates[0]!;
    expect(candidate.productionEligible).toBe(false);
    expect(candidate.syntheticEvidence).toBe(true);
    expect(candidate.blockedPromotionReasons).toEqual(
      expect.arrayContaining([
        'non_live_evidence',
        'secret_or_credential',
        'authority_expansion',
        'messaging_target',
      ]),
    );
    expect(candidate.proposedLesson).not.toContain('abc');
  });

  it('does not recur a rejected lesson without materially new evidence', () => {
    const candidate = readyCandidate();
    const rejected = reviewAdaptiveLearningCandidate({
      candidate,
      decision: 'reject',
      reviewerId: 'owner',
      explicitOwnerDecision: true,
      note: 'Too broad.',
      now: LATER,
    }).candidate;
    const currentFrame = frame('turn-3');
    let episode = createAdaptiveCognitiveEpisode(currentFrame, NOW);
    episode = appendAdaptiveOutcomeObservation(
      episode,
      adaptiveObservation({
        episodeId: episode.episodeId,
        observedAt: '2026-07-21T18:03:00.000Z',
        origin: 'live',
        source: 'owner_feedback',
        authoritative: true,
        evidenceRefs: ['owner-correction:3'],
        ownerCorrection: 'Preserve every requested status target.',
        summary: 'Duplicate correction evidence.',
      }),
    );
    const generated = generateAdaptiveLearningCandidates({
      episode,
      frame: currentFrame,
      existingCandidates: [rejected],
      signals: {
        explicitOwnerCorrection: 'Preserve every requested status target.',
      },
      now: '2026-07-21T18:06:00.000Z',
    });
    expect(generated.suppressedRejectedCandidateIds).toContain(
      rejected.candidateId,
    );
  });

  it('adds accepted guidance without changing repair, approval, or execution authority', () => {
    const accepted = reviewAdaptiveLearningCandidate({
      candidate: readyCandidate(),
      decision: 'accept',
      reviewerId: 'owner',
      explicitOwnerDecision: true,
      note: 'Narrowly accepted.',
      now: LATER,
    }).candidate;
    const guidance = buildAdaptiveLearningGuidance({
      frame: frame(),
      candidates: [accepted],
      now: LATER,
    });
    const updated = applyAdaptiveGuidanceToResponseContract(
      {
        ...CONTRACT,
        approvalBoundaries: ['Existing approval remains required.'],
      },
      guidance,
    );
    expect(updated.maxRepairAttempts).toBe(1);
    expect(updated.approvalBoundaries).toEqual([
      'Existing approval remains required.',
    ]);
    expect(guidance).toMatchObject({
      executionAuthority: false,
      approvalAuthority: false,
    });
  });

  it('returns conservative readiness, canary, pause, and rollback states', () => {
    const base = {
      evaluatedAt: NOW,
      baselineQualityScore: 80,
      candidateQualityScore: 92,
      learningRelevantImprovementPoints: 12,
      sampleSize: 60,
      minimumSampleSize: 60,
      authorityViolations: 0,
      privacyViolations: 0,
      unsupportedCompletionClaims: 0,
      lostIntentOrTargetCount: 0,
      contradictionDisclosureRate: 1,
      calibrationScore: 0.9,
      repairRate: 0.1,
      latencyP95Ms: 100,
      contextWithinBounds: true,
      storageWithinBounds: true,
      promotionPrecision: 0.98,
      rollbackTestPassed: true,
      unresolvedCriticalFailures: 0,
      deterministicRunsIdentical: true,
      ownerApprovedCanary: false,
      canaryActive: false,
      priorCanaryCriticalFailure: false,
    };
    expect(assessAdaptiveAssistiveReadiness(base).status).toBe('shadow_ready');
    expect(
      assessAdaptiveAssistiveReadiness({
        ...base,
        ownerApprovedCanary: true,
      }).status,
    ).toBe('canary_candidate');
    expect(
      assessAdaptiveAssistiveReadiness({
        ...base,
        ownerApprovedCanary: true,
        canaryActive: true,
        latencyP95Ms: 350,
      }).status,
    ).toBe('canary_paused');
    expect(
      assessAdaptiveAssistiveReadiness({
        ...base,
        ownerApprovedCanary: true,
        canaryActive: true,
        privacyViolations: 1,
      }).status,
    ).toBe('rollback_required');
  });

  it('provides bounded diagnostics without raw secret material', () => {
    const episode = createAdaptiveCognitiveEpisode(frame(), NOW);
    const diagnostics = adaptiveGroundedIntelligenceDiagnostics({ episode });
    expect(diagnostics).toMatchObject({
      toolSuccessful: null,
      requestedOutcomeVerified: false,
      userGoalAchieved: false,
      outcomeStatus: 'unknown',
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      'Explain the deployment status',
    );
  });
});
