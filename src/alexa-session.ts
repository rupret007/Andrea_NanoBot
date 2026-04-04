import {
  clearAlexaSession,
  getAlexaSession,
  purgeExpiredAlexaSessions,
  upsertAlexaSession,
} from './db.js';
import {
  type AlexaPendingSession,
  type AlexaPendingSessionKind,
} from './types.js';

export interface AlexaPendingSessionPayload {
  leadTimeText?: string;
  captureText?: string;
  meetingReference?: string;
  profileFactId?: string;
  profileAskText?: string;
}

const DEFAULT_ALEXA_SESSION_TTL_MS = 10 * 60 * 1000;

export function parseAlexaSessionPayload(
  session: AlexaPendingSession | undefined,
): AlexaPendingSessionPayload {
  if (!session) return {};
  try {
    return JSON.parse(session.payloadJson) as AlexaPendingSessionPayload;
  } catch {
    return {};
  }
}

export function loadAlexaPendingSession(
  principalKey: string,
  accessTokenHash: string,
  now = new Date().toISOString(),
): AlexaPendingSession | undefined {
  purgeExpiredAlexaSessions(now);
  return getAlexaSession(principalKey, accessTokenHash, now);
}

export function saveAlexaPendingSession(
  principalKey: string,
  accessTokenHash: string,
  pendingKind: AlexaPendingSessionKind,
  payload: AlexaPendingSessionPayload,
  ttlMs = DEFAULT_ALEXA_SESSION_TTL_MS,
  now = new Date(),
): AlexaPendingSession {
  const record: AlexaPendingSession = {
    principalKey,
    accessTokenHash,
    pendingKind,
    payloadJson: JSON.stringify(payload),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    updatedAt: now.toISOString(),
  };
  upsertAlexaSession(record);
  return record;
}

export function clearAlexaPendingSession(principalKey: string): void {
  clearAlexaSession(principalKey);
}
