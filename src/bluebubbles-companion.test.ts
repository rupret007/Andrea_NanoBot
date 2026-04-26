import crypto from 'crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  insertPilotJourneyEvent,
  storeChatMetadata,
  upsertMessageAction,
} from './db.js';
import {
  decideBlueBubblesCompanionIngress,
  isBlueBubblesExplicitAsk,
  isBlueBubblesProofDrillStartRequest,
  normalizeBlueBubblesCompanionPrompt,
  resolveBlueBubblesPendingLocalContinuationKind,
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

  it('allows direct assistant asks in the canonical BlueBubbles self-thread without @Andrea', () => {
    expect(
      isBlueBubblesExplicitAsk('hi', {
        chatJid: 'bb:iMessage;-;+14695405551',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('what should I say back', {
        chatJid: 'bb:iMessage;-;+14695405551',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('what am I forgetting', {
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('sounds good', {
        chatJid: 'bb:iMessage;-;+14695405551',
      }),
    ).toBe(false);
  });

  it('recognizes explicit BlueBubbles proof-drill start requests', () => {
    expect(isBlueBubblesProofDrillStartRequest('start proof drill')).toBe(true);
    expect(
      isBlueBubblesProofDrillStartRequest('@Andrea start bluebubbles proof'),
    ).toBe(true);
    expect(isBlueBubblesProofDrillStartRequest('start blue bubbles proof')).toBe(
      true,
    );
    expect(isBlueBubblesProofDrillStartRequest('send it later tonight')).toBe(
      false,
    );
  });

  it('allows recent direct 1:1 BlueBubbles chats to become conversational without @Andrea', () => {
    storeChatMetadata(
      'bb:iMessage;-;+12147254219',
      '2026-04-07T20:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );

    expect(
      isBlueBubblesExplicitAsk('what should I say back', {
        chatJid: 'bb:iMessage;-;+12147254219',
        hasRecentCompanionContext: true,
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('what am I forgetting', {
        chatJid: 'bb:iMessage;-;+12147254219',
        hasRecentCompanionContext: true,
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('sounds good', {
        chatJid: 'bb:iMessage;-;+12147254219',
        hasRecentCompanionContext: true,
      }),
    ).toBe(false);
    expect(
      isBlueBubblesExplicitAsk('what should I say back', {
        chatJid: 'bb:iMessage;-;+12147254219',
        hasRecentCompanionContext: false,
      }),
    ).toBe(false);
  });

  it('keeps explicit @Andrea asks ahead of pending continuation wakeups', () => {
    expect(
      decideBlueBubblesCompanionIngress('@Andrea yes', {
        pendingLocalContinuationKind: 'google_calendar_create',
      }),
    ).toEqual({ kind: 'explicit_ask' });
  });

  it('treats a bare self-thread reply-help ask as an explicit ask', () => {
    expect(
      decideBlueBubblesCompanionIngress('what should I say back', {
        chatJid: 'bb:iMessage;-;+14695405551',
      }),
    ).toEqual({ kind: 'explicit_ask' });
  });

  it('allows a bare message-action follow-up when a draft is already open in the same BlueBubbles chat', () => {
    expect(
      decideBlueBubblesCompanionIngress('send it later tonight', {
        hasOpenMessageActionFollowup: true,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'action_draft',
    });
  });

  it('allows a bare follow-up when a pending calendar create exists on the canonical self-thread alias', () => {
    const seenChatJids: string[] = [];
    const pendingKind = resolveBlueBubblesPendingLocalContinuationKind({
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      hasGoogleCalendarCreate: (chatJid) => {
        seenChatJids.push(chatJid);
        return chatJid === 'bb:iMessage;-;+14695405551';
      },
      hasGoogleCalendarReminder: () => false,
      hasGoogleCalendarEventAction: () => false,
      hasCalendarAutomation: () => false,
      hasActionReminder: () => false,
      hasActionDraft: () => false,
    });

    expect(pendingKind).toBe('google_calendar_create');
    expect(seenChatJids).toContain('bb:iMessage;-;+14695405551');
    expect(
      decideBlueBubblesCompanionIngress('Yes', {
        pendingLocalContinuationKind: pendingKind,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'google_calendar_create',
    });
    expect(
      decideBlueBubblesCompanionIngress('cancel', {
        pendingLocalContinuationKind: pendingKind,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'google_calendar_create',
    });
  });

  it('checks both self-thread aliases for exact-keyed pending local follow-ups', () => {
    const seenChatJids: string[] = [];
    const pendingKind = resolveBlueBubblesPendingLocalContinuationKind({
      chatJid: 'bb:iMessage;-;+14695405551',
      hasGoogleCalendarCreate: () => false,
      hasGoogleCalendarReminder: () => false,
      hasGoogleCalendarEventAction: () => false,
      hasCalendarAutomation: () => false,
      hasActionReminder: (chatJid) => {
        seenChatJids.push(chatJid);
        return chatJid === 'bb:iMessage;-;jeffstory007@gmail.com';
      },
      hasActionDraft: () => false,
    });

    expect(pendingKind).toBe('action_reminder');
    expect(seenChatJids).toContain('bb:iMessage;-;+14695405551');
    expect(seenChatJids).toContain('bb:iMessage;-;jeffstory007@gmail.com');
  });

  it.each([
    {
      label: 'calendar reminder',
      expected: 'google_calendar_reminder' as const,
      resolver: 'hasGoogleCalendarReminder' as const,
    },
    {
      label: 'calendar event action',
      expected: 'google_calendar_event_action' as const,
      resolver: 'hasGoogleCalendarEventAction' as const,
    },
    {
      label: 'calendar automation',
      expected: 'calendar_automation' as const,
      resolver: 'hasCalendarAutomation' as const,
    },
    {
      label: 'action draft',
      expected: 'action_draft' as const,
      resolver: 'hasActionDraft' as const,
    },
  ])(
    'allows bare follow-ups for a pending $label across BlueBubbles self-thread aliases',
    ({ expected, resolver }) => {
      const seenChatJids: string[] = [];
      const emailAlias = 'bb:iMessage;-;jeffstory007@gmail.com';
      const canonicalAlias = 'bb:iMessage;-;+14695405551';
      const handlers: {
        hasGoogleCalendarCreate(chatJid: string): boolean;
        hasGoogleCalendarReminder(chatJid: string): boolean;
        hasGoogleCalendarEventAction(chatJid: string): boolean;
        hasCalendarAutomation(chatJid: string): boolean;
        hasActionReminder(chatJid: string): boolean;
        hasActionDraft(chatJid: string): boolean;
      } = {
        hasGoogleCalendarCreate: () => false,
        hasGoogleCalendarReminder: () => false,
        hasGoogleCalendarEventAction: () => false,
        hasCalendarAutomation: () => false,
        hasActionReminder: () => false,
        hasActionDraft: () => false,
      };

      handlers[resolver] = (chatJid: string) => {
        seenChatJids.push(chatJid);
        return chatJid === emailAlias;
      };

      const pendingKind = resolveBlueBubblesPendingLocalContinuationKind({
        chatJid: canonicalAlias,
        ...handlers,
      });

      expect(pendingKind).toBe(expected);
      expect(seenChatJids).toContain(canonicalAlias);
      expect(seenChatJids).toContain(emailAlias);
      expect(
        decideBlueBubblesCompanionIngress('11am', {
          pendingLocalContinuationKind: pendingKind,
        }),
      ).toEqual({
        kind: 'pending_local_continuation',
        continuationKind: expected,
      });
    },
  );

  it('still ignores bare chatter when no pending continuation exists', () => {
    expect(
      decideBlueBubblesCompanionIngress('yes', {
        pendingLocalContinuationKind: null,
      }),
    ).toEqual({ kind: 'ignored_chatter' });
    expect(
      decideBlueBubblesCompanionIngress('11am', {
        pendingLocalContinuationKind: null,
      }),
    ).toEqual({ kind: 'ignored_chatter' });
    expect(
      decideBlueBubblesCompanionIngress("what's on my schedule tomorrow", {
        pendingLocalContinuationKind: null,
      }),
    ).toEqual({ kind: 'ignored_chatter' });
  });

  it('strips @Andrea mentions before shared capability routing', () => {
    expect(stripBlueBubblesAndreaMention('@Andrea what am I forgetting')).toBe(
      'what am I forgetting',
    );
    expect(stripBlueBubblesAndreaMention('hey @Andrea, summarize this')).toBe(
      'hey summarize this',
    );
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

  it('prefers a fresh same-thread message action over pilot-only history', () => {
    insertPilotJourneyEvent(
      buildEvent({
        chatJid: 'bb:iMessage;+;chat-pilot',
        startedAt: '2026-04-07T19:30:00.000Z',
        completedAt: '2026-04-07T19:31:00.000Z',
      }),
    );
    upsertMessageAction({
      messageActionId: 'msg-action-self-thread',
      groupFolder: 'main',
      sourceType: 'manual_prompt',
      sourceKey: 'self-thread-proof-gap',
      sourceSummary: 'Draft text message to Candace.',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;chat-candace',
        personName: 'Candace',
      }),
      draftText: 'Hey Candace, tonight still works for me.',
      trustLevel: 'approve_before_send',
      sendStatus: 'drafted',
      followupAt: null,
      requiresApproval: true,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({ personName: 'Candace' }),
      platformMessageId: null,
      scheduledTaskId: null,
      approvedAt: null,
      lastActionKind: null,
      lastActionAt: '2026-04-07T20:20:00.000Z',
      dedupeKey: 'self-thread-proof-gap',
      presentationChatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: '2026-04-07T20:19:00.000Z',
      lastUpdatedAt: '2026-04-07T20:20:00.000Z',
      sentAt: null,
    });

    expect(
      resolveMostRecentBlueBubblesCompanionChat({
        groupFolder: 'main',
        maxAgeHours: 12,
        now: new Date('2026-04-07T20:30:00.000Z'),
      }),
    ).toEqual({
      chatJid: 'bb:iMessage;-;+14695405551',
      engagedAt: '2026-04-07T20:20:00.000Z',
    });
  });

  it('prefers a fresh active group continuity target over stale pilot-only history', () => {
    insertPilotJourneyEvent(
      buildEvent({
        chatJid: 'bb:iMessage;+;chat-pilot',
        startedAt: '2026-04-07T19:30:00.000Z',
        completedAt: '2026-04-07T19:31:00.000Z',
      }),
    );
    storeChatMetadata(
      'bb:iMessage;+;group-fresh',
      '2026-04-07T19:31:00.000Z',
      'Family Group',
      'bluebubbles',
      true,
    );
    upsertMessageAction({
      messageActionId: 'msg-action-group-thread',
      groupFolder: 'main',
      sourceType: 'manual_prompt',
      sourceKey: 'group-proof-gap',
      sourceSummary: 'Draft group reply.',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:iMessage;+;group-fresh',
        personName: 'Family Group',
        isGroup: true,
      }),
      draftText: 'Dinner around 7 works here too.',
      trustLevel: 'approve_before_send',
      sendStatus: 'drafted',
      followupAt: null,
      requiresApproval: true,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({ personName: 'Family Group' }),
      platformMessageId: null,
      scheduledTaskId: null,
      approvedAt: null,
      lastActionKind: null,
      lastActionAt: '2026-04-07T19:45:00.000Z',
      dedupeKey: 'group-proof-gap',
      presentationChatJid: 'bb:iMessage;+;group-fresh',
      presentationThreadId: null,
      presentationMessageId: 'bb:group-draft-1',
      createdAt: '2026-04-07T19:44:00.000Z',
      lastUpdatedAt: '2026-04-07T19:45:00.000Z',
      sentAt: null,
    });

    expect(
      resolveMostRecentBlueBubblesCompanionChat({
        groupFolder: 'main',
        maxAgeHours: 12,
        now: new Date('2026-04-07T20:30:00.000Z'),
      }),
    ).toEqual({
      chatJid: 'bb:iMessage;+;group-fresh',
      engagedAt: '2026-04-07T19:45:00.000Z',
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
