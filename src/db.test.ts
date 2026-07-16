import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteRegisteredGroup,
  deleteTask,
  getAllChats,
  findOpenCognitiveCheckpoint,
  getCursorMessageContext,
  getCursorOperatorContext,
  getAllRegisteredGroups,
  getCognitiveCheckpoint,
  getCognitiveGoal,
  getRegisteredMainChat,
  getLastBotMessageTimestamp,
  getActionableMessagesSince,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getTaskById,
  insertCognitiveBenchmarkAttempt,
  insertCognitiveReflection,
  insertCognitiveRewardSignal,
  listCognitiveAutonomyBudgets,
  listCognitiveBenchmarkAttempts,
  listCognitiveBlackboardEntries,
  listCognitiveCheckpoints,
  listCognitiveGoals,
  listCognitiveReflections,
  listCognitiveRewardSignals,
  listCognitiveRuns,
  listCognitiveSubgoalsForRun,
  listCognitiveToolRegistry,
  listCognitiveWorldBeliefs,
  listRecentMessagesForChat,
  pruneCognitiveKernelData,
  quarantineStaleBlueBubblesMessagesForRecovery,
  pruneChatBoundEphemeralContexts,
  repairRegisteredMainChat,
  replaceCognitiveSubgoalsForRun,
  resolveCognitiveCheckpoint,
  setRegisteredGroup,
  storeCursorMessageContext,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
  upsertCognitiveCheckpoint,
  upsertCognitiveAutonomyBudget,
  upsertCognitiveBlackboardEntry,
  upsertCognitiveGoal,
  upsertCognitiveRun,
  upsertCognitiveToolRegistry,
  upsertCognitiveWorldBelief,
  upsertCursorOperatorContext,
  updateTask,
} from './db.js';
import { formatMessages } from './router.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  thread_id?: string;
  reply_to_id?: string;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
    thread_id: overrides.thread_id,
    reply_to_id: overrides.reply_to_id,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('stores reply and thread metadata for reply-linked operator flows', () => {
    storeChatMetadata('tg:1', '2024-01-01T00:00:00.000Z');

    store({
      id: 'tg-msg-1',
      chat_jid: 'tg:1',
      sender: '123',
      sender_name: 'Alice',
      content: 'replying to a cursor card',
      timestamp: '2024-01-01T00:00:06.000Z',
      thread_id: '42',
      reply_to_id: '9001',
    });

    const messages = getMessagesSince('tg:1', '', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].thread_id).toBe('42');
    expect(messages[0].reply_to_id).toBe('9001');
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('recovers cursor from last bot reply when lastAgentTimestamp is missing', () => {
    // beforeEach already inserts m3 (bot reply at 00:00:03) and m4 (user at 00:00:04)
    // Add more old history before the bot reply
    for (let i = 1; i <= 50; i++) {
      store({
        id: `history-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `old message ${i}`,
        timestamp: `2023-06-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    // New message after the bot reply (m3 at 00:00:03)
    store({
      id: 'new-1',
      chat_jid: 'group@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'new message after bot reply',
      timestamp: '2024-01-02T00:00:00.000Z',
    });

    // Recover cursor from the last bot message (m3 from beforeEach)
    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // Using recovered cursor: only gets messages after the bot reply
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    // m4 (third, 00:00:04) + new-1 — skips all 50 old messages and m1/m2
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('third');
    expect(msgs[1].content).toBe('new message after bot reply');
  });

  it('caps messages to configured limit even with recovered cursor', () => {
    // beforeEach inserts m3 (bot at 00:00:03). Add 30 messages after it.
    for (let i = 1; i <= 30; i++) {
      store({
        id: `pending-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `pending message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('group@g.us', 'Andy');
    expect(recovered).toBe('2024-01-01T00:00:03.000Z');

    // With limit=10, only the 10 most recent are returned
    const msgs = getMessagesSince('group@g.us', recovered!, 'Andy', 10);
    expect(msgs).toHaveLength(10);
    // Most recent 10: pending-21 through pending-30
    expect(msgs[0].content).toBe('pending message 21');
    expect(msgs[9].content).toBe('pending message 30');
  });

  it('returns last N messages when no bot reply and no cursor exist', () => {
    // Use a fresh group with no bot messages
    storeChatMetadata('fresh@g.us', '2024-01-01T00:00:00.000Z');
    for (let i = 1; i <= 20; i++) {
      store({
        id: `fresh-${i}`,
        chat_jid: 'fresh@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-02-${String(i).padStart(2, '0')}T12:00:00.000Z`,
      });
    }

    const recovered = getLastBotMessageTimestamp('fresh@g.us', 'Andy');
    expect(recovered).toBeUndefined();

    // No cursor → sinceTimestamp = '' but limit caps the result
    const msgs = getMessagesSince('fresh@g.us', '', 'Andy', 10);
    expect(msgs).toHaveLength(10);

    const prompt = formatMessages(msgs, 'Asia/Jerusalem');
    const messageTagCount = (prompt.match(/<message /g) || []).length;
    expect(messageTagCount).toBe(10);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

describe('message ingress provenance', () => {
  it('keeps provider-hydrated Messages history visible as context but never actionable', () => {
    const chatJid = 'bb:iMessage;-;+15550001111';
    storeChatMetadata(
      chatJid,
      '2026-07-16T18:00:00.000Z',
      'Contact',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:history-newer-than-cursor',
      chat_jid: chatJid,
      sender: 'bb:+15550001111',
      sender_name: 'Contact',
      content: '@Andrea this is provider history, not a new prompt',
      timestamp: '2026-07-16T18:01:00.000Z',
      is_from_me: false,
      message_ingress_origin: 'history_hydration',
    });

    expect(
      listRecentMessagesForChat(chatJid, 10).map((message) => message.id),
    ).toContain('bb:history-newer-than-cursor');
    expect(
      getMessagesSince(chatJid, '2026-07-16T18:00:30.000Z', 'Andrea').map(
        (message) => message.id,
      ),
    ).toContain('bb:history-newer-than-cursor');
    expect(
      getActionableMessagesSince(chatJid, '2026-07-16T18:00:30.000Z', 'Andrea'),
    ).toEqual([]);
    expect(
      getNewMessages([chatJid], '2026-07-16T18:00:30.000Z', 'Andrea').messages,
    ).toEqual([]);
  });

  it('does not let provider history hitchhike beside a later live self-thread turn', () => {
    const chatJid = 'bb:iMessage;-;owner@example.invalid';
    storeChatMetadata(
      chatJid,
      '2026-07-16T18:10:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:historical-command',
      chat_jid: chatJid,
      sender: 'bb:owner',
      sender_name: 'Owner',
      content: '@Andrea send this old message to a contact',
      timestamp: '2026-07-16T18:09:00.000Z',
      is_from_me: true,
      message_ingress_origin: 'history_hydration',
    });
    storeMessage({
      id: 'bb:current-live-question',
      chat_jid: chatJid,
      sender: 'bb:owner',
      sender_name: 'Owner',
      content: '@Andrea what is new?',
      timestamp: '2026-07-16T18:10:00.000Z',
      is_from_me: true,
    });

    expect(
      getActionableMessagesSince(chatJid, '', 'Andrea').map(
        (message) => message.id,
      ),
    ).toEqual(['bb:current-live-question']);
    expect(
      getMessagesSince(chatJid, '', 'Andrea').map((message) => message.id),
    ).toEqual(['bb:historical-command', 'bb:current-live-question']);
  });

  it('quarantines stale live Messages rows without hiding them from summaries or context', () => {
    const chatJid = 'bb:iMessage;-;+15550002222';
    storeChatMetadata(
      chatJid,
      '2026-07-16T18:20:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:stale-live',
      chat_jid: chatJid,
      sender: 'bb:owner',
      sender_name: 'Owner',
      content: '@Andrea old live command',
      timestamp: '2026-07-16T18:00:00.000Z',
      is_from_me: true,
      message_ingress_origin: 'live',
    });
    storeMessageDirect({
      id: 'bb:fresh-live',
      chat_jid: chatJid,
      sender: 'bb:owner',
      sender_name: 'Owner',
      content: '@Andrea current live command',
      timestamp: '2026-07-16T18:20:00.000Z',
      is_from_me: true,
      message_ingress_origin: 'live',
    });

    expect(
      quarantineStaleBlueBubblesMessagesForRecovery('2026-07-16T18:15:00.000Z'),
    ).toBe(1);
    expect(
      getActionableMessagesSince(chatJid, '', 'Andrea').map(
        (message) => message.id,
      ),
    ).toEqual(['bb:fresh-live']);
    expect(
      listRecentMessagesForChat(chatJid, 10).map((message) => message.id),
    ).toEqual(expect.arrayContaining(['bb:stale-live', 'bb:fresh-live']));
    expect(
      getMessagesSince(chatJid, '', 'Andrea').map((message) => message.id),
    ).toEqual(expect.arrayContaining(['bb:stale-live', 'bb:fresh-live']));
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('does not let placeholder BlueBubbles names overwrite a friendly title', () => {
    storeChatMetadata(
      'bb:iMessage;+;chat123',
      '2024-01-01T00:00:00.000Z',
      'Pops of Punk',
      'bluebubbles',
      true,
    );
    storeChatMetadata(
      'bb:iMessage;+;chat123',
      '2024-01-01T00:00:01.000Z',
      'bb:iMessage;+;chat123',
      'bluebubbles',
      true,
    );
    storeChatMetadata(
      'bb:iMessage;+;chat123',
      '2024-01-01T00:00:02.000Z',
      'iMessage;+;chat123',
      'bluebubbles',
      true,
    );
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Pops of Punk');
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:02.000Z');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('registered main chat repair', () => {
  it('returns the registered main chat record', () => {
    setRegisteredGroup('tg:runtime-proof', {
      name: 'Runtime Proof',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-02T20:45:00.000Z',
      requiresTrigger: false,
      isMain: true,
    });

    expect(getRegisteredMainChat()).toEqual(
      expect.objectContaining({
        jid: 'tg:runtime-proof',
        folder: 'main',
        isMain: true,
      }),
    );
  });

  it('repairs a stale synthetic main registration to the live Telegram DM', () => {
    setRegisteredGroup('tg:runtime-proof', {
      name: 'Runtime Proof',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-02T20:45:00.000Z',
      requiresTrigger: false,
      isMain: true,
    });
    storeChatMetadata(
      'tg:100000001',
      '2026-04-04T18:37:12.000Z',
      'Jeff',
      'telegram',
      false,
    );
    upsertCursorOperatorContext({
      chatJid: 'tg:runtime-proof',
      selectedLaneId: 'cursor',
      selectedAgentId: 'bc_123',
      updatedAt: '2026-04-04T18:37:12.000Z',
    });
    storeCursorMessageContext({
      chatJid: 'tg:runtime-proof',
      platformMessageId: '9001',
      contextKind: 'cursor_job_card',
      laneId: 'cursor',
      agentId: 'bc_123',
      createdAt: '2026-04-04T18:37:12.000Z',
    });

    const repaired = repairRegisteredMainChat({
      fromJid: 'tg:runtime-proof',
      toJid: 'tg:100000001',
      toName: 'Jeff',
    });

    expect(repaired.jid).toBe('tg:100000001');
    expect(repaired.name).toBe('Jeff');
    expect(repaired.folder).toBe('main');
    expect(getRegisteredGroup('tg:runtime-proof')).toBeUndefined();
    expect(getRegisteredMainChat()?.jid).toBe('tg:100000001');
    expect(getCursorOperatorContext('tg:runtime-proof')).toBeUndefined();
    expect(getCursorMessageContext('tg:runtime-proof', '9001')).toBeUndefined();
  });

  it('prunes chat-bound ephemeral contexts without touching registrations', () => {
    setRegisteredGroup('tg:runtime-proof', {
      name: 'Runtime Proof',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-02T20:45:00.000Z',
      requiresTrigger: false,
      isMain: true,
    });
    upsertCursorOperatorContext({
      chatJid: 'tg:runtime-proof',
      selectedLaneId: 'cursor',
      selectedAgentId: 'bc_123',
      updatedAt: '2026-04-04T18:37:12.000Z',
    });
    storeCursorMessageContext({
      chatJid: 'tg:runtime-proof',
      platformMessageId: '9001',
      contextKind: 'cursor_job_card',
      laneId: 'cursor',
      agentId: 'bc_123',
      createdAt: '2026-04-04T18:37:12.000Z',
    });

    expect(pruneChatBoundEphemeralContexts('tg:runtime-proof')).toBeGreaterThan(
      0,
    );
    expect(getCursorOperatorContext('tg:runtime-proof')).toBeUndefined();
    expect(getCursorMessageContext('tg:runtime-proof', '9001')).toBeUndefined();
    expect(getRegisteredMainChat()?.jid).toBe('tg:runtime-proof');
  });

  it('allows deleting a stale registered group explicitly', () => {
    setRegisteredGroup('tg:runtime-proof', {
      name: 'Runtime Proof',
      folder: 'main',
      trigger: '@Andrea',
      added_at: '2026-04-02T20:45:00.000Z',
      requiresTrigger: false,
      isMain: true,
    });

    deleteRegisteredGroup('tg:runtime-proof');
    expect(getRegisteredMainChat()).toBeUndefined();
  });
});

describe('cursor operator context accessors', () => {
  it('stores selection per chat and thread', () => {
    upsertCursorOperatorContext({
      chatJid: 'tg:1',
      threadId: '42',
      selectedLaneId: 'cursor',
      selectedAgentId: 'bc_123',
      selectedJobsByLaneJson: JSON.stringify({ cursor: 'bc_123' }),
      updatedAt: '2026-03-30T12:00:00.000Z',
    });

    const row = getCursorOperatorContext('tg:1', '42');
    expect(row?.selected_agent_id).toBe('bc_123');
    expect(row?.selected_lane_id).toBe('cursor');
    expect(row?.selected_jobs_by_lane_json).toContain('bc_123');
    expect(getCursorOperatorContext('tg:1', undefined)).toBeUndefined();
  });

  it('preserves existing snapshot fields when updating selection only', () => {
    upsertCursorOperatorContext({
      chatJid: 'tg:1',
      threadId: '',
      lastListSnapshotJson: JSON.stringify([
        { laneId: 'cursor', id: 'bc_123', provider: 'cloud' },
      ]),
      lastListMessageId: '99',
      dashboardMessageId: '555',
      updatedAt: '2026-03-30T12:00:00.000Z',
    });

    upsertCursorOperatorContext({
      chatJid: 'tg:1',
      selectedLaneId: 'cursor',
      selectedAgentId: 'bc_123',
      selectedJobsByLaneJson: JSON.stringify({ cursor: 'bc_123' }),
      updatedAt: '2026-03-30T12:05:00.000Z',
    });

    const row = getCursorOperatorContext('tg:1');
    expect(row?.selected_agent_id).toBe('bc_123');
    expect(row?.selected_lane_id).toBe('cursor');
    expect(row?.selected_jobs_by_lane_json).toContain('bc_123');
    expect(row?.last_list_message_id).toBe('99');
    expect(row?.dashboard_message_id).toBe('555');
    expect(row?.last_list_snapshot_json).toContain('bc_123');
  });
});

describe('cursor message context accessors', () => {
  it('stores message-to-agent linkage for reply resolution', () => {
    storeCursorMessageContext({
      chatJid: 'tg:1',
      platformMessageId: '9001',
      threadId: '42',
      contextKind: 'cursor_job_card',
      laneId: 'cursor',
      agentId: 'bc_123',
      payloadJson: JSON.stringify({ provider: 'cloud' }),
      createdAt: '2026-03-30T12:00:00.000Z',
    });

    const row = getCursorMessageContext('tg:1', '9001');
    expect(row?.agent_id).toBe('bc_123');
    expect(row?.lane_id).toBe('cursor');
    expect(row?.context_kind).toBe('cursor_job_card');
    expect(row?.thread_id).toBe('42');
  });
});

describe('cognitive kernel persistence', () => {
  function storeCognitiveRun(runId: string, createdAt: string) {
    upsertCognitiveRun({
      runId,
      createdAt,
      updatedAt: createdAt,
      groupFolder: null,
      channel: 'telegram',
      taskFamily: 'assistant',
      turnId: runId,
      runOrigin: 'live',
      goalSummary: 'metadata-only test goal',
      selectedSkillId: 'assistant.daily_guidance',
      status: 'planned',
      autonomyLevel: 'plan_draft_only',
      cognitiveMode: 'reactive_plan',
      taskGraphJson: '{}',
      evidenceContractJson: '{}',
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0.5,
      nextAction: 'continue',
      privacyJson: '{}',
      linkedSkillCardId: null,
    });
  }

  it('prunes cognitive run children before pruning old run metadata', () => {
    storeCognitiveRun('cog-old', '2026-01-01T00:00:00.000Z');
    replaceCognitiveSubgoalsForRun('cog-old', [
      {
        subgoalId: 'subgoal-old',
        runId: 'cog-old',
        position: 1,
        title: 'Frame',
        status: 'ready',
        requiredEvidence: 'sanitized_goal',
        allowedActionsJson: '[]',
        approvalNeed: 'none',
        stopCondition: 'framed',
        toolPlanJson: '[]',
        verificationJson: '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    insertCognitiveRewardSignal({
      signalId: 'reward-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      runId: 'cog-old',
      skillId: null,
      signalKind: 'task_answered',
      score: 0.5,
      summary: 'metadata-only reward',
      flagsJson: '[]',
    });
    insertCognitiveReflection({
      reflectionId: 'reflection-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      groupFolder: null,
      runId: 'cog-old',
      skillId: null,
      taskFamily: 'assistant',
      reflectionKind: 'success',
      summary: 'metadata-only reflection',
      routeKey: 'assistant.daily_guidance',
      providerStateJson: '{}',
      nextRule: 'continue',
      confidence: 0.5,
      privacyJson: '{}',
    });
    upsertCognitiveGoal({
      goalId: 'goal-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      groupFolder: null,
      parentGoalId: null,
      rootRunId: 'cog-old',
      taskFamily: 'assistant',
      objectiveSummary: 'old metadata-only goal',
      status: 'active',
      priority: 0.5,
      successCriteriaJson: '{}',
      decompositionJson: '[]',
      linkedRunIdsJson: '["cog-old"]',
      activeCheckpointId: null,
      rewardScore: 0.5,
      nextAction: 'old',
      closedAt: null,
      privacyJson: '{}',
    });
    upsertCognitiveBlackboardEntry({
      entryId: 'blackboard-old',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      groupFolder: null,
      goalId: 'goal-old',
      runId: 'cog-old',
      entryKind: 'observation',
      source: 'kernel',
      status: 'active',
      summary: 'old metadata-only observation',
      evidenceRefsJson: '["cog-old"]',
      confidence: 0.5,
      expiresAt: null,
      privacyJson: '{}',
    });

    pruneCognitiveKernelData({
      cutoffIso: '2026-02-01T00:00:00.000Z',
      retainLimit: 1000,
    });

    expect(listCognitiveRuns({ limit: 10 })).toEqual([]);
    expect(listCognitiveSubgoalsForRun('cog-old')).toEqual([]);
    expect(listCognitiveRewardSignals({ runId: 'cog-old' })).toEqual([]);
    expect(listCognitiveReflections({ taskFamily: 'assistant' })).toEqual([]);
    expect(listCognitiveBlackboardEntries({ runId: 'cog-old' })).toEqual([]);
    expect(getCognitiveGoal('goal-old')?.rootRunId).toBeNull();
  });

  it('rejects cognitive subgoals that belong to another run', () => {
    storeCognitiveRun('cog-a', '2026-01-01T00:00:00.000Z');

    expect(() =>
      replaceCognitiveSubgoalsForRun('cog-a', [
        {
          subgoalId: 'subgoal-b',
          runId: 'cog-b',
          position: 1,
          title: 'Mismatched',
          status: 'ready',
          requiredEvidence: 'sanitized_goal',
          allowedActionsJson: '[]',
          approvalNeed: 'none',
          stopCondition: 'framed',
          toolPlanJson: '[]',
          verificationJson: '{}',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    ).toThrow(/belongs to cog-b/);
  });

  it('stores checkpoint, tool, world belief, and benchmark metadata', () => {
    storeCognitiveRun('cog-v7', '2026-06-05T12:00:00.000Z');
    const syntheticApiKey = ['sk', 'testexample1234567890'].join('-');

    upsertCognitiveCheckpoint({
      checkpointId: 'checkpoint-v7',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      runId: 'cog-v7',
      subgoalId: null,
      groupFolder: 'main',
      channel: 'telegram',
      checkpointKind: 'approval_wait',
      status: 'open',
      summary: 'metadata-only checkpoint',
      stateJson: '{"approvalRequired":true}',
      nextAction: 'wait for approval',
      continuationKey: 'assistant:daily',
      expiresAt: null,
      resolvedAt: null,
      privacyJson: '{"rawPrivateBodiesStored":false}',
    });
    expect(getCognitiveCheckpoint('checkpoint-v7')?.status).toBe('open');
    expect(
      listCognitiveCheckpoints({ groupFolder: 'main', channel: 'telegram' }),
    ).toHaveLength(1);

    resolveCognitiveCheckpoint('checkpoint-v7', {
      resolvedAt: '2026-06-05T12:05:00.000Z',
      nextAction: 'closed safely',
    });
    expect(getCognitiveCheckpoint('checkpoint-v7')?.status).toBe('closed');

    upsertCognitiveToolRegistry({
      toolId: 'tool-v7',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      toolKind: 'read_only_integration',
      displayName: 'Tool v7',
      purpose: 'Read only metadata.',
      allowedActionsJson: '["read"]',
      approvalPolicy: 'read_only',
      riskLevel: 'medium',
      evidenceProducedJson: '["metadata"]',
      failureModesJson: '["blocked"]',
      lastVerifiedAt: '2026-06-05T12:00:00.000Z',
      healthState: 'healthy',
      privacyJson: '{}',
    });
    expect(
      listCognitiveToolRegistry({ toolKind: 'read_only_integration' })[0],
    ).toMatchObject({ toolId: 'tool-v7' });

    upsertCognitiveWorldBelief({
      beliefId: 'belief-v7',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      groupFolder: 'main',
      runId: 'cog-v7',
      source: 'provider_health',
      subject: 'provider_health',
      summary: 'providers usable',
      confidence: 0.8,
      freshness: 'fresh',
      supersedesBeliefId: null,
      privacyJson: '{}',
    });
    expect(listCognitiveWorldBeliefs({ runId: 'cog-v7' })[0]).toMatchObject({
      beliefId: 'belief-v7',
    });

    upsertCognitiveGoal({
      goalId: 'goal-v8',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      groupFolder: 'main',
      parentGoalId: null,
      rootRunId: 'cog-v7',
      taskFamily: 'assistant',
      objectiveSummary: `metadata-only goal with phone +12025550101 and key ${syntheticApiKey}`,
      status: 'active',
      priority: 0.8,
      successCriteriaJson: JSON.stringify({
        secret: syntheticApiKey,
        email: 'person@example.com',
      }),
      decompositionJson: '[{"title":"metadata only"}]',
      linkedRunIdsJson: '["cog-v7","+12025550101"]',
      activeCheckpointId: null,
      rewardScore: 0.7,
      nextAction: 'continue without raw private bodies',
      closedAt: null,
      privacyJson: '{"rawPrivateBodiesStored":false}',
    });
    expect(getCognitiveGoal('goal-v8')).toMatchObject({
      goalId: 'goal-v8',
      status: 'active',
    });
    expect(JSON.stringify(getCognitiveGoal('goal-v8'))).not.toMatch(
      /sk-testexample|12025550101|person@example\.com/,
    );
    expect(listCognitiveGoals({ taskFamily: 'assistant' })[0]?.goalId).toBe(
      'goal-v8',
    );

    upsertCognitiveBlackboardEntry({
      entryId: 'blackboard-v8',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      groupFolder: 'main',
      goalId: 'goal-v8',
      runId: 'cog-v7',
      entryKind: 'constraint',
      source: 'kernel',
      status: 'active',
      summary:
        'metadata-only blackboard entry with token Bearer abcdefghijklmnop',
      evidenceRefsJson: '["person@example.com","+12025550101"]',
      confidence: 0.8,
      expiresAt: null,
      privacyJson: '{"secretsRedacted":true}',
    });
    expect(
      listCognitiveBlackboardEntries({ runId: 'cog-v7' })[0],
    ).toMatchObject({ entryId: 'blackboard-v8', entryKind: 'constraint' });
    expect(
      JSON.stringify(listCognitiveBlackboardEntries({ runId: 'cog-v7' })),
    ).not.toMatch(/abcdefghijklmnop|person@example\.com|12025550101/);

    upsertCognitiveAutonomyBudget({
      budgetId: 'budget-v8',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      cognitiveMode: 'read_only_react',
      taskFamily: 'assistant',
      maxToolSteps: 4,
      maxCouncilCalls: 0,
      maxReadOnlyCalls: 2,
      mutatingAllowed: false,
      approvalRequired: false,
      maxRuntimeMs: 15000,
      clarificationAfterBlockedSteps: 1,
      budgetJson: JSON.stringify({ token: syntheticApiKey, readOnly: true }),
      privacyJson: '{"rawToolOutputStored":false}',
    });
    expect(
      listCognitiveAutonomyBudgets({
        cognitiveMode: 'read_only_react',
        taskFamily: 'assistant',
      })[0],
    ).toMatchObject({ budgetId: 'budget-v8', mutatingAllowed: false });
    expect(JSON.stringify(listCognitiveAutonomyBudgets())).not.toMatch(
      /sk-testexample/,
    );

    insertCognitiveBenchmarkAttempt({
      attemptId: 'bench-v7',
      createdAt: '2026-06-05T12:00:00.000Z',
      taskId: 'quick-guidance',
      taskFamily: 'assistant',
      status: 'pass',
      score: 1,
      runId: 'cog-v7',
      checkpointCount: 4,
      toolPolicyPass: true,
      approvalGatePass: true,
      privacyPass: true,
      outcomeCaptured: true,
      nextAction: 'continue',
      detailJson: '{}',
    });
    expect(
      listCognitiveBenchmarkAttempts({ taskId: 'quick-guidance' })[0],
    ).toMatchObject({ attemptId: 'bench-v7', status: 'pass' });
  });

  it('does not resume expired cognitive checkpoints', () => {
    storeCognitiveRun('cog-expired', '2026-06-05T12:00:00.000Z');
    upsertCognitiveCheckpoint({
      checkpointId: 'checkpoint-expired',
      createdAt: '2026-06-05T12:00:00.000Z',
      updatedAt: '2026-06-05T12:00:00.000Z',
      runId: 'cog-expired',
      subgoalId: null,
      groupFolder: 'main',
      channel: 'bluebubbles',
      checkpointKind: 'approval_wait',
      status: 'open',
      summary: 'expired approval checkpoint',
      stateJson: '{}',
      nextAction: 'should not resume',
      continuationKey: 'communication:reply',
      expiresAt: '2000-01-01T00:00:00.000Z',
      resolvedAt: null,
      privacyJson: '{}',
    });

    expect(
      findOpenCognitiveCheckpoint({
        groupFolder: 'main',
        channel: 'bluebubbles',
        continuationKey: 'communication:reply',
      }),
    ).toBeUndefined();
  });

  it('prunes v7 cognitive metadata linked to old runs', () => {
    storeCognitiveRun('cog-old-v7', '2026-01-01T00:00:00.000Z');
    upsertCognitiveCheckpoint({
      checkpointId: 'checkpoint-old-v7',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runId: 'cog-old-v7',
      subgoalId: null,
      groupFolder: null,
      channel: 'telegram',
      checkpointKind: 'frame',
      status: 'closed',
      summary: 'old',
      stateJson: '{}',
      nextAction: 'old',
      continuationKey: null,
      expiresAt: null,
      resolvedAt: '2026-01-01T00:00:00.000Z',
      privacyJson: '{}',
    });
    upsertCognitiveWorldBelief({
      beliefId: 'belief-old-v7',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      groupFolder: null,
      runId: 'cog-old-v7',
      source: 'local_metadata',
      subject: 'old',
      summary: 'old',
      confidence: 0.5,
      freshness: 'stale',
      supersedesBeliefId: null,
      privacyJson: '{}',
    });
    insertCognitiveBenchmarkAttempt({
      attemptId: 'bench-old-v7',
      createdAt: '2026-01-01T00:00:00.000Z',
      taskId: 'old',
      taskFamily: 'assistant',
      status: 'pass',
      score: 1,
      runId: 'cog-old-v7',
      checkpointCount: 4,
      toolPolicyPass: true,
      approvalGatePass: true,
      privacyPass: true,
      outcomeCaptured: true,
      nextAction: 'old',
      detailJson: '{}',
    });

    pruneCognitiveKernelData({
      cutoffIso: '2026-02-01T00:00:00.000Z',
      retainLimit: 1000,
    });

    expect(listCognitiveCheckpoints({ runId: 'cog-old-v7' })).toEqual([]);
    expect(listCognitiveWorldBeliefs({ runId: 'cog-old-v7' })).toEqual([]);
    expect(listCognitiveBenchmarkAttempts({ taskId: 'old' })).toEqual([]);
  });
});
