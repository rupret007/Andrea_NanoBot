/*
 * Redaction and concurrency helpers for Andrea's council surfaces.
 *
 * Redaction/concurrency patterns adapted from open-multi-agent/open-multi-agent
 * (MIT, commit 6d382d1bb86b714d0ad25c3f51719ef07723635d).
 * Copyright (c) 2025 open-multi-agent contributors.
 */

const REDACTED = '[REDACTED_SECRET]';

const SENSITIVE_NAME_PATTERN =
  /(?:api[_-]?key|apiKey|secret|password|passwd|pwd|private[_-]?key|privateKey|access[_-]?key|accessKey|accessToken|refreshToken|idToken|githubToken|authorization|auth[_-]?token|authToken|cookie|session|credential|bearer|^token$|[_-]token$|^token[_-])/i;

const QUOTED_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(\1?\s*[:=]\s*)(["'])([^]*?)\4/g;

const UNQUOTED_ASSIGNMENT_PATTERN =
  /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)(\1?\s*[:=]\s*)([^"'\s,;}\]\n\r][^,;}\]\n\r]*)/g;

const TOKEN_LITERAL_PATTERNS: readonly RegExp[] = [
  /sk-(?:proj-|ant-api\d*-|api-)?[A-Za-z0-9_-]{16,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /BSA-[A-Za-z0-9_-]{12,}/g,
  /gh[pousr]_[A-Za-z0-9_]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /crsr_[A-Za-z0-9_]{16,}/g,
  /\b\d{7,}:[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

export function isSensitiveName(name: string): boolean {
  if (/^secrets?Redacted$/i.test(name)) return false;
  return SENSITIVE_NAME_PATTERN.test(name);
}

export function redactCouncilText(value: string, limit = 6000): string {
  if (!value) return '';
  let redacted = value.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    REDACTED,
  );
  redacted = redacted.replace(
    /\b(Authorization\s*:\s*)(?:Bearer\s+)?[^\n\r,;}]+/gi,
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    `Bearer ${REDACTED}`,
  );
  redacted = redacted.replace(
    QUOTED_ASSIGNMENT_PATTERN,
    (
      match: string,
      keyQuote: string,
      key: string,
      separator: string,
      valueQuote: string,
    ) => {
      if (!isSensitiveName(key)) return match;
      return `${keyQuote}${key}${separator}${valueQuote}${REDACTED}${valueQuote}`;
    },
  );
  redacted = redacted.replace(
    UNQUOTED_ASSIGNMENT_PATTERN,
    (
      match: string,
      keyQuote: string,
      key: string,
      separator: string,
      value: string,
    ) => {
      if (!isSensitiveName(key)) return match;
      if (value === REDACTED || value.startsWith(REDACTED)) return match;
      return `${keyQuote}${key}${separator}${REDACTED}`;
    },
  );
  for (const pattern of TOKEN_LITERAL_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  redacted = redacted
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[redacted-email]')
    .replace(
      /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
      '[redacted-phone]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(0, limit);
}

export function redactCouncilMetadata(
  value: Record<string, string> | undefined,
  valueLimit = 480,
): Record<string, string> | undefined {
  if (!value) return undefined;
  const redacted: Record<string, string> = {};
  for (const [key, childValue] of Object.entries(value)) {
    redacted[key] = isSensitiveName(key)
      ? REDACTED
      : redactCouncilText(String(childValue), valueLimit);
  }
  return redacted;
}

export function clipCouncilText(value: string, limit: number): string {
  const redacted = redactCouncilText(value, Math.max(limit, 8));
  return redacted.length <= limit
    ? redacted
    : `${redacted.slice(0, limit - 3).trimEnd()}...`;
}

export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) {
      throw new RangeError(`Semaphore max must be at least 1, got ${max}`);
    }
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.current = Math.max(0, this.current - 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get active(): number {
    return this.current;
  }

  get pending(): number {
    return this.queue.length;
  }
}
