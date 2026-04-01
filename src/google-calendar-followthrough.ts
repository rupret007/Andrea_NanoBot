import { TIMEZONE } from './config.js';
import type {
  GoogleCalendarDraftConflictSummary,
  GoogleCalendarSlotSuggestion,
} from './google-calendar-create.js';
import type {
  GoogleCalendarEventRecord,
  GoogleCalendarMetadata,
} from './google-calendar.js';
import type { ScheduledTask } from './types.js';

const DEFAULT_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;
const CONFIRM_PATTERN =
  /^(?:yes|yep|yeah|confirm|go ahead|looks good|ok|okay|delete it|move it|update it|save it)\b/i;

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DAYPART_RANGES = {
  morning: { startHour: 6, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 21 },
  tonight: { startHour: 18, endHour: 24 },
} as const;

export interface GoogleCalendarTrackedEvent {
  id: string;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  calendarId: string;
  calendarName: string;
  htmlLink?: string | null;
}

export interface ActiveGoogleCalendarEventContextState {
  version: 1;
  createdAt: string;
  event: GoogleCalendarTrackedEvent;
}

interface ReminderScopeFilter {
  kind: 'family_shared';
  label: string;
  terms: string[];
}

type ReminderSelectorMode =
  | 'named'
  | 'next_timed'
  | 'first_timed_in_window'
  | 'single_in_window'
  | 'all_timed_in_window';

interface ReminderOffset {
  kind:
    | 'minutes_before'
    | 'hours_before'
    | 'night_before'
    | 'unspecified_before';
  minutes: number | null;
  label: string;
}

export interface PendingCalendarReminderState {
  version: 2;
  createdAt: string;
  step: 'clarify_event' | 'clarify_offset' | 'clarify_time' | 'confirm';
  offset: ReminderOffset;
  targetLabel: string;
  targetEvent: GoogleCalendarTrackedEvent | null;
  targetEvents: GoogleCalendarTrackedEvent[];
  candidates: GoogleCalendarTrackedEvent[];
  remindAtIso: string | null;
  remindAtByEventId: Record<string, string> | null;
  incompleteNote: string | null;
}

export interface PendingGoogleCalendarEventActionState {
  version: 1;
  createdAt: string;
  step: 'clarify_event' | 'choose_calendar' | 'confirm';
  action: 'move' | 'resize' | 'reassign' | 'delete';
  sourceEvent: GoogleCalendarTrackedEvent;
  proposedEvent: GoogleCalendarTrackedEvent | null;
  calendars: Array<{
    id: string;
    summary: string;
    primary: boolean;
  }>;
  selectedCalendarId: string | null;
  conflictSummary: GoogleCalendarDraftConflictSummary | null;
  candidates: GoogleCalendarTrackedEvent[];
}

export type CalendarEventReminderPlanResult =
  | { kind: 'none' }
  | { kind: 'needs_event_context'; message: string }
  | {
      kind: 'lookup';
      offset: ReminderOffset;
      targetLabel: string;
      queryText: string | null;
      searchStart: Date;
      searchEnd: Date;
      selectorMode: ReminderSelectorMode;
      scopeFilter: ReminderScopeFilter | null;
    }
  | {
      kind: 'awaiting_input';
      state: PendingCalendarReminderState;
      message: string;
    };

export type PendingCalendarReminderResult =
  | { kind: 'no_match' }
  | { kind: 'cancelled'; message: string }
  | { kind: 'invalid'; message: string; state: PendingCalendarReminderState }
  | {
      kind: 'awaiting_input';
      state: PendingCalendarReminderState;
      message: string;
    }
  | { kind: 'confirmed'; state: PendingCalendarReminderState };

export type GoogleCalendarEventActionPlanResult =
  | { kind: 'none' }
  | { kind: 'needs_event_context'; message: string }
  | {
      kind: 'awaiting_input';
      state: PendingGoogleCalendarEventActionState;
      message: string;
    }
  | {
      kind: 'resolve_anchor';
      state: PendingGoogleCalendarEventActionState;
      anchorTime: { hours: number; minutes: number; displayLabel: string };
      anchorDate: Date;
    };

export type PendingGoogleCalendarEventActionResult =
  | { kind: 'no_match' }
  | { kind: 'cancelled'; message: string }
  | {
      kind: 'awaiting_input';
      state: PendingGoogleCalendarEventActionState;
      message: string;
    }
  | {
      kind: 'resolve_anchor';
      state: PendingGoogleCalendarEventActionState;
      anchorTime: { hours: number; minutes: number; displayLabel: string };
      anchorDate: Date;
    }
  | { kind: 'confirmed'; state: PendingGoogleCalendarEventActionState };

export interface EventReminderTaskPlan {
  confirmation: string;
  tasks?: Array<Omit<ScheduledTask, 'last_run' | 'last_result'>>;
  task?: Omit<ScheduledTask, 'last_run' | 'last_result'>;
}

function normalizeMessage(message: string): string {
  return message
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .replace(
      /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|please)[,!. ]+)*(?:andrea[,!. ]+)?/i,
      '',
    )
    .trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toLocalTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, count: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + count);
  return next;
}

function setLocalTime(
  date: Date,
  hours: number,
  minutes = 0,
  seconds = 0,
): Date {
  const next = new Date(date);
  next.setHours(hours, minutes, seconds, 0);
  return next;
}

function formatClockLabel(hours: number, minutes: number): string {
  const displayHour = hours % 12 || 12;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return minutes === 0
    ? `${displayHour} ${suffix}`
    : `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function inferClockHourWithoutMeridiem(rawHour: number): number | null {
  if (rawHour < 0 || rawHour > 23) return null;
  if (rawHour >= 13) return rawHour;
  if (rawHour === 12) return 12;
  if (rawHour >= 1 && rawHour <= 7) return rawHour + 12;
  return rawHour;
}

function parseLooseClockTime(
  hoursText: string,
  minutesText?: string,
  meridiem?: string,
): { hours: number; minutes: number; displayLabel: string } | null {
  const rawHour = Number(hoursText);
  const minutes = minutesText ? Number(minutesText) : 0;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  let hours: number | null = null;
  if (meridiem) {
    const lowerMeridiem = meridiem.toLowerCase();
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) {
      return null;
    }
    hours =
      rawHour === 12
        ? lowerMeridiem === 'am'
          ? 0
          : 12
        : lowerMeridiem === 'pm'
          ? rawHour + 12
          : rawHour;
  } else {
    hours = inferClockHourWithoutMeridiem(rawHour);
  }

  if (hours === null) {
    return null;
  }

  return {
    hours,
    minutes,
    displayLabel: formatClockLabel(hours, minutes),
  };
}

function formatEventWhen(
  event: Pick<GoogleCalendarTrackedEvent, 'startIso' | 'endIso' | 'allDay'>,
  timeZone = TIMEZONE,
): string {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (event.allDay) {
    return `All day on ${dateFormatter.format(new Date(event.startIso))}`;
  }
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dateFormatter.format(new Date(event.startIso))}, ${timeFormatter.format(
    new Date(event.startIso),
  )}-${timeFormatter.format(new Date(event.endIso))}`;
}

function formatEventChoice(
  event: GoogleCalendarTrackedEvent,
  index: number,
  timeZone = TIMEZONE,
): string {
  return `${index}. ${event.title} (${formatEventWhen(event, timeZone)})`;
}

function formatReminderOffsetMinutes(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour before' : `${hours} hours before`;
  }
  return minutes === 1 ? '1 minute before' : `${minutes} minutes before`;
}

