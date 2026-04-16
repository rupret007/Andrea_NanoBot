import { TIMEZONE } from './config.js';
import type { GoogleCalendarMetadata } from './google-calendar.js';
import { formatVoiceChoicePrompt } from './voice-ready.js';

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const DAYPART_RANGES = {
  morning: { startHour: 6, endHour: 12 },
  afternoon: { startHour: 12, endHour: 17 },
  evening: { startHour: 17, endHour: 21 },
  tonight: { startHour: 18, endHour: 24 },
} as const;

const CANCEL_PATTERN =
  /^(?:cancel|never mind|nevermind|stop|no|delete(?:\s+(?:that|it))?|remove(?:\s+(?:that|it))?|discard(?:\s+(?:that|it))?)\b/i;
const CONFIRM_PATTERN =
  /^(?:yes|yep|yeah|confirm|create it|go ahead|looks good|ok|okay)\b/i;
const DEFAULT_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const ALL_DAY_PATTERN = /\ball(?:\s+|-)day\b/i;

export interface GoogleCalendarCreateDraft {
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  timeZone: string;
  location?: string | null;
  description?: string | null;
}

export interface GoogleCalendarConflictEvent {
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  calendarName?: string | null;
}

export interface GoogleCalendarSlotSuggestion {
  startIso: string;
  endIso: string;
  label: string;
}

export interface GoogleCalendarDraftConflictSummary {
  blockingEvents: GoogleCalendarConflictEvent[];
  suggestions: GoogleCalendarSlotSuggestion[];
  selectedSuggestionStartIso: string | null;
  warningMessage?: string | null;
}

export interface GoogleCalendarSchedulingContextState {
  version: 1;
  createdAt: string;
  title: string;
  durationMinutes: number;
  timeZone: string;
}

export interface PendingGoogleCalendarCreateState {
  version: 2;
  createdAt: string;
  step: 'choose_calendar' | 'confirm_create';
  draft: GoogleCalendarCreateDraft;
  calendars: Array<{
    id: string;
    summary: string;
    primary: boolean;
  }>;
  selectedCalendarId: string | null;
  conflictSummary: GoogleCalendarDraftConflictSummary | null;
}

export type GoogleCalendarCreatePlanResult =
  | { kind: 'none' }
  | {
      kind: 'needs_details';
      message: string;
      pendingState?: PendingGoogleCalendarCreateState | null;
    }
  | {
      kind: 'draft';
      draft: GoogleCalendarCreateDraft;
      selectedCalendarId: string | null;
    };

export type PendingGoogleCalendarCreateResult =
  | { kind: 'no_match' }
  | { kind: 'cancelled'; message: string }
  | {
      kind: 'awaiting_input';
      state: PendingGoogleCalendarCreateState;
      message: string;
    }
  | {
      kind: 'confirmed';
      state: PendingGoogleCalendarCreateState;
      calendarId: string;
    }
  | {
      kind: 'resolve_anchor';
      state: PendingGoogleCalendarCreateState;
      anchorTime: { hours: number; minutes: number; displayLabel: string };
      anchorDate: Date;
    };

