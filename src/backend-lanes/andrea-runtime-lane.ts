import {
  AndreaOpenAiBackendClient,
  type AndreaOpenAiBackendClientOptions,
} from '../andrea-openai-backend.js';
import {
  AndreaOpenAiRuntimeError,
  createAndreaOpenAiRuntimeJob,
  followUpAndreaOpenAiRuntimeGroup,
  followUpAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJobLogs,
  listAndreaOpenAiRuntimeJobs,
  stopAndreaOpenAiRuntimeJob,
} from '../andrea-openai-runtime.js';
import type { RegisteredGroup, RuntimeBackendJob } from '../types.js';
import type {
  BackendActionDescriptor,
  BackendCapabilitySet,
  BackendCreateJobParams,
  BackendFollowUpJobParams,
  BackendGetJobLogsParams,
  BackendGetJobParams,
  BackendJobDetails,
  BackendJobFilesResult,
  BackendJobLogsResult,
  BackendPrimaryOutputResult,
  BackendJobSummary,
  BackendLane,
  BackendListJobsParams,
  BackendStopJobParams,
} from './types.js';

const ANDREA_RUNTIME_CAPABILITIES: BackendCapabilitySet = {
  canCreateJob: true,
  canFollowUp: true,
  canGetLogs: true,
  canStop: true,
  canRefresh: true,
  canViewOutput: true,
  canViewFiles: false,
  actionIds: ['job.refresh', 'job.output', 'job.followup', 'job.stop'],
};

function toBackendJobSummary(job: RuntimeBackendJob): BackendJobSummary {
  return {
    handle: { laneId: 'andrea_runtime', jobId: job.jobId },
    title: 'Codex/OpenAI task',
    status: job.status,
    summary: job.promptPreview,
    updatedAt: job.updatedAt,
    createdAt: job.createdAt,
    sourceRepository: null,
    targetUrl: null,
    laneLabel: 'Codex/OpenAI Runtime',
    capabilities: ANDREA_RUNTIME_CAPABILITIES,
  };
}

function toBackendJobDetails(job: RuntimeBackendJob): BackendJobDetails {
  return {
    ...toBackendJobSummary(job),
    metadata: {
      kind: job.kind,
      stopRequested: job.stopRequested,
      groupFolder: job.groupFolder,
      groupJid: job.groupJid,
      parentJobId: job.parentJobId,
      threadId: job.threadId,
      runtimeRoute: job.runtimeRoute,
      requestedRuntime: job.requestedRuntime,
      selectedRuntime: job.selectedRuntime,
      latestOutputText: job.latestOutputText,
      finalOutputText: job.finalOutputText,
      errorText: job.errorText,
      logFile: job.logFile,
      sourceSystem: job.sourceSystem,
      correlationId: job.correlationId,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt,
    },
  };
}

function assertRuntimeHandle(handle: {
  laneId: string;
  jobId: string;
}): string {
  if (handle.laneId !== 'andrea_runtime') {
    throw new Error(
      `Andrea runtime lane cannot handle ${handle.laneId} job ${handle.jobId}.`,
    );
  }
  return handle.jobId;
}

function buildRuntimeActionDescriptors(
  job: BackendJobDetails,
): BackendActionDescriptor[] {
  const actions: BackendActionDescriptor[] = [
    { actionId: 'job.refresh', label: 'Refresh' },
    { actionId: 'job.output', label: 'View Output' },
    { actionId: 'job.followup', label: 'Continue' },
  ];

  if (job.status === 'queued' || job.status === 'running') {
    actions.push({ actionId: 'job.stop', label: 'Stop Run' });
  }

  return actions;
}

function summarizeRuntimeOutput(job: RuntimeBackendJob): string | null {
  const text =
    job.finalOutputText?.trim() ||
    job.latestOutputText?.trim() ||
    job.errorText?.trim() ||
    null;
  return text || null;
}

function resolveGroupContext(
  resolveGroupByFolder: (folder: string) => { jid: string; group: RegisteredGroup } | null,
  groupFolder: string,
): { jid: string; group: RegisteredGroup } {
  const resolved = resolveGroupByFolder(groupFolder);
  if (!resolved) {
    throw new Error(`No registered group found for folder "${groupFolder}".`);
  }
  return resolved;
}

export interface AndreaRuntimeBackendLane extends BackendLane {}

export interface AndreaRuntimeBackendLaneOptions {
  resolveGroupByFolder(
    folder: string,
  ): { jid: string; group: RegisteredGroup } | null;
  client?: AndreaOpenAiBackendClient;
  clientOptions?: AndreaOpenAiBackendClientOptions;
}

