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
    lower === 'good morning' ||
    lower === 'what should i know about today' ||
    lower === 'what matters today' ||
    lower === 'what should i know this morning' ||
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
    lower === 'anything i should know' ||
    lower === 'what should i follow up on' ||
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

function matchHouseholdPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
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
        lower === 'what about candace' ? 'what about Candace' : normalized,
      reason: 'matched Candace household phrasing',
    };
  }
  if (
    lower === 'anything for the family i am forgetting' ||
    lower === "anything for the family i'm forgetting" ||
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

function matchThreadPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
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

function matchMemoryPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
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
    /^lead with the main thing\b/.test(lower) ||
    /^be (a little |a bit )?warmer\b/.test(lower) ||
    /^sound (a little |a bit )?warmer\b/.test(lower) ||
    /^keep it plain\b/.test(lower) ||
    /^be plainer\b/.test(lower) ||
    /^be less warm\b/.test(lower) ||
    /^go back to balanced\b/.test(lower) ||
    /^normal tone\b/.test(lower) ||
    /^keep it balanced\b/.test(lower)
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

function matchPulsePrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    lower === 'andrea pulse' ||
    lower === 'pulse' ||
    lower === 'surprise me'
  ) {
    return {
      capabilityId: 'pulse.surprise_me',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched Andrea Pulse surprise phrasing',
    };
  }
  if (
    lower === 'tell me something interesting' ||
    lower === 'give me a weird fact' ||
    lower === 'one little thing to know today' ||
    lower === 'tell me a fun fact'
  ) {
    return {
      capabilityId: 'pulse.interesting_thing',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched interesting-thing Pulse phrasing',
    };
  }
  return null;
}

function matchRitualPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (/^what rituals do i have enabled\b/.test(lower)) {
    return {
      capabilityId: 'rituals.status',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched ritual status phrasing',
    };
  }
  if (
    /^what follow-?ups am i carrying right now\b/.test(lower) ||
    /^what have i been putting off\b/.test(lower) ||
    /^show me my carryover threads\b/.test(lower) ||
    /^what('?s| is) still open right now\b/.test(lower)
  ) {
    return {
      capabilityId: 'rituals.followthrough',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched follow-through ritual phrasing',
    };
  }
  if (
    /^stop doing that\b/.test(lower) ||
    /^don'?t remind me like that\b/.test(lower) ||
    /^make the morning brief shorter\b/.test(lower) ||
    /^stop surfacing family context automatically\b/.test(lower) ||
    /^reset my routine preferences\b/.test(lower) ||
    /^make this part of my evening reset\b/.test(lower) ||
    /^(enable|turn on|start) (the )?(morning brief|midday re-grounding|midday reground|evening reset|follow-through prompts|household check-ins|leave prompt)\b/.test(
      lower,
    )
  ) {
    return {
      capabilityId: 'rituals.configure',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched ritual configuration phrasing',
    };
  }
  return null;
}

function matchKnowledgePrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^save (?:this|that|this note|that note|this result|that result|this summary|that summary) to my library\b/.test(
      lower,
    ) ||
    /^(?:save|add|import|index) (?:the )?(?:file|document) /.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.save_source',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched explicit library save phrasing',
    };
  }
  if (
    /^what sources are you using\b/.test(lower) ||
    /^explain why this source was chosen\b/.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.explain_sources',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source explainability phrasing',
    };
  }
  if (
    /^show me the relevant saved items\b/.test(lower) ||
    /^what have i saved about\b/.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.list_sources',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source listing phrasing',
    };
  }
  if (
    /^compare these saved sources\b/.test(lower) ||
    /^compare my saved (?:notes|sources|material)\b/.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.compare_saved',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source comparison phrasing',
    };
  }
  if (
    /^what do my saved notes say about\b/.test(lower) ||
    /^what did i save about\b/.test(lower) ||
    /^summari[sz]e what i saved about\b/.test(lower) ||
    /^what do i already know about\b/.test(lower) ||
    /^use only my saved material\b/.test(lower) ||
    /^combine my notes with outside research\b/.test(lower)
  ) {
    return {
      capabilityId: /\bcompare\b/.test(lower)
        ? 'knowledge.compare_saved'
        : 'knowledge.summarize_saved',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched source-grounded knowledge-library phrasing',
    };
  }
  if (
    /^stop using that source\b/.test(lower) ||
    /^disable that source\b/.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.disable_source',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source disable phrasing',
    };
  }
  if (
    /^forget this source\b/.test(lower) ||
    /^delete this source\b/.test(lower)
  ) {
    return {
      capabilityId: 'knowledge.delete_source',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source delete phrasing',
    };
  }
  if (/^reindex this\b/.test(lower) || /^reindex that source\b/.test(lower)) {
    return {
      capabilityId: 'knowledge.reindex_source',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched saved-source reindex phrasing',
    };
  }
  return null;
}

function matchMediaPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  const match = lower.match(
    /^(?:generate|create|make) (?:an |a )?image of (.+)$|^draw (.+)$|^illustrate (.+)$/i,
  );
  const prompt = match?.[1] || match?.[2] || match?.[3];
  if (!prompt) return null;
  return {
    capabilityId: 'media.image_generate',
    normalizedText: normalized,
    canonicalText: prompt.trim(),
    reason: 'matched bounded image-generation phrasing',
  };
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
    matchPulsePrompt(normalized) ||
    matchRitualPrompt(normalized) ||
    matchKnowledgePrompt(normalized) ||
    matchMediaPrompt(normalized) ||
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
    /^(why\b|why did you choose that route\b|what path did you use\b|say more\b|make that shorter\b|shorter\b|be (a little |a bit )?more direct\b)\b/.test(
      lower,
    )
  ) {
    if (
      activeCapabilityId &&
      (activeCapabilityId.startsWith('research.') ||
        activeCapabilityId.startsWith('pulse.') ||
        activeCapabilityId.startsWith('knowledge.'))
    ) {
      return {
        capabilityId: activeCapabilityId,
        normalizedText: normalized,
        canonicalText: normalized,
        reason: 'continuing research capability style or depth follow-up',
        continuation: true,
      };
    }
  }

  if (
    /^(send (?:me )?(?:the )?(?:details|full version|full comparison)(?: to telegram)?|send (?:that|it) to telegram|also send (?:that|it) to telegram|give me the deeper comparison in telegram|save (?:that|it|this) (?:in|to) my library|save (?:that|it|this) to the library|save (?:that|it|this) for later|remember (?:that|it|this) for later|track (?:that|it|this)(?: under .+)?|keep track of (?:that|it|this)(?: under .+| for tonight)?|turn (?:that|it|this) into a reminder|remind me about (?:that|it|this)|draft that for me|draft a message about (?:that|it|this))\b/.test(
      lower,
    )
  ) {
    return null;
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
        canonicalText: 'what should I do next',
        reason:
          'mapped next-step style Alexa intent to shared daily capability',
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
