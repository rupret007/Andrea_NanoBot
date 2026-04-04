export const ALEXA_MY_DAY_INTENT = 'MyDayIntent';
export const ALEXA_UPCOMING_SOON_INTENT = 'UpcomingSoonIntent';
export const ALEXA_WHAT_NEXT_INTENT = 'WhatNextIntent';
export const ALEXA_BEFORE_NEXT_MEETING_INTENT = 'BeforeNextMeetingIntent';
export const ALEXA_TOMORROW_CALENDAR_INTENT = 'TomorrowCalendarIntent';
export const ALEXA_CANDACE_UPCOMING_INTENT = 'CandaceUpcomingIntent';
export const ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT =
  'RemindBeforeNextMeetingIntent';
export const ALEXA_SAVE_FOR_LATER_INTENT = 'SaveForLaterIntent';
export const ALEXA_DRAFT_FOLLOW_UP_INTENT = 'DraftFollowUpIntent';
export const ALEXA_ANYTHING_ELSE_INTENT = 'AnythingElseIntent';
export const ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT =
  'ConversationalFollowupIntent';
export const ALEXA_MEMORY_CONTROL_INTENT = 'MemoryControlIntent';

export const ALEXA_V1_PERSONAL_INTENTS = new Set<string>([
  ALEXA_MY_DAY_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
]);

const SPOKEN_STYLE_SUFFIX =
  ' Reply for Alexa with one strong lead sentence and at most two short supporting statements. Keep the rhythm natural, warm, and spoken. No markdown. No bullet list.';

function trimSingleLine(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  return normalized ? normalized : undefined;
}

export function isAlexaPersonalIntent(intentName: string): boolean {
  return ALEXA_V1_PERSONAL_INTENTS.has(intentName);
}

