import { spawn } from 'child_process';

import { TIMEZONE } from './config.js';
import { readEnvFile } from './env.js';
import {
  listGoogleCalendarEvents,
  listGoogleCalendars,
  type GoogleCalendarMetadata,
  resolveGoogleCalendarConfig,
} from './google-calendar.js';

const CALENDAR_ENV_KEYS = [
  'APPLE_CALENDAR_LOCAL_ENABLED',
  'APPLE_CALDAV_URL',
  'APPLE_CALDAV_USERNAME',
  'APPLE_CALDAV_PASSWORD',
  'APPLE_CALDAV_CALENDAR_URLS',
  'GOOGLE_CALENDAR_ACCESS_TOKEN',
  'GOOGLE_CALENDAR_REFRESH_TOKEN',
  'GOOGLE_CALENDAR_CLIENT_ID',
  'GOOGLE_CALENDAR_CLIENT_SECRET',
  'GOOGLE_CALENDAR_IDS',
  'OUTLOOK_CALENDAR_ACCESS_TOKEN',
  'OUTLOOK_CALENDAR_REFRESH_TOKEN',
  'OUTLOOK_CALENDAR_CLIENT_ID',
  'OUTLOOK_CALENDAR_CLIENT_SECRET',
  'OUTLOOK_CALENDAR_TENANT_ID',
  'OUTLOOK_CALENDAR_USER_ID',
] as const;

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

type FetchLike = typeof fetch;
type CalendarIntent = 'agenda' | 'availability';
type CalendarProviderId =
  | 'apple_local'
  | 'apple_caldav'
  | 'google_calendar'
  | 'outlook';
type CalendarProviderState = 'ready' | 'not_configured' | 'error';
type CalendarAwarenessKind =
  | 'none'
  | 'coming_up_soon'
  | 'rest_of_day'
  | 'morning_brief';
type CalendarReasoningMode =
  | 'agenda'
  | 'agenda_briefing_day'
  | 'agenda_briefing_week'
  | 'agenda_next'
  | 'availability_point'
  | 'availability_range'
  | 'availability_duration'
  | 'availability_back_to_back'
  | 'availability_open_windows'
  | 'availability_conflicts';

interface CalendarScopeFilter {
  kind: 'family_shared' | 'person_shared';
  label: string;
  terms: string[];
}

export interface CalendarActiveEventContext {
  providerId: CalendarProviderId;
  id: string;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  calendarId?: string | null;
  calendarName?: string | null;
  htmlLink?: string | null;
}

export interface PlannedCalendarLookup {
  intent: CalendarIntent;
  start: Date;
  end: Date;
  label: string;
  timeZone: string;
  pointInTime: Date | null;
  durationMinutes: number | null;
  durationLabel: string | null;
  reasoningMode: CalendarReasoningMode;
  clarificationQuestion: string | null;
  requestedTitle: string | null;
  minimumOpenMinutes: number | null;
  nextTimedOnly: boolean;
  scopeFilter: CalendarScopeFilter | null;
  subjectLabel: string | null;
  forceIncludeCalendarNames: boolean;
  awarenessKind: CalendarAwarenessKind;
  lookaheadMinutes: number | null;
}

export interface CalendarEvent {
  id: string;
  providerId: CalendarProviderId;
  providerLabel: string;
  title: string;
  startIso: string;
  endIso: string;
  allDay: boolean;
  calendarId?: string | null;
  calendarName?: string | null;
  location?: string | null;
  htmlLink?: string | null;
}

export interface CalendarProviderStatus {
  id: CalendarProviderId;
  label: string;
  state: CalendarProviderState;
  detail: string;
  configured: boolean;
  complete: boolean;
}

export interface CalendarLookupResult {
  plan: PlannedCalendarLookup;
  events: CalendarEvent[];
  statuses: CalendarProviderStatus[];
  scopeResolutionMessage: string | null;
  matchedScopeCalendars: string[];
}

export interface CalendarSchedulingContext {
  title: string;
  durationMinutes: number;
  timeZone: string;
}

export interface CalendarAssistantResponse {
  reply: string;
  schedulingContext: CalendarSchedulingContext | null;
  activeEventContext: CalendarActiveEventContext | null;
}

export interface CalendarTimeWindow {
  start: Date;
  end: Date;
}

export interface CalendarLookupSnapshot {
  unavailableReply: string | null;
  fullyConfirmed: boolean;
  incompleteNoteBody: string;
  timedEvents: CalendarEvent[];
  allDayEvents: CalendarEvent[];
  nextTimedEvent: CalendarEvent | null;
  activeAllDayEvents: CalendarEvent[];
  openWindows: CalendarTimeWindow[];
  conflictGroups: CalendarEvent[][];
  adjacencyClusters: CalendarEvent[][];
  densityLine: string | null;
}

interface CalendarAssistantConfig {
  appleLocalEnabled: boolean;
  appleCalDavUrl: string | null;
  appleCalDavUsername: string | null;
  appleCalDavPassword: string | null;
  appleCalDavCalendarUrls: string[];
  googleAccessToken: string | null;
  googleRefreshToken: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  googleCalendarIds: string[];
  outlookAccessToken: string | null;
  outlookRefreshToken: string | null;
  outlookClientId: string | null;
  outlookClientSecret: string | null;
  outlookTenantId: string;
  outlookUserId: string;
}

interface CalendarAssistantDeps {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  platform?: NodeJS.Platform;
  activeEventContext?: CalendarActiveEventContext | null;
  runAppleCalendarScript?: (
    startIso: string,
    endIso: string,
  ) => Promise<string>;
}

interface CalendarProviderResult {
  events: CalendarEvent[];
  status: CalendarProviderStatus;
}

interface ParsedIcsDate {
  iso: string | null;
  allDay: boolean;
}

interface ParsedClockTime {
  hours: number;
  minutes: number;
  displayLabel: string;
}

interface ParsedDuration {
  minutes: number;
  label: string;
  requestedTitle: string | null;
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

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date): Date {
  return addDays(startOfDay(date), 1);
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

function parseClockTime(normalized: string): ParsedClockTime | null {
  const match = normalized.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return null;

  const rawHour = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase() ?? null;
  if (!Number.isInteger(rawHour) || !Number.isInteger(minutes)) {
    return null;
  }
  if (minutes < 0 || minutes > 59) {
    return null;
  }

  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) {
      return null;
    }
    const normalizedHour =
      rawHour === 12
        ? meridiem === 'am'
          ? 0
          : 12
        : meridiem === 'pm'
          ? rawHour + 12
          : rawHour;
    return {
      hours: normalizedHour,
      minutes,
      displayLabel: formatClockLabel(normalizedHour, minutes),
    };
  }

  const inferredHour = inferClockHourWithoutMeridiem(rawHour);
  if (inferredHour === null) {
    return null;
  }

  return {
    hours: inferredHour,
    minutes,
    displayLabel: formatClockLabel(inferredHour, minutes),
  };
}

function parseDurationRequest(normalized: string): ParsedDuration | null {
  const hyphenHourMatch = normalized.match(
    /\bfor\s+(?:a\s+)?one-hour\b([\s\S]*?)(?:[?.!]|$)/i,
  );
  if (hyphenHourMatch) {
    return {
      minutes: 60,
      label: '1 hour',
      requestedTitle: inferRequestedTitle(hyphenHourMatch[1] || normalized),
    };
  }

  const hourMatch = normalized.match(
    /\bfor\s+(?:(an?|one)\s+hour|(\d+(?:\.\d+)?)\s*(hours?|hrs?))\b([\s\S]*?)(?:[?.!]|$)/i,
  );
  if (hourMatch) {
    const numericHours = hourMatch[2] ? Number(hourMatch[2]) : 1;
    if (Number.isFinite(numericHours) && numericHours > 0) {
      return {
        minutes: Math.round(numericHours * 60),
        label: numericHours === 1 ? '1 hour' : `${numericHours} hours`,
        requestedTitle: inferRequestedTitle(hourMatch[4] || normalized),
      };
    }
  }

  const minuteMatch = normalized.match(
    /\bfor\s+(\d{1,3})\s*(minutes?|mins?)\b([\s\S]*?)(?:[?.!]|$)/i,
  );
  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    if (Number.isFinite(minutes) && minutes > 0) {
      return {
        minutes,
        label: `${minutes} minutes`,
        requestedTitle: inferRequestedTitle(minuteMatch[3] || normalized),
      };
    }
  }

  return null;
}

