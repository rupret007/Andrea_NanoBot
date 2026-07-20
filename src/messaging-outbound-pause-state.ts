export const MESSAGING_OUTBOUND_PAUSE_STATE_KEY = 'messaging_outbound_pause_v1';

export interface MessagingOutboundPauseState {
  paused: boolean;
  changedAt: string;
  changedByChatJid: string;
  reason: string;
  /** Most recent durable owner stop boundary, retained after a resume. */
  lastPausedAt: string | null;
  /** Monotonic durable epoch advanced by every owner stop boundary. */
  pauseGeneration: number;
}

export interface MessagingOutboundAuthorizationFence {
  authorizationAt: string;
  pauseGeneration: number;
}

export interface MessagingOutboundAuthorizationValidation {
  ok: boolean;
  reason?: string;
}

export function failClosedMessagingOutboundPauseState(
  reason = 'pause_state_corrupt_fail_closed',
): MessagingOutboundPauseState {
  return {
    paused: true,
    changedAt: 'unknown',
    changedByChatJid: 'unknown',
    reason,
    lastPausedAt: null,
    pauseGeneration: 0,
  };
}

/** Parse the one durable pause record. Corruption always becomes a stop. */
export function parseMessagingOutboundPauseState(
  raw: string | null | undefined,
): MessagingOutboundPauseState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MessagingOutboundPauseState>;
    const hasValidLastPausedAt =
      parsed.lastPausedAt === null ||
      (typeof parsed.lastPausedAt === 'string' &&
        Number.isFinite(Date.parse(parsed.lastPausedAt)));
    const hasValidPauseGeneration =
      parsed.pauseGeneration === undefined ||
      (Number.isSafeInteger(parsed.pauseGeneration) &&
        Number(parsed.pauseGeneration) >= 0);
    if (
      typeof parsed.paused !== 'boolean' ||
      typeof parsed.changedAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.changedAt)) ||
      typeof parsed.changedByChatJid !== 'string' ||
      !parsed.changedByChatJid.trim() ||
      typeof parsed.reason !== 'string' ||
      !parsed.reason.trim() ||
      (parsed.lastPausedAt !== undefined && !hasValidLastPausedAt) ||
      !hasValidPauseGeneration
    ) {
      return failClosedMessagingOutboundPauseState();
    }
    return {
      ...(parsed as Omit<MessagingOutboundPauseState, 'lastPausedAt'>),
      // Backward-compatible normalization for a pause written by an older
      // build. A legacy active pause began at its own changedAt timestamp.
      lastPausedAt:
        parsed.lastPausedAt === undefined
          ? parsed.paused
            ? parsed.changedAt
            : null
          : parsed.lastPausedAt,
      pauseGeneration:
        parsed.pauseGeneration === undefined
          ? parsed.paused || parsed.lastPausedAt
            ? 1
            : 0
          : parsed.pauseGeneration,
    };
  } catch {
    return failClosedMessagingOutboundPauseState();
  }
}

export function validateMessagingOutboundAuthorizationFenceAgainstState(
  fence: MessagingOutboundAuthorizationFence,
  state: MessagingOutboundPauseState | null,
): MessagingOutboundAuthorizationValidation {
  if (state?.paused) {
    return {
      ok: false,
      reason: 'BlueBubbles outbound messaging is paused by the owner.',
    };
  }
  const authorizationAtMs = Date.parse(fence.authorizationAt || '');
  if (!Number.isFinite(authorizationAtMs)) {
    return {
      ok: false,
      reason:
        'BlueBubbles dispatch is missing a valid immutable owner-authorization timestamp.',
    };
  }
  if (
    !Number.isSafeInteger(fence.pauseGeneration) ||
    fence.pauseGeneration < 0
  ) {
    return {
      ok: false,
      reason:
        'BlueBubbles dispatch is missing a valid durable pause generation.',
    };
  }
  const currentGeneration = state?.pauseGeneration ?? 0;
  if (fence.pauseGeneration !== currentGeneration) {
    return {
      ok: false,
      reason:
        'The owner changed the Messages pause generation after this dispatch was authorized.',
    };
  }
  const lastPausedAtMs = Date.parse(state?.lastPausedAt || '');
  if (Number.isFinite(lastPausedAtMs) && authorizationAtMs <= lastPausedAtMs) {
    return {
      ok: false,
      reason:
        'This Messages dispatch was authorized before the latest owner stop boundary and needs a fresh owner action.',
    };
  }
  return { ok: true };
}
