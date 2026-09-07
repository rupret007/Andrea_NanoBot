import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  executeAssistantCapability,
  type AssistantCapabilityContext,
} from './assistant-capabilities.js';
import { continueAssistantCapabilityFromPriorSubjectData } from './assistant-capability-router.js';
import {
  _initTestDatabase,
  getAllTasks,
  listMessageActionsForGroup,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  getActionableMessageReceivedAt,
  updateTask,
} from './db.js';

const bobJid = 'bb:iMessage;-;+14695550199';
const originalFetch = globalThis.fetch;
const now = new Date('2026-09-06T00:30:00.000Z'); // Sep 5, 7:30 PM Chicago.
const baseContext: AssistantCapabilityContext = {
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'tg:100000001',
  ownerReviewAllowed: true,
  calendarDeps: { timeZone: 'America/Chicago' },
  currentMessageId: 'owner-clock-choice',
  now,
};

async function openBob(context = baseContext, answered = false) {
  storeChatMetadata(
    bobJid,
    '2026-09-06T00:20:00.000Z',
    'Bob',
    'bluebubbles',
    false,
  );
  storeMessage({
    id: 'bob-clock-practice',
    chat_jid: bobJid,
    sender: 'bb:+14695550199',
    sender_name: 'Bob',
    content: 'Practice moved to eight tonight, just keeping you posted.',
    timestamp: '2026-09-06T00:20:00.000Z',
    is_from_me: false,
  });
  if (answered)
    storeMessage({
      id: 'owner-clock-answer',
      chat_jid: bobJid,
      sender: 'owner',
      sender_name: 'Jeff',
      content: 'Thanks, see you at eight.',
      timestamp: '2026-09-06T00:25:00.000Z',
      is_from_me: true,
    });
  return executeAssistantCapability({
    capabilityId: 'communication.open_loops',
    context,
    input: { text: "what's still open with Bob", targetChatName: 'Bob' },
  });
}

async function remind(
  text: string,
  priorSubjectData: AssistantCapabilityContext['priorSubjectData'],
  overrides: Partial<AssistantCapabilityContext> = {},
) {
  return executeAssistantCapability({
    capabilityId: 'communication.manage_tracking',
    context: { ...baseContext, ...overrides, priorSubjectData },
    input: { text },
  });
}

function storeTimingChoice(
  text: string,
  context = baseContext,
  historyOnly = false,
  receivedAt = now.toISOString(),
) {
  storeChatMetadata(
    context.chatJid!,
    receivedAt,
    'Synthetic owner',
    context.channel,
    false,
  );
  const message = {
    id: context.currentMessageId!,
    chat_jid: context.chatJid!,
    sender: 'synthetic-owner',
    sender_name: 'Synthetic owner',
    content: text,
    timestamp: receivedAt,
    ingress_received_at: receivedAt,
    is_from_me: context.channel === 'bluebubbles',
  };
  if (historyOnly)
    storeMessageDirect({
      ...message,
      message_ingress_origin: 'history_hydration',
    });
  else storeMessage(message);
}