export function buildAlexaPersonalPrompt(
  intentName: string,
  values: {
    leadTimeText?: string;
    captureText?: string;
    meetingReference?: string;
    conversationSummary?: string;
    personName?: string;
  } = {},
): string {
  switch (intentName) {
    case ALEXA_MY_DAY_INTENT:
      return `Give me my day. Focus on today's calendar, obligations, reminders, and what matters most right now. Make it feel like a natural morning brief, not a list.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_UPCOMING_SOON_INTENT:
      return `What do I have coming up soon? Focus on the next few meaningful events or commitments and what I should be aware of around them.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_WHAT_NEXT_INTENT:
      return `What should I do next based on my schedule, reminders, and follow-through context? Prioritize the most useful next move.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_BEFORE_NEXT_MEETING_INTENT:
      return `What should I handle before my next meeting? Focus on the most important prep or follow-through.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_TOMORROW_CALENDAR_INTENT:
      return `What's on my calendar tomorrow? Mention timed events, notable free or busy guidance, and anything important to remember.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return `What do Candace and I have coming up? Focus on shared plans, family logistics, and anything useful to keep in mind.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT:
      return `Set a reminder ${trimSingleLine(values.leadTimeText) || '30 minutes'} before my next meeting, then confirm briefly once it is saved.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_SAVE_FOR_LATER_INTENT:
      return `Save this for later as personal follow-through: ${trimSingleLine(values.captureText) || 'unspecified note'}. Confirm briefly once it is captured.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_DRAFT_FOLLOW_UP_INTENT:
      return `Draft a short follow-up for ${trimSingleLine(values.meetingReference) || 'my next meeting'}. Keep it concise and spoken so I can refine it later.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_ANYTHING_ELSE_INTENT:
      return `Continue the current assistant conversation. Based on this context: ${trimSingleLine(values.conversationSummary) || 'recent personal assistant context'}. Tell me only the next most helpful thing, without repeating the same points.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT:
      return `Continue the current assistant conversation using this follow-up: ${trimSingleLine(values.captureText) || 'unspecified follow up'}. Ground it in this context: ${trimSingleLine(values.conversationSummary) || 'recent personal assistant context'}.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_MEMORY_CONTROL_INTENT:
      return `Handle this memory-control request briefly and clearly: ${trimSingleLine(values.captureText) || 'unspecified memory request'}.${SPOKEN_STYLE_SUFFIX}`;
    default:
      return `Help me with this request: ${trimSingleLine(values.captureText) || trimSingleLine(values.meetingReference) || trimSingleLine(values.leadTimeText) || 'unknown request'}.${SPOKEN_STYLE_SUFFIX}`;
  }
}

export function buildAlexaConversationalFollowupPrompt(
  action: string,
  values: {
    conversationSummary?: string;
    followupText?: string;
    personName?: string;
  } = {},
): string {
  const summary =
    trimSingleLine(values.conversationSummary) ||
    'recent personal assistant context';
  const personName = trimSingleLine(values.personName) || 'that person';

  switch (action) {
    case 'anything_else':
      return `Continue this Alexa conversation. Based on this context: ${summary}. Tell me only the next most useful thing I should know.${SPOKEN_STYLE_SUFFIX}`;
    case 'shorter':
      return `Say the last answer again, but shorter and more direct. Keep the meaning, remove repetition, and stay grounded in this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
    case 'before_that':
      return `Based on this context: ${summary}. Tell me what I should handle before that.${SPOKEN_STYLE_SUFFIX}`;
    case 'after_that':
      return `Based on this context: ${summary}. Tell me what comes next after that.${SPOKEN_STYLE_SUFFIX}`;
    case 'switch_person':
      return `Stay in the same assistant conversation, but shift the focus to ${personName}. Use this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
    case 'remind_before_that':
      return `Set a reminder before the meeting or event described here: ${summary}. Confirm briefly once it is saved.${SPOKEN_STYLE_SUFFIX}`;
    case 'save_that':
      return `Save the key follow-through item from this context for later: ${summary}. Confirm briefly once it is captured.${SPOKEN_STYLE_SUFFIX}`;
    case 'draft_followup':
      return `Draft a short follow-up for the meeting or topic described here: ${summary}. Keep it concise and spoken.${SPOKEN_STYLE_SUFFIX}`;
    default:
      return `Continue this Alexa conversation using this follow-up: ${trimSingleLine(values.followupText) || 'unspecified follow up'}. Ground it in this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
  }
}

export function buildAlexaHelpSpeech(assistantName: string): string {
  return `${assistantName} can brief you on today, tell you what is next, talk through tomorrow, help with shared plans, and stay with short follow-up questions like anything else or remind me before that.`;
}

export function buildAlexaWelcomeSpeech(assistantName: string): string {
  return `${assistantName} is ready. Ask about today, what is next, tomorrow, shared plans with Candace, or follow up naturally from there.`;
}

export function buildAlexaFallbackSpeech(assistantName: string): string {
  return `${assistantName} works best with short personal assistant requests like what matters today, what is next, what is on my calendar tomorrow, or remind me before that.`;
}

export function buildReminderLeadTimeQuestion(assistantName: string): string {
  return `How long before your next meeting should ${assistantName} remind you?`;
}

export function buildReminderConfirmationSpeech(
  assistantName: string,
  leadTimeText: string,
): string {
  return `${assistantName} can remind you ${leadTimeText} before your next meeting. Want me to save it?`;
}

export function buildSaveForLaterQuestion(assistantName: string): string {
  return `What do you want ${assistantName} to save for later?`;
}

export function buildSaveForLaterConfirmationSpeech(
  assistantName: string,
  captureText: string,
): string {
  const preview = trimSingleLine(captureText) || 'that';
  const clipped =
    preview.length > 80 ? `${preview.slice(0, 77).trim()}...` : preview;
  return `${assistantName} can save "${clipped}" for later. Want me to keep it?`;
}

export function buildDraftFollowUpQuestion(): string {
  return 'Which meeting do you mean?';
}
