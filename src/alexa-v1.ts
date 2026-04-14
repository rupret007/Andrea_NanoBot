export const ALEXA_COMPANION_GUIDANCE_INTENT = 'CompanionGuidanceIntent';
export const ALEXA_PEOPLE_HOUSEHOLD_INTENT = 'PeopleHouseholdIntent';
export const ALEXA_PLANNING_ORIENTATION_INTENT = 'PlanningOrientationIntent';
export const ALEXA_SAVE_REMIND_HANDOFF_INTENT = 'SaveRemindHandoffIntent';
export const ALEXA_OPEN_ASK_INTENT = 'OpenAskIntent';
export const ALEXA_CONVERSATION_CONTROL_INTENT = 'ConversationControlIntent';
export const ALEXA_MY_DAY_INTENT = 'MyDayIntent';
export const ALEXA_UPCOMING_SOON_INTENT = 'UpcomingSoonIntent';
export const ALEXA_WHAT_NEXT_INTENT = 'WhatNextIntent';
export const ALEXA_BEFORE_NEXT_MEETING_INTENT = 'BeforeNextMeetingIntent';
export const ALEXA_TOMORROW_CALENDAR_INTENT = 'TomorrowCalendarIntent';
export const ALEXA_CANDACE_UPCOMING_INTENT = 'CandaceUpcomingIntent';
export const ALEXA_EVENING_RESET_INTENT = 'EveningResetIntent';
export const ALEXA_WHAT_AM_I_FORGETTING_INTENT = 'WhatAmIForgettingIntent';
export const ALEXA_ANYTHING_IMPORTANT_INTENT = 'AnythingImportantIntent';
export const ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT =
  'WhatMattersMostTodayIntent';
export const ALEXA_FAMILY_UPCOMING_INTENT = 'FamilyUpcomingIntent';
export const ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT =
  'RemindBeforeNextMeetingIntent';
export const ALEXA_SAVE_FOR_LATER_INTENT = 'SaveForLaterIntent';
export const ALEXA_DRAFT_FOLLOW_UP_INTENT = 'DraftFollowUpIntent';
export const ALEXA_ANYTHING_ELSE_INTENT = 'AnythingElseIntent';
export const ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT =
  'ConversationalFollowupIntent';
export const ALEXA_MEMORY_CONTROL_INTENT = 'MemoryControlIntent';
export const ALEXA_DEFAULT_REPROMPT =
  "Ask what's on my calendar tomorrow, add milk to my shopping list, remind me to take my pills at 9, what bills do I need to pay this week, or what should I say back.";

export const ALEXA_V1_PERSONAL_INTENTS = new Set<string>([
  ALEXA_COMPANION_GUIDANCE_INTENT,
  ALEXA_PEOPLE_HOUSEHOLD_INTENT,
  ALEXA_PLANNING_ORIENTATION_INTENT,
  ALEXA_SAVE_REMIND_HANDOFF_INTENT,
  ALEXA_OPEN_ASK_INTENT,
  ALEXA_CONVERSATION_CONTROL_INTENT,
  ALEXA_MY_DAY_INTENT,
  ALEXA_UPCOMING_SOON_INTENT,
  ALEXA_WHAT_NEXT_INTENT,
  ALEXA_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_TOMORROW_CALENDAR_INTENT,
  ALEXA_CANDACE_UPCOMING_INTENT,
  ALEXA_EVENING_RESET_INTENT,
  ALEXA_WHAT_AM_I_FORGETTING_INTENT,
  ALEXA_ANYTHING_IMPORTANT_INTENT,
  ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT,
  ALEXA_FAMILY_UPCOMING_INTENT,
  ALEXA_REMIND_BEFORE_NEXT_MEETING_INTENT,
  ALEXA_SAVE_FOR_LATER_INTENT,
  ALEXA_DRAFT_FOLLOW_UP_INTENT,
  ALEXA_ANYTHING_ELSE_INTENT,
  ALEXA_CONVERSATIONAL_FOLLOWUP_INTENT,
  ALEXA_MEMORY_CONTROL_INTENT,
]);

