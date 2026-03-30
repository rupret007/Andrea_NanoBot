import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';

import QRCode from 'qrcode';
import { TelegramClient } from 'telegram';
import { NewMessage } from 'telegram/events/index.js';
import { LogLevel, Logger } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const DEFAULT_REPLY_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_AUTH_STATUS_FILE = 'telegram-user-auth-status.json';
const DEFAULT_AUTH_QR_IMAGE_FILE = 'telegram-user-login.png';
const DEFAULT_AUTH_QR_TEXT_FILE = 'telegram-user-login.txt';
const DEFAULT_SESSION_LOCK_FILE = 'telegram-user-session.lock';

export type TelegramUserAuthMode = 'phone' | 'qr';

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
  'TELEGRAM_USER_AUTH_MODE',
  'TELEGRAM_USER_2FA_PASSWORD',
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
  authMode: TelegramUserAuthMode;
  twoFactorPassword: string;
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

const TELEGRAM_USER_BASE_LOGGER = new Logger(LogLevel.NONE);

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeAuthMode(
  value: string | undefined,
  hasPhoneNumber: boolean,
): TelegramUserAuthMode {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'phone') return 'phone';
  if (normalized === 'qr') return 'qr';
  return hasPhoneNumber ? 'phone' : 'qr';
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
  envFileValues?: Partial<
    Record<(typeof TELEGRAM_USER_ENV_KEYS)[number], string>
  >,
): TelegramUserSessionConfig {
  const envFile = envFileValues ?? readEnvFile([...TELEGRAM_USER_ENV_KEYS]);
  const get = (key: (typeof TELEGRAM_USER_ENV_KEYS)[number]): string =>
    (env[key] || envFile[key] || '').trim();
  const phoneNumber = get('TELEGRAM_PHONE');

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
    phoneNumber,
    authMode: normalizeAuthMode(get('TELEGRAM_USER_AUTH_MODE'), !!phoneNumber),
    twoFactorPassword: get('TELEGRAM_USER_2FA_PASSWORD'),
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

function getTelegramUserAuthArtifacts(sessionFile: string): {
  statusFile: string;
  qrImageFile: string;
  qrTextFile: string;
} {
  const baseDir = path.dirname(sessionFile);
  return {
    statusFile: path.join(baseDir, DEFAULT_AUTH_STATUS_FILE),
    qrImageFile: path.join(baseDir, DEFAULT_AUTH_QR_IMAGE_FILE),
    qrTextFile: path.join(baseDir, DEFAULT_AUTH_QR_TEXT_FILE),
  };
}

function getTelegramUserSessionLockFile(sessionFile: string): string {
  return path.join(path.dirname(sessionFile), DEFAULT_SESSION_LOCK_FILE);
}

export async function withTelegramUserSessionLock<T>(
  sessionFile: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockFile = getTelegramUserSessionLockFile(sessionFile);
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(lockFile, 'wx');
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      })}\n`,
      'utf8',
    );
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === 'EEXIST'
    ) {
      throw new Error(
        `Telegram user-session harness is already running. Wait for the current run to finish, or remove the stale lock file if a previous run crashed: ${lockFile}`,
        { cause: err },
      );
    }
    throw err;
  }

  try {
    return await run();
  } finally {
    try {
      await handle?.close();
    } catch {
      // Best-effort close before cleanup.
    }
    fs.rmSync(lockFile, { force: true });
  }
}

function writeTelegramUserAuthStatus(
  statusFile: string,
  payload: Record<string, unknown>,
): void {
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(
    statusFile,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        ...payload,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
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

async function resolveTwoFactorPassword(
  config: TelegramUserSessionConfig,
): Promise<string> {
  if (config.twoFactorPassword) return config.twoFactorPassword;
  if (!process.stdin.isTTY) {
    throw new Error(
      'Telegram 2FA password is required. Set TELEGRAM_USER_2FA_PASSWORD or rerun `npm run telegram:user:auth` interactively.',
    );
  }
  return prompt('Telegram 2FA password (if any): ');
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
      baseLogger: TELEGRAM_USER_BASE_LOGGER,
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

    const artifacts = getTelegramUserAuthArtifacts(config.sessionFile);
    writeTelegramUserAuthStatus(artifacts.statusFile, {
      state: 'authorizing',
      authMode: config.authMode,
      sessionFile: config.sessionFile,
    });

    if (config.authMode === 'qr') {
      await client.signInUserWithQrCode(
        {
          apiId: config.apiId,
          apiHash: config.apiHash,
        },
        {
          qrCode: async (qrCode) => {
            const loginUrl = `tg://login?token=${qrCode.token.toString('base64url')}`;
            await QRCode.toFile(artifacts.qrImageFile, loginUrl, {
              margin: 1,
              width: 360,
            });
            fs.writeFileSync(
              artifacts.qrTextFile,
              [
                'Open Telegram on your phone, go to Settings > Devices > Link Desktop Device, then scan the QR image.',
                `QR image: ${artifacts.qrImageFile}`,
                `Login URL: ${loginUrl}`,
                `Expires (unix): ${qrCode.expires}`,
              ].join('\n'),
              'utf8',
            );
            writeTelegramUserAuthStatus(artifacts.statusFile, {
              state: 'awaiting_scan',
              authMode: config.authMode,
              sessionFile: config.sessionFile,
              qrImageFile: artifacts.qrImageFile,
              qrTextFile: artifacts.qrTextFile,
              expiresAtUnix: qrCode.expires,
            });
            console.log(
              `Telegram QR login image written to ${artifacts.qrImageFile}`,
            );
            console.log(
              'Open Telegram on your phone, go to Settings > Devices > Link Desktop Device, and scan that image.',
            );
          },
          password: async () => resolveTwoFactorPassword(config),
          onError: (err) => {
            writeTelegramUserAuthStatus(artifacts.statusFile, {
              state: 'error',
              authMode: config.authMode,
              sessionFile: config.sessionFile,
              message: err.message,
            });
            logger.warn({ err }, 'Telegram user-session auth error');
          },
        },
      );
    } else {
      const phoneNumber =
        config.phoneNumber || (await prompt('Telegram phone number: '));
      await client.start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => prompt('Telegram login code: '),
        password: async () => resolveTwoFactorPassword(config),
        onError: (err) => {
          writeTelegramUserAuthStatus(artifacts.statusFile, {
            state: 'error',
            authMode: config.authMode,
            sessionFile: config.sessionFile,
            message: err.message,
          });
          logger.warn({ err }, 'Telegram user-session auth error');
        },
      });
    }
  }

  const savedSession = stringSession.save();
  saveSessionToFile(config.sessionFile, savedSession);
  await client.getMe();
  const artifacts = getTelegramUserAuthArtifacts(config.sessionFile);
  writeTelegramUserAuthStatus(artifacts.statusFile, {
    state: 'authorized',
    authMode: config.authMode,
    sessionFile: config.sessionFile,
  });
  return { client, savedSession };
}