function inferRequestedTitle(raw: string): string | null {
  const normalized = raw
    .replace(/[?.!]+$/g, '')
    .replace(
      /\b(?:for|a|an|the|my|our|that|this|at|on|in|to|tomorrow|today|friday|monday|tuesday|wednesday|thursday|saturday|sunday|afternoon|morning|evening|tonight|meeting|meetings)\b/gi,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (/\bmeeting\b/i.test(raw)) return 'meeting';
  if (/\bcall\b/i.test(raw)) return 'call';
  if (/\bappointment\b/i.test(raw)) return 'appointment';
  if (/\bsync\b/i.test(raw)) return 'sync';
  if (/\bevent\b/i.test(raw)) return 'event';
  return normalized || null;
}

function resolveNextWeekdayRange(
  weekdayName: string,
  now: Date,
): { start: Date; end: Date; label: string } {
  const base = startOfDay(now);
  const targetDay = WEEKDAY_INDEX[weekdayName];
  let offset = (targetDay - base.getDay() + 7) % 7;
  if (offset === 0) {
    offset = 7;
  }
  const start = addDays(base, offset);
  return {
    start,
    end: addDays(start, 1),
    label: weekdayName[0].toUpperCase() + weekdayName.slice(1),
  };
}

function resolveUpcomingRange(
  now: Date,
  days: number,
  label: string,
): { start: Date; end: Date; label: string } {
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  return { start, end, label };
}

function resolveUpcomingMinutesRange(
  now: Date,
  minutes: number,
  label: string,
): { start: Date; end: Date; label: string } {
  const start = new Date(now);
  const end = new Date(now.getTime() + minutes * 60 * 1000);
  return { start, end, label };
}

function resolveRemainingDayRange(now: Date): {
  start: Date;
  end: Date;
  label: string;
} {
  return {
    start: new Date(now),
    end: endOfDay(now),
    label: 'the rest of today',
  };
}

function resolveWeekRange(
  now: Date,
  nextWeek: boolean,
): { start: Date; end: Date; label: string } {
  const base = startOfDay(now);
  const day = base.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const thisMonday = addDays(base, mondayOffset);
  const start = nextWeek ? addDays(thisMonday, 7) : base;
  const end = addDays(nextWeek ? start : thisMonday, 7);
  return {
    start,
    end,
    label: nextWeek ? 'next week' : 'this week',
  };
}

function resolveWeekendRange(now: Date): {
  start: Date;
  end: Date;
  label: string;
} {
  const base = startOfDay(now);
  const saturdayOffset = (6 - base.getDay() + 7) % 7;
  const start = addDays(base, saturdayOffset);
  return {
    start,
    end: addDays(start, 2),
    label: 'the weekend',
  };
}

function resolveLookupRange(
  normalized: string,
  now: Date,
): { start: Date; end: Date; label: string } {
  const base = startOfDay(now);

  if (/\bnext week\b/.test(normalized)) {
    return resolveWeekRange(now, true);
  }

  if (/\bthis week\b/.test(normalized)) {
    return resolveWeekRange(now, false);
  }

  if (/\b(?:this )?weekend\b/.test(normalized)) {
    return resolveWeekendRange(now);
  }

  for (const weekday of Object.keys(WEEKDAY_INDEX)) {
    const pattern = new RegExp(`\\b${weekday}\\b`);
    if (pattern.test(normalized)) {
      return resolveNextWeekdayRange(weekday, now);
    }
  }

  let start = base;
  let end = addDays(base, 1);
  let label = 'today';

  if (/\btomorrow\b/.test(normalized)) {
    start = addDays(base, 1);
    end = addDays(start, 1);
    label = 'tomorrow';
  }

  for (const [daypart, range] of Object.entries(DAYPART_RANGES)) {
    const pattern = new RegExp(`\\b${daypart}\\b`);
    if (pattern.test(normalized)) {
      const daypartStart = setLocalTime(start, range.startHour);
      const daypartEnd =
        range.endHour === 24
          ? addDays(start, 1)
          : setLocalTime(start, range.endHour);
      return {
        start: daypartStart,
        end: daypartEnd,
        label: `${label} ${daypart}`,
      };
    }
  }

  return { start, end, label };
}

function hasExplicitRangeReference(normalized: string): boolean {
  return (
    /\b(?:today|tomorrow|next week|this week|weekend)\b/.test(normalized) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      normalized,
    ) ||
    /\b(?:morning|afternoon|evening|tonight)\b/.test(normalized) ||
    /\b(?:after|before)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/.test(normalized)
  );
}

