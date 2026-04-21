import { TIMEZONE } from './config.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  planCalendarAssistantLookup,
  type CalendarActiveEventContext,
  type CalendarEvent,
} from './calendar-assistant.js';
import { isPotentialDailyCompanionPrompt } from './daily-companion.js';
import {
  buildGroundedDaySnapshot,
  describeWindowCapacity,
  describeWindowForSelectedWork,
  formatClock,
  formatWindow,
  minutesBetween,
  summarizeDuration,
  type DailyCommandCenterDeps,
  type GroundedDaySnapshot,
  type SelectedWorkContext,
  type UpcomingReminderSummary,
} from './daily-command-center.js';
import {
  isExplicitGoogleCalendarCreateRequest,
} from './google-calendar-create.js';
import {
  planContextualReminder,
  planSimpleReminder,
  type PlannedReminder,
} from './local-reminder.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';
import { canonicalizeBlueBubblesSelfThreadJid } from './bluebubbles-self-thread.js';

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;

function looksLikeFreshWorkCockpitPrompt(message: string): boolean {
  const normalized = normalizeMessage(message).toLowerCase();
  return (
    normalized === 'current work' ||
    normalized === "show me what's running" ||
    normalized === 'show me whats running' ||
    normalized === "show me what's running right now" ||
    normalized === 'show me whats running right now' ||
    normalized === "what's on deck for my repos" ||
    normalized === 'whats on deck for my repos' ||
    normalized === 'show me a repo standup' ||
    normalized === "what's running" ||
    normalized === 'whats running' ||
    normalized === 'what work is active right now' ||
    normalized === "what's the latest from runtime" ||
    normalized === 'whats the latest from runtime' ||
    normalized === 'open the current task again'
  );
}

function looksLikeFreshDiscoveryPrompt(message: string): boolean {
  return /^(?:who are you|what can you do|what can you actually do for me|what all (?:do|can) you handle(?: again)?|what do you handle(?: again)?|what all can you do(?: again)?|what do you actually do(?: for me)?|what are you useful for(?: right now| today)?|what can you help me with(?: today| right now)?|what should i use you for(?: tonight| right now| today)?)\b/i.test(
    normalizeMessage(message),
  );
}

type ActionLayerIntentKind =
  | 'what_next'
  | 'before_next_meeting'
  | 'next_free_window'
  | 'meeting_prep'
  | 'capture_reminder'
  | 'draft_message'
  | 'draft_follow_up'
  | 'draft_email'
  | 'draft_status_update'
  | 'draft_pre_meeting_note'
  | 'summary_today';

export interface ActionLayerIntent {
  kind: ActionLayerIntentKind;
  reminderTimeHint: string | null;
  explicitRecipient: string | null;
  explicitTopic: string | null;
}

export interface ActionLayerContextState {
  version: 1;
  createdAt: string;
  sourceKind:
    | 'selected_work'
    | 'calendar_event'
    | 'reminder'
    | 'action_suggestion';
  label: string;
  selectedWork: SelectedWorkContext | null;
  event: CalendarActiveEventContext | null;
  reminder: UpcomingReminderSummary | null;
  suggestedReminderLabel: string | null;
  suggestedDraftTopic: string | null;
  recipient?: string | null;
  draftKind?: PendingActionDraftState['draftKind'] | null;
}

export interface PendingActionReminderState {
  version: 1;
  createdAt: string;
  label: string;
  status?: 'awaiting_time' | 'created';
  originChatJid?: string | null;
  canonicalChatJid?: string | null;
  confirmation?: string | null;
  taskId?: string | null;
}

export interface PendingActionDraftState {
  version: 1;
  createdAt: string;
  step: 'clarify_topic' | 'clarify_recipient';
  draftKind:
    | 'message'
    | 'follow_up'
    | 'note'
    | 'email'
    | 'status_update'
    | 'pre_meeting_note';
  topicLabel: string | null;
  recipient: string | null;
  selectedWork: SelectedWorkContext | null;
  event: CalendarActiveEventContext | null;
  sourceLabel: string | null;
  timeZone?: string | null;
  topicPrompt?: string | null;
}

export function shouldInterruptPendingActionLayerFlow(
  message: string,
  params: {
    now?: Date;
    timeZone?: string;
    groupFolder?: string;
    chatJid?: string;
  } = {},
): boolean {
  const now = params.now || new Date();
  const timeZone = params.timeZone || TIMEZONE;
  const trimmed = message.trim();
  if (!trimmed) {
    return false;
  }
  const freshCapabilityPrompt = Boolean(matchAssistantCapabilityRequest(message));
  return Boolean(
    trimmed.startsWith('/') ||
      looksLikeFreshDiscoveryPrompt(message) ||
      looksLikeFreshWorkCockpitPrompt(message) ||
      isPotentialDailyCompanionPrompt(message) ||
      planCalendarAssistantLookup(message, now, timeZone) ||
      isExplicitGoogleCalendarCreateRequest(message) ||
      freshCapabilityPrompt ||
      (params.groupFolder &&
        params.chatJid &&
        planSimpleReminder(message, params.groupFolder, params.chatJid, now)),
  );
}

interface ActionLayerDeps extends DailyCommandCenterDeps {
  actionContext?: ActionLayerContextState | null;
  activeEventContext?: CalendarActiveEventContext | null;
  groupFolder?: string;
  chatJid?: string;
}

export type ActionLayerResult =
  | { kind: 'none' }
  | {
      kind: 'reply';
      reply: string;
      actionContext: ActionLayerContextState | null;
      activeEventContext: CalendarActiveEventContext | null;
    }
  | {
      kind: 'awaiting_reminder_time';
      message: string;
      state: PendingActionReminderState;
    }
  | {
      kind: 'created_reminder';
      confirmation: string;
      task: PlannedReminder['task'];
      actionContext: ActionLayerContextState | null;
      state?: PendingActionReminderState;
    }
  | {
      kind: 'awaiting_draft_input';
      message: string;
      state: PendingActionDraftState;
      actionContext: ActionLayerContextState | null;
    };

function normalizeMessage(message: string): string {
  return message
    .replace(/[â€™â€˜]/g, "'")
    .replace(/[â€œâ€]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim()
    .replace(
      /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|please)[,!. ]+)*(?:@?andrea[,!. ]+)?/i,
      '',
    )
    .trim()
    .replace(/\s+/g, ' ');
}

function hasExplicitReminderTimingTail(message: string): boolean {
  return (
    /\b(?:today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?:\s+(?:morning|afternoon|evening|tonight|at\b.*))?\s*[.?!]*$/i.test(
      message,
    ) ||
    /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+(?:today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday))?\s*[.?!]*$/i.test(
      message,
    )
  );
}

