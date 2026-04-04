import https from 'https';

import { Api, Bot, InlineKeyboard } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  ChannelSendReceipt,
  Channel,
  ChannelHealthSnapshot,
  ChannelInlineAction,
  OnChatMetadata,
  OnInboundMessage,
  ReplyMessageRef,
  RegisteredGroup,
  SendMessageOptions,
  SendMessageResult,
} from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onRegisterMainChat?: (
    chatJid: string,
    chatName: string,
    channel: string,
  ) => Promise<{ ok: boolean; message: string }>;
  onHealthUpdate?: (snapshot: ChannelHealthSnapshot) => void;
  onRoundtripActivity?: (event: {
    kind: 'organic_success';
    chatJid: string;
    observedAt: string;
    detail: string;
  }) => void;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeTelegramMarkdownText(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) =>
      /^`[^`\n]+`$/.test(part) ? part : part.replace(/(?<!\\)_/g, '\\_'),
    )
    .join('');
}

export function extractTelegramLeadingCommand(
  text: string,
  botUsername?: string,
): string | null {
  let normalized = text.trim();
  if (!normalized) return null;

  const username = botUsername?.trim().toLowerCase();
  if (username) {
    const mentionPattern = new RegExp(`^@${escapeRegExp(username)}\\b`, 'i');
    const mentionMatch = normalized.match(mentionPattern);
    if (mentionMatch) {
      normalized = normalized.slice(mentionMatch[0].length).trimStart();
    }
  }

  if (!normalized.startsWith('/')) return null;

  const commandToken = normalized.slice(1).split(/\s+/)[0];
  if (!commandToken) return null;

  const [commandName, commandTarget] = commandToken.split('@');
  if (!commandName) return null;

  if (commandTarget && username && commandTarget.toLowerCase() !== username) {
    return null;
  }

  return commandName.toLowerCase();
}

export function buildTelegramHelpText(assistantName = ASSISTANT_NAME): string {
  return [
    buildTelegramWelcomeText(assistantName),
    '',
    buildTelegramCommandsText(),
    '',
    buildTelegramFeaturesText(assistantName),
  ].join('\n');
}

export function buildTelegramWelcomeText(
  assistantName = ASSISTANT_NAME,
): string {
  return [
    `*Welcome to ${assistantName}*`,
    '',
    '- Start with a normal request in plain language.',
    '- In a direct chat: send normal messages or slash commands.',
    '- In a group: mention my Telegram username when you want me to act.',
    '- First-time Telegram setup: DM me and run `/registermain`.',
    '- Use `/commands` for the safe command list and `/features` for the short capability guide, including Andrea’s deeper operator work lanes.',
    '',
    '*Quick Start*',
    "- `What's the meaning of life?`",
    '- `Remind me tomorrow at 3pm to call Sam`',
    '- `Summarize my tasks for today`',
  ].join('\n');
}

export function buildTelegramCommandsText(): string {
  return [
    '*Commands*',
    '',
    '- `/start` - show the quick-start welcome message',
    '- `/help` - show the full guide',
    '- `/commands` - show the command reference',
    '- `/features` - show capability overview',
    '- `/ping` - check bot health',
    '- `/chatid` - show chat ID and chat type',
    '- `/registermain` - bootstrap main control chat (DM only)',
    '- `/cursor_status` - safe readiness check for Cursor Cloud, desktop bridge terminal control, and optional runtime-route wiring',
    '- Deeper operator work lanes stay operator/admin-only and are documented in the admin guide.',
  ].join('\n');
}

export function buildTelegramChatIdText(
  chatId: string | number,
  chatName: string,
  chatType: string,
): string {
  return `Chat ID: tg:${chatId}\nName: ${chatName}\nType: ${chatType}`;
}

export function buildTelegramUnregisteredDmText(
  assistantName = ASSISTANT_NAME,
): string {
  return `I'm ${assistantName}, but this chat is not set up yet. Run /start for the quick guide or /registermain here to make this your main control chat.`;
}

