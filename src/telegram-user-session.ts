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

const DEFAULT_REPLY_TIMEOUT_MS = 30_000;
const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_AUTH_STATUS_FILE = 'telegram-user-auth-status.json';
const DEFAULT_AUTH_QR_IMAGE_FILE = 'telegram-user-login.png';
const DEFAULT_AUTH_QR_TEXT_FILE = 'telegram-user-login.txt';
const DEFAULT_SESSION_LOCK_FILE = 'telegram-user-session.lock';
const TELEGRAM_SESSION_LOCK_RETRY_ATTEMPTS = 20;
const TELEGRAM_SESSION_LOCK_RETRY_DELAY_MS = 250;

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
  buttonLabels?: string[];
}

export interface TelegramSendAndCaptureResult {
  message: string;
  sentId: number;
  replies: TelegramLiveReply[];
}

export interface TelegramTapAndCaptureResult {
  sourceMessageId: number;
  tappedLabel: string;
  tappedIndex: number;
  replies: TelegramLiveReply[];
}

export interface TelegramSendCommandArgs {
  message: string;
  replyToMessageId?: number;
}

export interface TelegramTapCommandArgs {
  messageId: number;
  selection: string;
}

export interface TelegramTapButtonTarget {
  index: number;
  label: string;
}

interface TelegramButtonRef extends TelegramTapButtonTarget {
  click: () => Promise<unknown>;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function normalizeTelegramTestTarget(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '';
  if (normalized.startsWith('tg:')) return normalized.slice(3);
  return normalized;
}

export function normalizeTelegramSenderId(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized || null;
  }
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  if ('userId' in record) return normalizeTelegramSenderId(record.userId);
  if ('channelId' in record) return normalizeTelegramSenderId(record.channelId);
  if ('chatId' in record) return normalizeTelegramSenderId(record.chatId);
  if ('value' in record) return normalizeTelegramSenderId(record.value);
  if ('id' in record) return normalizeTelegramSenderId(record.id);
  return null;
}