function stripTargetPunctuation(value: string): string {
  return collapseWhitespace(value.replace(/[.?!]+$/g, ''));
}

function normalizeEventQuery(value: string): string {
  return collapseWhitespace(
    value
      .toLowerCase()
      .replace(
        /\b(?:my|the|that|this|an|a|on|for|at|to|calendar|event|meeting|appointment)\b/g,
        ' ',
      )
      .replace(/\b(?:today|tomorrow|tonight)\b/g, ' ')
      .replace(
        /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g,
        ' ',
      ),
  );
}

function detectReminderScopeFilter(
  normalized: string,
): ReminderScopeFilter | null {
  if (/\bfamily calendar\b/.test(normalized)) {
    return {
      kind: 'family_shared',
      label: 'the family calendar',
      terms: ['family'],
    };
  }
  return null;
}

function eventMatchesReminderScope(
  event: GoogleCalendarTrackedEvent,
  scopeFilter: ReminderScopeFilter | null,
): boolean {
  if (!scopeFilter) {
    return true;
  }
  const haystack = `${event.calendarName} ${event.calendarId}`.toLowerCase();
  return scopeFilter.terms.some((term) => haystack.includes(term));
}

function stripReminderScopePhrases(value: string): string {
  return collapseWhitespace(
    value.replace(/\b(?:the\s+)?family calendar(?: event)?\b/gi, ' '),
  );
}

function extractDateWindow(
  text: string,
  now = new Date(),
): {
  searchStart: Date;
  searchEnd: Date;
  targetText: string;
} {
  const normalized = collapseWhitespace(text);
  const lower = normalized.toLowerCase();
  let searchStart: Date | null = null;
  let searchEnd: Date | null = null;
  let targetText = normalized;

  if (/\btomorrow\b/.test(lower)) {
    searchStart = addDays(startOfDay(now), 1);
    searchEnd = addDays(searchStart, 1);
    targetText = collapseWhitespace(targetText.replace(/\btomorrow\b/i, ''));
  } else if (/\btoday\b/.test(lower)) {
    searchStart = startOfDay(now);
    searchEnd = addDays(searchStart, 1);
    targetText = collapseWhitespace(targetText.replace(/\btoday\b/i, ''));
  } else {
    const weekdayMatch = normalized.match(
      /\b(?:(next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
    );
    if (weekdayMatch) {
      const base = startOfDay(now);
      const weekdayName = weekdayMatch[2].toLowerCase();
      let offset = (WEEKDAY_INDEX[weekdayName] - base.getDay() + 7) % 7;
      if (offset === 0) {
        offset = 7;
      }
      searchStart = addDays(base, offset);
      searchEnd = addDays(searchStart, 1);
      targetText = collapseWhitespace(targetText.replace(weekdayMatch[0], ''));
    }
  }

  const daypartMatch = targetText.match(
    /\b(morning|afternoon|evening|tonight)\b/i,
  );
  if (daypartMatch && searchStart && searchEnd) {
    const daypart =
      daypartMatch[1].toLowerCase() as keyof typeof DAYPART_RANGES;
    const range = DAYPART_RANGES[daypart];
    const baseDay = startOfDay(searchStart);
    searchStart = setLocalTime(baseDay, range.startHour);
    searchEnd =
      range.endHour === 24
        ? addDays(baseDay, 1)
        : setLocalTime(baseDay, range.endHour);
    targetText = collapseWhitespace(targetText.replace(daypartMatch[0], ''));
  }

  return {
    searchStart: searchStart || now,
    searchEnd: searchEnd || new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    targetText: targetText || normalized,
  };
}

function eventTitleMatchesQuery(
  event: GoogleCalendarTrackedEvent,
  queryText: string,
): boolean {
  const normalizedEvent = normalizeEventQuery(event.title);
  const normalizedQuery = normalizeEventQuery(queryText);
  if (!normalizedQuery) {
    return false;
  }

  if (
    normalizedEvent === normalizedQuery ||
    normalizedEvent.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedEvent)
  ) {
    return true;
  }

  const queryTokens = normalizedQuery.split(' ').filter(Boolean);
  return queryTokens.length > 0
    ? queryTokens.every((token) => normalizedEvent.includes(token))
    : false;
}

function isPronounEventReference(text: string): boolean {
  return /\b(?:that|it)\s+(?:meeting|event|appointment)\b/i.test(text);
}

function getEventDurationMinutes(event: GoogleCalendarTrackedEvent): number {
  if (event.allDay) {
    return 24 * 60;
  }
  return Math.max(
    15,
    Math.round(
      (new Date(event.endIso).getTime() - new Date(event.startIso).getTime()) /
        (60 * 1000),
    ),
  );
}

function cloneEventWithTiming(
  event: GoogleCalendarTrackedEvent,
  start: Date,
  end: Date,
  allDay = event.allDay,
): GoogleCalendarTrackedEvent {
  return {
    ...event,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    allDay,
  };
}

function parseDaypartPhrase(working: string): {
  name: keyof typeof DAYPART_RANGES;
  matchedText: string;
} | null {
  for (const daypart of Object.keys(DAYPART_RANGES) as Array<
    keyof typeof DAYPART_RANGES
  >) {
    const match = working.match(new RegExp(`\\b${daypart}\\b`, 'i'));
    if (match) {
      return {
        name: daypart,
        matchedText: match[0],
      };
    }
  }
  return null;
}

function parseDatePhrase(
  working: string,
  now: Date,
): { date: Date; matchedText: string } | null {
  const tomorrow = working.match(/\btomorrow\b/i);
  if (tomorrow) {
    return {
      date: addDays(startOfDay(now), 1),
      matchedText: tomorrow[0],
    };
  }

  const today = working.match(/\btoday\b/i);
  if (today) {
    return {
      date: startOfDay(now),
      matchedText: today[0],
    };
  }

  const weekdayMatch = working.match(
    /\b(?:(next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i,
  );
  if (!weekdayMatch) {
    return null;
  }

  const weekday = weekdayMatch[2].toLowerCase();
  const base = startOfDay(now);
  let offset = (WEEKDAY_INDEX[weekday] - base.getDay() + 7) % 7;
  if (offset === 0) {
    offset = 7;
  }
  return {
    date: addDays(base, offset),
    matchedText: weekdayMatch[0],
  };
}

function parseTimeRange(working: string): {
  start: { hours: number; minutes: number; displayLabel: string } | null;
  end: { hours: number; minutes: number; displayLabel: string } | null;
} {
  const explicitRange = working.match(
    /\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|til)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (explicitRange) {
    return {
      start: parseLooseClockTime(
        explicitRange[1],
        explicitRange[2],
        explicitRange[3],
      ),
      end: parseLooseClockTime(
        explicitRange[4],
        explicitRange[5],
        explicitRange[6] || explicitRange[3],
      ),
    };
  }

  const startOnly = working.match(
    /\b(?:at|to)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (!startOnly) {
    return { start: null, end: null };
  }

  return {
    start: parseLooseClockTime(startOnly[1], startOnly[2], startOnly[3]),
    end: null,
  };
}

function parseReminderOffset(message: string): {
  offset: ReminderOffset;
  targetText: string;
} | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  const nightBefore = normalized.match(
    /^remind me\s+the night before\s+(.+)$/i,
  );
  if (nightBefore) {
    return {
      offset: {
        kind: 'night_before',
        minutes: null,
        label: 'the night before',
      },
      targetText: stripTargetPunctuation(nightBefore[1]),
    };
  }

  const minuteMatch = normalized.match(
    /^remind me\s+(\d{1,3})\s*(minutes?|mins?)\s+before\s+(.+)$/i,
  );
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    if (minutes > 0) {
      return {
        offset: {
          kind: 'minutes_before',
          minutes,
          label: formatReminderOffsetMinutes(minutes),
        },
        targetText: stripTargetPunctuation(minuteMatch[3]),
      };
    }
  }

  const hourMatch = normalized.match(
    /^remind me\s+(?:(an?|one)|(\d{1,3}))\s*(hours?|hrs?)\s+before\s+(.+)$/i,
  );
  if (hourMatch) {
    const hours = hourMatch[1] ? 1 : Number(hourMatch[2]);
    if (!Number.isInteger(hours) || hours <= 0) {
      return null;
    }

    return {
      offset: {
        kind: 'hours_before',
        minutes: hours * 60,
        label: formatReminderOffsetMinutes(hours * 60),
      },
      targetText: stripTargetPunctuation(hourMatch[4]),
    };
  }

  const beforeMatch = normalized.match(/^remind me\s+before\s+(.+)$/i);
  if (!beforeMatch) {
    return null;
  }

  return {
    offset: {
      kind: 'unspecified_before',
      minutes: null,
      label: 'before',
    },
    targetText: stripTargetPunctuation(beforeMatch[1]),
  };
}

function parseReminderOffsetReply(message: string): ReminderOffset | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  if (/^(?:the\s+)?night before\b/i.test(normalized)) {
    return {
      kind: 'night_before',
      minutes: null,
      label: 'the night before',
    };
  }

  const minuteMatch = normalized.match(/^(\d{1,3})\s*(minutes?|mins?)\b/i);
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    if (minutes > 0) {
      return {
        kind: 'minutes_before',
        minutes,
        label: formatReminderOffsetMinutes(minutes),
      };
    }
  }

  const hourMatch = normalized.match(
    /^(?:(an?|one)|(\d{1,3}))\s*(hours?|hrs?)\b/i,
  );
  if (!hourMatch) {
    return null;
  }

  const hours = hourMatch[1] ? 1 : Number(hourMatch[2]);
  if (!Number.isInteger(hours) || hours <= 0) {
    return null;
  }

  return {
    kind: 'hours_before',
    minutes: hours * 60,
    label: formatReminderOffsetMinutes(hours * 60),
  };
}

