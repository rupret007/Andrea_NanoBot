import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildCommunicationIdentityReviewActionRows,
  buildCommunicationIdentityReviewSnapshot,
  handleCommunicationIdentityReview,
  parseCommunicationIdentityReviewCommand,
} from './communication-identity-review.js';
import {
  _initTestDatabase,
  decideCommunicationThreadIdentity,
  getCommunicationIdentityReview,
  getCommunicationThread,
  setRegisteredGroup,
  storeChatMetadata,
  updateChatName,
  updateCommunicationThread,
  upsertCommunicationThread,
  upsertProfileSubject,
} from './db.js';
import { buildPersonalContextGraph } from './personal-context-graph.js';
import { BLUEBUBBLES_CANONICAL_SELF_THREAD_JID } from './bluebubbles-self-thread.js';
import type { CommunicationThreadRecord, ProfileSubject } from './types.js';

const now = '2026-07-12T03:00:00.000Z';

function seedPerson(
  id: string,
  displayName: string,
  canonicalName = displayName.toLocaleLowerCase('en-US'),
): ProfileSubject {
  const subject: ProfileSubject = {
    id,
    groupFolder: 'main',
    kind: 'person',
    canonicalName,
    displayName,
    createdAt: now,
    updatedAt: now,
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function seedThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const record: CommunicationThreadRecord = {
    id: overrides.id || 'communication:riley',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Riley',
    linkedSubjectIds: overrides.linkedSubjectIds || [],
    linkedLifeThreadIds: overrides.linkedLifeThreadIds || [],
    channel: overrides.channel || 'bluebubbles',
    channelChatJid: overrides.channelChatJid || 'bb:iMessage;-;+14695550123',
    lastInboundSummary: overrides.lastInboundSummary || 'Metadata summary.',
    lastOutboundSummary: overrides.lastOutboundSummary || null,
    followupState: overrides.followupState || 'unknown',
    urgency: overrides.urgency || 'none',
    followupDueAt: overrides.followupDueAt || null,
    suggestedNextAction: overrides.suggestedNextAction || null,
    toneStyleHints: overrides.toneStyleHints || [],
    lastContactAt: overrides.lastContactAt || now,
    lastMessageId: overrides.lastMessageId || null,
    linkedTaskId: overrides.linkedTaskId || null,
    inferenceState: overrides.inferenceState || 'assistant_inferred',
    trackingMode: overrides.trackingMode || 'default',
    createdAt: overrides.createdAt || now,
    updatedAt: overrides.updatedAt || now,
    disabledAt: overrides.disabledAt || null,
  };
  upsertCommunicationThread(record);
  storeChatMetadata(
    record.channelChatJid!,
    now,
    record.title,
    'bluebubbles',
    record.channelChatJid!.includes(';+;'),
  );
  return record;
}

beforeEach(() => {
  _initTestDatabase();
});

describe('communication identity review', () => {
  it('parses only explicit review, confirmation, dismissal, and reset commands', () => {
    expect(
      parseCommunicationIdentityReviewCommand(
        'review communication identities',
      ),
    ).toEqual({ kind: 'list' });
    expect(
      parseCommunicationIdentityReviewCommand(
        'confirm identity "Riley" is "Riley Smith"',
      ),
    ).toEqual({
      kind: 'confirm',
      threadTitle: 'Riley',
      personName: 'Riley Smith',
    });
    expect(
      parseCommunicationIdentityReviewCommand('dismiss identity "Band chat"'),
    ).toEqual({ kind: 'dismiss', threadTitle: 'Band chat' });
    expect(
      parseCommunicationIdentityReviewCommand(
        'clear identity review "Band chat"',
      ),
    ).toEqual({ kind: 'clear', threadTitle: 'Band chat' });
    expect(
      parseCommunicationIdentityReviewCommand('Riley texted me'),
    ).toBeNull();
  });

  it('proposes only a unique exact profile-name match and never identifiers', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    seedThread({
      id: 'communication:number',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });
    seedThread({
      id: 'communication:group',
      title: 'Riley',
      channelChatJid: 'bb:iMessage;+;chat123',
    });

    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    expect(
      snapshot.items.find((item) => item.threadId === 'communication:riley'),
    ).toMatchObject({
      isGroup: false,
      candidate: {
        subjectId: 'person-riley',
        reason: 'exact_profile_name_match',
      },
    });
    expect(
      snapshot.items.find((item) => item.threadId === 'communication:number')
        ?.candidate,
    ).toBeNull();
    expect(
      snapshot.items.find((item) => item.threadId === 'communication:group'),
    ).toMatchObject({ isGroup: true, candidate: null });
  });

  it('uses stable opaque review keys and never returns raw identifier labels', () => {
    seedPerson('person-candace', 'Candace');
    seedPerson('person-self-word', 'You');
    seedPerson('person-identifier', '+1 (469) 555-0188');
    seedPerson('person-family-category', 'close family');
    seedPerson('person-school-category', 'school contacts');
    seedPerson('person-riley-one', 'Riley', 'riley-one');
    seedPerson('person-riley-two', 'Riley', 'riley-two');
    seedThread({
      id: 'communication:number',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });
    const first = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const second = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const item = first.items.find(
      (candidate) => candidate.threadId === 'communication:number',
    )!;
    expect(item.reviewKey).toMatch(/^R-[A-F0-9]{8}$/);
    expect(
      second.items.find(
        (candidate) => candidate.threadId === 'communication:number',
      )?.reviewKey,
    ).toBe(item.reviewKey);
    expect(first.availablePeopleNames).toEqual(['Candace']);

    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });
    expect(response.replyText).toContain(`[${item.reviewKey}]`);
    expect(response.replyText).toContain('Unlabeled direct conversation');
    expect(response.replyText).toContain('Existing profile people');
    expect(response.replyText).toContain('Candace');
    expect(response.replyText).not.toContain('+1 (469) 555-0199');
    expect(response.replyText).not.toContain('+1 (469) 555-0188');
    expect(response.replyText).not.toMatch(/\bYou\b/);
  });

  it('offers bounded Telegram owner choices for only the first unresolved item', () => {
    seedPerson('person-candace', 'Candace');
    seedPerson('person-travis', 'Travis');
    seedThread({
      id: 'communication:number-one',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });
    seedThread({
      id: 'communication:number-two',
      title: '+1 (469) 555-0187',
      channelChatJid: 'bb:iMessage;-;+14695550187',
    });

    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });
    const firstKey = response.snapshot!.items.find(
      (item) => !item.review,
    )!.reviewKey;
    const actions = response.inlineActionRows!.flat();
    expect(actions.map((action) => action.label)).toEqual([
      'Link Candace',
      'Link Travis',
      'Keep without person link',
    ]);
    expect(actions.every((action) => action.actionId?.includes(firstKey))).toBe(
      true,
    );
    expect(
      actions.every(
        (action) => Buffer.byteLength(action.actionId || '', 'utf8') <= 64,
      ),
    ).toBe(true);
    expect(JSON.stringify(actions)).not.toContain('+1 (469)');

    const changed = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: actions[0]!.actionId!,
    });
    const nextKey = changed.snapshot!.items.find(
      (item) => !item.review,
    )!.reviewKey;
    expect(changed).toMatchObject({ changed: true });
    expect(changed.replyText).toContain(`Next: [${nextKey}]`);
    expect(changed.replyText).not.toContain('+1 (469)');
    expect(
      changed
        .inlineActionRows!.flat()
        .every((action) => action.actionId?.includes(nextKey)),
    ).toBe(true);
  });

  it('prioritizes an exact profile-name match ahead of opaque unknown conversations', () => {
    seedPerson('person-candace', 'Candace');
    seedThread({
      id: 'communication:opaque-first',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });
    seedThread({
      id: 'communication:exact-second',
      title: 'Candace',
      channelChatJid: 'bb:iMessage;-;+14695550188',
    });

    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });
    const exact = response.snapshot!.items.find(
      (item) => item.threadId === 'communication:exact-second',
    )!;

    expect(response.replyText).toContain(`[${exact.reviewKey}] Candace`);
    expect(response.inlineActionRows?.[0]?.[0]).toMatchObject({
      label: 'Confirm Candace',
    });
    expect(response.replyText).not.toContain('+1 (469) 555-0199');
  });

  it('uses safe current chat metadata when the stored communication title is generic', () => {
    seedPerson('person-candace', 'Candace');
    const thread = seedThread({
      id: 'communication:generic-title',
      title: 'Messages chat',
      channelChatJid: 'bb:iMessage;-;+14695550188',
    });
    updateChatName(thread.channelChatJid!, 'Candace');

    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const item = snapshot.items.find(
      (candidate) => candidate.threadId === thread.id,
    );

    expect(item).toMatchObject({
      threadTitle: 'Candace',
      candidate: {
        subjectId: 'person-candace',
        reason: 'exact_profile_name_match',
      },
    });
  });

  it('never substitutes identifier-shaped current chat metadata', () => {
    const thread = seedThread({
      id: 'communication:generic-identifier',
      title: 'Messages chat',
      channelChatJid: 'bb:iMessage;-;+14695550188',
    });
    updateChatName(thread.channelChatJid!, '+1 (469) 555-0188');

    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });

    expect(response.replyText).toContain('Messages chat');
    expect(response.replyText).not.toContain('+1 (469) 555-0188');
  });

  it('excludes the configured owner self-thread from identity review and graph gaps', () => {
    seedThread({
      id: 'communication:owner-self-thread',
      title: 'Jeff',
      channelChatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    });

    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });
    const graph = buildPersonalContextGraph({ groupFolder: 'main' });

    expect(snapshot).toMatchObject({
      selfThreads: 1,
      identityApplicableThreads: 0,
      unreviewedThreads: 0,
    });
    expect(response.inlineActionRows).toEqual([]);
    expect(response.replyText).toContain('owner self-thread is excluded');
    expect(graph.topGaps.join(' ')).not.toContain(
      'Confirm or dismiss identity links',
    );
  });

  it('skips independently linked threads when selecting the next review card', () => {
    seedPerson('person-candace', 'Candace');
    seedPerson('person-travis', 'Travis');
    seedThread({
      id: 'communication:already-linked',
      title: 'Candace',
      linkedSubjectIds: ['person-candace'],
      inferenceState: 'user_confirmed',
      urgency: 'overdue',
      lastContactAt: '2026-07-12T04:00:00.000Z',
    });
    seedThread({
      id: 'communication:needs-review',
      title: '+1 (469) 555-0187',
      channelChatJid: 'bb:iMessage;-;+14695550187',
      lastContactAt: '2026-07-12T03:00:00.000Z',
    });

    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const unresolved = snapshot.items.find(
      (item) => item.threadId === 'communication:needs-review',
    )!;
    const actions = buildCommunicationIdentityReviewActionRows(snapshot).flat();

    expect(snapshot.resolvedThreads).toBe(1);
    expect(snapshot.unreviewedThreads).toBe(1);
    expect(actions).toHaveLength(3);
    expect(
      actions.every((action) =>
        action.actionId?.includes(unresolved.reviewKey),
      ),
    ).toBe(true);
  });

  it('returns explicit next commands in Messages where inline controls are unavailable', () => {
    seedPerson('person-candace', 'Candace');
    seedThread({
      id: 'communication:number-one',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
      lastContactAt: '2026-07-12T04:00:00.000Z',
    });
    seedThread({
      id: 'communication:number-two',
      title: '+1 (469) 555-0187',
      channelChatJid: 'bb:iMessage;-;+14695550187',
      lastContactAt: '2026-07-12T03:00:00.000Z',
    });
    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    const first = snapshot.items.find(
      (item) => item.threadId === 'communication:number-one',
    )!;
    const next = snapshot.items.find(
      (item) => item.threadId === 'communication:number-two',
    )!;

    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;+14695405551',
      text: `link identity ${first.reviewKey} to "Candace"`,
    });

    expect(response).toMatchObject({ changed: true });
    expect(response.inlineActionRows).toBeUndefined();
    expect(response.replyText).toContain(`[${next.reviewKey}]`);
    expect(response.replyText).toContain(
      `link identity ${next.reviewKey} to "Candace"`,
    );
    expect(response.replyText).toContain(`dismiss identity ${next.reviewKey}`);
    expect(response.replyText).not.toContain('below');
    expect(response.replyText).not.toContain('+1 (469)');
  });

  it('resolves authoritative group metadata without asking for a person decision', () => {
    seedThread({
      id: 'communication:group-only',
      title: 'Family thread',
      channelChatJid: 'bb:iMessage;+;chat-family',
    });
    const snapshot = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    });
    expect(snapshot).toMatchObject({
      totalThreads: 1,
      groupThreads: 1,
      identityApplicableThreads: 0,
      resolvedThreads: 1,
      unreviewedThreads: 0,
    });
    expect(buildCommunicationIdentityReviewActionRows(snapshot)).toEqual([]);
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'review communication identities',
    });
    expect(response.replyText).toContain(
      'group conversation is already excluded from single-person linking',
    );
    expect(
      getCommunicationIdentityReview('communication:group-only'),
    ).toBeUndefined();
  });

  it('confirms, dismisses, and clears by opaque review key', () => {
    seedPerson('person-candace', 'Candace');
    seedThread({
      id: 'communication:number',
      title: '+1 (469) 555-0199',
      channelChatJid: 'bb:iMessage;-;+14695550199',
    });
    const key = buildCommunicationIdentityReviewSnapshot({
      groupFolder: 'main',
    }).items[0]!.reviewKey;
    const confirmed = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: `link identity ${key} to "Candace"`,
    });
    expect(confirmed).toMatchObject({ changed: true });
    expect(confirmed.replyText).not.toContain('+1 (469) 555-0199');
    expect(
      getCommunicationThread('communication:number')?.linkedSubjectIds,
    ).toEqual(['person-candace']);

    expect(
      handleCommunicationIdentityReview({
        groupFolder: 'main',
        channel: 'telegram',
        text: `clear identity review ${key}`,
      }),
    ).toMatchObject({ changed: true });
    expect(
      handleCommunicationIdentityReview({
        groupFolder: 'main',
        channel: 'telegram',
        text: `dismiss identity ${key}`,
      }),
    ).toMatchObject({ changed: true });
  });

  it('does not echo an unknown review reference back to the owner', () => {
    seedThread();
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'link identity "private-secret-reference" to "Candace"',
    });
    expect(response).toMatchObject({ changed: false });
    expect(response.replyText).not.toContain('private-secret-reference');
  });

  it('confirms an existing person idempotently with separate provenance', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    const first = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Riley"',
      now: new Date(now),
    });
    const second = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Riley"',
      now: new Date('2026-07-12T03:05:00.000Z'),
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(
      getCommunicationThread('communication:riley')?.linkedSubjectIds,
    ).toEqual(['person-riley']);
    expect(getCommunicationIdentityReview('communication:riley')).toMatchObject(
      {
        decision: 'confirmed',
        linkedSubjectId: 'person-riley',
        sourceChannel: 'telegram',
        createdAt: now,
        reviewedAt: '2026-07-12T03:05:00.000Z',
      },
    );
    const graph = buildPersonalContextGraph({ groupFolder: 'main' });
    expect(graph.coverage.linkedCommunicationThreads).toBe(1);
    expect(graph.coverage.identityReviewedCommunicationThreads).toBe(1);
    expect(graph.coverage.resolvedCommunicationThreads).toBe(1);
    expect(
      graph.edges.find((edge) => edge.edgeKind === 'message_about'),
    ).toMatchObject({
      confidence: 0.86,
      reason: 'Owner explicitly confirmed this communication identity link.',
    });
  });

  it('dismisses a group identity without creating a person link', () => {
    seedPerson('person-riley', 'Riley');
    seedThread({
      id: 'communication:band',
      title: 'Band chat',
      channelChatJid: 'bb:iMessage;+;chat123',
    });
    expect(
      handleCommunicationIdentityReview({
        groupFolder: 'main',
        channel: 'telegram',
        text: 'confirm identity "Band chat" is "Riley"',
      }),
    ).toMatchObject({ changed: false });
    expect(
      decideCommunicationThreadIdentity({
        groupFolder: 'main',
        threadId: 'communication:band',
        decision: 'confirmed',
        subjectId: 'person-riley',
        sourceChannel: 'telegram',
        now,
      }),
    ).toEqual({ ok: false, reason: 'group_thread_conflict' });

    const dismissed = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'dismiss identity "Band chat"',
      now: new Date(now),
    });
    expect(dismissed.changed).toBe(true);
    expect(
      getCommunicationThread('communication:band')?.linkedSubjectIds,
    ).toEqual([]);
    expect(getCommunicationIdentityReview('communication:band')).toMatchObject({
      decision: 'dismissed',
      linkedSubjectId: null,
    });
    const graph = buildPersonalContextGraph({ groupFolder: 'main' });
    expect(graph.coverage.linkedCommunicationThreads).toBe(0);
    expect(graph.coverage.resolvedCommunicationThreads).toBe(1);
    expect(graph.topGaps.join(' ')).not.toContain(
      'Confirm or dismiss identity links',
    );
  });

  it('clears only the link owned by the identity review', () => {
    seedPerson('person-riley', 'Riley');
    seedPerson('person-candace', 'Candace');
    seedThread({
      linkedSubjectIds: ['person-candace'],
      inferenceState: 'mixed',
    });
    handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Riley"',
    });
    expect(
      getCommunicationThread('communication:riley')?.linkedSubjectIds,
    ).toEqual(['person-candace', 'person-riley']);

    const cleared = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'clear identity review "Riley"',
    });
    expect(cleared.changed).toBe(true);
    expect(
      getCommunicationIdentityReview('communication:riley'),
    ).toBeUndefined();
    expect(
      getCommunicationThread('communication:riley')?.linkedSubjectIds,
    ).toEqual(['person-candace']);
  });

  it('replaces stale assistant-inferred identity context on explicit review', () => {
    seedPerson('person-riley', 'Riley');
    seedPerson('person-wrong', 'Wrong Person');
    seedThread({
      linkedSubjectIds: ['person-wrong'],
      linkedLifeThreadIds: ['assistant-derived-life-thread'],
      inferenceState: 'assistant_inferred',
    });

    handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Riley"',
    });
    expect(getCommunicationThread('communication:riley')).toMatchObject({
      linkedSubjectIds: ['person-riley'],
      linkedLifeThreadIds: [],
    });
  });

  it('does not let dismissal erase an independently confirmed link', () => {
    seedPerson('person-riley', 'Riley');
    seedThread({
      linkedSubjectIds: ['person-riley'],
      inferenceState: 'user_confirmed',
    });
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'dismiss identity "Riley"',
    });
    expect(response).toMatchObject({ changed: false });
    expect(response.replyText).toContain('will not erase');
    expect(
      getCommunicationThread('communication:riley')?.linkedSubjectIds,
    ).toEqual(['person-riley']);
    expect(
      getCommunicationIdentityReview('communication:riley'),
    ).toBeUndefined();
  });

  it('refuses unknown or ambiguous people instead of creating identities', () => {
    seedPerson('person-riley-1', 'Riley', 'riley-one');
    seedPerson('person-riley-2', 'Riley', 'riley-two');
    seedThread();
    const ambiguous = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Riley"',
    });
    const unknown = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'confirm identity "Riley" is "Someone Else"',
    });
    expect(ambiguous).toMatchObject({ changed: false });
    expect(unknown).toMatchObject({ changed: false });
    expect(
      getCommunicationIdentityReview('communication:riley'),
    ).toBeUndefined();
    expect(
      getCommunicationThread('communication:riley')?.linkedSubjectIds,
    ).toEqual([]);
  });

  it('keeps private identity review out of non-owner Messages threads', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;+15555550111',
      text: 'review communication identities',
    });
    expect(response).toMatchObject({ handled: true, changed: false });
    expect(response.replyText).toContain('private');
    expect(response.replyText).not.toContain('Riley');
  });

  it('keeps private identity review out of non-main Telegram chats', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:not-the-main-owner-chat',
      text: 'review communication identities',
    });
    expect(response).toMatchObject({ handled: true, changed: false });
    expect(response.replyText).toContain('private');
    expect(response.replyText).not.toContain('Riley');
  });

  it('allows read-only review in the registered main Telegram chat', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    setRegisteredGroup('tg:main-owner', {
      name: 'Main owner chat',
      folder: 'main',
      trigger: '@Andrea',
      added_at: now,
      requiresTrigger: false,
      isMain: true,
    });
    const response = handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:main-owner',
      text: 'review communication identities',
    });
    expect(response).toMatchObject({ handled: true, changed: false });
    expect(response.replyText).toContain('Riley');
  });

  it('does not let a disabled reviewed thread inflate active readiness', () => {
    seedPerson('person-riley', 'Riley');
    seedThread();
    handleCommunicationIdentityReview({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'dismiss identity "Riley"',
    });
    updateCommunicationThread('communication:riley', {
      disabledAt: now,
      trackingMode: 'disabled',
    });

    const graph = buildPersonalContextGraph({ groupFolder: 'main' });
    expect(graph.coverage.communicationThreads).toBe(0);
    expect(graph.coverage.identityReviewedCommunicationThreads).toBe(0);
    expect(graph.coverage.resolvedCommunicationThreads).toBe(0);
  });
});
