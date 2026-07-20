import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const RECEIPT_INBOX_SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_LEASE_MS = 30_000;
const MAX_LIST_LIMIT = 500;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_CHAT_GUID_LENGTH = 2_048;
const MAX_CONTENT_LENGTH = 64 * 1_024;
const MAX_CANONICAL_SCOPE_LENGTH = 2_048;
const MIRRORED_INGRESS_TOLERANCE_MS = 2_000;
const DEFAULT_INGRESS_PROCESSING_LEASE_MS = 30_000;
const MAX_WEBHOOK_PATH_LENGTH = 1_024;

interface ReceiptInboxRow {
  inbox_sequence: number;
  receipt_id: string;
  temp_guid: string;
  message_guid: string;
  direct_chat_guid: string;
  exact_content: string;
  provider_timestamp: string;
  provider_timestamp_ms: number;
  is_from_me: number;
  received_at: string;
  received_at_ms: number;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_expires_at_ms: number | null;
  acknowledged_at: string | null;
}

interface IngressClaimRow {
  claim_id: string;
  canonical_scope: string;
  owner_authored: number;
  normalized_exact_body: string;
  provider_timestamp: string;
  provider_timestamp_ms: number;
  claimed_at: string;
  processing_lease_token: string | null;
  processing_lease_expires_at: string | null;
  processing_lease_expires_at_ms: number | null;
  accepted_at: string | null;
}

export interface BlueBubblesReceiptInput {
  tempGuid: string;
  messageGuid: string;
  chatGuid: string;
  content: string;
  timestamp: string | number | Date;
  isFromMe: true;
}

export interface DurableBlueBubblesReceipt {
  sequence: number;
  receiptId: string;
  tempGuid: string;
  messageGuid: string;
  chatGuid: string;
  content: string;
  timestamp: string;
  providerTimestampMs: number;
  isFromMe: true;
  receivedAt: string;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  acknowledgedAt: string | null;
}

export interface PersistBlueBubblesReceiptResult {
  receipt: DurableBlueBubblesReceipt;
  inserted: boolean;
}

export interface LeasePendingReceiptsInput {
  consumerId: string;
  limit?: number;
  leaseMs?: number;
  now?: Date;
}

export interface LeasedBlueBubblesReceiptBatch {
  leaseToken: string | null;
  consumerId: string;
  leaseExpiresAt: string | null;
  receipts: DurableBlueBubblesReceipt[];
}

export interface AckPendingReceiptsInput {
  leaseToken: string;
  receiptIds: string[];
  acknowledgedAt?: Date;
}

export interface CanonicalSelfThreadIngressClaimInput {
  canonicalScope: string;
  ownerAuthored: boolean;
  body: string;
  providerTimestamp: string | number | Date;
  now?: Date;
  processingLeaseMs?: number;
}

export interface CanonicalSelfThreadIngressClaim {
  claimId: string;
  canonicalScope: string;
  ownerAuthored: boolean;
  normalizedBody: string;
  providerTimestamp: string;
  providerTimestampMs: number;
  claimedAt: string;
  processingLeaseToken: string | null;
  processingLeaseExpiresAt: string | null;
  acceptedAt: string | null;
  disposition: 'claimed' | 'mirror' | 'resumed';
  isNew: boolean;
  shouldProcess: boolean;
}

export interface AcceptCanonicalSelfThreadIngressClaimInput {
  claimId: string;
  processingLeaseToken: string;
  acceptedAt?: Date;
}

export interface ReleaseCanonicalSelfThreadIngressClaimInput {
  claimId: string;
  processingLeaseToken: string;
}

export interface IgnoreCanonicalSelfThreadIngressClaimInput {
  claimId: string;
  /**
   * Immutable local receipt time returned with the claim. Requiring it keeps
   * a stale-recovery tombstone bound to the exact durable row it inspected.
   */
  claimedAt: string | number | Date;
  ignoredAt?: Date;
}

export interface BlueBubblesReceiptInboxStoreHealth {
  status: 'ok';
  schemaVersion: number;
}

export class BlueBubblesReceiptInboxValidationError extends Error {
  readonly code = 'BLUEBUBBLES_RECEIPT_INBOX_VALIDATION';

  constructor(message: string) {
    super(message);
    this.name = 'BlueBubblesReceiptInboxValidationError';
  }
}

export class BlueBubblesReceiptConflictError extends Error {
  readonly code = 'BLUEBUBBLES_RECEIPT_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'BlueBubblesReceiptConflictError';
  }
}

function requireBoundedString(
  value: unknown,
  field: string,
  maxLength: number,
  options: { preserveWhitespace?: boolean } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} must be a non-empty string.`,
    );
  }
  if (value.length > maxLength) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} exceeds the ${maxLength}-character limit.`,
    );
  }
  if (value.includes('\u0000')) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} contains an unsupported null character.`,
    );
  }
  if (options.preserveWhitespace) {
    if (!value.trim()) {
      throw new BlueBubblesReceiptInboxValidationError(
        `${field} must contain non-whitespace content.`,
      );
    }
    return value;
  }
  const trimmed = value.trim();
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 31 || codePoint === 127;
  });
  if (trimmed !== value || hasControlCharacter) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} must be a bounded identifier without surrounding whitespace or control characters.`,
    );
  }
  return value;
}

