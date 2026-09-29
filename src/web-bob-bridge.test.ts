import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getMessageAction,
  updateMessageAction,
} from './db.js';
import { executeExplicitlyAuthorizedMessageAction } from './message-actions.js';
import { setMessagingOutboundPaused } from './messaging-outbound-pause.js';
import { WebBobBridge } from './web-bob-bridge.js';

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
  const open = () =>
    new WebBobBridge(config, path.join(folder, 'bridge.db'), {
      connected,
      resolveRecipient: resolve,
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
  beforeEach(() => {
    _initTestDatabase();
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-webbob-'));
    send.mockReset();
    resolve.mockReset();
    connected.mockReset();
    connected.mockReturnValue(true);
    resolve.mockResolvedValue(['+12025550102']);
    send.mockResolvedValue({
      platformMessageId: 'receipt-123',
      threadId: 'bb:iMessage;-;+12025550102',
    });
    bridge = open();
  });
  afterEach(() => {
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

  it('expired cards, pre-draft timestamps and unavailable persistence cannot dispatch', async () => {
    const input = await approval();
    await expect(
      bridge.confirm({ ...input, approvedAt: input.approvedAt - 1000 }),
    ).rejects.toThrow();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    db.prepare('UPDATE webbob_drafts SET expires = 0').run();
    db.close();
    await expect(bridge.confirm(input)).rejects.toThrow();
    bridge.close();
    await expect(bridge.confirm(input)).rejects.toThrow();
    bridge = open();
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
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(send).not.toHaveBeenCalled();
  });
});
