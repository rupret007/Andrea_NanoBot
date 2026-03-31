const LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

export type Level = keyof typeof LEVELS;
export type RuntimeLogLevel = 'info' | 'debug' | 'trace';
export type OperatorLogLevel = 'normal' | 'debug' | 'verbose';

export interface LogOverrideConfig {
  level: RuntimeLogLevel;
  expiresAt?: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface LogControlConfig {
  globalLevel: RuntimeLogLevel;
  scopedOverrides: Record<string, LogOverrideConfig>;
  updatedAt: string;
  updatedBy: string;
}

export interface LogRoutingContext {
  chatJid?: string;
  groupJid?: string;
  jid?: string;
  laneId?: string;
  component?: string;
  groupFolder?: string;
  jobId?: string;
  containerName?: string;
}

type LogInput = Record<string, unknown> | string;

const COLORS: Record<Level, string> = {
  trace: '\x1b[90m',
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH_KEY|AUTH_TOKEN|SESSION)[A-Z0-9_]*)=([^\s,;'"`]+)/gi;
const SENSITIVE_BEARER_PATTERN = /\b(authorization:\s*bearer)\s+[^\s,;'"`]+/gi;
const GENERIC_BEARER_PATTERN = /\bbearer\s+[a-z0-9._-]{12,}\b/gi;
const OPENAI_KEY_PATTERN = /\bsk-[a-z0-9][a-z0-9_-]{8,}\b/gi;
const CURSOR_KEY_PATTERN = /\bcursor_api_[a-z0-9_-]{8,}\b/gi;
const CURSOR_DASHBOARD_KEY_PATTERN = /\bkey_[a-z0-9]{20,}\b/gi;

function normalizeRuntimeLogLevel(value: string | undefined): RuntimeLogLevel {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'trace' || normalized === 'verbose') return 'trace';
  if (normalized === 'debug') return 'debug';
  return 'info';
}

function createDefaultLogControlConfig(
  updatedBy = 'startup',
): LogControlConfig {
  const now = new Date().toISOString();
  return {
    globalLevel: normalizeRuntimeLogLevel(process.env.LOG_LEVEL),
    scopedOverrides: {},
    updatedAt: now,
    updatedBy,
  };
}

function cloneOverride(override: LogOverrideConfig): LogOverrideConfig {
  return {
    level: override.level,
    expiresAt: override.expiresAt || null,
    updatedAt: override.updatedAt,
    updatedBy: override.updatedBy,
  };
}

function cloneLogControlConfig(config: LogControlConfig): LogControlConfig {
  return {
    globalLevel: config.globalLevel,
    scopedOverrides: Object.fromEntries(
      Object.entries(config.scopedOverrides || {}).map(([scope, override]) => [
        scope,
        cloneOverride(override),
      ]),
    ),
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

let logControlConfig = createDefaultLogControlConfig();

function isRuntimeLogLevel(value: string): value is RuntimeLogLevel {
  return value === 'info' || value === 'debug' || value === 'trace';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceLogControlConfig(value: unknown): LogControlConfig {
  if (!isPlainObject(value)) {
    return cloneLogControlConfig(createDefaultLogControlConfig('coerce'));
  }

  const globalLevel = isRuntimeLogLevel(String(value.globalLevel || ''))
    ? (value.globalLevel as RuntimeLogLevel)
    : normalizeRuntimeLogLevel(String(value.globalLevel || ''));
  const rawOverrides = isPlainObject(value.scopedOverrides)
    ? value.scopedOverrides
    : {};
  const scopedOverrides: Record<string, LogOverrideConfig> = {};

  for (const [scope, rawOverride] of Object.entries(rawOverrides)) {
    if (!isPlainObject(rawOverride)) continue;
    const level = isRuntimeLogLevel(String(rawOverride.level || ''))
      ? (rawOverride.level as RuntimeLogLevel)
      : normalizeRuntimeLogLevel(String(rawOverride.level || ''));
    scopedOverrides[scope] = {
      level,
      expiresAt:
        typeof rawOverride.expiresAt === 'string' && rawOverride.expiresAt
          ? rawOverride.expiresAt
          : null,
      updatedAt:
        typeof rawOverride.updatedAt === 'string' && rawOverride.updatedAt
          ? rawOverride.updatedAt
          : new Date().toISOString(),
      updatedBy:
        typeof rawOverride.updatedBy === 'string' && rawOverride.updatedBy
          ? rawOverride.updatedBy
          : 'unknown',
    };
  }

  return {
    globalLevel,
    scopedOverrides,
    updatedAt:
      typeof value.updatedAt === 'string' && value.updatedAt
        ? value.updatedAt
        : new Date().toISOString(),
    updatedBy:
      typeof value.updatedBy === 'string' && value.updatedBy
        ? value.updatedBy
        : 'unknown',
  };
}

function pruneExpiredOverrides(config: LogControlConfig): boolean {
  let changed = false;
  const now = Date.now();

  for (const [scope, override] of Object.entries(config.scopedOverrides)) {
    if (!override.expiresAt) continue;
    const expiresAtMs = Date.parse(override.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
      delete config.scopedOverrides[scope];
      changed = true;
      continue;
    }
    if (expiresAtMs <= now) {
      delete config.scopedOverrides[scope];
      changed = true;
    }
  }

  return changed;
}

export function getLogControlConfig(): LogControlConfig {
  pruneExpiredOverrides(logControlConfig);
  return cloneLogControlConfig(logControlConfig);
}

export function setLogControlConfig(config: LogControlConfig): void {
  logControlConfig = coerceLogControlConfig(config);
  pruneExpiredOverrides(logControlConfig);
}

function extractLogRoutingContext(
  dataOrMsg: LogInput | undefined,
): LogRoutingContext {
  if (!dataOrMsg || typeof dataOrMsg === 'string') return {};

  const getString = (key: string): string | undefined => {
    const value = dataOrMsg[key];
    return typeof value === 'string' && value ? value : undefined;
  };

  return {
    chatJid: getString('chatJid'),
    groupJid: getString('groupJid'),
    jid: getString('jid'),
    laneId: getString('laneId'),
    component: getString('component'),
    groupFolder: getString('groupFolder'),
    jobId: getString('jobId'),
    containerName: getString('containerName'),
  };
}

function resolveEffectiveRuntimeLogLevel(
  context: LogRoutingContext,
): RuntimeLogLevel {
  pruneExpiredOverrides(logControlConfig);
  const chatKey = context.chatJid || context.groupJid || context.jid;
  if (chatKey) {
    const match = logControlConfig.scopedOverrides[`chat:${chatKey}`];
    if (match) return match.level;
  }
  if (context.laneId) {
    const match = logControlConfig.scopedOverrides[`lane:${context.laneId}`];
    if (match) return match.level;
  }
  if (context.component) {
    const match =
      logControlConfig.scopedOverrides[`component:${context.component}`];
    if (match) return match.level;
  }
  return logControlConfig.globalLevel || 'info';
}

export function isLogLevelEnabled(level: Level, dataOrMsg?: LogInput): boolean {
  const context = extractLogRoutingContext(dataOrMsg);
  const threshold = resolveEffectiveRuntimeLogLevel(context);
  return LEVELS[level] >= LEVELS[threshold];
}

export function sanitizeLogString(value: string): string {
  if (!value) return value;
  return value
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1=***')
    .replace(SENSITIVE_BEARER_PATTERN, '$1 ***')
    .replace(GENERIC_BEARER_PATTERN, 'Bearer ***')
    .replace(OPENAI_KEY_PATTERN, 'sk-***')
    .replace(CURSOR_KEY_PATTERN, 'cursor_api_***')
    .replace(CURSOR_DASHBOARD_KEY_PATTERN, 'key_***');
}

function sanitizeUnknown(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return sanitizeLogString(value);
  if (
    value == null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();

  if (value instanceof Error) {
    return {
      type: value.constructor.name,
      message: sanitizeLogString(value.message || ''),
      stack: sanitizeLogString(value.stack || ''),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, seen));
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = sanitizeUnknown(item, seen);
    }
    return sanitized;
  }

  return sanitizeLogString(String(value));
}

export function sanitizeLogData(value: unknown): unknown {
  return sanitizeUnknown(value);
}

function stringifyLogData(value: unknown): string {
  try {
    return JSON.stringify(sanitizeLogData(value));
  } catch {
    return JSON.stringify('[Unserializable log data]');
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    const message = sanitizeLogString(err.message || '');
    const stack = sanitizeLogString(err.stack || '');
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${message}",\n      "stack":\n          ${stack}\n    }`;
  }
  return stringifyLogData(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${stringifyLogData(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (!isLogLevelEnabled(level, dataOrMsg)) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (typeof dataOrMsg === 'string') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`,
    );
    return;
  }

  stream.write(
    `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`,
  );
}

export const logger = {
  trace: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('trace', dataOrMsg, msg),
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

process.on('uncaughtException', (err) => {
  logger.fatal({ err, component: 'assistant' }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason, component: 'assistant' }, 'Unhandled rejection');
});
