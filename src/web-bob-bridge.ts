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
import {
  WebBobDraftRetention,
  WEB_BOB_TERMINAL_DRAFT_LIMIT,
} from './web-bob-draft-retention.js';
import {
  DisabledOwnerChallengeDelivery,
  type OwnerChallengeDelivery,
} from './owner-challenge-delivery.js';

const TTL = 5 * 60_000;
const APPROVAL_TTL = 30_000;
const PENDING_LIMIT = 10000;
const ISSUER = 'web-bob';
const AUDIENCE = 'andrea';
const PREFIX = '/web-bob/v1/';
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
// This dedicated owner surface is for Jeff. Caller identity claims confer no
// authority; only possession of the independently delivered approval can do so.
const OWNER_ACTOR = hash('web-bob:owner:jeff');
const challengeHash = (
  challenge: string,
  id: string,
  revision: number,
  digest: string,
) =>
  hash(
    JSON.stringify([
      'web-bob:owner-approval:v2',
      id,
      revision,
      digest,
      challenge,
    ]),
  );

export function isWebBobLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.has(address.replace(/^\[|\]$/g, ''));
}

export interface WebBobBridgeConfig {
  token: string;
  denyAddresses: string[];
  denyChatGuids: string[];
}

export interface WebBobBridgeDeps {
  readonly buildSha?: string;
  readonly ownerChallengeDelivery?: OwnerChallengeDelivery;
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
  approvedAt: number | null;
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

function parseDraftScope(value: Record<string, unknown>): Scope {
  requireValue(value.issuer === ISSUER && value.audience === AUDIENCE);
  for (const key of ['conversationId', 'epoch', 'draftId']) {
    requireValue(
      typeof value[key] === 'string' &&
        /^[a-zA-Z0-9_-]{8,128}$/.test(value[key] as string),
    );
  }
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
    actor: OWNER_ACTOR,
    conversationId: value.conversationId as string,
    epoch: value.epoch as string,
    draftId: value.draftId as string,
    revision: value.revision as number,
    draftRequestId: randomBytes(24).toString('hex'),
    chatGuid: value.chatGuid,
    addresses,
    text: value.text,
  };
}

/** Optional host integration; constructing it does not open a port or send.
 * FULL synchronous SQLite commits consume consent before external dispatch.
 * Existing control and MCP handlers never have a reference to this ingress. */
