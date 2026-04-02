import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import {
  buildCalendarAssistantResponse,
  lookupCalendarAssistantEvents,
  planCalendarAssistantLookup,
  type CalendarActiveEventContext,
  type CalendarEvent,
  type CalendarLookupResult,
} from './calendar-assistant.js';
import {
  listGoogleCalendars,
  listGoogleCalendarEvents,
  resolveGoogleCalendarConfig,
  type GoogleCalendarMetadata,
  type GoogleCalendarEventRecord,
} from './google-calendar.js';
import type { ScheduledTask } from './types.js';

const DEFAULT_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;
const CONFIRM_PATTERN =
  /^(?:yes|yep|yeah|confirm|save it|save|replace it|replace|turn it off|disable it|pause it|resume|resume it|turn it back on|enable it|delete it|remove it|go ahead|ok|okay)\b/i;
const DEFAULT_BRIEFING_MORNING_HOUR = 7;
const DEFAULT_BRIEFING_EVENING_HOUR = 19;
const DEFAULT_BRIEFING_NIGHT_HOUR = 20;
const DEFAULT_AUTOMATION_INTERVAL_MINUTES = 5;

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

type FetchLike = typeof fetch;

export type CalendarAutomationType = 'briefing' | 'event_reminder' | 'watch';
export type CalendarAutomationScopeKind =
  | 'all'
  | 'family_shared'
  | 'named_calendar';
type CalendarAutomationTriggerKind = 'daily' | 'weekdays' | 'weekly' | 'once';
type CalendarReminderSelector = 'next_meeting' | 'first_event_today';
type CalendarWatchCondition = 'back_to_back' | 'no_gap' | 'packed_day';

type CalendarAutomationMutationMode =
  | 'create'
  | 'replace'
  | 'pause'
  | 'resume'
  | 'delete';

export interface CalendarAutomationDedupeState {
  version: 1;
  keys: string[];
  updatedAt: string;
}

export interface CronCalendarAutomationSchedule {
  kind: 'cron';
  triggerKind: Exclude<CalendarAutomationTriggerKind, 'once'>;
  weekday: number | null;
  hour: number;
  minute: number;
  scheduleType: 'cron';
  scheduleValue: string;
  description: string;
}

export interface IntervalCalendarAutomationSchedule {
  kind: 'interval';
  triggerKind: 'daily';
  intervalMinutes: number;
  scheduleType: 'interval';
  scheduleValue: string;
  description: string;
}

export interface OnceCalendarAutomationSchedule {
  kind: 'once';
  triggerKind: 'once';
  runAtIso: string;
  hour: number;
  minute: number;
  scheduleType: 'once';
  scheduleValue: string;
  description: string;
}

export type CalendarAutomationSchedule =
  | CronCalendarAutomationSchedule
  | IntervalCalendarAutomationSchedule
  | OnceCalendarAutomationSchedule;

interface BaseCalendarAutomationConfig {
  kind: CalendarAutomationType;
  scopeKind: CalendarAutomationScopeKind;
  scopeCalendarId?: string | null;
  scopeCalendarSummary?: string | null;
  schedule: CalendarAutomationSchedule;
}

export interface BriefingCalendarAutomationConfig extends BaseCalendarAutomationConfig {
  kind: 'briefing';
  query: string;
  anchorOffsetDays: number;
}

export interface EventReminderCalendarAutomationConfig extends BaseCalendarAutomationConfig {
  kind: 'event_reminder';
  selector: CalendarReminderSelector;
  offsetMinutes: number;
  offsetLabel: string;
  weekdays: number[] | null;
}

export interface WatchCalendarAutomationConfig extends BaseCalendarAutomationConfig {
  kind: 'watch';
  condition: CalendarWatchCondition;
  query: string;
  minimumGapMinutes: number | null;
}

export type CalendarAutomationConfig =
  | BriefingCalendarAutomationConfig
  | EventReminderCalendarAutomationConfig
  | WatchCalendarAutomationConfig;

export interface CalendarAutomationSummary {
  taskId: string;
  chatJid: string;
  groupFolder: string;
  label: string;
  status: ScheduledTask['status'];
  nextRun: string | null;
  createdAt: string;
  updatedAt: string;
  config: CalendarAutomationConfig;
  dedupeState: CalendarAutomationDedupeState | null;
}

export interface CalendarAutomationRecordInput {
  task_id: string;
  chat_jid: string;
  group_folder: string;
  automation_type: CalendarAutomationType;
  label: string;
  config_json: string;
  dedupe_state_json: string | null;
  created_at: string;
  updated_at: string;
  status: ScheduledTask['status'];
  next_run: string | null;
}

export interface CalendarAutomationDraft {
  label: string;
  config: CalendarAutomationConfig;
  replaceTaskId: string | null;
  replaceLabel: string | null;
}

interface CalendarAutomationScopeSelection {
  scopeKind: CalendarAutomationScopeKind;
  scopeCalendarId: string | null;
  scopeCalendarSummary: string | null;
}

interface CalendarAutomationPlanDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  configuredCalendars?: GoogleCalendarMetadata[];
}

interface PendingWatchAutomationTemplate {
  kind: 'watch';
  condition: CalendarWatchCondition;
  scope: CalendarAutomationScopeSelection;
  resumeOnSave?: boolean;
  schedule:
    | Omit<
        CronCalendarAutomationSchedule,
        'hour' | 'minute' | 'scheduleValue' | 'description'
      >
    | {
        kind: 'once';
        triggerKind: 'once';
        targetDayIso: string;
      };
  query: string;
  minimumGapMinutes: number | null;
  labelPrefix: string;
}

interface PendingEventReminderAutomationTemplate {
  kind: 'event_reminder';
  selector: CalendarReminderSelector;
  scope: CalendarAutomationScopeSelection;
  weekdays: number[] | null;
  labelPrefix: string;
}

export type PendingCalendarAutomationState =
  | {
      version: 1;
      createdAt: string;
      step: 'clarify_time';
      replaceTaskId: string | null;
      replaceLabel: string | null;
      template: PendingWatchAutomationTemplate;
    }
  | {
      version: 1;
      createdAt: string;
      step: 'clarify_offset';
      replaceTaskId: string | null;
      replaceLabel: string | null;
      template: PendingEventReminderAutomationTemplate;
    }
  | {
      version: 1;
      createdAt: string;
      step: 'confirm';
      draft: CalendarAutomationDraft;
      mode: CalendarAutomationMutationMode;
      targetTaskId: string | null;
      targetStatus: ScheduledTask['status'] | null;
    };

export type CalendarAutomationPlanResult =
  | { kind: 'none' }
  | { kind: 'list'; message: string }
  | {
      kind: 'awaiting_input';
      state: PendingCalendarAutomationState;
      message: string;
    };

export type PendingCalendarAutomationResult =
  | { kind: 'no_match' }
  | { kind: 'cancelled'; message: string }
  | {
      kind: 'awaiting_input';
      state: PendingCalendarAutomationState;
      message: string;
    }
  | { kind: 'confirmed'; state: PendingCalendarAutomationState };

export interface CalendarAutomationPersistInput {
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>;
  automation: Omit<
    CalendarAutomationRecordInput,
    'status' | 'next_run' | 'created_at' | 'updated_at'
  > & {
    dedupe_state_json: string | null;
  };
  replaceTaskId: string | null;
}

export interface CalendarAutomationExecutionResult {
  message: string | null;
  summary: string;
  dedupeState: CalendarAutomationDedupeState | null;
}

interface CalendarAutomationExecutionDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  timeZone?: string;
  now?: Date;
}

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

function setLocalTime(date: Date, hour: number, minute = 0): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

function formatClockLabel(hour: number, minute: number): string {
  const displayHour = hour % 12 || 12;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return minute === 0
    ? `${displayHour}:00 ${suffix}`
    : `${displayHour}:${pad(minute)} ${suffix}`;
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
): { hour: number; minute: number; label: string } | null {
  const rawHour = Number(hoursText);
  const minute = minutesText ? Number(minutesText) : 0;
  if (!Number.isInteger(rawHour) || !Number.isInteger(minute)) {
    return null;
  }
  if (minute < 0 || minute > 59) {
    return null;
  }

  let hour: number | null = null;
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) {
      return null;
    }
    const lower = meridiem.toLowerCase();
    hour =
      rawHour === 12
        ? lower === 'am'
          ? 0
          : 12
        : lower === 'pm'
          ? rawHour + 12
          : rawHour;
  } else {
    hour = inferClockHourWithoutMeridiem(rawHour);
  }

  if (hour === null) {
    return null;
  }

  return {
    hour,
    minute,
    label: formatClockLabel(hour, minute),
  };
}

function parseExplicitClockTime(
  normalized: string,
): { hour: number; minute: number; label: string } | null {
  const match = normalized.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) {
    return null;
  }
  return parseLooseClockTime(match[1], match[2], match[3]);
}

function parseStandaloneClockReply(
  normalized: string,
): { hour: number; minute: number; label: string } | null {
  const match = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) {
    return null;
  }
  return parseLooseClockTime(match[1], match[2], match[3]);
}

function parseBeforeOffsetMinutes(normalized: string): number | null {
  const minuteMatch = normalized.match(
    /\b(\d{1,3})\s*(minutes?|mins?)\s+before\b/i,
  );
  if (minuteMatch) {
    return Number(minuteMatch[1]);
  }
  const hourMatch = normalized.match(
    /\b(?:(an?|one)\s+hour|(\d{1,2})\s*(hours?|hrs?))\s+before\b/i,
  );
  if (hourMatch) {
    if (hourMatch[2]) {
      return Number(hourMatch[2]) * 60;
    }
    return 60;
  }
  return null;
}

