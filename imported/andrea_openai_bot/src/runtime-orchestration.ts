import type { ChildProcess } from 'child_process';
import fs from 'fs';

import {
  classifyRuntimeRoute,
  selectPreferredRuntime,
  shouldReuseExistingThread,
} from './agent-runtime.js';
import {
  classifyAssistantRequest,
  type AssistantRequestPolicy,
} from './assistant-routing.js';
import type {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
} from './container-runner.js';
import {
  createRuntimeOrchestrationJob,
  findLatestRuntimeJobByThread,
  getRuntimeOrchestrationJob,
  listRuntimeOrchestrationJobs,
  updateRuntimeOrchestrationJob,
  type RuntimeOrchestrationJobRecord,
} from './db.js';
import type { RuntimeJobSnapshot as QueueRuntimeJobSnapshot } from './group-queue.js';
import { logger } from './logger.js';
import type {
  AgentRuntimeName,
  AgentThreadState,
  CreateRuntimeJobRequest,
  FollowUpRuntimeJobRequest,
  GetRuntimeJobLogsRequest,
  ListRuntimeJobsRequest,
  OrchestrationSource,
  RegisteredGroup,
  RuntimeJobLogsResult,
  RuntimeOrchestrationJob,
  RuntimeOrchestrationJobList,
  RuntimeRoute,
  StopRuntimeJobRequest,
  StopRuntimeJobResult,
} from './types.js';

export interface RuntimeExecutionDependencies {
  assistantName: string;
  getAvailableGroups(): AvailableGroup[];
  getRegisteredGroupJids(): Set<string>;
  getSession(groupFolder: string): string | undefined;
  getStoredThread(groupFolder: string): AgentThreadState | undefined;
  persistAgentThread(
    groupFolder: string,
    threadId: string,
    runtime: AgentRuntimeName,
  ): void;
  refreshTaskSnapshots(): void;
  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void;
  runContainerAgent(
    group: RegisteredGroup,
    input: ContainerInput,
    onProcess?: (proc: ChildProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput>;
  writeGroupsSnapshot(
    groupFolder: string,
    isMain: boolean,
    groups: AvailableGroup[],
    registeredJids: Set<string>,
  ): void;
}

export interface RuntimeExecutionRequest {
  group: RegisteredGroup;
  groupJid: string;
  chatJid: string;
  prompt: string;
  requestPolicy: AssistantRequestPolicy;
  routeHint?: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
  existingThreadOverride?: AgentThreadState;
  onOutput?: (output: ContainerOutput) => Promise<void>;
}

export interface RuntimeExecutionPlan {
  existingThread: AgentThreadState | undefined;
  runtimeRoute: RuntimeRoute;
  preferredRuntime: AgentRuntimeName;
  reusedThreadId: string | null;
  sessionId: string | undefined;
}

export interface RuntimeExecutionResult {
  output: ContainerOutput;
  plan: RuntimeExecutionPlan;
}

export interface RuntimeOrchestrationServiceDependencies extends RuntimeExecutionDependencies {
  enqueueJob(groupJid: string, jobId: string, fn: () => Promise<void>): void;
  getRuntimeJobs(): QueueRuntimeJobSnapshot[];
  notifyIdle(groupJid: string): void;
  requestStop(groupJid: string): boolean;
  resolveGroupByFolder(
    folder: string,
  ): { jid: string; group: RegisteredGroup } | null;
}

export interface RuntimeOrchestrationService {
  createJob(request: CreateRuntimeJobRequest): Promise<RuntimeOrchestrationJob>;
  followUp(
    request: FollowUpRuntimeJobRequest,
  ): Promise<RuntimeOrchestrationJob>;
  getJob(jobId: string): RuntimeOrchestrationJob | null;
  listJobs(query?: ListRuntimeJobsRequest): RuntimeOrchestrationJobList;
  getJobLogs(query: GetRuntimeJobLogsRequest): RuntimeJobLogsResult;
  stopJob(request: StopRuntimeJobRequest): Promise<StopRuntimeJobResult>;
}

interface ResolvedGroupTarget {
  jid: string;
  group: RegisteredGroup;
  threadCandidate?: AgentThreadState;
}

interface ResolvedFollowUpTarget extends ResolvedGroupTarget {
  parentJobId: string | null;
  threadCandidate?: AgentThreadState;
}

const DEFAULT_JOB_LIST_LIMIT = 20;
const MAX_JOB_LIST_LIMIT = 100;
const DEFAULT_LOG_LINES = 40;
const MAX_LOG_LINES = 120;
const MAX_PROMPT_PREVIEW = 160;

function nowIso(): string {
  return new Date().toISOString();
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeSource(source: OrchestrationSource): OrchestrationSource {
  const system = source.system.trim();
  if (!system) {
    throw new Error('source.system is required for runtime orchestration.');
  }

  return {
    system,
    actorRef: trimToNull(source.actorRef),
    correlationId: trimToNull(source.correlationId),
    replyRef: trimToNull(source.replyRef),
  };
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error('prompt is required for runtime orchestration.');
  }
  return trimmed;
}

function summarizePrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_PROMPT_PREVIEW) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PROMPT_PREVIEW - 3)}...`;
}

function clampJobListLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(limit ?? DEFAULT_JOB_LIST_LIMIT, 1),
    MAX_JOB_LIST_LIMIT,
  );
}

function clampLogLines(lines: number | undefined): number {
  return Math.min(Math.max(lines ?? DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
}

function buildThreadCandidate(
  groupFolder: string,
  threadId: string,
  runtime: AgentRuntimeName | null | undefined,
  storedThread: AgentThreadState | undefined,
): AgentThreadState | undefined {
  if (runtime) {
    return {
      group_folder: groupFolder,
      runtime,
      thread_id: threadId,
      last_response_id: threadId,
      updated_at: storedThread?.updated_at || '',
    };
  }

  if (storedThread?.thread_id === threadId) {
    return storedThread;
  }

  return undefined;
}

function createOrchestrationJobId(
  kind: RuntimeOrchestrationJob['kind'],
): string {
  return `runtime-job-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function readLogTail(logFile: string, lines: number): string | null {
  if (!fs.existsSync(logFile)) return null;

  const content = fs.readFileSync(logFile, 'utf-8');
  const tail = content.split(/\r?\n/).filter(Boolean).slice(-lines);

  return tail.length > 0 ? tail.join('\n') : null;
}

