import { classifyAssistantRequest } from './assistant-routing.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_CALENDAR_CANCEL_INTENT,
  ALEXA_CALENDAR_CREATE_INTENT,
  ALEXA_CALENDAR_MOVE_INTENT,
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
  ALEXA_REMINDER_CREATE_INTENT,
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
    | 'operator_handoff_required'
    | 'no_context_reference'
    | 'followup_binding_failed'
    | 'communication_should_route'
    | 'planning_should_route'
    | 'voice_shape_repetition';
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

function isFollowupBindingPrompt(normalized: string): boolean {
  return /^(save that|save this|save it|remind me later|remind me about that later|send me (?:the )?(?:details|full version|fuller version)|send that to telegram|send it to telegram|send me the plan)\b/i.test(
    normalized,
  );
}

function isCommunicationDraftPrompt(normalized: string): boolean {
  return /^(what should i say back|what should i send back|draft a reply|draft a response|give me a short reply)\b/i.test(
    normalized,
  );
}

function extractFigureOutTopic(normalized: string): string | undefined {
  return normalized.match(/^(?:help me )?figure out (.+)$/i)?.[1]?.trim();
}

function buildClarificationSpeech(
  state: AlexaConversationState | undefined,
  hint?: string,
): string {
  const personName = state?.subjectData.personName?.trim();
  const activeAnchor =
    state?.subjectData.activeVoiceAnchor?.trim() ||
    state?.subjectData.activeSubjectLabel?.trim() ||
    state?.subjectData.conversationFocus?.trim();
  const activeSubject =
    personName ||
    activeAnchor;
  if (activeSubject) {
    return `Is that still about ${activeSubject}, or something else?`;
  }
  if (hint === 'household') {
    return 'Was that about Candace, home stuff, or something you want to remember?';
  }
  return 'Was that about a person, a plan, or something you want me to remember?';
}

function buildBlockedRouteSpeech(normalized: string): string {
  if (
    /\b(cursor|runtime|job|agent|repo|repository|code|branch|commit)\b/i.test(
      normalized,
    )
  ) {
    return 'I can help here with your schedule, reminders, planning, review, and messages. For code or system controls, Telegram is the better place.';
  }
  return 'I can help here with your schedule, reminders, planning, review, and messages. For the bigger control-plane stuff, Telegram is the better place.';
}

function buildCompanionGuidanceCandidates(slotValue: string): string[] {
  const lower = slotValue.toLowerCase();
  if (/^(time is it(?: now)?|the time)$/i.test(lower)) {
    return ['what time is it'];
  }
  if (/^(day is it(?: today)?|date is it)$/i.test(lower)) {
    return ['what day is it'];
  }
  if (/^(up|up right now)$/i.test(lower)) {
    return ["what's up"];
  }
  if (/^(can you do|what can you do)$/i.test(lower)) {
    return ['what can you do', 'can you help me'];
  }
  if (/^(help|help me|can you help me)$/i.test(lower)) {
    return ['can you help me', 'what can you do'];
  }
  if (
    /\b(next on my calendar|next calendar item|next event)\b/.test(lower)
  ) {
    return ["what's next on my calendar", "what's coming up"];
  }
  if (/\b(first meeting tomorrow|first meeting)\b/.test(lower)) {
    return ['when is my first meeting tomorrow', 'what is on my calendar tomorrow'];
  }
  if (/\b(pills?|meds?|medication|medicine)\b/.test(lower)) {
    return ['remind me to take my pills at 9'];
  }
  if (/\b(bill|bills|rent|utilities|pay)\b/.test(lower)) {
    return ['what bills do I need to pay this week', "what's still open"];
  }
  if (/\b(meal|meals|meal plan)\b/.test(lower)) {
    return ['help me plan meals this week', 'help me plan tonight'];
  }
  if (/\b(owe people|owe a reply|owe replies|owe someone a reply)\b/.test(lower)) {
    return ['what do I owe people'];
  }
  if (/\b(still open|still needs attention|needs attention)\b/.test(lower)) {
    return ["what's still open", 'what still needs attention'];
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
  if (/\b(tomorrow)\b/.test(lower)) {
    return ['what is on my calendar tomorrow'];
  }
  if (
    /\b(calendar|schedule)\b/.test(lower) &&
    /\b(today|this afternoon|this evening|tonight)\b/.test(lower)
  ) {
    return [
      `what is on my calendar ${slotValue}`,
      `what do I have ${slotValue.replace(/\b(?:on my )?(?:calendar|schedule)\b/i, '').trim()}`,
    ];
  }
  if (/^(this afternoon|this evening|tonight)$/i.test(lower)) {
    return [`what do I have ${slotValue}`];
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
    `help me figure out ${topic}`,
    `figure out ${topic}`,
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
      `save ${item}`,
      'send me the full version',
      `draft ${item}`,
    ];
  }
  return [
    `save ${item}`,
    `draft ${item}`,
    `send ${item} to Telegram`,
  ];
}

