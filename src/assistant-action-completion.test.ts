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
});