function looksLikeBriefingQuery(normalized: string): boolean {
  return (
    /\bwhat(?:'s| is) my day look like\b/.test(normalized) ||
    /\bgive me (?:a )?quick schedule\b/.test(normalized) ||
    /\bgive me (?:a )?morning brief\b/.test(normalized) ||
    /\bwhat should i know about today\b/.test(normalized) ||
    /\bwhat do i need to know about\b/.test(normalized) ||
    /\b(?:what(?:'s| is)|anything)\b[\s\S]{0,40}\bimportant\b/.test(
      normalized,
    ) ||
    /\bwhat(?:'s| is)\b[\s\S]{0,40}\bcoming up\b/.test(normalized)
  );
}

function looksLikeNextAgendaQuery(normalized: string): boolean {
  return (
    /\bwhat(?:'s| is)\b[\s\S]{0,40}\bnext on my calendar\b/.test(normalized) ||
    /\bwhat(?:'s| is)\b[\s\S]{0,30}\bmy next meeting\b/.test(normalized) ||
    /\bwhat(?:'s| is)\b[\s\S]{0,20}\bnext after this\b/.test(normalized) ||
    /\bwhat do i have after this\b/.test(normalized) ||
    /\bwhat do i have coming up soon\b/.test(normalized) ||
    /\banything coming up in the next two hours\b/.test(normalized) ||
    /\bcoming up soon\b/.test(normalized) ||
    /\bnext two hours\b/.test(normalized) ||
    /\bwhat(?:'s| is)\b[\s\S]{0,40}\bcoming up this\b[\s\S]{0,20}\b(?:morning|afternoon|evening|tonight)\b/.test(
      normalized,
    )
  );
}

function looksLikeOpenWindowQuery(normalized: string): boolean {
  return (
    /\bdo i have any gaps\b/.test(normalized) ||
    /\bwhat openings do i have\b/.test(normalized) ||
    /\bwhen (?:am i|are we)\b[\s\S]{0,20}\bfree\b/.test(normalized)
  );
}

function looksLikeConflictSummaryQuery(normalized: string): boolean {
  return /\bdo i have any conflicts\b/.test(normalized);
}

function looksLikeAgendaQuery(normalized: string): boolean {
  return (
    /\bwhat(?:'s| is)\b[\s\S]{0,80}\b(calendar|schedule)\b/.test(normalized) ||
    /\bwhat does my\b[\s\S]{0,80}\blook like\b/.test(normalized) ||
    /\bwhat do i have\b/.test(normalized) ||
    /\b(?:show|check|look at|pull up|read)\b[\s\S]{0,80}\b(calendar|schedule)\b/.test(
      normalized,
    ) ||
    /\b(on my|in my)\s+(calendar|schedule)\b/.test(normalized) ||
    /\bdo i have\b[\s\S]{0,80}\b(meetings?|appointments?|events?)\b/.test(
      normalized,
    ) ||
    /\bwhat meetings do i have\b/.test(normalized)
  );
}

function looksLikeAvailabilityQuery(normalized: string): boolean {
  return (
    /\b(?:am i|are we)\b[\s\S]{0,80}\b(free|available|open)\b/.test(
      normalized,
    ) ||
    /\bdo i have time\b/.test(normalized) ||
    /\bdo i have back(?:\s*|-)?to(?:\s*|-)?back\b/.test(normalized) ||
    /\bdo i have anything\b[\s\S]{0,40}\bat\b/.test(normalized) ||
    /\bwhat(?:'s| is)\b[\s\S]{0,80}\b(availability|available)\b/.test(
      normalized,
    )
  );
}

function detectClarificationQuestion(normalized: string): string | null {
  if (/\bafter work\b/.test(normalized)) {
    return 'What time should I treat as after work?';
  }
  if (/\bbefore lunch\b/.test(normalized)) {
    return 'What time should I treat as before lunch?';
  }
  return null;
}

function toTitleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token[0]?.toUpperCase() + token.slice(1))
    .join(' ');
}

function detectCalendarScopeFilter(
  normalized: string,
): CalendarScopeFilter | null {
  if (/\bfamily calendar\b/.test(normalized)) {
    return {
      kind: 'family_shared',
      label: 'the family calendar',
      terms: ['family'],
    };
  }

  const sharedPeopleMatch = normalized.match(
    /\bwhat do ([a-z,&\s]+?) and i have coming up\b/,
  );
  if (!sharedPeopleMatch) {
    return null;
  }

  const names = sharedPeopleMatch[1]
    .split(/\band\b|,|&/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 2 &&
        !['my', 'our', 'the', 'calendar', 'schedule'].includes(token),
    );
  if (names.length === 0) {
    return null;
  }

  return {
    kind: 'person_shared',
    label: `${names.map(toTitleCase).join(' and ')} and your shared calendars`,
    terms: [...names, 'family'],
  };
}

function parseRelativeBoundaryTime(
  normalized: string,
): { kind: 'after' | 'before'; time: ParsedClockTime } | null {
  const match = normalized.match(
    /\b(after|before)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
  );
  if (!match) return null;

  const rawHour = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  const meridiem = match[4]?.toLowerCase() ?? null;
  let hours: number | null = null;
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) {
      return null;
    }
    hours =
      rawHour === 12
        ? meridiem === 'am'
          ? 0
          : 12
        : meridiem === 'pm'
          ? rawHour + 12
          : rawHour;
  } else {
    hours = inferClockHourWithoutMeridiem(rawHour);
  }
  if (
    hours === null ||
    !Number.isInteger(minutes) ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }

  return {
    kind: match[1].toLowerCase() === 'after' ? 'after' : 'before',
    time: {
      hours,
      minutes,
      displayLabel: formatClockLabel(hours, minutes),
    },
  };
}

export function planCalendarAssistantLookup(
  message: string,
  now = new Date(),
  timeZone = TIMEZONE,
  activeEventContext: CalendarActiveEventContext | null = null,
): PlannedCalendarLookup | null {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) return null;

  const clarificationQuestion = detectClarificationQuestion(normalized);
  const scopeFilter = detectCalendarScopeFilter(normalized);
  const briefingQuery = looksLikeBriefingQuery(normalized);
  const nextAgendaQuery = looksLikeNextAgendaQuery(normalized);
  const openWindowQuery = looksLikeOpenWindowQuery(normalized);
  const conflictQuery = looksLikeConflictSummaryQuery(normalized);
  const nearTermAwarenessQuery =
    /\bcoming up soon\b/.test(normalized) ||
    /\bnext two hours\b/.test(normalized);
  const restOfDayBriefingQuery =
    /\bwhat should i know about today\b/.test(normalized) ||
    /\bwhat do i need to know about today\b/.test(normalized);
  const morningBriefQuery =
    /\bgive me (?:a )?morning brief\b/.test(normalized) &&
    /\btomorrow\b/.test(normalized);
  const intent =
    openWindowQuery || conflictQuery || looksLikeAvailabilityQuery(normalized)
      ? 'availability'
      : briefingQuery ||
          nextAgendaQuery ||
          looksLikeAgendaQuery(normalized) ||
          !!scopeFilter
        ? 'agenda'
        : null;

  if (!intent) return null;

  const explicitRange = hasExplicitRangeReference(normalized);
  let range = resolveLookupRange(normalized, now);
  let awarenessKind: CalendarAwarenessKind = 'none';
  let lookaheadMinutes: number | null = null;
  if (nearTermAwarenessQuery) {
    awarenessKind = 'coming_up_soon';
    lookaheadMinutes = 120;
    range = resolveUpcomingMinutesRange(
      now,
      lookaheadMinutes,
      'coming up soon',
    );
  } else if (restOfDayBriefingQuery) {
    awarenessKind = 'rest_of_day';
    range = resolveRemainingDayRange(now);
  } else if (morningBriefQuery) {
    awarenessKind = 'morning_brief';
    const tomorrow = addDays(startOfDay(now), 1);
    range = {
      start: tomorrow,
      end: addDays(tomorrow, 1),
      label: 'tomorrow',
    };
  } else if (/\bcoming up\b/.test(normalized) && !explicitRange) {
    range = resolveUpcomingRange(now, 7, 'coming up');
  }
  const parsedClockTime = parseClockTime(normalized);
  const relativeBoundary = parseRelativeBoundaryTime(normalized);
  const parsedDuration = parseDurationRequest(normalized);
  const rangeDurationMs = range.end.getTime() - range.start.getTime();
  let pointInTime: Date | null = null;
  let label = range.label;
  let reasoningMode: CalendarReasoningMode =
    intent === 'agenda' ? 'agenda' : 'availability_range';
  let minimumOpenMinutes: number | null = null;
  let nextTimedOnly = false;
  const subjectLabel: string | null = scopeFilter?.label || null;
  const forceIncludeCalendarNames = Boolean(scopeFilter);

  let resolvedStart = range.start;
  let resolvedEnd = range.end;

  if (nextAgendaQuery) {
    reasoningMode = 'agenda_next';
    const activeEnd = activeEventContext
      ? new Date(activeEventContext.endIso)
      : null;
    const anchor =
      /\bafter this\b/.test(normalized) && activeEnd ? activeEnd : now;

    if (
      !explicitRange &&
      !/\bcoming up this\b/.test(normalized) &&
      awarenessKind !== 'coming_up_soon'
    ) {
      range = resolveUpcomingRange(anchor, 7, 'coming up');
      resolvedEnd = range.end;
      label = /\bafter this\b/.test(normalized) ? 'after this' : 'next';
    } else if (awarenessKind === 'coming_up_soon') {
      label = 'coming up soon';
    }

    resolvedStart =
      anchor.getTime() > range.start.getTime() ? anchor : range.start;
    if (/\bnext meeting\b/.test(normalized)) {
      nextTimedOnly = true;
    }
  } else if (intent === 'agenda') {
    const multiDayRange = rangeDurationMs > 24 * 60 * 60 * 1000;
    if (
      briefingQuery &&
      (multiDayRange || /\b(?:week|weekend)\b/.test(normalized))
    ) {
      reasoningMode = 'agenda_briefing_week';
    } else if (briefingQuery) {
      reasoningMode = 'agenda_briefing_day';
    } else if (scopeFilter && multiDayRange) {
      reasoningMode = 'agenda_briefing_week';
    }
  }

  if (relativeBoundary && rangeDurationMs <= 24 * 60 * 60 * 1000) {
    const boundary = setLocalTime(
      startOfDay(range.start),
      relativeBoundary.time.hours,
      relativeBoundary.time.minutes,
    );
    if (relativeBoundary.kind === 'after') {
      if (boundary >= range.start && boundary < range.end) {
        resolvedStart = boundary;
        label = `after ${relativeBoundary.time.displayLabel} ${range.label}`;
        if (intent === 'availability') {
          reasoningMode = 'availability_range';
        }
      }
    } else if (boundary > range.start && boundary <= range.end) {
      resolvedEnd = boundary;
      label = `before ${relativeBoundary.time.displayLabel} ${range.label}`;
      if (intent === 'availability') {
        reasoningMode = 'availability_range';
      }
    }
  }

  if (parsedClockTime && rangeDurationMs <= 24 * 60 * 60 * 1000) {
    const candidate = setLocalTime(
      startOfDay(range.start),
      parsedClockTime.hours,
      parsedClockTime.minutes,
    );
    if (candidate >= range.start && candidate < range.end) {
      pointInTime = candidate;
      label =
        intent === 'availability'
          ? `at ${parsedClockTime.displayLabel} ${range.label}`
          : `at ${parsedClockTime.displayLabel} ${range.label}`;
      if (intent === 'availability') {
        reasoningMode = parsedDuration
          ? 'availability_duration'
          : 'availability_point';
      }
    }
  }

  if (intent === 'availability' && openWindowQuery) {
    reasoningMode = 'availability_open_windows';
    minimumOpenMinutes = parsedDuration?.minutes || 30;
  }

  if (intent === 'availability' && conflictQuery) {
    reasoningMode = 'availability_conflicts';
  }

  if (
    intent === 'availability' &&
    /\bback(?:\s*|-)?to(?:\s*|-)?back\b/.test(normalized)
  ) {
    reasoningMode = 'availability_back_to_back';
  }

  return {
    intent,
    start: resolvedStart,
    end: resolvedEnd,
    label,
    timeZone,
    pointInTime,
    durationMinutes: parsedDuration?.minutes || null,
    durationLabel: parsedDuration?.label || null,
    reasoningMode,
    clarificationQuestion,
    requestedTitle: parsedDuration?.requestedTitle || null,
    minimumOpenMinutes,
    nextTimedOnly,
    scopeFilter,
    subjectLabel,
    forceIncludeCalendarNames,
    awarenessKind,
    lookaheadMinutes,
  };
}

function resolveConfigValue(
  key: (typeof CALENDAR_ENV_KEYS)[number],
  envFile: Record<string, string>,
  env?: Record<string, string | undefined>,
): string | undefined {
  if (env) {
    return env[key];
  }
  return process.env[key] ?? envFile[key];
}

function resolveCsvList(
  value: string | null | undefined,
  fallback: string[] = [],
): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveCalendarConfig(
  env?: Record<string, string | undefined>,
): CalendarAssistantConfig {
  const envFile = readEnvFile([...CALENDAR_ENV_KEYS]);
  const appleLocalEnabledValue = resolveConfigValue(
    'APPLE_CALENDAR_LOCAL_ENABLED',
    envFile,
    env,
  );
  const appleCalDavUrl =
    resolveConfigValue('APPLE_CALDAV_URL', envFile, env)?.trim() || null;
  const appleCalDavCalendarUrls = resolveCsvList(
    resolveConfigValue('APPLE_CALDAV_CALENDAR_URLS', envFile, env),
  );
  const googleConfig = resolveGoogleCalendarConfig(env);

  return {
    appleLocalEnabled: appleLocalEnabledValue
      ? appleLocalEnabledValue.toLowerCase() !== 'false'
      : true,
    appleCalDavUrl,
    appleCalDavUsername:
      resolveConfigValue('APPLE_CALDAV_USERNAME', envFile, env)?.trim() || null,
    appleCalDavPassword:
      resolveConfigValue('APPLE_CALDAV_PASSWORD', envFile, env) || null,
    appleCalDavCalendarUrls,
    googleAccessToken: googleConfig.accessToken,
    googleRefreshToken: googleConfig.refreshToken,
    googleClientId: googleConfig.clientId,
    googleClientSecret: googleConfig.clientSecret,
    googleCalendarIds: googleConfig.calendarIds,
    outlookAccessToken:
      resolveConfigValue('OUTLOOK_CALENDAR_ACCESS_TOKEN', envFile, env) || null,
    outlookRefreshToken:
      resolveConfigValue('OUTLOOK_CALENDAR_REFRESH_TOKEN', envFile, env) ||
      null,
    outlookClientId:
      resolveConfigValue('OUTLOOK_CALENDAR_CLIENT_ID', envFile, env)?.trim() ||
      null,
    outlookClientSecret:
      resolveConfigValue('OUTLOOK_CALENDAR_CLIENT_SECRET', envFile, env) ||
      null,
    outlookTenantId:
      resolveConfigValue('OUTLOOK_CALENDAR_TENANT_ID', envFile, env)?.trim() ||
      'common',
    outlookUserId:
      resolveConfigValue('OUTLOOK_CALENDAR_USER_ID', envFile, env)?.trim() ||
      'me',
  };
}

function truncateDetail(value: string, max = 140): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return compact.length <= max ? compact : `${compact.slice(0, max - 3)}...`;
}

function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function buildCalDavQueryBody(start: Date, end: Date): string {
  const formatUtc = (value: Date) =>
    value
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');

  return `<?xml version="1.0" encoding="utf-8" ?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag />
    <c:calendar-data>
      <c:expand start="${formatUtc(start)}" end="${formatUtc(end)}" />
    </c:calendar-data>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${formatUtc(start)}" end="${formatUtc(end)}" />
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`;
}

function parseIcsDate(
  value: string,
  params: Record<string, string>,
): ParsedIcsDate {
  const trimmed = value.trim();
  if (!trimmed) {
    return { iso: null, allDay: false };
  }

  if (params.VALUE === 'DATE' || /^\d{8}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    return {
      iso: new Date(`${year}-${month}-${day}T00:00:00`).toISOString(),
      allDay: true,
    };
  }

  if (/^\d{8}T\d{6}Z$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    const hour = trimmed.slice(9, 11);
    const minute = trimmed.slice(11, 13);
    const second = trimmed.slice(13, 15);
    return {
      iso: `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
      allDay: false,
    };
  }

  if (/^\d{8}T\d{6}$/.test(trimmed)) {
    const year = trimmed.slice(0, 4);
    const month = trimmed.slice(4, 6);
    const day = trimmed.slice(6, 8);
    const hour = trimmed.slice(9, 11);
    const minute = trimmed.slice(11, 13);
    const second = trimmed.slice(13, 15);
    return {
      iso: new Date(
        `${year}-${month}-${day}T${hour}:${minute}:${second}`,
      ).toISOString(),
      allDay: false,
    };
  }

  const parsed = new Date(trimmed);
  return {
    iso: Number.isNaN(parsed.getTime()) ? null : parsed.toISOString(),
    allDay: false,
  };
}

function parseIcsEvents(
  calendarData: string,
  providerId: CalendarProviderId,
  providerLabel: string,
): CalendarEvent[] {
  const unfoldedLines: string[] = [];
  const rawLines = calendarData.replace(/\r\n/g, '\n').split('\n');
  for (const line of rawLines) {
    if (/^[ \t]/.test(line) && unfoldedLines.length > 0) {
      unfoldedLines[unfoldedLines.length - 1] += line.slice(1);
    } else {
      unfoldedLines.push(line);
    }
  }

  const events: CalendarEvent[] = [];
  let current: Record<
    string,
    { value: string; params: Record<string, string> }
  > | null = null;

  for (const line of unfoldedLines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const startValue = current.DTSTART;
        const endValue = current.DTEND;
        const parsedStart = startValue
          ? parseIcsDate(startValue.value, startValue.params)
          : { iso: null, allDay: false };
        const parsedEnd = endValue
          ? parseIcsDate(endValue.value, endValue.params)
          : { iso: parsedStart.iso, allDay: parsedStart.allDay };
        if (parsedStart.iso && parsedEnd.iso) {
          events.push({
            id:
              current.UID?.value ||
              `${providerId}:${parsedStart.iso}:${current.SUMMARY?.value || 'event'}`,
            providerId,
            providerLabel,
            title: current.SUMMARY?.value || 'Untitled event',
            startIso: parsedStart.iso,
            endIso: parsedEnd.iso,
            allDay: parsedStart.allDay,
            location: current.LOCATION?.value || null,
            calendarName: null,
          });
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const left = line.slice(0, separator);
    const value = line
      .slice(separator + 1)
      .replace(/\\,/g, ',')
      .replace(/\\n/g, '\n');
    const [name, ...paramParts] = left.split(';');
    const params: Record<string, string> = {};
    for (const part of paramParts) {
      const [paramName, paramValue] = part.split('=');
      if (!paramName || !paramValue) continue;
      params[paramName.toUpperCase()] = paramValue;
    }
    current[name.toUpperCase()] = {
      value,
      params,
    };
  }

  return events;
}

function extractCalDavPayloads(xml: string): string[] {
  const matches = xml.matchAll(
    /<[^>]*calendar-data[^>]*>([\s\S]*?)<\/[^>]*calendar-data>/gi,
  );
  return [...matches].map((match) => xmlDecode(match[1] || '')).filter(Boolean);
}

function parseGraphDateTime(
  dateTime: string,
  timeZone?: string | null,
): string | null {
  const trimmed = dateTime.trim();
  if (!trimmed) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const suffix = timeZone && timeZone.toUpperCase() === 'UTC' ? 'Z' : '';
  const parsed = new Date(`${trimmed}${suffix}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractJsonErrorDetail(
  rawText: string,
  fallbackPrefix: string,
  status?: number,
): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return status ? `${fallbackPrefix} ${status}` : fallbackPrefix;
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      error?:
        | string
        | {
            message?: string;
            error_description?: string;
            description?: string;
          };
      error_description?: string;
    };
    const nestedError =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ||
          parsed.error?.error_description ||
          parsed.error?.description;
    const detail = nestedError || parsed.error_description;
    if (detail) {
      return status
        ? `${fallbackPrefix} ${status}: ${truncateDetail(detail)}`
        : `${fallbackPrefix}: ${truncateDetail(detail)}`;
    }
  } catch {
    // Fall through to plain-text handling.
  }

  return status
    ? `${fallbackPrefix} ${status}: ${truncateDetail(trimmed)}`
    : `${fallbackPrefix}: ${truncateDetail(trimmed)}`;
}

function dedupeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const result: CalendarEvent[] = [];
  for (const event of events) {
    const key = `${event.title}::${event.startIso}::${event.endIso}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result.sort((left, right) => {
    const startDiff =
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime();
    if (startDiff !== 0) return startDiff;
    return left.title.localeCompare(right.title);
  });
}

function eventOverlapsPoint(event: CalendarEvent, pointInTime: Date): boolean {
  const eventStart = new Date(event.startIso).getTime();
  const eventEnd = new Date(event.endIso).getTime();
  const point = pointInTime.getTime();
  return eventStart <= point && eventEnd > point;
}

function eventOverlapsRange(
  event: CalendarEvent,
  start: Date,
  end: Date,
): boolean {
  const eventStart = new Date(event.startIso).getTime();
  const eventEnd = new Date(event.endIso).getTime();
  return eventStart < end.getTime() && eventEnd > start.getTime();
}

function filterEventsForPlan(
  events: CalendarEvent[],
  plan: PlannedCalendarLookup,
): CalendarEvent[] {
  return events.filter((event) => {
    if (!eventOverlapsRange(event, plan.start, plan.end)) {
      return false;
    }
    if (!plan.pointInTime) {
      return true;
    }
    if (
      plan.reasoningMode === 'availability_duration' &&
      plan.durationMinutes &&
      plan.durationMinutes > 0
    ) {
      return eventOverlapsRange(
        event,
        plan.pointInTime,
        new Date(plan.pointInTime.getTime() + plan.durationMinutes * 60 * 1000),
      );
    }
    return eventOverlapsPoint(event, plan.pointInTime);
  });
}

function matchesScopeCalendar(
  calendar: Pick<GoogleCalendarMetadata, 'summary' | 'selected'>,
  filter: CalendarScopeFilter,
): boolean {
  if (!calendar.selected) {
    return false;
  }

  const summary = calendar.summary.trim().toLowerCase();
  if (!summary) {
    return false;
  }

  return filter.terms.some((term) => summary.includes(term.toLowerCase()));
}

async function applyScopeFilter(
  events: CalendarEvent[],
  statuses: CalendarProviderStatus[],
  plan: PlannedCalendarLookup,
  deps: CalendarAssistantDeps,
): Promise<{
  events: CalendarEvent[];
  scopeResolutionMessage: string | null;
  matchedScopeCalendars: string[];
}> {
  if (!plan.scopeFilter) {
    return {
      events,
      scopeResolutionMessage: null,
      matchedScopeCalendars: [],
    };
  }

  const googleStatus = statuses.find(
    (status) => status.id === 'google_calendar',
  );
  if (!googleStatus || googleStatus.state !== 'ready') {
    return {
      events: [],
      scopeResolutionMessage:
        "I can't confirm that shared Google calendar right now.",
      matchedScopeCalendars: [],
    };
  }

  try {
    const googleCalendars = await listGoogleCalendars(
      resolveGoogleCalendarConfig(deps.env),
      deps.fetchImpl,
    );
    const matchedCalendars = googleCalendars.filter((calendar) =>
      matchesScopeCalendar(calendar, plan.scopeFilter!),
    );
    if (matchedCalendars.length === 0) {
      return {
        events: [],
        scopeResolutionMessage:
          plan.scopeFilter.kind === 'family_shared'
            ? "I couldn't tell which selected shared calendar is your family calendar."
            : `I couldn't tell which selected shared calendar matches ${plan.scopeFilter.label}.`,
        matchedScopeCalendars: [],
      };
    }

    const matchedIds = new Set(matchedCalendars.map((calendar) => calendar.id));
    return {
      events: events.filter(
        (event) =>
          event.providerId === 'google_calendar' &&
          !!event.calendarId &&
          matchedIds.has(event.calendarId),
      ),
      scopeResolutionMessage: null,
      matchedScopeCalendars: matchedCalendars.map(
        (calendar) => calendar.summary,
      ),
    };
  } catch {
    return {
      events: [],
      scopeResolutionMessage:
        "I couldn't confirm which shared Google calendar matches that request right now.",
      matchedScopeCalendars: [],
    };
  }
}