function buildPendingReminderState(params: {
  label: string;
  now: Date;
  chatJid?: string | null;
  status?: 'awaiting_time' | 'created';
  confirmation?: string | null;
  taskId?: string | null;
}): PendingActionReminderState {
  return {
    version: 1,
    createdAt: params.now.toISOString(),
    label: params.label,
    status: params.status || 'awaiting_time',
    originChatJid: params.chatJid || null,
    canonicalChatJid: canonicalizeBlueBubblesSelfThreadJid(params.chatJid) || null,
    confirmation: params.confirmation || null,
    taskId: params.taskId || null,
  };
}

function isReminderConfirmationPrompt(message: string): boolean {
  return /^(?:you get that|did you get that|you got that|got that|got it|you get it|did you get it|is that set|is that saved|sounds good|thanks|thank you)[?.! ]*$/i.test(
    message,
  );
}

function trimTrailingPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[.?!]+$/g, '')
    .trim();
}

function isContextPlaceholder(value: string | null | undefined): boolean {
  const normalized = trimTrailingPunctuation(value || '').toLowerCase();
  if (!normalized) return true;
  return (
    normalized === 'this' ||
    normalized === 'that' ||
    normalized === 'it' ||
    normalized === 'this meeting' ||
    normalized === 'that meeting' ||
    normalized === 'this event' ||
    normalized === 'that event' ||
    normalized === 'this task' ||
    normalized === 'that task' ||
    normalized === "what's next" ||
    normalized === 'whats next'
  );
}

function parseTopicTail(value: string | null | undefined): string | null {
  const normalized = trimTrailingPunctuation(value || '');
  if (!normalized || isContextPlaceholder(normalized)) {
    return null;
  }
  return normalized;
}

function extractRecipient(message: string): {
  message: string;
  recipient: string | null;
} {
  const match = message.match(/\b(?:for|to)\s+(.+?)\s*$/i);
  if (!match) {
    return { message: trimTrailingPunctuation(message), recipient: null };
  }

  const recipient = trimTrailingPunctuation(match[1] || '');
  const trimmed = trimTrailingPunctuation(message.slice(0, match.index).trim());
  return {
    message: trimmed,
    recipient: recipient || null,
  };
}

export function planActionLayerIntent(
  message: string,
): ActionLayerIntent | null {
  const normalized = normalizeVoicePrompt(message);
  if (!normalized) return null;
  const reminderNormalized = normalizeMessage(message);

  if (/^what can i knock out in my next free window\??$/i.test(normalized)) {
    return {
      kind: 'next_free_window',
      reminderTimeHint: null,
      explicitRecipient: null,
      explicitTopic: null,
    };
  }

  const capturePatterns = [
    /^(turn that into a reminder|remind me about that|save that for later|capture this for later today|remind me to come back to this)(?:\s+(.+))?$/i,
    /^save this as something i need to send(?:\s+(.+))?$/i,
    /^turn this draft into a reminder(?:\s+(.+))?$/i,
    /^remind me to send this(?:\s+(.+))?$/i,
  ];
  for (const pattern of capturePatterns) {
    const captureMatch = normalized.match(pattern);
    if (!captureMatch) continue;
    return {
      kind: 'capture_reminder',
      reminderTimeHint: trimTrailingPunctuation(captureMatch[2] || '') || null,
      explicitRecipient: null,
      explicitTopic: null,
    };
  }

  const directReminderMatch = reminderNormalized.match(
    /^(?:remind me|help me remember)\s+to\s+(.+?)\s*$/i,
  );
  if (directReminderMatch) {
    const reminderTopic = trimTrailingPunctuation(directReminderMatch[1] || '');
    if (reminderTopic && !hasExplicitReminderTimingTail(reminderTopic)) {
      return {
        kind: 'capture_reminder',
        reminderTimeHint: null,
        explicitRecipient: null,
        explicitTopic: reminderTopic,
      };
    }
  }

  const noteToMatch = normalized.match(
    /^help me write a note (?:to|for)\s+(.+?)\s+about\s+(.+)$/i,
  );
  if (noteToMatch) {
    return {
      kind: 'draft_message',
      reminderTimeHint: null,
      explicitRecipient: trimTrailingPunctuation(noteToMatch[1] || '') || null,
      explicitTopic: parseTopicTail(noteToMatch[2] || ''),
    };
  }

  const aboutTailDrafts: Array<{
    pattern: RegExp;
    kind: ActionLayerIntentKind;
  }> = [
    {
      pattern: /^draft a message about(?:\s+(.+))?$/i,
      kind: 'draft_message',
    },
    {
      pattern: /^draft an email about(?:\s+(.+))?$/i,
      kind: 'draft_email',
    },
    {
      pattern: /^help me write a quick note about(?:\s+(.+))?$/i,
      kind: 'draft_message',
    },
    {
      pattern: /^draft a quick update about(?:\s+(.+))?$/i,
      kind: 'draft_status_update',
    },
  ];
  for (const entry of aboutTailDrafts) {
    const match = normalized.match(entry.pattern);
    if (!match) continue;
    const recipientInfo = extractRecipient(match[1] || '');
    return {
      kind: entry.kind,
      reminderTimeHint: null,
      explicitRecipient: recipientInfo.recipient,
      explicitTopic: parseTopicTail(recipientInfo.message),
    };
  }

  const simpleDraftPatterns: Array<{
    pattern: RegExp;
    kind: ActionLayerIntentKind;
  }> = [
    {
      pattern: /^draft a follow-up for this (?:meeting|event)(?:\s+(.+))?$/i,
      kind: 'draft_follow_up',
    },
    {
      pattern: /^what should i send after this meeting\??$/i,
      kind: 'draft_follow_up',
    },
    {
      pattern: /^help me follow up on this task\??$/i,
      kind: 'draft_status_update',
    },
    {
      pattern: /^turn this into a short follow-up message\??$/i,
      kind: 'draft_message',
    },
    {
      pattern: /^what should i send before my next meeting\??$/i,
      kind: 'draft_pre_meeting_note',
    },
    {
      pattern: /^draft a reminder message for me to send later\??$/i,
      kind: 'draft_message',
    },
  ];
  for (const entry of simpleDraftPatterns) {
    const match = normalized.match(entry.pattern);
    if (!match) continue;
    const recipientInfo = extractRecipient(match[1] || '');
    return {
      kind: entry.kind,
      reminderTimeHint: null,
      explicitRecipient: recipientInfo.recipient,
      explicitTopic: parseTopicTail(recipientInfo.message),
    };
  }

  return null;
}

