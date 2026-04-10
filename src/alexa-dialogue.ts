import { classifyAssistantRequest } from './assistant-routing.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_COMPANION_GUIDANCE_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_CONVERSATION_CONTROL_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_OPEN_ASK_INTENT,
  ALEXA_PEOPLE_HOUSEHOLD_INTENT,
  ALEXA_PLANNING_ORIENTATION_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_SAVE_REMIND_HANDOFF_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_AM_I_FORGETTING_INTENT,
  ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
} from './alexa-v1.js';
import {
  resolveAlexaConversationFollowup,
  type AlexaConversationState,
} from './alexa-conversation.js';
import type { AlexaConversationFollowupAction, NewMessage } from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export type AlexaVoiceIntentFamily =
  | 'companion_guidance'
  | 'people_household'
  | 'planning_orientation'
  | 'save_remind_handoff'
  | 'open_ask'
  | 'conversation_control'
  | 'legacy_guidance'
  | 'legacy_followup'
  | 'legacy_memory'
  | 'legacy_action';

type AlexaDialogueRoute =
  | 'local'
  | 'shared_capability'
  | 'assistant_bridge'
  | 'handoff'
  | 'blocked'
  | 'clarify';

export interface AlexaDialoguePlan {
  family?: AlexaVoiceIntentFamily;
  normalizedText: string;
  route: AlexaDialogueRoute;
  capabilityId?: import('./assistant-capabilities.js').AssistantCapabilityId;
  capabilityText?: string;
  followupAction?: AlexaConversationFollowupAction;
  followupText?: string;
  localKind?: 'time' | 'day' | 'whats_up' | 'help';
  blockedSpeech?: string;
  clarificationSpeech?: string;
  blockerClass?:
    | 'fallback_unmatched_open_utterance'
    | 'weak_clarifier_recovery'
    | 'carrier_phrase_missing'
    | 'operator_handoff_required';
}

export interface AlexaVoiceIntentCapture {
  family: AlexaVoiceIntentFamily;
  slotValue?: string;
  preferredText: string;
  candidateTexts: string[];
}

function buildSyntheticMessage(content: string): NewMessage {
  return {
    id: 'alexa-dialogue-plan',
    chat_jid: 'alexa:planning',
    sender: 'Alexa User',
    sender_name: 'Alexa User',
    content,
    timestamp: new Date(0).toISOString(),
  };
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '').replace(/\s+/g, ' ').trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function isBareReference(normalized: string): boolean {
  return /^(that|this|it|there|something)$/i.test(normalized.trim());
}

function isWeakReference(normalized: string): boolean {
  return /^(that|this|it|there|something|what about it|what about that|what should i know|why)\b/i.test(
    normalized,
  );
}

function buildClarificationSpeech(
  state: AlexaConversationState | undefined,
  hint?: string,
): string {
  const personName = state?.subjectData.personName?.trim();
  const activeSubject =
    personName ||
    state?.subjectData.activeSubjectLabel?.trim() ||
    state?.subjectData.conversationFocus?.trim();
  if (activeSubject) {
    return `I am not fully sure what you mean yet. Is that still about ${activeSubject}, or something else?`;
  }
  if (hint === 'household') {
    return 'Was that about Candace, home stuff, or something you want to remember?';
  }
  return "I am not fully sure what you meant, but I can help with your plans, open loops, or a reminder. Say it again a little more simply and I'll keep the thread.";
}

function buildBlockedRouteSpeech(normalized: string): string {
  if (
    /\b(cursor|runtime|job|agent|repo|repository|code|branch|commit)\b/i.test(
      normalized,
    )
  ) {
    return 'I can help here with plans, reminders, messages, and household follow-through. For code or system controls, Telegram is the better place.';
  }
  return 'I can help here with planning, reminders, messages, and household follow-through. For the bigger control-plane stuff, Telegram is the better place.';
}

function buildCompanionGuidanceCandidates(slotValue: string): string[] {
  const lower = slotValue.toLowerCase();
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
  if (/\b(tomorrow)\b/.test(lower)) {
    return ['what is on my calendar tomorrow'];
  }
  if (/\b(next|do next|do now|handle next|tackle next)\b/.test(lower)) {
    return ['what should I do next'];
  }
  if (/\b(matter|priority|prioritize|focus)\b/.test(lower)) {
    return ['what matters today'];
  }
  if (/\b(before .*meeting|before that|next meeting)\b/.test(lower)) {
    return ['what should I handle before my next meeting'];
  }
  if (/\b(today|my day|morning brief|shape of today)\b/.test(lower)) {
    return ['what should I know about today'];
  }
  return [
    `what should I know about ${slotValue}`,
    `help me with ${slotValue}`,
  ];
}

