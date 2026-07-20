import Database from 'better-sqlite3';
import path from 'path';

import { STORE_DIR } from './config.js';
import { getRouterState, isDatabaseInitialized, setRouterState } from './db.js';
import {
  failClosedMessagingOutboundPauseState,
  MESSAGING_OUTBOUND_PAUSE_STATE_KEY,
  parseMessagingOutboundPauseState,
  validateMessagingOutboundAuthorizationFenceAgainstState,
  type MessagingOutboundAuthorizationFence,
  type MessagingOutboundAuthorizationValidation,
  type MessagingOutboundPauseState,
} from './messaging-outbound-pause-state.js';

export type {
  MessagingOutboundAuthorizationFence,
  MessagingOutboundAuthorizationValidation,
  MessagingOutboundPauseState,
} from './messaging-outbound-pause-state.js';

interface MessagingOwnerAuthorizationMessageClock {
  timestamp: string;
  ingress_received_at?: string;
}

export type MessagingOutboundPauseCommand = 'pause' | 'resume';

export function parseMessagingOutboundPauseCommand(
  rawText: string,
): MessagingOutboundPauseCommand | null {
  const text = rawText
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!text) return null;
  const isPhoneOutboundSafetyComplaint =
    /\b(?:texting|sending)\b/.test(text) &&
    /\bfrom my phone\b/.test(text) &&
    /(?:^|\s)(?:please\s+)?stop$/.test(text);
  if (
    isPhoneOutboundSafetyComplaint ||
    /^(?:stop|pause|disable|turn off) (?:all )?(?:outbound )?(?:text|texts|texting|message|messages|messaging|bluebubbles)(?: sending| sends?)?(?: now)?$/.test(
      text,
    ) ||
    /^(?:do not|don't|dont) send (?:any |anything |any more |more )?(?:texts?|messages?)(?: to anyone)?$/.test(
      text,
    ) ||
    /^stop sending (?:texts?|messages?)(?: to anyone)?$/.test(text) ||
    /^stop (?:sending|texting) (?:people|anyone|everyone|real people)$/.test(
      text,
    )
  ) {
    return 'pause';
  }
  if (
    /^(?:resume|enable|turn on) (?:all )?(?:outbound )?(?:text|texts|texting|message|messages|messaging|bluebubbles)(?: sending| sends?)?$/.test(
      text,
    ) ||
    /^(?:resume|start) sending (?:texts?|messages?)$/.test(text)
  ) {
    return 'resume';
  }
  return null;
}

export function getMessagingOutboundPauseState(): MessagingOutboundPauseState | null {
  if (!isDatabaseInitialized()) return null;
  return parseMessagingOutboundPauseState(
    getRouterState(MESSAGING_OUTBOUND_PAUSE_STATE_KEY),
  );
}

/**
 * Read the durable pause record without initializing or migrating the service
 * database. Standalone operator tools use this read-only path so a missing,
 * unreadable, or malformed store can never silently authorize a provider call.
 */
export function readMessagingOutboundPauseStateFromStore(
  databasePath = path.join(STORE_DIR, 'messages.db'),
): MessagingOutboundPauseState | null {
  let database: Database.Database | null = null;
  try {
    database = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    const row = database
      .prepare('SELECT value FROM router_state WHERE key = ? LIMIT 1')
      .get(MESSAGING_OUTBOUND_PAUSE_STATE_KEY) as
      | { value?: unknown }
      | undefined;
    if (!row) return null;
    if (typeof row.value !== 'string') {
      return failClosedMessagingOutboundPauseState();
    }
    return parseMessagingOutboundPauseState(row.value);
  } catch {
    return failClosedMessagingOutboundPauseState(
      'pause_state_unavailable_fail_closed',
    );
  } finally {
    database?.close();
  }
}

export function isMessagingOutboundPaused(): boolean {
  return getMessagingOutboundPauseState()?.paused === true;
}

/**
 * Resolve authority for work handled directly in a channel callback. Never
 * substitute callback processing time: a delayed provider update must retain
 * the immutable time carried by its ingress record or provider envelope.
 */
export function resolveInboundMessagingOwnerAuthorizationAt(
  message: MessagingOwnerAuthorizationMessageClock,
): string {
  return message.ingress_received_at || message.timestamp;
}

/**
 * Resolve authority for a durable queued turn. Telegram's server timestamp is
 * conservative across polling downtime, while BlueBubbles uses the local
 * durable receipt/sidecar-claim time rather than an untrusted provider clock.
 */
export function resolveQueuedMessagingOwnerAuthorizationAt(
  channelName: string,
  message: MessagingOwnerAuthorizationMessageClock | undefined,
): string {
  if (!message) return '';
  return channelName === 'telegram'
    ? message.timestamp
    : message.ingress_received_at || '';
}