const SPOKEN_STYLE_SUFFIX =
  ' Reply for Alexa Companion Mode with one strong lead sentence and at most two short supporting statements. Lead with the main thing first. Keep the rhythm natural, warm, practical, and lightly personable. Avoid menu-like phrasing, status-panel labels, or robotic transitions. If nothing is urgent, say that plainly. A light touch of humor is okay only when it fits naturally. No markdown. No bullet list.';

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
    case ALEXA_COMPANION_GUIDANCE_INTENT:
      return `Stay in Andrea Alexa companion mode. Help with practical daily assistant jobs like checking the schedule, setting reminders, keeping up with bills or pills, planning meals or tonight, what matters today, what to do next, what is still open, or what to remember tonight. Lead with the main thing first, then only one or two useful supporting points.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_PEOPLE_HOUSEHOLD_INTENT:
      return `Stay in Andrea Alexa companion mode. Help with people, household follow-through, or relationship-sensitive guidance using this focus: ${trimSingleLine(values.captureText) || 'the current person or household topic'}. Be warm, grounded, and practical.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_PLANNING_ORIENTATION_INTENT:
      return `Stay in Andrea Alexa companion mode. Help me orient around this plan or blocker: ${trimSingleLine(values.captureText) || 'the current plan'}. Keep it short, useful, and action-first.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_SAVE_REMIND_HANDOFF_INTENT:
      return `Stay in Andrea Alexa companion mode. Help me add, move, remind, save, or hand off this item safely: ${trimSingleLine(values.captureText) || 'the current item'}. Finish the obvious voice step when it is clear. If more detail belongs in Telegram, say that naturally.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_OPEN_ASK_INTENT:
      return `Stay in Andrea Alexa companion mode. Answer this practical question naturally and briefly: ${trimSingleLine(values.captureText) || 'the current question'}. This may be reply help, compare-and-explain help, or something the user should know before deciding. Use shared Andrea context when it genuinely helps.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_CONVERSATION_CONTROL_INTENT:
      return `Stay in Andrea Alexa companion mode. Handle this follow-up or conversation-control request naturally: ${trimSingleLine(values.captureText) || 'continue the current thread'}.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_MY_DAY_INTENT:
      return `Give me a practical morning brief for today. Focus on calendar timing, obligations, reminders, and what matters most right now. Lead with the main thing first, then only one or two useful follow-through points.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_UPCOMING_SOON_INTENT:
      return `What do I have coming up soon? Focus on the next few meaningful events or commitments and what I should keep in mind around them.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_WHAT_NEXT_INTENT:
      return `What should I do next based on my schedule, reminders, follow-through context, and family context when relevant? Prioritize the most useful next move, not just the next event.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_BEFORE_NEXT_MEETING_INTENT:
      return `What should I handle before my next meeting? Focus on the most important prep, reminder-worthy detail, or follow-through.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_TOMORROW_CALENDAR_INTENT:
      return `What does tomorrow look like? Mention timed events, whether it feels busy or open, and the main thing to keep in mind.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_CANDACE_UPCOMING_INTENT:
      return `What do Candace and I have coming up? Start with the most important human thing between us right now, then shared plans, weekend logistics, family context, or anything useful to talk through.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_EVENING_RESET_INTENT:
      return `Give me an evening reset. Focus on what to wrap up today, what to remember tonight, and anything worth teeing up for tomorrow.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_WHAT_AM_I_FORGETTING_INTENT:
      return `What am I forgetting? Look for loose ends, prep gaps, reminder carryover, and relationship-sensitive follow-through. Be practical, not alarmist.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_ANYTHING_IMPORTANT_INTENT:
      return `Anything I should know? Surface the main thing to watch for, plus one helpful supporting detail if it matters. If nothing feels urgent, say that clearly.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_WHAT_MATTERS_MOST_TODAY_INTENT:
      return `What matters most today? Lead with the single highest-priority thing, then only the most relevant supporting detail.${SPOKEN_STYLE_SUFFIX}`;
    case ALEXA_FAMILY_UPCOMING_INTENT:
      return `What does the family have going on? Focus on household plans, shared logistics, what Candace or Travis may need from me, and anything important to remember for tonight or the weekend.${SPOKEN_STYLE_SUFFIX}`;
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
    case 'say_more':
      return `Stay with the same point, but say a little more. Add only the most useful extra detail from this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
    case 'before_that':
      return `Based on this context: ${summary}. Tell me what I should handle before that.${SPOKEN_STYLE_SUFFIX}`;
    case 'after_that':
      return `Based on this context: ${summary}. Tell me what comes next after that.${SPOKEN_STYLE_SUFFIX}`;
    case 'switch_person':
      return `Stay in the same assistant conversation, but shift the focus to ${personName}. Use this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
    case 'remind_before_that':
      return `Set a reminder before the meeting or event described here: ${summary}. Confirm briefly once it is saved.${SPOKEN_STYLE_SUFFIX}`;
    case 'save_that':
    case 'save_for_later':
      return `Save the key follow-through item from this context for later: ${summary}. Confirm briefly once it is captured.${SPOKEN_STYLE_SUFFIX}`;
    case 'memory_control':
      return `Stay with the same Alexa thread, but handle this preference or memory-control change briefly and naturally. Use this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
    case 'draft_followup':
    case 'draft_follow_up':
      return `Draft a short follow-up for the meeting or topic described here: ${summary}. Keep it concise and spoken.${SPOKEN_STYLE_SUFFIX}`;
    case 'action_guidance':
      return `Based on this context: ${summary}. Tell me the most useful thing to do about that next. If a short follow-up or message would help, say so briefly.${SPOKEN_STYLE_SUFFIX}`;
    case 'risk_check':
      return `Based on this context: ${summary}. Tell me if there is anything I should keep an eye on or worry about, without overstating it.${SPOKEN_STYLE_SUFFIX}`;
    default:
      return `Continue this Alexa conversation using this follow-up: ${trimSingleLine(values.followupText) || 'unspecified follow up'}. Ground it in this context: ${summary}.${SPOKEN_STYLE_SUFFIX}`;
  }
}

