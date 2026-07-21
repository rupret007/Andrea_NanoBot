import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listAdaptiveLearningLifecycleEvents,
  listCognitiveEpisodes,
  listGroundedLearningRecords,
} from './db.js';
import {
  adaptiveObservation,
  appendAdaptiveOutcomeObservation,
  createAdaptiveCognitiveEpisode,
  generateAdaptiveLearningCandidates,
  type AdaptiveLearningCandidate,
} from './adaptive-grounded-intelligence.js';
import {
  listAdaptiveLearningEvents,
  loadAdaptiveCognitiveEpisode,
  loadAdaptiveGuidanceForFrame,
  loadAdaptiveLearningCandidates,
  persistAdaptiveCognitiveEpisode,
  persistAdaptiveLearning,
  pruneAdaptiveGroundedIntelligence,
  reconcileAndPersistAdaptiveObservation,
  reconcileAdaptiveOwnerFeedbackByTurn,
  reviewAdaptiveLearningCandidateDurably,
} from './adaptive-grounded-intelligence-durable-adapter.js';
import {
  buildUnifiedGroundedCognitiveFrame,
  observeUnifiedOutcome,
} from './unified-grounded-cognition.js';

const NOW = '2026-07-21T18:00:00.000Z';

function frame(turnId = 'turn-1') {
  return buildUnifiedGroundedCognitiveFrame({
    turnId,
    conversationId: 'chat-1',
    channel: 'telegram',
    actorId: 'owner',
    groupFolder: 'main',
    text: 'Explain the project status.',
    now: NOW,
    runOrigin: 'live',
    taskFamily: 'project_status',
    mode: 'shadow',
  });
}

function readyCandidate(): {
  candidate: AdaptiveLearningCandidate;
  events: ReturnType<typeof generateAdaptiveLearningCandidates>['events'];
} {
  let existing: AdaptiveLearningCandidate[] = [];
  let lastEvents: ReturnType<
    typeof generateAdaptiveLearningCandidates
  >['events'] = [];
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
        evidenceRefs: [`owner:${index}`],
        ownerCorrection: 'Keep the requested target.',
        summary: 'Owner correction.',
      }),
    );
    const generated = generateAdaptiveLearningCandidates({
      episode,
      frame: currentFrame,
      existingCandidates: existing,
      signals: { explicitOwnerCorrection: 'Keep the requested target.' },
      now: `2026-07-21T18:0${index}:30.000Z`,
    });
    existing = generated.candidates;
    lastEvents = generated.events;
  }
  const candidate = existing.find(
    (item) => item.kind === 'explicit_owner_correction',
  );
  if (!candidate) throw new Error('expected candidate');
  return { candidate, events: lastEvents };
}