function planRuntimeExecution(
  deps: RuntimeExecutionDependencies,
  request: Omit<RuntimeExecutionRequest, 'onOutput'>,
): RuntimeExecutionPlan {
  const existingThread =
    request.existingThreadOverride ||
    deps.getStoredThread(request.group.folder);
  const runtimeRoute =
    request.routeHint ||
    classifyRuntimeRoute(request.requestPolicy, request.prompt);
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const reusedThreadId =
    existingThread &&
    shouldReuseExistingThread(existingThread, preferredRuntime)
      ? existingThread.thread_id
      : null;

  return {
    existingThread,
    runtimeRoute,
    preferredRuntime,
    reusedThreadId,
    sessionId: reusedThreadId || deps.getSession(request.group.folder),
  };
}

export async function executeRuntimeTurn(
  deps: RuntimeExecutionDependencies,
  request: RuntimeExecutionRequest,
): Promise<RuntimeExecutionResult> {
  const plan = planRuntimeExecution(deps, request);

  deps.refreshTaskSnapshots();
  deps.writeGroupsSnapshot(
    request.group.folder,
    request.group.isMain === true,
    deps.getAvailableGroups(),
    deps.getRegisteredGroupJids(),
  );

  const wrappedOnOutput = request.onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          deps.persistAgentThread(
            request.group.folder,
            output.newSessionId,
            output.runtime || plan.preferredRuntime,
          );
        }
        await request.onOutput?.(output);
      }
    : undefined;

  const output = await deps.runContainerAgent(
    request.group,
    {
      prompt: request.prompt,
      sessionId: plan.sessionId,
      preferredRuntime: plan.preferredRuntime,
      runtimeRoute: plan.runtimeRoute,
      groupFolder: request.group.folder,
      chatJid: request.chatJid,
      isMain: request.group.isMain === true,
      assistantName: deps.assistantName,
      requestPolicy: request.requestPolicy,
    },
    (proc, containerName) =>
      deps.registerProcess(
        request.groupJid,
        proc,
        containerName,
        request.group.folder,
      ),
    wrappedOnOutput,
  );

  if (output.newSessionId) {
    deps.persistAgentThread(
      request.group.folder,
      output.newSessionId,
      output.runtime || plan.preferredRuntime,
    );
  }

  return { output, plan };
}

