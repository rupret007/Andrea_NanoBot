import { createHash } from 'crypto';

import {
  buildAndreaPulseReply,
  getDefaultPulsePreference,
} from './andrea-pulse.js';
import {
  buildDailyCompanionResponse,
  buildDailyJourneyWhyLine,
  type DailyCompanionContext,
  type DailyCompanionResponse,
} from './daily-companion.js';
import {
  formatClock,
  getUpcomingReminders,
  type DailyCommandCenterDeps,
  type GroundedDaySnapshot,
  type SelectedWorkContext,
} from './daily-command-center.js';
import { buildUsefulDailyCommandCenter } from './useful-daily-command-center.js';
import {
  createTask,
  getAllChats,
  getAllTasks,
  getMessageActionBySource,
  listMessageMediaAttachments,
  listMessagesForChatWindow,
  listProfileFactsForGroup,
} from './db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
  type LifeThreadCommandResult,
} from './life-threads.js';
import {
  handlePersonalizationCommand,
  type PersonalizationCommandResult,
} from './assistant-personalization.js';
import { handleMemoryActivationCommand } from './memory-activation.js';
import { resolveCompanionToneProfileFromFacts } from './companion-personality.js';
import {
  isResearchPrompt,
  runResearchOrchestrator,
  type ResearchSupportingSource,
  type ResearchResult,
} from './research-orchestrator.js';
import { runImageGeneration } from './media-generation.js';
import { analyzeMessageMedia } from './media-analysis.js';
import {
  deleteKnowledgeSourceById,
  extractKnowledgeTopicQuery,
  disableKnowledgeSourceById,
  importKnowledgeFile,
  reindexKnowledgeSourceById,
  resolveKnowledgeSourceSelection,
  saveKnowledgeSource,
  searchKnowledgeLibrary,
} from './knowledge-library.js';
import { handleRitualCommand } from './rituals.js';
import { planContextualReminder } from './local-reminder.js';
import {
  analyzeCommunicationMessage,
  buildCommunicationOpenLoops,
  draftCommunicationReply,
  draftCommunicationReplyWithChannelFluidity,
  formatCommunicationAnalysisReply,
  formatCommunicationDraftReply,
  formatCommunicationOpenLoopsReply,
  manageCommunicationTracking,
} from './communication-companion.js';
import { handleCommunicationIdentityReview } from './communication-identity-review.js';
import {
  summarizeBlueBubblesThreadDigest,
  type BlueBubblesSuggestedReply,
} from './messages-fluidity.js';
import {
  extractGroundedMessagesPlanFacts,
  formatGroundedMessagesPlanFact,
  type GroundedMessagesPlanFact,
} from './messages-commitment-summary.js';
import { hasMessagesGroundingPolarityConflict } from './messages-grounding-polarity.js';
import {
  applyMessageActionOperation,
  createOrRefreshMessageActionFromDraft,
  resolveBlueBubblesThreadTargetByName,
  type MessageActionOperation,
  type ResolvedBlueBubblesThreadTarget,
} from './message-actions.js';
import { ALL_SYNCED_MESSAGES_TARGET } from './thread-summary-routing.js';
import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  buildRecentTextReviewSeedJson,
  buildMessagesThreadFreshnessSnapshot,
  describeMessageForSummary,
  buildReviewDraftPrompt,
  findLatestUnresolvedInboundAsk,
  formatRecentTextReviewFreshnessBlockedReply,
  formatRecentTextReviewUnboundReply,
  formatRecentTextReviewItemWhyReply,
  formatRecentTextReviewReply,
  isAutomatedRecentTextNotice,
  isBlueBubblesReactionPlaceholder,
  isExactNonEmptyMessagesHistoryRefreshReceipt,
  parseRecentTextReviewItemFollowup,
  parseRecentTextReviewSeedJson,
  recordRecentTextReviewOutcome,
  redactRecentTextReviewText,
  resolveRecentTextReviewFollowupTarget,
  reviewRecentTexts,
  validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh,
  validateMessagesThreadSnapshotBinding,
  type RecentTextReviewOutcome,
  type RecentTextReviewFreshnessSnapshot,
} from './recent-text-review.js';
import {
  buildFollowThroughOutcomeMetadata,
  handleFollowThroughActivationCommand,
  type FollowThroughOutcomeKind,
} from './follow-through-activation.js';
import { buildChiefOfStaffTurn } from './chief-of-staff.js';
import {
  buildMissionExecutionContext,
  buildMissionTurn,
  pickMissionActionFromUtterance,
  updateMissionAfterExecution,
} from './missions.js';
import { handleDeepWorkApprenticeshipCommand } from './deep-work-apprenticeship.js';
import {
  buildSignatureFlowPayload,
  buildSignaturePostActionConfirmation,
  buildSignatureSignalsWhyLine,
  stripSignatureFlowSystemPrefix,
  buildSignatureFlowText,
} from './signature-flows.js';
import { capturePilotIssue } from './pilot-mode.js';
import { handleEverydayCaptureCommand } from './everyday-capture.js';
import type {
  AlexaCompanionGuidanceGoal,
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  ChiefOfStaffContext,
  CompanionContinuationCandidate,
  CompanionHandoffPayload,
  CompanionToneProfile,
  EverydayListScope,
  KnowledgeSourceRecord,
  LifeThreadSnapshot,
  MediaGenerationResult,
  MessageActionLastActionKind,
  MessageActionNamedMessagesSummaryLink,
  MessageActionRecentTextReviewLink,
  MessageActionRecord,
  MessageActionSendStatus,
  MissionExecutionContext,
  MissionSuggestedAction,
  NewMessage,
  SendMessageOptions,
  CompanionRouteTimeWindowKind,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';
import { formatThreadSummaryWindowLabel } from './thread-summary-routing.js';
import { TIMEZONE } from './config.js';

export type AssistantCapabilityId =
  | 'daily.morning_brief'
  | 'daily.whats_next'
  | 'daily.loose_ends'
  | 'daily.evening_reset'
  | 'daily.command_center'
  | 'household.candace_upcoming'
  | 'household.family_open_loops'
  | 'followthrough.remind_before_anchor'
  | 'followthrough.save_for_later'
  | 'followthrough.draft_follow_up'
  | 'followthrough.reminder_overview'
  | 'pilot.capture_issue'
  | 'threads.list_open'
  | 'threads.explicit_lookup'
  | 'memory.explain'
  | 'memory.remember'
  | 'memory.forget'
  | 'memory.manual_only'
  | 'pulse.interesting_thing'
  | 'pulse.surprise_me'
  | 'rituals.status'
  | 'rituals.configure'
  | 'rituals.followthrough'
  | 'knowledge.save_source'
  | 'knowledge.list_sources'
  | 'knowledge.summarize_saved'
  | 'knowledge.compare_saved'
  | 'knowledge.explain_sources'
  | 'knowledge.disable_source'
  | 'knowledge.delete_source'
  | 'knowledge.reindex_source'
  | 'communication.understand_message'
  | 'communication.summarize_thread'
  | 'communication.review_recent_texts'
  | 'communication.manage_identity_links'
  | 'communication.draft_reply'
  | 'communication.open_loops'
  | 'communication.manage_tracking'
  | 'missions.propose'
  | 'missions.view'
  | 'missions.execute'
  | 'missions.manage'
  | 'missions.explain'
  | 'staff.prioritize'
  | 'staff.plan_horizon'
  | 'staff.prepare'
  | 'staff.decision_support'
  | 'staff.explain'
  | 'staff.configure'
  | 'research.topic'
  | 'research.compare'
  | 'research.summarize'
  | 'research.recommend'
  | 'work.current_summary'
  | 'work.current_output'
  | 'work.current_logs'
  | 'media.analyze'
  | 'media.image_generate'
  | 'media.image_edit'
  | 'media.video_generate'
  | 'capture.profile_setup'
  | 'capture.profile_review'
  | 'capture.add_item'
  | 'capture.read_items'
  | 'capture.update_item'
  | 'capture.convert_item';

export type AssistantCapabilityCategory =
  | 'daily'
  | 'household'
  | 'followthrough'
  | 'pilot'
  | 'threads'
  | 'memory'
  | 'pulse'
  | 'rituals'
  | 'knowledge'
  | 'communication'
  | 'missions'
  | 'staff'
  | 'research'
  | 'work'
  | 'media'
  | 'capture';

export type AssistantCapabilityOutputShape =
  | 'voice_brief'
  | 'chat_brief'
  | 'chat_rich'
  | 'handoff_offer'
  | 'artifact_only';

export type AssistantCapabilityHandlerKind =
  | 'local'
  | 'research'
  | 'backend_lane'
  | 'edge_only';

type AssistantConversationTaskKind =
  | 'calendar_read'
  | 'calendar_write'
  | 'calendar_move'
  | 'calendar_cancel'
  | 'reminder_write'
  | 'communication_draft'
  | 'planning_guidance'
  | 'list_capture'
  | 'list_read'
  | 'list_update'
  | 'profile_setup';

export interface AssistantCapabilityContext {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder?: string;
  chatJid?: string;
  ownerReviewAllowed?: boolean;
  /**
   * Refreshes one exact Messages chat before a review-backed continuation is
   * allowed to create or mutate an action. Absence and failure are both
   * fail-closed; a broad/global history refresh is not equivalent.
   */
  primeMessagesChatHistory?: (chatJid: string) => Promise<unknown>;
  currentMessageId?: string;
  currentAttachmentIds?: string[];
  now?: Date;
  selectedWork?: SelectedWorkContext | null;
  conversationSummary?: string;
  priorCompanionContext?: DailyCompanionContext | null;
  groundedSnapshot?: GroundedDaySnapshot;
  lifeThreadSnapshot?: LifeThreadSnapshot;
  calendarDeps?: Pick<
    DailyCommandCenterDeps,
    'env' | 'fetchImpl' | 'platform' | 'runAppleCalendarScript' | 'timeZone'
  >;
  replyText?: string;
  factIdHint?: string;
  threadHint?: string;
  priorSubjectData?: {
    lastIntentFamily?: string;
    lastRouteOutcome?: string;
    lastUserUtterance?: string;
    clarifierHints?: string[];
    activeVoiceFamily?: string;
    activeVoiceAnchor?: string;
    activeVoiceActionSummary?: string;
    lastAnswerSummary?: string;
    lastRecommendation?: string;
    conversationFocus?: string;
    threadId?: string;
    threadTitle?: string;
    personName?: string;
    researchRouteExplanation?: string;
    researchProviderUsed?: ResearchResult['providerUsed'];
    saveForLaterCandidate?: string;
    knowledgeSourceIds?: string[];
    knowledgeSourceTitles?: string[];
    knowledgeSourceMatches?: string[];
    knowledgeLastQuery?: string;
    communicationThreadId?: string;
    communicationSubjectIds?: string[];
    communicationLifeThreadIds?: string[];
    lastCommunicationSummary?: string;
    namedMessagesSummaryTargetJson?: string;
    recentTextReviewJson?: string;
    followthroughReviewJson?: string;
    chiefOfStaffContextJson?: string;
    missionId?: string;
    missionSummary?: string;
    missionSuggestedActionsJson?: string;
    missionBlockersJson?: string;
    missionStepFocusJson?: string;
    activeCapabilityId?: AssistantCapabilityId;
    companionContinuationJson?: string;
    actionBundleId?: string;
    actionBundleTitle?: string;
    actionBundleSummary?: string;
    messageActionId?: string;
    messageActionSummary?: string;
    delegationRulePreviewJson?: string;
    delegationRuleFocusRuleId?: string;
    delegationRuleExplanation?: string;
    activeListGroupId?: string;
    activeListItemIds?: string[];
    activeListScope?: EverydayListScope;
    activeOperatingProfileId?: string;
    activeTaskKind?: AssistantConversationTaskKind;
  };
}

export interface AssistantCapabilityInput {
  text?: string;
  canonicalText?: string;
  personName?: string;
  targetChatName?: string | null;
  targetChatJid?: string | null;
  threadTitle?: string | null;
  timeWindowKind?: CompanionRouteTimeWindowKind | null;
  timeWindowValue?: number | null;
  savedMaterialOnly?: boolean | null;
  replyStyle?: 'shorter' | 'warmer' | 'more_direct' | null;
  followupAction?: AlexaConversationFollowupAction;
  researchDepth?: 'brief' | 'standard' | 'deep';
  allowWebSearch?: boolean;
  personalContextMode?: 'auto' | 'explicit' | 'disabled';
  researchFollowupMode?: 'default' | 'explicit_only';
  reason?: string;
}

export interface AssistantCapabilityTrace {
  capabilityId: AssistantCapabilityId;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  handlerKind: AssistantCapabilityHandlerKind;
  responseSource:
    | 'local_companion'
    | 'life_thread_local'
    | 'memory_local'
    | 'pulse_local'
    | 'knowledge_library'
    | 'research_local'
    | 'research_openai'
    | 'research_minimax'
    | 'research_handoff'
    | 'media_openai'
    | 'media_handoff'
    | 'edge_only'
    | 'unavailable';
  reason: string;
  notes: string[];
}

export interface AssistantCapabilityConversationSeed {
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  summaryText: string;
  guidanceGoal: AlexaCompanionGuidanceGoal;
  subjectData?: {
    personName?: string;
    activePeople?: string[];
    householdFocus?: boolean;
    threadId?: string;
    threadTitle?: string;
    threadSummaryLines?: string[];
    lastAnswerSummary?: string;
    lastRecommendation?: string;
    pendingActionText?: string;
    conversationFocus?: string;
    fallbackCount?: number;
    dailyCompanionContextJson?: string;
    profileFactId?: string;
    activeCapabilityId?: AssistantCapabilityId;
    researchHandoffEligible?: boolean;
    researchRouteExplanation?: string;
    researchProviderUsed?: ResearchResult['providerUsed'];
    saveForLaterCandidate?: string;
    knowledgeSourceIds?: string[];
    knowledgeSourceTitles?: string[];
    knowledgeSourceMatches?: string[];
    knowledgeLastQuery?: string;
    communicationThreadId?: string;
    communicationSubjectIds?: string[];
    communicationLifeThreadIds?: string[];
    lastCommunicationSummary?: string;
    namedMessagesSummaryTargetJson?: string;
    recentTextReviewJson?: string;
    followthroughReviewJson?: string;
    chiefOfStaffContextJson?: string;
    missionId?: string;
    missionSummary?: string;
    missionSuggestedActionsJson?: string;
    missionBlockersJson?: string;
    missionStepFocusJson?: string;
    toneProfile?: CompanionToneProfile;
    companionContinuationJson?: string;
    actionBundleId?: string;
    actionBundleTitle?: string;
    actionBundleSummary?: string;
    messageActionId?: string;
    messageActionSummary?: string;
    delegationRulePreviewJson?: string;
    delegationRuleFocusRuleId?: string;
    delegationRuleExplanation?: string;
    activeListGroupId?: string;
    activeListItemIds?: string[];
    activeListScope?: EverydayListScope;
    activeOperatingProfileId?: string;
    activeTaskKind?: AssistantConversationTaskKind;
  };
  supportedFollowups?: AlexaConversationFollowupAction[];
  prioritizationLens?:
    | 'general'
    | 'calendar'
    | 'family'
    | 'meeting'
    | 'work'
    | 'evening';
  hasActionItem?: boolean;
  hasRiskSignal?: boolean;
  reminderCandidate?: boolean;
  responseStyle?: 'default' | 'short_direct' | 'expanded';
  responseSource?: 'assistant_bridge' | 'local_companion';
}

export interface AssistantCapabilityResult {
  handled: boolean;
  capabilityId?: AssistantCapabilityId;
  replyText?: string;
  sendOptions?: Pick<SendMessageOptions, 'inlineActions' | 'inlineActionRows'>;
  outputShape?: AssistantCapabilityOutputShape;
  trace?: AssistantCapabilityTrace;
  dailyResponse?: DailyCompanionResponse;
  lifeThreadResult?: LifeThreadCommandResult;
  personalizationResult?: PersonalizationCommandResult;
  researchResult?: ResearchResult;
  mediaResult?: MediaGenerationResult;
  conversationSeed?: AssistantCapabilityConversationSeed;
  handoffOffer?: string;
  followupActions?: AlexaConversationFollowupAction[];
  handoffPayload?: CompanionHandoffPayload;
  continuationCandidate?: CompanionContinuationCandidate;
  messageAction?: MessageActionRecord;
  outcomeMetadata?: AssistantCapabilityOutcomeMetadata;
}

export interface AssistantCapabilityOutcomeMetadata {
  source: 'recent_text_review' | 'followthrough_activation';
  outcomeKind: RecentTextReviewOutcome | FollowThroughOutcomeKind;
  handled: boolean;
  capabilityId: AssistantCapabilityId;
  messageActionId?: string;
  sendStatus?: MessageActionSendStatus;
  lastActionKind?: MessageActionLastActionKind | null;
  itemId?: string;
  itemRank?: number;
  taskId?: string;
  agentOSEpisodeId?: string;
  providerUsed?: 'local' | 'openai';
  counts?: {
    needsReply: number;
    worthWatching: number;
    noReplyNeeded: number;
  };
}

export interface AssistantCapabilityDescriptor {
  id: AssistantCapabilityId;
  label: string;
  category: AssistantCapabilityCategory;
  requiredInputs: string[];
  optionalInputs: string[];
  requiresLinkedAccount: boolean;
  requiresConfirmation: boolean;
  safeForAlexa: boolean;
  safeForTelegram: boolean;
  safeForBlueBubbles: boolean;
  operatorOnly: boolean;
  preferredOutputShape: {
    alexa: AssistantCapabilityOutputShape;
    telegram: AssistantCapabilityOutputShape;
    bluebubbles: AssistantCapabilityOutputShape;
  };
  followupActions: AlexaConversationFollowupAction[];
  handlerKind: AssistantCapabilityHandlerKind;
  availabilityNote?: string;
  execute?: (
    context: AssistantCapabilityContext,
    input: AssistantCapabilityInput,
  ) => Promise<AssistantCapabilityResult>;
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value: string | undefined, maxLength: number): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function clipPreservedText(
  value: string | null | undefined,
  maxLength: number,
): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildCapabilityTrace(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  responseSource: AssistantCapabilityTrace['responseSource'],
  reason: string,
  notes: string[] = [],
): AssistantCapabilityTrace {
  return {
    capabilityId: descriptor.id,
    channel: context.channel,
    handlerKind: descriptor.handlerKind,
    responseSource,
    reason,
    notes,
  };
}

function serializeCompanionContinuation(
  candidate: CompanionContinuationCandidate | undefined,
): string | undefined {
  return candidate ? JSON.stringify(candidate) : undefined;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildDailyContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  response: DailyCompanionResponse,
): CompanionContinuationCandidate {
  const buildDailyCompletionText = (): string => {
    const summaryText = normalizeText(response.context.summaryText);
    const summaryTarget = summaryText
      .replace(/^the easiest thing to forget right now is\s+/i, '')
      .replace(/^the main prep move is to get\s+/i, '')
      .replace(/^the main prep move is to\s+/i, '')
      .replace(
        /^for (?:today|tonight|tomorrow|this week|weekend|next few days),\s+/i,
        '',
      )
      .replace(/\s+ready\.$/i, '')
      .replace(/[.!?]+$/g, '')
      .trim();
    if (
      summaryTarget &&
      summaryTarget.toLowerCase() !== summaryText.toLowerCase()
    ) {
      return summaryTarget;
    }

    const detailTarget = stripSignatureFlowSystemPrefix(
      response.context.extraDetails[0],
    )
      .replace(/[.!?]+$/g, '')
      .trim();
    if (
      detailTarget &&
      !/^work:\s*/i.test(detailTarget) &&
      !/^at home,\s*/i.test(detailTarget)
    ) {
      return detailTarget;
    }

    const recommendationTarget = normalizeText(
      response.context.recommendationText || undefined,
    )
      .replace(/^handle\s+/i, '')
      .replace(/^keep\s+/i, '')
      .replace(/\s+next[.!?]*$/i, '')
      .replace(/[.!?]+$/g, '')
      .trim();
    if (recommendationTarget) {
      return recommendationTarget;
    }

    return summaryText || descriptor.label;
  };

  const title =
    response.context.usedThreadTitles?.[0] ||
    response.context.subjectData.personName ||
    descriptor.label;
  const followupSuggestions =
    response.context.recommendationKind === 'do_now'
      ? ['save that for later', 'remind me about that tonight']
      : ['what happens next', 'save that for later'];
  return {
    capabilityId: descriptor.id,
    voiceSummary: response.context.summaryText,
    handoffPayload: buildSignatureFlowPayload({
      title,
      lead: response.context.summaryText,
      detailLines: response.context.extraDetails,
      nextAction: response.context.recommendationText,
      whyLine:
        buildDailyJourneyWhyLine({
          leadReason: response.context.leadReason,
          signalsUsed: response.context.signalsUsed,
          subjectData: response.context.subjectData,
        }) || buildSignatureSignalsWhyLine(response.context.signalsUsed),
      followupSuggestions,
      sourceSummary:
        response.context.signalsUsed.length > 0
          ? `Using ${response.context.signalsUsed.join(', ')}`
          : undefined,
    }),
    completionText: buildDailyCompletionText(),
    threadId: response.context.usedThreadIds?.[0],
    threadTitle: response.context.usedThreadTitles?.[0],
    followupSuggestions,
  };
}

function extendCompanionFollowups(
  followups: AlexaConversationFollowupAction[] | undefined,
  candidate: CompanionContinuationCandidate | undefined,
): AlexaConversationFollowupAction[] {
  const next = new Set<AlexaConversationFollowupAction>(followups || []);
  if (candidate?.handoffPayload) {
    next.add('send_details');
  }
  if (candidate?.completionText?.trim()) {
    next.add('save_to_library');
    next.add('track_thread');
    next.add('create_reminder');
    next.add('save_for_later');
    next.add('draft_follow_up');
  }
  return [...next];
}

function getToneProfileForContext(
  context: AssistantCapabilityContext,
): CompanionToneProfile {
  if (!context.groupFolder) return 'balanced';
  return resolveCompanionToneProfileFromFacts(
    listProfileFactsForGroup(context.groupFolder, ['accepted']),
  );
}

function cloneContext(
  context: AssistantCapabilityContext,
): AssistantCapabilityContext {
  return {
    ...context,
    priorCompanionContext: context.priorCompanionContext || null,
  };
}

function buildDailySeed(
  id: AssistantCapabilityId,
  flowKey: string,
  summaryText: string,
  guidanceGoal: AlexaCompanionGuidanceGoal,
  defaults: Partial<AssistantCapabilityConversationSeed> = {},
): AssistantCapabilityConversationSeed {
  return {
    flowKey,
    subjectKind: defaults.subjectKind || 'day_brief',
    summaryText,
    guidanceGoal,
    subjectData: {
      activeCapabilityId: id,
      fallbackCount: 0,
      ...(defaults.subjectData || {}),
    },
    supportedFollowups: defaults.supportedFollowups,
    prioritizationLens: defaults.prioritizationLens || 'general',
    hasActionItem: defaults.hasActionItem,
    hasRiskSignal: defaults.hasRiskSignal,
    reminderCandidate: defaults.reminderCandidate,
    responseSource: defaults.responseSource || 'local_companion',
  };
}

type ReminderOverviewWindow = 'upcoming' | 'today' | 'tomorrow' | 'this_week';

function resolveReminderOverviewWindow(value: string): ReminderOverviewWindow {
  const lower = value.toLowerCase();
  if (/\btomorrow\b/.test(lower)) return 'tomorrow';
  if (/\btoday\b/.test(lower)) return 'today';
  if (/\bthis week\b/.test(lower)) return 'this_week';
  return 'upcoming';
}

function startOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfLocalDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next;
}

function endOfLocalWeek(date: Date): Date {
  const next = endOfLocalDay(date);
  const currentDay = next.getDay();
  const daysUntilNextMonday = currentDay === 0 ? 1 : 8 - currentDay;
  next.setDate(next.getDate() + daysUntilNextMonday);
  return next;
}

function filterReminderOverviewByWindow(
  reminders: Array<{ label: string; nextRunIso: string; id: string }>,
  window: ReminderOverviewWindow,
  now: Date,
): Array<{ label: string; nextRunIso: string; id: string }> {
  if (window === 'upcoming') {
    return reminders;
  }

  const start =
    window === 'today'
      ? now
      : window === 'tomorrow'
        ? startOfLocalDay(new Date(now.getTime() + 24 * 60 * 60 * 1000))
        : now;
  const end =
    window === 'today'
      ? endOfLocalDay(now)
      : window === 'tomorrow'
        ? endOfLocalDay(new Date(now.getTime() + 24 * 60 * 60 * 1000))
        : endOfLocalWeek(now);

  return reminders.filter((reminder) => {
    const runAt = new Date(reminder.nextRunIso);
    return (
      runAt.getTime() >= start.getTime() && runAt.getTime() < end.getTime()
    );
  });
}

function buildReminderOverviewLead(
  count: number,
  window: ReminderOverviewWindow,
): string {
  if (window === 'today') {
    return count === 1
      ? 'You have one reminder left today.'
      : `You have ${count} reminders left today.`;
  }
  if (window === 'tomorrow') {
    return count === 1
      ? 'Tomorrow you have one reminder.'
      : `Tomorrow you have ${count} reminders.`;
  }
  if (window === 'this_week') {
    return count === 1
      ? 'You have one reminder coming up this week.'
      : `You have ${count} reminders coming up this week.`;
  }
  return count === 1
    ? 'You have one upcoming reminder.'
    : `You have ${count} upcoming reminders.`;
}

