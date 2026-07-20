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
  upsertMessageAction,
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

  it('routes an external BlueBubbles task with a linked message action through that action before calendar automation', async () => {
    const nowIso = '2026-04-01T12:00:00.000Z';
    const taskId = 'task-linked-action-and-automation';
    const chatJid = 'bb:iMessage;-;+15551234567';
    createTask({
      id: taskId,
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send me a morning brief every weekday at 7 AM',
      schedule_type: 'once',
      schedule_value: nowIso,
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: nowIso,
    });
    createCalendarAutomation({
      task_id: taskId,
      chat_jid: chatJid,
      group_folder: 'main',
      automation_type: 'briefing',
      label: 'Morning brief every weekday at 7:00 AM',
      config_json: JSON.stringify({ kind: 'briefing' }),
      dedupe_state_json: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    upsertMessageAction({
      messageActionId: 'message-already-sent',
      groupFolder: 'main',
      sourceType: 'manual_prompt',
      sourceKey: 'already-sent',
      sourceSummary: 'Already completed send',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid,
        isGroup: false,
        personName: 'Candace',
      }),
      draftText: 'Already sent.',
      trustLevel: 'schedule_send',
      sendStatus: 'sent',
      followupAt: nowIso,
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: null,
      platformMessageId: 'message-1',
      scheduledTaskId: taskId,
      approvedAt: nowIso,
      lastActionKind: 'scheduled_send',
      lastActionAt: nowIso,
      dedupeKey: 'already-sent',
      presentationChatJid: chatJid,
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      sentAt: nowIso,
    });

    const pendingRuns: Promise<void>[] = [];
    const sendMessage = vi.fn(async () => {});
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'unexpected',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'External contact',
          folder: 'main',
          trigger: '@andrea',
          added_at: nowIso,
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
          pendingRuns.push(fn());
        },
        closeStdin: () => {},
        notifyIdle: () => {},
      } as any,
      onProcess: vi.fn(),
      sendMessage,
      sendToTarget,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(parseCalendarAutomationRecord).not.toHaveBeenCalled();
    expect(executeCalendarAutomation).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getTaskById(taskId)).toMatchObject({
      status: 'completed',
      last_result: 'Scheduled message no longer needed to send.',
    });
  });
});
