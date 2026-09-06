import { createHash } from 'node:crypto';

import type {
  PlannedReminder,
  ReminderOperationIdentity,
} from './local-reminder.js';

export const NAMED_REPLY_WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type NamedReplyWeekday = (typeof NAMED_REPLY_WEEKDAYS)[number];
export type NamedReplyClockDay = 'today' | 'tomorrow' | NamedReplyWeekday;

export type NamedReplyClockTiming =
  | {
      kind: 'clock';
      day: NamedReplyClockDay;
      hour24: number;
      minute: number;
    }
  | { kind: 'invalid_clock' };

const WEEKDAY_INDEX: Record<NamedReplyWeekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const CLOCK_SHAPE = '[+-]?\\d+(?::\\d+)?\\s*(?:am|pm)?';
const REMIND_LEAD =
  'remind me(?:(?: to (?:reply|answer))|(?: about (?:that|this|it)))?';
const WEEKDAY = NAMED_REPLY_WEEKDAYS.join('|');
const DAY_TOKEN = `today|tomorrow|(?:on\\s+)?(?:${WEEKDAY})`;
const DAY_FIRST = new RegExp(
  `^${REMIND_LEAD} (${DAY_TOKEN}) at\\s*(${CLOCK_SHAPE})[.!?]?$`,
  'i',
);
const CLOCK_FIRST = new RegExp(
  `^${REMIND_LEAD} at\\s*(${CLOCK_SHAPE}) (${DAY_TOKEN})[.!?]?$`,
  'i',
);

function isNamedReplyWeekday(value: string): value is NamedReplyWeekday {
  return (NAMED_REPLY_WEEKDAYS as readonly string[]).includes(value);
}

function normalizeClockDay(raw: string): NamedReplyClockDay | null {
  const cleaned = raw.replace(/^on\s+/i, '').toLowerCase();
  if (cleaned === 'today' || cleaned === 'tomorrow') return cleaned;
  return isNamedReplyWeekday(cleaned) ? cleaned : null;
}

export function isNamedReplyClockDay(
  value: string,
): value is NamedReplyClockDay {
  return (
    value === 'today' || value === 'tomorrow' || isNamedReplyWeekday(value)
  );
}

/** Only a standalone timing choice may inherit the named reply target. */
export function parseNamedReplyClockTiming(
  text: string,
): NamedReplyClockTiming | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const dayFirst = normalized.match(DAY_FIRST);
  const clockFirst = dayFirst ? null : normalized.match(CLOCK_FIRST);
  if (!dayFirst && !clockFirst) return null;
  const day = normalizeClockDay(dayFirst?.[1] || clockFirst?.[2] || '');
  const clockText = dayFirst?.[2] || clockFirst?.[1] || '';
  const clock = clockText.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!day || !clock) return { kind: 'invalid_clock' };
  const hour = Number(clock[1]);
  const minute = Number(clock[2] || '0');
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return { kind: 'invalid_clock' };
  }
  return {
    kind: 'clock',
    day,
    hour24: (hour % 12) + (clock[3].toLowerCase() === 'pm' ? 12 : 0),
    minute,
  };
}

export function formatNamedReplyClockTiming(
  timing: NamedReplyClockTiming,
): string {
  if (timing.kind === 'invalid_clock') return 'at an invalid time';
  const hour = timing.hour24 % 12 || 12;
  const minute = String(timing.minute).padStart(2, '0');
  return `${timing.day} at ${hour}:${minute}${timing.hour24 >= 12 ? 'pm' : 'am'}`;
}

interface CivilMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function readCivilMinute(
  date: Date,
  formatter: Intl.DateTimeFormat,
): CivilMinute {
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

function civilAsUtc(parts: CivilMinute): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
}

/**
 * Find every instant matching this civil minute under nearby zone offsets.
 * Zero matches is a clock gap; two matches is a repeated clock. Both require
 * another owner timing choice instead of silently moving the reminder.
 */
