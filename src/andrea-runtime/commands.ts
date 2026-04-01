import path from 'path';
import fs from 'fs';

import type {
  BackendGetJobLogsParams,
  BackendGetJobParams,
  BackendJobDetails,
  BackendJobHandle,
  BackendJobLogsResult,
  BackendJobSummary,
  BackendPrimaryOutputResult,
} from '../backend-lanes/types.js';
import {
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
} from '../operator-command-gate.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import {
  formatHumanTaskStatus,
  formatOpaqueTaskId,
  formatShellTaskCard,
  formatTaskNextStepMessage,
  formatTaskOutputHeading,
} from '../task-presentation.js';
import type { SendMessageOptions } from '../types.js';
import {
  buildTaskOutputSuggestion,
  getTaskContextType,
  interpretTaskContinuation,
  maybeBuildHarmlessTaskReply,
  mergeTaskMessageContextPayload,
  summarizeVisibleTaskText,
  type TaskContextType,
} from '../task-continuation.js';

export interface RuntimeJobSnapshot {
  groupFolder: string | null;
  groupJid: string;
  active: boolean;
  idleWaiting: boolean;
  runningTaskId?: string | null;
  pendingMessages: boolean;
  pendingTaskCount: number;
  containerName?: string | null;
}

export interface ResolvedRuntimeGroup {
  jid: string;
  folder: string;
}

export interface ResolvedRuntimeTarget {
  handle: BackendJobHandle;
  jobId: string;
  via: 'explicit' | 'ordinal' | 'current' | 'reply' | 'selected';
}

export interface RuntimeTargetResolutionResult {
  target: ResolvedRuntimeTarget | null;
  failureMessage: string | null;
}

export interface RuntimeCommandContext {
  operatorChatJid: string;
  groupFolder: string;
  rawTrimmed: string;
  commandToken: string;
  threadId?: string;
  replyToMessageId?: string;
  replyMessageContext?: {
    agentId: string | null;
    contextKind: string;
    payload: Record<string, unknown> | null;
  } | null;
}

export interface RuntimeCommandDependencies {
  sendToChat(
    chatJid: string,
    text: string,
    extra?: Pick<SendMessageOptions, 'inlineActions'>,
  ): Promise<string | undefined>;
  sendRuntimeJobMessage(args: {
    operatorChatJid: string;
    text: string;
    jobId: string;
    contextKind: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
  }): Promise<string | undefined>;
  rememberRuntimeJobList(args: {
    chatJid: string;
    threadId?: string;
    listMessageId?: string;
    jobs: BackendJobSummary[];
  }): void;
  getStatusMessage(): string;
  canExecute: boolean;
  getExecutionDisabledMessage(): string;
  getRuntimeJobs(): RuntimeJobSnapshot[];
  findGroupByFolder(folder: string): ResolvedRuntimeGroup | null;
  requestStop(groupJid: string): boolean;
  listJobs(args: {
    chatJid: string;
    groupFolder?: string;
    limit?: number;
  }): Promise<BackendJobSummary[]>;
  resolveTarget(args: {
    chatJid: string;
    threadId?: string;
    replyToMessageId?: string;
    requestedTarget?: string | null;
  }): RuntimeTargetResolutionResult;
  refreshJob(args: BackendGetJobParams): Promise<BackendJobDetails | null>;
  getPrimaryOutput(
    args: BackendGetJobLogsParams,
  ): Promise<BackendPrimaryOutputResult>;
  getJobLogs(args: BackendGetJobLogsParams): Promise<BackendJobLogsResult>;
  stopJob(args: {
    handle: BackendJobHandle;
    groupFolder: string;
    chatJid: string;
  }): Promise<BackendJobDetails>;
  followUpJob(args: {
    handle: BackendJobHandle;
    groupFolder: string;
    chatJid: string;
    promptText: string;
  }): Promise<BackendJobDetails>;
  followUpLegacyGroup(args: {
    groupFolder: string;
    chatJid: string;
    promptText: string;
  }): Promise<BackendJobDetails>;
  formatFailure(args: {
    operation: string;
    err: unknown;
    targetDisplay?: string | null;
    guidance?: string | null;
  }): string;
}

