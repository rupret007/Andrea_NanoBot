import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeAssistantActionFromAlexa } from './assistant-action-completion.js';
import {
  getAllTasks,
  listKnowledgeSourcesForGroup,
  listLifeThreadsForGroup,
  _initTestDatabase,
} from './db.js';

describe('assistant action completion', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('saves the prior Alexa answer to the knowledge library', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_to_library',
        utterance: 'save that in my library',
        conversationSummary: 'Candace still needs a dinner answer tonight.',
        priorSubjectData: {
          lastAnswerSummary: 'Candace still needs a dinner answer tonight.',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Saved');
    expect(listKnowledgeSourcesForGroup('main')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: 'generated_note',
        }),
      ]),
    );
  });

  it('tracks the prior Alexa answer under the requested thread', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'track_thread',
        utterance: 'track that under Candace thread',
        conversationSummary: 'Dinner follow-up for Candace.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Dinner follow-up for Candace.',
            completionText: 'Candace still needs a dinner answer tonight.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('Candace');
    expect(listLifeThreadsForGroup('main', ['active'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Candace',
        }),
      ]),
    );
  });

  it('delivers a richer handoff payload to Telegram', async () => {
    const sendTelegramMessage = vi.fn(async () => ({
      platformMessageId: 'tg-msg-42',
    }));

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'send_details',
        utterance: 'send me the details',
        conversationSummary: 'Kindle comparison.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'research.compare',
            voiceSummary: 'Kindle is the safer battery pick.',
            handoffPayload: {
              kind: 'message',
              title: 'Full comparison',
              text: '*Research Summary*\n\nKindle is the safer battery pick.',
              followupSuggestions: ['Save it if useful.'],
            },
            completionText: 'Kindle is the safer battery pick.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('sent the details to Telegram');
    expect(result.handoffResult?.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('*Research Summary*'),
    );
  });

  it('can send a text handoff to the linked BlueBubbles messages thread', async () => {
    const sendBlueBubblesMessage = vi.fn(async () => ({
      platformMessageId: 'bb-msg-42',
    }));

    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'send_details',
        utterance: 'send that to my messages',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'knowledge.summarize_saved',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            handoffPayload: {
              kind: 'message',
              title: 'Dinner follow-up',
              text: 'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
              followupSuggestions: [],
            },
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        resolveBlueBubblesCompanionChat: () => ({ chatJid: 'bb:chat-1' }),
        sendTelegramMessage: vi.fn(async () => ({ platformMessageId: 'tg-unused' })),
        sendBlueBubblesMessage,
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('your messages');
    expect(result.handoffResult?.ok).toBe(true);
    expect(sendBlueBubblesMessage).toHaveBeenCalledWith(
      'bb:chat-1',
      expect.stringContaining('Candace still needs a dinner answer'),
    );
  });

  it('creates a reminder when timing is explicit', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'create_reminder',
        utterance: 'turn that into a reminder tonight',
        conversationSummary: 'Band thing follow-up.',
        now: new Date('2026-04-03T14:00:00Z'),
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Do not forget the band thing.',
            completionText: 'Do not forget the band thing.',
          }),
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
      },
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('remind you');
    expect(getAllTasks().some((task) => task.prompt.includes('band thing'))).toBe(
      true,
    );
  });

  it('routes save-for-later follow-ups through the shared bridge-backed path', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_for_later',
        utterance: 'save that for later',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.bridgeSaveForLaterText).toContain(
      'pickup works better after rehearsal',
    );
  });

  it('turns keep-track-tonight follow-ups into bounded evening carryover', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'save_for_later',
        utterance: 'keep track of that for tonight',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          threadTitle: 'Candace',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
            threadTitle: 'Candace',
          }),
        },
        now: new Date('2026-04-03T14:00:00Z'),
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.replyText).toContain('evening reset');
    expect(listLifeThreadsForGroup('main', ['active'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Candace',
          followthroughMode: 'important_only',
        }),
      ]),
    );
  });

  it('prepares a draft-follow-up bridge request from prior Alexa context', async () => {
    const result = await completeAssistantActionFromAlexa(
      {
        groupFolder: 'main',
        action: 'draft_follow_up',
        utterance: 'draft that for me',
        conversationSummary: 'Candace dinner follow-up.',
        priorSubjectData: {
          threadTitle: 'Candace',
          companionContinuationJson: JSON.stringify({
            capabilityId: 'daily.loose_ends',
            voiceSummary: 'Candace still needs a dinner answer tonight.',
            completionText:
              'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
            threadTitle: 'Candace',
          }),
        },
      },
      {},
    );

    expect(result.handled).toBe(true);
    expect(result.bridgeDraftReference).toBe('Candace');
  });
});
