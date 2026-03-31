export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/andrea-openai-bot/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 1800000 (30 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

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

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