export function createAndreaRuntimeBackendLane(
  options: AndreaRuntimeBackendLaneOptions,
): AndreaRuntimeBackendLane {
  const client =
    options.client || new AndreaOpenAiBackendClient(options.clientOptions);

  return {
    id: 'andrea_runtime',
    label: 'Codex/OpenAI Runtime',
    getCapabilities() {
      return ANDREA_RUNTIME_CAPABILITIES;
    },
    async createJob(params: BackendCreateJobParams) {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      const created = await createAndreaOpenAiRuntimeJob(
        {
          chatJid: params.chatJid,
          group,
          prompt: params.promptText,
          actorId: params.requestedBy || params.chatJid,
        },
        client,
      );
      return toBackendJobDetails(created);
    },
    async followUp(params: BackendFollowUpJobParams) {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      const followed = await followUpAndreaOpenAiRuntimeJob(
        {
          chatJid: params.chatJid,
          group,
          jobId: assertRuntimeHandle(params.handle),
          prompt: params.promptText,
          actorId: params.chatJid,
        },
        client,
      );
      return toBackendJobDetails(followed);
    },
    async getJob(params: BackendGetJobParams) {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      try {
        const job = await getAndreaOpenAiRuntimeJob(
          {
            chatJid: params.chatJid,
            group,
            jobId: assertRuntimeHandle(params.handle),
          },
          client,
        );
        return toBackendJobDetails(job);
      } catch (err) {
        if (
          err instanceof AndreaOpenAiRuntimeError &&
          err.kind === 'not_found'
        ) {
          return null;
        }
        throw err;
      }
    },
    async listJobs(params: BackendListJobsParams) {
      const groupFolder = params.groupFolder;
      if (!groupFolder) {
        throw new Error('Codex/OpenAI runtime requires a workspace selection.');
      }
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        groupFolder,
      );
      const result = await listAndreaOpenAiRuntimeJobs(
        {
          chatJid: params.chatJid,
          group,
          limit: params.limit,
        },
        client,
      );
      return result.jobs.map(toBackendJobSummary);
    },
    async refreshJob(params) {
      return this.getJob(params);
    },
    async getPrimaryOutput(
      params: BackendGetJobLogsParams,
    ): Promise<BackendPrimaryOutputResult> {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      const job = await getAndreaOpenAiRuntimeJob(
        {
          chatJid: params.chatJid,
          group,
          jobId: assertRuntimeHandle(params.handle),
        },
        client,
      );

      const primaryText = summarizeRuntimeOutput(job);
      if (primaryText) {
        return {
          handle: params.handle,
          text: primaryText,
          source: job.finalOutputText?.trim()
            ? 'final_output'
            : job.latestOutputText?.trim()
              ? 'latest_output'
              : 'none',
          lineCount: primaryText.split(/\r?\n/).length,
        };
      }

      const logs = await getAndreaOpenAiRuntimeJobLogs(
        {
          chatJid: params.chatJid,
          group,
          jobId: assertRuntimeHandle(params.handle),
          lines: params.limit,
        },
        client,
      );
      return {
        handle: params.handle,
        text: logs.logText,
        source: logs.logText ? 'logs' : 'none',
        lineCount: logs.lines,
      };
    },
    async getFiles(params): Promise<BackendJobFilesResult> {
      return {
        handle: params.handle,
        supported: false,
        files: [],
        note: 'Codex/OpenAI tasks do not expose shell results yet.',
      };
    },
    getActionDescriptors(job) {
      return buildRuntimeActionDescriptors(job);
    },
    async getJobLogs(
      params: BackendGetJobLogsParams,
    ): Promise<BackendJobLogsResult> {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      const logs = await getAndreaOpenAiRuntimeJobLogs(
        {
          chatJid: params.chatJid,
          group,
          jobId: assertRuntimeHandle(params.handle),
          lines: params.limit,
        },
        client,
      );
      return {
        handle: params.handle,
        logText: logs.logText,
        logFile: logs.logFile,
        lines: logs.lines,
      };
    },
    async stopJob(params: BackendStopJobParams) {
      const { group } = resolveGroupContext(
        options.resolveGroupByFolder,
        params.groupFolder,
      );
      const stopped = await stopAndreaOpenAiRuntimeJob(
        {
          chatJid: params.chatJid,
          group,
          jobId: assertRuntimeHandle(params.handle),
          actorId: params.chatJid,
        },
        client,
      );
      return toBackendJobDetails(stopped.job);
    },
  };
}

export async function followUpAndreaRuntimeLaneGroup(params: {
  resolveGroupByFolder(
    folder: string,
  ): { jid: string; group: RegisteredGroup } | null;
  groupFolder: string;
  chatJid: string;
  promptText: string;
  actorId?: string | null;
  client?: AndreaOpenAiBackendClient;
}): Promise<BackendJobDetails> {
  const resolved = resolveGroupContext(
    params.resolveGroupByFolder,
    params.groupFolder,
  );
  const followed = await followUpAndreaOpenAiRuntimeGroup(
    {
      chatJid: params.chatJid,
      group: resolved.group,
      prompt: params.promptText,
      actorId: params.actorId || params.chatJid,
    },
    params.client,
  );
  return toBackendJobDetails(followed);
}
