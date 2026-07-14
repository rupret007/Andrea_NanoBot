import { createTask, getTaskById } from './db.js';
import type { PlannedReminder } from './local-reminder.js';
import type { ScheduledTask } from './types.js';

function hasSameReminderIntent(
  current: ScheduledTask,
  planned: PlannedReminder['task'],
): boolean {
  return (
    current.group_folder === planned.group_folder &&
    current.chat_jid === planned.chat_jid &&
    current.prompt === planned.prompt &&
    current.schedule_type === planned.schedule_type &&
    current.schedule_value === planned.schedule_value &&
    current.next_run === planned.next_run
  );
}

/**
 * Persist a reminder before attempting channel delivery. A deterministic task
 * ID is its operation receipt: retries either observe the original task or
 * fail closed if a conflicting task somehow owns that ID.
 */
export function persistReminderOperation(planned: PlannedReminder): {
  task: ScheduledTask;
  created: boolean;
} {
  const existing = getTaskById(planned.task.id);
  if (existing) {
    if (!hasSameReminderIntent(existing, planned.task)) {
      throw new Error(
        'Reminder operation identity conflicts with an existing task.',
      );
    }
    return { task: existing, created: false };
  }

  try {
    createTask(planned.task);
  } catch (error) {
    // Another worker can win between the read and insert. Re-read only this
    // deterministic ID; never manufacture a second reminder after a retry.
    const raced = getTaskById(planned.task.id);
    if (!raced || !hasSameReminderIntent(raced, planned.task)) throw error;
    return { task: raced, created: false };
  }

  const task = getTaskById(planned.task.id);
  if (!task) {
    throw new Error(
      'Reminder persistence did not yield a durable task receipt.',
    );
  }
  return { task, created: true };
}