function formatOffsetLabel(minutes: number): string {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour before' : `${hours} hours before`;
  }
  return minutes === 1 ? '1 minute before' : `${minutes} minutes before`;
}

function isExpired(createdAt: string, now: Date): boolean {
  return (
    now.getTime() - new Date(createdAt).getTime() > DEFAULT_CONFIRMATION_TTL_MS
  );
}

export function isPendingCalendarAutomationExpired(
  state: PendingCalendarAutomationState,
  now = new Date(),
): boolean {
  return isExpired(state.createdAt, now);
}

function normalizeAutomationMatchText(value: string): string {
  return collapseWhitespace(
    value
      .toLowerCase()
      .replace(
        /\b(?:my|the|a|an|calendar|automations?|automation|summary|brief|reminder|watch|schedule)\b/g,
        ' ',
      ),
  );
}

function buildCronExpression(
  hour: number,
  minute: number,
  triggerKind: Exclude<CalendarAutomationTriggerKind, 'once'>,
  weekday: number | null,
): string {
  if (triggerKind === 'weekdays') {
    return `${minute} ${hour} * * 1-5`;
  }
  if (triggerKind === 'weekly' && weekday !== null) {
    return `${minute} ${hour} * * ${weekday}`;
  }
  return `${minute} ${hour} * * *`;
}

function buildCronSchedule(input: {
  triggerKind: Exclude<CalendarAutomationTriggerKind, 'once'>;
  weekday?: number | null;
  hour: number;
  minute: number;
  description: string;
}): CronCalendarAutomationSchedule {
  return {
    kind: 'cron',
    triggerKind: input.triggerKind,
    weekday: input.weekday ?? null,
    hour: input.hour,
    minute: input.minute,
    scheduleType: 'cron',
    scheduleValue: buildCronExpression(
      input.hour,
      input.minute,
      input.triggerKind,
      input.weekday ?? null,
    ),
    description: input.description,
  };
}

function buildIntervalSchedule(input: {
  intervalMinutes: number;
  description: string;
}): IntervalCalendarAutomationSchedule {
  return {
    kind: 'interval',
    triggerKind: 'daily',
    intervalMinutes: input.intervalMinutes,
    scheduleType: 'interval',
    scheduleValue: String(input.intervalMinutes * 60 * 1000),
    description: input.description,
  };
}

function buildOnceSchedule(input: {
  runAt: Date;
  description: string;
}): OnceCalendarAutomationSchedule {
  return {
    kind: 'once',
    triggerKind: 'once',
    runAtIso: input.runAt.toISOString(),
    hour: input.runAt.getHours(),
    minute: input.runAt.getMinutes(),
    scheduleType: 'once',
    scheduleValue: toLocalTimestamp(input.runAt),
    description: input.description,
  };
}

function describeTrigger(
  triggerKind: CalendarAutomationTriggerKind,
  hour: number,
  minute: number,
  weekday: number | null = null,
): string {
  const time = formatClockLabel(hour, minute);
  if (triggerKind === 'weekdays') {
    return `every weekday at ${time}`;
  }
  if (triggerKind === 'weekly' && weekday !== null) {
    const weekdayName = Object.entries(WEEKDAY_INDEX).find(
      ([, index]) => index === weekday,
    )?.[0];
    return `every ${weekdayName || 'week'} at ${time}`;
  }
  if (triggerKind === 'once') {
    return `at ${time}`;
  }
  return `every day at ${time}`;
}

function createScopeSelection(
  scopeKind: CalendarAutomationScopeKind,
  calendar?: Pick<GoogleCalendarMetadata, 'id' | 'summary'> | null,
): CalendarAutomationScopeSelection {
  return {
    scopeKind,
    scopeCalendarId:
      scopeKind === 'named_calendar' ? calendar?.id || null : null,
    scopeCalendarSummary:
      scopeKind === 'named_calendar' ? calendar?.summary || null : null,
  };
}

function getScopeSelectionFromConfig(
  config: CalendarAutomationConfig,
): CalendarAutomationScopeSelection {
  return {
    scopeKind: config.scopeKind,
    scopeCalendarId: config.scopeCalendarId || null,
    scopeCalendarSummary: config.scopeCalendarSummary || null,
  };
}

function resolveBriefingScopeKind(
  normalized: string,
): CalendarAutomationScopeKind {
  return /\bfamily calendar\b/.test(normalized) ? 'family_shared' : 'all';
}

