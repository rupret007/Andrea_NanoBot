import {
  clearAlexaConversationContext as clearAlexaConversationContextRecord,
  getAlexaConversationContext,
  purgeExpiredAlexaConversationContexts,
  upsertAlexaConversationContext,
} from './db.js';
import {
  type AlexaCompanionGuidanceGoal,
  type AlexaConversationContext,
  type AlexaConversationFollowupAction,
  type AlexaConversationSubjectKind,
} from './types.js';
import type { AssistantCapabilityId } from './assistant-capabilities.js';

export interface AlexaConversationSubjectData {
  personName?: string;
  activePeople?: string[];
  householdFocus?: boolean;
  meetingReference?: string;
  profileFactId?: string;
  savedText?: string;
  threadId?: string;
  threadTitle?: string;
  threadSummaryLines?: string[];
  dailyCompanionContextJson?: string;
  fallbackCount?: number;
  lastAnswerSummary?: string;
  lastRecommendation?: string;
  pendingActionText?: string;
  conversationFocus?: string;
  activeCapabilityId?: AssistantCapabilityId;
  researchHandoffEligible?: boolean;
}

export interface AlexaConversationState {
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  subjectData: AlexaConversationSubjectData;
  summaryText: string;
  supportedFollowups: AlexaConversationFollowupAction[];
  styleHints: {
    responseStyle?: 'default' | 'short_direct' | 'expanded';
    channelMode?: 'alexa_companion';
    guidanceGoal?: AlexaCompanionGuidanceGoal;
    initiativeLevel?: 'measured';
    prioritizationLens?:
      | 'general'
      | 'calendar'
      | 'family'
      | 'meeting'
      | 'work'
      | 'evening';
    hasActionItem?: boolean;
    hasRiskSignal?: boolean;
    reminderCandidate?: boolean;
    responseSource?: 'assistant_bridge' | 'local_companion';
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
        'I need one quick anchor first. Ask about today, Candace, or what to remember tonight.',
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
            state.subjectData.personName
              ? `I am not quite sure which part you mean. Was that still about ${state.subjectData.personName}, or something else?`
              : 'I am not quite sure which part you mean yet. Please say it a little more directly.',
        };

  if (/^(anything else|anything more|what else)\b/i.test(normalized)) {
    return resolveSupported('anything_else');
  }
  if (
    /^(make that shorter|shorter|say that shorter|keep it shorter|make it tighter)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('shorter');
  }
  if (
    /^(say more|tell me more|give me a little more detail|go a little deeper|give me more detail)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('say_more');
  }
  if (
    /^(what('?s| is)? next after that|what next after that|what comes after that|after that)\b/i.test(
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
  if (
    /^(save that for later|save that|help me remember that tonight|remember that|remember this)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('save_that');
  }
  if (
    /^(what should i do about that|what should i handle about that|what do i do about that|what should i do with that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('action_guidance');
  }
  if (/^(should i be worried about anything|is there anything i should worry about)\b/i.test(normalized)) {
    return resolveSupported('risk_check');
  }
  if (/^(draft a follow up for this meeting|draft a follow up)\b/i.test(normalized)) {
    return resolveSupported('draft_followup');
  }
  if (/^(what should i message someone about|what should i follow up about)\b/i.test(normalized)) {
    return supported.has('draft_followup')
      ? resolveSupported('draft_followup')
      : resolveSupported('action_guidance');
  }
  if (
    /^(what about [a-z][a-z' -]+)\b/i.test(normalized) ||
    /^what about candace\b/i.test(normalized)
  ) {
    return resolveSupported('switch_person');
  }
  if (
    /^(forget that|stop using that|what do you remember\b|why\b|why did you say that|what are you using to personalize this|reset that preference|be more direct|be a little more direct|be a bit more direct|don'?t bring that up automatically|stop bringing that up)/i.test(
      normalized,
    )
  ) {
    return resolveSupported('memory_control');
  }

  return {
    ok: false,
    speech:
      state.subjectData.personName
        ? `I am not quite sure which part you mean. You can ask what is still open with ${state.subjectData.personName}, say say more, or ask it a different way.`
        : 'I did not quite get that follow-up. You can say anything else, say more, or ask it a different way.',
  };
}
