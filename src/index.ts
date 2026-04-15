import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  classifyRuntimeRoute,
  selectPreferredRuntime,
  shouldReuseExistingThread,
} from './agent-runtime.js';
import {
  ASSISTANT_NAME,
  ASSISTANT_NAME_SOURCE,
  AGENT_RUNTIME_FALLBACK,
  ANDREA_OPENAI_BACKEND_ENABLED,
  ANDREA_OPENAI_BACKEND_URL,
  CONTAINER_TIMEOUT,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  RUNTIME_STATE_DIR,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AvailableCursorAgent,
  AvailableOpenClawSkill,
  ContainerOutput,
  runContainerAgent,
  writeCursorAgentsSnapshot,
  writeGroupsSnapshot,
  writeOpenClawSkillsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  CONTAINER_RUNTIME_NAME,
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  getContainerRuntimeStatus,
} from './container-runtime.js';
import {
  createCalendarAutomation,
  createTask,
  deleteAgentThread,
  deleteSession,
  deleteSessionStorageKey,
  deleteTask,
  getCursorMessageContext,
  deleteRuntimeBackendCardContext,
  deleteRuntimeBackendChatSelection,
  getAllAgentThreads,
  getAllChats,
  getAgentThread,
  getRegisteredMainChat,
  getResponseFeedback,
  getResponseFeedbackByRemediationJob,
  listAllCursorAgents,
  listCalendarAutomationsForChat,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastBotMessageTimestamp,
  listCursorAgentArtifacts,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getRuntimeBackendCardContext,
  getRuntimeBackendChatSelection,
  getRuntimeBackendJob,
  initDatabase,
  listAllEnabledCommunitySkills,
  pruneExpiredRuntimeBackendCardContexts,
  repairRegisteredMainChat,
  setRegisteredGroup,
  setAgentThread,
  setRouterState,
  deleteRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateCalendarAutomation,
  updateResponseFeedback,
  updateTask,
  upsertRuntimeBackendCardContext,
  upsertRuntimeBackendChatSelection,
  upsertResponseFeedback,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import {
  primeBlueBubblesChatHistory,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { planSimpleReminder } from './local-reminder.js';
import {
  buildCalendarAssistantResponse,
  planCalendarAssistantLookup,
  type CalendarSchedulingContext,
} from './calendar-assistant.js';
import {
  type SelectedWorkContext,
} from './daily-command-center.js';
import {
  buildDailyCompanionResponse,
  isPotentialDailyCompanionPrompt,
  type DailyCompanionContext,
  type DailyCompanionMode,
} from './daily-companion.js';
import {
  buildLifeThreadSuggestionAskText,
  handleLifeThreadCommand,
  maybeCreatePendingLifeThreadSuggestion,
  setLastReferencedLifeThread,
} from './life-threads.js';
import {
  executeAssistantCapability,
  type AssistantCapabilityConversationSeed,
  type AssistantCapabilityResult,
} from './assistant-capabilities.js';
import { completeAssistantActionFromAlexa } from './assistant-action-completion.js';
import {
  continueAssistantCapabilityFromPriorSubjectData,
  matchAssistantCapabilityRequest,
} from './assistant-capability-router.js';
import {
  capturePilotIssue,
  completePilotJourney,
  type PilotJourneyCompleteParams,
  resolveCrossChannelPilotJourney,
  resolveOrdinaryChatPilotJourney,
  resolvePilotJourneyFromCapability,
  resolveWorkCockpitPilotJourney,
  startPilotJourney,
} from './pilot-mode.js';
import {
  resolveAlexaConversationFollowup,
  type AlexaConversationState,
} from './alexa-conversation.js';
import {
  buildCalendarCompanionEventReply,
  buildCalendarCompanionFailureReply,
  type CalendarCompanionFailureKind,
  type ConversationalChannel,
} from './conversational-core.js';
import {
  clearAssistantHealthState,
  clearAssistantReadyState,
  clearTelegramTransportState,
  reconcileWindowsHostState,
  writeRuntimeAuditState,
  writeAssistantHealthState,
  writeAssistantReadyState,
} from './host-control.js';
import {
  listCompanionConversationChatJids,
  resolveCompanionConversationBinding,
} from './companion-conversation-binding.js';
import {
  isBlueBubblesExplicitAsk,
  normalizeBlueBubblesCompanionPrompt,
  resolveMostRecentBlueBubblesCompanionChat,
} from './bluebubbles-companion.js';
import {
  canonicalizeBlueBubblesSelfThreadJid,
  isBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import { interpretBlueBubblesDirectTurn } from './messages-fluidity.js';
import { recordOrganicTelegramRoundtripSuccess } from './telegram-roundtrip.js';
import { readEnvFile } from './env.js';
import {
  advancePendingActionDraft,
  advancePendingActionReminder,
  buildActionLayerContextFromDailyCommandCenter,
  buildActionLayerResponse,
  isActionLayerContextExpired,
  isPendingActionDraftExpired,
  isPendingActionReminderExpired,
  planActionLayerIntent,
  shouldInterruptPendingActionLayerFlow,
  type ActionLayerContextState,
  type PendingActionDraftState,
  type PendingActionReminderState,
} from './action-layer.js';
import {
  type ActionBundleOperation,
  applyActionBundleOperation,
  buildActionBundlePresentation,
  createOrRefreshActionBundle,
  findLatestChatActionBundle,
  interpretActionBundleFollowup,
  rememberActionBundlePresentation,
} from './action-bundles.js';
import {
  applyMessageActionOperation,
  buildMessageActionPresentation,
  createOrRefreshMessageActionFromDraft,
  findLatestChatMessageAction,
  isBlueBubblesExplicitSendAlias,
  interpretMessageActionFollowup,
  parseExplicitBlueBubblesThreadSendIntent,
  resolveBlueBubblesThreadTargetByName,
  resolveMessageActionForFollowup,
  type MessageActionOperation,
} from './message-actions.js';
import {
  applyOutcomeReviewControl,
  buildOutcomeReviewResponse,
  interpretOutcomeReviewControl,
  matchOutcomeReviewPrompt,
  syncOutcomeFromReminderTask,
  type OutcomeReviewPromptMatch,
} from './outcome-reviews.js';
import {
  buildDelegationRuleListPresentation,
  buildDelegationRulePreview,
  buildDelegationRulePreviewPresentation,
  buildDelegationRuleWhyText,
  interpretDelegationRuleUtterance,
  retargetDelegationRuleChannels,
  saveDelegationRuleFromPreview,
  updateDelegationRuleMode,
} from './delegation-rules.js';
import { getDelegationRule, updateDelegationRule, updateMessageAction } from './db.js';
import {
  advancePendingCalendarAutomation,
  buildCalendarAutomationPersistInput,
  computeCalendarAutomationNextRun,
  isPendingCalendarAutomationExpired,
  parseCalendarAutomationRecord,
  planCalendarAutomation,
  type CalendarAutomationSummary,
  type PendingCalendarAutomationState,
} from './calendar-automations.js';
import {
  advancePendingCalendarReminder,
  advancePendingGoogleCalendarEventAction,
  buildActiveGoogleCalendarEventContextState,
  buildEventReminderTaskPlan,
  buildSameDaySuggestions,
  formatPendingGoogleCalendarEventActionPrompt,
  isActiveGoogleCalendarEventContextExpired,
  isPendingCalendarReminderExpired,
  isPendingGoogleCalendarEventActionExpired,
  planCalendarEventReminder,
  planGoogleCalendarEventAction,
  resolveCalendarReminderLookup,
  type ActiveGoogleCalendarEventContextState,
  type PendingCalendarReminderState,
  type PendingGoogleCalendarEventActionState,
} from './google-calendar-followthrough.js';
import {
  advancePendingGoogleCalendarCreate,
  buildGoogleCalendarSchedulingContextState,
  buildPendingGoogleCalendarCreateState,
  formatGoogleCalendarCreatePrompt,
  isExplicitGoogleCalendarCreateRequest,
  isGoogleCalendarSchedulingContextExpired,
  isPendingGoogleCalendarCreateExpired,
  planGoogleCalendarCreate,
  type GoogleCalendarConflictEvent,
  type GoogleCalendarDraftConflictSummary,
  type GoogleCalendarSchedulingContextState,
  type PendingGoogleCalendarCreateState,
} from './google-calendar-create.js';
import {
  classifyGoogleCalendarFailureDetail,
  type GoogleCalendarEventRecord,
  isGoogleCalendarAuthFailureKind,
  type GoogleCalendarMetadata,
  deleteGoogleCalendarEvent,
  listGoogleCalendarEvents,
  createGoogleCalendarEvent,
  listGoogleCalendars,
  moveGoogleCalendarEvent,
  resolveGoogleCalendarConfig,
  updateGoogleCalendarEvent,
} from './google-calendar.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  buildAssistantPromptWithPersonalization,
  handlePersonalizationCommand,
  maybeCreateProactiveProfileCandidate,
} from './assistant-personalization.js';
import {
  formatCursorGatewaySmokeTestMessage,
  formatCursorGatewayStatusMessage,
  getCursorGatewayStatus,
  runCursorGatewaySmokeTest,
} from './cursor-gateway.js';
import {
  CursorCloudClient,
  formatCursorCloudStatusMessage,
  getCursorCloudStatus,
  resolveCursorCloudConfig,
} from './cursor-cloud.js';
import {
  formatCursorDesktopStatusMessage,
  getCursorDesktopStatus,
} from './cursor-desktop.js';
import {
  formatCursorCapabilitySummaryMessage,
  formatCursorOperationFailure,
  shouldClearCursorSelectionForError,
  summarizeCursorCapabilities,
} from './cursor-capabilities.js';
import { formatBackendOperationFailure } from './backend-lane-errors.js';
import {
  formatAmazonBusinessStatusMessage,
  getAmazonBusinessStatus,
} from './amazon-business.js';
import {
  type AlexaRuntime,
  formatAlexaStatusMessage,
  getAlexaStatus,
  startAlexaServer,
} from './alexa.js';
import { seedConfiguredAlexaLinkedAccount } from './alexa-identity.js';
import {
  approveAmazonPurchaseRequest,
  cancelAmazonPurchaseRequest,
  createAmazonPurchaseRequest,
  formatAmazonPurchaseRequestsMessage,
  formatAmazonSearchResultsMessage,
  listAmazonPurchaseRequests,
  searchAmazonProducts,
} from './amazon-shopping.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropIncomingMessageBeforeCommands,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  AgentThreadState,
  Channel,
  ChannelHealthSnapshot,
  NewMessage,
  PilotBlockerOwner,
  PilotJourneyOutcome,
  RegisteredGroup,
  ResponseFeedbackRecord,
  SendMessageOptions,
  RuntimeBackendJob,
} from './types.js';
import { logger } from './logger.js';
import { deliverCompanionHandoff } from './cross-channel-handoffs.js';
import { buildFieldTrialOperatorTruth } from './field-trial-readiness.js';
import {
  buildDebugLogsInlineActions,
  buildDebugMutationInlineActions,
  buildDebugStatusInlineActions,
  formatDebugStatus,
  loadLogControlFromPersistence,
  readDebugLogs,
  refreshLogControlFromPersistence,
  resetDebugLevel,
  setDebugLevel,
  startLogControlAutoRefresh,
} from './debug-control.js';
import {
  disableOpenClawSkill,
  enableOpenClawSkill,
  installOpenClawSkill,
} from './openclaw-market.js';
import { classifyAssistantRequest } from './assistant-routing.js';
import {
  analyzeAgentError,
  buildRepeatedAgentErrorMessage,
} from './agent-error.js';
import { listCursorModels, type CursorAgentView } from './cursor-jobs.js';
import {
  buildRuntimeJobInlineActions,
  dispatchRuntimeCommand,
  formatRuntimeJobCard,
  formatRuntimeNextStep,
} from './andrea-runtime/commands.js';
import { createBackendLaneRegistry } from './backend-lanes/registry.js';
import {
  createAndreaRuntimeBackendLane,
  followUpAndreaRuntimeLaneGroup,
  type AndreaRuntimeBackendLane,
} from './backend-lanes/andrea-runtime-lane.js';
import { createCursorBackendLane } from './backend-lanes/cursor-lane.js';
import type {
  BackendJobDetails,
  BackendJobHandle,
  BackendJobSummary,
} from './backend-lanes/types.js';
import {
  parseCursorCreateCommand,
  tokenizeCommandArguments,
} from './cursor-command-parser.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
} from './user-facing-error.js';
import { resolveEffectiveIdleTimeout } from './runtime-timeout.js';
import {
  buildDirectAssistantRuntimeFailureReply,
  maybeBuildDirectQuickReply,
} from './direct-quick-reply.js';
import { buildDirectAssistantContinuationPrompt } from './direct-assistant-continuation.js';
import {
  getAssistantSessionStorageKey,
  isDeadAssistantSessionErrorText,
} from './assistant-session.js';
import {
  decideMainChatRouting,
  shouldAvoidCombinedContextForMainChat,
  type MainChatSessionState,
} from './main-chat-routing.js';
import { buildSilentSuccessFallback } from './user-facing-fallback.js';
import {
  buildCursorReplyContextMissingMessage,
  buildCursorCloudTaskActions,
  buildCursorJobCardActions,
  buildCursorTerminalCardActions,
  clearSelectedLaneJob,
  flattenCursorJobInventory,
  formatCursorJobCard,
  formatCursorTaskNextStepMessage,
  type FlattenedCursorJobEntry,
  type ResolvedCursorTarget,
  getActiveCursorOperatorContext,
  getActiveCursorMessageContext,
  getBackendContextGuidance,
  getCursorContextGuidance,
  getSelectedLaneJobId,
  looksLikeCursorTargetToken,
  rememberCursorDashboardMessage,
  rememberCursorJobList,
  rememberCursorMessageContext,
  rememberCursorOperatorSelection,
  resolveBackendTarget,
  resolveCursorReplyContext,
  resolveCursorTarget,
} from './cursor-operator-context.js';
import {
  buildCursorDashboardCurrentJob,
  buildCursorDashboardCurrentJobEmpty,
  buildCursorDashboardDesktop,
  buildCursorDashboardHelp,
  buildCursorDashboardHome,
  buildCursorDashboardJobs,
  buildCursorDashboardWorkCurrent,
  buildCursorDashboardRuntime,
  buildCursorDashboardRuntimeCurrent,
  buildCursorDashboardRuntimeCurrentEmpty,
  buildCursorDashboardRuntimeJobs,
  buildCursorDashboardStatus,
  buildCursorDashboardWizardConfirm,
  buildCursorDashboardWizardPrompt,
  buildCursorDashboardWizardRepo,
  CURSOR_DASHBOARD_EXPIRED_MESSAGE,
  CURSOR_DASHBOARD_PAGE_SIZE,
  formatCursorDashboardState,
  parseCursorDashboardState,
  type CursorDashboardState,
} from './cursor-dashboard.js';
import {
  formatWorkPanel,
  formatHumanTaskStatus,
  formatOpaqueTaskId,
  stripLeadingMarkdownTitle,
  formatTaskReplyPrompt,
} from './task-presentation.js';
import {
  reconcileWorkCockpitCurrentSelection,
  resolveRuntimeDashboardJobId,
  shouldClearStaleWorkCockpitSelection,
} from './work-cockpit-targets.js';
import {
  buildTaskOutputSuggestion,
  getTaskContextType,
  interpretTaskContinuation,
  maybeBuildHarmlessTaskReply,
  mergeTaskMessageContextPayload,
  summarizeVisibleTaskText,
  type TaskContextType,
} from './task-continuation.js';
import {
  ANDREA_OPENAI_BACKEND_ID,
} from './andrea-openai-backend.js';
import {
  AndreaOpenAiRuntimeError,
  createAndreaOpenAiRuntimeJob,
  followUpAndreaOpenAiRuntimeJob,
  getAndreaOpenAiBackendStatus,
  getAndreaOpenAiRuntimeJob,
  getAndreaOpenAiRuntimeJobLogs,
  listAndreaOpenAiRuntimeJobs,
  stopAndreaOpenAiRuntimeJob,
} from './andrea-openai-runtime.js';
import {
  formatRuntimeBackendCreateAcceptedMessage,
  extractRuntimeBackendJobIdFromText,
  formatRuntimeBackendFailure,
  formatRuntimeBackendFollowupAcceptedMessage,
  formatRuntimeBackendJobCard,
  formatRuntimeBackendJobsMessage,
  formatRuntimeBackendLogsMessage,
  formatRuntimeBackendStatusSummary,
  formatRuntimeBackendStopMessage,
} from './runtime-shell.js';
import {
  buildRuntimeReplyContextMissingMessage,
  buildRuntimeSelectionMissingMessage,
  computeRuntimeCardContextExpiry,
  resolveRuntimeJobTarget,
  resolveRuntimeLogsTarget,
  resolveRuntimeReplyContext,
} from './runtime-chat-context.js';
import {
  ALEXA_STATUS_COMMANDS,
  AMAZON_SEARCH_COMMANDS,
  AMAZON_STATUS_COMMANDS,
  CURSOR_ARTIFACTS_COMMANDS,
  CURSOR_ARTIFACT_LINK_COMMANDS,
  CURSOR_CONVERSATION_COMMANDS,
  CURSOR_CREATE_COMMANDS,
  CURSOR_DASHBOARD_COMMANDS,
  CURSOR_FOLLOWUP_COMMANDS,
  CURSOR_JOBS_COMMANDS,
  CURSOR_MODELS_COMMANDS,
  CURSOR_SELECT_COMMANDS,
  CURSOR_STOP_COMMANDS,
  CURSOR_SYNC_COMMANDS,
  CURSOR_TERMINAL_COMMANDS,
  CURSOR_TERMINAL_HELP_COMMANDS,
  CURSOR_TERMINAL_LOG_COMMANDS,
  CURSOR_TERMINAL_STATUS_COMMANDS,
  CURSOR_TERMINAL_STOP_COMMANDS,
  CURSOR_TEST_COMMANDS,
  CURSOR_UI_COMMANDS,
  DEBUG_LEVEL_COMMANDS,
  DEBUG_LOGS_COMMANDS,
  DEBUG_RESET_COMMANDS,
  DEBUG_STATUS_COMMANDS,
  getCommandAccessDecision,
  isMainControlChat,
  normalizeCommandToken,
  PURCHASE_APPROVE_COMMANDS,
  PURCHASE_CANCEL_COMMANDS,
  PURCHASE_REQUEST_COMMANDS,
  PURCHASE_REQUESTS_COMMANDS,
  RUNTIME_CREATE_COMMANDS,
  RUNTIME_FOLLOWUP_COMMANDS,
  RUNTIME_JOB_COMMANDS,
  RUNTIME_JOBS_COMMANDS,
  RUNTIME_LOGS_COMMANDS,
  RUNTIME_STATUS_COMMANDS,
  RUNTIME_STOP_COMMANDS,
  REMOTE_CONTROL_START_COMMANDS,
  REMOTE_CONTROL_STOP_COMMANDS,
} from './operator-command-gate.js';
import {
  appendResponseFeedbackActionRows,
  appendResponseFeedbackInlineRow,
  buildResponseFeedbackActionRows,
  buildResponseFeedbackCaptureReply,
  buildResponseFeedbackRemediationPrompt,
  buildResponseFeedbackWhyText,
  classifyResponseFeedbackCandidate,
  parseResponseFeedbackAction,
  selectResponseFeedbackLane,
} from './response-feedback.js';
import {
  auditRegisteredMainChat,
  type RegisteredMainChatRecord,
} from './main-chat-audit.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let agentThreads: Record<string, AgentThreadState> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
const NON_RETRIABLE_ERROR_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
const lastNonRetriableErrorNotice: Record<
  string,
  { code: string; at: number }
> = {};
const lastDirectAssistantTextByChatJid: Record<string, string> = {};
const GOOGLE_CALENDAR_PENDING_STATE_PREFIX = 'google_calendar_pending_create:';
const GOOGLE_CALENDAR_SCHEDULING_CONTEXT_PREFIX =
  'google_calendar_scheduling_context:';
const GOOGLE_CALENDAR_ACTIVE_EVENT_CONTEXT_PREFIX =
  'google_calendar_active_event_context:';
const GOOGLE_CALENDAR_PENDING_REMINDER_PREFIX =
  'google_calendar_pending_reminder:';
const GOOGLE_CALENDAR_PENDING_EVENT_ACTION_PREFIX =
  'google_calendar_pending_event_action:';
const GOOGLE_CALENDAR_PENDING_AUTOMATION_PREFIX =
  'google_calendar_pending_automation:';
const ACTION_LAYER_CONTEXT_PREFIX = 'action_layer_context:';
const ACTION_LAYER_PENDING_REMINDER_PREFIX = 'action_layer_pending_reminder:';
const ACTION_LAYER_PENDING_DRAFT_PREFIX = 'action_layer_pending_draft:';
const DAILY_COMPANION_CONTEXT_PREFIX = 'daily_companion_context:';
const DAILY_COMPANION_CONTEXT_TTL_MS = 10 * 60 * 1000;
const SHARED_ASSISTANT_CONTEXT_PREFIX = 'shared_assistant_context:';
const SHARED_ASSISTANT_CONTEXT_TTL_MS = 10 * 60 * 1000;
const OUTCOME_REVIEW_CONTEXT_PREFIX = 'outcome_review_context:';
const OUTCOME_REVIEW_CONTEXT_TTL_MS = 30 * 60 * 1000;
const DELEGATION_RULE_CONTEXT_PREFIX = 'delegation_rule_context:';

function getGoogleCalendarPendingStateKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_PENDING_STATE_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getGoogleCalendarSchedulingContextKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_SCHEDULING_CONTEXT_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getGoogleCalendarActiveEventContextKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_ACTIVE_EVENT_CONTEXT_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getGoogleCalendarPendingReminderKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_PENDING_REMINDER_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getGoogleCalendarPendingEventActionKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_PENDING_EVENT_ACTION_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getGoogleCalendarPendingAutomationKey(chatJid: string): string {
  return `${GOOGLE_CALENDAR_PENDING_AUTOMATION_PREFIX}${canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid}`;
}

function getActionLayerContextKey(chatJid: string): string {
  return `${ACTION_LAYER_CONTEXT_PREFIX}${chatJid}`;
}

function getActionLayerPendingReminderKey(chatJid: string): string {
  return `${ACTION_LAYER_PENDING_REMINDER_PREFIX}${chatJid}`;
}

function getActionLayerPendingDraftKey(chatJid: string): string {
  return `${ACTION_LAYER_PENDING_DRAFT_PREFIX}${chatJid}`;
}

function getDailyCompanionContextKey(chatJid: string): string {
  return `${DAILY_COMPANION_CONTEXT_PREFIX}${chatJid}`;
}

function getSharedAssistantContextKey(chatJid: string): string {
  return `${SHARED_ASSISTANT_CONTEXT_PREFIX}${chatJid}`;
}

function getOutcomeReviewContextKey(chatJid: string): string {
  return `${OUTCOME_REVIEW_CONTEXT_PREFIX}${chatJid}`;
}

function getDelegationRuleContextKey(chatJid: string): string {
  return `${DELEGATION_RULE_CONTEXT_PREFIX}${chatJid}`;
}

interface SharedAssistantContextState {
  version: 1;
  createdAt: string;
  seed: AssistantCapabilityConversationSeed;
}

interface OutcomeReviewContextState {
  version: 1;
  createdAt: string;
  promptMatchJson: string;
  focusOutcomeIds: string[];
  primaryOutcomeId?: string | null;
  presentationMessageId?: string | null;
}

interface DelegationRuleContextState {
  version: 1;
  createdAt: string;
  previewJson?: string | null;
  previewId?: string | null;
  focusRuleIds?: string[];
  primaryRuleId?: string | null;
  presentationMessageId?: string | null;
}

const ACTIVE_REPO_ROOT = process.cwd();
const ACTIVE_ENTRY_PATH = path.resolve(ACTIVE_REPO_ROOT, 'dist', 'index.js');
const ACTIVE_ENV_PATH = path.resolve(ACTIVE_REPO_ROOT, '.env');
const ACTIVE_STORE_DB_PATH = path.join(STORE_DIR, 'messages.db');
const ACTIVE_GIT_BRANCH = readGitRef(['rev-parse', '--abbrev-ref', 'HEAD']);
const ACTIVE_GIT_COMMIT = readGitRef(['rev-parse', 'HEAD']);

function readGitRef(args: string[]): string {
  try {
    return execFileSync('git', ['-C', ACTIVE_REPO_ROOT, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function parseGitStatusPath(line: string): string | null {
  if (!line || line.length < 4) return null;
  const rawPath = line.slice(3).trim();
  if (!rawPath) return null;
  if (rawPath.includes(' -> ')) {
    return rawPath.split(' -> ').at(-1)?.trim() || null;
  }
  return rawPath;
}

function listCurrentGitDirtyPaths(): string[] {
  try {
    const output = execFileSync(
      'git',
      ['-C', ACTIVE_REPO_ROOT, 'status', '--porcelain'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => parseGitStatusPath(line))
      .filter((path): path is string => Boolean(path));
  } catch {
    return [];
  }
}

function normalizeTaskStatus(status: string | null | undefined): string {
  return (status || '').trim().toLowerCase();
}

function isSuccessfulResponseFeedbackTaskStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeTaskStatus(status);
  return (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'finished' ||
    normalized === 'succeeded' ||
    normalized === 'success'
  );
}

function isFailedResponseFeedbackTaskStatus(
  status: string | null | undefined,
): boolean {
  const normalized = normalizeTaskStatus(status);
  return (
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  );
}

function getCurrentMainChatAudit(): ReturnType<typeof auditRegisteredMainChat> {
  const registeredMainChat =
    (getRegisteredMainChat() as RegisteredMainChatRecord | undefined) || null;
  return auditRegisteredMainChat({
    registeredMainChat,
    chats: getAllChats(),
  });
}

function writeCurrentRuntimeAuditState(warningOverride?: string | null): void {
  const audit = getCurrentMainChatAudit();
  try {
    writeRuntimeAuditState({
      updatedAt: new Date().toISOString(),
      activeRepoRoot: ACTIVE_REPO_ROOT,
      activeGitBranch: ACTIVE_GIT_BRANCH,
      activeGitCommit: ACTIVE_GIT_COMMIT,
      activeEntryPath: ACTIVE_ENTRY_PATH,
      activeEnvPath: ACTIVE_ENV_PATH,
      activeStoreDbPath: ACTIVE_STORE_DB_PATH,
      activeRuntimeStateDir: RUNTIME_STATE_DIR,
      assistantName: ASSISTANT_NAME,
      assistantNameSource: ASSISTANT_NAME_SOURCE,
      registeredMainChatJid: audit.registeredMainChat?.jid || null,
      registeredMainChatName: audit.registeredMainChat?.name || null,
      registeredMainChatFolder: audit.registeredMainChat?.folder || null,
      registeredMainChatPresentInChats:
        audit.registeredMainChatPresentInChats,
      latestTelegramChatJid: audit.latestTelegramChat?.jid || null,
      latestTelegramChatName: audit.latestTelegramChat?.name || null,
      mainChatAuditWarning: warningOverride ?? audit.warning,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to persist runtime audit state');
  }
}

function reconcileRegisteredMainChatState(): void {
  const audit = getCurrentMainChatAudit();
  if (audit.warning) {
    logger.warn(
      {
        registeredMainChatJid: audit.registeredMainChat?.jid || null,
        latestTelegramChatJid: audit.latestTelegramChat?.jid || null,
      },
      audit.warning,
    );
  }

  if (
    audit.registeredMainChat &&
    audit.repairTargetChat &&
    audit.repairTargetChat.jid !== audit.registeredMainChat.jid
  ) {
    const repaired = repairRegisteredMainChat({
      fromJid: audit.registeredMainChat.jid,
      toJid: audit.repairTargetChat.jid,
      toName:
        audit.repairTargetChat.name || audit.registeredMainChat.name || 'Main',
    });
    logger.warn(
      {
        previousMainChatJid: audit.registeredMainChat.jid,
        repairedMainChatJid: repaired.jid,
      },
      'Repaired stale Telegram main chat registration',
    );
    loadState();
    writeCurrentRuntimeAuditState(
      `Main chat registration was repaired from ${audit.registeredMainChat.jid} to ${repaired.jid}.`,
    );
    return;
  }

  writeCurrentRuntimeAuditState();
}

function getPendingGoogleCalendarCreateState(
  chatJid: string,
): PendingGoogleCalendarCreateState | null {
  const raw = getRouterState(getGoogleCalendarPendingStateKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingGoogleCalendarCreateState;
    if (
      !parsed ||
      parsed.version !== 2 ||
      !parsed.step ||
      !parsed.draft ||
      !Array.isArray(parsed.calendars)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingGoogleCalendarCreateState(
  chatJid: string,
  state: PendingGoogleCalendarCreateState,
): void {
  setRouterState(
    getGoogleCalendarPendingStateKey(chatJid),
    JSON.stringify(state),
  );
}

function clearPendingGoogleCalendarCreateState(chatJid: string): void {
  deleteRouterState(getGoogleCalendarPendingStateKey(chatJid));
}

function getGoogleCalendarSchedulingContext(
  chatJid: string,
): GoogleCalendarSchedulingContextState | null {
  const raw = getRouterState(getGoogleCalendarSchedulingContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as GoogleCalendarSchedulingContextState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.title ||
      !parsed.durationMinutes
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setGoogleCalendarSchedulingContext(
  chatJid: string,
  state: GoogleCalendarSchedulingContextState,
): void {
  setRouterState(
    getGoogleCalendarSchedulingContextKey(chatJid),
    JSON.stringify(state),
  );
}

function clearGoogleCalendarSchedulingContext(chatJid: string): void {
  deleteRouterState(getGoogleCalendarSchedulingContextKey(chatJid));
}

function getActiveGoogleCalendarEventContext(
  chatJid: string,
): ActiveGoogleCalendarEventContextState | null {
  const raw = getRouterState(getGoogleCalendarActiveEventContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as ActiveGoogleCalendarEventContextState;
    if (!parsed || parsed.version !== 1 || !parsed.event?.id) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setActiveGoogleCalendarEventContext(
  chatJid: string,
  state: ActiveGoogleCalendarEventContextState,
): void {
  setRouterState(
    getGoogleCalendarActiveEventContextKey(chatJid),
    JSON.stringify(state),
  );
}

function clearActiveGoogleCalendarEventContext(chatJid: string): void {
  deleteRouterState(getGoogleCalendarActiveEventContextKey(chatJid));
}

function getPendingCalendarReminderState(
  chatJid: string,
): PendingCalendarReminderState | null {
  const raw = getRouterState(getGoogleCalendarPendingReminderKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingCalendarReminderState;
    if (!parsed || parsed.version !== 2 || !parsed.step || !parsed.offset) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingCalendarReminderState(
  chatJid: string,
  state: PendingCalendarReminderState,
): void {
  setRouterState(
    getGoogleCalendarPendingReminderKey(chatJid),
    JSON.stringify(state),
  );
}

function clearPendingCalendarReminderState(chatJid: string): void {
  deleteRouterState(getGoogleCalendarPendingReminderKey(chatJid));
}

function getPendingGoogleCalendarEventActionState(
  chatJid: string,
): PendingGoogleCalendarEventActionState | null {
  const raw = getRouterState(getGoogleCalendarPendingEventActionKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingGoogleCalendarEventActionState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.action ||
      !parsed.sourceEvent
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingGoogleCalendarEventActionState(
  chatJid: string,
  state: PendingGoogleCalendarEventActionState,
): void {
  setRouterState(
    getGoogleCalendarPendingEventActionKey(chatJid),
    JSON.stringify(state),
  );
}

function clearPendingGoogleCalendarEventActionState(chatJid: string): void {
  deleteRouterState(getGoogleCalendarPendingEventActionKey(chatJid));
}

function getPendingCalendarAutomationState(
  chatJid: string,
): PendingCalendarAutomationState | null {
  const raw = getRouterState(getGoogleCalendarPendingAutomationKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingCalendarAutomationState;
    if (!parsed || parsed.version !== 1 || !parsed.step) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingCalendarAutomationState(
  chatJid: string,
  state: PendingCalendarAutomationState,
): void {
  setRouterState(
    getGoogleCalendarPendingAutomationKey(chatJid),
    JSON.stringify(state),
  );
}

function clearPendingCalendarAutomationState(chatJid: string): void {
  deleteRouterState(getGoogleCalendarPendingAutomationKey(chatJid));
}

function getActionLayerContext(
  chatJid: string,
): ActionLayerContextState | null {
  const raw = getRouterState(getActionLayerContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as ActionLayerContextState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.label ||
      !parsed.sourceKind
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setActionLayerContext(
  chatJid: string,
  state: ActionLayerContextState,
): void {
  setRouterState(getActionLayerContextKey(chatJid), JSON.stringify(state));
}

function clearActionLayerContext(chatJid: string): void {
  deleteRouterState(getActionLayerContextKey(chatJid));
}

function getPendingActionReminderState(
  chatJid: string,
): PendingActionReminderState | null {
  const raw = getRouterState(getActionLayerPendingReminderKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingActionReminderState;
    if (!parsed || parsed.version !== 1 || !parsed.label) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingActionReminderState(
  chatJid: string,
  state: PendingActionReminderState,
): void {
  setRouterState(
    getActionLayerPendingReminderKey(chatJid),
    JSON.stringify(state),
  );
}

function clearPendingActionReminderState(chatJid: string): void {
  deleteRouterState(getActionLayerPendingReminderKey(chatJid));
}

function getPendingActionDraftState(
  chatJid: string,
): PendingActionDraftState | null {
  const raw = getRouterState(getActionLayerPendingDraftKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as PendingActionDraftState;
    if (!parsed || parsed.version !== 1 || !parsed.step || !parsed.draftKind) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function setPendingActionDraftState(
  chatJid: string,
  state: PendingActionDraftState,
): void {
  setRouterState(getActionLayerPendingDraftKey(chatJid), JSON.stringify(state));
}

function clearPendingActionDraftState(chatJid: string): void {
  deleteRouterState(getActionLayerPendingDraftKey(chatJid));
}

function getDailyCompanionContext(
  chatJid: string,
  now = new Date(),
): DailyCompanionContext | null {
  const raw = getRouterState(getDailyCompanionContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as DailyCompanionContext;
    if (!parsed || parsed.version !== 1 || !parsed.generatedAt) {
      clearDailyCompanionContext(chatJid);
      return null;
    }

    const generatedAtMs = Date.parse(parsed.generatedAt);
    if (
      !Number.isFinite(generatedAtMs) ||
      generatedAtMs + DAILY_COMPANION_CONTEXT_TTL_MS < now.getTime()
    ) {
      clearDailyCompanionContext(chatJid);
      return null;
    }

    return {
      ...parsed,
      usedThreadIds: parsed.usedThreadIds || [],
      usedThreadTitles: parsed.usedThreadTitles || [],
      usedThreadReasons: parsed.usedThreadReasons || [],
      threadSummaryLines: parsed.threadSummaryLines || [],
      comparisonKeys: {
        ...parsed.comparisonKeys,
        thread: parsed.comparisonKeys?.thread || null,
      },
    };
  } catch {
    clearDailyCompanionContext(chatJid);
    return null;
  }
}

function setDailyCompanionContext(
  chatJid: string,
  context: DailyCompanionContext,
): void {
  setRouterState(getDailyCompanionContextKey(chatJid), JSON.stringify(context));
}

function clearDailyCompanionContext(chatJid: string): void {
  deleteRouterState(getDailyCompanionContextKey(chatJid));
}

function getOutcomeReviewContext(
  chatJid: string,
  now = new Date(),
): OutcomeReviewContextState | null {
  const raw = getRouterState(getOutcomeReviewContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as OutcomeReviewContextState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.createdAt ||
      !parsed.promptMatchJson ||
      !Array.isArray(parsed.focusOutcomeIds)
    ) {
      clearOutcomeReviewContext(chatJid);
      return null;
    }

    const createdAtMs = Date.parse(parsed.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs + OUTCOME_REVIEW_CONTEXT_TTL_MS < now.getTime()
    ) {
      clearOutcomeReviewContext(chatJid);
      return null;
    }

    return parsed;
  } catch {
    clearOutcomeReviewContext(chatJid);
    return null;
  }
}

function setOutcomeReviewContext(
  chatJid: string,
  state: OutcomeReviewContextState,
): void {
  setRouterState(getOutcomeReviewContextKey(chatJid), JSON.stringify(state));
}

function clearOutcomeReviewContext(chatJid: string): void {
  deleteRouterState(getOutcomeReviewContextKey(chatJid));
}

function getDelegationRuleContext(
  chatJid: string,
  now = new Date(),
): DelegationRuleContextState | null {
  const raw = getRouterState(getDelegationRuleContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as DelegationRuleContextState;
    if (!parsed || parsed.version !== 1 || !parsed.createdAt) {
      clearDelegationRuleContext(chatJid);
      return null;
    }
    const createdAtMs = Date.parse(parsed.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs + OUTCOME_REVIEW_CONTEXT_TTL_MS < now.getTime()
    ) {
      clearDelegationRuleContext(chatJid);
      return null;
    }
    return parsed;
  } catch {
    clearDelegationRuleContext(chatJid);
    return null;
  }
}

function setDelegationRuleContext(
  chatJid: string,
  state: DelegationRuleContextState,
): void {
  setRouterState(getDelegationRuleContextKey(chatJid), JSON.stringify(state));
}

function clearDelegationRuleContext(chatJid: string): void {
  deleteRouterState(getDelegationRuleContextKey(chatJid));
}

function getSharedAssistantCapabilitySeed(
  chatJid: string,
  now = new Date(),
): AssistantCapabilityConversationSeed | null {
  const raw = getRouterState(getSharedAssistantContextKey(chatJid));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as SharedAssistantContextState;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.createdAt ||
      !parsed.seed?.flowKey ||
      !parsed.seed?.summaryText
    ) {
      clearSharedAssistantCapabilitySeed(chatJid);
      return null;
    }

    const createdAtMs = Date.parse(parsed.createdAt);
    if (
      !Number.isFinite(createdAtMs) ||
      createdAtMs + SHARED_ASSISTANT_CONTEXT_TTL_MS < now.getTime()
    ) {
      clearSharedAssistantCapabilitySeed(chatJid);
      return null;
    }

    return parsed.seed;
  } catch {
    clearSharedAssistantCapabilitySeed(chatJid);
    return null;
  }
}

function setSharedAssistantCapabilitySeed(
  chatJid: string,
  seed: AssistantCapabilityConversationSeed,
  now = new Date(),
): void {
  const state: SharedAssistantContextState = {
    version: 1,
    createdAt: now.toISOString(),
    seed,
  };
  setRouterState(getSharedAssistantContextKey(chatJid), JSON.stringify(state));
}

function clearSharedAssistantCapabilitySeed(chatJid: string): void {
  deleteRouterState(getSharedAssistantContextKey(chatJid));
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseBundleCommand(rawText: string):
  | {
      bundleId: string;
      operation:
        | { kind: 'approve_all' }
        | { kind: 'enter_selection' }
        | { kind: 'toggle_action'; orderIndex: number }
        | { kind: 'run_selected' }
        | { kind: 'skip_selected' }
        | { kind: 'defer_all' }
        | { kind: 'show' };
    }
  | null {
  const trimmed = rawText.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const bundleId = parts[1];
  if (!bundleId) return null;
  if (command === '/bundle-run-all') {
    return { bundleId, operation: { kind: 'approve_all' } };
  }
  if (command === '/bundle-pick') {
    return { bundleId, operation: { kind: 'enter_selection' } };
  }
  if (command === '/bundle-toggle') {
    const orderIndex = Number.parseInt(parts[2] || '', 10);
    if (!Number.isFinite(orderIndex) || orderIndex < 1) return null;
    return { bundleId, operation: { kind: 'toggle_action', orderIndex } };
  }
  if (command === '/bundle-run-selected') {
    return { bundleId, operation: { kind: 'run_selected' } };
  }
  if (command === '/bundle-skip-selected') {
    return { bundleId, operation: { kind: 'skip_selected' } };
  }
  if (command === '/bundle-defer') {
    return { bundleId, operation: { kind: 'defer_all' } };
  }
  if (command === '/bundle-show') {
    return { bundleId, operation: { kind: 'show' } };
  }
  return null;
}

function parseMessageActionCommand(rawText: string):
  | {
      messageActionId: string;
      operation: MessageActionOperation;
    }
  | null {
  const trimmed = rawText.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const messageActionId = parts[1];
  if (!messageActionId) return null;
  if (command === '/message-show') {
    return { messageActionId, operation: { kind: 'show' } };
  }
  if (command === '/message-send') {
    return { messageActionId, operation: { kind: 'send' } };
  }
  if (command === '/message-send-again') {
    return { messageActionId, operation: { kind: 'send_again' } };
  }
  if (command === '/message-later') {
    return { messageActionId, operation: { kind: 'defer' } };
  }
  if (command === '/message-cancel-later') {
    return { messageActionId, operation: { kind: 'cancel_deferred' } };
  }
  if (command === '/message-remind') {
    return { messageActionId, operation: { kind: 'remind_instead' } };
  }
  if (command === '/message-save-thread') {
    return { messageActionId, operation: { kind: 'save_to_thread' } };
  }
  if (command === '/message-skip') {
    return { messageActionId, operation: { kind: 'skip' } };
  }
  if (command === '/message-why') {
    return { messageActionId, operation: { kind: 'why' } };
  }
  if (command === '/message-rewrite') {
    const style = (parts[2] || '').toLowerCase();
    if (style === 'shorter') {
      return { messageActionId, operation: { kind: 'rewrite', style: 'shorter' } };
    }
    if (style === 'warmer') {
      return { messageActionId, operation: { kind: 'rewrite', style: 'warmer' } };
    }
    if (style === 'direct') {
      return {
        messageActionId,
        operation: { kind: 'rewrite', style: 'more_direct' },
      };
    }
  }
  return null;
}

function parseReviewCommand(rawText: string):
  | {
      outcomeId: string;
      control:
        | { kind: 'mark_handled' }
        | { kind: 'still_open' }
        | { kind: 'remind_tomorrow' }
        | { kind: 'hide' }
        | { kind: 'show' };
    }
  | null {
  const trimmed = rawText.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const outcomeId = parts[1];
  if (!outcomeId) return null;
  if (command === '/review-handle') {
    return { outcomeId, control: { kind: 'mark_handled' } };
  }
  if (command === '/review-open') {
    return { outcomeId, control: { kind: 'still_open' } };
  }
  if (command === '/review-remind-tomorrow') {
    return { outcomeId, control: { kind: 'remind_tomorrow' } };
  }
  if (command === '/review-hide') {
    return { outcomeId, control: { kind: 'hide' } };
  }
  if (command === '/review-show') {
    return { outcomeId, control: { kind: 'show' } };
  }
  return null;
}

function parseDelegationRuleCommand(rawText: string):
  | {
      command:
        | 'confirm_preview'
        | 'cancel_preview'
        | 'pause'
        | 'disable'
        | 'always_ask'
        | 'auto_safe'
        | 'why'
        | 'use_here';
      targetId: string;
    }
  | null {
  const trimmed = rawText.trim();
  const parts = trimmed.split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const targetId = parts[1];
  if (!targetId) return null;
  if (command === '/rule-confirm') {
    return { command: 'confirm_preview', targetId };
  }
  if (command === '/rule-cancel') {
    return { command: 'cancel_preview', targetId };
  }
  if (command === '/rule-pause') {
    return { command: 'pause', targetId };
  }
  if (command === '/rule-disable') {
    return { command: 'disable', targetId };
  }
  if (command === '/rule-always-ask') {
    return { command: 'always_ask', targetId };
  }
  if (command === '/rule-auto-safe') {
    return { command: 'auto_safe', targetId };
  }
  if (command === '/rule-why') {
    return { command: 'why', targetId };
  }
  if (command === '/rule-use-here') {
    return { command: 'use_here', targetId };
  }
  return null;
}

async function applyAndPresentActionBundle(params: {
  chatJid: string;
  bundleId: string;
  operation: ActionBundleOperation;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  const conversationChannel =
    channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram';
  const result = await applyActionBundleOperation(
    params.bundleId,
    params.operation,
    {
      groupFolder: group.folder,
      channel: conversationChannel,
      chatJid: params.chatJid,
      currentTime: params.now,
      resolveTelegramMainChat: resolveTelegramMainChatForAlexa,
      resolveBlueBubblesCompanionChat: resolveBlueBubblesCompanionChat,
      resolveHandoffTarget: resolveCompanionHandoffTarget,
      sendTelegramMessage: sendCompanionHandoffMessageToChannel,
      sendBlueBubblesMessage: sendCompanionHandoffMessageToChannel,
      sendHandoffMessage: sendCompanionHandoffMessage,
      sendTelegramArtifact: sendCompanionHandoffArtifactToChannel,
      sendHandoffArtifact: sendCompanionHandoffArtifact,
    },
  );
  if (!result.handled) return false;

  if (channel.name === 'telegram' && result.presentation) {
    const messageId = result.snapshot?.bundle.presentationMessageId || null;
    const firstRuleAction = result.snapshot?.actions.find(
      (action) => action.delegationRuleId,
    );
    if (messageId && channel.editMessage) {
      await channel.editMessage(params.chatJid, messageId, result.presentation.text, {
        inlineActionRows: result.presentation.inlineActionRows,
      });
      rememberActionBundlePresentation({
        bundleId: params.bundleId,
        messageId,
        mode: result.presentation.mode,
        now: params.now,
      });
      if (firstRuleAction?.delegationRuleId) {
        setDelegationRuleContext(params.chatJid, {
          version: 1,
          createdAt: (params.now || new Date()).toISOString(),
          focusRuleIds: [firstRuleAction.delegationRuleId],
          primaryRuleId: firstRuleAction.delegationRuleId,
          presentationMessageId: messageId,
        });
      }
    } else {
      const sent = await channel.sendMessage(params.chatJid, result.presentation.text, {
        inlineActionRows: result.presentation.inlineActionRows,
      });
      rememberActionBundlePresentation({
        bundleId: params.bundleId,
        messageId: sent.platformMessageId || null,
        mode: result.presentation.mode,
        now: params.now,
      });
      if (firstRuleAction?.delegationRuleId) {
        setDelegationRuleContext(params.chatJid, {
          version: 1,
          createdAt: (params.now || new Date()).toISOString(),
          focusRuleIds: [firstRuleAction.delegationRuleId],
          primaryRuleId: firstRuleAction.delegationRuleId,
          presentationMessageId: sent.platformMessageId || null,
        });
      }
    }
  }

  if (result.replyText) {
    await channel.sendMessage(params.chatJid, result.replyText);
  }

  return true;
}

async function applyAndPresentMessageAction(params: {
  chatJid: string;
  messageActionId: string;
  operation: MessageActionOperation;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  const conversationChannel =
    channel.name === 'bluebubbles'
      ? 'bluebubbles'
      : channel.name === 'telegram'
        ? 'telegram'
        : 'alexa';
  const result = await applyMessageActionOperation(
    params.messageActionId,
    params.operation,
    {
      groupFolder: group.folder,
      channel: conversationChannel,
      chatJid: params.chatJid,
      currentTime: params.now,
      sendToTarget: (targetChannel, chatJid, text, options) =>
        sendCompanionHandoffMessage(targetChannel, chatJid, text, options),
    },
  );
  if (!result.handled) return false;

  if (channel.name === 'telegram' && result.presentation) {
    const messageId = result.action?.presentationMessageId || null;
    if (messageId && channel.editMessage) {
      await channel.editMessage(params.chatJid, messageId, result.presentation.text, {
        inlineActionRows: result.presentation.inlineActionRows,
      });
    } else {
      const sent = await channel.sendMessage(params.chatJid, result.presentation.text, {
        inlineActionRows: result.presentation.inlineActionRows,
      });
      updateMessageAction(params.messageActionId, {
        presentationMessageId: sent.platformMessageId || null,
        presentationChatJid: params.chatJid,
        lastUpdatedAt: (params.now || new Date()).toISOString(),
      });
    }
    if (result.replyText && !['show', 'show_draft'].includes(params.operation.kind)) {
      await channel.sendMessage(params.chatJid, result.replyText);
    }
    return true;
  }

  if (result.replyText) {
    await channel.sendMessage(params.chatJid, result.replyText);
  } else if (result.presentation) {
    await channel.sendMessage(params.chatJid, result.presentation.text);
  }
  return true;
}

async function applyAndPresentOutcomeReviewControl(params: {
  chatJid: string;
  outcomeId: string;
  control:
    | { kind: 'mark_handled' }
    | { kind: 'still_open' }
    | { kind: 'remind_tomorrow' }
    | { kind: 'hide' }
    | { kind: 'show' };
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;

  const result = applyOutcomeReviewControl({
    groupFolder: group.folder,
    outcomeId: params.outcomeId,
    control: params.control,
    chatJid: params.chatJid,
    now: params.now,
  });
  if (!result.handled) return false;

  const context = getOutcomeReviewContext(params.chatJid, params.now || new Date());
  let refreshedPresentation:
    | ReturnType<typeof buildOutcomeReviewResponse>
    | undefined;
  let nextContext: OutcomeReviewContextState | null = null;

  if (
    channel.name === 'telegram' &&
    context?.promptMatchJson &&
    params.control.kind !== 'show'
  ) {
    try {
      const promptMatch = JSON.parse(
        context.promptMatchJson,
      ) as OutcomeReviewPromptMatch;
      refreshedPresentation = buildOutcomeReviewResponse({
        groupFolder: group.folder,
        match: promptMatch,
        channel: 'telegram',
        now: params.now,
        timeZone: TIMEZONE,
      });
      nextContext = {
        version: 1,
        createdAt: (params.now || new Date()).toISOString(),
        promptMatchJson: context.promptMatchJson,
        focusOutcomeIds: refreshedPresentation.focusOutcomeIds,
        primaryOutcomeId: refreshedPresentation.primaryOutcomeId || null,
        presentationMessageId: context.presentationMessageId || null,
      };
    } catch {
      nextContext = null;
    }
  }

  if (
    refreshedPresentation &&
    context?.presentationMessageId &&
    channel.editMessage
  ) {
    await channel.editMessage(
      params.chatJid,
      context.presentationMessageId,
      refreshedPresentation.text,
      { inlineActionRows: refreshedPresentation.inlineActionRows },
    );
    setOutcomeReviewContext(params.chatJid, {
      ...(nextContext || context),
      presentationMessageId: context.presentationMessageId,
    });
  } else if (refreshedPresentation && channel.name === 'telegram') {
    const sent = await channel.sendMessage(
      params.chatJid,
      refreshedPresentation.text,
      { inlineActionRows: refreshedPresentation.inlineActionRows },
    );
    setOutcomeReviewContext(params.chatJid, {
      ...(nextContext || {
        version: 1,
        createdAt: (params.now || new Date()).toISOString(),
        promptMatchJson: context?.promptMatchJson || '',
        focusOutcomeIds: refreshedPresentation.focusOutcomeIds,
        primaryOutcomeId: refreshedPresentation.primaryOutcomeId || null,
        presentationMessageId: sent.platformMessageId || null,
      }),
      presentationMessageId: sent.platformMessageId || null,
    });
  }

  if (
    result.replyText &&
    (params.control.kind === 'show' || !refreshedPresentation)
  ) {
    await channel.sendMessage(params.chatJid, result.replyText);
  }

  return true;
}

async function applyAndPresentDelegationRuleCommand(params: {
  chatJid: string;
  command:
    | 'confirm_preview'
    | 'cancel_preview'
    | 'pause'
    | 'disable'
    | 'always_ask'
    | 'auto_safe'
    | 'why'
    | 'use_here';
  targetId: string;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  const now = params.now || new Date();
  const context = getDelegationRuleContext(params.chatJid, now);

  if (params.command === 'confirm_preview') {
    if (!context?.previewJson || context.previewId !== params.targetId) return false;
    try {
      const preview = JSON.parse(context.previewJson);
      const rule = saveDelegationRuleFromPreview(group.folder, preview, now);
      clearDelegationRuleContext(params.chatJid);
      const presentation = buildDelegationRuleListPresentation({
        groupFolder: group.folder,
        channel: channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      });
      await channel.sendMessage(
        params.chatJid,
        `Andrea: I saved that as a delegation rule.\n\n${presentation.text}`,
        { inlineActionRows: presentation.inlineActionRows },
      );
      setDelegationRuleContext(params.chatJid, {
        version: 1,
        createdAt: now.toISOString(),
        focusRuleIds: presentation.focusRuleIds,
        primaryRuleId: rule.ruleId,
      });
      return true;
    } catch {
      clearDelegationRuleContext(params.chatJid);
      return false;
    }
  }

  if (params.command === 'cancel_preview') {
    if (context?.previewId !== params.targetId) return false;
    clearDelegationRuleContext(params.chatJid);
    await channel.sendMessage(
      params.chatJid,
      'Andrea: Okay — I did not save that delegation rule.',
    );
    return true;
  }

  if (params.command === 'pause') {
    updateDelegationRule(params.targetId, { status: 'paused' });
  } else if (params.command === 'disable') {
    updateDelegationRule(params.targetId, { status: 'disabled' });
  } else if (params.command === 'always_ask') {
    updateDelegationRuleMode(params.targetId, 'always_ask');
  } else if (params.command === 'auto_safe') {
    updateDelegationRuleMode(params.targetId, 'auto_apply_when_safe');
  } else if (params.command === 'use_here') {
    retargetDelegationRuleChannels(
      params.targetId,
      [channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram'],
    );
  } else if (params.command === 'why') {
    const rule = getDelegationRule(params.targetId);
    if (!rule) return false;
    await channel.sendMessage(params.chatJid, buildDelegationRuleWhyText(rule));
    setDelegationRuleContext(params.chatJid, {
      version: 1,
      createdAt: now.toISOString(),
      focusRuleIds: [rule.ruleId],
      primaryRuleId: rule.ruleId,
    });
    return true;
  }

  const presentation = buildDelegationRuleListPresentation({
    groupFolder: group.folder,
    channel: channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram',
  });
  await channel.sendMessage(params.chatJid, presentation.text, {
    inlineActionRows: presentation.inlineActionRows,
  });
  setDelegationRuleContext(params.chatJid, {
    version: 1,
    createdAt: now.toISOString(),
    focusRuleIds: presentation.focusRuleIds,
    primaryRuleId: params.targetId,
  });
  return true;
}

const CALENDAR_LOOKUP_TOMORROW_PROMPT = "What's on my calendar tomorrow?";
const CALENDAR_LOOKUP_WEEK_PROMPT = "What's on my calendar this week?";
const CALENDAR_LOOKUP_POINT_PROMPT = 'Do I have anything at 3pm tomorrow?';
const CALENDAR_LOOKUP_FREE_PROMPT = 'Am I free Friday afternoon?';
const CALENDAR_LOOKUP_COMING_SOON_PROMPT = 'What do I have coming up soon?';
const CALENDAR_LOOKUP_TODAY_AWARENESS_PROMPT =
  'What should I know about today?';
const CALENDAR_LOOKUP_MORNING_BRIEF_PROMPT =
  'Give me a morning brief for tomorrow';

function resolveSafeCalendarRefreshPrompt(refreshPrompt: string): string {
  const normalized = refreshPrompt.trim();
  if (!normalized) {
    return CALENDAR_LOOKUP_TOMORROW_PROMPT;
  }

  const lower = normalized.toLowerCase();
  let candidate = normalized;
  if (
    /\bcoming up soon\b/.test(lower) ||
    /\bnext two hours\b/.test(lower) ||
    /\bcoming up in the next two hours\b/.test(lower)
  ) {
    candidate = CALENDAR_LOOKUP_COMING_SOON_PROMPT;
  } else if (
    /\bwhat should i know about today\b/.test(lower) ||
    /\brest of today\b/.test(lower)
  ) {
    candidate = CALENDAR_LOOKUP_TODAY_AWARENESS_PROMPT;
  } else if (
    /\bmorning brief\b/.test(lower) ||
    /\bwhat do i need to know about tomorrow\b/.test(lower)
  ) {
    candidate = CALENDAR_LOOKUP_MORNING_BRIEF_PROMPT;
  }

  return Buffer.byteLength(candidate, 'utf8') <= 60
    ? candidate
    : CALENDAR_LOOKUP_TOMORROW_PROMPT;
}

function formatCalendarPanelText(title: string, body: string): string {
  return formatWorkPanel({
    title,
    sections: [stripLeadingMarkdownTitle(body)],
  });
}

function resolveConversationalChannelForChannelName(
  channelName: string,
): ConversationalChannel {
  if (channelName === 'bluebubbles' || channelName === 'alexa') {
    return channelName;
  }
  return 'telegram';
}

function isGoogleCalendarAuthOrConfigDetail(
  detail: string | null | undefined,
): boolean {
  return isGoogleCalendarAuthFailureKind(
    classifyGoogleCalendarFailureDetail(detail),
  );
}

function isTransientCalendarHostWindow(): boolean {
  try {
    const reconciliation = reconcileWindowsHostState({
      projectRoot: process.cwd(),
    });
    return (
      reconciliation.serviceState === 'starting' ||
      reconciliation.serviceState === 'process_stale'
    );
  } catch {
    return false;
  }
}

function isTransientCalendarFailureDetail(
  detail: string | null | undefined,
): boolean {
  if (!detail) return false;
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('network') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('service unavailable')
  );
}

function resolveCalendarCompanionFailureKind(params: {
  technicalDetail?: string | null;
  transientHostUnavailable?: boolean;
  fallbackKind?: Exclude<CalendarCompanionFailureKind, 'temporary_unavailable'>;
}): CalendarCompanionFailureKind {
  const classifiedFailure = classifyGoogleCalendarFailureDetail(
    params.technicalDetail,
  );
  if (
    params.transientHostUnavailable ||
    isTransientCalendarFailureDetail(params.technicalDetail) ||
    classifiedFailure === 'temporary_unavailable'
  ) {
    return 'temporary_unavailable';
  }
  if (params.fallbackKind) {
    return params.fallbackKind;
  }
  if (isGoogleCalendarAuthOrConfigDetail(params.technicalDetail)) {
    return 'calendar_auth_unavailable';
  }
  return 'calendar_access_unavailable';
}

function buildCalendarCompanionFailurePanelText(params: {
  title: string;
  channelName: string;
  action: 'create_event' | 'confirm_reminder';
  technicalDetail?: string | null;
  fallbackKind?: Exclude<CalendarCompanionFailureKind, 'temporary_unavailable'>;
}): string {
  const transientHostUnavailable = isTransientCalendarHostWindow();
  return formatCalendarPanelText(
    params.title,
    buildCalendarCompanionFailureReply({
      channel: resolveConversationalChannelForChannelName(params.channelName),
      action: params.action,
      kind: resolveCalendarCompanionFailureKind({
        technicalDetail: params.technicalDetail,
        transientHostUnavailable,
        fallbackKind: params.fallbackKind,
      }),
    }),
  );
}

function formatDailyCompanionPanelTitle(mode: DailyCompanionMode): string {
  switch (mode) {
    case 'morning_brief':
      return '*Morning Brief*';
    case 'midday_reground':
      return '*Right Now*';
    case 'evening_reset':
      return '*Evening Reset*';
    case 'household_guidance':
      return '*Household*';
    default:
      return '*Daily Companion*';
  }
}

function buildCalendarLookupInlineActionRows(
  refreshPrompt: string,
): SendMessageOptions['inlineActionRows'] {
  return [
    [
      {
        label: 'Refresh',
        actionId: resolveSafeCalendarRefreshPrompt(refreshPrompt),
      },
      { label: 'Tomorrow', actionId: CALENDAR_LOOKUP_TOMORROW_PROMPT },
    ],
    [
      { label: 'This Week', actionId: CALENDAR_LOOKUP_WEEK_PROMPT },
      { label: '3 PM Tomorrow', actionId: CALENDAR_LOOKUP_POINT_PROMPT },
    ],
    [{ label: 'Friday Afternoon', actionId: CALENDAR_LOOKUP_FREE_PROMPT }],
  ];
}

function buildGoogleCalendarCreateInlineActionRows(
  state: PendingGoogleCalendarCreateState,
): SendMessageOptions['inlineActionRows'] {
  if (state.step === 'choose_calendar') {
    const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
    for (let index = 0; index < state.calendars.length; index += 2) {
      const slice = state.calendars
        .slice(index, index + 2)
        .map((calendar, offset) => ({
          label: `${index + offset + 1}. ${calendar.summary}${calendar.primary ? ' (primary)' : ''}`,
          actionId: String(index + offset + 1),
        }));
      rows.push(slice);
    }
    rows.push([{ label: 'Cancel', actionId: 'cancel' }]);
    return rows;
  }

  const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
  if (state.conflictSummary?.suggestions.length) {
    rows.push(
      state.conflictSummary.suggestions.slice(0, 2).map((_, index) => ({
        label: `Option ${index + 1}`,
        actionId: String(index + 1),
      })),
    );
  }
  rows.push([
    {
      label: state.conflictSummary?.blockingEvents.length
        ? 'Create Anyway'
        : 'Create',
      actionId: 'yes',
    },
    { label: 'Cancel', actionId: 'cancel' },
  ]);
  return rows;
}

function buildGoogleCalendarCreatedInlineActionRows(params: {
  htmlLink?: string | null;
}): SendMessageOptions['inlineActionRows'] {
  const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
  if (params.htmlLink) {
    rows.push([{ label: 'Open in Google Calendar', url: params.htmlLink }]);
  }
  rows.push([
    { label: 'Tomorrow', actionId: CALENDAR_LOOKUP_TOMORROW_PROMPT },
    { label: 'This Week', actionId: CALENDAR_LOOKUP_WEEK_PROMPT },
  ]);
  rows.push([
    { label: 'Friday Afternoon', actionId: CALENDAR_LOOKUP_FREE_PROMPT },
  ]);
  return rows;
}

function buildCalendarReminderInlineActionRows(
  state: PendingCalendarReminderState,
): SendMessageOptions['inlineActionRows'] {
  if (state.step === 'clarify_event' && state.candidates.length > 0) {
    return [
      state.candidates.slice(0, 3).map((_, index) => ({
        label: `${index + 1}`,
        actionId: String(index + 1),
      })),
      [{ label: 'Cancel', actionId: 'cancel' }],
    ];
  }

  if (state.step === 'clarify_time' || state.step === 'clarify_offset') {
    return [[{ label: 'Cancel', actionId: 'cancel' }]];
  }

  return [
    [
      { label: 'Confirm', actionId: 'yes' },
      { label: 'Cancel', actionId: 'cancel' },
    ],
  ];
}

function buildGoogleCalendarEventActionInlineRows(
  state: PendingGoogleCalendarEventActionState,
): SendMessageOptions['inlineActionRows'] {
  if (state.step === 'choose_calendar') {
    const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
    for (let index = 0; index < state.calendars.length; index += 2) {
      rows.push(
        state.calendars.slice(index, index + 2).map((calendar, offset) => ({
          label: `${index + offset + 1}. ${calendar.summary}${calendar.primary ? ' (primary)' : ''}`,
          actionId: String(index + offset + 1),
        })),
      );
    }
    rows.push([{ label: 'Cancel', actionId: 'cancel' }]);
    return rows;
  }

  const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
  if (state.conflictSummary?.suggestions.length) {
    rows.push(
      state.conflictSummary.suggestions.slice(0, 2).map((_, index) => ({
        label: `Option ${index + 1}`,
        actionId: String(index + 1),
      })),
    );
  }
  rows.push([
    {
      label:
        state.action === 'delete'
          ? 'Delete'
          : state.conflictSummary?.blockingEvents.length
            ? 'Update Anyway'
            : 'Update',
      actionId: 'yes',
    },
    { label: 'Cancel', actionId: 'cancel' },
  ]);
  return rows;
}

function getCalendarAutomationSummaries(
  chatJid: string,
): CalendarAutomationSummary[] {
  return listCalendarAutomationsForChat(chatJid).map(
    parseCalendarAutomationRecord,
  );
}

function buildCalendarAutomationInlineActionRows(
  state: PendingCalendarAutomationState,
): SendMessageOptions['inlineActionRows'] {
  if (state.step === 'clarify_time' || state.step === 'clarify_offset') {
    return [[{ label: 'Cancel', actionId: 'cancel' }]];
  }
  return [
    [
      { label: 'Confirm', actionId: 'yes' },
      { label: 'Cancel', actionId: 'cancel' },
    ],
  ];
}

function toGoogleCalendarSchedulingContextState(
  context: CalendarSchedulingContext,
  now = new Date(),
): GoogleCalendarSchedulingContextState {
  return {
    version: 1,
    createdAt: now.toISOString(),
    title: context.title,
    durationMinutes: context.durationMinutes,
    timeZone: context.timeZone,
  };
}

function getDraftDurationMinutes(
  state: PendingGoogleCalendarCreateState,
): number {
  return Math.max(
    15,
    Math.round(
      (new Date(state.draft.endIso).getTime() -
        new Date(state.draft.startIso).getTime()) /
        (60 * 1000),
    ),
  );
}

function eventOverlapsDraftWindow(
  event: GoogleCalendarEventRecord,
  start: Date,
  end: Date,
): boolean {
  if (event.allDay) {
    return false;
  }
  const eventStart = new Date(event.startIso).getTime();
  const eventEnd = new Date(event.endIso).getTime();
  return eventStart < end.getTime() && eventEnd > start.getTime();
}

function formatSuggestionLabel(
  start: Date,
  end: Date,
  timeZone: string,
): string {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${dateFormatter.format(start)}, ${timeFormatter.format(start)}-${timeFormatter.format(end)}`;
}

async function enrichPendingGoogleCalendarCreateStateWithConflicts(
  state: PendingGoogleCalendarCreateState,
): Promise<PendingGoogleCalendarCreateState> {
  if (state.step !== 'confirm_create' || state.draft.allDay) {
    return {
      ...state,
      conflictSummary: null,
    };
  }

  const googleConfig = resolveGoogleCalendarConfig();
  const draftStart = new Date(state.draft.startIso);
  const draftEnd = new Date(state.draft.endIso);
  const dayStart = new Date(draftStart);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const { events, failures } = await listGoogleCalendarEvents(
    {
      start: dayStart,
      end: dayEnd,
      calendarIds: googleConfig.calendarIds,
    },
    googleConfig,
  );

  const blocking = events
    .filter((event) => eventOverlapsDraftWindow(event, draftStart, draftEnd))
    .map<GoogleCalendarConflictEvent>((event) => ({
      title: event.title,
      startIso: event.startIso,
      endIso: event.endIso,
      allDay: event.allDay,
      calendarName: event.calendarName,
    }));

  if (blocking.length === 0) {
    return {
      ...state,
      conflictSummary:
        failures.length > 0
          ? {
              blockingEvents: [],
              suggestions: [],
              selectedSuggestionStartIso: null,
              warningMessage:
                "I couldn't fully verify conflicts across every selected Google calendar right now.",
            }
          : null,
    };
  }

  const durationMinutes = getDraftDurationMinutes(state);
  const suggestions: GoogleCalendarDraftConflictSummary['suggestions'] = [];
  const sortedTimedEvents = events
    .filter((event) => !event.allDay)
    .sort(
      (left, right) =>
        new Date(left.startIso).getTime() - new Date(right.startIso).getTime(),
    );
  const seen = new Set<string>();

  const slotFits = (candidateStart: Date): boolean => {
    const candidateEnd = new Date(
      candidateStart.getTime() + durationMinutes * 60 * 1000,
    );
    if (
      candidateStart.getTime() < dayStart.getTime() ||
      candidateEnd.getTime() > dayEnd.getTime()
    ) {
      return false;
    }
    return !sortedTimedEvents.some((event) =>
      eventOverlapsDraftWindow(event, candidateStart, candidateEnd),
    );
  };

  for (const direction of [1, -1] as const) {
    for (
      let offsetMinutes = 15;
      offsetMinutes <= 8 * 60 && suggestions.length < 2;
      offsetMinutes += 15
    ) {
      const candidateStart = new Date(
        draftStart.getTime() + direction * offsetMinutes * 60 * 1000,
      );
      const candidateEnd = new Date(
        candidateStart.getTime() + durationMinutes * 60 * 1000,
      );
      const key = `${candidateStart.toISOString()}::${candidateEnd.toISOString()}`;
      if (seen.has(key) || !slotFits(candidateStart)) {
        continue;
      }
      seen.add(key);
      suggestions.push({
        startIso: candidateStart.toISOString(),
        endIso: candidateEnd.toISOString(),
        label: formatSuggestionLabel(
          candidateStart,
          candidateEnd,
          state.draft.timeZone,
        ),
      });
    }
  }

  return {
    ...state,
    conflictSummary: {
      blockingEvents: blocking,
      suggestions,
      selectedSuggestionStartIso: null,
      warningMessage:
        failures.length > 0
          ? "I couldn't fully verify conflicts across every selected Google calendar right now."
          : null,
    },
  };
}

async function enrichPendingGoogleCalendarEventActionStateWithConflicts(
  state: PendingGoogleCalendarEventActionState,
): Promise<PendingGoogleCalendarEventActionState> {
  if (state.action !== 'move' && state.action !== 'resize') {
    return {
      ...state,
      conflictSummary: null,
    };
  }

  const targetEvent = state.proposedEvent || state.sourceEvent;
  if (targetEvent.allDay) {
    return {
      ...state,
      conflictSummary: null,
    };
  }

  const googleConfig = resolveGoogleCalendarConfig();
  const targetStart = new Date(targetEvent.startIso);
  const targetEnd = new Date(targetEvent.endIso);
  const dayStart = new Date(targetStart);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const { events, failures } = await listGoogleCalendarEvents(
    {
      start: dayStart,
      end: dayEnd,
      calendarIds: googleConfig.calendarIds,
    },
    googleConfig,
  );

  const blocking = events
    .filter((event) => event.id !== state.sourceEvent.id && !event.allDay)
    .filter((event) => {
      const eventStart = new Date(event.startIso).getTime();
      const eventEnd = new Date(event.endIso).getTime();
      return (
        eventStart < targetEnd.getTime() && eventEnd > targetStart.getTime()
      );
    })
    .map<GoogleCalendarConflictEvent>((event) => ({
      title: event.title,
      startIso: event.startIso,
      endIso: event.endIso,
      allDay: event.allDay,
      calendarName: event.calendarName,
    }));

  const durationMinutes = Math.max(
    15,
    Math.round((targetEnd.getTime() - targetStart.getTime()) / (60 * 1000)),
  );

  return {
    ...state,
    conflictSummary:
      blocking.length > 0 || failures.length > 0
        ? {
            blockingEvents: blocking,
            suggestions:
              blocking.length > 0
                ? buildSameDaySuggestions({
                    events,
                    sourceEventId: state.sourceEvent.id,
                    targetStart,
                    durationMinutes,
                    timeZone: TIMEZONE,
                  })
                : [],
            selectedSuggestionStartIso: null,
            warningMessage:
              failures.length > 0
                ? "I couldn't fully verify conflicts across every selected Google calendar right now."
                : null,
          }
        : null,
  };
}

function classifyDirectAssistantPromptKind(input: {
  rawPrompt: string;
  rewriteApplied: boolean;
}): 'exact' | 'summary' | 'refinement' | 'other' {
  if (input.rewriteApplied) return 'refinement';

  const normalized = input.rawPrompt.trim().toLowerCase();
  if (!normalized) return 'other';

  if (
    normalized.startsWith('reply with exactly:') ||
    normalized.startsWith('say exactly:')
  ) {
    return 'exact';
  }

  if (normalized.includes('summarize') || normalized.includes('summarise')) {
    return 'summary';
  }

  return 'other';
}

const channels: Channel[] = [];
const queue = new GroupQueue();
let blueBubblesConversationBinding:
  | {
      enabled: boolean;
      chatScope?: 'all_synced' | 'contacts_only' | 'allowlist';
      allowedChatGuids?: string[];
      allowedChatGuid?: string | null;
      groupFolder?: string | null;
    }
  | undefined;
const backendLaneRegistry = createBackendLaneRegistry();
const cursorBackendLane = createCursorBackendLane();
const andreaRuntimeExecutionEnabled = ANDREA_OPENAI_BACKEND_ENABLED;
const andreaRuntimeBackendLane = createAndreaRuntimeBackendLane({
  resolveGroupByFolder(folder) {
    const entry = Object.entries(registeredGroups).find(
      ([, group]) => group.folder === folder,
    );
    if (!entry) return null;
    const [jid, group] = entry;
    return { jid, group };
  },
});

backendLaneRegistry.register(cursorBackendLane);
backendLaneRegistry.register(andreaRuntimeBackendLane);

const onecli = new OneCLI({ url: ONECLI_URL });

function refreshTaskSnapshots(groups: Record<string, RegisteredGroup>): void {
  const tasks = getAllTasks();
  const taskRows = tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    script: t.script || undefined,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));
  for (const group of Object.values(groups)) {
    writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
  }
}

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  if (group.isMain) return;
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  agentThreads = getAllAgentThreads();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function persistAgentThread(
  groupFolder: string,
  threadId: string,
  runtime: AgentThreadState['runtime'],
): void {
  sessions[groupFolder] = threadId;
  setSession(groupFolder, threadId);
  const thread: AgentThreadState = {
    group_folder: groupFolder,
    runtime,
    thread_id: threadId,
    last_response_id: threadId,
    updated_at: new Date().toISOString(),
  };
  agentThreads[groupFolder] = thread;
  setAgentThread(thread);
}

function clearPersistedAssistantSessionState(
  groupFolder: string,
  sessionStorageKey: string,
): void {
  delete sessions[sessionStorageKey];
  deleteSessionStorageKey(sessionStorageKey);
  delete sessions[groupFolder];
  deleteSession(groupFolder);
  delete agentThreads[groupFolder];
  deleteAgentThread(groupFolder);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
  writeCurrentRuntimeAuditState();
}

async function bootstrapMainChatRegistration(
  chatJid: string,
  chatName: string,
  channel: string,
): Promise<{ ok: boolean; message: string }> {
  const existing = registeredGroups[chatJid];
  if (existing) {
    if (existing.isMain) {
      return {
        ok: true,
        message: 'This chat is already registered as the main control chat.',
      };
    }
    return {
      ok: false,
      message:
        'This chat is already registered as a non-main chat. Use your existing main chat for administration.',
    };
  }

  const existingMain = Object.entries(registeredGroups).find(
    ([, group]) => group.isMain,
  );
  if (existingMain) {
    return {
      ok: false,
      message: `Main chat is already registered as ${existingMain[0]}.`,
    };
  }

  const mainFolderConflict = Object.entries(registeredGroups).find(
    ([jid, group]) => group.folder === 'main' && jid !== chatJid,
  );
  if (mainFolderConflict) {
    return {
      ok: false,
      message:
        'Cannot bootstrap main chat because folder "main" is already used by another registration.',
    };
  }

  registerGroup(chatJid, {
    name: chatName || 'Main',
    folder: 'main',
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
  });

  logger.info(
    { chatJid, chatName, channel },
    'Bootstrapped main chat registration via channel command',
  );

  return {
    ok: true,
    message: `Main chat registered successfully (${chatJid}). You can now send commands to ${ASSISTANT_NAME} here.`,
  };
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function buildAndreaRuntimeDisabledMessage(): string {
  return formatWorkPanel({
    title: '*Codex/OpenAI Runtime*',
    lines: [
      "Andrea's Codex/OpenAI runtime lane uses the Andrea_OpenAI_Bot loopback backend on this host.",
      'That backend lane is currently disabled in this NanoBot runtime, so Andrea can only review existing runtime work.',
      'Enable ANDREA_OPENAI_BACKEND_ENABLED=true (the legacy ANDREA_RUNTIME_EXECUTION_ENABLED=true flag also works), then restart Andrea to bring the runtime lane back online.',
    ],
  });
}

async function buildAndreaRuntimeStatusMessage(
  group: RegisteredGroup,
): Promise<string> {
  const status = await getAndreaOpenAiBackendStatus();
  return formatWorkPanel({
    title: '*Codex/OpenAI Runtime Status*',
    sections: [
      stripLeadingMarkdownTitle(
        formatRuntimeBackendStatusSummary(
          status,
          group,
          ANDREA_OPENAI_BACKEND_URL,
        ),
      ),
    ],
    lines: [
      "Andrea's Codex/OpenAI lane now resolves through the Andrea_OpenAI_Bot loopback backend.",
      'Use `/cursor` when you want the unified work cockpit, or `/runtime-*` when you want explicit runtime controls.',
    ],
  });
}

function getAndreaRuntimeLane(): AndreaRuntimeBackendLane {
  return backendLaneRegistry.get('andrea_runtime') as AndreaRuntimeBackendLane;
}

function isTerminalWorkStatus(status: string | null | undefined): boolean {
  const normalized = (status || '').trim().toLowerCase();
  return (
    normalized === 'succeeded' ||
    normalized === 'success' ||
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'done' ||
    normalized === 'failed' ||
    normalized === 'error' ||
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  );
}

interface CurrentWorkSelection {
  laneId: 'cursor' | 'andrea_runtime';
  jobId: string;
  source: 'shared' | 'legacy_runtime_fallback';
}

function getLegacyRuntimeSelection(
  chatJid: string,
  groupFolder: string,
): string | null {
  const selection = getRuntimeBackendChatSelection(
    ANDREA_OPENAI_BACKEND_ID,
    chatJid,
  );
  if (!selection) return null;

  if (selection.group_folder !== groupFolder) {
    deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
    return null;
  }

  return selection.job_id;
}

function clearLegacyRuntimeSelection(chatJid: string): void {
  deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
}

function getCurrentWorkSelection(
  chatJid: string,
  groupFolder: string,
  threadId?: string,
): CurrentWorkSelection | null {
  const activeContext = getActiveCursorOperatorContext(chatJid, threadId);
  if (activeContext?.selectedLaneId) {
    const selectedJobId = getSelectedLaneJobId(
      chatJid,
      threadId,
      activeContext.selectedLaneId,
    );
    if (selectedJobId) {
      return {
        laneId: activeContext.selectedLaneId,
        jobId: selectedJobId,
        source: 'shared',
      };
    }
  }

  const legacyRuntimeSelection = getLegacyRuntimeSelection(chatJid, groupFolder);
  if (!legacyRuntimeSelection) {
    return null;
  }

  rememberCursorOperatorSelection({
    chatJid,
    threadId,
    laneId: 'andrea_runtime',
    agentId: legacyRuntimeSelection,
  });

  return {
    laneId: 'andrea_runtime',
    jobId: legacyRuntimeSelection,
    source: 'legacy_runtime_fallback',
  };
}

function clearCurrentWorkSelection(params: {
  chatJid: string;
  threadId?: string;
  laneId: 'cursor' | 'andrea_runtime';
  source?: CurrentWorkSelection['source'];
}): void {
  clearSelectedLaneJob({
    chatJid: params.chatJid,
    threadId: params.threadId,
    laneId: params.laneId,
  });
  if (params.laneId === 'andrea_runtime' || params.source === 'legacy_runtime_fallback') {
    clearLegacyRuntimeSelection(params.chatJid);
  }
}

async function getSelectedDailyWorkContext(
  chatJid: string,
  threadId?: string,
): Promise<SelectedWorkContext | null> {
  const group = registeredGroups[chatJid];
  if (!group) {
    return null;
  }

  const currentWorkSelection = getCurrentWorkSelection(
    chatJid,
    group.folder,
    threadId,
  );
  if (!currentWorkSelection) return null;

  if (currentWorkSelection.laneId === 'cursor') {
    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const selected =
      flattenCursorJobInventory(inventory).find(
        (entry) => entry.id === currentWorkSelection.jobId,
      ) || null;
    if (!selected) {
      clearCurrentWorkSelection({
        chatJid,
        threadId,
        laneId: 'cursor',
        source: currentWorkSelection.source,
      });
      return null;
    }
    if (isTerminalWorkStatus(selected.status)) {
      clearCurrentWorkSelection({
        chatJid,
        threadId,
        laneId: 'cursor',
        source: currentWorkSelection.source,
      });
      return null;
    }
    const title =
      selected.summary?.trim() ||
      selected.promptText?.trim() ||
      selected.sourceRepository?.trim() ||
      'selected Cursor task';
    return {
      laneLabel: 'Cursor',
      title,
      statusLabel: formatHumanTaskStatus(selected.status),
      summary:
        selected.summary && selected.summary.trim() !== title
          ? selected.summary.trim()
          : null,
    };
  }

  const selected = await getAndreaRuntimeLane().getJob({
    handle: { laneId: 'andrea_runtime', jobId: currentWorkSelection.jobId },
    groupFolder: group.folder,
    chatJid,
  });
  if (!selected) {
    clearCurrentWorkSelection({
      chatJid,
      threadId,
      laneId: 'andrea_runtime',
      source: currentWorkSelection.source,
    });
    return null;
  }
  if (isTerminalWorkStatus(selected.status)) {
    clearCurrentWorkSelection({
      chatJid,
      threadId,
      laneId: 'andrea_runtime',
      source: currentWorkSelection.source,
    });
    return null;
  }
  const runtimeTitle =
    selected.summary?.trim() ||
    selected.title?.trim() ||
    'selected runtime task';
  return {
    laneLabel: 'Codex/OpenAI runtime',
    title: runtimeTitle,
    statusLabel: formatHumanTaskStatus(selected.status),
    summary:
      selected.summary && selected.summary.trim() !== runtimeTitle
        ? selected.summary.trim()
        : null,
  };
}

function getEnabledOpenClawSkillsSnapshot(): AvailableOpenClawSkill[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return listAllEnabledCommunitySkills()
    .map((skill) => {
      const targetGroup = foldersToChats.get(skill.group_folder);
      if (!targetGroup) return null;

      return {
        chatJid: targetGroup.jid,
        groupFolder: skill.group_folder,
        groupName: targetGroup.name,
        skillId: skill.skill_id,
        displayName: skill.display_name,
        sourceUrl: skill.source_url,
        canonicalClawHubUrl: skill.canonical_clawhub_url,
        githubTreeUrl: skill.github_tree_url,
        installDirName: skill.cache_dir_name,
        enabledAt: skill.enabled_at,
        security: {
          virusTotalStatus: skill.virus_total_status,
          openClawStatus: skill.openclaw_status,
          openClawSummary: skill.openclaw_summary,
        },
      };
    })
    .filter((skill): skill is AvailableOpenClawSkill => skill !== null);
}

function getCursorAgentsSnapshot(): AvailableCursorAgent[] {
  const foldersToChats = new Map(
    Object.entries(registeredGroups).map(([jid, group]) => [
      group.folder,
      { jid, name: group.name },
    ]),
  );

  return listAllCursorAgents()
    .map((agent) => {
      const targetGroup = foldersToChats.get(agent.group_folder);
      if (!targetGroup) return null;

      return {
        id: agent.id,
        chatJid: targetGroup.jid,
        groupFolder: agent.group_folder,
        groupName: targetGroup.name,
        status: agent.status,
        model: agent.model,
        promptText: agent.prompt_text,
        sourceRepository: agent.source_repository,
        sourceRef: agent.source_ref,
        sourcePrUrl: agent.source_pr_url,
        targetUrl: agent.target_url,
        targetPrUrl: agent.target_pr_url,
        targetBranchName: agent.target_branch_name,
        summary: agent.summary,
        createdAt: agent.created_at,
        updatedAt: agent.updated_at,
        lastSyncedAt: agent.last_synced_at,
        artifacts: listCursorAgentArtifacts(agent.id).map((artifact) => ({
          absolutePath: artifact.absolute_path,
          sizeBytes: artifact.size_bytes,
          updatedAt: artifact.updated_at,
          downloadUrl: artifact.download_url,
          downloadUrlExpiresAt: artifact.download_url_expires_at,
          syncedAt: artifact.synced_at,
        })),
      };
    })
    .filter((agent): agent is AvailableCursorAgent => agent !== null);
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

function resolveCompanionBinding(chatJid: string) {
  return resolveCompanionConversationBinding(chatJid, registeredGroups, {
    bluebubbles: blueBubblesConversationBinding,
  });
}

function listProcessableCompanionChatJids(): string[] {
  return listCompanionConversationChatJids(registeredGroups, {
    bluebubbles: blueBubblesConversationBinding,
  });
}

let resolveTelegramMainChatForAlexa = (_groupFolder: string) => undefined as
  | { chatJid: string }
  | undefined;
let resolveBlueBubblesCompanionChat = (_groupFolder: string) => undefined as
  | { chatJid: string }
  | undefined;
let resolveCompanionHandoffTarget = (
  groupFolder: string,
  targetChannel: 'telegram' | 'bluebubbles',
) =>
  targetChannel === 'bluebubbles'
    ? resolveBlueBubblesCompanionChat(groupFolder)
    : resolveTelegramMainChatForAlexa(groupFolder);
let sendCompanionHandoffMessageToChannel = async (
  chatJid: string,
  text: string,
  options?: SendMessageOptions,
) => {
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    throw new Error(`No channel found for ${chatJid}`);
  }
  return channel.sendMessage(chatJid, text, options);
};
let sendCompanionHandoffMessage = async (
  _targetChannel: 'telegram' | 'bluebubbles',
  chatJid: string,
  text: string,
  options?: SendMessageOptions,
) => sendCompanionHandoffMessageToChannel(chatJid, text, options);
let sendCompanionHandoffArtifactToChannel = async (
  chatJid: string,
  artifact: Parameters<NonNullable<Channel['sendArtifact']>>[1],
  options?: Parameters<NonNullable<Channel['sendArtifact']>>[2],
) => {
  const channel = findChannel(channels, chatJid);
  if (!channel?.sendArtifact) {
    throw new Error(`Artifact delivery is unavailable for ${chatJid}`);
  }
  return channel.sendArtifact(chatJid, artifact, options);
};
let sendCompanionHandoffArtifact = async (
  _targetChannel: 'telegram' | 'bluebubbles',
  chatJid: string,
  artifact: Parameters<NonNullable<Channel['sendArtifact']>>[1],
  options?: Parameters<NonNullable<Channel['sendArtifact']>>[2],
) => sendCompanionHandoffArtifactToChannel(chatJid, artifact, options);

function getMainChatSessionState(chatJid: string): MainChatSessionState {
  const snapshot = queue
    .getRuntimeJobs()
    .find((job) => job.groupJid === chatJid && job.active);
  if (!snapshot) return 'inactive';
  if (snapshot.isTaskContainer) return 'task_container';
  return snapshot.idleWaiting ? 'idle_assistant' : 'busy_assistant';
}

function resolveExplicitCompanionHandoffTarget(
  text: string,
  sourceChannel: 'telegram' | 'bluebubbles',
): 'telegram' | 'bluebubbles' | null {
  if (
    sourceChannel === 'bluebubbles' &&
    /\b(send (?:me )?(?:the )?(?:details|fuller version|full version|full comparison)|send (?:that|it|this) (?:to|on) telegram|send me the fuller version on telegram)\b/i.test(
      text,
    )
  ) {
    return 'telegram';
  }
  return null;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = resolveCompanionBinding(chatJid)?.group;
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }
  const conversationChannel = channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram';

  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const requestPolicy = classifyAssistantRequest(missedMessages, {
    allowCombinedContext:
      !isMainGroup || !shouldAvoidCombinedContextForMainChat(missedMessages),
  });
  let promptMessages = missedMessages;
  const isStandaloneMainDirectAssistantTurn =
    requestPolicy.route === 'direct_assistant' &&
    isMainGroup &&
    shouldAvoidCombinedContextForMainChat(missedMessages);
  let forceFreshDirectAssistantSession = isStandaloneMainDirectAssistantTurn;
  let directAssistantRewriteApplied = false;
  let directAssistantFallbackPromptText: string | null = null;

  if (
    requestPolicy.route === 'direct_assistant' &&
    missedMessages.length === 1
  ) {
    const rewritten = buildDirectAssistantContinuationPrompt({
      rawPrompt: missedMessages[0]?.content || '',
      previousAssistantText: lastDirectAssistantTextByChatJid[chatJid],
    });
    if (
      rewritten.usedVisibleContext &&
      rewritten.normalizedPromptText &&
      rewritten.normalizedPromptText !== missedMessages[0]?.content.trim()
    ) {
      directAssistantRewriteApplied = true;
      directAssistantFallbackPromptText = rewritten.fallbackPromptText || null;
      promptMessages = [
        {
          ...missedMessages[0],
          content: rewritten.normalizedPromptText,
        },
      ];
      forceFreshDirectAssistantSession =
        forceFreshDirectAssistantSession || rewritten.shouldStartFreshSession;
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          directAssistantProfile: 'minimal_read_only',
          promptKind: 'refinement',
          forceFreshDirectAssistantSession,
          rewriteApplied: true,
        },
        'Rewrote terse direct assistant continuation using recent visible context',
      );
    }
  }

  const directAssistantPromptKind =
    requestPolicy.route === 'direct_assistant'
      ? classifyDirectAssistantPromptKind({
          rawPrompt: missedMessages.at(-1)?.content || '',
          rewriteApplied: directAssistantRewriteApplied,
        })
      : null;
  const quickReply =
    requestPolicy.route === 'direct_assistant'
      ? maybeBuildDirectQuickReply(missedMessages)
      : null;

  const prompt = buildAssistantPromptWithPersonalization(
    formatMessages(promptMessages, TIMEZONE),
    {
      channel: conversationChannel,
      groupFolder: group.folder,
    },
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      component: 'assistant',
      chatJid,
      groupFolder: group.folder,
      group: group.name,
      messageCount: missedMessages.length,
      requestRoute: requestPolicy.route,
      requestReason: requestPolicy.reason,
      directAssistantProfile:
        requestPolicy.route === 'direct_assistant' ? 'minimal_read_only' : null,
      promptKind: directAssistantPromptKind,
      freshSession:
        requestPolicy.route === 'direct_assistant'
          ? forceFreshDirectAssistantSession
          : null,
      rewriteApplied:
        requestPolicy.route === 'direct_assistant'
          ? directAssistantRewriteApplied
          : null,
      quickReply:
        requestPolicy.route === 'direct_assistant' ? Boolean(quickReply) : null,
    },
    'Processing messages',
  );

  const latestUserMessage = missedMessages.at(-1);
  const rawLastContent = latestUserMessage?.content ?? '';
  let lastContent =
    chatJid.startsWith('bb:')
      ? normalizeBlueBubblesCompanionPrompt(rawLastContent)
      : rawLastContent;
  const now = new Date();
  const sendAssistantReplyWithFeedback = async (params: {
    text: string;
    sendOptions?: SendMessageOptions;
    routeKey?: string | null;
    capabilityId?: string | null;
    handlerKind?: string | null;
    responseSource?: string | null;
    traceReason?: string | null;
    traceNotes?: string[];
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    linkedRefs?: ResponseFeedbackRecord['linkedRefs'];
    allowFeedback?: boolean;
  }) => {
    const replyText = params.text.trim();
    const shouldAttachFeedback =
      params.allowFeedback !== false &&
      channel.name === 'telegram' &&
      isMainControlChat(group) &&
      replyText.length > 0;
    const feedbackId = shouldAttachFeedback ? randomUUID() : null;
    const sendOptions =
      shouldAttachFeedback && feedbackId
        ? appendResponseFeedbackInlineRow(params.sendOptions || {}, feedbackId)
        : params.sendOptions || {};
    const sent = await channel.sendMessage(chatJid, replyText, sendOptions);
    if (!feedbackId) {
      return sent;
    }
    const classification = classifyResponseFeedbackCandidate({
      originalUserText: rawLastContent || lastContent,
      assistantReplyText: replyText,
      routeKey: params.routeKey,
      capabilityId: params.capabilityId,
      responseSource: params.responseSource,
      traceReason: params.traceReason,
      blockerClass: params.blockerClass,
    });
    upsertResponseFeedback({
      feedbackId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      status: classification.status,
      classification: classification.classification,
      channel: 'telegram',
      groupFolder: group.folder,
      chatJid,
      threadId: sent.threadId || latestUserMessage?.thread_id || null,
      platformMessageId: sent.platformMessageId || null,
      userMessageId: latestUserMessage?.id || null,
      routeKey: params.routeKey || requestPolicy.route,
      capabilityId: params.capabilityId || null,
      handlerKind: params.handlerKind || null,
      responseSource: params.responseSource || null,
      traceReason: params.traceReason || null,
      traceNotes: params.traceNotes || [],
      blockerClass: params.blockerClass || null,
      blockerOwner: params.blockerOwner || classification.blockerOwner,
      originalUserText: rawLastContent || lastContent,
      assistantReplyText: replyText,
      linkedRefs: params.linkedRefs || {},
      issueId: null,
      remediationLaneId: null,
      remediationJobId: null,
      remediationRuntimePreference: null,
      remediationPrompt: null,
      operatorNote: classification.explanation,
    });
    return sent;
  };
  let blueBubblesDirectTurnEnvelope: Awaited<
    ReturnType<typeof interpretBlueBubblesDirectTurn>
  > | null = null;
  let blueBubblesDirectTurnChecked = false;
  const maybeInterpretBlueBubblesDirectTurn = async () => {
    if (blueBubblesDirectTurnChecked) {
      return blueBubblesDirectTurnEnvelope;
    }
    blueBubblesDirectTurnChecked = true;
    if (
      conversationChannel !== 'bluebubbles' ||
      requestPolicy.route !== 'direct_assistant' ||
      quickReply ||
      !isBlueBubblesSelfThreadAliasJid(chatJid)
    ) {
      blueBubblesDirectTurnEnvelope = null;
      return blueBubblesDirectTurnEnvelope;
    }
    const priorAssistantCapabilitySeed = getSharedAssistantCapabilitySeed(
      chatJid,
      now,
    );
    const priorDailyContext = getDailyCompanionContext(chatJid, now);
    blueBubblesDirectTurnEnvelope = await interpretBlueBubblesDirectTurn({
      groupFolder: group.folder,
      chatJid,
      text: lastContent,
      conversationSummary:
        priorAssistantCapabilitySeed?.summaryText ||
        priorDailyContext?.summaryText,
      replyText: missedMessages.at(-1)?.reply_to?.content,
      priorPersonName: priorAssistantCapabilitySeed?.subjectData?.personName,
      priorThreadTitle: priorAssistantCapabilitySeed?.subjectData?.threadTitle,
      priorLastAnswerSummary:
        priorAssistantCapabilitySeed?.subjectData?.lastAnswerSummary,
      now,
    });
    if (
      blueBubblesDirectTurnEnvelope?.assistantPrompt &&
      blueBubblesDirectTurnEnvelope.routeFamily !== 'chat'
    ) {
      lastContent = blueBubblesDirectTurnEnvelope.assistantPrompt;
    }
    return blueBubblesDirectTurnEnvelope;
  };
  const tryHandleActionBundleFollowup = async (): Promise<boolean> => {
    const snapshot = findLatestChatActionBundle({
      groupFolder: group.folder,
      presentationChannel: conversationChannel,
      chatJid,
      now,
    });
    if (!snapshot) return false;
    const operation = interpretActionBundleFollowup(lastContent, snapshot);
    if (!operation) return false;
    return applyAndPresentActionBundle({
      chatJid,
      bundleId: snapshot.bundle.bundleId,
      operation,
      now,
    });
  };
  const tryHandleMessageActionFollowup = async (): Promise<boolean> => {
    let operation = interpretMessageActionFollowup(lastContent);
    if (!operation) {
      const interpretedTurn = await maybeInterpretBlueBubblesDirectTurn();
      if (
        interpretedTurn?.routeFamily === 'message_action_followup' &&
        interpretedTurn.assistantPrompt
      ) {
        operation = interpretMessageActionFollowup(interpretedTurn.assistantPrompt);
      }
    }
    if (!operation) return false;
    const messageAction = resolveMessageActionForFollowup({
      groupFolder: group.folder,
      chatJid,
      rawText: lastContent,
    });
    if (!messageAction) {
      if (
        conversationChannel === 'bluebubbles' &&
        operation.kind === 'send' &&
        isBlueBubblesExplicitSendAlias(lastContent)
      ) {
        await channel.sendMessage(
          chatJid,
          'Andrea: I do not have a draft open here yet.\n\nAsk what you should say back, or say `send a text message to <chat name>: <message>`.',
        );
        return true;
      }
      return false;
    }
    return applyAndPresentMessageAction({
      chatJid,
      messageActionId: messageAction.messageActionId,
      operation,
      now,
    });
  };
  const tryHandleExplicitBlueBubblesThreadSend = async (): Promise<boolean> => {
    if (conversationChannel !== 'bluebubbles') return false;
    const explicitSend = parseExplicitBlueBubblesThreadSendIntent(lastContent);
    if (!explicitSend) return false;
    const resolution = resolveBlueBubblesThreadTargetByName(explicitSend.targetLabel);
    if (resolution.state === 'missing') {
      await channel.sendMessage(
        chatJid,
        `Andrea: I could not match "${explicitSend.targetLabel}" to a synced Messages chat.\n\nUse the exact chat name, like \`send a text message to Rad Dad: <message>\`.`,
      );
      return true;
    }
    if (resolution.state === 'ambiguous') {
      const options = resolution.matches.map((match) => match.displayName).join(', ');
      await channel.sendMessage(
        chatJid,
        `Andrea: I found more than one Messages chat that could be "${explicitSend.targetLabel}".\n\nUse the exact chat name. Matches: ${options}.`,
      );
      return true;
    }
    const target = resolution.target;
    const action = createOrRefreshMessageActionFromDraft({
      groupFolder: group.folder,
      presentationChannel: 'bluebubbles',
      presentationChatJid: chatJid,
      sourceType: 'manual_prompt',
      sourceKey: `bluebubbles-thread-send:${target.chatJid}:${explicitSend.draftText
        .toLowerCase()
        .slice(0, 80)}`,
      sourceSummary: `Draft text message to ${target.displayName}.`,
      draftText: explicitSend.draftText,
      personName: target.displayName,
      threadTitle: target.displayName,
      communicationContext: 'general',
      targetOverride: {
        kind: 'external_thread',
        chatJid: target.chatJid,
        threadId: null,
        replyToMessageId: null,
        isGroup: target.isGroup,
        personName: target.displayName,
      },
      targetChannelOverride: 'bluebubbles',
      now,
    });
    const presentation = buildMessageActionPresentation(action, 'bluebubbles');
    await channel.sendMessage(chatJid, presentation.text);
    return true;
  };
  const tryHandleOutcomeReview = async (): Promise<boolean> => {
    const reviewPrompt = matchOutcomeReviewPrompt(lastContent);
    if (reviewPrompt) {
      const presentation = buildOutcomeReviewResponse({
        groupFolder: group.folder,
        match: reviewPrompt,
        channel:
          channel.name === 'telegram'
            ? 'telegram'
            : channel.name === 'bluebubbles'
              ? 'bluebubbles'
              : 'telegram',
        now,
        timeZone: TIMEZONE,
      });
      const sent = await channel.sendMessage(chatJid, presentation.text, {
        inlineActionRows: presentation.inlineActionRows,
      });
      setOutcomeReviewContext(chatJid, {
        version: 1,
        createdAt: now.toISOString(),
        promptMatchJson: JSON.stringify(reviewPrompt),
        focusOutcomeIds: presentation.focusOutcomeIds,
        primaryOutcomeId: presentation.primaryOutcomeId || null,
        presentationMessageId: sent.platformMessageId || null,
      });
      return true;
    }

    const control = interpretOutcomeReviewControl(lastContent);
    if (!control) return false;
    const context = getOutcomeReviewContext(chatJid, now);
    const targetOutcomeId =
      context?.primaryOutcomeId || context?.focusOutcomeIds?.[0] || null;
    if (!targetOutcomeId) return false;
    return applyAndPresentOutcomeReviewControl({
      chatJid,
      outcomeId: targetOutcomeId,
      control,
      now,
    });
  };
  const tryHandleDelegationRules = async (): Promise<boolean> => {
    const intent = interpretDelegationRuleUtterance(lastContent);
    if (!intent) return false;

    if (conversationChannel === 'bluebubbles') {
      await channel.sendMessage(
        chatJid,
        'Andrea: I can honor your usual safe defaults here, but rule setup and editing works best in Telegram. Ask me to send the rule details there if you want to manage them.',
      );
      return true;
    }

    if (intent.kind === 'show_rules') {
      const presentation = buildDelegationRuleListPresentation({
        groupFolder: group.folder,
        channel: conversationChannel,
      });
      const sent = await channel.sendMessage(chatJid, presentation.text, {
        inlineActionRows: presentation.inlineActionRows,
      });
      setDelegationRuleContext(chatJid, {
        version: 1,
        createdAt: now.toISOString(),
        focusRuleIds: presentation.focusRuleIds,
        primaryRuleId: presentation.primaryRuleId || null,
        presentationMessageId: sent.platformMessageId || null,
      });
      return true;
    }

    if (
      intent.kind === 'pause_rule' ||
      intent.kind === 'disable_rule' ||
      intent.kind === 'always_ask' ||
      intent.kind === 'stop_automatic' ||
      intent.kind === 'why_rule'
    ) {
      const context = getDelegationRuleContext(chatJid, now);
      const targetRuleId =
        context?.primaryRuleId || context?.focusRuleIds?.[0] || null;
      if (!targetRuleId) return false;
      return applyAndPresentDelegationRuleCommand({
        chatJid,
        command:
          intent.kind === 'pause_rule'
            ? 'pause'
            : intent.kind === 'disable_rule'
              ? 'disable'
              : intent.kind === 'why_rule'
                ? 'why'
                : 'always_ask',
        targetId: targetRuleId,
        now,
      });
    }

    const currentMessageAction = findLatestChatMessageAction({
      groupFolder: group.folder,
      chatJid,
    });
    const currentBundle = findLatestChatActionBundle({
      groupFolder: group.folder,
      presentationChannel: conversationChannel,
      chatJid,
      now,
    });
    const previewResult = buildDelegationRulePreview({
      utterance: lastContent,
      context: {
        groupFolder: group.folder,
        channel: conversationChannel,
        currentBundle,
        actionTypeHint:
          currentMessageAction?.sendStatus !== 'sent'
            ? 'send_message'
            : currentBundle?.actions.find((action) =>
                ['approved', 'proposed'].includes(action.status),
              )?.actionType,
        originKind: currentBundle?.bundle.originKind,
        threadTitle:
          parseJsonSafe<{ personName?: string | null }>(
            currentMessageAction?.linkedRefsJson,
            {},
          ).personName ||
          currentBundle?.bundle.title ||
          null,
        personName:
          parseJsonSafe<{ personName?: string | null }>(
            currentMessageAction?.linkedRefsJson,
            {},
          ).personName ||
          currentBundle?.bundle.title ||
          null,
        communicationContext:
          currentBundle?.bundle.originKind === 'communication'
            ? 'reply_followthrough'
            : currentBundle?.bundle.originKind === 'daily_guidance'
              ? 'household_followthrough'
              : 'general',
      },
    });
    if (!previewResult.handled) return false;
    if (previewResult.clarificationQuestion) {
      await channel.sendMessage(chatJid, previewResult.clarificationQuestion);
      return true;
    }
    if (!previewResult.preview) return false;
    const presentation = buildDelegationRulePreviewPresentation(
      previewResult.preview,
    );
    const sent = await channel.sendMessage(chatJid, presentation.text, {
      inlineActionRows: presentation.inlineActionRows,
    });
    setDelegationRuleContext(chatJid, {
      version: 1,
      createdAt: now.toISOString(),
      previewJson: JSON.stringify(previewResult.preview),
      previewId: previewResult.preview.previewId,
      presentationMessageId: sent.platformMessageId || null,
    });
    return true;
  };
  const tryHandleLocalCalendarAutomation = async (): Promise<boolean> => {
    try {
      const pendingGoogleCalendarCreateState =
        getPendingGoogleCalendarCreateState(chatJid);
      if (
        pendingGoogleCalendarCreateState &&
        isPendingGoogleCalendarCreateExpired(
          pendingGoogleCalendarCreateState,
          now,
        )
      ) {
        clearPendingGoogleCalendarCreateState(chatJid);
      }

      const pendingAutomation = getPendingCalendarAutomationState(chatJid);
      if (
        pendingAutomation &&
        isPendingCalendarAutomationExpired(pendingAutomation, now)
      ) {
        clearPendingCalendarAutomationState(chatJid);
      }

      const activePendingGoogleCalendarCreateState =
        getPendingGoogleCalendarCreateState(chatJid);
      if (
        activePendingGoogleCalendarCreateState &&
        advancePendingGoogleCalendarCreate(
          lastContent,
          activePendingGoogleCalendarCreateState,
        ).kind !== 'no_match'
      ) {
        return false;
      }

      const activeState = getPendingCalendarAutomationState(chatJid);
      const automations = getCalendarAutomationSummaries(chatJid);

      if (activeState) {
        const result = advancePendingCalendarAutomation(
          lastContent,
          activeState,
          now,
        );
        if (result.kind === 'no_match') {
          return false;
        }
        if (result.kind === 'cancelled') {
          clearPendingCalendarAutomationState(chatJid);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText('*Calendar Automation*', result.message),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }
        if (result.kind === 'awaiting_input') {
          setPendingCalendarAutomationState(chatJid, result.state);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText('*Calendar Automation*', result.message),
            {
              inlineActionRows: buildCalendarAutomationInlineActionRows(
                result.state,
              ),
            },
          );
          return true;
        }

        clearPendingCalendarAutomationState(chatJid);
        const confirmedState = result.state;
        if (confirmedState.step !== 'confirm') {
          return false;
        }
        const existingAutomation = confirmedState.targetTaskId
          ? automations.find(
              (item) => item.taskId === confirmedState.targetTaskId,
            ) || null
          : null;

        if (confirmedState.mode === 'pause' && confirmedState.targetTaskId) {
          updateTask(confirmedState.targetTaskId, { status: 'paused' });
          updateCalendarAutomation(confirmedState.targetTaskId, {
            updated_at: now.toISOString(),
          });
          refreshTaskSnapshots(registeredGroups);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Calendar Automation*',
              `Paused "${confirmedState.draft.label}".`,
            ),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }

        if (confirmedState.mode === 'resume' && confirmedState.targetTaskId) {
          const configChanged =
            !!existingAutomation &&
            (existingAutomation.label !== confirmedState.draft.label ||
              JSON.stringify(existingAutomation.config) !==
                JSON.stringify(confirmedState.draft.config));
          const nextRun = computeCalendarAutomationNextRun(
            confirmedState.draft.config.schedule,
            now,
          );
          updateTask(confirmedState.targetTaskId, {
            prompt: `Calendar automation: ${confirmedState.draft.label}`,
            schedule_type: confirmedState.draft.config.schedule.scheduleType,
            schedule_value: confirmedState.draft.config.schedule.scheduleValue,
            next_run: nextRun,
            status: 'active',
          });
          updateCalendarAutomation(confirmedState.targetTaskId, {
            label: confirmedState.draft.label,
            config_json: JSON.stringify(confirmedState.draft.config),
            dedupe_state_json: configChanged ? null : undefined,
            updated_at: now.toISOString(),
          });
          refreshTaskSnapshots(registeredGroups);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Calendar Automation*',
              nextRun
                ? `Resumed "${confirmedState.draft.label}".\nNext: ${new Intl.DateTimeFormat(
                    'en-US',
                    {
                      timeZone: TIMEZONE,
                      weekday: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    },
                  ).format(new Date(nextRun))}`
                : `Resumed "${confirmedState.draft.label}".`,
            ),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }

        if (confirmedState.mode === 'delete' && confirmedState.targetTaskId) {
          deleteTask(confirmedState.targetTaskId);
          refreshTaskSnapshots(registeredGroups);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Calendar Automation*',
              `Deleted "${confirmedState.draft.label}".`,
            ),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }

        const persistInput = buildCalendarAutomationPersistInput({
          draft: confirmedState.draft,
          chatJid,
          groupFolder: group.folder,
          now,
          existingTaskId: confirmedState.targetTaskId,
          status:
            confirmedState.mode === 'replace' &&
            confirmedState.targetStatus === 'paused'
              ? 'paused'
              : 'active',
        });

        if (persistInput.replaceTaskId) {
          updateTask(persistInput.replaceTaskId, {
            prompt: persistInput.task.prompt,
            schedule_type: persistInput.task.schedule_type,
            schedule_value: persistInput.task.schedule_value,
            next_run: persistInput.task.next_run,
            status: persistInput.task.status,
          });
          updateCalendarAutomation(persistInput.replaceTaskId, {
            label: persistInput.automation.label,
            config_json: persistInput.automation.config_json,
            dedupe_state_json: null,
            updated_at: now.toISOString(),
          });
        } else {
          createTask(persistInput.task);
          createCalendarAutomation({
            ...persistInput.automation,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          });
        }

        refreshTaskSnapshots(registeredGroups);
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText(
            '*Calendar Automation*',
            persistInput.replaceTaskId
              ? persistInput.task.status === 'paused'
                ? `Updated automation:\n- ${confirmedState.draft.label}\nIt will stay paused until you resume it.`
                : `Updated automation:\n- ${confirmedState.draft.label}`
              : `Saved automation:\n- ${confirmedState.draft.label}`,
          ),
          {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
        );
        return true;
      }

      const plan = await planCalendarAutomation(lastContent, now, automations);
      if (plan.kind === 'none') {
        return false;
      }

      if (plan.kind === 'list') {
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText('*Calendar Automations*', plan.message),
          {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
        );
        return true;
      }

      setPendingCalendarAutomationState(chatJid, plan.state);
      await channel.sendMessage(
        chatJid,
        formatCalendarPanelText('*Calendar Automation*', plan.message),
        {
          inlineActionRows: buildCalendarAutomationInlineActionRows(plan.state),
        },
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'Local calendar automation path failed, rolled back cursor for retry',
      );
      return false;
    }
  };

  const tryHandleLocalGoogleCalendarFollowThrough =
    async (): Promise<boolean> => {
      try {
        const activeEventContext = getActiveGoogleCalendarEventContext(chatJid);
        if (
          activeEventContext &&
          isActiveGoogleCalendarEventContextExpired(activeEventContext, now)
        ) {
          clearActiveGoogleCalendarEventContext(chatJid);
        }

        const pendingReminder = getPendingCalendarReminderState(chatJid);
        if (
          pendingReminder &&
          isPendingCalendarReminderExpired(pendingReminder, now)
        ) {
          clearPendingCalendarReminderState(chatJid);
        }

        const pendingAction = getPendingGoogleCalendarEventActionState(chatJid);
        if (
          pendingAction &&
          isPendingGoogleCalendarEventActionExpired(pendingAction, now)
        ) {
          clearPendingGoogleCalendarEventActionState(chatJid);
        }

        const refreshedActiveEventContext =
          getActiveGoogleCalendarEventContext(chatJid);
        const freshReminderPlan = planCalendarEventReminder(
          lastContent,
          now,
          refreshedActiveEventContext,
        );

        const activeReminder = getPendingCalendarReminderState(chatJid);
        if (activeReminder) {
          if (freshReminderPlan.kind !== 'none') {
            clearPendingCalendarReminderState(chatJid);
          } else {
            const result = advancePendingCalendarReminder(
              lastContent,
              activeReminder,
              now,
            );
            if (result.kind === 'no_match') {
              return false;
            }
            if (result.kind === 'cancelled') {
              clearPendingCalendarReminderState(chatJid);
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText('*Calendar*', result.message),
                {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
              );
              return true;
            }
            if (result.kind === 'invalid') {
              clearPendingCalendarReminderState(chatJid);
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText('*Calendar*', result.message),
                {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
              );
              return true;
            }
            if (result.kind === 'awaiting_input') {
              setPendingCalendarReminderState(chatJid, result.state);
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText('*Calendar*', result.message),
                {
                  inlineActionRows: buildCalendarReminderInlineActionRows(
                    result.state,
                  ),
                },
              );
              return true;
            }

            const reminderPlan = buildEventReminderTaskPlan({
              state: result.state,
              groupFolder: group.folder,
              chatJid,
              now,
              timeZone: TIMEZONE,
            });
            for (const task of reminderPlan.tasks || []) {
              createTask(task);
            }
            if (reminderPlan.task) {
              createTask(reminderPlan.task);
            }
            refreshTaskSnapshots(registeredGroups);
            clearPendingCalendarReminderState(chatJid);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Calendar*', reminderPlan.confirmation),
              {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
            );
            return true;
          }
        }

        const activeEventAction =
          getPendingGoogleCalendarEventActionState(chatJid);
        if (activeEventAction) {
          const result = advancePendingGoogleCalendarEventAction(
            lastContent,
            activeEventAction,
            now,
          );
          if (result.kind === 'no_match') {
            return false;
          }
          if (result.kind === 'cancelled') {
            clearPendingGoogleCalendarEventActionState(chatJid);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Google Calendar*', result.message),
              {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
            );
            return true;
          }
          if (result.kind === 'resolve_anchor') {
            const googleConfig = resolveGoogleCalendarConfig();
            const anchorStart = new Date(result.anchorDate);
            anchorStart.setHours(0, 0, 0, 0);
            const anchorEnd = new Date(anchorStart);
            anchorEnd.setDate(anchorEnd.getDate() + 1);
            const { events } = await listGoogleCalendarEvents(
              {
                start: anchorStart,
                end: anchorEnd,
                calendarIds: googleConfig.calendarIds,
              },
              googleConfig,
            );
            const anchorPoint = new Date(result.anchorDate);
            anchorPoint.setHours(
              result.anchorTime.hours,
              result.anchorTime.minutes,
              0,
              0,
            );
            const matches = events.filter((event) => {
              if (event.allDay) return false;
              const eventStart = new Date(event.startIso).getTime();
              const eventEnd = new Date(event.endIso).getTime();
              const point = anchorPoint.getTime();
              return eventStart <= point && eventEnd > point;
            });
            if (matches.length === 0) {
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText(
                  '*Google Calendar*',
                  `I couldn't find a ${result.anchorTime.displayLabel} meeting to schedule around on that day.`,
                ),
                {
                  inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                    result.state,
                  ),
                },
              );
              return true;
            }
            if (matches.length > 1) {
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText(
                  '*Google Calendar*',
                  `I found more than one event around ${result.anchorTime.displayLabel}. Tell me which one you mean.`,
                ),
                {
                  inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                    result.state,
                  ),
                },
              );
              return true;
            }
            const anchorEvent = matches[0];
            const sourceStart = new Date(result.state.sourceEvent.startIso);
            const sourceEnd = new Date(result.state.sourceEvent.endIso);
            const durationMs = sourceEnd.getTime() - sourceStart.getTime();
            const movedState =
              await enrichPendingGoogleCalendarEventActionStateWithConflicts({
                ...result.state,
                proposedEvent: {
                  ...result.state.sourceEvent,
                  startIso: anchorEvent.endIso,
                  endIso: new Date(
                    new Date(anchorEvent.endIso).getTime() + durationMs,
                  ).toISOString(),
                  allDay: false,
                },
                conflictSummary: null,
              });
            setPendingGoogleCalendarEventActionState(chatJid, movedState);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                formatPendingGoogleCalendarEventActionPrompt(movedState),
              ),
              {
                inlineActionRows:
                  buildGoogleCalendarEventActionInlineRows(movedState),
              },
            );
            return true;
          }
          if (result.kind === 'awaiting_input') {
            const enrichedState =
              result.state.action === 'move' || result.state.action === 'resize'
                ? await enrichPendingGoogleCalendarEventActionStateWithConflicts(
                    result.state,
                  )
                : result.state;
            setPendingGoogleCalendarEventActionState(chatJid, enrichedState);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                formatPendingGoogleCalendarEventActionPrompt(enrichedState),
              ),
              {
                inlineActionRows:
                  buildGoogleCalendarEventActionInlineRows(enrichedState),
              },
            );
            return true;
          }

          const googleConfig = resolveGoogleCalendarConfig();
          if (result.state.action === 'delete') {
            await deleteGoogleCalendarEvent(
              {
                calendarId: result.state.sourceEvent.calendarId,
                eventId: result.state.sourceEvent.id,
              },
              googleConfig,
            );
            clearPendingGoogleCalendarEventActionState(chatJid);
            clearActiveGoogleCalendarEventContext(chatJid);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                `Deleted "${result.state.sourceEvent.title}".`,
              ),
              {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
            );
            return true;
          }

          if (result.state.action === 'reassign') {
            const movedEvent = await moveGoogleCalendarEvent(
              {
                sourceCalendarId: result.state.sourceEvent.calendarId,
                destinationCalendarId: result.state.selectedCalendarId!,
                eventId: result.state.sourceEvent.id,
              },
              googleConfig,
            );
            clearPendingGoogleCalendarEventActionState(chatJid);
            setActiveGoogleCalendarEventContext(
              chatJid,
              buildActiveGoogleCalendarEventContextState(movedEvent, now),
            );
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                buildCalendarCompanionEventReply({
                  action: 'update_event',
                  title: movedEvent.title,
                  startIso: movedEvent.startIso,
                  endIso: movedEvent.endIso,
                  allDay: movedEvent.allDay,
                  timeZone: TIMEZONE,
                  calendarName: movedEvent.calendarName,
                  htmlLink: movedEvent.htmlLink || null,
                }),
              ),
              {
                inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
                  htmlLink: movedEvent.htmlLink || null,
                }),
              },
            );
            return true;
          }

          const targetEvent =
            result.state.proposedEvent || result.state.sourceEvent;
          const updatedEvent = await updateGoogleCalendarEvent(
            {
              calendarId: result.state.sourceEvent.calendarId,
              eventId: result.state.sourceEvent.id,
              start: new Date(targetEvent.startIso),
              end: new Date(targetEvent.endIso),
              timeZone: TIMEZONE,
              allDay: targetEvent.allDay,
            },
            googleConfig,
          );
          clearPendingGoogleCalendarEventActionState(chatJid);
          setActiveGoogleCalendarEventContext(
            chatJid,
            buildActiveGoogleCalendarEventContextState(updatedEvent, now),
          );
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Google Calendar*',
              buildCalendarCompanionEventReply({
                action: 'update_event',
                title: updatedEvent.title,
                startIso: updatedEvent.startIso,
                endIso: updatedEvent.endIso,
                allDay: updatedEvent.allDay,
                timeZone: TIMEZONE,
                calendarName: updatedEvent.calendarName,
                htmlLink: updatedEvent.htmlLink || null,
              }),
            ),
            {
              inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
                htmlLink: updatedEvent.htmlLink || null,
              }),
            },
          );
          return true;
        }

        const reminderPlan = freshReminderPlan;
        if (reminderPlan.kind !== 'none') {
          if (reminderPlan.kind === 'needs_event_context') {
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Calendar*', reminderPlan.message),
              {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
            );
            return true;
          }

          if (reminderPlan.kind === 'lookup') {
            const googleConfig = resolveGoogleCalendarConfig();
            const { events, failures, successCount } =
              await listGoogleCalendarEvents(
                {
                  start: reminderPlan.searchStart,
                  end: reminderPlan.searchEnd,
                  calendarIds: googleConfig.calendarIds,
                },
                googleConfig,
              );
            if (successCount === 0) {
              logger.warn(
                {
                  component: 'assistant',
                  chatJid,
                  groupFolder: group.folder,
                  group: group.name,
                  failures,
                },
                'Google calendar reminder lookup unavailable during local fast path',
              );
              await channel.sendMessage(
                chatJid,
                buildCalendarCompanionFailurePanelText({
                  title: '*Calendar*',
                  channelName: channel.name,
                  action: 'confirm_reminder',
                  technicalDetail: failures.join('; '),
                }),
                {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
              );
              return true;
            }
            const resolved = resolveCalendarReminderLookup({
              events,
              failures,
              offset: reminderPlan.offset,
              targetLabel: reminderPlan.targetLabel,
              selectorMode: reminderPlan.selectorMode,
              queryText: reminderPlan.queryText,
              scopeFilter: reminderPlan.scopeFilter,
              searchStart: reminderPlan.searchStart,
              searchEnd: reminderPlan.searchEnd,
              now,
            });
            if (resolved.kind === 'awaiting_input') {
              setPendingCalendarReminderState(chatJid, resolved.state);
              await channel.sendMessage(
                chatJid,
                formatCalendarPanelText('*Calendar*', resolved.message),
                {
                  inlineActionRows: buildCalendarReminderInlineActionRows(
                    resolved.state,
                  ),
                },
              );
              return true;
            }

            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Calendar*',
                'message' in resolved
                  ? resolved.message
                  : "I couldn't set that reminder from the events I found.",
              ),
              {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
            );
            return true;
          }

          setPendingCalendarReminderState(chatJid, reminderPlan.state);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText('*Calendar*', reminderPlan.message),
            {
              inlineActionRows: buildCalendarReminderInlineActionRows(
                reminderPlan.state,
              ),
            },
          );
          return true;
        }

        if (getPendingGoogleCalendarCreateState(chatJid)) {
          return false;
        }

        let writableCalendars: GoogleCalendarMetadata[] = [];
        const actionPlanPreview = planGoogleCalendarEventAction(
          lastContent,
          writableCalendars,
          now,
          refreshedActiveEventContext,
        );
        if (actionPlanPreview.kind === 'none') {
          return false;
        }

        if (actionPlanPreview.kind === 'needs_event_context') {
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Google Calendar*',
              actionPlanPreview.message,
            ),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }

        const googleConfig = resolveGoogleCalendarConfig();
        const discoveredCalendars = await listGoogleCalendars(googleConfig);
        writableCalendars = discoveredCalendars.filter(
          (calendar) => calendar.selected && calendar.writable,
        );
        const actionPlan = planGoogleCalendarEventAction(
          lastContent,
          discoveredCalendars,
          now,
          refreshedActiveEventContext,
        );
        if (actionPlan.kind === 'none') {
          return false;
        }
        if (actionPlan.kind === 'needs_event_context') {
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText('*Google Calendar*', actionPlan.message),
            {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
          );
          return true;
        }
        if (actionPlan.kind === 'resolve_anchor') {
          const anchorStart = new Date(actionPlan.anchorDate);
          anchorStart.setHours(0, 0, 0, 0);
          const anchorEnd = new Date(anchorStart);
          anchorEnd.setDate(anchorEnd.getDate() + 1);
          const { events } = await listGoogleCalendarEvents(
            {
              start: anchorStart,
              end: anchorEnd,
              calendarIds: googleConfig.calendarIds,
            },
            googleConfig,
          );
          const anchorPoint = new Date(actionPlan.anchorDate);
          anchorPoint.setHours(
            actionPlan.anchorTime.hours,
            actionPlan.anchorTime.minutes,
            0,
            0,
          );
          const matches = events.filter((event) => {
            if (event.allDay) return false;
            const eventStart = new Date(event.startIso).getTime();
            const eventEnd = new Date(event.endIso).getTime();
            const point = anchorPoint.getTime();
            return eventStart <= point && eventEnd > point;
          });
          if (matches.length === 0) {
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                `I couldn't find a ${actionPlan.anchorTime.displayLabel} meeting to schedule around on that day.`,
              ),
              {
                inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                  actionPlan.state,
                ),
              },
            );
            return true;
          }
          if (matches.length > 1) {
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText(
                '*Google Calendar*',
                `I found more than one event around ${actionPlan.anchorTime.displayLabel}. Tell me which one you mean.`,
              ),
              {
                inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                  actionPlan.state,
                ),
              },
            );
            return true;
          }

          const anchorEvent = matches[0];
          const sourceStart = new Date(actionPlan.state.sourceEvent.startIso);
          const sourceEnd = new Date(actionPlan.state.sourceEvent.endIso);
          const durationMs = sourceEnd.getTime() - sourceStart.getTime();
          const movedState =
            await enrichPendingGoogleCalendarEventActionStateWithConflicts({
              ...actionPlan.state,
              proposedEvent: {
                ...actionPlan.state.sourceEvent,
                startIso: anchorEvent.endIso,
                endIso: new Date(
                  new Date(anchorEvent.endIso).getTime() + durationMs,
                ).toISOString(),
                allDay: false,
              },
              conflictSummary: null,
            });
          setPendingGoogleCalendarEventActionState(chatJid, movedState);
          await channel.sendMessage(
            chatJid,
            formatCalendarPanelText(
              '*Google Calendar*',
              formatPendingGoogleCalendarEventActionPrompt(movedState),
            ),
            {
              inlineActionRows:
                buildGoogleCalendarEventActionInlineRows(movedState),
            },
          );
          return true;
        }

        const enrichedState =
          actionPlan.state.action === 'move' ||
          actionPlan.state.action === 'resize'
            ? await enrichPendingGoogleCalendarEventActionStateWithConflicts(
                actionPlan.state,
              )
            : actionPlan.state;
        setPendingGoogleCalendarEventActionState(chatJid, enrichedState);
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText(
            '*Google Calendar*',
            formatPendingGoogleCalendarEventActionPrompt(enrichedState),
          ),
          {
            inlineActionRows:
              buildGoogleCalendarEventActionInlineRows(enrichedState),
          },
        );
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local Google calendar follow-through path failed, rolled back cursor for retry',
        );
        return false;
      }
    };
  const tryHandleLocalGoogleCalendarCreate = async (): Promise<boolean> => {
    const schedulingContext = getGoogleCalendarSchedulingContext(chatJid);
    if (
      schedulingContext &&
      isGoogleCalendarSchedulingContextExpired(schedulingContext, now)
    ) {
      clearGoogleCalendarSchedulingContext(chatJid);
    }

    const pendingState = getPendingGoogleCalendarCreateState(chatJid);
    if (
      pendingState &&
      isPendingGoogleCalendarCreateExpired(pendingState, now)
    ) {
      clearPendingGoogleCalendarCreateState(chatJid);
    }

    let activePendingState = getPendingGoogleCalendarCreateState(chatJid);
    const explicitCreate = isExplicitGoogleCalendarCreateRequest(lastContent);
    let writableCalendars:
      | Awaited<ReturnType<typeof listGoogleCalendars>>
      | undefined;
    let createPlan: ReturnType<typeof planGoogleCalendarCreate> | undefined;

    if (activePendingState && explicitCreate) {
      try {
        const googleConfig = resolveGoogleCalendarConfig();
        const discoveredCalendars = await listGoogleCalendars(googleConfig);
        writableCalendars = discoveredCalendars.filter(
          (calendar) => calendar.selected && calendar.writable,
        );
        createPlan = planGoogleCalendarCreate(
          lastContent,
          writableCalendars,
          now,
          TIMEZONE,
          null,
        );
        if (createPlan.kind === 'draft') {
          clearPendingGoogleCalendarCreateState(chatJid);
          clearGoogleCalendarSchedulingContext(chatJid);
          activePendingState = null;
        }
      } catch {
        // Let the normal create path surface the underlying calendar failure.
      }
    }

    if (!activePendingState) {
      const activeSchedulingContext = getGoogleCalendarSchedulingContext(chatJid);
      if (!explicitCreate) {
        return false;
      }

      try {
        if (!writableCalendars || !createPlan) {
          const googleConfig = resolveGoogleCalendarConfig();
          const discoveredCalendars = await listGoogleCalendars(googleConfig);
          writableCalendars = discoveredCalendars.filter(
            (calendar) => calendar.selected && calendar.writable,
          );
          createPlan = planGoogleCalendarCreate(
            lastContent,
            writableCalendars,
            now,
            TIMEZONE,
            activeSchedulingContext,
          );
        }
      } catch (error) {
        try {
          const technicalDetail =
            error instanceof Error ? error.message : String(error);
          await sendAssistantReplyWithFeedback({
            text: buildCalendarCompanionFailurePanelText({
              title: '*Google Calendar*',
              channelName: channel.name,
              action: 'create_event',
              technicalDetail,
            }),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            routeKey: 'google_calendar.create_event',
            capabilityId: 'calendar.google_create',
            handlerKind: 'google_calendar_create_local',
            responseSource: 'local_companion',
            traceReason: 'google calendar create fast path hit a provider failure',
            blockerClass: technicalDetail,
            blockerOwner: 'external',
          });
          logger.warn(
            {
              component: 'assistant',
              chatJid,
              groupFolder: group.folder,
              group: group.name,
              err: error,
              technicalDetail,
            },
            'Google calendar create unavailable during local fast path',
          );
          return true;
        } catch (sendError) {
          lastAgentTimestamp[chatJid] = previousCursor;
          saveState();
          logger.warn(
            { group: group.name, err: sendError },
            'Google calendar unavailable reply failed, rolled back cursor for retry',
          );
          return false;
        }
      }

      if (!createPlan || createPlan.kind === 'none') {
        return false;
      }

      clearPendingActionReminderState(chatJid);
      clearPendingActionDraftState(chatJid);

      const noWritableCalendars =
        !writableCalendars || writableCalendars.length === 0;
      const pendingDraftState =
        createPlan.kind === 'draft' && !noWritableCalendars
          ? await enrichPendingGoogleCalendarCreateStateWithConflicts(
              buildPendingGoogleCalendarCreateState({
                draft: createPlan.draft,
                writableCalendars,
                selectedCalendarId: createPlan.selectedCalendarId,
                now,
              }),
            )
          : null;
      const pendingStateToPersist =
        pendingDraftState ||
        (createPlan.kind === 'needs_details' && !noWritableCalendars
          ? createPlan.pendingState || null
          : null);
      const reply =
        createPlan.kind === 'needs_details'
          ? createPlan.message
          : noWritableCalendars
            ? buildCalendarCompanionFailureReply({
                channel: resolveConversationalChannelForChannelName(channel.name),
                action: 'create_event',
                kind: 'calendar_auth_unavailable',
              })
            : formatGoogleCalendarCreatePrompt(pendingDraftState!);

      try {
        if (pendingStateToPersist) {
          setPendingGoogleCalendarCreateState(chatJid, pendingStateToPersist);
          const contextState = buildGoogleCalendarSchedulingContextState({
            draft: pendingStateToPersist.draft,
            now,
          });
          if (contextState) {
            setGoogleCalendarSchedulingContext(chatJid, contextState);
          }
        }
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText('*Google Calendar*', reply),
          sendOptions: {
            inlineActionRows: pendingDraftState
              ? buildGoogleCalendarCreateInlineActionRows(pendingDraftState)
              : buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason:
            createPlan.kind === 'needs_details'
              ? 'google calendar create is waiting on one missing detail'
              : 'google calendar create draft is ready for confirmation',
        });
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
          },
          'Handled Google calendar create via local fast path',
        );
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local Google calendar create path failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    const continueResult = advancePendingGoogleCalendarCreate(
      lastContent,
      activePendingState,
    );
    if (continueResult.kind === 'no_match') {
      return false;
    }

    if (continueResult.kind === 'cancelled') {
      try {
        clearPendingGoogleCalendarCreateState(chatJid);
        clearGoogleCalendarSchedulingContext(chatJid);
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            '*Google Calendar*',
            continueResult.message,
          ),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason: 'google calendar create flow was cancelled in-thread',
        });
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local Google calendar cancel reply failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    if (continueResult.kind === 'resolve_anchor') {
      try {
        const googleConfig = resolveGoogleCalendarConfig();
        const anchorStart = new Date(continueResult.anchorDate);
        anchorStart.setHours(0, 0, 0, 0);
        const anchorEnd = new Date(anchorStart);
        anchorEnd.setDate(anchorEnd.getDate() + 1);
        const { events } = await listGoogleCalendarEvents(
          {
            start: anchorStart,
            end: anchorEnd,
            calendarIds: googleConfig.calendarIds,
          },
          googleConfig,
        );
        const anchorPoint = new Date(continueResult.anchorDate);
        anchorPoint.setHours(
          continueResult.anchorTime.hours,
          continueResult.anchorTime.minutes,
          0,
          0,
        );
        const matches = events.filter((event) => {
          if (event.allDay) return false;
          const eventStart = new Date(event.startIso).getTime();
          const eventEnd = new Date(event.endIso).getTime();
          const point = anchorPoint.getTime();
          return eventStart <= point && eventEnd > point;
        });

        if (matches.length === 0) {
          await sendAssistantReplyWithFeedback({
            text: formatCalendarPanelText(
              '*Google Calendar*',
              `I couldn't find a ${continueResult.anchorTime.displayLabel} meeting to schedule around on that day.`,
            ),
            sendOptions: {
              inlineActionRows: buildGoogleCalendarCreateInlineActionRows(
                continueResult.state,
              ),
            },
            routeKey: 'google_calendar.create_event',
            capabilityId: 'calendar.google_create',
            handlerKind: 'google_calendar_create_local',
            responseSource: 'local_companion',
            traceReason:
              'google calendar create could not resolve the requested anchor event',
          });
          return true;
        }

        if (matches.length > 1) {
          await sendAssistantReplyWithFeedback({
            text: formatCalendarPanelText(
              '*Google Calendar*',
              `I found more than one event around ${continueResult.anchorTime.displayLabel}. Tell me which one you mean so I can move it.`,
            ),
            sendOptions: {
              inlineActionRows: buildGoogleCalendarCreateInlineActionRows(
                continueResult.state,
              ),
            },
            routeKey: 'google_calendar.create_event',
            capabilityId: 'calendar.google_create',
            handlerKind: 'google_calendar_create_local',
            responseSource: 'local_companion',
            traceReason:
              'google calendar create needs one more clarification about the anchor event',
          });
          return true;
        }

        const durationMs =
          new Date(continueResult.state.draft.endIso).getTime() -
          new Date(continueResult.state.draft.startIso).getTime();
        const anchorEvent = matches[0];
        const movedState =
          await enrichPendingGoogleCalendarCreateStateWithConflicts({
            ...continueResult.state,
            draft: {
              ...continueResult.state.draft,
              startIso: anchorEvent.endIso,
              endIso: new Date(
                new Date(anchorEvent.endIso).getTime() + durationMs,
              ).toISOString(),
            },
            conflictSummary: null,
          });
        setPendingGoogleCalendarCreateState(chatJid, movedState);
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            '*Google Calendar*',
            formatGoogleCalendarCreatePrompt(movedState),
          ),
          sendOptions: {
            inlineActionRows:
              buildGoogleCalendarCreateInlineActionRows(movedState),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason:
            'google calendar create resolved the requested anchor event and refreshed the draft',
        });
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local Google calendar anchor resolution failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    if (continueResult.kind === 'awaiting_input') {
      try {
        const enrichedState =
          await enrichPendingGoogleCalendarCreateStateWithConflicts(
            continueResult.state,
          );
        setPendingGoogleCalendarCreateState(chatJid, enrichedState);
        const contextState = buildGoogleCalendarSchedulingContextState({
          draft: enrichedState.draft,
          now,
        });
        if (contextState) {
          setGoogleCalendarSchedulingContext(chatJid, contextState);
        }
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            '*Google Calendar*',
            formatGoogleCalendarCreatePrompt(enrichedState),
          ),
          sendOptions: {
            inlineActionRows:
              buildGoogleCalendarCreateInlineActionRows(enrichedState),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason:
            'google calendar create stayed in the same-thread continuation flow',
        });
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local Google calendar follow-up prompt failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    try {
      const googleConfig = resolveGoogleCalendarConfig();
      const createdEvent = await createGoogleCalendarEvent(
        {
          calendarId: continueResult.calendarId,
          title: continueResult.state.draft.title,
          start: new Date(continueResult.state.draft.startIso),
          end: new Date(continueResult.state.draft.endIso),
          timeZone: continueResult.state.draft.timeZone,
          allDay: continueResult.state.draft.allDay,
          location: continueResult.state.draft.location,
          description: continueResult.state.draft.description,
        },
        googleConfig,
      );
      const selectedCalendar = continueResult.state.calendars.find(
        (calendar) => calendar.id === continueResult.calendarId,
      );
      clearPendingGoogleCalendarCreateState(chatJid);
      clearGoogleCalendarSchedulingContext(chatJid);
      setActiveGoogleCalendarEventContext(
        chatJid,
        buildActiveGoogleCalendarEventContextState(createdEvent, now),
      );
      await sendAssistantReplyWithFeedback({
        text: formatCalendarPanelText(
          '*Google Calendar*',
          buildCalendarCompanionEventReply({
            action: 'create_event',
            title: continueResult.state.draft.title,
            startIso: createdEvent.startIso,
            endIso: createdEvent.endIso,
            allDay: continueResult.state.draft.allDay,
            timeZone: continueResult.state.draft.timeZone,
            calendarName:
              selectedCalendar?.summary ||
              createdEvent.calendarName ||
              'Google Calendar',
            htmlLink: createdEvent.htmlLink || null,
          }),
        ),
        sendOptions: {
          inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
            htmlLink: createdEvent.htmlLink || null,
          }),
        },
        routeKey: 'google_calendar.create_event',
        capabilityId: 'calendar.google_create',
        handlerKind: 'google_calendar_create_local',
        responseSource: 'local_companion',
        traceReason: 'created a google calendar event through the local fast path',
        linkedRefs: {
          googleCalendarEventId: createdEvent.id,
        },
      });
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          calendarId: continueResult.calendarId,
        },
        'Created Google calendar event via local fast path',
      );
      return true;
    } catch (error) {
      try {
        clearPendingGoogleCalendarCreateState(chatJid);
        clearGoogleCalendarSchedulingContext(chatJid);
        const technicalDetail =
          error instanceof Error ? error.message : String(error);
        await sendAssistantReplyWithFeedback({
          text: buildCalendarCompanionFailurePanelText({
            title: '*Google Calendar*',
            channelName: channel.name,
            action: 'create_event',
            technicalDetail,
          }),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason: 'google calendar create failed after confirmation',
          blockerClass: technicalDetail,
          blockerOwner: 'external',
        });
        logger.warn(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            err: error,
            technicalDetail,
          },
          'Google calendar event create failed during local fast path',
        );
        return true;
      } catch (sendError) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err: sendError },
          'Google calendar create failure reply failed, rolled back cursor for retry',
        );
        return false;
      }
    }
  };
  const getCurrentActiveGoogleCalendarActionContext = () => {
    const activeEventContextState =
      getActiveGoogleCalendarEventContext(chatJid);
    return activeEventContextState &&
      !isActiveGoogleCalendarEventContextExpired(activeEventContextState, now)
      ? {
          providerId: 'google_calendar' as const,
          id: activeEventContextState.event.id,
          title: activeEventContextState.event.title,
          startIso: activeEventContextState.event.startIso,
          endIso: activeEventContextState.event.endIso,
          allDay: activeEventContextState.event.allDay,
          calendarId: activeEventContextState.event.calendarId || null,
          calendarName: activeEventContextState.event.calendarName || null,
          htmlLink: activeEventContextState.event.htmlLink || null,
        }
      : null;
  };
  const tryHandleLocalActionLayer = async (
    fastPathKind: 'direct' | 'protected',
  ): Promise<boolean> => {
    try {
      const actionContextState = getActionLayerContext(chatJid);
      if (
        actionContextState &&
        isActionLayerContextExpired(actionContextState, now)
      ) {
        clearActionLayerContext(chatJid);
      }

      const pendingActionReminder = getPendingActionReminderState(chatJid);
      if (
        pendingActionReminder &&
        isPendingActionReminderExpired(pendingActionReminder, now)
      ) {
        clearPendingActionReminderState(chatJid);
      }

      const pendingActionDraft = getPendingActionDraftState(chatJid);
      if (
        pendingActionDraft &&
        isPendingActionDraftExpired(pendingActionDraft, now)
      ) {
        clearPendingActionDraftState(chatJid);
      }

      const freshIntent = planActionLayerIntent(lastContent);
      const shouldInterruptPendingActionFlow =
        !freshIntent &&
        shouldInterruptPendingActionLayerFlow(lastContent, {
          now,
          timeZone: TIMEZONE,
          groupFolder: group.folder,
          chatJid,
        });
      const activeActionReminder = getPendingActionReminderState(chatJid);
      if (activeActionReminder) {
        if (freshIntent) {
          clearPendingActionReminderState(chatJid);
        } else if (shouldInterruptPendingActionFlow) {
          clearPendingActionReminderState(chatJid);
          return false;
        } else {
          const continued = advancePendingActionReminder(
            lastContent,
            activeActionReminder,
            {
              groupFolder: group.folder,
              chatJid,
              now,
            },
          );
          if (continued.kind === 'awaiting_reminder_time') {
            setPendingActionReminderState(chatJid, continued.state);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Next Step*', continued.message),
              {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
            );
            return true;
          }
          clearPendingActionReminderState(chatJid);
          if (continued.kind === 'none') {
            return false;
          }
          if (continued.kind === 'created_reminder') {
            createTask(continued.task);
            syncOutcomeFromReminderTask(continued.task, {
              linkedRefs: {
                reminderTaskId: continued.task.id,
                chatJid,
              },
              summaryText: continued.confirmation,
              now,
            });
            refreshTaskSnapshots(registeredGroups);
            if (continued.state) {
              setPendingActionReminderState(chatJid, continued.state);
            }
            if (continued.actionContext) {
              setActionLayerContext(chatJid, continued.actionContext);
            }
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Next Step*', continued.confirmation),
              {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
            );
            return true;
          }
          if (continued.kind === 'reply') {
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Next Step*', continued.reply),
              {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
            );
            return true;
          }
          return false;
        }
      }

      const activeActionDraft = getPendingActionDraftState(chatJid);
      if (activeActionDraft) {
        if (freshIntent) {
          clearPendingActionDraftState(chatJid);
        } else if (shouldInterruptPendingActionFlow) {
          clearPendingActionDraftState(chatJid);
          return false;
        } else {
          const continued = advancePendingActionDraft(
            lastContent,
            activeActionDraft,
            now,
          );
          if (continued.kind === 'awaiting_draft_input') {
            setPendingActionDraftState(chatJid, continued.state);
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Next Step*', continued.message),
              {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
            );
            return true;
          }
          clearPendingActionDraftState(chatJid);
          if (continued.kind === 'reply') {
            if (continued.actionContext) {
              setActionLayerContext(chatJid, continued.actionContext);
            }
            if (
              continued.activeEventContext?.providerId === 'google_calendar' &&
              continued.activeEventContext.calendarId
            ) {
              setActiveGoogleCalendarEventContext(
                chatJid,
                buildActiveGoogleCalendarEventContextState(
                  {
                    id: continued.activeEventContext.id,
                    title: continued.activeEventContext.title,
                    startIso: continued.activeEventContext.startIso,
                    endIso: continued.activeEventContext.endIso,
                    allDay: continued.activeEventContext.allDay,
                    calendarId: continued.activeEventContext.calendarId,
                    calendarName:
                      continued.activeEventContext.calendarName ||
                      'Google Calendar',
                    htmlLink: continued.activeEventContext.htmlLink || null,
                  },
                  now,
                ),
              );
            }
            await channel.sendMessage(
              chatJid,
              formatCalendarPanelText('*Next Step*', continued.reply),
              {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
            );
            return true;
          }
        }
      }

      const selectedWork = await getSelectedDailyWorkContext(
        chatJid,
        missedMessages.at(-1)?.thread_id,
      );
      const actionResult = await buildActionLayerResponse(lastContent, {
        now,
        timeZone: TIMEZONE,
        activeEventContext: getCurrentActiveGoogleCalendarActionContext(),
        actionContext: getActionLayerContext(chatJid),
        selectedWork,
        tasks: getAllTasks().filter((task) => task.chat_jid === chatJid),
        groupFolder: group.folder,
        chatJid,
      });
      if (actionResult.kind === 'none') {
        return false;
      }

      if (actionResult.kind === 'awaiting_reminder_time') {
        setPendingActionReminderState(chatJid, actionResult.state);
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText('*Next Step*', actionResult.message),
          {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
        );
        return true;
      }

      if (actionResult.kind === 'awaiting_draft_input') {
        setPendingActionDraftState(chatJid, actionResult.state);
        if (actionResult.actionContext) {
          setActionLayerContext(chatJid, actionResult.actionContext);
        }
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText('*Next Step*', actionResult.message),
          {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
        );
        return true;
      }

      if (actionResult.kind === 'created_reminder') {
        createTask(actionResult.task);
        syncOutcomeFromReminderTask(actionResult.task, {
          linkedRefs: {
            reminderTaskId: actionResult.task.id,
            chatJid,
          },
          summaryText: actionResult.confirmation,
          now,
        });
        refreshTaskSnapshots(registeredGroups);
        if (actionResult.state) {
          setPendingActionReminderState(chatJid, actionResult.state);
        } else {
          clearPendingActionReminderState(chatJid);
        }
        if (actionResult.actionContext) {
          setActionLayerContext(chatJid, actionResult.actionContext);
        }
        await channel.sendMessage(
          chatJid,
          formatCalendarPanelText('*Next Step*', actionResult.confirmation),
          {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
        );
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            requestRoute: requestPolicy.route,
            actionLayerFastPath: fastPathKind,
            reminderTaskId: actionResult.task.id,
          },
          'Handled action-layer reminder via local fast path',
        );
        return true;
      }

      if (actionResult.actionContext) {
        setActionLayerContext(chatJid, actionResult.actionContext);
      } else {
        clearActionLayerContext(chatJid);
      }
      if (
        actionResult.activeEventContext?.providerId === 'google_calendar' &&
        actionResult.activeEventContext.calendarId
      ) {
        setActiveGoogleCalendarEventContext(
          chatJid,
          buildActiveGoogleCalendarEventContextState(
            {
              id: actionResult.activeEventContext.id,
              title: actionResult.activeEventContext.title,
              startIso: actionResult.activeEventContext.startIso,
              endIso: actionResult.activeEventContext.endIso,
              allDay: actionResult.activeEventContext.allDay,
              calendarId: actionResult.activeEventContext.calendarId,
              calendarName:
                actionResult.activeEventContext.calendarName ||
                'Google Calendar',
              htmlLink: actionResult.activeEventContext.htmlLink || null,
            },
            now,
          ),
        );
      }
      await channel.sendMessage(
        chatJid,
        formatCalendarPanelText('*Next Step*', actionResult.reply),
        {
          inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
        },
      );
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          actionLayerFastPath: fastPathKind,
        },
        'Handled action layer via local fast path',
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err, requestRoute: requestPolicy.route },
        'Local action layer path failed, rolled back cursor for retry',
      );
      return false;
    }
  };
  const tryHandleLocalDailyCompanion = async (
    fastPathKind: 'direct' | 'protected',
  ): Promise<boolean> => {
    const selectedWork = await getSelectedDailyWorkContext(
      chatJid,
      missedMessages.at(-1)?.thread_id,
    );
    const dailyResponse = await buildDailyCompanionResponse(lastContent, {
      channel: conversationChannel,
      now,
      timeZone: TIMEZONE,
      groupFolder: group.folder,
      activeEventContext: getCurrentActiveGoogleCalendarActionContext(),
      selectedWork,
      tasks: getAllTasks().filter((task) => task.group_folder === group.folder),
      priorContext: getDailyCompanionContext(chatJid, now),
    });
    if (!dailyResponse) {
      return false;
    }

    try {
      const actionContext = dailyResponse.grounded
        ? buildActionLayerContextFromDailyCommandCenter({
            grounded: dailyResponse.grounded,
          })
        : null;
      await sendAssistantReplyWithFeedback({
        text: formatCalendarPanelText(
          formatDailyCompanionPanelTitle(dailyResponse.mode),
          dailyResponse.reply,
        ),
        sendOptions: {
          inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
        },
        routeKey: `daily_local_fast_path:${dailyResponse.mode}`,
        capabilityId: `daily.${dailyResponse.mode}`,
        handlerKind: 'daily_local_fast_path',
        responseSource: 'local_companion',
        traceReason: 'handled daily companion via local fast path',
        linkedRefs: {},
      });
      if (actionContext) {
        setActionLayerContext(chatJid, actionContext);
      } else {
        clearActionLayerContext(chatJid);
      }
      clearSharedAssistantCapabilitySeed(chatJid);
      setDailyCompanionContext(chatJid, dailyResponse.context);
      const suggestedThread =
        lastContent &&
        group.folder
          ? maybeCreatePendingLifeThreadSuggestion({
              groupFolder: group.folder,
              chatJid,
              text: lastContent,
              replyText: missedMessages.at(-1)?.reply_to?.content,
              conversationSummary: dailyResponse.context.summaryText,
              now,
            })
          : null;
      if (suggestedThread) {
        await channel.sendMessage(
          chatJid,
          buildLifeThreadSuggestionAskText(suggestedThread.title),
        );
      }
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          dailyCompanionFastPath: fastPathKind,
          dailyCompanionMode: dailyResponse.mode,
        },
        'Handled daily companion via local fast path',
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err, requestRoute: requestPolicy.route },
        'Local daily companion path failed, rolled back cursor for retry',
      );
      return false;
    }
  };
  const tryHandleLocalCalendarReply = async (
    fastPathKind: 'direct' | 'protected',
  ): Promise<boolean> => {
    const activeEventContext = getActiveGoogleCalendarEventContext(chatJid);
    const calendarResponse = await buildCalendarAssistantResponse(lastContent, {
      now,
      timeZone: TIMEZONE,
      activeEventContext: activeEventContext
        ? {
            providerId: 'google_calendar',
            id: activeEventContext.event.id,
            title: activeEventContext.event.title,
            startIso: activeEventContext.event.startIso,
            endIso: activeEventContext.event.endIso,
            allDay: activeEventContext.event.allDay,
            calendarId: activeEventContext.event.calendarId || null,
            calendarName: activeEventContext.event.calendarName || null,
            htmlLink: activeEventContext.event.htmlLink || null,
          }
        : null,
    });
    if (!calendarResponse) {
      return false;
    }

    try {
      clearPendingActionReminderState(chatJid);
      clearPendingActionDraftState(chatJid);
      if (calendarResponse.schedulingContext) {
        setGoogleCalendarSchedulingContext(
          chatJid,
          toGoogleCalendarSchedulingContextState(
            calendarResponse.schedulingContext,
            now,
          ),
        );
      }
      if (
        calendarResponse.activeEventContext?.providerId === 'google_calendar' &&
        calendarResponse.activeEventContext.calendarId
      ) {
        setActiveGoogleCalendarEventContext(
          chatJid,
          buildActiveGoogleCalendarEventContextState(
            {
              id: calendarResponse.activeEventContext.id,
              title: calendarResponse.activeEventContext.title,
              startIso: calendarResponse.activeEventContext.startIso,
              endIso: calendarResponse.activeEventContext.endIso,
              allDay: calendarResponse.activeEventContext.allDay,
              calendarId: calendarResponse.activeEventContext.calendarId,
              calendarName:
                calendarResponse.activeEventContext.calendarName ||
                'Google Calendar',
              htmlLink: calendarResponse.activeEventContext.htmlLink || null,
            },
            now,
          ),
        );
      } else {
        clearActiveGoogleCalendarEventContext(chatJid);
      }
      await sendAssistantReplyWithFeedback({
        text: formatCalendarPanelText('*Calendar*', calendarResponse.reply),
        sendOptions: {
          inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
        },
        routeKey: 'calendar_local_fast_path',
        capabilityId: 'calendar.local_lookup',
        handlerKind: 'calendar_local_fast_path',
        responseSource: 'local_companion',
        traceReason: 'handled calendar lookup via local fast path',
        linkedRefs: activeEventContext
          ? {
              googleCalendarEventId: activeEventContext.event.id,
            }
          : {},
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          calendarFastPath: fastPathKind,
        },
        'Handled calendar lookup via local fast path',
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err, requestRoute: requestPolicy.route },
        'Local calendar path failed, rolled back cursor for retry',
      );
      return false;
    }
  };

  const startConversationPilotProof = (
    seed:
      | ReturnType<typeof resolveOrdinaryChatPilotJourney>
      | ReturnType<typeof resolveCrossChannelPilotJourney>
      | ReturnType<typeof resolvePilotJourneyFromCapability>,
  ) =>
    seed
      ? startPilotJourney({
          ...seed,
          channel: conversationChannel,
          groupFolder: group.folder,
          chatJid,
          threadId: missedMessages.at(-1)?.thread_id || null,
        })
      : null;

  const completeConversationPilotProof = (
    record: ReturnType<typeof startPilotJourney>,
    params: Omit<PilotJourneyCompleteParams, 'eventId'>,
  ): void => {
    if (!record) return;
    completePilotJourney({
      eventId: record.eventId,
      ...params,
    });
  };

  const buildCapabilityPilotOutcome = (
    result: AssistantCapabilityResult,
    explicitHandoffTarget: 'telegram' | 'bluebubbles' | null,
    explicitHandoffCreated = false,
  ): {
    outcome: PilotJourneyOutcome;
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    degradedPath?: string | null;
    systemsInvolved?: string[];
    handoffCreated?: boolean;
    missionCreated?: boolean;
    threadSaved?: boolean;
    reminderCreated?: boolean;
    librarySaved?: boolean;
    currentWorkRef?: string | null;
    summaryText?: string | null;
  } => {
    const systemsInvolved = new Set<string>();
    const capabilityId = result.capabilityId || '';
    if (result.dailyResponse) {
      systemsInvolved.add('daily_companion');
    }
    if (result.lifeThreadResult?.referencedThread) {
      systemsInvolved.add('life_threads');
    }
    if (capabilityId.startsWith('communication.')) {
      systemsInvolved.add('communication_companion');
    }
    if (capabilityId.startsWith('missions.')) {
      systemsInvolved.add('missions');
      systemsInvolved.add('chief_of_staff');
    }
    if (capabilityId.startsWith('staff.')) {
      systemsInvolved.add('chief_of_staff');
    }
    if (capabilityId.startsWith('knowledge.')) {
      systemsInvolved.add('knowledge_library');
    }
    if (capabilityId.startsWith('threads.')) {
      systemsInvolved.add('life_threads');
    }
    if (result.trace?.responseSource?.startsWith('research')) {
      systemsInvolved.add('research');
    }
    if (result.trace?.responseSource?.startsWith('media')) {
      systemsInvolved.add('image_generation');
    }
    if (explicitHandoffTarget && explicitHandoffCreated) {
      systemsInvolved.add('cross_channel_handoffs');
      systemsInvolved.add(explicitHandoffTarget);
    }
    return {
      outcome:
        (capabilityId.startsWith('research.') ||
          capabilityId.startsWith('media.')) &&
        result.trace?.responseSource === 'unavailable'
          ? 'externally_blocked'
          : result.trace?.responseSource === 'unavailable'
            ? 'degraded_usable'
            : 'success',
      blockerClass:
        capabilityId.startsWith('research.') &&
        result.trace?.responseSource === 'unavailable'
          ? 'outward_research_blocked'
          : capabilityId.startsWith('media.') &&
              result.trace?.responseSource === 'unavailable'
            ? 'image_generation_blocked'
            : result.trace?.responseSource === 'unavailable'
              ? 'local_degraded_path'
              : null,
      blockerOwner:
        (capabilityId.startsWith('research.') ||
          capabilityId.startsWith('media.')) &&
        result.trace?.responseSource === 'unavailable'
          ? 'external'
          : result.trace?.responseSource === 'unavailable'
            ? 'repo_side'
            : 'none',
      degradedPath:
        result.trace?.responseSource === 'unavailable'
          ? result.trace.reason
          : null,
      systemsInvolved: [...systemsInvolved],
      handoffCreated: explicitHandoffCreated,
      missionCreated: Boolean(
        result.conversationSeed?.subjectData?.missionId ||
          result.continuationCandidate?.missionId,
      ),
      threadSaved: Boolean(result.lifeThreadResult?.referencedThread),
      librarySaved: capabilityId === 'knowledge.save_source',
      summaryText:
        result.conversationSeed?.summaryText ||
        result.replyText ||
        result.trace?.reason ||
        null,
    };
  };

  const buildCompletionPilotOutcome = (
    result: Awaited<ReturnType<typeof completeAssistantActionFromAlexa>>,
  ): {
    outcome: PilotJourneyOutcome;
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    degradedPath?: string | null;
    systemsInvolved?: string[];
    handoffCreated?: boolean;
    missionCreated?: boolean;
    threadSaved?: boolean;
    reminderCreated?: boolean;
    librarySaved?: boolean;
    currentWorkRef?: string | null;
    summaryText?: string | null;
  } => {
    const capabilityOutcome = result.capabilityResult
      ? buildCapabilityPilotOutcome(result.capabilityResult, null)
      : null;
    const systemsInvolved = new Set(capabilityOutcome?.systemsInvolved || []);
    if (result.handoffResult) {
      systemsInvolved.add('cross_channel_handoffs');
    }
    if (result.bridgeSaveForLaterText || result.lifeThreadResult?.referencedThread) {
      systemsInvolved.add('life_threads');
    }
    if (result.reminderTaskId) {
      systemsInvolved.add('reminders');
    }
    if (result.bridgeDraftReference) {
      systemsInvolved.add('communication_companion');
    }
    return {
      outcome: capabilityOutcome?.outcome || 'success',
      blockerClass: capabilityOutcome?.blockerClass || null,
      blockerOwner: capabilityOutcome?.blockerOwner || 'none',
      degradedPath: capabilityOutcome?.degradedPath || null,
      systemsInvolved: [...systemsInvolved],
      handoffCreated: Boolean(result.handoffResult),
      missionCreated: Boolean(
        capabilityOutcome?.missionCreated ||
          result.capabilityResult?.conversationSeed?.subjectData?.missionId,
      ),
      threadSaved: Boolean(
        result.bridgeSaveForLaterText || result.lifeThreadResult?.referencedThread,
      ),
      reminderCreated: Boolean(result.reminderTaskId),
      librarySaved: Boolean(capabilityOutcome?.librarySaved),
      summaryText:
        result.replyText ||
        result.bridgeSaveForLaterText ||
        result.bridgeDraftReference ||
        result.capabilityResult?.conversationSeed?.summaryText ||
        result.capabilityResult?.replyText ||
        null,
    };
  };

  const tryHandleSharedAssistantCompletion = async (): Promise<boolean> => {
    const sharedSeed = getSharedAssistantCapabilitySeed(chatJid, now);
    if (!sharedSeed) {
      return false;
    }

    const state: AlexaConversationState = {
      flowKey: sharedSeed.flowKey,
      subjectKind: sharedSeed.subjectKind,
      subjectData: sharedSeed.subjectData || {},
      summaryText: sharedSeed.summaryText,
      supportedFollowups: sharedSeed.supportedFollowups || [],
      styleHints: {},
    };
    const followup = resolveAlexaConversationFollowup(lastContent, state);
    if (!followup.ok || !followup.action) {
      return false;
    }

    const pilotRecord = startConversationPilotProof(
      resolveCrossChannelPilotJourney(lastContent),
    );
    let result: Awaited<ReturnType<typeof completeAssistantActionFromAlexa>>;
    try {
      result = await completeAssistantActionFromAlexa(
        {
          groupFolder: group.folder,
          action: followup.action,
          utterance: followup.text || lastContent,
          conversationSummary: sharedSeed.summaryText,
          priorSubjectData: sharedSeed.subjectData,
          replyText:
            sharedSeed.subjectData?.pendingActionText ||
            sharedSeed.subjectData?.lastAnswerSummary,
          now,
        },
        {
          resolveTelegramMainChat: resolveTelegramMainChatForAlexa,
          resolveBlueBubblesCompanionChat: resolveBlueBubblesCompanionChat,
          resolveHandoffTarget: resolveCompanionHandoffTarget,
          sendTelegramMessage: sendCompanionHandoffMessageToChannel,
          sendBlueBubblesMessage: sendCompanionHandoffMessageToChannel,
          sendHandoffMessage: sendCompanionHandoffMessage,
          sendTelegramArtifact: sendCompanionHandoffArtifactToChannel,
          sendHandoffArtifact: sendCompanionHandoffArtifact,
        },
      );
    } catch (err) {
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_completion_runtime_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error ? err.message : 'assistant completion failed',
      });
      throw err;
    }
    if (!result.handled) {
      return false;
    }

    try {
      if (result.reminderTaskId) {
        refreshTaskSnapshots(registeredGroups);
      }

      if (result.bridgeSaveForLaterText) {
        const savedThread = handleLifeThreadCommand({
          groupFolder: group.folder,
          channel: conversationChannel,
          chatJid,
          text: 'save this for later',
          replyText: result.bridgeSaveForLaterText,
          conversationSummary: sharedSeed.summaryText,
          now,
        });
        if (savedThread.referencedThread) {
          setLastReferencedLifeThread(chatJid, savedThread.referencedThread, now);
        }
        await sendAssistantReplyWithFeedback({
          text: savedThread.responseText || 'Okay.',
          routeKey: 'assistant_completion.save_for_later',
          capabilityId: 'capture.save_for_later',
          handlerKind: 'assistant_completion_bridge',
          responseSource: 'local_companion',
          traceReason: 'completed save-for-later follow-up from shared capability state',
          linkedRefs: savedThread.referencedThread
            ? {
                lifeThreadId: savedThread.referencedThread.id,
              }
            : {},
        });
      } else if (
        result.bridgeDraftReference &&
        sharedSeed.subjectData?.activeCapabilityId?.startsWith('communication.')
      ) {
        const draftResult = await executeAssistantCapability({
          capabilityId: 'communication.draft_reply',
          context: {
            channel: conversationChannel,
            groupFolder: group.folder,
            chatJid,
            now,
            conversationSummary: sharedSeed.summaryText,
            priorSubjectData: sharedSeed.subjectData,
            replyText: missedMessages.at(-1)?.reply_to?.content,
          },
          input: {
            text: 'what should I say back',
            canonicalText: 'what should I say back',
          },
        });
        if (!draftResult.handled) {
          return false;
        }
        if (draftResult.messageAction) {
          const presentation = buildMessageActionPresentation(
            draftResult.messageAction,
            conversationChannel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
          );
          if (channel.name === 'telegram') {
            const sent = await sendAssistantReplyWithFeedback({
              text: presentation.text,
              sendOptions: {
                inlineActionRows: presentation.inlineActionRows,
              },
              routeKey: 'assistant_completion.draft_reply',
              capabilityId: draftResult.capabilityId || 'communication.draft_reply',
              handlerKind: 'assistant_completion_bridge',
              responseSource: draftResult.trace?.responseSource || 'local_companion',
              traceReason:
                draftResult.trace?.reason ||
                'completed shared capability follow-up by reopening reply help',
              traceNotes: draftResult.trace?.notes || [],
              blockerClass: null,
              linkedRefs: {
                messageActionId: draftResult.messageAction.messageActionId,
              },
            });
            updateMessageAction(draftResult.messageAction.messageActionId, {
              presentationMessageId: sent.platformMessageId || null,
              presentationChatJid: chatJid,
              lastUpdatedAt: now.toISOString(),
            });
          } else {
            await channel.sendMessage(chatJid, presentation.text);
          }
        } else {
          await sendAssistantReplyWithFeedback({
            text: draftResult.replyText || 'Okay.',
            sendOptions: draftResult.sendOptions || {},
            routeKey: 'assistant_completion.draft_reply',
            capabilityId: draftResult.capabilityId || 'communication.draft_reply',
            handlerKind: 'assistant_completion_bridge',
            responseSource: draftResult.trace?.responseSource || 'local_companion',
            traceReason:
              draftResult.trace?.reason ||
              'completed shared capability follow-up by reopening reply help',
            traceNotes: draftResult.trace?.notes || [],
          });
        }
        if (draftResult.conversationSeed) {
          setSharedAssistantCapabilitySeed(chatJid, draftResult.conversationSeed, now);
        } else {
          clearSharedAssistantCapabilitySeed(chatJid);
        }
      } else {
        await sendAssistantReplyWithFeedback({
          text: result.replyText || 'Okay.',
          sendOptions: result.capabilityResult?.sendOptions || {},
          routeKey: 'assistant_completion',
          capabilityId: sharedSeed.subjectData?.activeCapabilityId || null,
          handlerKind: 'assistant_completion_bridge',
          responseSource:
            result.capabilityResult?.trace?.responseSource || 'local_companion',
          traceReason:
            result.capabilityResult?.trace?.reason ||
            'completed shared capability follow-up through Alexa-style action completion',
          traceNotes: result.capabilityResult?.trace?.notes || [],
          linkedRefs: result.reminderTaskId
            ? {
                reminderTaskId: result.reminderTaskId,
              }
            : {},
        });
      }

      clearActionLayerContext(chatJid);
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          followupAction: followup.action,
        },
        'Handled shared assistant follow-up completion via local fast path',
      );
      completeConversationPilotProof(pilotRecord, buildCompletionPilotOutcome(result));
      return true;
    } catch (err) {
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_completion_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error ? err.message : 'assistant completion send failed',
      });
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        {
          group: group.name,
          err,
          followupAction: followup.action,
        },
        'Shared assistant follow-up completion failed, rolled back cursor for retry',
      );
      return false;
    }
  };

  const tryHandleSharedAssistantCapability = async (): Promise<boolean> => {
    const priorAssistantCapabilitySeed = getSharedAssistantCapabilitySeed(
      chatJid,
      now,
    );
    let capabilityMatch =
      continueAssistantCapabilityFromPriorSubjectData(
        lastContent,
        priorAssistantCapabilitySeed?.subjectData,
      ) || matchAssistantCapabilityRequest(lastContent);
    if (!capabilityMatch) {
      const interpretedTurn = await maybeInterpretBlueBubblesDirectTurn();
      if (
        interpretedTurn?.assistantPrompt &&
        interpretedTurn.routeFamily !== 'chat' &&
        interpretedTurn.routeFamily !== 'message_action_followup'
      ) {
        capabilityMatch =
          continueAssistantCapabilityFromPriorSubjectData(
            interpretedTurn.assistantPrompt,
            priorAssistantCapabilitySeed?.subjectData,
          ) || matchAssistantCapabilityRequest(interpretedTurn.assistantPrompt);
      }
    }
    if (!capabilityMatch) {
      return false;
    }
    const priorDailyContext = getDailyCompanionContext(chatJid, now);
    const selectedWork = await getSelectedDailyWorkContext(
      chatJid,
      missedMessages.at(-1)?.thread_id,
    );
    const pilotRecord = startConversationPilotProof(
      resolvePilotJourneyFromCapability({
        capabilityId: capabilityMatch.capabilityId,
        channel: conversationChannel,
        text: lastContent,
        canonicalText: capabilityMatch.canonicalText,
        personName:
          priorAssistantCapabilitySeed?.subjectData?.personName,
        threadTitle: priorAssistantCapabilitySeed?.subjectData?.threadTitle,
        summaryText:
          priorAssistantCapabilitySeed?.summaryText ||
          priorDailyContext?.summaryText,
      }),
    );
    let result: AssistantCapabilityResult;
    try {
      result = await executeAssistantCapability({
        capabilityId: capabilityMatch.capabilityId,
        context: {
          channel: conversationChannel,
          groupFolder: group.folder,
          chatJid,
          now,
          selectedWork,
          conversationSummary:
            priorAssistantCapabilitySeed?.summaryText ||
            priorDailyContext?.summaryText,
          priorCompanionContext: priorDailyContext,
          priorSubjectData: priorAssistantCapabilitySeed?.subjectData,
          replyText: missedMessages.at(-1)?.reply_to?.content,
        },
        input: {
          text: lastContent,
          canonicalText: capabilityMatch.canonicalText,
        },
      });
    } catch (err) {
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_capability_runtime_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error ? err.message : 'assistant capability failed',
      });
      throw err;
    }
    if (!result.handled) {
      return false;
    }

    try {
      const explicitHandoffTarget = resolveExplicitCompanionHandoffTarget(
        lastContent,
        conversationChannel,
      );
      if (result.dailyResponse) {
        const actionContext = result.dailyResponse.grounded
          ? buildActionLayerContextFromDailyCommandCenter({
              grounded: result.dailyResponse.grounded,
            })
          : null;
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            formatDailyCompanionPanelTitle(result.dailyResponse.mode),
            result.dailyResponse.reply,
          ),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
          routeKey: capabilityMatch.capabilityId,
          capabilityId: result.capabilityId || capabilityMatch.capabilityId,
          handlerKind: result.trace?.handlerKind || 'assistant_capability',
          responseSource: result.trace?.responseSource || 'local_companion',
          traceReason: result.trace?.reason || 'handled shared daily capability',
          traceNotes: result.trace?.notes || [],
        });
        if (actionContext) {
          setActionLayerContext(chatJid, actionContext);
        } else {
          clearActionLayerContext(chatJid);
        }
        setDailyCompanionContext(chatJid, result.dailyResponse.context);
        const suggestedThread =
          lastContent && group.folder
            ? maybeCreatePendingLifeThreadSuggestion({
                groupFolder: group.folder,
                chatJid,
                text: lastContent,
                replyText: missedMessages.at(-1)?.reply_to?.content,
                conversationSummary: result.dailyResponse.context.summaryText,
                now,
              })
            : null;
        if (suggestedThread) {
          await channel.sendMessage(
            chatJid,
            buildLifeThreadSuggestionAskText(suggestedThread.title),
          );
        }
      } else if (result.lifeThreadResult) {
        if (result.lifeThreadResult.referencedThread) {
          setLastReferencedLifeThread(
            chatJid,
            result.lifeThreadResult.referencedThread,
            now,
          );
        }
        await sendAssistantReplyWithFeedback({
          text: result.replyText || 'Okay.',
          sendOptions: result.sendOptions || {},
          routeKey: capabilityMatch.capabilityId,
          capabilityId: result.capabilityId || capabilityMatch.capabilityId,
          handlerKind: result.trace?.handlerKind || 'assistant_capability',
          responseSource: result.trace?.responseSource || 'local_companion',
          traceReason:
            result.trace?.reason || 'handled shared capability via life-thread result',
          traceNotes: result.trace?.notes || [],
          linkedRefs: result.lifeThreadResult.referencedThread
            ? {
                lifeThreadId: result.lifeThreadResult.referencedThread.id,
              }
            : {},
        });
      } else if (result.mediaResult?.artifact && channel.sendArtifact) {
        await channel.sendArtifact(chatJid, result.mediaResult.artifact, {
          caption: result.replyText || result.mediaResult.summaryText,
        });
      } else if (result.messageAction) {
        if (
          result.messageAction.sendStatus === 'approved' &&
          !result.messageAction.requiresApproval
        ) {
          await applyAndPresentMessageAction({
            chatJid,
            messageActionId: result.messageAction.messageActionId,
            operation: { kind: 'send' },
            now,
          });
        } else {
          const presentation = buildMessageActionPresentation(
            result.messageAction,
            conversationChannel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
          );
          if (channel.name === 'telegram') {
            const sent = await sendAssistantReplyWithFeedback({
              text: presentation.text,
              sendOptions: {
                inlineActionRows: presentation.inlineActionRows,
              },
              routeKey: capabilityMatch.capabilityId,
              capabilityId: result.capabilityId || capabilityMatch.capabilityId,
              handlerKind: result.trace?.handlerKind || 'assistant_capability',
              responseSource: result.trace?.responseSource || 'local_companion',
              traceReason:
                result.trace?.reason ||
                'handled shared capability through a message-action presentation',
              traceNotes: result.trace?.notes || [],
              linkedRefs: {
                messageActionId: result.messageAction.messageActionId,
              },
            });
            updateMessageAction(result.messageAction.messageActionId, {
              presentationMessageId: sent.platformMessageId || null,
              presentationChatJid: chatJid,
              lastUpdatedAt: now.toISOString(),
            });
          } else {
            await channel.sendMessage(chatJid, presentation.text);
          }
        }
      } else {
        await sendAssistantReplyWithFeedback({
          text: result.replyText || 'Okay.',
          sendOptions: result.sendOptions || {},
          routeKey: capabilityMatch.capabilityId,
          capabilityId: result.capabilityId || capabilityMatch.capabilityId,
          handlerKind: result.trace?.handlerKind || 'assistant_capability',
          responseSource: result.trace?.responseSource || 'local_companion',
          traceReason: result.trace?.reason || 'handled shared assistant capability',
          traceNotes: result.trace?.notes || [],
        });
      }

      const actionBundle = createOrRefreshActionBundle({
        groupFolder: group.folder,
        presentationChannel: conversationChannel,
        presentationChatJid: chatJid,
        presentationThreadId: missedMessages.at(-1)?.thread_id || null,
        capabilityId: result.capabilityId,
        continuationCandidate: result.continuationCandidate,
        summaryText: result.conversationSeed?.summaryText || result.replyText,
        replyText: result.replyText,
        utterance: lastContent,
        now,
      });
      if (actionBundle) {
        if (result.conversationSeed) {
          result.conversationSeed.subjectData = {
            ...(result.conversationSeed.subjectData || {}),
            actionBundleId: actionBundle.bundle.bundleId,
            actionBundleTitle: actionBundle.bundle.title,
            actionBundleSummary: actionBundle.actions
              .slice(0, 3)
              .map((action) => action.summary)
              .join(', '),
          };
          result.conversationSeed.supportedFollowups = Array.from(
            new Set([
              ...(result.conversationSeed.supportedFollowups || []),
              'approve_bundle',
              'show_bundle',
            ]),
          );
        }
        if (result.continuationCandidate) {
          result.continuationCandidate.actionBundleId = actionBundle.bundle.bundleId;
          result.continuationCandidate.actionBundleTitle = actionBundle.bundle.title;
          result.continuationCandidate.actionBundleSummary = actionBundle.actions
            .slice(0, 3)
            .map((action) => action.summary)
            .join(', ');
        }
        if (conversationChannel === 'telegram') {
          const presentation = buildActionBundlePresentation(actionBundle);
          const sent = await channel.sendMessage(chatJid, presentation.text, {
            inlineActionRows: presentation.inlineActionRows,
          });
          rememberActionBundlePresentation({
            bundleId: actionBundle.bundle.bundleId,
            messageId: sent.platformMessageId || null,
            mode: presentation.mode,
            now,
          });
          const firstRuleAction = actionBundle.actions.find(
            (action) => action.delegationRuleId,
          );
          if (firstRuleAction?.delegationRuleId) {
            setDelegationRuleContext(chatJid, {
              version: 1,
              createdAt: now.toISOString(),
              focusRuleIds: [firstRuleAction.delegationRuleId],
              primaryRuleId: firstRuleAction.delegationRuleId,
              presentationMessageId: sent.platformMessageId || null,
            });
          }
        } else if (conversationChannel === 'bluebubbles') {
          await channel.sendMessage(
            chatJid,
            'I can line up the next steps here. If you want the fuller bundle, ask me to send it to Telegram.',
          );
        }
      }

      if (result.conversationSeed) {
        setSharedAssistantCapabilitySeed(chatJid, result.conversationSeed, now);
      } else {
        clearSharedAssistantCapabilitySeed(chatJid);
      }
      let explicitHandoffCreated = false;
      if (explicitHandoffTarget && result.continuationCandidate?.handoffPayload) {
        const handoff = await deliverCompanionHandoff(
          {
            groupFolder: group.folder,
            originChannel: conversationChannel,
            targetChannel: explicitHandoffTarget,
            capabilityId: result.capabilityId,
            voiceSummary:
              result.continuationCandidate.voiceSummary ||
              result.replyText ||
              'Andrea follow-up',
            payload: result.continuationCandidate.handoffPayload,
            threadId: result.continuationCandidate.threadId,
            communicationThreadId:
              result.continuationCandidate.communicationThreadId,
            communicationSubjectIds:
              result.continuationCandidate.communicationSubjectIds,
            communicationLifeThreadIds:
              result.continuationCandidate.communicationLifeThreadIds,
            lastCommunicationSummary:
              result.continuationCandidate.lastCommunicationSummary,
            missionId: result.continuationCandidate.missionId,
            missionSummary: result.continuationCandidate.missionSummary,
            missionSuggestedActionsJson:
              result.continuationCandidate.missionSuggestedActionsJson,
            missionBlockersJson:
              result.continuationCandidate.missionBlockersJson,
            missionStepFocusJson:
              result.continuationCandidate.missionStepFocusJson,
            knowledgeSourceIds: result.continuationCandidate.knowledgeSourceIds,
            followupSuggestions:
              result.continuationCandidate.followupSuggestions,
          },
          {
            resolveTelegramMainChat: resolveTelegramMainChatForAlexa,
            resolveBlueBubblesCompanionChat: resolveBlueBubblesCompanionChat,
            resolveHandoffTarget: resolveCompanionHandoffTarget,
            sendTelegramMessage: sendCompanionHandoffMessageToChannel,
            sendBlueBubblesMessage: sendCompanionHandoffMessageToChannel,
            sendHandoffMessage: sendCompanionHandoffMessage,
            sendTelegramArtifact: sendCompanionHandoffArtifactToChannel,
            sendHandoffArtifact: sendCompanionHandoffArtifact,
          },
        );
        explicitHandoffCreated = true;
        await channel.sendMessage(chatJid, handoff.speech);
      }

      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          capabilityId: result.capabilityId,
          capabilityReason: capabilityMatch.reason,
          capabilitySource: result.trace?.responseSource,
        },
        'Handled assistant request via shared capability fast path',
      );
      completeConversationPilotProof(
        pilotRecord,
        buildCapabilityPilotOutcome(
          result,
          explicitHandoffTarget,
          explicitHandoffCreated,
        ),
      );
      return true;
    } catch (err) {
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_capability_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error ? err.message : 'assistant capability send failed',
      });
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        {
          group: group.name,
          err,
          capabilityId: result.capabilityId,
        },
        'Shared capability fast path failed, rolled back cursor for retry',
      );
      return false;
    }
  };

  const tryHandleBlueBubblesFluidDirectReply = async (): Promise<boolean> => {
    const interpretedTurn = await maybeInterpretBlueBubblesDirectTurn();
    if (!interpretedTurn) {
      return false;
    }
    const clarificationNeeded =
      interpretedTurn.confidence < 0.55 && interpretedTurn.clarificationQuestion;
    const replyText =
      clarificationNeeded ||
      (interpretedTurn.routeFamily === 'chat' || interpretedTurn.routeFamily === 'help'
        ? interpretedTurn.replyText ||
          maybeBuildDirectQuickReply([
            { content: interpretedTurn.assistantPrompt || lastContent },
          ]) ||
          interpretedTurn.fallbackText
        : null);
    if (!replyText) {
      return false;
    }
    await sendAssistantReplyWithFeedback({
      text: replyText,
      routeKey: 'bluebubbles_fluid_direct_reply',
      handlerKind: 'messages_fluidity',
      responseSource: interpretedTurn.source || 'local_companion',
      traceReason:
        interpretedTurn.routeFamily === 'help'
          ? 'handled Messages direct turn as a bounded help reply'
          : 'handled Messages direct turn as a fluid bounded chat reply',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    logger.info(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        requestRoute: requestPolicy.route,
        interpretedRouteFamily: interpretedTurn.routeFamily,
        interpretedSource: interpretedTurn.source || 'fallback',
      },
      'Handled BlueBubbles direct assistant turn via Messages fluid reply path',
    );
    return true;
  };

  if (await tryHandleLocalCalendarAutomation()) {
    return true;
  }

  if (await tryHandleLocalGoogleCalendarFollowThrough()) {
    return true;
  }

  if (await tryHandleLocalGoogleCalendarCreate()) {
    return true;
  }

  const hasPendingActionLayerContinuation = Boolean(
    getPendingActionReminderState(chatJid) ||
    getPendingActionDraftState(chatJid),
  );
  const freshProtectedActionLayerIntent =
    requestPolicy.route === 'protected_assistant'
      ? planActionLayerIntent(lastContent)
      : null;
  const shouldPreferProtectedReminderCapture =
    freshProtectedActionLayerIntent?.kind === 'capture_reminder' &&
    Boolean(freshProtectedActionLayerIntent.explicitTopic);

  if (hasPendingActionLayerContinuation) {
    if (
      await tryHandleLocalActionLayer(
        requestPolicy.route === 'direct_assistant' ? 'direct' : 'protected',
      )
    ) {
      return true;
    }
  }

  if (shouldPreferProtectedReminderCapture) {
    if (await tryHandleLocalActionLayer('protected')) {
      return true;
    }
  }

  if (requestPolicy.route === 'direct_assistant' && quickReply) {
    const quickReplyPilot = startConversationPilotProof(
      resolveOrdinaryChatPilotJourney(lastContent),
    );
    try {
      await sendAssistantReplyWithFeedback({
        text: quickReply,
        routeKey: 'direct_quick_reply',
        handlerKind: 'direct_quick_reply',
        responseSource: 'local_companion',
        traceReason: 'handled message via direct quick reply path',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      completeConversationPilotProof(quickReplyPilot, {
        outcome: 'success',
        blockerOwner: 'none',
        summaryText: quickReply,
      });
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          directAssistantProfile: 'minimal_read_only',
          promptKind: directAssistantPromptKind,
          freshSession: forceFreshDirectAssistantSession,
          rewriteApplied: directAssistantRewriteApplied,
          quickReply: true,
        },
        'Handled message via direct quick reply path',
      );
      return true;
    } catch (err) {
      completeConversationPilotProof(quickReplyPilot, {
        outcome: 'internal_failure',
        blockerClass: 'direct_quick_reply_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error ? err.message : 'direct quick reply send failed',
      });
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'Direct quick reply send failed, rolled back cursor for retry',
      );
      return false;
    }
  }

  if (
    requestPolicy.route === 'direct_assistant' ||
    requestPolicy.route === 'protected_assistant'
  ) {
    if (await tryHandleOutcomeReview()) {
      return true;
    }
    if (await tryHandleDelegationRules()) {
      return true;
    }
    if (await tryHandleMessageActionFollowup()) {
      return true;
    }
    if (await tryHandleExplicitBlueBubblesThreadSend()) {
      return true;
    }
    if (await tryHandleActionBundleFollowup()) {
      return true;
    }
    if (await tryHandleSharedAssistantCapability()) {
      return true;
    }
    if (await tryHandleSharedAssistantCompletion()) {
      return true;
    }
  }

  if (requestPolicy.route === 'direct_assistant') {
    if (await tryHandleBlueBubblesFluidDirectReply()) {
      return true;
    }
  }

  if (requestPolicy.route === 'direct_assistant') {
    if (await tryHandleLocalActionLayer('direct')) {
      return true;
    }

    if (await tryHandleLocalDailyCompanion('direct')) {
      return true;
    }

    if (await tryHandleLocalCalendarReply('direct')) {
      return true;
    }
  }

  if (requestPolicy.route === 'protected_assistant') {
    if (await tryHandleLocalActionLayer('protected')) {
      return true;
    }

    const plannedReminder = planSimpleReminder(
      lastContent,
      group.folder,
      chatJid,
    );
    if (plannedReminder) {
      try {
        createTask(plannedReminder.task);
        syncOutcomeFromReminderTask(plannedReminder.task, {
          linkedRefs: {
            reminderTaskId: plannedReminder.task.id,
            chatJid,
          },
          summaryText: plannedReminder.confirmation,
          now,
        });
        refreshTaskSnapshots(registeredGroups);
        clearSharedAssistantCapabilitySeed(chatJid);
        await sendAssistantReplyWithFeedback({
          text: plannedReminder.confirmation,
          routeKey: 'local_reminder',
          capabilityId: 'capture.reminder',
          handlerKind: 'local_reminder',
          responseSource: 'local_companion',
          traceReason: 'handled simple reminder via local planner',
          linkedRefs: {
            reminderTaskId: plannedReminder.task.id,
          },
        });
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            taskId: plannedReminder.task.id,
          },
          'Handled reminder via local protected fast path',
        );
        return true;
      } catch (err) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local protected reminder path failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    if (await tryHandleLocalDailyCompanion('protected')) {
      return true;
    }

    if (await tryHandleLocalCalendarReply('protected')) {
      return true;
    }
  }

  const lifeThreadTurn = handleLifeThreadCommand({
    groupFolder: group.folder,
    channel: conversationChannel,
    chatJid,
    text: missedMessages.at(-1)?.content ?? '',
    replyText: missedMessages.at(-1)?.reply_to?.content,
    conversationSummary: getDailyCompanionContext(chatJid, now)?.summaryText,
    priorContext: getDailyCompanionContext(chatJid, now),
    now,
  });
  if (lifeThreadTurn.handled) {
    try {
      clearSharedAssistantCapabilitySeed(chatJid);
      if (lifeThreadTurn.referencedThread) {
        setLastReferencedLifeThread(chatJid, lifeThreadTurn.referencedThread, now);
      }
      await sendAssistantReplyWithFeedback({
        text: lifeThreadTurn.responseText || 'Okay.',
        routeKey: 'life_thread_local',
        capabilityId: 'life_thread.local',
        handlerKind: 'life_thread_local',
        responseSource: 'local_companion',
        traceReason: 'handled life thread request via local assistant fast path',
        linkedRefs: lifeThreadTurn.referencedThread
          ? {
              lifeThreadId: lifeThreadTurn.referencedThread.id,
            }
          : {},
      });
      logger.info(
        { group: group.name },
        'Handled life thread request via local assistant fast path',
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'Life thread fast path failed, rolled back cursor for retry',
      );
      return false;
    }
  }

  const personalizationTurn = handlePersonalizationCommand({
    groupFolder: group.folder,
    channel: conversationChannel,
    text: missedMessages.at(-1)?.content ?? '',
    replyText: missedMessages.at(-1)?.reply_to?.content,
  });
  if (personalizationTurn.handled) {
    try {
      await sendAssistantReplyWithFeedback({
        text: personalizationTurn.responseText || 'Okay.',
        routeKey: 'personalization_local',
        capabilityId: 'personalization.local',
        handlerKind: 'personalization_local',
        responseSource: 'local_companion',
        traceReason:
          'handled personalization request via local assistant fast path',
      });
      logger.info(
        { group: group.name },
        'Handled personalization request via local assistant fast path',
      );
      return true;
    } catch (err) {
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'Personalization fast path failed, rolled back cursor for retry',
      );
      return false;
    }
  }

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const configuredTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
  const effectiveIdleTimeout = resolveEffectiveIdleTimeout(
    IDLE_TIMEOUT,
    configuredTimeout,
  );

  if (effectiveIdleTimeout !== IDLE_TIMEOUT) {
    logger.debug(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        configuredTimeout,
        requestedIdleTimeout: IDLE_TIMEOUT,
        effectiveIdleTimeout,
      },
      'Clamped idle timeout to preserve graceful container shutdown window',
    );
  }

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
        },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, effectiveIdleTimeout);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  const handleAgentOutput = async (result: ContainerOutput) => {
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          outputChars: raw.length,
          requestRoute: requestPolicy.route,
        },
        'Agent output chunk received',
      );
      if (text) {
        await sendAssistantReplyWithFeedback({
          text,
          routeKey: requestPolicy.route,
          handlerKind:
            requestPolicy.route === 'direct_assistant'
              ? 'container_direct_assistant'
              : 'container_assistant',
          responseSource: 'container_agent',
          traceReason:
            requestPolicy.route === 'direct_assistant'
              ? 'handled request through the direct assistant container lane'
              : 'handled request through the assistant container lane',
        });
        outputSentToUser = true;
        if (requestPolicy.route === 'direct_assistant') {
          lastDirectAssistantTextByChatJid[chatJid] = text;
        }
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      if (requestPolicy.route === 'direct_assistant') {
        queue.closeStdin(chatJid);
      } else {
        queue.notifyIdle(chatJid);
      }
    }

    if (result.status === 'error') {
      hadError = true;
    }
  };

  const executeAgentPrompt = async (
    promptText: string,
    freshSession: boolean,
  ) => {
    hadError = false;
    return runAgent(
      group,
      promptText,
      chatJid,
      requestPolicy,
      effectiveIdleTimeout,
      freshSession,
      handleAgentOutput,
    );
  };

  let lastDirectAssistantAttemptPrompt = prompt;
  let output = await executeAgentPrompt(
    prompt,
    forceFreshDirectAssistantSession,
  );

  if (
    !outputSentToUser &&
    requestPolicy.route === 'direct_assistant' &&
    directAssistantRewriteApplied &&
    directAssistantFallbackPromptText &&
    (output.status === 'error' || hadError) &&
    !output.nonRetriable
  ) {
    const fallbackPrompt = formatMessages(
      [
        {
          ...promptMessages[0],
          content: directAssistantFallbackPromptText,
        },
      ],
      TIMEZONE,
    );
    logger.warn(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        code: output.code,
        directAssistantProfile: 'minimal_read_only',
        promptKind: directAssistantPromptKind,
        freshSession: true,
        rewriteApplied: true,
        recoveryAttempted: output.recoveryAttempted,
      },
      'Retrying rewritten direct assistant continuation with alternate prompt',
    );
    output = await executeAgentPrompt(fallbackPrompt, true);
    lastDirectAssistantAttemptPrompt = fallbackPrompt;
  }

  if (
    !outputSentToUser &&
    requestPolicy.route === 'direct_assistant' &&
    (output.status === 'error' || hadError) &&
    !output.nonRetriable
  ) {
    logger.warn(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        code: output.code,
        directAssistantProfile: 'minimal_read_only',
        promptKind: directAssistantPromptKind,
        freshSession: true,
        rewriteApplied: directAssistantRewriteApplied,
        recoveryAttempted: output.recoveryAttempted,
      },
      'Retrying direct assistant request in a fresh outer container after terminal runtime failure',
    );
    output = await executeAgentPrompt(lastDirectAssistantAttemptPrompt, true);
  }

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
        },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }

    if (output.status === 'error' && output.nonRetriable) {
      const now = Date.now();
      const previousNotice = lastNonRetriableErrorNotice[chatJid];
      const shouldNotify =
        !previousNotice ||
        previousNotice.code !== output.code ||
        now - previousNotice.at >= NON_RETRIABLE_ERROR_NOTIFY_COOLDOWN_MS;
      const safeCompanionSurface =
        requestPolicy.route === 'direct_assistant' ||
        requestPolicy.route === 'protected_assistant';

      if (safeCompanionSurface) {
        await sendAssistantReplyWithFeedback({
          text: buildSilentSuccessFallback(
            requestPolicy.route,
            missedMessages,
            conversationChannel,
          ),
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_fallback',
          responseSource: 'local_companion',
          traceReason:
            'used a safe local fallback after a non-retriable agent/runtime problem',
        });
      } else if (shouldNotify && output.userMessage) {
        await sendAssistantReplyWithFeedback({
          text: output.userMessage,
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_runtime_failure',
          responseSource: 'local_companion',
          traceReason:
            'reported a non-retriable agent/runtime issue back to the user',
        });
      } else if (!shouldNotify) {
        await sendAssistantReplyWithFeedback({
          text: buildRepeatedAgentErrorMessage(output.code),
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_runtime_failure',
          responseSource: 'local_companion',
          traceReason: 'reported a repeated non-retriable agent/runtime issue',
        });
      }

      lastNonRetriableErrorNotice[chatJid] = {
        code: output.code,
        at: now,
      };

      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          code: output.code,
          notified: shouldNotify,
          directAssistantProfile:
            requestPolicy.route === 'direct_assistant'
              ? 'minimal_read_only'
              : null,
          promptKind: directAssistantPromptKind,
          freshSession:
            requestPolicy.route === 'direct_assistant'
              ? forceFreshDirectAssistantSession
              : null,
          rewriteApplied:
            requestPolicy.route === 'direct_assistant'
              ? directAssistantRewriteApplied
              : null,
          quickReply:
            requestPolicy.route === 'direct_assistant'
              ? Boolean(quickReply)
              : null,
        },
        'Non-retriable agent error detected, skipping retry loop',
      );

      return true;
    }

    if (
      output.status === 'error' &&
      requestPolicy.route === 'direct_assistant'
    ) {
      await sendAssistantReplyWithFeedback({
        text: buildDirectAssistantRuntimeFailureReply(
          missedMessages,
          output.userMessage,
          now,
          conversationChannel,
        ),
        routeKey: 'direct_assistant',
        handlerKind: 'assistant_runtime_failure',
        responseSource: 'local_companion',
        traceReason:
          'used the direct-assistant runtime failure fallback after retries failed',
      });
      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          code: output.code,
          directAssistantProfile: 'minimal_read_only',
          promptKind: directAssistantPromptKind,
          freshSession: forceFreshDirectAssistantSession,
          rewriteApplied: directAssistantRewriteApplied,
          quickReply: Boolean(quickReply),
          recoveryAttempted: output.recoveryAttempted,
        },
        'Shielded direct assistant runtime failure with local reply',
      );
      return true;
    }

    if (hasPendingActionLayerContinuation) {
      if (await tryHandleLocalActionLayer('protected')) {
        return true;
      }
    }

    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
      },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  if (!outputSentToUser) {
    const fallbackReply = buildSilentSuccessFallback(
      requestPolicy.route,
      missedMessages,
      conversationChannel,
    );
    await channel.sendMessage(chatJid, fallbackReply);
    logger.warn(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        route: requestPolicy.route,
      },
      'Recovered blank agent success with user-facing fallback',
    );
  }

  const proactiveCandidate = maybeCreateProactiveProfileCandidate({
    groupFolder: group.folder,
    chatJid,
    channel: conversationChannel,
    text: missedMessages.at(-1)?.content ?? '',
  });
  if (proactiveCandidate) {
    try {
      await channel.sendMessage(chatJid, proactiveCandidate.askText);
    } catch (err) {
      logger.warn(
        { group: group.name, err },
        'Failed to send proactive personalization ask',
      );
    }
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  requestPolicy: ReturnType<typeof classifyAssistantRequest>,
  idleTimeoutMs: number,
  forceFreshSession = false,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<{
  status: 'success' | 'error';
  code:
    | 'insufficient_quota'
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'initial_output_timeout'
    | 'runtime_bootstrap_failed'
    | 'container_runtime_unavailable'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  nonRetriable: boolean;
  userMessage: string | null;
  recoveryAttempted: boolean;
}> {
  const isMain = group.isMain === true;
  const sessionStorageKey = getAssistantSessionStorageKey(
    group.folder,
    requestPolicy.route,
  );
  const runtimeRoute = classifyRuntimeRoute(requestPolicy, prompt);
  const existingThread =
    agentThreads[group.folder] || getAgentThread(group.folder);
  if (existingThread) {
    agentThreads[group.folder] = existingThread;
  }
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const persistedSessionId =
    requestPolicy.route === 'direct_assistant'
      ? sessions[sessionStorageKey]
      : sessions[group.folder];
  const sessionId = forceFreshSession
    ? undefined
    : shouldReuseExistingThread(existingThread, preferredRuntime)
      ? existingThread.thread_id
      : persistedSessionId;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );
  writeOpenClawSkillsSnapshot(
    group.folder,
    isMain,
    getEnabledOpenClawSkillsSnapshot(),
  );
  writeCursorAgentsSnapshot(group.folder, isMain, getCursorAgentsSnapshot());

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  let staleSessionOutputDetected = false;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        const streamedText =
          typeof output.result === 'string' ? output.result : null;
        if (isDeadAssistantSessionErrorText(streamedText)) {
          staleSessionOutputDetected = true;
          return;
        }
        if (output.newSessionId) {
          sessions[sessionStorageKey] = output.newSessionId;
          setSession(sessionStorageKey, output.newSessionId);
          persistAgentThread(
            group.folder,
            output.newSessionId,
            output.runtime || preferredRuntime,
          );
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        freshSessionHome:
          requestPolicy.route === 'direct_assistant' && forceFreshSession,
        preferredRuntime,
        fallbackRuntime: AGENT_RUNTIME_FALLBACK,
        runtimeRoute,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        requestPolicy,
        idleTimeoutMs,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    const staleSessionDetected =
      staleSessionOutputDetected ||
      isDeadAssistantSessionErrorText(output.error) ||
      isDeadAssistantSessionErrorText(
        typeof output.result === 'string' ? output.result : null,
      );

    if (staleSessionDetected) {
      if (!forceFreshSession) {
        logger.warn(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            route: requestPolicy.route,
            sessionId,
          },
          'Assistant detected stale session state, clearing stored conversation and retrying once',
        );
        clearPersistedAssistantSessionState(group.folder, sessionStorageKey);
        const recovered = await runAgent(
          group,
          prompt,
          chatJid,
          requestPolicy,
          idleTimeoutMs,
          true,
          onOutput,
        );
        return {
          ...recovered,
          recoveryAttempted: true,
        };
      }

      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          route: requestPolicy.route,
        },
        'Assistant stale session retry was already attempted and still failed',
      );
      return {
        status: 'error',
        code: 'transient_or_unknown',
        nonRetriable: false,
        userMessage: null,
        recoveryAttempted: true,
      };
    }

    if (output.newSessionId) {
      sessions[sessionStorageKey] = output.newSessionId;
      setSession(sessionStorageKey, output.newSessionId);
      persistAgentThread(
        group.folder,
        output.newSessionId,
        output.runtime || preferredRuntime,
      );
    }

    if (output.status === 'error') {
      const analysis = analyzeAgentError(output);
      logger.error(
        {
          group: group.name,
          error: output.error,
          failureKind: output.failureKind,
          failureStage: output.failureStage,
          diagnosticHint: output.diagnosticHint,
          logFile: output.logFile,
          recoveryAttempted: output.recoveryAttempted,
          sawLifecycleOnlyOutput: output.sawLifecycleOnlyOutput,
          firstResultSubtype: output.firstResultSubtype,
          code: analysis.code,
          nonRetriable: analysis.nonRetriable,
        },
        'Container agent error',
      );
      return {
        status: 'error',
        code: analysis.code,
        nonRetriable: analysis.nonRetriable,
        userMessage: analysis.userMessage,
        recoveryAttempted: output.recoveryAttempted === true,
      };
    }

    return {
      status: 'success',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
      recoveryAttempted: output.recoveryAttempted === true,
    };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      code: 'transient_or_unknown',
      nonRetriable: false,
      userMessage: null,
      recoveryAttempted: false,
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = listProcessableCompanionChatJids();
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = resolveCompanionBinding(chatJid)?.group;
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                triggerPattern.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const sessionState = getMainChatSessionState(chatJid);
          const localQuickReply =
            groupMessages.length === 1
              ? maybeBuildDirectQuickReply(groupMessages)
              : null;
          const mainChatRoutingDecision = decideMainChatRouting({
            isMainGroup,
            messages: groupMessages,
            sessionState,
            localQuickReply,
          });

          if (mainChatRoutingDecision.kind === 'reply_locally') {
            try {
              await channel.sendMessage(
                chatJid,
                mainChatRoutingDecision.replyText,
              );
              lastAgentTimestamp[chatJid] =
                groupMessages[groupMessages.length - 1].timestamp;
              saveState();
              logger.info(
                { chatJid, sessionState },
                'Handled standalone main-chat message locally while work session stayed intact',
              );
            } catch (err) {
              logger.warn(
                { chatJid, err },
                'Local main-chat reply failed, deferring to standard processing',
              );
              queue.enqueueMessageCheck(chatJid);
              if (sessionState === 'idle_assistant') {
                queue.closeStdin(chatJid);
              }
            }
            continue;
          }

          if (mainChatRoutingDecision.kind === 'process_fresh_turn_now') {
            queue.enqueueMessageCheck(chatJid);
            if (sessionState === 'idle_assistant') {
              queue.closeStdin(chatJid);
            }
            logger.debug(
              { chatJid, sessionState },
              'Queued standalone main-chat turn for fresh processing',
            );
            continue;
          }

          if (mainChatRoutingDecision.kind === 'queue_fresh_turn_after_work') {
            queue.enqueueMessageCheck(chatJid);
            logger.debug(
              { chatJid, sessionState },
              'Queued standalone main-chat turn behind active work',
            );
            continue;
          }

          const formatted = buildAssistantPromptWithPersonalization(
            formatMessages(messagesToSend, TIMEZONE),
            {
              channel: channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram',
              groupFolder: group.folder,
            },
          );

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const chatJid of listProcessableCompanionChatJids()) {
    const group = resolveCompanionBinding(chatJid)?.group;
    if (!group) continue;
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function resolveAppVersion(): string {
  try {
    const raw = fs.readFileSync(
      path.join(process.cwd(), 'package.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const appVersion = resolveAppVersion();
  const channelHealthByName = new Map<string, ChannelHealthSnapshot>();
  let assistantHealthInterval: ReturnType<typeof setInterval> | null = null;
  const writeCurrentAssistantHealth = () => {
    try {
      writeAssistantHealthState({
        appVersion,
        channelHealth: [...channelHealthByName.values()],
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to persist assistant health marker');
    }
  };
  const stopAssistantHealthLoop = () => {
    if (assistantHealthInterval) {
      clearInterval(assistantHealthInterval);
      assistantHealthInterval = null;
    }
    clearAssistantHealthState();
    clearTelegramTransportState();
  };

  clearAssistantHealthState();
  clearAssistantReadyState();
  clearTelegramTransportState();
  ensureContainerSystemRunning();
  initDatabase();
  loadLogControlFromPersistence();
  startLogControlAutoRefresh();
  logger.info({ component: 'assistant' }, 'Database initialized');
  loadState();
  reconcileRegisteredMainChatState();

  try {
    seedConfiguredAlexaLinkedAccount();
  } catch (err) {
    logger.error({ err }, 'Alexa linked-account seed failed');
  }

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  let alexaRuntime: AlexaRuntime | null = null;

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopAssistantHealthLoop();
    clearAssistantReadyState();
    await queue.shutdown(10000);
    if (alexaRuntime) {
      await alexaRuntime
        .close()
        .catch((err) =>
          logger.warn({ err }, 'Alexa voice ingress shutdown failed'),
        );
    }
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('exit', () => {
    stopAssistantHealthLoop();
    clearAssistantReadyState();
  });

  const CURSOR_STATUS_COMMANDS = new Set(['/cursor-status', '/cursor_status']);
  const CURSOR_CREATE_USAGE =
    'Usage: /cursor-create [--model MODEL_ID] [--repo REPO_URL] [--ref GIT_REF] [--pr PR_URL] [--branch BRANCH_NAME] [--auto-pr] [--cursor-github-app] [--skip-reviewer] PROMPT';
  const CURSOR_DOWNLOAD_USAGE =
    'Usage: /cursor-download [AGENT_ID|LIST_NUMBER|current] ABSOLUTE_PATH';
  const CURSOR_ARTIFACT_LINK_USAGE =
    'Usage: /cursor-artifact-link AGENT_ID ABSOLUTE_PATH';
  const RUNTIME_CREATE_USAGE = 'Usage: /runtime-create TEXT';
  const RUNTIME_JOBS_USAGE = 'Usage: /runtime-jobs [LIMIT] [BEFORE_JOB_ID]';
  const RUNTIME_JOB_USAGE = 'Usage: /runtime-job [JOB_ID]';
  const RUNTIME_FOLLOWUP_USAGE = 'Usage: /runtime-followup JOB_ID TEXT';
  const RUNTIME_STOP_USAGE = 'Usage: /runtime-stop [JOB_ID]';
  const RUNTIME_LOGS_USAGE = 'Usage: /runtime-logs [JOB_ID] [LINES]';
  const CURSOR_TERMINAL_USAGE =
    'Usage: /cursor-terminal [AGENT_ID|LIST_NUMBER|current] COMMAND';
  const CURSOR_TERMINAL_STATUS_USAGE =
    'Usage: /cursor-terminal-status [AGENT_ID|LIST_NUMBER|current]';
  const CURSOR_TERMINAL_LOG_USAGE =
    'Usage: /cursor-terminal-log [AGENT_ID|LIST_NUMBER|current] [LIMIT]';
  const CURSOR_TERMINAL_STOP_USAGE =
    'Usage: /cursor-terminal-stop [AGENT_ID|LIST_NUMBER|current]';
  const MAX_CURSOR_TERMINAL_REPLY_CHARS = 3000;
  const MAX_CURSOR_TERMINAL_LINES = 40;

  function formatCursorTerminalStatusMessage(
    agentId: string,
    terminal: {
      status: string;
      cwd: string | null;
      shell: string | null;
      lastCommand: string | null;
      lastExitCode: number | null;
      activePid: number | null;
      outputLineCount: number;
      lastStartedAt: string | null;
      lastFinishedAt: string | null;
    },
  ): string {
    const lines = [
      `Desktop bridge terminal for ${agentId}:`,
      `- Status: ${terminal.status}`,
      `- CWD: ${terminal.cwd || 'unknown'}`,
      `- Shell: ${terminal.shell || 'unknown'}`,
      `- Last exit: ${terminal.lastExitCode ?? 'unknown'}`,
      `- Active PID: ${terminal.activePid ?? 'none'}`,
      `- Output lines cached: ${terminal.outputLineCount}`,
    ];

    if (terminal.lastCommand) {
      lines.push(`- Last command: ${terminal.lastCommand}`);
    }
    if (terminal.lastStartedAt) {
      lines.push(`- Last started: ${terminal.lastStartedAt}`);
    }
    if (terminal.lastFinishedAt) {
      lines.push(`- Last finished: ${terminal.lastFinishedAt}`);
    }

    return lines.join('\n');
  }

  function formatCursorTerminalOutputSection(
    output: Array<{
      stream: string;
      text: string;
    }>,
  ): string {
    if (output.length === 0) {
      return 'No terminal output captured yet.';
    }

    const clippedLines = output
      .slice(-MAX_CURSOR_TERMINAL_LINES)
      .map((line) => `[${line.stream}] ${line.text}`);
    let joined = clippedLines.join('\n');
    if (joined.length > MAX_CURSOR_TERMINAL_REPLY_CHARS) {
      joined = `...${joined.slice(-(MAX_CURSOR_TERMINAL_REPLY_CHARS - 3))}`;
    }
    return joined;
  }

  function labelCursorRecord(
    record:
      | {
          provider?: 'cloud' | 'desktop';
          id: string;
        }
      | string,
  ): string {
    const provider =
      typeof record === 'string'
        ? /^desk_/i.test(record)
          ? 'desktop'
          : /^bc[-_]/i.test(record)
            ? 'cloud'
            : null
        : record.provider ||
          (/^desk_/i.test(record.id)
            ? 'desktop'
            : /^bc[-_]/i.test(record.id)
              ? 'cloud'
              : null);

    if (provider === 'desktop') return 'desktop bridge session';
    if (provider === 'cloud') return 'Cursor Cloud task';
    return 'Cursor task';
  }

  function isDesktopCursorRecord(
    record:
      | {
          provider?: 'cloud' | 'desktop';
          id: string;
        }
      | string,
  ): boolean {
    if (typeof record !== 'string' && record.provider) {
      return record.provider === 'desktop';
    }
    const id = typeof record === 'string' ? record : record.id;
    return /^desk_/i.test(id);
  }

  function maybeClearCursorSelectionForCommandError(params: {
    chatJid: string;
    threadId?: string;
    target: ResolvedCursorTarget;
    err: unknown;
  }): boolean {
    if (
      params.target.via !== 'current' &&
      params.target.via !== 'selected'
    ) {
      return false;
    }
    if (!shouldClearCursorSelectionForError(params.err)) {
      return false;
    }
    clearCurrentWorkSelection({
      chatJid: params.chatJid,
      threadId: params.threadId,
      laneId: 'cursor',
      source: 'shared',
    });
    return true;
  }

  function formatCursorCommandFailure(params: {
    prefix: string;
    err: unknown;
    clearedSelection?: boolean;
  }): string {
    const base = formatCursorOperationFailure(params.prefix, params.err);
    if (!params.clearedSelection) {
      return base;
    }
    return [
      base,
      '',
      "Andrea cleared this chat's stale current Cursor selection. Open `/cursor` -> `Current Work` or `Jobs` to pick a fresh task.",
    ].join('\n');
  }

  function buildCursorTaskContextPayload(params: {
    agentId: string;
    provider: 'cloud' | 'desktop';
    contextType: TaskContextType;
    status?: string | null;
    summary?: string | null;
    outputPreview?: string | null;
    outputSource?: string | null;
  }): Record<string, unknown> | null {
    return mergeTaskMessageContextPayload(
      { provider: params.provider },
      {
        taskContextType: params.contextType,
        taskTitle: `${labelCursorRecord({
          provider: params.provider,
          id: params.agentId,
        })} ${formatOpaqueTaskId(params.agentId)}`,
        taskStatus: params.status || null,
        taskSummary: summarizeVisibleTaskText(params.summary),
        outputPreview: summarizeVisibleTaskText(params.outputPreview),
        outputSource: params.outputSource || null,
      },
    );
  }

  function toCursorHandle(jobId: string): BackendJobHandle {
    return { laneId: 'cursor', jobId };
  }

  function getOperatorReplyToMessageId(
    message: NewMessage | undefined,
  ): string | undefined {
    if (!message) return undefined;
    if (message.reply_to_id) return message.reply_to_id;
    return /^\d+$/.test(message.id) ? message.id : undefined;
  }

  function buildOperatorSendOptions(
    message?: NewMessage,
    extra: Partial<SendMessageOptions> = {},
  ): SendMessageOptions {
    const replyToMessageId =
      extra.replyToMessageId || getOperatorReplyToMessageId(message);

    return {
      ...(message?.thread_id ? { threadId: message.thread_id } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      ...extra,
    };
  }

  async function sendCursorMessage(
    chatJid: string,
    text: string,
    message?: NewMessage,
    extra: Partial<SendMessageOptions> = {},
  ): Promise<string | undefined> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return undefined;
    const sent = await channel.sendMessage(
      chatJid,
      text,
      buildOperatorSendOptions(message, extra),
    );
    return sent.platformMessageId;
  }

  function buildDebugUpdatedBy(chatJid: string, message?: NewMessage): string {
    if (message?.sender) {
      return `telegram:${message.sender}`;
    }
    return `telegram:${chatJid}`;
  }

  function getActiveRuntimeSnapshot(chatJid: string) {
    return queue
      .getRuntimeJobs()
      .find((job) => job.groupJid === chatJid && job.active);
  }

  function buildCursorStatusInlineActions(
    chatJid: string,
  ): SendMessageOptions['inlineActions'] {
    const actions: NonNullable<SendMessageOptions['inlineActions']> = [
      { label: 'Refresh', actionId: '/cursor_status' },
    ];
    if (registeredGroups[chatJid]?.isMain) {
      actions.push({ label: 'Open /cursor', actionId: '/cursor' });
    }
    return actions;
  }

  function buildDebugStatusPanelText(): string {
    return formatWorkPanel({
      title: '*Debug Status*',
      sections: [stripLeadingMarkdownTitle(formatDebugStatus())],
    });
  }

  function buildResponseFeedbackBlockerClass(
    classification: ResponseFeedbackRecord['classification'],
  ): string {
    switch (classification) {
      case 'repo_side_broken':
        return 'response_feedback_repo_side_broken';
      case 'repo_side_rough_edge':
        return 'response_feedback_repo_side_rough_edge';
      case 'manual_sync_only':
        return 'response_feedback_manual_sync_only';
      case 'externally_blocked':
      default:
        return 'response_feedback_externally_blocked';
    }
  }

  function summarizeResponseFeedbackText(
    text: string | null | undefined,
    fallback: string,
    maxLength = 96,
  ): string {
    const normalized = (text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return fallback;
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
  }

  function buildResponseFeedbackIssueSummary(
    record: Pick<ResponseFeedbackRecord, 'originalUserText' | 'classification'>,
  ): string {
    const askExcerpt = summarizeResponseFeedbackText(
      record.originalUserText,
      'a recent ask',
      88,
    );
    switch (record.classification) {
      case 'repo_side_broken':
        return `User downvoted Andrea reply to "${askExcerpt}" because the flow looked broken.`;
      case 'externally_blocked':
        return `User downvoted Andrea reply to "${askExcerpt}" because the blocker surfaced poorly.`;
      case 'manual_sync_only':
        return `User downvoted Andrea reply to "${askExcerpt}" because a manual sync step surfaced in the answer.`;
      case 'repo_side_rough_edge':
      default:
        return `User downvoted Andrea reply to "${askExcerpt}".`;
    }
  }

  function buildResponseFeedbackHostTruthLines(): string[] {
    const truth = buildFieldTrialOperatorTruth();
    const summarize = (label: string, detail: string, proof: string) =>
      `${label}: ${proof}${detail ? ` (${detail})` : ''}`;
    return [
      summarize(
        'Telegram',
        truth.telegram.blocker || truth.telegram.detail,
        truth.telegram.proofState,
      ),
      summarize(
        'BlueBubbles',
        truth.bluebubbles.blocker || truth.bluebubbles.detail,
        truth.bluebubbles.proofState,
      ),
      summarize(
        'Google Calendar',
        truth.googleCalendar.blocker || truth.googleCalendar.detail,
        truth.googleCalendar.proofState,
      ),
      summarize(
        'Alexa',
        truth.alexa.blocker ||
          `${truth.alexa.proofState}; model_sync=${truth.launchReadiness.manualSurfaceSyncs.alexa.syncStatus}`,
        truth.alexa.proofState,
      ),
      summarize(
        'Research',
        truth.research.blocker || truth.research.detail,
        truth.research.proofState,
      ),
      summarize(
        'Image generation',
        truth.imageGeneration.blocker || truth.imageGeneration.detail,
        truth.imageGeneration.proofState,
      ),
      summarize(
        'Work cockpit',
        truth.workCockpit.blocker || truth.workCockpit.detail,
        truth.workCockpit.proofState,
      ),
    ];
  }

  function runGitCommand(args: string[]): string {
    try {
      return execFileSync('git', ['-C', ACTIVE_REPO_ROOT, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch (err) {
      const stderr =
        err &&
        typeof err === 'object' &&
        'stderr' in err &&
        typeof (err as { stderr?: unknown }).stderr === 'string'
          ? (err as { stderr: string }).stderr.trim()
          : '';
      const stdout =
        err &&
        typeof err === 'object' &&
        'stdout' in err &&
        typeof (err as { stdout?: unknown }).stdout === 'string'
          ? (err as { stdout: string }).stdout.trim()
          : '';
      throw new Error(
        stderr || stdout || `git ${args.join(' ')} failed in ${ACTIVE_REPO_ROOT}.`,
      );
    }
  }

  function syncResponseFeedbackFromTaskStatus(
    laneId: NonNullable<ResponseFeedbackRecord['remediationLaneId']>,
    jobId: string,
    taskStatus: string | null | undefined,
  ): ResponseFeedbackRecord | null {
    const record = getResponseFeedbackByRemediationJob({ laneId, jobId });
    if (!record) return null;

    if (
      isSuccessfulResponseFeedbackTaskStatus(taskStatus) &&
      record.status !== 'resolved_locally' &&
      record.status !== 'landed'
    ) {
      return updateResponseFeedback(record.feedbackId, {
        status: 'resolved_locally',
        operatorNote:
          'The remediation task completed locally and is waiting for explicit landing approval.',
      });
    }

    if (
      isFailedResponseFeedbackTaskStatus(taskStatus) &&
      record.status === 'running'
    ) {
      return updateResponseFeedback(record.feedbackId, {
        status: 'awaiting_confirmation',
        operatorNote:
          "The remediation task finished without a clean local hotfix, so it's back in review.",
      });
    }

    return record;
  }

  function buildResponseFeedbackTaskSendOptions(params: {
    laneId: 'cursor' | 'andrea_runtime';
    jobId: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
    inlineActionRows?: SendMessageOptions['inlineActionRows'];
    jobStatus?: string | null;
  }): Pick<SendMessageOptions, 'inlineActions' | 'inlineActionRows'> & {
    payload: Record<string, unknown> | null;
  } {
    const payloadStatus =
      params.payload && typeof params.payload.taskStatus === 'string'
        ? params.payload.taskStatus
        : null;
    const taskStatus = params.jobStatus || payloadStatus;
    const record = syncResponseFeedbackFromTaskStatus(
      params.laneId,
      params.jobId,
      taskStatus,
    );
    if (!record) {
      return {
        payload: params.payload || null,
        inlineActions: params.inlineActions,
        inlineActionRows: params.inlineActionRows,
      };
    }

    return {
      payload: mergeTaskMessageContextPayload(
        (params.payload || null) as Record<string, unknown> | null,
        {
          responseFeedbackId: record.feedbackId,
          taskStatus: taskStatus || null,
        },
      ),
      inlineActions: undefined,
      inlineActionRows: appendResponseFeedbackActionRows({
        record,
        inlineActions: params.inlineActions,
        inlineActionRows: params.inlineActionRows,
      }),
    };
  }

  function buildResponseFeedbackLandingCommitMessage(
    record: ResponseFeedbackRecord,
  ): string {
    const clippedAsk = summarizeResponseFeedbackText(
      record.originalUserText,
      'response feedback hotfix',
      44,
    )
      .replace(/[`"]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return clippedAsk
      ? `Land local hotfix for ${clippedAsk}`
      : `Land local hotfix for response feedback ${record.feedbackId.slice(0, 8)}`;
  }

  function landResponseFeedbackHotfix(
    record: ResponseFeedbackRecord,
    mode: 'commit_only' | 'commit_push',
  ): {
    branch: string;
    commitSha: string;
    commitMessage: string;
    dirtyPaths: string[];
    pushedAt: string | null;
  } {
    const dirtyAtStart = record.linkedRefs.repoDirtyPathsAtStart || [];
    if (dirtyAtStart.length > 0) {
      throw new Error(
        `This repo was already dirty before the remediation started (${dirtyAtStart.join(', ')}), so I am keeping the hotfix local instead of auto-committing from Telegram.`,
      );
    }

    const dirtyPaths = listCurrentGitDirtyPaths();
    if (dirtyPaths.length === 0) {
      throw new Error(
        'I do not see any local changes to land from this host right now.',
      );
    }

    runGitCommand(['add', '--all', '--', ...dirtyPaths]);
    const commitMessage = buildResponseFeedbackLandingCommitMessage(record);
    runGitCommand(['commit', '-m', commitMessage]);
    const branch = readGitRef(['rev-parse', '--abbrev-ref', 'HEAD']);
    const commitSha = readGitRef(['rev-parse', 'HEAD']);
    let pushedAt: string | null = null;

    if (mode === 'commit_push') {
      if (!branch || branch === 'unknown') {
        throw new Error(
          'I committed the local hotfix, but I could not determine the current git branch for a safe push.',
        );
      }
      runGitCommand(['push', 'origin', branch]);
      pushedAt = new Date().toISOString();
    }

    return {
      branch,
      commitSha,
      commitMessage,
      dirtyPaths,
      pushedAt,
    };
  }

  async function handleResponseFeedbackAction(
    chatJid: string,
    msg: NewMessage,
    action: NonNullable<ReturnType<typeof parseResponseFeedbackAction>>,
  ): Promise<boolean> {
    const channel = findChannel(channels, chatJid);
    const group = registeredGroups[chatJid];
    if (!channel || !group || !isMainControlChat(group)) {
      return true;
    }

    const existing = getResponseFeedback(action.feedbackId);
    if (!existing || existing.chatJid !== chatJid) {
      await channel.sendMessage(
        chatJid,
        'That feedback card is no longer available here.',
        buildOperatorSendOptions(msg),
      );
      return true;
    }

    const linkedRefs: ResponseFeedbackRecord['linkedRefs'] = {
      ...(existing.linkedRefs || {}),
      responseFeedbackId: existing.feedbackId,
      platformMessageId:
        existing.linkedRefs?.platformMessageId ||
        existing.platformMessageId ||
        undefined,
      userMessageId:
        existing.linkedRefs?.userMessageId || existing.userMessageId || undefined,
    };

    const ensurePilotIssue = (): ResponseFeedbackRecord => {
      if (existing.issueId) {
        return updateResponseFeedback(existing.feedbackId, {
          linkedRefs,
        });
      }
      const captured = capturePilotIssue({
        channel: 'telegram',
        groupFolder: existing.groupFolder,
        chatJid: existing.chatJid,
        threadId: existing.threadId || null,
        utterance: 'not helpful',
        routeKey: existing.routeKey || 'response_feedback.capture',
        assistantContextSummary: existing.assistantReplyText,
        linkedRefs,
        issueKindOverride: 'downvoted_response',
        summaryTextOverride: buildResponseFeedbackIssueSummary(existing),
        blockerClassOverride: buildResponseFeedbackBlockerClass(
          existing.classification,
        ),
        blockerOwnerOverride: existing.blockerOwner,
      });
      return updateResponseFeedback(existing.feedbackId, {
        issueId: captured.record?.issueId || null,
        linkedRefs,
        status:
          existing.classification === 'externally_blocked'
            ? 'blocked_external'
            : existing.classification === 'manual_sync_only'
              ? 'manual_sync_only'
              : 'awaiting_confirmation',
      });
    };

    if (action.operation === 'capture') {
      const captured = ensurePilotIssue();
      await channel.sendMessage(
        chatJid,
        buildResponseFeedbackCaptureReply(
          captured,
          captured.operatorNote || 'I saved the issue for review.',
        ),
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(captured),
        }),
      );
      return true;
    }

    if (action.operation === 'why') {
      await channel.sendMessage(
        chatJid,
        buildResponseFeedbackWhyText(
          existing,
          existing.operatorNote || 'I saved the issue for review.',
        ),
        buildOperatorSendOptions(msg),
      );
      return true;
    }

    if (action.operation === 'keep_local') {
      const updated = updateResponseFeedback(existing.feedbackId, {
        linkedRefs,
        status: 'resolved_locally',
        operatorNote:
          'Operator chose to keep the validated hotfix local without a commit or push.',
      });
      await channel.sendMessage(
        chatJid,
        'Keeping it local. I am leaving the validated hotfix on this host without a commit or push.',
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(updated),
        }),
      );
      return true;
    }

    if (
      action.operation === 'commit_only' ||
      action.operation === 'commit_push'
    ) {
      if (existing.status !== 'resolved_locally' && existing.status !== 'landed') {
        await channel.sendMessage(
          chatJid,
          'That hotfix is not ready to land yet. Refresh the remediation task card after it completes locally, then use the landing buttons there.',
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(existing),
          }),
        );
        return true;
      }

      try {
        const landed = landResponseFeedbackHotfix(
          existing,
          action.operation === 'commit_push' ? 'commit_push' : 'commit_only',
        );
        const updated = updateResponseFeedback(existing.feedbackId, {
          linkedRefs: {
            ...linkedRefs,
            landingCommitSha: landed.commitSha,
            landingPushedAt: landed.pushedAt || undefined,
          },
          status: 'landed',
          operatorNote:
            action.operation === 'commit_push'
              ? `Committed and pushed ${landed.commitSha.slice(0, 7)} on ${landed.branch}.`
              : `Committed ${landed.commitSha.slice(0, 7)} locally on ${landed.branch}.`,
        });
        await channel.sendMessage(
          chatJid,
          [
            action.operation === 'commit_push'
              ? 'I landed that hotfix and pushed it.'
              : 'I committed that hotfix locally.',
            `Commit: ${landed.commitSha}`,
            `Branch: ${landed.branch}`,
            `Files: ${landed.dirtyPaths.join(', ')}`,
            action.operation === 'commit_push'
              ? 'Push target: origin/' + landed.branch
              : 'Push: not requested',
          ].join('\n'),
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(updated),
          }),
        );
      } catch (err) {
        const updated = updateResponseFeedback(existing.feedbackId, {
          linkedRefs,
          status: 'resolved_locally',
          operatorNote: err instanceof Error ? err.message : String(err),
        });
        await channel.sendMessage(
          chatJid,
          err instanceof Error ? err.message : String(err),
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(updated),
          }),
        );
      }
      return true;
    }

    if (action.operation === 'not_now') {
      const updated = updateResponseFeedback(existing.feedbackId, {
        linkedRefs,
        status:
          existing.classification === 'externally_blocked'
            ? 'blocked_external'
            : existing.classification === 'manual_sync_only'
              ? 'manual_sync_only'
              : 'captured',
      });
      await channel.sendMessage(
        chatJid,
        'Saved for later. I am not starting a fix right now.',
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(updated),
        }),
      );
      return true;
    }

    const captured = ensurePilotIssue();
    if (captured.status === 'running' && captured.remediationJobId) {
      await channel.sendMessage(
        chatJid,
        `A self-fix task is already running for this feedback item (${captured.remediationJobId}).`,
        buildOperatorSendOptions(msg),
      );
      return true;
    }

    if (
      captured.classification === 'externally_blocked' ||
      captured.classification === 'manual_sync_only'
    ) {
      const updated = updateResponseFeedback(captured.feedbackId, {
        linkedRefs,
        status:
          captured.classification === 'externally_blocked'
            ? 'blocked_external'
            : 'manual_sync_only',
      });
      await channel.sendMessage(
        chatJid,
        buildResponseFeedbackCaptureReply(
          updated,
          updated.operatorNote ||
            'This one should stay captured rather than auto-starting a repo fix.',
        ),
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(updated),
        }),
      );
      return true;
    }

    const runtimeStatus = await getAndreaOpenAiBackendStatus();
    const cursorCloudStatus = getCursorCloudStatus();
    const cursorDesktopStatus = await getCursorDesktopStatus({ probe: true });
    const laneSelection = selectResponseFeedbackLane({
      runtimeAvailable: runtimeStatus.state === 'available',
      runtimeLocalPreferred:
        runtimeStatus.state === 'available' &&
        runtimeStatus.meta?.localExecutionState === 'available_authenticated',
      runtimeCloudAllowed: runtimeStatus.state === 'available',
      runtimeDetail:
        runtimeStatus.meta?.localExecutionState === 'available_authenticated'
          ? 'Codex local is healthy and authenticated on this host.'
          : runtimeStatus.detail || runtimeStatus.meta?.operatorGuidance || null,
      cursorCloudAvailable:
        cursorCloudStatus.enabled && cursorCloudStatus.hasApiKey,
      cursorCloudDetail:
        cursorCloudStatus.enabled && cursorCloudStatus.hasApiKey
          ? 'Cursor Cloud is configured and ready for queued coding jobs.'
          : null,
      cursorDesktopAvailable:
        cursorDesktopStatus.enabled &&
        cursorDesktopStatus.hasToken &&
        cursorDesktopStatus.probeStatus === 'ok' &&
        cursorDesktopStatus.agentJobCompatibility === 'validated',
      cursorDesktopDetail:
        cursorDesktopStatus.agentJobDetail || cursorDesktopStatus.probeDetail,
    });

    if (!laneSelection.laneId) {
      const updated = updateResponseFeedback(captured.feedbackId, {
        linkedRefs,
        status: 'captured',
        remediationRuntimePreference: laneSelection.runtimePreference,
        operatorNote: laneSelection.reason,
      });
      await channel.sendMessage(
        chatJid,
        [
          'I saved that feedback, but I do not have a queued self-fix lane ready right now.',
          laneSelection.reason,
          'Use `Why` if you want the routing context, or try again after the runtime lane is healthy.',
        ].join('\n'),
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(updated),
        }),
      );
      return true;
    }

    const remediationPrompt = buildResponseFeedbackRemediationPrompt({
      record: captured,
      laneSelection,
      hostTruthLines: buildResponseFeedbackHostTruthLines(),
    });
    const linkedRefsWithRepoBaseline: ResponseFeedbackRecord['linkedRefs'] = {
      ...linkedRefs,
      repoHeadAtStart:
        existing.linkedRefs.repoHeadAtStart || readGitRef(['rev-parse', 'HEAD']),
      repoDirtyPathsAtStart:
        existing.linkedRefs.repoDirtyPathsAtStart || listCurrentGitDirtyPaths(),
    };

    if (laneSelection.laneId === 'andrea_runtime') {
      const created = await getAndreaRuntimeLane().createJob({
        groupFolder: captured.groupFolder,
        chatJid,
        promptText: remediationPrompt,
        requestedBy: msg.sender,
      });
      const updated = updateResponseFeedback(captured.feedbackId, {
        linkedRefs: {
          ...linkedRefsWithRepoBaseline,
          backendLaneId: 'andrea_runtime',
          backendJobId: created.handle.jobId,
        },
        status: 'running',
        remediationLaneId: 'andrea_runtime',
        remediationJobId: created.handle.jobId,
        remediationRuntimePreference: laneSelection.runtimePreference,
        remediationPrompt,
        operatorNote: laneSelection.reason,
      });
      await sendBackendJobMessage({
        chatJid,
        laneId: 'andrea_runtime',
        jobId: created.handle.jobId,
        sourceMessage: msg,
        contextKind: 'runtime_job_card',
        payload: mergeTaskMessageContextPayload(created.metadata, {
          taskContextType: 'job_card',
          taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(created.handle.jobId)}`,
          taskStatus: created.status,
          taskSummary: summarizeVisibleTaskText(created.summary),
          responseFeedbackId: updated.feedbackId,
        }),
        inlineActions: buildRuntimeJobInlineActions({
          job: created,
          contextKind: 'runtime_job_card',
          canExecute: andreaRuntimeExecutionEnabled,
        }),
        jobStatus: created.status,
        text: [
          'Andrea started a self-fix task for that downvoted reply.',
          formatRuntimeJobCard(created),
          formatRuntimeNextStep(created.handle.jobId),
          'If the hotfix validates locally, I will still ask before any commit or push.',
        ].join('\n\n'),
      });
      return true;
    }

    const created = await cursorBackendLane.createCursorJob({
      groupFolder: captured.groupFolder,
      chatJid,
      promptText: remediationPrompt,
      requestedBy: msg.sender,
    });
    const updated = updateResponseFeedback(captured.feedbackId, {
      linkedRefs: {
        ...linkedRefsWithRepoBaseline,
        backendLaneId: 'cursor',
        backendJobId: created.id,
      },
      status: 'running',
      remediationLaneId: 'cursor',
      remediationJobId: created.id,
      remediationRuntimePreference: laneSelection.runtimePreference,
      remediationPrompt,
      operatorNote: laneSelection.reason,
    });
    await sendCursorAgentMessage({
      chatJid,
      agentId: created.id,
      provider: created.provider,
      sourceMessage: msg,
      contextKind: 'cursor_job_card',
      payload: mergeTaskMessageContextPayload(
        buildCursorTaskContextPayload({
          agentId: created.id,
          provider: created.provider,
          contextType: 'job_card',
          status: created.status,
          summary:
            created.summary || created.sourceRepository || created.promptText,
        }),
        {
          responseFeedbackId: updated.feedbackId,
        },
      ),
      inlineActions: buildCursorJobCardActions(created),
      jobStatus: created.status,
      text: [
        'Andrea started a self-fix task for that downvoted reply.',
        '',
        formatCursorJobCard(created),
        '',
        formatCursorTaskNextStepMessage(created),
        '',
        'If the hotfix validates locally, I will still ask before any commit or push.',
      ].join('\n'),
    });
    return true;
  }

  async function handleDebugStatus(
    chatJid: string,
    message?: NewMessage,
  ): Promise<void> {
    refreshLogControlFromPersistence();
    await sendCursorMessage(chatJid, buildDebugStatusPanelText(), message, {
      inlineActions: buildDebugStatusInlineActions(),
    });
  }

  async function handleDebugLevel(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    const args = rawTrimmed.split(/\s+/).slice(1);
    const levelToken = args[0];
    if (!levelToken) {
      await sendCursorMessage(
        chatJid,
        'Usage: /debug-level <normal|debug|verbose> [scope] [duration]',
        message,
      );
      return;
    }

    try {
      const result = setDebugLevel({
        level: levelToken,
        scopeToken: args[1],
        durationToken: args[2],
        updatedBy: buildDebugUpdatedBy(chatJid, message),
        chatJid,
      });

      const aliasLabel =
        result.level === 'trace'
          ? 'verbose'
          : result.level === 'debug'
            ? 'debug'
            : 'normal';
      await sendCursorMessage(
        chatJid,
        formatWorkPanel({
          title: '*Debug Level Updated*',
          lines: [
            `Scope: ${result.resolvedScope.label}`,
            `Level: ${aliasLabel}`,
            `Expires: ${result.expiresAt || 'persistent'}`,
          ],
        }),
        message,
        {
          inlineActions: buildDebugMutationInlineActions(),
        },
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function handleDebugReset(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    try {
      const scopeToken = rawTrimmed.split(/\s+/).slice(1).join(' ').trim();
      const result = resetDebugLevel({
        scopeToken: scopeToken || 'chat',
        updatedBy: buildDebugUpdatedBy(chatJid, message),
        chatJid,
      });

      await sendCursorMessage(
        chatJid,
        formatWorkPanel({
          title: '*Debug Logging Reset*',
          lines: [`Scope: ${result.resetScope}`],
        }),
        message,
        {
          inlineActions: buildDebugMutationInlineActions(),
        },
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function handleDebugLogs(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    try {
      refreshLogControlFromPersistence();
      const args = rawTrimmed.split(/\s+/).slice(1);
      const target = args[0] || 'service';
      const parsedLines = Number.parseInt(args[1] || '', 10);
      const runtimeSnapshot = getActiveRuntimeSnapshot(chatJid);
      const logPayload = readDebugLogs({
        target,
        lines: Number.isFinite(parsedLines) ? parsedLines : 80,
        chatJid,
        groupFolder: registeredGroups[chatJid]?.folder,
        containerName: runtimeSnapshot?.containerName || null,
      });

      await sendCursorMessage(
        chatJid,
        formatWorkPanel({
          title: '*Debug Logs*',
          lines: [`Target: ${logPayload.title}`],
          sections: [logPayload.body],
        }),
        message,
        {
          inlineActions: buildDebugLogsInlineActions(
            target,
            Number.isFinite(parsedLines) ? parsedLines : 80,
          ),
        },
      );
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        err instanceof Error ? err.message : String(err),
        message,
      );
    }
  }

  async function sendBackendJobMessage(params: {
    chatJid: string;
    text: string;
    laneId: 'cursor' | 'andrea_runtime';
    jobId: string;
    sourceMessage?: NewMessage;
    contextKind: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
    inlineActionRows?: SendMessageOptions['inlineActionRows'];
    jobStatus?: string | null;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    const sendOptions = buildResponseFeedbackTaskSendOptions({
      laneId: params.laneId,
      jobId: params.jobId,
      payload: params.payload,
      inlineActions: params.inlineActions,
      inlineActionRows: params.inlineActionRows,
      jobStatus: params.jobStatus,
    });
    const platformMessageId = await sendCursorMessage(
      params.chatJid,
      params.text,
      params.sourceMessage,
      {
        replyToMessageId: params.replyToMessageId,
        inlineActions: sendOptions.inlineActions,
        inlineActionRows: sendOptions.inlineActionRows,
      },
    );
    if (platformMessageId) {
      rememberCursorMessageContext({
        chatJid: params.chatJid,
        platformMessageId,
        threadId: params.sourceMessage?.thread_id,
        contextKind: params.contextKind,
        laneId: params.laneId,
        agentId: params.jobId,
        payload: sendOptions.payload || null,
      });
    }
    rememberCursorOperatorSelection({
      chatJid: params.chatJid,
      threadId: params.sourceMessage?.thread_id,
      laneId: params.laneId,
      agentId: params.jobId,
    });
    return platformMessageId;
  }

  async function sendCursorAgentMessage(params: {
    chatJid: string;
    text: string;
    agentId: string;
    provider?: 'cloud' | 'desktop';
    sourceMessage?: NewMessage;
    contextKind: string;
    payload?: Record<string, unknown> | null;
    inlineActions?: SendMessageOptions['inlineActions'];
    inlineActionRows?: SendMessageOptions['inlineActionRows'];
    jobStatus?: string | null;
    replyToMessageId?: string;
  }): Promise<string | undefined> {
    const mergedPayload = mergeTaskMessageContextPayload(
      params.provider ? { provider: params.provider } : null,
      (params.payload || {}) as Record<string, unknown>,
    );
    return sendBackendJobMessage({
      chatJid: params.chatJid,
      text: params.text,
      laneId: 'cursor',
      jobId: params.agentId,
      sourceMessage: params.sourceMessage,
      contextKind: params.contextKind,
      payload: mergedPayload,
      inlineActions: params.inlineActions,
      inlineActionRows: params.inlineActionRows,
      jobStatus: params.jobStatus,
      replyToMessageId: params.replyToMessageId,
    });
  }

  function getCursorDashboardMessageContext(
    chatJid: string,
    platformMessageId: string | undefined,
  ): {
    platformMessageId: string;
    agentId: string | null;
    laneId: 'cursor' | 'andrea_runtime';
    state: CursorDashboardState;
  } | null {
    const context = getActiveCursorMessageContext(chatJid, platformMessageId);
    if (!context || context.contextKind !== 'cursor_dashboard') {
      return null;
    }
    const state = parseCursorDashboardState(context.payload);
    if (!state) return null;
    return {
      platformMessageId: context.platformMessageId,
      agentId: context.agentId,
      laneId: context.laneId === 'andrea_runtime' ? 'andrea_runtime' : 'cursor',
      state,
    };
  }

  function summarizeCursorDashboardLines(params: {
    cloudStatus: ReturnType<typeof getCursorCloudStatus>;
    desktopStatus: Awaited<ReturnType<typeof getCursorDesktopStatus>>;
    gatewayStatus: Awaited<ReturnType<typeof getCursorGatewayStatus>>;
    runtimeBackendStatus: Awaited<ReturnType<typeof getAndreaOpenAiBackendStatus>>;
  }): {
    cloudLine: string;
    desktopLine: string;
    runtimeRouteLine: string;
    codexRuntimeLine: string;
  } {
    const cloudLine =
      params.cloudStatus.enabled && params.cloudStatus.hasApiKey
        ? 'ready'
        : 'unavailable (add CURSOR_API_KEY)';
    const desktopLine = params.desktopStatus.terminalAvailable
      ? 'ready'
      : params.desktopStatus.enabled
        ? params.desktopStatus.probeDetail
          ? `conditional (${params.desktopStatus.probeDetail})`
          : 'conditional'
        : 'optional and unavailable';
    const runtimeRouteLine =
      params.gatewayStatus.mode === 'configured'
        ? params.gatewayStatus.probeStatus === 'ok'
          ? 'configured'
          : params.gatewayStatus.probeStatus === 'failed'
            ? `configured (${params.gatewayStatus.probeDetail || 'probe failed'})`
            : 'configured'
        : params.gatewayStatus.mode === 'partial'
          ? 'partial'
          : 'optional and off';
    const codexRuntimeLine =
      params.runtimeBackendStatus.state === 'available'
        ? 'available and authenticated'
        : params.runtimeBackendStatus.state === 'auth_required'
          ? 'available but needs codex login'
          : params.runtimeBackendStatus.state === 'not_ready'
            ? `degraded (${params.runtimeBackendStatus.detail || 'backend not ready'})`
            : params.runtimeBackendStatus.state === 'not_enabled'
              ? 'disabled in this NanoBot runtime'
              : `unavailable (${params.runtimeBackendStatus.detail || 'loopback unreachable'})`;
    return { cloudLine, desktopLine, runtimeRouteLine, codexRuntimeLine };
  }

  async function getCursorSelectedAgentRecord(
    chatJid: string,
    threadId?: string,
  ): Promise<{
    inventory: Awaited<ReturnType<typeof cursorBackendLane.getInventory>>;
    selected: FlattenedCursorJobEntry | null;
  } | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;
    const selectedAgentId = getSelectedLaneJobId(chatJid, threadId, 'cursor');
    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const flattened = flattenCursorJobInventory(inventory);
    const selected =
      selectedAgentId
        ? flattened.find((entry) => entry.id === selectedAgentId) || null
        : null;
    if (
      shouldClearStaleWorkCockpitSelection({
        selectedJobId: selectedAgentId,
        selectedExists: Boolean(selected),
        status: selected?.status || null,
      })
    ) {
      clearCurrentWorkSelection({
        chatJid,
        threadId,
        laneId: 'cursor',
        source: 'shared',
      });
      return {
        inventory,
        selected: null,
      };
    }
    return {
      inventory,
      selected,
    };
  }

  async function getCursorAgentRecord(
    chatJid: string,
    agentId: string,
  ): Promise<FlattenedCursorJobEntry | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;
    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    return (
      flattenCursorJobInventory(inventory).find(
        (entry) => entry.id === agentId,
      ) || null
    );
  }

  async function getRuntimeSelectedJobRecord(
    chatJid: string,
    threadId?: string,
  ): Promise<{
    jobs: BackendJobSummary[];
    selected: BackendJobDetails | null;
  } | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;

    const runtimeLane = getAndreaRuntimeLane();
    const selectedJobId =
      getSelectedLaneJobId(chatJid, threadId, 'andrea_runtime') ||
      getLegacyRuntimeSelection(chatJid, group.folder);
    if (
      selectedJobId &&
      !getSelectedLaneJobId(chatJid, threadId, 'andrea_runtime')
    ) {
      rememberCursorOperatorSelection({
        chatJid,
        threadId,
        laneId: 'andrea_runtime',
        agentId: selectedJobId,
      });
    }
    const jobs = await runtimeLane.listJobs({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const selected = selectedJobId
      ? await runtimeLane.getJob({
          handle: { laneId: 'andrea_runtime', jobId: selectedJobId },
          groupFolder: group.folder,
          chatJid,
        })
      : null;
    if (
      shouldClearStaleWorkCockpitSelection({
        selectedJobId,
        selectedExists: Boolean(selected),
        status: selected?.status || null,
      })
    ) {
      clearCurrentWorkSelection({
        chatJid,
        threadId,
        laneId: 'andrea_runtime',
        source: getSelectedLaneJobId(chatJid, threadId, 'andrea_runtime')
          ? 'shared'
          : 'legacy_runtime_fallback',
      });
      return { jobs, selected: null };
    }

    return { jobs, selected };
  }

  async function upsertCursorDashboardMessage(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    text: string;
    inlineActionRows: SendMessageOptions['inlineActionRows'];
    selectedAgentId?: string | null;
    selectedLaneId?: 'cursor' | 'andrea_runtime';
    forceNew?: boolean;
  }): Promise<string | undefined> {
    const channel = findChannel(channels, params.chatJid);
    if (!channel) return undefined;

    const activeContext = getActiveCursorOperatorContext(
      params.chatJid,
      params.sourceMessage?.thread_id,
    );
    const existingDashboardMessageId = params.forceNew
      ? null
      : activeContext?.dashboardMessageId || null;

    let platformMessageId: string | undefined;
    if (existingDashboardMessageId && channel.editMessage) {
      const edited = await channel.editMessage(
        params.chatJid,
        existingDashboardMessageId,
        params.text,
        {
          inlineActionRows: params.inlineActionRows,
        },
      );
      platformMessageId = edited.platformMessageId;
    }

    if (!platformMessageId) {
      const sent = await channel.sendMessage(
        params.chatJid,
        params.text,
        buildOperatorSendOptions(params.sourceMessage, {
          inlineActionRows: params.inlineActionRows,
        }),
      );
      platformMessageId = sent.platformMessageId;
    }

    if (!platformMessageId) return undefined;

    rememberCursorDashboardMessage({
      chatJid: params.chatJid,
      threadId: params.sourceMessage?.thread_id,
      dashboardMessageId: platformMessageId,
      selectedAgentId: params.selectedAgentId,
      selectedLaneId: params.selectedLaneId,
    });
    rememberCursorMessageContext({
      chatJid: params.chatJid,
      platformMessageId,
      threadId: params.sourceMessage?.thread_id,
      contextKind: 'cursor_dashboard',
      laneId: params.selectedLaneId || 'cursor',
      agentId: params.selectedAgentId || null,
      payload: formatCursorDashboardState(params.state),
    });
    return platformMessageId;
  }

  async function openCursorDashboard(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    forceNew?: boolean;
  }): Promise<string | undefined> {
    const group = registeredGroups[params.chatJid];
    if (!group) {
      return sendCursorMessage(
        params.chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        params.sourceMessage,
      );
    }

    if (params.state.kind === 'home') {
      const [desktopStatus, gatewayStatus, runtimeBackendStatus] = await Promise.all([
        getCursorDesktopStatus({ probe: false }),
        getCursorGatewayStatus({ probe: false }),
        getAndreaOpenAiBackendStatus(),
      ]);
      const cloudStatus = getCursorCloudStatus();
      const [selection, runtimeSelection] = await Promise.all([
        getCursorSelectedAgentRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
      ]);
      const currentWorkSelection = getCurrentWorkSelection(
        params.chatJid,
        group.folder,
        params.sourceMessage?.thread_id,
      );
      const reconciledCurrentWorkSelection =
        reconcileWorkCockpitCurrentSelection({
          currentSelection: currentWorkSelection
            ? {
                laneId: currentWorkSelection.laneId,
                jobId: currentWorkSelection.jobId,
              }
            : null,
          cursorJobId: selection?.selected?.id || null,
          runtimeJobId: runtimeSelection?.selected?.handle.jobId || null,
        });
      const effectiveCurrentWorkSelection = reconciledCurrentWorkSelection
        ? {
            ...reconciledCurrentWorkSelection,
            source: currentWorkSelection?.source || 'shared',
          }
        : null;
      const render = buildCursorDashboardHome({
        ...summarizeCursorDashboardLines({
          cloudStatus,
          desktopStatus,
          gatewayStatus,
          runtimeBackendStatus,
        }),
        currentJob: selection?.selected || undefined,
        currentRuntimeTask: runtimeSelection?.selected || undefined,
        currentFocusLaneId: effectiveCurrentWorkSelection?.laneId || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: effectiveCurrentWorkSelection?.jobId || null,
        selectedLaneId: effectiveCurrentWorkSelection?.laneId,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'status') {
      const desktopStatus = await getCursorDesktopStatus({ probe: true });
      const gatewayStatus = await getCursorGatewayStatus({ probe: true });
      const cloudStatus = getCursorCloudStatus();
      const capabilitySummary = summarizeCursorCapabilities({
        desktopStatus,
        cloudStatus,
        gatewayStatus,
      });
      const render = buildCursorDashboardStatus(
        formatCursorCapabilitySummaryMessage(capabilitySummary),
      );
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'jobs') {
      const inventory = await cursorBackendLane.getInventory({
        groupFolder: group.folder,
        chatJid: params.chatJid,
        limit: 50,
      });
      const flattened = flattenCursorJobInventory(inventory);
      const render = buildCursorDashboardJobs({
        entries: flattened,
        page: params.state.page || 0,
        pageSize: CURSOR_DASHBOARD_PAGE_SIZE,
        selectedAgentId: getSelectedLaneJobId(
          params.chatJid,
          params.sourceMessage?.thread_id,
          'cursor',
        ),
      });
      const platformMessageId = await upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: {
          kind: 'jobs',
          page: params.state.page || 0,
        },
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        forceNew: params.forceNew,
      });
      rememberCursorJobList({
        chatJid: params.chatJid,
        threadId: params.sourceMessage?.thread_id,
        listMessageId: platformMessageId,
        items: flattened.map((entry) => ({
          laneId: 'cursor',
          id: entry.id,
          provider: entry.provider,
        })),
        selectedAgentId: render.selectedAgentId || null,
        selectedLaneId: 'cursor',
      });
      return platformMessageId;
    }

    if (params.state.kind === 'current') {
      const selection = await getCursorSelectedAgentRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const selected = selection?.selected || null;
      const render = selected
        ? buildCursorDashboardCurrentJob(
            selected,
            selected.provider === 'cloud'
              ? cursorBackendLane.getTrackedArtifactCount(selected.id)
              : 0,
          )
        : buildCursorDashboardCurrentJobEmpty();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        selectedLaneId: 'cursor',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'work_current') {
      const [selection, runtimeSelection, runtimeBackendStatus] = await Promise.all([
        getCursorSelectedAgentRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getAndreaOpenAiBackendStatus(),
      ]);
      const currentWorkSelection = getCurrentWorkSelection(
        params.chatJid,
        group.folder,
        params.sourceMessage?.thread_id,
      );
      const reconciledCurrentWorkSelection =
        reconcileWorkCockpitCurrentSelection({
          currentSelection: currentWorkSelection
            ? {
                laneId: currentWorkSelection.laneId,
                jobId: currentWorkSelection.jobId,
              }
            : null,
          cursorJobId: selection?.selected?.id || null,
          runtimeJobId: runtimeSelection?.selected?.handle.jobId || null,
        });
      const effectiveCurrentWorkSelection = reconciledCurrentWorkSelection
        ? {
            ...reconciledCurrentWorkSelection,
            source: currentWorkSelection?.source || 'shared',
          }
        : null;
      const render = buildCursorDashboardWorkCurrent({
        currentFocusLaneId: effectiveCurrentWorkSelection?.laneId || null,
        currentJob: selection?.selected || undefined,
        currentRuntimeTask: runtimeSelection?.selected || undefined,
        executionEnabled: runtimeBackendStatus.state === 'available',
        currentJobResultCount:
          selection?.selected?.provider === 'cloud'
            ? cursorBackendLane.getTrackedArtifactCount(selection.selected.id)
            : 0,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          effectiveCurrentWorkSelection?.jobId || render.selectedAgentId,
        selectedLaneId: effectiveCurrentWorkSelection?.laneId,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime') {
      const [runtimeSelection, runtimeBackendStatus] = await Promise.all([
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getAndreaOpenAiBackendStatus(),
      ]);
      const render = buildCursorDashboardRuntime({
        executionEnabled: runtimeBackendStatus.state === 'available',
        readinessLine:
          runtimeBackendStatus.state === 'available'
            ? 'authenticated and ready on this host'
            : runtimeBackendStatus.state === 'auth_required'
              ? runtimeBackendStatus.detail || 'codex_local needs login on the backend host'
              : runtimeBackendStatus.state === 'not_enabled'
                ? 'loopback backend is disabled in this NanoBot runtime'
                : runtimeBackendStatus.detail ||
                  'historical review is available, but live runtime execution is currently unavailable',
        currentTask: runtimeSelection?.selected || undefined,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: runtimeSelection?.selected?.handle.jobId || null,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime_jobs') {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const jobs = runtimeSelection?.jobs || [];
      const render = buildCursorDashboardRuntimeJobs({
        jobs,
        page: params.state.page || 0,
        pageSize: CURSOR_DASHBOARD_PAGE_SIZE,
        selectedJobId: runtimeSelection?.selected?.handle.jobId || null,
      });
      const platformMessageId = await upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: {
          kind: 'runtime_jobs',
          page: params.state.page || 0,
        },
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: render.selectedAgentId,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
      rememberCursorJobList({
        chatJid: params.chatJid,
        threadId: params.sourceMessage?.thread_id,
        listMessageId: platformMessageId,
        items: jobs.map((job) => ({
          laneId: 'andrea_runtime',
          id: job.handle.jobId,
          provider: null,
        })),
        selectedAgentId: render.selectedAgentId || null,
        selectedLaneId: 'andrea_runtime',
      });
      return platformMessageId;
    }

    if (params.state.kind === 'runtime_current') {
      const [runtimeSelection, runtimeBackendStatus] = await Promise.all([
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
        ),
        getAndreaOpenAiBackendStatus(),
      ]);
      const render = runtimeSelection?.selected
        ? buildCursorDashboardRuntimeCurrent(
            runtimeSelection.selected,
            runtimeBackendStatus.state === 'available',
          )
        : buildCursorDashboardRuntimeCurrentEmpty();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          runtimeSelection?.selected?.handle.jobId || render.selectedAgentId,
        selectedLaneId: 'andrea_runtime',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'desktop') {
      const desktopStatus = await getCursorDesktopStatus({ probe: true });
      const render = buildCursorDashboardDesktop(
        formatCursorDesktopStatusMessage(desktopStatus),
      );
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'help') {
      const render = buildCursorDashboardHelp();
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'wizard_repo') {
      const selection = await getCursorSelectedAgentRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
      );
      const render = buildCursorDashboardWizardRepo({
        selectedRepo:
          params.state.wizard?.sourceRepository !== undefined
            ? params.state.wizard.sourceRepository
            : selection?.selected?.sourceRepository || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: selection?.selected?.id || null,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'wizard_prompt') {
      const render = buildCursorDashboardWizardPrompt({
        sourceRepository: params.state.wizard?.sourceRepository || null,
      });
      return upsertCursorDashboardMessage({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        forceNew: params.forceNew,
      });
    }

    const render = buildCursorDashboardWizardConfirm({
      sourceRepository: params.state.wizard?.sourceRepository || null,
      promptText: params.state.wizard?.promptText || '',
    });
    return upsertCursorDashboardMessage({
      chatJid: params.chatJid,
      sourceMessage: params.sourceMessage,
      state: params.state,
      text: render.text,
      inlineActionRows: render.inlineActionRows,
      forceNew: params.forceNew,
    });
  }
  async function resolveCursorTargetOrReply(params: {
    chatJid: string;
    message?: NewMessage;
    requestedTarget?: string | null;
  }): Promise<ResolvedCursorTarget | null> {
    const channel = findChannel(channels, params.chatJid);
    if (!channel) return null;

    try {
      const resolved = resolveCursorTarget({
        chatJid: params.chatJid,
        threadId: params.message?.thread_id,
        replyToMessageId: params.message?.reply_to_id,
        requestedTarget: params.requestedTarget,
      });
      if (resolved.target) {
        return resolved.target;
      }

      await channel.sendMessage(
        params.chatJid,
        resolved.failureMessage || getCursorContextGuidance(),
        buildOperatorSendOptions(params.message),
      );
      return null;
    } catch (err) {
      await channel.sendMessage(
        params.chatJid,
        formatCursorOperationFailure('Cursor target resolution failed', err),
        buildOperatorSendOptions(params.message),
      );
      return null;
    }
  }

  function parseCursorTargetToken(rawToken: string | undefined): string | null {
    return looksLikeCursorTargetToken(rawToken) ? rawToken!.trim() : null;
  }

  function parseCursorCommandTarget(rawMessage: string): {
    targetToken: string | null;
    args: string[];
  } {
    const parts = tokenizeCommandArguments(rawMessage);
    return {
      targetToken: parseCursorTargetToken(parts[1]),
      args: parts,
    };
  }

  function parseCursorCommandTargetAndLimit(
    rawMessage: string,
    fallbackLimit: number,
    maxLimit: number,
  ): {
    targetToken: string | null;
    limit: number;
  } {
    const { args, targetToken } = parseCursorCommandTarget(rawMessage);
    const limitIndex = targetToken ? 2 : 1;
    const parsedLimit = Number.parseInt(args[limitIndex] || '', 10);
    return {
      targetToken,
      limit:
        Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(maxLimit, parsedLimit)
          : fallbackLimit,
    };
  }

  async function sendCursorSelectionCard(
    chatJid: string,
    agentId: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) return;

    const inventory = await cursorBackendLane.getInventory({
      groupFolder: group.folder,
      chatJid,
      limit: 50,
    });
    const selected = flattenCursorJobInventory(inventory).find(
      (entry) => entry.id === agentId,
    );

    if (!selected) {
      await sendCursorMessage(
        chatJid,
        `That Cursor job is no longer visible in the latest /cursor-jobs list.\n\n${getCursorContextGuidance()}`,
        sourceMessage,
      );
      return;
    }

    const resultCount =
      selected.provider === 'cloud'
        ? cursorBackendLane.getTrackedArtifactCount(selected.id)
        : 0;
    const text = `${formatCursorJobCard(selected, resultCount)}\n\n${formatCursorTaskNextStepMessage(selected)}`;
    const replyToMessageId =
      sourceMessage?.reply_to_id || getOperatorReplyToMessageId(sourceMessage);
    await sendCursorAgentMessage({
      chatJid,
      text,
      agentId: selected.id,
      provider: selected.provider,
      sourceMessage,
      contextKind: 'cursor_job_card',
      payload: buildCursorTaskContextPayload({
        agentId: selected.id,
        provider: selected.provider,
        contextType: 'job_card',
        status: selected.status,
        summary:
          selected.summary ||
          selected.sourceRepository ||
          selected.promptText ||
          null,
      }),
      inlineActions: buildCursorJobCardActions(selected),
      jobStatus: selected.status,
      replyToMessageId,
    });
  }

  async function handleRemoteControl(
    action: 'start' | 'stop',
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    logger.info(
      { action, chatJid, sender: msg.sender },
      'Remote control command blocked in demo mode',
    );
    await channel.sendMessage(
      chatJid,
      'This experimental remote-control bridge is disabled in the demo runtime.',
    );
  }

  function resolveRuntimeGroupTarget(
    token: string,
  ): { chatJid: string; group: RegisteredGroup } | null {
    const trimmed = token.trim();
    if (!trimmed) return null;

    const byJid = registeredGroups[trimmed];
    if (byJid) {
      return { chatJid: trimmed, group: byJid };
    }

    const byFolder = Object.entries(registeredGroups).find(
      ([, group]) => group.folder === trimmed,
    );
    if (byFolder) {
      return { chatJid: byFolder[0], group: byFolder[1] };
    }

    return null;
  }

  async function resolveRuntimeBackendContext(
    chatJid: string,
  ): Promise<{ channel: Channel; group: RegisteredGroup } | null> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return null;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return null;
    }

    return { channel, group };
  }

  function readCachedRuntimeJob(jobId: string): RuntimeBackendJob | null {
    const cached = getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, jobId);
    if (!cached?.raw_json) return null;
    try {
      return JSON.parse(cached.raw_json) as RuntimeBackendJob;
    } catch (err) {
      logger.warn(
        { err, jobId },
        'Failed to parse cached runtime backend job payload',
      );
      return null;
    }
  }

  function getCurrentRuntimeSelection(
    chatJid: string,
    groupFolder: string,
  ): string | null {
    const selection = getRuntimeBackendChatSelection(
      ANDREA_OPENAI_BACKEND_ID,
      chatJid,
    );
    if (!selection) return null;

    if (selection.group_folder !== groupFolder) {
      deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
      return null;
    }

    return selection.job_id;
  }

  function updateCurrentRuntimeSelection(
    chatJid: string,
    groupFolder: string,
    jobId: string,
    updatedAt = new Date().toISOString(),
  ): void {
    upsertRuntimeBackendChatSelection({
      backend_id: ANDREA_OPENAI_BACKEND_ID,
      chat_jid: chatJid,
      job_id: jobId,
      group_folder: groupFolder,
      updated_at: updatedAt,
    });
  }

  function clearCurrentRuntimeSelection(chatJid: string): void {
    deleteRuntimeBackendChatSelection(ANDREA_OPENAI_BACKEND_ID, chatJid);
  }

  function shouldClearRuntimeSelectionForError(err: unknown): boolean {
    return (
      err instanceof AndreaOpenAiRuntimeError &&
      (err.kind === 'not_found' || err.kind === 'context_mismatch')
    );
  }

  async function sendRuntimeBackendCardMessage(params: {
    channel: Channel;
    chatJid: string;
    group: RegisteredGroup;
    text: string;
    job?: RuntimeBackendJob | null;
    threadId?: string;
    armReplyContext?: boolean;
    updateSelection?: boolean;
  }): Promise<void> {
    const {
      channel,
      chatJid,
      group,
      text,
      job,
      threadId,
      armReplyContext = false,
      updateSelection = false,
    } = params;

    let receipt = null;
    if (channel.sendMessageWithReceipt) {
      receipt = await channel.sendMessageWithReceipt(chatJid, text, {
        ...(threadId ? { threadId } : {}),
      });
      if (!receipt) return;
    } else {
      await channel.sendMessage(chatJid, text, {
        ...(threadId ? { threadId } : {}),
      });
    }

    if (!job) return;

    const nowIso = new Date().toISOString();
    if (updateSelection) {
      updateCurrentRuntimeSelection(chatJid, group.folder, job.jobId, nowIso);
    }

    if (!armReplyContext || !receipt?.platformMessageIds.length) return;

    const expiresAt = computeRuntimeCardContextExpiry(nowIso);
    for (const messageId of receipt.platformMessageIds) {
      upsertRuntimeBackendCardContext({
        backend_id: ANDREA_OPENAI_BACKEND_ID,
        chat_jid: chatJid,
        message_id: messageId,
        job_id: job.jobId,
        group_folder: group.folder,
        thread_id: threadId || job.threadId || null,
        created_at: nowIso,
        expires_at: expiresAt,
      });
    }
  }

  async function maybeHandleRuntimeReplyContext(
    chatJid: string,
    msg: NewMessage,
  ): Promise<boolean> {
    const replyTo = msg.reply_to;
    const replyText = replyTo?.content?.trim() || '';
    const replyMessageId = replyTo?.message_id?.trim() || '';
    const promptText = msg.content.trim();

    if (!replyText || !replyMessageId || !promptText) return false;

    const unifiedRuntimeReplyContext = getActiveCursorMessageContext(
      chatJid,
      replyMessageId,
    );
    if (unifiedRuntimeReplyContext?.laneId === 'andrea_runtime') {
      return false;
    }

    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return true;

    pruneExpiredRuntimeBackendCardContexts(new Date().toISOString());
    const runtimeCardContext = getRuntimeBackendCardContext(
      ANDREA_OPENAI_BACKEND_ID,
      chatJid,
      replyMessageId,
    );
    const resolution = resolveRuntimeReplyContext({
      replyMessageId,
      replyText,
      contextMessageId: runtimeCardContext?.message_id,
      contextJobId: runtimeCardContext?.job_id,
      contextGroupFolder: runtimeCardContext?.group_folder,
      currentGroupFolder: context.group.folder,
      expiresAt: runtimeCardContext?.expires_at,
      nowIso: new Date().toISOString(),
    });

    if (resolution.kind === 'not_runtime_reply') {
      return false;
    }

    if (resolution.kind === 'missing' || resolution.kind === 'expired') {
      if (runtimeCardContext && resolution.kind === 'expired') {
        deleteRuntimeBackendCardContext(
          ANDREA_OPENAI_BACKEND_ID,
          chatJid,
          replyMessageId,
        );
      }
      await context.channel.sendMessage(
        chatJid,
        buildRuntimeReplyContextMissingMessage(resolution.jobIdHint),
        {
          ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
        },
      );
      return true;
    }

    try {
      const job = await followUpAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId: resolution.jobId!,
        prompt: promptText,
        actorId: msg.sender,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendFollowupAcceptedMessage(job),
        job,
        threadId: msg.thread_id || runtimeCardContext?.thread_id || undefined,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
        {
          ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
        },
      );
    }

    return true;
  }

  async function runOperatorRuntimeFollowup(
    operatorChatJid: string,
    targetChatJid: string,
    targetGroup: RegisteredGroup,
    promptText: string,
  ): Promise<void> {
    const channel = findChannel(channels, operatorChatJid);
    if (!channel) return;

    const requestPolicy = classifyAssistantRequest([{ content: promptText }]);
    let hadVisibleOutput = false;

    const result = await runAgent(
      targetGroup,
      promptText,
      targetChatJid,
      requestPolicy,
      IDLE_TIMEOUT,
      false,
      async (partial) => {
        const text =
          typeof partial.result === 'string'
            ? formatOutbound(partial.result)
            : '';
        if (!text) return;
        hadVisibleOutput = true;
        await channel.sendMessage(
          operatorChatJid,
          `Runtime follow-up (${targetGroup.folder}):\n\n${text}`,
        );
      },
    );

    if (result.status === 'error') {
      await channel.sendMessage(
        operatorChatJid,
        result.userMessage ||
          `Runtime follow-up failed for ${targetGroup.folder}.`,
      );
      return;
    }

    if (!hadVisibleOutput) {
      await channel.sendMessage(
        operatorChatJid,
        `Runtime follow-up for ${targetGroup.folder} completed without a user-visible reply.`,
      );
    }
  }

  async function handleRuntimeStatus(chatJid: string): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    const status = await getAndreaOpenAiBackendStatus();
    await context.channel.sendMessage(
      chatJid,
      formatRuntimeBackendStatusSummary(
        status,
        context.group,
        ANDREA_OPENAI_BACKEND_URL,
      ),
    );
  }

  async function handleRuntimeCreate(
    chatJid: string,
    promptText: string,
    actorId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await createAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        prompt: promptText,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendCreateAcceptedMessage(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeJobs(
    chatJid: string,
    limit: number,
    beforeJobId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await listAndreaOpenAiRuntimeJobs({
        chatJid,
        group: context.group,
        limit,
        beforeJobId,
      });
      if (result.jobs.length === 0) {
        await context.channel.sendMessage(
          chatJid,
          `No Andrea OpenAI jobs are recorded yet for backend group "${context.group.folder}".`,
        );
        return;
      }
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendJobsMessage({
          group: context.group,
          jobs: result.jobs,
          nextBeforeJobId: result.nextBeforeJobId,
          limit,
        }),
      );
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeJob(
    chatJid: string,
    jobId: string,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await getAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendJobCard(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleRuntimeFollowup(
    chatJid: string,
    jobId: string,
    promptText: string,
    actorId?: string,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const job = await followUpAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
        prompt: promptText,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendFollowupAcceptedMessage(job),
        job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      await context.channel.sendMessage(
        chatJid,
        formatRuntimeBackendFailure(err, chatJid, context.group),
      );
    }
  }

  async function handleRuntimeStop(
    chatJid: string,
    jobId: string,
    actorId?: string,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await stopAndreaOpenAiRuntimeJob({
        chatJid,
        group: context.group,
        jobId,
        actorId,
      });
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendStopMessage(result),
        job: result.job,
        armReplyContext: true,
        updateSelection: true,
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleRuntimeLogs(
    chatJid: string,
    jobId: string,
    limit: number,
    usedSelection = false,
  ): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    try {
      const result = await getAndreaOpenAiRuntimeJobLogs({
        chatJid,
        group: context.group,
        jobId,
        lines: limit,
      });
      let currentJob = readCachedRuntimeJob(jobId);
      if (!currentJob && !result.logText?.trim()) {
        try {
          currentJob = await getAndreaOpenAiRuntimeJob({
            chatJid,
            group: context.group,
            jobId,
          });
        } catch {
          currentJob = null;
        }
      }
      await sendRuntimeBackendCardMessage({
        channel: context.channel,
        chatJid,
        group: context.group,
        text: formatRuntimeBackendLogsMessage(result, currentJob),
        job: currentJob,
        armReplyContext: Boolean(currentJob),
        updateSelection: Boolean(currentJob),
      });
    } catch (err) {
      if (usedSelection && shouldClearRuntimeSelectionForError(err)) {
        clearCurrentRuntimeSelection(chatJid);
      }
      await context.channel.sendMessage(
        chatJid,
        [
          formatRuntimeBackendFailure(err, chatJid, context.group),
          usedSelection && shouldClearRuntimeSelectionForError(err)
            ? '- Current runtime selection cleared for this chat.'
            : null,
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n'),
      );
    }
  }

  async function handleCursorStatus(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const desktopStatus = await getCursorDesktopStatus({ probe: true });
    const gatewayStatus = await getCursorGatewayStatus({ probe: true });
    const cloudStatus = getCursorCloudStatus();
    const capabilitySummary = summarizeCursorCapabilities({
      desktopStatus,
      cloudStatus,
      gatewayStatus,
    });
    await sendCursorMessage(
      chatJid,
      formatWorkPanel({
        title: '*Cursor Status*',
        sections: [
          formatCursorCapabilitySummaryMessage(capabilitySummary),
          formatCursorDesktopStatusMessage(desktopStatus),
          formatCursorGatewayStatusMessage(gatewayStatus),
          formatCursorCloudStatusMessage(cloudStatus),
        ],
      }),
      sourceMessage,
      {
        inlineActions: buildCursorStatusInlineActions(chatJid),
      },
    );
  }

  async function runCursorCloudProbeMessage(): Promise<string> {
    const status = getCursorCloudStatus();
    if (!status.enabled) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: skipped',
        '- Detail: set `CURSOR_API_KEY` to enable Cursor Cloud Agent probes.',
      ].join('\n');
    }

    const config = resolveCursorCloudConfig();
    if (!config) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: failed',
        '- Detail: Cursor Cloud config could not be resolved from environment.',
      ].join('\n');
    }

    try {
      const client = new CursorCloudClient(config);
      const models = await client.listModels();
      const modelPreview = models.models
        .slice(0, 5)
        .map((model) => model.id)
        .join(', ');
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: ok',
        `- Base URL: ${status.baseUrl}`,
        `- Models visible: ${models.models.length}`,
        modelPreview ? `- Sample models: ${modelPreview}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    } catch (err) {
      return [
        '*Cursor Cloud Agents Probe*',
        '- Status: failed',
        `- Detail: ${getUserFacingErrorDetail(err)}`,
      ].join('\n');
    }
  }

  async function runCursorDesktopProbeMessage(): Promise<string> {
    const status = await getCursorDesktopStatus({ probe: true });
    return formatCursorDesktopStatusMessage(status);
  }

  async function handleCursorSmokeTest(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = await getCursorGatewayStatus({ probe: true });
    const smoke = await runCursorGatewaySmokeTest({ status });
    const desktopProbe = await runCursorDesktopProbeMessage();
    const cloudProbe = await runCursorCloudProbeMessage();
    await channel.sendMessage(
      chatJid,
      [
        desktopProbe,
        formatCursorGatewaySmokeTestMessage(status, smoke),
        cloudProbe,
      ].join('\n\n'),
    );
  }

  async function handleCursorDashboard(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    const pilotRecord = group
      ? startPilotJourney({
          ...resolveWorkCockpitPilotJourney({ source: 'dashboard_open' }),
          channel: 'telegram',
          groupFolder: group.folder,
          chatJid,
          threadId: sourceMessage?.thread_id || null,
        })
      : null;
    try {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'home' },
        forceNew: true,
      });
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'success',
          blockerOwner: 'none',
          summaryText: 'Opened the work cockpit dashboard.',
        });
      }
    } catch (err) {
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'work_cockpit_dashboard_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'work cockpit dashboard failed',
        });
      }
      throw err;
    }
  }

  async function handleCurrentWorkQuickOpen(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    const pilotRecord = group
      ? startPilotJourney({
          ...resolveWorkCockpitPilotJourney({ source: 'current_work' }),
          channel: 'telegram',
          groupFolder: group.folder,
          chatJid,
          threadId: sourceMessage?.thread_id || null,
        })
      : null;
    try {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'work_current' },
      });
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'success',
          blockerOwner: 'none',
          summaryText: 'Opened current work from the work cockpit.',
        });
      }
    } catch (err) {
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'current_work_quick_open_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'current work quick-open failed',
        });
      }
      throw err;
    }
  }

  async function handleAmazonStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = getAmazonBusinessStatus();
    await channel.sendMessage(
      chatJid,
      [
        formatAmazonBusinessStatusMessage(status),
        status.searchReady
          ? 'Try `/amazon-search <keywords>` to look for a product, then Andrea can prepare a guarded purchase approval.'
          : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n\n'),
    );
  }

  async function handleAlexaStatus(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const status = alexaRuntime?.getStatus() || getAlexaStatus();
    await channel.sendMessage(chatJid, formatAlexaStatusMessage(status));
  }

  async function handleAmazonSearch(
    chatJid: string,
    query: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const results = await searchAmazonProducts(query, 5);
      await channel.sendMessage(
        chatJid,
        formatAmazonSearchResultsMessage(query, results),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure('Amazon search failed', err),
      );
    }
  }

  async function handleAmazonPurchaseRequest(
    chatJid: string,
    asin: string,
    offerId: string,
    quantity: number,
    requestedBy?: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const created = await createAmazonPurchaseRequest({
        groupFolder: group.folder,
        chatJid,
        asin,
        offerId,
        quantity,
        requestedBy,
      });
      await channel.sendMessage(chatJid, created.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure('Amazon purchase request failed', err),
      );
    }
  }

  async function handleAmazonPurchaseRequests(chatJid: string): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      await channel.sendMessage(
        chatJid,
        formatAmazonPurchaseRequestsMessage(
          listAmazonPurchaseRequests(group.folder, 20),
        ),
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase request lookup failed',
          err,
        ),
      );
    }
  }

  async function handleAmazonPurchaseApprove(
    chatJid: string,
    requestId: string,
    approvalCode: string,
    approvedBy?: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const approved = await approveAmazonPurchaseRequest({
        groupFolder: group.folder,
        requestId,
        approvalCode,
        approvedBy,
      });
      await channel.sendMessage(chatJid, approved.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase approval failed',
          err,
        ),
      );
    }
  }

  async function handleAmazonPurchaseCancel(
    chatJid: string,
    requestId: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
      );
      return;
    }

    try {
      const cancelled = cancelAmazonPurchaseRequest({
        groupFolder: group.folder,
        requestId,
      });
      await channel.sendMessage(chatJid, cancelled.message);
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatUserFacingOperationFailure(
          'Amazon purchase cancellation failed',
          err,
        ),
      );
    }
  }

  async function handleCursorJobs(
    chatJid: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    await openCursorDashboard({
      chatJid,
      sourceMessage,
      state: { kind: 'jobs', page: 0 },
      forceNew: true,
    });
  }

  async function sendRuntimeDashboardPrompt(
    chatJid: string,
    job: BackendJobDetails,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    await sendBackendJobMessage({
      chatJid,
      laneId: 'andrea_runtime',
      jobId: job.handle.jobId,
      sourceMessage,
      contextKind: 'runtime_job_message',
      payload: mergeTaskMessageContextPayload(job.metadata, {
        taskContextType: 'job_card',
        taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(job.handle.jobId)}`,
        taskSummary: summarizeVisibleTaskText(job.summary),
      }),
      text: formatTaskReplyPrompt({
        lane: 'codex_runtime',
        taskId: job.handle.jobId,
      }),
    });
  }

  async function handleCursorUi(
    chatJid: string,
    rawMessage: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const args = tokenizeCommandArguments(rawMessage);
    const action = (args[1] || 'home').trim().toLowerCase();
    const dashboardContext = getCursorDashboardMessageContext(
      chatJid,
      sourceMessage?.reply_to_id,
    );

    if (sourceMessage?.reply_to_id && !dashboardContext) {
      await sendCursorMessage(
        chatJid,
        CURSOR_DASHBOARD_EXPIRED_MESSAGE,
        sourceMessage,
      );
      return;
    }

    const activeSelection = await getCursorSelectedAgentRecord(
      chatJid,
      sourceMessage?.thread_id,
    );
    const selectedAgent = activeSelection?.selected || null;

    if (action === 'home') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'home' },
      });
      return;
    }

    if (action === 'status') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'status' },
      });
      return;
    }

    if (action === 'jobs') {
      const rawPage = Number.parseInt(args[2] || '', 10);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: {
          kind: 'jobs',
          page:
            Number.isFinite(rawPage) && rawPage > 0
              ? Math.max(0, rawPage - 1)
              : dashboardContext?.state.kind === 'jobs'
                ? dashboardContext.state.page || 0
                : 0,
        },
      });
      return;
    }

    if (action === 'current') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'work-current') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'work_current' },
      });
      return;
    }

    if (action === 'desktop') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'desktop' },
      });
      return;
    }

    if (action === 'runtime') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime' },
      });
      return;
    }

    if (action === 'runtime-jobs') {
      const rawPage = Number.parseInt(args[2] || '', 10);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: {
          kind: 'runtime_jobs',
          page:
            Number.isFinite(rawPage) && rawPage > 0
              ? Math.max(0, rawPage - 1)
              : dashboardContext?.state.kind === 'runtime_jobs'
                ? dashboardContext.state.page || 0
                : 0,
        },
      });
      return;
    }

    if (action === 'runtime-current') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime_current' },
      });
      return;
    }

    if (action === 'help') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'help' },
      });
      return;
    }

    if (action === 'new') {
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'wizard_repo' },
      });
      return;
    }

    if (action === 'select') {
      if (dashboardContext?.state.kind !== 'jobs') {
        await sendCursorMessage(
          chatJid,
          CURSOR_DASHBOARD_EXPIRED_MESSAGE,
          sourceMessage,
        );
        return;
      }
      const visibleIndex = Number.parseInt(args[2] || '', 10);
      if (!Number.isFinite(visibleIndex) || visibleIndex <= 0) {
        await sendCursorMessage(
          chatJid,
          'That task tile is invalid. Open `/cursor` and browse Jobs again.',
          sourceMessage,
        );
        return;
      }
      const inventory = await cursorBackendLane.getInventory({
        groupFolder: registeredGroups[chatJid].folder,
        chatJid,
        limit: 50,
      });
      const flattened = flattenCursorJobInventory(inventory);
      const page = dashboardContext.state.page || 0;
      const selected =
        flattened[page * CURSOR_DASHBOARD_PAGE_SIZE + visibleIndex - 1];
      if (!selected) {
        await sendCursorMessage(
          chatJid,
          'That task is no longer visible in this Cursor jobs page. Open `Jobs` again to refresh the list.',
          sourceMessage,
        );
        return;
      }
      rememberCursorOperatorSelection({
        chatJid,
        threadId: sourceMessage?.thread_id,
        agentId: selected.id,
      });
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'work_current' },
      });
      return;
    }

    if (action === 'runtime-select') {
      if (dashboardContext?.state.kind !== 'runtime_jobs') {
        await sendCursorMessage(
          chatJid,
          CURSOR_DASHBOARD_EXPIRED_MESSAGE,
          sourceMessage,
        );
        return;
      }
      const visibleIndex = Number.parseInt(args[2] || '', 10);
      if (!Number.isFinite(visibleIndex) || visibleIndex <= 0) {
        await sendCursorMessage(
          chatJid,
          'That task tile is invalid. Open `Codex/OpenAI` and browse Recent Work again.',
          sourceMessage,
        );
        return;
      }
      const runtimeLane = getAndreaRuntimeLane();
      const jobs = await runtimeLane.listJobs({
        groupFolder: registeredGroups[chatJid].folder,
        chatJid,
        limit: 50,
      });
      const page = dashboardContext.state.page || 0;
      const selected =
        jobs[page * CURSOR_DASHBOARD_PAGE_SIZE + visibleIndex - 1];
      if (!selected) {
        await sendCursorMessage(
          chatJid,
          'That task is no longer visible in this Codex/OpenAI work page. Open `Recent Work` again to refresh the list.',
          sourceMessage,
        );
        return;
      }
      rememberCursorOperatorSelection({
        chatJid,
        threadId: sourceMessage?.thread_id,
        laneId: 'andrea_runtime',
        agentId: selected.handle.jobId,
      });
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'work_current' },
      });
      return;
    }

    if (action === 'sync') {
      await handleCursorSync(chatJid, null, sourceMessage);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'text') {
      await handleCursorConversation(chatJid, null, 20, sourceMessage);
      return;
    }

    if (action === 'files') {
      await handleCursorArtifacts(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'stop') {
      await handleCursorStop(chatJid, null, sourceMessage);
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'current' },
      });
      return;
    }

    if (action === 'followup') {
      if (!selectedAgent || selectedAgent.provider !== 'cloud') {
        await sendCursorMessage(
          chatJid,
          'Continue is only available for the current Cursor Cloud task. Open `Current Job`, then reply with plain text to that dashboard.',
          sourceMessage,
        );
        return;
      }
      await sendCursorAgentMessage({
        chatJid,
        agentId: selectedAgent.id,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: formatTaskReplyPrompt({
          lane: 'cursor_cloud',
          taskId: selectedAgent.id,
        }),
      });
      return;
    }

    if (
      action === 'runtime-refresh' ||
      action === 'runtime-output' ||
      action === 'runtime-followup' ||
      action === 'runtime-stop'
    ) {
      const runtimeLane = getAndreaRuntimeLane();
      const dashboardRuntimeJobId = resolveRuntimeDashboardJobId(
        dashboardContext
          ? {
              laneId: dashboardContext.laneId,
              agentId: dashboardContext.agentId,
              state: dashboardContext.state,
            }
          : null,
      );
      const runtimeSelection = dashboardRuntimeJobId
        ? null
        : await getRuntimeSelectedJobRecord(chatJid, sourceMessage?.thread_id);
      const selectedRuntimeJob = dashboardRuntimeJobId
        ? await runtimeLane.getJob({
            handle: {
              laneId: 'andrea_runtime',
              jobId: dashboardRuntimeJobId,
            },
            groupFolder: registeredGroups[chatJid].folder,
            chatJid,
          })
        : runtimeSelection?.selected || null;
      if (!selectedRuntimeJob) {
        await sendCursorMessage(
          chatJid,
          dashboardRuntimeJobId
            ? `Codex/OpenAI task ${formatOpaqueTaskId(dashboardRuntimeJobId)} is no longer available in this workspace.`
            : 'No Codex/OpenAI task is selected yet. Open `Codex/OpenAI`, then tap `Recent Work` to choose one.',
          sourceMessage,
        );
        return;
      }

      if (action === 'runtime-refresh') {
        const refreshed = await runtimeLane.refreshJob({
          handle: selectedRuntimeJob.handle,
          groupFolder: registeredGroups[chatJid].folder,
          chatJid,
        });
        if (!refreshed) {
          await sendCursorMessage(
            chatJid,
            `Codex/OpenAI task ${formatOpaqueTaskId(selectedRuntimeJob.handle.jobId)} is no longer available in this workspace.`,
            sourceMessage,
          );
          return;
        }
        await sendBackendJobMessage({
          chatJid,
          laneId: 'andrea_runtime',
          jobId: refreshed.handle.jobId,
          sourceMessage,
          contextKind: 'runtime_job_card',
          payload: mergeTaskMessageContextPayload(refreshed.metadata, {
            taskContextType: 'job_card',
            taskTitle: `Codex/OpenAI runtime ${formatOpaqueTaskId(refreshed.handle.jobId)}`,
            taskSummary: summarizeVisibleTaskText(refreshed.summary),
          }),
          inlineActions: buildRuntimeJobInlineActions({
            job: refreshed,
            contextKind: 'runtime_job_card',
            canExecute: andreaRuntimeExecutionEnabled,
          }),
          text: [
            `Refreshed Codex/OpenAI task ${formatOpaqueTaskId(refreshed.handle.jobId)}.`,
            formatRuntimeJobCard(refreshed),
            formatRuntimeNextStep(refreshed.handle.jobId),
          ].join('\n\n'),
        });
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: { kind: 'runtime_current' },
        });
        return;
      }

      if (action === 'runtime-output') {
        await handleAndreaRuntimeCommand(
          chatJid,
          `/runtime-logs ${selectedRuntimeJob.handle.jobId}`,
          '/runtime-logs',
          sourceMessage,
        );
        return;
      }

      if (!andreaRuntimeExecutionEnabled) {
        await sendCursorMessage(
          chatJid,
          buildAndreaRuntimeDisabledMessage(),
          sourceMessage,
        );
        return;
      }

      if (action === 'runtime-followup') {
        await sendRuntimeDashboardPrompt(
          chatJid,
          selectedRuntimeJob,
          sourceMessage,
        );
        return;
      }

      await handleAndreaRuntimeCommand(
        chatJid,
        `/runtime-stop ${selectedRuntimeJob.handle.jobId}`,
        '/runtime-stop',
        sourceMessage,
      );
      await openCursorDashboard({
        chatJid,
        sourceMessage,
        state: { kind: 'runtime_current' },
      });
      return;
    }

    if (action === 'terminal-status') {
      await handleCursorTerminalStatus(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'terminal-log') {
      await handleCursorTerminalLog(chatJid, null, 40, sourceMessage);
      return;
    }

    if (action === 'terminal-help') {
      await handleCursorTerminalHelp(chatJid, null, sourceMessage);
      return;
    }

    if (action === 'wizard') {
      const step = (args[2] || '').trim().toLowerCase();
      const priorWizard = dashboardContext?.state.wizard || {};

      if (step === 'repo-selected') {
        const selectedRepo = selectedAgent?.sourceRepository || null;
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_prompt',
            wizard: {
              ...priorWizard,
              sourceRepository: selectedRepo,
            },
          },
        });
        return;
      }

      if (step === 'repo-none') {
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_prompt',
            wizard: {
              ...priorWizard,
              sourceRepository: null,
            },
          },
        });
        return;
      }

      if (step === 'edit-repo') {
        await openCursorDashboard({
          chatJid,
          sourceMessage,
          state: {
            kind: 'wizard_repo',
            wizard: {
              ...priorWizard,
            },
          },
        });
        return;
      }

      if (step === 'create') {
        const promptText = priorWizard.promptText?.trim();
        if (!promptText) {
          await sendCursorMessage(
            chatJid,
            'Reply to the dashboard with the Cloud job prompt before you tap Create.',
            sourceMessage,
          );
          return;
        }
        const created = await handleCursorCreate(
          chatJid,
          promptText,
          sourceMessage?.sender,
          {
            sourceRepository: priorWizard.sourceRepository || undefined,
          },
          sourceMessage,
        );
        if (created) {
          await openCursorDashboard({
            chatJid,
            sourceMessage,
            state: { kind: 'current' },
          });
        }
        return;
      }
    }

    await sendCursorMessage(
      chatJid,
      CURSOR_DASHBOARD_EXPIRED_MESSAGE,
      sourceMessage,
    );
  }

  async function handleCursorModels(
    chatJid: string,
    filterText: string,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    try {
      const models = await listCursorModels(200);
      const normalizedFilter = filterText.trim().toLowerCase();
      const matches = normalizedFilter
        ? models.filter((model) => {
            const haystack = `${model.id} ${model.name || ''}`.toLowerCase();
            return haystack.includes(normalizedFilter);
          })
        : models;

      if (matches.length === 0) {
        await channel.sendMessage(
          chatJid,
          normalizedFilter
            ? `No Cursor models matched "${filterText.trim()}".`
            : 'Cursor Cloud returned no models for this account right now. Job control can still work without `/cursor-models` if you omit `--model` and let Cursor use its default.',
        );
        return;
      }

      const capped = matches.slice(0, 30);
      const lines = capped.map((model, index) => {
        const label = model.name && model.name !== model.id ? model.name : null;
        return `${index + 1}. ${model.id}${label ? ` (${label})` : ''}`;
      });
      const truncated =
        matches.length > capped.length
          ? `\n\nShowing ${capped.length} of ${matches.length} models. Narrow with /cursor-models FILTER.`
          : '';

      await channel.sendMessage(
        chatJid,
        `Cursor models:\n\n${lines.join('\n')}${truncated}`,
      );
    } catch (err) {
      await channel.sendMessage(
        chatJid,
        formatCursorOperationFailure('Cursor model list failed', err),
      );
    }
  }

  async function handleCursorCreate(
    chatJid: string,
    promptText: string,
    requestedBy?: string,
    options: {
      model?: string;
      sourceRepository?: string;
      sourceRef?: string;
      sourcePrUrl?: string;
      branchName?: string;
      autoCreatePr?: boolean;
      openAsCursorGithubApp?: boolean;
      skipReviewerRequest?: boolean;
    } = {},
    sourceMessage?: NewMessage,
  ): Promise<CursorAgentView | null> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return null;
    }

    try {
      const created = await cursorBackendLane.createCursorJob({
        groupFolder: group.folder,
        chatJid,
        promptText,
        requestedBy,
        options: {
          model: options.model,
          sourceRepository: options.sourceRepository,
          sourceRef: options.sourceRef,
          sourcePrUrl: options.sourcePrUrl,
          branchName: options.branchName,
          autoCreatePr: options.autoCreatePr,
          openAsCursorGithubApp: options.openAsCursorGithubApp,
          skipReviewerRequest: options.skipReviewerRequest,
        },
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: created.id,
        provider: created.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: created.id,
          provider: created.provider,
          contextType: 'job_card',
          status: created.status,
          summary:
            created.summary ||
            created.sourceRepository ||
            created.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(created),
        jobStatus: created.status,
        text: [
          'Andrea started this Cursor task.',
          '',
          formatCursorJobCard(created),
          '',
          formatCursorTaskNextStepMessage(created),
        ]
          .filter(Boolean)
          .join('\n'),
      });
      return created;
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure('Cursor create failed', err),
        sourceMessage,
      );
      return null;
    }
  }

  async function handleCursorConversation(
    chatJid: string,
    requestedTarget: string | null,
    limit: number,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const messages = await cursorBackendLane.getConversation({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        limit,
      });
      const provider = isDesktopCursorRecord(normalizedAgentId)
        ? 'desktop'
        : 'cloud';
      const actionRecord =
        provider === 'cloud'
          ? await getCursorAgentRecord(chatJid, normalizedAgentId)
          : null;
      const inlineActions =
        provider === 'desktop'
          ? buildCursorTerminalCardActions()
          : buildCursorCloudTaskActions(actionRecord?.targetUrl || null);

      if (messages.length === 0) {
        await sendCursorAgentMessage({
          chatJid,
          agentId: normalizedAgentId,
          provider,
          sourceMessage,
          contextKind: 'cursor_job_message',
        payload: buildCursorTaskContextPayload({
          agentId: normalizedAgentId,
          provider,
          contextType: 'output',
          status: actionRecord?.status || null,
          outputSource: 'none',
        }),
        jobStatus: actionRecord?.status || null,
        inlineActions,
        text: `No output is available yet for this task.\nTask: ${labelCursorRecord(normalizedAgentId)} ${formatOpaqueTaskId(normalizedAgentId)}.\n\n${formatCursorTaskNextStepMessage({ provider, id: normalizedAgentId })}`,
        });
        return;
      }

      const formatted = messages
        .map((message, index) => {
          const compact = message.content.replace(/\s+/g, ' ').trim();
          const preview =
            compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
          const createdAt = message.createdAt ? ` @ ${message.createdAt}` : '';
          return `${index + 1}. [${message.role}]${createdAt}\n${preview}`;
        })
        .join('\n\n');
      const outputSuggestion = buildTaskOutputSuggestion({
        laneId: 'cursor',
        contextKind: 'output',
        hasStructuredOutput: true,
        canReplyContinue: provider !== 'desktop',
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider,
        sourceMessage,
        contextKind: 'cursor_job_message',
        payload: buildCursorTaskContextPayload({
          agentId: normalizedAgentId,
          provider,
          contextType: 'output',
          status: actionRecord?.status || null,
          outputPreview: messages.at(-1)?.content || formatted,
          outputSource: 'conversation',
        }),
        jobStatus: actionRecord?.status || null,
        inlineActions,
        text: `Current output for this task\nTask: ${labelCursorRecord(normalizedAgentId)} ${formatOpaqueTaskId(normalizedAgentId)} (latest ${messages.length} messages)\n\n${formatted}${outputSuggestion ? `\n\n${outputSuggestion}` : ''}\n\n${formatCursorTaskNextStepMessage({ provider, id: normalizedAgentId })}`,
      });
    } catch (err) {
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor conversation fetch failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleCursorArtifacts(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const artifacts = await cursorBackendLane.getCursorFiles({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      const actionRecord = await getCursorAgentRecord(
        chatJid,
        normalizedAgentId,
      );
      const inlineActions = buildCursorCloudTaskActions(
        actionRecord?.targetUrl || null,
      );

      if (artifacts.length === 0) {
        await sendCursorAgentMessage({
          chatJid,
          agentId: normalizedAgentId,
          provider: 'cloud',
          sourceMessage,
          contextKind: 'cursor_job_message',
          inlineActions,
          text: `This task does not have results yet.\nTask: Cursor Cloud ${formatOpaqueTaskId(normalizedAgentId)}.\n\nView output first, then check Results again if you expect files from this task.`,
        });
        return;
      }

      const lines = artifacts.map(
        (artifact, index) =>
          `${index + 1}. ${artifact.absolutePath} (${artifact.sizeBytes ?? 'unknown'} bytes)${artifact.updatedAt ? ` updated=${artifact.updatedAt}` : ''}`,
      );

      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        payload: buildCursorTaskContextPayload({
          agentId: normalizedAgentId,
          provider: 'cloud',
          contextType: 'results',
          status: actionRecord?.status || null,
          summary: lines.slice(0, 3).join('\n'),
        }),
        jobStatus: actionRecord?.status || null,
        inlineActions,
        text: `Results for this task\nTask: Cursor Cloud ${formatOpaqueTaskId(normalizedAgentId)}\n\n${lines.join('\n')}\n\nReply to this result card with \`/cursor-download ABSOLUTE_PATH\` when you want one file. \`/cursor-download ${normalizedAgentId} ABSOLUTE_PATH\` still works anywhere as an explicit fallback.`,
      });
    } catch (err) {
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor results lookup failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleCursorArtifactLink(
    chatJid: string,
    requestedTarget: string | null,
    absolutePath: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const link = await cursorBackendLane.getDownloadLink({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        absolutePath,
      });
      const expiry = link.expiresAt ? `\nExpires: ${link.expiresAt}` : '';
      await sendCursorAgentMessage({
        chatJid,
        agentId: link.agentId,
        provider: 'cloud',
        sourceMessage,
        contextKind: 'cursor_job_message',
        text: `Download link for ${link.agentId}\nPath: ${link.absolutePath}\nURL: ${link.url}${expiry}`,
      });
    } catch (err) {
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor download failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminal(
    chatJid: string,
    requestedTarget: string | null,
    commandText: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const started = await cursorBackendLane.runTerminalCommand({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        commandText,
      });
      const lines = [
        `Andrea started desktop bridge terminal command ${started.commandId}.`,
        formatCursorTerminalStatusMessage(normalizedAgentId, started.terminal),
        'Recent output:',
        formatCursorTerminalOutputSection(started.output),
        'Reply to this card with `/cursor-terminal-status` or `/cursor-terminal-log` when you want the latest machine-side state.',
      ];
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        inlineActions: buildCursorTerminalCardActions(),
        text: lines.join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal command failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalStatus(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const terminal = await cursorBackendLane.getTerminalStatus({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        inlineActions: buildCursorTerminalCardActions(),
        text: formatCursorTerminalStatusMessage(normalizedAgentId, terminal),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal status failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalLog(
    chatJid: string,
    requestedTarget: string | null,
    limit: number,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const [terminal, output] = await Promise.all([
        cursorBackendLane.getTerminalStatus({
          handle: toCursorHandle(normalizedAgentId),
          groupFolder: group.folder,
          chatJid,
        }),
        cursorBackendLane.getTerminalOutput({
          handle: toCursorHandle(normalizedAgentId),
          groupFolder: group.folder,
          chatJid,
          limit,
        }),
      ]);
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        inlineActions: buildCursorTerminalCardActions(),
        text: [
          formatCursorTerminalStatusMessage(normalizedAgentId, terminal),
          'Recent output:',
          formatCursorTerminalOutputSection(output),
        ].join('\n\n'),
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal log failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorTerminalStop(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const terminal = await cursorBackendLane.stopTerminal({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      await sendCursorAgentMessage({
        chatJid,
        agentId: normalizedAgentId,
        provider: 'desktop',
        sourceMessage,
        contextKind: 'cursor_job_message',
        inlineActions: buildCursorTerminalCardActions(),
        text: `Stopped desktop bridge terminal command for ${normalizedAgentId}.\n\n${formatCursorTerminalStatusMessage(normalizedAgentId, terminal)}`,
      });
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatCursorOperationFailure(
          `Cursor terminal stop failed for ${normalizedAgentId}`,
          err,
        ),
        sourceMessage,
      );
    }
  }

  async function handleCursorSelect(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    await sendCursorSelectionCard(chatJid, normalizedAgentId, sourceMessage);
  }

  async function handleCursorTerminalHelp(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    await sendCursorAgentMessage({
      chatJid,
      agentId: normalizedAgentId,
      provider: 'desktop',
      sourceMessage,
      contextKind: 'cursor_job_message',
      inlineActions: buildCursorTerminalCardActions(),
      text: `Desktop bridge terminal control is available for ${formatOpaqueTaskId(normalizedAgentId)}.\n\nUse \`/cursor-terminal ${normalizedAgentId} <command>\` when you want Andrea to run a new machine-side command. Reply to this card with \`/cursor-terminal-status\` or \`/cursor-terminal-log\` when you want the latest state or output without retyping the id.`,
    });
  }

  function refreshCursorSnapshotsForAllGroups(): void {
    const cursorRows = getCursorAgentsSnapshot();
    for (const group of Object.values(registeredGroups)) {
      writeCursorAgentsSnapshot(
        group.folder,
        group.isMain === true,
        cursorRows,
      );
    }
  }

  async function handleCursorSync(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const synced = await cursorBackendLane.syncJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: synced.cursorJob.id,
        provider: synced.cursorJob.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: synced.cursorJob.id,
          provider: synced.cursorJob.provider,
          contextType: 'job_card',
          status: synced.cursorJob.status,
          summary:
            synced.cursorJob.summary ||
            synced.cursorJob.sourceRepository ||
            synced.cursorJob.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(synced.cursorJob),
        jobStatus: synced.cursorJob.status,
        text: [
          'Here is the latest state for this Cursor task.',
          '',
          formatCursorJobCard(
            synced.cursorJob,
            synced.cursorJob.provider === 'cloud' ? synced.artifacts.length : 0,
          ),
          '',
          formatCursorTaskNextStepMessage(synced.cursorJob),
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n\n'),
      });
    } catch (err) {
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor sync failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleCursorStop(
    chatJid: string,
    requestedTarget: string | null,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;

    try {
      const stopped = await cursorBackendLane.stopCursorJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: stopped.id,
        provider: stopped.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: stopped.id,
          provider: stopped.provider,
          contextType: 'job_card',
          status: stopped.status,
          summary:
            stopped.summary ||
            stopped.sourceRepository ||
            stopped.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(stopped),
        jobStatus: stopped.status,
        text: [
          'Andrea asked Cursor to stop this task.',
          '',
          formatCursorJobCard(stopped),
          '',
          formatCursorTaskNextStepMessage(stopped),
        ].join('\n'),
      });
    } catch (err) {
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor stop failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleCursorFollowup(
    chatJid: string,
    requestedTarget: string | null,
    promptText: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group) {
      await sendCursorMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        sourceMessage,
      );
      return;
    }

    const resolvedCursorTarget = await resolveCursorTargetOrReply({
      chatJid,
      message: sourceMessage,
      requestedTarget,
    });
    if (!resolvedCursorTarget) {
      return;
    }
    const normalizedAgentId = resolvedCursorTarget.agentId;
    const pilotRecord = startPilotJourney({
      ...resolveWorkCockpitPilotJourney({
        source: 'reply_followup',
        laneId: 'cursor',
      }),
      channel: 'telegram',
      groupFolder: group.folder,
      chatJid,
      threadId: sourceMessage?.thread_id || null,
      summaryText: `Cursor follow-up for ${labelCursorRecord(normalizedAgentId)}`,
    });

    try {
      const replyMessageContext = getActiveCursorMessageContext(
        chatJid,
        sourceMessage?.reply_to_id,
      );
      const canUseReplyContext =
        replyMessageContext?.agentId === normalizedAgentId &&
        !isDesktopCursorRecord(normalizedAgentId);
      if (canUseReplyContext) {
        const harmlessReply = maybeBuildHarmlessTaskReply(promptText);
        if (harmlessReply) {
          await sendCursorMessage(chatJid, harmlessReply, sourceMessage);
          if (pilotRecord) {
            completePilotJourney({
              eventId: pilotRecord.eventId,
              outcome: 'degraded_usable',
              blockerClass: 'work_cockpit_harmless_reply_short_circuit',
              blockerOwner: 'none',
              summaryText: harmlessReply,
            });
          }
          return;
        }
      }
      const normalizedPromptText = canUseReplyContext
        ? interpretTaskContinuation({
            laneId: 'cursor',
            rawPrompt: promptText,
            contextKind: getTaskContextType(replyMessageContext?.payload),
            messageContextPayload: replyMessageContext?.payload,
            taskId: normalizedAgentId,
            taskLabel: labelCursorRecord(normalizedAgentId),
          }).normalizedPromptText
        : promptText;
      const followed = await cursorBackendLane.followUpCursorJob({
        handle: toCursorHandle(normalizedAgentId),
        groupFolder: group.folder,
        chatJid,
        promptText: normalizedPromptText,
      });
      refreshCursorSnapshotsForAllGroups();
      await sendCursorAgentMessage({
        chatJid,
        agentId: followed.id,
        provider: followed.provider,
        sourceMessage,
        contextKind: 'cursor_job_card',
        payload: buildCursorTaskContextPayload({
          agentId: followed.id,
          provider: followed.provider,
          contextType: 'job_card',
          status: followed.status,
          summary:
            followed.summary ||
            followed.sourceRepository ||
            followed.promptText ||
            null,
        }),
        inlineActions: buildCursorJobCardActions(followed),
        jobStatus: followed.status,
        text: [
          'Andrea sent your next instruction to this Cursor task.',
          '',
          formatCursorJobCard(followed),
          '',
          formatCursorTaskNextStepMessage(followed),
        ]
          .filter((line): line is string => Boolean(line))
          .join('\n\n'),
      });
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'success',
          blockerOwner: 'none',
          currentWorkRef: followed.id,
          summaryText:
            followed.summary ||
            followed.promptText ||
            `Continued Cursor task ${formatOpaqueTaskId(followed.id)}.`,
        });
      }
    } catch (err) {
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'work_cockpit_cursor_followup_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'cursor follow-up failed',
        });
      }
      const clearedSelection = maybeClearCursorSelectionForCommandError({
        chatJid,
        threadId: sourceMessage?.thread_id,
        target: resolvedCursorTarget,
        err,
      });
      await sendCursorMessage(
        chatJid,
        formatCursorCommandFailure({
          prefix: `Cursor follow-up failed for ${normalizedAgentId}`,
          err,
          clearedSelection,
        }),
        sourceMessage,
      );
    }
  }

  async function handleAndreaRuntimeCommand(
    chatJid: string,
    rawTrimmed: string,
    commandToken: string,
    sourceMessage?: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        'This chat is not registered yet. Run /registermain in a DM first.',
        buildOperatorSendOptions(sourceMessage),
      );
      return;
    }
    const runtimeLane = getAndreaRuntimeLane();
    const replyMessageContext = getActiveCursorMessageContext(
      chatJid,
      sourceMessage?.reply_to_id,
    );
    const runtimePilotRecord =
      commandToken === '/runtime-followup'
        ? startPilotJourney({
            ...resolveWorkCockpitPilotJourney({
              source: 'reply_followup',
              laneId: 'andrea_runtime',
            }),
            channel: 'telegram',
            groupFolder: group.folder,
            chatJid,
            threadId: sourceMessage?.thread_id || null,
          })
        : null;

    try {
      await dispatchRuntimeCommand(
        {
        async sendToChat(targetChatJid, text, extra = {}) {
          const sent = await channel.sendMessage(
            targetChatJid,
            text,
            buildOperatorSendOptions(sourceMessage, extra),
          );
          return sent.platformMessageId;
        },
        async sendRuntimeJobMessage({
          operatorChatJid,
          text,
          jobId,
          contextKind,
          payload,
          inlineActions,
        }) {
          return sendBackendJobMessage({
            chatJid: operatorChatJid,
            text,
            laneId: 'andrea_runtime',
            jobId,
            sourceMessage,
            contextKind,
            payload,
            inlineActions,
          });
        },
        rememberRuntimeJobList({
          chatJid: targetChatJid,
          threadId,
          listMessageId,
          jobs,
        }) {
          rememberCursorJobList({
            chatJid: targetChatJid,
            threadId,
            listMessageId,
            items: jobs.map((job) => ({
              laneId: 'andrea_runtime',
              id: job.handle.jobId,
              provider: null,
            })),
            selectedLaneId: 'andrea_runtime',
          });
        },
        async getStatusMessage() {
          return buildAndreaRuntimeStatusMessage(group);
        },
        canExecute: andreaRuntimeExecutionEnabled,
        getExecutionDisabledMessage() {
          return buildAndreaRuntimeDisabledMessage();
        },
        async createJob({
          groupFolder,
          chatJid: targetChatJid,
          promptText,
          requestedBy,
        }) {
          return runtimeLane.createJob({
            groupFolder,
            chatJid: targetChatJid,
            promptText,
            requestedBy,
          });
        },
        getRuntimeJobs() {
          return queue.getRuntimeJobs();
        },
        async listJobs({ chatJid: targetChatJid, groupFolder, limit }) {
          return runtimeLane.listJobs({
            chatJid: targetChatJid,
            groupFolder,
            limit,
          });
        },
        resolveTarget({
          chatJid: targetChatJid,
          threadId,
          replyToMessageId,
          requestedTarget,
        }) {
          const resolved = resolveBackendTarget({
            chatJid: targetChatJid,
            threadId,
            replyToMessageId,
            requestedTarget,
            laneId: 'andrea_runtime',
            parseExplicitTarget(raw) {
              return /^runtime-job-/i.test(raw.trim()) ? raw.trim() : null;
            },
          });
          if (!resolved.target) {
            const legacySelection = getLegacyRuntimeSelection(
              targetChatJid,
              group.folder,
            );
            if (
              legacySelection &&
              (!requestedTarget || requestedTarget.trim().toLowerCase() === 'current')
            ) {
              rememberCursorOperatorSelection({
                chatJid: targetChatJid,
                threadId,
                laneId: 'andrea_runtime',
                agentId: legacySelection,
              });
              return {
                target: {
                  handle: { laneId: 'andrea_runtime', jobId: legacySelection },
                  jobId: legacySelection,
                  via: 'selected' as const,
                },
                failureMessage: null,
              };
            }
          }
          return resolved.target
            ? {
                target: {
                  handle: resolved.target.handle,
                  jobId: resolved.target.agentId,
                  via: resolved.target.via,
                },
                failureMessage: null,
              }
            : {
                target: null,
                failureMessage:
                  resolved.failureMessage ||
                  getBackendContextGuidance('andrea_runtime'),
              };
        },
        async refreshJob(args) {
          return runtimeLane.refreshJob(args);
        },
        async getPrimaryOutput(args) {
          return runtimeLane.getPrimaryOutput(args);
        },
        async getJobLogs(args) {
          return runtimeLane.getJobLogs(args);
        },
        async stopJob(args) {
          return runtimeLane.stopJob(args);
        },
        async followUpJob(args) {
          return runtimeLane.followUp(args);
        },
        async followUpLegacyGroup({
          groupFolder,
          chatJid: targetChatJid,
          promptText,
        }) {
          return followUpAndreaRuntimeLaneGroup({
            resolveGroupByFolder(folder) {
              const entry = Object.entries(registeredGroups).find(
                ([, candidate]) => candidate.folder === folder,
              );
              if (!entry) return null;
              const [jid, resolvedGroup] = entry;
              return { jid, group: resolvedGroup };
            },
            groupFolder,
            chatJid: targetChatJid,
            promptText,
            actorId: targetChatJid,
          });
        },
        findGroupByFolder(folder) {
          const entry = Object.entries(registeredGroups).find(
            ([, group]) => group.folder === folder,
          );
          if (!entry) return null;
          const [jid, group] = entry;
          return { jid, folder: group.folder };
        },
        requestStop(groupJid) {
          return queue.requestStop(groupJid);
        },
        formatFailure({ operation, err, targetDisplay, guidance }) {
          return formatBackendOperationFailure({
            laneId: 'andrea_runtime',
            operation,
            err,
            targetDisplay,
            guidance,
          });
        },
        clearCurrentSelection({ chatJid: targetChatJid, threadId }) {
          clearCurrentWorkSelection({
            chatJid: targetChatJid,
            threadId,
            laneId: 'andrea_runtime',
            source: 'shared',
          });
        },
        shouldClearSelectionForError(err) {
          return shouldClearRuntimeSelectionForError(err);
        },
        },
        {
          operatorChatJid: chatJid,
          groupFolder: group.folder,
          rawTrimmed,
          commandToken,
          threadId: sourceMessage?.thread_id,
          replyToMessageId: sourceMessage?.reply_to_id,
          replyMessageContext: replyMessageContext
            ? {
                agentId: replyMessageContext.agentId,
                contextKind: replyMessageContext.contextKind,
                payload: replyMessageContext.payload,
              }
            : null,
        },
      );
      if (runtimePilotRecord) {
        completePilotJourney({
          eventId: runtimePilotRecord.eventId,
          outcome: 'success',
          blockerOwner: 'none',
          summaryText:
            'Continued current work in the Codex/OpenAI runtime lane.',
        });
      }
    } catch (err) {
      if (runtimePilotRecord) {
        completePilotJourney({
          eventId: runtimePilotRecord.eventId,
          outcome: 'internal_failure',
          blockerClass: 'work_cockpit_runtime_followup_failed',
          blockerOwner: 'repo_side',
          summaryText:
            err instanceof Error ? err.message : 'runtime follow-up failed',
        });
      }
      throw err;
    }
  }

  // Channel callbacks (shared by all channels)
  const blueBubblesConfig = resolveBlueBubblesConfig();
  blueBubblesConversationBinding = {
    enabled: blueBubblesConfig.enabled,
    chatScope: blueBubblesConfig.chatScope,
    allowedChatGuids: blueBubblesConfig.allowedChatGuids,
    allowedChatGuid: blueBubblesConfig.allowedChatGuid,
    groupFolder: blueBubblesConfig.groupFolder,
  };
  const channelOpts = {
    onHealthUpdate: (snapshot: ChannelHealthSnapshot) => {
      channelHealthByName.set(snapshot.name, snapshot);
      writeCurrentAssistantHealth();
    },
    onCrossSurfaceFallback: async (params: {
      sourceChannel: 'bluebubbles';
      detail: string;
      chatJid: string | null;
    }) => {
      if (params.sourceChannel !== 'bluebubbles') {
        return {
          sent: false,
          detail: 'unsupported source channel',
        };
      }
      const mainTelegramEntry = Object.entries(registeredGroups).find(
        ([jid, group]) =>
          group.isMain === true && findChannel(channels, jid)?.name === 'telegram',
      );
      if (!mainTelegramEntry) {
        return {
          sent: false,
          detail: 'registered main Telegram chat is missing',
        };
      }
      const [telegramChatJid] = mainTelegramEntry;
      const telegramChannel = findChannel(channels, telegramChatJid);
      const telegramHealth = channelHealthByName.get('telegram');
      if (
        !telegramChannel ||
        telegramChannel.name !== 'telegram' ||
        !telegramChannel.isConnected()
      ) {
        return {
          sent: false,
          detail: 'telegram channel is not connected',
        };
      }
      if (telegramHealth?.state && telegramHealth.state !== 'ready') {
        return {
          sent: false,
          detail: `telegram health is ${telegramHealth.state}`,
        };
      }
      const notice =
        params.chatJid && params.detail.includes(params.chatJid)
          ? 'Messages looks unreliable right now, so use me here in Telegram for the moment. I am still tracking the issue on the phone side.'
          : 'Messages looks unreliable right now, so use me here in Telegram for the moment. I am still tracking the issue on the phone side.';
      try {
        await telegramChannel.sendMessage(telegramChatJid, notice);
        return {
          sent: true,
          detail: `sent fallback notice to ${telegramChatJid}`,
        };
      } catch (err) {
        logger.warn(
          { err, telegramChatJid, sourceChannel: params.sourceChannel },
          'Failed to send cross-surface fallback notice',
        );
        return {
          sent: false,
          detail: err instanceof Error ? err.message : 'fallback send failed',
        };
      }
    },
    onRoundtripActivity: (event: {
      kind: 'organic_success';
      chatJid: string;
      observedAt: string;
      detail: string;
    }) => {
      const group = registeredGroups[event.chatJid];
      if (!group || group.isMain !== true) return;
      try {
        recordOrganicTelegramRoundtripSuccess({
          detail: event.detail,
          target: event.chatJid,
          observedAt: event.observedAt,
        });
      } catch (err) {
        logger.warn(
          { err, chatJid: event.chatJid },
          'Failed to persist Telegram roundtrip success marker',
        );
      }
    },
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const rawTrimmed = msg.content.trim();
      const trimmed = rawTrimmed.toLowerCase();
      const isSlashCommand = rawTrimmed.startsWith('/');
      const rawCommandToken = trimmed.split(/\s+/)[0] || '';
      const commandToken = normalizeCommandToken(rawCommandToken);

      const allowlistCfg = loadSenderAllowlist();
      if (
        shouldDropIncomingMessageBeforeCommands(
          chatJid,
          msg,
          allowlistCfg,
          Boolean(registeredGroups[chatJid]),
        )
      ) {
        if (allowlistCfg.logDenied) {
          logger.debug(
            { chatJid, sender: msg.sender },
            'sender-allowlist: dropping message before command handling',
          );
        }
        return;
      }

      const responseFeedbackAction = parseResponseFeedbackAction(rawTrimmed);
      if (responseFeedbackAction) {
        handleResponseFeedbackAction(chatJid, msg, responseFeedbackAction).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Response feedback action error'),
        );
        return;
      }

      // Remote control commands — intercept before storage
      if (CURSOR_STATUS_COMMANDS.has(commandToken)) {
        handleCursorStatus(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor status command error'),
        );
        return;
      }

      const commandAccess = getCommandAccessDecision(
        commandToken,
        registeredGroups[chatJid],
      );
      if (!commandAccess.allowed) {
        const channel = findChannel(channels, chatJid);
        if (channel && commandAccess.message) {
          channel
            .sendMessage(
              chatJid,
              commandAccess.message,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid, commandToken },
                'Operator command gate reply failed',
              ),
            );
        }
        logger.info(
          {
            chatJid,
            commandToken,
            reason: commandAccess.reason,
            isMain: registeredGroups[chatJid]?.isMain === true,
          },
          'Blocked command outside allowed surface',
        );
        return;
      }

      const bundleCommand = parseBundleCommand(rawTrimmed);
      if (bundleCommand) {
        applyAndPresentActionBundle({
          chatJid,
          bundleId: bundleCommand.bundleId,
          operation: bundleCommand.operation,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Action bundle command error'),
        );
        return;
      }

      const messageActionCommand = parseMessageActionCommand(rawTrimmed);
      if (messageActionCommand) {
        applyAndPresentMessageAction({
          chatJid,
          messageActionId: messageActionCommand.messageActionId,
          operation: messageActionCommand.operation,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Message action command error'),
        );
        return;
      }

      const reviewCommand = parseReviewCommand(rawTrimmed);
      if (reviewCommand) {
        applyAndPresentOutcomeReviewControl({
          chatJid,
          outcomeId: reviewCommand.outcomeId,
          control: reviewCommand.control,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Outcome review command error'),
        );
        return;
      }

      const delegationRuleCommand = parseDelegationRuleCommand(rawTrimmed);
      if (delegationRuleCommand) {
        applyAndPresentDelegationRuleCommand({
          chatJid,
          command: delegationRuleCommand.command,
          targetId: delegationRuleCommand.targetId,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Delegation rule command error'),
        );
        return;
      }

      if (
        RUNTIME_CREATE_COMMANDS.has(commandToken) ||
        RUNTIME_JOB_COMMANDS.has(commandToken) ||
        RUNTIME_STATUS_COMMANDS.has(commandToken) ||
        RUNTIME_JOBS_COMMANDS.has(commandToken) ||
        RUNTIME_FOLLOWUP_COMMANDS.has(commandToken) ||
        RUNTIME_STOP_COMMANDS.has(commandToken) ||
        RUNTIME_LOGS_COMMANDS.has(commandToken)
      ) {
        handleAndreaRuntimeCommand(
          chatJid,
          rawTrimmed,
          commandToken,
          msg,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Andrea runtime command error'),
        );
        return;
      }

      if (DEBUG_STATUS_COMMANDS.has(commandToken)) {
        handleDebugStatus(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug status command error'),
        );
        return;
      }

      if (DEBUG_LEVEL_COMMANDS.has(commandToken)) {
        handleDebugLevel(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug level command error'),
        );
        return;
      }

      if (DEBUG_RESET_COMMANDS.has(commandToken)) {
        handleDebugReset(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug reset command error'),
        );
        return;
      }

      if (DEBUG_LOGS_COMMANDS.has(commandToken)) {
        handleDebugLogs(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Debug logs command error'),
        );
        return;
      }

      if (CURSOR_MODELS_COMMANDS.has(commandToken)) {
        const args = tokenizeCommandArguments(rawTrimmed);
        const filterText = args.slice(1).join(' ').trim();
        handleCursorModels(chatJid, filterText).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor models command error'),
        );
        return;
      }

      if (CURSOR_TEST_COMMANDS.has(commandToken)) {
        handleCursorSmokeTest(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor smoke command error'),
        );
        return;
      }

      if (CURSOR_DASHBOARD_COMMANDS.has(commandToken)) {
        handleCursorDashboard(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor dashboard command error'),
        );
        return;
      }

      if (
        registeredGroups[chatJid]?.isMain === true &&
        !isSlashCommand &&
        trimmed === 'current work'
      ) {
        handleCurrentWorkQuickOpen(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Current work quick-open error'),
        );
        return;
      }

      if (CURSOR_UI_COMMANDS.has(commandToken)) {
        handleCursorUi(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor dashboard UI command error'),
        );
        return;
      }

      if (CURSOR_SELECT_COMMANDS.has(commandToken)) {
        const { targetToken, args } = parseCursorCommandTarget(rawTrimmed);
        handleCursorSelect(chatJid, targetToken || args[1] || null, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor select command error'),
        );
        return;
      }

      if (CURSOR_JOBS_COMMANDS.has(commandToken)) {
        handleCursorJobs(chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor jobs command error'),
        );
        return;
      }

      if (CURSOR_CREATE_COMMANDS.has(commandToken)) {
        const parsed = parseCursorCreateCommand(rawTrimmed);
        if (parsed.errors.length > 0) {
          const channel = findChannel(channels, chatJid);
          const detail = parsed.errors.map((err) => `- ${err}`).join('\n');
          channel
            ?.sendMessage(
              chatJid,
              `${CURSOR_CREATE_USAGE}\n\n${detail}`,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error({ err, chatJid }, 'Cursor create usage send failed'),
            );
          return;
        }

        handleCursorCreate(
          chatJid,
          parsed.promptText,
          msg.sender,
          {
            model: parsed.model,
            sourceRepository: parsed.sourceRepository,
            sourceRef: parsed.sourceRef,
            sourcePrUrl: parsed.sourcePrUrl,
            branchName: parsed.branchName,
            autoCreatePr: parsed.autoCreatePr,
            openAsCursorGithubApp: parsed.openAsCursorGithubApp,
            skipReviewerRequest: parsed.skipReviewerRequest,
          },
          msg,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor create command error'),
        );
        return;
      }

      if (CURSOR_SYNC_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorSync(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor sync command error'),
        );
        return;
      }

      if (CURSOR_STOP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorStop(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor stop command error'),
        );
        return;
      }

      if (CURSOR_CONVERSATION_COMMANDS.has(commandToken)) {
        const { targetToken, limit } = parseCursorCommandTargetAndLimit(
          rawTrimmed,
          20,
          100,
        );
        handleCursorConversation(chatJid, targetToken, limit, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor conversation command error'),
        );
        return;
      }

      if (CURSOR_ARTIFACTS_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorArtifacts(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor artifacts command error'),
        );
        return;
      }

      if (CURSOR_ARTIFACT_LINK_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const absolutePath = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!absolutePath) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              CURSOR_DOWNLOAD_USAGE,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor artifact link usage send failed',
              ),
            );
          return;
        }

        handleCursorArtifactLink(chatJid, targetToken, absolutePath, msg).catch(
          (err) =>
            logger.error(
              { err, chatJid },
              'Cursor artifact link command error',
            ),
        );
        return;
      }

      if (CURSOR_TERMINAL_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const commandText = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!commandText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              CURSOR_TERMINAL_USAGE,
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor terminal usage send failed',
              ),
            );
          return;
        }

        handleCursorTerminal(chatJid, targetToken, commandText, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor terminal command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_HELP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalHelp(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal help command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STATUS_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalStatus(chatJid, targetToken, msg).catch((err) =>
          logger.error(
            { err, chatJid },
            'Cursor terminal status command error',
          ),
        );
        return;
      }

      if (CURSOR_TERMINAL_LOG_COMMANDS.has(commandToken)) {
        const { targetToken, limit } = parseCursorCommandTargetAndLimit(
          rawTrimmed,
          40,
          200,
        );
        handleCursorTerminalLog(chatJid, targetToken, limit, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal log command error'),
        );
        return;
      }

      if (CURSOR_TERMINAL_STOP_COMMANDS.has(commandToken)) {
        const { targetToken } = parseCursorCommandTarget(rawTrimmed);
        handleCursorTerminalStop(chatJid, targetToken, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor terminal stop command error'),
        );
        return;
      }

      if (CURSOR_FOLLOWUP_COMMANDS.has(commandToken)) {
        const { args, targetToken } = parseCursorCommandTarget(rawTrimmed);
        const promptText = args
          .slice(targetToken ? 2 : 1)
          .join(' ')
          .trim();
        if (!promptText) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /cursor-followup [AGENT_ID|LIST_NUMBER|current] TEXT',
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Cursor followup usage send failed',
              ),
            );
          return;
        }

        handleCursorFollowup(chatJid, targetToken, promptText, msg).catch(
          (err) =>
            logger.error({ err, chatJid }, 'Cursor followup command error'),
        );
        return;
      }

      if (AMAZON_STATUS_COMMANDS.has(commandToken)) {
        handleAmazonStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon status command error'),
        );
        return;
      }

      if (ALEXA_STATUS_COMMANDS.has(commandToken)) {
        handleAlexaStatus(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Alexa status command error'),
        );
        return;
      }

      if (AMAZON_SEARCH_COMMANDS.has(commandToken)) {
        const query = rawTrimmed.split(/\s+/).slice(1).join(' ').trim();
        if (!query) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /amazon-search <keywords>')
            .catch((err) =>
              logger.error({ err, chatJid }, 'Amazon search usage send failed'),
            );
          return;
        }

        handleAmazonSearch(chatJid, query).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon search command error'),
        );
        return;
      }

      if (PURCHASE_REQUEST_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const asin = parts[1];
        const offerId = parts[2];
        const parsedQuantity = Number.parseInt(parts[3] || '', 10);
        const quantity =
          Number.isFinite(parsedQuantity) && parsedQuantity > 0
            ? Math.min(999, parsedQuantity)
            : 1;

        if (!asin || !offerId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /purchase-request <asin> <offer_id> [quantity]',
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase request usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseRequest(
          chatJid,
          asin,
          offerId,
          quantity,
          msg.sender,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase request error'),
        );
        return;
      }

      if (PURCHASE_REQUESTS_COMMANDS.has(commandToken)) {
        handleAmazonPurchaseRequests(chatJid).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase list command error'),
        );
        return;
      }

      if (PURCHASE_APPROVE_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const requestId = parts[1];
        const approvalCode = parts[2];
        if (!requestId || !approvalCode) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Usage: /purchase-approve <request_id> <approval_code>',
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase approve usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseApprove(
          chatJid,
          requestId,
          approvalCode,
          msg.sender,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase approve error'),
        );
        return;
      }

      if (PURCHASE_CANCEL_COMMANDS.has(commandToken)) {
        const parts = rawTrimmed.split(/\s+/);
        const requestId = parts[1];
        if (!requestId) {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(chatJid, 'Usage: /purchase-cancel <request_id>')
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Amazon purchase cancel usage send failed',
              ),
            );
          return;
        }

        handleAmazonPurchaseCancel(chatJid, requestId).catch((err) =>
          logger.error({ err, chatJid }, 'Amazon purchase cancel error'),
        );
        return;
      }

      if (REMOTE_CONTROL_START_COMMANDS.has(commandToken)) {
        handleRemoteControl('start', chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      if (REMOTE_CONTROL_STOP_COMMANDS.has(commandToken)) {
        handleRemoteControl('stop', chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      try {
        if (await maybeHandleRuntimeReplyContext(chatJid, msg)) {
          return;
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Runtime reply-context routing error');
        return;
      }

      const repliedCursorDashboard =
        registeredGroups[chatJid]?.isMain === true &&
        !isSlashCommand &&
        rawTrimmed
          ? getCursorDashboardMessageContext(chatJid, msg.reply_to_id)
          : null;
      if (repliedCursorDashboard) {
        if (repliedCursorDashboard.state.kind === 'wizard_repo') {
          const normalizedRepo =
            rawTrimmed.trim().toLowerCase() === 'none'
              ? null
              : rawTrimmed.trim();
          openCursorDashboard({
            chatJid,
            sourceMessage: msg,
            state: {
              kind: 'wizard_prompt',
              wizard: {
                ...repliedCursorDashboard.state.wizard,
                sourceRepository: normalizedRepo,
              },
            },
          }).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor wizard repo reply error'),
          );
          return;
        }

        if (
          repliedCursorDashboard.state.kind === 'wizard_prompt' ||
          repliedCursorDashboard.state.kind === 'wizard_confirm'
        ) {
          openCursorDashboard({
            chatJid,
            sourceMessage: msg,
            state: {
              kind: 'wizard_confirm',
              wizard: {
                ...repliedCursorDashboard.state.wizard,
                promptText: rawTrimmed,
              },
            },
          }).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor wizard prompt reply error'),
          );
          return;
        }

        if (
          repliedCursorDashboard.state.kind === 'current' ||
          repliedCursorDashboard.state.kind === 'work_current'
        ) {
          if (!repliedCursorDashboard.agentId) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                repliedCursorDashboard.state.kind === 'work_current'
                  ? 'No current work is selected in this chat. Open `Jobs` or `Codex/OpenAI` -> `Recent Work`, then tap a task before replying here. Explicit ids and lane-specific slash commands still work if you want an explicit fallback.'
                  : 'No current task is selected in the Cursor lane. Open `Jobs`, then tap a task before replying here. Slash commands and raw ids still work if you want an explicit fallback.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Current dashboard empty guidance send failed',
                ),
              );
            return;
          }

          if (repliedCursorDashboard.laneId === 'andrea_runtime') {
            if (!andreaRuntimeExecutionEnabled) {
              const channel = findChannel(channels, chatJid);
              channel
                ?.sendMessage(
                  chatJid,
                  buildAndreaRuntimeDisabledMessage(),
                  buildOperatorSendOptions(msg),
                )
                .catch((err) =>
                  logger.error(
                    { err, chatJid },
                    'Current-work runtime disabled guidance send failed',
                  ),
                );
              return;
            }

            handleAndreaRuntimeCommand(
              chatJid,
              `/runtime-followup ${repliedCursorDashboard.agentId} ${rawTrimmed}`,
              '/runtime-followup',
              msg,
            ).catch((err) =>
              logger.error({ err, chatJid }, 'Current-work runtime followup error'),
            );
            return;
          }

          if (isDesktopCursorRecord(repliedCursorDashboard.agentId)) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                'Desktop sessions use `Refresh`, `View Output`, and `Terminal*` controls rather than plain-text continuation prompts.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Desktop dashboard followup guidance send failed',
                ),
              );
            return;
          }

          handleCursorFollowup(
            chatJid,
            repliedCursorDashboard.agentId,
            rawTrimmed,
            msg,
          ).catch((err) =>
            logger.error({ err, chatJid }, 'Cursor dashboard followup error'),
          );
          return;
        }

        if (repliedCursorDashboard.state.kind === 'runtime_current') {
          if (!repliedCursorDashboard.agentId) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                'No current task is selected in the Codex/OpenAI lane. Open `Codex/OpenAI` -> `Recent Work`, then tap a task before replying here. Slash commands still work if you want an explicit fallback.',
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Runtime current dashboard guidance send failed',
                ),
              );
            return;
          }

          if (!andreaRuntimeExecutionEnabled) {
            const channel = findChannel(channels, chatJid);
            channel
              ?.sendMessage(
                chatJid,
                buildAndreaRuntimeDisabledMessage(),
                buildOperatorSendOptions(msg),
              )
              .catch((err) =>
                logger.error(
                  { err, chatJid },
                  'Runtime current dashboard disabled guidance send failed',
                ),
              );
            return;
          }

          handleAndreaRuntimeCommand(
            chatJid,
            `/runtime-followup ${repliedCursorDashboard.agentId} ${rawTrimmed}`,
            '/runtime-followup',
            msg,
          ).catch((err) =>
            logger.error({ err, chatJid }, 'Runtime dashboard followup error'),
          );
          return;
        }
      }

      const rawRepliedMessageContext =
        registeredGroups[chatJid]?.isMain === true &&
        !isSlashCommand &&
        rawTrimmed
          ? getCursorMessageContext(chatJid, msg.reply_to_id || '')
          : null;
      const repliedMessageContext =
        rawRepliedMessageContext && msg.reply_to_id
          ? getActiveCursorMessageContext(chatJid, msg.reply_to_id)
          : null;
      const cursorReplyContext = resolveCursorReplyContext({
        replyMessageId: msg.reply_to_id,
        replyText: msg.reply_to?.content,
        contextMessageId: rawRepliedMessageContext?.platform_message_id,
        contextAgentId: rawRepliedMessageContext?.agent_id || null,
        contextCreatedAt: rawRepliedMessageContext?.created_at || null,
        nowIso: new Date().toISOString(),
      });
      if (
        cursorReplyContext.kind === 'missing' ||
        cursorReplyContext.kind === 'expired'
      ) {
        const channel = findChannel(channels, chatJid);
        channel
          ?.sendMessage(
            chatJid,
            buildCursorReplyContextMissingMessage(cursorReplyContext.provider),
            buildOperatorSendOptions(msg),
          )
          .catch((err) =>
            logger.error(
              { err, chatJid },
              'Cursor reply-context guidance send failed',
            ),
          );
        return;
      }

      if (chatJid.startsWith('bb:') && isSlashCommand) {
        const channel = findChannel(channels, chatJid);
        channel
          ?.sendMessage(
            chatJid,
            'This BlueBubbles thread is for companion help, not control commands. Ask me naturally here, and use Telegram for the admin side.',
          )
          .catch((err) =>
            logger.error({ err, chatJid }, 'BlueBubbles slash-command gate reply failed'),
          );
        return;
      }
      if (
        repliedMessageContext?.agentId &&
        repliedMessageContext.contextKind !== 'cursor_dashboard'
      ) {
        if (repliedMessageContext.laneId === 'andrea_runtime') {
          handleAndreaRuntimeCommand(
            chatJid,
            `/runtime-followup ${rawTrimmed}`,
            '/runtime-followup',
            msg,
          ).catch((err) =>
            logger.error(
              { err, chatJid },
              'Andrea runtime reply followup error',
            ),
          );
          return;
        }

        const provider =
          repliedMessageContext.payload?.provider === 'desktop' ||
          repliedMessageContext.payload?.provider === 'cloud'
            ? repliedMessageContext.payload.provider
            : isDesktopCursorRecord(repliedMessageContext.agentId)
              ? 'desktop'
              : 'cloud';

        if (provider === 'desktop') {
          const channel = findChannel(channels, chatJid);
          channel
            ?.sendMessage(
              chatJid,
              'Desktop sessions use /cursor-sync, /cursor-conversation, and /cursor-terminal* rather than plain-text continuation prompts.',
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Desktop reply-followup guidance send failed',
              ),
            );
          return;
        }

        handleCursorFollowup(chatJid, null, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Cursor reply followup error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      storeMessage(msg);
      if (chatJid.startsWith('bb:') && resolveCompanionBinding(chatJid)) {
        if (msg.timestamp > lastTimestamp) {
          lastTimestamp = msg.timestamp;
          saveState();
        }
        const hasRecentCompanionContext = Boolean(
          getSharedAssistantCapabilitySeed(chatJid, new Date()),
        );
        if (
          isBlueBubblesExplicitAsk(msg.content, {
            hasRecentCompanionContext,
          })
        ) {
          try {
            const primed = await primeBlueBubblesChatHistory(
              blueBubblesConfig,
              chatJid,
              12,
            );
            if (primed.storedCount > 0) {
              logger.debug(
                { chatJid, storedCount: primed.storedCount, totalCount: primed.totalCount },
                'Primed BlueBubbles recent chat history for an @Andrea mention',
              );
            }
          } catch (error) {
            logger.info(
              { err: error, chatJid },
              'BlueBubbles recent-history priming failed; continuing with stored local context',
            );
          }
          queue.enqueueMessageCheck(chatJid);
        } else {
          lastAgentTimestamp[chatJid] = msg.timestamp;
          saveState();
          logger.debug(
            { chatJid, messageId: msg.id },
            'Ignored BlueBubbles chatter without an @Andrea mention',
          );
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup);
      writeCurrentRuntimeAuditState();
    },
    registeredGroups: () => registeredGroups,
    onRegisterMainChat: bootstrapMainChatRegistration,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  resolveTelegramMainChatForAlexa = (groupFolder: string) => {
    const telegramEntries = Object.entries(registeredGroups).filter(([jid]) => {
      const channel = findChannel(channels, jid);
      return channel?.name === 'telegram';
    });
    const exactMain = telegramEntries.find(
      ([, group]) =>
        group.folder === groupFolder && (group.isMain === true || groupFolder === 'main'),
    );
    if (exactMain) {
      return { chatJid: exactMain[0] };
    }
    const exact = telegramEntries.find(([, group]) => group.folder === groupFolder);
    if (exact) {
      return { chatJid: exact[0] };
    }
    if (groupFolder === 'main') {
      const fallbackMain = telegramEntries.find(([, group]) => group.isMain === true);
      if (fallbackMain) {
        return { chatJid: fallbackMain[0] };
      }
    }
    return undefined;
  };
  resolveBlueBubblesCompanionChat = (groupFolder: string) => {
    if (!blueBubblesConfig.enabled) {
      return undefined;
    }
    const boundFolder = blueBubblesConfig.groupFolder || 'main';
    if (boundFolder !== groupFolder) {
      return undefined;
    }
    const recentChat = resolveMostRecentBlueBubblesCompanionChat({
      groupFolder,
      maxAgeHours: 12,
    });
    if (!recentChat?.chatJid) {
      return undefined;
    }
    const channel = findChannel(channels, recentChat.chatJid);
    if (channel?.name !== 'bluebubbles' || channel.isConnected() !== true) {
      return undefined;
    }
    return { chatJid: recentChat.chatJid };
  };
  resolveCompanionHandoffTarget = (
    groupFolder: string,
    targetChannel: 'telegram' | 'bluebubbles',
  ) =>
    targetChannel === 'bluebubbles'
      ? resolveBlueBubblesCompanionChat(groupFolder)
      : resolveTelegramMainChatForAlexa(groupFolder);
  sendCompanionHandoffMessageToChannel = async (chatJid, text, options) => {
    const channel = findChannel(channels, chatJid);
    if (!channel) {
      throw new Error(`No channel found for ${chatJid}`);
    }
    return channel.sendMessage(chatJid, text, options);
  };
  sendCompanionHandoffMessage = async (
    _targetChannel,
    chatJid,
    text,
    options,
  ) => sendCompanionHandoffMessageToChannel(chatJid, text, options);
  sendCompanionHandoffArtifactToChannel = async (
    chatJid,
    artifact,
    options,
  ) => {
    const channel = findChannel(channels, chatJid);
    if (!channel?.sendArtifact) {
      throw new Error(`Artifact delivery is unavailable for ${chatJid}`);
    }
    return channel.sendArtifact(chatJid, artifact, options);
  };
  sendCompanionHandoffArtifact = async (
    targetChannel,
    chatJid,
    artifact,
    options,
  ) => {
    if (targetChannel === 'bluebubbles') {
      throw new Error('BlueBubbles artifact delivery is unavailable.');
    }
    return sendCompanionHandoffArtifactToChannel(chatJid, artifact, options);
  };
  try {
    alexaRuntime = await startAlexaServer(undefined, {
      resolveHandoffTarget: resolveCompanionHandoffTarget,
      resolveTelegramMainChat: resolveTelegramMainChatForAlexa,
      resolveBlueBubblesCompanionChat,
      sendHandoffMessage: sendCompanionHandoffMessage,
      sendTelegramMessage: async (chatJid, text, options) => {
        return sendCompanionHandoffMessageToChannel(chatJid, text, options);
      },
      sendBlueBubblesMessage: async (chatJid, text, options) => {
        return sendCompanionHandoffMessageToChannel(chatJid, text, options);
      },
      sendHandoffArtifact: sendCompanionHandoffArtifact,
      sendTelegramArtifact: async (chatJid, artifact, options) => {
        return sendCompanionHandoffArtifactToChannel(chatJid, artifact, options);
      },
    });
  } catch (err) {
    logger.error({ err }, 'Alexa voice ingress failed to start');
  }

  const hasAlexaIngress = alexaRuntime?.getStatus().running === true;
  if (channels.length === 0 && !hasAlexaIngress) {
    logger.fatal('No channels connected and Alexa voice ingress is not running');
    process.exit(1);
  }
  if (channels.length === 0 && hasAlexaIngress) {
    logger.info('No chat channels connected; Alexa voice ingress is serving locally');
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getAgentThreads: () => agentThreads,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    sendToTarget: async (targetChannel, chatJid, text, options) =>
      sendCompanionHandoffMessage(targetChannel, chatJid, text, options),
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      await channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    onTasksChanged: () => refreshTaskSnapshots(registeredGroups),
    onMarketplaceChanged: () => {
      const skillRows = getEnabledOpenClawSkillsSnapshot();
      for (const group of Object.values(registeredGroups)) {
        writeOpenClawSkillsSnapshot(
          group.folder,
          group.isMain === true,
          skillRows,
        );
      }
    },
    onCursorChanged: () => {
      const cursorRows = getCursorAgentsSnapshot();
      for (const group of Object.values(registeredGroups)) {
        writeCursorAgentsSnapshot(
          group.folder,
          group.isMain === true,
          cursorRows,
        );
      }
    },
    enableOpenClawSkill,
    disableOpenClawSkill,
    installOpenClawSkill,
    searchAmazonProducts,
    createAmazonPurchaseRequest,
    approveAmazonPurchaseRequest,
    cancelAmazonPurchaseRequest,
  });
  const cursorRows = getCursorAgentsSnapshot();
  for (const group of Object.values(registeredGroups)) {
    writeCursorAgentsSnapshot(group.folder, group.isMain === true, cursorRows);
  }
  queue.setProcessMessagesFn(processGroupMessages);
  writeAssistantReadyState(appVersion);
  writeCurrentAssistantHealth();
  assistantHealthInterval = setInterval(() => {
    writeCurrentAssistantHealth();
  }, 30_000);
  assistantHealthInterval.unref?.();
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    stopAssistantHealthLoop();
    clearAssistantReadyState();
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