function resolveExactCivilMinute(
  target: CivilMinute,
  formatter: Intl.DateTimeFormat,
): Date | null {
  const nominal = civilAsUtc(target);
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = nominal + hours * 60 * 60 * 1000;
    offsets.add(
      civilAsUtc(readCivilMinute(new Date(sample), formatter)) - sample,
    );
  }
  const matches = new Set<number>();
  for (const offset of offsets) {
    const candidate = nominal - offset;
    if (
      civilAsUtc(readCivilMinute(new Date(candidate), formatter)) === nominal
    ) {
      matches.add(candidate);
    }
  }
  return matches.size === 1 ? new Date([...matches][0]) : null;
}

function ownerWeekdayIndex(today: CivilMinute): number {
  return new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
}

function namedReplyDayOffset(
  day: NamedReplyClockDay,
  today: CivilMinute,
): number {
  if (day === 'today') return 0;
  if (day === 'tomorrow') return 1;
  return (WEEKDAY_INDEX[day] - ownerWeekdayIndex(today) + 7) % 7;
}

function resolveNamedReplyClockInstant(
  timing: Extract<NamedReplyClockTiming, { kind: 'clock' }>,
  today: CivilMinute,
  now: Date,
  formatter: Intl.DateTimeFormat,
): Date | null {
  const resolveOffset = (dayOffset: number): Date | null => {
    const civilDate = new Date(
      Date.UTC(today.year, today.month - 1, today.day + dayOffset),
    );
    return resolveExactCivilMinute(
      {
        year: civilDate.getUTCFullYear(),
        month: civilDate.getUTCMonth() + 1,
        day: civilDate.getUTCDate(),
        hour: timing.hour24,
        minute: timing.minute,
      },
      formatter,
    );
  };

  const dayOffset = namedReplyDayOffset(timing.day, today);
  const first = resolveOffset(dayOffset);
  if (
    first &&
    first.getTime() <= now.getTime() &&
    isNamedReplyWeekday(timing.day)
  ) {
    return resolveOffset(dayOffset + 7);
  }
  return first;
}

/** Build a local, owner-addressed task; this function never persists or sends. */
export function planNamedReplyClockReminder(input: {
  timing: NamedReplyClockTiming;
  reminderBody: string;
  groupFolder: string;
  chatJid: string;
  now: Date;
  timeZone: string;
  identity?: ReminderOperationIdentity;
}): PlannedReminder | null {
  const { timing, now } = input;
  const reminderBody = input.reminderBody.replace(/\s+/g, ' ').trim();
  const timeZone = input.timeZone.trim();
  if (
    timing.kind !== 'clock' ||
    !isNamedReplyClockDay(timing.day) ||
    !Number.isInteger(timing.hour24) ||
    timing.hour24 < 0 ||
    timing.hour24 > 23 ||
    !Number.isInteger(timing.minute) ||
    timing.minute < 0 ||
    timing.minute > 59 ||
    !Number.isFinite(now.getTime()) ||
    !reminderBody ||
    !input.groupFolder.trim() ||
    !input.chatJid.trim() ||
    !timeZone
  ) {
    return null;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const today = readCivilMinute(now, formatter);
  const scheduledAt = resolveNamedReplyClockInstant(
    timing,
    today,
    now,
    formatter,
  );
  if (!scheduledAt || scheduledAt.getTime() <= now.getTime()) return null;

  const scheduleValue = scheduledAt.toISOString();
  const operation = createHash('sha256')
    .update(
      JSON.stringify([
        'andrea.named-reply-clock.v1',
        input.identity?.channel || 'internal',
        input.groupFolder,
        input.chatJid,
        timeZone,
        input.identity?.inboundId || now.toISOString(),
        reminderBody.toLowerCase(),
        scheduleValue,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  const dateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(scheduledAt);
  const clockLabel = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(scheduledAt);
  return {
    confirmation: `Okay. I'll remind you on ${dateLabel} at ${clockLabel} (${timeZone}) to ${reminderBody}.`,
    task: {
      id: `reminder-${operation}`,
      group_folder: input.groupFolder,
      chat_jid: input.chatJid,
      prompt: `Send a concise reminder telling the user to ${reminderBody}.`,
      script: null,
      schedule_type: 'once',
      // Once-task consumers parse this with Date; a UTC ISO value preserves
      // the reviewed instant across hosts with different local timezones.
      schedule_value: scheduleValue,
      context_mode: 'isolated',
      next_run: scheduleValue,
      status: 'active',
      created_at: now.toISOString(),
    },
  };
}
