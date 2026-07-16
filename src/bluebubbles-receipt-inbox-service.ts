import { createHash, timingSafeEqual } from 'node:crypto';
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { readBuildProvenance } from './build-provenance.js';

import {
  BlueBubblesReceiptConflictError,
  type BlueBubblesReceiptInput,
  type BlueBubblesReceiptInboxStore,
  BlueBubblesReceiptInboxValidationError,
  type PersistBlueBubblesReceiptResult,
} from './bluebubbles-receipt-inbox-store.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4306;
const DEFAULT_WEBHOOK_PATH = '/bluebubbles/receipt-inbox';
const DEFAULT_HEALTH_PATH = '/health';
const DEFAULT_MAX_PAYLOAD_BYTES = 128 * 1_024;
const MAX_WEBHOOK_SECRET_LENGTH = 4_096;
const MAX_CHAT_ARRAY_ITEMS = 8;
export const BLUEBUBBLES_RECEIPT_INBOX_SERVICE_KIND =
  'bluebubbles-receipt-inbox';
export const BLUEBUBBLES_RECEIPT_INBOX_PROTOCOL_VERSION = 2;
const BLUEBUBBLES_RECEIPT_INBOX_PROCESS_STARTED_AT = new Date().toISOString();

export function resolveBlueBubblesReceiptInboxBuildId(
  projectRoot = process.cwd(),
): string {
  const manifest = readBuildProvenance(projectRoot);
  return (
    process.env.ANDREA_BUILD_ID?.trim() ||
    (manifest ? `${manifest.gitCommit}:${manifest.artifactSha256}` : null) ||
    process.env.npm_package_version?.trim() ||
    'development-source'
  );
}

type UnknownRecord = Record<string, unknown>;

export interface BlueBubblesReceiptInboxServiceOptions {
  store: BlueBubblesReceiptInboxStore;
  webhookSecret: string;
  host?: string;
  port?: number;
  webhookPath?: string;
  healthPath?: string;
  maxPayloadBytes?: number;
  /** Test/supervision seam that runs only after SQLite has committed. */
  onPersistedBeforeResponse?: (
    result: PersistBlueBubblesReceiptResult,
  ) => void | Promise<void>;
}

export interface BlueBubblesReceiptInboxServiceAddress {
  host: string;
  port: number;
  webhookPath: string;
  url: string;
  healthPath: string;
  healthUrl: string;
}

export class BlueBubblesReceiptPayloadError extends Error {
  readonly code = 'BLUEBUBBLES_RECEIPT_PAYLOAD_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'BlueBubblesReceiptPayloadError';
  }
}

class HttpReceiptError extends Error {
  constructor(
    readonly statusCode: number,
    readonly responseCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpReceiptError';
  }
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function selectConsistentString(field: string, candidates: unknown[]): string {
  const present = candidates.filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (present.length === 0) {
    throw new BlueBubblesReceiptPayloadError(`${field} is required.`);
  }
  if (present.some((candidate) => typeof candidate !== 'string')) {
    throw new BlueBubblesReceiptPayloadError(`${field} must be a string.`);
  }
  const strings = present as string[];
  if (new Set(strings).size !== 1) {
    throw new BlueBubblesReceiptPayloadError(
      `${field} contains conflicting values.`,
    );
  }
  return strings[0]!;
}

function selectProviderTimestamp(candidates: unknown[]): string | number {
  const value = candidates.find(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BlueBubblesReceiptPayloadError(
      'timestamp must be a string or number.',
    );
  }
  return value;
}

function selectIsFromMe(candidates: unknown[]): true {
  const present = candidates.filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (
    present.length === 0 ||
    present.some((candidate) => typeof candidate !== 'boolean') ||
    new Set(present).size !== 1 ||
    present[0] !== true
  ) {
    throw new BlueBubblesReceiptPayloadError(
      'Receipt event must be consistently self-authored.',
    );
  }
  return true;
}

function selectChat(
  payload: UnknownRecord,
  data: UnknownRecord,
): UnknownRecord {
  const message = asRecord(data.message);
  const arrays = [data.chats, message.chats, payload.chats].filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  for (const candidate of arrays) {
    if (!Array.isArray(candidate) || candidate.length > MAX_CHAT_ARRAY_ITEMS) {
      throw new BlueBubblesReceiptPayloadError(
        `chats must be an array with no more than ${MAX_CHAT_ARRAY_ITEMS} items.`,
      );
    }
  }
  const firstArray = arrays.find(
    (candidate): candidate is unknown[] =>
      Array.isArray(candidate) && candidate.length > 0,
  );
  const records = [
    firstArray ? asRecord(firstArray[0]) : {},
    asRecord(message.chat),
    asRecord(data.chat),
    asRecord(payload.chat),
  ];
  return records.find((record) => Object.keys(record).length > 0) || {};
}

function isNewMessageEvent(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 64) return false;
  const normalized = value.trim().toLowerCase();
  return (
    /^new[-_. ]?message$/u.test(normalized) || normalized === 'message.new'
  );
}

