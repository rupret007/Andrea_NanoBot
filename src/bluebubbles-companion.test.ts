import crypto from 'crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, insertPilotJourneyEvent } from './db.js';
import {
  isBlueBubblesExplicitAsk,
  normalizeBlueBubblesCompanionPrompt,
  resolveMostRecentBlueBubblesCompanionChat,
  stripBlueBubblesAndreaMention,
} from './bluebubbles-companion.js';
import type { PilotJourneyEventRecord } from './types.js';

function buildEvent(
  overrides: Partial<PilotJourneyEventRecord> = {},
): PilotJourneyEventRecord {
  return {
    eventId: overrides.eventId || crypto.randomUUID(),
    journeyId: overrides.journeyId || 'ordinary_chat',
    channel: overrides.channel || 'bluebubbles',
    groupFolder: overrides.groupFolder || 'main',
    chatJid: overrides.chatJid || 'bb:iMessage;+;chat-1',
    threadId: overrides.threadId || null,
    routeKey: overrides.routeKey || null,
    systemsInvolved: overrides.systemsInvolved || ['assistant_shell'],
    outcome: overrides.outcome || 'success',
    blockerClass: overrides.blockerClass || null,
    blockerOwner: overrides.blockerOwner || 'none',
    degradedPath: overrides.degradedPath || null,
    handoffCreated: overrides.handoffCreated || false,
    missionCreated: overrides.missionCreated || false,
    threadSaved: overrides.threadSaved || false,
    reminderCreated: overrides.reminderCreated || false,
    librarySaved: overrides.librarySaved || false,
    currentWorkRef: overrides.currentWorkRef || null,
    summaryText: overrides.summaryText || 'BlueBubbles proof event',
    startedAt: overrides.startedAt || '2026-04-07T20:00:00.000Z',
    completedAt: overrides.completedAt || '2026-04-07T20:01:00.000Z',
    durationMs: overrides.durationMs || 1000,
  };
}

describe('bluebubbles companion helpers', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('requires an @Andrea mention before BlueBubbles wakes up', () => {
    expect(isBlueBubblesExplicitAsk('@Andrea hi')).toBe(true);
    expect(isBlueBubblesExplicitAsk('@Andrea what am I forgetting')).toBe(true);
    expect(isBlueBubblesExplicitAsk('@Andrea summarize this')).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('@Andrea anything else', {
        hasRecentCompanionContext: true,
      }),
    ).toBe(true);
    expect(isBlueBubblesExplicitAsk('Andrea, hi')).toBe(false);
    expect(isBlueBubblesExplicitAsk('what am I forgetting')).toBe(false);
    expect(isBlueBubblesExplicitAsk('summarize this')).toBe(false);
    expect(isBlueBubblesExplicitAsk('sounds good')).toBe(false);
  });

  it('strips @Andrea mentions before shared capability routing', () => {
    expect(stripBlueBubblesAndreaMention('@Andrea what am I forgetting')).toBe(
      'what am I forgetting',
    );
    expect(
      stripBlueBubblesAndreaMention('hey @Andrea, summarize this'),
    ).toBe('hey summarize this');
    expect(normalizeBlueBubblesCompanionPrompt('@Andrea')).toBe('hi');
  });

  it('selects the most recent Andrea-engaged BlueBubbles chat within the freshness window', () => {
    insertPilotJourneyEvent(
      buildEvent({
        chatJid: 'bb:iMessage;+;chat-old',
        startedAt: '2026-04-07T06:00:00.000Z',
        completedAt: '2026-04-07T06:01:00.000Z',
      }),
    );
    insertPilotJourneyEvent(
      buildEvent({
        eventId: crypto.randomUUID(),
        chatJid: 'bb:iMessage;+;chat-new',
        startedAt: '2026-04-07T19:00:00.000Z',
        completedAt: '2026-04-07T19:01:00.000Z',
      }),
    );

    expect(
      resolveMostRecentBlueBubblesCompanionChat({
        groupFolder: 'main',
        maxAgeHours: 12,
        now: new Date('2026-04-07T20:30:00.000Z'),
      }),
    ).toEqual({
      chatJid: 'bb:iMessage;+;chat-new',
      engagedAt: '2026-04-07T19:01:00.000Z',
    });
  });

  it('does not select stale or failed BlueBubbles chats for cross-channel handoff', () => {
    insertPilotJourneyEvent(
      buildEvent({
        chatJid: 'bb:iMessage;+;chat-stale',
        startedAt: '2026-04-06T01:00:00.000Z',
        completedAt: '2026-04-06T01:01:00.000Z',
      }),
    );
    insertPilotJourneyEvent(
      buildEvent({
        eventId: crypto.randomUUID(),
        chatJid: 'bb:iMessage;+;chat-failed',
        outcome: 'internal_failure',
        blockerOwner: 'repo_side',
        startedAt: '2026-04-07T19:00:00.000Z',
        completedAt: '2026-04-07T19:01:00.000Z',
      }),
    );

    expect(
      resolveMostRecentBlueBubblesCompanionChat({
        groupFolder: 'main',
        maxAgeHours: 12,
        now: new Date('2026-04-07T20:30:00.000Z'),
      }),
    ).toBeNull();
  });
});
