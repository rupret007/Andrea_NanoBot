import type { ScheduledTask } from './types.js';
import { buildQuickMathReply } from './direct-quick-reply.js';
import { normalizeVoicePrompt } from './voice-ready.js';

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const REMINDER_PATTERN =
  /^(?:can you\s+)?remind me\s+(tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+to\s+(.+?)\s*[.?!]*$/i;
const FLEXIBLE_REMINDER_PATTERN =
  /^(?:can you\s+)?(?:help me\s+)?remember to\s+(.+?)\s+(tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(morning|afternoon|evening|tonight)\s*[.?!]*$/i;
const DAYPART_HOURS: Record<string, number> = {
  morning: 9,
  afternoon: 15,
  evening: 19,
  tonight: 20,
};

function normalizeReminderInput(message: string): string {
  return normalizeVoicePrompt(message);
}

export interface PlannedReminder {
  confirmation: string;
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>;
}

interface ReminderTimingPlan {
  scheduledAt: Date;
  whenLabel: string;
}

function splitReminderBodyAndMathSuffix(reminderBodyRaw: string): {
  reminderBody: string;
  mathReply: string | null;
} {
  const trimmed = reminderBodyRaw.trim().replace(/\s+/g, ' ');
  const match = trimmed.match(
    /^(?<body>.+?)\s+(?:and also|also|and)\s+(?<math>(?:what(?:'s| is)|calculate|compute|solve).+)$/i,
  );

  if (!match?.groups) {
    return {
      reminderBody: trimmed,
      mathReply: null,
    };
  }

  const reminderBody = match.groups.body.trim();
  const mathReply = buildQuickMathReply(match.groups.math.trim());

  if (!reminderBody || !mathReply) {
    return {
      reminderBody: trimmed,
      mathReply: null,
    };
  }

  return { reminderBody, mathReply };
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function toLocalTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function normalizeMeridiem(hour: number, meridiem: string): number {
  const normalizedHour = hour % 12;
  return meridiem.toLowerCase() === 'pm' ? normalizedHour + 12 : normalizedHour;
}

function inferClockHourWithoutMeridiem(hour: number): number | null {
  if (hour < 0 || hour > 23) return null;
  if (hour >= 13) return hour;
  if (hour === 12) return 12;
  if (hour >= 1 && hour <= 7) return hour + 12;
  return hour;
}

function formatExplicitWhenLabel(
  dayPhrase: string,
  timeLabel: string,
  now: Date,
): string {
  const normalizedDayPhrase = dayPhrase.toLowerCase();
  if (normalizedDayPhrase === 'today') {
    return `today at ${timeLabel}`;
  }
  if (normalizedDayPhrase === 'tomorrow') {
    return `tomorrow at ${timeLabel}`;
  }
  const targetDay = WEEKDAY_INDEX[normalizedDayPhrase];
  const offset = (targetDay - now.getDay() + 7) % 7;
  const targetDate = new Date(now);
  targetDate.setDate(targetDate.getDate() + offset);
  return `${dayPhrase[0].toUpperCase()}${dayPhrase.slice(1).toLowerCase()} at ${timeLabel}`;
}

function resolveReminderDate(
  dayPhrase: string,
  hour24: number,
  minute: number,
  now: Date,
): Date {
  const target = new Date(now);
  target.setSeconds(0, 0);

  const normalizedDayPhrase = dayPhrase.toLowerCase();
  if (normalizedDayPhrase === 'today') {
    target.setHours(hour24, minute, 0, 0);
    return target;
  }

  if (normalizedDayPhrase === 'tomorrow') {
    target.setDate(target.getDate() + 1);
  } else {
    const targetDay = WEEKDAY_INDEX[normalizedDayPhrase];
    let offset = (targetDay - target.getDay() + 7) % 7;
    const candidateToday = new Date(target);
    candidateToday.setHours(hour24, minute, 0, 0);
    if (offset === 0 && candidateToday <= now) {
      offset = 7;
    }
    target.setDate(target.getDate() + offset);
  }

  target.setHours(hour24, minute, 0, 0);
  return target;
}

function buildPlannedReminder(
  reminderBody: string,
  scheduledAt: Date,
  whenLabel: string,
  groupFolder: string,
  chatJid: string,
  now: Date,
  mathReply: string | null = null,
): PlannedReminder {
  const scheduleValue = toLocalTimestamp(scheduledAt);

  return {
    confirmation: [
      `Okay. I'll remind you ${whenLabel} to ${reminderBody}.`,
      mathReply,
    ]
      .filter(Boolean)
      .join('\n\n'),
    task: {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt: `Send a concise reminder telling the user to ${reminderBody}.`,
      script: null,
      schedule_type: 'once',
      schedule_value: scheduleValue,
      context_mode: 'isolated',
      next_run: scheduledAt.toISOString(),
      status: 'active',
      created_at: now.toISOString(),
    },
  };
}

export function planContextualReminder(
  timingMessage: string,
  reminderBodyRaw: string,
  groupFolder: string,
  chatJid: string,
  now = new Date(),
): PlannedReminder | null {
  const timingText = normalizeReminderInput(timingMessage).toLowerCase();
  const { reminderBody, mathReply } =
    splitReminderBodyAndMathSuffix(reminderBodyRaw);
  if (!reminderBody) return null;

  let timing: ReminderTimingPlan | null = null;

  const explicitMatch = timingText.match(
    /^(?:(later)\s+)?(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  const timeBeforeDayMatch = explicitMatch
    ? null
    : timingText.match(
        /^(?:i(?: would|'d)\s+like\s+it\s+to\s+be\s+|set it for\s+|for\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*[.?!]*$/i,
      );
  if (explicitMatch) {
    const [, laterModifier, dayPhrase, hourText, minuteText, meridiem] =
      explicitMatch;
    const rawHour = Number.parseInt(hourText, 10);
    const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
    if (
      Number.isInteger(rawHour) &&
      Number.isInteger(minute) &&
      minute >= 0 &&
      minute <= 59
    ) {
      const hour24 = meridiem
        ? normalizeMeridiem(rawHour, meridiem)
        : inferClockHourWithoutMeridiem(rawHour);
      if (hour24 !== null) {
        const scheduledAt = resolveReminderDate(dayPhrase, hour24, minute, now);
        if (
          dayPhrase.toLowerCase() === 'today' &&
          laterModifier &&
          scheduledAt.getTime() <= now.getTime()
        ) {
          return null;
        }
        if (
          dayPhrase.toLowerCase() === 'today' &&
          scheduledAt.getTime() <= now.getTime()
        ) {
          return null;
        }
        const displayHour = hour24 % 12 || 12;
        const suffix = hour24 >= 12 ? 'pm' : 'am';
        const timeLabel =
          minute === 0
            ? `${displayHour}${suffix}`
            : `${displayHour}:${pad(minute)}${suffix}`;
        timing = {
          scheduledAt,
          whenLabel: formatExplicitWhenLabel(dayPhrase, timeLabel, now),
        };
      }
    }
  }

  if (!timing && timeBeforeDayMatch) {
    const [, hourText, minuteText, meridiem, dayPhrase] = timeBeforeDayMatch;
    const rawHour = Number.parseInt(hourText, 10);
    const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
    if (
      Number.isInteger(rawHour) &&
      Number.isInteger(minute) &&
      minute >= 0 &&
      minute <= 59
    ) {
      const hour24 = meridiem
        ? normalizeMeridiem(rawHour, meridiem)
        : inferClockHourWithoutMeridiem(rawHour);
      if (hour24 !== null) {
        const scheduledAt = resolveReminderDate(dayPhrase, hour24, minute, now);
        if (
          dayPhrase.toLowerCase() === 'today' &&
          scheduledAt.getTime() <= now.getTime()
        ) {
          return null;
        }
        const displayHour = hour24 % 12 || 12;
        const suffix = hour24 >= 12 ? 'pm' : 'am';
        const timeLabel =
          minute === 0
            ? `${displayHour}${suffix}`
            : `${displayHour}:${pad(minute)}${suffix}`;
        timing = {
          scheduledAt,
          whenLabel: formatExplicitWhenLabel(dayPhrase, timeLabel, now),
        };
      }
    }
  }

  if (!timing) {
    const daypartMatch = timingText.match(
      /^(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(morning|afternoon|evening|tonight)$/i,
    );
    if (daypartMatch) {
      const [, dayPhrase, dayPart] = daypartMatch;
      const normalizedDayPart = dayPart.toLowerCase();
      const scheduledAt = resolveReminderDate(
        dayPhrase,
        DAYPART_HOURS[normalizedDayPart]!,
        0,
        now,
      );
      if (
        dayPhrase.toLowerCase() === 'today' &&
        scheduledAt.getTime() <= now.getTime()
      ) {
        return null;
      }
      timing = {
        scheduledAt,
        whenLabel:
          dayPhrase.toLowerCase() === 'today'
            ? `today ${normalizedDayPart}`
            : dayPhrase.toLowerCase() === 'tomorrow'
              ? `tomorrow ${normalizedDayPart}`
              : `${dayPhrase[0].toUpperCase()}${dayPhrase.slice(1).toLowerCase()} ${normalizedDayPart}`,
      };
    }
  }

  if (!timing) {
    const clockOnlyMatch = timingText.match(
      /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
    );
    if (clockOnlyMatch) {
      const [, hourText, minuteText, meridiem] = clockOnlyMatch;
      const rawHour = Number.parseInt(hourText, 10);
      const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
      if (
        Number.isInteger(rawHour) &&
        Number.isInteger(minute) &&
        minute >= 0 &&
        minute <= 59
      ) {
        const hour24 = meridiem
          ? normalizeMeridiem(rawHour, meridiem)
          : inferClockHourWithoutMeridiem(rawHour);
        if (hour24 !== null) {
          const scheduledAt = new Date(now);
          scheduledAt.setHours(hour24, minute, 0, 0);
          if (scheduledAt.getTime() <= now.getTime()) {
            scheduledAt.setDate(scheduledAt.getDate() + 1);
          }
          const displayHour = hour24 % 12 || 12;
          const suffix = hour24 >= 12 ? 'pm' : 'am';
          const timeLabel =
            minute === 0
              ? `${displayHour}${suffix}`
              : `${displayHour}:${pad(minute)}${suffix}`;
          timing = {
            scheduledAt,
            whenLabel:
              scheduledAt.toDateString() === now.toDateString()
                ? `today at ${timeLabel}`
                : `tomorrow at ${timeLabel}`,
          };
        }
      }
    }
  }

  if (!timing) {
    return null;
  }

  return buildPlannedReminder(
    reminderBody,
    timing.scheduledAt,
    timing.whenLabel,
    groupFolder,
    chatJid,
    now,
    mathReply,
  );
}

export function planSimpleReminder(
  message: string,
  groupFolder: string,
  chatJid: string,
  now = new Date(),
): PlannedReminder | null {
  const normalizedMessage = normalizeReminderInput(message);
  const explicitMatch = normalizedMessage.match(REMINDER_PATTERN);
  const flexibleMatch = explicitMatch
    ? null
    : normalizedMessage.match(FLEXIBLE_REMINDER_PATTERN);
  if (!explicitMatch && !flexibleMatch) return null;

  let dayPhrase: string;
  let hour24: number;
  let minute: number;
  let whenLabel: string;
  let reminderBodyRaw: string;

  if (explicitMatch) {
    const [, explicitDayPhrase, hourText, minuteText, meridiem, explicitBody] =
      explicitMatch;
    const hour = Number.parseInt(hourText, 10);
    minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
    if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    dayPhrase = explicitDayPhrase;
    hour24 = normalizeMeridiem(hour, meridiem);
    const timeLabel = `${hour}${minute === 0 ? '' : `:${pad(minute)}`}${meridiem.toLowerCase()}`;
    whenLabel =
      dayPhrase.toLowerCase() === 'tomorrow'
        ? `tomorrow at ${timeLabel}`
        : `${dayPhrase[0].toUpperCase()}${dayPhrase.slice(1).toLowerCase()} at ${timeLabel}`;
    reminderBodyRaw = explicitBody;
  } else {
    const [, flexibleBody, flexibleDayPhrase, dayPart] = flexibleMatch!;
    const normalizedDayPart = dayPart.toLowerCase();
    hour24 = DAYPART_HOURS[normalizedDayPart];
    minute = 0;
    dayPhrase = flexibleDayPhrase;
    whenLabel =
      dayPhrase.toLowerCase() === 'tomorrow'
        ? `tomorrow ${normalizedDayPart}`
        : `${dayPhrase[0].toUpperCase()}${dayPhrase.slice(1).toLowerCase()} ${normalizedDayPart}`;
    reminderBodyRaw = flexibleBody;
  }

  const { reminderBody, mathReply } =
    splitReminderBodyAndMathSuffix(reminderBodyRaw);
  if (!reminderBody) return null;

  const scheduledAt = resolveReminderDate(dayPhrase, hour24, minute, now);
  return buildPlannedReminder(
    reminderBody,
    scheduledAt,
    whenLabel,
    groupFolder,
    chatJid,
    now,
    mathReply,
  );
}
