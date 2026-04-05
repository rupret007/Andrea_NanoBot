import {
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_AM_I_FORGETTING_INTENT,
  ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
} from './alexa-v1.js';
import type { AlexaConversationState } from './alexa-conversation.js';
import {
  inferResearchCapabilityId,
  isSharedResearchRequest,
  type AssistantCapabilityId,
} from './assistant-capabilities.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export interface AssistantCapabilityMatch {
  capabilityId: AssistantCapabilityId;
  normalizedText: string;
  canonicalText?: string;
  reason: string;
  continuation?: boolean;
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[!?]+$/g, '')
    .trim();
}

function matchDailyPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    lower === 'what should i know about today' ||
    lower === 'what matters today' ||
    lower === 'give me my day' ||
    lower === "what's my day looking like" ||
    lower === 'how does today look'
  ) {
    return {
      capabilityId: 'daily.morning_brief',
      normalizedText: normalized,
      canonicalText: 'what should I know about today',
      reason: 'matched morning brief phrasing',
    };
  }
  if (
    lower === 'what should i do next' ||
    lower === "what's next" ||
    lower === 'what is next' ||
    lower === 'what should i do now'
  ) {
    return {
      capabilityId: 'daily.whats_next',
      normalizedText: normalized,
      canonicalText: 'what should I do next',
      reason: 'matched what-next phrasing',
    };
  }
  if (
    lower === 'what am i forgetting' ||
    lower === 'what exactly am i forgetting' ||
    lower === 'exactly what am i forgetting' ||
    lower === "tell me what i'm forgetting" ||
    lower === 'tell me what im forgetting' ||
    lower === "what's still open"
  ) {
    return {
      capabilityId: 'daily.loose_ends',
      normalizedText: normalized,
      canonicalText: 'what am I forgetting',
      reason: 'matched loose-ends guidance phrasing',
    };
  }
  if (
    lower === 'what should i remember tonight' ||
    lower === 'give me an evening reset' ||
    lower === 'what should i handle before i leave'
  ) {
    return {
      capabilityId: 'daily.evening_reset',
      normalizedText: normalized,
      canonicalText: 'what should I remember tonight',
      reason: 'matched evening reset phrasing',
    };
  }
  return null;
}

function matchHouseholdPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    lower === 'what about candace' ||
    lower === 'what do candace and i have coming up' ||
    lower === "what's still open with candace" ||
    lower === 'what is still open with candace' ||
    lower === 'what still open with candace' ||
    lower === 'what should i talk to candace about' ||
    lower === 'what do i need to follow up on with candace'
  ) {
    return {
      capabilityId: 'household.candace_upcoming',
      normalizedText: normalized,
      canonicalText:
        lower === 'what about candace'
          ? 'what about Candace'
          : normalized,
      reason: 'matched Candace household phrasing',
    };
  }
  if (
    lower === 'anything for the family i am forgetting' ||
    lower === 'anything for the family i\'m forgetting' ||
    lower === 'what do i need to follow up on at home' ||
    lower === 'what does the family have going on'
  ) {
    return {
      capabilityId: 'household.family_open_loops',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched household follow-through phrasing',
    };
  }
  return null;
}

function matchThreadPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^what threads do i have open\b/.test(lower) ||
    /^what('?s| is) active right now\b/.test(lower)
  ) {
    return {
      capabilityId: 'threads.list_open',
      normalizedText: normalized,
      canonicalText: 'what threads do I have open',
      reason: 'matched thread listing phrasing',
    };
  }
  if (
    /^what('?s| is) still open with [a-z]/.test(lower) ||
    /^what still open with [a-z]/.test(lower) ||
    /^what('?s| is) in that thread\b/.test(lower) ||
    /^what thread are you using here\b/.test(lower) ||
    /^stop using thread context for this\b/.test(lower) ||
    /^close that thread\b/.test(lower) ||
    /^pause that thread\b/.test(lower) ||
    /^forget that thread\b/.test(lower)
  ) {
    return {
      capabilityId: 'threads.explicit_lookup',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched explicit thread phrasing',
    };
  }
  return null;
}

function matchMemoryPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^why did you say that\b/.test(lower) ||
    /^what are you using to personalize this\b/.test(lower) ||
    /^what do you remember about\b/.test(lower)
  ) {
    return {
      capabilityId: 'memory.explain',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched explainability or memory inspection phrasing',
    };
  }
  if (
    /^remember /.test(lower) ||
    /^remember that\b/.test(lower) ||
    /^be (a little |a bit )?more direct\b/.test(lower) ||
    /^lead with the main thing\b/.test(lower)
  ) {
    return {
      capabilityId: 'memory.remember',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched preference or memory save phrasing',
    };
  }
  if (
    /^forget /.test(lower) ||
    /^forget that\b/.test(lower) ||
    /^reset that preference\b/.test(lower)
  ) {
    return {
      capabilityId: 'memory.forget',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched memory removal phrasing',
    };
  }
  if (/^don'?t bring that up automatically\b/.test(lower)) {
    return {
      capabilityId: 'memory.manual_only',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched manual-only phrasing',
    };
  }
  return null;
}