/**
 * Accept the bounded BlueBubbles message shapes used by both webhook and
 * history responses. It intentionally returns only correlated, self-authored,
 * direct-chat text evidence; all other events are rejected by the inbox.
 */
export function parseBlueBubblesReceiptPayload(
  payload: unknown,
): BlueBubblesReceiptInput {
  const root = asRecord(payload);
  if (Object.keys(root).length === 0) {
    throw new BlueBubblesReceiptPayloadError('Payload must be a JSON object.');
  }
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const eventType = [root.type, root.event, data.type, data.event].find(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  if (!isNewMessageEvent(eventType)) {
    throw new BlueBubblesReceiptPayloadError(
      'Only new-message receipt events are accepted.',
    );
  }

  const chat = selectChat(root, data);
  const stringMessage = typeof data.message === 'string' ? data.message : null;
  return {
    tempGuid: selectConsistentString('tempGuid', [
      message.tempGuid,
      message.tempGUID,
      message.providerIdempotencyKey,
      message.provider_idempotency_key,
      data.tempGuid,
      data.tempGUID,
      data.providerIdempotencyKey,
      data.provider_idempotency_key,
      root.tempGuid,
      root.tempGUID,
      root.providerIdempotencyKey,
      root.provider_idempotency_key,
    ]),
    messageGuid: selectConsistentString('messageGuid', [
      message.guid,
      message.messageGuid,
      data.guid,
      data.messageGuid,
      root.messageGuid,
      root.guid,
    ]),
    chatGuid: selectConsistentString('chatGuid', [
      chat.guid,
      chat.chatGuid,
      data.chatGuid,
      root.chatGuid,
    ]),
    content: selectConsistentString('content', [
      message.text,
      message.body,
      data.text,
      stringMessage,
      root.text,
      root.body,
    ]),
    timestamp: selectProviderTimestamp([
      message.dateCreated,
      message.date,
      data.dateCreated,
      data.date,
      root.dateCreated,
      root.date,
    ]),
    isFromMe: selectIsFromMe([message.isFromMe, data.isFromMe, root.isFromMe]),
  };
}

function normalizeWebhookPath(value: string | undefined): string {
  const trimmed = value?.trim() || DEFAULT_WEBHOOK_PATH;
  if (
    !trimmed.startsWith('/') ||
    trimmed.length > 1_024 ||
    trimmed.includes('?') ||
    trimmed.includes('#')
  ) {
    throw new Error('BlueBubbles receipt inbox webhookPath is invalid.');
  }
  return trimmed;
}

function normalizeHealthPath(value: string | undefined): string {
  const normalized = normalizeWebhookPath(value || DEFAULT_HEALTH_PATH);
  if (normalized === '/') {
    throw new Error('BlueBubbles receipt inbox healthPath cannot be root.');
  }
  return normalized;
}

function normalizeWebhookSecret(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_WEBHOOK_SECRET_LENGTH
  ) {
    throw new Error(
      'BlueBubbles receipt inbox requires a configured webhook secret.',
    );
  }
  return value;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest();
  const rightHash = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftHash, rightHash);
}