async function defaultAppleCalendarScriptRunner(
  startIso: string,
  endIso: string,
): Promise<string> {
  const script = `
const app = Application('Calendar');
const start = new Date(ARGV[0]);
const end = new Date(ARGV[1]);
const rows = [];
for (const cal of app.calendars()) {
  const events = cal.events();
  for (const ev of events) {
    const eventStart = new Date(ev.startDate());
    const eventEnd = new Date(ev.endDate());
    if (!(eventStart < end && eventEnd > start)) continue;
    rows.push({
      id: String(typeof ev.id === 'function' ? ev.id() : ''),
      title: String(typeof ev.summary === 'function' ? ev.summary() : typeof ev.name === 'function' ? ev.name() : 'Untitled event'),
      startIso: eventStart.toISOString(),
      endIso: eventEnd.toISOString(),
      allDay: Boolean(typeof ev.alldayEvent === 'function' ? ev.alldayEvent() : false),
      location: typeof ev.location === 'function' ? String(ev.location() || '') : '',
      calendarName: String(typeof cal.name === 'function' ? cal.name() : 'Apple Calendar')
    });
  }
}
JSON.stringify(rows);
`;

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      'osascript',
      ['-l', 'JavaScript', '-e', script, startIso, endIso],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(
          new Error(stderr.trim() || `osascript exited with code ${code}`),
        );
      }
    });
  });
}

async function loadAppleLocalEvents(
  plan: PlannedCalendarLookup,
  config: CalendarAssistantConfig,
  deps: CalendarAssistantDeps,
): Promise<CalendarProviderResult> {
  const statusBase = {
    id: 'apple_local' as const,
    label: 'Apple Calendar on this Mac',
  };

  if (deps.platform !== 'darwin') {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'not_configured',
        detail: 'This host is not a Mac.',
        configured: false,
        complete: false,
      },
    };
  }

  if (!config.appleLocalEnabled) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'not_configured',
        detail: 'Disabled by APPLE_CALENDAR_LOCAL_ENABLED=false.',
        configured: false,
        complete: false,
      },
    };
  }

  try {
    const runner =
      deps.runAppleCalendarScript || defaultAppleCalendarScriptRunner;
    const raw = await runner(plan.start.toISOString(), plan.end.toISOString());
    const parsed = JSON.parse(raw) as Array<{
      id?: string;
      title?: string;
      startIso?: string;
      endIso?: string;
      allDay?: boolean;
      location?: string;
      calendarName?: string;
    }>;
    const events = dedupeEvents(
      parsed
        .filter((event) => event.startIso && event.endIso)
        .map((event) => ({
          id:
            event.id ||
            `apple_local:${event.startIso}:${event.title || 'event'}`,
          providerId: 'apple_local' as const,
          providerLabel: statusBase.label,
          title: event.title || 'Untitled event',
          startIso: event.startIso!,
          endIso: event.endIso!,
          allDay: Boolean(event.allDay),
          location: event.location || null,
          calendarName: event.calendarName || null,
        })),
    );
    return {
      events,
      status: {
        ...statusBase,
        state: 'ready',
        detail:
          events.length > 0
            ? `${events.length} event(s) found.`
            : 'No events found in range.',
        configured: true,
        complete: true,
      },
    };
  } catch (error) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'error',
        detail: truncateDetail(
          error instanceof Error ? error.message : String(error),
        ),
        configured: true,
        complete: false,
      },
    };
  }
}

