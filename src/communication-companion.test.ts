import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getCommunicationThread,
  getAllTasks,
  listCommunicationThreadsForGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateCommunicationThread,
  upsertLifeThread,
  upsertProfileFact,
  upsertProfileSubject,
} from './db.js';
import {
  analyzeCommunicationMessage,
  buildCommunicationOpenLoops,
  draftCommunicationReply,
  draftCommunicationReplyWithChannelFluidity,
  formatCommunicationDraftReply,
  formatCommunicationOpenLoopsReply,
  getCommunicationCarryoverSignal,
  manageCommunicationTracking,
} from './communication-companion.js';
import type { ProfileSubject } from './types.js';

const originalFetch = globalThis.fetch;

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

function seedSelf(): ProfileSubject {
  const subject: ProfileSubject = {
    id: 'subject-self',
    groupFolder: 'main',
    kind: 'self',
    canonicalName: 'self',
    displayName: 'Jeff',
    createdAt: '2026-04-06T08:00:00.000Z',
    updatedAt: '2026-04-06T08:00:00.000Z',
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function seedCommunicationStyleFact(params: {
  id: string;
  subjectId: string;
  canary: string;
  style: string;
}): void {
  upsertProfileFact({
    id: params.id,
    groupFolder: 'main',
    subjectId: params.subjectId,
    category: 'conversational_style',
    factKey: `style-${params.id}`,
    valueJson: JSON.stringify({
      note: `${params.canary} ${params.style}`,
    }),
    state: 'accepted',
    sourceChannel: 'telegram',
    sourceSummary: `${params.canary} prefers a ${params.style} response`,
    createdAt: '2026-04-06T08:00:00.000Z',
    updatedAt: '2026-04-06T08:00:00.000Z',
    decidedAt: '2026-04-06T08:00:00.000Z',
  });
}

function seedSensitiveTitleLifeThread(id: string, title: string): void {
  upsertLifeThread({
    id,
    groupFolder: 'main',
    title,
    category: 'relationship',
    status: 'active',
    scope: 'personal',
    relatedSubjectIds: [],
    contextTags: ['private'],
    summary: 'Private planning context that is not outbound message content.',
    nextAction: 'Review the private plan.',
    nextFollowupAt: null,
    sourceKind: 'explicit',
    confidenceKind: 'explicit',
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
}

describe('communication companion', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
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
      'bb:iMessage;-;+12025550101',
      '2026-04-10T00:03:20.633Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeChatMetadata(
      'bb:iMessage;-;owner@example.com',
      '2026-04-10T00:04:05.518Z',
      'Jeff',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:self-handle-source-1',
      chat_jid: 'bb:iMessage;-;+12025550101',
      sender: 'bb:+12025550101',
      sender_name: 'Jeff',
      content:
        '@Andrea Che is saying this.\n\nSo we’re pretty sure about Saturday right? I’m just making sure you’ve got a few mixed messages lol.',
      timestamp: '2026-04-10T00:03:03.567Z',
      is_from_me: true,
      is_bot_message: false,
    });
    storeMessageDirect({
      id: 'bb:self-handle-source-2',
      chat_jid: 'bb:iMessage;-;+12025550101',
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: 'Andrea: Here is the latest show summary.',
      timestamp: '2026-04-10T00:03:20.633Z',
      is_from_me: true,
      is_bot_message: true,
    });
    storeMessageDirect({
      id: 'bb:self-handle-ask-1',
      chat_jid: 'bb:iMessage;-;owner@example.com',
      sender: 'bb:owner@example.com',
      sender_name: 'Jeff',
      content: '@Andrea what should I send back?',
      timestamp: '2026-04-10T00:04:05.518Z',
      is_from_me: true,
      is_bot_message: false,
    });

    const result = draftCommunicationReply({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:iMessage;-;owner@example.com',
      text: 'what should I send back',
      now: new Date('2026-04-10T00:04:30.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).toContain('Saturday');
    expect(result.thread?.channelChatJid).toBe(
      'bb:iMessage;-;owner@example.com',
    );
  });

  it('uses quoted message text instead of the command wrapper for direct reply-help asks', () => {
    const result = draftCommunicationReply({
      channel: 'bluebubbles',
      groupFolder: 'main',
      text: 'what should I say back to "sounds good see you at 7"',
      now: new Date('2026-04-14T12:51:36.900Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('Sounds good');
    expect(result.draftText).toContain('See you at 7');
    expect(result.draftText).not.toContain('They sounds settled');
    expect(result.draftText).not.toContain('circle back');
  });

  it('uses context-first message text before trailing reply-help asks', () => {
    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: '@andrea Candace said: can you let me know if dinner still works tonight? what should I say back?',
      now: new Date('2026-04-14T12:51:36.900Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toMatch(/dinner still works tonight/i);
    expect(result.draftText).not.toContain('what should I say back');
  });

  it('does not append generic setup thread actions to direct reply drafts', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-setup-first-outcomes',
      groupFolder: 'main',
      title: 'First outcomes',
      category: 'routine',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['setup'],
      summary:
        'Help me reply to important texts, keep family logistics from slipping, and prepare for each day.',
      nextAction:
        'Use this setup to prioritize the first useful daily-agent wins.',
      nextFollowupAt: null,
      sourceKind: 'inferred',
      confidenceKind: 'medium',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      mergedIntoThreadId: null,
      createdAt: '2026-04-14T11:45:00.000Z',
      lastUpdatedAt: '2026-04-14T11:45:00.000Z',
      lastUsedAt: '2026-04-14T11:45:00.000Z',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: '@andrea Candace said: can you let me know if dinner still works tonight? what should I say back?',
      now: new Date('2026-04-14T12:51:36.900Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toMatch(/dinner still works tonight/i);
    expect(result.draftText).not.toContain('Use this setup');
    expect(result.draftText).not.toContain('daily-agent');
  });

  it('reuses the best open communication thread when Telegram main chat only has control prompts', () => {
    seedCandace();
    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-14T11:45:00.000Z'),
    });
    const generic = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Can you let me know?',
      now: new Date('2026-04-14T11:46:00.000Z'),
    });

    storeChatMetadata(
      'tg:main',
      '2026-04-14T11:50:00.000Z',
      'Andrea',
      'telegram',
      false,
    );
    storeMessageDirect({
      id: 'tg:control-ask',
      chat_jid: 'tg:main',
      sender: '100000001',
      sender_name: 'Jeff',
      content: 'what am I forgetting',
      timestamp: '2026-04-14T11:50:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'what should I say back',
      priorContext: {
        communicationThreadId: generic.thread?.id,
        lastAnswerSummary:
          "I can't check that live right now. Narrow the question a little and I'll keep the answer grounded.",
      },
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('Candace');
    expect(result.draftText).toContain('dinner still works tonight');
    expect(result.draftText).not.toContain('what am I forgetting');
  });

  it('recovers reply-help from linked life thread context when the stored thread summary is malformed', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-live',
      groupFolder: 'main',
      title: 'Candace',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['candace', 'dinner'],
      summary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      nextAction:
        'Candace wants a follow-up about whether dinner still works tonight.',
      nextFollowupAt: null,
      sourceKind: 'inferred',
      confidenceKind: 'high',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      mergedIntoThreadId: null,
      createdAt: '2026-04-14T11:45:00.000Z',
      lastUpdatedAt: '2026-04-14T11:45:00.000Z',
      lastUsedAt: '2026-04-14T11:45:00.000Z',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
    });
    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-14T11:45:00.000Z'),
    });
    expect(seeded.thread?.id).toBeTruthy();
    updateCommunicationThread(seeded.thread!.id, {
      lastInboundSummary: 'They wants an answer about .',
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'what should I say back',
      priorContext: {
        communicationThreadId: seeded.thread!.id,
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-live'],
      },
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).toContain('Candace wants a follow-up');
    expect(result.draftText).toContain('Candace');
    expect(result.draftText).toContain('dinner still works tonight');
    expect(result.draftText).not.toContain('They wants an answer about .');

    const repaired = listCommunicationThreadsForGroup({
      groupFolder: 'main',
      includeDisabled: false,
      limit: 10,
    }).find((thread) => thread.id === seeded.thread!.id);
    expect(repaired?.lastInboundSummary).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
  });

  it('treats question-mark reply-help prompts as commands instead of message bodies', () => {
    seedCandace();
    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-14T11:45:00.000Z'),
    });
    expect(seeded.thread?.id).toBeTruthy();
    updateCommunicationThread(seeded.thread!.id, {
      lastInboundSummary: 'They wants an answer about .',
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'what should I say back?',
      priorContext: {
        communicationThreadId: seeded.thread!.id,
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-live'],
      },
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).not.toContain('?');
    expect(result.summaryText).not.toContain('They wants an answer about .');
    expect(result.draftText).toContain('Candace');
    expect(result.draftText).not.toContain('They wants an answer about .');
    expect(result.draftText).not.toContain('circle back on ?');
    expect(result.draftText).not.toContain('circle back on They');
  });

  it('strips explicit reply-help framing so person-and-topic asks draft cleanly', () => {
    seedCandace();

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'What should I say back to Candace about dinner tonight?',
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('Hey Candace,');
    expect(result.draftText).toContain('dinner tonight');
    expect(result.draftText).not.toContain('circle back on to Candace');
  });

  it('repairs malformed carried-forward summaries for explicit person-and-topic follow-ups', () => {
    seedCandace();

    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-14T11:45:00.000Z'),
    });

    expect(seeded.ok).toBe(true);
    updateCommunicationThread(seeded.thread!.id, {
      lastInboundSummary: 'to Candace about dinner tonight?',
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'What should I say back to Candace about dinner tonight?',
      priorContext: {
        personName: 'Candace',
        communicationThreadId: seeded.thread!.id,
        communicationSubjectIds: ['subject-candace'],
        lastCommunicationSummary: 'to Candace about dinner tonight?',
      },
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).toBe(
      'Candace wants a follow-up about dinner tonight.',
    );
    expect(result.draftText).toContain('Hey Candace,');
    expect(result.draftText).toContain('dinner tonight');
    expect(result.draftText).not.toContain('to Candace about dinner tonight?');
    expect(result.draftText).not.toContain('circle back on to Candace');
  });

  it('repairs command-like carried-forward summaries for explicit person-and-topic follow-ups', () => {
    seedCandace();

    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-14T11:45:00.000Z'),
    });

    expect(seeded.ok).toBe(true);
    updateCommunicationThread(seeded.thread!.id, {
      lastInboundSummary: 'What do I still need to reply to?',
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      text: 'What should I say back to Candace about dinner tonight?',
      priorContext: {
        personName: 'Candace',
        communicationThreadId: seeded.thread!.id,
        communicationSubjectIds: ['subject-candace'],
        lastCommunicationSummary: 'What do I still need to reply to?',
      },
      now: new Date('2026-04-14T11:51:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).toBe(
      'Candace wants a follow-up about dinner tonight.',
    );
    expect(result.draftText).toContain('Hey Candace,');
    expect(result.draftText).toContain('dinner tonight');
    expect(result.draftText).not.toContain('What do I');
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

  it('asks to clarify before rewrite-only prompts invent a fresh communication thread', () => {
    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'make that less stiff',
      conversationSummary:
        'The first fixed point in your day is pest control is coming at 1:00 PM.',
      now: new Date('2026-04-16T18:31:00.000Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.style).toBe('warmer');
    expect(result.clarificationQuestion).toContain(
      'Show me the message you want me to rewrite first',
    );
  });

  it('uses direct rewrite style once a real communication thread is active', () => {
    seedCandace();

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'more blunt',
      priorContext: {
        personName: 'Candace',
        communicationThreadId: 'comm-candace',
        communicationSubjectIds: ['subject-candace'],
        lastCommunicationSummary:
          'Candace wants a follow-up about whether dinner still works tonight.',
      },
      now: new Date('2026-04-16T18:32:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.style).toBe('direct');
    expect(result.draftText).toContain('Candace');
  });

  it('uses the Messages model lane for BlueBubbles drafts when OpenAI is available', async () => {
    seedCandace();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            output_text:
              '{"draftText":"Hey Candace, tonight still works for me. If you want, we can keep it simple."}',
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
    ) as typeof fetch;

    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'Make it warmer: Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftMode).toBe('openai');
    expect(result.draftText).toContain('tonight still works for me');
    expect(result.fallbackNote).toBeUndefined();
  });

  it('uses profile facts only as closed style choices without exposing self or recipient facts', async () => {
    seedCandace();
    seedSelf();
    seedCommunicationStyleFact({
      id: 'self-private-style',
      subjectId: 'subject-self',
      canary: 'PRIVATE-PROFILE-CANARY-SELF',
      style: 'warm',
    });
    seedCommunicationStyleFact({
      id: 'recipient-private-style',
      subjectId: 'subject-candace',
      canary: 'PRIVATE-PROFILE-CANARY-RECIPIENT',
      style: 'direct',
    });

    const deterministic = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });
    expect(JSON.stringify(deterministic)).not.toContain(
      'PRIVATE-PROFILE-CANARY',
    );
    expect(deterministic.thread?.toneStyleHints).toEqual(
      expect.arrayContaining(['warmer', 'direct']),
    );

    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      providerBody = String(init?.body || '');
      return new Response(
        JSON.stringify({
          output_text:
            '{"draftText":"Hey Candace, dinner still works for me."}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;
    const modelDraft = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:01:00.000Z'),
    });
    expect(modelDraft.ok).toBe(true);
    expect(providerBody).not.toContain('PRIVATE-PROFILE-CANARY');
    expect(providerBody).not.toContain('prefers a');
  });

  it('keeps a newly linked sensitive life-thread title out of provider input', async () => {
    const canary = 'PRIVATE-THREAD-TITLE-CANARY-NEW';
    seedSensitiveTitleLifeThread('private-title-new', canary);
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      providerBody = String(init?.body || '');
      return new Response(
        JSON.stringify({
          output_text:
            '{"draftText":"Hey, can you confirm whether dinner still works tonight?"}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'Draft this reply: Can you confirm whether dinner still works tonight?',
      priorContext: {
        communicationLifeThreadIds: ['private-title-new'],
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.thread?.title).toBe('Communication follow-up');
    expect(providerBody).not.toContain(canary);
  });

  it('purges a legacy sensitive life-thread title before BlueBubbles provider use', async () => {
    const canary = 'PRIVATE-THREAD-TITLE-CANARY-LEGACY';
    seedSensitiveTitleLifeThread('private-title-legacy', canary);
    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'Can you confirm whether dinner still works tonight?',
      priorContext: {
        communicationLifeThreadIds: ['private-title-legacy'],
      },
      now: new Date('2026-04-06T08:30:00.000Z'),
    });
    updateCommunicationThread(seeded.thread!.id, {
      title: `${canary} conversation`,
      toneStyleHints: [`${canary} raw style`],
    });

    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      providerBody = String(init?.body || '');
      return new Response(
        JSON.stringify({
          output_text:
            '{"draftText":"Hey, can you confirm whether dinner still works tonight?"}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;
    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'Draft this reply: Can you confirm whether dinner still works tonight?',
      priorContext: {
        communicationThreadId: seeded.thread!.id,
        communicationLifeThreadIds: ['private-title-legacy'],
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(providerBody).not.toContain(canary);
    expect(getCommunicationThread(seeded.thread!.id)?.title).toBe(
      'Communication follow-up',
    );
    expect(getCommunicationThread(seeded.thread!.id)?.toneStyleHints).toEqual(
      [],
    );
  });

  it('keeps sensitive cross-topic life-thread context out of drafts and provider payloads', async () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-private-legal',
      groupFolder: 'main',
      title: 'Confidential divorce plan',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['legal', 'private'],
      summary: 'Confidential divorce plan.',
      nextAction: 'Call the lawyer before Candace sees the filing.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
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
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    let providerBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      providerBody = String(init?.body || '');
      return new Response(
        JSON.stringify({
          output_text:
            '{"draftText":"Hey Candace, can you let me know whether dinner still works tonight?"}',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }) as typeof fetch;

    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'what should I say back',
      conversationSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      priorContext: {
        personName: 'Candace',
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-private-legal'],
        lastCommunicationSummary:
          'Candace wants a follow-up about whether dinner still works tonight.',
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('dinner still works tonight');
    expect(result.draftText).not.toContain('divorce');
    expect(result.draftText).not.toContain('lawyer');
    expect(providerBody).not.toContain('Confidential divorce plan');
    expect(providerBody).not.toContain('Call the lawyer');
    expect(providerBody).not.toContain('filing');
  });

  it('does not promote sensitive life-thread text into a command-only draft topic', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-command-private',
      groupFolder: 'main',
      title: 'Confidential divorce plan',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['legal', 'private'],
      summary: 'Confidential divorce plan.',
      nextAction: 'Call the lawyer before Candace sees the filing.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
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
      priorContext: {
        personName: 'Candace',
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-command-private'],
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).not.toContain('divorce');
    expect(result.draftText).not.toContain('lawyer');
    expect(result.draftText).not.toContain('filing');
    expect(result.summaryText).not.toContain('divorce');
  });

  it('does not reuse a legacy summary linked to unsafe private planning state', () => {
    seedCandace();
    upsertLifeThread({
      id: 'thread-candace-legacy-private',
      groupFolder: 'main',
      title: 'Confidential divorce plan',
      category: 'relationship',
      status: 'active',
      scope: 'personal',
      relatedSubjectIds: ['subject-candace'],
      contextTags: ['legal', 'private'],
      summary: 'Confidential divorce plan.',
      nextAction: 'Call the secret lawyer.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
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
    const seeded = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:candace',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      priorContext: {
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-legacy-private'],
      },
      now: new Date('2026-04-06T08:30:00.000Z'),
    });
    const contaminated =
      'Candace wants a follow-up about ULTRA-PRIVATE-LEGACY-DIVORCE and the secret lawyer.';
    updateCommunicationThread(seeded.thread!.id, {
      lastInboundSummary: contaminated,
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I say back',
      priorContext: {
        personName: 'Candace',
        communicationThreadId: seeded.thread!.id,
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace-legacy-private'],
        lastCommunicationSummary: contaminated,
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).not.toContain('ULTRA-PRIVATE');
    expect(result.draftText).not.toContain('ULTRA-PRIVATE');
    expect(result.draftText).not.toContain('lawyer');
    expect(getCommunicationThread(seeded.thread!.id)?.lastInboundSummary).toBe(
      contaminated,
    );
  });

  it('never borrows another recipient communication thread as fallback', () => {
    seedCandace();
    upsertProfileSubject({
      id: 'subject-bob',
      groupFolder: 'main',
      kind: 'person',
      canonicalName: 'bob',
      displayName: 'Bob',
      createdAt: '2026-04-06T08:00:00.000Z',
      updatedAt: '2026-04-06T08:00:00.000Z',
      disabledAt: null,
    });
    const bob = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:bob',
      text: 'Bob: Can you answer me about BOB-PRIVATE-DIAGNOSIS-CANARY?',
      now: new Date('2026-04-06T08:30:00.000Z'),
    });

    const result = draftCommunicationReply({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I say back',
      priorContext: {
        personName: 'Candace',
        communicationSubjectIds: ['subject-candace'],
      },
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.summaryText).not.toContain('BOB-PRIVATE');
    expect(result.draftText).not.toContain('BOB-PRIVATE');
    expect(result.thread?.id).not.toBe(bob.thread?.id);
    expect(result.linkedSubjects.map((subject) => subject.id)).toEqual([
      'subject-candace',
    ]);
  });

  it('falls back honestly when the richer Messages draft lane is unavailable', async () => {
    seedCandace();
    vi.unstubAllEnvs();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called without config');
    }) as typeof fetch;

    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'what should I say back',
      conversationSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftMode).toBe('deterministic');
    expect(result.fallbackNote).toContain('richer Messages draft lane');
  });

  it('keeps BlueBubbles draft replies calm when the richer lane is unavailable', async () => {
    seedCandace();
    vi.unstubAllEnvs();
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not be called without config');
    }) as typeof fetch;

    const result = await draftCommunicationReplyWithChannelFluidity({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:self',
      text: 'what should I say back',
      conversationSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    const replyText = formatCommunicationDraftReply('bluebubbles', result);
    expect(replyText).toContain('Draft:');
    expect(replyText).toContain('kept this one simple here');
    expect(replyText).not.toContain('This is shaped around');
    expect(replyText).not.toContain("Here's what I'm thinking.");
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

  it('trims trailing move-it clauses out of follow-up summaries and drafts', () => {
    const analysis = analyzeCommunicationMessage({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:test',
      text: 'Summarize this message: Candace: Can you let me know if dinner still works tonight? If not, we should move it.',
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
    expect(analysis.summaryText).toContain(
      'whether dinner still works tonight',
    );
    expect(analysis.summaryText).not.toContain('if not');
    expect(draft.ok).toBe(true);
    expect(draft.draftText).toContain('whether dinner still works tonight');
    expect(draft.draftText).not.toContain('if not, we should move it');
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
      sensitivity: 'normal',
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
        communicationLifeThreadIds: ['thread-candace-dinner-proof'],
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

  it('prefers the live BlueBubbles inbound message over Andrea-style prior narration', () => {
    seedCandace();
    storeChatMetadata(
      'bb:chat-synthetic',
      '2026-04-06T10:00:00.000Z',
      'Candace',
      'bluebubbles',
      false,
    );
    storeMessageDirect({
      id: 'bb:msg-live-inbound',
      chat_jid: 'bb:chat-synthetic',
      sender: '+15551234567',
      sender_name: 'Candace',
      content: 'Can you let me know if dinner still works tonight?',
      timestamp: '2026-04-06T10:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    const result = draftCommunicationReply({
      channel: 'bluebubbles',
      groupFolder: 'main',
      chatJid: 'bb:chat-synthetic',
      text: 'what should I say back',
      priorContext: {
        lastCommunicationSummary:
          "With Candace, I'd stay with dinner plans tonight and keep the note simple.",
      },
      now: new Date('2026-04-06T10:05:00.000Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.draftText).toContain('dinner still works tonight');
    expect(result.draftText).not.toContain("With Candace, I'd");
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
    expect(result.draftText).not.toContain(
      'The main thing still open with Candace',
    );
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

    expect(openLoops.summaryText).toMatch(/still needs? attention/);
    expect(openLoops.bestNextStep).toContain('Candace');
    expect(openLoops.items[0]?.personName).toBe('Candace');
    expect(formatCommunicationOpenLoopsReply('telegram', openLoops)).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
    expect(
      formatCommunicationOpenLoopsReply('telegram', openLoops),
    ).not.toContain('Candace: Candace wants a follow-up');

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

  it('ignores malformed orphaned communication threads when summarizing open loops', () => {
    seedCandace();

    const candace = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });
    const generic = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Can you get back to me?',
      now: new Date('2026-04-06T09:01:00.000Z'),
    });

    updateCommunicationThread(candace.thread!.id, {
      lastInboundSummary:
        'Candace wants a follow-up about whether dinner still works tonight.',
    });
    updateCommunicationThread(generic.thread!.id, {
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      lastInboundSummary: 'They sounds settled on sounds good see you at 7.',
      lastOutboundSummary: 'Sounds good. See you at 7.',
    });

    const openLoops = buildCommunicationOpenLoops({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'What do I owe people?',
      now: new Date('2026-04-06T09:05:00.000Z'),
    });

    expect(openLoops.summaryText).toMatch(/still needs? attention/);
    expect(formatCommunicationOpenLoopsReply('telegram', openLoops)).toContain(
      'Candace wants a follow-up about whether dinner still works tonight.',
    );
    expect(
      formatCommunicationOpenLoopsReply('telegram', openLoops),
    ).not.toContain('They sounds settled on sounds good see you at 7.');
  });

  it('ignores command-like carried-forward summaries when summarizing open loops', () => {
    seedCandace();

    const candace = analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:test',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-06T09:00:00.000Z'),
    });

    expect(candace.ok).toBe(true);
    updateCommunicationThread(candace.thread!.id, {
      lastInboundSummary: 'What do I still need to reply to?',
      lastOutboundSummary:
        'Candace, I wanted to circle back on What do I. Let me know what works for you.',
    });

    const openLoops = buildCommunicationOpenLoops({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'What do I still need to reply to?',
      now: new Date('2026-04-06T09:05:00.000Z'),
    });

    expect(openLoops.summaryText).toMatch(/still needs attention/);
    expect(
      formatCommunicationOpenLoopsReply('telegram', openLoops),
    ).not.toContain('What do I still need to reply to?');
    expect(
      formatCommunicationOpenLoopsReply('telegram', openLoops),
    ).not.toContain('I wanted to circle back on What do I');
    expect(formatCommunicationOpenLoopsReply('telegram', openLoops)).toContain(
      'Candace',
    );
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
    expect(result.replyText).toContain(
      "I'll remind you tonight to reply to Candace about whether dinner still works tonight.",
    );
    expect(
      getAllTasks().some((task) => task.id === result.reminderTaskId),
    ).toBe(true);
    expect(
      getAllTasks().some(
        (task) =>
          task.id === result.reminderTaskId &&
          task.prompt.includes(
            'reply to Candace about whether dinner still works tonight',
          ),
      ),
    ).toBe(true);
  });
});
