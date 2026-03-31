import type { RuntimeOrchestrationService } from '../andrea-runtime/orchestration.js';
import type { RuntimeOrchestrationJob } from '../andrea-runtime/types.js';
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

function toBackendJobSummary(job: RuntimeOrchestrationJob): BackendJobSummary {
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

function toBackendJobDetails(job: RuntimeOrchestrationJob): BackendJobDetails {
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
      replyRef: job.replyRef,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
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

export interface AndreaRuntimeBackendLane extends BackendLane {
  getService(): RuntimeOrchestrationService;
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

export function createAndreaRuntimeBackendLane(
  service: RuntimeOrchestrationService,
): AndreaRuntimeBackendLane {
  return {
    id: 'andrea_runtime',
    label: 'Codex/OpenAI Runtime',
    getService() {
      return service;
    },
    getCapabilities() {
      return ANDREA_RUNTIME_CAPABILITIES;
    },
    async createJob(params: BackendCreateJobParams) {
      const created = await service.createJob({
        groupFolder: params.groupFolder,
        prompt: params.promptText,
        source: {
          system: 'nanoclaw_shell',
          actorRef: params.requestedBy || params.chatJid,
        },
        routeHint:
          typeof params.options?.routeHint === 'string'
            ? (params.options.routeHint as
                | 'local_required'
                | 'cloud_allowed'
                | 'cloud_preferred')
            : undefined,
        requestedRuntime:
          typeof params.options?.requestedRuntime === 'string'
            ? (params.options.requestedRuntime as
                | 'codex_local'
                | 'openai_cloud'
                | 'claude_legacy')
            : undefined,
      });
      return toBackendJobDetails(created);
    },
    async followUp(params: BackendFollowUpJobParams) {
      const followed = await service.followUp({
        jobId: assertRuntimeHandle(params.handle),
        prompt: params.promptText,
        source: {
          system: 'nanoclaw_shell',
          actorRef: params.chatJid,
        },
      });
      return toBackendJobDetails(followed);
    },
    async getJob(params: BackendGetJobParams) {
      const job = service.getJob(assertRuntimeHandle(params.handle));
      return job ? toBackendJobDetails(job) : null;
    },
    async listJobs(params: BackendListJobsParams) {
      return service
        .listJobs({
          groupFolder: params.groupFolder,
          limit: params.limit,
        })
        .jobs.map(toBackendJobSummary);
    },
    async refreshJob(params) {
      const job = service.getJob(assertRuntimeHandle(params.handle));
      return job ? toBackendJobDetails(job) : null;
    },
    async getPrimaryOutput(
      params: BackendGetJobLogsParams,
    ): Promise<BackendPrimaryOutputResult> {
      const job = service.getJob(assertRuntimeHandle(params.handle));
      if (!job) {
        return {
          handle: params.handle,
          text: null,
          source: 'none',
          lineCount: 0,
        };
      }

      if (job.finalOutputText?.trim()) {
        const text = job.finalOutputText.trim();
        return {
          handle: params.handle,
          text,
          source: 'final_output',
          lineCount: text.split(/\r?\n/).length,
        };
      }

      if (job.latestOutputText?.trim()) {
        const text = job.latestOutputText.trim();
        return {
          handle: params.handle,
          text,
          source: 'latest_output',
          lineCount: text.split(/\r?\n/).length,
        };
      }

      const logs = service.getJobLogs({
        jobId: assertRuntimeHandle(params.handle),
        lines: params.limit,
      });
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
      const logs = service.getJobLogs({
        jobId: assertRuntimeHandle(params.handle),
        lines: params.limit,
      });
      return {
        handle: params.handle,
        logText: logs.logText,
        logFile: logs.logFile,
        lines: logs.lines,
      };
    },
    async stopJob(params: BackendStopJobParams) {
      const stopped = await service.stopJob({
        jobId: assertRuntimeHandle(params.handle),
        source: {
          system: 'nanoclaw_shell',
          actorRef: params.chatJid,
        },
      });
      return toBackendJobDetails(stopped.job);
    },
  };
}
