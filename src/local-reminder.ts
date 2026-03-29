import type { ScheduledTask } from './types.js';

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

export interface PlannedReminder {
  confirmation: string;
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>;
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

function resolveReminderDate(
  dayPhrase: string,
  hour24: number,
  minute: number,
  now: Date,
): Date {
  const target = new Date(now);
  target.setSeconds(0, 0);

  if (dayPhrase.toLowerCase() === 'tomorrow') {
    target.setDate(target.getDate() + 1);
  } else {
    const targetDay = WEEKDAY_INDEX[dayPhrase.toLowerCase()];
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

export function planSimpleReminder(
  message: string,
  groupFolder: string,
  chatJid: string,
  now = new Date(),
): PlannedReminder | null {
  const match = message.trim().match(REMINDER_PATTERN);
  if (!match) return null;

  const [, dayPhrase, hourText, minuteText, meridiem, reminderBodyRaw] = match;
  const hour = Number.parseInt(hourText, 10);
  const minute = minuteText ? Number.parseInt(minuteText, 10) : 0;
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  const reminderBody = reminderBodyRaw.trim().replace(/\s+/g, ' ');
  if (!reminderBody) return null;

  const scheduledAt = resolveReminderDate(
    dayPhrase,
    normalizeMeridiem(hour, meridiem),
    minute,
    now,
  );
  const scheduleValue = toLocalTimestamp(scheduledAt);
  const timeLabel = `${hour}${minute === 0 ? '' : `:${pad(minute)}`}${meridiem.toLowerCase()}`;
  const whenLabel =
    dayPhrase.toLowerCase() === 'tomorrow'
      ? `tomorrow at ${timeLabel}`
      : `${dayPhrase[0].toUpperCase()}${dayPhrase.slice(1).toLowerCase()} at ${timeLabel}`;

  return {
    confirmation: `Your reminder is set:\nI'll prompt you ${whenLabel} to ${reminderBody}.`,
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
