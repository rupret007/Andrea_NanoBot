import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getAllTasks,
  listCommunicationThreadsForGroup,
  storeChatMetadata,
  storeMessageDirect,
  upsertProfileSubject,
} from './db.js';
import {
  analyzeCommunicationMessage,
  buildCommunicationOpenLoops,
  draftCommunicationReply,
  getCommunicationCarryoverSignal,
  manageCommunicationTracking,
} from './communication-companion.js';
import type { ProfileSubject } from './types.js';

function seedCandace(): ProfileSubject {
  const subject: ProfileSubject = {
    id: 'subject-candace',
    groupFolder: 'main',
    kind: 'person',
    canonicalName: 'candace',
    displayName: 'Candace',
    createdAt: '2026-04-06T08:00:00.000Z',
    updatedAt: '2026-04-06T08:00:00.000Z',
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

describe('communication companion', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('analyzes an explicit message and creates an inferred communication thread', () => {
    seedCandace();

    const result = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Summarize this message: Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.followupState).toBe('scheduled');
    expect(result.urgency).toBe('tonight');
    expect(result.summaryText).toContain('Candace');

    const threads = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 10,
    });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.followupState).toBe('scheduled');
    expect(threads[0]?.linkedSubjectIds).toContain('subject-candace');
  });

  it('falls back to the latest inbound message in the current chat when needed', () => {
    seedCandace();
    storeChatMetadata(
      'bb:chat-1',
      '2026-04-06T10:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:msg-1',
      chat_jid: 'bb:chat-1',
      sender: '+15551234567',
      sender_name: 'Candace',
      content: 'Can you send me the address when you get a chance?',
      timestamp: '2026-04-06T10:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const result = analyzeCommunicationMessage({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:chat-1',
      now: new Date('2026-04-06T10:05:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.messageText).toContain('address');
    expect(result.followupState).toBe('reply_needed');
  });

  it('builds warmer drafts from relationship-aware message context', () => {
    seedCandace();

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'Make it warmer: Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.style).toBe('warmer');
    expect(result.draftText).toContain('Hey Candace,');
    expect(result.draftText).toMatch(/let me know/i);
  });

  it('summarizes what is still owed and respects manual-only carryover suppression', () => {
    seedCandace();
    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    const openLoops = buildCommunicationOpenLoops({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'What do I owe people?',
      now: new Date('2026-04-06T09:05:00.000Z'),
    });

    expect(openLoops.summaryText).toContain('open conversation');
    expect(openLoops.items[0]?.personName).toBe('Candace');

    const suppressed = manageCommunicationTracking({
      channel: 'telegram',
      groupFolder: 'main',
      text: "don't surface this automatically: Candace: Can you let me know if dinner still works tonight?",
      now: new Date('2026-04-06T09:10:00.000Z'),
    });

    expect(suppressed.ok).toBe(true);
    expect(suppressed.replyText).toContain('stop surfacing');
    expect(getCommunicationCarryoverSignal({ groupFolder: 'main' })).toBeNull();
  });

  it('can turn an open conversation into a reply-later reminder', () => {
    seedCandace();

    const result = manageCommunicationTracking({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Remind me to reply later tonight: Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.reminderTaskId).toBeTruthy();
    expect(getAllTasks().some((task) => task.id === result.reminderTaskId)).toBe(
      true,
    );
  });
});
