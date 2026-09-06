import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  communicationThreadFingerprint,
  createTask,
  decideCommunicationThreadIdentity,
  deleteReviewedCommunicationThread,
  getCommunicationIdentityReview,
  getCommunicationThread,
  getLifeThread,
  getMessagesSince,
  getOutcomeBySource,
  getProfileFact,
  getProfileSubject,
  getTaskById,
  listCommunicationSignalsForThread,
  listOutcomesForGroup,
  storeChatMetadata,
  storeMessageDirect,
  upsertCommunicationSignal,
  upsertCommunicationThread,
  upsertLifeThread,
  upsertOutcome,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import type { CommunicationThreadRecord, OutcomeRecord } from './types.js';

const NOW = '2026-09-06T06:00:00.000Z';
const CHAT = 'tg:forget-db-fixture';

function seedOutcome(
  thread: CommunicationThreadRecord,
  overrides: Partial<OutcomeRecord> = {},
): void {
  upsertOutcome({
    outcomeId: `outcome:${thread.id}`,
    groupFolder: thread.groupFolder,
    sourceType: 'communication_thread',
    sourceKey: thread.id,
    linkedRefsJson: JSON.stringify({ communicationThreadId: thread.id }),
    status: 'partial',
    completionSummary: 'Synthetic conversation still needs a reply.',
    nextFollowupText: 'Review the synthetic reply.',
    reviewHorizon: 'tonight',
    lastCheckedAt: NOW,
    userConfirmed: false,
    showInDailyReview: true,
    showInWeeklyReview: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function seedThread(
  overrides: Partial<CommunicationThreadRecord> = {},
): CommunicationThreadRecord {
  const thread: CommunicationThreadRecord = {
    id: 'communication:forget-fixture',
    groupFolder: 'main',
    title: 'Synthetic Riley follow-up',
    linkedSubjectIds: [],
    linkedLifeThreadIds: [],
    channel: 'telegram',
    channelChatJid: CHAT,
    lastInboundSummary: 'Is the synthetic rehearsal still on?',
    lastOutboundSummary: null,
    followupState: 'reply_needed',
    urgency: 'tonight',
    followupDueAt: null,
    suggestedNextAction: 'draft_reply',
    toneStyleHints: [],
    lastContactAt: NOW,
    lastMessageId: 'message:forget-fixture',
    linkedTaskId: null,
    inferenceState: 'assistant_inferred',
    trackingMode: 'default',
    createdAt: NOW,
    updatedAt: NOW,
    disabledAt: null,
    ...overrides,
  };
  upsertCommunicationThread(thread);
  upsertCommunicationSignal({
    id: `signal:${thread.id}`,
    communicationThreadId: thread.id,
    groupFolder: thread.groupFolder,
    sourceChannel: thread.channel,
    chatJid: thread.channelChatJid,
    messageId: thread.lastMessageId,
    direction: 'inbound',
    summaryText: thread.lastInboundSummary!,
    followupState: thread.followupState,
    suggestedAction: thread.suggestedNextAction,
    urgency: thread.urgency,
    createdAt: NOW,
  });
  expect(
    decideCommunicationThreadIdentity({
      groupFolder: thread.groupFolder,
      threadId: thread.id,
      decision: thread.linkedSubjectIds.length ? 'confirmed' : 'dismissed',
      subjectId: thread.linkedSubjectIds[0],
      sourceChannel: 'telegram',
      now: NOW,
    }).ok,
  ).toBe(true);
  // Preserve independently saved links after recording the fixture's identity
  // decision, which intentionally replaces assistant-inferred links.
  upsertCommunicationThread(thread);
  const persisted = getCommunicationThread(thread.id)!;
  seedOutcome(persisted);
  return persisted;
}

function snapshot(thread: CommunicationThreadRecord) {
  return {
    thread: getCommunicationThread(thread.id),
    signals: listCommunicationSignalsForThread(thread.id),
    identity: getCommunicationIdentityReview(thread.id),
    outcome: getOutcomeBySource(
      thread.groupFolder,
      'communication_thread',
      thread.id,
    ),
  };
}

function request(thread: CommunicationThreadRecord) {
  return {
    groupFolder: thread.groupFolder,
    threadId: thread.id,
    expectedFingerprint: communicationThreadFingerprint(thread),
  };
}

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
  _closeDatabase();
});

describe('reviewed communication tracking deletion', () => {
  it('atomically removes only the bound tracking record and directly derived records', () => {
    const target = seedThread();
    const unrelated = seedThread({ id: 'communication:unrelated' });
    const otherGroup = seedThread({
      id: 'communication:other-group',
      groupFolder: 'other',
    });
    seedOutcome(target, {
      outcomeId: 'outcome:independent-reminder',
      sourceType: 'reminder',
      // A matching source key or linked reference does not make this derived.
      sourceKey: target.id,
    });
    seedOutcome(target, {
      outcomeId: 'outcome:other-group-same-key',
      groupFolder: 'other',
    });
    const unrelatedBefore = snapshot(unrelated);
    const otherGroupBefore = snapshot(otherGroup);
    const independentBefore = getOutcomeBySource('main', 'reminder', target.id);
    const sameKeyOtherGroupBefore = getOutcomeBySource(
      'other',
      'communication_thread',
      target.id,
    );

    expect(deleteReviewedCommunicationThread(request(target))).toBe(true);
    expect(snapshot(target)).toEqual({
      thread: undefined,
      signals: [],
      identity: undefined,
      outcome: undefined,
    });
    expect(snapshot(unrelated)).toEqual(unrelatedBefore);
    expect(snapshot(otherGroup)).toEqual(otherGroupBefore);
    expect(getOutcomeBySource('main', 'reminder', target.id)).toEqual(
      independentBefore,
    );
    expect(
      getOutcomeBySource('other', 'communication_thread', target.id),
    ).toEqual(sameKeyOtherGroupBefore);
  });

  it('preserves original messages, saved profile facts, life threads, and reminders', () => {
    storeChatMetadata(CHAT, NOW, 'Synthetic owner chat', 'telegram', false);
    storeMessageDirect({
      id: 'message:forget-fixture',
      chat_jid: CHAT,
      sender: 'synthetic-riley',
      sender_name: 'Riley Fixture',
      content: 'Is the synthetic rehearsal still on?',
      timestamp: NOW,
      is_from_me: false,
    });
    upsertProfileSubject({
      id: 'profile:forget-fixture',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'riley-fixture',
      displayName: 'Riley Fixture',
      createdAt: NOW,
      updatedAt: NOW,
    });
    upsertProfileFact({
      id: 'fact:forget-fixture',
      groupFolder: 'main',
      subjectId: 'profile:forget-fixture',
      category: 'conversational_style',
      factKey: 'synthetic-style',
      valueJson: '{"style":"brief"}',
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'Explicit synthetic profile preference.',
      createdAt: NOW,
      updatedAt: NOW,
      decidedAt: NOW,
    });
    upsertLifeThread({
      id: 'life:forget-fixture',
      groupFolder: 'main',
      title: 'Synthetic rehearsal',
      category: 'project',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['profile:forget-fixture'],
      contextTags: [],
      summary: 'An independently saved rehearsal plan.',
      nextAction: 'Review the plan.',
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      createdAt: NOW,
      lastUpdatedAt: NOW,
    });
    createTask({
      id: 'reminder:forget-fixture',
      group_folder: 'main',
      chat_jid: CHAT,
      prompt: 'Review the independently saved synthetic plan.',
      schedule_type: 'once',
      schedule_value: '2026-09-07T06:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-09-07T06:00:00.000Z',
      status: 'paused',
      created_at: NOW,
    });
    const target = seedThread({
      linkedSubjectIds: ['profile:forget-fixture'],
      linkedLifeThreadIds: ['life:forget-fixture'],
      linkedTaskId: 'reminder:forget-fixture',
    });
    const independent = () => ({
      messages: getMessagesSince(CHAT, '', 'Andrea'),
      profile: getProfileSubject('profile:forget-fixture'),
      fact: getProfileFact('fact:forget-fixture'),
      lifeThread: getLifeThread('life:forget-fixture'),
      reminder: getTaskById('reminder:forget-fixture'),
    });
    const before = independent();
    expect(before.messages).toHaveLength(1);
    expect(deleteReviewedCommunicationThread(request(target))).toBe(true);
    expect(independent()).toEqual(before);
  });

  it('rejects wrong group, wrong ID, missing, malformed, and replayed bindings without mutation', () => {
    const target = seedThread();
    const before = snapshot(target);
    for (const invalid of [
      { ...request(target), groupFolder: 'other' },
      { ...request(target), groupFolder: '../main' },
      { ...request(target), threadId: 'communication:missing' },
      { ...request(target), threadId: '' },
      { ...request(target), expectedFingerprint: '' },
      { ...request(target), expectedFingerprint: '0'.repeat(64) },
      { ...request(target), expectedFingerprint: 'not-a-fingerprint' },
    ]) {
      expect(deleteReviewedCommunicationThread(invalid)).toBe(false);
      expect(snapshot(target)).toEqual(before);
    }
    expect(deleteReviewedCommunicationThread(request(target))).toBe(true);
    expect(deleteReviewedCommunicationThread(request(target))).toBe(false);
    expect(listOutcomesForGroup({ groupFolder: 'main' })).toEqual([]);
  });

  it('rejects changed contents even when the timestamp is unchanged', () => {
    const target = seedThread();
    const reviewed = request(target);
    upsertCommunicationThread({
      ...target,
      lastInboundSummary: 'A newer synthetic message changes the question.',
    });
    const before = snapshot(target);
    expect(before.thread?.updatedAt).toBe(target.updatedAt);
    expect(deleteReviewedCommunicationThread(reviewed)).toBe(false);
    expect(snapshot(target)).toEqual(before);
  });

  it('refuses inconsistent cross-group children before cascading any deletion', () => {
    const target = seedThread();
    upsertCommunicationSignal({
      id: 'signal:foreign-child',
      communicationThreadId: target.id,
      groupFolder: 'other',
      sourceChannel: 'telegram',
      chatJid: 'tg:other',
      direction: 'inbound',
      summaryText: 'Inconsistent foreign-group signal.',
      followupState: 'reply_needed',
      urgency: 'soon',
      createdAt: NOW,
    });
    const before = snapshot(target);
    expect(deleteReviewedCommunicationThread(request(target))).toBe(false);
    expect(snapshot(target)).toEqual(before);
  });

  it('fingerprints every persisted field deterministically without mutating the record', () => {
    const target = seedThread();
    const before = structuredClone(target);
    const expected = communicationThreadFingerprint(target);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(
      communicationThreadFingerprint(
        Object.fromEntries(
          Object.entries(target).reverse(),
        ) as CommunicationThreadRecord,
      ),
    ).toBe(expected);
    const changes: Partial<CommunicationThreadRecord>[] = [
      { id: 'communication:changed' },
      { groupFolder: 'other' },
      { title: 'Changed title' },
      { linkedSubjectIds: ['profile:changed'] },
      { linkedLifeThreadIds: ['life:changed'] },
      { channel: 'bluebubbles' },
      { channelChatJid: 'bb:synthetic-other' },
      { lastInboundSummary: 'Changed inbound' },
      { lastOutboundSummary: 'Changed outbound' },
      { followupState: 'resolved' },
      { urgency: 'none' },
      { followupDueAt: '2026-09-07T06:00:00.000Z' },
      { suggestedNextAction: 'ignore' },
      { toneStyleHints: ['short'] },
      { lastContactAt: '2026-09-07T06:00:00.000Z' },
      { lastMessageId: 'message:changed' },
      { linkedTaskId: 'task:changed' },
      { inferenceState: 'user_confirmed' },
      { trackingMode: 'disabled' },
      { createdAt: '2026-09-05T06:00:00.000Z' },
      { updatedAt: '2026-09-07T06:00:00.000Z' },
      { disabledAt: '2026-09-07T06:00:00.000Z' },
    ];
    for (const change of changes) {
      expect(communicationThreadFingerprint({ ...target, ...change })).not.toBe(
        expected,
      );
    }
    expect(target).toEqual(before);
    expect(
      communicationThreadFingerprint({
        ...target,
        lastOutboundSummary: undefined,
      }),
    ).toBe(expected);
  });

  it('rolls back child and derived outcome deletions if the final database step fails', () => {
    const target = seedThread();
    const before = snapshot(target);
    const prepare = Database.prototype.prepare;
    let reachedFinalDelete = false;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string,
    ) {
      if (
        sql ===
        'DELETE FROM communication_threads WHERE id = ? AND group_folder = ?'
      ) {
        reachedFinalDelete = true;
        // The real transaction has already removed the three derived records.
        expect(getCommunicationIdentityReview(target.id)).toBeUndefined();
        expect(listCommunicationSignalsForThread(target.id)).toEqual([]);
        expect(
          getOutcomeBySource('main', 'communication_thread', target.id),
        ).toBeUndefined();
        throw new Error('Synthetic final-delete database failure');
      }
      return prepare.call(this, sql);
    });
    expect(() => deleteReviewedCommunicationThread(request(target))).toThrow(
      'Synthetic final-delete database failure',
    );
    expect(reachedFinalDelete).toBe(true);
    vi.restoreAllMocks();
    expect(snapshot(target)).toEqual(before);
    expect(deleteReviewedCommunicationThread(request(target))).toBe(true);
  });
});
