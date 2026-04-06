import http, { type IncomingMessage, type Server, type ServerResponse } from 'http';

import { hasStoredMessage } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { buildBlueBubblesChatJid } from '../companion-conversation-binding.js';
import type {
  BlueBubblesChatRef,
  BlueBubblesConfig,
  BlueBubblesContactRef,
  BlueBubblesWebhookEvent,
  Channel,
  ChannelHealthSnapshot,
  NewMessage,
  SendMessageOptions,
  SendMessageResult,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DEFAULT_BLUEBUBBLES_HOST = '127.0.0.1';
const DEFAULT_BLUEBUBBLES_PORT = 4305;

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeWebhookPath(value: string | undefined): string {
  const trimmed = value?.trim() || '/bluebubbles/webhook';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeBlueBubblesReplyId(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.startsWith('bb:') ? normalized : `bb:${normalized}`;
}

export function buildBlueBubblesLinkedChatJid(
  config: Pick<BlueBubblesConfig, 'allowedChatGuid'>,
): string | null {
  return buildBlueBubblesChatJid(config.allowedChatGuid);
}

export function buildBlueBubblesWebhookUrl(
  config: Pick<BlueBubblesConfig, 'host' | 'port' | 'webhookPath' | 'webhookSecret'>,
): string {
  const url = new URL(`http://${config.host}:${config.port}${config.webhookPath}`);
  if (config.webhookSecret) {
    url.searchParams.set('secret', config.webhookSecret);
  }
  return url.toString();
}

export function resolveBlueBubblesConfig(
  env = readEnvFile([
    'BLUEBUBBLES_ENABLED',
    'BLUEBUBBLES_BASE_URL',
    'BLUEBUBBLES_PASSWORD',
    'BLUEBUBBLES_HOST',
    'BLUEBUBBLES_PORT',
    'BLUEBUBBLES_GROUP_FOLDER',
    'BLUEBUBBLES_ALLOWED_CHAT_GUID',
    'BLUEBUBBLES_WEBHOOK_PATH',
    'BLUEBUBBLES_WEBHOOK_SECRET',
    'BLUEBUBBLES_SEND_ENABLED',
  ]),
): BlueBubblesConfig {
  const enabled = parseBool(
    process.env.BLUEBUBBLES_ENABLED || env.BLUEBUBBLES_ENABLED,
    false,
  );
  return {
    enabled,
    baseUrl: normalizeBaseUrl(
      process.env.BLUEBUBBLES_BASE_URL || env.BLUEBUBBLES_BASE_URL,
    ),
    password:
      process.env.BLUEBUBBLES_PASSWORD || env.BLUEBUBBLES_PASSWORD || null,
    host:
      process.env.BLUEBUBBLES_HOST ||
      env.BLUEBUBBLES_HOST ||
      DEFAULT_BLUEBUBBLES_HOST,
    port: parsePort(
      process.env.BLUEBUBBLES_PORT || env.BLUEBUBBLES_PORT,
      DEFAULT_BLUEBUBBLES_PORT,
    ),
    groupFolder:
      process.env.BLUEBUBBLES_GROUP_FOLDER ||
      env.BLUEBUBBLES_GROUP_FOLDER ||
      'main',
    allowedChatGuid:
      process.env.BLUEBUBBLES_ALLOWED_CHAT_GUID ||
      env.BLUEBUBBLES_ALLOWED_CHAT_GUID ||
      null,
    webhookPath: normalizeWebhookPath(
      process.env.BLUEBUBBLES_WEBHOOK_PATH || env.BLUEBUBBLES_WEBHOOK_PATH,
    ),
    webhookSecret:
      process.env.BLUEBUBBLES_WEBHOOK_SECRET ||
      env.BLUEBUBBLES_WEBHOOK_SECRET ||
      null,
    sendEnabled: parseBool(
      process.env.BLUEBUBBLES_SEND_ENABLED || env.BLUEBUBBLES_SEND_ENABLED,
      false,
    ),
  };
}

export function buildBlueBubblesHealthSnapshot(
  config: BlueBubblesConfig,
  overrides: Partial<ChannelHealthSnapshot> = {},
): ChannelHealthSnapshot {
  const configured = Boolean(
    config.baseUrl && config.password && config.allowedChatGuid && config.groupFolder,
  );
  const defaultState = !config.enabled
    ? 'stopped'
    : !configured
      ? 'degraded'
      : config.sendEnabled
        ? 'ready'
        : 'degraded';
  const defaultDetail = !config.enabled
    ? 'BlueBubbles disabled'
    : !configured
      ? 'BlueBubbles enabled but missing base URL, password, or allowed chat link'
      : config.sendEnabled
        ? `BlueBubbles listener ready for ${buildBlueBubblesLinkedChatJid(config)}`
        : 'BlueBubbles listener is configured, but outbound reply-back is disabled';
  return {
    name: 'bluebubbles',
    configured,
    state: defaultState,
    updatedAt: new Date().toISOString(),
    detail: defaultDetail,
    ...overrides,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTimestamp(value: unknown, fallback = new Date()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallback.toISOString();
}

function parseBlueBubblesJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractBlueBubblesErrorText(status: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `BlueBubbles request failed with status ${status}`;
  }
  const parsed = parseBlueBubblesJson(trimmed);
  const record = asRecord(parsed);
  const nested = asRecord(record.data);
  return (
    firstString(
      record.error,
      record.message,
      nested.error,
      nested.message,
      trimmed,
    ) || `BlueBubbles request failed with status ${status}`
  );
}

function extractBlueBubblesReceiptId(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(root.message);
  const nestedMessage = asRecord(data.message);
  const messages = Array.isArray(data.messages)
    ? data.messages.map((item) => asRecord(item))
    : [];
  return (
    firstString(
      root.guid,
      root.messageGuid,
      root.id,
      data.guid,
      data.messageGuid,
      data.id,
      message.guid,
      nestedMessage.guid,
      messages[0]?.guid,
      messages[0]?.messageGuid,
      messages[0]?.id,
    ) || null
  );
}

function buildAuthSearchParams(password: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('guid', password);
  params.set('password', password);
  params.set('token', password);
  return params;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeResponse(
  res: ServerResponse,
  statusCode: number,
  body: string,
): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

export function normalizeBlueBubblesWebhookEvent(
  payload: unknown,
): BlueBubblesWebhookEvent {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const chat = asRecord(data.chat);

  return {
    type:
      firstString(root.type, root.event, data.type, data.event, 'unknown') ||
      'unknown',
    messageGuid: firstString(
      root.messageGuid,
      root.guid,
      data.guid,
      message.guid,
      message.messageGuid,
    ),
    chatGuid: firstString(root.chatGuid, data.chatGuid, chat.guid),
    data,
  };
}

export function normalizeBlueBubblesContactRef(
  payload: unknown,
): BlueBubblesContactRef {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const sender = asRecord(message.handle || message.sender);

  return {
    handle:
      firstString(
        sender.address,
        sender.handle,
        sender.id,
        message.handle,
        message.address,
        'unknown',
      ) || 'unknown',
    displayName: firstString(
      sender.displayName,
      sender.name,
      message.senderName,
      message.contactName,
    ),
    address: firstString(sender.address, message.address),
  };
}

export function normalizeBlueBubblesChatRef(
  payload: unknown,
): BlueBubblesChatRef {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const chat = asRecord(data.chat);
  const participants = Array.isArray(chat.participants)
    ? chat.participants
        .map((participant) => {
          const record = asRecord(participant);
          return firstString(record.address, record.handle, record.id);
        })
        .filter((value): value is string => Boolean(value))
    : [];

  return {
    chatGuid:
      firstString(root.chatGuid, data.chatGuid, chat.guid, chat.chatGuid) ||
      'unknown',
    displayName: firstString(chat.displayName, chat.name),
    isGroup:
      typeof chat.isGroup === 'boolean'
        ? chat.isGroup
        : participants.length > 1,
    participants,
  };
}

export function normalizeBlueBubblesIncomingMessage(
  payload: unknown,
  now = new Date(),
): { chatJid: string; message: NewMessage; chat: BlueBubblesChatRef } | null {
  const event = normalizeBlueBubblesWebhookEvent(payload);
  if (!/new.?message/i.test(event.type) && event.type !== 'message.new') {
    return null;
  }

  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const text = firstString(
    message.text,
    message.body,
    data.text,
    data.message,
    root.text,
  );
  if (!text) return null;

  const chat = normalizeBlueBubblesChatRef(payload);
  const contact = normalizeBlueBubblesContactRef(payload);
  const messageGuid =
    event.messageGuid || `${chat.chatGuid}:${normalizeTimestamp(message.date, now)}`;

  return {
    chatJid: `bb:${chat.chatGuid}`,
    chat,
    message: {
      id: `bb:${messageGuid}`,
      chat_jid: `bb:${chat.chatGuid}`,
      sender: `bb:${contact.handle}`,
      sender_name: contact.displayName || contact.handle,
      content: text,
      timestamp: normalizeTimestamp(
        message.dateCreated || message.date || root.dateCreated,
        now,
      ),
      is_from_me: Boolean(message.isFromMe),
      is_bot_message: false,
      reply_to_id: normalizeBlueBubblesReplyId(
        firstString(message.replyToGuid, data.replyToGuid, root.replyToGuid),
      ),
    },
  };
}

export function createBlueBubblesWebhookAdapter(opts: {
  onMessage: ChannelOpts['onMessage'];
  onChatMetadata: ChannelOpts['onChatMetadata'];
}) {
  return async (payload: unknown): Promise<NewMessage | null> => {
    const normalized = normalizeBlueBubblesIncomingMessage(payload);
    if (!normalized) return null;

    const timestamp = normalized.message.timestamp;
    await opts.onChatMetadata(
      normalized.chatJid,
      timestamp,
      normalized.chat.displayName || normalized.chat.chatGuid,
      'bluebubbles',
      normalized.chat.isGroup,
    );
    await opts.onMessage(normalized.chatJid, normalized.message);
    return normalized.message;
  };
}

export class BlueBubblesChannel implements Channel {
  readonly name = 'bluebubbles';

  private connected = false;

  private server?: Server;

  private activePort: number;

  private lastReadyAt: string | null = null;

  private lastInboundObservedAt: string | null = null;

  private lastOutboundResult: string | null = null;

  private lastErrorText: string | null = null;

  private readonly inflightMessageIds = new Set<string>();

  constructor(
    private readonly config: BlueBubblesConfig,
    private readonly opts: ChannelOpts,
  ) {
    this.activePort = config.port;
  }

  private emitHealth(overrides: Partial<ChannelHealthSnapshot> = {}): void {
    const configured = Boolean(
      this.config.baseUrl &&
        this.config.password &&
        this.config.allowedChatGuid &&
        this.config.groupFolder,
    );
    const readyForTraffic = configured && this.config.sendEnabled;
    const detailParts = [
      this.connected
        ? `listener ${this.config.host}:${this.activePort}${this.config.webhookPath}`
        : 'listener stopped',
      this.config.allowedChatGuid
        ? `linked chat ${buildBlueBubblesLinkedChatJid(this.config)}`
        : 'linked chat missing',
      this.lastInboundObservedAt
        ? `last inbound ${this.lastInboundObservedAt}`
        : 'no inbound observed yet',
      this.lastOutboundResult
        ? `last outbound ${this.lastOutboundResult}`
        : this.config.sendEnabled
          ? 'no outbound sent yet'
          : 'outbound disabled',
    ];
    this.opts.onHealthUpdate?.(
      buildBlueBubblesHealthSnapshot(this.config, {
        state: !this.config.enabled
          ? 'stopped'
          : this.connected && readyForTraffic
            ? 'ready'
            : this.connected
              ? 'degraded'
              : 'starting',
        updatedAt: new Date().toISOString(),
        lastReadyAt: this.lastReadyAt,
        lastError: this.lastErrorText,
        detail: detailParts.join(' | '),
        ...overrides,
      }),
    );
  }

  private isReadyForTraffic(): boolean {
    return Boolean(
      this.connected &&
        this.config.enabled &&
        this.config.baseUrl &&
        this.config.password &&
        this.config.allowedChatGuid &&
        this.config.sendEnabled,
    );
  }

  private verifyWebhookSecret(reqUrl: URL): boolean {
    if (!this.config.webhookSecret) {
      return true;
    }
    const incoming =
      reqUrl.searchParams.get('secret') ||
      reqUrl.searchParams.get('token') ||
      reqUrl.searchParams.get('guid');
    return incoming === this.config.webhookSecret;
  }

  private async handleWebhookRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const reqUrl = new URL(
      req.url || this.config.webhookPath,
      `http://${req.headers.host || `${this.config.host}:${this.activePort}`}`,
    );
    if (req.method !== 'POST') {
      writeResponse(res, 405, 'Method Not Allowed');
      return;
    }
    if (reqUrl.pathname !== this.config.webhookPath) {
      writeResponse(res, 404, 'Not Found');
      return;
    }
    if (!this.verifyWebhookSecret(reqUrl)) {
      this.lastErrorText = 'BlueBubbles webhook secret mismatch';
      this.emitHealth({ state: 'degraded' });
      writeResponse(res, 401, 'Unauthorized');
      return;
    }
    if (!this.isReadyForTraffic()) {
      writeResponse(res, 503, 'BlueBubbles channel is not ready');
      return;
    }
    if (!String(req.headers['content-type'] || '').includes('application/json')) {
      writeResponse(res, 400, 'BlueBubbles webhook requires application/json');
      return;
    }

    const rawBody = await readRequestBody(req);
    const payload = parseBlueBubblesJson(rawBody);
    if (!payload) {
      writeResponse(res, 400, 'Invalid JSON');
      return;
    }

    const event = normalizeBlueBubblesWebhookEvent(payload);
    if (!/new.?message/i.test(event.type) && event.type !== 'message.new') {
      writeResponse(res, 202, 'Ignored event');
      return;
    }

    const normalized = normalizeBlueBubblesIncomingMessage(payload);
    if (!normalized) {
      writeResponse(res, 400, 'Malformed BlueBubbles message payload');
      return;
    }
    if (normalized.chat.chatGuid !== this.config.allowedChatGuid) {
      logger.info(
        {
          expectedChatGuid: this.config.allowedChatGuid,
          receivedChatGuid: normalized.chat.chatGuid,
        },
        'Ignoring BlueBubbles message from an unlinked chat',
      );
      writeResponse(res, 202, 'Ignored unlinked chat');
      return;
    }
    if (normalized.message.is_from_me) {
      writeResponse(res, 202, 'Ignored outgoing message');
      return;
    }
    if (
      this.inflightMessageIds.has(normalized.message.id) ||
      hasStoredMessage(normalized.chatJid, normalized.message.id)
    ) {
      writeResponse(res, 202, 'Ignored duplicate delivery');
      return;
    }

    this.inflightMessageIds.add(normalized.message.id);
    try {
      await this.opts.onChatMetadata(
        normalized.chatJid,
        normalized.message.timestamp,
        normalized.chat.displayName || normalized.chat.chatGuid,
        'bluebubbles',
        normalized.chat.isGroup,
      );
      await this.opts.onMessage(normalized.chatJid, normalized.message);
      this.lastInboundObservedAt = normalized.message.timestamp;
      this.lastErrorText = null;
      if (!this.lastReadyAt) {
        this.lastReadyAt = new Date().toISOString();
      }
      this.emitHealth();
      writeResponse(res, 200, 'OK');
    } catch (error) {
      this.lastErrorText =
        error instanceof Error ? error.message : 'Unknown BlueBubbles ingress error';
      this.emitHealth({ state: 'degraded' });
      writeResponse(res, 500, this.lastErrorText);
    } finally {
      this.inflightMessageIds.delete(normalized.message.id);
    }
  }

  private async postBlueBubblesText(
    text: string,
    replyToGuid?: string,
  ): Promise<SendMessageResult> {
    if (!this.config.baseUrl || !this.config.password || !this.config.allowedChatGuid) {
      throw new Error('BlueBubbles transport is missing base URL, password, or linked chat');
    }
    const url = new URL('/api/v1/message/text', this.config.baseUrl);
    for (const [key, value] of buildAuthSearchParams(this.config.password).entries()) {
      url.searchParams.set(key, value);
    }

    const body: Record<string, unknown> = {
      chatGuid: this.config.allowedChatGuid,
      text,
      method: 'private-api',
    };
    if (replyToGuid) {
      body.replyToGuid = replyToGuid;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(extractBlueBubblesErrorText(response.status, responseText));
    }
    const parsed = parseBlueBubblesJson(responseText);
    const receiptId = extractBlueBubblesReceiptId(parsed);
    if (!receiptId) {
      throw new Error('BlueBubbles did not return a delivery receipt.');
    }
    return {
      platformMessageId: `bb:${receiptId}`,
    };
  }

  private async sendBlueBubblesReply(
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    const replyToGuid = options?.replyToMessageId?.startsWith('bb:')
      ? options.replyToMessageId.slice(3)
      : undefined;
    if (!replyToGuid) {
      return this.postBlueBubblesText(text);
    }

    try {
      return await this.postBlueBubblesText(text, replyToGuid);
    } catch (error) {
      logger.info(
        { err: error, replyToGuid },
        'BlueBubbles reply threading was rejected, retrying without reply metadata',
      );
      return this.postBlueBubblesText(text);
    }
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      this.emitHealth({ state: 'stopped' });
      return;
    }
    this.server = http.createServer((req, res) => {
      this.handleWebhookRequest(req, res).catch((error) => {
        this.lastErrorText =
          error instanceof Error ? error.message : 'Unknown BlueBubbles listener error';
        this.emitHealth({ state: 'degraded' });
        writeResponse(res, 500, this.lastErrorText);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('error', onError);
        reject(error);
      };
      this.server?.once('error', onError);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off('error', onError);
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.activePort = address.port;
        }
        this.connected = true;
        this.lastReadyAt = new Date().toISOString();
        this.lastErrorText = null;
        this.emitHealth();
        resolve();
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    if (!this.connected) {
      throw new Error('BlueBubbles channel is not connected.');
    }
    if (!this.config.sendEnabled) {
      throw new Error('BlueBubbles outbound send is disabled.');
    }
    const linkedChatJid = buildBlueBubblesLinkedChatJid(this.config);
    if (!linkedChatJid) {
      throw new Error('BlueBubbles linked chat is not configured.');
    }
    if (jid !== linkedChatJid) {
      throw new Error(
        `BlueBubbles V1 only supports reply-back to the linked companion chat (${linkedChatJid}).`,
      );
    }

    try {
      const result = await this.sendBlueBubblesReply(text, options);
      this.lastOutboundResult = result.platformMessageId || 'sent without message id';
      this.lastErrorText = null;
      this.emitHealth();
      return result;
    } catch (error) {
      this.lastErrorText =
        error instanceof Error ? error.message : 'Unknown BlueBubbles send error';
      this.emitHealth({ state: 'degraded' });
      throw error;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('bb:');
  }

  getWebhookUrl(): string {
    return buildBlueBubblesWebhookUrl({
      host: this.config.host,
      port: this.activePort,
      webhookPath: this.config.webhookPath,
      webhookSecret: this.config.webhookSecret,
    });
  }

  getLinkedChatJid(): string | null {
    return buildBlueBubblesLinkedChatJid(this.config);
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch((error) => {
        logger.warn({ err: error }, 'Failed to close BlueBubbles listener cleanly');
      });
      this.server = undefined;
    }
    this.connected = false;
    this.emitHealth({
      state: 'stopped',
      detail: 'BlueBubbles channel disconnected',
    });
  }
}

registerChannel('bluebubbles', (opts: ChannelOpts) => {
  const config = resolveBlueBubblesConfig();
  if (!config.enabled) {
    logger.debug('BlueBubbles channel not registered because it is disabled');
    return null;
  }
  return new BlueBubblesChannel(config, opts);
});
