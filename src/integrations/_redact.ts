/**
 * Local redactor for integration error strings.
 *
 * Duplicates the logic from `safety/audit-log.ts` to avoid a circular import
 * between the integrations subsystem and the safety subsystem. Both must
 * stay in sync; if one changes, update the other.
 *
 * Used to scrub secrets out of `await r.text()` bodies and headers before
 * they get embedded in thrown Error messages that may be logged or shown
 * to the user.
 */

const SECRET_RE =
  /\b([A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9_.-]+/gi;
const AUTHZ_HEADER_RE = /Authorization\s*:\s*[^\r\n,"]+/gi;

/** Scrub secrets out of a free-form string. */
export function redactString(s: string): string {
  return s
    .replace(AUTHZ_HEADER_RE, 'Authorization: <redacted>')
    .replace(BEARER_RE, 'Bearer <redacted>')
    .replace(SECRET_RE, '<redacted>');
}

/** Scrub then truncate. Use when embedding response bodies in Error messages. */
export function redactForError(s: string, maxLen = 500): string {
  const r = redactString(s);
  return r.length > maxLen ? r.slice(0, maxLen) + '...<truncated>' : r;
}
