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
        communicationThreadId: 'comm-1',
        communicationSubjectIds: ['subject-candace'],
        communicationLifeThreadIds: ['thread-candace'],
        lastCommunicationSummary:
          'Candace still needs a dinner answer tonight.',
        missionId: 'mission-1',
        missionSummary: 'Plan Friday dinner with Candace.',
        missionSuggestedActionsJson:
          '[{"kind":"create_reminder","label":"Set a reminder","reason":"Lock the timing","requiresConfirmation":true}]',
        missionBlockersJson: '["The timing still looks fuzzy."]',
        missionStepFocusJson:
          '{"stepId":"step-1","missionId":"mission-1","position":1,"title":"Lock the timing","detail":"Confirm when dinner should happen.","stepStatus":"pending","requiresUserJudgment":true,"suggestedActionKind":"create_reminder","linkedRefJson":null,"lastUpdatedAt":"2026-04-06T17:00:00.000Z"}',
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
      communicationThreadId: 'comm-1',
      lastCommunicationSummary: 'Candace still needs a dinner answer tonight.',
      missionId: 'mission-1',
      missionSummary: 'Plan Friday dinner with Candace.',
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

    const cancelled = cancelCompanionHandoff(record.handoffId, 'User said no.');

    expect(cancelled).toMatchObject({
      handoffId: record.handoffId,
      status: 'cancelled',
      errorText: 'User said no.',
    });
  });

  it('can deliver a text handoff to the linked BlueBubbles thread', async () => {
    const sendBlueBubblesMessage = vi.fn(async () => ({
      platformMessageId: 'bb-msg-1',
    }));

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'alexa',
        targetChannel: 'bluebubbles',
        capabilityId: 'knowledge.summarize_saved',
        voiceSummary: 'Candace still needs a dinner answer tonight.',
        payload: {
          kind: 'message',
          title: 'Dinner follow-up',
          text: 'Candace still needs a dinner answer tonight, and pickup works better after rehearsal.',
          followupSuggestions: [],
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        resolveBlueBubblesCompanionChat: () => ({ chatJid: 'bb:chat-1' }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.speech).toContain('your messages');
    expect(sendBlueBubblesMessage).toHaveBeenCalledWith(
      'bb:chat-1',
      expect.stringContaining('Candace still needs a dinner answer'),
    );

    const stored = getCompanionHandoff(result.handoffId);
    expect(stored).toMatchObject({
      status: 'delivered',
      targetChannel: 'bluebubbles',
      targetChatJid: 'bb:chat-1',
      deliveredMessageId: 'bb-msg-1',
    });
  });

  it('uses a more specific confirmation for artifact handoffs', async () => {
    const sendTelegramArtifact = vi.fn(async () => ({
      platformMessageId: 'tg-artifact-1',
    }));

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'alexa',
        voiceSummary: 'Reading nook concept.',
        payload: {
          kind: 'artifact',
          title: 'Reading nook',
          text: 'Reading nook concept.',
          caption: 'Reading nook concept.',
          artifact: {
            kind: 'image',
            filename: 'reading-nook.png',
            mimeType: 'image/png',
            bytesBase64: 'ZmFrZQ==',
          },
          followupSuggestions: [],
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(),
        sendTelegramArtifact,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.speech).toBe('Okay. I sent the image to Telegram.');
    expect(sendTelegramArtifact).toHaveBeenCalled();
  });
});