describe('named reply clock reminder journey', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.stubEnv('OPENAI_API_KEY', '');
    globalThis.fetch = vi.fn() as typeof fetch;
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(
      listMessageActionsForGroup({ groupFolder: 'main', includeSent: true }),
    ).toHaveLength(0);
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it.each([
    [
      'telegram',
      'tg:100000001',
      'remind me in 30 minutes',
      '2026-09-06T01:00:00.000Z',
    ],
    [
      'bluebubbles',
      'bb:owner-self-test',
      'remind me to reply in 2 hours',
      '2026-09-06T02:30:00.000Z',
    ],
    [
      'telegram',
      'tg:100000001',
      'remind me in an hour',
      '2026-09-06T01:30:00.000Z',
    ],
    [
      'bluebubbles',
      'bb:owner-self-test',
      'remind me in half an hour',
      '2026-09-06T01:00:00.000Z',
    ],
    [
      'telegram',
      'tg:100000001',
      'remind me in a couple hours',
      '2026-09-06T02:30:00.000Z',
    ],
  ] as const)(
    'retains the named reply for a relative delay on %s',
    async (channel, chatJid, text, due) => {
      const context = { ...baseContext, channel, chatJid };
      const opened = await openBob(context);
      const seed = opened.conversationSeed?.subjectData;
      expect(opened.replyText).toContain('remind me in 30 minutes');
      expect(
        continueAssistantCapabilityFromPriorSubjectData(text, seed),
      ).toMatchObject({
        capabilityId: 'communication.manage_tracking',
        canonicalText: text,
        arguments: { personName: 'Bob' },
      });
      storeTimingChoice(text, context);
      const history = vi.fn();
      const result = await remind(text, seed, {
        ...context,
        primeMessagesChatHistory: history,
      });
      expect(result.replyText).toContain('reply to Bob');
      expect(result.replyText).toContain('America/Chicago');
      expect(result.replyText).toContain('CDT');
      expect(result.replyText).toContain('draft Bob');
      expect(result.messageAction).toBeUndefined();
      expect(history).not.toHaveBeenCalled();
      expect(getAllTasks()).toHaveLength(1);
      expect(getAllTasks()[0]).toMatchObject({
        chat_jid: chatJid,
        next_run: due,
        schedule_value: due,
        status: 'active',
      });

      // A provider retry can update the message row but not its original receipt.
      storeTimingChoice(text, context, false, '2026-09-06T00:31:00.000Z');
      expect(
        getActionableMessageReceivedAt(chatJid, context.currentMessageId!),
      ).toBe(now.toISOString());
      await remind(text, seed, {
        ...context,
        now: new Date('2026-09-06T00:31:00.000Z'),
      });
      expect(getAllTasks()).toHaveLength(1);
      expect(getAllTasks()[0].next_run).toBe(due);
    },
  );

  it.each([
    'remind me in 0 minutes',
    'remind me in -1 hour',
    'remind me in 1.5 hours',
    'remind me in 1441 minutes',
    'remind me in 25 hours',
  ])('refuses an invalid delay rather than using tonight: %s', async (text) => {
    const opened = await openBob();
    storeTimingChoice(text);
    const result = await remind(text, opened.conversationSeed?.subjectData);
    expect(result.replyText).toContain('could not set that reply reminder');
    expect(getAllTasks()).toHaveLength(0);
  });

  it('requires a matching durable live receipt, not another chat or hydrated history', async () => {
    const text = 'remind me in 30 minutes';
    const opened = await openBob();
    const seed = opened.conversationSeed?.subjectData;
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(0);
    storeTimingChoice(text, { ...baseContext, chatJid: 'tg:another-chat' });
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(0);
    storeTimingChoice(text, baseContext, true);
    expect(
      getActionableMessageReceivedAt(
        baseContext.chatJid!,
        baseContext.currentMessageId!,
      ),
    ).toBeNull();
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(0);
    storeTimingChoice(text);
    await remind(text, seed, { currentMessageId: undefined });
    expect(getAllTasks()).toHaveLength(0);
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(1);
  });

  it('does not use assistant-outbound evidence as an owner timing choice', async () => {
    const text = 'remind me in 30 minutes';
    const opened = await openBob();
    storeTimingChoice(text);
    storeMessageDirect({
      id: baseContext.currentMessageId!,
      chat_jid: baseContext.chatJid!,
      sender: 'assistant',
      sender_name: 'Andrea',
      content: text,
      timestamp: now.toISOString(),
      is_from_me: true,
      message_ingress_origin: 'assistant_outbound',
    });
    expect(
      getActionableMessageReceivedAt(
        baseContext.chatJid!,
        baseContext.currentMessageId!,
      ),
    ).toBeNull();
    await remind(text, opened.conversationSeed?.subjectData);
    expect(getAllTasks()).toHaveLength(0);
  });

  it.each([false, undefined])(
    'requires explicit owner authority for a delay (%s)',
    async (ownerReviewAllowed) => {
      const text = 'remind me in 30 minutes';
      const opened = await openBob();
      storeTimingChoice(text);
      const result = await remind(text, opened.conversationSeed?.subjectData, {
        ownerReviewAllowed,
      });
      expect(result.replyText).toContain('registered owner control chat');
      expect(result.replyText).not.toContain('reply to Bob');
      expect(getAllTasks()).toHaveLength(0);
    },
  );

  it('refuses expired or future receipts and never rearms a paused relative reminder', async () => {
    const text = 'remind me in 30 minutes';
    const opened = await openBob();
    storeTimingChoice(text);
    const seed = opened.conversationSeed?.subjectData;
    await remind(text, seed, { now: new Date('2026-09-06T01:00:00.000Z') });
    await remind(text, seed, { now: new Date('2026-09-06T00:29:00.000Z') });
    expect(getAllTasks()).toHaveLength(0);
    await remind(text, seed);
    const original = getAllTasks()[0];
    updateTask(original.id, { status: 'paused' });
    const retry = await remind(text, seed, {
      now: new Date('2026-09-06T00:31:00.000Z'),
    });
    expect(retry.replyText).toContain('no longer active');
    expect(getAllTasks()).toHaveLength(1);
    expect(getAllTasks()[0].status).toBe('paused');
  });

  it('refuses relative timing without an offered reply, or after the exact target changes', async () => {
    const text = 'remind me in 30 minutes';
    const answered = await openBob(baseContext, true);
    storeTimingChoice(text);
    await remind(text, answered.conversationSeed?.subjectData);
    expect(getAllTasks()).toHaveLength(0);
    _initTestDatabase();
    const opened = await openBob();
    storeTimingChoice(text);
    const seed = opened.conversationSeed?.subjectData;
    await remind(text, { ...seed, namedOpenLoopRemindOffered: false });
    await remind(text, {
      ...seed,
      namedMessagesSummaryTargetJson: JSON.stringify({ query: 'Bob' }),
    });
    expect(getAllTasks()).toHaveLength(0);
    storeChatMetadata(bobJid, now.toISOString(), 'Bob', 'bluebubbles', true);
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(0);
    storeChatMetadata(
      bobJid,
      now.toISOString(),
      'Different person',
      'bluebubbles',
      false,
    );
    await remind(text, seed);
    expect(getAllTasks()).toHaveLength(0);
  });

  it('does not inherit a person for compound or substituted delay requests', async () => {
    const opened = await openBob();
    for (const text of [
      'remind me in 30 minutes and send it',
      'remind me in 30 minutes; send now',
      'remind me in 2 hours to call Sam',
      'remind me to reply to Sam in 30 minutes',
      'send it in 30 minutes',
    ]) {
      expect(
        continueAssistantCapabilityFromPriorSubjectData(
          text,
          opened.conversationSeed?.subjectData,
        ),
      ).toBeNull();
    }
    expect(getAllTasks()).toHaveLength(0);
  });

  it.each([
    [
      'telegram',
      'tg:100000001',
      'remind me to reply tomorrow at 9am',
      '2026-09-06T14:00:00.000Z',
    ],
    [
      'bluebubbles',
      'bb:owner-self-test',
      'remind me at 9:30pm today',
      '2026-09-06T02:30:00.000Z',
    ],
    [
      'telegram',
      'tg:100000001',
      'remind me Friday at 9am',
      '2026-09-11T14:00:00.000Z',
    ],
    [
      'telegram',
      'tg:100000001',
      'remind me next Friday at 9am',
      '2026-09-18T14:00:00.000Z',
    ],
    [
      'bluebubbles',
      'bb:owner-self-test',
      'remind me at 9:30pm on Saturday',
      '2026-09-06T02:30:00.000Z',
    ],
  ] as const)(
    'keeps the person, owner chat and exact owner clock on %s for %s',
    async (channel, chatJid, text, due) => {
      const context = { ...baseContext, channel, chatJid };
      const opened = await openBob(context);
      expect(opened.replyText).toContain('remind me to reply tomorrow at 9am');
      expect(opened.replyText).toContain('remind me Friday at 9am');
      expect(opened.replyText).toContain('remind me next Friday at 9am');
      const seed = opened.conversationSeed?.subjectData;
      const routed = continueAssistantCapabilityFromPriorSubjectData(
        text,
        seed,
      );
      expect(routed).toMatchObject({
        capabilityId: 'communication.manage_tracking',
        continuation: true,
        arguments: { personName: 'Bob' },
      });
      expect(routed?.canonicalText).toContain(
        text.includes('tomorrow')
          ? 'tomorrow at 9:00am'
          : text.includes('next Friday')
            ? 'next friday at 9:00am'
            : text.includes('Friday')
              ? 'friday at 9:00am'
              : text.includes('Saturday')
                ? 'saturday at 9:30pm'
                : 'today at 9:30pm',
      );
      const history = vi.fn();
      const reminder = await remind(text, seed, {
        ...context,
        primeMessagesChatHistory: history,
      });
      expect(reminder.handled).toBe(true);
      expect(reminder.replyText).toContain('America/Chicago');
      expect(reminder.replyText).toContain('CDT');
      expect(reminder.replyText).toContain('reply to Bob');
      expect(reminder.messageAction).toBeUndefined();
      expect(history).not.toHaveBeenCalled();
      expect(getAllTasks()).toHaveLength(1);
      expect(getAllTasks()[0]).toMatchObject({
        chat_jid: chatJid,
        next_run: due,
        schedule_value: due,
        schedule_type: 'once',
      });
      expect(getAllTasks()[0].prompt).toBe(
        'Send a concise reminder telling the user to reply to Bob.',
      );
      await remind(text, seed, {
        ...context,
        now: new Date(now.getTime() + 60_000),
      });
      expect(getAllTasks()).toHaveLength(1);
    },
  );

  it.each([
    'remind me to reply today at 9am',
    'remind me tomorrow at 25am',
    'remind me tomorrow at 9:60am',
    'remind me tomorrow at 9',
    'remind me Friday at 25am',
    'remind me Friday at 9',
    'remind me next Friday at 25am',
    'remind me next Friday at 9',
  ])(
    'asks for another time without falling back to tonight: %s',
    async (text) => {
      const opened = await openBob();
      const result = await remind(text, opened.conversationSeed?.subjectData);
      expect(result.replyText).toContain(
        'could not set that exact reply reminder',
      );
      expect(getAllTasks()).toHaveLength(0);
    },
  );

  it.each([false, undefined])(
    'requires explicit owner authority (%s)',
    async (ownerReviewAllowed) => {
      const opened = await openBob();
      const result = await remind(
        'remind me tomorrow at 9am',
        opened.conversationSeed?.subjectData,
        { ownerReviewAllowed, chatJid: 'tg:karen' },
      );
      expect(result.replyText).toContain('registered owner control chat');
      expect(result.replyText).not.toContain('reply to Bob');
      expect(getAllTasks()).toHaveLength(0);
    },
  );

  it('does not inherit a person from an empty or already-answered conversation', async () => {
    const answered = await openBob(baseContext, true);
    expect(answered.replyText).toContain('Nothing open');
    for (const seed of [
      answered.conversationSeed?.subjectData,
      {
        activeCapabilityId: 'communication.open_loops' as const,
        personName: 'Bob',
      },
    ]) {
      expect(
        continueAssistantCapabilityFromPriorSubjectData(
          'remind me tomorrow at 9am',
          seed,
        ),
      ).toBeNull();
      await remind('remind me tomorrow at 9am', seed);
    }
    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects malformed and changed exact targets before writing', async () => {
    const opened = await openBob();
    const seed = opened.conversationSeed?.subjectData;
    await remind('remind me tomorrow at 9am', {
      ...seed,
      namedMessagesSummaryTargetJson: JSON.stringify({ query: 'Bob' }),
    });
    expect(getAllTasks()).toHaveLength(0);
    storeChatMetadata(
      bobJid,
      '2026-09-06T00:30:00.000Z',
      'Different person',
      'bluebubbles',
      false,
    );
    await remind('remind me tomorrow at 9am', seed);
    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects a target that has become a group', async () => {
    const opened = await openBob();
    storeChatMetadata(
      bobJid,
      '2026-09-06T00:30:00.000Z',
      'Bob',
      'bluebubbles',
      true,
    );
    await remind(
      'remind me tomorrow at 9am',
      opened.conversationSeed?.subjectData,
    );
    expect(getAllTasks()).toHaveLength(0);
  });

  it('never routes compound send or substituted reminder bodies as a named clock continuation', async () => {
    const opened = await openBob();
    for (const text of [
      'remind me tomorrow at 9am and send it',
      'remind me Friday at 9am and send it',
      'remind me next Friday at 9am and send it',
      'remind me to pay Bob tomorrow at 9am',
      'remind me to pay Bob Friday at 9am',
      'remind me to pay Bob next Friday at 9am',
      'send it',
    ]) {
      expect(
        continueAssistantCapabilityFromPriorSubjectData(
          text,
          opened.conversationSeed?.subjectData,
        ),
      ).toBeNull();
    }
    expect(getAllTasks()).toHaveLength(0);
  });
});
