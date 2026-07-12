import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildCommunicationIdentityReviewSnapshot,
  handleCommunicationIdentityReview,
  parseCommunicationIdentityReviewCommand,
} from './communication-identity-review.js';
import {
  _initTestDatabase,
  getCommunicationIdentityReview,
  getCommunicationThread,
  setRegisteredGroup,
  storeChatMetadata,
  updateCommunicationThread,
  upsertCommunicationThread,
  upsertProfileSubject,
} from './db.js';
import { buildPersonalContextGraph } from './personal-context-graph.js';
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
