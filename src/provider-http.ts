const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
const MIN_PROVIDER_REQUEST_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_REQUEST_TIMEOUT_MS = 300_000;

function resolveProviderRequestTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.PROVIDER_REQUEST_TIMEOUT_MS || '',
    10,
  );
  if (!Number.isFinite(parsed)) return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  return Math.max(
    MIN_PROVIDER_REQUEST_TIMEOUT_MS,
    Math.min(parsed, MAX_PROVIDER_REQUEST_TIMEOUT_MS),
  );
}

export function providerRequestSignal(): AbortSignal | undefined {
  const timeout = (
    AbortSignal as unknown as {
      timeout?: (ms: number) => AbortSignal;
    }
  ).timeout;
  return typeof timeout === 'function'
    ? timeout(resolveProviderRequestTimeoutMs())
    : undefined;
}

export function describeProviderTransportFailure(
  providerName: string,
  err: unknown,
): string {
  if (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  ) {
    return `${providerName} request timed out before Andrea could receive a provider response.`;
  }
  const detail =
    err instanceof Error && err.message
      ? ` ${err.message.replace(/\s+/g, ' ').trim().slice(0, 160)}`
      : '';
  return `${providerName} request failed before Andrea could receive a provider response.${detail}`;
}
