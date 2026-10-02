import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import Database from 'better-sqlite3';

import { getMessageAction } from './db.js';
import { ChannelDeliveryUnverifiedError } from './channel-delivery.js';
import {
  createOrRefreshMessageActionFromDraft,
  executeExplicitlyAuthorizedMessageAction,
  reconcileBlueBubblesUnverifiedMessageActions,
  type MessageActionExecutionDeps,
} from './message-actions.js';
import {
  captureMessagingOutboundAuthorizationFence,
  isMessagingOutboundPaused,
  validateMessagingOutboundAuthorizationFence,
} from './messaging-outbound-pause.js';
import { secureEqual } from './secure-equal.js';
import { mintWebBobDispatchApproval } from './web-bob-approval.js';

const TTL = 5 * 60_000;
const ISSUER = 'web-bob';
const AUDIENCE = 'andrea';
const PREFIX = '/web-bob/v1/';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export interface WebBobBridgeConfig {
  token: string;
  denyAddresses: string[];
  denyChatGuids: string[];
}

export interface WebBobBridgeDeps {
  readonly buildSha?: string;
  connected(): boolean;
  /** Read the real exact thread membership; never trust caller metadata. */
  resolveRecipient(chatGuid: string): Promise<string[]>;
  readDelivery?(target: WebBobDeliveryTarget): Promise<WebBobDeliveryEvidence>;
  sendToTarget: MessageActionExecutionDeps['sendToTarget'];
}

export interface WebBobDeliveryTarget {
  messageGuid: string;
  chatGuid: string;
  address: string;
  text: string;
}

export interface WebBobDeliveryEvidence {
  state:
    | 'submitted'
    | 'sent'
    | 'delivered'
    | 'delivery_failed'
    | 'delivery_unconfirmed';
  error: number | null;
  deliveredAt: number | null;
}

interface Scope {
  issuer: string;
  audience: string;
  actor: string;
  conversationId: string;
  epoch: string;
  draftId: string;
  revision: number;
  draftRequestId: string;
  chatGuid: string;
  addresses: string[];
  text: string;
}

interface StoredDraft {
  id: string;
  scope: string;
  digest: string;
  challengeHash: string;
  serverEpoch: string;
  expires: number;
  pauseGeneration: number;
  state: string;
  actionId: string;
  confirmationRequestId: string | null;
}

export class WebBobBridgeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function requireValue(
  ok: unknown,
  status = 400,
  message = 'Invalid Web Bob request.',
): asserts ok {
  if (!ok) throw new WebBobBridgeError(status, message);
}

export function canonicalWebBobAddress(value: string): string {
  const clean = value.trim().toLowerCase();
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean))
    return clean;
  requireValue(/^\+?[0-9 ().-]+$/.test(clean));
  const digits = clean.replace(/\D/g, '');
  requireValue(digits.length >= 10 && digits.length <= 15);
  return '+' + (digits.length === 10 ? '1' : '') + digits;
}

function parseScope(value: Record<string, unknown>): Scope {
  requireValue(value.issuer === ISSUER && value.audience === AUDIENCE);
  for (const key of [
    'actor',
    'conversationId',
    'epoch',
    'draftId',
    'draftRequestId',
  ]) {
    requireValue(
      typeof value[key] === 'string' &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(value[key] as string),
    );
  }
  requireValue(
    typeof value.actor === 'string' && /^[a-f0-9]{64}$/.test(value.actor),
  );
  requireValue(
    Number.isSafeInteger(value.revision) && Number(value.revision) > 0,
  );
  requireValue(
    typeof value.chatGuid === 'string' &&
      /^(iMessage|SMS|RCS);-;[^;\s]{1,320}$/.test(value.chatGuid),
  );
  requireValue(
    typeof value.text === 'string' &&
      value.text.trim() &&
      value.text.length <= 4000,
  );
  requireValue(
    Array.isArray(value.addresses) &&
      value.addresses.length === 1 &&
      typeof value.addresses[0] === 'string',
  );
  const addresses = (value.addresses as string[]).map(canonicalWebBobAddress);
  // Fixed field order binds exact bytes independently of input JSON ordering.
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    actor: value.actor,
    conversationId: value.conversationId as string,
    epoch: value.epoch as string,
    draftId: value.draftId as string,
    revision: value.revision as number,
    draftRequestId: value.draftRequestId as string,
    chatGuid: value.chatGuid,
    addresses,
    text: value.text,
  };
}

