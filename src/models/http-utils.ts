/**
 * Shared HTTP helpers for provider adapters.
 *
 * - AbortController-driven timeout (default 30s, capped at remaining budget).
 * - Single 429 retry that honors Retry-After (seconds or HTTP date),
 *   capped at the remaining wall-clock budget.
 */

export interface HttpOptions {
  /** Wall-clock ceiling in ms. Default 30000. */
  budgetMs?: number;
  /** Override fetch (for testing). Falls back to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export async function fetchWithTimeoutAndRetry(
  url: string,
  init: RequestInit,
  opts: HttpOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  const totalBudgetMs = opts.budgetMs ?? 30_000;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  if (!fetchImpl) throw new Error('No fetch implementation available');

  const remaining = () => Math.max(0, totalBudgetMs - (Date.now() - startedAt));

  const doFetch = async (timeoutMs: number): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(new Error('Timeout after ' + timeoutMs + 'ms')),
      timeoutMs,
    );
    try {
      const signal = mergeSignals(ac.signal, init.signal ?? undefined);
      return await fetchImpl(url, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let resp: Response;
  try {
    resp = await doFetch(remaining() || 1);
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError' || /Timeout/i.test(e?.message ?? '')) {
      throw new Error('Request timed out after ' + totalBudgetMs + 'ms', {
        cause: err,
      });
    }
    throw err;
  }

  if (resp.status !== 429) return resp;

  try {
    await resp.text();
  } catch {
    // ignore
  }

  const ra = parseRetryAfter(resp.headers.get('retry-after'));
  const remainingMs = remaining();
  if (remainingMs <= 0) {
    throw new Error('HTTP 429 and budget exhausted after retry-after parse');
  }
  const sleepMs = Math.max(0, Math.min(ra ?? 0, remainingMs));
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));

  const remaining2 = remaining();
  if (remaining2 <= 0) {
    throw new Error('HTTP 429 and budget exhausted before retry');
  }
  return doFetch(remaining2);
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function mergeSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ac = new AbortController();
  const onAbortA = () => ac.abort((a as any).reason);
  const onAbortB = () => ac.abort((b as any).reason);
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return ac.signal;
}