export function buildTelegramFeaturesText(
  assistantName = ASSISTANT_NAME,
): string {
  return [
    `*What ${assistantName} Can Do*`,
    '',
    '- Conversation-first help for everyday questions and follow-through',
    '- To-do lists, reminders, and recurring tasks',
    '- Research and summaries',
    '- Fast replies for simple questions, playful prompts, and basic math',
    '- Project and coding help through Andrea, with `/cursor_status` as the safe readiness check and deeper Cursor plus Codex/OpenAI operator work kept in the admin path',
    "- Secure per-chat isolation so one chat does not automatically get another chat's skills or files",
  ].join('\n');
}

export function splitTelegramMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const paragraphSplitAt = candidate.lastIndexOf('\n\n');
    const newlineSplitAt = candidate.lastIndexOf('\n');
    const spaceSplitAt = candidate.lastIndexOf(' ');
    const safeSplitAt =
      paragraphSplitAt >= Math.floor(maxLength * 0.4)
        ? paragraphSplitAt
        : newlineSplitAt >= Math.floor(maxLength * 0.6)
          ? newlineSplitAt
          : spaceSplitAt >= Math.floor(maxLength * 0.6)
            ? spaceSplitAt
            : -1;
    const chunkEnd = safeSplitAt > 0 ? safeSplitAt : maxLength;
    const chunk = remaining.slice(0, chunkEnd).trimEnd();
    if (!chunk) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
      continue;
    }
    chunks.push(chunk);
    remaining = remaining.slice(chunkEnd).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function buildTelegramDescriptionText(assistantName = ASSISTANT_NAME): string {
  return `${assistantName} helps with reminders, research, project help, and clear everyday assistance. In DM, use /registermain to set up your main control chat.`;
}

function buildTelegramShortDescriptionText(
  assistantName = ASSISTANT_NAME,
): string {
  return `${assistantName}: conversation-first help, reminders, research, and quick everyday answers.`;
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    reply_to_message_id?: number;
    reply_markup?: InlineKeyboard;
  } = {},
): Promise<SendMessageResult> {
  const markdownText = escapeTelegramMarkdownText(text);
  try {
    const sent = await api.sendMessage(chatId, markdownText, {
      ...options,
      parse_mode: 'Markdown',
    });
    return { platformMessageId: sent.message_id.toString() };
  } catch (err) {
    logger.debug(
      { component: 'telegram', err },
      'Markdown send failed, falling back to plain text',
    );
    const sent = await api.sendMessage(chatId, text, options);
    return { platformMessageId: sent.message_id.toString() };
  }
}

async function editTelegramMessage(
  api: { editMessageText: Api['editMessageText'] },
  chatId: string | number,
  messageId: number,
  text: string,
  options: {
    reply_markup?: InlineKeyboard;
  } = {},
): Promise<SendMessageResult> {
  const markdownText = escapeTelegramMarkdownText(text);
  try {
    await api.editMessageText(chatId, messageId, markdownText, {
      ...options,
      parse_mode: 'Markdown',
    });
    return { platformMessageId: messageId.toString() };
  } catch (err) {
    const detail =
      err instanceof Error
        ? err.message.toLowerCase()
        : String(err).toLowerCase();
    if (detail.includes('message is not modified')) {
      return { platformMessageId: messageId.toString() };
    }
    logger.debug(
      { component: 'telegram', err },
      'Markdown edit failed, falling back to plain text',
    );
    await api.editMessageText(chatId, messageId, text, options);
    return { platformMessageId: messageId.toString() };
  }
}

function buildInlineKeyboard(
  options: SendMessageOptions = {},
): InlineKeyboard | null {
  const rows =
    options.inlineActionRows && options.inlineActionRows.length > 0
      ? options.inlineActionRows
      : options.inlineActions && options.inlineActions.length > 0
        ? options.inlineActions.reduce<ChannelInlineAction[][]>(
            (all, action, index) => {
              const rowIndex = Math.floor(index / 3);
              if (!all[rowIndex]) all[rowIndex] = [];
              all[rowIndex].push(action);
              return all;
            },
            [],
          )
        : [];

  if (rows.length === 0) return null;

  const keyboard = new InlineKeyboard();
  rows.forEach((row, rowIndex) => {
    row.forEach((action) => {
      const text = action.label.trim();
      if (!text) return;
      if (action.url) {
        keyboard.url(text, action.url);
      } else if (action.actionId) {
        keyboard.text(text, action.actionId);
      }
    });
    if (rowIndex < rows.length - 1) {
      keyboard.row();
    }
  });
  return keyboard.inline_keyboard.length > 0 ? keyboard : null;
}

