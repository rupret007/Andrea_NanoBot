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
]);

const SPOKEN_STYLE_SUFFIX =
  ' Reply for Alexa with one short first sentence and at most two short supporting statements. No markdown. No bullet list.';

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
  } = {},
): string {
  switch (intentName) {
    case ALEXA_MY_DAY_INTENT:
      return `Give me my day. Focus on today's calendar, obligations, reminders, and anything I should know.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_UPCOMING_SOON_INTENT:
      return `What do I have coming up soon? Focus on the next few meaningful events or commitments.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_WHAT_NEXT_INTENT:
      return `What should I do next based on my schedule, reminders, and follow-through context?${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_BEFORE_NEXT_MEETING_INTENT:
      return `What should I handle before my next meeting?${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_TOMORROW_CALENDAR_INTENT:
      return `What's on my calendar tomorrow? Mention timed events and any notable free or busy guidance.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return `What do Candace and I have coming up?${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT:
      return `Set a reminder ${trimSingleLine(values.leadTimeText) || '30 minutes'} before my next meeting, then confirm briefly once it is saved.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_SAVE_FOR_LATER_INTENT:
      return `Save this for later as personal follow-through: ${trimSingleLine(values.captureText) || 'unspecified note'}. Confirm briefly once it is captured.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_DRAFT_FOLLOW_UP_INTENT:
      return `Draft a short follow-up for ${trimSingleLine(values.meetingReference) || 'my next meeting'}. Keep it concise and spoken so I can refine it later.${SPOKEN_STYLE_SUFFIX}`;
    default:
      return `Help me with this request: ${trimSingleLine(values.captureText) || trimSingleLine(values.meetingReference) || trimSingleLine(values.leadTimeText) || 'unknown request'}.${SPOKEN_STYLE_SUFFIX}`;
  }
}

export function buildAlexaHelpSpeech(assistantName: string): string {
  return `${assistantName} can tell you about your day, what is next, what is on your calendar tomorrow, and help with a reminder before your next meeting.`;
}

export function buildAlexaWelcomeSpeech(assistantName: string): string {
  return `${assistantName} is ready. You can ask for your day, what is next, what is on your calendar tomorrow, or a reminder before your next meeting.`;
}

export function buildAlexaFallbackSpeech(assistantName: string): string {
  return `${assistantName} works best with short personal assistant requests like what is next, what is on your calendar tomorrow, or remind me before my next meeting.`;
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
