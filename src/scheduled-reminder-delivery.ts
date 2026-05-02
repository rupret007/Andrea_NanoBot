import type { ScheduledTask } from './types.js';

const REMINDER_PROMPT_PATTERNS = [
  /^Send a concise reminder telling the user to (.+?)\.?$/i,
  /^Send a concise reminder that (.+?)\.?$/i,
  /^Send a concise reminder(?: to the user)? (?:about|for) (.+?)\.?$/i,
  /^Remind the user to (.+?)\.?$/i,
];

function normalizeReminderBody(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.?!]+$/g, '')
    .trim();
}

export function parsePlainReminderTask(
  task: Pick<ScheduledTask, 'prompt' | 'script'>,
): string | null {
  if (task.script) return null;
  const body = normalizeReminderBody(
    REMINDER_PROMPT_PATTERNS.map((pattern) => task.prompt.match(pattern)?.[1])
      .find((value): value is string => Boolean(value)) || '',
  );
  if (!body) return null;
  return body;
}

export function buildPlainReminderDeliveryText(
  task: Pick<ScheduledTask, 'prompt' | 'script'>,
): string | null {
  const body = parsePlainReminderTask(task);
  if (!body) return null;
  return `Reminder: ${body}.`;
}
