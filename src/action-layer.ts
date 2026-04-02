import type {
  CalendarActiveEventContext,
  CalendarEvent,
} from './calendar-assistant.js';
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
  planContextualReminder,
  type PlannedReminder,
} from './local-reminder.js';

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;

type ActionLayerIntentKind =
  | 'what_next'
  | 'before_next_meeting'
  | 'next_free_window'
  | 'meeting_prep'
  | 'capture_reminder'
  | 'draft_message'
  | 'summary_today';

export interface ActionLayerIntent {
  kind: ActionLayerIntentKind;
  reminderTimeHint: string | null;
  explicitRecipient: string | null;
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
}

export interface PendingActionReminderState {
  version: 1;
  createdAt: string;
  label: string;
}

export interface PendingActionDraftState {
  version: 1;
  createdAt: string;
  step: 'clarify_topic' | 'clarify_recipient';
  draftKind: 'message' | 'follow_up' | 'note';
  topicLabel: string | null;
  recipient: string | null;
  selectedWork: SelectedWorkContext | null;
  event: CalendarActiveEventContext | null;
  sourceLabel: string | null;
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
      /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|please)[,!. ]+)*(?:andrea[,!. ]+)?/i,
      '',
    )
    .trim()
    .replace(/\s+/g, ' ');
}

