import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import { createHash } from 'node:crypto';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  classifyRuntimeRoute,
  selectPreferredRuntime,
} from './agent-runtime.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  claimScheduledTaskOutboundDispatch,
  completeScheduledTaskOutboundDispatch,
  getCalendarAutomationByTaskId,
  getAllTasks,
  getDueTasks,
  getTaskById,
  isScheduledTaskOutboundDispatchClaimCurrent,
  logTaskRun,
  recoverClaimedScheduledTaskOutboundDispatches,
  terminallyBlockScheduledTaskOutboundDispatch,
  updateCalendarAutomation,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { classifyScheduledTaskRequest } from './assistant-routing.js';
import { getAssistantSessionStorageKey } from './assistant-session.js';
import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import type { ContainerIpcContext } from './container-ipc-auth.js';
import { runScheduledMessageActionByTaskId } from './message-actions.js';
import { buildPlainReminderDeliveryText } from './scheduled-reminder-delivery.js';
import { buildScheduledSelfImprovementStatusUpdate } from './self-improvement-status.js';
import { refreshRecentResponseFeedbackTruth } from './response-feedback.js';
import { emitAndreaPlatformDiagnosis } from './andrea-platform-bridge.js';
import { formatOutbound } from './router.js';
import { validateMessagingOutboundAuthorizationFence } from './messaging-outbound-pause.js';
import { requireCompleteChannelDelivery } from './channel-delivery.js';
import {
  executeCalendarAutomation,
  parseCalendarAutomationRecord,
} from './calendar-automations.js';
import {
  AgentThreadState,
  RegisteredGroup,
  ScheduledTask,
  SendMessageOptions,
  SendMessageResult,
} from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

async function emitReminderDeliveryFailureDiagnostic(input: {
  task: ScheduledTask;
  error: string;
  kind: 'plain_reminder' | 'self_improvement_status';
}): Promise<void> {
  await emitAndreaPlatformDiagnosis({
    goal: `Diagnose failed ${input.kind.replace(/_/g, ' ')} delivery.`,
    correlationId: input.task.id,
    taskFamily: 'assistant',
    channel: 'system',
    includePlatformSignals: false,
    signals: [
      {
        signal_kind: 'reminder_delivery_failure',
        source: 'andrea_task_scheduler',
        severity: 'warning',
        summary: 'Scheduled reminder delivery failed.',
        metadata: {
          task_id: input.task.id,
          group_folder: input.task.group_folder,
          schedule_type: input.task.schedule_type,
          delivery_kind: input.kind,
          error_class: 'send_message_failed',
        },
      },
    ],
    metadata: {
      taskId: input.task.id,
      deliveryKind: input.kind,
      failureClass: 'send_message_failed',
      errorSummary: input.error.slice(0, 180),
      rawContentPolicy: 'metadata_only',
    },
  });
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  getAgentThreads?: () => Record<string, AgentThreadState>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    ipcContext?: ContainerIpcContext,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
  sendToTarget: (
    targetChannel: 'telegram' | 'bluebubbles',
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
}

function isBlockedGenericBlueBubblesTaskTarget(chatJid: string): boolean {
  return (
    chatJid.startsWith('bb:') &&
    !isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)
  );
}

