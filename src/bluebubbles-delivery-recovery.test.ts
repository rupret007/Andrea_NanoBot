import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import './channels/index.js';

import { executeBlueBubblesOutboundRequest } from './bluebubbles-outbound-request.js';
import { recordBlueBubblesOutboundDeliveryEvidence } from './bluebubbles-delivery-recovery.js';
import { BlueBubblesReceiptInboxConsumer } from './bluebubbles-receipt-inbox-consumer.js';
import { BlueBubblesReceiptInboxStore } from './bluebubbles-receipt-inbox-store.js';
import { ChannelDeliveryUnverifiedError } from './channel-delivery.js';
import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  getActionableMessagesSince,
  getMessageAction,
  storeChatMetadata,
  updateMessageAction,
} from './db.js';
import { applyMessageActionOperation } from './message-actions.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import {
  runtimeCapabilityRegistry,
  type RuntimeCapabilityFacts,
} from './runtime-capability-registry.js';
import type { RegisteredGroup } from './types.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

const group: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-16T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const readyFacts: RuntimeCapabilityFacts = {
  toolRegistered: true,
  toolExposed: true,
  providerHealth: 'healthy',
  writePermission: 'granted',
  confirmation: 'satisfied',
};

describe('automatic BlueBubbles outbound evidence recovery', () => {
  beforeEach(() => {
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    _initTestDatabase();
    storeChatMetadata(
      'bb:iMessage;-;+12025550123',
      '2026-07-16T12:00:00.000Z',
      'Avery Example',
      'bluebubbles',
      false,
    );
  });

  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('recovers a success that arrives after startup only when the webhook tempGuid matches, then replay stays read-only', async () => {
    const sendToTarget = vi.fn(async () => {
      throw new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds: [],
        confirmedReceiptCount: 0,
      });
    });
    const request = {
      groupFolder: 'main',
      channel: 'telegram' as const,
      chatJid: 'tg:main',
      group,
      rawText: 'Text Avery Example: Delayed provider match.',
      inboundMessageId: 'tg:delayed-after-startup',
      now: new Date('2026-07-16T12:10:00.000Z'),
      capabilityFacts: readyFacts,
      executionDeps: {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        currentTime: new Date('2026-07-16T12:10:00.000Z'),
        sendToTarget,
      },
    };
    const staged = await executeBlueBubblesOutboundRequest(request);
    if (!staged.handled || staged.state !== 'staged') {
      throw new Error('expected an approval-gated outbound action');
    }
    expect(sendToTarget).not.toHaveBeenCalled();
    updateMessageAction(staged.action.messageActionId, {
      presentationMessageId: 'tg:delayed-recovery-card',
      lastUpdatedAt: '2026-07-16T12:10:01.000Z',
    });
    const uncertain = await applyMessageActionOperation(
      staged.action.messageActionId,
      { kind: 'send' },
      request.executionDeps,
    );
    if (!uncertain.action) {
      throw new Error('expected a durable unverified action after approval');
    }
    expect(uncertain.action.sendStatus).toBe('delivery_unverified');

    const unrelated = recordBlueBubblesOutboundDeliveryEvidence({
      chatJid: 'bb:iMessage;-;+12025550123',
      message: {
        id: 'bb:unrelated-identical',
        chat_jid: 'bb:iMessage;-;+12025550123',
        sender: 'Me',
        sender_name: 'You',
        content: 'Delayed provider match.',
        timestamp: '2026-07-16T12:10:05.000Z',
        is_from_me: true,
        provider_idempotency_key: 'different-action-id',
      },
      groupFolders: ['main'],
      now: new Date('2026-07-16T12:10:06.000Z'),
    });
    expect(unrelated).toMatchObject({ accepted: true, reconciled: 0 });
    expect(getMessageAction(uncertain.action.messageActionId)?.sendStatus).toBe(
      'delivery_unverified',
    );

    const correlated = recordBlueBubblesOutboundDeliveryEvidence({
      chatJid: 'bb:iMessage;-;+12025550123',
      message: {
        id: 'bb:correlated-provider-receipt',
        chat_jid: 'bb:iMessage;-;+12025550123',
        sender: 'Me',
        sender_name: 'You',
        content: 'Delayed provider match.',
        timestamp: '2026-07-16T12:10:08.000Z',
        is_from_me: true,
        provider_idempotency_key: uncertain.action.messageActionId,
      },
      groupFolders: ['main'],
      now: new Date('2026-07-16T12:10:09.000Z'),
    });
    expect(correlated).toMatchObject({
      accepted: true,
      reconciled: 1,
      stillUnverified: 0,
    });
    expect(
      getActionableMessagesSince('bb:iMessage;-;+12025550123', '', 'Andrea'),
    ).toEqual([]);
    expect(getMessageAction(uncertain.action.messageActionId)).toMatchObject({
      sendStatus: 'sent',
      platformMessageId: 'bb:correlated-provider-receipt',
    });

    const replay = await executeBlueBubblesOutboundRequest(request);
    expect(replay).toMatchObject({ handled: true, state: 'sent' });
    expect(sendToTarget).toHaveBeenCalledTimes(1);
  });

  it('drains and ACKs delayed first-contact evidence after both stores restart, preserving the provider direct JID', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-bb-recovery-restart-'),
    );
    const mainDatabasePath = path.join(root, 'main.sqlite3');
    const receiptDatabasePath = path.join(root, 'receipt.sqlite3');
    let mainDatabaseOpen = false;
    let receiptStore: BlueBubblesReceiptInboxStore | null = null;
    let consumer: BlueBubblesReceiptInboxConsumer | null = null;
    _closeDatabase();

    try {
      _initTestDatabaseAtPath(mainDatabasePath);
      mainDatabaseOpen = true;
      const sendToTarget = vi.fn(async () => {
        throw new ChannelDeliveryUnverifiedError({
          outcome: 'unknown',
          confirmedReceiptIds: [],
          confirmedReceiptCount: 0,
        });
      });
      const request = {
        groupFolder: 'main',
        channel: 'telegram' as const,
        chatJid: 'tg:main',
        group,
        rawText: 'Text New Person: Welcome after restart.',
        inboundMessageId: 'tg:first-contact-restart',
        recipientResolution: {
          state: 'resolved' as const,
          target: {
            chatJid: 'bb:iMessage;-;+12025550199',
            displayName: 'New Person at +12025550199',
            isGroup: false,
            blueBubblesCreateChatAddress: '+12025550199',
          },
        },
        now: new Date('2026-07-16T12:30:00.000Z'),
        capabilityFacts: readyFacts,
        executionDeps: {
          groupFolder: 'main',
          channel: 'telegram' as const,
          chatJid: 'tg:main',
          currentTime: new Date('2026-07-16T12:30:00.000Z'),
          sendToTarget,
        },
      };
      const staged = await executeBlueBubblesOutboundRequest(request);
      if (!staged.handled || staged.state !== 'staged') {
        throw new Error('expected an approval-gated first-contact action');
      }
      expect(sendToTarget).not.toHaveBeenCalled();
      updateMessageAction(staged.action.messageActionId, {
        presentationMessageId: 'tg:first-contact-restart-card',
        lastUpdatedAt: '2026-07-16T12:30:01.000Z',
      });
      const uncertain = await applyMessageActionOperation(
        staged.action.messageActionId,
        { kind: 'send' },
        request.executionDeps,
      );
      if (!uncertain.action) {
        throw new Error(
          'expected a durable first-contact action after approval',
        );
      }
      expect(uncertain.action.sendStatus).toBe('delivery_unverified');

      receiptStore = new BlueBubblesReceiptInboxStore(receiptDatabasePath);
      receiptStore.persistReceipt({
        tempGuid: uncertain.action.messageActionId,
        messageGuid: 'provider-first-contact-after-restart',
        chatGuid: 'SMS;-;+12025550199',
        content: 'Welcome after restart.',
        timestamp: '2026-07-16T12:30:05.000Z',
        isFromMe: true,
      });
      receiptStore.close();
      receiptStore = null;
      _closeDatabase();
      mainDatabaseOpen = false;

      _initTestDatabaseAtPath(mainDatabasePath);
      mainDatabaseOpen = true;
      receiptStore = new BlueBubblesReceiptInboxStore(receiptDatabasePath);
      consumer = new BlueBubblesReceiptInboxConsumer({
        store: receiptStore,
        consumerId: 'restart-integration-consumer',
        acceptReceipt: (message) => ({
          accepted: recordBlueBubblesOutboundDeliveryEvidence({
            chatJid: message.chat_jid,
            message,
            groupFolders: ['main'],
            now: new Date('2026-07-16T12:30:06.000Z'),
          }).accepted,
        }),
      });
      expect(
        await consumer.drainOnce(new Date('2026-07-16T12:30:07.000Z')),
      ).toEqual({
        leased: 1,
        accepted: 1,
        acknowledged: 1,
        pendingRetry: 0,
      });
      const recovered = getMessageAction(uncertain.action.messageActionId);
      expect(recovered).toMatchObject({
        sendStatus: 'sent',
        platformMessageId: 'bb:provider-first-contact-after-restart',
      });
      expect(JSON.parse(recovered!.targetConversationJson)).toMatchObject({
        chatJid: 'bb:SMS;-;+12025550199',
        blueBubblesCreateChatAddress: null,
      });
      expect(sendToTarget).toHaveBeenCalledTimes(1);
      expect(receiptStore.listPendingReceipts()).toEqual([]);
      const replay = await executeBlueBubblesOutboundRequest(request);
      expect(replay).toMatchObject({
        handled: true,
        state: 'sent',
        action: {
          platformMessageId: 'bb:provider-first-contact-after-restart',
        },
      });
      expect(sendToTarget).toHaveBeenCalledTimes(1);

      await consumer.shutdown();
      consumer = null;
      receiptStore.close();
      receiptStore = new BlueBubblesReceiptInboxStore(receiptDatabasePath);
      expect(receiptStore.listPendingReceipts()).toEqual([]);
    } finally {
      if (consumer) await consumer.shutdown();
      receiptStore?.close();
      if (mainDatabaseOpen) _closeDatabase();
      _initTestDatabase();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
