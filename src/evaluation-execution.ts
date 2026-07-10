export type EvaluationExecutionMode = 'deterministic' | 'live';

export interface EvaluationExecutionPolicy {
  mode: EvaluationExecutionMode;
  maxCostUsd: number;
  network: 'loopback_only' | 'enabled';
}

export interface EvaluationExecutionOptions {
  mode?: EvaluationExecutionMode;
  maxCostUsd?: number;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function resolveEvaluationExecutionPolicy(
  options: EvaluationExecutionOptions = {},
): EvaluationExecutionPolicy {
  const mode = options.mode ?? 'deterministic';
  const requestedBudget = options.maxCostUsd ?? 0;
  if (mode === 'live') {
    if (!Number.isFinite(requestedBudget) || requestedBudget <= 0) {
      throw new Error(
        'Live evaluation requires an explicit nonzero maxCostUsd budget.',
      );
    }
    return { mode, maxCostUsd: requestedBudget, network: 'enabled' };
  }
  if (requestedBudget !== 0) {
    throw new Error('Deterministic evaluation must have a zero cost budget.');
  }
  return { mode, maxCostUsd: 0, network: 'loopback_only' };
}

export function assertEvaluationCostWithinBudget(
  policy: EvaluationExecutionPolicy,
  estimatedCostUsd: number,
): void {
  if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
    throw new Error('Evaluation produced invalid cost metadata.');
  }
  if (estimatedCostUsd > policy.maxCostUsd) {
    throw new Error(
      `Evaluation cost $${estimatedCostUsd.toFixed(4)} exceeded the $${policy.maxCostUsd.toFixed(4)} cap.`,
    );
  }
}

export function assertLoopbackEvaluationRequest(input: unknown): void {
  const raw =
    typeof input === 'string' || input instanceof URL
      ? String(input)
      : input instanceof Request
        ? input.url
        : String(input);
  const url = new URL(raw);
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `Deterministic evaluation blocked non-loopback request to ${url.origin}`,
    );
  }
}

export function loopbackOnlyFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    assertLoopbackEvaluationRequest(input);
    return fetchImpl(input, init);
  }) as typeof fetch;
}

export async function withProcessFetch<T>(
  fetchImpl: typeof fetch,
  operation: () => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await operation();
  } finally {
    globalThis.fetch = previousFetch;
  }
}
