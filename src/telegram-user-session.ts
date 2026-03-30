import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_REPLY_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_MS = 1_500;
const POLL_INTERVAL_MS = 700;

export const DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES = [
  '/start',
  '/help',
  "What's the meaning of life?",
  'What is 56 + 778?',
  'Thanks',
  'ok',
  'Remind me tomorrow at 3pm to call Sam',
  '/cursor_status',
] as const;

const TELEGRAM_USER_ENV_KEYS = [
  'TELEGRAM_USER_API_ID',
  'TELEGRAM_USER_API_HASH',
  'TELEGRAM_USER_SESSION',
  'TELEGRAM_USER_SESSION_FILE',
  'TELEGRAM_TEST_TARGET',
  'TELEGRAM_TEST_CHAT_ID',
  'TELEGRAM_PHONE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_LIVE_REPLY_TIMEOUT_MS',
  'TELEGRAM_LIVE_REPLY_SETTLE_MS',
] as const;

export interface TelegramUserSessionConfig {
  apiId: number | null;
  apiHash: string;
  session: string;
  sessionFile: string;
  testTarget: string;
  phoneNumber: string;
  replyTimeoutMs: number;
  replySettleMs: number;
}

export interface TelegramLiveReply {
  id: number;
  text: string;
}

export interface TelegramSendAndCaptureResult {
  message: string;
  sentId: number;
  replies: TelegramLiveReply[];
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function uniqueMessages(messages: string[]): string[] {
  return messages.map((message) => message.trim()).filter(Boolean);
}

export function normalizeTelegramTestTarget(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.startsWith('tg:')) return normalized.slice(3);
  return normalized;
}

export function resolveTelegramUserSessionConfig(
  cwd = process.cwd(),
  env = process.env,
): TelegramUserSessionConfig {
  const envFile = readEnvFile([...TELEGRAM_USER_ENV_KEYS]);
  const get = (key: (typeof TELEGRAM_USER_ENV_KEYS)[number]): string =>
    (env[key] || envFile[key] || '').trim();

  return {
    apiId: (() => {
      const parsed = Number.parseInt(get('TELEGRAM_USER_API_ID'), 10);
      return Number.isFinite(parsed) ? parsed : null;
    })(),
    apiHash: get('TELEGRAM_USER_API_HASH'),
    session: get('TELEGRAM_USER_SESSION'),
    sessionFile:
      get('TELEGRAM_USER_SESSION_FILE') ||
      path.join(cwd, 'store', 'telegram-user.session'),
    testTarget: normalizeTelegramTestTarget(
      get('TELEGRAM_TEST_TARGET') || get('TELEGRAM_TEST_CHAT_ID'),
    ),
    phoneNumber: get('TELEGRAM_PHONE'),
    replyTimeoutMs: parsePositiveInt(
      get('TELEGRAM_LIVE_REPLY_TIMEOUT_MS'),
      DEFAULT_REPLY_TIMEOUT_MS,
    ),
    replySettleMs: parsePositiveInt(
      get('TELEGRAM_LIVE_REPLY_SETTLE_MS'),
      DEFAULT_SETTLE_MS,
    ),
  };
}