export class WebBobBridge {
  private readonly db: Database.Database;
  private readonly epoch = randomBytes(24).toString('hex');
  private readonly deny: Set<string>;
  private readonly ownerChallengeDelivery: OwnerChallengeDelivery;
  private readonly retention: WebBobDraftRetention;
  // Undelivered challenges never reach either persistent store. Keep failed
  // delivery diagnostics briefly in bounded memory; they confer no authority.
  private readonly staged = new Map<string, StoredDraft>();
  private deliveriesInFlight = 0;
  private closed = false;
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
    this.ownerChallengeDelivery =
      deps.ownerChallengeDelivery ?? new DisabledOwnerChallengeDelivery();
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
      confirmationRequestId TEXT, approvedAt INTEGER
    )`);
    if (
      !(this.db.pragma('table_info(webbob_drafts)') as { name: string }[]).some(
        (column) => column.name === 'approvedAt',
      )
    ) {
      this.db.exec('ALTER TABLE webbob_drafts ADD COLUMN approvedAt INTEGER');
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS webbob_delivery (
      draftId TEXT PRIMARY KEY, evidence TEXT NOT NULL
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS webbob_drafts_revision
      ON webbob_drafts (
        json_extract(scope, '$.actor'),
        json_extract(scope, '$.conversationId'),
        json_extract(scope, '$.epoch'),
        json_extract(scope, '$.draftId'),
        json_extract(scope, '$.revision')
      )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS webbob_drafts_pending
      ON webbob_drafts (state, expires)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS webbob_server_epoch (
      id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL
    )`);
    this.retention = new WebBobDraftRetention(this.db, (status, message) => {
      throw new WebBobBridgeError(status, message);
    });
    // Restart also revokes deliveries still awaiting an adapter in another
    // instance. Their eventual completion cannot create a persistent draft.
    this.db
      .prepare('INSERT OR REPLACE INTO webbob_server_epoch VALUES (1, ?)')
      .run(this.epoch);
    // Restart cannot revive a pending owner decision. Consumed records survive.
    this.db
      .prepare(
        "UPDATE webbob_drafts SET state = 'expired', challengeHash = '' WHERE state IN ('pending', 'awaiting_delivery')",
      )
      .run();
    this.db.transaction(() => this.retention.prune(Date.now())).immediate();
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  private pruneStaged(now: number): void {
    let terminal = 0;
    for (const row of this.staged.values()) {
      if (row.state === 'awaiting_delivery' && row.expires <= now) {
        row.state = 'expired';
        row.challengeHash = '';
      }
      if (row.state !== 'awaiting_delivery') terminal++;
    }
    for (const [id, row] of this.staged) {
      if (terminal <= WEB_BOB_TERMINAL_DRAFT_LIMIT) break;
      if (row.state !== 'awaiting_delivery') {
        this.staged.delete(id);
        terminal--;
      }
    }
  }

  private assertCurrentEpoch(): void {
    requireValue(!this.closed, 409);
    const current = this.db
      .prepare('SELECT epoch FROM webbob_server_epoch WHERE id = 1')
      .get() as { epoch: string };
    requireValue(current.epoch === this.epoch, 409);
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
    now = Date.now(),
  ): Promise<Record<string, unknown>> {
    requireValue(
      !(this.ownerChallengeDelivery instanceof DisabledOwnerChallengeDelivery),
      503,
      'Owner approval delivery is unavailable.',
    );
    const scope = parseDraftScope(value);
    await this.validateRecipient(scope);
    requireValue(
      !isMessagingOutboundPaused(),
      409,
      'Andrea outbound messaging is paused.',
    );
    const fence = captureMessagingOutboundAuthorizationFence(
      new Date(now).toISOString(),
    );
    requireValue(validateMessagingOutboundAuthorizationFence(fence).ok, 409);
    const serialized = JSON.stringify(scope);
    const digest = hash(serialized);
    // A pruned reference can never name a new action, even if a caller repeats
    // every input field. Revision watermarks independently reject stale input.
    const id = randomBytes(32).toString('hex');
    const challenge = 'wbtxt-' + randomBytes(32).toString('hex');
    this.pruneStaged(now);
    requireValue(
      this.deliveriesInFlight < PENDING_LIMIT,
      503,
      'Web Bob bridge pending draft limit reached.',
    );
    this.db
      .transaction(() => {
        this.assertCurrentEpoch();
        this.retention.prune(now);
        this.retention.assertRevision(scope);
        let awaiting = 0;
        for (const row of this.staged.values()) {
          const previous = JSON.parse(row.scope) as Scope;
          requireValue(
            previous.actor !== scope.actor ||
              previous.conversationId !== scope.conversationId ||
              previous.epoch !== scope.epoch ||
              previous.draftId !== scope.draftId ||
              previous.revision < scope.revision,
            409,
            'This draft revision already exists or is stale; review a fresh draft.',
          );
          if (
            row.state === 'awaiting_delivery' &&
            previous.conversationId !== scope.conversationId
          )
            awaiting++;
        }
        this.db
          .prepare(
            `UPDATE webbob_drafts SET state = 'superseded', challengeHash = ''
         WHERE state IN ('pending', 'awaiting_delivery') AND json_extract(scope, '$.conversationId') = ?`,
          )
          .run(scope.conversationId);
        const count = this.db
          .prepare(
            "SELECT count(*) AS n FROM webbob_drafts WHERE state IN ('pending', 'awaiting_delivery')",
          )
          .get() as { n: number };
        requireValue(
          count.n + awaiting < PENDING_LIMIT,
          503,
          'Web Bob bridge pending draft limit reached.',
        );
        this.retention.prune(now);
      })
      .immediate();
    for (const row of this.staged.values()) {
      if (
        row.state === 'awaiting_delivery' &&
        (JSON.parse(row.scope) as Scope).conversationId === scope.conversationId
      ) {
        row.state = 'superseded';
        row.challengeHash = '';
      }
    }
    const staged: StoredDraft = {
      id,
      scope: serialized,
      digest,
      challengeHash: challengeHash(challenge, id, scope.revision, digest),
      serverEpoch: this.epoch,
      expires: now + TTL,
      pauseGeneration: fence.pauseGeneration,
      state: 'awaiting_delivery',
      actionId: '',
      confirmationRequestId: null,
      approvedAt: null,
    };
    this.staged.set(id, staged);
    this.deliveriesInFlight++;
    try {
      await this.ownerChallengeDelivery.deliver(
        challenge,
        Object.freeze({
          bridgeDraftId: id,
          revision: scope.revision,
          contentHash: digest,
          expiresAt: now + TTL,
          actor: scope.actor,
          conversationId: scope.conversationId,
          chatGuid: scope.chatGuid,
          addresses: Object.freeze([...scope.addresses]),
          text: scope.text,
        }),
      );
      const action = this.db
        .transaction(() => {
          this.assertCurrentEpoch();
          requireValue(
            staged.state === 'awaiting_delivery' &&
              staged.expires > Math.max(now, Date.now()),
            409,
          );
          requireValue(
            validateMessagingOutboundAuthorizationFence(fence).ok,
            409,
          );
          this.retention.assertRevision(scope);
          this.retention.recordRevision(scope);
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
            .prepare(
              'INSERT INTO webbob_drafts (id, scope, digest, challengeHash, serverEpoch, expires, pauseGeneration, state, actionId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              id,
              serialized,
              digest,
              staged.challengeHash,
              this.epoch,
              now + TTL,
              fence.pauseGeneration,
              'pending',
              action.messageActionId,
            );
          return action;
        })
        .immediate();
      this.staged.delete(id);
      return {
        ok: true,
        draftId: id,
        digest,
        expiresAt: now + TTL,
        actionId: action.messageActionId,
      };
    } catch {
      if (staged.state === 'awaiting_delivery') {
        staged.state = 'approval_unavailable';
        staged.challengeHash = '';
      }
      // Delivery errors can contain secret bytes, including bridge error types.
      // Never forward any adapter exception or return the token as a fallback.
      throw new WebBobBridgeError(
        503,
        'Owner approval delivery is unavailable.',
      );
    } finally {
      this.deliveriesInFlight--;
      this.pruneStaged(Date.now());
    }
  }

  private bound(
    value: Record<string, unknown>,
    confirmation = false,
  ): {
    row: StoredDraft;
    scope: Scope;
  } {
    requireValue(
      Object.keys(value).every(
        (key) =>
          key === 'bridgeDraftId' || (confirmation && key === 'approvalToken'),
      ),
    );
    requireValue(
      typeof value.bridgeDraftId === 'string' &&
        /^[a-f0-9]{64}$/.test(value.bridgeDraftId),
    );
    const row =
      (this.db
        .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
        .get(value.bridgeDraftId) as StoredDraft | undefined) ??
      this.staged.get(value.bridgeDraftId);
    requireValue(row, 404, 'Unknown Web Bob draft.');
    requireValue(
      typeof row.scope === 'string' &&
        typeof row.digest === 'string' &&
        /^[a-f0-9]{64}$/.test(row.digest) &&
        secureEqual(hash(row.scope), row.digest),
      403,
      'This operation does not match the stored draft.',
    );
    const scope = JSON.parse(row.scope) as Scope;
    return { row, scope };
  }

  cancel(value: Record<string, unknown>): Record<string, unknown> {
    const { row } = this.bound(value);
    if (this.staged.has(row.id)) {
      if (row.state === 'awaiting_delivery') {
        row.state = 'cancelled';
        row.challengeHash = '';
      }
      this.pruneStaged(Date.now());
      return this.receipt(row);
    }
    this.db
      .prepare(
        "UPDATE webbob_drafts SET state = 'cancelled', challengeHash = '' WHERE id = ? AND state IN ('pending', 'awaiting_delivery')",
      )
      .run(row.id);
    const current = this.db
      .prepare('SELECT * FROM webbob_drafts WHERE id = ?')
      .get(row.id) as StoredDraft;
    this.db.transaction(() => this.retention.prune(Date.now())).immediate();
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
        .prepare(
          `INSERT OR IGNORE INTO webbob_delivery
          SELECT ?, ? WHERE EXISTS (SELECT 1 FROM webbob_drafts WHERE id = ?)`,
        )
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
          row.id,
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
          .prepare(
            `INSERT OR REPLACE INTO webbob_delivery
            SELECT ?, ? WHERE EXISTS (SELECT 1 FROM webbob_drafts WHERE id = ?)`,
          )
          .run(row.id, JSON.stringify(evidence), row.id);
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
    const { row, scope } = this.bound(value, true);
    requireValue(
      row.state === 'pending' && row.serverEpoch === this.epoch,
      409,
      'This draft confirmation is no longer current.',
    );
    requireValue(
      typeof value.approvalToken === 'string' &&
        /^wbtxt-[a-f0-9]{64}$/.test(value.approvalToken),
      403,
    );
    requireValue(
      secureEqual(
        challengeHash(value.approvalToken, row.id, scope.revision, row.digest),
        row.challengeHash,
      ),
      403,
    );
    // Owner approval is established by the token, not the bearer caller's
    // claims. Andrea owns both its timestamp and the audit request identity.
    const approvedAt = Date.now();
    const confirmationRequestId = randomBytes(24).toString('hex');
    const validateFreshness = () => {
      const currentTime = Date.now();
      requireValue(
        row.expires > currentTime,
        409,
        'This draft confirmation is no longer current.',
      );
      requireValue(
        approvedAt >= row.expires - TTL &&
          approvedAt <= currentTime &&
          currentTime - approvedAt < APPROVAL_TTL,
        403,
      );
      return currentTime;
    };
    validateFreshness();
    await this.validateRecipient(scope);
    // Membership lookup can outlive either the card or the separate owner
    // approval. Both must still be current before consuming durable consent.
    const validatedAt = validateFreshness();
    const authorizationAt = new Date(approvedAt).toISOString();
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
        "UPDATE webbob_drafts SET state = 'consumed', challengeHash = '', confirmationRequestId = ?, approvedAt = ? WHERE id = ? AND state = 'pending' AND serverEpoch = ? AND expires > ? AND digest = ? AND scope = ? AND challengeHash = ?",
      )
      .run(
        confirmationRequestId,
        approvedAt,
        row.id,
        this.epoch,
        validatedAt,
        row.digest,
        row.scope,
        row.challengeHash,
      );
    requireValue(
      consumed.changes,
      409,
      'This draft confirmation is no longer current.',
    );
    row.state = 'consumed';
    this.db.transaction(() => this.retention.prune(Date.now())).immediate();
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
        validateFreshness();
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
    const authorization = req.headers.authorization;
    const host = req.headers.host;
    if (
      req.headers.origin !== undefined ||
      req.headers['x-forwarded-for'] !== undefined ||
      req.headers['x-forwarded-host'] !== undefined ||
      req.headers['x-real-ip'] !== undefined ||
      req.headers.forwarded !== undefined ||
      typeof authorization !== 'string' ||
      typeof host !== 'string' ||
      !/^127\.0\.0\.1(?::\d+)?$/.test(host) ||
      !isWebBobLoopbackAddress(req.socket?.remoteAddress) ||
      !isWebBobLoopbackAddress(req.socket?.localAddress) ||
      !secureEqual(authorization, 'Bearer ' + this.config.token)
    ) {
      reply(401, { error: 'Unauthorized' });
      return;
    }
    try {
      if (req.method === 'GET' && req.url === PREFIX + 'health') {
        reply(200, {
          ok: true,
          protocol: 2,
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