function buildPeopleHouseholdCandidates(subject: string): string[] {
  return [
    `what about ${subject}`,
    `what's still open with ${subject}`,
    `what should I say back about ${subject}`,
    `help me with ${subject}`,
  ];
}

function buildPlanningCandidates(topic: string): string[] {
  return [
    `help me plan ${topic}`,
    `what's the next step for ${topic}`,
    `what's blocking ${topic}`,
    `what should I do about ${topic}`,
  ];
}

function buildSaveRemindCandidates(item: string): string[] {
  const normalized = item.toLowerCase();
  if (!normalized) {
    return ['send me the full version'];
  }
  if (isBareReference(normalized)) {
    return [
      'send me the full version',
      `save ${item}`,
      `remind me about ${item}`,
      `draft ${item}`,
    ];
  }
  return [
    `save ${item}`,
    `remind me about ${item}`,
    `draft ${item}`,
    `send ${item} to Telegram`,
  ];
}

function buildOpenAskCandidates(query: string): string[] {
  const normalized = query.toLowerCase();
  if (
    /\b(vs|versus)\b/.test(normalized) ||
    (normalized.includes(' and ') && normalized.split(' and ').length === 2)
  ) {
    return [`compare ${query}`];
  }
  return [
    `what should I know about ${query}`,
    `tell me about ${query}`,
    `explain ${query}`,
    `help me with ${query}`,
  ];
}

function buildConversationControlCandidates(controlText: string): string[] {
  const normalized = controlText.toLowerCase();
  if (!normalized) {
    return ['anything else'];
  }
  if (isBareReference(normalized)) {
    return [
      'what about that',
      'remember that',
      'save that',
      'why did you say that',
      "don't bring that up automatically",
    ];
  }
  if (/\bshort/.test(normalized)) {
    return [`make it ${controlText}`];
  }
  if (/\b(direct|calm|warmer|balanced|plain)\b/.test(normalized)) {
    return [`be ${controlText}`];
  }
  if (/\b(more|detail|deeper)\b/.test(normalized)) {
    return [`say ${controlText}`];
  }
  return [
    `what about ${controlText}`,
    `remember ${controlText}`,
    `why did you say ${controlText}`,
  ];
}

export function resolveAlexaVoiceIntentFamily(
  intentName: string,
): AlexaVoiceIntentFamily | null {
  switch (intentName) {
    case ALEXA_COMPANION_GUIDANCE_INTENT:
      return 'companion_guidance';
    case ALEXA_PEOPLE_HOUSEHOLD_INTENT:
      return 'people_household';
    case ALEXA_PLANNING_ORIENTATION_INTENT:
      return 'planning_orientation';
    case ALEXA_SAVE_REMIND_HANDOFF_INTENT:
      return 'save_remind_handoff';
    case ALEXA_OPEN_ASK_INTENT:
      return 'open_ask';
    case ALEXA_CONVERSATION_CONTROL_INTENT:
    case ALEXA_ANYTHING_ELSE_INTENT:
      return 'conversation_control';
    case ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT:
      return 'legacy_followup';
    case ALEXA_MEMORY_CONTROL_INTENT:
      return 'legacy_memory';
    case ALEXA_SAVE_FOR_LATER_INTENT:
    case ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT:
    case ALEXA_DRAFT_FOLLOW_UP_INTENT:
      return 'legacy_action';
    case ALEXA_MY_DAY_INTENT:
    case ALEXA_UPCOMING_SOON_INTENT:
    case ALEXA_WHAT_NEXT_INTENT:
    case ALEXA_WHAT_AM_I_FORGETTING_INTENT:
    case ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT:
    case ALEXA_TOMORROW_CALENDAR_INTENT:
    case ALEXA_EVENING_RESET_INTENT:
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return 'legacy_guidance';
    default:
      return null;
  }
}