function toPublicJob(
  job: RuntimeOrchestrationJobRecord | undefined,
): RuntimeOrchestrationJob | null {
  if (!job) return null;

  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    stopRequested: job.stopRequested,
    groupFolder: job.groupFolder,
    groupJid: job.groupJid,
    parentJobId: job.parentJobId,
    threadId: job.threadId,
    runtimeRoute: job.runtimeRoute,
    requestedRuntime: job.requestedRuntime,
    selectedRuntime: job.selectedRuntime,
    promptPreview: job.promptPreview,
    latestOutputText: job.latestOutputText,
    finalOutputText: job.finalOutputText,
    errorText: job.errorText,
    logFile: job.logFile,
    sourceSystem: job.sourceSystem,
    correlationId: job.correlationId,
    replyRef: job.replyRef,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt,
  };
}

function resolveGroupTarget(
  deps: RuntimeOrchestrationServiceDependencies,
  groupFolder: string,
): ResolvedGroupTarget {
  const target = deps.resolveGroupByFolder(groupFolder);
  if (!target) {
    throw new Error(`No registered group found for folder "${groupFolder}".`);
  }
  return target;
}

function resolveFollowUpTarget(
  deps: RuntimeOrchestrationServiceDependencies,
  request: FollowUpRuntimeJobRequest,
): ResolvedFollowUpTarget {
  if (request.jobId) {
    const sourceJob = getRuntimeOrchestrationJob(request.jobId);
    if (!sourceJob) {
      throw new Error(`No runtime job found for "${request.jobId}".`);
    }

    if (
      request.groupFolder &&
      request.groupFolder.trim() !== sourceJob.groupFolder
    ) {
      throw new Error(
        `Follow-up target mismatch: job "${request.jobId}" belongs to "${sourceJob.groupFolder}", not "${request.groupFolder.trim()}".`,
      );
    }

    if (
      request.threadId &&
      sourceJob.threadId &&
      request.threadId.trim() !== sourceJob.threadId
    ) {
      throw new Error(
        `Follow-up target mismatch: job "${request.jobId}" is linked to thread "${sourceJob.threadId}", not "${request.threadId.trim()}".`,
      );
    }

    const target = resolveGroupTarget(deps, sourceJob.groupFolder);
    const storedThread = deps.getStoredThread(sourceJob.groupFolder);

    return {
      ...target,
      parentJobId: sourceJob.jobId,
      threadCandidate: sourceJob.threadId
        ? buildThreadCandidate(
            sourceJob.groupFolder,
            sourceJob.threadId,
            sourceJob.selectedRuntime,
            storedThread,
          )
        : undefined,
    };
  }

  if (request.threadId) {
    const sourceJob = findLatestRuntimeJobByThread(request.threadId.trim());
    if (!sourceJob) {
      throw new Error(
        `No runtime thread found for "${request.threadId.trim()}".`,
      );
    }

    if (
      request.groupFolder &&
      request.groupFolder.trim() !== sourceJob.groupFolder
    ) {
      throw new Error(
        `Follow-up target mismatch: thread "${request.threadId.trim()}" belongs to "${sourceJob.groupFolder}", not "${request.groupFolder.trim()}".`,
      );
    }

    const target = resolveGroupTarget(deps, sourceJob.groupFolder);
    const storedThread = deps.getStoredThread(sourceJob.groupFolder);

    return {
      ...target,
      parentJobId: sourceJob.jobId,
      threadCandidate: buildThreadCandidate(
        sourceJob.groupFolder,
        request.threadId.trim(),
        sourceJob.selectedRuntime,
        storedThread,
      ),
    };
  }

  if (request.groupFolder) {
    const target = resolveGroupTarget(deps, request.groupFolder.trim());
    return {
      ...target,
      parentJobId: null,
      threadCandidate: deps.getStoredThread(target.group.folder),
    };
  }

  throw new Error(
    'Follow-up requires one of: jobId, threadId, or groupFolder.',
  );
}