function buildReminderStateBase(input: {
  step: PendingCalendarReminderState['step'];
  offset: ReminderOffset;
  targetLabel: string;
  targetEvent?: GoogleCalendarTrackedEvent | null;
  targetEvents?: GoogleCalendarTrackedEvent[];
  candidates?: GoogleCalendarTrackedEvent[];
  remindAtIso?: string | null;
  remindAtByEventId?: Record<string, string> | null;
  incompleteNote?: string | null;
  now?: Date;
}): PendingCalendarReminderState {
  const targetEvents = [...(input.targetEvents || [])].sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const targetEvent =
    input.targetEvent === undefined
      ? targetEvents.length === 1
        ? targetEvents[0]!
        : null
      : input.targetEvent;

  return {
    version: 2,
    createdAt: (input.now || new Date()).toISOString(),
    step: input.step,
    offset: input.offset,
    targetLabel: input.targetLabel,
    targetEvent,
    targetEvents,
    candidates: input.candidates || [],
    remindAtIso: input.remindAtIso || null,
    remindAtByEventId: input.remindAtByEventId || null,
    incompleteNote: input.incompleteNote || null,
  };
}

function getReminderTargetEvents(
  state: PendingCalendarReminderState,
): GoogleCalendarTrackedEvent[] {
  if (state.targetEvents.length > 0) {
    return state.targetEvents;
  }
  return state.targetEvent ? [state.targetEvent] : [];
}

function buildReminderNoMatchState(input: {
  offset: ReminderOffset;
  targetLabel: string;
  now?: Date;
  incompleteNote?: string | null;
}): PendingCalendarReminderState {
  return buildReminderStateBase({
    step: 'clarify_event',
    offset: input.offset,
    targetLabel: input.targetLabel,
    incompleteNote: input.incompleteNote,
    now: input.now,
  });
}

function buildReminderScheduleForEvents(input: {
  events: GoogleCalendarTrackedEvent[];
  offset: ReminderOffset;
  now?: Date;
  explicitTime?: { hours: number; minutes: number } | null;
}):
  | { kind: 'invalid'; message: string }
  | {
      kind: 'ok';
      remindAtIso: string | null;
      remindAtByEventId: Record<string, string> | null;
    } {
  const now = input.now || new Date();
  const remindAtByEventId: Record<string, string> = {};

  for (const event of input.events) {
    let remindAt: Date | null = null;
    if (input.offset.kind === 'night_before') {
      if (!input.explicitTime) {
        return { kind: 'invalid', message: 'I still need a reminder time.' };
      }
      remindAt = setLocalTime(
        addDays(startOfDay(new Date(event.startIso)), -1),
        input.explicitTime.hours,
        input.explicitTime.minutes,
      );
    } else if (event.allDay) {
      if (!input.explicitTime) {
        return { kind: 'invalid', message: 'I still need a reminder time.' };
      }
      remindAt = setLocalTime(
        startOfDay(new Date(event.startIso)),
        input.explicitTime.hours,
        input.explicitTime.minutes,
      );
    } else {
      remindAt = new Date(
        new Date(event.startIso).getTime() -
          (input.offset.minutes || 0) * 60 * 1000,
      );
    }

    if (remindAt.getTime() <= now.getTime()) {
      return {
        kind: 'invalid',
        message:
          input.events.length === 1
            ? `That reminder time has already passed for ${event.title}.`
            : 'One or more of those reminder times have already passed.',
      };
    }
    remindAtByEventId[event.id] = remindAt.toISOString();
  }

  if (input.events.length === 1) {
    return {
      kind: 'ok',
      remindAtIso: remindAtByEventId[input.events[0]!.id] || null,
      remindAtByEventId: null,
    };
  }

  return {
    kind: 'ok',
    remindAtIso: null,
    remindAtByEventId,
  };
}

