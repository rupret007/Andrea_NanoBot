import {
  ALEXA_COMPANION_GUIDANCE_INTENT,
  ALEXA_CONVERSATION_CONTROL_INTENT,
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_OPEN_ASK_INTENT,
  ALEXA_PEOPLE_HOUSEHOLD_INTENT,
  ALEXA_PLANNING_ORIENTATION_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_SAVE_REMIND_HANDOFF_INTENT,
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
import {
  parseAllSyncedMessagesSummaryIntent,
  looksLikeGenericThreadSummaryPrompt,
  parseThreadSummaryIntent,
} from './thread-summary-routing.js';
import type { CompanionRouteArguments } from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export interface AssistantCapabilityMatch {
  capabilityId: AssistantCapabilityId;
  normalizedText: string;
  canonicalText?: string;
  arguments?: CompanionRouteArguments;
  reason: string;
  continuation?: boolean;
}

export interface AssistantCapabilityContinuationSubjectData {
  activeCapabilityId?: AssistantCapabilityId;
  activeTaskKind?: string;
  activeListGroupId?: string;
}

function stripAndreaAddressing(value: string): string {
  return value
    .replace(/(^|[\s([{-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value: string | undefined): string {
  return stripAndreaAddressing(
    normalizeVoicePrompt(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[!?]+$/g, '')
      .trim(),
  );
}

function isBareAlexaReference(value: string): boolean {
  return /^(that|this|it|there|something)$/i.test(value.trim());
}

function isWeakAlexaReference(value: string): boolean {
  return /^(that|this|it|there|something|what about it|what about that|what should i know|why)\b/i.test(
    value.trim(),
  );
}

function isReferenceBoundSavePrompt(value: string): boolean {
  return /^(that|this|it|the details|details|the full version|the fuller version|the plan)$/i.test(
    value.trim(),
  );
}

function isBareCommunicationDraftFollowup(value: string): boolean {
  return /^(?:what should i say back|what should i send back|draft that for me|give me a short reply|make (?:it|that)(?: a little)? warmer|warmer|make (?:it|that) more direct|more direct|make (?:it|that) less stiff|less stiff|make (?:it|that) more blunt|more blunt)[?.! ]*$/i.test(
    value.trim(),
  );
}

function isAlexaLocalVoiceAsk(value: string): boolean {
  return /^(what time is it|what day is it|what'?s up|whats up|can you help me|help me|what can you do)$/i.test(
    value.trim(),
  );
}

function matchProfileSetupPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^help me set this up\b/.test(lower) ||
    /^walk me through what you should track for me\b/.test(lower) ||
    /^update my setup\b/.test(lower) ||
    /^change what you track\b/.test(lower)
  ) {
    return {
      capabilityId: 'capture.profile_setup',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched personal operating profile setup phrasing',
    };
  }
  if (/^show me my current setup\b/.test(lower)) {
    return {
      capabilityId: 'capture.profile_review',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched operating profile review phrasing',
    };
  }
  return null;
}

function matchEverydayCapturePrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (lower.startsWith('ev:v:')) {
    return {
      capabilityId: 'capture.read_items',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday capture view action',
    };
  }
  if (lower.startsWith('ev:c:')) {
    return {
      capabilityId: 'capture.convert_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday capture convert action',
    };
  }
  if (lower.startsWith('ev:')) {
    return {
      capabilityId: 'capture.update_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday capture item action',
    };
  }
  if (
    /^(add milk to my shopping list|put batteries on my list|save this as an errand|add pay water bill to my list|add dinner idea for friday|add my pills to tonight|track that for the household|put that on the weekend list)\b/.test(
      lower,
    ) ||
    /^(?:add|put)\b.+\b(?:shopping list|grocery list|on my list|to tonight|to groceries|under groceries|under household|under bills|under meals|weekend list)\b/.test(
      lower,
    ) ||
    /^save (?:this|that).+\b(?:as an errand|under)\b/.test(lower) ||
    /^(?:remember this|save this as a list item)\b/.test(lower)
  ) {
    return {
      capabilityId: 'capture.add_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday capture phrasing',
    };
  }
  if (
    /^(show me (?:my )?(?:grocery|shopping) list|what('?s| is) on my (?:grocery|shopping) list|what('?s| is) on my list|what('?s| is) on groceries|what do (?:we|i) need from the store(?: again)?|what do i still need to buy|what errands do i have|what('?s| is) (?:still )?on my errands list|what bills do i need to pay(?: this week| soon)?|what bills are due this week|what meals have i planned(?: this week)?|what meal ideas do i have this week|what meal do i have planned|what household (?:items|things|stuff) (?:are )?(?:still open|do i have)|what should i remember to get tonight|what('?s| is) left for tonight|what should i handle this weekend|what('?s| is) missing for dinner|what recurring (?:things|items) (?:are )?(?:coming back|coming up)(?: soon)?)\b/.test(
      lower,
    )
  ) {
    return {
      capabilityId: 'capture.read_items',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday list readout phrasing',
    };
  }
  if (
    /^(repeat (?:this|that) (?:every day|daily|every week|weekly|every month|monthly|every (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))|stop repeating (?:this|that)|reopen (?:this|that)|move (?:this|that) to groceries|save (?:this|that) under groceries|make (?:this|that) part of my weekend list|put (?:this|that) in tonight'?s plan)\b/.test(
      lower,
    )
  ) {
    return {
      capabilityId: 'capture.update_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched everyday list update phrasing',
    };
  }
  return null;
}

function buildOpenAskCandidates(query: string): string[] {
  const trimmed = normalizeText(query);
  const lower = trimmed.toLowerCase();
  if (
    /^what should i say back\b/.test(lower) ||
    /^what should i send back\b/.test(lower)
  ) {
    return [trimmed];
  }

  const figureOutTopic =
    trimmed.match(/^(?:help me )?figure out (.+)$/i)?.[1]?.trim() || undefined;
  if (figureOutTopic) {
    return [
      `help me plan ${figureOutTopic}`,
      `what's the next step for ${figureOutTopic}`,
      `what should I do about ${figureOutTopic}`,
    ];
  }

  if (/\b(vs|versus)\b/.test(lower) || lower.includes(' and ')) {
    return [`compare ${trimmed}`];
  }

  return [
    `what should I know about ${trimmed}`,
    `tell me about ${trimmed}`,
    `explain ${trimmed}`,
    `help me with ${trimmed}`,
  ];
}

function matchFirstCapabilityCandidate(
  candidates: string[],
): AssistantCapabilityMatch | null {
  for (const candidate of candidates) {
    const match = matchAssistantCapabilityRequest(candidate);
    if (match) {
      return match;
    }
  }
  return null;
}

function buildBroadAlexaCandidates(
  intentName: string,
  slotValue: string,
): string[] {
  const trimmed = normalizeText(slotValue);
  const lower = trimmed.toLowerCase();
  if (intentName === ALEXA_COMPANION_GUIDANCE_INTENT) {
    if (/^(time is it(?: now)?|the time)$/i.test(lower)) {
      return ['what time is it'];
    }
    if (/^(day is it(?: today)?|date is it)$/i.test(lower)) {
      return ['what day is it'];
    }
    if (/^(up|up right now)$/i.test(lower)) {
      return ["what's up"];
    }
    if (/^(what can you do|can you do)$/i.test(lower)) {
      return ['what can you do', 'can you help me'];
    }
    if (/^(help|help me|can you help me)$/i.test(lower)) {
      return ['can you help me', 'what can you do'];
    }
    if (/\b(next on my calendar|next calendar item|next event)\b/.test(lower)) {
      return ["what's next on my calendar", "what's coming up"];
    }
    if (/\b(first meeting tomorrow|first meeting)\b/.test(lower)) {
      return [
        'when is my first meeting tomorrow',
        'what is on my calendar tomorrow',
      ];
    }
    if (/\b(pills?|meds?|medication|medicine)\b/.test(lower)) {
      return ['remind me to take my pills at 9', 'add my pills to tonight'];
    }
    if (/\b(bill|bills|rent|utilities|pay)\b/.test(lower)) {
      return ['what bills do I need to pay this week', "what's on my list"];
    }
    if (/\b(list|groceries|shopping|errands)\b/.test(lower)) {
      return ["what's on my list", 'what do I still need to buy'];
    }
    if (/\b(meal|meals|meal plan)\b/.test(lower)) {
      return [
        'help me plan meals this week',
        'what meals have I planned this week',
      ];
    }
    if (
      /\b(forget|forgetting|forgot|missing|overlook|loose end|loose ends|not handled)\b/.test(
        lower,
      )
    ) {
      return ['what am I forgetting'];
    }
    if (/\b(remember tonight|tonight|wrap up|tee up|leave)\b/.test(lower)) {
      return ['what should I remember tonight', 'give me an evening reset'];
    }
    if (/\b(next|do next|do now|handle next|tackle next)\b/.test(lower)) {
      return ['what should I do next'];
    }
    if (/\b(matter|priority|prioritize|focus)\b/.test(lower)) {
      return ['what matters today'];
    }
    if (/\b(today|my day|morning brief)\b/.test(lower)) {
      return ['what should I know about today'];
    }
    if (/\btomorrow\b/.test(lower)) {
      return ['what is on my calendar tomorrow'];
    }
    if (/\b(next meeting|before that|before .*meeting)\b/.test(lower)) {
      return ['what should I handle before my next meeting'];
    }
    return [`what should I know about ${trimmed}`];
  }

  if (intentName === ALEXA_PEOPLE_HOUSEHOLD_INTENT) {
    return [
      `what about ${trimmed}`,
      `what's still open with ${trimmed}`,
      `what should I say back about ${trimmed}`,
      `help me with ${trimmed}`,
    ];
  }

  if (intentName === ALEXA_PLANNING_ORIENTATION_INTENT) {
    return [
      `help me plan ${trimmed}`,
      `help me figure out ${trimmed}`,
      `figure out ${trimmed}`,
      `what's the next step for ${trimmed}`,
      `what's blocking ${trimmed}`,
      `what should I do about ${trimmed}`,
    ];
  }

  if (intentName === ALEXA_SAVE_REMIND_HANDOFF_INTENT) {
    if (!trimmed) {
      return ['send me the full version'];
    }
    if (/\b(list|groceries)\b/.test(lower)) {
      return [
        `add ${trimmed} to my shopping list`,
        `save ${trimmed} for later`,
      ];
    }
    if (isBareAlexaReference(trimmed)) {
      return [
        `save ${trimmed}`,
        `remind me about ${trimmed}`,
        'send me the full version',
        `draft ${trimmed}`,
      ];
    }
    return [
      `save ${trimmed}`,
      `remind me about ${trimmed}`,
      `draft ${trimmed}`,
      `send ${trimmed} to Telegram`,
    ];
  }

  if (intentName === ALEXA_OPEN_ASK_INTENT) {
    return buildOpenAskCandidates(trimmed);
  }

  if (intentName === ALEXA_CONVERSATION_CONTROL_INTENT) {
    if (!trimmed) {
      return ['anything else'];
    }
    if (/\bshort/.test(lower)) {
      return [`make it ${trimmed}`];
    }
    if (/\b(more|detail|deeper)\b/.test(lower)) {
      return [`say ${trimmed}`];
    }
    if (/\b(direct|calm|warmer|balanced|plain)\b/.test(lower)) {
      return [`be ${trimmed}`];
    }
    return [
      `what about ${trimmed}`,
      `remember ${trimmed}`,
      `why did you say ${trimmed}`,
    ];
  }

  return [];
}

function isSharedAssistantCompletionFollowup(lower: string): boolean {
  return /^(send (?:me )?(?:the )?(?:details|fuller version|full version|full comparison|fuller plan|plan)(?: to telegram)?|send (?:that|it) to telegram|also send (?:that|it) to telegram|give me the deeper comparison in telegram|save (?:that|it|this) (?:in|to) my library|save (?:that|it|this) to the library|save (?:that|it|this) for later|remember (?:that|it|this) for later|save the draft|track (?:that|it|this)(?: under .+)?|keep track of (?:that|it|this)(?: under .+| for tonight)?|turn (?:that|it|this) into a reminder|remind me about (?:that|it|this)(?: tonight)?|draft that for me|draft a message about (?:that|it|this)|send me the plan|send me the fuller plan)\b/.test(
    lower,
  );
}

function looksLikeCalendarLookupPrompt(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return (
    /\bwhat(?:'s| is)\b[\s\S]{0,80}\b(calendar|schedule)\b/.test(lower) ||
    /\bwhat does my\b[\s\S]{0,80}\blook like\b/.test(lower) ||
    /\b(?:show|check|look at|pull up|read)\b[\s\S]{0,80}\b(calendar|schedule)\b/.test(
      lower,
    ) ||
    /\b(on my|in my)\s+(calendar|schedule)\b/.test(lower) ||
    /\bdo i have\b[\s\S]{0,80}\b(meetings?|appointments?|events?)\b/.test(
      lower,
    ) ||
    /\bwhat meetings do i have\b/.test(lower) ||
    /\bwhen is my first meeting tomorrow\b/.test(lower)
  );
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
    lower === 'what am i probably missing' ||
    lower === 'anything i should know' ||
    lower === 'is there anything new i should know' ||
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
    lower === 'what should i not forget before bed' ||
    lower === 'what should i do before bed' ||
    lower === 'what should i not lose sight of tonight' ||
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

function matchReminderOverviewPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^(?:what reminders do i have|what should i remember|what do i need to remember)(?: (today|tomorrow|this week))?$/.test(
      lower,
    )
  ) {
    const windowMatch = lower.match(/\b(today|tomorrow|this week)\b/);
    const windowLabel = windowMatch?.[1];
    const canonicalText = windowLabel
      ? `what reminders do I have ${windowLabel}`
      : 'what reminders do I have';
    return {
      capabilityId: 'followthrough.reminder_overview',
      normalizedText: normalized,
      canonicalText,
      reason: 'matched reminder overview readout phrasing',
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
    lower === 'what do candace and i have coming up'
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
    /^what life threads are open\b/.test(lower) ||
    /^what life threads do i have open\b/.test(lower) ||
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

function matchPilotPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^this felt weird\b/.test(lower) ||
    /^that answer was off\b/.test(lower) ||
    /^this shouldn'?t have happened\b/.test(lower) ||
    /^save this as a pilot issue\b/.test(lower) ||
    /^mark this flow as awkward\b/.test(lower)
  ) {
    return {
      capabilityId: 'pilot.capture_issue',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched explicit pilot issue capture phrasing',
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

function matchCommunicationPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  const allSyncedSummaryIntent =
    parseAllSyncedMessagesSummaryIntent(normalized);
  if (allSyncedSummaryIntent) {
    return {
      capabilityId: 'communication.summarize_thread',
      normalizedText: normalized,
      canonicalText: allSyncedSummaryIntent.canonicalText,
      arguments: allSyncedSummaryIntent.arguments,
      reason: 'matched all-synced Messages summary phrasing',
    };
  }
  const threadSummaryIntent = parseThreadSummaryIntent(normalized);
  if (threadSummaryIntent) {
    return {
      capabilityId: 'communication.summarize_thread',
      normalizedText: normalized,
      canonicalText: threadSummaryIntent.canonicalText,
      arguments: threadSummaryIntent.arguments,
      reason: 'matched named synced Messages thread summary phrasing',
    };
  }
  if (looksLikeGenericThreadSummaryPrompt(normalized)) {
    return {
      capabilityId: 'communication.summarize_thread',
      normalizedText: normalized,
      canonicalText: normalized,
      reason:
        'matched generic synced Messages summary phrasing that needs a thread clarification',
    };
  }
  if (
    /^summari[sz]e this\b/.test(lower) ||
    /^summari[sz]e this message\b/.test(lower) ||
    /^what did they mean\b/.test(lower) ||
    /^what still needs a reply here\b/.test(lower)
  ) {
    return {
      capabilityId: 'communication.understand_message',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched communication understanding phrasing',
    };
  }
  if (
    /^what should i say back\b/.test(lower) ||
    /^what should i send back\b/.test(lower) ||
    /^draft a response\b/.test(lower) ||
    /^draft a reply\b/.test(lower) ||
    /^draft a reply to\b/.test(lower) ||
    /^give me a short reply\b/.test(lower) ||
    /^make (?:it|that)(?: a little)? warmer\b/.test(lower) ||
    /^warmer\b/.test(lower) ||
    /^make (?:it|that) more direct\b/.test(lower) ||
    /^more direct\b/.test(lower) ||
    /^make (?:it|that) less stiff\b/.test(lower) ||
    /^less stiff\b/.test(lower) ||
    /^make (?:it|that) more blunt\b/.test(lower) ||
    /^more blunt\b/.test(lower) ||
    /^make it sound like me\b/.test(lower)
  ) {
    return {
      capabilityId: 'communication.draft_reply',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched relationship-aware draft phrasing',
    };
  }
  if (
    /^do i owe a reply\b/.test(lower) ||
    /^what do i owe people\b/.test(lower) ||
    /^what texts need me\b/.test(lower) ||
    /^who am i forgetting to respond to\b/.test(lower) ||
    /^anything i need to send tonight\b/.test(lower) ||
    /^anything i need to reply to\b/.test(lower) ||
    /^what('?s| is)? still open with [a-z][a-z' -]+\??$/.test(lower) ||
    /^what still open with [a-z][a-z' -]+\??$/.test(lower) ||
    /^what should i talk to [a-z][a-z' -]+ about\??$/.test(lower) ||
    /^what do i need to follow up on with [a-z][a-z' -]+\??$/.test(lower)
  ) {
    return {
      capabilityId: 'communication.open_loops',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched communication open-loop phrasing',
    };
  }
  if (
    /^save this conversation under\b/.test(lower) ||
    /^remind me to reply later\b/.test(lower) ||
    /^don'?t surface this automatically\b/.test(lower) ||
    /^stop tracking that\b/.test(lower) ||
    /^forget this conversation thread\b/.test(lower) ||
    /^mark that handled\b/.test(lower)
  ) {
    return {
      capabilityId: 'communication.manage_tracking',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched communication tracking control phrasing',
    };
  }
  return null;
}

function matchMissionPrompt(
  normalized: string,
): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^help me plan\b/.test(lower) ||
    /^make a plan\b/.test(lower) ||
    /^turn this into a plan\b/.test(lower) ||
    /^help me organize this\b/.test(lower) ||
    /^help me figure out the next steps\b/.test(lower) ||
    /^what('?s| is) my plan for\b/.test(lower) ||
    /^help me prepare for tonight\b/.test(lower)
  ) {
    return {
      capabilityId: 'missions.propose',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched mission planning phrasing',
    };
  }
  if (
    /^what('?s| is) the plan\b/.test(lower) ||
    /^what('?s| is) still open in that plan\b/.test(lower) ||
    /^what('?s| is) the next step on that\b/.test(lower) ||
    /^what am i missing for this\b/.test(lower) ||
    /^how should i handle this weekend\b/.test(lower)
  ) {
    return {
      capabilityId: 'missions.view',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched mission view phrasing',
    };
  }
  if (
    /^save this plan\b/.test(lower) ||
    /^activate this\b/.test(lower) ||
    /^pause that plan\b/.test(lower) ||
    /^close that plan\b/.test(lower) ||
    /^make it simpler\b/.test(lower) ||
    /^break it down more\b/.test(lower) ||
    /^stop suggesting that\b/.test(lower) ||
    /^mark this handled\b/.test(lower) ||
    /^mark this done\b/.test(lower)
  ) {
    return {
      capabilityId: 'missions.manage',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched mission control phrasing',
    };
  }
  if (
    /^what('?s| is) blocking this\b/.test(lower) ||
    /^why this plan\b/.test(lower) ||
    /^what should i do first\b/.test(lower) ||
    /^what are you using to shape this\b/.test(lower)
  ) {
    return {
      capabilityId: 'missions.explain',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched mission explainability phrasing',
    };
  }
  return null;
}

function matchStaffPrompt(normalized: string): AssistantCapabilityMatch | null {
  const lower = normalized.toLowerCase();
  if (
    /^what matters most today\b/.test(lower) ||
    /^what matters today\b/.test(lower) ||
    /^what should i do next\b/.test(lower) ||
    /^what is slipping\b/.test(lower) ||
    /^what should i not let slip\b/.test(lower) ||
    /^summari[sz]e the actions i should take today\b/.test(lower) ||
    /^what should i handle before tonight\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.prioritize',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff prioritization phrasing',
    };
  }
  if (
    /^what matters this week\b/.test(lower) ||
    /^what should i not let slip this week\b/.test(lower) ||
    /^what('?s| is) the smart plan for tomorrow\b/.test(lower) ||
    /^what should i line up this weekend\b/.test(lower) ||
    /^help me get tonight under control\b/.test(lower) ||
    /^walk me through tonight\b/.test(lower) ||
    /^talk me through tonight\b/.test(lower) ||
    /^what are the biggest open loops right now\b/.test(lower) ||
    /^what bills do i need to pay(?: this week| this month| soon)?\b/.test(
      lower,
    ) ||
    /^what bills are coming up\b/.test(lower) ||
    /^what do i need to pay(?: this week| this month)?\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.plan_horizon',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff horizon planning phrasing',
    };
  }
  if (
    /^what should i prepare before tonight\b/.test(lower) ||
    /^what should i remember before i leave\b/.test(lower) ||
    /^what should i handle before my next meeting\b/.test(lower) ||
    /^what matters before my next meeting\b/.test(lower) ||
    /^prep me for my next meeting\b/.test(lower) ||
    /^help me prepare for this meeting\b/.test(lower) ||
    /^what should i do before my next meeting\b/.test(lower) ||
    /^what do i need before that event\b/.test(lower) ||
    /^what should i prep for\b/.test(lower) ||
    /^what do i need before this weekend\b/.test(lower) ||
    /^what should i have ready for\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.prepare',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff prep phrasing',
    };
  }
  if (
    /^what('?s| is) the tradeoff here\b/.test(lower) ||
    /^what('?s| is) the best next move\b/.test(lower) ||
    /^should i handle this tonight or tomorrow\b/.test(lower) ||
    /^what('?s| is) the best order to do these things\b/.test(lower) ||
    /^what should i push off\b/.test(lower) ||
    /^what should i stop worrying about\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.decision_support',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff decision-support phrasing',
    };
  }
  if (
    /^why are you prioritizing that\b/.test(lower) ||
    /^what are you using to decide this\b/.test(lower) ||
    /^why is this suddenly a priority\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.explain',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff explainability phrasing',
    };
  }
  if (
    /^be less aggressive about surfacing family stuff\b/.test(lower) ||
    /^don'?t suggest work right now\b/.test(lower) ||
    /^be more direct\b/.test(lower) ||
    /^be calmer\b/.test(lower) ||
    /^reset my planning preferences\b/.test(lower)
  ) {
    return {
      capabilityId: 'staff.configure',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'matched chief-of-staff configuration phrasing',
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
    /^capture this idea\b/.test(lower) ||
    /^save this idea\b/.test(lower) ||
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
    /^what have i saved about\b/.test(lower) ||
    /^just use my saved stuff\b/.test(lower)
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
    /^just use my saved material\b/.test(lower) ||
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
  if (looksLikeCalendarLookupPrompt(normalized)) {
    return null;
  }

  return (
    matchPilotPrompt(normalized) ||
    matchProfileSetupPrompt(normalized) ||
    matchEverydayCapturePrompt(normalized) ||
    matchMissionPrompt(normalized) ||
    matchStaffPrompt(normalized) ||
    matchDailyPrompt(normalized) ||
    matchReminderOverviewPrompt(normalized) ||
    matchHouseholdPrompt(normalized) ||
    matchCommunicationPrompt(normalized) ||
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

function continueAssistantCapabilityFromActiveCapability(
  text: string,
  activeCapabilityId: AssistantCapabilityId | undefined,
): AssistantCapabilityMatch | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  const pilotMatch = matchPilotPrompt(normalized);
  if (pilotMatch) {
    return {
      ...pilotMatch,
      continuation: true,
    };
  }

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

  if (
    activeCapabilityId?.startsWith('capture.') &&
    (/^(mark that done|check that off|mark this done|check this off|remove that|remove this|delete that|delete this|move that to next week|move this to next week|remind me about that tomorrow|remind me about this tomorrow)\b/.test(
      lower,
    ) ||
      /^(turn that into a reminder|turn this into a reminder|make this part of my plan|make that part of my plan|save that under the household thread|save this under the household thread)\b/.test(
        lower,
      ) ||
      /^(approve that|approve|use that|yes)\b/.test(lower))
  ) {
    return {
      capabilityId:
        /^(turn that into a reminder|turn this into a reminder|make this part of my plan|make that part of my plan|save that under the household thread|save this under the household thread)\b/.test(
          lower,
        )
          ? 'capture.convert_item'
          : /^(approve that|approve|use that|yes)\b/.test(lower)
            ? 'capture.profile_setup'
            : 'capture.update_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'continuing the active everyday capture context',
      continuation: true,
    };
  }

  if (
    activeCapabilityId === 'capture.profile_setup' ||
    activeCapabilityId === 'capture.profile_review'
  ) {
    return {
      capabilityId: 'capture.profile_setup',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'continuing the operating-profile setup flow',
      continuation: true,
    };
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
        activeCapabilityId.startsWith('knowledge.') ||
        activeCapabilityId.startsWith('communication.'))
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
    activeCapabilityId?.startsWith('staff.') &&
    (/^(what matters today|what should i do next|what is slipping|help me get tonight under control|walk me through tonight|talk me through tonight)\b/.test(
      lower,
    ) ||
      /^say more\b/.test(lower) ||
      /^make that shorter\b/.test(lower) ||
      /^shorter\b/.test(lower) ||
      /^why are you prioritizing that\b/.test(lower) ||
      /^what are you using to decide this\b/.test(lower) ||
      /^why is this suddenly a priority\b/.test(lower) ||
      /^what matters before my next meeting\b/.test(lower) ||
      /^be less aggressive about surfacing family stuff\b/.test(lower) ||
      /^don'?t suggest work right now\b/.test(lower) ||
      /^be more direct\b/.test(lower) ||
      /^be calmer\b/.test(lower) ||
      /^reset my planning preferences\b/.test(lower))
  ) {
    const nextCapabilityId =
      /^say more\b/.test(lower) ||
      /^make that shorter\b/.test(lower) ||
      /^shorter\b/.test(lower)
        ? activeCapabilityId
        : /^why are you prioritizing that\b/.test(lower) ||
            /^what are you using to decide this\b/.test(lower) ||
            /^why is this suddenly a priority\b/.test(lower)
          ? 'staff.explain'
          : /^what matters before my next meeting\b/.test(lower)
            ? 'staff.prepare'
            : /^be less aggressive about surfacing family stuff\b/.test(
                  lower,
                ) ||
                /^don'?t suggest work right now\b/.test(lower) ||
                /^be more direct\b/.test(lower) ||
                /^be calmer\b/.test(lower) ||
                /^reset my planning preferences\b/.test(lower)
              ? 'staff.configure'
              : 'staff.prioritize';
    return {
      capabilityId: nextCapabilityId,
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'continuing chief-of-staff guidance from the active context',
      continuation: true,
    };
  }

  if (
    activeCapabilityId?.startsWith('missions.') &&
    (/^(anything else|what('?s| is) the blocker|what('?s| is) blocking this|what('?s| is) the next step|what happens next|what should i do first|what am i missing for this|break it down more|make it simpler)\b/.test(
      lower,
    ) ||
      /^save this plan\b/.test(lower) ||
      /^activate this\b/.test(lower) ||
      /^pause that plan\b/.test(lower) ||
      /^close that plan\b/.test(lower) ||
      /^stop suggesting that\b/.test(lower) ||
      /^mark this handled\b/.test(lower) ||
      /^mark this done\b/.test(lower) ||
      /^(okay )?do that\b/.test(lower) ||
      /^(do it|draft it|remind me|save that|track that|start (?:the )?research)\b/.test(
        lower,
      ))
  ) {
    const nextCapabilityId =
      /^(okay )?do that\b/.test(lower) ||
      /^(do it|draft it|remind me|save that|track that|start (?:the )?research)\b/.test(
        lower,
      )
        ? 'missions.execute'
        : /^save this plan\b/.test(lower) ||
            /^activate this\b/.test(lower) ||
            /^pause that plan\b/.test(lower) ||
            /^close that plan\b/.test(lower) ||
            /^stop suggesting that\b/.test(lower) ||
            /^mark this handled\b/.test(lower) ||
            /^mark this done\b/.test(lower) ||
            /^break it down more\b/.test(lower) ||
            /^make it simpler\b/.test(lower)
          ? 'missions.manage'
          : /^what('?s| is) the blocker\b/.test(lower) ||
              /^what('?s| is) blocking this\b/.test(lower) ||
              /^what should i do first\b/.test(lower)
            ? 'missions.explain'
            : 'missions.view';
    return {
      capabilityId: nextCapabilityId,
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'continuing the active mission context',
      continuation: true,
    };
  }

  if (
    isBareCommunicationDraftFollowup(lower) &&
    activeCapabilityId?.startsWith('communication.')
  ) {
    return {
      capabilityId: 'communication.draft_reply',
      normalizedText: normalized,
      canonicalText: normalized,
      reason:
        'continuing the active communication thread with a draft follow-up',
      continuation: true,
    };
  }

  if (
    /^(what do i owe people|anything i need to reply to|what conversations are still open|what texts need me)\b/.test(
      lower,
    ) &&
    activeCapabilityId?.startsWith('communication.')
  ) {
    return {
      capabilityId: 'communication.open_loops',
      normalizedText: normalized,
      canonicalText: normalized,
      reason:
        'continuing the active communication thread with an open-loops follow-up',
      continuation: true,
    };
  }

  if (isSharedAssistantCompletionFollowup(lower)) {
    return null;
  }

  return matchAssistantCapabilityRequest(normalized);
}

export function continueAssistantCapabilityFromPriorSubjectData(
  text: string,
  subjectData: AssistantCapabilityContinuationSubjectData | undefined,
): AssistantCapabilityMatch | null {
  if (!subjectData) return null;
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const pilotMatch = matchPilotPrompt(normalized);
  if (pilotMatch) return pilotMatch;
  if (
    subjectData.activeCapabilityId?.startsWith('capture.') &&
    ['list_capture', 'list_read', 'list_update'].includes(
      subjectData.activeTaskKind || '',
    ) &&
    subjectData.activeListGroupId &&
    /^add\b/.test(normalized.toLowerCase())
  ) {
    return {
      capabilityId: 'capture.add_item',
      normalizedText: normalized,
      canonicalText: normalized,
      reason: 'continuing the active everyday list with an add follow-up',
      continuation: true,
    };
  }
  if (
    !subjectData.activeCapabilityId?.startsWith('capture.') &&
    isSharedAssistantCompletionFollowup(normalized.toLowerCase())
  ) {
    return null;
  }
  return continueAssistantCapabilityFromActiveCapability(
    normalized,
    subjectData.activeCapabilityId,
  );
}

export function continueAssistantCapabilityFromAlexaState(
  text: string,
  state: AlexaConversationState | undefined,
): AssistantCapabilityMatch | null {
  if (!state) return null;
  return continueAssistantCapabilityFromActiveCapability(
    text,
    state.subjectData.activeCapabilityId,
  );
}

export function resolveAlexaIntentToCapability(
  intentName: string,
  options: {
    slotValue?: string;
    conversationState?: AlexaConversationState;
  } = {},
): AssistantCapabilityMatch | null {
  if (
    intentName === ALEXA_COMPANION_GUIDANCE_INTENT ||
    intentName === ALEXA_PEOPLE_HOUSEHOLD_INTENT ||
    intentName === ALEXA_PLANNING_ORIENTATION_INTENT ||
    intentName === ALEXA_SAVE_REMIND_HANDOFF_INTENT ||
    intentName === ALEXA_OPEN_ASK_INTENT ||
    intentName === ALEXA_CONVERSATION_CONTROL_INTENT
  ) {
    const normalizedSlot = normalizeText(options.slotValue || '');
    const candidates = buildBroadAlexaCandidates(
      intentName,
      options.slotValue || '',
    );
    if (candidates.some((candidate) => isAlexaLocalVoiceAsk(candidate))) {
      return null;
    }
    if (
      intentName === ALEXA_CONVERSATION_CONTROL_INTENT &&
      isWeakAlexaReference(normalizedSlot)
    ) {
      if (options.conversationState) {
        for (const candidate of candidates) {
          const continuation = continueAssistantCapabilityFromAlexaState(
            candidate,
            options.conversationState,
          );
          if (continuation) {
            return continuation;
          }
        }
      }
      return null;
    }
    if (
      intentName === ALEXA_SAVE_REMIND_HANDOFF_INTENT &&
      options.conversationState &&
      isReferenceBoundSavePrompt(normalizedSlot)
    ) {
      return null;
    }
    if (
      intentName === ALEXA_CONVERSATION_CONTROL_INTENT &&
      options.conversationState
    ) {
      for (const candidate of candidates) {
        const continuation = continueAssistantCapabilityFromAlexaState(
          candidate,
          options.conversationState,
        );
        if (continuation) {
          return continuation;
        }
      }
    }
    return matchFirstCapabilityCandidate(candidates);
  }

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