/** Optional host integration; constructing it does not open a port or send.
 * FULL synchronous SQLite commits consume consent before any external await.
 * Existing control and MCP handlers never have a reference to this ingress. */
export class WebBobBridge {
  private readonly db: Database.Database;
  private readonly epoch = randomBytes(24).toString('hex');
  private readonly deny: Set<string>;
  private readonly inspections = new Map<
    string,
    Promise<Record<string, unknown>>
  >();

  constructor(
    readonly config: WebBobBridgeConfig,
    databasePath: string,
    readonly deps: WebBobBridgeDeps,
  ) {
    requireValue(
      /^[a-zA-Z0-9_-]{32,128}$/.test(config.token) &&
        config.denyAddresses.length > 0 &&
        config.denyChatGuids.length > 0,
      503,
      'Web Bob bridge requires dedicated authentication and Instinct denial configuration.',
    );
    this.deny = new Set(config.denyAddresses.map(canonicalWebBobAddress));
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), {
        recursive: true,
        mode: 0o700,
      });
      // Fail closed on a linked store rather than granting authority through it.
      if (fs.existsSync(databasePath))
        requireValue(!fs.lstatSync(databasePath).isSymbolicLink(), 503);
    }
    this.db = new Database(databasePath);
    if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS webbob_drafts (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, digest TEXT NOT NULL,
      challengeHash TEXT NOT NULL, serverEpoch TEXT NOT NULL, expires INTEGER NOT NULL,
      pauseGeneration INTEGER NOT NULL, state TEXT NOT NULL, actionId TEXT NOT NULL,
      confirmationRequestId TEXT
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS webbob_delivery (
      draftId TEXT PRIMARY KEY, evidence TEXT NOT NULL
    )`);
    // Restart cannot revive a pending owner decision. Consumed records survive.
    this.db
      .prepare(
        "UPDATE webbob_drafts SET state = 'expired' WHERE state = 'pending'",
      )
      .run();
  }

  close(): void {
    this.db.close();
  }

  private async validateRecipient(scope: Scope): Promise<void> {
    requireValue(
      !this.config.denyChatGuids.includes(scope.chatGuid),
      403,
      'Instinct is read-only.',
    );
    const guidAddress = canonicalWebBobAddress(scope.chatGuid.split(';')[2]);
    requireValue(
      !this.deny.has(guidAddress) &&
        !scope.addresses.some((a) => this.deny.has(a)),
      403,
      'Instinct is read-only.',
    );
    requireValue(
      this.deps.connected(),
      503,
      'Andrea messaging is unavailable.',
    );
    const observed = (await this.deps.resolveRecipient(scope.chatGuid)).map(
      canonicalWebBobAddress,
    );
    requireValue(
      observed.length === 1 &&
        observed[0] === scope.addresses[0] &&
        observed[0] === guidAddress,
      409,
      'The exact direct-thread recipient could not be verified.',
    );
    requireValue(
      !observed.some((a) => this.deny.has(a)),
      403,
      'Instinct is read-only.',
    );
  }

  async prepare(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const scope = parseScope(value);
    await this.validateRecipient(scope);
    requireValue(
      !isMessagingOutboundPaused(),
      409,
      'Andrea outbound messaging is paused.',
    );
    const now = Date.now();
    const fence = captureMessagingOutboundAuthorizationFence(
      new Date(now).toISOString(),
    );
    requireValue(validateMessagingOutboundAuthorizationFence(fence).ok, 409);
    const serialized = JSON.stringify(scope);
    const digest = hash(serialized);
    const id = hash(
      JSON.stringify([
        scope.actor,
        scope.conversationId,
        scope.epoch,
        scope.draftId,
      ]),
    );
    const challenge = 'wbtxt-' + randomBytes(16).toString('hex');
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: 'webbob',
      presentationChannel: 'bluebubbles',
      presentationChatJid: 'webbob:' + scope.conversationId,
      sourceType: 'manual_prompt',
      sourceKey: 'webbob:inbound:' + id,
      sourceSummary: 'Exact Web Bob owner draft',
      draftProvenance: 'owner_literal',
      draftText: scope.text,
      forceApproval: true,
      targetChannelOverride: 'bluebubbles',
      targetOverride: {
        kind: 'external_thread',
        chatJid: 'bb:' + scope.chatGuid,
        isGroup: false,
      },
    });
    this.db
      .transaction(() => {
        requireValue(
          !this.db.prepare('SELECT id FROM webbob_drafts WHERE id = ?').get(id),
          409,
          'This draft request already exists; review a fresh draft.',
        );
        const count = this.db
          .prepare('SELECT count(*) AS n FROM webbob_drafts')
          .get() as { n: number };
        requireValue(
          count.n < 10000,
          503,
          'Web Bob bridge history limit reached.',
        );
        // A new draft supersedes every older pending card in this conversation.
        const pending = this.db
          .prepare(
            "SELECT id, scope FROM webbob_drafts WHERE state = 'pending'",
          )
          .all() as { id: string; scope: string }[];
        for (const row of pending) {
          const other = JSON.parse(row.scope) as Scope;
          if (other.conversationId === scope.conversationId)
            this.db
              .prepare(
                "UPDATE webbob_drafts SET state = 'superseded' WHERE id = ?",
              )
              .run(row.id);
        }
        this.db
          .prepare(
            'INSERT INTO webbob_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
          )
          .run(
            id,
            serialized,
            digest,
            hash(challenge),
            this.epoch,
            now + TTL,
            fence.pauseGeneration,
            'pending',
            action.messageActionId,
          );
      })
      .immediate();
    return {
      ok: true,
      draftId: id,
      digest,
      challenge,
      expiresAt: now + TTL,
      actionId: action.messageActionId,
    };
  }

  private bound(value: Record<string, unknown>): {
    row: StoredDraft;
    scope: Scope;
  } {
    requireValue(
      typeof value.bridgeDraftId === 'string' &&
        /^[a-f0-9]{64}$/.test(value.bridgeDraftId),
    );
    const row = this.db
      .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
      .get(value.bridgeDraftId) as StoredDraft | undefined;
    requireValue(row, 404, 'Unknown Web Bob draft.');
    const scope = parseScope(value);
    requireValue(
      secureEqual(hash(JSON.stringify(scope)), row.digest),
      403,
      'This confirmation does not match the exact draft and login.',
    );
    return { row, scope };
  }

  cancel(value: Record<string, unknown>): Record<string, unknown> {
    const { row } = this.bound(value);
    this.db
      .prepare(
        "UPDATE webbob_drafts SET state = 'cancelled' WHERE id = ? AND state = 'pending'",
      )
      .run(row.id);
    const current = this.db
      .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
      .get(row.id) as StoredDraft;
    return this.receipt(current);
  }

  private receipt(row: StoredDraft): Record<string, unknown> {
    // The existing BlueBubbles send transport may return only a receipt ID.
    // Its channel persists the exact outbound row before returning. Reconcile
    // only through the core's ID/body/recipient/authorship/time-bound evidence
    // matcher; absence or mismatch remains uncertain and can never resend.
    if (row.state === 'consumed') {
      reconcileBlueBubblesUnverifiedMessageActions({ groupFolder: 'webbob' });
    }
    const action = getMessageAction(row.actionId);
    const scope = JSON.parse(row.scope) as Scope;
    const explanation = action?.explanationJson
      ? JSON.parse(action.explanationJson)
      : {};
    const receipt = explanation.executionReceipt;
    const verified =
      action?.sendStatus === 'sent' &&
      action.platformMessageId?.trim() &&
      action.draftText === scope.text &&
      receipt?.verification === 'verified' &&
      receipt.provider === 'bluebubbles' &&
      receipt.providerReceiptId === action.platformMessageId &&
      receipt.recipient === 'bb:' + scope.chatGuid &&
      receipt.threadId === 'bb:' + scope.chatGuid &&
      receipt.exactContent === scope.text &&
      receipt.idempotencyKey === row.actionId;
    if (verified) {
      this.db
        .prepare('INSERT OR IGNORE INTO webbob_delivery VALUES (?, ?)')
        .run(
          row.id,
          JSON.stringify({
            state: 'submitted',
            error: null,
            deliveredAt: null,
            checkedAt: null,
            messageGuid: action.platformMessageId,
            actionId: row.actionId,
            digest: row.digest,
          }),
        );
    }
    const saved = this.db
      .prepare('SELECT evidence FROM webbob_delivery WHERE draftId = ?')
      .get(row.id) as { evidence: string } | undefined;
    const delivery = verified && saved ? JSON.parse(saved.evidence) : null;
    if (delivery)
      requireValue(
        delivery.messageGuid === action?.platformMessageId &&
          delivery.actionId === row.actionId &&
          delivery.digest === row.digest,
        409,
        'The original submission identity changed; delivery could not be refreshed.',
      );
    return {
      ok: true,
      draftId: row.id,
      digest: row.digest,
      actionId: row.actionId,
      state: verified
        ? delivery?.state || 'submitted'
        : row.state === 'consumed'
          ? 'delivery_unconfirmed'
          : row.state,
      ...(verified ? { messageGuid: action.platformMessageId } : {}),
      deliveryProtocol: 1,
      delivery: delivery ? { ...delivery, fresh: false } : null,
    };
  }

  /** Inspect only an already consumed, exactly correlated submission. No send
   * method is reachable here. Coalesce concurrent reads so old responses cannot
   * race newer evidence; retained failures/delivery survive restart/read errors. */
  private refreshReceipt(row: StoredDraft): Promise<Record<string, unknown>> {
    const existing = this.inspections.get(row.id);
    if (existing) return existing;
    const inspection = (async () => {
      const result = this.receipt(row);
      if (row.state !== 'consumed' || !result.messageGuid) return result;
      const scope = JSON.parse(row.scope) as Scope;
      try {
        if (!this.deps.readDelivery)
          throw new Error('Receipt inspection unavailable.');
        const observed = await this.deps.readDelivery({
          messageGuid: result.messageGuid as string,
          chatGuid: scope.chatGuid,
          address: scope.addresses[0],
          text: scope.text,
        });
        const current = this.receipt(row);
        requireValue(
          current.messageGuid === result.messageGuid &&
            current.actionId === result.actionId &&
            current.digest === result.digest,
          409,
          'Submission identity changed during inspection.',
        );
        const previous = result.delivery as
          | (WebBobDeliveryEvidence & { checkedAt: number })
          | null;
        let retained = false;
        let evidence = {
          ...observed,
          checkedAt: Date.now(),
          messageGuid: result.messageGuid,
          actionId: row.actionId,
          digest: row.digest,
        };
        // A row that merely exists cannot erase a known failure or delivery.
        // Recovery from an error requires a later positive delivery timestamp.
        if (
          previous &&
          (previous.state === 'delivery_failed' ||
            previous.state === 'delivered') &&
          (['submitted', 'sent', 'delivery_unconfirmed'].includes(
            observed.state,
          ) ||
            (previous.state === 'delivery_failed' &&
              observed.state === 'delivered' &&
              (!observed.deliveredAt ||
                observed.deliveredAt <= previous.checkedAt)))
        ) {
          retained = true;
          evidence = {
            state: previous.state,
            error: previous.error,
            deliveredAt: previous.deliveredAt,
            checkedAt: previous.checkedAt,
            messageGuid: result.messageGuid,
            actionId: row.actionId,
            digest: row.digest,
          };
        }
        this.db
          .prepare('INSERT OR REPLACE INTO webbob_delivery VALUES (?, ?)')
          .run(row.id, JSON.stringify(evidence));
        return {
          ...result,
          state: evidence.state,
          delivery: { ...evidence, fresh: !retained, refreshedAt: Date.now() },
        };
      } catch {
        // A failed read never proves failure, delivery, or permission to retry.
        return {
          ...result,
          delivery: result.delivery || null,
          deliveryRefreshUnavailable: true,
        };
      }
    })();
    this.inspections.set(row.id, inspection);
    const cleanup = () => {
      this.inspections.delete(row.id);
    };
    void inspection.then(cleanup, cleanup);
    return inspection;
  }

  async status(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row } = this.bound(value);
    return this.refreshReceipt(row);
  }

  async confirm(
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { row, scope } = this.bound(value);
    requireValue(
      typeof value.confirmation === 'string' &&
        /^yes wbtxt-[a-f0-9]{32}$/.test(value.confirmation),
    );
    requireValue(
      secureEqual(hash(value.confirmation.slice(4)), row.challengeHash),
      403,
    );
    requireValue(
      typeof value.confirmationRequestId === 'string' &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(value.confirmationRequestId) &&
        value.confirmationRequestId !== scope.draftRequestId,
      403,
      'A separate owner confirmation is required.',
    );
    if (row.state === 'consumed') return this.refreshReceipt(row);
    requireValue(
      row.state === 'pending' &&
        row.serverEpoch === this.epoch &&
        row.expires > Date.now(),
      409,
      'This draft confirmation is no longer current.',
    );
    requireValue(
      typeof value.approvedAt === 'number' &&
        value.approvedAt >= row.expires - TTL &&
        value.approvedAt <= Date.now() + 1000 &&
        value.approvedAt >= Date.now() - 30_000,
      403,
    );
    await this.validateRecipient(scope);
    const authorizationAt = new Date(value.approvedAt).toISOString();
    requireValue(
      validateMessagingOutboundAuthorizationFence({
        authorizationAt,
        pauseGeneration: row.pauseGeneration,
      }).ok,
      409,
      'Andrea outbound authority was revoked.',
    );
    // Recheck under the write lock after the membership read yielded. Cancel,
    // replacement, restart, concurrent approval and disk errors all fail closed.
    const consumed = this.db
      .prepare(
        "UPDATE webbob_drafts SET state = 'consumed', confirmationRequestId = ? WHERE id = ? AND state = 'pending' AND serverEpoch = ? AND expires > ?",
      )
      .run(value.confirmationRequestId, row.id, this.epoch, Date.now());
    if (!consumed.changes) {
      const current = this.db
        .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
        .get(row.id) as StoredDraft;
      requireValue(
        current.state === 'consumed',
        409,
        'This draft confirmation is no longer current.',
      );
      return this.refreshReceipt(current);
    }
    row.state = 'consumed';
    const action = getMessageAction(row.actionId);
    requireValue(
      action &&
        action.draftText === scope.text &&
        action.presentationChatJid === 'webbob:' + scope.conversationId &&
        JSON.parse(action.targetConversationJson).chatJid ===
          'bb:' + scope.chatGuid,
      409,
    );
    const webBobApproval = mintWebBobDispatchApproval(action);
    await executeExplicitlyAuthorizedMessageAction(row.actionId, {
      groupFolder: 'webbob',
      channel: 'bluebubbles',
      chatJid: action.presentationChatJid!,
      ownerAuthorizationAt: authorizationAt,
      webBobApproval,
      sendToTarget: async (channel, chatJid, text, options) => {
        requireValue(
          channel === 'bluebubbles' &&
            chatJid === 'bb:' + scope.chatGuid &&
            text === scope.text,
          403,
        );
        requireValue(
          validateMessagingOutboundAuthorizationFence({
            authorizationAt,
            pauseGeneration: row.pauseGeneration,
          }).ok,
          409,
        );
        const receipt = await this.deps.sendToTarget(
          channel,
          chatJid,
          text,
          options,
        );
        if (receipt.threadId !== chatJid) {
          throw new ChannelDeliveryUnverifiedError({
            outcome: 'unknown',
            confirmedReceiptIds: receipt.platformMessageId
              ? [receipt.platformMessageId]
              : [],
            confirmedReceiptCount: receipt.platformMessageId ? 1 : 0,
          });
        }
        return receipt;
      },
    });
    return this.refreshReceipt(row);
  }

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.origin ||
      !secureEqual(
        req.headers.authorization || '',
        'Bearer ' + this.config.token,
      )
    ) {
      reply(401, { error: 'Unauthorized' });
      return;
    }
    try {
      if (req.method === 'GET' && req.url === PREFIX + 'health') {
        reply(200, {
          ok: true,
          protocol: 1,
          service: 'andrea-web-bob',
          sha: this.deps.buildSha || null,
          connected: this.deps.connected(),
          paused: isMessagingOutboundPaused(),
          instinctReadOnly: true,
          deliveryProtocol: 1,
        });
        return;
      }
      requireValue(
        req.method === 'POST' &&
          [
            PREFIX + 'draft',
            PREFIX + 'confirm',
            PREFIX + 'cancel',
            PREFIX + 'status',
          ].includes(req.url || ''),
        404,
      );
      requireValue(
        req.headers['content-type']?.split(';')[0] === 'application/json',
        415,
      );
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const data of req) {
        length += data.length;
        requireValue(length <= 24000, 413);
        chunks.push(Buffer.from(data));
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new WebBobBridgeError(400, 'Invalid JSON.');
      }
      requireValue(value && typeof value === 'object' && !Array.isArray(value));
      const input = value as Record<string, unknown>;
      const output =
        req.url === PREFIX + 'draft'
          ? await this.prepare(input)
          : req.url === PREFIX + 'confirm'
            ? await this.confirm(input)
            : req.url === PREFIX + 'status'
              ? await this.status(input)
              : this.cancel(input);
      reply(200, output);
    } catch (error) {
      // Never expose request bytes, credentials, SQLite paths or provider errors.
      reply(error instanceof WebBobBridgeError ? error.status : 503, {
        error:
          error instanceof WebBobBridgeError
            ? error.message
            : 'Andrea could not verify this operation. No automatic retry.',
      });
    }
  }
}
