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
  reply_to_id?: string;
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

export type AgentRuntimeName =
  | 'codex_local'
  | 'openai_cloud'
  | 'minimax_cloud'
  | 'claude_legacy';

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

export type RuntimeBackendAuthState =
  | 'authenticated'
  | 'auth_required'
  | 'unknown';

export type RuntimeBackendLocalExecutionState =
  | 'available_authenticated'
  | 'available_auth_required'
  | 'not_ready'
  | 'unavailable';

export interface RuntimeBackendMeta {
  backend: string;
  transport: 'http';
  enabled: true;
  version: string | null;
  ready: boolean;
  localExecutionState: RuntimeBackendLocalExecutionState;
  authState: RuntimeBackendAuthState;
  localExecutionDetail: string | null;
  operatorGuidance: string | null;
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
  | 'auth_required'
  | 'available';

export interface RuntimeBackendStatus {
  state: RuntimeBackendAvailability;
  backend: string;
  version: string | null;
  transport: 'http';
  detail: string | null;
  meta: RuntimeBackendMeta | null;
}

export type CompanionRouteKind =
  | 'assistant_capability'
  | 'direct_quick_reply'
  | 'protected_assistant'
  | 'clarify'
  | 'unsupported';

export type CompanionRouteConfidence = 'high' | 'medium' | 'low';
export type OpenAiModelTier = 'simple' | 'standard' | 'complex';
export type OpenAiProviderMode = 'direct_openai' | 'compatible_gateway';

export type CompanionRouteTimeWindowKind =
  | 'default_24h'
  | 'last_hours'
  | 'last_days'
  | 'today'
  | 'yesterday'
  | 'this_week';

export interface CompanionRouteArguments {
  targetChatName?: string | null;
  targetChatJid?: string | null;
  personName?: string | null;
  threadTitle?: string | null;
  timeWindowKind?: CompanionRouteTimeWindowKind | null;
  timeWindowValue?: number | null;
  savedMaterialOnly?: boolean | null;
  replyStyle?: 'shorter' | 'warmer' | 'more_direct' | null;
}

export interface CompanionRouteDecision {
  routeKind: CompanionRouteKind;
  capabilityId?: string | null;
  canonicalText: string;
  arguments?: CompanionRouteArguments | null;
  confidence: CompanionRouteConfidence;
  clarificationPrompt?: string | null;
  reason?: string | null;
  selectedModelTier?: OpenAiModelTier | null;
  selectedModel?: string | null;
  providerMode?: OpenAiProviderMode | null;
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
  | 'capture_follow_up_reference'
  | 'confirm_profile_fact'
  | 'confirm_companion_completion';

export interface AlexaPendingSession {
  principalKey: string;
  accessTokenHash: string;
  pendingKind: AlexaPendingSessionKind;
  payloadJson: string;
  expiresAt: string;
  updatedAt: string;
}

export type AlexaConversationSubjectKind =
  | 'day_brief'
  | 'meeting'
  | 'event'
  | 'person'
  | 'household'
  | 'life_thread'
  | 'communication_thread'
  | 'mission'
  | 'saved_item'
  | 'draft'
  | 'memory_fact'
  | 'general';

export type AlexaCompanionGuidanceGoal =
  | 'daily_brief'
  | 'upcoming_soon'
  | 'next_action'
  | 'meeting_prep'
  | 'tomorrow_brief'
  | 'what_matters_most'
  | 'anything_important'
  | 'what_am_i_forgetting'
  | 'evening_reset'
  | 'family_guidance'
  | 'shared_plans'
  | 'life_thread_guidance'
  | 'open_conversation'
  | 'action_follow_through'
  | 'risk_check'
  | 'explainability';

export type AlexaConversationFollowupAction =
  | 'anything_else'
  | 'shorter'
  | 'say_more'
  | 'before_that'
  | 'after_that'
  | 'switch_person'
  | 'remind_before_that'
  | 'save_that'
  | 'draft_followup'
  | 'action_guidance'
  | 'risk_check'
  | 'memory_control'
  | 'send_details'
  | 'save_to_library'
  | 'track_thread'
  | 'create_reminder'
  | 'save_for_later'
  | 'draft_follow_up'
  | 'approve_bundle'
  | 'show_bundle'
  | 'delegation_control'
  | 'show_rules';

export type CompanionToneProfile = 'plain' | 'balanced' | 'warmer';

export interface PersonalityTexturePolicy {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  toneProfile: CompanionToneProfile;
  allowWarmth: boolean;
  allowHumor: boolean;
  allowTexture: boolean;
  maxTextureLines: number;
}

export interface PersonalityCooldownState {
  lastTextureKind?: 'transition' | 'closer' | 'pulse' | null;
  lastTexturedAt?: string | null;
  cooldownTurnsRemaining?: number;
}

export type PulseMode = 'off' | 'request_only';

export interface PulsePreference {
  mode: PulseMode;
  scheduledDeliveryEnabled: boolean;
  updatedAt?: string | null;
}

export type BlueBubblesChatScope = 'all_synced' | 'contacts_only' | 'allowlist';

export type AppleMessagesProviderName = 'bluebubbles' | 'openbubbles' | 'none';

export type AppleMessagesBridgeAvailability = 'available' | 'unavailable';

export type BlueBubblesReplyGateMode = 'mention_required' | 'direct_1to1';

export type MessagesDirectRouteFamily =
  | 'chat'
  | 'communication_reply'
  | 'message_action_followup'
  | 'capture'
  | 'calendar'
  | 'reminder'
  | 'household_view'
  | 'help';

export interface MessagesDirectTurnEnvelope {
  normalizedUserIntent: string;
  routeFamily: MessagesDirectRouteFamily;
  assistantPrompt: string;
  draftGoal?: string | null;
  toneHints?: string[];
  confidence: number;
  clarificationQuestion?: string | null;
  fallbackText?: string | null;
  replyText?: string | null;
  source?: 'openai' | 'fallback';
}

export interface BlueBubblesConfig {
  enabled: boolean;
  baseUrl: string | null;
  baseUrlCandidates: string[];
  password: string | null;
  host: string;
  port: number;
  groupFolder: string;
  webhookPublicBaseUrl: string | null;
  serverPublicUrl: string | null;
  localPort: string | null;
  imessageAccountLabel: string | null;
  computerId: string | null;
  chatScope: BlueBubblesChatScope;
  allowedChatGuids: string[];
  allowedChatGuid: string | null;
  webhookPath: string;
  webhookSecret: string | null;
  sendEnabled: boolean;
}

export interface BlueBubblesWebhookEvent {
  type: string;
  messageGuid?: string | null;
  chatGuid?: string | null;
  data?: Record<string, unknown> | null;
}

export interface BlueBubblesChatRef {
  chatGuid: string;
  displayName?: string | null;
  isGroup?: boolean;
  participants?: string[];
  chatIdentifier?: string | null;
  lastAddressedHandle?: string | null;
  service?: string | null;
}

export interface BlueBubblesContactRef {
  handle: string;
  displayName?: string | null;
  address?: string | null;
  service?: string | null;
}

export type BlueBubblesProofState =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'degraded_but_usable'
  | 'not_intended_for_trial';

export type BlueBubblesBlockerOwner = 'none' | 'repo_side' | 'external';

export interface BlueBubblesControlApiConfig {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  baseUrl: string | null;
}

export interface BlueBubblesControlMcpConfig {
  baseUrl: string;
  token: string;
}

export interface BlueBubblesChannelControlSnapshot {
  connected: boolean;
  enabled: boolean;
  groupFolder: string;
  chatScope: string;
  sendEnabled: boolean;
  listenerHost: string;
  listenerPort: number;
  configuredBaseUrl: string | null;
  activeBaseUrl: string | null;
  candidateBaseUrls: string[];
  publicWebhookUrl: string;
  serverPublicUrl: string | null;
  localPort: string | null;
  imessageAccountLabel: string | null;
  computerId: string | null;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  transportState: string;
  transportDetail: string;
  shadowPollLastOkAt: string;
  shadowPollLastError: string;
  shadowPollMostRecentChat: string;
  configuredReplyGateMode: BlueBubblesReplyGateMode;
  effectiveReplyGateMode: BlueBubblesReplyGateMode;
  lastInboundObservedAt: string;
  lastInboundChatJid: string;
  lastInboundWasSelfAuthored: boolean | null;
  lastOutboundResult: string;
  lastOutboundTargetKind: string;
  lastOutboundTarget: string;
  lastSendErrorDetail: string;
  detectionState: string;
  detectionDetail: string;
  detectionNextAction: string;
}

export interface BlueBubblesControlStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  groupFolder: string;
  chatScope: string;
  sendEnabled: boolean;
  listenerHost: string;
  listenerPort: number;
  configuredBaseUrl: string | null;
  activeBaseUrl: string | null;
  candidateBaseUrls: string[];
  publicWebhookUrl: string;
  serverPublicUrl: string | null;
  localPort: string | null;
  imessageAccountLabel: string | null;
  computerId: string | null;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  transportState: string;
  transportDetail: string;
  shadowPollLastOkAt: string;
  shadowPollLastError: string;
  shadowPollMostRecentChat: string;
  configuredReplyGateMode: BlueBubblesReplyGateMode;
  effectiveReplyGateMode: BlueBubblesReplyGateMode;
  proofState: BlueBubblesProofState;
  blocker: string;
  blockerOwner: BlueBubblesBlockerOwner;
  nextAction: string;
  detectionState: string;
  detectionDetail: string;
  detectionNextAction: string;
  mostRecentEngagedChatJid: string;
  mostRecentEngagedAt: string;
  lastInboundAt: string;
  lastInboundChatJid: string;
  lastInboundWasSelfAuthored: boolean;
  lastOutboundResult: string;
  lastOutboundTargetKind: string;
  lastOutboundTarget: string;
  lastSendErrorDetail: string;
  recentTargetChatJid: string;
  recentTargetAt: string;
  openMessageActionCount: number;
  continuityState: BlueBubblesContinuityState;
  proofCandidateChatJid: string;
  activeMessageActionId: string;
  conversationKind: BlueBubblesConversationKind;
  decisionPolicy: BlueBubblesDecisionPolicy;
  conversationalEligibility: BlueBubblesConversationalEligibility;
  requiresExplicitMention: boolean;
  activePresentationAt: string | null;
  eligibleFollowups: string[];
  canonicalSelfThreadChatJid: string;
  sourceSelfThreadChatJid: string;
  messageActionProofState: 'none' | 'fresh' | 'stale';
  messageActionProofChatJid: string;
  messageActionProofAt: string;
  proofDrillState: BlueBubblesProofDrillState;
  proofDrillActionId: string;
  proofDrillStartedAt: string;
  proofDrillNextStep: string;
}

export interface BlueBubblesProofReport {
  proofState: BlueBubblesProofState;
  blocker: string;
  blockerOwner: BlueBubblesBlockerOwner;
  nextAction: string;
  detail: string;
  configuredReplyGateMode: BlueBubblesReplyGateMode;
  effectiveReplyGateMode: BlueBubblesReplyGateMode;
  messageActionProofState: 'none' | 'fresh' | 'stale';
  messageActionProofChatJid: string;
  messageActionProofAt: string;
  messageActionProofDetail: string;
  detectionState: string;
  detectionDetail: string;
  detectionNextAction: string;
  transportState: string;
  transportDetail: string;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  recentTargetChatJid: string;
  recentTargetAt: string;
  openMessageActionCount: number;
  continuityState: BlueBubblesContinuityState;
  proofCandidateChatJid: string;
  activeMessageActionId: string;
  conversationKind: BlueBubblesConversationKind;
  decisionPolicy: BlueBubblesDecisionPolicy;
  conversationalEligibility: BlueBubblesConversationalEligibility;
  requiresExplicitMention: boolean;
  activePresentationAt: string | null;
  eligibleFollowups: string[];
  canonicalSelfThreadChatJid: string;
  sourceSelfThreadChatJid: string;
  proofDrillState: BlueBubblesProofDrillState;
  proofDrillActionId: string;
  proofDrillStartedAt: string;
  proofDrillNextStep: string;
}

export interface BlueBubblesChatSummary {
  chatJid: string;
  name: string | null;
  isGroup: boolean;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  effectiveReplyGateMode: BlueBubblesReplyGateMode;
}

export interface BlueBubblesMessageView {
  messageId: string;
  chatJid: string;
  timestamp: string;
  isBotMessage: boolean;
  isFromMe: boolean;
  preview: string;
  replyToMessageId?: string;
}

export type BlueBubblesMessageActionOperationKind =
  | 'send'
  | 'defer'
  | 'remind_instead'
  | 'save_to_thread';

export interface BlueBubblesOpenMessageAction {
  actionId: string;
  chatJid: string;
  status: MessageActionSendStatus;
  draftPreview: string;
  allowedOperations: BlueBubblesMessageActionOperationKind[];
  createdAt: string;
  scheduledFor: string | null;
  isActive: boolean;
  conversationKind: BlueBubblesConversationKind;
  decisionPolicy: BlueBubblesDecisionPolicy;
  conversationalEligibility: BlueBubblesConversationalEligibility;
  requiresExplicitMention: boolean;
  activePresentationAt: string | null;
  eligibleFollowups: string[];
  isProofDrill: boolean;
  proofDrillState: BlueBubblesProofDrillState;
  proofDrillStartedAt: string;
  proofDrillNextStep: string;
}

export type BlueBubblesProofDrillState =
  | 'idle'
  | 'active'
  | 'deferred'
  | 'stale';

export type BlueBubblesContinuityState =
  | 'idle'
  | 'draft_open'
  | 'awaiting_decision'
  | 'proof_gap';

export type BlueBubblesConversationKind =
  | 'self_thread'
  | 'direct_1to1'
  | 'group';

export type BlueBubblesDecisionPolicy =
  | 'semi_auto_self_thread'
  | 'semi_auto_recent_direct_1to1'
  | 'explicit_only';

export type BlueBubblesConversationalEligibility =
  | 'conversational_now'
  | 'explicit_only';

export interface BlueBubblesExecuteMessageActionRequest {
  operation: BlueBubblesMessageActionOperationKind;
  timingHint?: string | null;
}

export type KnowledgeSourceType =
  | 'uploaded_document'
  | 'generated_note'
  | 'saved_research_result'
  | 'imported_summary'
  | 'manual_reference';

export type KnowledgeScope = 'personal' | 'household' | 'work' | 'mixed';

export type KnowledgeSensitivity = 'normal' | 'private' | 'sensitive';

export type KnowledgeIngestionState =
  | 'pending'
  | 'ready'
  | 'failed'
  | 'deleted';

export type KnowledgeIndexState =
  | 'pending'
  | 'indexed'
  | 'stale'
  | 'disabled'
  | 'failed';

export type RitualType =
  | 'morning_brief'
  | 'midday_reground'
  | 'evening_reset'
  | 'open_guidance'
  | 'thread_followthrough'
  | 'household_checkin'
  | 'transition_prompt';

export type RitualTriggerStyle =
  | 'on_request'
  | 'scheduled'
  | 'context_triggered'
  | 'suggested';

export type RitualScope = 'personal' | 'household' | 'work' | 'mixed';

export type RitualSourceInput =
  | 'calendar'
  | 'reminders'
  | 'life_threads'
  | 'knowledge_library'
  | 'profile_facts'
  | 'current_work';

export type RitualToneStyle = 'brief' | 'balanced' | 'supportive';

export type RitualOptInState = 'not_set' | 'opted_in' | 'opted_out';

export interface RitualTiming {
  localTime?: string | null;
  weekdaysOnly?: boolean;
  anchor?:
    | 'morning'
    | 'midday'
    | 'evening'
    | 'before_leave'
    | 'tonight'
    | 'tomorrow'
    | null;
}

export interface RitualProfile {
  id: string;
  groupFolder: string;
  ritualType: RitualType;
  enabled: boolean;
  triggerStyle: RitualTriggerStyle;
  scope: RitualScope;
  timing: RitualTiming;
  toneStyle: RitualToneStyle;
  sourceInputs: RitualSourceInput[];
  lastRunAt?: string | null;
  nextDueAt?: string | null;
  optInState: RitualOptInState;
  linkedTaskId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CommunicationFollowupState =
  | 'unknown'
  | 'reply_needed'
  | 'waiting_on_them'
  | 'scheduled'
  | 'resolved'
  | 'ignored';

export type CommunicationSuggestedAction =
  | 'reply_now'
  | 'draft_reply'
  | 'save_for_later'
  | 'create_reminder'
  | 'link_thread'
  | 'ignore';

export type CommunicationUrgency =
  | 'none'
  | 'soon'
  | 'tonight'
  | 'tomorrow'
  | 'overdue';

export type CommunicationInferenceState =
  | 'user_confirmed'
  | 'assistant_inferred'
  | 'mixed';

export type CommunicationTrackingMode = 'default' | 'manual_only' | 'disabled';

export type ChiefOfStaffScope =
  | 'personal'
  | 'household'
  | 'family'
  | 'work'
  | 'mixed';

export type ChiefOfStaffHorizon =
  | 'today'
  | 'tonight'
  | 'tomorrow'
  | 'this_week'
  | 'weekend'
  | 'next_few_days';

export type ChiefOfStaffSignalKind =
  | 'commitment'
  | 'waiting_on'
  | 'open_loop'
  | 'deadline'
  | 'pressure_point'
  | 'slip_risk'
  | 'prep_needed'
  | 'opportunity'
  | 'focus_candidate';

export type ChiefOfStaffRecommendedAction =
  | 'do_now'
  | 'prepare'
  | 'follow_up'
  | 'remind'
  | 'delay'
  | 'delegate'
  | 'pause'
  | 'drop'
  | 'watch';

export type ChiefOfStaffConfidence = 'low' | 'medium' | 'high';

export type ChiefOfStaffSignalStrength = 'low' | 'medium' | 'high';

export interface ChiefOfStaffSignal {
  kind: ChiefOfStaffSignalKind;
  title: string;
  summaryText: string;
  scope: ChiefOfStaffScope;
  urgency: ChiefOfStaffSignalStrength;
  importance: ChiefOfStaffSignalStrength;
  recommendedAction: ChiefOfStaffRecommendedAction;
  reasons: string[];
  dueLabel?: string | null;
  relatedThreadId?: string | null;
  relatedCommunicationThreadId?: string | null;
}

export interface ChiefOfStaffSnapshot {
  horizon: ChiefOfStaffHorizon;
  scope: ChiefOfStaffScope;
  summaryText: string;
  mainSignal?: ChiefOfStaffSignal | null;
  supportingSignals: ChiefOfStaffSignal[];
  bestNextAction?: string | null;
  prepChecklist: string[];
  pressurePoints: string[];
  opportunities: string[];
  confidence: ChiefOfStaffConfidence;
  explainabilityLines: string[];
  signalsUsed: string[];
  omittedSignals: string[];
}

export interface ChiefOfStaffPreferences {
  familyAggressiveness: 'normal' | 'lighter';
  workSuggestionsEnabled: boolean;
  toneStyle: 'balanced' | 'direct' | 'calm';
  mainThingFirst: boolean;
}

export interface ChiefOfStaffContext {
  version: 1;
  mode:
    | 'prioritize'
    | 'plan_horizon'
    | 'prepare'
    | 'decision_support'
    | 'explain'
    | 'configure';
  snapshot: ChiefOfStaffSnapshot;
  preferences: ChiefOfStaffPreferences;
  sessionOverrides?: {
    suppressWorkSuggestions?: boolean;
  };
  focusTopic?: string | null;
  generatedAt: string;
}

export type MissionCategory =
  | 'household'
  | 'family'
  | 'work'
  | 'event_prep'
  | 'communication'
  | 'mixed';

export type MissionStatus =
  | 'proposed'
  | 'active'
  | 'blocked'
  | 'paused'
  | 'completed'
  | 'archived';

export type MissionStepStatus = 'pending' | 'blocked' | 'waiting' | 'done';

export type MissionSuggestedActionKind =
  | 'create_reminder'
  | 'draft_follow_up'
  | 'save_to_library'
  | 'link_thread'
  | 'track_follow_up'
  | 'pin_to_ritual'
  | 'start_research'
  | 'reference_current_work';

export type ActionBundleOriginKind =
  | 'mission'
  | 'communication'
  | 'chief_of_staff'
  | 'daily_guidance'
  | 'research'
  | 'handoff';

export type ActionBundlePresentationChannel =
  | 'telegram'
  | 'alexa'
  | 'bluebubbles';

export type ActionBundleStatus =
  | 'open'
  | 'partially_done'
  | 'done'
  | 'dismissed'
  | 'expired';

export type ActionBundlePresentationMode = 'default' | 'selection';

export type ActionBundleActionType =
  | 'create_reminder'
  | 'draft_follow_up'
  | 'send_message'
  | 'save_to_thread'
  | 'save_to_library'
  | 'pin_to_ritual'
  | 'send_to_telegram'
  | 'reference_current_work';

export type ActionBundleTargetSystem =
  | 'reminders'
  | 'communication'
  | 'message_actions'
  | 'life_threads'
  | 'knowledge_library'
  | 'rituals'
  | 'cross_channel_handoffs'
  | 'missions'
  | 'current_work';

export type ActionBundleActionStatus =
  | 'proposed'
  | 'approved'
  | 'executed'
  | 'skipped'
  | 'failed'
  | 'deferred';

export interface ActionBundleRelatedRefs {
  missionId?: string;
  threadId?: string;
  communicationThreadId?: string;
  knowledgeSourceIds?: string[];
  currentWorkRef?: string;
  handoffId?: string;
}

export interface ActionBundleSourceContext {
  whyLine?: string;
  summaryText?: string;
  utterance?: string;
  personName?: string;
  titleHint?: string;
}

export interface ActionBundleRecord {
  bundleId: string;
  groupFolder: string;
  title: string;
  originKind: ActionBundleOriginKind;
  originCapability?: string | null;
  sourceContextKey?: string | null;
  sourceContextJson: string;
  presentationChannel: ActionBundlePresentationChannel;
  presentationChatJid?: string | null;
  presentationThreadId?: string | null;
  presentationMessageId?: string | null;
  presentationMode?: ActionBundlePresentationMode | null;
  bundleStatus: ActionBundleStatus;
  userConfirmed: boolean;
  createdAt: string;
  expiresAt: string;
  lastUpdatedAt: string;
  relatedRefsJson?: string | null;
}

export interface ActionBundleActionRecord {
  actionId: string;
  bundleId: string;
  orderIndex: number;
  actionType: ActionBundleActionType;
  targetSystem: ActionBundleTargetSystem;
  summary: string;
  requiresConfirmation: boolean;
  status: ActionBundleActionStatus;
  delegationRuleId?: string | null;
  delegationMode?: DelegationApprovalMode | null;
  delegationExplanation?: string | null;
  failureReason?: string | null;
  payloadJson: string;
  resultRefJson?: string | null;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface ActionBundleSnapshot {
  bundle: ActionBundleRecord;
  actions: ActionBundleActionRecord[];
}

export type DelegationTriggerType =
  | 'prompt_pattern'
  | 'capability_result'
  | 'bundle_type'
  | 'mission_category'
  | 'thread_category'
  | 'ritual_context'
  | 'communication_context'
  | 'review_context';

export type DelegationTriggerScope =
  | 'personal'
  | 'household'
  | 'family'
  | 'work'
  | 'mixed';

export type DelegationApprovalMode =
  | 'always_ask'
  | 'ask_once_then_remember'
  | 'auto_apply_when_safe'
  | 'suggest_only';

export type DelegationRuleStatus = 'active' | 'paused' | 'disabled';

export type DelegationSafetyLevel =
  | 'safe_to_auto_after_delegation'
  | 'safe_to_suggest_only'
  | 'always_requires_fresh_approval'
  | 'never_automate';

export type DelegationPromptPattern =
  | 'save_that'
  | 'save_for_later'
  | 'send_full_version'
  | 'reply_followthrough'
  | 'general_default';

export interface DelegationRuleConditions {
  promptPattern?: DelegationPromptPattern;
  actionType?: ActionBundleActionType | null;
  originKind?: ActionBundleOriginKind | null;
  missionCategory?: MissionCategory | null;
  personName?: string | null;
  threadTitle?: string | null;
  ritualType?: RitualType | null;
  reviewHorizon?: OutcomeReviewHorizon | null;
  communicationContext?:
    | 'reply_followthrough'
    | 'household_followthrough'
    | 'general'
    | null;
}

export interface DelegationRuleAction {
  actionType: ActionBundleActionType;
  timingHint?: string | null;
  threadTitle?: string | null;
  note?: string | null;
}

export interface DelegationRuleRecord {
  ruleId: string;
  groupFolder: string;
  title: string;
  triggerType: DelegationTriggerType;
  triggerScope: DelegationTriggerScope;
  conditionsJson: string;
  delegatedActionsJson: string;
  approvalMode: DelegationApprovalMode;
  status: DelegationRuleStatus;
  createdAt: string;
  lastUsedAt?: string | null;
  timesUsed: number;
  timesAutoApplied: number;
  timesOverridden: number;
  lastOutcomeStatus?: OutcomeStatus | null;
  userConfirmed: boolean;
  channelApplicabilityJson: string;
  safetyLevel: DelegationSafetyLevel;
}

export type OutcomeSourceType =
  | 'mission'
  | 'action_bundle'
  | 'message_action'
  | 'reminder'
  | 'life_thread'
  | 'communication_thread'
  | 'current_work'
  | 'cross_channel_handoff';

export type OutcomeStatus =
  | 'completed'
  | 'partial'
  | 'skipped'
  | 'failed'
  | 'deferred'
  | 'unknown';

export type OutcomeReviewHorizon =
  | 'today'
  | 'tonight'
  | 'tomorrow'
  | 'this_week'
  | 'weekend'
  | 'later'
  | 'none';

export interface OutcomeLinkedRefs {
  actionBundleId?: string;
  messageActionId?: string;
  reminderTaskId?: string;
  threadId?: string;
  communicationThreadId?: string;
  missionId?: string;
  handoffId?: string;
  currentWorkRef?: string;
  knowledgeSourceIds?: string[];
  chatJid?: string;
  personName?: string;
  delegationRuleId?: string;
  delegationMode?: DelegationApprovalMode | null;
  delegationExplanation?: string | null;
}

export interface OutcomeRecord {
  outcomeId: string;
  groupFolder: string;
  sourceType: OutcomeSourceType;
  sourceKey: string;
  linkedRefsJson?: string | null;
  status: OutcomeStatus;
  completionSummary?: string | null;
  nextFollowupText?: string | null;
  blockerText?: string | null;
  dueAt?: string | null;
  reviewHorizon: OutcomeReviewHorizon;
  lastCheckedAt: string;
  userConfirmed: boolean;
  showInDailyReview: boolean;
  showInWeeklyReview: boolean;
  reviewSuppressedUntil?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CouncilOutcomeSignalKind =
  | 'guidance_applied'
  | 'answer_sent'
  | 'answer_blocked'
  | 'answer_clarified'
  | 'safe_rewrite'
  | 'feedback_attached'
  | 'feedback_negative'
  | 'repair_linked';

export interface CouncilRunLedgerRecord {
  councilRunId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  taskFamily: string;
  channel?: string | null;
  requestedMode?: string | null;
  chosenMode: string;
  calibrationReason: string;
  calibrationChanged: boolean;
  protectedMode: boolean;
  status: string;
  finalStatus: string;
  recommendedAction: string;
  confidence: number;
  evidenceGrade: string;
  approvalNeed: string;
  memberStatusesJson: string;
  providerFailuresJson: string;
  schemaStatusJson: string;
  evidenceScorecardJson: string;
  confidenceMathJson: string;
  budgetJson: string;
  replaySummary: string;
  riskFlagsJson: string;
  outcomeSignalCount: number;
  latestOutcomeAt?: string | null;
  outcomeStatus?: string | null;
}

export interface CouncilOutcomeSignal {
  signalId: string;
  councilRunId: string;
  createdAt: string;
  groupFolder?: string | null;
  channel?: string | null;
  signalKind: CouncilOutcomeSignalKind;
  routeKey?: string | null;
  capabilityId?: string | null;
  blockerClass?: string | null;
  feedbackId?: string | null;
  repairPlanId?: string | null;
  flagsJson: string;
  summary: string;
}

export interface CouncilProviderReliabilitySnapshot {
  providerId: string;
  role: string;
  runs: number;
  completed: number;
  blocked: number;
  skipped: number;
  recentFailureRate: number;
  degraded: boolean;
}

export interface CouncilCalibrationSnapshot {
  taskFamily: string;
  requestedMode: string;
  chosenMode: string;
  changedMode: boolean;
  protectedMode: boolean;
  reason: string;
  recentRuns: number;
  lowConfidenceRuns: number;
  schemaInvalidRuns: number;
  verifierBlockRuns: number;
  negativeFeedbackRuns: number;
  degradedProviderIds: string[];
  providerReliability: CouncilProviderReliabilitySnapshot[];
}

export interface CouncilDoctorReport {
  generatedAt: string;
  ok: boolean;
  summary: string;
  lastRun?: {
    councilRunId: string;
    createdAt: string;
    taskFamily: string;
    mode: string;
    finalStatus: string;
    confidence: number;
    replaySummary: string;
  } | null;
  recent: {
    totalRuns: number;
    degradedRuns: number;
    averageConfidence: number;
    schemaInvalidRuns: number;
    lowConfidenceRuns: number;
    outcomeSignals: number;
  };
  providerReliability: CouncilProviderReliabilitySnapshot[];
  providerParticipation?: {
    status: 'full' | 'degraded' | 'minimal' | 'none';
    skippedProviderIds: string[];
    substitutedRoles: string[];
    riskFlags: string[];
    nextAction: string;
  };
  degradedReasons: string[];
  evidenceGaps: string[];
  taskEase?: {
    status: 'pass' | 'warn' | 'fail';
    score: number;
    lastAttemptId: string;
    lastOutcome: string;
    outcomeSignalCount: number;
    sourcePatternCoverage: string;
    qualityGateCoverage: string;
    nextAction: string;
  };
  nextAction: string;
  privacy: {
    secretsRedacted: boolean;
    rawPromptsStored: boolean;
    rawPrivateBodiesStored: boolean;
  };
}

export interface BlueBubblesProofTimelineEntry {
  at: string;
  kind: 'message' | 'message_action';
  chatJid: string;
  canonicalChatJid: string;
  direction?: 'inbound' | 'outbound' | 'local_self';
  contentShape?: string;
  messageId?: string;
  messageActionId?: string;
  actionStatus?: MessageActionSendStatus;
  actionKind?: MessageActionLastActionKind | null;
  proofEligible: boolean;
  detail: string;
}

export interface BlueBubblesProofReconciliationReport {
  generatedAt: string;
  groupFolder: string;
  canonicalSelfThreadChatJid: string;
  aliasJids: string[];
  windowStart: string;
  windowEnd: string;
  timeline: BlueBubblesProofTimelineEntry[];
  activeActionId: string;
  activeActionChatJid: string;
  lastInboundAt: string;
  lastOutboundAt: string;
  lastDecisionAt: string;
  lastDecisionActionId: string;
  lastDecisionChatJid: string;
  confirmationAt: string;
  messageActionProofState: 'fresh' | 'stale' | 'none';
  blockerCategory:
    | 'none'
    | 'no_canonical_traffic'
    | 'no_action'
    | 'awaiting_decision'
    | 'awaiting_confirmation'
    | 'stale'
    | 'skipped';
  blocker: string;
  nextAction: string;
  privacy: {
    rawMessageBodiesStored: false;
    contentShapeOnly: true;
  };
}

export interface CouncilTaskAttempt {
  attemptId: string;
  createdAt: string;
  taskId: string;
  taskFamily: string;
  mode: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  outcome: string;
  riskFlags: string[];
}

export interface CouncilTaskOutcome {
  attemptId: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  outcomeSignalCount: number;
  nextAction: string;
}

export interface CouncilSourcePatternAdoptionStatus {
  patternId: string;
  sourceRepoIds: string[];
  adoptionMode: string;
  verificationScenarioId: string;
  implemented: boolean;
  verified: boolean;
  status: 'verified' | 'implemented_unverified' | 'planned';
}

export type CognitiveRunStatus =
  | 'framed'
  | 'planned'
  | 'awaiting_evidence'
  | 'awaiting_approval'
  | 'answered'
  | 'blocked'
  | 'learned';

export type CognitiveMode =
  | 'quick_path'
  | 'reactive_plan'
  | 'read_only_react'
  | 'council_verified'
  | 'approval_staged';

export type CognitiveAutonomyLevel =
  | 'none'
  | 'plan_draft_only'
  | 'read_only_tools';

export interface CognitiveRunRecord {
  runId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  channel?: string | null;
  taskFamily: string;
  turnId?: string | null;
  goalSummary: string;
  selectedSkillId: string;
  status: CognitiveRunStatus;
  autonomyLevel: CognitiveAutonomyLevel;
  cognitiveMode: CognitiveMode;
  taskGraphJson: string;
  evidenceContractJson: string;
  providerUsabilityJson: string;
  councilRunId?: string | null;
  verificationJson: string;
  outcomeScore: number;
  nextAction: string;
  privacyJson: string;
  linkedSkillCardId?: string | null;
}

export interface CognitiveSubgoalRecord {
  subgoalId: string;
  runId: string;
  position: number;
  title: string;
  status: 'pending' | 'ready' | 'blocked' | 'verified';
  requiredEvidence: string;
  allowedActionsJson: string;
  approvalNeed: string;
  stopCondition: string;
  toolPlanJson: string;
  verificationJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface CognitiveSkillCardRecord {
  skillId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  taskFamily: string;
  triggerSummary: string;
  skillSummary: string;
  requiredToolsJson: string;
  evidenceNeedsJson: string;
  approvalRulesJson: string;
  failureModesJson: string;
  verificationChecklistJson: string;
  latestOutcomeScore: number;
  promotionState: 'candidate' | 'promoted' | 'quarantined' | 'retired';
  usageCount: number;
  lastUsedAt?: string | null;
}

export type WorldFactType =
  | 'person'
  | 'household'
  | 'responsibility'
  | 'active_goal'
  | 'active_concern'
  | 'routine'
  | 'communication_obligation'
  | 'calendar_pressure'
  | 'bill'
  | 'errand'
  | 'grocery'
  | 'meal'
  | 'preference'
  | 'delegated_default'
  | 'tool_health'
  | 'friction_pattern';

export type WorldFactStatus =
  | 'suggested'
  | 'pending_confirmation'
  | 'confirmed'
  | 'stale'
  | 'rejected'
  | 'forgotten';

export type WorldFactSensitivity = 'low' | 'personal' | 'sensitive';

export type WorldFactAutoSurfacePolicy =
  | 'never'
  | 'when_relevant'
  | 'ask_first'
  | 'operator_only';

export interface WorldFactRecord {
  factId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  factType: WorldFactType;
  summary: string;
  confidence: number;
  evidenceRefsJson: string;
  lastSeenAt: string;
  lastConfirmedAt?: string | null;
  sensitivity: WorldFactSensitivity;
  autoSurfacePolicy: WorldFactAutoSurfacePolicy;
  reviewAfterAt?: string | null;
  expiresAt?: string | null;
  status: WorldFactStatus;
  sourceKind: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldFactEvidenceLinkRecord {
  linkId: string;
  factId: string;
  createdAt: string;
  evidenceSourceKind: string;
  evidenceSourceId: string;
  confidenceDelta: number;
  summary: string;
  privacyJson: string;
}

export type LearningDistillationOutputKind =
  | 'candidate_preference'
  | 'life_thread_update'
  | 'skill'
  | 'world_fact'
  | 'rule_adjustment'
  | 'friction_issue'
  | 'doc_test_gap';

export type LearningDistillationStatus =
  | 'suggested'
  | 'pending_confirmation'
  | 'confirmed'
  | 'rejected'
  | 'paused'
  | 'forgotten';

export interface LearningDistillationRecord {
  distillationId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  outputKind: LearningDistillationOutputKind;
  status: LearningDistillationStatus;
  sensitivity: WorldFactSensitivity;
  summary: string;
  whySuggested: string;
  evidenceRefsJson: string;
  targetId?: string | null;
  controlStateJson: string;
  nextAction: string;
  privacyJson: string;
}

export type SkillPlaybookStatus = 'suggested' | 'active' | 'paused' | 'retired';

export interface SkillPlaybookRecord {
  skillId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  title: string;
  triggerPattern: string;
  taskFamily: string;
  requiredContextJson: string;
  allowedActionsJson: string;
  disallowedActionsJson: string;
  approvalRequirementsJson: string;
  expectedToolsJson: string;
  fallbackPlan: string;
  successCriteriaJson: string;
  evalScenariosJson: string;
  usageCount: number;
  lastOutcome?: string | null;
  reliabilityScore: number;
  status: SkillPlaybookStatus;
  sourceDistillationId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface SkillPlaybookRunRecord {
  runId: string;
  skillId: string;
  createdAt: string;
  groupFolder?: string | null;
  requestSummary: string;
  matched: boolean;
  contextReady: boolean;
  toolReliabilityJson: string;
  approvalRequired: boolean;
  outcome: 'proposed' | 'executed_safe_step' | 'approval_staged' | 'blocked';
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveReflectionRecord {
  reflectionId: string;
  createdAt: string;
  groupFolder?: string | null;
  runId?: string | null;
  skillId?: string | null;
  taskFamily: string;
  reflectionKind:
    | 'success'
    | 'failure'
    | 'provider_degraded'
    | 'approval_blocked'
    | 'user_correction'
    | 'verifier_block';
  summary: string;
  routeKey?: string | null;
  providerStateJson: string;
  nextRule: string;
  confidence: number;
  privacyJson: string;
}

export interface CognitiveRewardSignalRecord {
  signalId: string;
  createdAt: string;
  runId: string;
  skillId?: string | null;
  signalKind:
    | 'task_answered'
    | 'task_blocked'
    | 'approval_required'
    | 'skill_promoted'
    | 'skill_demoted'
    | 'user_correction';
  score: number;
  summary: string;
  flagsJson: string;
}

export type CognitiveCheckpointKind =
  | 'frame'
  | 'plan'
  | 'tool_policy'
  | 'tool_step'
  | 'verification'
  | 'approval_wait'
  | 'evidence_wait'
  | 'clarification_wait'
  | 'resume'
  | 'outcome';

export type CognitiveCheckpointStatus =
  | 'open'
  | 'resumed'
  | 'closed'
  | 'blocked'
  | 'expired';

export interface CognitiveCheckpointRecord {
  checkpointId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  subgoalId?: string | null;
  groupFolder?: string | null;
  channel?: string | null;
  checkpointKind: CognitiveCheckpointKind;
  status: CognitiveCheckpointStatus;
  summary: string;
  stateJson: string;
  nextAction: string;
  continuationKey?: string | null;
  expiresAt?: string | null;
  resolvedAt?: string | null;
  privacyJson: string;
}

export type CognitiveToolKind =
  | 'local_lookup'
  | 'read_only_integration'
  | 'council'
  | 'draft'
  | 'approval_gate'
  | 'operator';

export type CognitiveToolApprovalPolicy =
  | 'none'
  | 'read_only'
  | 'explicit_approval'
  | 'forbidden';

export interface CognitiveToolRegistryRecord {
  toolId: string;
  createdAt: string;
  updatedAt: string;
  toolKind: CognitiveToolKind;
  displayName: string;
  purpose: string;
  allowedActionsJson: string;
  approvalPolicy: CognitiveToolApprovalPolicy;
  riskLevel: 'low' | 'medium' | 'high';
  evidenceProducedJson: string;
  failureModesJson: string;
  lastVerifiedAt?: string | null;
  healthState: 'healthy' | 'degraded' | 'blocked' | 'unknown';
  privacyJson: string;
}

export interface CognitiveToolAdapterContract {
  toolId: string;
  policyClass: 'local_lookup' | 'read_only' | 'council' | 'approval_staged';
  inputSchemaJson: string;
  outputSchemaJson: string;
  timeoutMs: number;
  retryPolicyJson: string;
  evidenceMapper: string;
  failureClassifier: string;
  privacyJson: string;
}

export interface CognitiveWorldBeliefRecord {
  beliefId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  runId?: string | null;
  source:
    | 'provider_health'
    | 'skill_library'
    | 'council_verdict'
    | 'integration_status'
    | 'local_metadata';
  subject: string;
  summary: string;
  confidence: number;
  freshness: 'fresh' | 'stale' | 'unknown';
  supersedesBeliefId?: string | null;
  privacyJson: string;
}

export interface CognitiveBenchmarkAttemptRecord {
  attemptId: string;
  createdAt: string;
  taskId: string;
  taskFamily: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  runId?: string | null;
  checkpointCount: number;
  toolPolicyPass: boolean;
  approvalGatePass: boolean;
  privacyPass: boolean;
  outcomeCaptured: boolean;
  nextAction: string;
  detailJson: string;
}

export type CognitiveGoalStatus =
  | 'active'
  | 'waiting_evidence'
  | 'waiting_approval'
  | 'satisfied'
  | 'blocked'
  | 'abandoned';

export interface CognitiveGoalRecord {
  goalId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  parentGoalId?: string | null;
  rootRunId?: string | null;
  taskFamily: string;
  objectiveSummary: string;
  status: CognitiveGoalStatus;
  priority: number;
  successCriteriaJson: string;
  decompositionJson: string;
  linkedRunIdsJson: string;
  activeCheckpointId?: string | null;
  rewardScore: number;
  nextAction: string;
  closedAt?: string | null;
  privacyJson: string;
}

export type CognitiveBlackboardEntryKind =
  | 'observation'
  | 'hypothesis'
  | 'constraint'
  | 'decision'
  | 'verification'
  | 'repair'
  | 'outcome';

export interface CognitiveBlackboardEntryRecord {
  entryId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  goalId?: string | null;
  runId?: string | null;
  entryKind: CognitiveBlackboardEntryKind;
  source:
    | 'kernel'
    | 'council'
    | 'tool_registry'
    | 'provider_health'
    | 'checkpoint'
    | 'user_feedback'
    | 'benchmark';
  status: 'active' | 'superseded' | 'resolved' | 'blocked';
  summary: string;
  evidenceRefsJson: string;
  confidence: number;
  expiresAt?: string | null;
  privacyJson: string;
}

export interface CognitiveAutonomyBudgetRecord {
  budgetId: string;
  createdAt: string;
  updatedAt: string;
  cognitiveMode: CognitiveMode;
  taskFamily: string;
  maxToolSteps: number;
  maxCouncilCalls: number;
  maxReadOnlyCalls: number;
  mutatingAllowed: boolean;
  approvalRequired: boolean;
  maxRuntimeMs: number;
  clarificationAfterBlockedSteps: number;
  budgetJson: string;
  privacyJson: string;
}

export type CognitiveTraceSpanKind =
  | 'run'
  | 'frame'
  | 'tool_plan'
  | 'tool_simulation'
  | 'tool_execution'
  | 'council'
  | 'provider_health'
  | 'checkpoint'
  | 'guardrail'
  | 'plan_revision'
  | 'outcome';

export interface CognitiveTraceSpan {
  spanId: string;
  createdAt: string;
  endedAt?: string | null;
  runId?: string | null;
  goalId?: string | null;
  parentSpanId?: string | null;
  spanKind: CognitiveTraceSpanKind;
  status: 'started' | 'completed' | 'blocked' | 'warn' | 'skipped';
  summary: string;
  inputSummary: string;
  outputSummary: string;
  metadataJson: string;
  privacyJson: string;
}

export interface CognitiveToolSimulation {
  simulationId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  actionClass: string;
  status: 'pass' | 'warn' | 'block';
  approvalRequired: boolean;
  readOnly: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  evidenceExpectedJson: string;
  failureModesJson: string;
  issuesJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitivePolicyDecision {
  decisionId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  simulationId?: string | null;
  status: 'allow' | 'stage_approval' | 'block' | 'skip';
  reason: string;
  approvalRequired: boolean;
  readOnly: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  issuesJson: string;
  privacyJson: string;
}

export interface CognitiveToolResultEnvelope {
  resultId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  status: 'succeeded' | 'degraded' | 'blocked' | 'skipped';
  summary: string;
  evidenceRefsJson: string;
  outputShapeJson: string;
  failureClass?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveExecutionStep {
  stepId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  subgoalId?: string | null;
  toolId: string;
  position: number;
  actionClass: string;
  status:
    | 'planned'
    | 'executed'
    | 'degraded'
    | 'blocked'
    | 'skipped'
    | 'approval_staged'
    | 'failed';
  policyDecisionId?: string | null;
  resultId?: string | null;
  policyDecisionJson: string;
  resultJson: string;
  verificationJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveEvidenceArtifact {
  artifactId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  resultId?: string | null;
  artifactKind:
    | 'local_memory'
    | 'provider_health'
    | 'integration_status'
    | 'calendar_read'
    | 'research_evidence'
    | 'bluebubbles_digest'
    | 'operator_diagnostics'
    | 'council'
    | 'cognition_trace'
    | 'approval_packet'
    | 'unknown';
  summary: string;
  evidenceRefsJson: string;
  sourceShapeJson: string;
  sensitivity: 'metadata' | 'sanitized_digest' | 'public' | 'private_metadata';
  freshness: 'fresh' | 'stale' | 'unknown';
  confidence: number;
  privacyJson: string;
}

export interface CognitiveExecutionLoopState {
  loopId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  status:
    | 'running'
    | 'satisfied'
    | 'budget_exhausted'
    | 'blocked'
    | 'approval_staged'
    | 'degraded';
  round: number;
  maxRounds: number;
  maxToolSteps: number;
  executedToolSteps: number;
  evidenceSatisfied: boolean;
  openEvidenceGapsJson: string;
  nextToolIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveStepVerification {
  verificationId: string;
  createdAt: string;
  runId: string;
  stepId?: string | null;
  toolId: string;
  status: 'pass' | 'warn' | 'block' | 'approval_staged';
  evidenceArtifactIdsJson: string;
  evidenceSufficient: boolean;
  approvalRequired: boolean;
  blockerClass?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveApprovalPacket {
  approvalPacketId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  toolId: string;
  actionClass: string;
  status: 'staged' | 'approved' | 'rejected' | 'expired' | 'executed_elsewhere';
  summary: string;
  approvalChannel?: string | null;
  approvalKey?: string | null;
  expiresAt?: string | null;
  decisionJson: string;
  privacyJson: string;
}

export interface CognitiveTrajectoryScore {
  trajectoryId: string;
  createdAt: string;
  runId: string;
  taskFamily: string;
  status: 'pass' | 'warn' | 'fail';
  overallScore: number;
  evidenceSufficiency: number;
  toolEfficiency: number;
  verifierSatisfaction: number;
  blockerClarity: number;
  privacySafety: number;
  outcomeSignal: number;
  promotedRoute: boolean;
  demotedAdaptersJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitivePlanRevision {
  revisionId: string;
  createdAt: string;
  runId: string;
  revisionKind:
    | 'tool_failure'
    | 'missing_evidence'
    | 'provider_cooldown'
    | 'approval_required'
    | 'verification'
    | 'success_path';
  changedToolId?: string | null;
  reason: string;
  beforeStateJson: string;
  afterStateJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveGoalThread {
  goalId: string;
  runIds: string[];
  status: CognitiveGoalStatus;
  nextAction: string;
}

export interface CognitiveRunEvent {
  eventId: string;
  createdAt: string;
  runId: string;
  eventKind:
    | 'frame'
    | 'simulate'
    | 'policy'
    | 'execute'
    | 'verify'
    | 'revise'
    | 'checkpoint'
    | 'outcome';
  summary: string;
  refsJson: string;
  privacyJson: string;
}

export interface CognitiveProviderCooldown {
  providerId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'cleared' | 'expired';
  failureClass: string;
  source: 'live_probe' | 'council' | 'cognition' | 'manual';
  runId?: string | null;
  cooldownUntil: string;
  lastFailure: string;
  nextAction: string;
  metadataJson: string;
  privacyJson: string;
}

export type CognitiveGovernanceRiskClass =
  | 'goal_hijack'
  | 'prompt_injection'
  | 'tool_misuse'
  | 'memory_poisoning'
  | 'identity_ambiguity'
  | 'cascading_failure'
  | 'rogue_agent_behavior'
  | 'data_exfiltration'
  | 'unauthorized_write'
  | 'policy_drift';

export type CognitiveWorkbenchRole =
  | 'planner'
  | 'evidence_scout'
  | 'memory_curator'
  | 'operator_diagnostician'
  | 'verifier'
  | 'final_arbiter'
  | 'executor';

export interface CognitiveGovernancePolicy {
  policyId: string;
  createdAt: string;
  updatedAt: string;
  policyName: string;
  status: 'active' | 'draft' | 'retired';
  version: string;
  defaultAction: 'allow' | 'stage_approval' | 'block';
  readOnlyAllowed: boolean;
  mutatingAllowed: boolean;
  approvalRequiredForHighRisk: boolean;
  riskClassesJson: string;
  sourcePatternRefsJson: string;
  privacyJson: string;
}

export interface CognitiveActionIdentity {
  actionId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  actionClass: string;
  actorRole: CognitiveWorkbenchRole;
  policyClass: CognitiveToolAdapterContract['policyClass'];
  channel?: string | null;
  targetKind?: string | null;
  targetSummary: string;
  sideEffectClass: 'none' | 'read_only' | 'draft' | 'mutating';
  identityRefsJson: string;
  privacyJson: string;
}

export interface CognitiveGovernanceDecision {
  decisionId: string;
  createdAt: string;
  runId: string;
  toolId: string;
  actionId?: string | null;
  policyId: string;
  interventionPoint:
    | 'pre_tool'
    | 'handoff'
    | 'memory_compile'
    | 'pre_approval'
    | 'council'
    | 'final_answer';
  status: 'allow' | 'warn' | 'stage_approval' | 'block';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskClassesJson: string;
  tripwireIdsJson: string;
  reason: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveGuardrailTripwire {
  tripwireId: string;
  createdAt: string;
  runId: string;
  toolId?: string | null;
  riskClass: CognitiveGovernanceRiskClass;
  severity: 'low' | 'medium' | 'high' | 'critical';
  triggered: boolean;
  source: 'goal' | 'tool_policy' | 'memory' | 'provider' | 'handoff';
  summary: string;
  evidenceRefsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveHandoff {
  handoffId: string;
  createdAt: string;
  runId: string;
  fromRole: CognitiveWorkbenchRole;
  toRole: CognitiveWorkbenchRole;
  status: 'requested' | 'accepted' | 'skipped' | 'blocked' | 'completed';
  reason: string;
  evidenceRefsJson: string;
  governanceDecisionId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveRiskSignal {
  signalId: string;
  createdAt: string;
  runId: string;
  riskClass: CognitiveGovernanceRiskClass;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'mitigated' | 'accepted' | 'false_positive';
  source: 'governance' | 'tripwire' | 'memory' | 'provider' | 'tool';
  summary: string;
  evidenceRefsJson: string;
  governanceDecisionId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveMemoryBlock {
  blockId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  blockKind:
    | 'profile'
    | 'preferences'
    | 'operating_rules'
    | 'current_projects'
    | 'people_threads'
    | 'skills'
    | 'provider_health'
    | 'integration_status';
  status: 'active' | 'conflicted' | 'blocked';
  summary: string;
  sourceIdsJson: string;
  freshness: 'fresh' | 'stale' | 'unknown';
  sensitivity: 'metadata' | 'sanitized_digest' | 'private_metadata';
  conflictFlagsJson: string;
  poisoningRisk: number;
  governanceDecisionId?: string | null;
  privacyJson: string;
}

export interface CognitiveWorkbenchState {
  workbenchId: string;
  createdAt: string;
  updatedAt: string;
  runId: string;
  status: 'active' | 'answered' | 'awaiting_approval' | 'blocked' | 'degraded';
  activeGoalId?: string | null;
  selectedSkillId?: string | null;
  handoffCount: number;
  governanceDecisionCount: number;
  memoryBlockCount: number;
  riskSignalCount: number;
  approvalPacketCount: number;
  nextAction: string;
  stateJson: string;
  privacyJson: string;
}

export interface CognitiveReplayPacket {
  generatedAt: string;
  runId?: string | null;
  latestRun?: CognitiveRunRecord | null;
  spans: CognitiveTraceSpan[];
  simulations: CognitiveToolSimulation[];
  policyDecisions: CognitivePolicyDecision[];
  toolResults: CognitiveToolResultEnvelope[];
  executionSteps: CognitiveExecutionStep[];
  evidenceArtifacts: CognitiveEvidenceArtifact[];
  loopStates: CognitiveExecutionLoopState[];
  stepVerifications: CognitiveStepVerification[];
  approvalPackets: CognitiveApprovalPacket[];
  planRevisions: CognitivePlanRevision[];
  runEvents: CognitiveRunEvent[];
  trajectoryScores: CognitiveTrajectoryScore[];
  providerCooldowns: CognitiveProviderCooldown[];
  governancePolicies: CognitiveGovernancePolicy[];
  actionIdentities: CognitiveActionIdentity[];
  governanceDecisions: CognitiveGovernanceDecision[];
  guardrailTripwires: CognitiveGuardrailTripwire[];
  handoffs: CognitiveHandoff[];
  riskSignals: CognitiveRiskSignal[];
  memoryBlocks: CognitiveMemoryBlock[];
  workbenchStates: CognitiveWorkbenchState[];
  checkpoints: CognitiveCheckpointRecord[];
  privacy: {
    metadataOnly: true;
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
  };
}

export interface CognitiveRunTraceReport {
  generatedAt: string;
  ok: boolean;
  summary: string;
  runId?: string | null;
  spanCount: number;
  blockedSpanCount: number;
  simulationStatus: 'pass' | 'warn' | 'block' | 'none';
  executionStatus: 'pass' | 'warn' | 'block' | 'none';
  executedStepCount: number;
  loopStatus: CognitiveExecutionLoopState['status'] | 'none';
  loopRoundCount: number;
  evidenceArtifactCount: number;
  approvalPacketCount: number;
  trajectoryScore?: number | null;
  governanceDecisionCount: number;
  handoffCount: number;
  memoryBlockCount: number;
  riskSignalCount: number;
  workbenchStatus: CognitiveWorkbenchState['status'] | 'none';
  planRevisionCount: number;
  activeCooldownProviderIds: string[];
  nextAction: string;
  replayPacket: CognitiveReplayPacket;
}

export type AgentOSEpisodeStatus =
  | 'active'
  | 'interrupted'
  | 'awaiting_approval'
  | 'blocked'
  | 'completed'
  | 'abandoned';

export type AgentOSEpisodeMode =
  | 'quick_episode'
  | 'read_only_episode'
  | 'council_verified_episode'
  | 'approval_staged_episode'
  | 'operator_episode';

export interface AgentOSEpisode {
  episodeId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  channel?: string | null;
  rootRunId?: string | null;
  activeRunId?: string | null;
  goalSummary: string;
  taskFamily: string;
  status: AgentOSEpisodeStatus;
  mode: AgentOSEpisodeMode;
  priority: number;
  linkedRunIdsJson: string;
  councilRunIdsJson: string;
  evidenceIdsJson: string;
  interruptIdsJson: string;
  approvalPacketIdsJson: string;
  memoryBlockIdsJson: string;
  trajectoryEvalIdsJson: string;
  sourceCoverageJson: string;
  nextAction: string;
  privacyJson: string;
  completedAt?: string | null;
}

export type AgentOSEpisodeStepKind =
  | 'frame'
  | 'plan'
  | 'handoff'
  | 'tool_discovery'
  | 'memory_compile'
  | 'tool_step'
  | 'council'
  | 'interrupt'
  | 'verify'
  | 'trajectory_eval'
  | 'outcome';

export interface AgentOSEpisodeStep {
  stepId: string;
  episodeId: string;
  runId?: string | null;
  createdAt: string;
  position: number;
  stepKind: AgentOSEpisodeStepKind;
  actorRole?: CognitiveWorkbenchRole | null;
  status: 'planned' | 'completed' | 'warn' | 'blocked' | 'approval_staged';
  summary: string;
  evidenceRefsJson: string;
  governanceDecisionIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSInterrupt {
  interruptId: string;
  episodeId: string;
  runId?: string | null;
  checkpointId?: string | null;
  createdAt: string;
  updatedAt: string;
  interruptKind:
    | 'approval_required'
    | 'evidence_gap'
    | 'clarification_required'
    | 'provider_blocked'
    | 'policy_blocked';
  status: 'open' | 'resumed' | 'closed' | 'expired';
  payloadJson: string;
  resumeTokenId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSResumeToken {
  resumeTokenId: string;
  episodeId: string;
  interruptId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
  continuationKey: string;
  safeStateJson: string;
  expiresAt?: string | null;
  usedAt?: string | null;
  privacyJson: string;
}

export interface AgentOSToolCard {
  toolCardId: string;
  createdAt: string;
  updatedAt: string;
  sourceToolId: string;
  displayName: string;
  capabilityKind:
    | 'script'
    | 'integration'
    | 'cognition_tool'
    | 'council_mode'
    | 'skill'
    | 'debug_surface';
  policyClass:
    | 'local_lookup'
    | 'read_only'
    | 'council'
    | 'approval_staged'
    | 'forbidden';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  approvalPolicy: CognitiveToolApprovalPolicy;
  healthState: 'healthy' | 'degraded' | 'blocked' | 'unknown';
  evidenceProducedJson: string;
  cooldownJson: string;
  sourceRefsJson: string;
  privacyJson: string;
}

export interface AgentOSRoleHandoff {
  handoffId: string;
  episodeId: string;
  runId?: string | null;
  createdAt: string;
  fromRole: CognitiveWorkbenchRole;
  toRole: CognitiveWorkbenchRole;
  status: 'requested' | 'accepted' | 'completed' | 'blocked' | 'skipped';
  reason: string;
  evidenceRefsJson: string;
  governanceDecisionIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSTrajectoryEval {
  evalId: string;
  episodeId: string;
  runId?: string | null;
  createdAt: string;
  status: 'pass' | 'warn' | 'fail';
  overallScore: number;
  sourceCoverage: number;
  interruptSafety: number;
  approvalSafety: number;
  toolUsefulness: number;
  verificationStrength: number;
  privacySafety: number;
  promotionEligible: boolean;
  demotionSignalsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSSkillProposal {
  proposalId: string;
  episodeId: string;
  createdAt: string;
  updatedAt: string;
  status: 'candidate' | 'accepted' | 'rejected' | 'quarantined';
  taskFamily: string;
  triggerSummary: string;
  skillSummary: string;
  requiredToolCardIdsJson: string;
  evidenceNeedsJson: string;
  approvalRulesJson: string;
  verificationChecklistJson: string;
  outcomeScore: number;
  sourceEpisodeIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSCapabilityDiscoveryReport {
  generatedAt: string;
  toolCards: AgentOSToolCard[];
  healthy: number;
  degraded: number;
  blocked: number;
  approvalStaged: number;
  readOnly: number;
  sourceCoverage: string[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface AgentOSReport {
  generatedAt: string;
  ok: boolean;
  summary: string;
  latestEpisode?: AgentOSEpisode | null;
  episodeSteps: AgentOSEpisodeStep[];
  interrupts: AgentOSInterrupt[];
  resumeTokens: AgentOSResumeToken[];
  toolCards: AgentOSToolCard[];
  handoffs: AgentOSRoleHandoff[];
  trajectoryEvals: AgentOSTrajectoryEval[];
  skillProposals: AgentOSSkillProposal[];
  capabilityDiscovery: AgentOSCapabilityDiscoveryReport;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface AgentOSTaskNode {
  nodeId: string;
  planId: string;
  position: number;
  nodeKind:
    | 'planner'
    | 'memory_curator'
    | 'evidence_scout'
    | 'tool_executor'
    | 'verifier'
    | 'arbiter'
    | 'approval_stager';
  role: CognitiveWorkbenchRole;
  status: 'planned' | 'ready' | 'executed' | 'blocked' | 'approval_staged';
  policyClass: AgentOSToolCard['policyClass'];
  approvalRequired: boolean;
  canRunInParallel: boolean;
  dependsOnNodeIdsJson: string;
  requiredEvidenceJson: string;
  stopCondition: string;
  toolCardIdsJson: string;
  guardrailJson: string;
  outputEvidenceIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSTaskDAG {
  dagId: string;
  planId: string;
  createdAt: string;
  taskFamily: string;
  status: 'planned' | 'replay_ready' | 'executed' | 'blocked';
  nodeIdsJson: string;
  edgeIdsJson: string;
  parallelGroupIdsJson: string;
  approvalNodeIdsJson: string;
  evidenceContractJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface GovernedToolNode {
  nodeId: string;
  toolCardId: string;
  policyClass: AgentOSToolCard['policyClass'];
  prePolicy: string;
  postPolicy: string;
  timeoutMs: number;
  outputRedaction: 'metadata_only' | 'summary_only';
  retryPolicy: 'none' | 'single_safe_retry' | 'cooldown_skip';
  approvalBehavior: 'execute_read_only' | 'stage_approval' | 'fail_closed';
}

export interface ToolGuardrailDecision {
  decisionId: string;
  nodeId: string;
  allowed: boolean;
  status: 'pass' | 'approval_required' | 'blocked';
  riskFlagsJson: string;
  reason: string;
  nextAction: string;
  privacyJson: string;
}

export interface ToolEvidenceMapping {
  mappingId: string;
  nodeId: string;
  evidenceIdsJson: string;
  sourceClassesJson: string;
  freshness: 'fresh' | 'recent' | 'stale' | 'unknown';
  summary: string;
  privacyJson: string;
}

export interface ToolCooldownPolicy {
  policyId: string;
  toolCardId: string;
  failureClassesJson: string;
  cooldownMs: number;
  skipWhenActive: boolean;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSPlanArtifact {
  planId: string;
  createdAt: string;
  updatedAt: string;
  goal: string;
  taskFamily: string;
  status: 'planned' | 'replay_ready' | 'replayed' | 'retired';
  planOnly: boolean;
  dagJson: string;
  nodeIdsJson: string;
  governedToolNodesJson: string;
  guardrailDecisionsJson: string;
  evidenceMappingsJson: string;
  cooldownPoliciesJson: string;
  approvalPacketJson: string;
  sourcePatternRefsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSPlanPreview {
  generatedAt: string;
  plan: AgentOSPlanArtifact;
  dag: AgentOSTaskDAG;
  nodes: AgentOSTaskNode[];
  governedToolNodes: GovernedToolNode[];
  guardrailDecisions: ToolGuardrailDecision[];
  evidenceMappings: ToolEvidenceMapping[];
  cooldownPolicies: ToolCooldownPolicy[];
  approvalRequired: boolean;
  executableReadOnlyNodeCount: number;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface AgentOSReplayRun {
  replayId: string;
  planId: string;
  createdAt: string;
  status: 'replayed' | 'approval_staged' | 'blocked';
  replayedNodeIdsJson: string;
  evidenceIdsJson: string;
  policyDecisionsJson: string;
  plannerSkipped: boolean;
  approvalRequired: boolean;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentOSReplayReport {
  generatedAt: string;
  plan: AgentOSPlanArtifact;
  replay: AgentOSReplayRun;
  nodes: AgentOSTaskNode[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type LogicClaimKind =
  | 'episode_state'
  | 'tool_health'
  | 'integration_state'
  | 'memory_fact'
  | 'safety_policy'
  | 'next_action'
  | 'user_preference'
  | 'unknown';

export type LogicClaimStatus =
  | 'active'
  | 'stale'
  | 'superseded'
  | 'contradicted'
  | 'resolved'
  | 'historical'
  | 'needs_confirmation'
  | 'rejected';

export type LogicEvidenceFreshness =
  | 'fresh'
  | 'recent'
  | 'stale'
  | 'expired'
  | 'unknown';

export interface LogicClaimTransition {
  transitionId: string;
  claimId: string;
  subject: string;
  createdAt: string;
  fromStatus: LogicClaimStatus;
  toStatus: LogicClaimStatus;
  reason: string;
  evidenceFreshness: LogicEvidenceFreshness;
  sourceIdsJson: string;
  actor: 'logic_kernel' | 'user' | 'agent_os' | 'harness';
  nextAction: string;
  privacyJson: string;
}

export interface LogicBeliefRevision {
  revisionId: string;
  subject: string;
  createdAt: string;
  previousBeliefStateId?: string | null;
  nextBeliefStateId?: string | null;
  transitionIdsJson: string;
  hypothesisSetId?: string | null;
  confidenceBefore: number;
  confidenceAfter: number;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicHypothesisSet {
  hypothesisSetId: string;
  subject: string;
  createdAt: string;
  updatedAt: string;
  hypothesisIdsJson: string;
  preferredHypothesisId?: string | null;
  probabilitySummaryJson: string;
  uncertaintySummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicResolutionDecision {
  resolutionId: string;
  subject: string;
  createdAt: string;
  status:
    | 'resolved'
    | 'retired_stale'
    | 'needs_confirmation'
    | 'needs_fresh_evidence'
    | 'kept_uncertain';
  claimIdsJson: string;
  transitionIdsJson: string;
  resolvedContradictionIdsJson: string;
  confidence: number;
  rationaleSummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicClaim {
  claimId: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  predicate: string;
  objectSummary: string;
  normalizedText: string;
  claimKind: LogicClaimKind;
  confidence: number;
  probability: number;
  sensitivity: KnowledgeSensitivity;
  status: LogicClaimStatus;
  sourceEpisodeId?: string | null;
  sourceRunId?: string | null;
  evidenceIdsJson: string;
  contradictionIdsJson: string;
  supersedesClaimId?: string | null;
  requiresConfirmation: boolean;
  privacyJson: string;
}

export interface LogicEvidenceLink {
  linkId: string;
  claimId: string;
  evidenceId: string;
  evidenceKind:
    | 'agent_os_episode'
    | 'cognitive_run'
    | 'memory_block'
    | 'tool_card'
    | 'provider_health'
    | 'integration_status'
    | 'trajectory_eval'
    | 'source_coverage'
    | 'manual_metadata';
  sourceId: string;
  support: 'supports' | 'refutes' | 'context';
  strength: number;
  freshness: 'fresh' | 'recent' | 'stale' | 'unknown';
  sensitivity: KnowledgeSensitivity;
  summary: string;
  privacyJson: string;
}

export interface LogicContradiction {
  contradictionId: string;
  subject: string;
  claimIdA: string;
  claimIdB?: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'resolved' | 'accepted_uncertainty';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicHypothesis {
  hypothesisId: string;
  subject: string;
  createdAt: string;
  updatedAt: string;
  claimIdsJson: string;
  evidenceIdsJson: string;
  probability: number;
  status: 'candidate' | 'preferred' | 'disfavored' | 'rejected';
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicUsefulnessScore {
  actionId: string;
  subject: string;
  episodeId?: string | null;
  createdAt: string;
  actionLabel: string;
  actionKind:
    | 'answer'
    | 'read_only'
    | 'clarification'
    | 'approval_stage'
    | 'blocked';
  expectedUsefulness: number;
  effort: number;
  reversibility: number;
  risk: number;
  urgency: number;
  userPreferenceFit: number;
  evidenceSufficiency: number;
  totalScore: number;
  approvalRequired: boolean;
  evidenceIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicMissingPremise {
  premiseId: string;
  subject: string;
  episodeId?: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'answered' | 'waived';
  question: string;
  blockerClass: string;
  requiredEvidenceJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicDecision {
  decisionId: string;
  subject: string;
  episodeId?: string | null;
  runId?: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'answer' | 'clarify' | 'stage_approval' | 'blocked';
  selectedClaimIdsJson: string;
  selectedHypothesisId?: string | null;
  selectedActionId?: string | null;
  confidence: number;
  utility: number;
  rationaleSummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicBeliefState {
  beliefStateId: string;
  subject: string;
  createdAt: string;
  updatedAt: string;
  status: 'stable' | 'uncertain' | 'conflicted' | 'needs_clarification';
  topClaimIdsJson: string;
  hypothesisIdsJson: string;
  contradictionIdsJson: string;
  missingPremiseIdsJson: string;
  decisionId?: string | null;
  confidence: number;
  probability: number;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface LogicKernelReport {
  generatedAt: string;
  ok: boolean;
  subject: string;
  beliefState?: LogicBeliefState | null;
  claims: LogicClaim[];
  evidenceLinks: LogicEvidenceLink[];
  contradictions: LogicContradiction[];
  hypotheses: LogicHypothesis[];
  missingPremises: LogicMissingPremise[];
  usefulnessScores: LogicUsefulnessScore[];
  decision?: LogicDecision | null;
  confidence: number;
  selectedNextAction: string;
  summary: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface LogicReconciliationReport {
  generatedAt: string;
  ok: boolean;
  subject: string;
  beliefState?: LogicBeliefState | null;
  revisions: LogicBeliefRevision[];
  transitions: LogicClaimTransition[];
  hypothesisSets: LogicHypothesisSet[];
  resolutionDecisions: LogicResolutionDecision[];
  staleClaims: LogicClaim[];
  activeClaims: LogicClaim[];
  unresolvedContradictions: LogicContradiction[];
  freshness: {
    fresh: number;
    recent: number;
    stale: number;
    expired: number;
    unknown: number;
  };
  confidence: number;
  nextAction: string;
  summary: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type TruthClaimKind =
  | 'answer_claim'
  | 'calendar_certainty'
  | 'provider_participation'
  | 'integration_proof'
  | 'approval_action'
  | 'memory_fact'
  | 'research_claim'
  | 'unknown';

export type TruthSupportGrade =
  | 'supported'
  | 'partial'
  | 'unsupported'
  | 'contradicted'
  | 'stale';

export interface TruthClaim {
  claimId: string;
  auditId: string;
  createdAt: string;
  claimText: string;
  normalizedText: string;
  claimKind: TruthClaimKind;
  confidence: number;
  supportGrade: TruthSupportGrade;
  evidenceIdsJson: string;
  riskFlagsJson: string;
  privacyJson: string;
}

export interface TruthEvidenceSupport {
  supportId: string;
  auditId: string;
  claimId: string;
  evidenceId: string;
  evidenceKind:
    | 'logic_claim'
    | 'logic_evidence'
    | 'agent_os_episode'
    | 'council_evidence'
    | 'provider_health'
    | 'integration_status'
    | 'manual_metadata';
  support: 'supports' | 'refutes' | 'context' | 'stale';
  strength: number;
  freshness: LogicEvidenceFreshness;
  summary: string;
  privacyJson: string;
}

export interface TruthContradictionCheck {
  checkId: string;
  auditId: string;
  claimId: string;
  status: 'none' | 'open' | 'resolved' | 'uncertain';
  severity: 'low' | 'medium' | 'high';
  contradictionIdsJson: string;
  summary: string;
  privacyJson: string;
}

export interface TruthCalibrationVerdict {
  status: 'pass' | 'warn' | 'clarify' | 'block';
  supportGrade: TruthSupportGrade;
  confidence: number;
  clarificationNeeded: boolean;
  approvalBlocked: boolean;
  flags: string[];
  summary: string;
}

export interface TruthRewriteDirective {
  directiveId: string;
  auditId: string;
  createdAt: string;
  directive:
    | 'none'
    | 'caveat'
    | 'clarify'
    | 'block'
    | 'stage_approval'
    | 'rewrite';
  reason: string;
  suggestedText?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface TruthAnswerAudit {
  auditId: string;
  createdAt: string;
  updatedAt: string;
  turnId?: string | null;
  channel?: string | null;
  taskFamily?: string | null;
  subject: string;
  status: TruthCalibrationVerdict['status'];
  confidence: number;
  supportGrade: TruthSupportGrade;
  claimIdsJson: string;
  unsupportedClaimIdsJson: string;
  contradictionCheckIdsJson: string;
  rewriteDirectiveIdsJson: string;
  evidenceIdsJson: string;
  riskFlagsJson: string;
  verdictSummary: string;
  rewrittenTextSummary: string;
  bestNextAction: string;
  privacyJson: string;
}

export interface TruthSourceCoverage {
  sourceCoverageId: string;
  auditId: string;
  createdAt: string;
  coverageGrade: 'strong' | 'partial' | 'weak' | 'none';
  sourceIdsJson: string;
  staleSourceIdsJson: string;
  missingSourceClassesJson: string;
  providerParticipationJson: string;
  integrationProofJson: string;
  privacyJson: string;
}

export interface TruthVerdict {
  generatedAt: string;
  audit: TruthAnswerAudit;
  claims: TruthClaim[];
  evidenceSupports: TruthEvidenceSupport[];
  contradictionChecks: TruthContradictionCheck[];
  rewriteDirectives: TruthRewriteDirective[];
  sourceCoverage: TruthSourceCoverage;
  calibration: TruthCalibrationVerdict;
  rewrittenText: string;
  bestNextAction: string;
  summary: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface TruthEngineReport {
  generatedAt: string;
  ok: boolean;
  latestAudit?: TruthAnswerAudit | null;
  claims: TruthClaim[];
  evidenceSupports: TruthEvidenceSupport[];
  contradictionChecks: TruthContradictionCheck[];
  rewriteDirectives: TruthRewriteDirective[];
  sourceCoverage: TruthSourceCoverage[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type WorldModelDomain =
  | 'providers'
  | 'google_calendar'
  | 'telegram'
  | 'bluebubbles'
  | 'alexa'
  | 'research'
  | 'image_generation'
  | 'user_preferences'
  | 'active_projects'
  | 'skills'
  | 'logic'
  | 'truth'
  | 'agent_os'
  | 'cognition'
  | 'harness';

export type WorldModelFreshness = LogicEvidenceFreshness;

export interface WorldModelFreshnessPolicy {
  policyId: string;
  domain: WorldModelDomain;
  freshForHours: number;
  staleAfterHours: number;
  expiresAfterHours: number;
  manualProofRequired: boolean;
  nextAction: string;
}

export interface WorldModelEvidenceRef {
  evidenceRefId: string;
  snapshotId: string;
  createdAt: string;
  domain: WorldModelDomain;
  sourceKind:
    | 'logic_claim'
    | 'truth_audit'
    | 'agent_os_episode'
    | 'cognitive_trace'
    | 'provider_health'
    | 'integration_status'
    | 'memory_block'
    | 'skill_outcome'
    | 'harness_trajectory'
    | 'manual_metadata';
  sourceId: string;
  freshness: WorldModelFreshness;
  trust: 'high' | 'medium' | 'low' | 'blocked';
  summary: string;
  privacyJson: string;
}

export interface WorldModelClaim {
  claimId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  domain: WorldModelDomain;
  subject: string;
  claimKind:
    | 'current_truth'
    | 'proof_state'
    | 'provider_state'
    | 'integration_state'
    | 'skill_state'
    | 'belief_state'
    | 'risk_state'
    | 'next_action';
  status:
    | 'current'
    | 'stale'
    | 'conflicted'
    | 'proof_debt'
    | 'needs_confirmation'
    | 'blocked'
    | 'unknown';
  confidence: number;
  evidenceRefIdsJson: string;
  verificationNeedIdsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldModelVerificationNeed {
  needId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  domain: WorldModelDomain;
  status:
    | 'pending'
    | 'runnable_read_only'
    | 'manual_proof'
    | 'approval_required'
    | 'resolved'
    | 'skipped';
  actionKind: 'read_only_check' | 'manual_proof' | 'approval_stage';
  safeToRunAutomatically: boolean;
  command: string;
  blockerClass: string;
  evidenceRefIdsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldModelOpenQuestion {
  questionId: string;
  snapshotId: string;
  createdAt: string;
  domain: WorldModelDomain;
  status: 'open' | 'answered' | 'waived';
  question: string;
  requiredEvidenceJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldModelRiskState {
  riskId: string;
  snapshotId: string;
  createdAt: string;
  domain: WorldModelDomain;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'mitigated' | 'accepted';
  riskClass:
    | 'stale_proof'
    | 'provider_blocked'
    | 'integration_proof_debt'
    | 'unsupported_claim'
    | 'approval_boundary'
    | 'memory_conflict'
    | 'unknown';
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldModelSkillTrustState {
  skillTrustId: string;
  snapshotId: string;
  createdAt: string;
  skillId: string;
  taskFamily: string;
  status: 'trusted' | 'probation' | 'quarantined' | 'needs_proof';
  confidence: number;
  outcomeScore: number;
  sourceIdsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface WorldModelSnapshot {
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  status: 'stable' | 'degraded' | 'needs_verification' | 'conflicted';
  confidence: number;
  logicBeliefStateId?: string | null;
  truthAuditId?: string | null;
  agentOSEpisodeId?: string | null;
  cognitiveRunId?: string | null;
  freshnessPolicyJson: string;
  claimIdsJson: string;
  evidenceRefIdsJson: string;
  verificationNeedIdsJson: string;
  openQuestionIdsJson: string;
  riskStateIdsJson: string;
  skillTrustIdsJson: string;
  summary: string;
  bestNextAction: string;
  privacyJson: string;
}

export interface WorldModelDoctorReport {
  generatedAt: string;
  ok: boolean;
  snapshot: WorldModelSnapshot;
  claims: WorldModelClaim[];
  learnedFacts: WorldFactRecord[];
  evidenceRefs: WorldModelEvidenceRef[];
  verificationNeeds: WorldModelVerificationNeed[];
  openQuestions: WorldModelOpenQuestion[];
  riskStates: WorldModelRiskState[];
  skillTrust: WorldModelSkillTrustState[];
  freshness: Record<WorldModelFreshness, number>;
  proofDebt: {
    total: number;
    runnableReadOnly: number;
    manualProof: number;
    approvalRequired: number;
  };
  safeVerificationRan: boolean;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type AgentRuntimeSpineMode = 'off' | 'shadow' | 'assistive';

export type AgentRuntimeRunStatus =
  | 'active'
  | 'shadowed'
  | 'awaiting_approval'
  | 'interrupted'
  | 'completed'
  | 'blocked';

export interface AgentRuntimeRun {
  runtimeRunId: string;
  createdAt: string;
  updatedAt: string;
  mode: AgentRuntimeSpineMode;
  status: AgentRuntimeRunStatus;
  turnId?: string | null;
  channel?: string | null;
  groupFolder?: string | null;
  goalSummary: string;
  taskFamily: string;
  worldSnapshotId?: string | null;
  agentOSEpisodeId?: string | null;
  cognitiveRunId?: string | null;
  councilRunId?: string | null;
  logicBeliefStateId?: string | null;
  truthAuditId?: string | null;
  checkpointIdsJson: string;
  writeIdsJson: string;
  stepIdsJson: string;
  evidencePacketIdsJson: string;
  interruptIdsJson: string;
  guardrailResultIdsJson: string;
  outcomeJson: string;
  nextAction: string;
  privacyJson: string;
}

export type AgentRuntimeStepKind =
  | 'world_snapshot'
  | 'goal_plan'
  | 'supervisor'
  | 'guardrail'
  | 'checkpoint'
  | 'tool_step'
  | 'evidence'
  | 'logic'
  | 'truth'
  | 'answer'
  | 'approval'
  | 'outcome';

export interface AgentRuntimeStep {
  stepId: string;
  runtimeRunId: string;
  createdAt: string;
  position: number;
  stepKind: AgentRuntimeStepKind;
  layer:
    | 'runtime_spine'
    | 'supervisor'
    | 'world_model'
    | 'agent_os'
    | 'cognition'
    | 'council'
    | 'logic'
    | 'truth'
    | 'tool'
    | 'approval';
  status:
    | 'planned'
    | 'completed'
    | 'warn'
    | 'blocked'
    | 'approval_staged'
    | 'skipped';
  summary: string;
  refsJson: string;
  evidencePacketIdsJson: string;
  guardrailResultIdsJson: string;
  checkpointId?: string | null;
  writeId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface AgentRuntimeCheckpoint {
  checkpointId: string;
  runtimeRunId: string;
  threadId: string;
  checkpointNs: string;
  parentCheckpointId?: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'completed' | 'interrupted' | 'resumed';
  checkpointJson: string;
  metadataJson: string;
  pendingWriteIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentRuntimeWrite {
  writeId: string;
  checkpointId: string;
  runtimeRunId: string;
  taskId: string;
  idx: number;
  channel: string;
  writeType:
    | 'checkpoint'
    | 'evidence'
    | 'approval_packet'
    | 'resume_state'
    | 'outcome';
  status: 'pending' | 'applied' | 'skipped';
  valueSummaryJson: string;
  createdAt: string;
  appliedAt?: string | null;
  privacyJson: string;
}

export interface AgentRuntimeGuardrailResult {
  guardrailResultId: string;
  runtimeRunId: string;
  stepId?: string | null;
  createdAt: string;
  interventionPoint:
    | 'input'
    | 'pre_tool'
    | 'post_tool'
    | 'pre_model'
    | 'post_model'
    | 'output'
    | 'checkpoint';
  behavior:
    | 'allow'
    | 'reject_content'
    | 'throw_exception'
    | 'stage_approval'
    | 'transform';
  status: 'pass' | 'warn' | 'block' | 'approval_required' | 'transformed';
  decision: 'allow' | 'deny' | 'suspend' | 'transform';
  allowed: boolean;
  transformed: boolean;
  reason: string;
  message: string;
  riskFlagsJson: string;
  outputInfoJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgentRuntimeInterrupt {
  interruptId: string;
  runtimeRunId: string;
  checkpointId?: string | null;
  createdAt: string;
  updatedAt: string;
  interruptKind:
    | 'approval_required'
    | 'abort_reconciliation'
    | 'evidence_gap'
    | 'policy_blocked'
    | 'provider_blocked'
    | 'resume_requested';
  status: 'open' | 'resolved' | 'expired';
  payloadJson: string;
  resumeTokenId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface AgentRuntimeResumeToken {
  resumeTokenId: string;
  runtimeRunId: string;
  interruptId: string;
  checkpointId?: string | null;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'used' | 'expired' | 'revoked';
  continuationKey: string;
  safeStateJson: string;
  expiresAt?: string | null;
  usedAt?: string | null;
  privacyJson: string;
}

export interface AgentRuntimeEvent {
  eventId: string;
  runtimeRunId: string;
  createdAt: string;
  eventKind:
    | 'action'
    | 'observation'
    | 'handoff'
    | 'guardrail'
    | 'checkpoint'
    | 'write'
    | 'abort_reconciliation'
    | 'skill'
    | 'world'
    | 'truth'
    | 'logic'
    | 'outcome';
  severity: 'info' | 'warn' | 'block';
  summary: string;
  truncated: boolean;
  refsJson: string;
  privacyJson: string;
}

export interface AgentRuntimeEvidencePacket {
  evidencePacketId: string;
  runtimeRunId: string;
  createdAt: string;
  sourceLayer:
    | 'world_model'
    | 'agent_os'
    | 'supervisor'
    | 'cognition'
    | 'logic'
    | 'truth'
    | 'council'
    | 'tool';
  sourceId: string;
  evidenceIdsJson: string;
  supportGrade: 'strong' | 'partial' | 'weak' | 'none';
  freshness: LogicEvidenceFreshness;
  confidence: number;
  citationCoverage: number;
  contradictionTier:
    | 'curated_vs_curated'
    | 'curated_vs_bulk'
    | 'bulk_vs_bulk'
    | 'other';
  returnPolicyJson: string;
  summary: string;
  privacyJson: string;
}

export interface AgentRuntimeSkillManifest {
  manifestId: string;
  createdAt: string;
  updatedAt: string;
  skillId: string;
  sourceKind: 'project' | 'user' | 'runtime';
  precedence: number;
  status: 'candidate' | 'trusted' | 'probation' | 'quarantined';
  frontmatterJson: string;
  triggerJson: string;
  toolRefsJson: string;
  approvalRulesJson: string;
  evidenceNeedsJson: string;
  summary: string;
  privacyJson: string;
}

export interface AgentRuntimeSpineReport {
  generatedAt: string;
  ok: boolean;
  mode: AgentRuntimeSpineMode;
  latestRun?: AgentRuntimeRun | null;
  steps: AgentRuntimeStep[];
  checkpoints: AgentRuntimeCheckpoint[];
  writes: AgentRuntimeWrite[];
  guardrails: AgentRuntimeGuardrailResult[];
  interrupts: AgentRuntimeInterrupt[];
  resumeTokens: AgentRuntimeResumeToken[];
  events: AgentRuntimeEvent[];
  evidencePackets: AgentRuntimeEvidencePacket[];
  skillManifests: AgentRuntimeSkillManifest[];
  supervisorReport?: SupervisorDoctorReport | null;
  sourceRefs: string[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type SupervisorParticipantRole =
  | 'planner'
  | 'evidence_scout'
  | 'memory_curator'
  | 'tool_executor'
  | 'verifier'
  | 'truth_calibrator'
  | 'approval_stager'
  | 'final_arbiter';

export type SupervisorRunStatus =
  | 'active'
  | 'completed'
  | 'awaiting_approval'
  | 'blocked'
  | 'terminated'
  | 'shadowed';

export interface SupervisorRun {
  supervisorRunId: string;
  runtimeRunId: string;
  createdAt: string;
  updatedAt: string;
  status: SupervisorRunStatus;
  mode: AgentRuntimeSpineMode;
  goalSummary: string;
  activeParticipant: SupervisorParticipantRole;
  turnCount: number;
  readOnlyToolSteps: number;
  councilCalls: number;
  clarificationRequests: number;
  blackboardId: string;
  budgetId: string;
  terminationId?: string | null;
  participantIdsJson: string;
  agendaItemIdsJson: string;
  handoffIdsJson: string;
  decisionIdsJson: string;
  blackboardPatchIdsJson: string;
  replayPacketId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorParticipant {
  participantId: string;
  supervisorRunId: string;
  role: SupervisorParticipantRole;
  displayName: string;
  status: 'available' | 'active' | 'skipped' | 'blocked';
  instructionsSummary: string;
  toolPolicyJson: string;
  handoffTargetsJson: string;
  sourceRefsJson: string;
  privacyJson: string;
}

export interface SupervisorBlackboard {
  blackboardId: string;
  supervisorRunId: string;
  runtimeRunId: string;
  createdAt: string;
  updatedAt: string;
  status: 'open' | 'checkpointed' | 'closed';
  goalSummary: string;
  evidenceIdsJson: string;
  claimIdsJson: string;
  proofDebtJson: string;
  blockerJson: string;
  handoffStateJson: string;
  approvalStateJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorBlackboardPatch {
  patchId: string;
  blackboardId: string;
  supervisorRunId: string;
  createdAt: string;
  participantRole: SupervisorParticipantRole;
  patchKind:
    | 'goal'
    | 'evidence'
    | 'claim'
    | 'proof_debt'
    | 'tool_result'
    | 'handoff_state'
    | 'approval'
    | 'blocker'
    | 'next_action';
  summary: string;
  refsJson: string;
  patchJson: string;
  rejected: boolean;
  rejectionReason?: string | null;
  privacyJson: string;
}

export interface SupervisorAgendaItem {
  agendaItemId: string;
  supervisorRunId: string;
  createdAt: string;
  updatedAt: string;
  position: number;
  ownerRole: SupervisorParticipantRole;
  itemKind:
    | 'frame_goal'
    | 'gather_evidence'
    | 'compile_memory'
    | 'run_read_only_tool'
    | 'verify'
    | 'calibrate_truth'
    | 'stage_approval'
    | 'finalize';
  status:
    | 'planned'
    | 'running'
    | 'completed'
    | 'blocked'
    | 'approval_staged'
    | 'skipped';
  policyClass:
    | 'local_lookup'
    | 'read_only'
    | 'council'
    | 'approval_staged'
    | 'forbidden';
  requiredEvidenceJson: string;
  resultRefsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorHandoffMessage {
  handoffId: string;
  supervisorRunId: string;
  createdAt: string;
  fromRole: SupervisorParticipantRole;
  toRole: SupervisorParticipantRole;
  status: 'requested' | 'accepted' | 'completed' | 'blocked' | 'skipped';
  reason: string;
  payloadJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorDecision {
  decisionId: string;
  supervisorRunId: string;
  createdAt: string;
  participantRole: SupervisorParticipantRole;
  decisionKind:
    | 'route'
    | 'tool_policy'
    | 'handoff'
    | 'termination'
    | 'approval'
    | 'answer_shape';
  decision:
    | 'continue'
    | 'handoff'
    | 'run_read_only'
    | 'stage_approval'
    | 'ask_clarification'
    | 'finalize'
    | 'block';
  confidence: number;
  evidenceRefsJson: string;
  riskFlagsJson: string;
  reason: string;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorTerminationCondition {
  terminationId: string;
  supervisorRunId: string;
  createdAt: string;
  reason:
    | 'final_answer_ready'
    | 'approval_required'
    | 'evidence_gap'
    | 'max_turns'
    | 'policy_blocked'
    | 'shadow_mode';
  status: 'met' | 'not_met';
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorLoopState {
  loopStateId: string;
  supervisorRunId: string;
  createdAt: string;
  updatedAt: string;
  turnIndex: number;
  activeRole: SupervisorParticipantRole;
  nextRole?: SupervisorParticipantRole | null;
  maxTurns: number;
  completedAgendaIdsJson: string;
  pendingAgendaIdsJson: string;
  terminationId?: string | null;
  status: 'running' | 'terminated' | 'awaiting_approval' | 'blocked';
  privacyJson: string;
}

export interface SupervisorBudget {
  budgetId: string;
  supervisorRunId: string;
  createdAt: string;
  maxTurns: number;
  maxReadOnlyToolSteps: number;
  maxCouncilCalls: number;
  maxClarificationRequests: number;
  usedTurns: number;
  usedReadOnlyToolSteps: number;
  usedCouncilCalls: number;
  usedClarificationRequests: number;
  exhausted: boolean;
  nextAction: string;
  privacyJson: string;
}

export interface SupervisorReplayPacket {
  replayPacketId: string;
  supervisorRunId: string;
  runtimeRunId: string;
  createdAt: string;
  blackboardId: string;
  checkpointIdsJson: string;
  handoffIdsJson: string;
  decisionIdsJson: string;
  agendaItemIdsJson: string;
  terminationId?: string | null;
  summary: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface SupervisorDoctorReport {
  generatedAt: string;
  ok: boolean;
  latestRun?: SupervisorRun | null;
  participants: SupervisorParticipant[];
  blackboard?: SupervisorBlackboard | null;
  blackboardPatches: SupervisorBlackboardPatch[];
  agendaItems: SupervisorAgendaItem[];
  handoffs: SupervisorHandoffMessage[];
  decisions: SupervisorDecision[];
  terminations: SupervisorTerminationCondition[];
  loopStates: SupervisorLoopState[];
  budgets: SupervisorBudget[];
  replayPackets: SupervisorReplayPacket[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type SessionGraphNodeKind =
  | 'assistant_session'
  | 'agent_thread'
  | 'telegram_chat'
  | 'bluebubbles_thread'
  | 'alexa_session'
  | 'communication_thread'
  | 'life_thread'
  | 'companion_handoff'
  | 'runtime_backend_job'
  | 'cognitive_run'
  | 'cognitive_checkpoint'
  | 'cognitive_handoff'
  | 'agent_os_episode'
  | 'agent_os_step'
  | 'agent_os_handoff'
  | 'runtime_run'
  | 'runtime_checkpoint'
  | 'runtime_event'
  | 'supervisor_run'
  | 'supervisor_blackboard'
  | 'supervisor_handoff'
  | 'world_snapshot'
  | 'world_claim'
  | 'world_verification_need'
  | 'logic_belief'
  | 'logic_claim'
  | 'truth_audit'
  | 'proof_state'
  | 'operator_job';

export type SessionGraphEdgeKind =
  | 'explicit_id'
  | 'handoff'
  | 'resume_checkpoint'
  | 'same_channel_thread'
  | 'same_person_thread'
  | 'proof_dependency'
  | 'evidence_support'
  | 'approval_boundary'
  | 'semantic_candidate'
  | 'contains'
  | 'derived_from';

export type SessionGraphLinkDecisionStatus =
  | 'accepted'
  | 'review_needed'
  | 'rejected';

export type SessionGraphSuggestionKind =
  | 'resume'
  | 'verify'
  | 'ask_clarification'
  | 'complete_proof'
  | 'review_link'
  | 'inspect_status';

export interface SessionGraphSnapshot {
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  status: 'compiled' | 'partial' | 'empty';
  nodeCount: number;
  edgeCount: number;
  clusterCount: number;
  suggestionCount: number;
  sourceLedgerJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface SessionGraphNode {
  nodeId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  nodeKind: SessionGraphNodeKind;
  sourceKind: string;
  sourceId: string;
  groupFolder?: string | null;
  channel?: string | null;
  threadKey?: string | null;
  personKey?: string | null;
  status: string;
  confidence: number;
  summary: string;
  refsJson: string;
  evidenceIdsJson: string;
  privacyJson: string;
}

export interface SessionGraphEdge {
  edgeId: string;
  snapshotId: string;
  createdAt: string;
  edgeKind: SessionGraphEdgeKind;
  fromNodeId: string;
  toNodeId: string;
  confidence: number;
  status: SessionGraphLinkDecisionStatus;
  reason: string;
  evidenceIdsJson: string;
  reviewNeeded: boolean;
  privacyJson: string;
}

export interface SessionCluster {
  clusterId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'blocked' | 'stale' | 'review_needed' | 'quiet';
  currentTheme: string;
  nodeIdsJson: string;
  edgeIdsJson: string;
  linkedSurfacesJson: string;
  activeBlockersJson: string;
  staleProofJson: string;
  openApprovalsJson: string;
  lastMeaningfulActivityAt?: string | null;
  evidenceIdsJson: string;
  bestNextAction: string;
  privacyJson: string;
}

export interface SessionContinuityThread {
  continuityThreadId: string;
  snapshotId: string;
  clusterId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  status: 'active' | 'needs_review' | 'stale' | 'resolved';
  nodeIdsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface SessionGraphSuggestion {
  suggestionId: string;
  snapshotId: string;
  clusterId?: string | null;
  createdAt: string;
  suggestionKind: SessionGraphSuggestionKind;
  priority: number;
  status: 'open' | 'review_needed' | 'dismissed' | 'resolved';
  summary: string;
  nextAction: string;
  sourceNodeIdsJson: string;
  evidenceIdsJson: string;
  approvalRequired: boolean;
  privacyJson: string;
}

export interface SessionGraphLinkDecision {
  decisionId: string;
  snapshotId: string;
  createdAt: string;
  edgeId: string;
  decisionStatus: SessionGraphLinkDecisionStatus;
  confidence: number;
  reason: string;
  sourceNodeIdsJson: string;
  privacyJson: string;
}

export type SessionContinuityActionKind =
  | 'resume_checkpoint'
  | 'review_approval'
  | 'complete_manual_proof'
  | 'run_safe_verification'
  | 'review_candidate_link'
  | 'inspect_cluster';

export interface SessionContinuityFocus {
  focusId: string;
  clusterId: string;
  status: SessionCluster['status'];
  priority: number;
  title: string;
  linkedSurfaces: string[];
  blockers: string[];
  staleProof: string[];
  approvals: string[];
  lastMeaningfulActivityAt?: string | null;
  bestNextAction: string;
  evidenceIds: string[];
}

export interface SessionContinuityActionItem {
  actionId: string;
  kind: SessionContinuityActionKind;
  priority: number;
  status: 'ready' | 'needs_manual' | 'review_needed' | 'blocked_by_approval';
  summary: string;
  nextAction: string;
  clusterId?: string | null;
  sourceSuggestionIds: string[];
  sourceNodeIds: string[];
  evidenceIds: string[];
  approvalRequired: boolean;
}

export interface SessionContinuityCockpit {
  generatedAt: string;
  status: 'ready' | 'empty' | 'needs_review';
  focusCount: number;
  actionCount: number;
  focuses: SessionContinuityFocus[];
  actionQueue: SessionContinuityActionItem[];
  staleProof: SessionContinuityActionItem[];
  approvalQueue: SessionContinuityActionItem[];
  reviewQueue: SessionContinuityActionItem[];
  proofDebt: {
    total: number;
    stale: number;
    manualProof: number;
    safeReadOnly: number;
  };
  reviewNeededCount: number;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface SessionGraphDoctorReport {
  generatedAt: string;
  ok: boolean;
  snapshot: SessionGraphSnapshot;
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
  clusters: SessionCluster[];
  continuityThreads: SessionContinuityThread[];
  linkDecisions: SessionGraphLinkDecision[];
  suggestions: SessionGraphSuggestion[];
  proofDebt: {
    total: number;
    stale: number;
    manualProof: number;
    safeReadOnly: number;
  };
  cockpit: SessionContinuityCockpit;
  reviewNeededCount: number;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type AgencyConvergenceMode = AgentRuntimeSpineMode;

export type AgencyConvergenceRunStatus =
  | 'running'
  | 'completed'
  | 'awaiting_approval'
  | 'manual_proof_required'
  | 'blocked'
  | 'shadowed';

export interface AgencyConvergenceRun {
  convergenceRunId: string;
  createdAt: string;
  updatedAt: string;
  mode: AgencyConvergenceMode;
  status: AgencyConvergenceRunStatus;
  selectedActionId?: string | null;
  selectedActionKind?: SessionContinuityActionKind | null;
  sessionSnapshotId?: string | null;
  refreshedSessionSnapshotId?: string | null;
  worldSnapshotId?: string | null;
  runtimeRunId?: string | null;
  supervisorRunId?: string | null;
  cognitiveRunId?: string | null;
  logicBeliefStateId?: string | null;
  truthAuditId?: string | null;
  harnessTrajectoryId?: string | null;
  sourceIdsJson: string;
  evidenceIdsJson: string;
  outcomeJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyConvergenceAgenda {
  agendaId: string;
  convergenceRunId: string;
  createdAt: string;
  status:
    | 'ready'
    | 'executed'
    | 'manual_required'
    | 'approval_required'
    | 'skipped';
  policyClass:
    | 'read_only'
    | 'approval_staged'
    | 'manual_proof'
    | 'inspect_only';
  selectedActionId?: string | null;
  actionKind?: SessionContinuityActionKind | null;
  priority: number;
  actionSummary: string;
  evidenceIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyConvergenceDecision {
  decisionId: string;
  convergenceRunId: string;
  createdAt: string;
  decisionKind:
    | 'execute_read_only'
    | 'stage_approval'
    | 'manual_proof'
    | 'resume_checkpoint'
    | 'inspect_only'
    | 'skip';
  status: 'pass' | 'warn' | 'block' | 'approval_required' | 'manual_required';
  reason: string;
  evidenceIdsJson: string;
  riskFlagsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyResumePlan {
  resumePlanId: string;
  convergenceRunId: string;
  createdAt: string;
  status: 'available' | 'not_needed' | 'approval_required' | 'blocked';
  runtimeRunId?: string | null;
  checkpointId?: string | null;
  resumeTokenId?: string | null;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyProviderParticipationPlan {
  participationPlanId: string;
  convergenceRunId: string;
  createdAt: string;
  status: 'healthy' | 'degraded' | 'blocked';
  healthyProviderIdsJson: string;
  blockedProviderIdsJson: string;
  skippedProviderIdsJson: string;
  cooldownProviderIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyLoopOutcome {
  outcomeId: string;
  convergenceRunId: string;
  createdAt: string;
  status:
    | 'completed'
    | 'manual_required'
    | 'approval_required'
    | 'blocked'
    | 'shadowed';
  runtimeRunId?: string | null;
  truthAuditId?: string | null;
  refreshedSessionSnapshotId?: string | null;
  outcomeScore: number;
  flagsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgencyConvergenceDoctorReport {
  generatedAt: string;
  ok: boolean;
  latestRun?: AgencyConvergenceRun | null;
  agendas: AgencyConvergenceAgenda[];
  decisions: AgencyConvergenceDecision[];
  resumePlans: AgencyResumePlan[];
  providerPlans: AgencyProviderParticipationPlan[];
  outcomes: AgencyLoopOutcome[];
  sessionGraph: SessionGraphDoctorReport;
  runtimeReport?: AgentRuntimeSpineReport | null;
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type CognitiveWorkspaceStatus =
  | 'ready'
  | 'needs_verification'
  | 'approval_required'
  | 'blocked'
  | 'shadow';

export type CognitiveWorkspaceContextBlockKind =
  | 'session_continuity'
  | 'world_model'
  | 'logic_belief'
  | 'truth_support'
  | 'runtime_spine'
  | 'supervisor_blackboard'
  | 'agent_os'
  | 'provider_plan'
  | 'integration_proof'
  | 'memory_skill'
  | 'harness_trajectory'
  | 'operating_rule';

export interface CognitiveGoalStack {
  goalStackId: string;
  createdAt: string;
  rootGoal: string;
  activeGoal: string;
  taskFamily: string;
  selectedActionId?: string | null;
  selectedActionKind?: SessionContinuityActionKind | null;
  priority: number;
  safeActionOnly: boolean;
  approvalRequired: boolean;
  evidenceIdsJson: string;
  blockersJson: string;
  nextAction: string;
}

export interface CognitiveContextBudget {
  budgetId: string;
  packetId: string;
  createdAt: string;
  maxBlocks: number;
  includedBlocks: number;
  withheldBlocks: number;
  freshnessFloor: LogicEvidenceFreshness;
  privacyPolicy: 'metadata_only';
  reason: string;
}

export interface CognitiveWorkspacePacket {
  packetId: string;
  createdAt: string;
  updatedAt: string;
  status: CognitiveWorkspaceStatus;
  goalStackJson: string;
  contextBudgetJson: string;
  sessionSnapshotId?: string | null;
  sessionClusterId?: string | null;
  convergenceRunId?: string | null;
  worldSnapshotId?: string | null;
  runtimeRunId?: string | null;
  supervisorRunId?: string | null;
  agentOSEpisodeId?: string | null;
  cognitiveRunId?: string | null;
  logicBeliefStateId?: string | null;
  truthAuditId?: string | null;
  councilRunId?: string | null;
  providerPlanId?: string | null;
  selectedProgramId?: string | null;
  contextBlockIdsJson: string;
  evidenceIdsJson: string;
  approvalBlockersJson: string;
  checkpointIdsJson: string;
  optimizationScorecardId?: string | null;
  nextSafeAction: string;
  privacyJson: string;
}

export interface CognitiveWorkspaceContextBlock {
  blockId: string;
  packetId: string;
  createdAt: string;
  blockKind: CognitiveWorkspaceContextBlockKind;
  sourceId: string;
  sourceIdsJson: string;
  freshness: LogicEvidenceFreshness;
  sensitivity: 'public' | 'internal' | 'private_digest' | 'secret_excluded';
  confidence: number;
  priority: number;
  tokenBudget: number;
  included: boolean;
  summary: string;
  evidenceIdsJson: string;
  conflictsJson: string;
  withheldReason?: string | null;
  privacyJson: string;
}

export interface CognitiveProgramManifest {
  programId: string;
  createdAt: string;
  updatedAt: string;
  status: 'candidate' | 'shadow' | 'trusted' | 'probation' | 'quarantined';
  taskFamily: string;
  triggerSummary: string;
  programSummary: string;
  sourceTrajectoryIdsJson: string;
  requiredEvidenceJson: string;
  allowedToolsJson: string;
  approvalRulesJson: string;
  verifierChecksJson: string;
  failureModesJson: string;
  outcomeScore: number;
  promotionReason: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveProgramRun {
  programRunId: string;
  packetId: string;
  programId: string;
  createdAt: string;
  status: 'selected' | 'shadowed' | 'blocked' | 'completed';
  selected: boolean;
  evidenceIdsJson: string;
  policyResultJson: string;
  outcomeScore: number;
  nextAction: string;
  privacyJson: string;
}

export interface CognitivePolicyVariant {
  variantId: string;
  createdAt: string;
  status: 'candidate' | 'shadow' | 'accepted' | 'rejected';
  variantKind:
    | 'route_policy'
    | 'context_budget'
    | 'program_manifest'
    | 'guardrail_policy'
    | 'eval_template';
  summary: string;
  changedKnobsJson: string;
  safetyBaselineJson: string;
  sourceRefsJson: string;
  privacyJson: string;
}

export interface CognitiveOptimizationScorecard {
  scorecardId: string;
  packetId?: string | null;
  proposalId?: string | null;
  variantId?: string | null;
  createdAt: string;
  status: 'pass' | 'warn' | 'fail';
  contextScore: number;
  programScore: number;
  policySafetyScore: number;
  evidenceScore: number;
  truthScore: number;
  privacyScore: number;
  totalScore: number;
  failureFlagsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveImprovementProposal {
  improvementProposalId: string;
  createdAt: string;
  updatedAt: string;
  status: 'candidate' | 'accepted' | 'rejected' | 'quarantined';
  proposalKind:
    | 'program'
    | 'policy_variant'
    | 'context_budget'
    | 'test_addition';
  sourcePacketId?: string | null;
  sourceScorecardId?: string | null;
  summary: string;
  expectedScoreDelta: number;
  safetyRegression: boolean;
  changedArtifactsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveWorkspaceDoctorReport {
  generatedAt: string;
  ok: boolean;
  packet?: CognitiveWorkspacePacket | null;
  contextBlocks: CognitiveWorkspaceContextBlock[];
  programManifests: CognitiveProgramManifest[];
  programRuns: CognitiveProgramRun[];
  policyVariants: CognitivePolicyVariant[];
  optimizationScorecards: CognitiveOptimizationScorecard[];
  improvementProposals: CognitiveImprovementProposal[];
  goalStack?: CognitiveGoalStack | null;
  contextBudget?: CognitiveContextBudget | null;
  sourceRefs: string[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type CognitiveExecutiveChannel = 'telegram' | 'alexa' | 'bluebubbles';

export type CognitiveExecutiveIntentFamily =
  | 'next_action'
  | 'loose_ends'
  | 'plan_tonight'
  | 'open_loops'
  | 'reply_help'
  | 'save_for_later'
  | 'list_status'
  | 'ambiguous_action'
  | 'explain_choice'
  | 'other';

export type CognitiveExecutiveRouteClass =
  | 'direct_answer'
  | 'daily_companion'
  | 'chief_of_staff'
  | 'missions'
  | 'communication_companion'
  | 'everyday_capture'
  | 'knowledge_library'
  | 'research'
  | 'message_actions'
  | 'work_cockpit'
  | 'telegram_handoff'
  | 'clarify'
  | 'unsupported';

export type CognitiveExecutiveToolId =
  | 'local_direct_answer'
  | 'calendar'
  | 'reminders'
  | 'everyday_capture'
  | 'communication_companion'
  | 'life_threads'
  | 'missions'
  | 'action_bundles'
  | 'knowledge_library'
  | 'research'
  | 'message_actions'
  | 'work_cockpit'
  | 'telegram_handoff'
  | 'clarifying_question';

export type MemoryItemKind =
  | 'user_ask'
  | 'fact'
  | 'proof'
  | 'goal'
  | 'plan'
  | 'message_context'
  | 'tool_state'
  | 'uncertainty'
  | 'correction'
  | 'outcome';

export type ReasoningMode =
  | 'fast_direct'
  | 'clarify_first'
  | 'retrieve_grounded'
  | 'plan_stepwise'
  | 'compare_counterfactuals'
  | 'verify_then_act'
  | 'deliberate_with_critic'
  | 'defer_or_handoff';

export type ConfidenceCalibrationLabel = 'high' | 'medium' | 'low' | 'blocked';

export interface WorkingMemoryFrame {
  frameId: string;
  createdAt: string;
  updatedAt: string;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  groupFolder?: string | null;
  chatJid?: string | null;
  threadId?: string | null;
  requestSummary: string;
  currentAskSummary: string;
  activeGoalId?: string | null;
  activeObjectSummary: string;
  itemIdsJson: string;
  selectedItemIdsJson: string;
  ignoredItemIdsJson: string;
  recommendedReasoningMode: ReasoningMode;
  confidence: number;
  expiresAt: string;
  staleAfter: string;
  privacyJson: string;
}

export interface MemoryItem {
  itemId: string;
  frameId: string;
  createdAt: string;
  itemKind: MemoryItemKind;
  summary: string;
  relevance: number;
  freshness: LogicEvidenceFreshness;
  confidence: number;
  source: string;
  sourceId?: string | null;
  sensitivity: RealitySensitivity;
  includeInUserAnswer: boolean;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface AttentionFocus {
  focusId: string;
  frameId: string;
  createdAt: string;
  primaryFocus: string;
  secondaryFocus?: string | null;
  ignoredContextJson: string;
  reason: string;
  expectedNextStep: string;
  privacyJson: string;
}

export interface GlobalWorkspaceSnapshot {
  workspaceId: string;
  frameId: string;
  createdAt: string;
  requestSummary: string;
  activeGoalId?: string | null;
  selectedItemIdsJson: string;
  routeCandidatesJson: string;
  uncertaintyJson: string;
  proofStateJson: string;
  toolAvailabilityJson: string;
  safetyConcernsJson: string;
  selectedReasoningMode: ReasoningMode;
  recommendedNextAction: string;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface MetacognitiveWarning {
  warningKind:
    | 'overconfidence'
    | 'insufficient_evidence'
    | 'stale_context'
    | 'conflicting_context'
    | 'repeated_fallback'
    | 'tool_unavailable'
    | 'user_uncertainty_check'
    | 'high_risk_action'
    | 'ambiguous_reference';
  severity: 'low' | 'medium' | 'high';
  summary: string;
  nextAction: string;
}

export interface ReasoningModeDecision {
  decisionId: string;
  frameId: string;
  createdAt: string;
  mode: ReasoningMode;
  modeReason: string;
  requiredContextJson: string;
  allowedToolsJson: string;
  approvalRequirement: GoalApprovalBoundary;
  outputShape:
    | 'direct'
    | 'one_question'
    | 'short_plan'
    | 'verified_answer'
    | 'handoff';
  failureMode: string;
  confidence: number;
  warningsJson: string;
  privacyJson: string;
}

export interface ConfidenceCalibration {
  calibrationId: string;
  frameId: string;
  createdAt: string;
  label: ConfidenceCalibrationLabel;
  score: number;
  proofFreshnessScore: number;
  toolReliabilityScore: number;
  realityConfidenceScore: number;
  missingInfoPenalty: number;
  contradictionPenalty: number;
  routeHistoryScore: number;
  skillReliabilityScore: number;
  correctionPenalty: number;
  reason: string;
  whatWouldIncreaseConfidence: string;
  actionAllowed:
    | 'answer'
    | 'clarify'
    | 'verify_first'
    | 'approval_only'
    | 'blocked';
  privacyJson: string;
}

export interface DeliberationRecord {
  deliberationId: string;
  frameId: string;
  createdAt: string;
  status: 'not_needed' | 'completed' | 'blocked';
  trigger: string;
  candidateRoutesJson: string;
  criticObjectionsJson: string;
  finalRecommendation: string;
  fallback: string;
  approvalRequired: boolean;
  hiddenReasoningStored: boolean;
  privacyJson: string;
}

export interface StrategyLearningSignal {
  signalId: string;
  frameId: string;
  createdAt: string;
  requestFamily:
    | CognitiveExecutiveIntentFamily
    | 'goal_planner'
    | 'status'
    | 'other';
  selectedMode: ReasoningMode;
  routeKey?: string | null;
  toolId?: CognitiveExecutiveToolId | string | null;
  confidence: number;
  warningKindsJson: string;
  userResponse:
    | 'accepted'
    | 'corrected'
    | 'ignored'
    | 'asked_for_more_reasoning'
    | 'asked_for_less_detail'
    | 'unknown';
  outcome: 'success' | 'warn' | 'fail' | 'deferred' | 'unknown';
  fallbackUsed: boolean;
  strategyAdjustment: string;
  improvementHint: string;
  privacyJson: string;
}

export interface MetacognitionDoctorReport {
  generatedAt: string;
  ok: boolean;
  latestFrame?: WorkingMemoryFrame | null;
  focus?: AttentionFocus | null;
  workspace?: GlobalWorkspaceSnapshot | null;
  decision?: ReasoningModeDecision | null;
  calibration?: ConfidenceCalibration | null;
  deliberation?: DeliberationRecord | null;
  strategySignals: StrategyLearningSignal[];
  warnings: MetacognitiveWarning[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface CognitiveRequest {
  requestId: string;
  createdAt: string;
  rawAsk: string;
  normalizedAsk: string;
  channel: CognitiveExecutiveChannel;
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  actorId?: string | null;
  activeContextSummary?: string | null;
  intentFamily: CognitiveExecutiveIntentFamily;
  confidence: number;
}

export interface CognitiveWorldSnapshotItem {
  itemId: string;
  itemKind:
    | 'calendar_pressure'
    | 'reminder'
    | 'life_thread'
    | 'communication_thread'
    | 'mission'
    | 'action_bundle'
    | 'list_item'
    | 'knowledge_source'
    | 'selected_work'
    | 'outcome'
    | 'integration'
    | 'message_action'
    | 'world_fact'
    | 'skill_playbook'
    | 'learning_candidate';
  sourceId: string;
  sourceIdsJson: string;
  summary: string;
  freshness: LogicEvidenceFreshness;
  confidence: number;
  priority: number;
  reasonUsed: string;
  reasonOmitted?: string | null;
}

export interface CognitiveWorldSnapshot {
  snapshotId: string;
  createdAt: string;
  groupFolder: string;
  status: 'ready' | 'needs_verification' | 'degraded' | 'empty';
  currentFocus: string;
  itemsJson: string;
  usedItemIdsJson: string;
  omittedItemIdsJson: string;
  degradedToolsJson: string;
  evidenceIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveState {
  stateId: string;
  createdAt: string;
  currentFocus: string;
  activePerson?: string | null;
  activeThreadId?: string | null;
  activeMissionId?: string | null;
  activeListId?: string | null;
  activeMessageActionId?: string | null;
  activeWorkItem?: string | null;
  relevantOpenLoopsJson: string;
  relevantDeadlinesJson: string;
  availableToolsJson: string;
  degradedToolsJson: string;
  recentOutcomesJson: string;
  snapshotId?: string | null;
}

export interface CognitivePlanStep {
  stepId: string;
  order: number;
  label: string;
  toolId: CognitiveExecutiveToolId;
  policyClass: 'read_only' | 'approval_required' | 'manual_proof' | 'clarify';
  expectedOutput: string;
}

export interface CognitivePlan {
  planId: string;
  createdAt: string;
  selectedRoute: CognitiveExecutiveRouteClass;
  routeKey: string;
  capabilityId?: string | null;
  confidence: number;
  stepsJson: string;
  involvedToolsJson: string;
  approvalRequired: boolean;
  fallbackRoute?: string | null;
  explanation: string;
  usedContextJson: string;
  ignoredContextJson: string;
}

export interface CognitiveResult {
  resultId: string;
  createdAt: string;
  status:
    | 'planned'
    | 'handled'
    | 'clarified'
    | 'approval_staged'
    | 'failed'
    | 'deferred';
  doneSummary: string;
  failureSummary?: string | null;
  changedSummary?: string | null;
  openSummary?: string | null;
  rememberSummary?: string | null;
  reviewLaterSummary?: string | null;
  nextSuggestion: string;
}

export interface CognitiveExplanation {
  explanationId: string;
  runId: string;
  createdAt: string;
  routeChosen: string;
  contextUsedJson: string;
  contextIgnoredJson: string;
  approvalReason?: string | null;
  degradedToolReason?: string | null;
  fallbackReason?: string | null;
  nextSafeAction: string;
  privacyJson: string;
}

export interface CognitiveExecutiveRunRecord {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: CognitiveResult['status'];
  channel: CognitiveExecutiveChannel;
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  actorId?: string | null;
  intentFamily: CognitiveExecutiveIntentFamily;
  confidence: number;
  routeClass: CognitiveExecutiveRouteClass;
  routeKey: string;
  capabilityId?: string | null;
  approvalRequired: boolean;
  requestSummary: string;
  stateSummary: string;
  planSummary: string;
  resultSummary: string;
  explanationJson: string;
  usedContextJson: string;
  ignoredContextJson: string;
  degradedToolsJson: string;
  evidenceIdsJson: string;
  snapshotId?: string | null;
  outcomeSignalId?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveExecutiveToolChoice {
  choiceId: string;
  runId: string;
  createdAt: string;
  toolId: CognitiveExecutiveToolId;
  capabilityId?: string | null;
  selected: boolean;
  status:
    | 'available'
    | 'degraded'
    | 'blocked'
    | 'approval_required'
    | 'not_relevant';
  confidence: number;
  approvalRequired: boolean;
  reason: string;
  fallbackToolId?: CognitiveExecutiveToolId | null;
  riskFlagsJson: string;
  privacyJson: string;
}

export interface CognitiveReflectionSignal {
  signalId: string;
  runId: string;
  createdAt: string;
  routeKey: string;
  capabilityId?: string | null;
  signalKind:
    | 'route_chosen'
    | 'answer_sent'
    | 'action_succeeded'
    | 'action_failed'
    | 'action_deferred'
    | 'approval_staged'
    | 'fallback_used'
    | 'user_corrected'
    | 'user_accepted'
    | 'ignored';
  outcome: 'success' | 'warn' | 'fail' | 'deferred' | 'unknown';
  routeConfidence: number;
  fallbackUsed: boolean;
  userResponse?: 'accepted' | 'corrected' | 'ignored' | 'unknown' | null;
  frictionKey?: string | null;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface CognitiveExecutiveDoctorReport {
  generatedAt: string;
  ok: boolean;
  latestRun?: CognitiveExecutiveRunRecord | null;
  latestSnapshot?: CognitiveWorldSnapshot | null;
  toolChoices: CognitiveExecutiveToolChoice[];
  reflectionSignals: CognitiveReflectionSignal[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type ToolReliabilitySubjectKind =
  | 'capability'
  | 'route'
  | 'cognitive_tool'
  | 'agent_os_card'
  | 'provider'
  | 'integration';

export type ToolReliabilityRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ToolReliabilityApprovalRequirement =
  | 'none'
  | 'confirmation'
  | 'main_control'
  | 'manual_external';

export interface ToolReliabilitySubject {
  subjectId: string;
  subjectKind: ToolReliabilitySubjectKind;
  displayName: string;
  aliasesJson: string;
  riskLevel: ToolReliabilityRiskLevel;
  approvalRequirement: ToolReliabilityApprovalRequirement;
  channelsJson: string;
  sourceRefsJson: string;
  privacyJson: string;
}

export interface ToolDependencyLink {
  linkId: string;
  subjectId: string;
  dependencySubjectId: string;
  dependencyKind: 'provider' | 'integration' | 'route' | 'tool' | 'fallback';
  reason: string;
  fallbackSubjectId?: string | null;
  privacyJson: string;
}

export interface ReliabilityObservation {
  observationId: string;
  subjectId: string;
  observedAt: string;
  sourceKind:
    | 'provider_health'
    | 'integration_doctor'
    | 'executive_reflection'
    | 'council'
    | 'response_feedback'
    | 'message_action'
    | 'repair'
    | 'simulation';
  outcome:
    | 'success'
    | 'degraded'
    | 'blocked'
    | 'failed'
    | 'fallback'
    | 'unknown';
  failureClass: string;
  confidence: number;
  fallbackUsed: boolean;
  latencyMs?: number | null;
  summary: string;
  nextAction: string;
  evidenceIdsJson: string;
  privacyJson: string;
}

export interface ToolReliabilityRollup {
  subjectId: string;
  updatedAt: string;
  sampleCount: number;
  successRate: number;
  degradedRate: number;
  blockedRate: number;
  fallbackRate: number;
  reliabilityScore: number;
  currentHealth: 'healthy' | 'degraded' | 'blocked' | 'unknown';
  confidenceCap: number;
  cooldownUntil?: string | null;
  nextAction: string;
  privacyJson: string;
}

export interface RouteConfidenceRollup {
  routeKey: string;
  channel: CognitiveExecutiveChannel | 'operator' | 'cross_channel';
  updatedAt: string;
  attempts: number;
  averagePredictedConfidence: number;
  empiricalSuccessRate: number;
  calibrationGap: number;
  correctionRate: number;
  recommendedConfidenceCap: number;
  recommendedFallback?: string | null;
  privacyJson: string;
}

export interface ToolReliabilityDoctorReport {
  generatedAt: string;
  subjects: ToolReliabilitySubject[];
  rollups: ToolReliabilityRollup[];
  routeRollups: RouteConfidenceRollup[];
  topDegraded: ToolReliabilityRollup[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type RepairPlaybookId =
  | 'bluebubbles_refresh_all'
  | 'alexa_ingress_probe'
  | 'google_calendar_auth_check'
  | 'provider_quota_cooldown_record'
  | 'assistant_session_clear_once'
  | 'work_cockpit_reconcile_selection'
  | 'scheduled_action_failure_review'
  | 'webhook_registration_check';

export interface RepairAttemptRecord {
  attemptId: string;
  playbookId: RepairPlaybookId;
  integrationId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'planned'
    | 'skipped'
    | 'succeeded'
    | 'failed'
    | 'blocked'
    | 'cooldown';
  failureClass: string;
  safeToApply: boolean;
  dryRun: boolean;
  validationStatus: 'not_run' | 'passed' | 'failed' | 'manual_required';
  rollbackStatus: 'not_needed' | 'not_run' | 'succeeded' | 'failed';
  summary: string;
  nextAction: string;
  cooldownUntil?: string | null;
  evidenceIdsJson: string;
  privacyJson: string;
}

export interface RepairCooldownRecord {
  cooldownId: string;
  targetId: string;
  playbookId: RepairPlaybookId;
  failureClass: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
  nextAction: string;
  privacyJson: string;
}

export interface RepairDoctorReport {
  generatedAt: string;
  attempts: RepairAttemptRecord[];
  cooldowns: RepairCooldownRecord[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface CriticReviewRecord {
  reviewId: string;
  createdAt: string;
  actor: string;
  action: string;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  decision: 'proceed' | 'clarify' | 'stage_approval' | 'block';
  approvalRequired: boolean;
  riskFlagsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface AgenticEvalScenarioResult {
  resultId: string;
  scenarioId: string;
  createdAt: string;
  status: 'passed' | 'failed';
  routeScore: number;
  toolScore: number;
  repairScore: number;
  safetyScore: number;
  reflectionScore: number;
  answerScore: number;
  failuresJson: string;
  summary: string;
  privacyJson: string;
}

export interface HarnessEvalTask {
  taskId: string;
  createdAt: string;
  taskFamily:
    | 'planning'
    | 'memory'
    | 'bluebubbles_draft'
    | 'calendar'
    | 'research'
    | 'provider_degradation'
    | 'operator_diagnostics'
    | 'interruption_resume'
    | 'truth';
  promptSummary: string;
  expectedEvidenceJson: string;
  safetyInvariantJson: string;
  sourcePatternRefsJson: string;
  privacyJson: string;
}

export interface HarnessTrajectory {
  trajectoryId: string;
  taskId: string;
  createdAt: string;
  status: 'pass' | 'warn' | 'fail';
  planId?: string | null;
  replayId?: string | null;
  beliefRevisionIdsJson: string;
  toolCallSummaryJson: string;
  guardrailDecisionIdsJson: string;
  evidenceIdsJson: string;
  outcomeJson: string;
  nextRepairAction: string;
  privacyJson: string;
}

export interface HarnessVariant {
  variantId: string;
  createdAt: string;
  taskFamily: HarnessEvalTask['taskFamily'];
  policySummary: string;
  changedKnobsJson: string;
  safetyBaselineJson: string;
  privacyJson: string;
}

export interface HarnessScorecard {
  scorecardId: string;
  trajectoryId: string;
  variantId?: string | null;
  createdAt: string;
  status: 'pass' | 'warn' | 'fail';
  planningScore: number;
  memoryScore: number;
  toolSafetyScore: number;
  evidenceScore: number;
  beliefScore: number;
  outcomeScore: number;
  privacyScore: number;
  claimSupportScore?: number;
  contradictionHandlingScore?: number;
  staleEvidenceHandlingScore?: number;
  calibrationScore?: number;
  clarificationQualityScore?: number;
  approvalIntegrityScore?: number;
  totalScore: number;
  failureFlagsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface HarnessImprovementProposal {
  proposalId: string;
  createdAt: string;
  status: 'candidate' | 'accepted' | 'rejected';
  taskFamily: HarnessEvalTask['taskFamily'];
  proposalKind:
    | 'skill_card'
    | 'policy_change'
    | 'prompt_control'
    | 'test_addition';
  summary: string;
  expectedScoreDelta: number;
  safetyRegression: boolean;
  sourceTrajectoryIdsJson: string;
  changedArtifactsJson: string;
  nextAction: string;
  privacyJson: string;
}

export type ImprovementHypothesisStatus =
  | 'proposed'
  | 'simulated'
  | 'patch_planned'
  | 'validated'
  | 'blocked'
  | 'rejected'
  | 'archived';

export type ImprovementRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ImprovementSourceSignalKind =
  | 'pilot_proof_gap'
  | 'repair_attempt'
  | 'tool_reliability'
  | 'executive_reflection'
  | 'learning_distillation'
  | 'skill_run'
  | 'harness_proposal'
  | 'response_feedback'
  | 'message_action'
  | 'task_failure';

export type ImprovementFixClass =
  | 'external_manual_proof'
  | 'external_config'
  | 'diagnostic_observation'
  | 'repair_playbook'
  | 'route_calibration'
  | 'skill_adjustment'
  | 'eval_gap'
  | 'debug_wording'
  | 'docs_or_test'
  | 'unsafe_or_requires_approval';

export interface ImprovementHypothesis {
  hypothesisId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  sourceSignalKind: ImprovementSourceSignalKind;
  sourceSignalIdsJson: string;
  affectedCapability: string;
  expectedBenefit: string;
  riskLevel: ImprovementRiskLevel;
  confidence: number;
  priorityScore: number;
  proposedTest: string;
  status: ImprovementHypothesisStatus;
  fixClass: ImprovementFixClass;
  externalBlocker: boolean;
  safetyNotes: string;
  nextAction: string;
  privacyJson: string;
}

export interface ImprovementExperiment {
  experimentId: string;
  hypothesisId: string;
  createdAt: string;
  updatedAt: string;
  scenarioIdsJson: string;
  baselineScore: number;
  candidateScore: number;
  safetyResult: 'pass' | 'warn' | 'fail' | 'not_run';
  decision:
    | 'do_not_patch'
    | 'prepare_patch_plan'
    | 'needs_approval'
    | 'validated'
    | 'failed';
  summary: string;
  privacyJson: string;
}

export interface CandidatePatchPlan {
  patchPlanId: string;
  hypothesisId: string;
  createdAt: string;
  updatedAt: string;
  filesLikelyAffectedJson: string;
  changeIntent: string;
  testPlanJson: string;
  rollbackPlan: string;
  approvalRequirement:
    | 'none'
    | 'explicit_approval'
    | 'main_control'
    | 'manual_external';
  riskLevel: ImprovementRiskLevel;
  status: 'planned' | 'approved' | 'rejected' | 'implemented' | 'archived';
  privacyJson: string;
}

export interface ImprovementOutcome {
  outcomeId: string;
  hypothesisId: string;
  createdAt: string;
  result: 'improved' | 'regressed' | 'neutral' | 'blocked' | 'not_applied';
  improvedSummary: string;
  regressedSummary: string;
  nextAction: string;
  learnedLesson: string;
  privacyJson: string;
}

export type ShadowImprovementRunStatus =
  | 'baseline_only'
  | 'compared'
  | 'blocked'
  | 'inconclusive';

export type ShadowCandidateDecision =
  | 'selected'
  | 'external_blocker'
  | 'requires_approval'
  | 'rejected';

export type SyntheticGauntletPhase = 'baseline' | 'candidate_plan';

export interface ShadowImprovementRun {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: ShadowImprovementRunStatus;
  policyJson: string;
  baselineScore: number;
  candidateScore: number;
  regressionCount: number;
  selectedHypothesisIdsJson: string;
  externalBlockerIdsJson: string;
  reportSummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface ShadowCandidateSelection {
  selectionId: string;
  runId: string;
  hypothesisId: string;
  createdAt: string;
  rank: number;
  decision: ShadowCandidateDecision;
  rationale: string;
  riskLevel: ImprovementRiskLevel;
  fixClass: ImprovementFixClass;
  expectedScenarioIdsJson: string;
  approvalRequired: boolean;
  privacyJson: string;
}

export interface SyntheticGauntletScenarioResult {
  resultId: string;
  runId: string;
  scenarioId: string;
  createdAt: string;
  phase: SyntheticGauntletPhase;
  status: 'passed' | 'failed';
  routeScore: number;
  contextScore: number;
  usefulnessScore: number;
  brevityScore: number;
  safetyScore: number;
  fallbackScore: number;
  reflectionScore: number;
  leakageScore: number;
  totalScore: number;
  linkedHypothesisIdsJson: string;
  failuresJson: string;
  summary: string;
  privacyJson: string;
}

export interface ShadowPatchReport {
  reportId: string;
  runId: string;
  hypothesisId: string;
  patchPlanId: string | null;
  createdAt: string;
  outcome: 'improved' | 'neutral' | 'regressed' | 'inconclusive' | 'blocked';
  baselineScore: number;
  candidateScore: number;
  scoreDelta: number;
  regressionFlagsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export type PatchWorkspaceStatus =
  | 'plan_only'
  | 'branch_prepared'
  | 'patch_applied'
  | 'tests_passing'
  | 'tests_failed'
  | 'reverted'
  | 'awaiting_approval'
  | 'ready_to_merge'
  | 'rejected'
  | 'merged';

export interface PatchWorkspace {
  workspaceId: string;
  hypothesisId: string;
  patchPlanId: string | null;
  branchName: string;
  baseCommit: string;
  status: PatchWorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  riskLevel: ImprovementRiskLevel;
  allowedFilesJson: string;
  disallowedFilesJson: string;
  workspacePath: string | null;
  policyJson: string;
  privacyJson: string;
}

export interface PatchAttempt {
  attemptId: string;
  workspaceId: string;
  patchPlanId: string | null;
  createdAt: string;
  updatedAt: string;
  filesChangedJson: string;
  diffSummary: string;
  testsRunJson: string;
  beforeScore: number;
  afterScore: number;
  regressionsJson: string;
  safetyResult: 'pass' | 'warn' | 'fail' | 'not_run';
  status:
    | 'planned'
    | 'applied'
    | 'tests_passing'
    | 'tests_failed'
    | 'reverted'
    | 'blocked';
  privacyJson: string;
}

export interface PatchReview {
  reviewId: string;
  attemptId: string;
  createdAt: string;
  recommendation:
    | 'reject'
    | 'keep_branch'
    | 'request_approval'
    | 'ready_to_merge';
  approvalRequired: boolean;
  rollbackPlan: string;
  mergeReadiness: 'not_ready' | 'ready_after_approval' | 'ready' | 'blocked';
  reviewerNotes: string;
  privacyJson: string;
}

export type LiveProofGauntletStatus =
  | 'live_proven'
  | 'near_live_only'
  | 'missing_config'
  | 'externally_blocked'
  | 'stale'
  | 'failed';

export interface LiveProofGauntletEntry {
  proofId: string;
  proofName: string;
  status: LiveProofGauntletStatus;
  lastProofAt: string;
  nextStep: string;
  repoWorkRequired: boolean;
  blockerOwner: 'none' | 'repo_side' | 'external';
  evidenceIdsJson: string;
  detail: string;
  privacyJson: string;
}

export interface LiveProofGauntletReport {
  generatedAt: string;
  entries: LiveProofGauntletEntry[];
  liveProvenCount: number;
  proofDebtCount: number;
  repoWorkRequiredCount: number;
  nextAction: string;
  privacyJson: string;
}

export type RealitySourceType =
  | 'proof_gauntlet'
  | 'world_model'
  | 'truth_audit'
  | 'tool_reliability'
  | 'repair_state'
  | 'integration_doctor'
  | 'executive_reflection'
  | 'live_status'
  | 'world_fact'
  | 'skill_playbook'
  | 'improvement_lab'
  | 'manual_metadata';

export type RealitySensitivity = 'low' | 'personal' | 'sensitive' | 'secret';

export type RealityBeliefStatus =
  | 'confirmed'
  | 'likely'
  | 'uncertain'
  | 'contradicted'
  | 'stale'
  | 'externally_blocked'
  | 'unknown';

export interface RealityObservation {
  observationId: string;
  snapshotId: string;
  createdAt: string;
  source: string;
  sourceType: RealitySourceType;
  subject: string;
  observedThing: string;
  observedValue: string;
  observedAt: string;
  freshnessWindowHours: number;
  confidence: number;
  sensitivity: RealitySensitivity;
  evidenceRef: string;
  rawContentAllowed: boolean;
  privacyJson: string;
}

export interface RealityBelief {
  beliefId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  subject: string;
  beliefSummary: string;
  beliefType:
    | 'proof_state'
    | 'tool_health'
    | 'integration_state'
    | 'user_memory'
    | 'route_confidence'
    | 'action_readiness'
    | 'status_truth';
  confidence: number;
  supportingObservationIdsJson: string;
  contradictingObservationIdsJson: string;
  lastVerifiedAt: string | null;
  staleAfterAt: string | null;
  status: RealityBeliefStatus;
  nextAction: string;
  privacyJson: string;
}

export interface RealityVerificationNeed {
  needId: string;
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  question: string;
  reason: string;
  neededBeforeAction: boolean;
  possibleSourceTool: string;
  riskIfSkipped: 'low' | 'medium' | 'high' | 'critical';
  urgency: 'low' | 'normal' | 'high';
  status:
    | 'open'
    | 'runnable_read_only'
    | 'manual_proof'
    | 'approval_required'
    | 'resolved'
    | 'skipped';
  evidenceIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export type VerificationNeed = RealityVerificationNeed;

export interface RealityContradiction {
  contradictionId: string;
  snapshotId: string;
  createdAt: string;
  subject: string;
  contradictionKind:
    | 'transport_vs_proof'
    | 'health_vs_probe'
    | 'memory_vs_user'
    | 'proof_vs_patch'
    | 'provider_vs_route'
    | 'unsupported_claim';
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'open' | 'downgraded' | 'resolved';
  observationIdsJson: string;
  beliefIdsJson: string;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface RealitySnapshot {
  snapshotId: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'grounded'
    | 'needs_verification'
    | 'conflicted'
    | 'externally_blocked';
  confidence: number;
  observationIdsJson: string;
  beliefIdsJson: string;
  contradictionIdsJson: string;
  verificationNeedIdsJson: string;
  recommendedProbeIdsJson: string;
  trueNowSummary: string;
  staleSummary: string;
  contradictionSummary: string;
  missingProofSummary: string;
  degradedToolsSummary: string;
  confidenceSummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface ActivePerceptionProbe {
  probeId: string;
  planId: string;
  createdAt: string;
  probeKind:
    | 'proof_status_read'
    | 'tool_reliability_read'
    | 'repair_state_read'
    | 'calendar_readiness_read'
    | 'telegram_health_read'
    | 'bluebubbles_health_read'
    | 'source_freshness_read'
    | 'local_metadata_read'
    | 'work_cockpit_read';
  target: string;
  safeToRunAutomatically: boolean;
  status: 'planned' | 'skipped' | 'manual_required' | 'completed' | 'blocked';
  command: string;
  reason: string;
  cooldownUntil: string | null;
  evidenceIdsJson: string;
  resultSummary: string;
  nextAction: string;
  privacyJson: string;
}

export interface ActivePerceptionPlan {
  planId: string;
  snapshotId: string;
  createdAt: string;
  requestSummary: string;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  status:
    | 'not_needed'
    | 'planned'
    | 'manual_proof_required'
    | 'blocked'
    | 'completed';
  riskSummary: string;
  probeIdsJson: string;
  skippedProbeIdsJson: string;
  manualStepIdsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface ProofClosureStep {
  stepId: string;
  planId: string;
  proofId: string;
  createdAt: string;
  proofName: string;
  status:
    | 'missing_config'
    | 'manual_action'
    | 'externally_blocked'
    | 'stale_proof'
    | 'repo_bug'
    | 'complete';
  blockerClass: string;
  exactNextStep: string;
  requestedAt: string;
  evidenceIdsJson: string;
  privacyJson: string;
}

export interface RealityDoctorReport {
  generatedAt: string;
  ok: boolean;
  snapshot: RealitySnapshot;
  observations: RealityObservation[];
  beliefs: RealityBelief[];
  contradictions: RealityContradiction[];
  verificationNeeds: RealityVerificationNeed[];
  perceptionPlan: ActivePerceptionPlan;
  perceptionProbes: ActivePerceptionProbe[];
  proofClosureSteps: ProofClosureStep[];
  proofDebt: {
    total: number;
    missingConfig: number;
    manualProof: number;
    externallyBlocked: number;
    repoWorkRequired: number;
  };
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface HarnessLabReport {
  generatedAt: string;
  ok: boolean;
  tasks: HarnessEvalTask[];
  trajectories: HarnessTrajectory[];
  scorecards: HarnessScorecard[];
  proposals: HarnessImprovementProposal[];
  averageScore: number;
  failingTaskFamilies: string[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export type MessageActionSourceType =
  | 'communication_thread'
  | 'mission'
  | 'life_thread'
  | 'cross_channel_handoff'
  | 'action_bundle'
  | 'manual_prompt'
  | 'ritual_review';

export type MessageActionTargetKind = 'external_thread' | 'self_companion';

export type MessageActionTargetChannel = 'telegram' | 'bluebubbles';

export type MessageActionTrustLevel =
  | 'draft_only'
  | 'suggest_and_ask'
  | 'approve_before_send'
  | 'schedule_send'
  | 'delegated_safe_send'
  | 'never_automate';

export type MessageActionSendStatus =
  | 'drafted'
  | 'approved'
  | 'sent'
  | 'deferred'
  | 'failed'
  | 'skipped';

export type MessageActionLastActionKind =
  | 'drafted'
  | 'approved'
  | 'sent'
  | 'scheduled_send'
  | 'remind_instead'
  | 'save_to_thread'
  | 'rewrite'
  | 'skipped'
  | 'failed';

export interface MessageActionLinkedRefs {
  actionBundleId?: string;
  communicationThreadId?: string;
  threadId?: string;
  missionId?: string;
  handoffId?: string;
  reminderTaskId?: string;
  currentWorkRef?: string;
  chatJid?: string;
  personName?: string;
  delegationRuleId?: string;
  delegationMode?: DelegationApprovalMode | null;
  delegationExplanation?: string | null;
}

export interface MessageActionExplanation {
  sourceSummary?: string | null;
  approvalReason?: string | null;
  safetyReason?: string | null;
  delegationNote?: string | null;
  trustNote?: string | null;
}

export interface MessageActionRecord {
  messageActionId: string;
  groupFolder: string;
  sourceType: MessageActionSourceType;
  sourceKey: string;
  sourceSummary?: string | null;
  targetKind: MessageActionTargetKind;
  targetChannel: MessageActionTargetChannel;
  targetConversationJson: string;
  draftText: string;
  trustLevel: MessageActionTrustLevel;
  sendStatus: MessageActionSendStatus;
  followupAt?: string | null;
  requiresApproval: boolean;
  delegationRuleId?: string | null;
  delegationMode?: DelegationApprovalMode | null;
  explanationJson?: string | null;
  linkedRefsJson?: string | null;
  platformMessageId?: string | null;
  scheduledTaskId?: string | null;
  approvedAt?: string | null;
  lastActionKind?: MessageActionLastActionKind | null;
  lastActionAt?: string | null;
  dedupeKey: string;
  presentationChatJid?: string | null;
  presentationThreadId?: string | null;
  presentationMessageId?: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  sentAt?: string | null;
}

export type HierarchicalGoalStatus =
  | 'proposed'
  | 'active'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'archived';

export type HierarchicalGoalScope =
  | 'personal'
  | 'household'
  | 'relationship'
  | 'work'
  | 'andrea_project'
  | 'general';

export type HierarchicalGoalOwner = 'user' | 'andrea' | 'shared' | 'external';

export type HierarchicalGoalPriority = 'low' | 'normal' | 'high' | 'urgent';

export type GoalApprovalBoundary =
  | 'read_only'
  | 'approval_required'
  | 'manual_external'
  | 'operator_only';

export interface HierarchicalGoal {
  goalId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  title: string;
  objective: string;
  scope: HierarchicalGoalScope;
  owner: HierarchicalGoalOwner;
  status: HierarchicalGoalStatus;
  priority: HierarchicalGoalPriority;
  confidence: number;
  evidenceRefsJson: string;
  relatedWorldFactIdsJson: string;
  relatedSkillIdsJson: string;
  relatedMissionIdsJson: string;
  relatedReminderIdsJson: string;
  relatedActionBundleIdsJson: string;
  reviewCadence: 'none' | 'daily' | 'weekly' | 'monthly' | 'on_demand';
  approvalBoundary: GoalApprovalBoundary;
  allowedActionsJson: string;
  disallowedActionsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface GoalMilestone {
  milestoneId: string;
  goalId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  desiredOutcome: string;
  dueOrReviewWindow: string;
  status: 'proposed' | 'active' | 'blocked' | 'done' | 'skipped';
  blockerIdsJson: string;
  dependenciesJson: string;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface GoalPlanStep {
  stepId: string;
  goalId: string;
  milestoneId?: string | null;
  createdAt: string;
  updatedAt: string;
  position: number;
  actionSummary: string;
  requiredContextJson: string;
  requiredTool: string;
  approvalRequirement: GoalApprovalBoundary;
  estimatedEffort: 'tiny' | 'small' | 'medium' | 'large';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  fallback: string;
  status:
    | 'proposed'
    | 'ready'
    | 'blocked'
    | 'approval_required'
    | 'done'
    | 'skipped';
  evidenceRefsJson: string;
  nextAction: string;
  privacyJson: string;
}

export interface GoalOutcome {
  outcomeId: string;
  goalId: string;
  createdAt: string;
  result: 'worked' | 'failed' | 'changed' | 'deferred' | 'unknown';
  workedSummary: string;
  failedSummary: string;
  changedSummary: string;
  evidenceRefsJson: string;
  nextRecommendation: string;
  privacyJson: string;
}

export interface CausalBelief {
  beliefId: string;
  createdAt: string;
  updatedAt: string;
  causeAction: string;
  expectedEffect: string;
  contextWhereLikelyTrue: string;
  confidence: number;
  evidenceRefsJson: string;
  contradictingEvidenceRefsJson: string;
  lastTestedAt?: string | null;
  sensitivity: RealitySensitivity;
  status: 'likely' | 'uncertain' | 'contradicted' | 'stale';
  nextAction: string;
  privacyJson: string;
}

export interface CounterfactualActionOption {
  optionId: string;
  comparisonId: string;
  createdAt: string;
  actionSummary: string;
  expectedBenefit: number;
  effort: number;
  risk: number;
  requiredProof: string;
  toolReliability: number;
  approvalRequirement: GoalApprovalBoundary;
  possibleFailure: string;
  fallbackPlan: string;
  score: number;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface CounterfactualComparison {
  comparisonId: string;
  createdAt: string;
  requestSummary: string;
  selectedOptionId?: string | null;
  optionIdsJson: string;
  decision: 'recommend' | 'clarify' | 'stage_approval' | 'do_nothing';
  reason: string;
  confidence: number;
  nextAction: string;
  privacyJson: string;
}

export interface ProactiveOpportunity {
  opportunityId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  triggerSource: string;
  relatedGoalId?: string | null;
  opportunitySummary: string;
  reason: string;
  urgency: 'low' | 'normal' | 'high';
  confidence: number;
  suggestedAction: string;
  approvalRequirement: GoalApprovalBoundary;
  status:
    | 'proposed'
    | 'shown'
    | 'accepted'
    | 'ignored'
    | 'snoozed'
    | 'dismissed';
  snoozedUntil?: string | null;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface GoalPlannerRun {
  runId: string;
  createdAt: string;
  updatedAt: string;
  groupFolder?: string | null;
  channel: CognitiveExecutiveChannel | 'operator' | 'internal';
  requestSummary: string;
  intent:
    | 'direct'
    | 'clarify'
    | 'plan'
    | 'goal_proposal'
    | 'goal_update'
    | 'communication_draft'
    | 'proof_task'
    | 'repair_task'
    | 'counterfactual'
    | 'no_action';
  selectedGoalId?: string | null;
  selectedComparisonId?: string | null;
  selectedOpportunityId?: string | null;
  candidateGoalIdsJson: string;
  candidateOpportunityIdsJson: string;
  verificationNeedIdsJson: string;
  approvalRequired: boolean;
  confidence: number;
  summary: string;
  nextAction: string;
  privacyJson: string;
}

export interface GoalPlannerDoctorReport {
  generatedAt: string;
  latestRun?: GoalPlannerRun | null;
  activeGoals: HierarchicalGoal[];
  proposedGoals: HierarchicalGoal[];
  blockedGoals: HierarchicalGoal[];
  staleGoals: HierarchicalGoal[];
  milestones: GoalMilestone[];
  planSteps: GoalPlanStep[];
  comparisons: CounterfactualComparison[];
  options: CounterfactualActionOption[];
  causalBeliefs: CausalBelief[];
  opportunities: ProactiveOpportunity[];
  nextAction: string;
  privacy: CognitiveReplayPacket['privacy'];
}

export interface MissionSuggestedAction {
  kind: MissionSuggestedActionKind;
  label: string;
  reason: string;
  requiresConfirmation: boolean;
  linkedRefJson?: string | null;
}

export interface MissionRecord {
  missionId: string;
  groupFolder: string;
  title: string;
  objective: string;
  category: MissionCategory;
  status: MissionStatus;
  scope: ChiefOfStaffScope;
  linkedLifeThreadIds: string[];
  linkedSubjectIds: string[];
  linkedReminderIds: string[];
  linkedCurrentWorkJson?: string | null;
  linkedKnowledgeSourceIds: string[];
  summary: string;
  suggestedNextActionJson?: string | null;
  blockersJson?: string | null;
  dueHorizon?: ChiefOfStaffHorizon | null;
  dueAt?: string | null;
  mutedSuggestedActionKinds: MissionSuggestedActionKind[];
  createdAt: string;
  lastUpdatedAt: string;
  userConfirmed: boolean;
}

export interface MissionStepRecord {
  stepId: string;
  missionId: string;
  position: number;
  title: string;
  detail?: string | null;
  stepStatus: MissionStepStatus;
  requiresUserJudgment: boolean;
  suggestedActionKind?: MissionSuggestedActionKind | null;
  linkedRefJson?: string | null;
  lastUpdatedAt: string;
}

export interface MissionPlanSnapshot {
  mission: MissionRecord;
  steps: MissionStepRecord[];
  blockers: string[];
  suggestedActions: MissionSuggestedAction[];
  explainabilityLines: string[];
  confidence: ChiefOfStaffConfidence;
}

export interface MissionExecutionContext {
  mission: MissionRecord;
  steps: MissionStepRecord[];
  stepFocus?: MissionStepRecord | null;
  suggestedActions: MissionSuggestedAction[];
}

export interface CommunicationThreadRecord {
  id: string;
  groupFolder: string;
  title: string;
  linkedSubjectIds: string[];
  linkedLifeThreadIds: string[];
  channel: 'telegram' | 'bluebubbles' | 'alexa-originated handoff';
  channelChatJid?: string | null;
  lastInboundSummary?: string | null;
  lastOutboundSummary?: string | null;
  followupState: CommunicationFollowupState;
  urgency: CommunicationUrgency;
  followupDueAt?: string | null;
  suggestedNextAction?: CommunicationSuggestedAction | null;
  toneStyleHints: string[];
  lastContactAt?: string | null;
  lastMessageId?: string | null;
  linkedTaskId?: string | null;
  inferenceState: CommunicationInferenceState;
  trackingMode: CommunicationTrackingMode;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
}

export type CommunicationSignalDirection =
  | 'inbound'
  | 'outbound'
  | 'draft'
  | 'handoff';

export interface CommunicationSignalRecord {
  id: string;
  communicationThreadId: string;
  groupFolder: string;
  sourceChannel: 'telegram' | 'bluebubbles' | 'alexa-originated handoff';
  chatJid?: string | null;
  messageId?: string | null;
  direction: CommunicationSignalDirection;
  summaryText: string;
  followupState: CommunicationFollowupState;
  suggestedAction?: CommunicationSuggestedAction | null;
  urgency: CommunicationUrgency;
  createdAt: string;
}

export type PilotJourneyId =
  | 'ordinary_chat'
  | 'daily_guidance'
  | 'candace_followthrough'
  | 'mission_planning'
  | 'work_cockpit'
  | 'cross_channel_handoff'
  | 'alexa_orientation';

export type PilotJourneyOutcome =
  | 'success'
  | 'degraded_usable'
  | 'externally_blocked'
  | 'internal_failure'
  | 'abandoned';

export type PilotBlockerOwner = 'none' | 'repo_side' | 'external';

export interface PilotJourneyEventRecord {
  eventId: string;
  journeyId: PilotJourneyId;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  routeKey?: string | null;
  systemsInvolved: string[];
  outcome: PilotJourneyOutcome;
  blockerClass?: string | null;
  blockerOwner: PilotBlockerOwner;
  degradedPath?: string | null;
  handoffCreated: boolean;
  missionCreated: boolean;
  threadSaved: boolean;
  reminderCreated: boolean;
  librarySaved: boolean;
  currentWorkRef?: string | null;
  summaryText: string;
  startedAt: string;
  completedAt?: string | null;
  durationMs?: number | null;
}

export type PilotIssueStatus = 'open' | 'triaged' | 'closed';

export type PilotIssueKind =
  | 'felt_weird'
  | 'answer_off'
  | 'should_not_happen'
  | 'awkward_flow'
  | 'manual_pilot_issue'
  | 'downvoted_response';

export interface PilotIssueLinkedRefs {
  missionId?: string;
  lifeThreadId?: string;
  communicationThreadId?: string;
  reminderTaskId?: string;
  knowledgeSourceIds?: string[];
  currentWorkRef?: string;
  responseFeedbackId?: string;
  backendLaneId?: string;
  backendJobId?: string;
  platformMessageId?: string;
  userMessageId?: string;
  messageActionId?: string;
  googleCalendarEventId?: string;
  platformTaskLedgerId?: string;
  platformProgressLedgerId?: string;
  platformReflectionId?: string;
  platformEvaluationId?: string;
  platformLearningId?: string;
  providerCouncilRunId?: string;
  providerCouncilMode?: string;
  providerCouncilStatus?: string;
  platformSkillCandidateIds?: string[];
  platformDiagnosisId?: string;
  platformRepairPlanId?: string;
  platformRepairRunId?: string;
  platformRepairExecutionId?: string;
  platformTraceGradeId?: string;
  repairApprovalId?: string;
  approvalUtteranceMessageId?: string;
  approvalBoundFeedbackId?: string;
  absorbedFeedbackIds?: string[];
  repairBindingState?: string;
  repairExecutionState?: string;
  repairApprovalScope?: string;
  repairSelectedWorker?: string;
  repairFallbackPolicy?: string;
  repairWorkerResultStatus?: string;
  repairWorkerResultAt?: string;
  repairWorkerResultSummary?: string;
  repairWorkerResultBlockerClass?: string;
  repairWorkerNeedsLocalApply?: string;
  repairVerificationState?: string;
  repairLandingScope?: string;
  repairNextLegalAction?: string;
  repairPatchArtifact?: string;
  repairTestsPassed?: string;
  repairFinalHealthState?: string;
  verificationEvidenceIds?: string[];
  deploymentAttemptId?: string;
  repoHeadAtStart?: string;
  repoDirtyPathsAtStart?: string[];
  landingCommitSha?: string;
  landingPushedAt?: string;
  restartVerifiedAt?: string;
}

export interface PilotIssueRecord {
  issueId: string;
  createdAt: string;
  status: PilotIssueStatus;
  issueKind: PilotIssueKind;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  journeyEventId?: string | null;
  routeKey?: string | null;
  blockerClass?: string | null;
  blockerOwner: PilotBlockerOwner;
  summaryText: string;
  assistantContextSummary: string;
  linkedRefs: PilotIssueLinkedRefs;
}

export type ResponseFeedbackStatus =
  | 'captured'
  | 'awaiting_confirmation'
  | 'running'
  | 'failed'
  | 'blocked_external'
  | 'manual_sync_only'
  | 'resolved_locally'
  | 'landed'
  | 'cancelled';

export type ResponseFeedbackClassification =
  | 'repo_side_broken'
  | 'repo_side_rough_edge'
  | 'externally_blocked'
  | 'manual_sync_only';

export type ResponseFeedbackRuntimePreference =
  | 'codex_local'
  | 'codex_cloud'
  | 'cursor_cloud'
  | 'cursor_local';

export interface ResponseFeedbackRecord {
  feedbackId: string;
  createdAt: string;
  updatedAt: string;
  status: ResponseFeedbackStatus;
  classification: ResponseFeedbackClassification;
  channel: 'telegram';
  groupFolder: string;
  chatJid: string;
  threadId?: string | null;
  platformMessageId?: string | null;
  userMessageId?: string | null;
  issueId?: string | null;
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  traceReason?: string | null;
  traceNotes?: string[];
  blockerClass?: string | null;
  blockerOwner: PilotBlockerOwner;
  originalUserText: string;
  assistantReplyText: string;
  linkedRefs: PilotIssueLinkedRefs;
  remediationLaneId?: 'cursor' | 'andrea_runtime' | null;
  remediationJobId?: string | null;
  remediationRuntimePreference?: ResponseFeedbackRuntimePreference | null;
  remediationPrompt?: string | null;
  operatorNote?: string | null;
}

export interface KnowledgeSourceRecord {
  sourceId: string;
  groupFolder: string;
  sourceType: KnowledgeSourceType;
  title: string;
  shortSummary: string;
  contentRef?: string | null;
  normalizedText: string;
  tags: string[];
  scope: KnowledgeScope;
  sensitivity: KnowledgeSensitivity;
  ingestionState: KnowledgeIngestionState;
  indexState: KnowledgeIndexState;
  sourceChannel?: 'alexa' | 'telegram' | 'bluebubbles' | 'system' | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string | null;
  disabledAt?: string | null;
  deletedAt?: string | null;
}

export interface KnowledgeChunkRecord {
  chunkId: string;
  sourceId: string;
  chunkIndex: number;
  chunkText: string;
  charLength: number;
  createdAt: string;
}

export interface KnowledgeRetrievalHit {
  sourceId: string;
  sourceTitle: string;
  sourceType: KnowledgeSourceType;
  scope: KnowledgeScope;
  sensitivity: KnowledgeSensitivity;
  chunkId: string;
  chunkIndex: number;
  excerpt: string;
  retrievalScore: number;
  matchReason: string;
  tags: string[];
}

export interface ChannelArtifact {
  kind: 'image';
  filename: string;
  mimeType: string;
  bytesBase64: string;
  altText?: string;
}

export interface MediaGenerationRequest {
  prompt: string;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder?: string;
  size?: '1024x1024' | '1536x1024' | '1024x1536' | 'auto';
  styleHint?: string;
}

export interface MediaProviderStatus {
  provider: 'openai_images';
  configured: boolean;
  missing: string[];
  baseUrl: string;
  imageModel: string;
}

export interface MediaGenerationResult {
  handled: boolean;
  providerStatus: MediaProviderStatus;
  routeExplanation: string;
  debugPath: string[];
  summaryText?: string;
  replyText?: string;
  blocker?: string;
  providerUsed?: 'openai_images';
  artifact?: ChannelArtifact;
}

export type CompanionHandoffStatus =
  | 'queued'
  | 'delivered'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface CompanionHandoffPayload {
  kind: 'message' | 'artifact' | 'action_confirmation';
  title: string;
  text: string;
  artifact?: ChannelArtifact;
  caption?: string;
  sourceSummary?: string;
  followupSuggestions: string[];
}

export interface CompanionContinuationCandidate {
  capabilityId?: string;
  voiceSummary: string;
  handoffPayload?: CompanionHandoffPayload;
  completionText?: string;
  chiefOfStaffContextJson?: string;
  missionId?: string;
  missionSummary?: string;
  missionSuggestedActionsJson?: string;
  missionBlockersJson?: string;
  missionStepFocusJson?: string;
  threadId?: string;
  threadTitle?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  knowledgeSourceIds?: string[];
  knowledgeSourceTitles?: string[];
  followupSuggestions?: string[];
  actionBundleId?: string;
  actionBundleTitle?: string;
  actionBundleSummary?: string;
  messageActionId?: string;
  messageActionSummary?: string;
}

export interface CompanionHandoffRecord {
  handoffId: string;
  groupFolder: string;
  originChannel: 'alexa' | 'telegram' | 'bluebubbles';
  targetChannel: 'telegram' | 'bluebubbles';
  targetChatJid?: string | null;
  capabilityId?: string | null;
  voiceSummary: string;
  richPayloadJson: string;
  status: CompanionHandoffStatus;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  requiresConfirmation: boolean;
  threadId?: string | null;
  taskId?: string | null;
  communicationThreadId?: string | null;
  communicationSubjectIdsJson?: string | null;
  communicationLifeThreadIdsJson?: string | null;
  lastCommunicationSummary?: string | null;
  missionId?: string | null;
  missionSummary?: string | null;
  missionSuggestedActionsJson?: string | null;
  missionBlockersJson?: string | null;
  missionStepFocusJson?: string | null;
  knowledgeSourceIdsJson?: string | null;
  workRef?: string | null;
  followupSuggestionsJson?: string | null;
  deliveredMessageId?: string | null;
  errorText?: string | null;
}

export interface AlexaConversationContext {
  principalKey: string;
  accessTokenHash: string;
  groupFolder: string;
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  subjectJson: string;
  summaryText: string;
  supportedFollowupsJson: string;
  styleJson: string;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export type ProfileSubjectKind = 'self' | 'person' | 'household';

export interface ProfileSubject {
  id: string;
  groupFolder: string;
  kind: ProfileSubjectKind;
  canonicalName: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string | null;
}

export type ProfileFactCategory =
  | 'people'
  | 'relationships'
  | 'preferences'
  | 'routines'
  | 'household_context'
  | 'conversational_style'
  | 'recurring_priorities';

export type ProfileFactState =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'disabled';

export interface ProfileFact {
  id: string;
  groupFolder: string;
  subjectId: string;
  category: ProfileFactCategory;
  factKey: string;
  valueJson: string;
  state: ProfileFactState;
  sourceChannel: string;
  sourceSummary: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
}

export interface ProfileFactWithSubject extends ProfileFact {
  subjectKind: ProfileSubjectKind;
  subjectCanonicalName: string;
  subjectDisplayName: string;
}

export type OperatingProfileStatus = 'draft' | 'active' | 'superseded';

export type OperatingProfileLearningMode = 'suggest_then_confirm';

export interface OperatingProfileIntake {
  rawText: string;
  routines: string[];
  trackingPriorities: string[];
  defaultGroups: string[];
  integrationsWanted: string[];
  richerSurface: 'telegram' | 'alexa' | 'bluebubbles';
  scope: 'personal' | 'household' | 'family' | 'mixed';
  notes: string[];
}

export interface OperatingProfilePlanGroup {
  title: string;
  kind:
    | 'shopping'
    | 'errands'
    | 'bills'
    | 'meals'
    | 'household'
    | 'checklist'
    | 'general';
  scope: 'personal' | 'household' | 'family' | 'mixed';
  purpose: string;
}

export interface OperatingProfilePlanIntegration {
  name: string;
  readiness: 'connected' | 'missing_manual' | 'not_requested';
  note?: string | null;
}

export interface OperatingProfilePlan {
  summary: string;
  trackedAreas: string[];
  defaultGroups: OperatingProfilePlanGroup[];
  routines: string[];
  reminderSuggestions: string[];
  richerSurface: 'telegram' | 'alexa' | 'bluebubbles';
  desiredIntegrations: OperatingProfilePlanIntegration[];
  learningPolicy: OperatingProfileLearningMode;
}

export interface OperatingProfile {
  profileId: string;
  groupFolder: string;
  status: OperatingProfileStatus;
  version: number;
  basedOnProfileId?: string | null;
  intakeJson: string;
  planJson: string;
  sourceChannel: 'telegram' | 'alexa' | 'bluebubbles' | 'system';
  createdAt: string;
  updatedAt: string;
  approvedAt?: string | null;
  supersededAt?: string | null;
}

export type OperatingProfileSuggestionState =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'dismissed';

export interface OperatingProfileSuggestion {
  suggestionId: string;
  groupFolder: string;
  profileId?: string | null;
  title: string;
  summary: string;
  suggestionJson: string;
  state: OperatingProfileSuggestionState;
  sourceChannel: 'telegram' | 'alexa' | 'bluebubbles' | 'system';
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
}

export type EverydayListGroupKind =
  | 'shopping'
  | 'errands'
  | 'bills'
  | 'meals'
  | 'household'
  | 'checklist'
  | 'general';

export type EverydayListItemKind =
  | 'shopping_item'
  | 'errand'
  | 'bill'
  | 'meal_entry'
  | 'checklist_item'
  | 'general_item';

export type EverydayListItemState =
  | 'open'
  | 'done'
  | 'snoozed'
  | 'deferred'
  | 'converted_to_reminder'
  | 'converted_to_mission';

export type EverydayListScope = 'personal' | 'household' | 'family' | 'mixed';

export type EverydayListRecurrenceKind =
  | 'none'
  | 'daily'
  | 'weekly'
  | 'monthly';

export interface EverydayListGroup {
  groupId: string;
  groupFolder: string;
  operatingProfileId?: string | null;
  title: string;
  kind: EverydayListGroupKind;
  scope: EverydayListScope;
  sourceSummary?: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
}

export interface EverydayListItem {
  itemId: string;
  groupFolder: string;
  groupId: string;
  operatingProfileId?: string | null;
  title: string;
  itemKind: EverydayListItemKind;
  state: EverydayListItemState;
  scope: EverydayListScope;
  sourceChannel: 'telegram' | 'alexa' | 'bluebubbles' | 'system';
  sourceSummary: string;
  detailJson?: string | null;
  linkageJson?: string | null;
  dueAt?: string | null;
  scheduledFor?: string | null;
  deferUntil?: string | null;
  recurrenceKind?: EverydayListRecurrenceKind;
  recurrenceInterval?: number;
  recurrenceDaysJson?: string | null;
  recurrenceDayOfMonth?: number | null;
  recurrenceAnchorAt?: string | null;
  recurrenceNextDueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
}

export type LifeThreadStatus = 'active' | 'paused' | 'closed' | 'archived';

export type LifeThreadScope =
  | 'personal'
  | 'household'
  | 'family'
  | 'work'
  | 'mixed';

export type LifeThreadCategory =
  | 'family'
  | 'relationship'
  | 'household'
  | 'school'
  | 'health'
  | 'routine'
  | 'work'
  | 'project'
  | 'community'
  | 'personal';

export type LifeThreadSourceKind =
  | 'explicit'
  | 'inferred'
  | 'reminder'
  | 'calendar'
  | 'draft'
  | 'action_layer'
  | 'daily_companion'
  | 'alexa_followup';

export type LifeThreadConfidenceKind = 'explicit' | 'high' | 'medium' | 'low';

export type LifeThreadSensitivity = 'normal' | 'sensitive';

export type LifeThreadSurfaceMode = 'default' | 'manual_only';

export type LifeThreadFollowthroughMode =
  | 'off'
  | 'manual_only'
  | 'important_only'
  | 'scheduled';

export type LifeThreadCommandChannel = 'telegram' | 'alexa' | 'bluebubbles';

export interface LifeThread {
  id: string;
  groupFolder: string;
  title: string;
  category: LifeThreadCategory;
  status: LifeThreadStatus;
  scope: LifeThreadScope;
  relatedSubjectIds: string[];
  contextTags: string[];
  summary: string;
  nextAction?: string | null;
  nextFollowupAt?: string | null;
  sourceKind: LifeThreadSourceKind;
  confidenceKind: LifeThreadConfidenceKind;
  userConfirmed: boolean;
  sensitivity: LifeThreadSensitivity;
  surfaceMode: LifeThreadSurfaceMode;
  followthroughMode: LifeThreadFollowthroughMode;
  lastSurfacedAt?: string | null;
  snoozedUntil?: string | null;
  linkedTaskId?: string | null;
  mergedIntoThreadId?: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  lastUsedAt?: string | null;
}

export interface LifeThreadSignal {
  id: string;
  threadId: string;
  groupFolder: string;
  sourceKind: LifeThreadSourceKind;
  summaryText: string;
  chatJid?: string | null;
  messageId?: string | null;
  taskId?: string | null;
  calendarEventId?: string | null;
  profileFactId?: string | null;
  confidenceKind: LifeThreadConfidenceKind;
  createdAt: string;
}

export interface PendingLifeThreadSuggestionState {
  version: 1;
  title: string;
  category: LifeThreadCategory;
  scope: LifeThreadScope;
  summary: string;
  nextAction?: string | null;
  sourceKind: 'inferred';
  confidenceKind: 'high';
  sensitivity: LifeThreadSensitivity;
  relatedSubjectIds: string[];
  contextTags: string[];
  createdAt: string;
  expiresAt: string;
}

export interface LastReferencedLifeThreadState {
  version: 1;
  threadId: string;
  title: string;
  createdAt: string;
}

export interface LifeThreadSnapshot {
  activeThreads: LifeThread[];
  dueFollowups: LifeThread[];
  slippingThreads: LifeThread[];
  householdCarryover: LifeThread | null;
  recommendedNextThread: LifeThread | null;
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

export interface ChannelInlineAction {
  label: string;
  actionId?: string;
  url?: string;
}

export interface SendMessageOptions {
  threadId?: string;
  replyToMessageId?: string;
  inlineActions?: ChannelInlineAction[];
  inlineActionRows?: ChannelInlineAction[][];
  suppressSenderLabel?: boolean;
}

export interface SendArtifactOptions extends SendMessageOptions {
  caption?: string;
}

export interface SendMessageResult {
  platformMessageId?: string;
  platformMessageIds?: string[];
  threadId?: string | null;
}

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

export type ChannelHealthState = 'starting' | 'ready' | 'degraded' | 'stopped';

export interface ChannelHealthSnapshot {
  name: string;
  configured: boolean;
  state: ChannelHealthState;
  updatedAt: string;
  lastReadyAt?: string | null;
  lastError?: string | null;
  detail?: string | null;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  editMessage?(
    jid: string,
    platformMessageId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  sendMessageWithReceipt?(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<ChannelSendReceipt | null>;
  sendArtifact?(
    jid: string,
    artifact: ChannelArtifact,
    options?: SendArtifactOptions,
  ): Promise<SendMessageResult>;
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

// ===========================================================================
// v32 General Intelligence Control Plane
// ===========================================================================

export type ControlPlaneChannel =
  | CognitiveExecutiveChannel
  | 'operator'
  | 'internal';

export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface AutonomyDecision {
  level: AutonomyLevel;
  levelLabel: string;
  operationSummary: string;
  matchedRule: string;
  allowed: boolean;
  requiresExplicitApproval: boolean;
  requiresOperatorContext: boolean;
  rationale: string;
}

export type ActionIntentStatus =
  | 'proposed'
  | 'needs_clarification'
  | 'needs_verification'
  | 'needs_approval'
  | 'approved'
  | 'scheduled'
  | 'attempted'
  | 'succeeded'
  | 'failed'
  | 'repaired'
  | 'deferred'
  | 'cancelled'
  | 'archived';

export type ActionIntentType =
  | 'message_send'
  | 'calendar_write'
  | 'reminder'
  | 'household'
  | 'repair'
  | 'patch'
  | 'experiment'
  | 'research'
  | 'status'
  | 'other';

export type ActionIntentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type ActionIntentSourceSystem =
  | 'message_actions'
  | 'action_bundles'
  | 'calendar'
  | 'goal_planner'
  | 'repair_runtime'
  | 'patch_workbench'
  | 'improvement_lab'
  | 'control_plane';

export interface ActionIntentRecord {
  actionId: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  sourceRequestSummary: string;
  sourceChannel: ControlPlaneChannel;
  relatedGoalId?: string | null;
  relatedPlanStepId?: string | null;
  relatedThreadId?: string | null;
  relatedCalendarEventId?: string | null;
  relatedSkillId?: string | null;
  relatedProofNeedId?: string | null;
  actionType: ActionIntentType;
  riskLevel: ActionIntentRiskLevel;
  autonomyLevel: number;
  approvalRequirement: 'none' | 'explicit_approval' | 'operator_context';
  status: ActionIntentStatus;
  statusReason: string;
  sourceSystem: ActionIntentSourceSystem;
  sourceKey: string;
  privacyJson: string;
}

export interface ActionAttemptRecord {
  attemptId: string;
  actionId: string;
  attemptedAt: string;
  toolUsed: string;
  preflightId?: string | null;
  preflightVerdict: string;
  result: 'succeeded' | 'failed' | 'blocked' | 'deferred';
  failureReason?: string | null;
  repairSuggestion?: string | null;
  evidenceRefsJson: string;
  privacyJson: string;
}

export interface ActionReviewRecord {
  actionReviewId: string;
  actionId: string;
  createdAt: string;
  outcome:
    | 'completed'
    | 'partial'
    | 'failed'
    | 'skipped'
    | 'deferred'
    | 'unknown';
  userSatisfaction: 'satisfied' | 'corrected' | 'dissatisfied' | 'unknown';
  whatChanged: string;
  lessons: string;
  followUpActionId?: string | null;
  privacyJson: string;
}

export type ActionPreflightVerdict =
  | 'proceed'
  | 'clarify'
  | 'verify'
  | 'request_approval'
  | 'defer'
  | 'block'
  | 'offer_fallback';

export type ActionPreflightCheckId =
  | 'object_clarity'
  | 'required_info'
  | 'reality_freshness'
  | 'tool_reliability'
  | 'approval'
  | 'channel_allowed'
  | 'safer_fallback'
  | 'duplicate'
  | 'contradiction'
  | 'risk_classification';

export interface ActionPreflightCheck {
  checkId: ActionPreflightCheckId;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
}

export interface ActionPreflightRecord {
  preflightId: string;
  actionId?: string | null;
  createdAt: string;
  actionSummary: string;
  actionType: ActionIntentType;
  channel: ControlPlaneChannel;
  riskLevel: ActionIntentRiskLevel;
  autonomyLevel: number;
  verdict: ActionPreflightVerdict;
  checksJson: string;
  criticDecision:
    | 'proceed'
    | 'clarify'
    | 'stage_approval'
    | 'block'
    | 'not_run';
  fallbackSuggestion?: string | null;
  blockerSummary: string;
  privacyJson: string;
}

export interface CognitiveEpisodeRecord {
  episodeId: string;
  createdAt: string;
  askSummary: string;
  channel: ControlPlaneChannel;
  goalId?: string | null;
  reasoningMode: string;
  selectedContextSummary: string;
  actionId?: string | null;
  result:
    | 'answered'
    | 'action_proposed'
    | 'action_executed'
    | 'clarified'
    | 'deferred'
    | 'failed';
  userCorrection?: string | null;
  confidence: number;
  lesson: string;
  followUpNeeded?: string | null;
  sensitivity: 'normal' | 'sensitive';
  retentionPolicy: 'standard_90d' | 'short_7d' | 'pinned';
  privacyJson: string;
}

export interface CapabilityStateRecord {
  capabilityId: string;
  updatedAt: string;
  displayName: string;
  enabled: boolean;
  proofStatus:
    | 'live_proven'
    | 'stale'
    | 'missing_config'
    | 'manual_proof_required'
    | 'externally_blocked'
    | 'unproven';
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  reliabilityScore: number;
  requiredConfig: string;
  currentBlocker?: string | null;
  allowedChannels: string;
  approvalRequirement: 'none' | 'explicit_approval' | 'operator_context';
  fallbackCapabilityId?: string | null;
  confidence: number;
  autonomyLevel: number;
  privacyJson: string;
}

export interface BlackboardSnapshotRecord {
  snapshotId: string;
  createdAt: string;
  currentRequestSummary: string;
  activeGoalSummary?: string | null;
  activePlanStepSummary?: string | null;
  activeActionId?: string | null;
  workingMemoryFocus?: string | null;
  realitySummary: string;
  proofDebtOpen: number;
  toolReliabilitySummary: string;
  approvalNeedsCount: number;
  likelyIntent: string;
  recentCorrectionsSummary: string;
  outcomeSignalSummary: string;
  improvementSignalSummary: string;
  recommendedNextStep: string;
  privacyJson: string;
}

export interface StrategyEvalRunRecord {
  evalRunId: string;
  createdAt: string;
  scenarioId: string;
  scenarioTitle: string;
  expectedMode: string;
  selectedMode: string;
  modeCorrect: boolean;
  scoresJson: string;
  totalScore: number;
  notes: string;
  privacyJson: string;
}

export interface AgiGauntletResultRecord {
  resultId: string;
  runId: string;
  createdAt: string;
  scenarioId: string;
  scenarioTitle: string;
  passed: boolean;
  score: number;
  subsystem: string;
  safetyRiskFlagsJson: string;
  detail: string;
  privacyJson: string;
}
