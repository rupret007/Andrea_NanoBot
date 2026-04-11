import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getAllTasks,
  listCommunicationThreadsForGroup,
  storeChatMetadata,
  storeMessageDirect,
  upsertLifeThread,
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

  it('skips the current companion ask when falling back to BlueBubbles chat context', () => {
    seedCandace();
    storeChatMetadata(
      'bb:chat-2',
      '2026-04-06T10:06:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:msg-older',
      chat_jid: 'bb:chat-2',
      sender: '+15551234567',
      sender_name: 'Candace',
      content: 'Can you send me the address when you get a chance?',
      timestamp: '2026-04-06T10:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'bb:msg-ask',
      chat_jid: 'bb:chat-2',
      sender: '+15551234567',
      sender_name: 'Candace',
      content: 'summarize this',
      timestamp: '2026-04-06T10:05:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const result = analyzeCommunicationMessage({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:chat-2',
      now: new Date('2026-04-06T10:06:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.messageText).toContain('address');
    expect(result.messageText).not.toContain('summarize this');
  });

  it('can reuse recent self-chat context across BlueBubbles self handles for draft replies', () => {
    storeChatMetadata(
      'bb:iMessage;-;+14695405551',
      '2026-04-10T00:03:20.633Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;-;jeffstory007@gmail.com',
      '2026-04-10T00:04:05.518Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-handle-source-1',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'bb:+14695405551',
      sender_name: 'Jeff',
      content:
        '@Andrea Che is saying this.\n\nSo we’re pretty sure about Saturday right? I’m just making sure you’ve got a few mixed messages lol.',
      timestamp: '2026-04-10T00:03:03.567Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'bb:self-handle-source-2',
      chat_jid: 'bb:iMessage;-;+14695405551',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest show summary.',
      timestamp: '2026-04-10T00:03:20.633Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'bb:self-handle-ask-1',
      chat_jid: 'bb:iMessage;-;jeffstory007@gmail.com',
      sender: 'bb:jeffstory007@gmail.com',
      sender_name: 'Jeff',
      content: '@Andrea what should I send back?',
      timestamp: '2026-04-10T00:04:05.518Z',
      is_from_me: true,
      is_bot_message: false,
    });

    const result = draftCommunicationReply({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      text: 'what should I send back',
      now: new Date('2026-04-10T00:04:30.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).toContain('Saturday');
    expect(result.thread?.channelChatJid).toBe(
      'bb:iMessage;-;jeffstory007@gmail.com',
    );
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

  it('phrases confirmation asks more naturally in summaries and drafts', () => {
    const analysis = analyzeCommunicationMessage({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:test',
      text: 'Summarize this message: Band: can you confirm tonight by 6 if you are in?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    const draft = draftCommunicationReply({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:test',
      text: 'what should I say back',
      conversationSummary: analysis.summaryText,
      priorContext: analysis.thread
        ? {
            communicationThreadId: analysis.thread.id,
            lastCommunicationSummary: analysis.summaryText,
          }
        : undefined,
      now: new Date('2026-04-06T09:05:00.000Z'),
    });

    expect(analysis.ok).toBe(true);
    expect(analysis.summaryText).toContain('whether you are in by 6 tonight');
    expect(analysis.summaryText).not.toContain('about confirm');
    expect(draft.ok).toBe(true);
    expect(draft.draftText).toContain('whether you are in by 6 tonight');
  });

  it('strips saved-note command wording from relationship-aware draft support lines', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-dinner-proof',
      groupFolder: 'main',
      title: 'Candace',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['candace', 'dinner'],
      summary: 'Candace dinner follow-up.',
      nextAction:
        'Save this to my library as Knowledge Proof Dinner A: Friday dinner after rehearsal keeps pickup simpler and avoids a late bedtime. tags: proof,candace',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'high',
      userConfirmed: true,
      sensitivity: 'sensitive',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
      mergedIntoThreadId: null,
      createdAt: '2026-04-06T08:00:00.000Z',
      lastUpdatedAt: '2026-04-06T08:00:00.000Z',
      lastUsedAt: null,
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I say back',
      conversationSummary: 'Candace wants a follow-up about whether dinner still works tonight.',
      priorContext: {
        lastCommunicationSummary:
          'Candace wants a follow-up about whether dinner still works tonight.',
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain(
      'Friday dinner after rehearsal keeps pickup simpler and avoids a late bedtime',
    );
    expect(result.draftText).not.toContain('Save this to my library as');
    expect(result.draftText).not.toContain('tags:');
  });

  it('does not recycle leaked draft blocks back into the draft body', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-dirty-draft',
      groupFolder: 'main',
      title: 'Candace',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['candace', 'dinner'],
      summary: 'Candace dinner follow-up.',
      nextAction:
        'Candace wants a follow-up about whether dinner still works tonight. Draft: Hey Candace, I wanted to check in about whether dinner still works tonight.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'high',
      userConfirmed: true,
      sensitivity: 'sensitive',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
      mergedIntoThreadId: null,
      createdAt: '2026-04-06T08:00:00.000Z',
      lastUpdatedAt: '2026-04-06T08:00:00.000Z',
      lastUsedAt: null,
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I say back',
      conversationSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      priorContext: {
        lastCommunicationSummary:
          'Candace wants a follow-up about whether dinner still works tonight.',
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).not.toContain('Draft:');
    expect(
      result.draftText?.match(/whether dinner still works tonight/gi) || [],
    ).toHaveLength(1);
  });

  it('strips programmatic open-loop phrasing out of Alexa-safe draft topics', () => {
    seedCandace();

    const result = draftCommunicationReply({
      channel: 'alexa',
      groupFolder: 'main',
      text: 'what should I say back',
      conversationSummary:
        'The main thing still open with Candace is dinner plans tonight still need a clean answer.',
      priorContext: {
        personName: 'Candace',
        lastCommunicationSummary:
          'The main thing still open with Candace is dinner plans tonight still need a clean answer.',
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('circle back on dinner plans tonight');
    expect(result.draftText).not.toContain('The main thing still open with Candace');
  });

  it('normalizes lowercase person names into cleaner Alexa-safe draft speech', () => {
    upsertProfileSubject({
      id: 'subject-candace-lower',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'candace',
      displayName: 'candace',
      createdAt: '2026-04-06T08:00:00.000Z',
      updatedAt: '2026-04-06T08:00:00.000Z',
      disabledAt: null,
    });

    const result = draftCommunicationReply({
      channel: 'alexa',
      groupFolder: 'main',
      text: 'what should I say back',
      conversationSummary:
        'candace said dinner plans tonight still need a clean answer.',
      priorContext: {
        personName: 'candace',
        lastCommunicationSummary:
          'candace said dinner plans tonight still need a clean answer.',
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('Hey Candace,');
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

    expect(openLoops.summaryText).toContain('still needs attention');
    expect(openLoops.bestNextStep).toContain('Candace');
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