function coerceEventContext(
  event: CalendarActiveEventContext | CalendarEvent,
): CalendarActiveEventContext | null {
  if (!('providerLabel' in event)) {
    return event as CalendarActiveEventContext;
  }
  return toCalendarActiveEventContext(event);
}

function buildCalendarEventContext(
  event: CalendarActiveEventContext | CalendarEvent,
  now: Date,
  sourceKind: ActionLayerContextState['sourceKind'] = 'calendar_event',
): ActionLayerContextState {
  const eventContext = coerceEventContext(event);
  const title = event.title;
  const eventStart = new Date(event.startIso).getTime();
  const eventEnd = new Date(event.endIso).getTime();
  const reminderLabel =
    eventStart > now.getTime()
      ? `prepare for ${title}`
      : eventEnd > now.getTime()
        ? `follow up on ${title}`
        : `follow up on ${title}`;

  return {
    version: 1,
    createdAt: now.toISOString(),
    sourceKind,
    label: title,
    selectedWork: null,
    event: eventContext,
    reminder: null,
    suggestedReminderLabel: reminderLabel,
    suggestedDraftTopic: title,
    recipient: null,
    draftKind: null,
  };
}

function buildSelectedWorkContext(
  selectedWork: SelectedWorkContext,
  now: Date,
  sourceKind: ActionLayerContextState['sourceKind'] = 'selected_work',
): ActionLayerContextState {
  return {
    version: 1,
    createdAt: now.toISOString(),
    sourceKind,
    label: selectedWork.title,
    selectedWork,
    event: null,
    reminder: null,
    suggestedReminderLabel: `come back to ${selectedWork.title}`,
    suggestedDraftTopic: selectedWork.title,
    recipient: null,
    draftKind: null,
  };
}

function buildReminderContext(
  reminder: UpcomingReminderSummary,
  now: Date,
): ActionLayerContextState {
  return {
    version: 1,
    createdAt: now.toISOString(),
    sourceKind: 'reminder',
    label: reminder.label,
    selectedWork: null,
    event: null,
    reminder,
    suggestedReminderLabel: reminder.label,
    suggestedDraftTopic: reminder.label,
    recipient: null,
    draftKind: null,
  };
}

function buildActionSuggestionContext(
  label: string,
  now: Date,
): ActionLayerContextState {
  return {
    version: 1,
    createdAt: now.toISOString(),
    sourceKind: 'action_suggestion',
    label,
    selectedWork: null,
    event: null,
    reminder: null,
    suggestedReminderLabel: label,
    suggestedDraftTopic: label,
    recipient: null,
    draftKind: null,
  };
}

function toCalendarActiveEventContext(
  event: CalendarEvent,
): CalendarActiveEventContext | null {
  if (event.providerId !== 'google_calendar' || !event.calendarId) {
    return null;
  }

  return {
    providerId: 'google_calendar',
    id: event.id,
    title: event.title,
    startIso: event.startIso,
    endIso: event.endIso,
    allDay: event.allDay,
    calendarId: event.calendarId,
    calendarName: event.calendarName || 'Google Calendar',
    htmlLink: event.htmlLink || null,
  };
}

function eventContextFromGroundedSnapshot(
  grounded: GroundedDaySnapshot,
): CalendarActiveEventContext | null {
  return grounded.calendar.nextTimedEvent
    ? toCalendarActiveEventContext(grounded.calendar.nextTimedEvent)
    : null;
}

function resolveFollowThroughContext(params: {
  now: Date;
  grounded: GroundedDaySnapshot;
  actionContext: ActionLayerContextState | null;
  activeEventContext: CalendarActiveEventContext | null;
}): ActionLayerContextState | null {
  if (params.actionContext) {
    return {
      ...params.actionContext,
      createdAt: params.now.toISOString(),
    };
  }

  if (params.activeEventContext) {
    return buildCalendarEventContext(params.activeEventContext, params.now);
  }

  if (params.grounded.selectedWork) {
    return buildSelectedWorkContext(params.grounded.selectedWork, params.now);
  }

  if (params.grounded.currentFocus.nextReminder) {
    return buildReminderContext(
      params.grounded.currentFocus.nextReminder,
      params.now,
    );
  }

  if (params.grounded.currentFocus.nextEvent) {
    return buildCalendarEventContext(
      params.grounded.currentFocus.nextEvent,
      params.now,
    );
  }

  return null;
}

function formatEventLineFromContext(
  event: CalendarActiveEventContext | CalendarEvent,
  timeZone: string,
): string {
  if (event.allDay) {
    return `Next: All day ${event.title}`;
  }
  return `Next: ${formatClock(new Date(event.startIso), timeZone)}-${formatClock(
    new Date(event.endIso),
    timeZone,
  )} ${event.title}`;
}

