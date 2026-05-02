import type { ScheduledTask } from './types.js';

const REMINDER_PROMPT_PATTERN =
  /^Send a concise reminder telling the user to (.+?)\.?$/i;

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
  const match = task.prompt.match(REMINDER_PROMPT_PATTERN);
  const body = normalizeReminderBody(match?.[1] || '');
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