function extractNamedCalendarHint(normalized: string): string | null {
  if (/\bfamily calendar\b/.test(normalized)) {
    return null;
  }

  const patterns = [
    /\b(?:on|from|for)\s+(?:my\s+|the\s+)?(.+?)\s+calendar\b/i,
    /\bbefore\s+(?:anything\s+on\s+)?(?:my\s+|the\s+)?(.+?)\s+calendar\b/i,
    /\b([a-z0-9][a-z0-9 '&/-]+?)\s+calendar\s+(?:summary|brief)\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const hint = match?.[1]
      ?.trim()
      .replace(/^(?:my|the)\s+/i, '')
      .replace(/\s+/g, ' ');
    if (!hint) {
      continue;
    }
    if (['my', 'the', 'your'].includes(hint.toLowerCase())) {
      continue;
    }
    return hint;
  }
  return null;
}

function normalizeCalendarMatchText(value: string): string {
  return collapseWhitespace(
    value
      .toLowerCase()
      .replace(/[^\w\s&'/-]+/g, ' ')
      .replace(/\bcalendar\b/g, ' '),
  );
}

function scoreNamedCalendarMatch(summary: string, hint: string): number {
  const normalizedSummary = normalizeCalendarMatchText(summary);
  const normalizedHint = normalizeCalendarMatchText(hint);
  if (!normalizedSummary || !normalizedHint) {
    return 0;
  }
  if (normalizedSummary === normalizedHint) {
    return 4;
  }
  if (normalizedSummary.includes(normalizedHint)) {
    return 3;
  }
  const terms = normalizedHint.split(' ').filter((term) => term.length >= 2);
  if (
    terms.length > 0 &&
    terms.every((term) => normalizedSummary.includes(term))
  ) {
    return 2;
  }
  return 0;
}

async function listConfiguredGoogleCalendars(
  deps: CalendarAutomationPlanDeps,
): Promise<GoogleCalendarMetadata[]> {
  if (deps.configuredCalendars) {
    return deps.configuredCalendars;
  }
  return listGoogleCalendars(
    resolveGoogleCalendarConfig(deps.env),
    deps.fetchImpl,
  );
}

type ScopeResolutionResult =
  | {
      kind: 'resolved';
      scope: CalendarAutomationScopeSelection;
    }
  | {
      kind: 'ambiguous';
      hint: string;
      calendars: GoogleCalendarMetadata[];
    }
  | {
      kind: 'missing';
      hint: string;
      calendars: GoogleCalendarMetadata[];
    };

async function resolveAutomationScopeSelection(
  normalized: string,
  deps: CalendarAutomationPlanDeps,
): Promise<ScopeResolutionResult> {
  if (/\bfamily calendar\b/.test(normalized)) {
    return {
      kind: 'resolved',
      scope: createScopeSelection('family_shared'),
    };
  }

  const hint = extractNamedCalendarHint(normalized);
  if (!hint) {
    return {
      kind: 'resolved',
      scope: createScopeSelection('all'),
    };
  }

  const calendars = (await listConfiguredGoogleCalendars(deps)).filter(
    (calendar) => calendar.selected,
  );
  const scored = calendars
    .map((calendar) => ({
      calendar,
      score: scoreNamedCalendarMatch(calendar.summary, hint),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      kind: 'missing',
      hint,
      calendars,
    };
  }

  const bestScore = scored[0]!.score;
  const matches = scored
    .filter((item) => item.score === bestScore)
    .map((item) => item.calendar);

  if (matches.length !== 1) {
    return {
      kind: 'ambiguous',
      hint,
      calendars: matches,
    };
  }

  return {
    kind: 'resolved',
    scope: createScopeSelection('named_calendar', matches[0]!),
  };
}

function resolveBriefingDefaults(normalized: string): {
  query: string;
  anchorOffsetDays: number;
  labelPrefix: string;
} | null {
  const scopeKind = resolveBriefingScopeKind(normalized);
  if (scopeKind === 'family_shared') {
    return {
      query: "What's on the family calendar this week?",
      anchorOffsetDays:
        /\bevery sunday\b/.test(normalized) ||
        /\bsunday night\b/.test(normalized)
          ? 1
          : 0,
      labelPrefix: 'Family calendar summary',
    };
  }

  if (/\bweekend\b/.test(normalized)) {
    return {
      query: 'Anything important this weekend?',
      anchorOffsetDays: 0,
      labelPrefix: 'Weekend brief',
    };
  }

  if (/\btomorrow\b/.test(normalized) || /\bevening\b/.test(normalized)) {
    return {
      query: "What's my day look like tomorrow?",
      anchorOffsetDays: 0,
      labelPrefix: 'Tomorrow brief',
    };
  }

  return {
    query: 'What should I know about today?',
    anchorOffsetDays: 0,
    labelPrefix: 'Morning brief',
  };
}

function parseRecurringTrigger(
  normalized: string,
  explicitTime: { hour: number; minute: number; label: string } | null,
  defaults: { morning?: boolean; evening?: boolean; night?: boolean } = {},
): CronCalendarAutomationSchedule | null {
  const time =
    explicitTime ||
    (defaults.morning
      ? {
          hour: DEFAULT_BRIEFING_MORNING_HOUR,
          minute: 0,
          label: formatClockLabel(DEFAULT_BRIEFING_MORNING_HOUR, 0),
        }
      : defaults.evening
        ? {
            hour: DEFAULT_BRIEFING_EVENING_HOUR,
            minute: 0,
            label: formatClockLabel(DEFAULT_BRIEFING_EVENING_HOUR, 0),
          }
        : defaults.night
          ? {
              hour: DEFAULT_BRIEFING_NIGHT_HOUR,
              minute: 0,
              label: formatClockLabel(DEFAULT_BRIEFING_NIGHT_HOUR, 0),
            }
          : null);

  if (/\bevery weekday\b/.test(normalized) || /\bworkday\b/.test(normalized)) {
    if (!time) return null;
    return buildCronSchedule({
      triggerKind: 'weekdays',
      hour: time.hour,
      minute: time.minute,
      description: describeTrigger('weekdays', time.hour, time.minute),
    });
  }

  const weeklyMatch = normalized.match(
    /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (weeklyMatch) {
    if (!time) return null;
    const weekday = WEEKDAY_INDEX[weeklyMatch[1]];
    return buildCronSchedule({
      triggerKind: 'weekly',
      weekday,
      hour: time.hour,
      minute: time.minute,
      description: describeTrigger('weekly', time.hour, time.minute, weekday),
    });
  }

  if (
    /\bevery day\b/.test(normalized) ||
    /\bdaily\b/.test(normalized) ||
    /\bevery morning\b/.test(normalized) ||
    /\bevery evening\b/.test(normalized) ||
    /\bevery night\b/.test(normalized)
  ) {
    if (!time) return null;
    return buildCronSchedule({
      triggerKind: 'daily',
      hour: time.hour,
      minute: time.minute,
      description: describeTrigger('daily', time.hour, time.minute),
    });
  }

  return null;
}

export function computeCalendarAutomationNextRun(
  schedule: CalendarAutomationSchedule,
  now: Date,
): string | null {
  if (schedule.scheduleType === 'interval') {
    return new Date(
      now.getTime() + Number(schedule.scheduleValue),
    ).toISOString();
  }
  if (schedule.scheduleType === 'once') {
    return new Date(schedule.runAtIso).toISOString();
  }
  const interval = CronExpressionParser.parse(schedule.scheduleValue, {
    tz: TIMEZONE,
    currentDate: now,
  });
  return interval.next().toISOString();
}

function buildAutomationSemanticKey(config: CalendarAutomationConfig): string {
  const scopeIdentity = getAutomationScopeIdentity(config);
  if (config.kind === 'briefing') {
    return `${config.kind}:${scopeIdentity}:${config.query}:${config.anchorOffsetDays}`;
  }
  if (config.kind === 'event_reminder') {
    return `${config.kind}:${scopeIdentity}:${config.selector}:${(
      config.weekdays || []
    ).join(',')}`;
  }
  return `${config.kind}:${scopeIdentity}:${config.condition}:${config.query}:${config.minimumGapMinutes || 0}`;
}

function getAutomationScopeIdentity(config: CalendarAutomationConfig): string {
  return config.scopeKind === 'named_calendar'
    ? `${config.scopeKind}:${config.scopeCalendarId || config.scopeCalendarSummary || 'unknown'}`
    : config.scopeKind;
}

function buildAutomationExactKey(config: CalendarAutomationConfig): string {
  const base = {
    kind: config.kind,
    scopeKind: config.scopeKind,
    scopeCalendarId: config.scopeCalendarId || null,
    scopeCalendarSummary: config.scopeCalendarSummary || null,
    scheduleKind: config.schedule.kind,
    scheduleType: config.schedule.scheduleType,
    scheduleValue: config.schedule.scheduleValue,
    description: config.schedule.description,
  };
  if (config.kind === 'briefing') {
    return JSON.stringify({
      ...base,
      query: config.query,
      anchorOffsetDays: config.anchorOffsetDays,
    });
  }
  if (config.kind === 'event_reminder') {
    return JSON.stringify({
      ...base,
      selector: config.selector,
      offsetMinutes: config.offsetMinutes,
      offsetLabel: config.offsetLabel,
      weekdays: config.weekdays || null,
    });
  }
  return JSON.stringify({
    ...base,
    condition: config.condition,
    query: config.query,
    minimumGapMinutes: config.minimumGapMinutes || null,
  });
}

function findDuplicateAutomation(
  draft: CalendarAutomationDraft,
  existing: CalendarAutomationSummary[],
):
  | { kind: 'none' }
  | { kind: 'exact_active'; automation: CalendarAutomationSummary }
  | { kind: 'exact_paused'; automation: CalendarAutomationSummary }
  | { kind: 'replace'; automation: CalendarAutomationSummary } {
  const semanticKey = buildAutomationSemanticKey(draft.config);
  const exactKey = buildAutomationExactKey(draft.config);
  const matching = existing.filter(
    (item) =>
      item.status !== 'completed' &&
      buildAutomationSemanticKey(item.config) === semanticKey,
  );
  const exact = matching.find(
    (item) => buildAutomationExactKey(item.config) === exactKey,
  );
  if (exact) {
    if (exact.status === 'paused') {
      return { kind: 'exact_paused', automation: exact };
    }
    return { kind: 'exact_active', automation: exact };
  }
  const replace = matching[0];
  if (replace) {
    return { kind: 'replace', automation: replace };
  }
  return { kind: 'none' };
}

function buildCreateAutomationResult(
  draft: CalendarAutomationDraft,
  existing: CalendarAutomationSummary[],
  now: Date,
): CalendarAutomationPlanResult {
  const duplicate = findDuplicateAutomation(draft, existing);
  if (duplicate.kind === 'exact_active') {
    return {
      kind: 'list',
      message: `"${duplicate.automation.label}" is already active.`,
    };
  }

  if (duplicate.kind === 'exact_paused') {
    return {
      kind: 'awaiting_input',
      state: {
        version: 1,
        createdAt: now.toISOString(),
        step: 'confirm',
        draft: {
          label: duplicate.automation.label,
          config: duplicate.automation.config,
          replaceTaskId: null,
          replaceLabel: null,
        },
        mode: 'resume',
        targetTaskId: duplicate.automation.taskId,
        targetStatus: duplicate.automation.status,
      },
      message: `"${duplicate.automation.label}" is paused.\n\nReply "yes" to resume it or "cancel" to leave it paused.`,
    };
  }

  const nextDraft =
    duplicate.kind === 'replace'
      ? {
          ...draft,
          replaceTaskId: duplicate.automation.taskId,
          replaceLabel: duplicate.automation.label,
        }
      : draft;

  const state: PendingCalendarAutomationState = {
    version: 1,
    createdAt: now.toISOString(),
    step: 'confirm',
    draft: nextDraft,
    mode: duplicate.kind === 'replace' ? 'replace' : 'create',
    targetTaskId:
      duplicate.kind === 'replace' ? duplicate.automation.taskId : null,
    targetStatus:
      duplicate.kind === 'replace' ? duplicate.automation.status : null,
  };

  return {
    kind: 'awaiting_input',
    state,
    message:
      duplicate.kind === 'replace'
        ? `I found an existing automation that matches this setup.\n\nCurrent: ${duplicate.automation.label}\nNew: ${nextDraft.label}\nScope: ${formatAutomationScopeLabel(nextDraft.config)}\n\nReply "yes" to replace it or "cancel" to keep the current one.`
        : `I can save this automation:\n\n- ${nextDraft.label}\n- Scope: ${formatAutomationScopeLabel(nextDraft.config)}\n\nReply "yes" to save it or "cancel" to stop.`,
  };
}

function formatCalendarOptions(calendars: GoogleCalendarMetadata[]): string {
  return calendars
    .filter((calendar) => calendar.selected)
    .map((calendar) => calendar.summary)
    .slice(0, 6)
    .join(', ');
}

function buildScopeResolutionResult(
  resolution: ScopeResolutionResult,
): CalendarAutomationPlanResult | null {
  if (resolution.kind === 'resolved') {
    return null;
  }

  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'list',
      message: `I found more than one configured calendar that matches "${resolution.hint}": ${resolution.calendars
        .map((calendar) => calendar.summary)
        .join(', ')}. Tell me which calendar you want.`,
    };
  }

  const available = formatCalendarOptions(resolution.calendars);
  return {
    kind: 'list',
    message: available
      ? `I couldn't find a configured calendar matching "${resolution.hint}". I can currently use: ${available}.`
      : `I couldn't find a configured calendar matching "${resolution.hint}".`,
  };
}

async function buildBriefingDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
  deps: CalendarAutomationPlanDeps,
): Promise<CalendarAutomationPlanResult> {
  const defaults = resolveBriefingDefaults(normalized);
  if (!defaults) return { kind: 'none' };

  const scopeResolution = await resolveAutomationScopeSelection(
    normalized,
    deps,
  );
  if (scopeResolution.kind !== 'resolved') {
    return buildScopeResolutionResult(scopeResolution)!;
  }
  const scope = scopeResolution.scope;

  const explicitTime = parseExplicitClockTime(normalized);
  const schedule = parseRecurringTrigger(normalized, explicitTime, {
    morning: /\bmorning\b/.test(normalized),
    evening: /\bevening\b/.test(normalized),
    night: /\bnight\b/.test(normalized) || /\btonight\b/.test(normalized),
  });
  if (!schedule) {
    return { kind: 'none' };
  }

  const config: BriefingCalendarAutomationConfig = {
    kind: 'briefing',
    scopeKind: scope.scopeKind,
    scopeCalendarId: scope.scopeCalendarId,
    scopeCalendarSummary: scope.scopeCalendarSummary,
    schedule,
    query: defaults.query,
    anchorOffsetDays: defaults.anchorOffsetDays,
  };
  const label = `${defaults.labelPrefix} ${schedule.description}`;
  return buildCreateAutomationResult(
    {
      label,
      config,
      replaceTaskId: null,
      replaceLabel: null,
    },
    existing,
    now,
  );
}

function parseWatchCondition(normalized: string): {
  condition: CalendarWatchCondition;
  query: string;
  minimumGapMinutes: number | null;
  labelPrefix: string;
} | null {
  if (/\bback(?:\s*|-)?to(?:\s*|-)?back\b/.test(normalized)) {
    const target = /\btomorrow\b/.test(normalized)
      ? 'tomorrow'
      : normalized.match(/\bfriday\b/i)
        ? 'Friday'
        : 'tomorrow';
    return {
      condition: 'back_to_back',
      query: `Do I have back-to-back meetings ${target}?`,
      minimumGapMinutes: null,
      labelPrefix: `Back-to-back watch for ${target.toLowerCase()}`,
    };
  }

  const noGapMatch = normalized.match(/\bno\s+(\d+)-minute gaps\b/);
  if (noGapMatch) {
    const minutes = Number(noGapMatch[1]);
    const target = /\btomorrow afternoon\b/.test(normalized)
      ? 'tomorrow afternoon'
      : /\btomorrow\b/.test(normalized)
        ? 'tomorrow'
        : normalized.match(/\bfriday afternoon\b/i)
          ? 'Friday afternoon'
          : 'tomorrow afternoon';
    return {
      condition: 'no_gap',
      query: `Do I have any gaps ${target}?`,
      minimumGapMinutes: minutes,
      labelPrefix: `No-${minutes}-minute-gap watch for ${target}`,
    };
  }

  if (/\bpacked\b/.test(normalized)) {
    const dayMatch = normalized.match(
      /\b(today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday)\b/i,
    );
    const target = dayMatch?.[1] || 'tomorrow';
    return {
      condition: 'packed_day',
      query: `What's my day look like ${target}?`,
      minimumGapMinutes: null,
      labelPrefix: `${target[0]!.toUpperCase()}${target.slice(1).toLowerCase()} packed-day watch`,
    };
  }

  return null;
}

function extractOnceWatchTargetDate(
  normalized: string,
  now: Date,
): Date | null {
  if (/\btomorrow\b/.test(normalized)) {
    return addDays(startOfDay(now), 1);
  }
  const weekdayMatch = normalized.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );
  if (weekdayMatch) {
    const weekday = WEEKDAY_INDEX[weekdayMatch[1].toLowerCase()];
    const base = startOfDay(now);
    let offset = (weekday - base.getDay() + 7) % 7;
    if (offset === 0) {
      offset = 7;
    }
    return addDays(base, offset);
  }
  return null;
}

async function buildWatchDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
  deps: CalendarAutomationPlanDeps,
): Promise<CalendarAutomationPlanResult> {
  const parsed = parseWatchCondition(normalized);
  if (!parsed) return { kind: 'none' };

  const scopeResolution = await resolveAutomationScopeSelection(
    normalized,
    deps,
  );
  if (scopeResolution.kind !== 'resolved') {
    return buildScopeResolutionResult(scopeResolution)!;
  }
  const scope = scopeResolution.scope;

  const explicitTime = parseExplicitClockTime(normalized);
  const recurringSchedule = parseRecurringTrigger(normalized, explicitTime);
  if (recurringSchedule) {
    const config: WatchCalendarAutomationConfig = {
      kind: 'watch',
      scopeKind: scope.scopeKind,
      scopeCalendarId: scope.scopeCalendarId,
      scopeCalendarSummary: scope.scopeCalendarSummary,
      schedule: recurringSchedule,
      condition: parsed.condition,
      query: parsed.query,
      minimumGapMinutes: parsed.minimumGapMinutes,
    };
    return buildCreateAutomationResult(
      {
        label: `${parsed.labelPrefix} ${recurringSchedule.description}`,
        config,
        replaceTaskId: null,
        replaceLabel: null,
      },
      existing,
      now,
    );
  }

  const targetDay = extractOnceWatchTargetDate(normalized, now);
  if (!targetDay) {
    return { kind: 'none' };
  }

  if (!explicitTime) {
    const state: PendingCalendarAutomationState = {
      version: 1,
      createdAt: now.toISOString(),
      step: 'clarify_time',
      replaceTaskId: null,
      replaceLabel: null,
      template: {
        kind: 'watch',
        condition: parsed.condition,
        scope,
        schedule: {
          kind: 'once',
          triggerKind: 'once',
          targetDayIso: targetDay.toISOString(),
        },
        query: parsed.query,
        minimumGapMinutes: parsed.minimumGapMinutes,
        labelPrefix: parsed.labelPrefix,
      },
    };
    return {
      kind: 'awaiting_input',
      state,
      message: 'What time should I run that check?',
    };
  }

  const runAt = setLocalTime(targetDay, explicitTime.hour, explicitTime.minute);
  const schedule = buildOnceSchedule({
    runAt,
    description: `at ${explicitTime.label}`,
  });
  const config: WatchCalendarAutomationConfig = {
    kind: 'watch',
    scopeKind: scope.scopeKind,
    scopeCalendarId: scope.scopeCalendarId,
    scopeCalendarSummary: scope.scopeCalendarSummary,
    schedule,
    condition: parsed.condition,
    query: parsed.query,
    minimumGapMinutes: parsed.minimumGapMinutes,
  };
  return buildCreateAutomationResult(
    {
      label: `${parsed.labelPrefix} ${schedule.description}`,
      config,
      replaceTaskId: null,
      replaceLabel: null,
    },
    existing,
    now,
  );
}

function resolveReminderAutomationWeekdays(
  normalized: string,
): { weekdays: number[] | null; recurrenceLabel: string } | null {
  if (/\bevery weekday\b/.test(normalized) || /\bworkday\b/.test(normalized)) {
    return { weekdays: [1, 2, 3, 4, 5], recurrenceLabel: 'every workday' };
  }
  if (/\bevery day\b/.test(normalized) || /\bdaily\b/.test(normalized)) {
    return { weekdays: null, recurrenceLabel: 'every day' };
  }
  return null;
}

async function buildEventReminderDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
  deps: CalendarAutomationPlanDeps,
): Promise<CalendarAutomationPlanResult> {
  const recurrence = resolveReminderAutomationWeekdays(normalized);
  if (!recurrence) {
    return { kind: 'none' };
  }

  const scopeResolution = await resolveAutomationScopeSelection(
    normalized,
    deps,
  );
  if (scopeResolution.kind !== 'resolved') {
    return buildScopeResolutionResult(scopeResolution)!;
  }
  const scope = scopeResolution.scope;

  let selector: CalendarReminderSelector | null = null;
  let labelPrefix = '';
  if (/\bnext meeting\b/.test(normalized)) {
    selector = 'next_meeting';
    labelPrefix = 'Next-meeting reminder';
  } else if (/\bfirst event\b/.test(normalized)) {
    selector = 'first_event_today';
    labelPrefix = 'First-event reminder';
  }
  if (!selector) {
    return { kind: 'none' };
  }

  const offsetMinutes = parseBeforeOffsetMinutes(normalized);
  if (!offsetMinutes) {
    const state: PendingCalendarAutomationState = {
      version: 1,
      createdAt: now.toISOString(),
      step: 'clarify_offset',
      replaceTaskId: null,
      replaceLabel: null,
      template: {
        kind: 'event_reminder',
        selector,
        scope,
        weekdays: recurrence.weekdays,
        labelPrefix: `${labelPrefix} ${recurrence.recurrenceLabel}`,
      },
    };
    return {
      kind: 'awaiting_input',
      state,
      message: 'How far before should I remind you?',
    };
  }

  const config: EventReminderCalendarAutomationConfig = {
    kind: 'event_reminder',
    scopeKind: scope.scopeKind,
    scopeCalendarId: scope.scopeCalendarId,
    scopeCalendarSummary: scope.scopeCalendarSummary,
    schedule: buildIntervalSchedule({
      intervalMinutes: DEFAULT_AUTOMATION_INTERVAL_MINUTES,
      description: recurrence.recurrenceLabel,
    }),
    selector,
    offsetMinutes,
    offsetLabel: formatOffsetLabel(offsetMinutes),
    weekdays: recurrence.weekdays,
  };
  return buildCreateAutomationResult(
    {
      label: `${labelPrefix} ${recurrence.recurrenceLabel} (${formatOffsetLabel(
        offsetMinutes,
      )})`,
      config,
      replaceTaskId: null,
      replaceLabel: null,
    },
    existing,
    now,
  );
}