function headerStrings(
  headers: IncomingHttpHeaders,
  name: keyof IncomingHttpHeaders,
): string[] {
  const value = headers[name];
  if (Array.isArray(value)) return value;
  return typeof value === 'string' ? [value] : [];
}

function presentedWebhookSecrets(
  requestUrl: URL,
  headers: IncomingHttpHeaders,
): string[] {
  const querySecrets = ['secret', 'token', 'guid'].flatMap((name) =>
    requestUrl.searchParams.getAll(name),
  );
  const directHeaders = headerStrings(headers, 'x-bluebubbles-webhook-secret');
  const authorization = headerStrings(headers, 'authorization').map((value) => {
    const match = value.match(/^Bearer[ \t]+(.+)$/iu);
    return match?.[1] || '\u0000invalid-authorization';
  });
  return [...querySecrets, ...directHeaders, ...authorization];
}

function verifyWebhookSecret(
  expected: string,
  requestUrl: URL,
  headers: IncomingHttpHeaders,
): boolean {
  const presented = presentedWebhookSecrets(requestUrl, headers);
  return (
    presented.length > 0 &&
    presented.every((candidate) => constantTimeEqual(candidate, expected))
  );
}

async function readBoundedJsonBody(
  req: IncomingMessage,
  maxPayloadBytes: number,
): Promise<unknown> {
  const advertisedLength = req.headers['content-length'];
  if (advertisedLength != null) {
    const parsedLength = Number(advertisedLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      throw new HttpReceiptError(
        400,
        'invalid_content_length',
        'Invalid Content-Length.',
      );
    }
    if (parsedLength > maxPayloadBytes) {
      throw new HttpReceiptError(
        413,
        'payload_too_large',
        'Receipt payload is too large.',
      );
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > maxPayloadBytes) {
      throw new HttpReceiptError(
        413,
        'payload_too_large',
        'Receipt payload is too large.',
      );
    }
    chunks.push(bytes);
  }
  if (totalBytes === 0) {
    throw new HttpReceiptError(400, 'empty_payload', 'Payload is required.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch (_error) {
    throw new HttpReceiptError(400, 'invalid_json', 'Payload is not JSON.');
  }
}

function writeJsonResponse(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function mapRequestError(error: unknown): HttpReceiptError {
  if (error instanceof HttpReceiptError) return error;
  if (
    error instanceof BlueBubblesReceiptPayloadError ||
    error instanceof BlueBubblesReceiptInboxValidationError
  ) {
    return new HttpReceiptError(
      422,
      'invalid_receipt',
      'Payload is not valid correlated BlueBubbles receipt evidence.',
    );
  }
  if (error instanceof BlueBubblesReceiptConflictError) {
    return new HttpReceiptError(
      409,
      'receipt_conflict',
      'Provider correlation key conflicts with durable receipt evidence.',
    );
  }
  return new HttpReceiptError(
    503,
    'receipt_persistence_failed',
    'Receipt persistence failed.',
  );
}

export class BlueBubblesReceiptInboxHttpService {
  private readonly store: BlueBubblesReceiptInboxStore;

  private readonly webhookSecret: string;

  private readonly host: string;

  private readonly port: number;

  private readonly webhookPath: string;

  private readonly healthPath: string;

  private readonly maxPayloadBytes: number;

  private readonly onPersistedBeforeResponse?: (
    result: PersistBlueBubblesReceiptResult,
  ) => void | Promise<void>;

  private server: Server | null = null;

  private activeAddress: BlueBubblesReceiptInboxServiceAddress | null = null;

  constructor(options: BlueBubblesReceiptInboxServiceOptions) {
    if (!options.store) {
      throw new Error('BlueBubbles receipt inbox requires a durable store.');
    }
    this.store = options.store;
    this.webhookSecret = normalizeWebhookSecret(options.webhookSecret);
    this.host = options.host?.trim() || DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.webhookPath = normalizeWebhookPath(options.webhookPath);
    this.healthPath = normalizeHealthPath(options.healthPath);
    if (this.healthPath === this.webhookPath) {
      throw new Error(
        'BlueBubbles receipt inbox healthPath must differ from webhookPath.',
      );
    }
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.onPersistedBeforeResponse = options.onPersistedBeforeResponse;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error('BlueBubbles receipt inbox port is invalid.');
    }
    if (
      !Number.isInteger(this.maxPayloadBytes) ||
      this.maxPayloadBytes < 1_024 ||
      this.maxPayloadBytes > 1024 * 1024
    ) {
      throw new Error(
        'BlueBubbles receipt inbox maxPayloadBytes must be between 1024 and 1048576.',
      );
    }
  }

  async start(): Promise<BlueBubblesReceiptInboxServiceAddress> {
    if (this.server) {
      throw new Error('BlueBubbles receipt inbox service is already started.');
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error: unknown) => {
        const mapped = mapRequestError(error);
        writeJsonResponse(res, mapped.statusCode, {
          error: mapped.responseCode,
        });
      });
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off('error', onError);
          reject(error);
        };
        server.once('error', onError);
        server.listen(this.port, this.host, () => {
          server.off('error', onError);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      throw error;
    }
    const address = server.address() as AddressInfo;
    const urlHost = this.host.includes(':') ? `[${this.host}]` : this.host;
    this.activeAddress = {
      host: this.host,
      port: address.port,
      webhookPath: this.webhookPath,
      url: `http://${urlHost}:${address.port}${this.webhookPath}`,
      healthPath: this.healthPath,
      healthUrl: `http://${urlHost}:${address.port}${this.healthPath}`,
    };
    return this.activeAddress;
  }

  getAddress(): BlueBubblesReceiptInboxServiceAddress | null {
    return this.activeAddress ? { ...this.activeAddress } : null;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.activeAddress = null;
    if (!server) return;
    server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url || '/', 'http://receipt-inbox.invalid');
    } catch (_error) {
      throw new HttpReceiptError(400, 'invalid_url', 'Invalid request URL.');
    }
    if (requestUrl.pathname === this.healthPath) {
      if (req.method !== 'GET') {
        writeJsonResponse(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (!verifyWebhookSecret(this.webhookSecret, requestUrl, req.headers)) {
        writeJsonResponse(res, 401, { error: 'unauthorized' });
        return;
      }
      writeJsonResponse(res, 200, {
        ...this.store.getHealth(),
        serviceKind: BLUEBUBBLES_RECEIPT_INBOX_SERVICE_KIND,
        protocolVersion: BLUEBUBBLES_RECEIPT_INBOX_PROTOCOL_VERSION,
        pid: process.pid,
        startedAt: BLUEBUBBLES_RECEIPT_INBOX_PROCESS_STARTED_AT,
        buildId: resolveBlueBubblesReceiptInboxBuildId(),
        webhookPath: this.webhookPath,
        configIdentity: this.store.getConfigIdentity(this.webhookPath),
      });
      return;
    }
    if (req.method !== 'POST') {
      writeJsonResponse(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (requestUrl.pathname !== this.webhookPath) {
      writeJsonResponse(res, 404, { error: 'not_found' });
      return;
    }
    if (!verifyWebhookSecret(this.webhookSecret, requestUrl, req.headers)) {
      writeJsonResponse(res, 401, { error: 'unauthorized' });
      return;
    }
    const contentType = String(req.headers['content-type'] || '')
      .split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      writeJsonResponse(res, 415, { error: 'json_required' });
      return;
    }

    const payload = await readBoundedJsonBody(req, this.maxPayloadBytes);
    const receiptInput = parseBlueBubblesReceiptPayload(payload);
    // better-sqlite3 commits synchronously with synchronous=FULL. Nothing is
    // written to the HTTP response until this durable transaction returns.
    const result = this.store.persistReceipt(receiptInput);
    await this.onPersistedBeforeResponse?.(result);
    writeJsonResponse(res, result.inserted ? 201 : 200, {
      status: result.inserted ? 'persisted' : 'duplicate',
      receiptId: result.receipt.receiptId,
      duplicate: !result.inserted,
    });
  }
}
