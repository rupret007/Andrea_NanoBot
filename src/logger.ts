const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
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

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTH_KEY|AUTH_TOKEN|SESSION)[A-Z0-9_]*)=([^\s,;'"`]+)/gi;
const SENSITIVE_BEARER_PATTERN = /\b(authorization:\s*bearer)\s+[^\s,;'"`]+/gi;
const GENERIC_BEARER_PATTERN = /\bbearer\s+[a-z0-9._-]{12,}\b/gi;
const OPENAI_KEY_PATTERN = /\bsk-[a-z0-9][a-z0-9_-]{8,}\b/gi;
const CURSOR_KEY_PATTERN = /\bcursor_api_[a-z0-9_-]{8,}\b/gi;
const CURSOR_DASHBOARD_KEY_PATTERN = /\bkey_[a-z0-9]{20,}\b/gi;

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
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  if (typeof dataOrMsg === 'string') {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`,
    );
  } else {
    stream.write(
      `[${ts()}] ${tag} (${process.pid}): ${MSG_COLOR}${msg}${RESET}${formatData(dataOrMsg)}\n`,
    );
  }
}

export const logger = {
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

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