async function loadAppleCalDavEvents(
  plan: PlannedCalendarLookup,
  config: CalendarAssistantConfig,
  deps: CalendarAssistantDeps,
): Promise<CalendarProviderResult> {
  const statusBase = {
    id: 'apple_caldav' as const,
    label: 'Apple/iCloud CalDAV',
  };

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const calendarUrls =
    config.appleCalDavCalendarUrls.length > 0
      ? config.appleCalDavCalendarUrls
      : config.appleCalDavUrl
        ? [config.appleCalDavUrl]
        : [];

  if (
    calendarUrls.length === 0 ||
    !config.appleCalDavUsername ||
    !config.appleCalDavPassword
  ) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'not_configured',
        detail:
          'Set APPLE_CALDAV_URL or APPLE_CALDAV_CALENDAR_URLS plus APPLE_CALDAV_USERNAME and APPLE_CALDAV_PASSWORD.',
        configured: false,
        complete: false,
      },
    };
  }

  try {
    const authToken = Buffer.from(
      `${config.appleCalDavUsername}:${config.appleCalDavPassword}`,
      'utf-8',
    ).toString('base64');
    const body = buildCalDavQueryBody(plan.start, plan.end);
    const events: CalendarEvent[] = [];
    const failures: string[] = [];
    let successCount = 0;

    for (const calendarUrl of calendarUrls) {
      try {
        const response = await fetchImpl(calendarUrl, {
          method: 'REPORT',
          headers: {
            Authorization: `Basic ${authToken}`,
            Depth: '1',
            'Content-Type': 'application/xml; charset=utf-8',
          },
          body,
        });

        const text = await response.text();
        if (!response.ok) {
          throw new Error(`CalDAV ${response.status}: ${truncateDetail(text)}`);
        }
        successCount += 1;

        for (const payload of extractCalDavPayloads(text)) {
          events.push(
            ...parseIcsEvents(payload, 'apple_caldav', statusBase.label),
          );
        }
      } catch (error) {
        failures.push(
          truncateDetail(
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    const deduped = dedupeEvents(events);
    if (successCount === 0 && failures.length > 0) {
      return {
        events: [],
        status: {
          ...statusBase,
          state: 'error',
          detail: failures.join(' | '),
          configured: true,
          complete: false,
        },
      };
    }

    return {
      events: deduped,
      status: {
        ...statusBase,
        state: 'ready',
        detail:
          failures.length === 0
            ? deduped.length > 0
              ? `${deduped.length} event(s) found.`
              : 'No events found in range.'
            : `Read ${successCount} of ${calendarUrls.length} calendar collection(s). Failures: ${failures.join(' | ')}`,
        configured: true,
        complete: failures.length === 0,
      },
    };
  } catch (error) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'error',
        detail: truncateDetail(
          error instanceof Error ? error.message : String(error),
        ),
        configured: true,
        complete: false,
      },
    };
  }
}

async function loadGoogleCalendarEvents(
  plan: PlannedCalendarLookup,
  config: CalendarAssistantConfig,
  deps: CalendarAssistantDeps,
): Promise<CalendarProviderResult> {
  const statusBase = {
    id: 'google_calendar' as const,
    label: 'Google Calendar',
  };

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (
    !config.googleAccessToken &&
    !(
      config.googleRefreshToken &&
      config.googleClientId &&
      config.googleClientSecret
    )
  ) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'not_configured',
        detail:
          'Set GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN plus GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET.',
        configured: false,
        complete: false,
      },
    };
  }

  try {
    const { events, failures, successCount } = await listGoogleCalendarEvents(
      {
        start: plan.start,
        end: plan.end,
        calendarIds: config.googleCalendarIds,
      },
      {
        accessToken: config.googleAccessToken,
        refreshToken: config.googleRefreshToken,
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        calendarIds: config.googleCalendarIds,
      },
      fetchImpl,
    );
    const deduped = dedupeEvents(
      events.map((event) => ({
        id: event.id,
        providerId: 'google_calendar' as const,
        providerLabel: statusBase.label,
        title: event.title,
        startIso: event.startIso,
        endIso: event.endIso,
        allDay: event.allDay,
        calendarId: event.calendarId,
        location: event.location || null,
        calendarName: event.calendarName,
        htmlLink: event.htmlLink || null,
      })),
    );
    if (successCount === 0 && failures.length > 0) {
      return {
        events: [],
        status: {
          ...statusBase,
          state: 'error',
          detail: failures.join(' | '),
          configured: true,
          complete: false,
        },
      };
    }

    return {
      events: deduped,
      status: {
        ...statusBase,
        state: 'ready',
        detail:
          failures.length === 0
            ? deduped.length > 0
              ? `${deduped.length} event(s) found across ${config.googleCalendarIds.length} calendar(s).`
              : `No events found across ${config.googleCalendarIds.length} calendar(s).`
            : `Read ${successCount} of ${config.googleCalendarIds.length} configured Google calendar(s). Failures: ${failures.join(' | ')}`,
        configured: true,
        complete: failures.length === 0,
      },
    };
  } catch (error) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'error',
        detail: truncateDetail(
          error instanceof Error ? error.message : String(error),
        ),
        configured: true,
        complete: false,
      },
    };
  }
}

async function getOutlookAccessToken(
  config: CalendarAssistantConfig,
  fetchImpl: FetchLike,
): Promise<string> {
  if (config.outlookAccessToken) {
    return config.outlookAccessToken;
  }

  if (!config.outlookRefreshToken || !config.outlookClientId) {
    throw new Error(
      'Set OUTLOOK_CALENDAR_ACCESS_TOKEN or OUTLOOK_CALENDAR_REFRESH_TOKEN plus OUTLOOK_CALENDAR_CLIENT_ID.',
    );
  }

  const body = new URLSearchParams({
    client_id: config.outlookClientId,
    grant_type: 'refresh_token',
    refresh_token: config.outlookRefreshToken,
    scope: 'https://graph.microsoft.com/Calendars.Read offline_access',
  });
  if (config.outlookClientSecret) {
    body.set('client_secret', config.outlookClientSecret);
  }

  const response = await fetchImpl(
    `https://login.microsoftonline.com/${encodeURIComponent(config.outlookTenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      extractJsonErrorDetail(text, 'Outlook token refresh', response.status),
    );
  }

  const payload = JSON.parse(text) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error('Outlook token refresh did not return an access token.');
  }
  return payload.access_token;
}

async function loadOutlookEvents(
  plan: PlannedCalendarLookup,
  config: CalendarAssistantConfig,
  deps: CalendarAssistantDeps,
): Promise<CalendarProviderResult> {
  const statusBase = {
    id: 'outlook' as const,
    label: 'Outlook Calendar',
  };

  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (
    !config.outlookAccessToken &&
    !(config.outlookRefreshToken && config.outlookClientId)
  ) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'not_configured',
        detail:
          'Set OUTLOOK_CALENDAR_ACCESS_TOKEN or OUTLOOK_CALENDAR_REFRESH_TOKEN plus OUTLOOK_CALENDAR_CLIENT_ID.',
        configured: false,
        complete: false,
      },
    };
  }

  try {
    const accessToken = await getOutlookAccessToken(config, fetchImpl);
    const url = new URL(
      config.outlookUserId === 'me'
        ? 'https://graph.microsoft.com/v1.0/me/calendarView'
        : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.outlookUserId)}/calendarView`,
    );
    url.searchParams.set('startDateTime', plan.start.toISOString());
    url.searchParams.set('endDateTime', plan.end.toISOString());
    url.searchParams.set('$orderby', 'start/dateTime');
    url.searchParams.set(
      '$select',
      'id,subject,start,end,isAllDay,location,organizer',
    );

    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.timezone="UTC"',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        extractJsonErrorDetail(text, 'Microsoft Graph', response.status),
      );
    }
    const payload = JSON.parse(text) as {
      value?: Array<{
        id?: string;
        subject?: string;
        isAllDay?: boolean;
        start?: { dateTime?: string; timeZone?: string };
        end?: { dateTime?: string; timeZone?: string };
        location?: { displayName?: string };
      }>;
    };
    const parsedEvents: Array<CalendarEvent | null> = (payload.value || []).map(
      (event) => {
        const startIso = event.start?.dateTime
          ? parseGraphDateTime(event.start.dateTime, event.start.timeZone)
          : null;
        const endIso = event.end?.dateTime
          ? parseGraphDateTime(event.end.dateTime, event.end.timeZone)
          : null;
        if (!startIso || !endIso) {
          return null;
        }
        return {
          id: event.id || `outlook:${startIso}:${event.subject || 'event'}`,
          providerId: 'outlook',
          providerLabel: statusBase.label,
          title: event.subject || 'Untitled event',
          startIso,
          endIso,
          allDay: Boolean(event.isAllDay),
          location: event.location?.displayName || null,
          calendarName: null,
        };
      },
    );
    const events = dedupeEvents(
      parsedEvents.filter((event): event is CalendarEvent => event !== null),
    );

    return {
      events,
      status: {
        ...statusBase,
        state: 'ready',
        detail:
          events.length > 0
            ? `${events.length} event(s) found.`
            : 'No events found in range.',
        configured: true,
        complete: true,
      },
    };
  } catch (error) {
    return {
      events: [],
      status: {
        ...statusBase,
        state: 'error',
        detail: truncateDetail(
          error instanceof Error ? error.message : String(error),
        ),
        configured: true,
        complete: false,
      },
    };
  }
}

export async function lookupCalendarAssistantEvents(
  plan: PlannedCalendarLookup,
  deps: CalendarAssistantDeps = {},
): Promise<CalendarLookupResult> {
  const config = resolveCalendarConfig(deps.env);
  const platform = deps.platform || process.platform;
  const resolvedDeps = {
    ...deps,
    platform,
  };

  const providerResults = await Promise.all([
    loadAppleLocalEvents(plan, config, resolvedDeps),
    loadAppleCalDavEvents(plan, config, resolvedDeps),
    loadGoogleCalendarEvents(plan, config, resolvedDeps),
    loadOutlookEvents(plan, config, resolvedDeps),
  ]);

  const statuses = providerResults.map((result) => result.status);
  const filteredEvents = filterEventsForPlan(
    dedupeEvents(providerResults.flatMap((result) => result.events)),
    plan,
  );
  const scoped = await applyScopeFilter(
    filteredEvents,
    statuses,
    plan,
    resolvedDeps,
  );

  return {
    plan,
    events: scoped.events,
    statuses,
    scopeResolutionMessage: scoped.scopeResolutionMessage,
    matchedScopeCalendars: scoped.matchedScopeCalendars,
  };
}