function extractReplyText(message: { message?: string | null }): string {
  return (message.message || '').trim();
}

async function mergeRepliesFromHistory(
  client: TelegramClient,
  target: string,
  sentId: number,
  replies: Map<number, TelegramLiveReply>,
): Promise<void> {
  const history = await client.getMessages(target, { limit: 12 });
  for (const item of history) {
    if (item.out || item.id <= sentId) continue;
    const text = extractReplyText(item);
    if (!text || replies.has(item.id)) continue;
    replies.set(item.id, { id: item.id, text });
  }
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
  const eventFilter = new NewMessage({ incoming: true, chats: [target] });

  await new Promise<void>((resolve) => {
    let settled = false;
    let settleTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finish = async () => {
      if (settled) return;
      settled = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      client.removeEventHandler(onMessage, eventFilter);
      try {
        await mergeRepliesFromHistory(client, target, sentId, replies);
      } catch (err) {
        logger.debug({ err }, 'Telegram reply history fallback failed');
      }
      resolve();
    };

    const armSettleTimer = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        void finish();
      }, settleMs);
    };

    const onMessage = (event: {
      message: { id: number; out?: boolean; message?: string | null };
    }) => {
      const incoming = event.message;
      if (incoming.out || incoming.id <= sentId) return;
      const text = extractReplyText(incoming);
      if (!text || replies.has(incoming.id)) return;
      replies.set(incoming.id, { id: incoming.id, text });
      armSettleTimer();
    };

    client.addEventHandler(onMessage, eventFilter);
    timeoutTimer = setTimeout(() => {
      void finish();
    }, timeoutMs);
  });

  return {
    message,
    sentId,
    replies: [...replies.values()].sort((a, b) => a.id - b.id),
  };
}

async function runAuthCommand(): Promise<void> {
  const config = resolveTelegramUserSessionConfig();
  await withTelegramUserSessionLock(config.sessionFile, async () => {
    const { client } = await connectTelegramUserSession(config, true);
    try {
      console.log(`Telegram user session saved to ${config.sessionFile}`);
      console.log(
        'You can also export this session manually by setting TELEGRAM_USER_SESSION.',
      );
    } finally {
      await client.disconnect();
    }
  });
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
  await withTelegramUserSessionLock(config.sessionFile, async () => {
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
  });
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
  await withTelegramUserSessionLock(config.sessionFile, async () => {
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
  });
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
- TELEGRAM_USER_AUTH_MODE=qr|phone
- TELEGRAM_USER_2FA_PASSWORD
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
