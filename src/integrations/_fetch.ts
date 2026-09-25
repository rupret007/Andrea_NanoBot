/**
 * Shared timeout-wrapped fetch for integration handlers.
 *
 * All external HTTP calls in integrations should use this helper to ensure:
 * - Bounded wall-clock time (default 30s, configurable)
 * - Proper AbortController cleanup
 * - Clear timeout error messages
 *
 * This is intentionally simpler than `src/models/http-utils.ts` which also
 * handles 429 retry logic for LLM providers. Integration handlers have
 * diverse retry semantics (some should retry, others not), so we expose
 * just the timeout behavior and let each integration decide retry policy.
 */

/** Default timeout for integration fetch calls (30 seconds). */
export const INTEGRATION_FETCH_TIMEOUT_MS = 30_000;

export interface TimeoutFetchOptions {
  /** Wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Override fetch implementation (for testing). */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch with a wall-clock timeout. Aborts the request if it exceeds the
 * configured timeout, ensuring integration handlers cannot hang indefinitely
 * on slow or unresponsive endpoints.
 *
 * @param url - Request URL
 * @param init - Standard fetch RequestInit
 * @param opts - Timeout and fetch override options
 * @returns Response from the fetch call
 * @throws Error with "timeout" in message if the request times out
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  opts: TimeoutFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? INTEGRATION_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error('No fetch implementation available');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort(new Error(`Integration fetch timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const signal = init.signal
      ? mergeSignals(ac.signal, init.signal)
      : ac.signal;
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    const e = err as Error;
    if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) {
      throw new Error(`Integration request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Merge two AbortSignals into one. If either aborts, the merged signal aborts.
 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ac = new AbortController();
  const onAbortA = () =>
    ac.abort((a as AbortSignal & { reason?: unknown }).reason);
  const onAbortB = () =>
    ac.abort((b as AbortSignal & { reason?: unknown }).reason);
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return ac.signal;
}