function buildReminderStateFromSelectedEvents(input: {
  events: GoogleCalendarTrackedEvent[];
  offset: ReminderOffset;
  targetLabel: string;
  now?: Date;
  incompleteNote?: string | null;
}): PendingCalendarReminderResult {
  const now = input.now || new Date();
  const events = [...input.events].sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );

  if (events.length === 0) {
    return {
      kind: 'invalid',
      state: buildReminderNoMatchState({
        offset: input.offset,
        targetLabel: input.targetLabel,
        incompleteNote: input.incompleteNote,
        now,
      }),
      message: `I couldn't find an event matching "${input.targetLabel}".`,
    };
  }

  if (input.offset.kind === 'unspecified_before') {
    const state = buildReminderStateBase({
      step: 'clarify_offset',
      offset: input.offset,
      targetLabel: input.targetLabel,
      targetEvents: events,
      incompleteNote: input.incompleteNote,
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingCalendarReminderPrompt(state),
    };
  }

  if (
    input.offset.kind === 'night_before' ||
    events.some((event) => event.allDay)
  ) {
    const state = buildReminderStateBase({
      step: 'clarify_time',
      offset: input.offset,
      targetLabel: input.targetLabel,
      targetEvents: events,
      incompleteNote: input.incompleteNote,
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingCalendarReminderPrompt(state),
    };
  }

  const schedule = buildReminderScheduleForEvents({
    events,
    offset: input.offset,
    now,
  });
  if (schedule.kind === 'invalid') {
    return {
      kind: 'invalid',
      state: buildReminderStateBase({
        step: 'confirm',
        offset: input.offset,
        targetLabel: input.targetLabel,
        targetEvents: events,
        incompleteNote: input.incompleteNote,
        now,
      }),
      message: schedule.message,
    };
  }

  const confirmState = buildReminderStateBase({
    step: 'confirm',
    offset: input.offset,
    targetLabel: input.targetLabel,
    targetEvents: events,
    remindAtIso: schedule.remindAtIso,
    remindAtByEventId: schedule.remindAtByEventId,
    incompleteNote: input.incompleteNote,
    now,
  });
  return {
    kind: 'awaiting_input',
    state: confirmState,
    message: formatPendingCalendarReminderPrompt(confirmState),
  };
}

export function planCalendarEventReminder(
  message: string,
  now = new Date(),
  activeEventContext?: ActiveGoogleCalendarEventContextState | null,
): CalendarEventReminderPlanResult {
  const parsed = parseReminderOffset(message);
  if (!parsed) {
    return { kind: 'none' };
  }

  if (isPronounEventReference(parsed.targetText)) {
    if (!activeEventContext) {
      return {
        kind: 'needs_event_context',
        message: 'Which event do you mean?',
      };
    }
    const resolved = buildReminderStateFromSelectedEvents({
      events: [activeEventContext.event],
      offset: parsed.offset,
      targetLabel: parsed.targetText,
      now,
    });
    if (resolved.kind === 'awaiting_input') {
      return {
        kind: 'awaiting_input',
        state: resolved.state,
        message: resolved.message,
      };
    }
    return {
      kind: 'needs_event_context',
      message:
        'message' in resolved
          ? resolved.message
          : 'I could not set that reminder from the current event context.',
    };
  }

  const scopeFilter = detectReminderScopeFilter(
    parsed.targetText.toLowerCase(),
  );
  const targetText = stripReminderScopePhrases(parsed.targetText);
  const lowerTarget = targetText.toLowerCase();
  let selectorMode: ReminderSelectorMode = 'named';
  let searchStart = now;
  let searchEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  let queryText: string | null = null;
  let targetLabel = parsed.targetText;

  if (/\bnext meeting\b/.test(lowerTarget)) {
    selectorMode = 'next_timed';
    searchEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    targetLabel = 'your next meeting';
  } else {
    const window = extractDateWindow(targetText, now);
    searchStart = window.searchStart;
    searchEnd = window.searchEnd;

    if (/\bfirst event\b/.test(lowerTarget)) {
      selectorMode = 'first_timed_in_window';
      targetLabel = 'your first event';
    } else if (/\banything on my calendar\b/.test(lowerTarget)) {
      selectorMode = 'all_timed_in_window';
    } else if (
      scopeFilter &&
      /\bevent\b/.test(parsed.targetText.toLowerCase()) &&
      !normalizeEventQuery(stripReminderScopePhrases(window.targetText))
    ) {
      selectorMode = 'single_in_window';
      targetLabel = scopeFilter.label;
    } else {
      queryText = normalizeEventQuery(window.targetText);
    }
  }

  if (selectorMode === 'named' && !queryText) {
    return {
      kind: 'needs_event_context',
      message: 'Which event should I use for that reminder?',
    };
  }

  return {
    kind: 'lookup',
    offset: parsed.offset,
    targetLabel,
    queryText,
    searchStart,
    searchEnd,
    selectorMode,
    scopeFilter,
  };
}

export function buildPendingCalendarReminderStateFromMatches(input: {
  events: GoogleCalendarTrackedEvent[];
  offset: ReminderOffset;
  targetLabel: string;
  selectorMode?: ReminderSelectorMode;
  incompleteNote?: string | null;
  now?: Date;
}): PendingCalendarReminderResult {
  const now = input.now || new Date();
  const selectorMode = input.selectorMode || 'named';
  if (input.events.length === 0) {
    return {
      kind: 'invalid',
      state: buildReminderNoMatchState({
        offset: input.offset,
        targetLabel: input.targetLabel,
        incompleteNote: input.incompleteNote,
        now,
      }),
      message: `I couldn't find an event matching "${input.targetLabel}".`,
    };
  }

  if (
    selectorMode === 'next_timed' ||
    selectorMode === 'first_timed_in_window'
  ) {
    return buildReminderStateFromSelectedEvents({
      events: [input.events[0]!],
      offset: input.offset,
      targetLabel: input.targetLabel,
      incompleteNote: input.incompleteNote,
      now,
    });
  }

  if (selectorMode === 'all_timed_in_window') {
    if (input.events.length > 3) {
      return {
        kind: 'invalid',
        state: buildReminderNoMatchState({
          offset: input.offset,
          targetLabel: input.targetLabel,
          incompleteNote: input.incompleteNote,
          now,
        }),
        message:
          'I found more than 3 events in that range. Can you narrow it down?',
      };
    }
    return buildReminderStateFromSelectedEvents({
      events: input.events.slice(0, 3),
      offset: input.offset,
      targetLabel: input.targetLabel,
      incompleteNote: input.incompleteNote,
      now,
    });
  }

  if (input.events.length === 1) {
    return buildReminderStateFromSelectedEvents({
      events: [input.events[0]!],
      offset: input.offset,
      targetLabel: input.targetLabel,
      incompleteNote: input.incompleteNote,
      now,
    });
  }

  if (input.events.length > 3) {
    return {
      kind: 'invalid',
      state: buildReminderNoMatchState({
        offset: input.offset,
        targetLabel: input.targetLabel,
        incompleteNote: input.incompleteNote,
        now,
      }),
      message: `I found more than one event matching "${input.targetLabel}". What day do you mean?`,
    };
  }

  const state = buildReminderStateBase({
    step: 'clarify_event',
    offset: input.offset,
    targetLabel: input.targetLabel,
    candidates: input.events.slice(0, 3),
    incompleteNote: input.incompleteNote,
    now,
  });
  return {
    kind: 'awaiting_input',
    state,
    message: formatPendingCalendarReminderPrompt(state),
  };
}

export function resolveCalendarReminderLookup(input: {
  events: GoogleCalendarEventRecord[];
  failures?: string[];
  offset: ReminderOffset;
  targetLabel: string;
  selectorMode: ReminderSelectorMode;
  queryText: string | null;
  scopeFilter: ReminderScopeFilter | null;
  now?: Date;
}): PendingCalendarReminderResult {
  const now = input.now || new Date();
  const trackedEvents = input.events
    .map(toTrackedGoogleCalendarEvent)
    .filter((event) => eventMatchesReminderScope(event, input.scopeFilter))
    .sort(
      (left, right) =>
        new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
    );

  if (
    input.failures?.length &&
    input.selectorMode !== 'named' &&
    input.selectorMode !== 'single_in_window'
  ) {
    return {
      kind: 'invalid',
      state: buildReminderNoMatchState({
        offset: input.offset,
        targetLabel: input.targetLabel,
        now,
      }),
      message:
        "I can't confirm that reminder yet because I couldn't read every configured calendar right now.",
    };
  }

  let matches: GoogleCalendarTrackedEvent[] = trackedEvents;
  if (input.selectorMode === 'named') {
    matches = input.queryText
      ? trackedEvents.filter((event) =>
          eventTitleMatchesQuery(event, input.queryText!),
        )
      : [];
  } else if (input.selectorMode === 'next_timed') {
    matches = trackedEvents.filter(
      (event) =>
        !event.allDay && new Date(event.startIso).getTime() >= now.getTime(),
    );
  } else if (input.selectorMode === 'first_timed_in_window') {
    matches = trackedEvents.filter((event) => !event.allDay);
  } else if (input.selectorMode === 'all_timed_in_window') {
    matches = trackedEvents.filter((event) => !event.allDay);
  }

  return buildPendingCalendarReminderStateFromMatches({
    events: matches,
    offset: input.offset,
    targetLabel: input.targetLabel,
    selectorMode: input.selectorMode,
    incompleteNote:
      input.failures?.length &&
      input.selectorMode === 'named' &&
      matches.length > 0
        ? "I found this in the calendars I could read, but I couldn't read every configured calendar right now."
        : null,
    now,
  });
}

function parseStandaloneTime(
  message: string,
): { hours: number; minutes: number; displayLabel: string } | null {
  const normalized = normalizeMessage(message);
  const match = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) {
    return null;
  }
  return parseLooseClockTime(match[1], match[2], match[3]);
}