function buildQueuedJobRecord(args: {
  jobId: string;
  kind: RuntimeOrchestrationJob['kind'];
  target: ResolvedGroupTarget;
  prompt: string;
  source: OrchestrationSource;
  runtimeRoute: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
  parentJobId?: string | null;
}): RuntimeOrchestrationJobRecord {
  const timestamp = nowIso();

  return {
    jobId: args.jobId,
    kind: args.kind,
    status: 'queued',
    stopRequested: false,
    groupFolder: args.target.group.folder,
    groupJid: args.target.jid,
    parentJobId: args.parentJobId || null,
    threadId: null,
    runtimeRoute: args.runtimeRoute,
    requestedRuntime: args.requestedRuntime || null,
    selectedRuntime: null,
    promptPreview: summarizePrompt(args.prompt),
    latestOutputText: null,
    finalOutputText: null,
    errorText: null,
    logFile: null,
    sourceSystem: args.source.system,
    actorRef: args.source.actorRef,
    correlationId: args.source.correlationId,
    replyRef: args.source.replyRef,
    createdAt: timestamp,
    startedAt: null,
    finishedAt: null,
    updatedAt: timestamp,
  };
}

async function runOrchestrationJob(
  deps: RuntimeOrchestrationServiceDependencies,
  jobId: string,
  groupTargetResolver: () => ResolvedGroupTarget,
  executionContextResolver: () => ResolvedFollowUpTarget | ResolvedGroupTarget,
  prompt: string,
  routeHint: RuntimeRoute | undefined,
): Promise<void> {
  const currentJob = getRuntimeOrchestrationJob(jobId);
  if (!currentJob) return;

  if (currentJob.status === 'failed' || currentJob.status === 'succeeded') {
    return;
  }

  const executionTarget = executionContextResolver();
  const requestPolicy = classifyAssistantRequest([{ content: prompt }]);
  const plan = planRuntimeExecution(deps, {
    group: executionTarget.group,
    groupJid: executionTarget.jid,
    chatJid: executionTarget.jid,
    prompt,
    requestPolicy,
    routeHint,
    existingThreadOverride: executionTarget.threadCandidate,
  });

  const startedAt = nowIso();
  updateRuntimeOrchestrationJob(jobId, {
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    selectedRuntime: plan.preferredRuntime,
    threadId: plan.reusedThreadId,
  });

  let latestOutputText: string | null =
    getRuntimeOrchestrationJob(jobId)?.latestOutputText || null;

  try {
    const result = await executeRuntimeTurn(deps, {
      group: executionTarget.group,
      groupJid: executionTarget.jid,
      chatJid: executionTarget.jid,
      prompt,
      requestPolicy,
      routeHint,
      existingThreadOverride: executionTarget.threadCandidate,
      onOutput: async (output) => {
        if (output.result !== null) {
          latestOutputText = output.result;
        }

        if (output.status === 'success') {
          deps.notifyIdle(executionTarget.jid);
        }

        updateRuntimeOrchestrationJob(jobId, {
          updatedAt: nowIso(),
          latestOutputText,
          selectedRuntime: output.runtime || plan.preferredRuntime,
          threadId: output.newSessionId || plan.reusedThreadId,
          logFile: output.logFile,
          errorText:
            output.status === 'error' ? output.error || null : undefined,
        });
      },
    });

    const finishedAt = nowIso();
    if (result.output.status === 'error') {
      updateRuntimeOrchestrationJob(jobId, {
        status: 'failed',
        updatedAt: finishedAt,
        finishedAt,
        selectedRuntime: result.output.runtime || plan.preferredRuntime,
        threadId: result.output.newSessionId || plan.reusedThreadId,
        latestOutputText,
        errorText: result.output.error || 'Unknown runtime error.',
        logFile: result.output.logFile,
      });
      return;
    }

    const current = getRuntimeOrchestrationJob(jobId);
    const finalOutputText =
      result.output.result ?? current?.latestOutputText ?? latestOutputText;

    updateRuntimeOrchestrationJob(jobId, {
      status: 'succeeded',
      updatedAt: finishedAt,
      finishedAt,
      selectedRuntime: result.output.runtime || plan.preferredRuntime,
      threadId: result.output.newSessionId || plan.reusedThreadId,
      latestOutputText: finalOutputText,
      finalOutputText,
      errorText: null,
      logFile: result.output.logFile,
    });
  } catch (err) {
    const finishedAt = nowIso();
    const errorText = err instanceof Error ? err.message : String(err);

    logger.error({ jobId, err }, 'Runtime orchestration job failed');
    updateRuntimeOrchestrationJob(jobId, {
      status: 'failed',
      updatedAt: finishedAt,
      finishedAt,
      errorText,
    });
  }

  const staleGroupTarget = groupTargetResolver();
  const finalJob = getRuntimeOrchestrationJob(jobId);
  if (!finalJob) return;

  if (finalJob.stopRequested && finalJob.status === 'queued') {
    updateRuntimeOrchestrationJob(jobId, {
      status: 'failed',
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      errorText: 'Stop requested before execution started.',
    });
    return;
  }

  if (finalJob.status === 'queued') {
    updateRuntimeOrchestrationJob(jobId, {
      status: 'failed',
      updatedAt: nowIso(),
      finishedAt: nowIso(),
      errorText: `Runtime orchestration job for ${staleGroupTarget.group.folder} exited without a final status update.`,
    });
  }
}

