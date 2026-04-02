import { TIMEZONE } from './config.js';
import type {
  CalendarActiveEventContext,
  CalendarEvent,
  CalendarLookupSnapshot,
  CalendarTimeWindow,
} from './calendar-assistant.js';
import {
  buildCalendarLookupSnapshot,
  lookupCalendarAssistantEvents,
  planCalendarAssistantLookup,
} from './calendar-assistant.js';
import type { ScheduledTask } from './types.js';

type DailyCommandCenterIntentKind =
  | 'day_overview'
  | 'coming_up_open'
  | 'right_now'
  | 'current_focus'
  | 'focus_now'
  | 'next_for_today'
  | 'fit_before_next_meeting'
  | 'fit_next_free_window'
  | 'open_before_end_of_day'
  | 'fit_before_anchor'
  | 'next_and_before_then';

export interface DailyCommandCenterIntent {
  kind: DailyCommandCenterIntentKind;
  anchorTimeLabel?: string | null;
  anchorDate?: Date | null;
}

export interface SelectedWorkContext {
  laneLabel: string;
  title: string;
  statusLabel: string;
  summary: string | null;
}

export interface UpcomingReminderSummary {
  id: string;
  label: string;
  nextRunIso: string;
}

type CurrentFocusReason =
  | 'reminder_due_soon'
  | 'meeting_soon'
  | 'selected_work'
  | 'schedule_only';

export interface CurrentFocusSnapshot {
  reason: CurrentFocusReason;
  selectedWork: SelectedWorkContext | null;
  nextEvent: CalendarEvent | null;
  nextReminder: UpcomingReminderSummary | null;
  nextMeaningfulOpenWindow: CalendarTimeWindow | null;
}

export interface DailyCommandCenterResponse {
  reply: string;
  activeEventContext: null;
  currentFocus: CurrentFocusSnapshot;
  grounded: GroundedDaySnapshot;
}

export interface DailyCommandCenterDeps {
  now?: Date;
  timeZone?: string;
  tasks?: ScheduledTask[];
  selectedWork?: SelectedWorkContext | null;
  activeEventContext?: CalendarActiveEventContext | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  runAppleCalendarScript?: (
    startIso: string,
    endIso: string,
  ) => Promise<string>;
}

const REST_OF_TODAY_QUERY = 'What should I know about today?';
const GIVE_ME_MY_DAY_QUERY = 'Give me my day';
export const MIN_MEANINGFUL_WINDOW_MINUTES = 20;

export interface GroundedDaySnapshot {
  now: Date;
  timeZone: string;
  calendar: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  reminders: UpcomingReminderSummary[];
  todayReminders: UpcomingReminderSummary[];
  meaningfulOpenWindows: CalendarTimeWindow[];
  currentFocus: CurrentFocusSnapshot;
}

function normalizeMessage(message: string): string {
  return message
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function parseClockTimeToDate(
  input: string,
  anchorDate: Date,
): { date: Date; label: string } | null {
  const match = input.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const rawMinute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]!.toLowerCase();
  if (rawHour < 1 || rawHour > 12 || rawMinute < 0 || rawMinute > 59) {
    return null;
  }

  let hours = rawHour % 12;
  if (meridiem === 'pm') {
    hours += 12;
  }

  const date = new Date(anchorDate);
  date.setHours(hours, rawMinute, 0, 0);
  const displayHour = hours % 12 || 12;
  const label =
    rawMinute === 0
      ? `${displayHour} ${meridiem.toUpperCase()}`
      : `${displayHour}:${String(rawMinute).padStart(2, '0')} ${meridiem.toUpperCase()}`;
  return { date, label };
}