function selectEventCandidate(
  message: string,
  events: GoogleCalendarTrackedEvent[],
): GoogleCalendarTrackedEvent | null {
  const normalized = collapseWhitespace(
    normalizeMessage(message),
  ).toLowerCase();
  if (!normalized) return null;

  const numeric = normalized.match(/\b(\d{1,2})\b/);
  if (numeric) {
    return events[Number(numeric[1]) - 1] || null;
  }

  return (
    events.find((event) => normalizeEventQuery(event.title) === normalized) ||
    events.find((event) =>
      normalizeEventQuery(event.title).includes(normalized),
    ) ||
    null
  );
}

export function advancePendingCalendarReminder(
  message: string,
  state: PendingCalendarReminderState,
  now = new Date(),
): PendingCalendarReminderResult {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return { kind: 'no_match' };
  }

  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'cancelled',
      message: "Okay, I won't set that reminder.",
    };
  }

  if (state.step === 'clarify_event') {
    const selected = selectEventCandidate(normalized, state.candidates);
    return selected
      ? buildReminderStateFromSelectedEvents({
          events: [selected],
          offset: state.offset,
          targetLabel: state.targetLabel,
          incompleteNote: state.incompleteNote,
          now,
        })
      : { kind: 'no_match' };
  }

  if (state.step === 'clarify_offset') {
    const offset = parseReminderOffsetReply(normalized);
    if (!offset) {
      return { kind: 'no_match' };
    }
    return buildReminderStateFromSelectedEvents({
      events: getReminderTargetEvents(state),
      offset,
      targetLabel: state.targetLabel,
      incompleteNote: state.incompleteNote,
      now,
    });
  }

  if (state.step === 'clarify_time') {
    const targetEvents = getReminderTargetEvents(state);
    if (targetEvents.length === 0) {
      return { kind: 'no_match' };
    }
    const time = parseStandaloneTime(normalized);
    if (!time) {
      return { kind: 'no_match' };
    }
    const schedule = buildReminderScheduleForEvents({
      events: targetEvents,
      offset: state.offset,
      explicitTime: time,
      now,
    });
    if (schedule.kind === 'invalid') {
      return {
        kind: 'invalid',
        state,
        message: schedule.message,
      };
    }
    const nextState = buildReminderStateBase({
      step: 'confirm',
      offset: state.offset,
      targetLabel: state.targetLabel,
      targetEvents,
      remindAtIso: schedule.remindAtIso,
      remindAtByEventId: schedule.remindAtByEventId,
      incompleteNote: state.incompleteNote,
      now,
    });
    return {
      kind: 'awaiting_input',
      state: nextState,
      message: formatPendingCalendarReminderPrompt(nextState),
    };
  }

  if (!CONFIRM_PATTERN.test(normalized)) {
    return { kind: 'no_match' };
  }

  return {
    kind: 'confirmed',
    state,
  };
}

export function formatPendingCalendarReminderPrompt(
  state: PendingCalendarReminderState,
  timeZone = TIMEZONE,
): string {
  if (state.step === 'clarify_event') {
    const lines = [
      `I found more than one event matching "${state.targetLabel}".`,
      '',
      ...state.candidates.map(
        (event, index) => `- ${formatEventChoice(event, index + 1, timeZone)}`,
      ),
      '',
      'Which one should I use?',
    ];
    if (state.incompleteNote) {
      lines.push('', state.incompleteNote);
    }
    return lines.join('\n');
  }

  if (state.step === 'clarify_offset') {
    const targetEvents = getReminderTargetEvents(state);
    if (targetEvents.length > 1) {
      return [
        'How far before should I remind you about these events?',
        '',
        ...targetEvents.map(
          (event, index) =>
            `- ${formatEventChoice(event, index + 1, timeZone)}`,
        ),
      ].join('\n');
    }
    return state.targetEvent
      ? `How far before should I remind you about ${state.targetEvent.title}?`
      : 'How far before should I remind you?';
  }

  if (state.step === 'clarify_time') {
    const targetEvents = getReminderTargetEvents(state);
    if (state.offset.kind === 'night_before') {
      return targetEvents.length > 1
        ? 'What time should I use the night before these events?'
        : state.targetEvent
          ? `What time should I use the night before ${state.targetEvent.title}?`
          : 'What time should I use the night before that event?';
    }
    return targetEvents.length > 1
      ? 'Those events are all day. What time should I use for the reminders?'
      : state.targetEvent
        ? `That event is all day. What time should I use for ${state.targetEvent.title}?`
        : 'That event is all day. What time should I use for the reminder?';
  }

  const targetEvents = getReminderTargetEvents(state);
  if (
    targetEvents.length === 0 ||
    (!state.remindAtIso && !state.remindAtByEventId)
  ) {
    return 'I still need a target event before I can set that reminder.';
  }

  const remindFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const eventFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  if (targetEvents.length === 1) {
    const event = targetEvents[0]!;
    const reminderIso =
      state.remindAtIso || state.remindAtByEventId?.[event.id] || null;
    return [
      event.allDay && state.offset.kind !== 'night_before'
        ? `I can remind you about ${event.title}.`
        : `I can remind you ${state.offset.label} ${event.title}.`,
      `- Reminder: ${reminderIso ? remindFormatter.format(new Date(reminderIso)) : 'pending'}`,
      `- Event: ${
        event.allDay
          ? formatEventWhen(event, timeZone)
          : eventFormatter.format(new Date(event.startIso))
      }`,
      ...(state.incompleteNote ? ['', state.incompleteNote] : []),
      '',
      'Reply "yes" to save it or "cancel" to stop.',
    ].join('\n');
  }

  return [
    `I can set ${targetEvents.length} reminders for these events:`,
    ...targetEvents.map((event) => {
      const reminderIso = state.remindAtByEventId?.[event.id];
      return `- ${event.title}: ${
        reminderIso ? remindFormatter.format(new Date(reminderIso)) : 'pending'
      } for ${formatEventWhen(event, timeZone)}`;
    }),
    ...(state.incompleteNote ? ['', state.incompleteNote] : []),
    '',
    'Reply "yes" to save them or "cancel" to stop.',
  ].join('\n');
}

