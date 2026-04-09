import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./calendar-automations.js', () => ({
  parseCalendarAutomationRecord: vi.fn((record) => record),
  executeCalendarAutomation: vi.fn(async () => ({
    message: 'Good morning - today has 1 timed event.',
    summary: 'Sent automation message.',
    dedupeState: {
      version: 1,
      keys: ['briefing:today:2026-04-01'],
      updatedAt: '2026-04-01T12:00:00.000Z',
    },
  })),
}));

import {
  _initTestDatabase,
  createCalendarAutomation,
  createTask,
  getCalendarAutomationByTaskId,
  getTaskById,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  startSchedulerLoop,
} from './task-scheduler.js';
import {
  executeCalendarAutomation,
  parseCalendarAutomationRecord,
} from './calendar-automations.js';

describe('task scheduler calendar automations', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes calendar automations locally and updates dedupe state', async () => {
    createTask({
      id: 'task-automation-1',
      group_folder: 'main',
      chat_jid: 'chat-1',
      prompt: 'Send me a morning brief every weekday at 7 AM',
      schedule_type: 'once',
      schedule_value: '2026-04-01T12:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-04-01T12:00:00.000Z',
    });

    createCalendarAutomation({
      task_id: 'task-automation-1',
      chat_jid: 'chat-1',
      group_folder: 'main',
      automation_type: 'briefing',
      label: 'Morning brief every weekday at 7:00 AM',
      config_json: JSON.stringify({
        kind: 'briefing',
        scopeKind: 'all',
        schedule: {
          kind: 'cron',
          triggerKind: 'weekdays',
          weekday: null,
          hour: 7,
          minute: 0,
          scheduleType: 'cron',
          scheduleValue: '0 7 * * 1-5',
          description: 'every weekday at 7:00 AM',
        },
        query: 'What should I know about today?',
        anchorOffsetDays: 0,
      }),
      dedupe_state_json: null,
      created_at: '2026-04-01T12:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
    });

    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      registeredGroups: () => ({
        'chat-1': {
          name: 'Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-04-01T12:00:00.000Z',
          isMain: true,
          requiresTrigger: false,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: (
          _groupJid: string,
          _taskId: string,
          fn: () => Promise<void>,
        ) => {
          void fn();
        },
        closeStdin: () => {},
        notifyIdle: () => {},
      } as any,
      onProcess: () => {},
      sendMessage,
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(parseCalendarAutomationRecord).toHaveBeenCalledTimes(1);
    expect(executeCalendarAutomation).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Good morning - today has 1 timed event.',
    );

    const task = getTaskById('task-automation-1');
    expect(task?.status).toBe('completed');
    expect(task?.last_result).toBe('Sent automation message.');

    const automation = getCalendarAutomationByTaskId('task-automation-1');
    expect(automation?.dedupe_state_json).toContain(
      'briefing:today:2026-04-01',
    );
  });
});
