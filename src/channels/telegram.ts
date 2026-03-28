import https from 'https';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
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
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
  const mentionExample = `@${assistantName}`;

  return [
    `*Welcome to ${assistantName}*`,
    '',
    '- In a direct chat: send normal messages or slash commands.',
    `- In a group: mention me (for example \`${mentionExample}\`) when you want me to act.`,
    '- First-time Telegram setup: DM me and run `/registermain`.',
    '- Use `/commands` for a command reference and `/features` for capability details.',
    '',
    '*Quick Start*',
    `- \`${mentionExample} add "renew passport" to my to-do list\``,
    `- \`${mentionExample} remind me tomorrow at 3pm to call Sam\``,
    `- \`${mentionExample} research the best family calendar apps and summarize them\``,
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
    '- `/cursor_status` - show Cursor/9router integration readiness',
    '- `/cursor_test` - run live Cursor/9router smoke test',
    '- `/cursor_remote` - start remote control bridge (main chat only)',
    '- `/cursor_remote_end` - end remote control bridge',
  ].join('\n');
}

export function buildTelegramFeaturesText(
  assistantName = ASSISTANT_NAME,
): string {
  return [
    `*What ${assistantName} Can Do*`,
    '',
    '- To-do lists, reminders, and recurring tasks',
    '- Research and summaries',
    '- Project and coding help',
    '- Enable/disable vetted community skills per chat',
    '- Calendar integrations through approved skills, including Apple Calendar, Google Calendar, Outlook/M365, and CalDAV options',
    "- Secure per-chat isolation so one chat does not automatically get another chat's skills or files",
  ].join('\n');
}

function buildTelegramDescriptionText(assistantName = ASSISTANT_NAME): string {
  return `${assistantName} helps with tasks, reminders, research, coding, and approved per-chat skills. In DM, use /registermain to set up your main control chat.`;
}

function buildTelegramShortDescriptionText(
  assistantName = ASSISTANT_NAME,
): string {
  return `${assistantName}: tasks, reminders, research, coding, and chat-specific skills.`;
}

async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : ((ctx.chat as { title?: string }).title ?? 'Unknown');

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    this.bot.command('help', (ctx) => {
      ctx.reply(buildTelegramHelpText(), { parse_mode: 'Markdown' });
    });

    this.bot.command('commands', (ctx) => {
      ctx.reply(buildTelegramCommandsText(), { parse_mode: 'Markdown' });
    });

    this.bot.command('features', (ctx) => {
      ctx.reply(buildTelegramFeaturesText(), { parse_mode: 'Markdown' });
    });

    this.bot.command('start', (ctx) => {
      ctx.reply(buildTelegramWelcomeText(), { parse_mode: 'Markdown' });
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
      await ctx.reply(result.message, { parse_mode: 'Markdown' });
    });

    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
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

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
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
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
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
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
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

    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          this.bot!.api.setMyDescription(buildTelegramDescriptionText()).catch(
            (err) => {
              logger.warn({ err }, 'Failed to set Telegram bot description');
            },
          );
          this.bot!.api.setMyShortDescription(
            buildTelegramShortDescriptionText(),
          ).catch((err) => {
            logger.warn(
              { err },
              'Failed to set Telegram bot short description',
            );
          });

          this.bot!.api.setMyCommands([
            { command: 'start', description: 'Quick start for new users' },
            { command: 'help', description: 'How Andrea works in this chat' },
            {
              command: 'commands',
              description: 'List commands and control tools',
            },
            { command: 'features', description: 'Show what Andrea can do' },
            { command: 'ping', description: 'Check if the bot is online' },
            { command: 'chatid', description: 'Show current chat ID/type' },
            {
              command: 'cursor_status',
              description: 'Show Cursor integration status',
            },
            {
              command: 'cursor_test',
              description: 'Run Cursor integration smoke test',
            },
            {
              command: 'registermain',
              description: 'Register this DM as main control chat',
            },
          ]).catch((err) => {
            logger.warn({ err }, 'Failed to register Telegram command menu');
          });

          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            '  Send /help for usage, /chatid for chat ID, or /registermain in DM to bootstrap main chat\n',
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
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
