import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBlueBubblesIngressDispatchIdempotencyKey } from './bluebubbles-ingress-dispatch.js';
import {
  _closeDatabase,
  _getActionableIngressSnapshotForTests,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  claimPendingActionableMessagesForChat,
  completeActionableIngressClaim,
  recoverAllActionableIngressClaims,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { deliverQueuedResponseWithIngressCommit } from './queued-response-delivery.js';

describe('BlueBubbles self-thread reply crash replay fence', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('keeps provider-accepted ingress terminal after a hard kill and restart', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-bb-reply-replay-'),
    );
    const databasePath = path.join(root, 'messages.sqlite3');
    const chatJid = 'bb:iMessage;-;+13125550101';
    _closeDatabase();
    _initTestDatabaseAtPath(databasePath);
    storeChatMetadata(
      chatJid,
      '2026-07-16T20:00:00.000Z',
      'Owner self-thread',
      'bluebubbles',
      false,
    );
    storeMessage({
      id: 'bb:owner-ingress-hard-kill',
      chat_jid: chatJid,
      sender: 'bb:self',
      sender_name: 'You',
      content: 'Summarize my newest messages.',
      timestamp: '2026-07-16T20:00:00.000Z',
      is_from_me: true,
      is_bot_message: false,
    });
    const claim = claimPendingActionableMessagesForChat({ chatJid });
    const ingress = claim.messages.at(-1);
    if (!claim.claimToken || !ingress?.ingress_received_at) {
      throw new Error('expected one durable owner self-thread ingress claim');
    }
    const idempotencyKey = buildBlueBubblesIngressDispatchIdempotencyKey({
      sourceChatJid: ingress.chat_jid,
      sourceMessageId: ingress.id,
      sourceReceivedAt: ingress.ingress_received_at,
      targetChatJid: chatJid,
      slot: 'queued_self_thread_reply:1',
    });
    let providerAcceptedCount = 0;

    try {
      await expect(
        deliverQueuedResponseWithIngressCommit({
          quarantineBeforeDispatch: true,
          onPrimaryDeliveryCommitted: () => {
            expect(
              completeActionableIngressClaim({
                claimToken: claim.claimToken!,
                disposition: 'delivery_unverified_pre_dispatch_quarantine',
              }),
            ).toBe(1);
          },
          send: async () => {
            expect(
              _getActionableIngressSnapshotForTests(chatJid, ingress.id),
            ).toMatchObject({
              state: 'handled',
              disposition: 'delivery_unverified_pre_dispatch_quarantine',
            });
            providerAcceptedCount += 1;
            throw new Error(
              'simulated hard kill after BlueBubbles accepted the tempGuid',
            );
          },
        }),
      ).rejects.toThrow('simulated hard kill');
      expect(providerAcceptedCount).toBe(1);

      _closeDatabase();
      _initTestDatabaseAtPath(databasePath);
      expect(recoverAllActionableIngressClaims()).toBe(0);
      const replayClaim = claimPendingActionableMessagesForChat({ chatJid });
      expect(replayClaim).toEqual({ claimToken: null, messages: [] });
      expect(
        _getActionableIngressSnapshotForTests(chatJid, ingress.id),
      ).toMatchObject({
        state: 'handled',
        disposition: 'delivery_unverified_pre_dispatch_quarantine',
      });
      expect(
        buildBlueBubblesIngressDispatchIdempotencyKey({
          sourceChatJid: ingress.chat_jid,
          sourceMessageId: ingress.id,
          sourceReceivedAt: ingress.ingress_received_at,
          targetChatJid: chatJid,
          slot: 'queued_self_thread_reply:1',
        }),
      ).toBe(idempotencyKey);
      const replayProvider = vi.fn();
      if (replayClaim.claimToken) {
        await replayProvider(idempotencyKey);
      }
      expect(replayProvider).not.toHaveBeenCalled();
      expect(providerAcceptedCount).toBe(1);
    } finally {
      _closeDatabase();
      _initTestDatabase();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