export function buildEventReminderTaskPlan(input: {
  state: PendingCalendarReminderState;
  groupFolder: string;
  chatJid: string;
  now?: Date;
  timeZone?: string;
}): EventReminderTaskPlan {
  const now = input.now || new Date();
  const timeZone = input.timeZone || TIMEZONE;
  const targetEvents = getReminderTargetEvents(input.state);
  const event = targetEvents[0]!;
  const remindAt = new Date(
    input.state.remindAtIso ||
      input.state.remindAtByEventId?.[event?.id || ''] ||
      now.toISOString(),
  );
  const eventFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const reminderFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  const tasks = targetEvents.map((event, index) => {
    const remindAt = new Date(
      input.state.remindAtByEventId?.[event.id] || input.state.remindAtIso!,
    );
    return {
      id: `task-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: input.groupFolder,
      chat_jid: input.chatJid,
      prompt: `Send a concise reminder that "${event.title}" is scheduled for ${
        event.allDay
          ? formatEventWhen(event, timeZone)
          : eventFormatter.format(new Date(event.startIso))
      }.`,
      script: null,
      schedule_type: 'once' as const,
      schedule_value: toLocalTimestamp(remindAt),
      context_mode: 'isolated' as const,
      next_run: remindAt.toISOString(),
      status: 'active' as const,
      created_at: now.toISOString(),
    };
  });

  const confirmation =
    targetEvents.length === 1
      ? `Okay, I'll remind you ${
          targetEvents[0]!.allDay && input.state.offset.kind !== 'night_before'
            ? `about ${targetEvents[0]!.title}`
            : `${input.state.offset.label} ${targetEvents[0]!.title}`
        }.\n\nReminder: ${reminderFormatter.format(
          new Date(
            input.state.remindAtIso ||
              input.state.remindAtByEventId?.[targetEvents[0]!.id] ||
              '',
          ),
        )}`
      : [
          `Okay, I'll set reminders for these ${targetEvents.length} events:`,
          ...targetEvents.map((event) => {
            const remindAt = input.state.remindAtByEventId?.[event.id];
            return `- ${event.title}: ${
              remindAt
                ? reminderFormatter.format(new Date(remindAt))
                : 'pending'
            }`;
          }),
        ].join('\n');

  return {
    confirmation,
    tasks,
  };

  return {
    confirmation: `Okay — I'll remind you ${input.state.offset.label} ${event.title}.\n\nReminder: ${reminderFormatter.format(remindAt)}`,
    task: {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: input.groupFolder,
      chat_jid: input.chatJid,
      prompt: `Send a concise reminder that "${event.title}" is scheduled for ${eventFormatter.format(new Date(event.startIso))}.`,
      script: null,
      schedule_type: 'once',
      schedule_value: toLocalTimestamp(remindAt),
      context_mode: 'isolated',
      next_run: remindAt.toISOString(),
      status: 'active',
      created_at: now.toISOString(),
    },
  };
}

function looksLikeEventAction(normalized: string): boolean {
  if (
    /\b(?:move|reschedule|shorten|extend|lengthen|cancel|delete|remove)\b/i.test(
      normalized,
    )
  ) {
    return true;
  }

  const hasPronounTarget = /\b(?:it|that|event|meeting|appointment)\b/i.test(
    normalized,
  );
  const hasCalendarVerb = /\b(?:put|move|switch)\b/i.test(normalized);
  const hasCalendarMention = /\bcalendar\b/i.test(normalized);
  const hasReassignHint =
    /\binstead\b/i.test(normalized) ||
    /\b(?:to|from)\b[\s\S]{0,30}\bcalendar\b/i.test(normalized);

  return (
    hasPronounTarget && hasCalendarVerb && hasCalendarMention && hasReassignHint
  );
}

function matchCalendarSelection(
  message: string,
  calendars: PendingGoogleCalendarEventActionState['calendars'],
): { id: string; summary: string; primary: boolean } | null {
  const normalized = collapseWhitespace(message).toLowerCase();
  if (!normalized) return null;

  const numeric = normalized.match(/\b(\d{1,2})\b/);
  if (numeric) {
    return calendars[Number(numeric[1]) - 1] || null;
  }

  return (
    calendars.find((calendar) => {
      const summary = calendar.summary.trim().toLowerCase();
      return (
        normalized === summary ||
        normalized === `${summary} calendar` ||
        normalized.includes(summary)
      );
    }) || null
  );
}

function buildEventActionState(input: {
  action: PendingGoogleCalendarEventActionState['action'];
  sourceEvent: GoogleCalendarTrackedEvent;
  proposedEvent?: GoogleCalendarTrackedEvent | null;
  calendars?: GoogleCalendarMetadata[];
  selectedCalendarId?: string | null;
  step?: PendingGoogleCalendarEventActionState['step'];
  now?: Date;
}): PendingGoogleCalendarEventActionState {
  return {
    version: 1,
    createdAt: (input.now || new Date()).toISOString(),
    step: input.step || 'confirm',
    action: input.action,
    sourceEvent: input.sourceEvent,
    proposedEvent: input.proposedEvent || null,
    calendars: (input.calendars || [])
      .filter((calendar) => calendar.selected && calendar.writable)
      .map((calendar) => ({
        id: calendar.id,
        summary: calendar.summary,
        primary: calendar.primary,
      })),
    selectedCalendarId: input.selectedCalendarId || null,
    conflictSummary: null,
    candidates: [],
  };
}

function parseDurationChange(
  normalized: string,
): { minutes: number; label: string } | null {
  const minuteMatch = normalized.match(
    /\b(?:shorten|make it|change it|set it)\b[\s\S]{0,20}\bto\s+(\d{1,3})\s*(minutes?|mins?)\b/i,
  );
  if (!minuteMatch) {
    return null;
  }
  const minutes = Number(minuteMatch[1]);
  if (!Number.isInteger(minutes) || minutes < 15) {
    return null;
  }
  return {
    minutes,
    label: `${minutes} minutes`,
  };
}

function parseEventMoveAdjustment(
  message: string,
  sourceEvent: GoogleCalendarTrackedEvent,
  now = new Date(),
): GoogleCalendarTrackedEvent | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  const dateInfo = parseDatePhrase(normalized, now);
  const timeInfo = parseTimeRange(normalized);
  const daypartInfo = parseDaypartPhrase(normalized);
  if (!dateInfo && !timeInfo.start && !daypartInfo) {
    return null;
  }

  const eventStart = new Date(sourceEvent.startIso);
  const durationMinutes = getEventDurationMinutes(sourceEvent);
  const targetDate = dateInfo ? dateInfo.date : startOfDay(eventStart);

  if (timeInfo.start) {
    const nextStart = setLocalTime(
      targetDate,
      timeInfo.start.hours,
      timeInfo.start.minutes,
    );
    const nextEnd = timeInfo.end
      ? (() => {
          const end = setLocalTime(
            targetDate,
            timeInfo.end!.hours,
            timeInfo.end!.minutes,
          );
          return end <= nextStart ? addDays(end, 1) : end;
        })()
      : new Date(nextStart.getTime() + durationMinutes * 60 * 1000);
    return cloneEventWithTiming(sourceEvent, nextStart, nextEnd, false);
  }

  if (daypartInfo) {
    const nextStart = setLocalTime(
      targetDate,
      DAYPART_RANGES[daypartInfo.name].startHour,
    );
    const nextEnd = new Date(nextStart.getTime() + durationMinutes * 60 * 1000);
    return cloneEventWithTiming(sourceEvent, nextStart, nextEnd, false);
  }

  return null;
}

function parseAfterAnchorRequest(
  message: string,
  sourceEvent: GoogleCalendarTrackedEvent,
  now = new Date(),
): {
  anchorTime: { hours: number; minutes: number; displayLabel: string };
  anchorDate: Date;
} | null {
  const normalized = normalizeMessage(message);
  const match = normalized.match(
    /\bafter my (\d{1,2})(?::(\d{2}))?\s*(am|pm)? meeting\b/i,
  );
  if (!match) {
    return null;
  }
  const anchorTime = parseLooseClockTime(match[1], match[2], match[3]);
  if (!anchorTime) {
    return null;
  }
  const dateInfo = parseDatePhrase(normalized, now);
  return {
    anchorTime,
    anchorDate: dateInfo
      ? dateInfo.date
      : startOfDay(new Date(sourceEvent.startIso)),
  };
}