function trimTrailingPunctuation(value: string): string {
  return value
    .trim()
    .replace(/[.?!]+$/g, '')
    .trim();
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
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  if (/^what should i do next\??$/i.test(normalized)) {
    return {
      kind: 'what_next',
      reminderTimeHint: null,
      explicitRecipient: null,
    };
  }
  if (/^what should i handle before my next meeting\??$/i.test(normalized)) {
    return {
      kind: 'before_next_meeting',
      reminderTimeHint: null,
      explicitRecipient: null,
    };
  }
  if (/^what can i knock out in my next free window\??$/i.test(normalized)) {
    return {
      kind: 'next_free_window',
      reminderTimeHint: null,
      explicitRecipient: null,
    };
  }
  if (
    /^help me prepare for this meeting\??$/i.test(normalized) ||
    /^what should i do before my next meeting\??$/i.test(normalized) ||
    /^what do i need before that event\??$/i.test(normalized)
  ) {
    return {
      kind: 'meeting_prep',
      reminderTimeHint: null,
      explicitRecipient: null,
    };
  }
  if (/^summarize the actions i should take today\??$/i.test(normalized)) {
    return {
      kind: 'summary_today',
      reminderTimeHint: null,
      explicitRecipient: null,
    };
  }

  const captureMatch = normalized.match(
    /^(turn that into a reminder|remind me about that|save that for later|capture this for later today|remind me to come back to this)(?:\s+(.+))?$/i,
  );
  if (captureMatch) {
    return {
      kind: 'capture_reminder',
      reminderTimeHint: trimTrailingPunctuation(captureMatch[2] || '') || null,
      explicitRecipient: null,
    };
  }

  const draftPatterns = [
    /^draft a message about this(?:\s+(.+))?$/i,
    /^draft a follow-up for this (?:meeting|event)(?:\s+(.+))?$/i,
    /^help me write a quick note about that(?:\s+(.+))?$/i,
  ];
  for (const pattern of draftPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const recipientInfo = extractRecipient(match[1] || '');
    return {
      kind: 'draft_message',
      reminderTimeHint: null,
      explicitRecipient: recipientInfo.recipient,
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
      reply: `I can give you a next step from the current work context, but I can't fully ground it in calendar data right now.\nCalendar: ${calendar.unavailableReply}`,
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
      `Start with the reminder at ${formatClock(
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
      `You have ${summarizeDuration(minutes)} before ${currentFocus.nextEvent.title}, so a quick prep or reminder check is the most realistic next step.`,
    );
    lines.push(formatEventLineFromContext(currentFocus.nextEvent, timeZone));
    actionContext = buildCalendarEventContext(currentFocus.nextEvent, now);
  } else if (
    currentFocus.reason === 'selected_work' &&
    currentFocus.selectedWork &&
    currentFocus.nextMeaningfulOpenWindow
  ) {
    lines.push(
      `Resuming ${currentFocus.selectedWork.title} is the strongest grounded next step right now.`,
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
      `I don't have a selected work item to rank, so the next grounded thing is ${currentFocus.nextEvent.title} at ${formatClock(
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
      `I don't have a selected work item to point at, but you do have ${summarizeDuration(
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

  if (calendar.incompleteNoteBody) {
    lines.push(`Calendar: ${calendar.incompleteNoteBody}`);
  }

  return {
    reply: lines.slice(0, 4).join('\n'),
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
      reply: `I can't safely size the time before your next meeting because calendar data is unavailable.\nCalendar: ${calendar.unavailableReply}`,
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  if (!nextEvent) {
    return {
      reply: selectedWork
        ? `I don't see another meeting today, so you can keep moving on ${selectedWork.title}.`
        : "I don't see another meeting today, and I don't have a selected work item to point at.",
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  const minutes = minutesBetween(now, new Date(nextEvent.startIso));
  const lines = [
    selectedWork
      ? `Before ${nextEvent.title}, you have ${describeWindowForSelectedWork(
          minutes,
          selectedWork,
        )}`
      : `Before ${nextEvent.title}, you have ${describeWindowCapacity(
          minutes,
        )} I don't have a selected work item, so this is schedule-based guidance only.`,
    formatEventLineFromContext(nextEvent, timeZone),
  ];
  if (selectedWork) {
    lines.push(`Work: ${selectedWork.title} (${selectedWork.statusLabel})`);
  }
  if (calendar.incompleteNoteBody) {
    lines.push(`Calendar: ${calendar.incompleteNoteBody}`);
  }

  return {
    reply: lines.slice(0, 4).join('\n'),
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
      reply: `I can't safely size your next free window because calendar data is unavailable.\nCalendar: ${calendar.unavailableReply}`,
      actionContext: selectedWork
        ? buildSelectedWorkContext(selectedWork, now)
        : null,
    };
  }

  if (!nextWindow) {
    return {
      reply: calendar.incompleteNoteBody
        ? `I don't see a meaningful free window left today in the calendars I could read.\nCalendar: ${calendar.incompleteNoteBody}`
        : "I don't see a meaningful free window left today.",
      actionContext: null,
    };
  }

  const minutes = minutesBetween(nextWindow.start, nextWindow.end);
  const lines = [
    selectedWork
      ? `Your next free window is ${formatWindow(
          nextWindow,
          timeZone,
        )}. ${describeWindowForSelectedWork(minutes, selectedWork)}`
      : `Your next free window is ${formatWindow(
          nextWindow,
          timeZone,
        )}. ${describeWindowCapacity(minutes)} I don't have a selected work item, though.`,
    `Open: ${formatWindow(nextWindow, timeZone)}`,
  ];
  if (selectedWork) {
    lines.push(`Work: ${selectedWork.title} (${selectedWork.statusLabel})`);
  }
  if (calendar.incompleteNoteBody) {
    lines.push(`Calendar: ${calendar.incompleteNoteBody}`);
  }

  return {
    reply: lines.slice(0, 4).join('\n'),
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
    lines.push(
      'I can only summarize this from the work and reminder context because calendar data is unavailable right now.',
    );
    if (selectedWork) {
      lines.push(`Work: ${selectedWork.title} (${selectedWork.statusLabel})`);
      actionContext = buildSelectedWorkContext(selectedWork, now);
    }
    return { reply: lines.join('\n'), actionContext };
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

  if (calendar.incompleteNoteBody) {
    lines.push(`Calendar: ${calendar.incompleteNoteBody}`);
  }

  return { reply: lines.slice(0, 4).join('\n'), actionContext };
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
    'Prep: review the event details and pull up any notes or materials you already have.',
  );
  lines.push('Prep: jot 1 or 2 questions or outcomes you want to cover.');

  return {
    reply: lines.slice(0, 4).join('\n'),
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

function buildDraftFromState(state: PendingActionDraftState): string {
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

function buildDraftState(params: {
  now: Date;
  draftKind: PendingActionDraftState['draftKind'];
  topicLabel: string | null;
  recipient: string | null;
  selectedWork: SelectedWorkContext | null;
  event: CalendarActiveEventContext | null;
  sourceLabel: string | null;
  step: PendingActionDraftState['step'];
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
  if (!normalized) {
    return {
      kind: 'awaiting_reminder_time',
      message: `When should I remind you about ${state.label}?`,
      state,
    };
  }
  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'reply',
      reply: 'Okay, I won’t turn that into a reminder.',
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
      message: `Tell me a time like "at 4", "tomorrow morning", or "later today at 5" for ${state.label}.`,
      state,
    };
  }

  return {
    kind: 'created_reminder',
    confirmation: plannedReminder.confirmation,
    task: plannedReminder.task,
    actionContext: buildActionSuggestionContext(state.label, now),
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
          ? 'What should the message be about?'
          : 'Who is it for?',
      state,
      actionContext: null,
    };
  }
  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'reply',
      reply: 'Okay, I won’t draft that message.',
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
        message: 'What should the message be about?',
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
        reply: buildDraftFromState(resolvedState),
        actionContext: resolvedState.event
          ? buildCalendarEventContext(resolvedState.event, now)
          : resolvedState.selectedWork
            ? buildSelectedWorkContext(resolvedState.selectedWork, now)
            : buildActionSuggestionContext(topic, now),
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
    reply: buildDraftFromState(resolvedState),
    actionContext: resolvedState.event
      ? buildCalendarEventContext(resolvedState.event, now)
      : resolvedState.selectedWork
        ? buildSelectedWorkContext(resolvedState.selectedWork, now)
        : buildActionSuggestionContext(
            resolvedState.topicLabel || 'that note',
            now,
          ),
    activeEventContext: resolvedState.event,
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
      if (!actionReference) {
        return {
          kind: 'reply',
          reply: 'What do you want me to save as a reminder?',
          actionContext: null,
          activeEventContext: null,
        };
      }
      const reminderLabel = buildCaptureReminderLabel(actionReference, now);
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
            actionContext: actionReference,
          };
        }
      }
      return {
        kind: 'awaiting_reminder_time',
        message: `When should I remind you about ${reminderLabel}?`,
        state: {
          version: 1,
          createdAt: now.toISOString(),
          label: reminderLabel,
        },
      };
    }
    case 'draft_message': {
      const explicitTopic = extractExplicitDraftTopic(
        normalized,
        actionReference,
      );
      const selectedWork =
        actionReference?.selectedWork || grounded.selectedWork;
      const event = actionReference?.event || deps.activeEventContext || null;
      const sourceLabel = actionReference?.label || null;
      if (!explicitTopic) {
        return {
          kind: 'awaiting_draft_input',
          message: 'What should the message be about?',
          state: buildDraftState({
            now,
            draftKind: /\bfollow-up\b/i.test(normalized)
              ? 'follow_up'
              : 'message',
            topicLabel: null,
            recipient: intent.explicitRecipient,
            selectedWork,
            event,
            sourceLabel,
            step: 'clarify_topic',
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
            draftKind: /\bfollow-up\b/i.test(normalized)
              ? 'follow_up'
              : 'message',
            topicLabel: explicitTopic,
            recipient: null,
            selectedWork,
            event,
            sourceLabel,
            step: 'clarify_recipient',
          }),
          actionContext: actionReference,
        };
      }

      const readyState = buildDraftState({
        now,
        draftKind: /\bfollow-up\b/i.test(normalized) ? 'follow_up' : 'message',
        topicLabel: explicitTopic,
        recipient: intent.explicitRecipient,
        selectedWork,
        event,
        sourceLabel,
        step: 'clarify_recipient',
      });
      return {
        kind: 'reply',
        reply: buildDraftFromState(readyState),
        actionContext:
          actionReference ||
          (event
            ? buildCalendarEventContext(event, now)
            : selectedWork
              ? buildSelectedWorkContext(selectedWork, now)
              : buildActionSuggestionContext(explicitTopic, now)),
        activeEventContext: event,
      };
    }
    default:
      return { kind: 'none' };
  }
}