describe('adaptive grounded intelligence durable adapter', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('stores a bounded adaptive projection in the existing cognitive episode table', () => {
    const currentFrame = frame();
    const episode = createAdaptiveCognitiveEpisode(currentFrame, NOW);
    expect(persistAdaptiveCognitiveEpisode(episode)).toBe(true);
    const loaded = loadAdaptiveCognitiveEpisode({
      episodeId: episode.episodeId,
      turnId: episode.turnId,
    });
    expect(loaded).toMatchObject({
      episodeId: episode.episodeId,
      frameId: currentFrame.frameId,
      turnId: 'turn-1',
      runOrigin: 'live',
      observations: [],
      invariants: {
        executionAuthority: false,
        learningPromotionAuthority: false,
        rawPrivateContentPersisted: false,
      },
    });
    const stored = listCognitiveEpisodes({ turnId: 'turn-1', limit: 10 })[0]!;
    expect(stored.askSummary).not.toContain('Explain the project status');
    expect(stored.observationsJson).toBe('[]');
    expect(stored.schemaVersion).toBe('1.0.0');
  });

  it('appends and reloads late outcome evidence without losing prior observations', () => {
    const currentFrame = frame();
    let episode = createAdaptiveCognitiveEpisode(currentFrame, NOW);
    persistAdaptiveCognitiveEpisode(episode);
    for (let index = 1; index <= 2; index += 1) {
      episode = reconcileAndPersistAdaptiveObservation({
        episode,
        observation: adaptiveObservation({
          episodeId: episode.episodeId,
          observedAt: `2026-07-21T18:0${index}:00.000Z`,
          origin: 'live',
          source: index === 1 ? 'tool_runtime' : 'goal_verification',
          authoritative: index === 2,
          facts:
            index === 1
              ? { toolTechnicallySuccessful: true }
              : { requestedOutcomeVerified: true, goalAchieved: true },
          evidenceRefs: [`evidence:${index}`],
          summary: `Observation ${index}.`,
        }),
      });
    }
    const loaded = loadAdaptiveCognitiveEpisode({
      episodeId: episode.episodeId,
      turnId: episode.turnId,
    });
    expect(loaded?.observations).toHaveLength(2);
    expect(loaded?.outcome).toMatchObject({
      toolTechnicallySuccessful: true,
      requestedOutcomeVerified: true,
      goalAchieved: true,
      status: 'achieved',
    });
  });

  it('supersedes an earlier failure lesson when late authoritative recovery arrives', () => {
    const baseFrame = frame();
    const observedFrame = observeUnifiedOutcome(baseFrame, {
      observedAt: '2026-07-21T18:01:00.000Z',
      routeUsed: 'provider:test',
      responseStatus: 'pass',
      toolCallAccepted: true,
      toolReturnedSuccess: true,
      providerReceiptIds: ['receipt:technical'],
      requestedOutcomeVerified: false,
      goalAchieved: false,
      evidenceRefs: ['tool:success'],
    });
    let episode = createAdaptiveCognitiveEpisode(observedFrame, NOW);
    episode = appendAdaptiveOutcomeObservation(
      episode,
      adaptiveObservation({
        episodeId: episode.episodeId,
        observedAt: '2026-07-21T18:01:00.000Z',
        origin: 'live',
        source: 'tool_runtime',
        authoritative: true,
        facts: { toolTechnicallySuccessful: true },
        evidenceRefs: ['tool:success'],
        summary: 'Technical success without requested-outcome verification.',
      }),
    );
    const generated = generateAdaptiveLearningCandidates({
      episode,
      frame: observedFrame,
      signals: { routeUsed: 'provider:test' },
      now: '2026-07-21T18:01:00.000Z',
    });
    persistAdaptiveCognitiveEpisode(episode);
    persistAdaptiveLearning(generated);
    const failureCandidate = generated.candidates.find(
      (item) => item.kind === 'technical_success_unverified_goal',
    );
    expect(failureCandidate).toBeDefined();

    reconcileAndPersistAdaptiveObservation({
      episode,
      observation: adaptiveObservation({
        episodeId: episode.episodeId,
        observedAt: '2026-07-21T18:10:00.000Z',
        origin: 'live',
        source: 'goal_verification',
        authoritative: true,
        facts: { requestedOutcomeVerified: true, goalAchieved: true },
        evidenceRefs: ['goal:recovered'],
        summary: 'Late authoritative recovery verified the goal.',
      }),
    });
    const superseded = loadAdaptiveLearningCandidates().find(
      (item) => item.candidateId === failureCandidate!.candidateId,
    );
    expect(superseded).toMatchObject({
      status: 'superseded',
      productionEligible: false,
    });
    expect(superseded?.counterEvidenceRefs).toContain('goal:recovered');
  });

  it('persists rich candidates and append-only lifecycle events with no authority', () => {
    const { candidate, events } = readyCandidate();
    const persisted = persistAdaptiveLearning({
      candidates: [candidate],
      events,
    });
    expect(persisted).toEqual({
      candidatesPersisted: 1,
      eventsPersisted: 1,
    });
    const stored = listGroundedLearningRecords({ limit: 10 })[0]!;
    expect(stored).toMatchObject({
      adaptiveStatus: 'ready_for_review',
      adaptiveKind: 'explicit_owner_correction',
      ownerReviewRequired: true,
      productionEligible: true,
      appliesToAuthority: false,
    });
    const loaded = loadAdaptiveLearningCandidates({
      status: 'ready_for_review',
    });
    expect(loaded[0]).toMatchObject({
      candidateId: candidate.candidateId,
      recurrenceCount: 3,
      executionAuthority: false,
    });
    const durableEvents = listAdaptiveLearningLifecycleEvents({ limit: 10 });
    expect(durableEvents[0]).toMatchObject({
      candidateId: candidate.candidateId,
      kind: 'ready_for_review',
      executionAuthority: false,
    });
  });

  it('joins explicit owner feedback to the originating turn without inferring broad goal success', () => {
    const episode = createAdaptiveCognitiveEpisode(frame(), NOW);
    persistAdaptiveCognitiveEpisode(episode);
    const reconciled = reconcileAdaptiveOwnerFeedbackByTurn({
      turnId: episode.turnId,
      feedbackId: 'feedback-1',
      verdict: 'accepted',
      routeKey: 'direct_assistant',
      completionVerified: true,
      observedAt: '2026-07-21T18:10:00.000Z',
    });
    expect(reconciled?.outcome).toMatchObject({
      requestedOutcomeVerified: true,
      goalAchieved: false,
      status: 'unknown',
    });
    expect(reconciled?.observations[0]).toMatchObject({
      source: 'owner_feedback',
      authoritative: true,
      recommendationFeedback: {
        verdict: 'accepted',
      },
    });
    expect(loadAdaptiveLearningCandidates()[0]).toMatchObject({
      kind: 'accepted_recommendation',
      status: 'proposed',
      recurrenceCount: 1,
      ownerReviewMandatory: true,
    });
  });

  it('requires explicit owner acceptance, applies only scoped guidance, and rolls back', () => {
    const { candidate, events } = readyCandidate();
    persistAdaptiveLearning({ candidates: [candidate], events });
    expect(() =>
      reviewAdaptiveLearningCandidateDurably({
        candidateId: candidate.candidateId,
        decision: 'accept',
        reviewerId: 'owner',
        explicitOwnerDecision: false,
        note: 'implicit',
        now: '2026-07-21T18:10:00.000Z',
      }),
    ).toThrow(/explicit owner/i);
    const accepted = reviewAdaptiveLearningCandidateDurably({
      candidateId: candidate.candidateId,
      decision: 'accept',
      reviewerId: 'owner',
      explicitOwnerDecision: true,
      note: 'Accepted for project status responses.',
      now: '2026-07-21T18:10:00.000Z',
    });
    expect(accepted?.status).toBe('accepted');
    const guidance = loadAdaptiveGuidanceForFrame(
      frame(),
      '2026-07-21T18:11:00.000Z',
    );
    expect(guidance.guidance.appliedLessonIds).toEqual([candidate.candidateId]);
    const unrelated = buildUnifiedGroundedCognitiveFrame({
      turnId: 'other',
      conversationId: 'other-chat',
      channel: 'telegram',
      groupFolder: 'other',
      text: 'Status?',
      now: NOW,
      runOrigin: 'live',
      taskFamily: 'project_status',
      mode: 'shadow',
    });
    expect(
      loadAdaptiveGuidanceForFrame(unrelated, '2026-07-21T18:11:00.000Z')
        .guidance.appliedLessonIds,
    ).toEqual([]);

    const rolledBack = reviewAdaptiveLearningCandidateDurably({
      candidateId: candidate.candidateId,
      decision: 'rollback',
      reviewerId: 'owner',
      explicitOwnerDecision: true,
      note: 'The lesson was too broad in dogfood.',
      now: '2026-07-21T18:12:00.000Z',
    });
    expect(rolledBack?.status).toBe('rolled_back');
    expect(
      loadAdaptiveGuidanceForFrame(frame(), '2026-07-21T18:13:00.000Z').guidance
        .appliedLessonIds,
    ).toEqual([]);
    expect(
      listAdaptiveLearningEvents({ candidateId: candidate.candidateId }).map(
        (item) => item.kind,
      ),
    ).toEqual(expect.arrayContaining(['owner_accepted', 'rolled_back']));
  });

  it('marks synthetic candidates non-production and keeps retention bounded', () => {
    const syntheticFrame = buildUnifiedGroundedCognitiveFrame({
      turnId: 'fixture-turn',
      conversationId: 'fixture-chat',
      channel: 'telegram',
      groupFolder: 'main',
      text: 'Synthetic fixture.',
      now: '2025-01-01T00:00:00.000Z',
      runOrigin: 'synthetic',
      taskFamily: 'fixture',
      mode: 'shadow',
    });
    const episode = createAdaptiveCognitiveEpisode(
      syntheticFrame,
      '2025-01-01T00:00:00.000Z',
    );
    persistAdaptiveCognitiveEpisode(episode);
    const generated = generateAdaptiveLearningCandidates({
      episode,
      frame: syntheticFrame,
      signals: { explicitOwnerCorrection: 'Fixture correction.' },
      now: '2025-01-01T00:01:00.000Z',
    });
    persistAdaptiveLearning(generated);
    expect(loadAdaptiveLearningCandidates()[0]).toMatchObject({
      syntheticEvidence: true,
      productionEligible: false,
    });
    const pruned = pruneAdaptiveGroundedIntelligence(
      '2026-07-21T18:00:00.000Z',
    );
    expect(pruned.episodes).toBeGreaterThanOrEqual(1);
    expect(pruned.lifecycleEvents).toBeGreaterThanOrEqual(1);
  });
});
