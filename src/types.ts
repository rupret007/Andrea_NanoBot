export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
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
  reply_to?: ReplyMessageRef;
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
  actorType?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
}

export interface RuntimeJobCapabilities {
  followUp: boolean;
  logs: boolean;
  stop: boolean;
}

export interface RuntimeBackendMeta {
  backend: string;
  transport: 'http';
  enabled: true;
  version: string | null;
  ready: boolean;
}

export interface RuntimeBackendJob {
  backend: string;
  jobId: string;
  kind: 'create' | 'follow_up';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
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
  actorType?: string | null;
  actorId?: string | null;
  correlationId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
  capabilities: RuntimeJobCapabilities;
}

export interface RuntimeBackendJobList {
  jobs: RuntimeBackendJob[];
  nextBeforeJobId?: string | null;
}

export interface RuntimeBackendJobLogs {
  jobId: string;
  logFile: string | null;
  logText: string | null;
  lines: number;
}

export interface RuntimeBackendStopResult {
  job: RuntimeBackendJob;
  liveStopAccepted: boolean;
}

export type RuntimeBackendAvailability =
  | 'not_enabled'
  | 'unavailable'
  | 'not_ready'
  | 'available';

export interface RuntimeBackendStatus {
  state: RuntimeBackendAvailability;
  backend: string;
  version: string | null;
  transport: 'http';
  detail: string | null;
  meta: RuntimeBackendMeta | null;
}

export interface RuntimeBackendJobCacheRecord {
  backend_id: string;
  job_id: string;
  group_folder: string;
  chat_jid: string;
  thread_id: string | null;
  status: string;
  selected_runtime: string | null;
  prompt_preview: string;
  latest_output_text: string | null;
  error_text: string | null;
  log_file: string | null;
  created_at: string;
  updated_at: string;
  raw_json: string;
}

export interface RuntimeBackendCardContextRecord {
  backend_id: string;
  chat_jid: string;
  message_id: string;
  job_id: string;
  group_folder: string;
  thread_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface RuntimeBackendChatSelectionRecord {
  backend_id: string;
  chat_jid: string;
  job_id: string;
  group_folder: string;
  updated_at: string;
}

export interface AlexaLinkedAccount {
  accessTokenHash: string;
  displayName: string;
  groupFolder: string;
  allowedAlexaUserId?: string | null;
  allowedAlexaPersonId?: string | null;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
}

export type AlexaPendingSessionKind =
  | 'capture_reminder_lead_time'
  | 'confirm_reminder_before_next_meeting'
  | 'capture_save_for_later_content'
  | 'confirm_save_for_later'
  | 'capture_follow_up_reference';

export interface AlexaPendingSession {
  principalKey: string;
  accessTokenHash: string;
  pendingKind: AlexaPendingSessionKind;
  payloadJson: string;
  expiresAt: string;
  updatedAt: string;
}

export interface AlexaOAuthAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: 'plain' | 'S256' | null;
  groupFolder: string;
  displayName: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
}

export interface AlexaOAuthRefreshTokenRecord {
  refreshTokenHash: string;
  clientId: string;
  scope: string;
  groupFolder: string;
  displayName: string;
  createdAt: string;
  expiresAt: string;
  disabledAt?: string | null;
}

// --- Channel abstraction ---

export interface ReplyMessageRef {
  message_id?: string;
  content?: string;
  sender?: string;
  sender_name?: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  timestamp?: string;
}

export interface ChannelSendReceipt {
  platformMessageIds: string[];
  threadId?: string | null;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string, threadId?: string): Promise<void>;
  sendMessageWithReceipt?(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<ChannelSendReceipt | null>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  chatJid: string,
  message: NewMessage,
) => void | Promise<void>;

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
