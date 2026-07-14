import { describe, expect, it, vi } from 'vitest';

const tasks = new Map<string, Record<string, unknown>>();

vi.mock('./db.js', () => ({
  createTask: (task: Record<string, unknown>) => {
    if (tasks.has(String(task.id))) throw new Error('UNIQUE constraint failed');
    tasks.set(String(task.id), task);
  },
  getTaskById: (id: string) => tasks.get(id),
}));

import { planSimpleReminder } from './local-reminder.js';
import { persistReminderOperation } from './reminder-operation.js';

describe('persistReminderOperation', () => {
  it('converges duplicate inbound reminder delivery on one durable task', () => {
    tasks.clear();
    const planned = planSimpleReminder(
      'Remind me tomorrow at 3 PM to call pharmacy',
      'main',
      'tg:owner',
      new Date('2026-07-14T10:00:00-05:00'),
      { channel: 'telegram', inboundId: 'update:42' },
    );
    expect(planned).not.toBeNull();
    const first = persistReminderOperation(planned!);
    const second = persistReminderOperation(planned!);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(tasks).toHaveLength(1);
  });

  it('fails closed when an operation key is reused for a different reminder', () => {
    tasks.clear();
    const first = planSimpleReminder(
      'Remind me tomorrow at 3 PM to call pharmacy',
      'main',
      'tg:owner',
      new Date('2026-07-14T10:00:00-05:00'),
      { channel: 'telegram', inboundId: 'update:42' },
    )!;
    persistReminderOperation(first);
    const conflicting = {
      ...first,
      task: {
        ...first.task,
        prompt:
          'Send a concise reminder telling the user to call someone else.',
      },
    };
    expect(() => persistReminderOperation(conflicting)).toThrow(/conflicts/);
  });
});
