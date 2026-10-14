import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  findRecentPilotJourneyEvent,
  insertPilotIssue,
  insertPilotJourneyEvent,
  listPilotIssues,
  listRecentPilotJourneyEvents,
  upsertResponseFeedback,
} from './db.js';
import {
  buildPilotReviewSnapshot,
  buildPilotReviewDigest,
  capturePilotIssue,
  classifyPilotIssueKind,
  completePilotJourney,
  isPilotIssueCaptureRequest,
  recordOrdinaryChatQuickReplyPilotProof,
  resolveCrossChannelPilotJourney,
  resolveGoalPlannerPilotJourney,
  resolveOrdinaryChatPilotJourney,
  resolvePilotJourneyFromCapability,
  sanitizePilotSummary,
  startPilotJourney,
} from './pilot-mode.js';
import type { PilotIssueRecord, PilotJourneyEventRecord } from './types.js';

describe('pilot mode', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
  });

  it('classifies explicit pilot issue capture phrases', () => {
    expect(classifyPilotIssueKind('this felt weird')).toBe('felt_weird');
    expect(classifyPilotIssueKind('that answer was off')).toBe('answer_off');
    expect(classifyPilotIssueKind("this shouldn't have happened")).toBe(
      'should_not_happen',
    );
    expect(isPilotIssueCaptureRequest('mark this flow as awkward')).toBe(true);
  });

  it('sanitizes stored summaries and avoids raw formatting leakage', () => {
    expect(
      sanitizePilotSummary(
        '  **Candace** still needs\n\n a reply with _details_.  ',
      ),
    ).toBe('Candace still needs a reply with details.');
  });

  it('classifies flagship journey seeds', () => {
    expect(resolveOrdinaryChatPilotJourney('hi')?.journeyId).toBe(
      'ordinary_chat',
    );
    expect(resolveOrdinaryChatPilotJourney('@Andrea hi')?.journeyId).toBe(
      'ordinary_chat',
    );
    expect(
      resolveOrdinaryChatPilotJourney("@Andrea what's up")?.journeyId,
    ).toBe('ordinary_chat');
    expect(
      resolveCrossChannelPilotJourney('save that for later')?.journeyId,
    ).toBe('cross_channel_handoff');
    expect(
      resolvePilotJourneyFromCapability({
        capabilityId: 'communication.draft_reply',
        channel: 'telegram',
        text: 'What should I say back to Candace?',
        canonicalText: 'what should i say back to candace',
      })?.journeyId,
    ).toBe('candace_followthrough');
    expect(
      resolvePilotJourneyFromCapability({
        capabilityId: 'research.answer',
        channel: 'telegram',
        text: 'What is Jar Jar Binks species?',
        canonicalText: 'what is jar jar binks species',
      }),
    ).toBeNull();
  });

  it('classifies goal-planner proof prompts as mission planning only when they ask for planning', () => {
    expect(
      resolveGoalPlannerPilotJourney('help me plan tonight'),
    ).toMatchObject({
      journeyId: 'mission_planning',
      routeKey: 'goal_planner.status',
    });
    expect(
      resolveGoalPlannerPilotJourney("what's blocking this"),
    ).toMatchObject({
      journeyId: 'mission_planning',
    });
    expect(
      resolveGoalPlannerPilotJourney('what is your current focus'),
    ).toBeNull();
  });

  it('records and finalizes bounded pilot journey events', () => {
    const started = startPilotJourney({
      journeyId: 'mission_planning',
      systemsInvolved: ['missions', 'chief_of_staff'],
      summaryText: 'Plan tonight mission',
      routeKey: 'missions.propose',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: 'thread-1',
      startedAt: '2026-04-07T18:00:00.000Z',
    });

    expect(started).toBeTruthy();
    completePilotJourney({
      eventId: started!.eventId,
      outcome: 'success',
      blockerOwner: 'none',
      completedAt: '2026-04-07T18:00:12.000Z',
      summaryText: 'Planned tonight and picked the next step.',
      missionCreated: true,
    });

    const events = listRecentPilotJourneyEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]?.durationMs).toBe(12_000);
    expect(events[0]?.missionCreated).toBe(true);
    expect(events[0]?.summaryText).toBe(
      'Planned tonight and picked the next step.',
    );
  });

  it('records ordinary-chat quick replies as live pilot proof', () => {
    const recorded = recordOrdinaryChatQuickReplyPilotProof({
      text: 'hi',
      replyText: "Hi. Give me one thing and I'll keep it simple.",
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: 'thread-hi',
      now: new Date('2026-04-07T18:30:00.000Z'),
    });

    expect(recorded?.journeyId).toBe('ordinary_chat');
    expect(recorded?.outcome).toBe('success');
    expect(recorded?.completedAt).toBe('2026-04-07T18:30:00.000Z');

    const digest = buildPilotReviewDigest(new Date('2026-04-07T18:31:00.000Z'));
    expect(digest.journeyDigests.ordinary_chat.proofFreshness).toBe('fresh');
    expect(digest.journeyDigests.ordinary_chat.usage24h).toBe(1);
  });

  it('links a pilot issue to the recent flagship journey in the same chat', () => {
    const started = startPilotJourney({
      journeyId: 'candace_followthrough',
      systemsInvolved: ['communication_companion'],
      summaryText: 'Candace follow-through',
      routeKey: 'communication.draft_reply',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: 'thread-2',
      startedAt: new Date().toISOString(),
    });
    completePilotJourney({
      eventId: started!.eventId,
      outcome: 'success',
      blockerOwner: 'none',
      summaryText: 'Drafted a reply for Candace.',
    });

    const capture = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: 'thread-2',
      utterance: 'this felt weird',
      routeKey: 'pilot.capture_issue',
      assistantContextSummary: 'Drafted a reply for Candace.',
      linkedRefs: {
        lifeThreadId: 'thread-candace',
      },
    });

    expect(capture.handled).toBe(true);
    expect(capture.record?.journeyEventId).toBe(started!.eventId);
    expect(capture.replyText).toContain('private pilot issue');
    expect(listPilotIssues({ status: 'open' })).toHaveLength(1);
  });

  it('stores standalone pilot issues when no recent journey exists', () => {
    const capture = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      utterance: 'save this as a pilot issue',
      routeKey: 'pilot.capture_issue',
      assistantContextSummary: 'Plain assistant context.',
    });

    expect(capture.handled).toBe(true);
    expect(capture.record?.journeyEventId).toBeNull();
    expect(capture.record?.summaryText).toContain('manual pilot issue');
  });

  it('supports override-driven downvoted response issues', () => {
    const capture = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      utterance: 'not helpful',
      routeKey: 'response_feedback.capture',
      assistantContextSummary: 'Generic news fallback.',
      linkedRefs: {
        responseFeedbackId: 'feedback-1',
      },
      issueKindOverride: 'downvoted_response',
      summaryTextOverride:
        'User downvoted Andrea reply to "what is the news today".',
      blockerClassOverride: 'response_feedback_repo_side_broken',
      blockerOwnerOverride: 'repo_side',
      journeyEventIdOverride: null,
    });

    expect(capture.handled).toBe(true);
    expect(capture.record?.issueKind).toBe('downvoted_response');
    expect(capture.record?.summaryText).toContain(
      'User downvoted Andrea reply',
    );
    expect(capture.record?.blockerClass).toBe(
      'response_feedback_repo_side_broken',
    );
    expect(capture.record?.linkedRefs.responseFeedbackId).toBe('feedback-1');
  });

  it('keeps only actionable downvoted issues open after feedback reconciliation', () => {
    const fixed = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      utterance: 'not helpful',
      linkedRefs: { responseFeedbackId: 'feedback-fixed' },
      issueKindOverride: 'downvoted_response',
      summaryTextOverride: 'Fixed route issue.',
    }).record!;
    const pending = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      utterance: 'not helpful',
      linkedRefs: { responseFeedbackId: 'feedback-pending' },
      issueKindOverride: 'downvoted_response',
      summaryTextOverride: 'Pending local repair.',
    }).record!;
    const feedbackBase = {
      createdAt: '2026-07-12T08:00:00.000Z',
      updatedAt: '2026-07-12T08:05:00.000Z',
      status: 'resolved_locally' as const,
      classification: 'repo_side_rough_edge' as const,
      channel: 'telegram' as const,
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      platformMessageId: '100',
      userMessageId: '101',
      routeKey: 'communication.summarize_thread',
      capabilityId: 'communication.summarize_thread',
      handlerKind: 'assistant_completion',
      responseSource: 'local_companion',
      traceReason: 'test',
      traceNotes: [],
      blockerClass: 'response_feedback_repo_side_rough_edge',
      blockerOwner: 'repo_side' as const,
      originalUserText: 'Summarize my messages.',
      assistantReplyText: 'A bounded summary.',
      remediationLaneId: null,
      remediationJobId: null,
      remediationRuntimePreference: null,
      remediationPrompt: null,
      operatorNote: 'test',
    };
    upsertResponseFeedback({
      ...feedbackBase,
      feedbackId: 'feedback-fixed',
      issueId: fixed.issueId,
      linkedRefs: {
        responseFeedbackId: 'feedback-fixed',
        feedbackRouteCoverageResolvedAt: '2026-07-12T08:05:00.000Z',
      },
    });
    upsertResponseFeedback({
      ...feedbackBase,
      feedbackId: 'feedback-pending',
      issueId: pending.issueId,
      linkedRefs: { responseFeedbackId: 'feedback-pending' },
    });

    const review = buildPilotReviewSnapshot(
      new Date('2026-07-12T08:10:00.000Z'),
    );

    expect(listPilotIssues({ status: 'open' })).toHaveLength(2);
    expect(review.openIssueCount).toBe(1);
    expect(review.openIssues.map((issue) => issue.issueId)).toEqual([
      pending.issueId,
    ]);
  });

  it('disables journey logging and issue capture when ANDREA_PILOT_LOGGING_ENABLED=0', () => {
    vi.stubEnv('ANDREA_PILOT_LOGGING_ENABLED', '0');

    const started = startPilotJourney({
      journeyId: 'ordinary_chat',
      systemsInvolved: ['assistant_shell'],
      summaryText: 'Ordinary chat greeting',
      routeKey: 'direct_quick_reply',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
    });
    const capture = capturePilotIssue({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      utterance: 'this felt weird',
      assistantContextSummary: 'hello',
    });

    expect(started).toBeNull();
    expect(capture.handled).toBe(true);
    expect(capture.replyText).toContain('disabled on this host');
    expect(listRecentPilotJourneyEvents({ limit: 5 })).toHaveLength(0);
    expect(listPilotIssues({ status: 'open' })).toHaveLength(0);
    expect(
      findRecentPilotJourneyEvent({ chatJid: 'tg:main', maxAgeMinutes: 30 }),
    ).toBeNull();
  });

  it('does not let newer retired-channel history crowd current records out of the window', () => {
    const now = new Date('2026-04-07T18:30:00.000Z');
    const retiredChannel = 'alexa' as PilotIssueRecord['channel'];
    const issue: PilotIssueRecord = {
      issueId: 'telegram-issue',
      createdAt: '2026-04-07T10:00:00.000Z',
      status: 'open',
      issueKind: 'manual_pilot_issue',
      channel: 'telegram',
      groupFolder: 'main',
      blockerOwner: 'repo_side',
      summaryText: 'Repair Telegram follow-through.',
      assistantContextSummary: 'Telegram follow-through needs repair.',
      linkedRefs: {},
    };
    const event: PilotJourneyEventRecord = {
      eventId: 'telegram-event',
      journeyId: 'ordinary_chat',
      channel: 'telegram',
      groupFolder: 'main',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerOwner: 'none',
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      summaryText: 'Telegram greeting succeeded.',
      startedAt: '2026-04-07T10:00:00.000Z',
      completedAt: '2026-04-07T10:00:02.000Z',
    };
    insertPilotIssue(issue);
    insertPilotJourneyEvent(event);
    // More newer retired rows than the snapshot's SQL LIMITs (300 / 1000).
    for (let i = 0; i < 1001; i += 1) {
      const at = new Date(
        Date.parse('2026-04-07T11:00:00.000Z') + i * 1000,
      ).toISOString();
      insertPilotIssue({
        ...issue,
        issueId: `retired-issue-${i}`,
        createdAt: at,
        channel: retiredChannel,
      });
      if (i < 301) {
        insertPilotJourneyEvent({
          ...event,
          eventId: `retired-event-${i}`,
          channel: retiredChannel,
          startedAt: at,
          completedAt: at,
        });
      }
    }

    const review = buildPilotReviewSnapshot(now);
    expect(review.openIssueCount).toBe(1);
    expect(review.openIssues.map((i) => i.issueId)).toEqual(['telegram-issue']);
    expect(review.recentEvents.map((e) => e.eventId)).toEqual([
      'telegram-event',
    ]);
    expect(listPilotIssues({ status: 'open', limit: 2000 })).toHaveLength(1002);
  });

  it('excludes retired-channel history from current pilot reporting without changing stored records', () => {
    const now = new Date('2026-04-07T18:30:00.000Z');
    // Persisted pre-removal records can have a channel outside today's types.
    const retiredChannel = 'alexa' as PilotIssueRecord['channel'];
    const issueBase: PilotIssueRecord = {
      issueId: 'telegram-issue',
      createdAt: '2026-04-07T17:00:00.000Z',
      status: 'open',
      issueKind: 'manual_pilot_issue',
      channel: 'telegram',
      groupFolder: 'main',
      blockerOwner: 'repo_side',
      summaryText: 'Repair Telegram follow-through.',
      assistantContextSummary: 'Telegram follow-through needs repair.',
      linkedRefs: {},
    };
    insertPilotIssue(issueBase);
    insertPilotIssue({
      ...issueBase,
      issueId: 'bluebubbles-issue',
      createdAt: '2026-04-07T17:30:00.000Z',
      channel: 'bluebubbles',
      summaryText: 'Repair BlueBubbles follow-through.',
      assistantContextSummary: 'BlueBubbles follow-through needs repair.',
    });
    insertPilotIssue({
      ...issueBase,
      issueId: 'retired-issue',
      createdAt: '2026-04-07T18:00:00.000Z',
      channel: retiredChannel,
      summaryText: 'Repair the Alexa voice router.',
      assistantContextSummary: 'Historical voice routing failure.',
    });

    const eventBase: PilotJourneyEventRecord = {
      eventId: 'telegram-event',
      journeyId: 'ordinary_chat',
      channel: 'telegram',
      groupFolder: 'main',
      systemsInvolved: ['assistant_shell'],
      outcome: 'success',
      blockerOwner: 'none',
      handoffCreated: false,
      missionCreated: false,
      threadSaved: false,
      reminderCreated: false,
      librarySaved: false,
      summaryText: 'Telegram greeting succeeded.',
      startedAt: '2026-04-07T17:00:00.000Z',
      completedAt: '2026-04-07T17:00:02.000Z',
    };
    insertPilotJourneyEvent(eventBase);
    insertPilotJourneyEvent({
      ...eventBase,
      eventId: 'bluebubbles-event',
      channel: 'bluebubbles',
      outcome: 'internal_failure',
      blockerOwner: 'repo_side',
      summaryText: 'BlueBubbles greeting failed.',
      startedAt: '2026-04-07T17:30:00.000Z',
      completedAt: '2026-04-07T17:30:02.000Z',
    });
    insertPilotJourneyEvent({
      ...eventBase,
      eventId: 'retired-event',
      channel: retiredChannel,
      outcome: 'internal_failure',
      blockerOwner: 'repo_side',
      summaryText: 'Historical Alexa greeting failure.',
      startedAt: '2026-04-07T18:00:00.000Z',
      completedAt: '2026-04-07T18:00:02.000Z',
    });
    const storedIssues = listPilotIssues({ status: 'open' });
    const storedEvents = listRecentPilotJourneyEvents();

    const review = buildPilotReviewSnapshot(now);
    const digest = buildPilotReviewDigest(now);

    expect(storedIssues).toHaveLength(3);
    expect(storedEvents).toHaveLength(3);
    for (const report of [review, digest]) {
      expect(report.openIssueCount).toBe(2);
      expect(report.openIssues.map((issue) => issue.issueId)).toEqual([
        'bluebubbles-issue',
        'telegram-issue',
      ]);
      expect(report.latestOpenIssue?.issueId).toBe('bluebubbles-issue');
      expect(report.latestOpenIssue?.summaryText).toBe(
        'Repair BlueBubbles follow-through.',
      );
      expect(report.recentEvents.map((event) => event.eventId)).toEqual([
        'bluebubbles-event',
        'telegram-event',
      ]);
    }
    expect(digest.totalUsage24h).toBe(2);
    expect(digest.totalUsage7d).toBe(2);
    expect(digest.journeyDigests.ordinary_chat.usage24h).toBe(2);
    expect(digest.journeyDigests.ordinary_chat.usage7d).toBe(2);
    expect(digest.journeyDigests.ordinary_chat.latestEvent?.eventId).toBe(
      'bluebubbles-event',
    );
    expect(
      digest.journeyDigests.ordinary_chat.latestProblemEvent?.eventId,
    ).toBe('bluebubbles-event');
    expect(digest.recentProblemEvents.map((event) => event.eventId)).toEqual([
      'bluebubbles-event',
    ]);
    expect(
      digest.currentActionableProblemEvents.map((event) => event.eventId),
    ).toEqual(['bluebubbles-event']);
    expect(listPilotIssues({ status: 'open' })).toEqual(storedIssues);
    expect(listRecentPilotJourneyEvents()).toEqual(storedEvents);
  });

  it('builds pilot review digests with usage counts and latest problems', () => {
    const success = startPilotJourney({
      journeyId: 'ordinary_chat',
      systemsInvolved: ['assistant_shell'],
      summaryText: 'Ordinary chat greeting',
      routeKey: 'direct_quick_reply',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      startedAt: '2026-04-07T17:00:00.000Z',
    });
    completePilotJourney({
      eventId: success!.eventId,
      outcome: 'success',
      blockerOwner: 'none',
      completedAt: '2026-04-07T17:00:02.000Z',
      summaryText: 'Pretty calm over here.',
    });

    const degraded = startPilotJourney({
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['cross_channel_handoffs'],
      summaryText: 'Cross-channel handoff or save',
      routeKey: 'assistant_completion',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      startedAt: '2026-04-07T18:00:00.000Z',
    });
    completePilotJourney({
      eventId: degraded!.eventId,
      outcome: 'degraded_usable',
      blockerClass: 'local_degraded_path',
      blockerOwner: 'repo_side',
      completedAt: '2026-04-07T18:00:05.000Z',
      summaryText: "I can't check that live right now.",
    });

    const digest = buildPilotReviewDigest(new Date('2026-04-07T18:30:00.000Z'));

    expect(digest.totalUsage24h).toBe(2);
    expect(digest.journeyDigests.ordinary_chat.usage24h).toBe(1);
    expect(digest.journeyDigests.ordinary_chat.proofFreshness).toBe('fresh');
    expect(
      digest.journeyDigests.cross_channel_handoff.latestProblemEvent?.outcome,
    ).toBe('degraded_usable');
    expect(digest.recentProblemEvents).toHaveLength(1);
    expect(digest.currentActionableProblemEvents).toHaveLength(1);
    expect(digest.historicalRecurringFailures).toHaveLength(0);
  });

  it('separates fresh actionable friction from older recurring failures', () => {
    const olderOne = startPilotJourney({
      journeyId: 'daily_guidance',
      systemsInvolved: ['daily_companion'],
      summaryText: 'Daily guidance in BlueBubbles self-thread',
      routeKey: 'daily.loose_ends',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      startedAt: '2026-04-08T10:00:00.000Z',
    });
    completePilotJourney({
      eventId: olderOne!.eventId,
      outcome: 'degraded_usable',
      blockerClass: 'message_action_missing',
      blockerOwner: 'repo_side',
      completedAt: '2026-04-08T10:00:04.000Z',
      summaryText: 'Daily guidance still needs a same-thread message action.',
    });

    const olderTwo = startPilotJourney({
      journeyId: 'daily_guidance',
      systemsInvolved: ['daily_companion'],
      summaryText: 'Daily guidance in BlueBubbles self-thread',
      routeKey: 'daily.loose_ends',
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      startedAt: '2026-04-08T11:00:00.000Z',
    });
    completePilotJourney({
      eventId: olderTwo!.eventId,
      outcome: 'degraded_usable',
      blockerClass: 'message_action_missing',
      blockerOwner: 'repo_side',
      completedAt: '2026-04-08T11:00:03.000Z',
      summaryText: 'Daily guidance still needs a same-thread message action.',
    });

    const current = startPilotJourney({
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['cross_channel_handoffs'],
      summaryText: 'Cross-channel handoff or save',
      routeKey: 'assistant_completion',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      startedAt: '2026-04-11T09:00:00.000Z',
    });
    completePilotJourney({
      eventId: current!.eventId,
      outcome: 'degraded_usable',
      blockerClass: 'local_degraded_path',
      blockerOwner: 'repo_side',
      completedAt: '2026-04-11T09:00:05.000Z',
      summaryText: "I can't check that live right now.",
    });

    const digest = buildPilotReviewDigest(new Date('2026-04-11T10:00:00.000Z'));

    expect(digest.currentActionableProblemEvents).toHaveLength(1);
    expect(digest.currentActionableProblemEvents[0]?.journeyId).toBe(
      'cross_channel_handoff',
    );
    expect(digest.historicalRecurringFailures[0]).toMatchObject({
      journeyId: 'daily_guidance',
      channel: 'bluebubbles',
      blockerClass: 'message_action_missing',
      occurrences: 2,
    });
  });
});