function buildWhatNextReply(grounded: GroundedDaySnapshot): {
  reply: string;
  actionContext: ActionLayerContextState | null;
} {
  const { currentFocus, timeZone, calendar, meaningfulOpenWindows, now } =
    grounded;

  if (calendar.unavailableReply) {
    return {
      reply: buildVoiceReply({
        summary:
          "I can't fully ground your next step in calendar data right now.",
        details: [
          grounded.selectedWork
            ? `Work: ${grounded.selectedWork.title} (${grounded.selectedWork.statusLabel})`
            : null,
        ],
        honesty: `Calendar: ${calendar.unavailableReply}`,
      }),
      actionContext: grounded.selectedWork
        ? buildSelectedWorkContext(grounded.selectedWork, now)
        : null,
    };
  }

  const lines: string[] = [];
  let actionContext: ActionLayerContextState | null = null;

  if (
    currentFocus.reason === 'reminder_due_soon' &&
    currentFocus.nextReminder
  ) {
    lines.push(
      `Start with your reminder at ${formatClock(
        new Date(currentFocus.nextReminder.nextRunIso),
        timeZone,
      )}.`,
    );
    lines.push(
      `Reminder: ${formatClock(
        new Date(currentFocus.nextReminder.nextRunIso),
        timeZone,
      )} ${currentFocus.nextReminder.label}`,
    );
    if (currentFocus.nextEvent) {
      lines.push(formatEventLineFromContext(currentFocus.nextEvent, timeZone));
    }
    actionContext = buildReminderContext(currentFocus.nextReminder, now);
  } else if (currentFocus.reason === 'meeting_soon' && currentFocus.nextEvent) {
    const minutes = minutesBetween(
      now,
      new Date(currentFocus.nextEvent.startIso),
    );
    lines.push(
      `You have ${summarizeDuration(minutes)} before ${currentFocus.nextEvent.title}, so a quick prep or reminder check is most realistic.`,
    );
    lines.push(formatEventLineFromContext(currentFocus.nextEvent, timeZone));
    actionContext = buildCalendarEventContext(currentFocus.nextEvent, now);
  } else if (
    currentFocus.reason === 'selected_work' &&
    currentFocus.selectedWork &&
    currentFocus.nextMeaningfulOpenWindow
  ) {
    lines.push(
      `Resuming ${currentFocus.selectedWork.title} is the best grounded next step right now.`,
    );
    lines.push(
      `Open: ${formatWindow(
        currentFocus.nextMeaningfulOpenWindow,
        timeZone,
      )} (${summarizeDuration(
        minutesBetween(
          currentFocus.nextMeaningfulOpenWindow.start,
          currentFocus.nextMeaningfulOpenWindow.end,
        ),
      )})`,
    );
    lines.push(
      `Work: ${currentFocus.selectedWork.title} (${currentFocus.selectedWork.statusLabel})`,
    );
    actionContext = buildSelectedWorkContext(currentFocus.selectedWork, now);
  } else if (currentFocus.nextEvent) {
    lines.push(
      `I don't have a selected work item, so the next grounded thing is ${currentFocus.nextEvent.title} at ${formatClock(
        new Date(currentFocus.nextEvent.startIso),
        timeZone,
      )}.`,
    );
    lines.push(formatEventLineFromContext(currentFocus.nextEvent, timeZone));
    if (meaningfulOpenWindows[0]) {
      lines.push(`Open: ${formatWindow(meaningfulOpenWindows[0], timeZone)}`);
    }
    actionContext = buildCalendarEventContext(currentFocus.nextEvent, now);
  } else if (meaningfulOpenWindows[0]) {
    const window = meaningfulOpenWindows[0];
    lines.push(
      `I don't have a selected work item, but you do have ${summarizeDuration(
        minutesBetween(window.start, window.end),
      )} open right now.`,
    );
    lines.push(`Open: ${formatWindow(window, timeZone)}`);
    actionContext = buildActionSuggestionContext(
      `use the open block ${formatWindow(window, timeZone)}`,
      now,
    );
  } else {
    lines.push(
      "I don't have enough grounded work context to pick the next task, and I don't see a meaningful free block right now.",
    );
  }

  return {
    reply: buildVoiceReply({
      summary:
        lines[0] ||
        "I don't have enough grounded work context to pick the next task, and I don't see a meaningful free block right now.",
      details: lines.slice(1),
      honesty: calendar.incompleteNoteBody
        ? `Calendar: ${calendar.incompleteNoteBody}`
        : null,
    }),
    actionContext,
  };
}