function buildReminderOverviewEmptyReply(
  window: ReminderOverviewWindow,
): string {
  if (window === 'today') {
    return "You don't have any reminders left today.";
  }
  if (window === 'tomorrow') {
    return "I don't see any reminders tomorrow.";
  }
  if (window === 'this_week') {
    return "I don't see any reminders coming up this week.";
  }
  return "You don't have any upcoming reminders right now.";
}

function formatReminderOverviewItem(
  reminder: { label: string; nextRunIso: string },
  timeZone: string,
  now: Date,
  window: ReminderOverviewWindow,
): string {
  const runAt = new Date(reminder.nextRunIso);
  const timeLabel = formatClock(runAt, timeZone);
  if (window === 'today') {
    return `${timeLabel} ${reminder.label}`;
  }
  if (window === 'tomorrow') {
    return `${timeLabel} ${reminder.label}`;
  }
  const tomorrowStart = startOfLocalDay(
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
  );
  const tomorrowEnd = endOfLocalDay(
    new Date(now.getTime() + 24 * 60 * 60 * 1000),
  );
  if (
    runAt.getTime() >= now.getTime() &&
    runAt.getTime() < endOfLocalDay(now).getTime()
  ) {
    return `Today at ${timeLabel} ${reminder.label}`;
  }
  if (
    runAt.getTime() >= tomorrowStart.getTime() &&
    runAt.getTime() < tomorrowEnd.getTime()
  ) {
    return `Tomorrow at ${timeLabel} ${reminder.label}`;
  }
  const dayLabel = runAt.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone,
  });
  return `${dayLabel} at ${timeLabel} ${reminder.label}`;
}

async function runReminderOverviewCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };

  const now = context.now || new Date();
  const window = resolveReminderOverviewWindow(
    input.canonicalText || input.text || '',
  );
  const reminders = filterReminderOverviewByWindow(
    getUpcomingReminders(
      getAllTasks().filter((task) => task.group_folder === context.groupFolder),
      now,
    ),
    window,
    now,
  );

  const replyText =
    reminders.length === 0
      ? buildReminderOverviewEmptyReply(window)
      : [
          buildReminderOverviewLead(reminders.length, window),
          ...reminders
            .slice(0, context.channel === 'bluebubbles' ? 3 : 5)
            .map((reminder) =>
              formatReminderOverviewItem(reminder, TIMEZONE, now, window),
            ),
          reminders.length > (context.channel === 'bluebubbles' ? 3 : 5)
            ? `Plus ${reminders.length - (context.channel === 'bluebubbles' ? 3 : 5)} more after that.`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'day_brief',
      summaryText: replyText,
      guidanceGoal: 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        conversationFocus: 'reminders',
        lastAnswerSummary: replyText,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'summarized upcoming reminders from local scheduled tasks',
      [`window:${window}`, `reminders:${reminders.length}`],
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runDailyCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
  canonicalPrompt: string,
  seed: AssistantCapabilityConversationSeed,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const response = await buildDailyCompanionResponse(
    input.canonicalText || canonicalPrompt,
    {
      channel: context.channel,
      groupFolder: context.groupFolder,
      tasks: getAllTasks().filter(
        (task) => task.group_folder === context.groupFolder,
      ),
      priorContext: context.priorCompanionContext || null,
      now: context.now,
      groundedSnapshot: context.groundedSnapshot,
      lifeThreadSnapshot: context.lifeThreadSnapshot,
      ...(context.calendarDeps || {}),
    },
  );
  if (!response) return { handled: false };
  const continuationCandidate = buildDailyContinuationCandidate(
    descriptor,
    response,
  );
  const supportedFollowups = extendCompanionFollowups(
    response.context.supportedFollowups,
    continuationCandidate,
  );
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: response.reply,
    outputShape: descriptor.preferredOutputShape[context.channel],
    dailyResponse: response,
    conversationSeed: {
      ...seed,
      subjectKind: response.context.subjectKind,
      summaryText: response.context.summaryText,
      supportedFollowups,
      subjectData: {
        ...seed.subjectData,
        ...response.context.subjectData,
        activeCapabilityId: descriptor.id,
        threadId: response.context.usedThreadIds?.[0],
        threadTitle: response.context.usedThreadTitles?.[0],
        threadSummaryLines: response.context.threadSummaryLines || [],
        lastAnswerSummary: response.context.summaryText,
        lastRecommendation: response.context.recommendationText || undefined,
        pendingActionText: response.context.recommendationText || undefined,
        conversationFocus:
          response.context.usedThreadTitles?.[0] ||
          response.context.subjectData.personName ||
          response.context.subjectKind,
        dailyCompanionContextJson: JSON.stringify(response.context),
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      `handled by daily companion using "${input.canonicalText || canonicalPrompt}"`,
      response.context.usedThreadTitles?.length
        ? [`threads: ${response.context.usedThreadTitles.join(', ')}`]
        : [],
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
  };
}

async function runLifeThreadCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = handleLifeThreadCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    messageId: context.currentMessageId,
    text: input.canonicalText || input.text || '',
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: context.priorCompanionContext || null,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    lifeThreadResult: result,
    conversationSeed: result.referencedThread
      ? {
          flowKey: descriptor.id.replace(/\./g, '_'),
          subjectKind: 'life_thread',
          summaryText: result.responseText || result.referencedThread.title,
          guidanceGoal: 'life_thread_guidance',
          subjectData: {
            activeCapabilityId: descriptor.id,
            fallbackCount: 0,
            threadId: result.referencedThread.id,
            threadTitle: result.referencedThread.title,
            threadSummaryLines: [
              result.referencedThread.nextAction ||
                result.referencedThread.summary,
            ],
            conversationFocus: result.referencedThread.title,
          },
          supportedFollowups: descriptor.followupActions,
          prioritizationLens:
            result.referencedThread.scope === 'household' ||
            result.referencedThread.scope === 'family'
              ? 'family'
              : 'general',
          responseSource: 'local_companion',
        }
      : undefined,
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'life_thread_local',
      'handled by life-thread command layer',
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runMemoryCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const activation = handleMemoryActivationCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    text: input.canonicalText || input.text || '',
    conversationSummary: context.conversationSummary,
    replyText: context.replyText,
    factIdHint: context.factIdHint,
    now: context.now,
  });
  if (activation.handled) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: activation.responseText || 'Okay.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: 'memory_fact',
        summaryText: activation.responseText || descriptor.label,
        guidanceGoal: 'explainability',
        subjectData: {
          activeCapabilityId: descriptor.id,
          profileFactId: activation.referencedFactId,
        },
        supportedFollowups: descriptor.followupActions,
        responseSource: 'local_companion',
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'memory_local',
        'handled by memory activation layer',
      ),
      followupActions: descriptor.followupActions,
    };
  }
  const result = handlePersonalizationCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    text: input.canonicalText || input.text || '',
    conversationSummary: context.conversationSummary,
    replyText: context.replyText,
    factIdHint: context.factIdHint,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    personalizationResult: result,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'memory_fact',
      summaryText: result.responseText || descriptor.label,
      guidanceGoal: 'explainability',
      subjectData: {
        activeCapabilityId: descriptor.id,
        profileFactId: result.referencedFactId,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'memory_local',
      'handled by personalization layer',
    ),
  };
}

async function runRitualControlCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = handleRitualCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    text: input.canonicalText || input.text || '',
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorCompanionMode: context.priorCompanionContext?.mode,
    priorContext: context.priorCompanionContext
      ? {
          usedThreadIds: context.priorCompanionContext.usedThreadIds,
        }
      : null,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'handled by ritual control layer',
    ),
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.responseText || descriptor.label,
      guidanceGoal: 'explainability',
      subjectData: {
        activeCapabilityId: descriptor.id,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
  };
}

async function runRitualFollowthroughCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const canonicalText =
    input.canonicalText || input.text || 'what should I follow up on';
  const activation = await handleFollowThroughActivationCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    text: canonicalText,
    now: context.now,
    priorReviewJson: context.priorSubjectData?.followthroughReviewJson,
  });
  if (activation.handled) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        context.channel === 'alexa'
          ? activation.replyText
              .replace(/\s+-\s+/g, '. ')
              .replace(/\n+/g, ' ')
              .slice(0, 700)
          : activation.replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: 'general',
        summaryText:
          activation.selectedItem?.title ||
          'Follow-through candidates are ready for approval.',
        guidanceGoal: 'action_follow_through',
        subjectData: {
          activeCapabilityId: descriptor.id,
          followthroughReviewJson: activation.reviewSeedJson,
          lastAnswerSummary:
            activation.selectedItem?.whyItMatters ||
            'Andrea reviewed proposed follow-through candidates.',
          lastRecommendation:
            activation.selectedItem?.safeNextAction ||
            'Approve one candidate with timing when you want local tracking.',
          conversationFocus:
            activation.selectedItem?.title || 'follow-through approval',
        },
        supportedFollowups: descriptor.followupActions,
        responseSource: 'local_companion',
        hasActionItem: activation.outcomeKind !== 'reviewed',
        hasRiskSignal: activation.outcomeKind.startsWith('blocked'),
        reminderCandidate: true,
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'handled by follow-through activation layer',
        [
          `outcome: ${activation.outcomeKind}`,
          activation.selectedItem
            ? `item: ${activation.selectedItem.rank}`
            : 'review list',
        ],
      ),
      followupActions: descriptor.followupActions,
      outcomeMetadata: buildFollowThroughOutcomeMetadata({
        outcomeKind: activation.outcomeKind,
        handled: true,
        capabilityId: descriptor.id,
        item: activation.selectedItem,
        taskId: activation.taskId,
        agentOSEpisodeId: activation.agentOSEpisodeId,
      }),
    };
  }
  const dailyResponse = await buildDailyCompanionResponse(canonicalText, {
    channel: context.channel,
    groupFolder: context.groupFolder,
    tasks: getAllTasks().filter(
      (task) => task.group_folder === context.groupFolder,
    ),
    priorContext: context.priorCompanionContext || null,
    now: context.now,
  });
  const threadSnapshot = buildLifeThreadSnapshot({
    groupFolder: context.groupFolder,
    now: context.now,
  });
  const followthroughLines = (
    threadSnapshot.dueFollowups.length
      ? threadSnapshot.dueFollowups
      : threadSnapshot.recommendedNextThread
        ? [threadSnapshot.recommendedNextThread]
        : []
  )
    .slice(0, context.channel === 'telegram' ? 3 : 2)
    .map((thread) => thread.nextAction || thread.summary || thread.title)
    .filter((line): line is string => Boolean(line));

  if (dailyResponse) {
    const continuationCandidate = buildDailyContinuationCandidate(
      descriptor,
      dailyResponse,
    );
    const supportedFollowups = extendCompanionFollowups(
      dailyResponse.context.supportedFollowups,
      continuationCandidate,
    );
    const replyText =
      context.channel === 'alexa'
        ? dailyResponse.reply
        : [
            dailyResponse.reply,
            followthroughLines.length > 1
              ? '\nStill open right now:'
              : followthroughLines.length === 1
                ? '\nStill open right now:'
                : null,
            ...followthroughLines.map((line) => `- ${line}`),
          ]
            .filter(Boolean)
            .join('\n');
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      dailyResponse,
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: dailyResponse.context.subjectKind,
        summaryText: dailyResponse.context.summaryText,
        guidanceGoal: 'action_follow_through',
        subjectData: {
          ...dailyResponse.context.subjectData,
          activeCapabilityId: descriptor.id,
          threadId: dailyResponse.context.usedThreadIds?.[0],
          threadTitle: dailyResponse.context.usedThreadTitles?.[0],
          threadSummaryLines: dailyResponse.context.threadSummaryLines || [],
          lastAnswerSummary: dailyResponse.context.summaryText,
          lastRecommendation:
            dailyResponse.context.recommendationText || undefined,
          conversationFocus:
            dailyResponse.context.usedThreadTitles?.[0] ||
            dailyResponse.context.subjectKind,
          dailyCompanionContextJson: JSON.stringify(dailyResponse.context),
          companionContinuationJson: serializeCompanionContinuation(
            continuationCandidate,
          ),
        },
        supportedFollowups,
        responseSource: 'local_companion',
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'handled by ritual follow-through layer',
        followthroughLines.length
          ? [`follow-through: ${followthroughLines.join(' | ')}`]
          : [],
      ),
      followupActions: supportedFollowups,
      handoffPayload: continuationCandidate.handoffPayload,
      continuationCandidate,
    };
  }

  const fallbackText =
    followthroughLines.length === 0
      ? 'Nothing is standing out as an active follow-through risk right now.'
      : context.channel === 'alexa'
        ? followthroughLines[0]!
        : [
            'Follow-through right now:',
            ...followthroughLines.map((line) => `- ${line}`),
          ].join('\n');
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: fallbackText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'life_thread_local',
      'used life-thread follow-through snapshot',
    ),
  };
}

function isResearchExplainabilityTurn(query: string): boolean {
  return /^(why\b|why did you choose that route\b|why research mode\b|why did you use research mode\b|what path did you use\b|what capability are you using\b)/i.test(
    normalizeText(query),
  );
}

interface ResearchReplyFormattingOptions {
  followupMode?: 'default' | 'explicit_only';
}

const EXPLICIT_RESEARCH_FOLLOWUP_TEXT =
  'Ask explicitly for the next research action you want—for example, “compare the tradeoffs” or “make the research summary shorter.” While the calendar request is pending, a bare “yes” or “okay” is not a research follow-up.';

function formatResearchTelegramReply(
  result: ResearchResult,
  options: ResearchReplyFormattingOptions = {},
): string {
  const lines = [
    '*Research Summary*',
    result.summaryText || result.fullText || '',
  ];
  for (const section of result.structuredFindings) {
    if (!section.items.length) continue;
    lines.push('', `*${section.title}*`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }
  if (result.recommendationText) {
    lines.push('', '*Recommendation*', result.recommendationText);
  }
  if (result.supportingSources?.length) {
    lines.push('', '*Supporting Sources*');
    for (const source of result.supportingSources.slice(0, 4)) {
      const freshness = source.updatedAt
        ? `; updated ${source.updatedAt.slice(0, 10)}${source.freshness ? `, ${source.freshness}` : ''}`
        : '';
      const visibleCitation = source.url ? ` — ${source.url}` : '';
      lines.push(
        `- ${source.title}${visibleCitation}${source.matchReason ? ` (${source.matchReason}${freshness})` : freshness ? ` (${freshness.slice(2)})` : ''}`,
      );
    }
  }
  if (options.followupMode === 'explicit_only') {
    lines.push('', '*To continue research*', EXPLICIT_RESEARCH_FOLLOWUP_TEXT);
  } else if (result.followupSuggestions.length) {
    lines.push('', '*Next if useful*');
    for (const suggestion of result.followupSuggestions.slice(0, 2)) {
      lines.push(`- ${suggestion}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

function formatResearchBlueBubblesReply(
  result: ResearchResult,
  options: ResearchReplyFormattingOptions = {},
): string {
  const lines = [result.summaryText || result.fullText || ''];
  const firstSection = result.structuredFindings[0];
  if (firstSection?.items.length) {
    lines.push(...firstSection.items.slice(0, 2).map((item) => `- ${item}`));
  }
  if (result.supportingSources?.length) {
    lines.push(
      `Sources: ${result.supportingSources
        .slice(0, 2)
        .map((source) => {
          const visibleCitation = source.url ? ` — ${source.url}` : '';
          const freshness = source.updatedAt
            ? ` (${source.updatedAt.slice(0, 10)}${source.freshness ? `, ${source.freshness}` : ''})`
            : '';
          return `${source.title}${visibleCitation}${freshness}`;
        })
        .join(', ')}`,
    );
  }
  if (options.followupMode === 'explicit_only') {
    lines.push(EXPLICIT_RESEARCH_FOLLOWUP_TEXT);
  } else if (result.handoffOption) {
    lines.push('If you want, I can send the fuller version to Telegram.');
  } else if (result.followupSuggestions[0]) {
    lines.push(result.followupSuggestions[0]);
  }
  return lines.filter(Boolean).join('\n');
}

function formatResearchAlexaReply(
  result: ResearchResult,
  options: ResearchReplyFormattingOptions = {},
): {
  replyText: string;
  handoffOffer?: string;
} {
  const lead =
    result.spokenText || result.summaryText || result.fullText || 'Okay.';
  const followupPrompt =
    options.followupMode === 'explicit_only'
      ? ' To continue the research, ask explicitly for the next research action. While the calendar request is pending, a bare yes or okay is not a research follow-up.'
      : result.handoffOption && result.plan.kind === 'compare'
        ? ' Want the tradeoffs, or should I send the fuller version to Telegram?'
        : result.handoffOption
          ? ' I can send the fuller version to Telegram if you want.'
          : result.followupSuggestions[0]
            ? ` ${result.followupSuggestions[0]}`
            : '';
  return {
    replyText: `${lead}${followupPrompt}`.trim(),
    handoffOffer:
      options.followupMode !== 'explicit_only' && result.handoffOption
        ? 'I can send the fuller version to Telegram if you want.'
        : undefined,
  };
}

function buildResearchContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  query: string,
  result: ResearchResult,
  voice: ReturnType<typeof formatResearchAlexaReply>,
  telegramReply: string,
): CompanionContinuationCandidate {
  const followupSuggestions =
    result.followupSuggestions && result.followupSuggestions.length > 0
      ? result.followupSuggestions
      : ['save this to my library', 'send me the fuller version'];
  return {
    capabilityId: descriptor.id,
    voiceSummary:
      result.spokenText || result.summaryText || voice.replyText || query,
    handoffPayload: buildSignatureFlowPayload({
      title: descriptor.label,
      lead: result.summaryText || voice.replyText || query,
      bodyText: telegramReply,
      nextAction:
        result.recommendationText ||
        (followupSuggestions[0] ? `${followupSuggestions[0]}.` : undefined),
      whyLine: result.routeExplanation,
      followupSuggestions,
      sourceSummary: result.routeExplanation,
    }),
    completionText:
      result.saveForLaterCandidate ||
      result.recommendationText ||
      result.summaryText ||
      query,
    knowledgeSourceIds: (result.supportingSources || [])
      .map((source) => source.sourceId)
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
    knowledgeSourceTitles: (result.supportingSources || []).map(
      (source) => source.title,
    ),
    followupSuggestions,
  };
}

function buildMediaContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  prompt: string,
  mediaResult: MediaGenerationResult,
): CompanionContinuationCandidate {
  const normalizedPrompt = normalizeText(prompt);
  const summary =
    mediaResult.summaryText || mediaResult.replyText || normalizedPrompt;
  return {
    capabilityId: descriptor.id,
    voiceSummary: summary,
    handoffPayload: {
      kind: mediaResult.artifact ? 'artifact' : 'message',
      title: descriptor.label,
      text: mediaResult.replyText || summary,
      artifact: mediaResult.artifact,
      caption: mediaResult.replyText || summary,
      followupSuggestions: [],
    },
    completionText: normalizedPrompt,
    followupSuggestions: [],
  };
}

function dedupeSupportingSources(
  supportingSources: ResearchSupportingSource[] | undefined,
): ResearchSupportingSource[] {
  const unique = new Map<string, ResearchSupportingSource>();
  for (const source of supportingSources || []) {
    const key =
      source.sourceId ||
      `${source.title.toLowerCase()}:${(source.excerpt || '').toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, source);
    }
  }
  return [...unique.values()];
}

function describeKnowledgeMatches(
  supportingSources: ResearchSupportingSource[] | undefined,
): string[] {
  return dedupeSupportingSources(supportingSources)
    .slice(0, 4)
    .map((source) =>
      source.matchReason
        ? `${source.title}: ${source.matchReason}`
        : source.title,
    );
}

function summarizeKnowledgeSourceList(
  sources: KnowledgeSourceRecord[],
  hits?: ResearchSupportingSource[],
): {
  telegram: string;
  alexa: string;
  bluebubbles: string;
} {
  if (sources.length === 0) {
    return {
      telegram: 'I do not have any matching saved sources yet.',
      alexa: 'I do not have any matching saved sources yet.',
      bluebubbles: 'I do not have any matching saved sources yet.',
    };
  }

  const matchById = new Map(
    (hits || []).map((hit) => [
      hit.sourceId || `${hit.title}:${hit.excerpt}`,
      hit,
    ]),
  );
  const telegramLines = ['*Saved Sources*'];
  for (const source of sources.slice(0, 5)) {
    const hit = matchById.get(source.sourceId);
    telegramLines.push(
      `- *${source.title}*${hit?.matchReason ? ` (${hit.matchReason})` : ''}`,
    );
    telegramLines.push(
      `  ${source.shortSummary}${source.tags.length ? ` [tags: ${source.tags.join(', ')}]` : ''}`,
    );
  }

  const alexaLead =
    sources.length === 1
      ? `I found one saved source: ${sources[0]!.title}.`
      : `I found ${sources.length} saved sources. The strongest match is ${sources[0]!.title}.`;

  return {
    telegram: telegramLines.join('\n'),
    alexa: alexaLead,
    bluebubbles: [
      'Saved sources:',
      ...sources.slice(0, 3).map((source) => `- ${source.title}`),
    ].join('\n'),
  };
}

function extractKnowledgeExplainTopic(query: string): string {
  return normalizeText(query)
    .replace(
      /^(?:what sources are you using(?: about| for)?|explain why this source was chosen(?: about| for)?|show me the relevant saved items(?: about| for)?)\s*/i,
      '',
    )
    .trim();
}

function buildKnowledgeSourceExplainReply(
  channel: AssistantCapabilityContext['channel'],
  query: string,
  supportingSources: ResearchSupportingSource[],
): string {
  if (supportingSources.length === 0) {
    return 'I do not have any saved sources to ground that yet.';
  }

  const topic = extractKnowledgeExplainTopic(query);
  const reason =
    topic.length > 0
      ? `They were the strongest saved matches for "${topic}".`
      : 'They were the strongest saved matches in your library.';

  if (channel === 'alexa') {
    const names = supportingSources.slice(0, 3).map((source) => source.title);
    const joinedNames =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names[0]}, ${names[1]}, and ${names[2]}`;
    return `I would use ${joinedNames} because ${reason.toLowerCase()}`;
  }

  if (channel === 'bluebubbles') {
    return [
      'Sources I would use:',
      ...supportingSources
        .slice(0, 3)
        .map(
          (source) =>
            `- ${source.title}${source.matchReason ? ` (${source.matchReason})` : ''}`,
        ),
      `Why these sources: ${reason}`,
    ].join('\n');
  }

  return [
    '*Sources I would use*',
    ...supportingSources.slice(0, 4).map((source) => {
      const lines = [
        `- *${source.title}*${source.matchReason ? ` (${source.matchReason})` : ''}`,
      ];
      if (source.excerpt) {
        lines.push(`  ${source.excerpt}`);
      }
      return lines.join('\n');
    }),
    '',
    '*Why these sources*',
    reason,
  ].join('\n');
}

function inferKnowledgeRequestedSourceIds(
  query: string,
  context: AssistantCapabilityContext,
): string[] | undefined {
  const normalized = normalizeText(query).toLowerCase();
  if (
    context.priorSubjectData?.knowledgeSourceIds?.length &&
    (/^(this|that|these) source/.test(normalized) ||
      /\bthese saved sources\b/.test(normalized) ||
      /\bthat source\b/.test(normalized) ||
      /\b(?:this|that)\b.*\b(?:already saved|saved material|saved|library)\b/.test(
        normalized,
      ))
  ) {
    return context.priorSubjectData.knowledgeSourceIds;
  }
  return undefined;
}

function resolveResearchTraceSource(
  result: ResearchResult,
  context: AssistantCapabilityContext,
): AssistantCapabilityTrace['responseSource'] {
  if (
    result.providerUsed === 'openai_responses' ||
    result.providerUsed === 'brave_search_plus_openai' ||
    result.providerUsed === 'hybrid'
  ) {
    return result.handoffOption && context.channel === 'alexa'
      ? 'research_handoff'
      : 'research_openai';
  }
  if (
    result.providerUsed === 'brave_search_plus_minimax' ||
    result.providerUsed === 'minimax_anthropic'
  ) {
    return 'research_minimax';
  }
  return 'research_local';
}

async function runResearchCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const query = input.canonicalText || input.text || '';
  if (!query.trim()) return { handled: false };
  if (
    isResearchExplainabilityTurn(query) &&
    context.priorSubjectData?.researchRouteExplanation
  ) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        context.channel === 'alexa'
          ? context.priorSubjectData.researchRouteExplanation
          : [
              '*Why this route*',
              context.priorSubjectData.researchRouteExplanation,
              context.priorSubjectData.researchProviderUsed
                ? `Provider: ${context.priorSubjectData.researchProviderUsed}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: 'general',
        summaryText: context.priorSubjectData.researchRouteExplanation,
        guidanceGoal: 'explainability',
        subjectData: {
          ...context.priorSubjectData,
          activeCapabilityId: descriptor.id,
        },
        supportedFollowups: descriptor.followupActions,
        responseSource: 'local_companion',
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'research_local',
        'explained the active research route',
      ),
    };
  }
  const result = await runResearchOrchestrator({
    query,
    channel: context.channel === 'bluebubbles' ? 'telegram' : context.channel,
    groupFolder: context.groupFolder,
    now: context.now,
    conversationSummary: context.conversationSummary,
    preferBrief: context.channel === 'alexa',
    requestedDepth: input.researchDepth,
    allowWebSearch: input.allowWebSearch,
    personalContextMode: input.personalContextMode,
  });
  if (!result.handled) return { handled: false };
  const formattingOptions: ResearchReplyFormattingOptions = {
    followupMode: input.researchFollowupMode,
  };
  const voice = formatResearchAlexaReply(result, formattingOptions);
  const telegramReply = formatResearchTelegramReply(result, formattingOptions);
  const bluebubblesReply = formatResearchBlueBubblesReply(
    result,
    formattingOptions,
  );
  const continuationCandidate = buildResearchContinuationCandidate(
    descriptor,
    query,
    result,
    voice,
    telegramReply,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? voice.replyText
        : context.channel === 'bluebubbles'
          ? bluebubblesReply
          : telegramReply,
    outputShape:
      result.handoffOption && context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    researchResult: result,
    handoffOffer: voice.handoffOffer,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.summaryText || query,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary: result.summaryText || query,
        lastRecommendation: result.recommendationText,
        conversationFocus: query,
        researchHandoffEligible: Boolean(result.handoffOption),
        researchRouteExplanation: result.routeExplanation,
        researchProviderUsed: result.providerUsed,
        saveForLaterCandidate: result.saveForLaterCandidate,
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
      supportedFollowups,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      resolveResearchTraceSource(result, context),
      result.plan.reason,
      result.sourceNotes,
    ),
    followupActions: supportedFollowups,
  };
}

