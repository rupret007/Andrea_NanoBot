export const CONTAINER_CLOSE_GRACE_PERIOD_MS = 30_000;

const MIN_TIMEOUT_MS = 1_000;

function normalizeTimeoutMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function resolveEffectiveIdleTimeout(
  idleTimeoutMs: number,
  containerTimeoutMs: number,
): number {
  const normalizedContainerTimeout = normalizeTimeoutMs(
    containerTimeoutMs,
    CONTAINER_CLOSE_GRACE_PERIOD_MS + MIN_TIMEOUT_MS,
  );
  const normalizedIdleTimeout = normalizeTimeoutMs(
    idleTimeoutMs,
    MIN_TIMEOUT_MS,
  );

  // Ensure _close can always fire before the container hard-timeout grace window.
  const latestSafeIdleTimeout = Math.max(
    MIN_TIMEOUT_MS,
    normalizedContainerTimeout - CONTAINER_CLOSE_GRACE_PERIOD_MS,
  );

  return Math.min(normalizedIdleTimeout, latestSafeIdleTimeout);
}
