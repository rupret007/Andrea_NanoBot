import {
  clearAlexaConversationContext as clearAlexaConversationContextRecord,
  getAlexaConversationContext,
  purgeExpiredAlexaConversationContexts,
  upsertAlexaConversationContext,
} from './db.js';
import {
  type AlexaConversationContext,
  type AlexaConversationFollowupAction,
  type AlexaConversationSubjectKind,
} from './types.js';

export interface AlexaConversationSubjectData {
  personName?: string;
  meetingReference?: string;
  profileFactId?: string;
  savedText?: string;
}

export interface AlexaConversationState {
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  subjectData: AlexaConversationSubjectData;
  summaryText: string;
  supportedFollowups: AlexaConversationFollowupAction[];
  styleHints: {
    responseStyle?: 'default' | 'short_direct';
  };
}

export interface AlexaConversationFollowupResolution {
  ok: boolean;
  action?: AlexaConversationFollowupAction;
  text?: string;
  speech?: string;
}

const DEFAULT_ALEXA_CONVERSATION_TTL_MS = 10 * 60 * 1000;

function parseJsonSafe<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseAlexaConversationState(
  record: AlexaConversationContext | undefined,
): AlexaConversationState | undefined {
  if (!record) return undefined;
  return {
    flowKey: record.flowKey,
    subjectKind: record.subjectKind,
    subjectData: parseJsonSafe<AlexaConversationSubjectData>(
      record.subjectJson,
      {},
    ),
    summaryText: record.summaryText,
    supportedFollowups: parseJsonSafe<AlexaConversationFollowupAction[]>(
      record.supportedFollowupsJson,
      [],
    ),
    styleHints: parseJsonSafe<AlexaConversationState['styleHints']>(
      record.styleJson,
      {},
    ),
  };
}

export function loadAlexaConversationState(
  principalKey: string,
  accessTokenHash: string,
  now = new Date().toISOString(),
): AlexaConversationState | undefined {
  purgeExpiredAlexaConversationContexts(now);
  return parseAlexaConversationState(
    getAlexaConversationContext(principalKey, accessTokenHash, now),
  );
}

export function saveAlexaConversationState(
  principalKey: string,
  accessTokenHash: string,
  groupFolder: string,
  state: AlexaConversationState,
  ttlMs = DEFAULT_ALEXA_CONVERSATION_TTL_MS,
  now = new Date(),
): AlexaConversationContext {
  const record: AlexaConversationContext = {
    principalKey,
    accessTokenHash,
    groupFolder,
    flowKey: state.flowKey,
    subjectKind: state.subjectKind,
    subjectJson: JSON.stringify(state.subjectData || {}),
    summaryText: state.summaryText,
    supportedFollowupsJson: JSON.stringify(state.supportedFollowups || []),
    styleJson: JSON.stringify(state.styleHints || {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    updatedAt: now.toISOString(),
  };
  upsertAlexaConversationContext(record);
  return record;
}

export function clearAlexaConversationState(principalKey: string): void {
  clearAlexaConversationContextRecord(principalKey);
}

export function getAlexaConversationReferencedFactId(
  state: AlexaConversationState | undefined,
): string | undefined {
  return state?.subjectData.profileFactId?.trim() || undefined;
}

export function resolveAlexaConversationFollowup(
  rawText: string,
  state: AlexaConversationState | undefined,
): AlexaConversationFollowupResolution {
  const text = rawText.trim();
  const normalized = text.toLowerCase();
  if (!state) {
    return {
      ok: false,
      speech:
        'I am not holding onto enough context for that yet. Please restate what you want.',
    };
  }

  const supported = new Set(state.supportedFollowups);
  const resolveSupported = (
    action: AlexaConversationFollowupAction,
    nextText = text,
  ): AlexaConversationFollowupResolution =>
    supported.has(action)
      ? { ok: true, action, text: nextText }
      : {
          ok: false,
          speech:
            'I do not have a strong enough handle on that part yet. Please say it directly one more time.',
        };

  if (/^(anything else|anything more|what else)\b/i.test(normalized)) {
    return resolveSupported('anything_else');
  }
  if (/^(make that shorter|shorter|say that shorter)\b/i.test(normalized)) {
    return resolveSupported('shorter');
  }
  if (
    /^(what('?s| is)? next after that|what next after that|after that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('after_that');
  }
  if (
    /^(what should i handle before that|before that|what about before that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('before_that');
  }
  if (/^(remind me before that)\b/i.test(normalized)) {
    return resolveSupported('remind_before_that');
  }
  if (/^(save that for later|save that)\b/i.test(normalized)) {
    return resolveSupported('save_that');
  }
  if (/^(draft a follow up for this meeting|draft a follow up)\b/i.test(normalized)) {
    return resolveSupported('draft_followup');
  }
  if (
    /^(what about [a-z][a-z' -]+)\b/i.test(normalized) ||
    /^what about candace\b/i.test(normalized)
  ) {
    return resolveSupported('switch_person');
  }
  if (
    /^(remember this|remember that|forget that|stop using that|what do you remember\b)/i.test(
      normalized,
    )
  ) {
    return resolveSupported('memory_control');
  }

  return {
    ok: false,
    speech:
      'I am not confident about that follow-up yet. Please say it a little more directly.',
  };
}