function loadSessionFromFile(sessionFile: string): string {
  try {
    return fs.readFileSync(sessionFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function saveSessionToFile(sessionFile: string, session: string): void {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${session.trim()}\n`, 'utf8');
}

async function prompt(promptText: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const response = await rl.question(promptText);
    return response.trim();
  } finally {
    rl.close();
  }
}

async function resolveBotUsernameFromToken(
  botToken: string,
): Promise<string | null> {
  if (!botToken) return null;
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      ok?: boolean;
      result?: { username?: string };
    };
    return payload.ok && payload.result?.username
      ? `@${payload.result.username}`
      : null;
  } catch (err) {
    logger.debug({ err }, 'Failed to resolve Telegram bot username from token');
    return null;
  }
}

async function ensureTelegramTestTarget(
  config: TelegramUserSessionConfig,
): Promise<string> {
  if (config.testTarget) return config.testTarget;

  const envFile = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']);
  const configuredUsername =
    process.env.TELEGRAM_BOT_USERNAME || envFile.TELEGRAM_BOT_USERNAME || '';
  if (configuredUsername.trim()) {
    return configuredUsername.startsWith('@')
      ? configuredUsername.trim()
      : `@${configuredUsername.trim()}`;
  }

  const botToken =
    process.env.TELEGRAM_BOT_TOKEN || envFile.TELEGRAM_BOT_TOKEN || '';
  const resolved = await resolveBotUsernameFromToken(botToken);
  if (resolved) return resolved;

  throw new Error(
    'Telegram test target is not configured. Set TELEGRAM_TEST_TARGET, TELEGRAM_TEST_CHAT_ID, or TELEGRAM_BOT_USERNAME.',
  );
}

export async function connectTelegramUserSession(
  config: TelegramUserSessionConfig,
  allowInteractiveAuth: boolean,
): Promise<{ client: TelegramClient; savedSession: string }> {
  if (!config.apiId || !config.apiHash) {
    throw new Error(
      'Telegram user-session is not configured. Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH first.',
    );
  }

  const initialSession =
    config.session || loadSessionFromFile(config.sessionFile);
  const stringSession = new StringSession(initialSession);
  const client = new TelegramClient(
    stringSession,
    config.apiId,
    config.apiHash,
    {
      connectionRetries: 5,
    },
  );

  await client.connect();
  const isAuthorized = await client.checkAuthorization();
  if (!isAuthorized) {
    if (!allowInteractiveAuth) {
      await client.disconnect();
      throw new Error(
        `Telegram user-session is not authenticated. Run \`npm run telegram:user:auth\` and complete the login flow. Session file: ${config.sessionFile}`,
      );
    }

    const phoneNumber =
      config.phoneNumber || (await prompt('Telegram phone number: '));
    await client.start({
      phoneNumber: async () => phoneNumber,
      phoneCode: async () => prompt('Telegram login code: '),
      password: async () => prompt('Telegram 2FA password (if any): '),
      onError: (err) => {
        logger.warn({ err }, 'Telegram user-session auth error');
      },
    });
  }

  const savedSession = stringSession.save();
  saveSessionToFile(config.sessionFile, savedSession);
  return { client, savedSession };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractReplyText(message: { message?: string | null }): string {
  return (message.message || '').trim();
}

export async function sendTelegramUserMessageAndCaptureReplies(
  client: TelegramClient,
  target: string,
  message: string,
  timeoutMs: number,
  settleMs: number,
): Promise<TelegramSendAndCaptureResult> {
  const sent = await client.sendMessage(target, { message });
  const sentId = sent.id;
  const replies = new Map<number, TelegramLiveReply>();
  const deadline = Date.now() + timeoutMs;
  let latestReplyAt = 0;

  while (Date.now() < deadline) {
    const history = await client.getMessages(target, { limit: 20 });
    for (const item of history) {
      if (item.out || item.id <= sentId) continue;
      const text = extractReplyText(item);
      if (!text) continue;
      if (!replies.has(item.id)) {
        replies.set(item.id, { id: item.id, text });
        latestReplyAt = Date.now();
      }
    }

    if (replies.size > 0 && Date.now() - latestReplyAt >= settleMs) {
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    message,
    sentId,
    replies: [...replies.values()].sort((a, b) => a.id - b.id),
  };
}

async function runAuthCommand(): Promise<void> {
  const config = resolveTelegramUserSessionConfig();
  const { client } = await connectTelegramUserSession(config, true);
  try {
    console.log(`Telegram user session saved to ${config.sessionFile}`);
    console.log(
      'You can also export this session manually by setting TELEGRAM_USER_SESSION.',
    );
  } finally {
    await client.disconnect();
  }
}

async function runSendCommand(messageArgs: string[]): Promise<void> {
  const message = messageArgs.join(' ').trim();
  if (!message) {
    throw new Error(
      'Usage: npm run telegram:user:send -- <message text to send to Andrea>',
    );
  }

  const config = resolveTelegramUserSessionConfig();
  const target = await ensureTelegramTestTarget(config);
  const { client } = await connectTelegramUserSession(config, false);
  try {
    const result = await sendTelegramUserMessageAndCaptureReplies(
      client,
      target,
      message,
      config.replyTimeoutMs,
      config.replySettleMs,
    );
    console.log(`Sent: ${result.message}`);
    if (result.replies.length === 0) {
      console.log('Replies: none observed before timeout');
      return;
    }
    console.log('Replies:');
    for (const reply of result.replies) {
      console.log(`- ${reply.text}`);
    }
  } finally {
    await client.disconnect();
  }
}

async function runBatchCommand(messageArgs: string[]): Promise<void> {
  const messages = uniqueMessages(
    messageArgs.length > 0
      ? messageArgs.join('\n').split(/\n+/)
      : [...DEFAULT_TELEGRAM_LIVE_TEST_MESSAGES],
  );
  if (messages.length === 0) {
    throw new Error('No Telegram live-test messages were provided.');
  }

  const config = resolveTelegramUserSessionConfig();
  const target = await ensureTelegramTestTarget(config);
  const { client } = await connectTelegramUserSession(config, false);
  try {
    for (const message of messages) {
      const result = await sendTelegramUserMessageAndCaptureReplies(
        client,
        target,
        message,
        config.replyTimeoutMs,
        config.replySettleMs,
      );
      console.log(`\nSent: ${result.message}`);
      if (result.replies.length === 0) {
        console.log('Replies: none observed before timeout');
        continue;
      }
      console.log('Replies:');
      for (const reply of result.replies) {
        console.log(`- ${reply.text}`);
      }
    }
  } finally {
    await client.disconnect();
  }
}

export async function runTelegramUserSessionCli(argv: string[]): Promise<void> {
  const [command = 'help', ...rest] = argv;

  if (command === 'auth') {
    await runAuthCommand();
    return;
  }

  if (command === 'send') {
    await runSendCommand(rest);
    return;
  }

  if (command === 'batch') {
    await runBatchCommand(rest);
    return;
  }

  console.log(`Telegram user-session operator tool

Commands:
- npm run telegram:user:auth
- npm run telegram:user:send -- <message>
- npm run telegram:user:batch

Required env:
- TELEGRAM_USER_API_ID
- TELEGRAM_USER_API_HASH

Optional env:
- TELEGRAM_USER_SESSION
- TELEGRAM_USER_SESSION_FILE
- TELEGRAM_TEST_TARGET
- TELEGRAM_TEST_CHAT_ID
- TELEGRAM_BOT_USERNAME
- TELEGRAM_PHONE
`);
}

const isDirectExecution =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectExecution) {
  runTelegramUserSessionCli(process.argv.slice(2)).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Telegram user-session error: ${message}`);
    process.exitCode = 1;
  });
}
