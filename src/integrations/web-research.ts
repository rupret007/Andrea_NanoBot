/**
 * Web research integration. Wraps a search API and a fetch+extract pipeline,
 * because "Andrea, find me X" is the most-used research request and
 * deserves first-class tooling rather than ad-hoc browser automation for
 * every lookup.
 *
 * Adapter prefers the Exa API if keys are set, falls back to a
 * `fetch + readability + html-to-text` pipeline against any URL the
 * frontier search returned.
 *
 * Safety: the `fetch` tool is an SSRF-tempting surface. We:
 *   - reject non-`https:` schemes (allow `http:` only with
 *     `ANDREA_ALLOW_HTTP=1`),
 *   - resolve DNS and reject any address in the loopback / link-local /
 *     private / multicast / unspecified ranges,
 *   - cap response bodies at 5 MB,
 *   - cap wall-clock time at 10 s via AbortController.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { redactForError } from './_redact.js';
import type { Integration, RegisteredTool } from './types.js';

export const FETCH_TIMEOUT_MS = 10_000;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;

export const WebResearchIntegration: Integration = {
  id: 'web',
  displayName: 'Web Research',
  enabled: true,

  async init(ctx) {
    const exa = await ctx.secrets.get('EXA_API_KEY');
    const brave = await ctx.secrets.get('BRAVE_API_KEY');
    if (!exa && !brave) throw new Error('Set EXA_API_KEY or BRAVE_API_KEY');
  },

  async register(ctx): Promise<RegisteredTool[]> {
    return [
      {
        integrationId: 'web',
        name: 'search',
        description:
          'Search the web. Returns ranked results with title/url/snippet. Use this before reading any URL.',
        effect: 'read',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            freshness: { type: 'string' },
          },
          required: ['query'],
        },
        handler: async (args) => {
          const exa = await ctx.secrets.get('EXA_API_KEY');
          if (exa) {
            const r = await fetch('https://api.exa.ai/search', {
              method: 'POST',
              headers: { 'x-api-key': exa, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                query: args.query,
                numResults: 10,
                useAutoprompt: true,
              }),
            });
            if (!r.ok)
              throw new Error(
                `Exa ${r.status}: ${redactForError(await r.text())}`,
              );
            return r.json();
          }
          const brave = await ctx.secrets.get('BRAVE_API_KEY');
          const r = await fetch(
            `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(args.query))}`,
            { headers: { 'X-Subscription-Token': brave ?? '' } },
          );
          if (!r.ok)
            throw new Error(
              `Brave ${r.status}: ${redactForError(await r.text())}`,
            );
          return r.json();
        },
      },
      {
        integrationId: 'web',
        name: 'fetch',
        description:
          'Fetch a single URL and return clean text. Use this only AFTER `search` and only on URLs from the search result.',
        effect: 'external',
        cost: 'cheap',
        schema: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
        handler: async (args) => {
          const url = String(args.url);
          await assertSafeUrl(url);
          const { text } = await safeFetchText(url);
          return { url, text: text.slice(0, 50_000) };
        },
      },
    ];
  },
};

/**
 * SSRF guard. Throws a clear Error if the URL is unsafe to fetch.
 * Public for testing.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid URL: ${rawUrl}`, { cause: err });
  }
  const allowHttp = process.env.ANDREA_ALLOW_HTTP === '1';
  if (u.protocol === 'http:') {
    if (!allowHttp)
      throw new Error(
        'Refusing http:// fetch; set ANDREA_ALLOW_HTTP=1 to allow',
      );
  } else if (u.protocol !== 'https:') {
    throw new Error(`Refusing ${u.protocol} fetch (only https/http supported)`);
  }
  const host = u.hostname;
  if (!host) throw new Error('URL has no hostname');

  // If host is a literal IP, check it directly.
  const literal = parseLiteralIp(host);
  const candidates: string[] = literal ? [literal] : [];
  if (!literal) {
    let resolved: { address: string; family: number }[] = [];
    try {
      resolved = await dnsLookup(host, { all: true });
    } catch (err) {
      throw new Error(
        `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    for (const r of resolved) candidates.push(r.address);
  }
  for (const ip of candidates) {
    if (isBlockedIp(ip)) {
      throw new Error(`Refusing fetch to blocked address ${ip} (${host})`);
    }
  }
}

/** Strip surrounding brackets from a bracketed IPv6 literal hostname. */
function parseLiteralIp(host: string): string | undefined {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  // Plain IPv4 literal? "1.2.3.4"
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  // Plain IPv6 literal? Must contain a colon and only hex/colon chars.
  if (host.includes(':') && /^[0-9a-fA-F:]+$/.test(host)) return host;
  return undefined;
}

