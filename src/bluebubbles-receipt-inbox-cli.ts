import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnvFile } from './env.js';
import { BlueBubblesReceiptInboxHttpService } from './bluebubbles-receipt-inbox-service.js';
import { BlueBubblesReceiptInboxStore } from './bluebubbles-receipt-inbox-store.js';

const RECEIPT_INBOX_ENV_KEYS = [
  'BLUEBUBBLES_WEBHOOK_SECRET',
  'BLUEBUBBLES_RECEIPT_INBOX_DB_PATH',
  'BLUEBUBBLES_RECEIPT_INBOX_HOST',
  'BLUEBUBBLES_RECEIPT_INBOX_PORT',
  'BLUEBUBBLES_RECEIPT_INBOX_PATH',
  'BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH',
  'ANDREA_STATE_DIR',
] as const;

const DEFAULT_RECEIPT_INBOX_HOST = '127.0.0.1';
const DEFAULT_RECEIPT_INBOX_PORT = 4_306;
const DEFAULT_RECEIPT_INBOX_PATH = '/bluebubbles/receipt-inbox';
const DEFAULT_RECEIPT_INBOX_HEALTH_PATH = '/health';
const MAX_RECEIPT_INBOX_PATH_LENGTH = 1_024;
const MAX_WEBHOOK_SECRET_LENGTH = 4_096;

export interface BlueBubblesReceiptInboxCliConfig {
  databasePath: string;
  webhookSecret: string;
  host: string;
  port: number;
  webhookPath: string;
  healthPath: string;
}

function firstConfigured(
  environment: NodeJS.ProcessEnv,
  fileEnvironment: Record<string, string>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = environment[key] || fileEnvironment[key];
    if (value) return value;
  }
  return undefined;
}

function expandHomeDirectory(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parseConfiguredPort(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      'BLUEBUBBLES_RECEIPT_INBOX_PORT must be an integer between 1 and 65535.',
    );
  }
  return parsed;
}

function normalizeConfiguredPath(
  value: string | undefined,
  fallback: string,
  key: string,
): string {
  const normalized = value?.trim() || fallback;
  if (
    !normalized.startsWith('/') ||
    normalized.length > MAX_RECEIPT_INBOX_PATH_LENGTH ||
    normalized.includes('?') ||
    normalized.includes('#')
  ) {
    throw new Error(
      `${key} must be an absolute URL path without a query or fragment.`,
    );
  }
  return normalized;
}

/** The supervised receipt listener is intentionally unavailable on LAN/WAN. */
export function normalizeBlueBubblesReceiptInboxHost(
  value: string | undefined,
): '127.0.0.1' | '::1' {
  const normalized = value?.trim().toLowerCase() || DEFAULT_RECEIPT_INBOX_HOST;
  if (normalized === '127.0.0.1' || normalized === '::1') {
    return normalized;
  }
  throw new Error(
    'BLUEBUBBLES_RECEIPT_INBOX_HOST must be 127.0.0.1 or ::1; wildcard and non-loopback listeners are forbidden.',
  );
}

function hardenDatabaseFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `BlueBubbles receipt inbox database file must be a regular file: ${filePath}`,
    );
  }
  fs.chmodSync(filePath, 0o600);
}

/**
 * Create/check the dedicated database directory and harden SQLite artifacts.
 * Existing shared directories are never silently made private.
 */
export function prepareBlueBubblesReceiptInboxDatabasePath(
  databasePath: string,
): void {
  const parentDirectory = path.dirname(databasePath);
  if (!fs.existsSync(parentDirectory)) {
    fs.mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
  }
  const parentStat = fs.lstatSync(parentDirectory);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      `BlueBubbles receipt inbox database parent must be a real directory: ${parentDirectory}`,
    );
  }
  const parentMode = parentStat.mode & 0o777;
  if (parentMode !== 0o700) {
    throw new Error(
      `BlueBubbles receipt inbox database directory must have mode 0700: ${parentDirectory}`,
    );
  }
  hardenDatabaseFile(databasePath);
  hardenDatabaseFile(`${databasePath}-wal`);
  hardenDatabaseFile(`${databasePath}-shm`);
}