function formatAutomationTypeLabel(config: CalendarAutomationConfig): string {
  if (config.kind === 'briefing') {
    return 'Briefing';
  }
  if (config.kind === 'event_reminder') {
    return 'Reminder';
  }
  return 'Watch';
}

function formatAutomationScopeLabel(config: CalendarAutomationConfig): string {
  if (config.scopeKind === 'family_shared') {
    return 'Family/shared';
  }
  if (config.scopeKind === 'named_calendar') {
    return config.scopeCalendarSummary || 'Named calendar';
  }
  return 'All calendars';
}

function formatAutomationSchedulePreview(
  automation: CalendarAutomationSummary,
  now: Date,
): string {
  if (automation.status === 'active') {
    return automation.nextRun
      ? `Next ${formatAutomationNextRun(automation.nextRun)}`
      : 'Runs on schedule';
  }

  if (automation.config.schedule.kind === 'once') {
    const runAt = new Date(automation.config.schedule.runAtIso);
    if (runAt.getTime() <= now.getTime()) {
      return 'Needs a new time';
    }
    return `Next when resumed: ${formatAutomationNextRun(
      automation.config.schedule.runAtIso,
    )}`;
  }

  const preview = computeCalendarAutomationNextRun(
    automation.config.schedule,
    now,
  );
  return preview
    ? `Next when resumed: ${formatAutomationNextRun(preview)}`
    : 'Next when resumed';
}