function normalizeMessage(message: string): string {
  return message
    .replace(/[â€™â€˜]/g, "'")
    .replace(/[â€œâ€]/g, '"')
    .trim()
    .replace(
      /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|please)[,!. ]+)*(?:andrea[,!. ]+)?/i,
      '',
    )
    .trim();
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

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatClockLabel(hours: number, minutes: number): string {
  const displayHour = hours % 12 || 12;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  return minutes === 0
    ? `${displayHour} ${suffix}`
    : `${displayHour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

function inferClockHourWithoutMeridiem(rawHour: number): number | null {
  if (rawHour < 0 || rawHour > 23) {
    return null;
  }
  if (rawHour >= 13) {
    return rawHour;
  }
  if (rawHour === 12) {
    return 12;
  }
  if (rawHour >= 1 && rawHour <= 7) {
    return rawHour + 12;
  }
  return rawHour;
}

function parseLooseClockTime(
  hoursText: string,
  minutesText: string | undefined,
  meridiem: string | undefined,
): { hours: number; minutes: number; displayLabel: string } | null {
  const rawHour = Number(hoursText);
  const minutes = minutesText ? Number(minutesText) : 0;
  const normalizedMeridiem = meridiem?.toLowerCase() ?? null;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  let hours: number | null = null;
  if (normalizedMeridiem) {
    if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) {
      return null;
    }
    hours =
      rawHour === 12
        ? normalizedMeridiem === 'am'
          ? 0
          : 12
        : normalizedMeridiem === 'pm'
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

function resolveNextWeekdayDate(weekdayName: string, now: Date): Date {
  const base = startOfDay(now);
  const targetDay = WEEKDAY_INDEX[weekdayName];
  let offset = (targetDay - base.getDay() + 7) % 7;
  if (offset === 0) {
    offset = 7;
  }
  return addDays(base, offset);
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
  if (weekdayMatch) {
    const weekdayName = weekdayMatch[2].toLowerCase();
    let date = resolveNextWeekdayDate(weekdayName, now);
    if (!weekdayMatch[1]) {
      date = resolveNextWeekdayDate(weekdayName, now);
    }
    return {
      date,
      matchedText: weekdayMatch[0],
    };
  }

  const monthNameMatch = working.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i,
  );
  if (monthNameMatch) {
    const month = MONTH_INDEX[monthNameMatch[1].toLowerCase()];
    const day = Number(monthNameMatch[2]);
    const year = monthNameMatch[3]
      ? Number(monthNameMatch[3])
      : (() => {
          const candidate = new Date(now.getFullYear(), month, day);
          return candidate < startOfDay(now)
            ? now.getFullYear() + 1
            : now.getFullYear();
        })();
    return {
      date: new Date(year, month, day),
      matchedText: monthNameMatch[0],
    };
  }

  const numericMatch = working.match(
    /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const month = Number(numericMatch[1]) - 1;
    const day = Number(numericMatch[2]);
    const year = numericMatch[3]
      ? Number(
          numericMatch[3].length === 2
            ? `20${numericMatch[3]}`
            : numericMatch[3],
        )
      : (() => {
          const candidate = new Date(now.getFullYear(), month, day);
          return candidate < startOfDay(now)
            ? now.getFullYear() + 1
            : now.getFullYear();
        })();
    return {
      date: new Date(year, month, day),
      matchedText: numericMatch[0],
    };
  }

  return null;
}

function parseClockPart(
  hoursText: string,
  minutesText: string | undefined,
  meridiem: string | undefined,
): { hours: number; minutes: number; displayLabel: string } | null {
  return parseLooseClockTime(hoursText, minutesText, meridiem);
}

function parseTimeRange(working: string): {
  start: { hours: number; minutes: number; displayLabel: string } | null;
  end: { hours: number; minutes: number; displayLabel: string } | null;
  matchedText: string | null;
} {
  const explicitRange = working.match(
    /\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|til)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (explicitRange) {
    const start = parseClockPart(
      explicitRange[1],
      explicitRange[2],
      explicitRange[3],
    );
    const end = parseClockPart(
      explicitRange[4],
      explicitRange[5],
      explicitRange[6] || explicitRange[3],
    );
    return {
      start,
      end,
      matchedText: explicitRange[0],
    };
  }

  const startOnly = working.match(
    /\b(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  const impliedStart =
    startOnly ||
    working.match(
      /\b(?:start\s+time|time)\s*(?:is\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
    ) ||
    working.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!impliedStart) {
    return {
      start: null,
      end: null,
      matchedText: null,
    };
  }

  return {
    start: parseClockPart(impliedStart[1], impliedStart[2], impliedStart[3]),
    end: null,
    matchedText: impliedStart[0],
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

function getDraftDurationMinutes(draft: GoogleCalendarCreateDraft): number {
  if (draft.allDay) {
    return 24 * 60;
  }
  return Math.max(
    15,
    Math.round(
      (new Date(draft.endIso).getTime() - new Date(draft.startIso).getTime()) /
        (60 * 1000),
    ),
  );
}

function looksLikeExplicitCalendarCreate(normalized: string): boolean {
  const assistantStyleSchedulingCue =
    /\b(?:today|tomorrow|tonight|this morning|this afternoon|this evening|all day|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|at \d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;
  return (
    /\b(?:add|put)\b[\s\S]{0,140}\b(?:to|on|in)\b[\s\S]{0,60}\bcalendar\b/.test(
      normalized,
    ) ||
    (/^\s*(?:add|put|create|schedule)\b/.test(normalized) &&
      assistantStyleSchedulingCue.test(normalized)) ||
    /\bcreate\b[\s\S]{0,50}\bevent\b/.test(normalized) ||
    /\bschedule\b[\s\S]{0,80}\b(?:event|calendar)\b/.test(normalized) ||
    (/^\s*schedule\b/.test(normalized) &&
      assistantStyleSchedulingCue.test(normalized))
  );
}

export function isExplicitGoogleCalendarCreateRequest(message: string): boolean {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) {
    return false;
  }
  return looksLikeExplicitCalendarCreate(normalized);
}

function extractTrailingField(
  working: string,
  label: 'location' | 'notes' | 'description',
): { value: string | null; nextWorking: string } {
  const pattern = new RegExp(
    `(?:^|\\s)${label}:\\s*(.+?)(?=(?:\\s+(?:location|notes|description):|$))`,
    'i',
  );
  const match = working.match(pattern);
  if (!match) {
    return { value: null, nextWorking: working };
  }

  const value = collapseWhitespace(match[1] || '');
  const nextWorking = collapseWhitespace(working.replace(match[0], ' '));
  return { value: value || null, nextWorking };
}

function buildMissingDetailsReply(input: {
  missingDate: boolean;
  missingTime: boolean;
  allDay: boolean;
}): string {
  if (input.missingDate && (input.missingTime || input.allDay)) {
    return 'I can add that, but I still need the date.';
  }
  if (input.missingDate) {
    return 'I can add that, but I still need the date.';
  }
  if (input.missingTime && !input.allDay) {
    return 'I can add that. What time should it start? You can also say "all day" if that is what you mean.';
  }
  return 'I can add that, but I still need a little more detail.';
}

function maybeMatchCalendarFromMessage(
  message: string,
  calendars: GoogleCalendarMetadata[],
): GoogleCalendarMetadata | null {
  const normalized = collapseWhitespace(message).toLowerCase();
  const primaryCalendar = calendars.find((calendar) => calendar.primary);
  if (
    primaryCalendar &&
    /\b(?:my|the)?\s*(?:main|primary)\s+calendar\b/.test(normalized)
  ) {
    return primaryCalendar;
  }
  const sorted = [...calendars].sort(
    (left, right) => right.summary.length - left.summary.length,
  );

  for (const calendar of sorted) {
    const summary = calendar.summary.trim().toLowerCase();
    if (!summary) continue;
    if (
      normalized.includes(`${summary} calendar`) ||
      normalized.includes(`to ${summary}`) ||
      normalized.includes(`on ${summary}`) ||
      normalized.includes(`in ${summary}`)
    ) {
      return calendar;
    }
  }

  return null;
}

function stripCreatePhrases(
  working: string,
  matchedDateText: string | null,
  matchedTimeText: string | null,
  matchedCalendarSummary: string | null,
): string {
  let next = working;
  if (matchedDateText) {
    next = next.replace(new RegExp(escapeRegex(matchedDateText), 'i'), ' ');
  }
  if (matchedTimeText) {
    next = next.replace(new RegExp(escapeRegex(matchedTimeText), 'i'), ' ');
  }
  if (matchedCalendarSummary) {
    next = next.replace(
      new RegExp(
        `\\b(?:to|on|in)?\\s*(?:the\\s+|my\\s+)?${escapeRegex(
          matchedCalendarSummary,
        )}(?:'s)?\\s+calendar\\b`,
        'i',
      ),
      ' ',
    );
  }

  next = next
    .replace(
      /\b(?:to|on|in)\s+(?:the\s+|my\s+)?(?:[\w.&-]+\s+){0,3}[\w.&-]+'s\s+calendar\b/gi,
      ' ',
    )
    .replace(
      /\b(?:to|on|in)\s+(?:the\s+|my\s+)?(?:main|primary)\s+calendar\b/gi,
      ' ',
    )
    .replace(/\b(?:to|on|in)\s+(?:my\s+)?calendar\b/gi, ' ')
    .replace(/\b(?:please\s+)?(?:add|put|create|schedule)\b/gi, ' ')
    .replace(/\b(?:an?\s+)?event\b/gi, ' ')
    .replace(/\b(?:called|named|for)\b/gi, ' ')
    .replace(ALL_DAY_PATTERN, ' ')
    .replace(/\s[-,:;]+\s/g, ' ');

  const collapsed = collapseWhitespace(next.replace(/^["']|["']$/g, ''));
  return collapsed
    .replace(/^(?:an?\s+)+/i, '')
    .replace(/^(?:that|it)\b/i, '')
    .replace(/\s+\bon\b$/i, '')
    .trim();
}

function formatDraftWhen(
  draft: GoogleCalendarCreateDraft,
  timeZone: string,
): string {
  if (draft.allDay) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(draft.startIso));
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dateFormatter.format(new Date(draft.startIso))}, ${timeFormatter.format(new Date(draft.startIso))}-${timeFormatter.format(new Date(draft.endIso))}`;
}

function formatCalendarChoice(
  calendar: { summary: string; primary: boolean },
  index?: number,
): string {
  const prefix = index ? `${index}. ` : '';
  return `${prefix}${calendar.summary}${calendar.primary ? ' (primary)' : ''}`;
}

function formatConflictSuggestion(
  suggestion: GoogleCalendarSlotSuggestion,
  timeZone: string,
): string {
  const draft: GoogleCalendarCreateDraft = {
    title: '',
    startIso: suggestion.startIso,
    endIso: suggestion.endIso,
    allDay: false,
    timeZone,
  };
  return formatDraftWhen(draft, timeZone);
}

function buildDraftAwaitingTime(input: {
  title: string;
  date: Date;
  timeZone: string;
  durationMinutes: number;
  selectedCalendarId: string | null;
  writableCalendars: GoogleCalendarMetadata[];
  location?: string | null;
  description?: string | null;
  now?: Date;
}): PendingGoogleCalendarCreateState {
  const start = startOfDay(input.date);
  const end = new Date(start.getTime() + input.durationMinutes * 60 * 1000);
  return buildPendingGoogleCalendarCreateState({
    draft: {
      title: input.title,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      allDay: false,
      timeZone: input.timeZone,
      location: input.location,
      description: input.description,
    },
    writableCalendars: input.writableCalendars,
    selectedCalendarId: input.selectedCalendarId,
    now: input.now,
  });
}

export function planGoogleCalendarCreate(
  message: string,
  writableCalendars: GoogleCalendarMetadata[],
  now = new Date(),
  timeZone = TIMEZONE,
  schedulingContext?: GoogleCalendarSchedulingContextState | null,
): GoogleCalendarCreatePlanResult {
  const normalizedMessage = normalizeMessage(message);
  if (!isExplicitGoogleCalendarCreateRequest(normalizedMessage)) {
    return { kind: 'none' };
  }

  let working = normalizedMessage.replace(/[.?!]+$/g, '');
  const locationField = extractTrailingField(working, 'location');
  working = locationField.nextWorking;
  const notesField = extractTrailingField(working, 'notes');
  working = notesField.nextWorking;
  const descriptionField = extractTrailingField(working, 'description');
  working = descriptionField.nextWorking;

  const selectedCalendar = maybeMatchCalendarFromMessage(
    working,
    writableCalendars,
  );
  const allDay = ALL_DAY_PATTERN.test(working);
  const dateInfo = parseDatePhrase(working, now);
  const timeInfo = parseTimeRange(working);
  const daypartInfo = parseDaypartPhrase(working);
  const contextDurationMinutes =
    schedulingContext && schedulingContext.timeZone === timeZone
      ? schedulingContext.durationMinutes
      : schedulingContext?.durationMinutes || null;

  if (!dateInfo) {
    return {
      kind: 'needs_details',
      message: buildMissingDetailsReply({
        missingDate: true,
        missingTime: !allDay && !timeInfo.start && !daypartInfo,
        allDay,
      }),
    };
  }

  let title = stripCreatePhrases(
    working,
    dateInfo?.matchedText || null,
    timeInfo.matchedText || daypartInfo?.matchedText || null,
    selectedCalendar?.summary || null,
  );
  if (!title && schedulingContext?.title && /\b(?:that|it)\b/i.test(working)) {
    title = schedulingContext.title;
  }
  if (!title) {
      return {
        kind: 'needs_details',
        message: /\b(?:that|it)\b/i.test(working)
          ? 'What should I put on your calendar?'
          : 'I can add that, but I still need a title.',
      };
  }

  if (!allDay && !timeInfo.start && !daypartInfo) {
    return {
      kind: 'needs_details',
      message: buildMissingDetailsReply({
        missingDate: false,
        missingTime: true,
        allDay,
      }),
      pendingState: buildDraftAwaitingTime({
        title,
        date: dateInfo.date,
        timeZone,
        durationMinutes: contextDurationMinutes || 60,
        selectedCalendarId: selectedCalendar?.id || null,
        writableCalendars,
        location: locationField.value,
        description: notesField.value || descriptionField.value,
        now,
      }),
    };
  }

  let start = startOfDay(dateInfo.date);
  let end = addDays(start, 1);

  if (!allDay && timeInfo.start) {
    start = setLocalTime(
      dateInfo.date,
      timeInfo.start.hours,
      timeInfo.start.minutes,
    );
    if (timeInfo.end) {
      end = setLocalTime(
        dateInfo.date,
        timeInfo.end.hours,
        timeInfo.end.minutes,
      );
      if (end <= start) {
        end = addDays(end, 1);
      }
    } else {
      const durationMinutes = contextDurationMinutes || 60;
      end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    }
  } else if (!allDay && daypartInfo) {
    const range = DAYPART_RANGES[daypartInfo.name];
    start = setLocalTime(dateInfo.date, range.startHour);
    const durationMinutes = contextDurationMinutes || 60;
    end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  }

  return {
    kind: 'draft',
    draft: {
      title,
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      allDay,
      timeZone,
      location: locationField.value,
      description: notesField.value || descriptionField.value,
    },
    selectedCalendarId: selectedCalendar?.id || null,
  };
}

export function buildPendingGoogleCalendarCreateState(input: {
  draft: GoogleCalendarCreateDraft;
  writableCalendars: GoogleCalendarMetadata[];
  selectedCalendarId: string | null;
  now?: Date;
}): PendingGoogleCalendarCreateState {
  const calendars = input.writableCalendars.map((calendar) => ({
    id: calendar.id,
    summary: calendar.summary,
    primary: calendar.primary,
  }));
  const selectedCalendarId =
    input.selectedCalendarId ||
    (calendars.length === 1 ? calendars[0].id : null);

  return {
    version: 2,
    createdAt: (input.now || new Date()).toISOString(),
    step: selectedCalendarId ? 'confirm_create' : 'choose_calendar',
    draft: input.draft,
    calendars,
    selectedCalendarId,
    conflictSummary: null,
  };
}

export function buildGoogleCalendarSchedulingContextState(input: {
  draft: GoogleCalendarCreateDraft;
  now?: Date;
}): GoogleCalendarSchedulingContextState | null {
  if (input.draft.allDay) {
    return null;
  }
  return {
    version: 1,
    createdAt: (input.now || new Date()).toISOString(),
    title: input.draft.title,
    durationMinutes: getDraftDurationMinutes(input.draft),
    timeZone: input.draft.timeZone,
  };
}

export function isGoogleCalendarSchedulingContextExpired(
  state: GoogleCalendarSchedulingContextState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

export function isPendingGoogleCalendarCreateExpired(
  state: PendingGoogleCalendarCreateState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

function resolvePendingGoogleCalendarCreateReferenceNow(
  state: PendingGoogleCalendarCreateState,
  now?: Date,
): Date {
  if (now) {
    return now;
  }
  const createdAt = new Date(state.createdAt);
  return Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;
}

export function formatGoogleCalendarCreatePrompt(
  state: PendingGoogleCalendarCreateState,
): string {
  if (state.step === 'choose_calendar') {
    return formatVoiceChoicePrompt({
      question: 'Which calendar should I use?',
      choices: state.calendars.map((calendar) =>
        formatCalendarChoice(calendar),
      ),
      directForTwo: state.calendars.length === 2,
      prefixForTwo: `Should I create "${state.draft.title}" on`,
      replyHint:
        state.calendars.length === 2
          ? null
          : 'Say the number or calendar name.',
    });
  }

  const selectedCalendar = state.calendars.find(
    (calendar) => calendar.id === state.selectedCalendarId,
  );

  return [
    ...(state.conflictSummary?.blockingEvents.length
      ? [
          'That time conflicts with:',
          ...state.conflictSummary.blockingEvents.map(
            (event) =>
              `- ${
                event.allDay
                  ? 'All day'
                  : `${formatDraftWhen(
                      {
                        title: event.title,
                        startIso: event.startIso,
                        endIso: event.endIso,
                        allDay: event.allDay,
                        timeZone: state.draft.timeZone,
                      },
                      state.draft.timeZone,
                    )}`
              } ${event.title}${event.calendarName ? ` [${event.calendarName}]` : ''}`,
          ),
          ...(state.conflictSummary.suggestions.length > 0
            ? [
                '',
                'You could also use:',
                ...state.conflictSummary.suggestions.map(
                  (suggestion, index) =>
                    `- ${index + 1}. ${formatConflictSuggestion(
                      suggestion,
                      state.draft.timeZone,
                    )}`,
                ),
              ]
            : []),
          '',
        ]
      : []),
    ...(state.conflictSummary?.warningMessage
      ? [state.conflictSummary.warningMessage, '']
      : []),
    'Ready to create this Google Calendar event:',
    `- Title: ${state.draft.title}`,
    `- When: ${state.draft.allDay ? `All day on ${formatDraftWhen(state.draft, state.draft.timeZone)}` : formatDraftWhen(state.draft, state.draft.timeZone)}`,
    `- Calendar: ${selectedCalendar?.summary || 'Unknown calendar'}`,
    ...(state.draft.location ? [`- Location: ${state.draft.location}`] : []),
    ...(state.draft.description ? [`- Notes: ${state.draft.description}`] : []),
    '',
    state.conflictSummary?.blockingEvents.length
      ? 'Reply "yes" to create it anyway, choose a suggestion number, or say "cancel".'
      : 'Reply "yes" to create it or "cancel" to stop.',
  ].join('\n');
}

function matchCalendarSelection(
  message: string,
  calendars: PendingGoogleCalendarCreateState['calendars'],
): { id: string; summary: string; primary: boolean } | null {
  const normalized = collapseWhitespace(message).toLowerCase();
  if (!normalized) return null;

  const primaryCalendar = calendars.find((calendar) => calendar.primary);
  if (
    primaryCalendar &&
    /\b(?:my|the)?\s*(?:main|primary)\s+calendar\b/.test(normalized)
  ) {
    return primaryCalendar;
  }

  const numeric = normalized.match(/\b(\d{1,2})\b/);
  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return calendars[index] || null;
  }

  for (const calendar of calendars) {
    const summary = calendar.summary.trim().toLowerCase();
    if (!summary) continue;
    if (
      normalized === summary ||
      normalized === `${summary} calendar` ||
      normalized.includes(summary)
    ) {
      return calendar;
    }
  }

  return null;
}

function cloneDraftWithTiming(
  draft: GoogleCalendarCreateDraft,
  start: Date,
  end: Date,
  allDay = draft.allDay,
): GoogleCalendarCreateDraft {
  return {
    ...draft,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    allDay,
  };
}

function parsePendingDraftAdjustment(
  message: string,
  state: PendingGoogleCalendarCreateState,
  now = new Date(),
): GoogleCalendarCreateDraft | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

  const draftStart = new Date(state.draft.startIso);
  const durationMinutes = getDraftDurationMinutes(state.draft);
  const working = normalized.replace(/[.?!]+$/g, '');
  const dateInfo = parseDatePhrase(working, now);
  const timeInfo = parseTimeRange(working);
  const daypartInfo = parseDaypartPhrase(working);
  const allDay = ALL_DAY_PATTERN.test(working);

  if (
    !looksLikePendingDraftAdjustmentMessage({
      working,
      dateInfo,
      timeInfo,
      daypartInfo,
      allDay,
    })
  ) {
    return null;
  }

  const targetDate = dateInfo ? dateInfo.date : startOfDay(draftStart);
  if (allDay) {
    const start = startOfDay(targetDate);
    const end = addDays(start, 1);
    return cloneDraftWithTiming(state.draft, start, end, true);
  }

  let start: Date;
  let end: Date;
  if (timeInfo.start) {
    start = setLocalTime(
      targetDate,
      timeInfo.start.hours,
      timeInfo.start.minutes,
    );
    if (timeInfo.end) {
      end = setLocalTime(targetDate, timeInfo.end.hours, timeInfo.end.minutes);
      if (end <= start) {
        end = addDays(end, 1);
      }
    } else {
      end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    }
    return cloneDraftWithTiming(state.draft, start, end, false);
  }

  if (daypartInfo) {
    const range = DAYPART_RANGES[daypartInfo.name];
    start = setLocalTime(targetDate, range.startHour);
    end = new Date(start.getTime() + durationMinutes * 60 * 1000);
    return cloneDraftWithTiming(state.draft, start, end, false);
  }

  start = setLocalTime(
    targetDate,
    draftStart.getHours(),
    draftStart.getMinutes(),
    draftStart.getSeconds(),
  );
  end = new Date(start.getTime() + durationMinutes * 60 * 1000);
  return cloneDraftWithTiming(state.draft, start, end, false);
}

function looksLikePendingDraftAdjustmentMessage(input: {
  working: string;
  dateInfo: { date: Date; matchedText: string } | null;
  timeInfo: {
    start: { hours: number; minutes: number; displayLabel: string } | null;
    end: { hours: number; minutes: number; displayLabel: string } | null;
    matchedText: string | null;
  };
  daypartInfo: { name: keyof typeof DAYPART_RANGES; matchedText: string } | null;
  allDay: boolean;
}): boolean {
  if (
    !input.dateInfo &&
    !input.timeInfo.start &&
    !input.daypartInfo &&
    !input.allDay
  ) {
    return false;
  }

  let residual = input.working;
  const stripLiteral = (value: string | null | undefined): void => {
    if (!value) return;
    residual = collapseWhitespace(
      residual.replace(new RegExp(escapeRegex(value), 'i'), ' '),
    );
  };

  stripLiteral(input.dateInfo?.matchedText);
  stripLiteral(input.timeInfo.matchedText);
  stripLiteral(input.daypartInfo?.matchedText);
  if (input.allDay) {
    residual = collapseWhitespace(residual.replace(ALL_DAY_PATTERN, ' '));
  }
  residual = collapseWhitespace(
    residual.replace(
      /\b(?:on|to|in)\s+(?:my\s+|the\s+)?(?:main|primary)\s+calendar\b/gi,
      ' ',
    ),
  );
  residual = collapseWhitespace(
    residual.replace(/\b(?:main|primary)\s+calendar\b/gi, ' '),
  );

  residual = collapseWhitespace(
    residual.replace(
      /^(?:(?:please|move|put|set|make|change|shift|start(?:\s+time)?(?:\s+is)?|it(?:\s+starts?)?|this|that|it|for|on|to|at|from|after|around|instead|calendar|my|the|event)\b[\s,.-]*)+/i,
      '',
    ),
  );

  return residual.length === 0;
}

function parseAfterAnchorRequest(
  message: string,
  state: PendingGoogleCalendarCreateState,
  now = new Date(),
): {
  anchorTime: { hours: number; minutes: number; displayLabel: string };
  anchorDate: Date;
} | null {
  const normalized = normalizeMessage(message);
  if (!normalized) return null;

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
      : startOfDay(new Date(state.draft.startIso)),
  };
}

export function advancePendingGoogleCalendarCreate(
  message: string,
  state: PendingGoogleCalendarCreateState,
): PendingGoogleCalendarCreateResult {
  const normalized = normalizeMessage(message);
  const referenceNow = resolvePendingGoogleCalendarCreateReferenceNow(state);
  if (!normalized) {
    return { kind: 'no_match' };
  }

  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'cancelled',
      message: 'Okay, I won’t create that calendar event.',
    };
  }

  if (state.step === 'choose_calendar') {
    const selection = matchCalendarSelection(normalized, state.calendars);
    const adjustedDraft = parsePendingDraftAdjustment(
      normalized,
      state,
      referenceNow,
    );
    if (!selection && !adjustedDraft) {
      return { kind: 'no_match' };
    }

    const nextState: PendingGoogleCalendarCreateState = {
      ...state,
      step: selection?.id || state.selectedCalendarId ? 'confirm_create' : 'choose_calendar',
      draft: adjustedDraft || state.draft,
      selectedCalendarId: selection?.id || state.selectedCalendarId,
      conflictSummary: null,
    };

    return {
      kind: 'awaiting_input',
      state: nextState,
      message: formatGoogleCalendarCreatePrompt(nextState),
    };
  }

  if (state.conflictSummary?.suggestions.length) {
    const numeric = normalized.match(/\b(\d{1,2})\b/);
    if (numeric) {
      const suggestionIndex = Number(numeric[1]) - 1;
      const suggestion = state.conflictSummary.suggestions[suggestionIndex];
      if (suggestion) {
        const nextState: PendingGoogleCalendarCreateState = {
          ...state,
          draft: cloneDraftWithTiming(
            state.draft,
            new Date(suggestion.startIso),
            new Date(suggestion.endIso),
            false,
          ),
          conflictSummary: null,
        };
        return {
          kind: 'awaiting_input',
          state: nextState,
          message: formatGoogleCalendarCreatePrompt(nextState),
        };
      }
    }
  }

  if (state.calendars.length > 1) {
    const selection = matchCalendarSelection(normalized, state.calendars);
    if (selection && selection.id !== state.selectedCalendarId) {
      const nextState: PendingGoogleCalendarCreateState = {
        ...state,
        selectedCalendarId: selection.id,
        conflictSummary: null,
      };
      return {
        kind: 'awaiting_input',
        state: nextState,
        message: formatGoogleCalendarCreatePrompt(nextState),
      };
    }
  }

  if (!state.selectedCalendarId) {
    return {
      kind: 'awaiting_input',
      state: {
        ...state,
        step: 'choose_calendar',
      },
      message: formatGoogleCalendarCreatePrompt({
        ...state,
        step: 'choose_calendar',
      }),
    };
  }

  const anchorRequest = parseAfterAnchorRequest(
    normalized,
    state,
    referenceNow,
  );
  if (anchorRequest) {
    return {
      kind: 'resolve_anchor',
      state,
      anchorTime: anchorRequest.anchorTime,
      anchorDate: anchorRequest.anchorDate,
    };
  }

  const adjustedDraft = parsePendingDraftAdjustment(
    normalized,
    state,
    referenceNow,
  );
  if (adjustedDraft) {
    const nextState: PendingGoogleCalendarCreateState = {
      ...state,
      draft: adjustedDraft,
      conflictSummary: null,
    };
    return {
      kind: 'awaiting_input',
      state: nextState,
      message: formatGoogleCalendarCreatePrompt(nextState),
    };
  }

  if (!CONFIRM_PATTERN.test(normalized)) {
    return { kind: 'no_match' };
  }

  return {
    kind: 'confirmed',
    state,
    calendarId: state.selectedCalendarId,
  };
}
