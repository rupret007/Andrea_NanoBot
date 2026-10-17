import { createHash, randomBytes } from 'node:crypto';
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
import {
  createOrRefreshMessageActionFromDraft,
  executeExplicitlyAuthorizedMessageAction,
} from './message-actions.js';
import type {
  OwnerChallengeDelivery,
  OwnerChallengeSummary,
} from './owner-challenge-delivery.js';
import { setMessagingOutboundPaused } from './messaging-outbound-pause.js';
import { isWebBobLoopbackAddress, WebBobBridge } from './web-bob-bridge.js';
import {
  computeWebBobActionDigest,
  computeWebBobRequestDigest,
  parseWebBobRequestScope,
  serializeWebBobRequestScope,
} from './web-bob-request-scope.js';

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
  draftRequestId: 'request-' + randomBytes(12).toString('hex'),
  chatGuid: 'iMessage;-;+12025550102',
  addresses: ['+12025550102'],
  text: 'Exact owner text.\nSecond line.',
});
const requestDigestFor = (input = draft()) =>
  computeWebBobRequestDigest(parseWebBobRequestScope(input));

describe('Web Bob dedicated Andrea ingress', () => {
  let folder: string;
  let bridge: WebBobBridge;
  const send = vi.fn();
  const resolve = vi.fn();
  const connected = vi.fn();
  const readDelivery = vi.fn();
  const deliver =
    vi.fn<
      (challenge: string, summary: OwnerChallengeSummary) => Promise<void>
    >();
  const delivered = new Map<string, string>();
  const open = (
    ownerChallengeDelivery: OwnerChallengeDelivery | null = { deliver },
  ) =>
    new WebBobBridge(config, path.join(folder, 'bridge.db'), {
      connected,
      resolveRecipient: resolve,
      readDelivery,
      sendToTarget: send,
      ...(ownerChallengeDelivery ? { ownerChallengeDelivery } : {}),
    });
  const approval = async (input = draft()) => {
    const card = await bridge.prepare(input);
    return {
      ...input,
      bridgeDraftId: card.draftId,
      requestDigest: card.requestDigest as string,
      approvalToken: delivered.get(card.draftId as string)!,
    };
  };
  const confirmation = (input: {
    bridgeDraftId: unknown;
    approvalToken: string;
    requestDigest: string;
  }) => ({
    bridgeDraftId: input.bridgeDraftId,
    approvalToken: input.approvalToken,
    requestDigest: input.requestDigest,
  });
  const identity = (input: {
    bridgeDraftId: unknown;
    requestDigest: string;
  }) => ({
    bridgeDraftId: input.bridgeDraftId,
    requestDigest: input.requestDigest,
  });
  const withHttp = async (
    run: (
      post: (route: string, body: unknown) => Promise<Response>,
    ) => Promise<void>,
  ) => {
    const server = http.createServer((req, res) => {
      void bridge.handleRequest(req, res);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    try {
      await run((route, body) =>
        fetch(`http://127.0.0.1:${port}/web-bob/v1/${route}`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + config.token,
            'Content-Type': 'application/json',
          },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        }),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  const historyRequestBinding = (n: number) => {
    const input = {
      ...draft(),
      draftRequestId: 'history-req-' + n.toString(16).padStart(56, '0'),
    };
    const requestScope = parseWebBobRequestScope(input);
    return {
      requestScope: serializeWebBobRequestScope(requestScope),
      requestDigest: computeWebBobRequestDigest(requestScope),
      draftRequestId: requestScope.draftRequestId,
    };
  };
  const seedHistory = async (state: string, expires: number, count = 10000) => {
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      const input = draft();
      db.function(
        'historyRequestScope',
        (n: number) => historyRequestBinding(n).requestScope,
      );
      db.function(
        'historyRequestDigest',
        (n: number) => historyRequestBinding(n).requestDigest,
      );
      db.function(
        'historyDraftRequestId',
        (n: number) => historyRequestBinding(n).draftRequestId,
      );
      // History represents delivered drafts in both stores, with actual core
      // actions and outcomes rather than empty references that bypass cleanup.
      db.function('historyActionId', (id: string, conversationId: string) => {
        return createOrRefreshMessageActionFromDraft({
          groupFolder: 'webbob',
          presentationChannel: 'bluebubbles',
          presentationChatJid: 'webbob:' + conversationId,
          sourceType: 'manual_prompt',
          sourceKey: 'webbob:inbound:' + id,
          sourceSummary: 'Exact Web Bob owner draft',
          draftProvenance: 'owner_literal',
          draftText: input.text,
          forceApproval: true,
          targetChannelOverride: 'bluebubbles',
          targetOverride: {
            kind: 'external_thread',
            chatJid: 'bb:' + input.chatGuid,
            isGroup: false,
          },
        }).messageActionId;
      });
      db.prepare(
        `WITH RECURSIVE entries(n) AS (
          VALUES(1) UNION ALL SELECT n + 1 FROM entries WHERE n < ?
        )
        INSERT INTO webbob_drafts
          (id, scope, requestScope, requestDigest, draftRequestId, digest, challengeHash, serverEpoch, expires, pauseGeneration, state, actionId, confirmationRequestId)
        SELECT printf('%064x', n), json_set(?, '$.conversationId', 'history-' || n),
          historyRequestScope(n), historyRequestDigest(n), historyDraftRequestId(n),
          '', '', '', ?, 0, ?,
          historyActionId(printf('%064x', n), 'history-' || n), NULL
        FROM entries`,
      ).run(
        count,
        JSON.stringify({
          ...input,
          actor: createHash('sha256')
            .update('web-bob:owner:jeff')
            .digest('hex'),
        }),
        expires,
        state,
      );
    } finally {
      db.close();
    }
  };
  const expectSettledConsent = async (bridgeDraftId: unknown) => {
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    try {
      expect(
        db
          .prepare(
            'SELECT state, dispatchInFlight FROM webbob_drafts WHERE id = ?',
          )
          .get(bridgeDraftId),
      ).toEqual({ state: 'consumed', dispatchInFlight: 0 });
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
    delivered.clear();
    deliver.mockReset();
    deliver.mockImplementation(async (challenge, summary) => {
      delivered.set(summary.bridgeDraftId, challenge);
    });
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

  it('rejects duplicate JSON keys on ingress before schema validation', async () => {
    await withHttp(async (post) => {
      const response = await post(
        'draft',
        '{"issuer":"web-bob","issuer":"web-bob","audience":"andrea"}',
      );
      expect(response.status).toBe(400);
    });
  });

  it('gives the bearer caller only a draft reference and delivers the token exclusively out of band', async () => {
    await withHttp(async (post) => {
      const response = await post('draft', draft());
      expect(response.status).toBe(200);
      const raw = await response.text();
      const card = JSON.parse(raw);
      expect(deliver).toHaveBeenCalledOnce();
      const [token, summary] = deliver.mock.calls[0];
      expect(token).toMatch(/^wbtxt-[0-9a-f]{64}$/);
      expect(summary).toMatchObject({
        bridgeDraftId: card.draftId,
        revision: 1,
        conversationId: draft().conversationId,
        chatGuid: draft().chatGuid,
        addresses: draft().addresses,
        text: draft().text,
      });
      expect(raw).not.toContain(token);
      for (const field of ['challenge', 'approvalToken', 'confirmation']) {
        expect(card).not.toHaveProperty(field);
      }
      expect(card.requestDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(card.requestDigest).not.toBe(card.digest);
      const draftIdentity = {
        bridgeDraftId: card.draftId,
        requestDigest: card.requestDigest,
      };
      expect((await post('confirm', draftIdentity)).status).toBe(403);
      expect(
        (
          await post('confirm', {
            ...draftIdentity,
            approvalToken: 'wbtxt-' + '0'.repeat(64),
          })
        ).status,
      ).toBe(403);
      const status = await post('status', draftIdentity);
      expect(await status.text()).not.toContain(token);
      expect(send).not.toHaveBeenCalled();
      expect(
        (await post('confirm', { ...draftIdentity, approvalToken: token }))
          .status,
      ).toBe(200);
      expect(
        (await post('confirm', { ...draftIdentity, approvalToken: token }))
          .status,
      ).toBe(409);
      expect(send).toHaveBeenCalledOnce();
    });
  });

  it('rejects forged authority metadata at HTTP ingress even with the real owner token', async () => {
    const input = await approval();
    await withHttp(async (post) => {
      for (const [field, value] of Object.entries({
        actor: 'b'.repeat(64),
        approvedAt: Date.now() + 60_000,
        requestId: 'attacker-request',
        confirmationRequestId: 'attacker-confirmation',
        scope: { ...draft(), text: 'Attacker replacement.' },
      })) {
        expect(
          (await post('confirm', { ...confirmation(input), [field]: value }))
            .status,
        ).toBe(400);
      }
      expect(send).not.toHaveBeenCalled();
      expect((await bridge.status(identity(input))).state).toBe('pending');
    });
  });

  it('derives actor, request IDs, approval time and dispatch scope from trusted server state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    try {
      const pending = db
        .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
        .get(input.bridgeDraftId) as {
        scope: string;
        digest: string;
        challengeHash: string;
        approvedAt: number | null;
        confirmationRequestId: string | null;
      };
      const scope = JSON.parse(pending.scope);
      const actor = createHash('sha256')
        .update('web-bob:owner:jeff')
        .digest('hex');
      expect(scope).toMatchObject({
        ...draft(),
        actor,
        draftRequestId: expect.any(String),
      });
      expect(scope.actor).not.toBe(input.actor);
      expect(scope.draftRequestId).not.toBe(input.draftRequestId);
      expect(pending.approvedAt).toBeNull();
      expect(pending.confirmationRequestId).toBeNull();
      expect(pending.challengeHash).not.toBe(input.approvalToken);
      expect(deliver.mock.calls[0][1]).toMatchObject({
        actor,
        contentHash: pending.digest,
      });
      vi.setSystemTime(Date.now() + 60_000);
      const approvedAt = Date.now();
      await bridge.confirm(confirmation(input));
      const consumed = db
        .prepare(
          'SELECT approvedAt, confirmationRequestId, challengeHash FROM webbob_drafts WHERE id = ?',
        )
        .get(input.bridgeDraftId) as {
        approvedAt: number;
        confirmationRequestId: string;
        challengeHash: string;
      };
      expect(consumed.approvedAt).toBe(approvedAt);
      expect(consumed.confirmationRequestId).toEqual(expect.any(String));
      expect(consumed.confirmationRequestId).not.toBe(scope.draftRequestId);
      expect(consumed.confirmationRequestId).not.toBe(input.draftRequestId);
      expect(consumed.challengeHash).toBe('');
      expect(send.mock.calls[0].slice(0, 3)).toEqual([
        'bluebubbles',
        'bb:' + scope.chatGuid,
        scope.text,
      ]);
    } finally {
      db.close();
    }
  });

  it('fails closed with the default disabled owner-delivery interface', async () => {
    bridge.close();
    bridge = open(null);
    await withHttp(async (post) => {
      const response = await post('draft', draft());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('wbtxt-');
    });
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
      { readonly: true },
    );
    try {
      expect(db.prepare('SELECT * FROM webbob_drafts').all()).toEqual([]);
      expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toEqual([]);
      await expect(
        bridge.confirm({
          bridgeDraftId: '0'.repeat(64),
          approvalToken: 'wbtxt-' + '0'.repeat(64),
          requestDigest: '0'.repeat(64),
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      db.close();
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sanitizes delivery errors and revokes even a token received by a failing delivery hook', async () => {
    deliver.mockImplementationOnce(async (token, summary) => {
      delivered.set(summary.bridgeDraftId, token);
      throw new Error('Delivery secret: ' + token);
    });
    await withHttp(async (post) => {
      const posted = draft();
      const requestDigest = requestDigestFor(posted);
      const response = await post('draft', posted);
      expect(response.status).toBe(503);
      const body = await response.text();
      const [token, summary] = deliver.mock.calls[0];
      expect(body).not.toContain(token);
      expect(body).not.toContain('Delivery secret');
      expect(
        (
          await post('confirm', {
            bridgeDraftId: summary.bridgeDraftId,
            approvalToken: token,
            requestDigest,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await bridge.status({
            bridgeDraftId: summary.bridgeDraftId,
            requestDigest,
          })
        ).state,
      ).toBe('approval_unavailable');
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'supersede', 'expire', 'restart', 'pause'])(
    'does not revive owner delivery invalidated by %s while awaiting the hook',
    async (reason) => {
      let finish!: () => void;
      deliver.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      const posted = draft();
      const preparing = bridge.prepare(posted);
      const rejected = expect(preparing).rejects.toThrow();
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      const [token, summary] = deliver.mock.calls[0];
      const draftIdentity = {
        bridgeDraftId: summary.bridgeDraftId,
        requestDigest: requestDigestFor(posted),
      };
      expect((await bridge.status(draftIdentity)).state).toBe(
        'awaiting_delivery',
      );
      await expect(
        bridge.confirm({ ...draftIdentity, approvalToken: token }),
      ).rejects.toMatchObject({ status: 409 });
      if (reason === 'cancel') bridge.cancel(draftIdentity);
      if (reason === 'pause')
        setMessagingOutboundPaused({
          paused: true,
          changedByChatJid: 'tg:main',
          reason: 'test',
        });
      if (reason === 'supersede')
        await approval({
          ...posted,
          revision: 2,
          draftRequestId: 'request-supersede-' + randomBytes(8).toString('hex'),
          text: 'Superseding exact owner text.',
        });
      if (reason === 'expire') {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      }
      if (reason === 'restart') {
        bridge.close();
        bridge = open();
      }
      finish();
      await rejected;
      await expect(
        bridge.confirm({ ...draftIdentity, approvalToken: token }),
      ).rejects.toMatchObject({ status: reason === 'restart' ? 404 : 409 });
      if (reason === 'restart') {
        // Undelivered drafts never persist, so restart forgets the reference.
        await expect(bridge.status(draftIdentity)).rejects.toMatchObject({
          status: 404,
        });
      } else {
        expect((await bridge.status(draftIdentity)).state).not.toBe('pending');
      }
      expect(
        listMessageActionsForGroup({ groupFolder: 'webbob' }),
      ).toHaveLength(reason === 'supersede' ? 1 : 0);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('drafts without sending and records one exact correlated core receipt after separate confirmation', async () => {
    const input = await approval();
    expect(send).not.toHaveBeenCalled();
    const result = await bridge.confirm(confirmation(input));
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
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 409,
    });
    expect((await bridge.status(identity(input))).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('refreshes accepted then failed delivery by stored identity without a second send, including restart', async () => {
    const input = await approval();
    readDelivery.mockResolvedValueOnce({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.confirm(confirmation(input))).state).toBe('submitted');
    readDelivery.mockResolvedValue({
      state: 'delivery_failed',
      error: 4,
      deliveredAt: null,
    });
    expect((await bridge.status(identity(input))).state).toBe(
      'delivery_failed',
    );
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
    expect(await bridge.status(identity(input))).toMatchObject({
      state: 'delivery_failed',
      deliveryRefreshUnavailable: true,
    });
    await expectSettledConsent(input.bridgeDraftId);
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 409,
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not erase failure with stale acceptance and requires later delivery evidence for recovery', async () => {
    const input = await approval();
    readDelivery.mockResolvedValue({
      state: 'delivery_failed',
      error: 4,
      deliveredAt: null,
    });
    const failed = await bridge.confirm(confirmation(input));
    readDelivery.mockResolvedValue({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.status(identity(input))).state).toBe(
      'delivery_failed',
    );
    readDelivery.mockResolvedValue({
      state: 'delivered',
      error: 0,
      deliveredAt: 1,
    });
    expect((await bridge.status(identity(input))).state).toBe(
      'delivery_failed',
    );
    const checkedAt = (failed.delivery as { checkedAt: number }).checkedAt;
    readDelivery.mockResolvedValue({
      state: 'delivered',
      error: 0,
      deliveredAt: checkedAt + 1,
    });
    expect((await bridge.status(identity(input))).state).toBe('delivered');
    readDelivery.mockResolvedValue({
      state: 'submitted',
      error: 0,
      deliveredAt: null,
    });
    expect((await bridge.status(identity(input))).state).toBe('delivered');
    expect(send).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent status reads, rejects altered scope, and never dispatches pending drafts', async () => {
    const input = await approval();
    expect((await bridge.status(identity(input))).state).toBe('pending');
    expect(readDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    await bridge.confirm(confirmation(input));
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
    const first = bridge.status(identity(input));
    const second = bridge.status(identity(input));
    finish({ state: 'delivered', error: 0, deliveredAt: Date.now() });
    expect((await first).state).toBe('delivered');
    expect(await second).toEqual(await first);
    expect(readDelivery).toHaveBeenCalledTimes(2);
    await expect(
      bridge.status({ ...identity(input), text: 'unrelated' }),
    ).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

  it('cannot transfer cached delivery to a replacement core receipt, including a change during inspection', async () => {
    const input = await approval();
    const result = await bridge.confirm(confirmation(input));
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
    expect(await bridge.status(identity(input))).toMatchObject({
      deliveryRefreshUnavailable: true,
      messageGuid: 'receipt-123',
    });
    await expect(bridge.status(identity(input))).rejects.toThrow(
      'identity changed',
    );
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
    'approvedAt',
    'confirmationRequestId',
    'requestId',
    'scope',
    'confirmation',
  ])('rejects altered %s', async (key) => {
    const input = await approval();
    const altered = {
      ...confirmation(input),
      [key]:
        key === 'revision'
          ? 2
          : key === 'addresses'
            ? ['+12025550103']
            : key === 'actor'
              ? 'b'.repeat(64)
              : 'changed-value',
    };
    await expect(bridge.confirm(altered)).rejects.toMatchObject({
      status: 400,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects confirmation when requestDigest does not match the stored original request', async () => {
    const input = await approval();
    await expect(
      bridge.confirm({
        ...confirmation(input),
        requestDigest: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not authorize dispatch when the approval token matches a different requestDigest', async () => {
    const first = await approval();
    const second = await approval({ ...draft(), draftId: 'draft-456' });
    await expect(
      bridge.confirm({
        bridgeDraftId: first.bridgeDraftId,
        approvalToken: first.approvalToken,
        requestDigest: second.requestDigest,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects legacy persisted drafts that lack requestDigest evidence', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      db.prepare(
        'UPDATE webbob_drafts SET requestDigest = ?, requestScope = ? WHERE id = ?',
      ).run('', '', input.bridgeDraftId);
    } finally {
      db.close();
    }
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 403,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('requires the separately delivered owner token and rejects legacy first-request approval', async () => {
    const input = await approval();
    await expect(
      bridge.confirm({
        ...confirmation(input),
        confirmationRequestId: input.draftRequestId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      bridge.confirm({
        bridgeDraftId: input.bridgeDraftId,
        requestDigest: input.requestDigest,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bridge.confirm({
        ...confirmation(input),
        approvalToken: 'wbtxt-' + '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      bridge.confirm({
        ...confirmation(input),
        approvedAt: Date.now() - 60000,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it('cancels and supersedes old cards without granting new authority', async () => {
    const first = await approval();
    bridge.cancel(identity(first));
    await expect(bridge.confirm(confirmation(first))).rejects.toThrow();
    const second = await approval({ ...draft(), draftId: 'draft-456' });
    await approval({ ...draft(), draftId: 'draft-789' });
    await expect(bridge.confirm(confirmation(second))).rejects.toThrow();
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
    expect(revised.approvalToken).not.toBe(first.approvalToken);
    const oldStatus = await bridge.status(identity(first));
    const newStatus = await bridge.status(identity(revised));
    expect(oldStatus.state).toBe('superseded');
    expect(newStatus.state).toBe('pending');
    expect(newStatus.actionId).not.toBe(oldStatus.actionId);
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      bridge.confirm({
        ...confirmation(revised),
        approvalToken: first.approvalToken,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(confirmation(revised))).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].slice(0, 3)).toEqual([
      'bluebubbles',
      'bb:' + revised.chatGuid,
      revised.text,
    ]);
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
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
      expect((await bridge.status(identity(current))).state).toBe('pending');
    }
    expect(listMessageActionsForGroup({ groupFolder: 'webbob' })).toHaveLength(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(confirmation(current))).state).toBe('sent');
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
    expect((await bridge.status(identity(current))).state).toBe('pending');
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
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
    expect((await bridge.status(identity(first))).state).toBe('superseded');
    expect((await bridge.status(identity(revised))).state).toBe('pending');
    expect(send).not.toHaveBeenCalled();
    expect((await bridge.confirm(confirmation(revised))).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps revision ordering and supersession separate across conversations', async () => {
    const first = await approval({ ...draft(), revision: 3 });
    const independent = await approval({
      ...draft(),
      conversationId: 'conversation-456',
    });
    const revised = await approval({ ...draft(), revision: 4 });
    expect((await bridge.status(identity(first))).state).toBe('superseded');
    expect((await bridge.status(identity(revised))).state).toBe('pending');
    expect((await bridge.status(identity(independent))).state).toBe('pending');
    expect(send).not.toHaveBeenCalled();
  });

  it('does not revive cancelled revisions through equal or lower preparations', async () => {
    const current = await approval({ ...draft(), revision: 3 });
    bridge.cancel(identity(current));
    for (const revision of [3, 2]) {
      await expect(
        bridge.prepare({ ...draft(), revision }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect((await bridge.status(identity(current))).state).toBe('cancelled');
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
    expect((await bridge.status(identity(legacy))).state).toBe('expired');
    await expect(bridge.confirm(confirmation(legacy))).rejects.toMatchObject({
      status: 409,
    });
    for (const revision of [3, 2]) {
      await expect(
        bridge.prepare({ ...draft(), revision }),
      ).rejects.toMatchObject({ status: 409 });
    }
    const revised = await approval({ ...draft(), revision: 4 });
    expect((await bridge.status(identity(revised))).state).toBe('pending');
    expect((await bridge.status(identity(legacy))).state).toBe('expired');
    await expect(bridge.confirm(confirmation(legacy))).rejects.toMatchObject({
      status: 409,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a consumed revision receipt when a higher revision is prepared and confirmed', async () => {
    const first = await approval();
    const originalReceipt = await bridge.confirm(confirmation(first));
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
    expect(await bridge.status(identity(first))).toMatchObject(
      originalIdentity,
    );
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
    expect((await bridge.status(identity(revised))).state).toBe('pending');
    expect(send).toHaveBeenCalledOnce();
    send.mockResolvedValueOnce({
      platformMessageId: 'receipt-456',
      threadId: 'bb:' + revised.chatGuid,
    });
    const revisedReceipt = await bridge.confirm(confirmation(revised));
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
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
    expect(await bridge.status(identity(first))).toMatchObject(
      originalIdentity,
    );
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not create a core action when active pending capacity is already full', async () => {
    await seedHistory('pending', Date.now() + 60_000);
    const existingActionIds = listMessageActionsForGroup({
      groupFolder: 'webbob',
      includeSent: true,
      limit: 10002,
    }).map((action) => action.messageActionId);
    expect(existingActionIds).toHaveLength(10000);
    await expect(bridge.prepare(draft())).rejects.toMatchObject({
      status: 503,
      message: 'Web Bob bridge pending draft limit reached.',
    });
    expect(
      listMessageActionsForGroup({
        groupFolder: 'webbob',
        includeSent: true,
        limit: 10002,
      }).map((action) => action.messageActionId),
    ).toEqual(existingActionIds);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['consumed', 'cancelled', 'expired', 'superseded'])(
    'does not let 10,000 %s history rows exhaust pending capacity',
    async (state) => {
      await seedHistory(state, Date.now() - 60_000);
      const input = await approval();
      expect(await bridge.status(identity(input))).toMatchObject({
        state: 'pending',
      });
      expect(
        listMessageActionsForGroup({
          groupFolder: 'webbob',
          includeSent: true,
          limit: 10002,
        }),
      ).toHaveLength(10001);
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
    expect(await bridge.status(identity(first))).toMatchObject({
      state: 'superseded',
    });
    expect(await bridge.status(identity(second))).toMatchObject({
      state: 'pending',
    });
    await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      bridge.prepare({ ...draft(), conversationId: 'unrelated-conversation' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await bridge.status(identity(second))).toMatchObject({
      state: 'pending',
    });
    expect(
      listMessageActionsForGroup({
        groupFolder: 'webbob',
        includeSent: true,
        limit: 10002,
      }),
    ).toHaveLength(10001);
    expect(send).not.toHaveBeenCalled();
  });

  it('invalidates pending challenges on service restart', async () => {
    const input = await approval();
    bridge.close();
    bridge = open();
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves consumed uncertain delivery across restart and never resends', async () => {
    const input = await approval();
    send.mockRejectedValue(new Error('lost receipt'));
    expect((await bridge.confirm(confirmation(input))).state).toBe(
      'delivery_unconfirmed',
    );
    await expectSettledConsent(input.bridgeDraftId);
    bridge.close();
    bridge = open();
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 409,
    });
    expect((await bridge.status(identity(input))).state).toBe(
      'delivery_unconfirmed',
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('rejects concurrent approval replay and issues only one provider call', async () => {
    const input = await approval();
    const results = await Promise.allSettled([
      bridge.confirm(confirmation(input)),
      bridge.confirm(confirmation(input)),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ status: 409 }),
      }),
    ]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('cancellation during membership refresh wins before durable consumption', async () => {
    const input = await approval();
    resolve.mockImplementationOnce(async () => {
      bridge.cancel(identity(input));
      return ['+12025550102'];
    });
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
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
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['approval', 'card'])(
    'rejects %s expiry while the membership lookup is pending',
    async (boundary) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const input = await approval();
      if (boundary === 'card') vi.setSystemTime(Date.now() + 5 * 60_000 - 1);
      resolve.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + (boundary === 'card' ? 2 : 30_001));
        return ['+12025550102'];
      });
      await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
      expect((await bridge.status(identity(input))).state).toBe('pending');
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
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:main',
      reason: 'test',
    });
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
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
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    expect(
      db.prepare('SELECT state, dispatchInFlight FROM webbob_drafts').get(),
    ).toEqual({
      state: 'consumed',
      dispatchInFlight: 0,
    });
    db.close();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not claim sent from a missing provider receipt', async () => {
    const input = await approval();
    send.mockResolvedValue({});
    expect((await bridge.confirm(confirmation(input))).state).toBe(
      'delivery_unconfirmed',
    );
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
    expect(await bridge.confirm(confirmation(input))).toMatchObject({
      state: 'sent',
      messageGuid: 'bb:actual-channel-receipt',
    });
    bridge.close();
    bridge = open();
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 409,
    });
    expect((await bridge.status(identity(input))).state).toBe('sent');
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
      expect((await bridge.confirm(confirmation(input))).state).toBe(
        'delivery_unconfirmed',
      );
      await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
        status: 409,
      });
      expect(send).toHaveBeenCalledOnce();
    },
  );

  it('requires a receipt from the exact recipient thread and never retries a mismatch', async () => {
    const input = await approval();
    send.mockResolvedValue({
      platformMessageId: 'receipt-123',
      threadId: 'bb:iMessage;-;+12025550103',
    });
    const result = await bridge.confirm(confirmation(input));
    expect(result.state).toBe('delivery_unconfirmed');
    expect(getMessageAction(result.actionId as string)?.sendStatus).toBe(
      'delivery_unverified',
    );
    await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
      status: 409,
    });
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
      expect((await bridge.confirm(confirmation(input))).state).toBe('sent');
    } finally {
      db.close();
    }
  });

  it('late cancellation cannot relabel a consumed or sent action as cancelled', async () => {
    const input = await approval();
    send.mockImplementation(async () => {
      expect(bridge.cancel(identity(input)).state).toBe('delivery_unconfirmed');
      return {
        platformMessageId: 'receipt-123',
        threadId: 'bb:iMessage;-;+12025550102',
      };
    });
    await bridge.confirm(confirmation(input));
    expect(bridge.cancel(identity(input)).state).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });

  it('expired cards, pre-draft timestamps and unavailable persistence cannot dispatch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const input = await approval();
    await expect(
      bridge.confirm({ ...confirmation(input), approvedAt: Date.now() - 1000 }),
    ).rejects.toMatchObject({ status: 400 });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    bridge.close();
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
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
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    const tampered = JSON.parse(original.scope);
    tampered.text = 'Tampered owner bytes.';
    db.prepare('UPDATE webbob_drafts SET scope = ?, digest = ?').run(
      JSON.stringify(tampered),
      original.digest,
    );
    db.close();
    await expect(bridge.confirm(confirmation(input))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('pins the owner token to the content hash independently of scope equality', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      const original = db
        .prepare('SELECT scope, digest FROM webbob_drafts WHERE id = ?')
        .get(input.bridgeDraftId) as { scope: string; digest: string };
      const changed = JSON.parse(original.scope);
      // The normalized actor may differ from the caller's actor. Changing only
      // it keeps the cross-scope equality checks valid but changes the hash.
      changed.actor = 'b'.repeat(64);
      const digest = computeWebBobActionDigest(changed);
      expect(digest).not.toBe(original.digest);
      db.prepare(
        'UPDATE webbob_drafts SET scope = ?, digest = ? WHERE id = ?',
      ).run(serializeWebBobRequestScope(changed), digest, input.bridgeDraftId);
      expect((await bridge.status(identity(input))).state).toBe('pending');
      resolve.mockClear();
      await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
        status: 403,
        message: 'Invalid Web Bob request.',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      db.prepare(
        'UPDATE webbob_drafts SET scope = ?, digest = ? WHERE id = ?',
      ).run(original.scope, original.digest, input.bridgeDraftId);
      await bridge.confirm(confirmation(input));
      expect(send).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('pins the owner token to requestDigest independently of the content hash', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      const original = db
        .prepare(
          'SELECT requestScope, requestDigest FROM webbob_drafts WHERE id = ?',
        )
        .get(input.bridgeDraftId) as {
        requestScope: string;
        requestDigest: string;
      };
      const changed = JSON.parse(original.requestScope);
      // Caller actor bytes belong to requestDigest but are normalized away
      // from the action, so its content hash and equality checks still pass.
      changed.actor = 'b'.repeat(64);
      const requestDigest = computeWebBobRequestDigest(changed);
      expect(requestDigest).not.toBe(original.requestDigest);
      db.prepare(
        'UPDATE webbob_drafts SET requestScope = ?, requestDigest = ? WHERE id = ?',
      ).run(
        serializeWebBobRequestScope(changed),
        requestDigest,
        input.bridgeDraftId,
      );
      const changedInput = { ...input, requestDigest };
      expect((await bridge.status(identity(changedInput))).state).toBe(
        'pending',
      );
      resolve.mockClear();
      await expect(
        bridge.confirm(confirmation(changedInput)),
      ).rejects.toMatchObject({
        status: 403,
        message: 'Invalid Web Bob request.',
      });
      expect(resolve).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      db.prepare(
        'UPDATE webbob_drafts SET requestScope = ?, requestDigest = ? WHERE id = ?',
      ).run(original.requestScope, original.requestDigest, input.bridgeDraftId);
      await bridge.confirm(confirmation(input));
      expect(send).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it('pins action and request scope equality even when both hashes are valid', async () => {
    const input = await approval();
    const db = new (await import('better-sqlite3')).default(
      path.join(folder, 'bridge.db'),
    );
    try {
      const original = db
        .prepare('SELECT scope, digest FROM webbob_drafts WHERE id = ?')
        .get(input.bridgeDraftId) as { scope: string; digest: string };
      const changed = JSON.parse(original.scope);
      changed.text = 'Different action text with a valid recomputed hash.';
      db.prepare(
        'UPDATE webbob_drafts SET scope = ?, digest = ? WHERE id = ?',
      ).run(
        serializeWebBobRequestScope(changed),
        computeWebBobActionDigest(changed),
        input.bridgeDraftId,
      );
      // Status and cancellation never check an owner token: only scope equality
      // can reject these independently valid hashes for different messages.
      await expect(bridge.status(identity(input))).rejects.toMatchObject({
        status: 403,
        message: 'This operation does not match the stored draft.',
      });
      expect(() => bridge.cancel(identity(input))).toThrowError(
        'This operation does not match the stored draft.',
      );
      expect(send).not.toHaveBeenCalled();
      db.prepare(
        'UPDATE webbob_drafts SET scope = ?, digest = ? WHERE id = ?',
      ).run(original.scope, original.digest, input.bridgeDraftId);
      expect((await bridge.status(identity(input))).state).toBe('pending');
      await bridge.confirm(confirmation(input));
      expect(send).toHaveBeenCalledOnce();
    } finally {
      db.close();
    }
  });

  it.each([
    'draft id',
    'revision',
    'content hash',
    'action recipient',
    'request body',
  ])(
    'binds the owner token to the stored %s even when the scope digest is recomputed',
    async (changed) => {
      const input = await approval();
      const db = new (await import('better-sqlite3')).default(
        path.join(folder, 'bridge.db'),
      );
      let bridgeDraftId = input.bridgeDraftId;
      try {
        const row = db
          .prepare('SELECT scope, requestScope FROM webbob_drafts WHERE id = ?')
          .get(bridgeDraftId) as { scope: string; requestScope: string };
        const scope = JSON.parse(row.scope);
        if (changed === 'draft id') bridgeDraftId = 'f'.repeat(64);
        if (changed === 'revision') scope.revision += 1;
        if (changed === 'content hash')
          scope.text = 'Changed exact message bytes.';
        if (changed === 'action recipient') {
          scope.addresses = ['+12025550103'];
          scope.chatGuid = 'iMessage;-;+12025550103';
        }
        if (changed === 'request body') {
          const requestScope = JSON.parse(row.requestScope) as Record<
            string,
            unknown
          >;
          requestScope.text = 'Changed exact message bytes.';
          db.prepare(
            'UPDATE webbob_drafts SET requestScope = ? WHERE id = ?',
          ).run(JSON.stringify(requestScope), input.bridgeDraftId);
        } else {
          const serialized = serializeWebBobRequestScope(scope);
          db.prepare(
            'UPDATE webbob_drafts SET id = ?, scope = ?, digest = ? WHERE id = ?',
          ).run(
            bridgeDraftId,
            serialized,
            computeWebBobActionDigest(scope),
            input.bridgeDraftId,
          );
        }
      } finally {
        db.close();
      }
      await expect(
        bridge.confirm({
          bridgeDraftId,
          approvalToken: input.approvalToken,
          requestDigest: input.requestDigest,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(send).not.toHaveBeenCalled();
    },
  );

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

  describe('protocol-2 requestDigest binding', () => {
    const goldenDraft = () => ({
      issuer: 'web-bob',
      audience: 'andrea',
      actor: 'a'.repeat(64),
      conversationId: 'conversation-123',
      epoch: 'epoch-123',
      draftId: 'draft-123',
      revision: 7,
      draftRequestId: 'request-123',
      chatGuid: 'iMessage;-;+12025550102',
      addresses: ['+12025550102'],
      text: '  Café 🎸 "quoted" \\ back\ttab\nline\u0001ctl\u2028sep  ',
    });

    it('returns the golden requestDigest from prepare()', async () => {
      const card = await bridge.prepare(goldenDraft());
      expect(card.requestDigest).toBe(
        '8e6a5e561b5fe14760b7127f1e6e16c380994e4d4692d1ef65377e030df4617e',
      );
      expect(card.requestDigest).not.toBe(card.digest);
    });

    it('refuses tampered request bodies and stored requestScope before dispatch', async () => {
      const input = await approval();
      const tamperedTextDigest = computeWebBobRequestDigest(
        parseWebBobRequestScope({ ...draft(), text: draft().text + '!' }),
      );
      await expect(
        bridge.confirm({
          ...confirmation(input),
          requestDigest: tamperedTextDigest,
        }),
      ).rejects.toMatchObject({
        status: 403,
      });
      const tamperedAddressDigest = computeWebBobRequestDigest(
        parseWebBobRequestScope({
          ...draft(),
          addresses: ['+12025550103'],
          chatGuid: 'iMessage;-;+12025550103',
        }),
      );
      await expect(
        bridge.status({
          bridgeDraftId: input.bridgeDraftId,
          requestDigest: tamperedAddressDigest,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(() =>
        bridge.cancel({
          bridgeDraftId: input.bridgeDraftId,
          requestDigest: tamperedTextDigest,
        }),
      ).toThrowError('This operation does not match the stored draft.');
      await expect(
        bridge.status({
          bridgeDraftId: input.bridgeDraftId,
          requestDigest: tamperedTextDigest,
        }),
      ).rejects.toMatchObject({ status: 403 });
      const db = new (await import('better-sqlite3')).default(
        path.join(folder, 'bridge.db'),
      );
      let originalRequestScope = '';
      try {
        const row = db
          .prepare('SELECT requestScope FROM webbob_drafts WHERE id = ?')
          .get(input.bridgeDraftId) as { requestScope: string };
        originalRequestScope = row.requestScope;
        const requestScope = JSON.parse(row.requestScope) as Record<
          string,
          unknown
        >;
        requestScope.text = 'Tampered immutable request bytes.';
        db.prepare(
          'UPDATE webbob_drafts SET requestScope = ? WHERE id = ?',
        ).run(JSON.stringify(requestScope), input.bridgeDraftId);
      } finally {
        db.close();
      }
      await expect(bridge.confirm(confirmation(input))).rejects.toMatchObject({
        status: 403,
      });
      expect(send).not.toHaveBeenCalled();
      const dbRestore = new (await import('better-sqlite3')).default(
        path.join(folder, 'bridge.db'),
      );
      try {
        dbRestore
          .prepare('UPDATE webbob_drafts SET requestScope = ? WHERE id = ?')
          .run(originalRequestScope, input.bridgeDraftId);
      } finally {
        dbRestore.close();
      }
      await bridge.confirm(confirmation(input));
      expect(send).toHaveBeenCalledOnce();
    });

    it.each(['staged', 'stored'])(
      'refuses a draft request ID already bound to a %s draft before delivering another challenge',
      async (state) => {
        const posted = draft();
        let finish = () => {};
        if (state === 'staged') {
          deliver.mockImplementationOnce(
            (token, summary) =>
              new Promise<void>((resolve) => {
                delivered.set(summary.bridgeDraftId, token);
                finish = resolve;
              }),
          );
        }
        const preparing = bridge.prepare(posted);
        const settled = preparing.catch(() => undefined);
        await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
        const [approvalToken, summary] = deliver.mock.calls[0];
        if (state === 'stored') await preparing;
        const first = {
          bridgeDraftId: summary.bridgeDraftId,
          approvalToken,
          requestDigest: requestDigestFor(posted),
        };
        expect((await bridge.status(identity(first))).state).toBe(
          state === 'staged' ? 'awaiting_delivery' : 'pending',
        );
        deliver.mockClear();
        delivered.clear();
        try {
          await expect(
            bridge.prepare({
              ...posted,
              conversationId: 'conversation-rebound',
              draftId: 'draft-rebound',
              text: 'Different body for the same request id.',
            }),
          ).rejects.toMatchObject({
            status: 409,
            message:
              'This Web Bob draft request ID is already bound to another draft.',
          });
          expect(deliver).not.toHaveBeenCalled();
          expect(delivered.size).toBe(0);
          expect(send).not.toHaveBeenCalled();
        } finally {
          finish();
          await settled;
        }
        await preparing;
        expect((await bridge.status(identity(first))).state).toBe('pending');
        await bridge.confirm(confirmation(first));
        expect(send).toHaveBeenCalledOnce();
      },
    );

    it('refuses replayed and cross-bound confirmations without double send', async () => {
      const first = await approval();
      await bridge.confirm(confirmation(first));
      expect(send).toHaveBeenCalledOnce();
      await expect(bridge.confirm(confirmation(first))).rejects.toMatchObject({
        status: 409,
      });
      expect(send).toHaveBeenCalledOnce();
      const second = await approval({ ...draft(), draftId: 'draft-456' });
      await expect(
        bridge.confirm({
          bridgeDraftId: first.bridgeDraftId,
          approvalToken: first.approvalToken,
          requestDigest: second.requestDigest,
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(send).toHaveBeenCalledOnce();
    });

    it('refuses missing or malformed requestDigest on confirm, cancel and status', async () => {
      const input = await approval();
      for (const requestDigest of [
        undefined,
        input.requestDigest.toUpperCase(),
        input.requestDigest.slice(0, 63),
        42,
      ]) {
        const bad = {
          bridgeDraftId: input.bridgeDraftId,
          ...(requestDigest === undefined ? {} : { requestDigest }),
        };
        await expect(
          bridge.confirm({ ...bad, approvalToken: input.approvalToken }),
        ).rejects.toMatchObject({
          status: 400,
        });
        expect(() => bridge.cancel(bad)).toThrowError(
          'Invalid Web Bob request.',
        );
        await expect(bridge.status(bad)).rejects.toMatchObject({ status: 400 });
      }
      expect(send).not.toHaveBeenCalled();
      await bridge.confirm(confirmation(input));
      expect(send).toHaveBeenCalledOnce();
    });

    it('accepts matching requestDigest and attests the stored original on receipts', async () => {
      const body = draft();
      const card = await bridge.prepare(body);
      const expected = computeWebBobRequestDigest(
        parseWebBobRequestScope(body),
      );
      expect(card.requestDigest).toBe(expected);
      expect(card.requestDigest).not.toBe(card.digest);
      const input = {
        ...body,
        bridgeDraftId: card.draftId,
        requestDigest: card.requestDigest as string,
        approvalToken: delivered.get(card.draftId as string)!,
      };
      const confirmed = await bridge.confirm(confirmation(input));
      expect(confirmed.requestDigest).toBe(expected);
      expect(send).toHaveBeenCalledOnce();
      const status = await bridge.status(identity(input));
      expect(status.requestDigest).toBe(expected);
      expect(status.requestDigest).not.toBe(
        computeWebBobRequestDigest(
          parseWebBobRequestScope({ ...body, text: body.text + 'x' }),
        ),
      );
    });

    it('rejects non-canonical addresses and caller-supplied digest keys on draft', async () => {
      for (const address of ['(202) 555-0102', '+1 202 555 0102']) {
        await expect(
          bridge.prepare({ ...draft(), addresses: [address] }),
        ).rejects.toMatchObject({ status: 400 });
      }
      await expect(
        bridge.prepare({ ...draft(), requestDigest: 'a'.repeat(64) }),
      ).rejects.toMatchObject({ status: 400 });
      expect(send).not.toHaveBeenCalled();
    });
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