function normalizeLimit(value: number | undefined): number {
  if (value == null) return 100;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new BlueBubblesReceiptInboxValidationError(
      `limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`,
    );
  }
  return value;
}

function normalizeDate(
  value: string | number | Date,
  field: string,
): { iso: string; epochMs: number } {
  let epochMs: number;
  if (value instanceof Date) {
    epochMs = value.getTime();
  } else if (typeof value === 'number') {
    epochMs = value > 10_000_000_000 ? value : value * 1_000;
  } else if (
    typeof value === 'string' &&
    value.length <= 128 &&
    value.trim() === value
  ) {
    if (/^-?\d+(?:\.\d+)?$/u.test(value)) {
      const numeric = Number(value);
      epochMs = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    } else {
      epochMs = Date.parse(value);
    }
  } else {
    epochMs = Number.NaN;
  }
  if (!Number.isFinite(epochMs)) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} must be a valid provider timestamp.`,
    );
  }
  const roundedEpochMs = Math.round(epochMs);
  let iso: string;
  try {
    iso = new Date(roundedEpochMs).toISOString();
  } catch (_error) {
    throw new BlueBubblesReceiptInboxValidationError(
      `${field} must be a valid provider timestamp.`,
    );
  }
  return { iso, epochMs: roundedEpochMs };
}

function validateDirectChatGuid(value: unknown): string {
  const chatGuid = requireBoundedString(
    value,
    'chatGuid',
    MAX_CHAT_GUID_LENGTH,
  );
  if (!/^[^;]+;-;[^;]+$/u.test(chatGuid)) {
    throw new BlueBubblesReceiptInboxValidationError(
      'chatGuid must identify a direct BlueBubbles chat.',
    );
  }
  return chatGuid;
}

function validateReceiptInput(input: BlueBubblesReceiptInput): {
  tempGuid: string;
  messageGuid: string;
  chatGuid: string;
  content: string;
  timestamp: string;
  providerTimestampMs: number;
  isFromMe: true;
} {
  if (!input || typeof input !== 'object') {
    throw new BlueBubblesReceiptInboxValidationError(
      'Receipt input must be an object.',
    );
  }
  if (input.isFromMe !== true) {
    throw new BlueBubblesReceiptInboxValidationError(
      'Only self-authored BlueBubbles receipts can enter this inbox.',
    );
  }
  const providerTimestamp = normalizeDate(input.timestamp, 'timestamp');
  return {
    tempGuid: requireBoundedString(
      input.tempGuid,
      'tempGuid',
      MAX_IDENTIFIER_LENGTH,
    ),
    messageGuid: requireBoundedString(
      input.messageGuid,
      'messageGuid',
      MAX_IDENTIFIER_LENGTH,
    ),
    chatGuid: validateDirectChatGuid(input.chatGuid),
    content: requireBoundedString(
      input.content,
      'content',
      MAX_CONTENT_LENGTH,
      { preserveWhitespace: true },
    ),
    timestamp: providerTimestamp.iso,
    providerTimestampMs: providerTimestamp.epochMs,
    isFromMe: true,
  };
}

function rowsMatchReceipt(
  row: ReceiptInboxRow,
  input: ReturnType<typeof validateReceiptInput>,
): boolean {
  return (
    row.temp_guid === input.tempGuid &&
    row.message_guid === input.messageGuid &&
    row.direct_chat_guid === input.chatGuid &&
    row.exact_content === input.content &&
    row.provider_timestamp === input.timestamp &&
    row.provider_timestamp_ms === input.providerTimestampMs &&
    row.is_from_me === 1
  );
}

function mapReceiptRow(row: ReceiptInboxRow): DurableBlueBubblesReceipt {
  return {
    sequence: row.inbox_sequence,
    receiptId: row.receipt_id,
    tempGuid: row.temp_guid,
    messageGuid: row.message_guid,
    chatGuid: row.direct_chat_guid,
    content: row.exact_content,
    timestamp: row.provider_timestamp,
    providerTimestampMs: row.provider_timestamp_ms,
    isFromMe: true,
    receivedAt: row.received_at,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function normalizeCanonicalScope(value: unknown): string {
  return requireBoundedString(
    value,
    'canonicalScope',
    MAX_CANONICAL_SCOPE_LENGTH,
  );
}

/**
 * Normalize only the representation differences already treated as equivalent
 * by the BlueBubbles ingress fingerprint. The resulting body is still matched
 * exactly; this API does not perform fuzzy or semantic deduplication.
 */
export function normalizeCanonicalSelfThreadIngressBody(body: string): string {
  const bounded = requireBoundedString(body, 'body', MAX_CONTENT_LENGTH, {
    preserveWhitespace: true,
  });
  return bounded
    .normalize('NFC')
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function hashNormalizedBody(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Bind the independently supervised writer and the main-process consumer to
 * the same durable queue and provider-facing path without exposing the local
 * database path through health responses.
 */
export function buildBlueBubblesReceiptInboxConfigIdentity(input: {
  databasePath: string;
  webhookPath: string;
}): string {
  const configuredDatabasePath = requireBoundedString(
    input.databasePath,
    'databasePath',
    16 * 1_024,
    { preserveWhitespace: true },
  );
  const databasePath =
    configuredDatabasePath === ':memory:'
      ? configuredDatabasePath
      : path.resolve(configuredDatabasePath);
  const webhookPath = requireBoundedString(
    input.webhookPath,
    'webhookPath',
    MAX_WEBHOOK_PATH_LENGTH,
  );
  if (
    !webhookPath.startsWith('/') ||
    webhookPath.includes('?') ||
    webhookPath.includes('#')
  ) {
    throw new BlueBubblesReceiptInboxValidationError(
      'webhookPath must be an absolute URL path without a query or fragment.',
    );
  }
  return createHash('sha256')
    .update('bluebubbles-receipt-inbox-config-v1\0', 'utf8')
    .update(databasePath, 'utf8')
    .update('\0', 'utf8')
    .update(webhookPath, 'utf8')
    .digest('hex');
}

function ensureParentDirectory(databasePath: string): void {
  if (databasePath === ':memory:') return;
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), {
    recursive: true,
    mode: 0o700,
  });
}

function initializeSchema(database: Database.Database): void {
  const migrate = database.transaction(() => {
    // Read the version only after BEGIN IMMEDIATE owns the writer lock. A
    // concurrently starting sidecar/main process then observes the completed
    // migration instead of racing stale table_info results.
    const version = Number(
      database.pragma('user_version', { simple: true }) || 0,
    );
    if (
      version !== 0 &&
      version !== 1 &&
      version !== RECEIPT_INBOX_SCHEMA_VERSION
    ) {
      throw new Error(
        `Unsupported BlueBubbles receipt inbox schema version ${version}.`,
      );
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS bluebubbles_receipt_inbox (
        inbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id TEXT NOT NULL UNIQUE,
        temp_guid TEXT NOT NULL UNIQUE,
        message_guid TEXT NOT NULL,
        direct_chat_guid TEXT NOT NULL,
        exact_content TEXT NOT NULL,
        provider_timestamp TEXT NOT NULL,
        provider_timestamp_ms INTEGER NOT NULL,
        is_from_me INTEGER NOT NULL CHECK (is_from_me = 1),
        received_at TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        lease_token TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        lease_expires_at_ms INTEGER,
        acknowledged_at TEXT,
        CHECK (
          (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_expires_at_ms IS NULL)
          OR
          (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at_ms IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS bluebubbles_receipt_pending_idx
        ON bluebubbles_receipt_inbox (
          acknowledged_at,
          lease_expires_at_ms,
          inbox_sequence
        );

      CREATE TABLE IF NOT EXISTS bluebubbles_canonical_ingress_claim (
        claim_id TEXT PRIMARY KEY,
        canonical_scope TEXT NOT NULL,
        owner_authored INTEGER NOT NULL CHECK (owner_authored IN (0, 1)),
        normalized_body_hash TEXT NOT NULL,
        normalized_exact_body TEXT NOT NULL,
        provider_timestamp TEXT NOT NULL,
        provider_timestamp_ms INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        claimed_at_ms INTEGER NOT NULL,
        processing_lease_token TEXT,
        processing_lease_expires_at TEXT,
        processing_lease_expires_at_ms INTEGER,
        accepted_at TEXT,
        CHECK (
          (processing_lease_token IS NULL AND processing_lease_expires_at IS NULL AND processing_lease_expires_at_ms IS NULL)
          OR
          (processing_lease_token IS NOT NULL AND processing_lease_expires_at IS NOT NULL AND processing_lease_expires_at_ms IS NOT NULL)
        )
      );

      CREATE INDEX IF NOT EXISTS bluebubbles_canonical_ingress_match_idx
        ON bluebubbles_canonical_ingress_claim (
          canonical_scope,
          owner_authored,
          normalized_body_hash,
          provider_timestamp_ms
        );
    `);

    if (version === 1) {
      const existingColumns = new Set(
        (
          database
            .prepare('PRAGMA table_info(bluebubbles_canonical_ingress_claim)')
            .all() as Array<{ name: string }>
        ).map((column) => column.name),
      );
      const additions = [
        ['processing_lease_token', 'TEXT'],
        ['processing_lease_expires_at', 'TEXT'],
        ['processing_lease_expires_at_ms', 'INTEGER'],
        ['accepted_at', 'TEXT'],
      ] as const;
      for (const [name, type] of additions) {
        if (!existingColumns.has(name)) {
          database.exec(
            `ALTER TABLE bluebubbles_canonical_ingress_claim ADD COLUMN ${name} ${type}`,
          );
        }
      }
    }
    database.pragma(`user_version = ${RECEIPT_INBOX_SCHEMA_VERSION}`);
  });
  migrate.immediate();
}