function isExplicitRuntimeTargetToken(token: string | undefined): boolean {
  const trimmed = token?.trim();
  if (!trimmed) return false;
  if (/^\d+$/.test(trimmed)) return true;
  if (trimmed.toLowerCase() === 'current') return true;
  return /^runtime-job-/i.test(trimmed);
}

function formatRuntimeJobListEntry(
  job: BackendJobSummary,
  ordinal: number,
): string {
  const updatedAt = job.updatedAt || job.createdAt;
  return `${ordinal}. ${formatOpaqueTaskId(job.handle.jobId)} [${formatHumanTaskStatus(job.status)}]${job.summary ? `\n   ${job.summary}` : ''}${updatedAt ? `\n   updated ${updatedAt}` : ''}`;
}

export function formatRuntimeJobsMessage(jobs: BackendJobSummary[]): string {
  if (jobs.length === 0) {
    return 'Andrea has no recent Codex/OpenAI tasks in this workspace right now.';
  }

  return [
    '*Codex/OpenAI Work*',
    ...jobs.map((job, index) => formatRuntimeJobListEntry(job, index + 1)),
    '',
    'Open `/cursor` -> `Codex/OpenAI` -> `Recent Work`, then reply to a task card to continue or inspect this work. `/runtime-logs`, `/runtime-followup`, and `/runtime-stop` still accept a list number, `current`, or a runtime task id when you want an explicit fallback.',
  ].join('\n');
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(120, parsed);
}

export function formatRuntimeJobCard(job: BackendJobDetails): string {
  const metadata = (job.metadata || {}) as Record<string, unknown>;
  return formatShellTaskCard({
    title: `Task ${formatOpaqueTaskId(job.handle.jobId)}`,
    lane: 'codex_runtime',
    status: job.status,
    detailLines: [
      typeof metadata.groupFolder === 'string'
        ? `Workspace: ${metadata.groupFolder}`
        : null,
      typeof metadata.selectedRuntime === 'string'
        ? `Runtime: ${metadata.selectedRuntime}`
        : null,
      typeof metadata.threadId === 'string'
        ? `Thread: ${metadata.threadId}`
        : null,
    ],
    summary: job.summary,
    updatedAt: job.updatedAt,
  });
}

export function formatRuntimeNextStep(jobId: string): string {
  return formatTaskNextStepMessage({
    primaryActions:
      'Use this task card or `/runtime-logs` to refresh this task or view output.',
    canReplyContinue: true,
    explicitFallback: `\`/runtime-followup ${jobId} <text>\` and \`/runtime-stop\` still work if you want explicit fallbacks.`,
  });
}

function getRuntimeJobErrorText(
  job: Pick<BackendJobDetails, 'metadata'> | null | undefined,
): string | null {
  const metadata = (job?.metadata || {}) as Record<string, unknown>;
  const errorText =
    typeof metadata.errorText === 'string' ? metadata.errorText.trim() : '';
  return errorText || null;
}

export function buildRuntimeJobInlineActions(params: {
  job: Pick<BackendJobDetails, 'status'>;
  contextKind: 'runtime_job_card' | 'runtime_job_message';
  canExecute: boolean;
}): SendMessageOptions['inlineActions'] {
  const actions: NonNullable<SendMessageOptions['inlineActions']> = [
    {
      label:
        params.contextKind === 'runtime_job_message'
          ? 'Refresh'
          : 'View Output',
      actionId: '/runtime-logs',
    },
  ];

  if (
    params.canExecute &&
    (params.job.status === 'queued' || params.job.status === 'running')
  ) {
    actions.push({ label: 'Stop Run', actionId: '/runtime-stop' });
  }

  return actions;
}

export function buildRuntimeStatusInlineActions(): NonNullable<
  SendMessageOptions['inlineActions']
> {
  return [
    { label: 'Refresh', actionId: '/runtime-status' },
    { label: 'Recent Work', actionId: '/runtime-jobs' },
    { label: 'Open /cursor', actionId: '/cursor' },
  ];
}

