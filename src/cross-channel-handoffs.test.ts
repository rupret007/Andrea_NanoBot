import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getCompanionHandoff, _initTestDatabase } from './db.js';
import {
  cancelCompanionHandoff,
  deliverCompanionHandoff,
  queueCompanionHandoff,
} from './cross-channel-handoffs.js';

describe('cross-channel handoffs', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('creates and delivers a queued Alexa-to-Telegram handoff', async () => {
    const sendTelegramMessage = vi.fn(async () => ({
      platformMessageId: 'tg-msg-1',
    }));

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'alexa',
        capabilityId: 'research.compare',
        voiceSummary: 'Kindle is the safer battery pick.',
        payload: {
          kind: 'message',
          title: 'Full comparison',
          text: '*Research Summary*\n\nKindle is the safer battery pick.',
          followupSuggestions: ['Save it if useful.'],
        },
        knowledgeSourceIds: ['source-1'],
        followupSuggestions: ['Save it if useful.'],
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe('delivered');
    expect(result.speech).toContain('Telegram');
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      'tg:main',
      expect.stringContaining('*Research Summary*'),
    );

    const stored = getCompanionHandoff(result.handoffId);
    expect(stored).toMatchObject({
      status: 'delivered',
      targetChatJid: 'tg:main',
      deliveredMessageId: 'tg-msg-1',
      capabilityId: 'research.compare',
    });
  });

  it('fails honestly when no Telegram target chat is available', async () => {
    const sendTelegramMessage = vi.fn();

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'alexa',
        voiceSummary: 'Dinner follow-up details.',
        payload: {
          kind: 'message',
          title: 'Dinner follow-up',
          text: 'Candace still needs a dinner answer tonight.',
          followupSuggestions: [],
        },
      },
      {
        resolveTelegramMainChat: () => undefined,
        sendTelegramMessage,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.speech).toContain('main Telegram chat');
    expect(sendTelegramMessage).not.toHaveBeenCalled();

    const stored = getCompanionHandoff(result.handoffId);
    expect(stored?.status).toBe('failed');
    expect(stored?.errorText).toContain('No registered main Telegram chat');
  });

  it('can cancel a queued handoff before delivery', () => {
    const record = queueCompanionHandoff({
      groupFolder: 'main',
      originChannel: 'alexa',
      voiceSummary: 'Dinner follow-up details.',
      payload: {
        kind: 'message',
        title: 'Dinner follow-up',
        text: 'Candace still needs a dinner answer tonight.',
        followupSuggestions: [],
      },
    });

    const cancelled = cancelCompanionHandoff(
      record.handoffId,
      'User said no.',
    );

    expect(cancelled).toMatchObject({
      handoffId: record.handoffId,
      status: 'cancelled',
      errorText: 'User said no.',
    });
  });
});
