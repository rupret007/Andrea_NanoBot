import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
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

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function resolveBlueBubblesConfig(
  env = readEnvFile([
    'BLUEBUBBLES_ENABLED',
    'BLUEBUBBLES_BASE_URL',
    'BLUEBUBBLES_PASSWORD',
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
    webhookPath:
      process.env.BLUEBUBBLES_WEBHOOK_PATH ||
      env.BLUEBUBBLES_WEBHOOK_PATH ||
      '/bluebubbles/webhook',
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
  const configured = Boolean(config.baseUrl && config.password);
  return {
    name: 'bluebubbles',
    configured,
    state: !config.enabled
      ? 'stopped'
      : configured
        ? 'ready'
        : 'degraded',
    updatedAt: new Date().toISOString(),
    detail: !config.enabled
      ? 'BlueBubbles disabled'
      : configured
        ? config.sendEnabled
          ? 'BlueBubbles scaffold enabled with outbound sends allowed by config'
          : 'BlueBubbles scaffold enabled in receive-first mode'
        : 'BlueBubbles enabled but missing base URL or password',
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
      reply_to_id: firstString(message.replyToGuid) || undefined,
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

  constructor(
    private readonly config: BlueBubblesConfig,
    private readonly opts: ChannelOpts,
  ) {}

  async connect(): Promise<void> {
    this.connected = this.config.enabled;
    this.opts.onHealthUpdate?.(buildBlueBubblesHealthSnapshot(this.config));
  }

  async sendMessage(
    jid: string,
    _text: string,
    _options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    if (!this.config.sendEnabled) {
      throw new Error('BlueBubbles outbound send is disabled in this scaffold.');
    }
    throw new Error(
      `BlueBubbles outbound send is not wired yet for ${jid}. Finish the verified REST send path before enabling it.`,
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('bb:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.opts.onHealthUpdate?.(
      buildBlueBubblesHealthSnapshot(this.config, {
        state: 'stopped',
        detail: 'BlueBubbles channel disconnected',
      }),
    );
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
