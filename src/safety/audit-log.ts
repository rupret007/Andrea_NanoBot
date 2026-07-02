/**
 * Append-only audit log.
 *
 * Every external action, every secret access, every cognition trace, every
 * memory write goes through here. The log is the ground-truth record for
 * "what did Andrea actually do today?" — not just for security, but so
 * the reflection loop can be honest about the agent's behavior.
 *
 * Each entry is hash-chained: `prevHash` points at the previous entry's
 * hash so post-hoc tampering is detectable. We ship `verifyChain()` so
 * downstream tools can validate the on-disk file front-to-back.
 *
 * Concurrency: `write()` calls are serialized via an internal promise tail
 * so two overlapping writes can't observe the same `lastHash` and fork the
 * chain.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CONSTITUTION_VERSION } from './constitution.js';

export interface AuditEntry {
  id: string;
  at: number;
  scope: string;
  kind: string;
  payload?: unknown;
  prevHash?: string;
  hash: string;
  /** Constitution version active at write-time. Auto-stamped. */
  constitutionVersion?: string;
}

export interface VerifyResult {
  ok: boolean;
  brokenAtLine?: number;
  reason?: string;
}

export class AuditLog {
  private lastHash: string | undefined;
  /** Promise tail used to serialize concurrent `write()` calls. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length) {
        const last: AuditEntry = JSON.parse(lines[lines.length - 1]);
        this.lastHash = last.hash;
      }
    } catch {
      // empty log
    }
  }

  /**
   * Append an entry. Concurrent calls are serialized — they enqueue onto an
   * internal promise tail so the hash chain stays single-threaded even when
   * multiple callers race.
   */
  write(
    entry: Omit<
      AuditEntry,
      'id' | 'at' | 'prevHash' | 'hash' | 'constitutionVersion'
    >,
  ): Promise<AuditEntry> {
    const next = this.tail.then(() => this.actualWrite(entry));
    // Swallow rejections on the tail so one failure doesn't poison subsequent
    // writes. Each caller still receives the rejection on their own returned
    // promise.
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async actualWrite(
    entry: Omit<
      AuditEntry,
      'id' | 'at' | 'prevHash' | 'hash' | 'constitutionVersion'
    >,
  ): Promise<AuditEntry> {
    const base: Omit<AuditEntry, 'hash'> = {
      id: randomUUID(),
      at: Date.now(),
      prevHash: this.lastHash,
      constitutionVersion: CONSTITUTION_VERSION,
      ...entry,
    };
    // Redact FIRST so the hash covers exactly what lands on disk; otherwise
    // the on-disk chain can't be verified (the disk form differs from the
    // form we hashed).
    const redactedBase = redactSecrets(base);
    const hash = createHash('sha256')
      .update(JSON.stringify(redactedBase))
      .digest('hex');
    const full: AuditEntry = { ...redactedBase, hash };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(full) + '\n', 'utf8');
    this.lastHash = hash;
    return full;
  }

  /**
   * Walk the on-disk file front-to-back, recomputing each line's hash and
   * verifying the prevHash chain. Returns `{ ok: true }` for a clean log,
   * or `{ ok: false, brokenAtLine, reason }` when tampering is detected.
   * Lines are 1-indexed.
   */
  async verifyChain(): Promise<VerifyResult> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      return {
        ok: false,
        reason: `Could not read log: ${(err as Error).message}`,
      };
    }
    const lines = raw.split('\n').filter(Boolean);
    let prevHash: string | undefined = undefined;
    for (let i = 0; i < lines.length; i++) {
      let parsed: AuditEntry;
      try {
        parsed = JSON.parse(lines[i]) as AuditEntry;
      } catch (err) {
        return {
          ok: false,
          brokenAtLine: i + 1,
          reason: `JSON parse error: ${(err as Error).message}`,
        };
      }
      const { hash, ...rest } = parsed;
      const recomputed = createHash('sha256')
        .update(JSON.stringify(rest))
        .digest('hex');
      if (recomputed !== hash) {
        return {
          ok: false,
          brokenAtLine: i + 1,
          reason: 'Hash mismatch: entry was tampered with',
        };
      }
      if ((parsed.prevHash ?? undefined) !== prevHash) {
        return {
          ok: false,
          brokenAtLine: i + 1,
          reason: "prevHash does not match previous entry's hash",
        };
      }
      prevHash = hash;
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

/**
 * Explicit, well-known secret patterns. Order matters: more specific patterns
 * come first so a JWT isn't first redacted as a generic high-entropy blob.
 */
export const KNOWN_SECRET_PATTERNS: RegExp[] = [
  // Multi-line PEM blocks (private keys). Use [\s\S] because . doesn't match
  // newlines by default.
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+ PRIVATE KEY-----/g,
  // JWT: three base64url segments dot-separated.
  /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // GitHub personal/oauth/user/server/refresh tokens.
  /\bgh[poursa]_[A-Za-z0-9]{20,}\b/g,
  // Anthropic — must come before generic sk- to win.
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI project-scoped.
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  // OpenAI generic.
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // AWS access keys.
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bASIA[0-9A-Z]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // Azure SAS query string fragments.
  /\?sv=[^&\s]+&[^\s]*sig=[^\s&]+/g,
];

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const KEY_NAME_RE = /\b(token|secret|api[_-]?key|password|auth)\b/i;

/** Shannon entropy in bits/char. Used as a gate on the generic catch-all. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const len = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / len;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Redact strings that look like API keys / tokens before writing them to
 * disk. Defense-in-depth — integrations should never pass secrets through
 * the audit channel in the first place, but this catches mistakes.
 *
 * `extraPatterns` lets callers extend the redactor without monkey-patching.
 */
export function redactSecrets<T>(value: T, extraPatterns: RegExp[] = []): T {
  const patterns = [...KNOWN_SECRET_PATTERNS, ...extraPatterns];

  const redactString = (s: string): string => {
    let out = s;
    for (const re of patterns) {
      // Re-create a fresh global regex per call; passing a stateful global
      // RegExp through .replace is fine, but calling it across multiple
      // strings keeps the lastIndex stable enough that we just rely on
      // .replace each time.
      out = out.replace(re, '<redacted>');
    }
    // Generic high-entropy catch-all: only redact alnum+symbol blobs that are
    // (a) long enough and (b) high-entropy enough that they can't plausibly
    // be a UUID, git SHA, or content-hash. UUIDs are ~3.9 bits/char of
    // hex+dashes; git SHAs are ~3.95 bits/char of hex; both fall under 4.5.
    out = out.replace(/[A-Za-z0-9+/=_-]{32,}/g, (match) => {
      if (shannonEntropy(match) >= 4.5) return '<redacted>';
      return match;
    });
    return out;
  };

  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') return redactString(v);
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = KEY_NAME_RE.test(k) ? '<redacted>' : visit(vv);
      }
      return out;
    }
    return v;
  };
  return visit(value) as T;
}

// Exposed only so other safety modules can keep their normalization in
// lockstep with redaction; not part of the public API stability surface.
export const _internal = { ZERO_WIDTH_RE, KEY_NAME_RE };