function parseKnowledgeTitle(text: string): string | undefined {
  const quoted =
    text.match(/\b(?:as|titled|called)\s+["“]([^"”]+)["”]/i)?.[1] ||
    text.match(/\b(?:as|titled|called)\s+([a-z0-9][a-z0-9'&: _-]{2,})$/i)?.[1];
  return quoted?.trim();
}

function parseKnowledgeExplicitTitle(text: string): string | undefined {
  return text
    .match(/\b(?:as|titled|called)\s+([^:\n]+):/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
}

function parseKnowledgeTags(text: string): string[] {
  const raw =
    text.match(/\btags?\s*[:=]\s*([a-z0-9, _-]+)/i)?.[1] ||
    text.match(/\btagged\s+([a-z0-9, _-]+)/i)?.[1];
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function parseKnowledgeFilePath(text: string): string | undefined {
  const quoted =
    text.match(
      /(?:save|add|import|index)\s+(?:the\s+)?(?:file|document)\s+["“]([^"”]+)["”]/i,
    )?.[1] ||
    text.match(
      /(?:save|add|import|index)\s+(?:the\s+)?(?:file|document)\s+([A-Za-z]:\\[^\n]+?)(?:\s+to my library|\s*$)/i,
    )?.[1];
  return quoted?.trim();
}

function resolveKnowledgeSourceType(
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): 'saved_research_result' | 'generated_note' | 'manual_reference' {
  const text = normalizeText(input.text || input.canonicalText);
  if (
    context.priorSubjectData?.activeCapabilityId?.startsWith('research.') ||
    /\bresearch\b/.test(text) ||
    context.priorSubjectData?.researchRouteExplanation
  ) {
    return 'saved_research_result';
  }
  if (context.replyText || context.priorSubjectData?.lastAnswerSummary) {
    return 'generated_note';
  }
  return 'manual_reference';
}

function pickKnowledgeSaveContent(
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): string {
  const text = input.text || input.canonicalText || '';
  const colonContent = text.includes(':')
    ? text.split(':').slice(1).join(':').trim()
    : '';
  if (colonContent) return colonContent;
  if (context.replyText?.trim()) return context.replyText.trim();
  if (context.priorSubjectData?.saveForLaterCandidate?.trim()) {
    return context.priorSubjectData.saveForLaterCandidate.trim();
  }
  if (context.priorSubjectData?.lastAnswerSummary?.trim()) {
    return context.priorSubjectData.lastAnswerSummary.trim();
  }
  return '';
}

function buildKnowledgeConversationSeed(
  descriptor: AssistantCapabilityDescriptor,
  summaryText: string,
  query: string,
  sourceIds: string[] = [],
  sourceTitles: string[] = [],
  sourceMatches: string[] = [],
): AssistantCapabilityConversationSeed {
  return {
    flowKey: descriptor.id.replace(/\./g, '_'),
    subjectKind: 'saved_item',
    summaryText,
    guidanceGoal: 'explainability',
    subjectData: {
      activeCapabilityId: descriptor.id,
      lastAnswerSummary: summaryText,
      conversationFocus: query,
      knowledgeSourceIds: sourceIds,
      knowledgeSourceTitles: sourceTitles,
      knowledgeSourceMatches: sourceMatches,
      knowledgeLastQuery: query,
    },
    supportedFollowups: descriptor.followupActions,
    responseSource: 'local_companion',
  };
}

function buildCommunicationContinuationCandidate(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  detailText: string;
  threadId?: string;
  threadTitle?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  messageActionId?: string;
  messageActionSummary?: string;
}): CompanionContinuationCandidate {
  const followupSuggestions = ['what should I say back', 'remind me later'];
  return {
    capabilityId: input.descriptor.id,
    voiceSummary: input.summaryText,
    handoffPayload: buildSignatureFlowPayload({
      title: input.descriptor.label,
      lead: input.summaryText,
      bodyText: input.detailText,
      nextAction: 'Draft the reply or remind yourself later.',
      whyLine: 'This uses the conversation you explicitly brought in here.',
      followupSuggestions,
      sourceSummary: 'Using the conversation you explicitly brought in here.',
    }),
    completionText: input.detailText,
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    communicationThreadId: input.communicationThreadId,
    communicationSubjectIds: input.communicationSubjectIds,
    communicationLifeThreadIds: input.communicationLifeThreadIds,
    lastCommunicationSummary: input.summaryText,
    followupSuggestions,
    messageActionId: input.messageActionId,
    messageActionSummary: input.messageActionSummary,
  };
}

function buildCommunicationConversationSeed(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  conversationFocus: string;
  personName?: string;
  threadId?: string;
  threadTitle?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  namedMessagesSummaryTargetJson?: string;
  messageActionId?: string;
  messageActionSummary?: string;
  recentTextReviewJson?: string;
  continuationCandidate?: CompanionContinuationCandidate;
  supportedFollowups?: AlexaConversationFollowupAction[];
}): AssistantCapabilityConversationSeed {
  return {
    flowKey: input.descriptor.id.replace(/\./g, '_'),
    subjectKind: 'communication_thread',
    summaryText: input.summaryText,
    guidanceGoal: 'action_follow_through',
    subjectData: {
      personName: input.personName,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      activeCapabilityId: input.descriptor.id,
      conversationFocus: input.conversationFocus,
      communicationThreadId: input.communicationThreadId,
      communicationSubjectIds: input.communicationSubjectIds,
      communicationLifeThreadIds: input.communicationLifeThreadIds,
      lastCommunicationSummary:
        input.lastCommunicationSummary || input.summaryText,
      namedMessagesSummaryTargetJson: input.namedMessagesSummaryTargetJson,
      recentTextReviewJson: input.recentTextReviewJson,
      messageActionId: input.messageActionId,
      messageActionSummary: input.messageActionSummary,
      companionContinuationJson: serializeCompanionContinuation(
        input.continuationCandidate,
      ),
    },
    supportedFollowups: input.supportedFollowups,
    responseSource: 'local_companion',
  };
}

function buildChiefOfStaffContinuationCandidate(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  detailText: string;
  chiefOfStaffContext: ChiefOfStaffContext;
  threadId?: string;
  threadTitle?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
}): CompanionContinuationCandidate {
  const followupSuggestions = [
    'why are you prioritizing that',
    'save that for later',
  ];
  return {
    capabilityId: input.descriptor.id,
    voiceSummary: input.summaryText,
    handoffPayload: buildSignatureFlowPayload({
      title: input.descriptor.label,
      lead: input.summaryText,
      bodyText: input.detailText,
      nextAction: input.chiefOfStaffContext.snapshot.bestNextAction,
      whyLine: buildSignatureSignalsWhyLine(
        input.chiefOfStaffContext.snapshot.signalsUsed,
      ),
      followupSuggestions,
      sourceSummary:
        input.chiefOfStaffContext.snapshot.signalsUsed.length > 0
          ? `Using ${input.chiefOfStaffContext.snapshot.signalsUsed.join(', ')}`
          : undefined,
    }),
    completionText:
      input.chiefOfStaffContext.snapshot.bestNextAction || input.summaryText,
    chiefOfStaffContextJson: JSON.stringify(input.chiefOfStaffContext),
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    communicationThreadId: input.communicationThreadId,
    communicationSubjectIds: input.communicationSubjectIds,
    communicationLifeThreadIds: input.communicationLifeThreadIds,
    followupSuggestions,
  };
}

function getChiefOfStaffGuidanceGoal(
  mode:
    | 'prioritize'
    | 'plan_horizon'
    | 'prepare'
    | 'decision_support'
    | 'explain'
    | 'configure',
): AlexaCompanionGuidanceGoal {
  switch (mode) {
    case 'prepare':
      return 'meeting_prep';
    case 'decision_support':
      return 'next_action';
    case 'explain':
      return 'explainability';
    case 'plan_horizon':
      return 'shared_plans';
    default:
      return 'what_matters_most';
  }
}

function buildChiefOfStaffConversationSeed(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  conversationFocus: string;
  chiefOfStaffContext: ChiefOfStaffContext;
  continuationCandidate?: CompanionContinuationCandidate;
  supportedFollowups?: AlexaConversationFollowupAction[];
}): AssistantCapabilityConversationSeed {
  return {
    flowKey: input.descriptor.id.replace(/\./g, '_'),
    subjectKind: 'general',
    summaryText: input.summaryText,
    guidanceGoal: getChiefOfStaffGuidanceGoal(input.chiefOfStaffContext.mode),
    subjectData: {
      activeCapabilityId: input.descriptor.id,
      conversationFocus: input.conversationFocus,
      lastAnswerSummary: input.summaryText,
      lastRecommendation:
        input.chiefOfStaffContext.snapshot.bestNextAction || undefined,
      chiefOfStaffContextJson: JSON.stringify(input.chiefOfStaffContext),
      companionContinuationJson: serializeCompanionContinuation(
        input.continuationCandidate,
      ),
      toneProfile: undefined,
    },
    supportedFollowups: input.supportedFollowups,
    responseSource: 'local_companion',
  };
}

function buildMissionContinuationCandidate(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  detailText: string;
  missionId: string;
  missionSummary: string;
  blockers: string[];
  suggestedActions: MissionSuggestedAction[];
  stepFocus?: MissionExecutionContext['stepFocus'];
  threadId?: string;
  threadTitle?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  knowledgeSourceIds?: string[];
  knowledgeSourceTitles?: string[];
}): CompanionContinuationCandidate {
  const nextAction =
    input.stepFocus?.title ||
    input.suggestedActions[0]?.label ||
    input.missionSummary;
  const followupSuggestions = [
    'send me the fuller plan',
    'remind me about that tonight',
    'save this plan',
  ];
  return {
    capabilityId: input.descriptor.id,
    voiceSummary: input.summaryText,
    handoffPayload: buildSignatureFlowPayload({
      title: input.descriptor.label,
      lead: input.summaryText,
      bodyText: input.detailText,
      nextAction,
      whyLine:
        input.blockers[0] ||
        'This is staying anchored to your current mission.',
      followupSuggestions,
      sourceSummary: 'Using your current mission context.',
    }),
    completionText: input.stepFocus?.title || input.missionSummary,
    missionId: input.missionId,
    missionSummary: input.missionSummary,
    missionSuggestedActionsJson: JSON.stringify(input.suggestedActions),
    missionBlockersJson: JSON.stringify(input.blockers),
    missionStepFocusJson: input.stepFocus
      ? JSON.stringify(input.stepFocus)
      : undefined,
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    communicationThreadId: input.communicationThreadId,
    communicationSubjectIds: input.communicationSubjectIds,
    communicationLifeThreadIds: input.communicationLifeThreadIds,
    knowledgeSourceIds: input.knowledgeSourceIds,
    knowledgeSourceTitles: input.knowledgeSourceTitles,
    followupSuggestions,
  };
}

function buildMissionConversationSeed(input: {
  descriptor: AssistantCapabilityDescriptor;
  summaryText: string;
  conversationFocus: string;
  continuationCandidate?: CompanionContinuationCandidate;
  supportedFollowups?: AlexaConversationFollowupAction[];
}): AssistantCapabilityConversationSeed {
  return {
    flowKey: input.descriptor.id.replace(/\./g, '_'),
    subjectKind: 'mission',
    summaryText: input.summaryText,
    guidanceGoal: 'shared_plans',
    subjectData: {
      activeCapabilityId: input.descriptor.id,
      conversationFocus: input.conversationFocus,
      lastAnswerSummary: input.summaryText,
      missionId: input.continuationCandidate?.missionId,
      missionSummary: input.continuationCandidate?.missionSummary,
      missionSuggestedActionsJson:
        input.continuationCandidate?.missionSuggestedActionsJson,
      missionBlockersJson: input.continuationCandidate?.missionBlockersJson,
      missionStepFocusJson: input.continuationCandidate?.missionStepFocusJson,
      communicationThreadId: input.continuationCandidate?.communicationThreadId,
      communicationSubjectIds:
        input.continuationCandidate?.communicationSubjectIds,
      communicationLifeThreadIds:
        input.continuationCandidate?.communicationLifeThreadIds,
      chiefOfStaffContextJson:
        input.continuationCandidate?.chiefOfStaffContextJson,
      companionContinuationJson: serializeCompanionContinuation(
        input.continuationCandidate,
      ),
    },
    supportedFollowups: input.supportedFollowups,
    responseSource: 'local_companion',
  };
}

async function runKnowledgeSaveCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };

  const raw = input.canonicalText || input.text || '';
  const filePath = parseKnowledgeFilePath(raw);
  const title = parseKnowledgeExplicitTitle(raw) || parseKnowledgeTitle(raw);
  const tags = parseKnowledgeTags(raw);
  const result = filePath
    ? importKnowledgeFile({
        groupFolder: context.groupFolder,
        filePath,
        title,
        tags,
        sourceChannel: context.channel === 'alexa' ? 'alexa' : context.channel,
      })
    : saveKnowledgeSource({
        groupFolder: context.groupFolder,
        title,
        content: pickKnowledgeSaveContent(context, input),
        sourceType: resolveKnowledgeSourceType(context, input),
        tags,
        sourceChannel: context.channel === 'alexa' ? 'alexa' : context.channel,
      });

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.message,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      result.message,
      raw || result.message,
      result.source ? [result.source.sourceId] : [],
      result.source ? [result.source.title] : [],
      result.source ? [result.source.title] : [],
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      result.ok
        ? 'saved an explicit library source'
        : 'library save failed cleanly',
      result.debugPath,
    ),
  };
}

function buildKnowledgeSourcesReply(
  channel: AssistantCapabilityContext['channel'],
  sources: KnowledgeSourceRecord[],
  supportingSources?: ResearchSupportingSource[],
): string {
  const formatted = summarizeKnowledgeSourceList(sources, supportingSources);
  if (channel === 'alexa') return formatted.alexa;
  if (channel === 'bluebubbles') return formatted.bluebubbles;
  return formatted.telegram;
}

async function runKnowledgeListCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const query = input.canonicalText || input.text || '';
  const search = searchKnowledgeLibrary({
    groupFolder: context.groupFolder,
    query,
    requestedSourceIds: inferKnowledgeRequestedSourceIds(query, context),
    limit: context.channel === 'alexa' ? 3 : 5,
  });
  const replyText = buildKnowledgeSourcesReply(
    context.channel,
    search.sources,
    search.hits.map((hit) => ({
      origin: 'knowledge_library',
      title: hit.sourceTitle,
      sourceId: hit.sourceId,
      sourceType: hit.sourceType,
      scope: hit.scope,
      excerpt: hit.excerpt,
      retrievalScore: hit.retrievalScore,
      matchReason: hit.matchReason,
    })),
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      search.sources.length
        ? `Found ${search.sources.length} saved sources.`
        : 'No matching saved sources yet.',
      query,
      search.sources.map((source) => source.sourceId),
      search.sources.map((source) => source.title),
      search.hits.map((hit) => `${hit.sourceTitle}: ${hit.matchReason}`),
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      'listed relevant saved sources from the knowledge library',
      search.debugPath,
    ),
  };
}

async function runKnowledgeResearchCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const query =
    input.canonicalText ||
    input.text ||
    context.priorSubjectData?.knowledgeLastQuery ||
    '';
  if (!query.trim()) return { handled: false };

  if (
    descriptor.id === 'knowledge.explain_sources' &&
    context.priorSubjectData?.knowledgeSourceMatches?.length
  ) {
    const replyText =
      context.channel === 'alexa'
        ? `I used ${context.priorSubjectData.knowledgeSourceTitles?.slice(0, 2).join(' and ')} because they were the strongest saved matches.`
        : [
            '*Sources used*',
            ...context.priorSubjectData.knowledgeSourceMatches.map(
              (match) => `- ${match}`,
            ),
          ].join('\n');
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildKnowledgeConversationSeed(
        descriptor,
        context.priorSubjectData.lastAnswerSummary ||
          'Saved source explanation',
        query,
        context.priorSubjectData.knowledgeSourceIds || [],
        context.priorSubjectData.knowledgeSourceTitles || [],
        context.priorSubjectData.knowledgeSourceMatches || [],
      ),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        'explained the saved sources used in the active answer',
      ),
    };
  }

  if (descriptor.id === 'knowledge.explain_sources') {
    if (!context.groupFolder) return { handled: false };
    const topicQuery = extractKnowledgeTopicQuery(query);
    if (!topicQuery.trim()) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'Ask that about a saved topic, or right after a saved-material answer.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'knowledge_library',
          'source explanation requested without a specific saved topic',
        ),
      };
    }

    const search = searchKnowledgeLibrary({
      groupFolder: context.groupFolder,
      query: topicQuery,
      requestedSourceIds: inferKnowledgeRequestedSourceIds(query, context),
      limit: context.channel === 'alexa' ? 2 : 4,
    });
    const supportingSources = dedupeSupportingSources(
      search.hits.map((hit) => ({
        origin: 'knowledge_library' as const,
        title: hit.sourceTitle,
        sourceId: hit.sourceId,
        sourceType: hit.sourceType,
        scope: hit.scope,
        excerpt: hit.excerpt,
        retrievalScore: hit.retrievalScore,
        matchReason: hit.matchReason,
      })),
    );

    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: buildKnowledgeSourceExplainReply(
        context.channel,
        query,
        supportingSources,
      ),
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildKnowledgeConversationSeed(
        descriptor,
        supportingSources.length
          ? `Explained the saved sources for ${topicQuery}.`
          : 'No saved sources matched that topic yet.',
        topicQuery,
        supportingSources
          .map((source) => source.sourceId)
          .filter((sourceId): sourceId is string => Boolean(sourceId)),
        supportingSources.map((source) => source.title),
        describeKnowledgeMatches(supportingSources),
      ),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        supportingSources.length
          ? 'explained which saved sources matched the requested topic'
          : 'no saved sources matched the requested topic',
        search.debugPath,
      ),
    };
  }

  const savedMaterialMode = /\bcombine my notes with outside research\b/i.test(
    query,
  )
    ? 'combine'
    : 'only';
  const requestedSourceIds = inferKnowledgeRequestedSourceIds(query, context);
  const researchResult = await runResearchOrchestrator({
    query,
    channel: context.channel === 'bluebubbles' ? 'telegram' : context.channel,
    groupFolder: context.groupFolder,
    now: context.now,
    conversationSummary: context.conversationSummary,
    preferBrief: context.channel === 'alexa',
    savedMaterialMode,
    requestedSourceIds,
    requestedDepth: input.researchDepth,
    allowWebSearch: input.allowWebSearch,
    personalContextMode: input.personalContextMode,
  });
  if (!researchResult.handled) return { handled: false };

  const voice = formatResearchAlexaReply(researchResult);
  const supportingSourceIds = (researchResult.supportingSources || [])
    .map((source) => source.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  const supportingSourceTitles = (researchResult.supportingSources || []).map(
    (source) => source.title,
  );
  const knowledgeMatches = describeKnowledgeMatches(
    researchResult.supportingSources,
  );
  const telegramReply = formatResearchTelegramReply(researchResult);
  const continuationCandidate = buildResearchContinuationCandidate(
    descriptor,
    query,
    researchResult,
    voice,
    telegramReply,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );
  const conversationSeed = buildKnowledgeConversationSeed(
    descriptor,
    researchResult.summaryText || query,
    query,
    supportingSourceIds,
    supportingSourceTitles,
    knowledgeMatches,
  );
  conversationSeed.subjectData = {
    ...(conversationSeed.subjectData || {}),
    companionContinuationJson: serializeCompanionContinuation(
      continuationCandidate,
    ),
  };
  conversationSeed.supportedFollowups = supportedFollowups;

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? voice.replyText
        : context.channel === 'bluebubbles'
          ? formatResearchBlueBubblesReply(researchResult)
          : telegramReply,
    outputShape:
      researchResult.handoffOption && context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    researchResult,
    handoffOffer: voice.handoffOffer,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed,
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      researchResult.routeExplanation,
      researchResult.debugPath,
    ),
    followupActions: supportedFollowups,
  };
}

async function runKnowledgeMutationCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const query = input.canonicalText || input.text || '';
  const selection = resolveKnowledgeSourceSelection({
    groupFolder: context.groupFolder,
    text: query,
    priorSourceIds: context.priorSubjectData?.knowledgeSourceIds,
  });
  const target = selection.sources[0];
  if (!target) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: 'I could not find a matching saved source for that.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        'no matching saved source was available for the requested mutation',
        selection.debugPath,
      ),
    };
  }

  const mutationResult =
    descriptor.id === 'knowledge.disable_source'
      ? disableKnowledgeSourceById(target.sourceId)
      : descriptor.id === 'knowledge.delete_source'
        ? deleteKnowledgeSourceById(target.sourceId)
        : reindexKnowledgeSourceById(target.sourceId);
  const mutationDebugPath: string[] =
    descriptor.id === 'knowledge.reindex_source' &&
    'debugPath' in mutationResult
      ? (mutationResult.debugPath as string[])
      : selection.debugPath;

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: mutationResult.message,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      mutationResult.message,
      query,
      [target.sourceId],
      [target.title],
      [target.title],
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      descriptor.id === 'knowledge.reindex_source'
        ? 'reindexed a saved knowledge source'
        : descriptor.id === 'knowledge.delete_source'
          ? 'deleted a saved knowledge source'
          : 'disabled a saved knowledge source',
      mutationDebugPath,
    ),
  };
}

function resolveThreadSummaryWindow(params: {
  now: Date;
  kind: CompanionRouteTimeWindowKind | null | undefined;
  value: number | null | undefined;
}): { startTimestamp: string; endTimestamp: string | null; label: string } {
  const start = new Date(params.now);
  let end: Date | null = null;
  switch (params.kind) {
    case 'last_hours':
      start.setHours(start.getHours() - Math.max(1, params.value || 1));
      break;
    case 'last_days':
      start.setDate(start.getDate() - Math.max(1, params.value || 1));
      break;
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      end = new Date(start);
      end.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      break;
    case 'this_week': {
      const day = start.getDay();
      const offset = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - offset);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'default_24h':
    default:
      start.setHours(start.getHours() - 24);
      break;
  }
  return {
    startTimestamp: start.toISOString(),
    endTimestamp: end ? end.toISOString() : null,
    label: formatThreadSummaryWindowLabel(params.kind, params.value),
  };
}

function looksLikeRawParticipantIdentifier(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  if (/(?:^|\s)bb[:;]/i.test(normalized)) return true;
  if (/(?:^|\s)(?:iMessage|SMS);[+-];/i.test(normalized)) return true;
  if (/(?:^|\s)[^@\s]+@[^@\s]+\.[^@\s]+(?:$|\s)/.test(normalized)) {
    return true;
  }
  const digits = normalized.replace(/\D/g, '');
  if (/^[+\d\s().-]+$/.test(normalized) && digits.length >= 3) return true;
  return digits.length >= 7;
}