export function extractAlexaVoiceIntentCapture(
  intentName: string,
  slotValues: {
    guidanceText?: string;
    subject?: string;
    topic?: string;
    item?: string;
    query?: string;
    controlText?: string;
    followupText?: string;
    memoryCommand?: string;
    captureText?: string;
    meetingReference?: string;
    leadTime?: string;
  } = {},
): AlexaVoiceIntentCapture | null {
  const family = resolveAlexaVoiceIntentFamily(intentName);
  if (!family) return null;

  const slotValue =
    normalizeText(
      slotValues.guidanceText ||
        slotValues.subject ||
        slotValues.topic ||
        slotValues.item ||
        slotValues.query ||
        slotValues.controlText ||
        slotValues.followupText ||
        slotValues.memoryCommand ||
        slotValues.captureText ||
        slotValues.meetingReference ||
        slotValues.leadTime,
    ) || undefined;

  switch (intentName) {
    case ALEXA_COMPANION_GUIDANCE_INTENT: {
      const candidates = dedupe(buildCompanionGuidanceCandidates(slotValue || 'today'));
      return {
        family,
        slotValue,
        preferredText: candidates[0] || 'what should I know about today',
        candidateTexts: candidates,
      };
    }
    case ALEXA_PEOPLE_HOUSEHOLD_INTENT: {
      const subject = slotValue || 'Candace';
      const candidates = dedupe(buildPeopleHouseholdCandidates(subject));
      return {
        family,
        slotValue: subject,
        preferredText: candidates[0] || `what about ${subject}`,
        candidateTexts: candidates,
      };
    }
    case ALEXA_PLANNING_ORIENTATION_INTENT: {
      const topic = slotValue || 'that';
      const candidates = dedupe(buildPlanningCandidates(topic));
      return {
        family,
        slotValue: topic,
        preferredText: candidates[0] || `help me plan ${topic}`,
        candidateTexts: candidates,
      };
    }
    case ALEXA_SAVE_REMIND_HANDOFF_INTENT: {
      const candidates = dedupe(buildSaveRemindCandidates(slotValue || ''));
      return {
        family,
        slotValue,
        preferredText: candidates[0] || 'send me the full version',
        candidateTexts: candidates,
      };
    }
    case ALEXA_OPEN_ASK_INTENT: {
      const query = slotValue || 'that';
      const candidates = dedupe(buildOpenAskCandidates(query));
      return {
        family,
        slotValue: query,
        preferredText: candidates[0] || `tell me about ${query}`,
        candidateTexts: candidates,
      };
    }
    case ALEXA_CONVERSATION_CONTROL_INTENT:
    case ALEXA_ANYTHING_ELSE_INTENT: {
      const candidates = dedupe(buildConversationControlCandidates(slotValue || ''));
      return {
        family,
        slotValue,
        preferredText: candidates[0] || 'anything else',
        candidateTexts: candidates,
      };
    }
    case ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT:
      return {
        family,
        slotValue,
        preferredText: slotValue || 'anything else',
        candidateTexts: dedupe([slotValue || 'anything else']),
      };
    case ALEXA_MEMORY_CONTROL_INTENT: {
      const candidates = dedupe(buildConversationControlCandidates(slotValue || ''));
      return {
        family,
        slotValue,
        preferredText: candidates[0] || 'be a little more direct',
        candidateTexts: candidates,
      };
    }
    case ALEXA_SAVE_FOR_LATER_INTENT:
      return {
        family,
        slotValue,
        preferredText: slotValue ? `save ${slotValue}` : 'save that for later',
        candidateTexts: dedupe([
          slotValue ? `save ${slotValue}` : 'save that for later',
          slotValue ? `save ${slotValue} for later` : '',
        ]),
      };
    case ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT:
      return {
        family,
        slotValue,
        preferredText: slotValue
          ? `remind me ${slotValue} before my next meeting`
          : 'remind me before my next meeting',
        candidateTexts: dedupe([
          slotValue
            ? `remind me ${slotValue} before my next meeting`
            : 'remind me before my next meeting',
        ]),
      };
    case ALEXA_DRAFT_FOLLOW_UP_INTENT:
      return {
        family,
        slotValue,
        preferredText: slotValue
          ? `draft a follow up for ${slotValue}`
          : 'draft a follow up',
        candidateTexts: dedupe([
          slotValue ? `draft a follow up for ${slotValue}` : 'draft a follow up',
        ]),
      };
    case ALEXA_MY_DAY_INTENT:
      return {
        family,
        preferredText: 'what should I know about today',
        candidateTexts: ['what should I know about today'],
      };
    case ALEXA_UPCOMING_SOON_INTENT:
      return {
        family,
        preferredText: 'what do I have coming up soon',
        candidateTexts: ['what do I have coming up soon'],
      };
    case ALEXA_WHAT_NEXT_INTENT:
      return {
        family,
        preferredText: 'what should I do next',
        candidateTexts: ['what should I do next'],
      };
    case ALEXA_WHAT_AM_I_FORGETTING_INTENT:
      return {
        family,
        preferredText: 'what am I forgetting',
        candidateTexts: ['what am I forgetting'],
      };
    case ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT:
      return {
        family,
        preferredText: 'what matters today',
        candidateTexts: ['what matters today'],
      };
    case ALEXA_TOMORROW_CALENDAR_INTENT:
      return {
        family,
        preferredText: 'what is on my calendar tomorrow',
        candidateTexts: ['what is on my calendar tomorrow'],
      };
    case ALEXA_EVENING_RESET_INTENT:
      return {
        family,
        preferredText: 'what should I remember tonight',
        candidateTexts: ['what should I remember tonight'],
      };
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return {
        family,
        preferredText: 'what about Candace',
        candidateTexts: ['what about Candace', "what's still open with Candace"],
      };
    default:
      return null;
  }
}