function formatDurationLabel(minutes: number): string {
  return minutes === 60
    ? '1 hour'
    : minutes % 60 === 0
      ? `${minutes / 60} hours`
      : `${minutes} minutes`;
}

export function planGoogleCalendarEventAction(
  message: string,
  writableCalendars: GoogleCalendarMetadata[],
  now = new Date(),
  activeEventContext?: ActiveGoogleCalendarEventContextState | null,
): GoogleCalendarEventActionPlanResult {
  const normalized = normalizeMessage(message);
  if (!normalized || !looksLikeEventAction(normalized)) {
    return { kind: 'none' };
  }

  if (!activeEventContext) {
    return {
      kind: 'needs_event_context',
      message: 'Which event do you mean?',
    };
  }

  const sourceEvent = activeEventContext.event;

  if (/\b(?:cancel|delete|remove)\b/i.test(normalized)) {
    const state = buildEventActionState({
      action: 'delete',
      sourceEvent,
      calendars: writableCalendars,
      selectedCalendarId: sourceEvent.calendarId,
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingGoogleCalendarEventActionPrompt(state),
    };
  }

  const requestedCalendar = matchCalendarSelection(
    normalized,
    writableCalendars,
  );
  if (
    /\bcalendar\b/i.test(normalized) &&
    /\b(?:put|move)\b/i.test(normalized) &&
    !/\b(?:move|reschedule)\b[\s\S]{0,40}\b(?:to|at|after)\b/i.test(normalized)
  ) {
    const writable = writableCalendars.filter(
      (calendar) => calendar.selected && calendar.writable,
    );
    if (writable.length === 0) {
      return {
        kind: 'needs_event_context',
        message:
          'I can read your Google calendars here, but none of the selected Google calendars are writable right now.',
      };
    }
    const selectedCalendarId =
      requestedCalendar?.id || (writable.length === 1 ? writable[0]?.id : null);
    const state = buildEventActionState({
      action: 'reassign',
      sourceEvent,
      calendars: writableCalendars,
      selectedCalendarId,
      step: selectedCalendarId ? 'confirm' : 'choose_calendar',
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingGoogleCalendarEventActionPrompt(state),
    };
  }

  const durationChange = parseDurationChange(normalized);
  if (durationChange) {
    const baseStart = new Date(sourceEvent.startIso);
    const proposedEvent = cloneEventWithTiming(
      sourceEvent,
      baseStart,
      new Date(baseStart.getTime() + durationChange.minutes * 60 * 1000),
      false,
    );
    const state = buildEventActionState({
      action: 'resize',
      sourceEvent,
      proposedEvent,
      calendars: writableCalendars,
      selectedCalendarId: sourceEvent.calendarId,
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingGoogleCalendarEventActionPrompt(state),
    };
  }

  const anchorRequest = parseAfterAnchorRequest(normalized, sourceEvent, now);
  if (anchorRequest) {
    const state = buildEventActionState({
      action: 'move',
      sourceEvent,
      proposedEvent: sourceEvent,
      calendars: writableCalendars,
      selectedCalendarId: sourceEvent.calendarId,
      now,
    });
    return {
      kind: 'resolve_anchor',
      state,
      anchorTime: anchorRequest.anchorTime,
      anchorDate: anchorRequest.anchorDate,
    };
  }

  const moveAdjustment = parseEventMoveAdjustment(normalized, sourceEvent, now);
  if (moveAdjustment) {
    const state = buildEventActionState({
      action: 'move',
      sourceEvent,
      proposedEvent: moveAdjustment,
      calendars: writableCalendars,
      selectedCalendarId: sourceEvent.calendarId,
      now,
    });
    return {
      kind: 'awaiting_input',
      state,
      message: formatPendingGoogleCalendarEventActionPrompt(state),
    };
  }

  return { kind: 'none' };
}

export function formatPendingGoogleCalendarEventActionPrompt(
  state: PendingGoogleCalendarEventActionState,
  timeZone = TIMEZONE,
): string {
  if (state.step === 'choose_calendar') {
    return [
      `Which calendar should I move "${state.sourceEvent.title}" to?`,
      '',
      ...state.calendars.map((calendar, index) => {
        const suffix = calendar.primary ? ' (primary)' : '';
        return `- ${index + 1}. ${calendar.summary}${suffix}`;
      }),
      '',
      'Reply with a number or calendar name.',
    ].join('\n');
  }

  const selectedCalendar = state.calendars.find(
    (calendar) => calendar.id === state.selectedCalendarId,
  );

  if (state.action === 'delete') {
    return [
      'Delete this Google Calendar event?',
      `- Title: ${state.sourceEvent.title}`,
      `- When: ${formatEventWhen(state.sourceEvent, timeZone)}`,
      `- Calendar: ${state.sourceEvent.calendarName}`,
      '',
      'Reply "yes" to delete it or "cancel" to stop.',
    ].join('\n');
  }

  if (state.action === 'reassign') {
    return [
      `Move "${state.sourceEvent.title}" to ${selectedCalendar?.summary || 'that'} calendar?`,
      `- Current calendar: ${state.sourceEvent.calendarName}`,
      `- New calendar: ${selectedCalendar?.summary || 'Unknown calendar'}`,
      '',
      'Reply "yes" to update it or "cancel" to stop.',
    ].join('\n');
  }

  const targetEvent = state.proposedEvent || state.sourceEvent;
  const targetLabel =
    state.action === 'resize'
      ? `Change "${state.sourceEvent.title}" to ${formatDurationLabel(getEventDurationMinutes(targetEvent))}?`
      : `Move "${state.sourceEvent.title}" to ${formatEventWhen(targetEvent, timeZone)}?`;

  return [
    ...(state.conflictSummary?.blockingEvents.length
      ? [
          'That time conflicts with:',
          ...state.conflictSummary.blockingEvents.map(
            (event) =>
              `- ${
                event.allDay
                  ? 'All day'
                  : formatEventWhen(
                      {
                        startIso: event.startIso,
                        endIso: event.endIso,
                        allDay: event.allDay,
                      },
                      timeZone,
                    )
              } ${event.title}${event.calendarName ? ` [${event.calendarName}]` : ''}`,
          ),
          ...(state.conflictSummary.suggestions.length > 0
            ? [
                '',
                'You could also use:',
                ...state.conflictSummary.suggestions.map(
                  (suggestion, index) => `- ${index + 1}. ${suggestion.label}`,
                ),
              ]
            : []),
          '',
        ]
      : []),
    ...(state.conflictSummary?.warningMessage
      ? [state.conflictSummary.warningMessage, '']
      : []),
    targetLabel,
    `- Current: ${formatEventWhen(state.sourceEvent, timeZone)}`,
    `- New: ${formatEventWhen(targetEvent, timeZone)}`,
    '',
    state.conflictSummary?.blockingEvents.length
      ? 'Reply "yes" to update it anyway, choose a suggestion number, or say "cancel".'
      : 'Reply "yes" to update it or "cancel" to stop.',
  ].join('\n');
}

export function advancePendingGoogleCalendarEventAction(
  message: string,
  state: PendingGoogleCalendarEventActionState,
  now = new Date(),
): PendingGoogleCalendarEventActionResult {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return { kind: 'no_match' };
  }

  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'cancelled',
      message:
        state.action === 'delete'
          ? "Okay, I won't delete that event."
          : "Okay, I won't update that event.",
    };
  }

  if (state.step === 'choose_calendar') {
    const selection = matchCalendarSelection(normalized, state.calendars);
    if (!selection) {
      return { kind: 'no_match' };
    }
    const nextState: PendingGoogleCalendarEventActionState = {
      ...state,
      step: 'confirm',
      selectedCalendarId: selection.id,
      conflictSummary: null,
    };
    return {
      kind: 'awaiting_input',
      state: nextState,
      message: formatPendingGoogleCalendarEventActionPrompt(nextState),
    };
  }

  if (state.conflictSummary?.suggestions.length) {
    const numeric = normalized.match(/\b(\d{1,2})\b/);
    if (numeric) {
      const suggestion =
        state.conflictSummary.suggestions[Number(numeric[1]) - 1];
      if (suggestion) {
        const nextState: PendingGoogleCalendarEventActionState = {
          ...state,
          proposedEvent: cloneEventWithTiming(
            state.sourceEvent,
            new Date(suggestion.startIso),
            new Date(suggestion.endIso),
            false,
          ),
          conflictSummary: null,
        };
        return {
          kind: 'awaiting_input',
          state: nextState,
          message: formatPendingGoogleCalendarEventActionPrompt(nextState),
        };
      }
    }
  }

  if (state.action === 'reassign' && state.calendars.length > 1) {
    const selection = matchCalendarSelection(normalized, state.calendars);
    if (selection && selection.id !== state.selectedCalendarId) {
      const nextState: PendingGoogleCalendarEventActionState = {
        ...state,
        selectedCalendarId: selection.id,
      };
      return {
        kind: 'awaiting_input',
        state: nextState,
        message: formatPendingGoogleCalendarEventActionPrompt(nextState),
      };
    }
  }

  if (state.action === 'move') {
    const anchorRequest = parseAfterAnchorRequest(
      normalized,
      state.sourceEvent,
      now,
    );
    if (anchorRequest) {
      return {
        kind: 'resolve_anchor',
        state,
        anchorTime: anchorRequest.anchorTime,
        anchorDate: anchorRequest.anchorDate,
      };
    }
  }

  if (state.action === 'move' || state.action === 'resize') {
    const updated =
      state.action === 'resize'
        ? (() => {
            const duration = parseDurationChange(normalized);
            if (!duration) return null;
            const start = new Date(
              (state.proposedEvent || state.sourceEvent).startIso,
            );
            return cloneEventWithTiming(
              state.sourceEvent,
              start,
              new Date(start.getTime() + duration.minutes * 60 * 1000),
              false,
            );
          })()
        : parseEventMoveAdjustment(
            normalized,
            state.proposedEvent || state.sourceEvent,
            now,
          );
    if (updated) {
      const nextState: PendingGoogleCalendarEventActionState = {
        ...state,
        proposedEvent: updated,
        conflictSummary: null,
      };
      return {
        kind: 'awaiting_input',
        state: nextState,
        message: formatPendingGoogleCalendarEventActionPrompt(nextState),
      };
    }
  }

  if (!CONFIRM_PATTERN.test(normalized)) {
    return { kind: 'no_match' };
  }

  return {
    kind: 'confirmed',
    state,
  };
}

