import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  claimScheduledTaskOutboundDispatch,
  createTask,
  getMessageAction,
  getTaskById,
  updateTask,
  upsertCommunicationThread,
  upsertMessageAction,
  upsertResponseFeedback,
} from './db.js';
import type { ResponseFeedbackRecord } from './types.js';
import { setMessagingOutboundPaused } from './messaging-outbound-pause.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
      sendToTarget: async () => ({ platformMessageId: 'unused' }),
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('pauses legacy script tasks before starting a container or shell', async () => {
    createTask({
      id: 'task-unapproved-script',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'Perform a generic scheduled operation.',
      script: 'printf "unexpected execution\\n"',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:30:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
    });

    const pendingRuns: Promise<void>[] = [];
    const onProcess = vi.fn();
    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:main': {
          name: 'Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess,
      sendMessage,
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(onProcess).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getTaskById('task-unapproved-script')).toMatchObject({
      status: 'paused',
      last_result:
        'Error: Scheduled task script execution is blocked because the task has no reviewed script approval provenance.',
    });
  });

  it('pauses a generic task targeting an external BlueBubbles thread before execution', async () => {
    const chatJid = 'bb:iMessage;-;+15551234567';
    createTask({
      id: 'task-bb-external-generic',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:30:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
    });

    const pendingRuns: Promise<void>[] = [];
    const onProcess = vi.fn();
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
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess,
      sendMessage,
      sendToTarget,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(onProcess).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendToTarget).not.toHaveBeenCalled();
    expect(getTaskById('task-bb-external-generic')).toMatchObject({
      status: 'paused',
      last_result:
        'Error: Generic scheduled tasks cannot target a BlueBubbles contact or group; use the explicitly configured owner self-thread or a recipient-bound scheduled message action.',
    });
  });

  it('allows a generic task to deliver to the configured BlueBubbles owner self-thread', async () => {
    const chatJid = 'bb:iMessage;-;+12025550199';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    createTask({
      id: 'task-bb-owner-self-thread',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:30:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      outbound_pause_generation: 0,
    });

    const pendingRuns: Promise<void>[] = [];
    const sendMessage = vi.fn(async () => {});
    const sendToTarget = vi.fn(async () => ({
      platformMessageId: 'bb:self-thread-reminder-1',
    }));

    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Owner self-thread',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: vi.fn(),
      sendMessage,
      sendToTarget,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendToTarget).toHaveBeenCalledWith(
      'bluebubbles',
      chatJid,
      'Reminder: call Sam.',
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^scheduled-task:[a-f0-9]{32}$/),
        blueBubblesAuthorizationAt: '2026-05-02T04:00:00.000Z',
        blueBubblesPauseGeneration: 0,
      }),
    );
    expect(getTaskById('task-bb-owner-self-thread')).toMatchObject({
      status: 'completed',
      last_result: 'Reminder: call Sam.',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      outbound_pause_generation: 0,
      outbound_dispatch_state: 'completed',
    });
  });

  it('terminally blocks a generic self-thread task created before stop even after resume', async () => {
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const chatJid = 'bb:iMessage;-;+12025550199';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    createTask({
      id: 'task-bb-self-thread-before-stop',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:20:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      outbound_pause_generation: 0,
    });
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop',
      now: new Date('2026-05-02T04:10:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume',
      now: new Date('2026-05-02T04:15:00.000Z'),
    });

    const pendingRuns: Promise<void>[] = [];
    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-send',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Owner self-thread',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(providerDispatch).not.toHaveBeenCalled();
    expect(getTaskById('task-bb-self-thread-before-stop')).toMatchObject({
      status: 'completed',
      next_run: null,
      last_result: expect.stringContaining('pause generation'),
      outbound_dispatch_state: 'blocked',
    });
  });

  it('does not refresh pre-stop ingress authority when its task is created after resume', async () => {
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const chatJid = 'bb:iMessage;-;+12025550199';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop',
      now: new Date('2026-05-02T04:10:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume',
      now: new Date('2026-05-02T04:15:00.000Z'),
    });

    // The task is persisted after resume, but its only authority is the
    // immutable timestamp/generation from the delayed pre-stop ingress.
    createTask({
      id: 'task-bb-delayed-pre-stop-ingress',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:20:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
      created_at: '2026-05-02T04:30:00.000Z',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      // The queue captures the current generation at processing time, but it
      // must retain the pre-stop ingress timestamp rather than task.created_at.
      outbound_pause_generation: 1,
    });
    expect(getTaskById('task-bb-delayed-pre-stop-ingress')).toMatchObject({
      created_at: '2026-05-02T04:30:00.000Z',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      outbound_pause_generation: 1,
    });

    const pendingRuns: Promise<void>[] = [];
    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-send-delayed-ingress',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Owner self-thread',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(providerDispatch).not.toHaveBeenCalled();
    expect(getTaskById('task-bb-delayed-pre-stop-ingress')).toMatchObject({
      status: 'completed',
      next_run: null,
      last_result: expect.stringContaining('latest owner stop boundary'),
      outbound_dispatch_state: 'blocked',
    });
  });

  it('requires an explicit current-turn fence to authorize a legacy task resume or update', async () => {
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const chatJid = 'bb:iMessage;-;+12025550199';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop',
      now: new Date('2026-05-02T04:10:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume',
      now: new Date('2026-05-02T04:15:00.000Z'),
    });

    for (const id of ['task-bb-legacy-resume', 'task-bb-explicit-resume']) {
      createTask({
        id,
        group_folder: 'main',
        chat_jid: chatJid,
        prompt: 'Send a concise reminder telling the user to call Sam.',
        schedule_type: 'once',
        schedule_value: '2026-05-02T04:20:00.000Z',
        context_mode: 'isolated',
        next_run: null,
        status: 'paused',
        created_at: '2026-05-02T04:30:00.000Z',
      });
    }
    updateTask('task-bb-legacy-resume', {
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
    });
    updateTask('task-bb-explicit-resume', {
      prompt: 'Send a concise reminder telling the user to call Pat.',
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
      outbound_authorization_at: '2026-05-02T04:16:00.000Z',
      outbound_pause_generation: 1,
    });
    expect(getTaskById('task-bb-legacy-resume')).toMatchObject({
      outbound_authorization_at: null,
      outbound_pause_generation: null,
    });
    expect(getTaskById('task-bb-explicit-resume')).toMatchObject({
      outbound_authorization_at: '2026-05-02T04:16:00.000Z',
      outbound_pause_generation: 1,
    });

    const pendingRuns: Promise<void>[] = [];
    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:explicit-resume-reminder',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Owner self-thread',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(providerDispatch).toHaveBeenCalledTimes(1);
    expect(providerDispatch).toHaveBeenCalledWith(
      'bluebubbles',
      chatJid,
      'Reminder: call Pat.',
      expect.objectContaining({
        blueBubblesAuthorizationAt: '2026-05-02T04:16:00.000Z',
        blueBubblesPauseGeneration: 1,
      }),
    );
    expect(getTaskById('task-bb-legacy-resume')).toMatchObject({
      status: 'completed',
      last_result: expect.stringContaining(
        'missing a valid immutable owner-authorization timestamp',
      ),
      outbound_dispatch_state: 'blocked',
    });
  });

  it('passes one immutable post-resume fence and stable occurrence key to the final provider boundary', async () => {
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const chatJid = 'bb:iMessage;-;+12025550199';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_stop',
      now: new Date('2026-05-02T04:10:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_resume',
      now: new Date('2026-05-02T04:15:00.000Z'),
    });
    createTask({
      id: 'task-bb-self-thread-after-resume',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:20:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
      created_at: '2026-05-02T04:16:00.000Z',
      outbound_authorization_at: '2026-05-02T04:16:00.000Z',
      outbound_pause_generation: 1,
    });

    const pendingRuns: Promise<void>[] = [];
    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:post-resume-reminder',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        [chatJid]: {
          name: 'Owner self-thread',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(providerDispatch).toHaveBeenCalledTimes(1);
    expect(providerDispatch).toHaveBeenCalledWith(
      'bluebubbles',
      chatJid,
      'Reminder: call Sam.',
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^scheduled-task:[a-f0-9]{32}$/),
        blueBubblesAuthorizationAt: '2026-05-02T04:16:00.000Z',
        blueBubblesPauseGeneration: 1,
      }),
    );
  });

  it('quarantines a prior-process self-thread claim on scheduler startup without replay', async () => {
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const chatJid = 'bb:iMessage;-;+12025550199';
    const runKey = '2026-05-02T04:20:00.000Z';
    vi.stubEnv('BLUEBUBBLES_CANONICAL_SELF_THREAD_JID', chatJid);
    createTask({
      id: 'task-bb-self-thread-crash-claim',
      group_folder: 'main',
      chat_jid: chatJid,
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: runKey,
      context_mode: 'isolated',
      next_run: runKey,
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
      outbound_authorization_at: '2026-05-02T04:00:00.000Z',
      outbound_pause_generation: 0,
    });
    expect(
      claimScheduledTaskOutboundDispatch({
        taskId: 'task-bb-self-thread-crash-claim',
        runKey,
        claimToken: 'prior-process-claim',
      }),
    ).toMatchObject({ status: 'claimed' });
    expect(
      claimScheduledTaskOutboundDispatch({
        taskId: 'task-bb-self-thread-crash-claim',
        runKey,
        claimToken: 'automatic-replay-attempt',
      }),
    ).toEqual({ status: 'already_claimed', runKey });

    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:duplicate-must-not-send',
    }));
    const enqueueTask = vi.fn();
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).not.toHaveBeenCalled();
    expect(providerDispatch).not.toHaveBeenCalled();
    expect(getTaskById('task-bb-self-thread-crash-claim')).toMatchObject({
      status: 'completed',
      next_run: null,
      outbound_dispatch_state: 'blocked',
      outbound_dispatch_claim_token: null,
      last_result: expect.stringContaining('automatic replay is blocked'),
    });
  });

  it('delivers plain reminders directly instead of routing through an agent', async () => {
    createTask({
      id: 'task-plain-reminder',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt: 'Send a concise reminder telling the user to call Sam.',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:30:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-02T04:00:00.000Z',
    });

    const sendMessage = vi.fn(async (_chatJid: string, _text: string) => {});
    const runContainer = vi.fn();

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:main': {
          name: 'Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: runContainer,
      sendMessage,
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith('tg:main', 'Reminder: call Sam.');
    expect(runContainer).not.toHaveBeenCalled();
    const task = getTaskById('task-plain-reminder');
    expect(task?.status).toBe('completed');
    expect(task?.last_result).toBe('Reminder: call Sam.');
  });

  it('delivers recurring self-improvement status updates from feedback truth', async () => {
    const feedback: ResponseFeedbackRecord = {
      feedbackId: 'feedback-1',
      createdAt: '2026-05-02T04:00:00.000Z',
      updatedAt: '2026-05-02T04:01:00.000Z',
      status: 'awaiting_confirmation',
      classification: 'repo_side_rough_edge',
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:main',
      threadId: null,
      platformMessageId: 'msg-1',
      userMessageId: 'user-1',
      issueId: 'issue-1',
      routeKey: 'turn_agent_harness.blocked',
      capabilityId: 'assistant.intelligence',
      handlerKind: 'turn_agent_harness_hold',
      responseSource: 'local_companion',
      traceReason: 'downvoted answer',
      traceNotes: [],
      blockerClass: 'provider_blocked',
      blockerOwner: 'repo_side',
      originalUserText: 'The status of the self improvement job',
      assistantReplyText: 'No job is running.',
      linkedRefs: {
        platformRepairPlanId: 'repair-plan-1',
      },
      remediationLaneId: 'andrea_runtime',
      remediationJobId: null,
      remediationRuntimePreference: 'codex_local',
      remediationPrompt: null,
      operatorNote: 'Cloud repair unavailable.',
    };
    upsertResponseFeedback(feedback);
    createTask({
      id: 'task-self-improvement-status',
      group_folder: 'main',
      chat_jid: 'tg:main',
      prompt:
        'Send Andrea self-improvement status update for recent response-feedback repair runs.',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-05-02T04:18:00.000Z',
    });

    const sendMessage = vi.fn(async (_chatJid: string, _text: string) => {});

    startSchedulerLoop({
      registeredGroups: () => ({
        'tg:main': {
          name: 'Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: '2026-05-02T04:00:00.000Z',
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
      } as any,
      onProcess: () => {},
      sendMessage,
      sendToTarget: vi.fn(async () => ({ platformMessageId: 'unused' })),
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = sendMessage.mock.calls[0]?.[1] as string;
    expect(text).toContain('*Self-Improvement Status*');
    expect(text).toContain('repair is staged and waiting for approval');
    expect(text).toContain('Approve local fallback');
    const task = getTaskById('task-self-improvement-status');
    expect(task?.status).toBe('active');
    expect(task?.next_run).not.toBeNull();
  });

  it('records an ambiguous scheduled send as unverified without replaying it', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    const taskId = 'task-scheduled-unverified';
    const nowIso = new Date().toISOString();
    upsertCommunicationThread({
      id: 'comm-scheduled-unverified',
      groupFolder: 'main',
      title: 'Candace',
      linkedSubjectIds: [],
      linkedLifeThreadIds: [],
      channel: 'bluebubbles',
      channelChatJid: 'bb:chat-1',
      lastInboundSummary: 'Candace asked about rehearsal.',
      lastOutboundSummary: null,
      followupState: 'reply_needed',
      urgency: 'tonight',
      followupDueAt: nowIso,
      suggestedNextAction: 'draft_reply',
      toneStyleHints: [],
      lastContactAt: nowIso,
      lastMessageId: 'bb:last-message',
      linkedTaskId: null,
      inferenceState: 'user_confirmed',
      trackingMode: 'default',
      createdAt: nowIso,
      updatedAt: nowIso,
      disabledAt: null,
    });
    createTask({
      id: taskId,
      group_folder: 'main',
      chat_jid: 'bb:chat-1',
      prompt: 'Scheduled message send for the owner',
      schedule_type: 'once',
      schedule_value: nowIso,
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: nowIso,
    });
    upsertMessageAction({
      messageActionId: 'message-scheduled-unverified',
      groupFolder: 'main',
      sourceType: 'manual_prompt',
      sourceKey: 'scheduled-unverified',
      sourceSummary: 'Owner follow-through',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:chat-1',
        isGroup: false,
        personName: 'Candace',
      }),
      draftText: 'Remember to check the rehearsal plan.',
      trustLevel: 'schedule_send',
      sendStatus: 'deferred',
      followupAt: nowIso,
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: JSON.stringify({
        communicationThreadId: 'comm-scheduled-unverified',
      }),
      platformMessageId: null,
      scheduledTaskId: taskId,
      approvedAt: nowIso,
      lastActionKind: 'scheduled_send',
      lastActionAt: nowIso,
      dedupeKey: 'scheduled-unverified',
      presentationChatJid: 'bb:chat-1',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      sentAt: null,
    });
    const sendToTarget = vi.fn(async () => ({
      deliveryState: 'unknown' as const,
      nextUnconfirmedChunkIndex: 0,
    }));

    startSchedulerLoop({
      registeredGroups: () => ({
        'bb:chat-1': {
          name: 'Main',
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
          void fn();
        },
      } as any,
      onProcess: () => {},
      sendMessage: vi.fn(async () => {}),
      sendToTarget,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendToTarget).toHaveBeenCalledTimes(1);
    expect(getMessageAction('message-scheduled-unverified')).toMatchObject({
      sendStatus: 'delivery_unverified',
      trustLevel: 'never_automate',
    });
    expect(getTaskById(taskId)).toMatchObject({
      status: 'completed',
      last_result:
        'Scheduled message delivery could not be verified; automatic retry is blocked.',
    });
  });

  it('drains a pre-pause scheduled send after resume with zero provider dispatches', async () => {
    vi.stubEnv('BLUEBUBBLES_SEND_ENABLED', 'true');
    vi.setSystemTime('2026-05-02T04:30:00.000Z');
    const taskId = 'task-scheduled-before-owner-stop';
    const approvedAt = '2026-05-02T04:00:00.000Z';
    createTask({
      id: taskId,
      group_folder: 'main',
      chat_jid: 'bb:chat-1',
      prompt: 'Scheduled message send for the owner',
      schedule_type: 'once',
      schedule_value: '2026-05-02T04:20:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-05-02T04:20:00.000Z',
      status: 'active',
      created_at: approvedAt,
    });
    upsertMessageAction({
      messageActionId: 'message-scheduled-before-owner-stop',
      groupFolder: 'main',
      sourceType: 'manual_prompt',
      sourceKey: 'scheduled-before-owner-stop',
      sourceSummary: 'Owner follow-through',
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
      targetConversationJson: JSON.stringify({
        kind: 'external_thread',
        chatJid: 'bb:chat-1',
        isGroup: false,
        personName: 'Candace',
      }),
      draftText: 'This stale queued message must not send.',
      trustLevel: 'schedule_send',
      sendStatus: 'deferred',
      followupAt: '2026-05-02T04:20:00.000Z',
      requiresApproval: false,
      delegationRuleId: null,
      delegationMode: null,
      explanationJson: null,
      linkedRefsJson: null,
      platformMessageId: null,
      scheduledTaskId: taskId,
      approvedAt,
      lastActionKind: 'scheduled_send',
      lastActionAt: approvedAt,
      dedupeKey: 'scheduled-before-owner-stop',
      presentationChatJid: 'bb:chat-1',
      presentationThreadId: null,
      presentationMessageId: null,
      createdAt: approvedAt,
      lastUpdatedAt: approvedAt,
      sentAt: null,
    });
    setMessagingOutboundPaused({
      paused: true,
      changedByChatJid: 'tg:owner',
      reason: 'owner_natural_language_pause',
      now: new Date('2026-05-02T04:10:00.000Z'),
    });
    setMessagingOutboundPaused({
      paused: false,
      changedByChatJid: 'tg:owner',
      reason: 'owner_explicit_resume',
      now: new Date('2026-05-02T04:15:00.000Z'),
    });

    const pendingRuns: Promise<void>[] = [];
    const providerDispatch = vi.fn(async () => ({
      platformMessageId: 'bb:must-not-be-created',
    }));
    startSchedulerLoop({
      registeredGroups: () => ({
        'bb:chat-1': {
          name: 'Main',
          folder: 'main',
          trigger: '@andrea',
          added_at: approvedAt,
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
      } as any,
      onProcess: vi.fn(),
      sendMessage: vi.fn(async () => {}),
      sendToTarget: providerDispatch,
    });

    await vi.advanceTimersByTimeAsync(10);
    await Promise.all(pendingRuns);

    expect(providerDispatch).not.toHaveBeenCalled();
    expect(
      getMessageAction('message-scheduled-before-owner-stop'),
    ).toMatchObject({
      sendStatus: 'failed',
      scheduledTaskId: null,
    });
    expect(getTaskById(taskId)).toMatchObject({
      status: 'completed',
      next_run: null,
      last_result: expect.stringContaining('needs a fresh owner action'),
    });
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