function buildRuntimeTaskPayload(
  job: Pick<BackendJobDetails, 'handle' | 'summary' | 'metadata'>,
  contextType: TaskContextType,
  extras: {
    outputPreview?: string | null;
    outputSource?: string | null;
  } = {},
): Record<string, unknown> | null {
  return mergeTaskMessageContextPayload(job.metadata || null, {
    taskContextType: contextType,
    taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(job.handle.jobId)}`,
    taskSummary: summarizeVisibleTaskText(job.summary),
    outputPreview: summarizeVisibleTaskText(extras.outputPreview),
    outputSource: extras.outputSource || null,
  });
}

function buildLegacyFallbackContext(params: {
  deps: RuntimeCommandDependencies;
  context: RuntimeCommandContext;
  requestedTarget: string | null;
}): {
  target: ResolvedRuntimeTarget | null;
  failureMessage: string | null;
  legacyTargetToken: string | null;
} {
  const requestedTarget = params.requestedTarget?.trim() || null;
  if (requestedTarget && isExplicitRuntimeTargetToken(requestedTarget)) {
    const resolved = params.deps.resolveTarget({
      chatJid: params.context.operatorChatJid,
      threadId: params.context.threadId,
      replyToMessageId: params.context.replyToMessageId,
      requestedTarget,
    });
    return {
      target: resolved.target,
      failureMessage: resolved.failureMessage,
      legacyTargetToken: null,
    };
  }

  const resolved = params.deps.resolveTarget({
    chatJid: params.context.operatorChatJid,
    threadId: params.context.threadId,
    replyToMessageId: params.context.replyToMessageId,
  });
  return {
    target: resolved.target,
    failureMessage: resolved.failureMessage,
    legacyTargetToken: requestedTarget,
  };
}

function readLegacyLogTail(
  groupFolder: string,
  lineLimit: number,
): string | null {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const logsDir = path.join(groupDir, 'logs');
  if (!fs.existsSync(logsDir)) return null;

  const entries = fs
    .readdirSync(logsDir)
    .filter((entry) => entry.endsWith('.log'))
    .sort();

  const latest = entries.at(-1);
  if (!latest) return null;

  const content = fs.readFileSync(path.join(logsDir, latest), 'utf-8');
  const lines = content.trim().split(/\r?\n/);
  const tail = lines.slice(-Math.max(1, lineLimit));
  return [`Latest log: ${latest}`, ...tail].join('\n');
}

async function handleRuntimeJobs(
  deps: RuntimeCommandDependencies,
  context: RuntimeCommandContext,
): Promise<void> {
  const jobs = await deps.listJobs({
    chatJid: context.operatorChatJid,
    limit: 20,
  });
  const messageId = await deps.sendToChat(
    context.operatorChatJid,
    formatRuntimeJobsMessage(jobs),
  );
  deps.rememberRuntimeJobList({
    chatJid: context.operatorChatJid,
    threadId: context.threadId,
    listMessageId: messageId,
    jobs,
  });
}

async function handleRuntimeFollowup(
  deps: RuntimeCommandDependencies,
  context: RuntimeCommandContext,
): Promise<void> {
  if (!deps.canExecute) {
    await deps.sendToChat(
      context.operatorChatJid,
      deps.getExecutionDisabledMessage(),
      {
        inlineActions: buildRuntimeStatusInlineActions(),
      },
    );
    return;
  }

  const parts = context.rawTrimmed.split(/\s+/);
  const requestedTarget = parts[1] || null;
  const resolution = buildLegacyFallbackContext({
    deps,
    context,
    requestedTarget,
  });
  const promptText = resolution.target
    ? parts
        .slice(
          requestedTarget && isExplicitRuntimeTargetToken(requestedTarget)
            ? 2
            : 1,
        )
        .join(' ')
        .trim()
    : parts.slice(2).join(' ').trim();

  if (resolution.target) {
    if (!promptText) {
      await deps.sendToChat(
        context.operatorChatJid,
        'Usage: /runtime-followup [JOB_ID|LIST_NUMBER|current] TEXT',
      );
      return;
    }

    try {
      const canUseReplyContext =
        context.replyMessageContext?.agentId === resolution.target.jobId;
      if (canUseReplyContext) {
        const harmlessReply = maybeBuildHarmlessTaskReply(promptText);
        if (harmlessReply) {
          await deps.sendToChat(context.operatorChatJid, harmlessReply);
          return;
        }
      }
      const normalizedPromptText = canUseReplyContext
        ? interpretTaskContinuation({
            laneId: 'andrea_runtime',
            rawPrompt: promptText,
            contextKind: getTaskContextType(
              context.replyMessageContext?.payload,
            ),
            messageContextPayload: context.replyMessageContext?.payload,
            taskId: resolution.target.jobId,
            taskLabel: 'Codex/OpenAI runtime',
          }).normalizedPromptText
        : promptText;
      const followed = await deps.followUpJob({
        handle: resolution.target.handle,
        groupFolder: context.groupFolder,
        chatJid: context.operatorChatJid,
        promptText: normalizedPromptText,
      });
      await deps.sendRuntimeJobMessage({
        operatorChatJid: context.operatorChatJid,
        jobId: followed.handle.jobId,
        contextKind: 'runtime_job_card',
        payload: buildRuntimeTaskPayload(followed, 'job_card'),
        inlineActions: buildRuntimeJobInlineActions({
          job: followed,
          contextKind: 'runtime_job_card',
          canExecute: deps.canExecute,
        }),
        text: [
          'Andrea sent your next instruction to this task.',
          `Task: Codex/OpenAI runtime ${formatOpaqueTaskId(followed.handle.jobId)}.`,
          formatRuntimeNextStep(followed.handle.jobId),
        ].join('\n\n'),
      });
      return;
    } catch (err) {
      await deps.sendToChat(
        context.operatorChatJid,
        deps.formatFailure({
          operation: 'Andrea runtime follow-up failed',
          err,
          targetDisplay: resolution.target.jobId,
        }),
      );
      return;
    }
  }

  const legacyTarget = resolution.legacyTargetToken;
  if (!legacyTarget || !promptText) {
    await deps.sendToChat(
      context.operatorChatJid,
      resolution.failureMessage ||
        'Usage: /runtime-followup [JOB_ID|LIST_NUMBER|current|GROUP_FOLDER] TEXT',
    );
    return;
  }

  const groupTarget = deps.findGroupByFolder(legacyTarget);
  if (!groupTarget) {
    await deps.sendToChat(
      context.operatorChatJid,
      `No registered group found for folder "${legacyTarget}".`,
    );
    return;
  }

  try {
    const followed = await deps.followUpLegacyGroup({
      groupFolder: groupTarget.folder,
      chatJid: context.operatorChatJid,
      promptText,
    });
    await deps.sendRuntimeJobMessage({
      operatorChatJid: context.operatorChatJid,
      jobId: followed.handle.jobId,
      contextKind: 'runtime_job_card',
      payload: buildRuntimeTaskPayload(followed, 'job_card'),
      inlineActions: buildRuntimeJobInlineActions({
        job: followed,
        contextKind: 'runtime_job_card',
        canExecute: deps.canExecute,
      }),
      text: [
        `Andrea started this task in the Codex/OpenAI lane for workspace ${legacyTarget}.`,
        `Task: Codex/OpenAI runtime ${formatOpaqueTaskId(followed.handle.jobId)}.`,
        `Status: ${formatHumanTaskStatus(followed.status)}.`,
        formatRuntimeNextStep(followed.handle.jobId),
      ].join('\n\n'),
    });
  } catch (err) {
    await deps.sendToChat(
      context.operatorChatJid,
      deps.formatFailure({
        operation: 'Andrea runtime follow-up failed',
        err,
        targetDisplay: legacyTarget,
      }),
    );
  }
}

async function handleRuntimeStop(
  deps: RuntimeCommandDependencies,
  context: RuntimeCommandContext,
): Promise<void> {
  const parts = context.rawTrimmed.split(/\s+/);
  const requestedTarget = parts[1] || null;
  const resolution = buildLegacyFallbackContext({
    deps,
    context,
    requestedTarget,
  });

  if (resolution.target) {
    try {
      const stopped = await deps.stopJob({
        handle: resolution.target.handle,
        groupFolder: context.groupFolder,
        chatJid: context.operatorChatJid,
      });
      await deps.sendRuntimeJobMessage({
        operatorChatJid: context.operatorChatJid,
        jobId: stopped.handle.jobId,
        contextKind: 'runtime_job_card',
        payload: buildRuntimeTaskPayload(stopped, 'job_card'),
        inlineActions: buildRuntimeJobInlineActions({
          job: stopped,
          contextKind: 'runtime_job_card',
          canExecute: deps.canExecute,
        }),
        text: `Stop requested for this task.\nTask: Codex/OpenAI runtime ${formatOpaqueTaskId(stopped.handle.jobId)}.\nStatus: ${formatHumanTaskStatus(stopped.status)}.\n\nReply to this task card with \`/runtime-logs\` when you want to refresh its latest output or error state.`,
      });
      return;
    } catch (err) {
      await deps.sendToChat(
        context.operatorChatJid,
        deps.formatFailure({
          operation: 'Andrea runtime stop failed',
          err,
          targetDisplay: resolution.target.jobId,
        }),
      );
      return;
    }
  }

  const legacyTarget = resolution.legacyTargetToken;
  if (!legacyTarget) {
    await deps.sendToChat(
      context.operatorChatJid,
      resolution.failureMessage ||
        'Usage: /runtime-stop [JOB_ID|LIST_NUMBER|current|GROUP_FOLDER]',
    );
    return;
  }

  const targetGroup = deps.findGroupByFolder(legacyTarget);
  if (!targetGroup) {
    await deps.sendToChat(
      context.operatorChatJid,
      `No registered group found for folder "${legacyTarget}".`,
    );
    return;
  }

  const candidateJobs = await deps.listJobs({
    chatJid: context.operatorChatJid,
    groupFolder: targetGroup.folder,
    limit: 20,
  });
  const activeJob =
    candidateJobs.find((job) => job.status === 'running') ||
    candidateJobs.find((job) => job.status === 'queued') ||
    null;

  if (activeJob) {
    try {
      const stopped = await deps.stopJob({
        handle: activeJob.handle,
        groupFolder: targetGroup.folder,
        chatJid: context.operatorChatJid,
      });
      await deps.sendRuntimeJobMessage({
        operatorChatJid: context.operatorChatJid,
        jobId: stopped.handle.jobId,
        contextKind: 'runtime_job_card',
        payload: buildRuntimeTaskPayload(stopped, 'job_card'),
        inlineActions: buildRuntimeJobInlineActions({
          job: stopped,
          contextKind: 'runtime_job_card',
          canExecute: deps.canExecute,
        }),
        text: `Stop requested for this task in workspace ${legacyTarget}.\nTask: Codex/OpenAI runtime ${formatOpaqueTaskId(stopped.handle.jobId)}.\nStatus: ${formatHumanTaskStatus(stopped.status)}.`,
      });
      return;
    } catch (err) {
      await deps.sendToChat(
        context.operatorChatJid,
        deps.formatFailure({
          operation: 'Andrea runtime stop failed',
          err,
          targetDisplay: legacyTarget,
        }),
      );
      return;
    }
  }

  const stopRequested = deps.requestStop(targetGroup.jid);
  await deps.sendToChat(
    context.operatorChatJid,
    stopRequested
      ? `Stop requested for runtime work in ${legacyTarget}.`
      : `No active Codex/OpenAI task was found for ${legacyTarget}.`,
  );
}

