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
  listGoogleCalendarEvents,
  resolveGoogleCalendarConfig,
  type GoogleCalendarEventRecord,
} from './google-calendar.js';
import type { ScheduledTask } from './types.js';

const DEFAULT_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
const CANCEL_PATTERN = /^(?:cancel|never mind|nevermind|stop|no)\b/i;
const CONFIRM_PATTERN =
  /^(?:yes|yep|yeah|confirm|save it|save|replace it|replace|turn it off|disable it|delete it|remove it|go ahead|ok|okay)\b/i;
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
export type CalendarAutomationScopeKind = 'all' | 'family_shared';
type CalendarAutomationTriggerKind = 'daily' | 'weekdays' | 'weekly' | 'once';
type CalendarReminderSelector = 'next_meeting' | 'first_event_today';
type CalendarWatchCondition = 'back_to_back' | 'no_gap' | 'packed_day';

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

interface PendingWatchAutomationTemplate {
  kind: 'watch';
  condition: CalendarWatchCondition;
  scopeKind: CalendarAutomationScopeKind;
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
  scopeKind: CalendarAutomationScopeKind;
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
      mode: 'create' | 'replace' | 'disable' | 'delete';
      targetTaskId: string | null;
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

function resolveBriefingScope(normalized: string): CalendarAutomationScopeKind {
  return /\bfamily calendar\b/.test(normalized) ? 'family_shared' : 'all';
}

function resolveBriefingDefaults(normalized: string): {
  query: string;
  anchorOffsetDays: number;
  scopeKind: CalendarAutomationScopeKind;
  labelPrefix: string;
} | null {
  const family = resolveBriefingScope(normalized);
  if (family === 'family_shared') {
    return {
      query: "What's on the family calendar this week?",
      anchorOffsetDays:
        /\bevery sunday\b/.test(normalized) ||
        /\bsunday night\b/.test(normalized)
          ? 1
          : 0,
      scopeKind: family,
      labelPrefix: 'Family calendar summary',
    };
  }

  if (/\bweekend\b/.test(normalized)) {
    return {
      query: 'Anything important this weekend?',
      anchorOffsetDays: 0,
      scopeKind: family,
      labelPrefix: 'Weekend brief',
    };
  }

  if (/\btomorrow\b/.test(normalized) || /\bevening\b/.test(normalized)) {
    return {
      query: "What's my day look like tomorrow?",
      anchorOffsetDays: 0,
      scopeKind: family,
      labelPrefix: 'Tomorrow brief',
    };
  }

  return {
    query: 'What should I know about today?',
    anchorOffsetDays: 0,
    scopeKind: family,
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

function computeInitialNextRun(
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

function buildAutomationDuplicateKey(config: CalendarAutomationConfig): string {
  if (config.kind === 'briefing') {
    return `${config.kind}:${config.scopeKind}:${config.query}:${config.anchorOffsetDays}`;
  }
  if (config.kind === 'event_reminder') {
    return `${config.kind}:${config.scopeKind}:${config.selector}:${(
      config.weekdays || []
    ).join(',')}`;
  }
  return `${config.kind}:${config.scopeKind}:${config.condition}:${config.query}:${config.minimumGapMinutes || 0}`;
}

function findDuplicateAutomation(
  draft: CalendarAutomationDraft,
  existing: CalendarAutomationSummary[],
): CalendarAutomationSummary | null {
  const key = buildAutomationDuplicateKey(draft.config);
  return (
    existing.find(
      (item) =>
        item.status !== 'completed' &&
        buildAutomationDuplicateKey(item.config) === key,
    ) || null
  );
}

function buildCreateAutomationResult(
  draft: CalendarAutomationDraft,
  existing: CalendarAutomationSummary[],
  now: Date,
): CalendarAutomationPlanResult {
  const duplicate = findDuplicateAutomation(draft, existing);
  const nextDraft = duplicate
    ? {
        ...draft,
        replaceTaskId: duplicate.taskId,
        replaceLabel: duplicate.label,
      }
    : draft;

  const state: PendingCalendarAutomationState = {
    version: 1,
    createdAt: now.toISOString(),
    step: 'confirm',
    draft: nextDraft,
    mode: duplicate ? 'replace' : 'create',
    targetTaskId: duplicate?.taskId || null,
  };

  return {
    kind: 'awaiting_input',
    state,
    message: duplicate
      ? `I found an existing automation that matches this setup.\n\nCurrent: ${duplicate.label}\nNew: ${nextDraft.label}\n\nReply "yes" to replace it or "cancel" to keep the current one.`
      : `I can save this automation:\n\n- ${nextDraft.label}\n\nReply "yes" to save it or "cancel" to stop.`,
  };
}

function buildBriefingDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
): CalendarAutomationPlanResult {
  const defaults = resolveBriefingDefaults(normalized);
  if (!defaults) return { kind: 'none' };

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
    scopeKind: defaults.scopeKind,
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

function buildWatchDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
): CalendarAutomationPlanResult {
  const parsed = parseWatchCondition(normalized);
  if (!parsed) return { kind: 'none' };

  const explicitTime = parseExplicitClockTime(normalized);
  const recurringSchedule = parseRecurringTrigger(normalized, explicitTime);
  if (recurringSchedule) {
    const config: WatchCalendarAutomationConfig = {
      kind: 'watch',
      scopeKind: resolveBriefingScope(normalized),
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
        scopeKind: resolveBriefingScope(normalized),
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
    scopeKind: resolveBriefingScope(normalized),
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

function buildEventReminderDraft(
  normalized: string,
  now: Date,
  existing: CalendarAutomationSummary[],
): CalendarAutomationPlanResult {
  const recurrence = resolveReminderAutomationWeekdays(normalized);
  if (!recurrence) {
    return { kind: 'none' };
  }

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
        scopeKind: resolveBriefingScope(normalized),
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
    scopeKind: resolveBriefingScope(normalized),
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

function listAutomationsMessage(
  automations: CalendarAutomationSummary[],
): string {
  const visible = automations.filter((item) => item.status !== 'completed');
  if (visible.length === 0) {
    return "You don't have any calendar automations set up.";
  }

  const lines = ['Your calendar automations:'];
  for (const automation of visible.slice(0, 8)) {
    lines.push(
      `- ${automation.label} (${automation.status}${
        automation.nextRun
          ? `, next ${formatAutomationNextRun(automation.nextRun)}`
          : ''
      })`,
    );
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

function findAutomationByTarget(
  automations: CalendarAutomationSummary[],
  targetText: string,
): CalendarAutomationSummary | null {
  const needle = normalizeAutomationMatchText(targetText);
  if (!needle) {
    return automations.length === 1 ? automations[0]! : null;
  }

  const matches = automations.filter((automation) =>
    normalizeAutomationMatchText(automation.label).includes(needle),
  );
  return matches.length === 1 ? matches[0]! : null;
}

function buildDisableOrDeleteResult(
  message: string,
  automations: CalendarAutomationSummary[],
  now: Date,
  mode: 'disable' | 'delete',
): CalendarAutomationPlanResult {
  const targetText = collapseWhitespace(
    normalizeMessage(message)
      .replace(/\b(?:turn off|disable|pause|stop|delete|remove)\b/gi, ' ')
      .replace(/\b(?:my|the)\b/gi, ' ')
      .replace(/\b(?:calendar )?automations?\b/gi, ' '),
  );
  const target = findAutomationByTarget(
    automations.filter((item) => item.status !== 'completed'),
    targetText,
  );
  if (!target) {
    return {
      kind: 'list',
      message:
        automations.length > 1
          ? `I couldn't tell which automation you meant. Try naming it more specifically.\n\n${listAutomationsMessage(
              automations,
            )}`
          : "I couldn't find that calendar automation.",
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
  };
  return {
    kind: 'awaiting_input',
    state,
    message:
      mode === 'disable'
        ? `I can turn off this automation:\n\n- ${target.label}\n\nReply "yes" to turn it off or "cancel" to keep it running.`
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
    const baseDay = startOfDay(new Date(config.schedule.runAtIso));
    const runAt = setLocalTime(baseDay, hour, minute);
    return {
      ...config,
      schedule: buildOnceSchedule({
        runAt: runAt > now ? runAt : addDays(runAt, 1),
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
    /\breplace\s+(.+?)\s+with\s+(.+)$/i,
  );
  if (!match) {
    return { kind: 'none' };
  }

  const target = findAutomationByTarget(
    automations.filter((item) => item.status !== 'completed'),
    match[1],
  );
  if (!target) {
    return {
      kind: 'list',
      message: `I couldn't tell which automation to replace.\n\n${listAutomationsMessage(
        automations,
      )}`,
    };
  }

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

  const newTime = parseStandaloneClockReply(match[2]);
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
  };

  return {
    kind: 'awaiting_input',
    state,
    message: `I can replace this automation:\n\nCurrent: ${target.label}\nNew: ${label}\n\nReply "yes" to save the new schedule or "cancel" to keep the current one.`,
  };
}

export function planCalendarAutomation(
  message: string,
  now: Date,
  automations: CalendarAutomationSummary[],
): CalendarAutomationPlanResult {
  const normalized = normalizeMessage(message).toLowerCase();
  if (!normalized) {
    return { kind: 'none' };
  }

  if (
    /\b(show|list|what are)\b/.test(normalized) &&
    /\bcalendar automations?\b/.test(normalized)
  ) {
    return {
      kind: 'list',
      message: listAutomationsMessage(automations),
    };
  }

  if (/^(?:turn off|disable|pause|stop)\b/.test(normalized)) {
    return buildDisableOrDeleteResult(message, automations, now, 'disable');
  }

  if (/^(?:delete|remove)\b/.test(normalized)) {
    return buildDisableOrDeleteResult(message, automations, now, 'delete');
  }

  if (/^replace\b/i.test(normalized)) {
    return buildReplaceResult(message, automations, now);
  }

  const briefingResult = buildBriefingDraft(normalized, now, automations);
  if (briefingResult.kind !== 'none') {
    return briefingResult;
  }

  const watchResult = buildWatchDraft(normalized, now, automations);
  if (watchResult.kind !== 'none') {
    return watchResult;
  }

  return buildEventReminderDraft(normalized, now, automations);
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
          scopeKind: state.template.scopeKind,
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
        scopeKind: state.template.scopeKind,
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
        scopeKind: state.template.scopeKind,
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
      mode: draft.replaceTaskId ? 'replace' : 'create',
      targetTaskId: draft.replaceTaskId,
    };
    return {
      kind: 'awaiting_input',
      state: nextState,
      message: draft.replaceTaskId
        ? `I can replace ${draft.replaceLabel || 'that automation'} with:\n\n- ${draft.label}\n\nReply "yes" to replace it or "cancel" to stop.`
        : `I can save this automation:\n\n- ${draft.label}\n\nReply "yes" to save it or "cancel" to stop.`,
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
  if (state.mode === 'disable') {
    return `I can turn off this automation:\n\n- ${state.draft.label}\n\nReply "yes" to turn it off or "cancel" to keep it running.`;
  }
  if (state.mode === 'delete') {
    return `I can delete this automation:\n\n- ${state.draft.label}\n\nReply "yes" to delete it or "cancel" to keep it.`;
  }
  return state.draft.replaceTaskId
    ? `I can replace ${state.draft.replaceLabel || 'that automation'} with:\n\n- ${state.draft.label}\n\nReply "yes" to replace it or "cancel" to stop.`
    : `I can save this automation:\n\n- ${state.draft.label}\n\nReply "yes" to save it or "cancel" to stop.`;
}

export function buildCalendarAutomationPersistInput(input: {
  draft: CalendarAutomationDraft;
  chatJid: string;
  groupFolder: string;
  now?: Date;
  existingTaskId?: string | null;
}): CalendarAutomationPersistInput {
  const now = input.now || new Date();
  const taskId =
    input.existingTaskId ||
    input.draft.replaceTaskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const nextRun = computeInitialNextRun(input.draft.config.schedule, now);
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
      status: 'active',
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

function matchesFamilyScope(
  event:
    | GoogleCalendarEventRecord
    | {
        calendarName?: string | null;
        calendarId?: string | null;
      },
  scopeKind: CalendarAutomationScopeKind,
): boolean {
  if (scopeKind !== 'family_shared') {
    return true;
  }
  const haystack =
    `${event.calendarName || ''} ${event.calendarId || ''}`.toLowerCase();
  return haystack.includes('family');
}

function selectReminderTargetEvents(
  automation: EventReminderCalendarAutomationConfig,
  events: GoogleCalendarEventRecord[],
  now: Date,
): GoogleCalendarEventRecord[] {
  const filtered = events
    .filter(
      (event) =>
        !event.allDay && matchesFamilyScope(event, automation.scopeKind),
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

async function executeBriefingAutomation(
  automation: CalendarAutomationSummary,
  now: Date,
  deps: CalendarAutomationExecutionDeps,
): Promise<CalendarAutomationExecutionResult> {
  const config = automation.config as BriefingCalendarAutomationConfig;
  const anchorNow = addDays(now, config.anchorOffsetDays);
  const dedupeKey = `briefing:${config.query}:${startOfDay(anchorNow).toISOString()}`;
  if (getAutomationDedupeKeys(automation.dedupeState).includes(dedupeKey)) {
    return {
      message: null,
      summary: 'Skipped duplicate briefing window.',
      dedupeState: automation.dedupeState,
    };
  }

  const response = await buildCalendarAssistantResponse(config.query, {
    now: anchorNow,
    timeZone: deps.timeZone || TIMEZONE,
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  const nextDedupe = rememberAutomationDedupeKey(
    automation.dedupeState,
    dedupeKey,
    now,
  );
  return {
    message:
      response?.reply || "I couldn't build that calendar briefing right now.",
    summary: response?.reply
      ? `Sent briefing: ${response.reply.slice(0, 120)}`
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

  const result = await lookupCalendarAssistantEvents(plan, {
    env: deps.env,
    fetchImpl: deps.fetchImpl,
  });
  const dedupeKeyBase = `${config.condition}:${plan.label}:${startOfDay(plan.start).toISOString()}`;
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
      message: `Heads up: ${plan.label} has no ${(
        config.minimumGapMinutes || 30
      ).toString()}-minute gaps.`,
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
        calendarIds: googleConfig.calendarIds,
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