export function captureMessagingOutboundAuthorizationFence(
  authorizationAt: string,
): MessagingOutboundAuthorizationFence {
  return {
    authorizationAt,
    pauseGeneration: getMessagingOutboundPauseState()?.pauseGeneration ?? 0,
  };
}

export function validateMessagingOutboundAuthorizationFence(
  fence: MessagingOutboundAuthorizationFence,
): MessagingOutboundAuthorizationValidation {
  if (!isDatabaseInitialized()) {
    return {
      ok: false,
      reason:
        'BlueBubbles durable owner-pause state is unavailable, so dispatch is blocked.',
    };
  }
  return validateMessagingOutboundAuthorizationFenceAgainstState(
    fence,
    getMessagingOutboundPauseState(),
  );
}

export function setMessagingOutboundPaused(params: {
  paused: boolean;
  changedByChatJid: string;
  reason: string;
  now?: Date;
}): MessagingOutboundPauseState {
  const now = params.now || new Date();
  const changedAt = now.toISOString();
  const previous = getMessagingOutboundPauseState();
  const previousLastPausedAt = previous?.lastPausedAt;
  const preservedLastPausedAt =
    typeof previousLastPausedAt === 'string' &&
    Number.isFinite(Date.parse(previousLastPausedAt))
      ? previousLastPausedAt
      : previous?.paused
        ? changedAt
        : null;
  const nextLastPausedAt = params.paused
    ? Number.isFinite(Date.parse(preservedLastPausedAt || '')) &&
      Date.parse(preservedLastPausedAt!) > now.getTime()
      ? preservedLastPausedAt
      : changedAt
    : preservedLastPausedAt;
  const previousPauseGeneration =
    previous && Number.isSafeInteger(previous.pauseGeneration)
      ? previous.pauseGeneration
      : 0;
  const crossedUnrecoverablePauseState =
    previous?.reason === 'pause_state_corrupt_fail_closed';
  const state: MessagingOutboundPauseState = {
    paused: params.paused,
    changedAt,
    changedByChatJid: params.changedByChatJid,
    reason: params.reason,
    lastPausedAt: nextLastPausedAt,
    pauseGeneration:
      params.paused || crossedUnrecoverablePauseState
        ? previousPauseGeneration + 1
        : previousPauseGeneration,
  };
  setRouterState(MESSAGING_OUTBOUND_PAUSE_STATE_KEY, JSON.stringify(state));
  return state;
}

export interface ApplyMessagingOutboundPauseCommandResult {
  applied: boolean;
  state: MessagingOutboundPauseState | null;
  reason?: string;
}

/**
 * Apply an owner-authored pause/resume command using its immutable ingress
 * clock. A stop is always honored at processing time. A resume must be newer
 * than every durable state transition and the retained last-stop boundary, so
 * delayed provider updates and replayed commands can never clear a newer stop.
 */
export function applyMessagingOutboundPauseCommand(params: {
  paused: boolean;
  changedByChatJid: string;
  reason: string;
  authorizationAt: string;
  now?: Date;
}): ApplyMessagingOutboundPauseCommandResult {
  if (params.paused) {
    return {
      applied: true,
      state: setMessagingOutboundPaused({
        paused: true,
        changedByChatJid: params.changedByChatJid,
        reason: params.reason,
        now: params.now,
      }),
    };
  }

  const previous = getMessagingOutboundPauseState();
  const authorizationAtMs = Date.parse(params.authorizationAt || '');
  if (!Number.isFinite(authorizationAtMs)) {
    return {
      applied: false,
      state: previous,
      reason: 'The resume command has no valid immutable ingress timestamp.',
    };
  }
  if (previous?.reason === 'pause_state_corrupt_fail_closed') {
    return {
      applied: false,
      state: previous,
      reason:
        'The durable outbound pause record is corrupt, so resume is blocked fail-closed.',
    };
  }

  const latestDurableBoundaryMs = Math.max(
    Number.isFinite(Date.parse(previous?.changedAt || ''))
      ? Date.parse(previous!.changedAt)
      : Number.NEGATIVE_INFINITY,
    Number.isFinite(Date.parse(previous?.lastPausedAt || ''))
      ? Date.parse(previous!.lastPausedAt!)
      : Number.NEGATIVE_INFINITY,
  );
  if (authorizationAtMs <= latestDurableBoundaryMs) {
    return {
      applied: false,
      state: previous,
      reason:
        'The resume command is older than the latest durable outbound stop or state transition.',
    };
  }

  return {
    applied: true,
    state: setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: params.changedByChatJid,
      reason: params.reason,
      now: new Date(authorizationAtMs),
    }),
  };
}