interface GenericBlueBubblesTaskDispatch {
  runKey: string;
  claimToken: string;
  idempotencyKey: string;
  authorizationAt: string;
  pauseGeneration: number;
  providerCallStarted: boolean;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  if (typeof task.script === 'string' && task.script.trim().length > 0) {
    const error =
      'Scheduled task script execution is blocked because the task has no reviewed script approval provenance.';
    updateTask(task.id, { status: 'paused' });
    updateTaskAfterRun(task.id, task.next_run, `Error: ${error}`);
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Paused legacy scheduled task with an unapproved script',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }

  const scheduledMessageResult = await runScheduledMessageActionByTaskId(
    task.id,
    {
      groupFolder: task.group_folder,
      channel: task.chat_jid.startsWith('bb:') ? 'bluebubbles' : 'telegram',
      chatJid: task.chat_jid,
      currentTime: new Date(),
      sendToTarget: deps.sendToTarget,
    },
  );
  if (scheduledMessageResult.handled) {
    if (
      scheduledMessageResult.notificationChatJid &&
      scheduledMessageResult.notificationText
    ) {
      await deps.sendMessage(
        scheduledMessageResult.notificationChatJid,
        scheduledMessageResult.notificationText,
      );
    }

    const durationMs = Date.now() - startTime;
    const deliveryDidNotComplete =
      scheduledMessageResult.action?.sendStatus === 'failed' ||
      scheduledMessageResult.action?.sendStatus === 'delivery_unverified';
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: deliveryDidNotComplete ? 'error' : 'success',
      result: deliveryDidNotComplete
        ? null
        : scheduledMessageResult.resultSummary,
      error: deliveryDidNotComplete
        ? scheduledMessageResult.resultSummary
        : null,
    });
    updateTaskAfterRun(task.id, null, scheduledMessageResult.resultSummary);
    return;
  }

  if (isBlockedGenericBlueBubblesTaskTarget(task.chat_jid)) {
    const error =
      'Generic scheduled tasks cannot target a BlueBubbles contact or group; use the explicitly configured owner self-thread or a recipient-bound scheduled message action.';
    updateTask(task.id, { status: 'paused' });
    updateTaskAfterRun(task.id, task.next_run, `Error: ${error}`);
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Paused generic scheduled task targeting an external BlueBubbles thread',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }

  let blueBubblesDispatch: GenericBlueBubblesTaskDispatch | null = null;
  if (isConfiguredBlueBubblesSelfThreadAliasJid(task.chat_jid)) {
    const authorizationFence = {
      authorizationAt: task.outbound_authorization_at || '',
      pauseGeneration: task.outbound_pause_generation ?? -1,
    };
    const authorization =
      validateMessagingOutboundAuthorizationFence(authorizationFence);
    if (!authorization.ok || !task.next_run) {
      const error =
        authorization.reason ||
        'Scheduled self-thread delivery is missing an exact durable occurrence key.';
      terminallyBlockScheduledTaskOutboundDispatch({
        taskId: task.id,
        lastResult: `Blocked: ${error}`,
      });
      logger.warn(
        { taskId: task.id, groupFolder: task.group_folder },
        'Terminally blocked generic BlueBubbles task with stale owner authority',
      );
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        status: 'error',
        result: null,
        error,
      });
      return;
    }

    const runKey = task.next_run;
    const claim = claimScheduledTaskOutboundDispatch({
      taskId: task.id,
      runKey,
    });
    if (claim.status !== 'claimed' || !claim.claimToken) {
      logger.warn(
        { taskId: task.id, runKey, claimStatus: claim.status },
        'Skipped generic BlueBubbles task because its durable occurrence is already claimed or stale',
      );
      return;
    }
    blueBubblesDispatch = {
      runKey,
      claimToken: claim.claimToken,
      idempotencyKey: `scheduled-task:${createHash('sha256')
        .update(task.id)
        .update('\u0000')
        .update(runKey)
        .digest('hex')
        .slice(0, 32)}`,
      authorizationAt: authorizationFence.authorizationAt,
      pauseGeneration: authorizationFence.pauseGeneration,
      providerCallStarted: false,
    };
  }

  const finishTask = (nextRun: string | null, lastResult: string): void => {
    if (!blueBubblesDispatch) {
      updateTaskAfterRun(task.id, nextRun, lastResult);
      return;
    }
    const completed = completeScheduledTaskOutboundDispatch({
      taskId: task.id,
      runKey: blueBubblesDispatch.runKey,
      claimToken: blueBubblesDispatch.claimToken,
      nextRun,
      lastResult,
    });
    if (!completed) {
      logger.warn(
        { taskId: task.id, runKey: blueBubblesDispatch.runKey },
        'Could not commit generic BlueBubbles task result because its durable claim changed',
      );
    }
  };

  const sendTaskMessage = async (text: string): Promise<void> => {
    if (!blueBubblesDispatch) {
      await deps.sendMessage(task.chat_jid, text);
      return;
    }
    if (blueBubblesDispatch.providerCallStarted) {
      throw new Error(
        'A generic scheduled self-thread occurrence may dispatch at most one message.',
      );
    }
    if (
      !isScheduledTaskOutboundDispatchClaimCurrent({
        taskId: task.id,
        runKey: blueBubblesDispatch.runKey,
        claimToken: blueBubblesDispatch.claimToken,
      })
    ) {
      throw new Error(
        'Scheduled self-thread delivery lost its durable dispatch claim before provider execution.',
      );
    }
    const authorization = validateMessagingOutboundAuthorizationFence({
      authorizationAt: blueBubblesDispatch.authorizationAt,
      pauseGeneration: blueBubblesDispatch.pauseGeneration,
    });
    if (!authorization.ok) {
      terminallyBlockScheduledTaskOutboundDispatch({
        taskId: task.id,
        lastResult: `Blocked: ${authorization.reason || 'owner authorization is no longer valid'}`,
      });
      throw new Error(
        authorization.reason ||
          'Scheduled self-thread owner authorization is no longer valid.',
      );
    }
    blueBubblesDispatch.providerCallStarted = true;
    requireCompleteChannelDelivery(
      await deps.sendToTarget('bluebubbles', task.chat_jid, text, {
        idempotencyKey: blueBubblesDispatch.idempotencyKey,
        blueBubblesAuthorizationAt: blueBubblesDispatch.authorizationAt,
        blueBubblesPauseGeneration: blueBubblesDispatch.pauseGeneration,
      }),
    );
  };

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const automationRecord = getCalendarAutomationByTaskId(task.id);
  if (automationRecord) {
    let resultSummary = 'Completed';
    let error: string | null = null;
    try {
      const automation = parseCalendarAutomationRecord(automationRecord);
      const execution = await executeCalendarAutomation(automation);
      if (execution.message) {
        await sendTaskMessage(execution.message);
      }
      resultSummary = execution.summary;
      updateCalendarAutomation(task.id, {
        dedupe_state_json: execution.dedupeState
          ? JSON.stringify(execution.dedupeState)
          : null,
        updated_at: new Date().toISOString(),
      });
      logger.info(
        { taskId: task.id, durationMs: Date.now() - startTime },
        'Calendar automation task completed',
      );
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      resultSummary = `Error: ${error}`;
      logger.error(
        { taskId: task.id, error },
        'Calendar automation task failed',
      );
    }

    const durationMs = Date.now() - startTime;
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: error ? 'error' : 'success',
      result: error ? null : resultSummary,
      error,
    });

    const nextRun = computeNextRun(task);
    finishTask(nextRun, resultSummary);
    return;
  }

  if (task.prompt.startsWith('Scheduled message send for ')) {
    const durationMs = Date.now() - startTime;
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: durationMs,
      status: 'error',
      result: null,
      error: 'Scheduled message task lost its linked message action.',
    });
    finishTask(null, 'Scheduled message task lost its linked message action.');
    return;
  }

  const plainReminderText = buildPlainReminderDeliveryText(task);
  if (plainReminderText) {
    try {
      await sendTaskMessage(plainReminderText);
      const durationMs = Date.now() - startTime;
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: 'success',
        result: plainReminderText,
        error: null,
      });
      finishTask(computeNextRun(task), plainReminderText);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: 'error',
        result: null,
        error,
      });
      finishTask(computeNextRun(task), `Error: ${error}`);
      await emitReminderDeliveryFailureDiagnostic({
        task,
        error,
        kind: 'plain_reminder',
      });
    }
    return;
  }

  const selfImprovementStatusText = buildScheduledSelfImprovementStatusUpdate(
    task,
    await refreshRecentResponseFeedbackTruth({
      chatJid: task.chat_jid,
      limit: 10,
    }),
  );
  if (selfImprovementStatusText) {
    try {
      await sendTaskMessage(selfImprovementStatusText);
      const durationMs = Date.now() - startTime;
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: 'success',
        result: selfImprovementStatusText.slice(0, 200),
        error: null,
      });
      finishTask(computeNextRun(task), selfImprovementStatusText.slice(0, 200));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      logTaskRun({
        task_id: task.id,
        run_at: new Date().toISOString(),
        duration_ms: durationMs,
        status: 'error',
        result: null,
        error,
      });
      finishTask(computeNextRun(task), `Error: ${error}`);
      await emitReminderDeliveryFailureDiagnostic({
        task,
        error,
        kind: 'self_improvement_status',
      });
    }
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const agentThreads = deps.getAgentThreads ? deps.getAgentThreads() : {};
  const requestPolicy = classifyScheduledTaskRequest(task.prompt);
  const runtimeRoute = classifyRuntimeRoute(requestPolicy, task.prompt, {
    isScheduledTask: true,
  });
  const existingThread =
    task.context_mode === 'group' ? agentThreads[task.group_folder] : undefined;
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const sessionId =
    task.context_mode === 'group'
      ? sessions[
          getAssistantSessionStorageKey(task.group_folder, requestPolicy.route)
        ]
      : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait the normal idle timeout for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        requestPolicy,
        preferredRuntime,
        runtimeRoute,
      },
      (proc, containerName, ipcContext) =>
        deps.onProcess(
          task.chat_jid,
          proc,
          containerName,
          task.group_folder,
          ipcContext,
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          const outbound = formatOutbound(streamedOutput.result);
          result = outbound || null;
          if (outbound) {
            await sendTaskMessage(outbound);
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  finishTask(nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  const recoveredDispatches = recoverClaimedScheduledTaskOutboundDispatches();
  if (recoveredDispatches > 0) {
    logger.warn(
      { count: recoveredDispatches },
      'Blocked prior-process scheduled self-thread claims without replay',
    );
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
