import { TIMEZONE } from './config.js';
import type { GoogleCalendarMetadata } from './google-calendar.js';

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

const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;
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

export interface PendingGoogleCalendarCreateState {
  version: 1;
  createdAt: string;
  step: 'choose_calendar' | 'confirm_create';
  draft: GoogleCalendarCreateDraft;
  calendars: Array<{
    id: string;
    summary: string;
    primary: boolean;
  }>;
  selectedCalendarId: string | null;
}

export type GoogleCalendarCreatePlanResult =
  | { kind: 'none' }
  | { kind: 'needs_details'; message: string }
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
  const rawHour = Number(hoursText);
  const minutes = minutesText ? Number(minutesText) : 0;
  const normalizedMeridiem = meridiem?.toLowerCase() ?? null;

  if (!Number.isInteger(rawHour) || rawHour < 1 || rawHour > 12) {
    return null;
  }
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    return null;
  }

  const hours =
    rawHour === 12
      ? normalizedMeridiem === 'am'
        ? 0
        : 12
      : normalizedMeridiem === 'pm'
        ? rawHour + 12
        : rawHour;

  return {
    hours,
    minutes,
    displayLabel: formatClockLabel(hours, minutes),
  };
}

function parseTimeRange(working: string): {
  start: { hours: number; minutes: number; displayLabel: string } | null;
  end: { hours: number; minutes: number; displayLabel: string } | null;
  matchedText: string | null;
} {
  const explicitRange = working.match(
    /\b(?:from\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:-|to|until|til)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
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
    /\b(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  );
  if (!startOnly) {
    return {
      start: null,
      end: null,
      matchedText: null,
    };
  }

  return {
    start: parseClockPart(startOnly[1], startOnly[2], startOnly[3]),
    end: null,
    matchedText: startOnly[0],
  };
}

function looksLikeExplicitCalendarCreate(normalized: string): boolean {
  return (
    /\b(?:add|put)\b[\s\S]{0,140}\b(?:to|on|in)\b[\s\S]{0,60}\bcalendar\b/.test(
      normalized,
    ) ||
    /\bcreate\b[\s\S]{0,50}\bevent\b/.test(normalized) ||
    /\bschedule\b[\s\S]{0,80}\b(?:event|calendar)\b/.test(normalized)
  );
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
    return 'I can create that as a calendar event, but I still need the date.';
  }
  if (input.missingDate) {
    return 'I can create that as a calendar event, but I still need the date.';
  }
  if (input.missingTime && !input.allDay) {
    return 'I can create that as a calendar event, but I still need the start time. You can also say "all day" if that is what you mean.';
  }
  return 'I can create that as a calendar event, but I still need a bit more detail.';
}

