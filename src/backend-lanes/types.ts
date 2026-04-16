import type { AgentRuntimeName } from '../types.js';

export type BackendLaneId = 'cursor' | 'andrea_runtime';

export interface BackendJobHandle {
  laneId: BackendLaneId;
  jobId: string;
}

export interface BackendCapabilitySet {
  canCreateJob: boolean;
  canFollowUp: boolean;
  canGetLogs: boolean;
  canStop: boolean;
  canRefresh: boolean;
  canViewOutput: boolean;
  canViewFiles: boolean;
  actionIds: string[];
}

export interface BackendActionDescriptor {
  actionId: string;
  label: string;
  kind?: 'command' | 'url';
  url?: string;
}

export interface BackendFileEntry {
  path: string;
  sizeBytes?: number | null;
  updatedAt?: string | null;
  downloadUrl?: string | null;
}

export interface BackendJobSummary {
  handle: BackendJobHandle;
  title: string;
  status: string;
  summary: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  sourceRepository?: string | null;
  targetUrl?: string | null;
  laneLabel: string;
  capabilities: BackendCapabilitySet;
}

export interface BackendJobDetails extends BackendJobSummary {
  metadata?: Record<string, unknown> | null;
}

export interface BackendCreateJobParams {
  groupFolder: string;
  chatJid: string;
  promptText: string;
  requestedBy?: string;
  requestedRuntime?: AgentRuntimeName | null;
  options?: Record<string, unknown>;
}

export interface BackendFollowUpJobParams {
  handle: BackendJobHandle;
  groupFolder: string;
  chatJid: string;
  promptText: string;
}

export interface BackendGetJobParams {
  handle: BackendJobHandle;
  groupFolder: string;
  chatJid: string;
}

export interface BackendListJobsParams {
  groupFolder?: string;
  chatJid: string;
  limit?: number;
}

export interface BackendGetJobLogsParams {
  handle: BackendJobHandle;
  groupFolder: string;
  chatJid: string;
  limit?: number;
}

export interface BackendPrimaryOutputResult {
  handle: BackendJobHandle;
  text: string | null;
  source: 'final_output' | 'latest_output' | 'logs' | 'conversation' | 'none';
  lineCount: number;
}

export interface BackendJobLogsResult {
  handle: BackendJobHandle;
  logText: string | null;
  lines: number;
  logFile?: string | null;
}

export interface BackendJobFilesResult {
  handle: BackendJobHandle;
  supported: boolean;
  files: BackendFileEntry[];
  note?: string | null;
}

export interface BackendStopJobParams {
  handle: BackendJobHandle;
  groupFolder: string;
  chatJid: string;
}

export interface BackendLane {
  id: BackendLaneId;
  label: string;
  getCapabilities(): BackendCapabilitySet;
  createJob(params: BackendCreateJobParams): Promise<BackendJobDetails>;
  followUp(params: BackendFollowUpJobParams): Promise<BackendJobDetails>;
  getJob(params: BackendGetJobParams): Promise<BackendJobDetails | null>;
  listJobs(params: BackendListJobsParams): Promise<BackendJobSummary[]>;
  refreshJob(params: BackendGetJobParams): Promise<BackendJobDetails | null>;
  getPrimaryOutput(
    params: BackendGetJobLogsParams,
  ): Promise<BackendPrimaryOutputResult>;
  getFiles(params: BackendGetJobParams): Promise<BackendJobFilesResult>;
  getActionDescriptors(job: BackendJobDetails): BackendActionDescriptor[];
  getJobLogs(params: BackendGetJobLogsParams): Promise<BackendJobLogsResult>;
  stopJob(params: BackendStopJobParams): Promise<BackendJobDetails>;
}