function listAutomationsMessage(
  automations: CalendarAutomationSummary[],
  options: {
    activeOnly?: boolean;
    now?: Date;
  } = {},
): string {
  const now = options.now || new Date();
  const visible = automations
    .filter((item) => item.status !== 'completed')
    .filter((item) => !options.activeOnly || item.status === 'active')
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === 'active' ? -1 : 1;
      }
      const leftKey = left.nextRun || left.updatedAt;
      const rightKey = right.nextRun || right.updatedAt;
      return leftKey.localeCompare(rightKey);
    });
  if (visible.length === 0) {
    return options.activeOnly
      ? "You don't have any active calendar automations."
      : "You don't have any calendar automations set up.";
  }

  const activeCount = visible.filter((item) => item.status === 'active').length;
  const pausedCount = visible.filter((item) => item.status === 'paused').length;
  const lines = [
    options.activeOnly
      ? `${activeCount} active.`
      : `${activeCount} active, ${pausedCount} paused.`,
  ];
  for (const automation of visible.slice(0, 8)) {
    lines.push(
      `- ${formatAutomationTypeLabel(automation.config)}: ${automation.label}`,
    );
    lines.push(
      `  ${
        automation.status === 'active' ? 'Active' : 'Paused'
      } · Scope: ${formatAutomationScopeLabel(
        automation.config,
      )} · ${formatAutomationSchedulePreview(automation, now)}`,
    );
  }
  if (visible.length > 8) {
    lines.push(`...and ${visible.length - 8} more.`);
  }
  return lines.join('\n');
}

function formatAutomationNextRun(nextRun: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return formatter.format(new Date(nextRun));
}

function findAutomationMatchesByTarget(
  automations: CalendarAutomationSummary[],
  targetText: string,
): CalendarAutomationSummary[] {
  const needle = normalizeAutomationMatchText(targetText);
  if (!needle) {
    return automations.length === 1 ? [automations[0]!] : [];
  }

  const exactMatches = automations.filter(
    (automation) => normalizeAutomationMatchText(automation.label) === needle,
  );
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  const prefixMatches = automations.filter((automation) =>
    normalizeAutomationMatchText(automation.label).startsWith(needle),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches;
  }

  return automations.filter((automation) =>
    normalizeAutomationMatchText(automation.label).includes(needle),
  );
}

function buildTargetAutomationListResult(
  automations: CalendarAutomationSummary[],
  now: Date,
  message: string,
): CalendarAutomationPlanResult {
  return {
    kind: 'list',
    message: `${message}\n\n${listAutomationsMessage(automations, { now })}`,
  };
}

function buildPauseResumeOrDeleteResult(
  message: string,
  automations: CalendarAutomationSummary[],
  now: Date,
  mode: 'pause' | 'resume' | 'delete',
): CalendarAutomationPlanResult {
  const targetText = collapseWhitespace(
    normalizeMessage(message)
      .replace(
        /\b(?:turn off|disable|pause|stop|delete|remove|resume|turn back on|reactivate|enable)\b/gi,
        ' ',
      )
      .replace(/\b(?:my|the)\b/gi, ' ')
      .replace(/\b(?:calendar )?automations?\b/gi, ' '),
  );
  const matches = findAutomationMatchesByTarget(
    automations.filter((item) => item.status !== 'completed'),
    targetText,
  );
  if (matches.length !== 1) {
    return buildTargetAutomationListResult(
      automations,
      now,
      matches.length > 1
        ? 'I found more than one automation that matches that.'
        : "I couldn't tell which automation you meant.",
    );
  }
  const target = matches[0]!;

  if (mode === 'pause' && target.status === 'paused') {
    return {
      kind: 'list',
      message: `"${target.label}" is already paused.`,
    };
  }
  if (mode === 'resume' && target.status === 'active') {
    return {
      kind: 'list',
      message: `"${target.label}" is already active.`,
    };
  }

  if (
    mode === 'resume' &&
    target.config.schedule.kind === 'once' &&
    new Date(target.config.schedule.runAtIso).getTime() <= now.getTime()
  ) {
    if (target.config.kind !== 'watch') {
      return {
        kind: 'list',
        message: `I need a new time before I can resume "${target.label}".`,
      };
    }
    return {
      kind: 'awaiting_input',
      state: {
        version: 1,
        createdAt: now.toISOString(),
        step: 'clarify_time',
        replaceTaskId: target.taskId,
        replaceLabel: target.label,
        template: {
          kind: 'watch',
          condition: target.config.condition,
          scope: getScopeSelectionFromConfig(target.config),
          schedule: {
            kind: 'once',
            triggerKind: 'once',
            targetDayIso: startOfDay(now).toISOString(),
          },
          query: target.config.query,
          minimumGapMinutes: target.config.minimumGapMinutes,
          labelPrefix: target.label.replace(/\sat [\s\S]+$/i, '').trim(),
          resumeOnSave: true,
        },
      },
      message: `That check needs a new time before I can resume it. What time should I use for "${target.label}"?`,
    };
  }

  const state: PendingCalendarAutomationState = {
    version: 1,
    createdAt: now.toISOString(),
    step: 'confirm',
    draft: {
      label: target.label,
      config: target.config,
      replaceTaskId: null,
      replaceLabel: null,
    },
    mode,
    targetTaskId: target.taskId,
    targetStatus: target.status,
  };
  return {
    kind: 'awaiting_input',
    state,
    message:
      mode === 'pause'
        ? `I can pause this automation:\n\n- ${target.label}\n\nReply "yes" to pause it or "cancel" to keep it running.`
        : mode === 'resume'
          ? `I can resume this automation:\n\n- ${target.label}\n\nReply "yes" to turn it back on or "cancel" to leave it paused.`
          : `I can delete this automation:\n\n- ${target.label}\n\nReply "yes" to delete it or "cancel" to keep it.`,
  };
}

function rebuildAutomationLabel(
  currentLabel: string,
  scheduleDescription: string,
): string {
  const base = currentLabel
    .replace(/\severy [\s\S]+$/i, '')
    .replace(/\sat [\s\S]+$/i, '')
    .trim();
  return `${base} ${scheduleDescription}`;
}

function rebuildAutomationWithNewTime(
  config: CalendarAutomationConfig,
  hour: number,
  minute: number,
  now: Date,
): CalendarAutomationConfig | null {
  if (config.schedule.kind === 'cron') {
    return {
      ...config,
      schedule: buildCronSchedule({
        triggerKind: config.schedule.triggerKind,
        weekday: config.schedule.weekday,
        hour,
        minute,
        description: describeTrigger(
          config.schedule.triggerKind,
          hour,
          minute,
          config.schedule.weekday,
        ),
      }),
    } as CalendarAutomationConfig;
  }

  if (config.schedule.kind === 'once') {
    const candidate = setLocalTime(now, hour, minute);
    const runAt =
      candidate.getTime() > now.getTime() ? candidate : addDays(candidate, 1);
    return {
      ...config,
      schedule: buildOnceSchedule({
        runAt,
        description: `at ${formatClockLabel(hour, minute)}`,
      }),
    } as CalendarAutomationConfig;
  }

  return null;
}

function buildReplaceResult(
  message: string,
  automations: CalendarAutomationSummary[],
  now: Date,
): CalendarAutomationPlanResult {
  const match = normalizeMessage(message).match(
    /\b(?:replace\s+(.+?)\s+with|change\s+(.+?)\s+to)\s+(.+)$/i,
  );
  if (!match) {
    return { kind: 'none' };
  }

  const targetText = match[1] || match[2] || '';
  const matches = findAutomationMatchesByTarget(
    automations.filter((item) => item.status !== 'completed'),
    targetText,
  );
  if (matches.length !== 1) {
    return buildTargetAutomationListResult(
      automations,
      now,
      matches.length > 1
        ? 'I found more than one automation that matches that change.'
        : "I couldn't tell which automation to change.",
    );
  }
  const target = matches[0]!;

  if (
    target.config.schedule.kind !== 'cron' &&
    target.config.schedule.kind !== 'once'
  ) {
    return {
      kind: 'list',
      message:
        'I can only change the trigger time for briefing and watch automations right now.',
    };
  }

  const newTime = parseStandaloneClockReply(match[3] || '');
  if (!newTime) {
    return {
      kind: 'list',
      message: 'Tell me the new time you want to use, like "6:30 AM".',
    };
  }

  const updatedConfig = rebuildAutomationWithNewTime(
    target.config,
    newTime.hour,
    newTime.minute,
    now,
  );
  if (!updatedConfig) {
    return {
      kind: 'list',
      message:
        'I can only change the trigger time for briefing and watch automations right now.',
    };
  }

  const label = rebuildAutomationLabel(
    target.label,
    updatedConfig.schedule.description,
  );
  const state: PendingCalendarAutomationState = {
    version: 1,
    createdAt: now.toISOString(),
    step: 'confirm',
    draft: {
      label,
      config: updatedConfig,
      replaceTaskId: target.taskId,
      replaceLabel: target.label,
    },
    mode: 'replace',
    targetTaskId: target.taskId,
    targetStatus: target.status,
  };

  return {
    kind: 'awaiting_input',
    state,
    message: `I can replace this automation:\n\nCurrent: ${target.label}\nNew: ${label}\nScope: ${formatAutomationScopeLabel(updatedConfig)}\n\nReply "yes" to save the new schedule or "cancel" to keep the current one.`,
  };
}