export function matchAssistantCapabilityRequest(
  text: string,
): AssistantCapabilityMatch | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  return (
    matchDailyPrompt(normalized) ||
    matchHouseholdPrompt(normalized) ||
    matchThreadPrompt(normalized) ||
    matchMemoryPrompt(normalized) ||
    (isSharedResearchRequest(normalized)
      ? {
          capabilityId: inferResearchCapabilityId(normalized),
          normalizedText: normalized,
          canonicalText: normalized,
          reason: 'matched bounded research phrasing',
        }
      : null)
  );
}

export function continueAssistantCapabilityFromAlexaState(
  text: string,
  state: AlexaConversationState | undefined,
): AssistantCapabilityMatch | null {
  const normalized = normalizeText(text);
  if (!state || !normalized) return null;
  const lower = normalized.toLowerCase();
  const activeCapabilityId = state.subjectData.activeCapabilityId;

  if (/^(anything else|what else|anything more)\b/.test(lower)) {
    if (activeCapabilityId) {
      return {
        capabilityId: activeCapabilityId,
        normalizedText: normalized,
        canonicalText: 'anything else',
        reason: 'continuing the active capability with a follow-up',
        continuation: true,
      };
    }
  }

  if (/^what about candace\b/.test(lower)) {
    return {
      capabilityId: 'household.candace_upcoming',
      normalizedText: normalized,
      canonicalText: 'what about Candace',
      reason: 'switching to the Candace household capability',
      continuation: true,
    };
  }

  if (
    /^(why\b|say more\b|make that shorter\b|shorter\b|be (a little |a bit )?more direct\b)\b/.test(
      lower,
    )
  ) {
    if (activeCapabilityId && activeCapabilityId.startsWith('research.')) {
      return {
        capabilityId: activeCapabilityId,
        normalizedText: normalized,
        canonicalText: normalized,
        reason: 'continuing research capability style or depth follow-up',
        continuation: true,
      };
    }
  }

  return matchAssistantCapabilityRequest(normalized);
}

export function resolveAlexaIntentToCapability(
  intentName: string,
  options: {
    slotValue?: string;
    conversationState?: AlexaConversationState;
  } = {},
): AssistantCapabilityMatch | null {
  switch (intentName) {
    case ALEXA_MY_DAY_INTENT:
      return {
        capabilityId: 'daily.morning_brief',
        normalizedText: 'what should I know about today',
        canonicalText: 'what should I know about today',
        reason: 'mapped MyDayIntent to shared daily capability',
      };
    case ALEXA_WHAT_NEXT_INTENT:
      return {
        capabilityId: 'daily.whats_next',
        normalizedText: 'what should I do next',
        canonicalText:
          'what should I do next',
        reason: 'mapped next-step style Alexa intent to shared daily capability',
      };
    case ALEXA_WHAT_AM_I_FORGETTING_INTENT:
      return {
        capabilityId: 'daily.loose_ends',
        normalizedText: 'what am I forgetting',
        canonicalText: 'what am I forgetting',
        reason: 'mapped loose-ends Alexa intent to shared daily capability',
      };
    case ALEXA_EVENING_RESET_INTENT:
      return {
        capabilityId: 'daily.evening_reset',
        normalizedText: 'give me an evening reset',
        canonicalText: 'give me an evening reset',
        reason: 'mapped evening-style Alexa intent to shared daily capability',
      };
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return {
        capabilityId: 'household.candace_upcoming',
        normalizedText: 'what about Candace',
        canonicalText: 'what do Candace and I have coming up',
        reason: 'mapped Candace Alexa intent to shared household capability',
      };
    case ALEXA_FAMILY_UPCOMING_INTENT:
      return {
        capabilityId: 'household.family_open_loops',
        normalizedText: 'what does the family have going on',
        canonicalText: 'what does the family have going on',
        reason: 'mapped family Alexa intent to shared household capability',
      };
    case ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT:
      return continueAssistantCapabilityFromAlexaState(
        options.slotValue || '',
        options.conversationState,
      );
    case ALEXA_ANYTHING_ELSE_INTENT:
      return continueAssistantCapabilityFromAlexaState(
        'anything else',
        options.conversationState,
      );
    default:
      return null;
  }
}
