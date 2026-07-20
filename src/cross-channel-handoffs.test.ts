import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelDeliveryRejectedBeforeDispatchError } from './channel-delivery.js';
import {
  _closeDatabase,
  getCompanionHandoff,
  _initTestDatabase,
  _initTestDatabaseAtPath,
} from './db.js';
import {
  cancelCompanionHandoff,
  deliverCompanionHandoff,
  queueCompanionHandoff,
} from './cross-channel-handoffs.js';
import { recordBlueBubblesOutboundDeliveryEvidence } from './bluebubbles-delivery-recovery.js';
import {
  setMessagingOutboundPaused,
  validateMessagingOutboundAuthorizationFence,
} from './messaging-outbound-pause.js';

describe('cross-channel handoffs', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
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

  it('preserves a partial Telegram handoff as delivery-unverified', async () => {
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
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({
          platformMessageId: 'prefix-only',
          platformMessageIds: ['prefix-only'],
          deliveryState: 'partial' as const,
          nextUnconfirmedChunkIndex: 1,
        })),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'delivery_unverified',
      platformMessageId: 'prefix-only',
      deliveryOutcome: 'partial',
      confirmedReceiptCount: 1,
      nextUnconfirmedChunkIndex: 1,
    });
    expect(result.speech).not.toContain('I sent');
    expect(result.speech).toContain('will not retry');
    const stored = getCompanionHandoff(result.handoffId);
    expect(stored).toMatchObject({
      status: 'delivery_unverified',
      deliveredMessageId: 'prefix-only',
    });
    expect(stored?.errorText).toContain('confirmed_receipts=1');
    expect(stored?.errorText).toContain('next_unconfirmed_chunk_index=1');
    expect(stored?.errorText).toContain('Automatic retry is blocked');

    const cancelled = cancelCompanionHandoff(result.handoffId, 'Cancel it.');
    expect(cancelled?.status).toBe('delivery_unverified');
  });

  it('preserves receiptless transport ambiguity without calling it failed', async () => {
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
        resolveTelegramMainChat: () => ({ chatJid: 'tg:main' }),
        sendTelegramMessage: vi.fn(async () => ({
          deliveryState: 'unknown' as const,
          nextUnconfirmedChunkIndex: 0,
        })),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'delivery_unverified',
      deliveryOutcome: 'unknown',
      confirmedReceiptCount: 0,
      nextUnconfirmedChunkIndex: 0,
    });
    expect(result.platformMessageId).toBeUndefined();
    const stored = getCompanionHandoff(result.handoffId);
    expect(stored).toMatchObject({
      status: 'delivery_unverified',
      deliveredMessageId: null,
    });
    expect(stored?.errorText).toContain('unknown');
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

  it('quarantines a Telegram-to-BlueBubbles handoff before provider acceptance and never replays after restart', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-handoff-hard-kill-'),
    );
    const databasePath = path.join(root, 'messages.sqlite3');
    _closeDatabase();
    _initTestDatabaseAtPath(databasePath);
    const ingressAuthorization = {
      sourceChatJid: 'tg:owner',
      sourceMessageId: 'tg:handoff-hard-kill',
      sourceReceivedAt: '2026-07-16T20:00:01.000Z',
      authorizationAt: '2026-07-16T20:00:00.000Z',
      pauseGeneration: 0,
    };
    const params = {
      groupFolder: 'main',
      originChannel: 'telegram' as const,
      targetChannel: 'bluebubbles' as const,
      voiceSummary: 'A fuller owner-only follow-up.',
      payload: {
        kind: 'message' as const,
        title: 'Owner follow-up',
        text: 'A fuller owner-only follow-up.',
        followupSuggestions: [],
      },
      ingressAuthorization,
    };
    let providerAcceptedCount = 0;
    const observedIdempotencyKeys: string[] = [];
    const onDispatchQuarantined = vi.fn();

    try {
      const first = await deliverCompanionHandoff(
        params,
        {
          resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
          resolveBlueBubblesCompanionChat: () => ({
            chatJid: 'bb:iMessage;-;+13125550101',
          }),
          sendTelegramMessage: vi.fn(),
          sendBlueBubblesMessage: vi.fn(async (_jid, _text, options) => {
            const beforeProvider = getCompanionHandoff(
              options?.idempotencyKey || '',
            );
            expect(beforeProvider).toMatchObject({
              status: 'delivery_unverified',
              dispatchStartedAt: expect.any(String),
            });
            observedIdempotencyKeys.push(options?.idempotencyKey || '');
            providerAcceptedCount += 1;
            throw new Error(
              'simulated hard kill immediately after provider acceptance',
            );
          }),
        },
        { onDispatchQuarantined },
      );

      expect(first).toMatchObject({
        ok: false,
        status: 'delivery_unverified',
      });
      expect(onDispatchQuarantined).toHaveBeenCalledOnce();
      expect(providerAcceptedCount).toBe(1);
      expect(observedIdempotencyKeys[0]).toBe(first.handoffId);

      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      const replaySend = vi.fn();
      const replay = await deliverCompanionHandoff(params, {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
        resolveBlueBubblesCompanionChat: () => ({
          chatJid: 'bb:iMessage;-;+13125550101',
        }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage: replaySend,
      });

      expect(replay).toMatchObject({
        handoffId: first.handoffId,
        ok: false,
        status: 'delivery_unverified',
      });
      expect(replaySend).not.toHaveBeenCalled();
      expect(providerAcceptedCount).toBe(1);
      expect(getCompanionHandoff(first.handoffId)).toMatchObject({
        sourceChatJid: ingressAuthorization.sourceChatJid,
        sourceMessageId: ingressAuthorization.sourceMessageId,
        sourceIngressReceivedAt: ingressAuthorization.sourceReceivedAt,
        outboundAuthorizationAt: ingressAuthorization.authorizationAt,
        outboundPauseGeneration: ingressAuthorization.pauseGeneration,
        providerIdempotencyKey: first.handoffId,
        status: 'delivery_unverified',
      });

      expect(
        recordBlueBubblesOutboundDeliveryEvidence({
          chatJid: 'bb:iMessage;-;+13125550101',
          message: {
            id: 'bb:provider-handoff-receipt',
            chat_jid: 'bb:iMessage;-;+13125550101',
            sender: 'Me',
            sender_name: 'You',
            content: 'Owner follow-up\n\nA fuller owner-only follow-up.',
            timestamp: '2026-07-16T20:00:03.000Z',
            is_from_me: true,
            provider_idempotency_key: first.handoffId,
          },
          groupFolders: ['main'],
          now: new Date('2026-07-16T20:00:04.000Z'),
        }),
      ).toMatchObject({ accepted: true, inspected: 1, reconciled: 1 });
      expect(getCompanionHandoff(first.handoffId)).toMatchObject({
        status: 'delivered',
        deliveredMessageId: 'bb:provider-handoff-receipt',
      });
      const reconciledReplaySend = vi.fn();
      const reconciledReplay = await deliverCompanionHandoff(params, {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
        resolveBlueBubblesCompanionChat: () => ({
          chatJid: 'bb:iMessage;-;+13125550101',
        }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage: reconciledReplaySend,
      });
      expect(reconciledReplay).toMatchObject({
        ok: true,
        handoffId: first.handoffId,
        status: 'delivered',
        platformMessageId: 'bb:provider-handoff-receipt',
      });
      expect(reconciledReplaySend).not.toHaveBeenCalled();
    } finally {
      _closeDatabase();
      _initTestDatabase();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('carries a pre-stop Telegram fence unchanged and performs zero provider dispatch after resume', async () => {
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner stop',
      now: new Date('2026-07-16T20:05:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'later owner resume',
      now: new Date('2026-07-16T20:06:00.000Z'),
    });
    let providerDispatchCount = 0;
    const sendBlueBubblesMessage = vi.fn(
      async (
        _jid: string,
        _text: string,
        options?: {
          blueBubblesAuthorizationAt?: string;
          blueBubblesPauseGeneration?: number;
        },
      ) => {
        const fence = {
          authorizationAt: options?.blueBubblesAuthorizationAt || '',
          pauseGeneration: options?.blueBubblesPauseGeneration ?? -1,
        };
        const validation = validateMessagingOutboundAuthorizationFence(fence);
        if (!validation.ok) {
          throw new ChannelDeliveryRejectedBeforeDispatchError(
            validation.reason || 'blocked before dispatch',
          );
        }
        providerDispatchCount += 1;
        return { platformMessageId: 'must-not-exist' };
      },
    );

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'telegram',
        targetChannel: 'bluebubbles',
        voiceSummary: 'Stale handoff.',
        payload: {
          kind: 'message',
          title: 'Stale handoff',
          text: 'Stale handoff.',
          followupSuggestions: [],
        },
        ingressAuthorization: {
          sourceChatJid: 'tg:owner',
          sourceMessageId: 'tg:before-stop',
          sourceReceivedAt: '2026-07-16T20:00:01.000Z',
          authorizationAt: '2026-07-16T20:00:00.000Z',
          pauseGeneration: 1,
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
        resolveBlueBubblesCompanionChat: () => ({
          chatJid: 'bb:iMessage;-;+13125550101',
        }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage,
      },
    );

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(sendBlueBubblesMessage).toHaveBeenCalledWith(
      'bb:iMessage;-;+13125550101',
      expect.any(String),
      expect.objectContaining({
        blueBubblesAuthorizationAt: '2026-07-16T20:00:00.000Z',
        blueBubblesPauseGeneration: 1,
      }),
    );
    expect(providerDispatchCount).toBe(0);

    const replaySend = vi.fn();
    const replay = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'telegram',
        targetChannel: 'bluebubbles',
        voiceSummary: 'Stale handoff.',
        payload: {
          kind: 'message',
          title: 'Stale handoff',
          text: 'Stale handoff.',
          followupSuggestions: [],
        },
        ingressAuthorization: {
          sourceChatJid: 'tg:owner',
          sourceMessageId: 'tg:before-stop',
          sourceReceivedAt: '2026-07-16T20:00:01.000Z',
          authorizationAt: '2026-07-16T20:00:00.000Z',
          pauseGeneration: 1,
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
        resolveBlueBubblesCompanionChat: () => ({
          chatJid: 'bb:iMessage;-;+13125550101',
        }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage: replaySend,
      },
    );
    expect(replay.status).toBe('failed');
    expect(replaySend).not.toHaveBeenCalled();
  });

  it('fails a Telegram-to-BlueBubbles handoff closed instead of minting processing-time authority', async () => {
    const sendBlueBubblesMessage = vi.fn();

    const result = await deliverCompanionHandoff(
      {
        groupFolder: 'main',
        originChannel: 'telegram',
        targetChannel: 'bluebubbles',
        voiceSummary: 'Unbound handoff.',
        payload: {
          kind: 'message',
          title: 'Unbound handoff',
          text: 'Unbound handoff.',
          followupSuggestions: [],
        },
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
        resolveBlueBubblesCompanionChat: () => ({
          chatJid: 'bb:iMessage;-;+13125550101',
        }),
        sendTelegramMessage: vi.fn(),
        sendBlueBubblesMessage,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      errorText: expect.stringContaining('immutable owner-ingress'),
    });
    expect(sendBlueBubblesMessage).not.toHaveBeenCalled();
  });

  it('uses one stable handoff identity across configured self-thread aliases', async () => {
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'bb:iMessage;-;+13125550101',
    );
    vi.stubEnv(
      'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
      'bb:iMessage;-;owner@sample.test',
    );
    const params = {
      groupFolder: 'main',
      originChannel: 'telegram' as const,
      targetChannel: 'bluebubbles' as const,
      voiceSummary: 'Alias-stable handoff.',
      payload: {
        kind: 'message' as const,
        title: 'Alias-stable handoff',
        text: 'Alias-stable handoff.',
        followupSuggestions: [],
      },
      ingressAuthorization: {
        sourceChatJid: 'tg:owner',
        sourceMessageId: 'tg:alias-stable',
        sourceReceivedAt: '2026-07-16T20:10:01.000Z',
        authorizationAt: '2026-07-16T20:10:00.000Z',
        pauseGeneration: 0,
      },
    };
    const first = await deliverCompanionHandoff(params, {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
      resolveBlueBubblesCompanionChat: () => ({
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
      sendTelegramMessage: vi.fn(),
      sendBlueBubblesMessage: vi.fn(async () => {
        throw new Error('provider accepted before process loss');
      }),
    });
    const aliasReplaySend = vi.fn();
    const aliasReplay = await deliverCompanionHandoff(params, {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
      resolveBlueBubblesCompanionChat: () => ({
        chatJid: 'bb:iMessage;-;owner@sample.test',
      }),
      sendTelegramMessage: vi.fn(),
      sendBlueBubblesMessage: aliasReplaySend,
    });

    expect(first.status).toBe('delivery_unverified');
    expect(aliasReplay.handoffId).toBe(first.handoffId);
    expect(aliasReplaySend).not.toHaveBeenCalled();
  });

  it('allows only one durable claimant to cross the handoff provider boundary', async () => {
    let acceptProvider!: (result: { platformMessageId: string }) => void;
    const providerGate = new Promise<{ platformMessageId: string }>(
      (resolve) => {
        acceptProvider = resolve;
      },
    );
    const sendBlueBubblesMessage = vi.fn(() => providerGate);
    const params = {
      groupFolder: 'main',
      originChannel: 'telegram' as const,
      targetChannel: 'bluebubbles' as const,
      voiceSummary: 'Claim-once handoff.',
      payload: {
        kind: 'message' as const,
        title: 'Claim-once handoff',
        text: 'Claim-once handoff.',
        followupSuggestions: [],
      },
      ingressAuthorization: {
        sourceChatJid: 'tg:owner',
        sourceMessageId: 'tg:claim-once',
        sourceReceivedAt: '2026-07-16T20:20:01.000Z',
        authorizationAt: '2026-07-16T20:20:00.000Z',
        pauseGeneration: 0,
      },
    };
    const deps = {
      resolveTelegramMainChat: () => ({ chatJid: 'tg:owner' }),
      resolveBlueBubblesCompanionChat: () => ({
        chatJid: 'bb:iMessage;-;+13125550101',
      }),
      sendTelegramMessage: vi.fn(),
      sendBlueBubblesMessage,
    };

    const first = deliverCompanionHandoff(params, deps);
    await vi.waitFor(() =>
      expect(sendBlueBubblesMessage).toHaveBeenCalledOnce(),
    );
    const concurrent = await deliverCompanionHandoff(params, deps);
    expect(concurrent.status).toBe('delivery_unverified');
    expect(sendBlueBubblesMessage).toHaveBeenCalledOnce();

    acceptProvider({ platformMessageId: 'bb:claim-once-receipt' });
    await expect(first).resolves.toMatchObject({
      ok: true,
      status: 'delivered',
      platformMessageId: 'bb:claim-once-receipt',
    });
    expect(sendBlueBubblesMessage).toHaveBeenCalledOnce();
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