export function planDailyCommandCenterIntent(
  message: string,
  now = new Date(),
): DailyCommandCenterIntent | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  if (
    /\bwhat'?s next on my calendar\b/.test(normalized) &&
    /\bwhat could i do before then\b/.test(normalized)
  ) {
    return { kind: 'next_and_before_then' };
  }

  if (
    /\bdo i have time to work on this\b/.test(normalized) &&
    /\bbefore my next meeting\b/.test(normalized)
  ) {
    return { kind: 'fit_before_next_meeting' };
  }

  if (
    /\bwhat can i fit\b/.test(normalized) &&
    /\bnext free window\b/.test(normalized)
  ) {
    return { kind: 'fit_next_free_window' };
  }

  if (
    /\bwhat'?s still open\b/.test(normalized) &&
    /\bbefore my day ends\b/.test(normalized)
  ) {
    return { kind: 'open_before_end_of_day' };
  }

  if (
    /\bwhat should i tackle\b/.test(normalized) &&
    /\bbefore my\b/.test(normalized) &&
    /\bmeeting\b/.test(normalized)
  ) {
    const anchorTime = parseClockTimeToDate(normalized, now);
    return {
      kind: 'fit_before_anchor',
      anchorTimeLabel: anchorTime?.label || null,
      anchorDate: anchorTime?.date || null,
    };
  }

  if (
    normalized === GIVE_ME_MY_DAY_QUERY.toLowerCase() ||
    normalized === 'what should i know about today?' ||
    normalized === "what's my day look like today?" ||
    normalized === 'whats my day look like today?'
  ) {
    return { kind: 'day_overview' };
  }

  if (
    normalized === "what's coming up and what's still open?" ||
    normalized === "whats coming up and what's still open?" ||
    normalized === "what's coming up and whats still open?" ||
    normalized === 'whats coming up and whats still open?'
  ) {
    return { kind: 'coming_up_open' };
  }

  if (
    normalized === 'what do i need to know right now?' ||
    normalized === 'what do i need to know right now'
  ) {
    return { kind: 'right_now' };
  }

  if (
    normalized === "what's my current focus?" ||
    normalized === 'whats my current focus?'
  ) {
    return { kind: 'current_focus' };
  }

  if (
    normalized === 'what should i focus on today?' ||
    normalized === 'what should i do now?' ||
    normalized === 'what should i tackle next?' ||
    normalized === 'what should i focus on today' ||
    normalized === 'what should i do now' ||
    normalized === 'what should i tackle next'
  ) {
    return { kind: 'focus_now' };
  }

  if (
    normalized === "what's next for me today?" ||
    normalized === 'whats next for me today?'
  ) {
    return { kind: 'next_for_today' };
  }

  return null;
}

export function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatWindow(
  window: CalendarTimeWindow,
  timeZone: string,
): string {
  return `${formatClock(window.start, timeZone)}-${formatClock(window.end, timeZone)}`;
}

function maybeCalendarSuffix(event: CalendarEvent): string {
  if (!event.calendarName) return '';
  if (event.calendarName.includes('@')) return '';
  if (/^primary$/i.test(event.calendarName)) return '';
  if (/^google calendar$/i.test(event.calendarName)) return '';
  return ` [${event.calendarName}]`;
}

export function formatEventSummary(
  event: CalendarEvent,
  timeZone: string,
): string {
  if (event.allDay) {
    return `All day ${event.title}${maybeCalendarSuffix(event)}`;
  }
  return `${formatClock(new Date(event.startIso), timeZone)}-${formatClock(
    new Date(event.endIso),
    timeZone,
  )} ${event.title}${maybeCalendarSuffix(event)}`;
}

function parseReminderLabel(prompt: string): string {
  const eventMatch = prompt.match(
    /^Send a concise reminder that "(.+?)" is scheduled for /i,
  );
  if (eventMatch) {
    return eventMatch[1]!;
  }

  const plainMatch = prompt.match(
    /^Send a concise reminder telling the user to (.+?)\.?$/i,
  );
  if (plainMatch) {
    return plainMatch[1]!;
  }

  return 'upcoming reminder';
}

export function getUpcomingReminders(
  tasks: ScheduledTask[],
  now: Date,
): UpcomingReminderSummary[] {
  return tasks
    .filter((task) => {
      if (task.status !== 'active') return false;
      if (task.schedule_type !== 'once') return false;
      if (!task.next_run) return false;
      return /^Send a concise reminder /i.test(task.prompt || '');
    })
    .map((task) => ({
      id: task.id,
      label: parseReminderLabel(task.prompt || ''),
      nextRunIso: task.next_run!,
    }))
    .filter((task) => Number.isFinite(Date.parse(task.nextRunIso)))
    .filter((task) => new Date(task.nextRunIso).getTime() >= now.getTime())
    .sort(
      (left, right) =>
        new Date(left.nextRunIso).getTime() -
        new Date(right.nextRunIso).getTime(),
    );
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
}

export function endOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next;
}