async function handleRuntimeLogs(
  deps: RuntimeCommandDependencies,
  context: RuntimeCommandContext,
): Promise<void> {
  const parts = context.rawTrimmed.split(/\s+/);
  const requestedTarget = parts[1] || null;
  const resolution = buildLegacyFallbackContext({
    deps,
    context,
    requestedTarget,
  });
  const explicitTargetUsed =
    Boolean(requestedTarget) &&
    isExplicitRuntimeTargetToken(requestedTarget || undefined);
  const lineLimit = parsePositiveInt(
    parts[explicitTargetUsed ? 2 : 1] || undefined,
    40,
  );

  if (resolution.target) {
    try {
      const [job, output, logs] = await Promise.all([
        deps.refreshJob({
          handle: resolution.target.handle,
          groupFolder: context.groupFolder,
          chatJid: context.operatorChatJid,
        }),
        deps.getPrimaryOutput({
          handle: resolution.target.handle,
          groupFolder: context.groupFolder,
          chatJid: context.operatorChatJid,
          limit: lineLimit,
        }),
        deps.getJobLogs({
          handle: resolution.target.handle,
          groupFolder: context.groupFolder,
          chatJid: context.operatorChatJid,
          limit: lineLimit,
        }),
      ]);
      const targetJob = job || {
        handle: resolution.target.handle,
        status: 'unknown',
        summary: null,
        metadata: null,
      };
      const errorText = getRuntimeJobErrorText(targetJob as BackendJobDetails);
      const text = output.text || logs.logText || errorText;
      const hasStructuredOutput = Boolean(output.text);
      const contextType: TaskContextType = hasStructuredOutput
        ? 'output'
        : 'activity';
      const suggestion = buildTaskOutputSuggestion({
        laneId: 'andrea_runtime',
        contextKind: contextType,
        hasStructuredOutput,
        canReplyContinue: deps.canExecute,
      });
      await deps.sendRuntimeJobMessage({
        operatorChatJid: context.operatorChatJid,
        jobId: resolution.target.jobId,
        contextKind: 'runtime_job_message',
        payload: buildRuntimeTaskPayload(
          (job || targetJob) as Pick<
            BackendJobDetails,
            'handle' | 'summary' | 'metadata'
          >,
          contextType,
          {
            outputPreview: output.text || logs.logText || errorText,
            outputSource: hasStructuredOutput
              ? output.source
              : errorText
                ? 'error'
                : 'logs',
          },
        ),
        inlineActions: buildRuntimeJobInlineActions({
          job: targetJob as BackendJobDetails,
          contextKind: 'runtime_job_message',
          canExecute: deps.canExecute,
        }),
        text: text
          ? [
              `${formatRuntimeJobCard(targetJob as BackendJobDetails)}`,
              '',
              output.text
                ? `${formatTaskOutputHeading(output.source)}:\n${output.text}`
                : errorText
                  ? `Current error:\n${errorText}`
                  : `Recent activity:\n${logs.logText}\n\nStructured output is not available yet, so Andrea is showing recent task activity instead.`,
              suggestion ? '' : null,
              suggestion,
              '',
              formatRuntimeNextStep(resolution.target.jobId),
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          : `This task does not have output yet.\nTask: Codex/OpenAI runtime ${formatOpaqueTaskId(resolution.target.jobId)}.\n\nReply with plain text to continue this task, or rerun \`/runtime-logs\` later if you want another explicit check.`,
      });
      return;
    } catch (err) {
      await deps.sendToChat(
        context.operatorChatJid,
        deps.formatFailure({
          operation: 'Andrea runtime output lookup failed',
          err,
          targetDisplay: resolution.target.jobId,
        }),
      );
      return;
    }
  }

  const legacyTarget = resolution.legacyTargetToken;
  if (!legacyTarget) {
    await deps.sendToChat(
      context.operatorChatJid,
      resolution.failureMessage ||
        'Usage: /runtime-logs [JOB_ID|LIST_NUMBER|current|GROUP_FOLDER] [LINES]',
    );
    return;
  }

  const groupTarget = deps.findGroupByFolder(legacyTarget);
  if (!groupTarget) {
    await deps.sendToChat(
      context.operatorChatJid,
      `No registered group found for folder "${legacyTarget}".`,
    );
    return;
  }

  const jobs = await deps.listJobs({
    chatJid: context.operatorChatJid,
    groupFolder: groupTarget.folder,
    limit: 20,
  });
  const latestJob = jobs[0] || null;

  if (latestJob) {
    try {
      const [job, output, logs] = await Promise.all([
        deps.refreshJob({
          handle: latestJob.handle,
          groupFolder: groupTarget.folder,
          chatJid: context.operatorChatJid,
        }),
        deps.getPrimaryOutput({
          handle: latestJob.handle,
          groupFolder: groupTarget.folder,
          chatJid: context.operatorChatJid,
          limit: lineLimit,
        }),
        deps.getJobLogs({
          handle: latestJob.handle,
          groupFolder: groupTarget.folder,
          chatJid: context.operatorChatJid,
          limit: lineLimit,
        }),
      ]);
      const hydratedJob = (job || latestJob) as BackendJobDetails;
      const errorText = getRuntimeJobErrorText(hydratedJob);
      const text = output.text || logs.logText || errorText;
      const hasStructuredOutput = Boolean(output.text);
      const contextType: TaskContextType = hasStructuredOutput
        ? 'output'
        : 'activity';
      const suggestion = buildTaskOutputSuggestion({
        laneId: 'andrea_runtime',
        contextKind: contextType,
        hasStructuredOutput,
        canReplyContinue: deps.canExecute,
      });
      await deps.sendRuntimeJobMessage({
        operatorChatJid: context.operatorChatJid,
        jobId: latestJob.handle.jobId,
        contextKind: 'runtime_job_message',
        payload: buildRuntimeTaskPayload(
          hydratedJob as Pick<
            BackendJobDetails,
            'handle' | 'summary' | 'metadata'
          >,
          contextType,
          {
            outputPreview: output.text || logs.logText || errorText,
            outputSource: hasStructuredOutput
              ? output.source
              : errorText
                ? 'error'
                : 'logs',
          },
        ),
        inlineActions: buildRuntimeJobInlineActions({
          job: hydratedJob,
          contextKind: 'runtime_job_message',
          canExecute: deps.canExecute,
        }),
        text: text
          ? [
              `${formatRuntimeJobCard(hydratedJob)}`,
              '',
              output.text
                ? `${formatTaskOutputHeading(output.source)}:\n${output.text}`
                : errorText
                  ? `Current error:\n${errorText}`
                  : `Recent activity:\n${logs.logText}\n\nStructured output is not available yet, so Andrea is showing recent task activity instead.`,
              suggestion ? '' : null,
              suggestion,
              '',
              formatRuntimeNextStep(latestJob.handle.jobId),
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          : `This task does not have output yet.\nTask: Codex/OpenAI runtime ${formatOpaqueTaskId(latestJob.handle.jobId)}.`,
      });
      return;
    } catch (err) {
      await deps.sendToChat(
        context.operatorChatJid,
        deps.formatFailure({
          operation: 'Andrea runtime output lookup failed',
          err,
          targetDisplay: legacyTarget,
        }),
      );
      return;
    }
  }

  const legacyLogText = readLegacyLogTail(groupTarget.folder, lineLimit);
  await deps.sendToChat(
    context.operatorChatJid,
    legacyLogText ||
      `No Codex/OpenAI runtime logs were found yet for ${legacyTarget}.`,
  );
}

export async function dispatchRuntimeCommand(
  deps: RuntimeCommandDependencies,
  context: RuntimeCommandContext,
): Promise<boolean> {
  if (RUNTIME_STATUS_COMMANDS.has(context.commandToken)) {
    await deps.sendToChat(context.operatorChatJid, deps.getStatusMessage(), {
      inlineActions: buildRuntimeStatusInlineActions(),
    });
    return true;
  }

  if (RUNTIME_JOBS_COMMANDS.has(context.commandToken)) {
    await handleRuntimeJobs(deps, context);
    return true;
  }

  if (RUNTIME_FOLLOWUP_COMMANDS.has(context.commandToken)) {
    await handleRuntimeFollowup(deps, context);
    return true;
  }

  if (RUNTIME_STOP_COMMANDS.has(context.commandToken)) {
    await handleRuntimeStop(deps, context);
    return true;
  }

  if (RUNTIME_LOGS_COMMANDS.has(context.commandToken)) {
    await handleRuntimeLogs(deps, context);
    return true;
  }

  return false;
}

export function readLatestRuntimeLog(
  groupFolder: string,
  lineLimit: number,
): string | null {
  return readLegacyLogTail(groupFolder, lineLimit);
}
