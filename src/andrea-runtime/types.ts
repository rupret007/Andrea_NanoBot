export type AgentRuntimeName = 'codex_local' | 'openai_cloud' | 'claude_legacy';

export type RuntimeRoute =
  | 'local_required'
  | 'cloud_allowed'
  | 'cloud_preferred';

export interface AgentThreadState {
  group_folder: string;
  runtime: AgentRuntimeName;
  thread_id: string;
  last_response_id?: string | null;
  updated_at: string;
}

export interface OrchestrationSource {
  system: string;
  actorRef?: string | null;
  correlationId?: string | null;
  replyRef?: string | null;
}

export interface CreateRuntimeJobRequest {
  groupFolder: string;
  prompt: string;
  source: OrchestrationSource;
  routeHint?: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
}

export interface FollowUpRuntimeJobRequest {
  prompt: string;
  source: OrchestrationSource;
  jobId?: string;
  threadId?: string;
  groupFolder?: string;
}

export interface ListRuntimeJobsRequest {
  groupFolder?: string;
  threadId?: string;
  limit?: number;
  beforeJobId?: string;
}

export interface GetRuntimeJobLogsRequest {
  jobId: string;
  lines?: number;
}

export interface StopRuntimeJobRequest {
  jobId: string;
  source?: OrchestrationSource;
}

export type RuntimeOrchestrationJobKind = 'create' | 'follow_up';

export type RuntimeOrchestrationJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface RuntimeOrchestrationJob {
  jobId: string;
  kind: RuntimeOrchestrationJobKind;
  status: RuntimeOrchestrationJobStatus;
  stopRequested: boolean;
  groupFolder: string;
  groupJid: string;
  parentJobId?: string | null;
  threadId?: string | null;
  runtimeRoute: RuntimeRoute;
  requestedRuntime?: AgentRuntimeName | null;
  selectedRuntime?: AgentRuntimeName | null;
  promptPreview: string;
  latestOutputText?: string | null;
  finalOutputText?: string | null;
  errorText?: string | null;
  logFile?: string | null;
  sourceSystem: string;
  correlationId?: string | null;
  replyRef?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
}

export interface RuntimeOrchestrationJobList {
  jobs: RuntimeOrchestrationJob[];
  nextBeforeJobId?: string | null;
}

export interface RuntimeJobLogsResult {
  jobId: string;
  logFile: string | null;
  logText: string | null;
  lines: number;
}

export interface StopRuntimeJobResult {
  job: RuntimeOrchestrationJob;
  liveStopAccepted: boolean;
}