function buildBeforeNextMeetingReply(grounded: GroundedDaySnapshot): {
  reply: string;
  actionContext: ActionLayerContextState | null;
} {
  const nextEvent = grounded.currentFocus.nextEvent;
  const { timeZone, now, selectedWork, calendar } = grounded;
  if (calendar.unavailableReply) {
    return {
      reply: buildVoiceReply({
        summary:
          "I can't safely size the time before your next meeting right now.",
        honesty: `Calendar: ${calendar.unavailableReply}`,
      }),
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  if (!nextEvent) {
    return {
      reply: selectedWork
        ? `You don't have another meeting today, so you can keep moving on ${selectedWork.title}.`
        : "You don't have another meeting today, and I don't have a selected work item.",
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  const minutes = minutesBetween(now, new Date(nextEvent.startIso));
  return {
    reply: buildVoiceReply({
      summary: selectedWork
        ? `You have ${describeWindowForSelectedWork(
            minutes,
            selectedWork,
          )} before ${nextEvent.title}.`
        : `Before ${nextEvent.title}, you have ${describeWindowCapacity(
            minutes,
          )} This is schedule-based guidance only.`,
      details: [
        formatEventLineFromContext(nextEvent, timeZone),
        selectedWork
          ? `Work: ${selectedWork.title} (${selectedWork.statusLabel})`
          : null,
      ],
      honesty: calendar.incompleteNoteBody
        ? `Calendar: ${calendar.incompleteNoteBody}`
        : null,
    }),
    actionContext: selectedWork
      ? buildSelectedWorkContext(selectedWork, now)
      : buildCalendarEventContext(nextEvent, now, 'action_suggestion'),
  };
}

function buildNextFreeWindowReply(grounded: GroundedDaySnapshot): {
  reply: string;
  actionContext: ActionLayerContextState | null;
} {
  const nextWindow = grounded.meaningfulOpenWindows[0];
  const { selectedWork, timeZone, now, calendar } = grounded;
  if (calendar.unavailableReply) {
    return {
      reply: buildVoiceReply({
        summary: "I can't safely size your next free window right now.",
        honesty: `Calendar: ${calendar.unavailableReply}`,
      }),
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  if (!nextWindow) {
    return {
      reply: buildVoiceReply({
        summary: "I don't see a meaningful free window left today.",
        honesty: calendar.incompleteNoteBody
          ? `Calendar: ${calendar.incompleteNoteBody}`
          : null,
      }),
      actionContext: null,
    };
  }

  const minutes = minutesBetween(nextWindow.start, nextWindow.end);
  return {
    reply: buildVoiceReply({
      summary: selectedWork
        ? `Your next free window is ${formatWindow(
            nextWindow,
            timeZone,
          )}. ${describeWindowForSelectedWork(minutes, selectedWork)}`
        : `Your next free window is ${formatWindow(
            nextWindow,
            timeZone,
          )}. ${describeWindowCapacity(minutes)} This is schedule-based guidance only.`,
      details: [
        `Open: ${formatWindow(nextWindow, timeZone)}`,
        selectedWork
          ? `Work: ${selectedWork.title} (${selectedWork.statusLabel})`
          : null,
      ],
      honesty: calendar.incompleteNoteBody
        ? `Calendar: ${calendar.incompleteNoteBody}`
        : null,
    }),
    actionContext: selectedWork
      ? buildSelectedWorkContext(selectedWork, now)
      : buildActionSuggestionContext(
          `use the next free window ${formatWindow(nextWindow, timeZone)}`,
          now,
        ),
  };
}

function buildSummaryTodayReply(grounded: GroundedDaySnapshot): {
  reply: string;
  actionContext: ActionLayerContextState | null;
} {
  const { currentFocus, timeZone, now, calendar, selectedWork } = grounded;
  const lines: string[] = [];
  let actionContext: ActionLayerContextState | null = null;

  if (calendar.unavailableReply) {
    if (selectedWork) {
      actionContext = buildSelectedWorkContext(selectedWork, now);
    }
    return {
      reply: buildVoiceReply({
        summary:
          'I can only summarize this from work and reminder context right now.',
        details: selectedWork
          ? [`Work: ${selectedWork.title} (${selectedWork.statusLabel})`]
          : [],
        honesty: `Calendar: ${calendar.unavailableReply}`,
      }),
      actionContext,
    };
  }

  if (currentFocus.nextReminder) {
    lines.push(
      `First handle the reminder at ${formatClock(
        new Date(currentFocus.nextReminder.nextRunIso),
        timeZone,
      )}.`,
    );
    lines.push(
      `Reminder: ${formatClock(
        new Date(currentFocus.nextReminder.nextRunIso),
        timeZone,
      )} ${currentFocus.nextReminder.label}`,
    );
    actionContext = buildReminderContext(currentFocus.nextReminder, now);
  }

  if (
    lines.length < 4 &&
    selectedWork &&
    grounded.meaningfulOpenWindows[0] &&
    minutesBetween(
      grounded.meaningfulOpenWindows[0].start,
      grounded.meaningfulOpenWindows[0].end,
    ) >= 20
  ) {
    lines.push(`Then use the open block to resume ${selectedWork.title}.`);
    lines.push(
      `Open: ${formatWindow(grounded.meaningfulOpenWindows[0], timeZone)}`,
    );
    if (!actionContext) {
      actionContext = buildSelectedWorkContext(selectedWork, now);
    }
  } else if (lines.length < 4 && currentFocus.nextEvent) {
    lines.push(`Later, be ready for ${currentFocus.nextEvent.title}.`);
    lines.push(formatEventLineFromContext(currentFocus.nextEvent, timeZone));
    if (!actionContext) {
      actionContext = buildCalendarEventContext(currentFocus.nextEvent, now);
    }
  }

  if (lines.length === 0) {
    lines.push('There is not much urgent today from the signals I can ground.');
    if (grounded.meaningfulOpenWindows[0]) {
      lines.push(
        `Open: ${formatWindow(grounded.meaningfulOpenWindows[0], timeZone)}`,
      );
    }
  }

  return {
    reply: buildVoiceReply({
      summary:
        lines[0] ||
        'There is not much urgent today from the signals I can ground.',
      details: lines.slice(1),
      honesty: calendar.incompleteNoteBody
        ? `Calendar: ${calendar.incompleteNoteBody}`
        : null,
    }),
    actionContext,
  };
}

function resolvePrepEvent(params: {
  grounded: GroundedDaySnapshot;
  activeEventContext: CalendarActiveEventContext | null;
}): CalendarActiveEventContext | null {
  if (params.activeEventContext) {
    return params.activeEventContext;
  }
  return eventContextFromGroundedSnapshot(params.grounded);
}

function buildMeetingPrepReply(params: {
  grounded: GroundedDaySnapshot;
  activeEventContext: CalendarActiveEventContext | null;
}): {
  reply: string;
  actionContext: ActionLayerContextState | null;
  activeEventContext: CalendarActiveEventContext | null;
} {
  const event = resolvePrepEvent(params);
  if (!event) {
    return {
      reply: 'Which meeting do you mean?',
      actionContext: null,
      activeEventContext: null,
    };
  }

  const { timeZone, now } = params.grounded;
  const minutes = minutesBetween(now, new Date(event.startIso));
  const lines: string[] = [];
  if (!event.allDay && minutes <= 15) {
    lines.push(
      `You only have ${summarizeDuration(minutes)} before ${event.title}, so keep this to a quick prep pass.`,
    );
  } else {
    lines.push(`Here’s a grounded prep pass for ${event.title}.`);
  }
  lines.push(formatEventLineFromContext(event, timeZone));
  lines.push(
    'Prep: review the event details and pull up any notes you already have.',
  );
  lines.push('Prep: jot 1 or 2 questions or outcomes you want to cover.');

  return {
    reply: buildVoiceReply({
      summary: lines[0]!,
      details: lines.slice(1),
    }),
    actionContext: buildCalendarEventContext(event, now),
    activeEventContext: event,
  };
}

function buildCaptureReminderLabel(
  context: ActionLayerContextState,
  now: Date,
): string {
  if (context.suggestedReminderLabel) {
    return context.suggestedReminderLabel;
  }
  if (context.selectedWork) {
    return `come back to ${context.selectedWork.title}`;
  }
  if (context.event) {
    return new Date(context.event.startIso).getTime() > now.getTime()
      ? `prepare for ${context.event.title}`
      : `follow up on ${context.event.title}`;
  }
  if (context.reminder) {
    return context.reminder.label;
  }
  return context.label;
}

function _buildDraftFromState(state: PendingActionDraftState): string {
  const recipient = state.recipient || '[recipient]';
  const topic = state.topicLabel || state.sourceLabel || 'this';
  const referenceNow = new Date(state.createdAt).getTime();

  let body: string;
  if (state.event) {
    const eventStart = new Date(state.event.startIso).getTime();
    body =
      eventStart > referenceNow
        ? `Hi ${recipient},\n\nLooking forward to ${topic}. I want to make sure we cover [question or topic]. Let me know if there is anything you want me to prepare in advance.\n\nThanks,`
        : `Hi ${recipient},\n\nThanks for the time on ${topic}. My next step is [next step], and I wanted to send a quick follow-up while it is still fresh.\n\nThanks,`;
  } else if (state.selectedWork) {
    body = `Hi ${recipient},\n\nQuick update on ${topic}: I am working through it now. My next step is [next step], and I will follow up once I have [detail].\n\nThanks,`;
  } else {
    body = `Hi ${recipient},\n\nQuick note about ${topic}: [detail]. My next step is [next step].\n\nThanks,`;
  }

  return `Here’s a draft for ${recipient}.\nDraft: ${topic}\n\n${body}`;
}

function formatDraftClock(iso: string, timeZone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  }
}

function buildEmailSubject(state: PendingActionDraftState): string {
  const topic = state.topicLabel || state.sourceLabel || 'this';
  if (state.draftKind === 'follow_up' || (state.event && !state.selectedWork)) {
    return `Follow-up on ${topic}`;
  }
  if (state.draftKind === 'status_update' || state.selectedWork) {
    return `Update on ${topic}`;
  }
  return `Quick note about ${topic}`;
}

function buildCommunicationDraftFromState(
  state: PendingActionDraftState,
): string {
  const recipient = state.recipient || '[recipient]';
  const topic = state.topicLabel || state.sourceLabel || 'this';
  const referenceNow = new Date(state.createdAt).getTime();
  const eventTime = state.event
    ? formatDraftClock(state.event.startIso, state.timeZone)
    : null;

  let intro: string;
  let body: string;
  switch (state.draftKind) {
    case 'email': {
      intro = `Here's a short email draft for ${recipient}.`;
      body = state.event
        ? `Hi ${recipient},\n\n${new Date(state.event.startIso).getTime() > referenceNow ? `Before ${topic}${eventTime ? ` at ${eventTime}` : ''}, I wanted to share [detail] and flag [question].` : `Thanks for the time on ${topic}. My next step is [next step], and I'll follow up once I have [detail].`}\n\nThanks,`
        : state.selectedWork
          ? `Hi ${recipient},\n\nQuick update on ${topic}: I'm working through it now. My next step is [next step], and I'll follow up once I have [detail].\n\nThanks,`
          : `Hi ${recipient},\n\nQuick note about ${topic}: [detail]. My next step is [next step].\n\nThanks,`;
      return `${intro}\nSubject: ${buildEmailSubject(state)}\n\n${body}`;
    }
    case 'follow_up': {
      intro = `Here's a short follow-up for ${recipient}.`;
      if (state.event) {
        body = `Hi ${recipient},\n\nThanks for the time on ${topic}. My next step is [next step], and I wanted to send a quick follow-up while it is still fresh. Let me know if you need anything else from me.\n\nThanks,`;
      } else if (state.selectedWork) {
        body = `Hi ${recipient},\n\nQuick follow-up on ${topic}: I'm working through it now. My next step is [next step], and I'll follow up once I have [detail].\n\nThanks,`;
      } else {
        body = `Hi ${recipient},\n\nFollowing up on ${topic}: [detail]. My next step is [next step].\n\nThanks,`;
      }
      break;
    }
    case 'status_update': {
      intro = `Here's a short update draft for ${recipient}.`;
      body = state.selectedWork
        ? `Hi ${recipient},\n\nQuick update on ${topic}: I'm working through it now. My next step is [next step], and I'll follow up once I have [detail].\n\nThanks,`
        : `Hi ${recipient},\n\nQuick update on ${topic}: [detail]. My next step is [next step].\n\nThanks,`;
      break;
    }
    case 'pre_meeting_note': {
      const eventStart = state.event
        ? new Date(state.event.startIso).getTime()
        : 0;
      const minutes = state.event
        ? Math.max(0, Math.round((eventStart - referenceNow) / 60000))
        : null;
      intro =
        minutes !== null && minutes <= 15
          ? `You only have ${summarizeDuration(minutes)} before ${topic}, so keep this note short.`
          : `Here's a short note you could send before ${topic}.`;
      body = `Hi ${recipient},\n\nBefore ${topic}${eventTime ? ` at ${eventTime}` : ''}, I wanted to send over [detail] and flag [question]. Let me know if there is anything else you'd like me to bring or cover.\n\nThanks,`;
      break;
    }
    case 'note':
    case 'message':
    default: {
      intro = `Here's a draft for ${recipient}.`;
      if (state.event) {
        const eventStart = new Date(state.event.startIso).getTime();
        body =
          eventStart > referenceNow
            ? `Hi ${recipient},\n\nLooking ahead to ${topic}, I wanted to send a quick note about [detail]. Let me know if there is anything you want me to prepare in advance.\n\nThanks,`
            : `Hi ${recipient},\n\nQuick note about ${topic}: [detail]. My next step is [next step], and I wanted to send a short follow-up while it is still fresh.\n\nThanks,`;
      } else if (state.selectedWork) {
        body = `Hi ${recipient},\n\nQuick update on ${topic}: I'm working through it now. My next step is [next step], and I'll follow up once I have [detail].\n\nThanks,`;
      } else {
        body = `Hi ${recipient},\n\nQuick note about ${topic}: [detail]. My next step is [next step].\n\nThanks,`;
      }
      break;
    }
  }

  return `${intro}\nDraft: ${topic}\n\n${body}`;
}

function buildCommunicationDraftActionContext(
  state: PendingActionDraftState,
  now: Date,
): ActionLayerContextState {
  const topic = state.topicLabel || state.sourceLabel || 'this';
  let suggestedReminderLabel: string;
  if (state.recipient) {
    suggestedReminderLabel = `send note to ${state.recipient} about ${topic}`;
  } else if (state.draftKind === 'follow_up' && state.event) {
    suggestedReminderLabel = `send follow-up for ${topic}`;
  } else if (state.draftKind === 'status_update') {
    suggestedReminderLabel = `send update about ${topic}`;
  } else {
    suggestedReminderLabel = `send message about ${topic}`;
  }

  return {
    version: 1,
    createdAt: now.toISOString(),
    sourceKind: state.event
      ? 'calendar_event'
      : state.selectedWork
        ? 'selected_work'
        : 'action_suggestion',
    label: topic,
    selectedWork: state.selectedWork,
    event: state.event,
    reminder: null,
    suggestedReminderLabel,
    suggestedDraftTopic: topic,
    recipient: state.recipient,
    draftKind: state.draftKind,
  };
}

function buildDraftState(params: {
  now: Date;
  draftKind: PendingActionDraftState['draftKind'];
  topicLabel: string | null;
  recipient: string | null;
  selectedWork: SelectedWorkContext | null;
  event: CalendarActiveEventContext | null;
  sourceLabel: string | null;
  step: PendingActionDraftState['step'];
  timeZone?: string | null;
  topicPrompt?: string | null;
}): PendingActionDraftState {
  return {
    version: 1,
    createdAt: params.now.toISOString(),
    step: params.step,
    draftKind: params.draftKind,
    topicLabel: params.topicLabel,
    recipient: params.recipient,
    selectedWork: params.selectedWork,
    event: params.event,
    sourceLabel: params.sourceLabel,
    timeZone: params.timeZone || null,
    topicPrompt: params.topicPrompt || null,
  };
}

function extractExplicitDraftTopic(
  normalizedMessage: string,
  context: ActionLayerContextState | null,
): string | null {
  const topicMatch = normalizedMessage.match(
    /^(?:draft a message about|help me write a quick note about)\s+(.+)$/i,
  );
  if (topicMatch && !/\bthis\b|\bthat\b/i.test(topicMatch[1] || '')) {
    const recipientInfo = extractRecipient(topicMatch[1] || '');
    const topic = trimTrailingPunctuation(recipientInfo.message);
    if (topic) {
      return topic;
    }
  }

  if (context?.suggestedDraftTopic) {
    return context.suggestedDraftTopic;
  }
  return context?.label || null;
}

function resolveExplicitDraftTopic(
  intent: ActionLayerIntent,
  normalizedMessage: string,
  context: ActionLayerContextState | null,
): string | null {
  if (intent.explicitTopic) {
    return intent.explicitTopic;
  }

  const topicMatch = normalizedMessage.match(
    /^(?:draft a message about|draft an email about|help me write a quick note about|draft a quick update about)\s+(.+)$/i,
  );
  if (topicMatch) {
    const recipientInfo = extractRecipient(topicMatch[1] || '');
    const topic = parseTopicTail(recipientInfo.message);
    if (topic) {
      return topic;
    }
  }

  return extractExplicitDraftTopic(normalizedMessage, context);
}

export function buildActionLayerContextFromDailyCommandCenter(params: {
  grounded: GroundedDaySnapshot;
}): ActionLayerContextState | null {
  const { currentFocus, now } = params.grounded;
  if (
    currentFocus.reason === 'reminder_due_soon' &&
    currentFocus.nextReminder
  ) {
    return buildReminderContext(currentFocus.nextReminder, now);
  }
  if (currentFocus.reason === 'meeting_soon' && currentFocus.nextEvent) {
    return buildCalendarEventContext(currentFocus.nextEvent, now);
  }
  if (currentFocus.reason === 'selected_work' && currentFocus.selectedWork) {
    return buildSelectedWorkContext(currentFocus.selectedWork, now);
  }
  if (currentFocus.nextEvent) {
    return buildCalendarEventContext(currentFocus.nextEvent, now);
  }
  return null;
}

export function isActionLayerContextExpired(
  state: ActionLayerContextState,
  now: Date,
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_PENDING_TTL_MS;
}

export function isPendingActionReminderExpired(
  state: PendingActionReminderState,
  now: Date,
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_PENDING_TTL_MS;
}

export function isPendingActionDraftExpired(
  state: PendingActionDraftState,
  now: Date,
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_PENDING_TTL_MS;
}

export function advancePendingActionReminder(
  message: string,
  state: PendingActionReminderState,
  deps: Required<Pick<ActionLayerDeps, 'groupFolder' | 'chatJid'>> & {
    now?: Date;
  },
): ActionLayerResult {
  const now = deps.now || new Date();
  const normalized = normalizeMessage(message);
  if (state.status === 'created') {
    if (!normalized) {
      return {
        kind: 'reply',
        reply:
          state.confirmation ||
          `Yes. I'll remind you to ${state.label}.`,
        actionContext: buildActionSuggestionContext(state.label, now),
        activeEventContext: null,
      };
    }
    if (isReminderConfirmationPrompt(normalized)) {
      return {
        kind: 'reply',
        reply:
          state.confirmation ||
          `Yes. I'll remind you to ${state.label}.`,
        actionContext: buildActionSuggestionContext(state.label, now),
        activeEventContext: null,
      };
    }
    const repeatedReminder = planContextualReminder(
      normalized,
      state.label,
      deps.groupFolder,
      deps.chatJid,
      now,
    );
    if (repeatedReminder) {
      return {
        kind: 'reply',
        reply: state.confirmation || repeatedReminder.confirmation,
        actionContext: buildActionSuggestionContext(state.label, now),
        activeEventContext: null,
      };
    }
    return { kind: 'none' };
  }
  if (!normalized) {
    return {
      kind: 'awaiting_reminder_time',
      message: 'What time should I use?',
      state,
    };
  }
  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'reply',
      reply: "Okay, I won't turn that into a reminder.",
      actionContext: null,
      activeEventContext: null,
    };
  }

  const plannedReminder = planContextualReminder(
    normalized,
    state.label,
    deps.groupFolder,
    deps.chatJid,
    now,
  );
  if (!plannedReminder) {
    return {
      kind: 'awaiting_reminder_time',
      message:
        'What time should I use? You can say "at 4" or "tomorrow morning."',
      state,
    };
  }

  return {
    kind: 'created_reminder',
    confirmation: plannedReminder.confirmation,
    task: plannedReminder.task,
    actionContext: buildActionSuggestionContext(state.label, now),
    state: buildPendingReminderState({
      label: state.label,
      now,
      chatJid: state.originChatJid || deps.chatJid,
      status: 'created',
      confirmation: plannedReminder.confirmation,
      taskId: plannedReminder.task.id,
    }),
  };
}

function parseDraftRecipient(message: string): string | null {
  const normalized = trimTrailingPunctuation(message);
  if (!normalized) return null;
  const recipientInfo = extractRecipient(normalized);
  return (
    trimTrailingPunctuation(
      recipientInfo.recipient || recipientInfo.message || '',
    ) || null
  );
}

export function advancePendingActionDraft(
  message: string,
  state: PendingActionDraftState,
  now = new Date(),
): ActionLayerResult {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return {
      kind: 'awaiting_draft_input',
      message:
        state.step === 'clarify_topic'
          ? state.topicPrompt || 'What should the message be about?'
          : 'Who is it for?',
      state,
      actionContext: null,
    };
  }
  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'reply',
      reply: "Okay, I won't draft that message.",
      actionContext: null,
      activeEventContext: null,
    };
  }

  if (state.step === 'clarify_topic') {
    const recipientInfo = extractRecipient(normalized);
    const topic = trimTrailingPunctuation(recipientInfo.message);
    if (!topic) {
      return {
        kind: 'awaiting_draft_input',
        message: state.topicPrompt || 'What should the message be about?',
        state,
        actionContext: null,
      };
    }
    if (recipientInfo.recipient) {
      const resolvedState = {
        ...state,
        topicLabel: topic,
        recipient: recipientInfo.recipient,
      };
      return {
        kind: 'reply',
        reply: buildCommunicationDraftFromState(resolvedState),
        actionContext: buildCommunicationDraftActionContext(resolvedState, now),
        activeEventContext: resolvedState.event,
      };
    }
    return {
      kind: 'awaiting_draft_input',
      message: 'Who is it for?',
      state: {
        ...state,
        createdAt: now.toISOString(),
        step: 'clarify_recipient',
        topicLabel: topic,
      },
      actionContext: null,
    };
  }

  const recipient = parseDraftRecipient(normalized);
  if (!recipient) {
    return {
      kind: 'awaiting_draft_input',
      message: 'Who is it for?',
      state,
      actionContext: null,
    };
  }

  const resolvedState = {
    ...state,
    recipient,
  };
  return {
    kind: 'reply',
    reply: buildCommunicationDraftFromState(resolvedState),
    actionContext: buildCommunicationDraftActionContext(resolvedState, now),
    activeEventContext: resolvedState.event,
  };
}