export async function planCalendarAutomation(
  message: string,
  now: Date,
  automations: CalendarAutomationSummary[],
  deps: CalendarAutomationPlanDeps = {},
): Promise<CalendarAutomationPlanResult> {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) {
    return { kind: 'none' };
  }

  if (
    /\b(show|list|what|which)\b/.test(normalized) &&
    /\b(?:calendar|schedule) automations?\b/.test(normalized)
  ) {
    const activeOnly = /\bactive\b/.test(normalized);
    return {
      kind: 'list',
      message: listAutomationsMessage(automations, { activeOnly, now }),
    };
  }

  if (/^(?:turn off|disable|pause|stop)\b/.test(normalized)) {
    return buildPauseResumeOrDeleteResult(message, automations, now, 'pause');
  }

  if (/^(?:resume|turn back on|reactivate|enable)\b/.test(normalized)) {
    return buildPauseResumeOrDeleteResult(message, automations, now, 'resume');
  }

  if (/^(?:delete|remove)\b/.test(normalized)) {
    return buildPauseResumeOrDeleteResult(message, automations, now, 'delete');
  }

  if (/^(?:replace|change)\b/i.test(normalized)) {
    return buildReplaceResult(message, automations, now);
  }

  const briefingResult = await buildBriefingDraft(
    normalized,
    now,
    automations,
    deps,
  );
  if (briefingResult.kind !== 'none') {
    return briefingResult;
  }

  const watchResult = await buildWatchDraft(normalized, now, automations, deps);
  if (watchResult.kind !== 'none') {
    return watchResult;
  }

  return buildEventReminderDraft(normalized, now, automations, deps);
}

function buildDraftFromPendingTemplate(
  state: PendingCalendarAutomationState,
  reply: string,
  now: Date,
): CalendarAutomationDraft | null {
  const normalized = normalizeMessage(reply);
  if (state.step === 'clarify_time') {
    const time = parseStandaloneClockReply(normalized);
    if (!time) return null;

    if (state.template.schedule.kind === 'once') {
      const candidate = setLocalTime(now, time.hour, time.minute);
      const runAt =
        candidate.getTime() > now.getTime() ? candidate : addDays(candidate, 1);
      const schedule = buildOnceSchedule({
        runAt,
        description: `at ${time.label}`,
      });
      return {
        label: `${state.template.labelPrefix} ${schedule.description}`,
        config: {
          kind: 'watch',
          scopeKind: state.template.scope.scopeKind,
          scopeCalendarId: state.template.scope.scopeCalendarId,
          scopeCalendarSummary: state.template.scope.scopeCalendarSummary,
          schedule,
          condition: state.template.condition,
          query: state.template.query,
          minimumGapMinutes: state.template.minimumGapMinutes,
        },
        replaceTaskId: state.replaceTaskId,
        replaceLabel: state.replaceLabel,
      };
    }

    const schedule = buildCronSchedule({
      triggerKind: state.template.schedule.triggerKind,
      weekday: state.template.schedule.weekday,
      hour: time.hour,
      minute: time.minute,
      description: describeTrigger(
        state.template.schedule.triggerKind,
        time.hour,
        time.minute,
        state.template.schedule.weekday,
      ),
    });
    return {
      label: `${state.template.labelPrefix} ${schedule.description}`,
      config: {
        kind: 'watch',
        scopeKind: state.template.scope.scopeKind,
        scopeCalendarId: state.template.scope.scopeCalendarId,
        scopeCalendarSummary: state.template.scope.scopeCalendarSummary,
        schedule,
        condition: state.template.condition,
        query: state.template.query,
        minimumGapMinutes: state.template.minimumGapMinutes,
      },
      replaceTaskId: state.replaceTaskId,
      replaceLabel: state.replaceLabel,
    };
  }

  if (state.step === 'clarify_offset') {
    const offsetMinutes = parseBeforeOffsetMinutes(normalized);
    if (!offsetMinutes) return null;
    return {
      label: `${state.template.labelPrefix} (${formatOffsetLabel(
        offsetMinutes,
      )})`,
      config: {
        kind: 'event_reminder',
        scopeKind: state.template.scope.scopeKind,
        scopeCalendarId: state.template.scope.scopeCalendarId,
        scopeCalendarSummary: state.template.scope.scopeCalendarSummary,
        schedule: buildIntervalSchedule({
          intervalMinutes: DEFAULT_AUTOMATION_INTERVAL_MINUTES,
          description:
            state.template.weekdays?.length === 5
              ? 'every workday'
              : 'every day',
        }),
        selector: state.template.selector,
        offsetMinutes,
        offsetLabel: formatOffsetLabel(offsetMinutes),
        weekdays: state.template.weekdays,
      },
      replaceTaskId: state.replaceTaskId,
      replaceLabel: state.replaceLabel,
    };
  }

  return null;
}

export function advancePendingCalendarAutomation(
  message: string,
  state: PendingCalendarAutomationState,
  now: Date,
): PendingCalendarAutomationResult {
  const normalized = normalizeMessage(message);
  if (!normalized) {
    return { kind: 'no_match' };
  }

  if (CANCEL_PATTERN.test(normalized)) {
    return {
      kind: 'cancelled',
      message: "Okay, I won't save that automation.",
    };
  }

  if (state.step === 'clarify_time' || state.step === 'clarify_offset') {
    const draft = buildDraftFromPendingTemplate(state, normalized, now);
    if (!draft) {
      return { kind: 'no_match' };
    }
    const nextState: PendingCalendarAutomationState = {
      version: 1,
      createdAt: now.toISOString(),
      step: 'confirm',
      draft,
      mode:
        state.step === 'clarify_time' && state.template.resumeOnSave
          ? 'resume'
          : draft.replaceTaskId
            ? 'replace'
            : 'create',
      targetTaskId: draft.replaceTaskId,
      targetStatus: draft.replaceTaskId ? 'paused' : null,
    };
    return {
      kind: 'awaiting_input',
      state: nextState,
      message:
        nextState.mode === 'resume'
          ? `I can resume this automation with:\n\n- ${draft.label}\n- Scope: ${formatAutomationScopeLabel(draft.config)}\n\nReply "yes" to resume it or "cancel" to stop.`
          : draft.replaceTaskId
            ? `I can replace ${draft.replaceLabel || 'that automation'} with:\n\n- ${draft.label}\n- Scope: ${formatAutomationScopeLabel(draft.config)}\n\nReply "yes" to replace it or "cancel" to stop.`
            : `I can save this automation:\n\n- ${draft.label}\n- Scope: ${formatAutomationScopeLabel(draft.config)}\n\nReply "yes" to save it or "cancel" to stop.`,
    };
  }

  if (!CONFIRM_PATTERN.test(normalized)) {
    return { kind: 'no_match' };
  }

  return { kind: 'confirmed', state };
}

export function formatPendingCalendarAutomationPrompt(
  state: PendingCalendarAutomationState,
): string {
  if (state.step === 'clarify_time') {
    return 'What time should I run that check?';
  }
  if (state.step === 'clarify_offset') {
    return 'How far before should I remind you?';
  }
  if (state.mode === 'pause') {
    return `I can pause this automation:\n\n- ${state.draft.label}\n\nReply "yes" to pause it or "cancel" to keep it running.`;
  }
  if (state.mode === 'resume') {
    return `I can resume this automation:\n\n- ${state.draft.label}\n\nReply "yes" to turn it back on or "cancel" to leave it paused.`;
  }
  if (state.mode === 'delete') {
    return `I can delete this automation:\n\n- ${state.draft.label}\n\nReply "yes" to delete it or "cancel" to keep it.`;
  }
  return state.draft.replaceTaskId
    ? `I can replace ${state.draft.replaceLabel || 'that automation'} with:\n\n- ${state.draft.label}\n- Scope: ${formatAutomationScopeLabel(state.draft.config)}\n\nReply "yes" to replace it or "cancel" to stop.`
    : `I can save this automation:\n\n- ${state.draft.label}\n- Scope: ${formatAutomationScopeLabel(state.draft.config)}\n\nReply "yes" to save it or "cancel" to stop.`;
}

export function buildCalendarAutomationPersistInput(input: {
  draft: CalendarAutomationDraft;
  chatJid: string;
  groupFolder: string;
  now?: Date;
  existingTaskId?: string | null;
  status?: ScheduledTask['status'];
}): CalendarAutomationPersistInput {
  const now = input.now || new Date();
  const taskId =
    input.existingTaskId ||
    input.draft.replaceTaskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const status = input.status || 'active';
  const nextRun = computeCalendarAutomationNextRun(
    input.draft.config.schedule,
    now,
  );
  return {
    task: {
      id: taskId,
      group_folder: input.groupFolder,
      chat_jid: input.chatJid,
      prompt: `Calendar automation: ${input.draft.label}`,
      script: null,
      schedule_type: input.draft.config.schedule.scheduleType,
      schedule_value: input.draft.config.schedule.scheduleValue,
      context_mode: 'isolated',
      next_run: nextRun,
      status,
      created_at: now.toISOString(),
    },
    automation: {
      task_id: taskId,
      chat_jid: input.chatJid,
      group_folder: input.groupFolder,
      automation_type: input.draft.config.kind,
      label: input.draft.label,
      config_json: JSON.stringify(input.draft.config),
      dedupe_state_json: null,
    },
    replaceTaskId: input.draft.replaceTaskId,
  };
}

