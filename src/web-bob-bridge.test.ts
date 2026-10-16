import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getMessageAction,
  listMessageActionsForGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateMessageAction,
} from './db.js';
import { executeExplicitlyAuthorizedMessageAction } from './message-actions.js';
import { setMessagingOutboundPaused } from './messaging-outbound-pause.js';
import { isWebBobLoopbackAddress, WebBobBridge } from './web-bob-bridge.js';

const config = {
  token: 'test-service-token-'.repeat(4),
  denyAddresses: ['+12025550199'],
  denyChatGuids: ['iMessage;-;+12025550199'],
};
const draft = () => ({
  issuer: 'web-bob',
  audience: 'andrea',
  actor: 'a'.repeat(64),
  conversationId: 'conversation-123',
  epoch: 'epoch-123',
  draftId: 'draft-123',
  revision: 1,
  draftRequestId: 'request-123',
  chatGuid: 'iMessage;-;+12025550102',
  addresses: ['+12025550102'],
  text: 'Exact owner text.\nSecond line.',
});

describe('Web Bob dedicated Andrea ingress', () => {
  let folder: string;
  let bridge: WebBobBridge;
  const send = vi.fn();
  const resolve = vi.fn();
  const connected = vi.fn();
  const readDelivery = vi.fn();
  const open = () =>
    new WebBobBridge(config, path.join(folder, 'bridge.db'), {
      connected,
      resolveRecipient: resolve,
      readDelivery,
      sendToTarget: send,
    });
  const approval = async (input = draft()) => {
    const card = await bridge.prepare(input);
    return {
      ...input,
      bridgeDraftId: card.draftId,
      confirmation: 'yes ' + card.challenge,
      confirmationRequestId: 'confirm-123',
      approvedAt: Date.now(),
    };
  };
  const seedHistory = async (state: string, expires: number, count = 10000) => {
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      db.prepare(
        `WITH RECURSIVE entries(n) AS (
          VALUES(1) UNION ALL SELECT n + 1 FROM entries WHERE n < ?
        )
        INSERT INTO webbob_drafts
        SELECT CAST(n AS TEXT), json_set(?, '$.conversationId', 'history-' || n),
          '', '', '', ?, 0, ?, '', NULL
        FROM entries`,
      ).run(count, JSON.stringify(draft()), expires, state);
    } finally {
      db.close();
    }
  };
  beforeEach(() => {
    _initTestDatabase();
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-webbob-'));
    send.mockReset();
    resolve.mockReset();
    connected.mockReset();
    readDelivery.mockReset();
    readDelivery.mockResolvedValue({
      state: 'sent',
      error: 0,
      deliveredAt: null,
    });
    connected.mockReturnValue(true);
    resolve.mockResolvedValue(['+12025550102']);
    send.mockResolvedValue({
      platformMessageId: 'receipt-123',
      threadId: 'bb:iMessage;-;+12025550102',
    });
    bridge = open();
  });
  afterEach(() => {
    vi.useRealTimers();
    bridge.close();
    _closeDatabase();
    fs.rmSync(folder, { recursive: true, force: true });
  });

  it('drafts without sending and records one exact correlated core receipt after separate confirmation', async () => {
    const input = await approval();
    expect(send).not.toHaveBeenCalled();
    const result = await bridge.confirm(input);
    expect(result).toMatchObject({ state: 'sent', messageGuid: 'receipt-123' });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].slice(0, 3)).toEqual([
      'bluebubbles',
      'bb:' + input.chatGuid,
      input.text,
    ]);
    expect(send.mock.calls[0][3]).toMatchObject({
      idempotencyKey: result.actionId,
      suppressSenderLabel: true,
    });
    expect((await bridge.confirm(input)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('refreshes accepted then failed delivery by stored identity without a second send, including restart', async () => {
    const input = await approval();
    readDelivery.mockResolvedValueOnce({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.confirm(input)).state).toBe('submitted');
    readDelivery.mockResolvedValue({
      state: 'delivery_failed',
      error: 4,
      deliveredAt: null,
    });
    expect((await bridge.status(input)).state).toBe('delivery_failed');
    expect(readDelivery.mock.calls[1][0]).toEqual({
      messageGuid: 'receipt-123',
      chatGuid: input.chatGuid,
      address: input.addresses[0],
      text: input.text,
    });
    expect(send).toHaveBeenCalledOnce();
    bridge.close();
    bridge = open();
    readDelivery.mockRejectedValue(new Error('unavailable'));
    expect(await bridge.status(input)).toMatchObject({
      state: 'delivery_failed',
      deliveryRefreshUnavailable: true,
    });
    expect((await bridge.confirm(input)).state).toBe('delivery_failed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not erase failure with stale acceptance and requires later delivery evidence for recovery', async () => {
    const input = await approval();
    readDelivery.mockResolvedValue({
      state: 'delivery_failed',
      error: 4,
      deliveredAt: null,
    });
    const failed = await bridge.confirm(input);
    readDelivery.mockResolvedValue({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.status(input)).state).toBe('delivery_failed');
    readDelivery.mockResolvedValue({
      state: 'delivered',
      error: 0,
      deliveredAt: 1,
    });
    expect((await bridge.status(input)).state).toBe('delivery_failed');
    const checkedAt = (failed.delivery as { checkedAt: number }).checkedAt;
    readDelivery.mockResolvedValue({
      state: 'delivered',
      error: 0,
      deliveredAt: checkedAt + 1,
    });
    expect((await bridge.status(input)).state).toBe('delivered');
    readDelivery.mockResolvedValue({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.status(input)).state).toBe('delivered');
    expect(send).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent status reads, rejects altered scope, and never dispatches pending drafts', async () => {
    const input = await approval();
    expect((await bridge.status(input)).state).toBe('pending');
    expect(readDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await bridge.confirm(input);
    let finish!: (evidence: {
      state: 'delivered';
      error: number;
      deliveredAt: number;
    }) => void;
    readDelivery.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = bridge.status(input);
    const second = bridge.status(input);
    finish({ state: 'delivered', error: 0, deliveredAt: Date.now() });
    expect((await first).state).toBe('delivered');
    expect(await second).toEqual(await first);
    expect(readDelivery).toHaveBeenCalledTimes(2);
    await expect(
      bridge.status({ ...input, text: 'unrelated' }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('cannot transfer cached delivery to a replacement core receipt, including a change during inspection', async () => {
    const input = await approval();
    const result = await bridge.confirm(input);
    const actionId = result.actionId as string;
    const replace = () => {
      const action = getMessageAction(actionId)!;
      const explanation = JSON.parse(action.explanationJson!);
      explanation.executionReceipt.providerReceiptId = 'other-receipt';
      updateMessageAction(actionId, {
        platformMessageId: 'other-receipt',
        explanationJson: JSON.stringify(explanation),
      });
    };
    readDelivery.mockImplementationOnce(async () => {
      replace();
      return { state: 'delivered', error: 0, deliveredAt: Date.now() };
    });
    expect(await bridge.status(input)).toMatchObject({
      deliveryRefreshUnavailable: true,
      messageGuid: 'receipt-123',
    });
    await expect(bridge.status(input)).rejects.toThrow('identity changed');
    expect(send).toHaveBeenCalledOnce();
    expect(readDelivery).toHaveBeenCalledTimes(2);
  });

  it.each([
    'actor',
    'conversationId',
    'epoch',
    'draftId',
    'draftRequestId',
    'text',
    'chatGuid',
    'revision',
    'addresses',
    'issuer',
    'audience',
  ])('rejects altered %s', async (key) => {
    const input = await approval();
    const altered = {
      ...input,
      [key]:
        key === 'revision'
          ? 2
          : key === 'addresses'
            ? ['+12025550103']
            : key === 'actor'
              ? 'b'.repeat(64)
              : 'changed-value',
    };
    await expect(bridge.confirm(altered)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('denies both first-request approval and forged challenge', async () => {
    const input = await approval();
    await expect(
      bridge.confirm({ ...input, confirmationRequestId: input.draftRequestId }),
    ).rejects.toThrow();
    await expect(
      bridge.confirm({ ...input, confirmation: 'yes wbtxt-' + '0'.repeat(32) }),
    ).rejects.toThrow();
    await expect(
      bridge.confirm({ ...input, approvedAt: Date.now() - 60000 }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels and supersedes old cards without granting new authority', async () => {
    const first = await approval();
    bridge.cancel(first);
    await expect(bridge.confirm(first)).rejects.toThrow();
    const second = await approval({ ...draft(), draftId: 'draft-456' });
    await approval({ ...draft(), draftId: 'draft-789' });
    await expect(bridge.confirm(second)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('supersedes the same draft ID with a higher revision and requires its new challenge', async () => {
    const first = await approval();
    const revised = await approval({
      ...draft(),
      revision: 2,
      draftRequestId: 'request-456',
      text: 'Revised exact owner text.',
    });
    expect(revised.bridgeDraftId).not.toBe(first.bridgeDraftId);
    expect(revised.confirmation).not.toBe(first.confirmation);
    const oldStatus = await bridge.status(first);
    const newStatus = await bridge.status(revised);
    expect(oldStatus.state).toBe('superseded');
    expect(newStatus.state).toBe('pending');
    expect(newStatus.actionId).not.toBe(oldStatus.actionId);
    await expect(bridge.confirm(first)).rejects.toMatchObject({ status: 409 });
    await expect(
      bridge.confirm({ ...revised, confirmation: first.confirmation }),
    ).rejects.toMatchObject({ status: 403 });
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(revised)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].slice(0, 3)).toEqual([
      'bluebubbles',
      'bb:' + revised.chatGuid,
      revised.text,
    ]);
    await expect(bridge.confirm(first)).rejects.toMatchObject({ status: 409 });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects duplicate, equal and lower revisions without revoking the latest pending card', async () => {
    const currentDraft = { ...draft(), revision: 3 };
    const current = await approval(currentDraft);
    await expect(bridge.prepare(currentDraft)).rejects.toMatchObject({
      status: 409,
    });
    for (const revision of [3, 2, 1]) {
      await expect(
        bridge.prepare({
          ...currentDraft,
          revision,
          draftRequestId: 'request-stale-' + revision,
          text: 'Rejected replacement text.',
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect((await bridge.status(current)).state).toBe('pending');
    }
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toHaveLength(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(current)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects a lower revision whose recipient lookup completes after a newer revision', async () => {
    let finish!: (addresses: string[]) => void;
    resolve.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const delayed = bridge.prepare({ ...draft(), revision: 2 });
    const rejected = expect(delayed).rejects.toMatchObject({ status: 409 });
    const current = await approval({ ...draft(), revision: 3 });
    finish(['+12025550102']);
    await rejected;
    expect((await bridge.status(current)).state).toBe('pending');
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toHaveLength(
      1,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('revokes confirmation when a higher revision arrives during recipient lookup', async () => {
    const first = await approval();
    let revised!: Awaited<ReturnType<typeof approval>>;
    resolve.mockImplementationOnce(async () => {
      revised = await approval({ ...draft(), revision: 2 });
      return ['+12025550102'];
    });
    await expect(bridge.confirm(first)).rejects.toMatchObject({ status: 409 });
    expect((await bridge.status(first)).state).toBe('superseded');
    expect((await bridge.status(revised)).state).toBe('pending');
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(revised)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps revision ordering and supersession separate across conversations', async () => {
    const first = await approval({ ...draft(), revision: 3 });
    const independent = await approval({
      ...draft(),
      conversationId: 'conversation-456',
    });
    const revised = await approval({ ...draft(), revision: 4 });
    expect((await bridge.status(first)).state).toBe('superseded');
    expect((await bridge.status(revised)).state).toBe('pending');
    expect((await bridge.status(independent)).state).toBe('pending');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not revive cancelled revisions through equal or lower preparations', async () => {
    const current = await approval({ ...draft(), revision: 3 });
    bridge.cancel(current);
    for (const revision of [3, 2]) {
      await expect(
        bridge.prepare({ ...draft(), revision }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect((await bridge.status(current)).state).toBe('cancelled');
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toHaveLength(
      1,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves revision replay protection for legacy persisted draft IDs after upgrade', async () => {
    const input = await approval({ ...draft(), revision: 3 });
    const legacyId = createHash('sha256')
      .update(
        JSON.stringify([
          input.actor,
          input.conversationId,
          input.epoch,
          input.draftId,
        ]),
      )
      .digest('hex');
    bridge.close();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      db.exec(`DROP INDEX webbob_drafts_revision;
        DROP INDEX webbob_drafts_pending;`);
      db.prepare('UPDATE webbob_drafts SET id = ? WHERE id = ?').run(
        legacyId,
        input.bridgeDraftId,
      );
    } finally {
      db.close();
    }
    bridge = open();
    const legacy = { ...input, bridgeDraftId: legacyId };
    expect((await bridge.status(legacy)).state).toBe('expired');
    await expect(bridge.confirm(legacy)).rejects.toMatchObject({ status: 409 });
    for (const revision of [3, 2]) {
      await expect(
        bridge.prepare({ ...draft(), revision }),
      ).rejects.toMatchObject({ status: 409 });
    }
    const revised = await approval({ ...draft(), revision: 4 });
    expect((await bridge.status(revised)).state).toBe('pending');
    expect((await bridge.status(legacy)).state).toBe('expired');
    await expect(bridge.confirm(legacy)).rejects.toMatchObject({ status: 409 });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a consumed revision receipt when a higher revision is prepared and confirmed', async () => {
    const first = await approval();
    const originalReceipt = await bridge.confirm(first);
    expect(originalReceipt).toMatchObject({
      state: 'sent',
      messageGuid: 'receipt-123',
    });
    const revised = await approval({
      ...draft(),
      revision: 2,
      draftRequestId: 'request-456',
      text: 'A separate revised owner message.',
    });
    const originalIdentity = {
      state: 'sent',
      actionId: originalReceipt.actionId,
      messageGuid: 'receipt-123',
    };
    expect(await bridge.status(first)).toMatchObject(originalIdentity);
    expect(await bridge.confirm(first)).toMatchObject(originalIdentity);
    expect((await bridge.status(revised)).state).toBe('pending');
    expect(send).toHaveBeenCalledOnce();
    send.mockResolvedValueOnce({
      platformMessageId: 'receipt-456',
      threadId: 'bb:' + revised.chatGuid,
    });
    const revisedReceipt = await bridge.confirm(revised);
    expect(revisedReceipt).toMatchObject({
      state: 'sent',
      messageGuid: 'receipt-456',
    });
    expect(revisedReceipt.actionId).not.toBe(originalReceipt.actionId);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1].slice(0, 3)).toEqual([
      'bluebubbles',
      'bb:' + revised.chatGuid,
      revised.text,
    ]);
    expect(await bridge.confirm(first)).toMatchObject(originalIdentity);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not create a core action when active pending capacity is already full', async () => {
    await seedHistory('pending', Date.now() + 60_000);
    await expect(bridge.prepare(draft())).rejects.toMatchObject({
      status: 503,
      message: 'Web Bob bridge pending draft limit reached.',
    });
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'cancelled', 'expired', 'superseded'])(
    'does not let 10,000 %s history rows exhaust pending capacity',
    async (state) => {
      await seedHistory(state, Date.now() - 60_000);
      const input = await approval();
      expect(await bridge.status(input)).toMatchObject({ state: 'pending' });
      expect(
        listMessageActionsForGroup({ groupFolder: 'webbob' }),
      ).toHaveLength(1);
      // Retaining terminal identity prevents replay even when it no longer
      // consumes pending capacity.
      await expect(
        bridge.prepare({ ...draft(), conversationId: 'history-1' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('expires elapsed pending drafts before enforcing capacity', async () => {
    const now = Date.now();
    await seedHistory('pending', now);
    await bridge.prepare(draft(), now);
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      expect(
        db
          .prepare(
            'SELECT state, count(*) AS n FROM webbob_drafts GROUP BY state',
          )
          .all(),
      ).toEqual([
        { state: 'expired', n: 10000 },
        { state: 'pending', n: 1 },
      ]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  it('allows a revision to replace its pending draft at full capacity', async () => {
    const first = await approval();
    await seedHistory('pending', Date.now() + 60_000, 9999);
    const second = await approval({ ...draft(), revision: 2 });
    expect(await bridge.status(first)).toMatchObject({ state: 'superseded' });
    expect(await bridge.status(second)).toMatchObject({ state: 'pending' });
    await expect(bridge.confirm(first)).rejects.toMatchObject({ status: 409 });
    await expect(
      bridge.prepare({ ...draft(), conversationId: 'unrelated-conversation' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await bridge.status(second)).toMatchObject({ state: 'pending' });
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toHaveLength(
      2,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('invalidates pending challenges on service restart', async () => {
    const input = await approval();
    bridge.close();
    bridge = open();
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves consumed uncertain delivery across restart and never resends', async () => {
    const input = await approval();
    send.mockRejectedValue(new Error('lost receipt'));
    expect((await bridge.confirm(input)).state).toBe('delivery_unconfirmed');
    bridge.close();
    bridge = open();
    expect((await bridge.confirm(input)).state).toBe('delivery_unconfirmed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('concurrent approvals issue only one provider call', async () => {
    const input = await approval();
    await Promise.all([bridge.confirm(input), bridge.confirm(input)]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('cancellation during membership refresh wins before durable consumption', async () => {
    const input = await approval();
    resolve.mockImplementationOnce(async () => {
      bridge.cancel(input);
      return ['+12025550102'];
    });
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('denies Instinct canonical and address aliases, groups and unknown membership', async () => {
    for (const address of ['+12025550199', '2025550199', '+1(202)555-0199']) {
      await expect(
        bridge.prepare({
          ...draft(),
          chatGuid: 'SMS;-;' + address,
          addresses: [address],
        }),
      ).rejects.toThrow();
    }
    await expect(
      bridge.prepare({ ...draft(), chatGuid: 'iMessage;+;group' }),
    ).rejects.toThrow();
    resolve.mockResolvedValueOnce(['+12025550102', '+12025550199']);
    await expect(bridge.prepare(draft())).rejects.toThrow();
    resolve.mockResolvedValueOnce([]);
    await expect(bridge.prepare(draft())).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('revalidates membership at confirmation', async () => {
    const input = await approval();
    resolve.mockResolvedValue(['+12025550103']);
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['approval', 'card'])(
    'rejects %s expiry while the membership lookup is pending',
    async (boundary) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const input = await approval();
      vi.setSystemTime(
        Date.now() + (boundary === 'card' ? 5 * 60_000 : 30_000) - 1,
      );
      if (boundary === 'card') input.approvedAt = Date.now();
      resolve.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 2);
        return ['+12025550102'];
      });
      await expect(bridge.confirm(input)).rejects.toThrow();
      expect((await bridge.status(input)).state).toBe('pending');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('rejects pause and pause-then-resume after the card', async () => {
    const input = await approval();
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:main',
      reason: 'test',
    });
    await expect(bridge.confirm(input)).rejects.toThrow();
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:main',
      reason: 'test',
    });
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('a caller-selected Web Bob JID or serialized capability cannot authorize core dispatch', async () => {
    const input = await approval();
    // Find the bound core action without exposing a challenge in diagnostics.
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    const row = db.prepare('SELECT actionId FROM webbob_drafts').get() as {
      actionId: string;
    };
    db.close();
    await executeExplicitlyAuthorizedMessageAction(row.actionId, {
      groupFolder: 'webbob',
      channel: 'bluebubbles',
      chatJid: 'webbob:' + input.conversationId,
      ownerAuthorizationAt: new Date().toISOString(),
      webBobApproval: { surface: 'web-bob' },
      sendToTarget: send,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('persists consumption before the provider callback and rejects tampered core bytes', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    const row = db.prepare('SELECT actionId FROM webbob_drafts').get() as {
      actionId: string;
    };
    updateMessageAction(row.actionId, { draftText: 'altered' });
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(db.prepare('SELECT state FROM webbob_drafts').get()).toEqual({
      state: 'consumed',
    });
    db.close();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim sent from a missing provider receipt', async () => {
    const input = await approval();
    send.mockResolvedValue({});
    expect((await bridge.confirm(input)).state).toBe('delivery_unconfirmed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('reconciles the real channel receipt shape from one exact durable outbound row without resending', async () => {
    const input = await approval();
    send.mockImplementation(async (_channel, chatJid, text, options) => {
      const timestamp = new Date().toISOString();
      storeChatMetadata(chatJid, timestamp, undefined, 'bluebubbles');
      storeMessageDirect({
        id: 'bb:actual-channel-receipt',
        chat_jid: chatJid,
        sender: 'Me',
        sender_name: 'You',
        content: text,
        timestamp,
        is_from_me: true,
        is_bot_message: false,
        provider_idempotency_key: options.idempotencyKey,
        message_ingress_origin: 'assistant_outbound',
      });
      return { platformMessageId: 'bb:actual-channel-receipt' };
    });
    expect(await bridge.confirm(input)).toMatchObject({
      state: 'sent',
      messageGuid: 'bb:actual-channel-receipt',
    });
    bridge.close();
    bridge = open();
    expect((await bridge.confirm(input)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(['recipient', 'body', 'authorship', 'receipt', 'time'])(
    'rejects a durable row with mismatched %s',
    async (mismatch) => {
      const input = await approval();
      send.mockImplementation(async (_channel, chatJid, text) => {
        const target =
          mismatch === 'recipient' ? 'bb:iMessage;-;+12025550103' : chatJid;
        const timestamp =
          mismatch === 'time'
            ? new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString()
            : new Date().toISOString();
        storeChatMetadata(target, timestamp, undefined, 'bluebubbles');
        storeMessageDirect({
          id:
            mismatch === 'receipt'
              ? 'bb:different-receipt'
              : 'bb:actual-channel-receipt',
          chat_jid: target,
          sender: 'Me',
          sender_name: 'You',
          content: mismatch === 'body' ? 'Different bytes' : text,
          timestamp,
          is_from_me: mismatch !== 'authorship',
          is_bot_message: false,
          message_ingress_origin: 'assistant_outbound',
        });
        return { platformMessageId: 'bb:actual-channel-receipt' };
      });
      expect((await bridge.confirm(input)).state).toBe('delivery_unconfirmed');
      await bridge.confirm(input);
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it('requires a receipt from the exact recipient thread and never retries a mismatch', async () => {
    const input = await approval();
    send.mockResolvedValue({
      platformMessageId: 'receipt-123',
      threadId: 'bb:iMessage;-;+12025550103',
    });
    const result = await bridge.confirm(input);
    expect(result.state).toBe('delivery_unconfirmed');
    expect(getMessageAction(result.actionId as string)?.sendStatus).toBe(
      'delivery_unverified',
    );
    await bridge.confirm(input);
    expect(send).toHaveBeenCalledOnce();
  });

  it('the provider observes already committed consent consumption', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    send.mockImplementation(async () => {
      expect(db.prepare('SELECT state FROM webbob_drafts').get()).toEqual({
        state: 'consumed',
      });
      return {
        platformMessageId: 'receipt-123',
        threadId: 'bb:iMessage;-;+12025550102',
      };
    });
    try {
      expect((await bridge.confirm(input)).state).toBe('sent');
    } finally {
      db.close();
    }
  });

  it('late cancellation cannot relabel a consumed or sent action as cancelled', async () => {
    const input = await approval();
    send.mockImplementation(async () => {
      expect(bridge.cancel(input).state).toBe('delivery_unconfirmed');
      return {
        platformMessageId: 'receipt-123',
        threadId: 'bb:iMessage;-;+12025550102',
      };
    });
    await bridge.confirm(input);
    expect(bridge.cancel(input).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('expired cards, pre-draft timestamps and unavailable persistence cannot dispatch', async () => {
    const input = await approval();
    await expect(
      bridge.confirm({ ...input, approvedAt: input.approvedAt - 1000 }),
    ).rejects.toThrow();
    await expect(
      bridge.confirm(input, Number(input.approvedAt) + 5 * 60_000 + 1),
    ).rejects.toThrow();
    bridge.close();
    await expect(bridge.confirm(input)).rejects.toThrow();
    bridge = open();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects confirmation when stored digest and scope bytes diverge', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    const original = db
      .prepare('SELECT scope, digest FROM webbob_drafts')
      .get() as { scope: string; digest: string };
    db.prepare('UPDATE webbob_drafts SET digest = ?').run('a'.repeat(64));
    await expect(bridge.confirm(input)).rejects.toThrow();
    const tampered = JSON.parse(original.scope);
    tampered.text = 'Tampered owner bytes.';
    db.prepare('UPDATE webbob_drafts SET scope = ?, digest = ?').run(
      JSON.stringify(tampered),
      original.digest,
    );
    db.close();
    await expect(bridge.confirm(input)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects non-loopback peers and forwarded proxy headers at HTTP ingress', async () => {
    expect(isWebBobLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isWebBobLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isWebBobLoopbackAddress(':ffff:127.0.0.1')).toBe(false);
    expect(isWebBobLoopbackAddress('8.8.8.8')).toBe(false);
    expect(isWebBobLoopbackAddress(undefined)).toBe(false);
    const denied = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body?: string) {
        this.body = body || '';
      },
    };
    await bridge.handleRequest(
      {
        method: 'GET',
        url: '/web-bob/v1/health',
        headers: {
          authorization: 'Bearer ' + config.token,
          host: '127.0.0.1',
        },
        socket: { remoteAddress: '8.8.8.8', localAddress: '8.8.8.8' },
      } as unknown as http.IncomingMessage,
      denied as unknown as http.ServerResponse,
    );
    expect(denied.statusCode).toBe(401);
    const forwarded = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body?: string) {
        this.body = body || '';
      },
    };
    await bridge.handleRequest(
      {
        method: 'GET',
        url: '/web-bob/v1/health',
        headers: {
          authorization: 'Bearer ' + config.token,
          host: '127.0.0.1',
          'x-forwarded-for': '8.8.8.8',
        },
        socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
      } as unknown as http.IncomingMessage,
      forwarded as unknown as http.ServerResponse,
    );
    expect(forwarded.statusCode).toBe(401);
    const badHost = {
      statusCode: 0,
      body: '',
      writeHead(status: number) {
        this.statusCode = status;
      },
      end(body?: string) {
        this.body = body || '';
      },
    };
    await bridge.handleRequest(
      {
        method: 'GET',
        url: '/web-bob/v1/health',
        headers: {
          authorization: 'Bearer ' + config.token,
          host: 'evil.invalid',
        },
        socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
      } as unknown as http.IncomingMessage,
      badHost as unknown as http.ServerResponse,
    );
    expect(badHost.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('requires dedicated credentials and denies browser-origin requests at HTTP ingress', async () => {
    const server = http.createServer((req, res) => {
      void bridge.handleRequest(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/web-bob/v1/health`;
    try {
      expect((await fetch(url)).status).toBe(401);
      expect(
        (await fetch(url, { headers: { Authorization: 'Bearer wrong' } }))
          .status,
      ).toBe(401);
      expect(
        (
          await fetch(url, {
            headers: {
              Authorization: 'Bearer ' + config.token,
              Origin: 'https://evil.invalid',
            },
          })
        ).status,
      ).toBe(401);
      expect(
        await (
          await fetch(url, {
            headers: { Authorization: 'Bearer ' + config.token },
          })
        ).json(),
      ).toMatchObject({ connected: true, instinctReadOnly: true });
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/web-bob/v1/draft`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer ' + config.token,
              'Content-Type': 'application/json',
            },
            body: 'x'.repeat(24001),
          })
        ).status,
      ).toBe(413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    'origin',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-real-ip',
    'forwarded',
  ])(
    'rejects a present but empty %s header at HTTP ingress',
    async (header) => {
      const response = {
        statusCode: 0,
        writeHead(status: number) {
          this.statusCode = status;
        },
        end: vi.fn(),
      };
      await bridge.handleRequest(
        {
          method: 'GET',
          url: '/web-bob/v1/health',
          headers: {
            authorization: 'Bearer ' + config.token,
            host: '127.0.0.1',
            [header]: '',
          },
          socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
        } as unknown as http.IncomingMessage,
        response as unknown as http.ServerResponse,
      );
      expect(response.statusCode).toBe(401);
      expect(send).not.toHaveBeenCalled();
    },
  );
});
