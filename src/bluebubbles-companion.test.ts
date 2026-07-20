import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  shouldHandleBlueBubblesProofDrillLocally,
  shouldPreferBlueBubblesLocalMessageActionFollowup,
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
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;+13125550101',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'bb:iMessage;-;+13125550101,bb:iMessage;-;owner@example.invalid',
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps companion control private to the configured owner self-thread', () => {
    const selfThread = 'bb:iMessage;-;+13125550101';
    expect(
      isBlueBubblesExplicitAsk('@Andrea hi', { chatJid: selfThread }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('@openclaw hi', { chatJid: selfThread }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('@Andrea what am I forgetting', {
        chatJid: selfThread,
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('@Andrea summarize this', {
        chatJid: selfThread,
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('@Andrea anything else', {
        chatJid: selfThread,
        hasRecentCompanionContext: true,
      }),
    ).toBe(true);
    for (const chatJid of [
      'bb:iMessage;-;+12025550104',
      'bb:iMessage;+;family-group',
    ]) {
      expect(
        isBlueBubblesExplicitAsk('@Andrea summarize this', {
          chatJid,
          hasRecentCompanionContext: true,
        }),
      ).toBe(false);
    }
    expect(isBlueBubblesExplicitAsk('@Andrea summarize this')).toBe(false);
    expect(
      isBlueBubblesExplicitAsk('Andrea, hi', { chatJid: selfThread }),
    ).toBe(false);
    expect(
      isBlueBubblesExplicitAsk('sounds good', { chatJid: selfThread }),
    ).toBe(false);
  });

  it('allows direct assistant asks in the canonical BlueBubbles self-thread without @Andrea', () => {
    expect(
      isBlueBubblesExplicitAsk('hi', {
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('what should I say back', {
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('what am I forgetting', {
        chatJid: 'bb:iMessage;-;owner@example.invalid',
      }),
    ).toBe(true);
    expect(
      isBlueBubblesExplicitAsk('sounds good', {
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
    ).toBe(false);
  });

  it('recognizes explicit BlueBubbles proof-drill start requests', () => {
    expect(isBlueBubblesProofDrillStartRequest('start proof drill')).toBe(true);
    expect(
      isBlueBubblesProofDrillStartRequest('@Andrea start bluebubbles proof'),
    ).toBe(true);
    expect(
      isBlueBubblesProofDrillStartRequest('start blue bubbles proof'),
    ).toBe(true);
    expect(isBlueBubblesProofDrillStartRequest('send it later tonight')).toBe(
      false,
    );
  });

  it('never lets recent context turn an ordinary direct chat into a control surface', () => {
    const contactChat = 'bb:iMessage;-;+12025550104';
    storeChatMetadata(
      contactChat,
      '2026-04-07T20:05:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );

    expect(
      isBlueBubblesExplicitAsk('what should I say back', {
        chatJid: contactChat,
        hasRecentCompanionContext: true,
      }),
    ).toBe(false);
    expect(
      isBlueBubblesExplicitAsk('@Andrea what am I forgetting', {
        chatJid: contactChat,
        hasRecentCompanionContext: true,
      }),
    ).toBe(false);
    expect(
      decideBlueBubblesCompanionIngress('@Andrea send it', {
        chatJid: contactChat,
        hasRecentCompanionContext: true,
        hasOpenMessageActionFollowup: true,
        pendingLocalContinuationKind: 'action_draft',
      }),
    ).toEqual({ kind: 'ignored_chatter' });
    expect(
      resolveBlueBubblesPendingLocalContinuationKind({
        chatJid: contactChat,
        hasGoogleCalendarCreate: () => true,
        hasGoogleCalendarReminder: () => true,
        hasGoogleCalendarEventAction: () => true,
        hasCalendarAutomation: () => true,
        hasActionReminder: () => true,
        hasActionDraft: () => true,
      }),
    ).toBeNull();
  });

  it('keeps explicit @Andrea asks ahead of pending continuation wakeups', () => {
    expect(
      decideBlueBubblesCompanionIngress('@Andrea yes', {
        chatJid: 'bb:iMessage;-;+13125550101',
        pendingLocalContinuationKind: 'google_calendar_create',
      }),
    ).toEqual({ kind: 'explicit_ask' });
  });

  it('treats a bare self-thread reply-help ask as an explicit ask', () => {
    expect(
      decideBlueBubblesCompanionIngress('what should I say back', {
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
    ).toEqual({ kind: 'explicit_ask' });
  });

  it('allows a bare message-action follow-up when a draft is already open in the same BlueBubbles chat', () => {
    expect(
      decideBlueBubblesCompanionIngress('send it later tonight', {
        chatJid: 'bb:iMessage;-;+13125550101',
        hasOpenMessageActionFollowup: true,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'action_draft',
    });
  });

  it('prefers an applicable local message action over a platform hold', () => {
    expect(
      shouldPreferBlueBubblesLocalMessageActionFollowup({
        conversationChannel: 'bluebubbles',
        requestRoute: 'direct_assistant',
        operationRecognized: true,
        actionResolved: true,
        policyAllows: true,
      }),
    ).toBe(true);
  });

  it('does not bypass a platform hold for unrelated or disallowed turns', () => {
    const base = {
      conversationChannel: 'bluebubbles',
      requestRoute: 'direct_assistant',
      operationRecognized: true,
      actionResolved: true,
      policyAllows: true,
    };
    expect(
      shouldPreferBlueBubblesLocalMessageActionFollowup({
        ...base,
        conversationChannel: 'telegram',
      }),
    ).toBe(false);
    expect(
      shouldPreferBlueBubblesLocalMessageActionFollowup({
        ...base,
        actionResolved: false,
      }),
    ).toBe(false);
    expect(
      shouldPreferBlueBubblesLocalMessageActionFollowup({
        ...base,
        policyAllows: false,
      }),
    ).toBe(false);
  });

  it('keeps proof-start recovery on the deterministic BlueBubbles path', () => {
    expect(
      shouldHandleBlueBubblesProofDrillLocally({
        conversationChannel: 'bluebubbles',
        requestRoute: 'direct_assistant',
        text: '@Andrea start bluebubbles proof',
      }),
    ).toBe(true);
    expect(
      shouldHandleBlueBubblesProofDrillLocally({
        conversationChannel: 'telegram',
        requestRoute: 'direct_assistant',
        text: '@Andrea start bluebubbles proof',
      }),
    ).toBe(false);
    expect(
      shouldHandleBlueBubblesProofDrillLocally({
        conversationChannel: 'bluebubbles',
        requestRoute: 'direct_assistant',
        text: 'tell me about bluebubbles',
      }),
    ).toBe(false);
  });

  it('routes @Andrea-prefixed message-action follow-ups before generic asks', () => {
    expect(
      decideBlueBubblesCompanionIngress('@Andrea send it later tonight', {
        chatJid: 'bb:iMessage;-;+13125550101',
        hasOpenMessageActionFollowup: true,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'action_draft',
    });
    expect(
      decideBlueBubblesCompanionIngress('@Andrea what am I forgetting', {
        chatJid: 'bb:iMessage;-;+13125550101',
        hasOpenMessageActionFollowup: false,
      }),
    ).toEqual({ kind: 'explicit_ask' });
  });

  it('allows a bare follow-up when a pending calendar create exists on the canonical self-thread alias', () => {
    const seenChatJids: string[] = [];
    const pendingKind = resolveBlueBubblesPendingLocalContinuationKind({
      chatJid: 'bb:iMessage;-;owner@example.invalid',
      hasGoogleCalendarCreate: (chatJid) => {
        seenChatJids.push(chatJid);
        return chatJid === 'bb:iMessage;-;+13125550101';
      },
      hasGoogleCalendarReminder: () => false,
      hasGoogleCalendarEventAction: () => false,
      hasCalendarAutomation: () => false,
      hasActionReminder: () => false,
      hasActionDraft: () => false,
    });

    expect(pendingKind).toBe('google_calendar_create');
    expect(seenChatJids).toContain('bb:iMessage;-;+13125550101');
    expect(
      decideBlueBubblesCompanionIngress('Yes', {
        chatJid: 'bb:iMessage;-;owner@example.invalid',
        pendingLocalContinuationKind: pendingKind,
      }),
    ).toEqual({
      kind: 'pending_local_continuation',
      continuationKind: 'google_calendar_create',
    });
    expect(
      decideBlueBubblesCompanionIngress('cancel', {
        chatJid: 'bb:iMessage;-;owner@example.invalid',
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
      chatJid: 'bb:iMessage;-;+13125550101',
      hasGoogleCalendarCreate: () => false,
      hasGoogleCalendarReminder: () => false,
      hasGoogleCalendarEventAction: () => false,
      hasCalendarAutomation: () => false,
      hasActionReminder: (chatJid) => {
        seenChatJids.push(chatJid);
        return chatJid === 'bb:iMessage;-;owner@example.invalid';
      },
      hasActionDraft: () => false,
    });

    expect(pendingKind).toBe('action_reminder');
    expect(seenChatJids).toContain('bb:iMessage;-;+13125550101');
    expect(seenChatJids).toContain('bb:iMessage;-;owner@example.invalid');
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
      const emailAlias = 'bb:iMessage;-;owner@example.invalid';
      const canonicalAlias = 'bb:iMessage;-;+13125550101';
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
          chatJid: canonicalAlias,
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
    expect(stripBlueBubblesAndreaMention('@openclaw search skills')).toBe(
      'search skills',
    );
    expect(stripBlueBubblesAndreaMention('hey @Andrea, summarize this')).toBe(
      'hey summarize this',
    );
    expect(normalizeBlueBubblesCompanionPrompt('@Andrea')).toBe('hi');
  });

  describe('cross-channel BlueBubbles handoff target safety', () => {
    beforeEach(() => {
      vi.stubEnv(
        'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
        'bb:iMessage;-;+12025550199',
      );
      vi.stubEnv(
        'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
        'bb:iMessage;-;owner@example.invalid',
      );
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('ignores recent contact pilot history and selects only the configured owner self-thread', () => {
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
        chatJid: 'bb:iMessage;-;+12025550199',
        engagedAt: '2026-04-07T20:30:00.000Z',
      });
    });

    it('keeps a contact-targeted action from changing the handoff destination', () => {
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
        presentationChatJid: 'bb:iMessage;-;owner@example.invalid',
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
        chatJid: 'bb:iMessage;-;+12025550199',
        engagedAt: '2026-04-07T20:30:00.000Z',
      });
    });

    it('never selects a contact group even when it has the freshest active continuity', () => {
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
        chatJid: 'bb:iMessage;-;+12025550199',
        engagedAt: '2026-04-07T20:30:00.000Z',
      });
    });

    it('fails closed when no owner self-thread is explicitly configured', () => {
      vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', '');
      vi.stubEnv('BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS', '');
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
});