export function buildAlexaOpenConversationPrompt(
  utterance: string,
  values: {
    conversationSummary?: string;
  } = {},
): string {
  const summary =
    trimSingleLine(values.conversationSummary) ||
    'the current Alexa conversation';
  const prompt = trimSingleLine(utterance) || 'the user needs help';
  return `Stay in the same Andrea Alexa conversation. The user just said: ${prompt}. Use this context when it genuinely helps: ${summary}. Answer naturally, briefly, and like a calm capable companion. If the request is actionable and already supported, help with it or ask one short clarification.${SPOKEN_STYLE_SUFFIX}`;
}

export function buildAlexaHelpSpeech(assistantName: string): string {
  return `This is ${assistantName}. I'm best at your schedule, reminders, lists, planning tonight, open follow-through, and quick reply help. Try what's on my calendar tomorrow, add milk to my shopping list, remind me to take my pills at 9, what bills do I need to pay this week, help me plan tonight, or what should I say back. If we need more detail, I can send it to Telegram.`;
}

export function buildAlexaWelcomeSpeech(assistantName: string): string {
  return `This is ${assistantName}. I can help with your schedule, reminders, lists, planning tonight, open follow-through, and quick reply help. Try what's on my calendar tomorrow, add milk to my shopping list, remind me to take my pills at 9, what bills do I need to pay this week, or what should I say back.`;
}

export function buildAlexaFallbackSpeech(assistantName: string): string {
  return `This is ${assistantName}. I didn't catch that. Ask about your schedule, your grocery list, a reminder, planning tonight, what bills are still open, or what you should say back.`;
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