/** Return true if ip is in any blocked range. */
export function isBlockedIp(ip: string): boolean {
  if (ip.includes(':')) return isBlockedIPv6(ip);
  return isBlockedIPv4(ip);
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)
  ) {
    // Unparseable — treat as blocked (defense-in-depth).
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // unspecified / "this network"
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT 100.64.0.0/10
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a >= 224 && a <= 239) return true; // multicast 224.0.0.0/4
  if (a >= 240) return true; // reserved + broadcast
  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback ::1
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified ::
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // Link-local fe80::/10
  if (/^fe[89ab]/.test(lower)) return true;
  // Unique-local fc00::/7
  if (/^f[cd]/.test(lower)) return true;
  // Multicast ff00::/8
  if (/^ff/.test(lower)) return true;
  // IPv4-mapped ::ffff:127.0.0.1 etc — recurse on the v4 portion
  const v4Mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(lower);
  if (v4Mapped) return isBlockedIPv4(v4Mapped[1]);
  return false;
}

/**
 * Fetch a URL with timeout + size cap, return cleaned text.
 * Public for testing (call assertSafeUrl yourself first if untrusted).
 */
export async function safeFetchText(
  url: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ text: string; truncated: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let r: Response | undefined;
  let currentUrl = url;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      r = await f(currentUrl, {
        headers: { 'User-Agent': 'Andrea-NanoBot/1.0 (+research)' },
        signal: ac.signal,
        redirect: 'manual',
      });
      if (r.status < 300 || r.status >= 400) break;
      const location = r.headers.get('location');
      if (!location) break;
      const nextUrl = new URL(location, currentUrl).toString();
      await assertSafeUrl(nextUrl);
      currentUrl = nextUrl;
      if (redirects === 5) {
        throw new Error('Too many redirects');
      }
    }
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`Fetch timeout after ${FETCH_TIMEOUT_MS}ms`, {
        cause: err,
      });
    }
    throw err;
  }
  if (!r) throw new Error('Fetch failed before receiving a response');
  if (!r.ok) {
    clearTimeout(timer);
    throw new Error(`HTTP ${r.status}`);
  }
  // Stream the body so we can enforce size cap without buffering >5MB.
  let truncated = false;
  let total = 0;
  const chunks: Uint8Array[] = [];
  const body = r.body;
  if (body) {
    const reader = body.getReader();
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (total + value.byteLength > FETCH_MAX_BYTES) {
          const remaining = FETCH_MAX_BYTES - total;
          if (remaining > 0) chunks.push(value.subarray(0, remaining));
          total = FETCH_MAX_BYTES;
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } finally {
      clearTimeout(timer);
    }
  } else {
    clearTimeout(timer);
    // No streaming body — fall back to text() within size cap.
    const t = await r.text();
    const slice = t.slice(0, FETCH_MAX_BYTES);
    return { text: cleanHtml(slice), truncated: t.length > FETCH_MAX_BYTES };
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: cleanHtml(buf.toString('utf8')), truncated };
}

function cleanHtml(html: string): string {
  return stripElementBlocks(stripElementBlocks(html, 'script'), 'style')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripElementBlocks(html: string, tagName: 'script' | 'style'): string {
  let output = html;
  let lower = output.toLowerCase();
  const startNeedle = `<${tagName}`;
  const endNeedle = `</${tagName}`;
  let searchFrom = 0;

  while (searchFrom < lower.length) {
    const start = lower.indexOf(startNeedle, searchFrom);
    if (start < 0) break;

    const startNameEnd = start + startNeedle.length;
    const afterName = lower[startNameEnd] ?? '';
    if (afterName && !/[\s>/]/.test(afterName)) {
      searchFrom = startNameEnd;
      continue;
    }

    const startTagEnd = lower.indexOf('>', startNameEnd);
    if (startTagEnd < 0) {
      output = output.slice(0, start);
      break;
    }

    const endStart = lower.indexOf(endNeedle, startTagEnd + 1);
    if (endStart < 0) {
      output = output.slice(0, start);
      break;
    }

    const endTagEnd = lower.indexOf('>', endStart + endNeedle.length);
    if (endTagEnd < 0) {
      output = output.slice(0, start);
      break;
    }

    output = output.slice(0, start) + output.slice(endTagEnd + 1);
    lower = output.toLowerCase();
    searchFrom = start;
  }

  return output;
}
