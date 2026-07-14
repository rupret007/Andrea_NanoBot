export interface BackgroundReadOnlySidecar {
  /** Always resolves after result/blocker delivery or classified delivery failure. */
  completion: Promise<void>;
}

export interface BackgroundReadOnlySidecarDrainResult {
  attempted: number;
  remaining: number;
  timedOut: boolean;
}

const activeSidecars = new Set<Promise<void>>();

function trackSidecar(completion: Promise<void>): Promise<void> {
  const tracked = completion.finally(() => {
    activeSidecars.delete(tracked);
  });
  activeSidecars.add(tracked);
  return tracked;
}

/**
 * Gives graceful service restarts a bounded chance to finish already-started
 * read-only work before channel transports disconnect. A hard process crash
 * can still interrupt a sidecar; callers must never treat it as durable work.
 */
export async function drainBackgroundReadOnlySidecars(
  timeoutMs = 5_000,
): Promise<BackgroundReadOnlySidecarDrainResult> {
  const pending = [...activeSidecars];
  if (pending.length === 0) {
    return { attempted: 0, remaining: 0, timedOut: false };
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const timedOut = await Promise.race([
    Promise.allSettled(pending).then(() => false),
    new Promise<true>((resolve) => {
      timeout = setTimeout(resolve, Math.max(1, timeoutMs), true);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return {
    attempted: pending.length,
    remaining: activeSidecars.size,
    timedOut,
  };
}

async function notifyDeliveryError(
  callback: (error: unknown) => void | Promise<void>,
  error: unknown,
): Promise<void> {
  try {
    await callback(error);
    // This is the final diagnostic boundary for already-delivered work.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    // The background completion must never create an unhandled rejection, even
    // if the diagnostic callback itself is unavailable during shutdown.
  }
}

/**
 * Confirms the primary response before starting any read-only sidecar work.
 * The returned completion is observable for tests and shutdown diagnostics,
 * but is internally fail-closed and never rejects.
 */
export async function deliverPrimaryThenStartReadOnlySidecar<T>(params: {
  deliverPrimary: () => Promise<void>;
  startSidecar: (() => Promise<T>) | null;
  deliverResult: (result: T) => Promise<void>;
  deliverFailure: (error: unknown) => Promise<void>;
  onSidecarDeliveryError: (error: unknown) => void | Promise<void>;
}): Promise<BackgroundReadOnlySidecar | null> {
  if (!params.startSidecar) {
    await params.deliverPrimary();
    return null;
  }

  let releasePrimary!: () => void;
  let rejectPrimary!: (error: unknown) => void;
  const primaryDelivered = new Promise<void>((resolve, reject) => {
    releasePrimary = resolve;
    rejectPrimary = reject;
  });

  const completion = trackSidecar(
    (async (): Promise<void> => {
      try {
        await primaryDelivered;
        // Primary failure is propagated to the caller and intentionally stops
        // the already-registered sidecar lifecycle.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        return;
      }

      let result: T;
      try {
        result = await params.startSidecar!();
        // Convert execution failure into one user-visible blocker.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        try {
          await params.deliverFailure(error);
          // Delivery failure is diagnostic-only after the primary reply commits.
          // eslint-disable-next-line no-catch-all/no-catch-all
        } catch (deliveryError) {
          await notifyDeliveryError(
            params.onSidecarDeliveryError,
            deliveryError,
          );
        }
        return;
      }

      try {
        await params.deliverResult(result);
        // Delivery failure is diagnostic-only after the primary reply commits.
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (deliveryError) {
        await notifyDeliveryError(params.onSidecarDeliveryError, deliveryError);
      }
    })(),
  );

  try {
    await params.deliverPrimary();
    releasePrimary();
    // Preserve the primary delivery error for the caller while allowing the
    // tracked lifecycle to settle without starting research.
  } catch (error) {
    rejectPrimary(error);
    await completion;
    throw error;
  }

  return { completion };
}