function buildWeakContextDraftReply(input: {
  question: string;
  draftKind: PendingActionDraftState['draftKind'];
  now: Date;
  timeZone: string;
}): ActionLayerResult {
  return {
    kind: 'awaiting_draft_input',
    message: input.question,
    state: buildDraftState({
      now: input.now,
      draftKind: input.draftKind,
      topicLabel: null,
      recipient: null,
      selectedWork: null,
      event: null,
      sourceLabel: null,
      step: 'clarify_topic',
      timeZone: input.timeZone,
      topicPrompt: input.question,
    }),
    actionContext: null,
  };
}

export async function buildActionLayerResponse(
  message: string,
  deps: ActionLayerDeps = {},
): Promise<ActionLayerResult> {
  const now = deps.now || new Date();
  const intent = planActionLayerIntent(message);
  if (!intent) {
    return { kind: 'none' };
  }

  const grounded = await buildGroundedDaySnapshot(deps);
  const actionReference = resolveFollowThroughContext({
    now,
    grounded,
    actionContext: deps.actionContext || null,
    activeEventContext: deps.activeEventContext || null,
  });
  const normalized = normalizeMessage(message);

  switch (intent.kind) {
    case 'what_next': {
      const built = buildWhatNextReply(grounded);
      return {
        kind: 'reply',
        reply: built.reply,
        actionContext: built.actionContext,
        activeEventContext: null,
      };
    }
    case 'before_next_meeting': {
      const built = buildBeforeNextMeetingReply(grounded);
      return {
        kind: 'reply',
        reply: built.reply,
        actionContext: built.actionContext,
        activeEventContext: null,
      };
    }
    case 'next_free_window': {
      const built = buildNextFreeWindowReply(grounded);
      return {
        kind: 'reply',
        reply: built.reply,
        actionContext: built.actionContext,
        activeEventContext: null,
      };
    }
    case 'summary_today': {
      const built = buildSummaryTodayReply(grounded);
      return {
        kind: 'reply',
        reply: built.reply,
        actionContext: built.actionContext,
        activeEventContext: null,
      };
    }
    case 'meeting_prep': {
      const built = buildMeetingPrepReply({
        grounded,
        activeEventContext: deps.activeEventContext || null,
      });
      return {
        kind: 'reply',
        reply: built.reply,
        actionContext: built.actionContext,
        activeEventContext: built.activeEventContext,
      };
    }
    case 'capture_reminder': {
      const reminderLabel =
        intent.explicitTopic ||
        (actionReference ? buildCaptureReminderLabel(actionReference, now) : null);
      if (!reminderLabel) {
        return {
          kind: 'reply',
          reply: 'What do you want me to save as a reminder?',
          actionContext: null,
          activeEventContext: null,
        };
      }
      if (intent.reminderTimeHint && deps.groupFolder && deps.chatJid) {
        const plannedReminder = planContextualReminder(
          intent.reminderTimeHint,
          reminderLabel,
          deps.groupFolder,
          deps.chatJid,
          now,
        );
        if (plannedReminder) {
          return {
            kind: 'created_reminder',
            confirmation: plannedReminder.confirmation,
            task: plannedReminder.task,
            actionContext:
              actionReference || buildActionSuggestionContext(reminderLabel, now),
            state: buildPendingReminderState({
              label: reminderLabel,
              now,
              chatJid: deps.chatJid,
              status: 'created',
              confirmation: plannedReminder.confirmation,
              taskId: plannedReminder.task.id,
            }),
          };
        }
      }
      return {
        kind: 'awaiting_reminder_time',
        message: `I can save a reminder for ${reminderLabel}. What time should I use?`,
        state: buildPendingReminderState({
          label: reminderLabel,
          now,
          chatJid: deps.chatJid,
        }),
      };
    }
    case 'draft_message':
    case 'draft_follow_up':
    case 'draft_email':
    case 'draft_status_update':
    case 'draft_pre_meeting_note': {
      const selectedWork =
        actionReference?.selectedWork || grounded.selectedWork || null;
      const event =
        actionReference?.event ||
        deps.activeEventContext ||
        (intent.kind === 'draft_follow_up' ||
        intent.kind === 'draft_pre_meeting_note'
          ? eventContextFromGroundedSnapshot(grounded)
          : null);
      const sourceLabel = actionReference?.label || null;
      const explicitTopic = resolveExplicitDraftTopic(
        intent,
        normalized,
        actionReference,
      );
      const draftKind: PendingActionDraftState['draftKind'] =
        intent.kind === 'draft_follow_up'
          ? 'follow_up'
          : intent.kind === 'draft_email'
            ? 'email'
            : intent.kind === 'draft_status_update'
              ? 'status_update'
              : intent.kind === 'draft_pre_meeting_note'
                ? 'pre_meeting_note'
                : 'message';

      if (intent.kind === 'draft_follow_up' && !event) {
        return buildWeakContextDraftReply({
          question: 'Which meeting do you mean?',
          draftKind,
          now,
          timeZone: deps.timeZone || grounded.timeZone,
        });
      }

      if (intent.kind === 'draft_pre_meeting_note' && !event) {
        return buildWeakContextDraftReply({
          question: 'Which meeting do you mean?',
          draftKind,
          now,
          timeZone: deps.timeZone || grounded.timeZone,
        });
      }

      if (intent.kind === 'draft_status_update' && !selectedWork) {
        return buildWeakContextDraftReply({
          question: 'What task do you mean?',
          draftKind,
          now,
          timeZone: deps.timeZone || grounded.timeZone,
        });
      }

      const topicPrompt =
        intent.kind === 'draft_follow_up' ||
        intent.kind === 'draft_pre_meeting_note'
          ? 'Which meeting do you mean?'
          : intent.kind === 'draft_status_update'
            ? 'What task do you mean?'
            : 'What should the message be about?';

      if (!explicitTopic) {
        return {
          kind: 'awaiting_draft_input',
          message: topicPrompt,
          state: buildDraftState({
            now,
            draftKind,
            topicLabel: null,
            recipient: intent.explicitRecipient,
            selectedWork,
            event,
            sourceLabel,
            step: 'clarify_topic',
            timeZone: deps.timeZone || grounded.timeZone,
            topicPrompt,
          }),
          actionContext: actionReference,
        };
      }
      if (!intent.explicitRecipient) {
        return {
          kind: 'awaiting_draft_input',
          message: 'Who is it for?',
          state: buildDraftState({
            now,
            draftKind,
            topicLabel: explicitTopic,
            recipient: null,
            selectedWork,
            event,
            sourceLabel,
            step: 'clarify_recipient',
            timeZone: deps.timeZone || grounded.timeZone,
          }),
          actionContext: actionReference,
        };
      }

      const readyState = buildDraftState({
        now,
        draftKind,
        topicLabel: explicitTopic,
        recipient: intent.explicitRecipient,
        selectedWork,
        event,
        sourceLabel,
        step: 'clarify_recipient',
        timeZone: deps.timeZone || grounded.timeZone,
      });
      return {
        kind: 'reply',
        reply: buildCommunicationDraftFromState(readyState),
        actionContext: buildCommunicationDraftActionContext(readyState, now),
        activeEventContext: event,
      };
    }
    default:
      return { kind: 'none' };
  }
}
