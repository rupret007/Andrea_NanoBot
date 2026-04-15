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

export type BlueBubblesChatScope =
  | 'all_synced'
  | 'contacts_only'
  | 'allowlist';

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
  repoHeadAtStart?: string;
  repoDirtyPathsAtStart?: string[];
  landingCommitSha?: string;
  landingPushedAt?: string;
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