export function parseCalendarAutomationRecord(
  record: CalendarAutomationRecordInput,
): CalendarAutomationSummary {
  return {
    taskId: record.task_id,
    chatJid: record.chat_jid,
    groupFolder: record.group_folder,
    label: record.label,
    status: record.status,
    nextRun: record.next_run,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    config: JSON.parse(record.config_json) as CalendarAutomationConfig,
    dedupeState: record.dedupe_state_json
      ? (JSON.parse(record.dedupe_state_json) as CalendarAutomationDedupeState)
      : null,
  };
}

function getAutomationDedupeKeys(
  state: CalendarAutomationDedupeState | null,
): string[] {
  return state?.keys || [];
}

function rememberAutomationDedupeKey(
  state: CalendarAutomationDedupeState | null,
  key: string,
  now: Date,
): CalendarAutomationDedupeState {
  const keys = [
    key,
    ...getAutomationDedupeKeys(state).filter((item) => item !== key),
  ].slice(0, 20);
  return {
    version: 1,
    keys,
    updatedAt: now.toISOString(),
  };
}

function hasConfiguredCalendarFailure(result: CalendarLookupResult): boolean {
  const configured = result.statuses.filter((status) => status.configured);
  return (
    configured.length === 0 ||
    configured.some((status) => status.state !== 'ready' || !status.complete)
  );
}

function getTimedCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.filter((event) => !event.allDay);
}

function buildBusyWindows(
  events: CalendarEvent[],
): Array<{ start: Date; end: Date }> {
  const sorted = getTimedCalendarEvents(events).sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const windows: Array<{ start: Date; end: Date }> = [];
  for (const event of sorted) {
    const start = new Date(event.startIso);
    const end = new Date(event.endIso);
    const last = windows.at(-1);
    if (!last || start.getTime() > last.end.getTime()) {
      windows.push({ start, end });
      continue;
    }
    if (end.getTime() > last.end.getTime()) {
      last.end = end;
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
      windows.push({ start: new Date(cursor), end: new Date(busyStart) });
    }
    cursor = Math.max(cursor, busyEnd);
  }
  if (cursor < end.getTime()) {
    windows.push({ start: new Date(cursor), end: new Date(end.getTime()) });
  }
  return windows;
}

function buildAdjacencyClusters(events: CalendarEvent[]): CalendarEvent[][] {
  const sorted = getTimedCalendarEvents(events).sort(
    (left, right) =>
      new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
  );
  const clusters: CalendarEvent[][] = [];
  let current: CalendarEvent[] = [];
  for (const event of sorted) {
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

function formatEventStart(
  event: GoogleCalendarEventRecord,
  timeZone: string,
): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  return formatter.format(new Date(event.startIso));
}

async function resolveScopedGoogleCalendarIds(
  config: CalendarAutomationConfig,
  deps: CalendarAutomationExecutionDeps,
): Promise<{
  kind: 'all' | 'scoped' | 'missing';
  calendarIds: string[];
  calendarLabel: string | null;
  errorMessage: string | null;
}> {
  if (config.scopeKind === 'all') {
    return {
      kind: 'all',
      calendarIds: [],
      calendarLabel: null,
      errorMessage: null,
    };
  }

  try {
    const calendars = (
      await listGoogleCalendars(
        resolveGoogleCalendarConfig(deps.env),
        deps.fetchImpl,
      )
    ).filter((calendar) => calendar.selected);

    if (config.scopeKind === 'family_shared') {
      const matches = calendars.filter((calendar) =>
        normalizeCalendarMatchText(
          `${calendar.summary} ${calendar.id}`,
        ).includes('family'),
      );
      if (matches.length === 0) {
        return {
          kind: 'missing',
          calendarIds: [],
          calendarLabel: 'Family/shared',
          errorMessage:
            "I couldn't confirm which selected family calendar to use right now.",
        };
      }
      return {
        kind: 'scoped',
        calendarIds: matches.map((calendar) => calendar.id),
        calendarLabel: 'Family/shared',
        errorMessage: null,
      };
    }

    const namedCalendar = calendars.find(
      (calendar) =>
        calendar.id === config.scopeCalendarId ||
        normalizeCalendarMatchText(calendar.summary) ===
          normalizeCalendarMatchText(config.scopeCalendarSummary || ''),
    );
    if (!namedCalendar) {
      return {
        kind: 'missing',
        calendarIds: [],
        calendarLabel: config.scopeCalendarSummary || 'Named calendar',
        errorMessage: `I couldn't confirm the ${config.scopeCalendarSummary || 'saved'} calendar for that automation right now.`,
      };
    }
    return {
      kind: 'scoped',
      calendarIds: [namedCalendar.id],
      calendarLabel: namedCalendar.summary,
      errorMessage: null,
    };
  } catch {
    return {
      kind: 'missing',
      calendarIds: [],
      calendarLabel:
        config.scopeKind === 'named_calendar'
          ? config.scopeCalendarSummary || 'Named calendar'
          : 'Family/shared',
      errorMessage: "I couldn't confirm that Google calendar scope right now.",
    };
  }
}

function buildScopedGoogleEnv(
  env: Record<string, string | undefined> | undefined,
  calendarIds: string[],
): Record<string, string | undefined> {
  const config = resolveGoogleCalendarConfig(env);
  return {
    GOOGLE_CALENDAR_ACCESS_TOKEN: config.accessToken || undefined,
    GOOGLE_CALENDAR_REFRESH_TOKEN: config.refreshToken || undefined,
    GOOGLE_CALENDAR_CLIENT_ID: config.clientId || undefined,
    GOOGLE_CALENDAR_CLIENT_SECRET: config.clientSecret || undefined,
    GOOGLE_CALENDAR_IDS: calendarIds.join(','),
  };
}

function matchesAutomationScope(
  event:
    | GoogleCalendarEventRecord
    | {
        calendarName?: string | null;
        calendarId?: string | null;
      },
  config: CalendarAutomationConfig,
): boolean {
  if (config.scopeKind === 'all') {
    return true;
  }
  const haystack =
    `${event.calendarName || ''} ${event.calendarId || ''}`.toLowerCase();
  if (config.scopeKind === 'family_shared') {
    return haystack.includes('family');
  }
  return (
    Boolean(config.scopeCalendarId) &&
    event.calendarId?.toLowerCase() === config.scopeCalendarId?.toLowerCase()
  );
}

function selectReminderTargetEvents(
  automation: EventReminderCalendarAutomationConfig,
  events: GoogleCalendarEventRecord[],
  now: Date,
): GoogleCalendarEventRecord[] {
  const filtered = events
    .filter(
      (event) => !event.allDay && matchesAutomationScope(event, automation),
    )
    .sort(
      (left, right) =>
        new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
    );

  if (automation.selector === 'next_meeting') {
    return filtered.filter(
      (event) => new Date(event.startIso).getTime() >= now.getTime(),
    );
  }

  return filtered;
}

function lowerCaseFirst(value: string): string {
  return value ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

function polishBriefingAutomationMessage(
  automation: BriefingCalendarAutomationConfig,
  reply: string,
): string {
  const trimmed = reply.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (
    automation.query === 'What should I know about today?' &&
    !/^good morning\b/i.test(trimmed)
  ) {
    return `Good morning - ${lowerCaseFirst(trimmed)}`;
  }
  if (
    automation.scopeKind === 'family_shared' &&
    !/^family calendar\b/i.test(trimmed)
  ) {
    return `Family calendar update: ${lowerCaseFirst(trimmed)}`;
  }
  if (
    automation.query === "What's my day look like tomorrow?" &&
    !/^tomorrow\b/i.test(trimmed)
  ) {
    return `Tomorrow: ${lowerCaseFirst(trimmed)}`;
  }
  return trimmed;
}

async function executeBriefingAutomation(
  automation: CalendarAutomationSummary,
  now: Date,
  deps: CalendarAutomationExecutionDeps,
): Promise<CalendarAutomationExecutionResult> {
  const config = automation.config as BriefingCalendarAutomationConfig;
  const anchorNow = addDays(now, config.anchorOffsetDays);
  const dedupeKey = `briefing:${getAutomationScopeIdentity(config)}:${config.query}:${startOfDay(anchorNow).toISOString()}`;
  if (getAutomationDedupeKeys(automation.dedupeState).includes(dedupeKey)) {
    return {
      message: null,
      summary: 'Skipped duplicate briefing window.',
      dedupeState: automation.dedupeState,
    };
  }

  const scopedCalendars = await resolveScopedGoogleCalendarIds(config, deps);
  if (scopedCalendars.kind === 'missing') {
    const failureKey = `${dedupeKey}:scope-missing`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate briefing scope warning.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: scopedCalendars.errorMessage,
      summary: 'Sent briefing scope warning.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        failureKey,
        now,
      ),
    };
  }

  const scopedEnv =
    scopedCalendars.kind === 'scoped'
      ? buildScopedGoogleEnv(deps.env, scopedCalendars.calendarIds)
      : deps.env;
  const response = await buildCalendarAssistantResponse(config.query, {
    now: anchorNow,
    timeZone: deps.timeZone || TIMEZONE,
    env: scopedEnv,
    fetchImpl: deps.fetchImpl,
  });
  const nextDedupe = rememberAutomationDedupeKey(
    automation.dedupeState,
    dedupeKey,
    now,
  );
  const reply = response?.reply
    ? polishBriefingAutomationMessage(config, response.reply)
    : "I couldn't build that calendar briefing right now.";
  return {
    message: reply,
    summary: response?.reply
      ? `Sent briefing: ${reply.slice(0, 120)}`
      : 'Briefing unavailable.',
    dedupeState: nextDedupe,
  };
}