export function pickAlexaConversationFollowupCandidate(
  texts: string[],
  state: AlexaConversationState | undefined,
): { text: string; action: AlexaConversationFollowupAction } | null {
  if (!state) return null;
  for (const text of texts) {
    const resolution = resolveAlexaConversationFollowup(text, state);
    if (resolution.ok && resolution.action) {
      return {
        text: resolution.text || text,
        action: resolution.action,
      };
    }
  }
  return null;
}

export function planAlexaDialogueTurn(
  text: string,
  state?: AlexaConversationState,
  family?: AlexaVoiceIntentFamily,
): AlexaDialoguePlan {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return {
      family,
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
      blockerClass: 'carrier_phrase_missing',
    };
  }

  const lower = normalizedText.toLowerCase();
  if (/^what time is it\b/.test(lower)) {
    return { family, normalizedText, route: 'local', localKind: 'time' };
  }
  if (/^what day is it\b/.test(lower)) {
    return { family, normalizedText, route: 'local', localKind: 'day' };
  }
  if (/^(what'?s up|whats up)\b/.test(lower)) {
    return { family, normalizedText, route: 'local', localKind: 'whats_up' };
  }
  if (lower === 'can you help me' || lower === 'help me') {
    return { family, normalizedText, route: 'local', localKind: 'help' };
  }
  if (lower === 'what should i know') {
    return {
      family,
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
      blockerClass: 'weak_clarifier_recovery',
    };
  }

  if (state) {
    const resolution = resolveAlexaConversationFollowup(normalizedText, state);
    if (resolution.ok && resolution.action) {
      return {
        family,
        normalizedText,
        route: 'handoff',
        followupAction: resolution.action,
        followupText: resolution.text || normalizedText,
      };
    }
  } else if (isWeakReference(lower)) {
    return {
      family,
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
      blockerClass: 'weak_clarifier_recovery',
    };
  }

  const capabilityMatch = matchAssistantCapabilityRequest(normalizedText);
  if (capabilityMatch) {
    return {
      family,
      normalizedText,
      route: 'shared_capability',
      capabilityId: capabilityMatch.capabilityId,
      capabilityText: capabilityMatch.canonicalText || normalizedText,
    };
  }

  const policy = classifyAssistantRequest([buildSyntheticMessage(normalizedText)]);
  if (
    policy.route === 'control_plane' ||
    policy.route === 'code_plane' ||
    policy.route === 'advanced_helper'
  ) {
    return {
      family,
      normalizedText,
      route: 'blocked',
      blockedSpeech: buildBlockedRouteSpeech(normalizedText),
      blockerClass: 'operator_handoff_required',
    };
  }

  return {
    family,
    normalizedText,
    route: 'assistant_bridge',
    blockerClass: 'fallback_unmatched_open_utterance',
  };
}
