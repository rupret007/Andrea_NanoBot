import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  findRecentPilotJourneyEvent,
  listPilotIssues,
  listRecentPilotJourneyEvents,
} from './db.js';
import {
  capturePilotIssue,
  classifyPilotIssueKind,
  completePilotJourney,
  isPilotIssueCaptureRequest,
  resolveCrossChannelPilotJourney,
  resolveOrdinaryChatPilotJourney,
  resolvePilotJourneyFromCapability,
  sanitizePilotSummary,
  startPilotJourney,
} from './pilot-mode.js';

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
      sanitizePilotSummary('  **Candace** still needs\n\n a reply with _details_.  '),
    ).toBe('Candace still needs a reply with details.');
  });

  it('classifies flagship journey seeds', () => {
    expect(resolveOrdinaryChatPilotJourney('hi')?.journeyId).toBe('ordinary_chat');
    expect(resolveCrossChannelPilotJourney('save that for later')?.journeyId).toBe(
      'cross_channel_handoff',
    );
    expect(
      resolvePilotJourneyFromCapability({
        capabilityId: 'communication.draft_reply',
        channel: 'telegram',
        text: 'What should I say back to Candace?',
        canonicalText: 'what should i say back to candace',
      })?.journeyId,
    ).toBe('candace_followthrough');
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
});