export function resolveBlueBubblesReceiptInboxCliConfig(
  environment: NodeJS.ProcessEnv = process.env,
  fileEnvironment: Record<string, string> = readEnvFile([
    ...RECEIPT_INBOX_ENV_KEYS,
  ]),
): BlueBubblesReceiptInboxCliConfig {
  const webhookSecret = firstConfigured(
    environment,
    fileEnvironment,
    'BLUEBUBBLES_WEBHOOK_SECRET',
  );
  if (!webhookSecret) {
    throw new Error(
      'BLUEBUBBLES_WEBHOOK_SECRET is required for the receipt inbox service.',
    );
  }
  if (webhookSecret.length > MAX_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `BLUEBUBBLES_WEBHOOK_SECRET must not exceed ${MAX_WEBHOOK_SECRET_LENGTH} characters.`,
    );
  }
  const databasePath = firstConfigured(
    environment,
    fileEnvironment,
    'BLUEBUBBLES_RECEIPT_INBOX_DB_PATH',
  );
  const stateDirectory = firstConfigured(
    environment,
    fileEnvironment,
    'ANDREA_STATE_DIR',
  );
  const webhookPath = normalizeConfiguredPath(
    firstConfigured(
      environment,
      fileEnvironment,
      'BLUEBUBBLES_RECEIPT_INBOX_PATH',
    ),
    DEFAULT_RECEIPT_INBOX_PATH,
    'BLUEBUBBLES_RECEIPT_INBOX_PATH',
  );
  const healthPath = normalizeConfiguredPath(
    firstConfigured(
      environment,
      fileEnvironment,
      'BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH',
    ),
    DEFAULT_RECEIPT_INBOX_HEALTH_PATH,
    'BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH',
  );
  if (healthPath === '/' || healthPath === webhookPath) {
    throw new Error(
      'BLUEBUBBLES_RECEIPT_INBOX_HEALTH_PATH must be non-root and differ from BLUEBUBBLES_RECEIPT_INBOX_PATH.',
    );
  }
  return {
    databasePath: path.resolve(
      expandHomeDirectory(
        databasePath ||
          path.join(
            stateDirectory || path.join(os.homedir(), '.andrea'),
            'bluebubbles',
            'receipt-inbox.sqlite3',
          ),
      ),
    ),
    webhookSecret,
    host: normalizeBlueBubblesReceiptInboxHost(
      firstConfigured(
        environment,
        fileEnvironment,
        'BLUEBUBBLES_RECEIPT_INBOX_HOST',
      ),
    ),
    port: parseConfiguredPort(
      firstConfigured(
        environment,
        fileEnvironment,
        'BLUEBUBBLES_RECEIPT_INBOX_PORT',
      ),
      DEFAULT_RECEIPT_INBOX_PORT,
    ),
    webhookPath,
    healthPath,
  };
}

/** Explicit long-running entrypoint; importing this module starts nothing. */
export async function runBlueBubblesReceiptInboxCli(
  config = resolveBlueBubblesReceiptInboxCliConfig(),
): Promise<void> {
  prepareBlueBubblesReceiptInboxDatabasePath(config.databasePath);
  const store = new BlueBubblesReceiptInboxStore(config.databasePath);
  prepareBlueBubblesReceiptInboxDatabasePath(config.databasePath);
  const service = new BlueBubblesReceiptInboxHttpService({
    store,
    webhookSecret: config.webhookSecret,
    host: config.host,
    port: config.port,
    webhookPath: config.webhookPath,
    healthPath: config.healthPath,
  });
  let shutdownResolve: (() => void) | null = null;
  const shutdown = () => shutdownResolve?.();
  try {
    const address = await service.start();
    process.stdout.write(
      `${JSON.stringify({
        status: 'ready',
        host: address.host,
        port: address.port,
        webhookPath: address.webhookPath,
        healthPath: address.healthPath,
        databasePath: config.databasePath,
      })}\n`,
    );
    await new Promise<void>((resolve) => {
      shutdownResolve = resolve;
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await service.stop();
    store.close();
  }
}
