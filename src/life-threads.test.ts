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
import { buildCognitiveWorldSnapshot } from './cognitive-executive.js';
import {
  buildLifeThreadSnapshot,
  findLifeThreadForExplicitLookup,
  getPendingLifeThreadSuggestion,
  handleLifeThreadCommand,
  isAutomaticSurfaceWorthyLifeThread,
  maybeCreatePendingLifeThreadSuggestion,
} from './life-threads.js';
import { getLifeThreadCommitment } from './life-thread-commitment.js';

beforeEach(() => {
  _initTestDatabase();
});

function storeChatMessage(input: {
  id: string;
  content: string;
  timestamp: string;
  chatJid?: string;
}) {
  const chatJid = input.chatJid || 'tg:100000001';
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
      chatJid: 'tg:100000001',
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
      chatJid: 'tg:100000001',
      text: 'Remember I need to talk to Candace about dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('Candace thread');
    expect(threads).toHaveLength(1);
    expect(threads[0]?.title).toBe('Candace');
    expect(threads[0]?.summary).toContain('dinner plans tonight');
    expect(threads[0]?.nextAction).toContain(
      'Talk to Candace about dinner plans tonight',
    );
  });

  it('can rename, pause, close, and forget a referenced thread', () => {
    const created = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the family thread',
      replyText: 'Talk about dinner plans and school pickup.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    expect(created.referencedThread?.title).toBe('Family');

    const renamed = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'rename that thread to Candace',
      priorContext: {
        summaryText: 'family logistics',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['family'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [
          'family: Talk about dinner plans and school pickup.',
        ],
      },
      now: new Date('2026-04-04T09:05:00.000Z'),
    });
    expect(renamed.responseText).toContain('Candace');

    const paused = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'pause that',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [
          'Candace: Talk about dinner plans and school pickup.',
        ],
      },
      now: new Date('2026-04-04T09:06:00.000Z'),
    });
    expect(paused.responseText).toContain('paused');

    const closed = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'close that thread',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [
          'Candace: Talk about dinner plans and school pickup.',
        ],
      },
      now: new Date('2026-04-04T09:07:00.000Z'),
    });
    expect(closed.responseText).toContain('closed');

    const forgotten = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'forget that thread',
      priorContext: {
        summaryText: 'Candace',
        usedThreadIds: [created.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [
          'Candace: Talk about dinner plans and school pickup.',
        ],
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
      chatJid: 'tg:100000001',
      text: 'save this under the band thread',
      replyText: 'Book rehearsal space.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;
    const community = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
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
    expect(communitySignals).toHaveLength(1);
    expect(
      listLifeThreadSignals(band.id, 10).filter(
        (signal) => signal.commitmentTransition,
      ),
    ).toHaveLength(2);
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
      chatJid: 'tg:100000001',
      text: 'What am I forgetting about the band this week?',
      now: new Date('2026-04-04T12:00:00.000Z'),
    });

    expect(suggestion?.title).toBe('Band');
    expect(listLifeThreadsForGroup('main')).toHaveLength(0);
    expect(
      getPendingLifeThreadSuggestion(
        'tg:100000001',
        new Date('2026-04-04T12:10:00.000Z'),
      )?.title,
    ).toBe('Band');

    const accepted = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
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
      chatJid: 'tg:100000001',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the work thread',
      replyText: 'Finish the rollout notes.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    });

    const threads = listLifeThreadsForGroup('main', ['active']);
    const candace = threads.find(
      (thread) => thread.title.toLowerCase() === 'candace',
    );
    const work = threads.find(
      (thread) => thread.title.toLowerCase() === 'work',
    );
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
      chatJid: 'tg:100000001',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
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
    expect(snapshot.activeThreads.map((thread) => thread.title)).not.toContain(
      'Candace',
    );
  });

  it('keeps manual, disabled, snoozed, and non-actionable commitments out of Cognitive Executive focus', () => {
    const now = new Date('2026-04-04T09:00:00.000Z');
    const create = (title: string, detail: string, minute: number) =>
      handleLifeThreadCommand({
        groupFolder: 'main',
        channel: 'telegram',
        chatJid: `tg:cognitive-${title}`,
        messageId: `message:cognitive-${title}`,
        text: `save this under the ${title} thread`,
        replyText: detail,
        now: new Date(now.getTime() + minute * 60_000),
      }).referencedThread!;
    const manual = create(
      'manual focus',
      'Review the private manual packet.',
      0,
    );
    const disabled = create('disabled focus', 'Review the disabled packet.', 1);
    const snoozed = create('snoozed focus', 'Review the snoozed packet.', 2);
    const speculative = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:cognitive-speculative',
      messageId: 'message:cognitive-speculative',
      text: 'I might review the speculative archive someday.',
      now: new Date(now.getTime() + 3 * 60_000),
    }).referencedThread!;

    updateLifeThread(manual.id, {
      surfaceMode: 'manual_only',
      followthroughMode: 'manual_only',
    });
    updateLifeThread(disabled.id, { followthroughMode: 'off' });
    updateLifeThread(snoozed.id, {
      snoozedUntil: '2026-04-10T14:00:00.000Z',
    });

    const world = buildCognitiveWorldSnapshot({
      groupFolder: 'main',
      intentFamily: 'next_action',
      now: new Date('2026-04-04T18:00:00.000Z'),
      persist: false,
    });
    const suppressedIds = [manual.id, disabled.id, snoozed.id, speculative.id];

    const automaticallyFocusedLifeThreadIds = world.items
      .filter((item) => item.itemKind === 'life_thread')
      .map((item) => item.sourceId);
    expect(
      suppressedIds.filter((id) =>
        automaticallyFocusedLifeThreadIds.includes(id),
      ),
    ).toEqual([]);
    expect(world.snapshot.currentFocus).not.toMatch(
      /private manual|disabled packet|snoozed packet|speculative archive/i,
    );
    expect(world.snapshot.nextAction).not.toMatch(
      /private manual|disabled packet|snoozed packet|speculative archive/i,
    );
    for (const title of ['manual focus', 'disabled focus', 'snoozed focus']) {
      expect(
        findLifeThreadForExplicitLookup({
          groupFolder: 'main',
          query: title,
        })?.title.toLowerCase(),
      ).toBe(title);
    }
  });

  it('keeps low-value placeholder threads out of automatic recommendations', () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the band thread',
      replyText:
        'The next grounded thing is your schedule, because I do not have a better signal than that yet.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    });
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
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
      chatJid: 'tg:100000001',
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
    expect(thread?.nextAction).toBeNull();
    expect(getLifeThreadCommitment(thread!).downstreamAction).toContain(
      'Talk to Candace',
    );
  });

  it('uses the clean summary line when save-for-later context includes a draft block', () => {
    const dirtyDraftReply = [
      'Candace wants a follow-up about whether dinner still works tonight.',
      'Draft:',
      'Hey Candace, I wanted to check in about whether dinner still works tonight. Candace wants a follow-up about whether dinner still works tonight.',
      'Next: Save it, send the fuller version, or remind yourself later.',
      'Keep in mind: This is shaped around Candace and the current conversation.',
    ].join('\n');

    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this for later',
      replyText: dirtyDraftReply,
      now: new Date('2026-04-04T09:00:00.000Z'),
    });

    const thread = result.referencedThread
      ? getLifeThread(result.referencedThread.id)
      : null;

    expect(result.handled).toBe(true);
    expect(result.responseText).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
    expect(result.responseText).not.toContain('Draft:');
    expect(thread?.summary).toBe(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
  });

  it('keeps manual and snoozed threads out of automatic follow-through while surfacing slipping ones', () => {
    const due = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: "don't let me forget this band thing tonight",
      replyText: 'Confirm the rehearsal set list before tonight.',
      now: new Date('2026-04-04T09:00:00-05:00'),
    }).referencedThread!;

    const manual = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
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
      chatJid: 'tg:100000001',
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

    expect(snapshot.slippingThreads.map((thread) => thread.id)).toContain(
      due.id,
    );
    expect(snapshot.activeThreads.map((thread) => thread.id)).not.toContain(
      manual.id,
    );
    expect(snapshot.activeThreads.map((thread) => thread.id)).not.toContain(
      snoozed.id,
    );
  });

  it('closes a uniquely identified obligation when the user reports completion', () => {
    const expense = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the expense report thread',
      replyText: 'Submit the expense report by Tuesday.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;
    const unrelated = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the air filters thread',
      replyText: 'Buy replacement air filters this month.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    }).referencedThread!;

    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'I submitted the expense report. Mark that done.',
      now: new Date('2026-04-04T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(getLifeThread(expense.id)).toMatchObject({
      status: 'closed',
      nextAction: null,
      nextFollowupAt: null,
      followthroughMode: 'off',
    });
    expect(getLifeThread(unrelated.id)?.status).toBe('active');
    expect(listLifeThreadSignals(expense.id, 5)[0]?.summaryText).toContain(
      'commitment_transition:completed',
    );
    expect(
      buildLifeThreadSnapshot({ groupFolder: 'main' }).activeThreads.map(
        (thread) => thread.id,
      ),
    ).not.toContain(expense.id);
  });

  it('uses sufficient prior context for a held-out completion paraphrase', () => {
    const saved = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the vendor renewal thread',
      replyText: 'Finish the vendor renewal paperwork.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;

    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'That task is taken care of now.',
      priorContext: {
        summaryText: saved.summary,
        usedThreadIds: [saved.id],
        usedThreadTitles: [saved.title],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [`${saved.title}: ${saved.summary}`],
      },
      now: new Date('2026-04-04T10:00:00.000Z'),
    });

    expect(result.handled).toBe(true);
    expect(getLifeThread(saved.id)?.status).toBe('closed');
  });

  it('closes cancelled plans for exact and held-out semantic variants without touching unrelated work', () => {
    const exact = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the kitchen repair meeting thread',
      replyText: 'Meet Leo about the kitchen repair Friday afternoon.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;
    const heldOut = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the contractor meeting thread',
      replyText: 'Attend the Friday contractor meeting.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    }).referencedThread!;
    const unrelated = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:100000001',
      text: 'save this under the client proposal thread',
      replyText: 'Finish the client proposal.',
      now: new Date('2026-04-04T09:02:00.000Z'),
    }).referencedThread!;

    const exactResult = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'The meeting with Leo was cancelled.',
      now: new Date('2026-04-04T10:00:00.000Z'),
    });
    const heldOutResult = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'We are not doing the Friday contractor meeting anymore.',
      now: new Date('2026-04-04T10:01:00.000Z'),
    });

    expect(exactResult.handled).toBe(true);
    expect(heldOutResult.handled).toBe(true);
    expect(getLifeThread(exact.id)?.status).toBe('closed');
    expect(getLifeThread(heldOut.id)?.status).toBe('closed');
    expect(getLifeThread(unrelated.id)?.status).toBe('active');
    expect(listLifeThreadSignals(exact.id, 5)[0]?.summaryText).toContain(
      'commitment_transition:cancelled',
    );
  });

  it('asks for clarification without mutation when target terms conflict with unrelated context', () => {
    const first = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'save this under the first follow-up thread',
      replyText: 'Finish the first follow-up.',
      now: new Date('2026-04-04T09:00:00.000Z'),
    }).referencedThread!;
    const second = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'save this under the second follow-up thread',
      replyText: 'Finish the second follow-up.',
      now: new Date('2026-04-04T09:01:00.000Z'),
    }).referencedThread!;
    const unrelated = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'save this under the client proposal thread',
      replyText: 'Finish the client proposal.',
      now: new Date('2026-04-04T09:02:00.000Z'),
    }).referencedThread!;

    const referentialResult = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'I finished it.',
      now: new Date('2026-04-04T09:59:00.000Z'),
    });
    const result = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'I finished the follow-up.',
      priorContext: {
        summaryText: unrelated.summary,
        usedThreadIds: [unrelated.id],
        usedThreadTitles: [unrelated.title],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: [`${unrelated.title}: ${unrelated.summary}`],
      },
      now: new Date('2026-04-04T10:00:00.000Z'),
    });

    expect(referentialResult.handled).toBe(false);
    expect(result.handled).toBe(true);
    expect(result.responseText).toContain('more than one open commitment');
    expect(getLifeThread(first.id)?.status).toBe('active');
    expect(getLifeThread(second.id)?.status).toBe('active');
    expect(getLifeThread(unrelated.id)?.status).toBe('active');
  });
});