export function summarizeDuration(minutes: number): string {
  if (minutes < 60) {
    return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (remainder === 0) {
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `about ${hours} hour${hours === 1 ? '' : 's'} ${remainder} minute${
    remainder === 1 ? '' : 's'
  }`;
}

export function describeWindowCapacity(minutes: number): string {
  const duration = summarizeDuration(minutes);
  if (minutes < 20) {
    return `${duration}, so this is only enough for a quick check.`;
  }
  if (minutes < 60) {
    return `${duration}, so this is enough for a short focused block.`;
  }
  return `${duration}, so this is a meaningful work block.`;
}

export function describeWindowForSelectedWork(
  minutes: number,
  selectedWork: SelectedWorkContext,
): string {
  const duration = summarizeDuration(minutes);
  if (minutes < 20) {
    return `${duration}, so this is only enough for a quick check on ${selectedWork.title}.`;
  }
  if (minutes < 60) {
    return `${duration}, so you could get a short focused block on ${selectedWork.title}.`;
  }
  return `${duration}, so you could make meaningful progress on ${selectedWork.title}.`;
}

export function filterMeaningfulOpenWindows(
  windows: CalendarTimeWindow[],
  minimumMinutes = MIN_MEANINGFUL_WINDOW_MINUTES,
): CalendarTimeWindow[] {
  return windows.filter(
    (window) => minutesBetween(window.start, window.end) >= minimumMinutes,
  );
}

function pushLine(lines: string[], line: string | null | undefined): void {
  if (!line) return;
  if (lines.includes(line)) return;
  if (lines.length >= 4) return;
  lines.push(line);
}

async function loadCalendarSnapshot(
  query: string,
  deps: DailyCommandCenterDeps,
): Promise<CalendarLookupSnapshot & { planLabel: string }> {
  const plan = planCalendarAssistantLookup(
    query,
    deps.now || new Date(),
    deps.timeZone || TIMEZONE,
    deps.activeEventContext || null,
  );
  if (!plan || plan.clarificationQuestion) {
    throw new Error(`Unable to plan calendar snapshot for "${query}".`);
  }

  const result = await lookupCalendarAssistantEvents(plan, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
    platform: deps.platform,
    runAppleCalendarScript: deps.runAppleCalendarScript,
    activeEventContext: deps.activeEventContext || null,
  });

  return {
    ...buildCalendarLookupSnapshot(result),
    planLabel: result.plan.label,
  };
}

export function buildCurrentFocusSnapshot(params: {
  now: Date;
  nextReminder: UpcomingReminderSummary | null;
  nextEvent: CalendarEvent | null;
  nextMeaningfulOpenWindow: CalendarTimeWindow | null;
  selectedWork: SelectedWorkContext | null;
}): CurrentFocusSnapshot {
  const nextReminderMinutes = params.nextReminder
    ? minutesBetween(params.now, new Date(params.nextReminder.nextRunIso))
    : null;
  const nextEventMinutes = params.nextEvent
    ? minutesBetween(params.now, new Date(params.nextEvent.startIso))
    : null;

  let reason: CurrentFocusReason = 'schedule_only';
  if (nextReminderMinutes !== null && nextReminderMinutes <= 15) {
    reason = 'reminder_due_soon';
  } else if (nextEventMinutes !== null && nextEventMinutes <= 20) {
    reason = 'meeting_soon';
  } else if (
    params.selectedWork &&
    params.nextMeaningfulOpenWindow &&
    minutesBetween(
      params.nextMeaningfulOpenWindow.start,
      params.nextMeaningfulOpenWindow.end,
    ) >= MIN_MEANINGFUL_WINDOW_MINUTES
  ) {
    reason = 'selected_work';
  }

  return {
    reason,
    selectedWork: params.selectedWork,
    nextEvent: params.nextEvent,
    nextReminder: params.nextReminder,
    nextMeaningfulOpenWindow: params.nextMeaningfulOpenWindow,
  };
}

export async function buildGroundedDaySnapshot(
  deps: DailyCommandCenterDeps = {},
): Promise<GroundedDaySnapshot> {
  const now = deps.now || new Date();
  const timeZone = deps.timeZone || TIMEZONE;
  const calendar = await loadCalendarSnapshot(REST_OF_TODAY_QUERY, {
    ...deps,
    now,
    timeZone,
  });
  const reminders = getUpcomingReminders(deps.tasks || [], now);
  const todayReminders = reminders.filter(
    (reminder) =>
      new Date(reminder.nextRunIso).getTime() < endOfLocalDay(now).getTime(),
  );
  const meaningfulOpenWindows = filterMeaningfulOpenWindows(
    calendar.openWindows,
  );
  const currentFocus = buildCurrentFocusSnapshot({
    now,
    nextReminder: reminders[0] || null,
    nextEvent: calendar.nextTimedEvent,
    nextMeaningfulOpenWindow: meaningfulOpenWindows[0] || null,
    selectedWork: deps.selectedWork || null,
  });

  return {
    now,
    timeZone,
    calendar,
    selectedWork: deps.selectedWork || null,
    reminders,
    todayReminders,
    meaningfulOpenWindows,
    currentFocus,
  };
}

function formatReminderLine(
  reminder: UpcomingReminderSummary,
  timeZone: string,
): string {
  return `Reminder: ${formatClock(new Date(reminder.nextRunIso), timeZone)} ${reminder.label}`;
}

function formatNextEventLine(event: CalendarEvent, timeZone: string): string {
  return `Next: ${formatEventSummary(event, timeZone)}`;
}

function formatOpenWindowLine(
  window: CalendarTimeWindow,
  timeZone: string,
): string {
  return `Open: ${formatWindow(window, timeZone)}`;
}

function formatFocusLine(selectedWork: SelectedWorkContext): string {
  return `Focus: ${selectedWork.title} (${selectedWork.laneLabel})`;
}

function formatWorkLine(selectedWork: SelectedWorkContext): string {
  return `Work: ${selectedWork.title} (${selectedWork.statusLabel})`;
}

function buildDayOverviewReply(params: {
  snapshot: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  reminders: UpcomingReminderSummary[];
  currentFocus: CurrentFocusSnapshot;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    const lines = [
      'I can still see your reminders and current work context, but I could not ground this in calendar data right now.',
    ];
    pushLine(
      lines,
      params.reminders[0]
        ? formatReminderLine(params.reminders[0], params.timeZone)
        : null,
    );
    pushLine(
      lines,
      params.selectedWork ? formatWorkLine(params.selectedWork) : null,
    );
    return lines.join('\n');
  }

  const nextReminder = params.reminders[0] || null;
  const nextEvent = params.snapshot.nextTimedEvent;
  const nextOpen = filterMeaningfulOpenWindows(params.snapshot.openWindows)[0];

  let summary = 'Nothing urgent is crowding the calendar right now.';
  if (params.currentFocus.reason === 'reminder_due_soon' && nextReminder) {
    summary = `The next thing that needs attention is your reminder at ${formatClock(
      new Date(nextReminder.nextRunIso),
      params.timeZone,
    )}.`;
  } else if (params.currentFocus.reason === 'meeting_soon' && nextEvent) {
    summary = `Your next real time pressure is ${nextEvent.title} at ${formatClock(
      new Date(nextEvent.startIso),
      params.timeZone,
    )}.`;
  } else if (
    params.currentFocus.reason === 'selected_work' &&
    params.selectedWork &&
    nextOpen
  ) {
    summary = `You have a usable work block right now for ${params.selectedWork.title}.`;
  } else if (nextEvent) {
    summary = `Your next calendar anchor is ${nextEvent.title} at ${formatClock(
      new Date(nextEvent.startIso),
      params.timeZone,
    )}.`;
  } else if (nextOpen) {
    summary = 'Your calendar looks fairly open right now.';
  }

  const lines = [summary];
  pushLine(
    lines,
    nextEvent ? formatNextEventLine(nextEvent, params.timeZone) : null,
  );
  pushLine(
    lines,
    nextReminder ? formatReminderLine(nextReminder, params.timeZone) : null,
  );
  pushLine(
    lines,
    nextOpen ? formatOpenWindowLine(nextOpen, params.timeZone) : null,
  );
  if (params.selectedWork && params.currentFocus.reason === 'selected_work') {
    pushLine(lines, formatFocusLine(params.selectedWork));
  } else if (params.selectedWork && !nextReminder) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }

  if (params.snapshot.activeAllDayEvents.length > 0 && lines.length < 4) {
    pushLine(
      lines,
      `Next: ${formatEventSummary(
        params.snapshot.activeAllDayEvents[0]!,
        params.timeZone,
      )}`,
    );
  }

  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }

  return lines.join('\n');
}