export function createRuntimeOrchestrationService(
  deps: RuntimeOrchestrationServiceDependencies,
): RuntimeOrchestrationService {
  return {
    async createJob(
      request: CreateRuntimeJobRequest,
    ): Promise<RuntimeOrchestrationJob> {
      const prompt = normalizePrompt(request.prompt);
      const source = normalizeSource(request.source);
      const target = resolveGroupTarget(deps, request.groupFolder.trim());
      const requestPolicy = classifyAssistantRequest([{ content: prompt }]);
      const runtimeRoute =
        request.routeHint || classifyRuntimeRoute(requestPolicy, prompt);
      const jobId = createOrchestrationJobId('create');

      createRuntimeOrchestrationJob(
        buildQueuedJobRecord({
          jobId,
          kind: 'create',
          target,
          prompt,
          source,
          runtimeRoute,
          requestedRuntime: request.requestedRuntime,
        }),
      );

      deps.enqueueJob(target.jid, jobId, async () => {
        const current = getRuntimeOrchestrationJob(jobId);
        if (!current) return;

        if (current.stopRequested && current.status === 'queued') {
          const timestamp = nowIso();
          updateRuntimeOrchestrationJob(jobId, {
            status: 'failed',
            updatedAt: timestamp,
            finishedAt: timestamp,
            errorText: 'Stop requested before execution started.',
          });
          return;
        }

        await runOrchestrationJob(
          deps,
          jobId,
          () => target,
          () => ({
            ...target,
            parentJobId: null,
            threadCandidate: deps.getStoredThread(target.group.folder),
          }),
          prompt,
          request.routeHint,
        );
      });

      return toPublicJob(getRuntimeOrchestrationJob(jobId))!;
    },

    async followUp(
      request: FollowUpRuntimeJobRequest,
    ): Promise<RuntimeOrchestrationJob> {
      const prompt = normalizePrompt(request.prompt);
      const source = normalizeSource(request.source);
      const initialTarget = resolveFollowUpTarget(deps, request);
      const requestPolicy = classifyAssistantRequest([{ content: prompt }]);
      const runtimeRoute = classifyRuntimeRoute(requestPolicy, prompt);
      const jobId = createOrchestrationJobId('follow_up');

      createRuntimeOrchestrationJob(
        buildQueuedJobRecord({
          jobId,
          kind: 'follow_up',
          target: initialTarget,
          prompt,
          source,
          runtimeRoute,
          requestedRuntime: null,
          parentJobId: initialTarget.parentJobId,
        }),
      );

      deps.enqueueJob(initialTarget.jid, jobId, async () => {
        const current = getRuntimeOrchestrationJob(jobId);
        if (!current) return;

        if (current.stopRequested && current.status === 'queued') {
          const timestamp = nowIso();
          updateRuntimeOrchestrationJob(jobId, {
            status: 'failed',
            updatedAt: timestamp,
            finishedAt: timestamp,
            errorText: 'Stop requested before execution started.',
          });
          return;
        }

        await runOrchestrationJob(
          deps,
          jobId,
          () => initialTarget,
          () => resolveFollowUpTarget(deps, request),
          prompt,
          undefined,
        );
      });

      return toPublicJob(getRuntimeOrchestrationJob(jobId))!;
    },

    getJob(jobId: string): RuntimeOrchestrationJob | null {
      return toPublicJob(getRuntimeOrchestrationJob(jobId));
    },

    listJobs(query: ListRuntimeJobsRequest = {}): RuntimeOrchestrationJobList {
      const result = listRuntimeOrchestrationJobs({
        ...query,
        limit: clampJobListLimit(query.limit),
      });

      return {
        jobs: result.jobs.map(
          (job) => toPublicJob(job as RuntimeOrchestrationJobRecord)!,
        ),
        nextBeforeJobId: result.nextBeforeJobId || null,
      };
    },

    getJobLogs(query: GetRuntimeJobLogsRequest): RuntimeJobLogsResult {
      const job = getRuntimeOrchestrationJob(query.jobId);
      if (!job) {
        throw new Error(`No runtime job found for "${query.jobId}".`);
      }

      const lines = clampLogLines(query.lines);
      return {
        jobId: job.jobId,
        logFile: job.logFile || null,
        logText: job.logFile ? readLogTail(job.logFile, lines) : null,
        lines,
      };
    },

    async stopJob(
      request: StopRuntimeJobRequest,
    ): Promise<StopRuntimeJobResult> {
      const job = getRuntimeOrchestrationJob(request.jobId);
      if (!job) {
        throw new Error(`No runtime job found for "${request.jobId}".`);
      }

      const timestamp = nowIso();
      let liveStopAccepted = false;

      if (job.status === 'queued') {
        updateRuntimeOrchestrationJob(job.jobId, {
          stopRequested: true,
          status: 'failed',
          updatedAt: timestamp,
          finishedAt: timestamp,
          errorText: 'Stop requested before execution started.',
        });
      } else if (job.status === 'running') {
        const activeJob = deps
          .getRuntimeJobs()
          .find((runtimeJob) => runtimeJob.runningTaskId === job.jobId);

        liveStopAccepted = activeJob
          ? deps.requestStop(activeJob.groupJid)
          : false;

        updateRuntimeOrchestrationJob(job.jobId, {
          stopRequested: true,
          updatedAt: timestamp,
        });
      }

      const updatedJob = toPublicJob(getRuntimeOrchestrationJob(job.jobId));
      if (!updatedJob) {
        throw new Error(`Runtime job "${job.jobId}" disappeared during stop.`);
      }

      return { job: updatedJob, liveStopAccepted };
    },
  };
}