async function executeWatchAutomation(
  automation: CalendarAutomationSummary,
  now: Date,
  deps: CalendarAutomationExecutionDeps,
): Promise<CalendarAutomationExecutionResult> {
  const config = automation.config as WatchCalendarAutomationConfig;
  const plan = planCalendarAssistantLookup(
    config.query,
    now,
    deps.timeZone || TIMEZONE,
    null as CalendarActiveEventContext | null,
  );
  if (!plan) {
    return {
      message: null,
      summary: 'Watch plan could not be resolved.',
      dedupeState: automation.dedupeState,
    };
  }

  const scopeIdentity = getAutomationScopeIdentity(config);
  const scopedCalendars = await resolveScopedGoogleCalendarIds(config, deps);
  if (scopedCalendars.kind === 'missing') {
    const failureKey = `watch:${scopeIdentity}:${plan.label}:${startOfDay(plan.start).toISOString()}:scope-missing`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate watch scope warning.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: scopedCalendars.errorMessage,
      summary: 'Sent watch scope warning.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        failureKey,
        now,
      ),
    };
  }

  const result = await lookupCalendarAssistantEvents(plan, {
    env:
      scopedCalendars.kind === 'scoped'
        ? buildScopedGoogleEnv(deps.env, scopedCalendars.calendarIds)
        : deps.env,
    fetchImpl: deps.fetchImpl,
  });
  const dedupeKeyBase = `${config.condition}:${scopeIdentity}:${plan.label}:${startOfDay(plan.start).toISOString()}`;
  if (hasConfiguredCalendarFailure(result)) {
    const failureKey = `${dedupeKeyBase}:incomplete`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate incomplete watch notice.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: `I couldn't confirm your ${automation.label.toLowerCase()} because I couldn't read every configured calendar right now.`,
      summary: 'Sent incomplete watch notice.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        failureKey,
        now,
      ),
    };
  }

  if (config.condition === 'back_to_back') {
    const clusters = buildAdjacencyClusters(result.events);
    if (clusters.length === 0) {
      return {
        message: null,
        summary: 'Watch condition not met.',
        dedupeState: automation.dedupeState,
      };
    }
    const first = clusters[0]![0]!;
    const key = `${dedupeKeyBase}:${first.id}`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(key)) {
      return {
        message: null,
        summary: 'Skipped duplicate back-to-back notice.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: `Heads up: you have back-to-back meetings starting ${formatEventStart(
        {
          id: first.id,
          title: first.title,
          startIso: first.startIso,
          endIso: first.endIso,
          allDay: first.allDay,
          calendarId: first.calendarId || '',
          calendarName: first.calendarName || '',
        },
        deps.timeZone || TIMEZONE,
      )}.`,
      summary: 'Sent back-to-back watch notice.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        key,
        now,
      ),
    };
  }

  if (config.condition === 'no_gap') {
    const openings = buildOpenWindows(
      plan.start,
      plan.end,
      buildBusyWindows(result.events),
    ).filter(
      (window) =>
        window.end.getTime() - window.start.getTime() >=
        (config.minimumGapMinutes || 30) * 60 * 1000,
    );
    if (openings.length > 0) {
      return {
        message: null,
        summary: 'Watch condition not met.',
        dedupeState: automation.dedupeState,
      };
    }
    const key = `${dedupeKeyBase}:nogap`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(key)) {
      return {
        message: null,
        summary: 'Skipped duplicate no-gap notice.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: `Heads up: ${plan.label} doesn't have a ${(
        config.minimumGapMinutes || 30
      ).toString()}-minute opening.`,
      summary: 'Sent no-gap watch notice.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        key,
        now,
      ),
    };
  }

  const busyMinutes = buildBusyWindows(result.events).reduce(
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
  const totalWindowMinutes = Math.max(
    0,
    Math.round((plan.end.getTime() - plan.start.getTime()) / (60 * 1000)),
  );
  const openMinutes = Math.max(0, totalWindowMinutes - busyMinutes);
  const packed =
    totalWindowMinutes >= 180 &&
    (busyMinutes >= totalWindowMinutes * 0.75 ||
      (openMinutes > 0 && openMinutes < 60));
  if (!packed) {
    return {
      message: null,
      summary: 'Watch condition not met.',
      dedupeState: automation.dedupeState,
    };
  }
  const key = `${dedupeKeyBase}:packed`;
  if (getAutomationDedupeKeys(automation.dedupeState).includes(key)) {
    return {
      message: null,
      summary: 'Skipped duplicate packed-day notice.',
      dedupeState: automation.dedupeState,
    };
  }
  return {
    message: `Heads up: ${plan.label} looks packed.`,
    summary: 'Sent packed-day watch notice.',
    dedupeState: rememberAutomationDedupeKey(automation.dedupeState, key, now),
  };
}

async function executeEventReminderAutomation(
  automation: CalendarAutomationSummary,
  now: Date,
  deps: CalendarAutomationExecutionDeps,
): Promise<CalendarAutomationExecutionResult> {
  const config = automation.config as EventReminderCalendarAutomationConfig;
  if (config.weekdays && !config.weekdays.includes(now.getDay())) {
    return {
      message: null,
      summary: 'Skipped reminder automation outside active weekdays.',
      dedupeState: automation.dedupeState,
    };
  }

  const googleConfig = resolveGoogleCalendarConfig(deps.env);
  const scopedCalendars = await resolveScopedGoogleCalendarIds(config, deps);
  if (scopedCalendars.kind === 'missing') {
    const failureKey = `reminder-scope:${getAutomationScopeIdentity(config)}:${startOfDay(now).toISOString()}`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate reminder scope warning.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: scopedCalendars.errorMessage,
      summary: 'Sent reminder scope warning.',
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        failureKey,
        now,
      ),
    };
  }
  const searchStart =
    config.selector === 'first_event_today' ? startOfDay(now) : now;
  const searchEnd =
    config.selector === 'first_event_today'
      ? addDays(startOfDay(now), 1)
      : new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  try {
    const { events, failures } = await listGoogleCalendarEvents(
      {
        start: searchStart,
        end: searchEnd,
        calendarIds:
          scopedCalendars.kind === 'scoped'
            ? scopedCalendars.calendarIds
            : googleConfig.calendarIds,
      },
      googleConfig,
      deps.fetchImpl,
    );

    if (failures.length > 0) {
      const failureKey = `reminder-failure:${config.selector}:${startOfDay(now).toISOString()}`;
      if (
        getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)
      ) {
        return {
          message: null,
          summary: 'Skipped duplicate reminder failure notice.',
          dedupeState: automation.dedupeState,
        };
      }
      return {
        message: `I couldn't confirm your ${automation.label.toLowerCase()} because I couldn't read every configured calendar right now.`,
        summary: 'Sent reminder failure notice.',
        dedupeState: rememberAutomationDedupeKey(
          automation.dedupeState,
          failureKey,
          now,
        ),
      };
    }

    const matches = selectReminderTargetEvents(config, events, now);
    const target = matches[0];
    if (!target) {
      return {
        message: null,
        summary: 'No matching reminder event found.',
        dedupeState: automation.dedupeState,
      };
    }

    const eventStart = new Date(target.startIso);
    const remindAt = new Date(
      eventStart.getTime() - config.offsetMinutes * 60 * 1000,
    );
    if (
      now.getTime() < remindAt.getTime() ||
      now.getTime() >= eventStart.getTime()
    ) {
      return {
        message: null,
        summary: 'Reminder target not due yet.',
        dedupeState: automation.dedupeState,
      };
    }

    const dedupeKey = `reminder:${target.id}:${remindAt.toISOString()}:${config.offsetMinutes}`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(dedupeKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate event reminder automation notice.',
        dedupeState: automation.dedupeState,
      };
    }

    const startLabel = formatEventStart(target, deps.timeZone || TIMEZONE);
    return {
      message: `Reminder: ${target.title} starts ${startLabel}.`,
      summary: `Sent reminder for ${target.title}.`,
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        dedupeKey,
        now,
      ),
    };
  } catch (error) {
    const failureKey = `reminder-error:${config.selector}:${startOfDay(now).toISOString()}`;
    if (getAutomationDedupeKeys(automation.dedupeState).includes(failureKey)) {
      return {
        message: null,
        summary: 'Skipped duplicate reminder error notice.',
        dedupeState: automation.dedupeState,
      };
    }
    return {
      message: `I couldn't confirm your ${automation.label.toLowerCase()} because Google Calendar is unavailable right now.`,
      summary: `Reminder automation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      dedupeState: rememberAutomationDedupeKey(
        automation.dedupeState,
        failureKey,
        now,
      ),
    };
  }
}

export async function executeCalendarAutomation(
  automation: CalendarAutomationSummary,
  deps: CalendarAutomationExecutionDeps = {},
): Promise<CalendarAutomationExecutionResult> {
  const now = deps.now || new Date();
  if (automation.config.kind === 'briefing') {
    return executeBriefingAutomation(automation, now, deps);
  }
  if (automation.config.kind === 'watch') {
    return executeWatchAutomation(automation, now, deps);
  }
  return executeEventReminderAutomation(automation, now, deps);
}
