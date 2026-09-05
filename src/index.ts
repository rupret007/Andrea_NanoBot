import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  classifyRuntimeRoute,
  selectPreferredRuntime,
} from './agent-runtime.js';
import {
  ASSISTANT_NAME,
  ASSISTANT_NAME_SOURCE,
  AGENT_RUNTIME_FALLBACK,
  ANDREA_USE_AGI,
  ANDREA_OPENAI_BACKEND_ENABLED,
  ANDREA_OPENAI_BACKEND_URL,
  ANDREA_PLATFORM_COORDINATOR_ENABLED,
  ANDREA_PLATFORM_COORDINATOR_URL,
  ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME,
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
  type AvailableGroup,
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
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  createCalendarAutomation,
  createTask,
  claimPendingActionableMessagesForChat,
  completeActionableIngressClaim,
  deleteAgentThread,
  deleteSession,
  deleteSessionStorageKey,
  deleteTask,
  getCursorMessageContext,
  deleteRuntimeBackendCardContext,
  deleteRuntimeBackendChatSelection,
  getAllAgentThreads,
  getAllChats,
  getTaskById,
  getAgentThread,
  getRegisteredMainChat,
  getResponseFeedback,
  getResponseFeedbackByMessage,
  getResponseFeedbackByRemediationJob,
  getVerifiedDeepWorkPacket,
  findFirstPendingActionableMessageForChat,
  listAllCursorAgents,
  listCalendarAutomationsForChat,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  ignorePendingActionableIngressMessage,
  listRecentMessagesForChat,
  listCursorAgentArtifacts,
  listRecentResponseFeedback,
  listPendingActionableMessagesForChats,
  claimPendingActionableMessagesThroughSequence,
  hasStoredMessage,
  getRouterState,
  getRuntimeBackendCardContext,
  getRuntimeBackendChatSelection,
  getRuntimeBackendJob,
  initDatabase,
  listAllEnabledCommunitySkills,
  pruneExpiredRuntimeBackendCardContexts,
  pruneUnreviewedBlueBubblesFeedbackLinks,
  releaseActionableIngressClaim,
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
import { buildDeepWorkReviewInvitation } from './deep-work-apprenticeship.js';
import { GroupQueue } from './group-queue.js';
import { logicalTurnSerializer } from './keyed-turn-serializer.js';
import { acquireRuntimeProcessLock } from './runtime-process-lock.js';
import {
  applyMessagingOutboundPauseCommand,
  captureMessagingOutboundAuthorizationFence,
  parseMessagingOutboundPauseCommand,
  resolveInboundMessagingOwnerAuthorizationAt,
  resolveQueuedMessagingOwnerAuthorizationAt,
} from './messaging-outbound-pause.js';
import {
  classifyChannelDelivery,
  requireCompleteChannelDelivery,
} from './channel-delivery.js';
import { deliverQueuedResponseWithIngressCommit } from './queued-response-delivery.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { prepareActionableIngressForStartupRecovery } from './startup-ingress-recovery.js';
import {
  BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
  BlueBubblesChannel,
  primeBlueBubblesChatHistory,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { startBlueBubblesControlServer } from './bluebubbles-control-server.js';
import { recordBlueBubblesOutboundDeliveryEvidence } from './bluebubbles-delivery-recovery.js';
import {
  applyBlueBubblesIngressPolicy,
  isBlueBubblesDataOnlyContactThread,
} from './bluebubbles-ingress-policy.js';
import { BlueBubblesReceiptInboxConsumer } from './bluebubbles-receipt-inbox-consumer.js';
import { BlueBubblesReceiptInboxStore } from './bluebubbles-receipt-inbox-store.js';
import { buildBlueBubblesIngressDispatchIdempotencyKey } from './bluebubbles-ingress-dispatch.js';
import { startOwnerCockpitServer } from './owner-cockpit-server.js';
import { planSimpleReminder } from './local-reminder.js';
import { persistReminderOperation } from './reminder-operation.js';
import {
  buildCalendarAssistantResponse,
  type CalendarSchedulingContext,
} from './calendar-assistant.js';
import { type SelectedWorkContext } from './daily-command-center.js';
import {
  buildDailyCompanionResponse,
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
  inferResearchCapabilityId,
  type AssistantCapabilityId,
  type AssistantCapabilityConversationSeed,
  type AssistantCapabilityResult,
} from './assistant-capabilities.js';
import { planCompoundCalendarResearchRequest } from './calendar-research-coordinator.js';
import { planCompoundReminderResearchRequest } from './reminder-research-coordinator.js';
import {
  deliverPrimaryThenStartReadOnlySidecar,
  drainBackgroundReadOnlySidecars,
} from './calendar-research-sequencing.js';
import { resolveExplicitResearchPersonalContextMode } from './research-orchestrator.js';
import { buildAndreaPlatformConfigSnapshots } from './assistant-profile-pack.js';
import { completeAssistantActionFromAlexa } from './assistant-action-completion.js';
import {
  continueAssistantCapabilityFromPriorSubjectData,
  matchAssistantCapabilityRequest,
} from './assistant-capability-router.js';
import { buildAssistantCapabilityExecutionInput } from './assistant-capability-input.js';
import {
  namedOpenLoopHistoryQuery,
  resolveNamedOpenLoopBinding,
} from './named-open-loop.js';
import { ALL_SYNCED_MESSAGES_TARGET } from './thread-summary-routing.js';
import {
  formatMessagesHistoryRefreshDisclosure,
  type MessagesHistoryRefreshDisclosureInput,
} from './messages-history-refresh-disclosure.js';
import {
  capturePilotIssue,
  completePilotJourney,
  type PilotJourneyCompleteParams,
  resolveCrossChannelPilotJourney,
  resolveGoalPlannerPilotJourney,
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
  assessBuildProvenance,
  requireVerifiedRuntimeBuild,
  resolveRuntimeArtifactContext,
} from './build-provenance.js';
import {
  emitAndreaPlatformDiagnosis,
  emitAndreaPlatformProofEvent,
  emitAndreaPlatformRepairApproval,
  emitAndreaPlatformRepairComplete,
  emitAndreaPlatformRepairDeployment,
  emitAndreaPlatformRepairEvidence,
  emitAndreaPlatformRepairExecution,
  emitAndreaPlatformRepairPlan,
  emitAndreaPlatformFeedbackReflection,
  emitAndreaPlatformShellConfigSnapshot,
  emitAndreaPlatformShellHealth,
  emitAndreaPlatformTraceEvent,
  emitAndreaPlatformTransportEvent,
  mapShellHealthFromChannelHealth,
} from './andrea-platform-bridge.js';
import {
  buildRepairVerificationBundle,
  collectRepairWorkerOutput,
  deriveRepairNextLegalAction,
  parseRepairApprovalScopeFromText,
  parseRepairWorkerResult,
  type RepairApprovalScope,
} from './repair-autopilot.js';
import {
  beginTurnAgentHarness,
  evaluateTurnReply,
  isSafeReadOnlyCalendarLookupAsk,
  reconcileTurnRuntimeEvidence,
  reflectTurnAgentOutcome,
  verifyTurnAgentAdaptiveCompletion,
  type PreSendEvaluation,
  type TurnAgentHarnessContext,
} from './turn-agent-harness.js';
import { formatGroundedDeliberationGuidance } from './grounded-response-intelligence.js';
import { TurnRuntimeEvidenceScope } from './turn-runtime-evidence-scope.js';
import {
  buildPendingPostDeliveryReflectionRefs,
  drainPostDeliveryReflections,
  reconcileInterruptedPostDeliveryReflections,
  schedulePostDeliveryReflection,
} from './post-delivery-reflection.js';
import {
  listCompanionConversationChatJids,
  resolveCompanionConversationBinding,
} from './companion-conversation-binding.js';
import {
  decideBlueBubblesCompanionIngress,
  isBlueBubblesProofDrillStartRequest,
  normalizeBlueBubblesCompanionPrompt,
  resolveBlueBubblesPendingLocalContinuationKind,
  resolveMostRecentBlueBubblesCompanionChat,
  shouldHandleBlueBubblesProofDrillLocally,
  shouldPreferBlueBubblesLocalMessageActionFollowup,
} from './bluebubbles-companion.js';
import {
  canonicalizeBlueBubblesSelfThreadJid,
  expandBlueBubblesLogicalSelfThreadJids,
  isBlueBubblesSelfThreadAliasJid,
  isConfiguredBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import { dispatchCapabilityApprenticeshipOwnerAction } from './capability-apprenticeship-chat.js';
import {
  dispatchActiveReleaseReadinessReuse,
  isReleaseReadinessActiveReuseRequest,
} from './release-readiness-active-reuse.js';
import { interpretBlueBubblesDirectTurn } from './messages-fluidity.js';
import { recordOrganicTelegramRoundtripSuccess } from './telegram-roundtrip.js';
import {
  collectProviderHealthSnapshots,
  formatProviderHealthAlertMessage,
  resolveSystemAlertConfig,
  shouldEmitProviderAlertSnapshot,
  type AlertEventSnapshot,
  type ProviderHealthSnapshot,
  type ProviderHealthState,
} from './provider-health.js';
import {
  refreshToolReliabilityFromCurrentTruth,
  resolveToolReliabilityRefreshIntervalMs,
} from './tool-reliability.js';
import {
  clearPendingBootAlert,
  readPendingBootAlert,
} from './startup-autostart.js';
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
  buildBlueBubblesProofDrillPresentationText,
  buildMessageActionPresentation,
  canApplyBlueBubblesMessageActionFollowup,
  canUseBareBlueBubblesMessageActionFollowup,
  ensureBlueBubblesSelfThreadMessageActionForReplyText,
  reconcileBlueBubblesMessageActionContinuity,
  reconcileBlueBubblesSelfThreadContinuity,
  findLatestChatMessageAction,
  isBlueBubblesExplicitSendAlias,
  isBlueBubblesProofDrillAction,
  isMessageActionBoundToPresentationMessage,
  isMessageActionBoundToPresentationSurface,
  interpretMessageActionFollowup,
  linkMessageActionCognitiveContext,
  reconcileBlueBubblesUnverifiedMessageActions,
  resolveBlueBubblesThreadTargetByName,
  resolveMessageActionForFollowup,
  startBlueBubblesProofDrill,
  type MessageActionOperation,
} from './message-actions.js';
import {
  doContextBoundRecipientLabelsMatch,
  executeBlueBubblesOutboundTurn,
} from './bluebubbles-outbound-turn.js';
import { resolveRefreshedContextBoundRecipient } from './context-bound-messages-history.js';
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
import {
  getCommunicationThread,
  getDelegationRule,
  getMessageAction,
  hasCommunicationSignal,
  updateDelegationRule,
  updateMessageAction,
} from './db.js';
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
  getGoogleCalendarCreateConfirmationActionId,
  getGoogleCalendarCreateIdempotencyKey,
  getPendingGoogleCalendarCreatedEvent,
  isExplicitGoogleCalendarCreateRequest,
  isGoogleCalendarSchedulingContextExpired,
  isPendingGoogleCalendarCreateExpired,
  planGoogleCalendarCreate,
  recordPendingGoogleCalendarCreateSuccess,
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
  buildSelfImprovementStatusText,
  isSelfImprovementStatusFollowupRequest,
  isSelfImprovementStatusRequest,
  isSelfImprovementStatusTask,
  planSelfImprovementStatusMonitor,
} from './self-improvement-status.js';
import {
  buildIntegrationDoctorReport,
  buildIntegrationFixGuidance,
  formatIntegrationDoctorReport,
  isIntegrationDoctorRequest,
  parseIntegrationFixTarget,
} from './integration-doctor.js';
import { runIntegrationRecoveryCommand } from './integration-recovery.js';
import {
  formatCouncilDoctorReport,
  buildCouncilDoctorReport,
  isCouncilDoctorRequest,
  recordCouncilOutcomeSignal,
} from './council-quality.js';
import {
  authorizeCognitiveReplyDelivery,
  buildCognitiveDoctorReport,
  formatCognitiveDoctorReport,
  isCognitionDoctorRequest,
  recordCognitiveOwnerReview,
  type CognitiveReplyKind,
} from './cognitive-kernel.js';
import type { AdaptiveEvidence } from './adaptive-cognition-engine.js';
import {
  adaptiveCompletionEvidenceFromVerifiedRuntime,
  resolveCognitiveDeliveryPayload,
} from './cognitive-runtime-completion.js';
import { buildAgentOSStatusText, isAgentOSNaturalRequest } from './agent-os.js';
import { buildLogicStatusText, isLogicNaturalRequest } from './logic-kernel.js';
import { buildTruthStatusText, isTruthNaturalRequest } from './truth-engine.js';
import {
  buildWorldModelStatusText,
  isWorldModelNaturalRequest,
} from './world-model.js';
import {
  buildRealityStatusText,
  formatRealityNaturalResponse,
  isRealityNaturalRequest,
} from './reality-grounding.js';
import {
  applyLearningControl,
  buildLearningDistillationReport,
  formatLearningDistillationReport,
  parseLearningDefaultRequest,
} from './memory-distillation.js';
import {
  applySkillControl,
  buildSkillLibraryReport,
  formatSkillLibraryReport,
} from './skill-library.js';
import {
  buildAgentRuntimeSpineStatusText,
  buildSupervisorStatusText,
  isAgentRuntimeSpineNaturalRequest,
  isSupervisorNaturalRequest,
  reconcileInterruptedAgentRuntimeRuns,
} from './agent-runtime-spine.js';
import {
  buildSessionGraphStatusText,
  isSessionGraphNaturalRequest,
} from './session-graph.js';
import {
  buildDurableContinuityReport,
  formatDurableContinuityForUser,
  isDurableContinuityNaturalRequest,
  reconcileDurableWorkOnStartup,
} from './durable-work-continuity.js';
import {
  buildAgencyConvergenceStatusText,
  isAgencyConvergenceNaturalRequest,
} from './agency-convergence-loop.js';
import {
  buildCognitiveWorkspaceStatusText,
  isCognitiveWorkspaceNaturalRequest,
} from './cognitive-workspace.js';
import {
  beginCognitiveExecutiveTurn,
  buildCognitiveExecutiveStatusText,
  finalizeCognitiveExecutiveTurn,
  formatLatestCognitiveExecutiveExplanation,
  isCognitiveExecutiveCandidate,
  isCognitiveExecutiveNaturalRequest,
} from './cognitive-executive.js';
import {
  buildGoalPlannerStatusText,
  formatGoalPlannerNaturalResponse,
  isGoalPlannerNaturalRequest,
} from './goal-planner.js';
import {
  formatMetacognitionNaturalResponse,
  isMetacognitionNaturalRequest,
} from './metacognition.js';
import {
  formatBlackboardNaturalResponse,
  isBlackboardNaturalRequest,
} from './cognitive-blackboard.js';
import {
  formatActionLifecycleNaturalResponse,
  isActionLifecycleNaturalRequest,
} from './action-lifecycle.js';
import {
  formatCapabilityNaturalResponse,
  isCapabilityNaturalRequest,
} from './capability-self-model.js';
import {
  formatEpisodeNaturalResponse,
  isEpisodeNaturalRequest,
} from './cognitive-episodes.js';
import {
  formatAutonomyNaturalResponse,
  isAutonomyNaturalRequest,
} from './autonomy-governor.js';
import {
  AgentRuntimeName,
  AgentThreadState,
  Channel,
  ChannelHealthSnapshot,
  MessageActionRecentTextReviewLink,
  MessageActionRecord,
  NewMessage,
  PilotBlockerOwner,
  PilotJourneyOutcome,
  RegisteredGroup,
  ResponseFeedbackRecord,
  SendMessageOptions,
  SendMessageResult,
  RuntimeBackendJob,
} from './types.js';
import { logger } from './logger.js';
import {
  assessChannelHealthAlert,
  decideChannelHealthAlert,
} from './channel-health-alert.js';
import { parseGitDirtyPaths } from './git-status-paths.js';
import { deliverCompanionHandoff } from './cross-channel-handoffs.js';
import {
  buildFieldTrialOperatorTruth,
  type FieldTrialBlueBubblesTruth,
  type FieldTrialOperatorTruth,
  type FieldTrialProofState,
  type FieldTrialSurfaceTruth,
} from './field-trial-readiness.js';
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
import {
  assistantCapabilityKey,
  classifyAssistantRequest,
  maybeBuildOpenClawPresenceReply,
} from './assistant-routing.js';
import { parseAssistantMessageActionIntent } from './assistant-action-intent.js';
import {
  buildRecentTextReviewOutcomeSignalId,
  formatRecentTextReviewFreshnessBlockedReply,
  parseRecentTextReviewItemFollowup,
  parseRecentTextReviewSeedJson,
  isBoundRecentTextReviewItemFollowup,
  recordRecentTextReviewOutcome,
  resolveRecentTextReviewFollowupTarget,
  validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh,
} from './recent-text-review.js';
import {
  resolveSharedAssistantOwnerContextScope,
  shouldRetainSharedAssistantCapabilitySeed,
} from './shared-assistant-context.js';
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
import { dispatchUnifiedJob } from './job-dispatch.js';
import { buildJobDispatchAdapters } from './job-dispatch-adapters.js';
import { parseUnifiedJobCommand } from './unified-job-command-parser.js';
import {
  formatUserFacingOperationFailure,
  getUserFacingErrorDetail,
  isUserFacingExternalDependencyDetail,
} from './user-facing-error.js';
import { resolveEffectiveIdleTimeout } from './runtime-timeout.js';
import {
  buildDirectAssistantRuntimeFailureReply,
  maybeBuildDirectQuickReply,
} from './direct-quick-reply.js';
import { routeCompanionTurnWithOpenAiBackend } from './openai-guided-routing.js';
import { recordOpenAiGuidedRoutingState } from './openai-guided-routing-state.js';
import {
  buildOpenClawMediaGroundedPrompt,
  buildOpenClawChatSessionKey,
  delegateToOpenClawAgent,
  formatOpenClawDelegationResponse,
  isOpenClawDelegationEnabled,
  isOpenClawOwnerControlSurface,
  resolveOpenClawDelegationRoute,
  type OpenClawDelegationCommand,
} from './openclaw-connector.js';
import { analyzeMessageMedia } from './media-analysis.js';
import { buildDirectAssistantContinuationPrompt } from './direct-assistant-continuation.js';
import {
  getSuppressedDeadSessionRuntimeEvidence,
  getAssistantSessionStorageKey,
  isDeadAssistantSessionErrorText,
} from './assistant-session.js';
import {
  decideMainChatRouting,
  shouldAvoidCombinedContextForMainChat,
  type MainChatSessionState,
} from './main-chat-routing.js';
import {
  buildSilentSuccessFallback,
  maybeShieldProtectedAssistantOutput,
} from './user-facing-fallback.js';
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
  buildCursorDashboardRuntimeCurrentUnavailable,
  buildCursorDashboardRuntimeJobs,
  buildCursorDashboardRuntimeJobsUnavailable,
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
  createWorkCockpitReadGuard,
  createWorkCockpitPresentationQueue,
  reconcileWorkCockpitCurrentSelection,
  resolveRuntimeDashboardJobId,
  shouldClearStaleWorkCockpitSelection,
} from './work-cockpit-targets.js';
import {
  getRuntimeWorkRecoveryReply,
  resolveRuntimeWorkRecovery,
  type RuntimeWorkRecovery,
} from './work-cockpit-recovery.js';
import {
  buildTaskOutputSuggestion,
  getTaskContextType,
  interpretTaskContinuation,
  maybeBuildHarmlessTaskReply,
  mergeTaskMessageContextPayload,
  summarizeVisibleTaskText,
  type TaskContextType,
} from './task-continuation.js';
import { ANDREA_OPENAI_BACKEND_ID } from './andrea-openai-backend.js';
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
  computeRuntimeCardContextExpiry,
  resolveRuntimeReplyContext,
} from './runtime-chat-context.js';
import { deliverRuntimeCardNotification } from './runtime-card-delivery.js';
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
  INTEGRATION_RECOVERY_COMMANDS,
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
  UNIFIED_JOB_COMMANDS,
} from './operator-command-gate.js';
import {
  appendResponseFeedbackActionRows,
  appendResponseFeedbackInlineRow,
  buildResponseFeedbackReviewQueue,
  buildResponseFeedbackActionRows,
  buildResponseFeedbackCaptureReply,
  buildResponseFeedbackRemediationPrompt,
  buildResponseFeedbackWhyText,
  classifyResponseFeedbackCandidate,
  mapMessageReactionToFeedbackAction,
  isResponseFeedbackReviewQueueRequest,
  parseResponseFeedbackAction,
  refreshRecentResponseFeedbackTruth,
  resolveNaturalResponseFeedbackVerdict,
  resolvePendingResponseFeedbackApproval,
  type ResponseFeedbackLaneSelection,
  selectResponseFeedbackRetryLane,
  shouldCancelPendingContinuationForFeedback,
  shouldPreferLocalResponseFeedbackReview,
} from './response-feedback.js';
import { reconcileAdaptiveOwnerFeedbackByTurn } from './adaptive-grounded-intelligence-durable-adapter.js';
import {
  buildReviewedOutcomeProgress,
  createRegressionFixtureFromFeedback,
  formatReviewedOutcomeProgress,
  recordMemoryRetrievalJudgment,
  recordReviewedRecommendationOutcome,
} from './personal-assistant-metrics.js';
import {
  captureHostPressureSnapshot,
  CommittedIncompleteDeliveryError,
  deliverAssistantReplyWithMetric,
  isCommittedIncompleteDeliveryError,
  resolveInteractionTurnStartedAtMs,
  runPostDeliveryEnrichment,
  type InteractionLatencyTargetClass,
} from './interaction-delivery-metrics.js';
import {
  InFlightTurnCursorRegistry,
  runQueuedTurnWithCursorRecovery,
} from './in-flight-turn-cursors.js';
import {
  auditRegisteredMainChat,
  type RegisteredMainChatRecord,
} from './main-chat-audit.js';
import { bootstrapAgi } from './agi-bootstrap.js';
import type { AgiRuntime } from './agi-runtime.js';
import { registerProductionRuntimeCapabilitySurfaces } from './runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from './runtime-capability-registry.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let sessions: Record<string, string> = {};
let agentThreads: Record<string, AgentThreadState> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// Chats with a turn currently being processed, mapped to the cursor value
// from before that turn advanced it. Shutdown rolls these back so an
// in-flight turn is re-fetched after restart instead of dropped silently.
const inFlightCursorRollbacks = new InFlightTurnCursorRegistry();
let messageLoopRunning = false;
const NON_RETRIABLE_ERROR_NOTIFY_COOLDOWN_MS = 15 * 60 * 1000;
const lastNonRetriableErrorNotice: Record<
  string,
  { code: string; at: number }
> = {};
const lastDirectAssistantTextByChatJid: Record<string, string> = {};

function resolveLatestEligibleLocalMessagesTimestamp(
  targetChatJid?: string | null,
): string | null {
  const chatJids = targetChatJid
    ? [targetChatJid]
    : getAllChats()
        .filter(
          (chat) =>
            chat.channel === 'bluebubbles' &&
            chat.jid.startsWith('bb:') &&
            !isConfiguredBlueBubblesSelfThreadAliasJid(chat.jid),
        )
        .map((chat) => chat.jid);
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidateChatJid of chatJids) {
    if (
      !candidateChatJid.startsWith('bb:') ||
      isConfiguredBlueBubblesSelfThreadAliasJid(candidateChatJid)
    ) {
      continue;
    }
    const message = listRecentMessagesForChat(candidateChatJid, 8).find(
      (candidate) => !candidate.is_bot_message,
    );
    if (!message) continue;
    const timestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(timestampMs) || timestampMs <= latestMs) continue;
    latestMs = timestampMs;
    latest = message.timestamp;
  }
  return latest;
}
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
const ACTION_LAYER_PENDING_REMINDER_COLLECTION_PREFIX =
  'action_layer_pending_reminder_collection:';
const ACTION_LAYER_PENDING_DRAFT_PREFIX = 'action_layer_pending_draft:';
const DAILY_COMPANION_CONTEXT_PREFIX = 'daily_companion_context:';
const DAILY_COMPANION_CONTEXT_TTL_MS = 10 * 60 * 1000;
const SHARED_ASSISTANT_CONTEXT_PREFIX = 'shared_assistant_context:';
const OUTCOME_REVIEW_CONTEXT_PREFIX = 'outcome_review_context:';
const OUTCOME_REVIEW_CONTEXT_TTL_MS = 30 * 60 * 1000;
const DELEGATION_RULE_CONTEXT_PREFIX = 'delegation_rule_context:';
let agiRuntime: AgiRuntime | null = null;
let agiRuntimeInitFailed = false;
let agiRuntimeLastInitFailedAt = 0;
const AGI_RUNTIME_BOOT_RETRY_MS = 60_000;
const AGI_PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const pendingAgiConfirmationsById = new Map<
  string,
  { chatJid: string; scope: string; sender: string; createdAt: number }
>();

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

function getActionLayerPendingReminderCollectionKey(chatJid: string): string {
  return `${ACTION_LAYER_PENDING_REMINDER_COLLECTION_PREFIX}${chatJid}`;
}

function getActionLayerPendingDraftKey(chatJid: string): string {
  return `${ACTION_LAYER_PENDING_DRAFT_PREFIX}${chatJid}`;
}

function getDailyCompanionContextKey(chatJid: string): string {
  return `${DAILY_COMPANION_CONTEXT_PREFIX}${chatJid}`;
}

function getSharedAssistantContextKey(chatJid: string): string | null {
  const scope = resolveSharedAssistantOwnerContextScope({
    chatJid,
    registeredGroups,
    blueBubblesEnabled: blueBubblesConversationBinding?.enabled,
    blueBubblesGroupFolder: blueBubblesConversationBinding?.groupFolder,
  });
  return scope
    ? `${SHARED_ASSISTANT_CONTEXT_PREFIX}${scope.storageKeySuffix}`
    : null;
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

const ACTIVE_RUNTIME_ARTIFACT = resolveRuntimeArtifactContext(
  import.meta.url,
  'index.js',
);
const ACTIVE_REPO_ROOT = ACTIVE_RUNTIME_ARTIFACT.projectRoot;
const ACTIVE_ENTRY_PATH = ACTIVE_RUNTIME_ARTIFACT.modulePath;
const ACTIVE_ENV_PATH = path.resolve(ACTIVE_REPO_ROOT, '.env');
const ACTIVE_STORE_DB_PATH = path.join(STORE_DIR, 'messages.db');
const ACTIVE_RUNTIME_PROCESS_LOCK_PATH = path.join(
  RUNTIME_STATE_DIR,
  'andrea-runtime-process.lock',
);
const ACTIVE_GIT_BRANCH = readGitRef(['rev-parse', '--abbrev-ref', 'HEAD']);
const ACTIVE_GIT_COMMIT = readGitRef(['rev-parse', 'HEAD']);
const ACTIVE_BUILD_PROVENANCE = assessBuildProvenance({
  projectRoot: ACTIVE_REPO_ROOT,
  expectedGitCommit: ACTIVE_GIT_COMMIT,
});

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

function listCurrentGitDirtyPaths(): string[] {
  try {
    const output = execFileSync(
      'git',
      ['-C', ACTIVE_REPO_ROOT, 'status', '--porcelain'],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    if (!output.trim()) return [];
    return parseGitDirtyPaths(output);
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

function buildResponseFeedbackFailureNote(
  taskStatus: string | null | undefined,
): string {
  const normalized = normalizeTaskStatus(taskStatus);
  switch (normalized) {
    case 'cancelled':
    case 'canceled':
      return 'The remediation task was cancelled before it produced a clean local hotfix, so it is back in review.';
    case 'stopped':
      return 'The remediation task was stopped before it produced a clean local hotfix, so it is back in review.';
    case 'error':
      return 'The remediation task hit an execution error before it produced a clean local hotfix, so it is back in review.';
    case 'failed':
    default:
      return 'The remediation task failed before it produced a clean local hotfix, so it is back in review.';
  }
}

function buildResponseFeedbackNoHotfixNote(): string {
  return 'The remediation task finished, but I do not see a new local hotfix on this host yet, so it is back in review.';
}

function buildResponseFeedbackReadOnlyLaneNote(): string {
  return 'The remediation task finished, but the Codex/OpenAI runtime lane is read-only on this host, so there is no local hotfix to land yet.';
}

function hasResponseFeedbackLocalHotfix(
  record: Pick<ResponseFeedbackRecord, 'linkedRefs'>,
): boolean {
  const baseline = new Set(record.linkedRefs?.repoDirtyPathsAtStart || []);
  return listCurrentGitDirtyPaths().some((path) => !baseline.has(path));
}

function mapResponseFeedbackRuntimePreferenceToAgentRuntime(
  runtimePreference: ResponseFeedbackRecord['remediationRuntimePreference'],
): AgentRuntimeName | null {
  switch (runtimePreference) {
    case 'codex_local':
      return 'codex_local';
    case 'codex_cloud':
      return 'openai_cloud';
    default:
      return null;
  }
}

function isCurrentWorkQuickOpenPhrase(trimmed: string): boolean {
  const normalized = trimmed
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return (
    normalized === 'current work' ||
    normalized === "show me what's running" ||
    normalized === 'show me whats running' ||
    normalized === "show me what's running right now" ||
    normalized === 'show me whats running right now' ||
    normalized === "what's on deck for my repos" ||
    normalized === 'whats on deck for my repos' ||
    normalized === 'show me a repo standup' ||
    normalized === "what's running" ||
    normalized === 'whats running' ||
    normalized === 'what work is active right now' ||
    normalized === 'open the current task again' ||
    normalized === "what's the latest from runtime" ||
    normalized === 'whats the latest from runtime'
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

function getResolvedMainChatDisplayName(): string {
  const registeredMainChat =
    (getRegisteredMainChat() as
      | (RegisteredMainChatRecord & { jid: string })
      | undefined) || null;
  if (!registeredMainChat) {
    return 'No main control chat is currently registered.';
  }

  return `${registeredMainChat.name || 'Main'} (${registeredMainChat.jid})`;
}

function buildMainChatBlockedMessage(
  context = 'advanced operator workflows',
): string {
  const details = getResolvedMainChatDisplayName();
  const actionContext = context ? ` for ${context}` : '';
  return [
    `This chat is not set up yet${actionContext}.`,
    `Andrea can only run these features in the registered main control chat.`,
    details,
    'Run `/mainchat` for the exact current status and recovery steps.',
    'If this is your control chat, send `/registermain` here to bind it.',
  ].join('\n');
}

function buildMainChatSummaryLine(
  mainChatJid: string,
  mainChat: RegisteredGroup,
): string {
  return `${mainChat.name || 'Main'} (${mainChatJid})`;
}

function writeCurrentRuntimeAuditState(warningOverride?: string | null): void {
  const audit = getCurrentMainChatAudit();
  try {
    writeRuntimeAuditState({
      updatedAt: new Date().toISOString(),
      activeRepoRoot: ACTIVE_REPO_ROOT,
      activeGitBranch: ACTIVE_GIT_BRANCH,
      activeGitCommit: ACTIVE_GIT_COMMIT,
      activeBuildProvenanceState: ACTIVE_BUILD_PROVENANCE.state,
      activeBuildGitCommit: ACTIVE_BUILD_PROVENANCE.manifest?.gitCommit || null,
      activeBuildGitDirtyPathCount:
        ACTIVE_BUILD_PROVENANCE.manifest?.gitDirtyPathCount ?? null,
      activeBuildArtifactVerified: ACTIVE_BUILD_PROVENANCE.artifactVerified,
      activeBuildAt: ACTIVE_BUILD_PROVENANCE.manifest?.builtAt || null,
      activeEntryPath: ACTIVE_ENTRY_PATH,
      activeEnvPath: ACTIVE_ENV_PATH,
      activeStoreDbPath: ACTIVE_STORE_DB_PATH,
      activeRuntimeStateDir: RUNTIME_STATE_DIR,
      assistantName: ASSISTANT_NAME,
      assistantNameSource: ASSISTANT_NAME_SOURCE,
      registeredMainChatJid: audit.registeredMainChat?.jid || null,
      registeredMainChatName: audit.registeredMainChat?.name || null,
      registeredMainChatFolder: audit.registeredMainChat?.folder || null,
      registeredMainChatPresentInChats: audit.registeredMainChatPresentInChats,
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

interface PendingActionReminderCollection {
  version: 1;
  states: PendingActionReminderState[];
}

function getPendingActionReminderStates(
  chatJid: string,
): PendingActionReminderState[] {
  const collectionRaw = getRouterState(
    getActionLayerPendingReminderCollectionKey(chatJid),
  );
  if (collectionRaw) {
    try {
      const parsed = JSON.parse(
        collectionRaw,
      ) as PendingActionReminderCollection;
      if (
        parsed?.version === 1 &&
        Array.isArray(parsed.states) &&
        parsed.states.every((state) => state?.version === 1 && state.label)
      ) {
        return parsed.states;
      }
    } catch {
      // Fall back to the legacy single-state record below.
    }
  }
  const raw = getRouterState(getActionLayerPendingReminderKey(chatJid));
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as PendingActionReminderState;
    if (!parsed || parsed.version !== 1 || !parsed.label) {
      return [];
    }
    return [parsed];
  } catch {
    return [];
  }
}

function getPendingActionReminderState(
  chatJid: string,
): PendingActionReminderState | null {
  return getPendingActionReminderStates(chatJid).at(-1) || null;
}

function writePendingActionReminderStates(
  chatJid: string,
  states: PendingActionReminderState[],
): void {
  if (states.length === 0) {
    deleteRouterState(getActionLayerPendingReminderKey(chatJid));
    deleteRouterState(getActionLayerPendingReminderCollectionKey(chatJid));
    return;
  }
  if (states.length === 1) {
    setRouterState(
      getActionLayerPendingReminderKey(chatJid),
      JSON.stringify(states[0]),
    );
    deleteRouterState(getActionLayerPendingReminderCollectionKey(chatJid));
    return;
  }
  setRouterState(
    getActionLayerPendingReminderCollectionKey(chatJid),
    JSON.stringify({ version: 1, states }),
  );
  deleteRouterState(getActionLayerPendingReminderKey(chatJid));
}

function setPendingActionReminderState(
  chatJid: string,
  state: PendingActionReminderState,
): void {
  const states = getPendingActionReminderStates(chatJid);
  const existingIndex = states.findIndex(
    (candidate) => candidate.createdAt === state.createdAt,
  );
  if (existingIndex >= 0) states[existingIndex] = state;
  else states.push(state);
  writePendingActionReminderStates(chatJid, states);
}

function clearPendingActionReminderState(
  chatJid: string,
  state?: PendingActionReminderState,
): void {
  if (!state) {
    writePendingActionReminderStates(chatJid, []);
    return;
  }
  writePendingActionReminderStates(
    chatJid,
    getPendingActionReminderStates(chatJid).filter(
      (candidate) => candidate.createdAt !== state.createdAt,
    ),
  );
}

export function resolvePendingActionReminderContinuation(
  states: PendingActionReminderState[],
  message: string,
): { state: PendingActionReminderState; timingText: string } | null {
  const match = message.match(/^\s*(.+?)\s*:\s*(.+?)\s*[.?!]*$/);
  if (!match) return null;
  const target = match[1]!.trim().toLowerCase().replace(/\s+/g, ' ');
  const timingText = match[2]!.trim();
  if (!target || !timingText) return null;
  const matches = states.filter((state) => {
    const label = state.label.toLowerCase().replace(/\s+/g, ' ');
    return label === target || label.includes(target) || target.includes(label);
  });
  return matches.length === 1 ? { state: matches[0]!, timingText } : null;
}

export function formatPendingActionReminderDisambiguation(
  states: PendingActionReminderState[],
): string {
  const labels = states.slice(0, 3).map((state) => `“${state.label}”`);
  return `I still need a time for ${labels.join(' and ')}. Tell me which one and when, for example: “${states[0]!.label}: Friday afternoon.”`;
}

interface ReminderResearchReceipt {
  version: 1;
  status: 'running' | 'completed' | 'failed';
  updatedAt: string;
}

interface ReminderResearchOperationState {
  version: 1;
  taskId: string;
  reminderStatus: 'persisted' | 'confirmation_delivered';
  researchStatus: 'not_started' | ReminderResearchReceipt['status'];
  updatedAt: string;
}

function getReminderResearchOperationKey(chatJid: string): string {
  return `reminder-research-operation:${chatJid}`;
}

function getReminderResearchOperation(
  chatJid: string,
): ReminderResearchOperationState | null {
  const raw = getRouterState(getReminderResearchOperationKey(chatJid));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReminderResearchOperationState;
    return parsed?.version === 1 && parsed.taskId && parsed.reminderStatus
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function setReminderResearchOperation(
  chatJid: string,
  state: Omit<ReminderResearchOperationState, 'version' | 'updatedAt'>,
  now: Date,
): void {
  setRouterState(
    getReminderResearchOperationKey(chatJid),
    JSON.stringify({ ...state, version: 1, updatedAt: now.toISOString() }),
  );
}

function isReminderResearchStatusPrompt(text: string): boolean {
  return /^(?:what happened with that|what happened|status(?: of that)?|did (?:that|the research) (?:finish|work)|where (?:are|is) (?:we|that))(?:[?.! ]*)$/i.test(
    text.trim(),
  );
}

function formatReminderResearchStatus(
  state: ReminderResearchOperationState,
): string {
  const task = getTaskById(state.taskId);
  const reminder = task
    ? state.reminderStatus === 'confirmation_delivered'
      ? 'The reminder is saved and its confirmation was delivered.'
      : 'The reminder is saved; its earlier confirmation may not have reached you.'
    : 'I cannot verify the reminder record now, so I will not recreate it automatically.';
  const research =
    state.researchStatus === 'completed'
      ? 'Research completed separately.'
      : state.researchStatus === 'failed'
        ? 'Research did not finish cleanly; ask me to retry it if you want a fresh read-only run.'
        : state.researchStatus === 'running'
          ? 'Research was started and may have been interrupted before its result was delivered; I will not replay it automatically.'
          : 'Research had not started yet.';
  return `${reminder} ${research}`;
}

function getReminderResearchReceiptKey(
  chatJid: string,
  taskId: string,
): string {
  return `reminder-research:${chatJid}:${taskId}`;
}

function getReminderResearchReceipt(
  chatJid: string,
  taskId: string,
): ReminderResearchReceipt | null {
  const raw = getRouterState(getReminderResearchReceiptKey(chatJid, taskId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReminderResearchReceipt;
    return parsed?.version === 1 &&
      ['running', 'completed', 'failed'].includes(parsed.status)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function setReminderResearchReceipt(
  chatJid: string,
  taskId: string,
  status: ReminderResearchReceipt['status'],
  now: Date,
): void {
  setRouterState(
    getReminderResearchReceiptKey(chatJid, taskId),
    JSON.stringify({ version: 1, status, updatedAt: now.toISOString() }),
  );
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

function getPendingBlueBubblesLocalContinuationKind(
  chatJid: string,
  now = new Date(),
) {
  return resolveBlueBubblesPendingLocalContinuationKind({
    chatJid,
    hasGoogleCalendarCreate: (candidateChatJid) => {
      const pendingState =
        getPendingGoogleCalendarCreateState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingGoogleCalendarCreateExpired(pendingState, now)) {
        clearPendingGoogleCalendarCreateState(candidateChatJid);
        return false;
      }
      return true;
    },
    hasGoogleCalendarReminder: (candidateChatJid) => {
      const pendingState = getPendingCalendarReminderState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingCalendarReminderExpired(pendingState, now)) {
        clearPendingCalendarReminderState(candidateChatJid);
        return false;
      }
      return true;
    },
    hasGoogleCalendarEventAction: (candidateChatJid) => {
      const pendingState =
        getPendingGoogleCalendarEventActionState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingGoogleCalendarEventActionExpired(pendingState, now)) {
        clearPendingGoogleCalendarEventActionState(candidateChatJid);
        return false;
      }
      return true;
    },
    hasCalendarAutomation: (candidateChatJid) => {
      const pendingState = getPendingCalendarAutomationState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingCalendarAutomationExpired(pendingState, now)) {
        clearPendingCalendarAutomationState(candidateChatJid);
        return false;
      }
      return true;
    },
    hasActionReminder: (candidateChatJid) => {
      const pendingState = getPendingActionReminderState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingActionReminderExpired(pendingState, now)) {
        clearPendingActionReminderState(candidateChatJid);
        return false;
      }
      return true;
    },
    hasActionDraft: (candidateChatJid) => {
      const pendingState = getPendingActionDraftState(candidateChatJid);
      if (!pendingState) return false;
      if (isPendingActionDraftExpired(pendingState, now)) {
        clearPendingActionDraftState(candidateChatJid);
        return false;
      }
      return true;
    },
  });
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
  const contextKey = getSharedAssistantContextKey(chatJid);
  if (!contextKey) return null;
  const raw = getRouterState(contextKey);
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
      deleteRouterState(contextKey);
      return null;
    }

    if (
      !shouldRetainSharedAssistantCapabilitySeed({
        createdAt: parsed.createdAt,
        recentTextReviewJson: parsed.seed.subjectData?.recentTextReviewJson,
        now,
      })
    ) {
      deleteRouterState(contextKey);
      return null;
    }

    return parsed.seed;
  } catch {
    deleteRouterState(contextKey);
    return null;
  }
}

function setSharedAssistantCapabilitySeed(
  chatJid: string,
  seed: AssistantCapabilityConversationSeed,
  now = new Date(),
): void {
  const contextKey = getSharedAssistantContextKey(chatJid);
  if (!contextKey) return;
  const state: SharedAssistantContextState = {
    version: 1,
    createdAt: now.toISOString(),
    seed,
  };
  setRouterState(contextKey, JSON.stringify(state));
}

function clearSharedAssistantCapabilitySeed(chatJid: string): void {
  const contextKey = getSharedAssistantContextKey(chatJid);
  if (contextKey) deleteRouterState(contextKey);
}

/** @internal - exported for offline owner-surface continuity tests. */
export function _getSharedAssistantCapabilitySeedForTests(
  chatJid: string,
  now = new Date(),
): AssistantCapabilityConversationSeed | null {
  return getSharedAssistantCapabilitySeed(chatJid, now);
}

/** @internal - exported for offline owner-surface continuity tests. */
export function _setSharedAssistantCapabilitySeedForTests(
  chatJid: string,
  seed: AssistantCapabilityConversationSeed,
  now = new Date(),
): void {
  setSharedAssistantCapabilitySeed(chatJid, seed, now);
}

/** @internal - exported for offline owner-surface continuity tests. */
export function _clearSharedAssistantCapabilitySeedForTests(
  chatJid: string,
): void {
  clearSharedAssistantCapabilitySeed(chatJid);
}

function fingerprintRecentTextReviewValue(
  domain: string,
  value: string,
): string {
  return createHash('sha256')
    .update(`${domain}\u0000${value}`, 'utf8')
    .digest('hex');
}

function computeRecentTextReviewLinkFingerprint(
  link: Omit<MessageActionRecentTextReviewLink, 'linkFingerprint'>,
): string {
  return fingerprintRecentTextReviewValue(
    'message-action-recent-text-review-link',
    [
      link.version,
      link.seedFingerprint,
      link.reviewedAt,
      link.itemId,
      link.itemRank,
      link.communicationThreadId,
      link.historyStartTimestamp,
      link.freshnessSnapshot.latestMessageIdentityHash,
      link.freshnessSnapshot.latestMessageAt,
      link.freshnessSnapshot.latestInboundAt || '',
      link.freshnessSnapshot.latestOutboundAt || '',
      link.freshnessSnapshot.messageCount,
      link.freshnessSnapshot.snapshotHash,
      link.freshnessSnapshot.transcriptHash,
      link.targetChatFingerprint,
      link.presentationScopeFingerprint,
    ].join('\u0000'),
  );
}

export function buildRecentTextReviewMessageActionLink(input: {
  groupFolder: string;
  presentationChatJid: string;
  targetChatJid: string;
  seedJson: string;
  item: {
    itemId: string;
    rank: number;
    communicationThreadId?: string | null;
  };
}): MessageActionRecentTextReviewLink | null {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  const reviewedAt = seed?.reviewedAt || '';
  const historyStartTimestamp = seed?.windowStartTimestamp || '';
  const communicationThreadId = input.item.communicationThreadId?.trim() || '';
  const itemId = input.item.itemId.trim();
  const exactSeedItem = seed?.items.find(
    (candidate) =>
      candidate.itemId === itemId &&
      candidate.rank === input.item.rank &&
      candidate.communicationThreadId === communicationThreadId,
  );
  const freshnessSnapshot = exactSeedItem?.freshnessSnapshot;
  if (
    !exactSeedItem ||
    !freshnessSnapshot?.latestMessageIdentityHash ||
    !freshnessSnapshot.latestMessageAt ||
    !Number.isInteger(freshnessSnapshot.messageCount) ||
    !freshnessSnapshot.messageCount ||
    !/^[a-f0-9]{16}$/i.test(freshnessSnapshot.snapshotHash || '') ||
    !/^[a-f0-9]{16}$/i.test(freshnessSnapshot.transcriptHash || '') ||
    !Number.isInteger(input.item.rank) ||
    input.item.rank < 1 ||
    input.item.rank > 8 ||
    !/^text-review:[a-f0-9]{16,64}$/i.test(itemId) ||
    !/^[a-z0-9][a-z0-9:._-]{0,199}$/i.test(communicationThreadId) ||
    !input.groupFolder.trim() ||
    !input.presentationChatJid.trim() ||
    !input.targetChatJid.startsWith('bb:') ||
    !Number.isFinite(Date.parse(reviewedAt)) ||
    !Number.isFinite(Date.parse(historyStartTimestamp))
  ) {
    return null;
  }
  const base: Omit<MessageActionRecentTextReviewLink, 'linkFingerprint'> = {
    version: 2,
    seedFingerprint: fingerprintRecentTextReviewValue(
      'recent-text-review-seed',
      input.seedJson,
    ),
    reviewedAt,
    itemId,
    itemRank: input.item.rank,
    communicationThreadId,
    historyStartTimestamp,
    freshnessSnapshot: {
      latestMessageIdentityHash: freshnessSnapshot.latestMessageIdentityHash,
      latestMessageAt: freshnessSnapshot.latestMessageAt,
      latestInboundAt: freshnessSnapshot.latestInboundAt || null,
      latestOutboundAt: freshnessSnapshot.latestOutboundAt || null,
      messageCount: freshnessSnapshot.messageCount,
      snapshotHash: freshnessSnapshot.snapshotHash!,
      transcriptHash: freshnessSnapshot.transcriptHash!,
    },
    targetChatFingerprint: fingerprintRecentTextReviewValue(
      'recent-text-review-target-chat',
      input.targetChatJid,
    ),
    presentationScopeFingerprint: fingerprintRecentTextReviewValue(
      'recent-text-review-presentation-scope',
      `${input.groupFolder}\u0000${input.presentationChatJid}`,
    ),
  };
  return {
    ...base,
    linkFingerprint: computeRecentTextReviewLinkFingerprint(base),
  };
}

function parseRecentTextReviewMessageActionLink(
  action: MessageActionRecord,
): MessageActionRecentTextReviewLink | null {
  let refs: Record<string, unknown>;
  try {
    refs = JSON.parse(action.linkedRefsJson || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const raw = refs.recentTextReview;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.version !== 2 ||
    typeof candidate.seedFingerprint !== 'string' ||
    typeof candidate.reviewedAt !== 'string' ||
    typeof candidate.itemId !== 'string' ||
    typeof candidate.itemRank !== 'number' ||
    typeof candidate.communicationThreadId !== 'string' ||
    typeof candidate.historyStartTimestamp !== 'string' ||
    !candidate.freshnessSnapshot ||
    typeof candidate.freshnessSnapshot !== 'object' ||
    Array.isArray(candidate.freshnessSnapshot) ||
    typeof candidate.targetChatFingerprint !== 'string' ||
    typeof candidate.presentationScopeFingerprint !== 'string' ||
    typeof candidate.linkFingerprint !== 'string'
  ) {
    return null;
  }
  const rawSnapshot = candidate.freshnessSnapshot as Record<string, unknown>;
  if (
    typeof rawSnapshot.latestMessageIdentityHash !== 'string' ||
    typeof rawSnapshot.latestMessageAt !== 'string' ||
    !(
      rawSnapshot.latestInboundAt === null ||
      typeof rawSnapshot.latestInboundAt === 'string'
    ) ||
    !(
      rawSnapshot.latestOutboundAt === null ||
      typeof rawSnapshot.latestOutboundAt === 'string'
    ) ||
    typeof rawSnapshot.messageCount !== 'number' ||
    typeof rawSnapshot.snapshotHash !== 'string' ||
    typeof rawSnapshot.transcriptHash !== 'string'
  ) {
    return null;
  }
  const link: MessageActionRecentTextReviewLink = {
    version: 2,
    seedFingerprint: candidate.seedFingerprint,
    reviewedAt: candidate.reviewedAt,
    itemId: candidate.itemId,
    itemRank: candidate.itemRank,
    communicationThreadId: candidate.communicationThreadId,
    historyStartTimestamp: candidate.historyStartTimestamp,
    freshnessSnapshot: {
      latestMessageIdentityHash: rawSnapshot.latestMessageIdentityHash,
      latestMessageAt: rawSnapshot.latestMessageAt,
      latestInboundAt: rawSnapshot.latestInboundAt,
      latestOutboundAt: rawSnapshot.latestOutboundAt,
      messageCount: rawSnapshot.messageCount,
      snapshotHash: rawSnapshot.snapshotHash,
      transcriptHash: rawSnapshot.transcriptHash,
    },
    targetChatFingerprint: candidate.targetChatFingerprint,
    presentationScopeFingerprint: candidate.presentationScopeFingerprint,
    linkFingerprint: candidate.linkFingerprint,
  };
  const fingerprints = [
    link.seedFingerprint,
    link.targetChatFingerprint,
    link.presentationScopeFingerprint,
    link.linkFingerprint,
  ];
  const valid =
    fingerprints.every((value) => /^[a-f0-9]{64}$/i.test(value)) &&
    /^text-review:[a-f0-9]{16,64}$/i.test(link.itemId) &&
    Number.isInteger(link.itemRank) &&
    link.itemRank >= 1 &&
    link.itemRank <= 8 &&
    /^[a-z0-9][a-z0-9:._-]{0,199}$/i.test(link.communicationThreadId) &&
    Number.isFinite(Date.parse(link.reviewedAt)) &&
    Number.isFinite(Date.parse(link.historyStartTimestamp)) &&
    /^[a-f0-9]{16}$/i.test(link.freshnessSnapshot.latestMessageIdentityHash) &&
    Number.isFinite(Date.parse(link.freshnessSnapshot.latestMessageAt)) &&
    Number.isInteger(link.freshnessSnapshot.messageCount) &&
    link.freshnessSnapshot.messageCount > 0 &&
    /^[a-f0-9]{16}$/i.test(link.freshnessSnapshot.snapshotHash) &&
    /^[a-f0-9]{16}$/i.test(link.freshnessSnapshot.transcriptHash) &&
    refs.communicationThreadId === link.communicationThreadId &&
    computeRecentTextReviewLinkFingerprint({
      version: link.version,
      seedFingerprint: link.seedFingerprint,
      reviewedAt: link.reviewedAt,
      itemId: link.itemId,
      itemRank: link.itemRank,
      communicationThreadId: link.communicationThreadId,
      historyStartTimestamp: link.historyStartTimestamp,
      freshnessSnapshot: link.freshnessSnapshot,
      targetChatFingerprint: link.targetChatFingerprint,
      presentationScopeFingerprint: link.presentationScopeFingerprint,
    }) === link.linkFingerprint;
  return valid ? link : null;
}

export function completeRecentTextReviewMessageActionLifecycle(input: {
  action: MessageActionRecord;
  now?: Date;
}): boolean {
  const action = getMessageAction(input.action.messageActionId) || input.action;
  const link = parseRecentTextReviewMessageActionLink(action);
  const presentationChatJid = action.presentationChatJid?.trim() || '';
  const sentAt = action.sentAt || '';
  const now = input.now || new Date();
  let targetChatJid = '';
  try {
    const target = JSON.parse(action.targetConversationJson) as {
      chatJid?: unknown;
    };
    targetChatJid =
      typeof target.chatJid === 'string' ? target.chatJid.trim() : '';
  } catch {
    return false;
  }
  const thread = link
    ? getCommunicationThread(link.communicationThreadId)
    : undefined;
  if (
    !link ||
    action.sourceType !== 'manual_prompt' ||
    !action.sourceKey.includes(':inbound:') ||
    action.targetKind !== 'external_thread' ||
    action.targetChannel !== 'bluebubbles' ||
    action.sendStatus !== 'sent' ||
    !action.platformMessageId?.trim() ||
    !Number.isFinite(Date.parse(sentAt)) ||
    Date.parse(sentAt) > now.getTime() + 5 * 60_000 ||
    !presentationChatJid ||
    !getSharedAssistantContextKey(presentationChatJid) ||
    !targetChatJid.startsWith('bb:') ||
    !thread ||
    thread.groupFolder !== action.groupFolder ||
    thread.channel !== 'bluebubbles' ||
    thread.channelChatJid !== targetChatJid ||
    thread.disabledAt != null ||
    fingerprintRecentTextReviewValue(
      'recent-text-review-target-chat',
      targetChatJid,
    ) !== link.targetChatFingerprint ||
    fingerprintRecentTextReviewValue(
      'recent-text-review-presentation-scope',
      `${action.groupFolder}\u0000${presentationChatJid}`,
    ) !== link.presentationScopeFingerprint
  ) {
    return false;
  }

  const signalId = buildRecentTextReviewOutcomeSignalId({
    itemId: link.itemId,
    outcome: 'handled',
    occurredAt: sentAt,
  });
  if (!hasCommunicationSignal(signalId)) {
    const recorded = recordRecentTextReviewOutcome({
      groupFolder: action.groupFolder,
      item: {
        itemId: link.itemId,
        rank: link.itemRank,
        section: 'needs_reply',
        chatLabel: 'Messages thread',
        isGroup: false,
        communicationThreadId: link.communicationThreadId,
        summaryText: 'Verified reply sent.',
      },
      outcome: 'handled',
      now: new Date(sentAt),
    });
    if (!recorded) return false;
  }

  const currentSeed = getSharedAssistantCapabilitySeed(
    presentationChatJid,
    now,
  );
  const currentSeedJson = currentSeed?.subjectData?.recentTextReviewJson;
  if (
    currentSeedJson &&
    fingerprintRecentTextReviewValue(
      'recent-text-review-seed',
      currentSeedJson,
    ) === link.seedFingerprint
  ) {
    const currentReview = parseRecentTextReviewSeedJson(currentSeedJson);
    const exactItem = currentReview?.items.find(
      (item) =>
        item.itemId === link.itemId &&
        item.rank === link.itemRank &&
        item.communicationThreadId === link.communicationThreadId,
    );
    if (currentReview?.reviewedAt === link.reviewedAt && exactItem) {
      clearSharedAssistantCapabilitySeed(presentationChatJid);
    }
  }
  return true;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseBundleCommand(rawText: string): {
  bundleId: string;
  operation:
    | { kind: 'approve_all' }
    | { kind: 'enter_selection' }
    | { kind: 'toggle_action'; orderIndex: number }
    | { kind: 'run_selected' }
    | { kind: 'skip_selected' }
    | { kind: 'defer_all' }
    | { kind: 'show' };
} | null {
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

function parseMessageActionCommand(rawText: string): {
  messageActionId: string;
  operation: MessageActionOperation;
} | null {
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
      return {
        messageActionId,
        operation: { kind: 'rewrite', style: 'shorter' },
      };
    }
    if (style === 'warmer') {
      return {
        messageActionId,
        operation: { kind: 'rewrite', style: 'warmer' },
      };
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

function parseReviewCommand(rawText: string): {
  outcomeId: string;
  control:
    | { kind: 'mark_handled' }
    | { kind: 'still_open' }
    | { kind: 'remind_tomorrow' }
    | { kind: 'hide' }
    | { kind: 'show' };
} | null {
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

function parseDelegationRuleCommand(rawText: string): {
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
} | null {
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

function acceptConfirmedPresentationDelivery<
  T extends SendMessageResult,
>(params: {
  result: T;
  channel: string;
  chatJid: string;
  workflow: string;
  onUnverified?: () => void;
}): T | null {
  const classification = classifyChannelDelivery(params.result);
  if (classification.outcome === 'confirmed') return params.result;
  if (classification.outcome === 'rejected') {
    throw new Error('Channel presentation returned no confirmed receipt.');
  }
  params.onUnverified?.();
  logger.error(
    {
      component: 'channel_presentation',
      channel: params.channel,
      chatJid: params.chatJid,
      workflow: params.workflow,
      deliveryOutcome: classification.outcome,
      confirmedReceiptCount: classification.confirmedReceiptCount,
      nextUnconfirmedChunkIndex: classification.nextUnconfirmedChunkIndex,
    },
    'Presentation delivery is incomplete or uncertain; workflow context was not advanced and automatic replay is blocked',
  );
  return null;
}

async function applyAndPresentActionBundle(params: {
  chatJid: string;
  bundleId: string;
  operation: ActionBundleOperation;
  readonly ownerAuthored?: boolean | null;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  if (
    !isTrustedOwnerReviewSurface({
      channelName: channel.name,
      chatJid: params.chatJid,
      group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return true;
  }
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
      await channel.editMessage(
        params.chatJid,
        messageId,
        result.presentation.text,
        {
          inlineActionRows: result.presentation.inlineActionRows,
        },
      );
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
      const sent = acceptConfirmedPresentationDelivery({
        result: await channel.sendMessage(
          params.chatJid,
          result.presentation.text,
          {
            inlineActionRows: result.presentation.inlineActionRows,
          },
        ),
        channel: channel.name,
        chatJid: params.chatJid,
        workflow: 'action_bundle_presentation',
      });
      if (!sent) return true;
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
  /** Exact presentation card that emitted a callback, when applicable. */
  sourcePresentationMessageId?: string | null;
  sourcePresentationThreadId?: string | null;
  /** Exact authorship fact from the current inbound platform message. */
  readonly ownerAuthored?: boolean | null;
  ownerAuthorizationAt?: string;
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
  const action = getMessageAction(params.messageActionId);
  const messagesHistoryChannel = channels.find(
    (candidate) =>
      candidate.name === 'bluebubbles' && candidate.primeChatHistory,
  );
  const trustedOwnerSurface = isTrustedOwnerReviewSurface({
    channelName: channel.name,
    chatJid: params.chatJid,
    group,
    ownerAuthored: params.ownerAuthored,
  });
  if (
    !action ||
    action.groupFolder !== group.folder ||
    !trustedOwnerSurface ||
    !isMessageActionBoundToPresentationSurface({
      action,
      channel: conversationChannel,
      chatJid: params.chatJid,
    }) ||
    (params.sourcePresentationMessageId !== undefined &&
      !isMessageActionBoundToPresentationMessage({
        action,
        presentationMessageId: params.sourcePresentationMessageId,
        presentationThreadId: params.sourcePresentationThreadId,
      }))
  ) {
    await channel.sendMessage(
      params.chatJid,
      'Andrea: That message action is not bound to this private owner chat. I did not show, change, schedule, or send it.',
    );
    return true;
  }
  const result = await applyMessageActionOperation(
    params.messageActionId,
    params.operation,
    {
      groupFolder: group.folder,
      channel: conversationChannel,
      chatJid: params.chatJid,
      currentTime: params.now,
      ownerAuthorizationAt: params.ownerAuthorizationAt,
      ownerReviewGroup: group,
      ...(messagesHistoryChannel?.primeChatHistory
        ? {
            primeMessagesChatHistory: (targetChatJid: string) =>
              messagesHistoryChannel.primeChatHistory!(targetChatJid, {
                limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
              }),
          }
        : {}),
      onVerifiedSend: (verifiedAction) => {
        completeRecentTextReviewMessageActionLifecycle({
          action: verifiedAction,
          now: params.now,
        });
      },
      sendToTarget: (targetChannel, chatJid, text, options) =>
        sendCompanionHandoffMessage(targetChannel, chatJid, text, options),
    },
  );
  if (!result.handled) return false;

  if (channel.name === 'telegram' && result.presentation) {
    const messageId = result.action?.presentationMessageId || null;
    if (messageId && channel.editMessage) {
      await channel.editMessage(
        params.chatJid,
        messageId,
        result.presentation.text,
        {
          inlineActionRows: result.presentation.inlineActionRows,
        },
      );
    } else {
      const sent = acceptConfirmedPresentationDelivery({
        result: await channel.sendMessage(
          params.chatJid,
          result.presentation.text,
          {
            inlineActionRows: result.presentation.inlineActionRows,
          },
        ),
        channel: channel.name,
        chatJid: params.chatJid,
        workflow: 'message_action_presentation',
      });
      if (!sent) return true;
      updateMessageAction(params.messageActionId, {
        presentationMessageId: sent.platformMessageId || null,
        presentationChatJid: params.chatJid,
        lastUpdatedAt: (params.now || new Date()).toISOString(),
      });
    }
    if (
      result.replyText &&
      !['show', 'show_draft'].includes(params.operation.kind)
    ) {
      await channel.sendMessage(params.chatJid, result.replyText);
    }
    return true;
  }

  if (result.presentation) {
    const sent = acceptConfirmedPresentationDelivery({
      result: await channel.sendMessage(
        params.chatJid,
        result.presentation.text,
      ),
      channel: channel.name,
      chatJid: params.chatJid,
      workflow: 'message_action_presentation',
    });
    if (!sent) return true;
    if (channel.name === 'bluebubbles' && result.action) {
      syncBlueBubblesMessageActionPresentation({
        groupFolder: group.folder,
        chatJid: params.chatJid,
        messageActionId: result.action.messageActionId,
        platformMessageId: sent.platformMessageId || null,
        now: params.now || new Date(),
      });
    }
    if (
      result.replyText &&
      !['show', 'show_draft'].includes(params.operation.kind)
    ) {
      await channel.sendMessage(params.chatJid, result.replyText);
    }
  } else if (result.replyText) {
    await channel.sendMessage(params.chatJid, result.replyText);
  }
  return true;
}

function syncBlueBubblesMessageActionPresentation(params: {
  groupFolder: string;
  chatJid: string;
  messageActionId: string;
  platformMessageId?: string | null;
  now: Date;
}): void {
  updateMessageAction(params.messageActionId, {
    presentationMessageId: params.platformMessageId || null,
    presentationChatJid: params.chatJid,
    lastUpdatedAt: params.now.toISOString(),
  });
  reconcileBlueBubblesSelfThreadContinuity({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
    now: params.now,
    allowRehydrate: false,
  });
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
  readonly ownerAuthored?: boolean | null;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  if (
    !isTrustedOwnerReviewSurface({
      channelName: channel.name,
      chatJid: params.chatJid,
      group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return true;
  }

  const result = applyOutcomeReviewControl({
    groupFolder: group.folder,
    outcomeId: params.outcomeId,
    control: params.control,
    chatJid: params.chatJid,
    now: params.now,
  });
  if (!result.handled) return false;

  const context = getOutcomeReviewContext(
    params.chatJid,
    params.now || new Date(),
  );
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
    const sent = acceptConfirmedPresentationDelivery({
      result: await channel.sendMessage(
        params.chatJid,
        refreshedPresentation.text,
        { inlineActionRows: refreshedPresentation.inlineActionRows },
      ),
      channel: channel.name,
      chatJid: params.chatJid,
      workflow: 'outcome_review_presentation',
    });
    if (!sent) return true;
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
  readonly ownerAuthored?: boolean | null;
  now?: Date;
}): Promise<boolean> {
  const group = resolveCompanionBinding(params.chatJid)?.group;
  const channel = findChannel(channels, params.chatJid);
  if (!group || !channel) return false;
  if (
    !isTrustedOwnerReviewSurface({
      channelName: channel.name,
      chatJid: params.chatJid,
      group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return true;
  }
  const now = params.now || new Date();
  const context = getDelegationRuleContext(params.chatJid, now);

  if (params.command === 'confirm_preview') {
    if (!context?.previewJson || context.previewId !== params.targetId)
      return false;
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
    retargetDelegationRuleChannels(params.targetId, [
      channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram',
    ]);
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

function buildAgiPendingActionRows(
  actions: { pendingId: string; tool: string }[] | undefined,
): SendMessageOptions['inlineActionRows'] {
  if (!actions?.length) return undefined;
  const rows: NonNullable<SendMessageOptions['inlineActionRows']> = [];
  for (const action of actions.slice(0, 3)) {
    rows.push([
      {
        label: `Approve ${action.tool}`,
        actionId: `/agi-confirm ${action.pendingId}`,
      },
      {
        label: 'Decline',
        actionId: `/agi-decline ${action.pendingId}`,
      },
    ]);
  }
  return rows;
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
      actionId: getGoogleCalendarCreateConfirmationActionId(state),
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

function saveState(): void {
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

async function getAgiRuntimeOrNull(): Promise<AgiRuntime | null> {
  if (!ANDREA_USE_AGI) return null;
  if (agiRuntime) return agiRuntime;
  if (
    agiRuntimeInitFailed &&
    Date.now() - agiRuntimeLastInitFailedAt < AGI_RUNTIME_BOOT_RETRY_MS
  ) {
    return null;
  }
  try {
    agiRuntime = await bootstrapAgi({}, { skipSignalHooks: true });
    agiRuntimeInitFailed = false;
    agiRuntimeLastInitFailedAt = 0;
    logger.info({ component: 'agi_runtime' }, 'AGI runtime bootstrapped');
    return agiRuntime;
  } catch (err) {
    agiRuntimeInitFailed = true;
    agiRuntimeLastInitFailedAt = Date.now();
    logger.warn(
      { component: 'agi_runtime', err },
      'AGI runtime bootstrap failed; continuing on legacy runtime',
    );
    return null;
  }
}

function prunePendingAgiConfirmations(now = Date.now()): void {
  for (const [pendingId, pending] of pendingAgiConfirmationsById) {
    if (now - pending.createdAt > AGI_PENDING_CONFIRMATION_TTL_MS) {
      pendingAgiConfirmationsById.delete(pendingId);
    }
  }
}

async function handleAgiConfirmationCommand(params: {
  chatJid: string;
  msg: NewMessage;
  approve: boolean;
  pendingId: string;
}): Promise<string> {
  if (!ANDREA_USE_AGI) return 'AGI runtime is not enabled.';
  prunePendingAgiConfirmations();
  const pending = pendingAgiConfirmationsById.get(params.pendingId);
  if (!pending || pending.chatJid !== params.chatJid) {
    return 'That AGI confirmation is unknown or expired.';
  }
  if (
    pending.sender &&
    pending.sender !== (params.msg.sender || params.chatJid)
  ) {
    return 'That AGI confirmation belongs to a different sender.';
  }
  const agi = await getAgiRuntimeOrNull();
  if (!agi) return 'AGI runtime is unavailable; no action was taken.';
  pendingAgiConfirmationsById.delete(params.pendingId);
  const out = await agi.confirmTool(params.pendingId, params.approve, {
    chatJid: pending.scope,
  });
  if (!params.approve) return 'Declined. No action was taken.';
  if (out.ok) return 'Approved and completed.';
  if ('error' in out && out.error) return `Approval failed: ${out.error}`;
  if ('decision' in out && out.decision) {
    return `Approval blocked: ${out.decision.reason}`;
  }
  return 'Approval did not complete.';
}

function persistAgentThread(
  groupFolder: string,
  threadId: string,
  runtime: AgentThreadState['runtime'],
): void {
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
  if (sessionStorageKey === groupFolder) {
    delete sessions[groupFolder];
    deleteSession(groupFolder);
    delete agentThreads[groupFolder];
    deleteAgentThread(groupFolder);
  }
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
        'This chat is already registered as a non-main chat. Use your existing main chat for administration, or run /mainchat for the exact change flow.',
    };
  }

  const audit = getCurrentMainChatAudit();
  if (
    audit.registeredMainChat &&
    audit.repairTargetChat &&
    audit.repairTargetChat.jid === chatJid
  ) {
    try {
      const repaired = repairRegisteredMainChat({
        fromJid: audit.registeredMainChat.jid,
        toJid: chatJid,
        toName: chatName || 'Main',
      });
      loadState();
      writeCurrentRuntimeAuditState(
        `Main chat registration was repaired from ${audit.registeredMainChat.jid} to ${repaired.jid}.`,
      );
      logger.warn(
        { fromJid: audit.registeredMainChat.jid, toJid: chatJid },
        'Repaired stale main chat registration via /registermain',
      );
      return {
        ok: true,
        message: `Main chat registration was stale and has been repaired to ${buildMainChatSummaryLine(repaired.jid, repaired)}. This chat is now your main control chat. You can continue here.`,
      };
    } catch (err) {
      logger.warn(
        {
          err,
          chatJid,
          fromJid: audit.registeredMainChat.jid,
        },
        'Failed deterministic main chat repair during /registermain flow',
      );
    }
  }

  const existingMain = Object.entries(registeredGroups).find(
    ([, group]) => group.isMain,
  );
  const existingMainFolder = Object.entries(registeredGroups).find(
    ([, group]) => group.folder === 'main',
  );
  if (existingMain) {
    const [existingMainJid, existingGroup] = existingMain;
    const mainSummary = buildMainChatSummaryLine(
      existingMainJid,
      existingGroup,
    );
    return {
      ok: false,
      message: `A main chat is already registered as ${mainSummary}. To switch, run /mainchat in the current main chat and follow the on-screen transfer flow.`,
    };
  }

  if (existingMainFolder && !existingMain) {
    const [existingMainJid, existingGroup] = existingMainFolder;
    const mainSummary = buildMainChatSummaryLine(
      existingMainJid,
      existingGroup,
    );
    return {
      ok: false,
      message: `A main chat is already registered as ${mainSummary}. To switch, run /mainchat in that chat and use its on-screen transfer flow.`,
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
    message: `Main chat registered successfully (${chatJid}). You can now use main-control commands here with ${ASSISTANT_NAME}.`,
  };
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): AvailableGroup[] {
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
      ANDREA_PLATFORM_COORDINATOR_ENABLED &&
      !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
        ? "Andrea's Codex/OpenAI runtime lane is platform-routed on this host, but execution is currently turned off."
        : "Andrea's Codex/OpenAI runtime lane uses the Andrea_OpenAI_Bot loopback backend on this host.",
      'That backend lane is currently disabled in this NanoBot runtime, so Andrea can only review existing runtime work.',
      'Enable ANDREA_OPENAI_BACKEND_ENABLED=true (the legacy ANDREA_RUNTIME_EXECUTION_ENABLED=true flag also works), then restart Andrea to bring the runtime lane back online.',
    ],
  });
}

function getAndreaRuntimeStatusBaseUrl(): string {
  if (
    ANDREA_PLATFORM_COORDINATOR_ENABLED &&
    !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
  ) {
    return ANDREA_PLATFORM_COORDINATOR_URL;
  }
  return ANDREA_OPENAI_BACKEND_URL;
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
          getAndreaRuntimeStatusBaseUrl(),
        ),
      ),
    ],
    lines: [
      ANDREA_PLATFORM_COORDINATOR_ENABLED &&
      !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
        ? "Andrea's Codex/OpenAI lane now resolves through the Andrea Platform coordinator first; the direct backend path is break-glass fallback."
        : "Andrea's Codex/OpenAI lane now resolves through the Andrea_OpenAI_Bot loopback backend.",
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

  const legacyRuntimeSelection = getLegacyRuntimeSelection(
    chatJid,
    groupFolder,
  );
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
  if (
    params.laneId === 'andrea_runtime' ||
    params.source === 'legacy_runtime_fallback'
  ) {
    clearLegacyRuntimeSelection(params.chatJid);
  }
}

/** Read one selected task without listing, bootstrapping, or resuming work. */
export async function getRuntimeWorkCockpitSelection(params: {
  chatJid: string;
  groupFolder: string;
  threadId?: string;
  getJob: Parameters<typeof resolveRuntimeWorkRecovery>[0]['getJob'];
  getCachedJob?: Parameters<
    typeof resolveRuntimeWorkRecovery
  >[0]['getCachedJob'];
  isCurrentRead?: () => boolean;
}): Promise<{
  selected: BackendJobDetails | null;
  recovery: RuntimeWorkRecovery;
  superseded: boolean;
}> {
  const readSelection = () =>
    getSelectedLaneJobId(params.chatJid, params.threadId, 'andrea_runtime') ||
    getLegacyRuntimeSelection(params.chatJid, params.groupFolder);
  const selectedJobId = readSelection();
  const focus = getActiveCursorOperatorContext(params.chatJid, params.threadId);
  const recovery = await resolveRuntimeWorkRecovery({
    ...params,
    selectedJobId,
    getCachedJob:
      params.getCachedJob ||
      ((jobId) => getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, jobId)),
  });
  const latestFocus = getActiveCursorOperatorContext(
    params.chatJid,
    params.threadId,
  );
  const superseded =
    (params.isCurrentRead ? !params.isCurrentRead() : false) ||
    readSelection() !== selectedJobId ||
    latestFocus?.selectedLaneId !== focus?.selectedLaneId ||
    latestFocus?.selectedAgentId !== focus?.selectedAgentId;
  if (!superseded && recovery.kind === 'missing' && selectedJobId) {
    // Clear only the exact confirmed-missing pointer, never a newer choice.
    if (
      getSelectedLaneJobId(
        params.chatJid,
        params.threadId,
        'andrea_runtime',
      ) === selectedJobId
    ) {
      clearSelectedLaneJob({
        chatJid: params.chatJid,
        threadId: params.threadId,
        laneId: 'andrea_runtime',
      });
    }
    if (
      getLegacyRuntimeSelection(params.chatJid, params.groupFolder) ===
      selectedJobId
    ) {
      clearLegacyRuntimeSelection(params.chatJid);
    }
  }
  return {
    selected:
      !superseded && recovery.kind === 'available' ? recovery.job : null,
    recovery,
    superseded,
  };
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

/** @internal - exported for offline owner-surface continuity tests. */
export function _setBlueBubblesConversationBindingForTests(
  binding: typeof blueBubblesConversationBinding,
): void {
  blueBubblesConversationBinding = binding;
}

function resolveCompanionBinding(chatJid: string) {
  return resolveCompanionConversationBinding(chatJid, registeredGroups, {
    bluebubbles: blueBubblesConversationBinding,
  });
}

function listProcessableCompanionChatJids(): string[] {
  return listCompanionConversationChatJids(registeredGroups, {
    bluebubbles: blueBubblesConversationBinding,
  }).filter(
    (chatJid) =>
      !chatJid.startsWith('bb:') ||
      !isBlueBubblesDataOnlyContactThread({
        channelName: 'bluebubbles',
        chatJid,
      }),
  );
}

let resolveTelegramMainChatForAlexa = (_groupFolder: string) =>
  undefined as { chatJid: string } | undefined;
let resolveBlueBubblesCompanionChat = (_groupFolder: string) =>
  undefined as { chatJid: string } | undefined;
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
  return requireCompleteChannelDelivery(
    await channel.sendMessage(chatJid, text, options),
  );
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

export function buildDurableContinuityNaturalReply(input: {
  text: string;
  groupFolder: string;
  now?: Date | string;
}): string | null {
  if (!isDurableContinuityNaturalRequest(input.text)) return null;
  return formatDurableContinuityForUser(
    buildDurableContinuityReport({
      groupId: input.groupFolder,
      now: input.now,
    }),
  );
}

export function reconcileDurableContinuityBeforeAcceptingWork(
  now: Date | string = new Date(),
) {
  return reconcileDurableWorkOnStartup({ now });
}

async function prepareOpenClawDelegationResponse(params: {
  chatJid: string;
  prompt: string;
  message?: NewMessage;
  command: OpenClawDelegationCommand;
}): Promise<{ responseText: string; ok: boolean; detail: string }> {
  const mediaAttachmentIds = (params.message?.attachments || [])
    .filter((attachment) => ['image', 'video'].includes(attachment.kind))
    .map((attachment) => attachment.attachmentId);
  let delegatedPrompt = params.prompt;
  if (mediaAttachmentIds.length > 0) {
    const media = await analyzeMessageMedia({
      attachmentIds: mediaAttachmentIds,
      prompt:
        'Describe the attached image or sampled video accurately for another assistant. Include visible text and uncertainty. Do not infer details that are not visible.',
      requester: 'andrea',
    });
    delegatedPrompt = buildOpenClawMediaGroundedPrompt({
      prompt: params.prompt,
      mediaSummary: media.summaryText,
      mediaBlocker: media.handled ? null : media.blocker,
    });
    logger.info(
      {
        chatJid: params.chatJid,
        attachmentCount: mediaAttachmentIds.length,
        mediaHandled: media.handled,
        mediaProvider: media.providerUsed || null,
        mediaDebugPath: media.debugPath,
      },
      'Prepared bounded media evidence for OpenClaw delegation',
    );
  }

  const result = await delegateToOpenClawAgent({
    message: delegatedPrompt,
    sessionKey: buildOpenClawChatSessionKey(params.chatJid),
  });
  return {
    responseText: formatOpenClawDelegationResponse(
      result,
      params.command === 'mention' ? 'mention' : 'operator',
    ),
    ok: result.ok,
    detail: result.detail,
  };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = resolveCompanionBinding(chatJid)?.group;
  if (!group) return true;
  const channel = findChannel(channels, chatJid);
  if (!channel) return true;
  if (
    isBlueBubblesDataOnlyContactThread({
      channelName: channel.name,
      chatJid,
    })
  ) {
    return true;
  }

  // Acquire the logical session lock before claiming. Telegram and
  // BlueBubbles JIDs may share one folder/session; a claim must not age while
  // another surface is still running that same assistant context.
  return logicalTurnSerializer.run(group.folder, async () => {
    const needsTrigger =
      group.isMain !== true && group.requiresTrigger !== false;
    const allowlistCfg = needsTrigger ? loadSenderAllowlist() : null;
    const triggerPattern = needsTrigger
      ? getTriggerPattern(group.trigger)
      : null;
    // A proof-drill request is a deterministic owner-surface control turn.
    // Find it across the full durable pending sequence and end the claim at
    // that exact row so newer chatter cannot bury it or join its instruction
    // batch. Authorization is enforced again inside the claimed handler.
    const proofDrillMessage =
      channel.name === 'bluebubbles'
        ? findFirstPendingActionableMessageForChat({
            chatJid,
            predicate: (message) =>
              isBlueBubblesProofDrillStartRequest(message.content) &&
              isTrustedOwnerReviewSurface({
                channelName: channel.name,
                chatJid,
                group,
                ownerAuthored: message.is_from_me === true,
              }),
          })
        : null;
    const triggerMessage =
      !proofDrillMessage && needsTrigger && triggerPattern && allowlistCfg
        ? findFirstPendingActionableMessageForChat({
            chatJid,
            predicate: (message) =>
              triggerPattern.test(message.content.trim()) &&
              (message.is_from_me ||
                isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
          })
        : null;
    if (
      needsTrigger &&
      !proofDrillMessage?.ingress_seq &&
      !triggerMessage?.ingress_seq
    ) {
      return true;
    }

    const boundedTerminus = proofDrillMessage || triggerMessage;
    const claim = boundedTerminus?.ingress_seq
      ? claimPendingActionableMessagesThroughSequence({
          chatJid,
          throughSequence: boundedTerminus.ingress_seq,
          limit: 200,
        })
      : claimPendingActionableMessagesForChat({
          chatJid,
          limit: MAX_MESSAGES_PER_PROMPT,
        });
    if (!claim.claimToken || claim.messages.length === 0) return true;
    const ignoredBeforeCount =
      'ignoredBeforeCount' in claim ? Number(claim.ignoredBeforeCount) || 0 : 0;
    if (ignoredBeforeCount > 0) {
      logger.info(
        {
          chatJid,
          ignoredBeforeCount,
          contextWindowCount: claim.messages.length,
        },
        'Bounded accumulated group context to the newest messages ending at the trigger',
      );
    }

    let claimCommitted = false;
    const commitClaim = (disposition: string) => {
      if (claimCommitted) return;
      const completed = completeActionableIngressClaim({
        claimToken: claim.claimToken!,
        disposition,
      });
      if (completed !== claim.messages.length) {
        throw new Error(
          `Actionable ingress claim commit mismatch: expected ${claim.messages.length}, completed ${completed}.`,
        );
      }
      claimCommitted = true;
    };

    try {
      const success = await processClaimedGroupMessages(
        chatJid,
        claim.messages,
        (disposition) =>
          commitClaim(disposition || 'primary_delivery_committed'),
      );
      if (success) {
        commitClaim('assistant_turn_handled');
      } else if (!claimCommitted) {
        releaseActionableIngressClaim({
          claimToken: claim.claimToken,
          disposition: 'assistant_turn_retry',
        });
      }
      return success;
    } catch (error) {
      if (claimCommitted) {
        // Delivery already crossed the real side-effect boundary. Never make
        // the originating input actionable again because enrichment failed.
      } else if (isCommittedIncompleteDeliveryError(error)) {
        commitClaim('delivery_committed_or_unverified');
      } else {
        releaseActionableIngressClaim({
          claimToken: claim.claimToken,
          disposition: 'assistant_turn_threw',
        });
      }
      throw error;
    }
  });
}

async function processClaimedGroupMessages(
  chatJid: string,
  actionableMessages: NewMessage[],
  onPrimaryDeliveryCommitted?: (disposition?: string) => void,
): Promise<boolean> {
  const group = resolveCompanionBinding(chatJid)?.group;
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }
  if (
    isBlueBubblesDataOnlyContactThread({
      channelName: channel.name,
      chatJid,
    })
  ) {
    logger.warn(
      { chatJid },
      'Refused queued processing for a data-only BlueBubbles contact thread',
    );
    return true;
  }
  const conversationChannel =
    channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram';
  if (conversationChannel === 'bluebubbles' && !onPrimaryDeliveryCommitted) {
    logger.error(
      { chatJid, groupFolder: group.folder },
      'Refused BlueBubbles self-thread processing without a durable pre-dispatch ingress commit',
    );
    return false;
  }

  const isMainGroup = group.isMain === true;

  const latestObservedTimestamp = actionableMessages.at(-1)!.timestamp;
  // Only live callback rows belong in the instruction batch. Provider history
  // and passive contact sync remain available to explicit review/summary
  // queries, but must not hitchhike into a later live turn as apparent commands.
  let missedMessages = actionableMessages;
  const canonicalSelfThreadJid = canonicalizeBlueBubblesSelfThreadJid(chatJid);
  if (
    canonicalSelfThreadJid &&
    canonicalSelfThreadJid !== chatJid &&
    isBlueBubblesSelfThreadAliasJid(chatJid)
  ) {
    const uniqueMessages = missedMessages.filter(
      (message) => !hasStoredMessage(canonicalSelfThreadJid, message.id),
    );
    if (uniqueMessages.length !== missedMessages.length) {
      logger.info(
        {
          chatJid,
          canonicalChatJid: canonicalSelfThreadJid,
          duplicateCount: missedMessages.length - uniqueMessages.length,
        },
        'Skipped mirrored BlueBubbles self-thread messages',
      );
      missedMessages = uniqueMessages;
      const remainingMessageKeys = new Set(
        missedMessages.map(
          (message) => `${message.chat_jid}\u0000${message.id}`,
        ),
      );
      actionableMessages = actionableMessages.filter((message) =>
        remainingMessageKeys.has(`${message.chat_jid}\u0000${message.id}`),
      );
      if (missedMessages.length === 0 || actionableMessages.length === 0) {
        lastAgentTimestamp[chatJid] = latestObservedTimestamp;
        saveState();
        return true;
      }
    }
  }

  // For non-main groups, check if trigger is required and present. A durable
  // proof-drill claim deliberately ends at its exact control row; treat that
  // row as the terminus here and enforce owner authority in the local handler.
  const hasProofDrillTerminus =
    conversationChannel === 'bluebubbles' &&
    isBlueBubblesProofDrillStartRequest(
      actionableMessages.at(-1)?.content || '',
    );
  if (
    !hasProofDrillTerminus &&
    !isMainGroup &&
    group.requiresTrigger !== false
  ) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = actionableMessages.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const queuedLatestMessage = actionableMessages.at(-1);
  const queuedOwnerAuthorizationAt = resolveQueuedMessagingOwnerAuthorizationAt(
    conversationChannel,
    queuedLatestMessage,
  );
  const queuedMessagingAuthorizationFence =
    captureMessagingOutboundAuthorizationFence(queuedOwnerAuthorizationAt);
  const queuedBlueBubblesAuthorizationFence =
    conversationChannel === 'bluebubbles'
      ? queuedMessagingAuthorizationFence
      : null;
  let queuedBlueBubblesDispatchOrdinal = 0;
  const withQueuedBlueBubblesAuthorization = (
    options: SendMessageOptions = {},
  ): SendMessageOptions =>
    queuedBlueBubblesAuthorizationFence
      ? {
          ...options,
          idempotencyKey:
            options.idempotencyKey ||
            buildBlueBubblesIngressDispatchIdempotencyKey({
              sourceChatJid: queuedLatestMessage?.chat_jid || '',
              sourceMessageId: queuedLatestMessage?.id || '',
              sourceReceivedAt: queuedLatestMessage?.ingress_received_at || '',
              targetChatJid: chatJid,
              slot: `queued_self_thread_reply:${++queuedBlueBubblesDispatchOrdinal}`,
            }),
          blueBubblesAuthorizationAt:
            queuedBlueBubblesAuthorizationFence.authorizationAt,
          blueBubblesPauseGeneration:
            queuedBlueBubblesAuthorizationFence.pauseGeneration,
        }
      : options;
  const withQueuedBlueBubblesTaskAuthorization = <T extends object>(
    task: T,
  ): T & {
    outbound_authorization_at?: string | null;
    outbound_pause_generation?: number | null;
  } =>
    queuedBlueBubblesAuthorizationFence
      ? {
          ...task,
          outbound_authorization_at:
            queuedBlueBubblesAuthorizationFence.authorizationAt,
          outbound_pause_generation:
            queuedBlueBubblesAuthorizationFence.pauseGeneration,
        }
      : task;
  const queuedOpenClawRoute = resolveOpenClawDelegationRoute({
    rawMessage: queuedLatestMessage?.content || '',
    mainControlChat: isOpenClawOwnerControlSurface({
      mainControlChat: false,
      channelName: channel.name,
      blueBubblesSelfThread:
        queuedLatestMessage?.is_from_me === true &&
        isConfiguredBlueBubblesSelfThreadAliasJid(chatJid),
    }),
    delegationEnabled: isOpenClawDelegationEnabled(),
  });
  if (queuedOpenClawRoute.action === 'delegate' && queuedLatestMessage) {
    const startedAt = Date.now();
    lastAgentTimestamp[chatJid] = latestObservedTimestamp;
    saveState();
    logger.info(
      {
        chatJid,
        command: queuedOpenClawRoute.request.command,
        sessionKey: buildOpenClawChatSessionKey(chatJid),
        promptChars: queuedOpenClawRoute.request.prompt.length,
        ingress: 'durable_queue',
      },
      'OpenClaw delegation started',
    );
    try {
      await channel.setTyping?.(chatJid, true);
      const prepared = await prepareOpenClawDelegationResponse({
        chatJid,
        prompt: queuedOpenClawRoute.request.prompt,
        message: queuedLatestMessage,
        command: queuedOpenClawRoute.request.command,
      });
      logger.info(
        {
          chatJid,
          command: queuedOpenClawRoute.request.command,
          ok: prepared.ok,
          detail: prepared.detail,
          ingress: 'durable_queue',
        },
        'OpenClaw delegation prepared for same-chat delivery',
      );
      await deliverQueuedResponseWithIngressCommit({
        send: () =>
          channel.sendMessage(
            chatJid,
            prepared.responseText,
            withQueuedBlueBubblesAuthorization(),
          ),
        onPrimaryDeliveryCommitted: () =>
          onPrimaryDeliveryCommitted?.(
            conversationChannel === 'bluebubbles'
              ? 'delivery_unverified_pre_dispatch_quarantine'
              : undefined,
          ),
        quarantineBeforeDispatch: conversationChannel === 'bluebubbles',
      });
      logger.info(
        {
          chatJid,
          command: queuedOpenClawRoute.request.command,
          sessionKey: buildOpenClawChatSessionKey(chatJid),
          ok: prepared.ok,
          durationMs: Date.now() - startedAt,
          ingress: 'durable_queue',
        },
        'OpenClaw delegation completed',
      );
    } catch (err) {
      logger.error(
        { err, chatJid, ingress: 'durable_queue' },
        'Queued OpenClaw delegation failed',
      );
      throw err;
    } finally {
      await channel.setTyping?.(chatJid, false).catch(() => undefined);
    }
    return true;
  }

  const turnDequeuedAt = Date.now();
  const turnStartedAt = resolveInteractionTurnStartedAtMs({
    inboundTimestamps: missedMessages.map((message) => message.timestamp),
    dequeuedAtMs: turnDequeuedAt,
  });
  const turnHostPressure = captureHostPressureSnapshot();

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

  let prompt = buildAssistantPromptWithPersonalization(
    formatMessages(promptMessages, TIMEZONE),
    {
      channel: conversationChannel,
      groupFolder: group.folder,
    },
  );

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] = latestObservedTimestamp;
  inFlightCursorRollbacks.begin(chatJid, previousCursor);
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
  const currentTurnOwnerAuthored = latestUserMessage?.is_from_me === true;
  const rawLastContent = latestUserMessage?.content ?? '';
  let lastContent = chatJid.startsWith('bb:')
    ? normalizeBlueBubblesCompanionPrompt(rawLastContent)
    : rawLastContent;
  const compoundCalendarResearchPlan =
    planCompoundCalendarResearchRequest(lastContent);
  const currentTurnAttachments = missedMessages.flatMap(
    (message) => message.attachments || [],
  );
  const currentAttachmentIds = currentTurnAttachments
    .filter((attachment) => ['image', 'video'].includes(attachment.kind))
    .map((attachment) => attachment.attachmentId);
  const currentMessageCapabilityMatch = matchAssistantCapabilityRequest(
    lastContent,
    {
      currentAttachmentKinds: currentTurnAttachments.map(
        (attachment) => attachment.kind,
      ),
    },
  );
  const currentInboundMediaCapabilityMatch = currentAttachmentIds.length
    ? currentMessageCapabilityMatch
    : null;
  const now = new Date();
  const reminderOperationIdentity = {
    channel:
      conversationChannel === 'bluebubbles'
        ? ('bluebubbles' as const)
        : ('telegram' as const),
    inboundId: latestUserMessage?.id || null,
    timeZone: TIMEZONE,
  };
  const compoundReminderResearchPlan = planCompoundReminderResearchRequest(
    lastContent,
    group.folder,
    chatJid,
    now,
    reminderOperationIdentity,
  );
  const preHarnessMessageActionOperation =
    conversationChannel === 'bluebubbles'
      ? interpretMessageActionFollowup(lastContent)
      : null;
  const preHarnessMessageAction = preHarnessMessageActionOperation
    ? resolveMessageActionForFollowup({
        groupFolder: group.folder,
        chatJid,
        rawText: lastContent,
        now,
      })
    : null;
  const turnRunOrigin =
    preHarnessMessageAction &&
    isBlueBubblesProofDrillAction(preHarnessMessageAction)
      ? 'replay'
      : 'live';
  const shouldHandleProofDrillLocally =
    shouldHandleBlueBubblesProofDrillLocally({
      conversationChannel,
      requestRoute: requestPolicy.route,
      text: rawLastContent,
    });
  const shouldHandleOutcomeReviewLocally =
    shouldPreferLocalResponseFeedbackReview({
      requestRoute: requestPolicy.route,
      text: rawLastContent || lastContent,
    });
  const shouldHandleDurableContinuityLocally =
    isDurableContinuityNaturalRequest(lastContent);
  const shouldHandleReleaseReadinessReuseLocally =
    isReleaseReadinessActiveReuseRequest(lastContent);
  const turnHarnessStartedAt = Date.now();
  const turnAgentHarness: TurnAgentHarnessContext | null =
    shouldHandleProofDrillLocally ||
    shouldHandleOutcomeReviewLocally ||
    shouldHandleDurableContinuityLocally ||
    shouldHandleReleaseReadinessReuseLocally ||
    Boolean(compoundCalendarResearchPlan || compoundReminderResearchPlan)
      ? null
      : await beginTurnAgentHarness({
          turnId:
            latestUserMessage?.id ||
            `${conversationChannel}:${chatJid}:${now.toISOString()}`,
          channel:
            String(channel.name) === 'bluebubbles'
              ? 'bluebubbles'
              : String(channel.name) === 'alexa'
                ? 'alexa'
                : 'telegram',
          groupFolder: group.folder,
          text: lastContent,
          requestRoute: requestPolicy.route,
          runOrigin: turnRunOrigin,
          // v13 B4 caller-side completion: pass the per-message sender (group
          // chats) or fall back to chatJid (1-on-1) so the platform's user-belief
          // state actually accumulates per actor instead of staying empty.
          actorId: latestUserMessage?.sender || chatJid,
          chatId: chatJid,
        });
  const turnHarnessCompletedAt = Date.now();
  if (turnAgentHarness?.groundedDeliberation?.mode === 'assistive') {
    prompt = [
      prompt,
      '',
      '<grounded-response-advisory>',
      formatGroundedDeliberationGuidance(turnAgentHarness.groundedDeliberation),
      '</grounded-response-advisory>',
    ].join('\n');
    turnAgentHarness.contextCompile.metadata.grounded_advisory_prompt_injected =
      'true';
  } else if (turnAgentHarness) {
    turnAgentHarness.contextCompile.metadata.grounded_advisory_prompt_injected =
      'false';
  }
  const interactionTurnId = randomUUID();
  let primaryDeliveryCompleted = false;
  let latestDeliveredTurnEvaluation: PreSendEvaluation | null = null;
  const runtimeEvidenceScope = new TurnRuntimeEvidenceScope();
  const shouldDeferPlatformHoldForLocalCalendarLookup =
    (requestPolicy.route === 'direct_assistant' ||
      requestPolicy.route === 'protected_assistant') &&
    isSafeReadOnlyCalendarLookupAsk(lastContent);
  const localBlueBubblesMessageActionOperation =
    preHarnessMessageActionOperation;
  const localBlueBubblesMessageAction = preHarnessMessageAction;
  const localBlueBubblesMessageActionContinuity =
    localBlueBubblesMessageActionOperation && localBlueBubblesMessageAction
      ? reconcileBlueBubblesMessageActionContinuity({
          groupFolder: group.folder,
          chatJid,
          now,
          allowRehydrate: true,
        })
      : null;
  const shouldDeferPlatformHoldForLocalMessageAction =
    shouldPreferBlueBubblesLocalMessageActionFollowup({
      conversationChannel,
      requestRoute: requestPolicy.route,
      operationRecognized: Boolean(localBlueBubblesMessageActionOperation),
      actionResolved: Boolean(localBlueBubblesMessageAction),
      policyAllows: Boolean(
        localBlueBubblesMessageActionOperation &&
        localBlueBubblesMessageActionContinuity &&
        canApplyBlueBubblesMessageActionFollowup({
          rawText: rawLastContent,
          operation: localBlueBubblesMessageActionOperation,
          continuity: localBlueBubblesMessageActionContinuity,
        }),
      ),
    });
  const shouldDeferPlatformHoldForLocalOutcomeReview =
    shouldHandleOutcomeReviewLocally;
  const localBlueBubblesOutboundIntent =
    parseAssistantMessageActionIntent(lastContent);
  const shouldDeferPlatformHoldForExplicitBlueBubblesExecution = Boolean(
    localBlueBubblesOutboundIntent?.kind === 'message_send' &&
    ['execute', 'draft', 'prepare', 'inform'].includes(
      localBlueBubblesOutboundIntent.mode,
    ),
  );
  const shouldDeferPlatformHoldForLocalUsefulCapability =
    (requestPolicy.route === 'direct_assistant' ||
      requestPolicy.route === 'protected_assistant') &&
    Boolean(
      quickReply ||
      shouldHandleDurableContinuityLocally ||
      shouldHandleReleaseReadinessReuseLocally ||
      currentMessageCapabilityMatch ||
      shouldDeferPlatformHoldForLocalCalendarLookup ||
      shouldDeferPlatformHoldForLocalMessageAction ||
      shouldDeferPlatformHoldForLocalOutcomeReview ||
      shouldDeferPlatformHoldForExplicitBlueBubblesExecution ||
      compoundCalendarResearchPlan ||
      compoundReminderResearchPlan,
    );
  const sendAssistantReplyWithFeedback = async (params: {
    text: string;
    sendOptions?: SendMessageOptions;
    routeKey?: string | null;
    capabilityId?: string | null;
    providerId?: string | null;
    modelId?: string | null;
    endpointMode?: string | null;
    routingProviderId?: string | null;
    routingModelId?: string | null;
    routingEndpointMode?: string | null;
    toolClass?: string | null;
    handlerKind?: string | null;
    responseSource?: string | null;
    traceReason?: string | null;
    traceNotes?: string[];
    blockerClass?: string | null;
    blockerOwner?: PilotBlockerOwner;
    linkedRefs?: ResponseFeedbackRecord['linkedRefs'];
    allowFeedback?: boolean;
    preserveStructuredText?: boolean;
    skipBlueBubblesActionRehydration?: boolean;
    skipCursorDeliveryMark?: boolean;
    latencyTargetClass?: InteractionLatencyTargetClass;
    deliveryOrdinal?: number;
    recordMetricEnabled?: boolean;
    replyKind?: CognitiveReplyKind;
    completionEvidence?: AdaptiveEvidence[];
    durableCompletionVerified?: boolean;
  }) => {
    const requestedReplyKind = params.replyKind || 'completion';
    const authorizationNow = new Date();
    const durableCompletionVerified =
      params.durableCompletionVerified ??
      (requestedReplyKind === 'completion' &&
      (params.completionEvidence?.length || 0) > 0
        ? await verifyTurnAgentAdaptiveCompletion({
            context: turnAgentHarness,
            completionEvidence: params.completionEvidence!,
            now: authorizationNow,
          })
        : false);
    const deliveryAuthorization = authorizeCognitiveReplyDelivery({
      cognitiveRun: turnAgentHarness?.cognitiveRun,
      replyKind: requestedReplyKind,
      completionEvidence: params.completionEvidence,
      durableCompletionVerified,
      now: authorizationNow.toISOString(),
    });
    const authorizedPayload = resolveCognitiveDeliveryPayload({
      authorization: deliveryAuthorization,
      requestedText: params.text,
      requestedSendOptions: params.sendOptions,
    });
    const authorizedText = authorizedPayload.text;
    const effectiveReplyKind: CognitiveReplyKind = deliveryAuthorization.allowed
      ? requestedReplyKind
      : 'evidence_request';
    const turnEvaluation: PreSendEvaluation =
      params.preserveStructuredText && deliveryAuthorization.allowed
        ? {
            status: 'pass',
            evidenceLevel: 'unknown',
            evidenceGap: 'none',
            evaluatorFlags: ['structured_presentation_preserved'],
            safeRewriteApplied: false,
            rewrittenText: authorizedText,
            approvalCorrectness: 'correct',
            memoryEffect: 'unknown',
            summary:
              'Structured approval presentation preserved after local safety staging.',
            truthVerdict: null,
          }
        : evaluateTurnReply({
            context: turnAgentHarness,
            text: authorizedText,
            routeKey: params.routeKey || requestPolicy.route,
            capabilityId: params.capabilityId,
            handlerKind: params.handlerKind,
            responseSource: params.responseSource,
            blockerClass: params.blockerClass,
          });
    const replyText = turnEvaluation.rewrittenText.trim();
    const shouldRecordFeedback =
      params.allowFeedback !== false &&
      replyText.length > 0 &&
      isTrustedOwnerReviewSurface({
        channelName: channel.name,
        chatJid,
        group,
        ownerAuthored: currentTurnOwnerAuthored,
      });
    const shouldAttachFeedbackButtons =
      shouldRecordFeedback && channel.name === 'telegram';
    const feedbackId = shouldRecordFeedback ? randomUUID() : null;
    const authorizedSendOptions = authorizedPayload.sendOptions || {};
    const requestedSendOptions =
      shouldAttachFeedbackButtons && feedbackId
        ? appendResponseFeedbackInlineRow(authorizedSendOptions, feedbackId)
        : authorizedSendOptions;
    const sendOptions =
      withQueuedBlueBubblesAuthorization(requestedSendOptions);
    const delivery = await deliverAssistantReplyWithMetric({
      context: {
        groupFolder: group.folder,
        routeKey: params.routeKey || requestPolicy.route,
        channel: conversationChannel,
        responseSource: params.responseSource || 'unknown',
        handlerKind: params.handlerKind || 'unknown',
        capabilityId: params.capabilityId || 'unknown',
        providerId:
          params.providerId ||
          (params.responseSource === 'local_companion'
            ? 'local_runtime'
            : params.responseSource || 'unknown'),
        modelId: params.modelId || undefined,
        endpointMode: params.endpointMode || undefined,
        routingProviderId: params.routingProviderId || undefined,
        routingModelId: params.routingModelId || undefined,
        routingEndpointMode: params.routingEndpointMode || undefined,
        toolClass:
          params.toolClass ||
          params.capabilityId ||
          params.handlerKind ||
          undefined,
        turnId: interactionTurnId,
        deliveryOrdinal: params.deliveryOrdinal ?? 1,
        runOrigin: turnRunOrigin,
        latencyTargetClass: params.latencyTargetClass || 'ordinary_response',
        turnStartedAtMs: turnStartedAt,
        turnDequeuedAtMs: turnDequeuedAt,
        harnessStartedAtMs: turnHarnessStartedAt,
        harnessCompletedAtMs: turnHarnessCompletedAt,
        harnessBypassed:
          shouldHandleOutcomeReviewLocally ||
          shouldHandleDurableContinuityLocally ||
          Boolean(compoundCalendarResearchPlan || compoundReminderResearchPlan),
        hostPressure: turnHostPressure,
      },
      send: async () => {
        if (conversationChannel === 'bluebubbles') {
          // There is no atomic transaction spanning the local ingress ledger
          // and BlueBubbles. Quarantine this exact claimed turn before POST;
          // a crash may leave delivery unverified, but can never replay it.
          inFlightCursorRollbacks.markDelivered(chatJid);
          onPrimaryDeliveryCommitted?.(
            'delivery_unverified_pre_dispatch_quarantine',
          );
        }
        return channel.sendMessage(chatJid, replyText, sendOptions);
      },
      classifyDelivery: classifyChannelDelivery,
      recordMetricEnabled:
        params.recordMetricEnabled ?? !primaryDeliveryCompleted,
      onDelivered: () => {
        if (!params.skipCursorDeliveryMark) {
          inFlightCursorRollbacks.markDelivered(chatJid);
          onPrimaryDeliveryCommitted?.();
        }
      },
      onDeliveryCommitError: (error) =>
        logger.error(
          { err: error, chatJid, groupFolder: group.folder },
          'Assistant reply was delivered but its in-flight cursor could not be committed',
        ),
      onMetricError: (error) =>
        logger.warn(
          {
            err: error,
            chatJid,
            groupFolder: group.folder,
            routeKey: params.routeKey || requestPolicy.route,
          },
          'Assistant reply was delivered but latency evidence could not be persisted',
        ),
    });
    const sent = delivery.result;
    primaryDeliveryCompleted = true;
    if (delivery.deliveryOutcome !== 'confirmed') {
      const confirmedReceiptCount = new Set(
        [sent.platformMessageId, ...(sent.platformMessageIds || [])].filter(
          (value): value is string => Boolean(value),
        ),
      ).size;
      logger.error(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          routeKey: params.routeKey || requestPolicy.route,
          deliveryOutcome: delivery.deliveryOutcome,
          confirmedReceiptCount,
          nextUnconfirmedChunkIndex: sent.nextUnconfirmedChunkIndex,
        },
        'Assistant reply delivery was incomplete or uncertain; cursor committed to prevent duplicate replay',
      );
      throw new CommittedIncompleteDeliveryError({
        deliveryOutcome: delivery.deliveryOutcome,
        confirmedReceiptCount,
        nextUnconfirmedChunkIndex: sent.nextUnconfirmedChunkIndex,
      });
    }
    latestDeliveredTurnEvaluation = turnEvaluation;
    await runPostDeliveryEnrichment({
      run: async () => {
        if (
          channel.name === 'bluebubbles' &&
          !params.skipBlueBubblesActionRehydration
        ) {
          ensureBlueBubblesSelfThreadMessageActionForReplyText({
            groupFolder: group.folder,
            chatJid,
            replyText,
            presentationMessageId: sent.platformMessageId || null,
            now,
          });
        }
        const feedbackClassification = feedbackId
          ? classifyResponseFeedbackCandidate({
              originalUserText: rawLastContent || lastContent,
              assistantReplyText: replyText,
              routeKey: params.routeKey,
              capabilityId: params.capabilityId,
              responseSource: params.responseSource,
              traceReason: params.traceReason,
              blockerClass: params.blockerClass,
            })
          : null;
        if (feedbackId && feedbackClassification) {
          upsertResponseFeedback({
            feedbackId,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            status: feedbackClassification.status,
            classification: feedbackClassification.classification,
            channel: conversationChannel,
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
            blockerOwner:
              params.blockerOwner || feedbackClassification.blockerOwner,
            originalUserText:
              conversationChannel === 'bluebubbles'
                ? '[private BlueBubbles request omitted]'
                : rawLastContent || lastContent,
            assistantReplyText:
              conversationChannel === 'bluebubbles'
                ? '[private BlueBubbles response omitted]'
                : replyText,
            linkedRefs: {
              ...(params.linkedRefs || {}),
              platformTaskLedgerId:
                turnAgentHarness?.deliberation?.taskLedgerId,
              platformProgressLedgerId:
                turnAgentHarness?.deliberation?.progressLedgerId,
              platformEvaluationId:
                turnAgentHarness?.deliberation?.evaluationId,
              platformTraceGradeId:
                turnAgentHarness?.deliberation?.traceGradeId,
              providerCouncilRunId:
                turnAgentHarness?.providerCouncil?.councilRunId,
              providerCouncilMode: turnAgentHarness?.providerCouncil?.mode,
              providerCouncilStatus:
                turnAgentHarness?.providerCouncil?.answerGuidance?.status,
              personalContextPacketId:
                turnAgentHarness?.personalContextPacket?.packetId,
              personalContextCitations:
                turnAgentHarness?.personalContextPacket?.citations.slice(0, 12),
              verifiedDeepWorkPacketId:
                turnAgentHarness?.verifiedDeepWorkPacket?.packetId,
              cognitiveRunId: turnAgentHarness?.cognitiveRun?.run.runId,
              cognitiveSkillId:
                turnAgentHarness?.cognitiveRun?.run.linkedSkillCardId ||
                undefined,
              cognitiveTrajectoryId:
                turnAgentHarness?.cognitiveRun?.trajectoryScore.trajectoryId,
              agentRuntimeRunId:
                turnAgentHarness?.runtimeSpine?.run.runtimeRunId,
              ...buildPendingPostDeliveryReflectionRefs(now),
            },
            issueId: null,
            remediationLaneId: null,
            remediationJobId: null,
            remediationRuntimePreference: null,
            remediationPrompt: null,
            operatorNote: feedbackClassification.explanation,
          });
        }
        void schedulePostDeliveryReflection({
          groupFolder: group.folder,
          routeKey: params.routeKey || requestPolicy.route,
          runOrigin: turnRunOrigin,
          feedbackId,
          reflect: () =>
            reflectTurnAgentOutcome({
              context: turnAgentHarness,
              evaluation: turnEvaluation,
              routeUsed: params.routeKey || requestPolicy.route,
              answerClass:
                effectiveReplyKind === 'blocked_notice' || params.blockerClass
                  ? 'blocked'
                  : effectiveReplyKind !== 'completion'
                    ? 'degraded'
                    : params.responseSource === 'container_agent'
                      ? 'handled'
                      : params.handlerKind?.includes('fallback')
                        ? 'fallback'
                        : 'handled',
              blockerClass: params.blockerClass,
              replyKind: effectiveReplyKind,
              completionEvidence: deliveryAuthorization.allowed
                ? params.completionEvidence
                : undefined,
              fallbackUsed:
                params.handlerKind?.includes('fallback') ||
                params.responseSource === 'local_companion',
            }),
        });
        if (!feedbackId || !feedbackClassification) return;
        const classification = feedbackClassification;
        if (conversationChannel === 'bluebubbles') {
          pruneUnreviewedBlueBubblesFeedbackLinks({ now });
        }
        recordCouncilOutcomeSignal({
          councilRunId: turnAgentHarness?.providerCouncil?.councilRunId,
          signalKind: 'feedback_attached',
          groupFolder: group.folder,
          channel: conversationChannel,
          routeKey: params.routeKey || requestPolicy.route,
          capabilityId: params.capabilityId,
          blockerClass: params.blockerClass,
          feedbackId,
          flags: [
            conversationChannel === 'telegram'
              ? 'feedback_card_attached'
              : 'reaction_feedback_linked',
          ],
          summary:
            conversationChannel === 'telegram'
              ? 'Telegram feedback affordance attached to a council-guided response.'
              : 'BlueBubbles response linked to privacy-safe native reaction feedback.',
        });
        void emitAndreaPlatformTraceEvent({
          traceId: feedbackId,
          traceKind: 'feedback',
          title:
            conversationChannel === 'telegram'
              ? 'Response feedback affordance attached'
              : 'Native reaction feedback linked',
          summary: classification.explanation,
          refs: compactPlatformStrings({
            feedbackId,
            platformMessageId: sent.platformMessageId || '',
            userMessageId: latestUserMessage?.id
              ? String(latestUserMessage.id)
              : '',
            threadId:
              sent.threadId ||
              (latestUserMessage?.thread_id
                ? String(latestUserMessage.thread_id)
                : ''),
            chatJid,
          }),
          metadata: compactPlatformStrings({
            status: classification.status,
            classification: classification.classification,
            routeKey: params.routeKey || requestPolicy.route,
            capabilityId: params.capabilityId || '',
            handlerKind: params.handlerKind || '',
            responseSource: params.responseSource || '',
            blockerClass: params.blockerClass || '',
            blockerOwner: params.blockerOwner || classification.blockerOwner,
          }),
        });
      },
      onError: (error) =>
        logger.error(
          {
            err: error,
            chatJid,
            groupFolder: group.folder,
            routeKey: params.routeKey || requestPolicy.route,
          },
          'Assistant reply was delivered but post-delivery state could not be fully persisted',
        ),
    });
    return sent;
  };
  const sendCognitiveTurnReply = (params: {
    text: string;
    replyKind: CognitiveReplyKind;
    sendOptions?: SendMessageOptions;
    routeKey?: string;
    capabilityId?: string;
    traceReason?: string;
  }) =>
    sendAssistantReplyWithFeedback({
      text: params.text,
      sendOptions: params.sendOptions,
      routeKey: params.routeKey || `turn_status.${params.replyKind}`,
      capabilityId: params.capabilityId || 'cognition.turn_status',
      handlerKind: 'typed_turn_status',
      responseSource: 'local_companion',
      traceReason:
        params.traceReason ||
        `delivered an explicit ${params.replyKind} response without widening it into a completion claim`,
      replyKind: params.replyKind,
    });

  const openClawPresenceReply = maybeBuildOpenClawPresenceReply(missedMessages);
  if (openClawPresenceReply) {
    try {
      await sendAssistantReplyWithFeedback({
        text: openClawPresenceReply,
        routeKey: 'advanced_helper.openclaw_identity',
        capabilityId: 'openclaw.identity',
        handlerKind: 'openclaw_identity_fast_path',
        responseSource: 'local_companion',
        traceReason:
          'answered explicit OpenClaw presence check through local fast path',
        replyKind: 'progress',
      });
      logger.info(
        { group: group.name },
        'Handled OpenClaw presence request via local assistant fast path',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'OpenClaw presence fast path failed, rolled back cursor for retry',
      );
      return false;
    }
  }

  async function tryHandleAgiRuntimeTurn(): Promise<boolean> {
    if (!ANDREA_USE_AGI || !channel || !group || channel.name !== 'telegram') {
      return false;
    }
    const agi = await getAgiRuntimeOrNull();
    if (!agi) return false;
    try {
      const history = promptMessages
        .slice(0, -1)
        .map((m) => ({
          role: m.is_bot_message ? ('assistant' as const) : ('user' as const),
          content: m.content,
        }))
        .filter((m) => m.content.trim().length > 0);
      const out = await agi.ask({
        scope: group.folder,
        text: lastContent,
        source: `telegram:${chatJid}`,
        initiatedByUser: true,
        history,
      });
      if (out.failed) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { component: 'agi_runtime', chatJid, groupFolder: group.folder },
          'AGI runtime returned failed result; rolling back cursor for legacy fallback',
        );
        return false;
      }
      const pendingRows = buildAgiPendingActionRows(out.pendingActions);
      const pendingText =
        out.pendingActions && out.pendingActions.length > 0
          ? `\n\nPending approval:\n${out.pendingActions
              .map((a) => `- ${a.tool}: ${a.reason}\n  Args: ${a.argsPreview}`)
              .join('\n')}`
          : '';
      prunePendingAgiConfirmations();
      for (const action of out.pendingActions ?? []) {
        pendingAgiConfirmationsById.set(action.pendingId, {
          chatJid,
          scope: group.folder,
          sender: latestUserMessage?.sender || chatJid,
          createdAt: Date.now(),
        });
      }
      await sendAssistantReplyWithFeedback({
        text: out.reply + pendingText,
        sendOptions: pendingRows?.length
          ? { inlineActionRows: pendingRows }
          : undefined,
        routeKey: 'agi_runtime',
        handlerKind: 'agi_runtime',
        responseSource: 'agi_runtime',
        traceReason: 'handled Telegram canary turn through AGI runtime',
        replyKind:
          (out.pendingActions?.length || 0) > 0
            ? 'approval_request'
            : 'completion',
      });
      lastDirectAssistantTextByChatJid[chatJid] = out.reply;
      logger.info(
        {
          component: 'agi_runtime',
          chatJid,
          groupFolder: group.folder,
          pendingActions: out.pendingActions?.length ?? 0,
          strategy: out.trace.answer ? 'completed' : 'unknown',
        },
        'Handled Telegram canary turn through AGI runtime',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { component: 'agi_runtime', chatJid, groupFolder: group.folder, err },
        'AGI runtime canary turn failed; rolling back cursor for legacy fallback',
      );
      return false;
    }
  }

  if (
    shouldHandleProofDrillLocally &&
    !isTrustedOwnerReviewSurface({
      channelName: channel.name,
      chatJid,
      group,
      ownerAuthored: currentTurnOwnerAuthored,
    })
  ) {
    logger.warn(
      { component: 'assistant', chatJid, groupFolder: group.folder },
      'Ignored non-owner-authored BlueBubbles proof instruction from the durable queue',
    );
    return true;
  }

  if (shouldHandleProofDrillLocally) {
    const started = startBlueBubblesProofDrill({
      groupFolder: group.folder,
      chatJid,
      now,
    });
    const proofPresentationAuthorization = authorizeCognitiveReplyDelivery({
      cognitiveRun: turnAgentHarness?.cognitiveRun,
      replyKind: 'progress',
      now: new Date().toISOString(),
    });
    if (!proofPresentationAuthorization.allowed) {
      throw new Error('Cognitive gate rejected the proof-drill status reply.');
    }
    const sent = acceptConfirmedPresentationDelivery({
      result: await channel.sendMessage(
        started.action.presentationChatJid || chatJid,
        buildBlueBubblesProofDrillPresentationText(started.action),
      ),
      channel: channel.name,
      chatJid,
      workflow: 'bluebubbles_proof_drill_presentation',
      onUnverified: () => {
        inFlightCursorRollbacks.markDelivered(chatJid);
        onPrimaryDeliveryCommitted?.();
      },
    });
    if (!sent) return true;
    inFlightCursorRollbacks.markDelivered(chatJid);
    onPrimaryDeliveryCommitted?.();
    updateMessageAction(started.action.messageActionId, {
      presentationMessageId: sent.platformMessageId || null,
      presentationChatJid: started.action.presentationChatJid || chatJid,
      lastUpdatedAt: now.toISOString(),
    });
    logger.info(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        actionId: started.action.messageActionId,
      },
      'Recovered BlueBubbles proof drill through the local deterministic path',
    );
    return true;
  }

  if (
    turnAgentHarness?.platformHoldReply &&
    !shouldDeferPlatformHoldForLocalUsefulCapability &&
    (requestPolicy.route === 'direct_assistant' ||
      requestPolicy.route === 'protected_assistant')
  ) {
    const holdPosture = turnAgentHarness.deliberation?.executionPosture;
    await sendAssistantReplyWithFeedback({
      text: turnAgentHarness.platformHoldReply,
      routeKey: `turn_agent_harness.${turnAgentHarness.deliberation?.executionPosture || 'hold'}`,
      capabilityId: turnAgentHarness.selectedSkill.skillId,
      handlerKind: 'turn_agent_harness_hold',
      responseSource: 'local_companion',
      traceReason:
        'honored platform deliberation hold before executing the selected route',
      blockerClass:
        holdPosture === 'blocked'
          ? turnAgentHarness.deliberation?.policyHoldReason ||
            'platform_policy_hold'
          : null,
      replyKind:
        holdPosture === 'approval_first'
          ? 'approval_request'
          : holdPosture === 'clarify_first'
            ? 'clarification'
            : holdPosture === 'blocked'
              ? 'blocked_notice'
              : 'evidence_request',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    logger.info(
      {
        component: 'assistant',
        chatJid,
        groupFolder: group.folder,
        group: group.name,
        requestRoute: requestPolicy.route,
        executionPosture: turnAgentHarness.deliberation?.executionPosture,
        selectedPolicyId: turnAgentHarness.deliberation?.selectedPolicyId,
      },
      'Handled turn via platform deliberation hold',
    );
    return true;
  }
  const openAiGuidedUserText = lastContent;
  const guidedRequestRoute =
    requestPolicy.route === 'protected_assistant'
      ? 'protected_assistant'
      : 'direct_assistant';
  const shouldUseOpenAiGuidedRouting =
    (conversationChannel === 'telegram' ||
      conversationChannel === 'bluebubbles') &&
    (guidedRequestRoute === 'direct_assistant' ||
      guidedRequestRoute === 'protected_assistant');
  let openAiGuidedRouteChecked = false;
  let openAiGuidedRouteResult: Awaited<
    ReturnType<typeof routeCompanionTurnWithOpenAiBackend>
  > | null = null;
  const rememberOpenAiGuidedRoutingState = (params: {
    source: 'local_fast_path' | 'openai_router' | 'deterministic_fallback';
    routeKind?: string | null;
    capabilityId?: string | null;
    confidence?: string | null;
    fallbackReason?: string | null;
    selectedModelTier?: 'simple' | 'standard' | 'complex' | null;
    selectedModel?: string | null;
    providerMode?: 'direct_openai' | 'compatible_gateway' | null;
  }) => {
    if (!shouldUseOpenAiGuidedRouting) return;
    recordOpenAiGuidedRoutingState({
      at: new Date().toISOString(),
      channel: conversationChannel,
      source: params.source,
      routeKind: params.routeKind || null,
      capabilityId: params.capabilityId || null,
      confidence: params.confidence || null,
      fallbackReason: params.fallbackReason || null,
      selectedModelTier: params.selectedModelTier || null,
      selectedModel: params.selectedModel || null,
      providerMode: params.providerMode || null,
    });
  };
  const maybeGetOpenAiGuidedRoute = async () => {
    if (!shouldUseOpenAiGuidedRouting) {
      return null;
    }
    if (openAiGuidedRouteChecked) {
      return openAiGuidedRouteResult;
    }
    openAiGuidedRouteChecked = true;
    const priorAssistantCapabilitySeed = getSharedAssistantCapabilitySeed(
      chatJid,
      now,
    );
    const priorDailyContext = getDailyCompanionContext(chatJid, now);
    openAiGuidedRouteResult = await routeCompanionTurnWithOpenAiBackend({
      channel: conversationChannel,
      text: openAiGuidedUserText,
      requestRoute: guidedRequestRoute,
      conversationSummary:
        priorAssistantCapabilitySeed?.summaryText ||
        priorDailyContext?.summaryText ||
        null,
      replyText: missedMessages.at(-1)?.reply_to?.content || null,
      priorPersonName: priorAssistantCapabilitySeed?.subjectData?.personName,
      priorThreadTitle: priorAssistantCapabilitySeed?.subjectData?.threadTitle,
      priorLastAnswerSummary:
        priorAssistantCapabilitySeed?.subjectData?.lastAnswerSummary,
    });
    return openAiGuidedRouteResult;
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
      !isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)
    ) {
      blueBubblesDirectTurnEnvelope = null;
      return blueBubblesDirectTurnEnvelope;
    }
    const priorAssistantCapabilitySeed = getSharedAssistantCapabilitySeed(
      chatJid,
      now,
    );
    const priorDailyContext = getDailyCompanionContext(chatJid, now);
    const routingResult = await maybeGetOpenAiGuidedRoute();
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
      routingResult,
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
      ownerAuthored: currentTurnOwnerAuthored,
      now,
    });
  };
  const tryHandleMessageActionFollowup = async (): Promise<boolean> => {
    const rawMessageActionText = lastContent;
    let messageActionCommandText =
      conversationChannel === 'bluebubbles'
        ? normalizeBlueBubblesCompanionPrompt(lastContent)
        : lastContent;
    let operation = interpretMessageActionFollowup(messageActionCommandText);
    if (!operation) {
      const interpretedTurn = await maybeInterpretBlueBubblesDirectTurn();
      if (
        interpretedTurn?.routeFamily === 'message_action_followup' &&
        interpretedTurn.assistantPrompt
      ) {
        const interpretedCommandText =
          conversationChannel === 'bluebubbles'
            ? normalizeBlueBubblesCompanionPrompt(
                interpretedTurn.assistantPrompt,
              )
            : interpretedTurn.assistantPrompt;
        operation = interpretMessageActionFollowup(interpretedCommandText);
        if (operation) {
          messageActionCommandText = interpretedCommandText;
        }
      }
    }
    if (!operation) return false;
    const messageAction = resolveMessageActionForFollowup({
      groupFolder: group.folder,
      chatJid,
      rawText: messageActionCommandText,
      replyToMessageId: latestUserMessage?.reply_to_id || null,
      includeStaleForDenial: true,
      now,
    });
    if (!messageAction) {
      if (
        conversationChannel === 'bluebubbles' &&
        operation.kind === 'defer' &&
        isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)
      ) {
        const started = startBlueBubblesProofDrill({
          groupFolder: group.folder,
          chatJid,
          now,
        });
        return applyAndPresentMessageAction({
          chatJid,
          messageActionId: started.action.messageActionId,
          operation,
          ownerAuthored: currentTurnOwnerAuthored,
          ownerAuthorizationAt: queuedOwnerAuthorizationAt,
          now,
        });
      }
      if (
        conversationChannel === 'bluebubbles' &&
        operation.kind === 'send' &&
        isBlueBubblesExplicitSendAlias(messageActionCommandText)
      ) {
        await sendAssistantReplyWithFeedback({
          text: 'Andrea: I do not have a draft open here yet.\n\nAsk what you should say back, or say `send a text message to <chat name>: <message>`.',
          routeKey: 'bluebubbles.outbound.missing_draft',
          capabilityId: 'communication.draft_reply',
          handlerKind: 'local_bluebubbles_outbound_request',
          responseSource: 'local_companion',
          traceReason:
            'asked for the missing draft context without claiming completion',
          replyKind: 'clarification',
        });
        return true;
      }
      return false;
    }
    if (conversationChannel === 'bluebubbles') {
      const continuity = reconcileBlueBubblesMessageActionContinuity({
        groupFolder: group.folder,
        chatJid,
        now,
        allowRehydrate: true,
      });
      if (
        !canApplyBlueBubblesMessageActionFollowup({
          rawText: rawMessageActionText,
          operation,
          continuity,
        })
      ) {
        return false;
      }
    }
    return applyAndPresentMessageAction({
      chatJid,
      messageActionId: messageAction.messageActionId,
      operation,
      ownerAuthored: currentTurnOwnerAuthored,
      ownerAuthorizationAt: queuedOwnerAuthorizationAt,
      now,
    });
  };
  const tryHandleExplicitBlueBubblesThreadSend = async (): Promise<boolean> => {
    if (
      conversationChannel !== 'telegram' &&
      conversationChannel !== 'bluebubbles'
    ) {
      return false;
    }
    const blueBubblesChannel = channels.find(
      (candidate): candidate is BlueBubblesChannel =>
        candidate instanceof BlueBubblesChannel,
    );
    const result = await executeBlueBubblesOutboundTurn({
      groupFolder: group.folder,
      channel: conversationChannel,
      chatJid,
      group,
      ownerAuthored: currentTurnOwnerAuthored,
      rawText: lastContent,
      inboundMessageId: latestUserMessage?.id || null,
      now,
      blueBubblesChannel,
      resolveContextBoundRecipient: async ({ intent }) => {
        if (!blueBubblesChannel) {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText:
                'I could not refresh Messages history before binding that contextual reply, so I did not send anything. Ask me to review recent texts again.',
            },
          };
        }
        if (intent.contextBinding?.kind === 'recent_recipient_thread') {
          if (!intent.targetLabel) {
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_unavailable' as const,
                replyText:
                  'I could not identify the Messages recipient for that recent-thread reply, so I did not send anything.',
              },
            };
          }
          const refreshedContext = await resolveRefreshedContextBoundRecipient({
            targetLabel: intent.targetLabel,
            replyContent: intent.content,
            resolveRecipient: resolveBlueBubblesThreadTargetByName,
            primeRecentHistory: () =>
              blueBubblesChannel.primeRecentHistory({ limit: 500 }),
            primeChatHistory: (targetChatJid) =>
              blueBubblesChannel.primeChatHistory(targetChatJid, {
                limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
              }),
            listRecentMessagesForChat,
          });
          if (refreshedContext.state === 'resolved') {
            return {
              state: 'resolved' as const,
              recipientResolution: refreshedContext.recipientResolution,
            };
          }
          if (refreshedContext.state === 'targeted_refresh_failed') {
            logger.warn(
              { component: 'assistant', err: refreshedContext.error },
              'BlueBubbles exact-thread contextual history refresh failed; dispatch blocked',
            );
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_unavailable' as const,
                replyText: `I could not refresh the exact Messages thread for ${refreshedContext.target.displayName}, so I did not create a draft or send anything. Ask me to summarize that thread again.`,
              },
            };
          }
          if (refreshedContext.state === 'global_refresh_failed') {
            logger.warn(
              { component: 'assistant', err: refreshedContext.error },
              'BlueBubbles bounded recipient discovery refresh failed; contextual dispatch blocked',
            );
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_unavailable' as const,
                replyText:
                  'I could not refresh the bounded recent Messages directory needed to find that named thread, so I did not create a draft or send anything. Use the exact phone/email or ask me to summarize the thread again.',
              },
            };
          }
          if (refreshedContext.state === 'ambiguous') {
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_mismatch' as const,
                replyText: `I found more than one locally known Messages conversation for ${intent.targetLabel}, so I did not create a draft or send anything. Use the exact conversation name or phone/email.`,
              },
            };
          }
          if (refreshedContext.state === 'missing') {
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_unavailable' as const,
                replyText: `I could not match ${intent.targetLabel} after a bounded recent-conversation discovery. A quiet thread can fall outside that global slice, so I did not create a draft or send anything. Use the exact phone/email or ask me to summarize that thread.`,
              },
            };
          }
          if (refreshedContext.state === 'context_stale') {
            return {
              state: 'blocked' as const,
              result: {
                handled: true as const,
                state: 'context_stale' as const,
                replyText: `After refreshing the exact Messages thread, the latest incoming message from ${refreshedContext.target.displayName} no longer matches the contextual reply you described, so I did not create a draft or send anything. Ask me to review that thread again.`,
              },
            };
          }
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText: `I refreshed the exact Messages thread for ${refreshedContext.target.displayName}, but could not verify a recent incoming message, so I did not create a draft or send anything.`,
            },
          };
        }
        if (intent.contextBinding?.kind !== 'recent_text_review_item') {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText:
                'I could not safely interpret that Messages context binding, so I did not send anything.',
            },
          };
        }
        const itemNumber = intent.contextBinding.itemNumber;
        const priorSeed = getSharedAssistantCapabilitySeed(chatJid, now);
        const seedJson = priorSeed?.subjectData?.recentTextReviewJson;
        const reviewFollowup = parseRecentTextReviewItemFollowup({
          seedJson,
          userText: lastContent,
        });
        if (
          !seedJson ||
          !isBoundRecentTextReviewItemFollowup(reviewFollowup) ||
          reviewFollowup.item.rank !== itemNumber
        ) {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText: `I could not safely bind item #${itemNumber} to the current text review, so I did not send anything. Ask me to review recent texts again, then choose from the fresh list.`,
            },
          };
        }
        const freshness =
          await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
            seedJson,
            item: reviewFollowup.item,
            now,
            primeChatHistory: (targetChatJid) =>
              blueBubblesChannel.primeChatHistory(targetChatJid, {
                limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
              }),
          });
        if (!freshness.ok) {
          recordRecentTextReviewOutcome({
            groupFolder: group.folder,
            item: reviewFollowup.item,
            outcome: freshness.outcome,
            now,
          });
          const exactRefreshFailed =
            freshness.reason === 'targeted_refresh_failed';
          if (exactRefreshFailed) {
            logger.warn(
              { component: 'assistant' },
              'BlueBubbles exact numbered-review thread refresh failed; dispatch blocked',
            );
          }
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: exactRefreshFailed
                ? ('context_unavailable' as const)
                : ('context_stale' as const),
              replyText: exactRefreshFailed
                ? `I could not refresh the exact Messages thread for item #${reviewFollowup.item.rank}, so I did not create a draft or send anything. Ask me to review recent texts again.`
                : formatRecentTextReviewFreshnessBlockedReply(
                    reviewFollowup.item,
                    freshness,
                  ),
            },
          };
        }
        const reviewTarget =
          freshness.target ||
          resolveRecentTextReviewFollowupTarget(reviewFollowup.item);
        if (!reviewTarget.ok || !reviewTarget.chatJid) {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText: `I could not safely resolve item #${reviewFollowup.item.rank} to one current Messages conversation, so I did not send anything. Ask me to review recent texts again.`,
            },
          };
        }
        const reviewLabel =
          reviewTarget.personName || reviewFollowup.item.chatLabel;
        const labelsAgree = doContextBoundRecipientLabelsMatch(
          intent.targetLabel,
          reviewLabel,
        );
        if (!reviewLabel || !labelsAgree) {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_mismatch' as const,
              replyText: `Item #${reviewFollowup.item.rank} is ${reviewTarget.personName || reviewFollowup.item.chatLabel}, but your instruction named ${intent.targetLabel || 'a different recipient'}. I did not send anything.`,
            },
          };
        }
        const recentTextReview = buildRecentTextReviewMessageActionLink({
          groupFolder: group.folder,
          presentationChatJid: chatJid,
          targetChatJid: reviewTarget.chatJid!,
          seedJson,
          item: {
            itemId: reviewFollowup.item.itemId,
            rank: reviewFollowup.item.rank,
            communicationThreadId:
              reviewTarget.communicationThreadId ||
              reviewFollowup.item.communicationThreadId ||
              null,
          },
        });
        if (!recentTextReview) {
          return {
            state: 'blocked' as const,
            result: {
              handled: true as const,
              state: 'context_unavailable' as const,
              replyText: `I could not durably bind item #${reviewFollowup.item.rank} to this exact draft, so I did not create or send anything. Ask me to review recent texts again.`,
            },
          };
        }
        return {
          state: 'resolved' as const,
          recentTextReview,
          recipientResolution: {
            state: 'resolved' as const,
            target: {
              chatJid: reviewTarget.chatJid,
              displayName:
                reviewTarget.personName || reviewFollowup.item.chatLabel,
              isGroup: Boolean(reviewTarget.isGroup),
            },
          },
        };
      },
      executionDeps: {
        groupFolder: group.folder,
        channel: conversationChannel,
        chatJid,
        currentTime: now,
        ownerAuthorizationAt: queuedOwnerAuthorizationAt,
        primeMessagesChatHistory: (targetChatJid) => {
          if (!blueBubblesChannel) {
            throw new Error('BlueBubbles history refresh is unavailable.');
          }
          return blueBubblesChannel.primeChatHistory(targetChatJid, {
            limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
          });
        },
        onVerifiedSend: (action) => {
          completeRecentTextReviewMessageActionLifecycle({ action, now });
        },
        sendToTarget: (targetChannel, targetChatJid, text, options) =>
          sendCompanionHandoffMessage(
            targetChannel,
            targetChatJid,
            text,
            options,
          ),
      },
      onRefreshFailure: (error) =>
        logger.warn(
          { component: 'assistant', err: error },
          'BlueBubbles explicit-send transport refresh failed',
        ),
      onRecipientLookupFailure: (error) =>
        logger.warn(
          { component: 'assistant', err: error },
          'BlueBubbles exact live-contact validation failed; dispatch blocked',
        ),
    });
    if (!result.handled) return false;
    if (
      conversationChannel === 'bluebubbles' &&
      currentTurnOwnerAuthored !== true &&
      result.state === 'restricted'
    ) {
      logger.info(
        { chatJid, messageId: latestUserMessage?.id || null },
        'Ignored non-owner-authored BlueBubbles outbound instruction',
      );
      return true;
    }
    if (result.state !== 'staged') {
      await sendAssistantReplyWithFeedback({
        text: result.replyText,
        routeKey: `bluebubbles.outbound.${result.state}`,
        capabilityId: 'messages.send.bluebubbles',
        handlerKind: 'local_bluebubbles_outbound_request',
        responseSource: 'local_companion',
        traceReason:
          result.state === 'sent'
            ? 'executed an explicitly authorized BlueBubbles send with a verified provider receipt'
            : 'grounded the BlueBubbles execution response in the authoritative capability or delivery state',
        allowFeedback: false,
        ...('action' in result
          ? { linkedRefs: { messageActionId: result.action.messageActionId } }
          : {}),
        latencyTargetClass: 'local_command',
        replyKind:
          result.state === 'sent'
            ? 'completion'
            : result.state === 'confirmation_required'
              ? 'approval_request'
              : result.state === 'capability_status'
                ? 'progress'
                : [
                      'missing_target',
                      'ambiguous_target',
                      'unsupported_target',
                      'context_unavailable',
                      'context_stale',
                      'context_mismatch',
                    ].includes(result.state)
                  ? 'clarification'
                  : 'blocked_notice',
      });
      return true;
    }

    const sent = await sendAssistantReplyWithFeedback({
      text: result.presentation.text,
      sendOptions:
        conversationChannel === 'telegram'
          ? { inlineActionRows: result.presentation.inlineActionRows }
          : {},
      routeKey: 'bluebubbles.outbound.staged',
      capabilityId: 'communication.draft_reply',
      handlerKind: 'local_bluebubbles_outbound_request',
      responseSource: 'local_companion',
      traceReason:
        'staged an exact recipient-bound BlueBubbles draft; every fresh imperative requires a separate approval before dispatch',
      linkedRefs: { messageActionId: result.action.messageActionId },
      preserveStructuredText: true,
      replyKind: 'approval_request',
      latencyTargetClass: 'local_command',
    });
    if (conversationChannel === 'bluebubbles') {
      syncBlueBubblesMessageActionPresentation({
        groupFolder: group.folder,
        chatJid,
        messageActionId: result.action.messageActionId,
        platformMessageId: sent.platformMessageId || null,
        now,
      });
    } else {
      updateMessageAction(result.action.messageActionId, {
        presentationMessageId:
          sent.platformMessageId || sent.platformMessageIds?.[0] || null,
        presentationChatJid: chatJid,
        lastUpdatedAt: now.toISOString(),
      });
    }
    return true;
  };
  const tryHandleOutcomeReview = async (): Promise<boolean> => {
    const reviewPrompt = matchOutcomeReviewPrompt(lastContent);
    if (reviewPrompt) {
      if (
        conversationChannel === 'telegram' &&
        reviewPrompt.kind === 'still_open_person'
      ) {
        return false;
      }
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
      const sent = acceptConfirmedPresentationDelivery({
        result: await sendCognitiveTurnReply({
          text: presentation.text,
          sendOptions: withQueuedBlueBubblesAuthorization({
            inlineActionRows: presentation.inlineActionRows,
          }),
          replyKind: 'progress',
          routeKey: 'outcome_review.presentation',
          capabilityId: 'outcome_review.read',
        }),
        channel: channel.name,
        chatJid,
        workflow: 'outcome_review_presentation',
        onUnverified: () => inFlightCursorRollbacks.markDelivered(chatJid),
      });
      if (!sent) return true;
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
      ownerAuthored: currentTurnOwnerAuthored,
      now,
    });
  };
  const tryHandleDelegationRules = async (): Promise<boolean> => {
    const intent = interpretDelegationRuleUtterance(lastContent);
    if (!intent) return false;

    if (conversationChannel === 'bluebubbles') {
      await sendCognitiveTurnReply({
        text: 'Andrea: I can honor your usual safe defaults here, but rule setup and editing works best in Telegram. Ask me to send the rule details there if you want to manage them.',
        sendOptions: withQueuedBlueBubblesAuthorization(),
        replyKind: 'progress',
        routeKey: 'delegation_rules.channel_guidance',
      });
      return true;
    }

    if (intent.kind === 'show_rules') {
      const presentation = buildDelegationRuleListPresentation({
        groupFolder: group.folder,
        channel: conversationChannel,
      });
      const sent = acceptConfirmedPresentationDelivery({
        result: await sendCognitiveTurnReply({
          text: presentation.text,
          sendOptions: withQueuedBlueBubblesAuthorization({
            inlineActionRows: presentation.inlineActionRows,
          }),
          replyKind: 'progress',
          routeKey: 'delegation_rules.list',
        }),
        channel: channel.name,
        chatJid,
        workflow: 'delegation_rule_list_presentation',
        onUnverified: () => inFlightCursorRollbacks.markDelivered(chatJid),
      });
      if (!sent) return true;
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
        ownerAuthored: currentTurnOwnerAuthored,
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
      await sendCognitiveTurnReply({
        text: previewResult.clarificationQuestion,
        sendOptions: withQueuedBlueBubblesAuthorization(),
        replyKind: 'clarification',
        routeKey: 'delegation_rules.clarification',
      });
      return true;
    }
    if (!previewResult.preview) return false;
    const presentation = buildDelegationRulePreviewPresentation(
      previewResult.preview,
    );
    const sent = acceptConfirmedPresentationDelivery({
      result: await sendCognitiveTurnReply({
        text: presentation.text,
        sendOptions: withQueuedBlueBubblesAuthorization({
          inlineActionRows: presentation.inlineActionRows,
        }),
        replyKind: 'approval_request',
        routeKey: 'delegation_rules.preview',
      }),
      channel: channel.name,
      chatJid,
      workflow: 'delegation_rule_preview_presentation',
      onUnverified: () => inFlightCursorRollbacks.markDelivered(chatJid),
    });
    if (!sent) return true;
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Calendar Automation*',
              result.message,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'progress',
            routeKey: 'calendar_automation.cancelled',
          });
          return true;
        }
        if (result.kind === 'awaiting_input') {
          setPendingCalendarAutomationState(chatJid, result.state);
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Calendar Automation*',
              result.message,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarAutomationInlineActionRows(
                result.state,
              ),
            },
            replyKind: 'clarification',
            routeKey: 'calendar_automation.awaiting_input',
          });
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Calendar Automation*',
              `Paused "${confirmedState.draft.label}".`,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'completion',
            routeKey: 'calendar_automation.paused',
          });
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
          updateTask(
            confirmedState.targetTaskId,
            withQueuedBlueBubblesTaskAuthorization({
              prompt: `Calendar automation: ${confirmedState.draft.label}`,
              schedule_type: confirmedState.draft.config.schedule.scheduleType,
              schedule_value:
                confirmedState.draft.config.schedule.scheduleValue,
              next_run: nextRun,
              status: 'active',
            }),
          );
          updateCalendarAutomation(confirmedState.targetTaskId, {
            label: confirmedState.draft.label,
            config_json: JSON.stringify(confirmedState.draft.config),
            dedupe_state_json: configChanged ? null : undefined,
            updated_at: now.toISOString(),
          });
          refreshTaskSnapshots(registeredGroups);
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
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
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'completion',
            routeKey: 'calendar_automation.resumed',
          });
          return true;
        }

        if (confirmedState.mode === 'delete' && confirmedState.targetTaskId) {
          deleteTask(confirmedState.targetTaskId);
          refreshTaskSnapshots(registeredGroups);
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Calendar Automation*',
              `Deleted "${confirmedState.draft.label}".`,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'completion',
            routeKey: 'calendar_automation.deleted',
          });
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
          updateTask(
            persistInput.replaceTaskId,
            withQueuedBlueBubblesTaskAuthorization({
              prompt: persistInput.task.prompt,
              schedule_type: persistInput.task.schedule_type,
              schedule_value: persistInput.task.schedule_value,
              next_run: persistInput.task.next_run,
              status: persistInput.task.status,
            }),
          );
          updateCalendarAutomation(persistInput.replaceTaskId, {
            label: persistInput.automation.label,
            config_json: persistInput.automation.config_json,
            dedupe_state_json: null,
            updated_at: now.toISOString(),
          });
        } else {
          createTask(withQueuedBlueBubblesTaskAuthorization(persistInput.task));
          createCalendarAutomation({
            ...persistInput.automation,
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
          });
        }

        refreshTaskSnapshots(registeredGroups);
        await sendCognitiveTurnReply({
          text: formatCalendarPanelText(
            '*Calendar Automation*',
            persistInput.replaceTaskId
              ? persistInput.task.status === 'paused'
                ? `Updated automation:\n- ${confirmedState.draft.label}\nIt will stay paused until you resume it.`
                : `Updated automation:\n- ${confirmedState.draft.label}`
              : `Saved automation:\n- ${confirmedState.draft.label}`,
          ),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
          replyKind: 'completion',
          routeKey: 'calendar_automation.saved',
        });
        return true;
      }

      const plan = await planCalendarAutomation(lastContent, now, automations);
      if (plan.kind === 'none') {
        return false;
      }

      if (plan.kind === 'list') {
        await sendCognitiveTurnReply({
          text: formatCalendarPanelText('*Calendar Automations*', plan.message),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(
              CALENDAR_LOOKUP_TOMORROW_PROMPT,
            ),
          },
          replyKind: 'progress',
          routeKey: 'calendar_automation.list',
        });
        return true;
      }

      setPendingCalendarAutomationState(chatJid, plan.state);
      await sendCognitiveTurnReply({
        text: formatCalendarPanelText('*Calendar Automation*', plan.message),
        sendOptions: {
          inlineActionRows: buildCalendarAutomationInlineActionRows(plan.state),
        },
        replyKind: 'approval_request',
        routeKey: 'calendar_automation.confirmation',
      });
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
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText('*Calendar*', result.message),
                sendOptions: {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
                replyKind: 'progress',
                routeKey: 'calendar_reminder.cancelled',
              });
              return true;
            }
            if (result.kind === 'invalid') {
              clearPendingCalendarReminderState(chatJid);
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText('*Calendar*', result.message),
                sendOptions: {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
                replyKind: 'clarification',
                routeKey: 'calendar_reminder.invalid',
              });
              return true;
            }
            if (result.kind === 'awaiting_input') {
              setPendingCalendarReminderState(chatJid, result.state);
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText('*Calendar*', result.message),
                sendOptions: {
                  inlineActionRows: buildCalendarReminderInlineActionRows(
                    result.state,
                  ),
                },
                replyKind: 'clarification',
                routeKey: 'calendar_reminder.awaiting_input',
              });
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
              createTask(withQueuedBlueBubblesTaskAuthorization(task));
            }
            if (reminderPlan.task) {
              createTask(
                withQueuedBlueBubblesTaskAuthorization(reminderPlan.task),
              );
            }
            refreshTaskSnapshots(registeredGroups);
            clearPendingCalendarReminderState(chatJid);
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Calendar*',
                reminderPlan.confirmation,
              ),
              sendOptions: {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
              replyKind: 'completion',
              routeKey: 'calendar_reminder.created',
            });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                result.message,
              ),
              sendOptions: {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
              replyKind: 'progress',
              routeKey: 'google_calendar.action_cancelled',
            });
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
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText(
                  '*Google Calendar*',
                  `I couldn't find a ${result.anchorTime.displayLabel} meeting to schedule around on that day.`,
                ),
                sendOptions: {
                  inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                    result.state,
                  ),
                },
                replyKind: 'clarification',
                routeKey: 'google_calendar.anchor_missing',
              });
              return true;
            }
            if (matches.length > 1) {
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText(
                  '*Google Calendar*',
                  `I found more than one event around ${result.anchorTime.displayLabel}. Tell me which one you mean.`,
                ),
                sendOptions: {
                  inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                    result.state,
                  ),
                },
                replyKind: 'clarification',
                routeKey: 'google_calendar.anchor_ambiguous',
              });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                formatPendingGoogleCalendarEventActionPrompt(movedState),
              ),
              sendOptions: {
                inlineActionRows:
                  buildGoogleCalendarEventActionInlineRows(movedState),
              },
              replyKind: 'approval_request',
              routeKey: 'google_calendar.action_confirmation',
            });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                formatPendingGoogleCalendarEventActionPrompt(enrichedState),
              ),
              sendOptions: {
                inlineActionRows:
                  buildGoogleCalendarEventActionInlineRows(enrichedState),
              },
              replyKind: 'clarification',
              routeKey: 'google_calendar.action_input',
            });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                `Deleted "${result.state.sourceEvent.title}".`,
              ),
              sendOptions: {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
              replyKind: 'completion',
              routeKey: 'google_calendar.event_deleted',
            });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
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
              sendOptions: {
                inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
                  htmlLink: movedEvent.htmlLink || null,
                }),
              },
              replyKind: 'completion',
              routeKey: 'google_calendar.event_reassigned',
            });
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
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
            sendOptions: {
              inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
                htmlLink: updatedEvent.htmlLink || null,
              }),
            },
            replyKind: 'completion',
            routeKey: 'google_calendar.event_updated',
          });
          return true;
        }

        const reminderPlan = freshReminderPlan;
        if (reminderPlan.kind !== 'none') {
          if (reminderPlan.kind === 'needs_event_context') {
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText('*Calendar*', reminderPlan.message),
              sendOptions: {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
              replyKind: 'clarification',
              routeKey: 'calendar_reminder.event_context_needed',
            });
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
              await sendCognitiveTurnReply({
                text: buildCalendarCompanionFailurePanelText({
                  title: '*Calendar*',
                  channelName: channel.name,
                  action: 'confirm_reminder',
                  technicalDetail: failures.join('; '),
                }),
                sendOptions: {
                  inlineActionRows: buildCalendarLookupInlineActionRows(
                    CALENDAR_LOOKUP_TOMORROW_PROMPT,
                  ),
                },
                replyKind: 'blocked_notice',
                routeKey: 'calendar_reminder.lookup_blocked',
              });
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
              await sendCognitiveTurnReply({
                text: formatCalendarPanelText('*Calendar*', resolved.message),
                sendOptions: {
                  inlineActionRows: buildCalendarReminderInlineActionRows(
                    resolved.state,
                  ),
                },
                replyKind: 'clarification',
                routeKey: 'calendar_reminder.lookup_clarification',
              });
              return true;
            }

            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Calendar*',
                'message' in resolved
                  ? resolved.message
                  : "I couldn't set that reminder from the events I found.",
              ),
              sendOptions: {
                inlineActionRows: buildCalendarLookupInlineActionRows(
                  CALENDAR_LOOKUP_TOMORROW_PROMPT,
                ),
              },
              replyKind: 'blocked_notice',
              routeKey: 'calendar_reminder.lookup_unresolved',
            });
            return true;
          }

          setPendingCalendarReminderState(chatJid, reminderPlan.state);
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText('*Calendar*', reminderPlan.message),
            sendOptions: {
              inlineActionRows: buildCalendarReminderInlineActionRows(
                reminderPlan.state,
              ),
            },
            replyKind: 'approval_request',
            routeKey: 'calendar_reminder.confirmation',
          });
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Google Calendar*',
              actionPlanPreview.message,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'clarification',
            routeKey: 'google_calendar.event_context_needed',
          });
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Google Calendar*',
              actionPlan.message,
            ),
            sendOptions: {
              inlineActionRows: buildCalendarLookupInlineActionRows(
                CALENDAR_LOOKUP_TOMORROW_PROMPT,
              ),
            },
            replyKind: 'clarification',
            routeKey: 'google_calendar.event_context_needed',
          });
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
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                `I couldn't find a ${actionPlan.anchorTime.displayLabel} meeting to schedule around on that day.`,
              ),
              sendOptions: {
                inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                  actionPlan.state,
                ),
              },
              replyKind: 'clarification',
              routeKey: 'google_calendar.anchor_missing',
            });
            return true;
          }
          if (matches.length > 1) {
            await sendCognitiveTurnReply({
              text: formatCalendarPanelText(
                '*Google Calendar*',
                `I found more than one event around ${actionPlan.anchorTime.displayLabel}. Tell me which one you mean.`,
              ),
              sendOptions: {
                inlineActionRows: buildGoogleCalendarEventActionInlineRows(
                  actionPlan.state,
                ),
              },
              replyKind: 'clarification',
              routeKey: 'google_calendar.anchor_ambiguous',
            });
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
          await sendCognitiveTurnReply({
            text: formatCalendarPanelText(
              '*Google Calendar*',
              formatPendingGoogleCalendarEventActionPrompt(movedState),
            ),
            sendOptions: {
              inlineActionRows:
                buildGoogleCalendarEventActionInlineRows(movedState),
            },
            replyKind: 'approval_request',
            routeKey: 'google_calendar.action_confirmation',
            capabilityId: 'google_calendar.event_action',
          });
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
        await sendCognitiveTurnReply({
          text: formatCalendarPanelText(
            '*Google Calendar*',
            formatPendingGoogleCalendarEventActionPrompt(enrichedState),
          ),
          sendOptions: {
            inlineActionRows:
              buildGoogleCalendarEventActionInlineRows(enrichedState),
          },
          replyKind: 'approval_request',
          routeKey: 'google_calendar.action_confirmation',
          capabilityId: 'google_calendar.event_action',
        });
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
    const compoundRequest = compoundCalendarResearchPlan;
    const calendarRequestText =
      compoundRequest?.calendarText?.trim() || lastContent;
    const compoundResearchPersonalContextMode = compoundRequest
      ? resolveExplicitResearchPersonalContextMode(compoundRequest.researchText)
      : null;
    const compoundResearchErrorClass = (error: unknown): string =>
      error instanceof Error
        ? error.name.replace(/[^a-z0-9_.-]/gi, '').slice(0, 80) || 'Error'
        : typeof error;
    const explicitCreate =
      isExplicitGoogleCalendarCreateRequest(calendarRequestText);
    // A new compound request supersedes an unfinished draft, but never discard
    // a provider receipt. The latter is the only evidence we have that the
    // approved write already happened if delivery was interrupted.
    if (
      activePendingState &&
      compoundRequest &&
      !getPendingGoogleCalendarCreatedEvent(activePendingState)
    ) {
      clearPendingGoogleCalendarCreateState(chatJid);
      clearGoogleCalendarSchedulingContext(chatJid);
      activePendingState = null;
    }
    const reconciledCreatedEvent = activePendingState
      ? getPendingGoogleCalendarCreatedEvent(activePendingState)
      : null;
    if (activePendingState && reconciledCreatedEvent) {
      try {
        const selectedCalendar = activePendingState.calendars.find(
          (calendar) => calendar.id === reconciledCreatedEvent.calendarId,
        );
        setActiveGoogleCalendarEventContext(
          chatJid,
          buildActiveGoogleCalendarEventContextState(
            reconciledCreatedEvent,
            now,
          ),
        );
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            '*Google Calendar*',
            buildCalendarCompanionEventReply({
              action: 'create_event',
              title: activePendingState.draft.title,
              startIso: reconciledCreatedEvent.startIso,
              endIso: reconciledCreatedEvent.endIso,
              allDay: activePendingState.draft.allDay,
              timeZone: activePendingState.draft.timeZone,
              calendarName:
                selectedCalendar?.summary ||
                reconciledCreatedEvent.calendarName ||
                'Google Calendar',
              htmlLink: reconciledCreatedEvent.htmlLink || null,
            }),
          ),
          sendOptions: {
            inlineActionRows: buildGoogleCalendarCreatedInlineActionRows({
              htmlLink: reconciledCreatedEvent.htmlLink || null,
            }),
          },
          routeKey: 'google_calendar.create_event',
          capabilityId: 'calendar.google_create',
          handlerKind: 'google_calendar_create_local',
          responseSource: 'local_companion',
          traceReason:
            'reconciled a calendar event that was created before delivery completed',
          linkedRefs: {
            googleCalendarEventId: reconciledCreatedEvent.id,
          },
          replyKind: 'completion',
        });
        clearPendingGoogleCalendarCreateState(chatJid);
        clearGoogleCalendarSchedulingContext(chatJid);
        return true;
      } catch (error) {
        if (isCommittedIncompleteDeliveryError(error)) throw error;
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err: error },
          'Calendar create reconciliation reply failed; retained the provider receipt for retry',
        );
        return false;
      }
    }
    const startCompoundResearch = compoundRequest
      ? () =>
          executeAssistantCapability({
            capabilityId: inferResearchCapabilityId(
              compoundRequest.researchText,
            ),
            context: {
              channel: conversationChannel,
              groupFolder: group.folder,
              chatJid,
              ownerReviewAllowed: isTrustedOwnerReviewSurface({
                channelName: conversationChannel,
                chatJid,
                group,
                ownerAuthored: currentTurnOwnerAuthored,
              }),
              currentMessageId: latestUserMessage?.id,
              now,
              conversationSummary:
                getSharedAssistantCapabilitySeed(chatJid, now)?.summaryText ||
                getDailyCompanionContext(chatJid, now)?.summaryText,
            },
            input: {
              text: compoundRequest.researchText,
              canonicalText: compoundRequest.researchText,
              researchDepth: compoundRequest.requestedDepth,
              allowWebSearch: compoundRequest.allowWebSearch,
              personalContextMode:
                compoundResearchPersonalContextMode || 'disabled',
              researchFollowupMode: 'explicit_only',
            },
          })
      : null;
    const deliverCompoundResearchFailure = async (
      error: unknown,
    ): Promise<void> => {
      if (!compoundRequest) return;
      const errorClass = compoundResearchErrorClass(error);
      await sendAssistantReplyWithFeedback({
        text: formatCalendarPanelText(
          '*Research*',
          'I could not complete the research leg cleanly. The calendar response I just sent still stands, and no calendar write happened. Ask me to retry the research when the provider is available.',
        ),
        routeKey: 'compound.calendar_research',
        capabilityId: inferResearchCapabilityId(compoundRequest.researchText),
        handlerKind: 'assistant_capability',
        responseSource: 'unavailable',
        traceReason:
          'the read-only research leg of a compound calendar request was blocked',
        blockerClass: 'compound_calendar_research_unavailable',
        skipCursorDeliveryMark: true,
        deliveryOrdinal: 2,
        recordMetricEnabled: true,
        replyKind: 'blocked_notice',
      });
      logger.warn(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          routeKey: 'compound.calendar_research',
          requestedDepth: compoundRequest.requestedDepth,
          allowWebSearch: compoundRequest.allowWebSearch,
          errorClass,
        },
        'Compound calendar research leg did not complete',
      );
    };
    const deliverCompoundResearchResult = async (
      result: AssistantCapabilityResult,
    ): Promise<void> => {
      if (!compoundRequest) return;
      if (!result.handled) {
        await deliverCompoundResearchFailure(
          new Error('The selected research capability declined the request.'),
        );
        return;
      }
      await sendAssistantReplyWithFeedback({
        text: result.replyText || 'The research completed.',
        sendOptions: result.sendOptions || {},
        routeKey: 'compound.calendar_research',
        capabilityId:
          result.capabilityId ||
          inferResearchCapabilityId(compoundRequest.researchText),
        providerId: result.researchResult?.providerUsed || null,
        toolClass: 'compound_read_only_research',
        handlerKind: result.trace?.handlerKind || 'assistant_capability',
        responseSource: result.trace?.responseSource || 'local_companion',
        traceReason:
          result.trace?.reason ||
          'completed the read-only research leg of a compound calendar request',
        traceNotes: [
          ...(result.trace?.notes || []),
          `compound_research_depth:${compoundRequest.requestedDepth}`,
          `compound_web_search:${compoundRequest.allowWebSearch ? 'allowed' : 'disabled'}`,
          `compound_personal_context:${compoundResearchPersonalContextMode || 'disabled'}`,
          `compound_explicit_max_effort:${compoundRequest.explicitMaxEffort ? 'yes' : 'no'}`,
        ],
        skipCursorDeliveryMark: true,
        deliveryOrdinal: 2,
        recordMetricEnabled: true,
        replyKind: 'completion',
      });
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          routeKey: 'compound.calendar_research',
          capabilityId: result.capabilityId,
          requestedDepth: compoundRequest.requestedDepth,
          allowWebSearch: compoundRequest.allowWebSearch,
          explicitMaxEffort: compoundRequest.explicitMaxEffort,
          conversationSeedSuppressed: Boolean(result.conversationSeed),
        },
        'Delivered compound calendar research result after calendar response',
      );
    };
    const deliverCalendarReplyThenCompoundResearch = async (
      deliverCalendarReply: () => Promise<void>,
    ): Promise<void> => {
      const background = await deliverPrimaryThenStartReadOnlySidecar({
        deliverPrimary: deliverCalendarReply,
        startSidecar: startCompoundResearch,
        deliverResult: deliverCompoundResearchResult,
        deliverFailure: deliverCompoundResearchFailure,
        onSidecarDeliveryError: (error) => {
          logger.error(
            {
              component: 'assistant',
              chatJid,
              groupFolder: group.folder,
              group: group.name,
              routeKey: 'compound.calendar_research',
              errorClass: compoundResearchErrorClass(error),
            },
            'Calendar response was delivered but the compound research result could not be delivered',
          );
        },
      });
      if (background) {
        void background.completion.catch((error) => {
          logger.error(
            {
              component: 'assistant',
              chatJid,
              groupFolder: group.folder,
              group: group.name,
              routeKey: 'compound.calendar_research',
              errorClass: compoundResearchErrorClass(error),
            },
            'Unexpected rejection escaped the compound research background boundary',
          );
        });
      }
    };
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
          calendarRequestText,
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
      const activeSchedulingContext =
        getGoogleCalendarSchedulingContext(chatJid);
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
            calendarRequestText,
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
          await deliverCalendarReplyThenCompoundResearch(async () => {
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
              traceReason:
                'google calendar create fast path hit a provider failure',
              blockerClass: technicalDetail,
              blockerOwner: 'external',
              replyKind: 'blocked_notice',
            });
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
          if (isCommittedIncompleteDeliveryError(sendError)) throw sendError;
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
        if (compoundRequest) {
          try {
            await deliverCalendarReplyThenCompoundResearch(async () => {
              await sendAssistantReplyWithFeedback({
                text: formatCalendarPanelText(
                  '*Google Calendar*',
                  'I recognized the calendar part, but I still need the event title, date, and time before I can prepare a safe draft. I did not create anything.',
                ),
                routeKey: 'compound.calendar_research',
                capabilityId: 'calendar.google_create',
                handlerKind: 'google_calendar_create_local',
                responseSource: 'local_companion',
                traceReason:
                  'compound calendar request needed more event details before drafting',
                replyKind: 'clarification',
              });
            });
            return true;
          } catch (error) {
            if (isCommittedIncompleteDeliveryError(error)) throw error;
            lastAgentTimestamp[chatJid] = previousCursor;
            saveState();
            logger.warn(
              {
                component: 'assistant',
                chatJid,
                groupFolder: group.folder,
                group: group.name,
                routeKey: 'compound.calendar_research',
                err: error,
              },
              'Compound calendar clarification could not be delivered; rolled back cursor for retry',
            );
            return false;
          }
        }
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
                ...(compoundRequest
                  ? { confirmationMode: 'calendar_targeted' as const }
                  : {}),
                now,
              }),
            )
          : null;
      const pendingStateToPersist =
        pendingDraftState ||
        (createPlan.kind === 'needs_details' && !noWritableCalendars
          ? createPlan.pendingState
            ? {
                ...createPlan.pendingState,
                ...(compoundRequest
                  ? { confirmationMode: 'calendar_targeted' as const }
                  : {}),
              }
            : null
          : null);
      const reply =
        createPlan.kind === 'needs_details'
          ? createPlan.message
          : noWritableCalendars
            ? buildCalendarCompanionFailureReply({
                channel: resolveConversationalChannelForChannelName(
                  channel.name,
                ),
                action: 'create_event',
                kind: 'calendar_auth_unavailable',
              })
            : formatGoogleCalendarCreatePrompt(pendingDraftState!);
      const calendarDraftTraceReason =
        createPlan.kind === 'needs_details'
          ? 'google calendar create is waiting on one missing detail'
          : 'google calendar create draft is ready for confirmation';
      const calendarDraftReplyKind: CognitiveReplyKind =
        createPlan.kind === 'needs_details'
          ? 'clarification'
          : noWritableCalendars
            ? 'blocked_notice'
            : 'approval_request';

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
        await deliverCalendarReplyThenCompoundResearch(async () => {
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
            traceReason: calendarDraftTraceReason,
            replyKind: calendarDraftReplyKind,
          });
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
        if (isCommittedIncompleteDeliveryError(err)) throw err;
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
          replyKind: 'progress',
        });
        return true;
      } catch (err) {
        if (isCommittedIncompleteDeliveryError(err)) throw err;
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
            replyKind: 'clarification',
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
            replyKind: 'clarification',
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
          replyKind: 'approval_request',
        });
        return true;
      } catch (err) {
        if (isCommittedIncompleteDeliveryError(err)) throw err;
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
          replyKind: 'approval_request',
        });
        return true;
      } catch (err) {
        if (isCommittedIncompleteDeliveryError(err)) throw err;
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
          idempotencyKey: getGoogleCalendarCreateIdempotencyKey(
            continueResult.state,
          ),
        },
        googleConfig,
      );
      const selectedCalendar = continueResult.state.calendars.find(
        (calendar) => calendar.id === continueResult.calendarId,
      );
      setPendingGoogleCalendarCreateState(
        chatJid,
        recordPendingGoogleCalendarCreateSuccess(
          continueResult.state,
          createdEvent,
          now,
        ),
      );
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
        traceReason:
          'created a google calendar event through the local fast path',
        linkedRefs: {
          googleCalendarEventId: createdEvent.id,
        },
        replyKind: 'completion',
      });
      clearPendingGoogleCalendarCreateState(chatJid);
      clearGoogleCalendarSchedulingContext(chatJid);
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
      if (isCommittedIncompleteDeliveryError(error)) throw error;
      const persistedCreateState = getPendingGoogleCalendarCreateState(chatJid);
      if (
        persistedCreateState &&
        getPendingGoogleCalendarCreatedEvent(persistedCreateState)
      ) {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err: error },
          'Calendar event was created but its confirmation was not delivered; retained the receipt for reconciliation',
        );
        return false;
      }
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
          traceReason: 'google calendar create failed after confirmation',
          blockerClass: technicalDetail,
          blockerOwner: 'external',
          replyKind: 'blocked_notice',
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
        if (isCommittedIncompleteDeliveryError(sendError)) throw sendError;
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

      for (const pendingActionReminder of getPendingActionReminderStates(
        chatJid,
      )) {
        if (isPendingActionReminderExpired(pendingActionReminder, now)) {
          clearPendingActionReminderState(chatJid, pendingActionReminder);
        }
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
      const activeActionReminders = getPendingActionReminderStates(chatJid);
      let activeActionReminder =
        activeActionReminders.length === 1 ? activeActionReminders[0]! : null;
      let reminderContinuationText = lastContent;
      if (activeActionReminders.length > 1 && !freshIntent) {
        const resolved = resolvePendingActionReminderContinuation(
          activeActionReminders,
          lastContent,
        );
        if (!resolved) {
          await sendAssistantReplyWithFeedback({
            text: formatCalendarPanelText(
              '*Next Step*',
              formatPendingActionReminderDisambiguation(activeActionReminders),
            ),
            routeKey: 'local_reminder.clarify',
            capabilityId: 'capture.reminder',
            handlerKind: 'local_reminder',
            responseSource: 'local_companion',
            traceReason:
              'refused to bind an ambiguous timing answer across pending reminders',
            replyKind: 'clarification',
          });
          return true;
        }
        activeActionReminder = resolved.state;
        reminderContinuationText = resolved.timingText;
      }
      if (activeActionReminder) {
        if (freshIntent) {
          if (freshIntent.kind !== 'capture_reminder') {
            clearPendingActionReminderState(chatJid, activeActionReminder);
          }
        } else if (shouldInterruptPendingActionFlow) {
          clearPendingActionReminderState(chatJid);
          return false;
        } else {
          const continued = advancePendingActionReminder(
            reminderContinuationText,
            activeActionReminder,
            {
              groupFolder: group.folder,
              chatJid,
              now,
            },
          );
          if (continued.kind === 'awaiting_reminder_time') {
            setPendingActionReminderState(chatJid, continued.state);
            await sendAssistantReplyWithFeedback({
              text: formatCalendarPanelText('*Next Step*', continued.message),
              sendOptions: {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
              routeKey: 'local_reminder.clarify',
              capabilityId: 'capture.reminder',
              handlerKind: 'local_reminder',
              responseSource: 'local_companion',
              traceReason:
                'persisted a scoped reminder clarification before delivery',
              replyKind: 'clarification',
            });
            return true;
          }
          if (continued.kind === 'none') {
            clearPendingActionReminderState(chatJid, activeActionReminder);
            return false;
          }
          if (continued.kind === 'created_reminder') {
            const persisted = persistReminderOperation({
              confirmation: continued.confirmation,
              task: continued.task,
            });
            syncOutcomeFromReminderTask(persisted.task, {
              linkedRefs: {
                reminderTaskId: continued.task.id,
                chatJid,
              },
              summaryText: continued.confirmation,
              now,
            });
            refreshTaskSnapshots(registeredGroups);
            if (continued.state) {
              clearPendingActionReminderState(chatJid, activeActionReminder);
              setPendingActionReminderState(chatJid, continued.state);
            }
            if (continued.actionContext) {
              setActionLayerContext(chatJid, continued.actionContext);
            }
            await sendAssistantReplyWithFeedback({
              text: formatCalendarPanelText(
                '*Next Step*',
                continued.confirmation,
              ),
              sendOptions: {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
              routeKey: 'local_reminder',
              capabilityId: 'capture.reminder',
              handlerKind: 'local_reminder',
              responseSource: 'local_companion',
              traceReason:
                'persisted a clarified reminder before confirmation delivery',
              linkedRefs: { reminderTaskId: persisted.task.id },
              replyKind: 'completion',
            });
            return true;
          }
          if (continued.kind === 'reply') {
            await sendAssistantReplyWithFeedback({
              text: formatCalendarPanelText('*Next Step*', continued.reply),
              sendOptions: {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
              routeKey: 'local_reminder',
              capabilityId: 'capture.reminder',
              handlerKind: 'local_reminder',
              responseSource: 'local_companion',
              traceReason:
                'reconciled an existing reminder without creating another task',
              linkedRefs: {
                reminderTaskId: activeActionReminder.taskId || undefined,
              },
              replyKind: 'completion',
            });
            clearPendingActionReminderState(chatJid, activeActionReminder);
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
            await sendAssistantReplyWithFeedback({
              text: formatCalendarPanelText('*Next Step*', continued.message),
              sendOptions: {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
              routeKey: 'action_layer.awaiting_draft_input',
              capabilityId: 'communication.draft_reply',
              handlerKind: 'local_action_layer',
              responseSource: 'local_companion',
              traceReason: 'asked for missing draft input before continuing',
              replyKind: 'clarification',
            });
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
            await sendAssistantReplyWithFeedback({
              text: formatCalendarPanelText('*Next Step*', continued.reply),
              sendOptions: {
                inlineActionRows:
                  buildCalendarLookupInlineActionRows(lastContent),
              },
              routeKey: 'action_layer.draft_progress',
              capabilityId: 'communication.draft_reply',
              handlerKind: 'local_action_layer',
              responseSource: 'local_companion',
              traceReason:
                'presented non-completion action-layer draft progress',
              replyKind: 'progress',
            });
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
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText('*Next Step*', actionResult.message),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
          routeKey: 'action_layer.awaiting_reminder_time',
          capabilityId: 'capture.reminder',
          handlerKind: 'local_action_layer',
          responseSource: 'local_companion',
          traceReason: 'asked for missing reminder timing before persistence',
          replyKind: 'clarification',
        });
        return true;
      }

      if (actionResult.kind === 'awaiting_draft_input') {
        setPendingActionDraftState(chatJid, actionResult.state);
        if (actionResult.actionContext) {
          setActionLayerContext(chatJid, actionResult.actionContext);
        }
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText('*Next Step*', actionResult.message),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
          routeKey: 'action_layer.awaiting_draft_input',
          capabilityId: 'communication.draft_reply',
          handlerKind: 'local_action_layer',
          responseSource: 'local_companion',
          traceReason: 'asked for missing draft input before continuing',
          replyKind: 'clarification',
        });
        return true;
      }

      if (actionResult.kind === 'created_reminder') {
        createTask(withQueuedBlueBubblesTaskAuthorization(actionResult.task));
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
        await sendAssistantReplyWithFeedback({
          text: formatCalendarPanelText(
            '*Next Step*',
            actionResult.confirmation,
          ),
          sendOptions: {
            inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
          },
          routeKey: 'action_layer.created_reminder',
          capabilityId: 'capture.reminder',
          handlerKind: 'local_action_layer',
          responseSource: 'local_companion',
          traceReason:
            'presented reminder completion only through the cognitive claim gate',
          linkedRefs: { reminderTaskId: actionResult.task.id },
          replyKind: 'completion',
        });
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
      await sendAssistantReplyWithFeedback({
        text: formatCalendarPanelText('*Next Step*', actionResult.reply),
        sendOptions: {
          inlineActionRows: buildCalendarLookupInlineActionRows(lastContent),
        },
        routeKey: 'action_layer.result',
        capabilityId: 'action_layer.local',
        handlerKind: 'local_action_layer',
        responseSource: 'local_companion',
        traceReason:
          'routed action-layer result through the cognitive claim gate',
        replyKind: 'progress',
      });
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
      if (isCommittedIncompleteDeliveryError(err)) throw err;
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
        replyKind: 'progress',
      });
      if (actionContext) {
        setActionLayerContext(chatJid, actionContext);
      } else {
        clearActionLayerContext(chatJid);
      }
      clearSharedAssistantCapabilitySeed(chatJid);
      setDailyCompanionContext(chatJid, dailyResponse.context);
      const suggestedThread =
        lastContent && group.folder
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
        await sendCognitiveTurnReply({
          text: buildLifeThreadSuggestionAskText(suggestedThread.title),
          replyKind: 'approval_request',
          routeKey: 'life_thread.suggestion_confirmation',
          capabilityId: 'life_thread.suggestion',
        });
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
      if (isCommittedIncompleteDeliveryError(err)) throw err;
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
        replyKind: 'progress',
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
      if (isCommittedIncompleteDeliveryError(err)) throw err;
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
    if (
      result.bridgeSaveForLaterText ||
      result.lifeThreadResult?.referencedThread
    ) {
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
        result.bridgeSaveForLaterText ||
        result.lifeThreadResult?.referencedThread,
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

    const executiveContext = beginCognitiveExecutiveTurn({
      rawAsk: lastContent,
      channel: conversationChannel,
      groupFolder: group.folder,
      chatJid,
      threadId: missedMessages.at(-1)?.thread_id || null,
      actorId: missedMessages.at(-1)?.sender || null,
      turnId: missedMessages.at(-1)?.id || null,
      requestRoute: requestPolicy.route,
      activeContextSummary: sharedSeed.summaryText,
      priorSubjectData: sharedSeed.subjectData as Record<string, unknown>,
      replyTo: missedMessages.at(-1)?.reply_to || null,
      now,
      personalContextPacket: turnAgentHarness?.personalContextPacket || null,
    });
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
          messageId: missedMessages.at(-1)?.id,
          text: 'save this for later',
          replyText: result.bridgeSaveForLaterText,
          conversationSummary: sharedSeed.summaryText,
          now,
        });
        if (savedThread.referencedThread) {
          setLastReferencedLifeThread(
            chatJid,
            savedThread.referencedThread,
            now,
          );
        }
        await sendAssistantReplyWithFeedback({
          text: savedThread.responseText || 'Okay.',
          routeKey: 'assistant_completion.save_for_later',
          capabilityId: 'capture.save_for_later',
          handlerKind: 'assistant_completion_bridge',
          responseSource: 'local_companion',
          traceReason:
            'completed save-for-later follow-up from shared capability state',
          linkedRefs: savedThread.referencedThread
            ? {
                lifeThreadId: savedThread.referencedThread.id,
              }
            : {},
          replyKind: 'completion',
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
              capabilityId:
                draftResult.capabilityId || 'communication.draft_reply',
              handlerKind: 'assistant_completion_bridge',
              responseSource:
                draftResult.trace?.responseSource || 'local_companion',
              traceReason:
                draftResult.trace?.reason ||
                'completed shared capability follow-up by reopening reply help',
              traceNotes: draftResult.trace?.notes || [],
              blockerClass: null,
              linkedRefs: {
                messageActionId: draftResult.messageAction.messageActionId,
              },
              preserveStructuredText: true,
              replyKind: 'approval_request',
            });
            linkMessageActionCognitiveContext({
              messageActionId: draftResult.messageAction.messageActionId,
              cognitiveRunId: turnAgentHarness?.cognitiveRun?.run.runId,
              cognitiveSkillId:
                turnAgentHarness?.cognitiveRun?.run.linkedSkillCardId,
              cognitiveTrajectoryId:
                turnAgentHarness?.cognitiveRun?.trajectoryScore.trajectoryId,
              agentRuntimeRunId:
                turnAgentHarness?.runtimeSpine?.run.runtimeRunId,
              now,
            });
            updateMessageAction(draftResult.messageAction.messageActionId, {
              presentationMessageId: sent.platformMessageId || null,
              presentationChatJid: chatJid,
              lastUpdatedAt: now.toISOString(),
            });
          } else {
            const sent = await sendAssistantReplyWithFeedback({
              text: presentation.text,
              routeKey: 'assistant_completion.draft_reply',
              capabilityId:
                draftResult.capabilityId || 'communication.draft_reply',
              handlerKind: 'assistant_completion_bridge',
              responseSource:
                draftResult.trace?.responseSource || 'local_companion',
              traceReason:
                draftResult.trace?.reason ||
                'completed BlueBubbles follow-up through a message-action presentation',
              traceNotes: draftResult.trace?.notes || [],
              linkedRefs: {
                messageActionId: draftResult.messageAction.messageActionId,
              },
              preserveStructuredText: true,
              replyKind: 'approval_request',
              skipBlueBubblesActionRehydration: true,
            });
            linkMessageActionCognitiveContext({
              messageActionId: draftResult.messageAction.messageActionId,
              cognitiveRunId: turnAgentHarness?.cognitiveRun?.run.runId,
              cognitiveSkillId:
                turnAgentHarness?.cognitiveRun?.run.linkedSkillCardId,
              cognitiveTrajectoryId:
                turnAgentHarness?.cognitiveRun?.trajectoryScore.trajectoryId,
              agentRuntimeRunId:
                turnAgentHarness?.runtimeSpine?.run.runtimeRunId,
              now,
            });
            syncBlueBubblesMessageActionPresentation({
              groupFolder: group.folder,
              chatJid,
              messageActionId: draftResult.messageAction.messageActionId,
              platformMessageId: sent.platformMessageId || null,
              now,
            });
          }
        } else {
          await sendAssistantReplyWithFeedback({
            text: draftResult.replyText || 'Okay.',
            sendOptions: draftResult.sendOptions || {},
            routeKey: 'assistant_completion.draft_reply',
            capabilityId:
              draftResult.capabilityId || 'communication.draft_reply',
            handlerKind: 'assistant_completion_bridge',
            responseSource:
              draftResult.trace?.responseSource || 'local_companion',
            traceReason:
              draftResult.trace?.reason ||
              'completed shared capability follow-up by reopening reply help',
            traceNotes: draftResult.trace?.notes || [],
            replyKind: 'progress',
          });
        }
        if (draftResult.conversationSeed) {
          setSharedAssistantCapabilitySeed(
            chatJid,
            draftResult.conversationSeed,
            now,
          );
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
          replyKind: 'completion',
        });
      }

      clearActionLayerContext(chatJid);
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: result.reminderTaskId ? 'handled' : 'handled',
        resultSummary:
          result.replyText ||
          result.bridgeSaveForLaterText ||
          result.bridgeDraftReference ||
          result.capabilityResult?.conversationSeed?.summaryText ||
          'Shared assistant completion handled the follow-up.',
        changedSummary: result.reminderTaskId
          ? 'A reminder was created through the existing completion flow.'
          : result.bridgeSaveForLaterText
            ? 'The referenced context was saved through the existing life-thread flow.'
            : null,
        nextAction:
          result.capabilityResult?.conversationSeed?.summaryText ||
          'Use the existing follow-up controls if more action is needed.',
        now,
      });
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
      completeConversationPilotProof(
        pilotRecord,
        buildCompletionPilotOutcome(result),
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: 'failed',
        resultSummary:
          err instanceof Error
            ? err.message
            : 'Shared assistant completion failed.',
        blockerClass: 'assistant_completion_send_failed',
        nextAction: 'Retry the same follow-up after the send path is healthy.',
        now,
      });
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_completion_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error
            ? err.message
            : 'assistant completion send failed',
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
      currentInboundMediaCapabilityMatch ||
      continueAssistantCapabilityFromPriorSubjectData(
        lastContent,
        priorAssistantCapabilitySeed?.subjectData,
      );
    let capabilityRouteSource:
      | 'local_fast_path'
      | 'openai_router'
      | 'deterministic_fallback' = capabilityMatch
      ? 'local_fast_path'
      : 'deterministic_fallback';
    let capabilityRouteDecision: {
      routeKind?: string | null;
      confidence?: string | null;
    } | null = null;
    if (!capabilityMatch) {
      const openAiRoute = await maybeGetOpenAiGuidedRoute();
      const decision = openAiRoute?.decision;
      if (
        decision?.routeKind === 'assistant_capability' &&
        typeof decision.capabilityId === 'string'
      ) {
        capabilityMatch = {
          capabilityId: decision.capabilityId as AssistantCapabilityId,
          normalizedText: openAiGuidedUserText,
          canonicalText: decision.canonicalText || openAiGuidedUserText,
          arguments: decision.arguments || undefined,
          reason:
            decision.reason || 'matched OpenAI-guided assistant capability',
        };
        capabilityRouteSource = 'openai_router';
        capabilityRouteDecision = decision;
      }
    }
    if (!capabilityMatch) {
      capabilityMatch = matchAssistantCapabilityRequest(lastContent);
      if (capabilityMatch) {
        capabilityRouteSource = 'deterministic_fallback';
      }
    }
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
        if (capabilityMatch) {
          capabilityRouteSource =
            interpretedTurn.source === 'openai'
              ? 'openai_router'
              : 'deterministic_fallback';
        }
      }
    }
    let priorDailyContext: DailyCompanionContext | null = null;
    let selectedWork: SelectedWorkContext | null = null;
    let selectedWorkLoaded = false;
    const loadSelectedWorkForExecutive =
      async (): Promise<SelectedWorkContext | null> => {
        if (!selectedWorkLoaded) {
          selectedWork = await getSelectedDailyWorkContext(
            chatJid,
            missedMessages.at(-1)?.thread_id,
          );
          selectedWorkLoaded = true;
        }
        return selectedWork;
      };
    const executiveContext = isCognitiveExecutiveCandidate(lastContent)
      ? beginCognitiveExecutiveTurn({
          rawAsk: lastContent,
          channel: conversationChannel,
          groupFolder: group.folder,
          chatJid,
          threadId: missedMessages.at(-1)?.thread_id || null,
          actorId: missedMessages.at(-1)?.sender || null,
          turnId: missedMessages.at(-1)?.id || null,
          requestRoute: requestPolicy.route,
          selectedWork: await loadSelectedWorkForExecutive(),
          activeContextSummary:
            priorAssistantCapabilitySeed?.summaryText ||
            (priorDailyContext = getDailyCompanionContext(chatJid, now))
              ?.summaryText ||
            null,
          priorSubjectData: priorAssistantCapabilitySeed?.subjectData as Record<
            string,
            unknown
          > | null,
          replyTo: missedMessages.at(-1)?.reply_to || null,
          capabilityMatchOverride: capabilityMatch,
          now,
          personalContextPacket:
            turnAgentHarness?.personalContextPacket || null,
        })
      : null;
    if (executiveContext?.capabilityMatch) {
      capabilityMatch = executiveContext.capabilityMatch;
      if (capabilityRouteSource === 'deterministic_fallback') {
        capabilityRouteSource = 'deterministic_fallback';
      }
    }
    if (!capabilityMatch) {
      if (executiveContext?.plan.selectedRoute === 'clarify') {
        const clarification =
          executiveContext.plan.explanation ||
          'I need one more detail before I can route that safely.';
        const clarificationText = /\?\s*$/.test(clarification.trim())
          ? clarification
          : `${clarification}\n\nWhat exactly do you want me to handle?`;
        await sendAssistantReplyWithFeedback({
          text: clarificationText,
          routeKey: executiveContext.plan.routeKey,
          capabilityId: null,
          handlerKind: 'local_cognitive_executive',
          responseSource: 'local_companion',
          traceReason:
            'cognitive executive asked for clarification before action selection',
          replyKind: 'clarification',
        });
        finalizeCognitiveExecutiveTurn({
          context: executiveContext,
          status: 'clarified',
          resultSummary: 'Asked one clarifying question before taking action.',
          nextAction:
            'Wait for the user to provide the target, timing, or approval context.',
          now,
        });
        clearSharedAssistantCapabilitySeed(chatJid);
        return true;
      }
      return false;
    }
    rememberOpenAiGuidedRoutingState({
      source: capabilityRouteSource,
      routeKind:
        capabilityRouteDecision?.routeKind ||
        (capabilityRouteSource === 'local_fast_path'
          ? 'assistant_capability'
          : 'assistant_capability'),
      capabilityId: capabilityMatch.capabilityId,
      confidence: capabilityRouteDecision?.confidence || null,
      fallbackReason:
        capabilityRouteSource === 'deterministic_fallback'
          ? openAiGuidedRouteResult?.fallbackReason || null
          : null,
      selectedModelTier:
        openAiGuidedRouteResult?.decision?.selectedModelTier || null,
      selectedModel: openAiGuidedRouteResult?.decision?.selectedModel || null,
      providerMode: openAiGuidedRouteResult?.decision?.providerMode || null,
    });
    if (!priorDailyContext) {
      priorDailyContext = getDailyCompanionContext(chatJid, now);
    }
    if (!selectedWorkLoaded) {
      selectedWork = await loadSelectedWorkForExecutive();
    }
    const pilotRecord = startConversationPilotProof(
      resolvePilotJourneyFromCapability({
        capabilityId: capabilityMatch.capabilityId,
        channel: conversationChannel,
        text: lastContent,
        canonicalText: capabilityMatch.canonicalText,
        personName: priorAssistantCapabilitySeed?.subjectData?.personName,
        threadTitle: priorAssistantCapabilitySeed?.subjectData?.threadTitle,
        summaryText:
          priorAssistantCapabilitySeed?.summaryText ||
          priorDailyContext?.summaryText,
      }),
    );
    let result: AssistantCapabilityResult;
    try {
      const ownerReviewAllowed = isTrustedOwnerReviewSurface({
        channelName: conversationChannel,
        chatJid,
        group,
        ownerAuthored: currentTurnOwnerAuthored,
      });
      const messagesHistoryChannel = channels.find(
        (candidate): candidate is BlueBubblesChannel =>
          candidate instanceof BlueBubblesChannel,
      );
      const capabilityInput = buildAssistantCapabilityExecutionInput({
        lastContent,
        capabilityMatch,
        priorSubjectData: priorAssistantCapabilitySeed?.subjectData,
      });
      let historyRefreshDisclosure: MessagesHistoryRefreshDisclosureInput | null =
        null;
      let historyRefreshTargetChatJid: string | null = null;
      const namedOpenLoopQuery =
        capabilityMatch.capabilityId === 'communication.open_loops'
          ? namedOpenLoopHistoryQuery(
              resolveNamedOpenLoopBinding({
                text: lastContent,
                canonicalText: capabilityMatch.canonicalText,
                targetChatName: capabilityInput.targetChatName,
                ownerReviewAllowed,
                priorNamedSeedJson:
                  priorAssistantCapabilitySeed?.subjectData
                    ?.namedMessagesSummaryTargetJson,
              }),
            )
          : null;
      const historyCapability =
        capabilityMatch.capabilityId === 'communication.summarize_thread' ||
        capabilityMatch.capabilityId === 'communication.review_recent_texts' ||
        Boolean(namedOpenLoopQuery);

      // Keep provider history reads inside the exact owner-only privacy gate.
      // A known named thread gets its own bounded read so a quiet conversation
      // cannot disappear merely because the global newest-500 slice is busy.
      if (ownerReviewAllowed && historyCapability) {
        type GlobalDiscoveryDisclosure = NonNullable<
          MessagesHistoryRefreshDisclosureInput['precedingGlobalDiscovery']
        >;
        const runGlobalHistoryRefresh =
          async (): Promise<GlobalDiscoveryDisclosure> => {
            if (!messagesHistoryChannel?.primeRecentHistory) {
              const refresh: GlobalDiscoveryDisclosure = {
                mode: 'local_only',
                requestedLimit: 500,
              };
              historyRefreshDisclosure = { ...refresh, timeZone: TIMEZONE };
              return refresh;
            }
            try {
              const hydrated = await messagesHistoryChannel.primeRecentHistory({
                limit: 500,
              });
              const refresh: GlobalDiscoveryDisclosure = {
                mode: 'global_succeeded',
                requestedLimit: 500,
                inspectedCount: hydrated.totalCount,
                storedCount: hydrated.storedCount,
              };
              historyRefreshDisclosure = { ...refresh, timeZone: TIMEZONE };
              logger.info(
                {
                  component: 'assistant',
                  channel: conversationChannel,
                  capabilityId: capabilityMatch.capabilityId,
                  storedCount: hydrated.storedCount,
                  totalCount: hydrated.totalCount,
                },
                'Hydrated bounded global Messages history for an explicit owner review request',
              );
              return refresh;
              // eslint-disable-next-line no-catch-all/no-catch-all
            } catch (error) {
              const refresh: GlobalDiscoveryDisclosure = {
                mode: 'global_failed',
                requestedLimit: 500,
              };
              historyRefreshDisclosure = { ...refresh, timeZone: TIMEZONE };
              logger.warn(
                {
                  component: 'assistant',
                  channel: conversationChannel,
                  capabilityId: capabilityMatch.capabilityId,
                  err: error,
                },
                'Global Messages history hydration failed; continuing with locally stored history',
              );
              return refresh;
            }
          };

        const namedChatQuery =
          (capabilityMatch.capabilityId === 'communication.summarize_thread' &&
            capabilityInput.targetChatJid !== ALL_SYNCED_MESSAGES_TARGET) ||
          Boolean(namedOpenLoopQuery)
            ? capabilityInput.targetChatJid ||
              capabilityInput.targetChatName ||
              capabilityInput.threadTitle ||
              capabilityInput.personName ||
              null
            : null;

        if (namedChatQuery) {
          let precedingGlobalDiscovery: GlobalDiscoveryDisclosure | null = null;
          let resolution = resolveBlueBubblesThreadTargetByName(namedChatQuery);
          if (resolution.state === 'missing') {
            // A global refresh can discover current metadata for a recently
            // active thread. If it remains missing, the resulting disclosure
            // is explicit that the newest-500 global slice may omit quiet chats.
            precedingGlobalDiscovery = await runGlobalHistoryRefresh();
            resolution = resolveBlueBubblesThreadTargetByName(namedChatQuery);
          }
          if (resolution.state === 'resolved') {
            historyRefreshTargetChatJid = resolution.target.chatJid;
            if (messagesHistoryChannel?.primeChatHistory) {
              try {
                const hydrated = await messagesHistoryChannel.primeChatHistory(
                  resolution.target.chatJid,
                  { limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT },
                );
                historyRefreshDisclosure = {
                  mode: 'targeted_succeeded',
                  requestedLimit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
                  inspectedCount: hydrated.totalCount,
                  storedCount: hydrated.storedCount,
                  timeZone: TIMEZONE,
                  ...(precedingGlobalDiscovery
                    ? { precedingGlobalDiscovery }
                    : {}),
                };
                logger.info(
                  {
                    component: 'assistant',
                    channel: conversationChannel,
                    capabilityId: capabilityMatch.capabilityId,
                    storedCount: hydrated.storedCount,
                    totalCount: hydrated.totalCount,
                  },
                  'Hydrated bounded targeted Messages history for an explicit owner summary request',
                );
                // eslint-disable-next-line no-catch-all/no-catch-all
              } catch (error) {
                historyRefreshDisclosure = {
                  mode: 'targeted_failed',
                  requestedLimit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
                  timeZone: TIMEZONE,
                  ...(precedingGlobalDiscovery
                    ? { precedingGlobalDiscovery }
                    : {}),
                };
                logger.warn(
                  {
                    component: 'assistant',
                    channel: conversationChannel,
                    capabilityId: capabilityMatch.capabilityId,
                    err: error,
                  },
                  'Targeted Messages history hydration failed; continuing with the exact local thread snapshot',
                );
              }
            } else {
              historyRefreshDisclosure = {
                mode: 'local_only',
                requestedLimit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
                timeZone: TIMEZONE,
                ...(precedingGlobalDiscovery
                  ? { precedingGlobalDiscovery }
                  : {}),
              };
            }
          }
        } else if (
          capabilityMatch.capabilityId ===
            'communication.review_recent_texts' ||
          capabilityInput.targetChatJid === ALL_SYNCED_MESSAGES_TARGET
        ) {
          await runGlobalHistoryRefresh();
        }
      }
      result = await executeAssistantCapability({
        capabilityId: capabilityMatch.capabilityId,
        context: {
          channel: conversationChannel,
          groupFolder: group.folder,
          chatJid,
          ownerReviewAllowed,
          currentMessageId: latestUserMessage?.id,
          currentAttachmentIds,
          now,
          selectedWork,
          conversationSummary:
            priorAssistantCapabilitySeed?.summaryText ||
            priorDailyContext?.summaryText,
          priorCompanionContext: priorDailyContext,
          priorSubjectData: priorAssistantCapabilitySeed?.subjectData,
          replyText: missedMessages.at(-1)?.reply_to?.content,
          ...(ownerReviewAllowed && messagesHistoryChannel
            ? {
                primeMessagesChatHistory: (targetChatJid: string) =>
                  messagesHistoryChannel.primeChatHistory(targetChatJid, {
                    limit: BLUEBUBBLES_TARGETED_HISTORY_LIMIT,
                  }),
              }
            : {}),
        },
        input: capabilityInput,
      });
      if (historyRefreshDisclosure && result.replyText) {
        const disclosure = formatMessagesHistoryRefreshDisclosure({
          ...historyRefreshDisclosure,
          latestLocalMessageAt: resolveLatestEligibleLocalMessagesTimestamp(
            historyRefreshTargetChatJid,
          ),
        });
        result = {
          ...result,
          replyText: `${result.replyText}\n\n${disclosure}`,
          ...(result.conversationSeed
            ? {
                conversationSeed: {
                  ...result.conversationSeed,
                  summaryText: `${result.conversationSeed.summaryText}\n\n${disclosure}`,
                },
              }
            : {}),
        };
      }
    } catch (err) {
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: 'failed',
        resultSummary:
          err instanceof Error ? err.message : 'Assistant capability failed.',
        blockerClass: 'assistant_capability_runtime_failed',
        nextAction:
          'Retry after the selected capability runtime path is healthy.',
        fallbackUsed: capabilityRouteSource === 'deterministic_fallback',
        now,
      });
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
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: 'failed',
        resultSummary:
          'The selected capability declined this turn after route selection.',
        blockerClass: 'assistant_capability_declined',
        nextAction:
          'Fall back to a direct answer or ask one clarifying question.',
        fallbackUsed: true,
        now,
      });
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
          traceReason:
            result.trace?.reason || 'handled shared daily capability',
          traceNotes: result.trace?.notes || [],
          replyKind: 'progress',
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
          await sendCognitiveTurnReply({
            text: buildLifeThreadSuggestionAskText(suggestedThread.title),
            replyKind: 'approval_request',
            routeKey: 'life_thread.suggestion_confirmation',
            capabilityId: 'life_thread.suggestion',
          });
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
            result.trace?.reason ||
            'handled shared capability via life-thread result',
          traceNotes: result.trace?.notes || [],
          linkedRefs: result.lifeThreadResult.referencedThread
            ? {
                lifeThreadId: result.lifeThreadResult.referencedThread.id,
              }
            : {},
          replyKind: 'completion',
        });
      } else if (result.mediaResult?.artifact && channel.sendArtifact) {
        const artifactAuthorization = authorizeCognitiveReplyDelivery({
          cognitiveRun: turnAgentHarness?.cognitiveRun,
          replyKind: 'completion',
          now: new Date().toISOString(),
        });
        if (!artifactAuthorization.allowed) {
          await sendCognitiveTurnReply({
            text: artifactAuthorization.safeFallbackText,
            replyKind: 'evidence_request',
            routeKey: 'media.artifact_verification_pending',
            capabilityId: result.capabilityId || capabilityMatch.capabilityId,
          });
          return true;
        }
        const sentArtifact = acceptConfirmedPresentationDelivery({
          result: await channel.sendArtifact(
            chatJid,
            result.mediaResult.artifact,
            {
              caption: result.replyText || result.mediaResult.summaryText,
            },
          ),
          channel: channel.name,
          chatJid,
          workflow: 'assistant_media_artifact_completion',
          onUnverified: () => inFlightCursorRollbacks.markDelivered(chatJid),
        });
        if (!sentArtifact) return true;
      } else if (result.messageAction) {
        if (
          result.messageAction.sendStatus === 'approved' &&
          !result.messageAction.requiresApproval &&
          result.messageAction.targetKind !== 'external_thread'
        ) {
          await applyAndPresentMessageAction({
            chatJid,
            messageActionId: result.messageAction.messageActionId,
            operation: { kind: 'send' },
            ownerAuthored: currentTurnOwnerAuthored,
            ownerAuthorizationAt: queuedOwnerAuthorizationAt,
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
              preserveStructuredText: true,
              replyKind: 'approval_request',
            });
            linkMessageActionCognitiveContext({
              messageActionId: result.messageAction.messageActionId,
              cognitiveRunId: turnAgentHarness?.cognitiveRun?.run.runId,
              cognitiveSkillId:
                turnAgentHarness?.cognitiveRun?.run.linkedSkillCardId,
              cognitiveTrajectoryId:
                turnAgentHarness?.cognitiveRun?.trajectoryScore.trajectoryId,
              agentRuntimeRunId:
                turnAgentHarness?.runtimeSpine?.run.runtimeRunId,
              now,
            });
            updateMessageAction(result.messageAction.messageActionId, {
              presentationMessageId: sent.platformMessageId || null,
              presentationChatJid: chatJid,
              lastUpdatedAt: now.toISOString(),
            });
          } else {
            const sent = await sendAssistantReplyWithFeedback({
              text: presentation.text,
              routeKey: capabilityMatch.capabilityId,
              capabilityId: result.capabilityId || capabilityMatch.capabilityId,
              handlerKind: result.trace?.handlerKind || 'assistant_capability',
              responseSource: result.trace?.responseSource || 'local_companion',
              traceReason:
                result.trace?.reason ||
                'handled BlueBubbles capability through a message-action presentation',
              traceNotes: result.trace?.notes || [],
              linkedRefs: {
                messageActionId: result.messageAction.messageActionId,
              },
              preserveStructuredText: true,
              replyKind: 'approval_request',
              skipBlueBubblesActionRehydration: true,
            });
            linkMessageActionCognitiveContext({
              messageActionId: result.messageAction.messageActionId,
              cognitiveRunId: turnAgentHarness?.cognitiveRun?.run.runId,
              cognitiveSkillId:
                turnAgentHarness?.cognitiveRun?.run.linkedSkillCardId,
              cognitiveTrajectoryId:
                turnAgentHarness?.cognitiveRun?.trajectoryScore.trajectoryId,
              agentRuntimeRunId:
                turnAgentHarness?.runtimeSpine?.run.runtimeRunId,
              now,
            });
            syncBlueBubblesMessageActionPresentation({
              groupFolder: group.folder,
              chatJid,
              messageActionId: result.messageAction.messageActionId,
              platformMessageId: sent.platformMessageId || null,
              now,
            });
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
          traceReason:
            result.trace?.reason || 'handled shared assistant capability',
          traceNotes: result.trace?.notes || [],
          replyKind: 'completion',
        });
      }

      const actionBundle = result.messageAction
        ? null
        : createOrRefreshActionBundle({
            groupFolder: group.folder,
            presentationChannel: conversationChannel,
            presentationChatJid: chatJid,
            presentationThreadId: missedMessages.at(-1)?.thread_id || null,
            capabilityId: result.capabilityId,
            continuationCandidate: result.continuationCandidate,
            summaryText:
              result.conversationSeed?.summaryText || result.replyText,
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
          result.continuationCandidate.actionBundleId =
            actionBundle.bundle.bundleId;
          result.continuationCandidate.actionBundleTitle =
            actionBundle.bundle.title;
          result.continuationCandidate.actionBundleSummary =
            actionBundle.actions
              .slice(0, 3)
              .map((action) => action.summary)
              .join(', ');
        }
        if (conversationChannel === 'telegram') {
          const presentation = buildActionBundlePresentation(actionBundle);
          const bundleAuthorization = authorizeCognitiveReplyDelivery({
            cognitiveRun: turnAgentHarness?.cognitiveRun,
            replyKind: 'approval_request',
            now: new Date().toISOString(),
          });
          if (!bundleAuthorization.allowed) {
            await sendCognitiveTurnReply({
              text: presentation.text,
              replyKind: 'approval_request',
              routeKey: 'action_bundle.approval_presentation',
              capabilityId: 'action_bundle.approval',
            });
            return true;
          }
          const sent = acceptConfirmedPresentationDelivery({
            result: await sendAssistantReplyWithFeedback({
              text: presentation.text,
              sendOptions: withQueuedBlueBubblesAuthorization({
                inlineActionRows: presentation.inlineActionRows,
              }),
              routeKey: 'action_bundle.approval_presentation',
              capabilityId: 'action_bundle.approval',
              handlerKind: 'action_bundle_presentation',
              responseSource: 'local_companion',
              traceReason:
                'presented a staged action bundle for explicit approval',
              preserveStructuredText: true,
              replyKind: 'approval_request',
            }),
            channel: channel.name,
            chatJid,
            workflow: 'capability_action_bundle_presentation',
            onUnverified: () => inFlightCursorRollbacks.markDelivered(chatJid),
          });
          if (!sent) return true;
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
          await sendCognitiveTurnReply({
            text: 'I can line up the next steps here. If you want the fuller bundle, ask me to send it to Telegram.',
            replyKind: 'progress',
            routeKey: 'action_bundle.channel_guidance',
            capabilityId: 'action_bundle.guidance',
          });
        }
      }

      if (result.conversationSeed) {
        setSharedAssistantCapabilitySeed(chatJid, result.conversationSeed, now);
      } else {
        clearSharedAssistantCapabilitySeed(chatJid);
      }
      let explicitHandoffCreated = false;
      if (
        explicitHandoffTarget &&
        result.continuationCandidate?.handoffPayload
      ) {
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
            ingressAuthorization:
              conversationChannel === 'telegram' &&
              explicitHandoffTarget === 'bluebubbles' &&
              queuedLatestMessage?.ingress_received_at
                ? {
                    sourceChatJid: queuedLatestMessage.chat_jid,
                    sourceMessageId: queuedLatestMessage.id,
                    sourceReceivedAt: queuedLatestMessage.ingress_received_at,
                    authorizationAt:
                      queuedMessagingAuthorizationFence.authorizationAt,
                    pauseGeneration:
                      queuedMessagingAuthorizationFence.pauseGeneration,
                  }
                : undefined,
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
          {
            onDispatchQuarantined: () => {
              inFlightCursorRollbacks.markDelivered(chatJid);
              onPrimaryDeliveryCommitted?.(
                'delivery_unverified_pre_dispatch_quarantine',
              );
            },
          },
        );
        explicitHandoffCreated = true;
        const handoffReplyKind: CognitiveReplyKind = handoff.ok
          ? 'completion'
          : handoff.status === 'delivery_unverified'
            ? 'evidence_request'
            : 'blocked_notice';
        await sendCognitiveTurnReply({
          text: handoff.speech,
          sendOptions: withQueuedBlueBubblesAuthorization(),
          replyKind: handoffReplyKind,
          routeKey: 'companion_handoff.delivery_status',
          capabilityId: 'companion_handoff.delivery',
        });
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
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: result.messageAction?.requiresApproval
          ? 'approval_staged'
          : 'handled',
        resultSummary:
          result.replyText ||
          result.conversationSeed?.summaryText ||
          `Handled ${result.capabilityId || capabilityMatch.capabilityId}.`,
        changedSummary: result.messageAction
          ? 'A message action draft was prepared through the existing approval-first path.'
          : result.lifeThreadResult?.referencedThread
            ? 'A life-thread reference was updated through the existing path.'
            : null,
        nextAction: result.messageAction?.requiresApproval
          ? 'Wait for explicit same-thread approval before sending.'
          : result.continuationCandidate?.voiceSummary ||
            result.conversationSeed?.summaryText ||
            'Use the presented follow-up controls if needed.',
        fallbackUsed: capabilityRouteSource === 'deterministic_fallback',
        now,
      });
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      finalizeCognitiveExecutiveTurn({
        context: executiveContext,
        status: 'failed',
        resultSummary:
          err instanceof Error ? err.message : 'Assistant capability failed.',
        blockerClass: 'assistant_capability_send_failed',
        nextAction: 'Retry after the selected capability send path is healthy.',
        fallbackUsed: capabilityRouteSource === 'deterministic_fallback',
        now,
      });
      completeConversationPilotProof(pilotRecord, {
        outcome: 'internal_failure',
        blockerClass: 'assistant_capability_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error
            ? err.message
            : 'assistant capability send failed',
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

  const tryHandleOpenAiGuidedReply = async (): Promise<boolean> => {
    const routed = await maybeGetOpenAiGuidedRoute();
    const decision = routed?.decision;
    if (!decision) {
      return false;
    }

    if (decision.routeKind === 'clarify') {
      const clarificationText =
        decision.clarificationPrompt ||
        "I couldn't route that cleanly. What do you want me to help with here?";
      rememberOpenAiGuidedRoutingState({
        source: 'openai_router',
        routeKind: decision.routeKind,
        capabilityId: decision.capabilityId || null,
        confidence: decision.confidence,
        selectedModelTier: decision.selectedModelTier || null,
        selectedModel: decision.selectedModel || null,
        providerMode: decision.providerMode || null,
      });
      await sendAssistantReplyWithFeedback({
        text: clarificationText,
        routeKey: 'openai_guided_clarify',
        handlerKind: 'direct_quick_reply',
        responseSource: 'local_companion',
        routingProviderId:
          decision.providerMode === 'compatible_gateway'
            ? 'openai_compatible_gateway'
            : 'openai_cloud',
        routingModelId: decision.selectedModel || null,
        routingEndpointMode: decision.providerMode || null,
        toolClass: 'openai_guided_router',
        traceReason: 'handled message via OpenAI-guided clarification path',
        replyKind: 'clarification',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          openAiGuidedRouteKind: decision.routeKind,
          openAiGuidedConfidence: decision.confidence,
        },
        'Handled message via OpenAI-guided clarification path',
      );
      return true;
    }

    if (decision.routeKind !== 'direct_quick_reply') {
      return false;
    }

    const guidedReply =
      maybeBuildDirectQuickReply([
        { content: decision.canonicalText || openAiGuidedUserText },
      ]) || maybeBuildDirectQuickReply([{ content: openAiGuidedUserText }]);
    if (!guidedReply) {
      return false;
    }

    const quickReplyPilot = startConversationPilotProof(
      resolveOrdinaryChatPilotJourney(openAiGuidedUserText),
    );
    try {
      rememberOpenAiGuidedRoutingState({
        source: 'openai_router',
        routeKind: decision.routeKind,
        capabilityId: decision.capabilityId || null,
        confidence: decision.confidence,
        selectedModelTier: decision.selectedModelTier || null,
        selectedModel: decision.selectedModel || null,
        providerMode: decision.providerMode || null,
      });
      await sendAssistantReplyWithFeedback({
        text: guidedReply,
        routeKey: 'openai_guided_direct_quick_reply',
        handlerKind: 'direct_quick_reply',
        responseSource: 'local_companion',
        routingProviderId:
          decision.providerMode === 'compatible_gateway'
            ? 'openai_compatible_gateway'
            : 'openai_cloud',
        routingModelId: decision.selectedModel || null,
        routingEndpointMode: decision.providerMode || null,
        toolClass: 'openai_guided_router',
        traceReason:
          'handled message via OpenAI-guided direct quick reply path',
        replyKind: 'progress',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      completeConversationPilotProof(quickReplyPilot, {
        outcome: 'success',
        blockerOwner: 'none',
        summaryText: guidedReply,
      });
      logger.info(
        {
          component: 'assistant',
          chatJid,
          groupFolder: group.folder,
          group: group.name,
          requestRoute: requestPolicy.route,
          directAssistantProfile: 'minimal_read_only',
          openAiGuidedRouteKind: decision.routeKind,
          openAiGuidedConfidence: decision.confidence,
          quickReply: true,
        },
        'Handled message via OpenAI-guided direct quick reply path',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      completeConversationPilotProof(quickReplyPilot, {
        outcome: 'internal_failure',
        blockerClass: 'openai_guided_direct_quick_reply_send_failed',
        blockerOwner: 'repo_side',
        summaryText:
          err instanceof Error
            ? err.message
            : 'OpenAI-guided direct quick reply send failed',
      });
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'OpenAI-guided direct quick reply send failed, rolled back cursor for retry',
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
      interpretedTurn.confidence < 0.55 &&
      interpretedTurn.clarificationQuestion;
    const replyText =
      clarificationNeeded ||
      (interpretedTurn.routeFamily === 'chat' ||
      interpretedTurn.routeFamily === 'help'
        ? interpretedTurn.replyText ||
          maybeBuildDirectQuickReply([
            { content: interpretedTurn.assistantPrompt || lastContent },
          ]) ||
          interpretedTurn.fallbackText
        : null);
    if (!replyText) {
      return false;
    }
    if (!clarificationNeeded && interpretedTurn.source !== 'fallback') {
      // Model-authored chat prose must finish through the canonical runtime
      // evidence and durable terminal-verifier path. Only the deterministic
      // bounded fallback remains an informational fast path.
      return false;
    }
    rememberOpenAiGuidedRoutingState({
      source:
        interpretedTurn.source === 'openai'
          ? 'openai_router'
          : 'deterministic_fallback',
      routeKind:
        clarificationNeeded && interpretedTurn.clarificationQuestion
          ? 'clarify'
          : 'direct_quick_reply',
      confidence:
        interpretedTurn.source === 'openai'
          ? interpretedTurn.confidence >= 0.85
            ? 'high'
            : interpretedTurn.confidence >= 0.55
              ? 'medium'
              : 'low'
          : null,
      fallbackReason:
        interpretedTurn.source === 'fallback'
          ? interpretedTurn.fallbackText ||
            'Messages direct turn fell back locally.'
          : null,
      selectedModelTier:
        openAiGuidedRouteResult?.decision?.selectedModelTier || null,
      selectedModel: openAiGuidedRouteResult?.decision?.selectedModel || null,
      providerMode: openAiGuidedRouteResult?.decision?.providerMode || null,
    });
    await sendAssistantReplyWithFeedback({
      text: replyText,
      routeKey: 'bluebubbles_fluid_direct_reply',
      handlerKind: 'messages_fluidity',
      responseSource: interpretedTurn.source || 'local_companion',
      traceReason:
        interpretedTurn.routeFamily === 'help'
          ? 'handled Messages direct turn as a bounded help reply'
          : 'handled Messages direct turn as a fluid bounded chat reply',
      replyKind: clarificationNeeded ? 'clarification' : 'progress',
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

  const tryHandleSelfImprovementStatus = async (): Promise<boolean> => {
    const statusMonitor = planSelfImprovementStatusMonitor(
      lastContent,
      group.folder,
      chatJid,
      now,
    );
    if (statusMonitor) {
      try {
        createTask(withQueuedBlueBubblesTaskAuthorization(statusMonitor.task));
        refreshTaskSnapshots(registeredGroups);
        clearSharedAssistantCapabilitySeed(chatJid);
        await sendAssistantReplyWithFeedback({
          text: statusMonitor.confirmation,
          routeKey: 'self_improvement.status_monitor',
          capabilityId: 'self_improvement.status',
          handlerKind: 'local_self_improvement_status',
          responseSource: 'local_companion',
          traceReason:
            'created a recurring self-improvement status monitor task',
          linkedRefs: {
            reminderTaskId: statusMonitor.task.id,
          },
          replyKind: 'completion',
          latencyTargetClass: 'local_command',
        });
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            taskId: statusMonitor.task.id,
          },
          'Created self-improvement status monitor task',
        );
        return true;
      } catch (err) {
        if (isCommittedIncompleteDeliveryError(err)) throw err;
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Self-improvement status monitor creation failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    const recentFeedback = await refreshRecentResponseFeedbackTruth({
      chatJid,
      limit: 10,
    });
    const hasSelfImprovementContext =
      recentFeedback.length > 0 ||
      getAllTasks().some(
        (task) =>
          task.chat_jid === chatJid &&
          task.status === 'active' &&
          isSelfImprovementStatusTask(task),
      );
    if (
      !isSelfImprovementStatusRequest(lastContent) &&
      !(
        isSelfImprovementStatusFollowupRequest(lastContent) &&
        hasSelfImprovementContext
      )
    ) {
      return false;
    }

    await sendAssistantReplyWithFeedback({
      text: buildSelfImprovementStatusText(recentFeedback, now),
      routeKey: 'self_improvement.status',
      capabilityId: 'self_improvement.status',
      handlerKind: 'local_self_improvement_status',
      responseSource: 'local_companion',
      traceReason:
        'answered self-improvement status from response-feedback repair truth',
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    return true;
  };

  const tryHandleIntegrationDoctor = async (): Promise<boolean> => {
    const fixTarget = parseIntegrationFixTarget(lastContent);
    const isStatusRequest = isIntegrationDoctorRequest(lastContent);
    if (!fixTarget && !isStatusRequest) {
      return false;
    }

    const text = fixTarget
      ? buildIntegrationFixGuidance(fixTarget)
      : formatIntegrationDoctorReport(buildIntegrationDoctorReport(), 'doctor');
    await sendAssistantReplyWithFeedback({
      text,
      routeKey: fixTarget ? 'integrations.fix_guidance' : 'integrations.doctor',
      capabilityId: 'integrations.status',
      handlerKind: 'local_integration_doctor',
      responseSource: 'local_companion',
      traceReason:
        'answered integration health from canonical integration doctor truth',
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  const tryHandleCouncilDoctor = async (): Promise<boolean> => {
    if (!isCouncilDoctorRequest(lastContent)) {
      return false;
    }

    await sendAssistantReplyWithFeedback({
      text: formatCouncilDoctorReport(buildCouncilDoctorReport()),
      routeKey: 'council.doctor',
      capabilityId: 'council.status',
      handlerKind: 'local_council_doctor',
      responseSource: 'local_companion',
      traceReason: 'answered council quality status from local metadata ledger',
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  const tryHandleCapabilityApprenticeshipOwnerAction =
    async (): Promise<boolean> => {
      const ownerActionInput = {
        text: lastContent,
        channelName: channel.name,
        chatJid,
        group,
        ownerAuthored: currentTurnOwnerAuthored,
        messageId: latestUserMessage?.id || null,
        now,
      };
      const result =
        dispatchCapabilityApprenticeshipOwnerAction(ownerActionInput);
      if (!result.handled || !result.text) return false;
      await sendAssistantReplyWithFeedback({
        text: result.text,
        routeKey: `learning.capability_apprenticeship.${result.action || 'status'}`,
        capabilityId: 'memory.status',
        handlerKind: 'local_capability_apprenticeship_owner_action',
        responseSource: 'local_companion',
        traceReason:
          'resolved an exact private capability apprenticeship action through canonical token binding',
        allowFeedback: false,
        preserveStructuredText: true,
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    };

  const tryHandleActiveReleaseReadinessReuse = async (): Promise<boolean> => {
    const activeReuseInput = {
      text: lastContent,
      channelName: channel.name,
      chatJid,
      group,
      ownerAuthored: currentTurnOwnerAuthored,
      now,
    };
    const result = await dispatchActiveReleaseReadinessReuse(activeReuseInput);
    if (!result.handled || !result.text) return false;
    await sendAssistantReplyWithFeedback({
      text: result.text,
      routeKey: `capabilities.release_readiness.active_reuse.${result.action || 'status'}`,
      capabilityId: 'cognition.status',
      handlerKind: 'local_release_readiness_active_reuse',
      responseSource: 'local_companion',
      traceReason:
        'resolved an exact release-readiness request through active contract matching, fresh health, and independent verification',
      allowFeedback: result.action === 'verified',
      preserveStructuredText: true,
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  const tryHandleLearningStatus = async (): Promise<boolean> => {
    if (isResponseFeedbackReviewQueueRequest(lastContent)) {
      const privateReviewSurface = isTrustedOwnerReviewSurface({
        channelName: channel.name,
        chatJid,
        group,
        ownerAuthored: currentTurnOwnerAuthored,
      });
      if (!privateReviewSurface) {
        await sendAssistantReplyWithFeedback({
          text: 'Outcome review is private to your registered main Telegram chat or configured Messages self-thread. I did not load or record any review candidate here.',
          routeKey: 'learning.outcome_review.restricted',
          capabilityId: 'memory.status',
          handlerKind: 'local_outcome_review_restriction',
          responseSource: 'local_companion',
          traceReason:
            'refused to expose review candidates outside owner-only surfaces',
          allowFeedback: false,
          replyKind: 'blocked_notice',
          latencyTargetClass: 'local_command',
        });
        clearSharedAssistantCapabilitySeed(chatJid);
        return true;
      }
      const reviewChannel =
        channel.name === 'bluebubbles' ? 'bluebubbles' : 'telegram';
      const reviewQueue = buildResponseFeedbackReviewQueue({
        records: listRecentResponseFeedback({
          groupFolder: group.folder,
          limit: 100,
        }),
        groupFolder: group.folder,
        channel: reviewChannel,
        allowedChatJids:
          reviewChannel === 'bluebubbles'
            ? expandBlueBubblesLogicalSelfThreadJids(chatJid)
            : [chatJid],
        now,
      });
      await sendAssistantReplyWithFeedback({
        text: reviewQueue.text,
        sendOptions: reviewQueue.inlineActionRows
          ? { inlineActionRows: reviewQueue.inlineActionRows }
          : undefined,
        routeKey: 'learning.outcome_review',
        capabilityId: 'memory.status',
        handlerKind: 'local_outcome_review_queue',
        responseSource: 'local_companion',
        traceReason:
          'presented one recent unreviewed answer without recording a verdict',
        allowFeedback: false,
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }
    const defaultRequest = parseLearningDefaultRequest(lastContent);
    if (defaultRequest) {
      await sendAssistantReplyWithFeedback({
        text: defaultRequest.clarificationQuestion,
        routeKey: 'learning.skill_review',
        capabilityId: 'memory.status',
        handlerKind: 'local_learning_control',
        responseSource: 'local_companion',
        traceReason:
          'kept an unresolved default-learning request proposed until the behavior is explicit',
        replyKind: 'clarification',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }
    if (
      /\b(stop doing that|don'?t use that skill|do not use that skill|pause that skill)\b/i.test(
        lastContent,
      )
    ) {
      const skills = buildSkillLibraryReport({
        groupFolder: group.folder,
        refresh: false,
      });
      const target =
        skills.recentRuns[0]?.skillId ||
        skills.active[0]?.skillId ||
        skills.suggested[0]?.skillId;
      const text = target
        ? applySkillControl({
            skillId: target,
            control: 'pause',
            groupFolder: group.folder,
          }).message
        : 'I do not have a specific learned skill to pause yet.';
      await sendAssistantReplyWithFeedback({
        text,
        routeKey: 'learning.control.pause_skill',
        capabilityId: 'memory.status',
        handlerKind: 'local_learning_control',
        responseSource: 'local_companion',
        traceReason: 'paused latest inspectable skill metadata when available',
        replyKind: 'completion',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (
      /\b(forget that|reset that pattern|make that my default)\b/i.test(
        lastContent,
      )
    ) {
      const report = buildLearningDistillationReport({
        groupFolder: group.folder,
      });
      const target =
        report.pendingConfirmations[0]?.distillationId ||
        report.candidates[0]?.distillationId;
      const control = /\bmake that my default\b/i.test(lastContent)
        ? 'confirm'
        : /\breset that pattern\b/i.test(lastContent)
          ? 'reset'
          : 'forget';
      const text = target
        ? applyLearningControl({
            targetId: target,
            control,
            groupFolder: group.folder,
          }).message
        : 'I do not have a specific learned item to change yet.';
      await sendAssistantReplyWithFeedback({
        text,
        routeKey: `learning.control.${control}`,
        capabilityId: 'memory.status',
        handlerKind: 'local_learning_control',
        responseSource: 'local_companion',
        traceReason:
          'updated latest inspectable learning metadata when available',
        replyKind: 'completion',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (/\balways ask first\b/i.test(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: 'Got it. Sensitive or high-impact learned items stay pending until you confirm them, and side-effect actions still require approval.',
        routeKey: 'learning.control.ask_first',
        capabilityId: 'memory.status',
        handlerKind: 'local_learning_control',
        responseSource: 'local_companion',
        traceReason: 'confirmed approval-first learning boundary',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (
      !/\b(what do you remember about me|what skills have you learned|show me what you learned this week|what did you learn|learned skills|learning status|how are you learning|how is your learning|how much have you learned)\b/i.test(
        lastContent,
      )
    ) {
      return false;
    }

    const text = /\b(skill|skills)\b/i.test(lastContent)
      ? formatSkillLibraryReport(
          buildSkillLibraryReport({
            groupFolder: group.folder,
            refresh: false,
          }),
        )
      : `${formatLearningDistillationReport({
          ...buildLearningDistillationReport({
            groupFolder: group.folder,
            persist: false,
          }),
          // Reflection signals predate group ownership and cannot safely be
          // attributed here. Keep cross-group aggregates out of chat.
          repeatedFriction: [],
        })}\n\n${formatReviewedOutcomeProgress(
          buildReviewedOutcomeProgress({
            groupFolder: group.folder,
            now,
          }),
        )}`;
    await sendAssistantReplyWithFeedback({
      text,
      routeKey: 'learning.status',
      capabilityId: 'memory.status',
      handlerKind: 'local_learning_status',
      responseSource: 'local_companion',
      traceReason:
        'answered learning and skill status from metadata-only ledgers',
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  const tryHandleCognitionDoctor = async (): Promise<boolean> => {
    if (
      !isCognitionDoctorRequest(lastContent) &&
      !isAgentOSNaturalRequest(lastContent) &&
      !isLogicNaturalRequest(lastContent) &&
      !isTruthNaturalRequest(lastContent) &&
      !isWorldModelNaturalRequest(lastContent) &&
      !isRealityNaturalRequest(lastContent) &&
      !isAgentRuntimeSpineNaturalRequest(lastContent) &&
      !isSupervisorNaturalRequest(lastContent) &&
      !isSessionGraphNaturalRequest(lastContent) &&
      !isAgencyConvergenceNaturalRequest(lastContent) &&
      !isCognitiveWorkspaceNaturalRequest(lastContent) &&
      !isMetacognitionNaturalRequest(lastContent) &&
      !isCognitiveExecutiveNaturalRequest(lastContent) &&
      !isGoalPlannerNaturalRequest(lastContent) &&
      !isBlackboardNaturalRequest(lastContent) &&
      !isActionLifecycleNaturalRequest(lastContent) &&
      !isCapabilityNaturalRequest(lastContent) &&
      !isEpisodeNaturalRequest(lastContent) &&
      !isAutonomyNaturalRequest(lastContent)
    ) {
      return false;
    }

    if (isBlackboardNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatBlackboardNaturalResponse(lastContent),
        routeKey: 'control_plane.blackboard',
        capabilityId: 'cognition.status',
        handlerKind: 'local_cognitive_blackboard',
        responseSource: 'local_companion',
        traceReason:
          'answered current-state request from metadata-only cognitive blackboard',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isActionLifecycleNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatActionLifecycleNaturalResponse(lastContent),
        routeKey: 'control_plane.action_lifecycle',
        capabilityId: 'cognition.status',
        handlerKind: 'local_action_lifecycle',
        responseSource: 'local_companion',
        traceReason:
          'answered pending-action request from metadata-only action lifecycle ledger',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isCapabilityNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatCapabilityNaturalResponse(lastContent),
        routeKey: 'control_plane.capabilities',
        capabilityId: 'cognition.status',
        handlerKind: 'local_capability_self_model',
        responseSource: 'local_companion',
        traceReason:
          'answered capability/setup request from metadata-only capability self-model',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isEpisodeNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatEpisodeNaturalResponse(lastContent),
        routeKey: 'control_plane.episodes',
        capabilityId: 'cognition.status',
        handlerKind: 'local_cognitive_episodes',
        responseSource: 'local_companion',
        traceReason:
          'answered learning-recall request from redacted episodic memory summaries',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isAutonomyNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatAutonomyNaturalResponse(),
        routeKey: 'control_plane.autonomy',
        capabilityId: 'cognition.status',
        handlerKind: 'local_autonomy_governor',
        responseSource: 'local_companion',
        traceReason:
          'answered autonomy-boundary request from static governor policy',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isMetacognitionNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatMetacognitionNaturalResponse(lastContent),
        routeKey: 'metacognition.explain',
        capabilityId: 'cognition.status',
        handlerKind: 'local_metacognition',
        responseSource: 'local_companion',
        traceReason:
          'answered metacognitive confidence/context request from metadata-only ledger',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (
      isCognitiveExecutiveNaturalRequest(lastContent) &&
      /\b(why did you suggest that|why did you choose|what are you using to decide|why didn'?t you|why are you bringing that up|current focus)\b/i.test(
        lastContent,
      )
    ) {
      await sendAssistantReplyWithFeedback({
        text: formatLatestCognitiveExecutiveExplanation(),
        routeKey: 'cognitive_executive.explain',
        capabilityId: 'cognition.status',
        handlerKind: 'local_cognitive_executive',
        responseSource: 'local_companion',
        traceReason:
          'answered executive route explanation from local metadata ledger',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isRealityNaturalRequest(lastContent)) {
      await sendAssistantReplyWithFeedback({
        text: formatRealityNaturalResponse(lastContent),
        routeKey: 'reality_grounding.status',
        capabilityId: 'cognition.status',
        handlerKind: 'local_reality_grounding',
        responseSource: 'local_companion',
        traceReason:
          'answered reality grounding status from metadata-only proof and tool truth',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    if (isGoalPlannerNaturalRequest(lastContent)) {
      const reply = formatGoalPlannerNaturalResponse(lastContent);
      const pilotRecord = startConversationPilotProof(
        resolveGoalPlannerPilotJourney(lastContent),
      );
      await sendAssistantReplyWithFeedback({
        text: reply,
        routeKey: 'goal_planner.status',
        capabilityId: 'cognition.status',
        handlerKind: 'local_goal_planner',
        responseSource: 'local_companion',
        traceReason:
          'answered goal-directed planning request from metadata-only planner',
        replyKind: 'progress',
        latencyTargetClass: 'local_command',
      });
      completeConversationPilotProof(pilotRecord, {
        outcome: 'success',
        blockerOwner: 'none',
        summaryText: reply,
      });
      clearSharedAssistantCapabilitySeed(chatJid);
      return true;
    }

    await sendAssistantReplyWithFeedback({
      text: [
        formatCognitiveDoctorReport(buildCognitiveDoctorReport()),
        '',
        buildAgentOSStatusText(),
        '',
        buildLogicStatusText(),
        '',
        buildTruthStatusText(),
        '',
        buildWorldModelStatusText(),
        '',
        buildRealityStatusText(),
        '',
        buildAgentRuntimeSpineStatusText(),
        '',
        buildSupervisorStatusText(),
        '',
        buildSessionGraphStatusText(),
        '',
        buildAgencyConvergenceStatusText(),
        '',
        buildCognitiveWorkspaceStatusText(),
        '',
        buildCognitiveExecutiveStatusText(),
        '',
        buildGoalPlannerStatusText(),
      ].join('\n'),
      routeKey: 'cognition.doctor',
      capabilityId: 'cognition.status',
      handlerKind: 'local_cognition_doctor',
      responseSource: 'local_companion',
      traceReason: 'answered cognitive task status from local metadata ledger',
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  const tryHandleDurableContinuity = async (): Promise<boolean> => {
    const text = buildDurableContinuityNaturalReply({
      text: lastContent,
      groupFolder: group.folder,
      now,
    });
    if (!text) return false;
    await sendAssistantReplyWithFeedback({
      text,
      routeKey: 'durable_continuity.recovery',
      capabilityId: 'cognition.status',
      handlerKind: 'local_durable_continuity',
      responseSource: 'local_companion',
      traceReason:
        'answered recovery request from canonical durable continuity metadata',
      preserveStructuredText: true,
      replyKind: 'progress',
      latencyTargetClass: 'local_command',
    });
    clearSharedAssistantCapabilitySeed(chatJid);
    return true;
  };

  if (
    requestPolicy.route === 'direct_assistant' ||
    requestPolicy.route === 'protected_assistant'
  ) {
    if (await tryHandleDurableContinuity()) {
      return true;
    }
    if (await tryHandleSelfImprovementStatus()) {
      return true;
    }
    if (await tryHandleCouncilDoctor()) {
      return true;
    }
    if (await tryHandleActiveReleaseReadinessReuse()) {
      return true;
    }
    if (await tryHandleCapabilityApprenticeshipOwnerAction()) {
      return true;
    }
    if (await tryHandleLearningStatus()) {
      return true;
    }
    if (await tryHandleCognitionDoctor()) {
      return true;
    }
    if (await tryHandleIntegrationDoctor()) {
      return true;
    }
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
    if (await tryHandleSharedAssistantCompletion()) {
      return true;
    }
    if (await tryHandleSharedAssistantCapability()) {
      return true;
    }
  }

  if (requestPolicy.route === 'direct_assistant') {
    if (await tryHandleOpenAiGuidedReply()) {
      return true;
    }
    if (await tryHandleBlueBubblesFluidDirectReply()) {
      return true;
    }
  }

  if (requestPolicy.route === 'direct_assistant' && quickReply) {
    const quickReplyPilot = startConversationPilotProof(
      resolveOrdinaryChatPilotJourney(lastContent),
    );
    const openAiGuidedFallbackDecision = (
      openAiGuidedRouteResult as {
        decision?: {
          selectedModelTier?: 'simple' | 'standard' | 'complex' | null;
          selectedModel?: string | null;
          providerMode?: 'direct_openai' | 'compatible_gateway' | null;
        } | null;
      } | null
    )?.decision;
    const openAiGuidedFallbackReason = (
      openAiGuidedRouteResult as { fallbackReason?: string | null } | null
    )?.fallbackReason;
    try {
      rememberOpenAiGuidedRoutingState({
        source: 'deterministic_fallback',
        routeKind: 'direct_quick_reply',
        fallbackReason:
          openAiGuidedFallbackReason ||
          'Fell back to the local quick reply matcher.',
        selectedModelTier:
          openAiGuidedFallbackDecision?.selectedModelTier || null,
        selectedModel: openAiGuidedFallbackDecision?.selectedModel || null,
        providerMode: openAiGuidedFallbackDecision?.providerMode || null,
      });
      await sendAssistantReplyWithFeedback({
        text: quickReply,
        routeKey: 'direct_quick_reply',
        handlerKind: 'direct_quick_reply',
        responseSource: 'local_companion',
        traceReason: 'handled message via direct quick reply fallback path',
        replyKind: 'progress',
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
          openAiGuidedFallback: true,
        },
        'Handled message via direct quick reply fallback path',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
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

  const tryHandleCompoundReminderResearch = async (): Promise<boolean> => {
    const compoundRequest = compoundReminderResearchPlan;
    if (!compoundRequest) return false;
    const plannedReminder = planSimpleReminder(
      compoundRequest.reminderText,
      group.folder,
      chatJid,
      now,
      reminderOperationIdentity,
    );
    if (!plannedReminder) return false;

    try {
      const persisted = persistReminderOperation(plannedReminder);
      syncOutcomeFromReminderTask(persisted.task, {
        linkedRefs: { reminderTaskId: persisted.task.id, chatJid },
        summaryText: plannedReminder.confirmation,
        now,
      });
      if (persisted.created) {
        refreshTaskSnapshots(registeredGroups);
      }
      setReminderResearchOperation(
        chatJid,
        {
          taskId: persisted.task.id,
          reminderStatus: 'persisted',
          researchStatus: 'not_started',
        },
        now,
      );
      clearSharedAssistantCapabilitySeed(chatJid);
      const priorResearchReceipt = getReminderResearchReceipt(
        chatJid,
        persisted.task.id,
      );
      const researchStatusNote = priorResearchReceipt
        ? priorResearchReceipt.status === 'completed'
          ? '\n\n*Research* This request already completed; I will not run it again automatically.'
          : '\n\n*Research* This request was already started and may have been interrupted before delivery. I will not replay it automatically; ask me to retry if you want a fresh run.'
        : '';
      const startResearch = () => {
        setReminderResearchReceipt(
          chatJid,
          persisted.task.id,
          'running',
          new Date(),
        );
        setReminderResearchOperation(
          chatJid,
          {
            taskId: persisted.task.id,
            reminderStatus: 'confirmation_delivered',
            researchStatus: 'running',
          },
          new Date(),
        );
        return executeAssistantCapability({
          capabilityId: inferResearchCapabilityId(compoundRequest.researchText),
          context: {
            channel: conversationChannel,
            groupFolder: group.folder,
            chatJid,
            ownerReviewAllowed: isTrustedOwnerReviewSurface({
              channelName: conversationChannel,
              chatJid,
              group,
              ownerAuthored: currentTurnOwnerAuthored,
            }),
            currentMessageId: latestUserMessage?.id,
            now,
          },
          input: {
            text: compoundRequest.researchText,
            canonicalText: compoundRequest.researchText,
            researchDepth: compoundRequest.requestedDepth,
            allowWebSearch: true,
            personalContextMode: 'disabled',
            researchFollowupMode: 'explicit_only',
          },
        });
      };
      const background = await deliverPrimaryThenStartReadOnlySidecar({
        deliverPrimary: async () => {
          await sendAssistantReplyWithFeedback({
            text: `${plannedReminder.confirmation}${researchStatusNote}`,
            routeKey: 'compound.reminder_research',
            capabilityId: 'capture.reminder',
            handlerKind: 'local_reminder',
            responseSource: 'local_companion',
            traceReason:
              'persisted the reminder before delivery and queued bounded read-only research',
            linkedRefs: { reminderTaskId: persisted.task.id },
            replyKind: 'completion',
          });
          setReminderResearchOperation(
            chatJid,
            {
              taskId: persisted.task.id,
              reminderStatus: 'confirmation_delivered',
              researchStatus: priorResearchReceipt?.status || 'not_started',
            },
            new Date(),
          );
        },
        startSidecar: priorResearchReceipt ? null : startResearch,
        deliverResult: async (result) => {
          if (!result.handled)
            throw new Error('Research capability declined the request.');
          setReminderResearchReceipt(
            chatJid,
            persisted.task.id,
            'completed',
            new Date(),
          );
          setReminderResearchOperation(
            chatJid,
            {
              taskId: persisted.task.id,
              reminderStatus: 'confirmation_delivered',
              researchStatus: 'completed',
            },
            new Date(),
          );
          await sendAssistantReplyWithFeedback({
            text: result.replyText || 'The research completed.',
            sendOptions: result.sendOptions || {},
            routeKey: 'compound.reminder_research',
            capabilityId:
              result.capabilityId ||
              inferResearchCapabilityId(compoundRequest.researchText),
            providerId: result.researchResult?.providerUsed || null,
            toolClass: 'compound_read_only_research',
            handlerKind: result.trace?.handlerKind || 'assistant_capability',
            responseSource: result.trace?.responseSource || 'local_companion',
            traceReason:
              result.trace?.reason ||
              'completed the independent read-only research leg after reminder delivery',
            traceNotes: [
              `compound_research_depth:${compoundRequest.requestedDepth}`,
              `compound_explicit_max_effort:${compoundRequest.explicitMaxEffort ? 'yes' : 'no'}`,
            ],
            skipCursorDeliveryMark: true,
            deliveryOrdinal: 2,
            replyKind: 'completion',
          });
        },
        deliverFailure: async (error) => {
          setReminderResearchReceipt(
            chatJid,
            persisted.task.id,
            'failed',
            new Date(),
          );
          setReminderResearchOperation(
            chatJid,
            {
              taskId: persisted.task.id,
              reminderStatus: 'confirmation_delivered',
              researchStatus: 'failed',
            },
            new Date(),
          );
          await sendAssistantReplyWithFeedback({
            text: '*Research*\nI saved the reminder, but research could not finish cleanly. Ask me to retry the research when the provider is available.',
            routeKey: 'compound.reminder_research',
            capabilityId: inferResearchCapabilityId(
              compoundRequest.researchText,
            ),
            handlerKind: 'assistant_capability',
            responseSource: 'unavailable',
            traceReason: 'the independent reminder research leg was blocked',
            blockerClass: 'compound_reminder_research_unavailable',
            traceNotes: [
              `error_class:${error instanceof Error ? error.name : typeof error}`,
            ],
            skipCursorDeliveryMark: true,
            deliveryOrdinal: 2,
            replyKind: 'blocked_notice',
          });
        },
        onSidecarDeliveryError: (error) => {
          logger.warn(
            {
              chatJid,
              errorClass: error instanceof Error ? error.name : typeof error,
            },
            'Reminder research completed but its result could not be delivered',
          );
        },
      });
      if (background) void background.completion;
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn({ group: group.name, err }, 'Compound reminder path failed');
      return false;
    }
  };

  const tryHandleReminderResearchStatus = async (): Promise<boolean> => {
    if (!isReminderResearchStatusPrompt(lastContent)) return false;
    const state = getReminderResearchOperation(chatJid);
    if (!state) return false;
    await sendAssistantReplyWithFeedback({
      text: formatReminderResearchStatus(state),
      routeKey: 'compound.reminder_research_status',
      capabilityId: 'capture.reminder',
      handlerKind: 'local_reminder',
      responseSource: 'local_companion',
      traceReason:
        'reported persisted reminder and research states without re-executing either leg',
      linkedRefs: { reminderTaskId: state.taskId },
      replyKind: 'progress',
    });
    return true;
  };

  if (requestPolicy.route === 'direct_assistant') {
    if (await tryHandleReminderResearchStatus()) return true;
    if (await tryHandleLocalActionLayer('direct')) {
      return true;
    }

    if (await tryHandleCompoundReminderResearch()) return true;

    const plannedReminder = planSimpleReminder(
      lastContent,
      group.folder,
      chatJid,
      now,
      reminderOperationIdentity,
    );
    if (plannedReminder) {
      try {
        const persisted = persistReminderOperation(plannedReminder);
        syncOutcomeFromReminderTask(persisted.task, {
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
          traceReason: 'handled simple reminder via local direct fast path',
          linkedRefs: {
            reminderTaskId: plannedReminder.task.id,
          },
          replyKind: 'completion',
        });
        logger.info(
          {
            component: 'assistant',
            chatJid,
            groupFolder: group.folder,
            group: group.name,
            taskId: plannedReminder.task.id,
          },
          'Handled reminder via local direct fast path',
        );
        return true;
      } catch (err) {
        if (isCommittedIncompleteDeliveryError(err)) throw err;
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name, err },
          'Local direct reminder path failed, rolled back cursor for retry',
        );
        return false;
      }
    }

    if (await tryHandleLocalDailyCompanion('direct')) {
      return true;
    }

    if (await tryHandleLocalCalendarReply('direct')) {
      return true;
    }
  }

  if (requestPolicy.route === 'protected_assistant') {
    if (await tryHandleReminderResearchStatus()) return true;
    if (await tryHandleLocalActionLayer('protected')) {
      return true;
    }

    if (await tryHandleCompoundReminderResearch()) return true;

    const plannedReminder = planSimpleReminder(
      lastContent,
      group.folder,
      chatJid,
      now,
      reminderOperationIdentity,
    );
    if (plannedReminder) {
      try {
        const persisted = persistReminderOperation(plannedReminder);
        syncOutcomeFromReminderTask(persisted.task, {
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
          replyKind: 'completion',
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
        if (isCommittedIncompleteDeliveryError(err)) throw err;
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
    messageId: missedMessages.at(-1)?.id,
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
        setLastReferencedLifeThread(
          chatJid,
          lifeThreadTurn.referencedThread,
          now,
        );
      }
      await sendAssistantReplyWithFeedback({
        text: lifeThreadTurn.responseText || 'Okay.',
        routeKey: 'life_thread_local',
        capabilityId: 'life_thread.local',
        handlerKind: 'life_thread_local',
        responseSource: 'local_companion',
        traceReason:
          'handled life thread request via local assistant fast path',
        linkedRefs: lifeThreadTurn.referencedThread
          ? {
              lifeThreadId: lifeThreadTurn.referencedThread.id,
            }
          : {},
        replyKind: 'completion',
      });
      logger.info(
        { group: group.name },
        'Handled life thread request via local assistant fast path',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
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
        replyKind: 'completion',
      });
      logger.info(
        { group: group.name },
        'Handled personalization request via local assistant fast path',
      );
      return true;
    } catch (err) {
      if (isCommittedIncompleteDeliveryError(err)) throw err;
      lastAgentTimestamp[chatJid] = previousCursor;
      saveState();
      logger.warn(
        { group: group.name, err },
        'Personalization fast path failed, rolled back cursor for retry',
      );
      return false;
    }
  }

  if (await tryHandleAgiRuntimeTurn()) {
    return true;
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
  let runtimeEvidenceReconciled = false;
  let scopedDeliveredTurnEvaluation: PreSendEvaluation | null = null;
  type BufferedAgentReply = {
    text: string;
    shielded: boolean;
    runtime?: string | null;
    selectedModel?: string | null;
    endpointMode?: string | null;
  };
  let bufferedAgentReplies: BufferedAgentReply[] = [];
  const reconcileCurrentRuntimeEvidence = (
    runtimeStatus: 'success' | 'error',
    evaluation?: PreSendEvaluation | null,
  ) => {
    if (runtimeEvidenceReconciled) {
      return turnAgentHarness?.verifiedDeepWorkPacket || null;
    }
    const packet = reconcileTurnRuntimeEvidence({
      context: turnAgentHarness,
      evaluation:
        evaluation ||
        scopedDeliveredTurnEvaluation ||
        latestDeliveredTurnEvaluation,
      runtimeToolEvidence: runtimeEvidenceScope.snapshot(),
      runtimeStatus,
      routeUsed: requestPolicy.route,
    });
    runtimeEvidenceReconciled = true;
    return packet;
  };
  const handleAgentOutput = async (result: ContainerOutput) => {
    if (result.runtimeToolEvidence) {
      runtimeEvidenceScope.observe(result.runtimeToolEvidence);
    }
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      const shieldedProtectedText =
        requestPolicy.route === 'protected_assistant'
          ? maybeShieldProtectedAssistantOutput(
              missedMessages,
              text,
              conversationChannel,
            )
          : null;
      const outboundText = shieldedProtectedText || text;
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
      if (outboundText) {
        // Runtime output is untrusted until the terminal attempt has finished
        // and its host-scoped evidence has been reconciled. Buffering here is
        // the last pre-send boundary: partial output can never outrun its
        // postcondition receipt.
        bufferedAgentReplies.push({
          text: outboundText,
          shielded: Boolean(shieldedProtectedText),
          runtime: result.runtime,
          selectedModel: result.selectedModel,
          endpointMode: result.endpointMode,
        });
      }
      resetIdleTimer();
    }

    if (result.status === 'success') {
      if (!result.result && outputSentToUser) {
        reconcileCurrentRuntimeEvidence('success');
      }
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
    bufferedAgentReplies = [];
    runtimeEvidenceScope.beginAttempt();
    const attemptOutput = await runAgent(
      group,
      promptText,
      chatJid,
      requestPolicy,
      effectiveIdleTimeout,
      freshSession,
      handleAgentOutput,
      (evidence) => runtimeEvidenceScope.observe(evidence),
    );
    if (attemptOutput.status === 'error' || hadError) {
      runtimeEvidenceScope.markCurrentAttemptFailed();
    }
    return attemptOutput;
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

  const runtimeFailed = output.status === 'error' || hadError;
  if (!runtimeFailed && bufferedAgentReplies.length > 0) {
    runtimeEvidenceScope.freezeDelivered();
    const terminalReply = bufferedAgentReplies.at(-1)!;
    const provisionalEvaluation = evaluateTurnReply({
      context: turnAgentHarness,
      text: terminalReply.text,
      routeKey: requestPolicy.route,
      handlerKind: terminalReply.shielded
        ? 'assistant_fallback'
        : requestPolicy.route === 'direct_assistant'
          ? 'container_direct_assistant'
          : 'container_assistant',
      responseSource: terminalReply.shielded
        ? 'local_companion'
        : 'container_agent',
    });
    const verifiedPacket = reconcileCurrentRuntimeEvidence(
      'success',
      provisionalEvaluation,
    );
    const completionNow = new Date();
    const completionEvidence = adaptiveCompletionEvidenceFromVerifiedRuntime({
      cognitiveRun: turnAgentHarness?.cognitiveRun,
      packet: verifiedPacket,
      now: completionNow,
    });
    const durableCompletionVerified =
      completionEvidence.length > 0
        ? await verifyTurnAgentAdaptiveCompletion({
            context: turnAgentHarness,
            completionEvidence,
            now: completionNow,
          })
        : false;
    const completionAuthorization = authorizeCognitiveReplyDelivery({
      cognitiveRun: turnAgentHarness?.cognitiveRun,
      replyKind: 'completion',
      completionEvidence,
      durableCompletionVerified,
      now: completionNow.toISOString(),
    });
    const repliesToDeliver = completionAuthorization.allowed
      ? bufferedAgentReplies
      : [terminalReply];
    for (const buffered of repliesToDeliver) {
      const replyKind: CognitiveReplyKind = buffered.shielded
        ? 'evidence_request'
        : 'completion';
      await sendAssistantReplyWithFeedback({
        text: buffered.text,
        routeKey: requestPolicy.route,
        handlerKind: buffered.shielded
          ? 'assistant_fallback'
          : requestPolicy.route === 'direct_assistant'
            ? 'container_direct_assistant'
            : 'container_assistant',
        responseSource: buffered.shielded
          ? 'local_companion'
          : 'container_agent',
        providerId: buffered.shielded
          ? 'local_runtime'
          : buffered.runtime || 'container_runtime',
        modelId: buffered.shielded
          ? undefined
          : buffered.selectedModel || undefined,
        endpointMode: buffered.shielded
          ? undefined
          : buffered.endpointMode || undefined,
        toolClass: 'container_agent',
        traceReason: buffered.shielded
          ? 'shielded protected assistant container output with a safe degraded reply'
          : requestPolicy.route === 'direct_assistant'
            ? 'handled request through the direct assistant container lane'
            : 'handled request through the assistant container lane',
        replyKind,
        completionEvidence:
          replyKind === 'completion' ? completionEvidence : undefined,
        durableCompletionVerified:
          replyKind === 'completion' ? durableCompletionVerified : false,
      });
      outputSentToUser = true;
      scopedDeliveredTurnEvaluation ||= latestDeliveredTurnEvaluation;
    }
    if (requestPolicy.route === 'direct_assistant') {
      lastDirectAssistantTextByChatJid[chatJid] =
        completionAuthorization.allowed
          ? terminalReply.text
          : completionAuthorization.safeFallbackText;
    }
  } else {
    reconcileCurrentRuntimeEvidence(runtimeFailed ? 'error' : 'success');
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

    if (requestPolicy.route === 'protected_assistant') {
      const shieldedProtectedFallback = maybeShieldProtectedAssistantOutput(
        missedMessages,
        output.userMessage || '',
        conversationChannel,
        { forceLiveLookupFallback: true },
      );
      if (shieldedProtectedFallback) {
        await sendAssistantReplyWithFeedback({
          text: shieldedProtectedFallback,
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_fallback',
          responseSource: 'local_companion',
          traceReason:
            'shielded a protected assistant runtime failure with a safe degraded reply',
          replyKind: 'evidence_request',
        });
        return true;
      }
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
          replyKind: 'evidence_request',
        });
      } else if (shouldNotify && output.userMessage) {
        await sendAssistantReplyWithFeedback({
          text: output.userMessage,
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_runtime_failure',
          responseSource: 'local_companion',
          traceReason:
            'reported a non-retriable agent/runtime issue back to the user',
          replyKind: 'blocked_notice',
        });
      } else if (!shouldNotify) {
        await sendAssistantReplyWithFeedback({
          text: buildRepeatedAgentErrorMessage(output.code),
          routeKey: requestPolicy.route,
          handlerKind: 'assistant_runtime_failure',
          responseSource: 'local_companion',
          traceReason: 'reported a repeated non-retriable agent/runtime issue',
          replyKind: 'blocked_notice',
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
        replyKind: 'blocked_notice',
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
    await sendAssistantReplyWithFeedback({
      text: fallbackReply,
      routeKey: requestPolicy.route,
      handlerKind: 'assistant_blank_success_fallback',
      responseSource: 'local_companion',
      traceReason:
        'reported a successful runtime without a verified user-visible completion',
      replyKind: 'evidence_request',
    });
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
      await sendAssistantReplyWithFeedback({
        text: proactiveCandidate.askText,
        routeKey: 'personalization.proactive_candidate',
        capabilityId: 'personalization.local',
        handlerKind: 'proactive_personalization_ask',
        responseSource: 'local_companion',
        traceReason:
          'asked a non-completion personalization question after the turn',
        replyKind: 'progress',
      });
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
  onSuppressedRuntimeEvidence?: (
    evidence: NonNullable<ContainerOutput['runtimeToolEvidence']>,
  ) => void | Promise<void>,
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
    requestPolicy.route === 'direct_assistant'
      ? undefined
      : agentThreads[group.folder] || getAgentThread(group.folder);
  if (existingThread) {
    agentThreads[group.folder] = existingThread;
  }
  const preferredRuntime = selectPreferredRuntime(existingThread, runtimeRoute);
  const persistedSessionId = sessions[sessionStorageKey];
  const sessionId = forceFreshSession ? undefined : persistedSessionId;

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
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
  let staleSessionStreamedEvidenceForwarded = false;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        const streamedText =
          typeof output.result === 'string' ? output.result : null;
        if (isDeadAssistantSessionErrorText(streamedText)) {
          staleSessionOutputDetected = true;
          const suppressedEvidence =
            getSuppressedDeadSessionRuntimeEvidence(output);
          if (suppressedEvidence) {
            await onSuppressedRuntimeEvidence?.(suppressedEvidence);
            staleSessionStreamedEvidenceForwarded = true;
          }
          return;
        }
        if (output.newSessionId) {
          sessions[sessionStorageKey] = output.newSessionId;
          setSession(sessionStorageKey, output.newSessionId);
          if (requestPolicy.route !== 'direct_assistant') {
            persistAgentThread(
              group.folder,
              output.newSessionId,
              output.runtime || preferredRuntime,
            );
          }
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
      (proc, containerName, ipcContext) =>
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          assistantCapabilityKey(requestPolicy),
          requestPolicy.route,
          ipcContext,
        ),
      wrappedOnOutput,
    );

    const staleSessionDetected =
      staleSessionOutputDetected ||
      isDeadAssistantSessionErrorText(output.error) ||
      isDeadAssistantSessionErrorText(
        typeof output.result === 'string' ? output.result : null,
      );

    if (staleSessionDetected) {
      const suppressedFinalEvidence = getSuppressedDeadSessionRuntimeEvidence(
        output,
        {
          streamedEvidenceForwarded: staleSessionStreamedEvidenceForwarded,
        },
      );
      if (suppressedFinalEvidence) {
        await onSuppressedRuntimeEvidence?.(suppressedFinalEvidence);
      }
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
          onSuppressedRuntimeEvidence,
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
      if (requestPolicy.route !== 'direct_assistant') {
        persistAgentThread(
          group.folder,
          output.newSessionId,
          output.runtime || preferredRuntime,
        );
      }
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
      const messages = listPendingActionableMessagesForChats(
        jids,
        MAX_MESSAGES_PER_PROMPT,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

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
          let durableTriggerMessage: NewMessage | null = null;

          // For non-main groups, only act on trigger messages.
          // Scan the durable sequence ledger in bounded pages so an old
          // chatter prefix can never hide a later trigger.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            durableTriggerMessage = findFirstPendingActionableMessageForChat({
              chatJid,
              predicate: (message) =>
                triggerPattern.test(message.content.trim()) &&
                (message.is_from_me ||
                  isTriggerAllowed(chatJid, message.sender, allowlistCfg)),
            });
            if (!durableTriggerMessage) continue;
          }

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

          if (mainChatRoutingDecision.kind === 'pipe_active_session') {
            // The IPC inbox currently has no durable consumer acknowledgement.
            // Writing a file and immediately marking ingress handled can lose a
            // command if the container exits before reading it, or replay it if
            // the host dies after consumption but before the ledger update.
            // Keep every protected messaging turn on the durable queue until an
            // end-to-end ACK protocol exists.
            queue.enqueueMessageCheck(chatJid);
            if (sessionState === 'idle_assistant') {
              queue.closeStdin(chatJid);
            }
            logger.debug(
              { chatJid, sessionState },
              'Queued actionable messaging ingress for durable fresh-turn processing',
            );
            continue;
          }

          if (mainChatRoutingDecision.kind === 'reply_locally') {
            // The claimed turn already has the same deterministic quick-reply
            // path plus an exact delivery-boundary ledger commit. Keep this
            // poller read-only so a crash cannot duplicate a reply or mark a
            // larger pending batch handled than the message it examined.
            queue.enqueueMessageCheck(chatJid);
            if (sessionState === 'idle_assistant') {
              queue.closeStdin(chatJid);
            }
            logger.debug(
              { chatJid, sessionState },
              'Queued local quick reply through durable claimed processing',
            );
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
 * Handles a crash after live ingress was stored but before that chat's
 * processing cursor was durably advanced.
 */
function recoverPendingMessages(): void {
  for (const chatJid of listProcessableCompanionChatJids()) {
    const group = resolveCompanionBinding(chatJid)?.group;
    if (!group) continue;
    const pending = listPendingActionableMessagesForChats(
      [chatJid],
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

type AndreaPlatformProofState =
  | 'LIVE_PROVEN'
  | 'NEAR_LIVE_ONLY'
  | 'DEGRADED_BUT_USABLE'
  | 'EXTERNALLY_BLOCKED';
type AndreaPlatformHealthState =
  | 'healthy'
  | 'degraded'
  | 'faulted'
  | 'blocked_external'
  | 'near_live_only';

function compactPlatformStrings(
  values: Record<string, string | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

function sanitizePlatformControlText(value: string | null | undefined): string {
  if (!value) return '';
  const markers = [
    'OPENAI_API_KEY=',
    'ANTHROPIC_API_KEY=',
    'stack trace:',
    'Traceback (most recent call last)',
  ];
  let sanitized = value;
  for (const marker of markers) {
    const index = sanitized.indexOf(marker);
    if (index >= 0) {
      sanitized = `${sanitized.slice(0, index).trim()} Provider/runtime diagnostic detail omitted from platform control-plane truth.`;
      break;
    }
  }
  return sanitized.replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function toAndreaPlatformProofState(
  state: FieldTrialProofState,
): AndreaPlatformProofState | null {
  switch (state) {
    case 'live_proven':
      return 'LIVE_PROVEN';
    case 'near_live_only':
      return 'NEAR_LIVE_ONLY';
    case 'degraded_but_usable':
      return 'DEGRADED_BUT_USABLE';
    case 'externally_blocked':
      return 'EXTERNALLY_BLOCKED';
    case 'not_intended_for_trial':
      return null;
  }
}

function toAndreaPlatformHealthState(
  state: FieldTrialProofState,
): AndreaPlatformHealthState {
  switch (state) {
    case 'live_proven':
      return 'healthy';
    case 'near_live_only':
      return 'near_live_only';
    case 'externally_blocked':
      return 'blocked_external';
    case 'degraded_but_usable':
    case 'not_intended_for_trial':
      return 'degraded';
  }
}

function summarizePlatformProofTruth(truth: FieldTrialSurfaceTruth): string {
  return sanitizePlatformControlText(
    truth.detail || truth.blocker || truth.nextAction || truth.proofState,
  );
}

function emitAndreaPlatformSurfaceProof(
  surface: string,
  journey: string,
  truth: FieldTrialSurfaceTruth,
  extraMetadata?: Record<string, string | null | undefined>,
): void {
  const state = toAndreaPlatformProofState(truth.proofState);
  if (!state) return;
  void emitAndreaPlatformProofEvent({
    surface,
    journey,
    state,
    summary: summarizePlatformProofTruth(truth),
    blocker: sanitizePlatformControlText(truth.blocker) || null,
    nextAction: sanitizePlatformControlText(truth.nextAction) || null,
    metadata: compactPlatformStrings({
      blockerOwner: truth.blockerOwner,
      ...(extraMetadata || {}),
    }),
  });
}

function combinePlatformProofStates(
  truths: readonly FieldTrialSurfaceTruth[],
): AndreaPlatformProofState {
  if (truths.some((truth) => truth.proofState === 'externally_blocked')) {
    return 'EXTERNALLY_BLOCKED';
  }
  if (truths.some((truth) => truth.proofState === 'degraded_but_usable')) {
    return 'DEGRADED_BUT_USABLE';
  }
  if (truths.some((truth) => truth.proofState === 'near_live_only')) {
    return 'NEAR_LIVE_ONLY';
  }
  return 'LIVE_PROVEN';
}

function buildBlueBubblesPlatformMetadata(
  truth: FieldTrialBlueBubblesTruth,
): Record<string, string | null | undefined> {
  return {
    configuredReplyGateMode: truth.configuredReplyGateMode,
    effectiveReplyGateMode: truth.effectiveReplyGateMode,
    mostRecentEngagedChatJid: truth.mostRecentEngagedChatJid,
    mostRecentEngagedAt: truth.mostRecentEngagedAt,
    conversationKind: truth.conversationKind,
    decisionPolicy: truth.decisionPolicy,
    conversationalEligibility: truth.conversationalEligibility,
    requiresExplicitMention: truth.requiresExplicitMention ? 'true' : 'false',
    recentTargetChatJid: truth.recentTargetChatJid,
    recentTargetAt: truth.recentTargetAt,
    openMessageActionCount: String(truth.openMessageActionCount),
    continuityState: truth.continuityState,
    proofCandidateChatJid: truth.proofCandidateChatJid,
    activeMessageActionId: truth.activeMessageActionId,
    activePresentationAt: truth.activePresentationAt,
    eligibleFollowups:
      truth.eligibleFollowups.length > 0
        ? truth.eligibleFollowups.join(' | ')
        : null,
    canonicalSelfThreadChatJid: truth.canonicalSelfThreadChatJid,
    sourceSelfThreadChatJid: truth.sourceSelfThreadChatJid,
    messageActionProofState: truth.messageActionProofState,
    messageActionProofChatJid: truth.messageActionProofChatJid,
    messageActionProofAt: truth.messageActionProofAt,
    proofDrillState: truth.proofDrillState,
    proofDrillActionId: truth.proofDrillActionId,
    proofDrillStartedAt: truth.proofDrillStartedAt,
    proofDrillNextStep: truth.proofDrillNextStep,
    transportState: truth.transportState,
    webhookRegistrationState: truth.webhookRegistrationState,
  };
}

function emitAndreaPlatformProofTruths(truth: FieldTrialOperatorTruth): void {
  const surfaces: Array<[string, string, FieldTrialSurfaceTruth]> = [
    ['telegram', 'roundtrip', truth.telegram],
    ['alexa', 'signed_intent', truth.alexa],
    ['bluebubbles', 'same_thread_message_action', truth.bluebubbles],
    ['google_calendar', 'read_write', truth.googleCalendar],
    ['work_cockpit', 'runtime_status', truth.workCockpit],
    ['life_threads', 'continuity', truth.lifeThreads],
    ['communication_companion', 'reply_help', truth.communicationCompanion],
    ['chief_of_staff_missions', 'daily_guidance', truth.chiefOfStaffMissions],
    ['knowledge_library', 'saved_material', truth.knowledgeLibrary],
    [
      'action_bundles_delegation_outcome_review',
      'feedback_loop',
      truth.actionBundlesDelegationOutcomeReview,
    ],
    ['research', 'live_facts', truth.research],
    ['image_generation', 'telegram_image', truth.imageGeneration],
    ['host_health', 'runtime_host', truth.hostHealth],
  ];
  for (const [surface, journey, surfaceTruth] of surfaces) {
    emitAndreaPlatformSurfaceProof(
      surface,
      journey,
      surfaceTruth,
      surface === 'bluebubbles'
        ? buildBlueBubblesPlatformMetadata(truth.bluebubbles)
        : undefined,
    );
  }
  for (const [journeyId, journeyTruth] of Object.entries(truth.journeys)) {
    emitAndreaPlatformSurfaceProof('journey', journeyId, journeyTruth);
  }
  emitAndreaPlatformSurfaceProof(
    'memory',
    'profile_pack',
    truth.knowledgeLibrary,
  );
  void emitAndreaPlatformProofEvent({
    surface: 'integrations',
    journey: 'registry',
    state: combinePlatformProofStates([
      truth.googleCalendar,
      truth.bluebubbles,
      truth.research,
      truth.imageGeneration,
      truth.alexa,
    ]),
    summary:
      'Integration registry truth is derived from calendar, messages, Alexa, research, and image-provider proof states.',
    metadata: compactPlatformStrings({
      googleCalendar: truth.googleCalendar.proofState,
      bluebubbles: truth.bluebubbles.proofState,
      alexa: truth.alexa.proofState,
      research: truth.research.proofState,
      imageGeneration: truth.imageGeneration.proofState,
    }),
  });
  emitAndreaPlatformSurfaceProof(
    'rituals',
    'daily_guidance',
    truth.journeys.daily_guidance,
  );
}

function channelTransportKind(
  channelName: string,
): 'telegram' | 'bluebubbles' | 'other' {
  const normalized = channelName.toLowerCase();
  if (normalized.includes('telegram')) return 'telegram';
  if (normalized.includes('bluebubbles')) return 'bluebubbles';
  return 'other';
}

function channelTransportState(
  channel: ChannelHealthSnapshot,
): AndreaPlatformHealthState {
  if (!channel.configured) return 'degraded';
  if (channel.state === 'ready') return 'healthy';
  if (channel.state === 'stopped') return 'faulted';
  return 'degraded';
}

function secondsSinceTimestamp(
  timestamp: string | null | undefined,
): number | null {
  if (!timestamp) return null;
  const millis = Date.parse(timestamp);
  if (Number.isNaN(millis)) return null;
  return Math.max(0, Math.floor((Date.now() - millis) / 1000));
}

function emitAndreaPlatformTransportTruths(
  channelHealth: readonly ChannelHealthSnapshot[],
  truth: FieldTrialOperatorTruth,
): void {
  for (const channel of channelHealth) {
    const kind = channelTransportKind(channel.name);
    void emitAndreaPlatformTransportEvent({
      transportId: channel.name,
      transportKind: kind,
      state: channelTransportState(channel),
      summary: sanitizePlatformControlText(
        channel.detail ||
          channel.lastError ||
          `${channel.name} channel is ${channel.state}.`,
      ),
      detail:
        sanitizePlatformControlText(
          channel.lastError || channel.detail || null,
        ) || null,
      freshnessSeconds: secondsSinceTimestamp(channel.updatedAt),
      deliverySemantics:
        kind === 'telegram'
          ? 'telegram_long_polling'
          : kind === 'bluebubbles'
            ? 'bluebubbles_webhook_shadow_poll'
            : 'channel_adapter',
      fallbackTarget: kind === 'bluebubbles' ? 'telegram' : 'none',
      blocker: sanitizePlatformControlText(channel.lastError) || null,
      metadata: compactPlatformStrings({
        configured: String(channel.configured),
        channelState: channel.state,
        operatingMode: channel.operatingMode || '',
        inboundAvailable:
          channel.capabilities == null
            ? ''
            : String(channel.capabilities.inboundAvailable),
        outboundAvailable:
          channel.capabilities == null
            ? ''
            : String(channel.capabilities.outboundAvailable),
        lastReadyAt: channel.lastReadyAt || '',
        ...(kind === 'bluebubbles'
          ? buildBlueBubblesPlatformMetadata(truth.bluebubbles)
          : {}),
      }),
    });
  }
  void emitAndreaPlatformTransportEvent({
    transportId: 'alexa_public_ingress',
    transportKind: 'alexa',
    state: toAndreaPlatformHealthState(truth.alexa.proofState),
    summary: summarizePlatformProofTruth(truth.alexa),
    detail:
      sanitizePlatformControlText(truth.alexa.detail || truth.alexa.blocker) ||
      null,
    deliverySemantics: 'signed_https_request',
    fallbackTarget: 'telegram',
    blocker: sanitizePlatformControlText(truth.alexa.blocker) || null,
    nextAction: sanitizePlatformControlText(truth.alexa.nextAction) || null,
  });
  void emitAndreaPlatformTransportEvent({
    transportId: 'research_provider',
    transportKind: 'provider',
    state: toAndreaPlatformHealthState(truth.research.proofState),
    summary: summarizePlatformProofTruth(truth.research),
    detail:
      sanitizePlatformControlText(
        truth.research.detail || truth.research.blocker,
      ) || null,
    deliverySemantics: 'provider_api',
    fallbackTarget: 'saved_material_only',
    blocker: sanitizePlatformControlText(truth.research.blocker) || null,
    nextAction: sanitizePlatformControlText(truth.research.nextAction) || null,
  });
  void emitAndreaPlatformTransportEvent({
    transportId: 'image_generation_provider',
    transportKind: 'provider',
    state: toAndreaPlatformHealthState(truth.imageGeneration.proofState),
    summary: summarizePlatformProofTruth(truth.imageGeneration),
    detail:
      sanitizePlatformControlText(
        truth.imageGeneration.detail || truth.imageGeneration.blocker,
      ) || null,
    deliverySemantics: 'provider_api',
    fallbackTarget: 'telegram_text_handoff',
    blocker: sanitizePlatformControlText(truth.imageGeneration.blocker) || null,
    nextAction:
      sanitizePlatformControlText(truth.imageGeneration.nextAction) || null,
  });
  void emitAndreaPlatformTransportEvent({
    transportId: 'local_gateway',
    transportKind: 'gateway',
    state: toAndreaPlatformHealthState(truth.hostHealth.proofState),
    summary: summarizePlatformProofTruth(truth.hostHealth),
    detail:
      sanitizePlatformControlText(
        truth.hostHealth.detail || truth.hostHealth.blocker,
      ) || null,
    deliverySemantics: 'local_process_and_http',
    fallbackTarget: 'operator_status',
    blocker: sanitizePlatformControlText(truth.hostHealth.blocker) || null,
    nextAction:
      sanitizePlatformControlText(truth.hostHealth.nextAction) || null,
  });
}

async function main(): Promise<void> {
  // This must remain the first runtime action. In particular, database and
  // recovery state below must never be touched by overlapping main processes.
  const runtimeProcessLock = await acquireRuntimeProcessLock(
    ACTIVE_RUNTIME_PROCESS_LOCK_PATH,
  );
  const releaseRuntimeProcessLockOnExit = () => {
    try {
      if (!runtimeProcessLock.releaseSync()) {
        logger.error(
          {
            component: 'runtime_process_lock',
            lockPath: runtimeProcessLock.lockPath,
          },
          'Runtime process lock ownership changed before exit; preserved the current lock file',
        );
      }
    } catch (err) {
      logger.error(
        {
          component: 'runtime_process_lock',
          lockPath: runtimeProcessLock.lockPath,
          err,
        },
        'Runtime process lock could not be released during exit',
      );
    }
  };
  // Cover startup failures before the full shutdown state is initialized.
  process.once('exit', releaseRuntimeProcessLockOnExit);
  const exitDuringStartup = (signal: 'SIGTERM' | 'SIGINT') => {
    logger.info(
      { component: 'runtime_process_lock', signal },
      'Shutdown signal received during startup',
    );
    process.exit(0);
  };
  const exitDuringStartupOnSigterm = () => exitDuringStartup('SIGTERM');
  const exitDuringStartupOnSigint = () => exitDuringStartup('SIGINT');
  process.once('SIGTERM', exitDuringStartupOnSigterm);
  process.once('SIGINT', exitDuringStartupOnSigint);

  if (ACTIVE_RUNTIME_ARTIFACT.isCompiledArtifact) {
    process.env.ANDREA_BUILD_ID = requireVerifiedRuntimeBuild({
      projectRoot: ACTIVE_REPO_ROOT,
      expectedGitCommit: ACTIVE_GIT_COMMIT,
      runnerBuildId: process.env.ANDREA_BUILD_ID,
      runtimeName: 'Compiled Andrea runtime',
    });
  } else if (!process.env.ANDREA_BUILD_ID?.trim()) {
    process.env.ANDREA_BUILD_ID = 'development-source';
  }
  const appVersion = resolveAppVersion();
  const channelHealthByName = new Map<string, ChannelHealthSnapshot>();
  let assistantHealthInterval: ReturnType<typeof setInterval> | null = null;
  let systemAlertInterval: ReturnType<typeof setInterval> | null = null;
  let bootAlertInterval: ReturnType<typeof setInterval> | null = null;
  let toolReliabilityInterval: ReturnType<typeof setInterval> | null = null;
  let toolReliabilityRefreshInFlight = false;
  const systemAlertLastStateByKey = new Map<string, string>();
  const systemAlertLastChannelFaultByKey = new Map<string, string>();
  const systemAlertLastSentAtByKey = new Map<string, number>();
  const writeCurrentAssistantHealth = () => {
    try {
      const currentChannelHealth = [...channelHealthByName.values()];
      const activeGroupFolders = [
        ...new Set(
          Object.values(registeredGroups)
            .map((group) => group.folder)
            .filter(Boolean),
        ),
      ];
      writeAssistantHealthState({
        appVersion,
        channelHealth: currentChannelHealth,
      });
      void emitAndreaPlatformShellHealth(
        mapShellHealthFromChannelHealth(currentChannelHealth),
      );
      for (const snapshot of buildAndreaPlatformConfigSnapshots(
        activeGroupFolders,
      )) {
        void emitAndreaPlatformShellConfigSnapshot(snapshot);
      }
      const operatorTruth = buildFieldTrialOperatorTruth();
      emitAndreaPlatformProofTruths(operatorTruth);
      emitAndreaPlatformTransportTruths(currentChannelHealth, operatorTruth);
    } catch (err) {
      logger.warn({ err }, 'Failed to persist assistant health marker');
    }
  };
  const sendSystemAlertMessage = async (
    targetChannel: 'telegram' | 'bluebubbles',
    message: string,
  ): Promise<'confirmed' | 'unverified' | false> => {
    const target =
      targetChannel === 'telegram'
        ? resolveTelegramMainChatForAlexa('main')
        : resolveBlueBubblesCompanionChat('main');
    if (!target?.chatJid) return false;
    const channel = findChannel(channels, target.chatJid);
    if (
      !channel ||
      channel.name !== targetChannel ||
      channel.isConnected() !== true
    ) {
      return false;
    }
    const result = await channel.sendMessage(target.chatJid, message);
    const classification = classifyChannelDelivery(result);
    if (classification.outcome === 'confirmed') return 'confirmed';
    if (
      classification.outcome === 'partial' ||
      classification.outcome === 'unknown'
    ) {
      logger.error(
        {
          component: 'system_alert_delivery',
          channel: targetChannel,
          deliveryOutcome: classification.outcome,
          confirmedReceiptCount: classification.confirmedReceiptCount,
          nextUnconfirmedChunkIndex: classification.nextUnconfirmedChunkIndex,
        },
        'System alert delivery is unverified; cooldown will suppress automatic replay',
      );
      return 'unverified';
    }
    return false;
  };
  const maybeSendSystemAlert = async (params: {
    dedupeKey: string;
    state: string;
    message: string;
  }): Promise<boolean> => {
    const alertConfig = resolveSystemAlertConfig();
    if (!alertConfig.enabled) return false;

    const now = Date.now();
    const cooldownMs = alertConfig.cooldownMinutes * 60_000;
    const lastSentAt = systemAlertLastSentAtByKey.get(params.dedupeKey) || 0;
    if (lastSentAt > 0 && now - lastSentAt < cooldownMs) {
      return false;
    }

    const attempted: string[] = [];
    let sent = false;
    for (const channelName of alertConfig.channels) {
      attempted.push(channelName);
      try {
        if (
          (await sendSystemAlertMessage(channelName, params.message)) !== false
        ) {
          sent = true;
        }
      } catch (err) {
        logger.warn(
          { err, channelName, dedupeKey: params.dedupeKey },
          'System alert channel send failed',
        );
      }
    }

    if (sent) {
      systemAlertLastSentAtByKey.set(params.dedupeKey, now);
    } else {
      logger.warn(
        { attempted, dedupeKey: params.dedupeKey, state: params.state },
        'System alert could not be delivered to any configured channel',
      );
    }
    return sent;
  };
  const dispatchPendingBootSummaryAlert = async (): Promise<void> => {
    const pending = readPendingBootAlert();
    if (!pending) return;
    const sent = await maybeSendSystemAlert({
      dedupeKey: pending.dedupeKey,
      state: pending.status,
      message: pending.message,
    });
    if (sent) {
      clearPendingBootAlert(pending.alertId);
    }
  };
  const providerTransitionForState = (
    state: ProviderHealthState,
  ): 'down' | 'degraded' =>
    state === 'degraded' || state === 'externally_blocked'
      ? 'degraded'
      : 'down';
  const providerSeverityForState = (
    state: ProviderHealthState,
  ): AlertEventSnapshot['severity'] =>
    state === 'not_configured'
      ? 'info'
      : state === 'healthy'
        ? 'info'
        : 'warning';
  const emitProviderAlertIfNeeded = async (
    provider: ProviderHealthSnapshot,
  ): Promise<void> => {
    const key = `provider:${provider.providerId}`;
    const previousState = systemAlertLastStateByKey.get(key);

    if (
      provider.state !== 'healthy' &&
      !shouldEmitProviderAlertSnapshot(provider)
    ) {
      return;
    }
    systemAlertLastStateByKey.set(key, provider.state);

    if (provider.state === 'healthy') {
      if (previousState && previousState !== 'healthy') {
        await maybeSendSystemAlert({
          dedupeKey: `${key}:recovered`,
          state: provider.state,
          message: formatProviderHealthAlertMessage({
            provider,
            transition: 'recovered',
            severity: 'info',
          }),
        });
      }
      return;
    }

    await maybeSendSystemAlert({
      dedupeKey: `${key}:${provider.failureClass}`,
      state: provider.state,
      message: formatProviderHealthAlertMessage({
        provider,
        transition: providerTransitionForState(provider.state),
        severity: providerSeverityForState(provider.state),
      }),
    });
  };
  const formatChannelAlertMessage = (params: {
    snapshot: ChannelHealthSnapshot;
    transition: 'down' | 'degraded' | 'recovered';
    severity: AlertEventSnapshot['severity'];
  }): string => {
    const { snapshot, transition, severity } = params;
    const assessment = assessChannelHealthAlert(snapshot);
    const symptom =
      transition === 'recovered'
        ? `${snapshot.name} recovered and is ready again.`
        : snapshot.detail ||
          snapshot.lastError ||
          `${snapshot.name} channel is ${snapshot.state}.`;
    const nextAction =
      transition === 'recovered'
        ? 'No action needed. Andrea will keep monitoring.'
        : assessment.nextAction;
    return [
      'Andrea system alert',
      `System: ${snapshot.name}`,
      `Severity: ${severity}`,
      `Transition: ${transition}`,
      `Symptom: ${symptom}`,
      `Likely cause: ${assessment.likelyCause}`,
      `Next action: ${nextAction}`,
      'Class: external/manual-or-host',
    ].join('\n');
  };
  const emitChannelAlertIfNeeded = async (
    snapshot: ChannelHealthSnapshot,
  ): Promise<void> => {
    const key = `channel:${snapshot.name}`;
    const previousFault = systemAlertLastChannelFaultByKey.get(key) || null;
    const decision = decideChannelHealthAlert(snapshot, previousFault);
    const { assessment } = decision;

    if (decision.event === 'none') {
      if (!assessment.actionable) {
        systemAlertLastChannelFaultByKey.delete(key);
      }
      return;
    }

    if (decision.event === 'recovered') {
      systemAlertLastChannelFaultByKey.delete(key);
      await maybeSendSystemAlert({
        dedupeKey: `${key}:recovered`,
        state: 'healthy',
        message: formatChannelAlertMessage({
          snapshot,
          transition: 'recovered',
          severity: 'info',
        }),
      });
      return;
    }

    const sent = await maybeSendSystemAlert({
      dedupeKey: `${key}:${assessment.fingerprint}`,
      state: snapshot.state,
      message: formatChannelAlertMessage({
        snapshot,
        transition: snapshot.state === 'stopped' ? 'down' : 'degraded',
        severity: snapshot.state === 'stopped' ? 'critical' : 'warning',
      }),
    });
    if (sent) {
      systemAlertLastChannelFaultByKey.set(key, assessment.fingerprint!);
    }
  };
  const dispatchSystemHealthAlerts = async (): Promise<void> => {
    const alertConfig = resolveSystemAlertConfig();
    if (!alertConfig.enabled) return;
    await dispatchPendingBootSummaryAlert();
    const checkedAt = new Date().toISOString();
    for (const provider of collectProviderHealthSnapshots(checkedAt)) {
      await emitProviderAlertIfNeeded(provider);
    }
    for (const snapshot of channelHealthByName.values()) {
      await emitChannelAlertIfNeeded(snapshot);
    }
  };
  const refreshCurrentToolReliability = async (
    trigger: 'startup' | 'interval',
  ): Promise<void> => {
    if (toolReliabilityRefreshInFlight) return;
    toolReliabilityRefreshInFlight = true;
    try {
      const report = await refreshToolReliabilityFromCurrentTruth();
      logger.debug(
        {
          component: 'tool_reliability',
          trigger,
          subjects: report.subjects.length,
          degraded: report.degradedSubjectCount,
        },
        'Refreshed bounded tool-reliability truth.',
      );
    } catch (err) {
      logger.warn(
        { component: 'tool_reliability', trigger, err },
        'Tool-reliability truth refresh failed; prior evidence remains intact.',
      );
    } finally {
      toolReliabilityRefreshInFlight = false;
    }
  };
  const stopAssistantHealthLoop = () => {
    if (assistantHealthInterval) {
      clearInterval(assistantHealthInterval);
      assistantHealthInterval = null;
    }
    if (systemAlertInterval) {
      clearInterval(systemAlertInterval);
      systemAlertInterval = null;
    }
    if (bootAlertInterval) {
      clearInterval(bootAlertInterval);
      bootAlertInterval = null;
    }
    if (toolReliabilityInterval) {
      clearInterval(toolReliabilityInterval);
      toolReliabilityInterval = null;
    }
    clearAssistantHealthState();
    clearTelegramTransportState();
  };

  // Replace the startup-only exit hook before the first shared filesystem or
  // database mutation. This keeps the process lock held until health markers
  // and transports are marked stopped, then releases it synchronously as the
  // final exit operation.
  process.removeListener('exit', releaseRuntimeProcessLockOnExit);
  process.once('exit', () => {
    try {
      stopAssistantHealthLoop();
      clearAssistantReadyState();
    } finally {
      releaseRuntimeProcessLockOnExit();
    }
  });

  clearAssistantHealthState();
  clearAssistantReadyState();
  clearTelegramTransportState();
  ensureContainerSystemRunning();
  initDatabase();
  // Fence stale actionable ingress before any channel connects, any callback
  // can enqueue work, or the shared queue is given a processor. Once a stale
  // row has been claimed into an in-memory turn, a later database quarantine
  // cannot revoke side effects that the turn has already started.
  const startupIngressRecovery = prepareActionableIngressForStartupRecovery();
  if (startupIngressRecovery.quarantinedBlueBubblesMessageCount > 0) {
    logger.warn(
      {
        cutoff: startupIngressRecovery.blueBubblesRecoveryCutoff,
        quarantinedMessageCount:
          startupIngressRecovery.quarantinedBlueBubblesMessageCount,
      },
      'Quarantined stale BlueBubbles actionable ingress before startup recovery',
    );
  }
  if (startupIngressRecovery.recoveredIngressClaimCount > 0) {
    logger.info(
      {
        recoveredClaimCount: startupIngressRecovery.recoveredIngressClaimCount,
      },
      'Recovered durable actionable ingress claims from the prior process',
    );
  }
  const durableContinuityRecovery =
    reconcileDurableContinuityBeforeAcceptingWork();
  logger.info(
    {
      component: 'durable_continuity',
      ...durableContinuityRecovery,
    },
    'Reconciled durable work leases before accepting new work.',
  );
  const interruptedReflectionRecovery =
    reconcileInterruptedPostDeliveryReflections();
  if (interruptedReflectionRecovery.reconciled > 0) {
    logger.warn(
      {
        component: 'post_delivery_reflection',
        reconciled: interruptedReflectionRecovery.reconciled,
        inspected: interruptedReflectionRecovery.inspected,
      },
      'Reconciled post-delivery reflections interrupted by a prior process.',
    );
  }
  const interruptedRuntimeRecovery = reconcileInterruptedAgentRuntimeRuns();
  if (
    interruptedRuntimeRecovery.interrupted > 0 ||
    interruptedRuntimeRecovery.episodeSynced > 0
  ) {
    logger.warn(
      {
        component: 'agent_runtime_spine',
        ...interruptedRuntimeRecovery,
      },
      'Reconciled runtime and Agent OS lifecycle state from a prior process.',
    );
  }
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
  let blueBubblesControlServer: ReturnType<
    typeof startBlueBubblesControlServer
  > = null;
  let blueBubblesReceiptInboxStore: BlueBubblesReceiptInboxStore | null = null;
  let blueBubblesReceiptInboxConsumer: BlueBubblesReceiptInboxConsumer | null =
    null;
  let ownerCockpitServer: ReturnType<typeof startOwnerCockpitServer> = null;

  // This is the final shared cursor mutation during shutdown. The exit hook
  // that follows it is synchronous, so no channel work can interleave before
  // health-state cleanup and process-lock release.
  const finalizeInFlightCursorRollback = () => {
    if (inFlightCursorRollbacks.size === 0) return;
    inFlightCursorRollbacks.rollbackAll((chatJid, previousCursor) => {
      lastAgentTimestamp[chatJid] = previousCursor;
      logger.info(
        { component: 'assistant', chatJid },
        'Rolled back message cursor for unresolved turn; it will retry after restart',
      );
    });
    saveState();
  };

  // Graceful shutdown handlers
  const performShutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopAssistantHealthLoop();
    clearAssistantReadyState();
    await queue.shutdown(10000);
    const reflectionDrain = await drainPostDeliveryReflections(5_000);
    if (reflectionDrain.attempted > 0) {
      logger.info(
        {
          component: 'post_delivery_reflection',
          ...reflectionDrain,
        },
        reflectionDrain.timedOut
          ? 'Shutdown reflection drain reached its bounded timeout; startup will reconcile remaining work.'
          : 'Shutdown drained active post-delivery reflections.',
      );
    }
    const readOnlySidecarDrain = await drainBackgroundReadOnlySidecars(10_000);
    if (readOnlySidecarDrain.attempted > 0) {
      logger.info(
        {
          component: 'background_read_only_sidecar',
          ...readOnlySidecarDrain,
        },
        readOnlySidecarDrain.timedOut
          ? 'Shutdown read-only sidecar drain reached its bounded timeout; unfinished non-durable work must be requested again after restart.'
          : 'Shutdown drained active read-only sidecars.',
      );
    }
    if (alexaRuntime) {
      await alexaRuntime
        .close()
        .catch((err) =>
          logger.warn({ err }, 'Alexa voice ingress shutdown failed'),
        );
    }
    if (blueBubblesControlServer) {
      await new Promise<void>((resolve) =>
        blueBubblesControlServer?.close(() => resolve()),
      ).catch((err) =>
        logger.warn({ err }, 'BlueBubbles control API shutdown failed'),
      );
    }
    if (blueBubblesReceiptInboxConsumer) {
      await blueBubblesReceiptInboxConsumer
        .shutdown()
        .catch((err) =>
          logger.warn(
            { err },
            'BlueBubbles receipt inbox consumer shutdown failed',
          ),
        );
      blueBubblesReceiptInboxConsumer = null;
    }
    if (blueBubblesReceiptInboxStore) {
      try {
        blueBubblesReceiptInboxStore.close();
      } catch (err) {
        logger.warn({ err }, 'BlueBubbles receipt inbox store shutdown failed');
      }
      blueBubblesReceiptInboxStore = null;
    }
    if (ownerCockpitServer) {
      await new Promise<void>((resolve) =>
        ownerCockpitServer?.close(() => resolve()),
      ).catch((err) => logger.warn({ err }, 'Owner cockpit shutdown failed'));
    }
    if (agiRuntime) {
      await agiRuntime
        .shutdown()
        .catch((err) => logger.warn({ err }, 'AGI runtime shutdown failed'));
    }
    for (const ch of channels) {
      await ch
        .disconnect()
        .catch((err) =>
          logger.warn(
            { err, channel: ch.name },
            'Channel disconnect failed during shutdown',
          ),
        );
    }
  };
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    let exitCode = 0;
    shutdownPromise = performShutdown(signal)
      .catch((err) => {
        exitCode = 1;
        logger.error({ signal, err }, 'Graceful shutdown failed');
      })
      .finally(() => {
        try {
          finalizeInFlightCursorRollback();
        } catch (err) {
          exitCode = 1;
          logger.error(
            { signal, err },
            'Failed to persist unresolved-turn cursor rollback during shutdown',
          );
        } finally {
          process.exit(exitCode);
        }
      });
    return shutdownPromise;
  };
  process.removeListener('SIGTERM', exitDuringStartupOnSigterm);
  process.removeListener('SIGINT', exitDuringStartupOnSigint);
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const CURSOR_STATUS_COMMANDS = new Set(['/cursor-status', '/cursor_status']);
  const CURSOR_CREATE_USAGE =
    'Usage: /cursor-create [--model MODEL_ID] [--repo REPO_URL] [--ref GIT_REF] [--pr PR_URL] [--branch BRANCH_NAME] [--auto-pr] [--cursor-github-app] [--skip-reviewer] PROMPT';
  const CURSOR_DOWNLOAD_USAGE =
    'Usage: /cursor-download [AGENT_ID|LIST_NUMBER|current] ABSOLUTE_PATH';
  const _CURSOR_ARTIFACT_LINK_USAGE =
    'Usage: /cursor-artifact-link AGENT_ID ABSOLUTE_PATH';
  const _RUNTIME_CREATE_USAGE = 'Usage: /runtime-create TEXT';
  const _RUNTIME_JOBS_USAGE = 'Usage: /runtime-jobs [LIMIT] [BEFORE_JOB_ID]';
  const _RUNTIME_JOB_USAGE = 'Usage: /runtime-job [JOB_ID]';
  const _RUNTIME_FOLLOWUP_USAGE = 'Usage: /runtime-followup JOB_ID TEXT';
  const _RUNTIME_STOP_USAGE = 'Usage: /runtime-stop [JOB_ID]';
  const _RUNTIME_LOGS_USAGE = 'Usage: /runtime-logs [JOB_ID] [LINES]';
  const CURSOR_TERMINAL_USAGE =
    'Usage: /cursor-terminal [AGENT_ID|LIST_NUMBER|current] COMMAND';
  const _CURSOR_TERMINAL_STATUS_USAGE =
    'Usage: /cursor-terminal-status [AGENT_ID|LIST_NUMBER|current]';
  const _CURSOR_TERMINAL_LOG_USAGE =
    'Usage: /cursor-terminal-log [AGENT_ID|LIST_NUMBER|current] [LIMIT]';
  const _CURSOR_TERMINAL_STOP_USAGE =
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
    if (params.target.via !== 'current' && params.target.via !== 'selected') {
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
    const sent = acceptConfirmedPresentationDelivery({
      result: await channel.sendMessage(
        chatJid,
        text,
        buildOperatorSendOptions(message, extra),
      ),
      channel: channel.name,
      chatJid,
      workflow: 'cursor_operator_message',
    });
    return sent?.platformMessageId;
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

  function mapResponseFeedbackTaskFamily(
    record: Pick<
      ResponseFeedbackRecord,
      'routeKey' | 'capabilityId' | 'responseSource'
    >,
  ):
    | 'calendar'
    | 'communication'
    | 'research'
    | 'media'
    | 'assistant'
    | 'operator'
    | 'code'
    | 'unknown' {
    const routeText = [
      record.routeKey,
      record.capabilityId,
      record.responseSource,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (routeText.includes('calendar')) return 'calendar';
    if (
      routeText.includes('communication') ||
      routeText.includes('reply') ||
      routeText.includes('message') ||
      routeText.includes('text')
    ) {
      return 'communication';
    }
    if (routeText.includes('research') || routeText.includes('news')) {
      return 'research';
    }
    if (routeText.includes('image') || routeText.includes('media'))
      return 'media';
    if (routeText.includes('runtime') || routeText.includes('work_cockpit')) {
      return 'operator';
    }
    if (routeText.includes('code') || routeText.includes('repo')) return 'code';
    return routeText ? 'assistant' : 'unknown';
  }

  async function emitResponseFeedbackCognition(
    record: ResponseFeedbackRecord,
  ): Promise<ResponseFeedbackRecord> {
    void emitAndreaPlatformTraceEvent({
      traceId: record.feedbackId,
      traceKind: 'feedback',
      title: 'Response feedback downvote captured',
      summary: buildResponseFeedbackIssueSummary(record),
      refs: compactPlatformStrings({
        feedbackId: record.feedbackId,
        issueId: record.issueId || '',
        platformMessageId: record.platformMessageId || '',
        userMessageId: record.userMessageId || '',
        remediationJobId: record.remediationJobId || '',
      }),
      metadata: compactPlatformStrings({
        status: record.status,
        classification: record.classification,
        routeKey: record.routeKey || '',
        capabilityId: record.capabilityId || '',
        blockerClass: record.blockerClass || '',
        blockerOwner: record.blockerOwner,
      }),
    });
    const platform = await emitAndreaPlatformFeedbackReflection({
      feedbackId: record.feedbackId,
      issueId: record.issueId || null,
      status: record.status,
      classification: record.classification,
      taskFamily: mapResponseFeedbackTaskFamily(record),
      channel: record.channel,
      groupFolder: record.groupFolder,
      chatJid: record.chatJid,
      threadId: record.threadId || null,
      routeKey: record.routeKey || null,
      capabilityId: record.capabilityId || null,
      handlerKind: record.handlerKind || null,
      responseSource: record.responseSource || null,
      blockerClass: record.blockerClass || null,
      blockerOwner: record.blockerOwner,
      platformMessageId: record.platformMessageId || null,
      userMessageId: record.userMessageId || null,
      remediationLaneId: record.remediationLaneId || null,
      remediationJobId: record.remediationJobId || null,
      originalUserPreview: sanitizePlatformControlText(
        summarizeResponseFeedbackText(
          record.originalUserText,
          'original ask',
          220,
        ),
      ),
      assistantReplyPreview: sanitizePlatformControlText(
        summarizeResponseFeedbackText(
          record.assistantReplyText,
          'assistant reply',
          220,
        ),
      ),
      summary: buildResponseFeedbackIssueSummary(record),
    });
    if (!platform) return record;
    return updateResponseFeedback(record.feedbackId, {
      linkedRefs: {
        ...(record.linkedRefs || {}),
        platformTaskLedgerId: platform.taskLedgerId,
        platformProgressLedgerId: platform.progressLedgerId,
        platformReflectionId: platform.reflectionId,
        platformEvaluationId: platform.evaluationId,
        platformLearningId: platform.learningId,
        platformSkillCandidateIds: [
          ...((record.linkedRefs || {}).platformSkillCandidateIds || []),
          ...(platform.skillCandidateId ? [platform.skillCandidateId] : []),
        ],
      },
    });
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

  function mapResponseFeedbackRepairWorker(
    runtimePreference: ResponseFeedbackRecord['remediationRuntimePreference'],
  ): { workerId: string | null; cloudWorkerId: string | null } {
    switch (runtimePreference) {
      case 'cursor_cloud':
        return { workerId: 'openai_cloud', cloudWorkerId: 'cursor_cloud' };
      case 'codex_cloud':
        return { workerId: 'openai_cloud', cloudWorkerId: 'codex_cloud' };
      case 'codex_local':
        return { workerId: 'codex_local', cloudWorkerId: null };
      case 'cursor_local':
        return { workerId: 'codex_local', cloudWorkerId: 'cursor_local' };
      default:
        return { workerId: null, cloudWorkerId: null };
    }
  }

  function buildResponseFeedbackApprovalScope(
    record: ResponseFeedbackRecord,
    scope: RepairApprovalScope = 'execution_only',
  ): string {
    return [
      `feedback:${record.feedbackId}`,
      `classification:${record.classification}`,
      'repo:Andrea_NanoBot',
      'tests:npm run typecheck,npm run build,npm test',
      `landing_scope:${scope}`,
      'secrets:false',
      'external_accounts:false',
      'outbound_messages:false',
    ].join('; ');
  }

  function buildResponseFeedbackFallbackPolicy(
    laneSelection: ResponseFeedbackLaneSelection,
  ): string {
    if (laneSelection.runtimePreference === 'codex_local') {
      return 'cloud_unavailable_explicit_local_fallback_required';
    }
    if (
      laneSelection.runtimePreference === 'cursor_cloud' ||
      laneSelection.runtimePreference === 'codex_cloud'
    ) {
      return 'cloud_preferred_no_local_fallback_without_new_approval';
    }
    return 'no_ready_repair_lane';
  }

  function buildResponseFeedbackLaneSelectionFromRecord(
    record: ResponseFeedbackRecord,
  ): ResponseFeedbackLaneSelection | null {
    if (!record.remediationRuntimePreference || !record.remediationLaneId) {
      return null;
    }
    const reason =
      record.operatorNote ||
      'Andrea staged this repair lane during the feedback capture step.';
    switch (record.remediationRuntimePreference) {
      case 'cursor_cloud':
        return {
          laneId: 'cursor',
          runtimePreference: 'cursor_cloud',
          label: 'Cursor Cloud',
          promptPrefix: '',
          reason,
        };
      case 'codex_cloud':
        return {
          laneId: 'andrea_runtime',
          runtimePreference: 'codex_cloud',
          label: 'Codex cloud',
          promptPrefix: '[runtime: cloud]',
          reason,
        };
      case 'codex_local':
        return {
          laneId: 'andrea_runtime',
          runtimePreference: 'codex_local',
          label: 'Codex local',
          promptPrefix: '[runtime: local]',
          reason,
        };
      case 'cursor_local':
        return {
          laneId: null,
          runtimePreference: 'cursor_local',
          label: 'Cursor desktop bridge',
          promptPrefix: '',
          reason,
        };
      default:
        return null;
    }
  }

  async function selectCurrentResponseFeedbackRepairLane(
    record: ResponseFeedbackRecord,
  ): Promise<ResponseFeedbackLaneSelection> {
    const runtimeStatus = await getAndreaOpenAiBackendStatus();
    const cursorCloudStatus = getCursorCloudStatus();
    const cursorDesktopStatus = await getCursorDesktopStatus({ probe: true });
    return selectResponseFeedbackRetryLane({
      record,
      availability: {
        runtimeAvailable: runtimeStatus.state === 'available',
        runtimeLocalPreferred:
          runtimeStatus.state === 'available' &&
          runtimeStatus.meta?.localExecutionState === 'available_authenticated',
        runtimeCloudAllowed: runtimeStatus.state === 'available',
        runtimeDetail:
          runtimeStatus.meta?.localExecutionState === 'available_authenticated'
            ? 'Codex local is healthy and authenticated on this host.'
            : runtimeStatus.detail ||
              runtimeStatus.meta?.operatorGuidance ||
              null,
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
      },
    });
  }

  async function emitResponseFeedbackRepairAutopilotPlan(
    record: ResponseFeedbackRecord,
    laneSelection: ResponseFeedbackLaneSelection,
  ): Promise<ResponseFeedbackRecord> {
    const taskFamily = mapResponseFeedbackTaskFamily(record);
    const repairWorker = mapResponseFeedbackRepairWorker(
      laneSelection.runtimePreference,
    );
    const goal = `Diagnose and repair downvoted ${taskFamily} response ${record.feedbackId}.`;
    const diagnosis = await emitAndreaPlatformDiagnosis({
      goal,
      correlationId: record.feedbackId,
      taskFamily,
      channel: record.channel,
      includePlatformSignals: true,
      signals: [
        {
          signalKind: 'response_feedback_downvote',
          severity:
            record.classification === 'repo_side_broken' ? 'error' : 'warn',
          source: 'andrea_nanobot',
          feedbackId: record.feedbackId,
          issueId: record.issueId || '',
          taskFamily,
          classification: record.classification,
          blockerOwner: record.blockerOwner,
        },
      ],
      metadata: compactPlatformStrings({
        feedbackId: record.feedbackId,
        issueId: record.issueId || '',
        routeKey: record.routeKey || '',
        capabilityId: record.capabilityId || '',
        laneId: laneSelection.laneId || '',
        runtimePreference: laneSelection.runtimePreference || '',
        cloudRepairReadiness:
          laneSelection.runtimePreference === 'cursor_cloud' ||
          laneSelection.runtimePreference === 'codex_cloud'
            ? 'healthy'
            : 'unavailable',
        fallbackPolicy: buildResponseFeedbackFallbackPolicy(laneSelection),
      }),
    });
    const approvalScope = buildResponseFeedbackApprovalScope(record);
    const fallbackPolicy = buildResponseFeedbackFallbackPolicy(laneSelection);
    const repairPlan = await emitAndreaPlatformRepairPlan({
      goal,
      diagnosisId: diagnosis?.diagnosisId || null,
      correlationId: record.feedbackId,
      title: `Repair downvoted ${taskFamily} response`,
      workerId: repairWorker.workerId,
      cloudWorkerId: repairWorker.cloudWorkerId,
      affectedRepos: ['Andrea_NanoBot'],
      affectedServices: ['nanobot'],
      testsRequired: ['npm run typecheck', 'npm run build', 'npm test'],
      restartRequired: false,
      deployAllowed: false,
      metadata: compactPlatformStrings({
        feedbackId: record.feedbackId,
        issueId: record.issueId || '',
        selectedLaneId: laneSelection.laneId || '',
        selectedRuntimePreference: laneSelection.runtimePreference || '',
        selectedLaneLabel: laneSelection.label,
        selectedWorkerReason: laneSelection.reason,
        approvalScope,
        executionGate: 'explicit_feedback_approval_required',
        verificationGate: 'typecheck_build_full_test_before_landing',
        landingGate: 'commit_push_restart_only_when_approval_scope_allows',
        fallbackPolicy,
        localFallbackRequiresExplicitApproval:
          laneSelection.runtimePreference === 'codex_local' ? 'true' : 'false',
        cloudRepairReadiness:
          laneSelection.runtimePreference === 'cursor_cloud' ||
          laneSelection.runtimePreference === 'codex_cloud'
            ? 'healthy'
            : 'unavailable',
        cloudPreferred:
          laneSelection.runtimePreference === 'cursor_cloud' ||
          laneSelection.runtimePreference === 'codex_cloud'
            ? 'true'
            : 'false',
        localFallback:
          laneSelection.runtimePreference === 'codex_local' ? 'true' : 'false',
      }),
    });
    if (!diagnosis && !repairPlan) return record;
    return updateResponseFeedback(record.feedbackId, {
      linkedRefs: {
        ...(record.linkedRefs || {}),
        platformDiagnosisId: diagnosis?.diagnosisId,
        platformRepairPlanId: repairPlan?.repairPlanId,
        platformRepairRunId:
          repairPlan?.repairRunId || diagnosis?.repairRunId || undefined,
        repairApprovalScope: approvalScope,
        repairSelectedWorker: laneSelection.runtimePreference || undefined,
        repairFallbackPolicy: fallbackPolicy,
      },
      remediationLaneId: laneSelection.laneId,
      remediationRuntimePreference: laneSelection.runtimePreference,
      operatorNote:
        laneSelection.runtimePreference === 'codex_local'
          ? `${laneSelection.reason} Platform staged a one-approval repair plan first; local Codex is the fallback because no cloud repair lane is ready.`
          : repairPlan?.approvalSummary || laneSelection.reason,
    });
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
        stderr ||
          stdout ||
          `git ${args.join(' ')} failed in ${ACTIVE_REPO_ROOT}.`,
        { cause: err },
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
      if (laneId === 'andrea_runtime') {
        return updateResponseFeedback(record.feedbackId, {
          status: 'captured',
          operatorNote: buildResponseFeedbackReadOnlyLaneNote(),
        });
      }
      if (!hasResponseFeedbackLocalHotfix(record)) {
        return updateResponseFeedback(record.feedbackId, {
          status: 'captured',
          operatorNote: buildResponseFeedbackNoHotfixNote(),
        });
      }
      return updateResponseFeedback(record.feedbackId, {
        status: 'resolved_locally',
        operatorNote:
          'The remediation task completed locally and is waiting for explicit landing approval.',
      });
    }

    if (
      isFailedResponseFeedbackTaskStatus(taskStatus) &&
      record.status !== 'resolved_locally' &&
      record.status !== 'landed'
    ) {
      const operatorNote = buildResponseFeedbackFailureNote(taskStatus);
      if (record.status === 'failed' && record.operatorNote === operatorNote) {
        return record;
      }
      return updateResponseFeedback(record.feedbackId, {
        status: 'failed',
        operatorNote,
      });
    }

    return record;
  }

  async function syncResponseFeedbackWorkerResult(params: {
    record: ResponseFeedbackRecord;
    laneId: NonNullable<ResponseFeedbackRecord['remediationLaneId']>;
    job: BackendJobDetails;
  }): Promise<ResponseFeedbackRecord> {
    const { record, laneId, job } = params;
    if (!record.linkedRefs.platformRepairPlanId) return record;
    if (!isSuccessfulResponseFeedbackTaskStatus(job.status)) return record;
    const existingResultAt = record.linkedRefs.repairWorkerResultAt;
    if (
      existingResultAt &&
      record.linkedRefs.repairWorkerResultStatus &&
      record.linkedRefs.repairWorkerResultStatus !== 'waiting_for_cloud_result'
    ) {
      return record;
    }

    const lane =
      laneId === 'cursor' ? cursorBackendLane : getAndreaRuntimeLane();
    const outputText = await collectRepairWorkerOutput({
      lane,
      job,
      groupFolder: record.groupFolder,
      chatJid: record.chatJid,
    });
    const result = parseRepairWorkerResult(outputText, job.metadata || null);
    const landingScope: RepairApprovalScope =
      record.linkedRefs.repairLandingScope === 'execution_and_landing'
        ? 'execution_and_landing'
        : (record.linkedRefs.repairApprovalScope || '').includes(
              'landing_scope:execution_and_landing',
            )
          ? 'execution_and_landing'
          : 'execution_only';
    const nextLegalAction =
      result.nextLegalAction ||
      deriveRepairNextLegalAction(
        result.status,
        result.needsLocalApply,
        landingScope,
      );
    const verification = buildRepairVerificationBundle(result, {
      feedbackId: record.feedbackId,
      repairPlanId: record.linkedRefs.platformRepairPlanId,
      executionId: record.linkedRefs.platformRepairExecutionId || null,
      workerId: record.remediationRuntimePreference || null,
      laneId,
      jobId: record.remediationJobId,
    });

    const evidence = await emitAndreaPlatformRepairEvidence({
      repairPlanId: record.linkedRefs.platformRepairPlanId,
      correlationId: record.feedbackId,
      evidenceKind: verification.evidenceKind,
      command: verification.command,
      passed: verification.passed,
      summary: verification.summary,
      artifactPath: result.patchArtifact,
      final: true,
      metadata: compactPlatformStrings(verification.metadata),
    });

    const verificationIds: string[] = [
      ...(record.linkedRefs.verificationEvidenceIds || []),
      ...(evidence?.verificationEvidenceId
        ? [evidence.verificationEvidenceId]
        : []),
    ].filter(
      (value, index, values): value is string =>
        Boolean(value) && values.indexOf(value) === index,
    );
    let platformComplete: Awaited<
      ReturnType<typeof emitAndreaPlatformRepairComplete>
    > | null = null;
    if (verification.passed && !result.needsLocalApply) {
      platformComplete = await emitAndreaPlatformRepairComplete({
        repairPlanId: record.linkedRefs.platformRepairPlanId,
        executionId: record.linkedRefs.platformRepairExecutionId,
        correlationId: record.feedbackId,
        status: 'completed',
        finalHealthState: 'verified_worker_result',
        summary: result.verificationSummary,
        metadata: compactPlatformStrings({
          feedbackId: record.feedbackId,
          workerResultStatus: result.status,
          nextLegalAction,
        }),
      });
    }

    const status: ResponseFeedbackRecord['status'] =
      result.status === 'failed_tests'
        ? 'failed'
        : result.status === 'blocked_external'
          ? 'blocked_external'
          : verification.passed
            ? 'resolved_locally'
            : 'captured';
    const operatorNote =
      result.status === 'waiting_for_cloud_result'
        ? 'The repair worker finished, but it did not return the required structured verification contract yet.'
        : result.status === 'failed_tests'
          ? 'The repair worker returned failed test evidence, so Andrea paused before any landing step.'
          : result.status === 'blocked_external'
            ? 'The repair worker found an external/manual blocker, so Andrea paused without pretending this is repo-fixed.'
            : result.needsLocalApply
              ? 'The repair worker returned a verified patch artifact. Andrea needs explicit landing approval before local apply/commit/push/restart.'
              : 'The repair worker returned passing verification evidence. Andrea linked it to the repair run.';

    return updateResponseFeedback(record.feedbackId, {
      linkedRefs: {
        ...(record.linkedRefs || {}),
        platformRepairRunId:
          evidence?.repairRunId ||
          platformComplete?.repairRunId ||
          record.linkedRefs.platformRepairRunId,
        platformTraceGradeId:
          evidence?.traceGradeId ||
          platformComplete?.traceGradeId ||
          record.linkedRefs.platformTraceGradeId,
        platformSkillCandidateIds: platformComplete?.skillCandidateId
          ? [
              ...(record.linkedRefs.platformSkillCandidateIds || []),
              platformComplete.skillCandidateId,
            ]
          : record.linkedRefs.platformSkillCandidateIds,
        verificationEvidenceIds: verificationIds,
        repairWorkerResultStatus: result.status,
        repairWorkerResultAt: new Date().toISOString(),
        repairWorkerResultSummary: result.verificationSummary,
        repairWorkerResultBlockerClass: result.blockerClass || undefined,
        repairWorkerNeedsLocalApply: String(result.needsLocalApply),
        repairVerificationState: verification.passed
          ? 'verified'
          : 'not_verified',
        repairLandingScope: landingScope,
        repairNextLegalAction: nextLegalAction,
        repairPatchArtifact: result.patchArtifact || undefined,
        repairTestsPassed:
          result.testsPassed === null ? 'unknown' : String(result.testsPassed),
        repairFinalHealthState: platformComplete
          ? 'verified_worker_result'
          : undefined,
      },
      status,
      operatorNote,
    });
  }

  async function refreshRunningResponseFeedbackRecord(
    record: ResponseFeedbackRecord,
  ): Promise<ResponseFeedbackRecord> {
    if (!record.remediationLaneId || !record.remediationJobId) {
      return record;
    }

    try {
      if (record.remediationLaneId === 'andrea_runtime') {
        const job = await getAndreaRuntimeLane().getJob({
          handle: {
            laneId: 'andrea_runtime',
            jobId: record.remediationJobId,
          },
          groupFolder: record.groupFolder,
          chatJid: record.chatJid,
        });
        if (!job) return record;
        const synced =
          syncResponseFeedbackFromTaskStatus(
            'andrea_runtime',
            record.remediationJobId,
            job.status,
          ) || record;
        return syncResponseFeedbackWorkerResult({
          record: synced,
          laneId: 'andrea_runtime',
          job,
        });
      }

      const job = await cursorBackendLane.getJob({
        handle: {
          laneId: 'cursor',
          jobId: record.remediationJobId,
        },
        groupFolder: record.groupFolder,
        chatJid: record.chatJid,
      });
      if (!job) return record;
      const synced =
        syncResponseFeedbackFromTaskStatus(
          'cursor',
          record.remediationJobId,
          job.status,
        ) || record;
      return syncResponseFeedbackWorkerResult({
        record: synced,
        laneId: 'cursor',
        job,
      });
    } catch (err) {
      logger.warn(
        {
          err,
          feedbackId: record.feedbackId,
          laneId: record.remediationLaneId,
          remediationJobId: record.remediationJobId,
        },
        'Failed to refresh response feedback remediation state',
      );
      return record;
    }
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
    options: {
      acknowledge?: boolean;
      completionVerified?: boolean;
      memoryCorrectness?: boolean;
      reviewSource?: 'inline_action' | 'native_reaction' | 'natural_language';
    } = {},
  ): Promise<boolean> {
    const feedbackNow = new Date();
    const acknowledge = options.acknowledge !== false;
    const reviewSource = options.reviewSource || 'inline_action';
    const channel = findChannel(channels, chatJid);
    const group = resolveCompanionBinding(chatJid)?.group;
    const authorizedFeedbackSurface = isTrustedOwnerReviewSurface({
      channelName: channel?.name,
      chatJid,
      group,
      ownerAuthored: msg.is_from_me === true,
    });
    if (!channel || !group || !authorizedFeedbackSurface) {
      return true;
    }

    let existing = getResponseFeedback(action.feedbackId);
    const sameFeedbackChat =
      existing?.chatJid === chatJid ||
      (existing?.channel === 'bluebubbles' &&
        isBlueBubblesSelfThreadAliasJid(existing.chatJid) &&
        isBlueBubblesSelfThreadAliasJid(chatJid));
    if (!existing || !sameFeedbackChat) {
      if (acknowledge) {
        await channel.sendMessage(
          chatJid,
          'That feedback card is no longer available here.',
          buildOperatorSendOptions(msg),
        );
      }
      return true;
    }
    existing = await refreshRunningResponseFeedbackRecord(existing);
    const feedbackGroupFolder = existing.groupFolder;

    let linkedRefs: ResponseFeedbackRecord['linkedRefs'] = {
      ...(existing.linkedRefs || {}),
      responseFeedbackId: existing.feedbackId,
      platformMessageId:
        existing.linkedRefs?.platformMessageId ||
        existing.platformMessageId ||
        undefined,
      userMessageId:
        existing.linkedRefs?.userMessageId ||
        existing.userMessageId ||
        undefined,
    };
    const reconcileAdaptiveFeedback = (input: {
      verdict: 'accepted' | 'rejected';
      completionVerified?: boolean;
      correction?: boolean;
    }): void => {
      try {
        reconcileAdaptiveOwnerFeedbackByTurn({
          turnId: linkedRefs.userMessageId || existing?.userMessageId || null,
          feedbackId: existing!.feedbackId,
          verdict: input.verdict,
          routeKey: existing?.routeKey || null,
          completionVerified: input.completionVerified,
          correction: input.correction,
          observedAt: feedbackNow.toISOString(),
        });
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        logger.warn(
          { error, feedbackId: existing?.feedbackId },
          'Adaptive owner-feedback reconciliation failed closed',
        );
      }
    };
    const recordLinkedMemoryJudgment = (): boolean =>
      options.memoryCorrectness !== undefined &&
      Boolean(
        linkedRefs.personalContextPacketId &&
        recordMemoryRetrievalJudgment({
          groupFolder: feedbackGroupFolder,
          packetId: linkedRefs.personalContextPacketId,
          correct: options.memoryCorrectness,
          reviewSource: 'natural_language',
          now: feedbackNow,
        }),
      );
    const buildNextReviewQueue = (record: ResponseFeedbackRecord) => {
      if (record.channel !== 'telegram' && record.channel !== 'bluebubbles') {
        return null;
      }
      const queue = buildResponseFeedbackReviewQueue({
        records: listRecentResponseFeedback({
          groupFolder: feedbackGroupFolder,
          limit: 100,
        }),
        groupFolder: feedbackGroupFolder,
        channel: record.channel,
        allowedChatJids:
          record.channel === 'bluebubbles'
            ? expandBlueBubblesLogicalSelfThreadJids(chatJid)
            : [chatJid],
        now: feedbackNow,
      });
      return queue.candidate ? queue : null;
    };

    if (action.operation === 'accept') {
      const memoryJudgmentRecorded = recordLinkedMemoryJudgment();
      const cognitiveReview = recordCognitiveOwnerReview({
        runId: linkedRefs.cognitiveRunId,
        feedbackId: existing.feedbackId,
        verdict: 'accepted',
        reviewedAt: feedbackNow.toISOString(),
      });
      linkedRefs = {
        ...linkedRefs,
        cognitiveOwnerReviewSignalId:
          cognitiveReview.signalId || linkedRefs.cognitiveOwnerReviewSignalId,
      };
      const updated = updateResponseFeedback(existing.feedbackId, {
        linkedRefs,
        status: 'accepted',
        operatorNote: cognitiveReview.recorded
          ? `Owner marked the response helpful via ${reviewSource}; the review was linked to its cognitive run.`
          : `Owner marked the response helpful via ${reviewSource}; no retained cognitive run was available to update.`,
        updatedAt: feedbackNow.toISOString(),
      });
      recordReviewedRecommendationOutcome({
        feedbackId: updated.feedbackId,
        groupFolder: updated.groupFolder,
        verdict: 'accepted',
        completionVerified: options.completionVerified,
        metadata: {
          routeKey: updated.routeKey || '',
          cognitiveRunId: linkedRefs.cognitiveRunId || '',
          reviewSource,
          ...(linkedRefs.verifiedDeepWorkPacketId
            ? { packetId: linkedRefs.verifiedDeepWorkPacketId }
            : {}),
        },
        now: feedbackNow,
      });
      reconcileAdaptiveFeedback({
        verdict: 'accepted',
        completionVerified: options.completionVerified,
      });
      if (acknowledge) {
        const linkedMission = linkedRefs.verifiedDeepWorkPacketId
          ? getVerifiedDeepWorkPacket(linkedRefs.verifiedDeepWorkPacketId)
          : undefined;
        const missionInvitation = linkedMission
          ? buildDeepWorkReviewInvitation(linkedMission)
          : null;
        const progressText = formatReviewedOutcomeProgress(
          buildReviewedOutcomeProgress({
            groupFolder: updated.groupFolder,
            now: feedbackNow,
          }),
        );
        const acknowledgement = memoryJudgmentRecorded
          ? 'Thanks — I recorded that the retrieved memory was correct and linked it to the exact context packet.'
          : options.completionVerified
            ? cognitiveReview.recorded
              ? 'Thanks — I recorded that it worked and linked the verified outcome to the exact reasoning route.'
              : 'Thanks — I recorded that it worked.'
            : cognitiveReview.recorded
              ? 'Thanks — I linked that helpful outcome to the exact reasoning route so repeated success can improve future choices.'
              : 'Thanks — I recorded that as helpful.';
        const nextReviewQueue = buildNextReviewQueue(updated);
        await channel.sendMessage(
          chatJid,
          `${acknowledgement}\n${progressText}${missionInvitation ? `\n${missionInvitation}` : ''}${nextReviewQueue ? `\n\n${nextReviewQueue.text}` : ''}`,
          buildOperatorSendOptions(
            msg,
            nextReviewQueue?.inlineActionRows
              ? { inlineActionRows: nextReviewQueue.inlineActionRows }
              : undefined,
          ),
        );
      }
      return true;
    }

    const issueSource = existing;
    const ensurePilotIssue = (): ResponseFeedbackRecord => {
      if (issueSource.issueId) {
        return updateResponseFeedback(issueSource.feedbackId, {
          linkedRefs,
        });
      }
      const captured = capturePilotIssue({
        channel: issueSource.channel,
        groupFolder: issueSource.groupFolder,
        chatJid: issueSource.chatJid,
        threadId: issueSource.threadId || null,
        utterance: 'not helpful',
        routeKey: issueSource.routeKey || 'response_feedback.capture',
        assistantContextSummary: issueSource.assistantReplyText,
        linkedRefs,
        issueKindOverride: 'downvoted_response',
        summaryTextOverride: buildResponseFeedbackIssueSummary(issueSource),
        blockerClassOverride: buildResponseFeedbackBlockerClass(
          issueSource.classification,
        ),
        blockerOwnerOverride: issueSource.blockerOwner,
      });
      return updateResponseFeedback(issueSource.feedbackId, {
        issueId: captured.record?.issueId || null,
        linkedRefs,
        status:
          issueSource.classification === 'externally_blocked'
            ? 'blocked_external'
            : issueSource.classification === 'manual_sync_only'
              ? 'manual_sync_only'
              : 'awaiting_confirmation',
      });
    };

    if (action.operation === 'capture') {
      const memoryJudgmentRecorded = recordLinkedMemoryJudgment();
      if (shouldCancelPendingContinuationForFeedback(existing)) {
        clearPendingGoogleCalendarCreateState(chatJid);
        clearGoogleCalendarSchedulingContext(chatJid);
      }
      const cognitiveReview = recordCognitiveOwnerReview({
        runId: linkedRefs.cognitiveRunId,
        feedbackId: existing.feedbackId,
        verdict: 'rejected',
        reviewedAt: feedbackNow.toISOString(),
      });
      if (cognitiveReview.signalId) {
        linkedRefs = {
          ...linkedRefs,
          cognitiveOwnerReviewSignalId: cognitiveReview.signalId,
        };
        existing = updateResponseFeedback(existing.feedbackId, { linkedRefs });
      }
      let captured = await emitResponseFeedbackCognition(ensurePilotIssue());
      if (
        captured.classification !== 'externally_blocked' &&
        captured.classification !== 'manual_sync_only' &&
        !captured.linkedRefs.platformRepairPlanId
      ) {
        const laneSelection =
          await selectCurrentResponseFeedbackRepairLane(captured);
        if (laneSelection.laneId) {
          captured = await emitResponseFeedbackRepairAutopilotPlan(
            captured,
            laneSelection,
          );
        } else {
          captured = updateResponseFeedback(captured.feedbackId, {
            status: 'captured',
            remediationRuntimePreference: laneSelection.runtimePreference,
            operatorNote: laneSelection.reason,
          });
        }
      }
      recordCouncilOutcomeSignal({
        councilRunId: captured.linkedRefs.providerCouncilRunId,
        signalKind: captured.linkedRefs.platformRepairPlanId
          ? 'repair_linked'
          : 'feedback_negative',
        groupFolder: captured.groupFolder,
        channel: captured.channel,
        routeKey: captured.routeKey,
        capabilityId: captured.capabilityId,
        blockerClass: captured.blockerClass,
        feedbackId: captured.feedbackId,
        repairPlanId: captured.linkedRefs.platformRepairPlanId,
        flags: [
          `feedback_status:${captured.status}`,
          `feedback_classification:${captured.classification}`,
        ],
        summary:
          'User captured negative response feedback for a council-linked answer.',
      });
      createRegressionFixtureFromFeedback(captured, feedbackNow);
      recordReviewedRecommendationOutcome({
        feedbackId: captured.feedbackId,
        groupFolder: captured.groupFolder,
        verdict: 'rejected',
        correction: true,
        metadata: {
          classification: captured.classification,
          routeKey: captured.routeKey || '',
          cognitiveRunId: linkedRefs.cognitiveRunId || '',
          reviewSource,
          ...(linkedRefs.verifiedDeepWorkPacketId
            ? { packetId: linkedRefs.verifiedDeepWorkPacketId }
            : {}),
        },
        now: feedbackNow,
      });
      reconcileAdaptiveFeedback({
        verdict: 'rejected',
        correction: true,
      });
      if (acknowledge) {
        const progressText = formatReviewedOutcomeProgress(
          buildReviewedOutcomeProgress({
            groupFolder: captured.groupFolder,
            now: feedbackNow,
          }),
        );
        await channel.sendMessage(
          chatJid,
          `${memoryJudgmentRecorded ? 'I recorded that the retrieved memory was incorrect.\n\n' : ''}${buildResponseFeedbackCaptureReply(
            captured,
            captured.operatorNote || 'I saved the issue for review.',
          )}\n\n${progressText}`,
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(captured),
          }),
        );
      }
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
        linkedRefs: {
          ...linkedRefs,
          repairFinalHealthState: 'kept_local',
          repairNextLegalAction:
            'No landing action is pending; the operator chose to keep this repair local.',
        },
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

    if (action.operation === 'approve_landing') {
      if (
        existing.status !== 'resolved_locally' &&
        existing.status !== 'landed'
      ) {
        await channel.sendMessage(
          chatJid,
          'Landing is not ready yet. Andrea needs a verified repair result before commit, push, or restart can be approved.',
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(existing),
          }),
        );
        return true;
      }
      const updated = updateResponseFeedback(existing.feedbackId, {
        linkedRefs: {
          ...linkedRefs,
          repairLandingScope: 'execution_and_landing',
          repairApprovalScope: buildResponseFeedbackApprovalScope(
            existing,
            'execution_and_landing',
          ),
          repairNextLegalAction:
            'Landing approved; commit/push only after dirty-path and test gates pass.',
        },
        operatorNote:
          'Landing scope is approved for this verified repair. Commit/push still checks dirty-path and test gates.',
      });
      await channel.sendMessage(
        chatJid,
        'Landing scope approved. Use Commit + push or Commit only when the expected hotfix files are present and tests remain green.',
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
      if (
        existing.status !== 'resolved_locally' &&
        existing.status !== 'landed'
      ) {
        await channel.sendMessage(
          chatJid,
          'That hotfix is not ready to land yet. Refresh the remediation task card after it completes locally, then use the landing buttons there.',
          buildOperatorSendOptions(msg, {
            inlineActionRows: buildResponseFeedbackActionRows(existing),
          }),
        );
        return true;
      }
      if (existing.linkedRefs.repairLandingScope !== 'execution_and_landing') {
        await channel.sendMessage(
          chatJid,
          'I need explicit landing approval before commit, push, or restart. Use Approve landing first, or say “repair and land” when approving the repair card.',
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
        if (updated.linkedRefs.platformRepairPlanId) {
          const deployment = await emitAndreaPlatformRepairDeployment({
            repairPlanId: updated.linkedRefs.platformRepairPlanId,
            executionId: updated.linkedRefs.platformRepairExecutionId,
            correlationId: updated.feedbackId,
            commitSha: landed.commitSha,
            services: ['nanobot'],
            status:
              action.operation === 'commit_push' ? 'deployed' : 'not_started',
            verificationEvidenceIds: updated.linkedRefs.verificationEvidenceIds,
            summary:
              action.operation === 'commit_push'
                ? `Repair commit ${landed.commitSha.slice(0, 7)} was pushed to ${landed.branch}.`
                : `Repair commit ${landed.commitSha.slice(0, 7)} was created locally on ${landed.branch}.`,
            metadata: compactPlatformStrings({
              feedbackId: updated.feedbackId,
              branch: landed.branch,
              pushed: String(Boolean(landed.pushedAt)),
            }),
          });
          const completed = await emitAndreaPlatformRepairComplete({
            repairPlanId: updated.linkedRefs.platformRepairPlanId,
            executionId: updated.linkedRefs.platformRepairExecutionId,
            deploymentId: deployment?.deploymentId,
            correlationId: updated.feedbackId,
            status: 'completed',
            finalHealthState:
              action.operation === 'commit_push'
                ? 'landed_push_recorded'
                : 'local_commit_recorded',
            summary:
              action.operation === 'commit_push'
                ? 'Repair landed and push evidence was recorded.'
                : 'Repair committed locally; push/restart not requested.',
            metadata: compactPlatformStrings({
              feedbackId: updated.feedbackId,
              landingCommitSha: landed.commitSha,
              pushedAt: landed.pushedAt || '',
            }),
          });
          updateResponseFeedback(updated.feedbackId, {
            linkedRefs: {
              ...updated.linkedRefs,
              deploymentAttemptId:
                deployment?.deploymentId ||
                updated.linkedRefs.deploymentAttemptId,
              platformRepairRunId:
                completed?.repairRunId ||
                updated.linkedRefs.platformRepairRunId,
              platformTraceGradeId:
                completed?.traceGradeId ||
                updated.linkedRefs.platformTraceGradeId,
              repairFinalHealthState:
                action.operation === 'commit_push'
                  ? 'landed_push_recorded'
                  : 'local_commit_recorded',
            },
          });
        }
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

    let laneSelection =
      buildResponseFeedbackLaneSelectionFromRecord(captured) ||
      (await selectCurrentResponseFeedbackRepairLane(captured));

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

    if (!captured.linkedRefs.platformRepairPlanId) {
      const repairPlanned = await emitResponseFeedbackRepairAutopilotPlan(
        captured,
        laneSelection,
      );
      await channel.sendMessage(
        chatJid,
        buildResponseFeedbackCaptureReply(
          repairPlanned,
          repairPlanned.operatorNote ||
            'I staged a bounded self-repair plan. Review the scope before approving execution.',
        ),
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(repairPlanned),
        }),
      );
      return true;
    }

    if (
      laneSelection.runtimePreference === 'codex_local' &&
      action.operation !== 'approve_local'
    ) {
      const updated = updateResponseFeedback(captured.feedbackId, {
        operatorNote:
          'Cloud repair is not ready. Local Codex is available, but this fallback requires the explicit `Approve local fallback` action.',
      });
      await channel.sendMessage(
        chatJid,
        [
          'I staged the repair, but I am not starting local Codex silently.',
          'Cloud repair is not ready, so local fallback needs a separate explicit approval.',
        ].join('\n'),
        buildOperatorSendOptions(msg, {
          inlineActionRows: buildResponseFeedbackActionRows(updated),
        }),
      );
      return true;
    }

    const repairRecord = captured;
    laneSelection =
      buildResponseFeedbackLaneSelectionFromRecord(repairRecord) ||
      laneSelection;
    const approvalScopeKind = parseRepairApprovalScopeFromText(msg.content);
    const approvalScope = buildResponseFeedbackApprovalScope(
      repairRecord,
      approvalScopeKind,
    );

    const remediationPrompt = buildResponseFeedbackRemediationPrompt({
      record: repairRecord,
      laneSelection,
      hostTruthLines: buildResponseFeedbackHostTruthLines(),
    });
    const linkedRefsWithRepoBaseline: ResponseFeedbackRecord['linkedRefs'] = {
      ...linkedRefs,
      repoHeadAtStart: readGitRef(['rev-parse', 'HEAD']),
      repoDirtyPathsAtStart: listCurrentGitDirtyPaths(),
    };
    const approval = repairRecord.linkedRefs.platformRepairPlanId
      ? await emitAndreaPlatformRepairApproval({
          repairPlanId: repairRecord.linkedRefs.platformRepairPlanId,
          approvedBy: msg.sender,
          metadata: compactPlatformStrings({
            feedbackId: repairRecord.feedbackId,
            approvalScope,
            repairLandingScope: approvalScopeKind,
            selectedWorker: laneSelection.runtimePreference || '',
            fallbackPolicy:
              repairRecord.linkedRefs.repairFallbackPolicy ||
              buildResponseFeedbackFallbackPolicy(laneSelection),
            explicitLocalFallback:
              action.operation === 'approve_local' ? 'true' : 'false',
            approvalUtteranceMessageId: msg.id,
            approvalBoundFeedbackId: repairRecord.feedbackId,
            repairBindingState:
              action.operation === 'approve_local'
                ? 'explicit_local_fallback_approval'
                : 'natural_approval_bound',
          }),
        })
      : null;
    const linkedRefsWithApproval: ResponseFeedbackRecord['linkedRefs'] = {
      ...linkedRefsWithRepoBaseline,
      repairApprovalId: approval?.approvalId || undefined,
      approvalUtteranceMessageId: msg.id,
      approvalBoundFeedbackId: repairRecord.feedbackId,
      repairBindingState:
        action.operation === 'approve_local'
          ? 'explicit_local_fallback_approval'
          : 'natural_approval_bound',
      repairApprovalScope: approvalScope,
      repairLandingScope: approvalScopeKind,
      repairExecutionState:
        laneSelection.runtimePreference === 'codex_local'
          ? 'local_fallback_explicitly_approved'
          : 'cloud_preferred_execution_requested',
      platformRepairRunId:
        approval?.repairRunId ||
        repairRecord.linkedRefs.platformRepairRunId ||
        undefined,
    };

    if (laneSelection.laneId === 'andrea_runtime') {
      const created = await getAndreaRuntimeLane().createJob({
        groupFolder: repairRecord.groupFolder,
        chatJid,
        promptText: remediationPrompt,
        requestedBy: msg.sender,
        requestedRuntime: mapResponseFeedbackRuntimePreferenceToAgentRuntime(
          laneSelection.runtimePreference,
        ),
      });
      const updated = updateResponseFeedback(repairRecord.feedbackId, {
        linkedRefs: {
          ...(repairRecord.linkedRefs || {}),
          ...linkedRefsWithApproval,
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
      const execution = updated.linkedRefs.platformRepairPlanId
        ? await emitAndreaPlatformRepairExecution({
            repairPlanId: updated.linkedRefs.platformRepairPlanId,
            approvalId: updated.linkedRefs.repairApprovalId,
            groupFolder: updated.groupFolder,
            channel: updated.channel,
            actorId: msg.sender,
            externalJobId: created.handle.jobId,
            externalLaneId: 'andrea_runtime',
            workerId: laneSelection.runtimePreference || 'codex_cloud',
            jobStatus: created.status,
            metadata: compactPlatformStrings({
              feedbackId: updated.feedbackId,
              backendJobId: created.handle.jobId,
              selectedWorker: laneSelection.runtimePreference || '',
            }),
          })
        : null;
      if (execution) {
        updateResponseFeedback(updated.feedbackId, {
          linkedRefs: {
            ...updated.linkedRefs,
            platformRepairRunId:
              execution.repairRunId || updated.linkedRefs.platformRepairRunId,
            platformRepairExecutionId:
              execution.executionId ||
              updated.linkedRefs.platformRepairExecutionId,
            platformTraceGradeId:
              execution.traceGradeId || updated.linkedRefs.platformTraceGradeId,
            verificationEvidenceIds: execution.verificationEvidenceId
              ? [execution.verificationEvidenceId]
              : updated.linkedRefs.verificationEvidenceIds,
          },
        });
      }
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
          `Andrea started a self-fix task for that downvoted reply using ${laneSelection.label}.`,
          laneSelection.runtimePreference === 'codex_local'
            ? 'Cloud repair was not ready, so this is the explicit local fallback path for the approved feedback card.'
            : 'This used the cloud-preferred repair lane selected by the current health checks.',
          formatRuntimeJobCard(created),
          formatRuntimeNextStep(created.handle.jobId),
          'If the hotfix validates locally, I will still ask before any commit or push.',
        ].join('\n\n'),
      });
      return true;
    }

    const created = await cursorBackendLane.createCursorJob({
      groupFolder: repairRecord.groupFolder,
      chatJid,
      promptText: remediationPrompt,
      requestedBy: msg.sender,
    });
    const updated = updateResponseFeedback(repairRecord.feedbackId, {
      linkedRefs: {
        ...(repairRecord.linkedRefs || {}),
        ...linkedRefsWithApproval,
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
    const execution = updated.linkedRefs.platformRepairPlanId
      ? await emitAndreaPlatformRepairExecution({
          repairPlanId: updated.linkedRefs.platformRepairPlanId,
          approvalId: updated.linkedRefs.repairApprovalId,
          groupFolder: updated.groupFolder,
          channel: updated.channel,
          actorId: msg.sender,
          externalJobId: created.id,
          externalLaneId: 'cursor',
          workerId: laneSelection.runtimePreference || 'cursor_cloud',
          jobStatus: created.status,
          metadata: compactPlatformStrings({
            feedbackId: updated.feedbackId,
            backendJobId: created.id,
            selectedWorker: laneSelection.runtimePreference || '',
          }),
        })
      : null;
    if (execution) {
      updateResponseFeedback(updated.feedbackId, {
        linkedRefs: {
          ...updated.linkedRefs,
          platformRepairRunId:
            execution.repairRunId || updated.linkedRefs.platformRepairRunId,
          platformRepairExecutionId:
            execution.executionId ||
            updated.linkedRefs.platformRepairExecutionId,
          platformTraceGradeId:
            execution.traceGradeId || updated.linkedRefs.platformTraceGradeId,
          verificationEvidenceIds: execution.verificationEvidenceId
            ? [execution.verificationEvidenceId]
            : updated.linkedRefs.verificationEvidenceIds,
        },
      });
    }
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
        `Andrea started a self-fix task for that downvoted reply using ${laneSelection.label}.`,
        'This used the cloud-preferred repair lane selected by the current health checks.',
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

  async function handleOpenClawDelegation(
    chatJid: string,
    promptText: string,
    message?: NewMessage,
    command: OpenClawDelegationCommand = 'slash',
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    const prompt = promptText.trim();
    const sessionKey = buildOpenClawChatSessionKey(chatJid);
    const startedAt = Date.now();

    logger.info(
      { chatJid, command, sessionKey, promptChars: prompt.length },
      'OpenClaw delegation started',
    );

    try {
      await channel?.setTyping?.(chatJid, true);

      if (!prompt) {
        await sendCursorMessage(chatJid, 'Usage: /openclaw <message>', message);
        return;
      }

      if (command === 'mention' || command === 'natural') {
        try {
          await sendCursorMessage(chatJid, 'Asking OpenClaw…', message);
        } catch (ackErr) {
          logger.warn(
            { err: ackErr, chatJid },
            'OpenClaw delegation ack failed',
          );
        }
      }

      const prepared = await prepareOpenClawDelegationResponse({
        chatJid,
        prompt,
        message,
        command,
      });
      const responseText = prepared.responseText;

      try {
        await sendCursorMessage(chatJid, responseText, message);
      } catch (sendErr) {
        logger.error(
          { err: sendErr, chatJid },
          'OpenClaw delegation reply failed',
        );
        try {
          await channel?.sendMessage(
            chatJid,
            'OpenClaw replied, but Andrea could not deliver the message. Try again.',
            buildOperatorSendOptions(message),
          );
        } catch (fallbackErr) {
          logger.error(
            { err: fallbackErr, chatJid },
            'OpenClaw delegation fallback reply failed',
          );
        }
      }

      logger.info(
        {
          chatJid,
          command,
          sessionKey,
          ok: prepared.ok,
          durationMs: Date.now() - startedAt,
        },
        'OpenClaw delegation completed',
      );
    } finally {
      await channel?.setTyping?.(chatJid, false).catch(() => undefined);
    }
  }

  async function handleIntegrationRecovery(
    chatJid: string,
    rawTrimmed: string,
    message?: NewMessage,
  ): Promise<void> {
    try {
      const result = await runIntegrationRecoveryCommand(rawTrimmed);
      await sendCursorMessage(chatJid, result.text, message);
    } catch (err) {
      await sendCursorMessage(
        chatJid,
        formatUserFacingOperationFailure('Integration recovery failed', err),
        message,
      );
    }
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
    recoveryReply: string | null;
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
      recoveryReply: getRuntimeWorkRecoveryReply(context.payload),
    };
  }

  function summarizeCursorDashboardLines(params: {
    cloudStatus: ReturnType<typeof getCursorCloudStatus>;
    desktopStatus: Awaited<ReturnType<typeof getCursorDesktopStatus>>;
    gatewayStatus: Awaited<ReturnType<typeof getCursorGatewayStatus>>;
    runtimeBackendStatus: Awaited<
      ReturnType<typeof getAndreaOpenAiBackendStatus>
    >;
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
    const selected = selectedAgentId
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
    isCurrentRead?: () => boolean,
  ): Promise<Awaited<
    ReturnType<typeof getRuntimeWorkCockpitSelection>
  > | null> {
    const group = registeredGroups[chatJid];
    if (!group) return null;
    const runtimeLane = getAndreaRuntimeLane();
    return getRuntimeWorkCockpitSelection({
      chatJid,
      groupFolder: group.folder,
      threadId,
      isCurrentRead,
      getJob: (params) => runtimeLane.getJob(params),
    });
  }

  const workCockpitPresentationQueue = createWorkCockpitPresentationQueue();

  async function upsertCursorDashboardMessage(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    text: string;
    inlineActionRows: SendMessageOptions['inlineActionRows'];
    selectedAgentId?: string | null;
    selectedLaneId?: 'cursor' | 'andrea_runtime';
    readOnlyRecovery?: boolean;
    preserveSelection?: boolean;
    isCurrentRead?: () => boolean;
    forceNew?: boolean;
  }): Promise<string | undefined> {
    return workCockpitPresentationQueue.run(
      JSON.stringify([params.chatJid, params.sourceMessage?.thread_id || null]),
      async () => {
        if (params.isCurrentRead && !params.isCurrentRead()) return undefined;
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
          if (params.readOnlyRecovery) {
            // Pause old controls before an edit whose transport result may be
            // uncertain. Only a later confirmed healthy card can re-arm them.
            rememberCursorMessageContext({
              chatJid: params.chatJid,
              platformMessageId: existingDashboardMessageId,
              threadId: params.sourceMessage?.thread_id,
              contextKind: 'cursor_dashboard',
              laneId: params.selectedLaneId || 'andrea_runtime',
              agentId: params.selectedAgentId || null,
              payload: {
                ...formatCursorDashboardState(params.state),
                readOnlyRecovery: true,
              },
            });
          }
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
          const sent = acceptConfirmedPresentationDelivery({
            result: await channel.sendMessage(
              params.chatJid,
              params.text,
              buildOperatorSendOptions(params.sourceMessage, {
                inlineActionRows: params.inlineActionRows,
              }),
            ),
            channel: channel.name,
            chatJid: params.chatJid,
            workflow: 'cursor_dashboard_presentation',
          });
          if (!sent) return undefined;
          platformMessageId = sent.platformMessageId;
        }

        if (!platformMessageId) return undefined;
        rememberCursorDashboardMessage({
          chatJid: params.chatJid,
          threadId: params.sourceMessage?.thread_id,
          dashboardMessageId: platformMessageId,
          ...(params.preserveSelection
            ? {}
            : {
                selectedAgentId: params.selectedAgentId,
                selectedLaneId: params.selectedLaneId,
              }),
        });
        rememberCursorMessageContext({
          chatJid: params.chatJid,
          platformMessageId,
          threadId: params.sourceMessage?.thread_id,
          contextKind: 'cursor_dashboard',
          laneId: params.selectedLaneId || 'cursor',
          agentId: params.selectedAgentId || null,
          payload: {
            ...formatCursorDashboardState(params.state),
            ...(params.readOnlyRecovery ? { readOnlyRecovery: true } : {}),
          },
        });
        return platformMessageId;
      },
    );
  }

  const { begin: beginWorkCockpitRead } = createWorkCockpitReadGuard();

  async function openCursorDashboard(params: {
    chatJid: string;
    sourceMessage?: NewMessage;
    state: CursorDashboardState;
    forceNew?: boolean;
  }): Promise<string | undefined> {
    const isCurrentRead = beginWorkCockpitRead(
      JSON.stringify([params.chatJid, params.sourceMessage?.thread_id || null]),
    );
    const presentRead = (
      presentation: Parameters<typeof upsertCursorDashboardMessage>[0],
    ) =>
      upsertCursorDashboardMessage({
        preserveSelection: true,
        ...presentation,
        isCurrentRead,
      });
    const group = registeredGroups[params.chatJid];
    if (!group) {
      return sendCursorMessage(
        params.chatJid,
        buildMainChatBlockedMessage('advanced operator workflows'),
        params.sourceMessage,
      );
    }

    if (params.state.kind === 'home') {
      const [desktopStatus, gatewayStatus, runtimeBackendStatus] =
        await Promise.all([
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
          isCurrentRead,
        ),
      ]);
      if (runtimeSelection?.superseded) return undefined;
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
        currentRuntimeRecovery:
          runtimeSelection?.recovery.kind === 'unavailable'
            ? runtimeSelection.recovery
            : undefined,
        currentFocusLaneId: effectiveCurrentWorkSelection?.laneId || null,
      });
      return presentRead({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId: effectiveCurrentWorkSelection?.jobId || null,
        selectedLaneId: effectiveCurrentWorkSelection?.laneId,
        preserveSelection: true,
        readOnlyRecovery:
          effectiveCurrentWorkSelection?.laneId === 'andrea_runtime' &&
          runtimeSelection?.recovery.kind === 'unavailable',
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
      return presentRead({
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
      const platformMessageId = await presentRead({
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
      if (!platformMessageId || !isCurrentRead()) return undefined;
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
      return presentRead({
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
      const [selection, runtimeSelection, runtimeBackendStatus] =
        await Promise.all([
          getCursorSelectedAgentRecord(
            params.chatJid,
            params.sourceMessage?.thread_id,
          ),
          getRuntimeSelectedJobRecord(
            params.chatJid,
            params.sourceMessage?.thread_id,
            isCurrentRead,
          ),
          getAndreaOpenAiBackendStatus(),
        ]);
      if (runtimeSelection?.superseded) return undefined;
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
        currentRuntimeRecovery:
          runtimeSelection?.recovery.kind === 'unavailable'
            ? runtimeSelection.recovery
            : undefined,
        executionEnabled: runtimeBackendStatus.state === 'available',
        currentJobResultCount:
          selection?.selected?.provider === 'cloud'
            ? cursorBackendLane.getTrackedArtifactCount(selection.selected.id)
            : 0,
      });
      return presentRead({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          effectiveCurrentWorkSelection?.jobId || render.selectedAgentId,
        selectedLaneId: effectiveCurrentWorkSelection?.laneId,
        preserveSelection: true,
        readOnlyRecovery:
          effectiveCurrentWorkSelection?.laneId === 'andrea_runtime' &&
          runtimeSelection?.recovery.kind === 'unavailable',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime') {
      const [runtimeSelection, runtimeBackendStatus] = await Promise.all([
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
          isCurrentRead,
        ),
        getAndreaOpenAiBackendStatus(),
      ]);
      if (runtimeSelection?.superseded) return undefined;
      const render = buildCursorDashboardRuntime({
        executionEnabled: runtimeBackendStatus.state === 'available',
        readinessLine:
          runtimeBackendStatus.state === 'available'
            ? 'authenticated and ready on this host'
            : runtimeBackendStatus.state === 'auth_required'
              ? runtimeBackendStatus.detail ||
                'codex_local needs login on the backend host'
              : runtimeBackendStatus.state === 'not_enabled'
                ? 'loopback backend is disabled in this NanoBot runtime'
                : runtimeBackendStatus.detail ||
                  'historical review is available, but live runtime execution is currently unavailable',
        currentTask: runtimeSelection?.selected || undefined,
        currentTaskRecovery:
          runtimeSelection?.recovery.kind === 'unavailable'
            ? runtimeSelection.recovery
            : undefined,
      });
      return presentRead({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          runtimeSelection?.recovery.kind === 'missing'
            ? null
            : runtimeSelection?.recovery.selectedJobId || null,
        selectedLaneId: 'andrea_runtime',
        preserveSelection: true,
        readOnlyRecovery: runtimeSelection?.recovery.kind === 'unavailable',
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'runtime_jobs') {
      const runtimeSelection = await getRuntimeSelectedJobRecord(
        params.chatJid,
        params.sourceMessage?.thread_id,
        isCurrentRead,
      );
      if (runtimeSelection?.superseded) return undefined;
      let jobs: BackendJobSummary[];
      try {
        jobs = await getAndreaRuntimeLane().listJobs({
          groupFolder: group.folder,
          chatJid: params.chatJid,
          limit: 50,
        });
      } catch {
        // An unavailable inventory is not proof that there are no tasks.
        const render = buildCursorDashboardRuntimeJobsUnavailable();
        return presentRead({
          ...params,
          text: render.text,
          inlineActionRows: render.inlineActionRows,
          selectedAgentId:
            runtimeSelection?.recovery.kind === 'missing'
              ? null
              : runtimeSelection?.recovery.selectedJobId || null,
          selectedLaneId: 'andrea_runtime',
          readOnlyRecovery: true,
          preserveSelection: true,
        });
      }
      const render = buildCursorDashboardRuntimeJobs({
        jobs,
        page: params.state.page || 0,
        pageSize: CURSOR_DASHBOARD_PAGE_SIZE,
        selectedJobId:
          runtimeSelection?.recovery.kind === 'missing'
            ? null
            : runtimeSelection?.recovery.selectedJobId || null,
      });
      const platformMessageId = await presentRead({
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
        preserveSelection: true,
        forceNew: params.forceNew,
      });
      if (!platformMessageId || !isCurrentRead()) return undefined;
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
        preserveSelection: true,
      });
      return platformMessageId;
    }

    if (params.state.kind === 'runtime_current') {
      const [runtimeSelection, runtimeBackendStatus] = await Promise.all([
        getRuntimeSelectedJobRecord(
          params.chatJid,
          params.sourceMessage?.thread_id,
          isCurrentRead,
        ),
        getAndreaOpenAiBackendStatus(),
      ]);
      if (runtimeSelection?.superseded) return undefined;
      const render =
        runtimeSelection?.recovery.kind === 'unavailable'
          ? buildCursorDashboardRuntimeCurrentUnavailable(
              runtimeSelection.recovery,
            )
          : runtimeSelection?.selected
            ? buildCursorDashboardRuntimeCurrent(
                runtimeSelection.selected,
                runtimeBackendStatus.state === 'available',
              )
            : buildCursorDashboardRuntimeCurrentEmpty();
      return presentRead({
        chatJid: params.chatJid,
        sourceMessage: params.sourceMessage,
        state: params.state,
        text: render.text,
        inlineActionRows: render.inlineActionRows,
        selectedAgentId:
          runtimeSelection?.recovery.kind === 'missing'
            ? null
            : runtimeSelection?.recovery.selectedJobId ||
              render.selectedAgentId,
        selectedLaneId: 'andrea_runtime',
        readOnlyRecovery: runtimeSelection?.recovery.kind === 'unavailable',
        preserveSelection: true,
        forceNew: params.forceNew,
      });
    }

    if (params.state.kind === 'desktop') {
      const desktopStatus = await getCursorDesktopStatus({ probe: true });
      const render = buildCursorDashboardDesktop(
        formatCursorDesktopStatusMessage(desktopStatus),
      );
      return presentRead({
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
      return presentRead({
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
      return presentRead({
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
      return presentRead({
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
    return presentRead({
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

  function _resolveRuntimeGroupTarget(
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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

  function _getCurrentRuntimeSelection(
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
  }): Promise<'confirmed' | 'notification_blocked'> {
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

    const nowIso = new Date().toISOString();
    // The backend mutation has already happened. Persist its selection before
    // attempting the notification so an uncertain send can never make the
    // user repeat create/follow-up/stop against stale local context.
    if (job && updateSelection) {
      updateCurrentRuntimeSelection(chatJid, group.folder, job.jobId, nowIso);
    }

    const delivery = await deliverRuntimeCardNotification({
      send: () =>
        channel.sendMessage(chatJid, text, {
          ...(threadId ? { threadId } : {}),
        }),
    });
    if (delivery.status !== 'confirmed') {
      logger.error(
        {
          component: 'runtime_backend_notification',
          chatJid,
          groupFolder: group.folder,
          jobId: job?.jobId || null,
          deliveryOutcome: delivery.deliveryOutcome,
          confirmedReceiptCount: delivery.platformMessageIds.length,
          nextUnconfirmedChunkIndex: delivery.nextUnconfirmedChunkIndex,
          errorClass: delivery.errorClass || null,
        },
        'Runtime operation state was preserved, but its chat notification is blocked or unverified; do not repeat the backend operation',
      );
      return 'notification_blocked';
    }

    if (!job) return 'confirmed';

    if (!armReplyContext || delivery.platformMessageIds.length === 0) {
      return 'confirmed';
    }

    const expiresAt = computeRuntimeCardContextExpiry(nowIso);
    for (const messageId of delivery.platformMessageIds) {
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
    return 'confirmed';
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

  async function _runOperatorRuntimeFollowup(
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

  async function _handleRuntimeStatus(chatJid: string): Promise<void> {
    const context = await resolveRuntimeBackendContext(chatJid);
    if (!context) return;

    const status = await getAndreaOpenAiBackendStatus();
    await context.channel.sendMessage(
      chatJid,
      formatRuntimeBackendStatusSummary(
        status,
        context.group,
        getAndreaRuntimeStatusBaseUrl(),
      ),
    );
  }

  async function handleUnifiedJob(
    chatJid: string,
    rawMessage: string,
    msg: NewMessage,
  ): Promise<void> {
    const channel = findChannel(channels, chatJid);
    if (!channel) return;
    const parsed = parseUnifiedJobCommand(rawMessage);
    if (parsed.error) {
      await channel.sendMessage(chatJid, parsed.error);
      return;
    }
    const group = registeredGroups[chatJid];
    if (!group) {
      await channel.sendMessage(
        chatJid,
        buildMainChatBlockedMessage('job dispatch'),
      );
      return;
    }
    const adapters = buildJobDispatchAdapters({
      resolveGroup: (jid: string) => registeredGroups[jid] ?? null,
    });
    try {
      const dispatchResult = await dispatchUnifiedJob({
        channel: {
          sendMessage: channel.sendMessage.bind(channel),
          editMessage: channel.editMessage
            ? channel.editMessage.bind(channel)
            : undefined,
        },
        input: {
          chatJid,
          prompt: parsed.prompt,
          laneOverride: parsed.laneOverride,
          actorId: msg.sender || chatJid,
        },
        adapters,
      });
      if (dispatchResult.outcome === 'notification_blocked') {
        logger.error(
          {
            component: 'unified_job_notification',
            chatJid,
            lane: dispatchResult.lane,
            jobId: dispatchResult.jobId,
          },
          'Unified job was created or remained active, but its status notification is blocked; the job must not be recreated',
        );
      }
    } catch (err) {
      logger.error({ err, chatJid }, 'Unified /job dispatch failed');
      await channel.sendMessage(
        chatJid,
        `/job dispatch error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async function _handleRuntimeCreate(
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

  async function _handleRuntimeJobs(
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

  async function _handleRuntimeJob(
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

  async function _handleRuntimeFollowup(
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

  async function _handleRuntimeStop(
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

  async function _handleRuntimeLogs(
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
      const errorDetail = getUserFacingErrorDetail(err);
      const externalDependencyFailure =
        isUserFacingExternalDependencyDetail(errorDetail);
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: externalDependencyFailure
            ? 'externally_blocked'
            : 'internal_failure',
          blockerClass: externalDependencyFailure
            ? 'work_cockpit_external_dependency_blocked'
            : 'work_cockpit_dashboard_failed',
          blockerOwner: externalDependencyFailure ? 'external' : 'repo_side',
          summaryText:
            err instanceof Error
              ? err.message
              : 'work cockpit dashboard failed',
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
        forceNew: true,
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
      const errorDetail = getUserFacingErrorDetail(err);
      const externalDependencyFailure =
        isUserFacingExternalDependencyDetail(errorDetail);
      if (pilotRecord) {
        completePilotJourney({
          eventId: pilotRecord.eventId,
          outcome: externalDependencyFailure
            ? 'externally_blocked'
            : 'internal_failure',
          blockerClass: externalDependencyFailure
            ? 'work_cockpit_external_dependency_blocked'
            : 'current_work_quick_open_failed',
          blockerOwner: externalDependencyFailure ? 'external' : 'repo_side',
          summaryText:
            err instanceof Error
              ? err.message
              : 'current work quick-open failed',
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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

    if (
      dashboardContext?.recoveryReply &&
      ![
        'home',
        'work-current',
        'runtime',
        'runtime-current',
        'runtime-jobs',
        'jobs',
        'status',
      ].includes(action)
    ) {
      await sendCursorMessage(
        chatJid,
        dashboardContext.recoveryReply,
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
      if (runtimeSelection?.superseded) return;
      const runtimeRecovery = dashboardRuntimeJobId
        ? await resolveRuntimeWorkRecovery({
            selectedJobId: dashboardRuntimeJobId,
            groupFolder: registeredGroups[chatJid].folder,
            chatJid,
            getJob: (params) => runtimeLane.getJob(params),
            getCachedJob: (jobId) =>
              getRuntimeBackendJob(ANDREA_OPENAI_BACKEND_ID, jobId),
          })
        : runtimeSelection?.recovery;
      if (runtimeRecovery?.kind === 'unavailable') {
        const render =
          buildCursorDashboardRuntimeCurrentUnavailable(runtimeRecovery);
        await upsertCursorDashboardMessage({
          chatJid,
          sourceMessage,
          state: { kind: 'runtime_current' },
          text: render.text,
          inlineActionRows: render.inlineActionRows,
          readOnlyRecovery: true,
          preserveSelection: true,
          selectedLaneId: 'andrea_runtime',
          // A failed action read must not switch the current task to an old card.
        });
        return;
      }
      const selectedRuntimeJob =
        runtimeRecovery?.kind === 'available' ? runtimeRecovery.job : null;
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
        buildMainChatBlockedMessage('advanced operator workflows'),
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
            const sent = acceptConfirmedPresentationDelivery({
              result: await channel.sendMessage(
                targetChatJid,
                text,
                buildOperatorSendOptions(sourceMessage, extra),
              ),
              channel: channel.name,
              chatJid: targetChatJid,
              workflow: 'andrea_runtime_operator_message',
            });
            return sent?.platformMessageId;
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
                (!requestedTarget ||
                  requestedTarget.trim().toLowerCase() === 'current')
              ) {
                rememberCursorOperatorSelection({
                  chatJid: targetChatJid,
                  threadId,
                  laneId: 'andrea_runtime',
                  agentId: legacySelection,
                });
                return {
                  target: {
                    handle: {
                      laneId: 'andrea_runtime',
                      jobId: legacySelection,
                    },
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
  if (blueBubblesConfig.receiptInboxEnabled) {
    try {
      blueBubblesReceiptInboxStore = new BlueBubblesReceiptInboxStore(
        blueBubblesConfig.receiptInboxDatabasePath,
      );
      blueBubblesReceiptInboxConsumer = new BlueBubblesReceiptInboxConsumer({
        store: blueBubblesReceiptInboxStore,
        consumerId: `andrea-main:${process.pid}:${randomUUID()}`,
        acceptReceipt: (message) => {
          const groupFolders = [
            ...new Set(
              Object.values(registeredGroups)
                .map((entry) => entry.folder)
                .filter(Boolean),
            ),
          ];
          const recovery = recordBlueBubblesOutboundDeliveryEvidence({
            chatJid: message.chat_jid,
            message,
            groupFolders,
          });
          if (recovery.reconciled > 0) {
            logger.info(
              {
                component: 'bluebubbles_receipt_inbox',
                providerMessageId: message.id,
                ...recovery,
              },
              'Reconciled delayed BlueBubbles success from the durable receipt inbox',
            );
          }
          writeCurrentRuntimeAuditState();
          return { accepted: recovery.accepted };
        },
        onDrainError: (error) => {
          logger.warn(
            { component: 'bluebubbles_receipt_inbox', err: error },
            'BlueBubbles receipt inbox drain failed; the durable row remains pending',
          );
        },
      });
      const startupDrain = await blueBubblesReceiptInboxConsumer.drainOnce();
      blueBubblesReceiptInboxConsumer.start();
      logger.info(
        {
          component: 'bluebubbles_receipt_inbox',
          databasePath: blueBubblesConfig.receiptInboxDatabasePath,
          ...startupDrain,
        },
        'Started the durable BlueBubbles receipt inbox consumer',
      );
    } catch (error) {
      blueBubblesReceiptInboxConsumer?.stop();
      blueBubblesReceiptInboxConsumer = null;
      try {
        blueBubblesReceiptInboxStore?.close();
      } catch (_closeError) {
        // Preserve the startup failure as the actionable error.
      }
      blueBubblesReceiptInboxStore = null;
      logger.error(
        { component: 'bluebubbles_receipt_inbox', err: error },
        'Durable BlueBubbles receipt consumer could not start; BlueBubbles sends will remain fail-closed',
      );
    }
  }
  const channelOpts = {
    isBlueBubblesReceiptConsumerReady: () =>
      blueBubblesReceiptInboxConsumer?.isRunning() === true,
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
          group.isMain === true &&
          findChannel(channels, jid)?.name === 'telegram',
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
      const callbackOwnerAuthorizationAt =
        resolveInboundMessagingOwnerAuthorizationAt(msg);
      const rawTrimmed = msg.content.trim();
      const trimmed = rawTrimmed.toLowerCase();
      const isSlashCommand = rawTrimmed.startsWith('/');
      const rawCommandToken = trimmed.split(/\s+/)[0] || '';
      const commandToken = normalizeCommandToken(rawCommandToken);
      const mainControlChat =
        isMainControlChat(registeredGroups[chatJid]) ||
        getRegisteredMainChat()?.jid === chatJid;
      const inboundChannel = findChannel(channels, chatJid);
      const inboundGroup = resolveCompanionBinding(chatJid)?.group;
      const trustedInboundOwnerSurface = isTrustedOwnerReviewSurface({
        channelName: inboundChannel?.name,
        chatJid,
        group: inboundGroup,
        ownerAuthored: msg.is_from_me === true,
      });

      // Ordinary Messages conversations are synced communication data, not
      // assistant command surfaces. Persist them for reviews, summaries, and
      // explicitly owner-authorized sends, but stop before sender-command
      // filtering, command parsing, or queueing. The configured owner
      // self-thread remains the sole native BlueBubbles control surface.
      if (
        isBlueBubblesDataOnlyContactThread({
          channelName: inboundChannel?.name,
          chatJid,
        })
      ) {
        const ingressPolicy = applyBlueBubblesIngressPolicy({
          channelName: inboundChannel?.name,
          chatJid,
          message: msg,
        });
        const existingChatCursor = lastAgentTimestamp[chatJid] || '';
        if (msg.timestamp > existingChatCursor) {
          lastAgentTimestamp[chatJid] = msg.timestamp;
        }
        saveState();
        logger.debug(
          {
            chatJid,
            messageId: msg.id,
            ownerAuthored: msg.is_from_me === true,
            reaction: Boolean(msg.reaction),
            stored:
              ingressPolicy.kind === 'stored_contact_data_only'
                ? ingressPolicy.stored
                : false,
          },
          'Stored ordinary BlueBubbles contact-thread activity as data only',
        );
        return;
      }

      const outboundPauseCommand =
        parseMessagingOutboundPauseCommand(rawTrimmed);
      if (outboundPauseCommand && trustedInboundOwnerSurface) {
        const paused = outboundPauseCommand === 'pause';
        const pauseResult = applyMessagingOutboundPauseCommand({
          paused,
          changedByChatJid: chatJid,
          reason: paused
            ? 'owner_natural_language_pause'
            : 'owner_explicit_resume',
          authorizationAt: callbackOwnerAuthorizationAt,
        });
        if (!pauseResult.applied) {
          logger.warn(
            { chatJid, paused, reason: pauseResult.reason },
            'Ignored stale or invalid owner outbound resume command',
          );
          return;
        }
        logger.warn(
          { chatJid, paused },
          paused
            ? 'Owner paused all BlueBubbles outbound messaging'
            : 'Owner explicitly resumed BlueBubbles outbound messaging',
        );
        if (inboundChannel?.name === 'telegram' || !paused) {
          await inboundChannel?.sendMessage(
            chatJid,
            paused
              ? 'Outbound Messages sending is paused. Incoming sync and text summaries remain available. Only an explicit resume command will turn sending back on.'
              : 'The runtime outbound pause is cleared. BlueBubbles still must pass its configured send and receipt-readiness checks before anything can be sent.',
          );
        }
        return;
      }

      // A verified owner stop instruction is a safety interrupt. Handle it
      // before configurable sender filtering so a stale allowlist cannot
      // prevent the owner from fencing outbound Messages delivery.
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

      // Native BlueBubbles reactions are structured owner-review signals, not
      // conversational turns. Consume them before command parsing or message
      // storage so a tapback can never become an accidental assistant prompt.
      if (msg.reaction) {
        const reactionAction = mapMessageReactionToFeedbackAction(msg.reaction);
        const feedback = reactionAction
          ? expandBlueBubblesLogicalSelfThreadJids(chatJid)
              .map((candidateChatJid) =>
                getResponseFeedbackByMessage({
                  chatJid: candidateChatJid,
                  platformMessageId: msg.reaction?.targetMessageId || '',
                }),
              )
              .find(Boolean)
          : undefined;
        if (
          reactionAction &&
          feedback &&
          feedback.channel === 'bluebubbles' &&
          isBlueBubblesSelfThreadAliasJid(feedback.chatJid) &&
          isBlueBubblesSelfThreadAliasJid(chatJid)
        ) {
          handleResponseFeedbackAction(
            chatJid,
            msg,
            {
              feedbackId: feedback.feedbackId,
              operation: reactionAction,
            },
            { acknowledge: false, reviewSource: 'native_reaction' },
          ).catch((err) =>
            logger.error(
              { err, chatJid, reactionKind: msg.reaction?.kind },
              'BlueBubbles native reaction feedback error',
            ),
          );
        } else {
          logger.debug(
            {
              chatJid,
              reactionKind: msg.reaction.kind,
              removed: msg.reaction.removed,
              feedbackLinked: false,
            },
            'Ignored BlueBubbles reaction without an unambiguous feedback link',
          );
        }
        return;
      }

      const agiConfirmMatch = rawTrimmed.match(
        /^\/agi-(confirm|decline)\s+(\S+)/i,
      );
      if (agiConfirmMatch) {
        if (!trustedInboundOwnerSurface) return;
        const channel = findChannel(channels, chatJid);
        if (channel) {
          handleAgiConfirmationCommand({
            chatJid,
            msg,
            approve: agiConfirmMatch[1].toLowerCase() === 'confirm',
            pendingId: agiConfirmMatch[2],
          })
            .then((reply) => channel.sendMessage(chatJid, reply))
            .catch((err) => {
              logger.warn(
                { component: 'agi_runtime', chatJid, err },
                'AGI confirmation command failed',
              );
              return channel.sendMessage(
                chatJid,
                'AGI confirmation failed before any action was taken.',
              );
            });
        }
        return;
      }

      const responseFeedbackAction = parseResponseFeedbackAction(rawTrimmed);
      if (responseFeedbackAction) {
        handleResponseFeedbackAction(
          chatJid,
          msg,
          responseFeedbackAction,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Response feedback action error'),
        );
        return;
      }

      // Natural self-repair approvals bind to the most recent safe feedback card before generic chat.
      const naturalRepairApproval = resolvePendingResponseFeedbackApproval(
        rawTrimmed,
        await refreshRecentResponseFeedbackTruth({ chatJid, limit: 10 }),
      );
      if (
        naturalRepairApproval.state === 'ready' &&
        trustedInboundOwnerSurface
      ) {
        if (naturalRepairApproval.absorbedRecord) {
          const absorbed = naturalRepairApproval.absorbedRecord;
          updateResponseFeedback(naturalRepairApproval.record.feedbackId, {
            linkedRefs: {
              ...(naturalRepairApproval.record.linkedRefs || {}),
              absorbedFeedbackIds: Array.from(
                new Set([
                  ...(naturalRepairApproval.record.linkedRefs
                    ?.absorbedFeedbackIds || []),
                  absorbed.feedbackId,
                ]),
              ),
              repairBindingState: 'natural_approval_absorbed_prior_feedback',
            },
          });
          updateResponseFeedback(absorbed.feedbackId, {
            status: 'cancelled',
            linkedRefs: {
              ...(absorbed.linkedRefs || {}),
              approvalBoundFeedbackId: naturalRepairApproval.record.feedbackId,
              repairBindingState: 'absorbed_by_repair_approval',
              repairExecutionState: 'approval_bound_to_prior_repair',
            },
            operatorNote:
              'This feedback row was an approval utterance. Andrea bound it to the prior pending repair instead of starting a second orphan repair.',
          });
        }
        handleResponseFeedbackAction(
          chatJid,
          msg,
          naturalRepairApproval.action,
        ).catch((err) =>
          logger.error(
            { err, chatJid },
            'Natural response feedback repair approval error',
          ),
        );
        return;
      }
      if (naturalRepairApproval.state === 'stale') {
        const channel = findChannel(channels, chatJid);
        if (channel) {
          channel
            .sendMessage(
              chatJid,
              [
                'I found an older repair plan, but I am not going to start a stale self-repair from a loose approval phrase.',
                'Tap the current feedback card approval button, or ask me for the self-improvement status so I can show the latest safe action.',
              ].join('\n'),
              buildOperatorSendOptions(msg),
            )
            .catch((err) =>
              logger.error(
                { err, chatJid },
                'Natural response feedback stale approval notice error',
              ),
            );
          return;
        }
      }

      // Explicit standalone owner verdicts review only the immediately latest
      // private-surface response. Mixed action language is rejected by the
      // resolver, so feedback can never become send/deploy/purchase approval.
      const naturalVerdictChannel = findChannel(channels, chatJid);
      const naturalVerdictSurface = isTrustedOwnerReviewSurface({
        channelName: naturalVerdictChannel?.name,
        chatJid,
        group: resolveCompanionBinding(chatJid)?.group,
        ownerAuthored: msg.is_from_me === true,
      });
      if (naturalVerdictSurface) {
        const candidateChatJids =
          naturalVerdictChannel?.name === 'bluebubbles'
            ? expandBlueBubblesLogicalSelfThreadJids(chatJid)
            : [chatJid];
        const naturalVerdict = resolveNaturalResponseFeedbackVerdict(
          rawTrimmed,
          candidateChatJids.flatMap((candidateChatJid) =>
            listRecentResponseFeedback({
              chatJid: candidateChatJid,
              limit: 3,
            }),
          ),
        );
        if (naturalVerdict.state === 'ready') {
          handleResponseFeedbackAction(chatJid, msg, naturalVerdict.action, {
            completionVerified: naturalVerdict.completionVerified,
            memoryCorrectness: naturalVerdict.memoryCorrectness,
            reviewSource: 'natural_language',
          }).catch((err) =>
            logger.error(
              { err, chatJid },
              'Natural response feedback verdict error',
            ),
          );
          return;
        }
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
            isMain: mainControlChat,
          },
          'Blocked command outside allowed surface',
        );
        return;
      }

      const openClawChannel = findChannel(channels, chatJid);
      const openClawOwnerControlSurface = isOpenClawOwnerControlSurface({
        mainControlChat,
        channelName: openClawChannel?.name,
        blueBubblesSelfThread:
          msg.is_from_me === true &&
          isConfiguredBlueBubblesSelfThreadAliasJid(chatJid),
      });
      const openClawRoute = resolveOpenClawDelegationRoute({
        rawMessage: rawTrimmed,
        mainControlChat: openClawOwnerControlSurface,
        delegationEnabled: isOpenClawDelegationEnabled(),
      });
      if (openClawRoute.action === 'restrict') {
        const channel = findChannel(channels, chatJid);
        channel
          ?.sendMessage(
            chatJid,
            "OpenClaw delegation is restricted to Andrea's private owner-control surfaces.",
            buildOperatorSendOptions(msg),
          )
          .catch((err) =>
            logger.error(
              { err, chatJid },
              'OpenClaw delegation restriction reply failed',
            ),
          );
        return;
      }
      if (openClawRoute.action === 'delegate') {
        handleOpenClawDelegation(
          chatJid,
          openClawRoute.request.prompt,
          msg,
          openClawRoute.request.command,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'OpenClaw delegation command error'),
        );
        return;
      }

      const bundleCommand = parseBundleCommand(rawTrimmed);
      if (bundleCommand) {
        applyAndPresentActionBundle({
          chatJid,
          bundleId: bundleCommand.bundleId,
          operation: bundleCommand.operation,
          ownerAuthored: msg.is_from_me === true,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Follow-through review command error'),
        );
        return;
      }

      const messageActionCommand = parseMessageActionCommand(rawTrimmed);
      if (messageActionCommand) {
        await applyAndPresentMessageAction({
          chatJid,
          messageActionId: messageActionCommand.messageActionId,
          operation: messageActionCommand.operation,
          sourcePresentationMessageId: msg.reply_to_id || null,
          sourcePresentationThreadId: msg.thread_id || null,
          ownerAuthored: msg.is_from_me === true,
          ownerAuthorizationAt: callbackOwnerAuthorizationAt,
          now: new Date(),
        });
        return;
      }

      const reviewCommand = parseReviewCommand(rawTrimmed);
      if (reviewCommand) {
        applyAndPresentOutcomeReviewControl({
          chatJid,
          outcomeId: reviewCommand.outcomeId,
          control: reviewCommand.control,
          ownerAuthored: msg.is_from_me === true,
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
          ownerAuthored: msg.is_from_me === true,
          now: new Date(),
        }).catch((err) =>
          logger.error({ err, chatJid }, 'Delegation rule command error'),
        );
        return;
      }

      if (UNIFIED_JOB_COMMANDS.has(commandToken)) {
        handleUnifiedJob(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Unified /job command error'),
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

      if (INTEGRATION_RECOVERY_COMMANDS.has(commandToken)) {
        handleIntegrationRecovery(chatJid, rawTrimmed, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Integration recovery command error'),
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
        mainControlChat &&
        !isSlashCommand &&
        isCurrentWorkQuickOpenPhrase(trimmed)
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

      const repliedCursorDashboard =
        mainControlChat && !isSlashCommand && rawTrimmed
          ? getCursorDashboardMessageContext(chatJid, msg.reply_to_id)
          : null;
      if (repliedCursorDashboard?.recoveryReply) {
        sendCursorMessage(
          chatJid,
          repliedCursorDashboard.recoveryReply,
          msg,
        ).catch((err) =>
          logger.error({ err, chatJid }, 'Work recovery guidance send failed'),
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
              logger.error(
                { err, chatJid },
                'Current-work runtime followup error',
              ),
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
        mainControlChat && !isSlashCommand && rawTrimmed
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
            logger.error(
              { err, chatJid },
              'BlueBubbles slash-command gate reply failed',
            ),
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
      const blueBubblesBinding = chatJid.startsWith('bb:')
        ? resolveCompanionBinding(chatJid)
        : null;
      if (blueBubblesBinding) {
        const companionNow = new Date();
        if (!trustedInboundOwnerSurface) {
          ignorePendingActionableIngressMessage({
            chatJid,
            messageId: msg.id,
            disposition: 'bluebubbles_self_thread_rejected_non_owner',
            now: companionNow,
          });
          logger.info(
            { chatJid, messageId: msg.id },
            'Ignored non-owner-authored BlueBubbles self-thread activity as control input',
          );
          return;
        }
        if (isBlueBubblesProofDrillStartRequest(msg.content)) {
          // The durable queue is the only proof-drill executor. The stored
          // ingress row can now be recovered after a crash and cannot race a
          // second direct delivery from this callback.
          queue.enqueueMessageCheck(chatJid);
          logger.debug(
            { chatJid, messageId: msg.id },
            'Enqueued BlueBubbles proof drill through durable ingress',
          );
          return;
        }
        const hasRecentCompanionContext = Boolean(
          getSharedAssistantCapabilitySeed(chatJid, companionNow),
        );
        const pendingLocalContinuationKind =
          getPendingBlueBubblesLocalContinuationKind(chatJid, companionNow);
        const messageActionCommandText = normalizeBlueBubblesCompanionPrompt(
          msg.content,
        );
        const interpretedMessageActionFollowup = interpretMessageActionFollowup(
          messageActionCommandText,
        );
        const resolvedMessageAction = interpretedMessageActionFollowup
          ? resolveMessageActionForFollowup({
              groupFolder: blueBubblesBinding.group.folder,
              chatJid,
              rawText: messageActionCommandText,
              now: companionNow,
            })
          : null;
        const continuitySnapshot = interpretedMessageActionFollowup
          ? reconcileBlueBubblesMessageActionContinuity({
              groupFolder: blueBubblesBinding.group.folder,
              chatJid,
              now: companionNow,
              allowRehydrate: true,
            })
          : null;
        const hasOpenMessageActionFollowup =
          Boolean(interpretedMessageActionFollowup) &&
          Boolean(resolvedMessageAction) &&
          Boolean(continuitySnapshot) &&
          canUseBareBlueBubblesMessageActionFollowup({
            rawText: messageActionCommandText,
            operation: interpretedMessageActionFollowup!,
            continuity: continuitySnapshot!,
          });
        const companionIngressDecision = decideBlueBubblesCompanionIngress(
          msg.content,
          {
            chatJid,
            hasRecentCompanionContext,
            hasOpenMessageActionFollowup,
            pendingLocalContinuationKind,
          },
        );
        if (companionIngressDecision.kind === 'explicit_ask') {
          const selfThreadOpenClawRoute = resolveOpenClawDelegationRoute({
            rawMessage: rawTrimmed,
            mainControlChat: isOpenClawOwnerControlSurface({
              mainControlChat: false,
              channelName: 'bluebubbles',
              blueBubblesSelfThread:
                msg.is_from_me === true &&
                isConfiguredBlueBubblesSelfThreadAliasJid(chatJid),
            }),
            delegationEnabled: isOpenClawDelegationEnabled(),
          });
          if (selfThreadOpenClawRoute.action === 'delegate') {
            queue.enqueueMessageCheck(chatJid);
            return;
          }
          try {
            const primed = await primeBlueBubblesChatHistory(
              blueBubblesConfig,
              chatJid,
              12,
            );
            if (primed.storedCount > 0) {
              logger.debug(
                {
                  chatJid,
                  storedCount: primed.storedCount,
                  totalCount: primed.totalCount,
                },
                'Primed BlueBubbles recent chat history for an owner self-thread ask',
              );
            }
          } catch (error) {
            logger.info(
              { err: error, chatJid },
              'BlueBubbles recent-history priming failed; continuing with stored local context',
            );
          }
          logger.debug(
            { chatJid, messageId: msg.id },
            'Enqueued BlueBubbles companion turn from an owner self-thread ask',
          );
          queue.enqueueMessageCheck(chatJid);
        } else if (
          companionIngressDecision.kind === 'pending_local_continuation'
        ) {
          logger.debug(
            {
              chatJid,
              messageId: msg.id,
              continuationKind: companionIngressDecision.continuationKind,
            },
            'Enqueued BlueBubbles same-thread follow-up for pending local continuation',
          );
          queue.enqueueMessageCheck(chatJid);
        } else {
          lastAgentTimestamp[chatJid] = msg.timestamp;
          saveState();
          ignorePendingActionableIngressMessage({
            chatJid,
            messageId: msg.id,
            disposition: 'bluebubbles_non_companion_chatter',
            now: companionNow,
          });
          logger.debug(
            { chatJid, messageId: msg.id },
            'Ignored non-actionable BlueBubbles owner self-thread chatter',
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
  const blueBubblesChannelForRecovery = channels.find(
    (channel): channel is BlueBubblesChannel =>
      channel instanceof BlueBubblesChannel,
  );
  if (blueBubblesChannelForRecovery?.isConnected()) {
    try {
      await blueBubblesChannelForRecovery.primeRecentHistory({
        limit: 200,
        recoverUnacceptedClaims: true,
      });
      const groupFolders = [
        ...new Set(
          Object.values(registeredGroups)
            .map((entry) => entry.folder)
            .filter(Boolean),
        ),
      ];
      for (const groupFolder of groupFolders) {
        const recovery = reconcileBlueBubblesUnverifiedMessageActions({
          groupFolder,
        });
        if (recovery.inspected > 0) {
          logger.info(
            { component: 'bluebubbles_recovery', groupFolder, ...recovery },
            'Reconciled fenced BlueBubbles message actions from exact recent provider history',
          );
        }
      }
    } catch (error) {
      logger.warn(
        { component: 'bluebubbles_recovery', err: error },
        'BlueBubbles startup reconciliation was unavailable; fenced actions remain blocked from replay',
      );
    }
  }
  blueBubblesControlServer = startBlueBubblesControlServer({
    getChannel: () =>
      channels.find(
        (channel): channel is BlueBubblesChannel =>
          channel instanceof BlueBubblesChannel,
      ) || null,
  });
  ownerCockpitServer = startOwnerCockpitServer();
  resolveTelegramMainChatForAlexa = (groupFolder: string) => {
    const telegramEntries = Object.entries(registeredGroups).filter(([jid]) => {
      const channel = findChannel(channels, jid);
      return channel?.name === 'telegram';
    });
    const exactMain = telegramEntries.find(
      ([, group]) =>
        group.folder === groupFolder &&
        (group.isMain === true || groupFolder === 'main'),
    );
    if (exactMain) {
      return { chatJid: exactMain[0] };
    }
    const exact = telegramEntries.find(
      ([, group]) => group.folder === groupFolder,
    );
    if (exact) {
      return { chatJid: exact[0] };
    }
    if (groupFolder === 'main') {
      const fallbackMain = telegramEntries.find(
        ([, group]) => group.isMain === true,
      );
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
    if (
      !recentChat?.chatJid ||
      !isConfiguredBlueBubblesSelfThreadAliasJid(recentChat.chatJid)
    ) {
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
    return requireCompleteChannelDelivery(
      await channel.sendMessage(chatJid, text, options),
    );
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
        return sendCompanionHandoffArtifactToChannel(
          chatJid,
          artifact,
          options,
        );
      },
    });
  } catch (err) {
    logger.error({ err }, 'Alexa voice ingress failed to start');
  }

  const hasAlexaIngress = alexaRuntime?.getStatus().running === true;
  if (channels.length === 0 && !hasAlexaIngress) {
    logger.fatal(
      'No channels connected and Alexa voice ingress is not running',
    );
    process.exit(1);
  }
  if (channels.length === 0 && hasAlexaIngress) {
    logger.info(
      'No chat channels connected; Alexa voice ingress is serving locally',
    );
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    getAgentThreads: () => agentThreads,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder, ipcContext) =>
      queue.registerProcess(
        groupJid,
        proc,
        containerName,
        groupFolder,
        undefined,
        undefined,
        ipcContext,
      ),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) {
        requireCompleteChannelDelivery(await channel.sendMessage(jid, text));
      }
    },
    sendToTarget: async (targetChannel, chatJid, text, options) =>
      sendCompanionHandoffMessage(targetChannel, chatJid, text, options),
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      requireCompleteChannelDelivery(await channel.sendMessage(jid, text));
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
  queue.setProcessMessagesFn(async (groupJid: string) => {
    return runQueuedTurnWithCursorRecovery({
      chatJid: groupJid,
      registry: inFlightCursorRollbacks,
      run: async () => {
        try {
          return await processGroupMessages(groupJid);
        } catch (error) {
          if (!isCommittedIncompleteDeliveryError(error)) throw error;
          logger.error(
            {
              component: 'assistant',
              chatJid: groupJid,
              deliveryOutcome: error.deliveryOutcome,
              confirmedReceiptCount: error.confirmedReceiptCount,
              nextUnconfirmedChunkIndex: error.nextUnconfirmedChunkIndex,
            },
            'Stopped workflow advancement after an incomplete or uncertain committed reply',
          );
          return true;
        }
      },
      rollback: (chatJid, previousCursor) => {
        lastAgentTimestamp[chatJid] = previousCursor;
        saveState();
      },
    });
  });
  writeAssistantReadyState(appVersion);
  writeCurrentAssistantHealth();
  assistantHealthInterval = setInterval(() => {
    writeCurrentAssistantHealth();
  }, 30_000);
  assistantHealthInterval.unref?.();
  bootAlertInterval = setInterval(() => {
    void dispatchPendingBootSummaryAlert();
  }, 10_000);
  bootAlertInterval.unref?.();
  void dispatchSystemHealthAlerts();
  const systemAlertConfig = resolveSystemAlertConfig();
  void refreshCurrentToolReliability('startup');
  toolReliabilityInterval = setInterval(() => {
    void refreshCurrentToolReliability('interval');
  }, resolveToolReliabilityRefreshIntervalMs(systemAlertConfig.providerHealthIntervalMinutes));
  toolReliabilityInterval.unref?.();
  if (systemAlertConfig.enabled) {
    systemAlertInterval = setInterval(() => {
      void dispatchSystemHealthAlerts();
    }, systemAlertConfig.providerHealthIntervalMinutes * 60_000);
    systemAlertInterval.unref?.();
  }
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
  process.argv[1] && path.resolve(process.argv[1]) === ACTIVE_ENTRY_PATH;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
