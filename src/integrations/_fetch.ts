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
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(new Error(`Integration fetch timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const merged = init.signal ? mergeSignals(ac.signal, init.signal) : null;
  try {
    const signal = merged ? merged.signal : ac.signal;
    const res = await fetchImpl(url, { ...init, signal });
    // Keep the deadline active through body consumption: buffer the body
    // inside the timeout window so a stalled body cannot hang the caller.
    if (res.body === null) return res;
    const body = await res.arrayBuffer();
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err) {
    // Only an abort caused by our own timer is reported as a timeout;
    // caller cancellation and other errors propagate unchanged.
    if (timedOut) {
      throw new Error(`Integration request timed out after ${timeoutMs}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    merged?.cleanup();
  }
}

/**
 * Merge two AbortSignals into one. If either aborts, the merged signal aborts.
 * `cleanup` removes the listeners so long-lived caller signals do not leak.
 */
function mergeSignals(
  a: AbortSignal,
  b: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  if (a.aborted) return { signal: a, cleanup: () => {} };
  if (b.aborted) return { signal: b, cleanup: () => {} };
  const ac = new AbortController();
  const onAbortA = () => ac.abort(a.reason);
  const onAbortB = () => ac.abort(b.reason);
  a.addEventListener('abort', onAbortA, { once: true });
  b.addEventListener('abort', onAbortB, { once: true });
  return {
    signal: ac.signal,
    cleanup: () => {
      a.removeEventListener('abort', onAbortA);
      b.removeEventListener('abort', onAbortB);
    },
  };
}