function formatTimeRange(event: CalendarEvent, timeZone: string): string {
  if (event.allDay) {
    return 'All day';
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatter.format(new Date(event.startIso))}-${formatter.format(new Date(event.endIso))}`;
}

function formatEventLine(
  event: CalendarEvent,
  timeZone: string,
  includeProvider: boolean,
  includeCalendarName: boolean,
): string {
  const parts = [`- ${formatTimeRange(event, timeZone)} ${event.title}`];
  if (event.location) {
    parts.push(`@ ${event.location}`);
  }
  if (includeCalendarName && event.calendarName) {
    parts.push(`[${event.calendarName}]`);
  }
  if (includeProvider) {
    parts.push(`(${event.providerLabel})`);
  }
  return parts.join(' ');
}

function formatGroupedEvents(
  events: CalendarEvent[],
  timeZone: string,
  forceIncludeCalendarName = false,
): string[] {
  if (events.length === 0) {
    return [];
  }

  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
  const includeProvider =
    new Set(events.map((event) => event.providerLabel)).size > 1;
  const includeCalendarName =
    forceIncludeCalendarName ||
    new Set(events.map((event) => event.calendarName).filter(Boolean)).size > 1;
  const grouped = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const dayKey = dayFormatter.format(new Date(event.startIso));
    const bucket = grouped.get(dayKey);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(dayKey, [event]);
    }
  }

  if (grouped.size === 1) {
    return [...grouped.values()][0].map((event) =>
      formatEventLine(event, timeZone, includeProvider, includeCalendarName),
    );
  }

  const lines: string[] = [];
  for (const [dayKey, bucket] of grouped.entries()) {
    lines.push(`${dayKey}:`);
    for (const event of bucket) {
      lines.push(
        formatEventLine(event, timeZone, includeProvider, includeCalendarName),
      );
    }
  }
  return lines;
}

function formatStatusLabelList(statuses: CalendarProviderStatus[]): string {
  if (statuses.length === 0) {
    return 'your configured calendars';
  }
  const labels = statuses.map((status) => status.label);
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function formatStatusDetailList(statuses: CalendarProviderStatus[]): string {
  return statuses
    .map((status) => `- ${status.label}: ${status.detail}`)
    .join('\n');
}

interface CalendarReplyStatusContext {
  configuredStatuses: CalendarProviderStatus[];
  readyStatuses: CalendarProviderStatus[];
  incompleteStatuses: CalendarProviderStatus[];
  configuredReady: boolean;
  hasConfiguredProviders: boolean;
  fullyConfirmed: boolean;
  incompleteNote: string;
  incompleteNoteBody: string;
}

function buildReplyStatusContext(
  result: CalendarLookupResult,
): CalendarReplyStatusContext {
  const configuredStatuses = result.statuses.filter(
    (status) => status.configured,
  );
  const readyStatuses = configuredStatuses.filter(
    (status) => status.state === 'ready',
  );
  const incompleteStatuses = configuredStatuses.filter(
    (status) => status.state !== 'ready' || !status.complete,
  );
  const configuredReady = readyStatuses.length > 0;
  const hasConfiguredProviders = configuredStatuses.length > 0;
  const fullyConfirmed =
    hasConfiguredProviders &&
    configuredStatuses.every(
      (status) => status.state === 'ready' && status.complete,
    );
  const incompleteNote =
    incompleteStatuses.length > 0
      ? `\n\nI couldn't confirm every configured calendar right now.\n${formatStatusDetailList(
          incompleteStatuses,
        )}`
      : '';

  return {
    configuredStatuses,
    readyStatuses,
    incompleteStatuses,
    configuredReady,
    hasConfiguredProviders,
    fullyConfirmed,
    incompleteNote,
    incompleteNoteBody: incompleteNote.replace(/^\n+/, ''),
  };
}

function sortCalendarEventsChronologically(
  events: CalendarEvent[],
): CalendarEvent[] {
  return [...events].sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
}

export function buildCalendarLookupSnapshot(
  result: CalendarLookupResult,
): CalendarLookupSnapshot {
  const statusContext = buildReplyStatusContext(result);
  const timedEvents = sortCalendarEventsChronologically(
    getTimedEvents(result.events),
  );
  const allDayEvents = sortCalendarEventsChronologically(
    getAllDayEvents(result.events),
  );
  const openWindows = buildOpenWindows(
    result.plan.start,
    result.plan.end,
    buildBusyWindows(timedEvents),
  );
  const nextTimedEvent =
    timedEvents.find(
      (event) => new Date(event.endIso).getTime() > result.plan.start.getTime(),
    ) || null;

  return {
    unavailableReply: buildUnavailableCalendarReply(result, statusContext),
    fullyConfirmed: statusContext.fullyConfirmed,
    incompleteNoteBody: statusContext.incompleteNoteBody,
    timedEvents,
    allDayEvents,
    nextTimedEvent,
    activeAllDayEvents: allDayEvents.filter((event) =>
      eventOverlapsPoint(event, result.plan.start),
    ),
    openWindows,
    conflictGroups: buildConflictGroups(result.events),
    adjacencyClusters: buildAdjacencyClusters(result.events),
    densityLine: formatBriefingDensityLine(result, timedEvents),
  };
}

function formatSubjectLabel(plan: PlannedCalendarLookup): string {
  return plan.subjectLabel || 'your calendar';
}

function capitalizeLabel(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function formatCountLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function formatListWithAnd(parts: string[]): string {
  if (parts.length <= 1) {
    return parts[0] || '';
  }
  if (parts.length === 2) {
    return `${parts[0]} and ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

function formatWindowRange(start: Date, end: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${formatter.format(start)}-${formatter.format(end)}`;
}

function getTimedEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((event) => !event.allDay);
}

function getAllDayEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((event) => event.allDay);
}

function buildBusyWindows(events: CalendarEvent[]): Array<{
  start: Date;
  end: Date;
}> {
  const sorted = getTimedEvents(events).sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const windows: Array<{ start: Date; end: Date }> = [];
  for (const event of sorted) {
    const start = new Date(event.startIso);
    const end = new Date(event.endIso);
    const current = windows.at(-1);
    if (!current || start.getTime() > current.end.getTime()) {
      windows.push({ start, end });
      continue;
    }
    if (end.getTime() > current.end.getTime()) {
      current.end = end;
    }
  }
  return windows;
}

function buildOpenWindows(
  start: Date,
  end: Date,
  busyWindows: Array<{ start: Date; end: Date }>,
): Array<{ start: Date; end: Date }> {
  const windows: Array<{ start: Date; end: Date }> = [];
  let cursor = start.getTime();
  for (const busy of busyWindows) {
    const busyStart = Math.max(busy.start.getTime(), start.getTime());
    const busyEnd = Math.min(busy.end.getTime(), end.getTime());
    if (busyEnd <= start.getTime() || busyStart >= end.getTime()) {
      continue;
    }
    if (busyStart > cursor) {
      windows.push({
        start: new Date(cursor),
        end: new Date(busyStart),
      });
    }
    cursor = Math.max(cursor, busyEnd);
  }
  if (cursor < end.getTime()) {
    windows.push({
      start: new Date(cursor),
      end: new Date(end.getTime()),
    });
  }
  return windows.filter(
    (window) => window.end.getTime() > window.start.getTime(),
  );
}

function formatOpenWindows(
  windows: Array<{ start: Date; end: Date }>,
  timeZone: string,
): string[] {
  return windows.map(
    (window) =>
      `- Open: ${formatWindowRange(window.start, window.end, timeZone)}`,
  );
}

function formatEventSummary(
  event: CalendarEvent,
  timeZone: string,
  forceIncludeCalendarName: boolean,
): string {
  return formatEventLine(
    event,
    timeZone,
    false,
    forceIncludeCalendarName,
  ).replace(/^- /, '');
}

function countDistinctDays(events: CalendarEvent[], timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return new Set(
    events.map((event) => formatter.format(new Date(event.startIso))),
  ).size;
}

function formatMorningBriefLine(
  result: CalendarLookupResult,
  timedEvents: CalendarEvent[],
): string | null {
  if (result.plan.awarenessKind !== 'morning_brief') {
    return null;
  }

  const morningEnd = setLocalTime(startOfDay(result.plan.start), 12);
  const morningEvents = timedEvents.filter(
    (event) => new Date(event.startIso).getTime() < morningEnd.getTime(),
  );
  if (morningEvents.length === 0) {
    return 'Morning looks clear.';
  }

  return `Morning starts with ${formatEventSummary(
    morningEvents[0]!,
    result.plan.timeZone,
    result.plan.forceIncludeCalendarNames,
  )}.`;
}

function formatBriefingDensityLine(
  result: CalendarLookupResult,
  timedEvents: CalendarEvent[],
): string | null {
  if (
    result.plan.awarenessKind !== 'rest_of_day' &&
    result.plan.awarenessKind !== 'morning_brief'
  ) {
    return null;
  }

  const totalWindowMinutes = Math.max(
    0,
    Math.round(
      (result.plan.end.getTime() - result.plan.start.getTime()) / (60 * 1000),
    ),
  );
  if (totalWindowMinutes < 180) {
    return null;
  }

  const busyMinutes = buildBusyWindows(timedEvents).reduce(
    (total, window) =>
      total +
      Math.max(
        0,
        Math.round(
          (window.end.getTime() - window.start.getTime()) / (60 * 1000),
        ),
      ),
    0,
  );
  const openMinutes = Math.max(0, totalWindowMinutes - busyMinutes);

  if (openMinutes > 0 && openMinutes < 60) {
    return 'You have very little free time in that stretch.';
  }
  if (busyMinutes >= totalWindowMinutes * 0.75) {
    return 'It looks pretty packed.';
  }
  return null;
}

function buildAdjacencyClusters(events: CalendarEvent[]): CalendarEvent[][] {
  const timedEvents = getTimedEvents(events).sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const clusters: CalendarEvent[][] = [];
  let current: CalendarEvent[] = [];

  for (const event of timedEvents) {
    if (current.length === 0) {
      current = [event];
      continue;
    }

    const previous = current.at(-1)!;
    const gapMs =
      new Date(event.startIso).getTime() - new Date(previous.endIso).getTime();
    if (gapMs >= 0 && gapMs <= 15 * 60 * 1000) {
      current.push(event);
      continue;
    }

    if (current.length > 1) {
      clusters.push(current);
    }
    current = [event];
  }

  if (current.length > 1) {
    clusters.push(current);
  }

  return clusters;
}

function buildConflictGroups(events: CalendarEvent[]): CalendarEvent[][] {
  const timedEvents = getTimedEvents(events).sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const groups: CalendarEvent[][] = [];
  let current: CalendarEvent[] = [];
  let currentEndMs = 0;

  for (const event of timedEvents) {
    const eventStartMs = new Date(event.startIso).getTime();
    const eventEndMs = new Date(event.endIso).getTime();

    if (current.length === 0) {
      current = [event];
      currentEndMs = eventEndMs;
      continue;
    }

    if (eventStartMs < currentEndMs) {
      current.push(event);
      currentEndMs = Math.max(currentEndMs, eventEndMs);
      continue;
    }

    if (current.length > 1) {
      groups.push(current);
    }
    current = [event];
    currentEndMs = eventEndMs;
  }

  if (current.length > 1) {
    groups.push(current);
  }

  return groups;
}

function formatConflictLines(
  groups: CalendarEvent[][],
  timeZone: string,
  forceIncludeCalendarName: boolean,
): string[] {
  return groups.map((group) => {
    if (group.length === 2) {
      return `- Conflict: ${formatEventSummary(
        group[0]!,
        timeZone,
        forceIncludeCalendarName,
      )} overlaps ${formatEventSummary(
        group[1]!,
        timeZone,
        forceIncludeCalendarName,
      )}`;
    }

    const start = new Date(group[0]!.startIso);
    const end = new Date(
      Math.max(...group.map((event) => new Date(event.endIso).getTime())),
    );
    return `- Conflict: ${group.length} overlapping events around ${formatWindowRange(
      start,
      end,
      timeZone,
    )}`;
  });
}

function formatTightStretchLine(
  clusters: CalendarEvent[][],
  timeZone: string,
  forceIncludeCalendarName: boolean,
): string | null {
  const cluster = clusters[0];
  if (!cluster || cluster.length < 2) {
    return null;
  }

  return `- Tight stretch: ${cluster
    .map((event) =>
      formatEventSummary(event, timeZone, forceIncludeCalendarName),
    )
    .join(' -> ')}`;
}

function buildUnavailableCalendarReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string | null {
  if (result.scopeResolutionMessage) {
    return result.scopeResolutionMessage;
  }

  const { configuredStatuses, configuredReady, hasConfiguredProviders } =
    statusContext;

  if (!hasConfiguredProviders) {
    return [
      "I can't check your calendar yet because no supported calendar provider is ready on this host.",
      '',
      'Andrea can read:',
      '- Google Calendar with a configured OAuth token',
      '- Apple Calendar directly on a Mac',
      '- Apple/iCloud calendars over CalDAV',
      '- Outlook calendars through Microsoft Graph',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (!configuredReady) {
    return [
      `I can't confirm your calendar right now because ${formatStatusLabelList(configuredStatuses)} ${configuredStatuses.length === 1 ? 'is' : 'are'} unavailable on this host.`,
      '',
      formatStatusDetailList(configuredStatuses),
    ].join('\n');
  }

  return null;
}

function buildBriefingReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string {
  const { fullyConfirmed, incompleteNoteBody } = statusContext;
  const forceIncludeCalendarName = result.plan.forceIncludeCalendarNames;
  const allDayEvents = getAllDayEvents(result.events);
  const timedEvents = getTimedEvents(result.events);
  const conflictGroups = buildConflictGroups(result.events);
  const tightStretchLine = formatTightStretchLine(
    buildAdjacencyClusters(result.events),
    result.plan.timeZone,
    forceIncludeCalendarName,
  );
  const morningBriefLine = formatMorningBriefLine(result, timedEvents);
  const densityLine = formatBriefingDensityLine(result, timedEvents);

  if (result.events.length === 0) {
    if (!fullyConfirmed) {
      return `I didn't find anything on ${formatSubjectLabel(
        result.plan,
      )} ${result.plan.label} in the calendars I could read.${statusContext.incompleteNote}`;
    }
    return `${capitalizeLabel(result.plan.label)} looks clear.`;
  }

  const summaryBits: string[] = [];
  if (allDayEvents.length > 0) {
    summaryBits.push(formatCountLabel(allDayEvents.length, 'all-day event'));
  }
  if (timedEvents.length > 0) {
    summaryBits.push(formatCountLabel(timedEvents.length, 'timed event'));
  }
  if (conflictGroups.length > 0) {
    summaryBits.push(formatCountLabel(conflictGroups.length, 'conflict'));
  } else if (result.plan.reasoningMode === 'agenda_briefing_week') {
    summaryBits.push(
      `${countDistinctDays(result.events, result.plan.timeZone)} day${
        countDistinctDays(result.events, result.plan.timeZone) === 1 ? '' : 's'
      } with events`,
    );
  }

  const lines = [
    `${capitalizeLabel(result.plan.label)} has ${formatListWithAnd(summaryBits)}.`,
    ...(morningBriefLine ? [morningBriefLine] : []),
    ...(densityLine ? [densityLine] : []),
    ...formatGroupedEvents(
      [...allDayEvents, ...timedEvents],
      result.plan.timeZone,
      forceIncludeCalendarName,
    ),
    ...formatConflictLines(
      conflictGroups,
      result.plan.timeZone,
      forceIncludeCalendarName,
    ),
    ...(tightStretchLine ? [tightStretchLine] : []),
    ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
  ];

  return lines.filter(Boolean).join('\n');
}

function buildNextReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string {
  const { fullyConfirmed, incompleteNote, incompleteNoteBody } = statusContext;
  const forceIncludeCalendarName = result.plan.forceIncludeCalendarNames;
  const anchor = result.plan.start;
  const activeAllDayEvents = getAllDayEvents(result.events).filter((event) =>
    eventOverlapsPoint(event, anchor),
  );
  const timedEvents = getTimedEvents(result.events).filter(
    (event) => new Date(event.endIso).getTime() > anchor.getTime(),
  );
  const shouldListMultiple =
    /\b(?:morning|afternoon|evening|tonight)\b/.test(result.plan.label) ||
    result.plan.label === 'coming up' ||
    result.plan.awarenessKind === 'coming_up_soon';

  if (timedEvents.length === 0) {
    if (activeAllDayEvents.length > 0 && !result.plan.nextTimedOnly) {
      const lines = [
        `The next thing on ${formatSubjectLabel(result.plan)} is an all-day event.`,
        ...formatGroupedEvents(
          activeAllDayEvents,
          result.plan.timeZone,
          forceIncludeCalendarName,
        ),
        ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
      ];
      return lines.filter(Boolean).join('\n');
    }

    if (!fullyConfirmed) {
      return `I didn't find anything else coming up on ${formatSubjectLabel(
        result.plan,
      )} in the calendars I could read.${incompleteNote}`;
    }

    if (result.plan.awarenessKind === 'coming_up_soon') {
      return `I don't see anything coming up in the next 2 hours.`;
    }

    return result.plan.nextTimedOnly
      ? `I don't see a timed event coming up ${result.plan.label === 'next' ? 'next' : result.plan.label}.`
      : `I don't see anything else coming up ${result.plan.label === 'next' ? 'next' : result.plan.label}.`;
  }

  if (shouldListMultiple) {
    const lines = [
      result.plan.awarenessKind === 'coming_up_soon'
        ? 'Coming up in the next 2 hours:'
        : `Coming up ${result.plan.label}:`,
      ...formatGroupedEvents(
        timedEvents.slice(0, 3),
        result.plan.timeZone,
        forceIncludeCalendarName,
      ),
      ...(timedEvents.length > 3 ? ['- And more later.'] : []),
      ...(activeAllDayEvents.length > 0 && !result.plan.nextTimedOnly
        ? [
            '',
            'All-day events:',
            ...formatGroupedEvents(
              activeAllDayEvents,
              result.plan.timeZone,
              forceIncludeCalendarName,
            ),
          ]
        : []),
      ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
    ];
    return lines.filter(Boolean).join('\n');
  }

  const nextEvent = timedEvents[0]!;
  const isInProgress =
    new Date(nextEvent.startIso).getTime() <= anchor.getTime() &&
    new Date(nextEvent.endIso).getTime() > anchor.getTime();
  const lines = [
    `${
      result.plan.label === 'after this'
        ? 'After this:'
        : isInProgress
          ? 'Right now:'
          : 'Next up:'
    } ${formatEventSummary(nextEvent, result.plan.timeZone, forceIncludeCalendarName)}`,
    ...(activeAllDayEvents.length > 0 && !result.plan.nextTimedOnly
      ? [
          `All day: ${activeAllDayEvents
            .slice(0, 2)
            .map((event) =>
              formatEventSummary(
                event,
                result.plan.timeZone,
                forceIncludeCalendarName,
              ),
            )
            .join(' | ')}`,
        ]
      : []),
    ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildOpenWindowsReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string {
  const { fullyConfirmed, incompleteNote, incompleteNoteBody } = statusContext;
  const timedEvents = getTimedEvents(result.events);
  const allDayEvents = getAllDayEvents(result.events);
  const minimumOpenMinutes = result.plan.minimumOpenMinutes || 30;
  const openings = buildOpenWindows(
    result.plan.start,
    result.plan.end,
    buildBusyWindows(timedEvents),
  ).filter(
    (window) =>
      window.end.getTime() - window.start.getTime() >=
      minimumOpenMinutes * 60 * 1000,
  );

  const openingLabel =
    minimumOpenMinutes === 30
      ? '30-minute openings'
      : `${minimumOpenMinutes}-minute openings`;

  if (openings.length === 0) {
    if (!fullyConfirmed) {
      return `I couldn't find any clear ${openingLabel} ${result.plan.label} in the calendars I could read.${incompleteNote}`;
    }
    return `I don't see any ${openingLabel} ${result.plan.label}.`;
  }

  const lines = [
    `You have these ${openingLabel} ${result.plan.label}:`,
    ...formatOpenWindows(openings.slice(0, 3), result.plan.timeZone),
    ...(openings.length > 3 ? ['- And more later.'] : []),
    ...(allDayEvents.length > 0
      ? [
          '',
          'All-day events:',
          ...formatGroupedEvents(
            allDayEvents,
            result.plan.timeZone,
            result.plan.forceIncludeCalendarNames,
          ),
        ]
      : []),
    ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildConflictSummaryReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string {
  const { fullyConfirmed, incompleteNote, incompleteNoteBody } = statusContext;
  const groups = buildConflictGroups(result.events);

  if (groups.length === 0) {
    if (!fullyConfirmed) {
      return `I didn't find any conflicts ${result.plan.label} in the calendars I could read.${incompleteNote}`;
    }
    return `I don't see any conflicts ${result.plan.label}.`;
  }

  return [
    `You do have conflicts ${result.plan.label}:`,
    ...formatConflictLines(
      groups,
      result.plan.timeZone,
      result.plan.forceIncludeCalendarNames,
    ),
    ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
  ]
    .filter(Boolean)
    .join('\n');
}

function buildDefaultCalendarReply(
  result: CalendarLookupResult,
  statusContext: CalendarReplyStatusContext,
): string {
  const { fullyConfirmed, incompleteNote, incompleteNoteBody } = statusContext;

  if (result.plan.reasoningMode === 'availability_back_to_back') {
    const clusters = buildAdjacencyClusters(result.events);
    if (clusters.length === 0) {
      if (!fullyConfirmed) {
        return `I didn't find any back-to-back meetings ${result.plan.label} in the calendars I could read.${incompleteNote}`;
      }
      return `You don't have any back-to-back meetings ${result.plan.label}.`;
    }

    const clusterLines = clusters.map((cluster) => {
      const parts = cluster.map(
        (event) =>
          `${formatTimeRange(event, result.plan.timeZone)} ${event.title}`,
      );
      return `- ${parts.join(' -> ')}`;
    });
    return [
      `You do have back-to-back meetings ${result.plan.label}:`,
      ...clusterLines,
      ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (
    result.plan.reasoningMode === 'availability_point' ||
    result.plan.reasoningMode === 'availability_duration' ||
    result.plan.reasoningMode === 'availability_range'
  ) {
    const timedEvents = getTimedEvents(result.events);
    const allDayEvents = getAllDayEvents(result.events);

    if (result.plan.reasoningMode === 'availability_point') {
      if (timedEvents.length === 0) {
        if (!fullyConfirmed) {
          return `I didn't find anything blocking ${result.plan.label} in the calendars I could read.${incompleteNote}`;
        }
        const allDayNote =
          allDayEvents.length > 0
            ? `\n\nAll-day events:\n${formatGroupedEvents(
                allDayEvents,
                result.plan.timeZone,
                result.plan.forceIncludeCalendarNames,
              ).join('\n')}`
            : '';
        return `You look free ${result.plan.label}.${allDayNote}`;
      }

      return [
        `You're not free ${result.plan.label}.`,
        ...formatGroupedEvents(
          timedEvents,
          result.plan.timeZone,
          result.plan.forceIncludeCalendarNames,
        ),
        ...(allDayEvents.length > 0
          ? [
              '',
              'All-day events:',
              ...formatGroupedEvents(
                allDayEvents,
                result.plan.timeZone,
                result.plan.forceIncludeCalendarNames,
              ),
            ]
          : []),
        ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
      ]
        .filter(Boolean)
        .join('\n');
    }

    if (
      result.plan.reasoningMode === 'availability_duration' &&
      result.plan.pointInTime &&
      result.plan.durationMinutes
    ) {
      if (timedEvents.length === 0) {
        if (!fullyConfirmed) {
          return `I didn't find anything blocking ${result.plan.label} for ${result.plan.durationLabel || `${result.plan.durationMinutes} minutes`} in the calendars I could read.${incompleteNote}`;
        }
        return `Yes, you have time ${result.plan.label} for ${result.plan.durationLabel || `${result.plan.durationMinutes} minutes`}.`;
      }

      return [
        `No, you don't have a full ${result.plan.durationLabel || `${result.plan.durationMinutes} minutes`} ${result.plan.label}.`,
        ...formatGroupedEvents(
          timedEvents,
          result.plan.timeZone,
          result.plan.forceIncludeCalendarNames,
        ),
        ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
      ]
        .filter(Boolean)
        .join('\n');
    }

    const busyWindows = buildBusyWindows(timedEvents);
    const openWindows = buildOpenWindows(
      result.plan.start,
      result.plan.end,
      busyWindows,
    );
    const rangeEvents = formatGroupedEvents(
      timedEvents,
      result.plan.timeZone,
      result.plan.forceIncludeCalendarNames,
    );
    const allDayLines =
      allDayEvents.length > 0
        ? [
            '',
            'All-day events:',
            ...formatGroupedEvents(
              allDayEvents,
              result.plan.timeZone,
              result.plan.forceIncludeCalendarNames,
            ),
          ]
        : [];

    if (timedEvents.length === 0) {
      if (!fullyConfirmed) {
        return `I didn't find anything blocking ${result.plan.label} in the calendars I could read.${incompleteNote}`;
      }
      return [`You look open ${result.plan.label}.`, ...allDayLines]
        .filter(Boolean)
        .join('\n');
    }

    if (openWindows.length === 0) {
      return [
        `You're busy ${result.plan.label}.`,
        ...rangeEvents,
        ...allDayLines,
        ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
      ]
        .filter(Boolean)
        .join('\n');
    }

    return [
      `You're partly open ${result.plan.label}.`,
      ...rangeEvents,
      '',
      ...formatOpenWindows(openWindows, result.plan.timeZone),
      ...allDayLines,
      ...(fullyConfirmed ? [] : ['', incompleteNoteBody]),
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (result.events.length === 0) {
    if (!fullyConfirmed) {
      const inspected =
        result.plan.intent === 'availability'
          ? `I didn't find anything blocking ${result.plan.label} in the calendars I could read.`
          : `I didn't find anything on ${formatSubjectLabel(result.plan)} ${result.plan.label} in the calendars I could read.`;
      return `${inspected}${incompleteNote}`;
    }

    if (result.plan.intent === 'availability') {
      return `You look free ${result.plan.label}.`;
    }
    return `I don't see anything on ${formatSubjectLabel(result.plan)} ${result.plan.label}.`;
  }

  const header =
    result.plan.intent === 'availability'
      ? `You're not free ${result.plan.label}.`
      : `Here's what's on ${formatSubjectLabel(result.plan)} ${result.plan.label}:`;
  const lines = formatGroupedEvents(
    result.events,
    result.plan.timeZone,
    result.plan.forceIncludeCalendarNames,
  );
  return `${header}\n${lines.join('\n')}${!fullyConfirmed ? `\n\nI found these events, but I couldn't read every configured calendar right now.\n${formatStatusDetailList(statusContext.incompleteStatuses)}` : ''}`;
}

export function formatCalendarAssistantReply(
  result: CalendarLookupResult,
): string {
  const statusContext = buildReplyStatusContext(result);
  const unavailableReply = buildUnavailableCalendarReply(result, statusContext);
  if (unavailableReply) {
    return unavailableReply;
  }

  if (
    result.plan.reasoningMode === 'agenda_briefing_day' ||
    result.plan.reasoningMode === 'agenda_briefing_week'
  ) {
    return buildBriefingReply(result, statusContext);
  }

  if (result.plan.reasoningMode === 'agenda_next') {
    return buildNextReply(result, statusContext);
  }

  if (result.plan.reasoningMode === 'availability_open_windows') {
    return buildOpenWindowsReply(result, statusContext);
  }

  if (result.plan.reasoningMode === 'availability_conflicts') {
    return buildConflictSummaryReply(result, statusContext);
  }

  return buildDefaultCalendarReply(result, statusContext);
}

function toActiveEventContext(
  event: CalendarEvent | null | undefined,
): CalendarActiveEventContext | null {
  if (!event || event.providerId !== 'google_calendar' || !event.calendarId) {
    return null;
  }

  return {
    providerId: event.providerId,
    id: event.id,
    title: event.title,
    startIso: event.startIso,
    endIso: event.endIso,
    allDay: event.allDay,
    calendarId: event.calendarId || null,
    calendarName: event.calendarName || null,
    htmlLink: event.htmlLink || null,
  };
}

function selectAgendaNextActiveEvent(
  result: CalendarLookupResult,
): CalendarEvent | null {
  const shouldListMultiple =
    /\b(?:morning|afternoon|evening|tonight)\b/.test(result.plan.label) ||
    result.plan.label === 'coming up' ||
    result.plan.awarenessKind === 'coming_up_soon';
  if (shouldListMultiple) {
    return null;
  }

  const anchor = result.plan.start;
  const timedEvents = getTimedEvents(result.events).filter(
    (event) => new Date(event.endIso).getTime() > anchor.getTime(),
  );
  if (timedEvents.length > 0) {
    return timedEvents[0]!;
  }

  if (result.plan.nextTimedOnly) {
    return null;
  }

  const activeAllDayEvents = getAllDayEvents(result.events).filter((event) =>
    eventOverlapsPoint(event, anchor),
  );
  return activeAllDayEvents.length === 1 ? activeAllDayEvents[0]! : null;
}

function selectActiveEventContext(
  result: CalendarLookupResult,
): CalendarActiveEventContext | null {
  if (
    result.plan.reasoningMode === 'agenda_briefing_day' ||
    result.plan.reasoningMode === 'agenda_briefing_week' ||
    result.plan.reasoningMode === 'availability_range' ||
    result.plan.reasoningMode === 'availability_duration' ||
    result.plan.reasoningMode === 'availability_back_to_back' ||
    result.plan.reasoningMode === 'availability_open_windows' ||
    result.plan.reasoningMode === 'availability_conflicts'
  ) {
    return null;
  }

  if (result.plan.reasoningMode === 'agenda_next') {
    return toActiveEventContext(selectAgendaNextActiveEvent(result));
  }

  if (
    (result.plan.reasoningMode === 'agenda' ||
      result.plan.reasoningMode === 'availability_point') &&
    result.events.length === 1
  ) {
    return toActiveEventContext(result.events[0]);
  }

  return null;
}

export async function buildCalendarAssistantResponse(
  message: string,
  deps: CalendarAssistantDeps & {
    now?: Date;
    timeZone?: string;
  } = {},
): Promise<CalendarAssistantResponse | null> {
  const plan = planCalendarAssistantLookup(
    message,
    deps.now || new Date(),
    deps.timeZone || TIMEZONE,
    deps.activeEventContext || null,
  );
  if (!plan) return null;
  if (plan.clarificationQuestion) {
    return {
      reply: plan.clarificationQuestion,
      schedulingContext:
        plan.durationMinutes && plan.requestedTitle
          ? {
              title: plan.requestedTitle,
              durationMinutes: plan.durationMinutes,
              timeZone: plan.timeZone,
            }
          : null,
      activeEventContext: null,
    };
  }
  const result = await lookupCalendarAssistantEvents(plan, deps);
  return {
    reply: formatCalendarAssistantReply(result),
    schedulingContext:
      plan.durationMinutes && plan.requestedTitle
        ? {
            title: plan.requestedTitle,
            durationMinutes: plan.durationMinutes,
            timeZone: plan.timeZone,
          }
        : null,
    activeEventContext: selectActiveEventContext(result),
  };
}

export async function buildCalendarAssistantReply(
  message: string,
  deps: CalendarAssistantDeps & {
    now?: Date;
    timeZone?: string;
  } = {},
): Promise<string | null> {
  const response = await buildCalendarAssistantResponse(message, deps);
  return response?.reply || null;
}