export class BlueBubblesReceiptInboxStore {
  private readonly database: Database.Database;

  private readonly databasePath: string;

  private closed = false;

  constructor(databasePath: string, options: { busyTimeoutMs?: number } = {}) {
    const normalizedPath = requireBoundedString(
      databasePath,
      'databasePath',
      16 * 1_024,
      { preserveWhitespace: true },
    );
    ensureParentDirectory(normalizedPath);
    const database = new Database(normalizedPath);
    this.database = database;
    this.databasePath = normalizedPath;
    try {
      const busyTimeoutMs =
        options.busyTimeoutMs == null
          ? DEFAULT_BUSY_TIMEOUT_MS
          : options.busyTimeoutMs;
      if (
        !Number.isInteger(busyTimeoutMs) ||
        busyTimeoutMs < 1 ||
        busyTimeoutMs > 60_000
      ) {
        throw new BlueBubblesReceiptInboxValidationError(
          'busyTimeoutMs must be an integer between 1 and 60000.',
        );
      }
      database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      database.pragma('foreign_keys = ON');
      database.pragma('journal_mode = WAL');
      database.pragma('synchronous = FULL');
      database.pragma('wal_autocheckpoint = 1');
      initializeSchema(database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  getConfigIdentity(webhookPath: string): string {
    this.assertOpen();
    return buildBlueBubblesReceiptInboxConfigIdentity({
      databasePath: this.databasePath,
      webhookPath,
    });
  }

  persistReceipt(
    input: BlueBubblesReceiptInput,
    receivedAt = new Date(),
  ): PersistBlueBubblesReceiptResult {
    this.assertOpen();
    const normalized = validateReceiptInput(input);
    const received = normalizeDate(receivedAt, 'receivedAt');
    const insert = this.database.prepare(`
      INSERT INTO bluebubbles_receipt_inbox (
        receipt_id,
        temp_guid,
        message_guid,
        direct_chat_guid,
        exact_content,
        provider_timestamp,
        provider_timestamp_ms,
        is_from_me,
        received_at,
        received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(temp_guid) DO NOTHING
    `);
    const select = this.database.prepare(`
      SELECT *
      FROM bluebubbles_receipt_inbox
      WHERE temp_guid = ?
    `);
    const persist = this.database.transaction(() => {
      const receiptId = randomUUID();
      const result = insert.run(
        receiptId,
        normalized.tempGuid,
        normalized.messageGuid,
        normalized.chatGuid,
        normalized.content,
        normalized.timestamp,
        normalized.providerTimestampMs,
        received.iso,
        received.epochMs,
      );
      const row = select.get(normalized.tempGuid) as
        | ReceiptInboxRow
        | undefined;
      if (!row) {
        throw new Error('BlueBubbles receipt commit did not produce a row.');
      }
      if (!rowsMatchReceipt(row, normalized)) {
        throw new BlueBubblesReceiptConflictError(
          'The provider correlation key is already bound to different receipt evidence.',
        );
      }
      return {
        receipt: mapReceiptRow(row),
        inserted: result.changes === 1,
      };
    });
    return persist.immediate();
  }

  listPendingReceipts(
    options: { limit?: number } = {},
  ): DurableBlueBubblesReceipt[] {
    this.assertOpen();
    const limit = normalizeLimit(options.limit);
    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM bluebubbles_receipt_inbox
          WHERE acknowledged_at IS NULL
          ORDER BY inbox_sequence ASC
          LIMIT ?
        `,
      )
      .all(limit) as ReceiptInboxRow[];
    return rows.map(mapReceiptRow);
  }

  leasePendingReceipts(
    input: LeasePendingReceiptsInput,
  ): LeasedBlueBubblesReceiptBatch {
    this.assertOpen();
    const consumerId = requireBoundedString(
      input.consumerId,
      'consumerId',
      MAX_IDENTIFIER_LENGTH,
    );
    const limit = normalizeLimit(input.limit);
    const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) {
      throw new BlueBubblesReceiptInboxValidationError(
        'leaseMs must be an integer between 100 and 3600000.',
      );
    }
    const now = normalizeDate(input.now || new Date(), 'now');
    const expires = normalizeDate(now.epochMs + leaseMs, 'leaseExpiresAt');
    const leaseToken = randomUUID();
    const selectAvailable = this.database.prepare(`
      SELECT receipt_id
      FROM bluebubbles_receipt_inbox
      WHERE acknowledged_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at_ms <= ?)
      ORDER BY inbox_sequence ASC
      LIMIT ?
    `);
    const leaseOne = this.database.prepare(`
      UPDATE bluebubbles_receipt_inbox
      SET lease_token = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          lease_expires_at_ms = ?
      WHERE receipt_id = ?
        AND acknowledged_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at_ms <= ?)
    `);
    const selectLeased = this.database.prepare(`
      SELECT *
      FROM bluebubbles_receipt_inbox
      WHERE lease_token = ?
      ORDER BY inbox_sequence ASC
    `);
    const lease = this.database.transaction(() => {
      const available = selectAvailable.all(now.epochMs, limit) as Array<{
        receipt_id: string;
      }>;
      for (const row of available) {
        const changed = leaseOne.run(
          leaseToken,
          consumerId,
          expires.iso,
          expires.epochMs,
          row.receipt_id,
          now.epochMs,
        );
        if (changed.changes !== 1) {
          throw new Error('Failed to atomically lease a pending receipt.');
        }
      }
      return (
        available.length === 0
          ? []
          : (selectLeased.all(leaseToken) as ReceiptInboxRow[])
      ).map(mapReceiptRow);
    });
    const receipts = lease.immediate();
    return {
      leaseToken: receipts.length > 0 ? leaseToken : null,
      consumerId,
      leaseExpiresAt: receipts.length > 0 ? expires.iso : null,
      receipts,
    };
  }

  /**
   * Drain means atomically move currently available rows into a durable lease.
   * Rows remain in SQLite until and after explicit acknowledgement.
   */
  drainPendingReceipts(
    input: LeasePendingReceiptsInput,
  ): LeasedBlueBubblesReceiptBatch {
    return this.leasePendingReceipts(input);
  }

  ackPendingReceipts(input: AckPendingReceiptsInput): number {
    this.assertOpen();
    const leaseToken = requireBoundedString(
      input.leaseToken,
      'leaseToken',
      MAX_IDENTIFIER_LENGTH,
    );
    if (
      !Array.isArray(input.receiptIds) ||
      input.receiptIds.length < 1 ||
      input.receiptIds.length > MAX_LIST_LIMIT
    ) {
      throw new BlueBubblesReceiptInboxValidationError(
        `receiptIds must contain between 1 and ${MAX_LIST_LIMIT} identifiers.`,
      );
    }
    const receiptIds = [
      ...new Set(
        input.receiptIds.map((receiptId) =>
          requireBoundedString(receiptId, 'receiptId', MAX_IDENTIFIER_LENGTH),
        ),
      ),
    ];
    const acknowledged = normalizeDate(
      input.acknowledgedAt || new Date(),
      'acknowledgedAt',
    );
    const select = this.database.prepare(`
      SELECT receipt_id
      FROM bluebubbles_receipt_inbox
      WHERE receipt_id = ?
        AND acknowledged_at IS NULL
        AND lease_token = ?
    `);
    const update = this.database.prepare(`
      UPDATE bluebubbles_receipt_inbox
      SET acknowledged_at = ?,
          lease_token = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          lease_expires_at_ms = NULL
      WHERE receipt_id = ?
        AND acknowledged_at IS NULL
        AND lease_token = ?
    `);
    const acknowledge = this.database.transaction(() => {
      for (const receiptId of receiptIds) {
        if (!select.get(receiptId, leaseToken)) {
          throw new BlueBubblesReceiptConflictError(
            'Receipt acknowledgement requires the current durable lease token.',
          );
        }
      }
      for (const receiptId of receiptIds) {
        const result = update.run(acknowledged.iso, receiptId, leaseToken);
        if (result.changes !== 1) {
          throw new Error('Failed to atomically acknowledge a leased receipt.');
        }
      }
      return receiptIds.length;
    });
    return acknowledge.immediate();
  }

  claimCanonicalSelfThreadIngress(
    input: CanonicalSelfThreadIngressClaimInput,
  ): CanonicalSelfThreadIngressClaim {
    this.assertOpen();
    if (typeof input.ownerAuthored !== 'boolean') {
      throw new BlueBubblesReceiptInboxValidationError(
        'ownerAuthored must be a boolean.',
      );
    }
    const canonicalScope = normalizeCanonicalScope(input.canonicalScope);
    const normalizedBody = normalizeCanonicalSelfThreadIngressBody(input.body);
    const normalizedBodyHash = hashNormalizedBody(normalizedBody);
    const providerTimestamp = normalizeDate(
      input.providerTimestamp,
      'providerTimestamp',
    );
    const claimedAt = normalizeDate(input.now || new Date(), 'now');
    const processingLeaseMs =
      input.processingLeaseMs ?? DEFAULT_INGRESS_PROCESSING_LEASE_MS;
    if (
      !Number.isInteger(processingLeaseMs) ||
      processingLeaseMs < 100 ||
      processingLeaseMs > 3_600_000
    ) {
      throw new BlueBubblesReceiptInboxValidationError(
        'processingLeaseMs must be an integer between 100 and 3600000.',
      );
    }
    const processingLeaseExpiresAt = normalizeDate(
      claimedAt.epochMs + processingLeaseMs,
      'processingLeaseExpiresAt',
    );
    const findMirror = this.database.prepare(`
      SELECT
        claim_id,
        canonical_scope,
        owner_authored,
        normalized_exact_body,
        provider_timestamp,
        provider_timestamp_ms,
        claimed_at,
        processing_lease_token,
        processing_lease_expires_at,
        processing_lease_expires_at_ms,
        accepted_at
      FROM bluebubbles_canonical_ingress_claim
      WHERE canonical_scope = ?
        AND owner_authored = ?
        AND normalized_body_hash = ?
        AND normalized_exact_body = ?
        AND provider_timestamp_ms BETWEEN ? AND ?
      ORDER BY
        ABS(provider_timestamp_ms - ?) ASC,
        claimed_at_ms ASC,
        claim_id ASC
      LIMIT 1
    `);
    const insert = this.database.prepare(`
      INSERT INTO bluebubbles_canonical_ingress_claim (
        claim_id,
        canonical_scope,
        owner_authored,
        normalized_body_hash,
        normalized_exact_body,
        provider_timestamp,
        provider_timestamp_ms,
        claimed_at,
        claimed_at_ms,
        processing_lease_token,
        processing_lease_expires_at,
        processing_lease_expires_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const resume = this.database.prepare(`
      UPDATE bluebubbles_canonical_ingress_claim
      SET processing_lease_token = ?,
          processing_lease_expires_at = ?,
          processing_lease_expires_at_ms = ?
      WHERE claim_id = ?
        AND accepted_at IS NULL
        AND (
          processing_lease_token IS NULL
          OR processing_lease_expires_at_ms IS NULL
          OR processing_lease_expires_at_ms <= ?
        )
    `);
    const claim = this.database.transaction(() => {
      const ownerAuthored = input.ownerAuthored ? 1 : 0;
      const existing = findMirror.get(
        canonicalScope,
        ownerAuthored,
        normalizedBodyHash,
        normalizedBody,
        providerTimestamp.epochMs - MIRRORED_INGRESS_TOLERANCE_MS,
        providerTimestamp.epochMs + MIRRORED_INGRESS_TOLERANCE_MS,
        providerTimestamp.epochMs,
      ) as IngressClaimRow | undefined;
      if (existing) {
        if (
          existing.accepted_at ||
          (existing.processing_lease_token &&
            existing.processing_lease_expires_at_ms != null &&
            existing.processing_lease_expires_at_ms > claimedAt.epochMs)
        ) {
          return {
            claimId: existing.claim_id,
            canonicalScope: existing.canonical_scope,
            ownerAuthored: existing.owner_authored === 1,
            normalizedBody: existing.normalized_exact_body,
            providerTimestamp: existing.provider_timestamp,
            providerTimestampMs: existing.provider_timestamp_ms,
            claimedAt: existing.claimed_at,
            processingLeaseToken: null,
            processingLeaseExpiresAt: existing.processing_lease_expires_at,
            acceptedAt: existing.accepted_at,
            disposition: 'mirror' as const,
            isNew: false,
            shouldProcess: false,
          };
        }
        const processingLeaseToken = randomUUID();
        const resumed = resume.run(
          processingLeaseToken,
          processingLeaseExpiresAt.iso,
          processingLeaseExpiresAt.epochMs,
          existing.claim_id,
          claimedAt.epochMs,
        );
        if (resumed.changes !== 1) {
          throw new Error(
            'Failed to atomically resume the durable ingress claim.',
          );
        }
        return {
          claimId: existing.claim_id,
          canonicalScope: existing.canonical_scope,
          ownerAuthored: existing.owner_authored === 1,
          normalizedBody: existing.normalized_exact_body,
          providerTimestamp: existing.provider_timestamp,
          providerTimestampMs: existing.provider_timestamp_ms,
          claimedAt: existing.claimed_at,
          processingLeaseToken,
          processingLeaseExpiresAt: processingLeaseExpiresAt.iso,
          acceptedAt: null,
          disposition: 'resumed' as const,
          isNew: false,
          shouldProcess: true,
        };
      }
      const claimId = randomUUID();
      const processingLeaseToken = randomUUID();
      insert.run(
        claimId,
        canonicalScope,
        ownerAuthored,
        normalizedBodyHash,
        normalizedBody,
        providerTimestamp.iso,
        providerTimestamp.epochMs,
        claimedAt.iso,
        claimedAt.epochMs,
        processingLeaseToken,
        processingLeaseExpiresAt.iso,
        processingLeaseExpiresAt.epochMs,
      );
      return {
        claimId,
        canonicalScope,
        ownerAuthored: input.ownerAuthored,
        normalizedBody,
        providerTimestamp: providerTimestamp.iso,
        providerTimestampMs: providerTimestamp.epochMs,
        claimedAt: claimedAt.iso,
        processingLeaseToken,
        processingLeaseExpiresAt: processingLeaseExpiresAt.iso,
        acceptedAt: null,
        disposition: 'claimed' as const,
        isNew: true,
        shouldProcess: true,
      };
    });
    // BEGIN IMMEDIATE serializes the range read and insert across processes.
    return claim.immediate();
  }

  /**
   * Resume only a claim that a real webhook already created. History recovery
   * must never insert a probe claim because that could suppress a concurrent
   * live delivery before the history path decides the row is read-only.
   */
  resumeCanonicalSelfThreadIngressIfExists(
    input: CanonicalSelfThreadIngressClaimInput,
  ): CanonicalSelfThreadIngressClaim | null {
    this.assertOpen();
    if (typeof input.ownerAuthored !== 'boolean') {
      throw new BlueBubblesReceiptInboxValidationError(
        'ownerAuthored must be a boolean.',
      );
    }
    const canonicalScope = normalizeCanonicalScope(input.canonicalScope);
    const normalizedBody = normalizeCanonicalSelfThreadIngressBody(input.body);
    const normalizedBodyHash = hashNormalizedBody(normalizedBody);
    const providerTimestamp = normalizeDate(
      input.providerTimestamp,
      'providerTimestamp',
    );
    const claimedAt = normalizeDate(input.now || new Date(), 'now');
    const processingLeaseMs =
      input.processingLeaseMs ?? DEFAULT_INGRESS_PROCESSING_LEASE_MS;
    if (
      !Number.isInteger(processingLeaseMs) ||
      processingLeaseMs < 100 ||
      processingLeaseMs > 3_600_000
    ) {
      throw new BlueBubblesReceiptInboxValidationError(
        'processingLeaseMs must be an integer between 100 and 3600000.',
      );
    }
    const processingLeaseExpiresAt = normalizeDate(
      claimedAt.epochMs + processingLeaseMs,
      'processingLeaseExpiresAt',
    );
    const findMirror = this.database.prepare(`
      SELECT
        claim_id,
        canonical_scope,
        owner_authored,
        normalized_exact_body,
        provider_timestamp,
        provider_timestamp_ms,
        claimed_at,
        processing_lease_token,
        processing_lease_expires_at,
        processing_lease_expires_at_ms,
        accepted_at
      FROM bluebubbles_canonical_ingress_claim
      WHERE canonical_scope = ?
        AND owner_authored = ?
        AND normalized_body_hash = ?
        AND normalized_exact_body = ?
        AND provider_timestamp_ms BETWEEN ? AND ?
      ORDER BY
        ABS(provider_timestamp_ms - ?) ASC,
        claimed_at_ms ASC,
        claim_id ASC
      LIMIT 1
    `);
    const resume = this.database.prepare(`
      UPDATE bluebubbles_canonical_ingress_claim
      SET processing_lease_token = ?,
          processing_lease_expires_at = ?,
          processing_lease_expires_at_ms = ?
      WHERE claim_id = ?
        AND accepted_at IS NULL
        AND (
          processing_lease_token IS NULL
          OR processing_lease_expires_at_ms IS NULL
          OR processing_lease_expires_at_ms <= ?
        )
    `);
    const recover = this.database.transaction(() => {
      const existing = findMirror.get(
        canonicalScope,
        input.ownerAuthored ? 1 : 0,
        normalizedBodyHash,
        normalizedBody,
        providerTimestamp.epochMs - MIRRORED_INGRESS_TOLERANCE_MS,
        providerTimestamp.epochMs + MIRRORED_INGRESS_TOLERANCE_MS,
        providerTimestamp.epochMs,
      ) as IngressClaimRow | undefined;
      if (!existing) return null;
      if (
        existing.accepted_at ||
        (existing.processing_lease_token &&
          existing.processing_lease_expires_at_ms != null &&
          existing.processing_lease_expires_at_ms > claimedAt.epochMs)
      ) {
        return {
          claimId: existing.claim_id,
          canonicalScope: existing.canonical_scope,
          ownerAuthored: existing.owner_authored === 1,
          normalizedBody: existing.normalized_exact_body,
          providerTimestamp: existing.provider_timestamp,
          providerTimestampMs: existing.provider_timestamp_ms,
          claimedAt: existing.claimed_at,
          processingLeaseToken: null,
          processingLeaseExpiresAt: existing.processing_lease_expires_at,
          acceptedAt: existing.accepted_at,
          disposition: 'mirror' as const,
          isNew: false,
          shouldProcess: false,
        };
      }
      const processingLeaseToken = randomUUID();
      const resumed = resume.run(
        processingLeaseToken,
        processingLeaseExpiresAt.iso,
        processingLeaseExpiresAt.epochMs,
        existing.claim_id,
        claimedAt.epochMs,
      );
      if (resumed.changes !== 1) {
        throw new Error(
          'Failed to atomically resume the existing durable ingress claim.',
        );
      }
      return {
        claimId: existing.claim_id,
        canonicalScope: existing.canonical_scope,
        ownerAuthored: existing.owner_authored === 1,
        normalizedBody: existing.normalized_exact_body,
        providerTimestamp: existing.provider_timestamp,
        providerTimestampMs: existing.provider_timestamp_ms,
        claimedAt: existing.claimed_at,
        processingLeaseToken,
        processingLeaseExpiresAt: processingLeaseExpiresAt.iso,
        acceptedAt: null,
        disposition: 'resumed' as const,
        isNew: false,
        shouldProcess: true,
      };
    });
    return recover.immediate();
  }

  acceptCanonicalSelfThreadIngressClaim(
    input: AcceptCanonicalSelfThreadIngressClaimInput,
  ): boolean {
    this.assertOpen();
    const claimId = requireBoundedString(
      input.claimId,
      'claimId',
      MAX_IDENTIFIER_LENGTH,
    );
    const processingLeaseToken = requireBoundedString(
      input.processingLeaseToken,
      'processingLeaseToken',
      MAX_IDENTIFIER_LENGTH,
    );
    const acceptedAt = normalizeDate(
      input.acceptedAt || new Date(),
      'acceptedAt',
    );
    const result = this.database
      .prepare(
        `
          UPDATE bluebubbles_canonical_ingress_claim
          SET accepted_at = ?,
              processing_lease_token = NULL,
              processing_lease_expires_at = NULL,
              processing_lease_expires_at_ms = NULL
          WHERE claim_id = ?
            AND accepted_at IS NULL
            AND processing_lease_token = ?
        `,
      )
      .run(acceptedAt.iso, claimId, processingLeaseToken);
    return result.changes === 1;
  }

  /**
   * Permanently suppress a claim that recovery determined must never be
   * routed. `accepted_at` is the schema's existing terminal tombstone; this
   * path intentionally does not imply that a main-store callback ran.
   *
   * Unlike normal acceptance, stale recovery may encounter an active lease
   * left by another crashed process. Matching the immutable `claimed_at`
   * value lets it terminalize that exact old row without waiting or allowing
   * a later lease resume to turn it back into an actionable command.
   */
  ignoreCanonicalSelfThreadIngressClaim(
    input: IgnoreCanonicalSelfThreadIngressClaimInput,
  ): boolean {
    this.assertOpen();
    const claimId = requireBoundedString(
      input.claimId,
      'claimId',
      MAX_IDENTIFIER_LENGTH,
    );
    const claimedAt = normalizeDate(input.claimedAt, 'claimedAt');
    const ignoredAt = normalizeDate(input.ignoredAt || new Date(), 'ignoredAt');
    const ignore = this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `
            SELECT claimed_at, accepted_at
            FROM bluebubbles_canonical_ingress_claim
            WHERE claim_id = ?
            LIMIT 1
          `,
        )
        .get(claimId) as
        | { claimed_at: string; accepted_at: string | null }
        | undefined;
      if (!existing || existing.claimed_at !== claimedAt.iso) return false;
      if (existing.accepted_at) return true;
      const result = this.database
        .prepare(
          `
            UPDATE bluebubbles_canonical_ingress_claim
            SET accepted_at = ?,
                processing_lease_token = NULL,
                processing_lease_expires_at = NULL,
                processing_lease_expires_at_ms = NULL
            WHERE claim_id = ?
              AND claimed_at = ?
              AND accepted_at IS NULL
          `,
        )
        .run(ignoredAt.iso, claimId, claimedAt.iso);
      return result.changes === 1;
    });
    return ignore.immediate();
  }

  releaseCanonicalSelfThreadIngressClaim(
    input: ReleaseCanonicalSelfThreadIngressClaimInput,
  ): boolean {
    this.assertOpen();
    const claimId = requireBoundedString(
      input.claimId,
      'claimId',
      MAX_IDENTIFIER_LENGTH,
    );
    const processingLeaseToken = requireBoundedString(
      input.processingLeaseToken,
      'processingLeaseToken',
      MAX_IDENTIFIER_LENGTH,
    );
    const result = this.database
      .prepare(
        `
          UPDATE bluebubbles_canonical_ingress_claim
          SET processing_lease_token = NULL,
              processing_lease_expires_at = NULL,
              processing_lease_expires_at_ms = NULL
          WHERE claim_id = ?
            AND accepted_at IS NULL
            AND processing_lease_token = ?
        `,
      )
      .run(claimId, processingLeaseToken);
    return result.changes === 1;
  }

  /** Read-only liveness check used by the independently supervised service. */
  getHealth(): BlueBubblesReceiptInboxStoreHealth {
    this.assertOpen();
    const row = this.database.prepare('SELECT 1 AS healthy').get() as
      | { healthy: number }
      | undefined;
    const schemaVersion = Number(
      this.database.pragma('user_version', { simple: true }) || 0,
    );
    if (row?.healthy !== 1 || schemaVersion !== RECEIPT_INBOX_SCHEMA_VERSION) {
      throw new Error('BlueBubbles receipt inbox health check failed.');
    }
    return { status: 'ok', schemaVersion };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('BlueBubbles receipt inbox store is closed.');
    }
  }
}