function clipThreadSummaryEvidence(
  value: string | null | undefined,
  maxLength: number,
): string {
  const redacted = redactRecentTextReviewText(value || '');
  if (!redacted || redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatThreadSummaryTranscriptTimestamp(
  value: string | null | undefined,
): string {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

function getThreadSummarySpeakerKey(message: NewMessage): string {
  if (message.is_from_me) {
    return '__you__';
  }
  return (
    normalizeText(message.sender_name || message.sender || '') || '__unknown__'
  );
}

function buildThreadSummarySpeakerLabels(params: {
  messages: NewMessage[];
  isGroup: boolean;
}): Map<string, string> {
  const labels = new Map<string, string>();
  let unlabeledIndex = 0;
  const groupFallbackLabels = [
    'One person',
    'Another person',
    'A third person',
    'Someone else',
  ];
  for (const message of params.messages) {
    const key = getThreadSummarySpeakerKey(message);
    if (!key || labels.has(key)) continue;
    if (message.is_from_me) {
      labels.set(key, 'You');
      continue;
    }
    const preferredName = normalizeText(message.sender_name || '');
    const secondaryName = normalizeText(message.sender || '');
    const friendlyName = [preferredName, secondaryName].find(
      (candidate) => candidate && !looksLikeRawParticipantIdentifier(candidate),
    );
    if (friendlyName) {
      labels.set(key, friendlyName);
      continue;
    }
    if (!params.isGroup) {
      labels.set(key, 'The other person');
      continue;
    }
    const fallbackLabel =
      groupFallbackLabels[unlabeledIndex] || `Person ${unlabeledIndex + 1}`;
    unlabeledIndex += 1;
    labels.set(key, fallbackLabel);
  }
  return labels;
}

function extractThreadSummaryPlanFacts(params: {
  messages: NewMessage[];
  speakerLabels: Map<string, string>;
  isGroup: boolean;
  directOtherLabel?: string | null;
}): GroundedMessagesPlanFact[] {
  const directOtherLabel =
    normalizeText(params.directOtherLabel || '') ||
    params.messages
      .filter((message) => !message.is_from_me)
      .map((message) =>
        params.speakerLabels.get(getThreadSummarySpeakerKey(message)),
      )
      .find(Boolean) ||
    'The other person';
  return extractGroundedMessagesPlanFacts({
    messages: params.messages,
    getSpeakerLabel: (message) =>
      params.speakerLabels.get(getThreadSummarySpeakerKey(message)) ||
      (message.is_from_me ? 'You' : directOtherLabel),
    getSecondPersonLabel: params.isGroup
      ? undefined
      : (message) => (message.is_from_me ? directOtherLabel : 'You'),
  });
}

function formatThreadSummaryPlanSection(params: {
  facts: GroundedMessagesPlanFact[];
  limit: number;
}): string {
  const lines = params.facts
    .slice(-params.limit)
    .map((fact) => `- ${formatGroundedMessagesPlanFact(fact)}`);
  return [
    'Commitments and decisions',
    ...(lines.length > 0
      ? lines
      : [
          '- No explicit commitments, decisions, or pending proposals were found in this bounded snapshot.',
        ]),
  ].join('\n');
}

function buildThreadSummaryTranscript(params: {
  messages: NewMessage[];
  speakerLabels: Map<string, string>;
}): string {
  return params.messages
    .slice(-120)
    .map((message) => {
      const speaker =
        params.speakerLabels.get(getThreadSummarySpeakerKey(message)) ||
        'Someone';
      return `[${formatThreadSummaryTranscriptTimestamp(message.timestamp)}] ${clipThreadSummaryEvidence(speaker, 72)}: ${clipThreadSummaryEvidence(message.content, 240)}`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildLocalThreadSummarySuggestedReplies(
  messages: NewMessage[],
): BlueBubblesSuggestedReply[] {
  let latestInboundIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !message.is_from_me && !message.is_bot_message) {
      latestInboundIndex = index;
      break;
    }
  }
  const latestInbound = messages[latestInboundIndex];
  if (!latestInbound) return [];
  if (isBlueBubblesReactionPlaceholder(latestInbound.content)) return [];
  if (
    messages.slice(latestInboundIndex + 1).some((message) => message.is_from_me)
  ) {
    return [];
  }
  const content = clipPreservedText(
    latestInbound.content,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    !content ||
    content.length < 8 ||
    /\?|\b(?:can you|could you|would you|will you|do you|did you|are you|were you|should we|should i|do you want|let me know|lmk|need you to|please\s+(?:send|share|confirm|call|bring|reply|tell)|send me|share with me|tell me|confirm)\b/i.test(
      content,
    ) ||
    /^(?:ok(?:ay)?|thanks(?: so much)?|thank you|thx|got it|sounds good|perfect|great|cool|nice|no worries|you(?:'re| are) welcome|lol|haha)[!. ]*$/i.test(
      content,
    ) ||
    closesAllSyncedMessagesOpenRequest(latestInbound) ||
    isAllSyncedMessagesAutomatedNoise(latestInbound) ||
    isAutomatedRecentTextNotice(latestInbound.content || '')
  ) {
    return [];
  }
  return [
    {
      label: 'warm',
      text: 'Thanks for the update.',
    },
    {
      label: 'brief',
      text: 'Got it.',
    },
  ];
}

function pickRepresentativeThreadMessages(
  messages: NewMessage[],
): NewMessage[] {
  if (messages.length <= 4) return [...messages];
  const selected = new Set<number>([0, messages.length - 1]);
  const salientIndexes = messages
    .map((message, index) => ({
      index,
      text: normalizeText(message.content || ''),
    }))
    .filter(({ text }) =>
      /\?|\b(?:yes|no|done|confirmed|decided|booked|scheduled|cancelled|canceled|never mind|all set|instead|change of plans)\b|\[Attached:|\[(?:Reacted with|Removed .* reaction)\]/i.test(
        text,
      ),
    )
    .map(({ index }) => index);
  for (const index of salientIndexes.reverse()) {
    selected.add(index);
    if (selected.size >= 4) break;
  }
  for (const index of [
    Math.floor(messages.length / 3),
    Math.floor((messages.length * 2) / 3),
  ]) {
    if (selected.size >= 4) break;
    selected.add(index);
  }
  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => messages[index])
    .filter((message): message is NewMessage => Boolean(message));
}

function inferThreadReplyNeed(messages: NewMessage[]): string | null {
  let latestInboundIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !message.is_from_me && !message.is_bot_message) {
      latestInboundIndex = index;
      break;
    }
  }
  const latestInbound = messages[latestInboundIndex];
  if (!latestInbound) return null;
  if (
    messages.slice(latestInboundIndex + 1).some((message) => message.is_from_me)
  ) {
    return null;
  }
  const content = redactRecentTextReviewText(
    latestInbound.content || '',
  ).toLowerCase();
  if (
    /\?/.test(content) ||
    /\b(?:can you|could you|would you|will you|do you|did you|are you|were you|should we|should i|do you want|let me know|lmk|need you to|please\s+(?:send|share|confirm|call|bring|reply|tell)|send me|share with me|tell me|confirm)\b/.test(
      content,
    )
  ) {
    return `The latest open ask looks like: "${clipThreadSummaryEvidence(latestInbound.content, 180)}".`;
  }
  return null;
}

function buildFallbackThreadSummaryReply(params: {
  chatName: string;
  windowLabel: string;
  messages: NewMessage[];
  speakerLabels: Map<string, string>;
  channel: AssistantCapabilityContext['channel'];
}): string {
  const highlights = pickRepresentativeThreadMessages(params.messages);
  const selectHighlightsIncludingLatest = (limit: number): NewMessage[] => {
    if (highlights.length <= limit) return highlights;
    return [
      ...highlights.slice(0, Math.max(0, limit - 1)),
      highlights.at(-1),
    ].filter((message): message is NewMessage => Boolean(message));
  };
  const digestHighlights = selectHighlightsIncludingLatest(
    params.channel === 'bluebubbles' ? 2 : 3,
  );
  const bulletHighlights = selectHighlightsIncludingLatest(
    params.channel === 'bluebubbles' ? 2 : 4,
  );
  const replyNeed = inferThreadReplyNeed(params.messages);
  const lead = `Here’s the gist from ${params.chatName} ${params.windowLabel === 'today' ? 'today' : `over ${params.windowLabel}`}.`;
  const digestSentences = digestHighlights.map((message, index) => {
    const speaker =
      params.speakerLabels.get(getThreadSummarySpeakerKey(message)) ||
      'Someone';
    const content = clipThreadSummaryEvidence(
      message.content,
      params.channel === 'bluebubbles' ? 90 : 140,
    );
    if (index === 0) {
      return `${clipThreadSummaryEvidence(speaker, 72)} opened with "${content}".`;
    }
    if (index === digestHighlights.length - 1) {
      return `By the end, ${clipThreadSummaryEvidence(speaker, 72)} was saying "${content}".`;
    }
    return `Later, ${clipThreadSummaryEvidence(speaker, 72)} added "${content}".`;
  });
  const latestHighlightId = highlights.at(-1)?.id;
  const bullets = bulletHighlights
    .map((message, index) => {
      const speaker =
        params.speakerLabels.get(getThreadSummarySpeakerKey(message)) ||
        'Someone';
      const prefix =
        index === 0
          ? 'Early on'
          : message.id === latestHighlightId
            ? 'Latest turn'
            : 'Later';
      return `${prefix}: ${clipThreadSummaryEvidence(speaker, 72)} said "${clipThreadSummaryEvidence(message.content, 120)}".`;
    })
    .slice(0, params.channel === 'bluebubbles' ? 2 : 4);
  if (replyNeed) {
    bullets.push(replyNeed);
  }
  const suggestedReplies = buildLocalThreadSummarySuggestedReplies(
    params.messages,
  );
  const suggestedReplyLines =
    suggestedReplies.length > 0
      ? [
          'Suggested replies (unsent; review before using)',
          ...suggestedReplies.map(
            (reply) =>
              `- ${clipText(reply.label, 32)}: "${clipThreadSummaryEvidence(reply.text, 180)}"`,
          ),
        ]
      : [];

  if (params.channel === 'bluebubbles') {
    return [
      lead,
      digestSentences.slice(0, 2).join(' '),
      ...bullets.slice(0, 2),
      suggestedReplyLines.length > 0 ? suggestedReplyLines.join('\n') : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    lead,
    '',
    digestSentences.join(' '),
    '',
    ...bullets.map((line) => `- ${line}`),
    suggestedReplyLines.length > 0 ? '' : null,
    suggestedReplyLines.length > 0 ? suggestedReplyLines.join('\n') : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatThreadSummaryReply(params: {
  lead: string | null;
  digest: string | null;
  bullets: string[];
  suggestedReplies?: BlueBubblesSuggestedReply[];
  channel: AssistantCapabilityContext['channel'];
}): string {
  const suggestedReplies = params.suggestedReplies || [];
  const suggestedReplyLines =
    suggestedReplies.length > 0
      ? [
          'Suggested replies (unsent; review before using)',
          ...suggestedReplies
            .slice(0, 3)
            .map(
              (reply) =>
                `- ${clipText(reply.label, 32)}: "${clipThreadSummaryEvidence(reply.text, 180)}"`,
            ),
        ]
      : [];
  if (params.channel === 'bluebubbles') {
    return [
      params.lead ? clipThreadSummaryEvidence(params.lead, 520) : null,
      params.digest ? clipThreadSummaryEvidence(params.digest, 520) : null,
      ...params.bullets
        .slice(0, 2)
        .map((line) => `- ${clipThreadSummaryEvidence(line, 180)}`),
      suggestedReplyLines.length > 0 ? suggestedReplyLines.join('\n') : null,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return [
    params.lead ? clipThreadSummaryEvidence(params.lead, 760) : null,
    '',
    params.digest ? clipThreadSummaryEvidence(params.digest, 1_200) : null,
    '',
    ...params.bullets
      .slice(0, 6)
      .map((line) => `- ${clipThreadSummaryEvidence(line, 260)}`),
    suggestedReplyLines.length > 0 ? '' : null,
    suggestedReplyLines.length > 0 ? suggestedReplyLines.join('\n') : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatSafeSyncedThreadLabel(params: {
  name?: string | null;
  jid: string;
  isGroup?: boolean | null;
}): string {
  const normalized = normalizeText(params.name || '');
  const looksLikePrivateIdentifier =
    looksLikeRawParticipantIdentifier(normalized);
  if (normalized && normalized !== params.jid && !looksLikePrivateIdentifier) {
    return clipText(normalized, 64);
  }
  return params.isGroup ? 'Messages group' : 'Messages chat';
}

interface NamedMessagesSummaryTargetSeedV2 {
  version: 2;
  query: string;
  target: {
    chatJid: string;
    displayName: string;
    isGroup: boolean;
  };
  historyStartTimestamp: string;
  freshnessSnapshot: MessageActionNamedMessagesSummaryLink['freshnessSnapshot'];
}

function requireMessagesSummaryFreshnessSnapshot(
  snapshot: RecentTextReviewFreshnessSnapshot,
): MessageActionNamedMessagesSummaryLink['freshnessSnapshot'] | null {
  if (
    !/^[a-f0-9]{16}$/i.test(snapshot.latestMessageIdentityHash || '') ||
    !snapshot.latestMessageAt ||
    !Number.isFinite(Date.parse(snapshot.latestMessageAt)) ||
    !Number.isInteger(snapshot.messageCount) ||
    !snapshot.messageCount ||
    snapshot.messageCount < 1 ||
    !/^[a-f0-9]{16}$/i.test(snapshot.snapshotHash || '') ||
    !/^[a-f0-9]{16}$/i.test(snapshot.transcriptHash || '')
  ) {
    return null;
  }
  return {
    latestMessageIdentityHash: snapshot.latestMessageIdentityHash!,
    latestMessageAt: snapshot.latestMessageAt,
    latestInboundAt: snapshot.latestInboundAt || null,
    latestOutboundAt: snapshot.latestOutboundAt || null,
    messageCount: snapshot.messageCount,
    snapshotHash: snapshot.snapshotHash!,
    transcriptHash: snapshot.transcriptHash!,
  };
}

function fingerprintNamedMessagesSummaryValue(
  domain: string,
  value: string,
): string {
  return createHash('sha256')
    .update(`${domain}\u0000${value}`, 'utf8')
    .digest('hex');
}

function buildNamedMessagesSummaryActionLink(input: {
  validation: Extract<
    NamedMessagesSummaryTargetValidation,
    { state: 'resolved' }
  >;
  groupFolder: string;
  presentationChatJid: string;
}): MessageActionNamedMessagesSummaryLink {
  const base: Omit<MessageActionNamedMessagesSummaryLink, 'linkFingerprint'> = {
    version: 1,
    queryFingerprint: fingerprintNamedMessagesSummaryValue(
      'named-messages-summary-query',
      input.validation.seed.query,
    ),
    historyStartTimestamp: input.validation.seed.historyStartTimestamp,
    freshnessSnapshot: input.validation.seed.freshnessSnapshot,
    targetChatFingerprint: fingerprintNamedMessagesSummaryValue(
      'named-messages-summary-target-chat',
      input.validation.target.chatJid,
    ),
    presentationScopeFingerprint: fingerprintNamedMessagesSummaryValue(
      'named-messages-summary-presentation-scope',
      `${input.groupFolder}\u0000${input.presentationChatJid}`,
    ),
  };
  return {
    ...base,
    linkFingerprint: fingerprintNamedMessagesSummaryValue(
      'message-action-named-messages-summary-link',
      [
        base.version,
        base.queryFingerprint,
        base.historyStartTimestamp,
        base.freshnessSnapshot.latestMessageIdentityHash,
        base.freshnessSnapshot.latestMessageAt,
        base.freshnessSnapshot.latestInboundAt || '',
        base.freshnessSnapshot.latestOutboundAt || '',
        base.freshnessSnapshot.messageCount,
        base.freshnessSnapshot.snapshotHash,
        base.freshnessSnapshot.transcriptHash,
        base.targetChatFingerprint,
        base.presentationScopeFingerprint,
      ].join('\u0000'),
    ),
  };
}

function buildRecentTextReviewDraftActionLink(input: {
  seedJson: string;
  itemId: string;
  itemRank: number;
  communicationThreadId: string;
  targetChatJid: string;
  groupFolder: string;
  presentationChatJid: string;
}): MessageActionRecentTextReviewLink | null {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  const item = seed?.items.find(
    (candidate) =>
      candidate.itemId === input.itemId &&
      candidate.rank === input.itemRank &&
      candidate.communicationThreadId === input.communicationThreadId,
  );
  const freshnessSnapshot = item?.freshnessSnapshot
    ? requireMessagesSummaryFreshnessSnapshot(item.freshnessSnapshot)
    : null;
  if (
    !seed?.reviewedAt ||
    !seed.windowStartTimestamp ||
    !item ||
    !freshnessSnapshot
  ) {
    return null;
  }
  const base: Omit<MessageActionRecentTextReviewLink, 'linkFingerprint'> = {
    version: 2,
    seedFingerprint: fingerprintNamedMessagesSummaryValue(
      'recent-text-review-seed',
      input.seedJson,
    ),
    reviewedAt: seed.reviewedAt,
    itemId: input.itemId,
    itemRank: input.itemRank,
    communicationThreadId: input.communicationThreadId,
    historyStartTimestamp: seed.windowStartTimestamp,
    freshnessSnapshot,
    targetChatFingerprint: fingerprintNamedMessagesSummaryValue(
      'recent-text-review-target-chat',
      input.targetChatJid,
    ),
    presentationScopeFingerprint: fingerprintNamedMessagesSummaryValue(
      'recent-text-review-presentation-scope',
      `${input.groupFolder}\u0000${input.presentationChatJid}`,
    ),
  };
  return {
    ...base,
    linkFingerprint: fingerprintNamedMessagesSummaryValue(
      'message-action-recent-text-review-link',
      [
        base.version,
        base.seedFingerprint,
        base.reviewedAt,
        base.itemId,
        base.itemRank,
        base.communicationThreadId,
        base.historyStartTimestamp,
        base.freshnessSnapshot.latestMessageIdentityHash,
        base.freshnessSnapshot.latestMessageAt,
        base.freshnessSnapshot.latestInboundAt || '',
        base.freshnessSnapshot.latestOutboundAt || '',
        base.freshnessSnapshot.messageCount,
        base.freshnessSnapshot.snapshotHash,
        base.freshnessSnapshot.transcriptHash,
        base.targetChatFingerprint,
        base.presentationScopeFingerprint,
      ].join('\u0000'),
    ),
  };
}

type NamedMessagesSummaryTargetValidation =
  | {
      state: 'resolved';
      target: ResolvedBlueBubblesThreadTarget;
      seedJson: string;
      seed: NamedMessagesSummaryTargetSeedV2;
    }
  | {
      state:
        | 'missing_seed'
        | 'invalid_seed'
        | 'missing'
        | 'ambiguous'
        | 'changed'
        | 'presentation_conflict';
      detail: string;
    };

function buildNamedMessagesSummaryTargetSeedJson(input: {
  query: string;
  target: ResolvedBlueBubblesThreadTarget;
  historyStartTimestamp: string;
  freshnessSnapshot: MessageActionNamedMessagesSummaryLink['freshnessSnapshot'];
}): string {
  return JSON.stringify({
    version: 2,
    query: input.query,
    target: {
      chatJid: input.target.chatJid,
      displayName: input.target.displayName,
      isGroup: input.target.isGroup,
    },
    historyStartTimestamp: input.historyStartTimestamp,
    freshnessSnapshot: input.freshnessSnapshot,
  } satisfies NamedMessagesSummaryTargetSeedV2);
}

function parseNamedMessagesSummaryTargetSeed(
  value: string | null | undefined,
): NamedMessagesSummaryTargetSeedV2 | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(
      value,
    ) as Partial<NamedMessagesSummaryTargetSeedV2>;
    const snapshot = parsed.freshnessSnapshot;
    if (
      parsed.version !== 2 ||
      typeof parsed.query !== 'string' ||
      !parsed.query.trim() ||
      !parsed.target ||
      typeof parsed.target.chatJid !== 'string' ||
      !parsed.target.chatJid.trim().startsWith('bb:') ||
      typeof parsed.target.displayName !== 'string' ||
      !parsed.target.displayName.trim() ||
      typeof parsed.target.isGroup !== 'boolean' ||
      typeof parsed.historyStartTimestamp !== 'string' ||
      !Number.isFinite(Date.parse(parsed.historyStartTimestamp)) ||
      !snapshot ||
      typeof snapshot.latestMessageIdentityHash !== 'string' ||
      !/^[a-f0-9]{16}$/i.test(snapshot.latestMessageIdentityHash) ||
      typeof snapshot.latestMessageAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.latestMessageAt)) ||
      !(
        snapshot.latestInboundAt === null ||
        typeof snapshot.latestInboundAt === 'string'
      ) ||
      !(
        snapshot.latestOutboundAt === null ||
        typeof snapshot.latestOutboundAt === 'string'
      ) ||
      !Number.isInteger(snapshot.messageCount) ||
      snapshot.messageCount < 1 ||
      typeof snapshot.snapshotHash !== 'string' ||
      !/^[a-f0-9]{16}$/i.test(snapshot.snapshotHash) ||
      typeof snapshot.transcriptHash !== 'string' ||
      !/^[a-f0-9]{16}$/i.test(snapshot.transcriptHash)
    ) {
      return null;
    }
    return {
      version: 2,
      query: parsed.query.trim(),
      target: {
        chatJid: parsed.target.chatJid.trim(),
        displayName: parsed.target.displayName.trim(),
        isGroup: parsed.target.isGroup,
      },
      historyStartTimestamp: parsed.historyStartTimestamp,
      freshnessSnapshot: snapshot,
    };
  } catch {
    return null;
  }
}

function validateNamedMessagesSummaryTarget(input: {
  seedJson?: string | null;
  presentationChatJid?: string | null;
}): NamedMessagesSummaryTargetValidation {
  if (!input.seedJson?.trim()) {
    return {
      state: 'missing_seed',
      detail: 'the summary continuation has no exact Messages target seed',
    };
  }
  const seed = parseNamedMessagesSummaryTargetSeed(input.seedJson);
  if (!seed) {
    return {
      state: 'invalid_seed',
      detail: 'the exact Messages target seed is malformed',
    };
  }
  const presentationChatJid = normalizeText(input.presentationChatJid || '');
  if (
    seed.target.chatJid === presentationChatJid ||
    isConfiguredBlueBubblesSelfThreadAliasJid(seed.target.chatJid)
  ) {
    return {
      state: 'presentation_conflict',
      detail:
        'the external Messages target resolves to the assistant control conversation',
    };
  }
  const hasCurrentExactChat = getAllChats().some(
    (chat) =>
      chat.jid === seed.target.chatJid &&
      (chat.channel === 'bluebubbles' || chat.jid.startsWith('bb:')),
  );
  if (!hasCurrentExactChat) {
    return {
      state: 'missing',
      detail: 'the exact Messages target is no longer in the synced chat list',
    };
  }
  const resolution = resolveBlueBubblesThreadTargetByName(seed.query);
  if (resolution.state === 'missing') {
    return {
      state: 'missing',
      detail: 'the named Messages target no longer resolves',
    };
  }
  if (resolution.state === 'ambiguous') {
    return {
      state: 'ambiguous',
      detail: 'the named Messages target now matches more than one chat',
    };
  }
  if (
    resolution.target.chatJid !== seed.target.chatJid ||
    resolution.target.isGroup !== seed.target.isGroup ||
    resolution.target.chatJid === presentationChatJid ||
    isConfiguredBlueBubblesSelfThreadAliasJid(resolution.target.chatJid)
  ) {
    return {
      state: 'changed',
      detail: 'the current Messages target no longer matches the summary seed',
    };
  }
  return {
    state: 'resolved',
    target: resolution.target,
    seedJson: buildNamedMessagesSummaryTargetSeedJson({
      query: seed.query,
      target: resolution.target,
      historyStartTimestamp: seed.historyStartTimestamp,
      freshnessSnapshot: seed.freshnessSnapshot,
    }),
    seed,
  };
}

interface AllSyncedMessagesSummaryThread {
  label: string;
  isGroup: boolean;
  messages: NewMessage[];
  latestTimestamp: string;
}

interface AllSyncedMessagesPendingReply {
  label: string;
  message: NewMessage;
  priorityScore: number;
}

type AllSyncedMessagesDigestSource =
  | 'openai_grounded'
  | 'local'
  | 'local_provider_failed'
  | 'local_untrusted_provider';

const ALL_SYNCED_MESSAGES_PROVIDER_THREAD_LIMIT = 8;

const ALL_SYNCED_MESSAGES_GROUNDING_STOPWORDS = new Set(
  [
    'about',
    'after',
    'again',
    'also',
    'another',
    'because',
    'been',
    'before',
    'being',
    'between',
    'both',
    'could',
    'conversation',
    'conversations',
    'decision',
    'decisions',
    'digest',
    'does',
    'email',
    'from',
    'have',
    'here',
    'into',
    'latest',
    'main',
    'message',
    'messages',
    'more',
    'most',
    'needs',
    'open',
    'other',
    'people',
    'person',
    'priority',
    'question',
    'questions',
    'redacted',
    'recent',
    'reply',
    'should',
    'still',
    'summary',
    'secret',
    'texts',
    'than',
    'that',
    'their',
    'them',
    'theme',
    'themes',
    'there',
    'these',
    'they',
    'this',
    'those',
    'through',
    'today',
    'under',
    'very',
    'want',
    'were',
    'what',
    'when',
    'where',
    'which',
    'while',
    'with',
    'would',
    'your',
    'number',
    'jid',
  ].map((word) => word.toLowerCase()),
);

function allSyncedMessagesGroundingTokens(value: string): string[] {
  return redactRecentTextReviewText(value)
    .toLowerCase()
    .replace(/[\u2018\u2019']s\b/g, '')
    .replace(/[\u2018\u2019']/g, '')
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 &&
        !ALL_SYNCED_MESSAGES_GROUNDING_STOPWORDS.has(token) &&
        !/^\d+$/.test(token),
    );
}

function clipAllSyncedMessagesEvidence(
  value: string | null | undefined,
  maxLength: number,
): string {
  const redacted = redactRecentTextReviewText(value || '');
  if (!redacted || redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isAllSyncedMessagesProviderDigestGrounded(params: {
  evidenceText: string;
  digest: Awaited<ReturnType<typeof summarizeBlueBubblesThreadDigest>>;
}): boolean {
  if (params.digest.source !== 'openai') return false;
  const evidenceText = redactRecentTextReviewText(params.evidenceText);
  const evidenceNumbers = new Set(
    evidenceText.toLowerCase().match(/\b\d+(?:[.,:]\d+)?\b/g) || [],
  );
  const highImpactFacts = [
    'not',
    'never',
    'cancelled',
    'canceled',
    'confirmed',
    'decided',
    'booked',
    'scheduled',
    'paid',
    'due',
    'overdue',
    'sent',
    'completed',
    'delayed',
  ];
  const evidenceLower = evidenceText.toLowerCase();
  const claims = [
    params.digest.lead,
    params.digest.digest,
    ...params.digest.bullets,
  ].filter((claim): claim is string => Boolean(claim));
  for (const claim of claims) {
    const sanitizedClaim = redactRecentTextReviewText(claim).toLowerCase();
    const unsupportedNumber = (
      sanitizedClaim.match(/\b\d+(?:[.,:]\d+)?\b/g) || []
    ).some((number) => !evidenceNumbers.has(number));
    const unsupportedState = highImpactFacts.some(
      (fact) =>
        new RegExp(`\\b${fact}\\b`, 'i').test(sanitizedClaim) &&
        !new RegExp(`\\b${fact}\\b`, 'i').test(evidenceLower),
    );
    if (
      unsupportedNumber ||
      unsupportedState ||
      hasMessagesGroundingPolarityConflict({
        claimText: sanitizedClaim,
        evidenceText,
      })
    ) {
      return false;
    }
  }
  const evidenceTokens = new Set(
    allSyncedMessagesGroundingTokens(evidenceText),
  );
  if (evidenceTokens.size === 0) return false;

  const substantiveClaims = [
    { kind: 'lead' as const, text: params.digest.lead },
    { kind: 'digest' as const, text: params.digest.digest },
    ...params.digest.bullets.map((text) => ({
      kind: 'bullet' as const,
      text,
    })),
  ]
    .map((claim) => ({
      kind: claim.kind,
      tokens: allSyncedMessagesGroundingTokens(claim.text || ''),
    }))
    .filter((claim) => claim.tokens.length > 0);
  if (substantiveClaims.length === 0) return false;

  const anchoredTokens = new Set<string>();
  const claimGrounding = new Map<(typeof substantiveClaims)[number], boolean>();
  for (const claim of substantiveClaims) {
    const claimTokens = claim.tokens;
    const claimAnchors = new Set(
      claimTokens.filter((token) => evidenceTokens.has(token)),
    );
    for (const token of claimAnchors) anchoredTokens.add(token);
    const minimumClaimAnchors = claimTokens.length <= 5 ? 1 : 2;
    const claimIsGrounded =
      claimAnchors.size >= minimumClaimAnchors &&
      claimAnchors.size / claimTokens.length >= 0.3;
    claimGrounding.set(claim, claimIsGrounded);
  }

  const minimumTotalAnchors = Math.min(2, evidenceTokens.size);
  const primaryClaim =
    substantiveClaims.find((claim) => claim.kind === 'digest') ||
    substantiveClaims[0];
  return (
    anchoredTokens.size >= minimumTotalAnchors &&
    Boolean(primaryClaim && claimGrounding.get(primaryClaim)) &&
    substantiveClaims.every((claim) => claimGrounding.get(claim) === true)
  );
}

export function formatMessagesSummaryCouncilDisclosure(input: {
  councilAttempted: boolean;
  councilProviderUsed: boolean;
}): string | null {
  if (input.councilProviderUsed) {
    return 'Council review: At least one configured council provider processed a sanitized transcript snippet; no council wording is rendered directly in this summary.';
  }
  if (input.councilAttempted) {
    return 'Council review: A provider council was attempted with a sanitized transcript snippet; no council wording is rendered directly in this summary.';
  }
  return null;
}

function isAllSyncedMessagesAutomatedNoise(message: NewMessage): boolean {
  return isAutomatedRecentTextNotice(message.content || '');
}

function closesAllSyncedMessagesOpenRequest(message: NewMessage): boolean {
  const content = redactRecentTextReviewText(message.content || '');
  return /\b(?:never mind|nevermind|ignore that|no need|all set|handled it|figured it out|already got it|cancel(?:led)?|disregard)\b/i.test(
    content,
  );
}

function findAllSyncedMessagesPendingReply(
  thread: AllSyncedMessagesSummaryThread,
): AllSyncedMessagesPendingReply | null {
  // Use the same turn-aware unresolved-ask semantics as the dedicated recent
  // text review. A later inbound addendum does not answer an earlier ask, and
  // an unrelated owner message does not silently close it.
  const unresolvedAsk = findLatestUnresolvedInboundAsk(thread.messages);
  if (
    !unresolvedAsk ||
    closesAllSyncedMessagesOpenRequest(unresolvedAsk) ||
    isAllSyncedMessagesAutomatedNoise(unresolvedAsk)
  ) {
    return null;
  }
  if (thread.isGroup) {
    const repliedToOwnerTurn = Boolean(
      unresolvedAsk.reply_to_id &&
      thread.messages.some(
        (candidate) =>
          candidate.id === unresolvedAsk.reply_to_id && candidate.is_from_me,
      ),
    );
    if (!repliedToOwnerTurn) {
      // A bare question in a group may be addressed to another participant or
      // the room generally. Do not turn it into owner-owed work without an
      // explicit provider reply binding to the owner's turn.
      return null;
    }
  }
  const content = redactRecentTextReviewText(unresolvedAsk.content || '');
  const timestampScore = Date.parse(unresolvedAsk.timestamp || '');
  const priorityScore =
    (/\b(?:urgent|asap|right away|deadline)\b/i.test(content) ? 30 : 0) +
    (/\b(?:today|tonight|tomorrow|by \d|before \d)\b/i.test(content) ? 15 : 0) +
    (Number.isFinite(timestampScore) ? timestampScore : 0) / 1_000_000_000_000;
  return {
    label: thread.label,
    message: unresolvedAsk,
    priorityScore,
  };
}

function buildAllSyncedMessagesTranscript(
  threads: AllSyncedMessagesSummaryThread[],
): { transcript: string; evidenceText: string } {
  const selectedThreads = threads.slice(
    0,
    ALL_SYNCED_MESSAGES_PROVIDER_THREAD_LIMIT,
  );
  const transcript = selectedThreads
    .map((thread) => {
      const speakerLabels = buildThreadSummarySpeakerLabels({
        messages: thread.messages,
        isGroup: thread.isGroup,
      });
      const turns = thread.messages
        .slice(-16)
        .map((message) => {
          const speaker =
            speakerLabels.get(getThreadSummarySpeakerKey(message)) || 'Someone';
          return `[${formatThreadSummaryTranscriptTimestamp(message.timestamp)}] ${speaker}: ${clipAllSyncedMessagesEvidence(message.content, 240)}`;
        })
        .filter(Boolean)
        .join('\n');
      return `[Conversation: ${thread.label}]\n${turns}`;
    })
    .join('\n\n');
  return {
    transcript: redactRecentTextReviewText(transcript),
    evidenceText: selectedThreads
      .flatMap((thread) => thread.messages)
      .map((message) => redactRecentTextReviewText(message.content || ''))
      .join('\n'),
  };
}

function buildLocalAllSyncedMessagesThemeLines(params: {
  threads: AllSyncedMessagesSummaryThread[];
  channel: AssistantCapabilityContext['channel'];
}): string[] {
  const maxThreads = params.channel === 'bluebubbles' ? 3 : 6;
  const snippetLimit = params.channel === 'bluebubbles' ? 88 : 130;
  return params.threads.slice(0, maxThreads).map((thread) => {
    const highlights = pickRepresentativeThreadMessages(thread.messages);
    const first = highlights[0] || thread.messages[0];
    const latest = highlights.at(-1) || thread.messages.at(-1);
    const firstText = clipAllSyncedMessagesEvidence(
      first?.content,
      snippetLimit,
    );
    const latestText = clipAllSyncedMessagesEvidence(
      latest?.content,
      snippetLimit,
    );
    if (!firstText || first?.id === latest?.id || firstText === latestText) {
      return `- ${thread.label}: "${latestText || 'Recent conversation activity.'}"`;
    }
    return `- ${thread.label}: "${firstText}" \u2192 "${latestText}"`;
  });
}

function formatAllSyncedMessagesProviderThemes(params: {
  digest: Awaited<ReturnType<typeof summarizeBlueBubblesThreadDigest>>;
  channel: AssistantCapabilityContext['channel'];
}): string[] {
  const compact = params.channel === 'bluebubbles';
  const overview = [params.digest.lead, params.digest.digest]
    .filter(Boolean)
    .map((value) => redactRecentTextReviewText(value || ''))
    .join(' ');
  return [
    overview ? clipText(overview, compact ? 420 : 760) : null,
    ...params.digest.bullets
      .slice(0, compact ? 2 : 4)
      .map(
        (bullet) =>
          `- ${clipText(redactRecentTextReviewText(bullet), compact ? 140 : 190)}`,
      ),
  ].filter((line): line is string => Boolean(line));
}

async function buildAllSyncedMessagesSummaryReply(params: {
  window: ReturnType<typeof resolveThreadSummaryWindow>;
  channel: AssistantCapabilityContext['channel'];
}): Promise<{
  replyText: string;
  digestSource: AllSyncedMessagesDigestSource;
  threadCount: number;
  messageCount: number;
}> {
  const threads = getAllChats()
    .filter((chat) => chat.jid.startsWith('bb:'))
    .filter((chat) => !isConfiguredBlueBubblesSelfThreadAliasJid(chat.jid))
    .map((chat) => {
      const messages = listMessagesForChatWindow({
        chatJid: chat.jid,
        startTimestamp: params.window.startTimestamp,
        endTimestamp: params.window.endTimestamp,
        limit: 80,
      })
        .filter(
          (message) =>
            !message.is_bot_message && describeMessageForSummary(message),
        )
        .map((message) => ({
          ...message,
          content: describeMessageForSummary(message),
        }));
      return {
        label: formatSafeSyncedThreadLabel({
          jid: chat.jid,
          name: chat.name,
          isGroup: Boolean(chat.is_group),
        }),
        isGroup: Boolean(chat.is_group),
        messages,
        latestTimestamp: messages[messages.length - 1]?.timestamp || '',
      } satisfies AllSyncedMessagesSummaryThread;
    })
    .filter((entry) => entry.messages.length > 0)
    .sort((left, right) =>
      right.latestTimestamp.localeCompare(left.latestTimestamp),
    );

  if (threads.length === 0) {
    return {
      replyText: `In the available local Messages snapshot, I did not find activity outside your configured self-thread over ${params.window.label}.\n\nSynthesis: Local-only; all visible claims and classifications are grounded in the available local synced snapshot.\n\nCoverage: Sync completeness was not independently verified, and each conversation was capped at its newest 80 in-window messages. This is an activity/actionability view, not device unread/read status.`,
      digestSource: 'local',
      threadCount: 0,
      messageCount: 0,
    };
  }

  const totalMessages = threads.reduce(
    (sum, entry) => sum + entry.messages.length,
    0,
  );
  const { transcript, evidenceText } =
    buildAllSyncedMessagesTranscript(threads);
  const synthesizedDigest = await summarizeBlueBubblesThreadDigest({
    chatName: 'all synced Messages chats',
    windowLabel: params.window.label,
    transcript,
    channel: params.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
    thinkingMode: 'quick',
  });
  const providerGrounded = isAllSyncedMessagesProviderDigestGrounded({
    evidenceText,
    digest: synthesizedDigest,
  });
  const digestSource: AllSyncedMessagesDigestSource = providerGrounded
    ? 'openai_grounded'
    : synthesizedDigest.source === 'openai' ||
        synthesizedDigest.fallbackReason === 'ungrounded'
      ? 'local_untrusted_provider'
      : synthesizedDigest.providerAttempted
        ? 'local_provider_failed'
        : 'local';
  const synthesisDisclosure =
    digestSource === 'openai_grounded'
      ? 'Synthesis: OpenAI generated the Themes wording from the bounded local synced transcript; commitments, decisions, open questions, and reply classifications remain deterministic and grounded in that local snapshot.'
      : digestSource === 'local_untrusted_provider'
        ? 'Synthesis: Local-only output. An OpenAI draft was rejected by grounding checks; all visible claims and classifications come from the available local synced snapshot.'
        : digestSource === 'local_provider_failed'
          ? 'Synthesis: Visible output is local. OpenAI synthesis was attempted on the bounded transcript but did not return usable output; all visible claims and classifications come from the available local synced snapshot.'
          : 'Synthesis: Local-only; no OpenAI synthesis request was made, and all visible claims and classifications are grounded in the available local synced snapshot.';
  const councilDisclosure =
    formatMessagesSummaryCouncilDisclosure(synthesizedDigest);
  const themeLines = providerGrounded
    ? formatAllSyncedMessagesProviderThemes({
        digest: synthesizedDigest,
        channel: params.channel,
      })
    : buildLocalAllSyncedMessagesThemeLines({
        threads,
        channel: params.channel,
      });

  const compact = params.channel === 'bluebubbles';
  const sectionLimit = compact ? 2 : 3;
  const evidenceLimit = compact ? 112 : 170;
  const groundedPlans = threads
    .flatMap((thread) => {
      const speakerLabels = buildThreadSummarySpeakerLabels({
        messages: thread.messages,
        isGroup: thread.isGroup,
      });
      return extractThreadSummaryPlanFacts({
        messages: thread.messages,
        speakerLabels,
        isGroup: thread.isGroup,
        directOtherLabel: thread.label,
      }).map((fact) => ({ label: thread.label, fact }));
    })
    .sort((left, right) =>
      right.fact.timestamp.localeCompare(left.fact.timestamp),
    )
    .slice(0, sectionLimit)
    .map(
      (item) =>
        `- ${item.label}: ${formatGroundedMessagesPlanFact({
          ...item.fact,
          action: clipAllSyncedMessagesEvidence(
            item.fact.action,
            compact ? 72 : 110,
          ),
        })}`,
    );
  const pendingReplies = threads
    .map(findAllSyncedMessagesPendingReply)
    .filter((item): item is AllSyncedMessagesPendingReply => Boolean(item))
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        right.message.timestamp.localeCompare(left.message.timestamp),
    );
  const openQuestions = pendingReplies
    .slice(0, sectionLimit)
    .map(
      (item) =>
        `- ${item.label}: "${clipAllSyncedMessagesEvidence(item.message.content, evidenceLimit)}"`,
    );
  const replyPriorities = pendingReplies
    .slice(0, sectionLimit)
    .map(
      (item) =>
        `- ${item.label} \u2014 respond to "${clipAllSyncedMessagesEvidence(item.message.content, compact ? 72 : 100)}"`,
    );
  const themeCoverageLimit = providerGrounded
    ? ALL_SYNCED_MESSAGES_PROVIDER_THREAD_LIMIT
    : compact
      ? 3
      : 6;
  const hiddenThreadCount = Math.max(0, threads.length - themeCoverageLimit);
  const coverageNote = [
    'Coverage: Available local synced snapshot only; sync completeness was not independently verified.',
    'The configured self-thread was excluded, and each conversation was capped at its newest 80 in-window messages.',
    'Reply priorities are inferred from conversation turns, not device unread/read status.',
    providerGrounded
      ? 'Model-generated Themes used at most 8 conversations and their newest 16 messages.'
      : `Local Themes show at most ${themeCoverageLimit} conversations.`,
  ].join(' ');

  const sections = [
    `Messages digest \u2014 ${params.window.label}`,
    synthesisDisclosure,
    councilDisclosure,
    ['Themes', ...themeLines].join('\n'),
    [
      'Commitments and decisions',
      ...(groundedPlans.length > 0
        ? groundedPlans
        : [
            'No explicit commitments, decisions, or pending proposals were captured in the synced messages.',
          ]),
    ].join('\n'),
    [
      'Open questions',
      ...(openQuestions.length > 0
        ? openQuestions
        : ['No unanswered question is obvious from the latest turns.']),
    ].join('\n'),
    [
      'Reply priorities',
      ...(replyPriorities.length > 0
        ? replyPriorities
        : ['No reply looks clearly due from the latest turns.']),
    ].join('\n'),
    hiddenThreadCount > 0
      ? `Coverage note: ${hiddenThreadCount} additional active conversation${hiddenThreadCount === 1 ? '' : 's'} stayed outside this compact view.`
      : null,
    coverageNote,
  ].filter((section): section is string => Boolean(section));
  return {
    replyText: sections.join('\n\n'),
    digestSource,
    threadCount: threads.length,
    messageCount: totalMessages,
  };
}

async function runCommunicationThreadSummaryCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (input.targetChatJid === ALL_SYNCED_MESSAGES_TARGET) {
    const window = resolveThreadSummaryWindow({
      now: context.now || new Date(),
      kind: input.timeWindowKind,
      value: input.timeWindowValue,
    });
    const summary = await buildAllSyncedMessagesSummaryReply({
      window,
      channel: context.channel,
    });
    const replyText = summary.replyText;
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'summarized activity across all synced Messages chats',
        [
          `window:${window.label}`,
          `threads:${summary.threadCount}`,
          `messages:${summary.messageCount}`,
          `digest_source:${summary.digestSource}`,
        ],
      ),
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: 'communication_thread',
        summaryText: replyText,
        guidanceGoal: 'open_conversation',
        subjectData: {
          activeCapabilityId: descriptor.id,
          threadTitle: 'all synced Messages',
          conversationFocus: 'all synced Messages',
        },
        supportedFollowups: descriptor.followupActions,
        responseSource: 'local_companion',
      },
    };
  }

  const chatQuery =
    normalizeText(input.targetChatName || input.threadTitle || '') ||
    normalizeText(input.personName || '');
  if (!chatQuery) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'Tell me which synced Messages thread you want summarized, like `summarize Pops of Punk from the last 2 days`.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'asked to clarify the target synced Messages thread',
      ),
    };
  }

  const resolution = resolveBlueBubblesThreadTargetByName(chatQuery);
  if (resolution.state === 'missing') {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: `I couldn't match "${chatQuery}" to a synced Messages chat yet.`,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'could not match the requested synced Messages chat by name',
      ),
    };
  }
  if (resolution.state === 'ambiguous') {
    const matches = resolution.matches
      .map((match) =>
        formatSafeSyncedThreadLabel({
          jid: match.chatJid,
          name: match.displayName,
          isGroup: match.isGroup,
        }),
      )
      .join(', ');
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: `I found more than one synced Messages chat that could be "${chatQuery}". Which one do you want: ${matches}?`,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'asked to clarify an ambiguous synced Messages chat match',
      ),
    };
  }

  const safeDisplayName = formatSafeSyncedThreadLabel({
    jid: resolution.target.chatJid,
    name: resolution.target.displayName,
    isGroup: resolution.target.isGroup,
  });

  const window = resolveThreadSummaryWindow({
    now: context.now || new Date(),
    kind: input.timeWindowKind,
    value: input.timeWindowValue,
  });
  const messages = listMessagesForChatWindow({
    chatJid: resolution.target.chatJid,
    startTimestamp: window.startTimestamp,
    endTimestamp: window.endTimestamp,
    limit: 400,
  })
    .filter(
      (message) =>
        !message.is_bot_message && describeMessageForSummary(message),
    )
    .map((message) => ({
      ...message,
      content: describeMessageForSummary(message),
    }));

  if (messages.length === 0) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: `In the available local Messages snapshot, I didn't find activity in ${safeDisplayName} over ${window.label}.\n\nCoverage: Sync completeness was not independently verified; this named conversation lookup was capped at its newest 400 in-window messages. This is an activity view, not device unread status.`,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'found no synced Messages history inside the requested window',
      ),
    };
  }

  const speakerLabels = buildThreadSummarySpeakerLabels({
    messages,
    isGroup: resolution.target.isGroup,
  });
  const transcript = buildThreadSummaryTranscript({
    messages,
    speakerLabels,
  });
  const synthesizedDigest = await summarizeBlueBubblesThreadDigest({
    chatName: safeDisplayName,
    windowLabel: window.label,
    transcript,
    channel: context.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
  });
  const safeSuggestedReplies =
    buildLocalThreadSummarySuggestedReplies(messages);
  const usedOpenAiSynthesis =
    synthesizedDigest.source === 'openai' &&
    Boolean(
      synthesizedDigest.lead ||
      synthesizedDigest.digest ||
      synthesizedDigest.bullets.length > 0,
    );
  const summaryReplyText = usedOpenAiSynthesis
    ? formatThreadSummaryReply({
        lead:
          synthesizedDigest.lead ||
          `Here’s the gist from ${safeDisplayName} ${window.label === 'today' ? 'today' : `over ${window.label}`}.`,
        digest: synthesizedDigest.digest,
        bullets: synthesizedDigest.bullets,
        suggestedReplies: safeSuggestedReplies,
        channel: context.channel,
      })
    : buildFallbackThreadSummaryReply({
        chatName: safeDisplayName,
        windowLabel: window.label,
        messages,
        speakerLabels,
        channel: context.channel,
      });
  const groundedPlanFacts = extractThreadSummaryPlanFacts({
    messages,
    speakerLabels,
    isGroup: resolution.target.isGroup,
    directOtherLabel: safeDisplayName,
  });
  const planSection = formatThreadSummaryPlanSection({
    facts: groundedPlanFacts,
    limit: context.channel === 'bluebubbles' ? 2 : 4,
  });
  const synthesisDisclosure = usedOpenAiSynthesis
    ? 'Synthesis: OpenAI summarized the bounded local synced transcript; all visible claims and the deterministic commitment/decision classification remain grounded in that local snapshot.'
    : synthesizedDigest.fallbackReason === 'ungrounded'
      ? 'Synthesis: Visible output is local. An OpenAI draft was rejected by grounding checks; all visible claims and commitment/decision classifications come from the available local synced snapshot.'
      : synthesizedDigest.providerAttempted
        ? 'Synthesis: Visible output is local. OpenAI synthesis was attempted on the bounded transcript but did not return usable output; all visible claims and commitment/decision classifications come from the available local synced snapshot.'
        : 'Synthesis: Local-only; no OpenAI synthesis request was made, and all visible claims and commitment/decision classifications are grounded in the available local synced snapshot.';
  const synthesisCoverage = usedOpenAiSynthesis
    ? 'OpenAI synthesis saw only the newest 120 in-window messages.'
    : synthesizedDigest.providerAttempted
      ? 'The attempted OpenAI synthesis saw only the newest 120 in-window messages; its wording is not rendered.'
      : 'No OpenAI synthesis request was made.';
  const councilDisclosure =
    formatMessagesSummaryCouncilDisclosure(synthesizedDigest);
  const replyText = `${summaryReplyText}\n\n${planSection}\n\n${synthesisDisclosure}${councilDisclosure ? `\n\n${councilDisclosure}` : ''}\n\nCoverage: Available local synced snapshot only; sync completeness was not independently verified. This named conversation lookup was capped at its newest 400 in-window messages. ${synthesisCoverage} This is an activity/actionability view, not device unread/read status; any suggested reply is unsent.`;
  const latestTranscriptMessages = listMessagesForChatWindow({
    chatJid: resolution.target.chatJid,
    startTimestamp: window.startTimestamp,
    endTimestamp: null,
    limit: 400,
  })
    .filter(
      (message) =>
        !message.is_bot_message && describeMessageForSummary(message),
    )
    .map((message) => ({
      ...message,
      content: describeMessageForSummary(message),
    }));
  const namedSummaryFreshnessSnapshot = requireMessagesSummaryFreshnessSnapshot(
    buildMessagesThreadFreshnessSnapshot({
      chatJid: resolution.target.chatJid,
      messages: latestTranscriptMessages,
    }),
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'summarized a synced Messages chat from raw BlueBubbles history',
      [
        `chat:${safeDisplayName}`,
        `window:${window.label}`,
        `messages:${messages.length}`,
        `digest_source:${synthesizedDigest.source}`,
        `provider_attempted:${synthesizedDigest.providerAttempted}`,
        `council_attempted:${synthesizedDigest.councilAttempted}`,
        `council_provider_used:${synthesizedDigest.councilProviderUsed}`,
      ],
    ),
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'communication_thread',
      summaryText: replyText,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        personName: resolution.target.isGroup ? undefined : safeDisplayName,
        threadTitle: safeDisplayName,
        conversationFocus: safeDisplayName,
        namedMessagesSummaryTargetJson: namedSummaryFreshnessSnapshot
          ? buildNamedMessagesSummaryTargetSeedJson({
              query: chatQuery,
              target: resolution.target,
              historyStartTimestamp: window.startTimestamp,
              freshnessSnapshot: namedSummaryFreshnessSnapshot,
            })
          : undefined,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
  };
}

