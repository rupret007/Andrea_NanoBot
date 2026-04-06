import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getLifeThread,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  storeChatMetadata,
  storeMessage,
  updateLifeThread,
} from './db.js';
import {
  buildLifeThreadSnapshot,
  findLifeThreadForExplicitLookup,
  getPendingLifeThreadSuggestion,
  handleLifeThreadCommand,
  isAutomaticSurfaceWorthyLifeThread,
  maybeCreatePendingLifeThreadSuggestion,
} from './life-threads.js';

beforeEach(() => {
  _initTestDatabase();
});

function storeChatMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  chatJid?: string;
}) {
  const chatJid = input.chatJid || 'tg:8004355504';
  storeChatMetadata(chatJid, input.timestamp);
  storeMessage({
    id: input.id,
    chat_jid: chatJid,
    sender: 'user',
    sender_name: 'User',
    content: input.content,
    timestamp: input.timestamp,
    is_from_me: false,
  });
}

describe('life threads', () => {
  it('creates a durable thread from an explicit save request', () => {
    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the band thread',
      replyText: 'Confirm rehearsal time with the drummer before Friday.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('Band thread');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe('Band');
    expect(threads[0]?.summary).toContain('Confirm rehearsal time');
    expect(listLifeThreadSignals(threads[0]!.id, 5)).toHaveLength(1);
  });

  it('captures natural remember-to-talk phrasing as an explicit thread', () => {
    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'Remember I need to talk to Candace about dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('Candace thread');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe('Candace');
    expect(threads[0]?.summary).toContain('dinner plans tonight');
    expect(threads[0]?.nextAction).toContain('Talk to Candace about dinner plans tonight');
  });

  it('can rename, pause, close, and forget a referenced thread', () => {
    const created = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the family thread',
      replyText: 'Talk about dinner plans and school pickup.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    expect(created.referencedThread?.title).toBe('Family');

    const renamed = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'rename that thread to Candace',
      priorContext: {
        summaryText: 'family logistics',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['family'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['family: Talk about dinner plans and school pickup.'],
      },
      now: new Date('2026-04-04T09:05:00.000Z'),
    });
    expect(renamed.responseText).toContain('Candace');

    const paused = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'pause that',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Talk about dinner plans and school pickup.'],
      },
      now: new Date('2026-04-04T09:06:00.000Z'),
    });
    expect(paused.responseText).toContain('paused');

    const closed = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'close that thread',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Talk about dinner plans and school pickup.'],
      },
      now: new Date('2026-04-04T09:07:00.000Z'),
    });
    expect(closed.responseText).toContain('closed');

    const forgotten = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'forget that thread',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Talk about dinner plans and school pickup.'],
      },
      now: new Date('2026-04-04T09:08:00.000Z'),
    });

    expect(forgotten.responseText).toContain('forgot the Candace thread');
    expect(listLifeThreadsForGroup('main')).toHaveLength(0);
  });

  it('merges threads and reassigns signals', () => {
    const band = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the band thread',
      replyText: 'Book rehearsal space.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;
    const community = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the community thread',
      replyText: 'Confirm the neighborhood fundraiser set.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    }).referencedThread!;

    const merged = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'merge the band thread into the community thread',
      now: new Date('2026-04-04T09:02:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main');
    const archivedBand = threads.find((thread) => thread.id === band.id);
    const communitySignals = listLifeThreadSignals(community.id, 10);
    expect(merged.responseText).toContain('merged Band into Community');
    expect(archivedBand?.status).toBe('archived');
    expect(communitySignals).toHaveLength(2);
  });

  it('keeps inferred thread suggestions pending until the user confirms them', () => {
    storeChatMessage({
      id: 'msg-1',
      content: 'I keep thinking about the band set list.',
      timestamp: '2026-04-02T10:00:00.000Z',
    });
    storeChatMessage({
      id: 'msg-2',
      content: 'The band still needs a rehearsal plan.',
      timestamp: '2026-04-03T11:00:00.000Z',
    });
    storeChatMessage({
      id: 'msg-3',
      content: 'What am I forgetting about the band this week?',
      timestamp: '2026-04-04T12:00:00.000Z',
    });

    const suggestion = maybeCreatePendingLifeThreadSuggestion({
      groupFolder: 'main',
      chatJid: 'tg:8004355504',
      text: 'What am I forgetting about the band this week?',
      now: new Date('2026-04-04T12:00:00.000Z'),
    });

    expect(suggestion?.title).toBe('Band');
    expect(listLifeThreadsForGroup('main')).toHaveLength(0);
    expect(
      getPendingLifeThreadSuggestion(
        'tg:8004355504',
        new Date('2026-04-04T12:10:00.000Z'),
      )?.title,
    ).toBe('Band');

    const accepted = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'yes',
      now: new Date('2026-04-04T12:11:00.000Z'),
    });
    expect(accepted.responseText).toContain('Band');
    expect(listLifeThreadsForGroup('main', ['active'])).toHaveLength(1);
  });

  it('builds a useful thread snapshot for daily companion flows', () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the work thread',
      replyText: 'Finish the rollout notes.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    const candace = threads.find((thread) => thread.title.toLowerCase() === 'candace');
    const work = threads.find((thread) => thread.title.toLowerCase() === 'work');
    expect(candace).toBeDefined();
    expect(work).toBeDefined();

    const snapshot = buildLifeThreadSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-04T18:00:00.000Z'),
      selectedWorkTitle: 'Ship docs',
    });

    expect(snapshot.activeThreads.length).toBe(2);
    expect(snapshot.householdCarryover?.title).toBe('Candace');
    expect(snapshot.recommendedNextThread?.title).toBeTruthy();
  });

  it('still allows explicit lookup for a manual-only thread while excluding it from the automatic snapshot', () => {
    const created = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: "don't bring this up automatically",
      priorContext: {
        summaryText: 'Candace dinner plans',
        usedThreadIds: [created.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Talk through dinner plans tonight.'],
      },
      now: new Date('2026-04-04T09:05:00.000Z'),
    });

    const explicit = findLifeThreadForExplicitLookup({
      groupFolder: 'main',
      query: 'Candace',
    });
    const snapshot = buildLifeThreadSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-04T18:00:00.000Z'),
    });

    expect(explicit?.title).toBe('Candace');
    expect(snapshot.activeThreads.map((thread) => thread.title)).not.toContain('Candace');
  });

  it('keeps low-value placeholder threads out of automatic recommendations', () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the band thread',
      replyText:
        'The next grounded thing is your schedule, because I do not have a better signal than that yet.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the work thread',
      replyText: 'Finish the rollout notes.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    const band = threads.find((thread) => thread.title === 'Band')!;
    const work = threads.find((thread) => thread.title === 'Work')!;
    const snapshot = buildLifeThreadSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-04T18:00:00.000Z'),
    });

    expect(isAutomaticSurfaceWorthyLifeThread(band)).toBe(false);
    expect(isAutomaticSurfaceWorthyLifeThread(work)).toBe(true);
    expect(snapshot.recommendedNextThread?.title).toBe('Work');
  });

  it('creates a scheduled follow-through loop from remind-me phrasing', () => {
    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'remind me to talk to Candace about dinner plans tonight',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    const thread = result.referencedThread
      ? getLifeThread(result.referencedThread.id)
      : null;

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('Candace');
    expect(thread?.followthroughMode).toBe('scheduled');
    expect(thread?.nextFollowupAt).toBeTruthy();
    expect(thread?.nextAction).toContain('Talk to Candace');
  });

  it('keeps manual and snoozed threads out of automatic follow-through while surfacing slipping ones', () => {
    const due = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: "don't let me forget this band thing tonight",
      replyText: 'Confirm the rehearsal set list before tonight.',
      now: new Date('2026-04-04T09:00:00-05:00'),
    }).referencedThread!;

    const manual = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the house thread',
      replyText: 'Check the back porch light.',
      now: new Date('2026-04-04T09:05:00.000Z'),
    }).referencedThread!;

    updateLifeThread(manual.id, {
      surfaceMode: 'manual_only',
      followthroughMode: 'manual_only',
      lastUpdatedAt: '2026-04-04T09:06:00.000Z',
      lastUsedAt: '2026-04-04T09:06:00.000Z',
    });

    const snoozed = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the work thread',
      replyText: 'Finish the rollout notes.',
      now: new Date('2026-04-04T09:10:00.000Z'),
    }).referencedThread!;

    updateLifeThread(snoozed.id, {
      followthroughMode: 'important_only',
      snoozedUntil: '2026-04-05T09:00:00.000Z',
      lastUpdatedAt: '2026-04-04T09:11:00.000Z',
      lastUsedAt: '2026-04-04T09:11:00.000Z',
    });

    const snapshot = buildLifeThreadSnapshot({
      groupFolder: 'main',
      now: new Date('2026-04-04T21:00:00-05:00'),
    });

    expect(snapshot.slippingThreads.map((thread) => thread.id)).toContain(due.id);
    expect(snapshot.activeThreads.map((thread) => thread.id)).not.toContain(
      manual.id,
    );
    expect(snapshot.activeThreads.map((thread) => thread.id)).not.toContain(
      snoozed.id,
    );
  });
});