export function matchesExpectedTelegramSender(
  message: { senderId?: unknown },
  expectedSenderId: string | null,
): boolean {
  if (!expectedSenderId) return true;
  return normalizeTelegramSenderId(message.senderId) === expectedSenderId;
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
  for (
    let attempt = 0;
    attempt < TELEGRAM_SESSION_LOCK_RETRY_ATTEMPTS;
    attempt += 1
  ) {
    try {
      handle = await fs.promises.open(lockFile, 'wx');
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        })}\n`,
        'utf8',
      );
      break;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        err.code === 'EEXIST'
      ) {
        try {
          const raw = fs.readFileSync(lockFile, 'utf8').trim();
          const parsed = raw
            ? (JSON.parse(raw) as Record<string, unknown>)
            : {};
          const lockPid =
            typeof parsed.pid === 'number' ? parsed.pid : Number(parsed.pid);
          if (!isProcessAlive(lockPid)) {
            fs.rmSync(lockFile, { force: true });
            continue;
          }
        } catch {
          fs.rmSync(lockFile, { force: true });
          continue;
        }

        if (attempt < TELEGRAM_SESSION_LOCK_RETRY_ATTEMPTS - 1) {
          await sleep(TELEGRAM_SESSION_LOCK_RETRY_DELAY_MS);
          continue;
        }

        throw new Error(
          `Telegram user-session harness is already running. Wait for the current run to finish, or remove the stale lock file if a previous run crashed: ${lockFile}`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  if (!handle) {
    throw new Error(
      `Telegram user-session harness could not acquire its lock file: ${lockFile}`,
    );
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

function extractTelegramButtonText(button: unknown): string {
  if (!button || typeof button !== 'object') return '';
  const record = button as Record<string, unknown>;
  return typeof record.text === 'string' ? record.text.trim() : '';
}

async function getTelegramButtonRefs(message: {
  buttons?: unknown;
  getButtons?: () => Promise<unknown>;
}): Promise<TelegramButtonRef[]> {
  let rows = message.buttons;
  if (!rows && typeof message.getButtons === 'function') {
    rows = await message.getButtons();
  }

  if (!Array.isArray(rows)) return [];

  const buttons: TelegramButtonRef[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const button of row) {
      const label = extractTelegramButtonText(button);
      if (!label || !button || typeof button !== 'object') continue;
      const click = (
        button as {
          click?: (options?: Record<string, unknown>) => Promise<unknown>;
        }
      ).click;
      if (typeof click !== 'function') continue;
      buttons.push({
        index: buttons.length + 1,
        label,
        click: () => click.call(button, {}),
      });
    }
  }

  return buttons;
}

async function extractTelegramButtonLabels(message: {
  buttons?: unknown;
  getButtons?: () => Promise<unknown>;
}): Promise<string[]> {
  const refs = await getTelegramButtonRefs(message);
  return refs.map((button) => button.label);
}

function extractReplyMetadata(
  message: {
    id: number;
    message?: string | null;
    buttons?: unknown;
    getButtons?: () => Promise<unknown>;
  },
  buttonLabels: string[],
): TelegramLiveReply {
  return {
    id: message.id,
    text: extractReplyText(message),
    ...(buttonLabels.length > 0 ? { buttonLabels } : {}),
  };
}

export function parseTelegramSendCommandArgs(
  args: string[],
): TelegramSendCommandArgs {
  if (args.length === 0) {
    throw new Error(
      'Usage: npm run telegram:user:send -- [--reply-to MESSAGE_ID] <message text to send to Andrea>',
    );
  }

  let replyToMessageId: number | undefined;
  let offset = 0;
  if (args[0] === '--reply-to') {
    const rawMessageId = args[1] || '';
    const parsed = Number.parseInt(rawMessageId, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        'Usage: npm run telegram:user:send -- [--reply-to MESSAGE_ID] <message text to send to Andrea>',
      );
    }
    replyToMessageId = parsed;
    offset = 2;
  }

  const message = args.slice(offset).join(' ').trim();
  if (!message) {
    throw new Error(
      'Usage: npm run telegram:user:send -- [--reply-to MESSAGE_ID] <message text to send to Andrea>',
    );
  }

  return { message, replyToMessageId };
}

export function parseTelegramTapCommandArgs(
  args: string[],
): TelegramTapCommandArgs {
  const rawMessageId = args[0] || '';
  const messageId = Number.parseInt(rawMessageId, 10);
  const selection = args.slice(1).join(' ').trim();
  if (!Number.isFinite(messageId) || messageId <= 0 || !selection) {
    throw new Error(
      'Usage: npm run telegram:user:tap -- <messageId> <button label or 1-based index>',
    );
  }
  return { messageId, selection };
}

export function resolveTelegramTapButtonTarget(
  buttonLabels: string[],
  selection: string,
): TelegramTapButtonTarget {
  const trimmed = selection.trim();
  const exact = buttonLabels.findIndex((label) => label === trimmed);
  if (exact >= 0) {
    return { index: exact + 1, label: buttonLabels[exact] };
  }

  const caseInsensitive = buttonLabels.findIndex(
    (label) => label.toLowerCase() === trimmed.toLowerCase(),
  );
  if (caseInsensitive >= 0) {
    return {
      index: caseInsensitive + 1,
      label: buttonLabels[caseInsensitive],
    };
  }

  const numericIndex = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numericIndex) && numericIndex >= 1) {
    const label = buttonLabels[numericIndex - 1];
    if (label) {
      return { index: numericIndex, label };
    }
  }

  throw new Error(
    `That button selection was not found. Available buttons: ${buttonLabels.length > 0 ? buttonLabels.join(', ') : 'none'}.`,
  );
}

async function resolveExpectedReplySenderId(
  client: TelegramClient,
  target: string,
): Promise<string | null> {
  try {
    const entity = (await client.getEntity(target)) as unknown as Record<
      string,
      unknown
    >;
    if (!entity || typeof entity !== 'object') return null;
    if ('title' in entity) return null;
    return normalizeTelegramSenderId(entity.id);
  } catch (err) {
    logger.debug({ err, target }, 'Telegram reply sender resolution failed');
    return null;
  }
}

async function mergeRepliesFromHistory(
  client: TelegramClient,
  target: string,
  sentId: number,
  replies: Map<
    number,
    {
      id: number;
      message?: string | null;
      buttons?: unknown;
      getButtons?: () => Promise<unknown>;
    }
  >,
  expectedSenderId: string | null,
  limit = 12,
): Promise<void> {
  const history = await client.getMessages(target, { limit });
  for (const item of history) {
    if (item.out || item.id <= sentId) continue;
    if (!matchesExpectedTelegramSender(item, expectedSenderId)) continue;
    const text = extractReplyText(item);
    if (!text || replies.has(item.id)) continue;
    replies.set(item.id, item);
  }
}

async function captureTelegramReplies(
  client: TelegramClient,
  target: string,
  sentId: number,
  timeoutMs: number,
  settleMs: number,
): Promise<TelegramLiveReply[]> {
  const replies = new Map<
    number,
    {
      id: number;
      out?: boolean;
      message?: string | null;
      senderId?: unknown;
      buttons?: unknown;
      getButtons?: () => Promise<unknown>;
    }
  >();
  const eventFilter = new NewMessage({ incoming: true, chats: [target] });
  const expectedSenderId = await resolveExpectedReplySenderId(client, target);

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
        await mergeRepliesFromHistory(
          client,
          target,
          sentId,
          replies,
          expectedSenderId,
        );
        if (replies.size === 0) {
          await sleep(Math.min(settleMs, 2_000));
          await mergeRepliesFromHistory(
            client,
            target,
            sentId,
            replies,
            null,
            25,
          );
        }
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
      message: {
        id: number;
        out?: boolean;
        message?: string | null;
        senderId?: unknown;
        buttons?: unknown;
        getButtons?: () => Promise<unknown>;
      };
    }) => {
      const incoming = event.message;
      if (incoming.out || incoming.id <= sentId) return;
      if (!matchesExpectedTelegramSender(incoming, expectedSenderId)) return;
      const text = extractReplyText(incoming);
      if (!text || replies.has(incoming.id)) return;
      replies.set(incoming.id, incoming);
      armSettleTimer();
    };

    client.addEventHandler(onMessage, eventFilter);
    timeoutTimer = setTimeout(() => {
      void finish();
    }, timeoutMs);
  });

  const summaries: TelegramLiveReply[] = [];
  for (const reply of [...replies.values()].sort((a, b) => a.id - b.id)) {
    const buttonLabels = await extractTelegramButtonLabels(reply);
    summaries.push(extractReplyMetadata(reply, buttonLabels));
  }
  return summaries;
}

export async function sendTelegramUserMessageAndCaptureReplies(
  client: TelegramClient,
  target: string,
  message: string,
  timeoutMs: number,
  settleMs: number,
  options: { replyToMessageId?: number } = {},
): Promise<TelegramSendAndCaptureResult> {
  const sent = await client.sendMessage(target, {
    message,
    ...(options.replyToMessageId ? { replyTo: options.replyToMessageId } : {}),
  });
  const sentId = sent.id;
  const replies = await captureTelegramReplies(
    client,
    target,
    sentId,
    timeoutMs,
    settleMs,
  );
  return {
    message,
    sentId,
    replies,
  };
}

async function fetchTelegramMessageById(
  client: TelegramClient,
  target: string,
  messageId: number,
): Promise<{
  id: number;
  buttons?: unknown;
  getButtons?: () => Promise<unknown>;
  click?: (params?: unknown) => Promise<unknown>;
} | null> {
  const messages = (await client.getMessages(target, {
    ids: messageId,
  })) as unknown;
  if (Array.isArray(messages)) {
    return (
      (messages[0] as {
        id: number;
        buttons?: unknown;
        getButtons?: () => Promise<unknown>;
        click?: (params?: unknown) => Promise<unknown>;
      }) || null
    );
  }

  if (messages && typeof messages === 'object' && 'id' in messages) {
    return messages as {
      id: number;
      buttons?: unknown;
      getButtons?: () => Promise<unknown>;
      click?: (params?: unknown) => Promise<unknown>;
    };
  }
  return null;
}

async function getLatestTelegramMessageId(
  client: TelegramClient,
  target: string,
): Promise<number> {
  const history = (await client.getMessages(target, {
    limit: 1,
  })) as unknown;
  if (
    Array.isArray(history) &&
    history[0] &&
    typeof history[0].id === 'number'
  ) {
    return history[0].id;
  }
  if (history && typeof history === 'object' && 'id' in history) {
    const id = (history as { id?: unknown }).id;
    return typeof id === 'number' ? id : 0;
  }
  return 0;
}

export async function tapTelegramMessageButtonAndCaptureReplies(
  client: TelegramClient,
  target: string,
  messageId: number,
  selection: string,
  timeoutMs: number,
  settleMs: number,
): Promise<TelegramTapAndCaptureResult> {
  const message = await fetchTelegramMessageById(client, target, messageId);
  if (!message) {
    throw new Error(
      `Telegram message ${messageId} was not found in ${target}.`,
    );
  }

  const buttons = await getTelegramButtonRefs(message);
  if (buttons.length === 0) {
    throw new Error(
      `Telegram message ${messageId} has no inline buttons to tap.`,
    );
  }

  const targetButton = resolveTelegramTapButtonTarget(
    buttons.map((button) => button.label),
    selection,
  );
  const chosenButton = buttons[targetButton.index - 1];
  const baselineId = Math.max(
    await getLatestTelegramMessageId(client, target),
    messageId,
  );
  await chosenButton.click();
  const replies = await captureTelegramReplies(
    client,
    target,
    baselineId,
    timeoutMs,
    settleMs,
  );

  return {
    sourceMessageId: messageId,
    tappedLabel: chosenButton.label,
    tappedIndex: chosenButton.index,
    replies,
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

function printTelegramCaptureReplies(replies: TelegramLiveReply[]): void {
  if (replies.length === 0) {
    console.log('Replies: none observed before timeout');
    return;
  }

  console.log('Replies:');
  for (const reply of replies) {
    console.log(`- [${reply.id}] ${reply.text}`);
    if (reply.buttonLabels?.length) {
      console.log(
        `  Buttons: ${reply.buttonLabels
          .map((label, index) => `${index + 1}=${label}`)
          .join(' | ')}`,
      );
    }
  }
}

async function runSendCommand(messageArgs: string[]): Promise<void> {
  const parsed = parseTelegramSendCommandArgs(messageArgs);

  const config = resolveTelegramUserSessionConfig();
  const target = await ensureTelegramTestTarget(config);
  await withTelegramUserSessionLock(config.sessionFile, async () => {
    const { client } = await connectTelegramUserSession(config, false);
    try {
      const result = await sendTelegramUserMessageAndCaptureReplies(
        client,
        target,
        parsed.message,
        config.replyTimeoutMs,
        config.replySettleMs,
        { replyToMessageId: parsed.replyToMessageId },
      );
      console.log(`Sent: ${result.message}`);
      console.log(`Sent ID: ${result.sentId}`);
      if (parsed.replyToMessageId) {
        console.log(`Replying to: ${parsed.replyToMessageId}`);
      }
      printTelegramCaptureReplies(result.replies);
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
        console.log(`Sent ID: ${result.sentId}`);
        printTelegramCaptureReplies(result.replies);
      }
    } finally {
      await client.disconnect();
    }
  });
}

async function runTapCommand(messageArgs: string[]): Promise<void> {
  const parsed = parseTelegramTapCommandArgs(messageArgs);

  const config = resolveTelegramUserSessionConfig();
  const target = await ensureTelegramTestTarget(config);
  await withTelegramUserSessionLock(config.sessionFile, async () => {
    const { client } = await connectTelegramUserSession(config, false);
    try {
      const result = await tapTelegramMessageButtonAndCaptureReplies(
        client,
        target,
        parsed.messageId,
        parsed.selection,
        config.replyTimeoutMs,
        config.replySettleMs,
      );
      console.log(`Tapped: ${result.tappedLabel} (#${result.tappedIndex})`);
      console.log(`Source Message ID: ${result.sourceMessageId}`);
      printTelegramCaptureReplies(result.replies);
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

  if (command === 'tap') {
    await runTapCommand(rest);
    return;
  }

  if (command === 'batch') {
    await runBatchCommand(rest);
    return;
  }

  console.log(`Telegram user-session operator tool

Commands:
- npm run telegram:user:auth
- npm run telegram:user:send -- [--reply-to MESSAGE_ID] <message>
- npm run telegram:user:tap -- <messageId> <button label or 1-based index>
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