async function runRecentTextReviewCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = await reviewRecentTexts({
    groupFolder: context.groupFolder,
    now: context.now,
    channel: context.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
    timeWindowKind: input.timeWindowKind || 'default_24h',
    timeWindowValue: input.timeWindowValue || 24,
    cloudAnalysisMode: 'auto',
  });
  const replyText = formatRecentTextReviewReply({
    result,
    channel: context.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
  });
  const firstItem = result.needsReply[0] || result.worthWatching[0];
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      result.providerUsed === 'openai' ? 'research_openai' : 'local_companion',
      'reviewed recent synced Messages for priority and reply needs',
      [
        `window:${result.window.label}`,
        `needs_reply:${result.needsReply.length}`,
        `worth_watching:${result.worthWatching.length}`,
      ],
    ),
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'communication_thread',
      summaryText: result.summaryText,
      guidanceGoal: 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        conversationFocus: 'recent synced Messages review',
        threadTitle: firstItem?.chatLabel || 'recent text review',
        personName: firstItem?.chatLabel,
        communicationThreadId: firstItem?.communicationThreadId || undefined,
        communicationSubjectIds: firstItem?.linkedSubjectIds || [],
        communicationLifeThreadIds: firstItem?.linkedLifeThreadIds || [],
        lastCommunicationSummary: firstItem?.summaryText || result.summaryText,
        recentTextReviewJson: buildRecentTextReviewSeedJson(result),
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
    followupActions: descriptor.followupActions,
    outcomeMetadata: {
      source: 'recent_text_review',
      outcomeKind: result.items.some((item) => item.suggestedReply)
        ? 'suggested'
        : 'reviewed',
      handled: true,
      capabilityId: descriptor.id,
      providerUsed: result.providerUsed,
      counts: {
        needsReply: result.needsReply.length,
        worthWatching: result.worthWatching.length,
        noReplyNeeded: result.noReplyNeeded.length,
      },
    },
  };
}

async function runCommunicationIdentityReviewCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const response = handleCommunicationIdentityReview({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    text: input.text || input.canonicalText || '',
    now: context.now,
  });
  if (!response.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: response.replyText,
    sendOptions: response.inlineActionRows?.length
      ? { inlineActionRows: response.inlineActionRows }
      : undefined,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      response.changed
        ? 'applied an explicit metadata-only communication identity decision'
        : 'reviewed metadata-only communication identity decisions without mutation',
      [
        'identity_source:explicit_owner_review',
        'raw_message_bodies_used:no',
        'identifier_inference_used:no',
      ],
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runCommunicationUnderstandCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const rawCommunicationText = input.text || input.canonicalText || '';
  const analysis = analyzeCommunicationMessage({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    text: rawCommunicationText,
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: context.priorSubjectData,
    now: context.now,
  });
  const replyText = formatCommunicationAnalysisReply(context.channel, analysis);
  if (!analysis.ok) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'asked for one short clarification before analyzing the message',
      ),
      followupActions: descriptor.followupActions,
    };
  }

  const continuationCandidate = buildCommunicationContinuationCandidate({
    descriptor,
    summaryText: analysis.summaryText || 'I looked at the conversation.',
    detailText: formatCommunicationAnalysisReply('telegram', analysis),
    threadId: analysis.linkedLifeThreads[0]?.id,
    threadTitle: analysis.linkedLifeThreads[0]?.title || analysis.thread?.title,
    communicationThreadId: analysis.thread?.id,
    communicationSubjectIds: analysis.linkedSubjects.map(
      (subject) => subject.id,
    ),
    communicationLifeThreadIds: analysis.linkedLifeThreads.map(
      (thread) => thread.id,
    ),
  });
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildCommunicationConversationSeed({
      descriptor,
      summaryText: analysis.summaryText || 'I looked at the conversation.',
      conversationFocus: analysis.messageText || rawCommunicationText,
      personName: analysis.linkedSubjects[0]?.displayName,
      threadId: analysis.linkedLifeThreads[0]?.id,
      threadTitle:
        analysis.linkedLifeThreads[0]?.title || analysis.thread?.title,
      communicationThreadId: analysis.thread?.id,
      communicationSubjectIds: analysis.linkedSubjects.map(
        (subject) => subject.id,
      ),
      communicationLifeThreadIds: analysis.linkedLifeThreads.map(
        (thread) => thread.id,
      ),
      lastCommunicationSummary: analysis.summaryText,
      continuationCandidate,
      supportedFollowups,
    }),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'handled by communication companion layer',
      analysis.explanation ? [analysis.explanation] : [],
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
  };
}

function mapRecentTextReviewFollowupToMessageOperation(
  followup: ReturnType<typeof parseRecentTextReviewItemFollowup>,
): MessageActionOperation | null {
  if (!followup) return null;
  if (followup.kind === 'remind') {
    return {
      kind: 'remind_instead',
      timingHint: followup.timingHint || null,
    };
  }
  if (followup.kind === 'save') return { kind: 'save_to_thread' };
  if (followup.kind === 'skip') return { kind: 'skip' };
  return null;
}

function mapRecentTextReviewFollowupToOutcome(
  followup: ReturnType<typeof parseRecentTextReviewItemFollowup>,
): RecentTextReviewOutcome {
  if (!followup) return 'drafted';
  if (followup.kind === 'remind') return 'reminded';
  if (followup.kind === 'save') return 'saved';
  if (followup.kind === 'skip') return 'skipped';
  if (followup.kind === 'handled' || followup.kind === 'why') return 'handled';
  return 'drafted';
}

function buildRecentTextReviewFollowupSeed(input: {
  descriptor: AssistantCapabilityDescriptor;
  context: AssistantCapabilityContext;
  summaryText: string;
  item: NonNullable<
    ReturnType<typeof parseRecentTextReviewItemFollowup>
  >['item'];
}): AssistantCapabilityConversationSeed {
  return {
    flowKey: 'communication_review_recent_texts',
    subjectKind: 'communication_thread',
    summaryText: input.summaryText,
    guidanceGoal: 'action_follow_through',
    subjectData: {
      ...input.context.priorSubjectData,
      activeCapabilityId: 'communication.review_recent_texts',
      conversationFocus: input.item.summaryText,
      threadTitle: input.item.chatLabel,
      personName: input.item.chatLabel,
      communicationThreadId: input.item.communicationThreadId || undefined,
      communicationSubjectIds: input.item.linkedSubjectIds || [],
      communicationLifeThreadIds: input.item.linkedLifeThreadIds || [],
      lastCommunicationSummary: input.item.summaryText,
      recentTextReviewJson:
        input.context.priorSubjectData?.recentTextReviewJson,
    },
    supportedFollowups: input.descriptor.followupActions,
    responseSource: 'local_companion',
  };
}

async function runCommunicationDraftCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const namedSummarySeedJson =
    context.priorSubjectData?.namedMessagesSummaryTargetJson;
  const expectsNamedSummaryTarget =
    Boolean(namedSummarySeedJson) ||
    context.priorSubjectData?.activeCapabilityId ===
      'communication.summarize_thread';
  const namedSummaryTargetValidation = expectsNamedSummaryTarget
    ? validateNamedMessagesSummaryTarget({
        seedJson: namedSummarySeedJson,
        presentationChatJid: context.chatJid,
      })
    : null;
  if (
    namedSummaryTargetValidation &&
    namedSummaryTargetValidation.state !== 'resolved'
  ) {
    const replyText =
      namedSummaryTargetValidation.state === 'ambiguous'
        ? 'That summarized Messages name now matches more than one current chat. Ask me to summarize the exact conversation again before drafting. I did not create a draft or any send controls.'
        : 'I can no longer bind that summary to one exact current Messages chat. Ask me to summarize the named conversation again before drafting. I did not create a draft or any send controls.';
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'blocked a named Messages summary continuation without an exact current external target',
        [
          `target_validation:${namedSummaryTargetValidation.state}`,
          namedSummaryTargetValidation.detail,
        ],
      ),
      followupActions: [],
    };
  }
  let namedSummaryTarget =
    namedSummaryTargetValidation?.state === 'resolved'
      ? namedSummaryTargetValidation
      : null;
  if (namedSummaryTarget) {
    if (!context.primeMessagesChatHistory) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'I could not refresh the exact Messages chat behind that summary, so I did not create a draft or any send controls. Ask me to summarize the named conversation again.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked a named Messages summary continuation without an exact-thread refresh capability',
          ['target_refresh:unavailable'],
        ),
        followupActions: [],
      };
    }
    try {
      const receipt = await context.primeMessagesChatHistory(
        namedSummaryTarget.target.chatJid,
      );
      if (
        !isExactNonEmptyMessagesHistoryRefreshReceipt({
          receipt,
          expectedChatJid: namedSummaryTarget.target.chatJid,
        })
      ) {
        throw new Error('unverifiable targeted Messages refresh');
      }
    } catch {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'I could not refresh the exact Messages chat behind that summary, so I did not create a draft or any send controls. Ask me to summarize the named conversation again.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked a named Messages summary continuation after its exact-thread refresh failed',
          ['target_refresh:failed'],
        ),
        followupActions: [],
      };
    }
    const refreshedTargetValidation = validateNamedMessagesSummaryTarget({
      seedJson: namedSummaryTarget.seedJson,
      presentationChatJid: context.chatJid,
    });
    if (refreshedTargetValidation.state !== 'resolved') {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'The Messages target changed while I refreshed it, so I did not create a draft or any send controls. Ask me to summarize the exact conversation again.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked a named Messages summary continuation whose target changed during refresh',
          [`target_validation:${refreshedTargetValidation.state}`],
        ),
        followupActions: [],
      };
    }
    const refreshedSnapshotValidation = validateMessagesThreadSnapshotBinding({
      chatJid: refreshedTargetValidation.target.chatJid,
      historyStartTimestamp:
        refreshedTargetValidation.seed.historyStartTimestamp,
      freshnessSnapshot: refreshedTargetValidation.seed.freshnessSnapshot,
    });
    if (!refreshedSnapshotValidation.ok) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'The Messages conversation changed after that summary, so I did not create a draft or any send controls. Ask me to summarize the exact conversation again.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked a named Messages summary continuation whose transcript snapshot changed',
          [refreshedSnapshotValidation.reason],
        ),
        followupActions: [],
      };
    }
    namedSummaryTarget = refreshedTargetValidation;
  }
  const reviewItemFollowup = parseRecentTextReviewItemFollowup({
    seedJson: context.priorSubjectData?.recentTextReviewJson,
    userText: input.text || input.canonicalText || '',
  });
  if (reviewItemFollowup && reviewItemFollowup.kind !== 'why') {
    const freshness =
      await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
        seedJson: context.priorSubjectData?.recentTextReviewJson,
        item: reviewItemFollowup.item,
        now: context.now,
        primeChatHistory:
          context.primeMessagesChatHistory ||
          (async () => {
            throw new Error('targeted Messages history refresh unavailable');
          }),
      });
    if (!freshness.ok) {
      recordRecentTextReviewOutcome({
        groupFolder: context.groupFolder,
        item: reviewItemFollowup.item,
        outcome: freshness.outcome,
        now: context.now,
        timingHint: reviewItemFollowup.timingHint || null,
      });
      const replyText = formatRecentTextReviewFreshnessBlockedReply(
        reviewItemFollowup.item,
        freshness,
      );
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText,
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          freshness.outcome === 'blocked_unbound'
            ? 'blocked an unbound recent text review follow-up before action'
            : 'blocked a stale recent text review follow-up before action',
          [freshness.reason],
        ),
        followupActions: descriptor.followupActions,
        outcomeMetadata: {
          source: 'recent_text_review',
          outcomeKind: freshness.outcome,
          handled: false,
          capabilityId: descriptor.id,
          itemId: reviewItemFollowup.item.itemId,
          itemRank: reviewItemFollowup.item.rank,
        },
      };
    }
  }
  if (
    reviewItemFollowup?.kind === 'draft' &&
    reviewItemFollowup.item.riskFlags?.includes('needs_owner_answer')
  ) {
    const replyText = `#${reviewItemFollowup.item.rank} asks for your actual answer, and I do not want to guess it. Tell me what you want to say to ${reviewItemFollowup.item.chatLabel}, and I can help word it. I did not create or send a draft.`;
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'withheld an ungrounded answer draft pending owner-provided wording',
        ['needs_owner_answer'],
      ),
      conversationSeed: buildRecentTextReviewFollowupSeed({
        descriptor,
        context,
        summaryText: replyText,
        item: reviewItemFollowup.item,
      }),
      followupActions: descriptor.followupActions,
      outcomeMetadata: {
        source: 'recent_text_review',
        outcomeKind: 'reviewed',
        handled: false,
        capabilityId: descriptor.id,
        itemId: reviewItemFollowup.item.itemId,
        itemRank: reviewItemFollowup.item.rank,
      },
    };
  }
  if (reviewItemFollowup?.kind === 'why') {
    const replyText = formatRecentTextReviewItemWhyReply(
      reviewItemFollowup.item,
    );
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'explained the selected recent text review item',
      ),
      conversationSeed: buildRecentTextReviewFollowupSeed({
        descriptor,
        context,
        summaryText: replyText,
        item: reviewItemFollowup.item,
      }),
      followupActions: descriptor.followupActions,
      outcomeMetadata: {
        source: 'recent_text_review',
        outcomeKind: 'handled',
        handled: true,
        capabilityId: descriptor.id,
        itemId: reviewItemFollowup.item.itemId,
        itemRank: reviewItemFollowup.item.rank,
      },
    };
  }
  if (reviewItemFollowup?.kind === 'handled') {
    const recorded = recordRecentTextReviewOutcome({
      groupFolder: context.groupFolder,
      item: reviewItemFollowup.item,
      outcome: 'handled',
      now: context.now,
    });
    const replyText = recorded
      ? `Marked #${reviewItemFollowup.item.rank} handled. I did not draft or send anything.`
      : formatRecentTextReviewUnboundReply(reviewItemFollowup.item);
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        recorded
          ? 'marked a recent text review item handled without drafting'
          : 'could not bind a recent text review item to a current thread',
      ),
      conversationSeed: buildRecentTextReviewFollowupSeed({
        descriptor,
        context,
        summaryText: replyText,
        item: reviewItemFollowup.item,
      }),
      followupActions: descriptor.followupActions,
      outcomeMetadata: {
        source: 'recent_text_review',
        outcomeKind: 'handled',
        handled: recorded,
        capabilityId: descriptor.id,
        itemId: reviewItemFollowup.item.itemId,
        itemRank: reviewItemFollowup.item.rank,
      },
    };
  }
  const reviewDraftPrompt = buildReviewDraftPrompt({
    seedJson: context.priorSubjectData?.recentTextReviewJson,
    userText: input.text || input.canonicalText || '',
  });
  const selectedReviewItem =
    reviewDraftPrompt?.item || reviewItemFollowup?.item || null;
  const selectedReviewTarget = selectedReviewItem
    ? resolveRecentTextReviewFollowupTarget(selectedReviewItem)
    : null;
  const selectedReviewTargetChannel =
    selectedReviewTarget?.ok &&
    (selectedReviewTarget.targetChannel === 'telegram' ||
      selectedReviewTarget.targetChannel === 'bluebubbles')
      ? selectedReviewTarget.targetChannel
      : null;
  const earlyReviewOperation =
    mapRecentTextReviewFollowupToMessageOperation(reviewItemFollowup);
  const earlyReviewActionSourceKey = selectedReviewItem
    ? selectedReviewItem.itemId ||
      selectedReviewItem.communicationThreadId ||
      null
    : null;
  const earlyReusableReviewAction =
    earlyReviewOperation && earlyReviewActionSourceKey
      ? getMessageActionBySource(
          context.groupFolder,
          'communication_thread',
          earlyReviewActionSourceKey,
        )
      : undefined;
  if (
    earlyReviewOperation &&
    earlyReusableReviewAction &&
    earlyReusableReviewAction.sendStatus !== 'sent' &&
    earlyReusableReviewAction.sendStatus !== 'skipped'
  ) {
    const operationChatJid =
      context.chatJid || earlyReusableReviewAction.presentationChatJid;
    const operationResult = operationChatJid
      ? await applyMessageActionOperation(
          earlyReusableReviewAction.messageActionId,
          earlyReviewOperation,
          {
            groupFolder: context.groupFolder,
            channel: context.channel,
            chatJid: operationChatJid,
            currentTime: context.now,
            sendToTarget: async () => {
              throw new Error(
                'recent text review follow-up cannot send messages',
              );
            },
          },
        )
      : { handled: false };
    if (operationResult.handled) {
      const finalAction = operationResult.action || earlyReusableReviewAction;
      if (selectedReviewItem) {
        recordRecentTextReviewOutcome({
          groupFolder: context.groupFolder,
          item: selectedReviewItem,
          outcome: mapRecentTextReviewFollowupToOutcome(reviewItemFollowup),
          now: context.now,
          timingHint: reviewItemFollowup?.timingHint || null,
        });
      }
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          operationResult.replyText ||
          operationResult.presentation?.text ||
          'Updated that recent text follow-up.',
        sendOptions: operationResult.presentation?.inlineActionRows.length
          ? { inlineActionRows: operationResult.presentation.inlineActionRows }
          : undefined,
        outputShape: descriptor.preferredOutputShape[context.channel],
        conversationSeed: selectedReviewItem
          ? buildRecentTextReviewFollowupSeed({
              descriptor,
              context,
              summaryText:
                operationResult.replyText ||
                operationResult.presentation?.summaryText ||
                'Updated that recent text follow-up.',
              item: selectedReviewItem,
            })
          : undefined,
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'applied a selected recent text review follow-up to an existing draft',
        ),
        followupActions: descriptor.followupActions,
        messageAction: finalAction,
        outcomeMetadata: selectedReviewItem
          ? {
              source: 'recent_text_review',
              outcomeKind:
                mapRecentTextReviewFollowupToOutcome(reviewItemFollowup),
              handled: true,
              capabilityId: descriptor.id,
              messageActionId: finalAction.messageActionId,
              sendStatus: finalAction.sendStatus,
              lastActionKind: finalAction.lastActionKind || null,
              itemId: selectedReviewItem.itemId,
              itemRank: selectedReviewItem.rank,
            }
          : undefined,
      };
    }
  }
  if (
    reviewItemFollowup?.kind === 'skip' &&
    selectedReviewItem &&
    !earlyReusableReviewAction
  ) {
    const recorded = recordRecentTextReviewOutcome({
      groupFolder: context.groupFolder,
      item: selectedReviewItem,
      outcome: 'skipped',
      now: context.now,
    });
    const replyText = recorded
      ? `Skipped #${selectedReviewItem.rank}. I did not draft or send anything.`
      : formatRecentTextReviewUnboundReply(selectedReviewItem);
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildRecentTextReviewFollowupSeed({
        descriptor,
        context,
        summaryText: replyText,
        item: selectedReviewItem,
      }),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        recorded
          ? 'skipped a selected recent text review item without drafting'
          : 'could not bind a skipped recent text review item to a current thread',
      ),
      followupActions: descriptor.followupActions,
      outcomeMetadata: {
        source: 'recent_text_review',
        outcomeKind: recorded ? 'skipped' : 'blocked_unbound',
        handled: recorded,
        capabilityId: descriptor.id,
        itemId: selectedReviewItem.itemId,
        itemRank: selectedReviewItem.rank,
      },
    };
  }
  if (selectedReviewItem && selectedReviewTarget && !selectedReviewTarget.ok) {
    const replyText = formatRecentTextReviewUnboundReply(selectedReviewItem);
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'blocked an unbound recent text review follow-up before drafting',
      ),
      followupActions: descriptor.followupActions,
      outcomeMetadata: {
        source: 'recent_text_review',
        outcomeKind: 'blocked_unbound',
        handled: false,
        capabilityId: descriptor.id,
        itemId: selectedReviewItem.itemId,
        itemRank: selectedReviewItem.rank,
      },
    };
  }
  const rawCommunicationText =
    reviewDraftPrompt?.text ||
    (selectedReviewItem
      ? `Use this recent text review item without sending anything yet. Thread: ${selectedReviewItem.chatLabel}. Context: ${selectedReviewItem.summaryText}. Why it matters: ${selectedReviewItem.whyText || selectedReviewItem.recommendedAction || 'recent synced Messages review'}.`
      : input.text || input.canonicalText || '');
  const priorContextForDraft = namedSummaryTarget
    ? {
        ...context.priorSubjectData,
        personName: namedSummaryTarget.target.isGroup
          ? undefined
          : namedSummaryTarget.target.displayName,
        threadTitle: namedSummaryTarget.target.displayName,
        communicationThreadId: undefined,
        communicationSubjectIds: [],
        communicationLifeThreadIds: [],
        lastCommunicationSummary: undefined,
        recentTextReviewJson: undefined,
      }
    : reviewDraftPrompt?.item
      ? {
          ...context.priorSubjectData,
          threadTitle: selectedReviewItem?.chatLabel,
          personName: selectedReviewItem?.chatLabel,
          communicationThreadId: undefined,
          communicationSubjectIds:
            selectedReviewItem?.linkedSubjectIds ||
            context.priorSubjectData?.communicationSubjectIds,
          communicationLifeThreadIds:
            selectedReviewItem?.linkedLifeThreadIds ||
            context.priorSubjectData?.communicationLifeThreadIds,
          lastCommunicationSummary:
            selectedReviewItem?.summaryText ||
            context.priorSubjectData?.lastCommunicationSummary,
        }
      : selectedReviewItem
        ? {
            ...context.priorSubjectData,
            threadTitle: selectedReviewItem.chatLabel,
            personName: selectedReviewItem.chatLabel,
            communicationThreadId: undefined,
            communicationSubjectIds:
              selectedReviewItem.linkedSubjectIds ||
              context.priorSubjectData?.communicationSubjectIds,
            communicationLifeThreadIds:
              selectedReviewItem.linkedLifeThreadIds ||
              context.priorSubjectData?.communicationLifeThreadIds,
            lastCommunicationSummary:
              selectedReviewItem.summaryText ||
              context.priorSubjectData?.lastCommunicationSummary,
          }
        : context.priorSubjectData;
  const draftContextChannel = namedSummaryTarget
    ? ('bluebubbles' as const)
    : context.channel;
  const draftContextChatJid =
    namedSummaryTarget?.target.chatJid || context.chatJid;
  const draft =
    context.channel === 'bluebubbles'
      ? await draftCommunicationReplyWithChannelFluidity({
          channel: draftContextChannel,
          groupFolder: context.groupFolder,
          chatJid: draftContextChatJid,
          text: rawCommunicationText,
          replyText: context.replyText,
          conversationSummary: context.conversationSummary,
          priorContext: priorContextForDraft,
          now: context.now,
        })
      : draftCommunicationReply({
          channel: draftContextChannel,
          groupFolder: context.groupFolder,
          chatJid: draftContextChatJid,
          text: rawCommunicationText,
          replyText: context.replyText,
          conversationSummary: context.conversationSummary,
          priorContext: priorContextForDraft,
          now: context.now,
        });
  const replyText = formatCommunicationDraftReply(context.channel, draft);
  if (!draft.ok) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'asked for one short clarification before drafting',
      ),
      followupActions: descriptor.followupActions,
    };
  }

  if (namedSummaryTarget) {
    let refreshReceipt: unknown;
    try {
      refreshReceipt = await context.primeMessagesChatHistory!(
        namedSummaryTarget.target.chatJid,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      refreshReceipt = null;
    }
    const finalTargetValidation = validateNamedMessagesSummaryTarget({
      seedJson: namedSummaryTarget.seedJson,
      presentationChatJid: context.chatJid,
    });
    const exactRefreshProven = isExactNonEmptyMessagesHistoryRefreshReceipt({
      receipt: refreshReceipt,
      expectedChatJid: namedSummaryTarget.target.chatJid,
    });
    const finalSnapshotValidation =
      finalTargetValidation.state === 'resolved'
        ? validateMessagesThreadSnapshotBinding({
            chatJid: finalTargetValidation.target.chatJid,
            historyStartTimestamp:
              finalTargetValidation.seed.historyStartTimestamp,
            freshnessSnapshot: finalTargetValidation.seed.freshnessSnapshot,
          })
        : null;
    if (
      !exactRefreshProven ||
      finalTargetValidation.state !== 'resolved' ||
      !finalSnapshotValidation?.ok
    ) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'The exact Messages conversation could not be proven unchanged after drafting, so I discarded the generated wording and did not create a draft or any send controls. Ask me to summarize that conversation again.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked named-summary action creation after final transcript revalidation',
          [
            exactRefreshProven
              ? 'final_target_refresh:verified'
              : 'final_target_refresh:unverifiable',
            `final_target_validation:${finalTargetValidation.state}`,
            finalSnapshotValidation?.ok
              ? 'final_snapshot:fresh'
              : `final_snapshot:${finalSnapshotValidation?.reason || 'unavailable'}`,
          ],
        ),
        followupActions: [],
      };
    }
    namedSummaryTarget = finalTargetValidation;
  }

  if (selectedReviewItem) {
    const finalReviewFreshness =
      await validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh({
        seedJson: context.priorSubjectData?.recentTextReviewJson,
        item: selectedReviewItem,
        now: context.now,
        primeChatHistory:
          context.primeMessagesChatHistory ||
          (async () => {
            throw new Error('targeted Messages history refresh unavailable');
          }),
      });
    if (!finalReviewFreshness.ok) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText: `${formatRecentTextReviewFreshnessBlockedReply(selectedReviewItem, finalReviewFreshness)}\n\nI discarded the generated wording and created no send controls.`,
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'local_companion',
          'blocked recent-review action creation after final transcript revalidation',
          [finalReviewFreshness.reason],
        ),
        followupActions: [],
      };
    }
  }

  const recentTextReviewActionLink =
    selectedReviewItem?.communicationThreadId &&
    selectedReviewTarget?.ok &&
    selectedReviewTarget.chatJid &&
    context.chatJid &&
    context.priorSubjectData?.recentTextReviewJson
      ? buildRecentTextReviewDraftActionLink({
          seedJson: context.priorSubjectData.recentTextReviewJson,
          itemId: selectedReviewItem.itemId,
          itemRank: selectedReviewItem.rank,
          communicationThreadId: selectedReviewItem.communicationThreadId,
          targetChatJid: selectedReviewTarget.chatJid,
          groupFolder: context.groupFolder,
          presentationChatJid: context.chatJid,
        })
      : null;
  if (selectedReviewItem && !recentTextReviewActionLink) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: `I could not bind #${selectedReviewItem.rank} to an immutable Messages transcript snapshot after drafting, so I discarded the wording and did not create any send controls. Ask me to review recent texts again.`,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'blocked recent-review action creation without an immutable transcript link',
        ['review_snapshot_link:missing'],
      ),
      followupActions: [],
    };
  }

  const reviewOperation = earlyReviewOperation;
  const reviewActionSourceKey = selectedReviewItem
    ? selectedReviewItem.itemId ||
      selectedReviewItem.communicationThreadId ||
      draft.thread?.id ||
      null
    : null;
  const reusableReviewAction =
    reviewOperation && reviewActionSourceKey
      ? getMessageActionBySource(
          context.groupFolder,
          'communication_thread',
          reviewActionSourceKey,
        )
      : undefined;
  const messageAction =
    context.channel === 'alexa' || !context.chatJid
      ? undefined
      : namedSummaryTarget?.target.isGroup
        ? undefined
        : namedSummaryTarget
          ? (() => {
              const dedupeSeed = clipText(
                normalizeText(draft.draftText || replyText).toLowerCase(),
                80,
              );
              const exactCommunicationThreadId =
                draft.thread?.channel === 'bluebubbles' &&
                draft.thread.channelChatJid ===
                  namedSummaryTarget.target.chatJid
                  ? draft.thread.id
                  : undefined;
              return createOrRefreshMessageActionFromDraft({
                groupFolder: context.groupFolder,
                presentationChannel: context.channel,
                presentationChatJid: context.chatJid,
                presentationThreadId: null,
                sourceType: 'manual_prompt',
                sourceKey: `named-messages-summary-draft:${namedSummaryTarget.target.chatJid}:${dedupeSeed}`,
                sourceSummary:
                  draft.summaryText ||
                  `Draft text message to ${namedSummaryTarget.target.displayName}.`,
                draftProvenance: draft.draftProvenance,
                draftText: draft.draftText || replyText,
                personName: namedSummaryTarget.target.displayName,
                threadTitle: namedSummaryTarget.target.displayName,
                communicationThreadId: exactCommunicationThreadId,
                communicationContext: 'reply_followthrough',
                namedMessagesSummary: buildNamedMessagesSummaryActionLink({
                  validation: namedSummaryTarget,
                  groupFolder: context.groupFolder,
                  presentationChatJid: context.chatJid,
                }),
                forceApproval: true,
                targetOverride: {
                  kind: 'external_thread',
                  chatJid: namedSummaryTarget.target.chatJid,
                  threadId: null,
                  replyToMessageId: null,
                  isGroup: namedSummaryTarget.target.isGroup,
                  personName: namedSummaryTarget.target.displayName,
                  blueBubblesCreateChatAddress:
                    namedSummaryTarget.target.blueBubblesCreateChatAddress,
                },
                targetChannelOverride: 'bluebubbles',
                now: context.now,
              });
            })()
          : draft.thread?.id
            ? reusableReviewAction &&
              reusableReviewAction.sendStatus !== 'sent' &&
              reusableReviewAction.sendStatus !== 'skipped'
              ? reusableReviewAction
              : createOrRefreshMessageActionFromDraft({
                  groupFolder: context.groupFolder,
                  presentationChannel: context.channel,
                  presentationChatJid: context.chatJid,
                  presentationThreadId: priorContextForDraft?.threadId || null,
                  sourceType: 'communication_thread',
                  sourceKey:
                    reviewActionSourceKey ||
                    selectedReviewItem?.communicationThreadId ||
                    draft.thread.id,
                  sourceSummary:
                    selectedReviewItem?.summaryText ||
                    draft.summaryText ||
                    'Drafted reply',
                  draftProvenance: draft.draftProvenance,
                  draftText: draft.draftText || replyText,
                  personName:
                    selectedReviewItem?.chatLabel ||
                    draft.linkedSubjects[0]?.displayName ||
                    draft.thread.title,
                  threadTitle:
                    selectedReviewItem?.chatLabel ||
                    draft.linkedLifeThreads[0]?.title ||
                    draft.thread.title,
                  communicationThreadId:
                    selectedReviewItem?.communicationThreadId ||
                    draft.thread.id,
                  threadId: draft.linkedLifeThreads[0]?.id,
                  communicationContext: 'reply_followthrough',
                  recentTextReview: recentTextReviewActionLink,
                  forceApproval: Boolean(selectedReviewItem),
                  targetOverride:
                    selectedReviewItem && selectedReviewTarget?.ok
                      ? {
                          kind: 'external_thread',
                          chatJid: selectedReviewTarget.chatJid!,
                          threadId: null,
                          replyToMessageId: null,
                          isGroup: selectedReviewTarget.isGroup || false,
                          personName:
                            selectedReviewTarget.personName ||
                            selectedReviewItem.chatLabel,
                        }
                      : null,
                  targetChannelOverride:
                    selectedReviewTargetChannel ??
                    (selectedReviewItem
                      ? selectedReviewItem.sourceChannel === 'telegram'
                        ? 'telegram'
                        : selectedReviewItem.sourceChannel === 'bluebubbles'
                          ? 'bluebubbles'
                          : selectedReviewTarget?.chatJid?.startsWith('tg:')
                            ? 'telegram'
                            : selectedReviewTarget?.chatJid?.startsWith('bb:')
                              ? 'bluebubbles'
                              : null
                      : null),
                  now: context.now,
                })
            : context.channel === 'bluebubbles' &&
                draft.linkedSubjects[0]?.displayName
              ? (() => {
                  const resolvedTarget = resolveBlueBubblesThreadTargetByName(
                    draft.linkedSubjects[0]!.displayName,
                  );
                  if (resolvedTarget.state !== 'resolved') {
                    return undefined;
                  }
                  const dedupeSeed = clipText(
                    normalizeText(draft.draftText || replyText).toLowerCase(),
                    80,
                  );
                  return createOrRefreshMessageActionFromDraft({
                    groupFolder: context.groupFolder,
                    presentationChannel: 'bluebubbles',
                    presentationChatJid: context.chatJid,
                    presentationThreadId:
                      priorContextForDraft?.threadId || null,
                    sourceType: 'manual_prompt',
                    sourceKey: `bluebubbles-channel-draft:${resolvedTarget.target.chatJid}:${dedupeSeed}`,
                    sourceSummary:
                      draft.summaryText ||
                      `Draft text message to ${resolvedTarget.target.displayName}.`,
                    draftProvenance: draft.draftProvenance,
                    draftText: draft.draftText || replyText,
                    personName: resolvedTarget.target.displayName,
                    threadTitle:
                      draft.linkedLifeThreads[0]?.title ||
                      resolvedTarget.target.displayName,
                    threadId: draft.linkedLifeThreads[0]?.id,
                    communicationContext: 'general',
                    targetOverride: {
                      kind: 'external_thread',
                      chatJid: resolvedTarget.target.chatJid,
                      threadId: null,
                      replyToMessageId: null,
                      isGroup: resolvedTarget.target.isGroup,
                      personName: resolvedTarget.target.displayName,
                    },
                    targetChannelOverride: 'bluebubbles',
                    now: context.now,
                  });
                })()
              : undefined;

  let finalReplyText = namedSummaryTarget?.target.isGroup
    ? `${replyText}\n\nGroup draft only: this is unsent and not sendable from Andrea. I did not create any send controls.`
    : replyText;
  let finalMessageAction = messageAction;
  let finalSendOptions:
    | Pick<SendMessageOptions, 'inlineActions' | 'inlineActionRows'>
    | undefined;
  const operationChatJid =
    context.chatJid || messageAction?.presentationChatJid;
  if (reviewOperation && messageAction && operationChatJid) {
    const operationResult = await applyMessageActionOperation(
      messageAction.messageActionId,
      reviewOperation,
      {
        groupFolder: context.groupFolder,
        channel: context.channel,
        chatJid: operationChatJid,
        currentTime: context.now,
        sendToTarget: async () => {
          throw new Error('recent text review follow-up cannot send messages');
        },
      },
    );
    if (operationResult.handled) {
      finalMessageAction = operationResult.action || messageAction;
      finalReplyText =
        operationResult.replyText ||
        operationResult.presentation?.text ||
        finalReplyText;
      if (operationResult.presentation?.inlineActionRows.length) {
        finalSendOptions = {
          inlineActionRows: operationResult.presentation.inlineActionRows,
        };
      }
    }
  }
  if (selectedReviewItem && finalMessageAction) {
    recordRecentTextReviewOutcome({
      groupFolder: context.groupFolder,
      item: selectedReviewItem,
      outcome: mapRecentTextReviewFollowupToOutcome(reviewItemFollowup),
      now: context.now,
      timingHint: reviewItemFollowup?.timingHint || null,
    });
  }

  const continuationCandidate = buildCommunicationContinuationCandidate({
    descriptor,
    summaryText: draft.summaryText || 'I drafted a reply.',
    detailText: formatCommunicationDraftReply('telegram', draft),
    threadId: draft.linkedLifeThreads[0]?.id,
    threadTitle: draft.linkedLifeThreads[0]?.title || draft.thread?.title,
    communicationThreadId: draft.thread?.id,
    communicationSubjectIds: draft.linkedSubjects.map((subject) => subject.id),
    communicationLifeThreadIds: draft.linkedLifeThreads.map(
      (thread) => thread.id,
    ),
    messageActionId: finalMessageAction?.messageActionId,
    messageActionSummary: finalMessageAction?.sourceSummary || undefined,
  });
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: finalReplyText,
    sendOptions: finalSendOptions,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildCommunicationConversationSeed({
      descriptor,
      summaryText: draft.summaryText || 'I drafted a reply.',
      conversationFocus:
        selectedReviewItem?.summaryText ||
        rawCommunicationText ||
        draft.summaryText ||
        '',
      personName: namedSummaryTarget?.target.isGroup
        ? undefined
        : namedSummaryTarget?.target.displayName ||
          draft.linkedSubjects[0]?.displayName,
      threadId: draft.linkedLifeThreads[0]?.id,
      threadTitle:
        namedSummaryTarget?.target.displayName ||
        draft.linkedLifeThreads[0]?.title ||
        draft.thread?.title,
      communicationThreadId:
        selectedReviewItem?.communicationThreadId ||
        (namedSummaryTarget &&
        (draft.thread?.channel !== 'bluebubbles' ||
          draft.thread.channelChatJid !== namedSummaryTarget.target.chatJid)
          ? undefined
          : draft.thread?.id),
      communicationSubjectIds: draft.linkedSubjects.map(
        (subject) => subject.id,
      ),
      communicationLifeThreadIds: draft.linkedLifeThreads.map(
        (thread) => thread.id,
      ),
      lastCommunicationSummary: draft.summaryText,
      namedMessagesSummaryTargetJson: namedSummaryTarget?.seedJson,
      recentTextReviewJson: context.priorSubjectData?.recentTextReviewJson,
      messageActionId: finalMessageAction?.messageActionId,
      messageActionSummary: finalMessageAction?.sourceSummary || undefined,
      continuationCandidate,
      supportedFollowups,
    }),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'built a relationship-aware reply draft',
      [draft.style],
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    messageAction: finalMessageAction,
    outcomeMetadata: selectedReviewItem
      ? {
          source: 'recent_text_review',
          outcomeKind: mapRecentTextReviewFollowupToOutcome(reviewItemFollowup),
          handled: true,
          capabilityId: descriptor.id,
          messageActionId: finalMessageAction?.messageActionId,
          sendStatus: finalMessageAction?.sendStatus,
          lastActionKind: finalMessageAction?.lastActionKind || null,
          itemId: selectedReviewItem.itemId,
          itemRank: selectedReviewItem.rank,
        }
      : undefined,
  };
}

async function runCommunicationOpenLoopsCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const rawCommunicationText = input.text || input.canonicalText || '';
  const openLoops = buildCommunicationOpenLoops({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    text: rawCommunicationText,
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: context.priorSubjectData,
    now: context.now,
  });
  const replyText = formatCommunicationOpenLoopsReply(
    context.channel,
    openLoops,
  );
  const firstItem = openLoops.items[0];
  const continuationCandidate = firstItem
    ? buildCommunicationContinuationCandidate({
        descriptor,
        summaryText: openLoops.summaryText,
        detailText: formatCommunicationOpenLoopsReply('telegram', openLoops),
        communicationThreadId: firstItem.threadId,
        threadTitle: firstItem.title,
      })
    : undefined;
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildCommunicationConversationSeed({
      descriptor,
      summaryText: openLoops.summaryText,
      conversationFocus:
        input.canonicalText || input.text || openLoops.summaryText,
      personName: firstItem?.personName,
      threadTitle: firstItem?.title,
      communicationThreadId: firstItem?.threadId,
      lastCommunicationSummary: firstItem?.summaryText,
      continuationCandidate,
      supportedFollowups,
    }),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'summarized communication open loops',
      openLoops.items.map((item) => item.title),
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate?.handoffPayload,
    continuationCandidate,
  };
}

async function runCommunicationManageCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const rawCommunicationText = input.text || input.canonicalText || '';
  const result = manageCommunicationTracking({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    text: rawCommunicationText,
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: context.priorSubjectData,
    now: context.now,
  });

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildCommunicationConversationSeed({
      descriptor,
      summaryText: result.replyText,
      conversationFocus: input.canonicalText || input.text || result.replyText,
      threadTitle: result.thread?.title,
      communicationThreadId: result.thread?.id,
      communicationSubjectIds: result.thread?.linkedSubjectIds,
      communicationLifeThreadIds: result.thread?.linkedLifeThreadIds,
      lastCommunicationSummary:
        result.thread?.lastInboundSummary ||
        result.thread?.lastOutboundSummary ||
        result.replyText,
      supportedFollowups: descriptor.followupActions,
    }),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'updated communication tracking state',
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runChiefOfStaffCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
  mode:
    | 'prioritize'
    | 'plan_horizon'
    | 'prepare'
    | 'decision_support'
    | 'explain'
    | 'configure',
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const text = input.canonicalText || input.text || '';
  const tasks = getAllTasks().filter(
    (task) => task.group_folder === context.groupFolder,
  );
  const result = await buildChiefOfStaffTurn({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    text,
    mode,
    now: context.now,
    tasks,
    selectedWork: context.selectedWork || null,
    priorChiefOfStaffContextJson:
      context.priorSubjectData?.chiefOfStaffContextJson,
    priorCommunicationSubjectIds:
      context.priorSubjectData?.communicationSubjectIds,
    priorKnowledgeSourceIds: context.priorSubjectData?.knowledgeSourceIds,
    groundedSnapshot: context.groundedSnapshot,
    lifeThreadSnapshot: context.lifeThreadSnapshot,
  });
  const continuationCandidate = buildChiefOfStaffContinuationCandidate({
    descriptor,
    summaryText: result.summaryText,
    detailText: result.detailText,
    chiefOfStaffContext: result.context,
    threadId: result.snapshot.mainSignal?.relatedThreadId || undefined,
    threadTitle: result.snapshot.mainSignal?.title,
    communicationThreadId:
      result.snapshot.mainSignal?.relatedCommunicationThreadId || undefined,
  });
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildChiefOfStaffConversationSeed({
      descriptor,
      summaryText: result.summaryText,
      conversationFocus: text || result.summaryText,
      chiefOfStaffContext: result.context,
      continuationCandidate,
      supportedFollowups,
    }),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      `handled by chief-of-staff in ${mode} mode`,
      result.snapshot.signalsUsed,
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
  };
}

async function runUsefulDailyCommandCenterCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = buildUsefulDailyCommandCenter({
    groupFolder: context.groupFolder,
    now: context.now,
  });
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? result.replyText.replace(/\n+/g, ' ').slice(0, 700)
        : result.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: {
      flowKey: 'daily_command_center',
      subjectKind: 'day_brief',
      summaryText: 'Andrea reviewed the useful daily command center.',
      guidanceGoal: 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        followthroughReviewJson: result.reviewSeedJson,
        lastAnswerSummary: 'Daily command center reviewed.',
        lastRecommendation:
          result.selectedFollowthrough?.safeNextAction ||
          'Review what needs reply, what can wait, and what is safe to track.',
        conversationFocus: 'daily command center',
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
      hasActionItem: true,
      reminderCandidate: Boolean(result.selectedFollowthrough),
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'composed useful daily command center',
      [
        `needs_reply: ${result.counts.needsReply}`,
        `ready_followthrough: ${result.counts.readyFollowthrough}`,
        `can_wait: ${result.counts.canWait}`,
      ],
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runMissionCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
  mode: 'propose' | 'view' | 'execute' | 'manage' | 'explain',
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const text = input.canonicalText || input.text || '';

  const apprenticeshipReply = handleDeepWorkApprenticeshipCommand({
    groupFolder: context.groupFolder,
    text,
    ownerReviewAllowed: context.ownerReviewAllowed,
    now: context.now,
  });
  if (apprenticeshipReply) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: apprenticeshipReply,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'handled owner-reviewed deep-work apprenticeship command',
      ),
      followupActions: descriptor.followupActions,
    };
  }

  const carryMissionIntoResult = (params: {
    summaryText: string;
    detailText: string;
    missionId: string;
    missionSummary: string;
    blockers: string[];
    suggestedActions: MissionSuggestedAction[];
    stepFocus?: MissionExecutionContext['stepFocus'];
    replyText: string;
  }): AssistantCapabilityResult => {
    const continuationCandidate = buildMissionContinuationCandidate({
      descriptor,
      summaryText: params.summaryText,
      detailText: params.detailText,
      missionId: params.missionId,
      missionSummary: params.missionSummary,
      blockers: params.blockers,
      suggestedActions: params.suggestedActions,
      stepFocus: params.stepFocus,
      threadId: context.priorSubjectData?.threadId,
      threadTitle: context.priorSubjectData?.threadTitle,
      communicationThreadId: context.priorSubjectData?.communicationThreadId,
      communicationSubjectIds:
        context.priorSubjectData?.communicationSubjectIds,
      communicationLifeThreadIds:
        context.priorSubjectData?.communicationLifeThreadIds,
      knowledgeSourceIds: context.priorSubjectData?.knowledgeSourceIds,
      knowledgeSourceTitles: context.priorSubjectData?.knowledgeSourceTitles,
    });
    const supportedFollowups = extendCompanionFollowups(
      descriptor.followupActions,
      continuationCandidate,
    );
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: params.replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildMissionConversationSeed({
        descriptor,
        summaryText: params.summaryText,
        conversationFocus: text || params.summaryText,
        continuationCandidate,
        supportedFollowups,
      }),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        `handled by missions in ${mode} mode`,
      ),
      followupActions: supportedFollowups,
      handoffPayload: continuationCandidate.handoffPayload,
      continuationCandidate,
    };
  };

  if (mode !== 'execute') {
    const result = await buildMissionTurn({
      channel: context.channel,
      groupFolder: context.groupFolder,
      chatJid: context.chatJid,
      text,
      mode,
      conversationSummary: context.conversationSummary,
      replyText: context.replyText,
      selectedWork: context.selectedWork || null,
      priorContext: context.priorSubjectData,
      now: context.now,
    });
    return carryMissionIntoResult({
      summaryText: result.summaryText,
      detailText: result.detailText,
      missionId: result.mission.missionId,
      missionSummary: result.mission.summary,
      blockers: result.blockers,
      suggestedActions: result.suggestedActions,
      stepFocus: result.stepFocus,
      replyText: result.replyText,
    });
  }

  const missionId = context.priorSubjectData?.missionId;
  if (!missionId) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'I do not have a specific plan in view yet. Ask me to make a plan first.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'mission execution requested without an active mission context',
      ),
    };
  }
  const executionContext = buildMissionExecutionContext(missionId);
  if (!executionContext) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: 'I cannot find that plan anymore, so let me rebuild it first.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'mission execution context was missing',
      ),
    };
  }
  const actionKind = pickMissionActionFromUtterance({
    utterance: text,
    suggestedActions:
      executionContext.suggestedActions.length > 0
        ? executionContext.suggestedActions
        : parseJsonSafe<MissionSuggestedAction[]>(
            context.priorSubjectData?.missionSuggestedActionsJson,
            [],
          ),
  });
  if (!actionKind) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'Tell me whether you want me to remind you, draft it, save it, or track it.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'mission execution request had no actionable target',
      ),
    };
  }

  let replyText = 'Okay.';
  let linkedReminderId: string | null = null;
  let linkedKnowledgeSourceId: string | null = null;
  let linkedLifeThreadId: string | null = null;
  let linkedCurrentWorkJson: string | null = null;

  if (actionKind === 'create_reminder') {
    if (!context.chatJid) {
      replyText =
        'I can set that up when we are in a chat context that can hold the reminder.';
    } else {
      const timing =
        executionContext.mission.dueHorizon === 'tonight'
          ? 'today evening'
          : executionContext.mission.dueHorizon === 'tomorrow'
            ? 'tomorrow morning'
            : executionContext.mission.dueHorizon === 'weekend'
              ? 'tomorrow evening'
              : 'today evening';
      const reminderTarget = executionContext.stepFocus?.title
        ? `${executionContext.stepFocus.title.charAt(0).toLowerCase()}${executionContext.stepFocus.title.slice(1)}`
        : executionContext.mission.summary ||
          executionContext.mission.objective;
      const plannedReminder = planContextualReminder(
        timing,
        reminderTarget,
        context.groupFolder,
        context.chatJid,
        context.now,
      );
      if (!plannedReminder) {
        replyText = 'I could not turn that into a reminder yet.';
      } else {
        createTask(plannedReminder.task);
        linkedReminderId = plannedReminder.task.id;
        replyText = plannedReminder.confirmation;
      }
    }
  } else if (actionKind === 'draft_follow_up') {
    const personName =
      context.priorSubjectData?.personName ||
      parseJsonSafe<{ personName?: string }>(
        executionContext.suggestedActions[0]?.linkedRefJson,
        {},
      ).personName;
    const draft =
      context.channel === 'bluebubbles'
        ? await draftCommunicationReplyWithChannelFluidity({
            channel: context.channel,
            groupFolder: context.groupFolder,
            chatJid: context.chatJid,
            text: text || `draft a reply to ${personName || 'them'}`,
            replyText:
              executionContext.mission.summary ||
              context.replyText ||
              context.conversationSummary,
            conversationSummary: executionContext.mission.summary,
            priorContext: {
              personName,
              communicationThreadId:
                context.priorSubjectData?.communicationThreadId,
              communicationSubjectIds:
                context.priorSubjectData?.communicationSubjectIds,
              communicationLifeThreadIds:
                context.priorSubjectData?.communicationLifeThreadIds,
              lastCommunicationSummary:
                context.priorSubjectData?.lastCommunicationSummary ||
                executionContext.mission.summary,
            },
            now: context.now,
          })
        : draftCommunicationReply({
            channel: context.channel,
            groupFolder: context.groupFolder,
            chatJid: context.chatJid,
            text: text || `draft a reply to ${personName || 'them'}`,
            replyText:
              executionContext.mission.summary ||
              context.replyText ||
              context.conversationSummary,
            conversationSummary: executionContext.mission.summary,
            priorContext: {
              personName,
              communicationThreadId:
                context.priorSubjectData?.communicationThreadId,
              communicationSubjectIds:
                context.priorSubjectData?.communicationSubjectIds,
              communicationLifeThreadIds:
                context.priorSubjectData?.communicationLifeThreadIds,
              lastCommunicationSummary:
                context.priorSubjectData?.lastCommunicationSummary ||
                executionContext.mission.summary,
            },
            now: context.now,
          });
    replyText = draft.draftText
      ? formatCommunicationDraftReply(context.channel, draft)
      : draft.clarificationQuestion ||
        'I need a little more context before I draft that.';
  } else if (actionKind === 'save_to_library') {
    const saved = saveKnowledgeSource({
      groupFolder: context.groupFolder,
      sourceType: 'generated_note',
      title: executionContext.mission.title,
      content:
        executionContext.mission.summary +
        '\n\n' +
        executionContext.steps
          .map(
            (step) =>
              `${step.position}. ${step.title}${step.detail ? ` - ${step.detail}` : ''}`,
          )
          .join('\n'),
      sourceChannel: context.channel,
      shortSummary: executionContext.mission.summary,
      now: context.now,
    });
    replyText = saved.message;
    linkedKnowledgeSourceId = saved.source?.sourceId || null;
  } else if (actionKind === 'link_thread') {
    const threadTitle =
      context.priorSubjectData?.threadTitle ||
      parseJsonSafe<{ threadTitle?: string }>(
        executionContext.suggestedActions[0]?.linkedRefJson,
        {},
      ).threadTitle;
    const threadResult = handleLifeThreadCommand({
      groupFolder: context.groupFolder,
      channel: context.channel,
      messageId: context.currentMessageId,
      text: threadTitle
        ? `track this under ${threadTitle} thread`
        : 'save this for later',
      replyText: executionContext.mission.summary,
      conversationSummary: executionContext.mission.summary,
      now: context.now,
    });
    replyText = threadResult.responseText || 'Okay.';
    linkedLifeThreadId = threadResult.referencedThread?.id || null;
  } else if (actionKind === 'pin_to_ritual') {
    const ritualResult = handleRitualCommand({
      groupFolder: context.groupFolder,
      channel: context.channel,
      text: 'make this part of my evening reset',
      replyText: executionContext.mission.summary,
      conversationSummary: executionContext.mission.summary,
      priorContext:
        executionContext.mission.linkedLifeThreadIds.length > 0
          ? { usedThreadIds: executionContext.mission.linkedLifeThreadIds }
          : undefined,
      now: context.now,
    });
    replyText = ritualResult.responseText || 'Okay.';
  } else if (actionKind === 'reference_current_work') {
    linkedCurrentWorkJson =
      executionContext.mission.linkedCurrentWorkJson ||
      (context.selectedWork ? JSON.stringify(context.selectedWork) : null);
    replyText = executionContext.mission.linkedCurrentWorkJson
      ? 'I kept the current work context attached to this plan.'
      : 'I do not have an active current-work selection tied to this plan yet.';
  } else if (actionKind === 'start_research') {
    const researchResult = await executeAssistantCapability({
      capabilityId: inferResearchCapabilityId(
        executionContext.mission.objective,
      ),
      context: {
        ...context,
        channel: context.channel === 'alexa' ? 'telegram' : context.channel,
      },
      input: {
        text: executionContext.mission.objective,
        canonicalText: executionContext.mission.objective,
      },
    });
    replyText =
      researchResult.replyText || 'I could not start that research cleanly.';
  }

  const updatedMission = updateMissionAfterExecution({
    missionId: executionContext.mission.missionId,
    actionKind,
    linkedReminderId,
    linkedKnowledgeSourceId,
    linkedLifeThreadId,
    linkedCurrentWorkJson,
  });
  const refreshed = buildMissionExecutionContext(
    updatedMission?.missionId || executionContext.mission.missionId,
  );
  const blockers = parseJsonSafe<string[]>(
    updatedMission?.blockersJson ||
      context.priorSubjectData?.missionBlockersJson,
    [],
  );
  const nextSuggestion =
    refreshed?.suggestedActions[0]?.label ||
    refreshed?.stepFocus?.title ||
    null;
  const stillOpen =
    refreshed?.stepFocus?.title ||
    blockers[0] ||
    (updatedMission?.status === 'completed' ? null : updatedMission?.summary) ||
    executionContext.mission.summary;
  const detailText = buildSignatureFlowText({
    lead: updatedMission?.summary || executionContext.mission.summary,
    detailLines: [
      refreshed?.stepFocus
        ? `Remaining step: ${refreshed.stepFocus.title}${
            refreshed.stepFocus.detail ? ` - ${refreshed.stepFocus.detail}` : ''
          }`
        : null,
      blockers[0] ? `Blocker: ${blockers[0]}` : null,
    ],
    nextAction: nextSuggestion,
    whyLine: refreshed?.stepFocus
      ? 'This is the next open step on the plan.'
      : blockers[0]
        ? 'There is still one blocker worth clearing.'
        : undefined,
  });
  const replyTextWithContinuity = buildSignaturePostActionConfirmation({
    channel: context.channel,
    didWhat: replyText,
    stillOpen: updatedMission?.status === 'completed' ? null : stillOpen,
    nextSuggestion:
      updatedMission?.status === 'completed'
        ? 'Come back if you want me to turn the next goal into a plan.'
        : nextSuggestion,
  });
  return carryMissionIntoResult({
    summaryText: updatedMission?.summary || executionContext.mission.summary,
    detailText,
    missionId: executionContext.mission.missionId,
    missionSummary: updatedMission?.summary || executionContext.mission.summary,
    blockers,
    suggestedActions:
      refreshed?.suggestedActions || executionContext.suggestedActions,
    stepFocus: refreshed?.stepFocus || executionContext.stepFocus,
    replyText: replyTextWithContinuity,
  });
}