export function extractTelegramReplyRef(
  message: {
    reply_to_message?: {
      message_id: number;
      text?: string;
      caption?: string;
      date?: number;
      from?: {
        id?: number;
        first_name?: string;
        username?: string;
        is_bot?: boolean;
      };
    };
  },
  selfId?: number,
): ReplyMessageRef | undefined {
  const replied = message.reply_to_message;
  if (!replied) return undefined;

  const senderId =
    replied.from?.id === undefined ? undefined : replied.from.id.toString();
  const senderName =
    replied.from?.first_name ||
    replied.from?.username ||
    senderId ||
    undefined;

  return {
    message_id: replied.message_id.toString(),
    content: replied.text || replied.caption || '',
    sender: senderId,
    sender_name: senderName,
    is_from_me:
      replied.from?.id !== undefined && selfId !== undefined
        ? replied.from.id === selfId
        : undefined,
    is_bot_message:
      replied.from?.is_bot === undefined ? undefined : replied.from.is_bot,
    timestamp:
      replied.date === undefined
        ? undefined
        : new Date(replied.date * 1000).toISOString(),
  };
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;
  private healthSnapshot: ChannelHealthSnapshot;
  private recentInboundByChatJid = new Map<string, string>();

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
    this.healthSnapshot = {
      name: 'telegram',
      configured: true,
      state: 'stopped',
      updatedAt: new Date().toISOString(),
      lastReadyAt: null,
      lastError: null,
      detail: 'Telegram polling has not started yet.',
    };
  }

  private updateHealth(
    patch: Partial<Omit<ChannelHealthSnapshot, 'name' | 'configured'>>,
  ): void {
    this.healthSnapshot = {
      ...this.healthSnapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.opts.onHealthUpdate?.({ ...this.healthSnapshot });
  }

  private describePollingError(err: unknown): string {
    const raw =
      err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (
      raw.includes('409') &&
      raw.toLowerCase().includes('terminated by setwebhook request')
    ) {
      return 'Telegram long polling was interrupted by a webhook change.';
    }
    return raw || 'Telegram long polling failed unexpectedly.';
  }

  private rememberInbound(chatJid: string, observedAt: string): void {
    this.recentInboundByChatJid.set(chatJid, observedAt);
  }

  private reportOrganicRoundtrip(
    chatJid: string,
    detail: string,
    observedAt = new Date().toISOString(),
  ): void {
    this.recentInboundByChatJid.delete(chatJid);
    this.opts.onRoundtripActivity?.({
      kind: 'organic_success',
      chatJid,
      observedAt,
      detail,
    });
  }

  private maybeReportSendRoundtrip(jid: string): void {
    const inboundAt = this.recentInboundByChatJid.get(jid);
    if (!inboundAt) return;
    const inboundMs = Date.parse(inboundAt);
    if (!Number.isFinite(inboundMs)) {
      this.recentInboundByChatJid.delete(jid);
      return;
    }
    if (Date.now() - inboundMs > 10 * 60 * 1000) {
      this.recentInboundByChatJid.delete(jid);
      return;
    }
    this.reportOrganicRoundtrip(
      jid,
      'Observed a real Telegram request/response exchange.',
      new Date().toISOString(),
    );
  }

  private async clearWebhookBeforePolling(): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.deleteWebhook({
        drop_pending_updates: false,
      });
      logger.info('Cleared Telegram webhook before starting long polling');
    } catch (err) {
      logger.warn({ err }, 'Failed to clear Telegram webhook before polling');
    }
  }

  private scheduleRecovery(reason: string): void {
    if (this.shuttingDown || this.reconnectTimer || !this.bot) {
      return;
    }
    logger.warn(
      { component: 'telegram', reason },
      'Telegram polling degraded; scheduling recovery attempt',
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown || !this.bot) return;
      try {
        this.bot.stop();
      } catch (err) {
        logger.debug(
          { component: 'telegram', err },
          'Telegram polling stop during recovery was not clean',
        );
      }
      void this.startPollingSession(true).catch((err) => {
        const detail = this.describePollingError(err);
        this.updateHealth({
          state: 'degraded',
          lastError: detail,
          detail,
        });
        this.scheduleRecovery(detail);
      });
    }, 5000);
    this.reconnectTimer.unref?.();
  }

  private async startPollingSession(isRecovery = false): Promise<void> {
    if (!this.bot) {
      throw new Error('Telegram bot is not initialized.');
    }

    this.updateHealth({
      state: 'starting',
      lastError: null,
      detail: isRecovery
        ? 'Restarting Telegram long polling.'
        : 'Starting Telegram long polling.',
    });

    await this.clearWebhookBeforePolling();

    await new Promise<void>((resolve, reject) => {
      let started = false;
      const timeout = setTimeout(() => {
        if (started) return;
        reject(
          new Error('Telegram long polling did not report ready in time.'),
        );
      }, 20000);
      timeout.unref?.();

      const settleReady = () => {
        started = true;
        clearTimeout(timeout);
        resolve();
      };
      const settleFailure = (err: unknown) => {
        clearTimeout(timeout);
        if (!started) {
          reject(err);
          return;
        }
        const detail = this.describePollingError(err);
        this.updateHealth({
          state: 'degraded',
          lastError: detail,
          detail,
        });
        this.scheduleRecovery(detail);
      };

      this.bot!
        .start({
          onStart: (botInfo) => {
            this.bot!.api
              .setMyDescription(buildTelegramDescriptionText())
              .catch((err) => {
                logger.warn(
                  { component: 'telegram', err },
                  'Failed to set Telegram bot description',
                );
              });
            this.bot!.api
              .setMyShortDescription(buildTelegramShortDescriptionText())
              .catch((err) => {
                logger.warn(
                  { component: 'telegram', err },
                  'Failed to set Telegram bot short description',
                );
              });

            this.bot!.api
              .setMyCommands([
                { command: 'start', description: 'Quick start for new users' },
                {
                  command: 'help',
                  description: 'How Andrea works in this chat',
                },
                {
                  command: 'commands',
                  description: 'List the demo-safe command set',
                },
                { command: 'features', description: 'Show what Andrea can do' },
                { command: 'ping', description: 'Check if the bot is online' },
                { command: 'chatid', description: 'Show current chat ID/type' },
                {
                  command: 'cursor_status',
                  description: 'Show Cursor integration status',
                },
                {
                  command: 'registermain',
                  description: 'Register this DM as main control chat',
                },
              ])
              .catch((err) => {
                logger.warn(
                  { component: 'telegram', err },
                  'Failed to register Telegram command menu',
                );
              });

            const readyAt = new Date().toISOString();
            this.updateHealth({
              state: 'ready',
              lastReadyAt: readyAt,
              lastError: null,
              detail: `Telegram long polling connected as @${botInfo.username}.`,
            });
            logger.info(
              {
                component: 'telegram',
                username: botInfo.username,
                id: botInfo.id,
              },
              'Telegram bot connected',
            );
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(
              '  Send /help for usage, /chatid for chat ID, or /registermain in DM to bootstrap main chat\n',
            );
            settleReady();
          },
        })
        .catch(settleFailure);
    });
  }

  async connect(): Promise<void> {
    this.shuttingDown = false;
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    const replyAndTrack = async (
      ctx: {
        chat: { id: number | string };
        reply: (
          text: string,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      },
      text: string,
      options?: Record<string, unknown>,
      detail = 'Observed a Telegram command roundtrip.',
    ): Promise<void> => {
      await ctx.reply(text, options);
      this.reportOrganicRoundtrip(`tg:${ctx.chat.id}`, detail);
    };

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : ((ctx.chat as { title?: string }).title ?? 'Unknown');

      return replyAndTrack(
        ctx,
        buildTelegramChatIdText(chatId, chatName, chatType),
        undefined,
        'Observed a Telegram /chatid roundtrip.',
      );
    });

    this.bot.command('help', (ctx) => {
      return replyAndTrack(
        ctx,
        buildTelegramHelpText(),
        { parse_mode: 'Markdown' },
        'Observed a Telegram /help roundtrip.',
      );
    });

    this.bot.command('commands', (ctx) => {
      return replyAndTrack(
        ctx,
        buildTelegramCommandsText(),
        { parse_mode: 'Markdown' },
        'Observed a Telegram /commands roundtrip.',
      );
    });

    this.bot.command('features', (ctx) => {
      return replyAndTrack(
        ctx,
        buildTelegramFeaturesText(),
        { parse_mode: 'Markdown' },
        'Observed a Telegram /features roundtrip.',
      );
    });

    this.bot.command('start', (ctx) => {
      return replyAndTrack(
        ctx,
        buildTelegramWelcomeText(),
        { parse_mode: 'Markdown' },
        'Observed a Telegram /start roundtrip.',
      );
    });

    this.bot.command('registermain', async (ctx) => {
      const chatType = ctx.chat.type;
      if (chatType !== 'private') {
        await ctx.reply(
          'For safety, `/registermain` is only allowed in a direct chat with the bot.',
          { parse_mode: 'Markdown' },
        );
        return;
      }

      if (!this.opts.onRegisterMainChat) {
        await ctx.reply(
          'Main chat bootstrap is not available in this runtime configuration.',
        );
        return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      const chatName =
        ctx.from?.first_name || ctx.from?.username || 'Telegram Main';
      const result = await this.opts.onRegisterMainChat(
        chatJid,
        chatName,
        'telegram',
      );
      await replyAndTrack(
        ctx,
        result.message,
        { parse_mode: 'Markdown' },
        'Observed a Telegram /registermain roundtrip.',
      );
    });

    this.bot.command('ping', (ctx) => {
      return replyAndTrack(
        ctx,
        `${ASSISTANT_NAME} is online.`,
        undefined,
        'Observed a Telegram /ping roundtrip.',
      );
    });

    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid',
      'commands',
      'features',
      'help',
      'ping',
      'registermain',
      'start',
    ]);

    this.bot.on('message:text', async (ctx) => {
      const botUsername = ctx.me?.username?.toLowerCase();
      const leadingCommand = extractTelegramLeadingCommand(
        ctx.message.text,
        botUsername,
      );
      if (leadingCommand && TELEGRAM_BOT_COMMANDS.has(leadingCommand)) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;
      const replyTo = extractTelegramReplyRef(ctx.message, ctx.me?.id);
      const replyToId = replyTo?.message_id;

      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : ((ctx.chat as { title?: string }).title ?? chatJid);

      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );
      this.rememberInbound(chatJid, timestamp);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { component: 'telegram', chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        if (ctx.chat.type === 'private') {
          await ctx.reply(buildTelegramUnregisteredDmText());
        }
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_id: replyToId,
        reply_to: replyTo,
      });

      logger.info(
        { component: 'telegram', chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    const storeNonText = (
      ctx: {
        chat: { id: number | string; type: string };
        from?: { id?: number | string; first_name?: string; username?: string };
        message: {
          date: number;
          message_id: number;
          message_thread_id?: number;
          reply_to_message?: { message_id: number };
          caption?: string;
          document?: { file_name?: string };
          sticker?: { emoji?: string };
        };
      },
      placeholder: string,
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.rememberInbound(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
        thread_id: ctx.message.message_thread_id?.toString(),
        reply_to_id: ctx.message.reply_to_message?.message_id?.toString(),
        reply_to: extractTelegramReplyRef(ctx.message),
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', (ctx) => storeNonText(ctx, '[Voice message]'));
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    this.bot.on('callback_query:data', async (ctx) => {
      const callbackMessage = ctx.callbackQuery.message;
      if (!callbackMessage?.chat) {
        await ctx.answerCallbackQuery({
          text: 'That Cursor action is no longer available.',
        });
        return;
      }

      const chatJid = `tg:${callbackMessage.chat.id}`;
      const senderName =
        ctx.from.first_name || ctx.from.username || ctx.from.id.toString();
      const timestamp = new Date().toISOString();
      const isGroup =
        callbackMessage.chat.type === 'group' ||
        callbackMessage.chat.type === 'supergroup';
      const chatName =
        callbackMessage.chat.type === 'private'
          ? senderName
          : ((callbackMessage.chat as { title?: string }).title ?? chatJid);

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );
      this.rememberInbound(chatJid, timestamp);

      await ctx.answerCallbackQuery({ text: 'Working...' });
      this.opts.onMessage(chatJid, {
        id: `callback:${ctx.callbackQuery.id}`,
        chat_jid: chatJid,
        sender: ctx.from.id.toString(),
        sender_name: senderName,
        content: ctx.callbackQuery.data,
        timestamp,
        is_from_me: false,
        thread_id: callbackMessage.message_thread_id?.toString(),
        reply_to_id: callbackMessage.message_id.toString(),
        reply_to: {
          message_id: callbackMessage.message_id.toString(),
          content: callbackMessage.text || '',
          timestamp:
            callbackMessage.date === undefined
              ? undefined
              : new Date(callbackMessage.date * 1000).toISOString(),
        },
      });
    });

    this.bot.catch((err) => {
      logger.error(
        { component: 'telegram', err: err.message },
        'Telegram bot error',
      );
    });
    await this.startPollingSession(false);
  }

  async sendMessage(
    jid: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<SendMessageResult> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return {};
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const baseOptions = {
        ...(options.threadId
          ? { message_thread_id: parseInt(options.threadId, 10) }
          : {}),
        ...(options.replyToMessageId
          ? {
              reply_to_message_id: parseInt(options.replyToMessageId, 10),
            }
          : {}),
      };
      const inlineKeyboard = buildInlineKeyboard(options);
      let firstMessageId: string | undefined;

      const chunks = splitTelegramMessage(text);
      for (const [index, chunk] of chunks.entries()) {
        const result = await sendTelegramMessage(
          this.bot.api,
          numericId,
          chunk,
          {
            ...baseOptions,
            ...(index === 0 && inlineKeyboard
              ? { reply_markup: inlineKeyboard }
              : {}),
            ...(index > 0
              ? {
                  reply_to_message_id: undefined,
                  reply_markup: undefined,
                }
              : {}),
          },
        );
        if (!firstMessageId) {
          firstMessageId = result.platformMessageId;
        }
      }
      this.maybeReportSendRoundtrip(jid);
      logger.info(
        {
          component: 'telegram',
          jid,
          length: text.length,
          threadId: options.threadId,
          replyToMessageId: options.replyToMessageId,
          inlineActions: options.inlineActions?.length || 0,
          inlineActionRows: options.inlineActionRows?.length || 0,
        },
        'Telegram message sent',
      );
      return {
        platformMessageId: firstMessageId,
        platformMessageIds: firstMessageId ? [firstMessageId] : [],
        threadId: options.threadId || null,
      };
    } catch (err) {
      logger.error(
        { component: 'telegram', jid, err },
        'Failed to send Telegram message',
      );
      return {};
    }
  }

  async sendMessageWithReceipt(
    jid: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<ChannelSendReceipt | null> {
    const result = await this.sendMessage(jid, text, options);
    const platformMessageIds =
      result.platformMessageIds ||
      (result.platformMessageId ? [result.platformMessageId] : []);
    if (platformMessageIds.length === 0) {
      return null;
    }
    return {
      platformMessageIds,
      threadId: result.threadId || options.threadId || null,
    };
  }

  async editMessage(
    jid: string,
    platformMessageId: string,
    text: string,
    options: SendMessageOptions = {},
  ): Promise<SendMessageResult> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return {};
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const messageId = Number.parseInt(platformMessageId, 10);
      if (!Number.isFinite(messageId) || messageId <= 0) {
        return {};
      }
      const inlineKeyboard = buildInlineKeyboard(options);
      const result = await editTelegramMessage(
        this.bot.api,
        numericId,
        messageId,
        splitTelegramMessage(text)[0] || text,
        {
          ...(inlineKeyboard ? { reply_markup: inlineKeyboard } : {}),
        },
      );
      logger.info(
        {
          component: 'telegram',
          jid,
          platformMessageId,
          inlineActions: options.inlineActions?.length || 0,
          inlineActionRows: options.inlineActionRows?.length || 0,
        },
        'Telegram message edited',
      );
      return result;
    } catch (err) {
      logger.error(
        { component: 'telegram', jid, platformMessageId, err },
        'Failed to edit Telegram message',
      );
      return {};
    }
  }

  isConnected(): boolean {
    return this.bot !== null && this.healthSnapshot.state === 'ready';
  }

  getHealthSnapshot(): ChannelHealthSnapshot {
    return { ...this.healthSnapshot };
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.updateHealth({
        state: 'stopped',
        detail: 'Telegram polling stopped.',
      });
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug(
        { component: 'telegram', jid, err },
        'Failed to send Telegram typing indicator',
      );
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