function maybeMatchCalendarFromMessage(
  message: string,
  calendars: GoogleCalendarMetadata[],
): GoogleCalendarMetadata | null {
  const normalized = collapseWhitespace(message).toLowerCase();
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
        )}\\s+calendar\\b`,
        'i',
      ),
      ' ',
    );
  }

  next = next
    .replace(/\b(?:to|on|in)\s+(?:my\s+)?calendar\b/gi, ' ')
    .replace(/\b(?:please\s+)?(?:add|put|create|schedule)\b/gi, ' ')
    .replace(/\b(?:an?\s+)?event\b/gi, ' ')
    .replace(/\b(?:called|named|for)\b/gi, ' ')
    .replace(ALL_DAY_PATTERN, ' ')
    .replace(/\s[-,:;]+\s/g, ' ');

  const collapsed = collapseWhitespace(next.replace(/^["']|["']$/g, ''));
  return collapsed
    .replace(/^(?:an?\s+)+/i, '')
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

export function planGoogleCalendarCreate(
  message: string,
  writableCalendars: GoogleCalendarMetadata[],
  now = new Date(),
  timeZone = TIMEZONE,
): GoogleCalendarCreatePlanResult {
  const normalizedMessage = normalizeMessage(message);
  const normalizedLower = normalizedMessage.toLowerCase();
  if (!normalizedLower || !looksLikeExplicitCalendarCreate(normalizedLower)) {
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

  if (!dateInfo || (!allDay && !timeInfo.start)) {
    return {
      kind: 'needs_details',
      message: buildMissingDetailsReply({
        missingDate: !dateInfo,
        missingTime: !timeInfo.start,
        allDay,
      }),
    };
  }

  const title = stripCreatePhrases(
    working,
    dateInfo?.matchedText || null,
    timeInfo.matchedText,
    selectedCalendar?.summary || null,
  );
  if (!title) {
    return {
      kind: 'needs_details',
      message:
        'I can create that as a calendar event, but I still need a title.',
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
      end = new Date(start.getTime() + 60 * 60 * 1000);
    }
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
    version: 1,
    createdAt: (input.now || new Date()).toISOString(),
    step: selectedCalendarId ? 'confirm_create' : 'choose_calendar',
    draft: input.draft,
    calendars,
    selectedCalendarId,
  };
}

export function isPendingGoogleCalendarCreateExpired(
  state: PendingGoogleCalendarCreateState,
  now = new Date(),
): boolean {
  const createdAt = new Date(state.createdAt).getTime();
  if (Number.isNaN(createdAt)) return true;
  return now.getTime() - createdAt > DEFAULT_CONFIRMATION_TTL_MS;
}

export function formatGoogleCalendarCreatePrompt(
  state: PendingGoogleCalendarCreateState,
): string {
  if (state.step === 'choose_calendar') {
    return [
      `I'm ready to create "${state.draft.title}" for ${formatDraftWhen(
        state.draft,
        state.draft.timeZone,
      )}.`,
      '',
      'Which calendar should I use?',
      ...state.calendars.map(
        (calendar, index) => `- ${formatCalendarChoice(calendar, index + 1)}`,
      ),
      '',
      'Reply with a number or calendar name.',
    ].join('\n');
  }

  const selectedCalendar = state.calendars.find(
    (calendar) => calendar.id === state.selectedCalendarId,
  );

  return [
    'Ready to create this Google Calendar event:',
    `- Title: ${state.draft.title}`,
    `- When: ${state.draft.allDay ? `All day on ${formatDraftWhen(state.draft, state.draft.timeZone)}` : formatDraftWhen(state.draft, state.draft.timeZone)}`,
    `- Calendar: ${selectedCalendar?.summary || 'Unknown calendar'}`,
    ...(state.draft.location ? [`- Location: ${state.draft.location}`] : []),
    ...(state.draft.description ? [`- Notes: ${state.draft.description}`] : []),
    '',
    'Reply "yes" to create it or "cancel" to stop.',
  ].join('\n');
}

function matchCalendarSelection(
  message: string,
  calendars: PendingGoogleCalendarCreateState['calendars'],
): { id: string; summary: string; primary: boolean } | null {
  const normalized = collapseWhitespace(message).toLowerCase();
  if (!normalized) return null;

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

export function advancePendingGoogleCalendarCreate(
  message: string,
  state: PendingGoogleCalendarCreateState,
): PendingGoogleCalendarCreateResult {
  const normalized = normalizeMessage(message);
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
    if (!selection) {
      return { kind: 'no_match' };
    }

    const nextState: PendingGoogleCalendarCreateState = {
      ...state,
      step: 'confirm_create',
      selectedCalendarId: selection.id,
    };

    return {
      kind: 'awaiting_input',
      state: nextState,
      message: formatGoogleCalendarCreatePrompt(nextState),
    };
  }

  if (state.calendars.length > 1) {
    const selection = matchCalendarSelection(normalized, state.calendars);
    if (selection && selection.id !== state.selectedCalendarId) {
      const nextState: PendingGoogleCalendarCreateState = {
        ...state,
        selectedCalendarId: selection.id,
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

  if (!CONFIRM_PATTERN.test(normalized)) {
    return { kind: 'no_match' };
  }

  return {
    kind: 'confirmed',
    state,
    calendarId: state.selectedCalendarId,
  };
}