function buildComingUpAndOpenReply(params: {
  snapshot: CalendarLookupSnapshot;
  reminders: UpcomingReminderSummary[];
  selectedWork: SelectedWorkContext | null;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely answer what's still open right now because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const upcomingEvents = params.snapshot.timedEvents.slice(0, 2);
  const windows = filterMeaningfulOpenWindows(
    params.snapshot.openWindows,
  ).slice(0, 2);
  const summary =
    upcomingEvents.length > 0
      ? `You have ${upcomingEvents.length === 1 ? 'one timed event' : `${upcomingEvents.length} timed events`} coming up and ${windows.length === 0 ? 'not much open time' : 'some usable open time'} today.`
      : windows.length > 0
        ? 'There is not much coming up, and you still have open time today.'
        : 'There is not much coming up, but I do not see a meaningful open window left today.';

  const lines = [summary];
  for (const event of upcomingEvents) {
    pushLine(lines, formatNextEventLine(event, params.timeZone));
  }
  for (const window of windows) {
    pushLine(lines, formatOpenWindowLine(window, params.timeZone));
  }
  if (lines.length < 4 && params.reminders[0]) {
    pushLine(lines, formatReminderLine(params.reminders[0], params.timeZone));
  } else if (lines.length < 4 && params.selectedWork) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }

  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildRightNowReply(params: {
  snapshot: CalendarLookupSnapshot;
  currentFocus: CurrentFocusSnapshot;
  timeZone: string;
  now: Date;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't fully ground this in calendar data right now.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const lines: string[] = [];
  if (
    params.currentFocus.reason === 'reminder_due_soon' &&
    params.currentFocus.nextReminder
  ) {
    lines.push(
      `The next thing that needs attention is your reminder at ${formatClock(
        new Date(params.currentFocus.nextReminder.nextRunIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatReminderLine(params.currentFocus.nextReminder, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'meeting_soon' &&
    params.currentFocus.nextEvent
  ) {
    lines.push(
      `You have ${params.currentFocus.nextEvent.title} coming up at ${formatClock(
        new Date(params.currentFocus.nextEvent.startIso),
        params.timeZone,
      )}, so this is more of a prep window.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'selected_work' &&
    params.currentFocus.selectedWork &&
    params.currentFocus.nextMeaningfulOpenWindow
  ) {
    const window = params.currentFocus.nextMeaningfulOpenWindow;
    const minutes = minutesBetween(window.start, window.end);
    lines.push(
      `You have ${summarizeDuration(minutes)} open right now, so resuming ${params.currentFocus.selectedWork.title} looks realistic.`,
    );
    pushLine(lines, formatOpenWindowLine(window, params.timeZone));
    pushLine(lines, formatFocusLine(params.currentFocus.selectedWork));
  } else if (params.currentFocus.nextEvent) {
    lines.push(
      `The next calendar anchor is ${params.currentFocus.nextEvent.title} at ${formatClock(
        new Date(params.currentFocus.nextEvent.startIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
  } else if (params.currentFocus.nextMeaningfulOpenWindow) {
    lines.push('Nothing urgent is on the calendar right now.');
    pushLine(
      lines,
      formatOpenWindowLine(
        params.currentFocus.nextMeaningfulOpenWindow,
        params.timeZone,
      ),
    );
  } else {
    lines.push('Nothing urgent is on the calendar right now.');
  }

  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildCurrentFocusReply(params: {
  currentFocus: CurrentFocusSnapshot;
  snapshot: CalendarLookupSnapshot;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't fully ground your current focus in calendar data right now.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const lines: string[] = [];
  if (
    params.currentFocus.reason === 'reminder_due_soon' &&
    params.currentFocus.nextReminder
  ) {
    lines.push(
      `Your current focus is the reminder at ${formatClock(
        new Date(params.currentFocus.nextReminder.nextRunIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatReminderLine(params.currentFocus.nextReminder, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'meeting_soon' &&
    params.currentFocus.nextEvent
  ) {
    lines.push(
      `Your next meeting is close, so this is mainly transition time before ${params.currentFocus.nextEvent.title}.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'selected_work' &&
    params.currentFocus.selectedWork &&
    params.currentFocus.nextMeaningfulOpenWindow
  ) {
    lines.push(
      `Your best current focus is ${params.currentFocus.selectedWork.title}.`,
    );
    pushLine(
      lines,
      formatOpenWindowLine(
        params.currentFocus.nextMeaningfulOpenWindow,
        params.timeZone,
      ),
    );
    pushLine(lines, formatFocusLine(params.currentFocus.selectedWork));
  } else if (params.currentFocus.nextEvent) {
    lines.push(
      `I don't have a current work focus selected, so the next grounded thing is ${params.currentFocus.nextEvent.title} at ${formatClock(
        new Date(params.currentFocus.nextEvent.startIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
  } else {
    lines.push(
      "I don't have a current work focus selected, so your schedule is the best signal right now.",
    );
    if (params.currentFocus.nextMeaningfulOpenWindow) {
      pushLine(
        lines,
        formatOpenWindowLine(
          params.currentFocus.nextMeaningfulOpenWindow,
          params.timeZone,
        ),
      );
    }
  }

  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildFocusNowReply(params: {
  currentFocus: CurrentFocusSnapshot;
  snapshot: CalendarLookupSnapshot;
  timeZone: string;
  now: Date;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely tell you what to focus on from calendar data right now.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const lines: string[] = [];
  if (
    params.currentFocus.reason === 'meeting_soon' &&
    params.currentFocus.nextEvent
  ) {
    const minutes = minutesBetween(
      params.now,
      new Date(params.currentFocus.nextEvent.startIso),
    );
    lines.push(
      `You have ${summarizeDuration(minutes)} before ${params.currentFocus.nextEvent.title}, so only a quick check or prep block is realistic.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'reminder_due_soon' &&
    params.currentFocus.nextReminder
  ) {
    lines.push(
      `Start with the reminder at ${formatClock(
        new Date(params.currentFocus.nextReminder.nextRunIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatReminderLine(params.currentFocus.nextReminder, params.timeZone),
    );
  } else if (
    params.currentFocus.reason === 'selected_work' &&
    params.currentFocus.selectedWork &&
    params.currentFocus.nextMeaningfulOpenWindow
  ) {
    const minutes = minutesBetween(
      params.currentFocus.nextMeaningfulOpenWindow.start,
      params.currentFocus.nextMeaningfulOpenWindow.end,
    );
    lines.push(
      `Resuming ${params.currentFocus.selectedWork.title} looks like the best grounded next step.`,
    );
    pushLine(
      lines,
      `Open: ${formatWindow(
        params.currentFocus.nextMeaningfulOpenWindow,
        params.timeZone,
      )} (${summarizeDuration(minutes)})`,
    );
    pushLine(lines, formatFocusLine(params.currentFocus.selectedWork));
  } else if (params.currentFocus.nextEvent) {
    lines.push(
      `I don't have a current work task selected, so the next grounded thing is ${params.currentFocus.nextEvent.title} at ${formatClock(
        new Date(params.currentFocus.nextEvent.startIso),
        params.timeZone,
      )}.`,
    );
    pushLine(
      lines,
      formatNextEventLine(params.currentFocus.nextEvent, params.timeZone),
    );
    if (params.currentFocus.nextMeaningfulOpenWindow) {
      pushLine(
        lines,
        formatOpenWindowLine(
          params.currentFocus.nextMeaningfulOpenWindow,
          params.timeZone,
        ),
      );
    }
  } else if (params.currentFocus.nextMeaningfulOpenWindow) {
    const minutes = minutesBetween(
      params.currentFocus.nextMeaningfulOpenWindow.start,
      params.currentFocus.nextMeaningfulOpenWindow.end,
    );
    lines.push(
      `I don't have a current work task selected, but you do have ${summarizeDuration(minutes)} open right now.`,
    );
    pushLine(
      lines,
      formatOpenWindowLine(
        params.currentFocus.nextMeaningfulOpenWindow,
        params.timeZone,
      ),
    );
  } else {
    lines.push(
      "I don't have enough work context to rank what matters next, and I don't see a meaningful free block right now.",
    );
  }

  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildNextForTodayReply(params: {
  snapshot: CalendarLookupSnapshot;
  currentFocus: CurrentFocusSnapshot;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely answer what's next for today because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  if (params.snapshot.nextTimedEvent) {
    const lines = [
      `Next for today is ${params.snapshot.nextTimedEvent.title} at ${formatClock(
        new Date(params.snapshot.nextTimedEvent.startIso),
        params.timeZone,
      )}.`,
      formatNextEventLine(params.snapshot.nextTimedEvent, params.timeZone),
    ];
    if (params.currentFocus.nextMeaningfulOpenWindow) {
      pushLine(
        lines,
        formatOpenWindowLine(
          params.currentFocus.nextMeaningfulOpenWindow,
          params.timeZone,
        ),
      );
    }
    if (params.snapshot.incompleteNoteBody) {
      lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
    }
    return lines.join('\n');
  }

  if (params.currentFocus.nextMeaningfulOpenWindow) {
    const lines = [
      'There is no later meeting on the calendar right now, so your next meaningful thing is the open block you have left today.',
      formatOpenWindowLine(
        params.currentFocus.nextMeaningfulOpenWindow,
        params.timeZone,
      ),
    ];
    if (params.snapshot.incompleteNoteBody) {
      lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
    }
    return lines.join('\n');
  }

  return params.snapshot.incompleteNoteBody
    ? `I don't see anything else scheduled today in the calendars I could read.\nCalendar: ${params.snapshot.incompleteNoteBody}`
    : "I don't see anything else scheduled today.";
}

function buildFitBeforeNextMeetingReply(params: {
  snapshot: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  timeZone: string;
  now: Date;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely size that window because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const nextEvent = params.snapshot.nextTimedEvent;
  if (!nextEvent) {
    if (params.snapshot.fullyConfirmed) {
      return params.selectedWork
        ? `I don't see another meeting today, so you have the rest of the day for ${params.selectedWork.title}.`
        : "I don't see another meeting today, but I also don't have a current work item selected.";
    }
    return `I don't see another meeting in the calendars I could read, but I couldn't confirm every configured calendar.\nCalendar: ${params.snapshot.incompleteNoteBody}`;
  }

  const minutes = minutesBetween(params.now, new Date(nextEvent.startIso));
  const lines = [
    params.selectedWork
      ? `Before ${nextEvent.title}, you have ${describeWindowForSelectedWork(
          minutes,
          params.selectedWork,
        )}`
      : `Before ${nextEvent.title}, you have ${describeWindowCapacity(
          minutes,
        )} I don't have a current work item selected, though.`,
    formatNextEventLine(nextEvent, params.timeZone),
  ];
  if (params.selectedWork) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }
  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildFitNextFreeWindowReply(params: {
  snapshot: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely size your next free window because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const nextWindow = filterMeaningfulOpenWindows(
    params.snapshot.openWindows,
  )[0];
  if (!nextWindow) {
    return params.snapshot.incompleteNoteBody
      ? `I don't see a meaningful free window left today in the calendars I could read.\nCalendar: ${params.snapshot.incompleteNoteBody}`
      : "I don't see a meaningful free window left today.";
  }

  const minutes = minutesBetween(nextWindow.start, nextWindow.end);
  const lines = [
    params.selectedWork
      ? `Your next free window is ${formatWindow(
          nextWindow,
          params.timeZone,
        )}. ${describeWindowForSelectedWork(minutes, params.selectedWork)}`
      : `Your next free window is ${formatWindow(
          nextWindow,
          params.timeZone,
        )}. ${describeWindowCapacity(minutes)} I don't have a current work item selected, though.`,
    formatOpenWindowLine(nextWindow, params.timeZone),
  ];
  if (params.selectedWork) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }
  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildOpenBeforeDayEndsReply(params: {
  snapshot: CalendarLookupSnapshot;
  timeZone: string;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely tell you what's still open because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const windows = filterMeaningfulOpenWindows(
    params.snapshot.openWindows,
  ).slice(0, 3);
  if (windows.length === 0) {
    return params.snapshot.incompleteNoteBody
      ? `I don't see a meaningful open block before the day ends in the calendars I could read.\nCalendar: ${params.snapshot.incompleteNoteBody}`
      : "I don't see a meaningful open block before the day ends.";
  }

  const lines = [
    `You still have ${windows.length === 1 ? 'one meaningful open block' : `${windows.length} meaningful open blocks`} before the day ends.`,
  ];
  for (const window of windows) {
    pushLine(lines, formatOpenWindowLine(window, params.timeZone));
  }
  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function findAnchorEvent(
  snapshot: CalendarLookupSnapshot,
  anchorDate: Date,
): { kind: 'ok'; event: CalendarEvent } | { kind: 'none' } | { kind: 'many' } {
  const point = anchorDate.getTime();
  const matches = snapshot.timedEvents.filter((event) => {
    const start = new Date(event.startIso).getTime();
    const end = new Date(event.endIso).getTime();
    return start <= point && end > point;
  });

  if (matches.length === 0) {
    return { kind: 'none' };
  }
  if (matches.length > 1) {
    return { kind: 'many' };
  }
  return { kind: 'ok', event: matches[0]! };
}

function buildFitBeforeAnchorReply(params: {
  snapshot: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  anchorDate: Date | null | undefined;
  anchorTimeLabel: string | null | undefined;
  timeZone: string;
  now: Date;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely size that window because calendar data is unavailable.\nCalendar: ${params.snapshot.unavailableReply}`;
  }
  if (!params.anchorDate || !params.anchorTimeLabel) {
    return 'Tell me the meeting time so I can size that window.';
  }

  const anchorResult = findAnchorEvent(params.snapshot, params.anchorDate);
  if (anchorResult.kind === 'none') {
    return `I couldn't find a ${params.anchorTimeLabel} meeting on your calendar today.`;
  }
  if (anchorResult.kind === 'many') {
    return `I found more than one event around ${params.anchorTimeLabel}. Tell me which one you mean.`;
  }

  const minutes = minutesBetween(
    params.now,
    new Date(anchorResult.event.startIso),
  );
  const lines = [
    params.selectedWork
      ? `Before ${anchorResult.event.title}, you have ${describeWindowForSelectedWork(
          minutes,
          params.selectedWork,
        )}`
      : `Before ${anchorResult.event.title}, you have ${describeWindowCapacity(
          minutes,
        )} I don't have a current work item selected, though.`,
    formatNextEventLine(anchorResult.event, params.timeZone),
  ];
  if (params.selectedWork) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }
  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

function buildNextAndBeforeThenReply(params: {
  snapshot: CalendarLookupSnapshot;
  selectedWork: SelectedWorkContext | null;
  timeZone: string;
  now: Date;
}): string {
  if (params.snapshot.unavailableReply) {
    return `I can't safely combine your next event with a work window right now.\nCalendar: ${params.snapshot.unavailableReply}`;
  }

  const nextEvent = params.snapshot.nextTimedEvent;
  if (!nextEvent) {
    const nextWindow = filterMeaningfulOpenWindows(
      params.snapshot.openWindows,
    )[0];
    if (!nextWindow) {
      return params.snapshot.incompleteNoteBody
        ? `I don't see another event or a meaningful open block today in the calendars I could read.\nCalendar: ${params.snapshot.incompleteNoteBody}`
        : "I don't see another event or a meaningful open block today.";
    }
    const minutes = minutesBetween(nextWindow.start, nextWindow.end);
    return params.selectedWork
      ? `There isn't another calendar event yet, and your next open block is ${formatWindow(
          nextWindow,
          params.timeZone,
        )}. ${describeWindowForSelectedWork(minutes, params.selectedWork)}`
      : `There isn't another calendar event yet, and your next open block is ${formatWindow(
          nextWindow,
          params.timeZone,
        )}. ${describeWindowCapacity(minutes)} I don't have a current work item selected, though.`;
  }

  const minutes = minutesBetween(params.now, new Date(nextEvent.startIso));
  const lines = [
    `Next on your calendar is ${nextEvent.title} at ${formatClock(
      new Date(nextEvent.startIso),
      params.timeZone,
    )}.`,
    params.selectedWork
      ? `Before then, you have ${describeWindowForSelectedWork(
          minutes,
          params.selectedWork,
        )}`
      : `Before then, you have ${describeWindowCapacity(
          minutes,
        )} I don't have a current work item selected, though.`,
    formatNextEventLine(nextEvent, params.timeZone),
  ];
  if (params.selectedWork) {
    pushLine(lines, formatWorkLine(params.selectedWork));
  }
  if (params.snapshot.incompleteNoteBody) {
    lines.push(`Calendar: ${params.snapshot.incompleteNoteBody}`);
  }
  return lines.join('\n');
}

export async function buildDailyCommandCenterResponse(
  message: string,
  deps: DailyCommandCenterDeps = {},
): Promise<DailyCommandCenterResponse | null> {
  const now = deps.now || new Date();
  const intent = planDailyCommandCenterIntent(message, now);
  if (!intent) {
    return null;
  }

  const grounded = await buildGroundedDaySnapshot(deps);
  const {
    timeZone,
    calendar: snapshot,
    todayReminders,
    currentFocus,
    selectedWork,
  } = grounded;

  let reply: string;
  switch (intent.kind) {
    case 'day_overview':
      reply = buildDayOverviewReply({
        snapshot,
        selectedWork,
        reminders: todayReminders,
        currentFocus,
        timeZone,
      });
      break;
    case 'coming_up_open':
      reply = buildComingUpAndOpenReply({
        snapshot,
        reminders: todayReminders,
        selectedWork,
        timeZone,
      });
      break;
    case 'right_now':
      reply = buildRightNowReply({ snapshot, currentFocus, timeZone, now });
      break;
    case 'current_focus':
      reply = buildCurrentFocusReply({ currentFocus, snapshot, timeZone });
      break;
    case 'focus_now':
      reply = buildFocusNowReply({ currentFocus, snapshot, timeZone, now });
      break;
    case 'next_for_today':
      reply = buildNextForTodayReply({ snapshot, currentFocus, timeZone });
      break;
    case 'fit_before_next_meeting':
      reply = buildFitBeforeNextMeetingReply({
        snapshot,
        selectedWork,
        timeZone,
        now,
      });
      break;
    case 'fit_next_free_window':
      reply = buildFitNextFreeWindowReply({
        snapshot,
        selectedWork,
        timeZone,
      });
      break;
    case 'open_before_end_of_day':
      reply = buildOpenBeforeDayEndsReply({ snapshot, timeZone });
      break;
    case 'fit_before_anchor':
      reply = buildFitBeforeAnchorReply({
        snapshot,
        selectedWork,
        anchorDate: intent.anchorDate,
        anchorTimeLabel: intent.anchorTimeLabel,
        timeZone,
        now,
      });
      break;
    case 'next_and_before_then':
      reply = buildNextAndBeforeThenReply({
        snapshot,
        selectedWork,
        timeZone,
        now,
      });
      break;
    default:
      return null;
  }

  return {
    reply,
    activeEventContext: null,
    currentFocus,
    grounded,
  };
}