function buildOpenAskCandidates(query: string): string[] {
  const normalized = query.toLowerCase();
  if (isCommunicationDraftPrompt(normalized)) {
    return [query];
  }
  if (
    /^what do i owe people\b/.test(normalized) ||
    /^who do i still owe a reply\b/.test(normalized) ||
    /^what should i know before deciding\b/.test(normalized) ||
    /^explain this simply\b/.test(normalized) ||
    /^tell me something interesting\b/.test(normalized) ||
    /^summari[sz]e this\b/.test(normalized) ||
    /^help me think through this choice\b/.test(normalized)
  ) {
    return [query];
  }
  const figureOutTopic = extractFigureOutTopic(query);
  if (figureOutTopic) {
    return [
      `help me plan ${figureOutTopic}`,
      `what's the next step for ${figureOutTopic}`,
      `what should I do about ${figureOutTopic}`,
    ];
  }
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
  if (isBareReference(normalized) || isWeakReference(normalized)) {
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
    case ALEXA_CALENDAR_CREATE_INTENT:
    case ALEXA_CALENDAR_MOVE_INTENT:
    case ALEXA_CALENDAR_CANCEL_INTENT:
    case ALEXA_REMINDER_CREATE_INTENT:
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
    calendarReadText?: string;
    subject?: string;
    topic?: string;
    item?: string;
    calendarCreateText?: string;
    calendarMoveText?: string;
    calendarCancelText?: string;
    reminderText?: string;
    eventTitle?: string;
    eventReference?: string;
    targetDate?: string;
    targetTime?: string;
    sourceTime?: string;
    reminderBody?: string;
    reminderDate?: string;
    reminderTime?: string;
    calendarReference?: string;
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
        slotValues.calendarReadText ||
        slotValues.subject ||
        slotValues.topic ||
        slotValues.calendarCreateText ||
        slotValues.calendarMoveText ||
        slotValues.calendarCancelText ||
        slotValues.reminderText ||
        slotValues.eventTitle ||
        slotValues.eventReference ||
        slotValues.reminderBody ||
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
    case ALEXA_SAVE_REMIND_HANDOFF_INTENT:
    case ALEXA_CALENDAR_CREATE_INTENT:
    case ALEXA_CALENDAR_MOVE_INTENT:
    case ALEXA_CALENDAR_CANCEL_INTENT:
    case ALEXA_REMINDER_CREATE_INTENT: {
      if (intentName === ALEXA_CALENDAR_CREATE_INTENT && slotValues.calendarCreateText) {
        const value =
          normalizeText(slotValues.calendarCreateText) || slotValues.calendarCreateText;
        return {
          family,
          slotValue: value,
          preferredText: `add ${value}`,
          candidateTexts: dedupe([
            `add ${value}`,
            `schedule ${value}`,
            `put ${value} on my calendar`,
          ]),
        };
      }
      if (intentName === ALEXA_CALENDAR_MOVE_INTENT && slotValues.calendarMoveText) {
        const value =
          normalizeText(slotValues.calendarMoveText) || slotValues.calendarMoveText;
        return {
          family,
          slotValue: value,
          preferredText: `move ${value}`,
          candidateTexts: dedupe([`move ${value}`, `reschedule ${value}`]),
        };
      }
      if (intentName === ALEXA_CALENDAR_CANCEL_INTENT && slotValues.calendarCancelText) {
        const value =
          normalizeText(slotValues.calendarCancelText) || slotValues.calendarCancelText;
        return {
          family,
          slotValue: value,
          preferredText: `cancel ${value}`,
          candidateTexts: dedupe([`cancel ${value}`, `delete ${value}`]),
        };
      }
      if (intentName === ALEXA_CALENDAR_CANCEL_INTENT && slotValues.eventReference) {
        const value =
          normalizeText(
            `${slotValues.eventReference}${slotValues.targetDate ? ` ${slotValues.targetDate}` : ''}${slotValues.calendarReference ? ` ${slotValues.calendarReference}` : ''}`,
          ) || slotValues.eventReference;
        return {
          family,
          slotValue: value,
          preferredText: `cancel ${value}`,
          candidateTexts: dedupe([`cancel ${value}`, `delete ${value}`]),
        };
      }
      if (intentName === ALEXA_REMINDER_CREATE_INTENT && slotValues.reminderText) {
        const value = normalizeText(slotValues.reminderText) || slotValues.reminderText;
        return {
          family,
          slotValue: value,
          preferredText: `remind me ${value}`,
          candidateTexts: dedupe([
            `remind me ${value}`,
            `remind me to ${value}`,
            `remind me about ${value}`,
          ]),
        };
      }
      if (intentName === ALEXA_REMINDER_CREATE_INTENT && slotValues.reminderBody) {
        const reminderTail = normalizeText(
          [
            slotValues.reminderDate,
            slotValues.reminderTime &&
            !/^(?:at|morning|afternoon|evening|tonight)\b/i.test(slotValues.reminderTime)
              ? `at ${slotValues.reminderTime}`
              : slotValues.reminderTime,
          ]
            .filter(Boolean)
            .join(' '),
        );
        const value =
          normalizeText(
            `${slotValues.reminderBody}${reminderTail ? ` ${reminderTail}` : ''}`,
          ) ||
          slotValues.reminderBody;
        return {
          family,
          slotValue: value,
          preferredText: `remind me to ${value}`,
          candidateTexts: dedupe([
            `remind me to ${value}`,
            `remind me about ${value}`,
          ]),
        };
      }
      if (slotValues.eventTitle && slotValues.targetDate) {
        const dateOrTime = [slotValues.targetDate, slotValues.targetTime]
          .filter(Boolean)
          .join(' ');
        const calendarReference = slotValues.calendarReference
          ? ` on ${slotValues.calendarReference}`
          : '';
        const value =
          normalizeText(
            `${slotValues.eventTitle} ${dateOrTime}${calendarReference}`,
          ) ||
          slotValues.eventTitle;
        return {
          family,
          slotValue: value,
          preferredText: `schedule ${value}`,
          candidateTexts: dedupe([
            `schedule ${value}`,
            `add ${value}`,
            `put ${value} on my calendar`,
          ]),
        };
      }
      if (slotValues.eventReference && (slotValues.targetDate || slotValues.targetTime)) {
        const destinationParts = [slotValues.targetDate, slotValues.targetTime]
          .filter(Boolean)
          .join(' ');
        const calendarReference = slotValues.calendarReference
          ? ` on ${slotValues.calendarReference}`
          : '';
        const value =
          normalizeText(
            `${slotValues.eventReference} to ${destinationParts}${calendarReference}`,
          ) ||
          slotValues.eventReference;
        return {
          family,
          slotValue: value,
          preferredText: `move ${value}`,
          candidateTexts: dedupe([`move ${value}`, `reschedule ${value}`]),
        };
      }
      if (slotValues.eventReference) {
        const dateOrCalendar = [slotValues.targetDate, slotValues.calendarReference]
          .filter(Boolean)
          .join(' ');
        const value =
          normalizeText(`${slotValues.eventReference} ${dateOrCalendar}`) ||
          slotValues.eventReference;
        return {
          family,
          slotValue: value,
          preferredText: `cancel ${value}`,
          candidateTexts: dedupe([`cancel ${value}`, `delete ${value}`]),
        };
      }
      if (slotValues.reminderBody) {
        const reminderTail = [slotValues.reminderDate, slotValues.reminderTime]
          .filter(Boolean)
          .join(' ');
        const value =
          normalizeText(`${slotValues.reminderBody} ${reminderTail}`) ||
          slotValues.reminderBody;
        return {
          family,
          slotValue: value,
          preferredText: `remind me to ${value}`,
          candidateTexts: dedupe([
            `remind me to ${value}`,
            `remind me about ${value}`,
          ]),
        };
      }
      if (slotValues.calendarCreateText) {
        const value = normalizeText(slotValues.calendarCreateText) || slotValues.calendarCreateText;
        return {
          family,
          slotValue: value,
          preferredText: `add ${value}`,
          candidateTexts: dedupe([
            `add ${value}`,
            `schedule ${value}`,
            `put ${value} on my calendar`,
          ]),
        };
      }
      if (slotValues.calendarMoveText) {
        const value = normalizeText(slotValues.calendarMoveText) || slotValues.calendarMoveText;
        return {
          family,
          slotValue: value,
          preferredText: `move ${value}`,
          candidateTexts: dedupe([`move ${value}`, `reschedule ${value}`]),
        };
      }
      if (slotValues.calendarCancelText) {
        const value = normalizeText(slotValues.calendarCancelText) || slotValues.calendarCancelText;
        return {
          family,
          slotValue: value,
          preferredText: `cancel ${value}`,
          candidateTexts: dedupe([`cancel ${value}`, `delete ${value}`]),
        };
      }
      if (slotValues.reminderText) {
        const value = normalizeText(slotValues.reminderText) || slotValues.reminderText;
        return {
          family,
          slotValue: value,
          preferredText: `remind me ${value}`,
          candidateTexts: dedupe([
            `remind me ${value}`,
            `remind me to ${value}`,
            `remind me at ${value}`,
            `remind me about ${value}`,
          ]),
        };
      }
      const candidates = dedupe(buildSaveRemindCandidates(slotValue || ''));
      return {
        family,
        slotValue,
        preferredText: candidates[0] || 'send me the full version',
        candidateTexts: candidates,
      };
    }
    case ALEXA_OPEN_ASK_INTENT: {
      const query = slotValue || 'what should I say back';
      const candidates = dedupe(buildOpenAskCandidates(query));
      return {
        family,
        slotValue: query,
        preferredText: candidates[0] || query,
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
  if (
    lower === 'can you help me' ||
    lower === 'help me' ||
    lower === 'what can you do'
  ) {
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
  if (isCommunicationDraftPrompt(lower)) {
    return {
      family,
      normalizedText,
      route: 'shared_capability',
      capabilityId: 'communication.draft_reply',
      capabilityText: normalizedText,
    };
  }
  const figureOutTopic = extractFigureOutTopic(normalizedText);
  if (figureOutTopic) {
    return {
      family,
      normalizedText,
      route: 'shared_capability',
      capabilityId: 'missions.propose',
      capabilityText: `help me plan ${figureOutTopic}`,
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
    if (isWeakReference(lower) || isFollowupBindingPrompt(lower)) {
      return {
        family,
        normalizedText,
        route: 'clarify',
        clarificationSpeech: buildClarificationSpeech(state),
        blockerClass: isFollowupBindingPrompt(lower)
          ? 'followup_binding_failed'
          : 'no_context_reference',
      };
    }
  } else if (isWeakReference(lower)) {
    return {
      family,
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
      blockerClass: isFollowupBindingPrompt(lower)
        ? 'followup_binding_failed'
        : 'no_context_reference',
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

  if (isCommunicationDraftPrompt(lower)) {
    return {
      family,
      normalizedText,
      route: 'assistant_bridge',
      blockerClass: 'communication_should_route',
    };
  }
  if (figureOutTopic) {
    return {
      family,
      normalizedText,
      route: 'assistant_bridge',
      blockerClass: 'planning_should_route',
    };
  }

  return {
    family,
    normalizedText,
    route: 'assistant_bridge',
    blockerClass: 'fallback_unmatched_open_utterance',
  };
}