export function buildActiveGoogleCalendarEventContextState(
  event: GoogleCalendarEventRecord | GoogleCalendarTrackedEvent,
  now = new Date(),
): ActiveGoogleCalendarEventContextState {
  return {
    version: 1,
    createdAt: now.toISOString(),
    event: {
      id: event.id,
      title: event.title,
      startIso: event.startIso,
      endIso: event.endIso,
      allDay: event.allDay,
      calendarId: event.calendarId,
      calendarName: event.calendarName,
      htmlLink: event.htmlLink || null,
    },
  };
}

export function isActiveGoogleCalendarEventContextExpired(
  state: ActiveGoogleCalendarEventContextState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

export function isPendingCalendarReminderExpired(
  state: PendingCalendarReminderState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

export function isPendingGoogleCalendarEventActionExpired(
  state: PendingGoogleCalendarEventActionState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

export function matchGoogleCalendarTrackedEvents(
  events: GoogleCalendarEventRecord[],
  queryText: string,
): GoogleCalendarTrackedEvent[] {
  return events
    .filter((event) =>
      eventTitleMatchesQuery(
        {
          id: event.id,
          title: event.title,
          startIso: event.startIso,
          endIso: event.endIso,
          allDay: event.allDay,
          calendarId: event.calendarId,
          calendarName: event.calendarName,
          htmlLink: event.htmlLink || null,
        },
        queryText,
      ),
    )
    .map((event) => ({
      id: event.id,
      title: event.title,
      startIso: event.startIso,
      endIso: event.endIso,
      allDay: event.allDay,
      calendarId: event.calendarId,
      calendarName: event.calendarName,
      htmlLink: event.htmlLink || null,
    }))
    .sort(
      (left, right) =>
        new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
    );
}

export function toTrackedGoogleCalendarEvent(
  event: GoogleCalendarEventRecord,
): GoogleCalendarTrackedEvent {
  return {
    id: event.id,
    title: event.title,
    startIso: event.startIso,
    endIso: event.endIso,
    allDay: event.allDay,
    calendarId: event.calendarId,
    calendarName: event.calendarName,
    htmlLink: event.htmlLink || null,
  };
}

export function buildSameDaySuggestions(input: {
  events: GoogleCalendarEventRecord[];
  sourceEventId?: string | null;
  targetStart: Date;
  durationMinutes: number;
  timeZone?: string;
}): GoogleCalendarSlotSuggestion[] {
  const suggestions: GoogleCalendarSlotSuggestion[] = [];
  const dayStart = startOfDay(input.targetStart);
  const dayEnd = addDays(dayStart, 1);
  const stepMs = 15 * 60 * 1000;
  const durationMs = input.durationMinutes * 60 * 1000;
  const isOpen = (candidateStart: Date): boolean => {
    const candidateEnd = new Date(candidateStart.getTime() + durationMs);
    if (candidateStart < dayStart || candidateEnd > dayEnd) {
      return false;
    }
    return !input.events.some((event) => {
      if (event.id === input.sourceEventId || event.allDay) {
        return false;
      }
      const eventStart = new Date(event.startIso).getTime();
      const eventEnd = new Date(event.endIso).getTime();
      return (
        eventStart < candidateEnd.getTime() &&
        eventEnd > candidateStart.getTime()
      );
    });
  };

  for (
    let offset = stepMs;
    offset <= 8 * 60 * 60 * 1000 && suggestions.length < 2;
    offset += stepMs
  ) {
    const later = new Date(input.targetStart.getTime() + offset);
    if (isOpen(later)) {
      suggestions.push({
        startIso: later.toISOString(),
        endIso: new Date(later.getTime() + durationMs).toISOString(),
        label: formatEventWhen(
          {
            startIso: later.toISOString(),
            endIso: new Date(later.getTime() + durationMs).toISOString(),
            allDay: false,
          },
          input.timeZone || TIMEZONE,
        ),
      });
    }
    if (suggestions.length >= 2) break;
    const earlier = new Date(input.targetStart.getTime() - offset);
    if (isOpen(earlier)) {
      suggestions.push({
        startIso: earlier.toISOString(),
        endIso: new Date(earlier.getTime() + durationMs).toISOString(),
        label: formatEventWhen(
          {
            startIso: earlier.toISOString(),
            endIso: new Date(earlier.getTime() + durationMs).toISOString(),
            allDay: false,
          },
          input.timeZone || TIMEZONE,
        ),
      });
    }
  }

  return suggestions.slice(0, 2);
}