async function runMediaCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const prompt = input.canonicalText || input.text || '';
  if (!prompt.trim()) return { handled: false };

  if (descriptor.id === 'media.analyze') {
    const selectedAttachments = context.currentAttachmentIds?.length
      ? listMessageMediaAttachments({
          attachmentIds: context.currentAttachmentIds,
          limit: Math.max(4, context.currentAttachmentIds.length),
        })
      : context.chatJid && context.currentMessageId
        ? listMessageMediaAttachments({
            chatJid: context.chatJid,
            messageId: context.currentMessageId,
            limit: 20,
          })
        : context.chatJid
          ? listMessageMediaAttachments({
              chatJid: context.chatJid,
              limit: 50,
            })
          : [];
    const recentAttachments = selectedAttachments
      .filter(
        (attachment) =>
          attachment.kind === 'image' || attachment.kind === 'video',
      )
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt || right.createdAt || '') -
          Date.parse(left.updatedAt || left.createdAt || ''),
      )
      .slice(0, 4);
    const analysis = await analyzeMessageMedia({
      attachmentIds: recentAttachments.map(
        (attachment) => attachment.attachmentId,
      ),
      prompt,
      requester: 'andrea',
    });
    const replyText =
      analysis.summaryText ||
      analysis.blocker ||
      'I could not analyze any recent image or video yet.';
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        analysis.handled ? 'media_openai' : 'unavailable',
        analysis.handled
          ? 'analyzed recent inbound media with the shared media analysis path'
          : analysis.blocker || 'media analysis unavailable',
        analysis.debugPath,
      ),
    };
  }

  if (descriptor.id !== 'media.image_generate') {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        context.channel === 'alexa'
          ? 'That media workflow is still a future hook.'
          : 'That media workflow is still prepared, but not implemented yet.',
      outputShape:
        context.channel === 'alexa'
          ? 'voice_brief'
          : descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'unavailable',
        'media workflow is still a future hook',
      ),
    };
  }

  const mediaResult = await runImageGeneration({
    prompt,
    channel: context.channel,
    groupFolder: context.groupFolder,
  });
  const continuationCandidate = buildMediaContinuationCandidate(
    descriptor,
    prompt,
    mediaResult,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: mediaResult.replyText || mediaResult.summaryText || 'Okay.',
    outputShape:
      context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    mediaResult,
    handoffOffer:
      context.channel === 'alexa'
        ? 'I can generate that and send it to Telegram.'
        : undefined,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'saved_item',
      summaryText:
        mediaResult.summaryText ||
        mediaResult.replyText ||
        normalizeText(prompt),
      guidanceGoal: 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary:
          mediaResult.summaryText ||
          mediaResult.replyText ||
          normalizeText(prompt),
        conversationFocus: normalizeText(prompt),
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
      supportedFollowups,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      context.channel === 'alexa'
        ? 'media_handoff'
        : mediaResult.providerUsed === 'openai_images'
          ? 'media_openai'
          : 'unavailable',
      mediaResult.routeExplanation,
      mediaResult.debugPath,
    ),
    followupActions: supportedFollowups,
  };
}

async function runPulseCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const preference = getDefaultPulsePreference();
  const toneProfile = getToneProfileForContext(context);
  const result = buildAndreaPulseReply({
    channel: context.channel,
    query: input.canonicalText || input.text || descriptor.label,
    toneProfile,
    now: context.now,
    previousSummary: context.conversationSummary,
  });
  const notes = [`mode: ${preference.mode}`, `item: ${result.item.id}`];
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.summaryText,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary: result.summaryText,
        conversationFocus: result.item.title,
        toneProfile,
      },
      supportedFollowups: descriptor.followupActions,
      responseStyle: 'default',
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'pulse_local',
      'handled by local Andrea Pulse catalog',
      notes,
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runPilotCaptureCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'I can only save pilot issues from a registered assistant context.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'unavailable',
        'pilot issue capture requires a registered assistant context',
      ),
    };
  }

  const capture = capturePilotIssue({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    threadId: context.threadHint || context.priorSubjectData?.threadId,
    utterance: input.canonicalText || input.text || '',
    routeKey: descriptor.id,
    assistantContextSummary:
      context.priorSubjectData?.lastAnswerSummary ||
      context.conversationSummary ||
      context.replyText ||
      '',
    linkedRefs: {
      missionId: context.priorSubjectData?.missionId,
      lifeThreadId: context.priorSubjectData?.threadId,
      communicationThreadId: context.priorSubjectData?.communicationThreadId,
      knowledgeSourceIds: context.priorSubjectData?.knowledgeSourceIds,
      currentWorkRef: context.selectedWork
        ? `${context.selectedWork.laneLabel}: ${context.selectedWork.title}`
        : undefined,
    },
  });

  return {
    handled: capture.handled,
    capabilityId: descriptor.id,
    replyText: capture.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      capture.record ? 'local_companion' : 'unavailable',
      capture.record
        ? 'captured a private pilot issue'
        : 'pilot issue capture was unavailable',
    ),
  };
}

async function runEverydayCaptureCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'I need your registered Andrea context before I can manage lists for you.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'unavailable',
        'everyday capture requires a registered assistant context',
      ),
    };
  }

  // Preserve the raw user utterance for list handling so an upstream
  // capability canonicalization cannot turn an explicit read ask into an
  // update flow before everyday-capture gets to interpret it.
  const utterance = input.text || input.canonicalText || '';
  const result = await handleEverydayCaptureCommand({
    channel: context.channel,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    text: utterance,
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: {
      activeListGroupId: context.priorSubjectData?.activeListGroupId,
      activeListItemIds: context.priorSubjectData?.activeListItemIds,
      activeListScope: context.priorSubjectData?.activeListScope,
      activeOperatingProfileId:
        context.priorSubjectData?.activeOperatingProfileId,
      activeTaskKind: context.priorSubjectData?.activeTaskKind,
      conversationFocus: context.priorSubjectData?.conversationFocus,
      lastAnswerSummary: context.priorSubjectData?.lastAnswerSummary,
      threadId: context.priorSubjectData?.threadId,
      threadTitle: context.priorSubjectData?.threadTitle,
    },
    now: context.now,
  });
  if (!result.handled) {
    return { handled: false };
  }

  const supportedFollowups =
    result.supportedFollowups || descriptor.followupActions;
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.replyText,
    sendOptions: result.sendOptions,
    outputShape:
      result.mode === 'read_items' && context.channel === 'telegram'
        ? 'chat_rich'
        : descriptor.preferredOutputShape[context.channel],
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: result.subjectKind || 'saved_item',
      summaryText: result.summaryText || result.replyText || descriptor.label,
      guidanceGoal:
        result.mode === 'profile_setup' || result.mode === 'profile_review'
          ? 'open_conversation'
          : 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary:
          result.summaryText || result.replyText || descriptor.label,
        conversationFocus: result.summaryText || utterance,
        activeListGroupId: result.conversationData?.activeListGroupId,
        activeListItemIds: result.conversationData?.activeListItemIds,
        activeListScope: result.conversationData?.activeListScope,
        activeOperatingProfileId:
          result.conversationData?.activeOperatingProfileId,
        activeTaskKind: result.conversationData?.activeTaskKind,
      },
      supportedFollowups,
      responseSource: 'local_companion',
    },
    handoffOffer:
      context.channel === 'alexa'
        ? result.handoffOffer || undefined
        : undefined,
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      `handled by everyday capture in ${result.mode || 'unknown'} mode`,
      result.listItems?.slice(0, 3).map((item) => item.title) || [],
    ),
    followupActions: supportedFollowups,
  };
}

const CAPABILITY_DESCRIPTORS: AssistantCapabilityDescriptor[] = [
  {
    id: 'daily.morning_brief',
    label: 'Morning Brief',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[0]!,
        cloneContext(context),
        input,
        'what should I know about today',
        buildDailySeed(
          'daily.morning_brief',
          'daily_morning_brief',
          'today and what matters most',
          'daily_brief',
          {
            subjectKind: 'day_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.whats_next',
    label: "What's Next",
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[1]!,
        cloneContext(context),
        input,
        'what should I do next',
        buildDailySeed(
          'daily.whats_next',
          'daily_whats_next',
          'what should you do next',
          'next_action',
          {
            subjectKind: 'event',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.loose_ends',
    label: 'Loose Ends',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[2]!,
        cloneContext(context),
        input,
        'what am I forgetting',
        buildDailySeed(
          'daily.loose_ends',
          'daily_loose_ends',
          'likely loose ends and what you may be forgetting',
          'what_am_i_forgetting',
          {
            subjectKind: 'day_brief',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.evening_reset',
    label: 'Evening Reset',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'save_that',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[3]!,
        cloneContext(context),
        input,
        'what should I remember tonight',
        buildDailySeed(
          'daily.evening_reset',
          'daily_evening_reset',
          'what to wrap up today and remember tonight',
          'evening_reset',
          {
            subjectKind: 'day_brief',
            prioritizationLens: 'evening',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'household.candace_upcoming',
    label: 'Candace Upcoming',
    category: 'household',
    requiredInputs: [],
    optionalInputs: ['text', 'personName'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'switch_person',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[4]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText ||
            input.text ||
            (input.personName
              ? `what about ${input.personName}`
              : 'what do Candace and I have coming up'),
        },
        'what do Candace and I have coming up',
        buildDailySeed(
          'household.candace_upcoming',
          'candace_upcoming',
          'shared plans and open loops with Candace',
          'shared_plans',
          {
            subjectKind: 'person',
            subjectData: { personName: 'Candace', activePeople: ['Candace'] },
            prioritizationLens: 'family',
            hasActionItem: true,
          },
        ),
      ),
  },
  {
    id: 'household.family_open_loops',
    label: 'Family Open Loops',
    category: 'household',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[5]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText ||
            input.text ||
            'anything for the family I am forgetting',
        },
        'what do I need to follow up on at home',
        buildDailySeed(
          'household.family_open_loops',
          'family_open_loops',
          'family plans, home follow-through, and household carryover',
          'family_guidance',
          {
            subjectKind: 'household',
            subjectData: {
              activePeople: ['Candace', 'Travis'],
              householdFocus: true,
            },
            prioritizationLens: 'family',
            hasActionItem: true,
          },
        ),
      ),
  },
  {
    id: 'followthrough.remind_before_anchor',
    label: 'Remind Before Anchor',
    category: 'followthrough',
    requiredInputs: ['anchor'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote: 'implemented at the channel edge for confirmation safety',
  },
  {
    id: 'followthrough.save_for_later',
    label: 'Save For Later',
    category: 'followthrough',
    requiredInputs: ['content'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote: 'implemented at the channel edge for confirmation safety',
  },
  {
    id: 'followthrough.draft_follow_up',
    label: 'Draft Follow-up',
    category: 'followthrough',
    requiredInputs: ['reference'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote:
      'implemented at the channel edge for shorter drafting workflows',
  },
  {
    id: 'threads.list_open',
    label: 'List Open Threads',
    category: 'threads',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runLifeThreadCapability(
        CAPABILITY_DESCRIPTORS[9]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText || input.text || 'what threads do I have open',
        },
      ),
  },
  {
    id: 'threads.explicit_lookup',
    label: 'Explicit Thread Lookup',
    category: 'threads',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runLifeThreadCapability(
        CAPABILITY_DESCRIPTORS[10]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.explain',
    label: 'Explain Memory Use',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[11]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.remember',
    label: 'Remember',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[12]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.forget',
    label: 'Forget Memory',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[13]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.manual_only',
    label: 'Manual-only Memory Use',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[14]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'pulse.interesting_thing',
    label: 'Interesting Thing',
    category: 'pulse',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runPulseCapability(
        CAPABILITY_DESCRIPTORS[15]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'pulse.surprise_me',
    label: 'Andrea Pulse',
    category: 'pulse',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runPulseCapability(
        CAPABILITY_DESCRIPTORS[16]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.topic',
    label: 'Research Topic',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[17]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.compare',
    label: 'Compare Options',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[18]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.summarize',
    label: 'Summarize Findings',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[19]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.recommend',
    label: 'Recommend Best Choice',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[20]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'work.current_summary',
    label: 'Current Work Summary',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'work.current_output',
    label: 'Current Work Output',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'work.current_logs',
    label: 'Current Work Logs',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'media.image_generate',
    label: 'Generate Image',
    category: 'media',
    requiredInputs: ['prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote:
      'Telegram image generation is wired when OpenAI credentials are configured; Alexa stays handoff-only',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[24]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'media.image_edit',
    label: 'Edit Image',
    category: 'media',
    requiredInputs: ['image', 'prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'artifact_only',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote: 'prepared only; image editing provider is not wired yet',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[25]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'media.video_generate',
    label: 'Generate Video',
    category: 'media',
    requiredInputs: ['prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'artifact_only',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote: 'future hook only; no video provider is wired yet',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[26]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.save_source',
    label: 'Save To Library',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeSaveCapability(
        CAPABILITY_DESCRIPTORS[27]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.list_sources',
    label: 'List Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'shorter', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeListCapability(
        CAPABILITY_DESCRIPTORS[28]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.summarize_saved',
    label: 'Summarize Saved Material',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[29]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.compare_saved',
    label: 'Compare Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[30]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.explain_sources',
    label: 'Explain Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[31]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.disable_source',
    label: 'Disable Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[32]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.delete_source',
    label: 'Delete Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[33]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.reindex_source',
    label: 'Reindex Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[34]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.status',
    label: 'Ritual Status',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualControlCapability(
        CAPABILITY_DESCRIPTORS[35]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.configure',
    label: 'Configure Rituals',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualControlCapability(
        CAPABILITY_DESCRIPTORS[36]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.followthrough',
    label: 'Follow-through View',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualFollowthroughCapability(
        CAPABILITY_DESCRIPTORS[37]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.understand_message',
    label: 'Understand Message',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: ['personName'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
      'draft_follow_up',
      'create_reminder',
      'track_thread',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationUnderstandCapability(
        CAPABILITY_DESCRIPTORS[38]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.draft_reply',
    label: 'Draft Reply',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: ['personName'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['shorter', 'say_more', 'send_details', 'save_for_later'],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationDraftCapability(
        CAPABILITY_DESCRIPTORS[39]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.open_loops',
    label: 'Open Communication Loops',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: ['personName'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'draft_follow_up',
      'create_reminder',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationOpenLoopsCapability(
        CAPABILITY_DESCRIPTORS[40]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.manage_tracking',
    label: 'Manage Communication Tracking',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationManageCapability(
        CAPABILITY_DESCRIPTORS[41]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'staff.prioritize',
    label: 'Chief-of-Staff Priorities',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
      'create_reminder',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[42]!,
        cloneContext(context),
        input,
        'prioritize',
      ),
  },
  {
    id: 'staff.plan_horizon',
    label: 'Chief-of-Staff Planning',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[43]!,
        cloneContext(context),
        input,
        'plan_horizon',
      ),
  },
  {
    id: 'staff.prepare',
    label: 'Chief-of-Staff Prep',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
      'create_reminder',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[44]!,
        cloneContext(context),
        input,
        'prepare',
      ),
  },
  {
    id: 'staff.decision_support',
    label: 'Chief-of-Staff Decision Support',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[45]!,
        cloneContext(context),
        input,
        'decision_support',
      ),
  },
  {
    id: 'staff.explain',
    label: 'Chief-of-Staff Explain',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[46]!,
        cloneContext(context),
        input,
        'explain',
      ),
  },
  {
    id: 'staff.configure',
    label: 'Configure Chief-of-Staff',
    category: 'staff',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runChiefOfStaffCapability(
        CAPABILITY_DESCRIPTORS[47]!,
        cloneContext(context),
        input,
        'configure',
      ),
  },
  {
    id: 'missions.propose',
    label: 'Mission Proposal',
    category: 'missions',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
      'create_reminder',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runMissionCapability(
        CAPABILITY_DESCRIPTORS[48]!,
        cloneContext(context),
        input,
        'propose',
      ),
  },
  {
    id: 'missions.view',
    label: 'Mission View',
    category: 'missions',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'send_details',
      'save_for_later',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runMissionCapability(
        CAPABILITY_DESCRIPTORS[49]!,
        cloneContext(context),
        input,
        'view',
      ),
  },
  {
    id: 'missions.execute',
    label: 'Execute Mission Action',
    category: 'missions',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more', 'send_details'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMissionCapability(
        CAPABILITY_DESCRIPTORS[50]!,
        cloneContext(context),
        input,
        'execute',
      ),
  },
  {
    id: 'missions.manage',
    label: 'Manage Mission',
    category: 'missions',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMissionCapability(
        CAPABILITY_DESCRIPTORS[51]!,
        cloneContext(context),
        input,
        'manage',
      ),
  },
  {
    id: 'missions.explain',
    label: 'Explain Mission',
    category: 'missions',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'send_details'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMissionCapability(
        CAPABILITY_DESCRIPTORS[52]!,
        cloneContext(context),
        input,
        'explain',
      ),
  },
  {
    id: 'pilot.capture_issue',
    label: 'Capture Pilot Issue',
    category: 'pilot',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runPilotCaptureCapability(
        CAPABILITY_DESCRIPTORS[53]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.profile_setup',
    label: 'Everyday Setup',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'anything_else'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[54]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.profile_review',
    label: 'Everyday Setup Review',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'anything_else'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[55]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.add_item',
    label: 'Add Everyday Item',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'create_reminder', 'save_for_later'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[56]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.read_items',
    label: 'Read Everyday Items',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'create_reminder', 'send_details'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[57]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.update_item',
    label: 'Update Everyday Item',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'create_reminder'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[58]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'capture.convert_item',
    label: 'Convert Everyday Item',
    category: 'capture',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'create_reminder', 'send_details'],
    handlerKind: 'local',
    execute: (context, input) =>
      runEverydayCaptureCapability(
        CAPABILITY_DESCRIPTORS[59]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.summarize_thread',
    label: 'Summarize Synced Messages Thread',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: ['targetChatName', 'targetChatJid', 'threadTitle'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'chat_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationThreadSummaryCapability(
        CAPABILITY_DESCRIPTORS[60]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'followthrough.reminder_overview',
    label: 'Reminder Overview',
    category: 'followthrough',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runReminderOverviewCapability(
        CAPABILITY_DESCRIPTORS[61]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.review_recent_texts',
    label: 'Review Recent Texts',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: ['timeWindowKind', 'timeWindowValue'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'chat_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'draft_follow_up',
      'create_reminder',
      'save_for_later',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runRecentTextReviewCapability(
        CAPABILITY_DESCRIPTORS[62]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'daily.command_center',
    label: 'Daily Command Center',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'create_reminder',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context) =>
      runUsefulDailyCommandCenterCapability(
        CAPABILITY_DESCRIPTORS[63]!,
        cloneContext(context),
      ),
  },
  {
    id: 'media.analyze',
    label: 'Analyze Media',
    category: 'media',
    requiredInputs: ['media'],
    optionalInputs: ['prompt'],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'chat_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'say_more'],
    handlerKind: 'edge_only',
    availabilityNote:
      'Analyzes recent inbound image/video attachments when OpenAI vision is configured',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[64]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'communication.manage_identity_links',
    label: 'Review Communication Identities',
    category: 'communication',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'chat_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runCommunicationIdentityReviewCapability(
        CAPABILITY_DESCRIPTORS.find(
          (entry) => entry.id === 'communication.manage_identity_links',
        )!,
        cloneContext(context),
        input,
      ),
  },
];

export function getAssistantCapabilityRegistry(): AssistantCapabilityDescriptor[] {
  return [...CAPABILITY_DESCRIPTORS];
}

export function getAssistantCapability(
  id: AssistantCapabilityId,
): AssistantCapabilityDescriptor | undefined {
  return CAPABILITY_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

export function isAssistantCapabilityAllowed(
  descriptor: AssistantCapabilityDescriptor,
  channel: AssistantCapabilityContext['channel'],
): boolean {
  if (descriptor.operatorOnly) {
    return channel === 'telegram' && descriptor.safeForTelegram;
  }
  if (channel === 'alexa') {
    return descriptor.safeForAlexa;
  }
  if (channel === 'bluebubbles') {
    return descriptor.safeForBlueBubbles;
  }
  return descriptor.safeForTelegram;
}

const OWNER_PRIVATE_MESSAGES_CAPABILITIES = new Set<AssistantCapabilityId>([
  'communication.summarize_thread',
  'communication.review_recent_texts',
]);

function requiresTrustedOwnerMessagesSurface(
  capabilityId: AssistantCapabilityId,
): boolean {
  return OWNER_PRIVATE_MESSAGES_CAPABILITIES.has(capabilityId);
}

export async function executeAssistantCapability(params: {
  capabilityId: AssistantCapabilityId;
  context: AssistantCapabilityContext;
  input?: AssistantCapabilityInput;
}): Promise<AssistantCapabilityResult> {
  const descriptor = getAssistantCapability(params.capabilityId);
  if (!descriptor) {
    return { handled: false };
  }
  if (!isAssistantCapabilityAllowed(descriptor, params.context.channel)) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        params.context.channel === 'alexa'
          ? 'I can help with that in Telegram, but not safely by voice here.'
          : params.context.channel === 'bluebubbles'
            ? 'That one stays on the Telegram or operator side for safety.'
            : 'That action stays on the operator or Telegram side for safety.',
      outputShape:
        params.context.channel === 'alexa' ? 'voice_brief' : 'chat_brief',
      trace: buildCapabilityTrace(
        descriptor,
        params.context,
        'unavailable',
        'blocked by channel safety gate',
      ),
    };
  }
  if (
    requiresTrustedOwnerMessagesSurface(descriptor.id) &&
    params.context.ownerReviewAllowed !== true
  ) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        'I can only review synced Messages in your registered owner control chat. I did not read or summarize any Messages content here.',
      outputShape:
        params.context.channel === 'telegram' ? 'chat_rich' : 'chat_brief',
      trace: buildCapabilityTrace(
        descriptor,
        params.context,
        'unavailable',
        'blocked private Messages review outside a trusted owner surface',
      ),
    };
  }
  if (!descriptor.execute) {
    return { handled: false };
  }
  return descriptor.execute(params.context, params.input || {});
}

export function capabilitySupportsResearch(id: AssistantCapabilityId): boolean {
  return id.startsWith('research.');
}

export function inferResearchCapabilityId(text: string): AssistantCapabilityId {
  const normalized = normalizeText(text).toLowerCase();
  if (
    /\b(compare|versus|vs\.?|tradeoffs?|pros and cons|pros|cons)\b/.test(
      normalized,
    )
  ) {
    return 'research.compare';
  }
  if (
    /\b(best choice|which should i|which one'?s actually better for me|recommend|what should i know before deciding|before deciding|why)\b/.test(
      normalized,
    ) ||
    /\b(?:look\s+for|find)\s+(?:me\s+)?(?:(?:a|an|the|some)\s+)?(?:good|best|right|suitable|recommended)\b/.test(
      normalized,
    )
  ) {
    return 'research.recommend';
  }
  if (/\b(summarize|summarise)\b/.test(normalized)) {
    return 'research.summarize';
  }
  return 'research.topic';
}

export function isSharedResearchRequest(text: string): boolean {
  return isResearchPrompt(text);
}
