import {
  buildBlueBubblesHealthSnapshot,
  buildBlueBubblesWebhookUrl,
  redactBlueBubblesWebhookUrl,
  resolveConfiguredBlueBubblesReplyGateMode,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { readBlueBubblesMonitorState } from './bluebubbles-monitor-state.js';
import { getAlexaModelSyncStatus } from './alexa-model-sync-state.js';
import {
  getAllChats,
  listMessageActionsForGroup,
  listRecentMessagesForChat,
  listRecentResponseFeedback,
} from './db.js';
import {
  listBlueBubblesMessageActionContinuitySnapshots,
  reconcileBlueBubblesMessageActionContinuity,
  reconcileBlueBubblesSelfThreadContinuity,
} from './message-actions.js';
import {
  BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  canonicalizeBlueBubblesSelfThreadJid,
  expandBlueBubblesLogicalSelfThreadJids,
  isBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import { readEnvFile } from './env.js';
import {
  buildGoogleCalendarBlockedProofSurface,
  buildGoogleCalendarNearLiveSurface,
  hasGoogleCalendarCredentialMaterial,
} from './google-calendar-proof.js';
import { resolveGoogleCalendarConfig } from './google-calendar.js';
import {
  assessAlexaLiveProof,
  assessAssistantHealthState,
  assessTelegramRoundtripState,
  DEFAULT_ALEXA_LIVE_PROOF_FRESHNESS_MS,
  DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS,
  formatAlexaProofAgeLabel,
  readHostControlSnapshot,
  reconcileWindowsHostState,
  type HostControlSnapshot,
  type AlexaLiveProofFreshness,
  type AlexaLiveProofKind,
  type WindowsHostReconciliation,
} from './host-control.js';
import { getMediaProviderStatus } from './media-generation.js';
import { resolveBlueBubblesReplyGateMode } from './messages-fluidity.js';
import {
  describeOpenAiConfigBlocker,
  getOpenAiProviderStatus,
} from './openai-provider.js';
import { buildPilotReviewSnapshot } from './pilot-mode.js';
import { readProviderProofState } from './provider-proof-state.js';
import type {
  AppleMessagesBridgeAvailability,
  AppleMessagesProviderName,
  MessageActionRecord,
  PilotJourneyEventRecord,
  PilotJourneyId,
} from './types.js';

export type FieldTrialProofState =
  | 'live_proven'
  | 'near_live_only'
  | 'externally_blocked'
  | 'degraded_but_usable'
  | 'not_intended_for_trial';

export type FieldTrialBlockerOwner = 'none' | 'repo_side' | 'external';

export interface FieldTrialSurfaceTruth {
  proofState: FieldTrialProofState;
  blocker: string;
  blockerOwner: FieldTrialBlockerOwner;
  nextAction: string;
  detail: string;
}

export type FieldTrialLaunchCandidateStatus =
  | 'core_ready'
  | 'core_ready_with_manual_surface_sync'
  | 'provider_blocked_but_core_usable'
  | 'near_live_only'
  | 'externally_blocked';

export type FieldTrialCoreStatus =
  | 'healthy'
  | 'manual_sync_pending'
  | 'fresh_proof_gap'
  | 'blocked';

export interface FieldTrialManualSurfaceSyncTruth {
  surfaceId: 'alexa';
  syncStatus: 'synced' | 'pending' | 'not_tracked';
  interactionModelPath: string;
  interactionModelHash: string;
  lastSyncedHash: string;
  lastSyncedAt: string;
  lastSyncedBy: string;
  detail: string;
  nextAction: string;
}

export interface FieldTrialLaunchReadinessTruth {
  status: FieldTrialLaunchCandidateStatus;
  coreStatus: FieldTrialCoreStatus;
  summary: string;
  coreBlockers: string[];
  manualSyncSteps: string[];
  optionalProviderBlockers: string[];
  optionalProviderNextActions: string[];
  optionalBridgeBlockers: string[];
  optionalBridgeNextActions: string[];
  proofFreshnessGaps: string[];
  manualSurfaceSyncs: {
    alexa: FieldTrialManualSurfaceSyncTruth;
  };
}

export interface FieldTrialAlexaTruth extends FieldTrialSurfaceTruth {
  lastSignedRequestAt: string;
  lastSignedRequestType: string;
  lastSignedIntent: string;
  lastSignedResponseSource: string;
  lastHandledProofAt: string;
  lastHandledProofIntent: string;
  lastHandledProofResponseSource: string;
  proofKind: AlexaLiveProofKind;
  proofFreshness: AlexaLiveProofFreshness;
  proofAgeMinutes: number | null;
  proofAgeLabel: string;
  recommendedUtterance: string;
  confirmCommand: string;
  successShape: string;
  staleShape: string;
  failureChecklist: string;
}

export interface FieldTrialBlueBubblesTruth extends FieldTrialSurfaceTruth {
  providerName: AppleMessagesProviderName;
  bridgeAvailability: AppleMessagesBridgeAvailability;
  configured: boolean;
  serverBaseUrl: string;
  activeServerBaseUrl: string;
  serverBaseUrlCandidates: string;
  serverBaseUrlCandidateResults: string;
  listenerHost: string;
  listenerPort: number;
  publicWebhookUrl: string;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  chatScope: string;
  configuredReplyGateMode: string;
  effectiveReplyGateMode: string;
  replyGateMode: string;
  mostRecentEngagedChatJid: string;
  mostRecentEngagedAt: string;
  lastInboundObservedAt: string;
  lastInboundChatJid: string;
  lastInboundWasSelfAuthored: boolean;
  lastOutboundResult: string;
  lastOutboundTargetKind: string;
  lastOutboundTarget: string;
  lastSendErrorDetail: string;
  sendMethod: string;
  privateApiAvailable: string;
  lastMetadataHydrationSource: string;
  attemptedTargetSequence: string;
  transportState: string;
  transportDetail: string;
  detectionState: string;
  detectionDetail: string;
  detectionNextAction: string;
  shadowPollLastOkAt: string;
  shadowPollLastError: string;
  shadowPollMostRecentChat: string;
  mostRecentServerSeenAt: string;
  mostRecentServerSeenChatJid: string;
  mostRecentWebhookObservedAt: string;
  mostRecentWebhookObservedChatJid: string;
  lastIgnoredAt: string;
  lastIgnoredChatJid: string;
  lastIgnoredReason: string;
  crossSurfaceFallbackState: string;
  crossSurfaceFallbackLastSentAt: string;
  recentTargetChatJid: string;
  recentTargetAt: string;
  openMessageActionCount: number;
  continuityState: 'idle' | 'draft_open' | 'awaiting_decision' | 'proof_gap';
  proofCandidateChatJid: string;
  activeMessageActionId: string;
  conversationKind: 'self_thread' | 'direct_1to1' | 'group';
  decisionPolicy:
    | 'semi_auto_self_thread'
    | 'semi_auto_recent_direct_1to1'
    | 'explicit_only';
  conversationalEligibility: 'conversational_now' | 'explicit_only';
  requiresExplicitMention: boolean;
  activePresentationAt: string | null;
  eligibleFollowups: string[];
  canonicalSelfThreadChatJid: string;
  sourceSelfThreadChatJid: string;
  messageActionProofState: 'none' | 'fresh' | 'stale';
  messageActionProofChatJid: string;
  messageActionProofAt: string;
  messageActionProofDetail: string;
}

function parseFieldTrialIsoTime(
  value: string | null | undefined,
): number | null {
  if (!value || value === 'none') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickMostRecentBlueBubblesChat(
  candidates: Array<{
    chatJid: string | null | undefined;
    at: string | null | undefined;
  }>,
): { chatJid: string; at: string } | null {
  let best: { chatJid: string; at: string; timestamp: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate.chatJid || candidate.chatJid === 'none') continue;
    const timestamp = parseFieldTrialIsoTime(candidate.at);
    if (timestamp == null) continue;
    if (!best || timestamp > best.timestamp) {
      best = {
        chatJid: candidate.chatJid,
        at: candidate.at as string,
        timestamp,
      };
    }
  }
  return best ? { chatJid: best.chatJid, at: best.at } : null;
}

function canonicalizeBlueBubblesProofCandidate(candidate: {
  chatJid: string | null | undefined;
  at: string | null | undefined;
}): {
  chatJid: string | null;
  at: string | null | undefined;
} {
  return {
    chatJid: canonicalizeBlueBubblesSelfThreadJid(candidate.chatJid),
    at: candidate.at,
  };
}

function listRecentMessagesForBlueBubblesProofChat(
  proofChatJid: string | null,
  limit: number,
): Array<ReturnType<typeof listRecentMessagesForChat>[number]> {
  if (!proofChatJid) return [];
  const scopedChats = expandBlueBubblesLogicalSelfThreadJids(proofChatJid);
  const merged = scopedChats.flatMap((chatJid) =>
    listRecentMessagesForChat(chatJid, limit),
  );
  return merged
    .sort(
      (left, right) =>
        Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''),
    )
    .slice(0, limit);
}

function isLikelyBlueBubblesDraftReply(
  content: string | null | undefined,
): boolean {
  const normalized = (content || '').toLowerCase();
  if (!normalized) return false;
  return (
    /\bdraft\b/.test(normalized) ||
    /^andrea:\s*(sure|here)/.test(normalized) ||
    normalized.includes('what you can send') ||
    normalized.includes('what you could send')
  );
}

function findBlueBubblesSameThreadContinuationAfterAction(
  proofChatJid: string | null,
  actionAt: string | null | undefined,
  messages: Array<ReturnType<typeof listRecentMessagesForChat>[number]>,
): { inboundAt: string; outboundAt: string } | null {
  if (!proofChatJid) return null;
  const actionTimestamp = parseFieldTrialIsoTime(actionAt);
  if (actionTimestamp == null) return null;
  const ordered = [...messages]
    .filter(
      (message) =>
        canonicalizeBlueBubblesSelfThreadJid(message.chat_jid) ===
          proofChatJid || message.chat_jid === proofChatJid,
    )
    .sort(
      (left, right) =>
        Date.parse(left.timestamp || '') - Date.parse(right.timestamp || ''),
    );
  let inboundAfterAction: { timestamp: string } | null = null;
  for (const message of ordered) {
    const messageTimestamp = parseFieldTrialIsoTime(message.timestamp);
    if (messageTimestamp == null || messageTimestamp <= actionTimestamp)
      continue;
    if (!inboundAfterAction) {
      if (!message.is_bot_message) {
        inboundAfterAction = { timestamp: message.timestamp };
      }
      continue;
    }
    if (
      message.is_bot_message &&
      messageTimestamp > Date.parse(inboundAfterAction.timestamp)
    ) {
      return {
        inboundAt: inboundAfterAction.timestamp,
        outboundAt: message.timestamp,
      };
    }
  }
  return null;
}

const BLUEBUBBLES_DECISION_CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

function isLikelyBlueBubblesMessageActionDecisionPrompt(
  content: string,
): boolean {
  const normalized = content
    .replace(/^@\s*andrea[:,]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return /^(send it(?: later(?: tonight)?| tonight)?|save that|save it|remind me instead|remind me later|send the draft|send that)\b/.test(
    normalized,
  );
}

function findBlueBubblesSameThreadDecisionConfirmation(
  proofChatJid: string | null,
  actionAt: string | null | undefined,
  messages: Array<ReturnType<typeof listRecentMessagesForChat>[number]>,
): { inboundAt: string; outboundAt: string } | null {
  if (!proofChatJid) return null;
  const actionTimestamp = parseFieldTrialIsoTime(actionAt);
  if (actionTimestamp == null) return null;
  const ordered = [...messages]
    .filter(
      (message) =>
        canonicalizeBlueBubblesSelfThreadJid(message.chat_jid) ===
          proofChatJid || message.chat_jid === proofChatJid,
    )
    .sort(
      (left, right) =>
        Date.parse(left.timestamp || '') - Date.parse(right.timestamp || ''),
    );
  const earliestDecisionAt =
    actionTimestamp - BLUEBUBBLES_DECISION_CONFIRMATION_WINDOW_MS;
  let decisionInbound: { timestamp: string } | null = null;
  for (const message of ordered) {
    const messageTimestamp = parseFieldTrialIsoTime(message.timestamp);
    if (
      messageTimestamp == null ||
      messageTimestamp < earliestDecisionAt ||
      messageTimestamp > actionTimestamp
    ) {
      continue;
    }
    if (
      !message.is_bot_message &&
      isLikelyBlueBubblesMessageActionDecisionPrompt(message.content || '')
    ) {
      decisionInbound = { timestamp: message.timestamp };
    }
  }
  if (!decisionInbound) return null;
  for (const message of ordered) {
    const messageTimestamp = parseFieldTrialIsoTime(message.timestamp);
    if (
      messageTimestamp == null ||
      messageTimestamp < actionTimestamp ||
      messageTimestamp <= Date.parse(decisionInbound.timestamp)
    ) {
      continue;
    }
    if (message.is_bot_message) {
      return {
        inboundAt: decisionInbound.timestamp,
        outboundAt: message.timestamp,
      };
    }
  }
  return null;
}

function deriveBlueBubblesWebhookRegistrationTruth(detail: string): {
  state: string;
  detail: string;
} {
  const normalized = detail.toLowerCase();
  const registrationMatch = detail.match(
    /webhook registration ([^|]+?)(?: \| |$)/i,
  );
  const registrationDetail =
    registrationMatch?.[1]?.trim() || 'not checked yet';
  if (
    normalized.includes(
      'webhook registration registered on the bluebubbles server',
    )
  ) {
    return {
      state: 'registered',
      detail: registrationDetail,
    };
  }
  if (
    normalized.includes(
      'webhook registration no matching andrea webhook is registered on the bluebubbles server',
    )
  ) {
    return {
      state: 'missing',
      detail: registrationDetail,
    };
  }
  if (
    normalized.includes(
      'webhook registration cannot be checked until bluebubbles is enabled with a base url and password',
    )
  ) {
    return {
      state: 'not_configured',
      detail: registrationDetail,
    };
  }
  if (
    normalized.includes('webhook registration unauthorized') ||
    normalized.includes('webhook registration forbidden')
  ) {
    return {
      state: 'auth_failed',
      detail: registrationDetail,
    };
  }
  if (normalized.includes('webhook registration')) {
    return {
      state: 'unreachable',
      detail: registrationDetail,
    };
  }
  return {
    state: 'not_checked',
    detail: 'not checked yet',
  };
}

function extractBlueBubblesDetailField(
  detail: string,
  prefix: string,
): string | null {
  const match = detail.match(
    new RegExp(
      `${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([^|]+?)(?: \\| |$)`,
    ),
  );
  return match?.[1]?.trim() || null;
}

function normalizeBlueBubblesDetailValue(value: string | null): string | null {
  if (!value || value === 'none') {
    return null;
  }
  return value;
}

function deriveBlueBubblesTransportProbeState(detail: string): string {
  const explicit = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(detail, 'transport probe state'),
  );
  if (explicit) {
    return explicit;
  }

  const transportDetail = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(detail, 'transport'),
  );
  if (!transportDetail) {
    return 'not_checked';
  }
  if (/reachable\/auth ok/i.test(transportDetail)) {
    return 'reachable';
  }
  if (/auth failed|unauthor|forbidden/i.test(transportDetail)) {
    return 'auth_failed';
  }
  if (/unreachable|no reachable/i.test(transportDetail)) {
    return 'unreachable';
  }
  return 'not_checked';
}

function deriveBlueBubblesWebhookRegistrationState(
  detail: string,
): string | null {
  const explicit = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(detail, 'webhook registration state'),
  );
  if (explicit) {
    return explicit;
  }

  const registrationDetail = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(detail, 'webhook registration'),
  );
  if (!registrationDetail) {
    return null;
  }
  if (/registered on the BlueBubbles server/i.test(registrationDetail)) {
    return 'registered';
  }
  if (/no matching Andrea webhook/i.test(registrationDetail)) {
    return 'missing';
  }
  if (/cannot be checked/i.test(registrationDetail)) {
    return 'not_configured';
  }
  if (/unauthor|forbidden/i.test(registrationDetail)) {
    return 'auth_failed';
  }
  if (/unreachable|skipped because no reachable/i.test(registrationDetail)) {
    return 'unreachable';
  }
  return null;
}

function deriveBlueBubblesReplyGateMode(detail: string): string | null {
  return normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(detail, 'reply gate'),
  );
}

function deriveBlueBubblesTransportDiagnostics(detail: string): {
  lastInboundChatJid: string;
  lastInboundWasSelfAuthored: boolean | null;
  lastOutboundTargetKind: string;
  lastOutboundTarget: string;
  lastSendErrorDetail: string;
  sendMethod: string;
  privateApiAvailable: string;
  lastMetadataHydrationSource: string;
  attemptedTargetSequence: string;
} {
  const inboundSelfAuthored = extractBlueBubblesDetailField(
    detail,
    'last inbound self_authored',
  );
  return {
    lastInboundChatJid:
      extractBlueBubblesDetailField(detail, 'last inbound chat') || 'none',
    lastInboundWasSelfAuthored:
      inboundSelfAuthored === 'yes'
        ? true
        : inboundSelfAuthored === 'no'
          ? false
          : null,
    lastOutboundTargetKind:
      extractBlueBubblesDetailField(detail, 'last outbound target kind') ||
      'none',
    lastOutboundTarget:
      extractBlueBubblesDetailField(detail, 'last outbound target value') ||
      'none',
    lastSendErrorDetail:
      extractBlueBubblesDetailField(detail, 'last send error') || 'none',
    sendMethod:
      extractBlueBubblesDetailField(detail, 'send method') || 'private-api',
    privateApiAvailable:
      extractBlueBubblesDetailField(detail, 'private api available') ||
      'unknown',
    lastMetadataHydrationSource:
      extractBlueBubblesDetailField(detail, 'last metadata hydration') ||
      'none',
    attemptedTargetSequence:
      extractBlueBubblesDetailField(detail, 'attempted target sequence') ||
      'none',
  };
}

export interface FieldTrialJourneyTruthMap {
  ordinary_chat: FieldTrialSurfaceTruth;
  daily_guidance: FieldTrialSurfaceTruth;
  candace_followthrough: FieldTrialSurfaceTruth;
  mission_planning: FieldTrialSurfaceTruth;
  work_cockpit: FieldTrialSurfaceTruth;
  cross_channel_handoff: FieldTrialSurfaceTruth;
  alexa_orientation: FieldTrialSurfaceTruth;
}

export interface FieldTrialPilotIssueTruth {
  loggingEnabled: boolean;
  openCount: number;
  latestSummary: string;
  latestResponseFeedbackStatus: string;
  latestResponseFeedbackClassification: string;
  latestResponseFeedbackSummary: string;
  localHotfixPending: boolean;
}

export interface FieldTrialOperatorTruth {
  telegram: FieldTrialSurfaceTruth;
  alexa: FieldTrialAlexaTruth;
  bluebubbles: FieldTrialBlueBubblesTruth;
  googleCalendar: FieldTrialSurfaceTruth;
  workCockpit: FieldTrialSurfaceTruth;
  lifeThreads: FieldTrialSurfaceTruth;
  communicationCompanion: FieldTrialSurfaceTruth;
  chiefOfStaffMissions: FieldTrialSurfaceTruth;
  knowledgeLibrary: FieldTrialSurfaceTruth;
  actionBundlesDelegationOutcomeReview: FieldTrialSurfaceTruth;
  research: FieldTrialSurfaceTruth;
  imageGeneration: FieldTrialSurfaceTruth;
  hostHealth: FieldTrialSurfaceTruth;
  journeys: FieldTrialJourneyTruthMap;
  pilotIssues: FieldTrialPilotIssueTruth;
  launchReadiness: FieldTrialLaunchReadinessTruth;
}

export interface BuildFieldTrialOperatorTruthOptions {
  projectRoot?: string;
  hostSnapshot?: HostControlSnapshot;
  windowsHost?: WindowsHostReconciliation | null;
  outwardResearchStatus?:
    | 'not_configured'
    | 'misconfigured_native_openai_endpoint'
    | 'missing_direct_provider_credentials'
    | 'quota_blocked'
    | 'degraded'
    | 'available';
}

interface OpenSelfThreadMessageActionEntry {
  action: MessageActionRecord;
  chatJid: string;
  engagedAt: string;
  engagedAtMs: number;
}

interface PilotReviewSnapshotLike {
  loggingEnabled: boolean;
  recentEvents: PilotJourneyEventRecord[];
  openIssueCount: number;
  latestOpenIssue: { summaryText: string } | null;
}

function buildTruth(
  truth: Partial<FieldTrialSurfaceTruth> &
    Pick<FieldTrialSurfaceTruth, 'proofState'>,
): FieldTrialSurfaceTruth {
  return {
    blocker: '',
    blockerOwner: 'none',
    nextAction: '',
    detail: '',
    ...truth,
  };
}

function formatLaunchSurfaceLabel(label: string): string {
  return label.replace(/_/g, ' ');
}

function summarizeTruthLine(
  label: string,
  state: FieldTrialSurfaceTruth,
): string {
  const prefix = `${formatLaunchSurfaceLabel(label)}:`;
  if (state.blocker) {
    return `${prefix} ${state.blocker}${state.nextAction ? ` Next: ${state.nextAction}` : ''}`;
  }
  if (state.detail) {
    return `${prefix} ${state.detail}${state.nextAction ? ` Next: ${state.nextAction}` : ''}`;
  }
  return `${prefix} ${state.proofState}`;
}

function summarizeMessagesBridgeLine(
  state: FieldTrialBlueBubblesTruth,
): string {
  const prefix = `messages bridge (${state.providerName})`;
  const availability = state.bridgeAvailability;
  const body =
    state.blocker ||
    state.detail ||
    (availability === 'available'
      ? 'available'
      : 'unavailable, use Telegram as the dependable main path');
  return `${prefix}: ${body}`;
}

function buildAlexaManualSyncTruth(
  projectRoot: string,
): FieldTrialManualSurfaceSyncTruth {
  const status = getAlexaModelSyncStatus(projectRoot);
  if (status.syncStatus === 'synced') {
    return {
      surfaceId: 'alexa',
      syncStatus: 'synced',
      interactionModelPath: status.interactionModelPath,
      interactionModelHash: status.interactionModelHash,
      lastSyncedHash: status.lastSyncedHash,
      lastSyncedAt: status.lastSyncedAt,
      lastSyncedBy: status.lastSyncedBy,
      detail:
        'Alexa interaction model hash is marked as synced with the current repo model.',
      nextAction: '',
    };
  }

  if (status.syncStatus === 'pending') {
    return {
      surfaceId: 'alexa',
      syncStatus: 'pending',
      interactionModelPath: status.interactionModelPath,
      interactionModelHash: status.interactionModelHash,
      lastSyncedHash: status.lastSyncedHash,
      lastSyncedAt: status.lastSyncedAt,
      lastSyncedBy: status.lastSyncedBy,
      detail:
        'Alexa proof is separate from the latest console model sync. The current repo interaction model hash has not been marked as synced yet.',
      nextAction:
        'Import docs/alexa/interaction-model.en-US.json in the Alexa Developer Console, run Build Model, then run npm run setup -- --step alexa-model-sync mark-synced.',
    };
  }

  return {
    surfaceId: 'alexa',
    syncStatus: 'not_tracked',
    interactionModelPath: status.interactionModelPath,
    interactionModelHash: status.interactionModelHash,
    lastSyncedHash: status.lastSyncedHash,
    lastSyncedAt: status.lastSyncedAt,
    lastSyncedBy: status.lastSyncedBy,
    detail:
      'Alexa model sync is not being tracked from this repo root yet because the interaction-model file is missing here.',
    nextAction: '',
  };
}

function buildActionBundlesDelegationOutcomeReviewTruth(
  review: PilotReviewSnapshotLike,
): FieldTrialSurfaceTruth {
  const matchingEvent = getRecentJourneyEvent(review, (event) => {
    const summary = (event.summaryText || '').toLowerCase();
    const routeKey = (event.routeKey || '').toLowerCase();
    return (
      summary.includes('bundle') ||
      summary.includes('review') ||
      routeKey.includes('bundle') ||
      routeKey.includes('review') ||
      event.systemsInvolved.includes('cross_channel_handoffs')
    );
  });

  if (matchingEvent && isLiveProvenPilotOutcome(matchingEvent.outcome)) {
    return buildTruth({
      proofState: 'live_proven',
      detail: describeRecentJourney(
        'Action bundles / delegation / outcome review',
        matchingEvent,
        'live-proven',
      ),
    });
  }

  if (matchingEvent && matchingEvent.outcome === 'degraded_usable') {
    return buildTruth({
      proofState: 'degraded_but_usable',
      blocker:
        'Action bundles or outcome review stayed usable, but the latest host proof still used a degraded path.',
      blockerOwner:
        matchingEvent.blockerOwner === 'none'
          ? 'repo_side'
          : matchingEvent.blockerOwner,
      nextAction:
        'Run one clean approve or partial-review chain and confirm the outcome review updates without fallback.',
      detail: describeRecentJourney(
        'Action bundles / delegation / outcome review',
        matchingEvent,
        'degraded but usable',
      ),
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'Action bundles, delegation rules, and outcome review are implemented and well-covered, but this host still needs one fresh approve or partial-review proof chain.',
    blockerOwner: 'repo_side',
    nextAction:
      'Run one bundle approval flow, let it land in outcome review, then rerun npm run debug:pilot.',
    detail:
      'This composite launch surface is repo-ready, but it still needs one first-class host proof chain so it does not disappear from the RC story.',
  });
}

function buildLaunchReadinessTruth(params: {
  projectRoot: string;
  hostSnapshot: HostControlSnapshot;
  windowsHost: WindowsHostReconciliation | null;
  telegram: FieldTrialSurfaceTruth;
  alexa: FieldTrialAlexaTruth;
  bluebubbles: FieldTrialBlueBubblesTruth;
  googleCalendar: FieldTrialSurfaceTruth;
  workCockpit: FieldTrialSurfaceTruth;
  lifeThreads: FieldTrialSurfaceTruth;
  communicationCompanion: FieldTrialSurfaceTruth;
  chiefOfStaffMissions: FieldTrialSurfaceTruth;
  knowledgeLibrary: FieldTrialSurfaceTruth;
  research: FieldTrialSurfaceTruth;
  imageGeneration: FieldTrialSurfaceTruth;
  hostHealth: FieldTrialSurfaceTruth;
  journeys: FieldTrialJourneyTruthMap;
  actionBundlesDelegationOutcomeReview: FieldTrialSurfaceTruth;
}): FieldTrialLaunchReadinessTruth {
  const alexaManualSync = buildAlexaManualSyncTruth(params.projectRoot);
  const coreSurfaces: Array<[string, FieldTrialSurfaceTruth]> = [
    ['telegram', params.telegram],
    ['alexa', params.alexa],
    ['google_calendar', params.googleCalendar],
    ['work_cockpit', params.workCockpit],
    ['life_threads', params.lifeThreads],
    ['communication_companion', params.communicationCompanion],
    ['chief_of_staff_missions', params.chiefOfStaffMissions],
    ['knowledge_library', params.knowledgeLibrary],
    ['host_health', params.hostHealth],
  ];

  const blockedCoreSurfaces = coreSurfaces.filter(
    ([, state]) => state.proofState === 'externally_blocked',
  );
  const nearLiveCoreSurfaces = coreSurfaces.filter(
    ([, state]) => state.proofState === 'near_live_only',
  );
  const degradedUsableCoreSurfaces = coreSurfaces.filter(
    ([, state]) => state.proofState === 'degraded_but_usable',
  );
  const manualSyncSteps =
    params.alexa.proofState === 'live_proven' &&
    alexaManualSync.syncStatus === 'pending'
      ? [alexaManualSync.nextAction]
      : [];

  const optionalProviderBlockers: string[] = [];
  const optionalProviderNextActions: string[] = [];
  const optionalBridgeBlockers: string[] = [];
  const optionalBridgeNextActions: string[] = [];
  if (params.research.proofState === 'externally_blocked') {
    optionalProviderBlockers.push(
      summarizeTruthLine('outward_research', params.research),
    );
    if (params.research.nextAction) {
      optionalProviderNextActions.push(params.research.nextAction);
    }
  }
  if (params.imageGeneration.proofState === 'externally_blocked') {
    optionalProviderBlockers.push(
      summarizeTruthLine('image_generation', params.imageGeneration),
    );
    if (params.imageGeneration.nextAction) {
      optionalProviderNextActions.push(params.imageGeneration.nextAction);
    }
  }
  const dependencyState =
    params.windowsHost?.dependencyState ||
    params.hostSnapshot.hostState?.dependencyState ||
    'unknown';
  const dependencyError =
    params.windowsHost?.dependencyError ||
    params.hostSnapshot.hostState?.dependencyError ||
    '';
  if (dependencyState === 'degraded' && dependencyError) {
    optionalProviderBlockers.push(
      `local_gateway_compatibility_lane: ${dependencyError}`,
    );
    optionalProviderNextActions.push(
      'Repair the local Anthropic-compatible gateway lane, then rerun npm run setup -- --step verify.',
    );
  }
  if (params.bluebubbles.proofState !== 'live_proven') {
    optionalBridgeBlockers.push(
      summarizeMessagesBridgeLine(params.bluebubbles),
    );
    if (params.bluebubbles.nextAction) {
      optionalBridgeNextActions.push(params.bluebubbles.nextAction);
    }
  }

  const proofFreshnessGaps = (
    Object.entries(params.journeys) as Array<
      [keyof FieldTrialJourneyTruthMap, FieldTrialSurfaceTruth]
    >
  )
    .filter(([, state]) => state.proofState === 'near_live_only')
    .map(([label, state]) => summarizeTruthLine(label, state))
    .concat(
      degradedUsableCoreSurfaces.map(([label, state]) =>
        summarizeTruthLine(label, state),
      ),
    );

  const coreBlockers = blockedCoreSurfaces
    .concat(nearLiveCoreSurfaces)
    .map(([label, state]) => summarizeTruthLine(label, state));

  let coreStatus: FieldTrialCoreStatus = 'healthy';
  let status: FieldTrialLaunchCandidateStatus = 'core_ready';
  let summary = 'Andrea core companion is launch-ready on this host.';

  if (blockedCoreSurfaces.length > 0) {
    coreStatus = 'blocked';
    status = 'externally_blocked';
    summary =
      'A core Andrea launch surface is currently blocked or degraded on this host.';
  } else if (nearLiveCoreSurfaces.length > 0) {
    coreStatus = 'fresh_proof_gap';
    status = 'near_live_only';
    const onlyAlexaNeedsFreshProof =
      nearLiveCoreSurfaces.length === 1 &&
      nearLiveCoreSurfaces[0]?.[0] === 'alexa' &&
      params.telegram.proofState === 'live_proven';
    summary = onlyAlexaNeedsFreshProof
      ? 'Andrea core companion is usable on this PC. Telegram is already dependable, and Alexa still needs one fresh same-host proof turn.'
      : 'Andrea core companion is close, but one core surface still needs a same-host fresh proof step.';
  } else if (manualSyncSteps.length > 0) {
    coreStatus = 'manual_sync_pending';
    status = 'core_ready_with_manual_surface_sync';
    summary =
      'Andrea core companion is ready, but one manual surface sync step is still pending.';
  } else if (optionalBridgeBlockers.length > 0) {
    coreStatus = 'healthy';
    status = 'provider_blocked_but_core_usable';
    summary =
      params.bluebubbles.bridgeAvailability === 'available'
        ? 'Andrea core companion is ready on this PC. Messages is a best-effort bridge right now, and Telegram remains the dependable main path.'
        : 'Andrea core companion is ready on this PC. The Messages bridge is unavailable right now, so use Telegram as the dependable main path.';
  } else if (optionalProviderBlockers.length > 0) {
    coreStatus = 'healthy';
    status = 'provider_blocked_but_core_usable';
    summary =
      'Andrea core companion is ready. Optional provider-backed lanes are blocked, but the core product remains usable.';
  }

  return {
    status,
    coreStatus,
    summary,
    coreBlockers,
    manualSyncSteps,
    optionalProviderBlockers,
    optionalProviderNextActions: [...new Set(optionalProviderNextActions)],
    optionalBridgeBlockers,
    optionalBridgeNextActions: [...new Set(optionalBridgeNextActions)],
    proofFreshnessGaps,
    manualSurfaceSyncs: {
      alexa: alexaManualSync,
    },
  };
}

function formatProofMoment(iso: string | null | undefined): string {
  if (!iso) return 'recently';
  return `on ${iso}`;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function resolveBlueBubblesMessageActionProofTarget(action: {
  presentationChatJid?: string | null;
  targetConversationJson: string;
}): string | null {
  if (action.presentationChatJid?.startsWith('bb:')) {
    return action.presentationChatJid;
  }
  const target = parseJsonSafe<{ chatJid?: string | null }>(
    action.targetConversationJson,
    {},
  );
  if (target.chatJid?.startsWith('bb:')) {
    return target.chatJid;
  }
  if (action.presentationChatJid?.startsWith('bb:')) {
    return action.presentationChatJid;
  }
  return null;
}

function describeRecentJourney(
  label: string,
  event: PilotJourneyEventRecord,
  proofLabel: 'live-proven' | 'degraded but usable',
): string {
  return `${label} was ${proofLabel} ${formatProofMoment(
    event.completedAt || event.startedAt,
  )}. ${event.summaryText}`;
}

function formatBlockerClass(
  value: string | null | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  return value.replace(/_/g, ' ');
}

function isLiveProvenPilotOutcome(
  outcome: PilotJourneyEventRecord['outcome'],
): boolean {
  return outcome === 'success';
}

function getRecentJourneyEvent(
  review: PilotReviewSnapshotLike,
  predicate: (event: PilotJourneyEventRecord) => boolean,
): PilotJourneyEventRecord | null {
  return review.recentEvents.find(predicate) || null;
}

function getJourneyEventById(
  review: PilotReviewSnapshotLike,
  journeyId: PilotJourneyId,
): PilotJourneyEventRecord | null {
  return getRecentJourneyEvent(
    review,
    (event) => event.journeyId === journeyId,
  );
}

function getAlexaPilotProofFallback(
  review: PilotReviewSnapshotLike,
  now = new Date(),
): {
  event: PilotJourneyEventRecord;
  proofAt: string;
  proofAgeMs: number;
  proofAgeMinutes: number;
  proofAgeLabel: string;
} | null {
  const event = getRecentJourneyEvent(
    review,
    (candidate) =>
      candidate.journeyId === 'alexa_orientation' &&
      candidate.channel === 'alexa' &&
      candidate.outcome === 'success',
  );
  if (!event) return null;
  const proofAt = event.completedAt || event.startedAt;
  const proofAtMs = parseFieldTrialIsoTime(proofAt);
  if (proofAtMs == null) return null;
  const proofAgeMs = Math.max(0, now.getTime() - proofAtMs);
  if (proofAgeMs > DEFAULT_ALEXA_LIVE_PROOF_FRESHNESS_MS) {
    return null;
  }
  return {
    event,
    proofAt,
    proofAgeMs,
    proofAgeMinutes: Math.floor(proofAgeMs / 60_000),
    proofAgeLabel: formatAlexaProofAgeLabel(proofAgeMs),
  };
}

function buildJourneyTruthFromEvent(params: {
  label: string;
  event: PilotJourneyEventRecord | null;
  nearLiveDetail: string;
  nearLiveNextAction: string;
  externalBlocker?: string;
  externalNextAction?: string;
}): FieldTrialSurfaceTruth {
  if (!params.event) {
    return buildTruth({
      proofState: 'near_live_only',
      detail: params.nearLiveDetail,
      nextAction: params.nearLiveNextAction,
    });
  }

  if (isLiveProvenPilotOutcome(params.event.outcome)) {
    return buildTruth({
      proofState: 'live_proven',
      detail: describeRecentJourney(params.label, params.event, 'live-proven'),
    });
  }

  if (params.event.outcome === 'degraded_usable') {
    return buildTruth({
      proofState: 'degraded_but_usable',
      blocker: formatBlockerClass(
        params.event.blockerClass,
        `${params.label} stayed usable, but only through a bounded fallback path on this host.`,
      ),
      blockerOwner:
        params.event.blockerOwner === 'none'
          ? 'repo_side'
          : params.event.blockerOwner,
      nextAction: params.nearLiveNextAction,
      detail: describeRecentJourney(
        params.label,
        params.event,
        'degraded but usable',
      ),
    });
  }

  if (params.event.outcome === 'externally_blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        params.externalBlocker ||
        formatBlockerClass(
          params.event.blockerClass,
          `${params.label} is blocked by an external dependency on this host.`,
        ),
      blockerOwner:
        params.event.blockerOwner === 'none'
          ? 'external'
          : params.event.blockerOwner,
      nextAction: params.externalNextAction || params.nearLiveNextAction,
      detail:
        params.event.summaryText ||
        `${params.label} hit an external blocker on this host.`,
    });
  }

  if (params.event.outcome === 'internal_failure') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: `${params.label} hit a repo-side failure during the most recent proof run.`,
      blockerOwner: 'repo_side',
      nextAction: params.nearLiveNextAction,
      detail:
        params.event.summaryText ||
        `${params.label} needs one clean rerun after the last internal failure.`,
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    detail: params.nearLiveDetail,
    nextAction: params.nearLiveNextAction,
  });
}

function buildHostHealthTruth(
  hostSnapshot: HostControlSnapshot,
  windowsHost: WindowsHostReconciliation | null,
): FieldTrialSurfaceTruth {
  const serviceState =
    windowsHost?.serviceState || hostSnapshot.hostState?.phase || 'stopped';
  const dependencyState =
    windowsHost?.dependencyState ||
    hostSnapshot.hostState?.dependencyState ||
    'unknown';
  const dependencyError =
    windowsHost?.dependencyError ||
    hostSnapshot.hostState?.dependencyError ||
    '';

  if (serviceState === 'running_ready') {
    return buildTruth({
      proofState: 'live_proven',
      detail:
        dependencyState === 'degraded' && dependencyError
          ? `Host-control is healthy and ready on this machine. Dependency state is degraded: ${dependencyError}`
          : 'Host-control, watchdog, and readiness are healthy on this machine.',
    });
  }

  if (serviceState === 'starting') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: 'Andrea is still starting on this machine.',
      nextAction:
        'Wait for the host to reach running_ready, then rerun services:status.',
      detail:
        'The host is starting and not ready to claim a full pilot proof yet.',
    });
  }

  return buildTruth({
    proofState: 'externally_blocked',
    blocker:
      windowsHost?.launcherError ||
      hostSnapshot.hostState?.lastError ||
      'Andrea is not currently healthy on this machine.',
    blockerOwner: 'repo_side',
    nextAction:
      'Repair the host-control path on this machine, then rerun services:status, setup verify, and debug:status.',
    detail: `Host state is ${serviceState}.`,
  });
}

function buildTelegramTruth(
  hostSnapshot: HostControlSnapshot,
  windowsHost: WindowsHostReconciliation | null,
): FieldTrialSurfaceTruth {
  const assistantHealth = assessAssistantHealthState({
    assistantHealthState: hostSnapshot.assistantHealthState,
    hostState: hostSnapshot.hostState,
    readyState: hostSnapshot.readyState,
    processRunning: windowsHost?.processRunning,
    runtimePid: windowsHost?.runtimePid,
  });
  const roundtrip = assessTelegramRoundtripState({
    assistantHealthState: hostSnapshot.assistantHealthState,
    telegramRoundtripState: hostSnapshot.telegramRoundtripState,
    hostState: hostSnapshot.hostState,
    readyState: hostSnapshot.readyState,
  });
  const transport = hostSnapshot.telegramTransportState;
  const hostBootId =
    hostSnapshot.hostState?.bootId || hostSnapshot.readyState?.bootId || null;
  const roundtripBootId = hostSnapshot.telegramRoundtripState?.bootId || null;
  const sameBootRoundtrip =
    Boolean(hostBootId) &&
    Boolean(roundtripBootId) &&
    hostBootId === roundtripBootId;
  const lastOkTimestamp = parseFieldTrialIsoTime(roundtrip.lastOkAt);
  const recentlyConfirmed =
    lastOkTimestamp != null &&
    Date.now() - lastOkTimestamp <=
      DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS * 2;

  if (transport?.status === 'ready' && roundtrip.status === 'healthy') {
    return buildTruth({
      proofState: 'live_proven',
      detail:
        roundtrip.detail ||
        'Telegram transport and roundtrip proof are healthy on this host.',
    });
  }

  if (transport?.status === 'blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        transport.detail ||
        'Telegram is blocked by another consumer or an active webhook on this token.',
      blockerOwner: 'external',
      nextAction:
        'Clear the external Telegram consumer or rotate the bot token, then rerun npm run telegram:user:smoke.',
      detail:
        transport.detail ||
        'Telegram transport is blocked, so this host cannot claim a live Telegram roundtrip right now.',
    });
  }

  if (roundtrip.status === 'unconfigured') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: roundtrip.detail,
      blockerOwner: 'external',
      nextAction:
        'Configure the Telegram user-session probe on this host and rerun npm run telegram:user:smoke.',
      detail:
        'Telegram bot routing can still run, but the live proof path is not fully configured on this host.',
    });
  }

  if (
    transport?.status === 'ready' &&
    assistantHealth.status === 'healthy' &&
    sameBootRoundtrip &&
    recentlyConfirmed
  ) {
    return buildTruth({
      proofState: 'live_proven',
      detail:
        roundtrip.detail ||
        'Telegram routing is healthy on this host and the most recent same-boot roundtrip confirmation is still recent.',
      nextAction:
        'Rerun npm run telegram:user:smoke if you want to refresh the Telegram live-proof marker immediately.',
    });
  }

  if (roundtrip.status === 'pending') {
    return buildTruth({
      proofState: 'near_live_only',
      blocker: roundtrip.detail,
      blockerOwner: 'none',
      nextAction:
        'Wait for the first post-startup Telegram roundtrip or rerun npm run telegram:user:smoke.',
      detail:
        'Telegram routing is up, but the latest live-proof marker is still pending after startup.',
    });
  }

  return buildTruth({
    proofState:
      assistantHealth.status === 'healthy'
        ? 'near_live_only'
        : 'externally_blocked',
    blocker:
      roundtrip.detail ||
      transport?.detail ||
      assistantHealth.detail ||
      'Telegram live proof is not currently healthy on this host.',
    blockerOwner: assistantHealth.status === 'healthy' ? 'none' : 'external',
    nextAction:
      assistantHealth.status === 'healthy'
        ? 'Rerun npm run telegram:user:smoke to refresh the Telegram live-proof marker.'
        : 'Repair the Telegram transport or roundtrip path on this host, then rerun npm run telegram:user:smoke.',
    detail:
      roundtrip.detail ||
      transport?.detail ||
      'Telegram live proof needs another same-host confirmation.',
  });
}

function buildAlexaTruth(
  projectRoot: string,
  review: PilotReviewSnapshotLike,
): FieldTrialAlexaTruth {
  const env = readEnvFile(['ALEXA_SKILL_ID']);
  const configured = Boolean(process.env.ALEXA_SKILL_ID || env.ALEXA_SKILL_ID);
  const recommendedUtterance =
    '`Open Andrea Assistant` then `What am I forgetting?`';
  const confirmCommand = 'npm run services:status';
  const successShape =
    'Success looks like IntentRequest + WhatAmIForgettingIntent + a handled response source + proof freshness=fresh.';
  const staleShape =
    'Stale looks like a handled IntentRequest is still present, but proof freshness=stale and Alexa remains near_live_only.';
  const failureChecklist =
    'Check for no IntentRequest, LaunchRequest only, responseSource=received_trusted_request, responseSource=barrier/fallback/help/launch, stale interaction model, endpoint/account-link mismatch, or the signed request never reaching this host.';
  const alexaModelSync = getAlexaModelSyncStatus(projectRoot);
  const modelSyncStep =
    alexaModelSync.syncStatus === 'pending'
      ? 'Import docs/alexa/interaction-model.en-US.json in the Alexa Developer Console, run Build Model, then run npm run setup -- --step alexa-model-sync mark-synced.'
      : '';

  if (!configured) {
    return {
      ...buildTruth({
        proofState: 'not_intended_for_trial',
        detail: 'Alexa is not configured on this host.',
      }),
      lastSignedRequestAt: 'none',
      lastSignedRequestType: 'none',
      lastSignedIntent: 'none',
      lastSignedResponseSource: 'none',
      lastHandledProofAt: 'none',
      lastHandledProofIntent: 'none',
      lastHandledProofResponseSource: 'none',
      proofKind: 'none',
      proofFreshness: 'none',
      proofAgeMinutes: null,
      proofAgeLabel: 'none',
      recommendedUtterance,
      confirmCommand,
      successShape,
      staleShape,
      failureChecklist,
    };
  }

  const assessment = assessAlexaLiveProof({
    projectRoot,
  });
  const pilotProofFallback =
    assessment.proofState === 'live_proven'
      ? null
      : getAlexaPilotProofFallback(review);
  const lastSignedRequest = assessment.lastSignedRequest;
  const lastHandledProofIntent =
    assessment.lastHandledProofIntent ||
    (pilotProofFallback
      ? {
          updatedAt: pilotProofFallback.proofAt,
          requestId: `pilot:${pilotProofFallback.event.eventId}`,
          requestType: 'IntentRequest',
          intentName: 'alexa_orientation',
          applicationIdVerified: true,
          linkingResolved: true,
          groupFolder: pilotProofFallback.event.groupFolder,
          responseSource: 'pilot_recent_success',
        }
      : null);
  const proofState = pilotProofFallback ? 'live_proven' : assessment.proofState;
  const proofKind = pilotProofFallback
    ? 'handled_intent'
    : assessment.proofKind;
  const proofFreshness = pilotProofFallback
    ? 'fresh'
    : assessment.proofFreshness;
  const proofAgeMs = pilotProofFallback
    ? pilotProofFallback.proofAgeMs
    : assessment.proofAgeMs;
  const proofAgeMinutes = pilotProofFallback
    ? pilotProofFallback.proofAgeMinutes
    : assessment.proofAgeMinutes;
  const proofAgeLabel = pilotProofFallback
    ? pilotProofFallback.proofAgeLabel
    : formatAlexaProofAgeLabel(assessment.proofAgeMs);
  const combinedNextAction = pilotProofFallback
    ? ''
    : [
        modelSyncStep,
        assessment.nextAction ||
          'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
      ]
        .filter(Boolean)
        .join(' Then ');
  const detail = pilotProofFallback
    ? `Alexa is still credited as live-proven on this host because a recent Andrea custom-skill orientation turn succeeded ${formatProofMoment(
        pilotProofFallback.proofAt,
      )}, and that proof survives restart while it stays fresh.`
    : assessment.proofState === 'live_proven'
      ? assessment.detail
      : assessment.proofKind === 'launch_only'
        ? 'Alexa has only recorded a signed LaunchRequest here so far. Open the skill, then ask `What am I forgetting?` to produce a handled proof turn.'
        : assessment.proofKind === 'signed_intent_unhandled'
          ? `Alexa recorded a signed IntentRequest, but the latest response source was ${lastSignedRequest?.responseSource || 'none'}, so it does not qualify as handled live proof yet.`
          : assessment.proofKind === 'handled_intent' &&
              assessment.proofFreshness === 'stale'
            ? `Alexa did record a handled signed intent ${assessment.proofAgeLabel} ago, but proof older than 24 hours is treated as stale.`
            : assessment.proofKind === 'none' && modelSyncStep
              ? 'Alexa has not recorded a fresh handled signed turn on this host yet, and the latest repo interaction model still has not been marked as synced in the Alexa Developer Console.'
              : 'Alexa listener, ingress, and account-link health can still be green even when no fresh handled signed live turn has been recorded on this host.';

  return {
    ...buildTruth({
      proofState,
      blocker: pilotProofFallback ? '' : assessment.blocker,
      blockerOwner: proofState === 'live_proven' ? 'none' : 'external',
      nextAction: combinedNextAction,
      detail,
    }),
    lastSignedRequestAt: lastSignedRequest?.updatedAt || 'none',
    lastSignedRequestType: lastSignedRequest?.requestType || 'none',
    lastSignedIntent: lastSignedRequest?.intentName || 'none',
    lastSignedResponseSource: lastSignedRequest?.responseSource || 'none',
    lastHandledProofAt: lastHandledProofIntent?.updatedAt || 'none',
    lastHandledProofIntent: lastHandledProofIntent?.intentName || 'none',
    lastHandledProofResponseSource:
      lastHandledProofIntent?.responseSource || 'none',
    proofKind,
    proofFreshness,
    proofAgeMinutes,
    proofAgeLabel,
    recommendedUtterance,
    confirmCommand,
    successShape,
    staleShape,
    failureChecklist,
  };
}

function buildBlueBubblesTruth(
  projectRoot: string,
  hostSnapshot: HostControlSnapshot,
  review: PilotReviewSnapshotLike,
): FieldTrialBlueBubblesTruth {
  const now = new Date();
  const config = resolveBlueBubblesConfig();
  const monitorState = readBlueBubblesMonitorState(projectRoot);
  const snapshot = buildBlueBubblesHealthSnapshot(config);
  const bluebubblesChannel =
    hostSnapshot.assistantHealthState?.channels.find(
      (channel) => channel.name === 'bluebubbles',
    ) || null;
  const channelDetail =
    bluebubblesChannel?.detail ||
    snapshot.detail ||
    'No BlueBubbles transport detail is available yet.';
  const webhookRegistration =
    deriveBlueBubblesWebhookRegistrationTruth(channelDetail);
  const transportDiagnostics =
    deriveBlueBubblesTransportDiagnostics(channelDetail);
  const effectiveLastInboundChatFromDiagnostics =
    transportDiagnostics.lastInboundChatJid !== 'none'
      ? transportDiagnostics.lastInboundChatJid
      : monitorState.lastInboundChatJid || 'none';
  const effectiveLastInboundWasSelfAuthored =
    transportDiagnostics.lastInboundWasSelfAuthored != null
      ? transportDiagnostics.lastInboundWasSelfAuthored
      : (monitorState.lastInboundWasSelfAuthored ?? false);
  const effectiveLastOutboundTargetKind =
    transportDiagnostics.lastOutboundTargetKind !== 'none'
      ? transportDiagnostics.lastOutboundTargetKind
      : monitorState.lastOutboundTargetKind || 'none';
  const effectiveLastOutboundTarget =
    transportDiagnostics.lastOutboundTarget !== 'none'
      ? transportDiagnostics.lastOutboundTarget
      : monitorState.lastOutboundTargetValue || 'none';
  const effectiveLastSendErrorDetail =
    transportDiagnostics.lastSendErrorDetail !== 'none'
      ? transportDiagnostics.lastSendErrorDetail
      : monitorState.lastSendErrorDetail || 'none';
  const effectiveLastMetadataHydrationSource =
    transportDiagnostics.lastMetadataHydrationSource !== 'none'
      ? transportDiagnostics.lastMetadataHydrationSource
      : monitorState.lastMetadataHydrationSource || 'none';
  const effectiveAttemptedTargetSequence =
    transportDiagnostics.attemptedTargetSequence !== 'none'
      ? transportDiagnostics.attemptedTargetSequence
      : monitorState.lastAttemptedTargetSequence.join(' -> ') || 'none';
  const bluebubblesChats = getAllChats().filter((chat) =>
    chat.jid.startsWith('bb:'),
  );
  const recentEngagement = review.recentEvents.find(
    (event) =>
      event.channel === 'bluebubbles' &&
      event.chatJid?.startsWith('bb:') === true &&
      (event.outcome === 'success' || event.outcome === 'degraded_usable'),
  );
  const freshProofCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const recentSuccesses = review.recentEvents.filter((event) => {
    const proofAt = Date.parse(event.completedAt || event.startedAt);
    return (
      event.channel === 'bluebubbles' &&
      event.chatJid?.startsWith('bb:') === true &&
      event.outcome === 'success' &&
      Number.isFinite(proofAt) &&
      proofAt >= freshProofCutoff
    );
  });
  const successCounts = new Map<string, number>();
  for (const event of recentSuccesses) {
    const chatJid = canonicalizeBlueBubblesSelfThreadJid(event.chatJid) || '';
    if (!chatJid) continue;
    successCounts.set(chatJid, (successCounts.get(chatJid) || 0) + 1);
  }
  const liveProofChatJid =
    [...successCounts.entries()].find(([, count]) => count >= 2)?.[0] || null;
  const recentMessageActionProofs = listMessageActionsForGroup({
    groupFolder: config.groupFolder || 'main',
    includeSent: true,
    limit: 80,
  })
    .map((action) => {
      const observedProofChatJid =
        resolveBlueBubblesMessageActionProofTarget(action);
      const proofChatJid =
        canonicalizeBlueBubblesSelfThreadJid(observedProofChatJid) ||
        observedProofChatJid;
      const proofAt = Date.parse(action.lastActionAt || action.sentAt || '');
      return {
        action,
        observedProofChatJid,
        proofChatJid,
        proofAt,
      };
    })
    .filter(
      ({ action, proofChatJid, proofAt }) =>
        action.targetChannel === 'bluebubbles' &&
        action.targetKind === 'external_thread' &&
        proofChatJid?.startsWith('bb:') === true &&
        Number.isFinite(proofAt) &&
        proofAt >= freshProofCutoff &&
        ['sent', 'scheduled_send', 'remind_instead', 'save_to_thread'].includes(
          action.lastActionKind || '',
        ),
    )
    .sort((left, right) => right.proofAt - left.proofAt);
  const matchingMessageActionProof = liveProofChatJid
    ? recentMessageActionProofs.find(
        (entry) => entry.proofChatJid === liveProofChatJid,
      ) || null
    : null;
  const continuity = reconcileBlueBubblesSelfThreadContinuity({
    groupFolder: config.groupFolder || 'main',
    chatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    now,
    allowRehydrate: true,
  });
  const continuitySnapshots = listBlueBubblesMessageActionContinuitySnapshots({
    groupFolder: config.groupFolder || 'main',
    now,
    allowRehydrate: true,
  });
  const primaryContinuity = continuitySnapshots[0] || continuity;

  let lastInboundObservedAt = 'none';
  let lastOutboundResult = 'none';
  let lastOutboundObservedAt = monitorState.lastOutboundObservedAt || 'none';
  let lastOutboundChatJid = monitorState.lastOutboundObservedChatJid || 'none';
  let lastInboundChatJid = effectiveLastInboundChatFromDiagnostics;
  let lastInboundWasSelfAuthored = effectiveLastInboundWasSelfAuthored;
  for (const chat of bluebubblesChats) {
    const recentMessages = listRecentMessagesForChat(chat.jid, 12);
    const inbound = recentMessages.find((message) => !message.is_bot_message);
    const outbound = recentMessages.find((message) => message.is_bot_message);
    if (
      inbound &&
      (lastInboundObservedAt === 'none' ||
        inbound.timestamp > lastInboundObservedAt)
    ) {
      lastInboundObservedAt = inbound.timestamp;
      lastInboundChatJid = chat.jid;
      lastInboundWasSelfAuthored = Boolean(inbound.is_from_me);
    }
    if (
      outbound &&
      (lastOutboundResult === 'none' || outbound.timestamp > lastOutboundResult)
    ) {
      lastOutboundResult = `${outbound.timestamp} (${chat.jid})`;
      lastOutboundObservedAt = outbound.timestamp;
      lastOutboundChatJid = chat.jid;
    }
  }

  const activeSelfThreadChat =
    pickMostRecentBlueBubblesChat([
      continuity.recentTargetChatJid !== 'none'
        ? {
            chatJid: continuity.recentTargetChatJid,
            at: continuity.recentTargetAt,
          }
        : {
            chatJid: null,
            at: null,
          },
      canonicalizeBlueBubblesProofCandidate({
        chatJid:
          matchingMessageActionProof?.proofChatJid ||
          recentMessageActionProofs[0]?.proofChatJid ||
          null,
        at:
          matchingMessageActionProof?.action.lastActionAt ||
          matchingMessageActionProof?.action.sentAt ||
          recentMessageActionProofs[0]?.action.lastActionAt ||
          recentMessageActionProofs[0]?.action.sentAt ||
          null,
      }),
      canonicalizeBlueBubblesProofCandidate({
        chatJid: recentEngagement?.chatJid || null,
        at:
          recentEngagement?.completedAt || recentEngagement?.startedAt || null,
      }),
      canonicalizeBlueBubblesProofCandidate({
        chatJid: lastOutboundChatJid,
        at: lastOutboundObservedAt,
      }),
      lastInboundWasSelfAuthored
        ? canonicalizeBlueBubblesProofCandidate({
            chatJid: lastInboundChatJid,
            at: lastInboundObservedAt,
          })
        : {
            chatJid: null,
            at: null,
          },
    ]) || null;
  const freshestObservedTrafficChat =
    pickMostRecentBlueBubblesChat([
      canonicalizeBlueBubblesProofCandidate({
        chatJid: lastInboundChatJid,
        at: lastInboundObservedAt,
      }),
      canonicalizeBlueBubblesProofCandidate({
        chatJid: lastOutboundChatJid,
        at: lastOutboundObservedAt,
      }),
      canonicalizeBlueBubblesProofCandidate({
        chatJid: recentEngagement?.chatJid || null,
        at:
          recentEngagement?.completedAt || recentEngagement?.startedAt || null,
      }),
    ]) || null;
  const activeProofChat = activeSelfThreadChat || freshestObservedTrafficChat;
  const proofChainChatJid =
    liveProofChatJid ||
    activeProofChat?.chatJid ||
    canonicalizeBlueBubblesSelfThreadJid(recentEngagement?.chatJid) ||
    recentEngagement?.chatJid ||
    null;
  const recentProofChainMessages = listRecentMessagesForBlueBubblesProofChat(
    proofChainChatJid,
    8,
  );
  const matchingProofChainMessageAction = proofChainChatJid
    ? recentMessageActionProofs.find(
        (entry) => entry.proofChatJid === proofChainChatJid,
      ) || null
    : null;
  const draftLikeReplyMessage = matchingProofChainMessageAction
    ? null
    : recentProofChainMessages.find(
        (message) =>
          message.is_bot_message &&
          isLikelyBlueBubblesDraftReply(message.content),
      ) || null;
  const draftLikeReplyWithoutAction =
    !matchingProofChainMessageAction && Boolean(draftLikeReplyMessage);
  const continuityState = primaryContinuity.continuityState;
  const effectiveReplyGateChatJid =
    activeSelfThreadChat?.chatJid ||
    activeProofChat?.chatJid ||
    canonicalizeBlueBubblesSelfThreadJid(recentEngagement?.chatJid) ||
    recentEngagement?.chatJid ||
    null;
  const effectiveReplyGateContinuity = effectiveReplyGateChatJid
    ? reconcileBlueBubblesMessageActionContinuity({
        groupFolder: config.groupFolder || 'main',
        chatJid: effectiveReplyGateChatJid,
        now,
        allowRehydrate: true,
      })
    : null;
  const representativeContinuity =
    effectiveReplyGateContinuity || primaryContinuity;
  const effectiveReplyGateIsGroup = effectiveReplyGateChatJid
    ? (bluebubblesChats.find((chat) => chat.jid === effectiveReplyGateChatJid)
        ?.is_group ?? 0) !== 0
    : null;
  const effectiveReplyGateMode = effectiveReplyGateContinuity
    ? effectiveReplyGateContinuity.requiresExplicitMention
      ? 'mention_required'
      : 'direct_1to1'
    : effectiveReplyGateChatJid
      ? resolveBlueBubblesReplyGateMode({
          chatJid: effectiveReplyGateChatJid,
          isGroup: effectiveReplyGateIsGroup,
        })
      : deriveBlueBubblesReplyGateMode(channelDetail) || 'mention_required';
  const sameThreadContinuationProof = matchingProofChainMessageAction
    ? findBlueBubblesSameThreadContinuationAfterAction(
        proofChainChatJid,
        matchingProofChainMessageAction.action.lastActionAt ||
          matchingProofChainMessageAction.action.sentAt,
        recentProofChainMessages,
      )
    : null;
  const sameThreadDecisionConfirmationProof = matchingProofChainMessageAction
    ? findBlueBubblesSameThreadDecisionConfirmation(
        proofChainChatJid,
        matchingProofChainMessageAction.action.lastActionAt ||
          matchingProofChainMessageAction.action.sentAt,
        recentProofChainMessages,
      )
    : null;
  const sameThreadProof =
    sameThreadContinuationProof || sameThreadDecisionConfirmationProof;
  const creditedLiveProofChatJid =
    sameThreadProof && proofChainChatJid ? proofChainChatJid : liveProofChatJid;
  const blueBubblesSelfThreadAliasDetail =
    isBlueBubblesSelfThreadAliasJid(lastInboundChatJid) ||
    isBlueBubblesSelfThreadAliasJid(lastOutboundChatJid) ||
    isBlueBubblesSelfThreadAliasJid(recentEngagement?.chatJid)
      ? ` Canonical self-thread: ${BLUEBUBBLES_CANONICAL_SELF_THREAD_JID}. Alias support stays enabled for bb:iMessage;-;jeffstory007@gmail.com.`
      : '';
  const rawDerivedDetectionState = extractBlueBubblesDetailField(
    channelDetail,
    'detection',
  );
  const derivedDetectionState =
    normalizeBlueBubblesDetailValue(rawDerivedDetectionState) || 'none';
  const rawDerivedDetectionDetail = extractBlueBubblesDetailField(
    channelDetail,
    'detection detail',
  );
  const derivedDetectionDetail = normalizeBlueBubblesDetailValue(
    rawDerivedDetectionDetail,
  );
  const rawDerivedDetectionNextAction = extractBlueBubblesDetailField(
    channelDetail,
    'detection next action',
  );
  const derivedDetectionNextAction = normalizeBlueBubblesDetailValue(
    rawDerivedDetectionNextAction,
  );
  const rawDerivedShadowPollError = extractBlueBubblesDetailField(
    channelDetail,
    'shadow poll error',
  );
  const derivedShadowPollError = normalizeBlueBubblesDetailValue(
    rawDerivedShadowPollError,
  );
  const rawDerivedShadowPollLastOk = extractBlueBubblesDetailField(
    channelDetail,
    'shadow poll last ok',
  );
  const derivedShadowPollLastOk = normalizeBlueBubblesDetailValue(
    rawDerivedShadowPollLastOk,
  );
  const rawDerivedServerSeenChat = extractBlueBubblesDetailField(
    channelDetail,
    'server seen chat',
  );
  const derivedServerSeenChat = normalizeBlueBubblesDetailValue(
    rawDerivedServerSeenChat,
  );
  const rawDerivedServerSeenAt = extractBlueBubblesDetailField(
    channelDetail,
    'server seen at',
  );
  const derivedServerSeenAt = normalizeBlueBubblesDetailValue(
    rawDerivedServerSeenAt,
  );
  const derivedActiveEndpoint = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(channelDetail, 'active endpoint'),
  );
  const derivedCandidateProbeResults = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(channelDetail, 'candidate probe results'),
  );
  const derivedFallbackState =
    extractBlueBubblesDetailField(channelDetail, 'fallback') || null;
  const derivedFallbackLastSent =
    extractBlueBubblesDetailField(channelDetail, 'fallback last sent') || null;
  const derivedWebhookRegistrationDetail = normalizeBlueBubblesDetailValue(
    extractBlueBubblesDetailField(channelDetail, 'webhook registration'),
  );
  const derivedWebhookRegistrationState =
    deriveBlueBubblesWebhookRegistrationState(channelDetail);
  const derivedTransportProbeState =
    deriveBlueBubblesTransportProbeState(channelDetail);
  const persistedCandidateProbeResults =
    Object.entries(monitorState.candidateProbeResults).length > 0
      ? Object.entries(monitorState.candidateProbeResults)
          .map(([baseUrl, detail]) => `${baseUrl} => ${detail}`)
          .join(' | ')
      : null;
  const effectiveCandidateProbeResults = derivedCandidateProbeResults
    ? derivedCandidateProbeResults.replace(/ \|\| /g, ' | ')
    : persistedCandidateProbeResults || null;
  const effectiveWebhookRegistrationState =
    derivedWebhookRegistrationState || webhookRegistration.state;
  const effectiveWebhookRegistrationDetail =
    derivedWebhookRegistrationDetail || webhookRegistration.detail;
  const effectiveTransportProbeState =
    derivedTransportProbeState !== 'not_checked'
      ? derivedTransportProbeState
      : bluebubblesChannel?.state === 'ready'
        ? 'reachable'
        : 'not_checked';
  const effectiveShadowPollLastOkAt =
    rawDerivedShadowPollLastOk === 'none'
      ? 'none'
      : derivedShadowPollLastOk || monitorState.shadowPollLastOkAt || 'none';
  const effectiveShadowPollLastError =
    rawDerivedShadowPollError === 'none'
      ? 'none'
      : derivedShadowPollError || monitorState.shadowPollLastError || 'none';
  const effectiveMostRecentServerSeenChat =
    rawDerivedServerSeenChat === 'none'
      ? 'none'
      : derivedServerSeenChat ||
        monitorState.mostRecentServerSeenChatJid ||
        'none';
  const effectiveMostRecentServerSeenAt =
    rawDerivedServerSeenAt === 'none'
      ? 'none'
      : derivedServerSeenAt || monitorState.mostRecentServerSeenAt || 'none';
  const mostRecentWebhookObservedAt =
    monitorState.mostRecentWebhookObservedAt || 'none';
  const mostRecentWebhookObservedChatJid =
    monitorState.mostRecentWebhookObservedChatJid || 'none';
  const webhookCaughtUpToServer =
    effectiveMostRecentServerSeenChat !== 'none' &&
    effectiveMostRecentServerSeenAt !== 'none' &&
    mostRecentWebhookObservedChatJid === effectiveMostRecentServerSeenChat &&
    (parseFieldTrialIsoTime(mostRecentWebhookObservedAt) ?? -1) >=
      (parseFieldTrialIsoTime(effectiveMostRecentServerSeenAt) ??
        Number.MAX_SAFE_INTEGER);
  const hasRecentBlueBubblesReplyFailure = monitorState.recentEvidence.some(
    (entry) => entry.kind === 'reply_delivery_failed',
  );
  const shadowMonitorOverrideAllowed =
    derivedDetectionState === 'none' ||
    derivedDetectionState === 'ignored_by_gate_or_scope' ||
    derivedDetectionState === 'transport_unreachable';
  const shadowMonitorUnstable =
    effectiveTransportProbeState === 'reachable' &&
    effectiveWebhookRegistrationState === 'registered' &&
    effectiveShadowPollLastError !== 'none' &&
    effectiveShadowPollLastOkAt === 'none' &&
    effectiveMostRecentServerSeenChat === 'none' &&
    shadowMonitorOverrideAllowed;
  const liveDetectionEnvelopePresent =
    rawDerivedDetectionState !== null ||
    rawDerivedDetectionDetail !== null ||
    rawDerivedDetectionNextAction !== null;
  let effectiveDetectionState =
    derivedDetectionState !== 'none'
      ? derivedDetectionState
      : monitorState.detectionState;
  const staleReachabilityDetail = (
    liveDetectionEnvelopePresent
      ? derivedDetectionDetail || ''
      : monitorState.detectionDetail || ''
  ).toLowerCase();
  if (shadowMonitorUnstable) {
    effectiveDetectionState = 'mixed_degraded';
  } else if (
    staleReachabilityDetail.includes('could not reach the bluebubbles server')
  ) {
    effectiveDetectionState =
      effectiveTransportProbeState === 'reachable'
        ? 'mixed_degraded'
        : 'transport_unreachable';
  } else if (
    webhookCaughtUpToServer &&
    (effectiveDetectionState === 'suspected_missed_inbound' ||
      effectiveDetectionState === 'mixed_degraded')
  ) {
    effectiveDetectionState = hasRecentBlueBubblesReplyFailure
      ? 'reply_delivery_broken'
      : 'healthy';
  }
  const effectiveDetectionDetail =
    webhookCaughtUpToServer &&
    (derivedDetectionState === 'suspected_missed_inbound' ||
      derivedDetectionState === 'mixed_degraded' ||
      monitorState.detectionState === 'suspected_missed_inbound' ||
      monitorState.detectionState === 'mixed_degraded')
      ? null
      : shadowMonitorUnstable
        ? `Andrea can reach the BlueBubbles bridge from this PC, but the recent-activity shadow poll is failing (${effectiveShadowPollLastError}), so the same-thread health check is not trustworthy yet.`
        : liveDetectionEnvelopePresent
          ? derivedDetectionDetail || null
          : monitorState.detectionDetail ||
            (effectiveDetectionState === 'transport_unreachable' &&
            derivedShadowPollError
              ? `Andrea could not reach the BlueBubbles server from this host. ${derivedShadowPollError}`
              : null) ||
            null;
  const effectiveDetectionNextAction =
    webhookCaughtUpToServer &&
    (derivedDetectionState === 'suspected_missed_inbound' ||
      derivedDetectionState === 'mixed_degraded' ||
      monitorState.detectionState === 'suspected_missed_inbound' ||
      monitorState.detectionState === 'mixed_degraded')
      ? null
      : shadowMonitorUnstable
        ? 'Check the BlueBubbles recent-message endpoint and shadow-poll path for this Windows host, then retry the same 1:1 Messages thread.'
        : liveDetectionEnvelopePresent
          ? derivedDetectionNextAction || null
          : monitorState.detectionNextAction ||
            (effectiveDetectionState === 'transport_unreachable'
              ? 'Check the BlueBubbles server endpoint for this Windows host, prefer a stable IP or explicit candidate list over a .local hostname, then retry the same 1:1 Messages thread.'
              : null) ||
            null;
  const effectiveChannelDetail =
    webhookCaughtUpToServer &&
    (derivedDetectionState === 'suspected_missed_inbound' ||
      derivedDetectionState === 'mixed_degraded' ||
      monitorState.detectionState === 'suspected_missed_inbound' ||
      monitorState.detectionState === 'mixed_degraded')
      ? channelDetail
          .split(' | ')
          .filter(
            (part) =>
              part !== 'detection suspected_missed_inbound' &&
              !part.startsWith('detection detail ') &&
              !part.startsWith('detection next action '),
          )
          .concat('detection healthy')
          .join(' | ')
      : channelDetail;
  const bridgeAvailability: AppleMessagesBridgeAvailability =
    config.enabled &&
    snapshot.configured &&
    Boolean(config.webhookPublicBaseUrl) &&
    config.sendEnabled &&
    effectiveTransportProbeState === 'reachable' &&
    effectiveWebhookRegistrationState === 'registered'
      ? 'available'
      : 'unavailable';

  const base: Omit<FieldTrialBlueBubblesTruth, keyof FieldTrialSurfaceTruth> = {
    providerName: 'bluebubbles',
    bridgeAvailability,
    configured: snapshot.configured,
    serverBaseUrl: config.baseUrl || 'none',
    activeServerBaseUrl:
      derivedActiveEndpoint || monitorState.activeBaseUrl || 'none',
    serverBaseUrlCandidates:
      config.baseUrlCandidates.length > 0
        ? config.baseUrlCandidates.join(' | ')
        : config.baseUrl || 'none',
    serverBaseUrlCandidateResults: effectiveCandidateProbeResults || 'none',
    listenerHost: config.host,
    listenerPort: config.port,
    publicWebhookUrl:
      config.enabled === true
        ? redactBlueBubblesWebhookUrl(buildBlueBubblesWebhookUrl(config))
        : 'none',
    webhookRegistrationState: effectiveWebhookRegistrationState,
    webhookRegistrationDetail: effectiveWebhookRegistrationDetail,
    chatScope: config.chatScope,
    configuredReplyGateMode: resolveConfiguredBlueBubblesReplyGateMode(config),
    effectiveReplyGateMode,
    replyGateMode: effectiveReplyGateMode,
    mostRecentEngagedChatJid:
      activeProofChat?.chatJid || recentEngagement?.chatJid || 'none',
    mostRecentEngagedAt:
      activeProofChat?.at ||
      recentEngagement?.completedAt ||
      recentEngagement?.startedAt ||
      'none',
    lastInboundObservedAt,
    lastInboundChatJid,
    lastInboundWasSelfAuthored,
    lastOutboundResult,
    lastOutboundTargetKind: effectiveLastOutboundTargetKind,
    lastOutboundTarget: effectiveLastOutboundTarget,
    lastSendErrorDetail:
      effectiveLastSendErrorDetail !== 'none'
        ? effectiveLastSendErrorDetail
        : bluebubblesChannel?.lastError || 'none',
    sendMethod: transportDiagnostics.sendMethod,
    privateApiAvailable: transportDiagnostics.privateApiAvailable,
    lastMetadataHydrationSource: effectiveLastMetadataHydrationSource,
    attemptedTargetSequence: effectiveAttemptedTargetSequence,
    transportState: bluebubblesChannel?.state || snapshot.state,
    transportDetail: effectiveChannelDetail,
    detectionState: effectiveDetectionState,
    detectionDetail: effectiveDetectionDetail || 'none',
    detectionNextAction: effectiveDetectionNextAction || 'none',
    shadowPollLastOkAt: effectiveShadowPollLastOkAt,
    shadowPollLastError: effectiveShadowPollLastError,
    shadowPollMostRecentChat:
      rawDerivedServerSeenChat === 'none'
        ? 'none'
        : monitorState.shadowPollMostRecentChat ||
          derivedServerSeenChat ||
          'none',
    mostRecentServerSeenAt: effectiveMostRecentServerSeenAt,
    mostRecentServerSeenChatJid: effectiveMostRecentServerSeenChat,
    mostRecentWebhookObservedAt,
    mostRecentWebhookObservedChatJid,
    lastIgnoredAt: monitorState.lastIgnoredAt || 'none',
    lastIgnoredChatJid: monitorState.lastIgnoredChatJid || 'none',
    lastIgnoredReason: monitorState.lastIgnoredReason || 'none',
    crossSurfaceFallbackState:
      derivedFallbackState && derivedFallbackState !== 'none'
        ? derivedFallbackState
        : monitorState.crossSurfaceFallbackState,
    crossSurfaceFallbackLastSentAt:
      derivedFallbackState !== null
        ? derivedFallbackLastSent && derivedFallbackLastSent !== 'none'
          ? derivedFallbackLastSent
          : 'none'
        : monitorState.crossSurfaceFallbackLastSentAt || 'none',
    recentTargetChatJid:
      representativeContinuity.recentTargetChatJid !== 'none'
        ? representativeContinuity.recentTargetChatJid
        : activeSelfThreadChat?.chatJid ||
          activeProofChat?.chatJid ||
          canonicalizeBlueBubblesSelfThreadJid(recentEngagement?.chatJid) ||
          recentEngagement?.chatJid ||
          'none',
    recentTargetAt:
      representativeContinuity.recentTargetAt !== 'none'
        ? representativeContinuity.recentTargetAt
        : activeSelfThreadChat?.at ||
          activeProofChat?.at ||
          recentEngagement?.completedAt ||
          recentEngagement?.startedAt ||
          'none',
    openMessageActionCount: representativeContinuity.openMessageActionCount,
    continuityState: representativeContinuity.continuityState,
    proofCandidateChatJid:
      continuity.proofCandidateChatJid !== 'none'
        ? continuity.proofCandidateChatJid
        : proofChainChatJid ||
          matchingProofChainMessageAction?.proofChatJid ||
          recentMessageActionProofs[0]?.proofChatJid ||
          'none',
    activeMessageActionId:
      representativeContinuity.activeMessageActionId || 'none',
    conversationKind: representativeContinuity.conversationKind,
    decisionPolicy: representativeContinuity.decisionPolicy,
    conversationalEligibility:
      representativeContinuity.conversationalEligibility,
    requiresExplicitMention: representativeContinuity.requiresExplicitMention,
    activePresentationAt: representativeContinuity.activePresentationAt,
    eligibleFollowups: [...representativeContinuity.eligibleFollowups],
    canonicalSelfThreadChatJid:
      representativeContinuity.canonicalSelfThreadChatJid ||
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    sourceSelfThreadChatJid:
      representativeContinuity.sourceSelfThreadChatJid ||
      representativeContinuity.canonicalSelfThreadChatJid ||
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    messageActionProofState: matchingProofChainMessageAction
      ? 'fresh'
      : recentMessageActionProofs.length > 0
        ? 'stale'
        : 'none',
    messageActionProofChatJid:
      matchingProofChainMessageAction?.proofChatJid ||
      recentMessageActionProofs[0]?.proofChatJid ||
      'none',
    messageActionProofAt:
      matchingProofChainMessageAction?.action.lastActionAt ||
      matchingProofChainMessageAction?.action.sentAt ||
      recentMessageActionProofs[0]?.action.lastActionAt ||
      recentMessageActionProofs[0]?.action.sentAt ||
      'none',
    messageActionProofDetail: matchingProofChainMessageAction
      ? `Recent same-chat message action is recorded in ${matchingProofChainMessageAction.proofChatJid}.${blueBubblesSelfThreadAliasDetail}`
      : continuity.activeMessageActionId
        ? `A fresh BlueBubbles same-thread draft is active in ${continuity.canonicalSelfThreadChatJid || proofChainChatJid || BLUEBUBBLES_CANONICAL_SELF_THREAD_JID}, and it is waiting for a decision.${blueBubblesSelfThreadAliasDetail}`
        : draftLikeReplyWithoutAction && proofChainChatJid
          ? continuityState === 'idle'
            ? `Andrea drafted in ${draftLikeReplyMessage?.chat_jid || proofChainChatJid} earlier, but that self-thread draft is no longer fresh and no active message-action record remains.${blueBubblesSelfThreadAliasDetail}`
            : `Andrea drafted in ${draftLikeReplyMessage?.chat_jid || proofChainChatJid}, but no fresh message-action record was created yet.${blueBubblesSelfThreadAliasDetail}`
          : recentMessageActionProofs.length > 0
            ? `A recent BlueBubbles message-action decision exists in ${recentMessageActionProofs[0]!.proofChatJid}, but not in the same chat as the current proof chain.${blueBubblesSelfThreadAliasDetail}`
            : `No fresh BlueBubbles message-action decision is recorded yet.${blueBubblesSelfThreadAliasDetail}`,
  };
  const directOneToOneMode = base.effectiveReplyGateMode === 'direct_1to1';
  const blueBubblesPromptPrefix = directOneToOneMode ? '' : '@Andrea ';
  const blueBubblesWarmupPrompt = `\`${blueBubblesPromptPrefix}hi\``;
  const blueBubblesLooseEndsPrompt = `\`${blueBubblesPromptPrefix}what am I forgetting\``;
  const blueBubblesDraftPrompt = `\`${blueBubblesPromptPrefix}what should I say back\``;
  const blueBubblesSendPrompt = `\`${blueBubblesPromptPrefix}send it\``;
  const blueBubblesSendLaterPrompt = `\`${blueBubblesPromptPrefix}send it later tonight\``;

  if (
    !config.enabled &&
    !config.baseUrl &&
    !config.password &&
    config.allowedChatGuids.length === 0
  ) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          "Messages bridge is not configured on this PC, so use Telegram as Andrea's dependable main messaging surface.",
        blockerOwner: 'external',
        nextAction:
          'Load the BLUEBUBBLES_* connection values on this Windows host, wire the Mac-side webhook to Andrea, and repro one real inbound -> reply -> follow-up flow.',
        detail:
          'Repo-side BlueBubbles harnesses can still pass here, but Andrea does not currently have a live Messages bridge configured on this PC.',
      }),
      ...base,
    };
  }

  if (!config.enabled) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          "Messages bridge is disabled on this PC, so use Telegram as Andrea's dependable main messaging surface.",
        blockerOwner: 'external',
        nextAction:
          'Enable BLUEBUBBLES_ENABLED and point this host at the reachable BlueBubbles server/webhook.',
        detail:
          'BlueBubbles code is present, but the optional Messages bridge is intentionally disabled on this machine.',
      }),
      ...base,
    };
  }

  if (!snapshot.configured) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          snapshot.detail ||
          'Messages bridge is enabled but still missing the live server or chat-scope configuration.',
        blockerOwner: 'external',
        nextAction:
          config.chatScope === 'allowlist'
            ? 'Finish the BLUEBUBBLES_* connection values and set one or more allowed chat GUIDs for this host.'
            : 'Finish the BLUEBUBBLES_* connection values for this host.',
        detail:
          'The BlueBubbles bridge is enabled in code, but this PC is not yet configured for live scoped Messages conversations.',
      }),
      ...base,
    };
  }

  if (!config.webhookPublicBaseUrl) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          'Messages bridge does not have a public webhook URL configured for this Windows host, so Telegram remains the reliable main path.',
        blockerOwner: 'external',
        nextAction:
          'Set BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL to the Mac-reachable Andrea listener URL, then update the Mac-side BlueBubbles webhook.',
        detail:
          'Andrea can listen locally, but the Mac-side BlueBubbles server still needs a public webhook target that points back to this Windows host.',
      }),
      ...base,
    };
  }

  if (!config.sendEnabled) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          'Messages bridge can be configured here, but reply-back is still disabled on this host. Use Telegram until the bridge can answer back.',
        blockerOwner: 'external',
        nextAction:
          'Enable BLUEBUBBLES_SEND_ENABLED and repro one real inbound -> reply -> follow-up flow.',
        detail:
          'Inbound webhook handling is configured, but this PC cannot yet prove a full live reply-back flow.',
      }),
      ...base,
    };
  }

  if (effectiveDetectionState === 'transport_unreachable') {
    const detailParts = [
      base.detectionDetail !== 'none' ? base.detectionDetail : null,
      base.activeServerBaseUrl !== 'none'
        ? `Active endpoint: ${base.activeServerBaseUrl}.`
        : null,
      base.serverBaseUrlCandidates !== 'none'
        ? `Configured endpoints: ${base.serverBaseUrlCandidates}.`
        : null,
      base.serverBaseUrlCandidateResults !== 'none'
        ? `Probe results: ${base.serverBaseUrlCandidateResults}.`
        : null,
      base.crossSurfaceFallbackState !== 'idle'
        ? `Telegram fallback: ${base.crossSurfaceFallbackState}${
            base.crossSurfaceFallbackLastSentAt !== 'none'
              ? ` at ${base.crossSurfaceFallbackLastSentAt}`
              : ''
          }.`
        : null,
      channelDetail,
    ].filter(Boolean);
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          'Messages bridge is unavailable from this Windows host right now, so Messages may miss 1:1 texts before Andrea ever sees them. Use Telegram as the dependable main path.',
        blockerOwner: 'external',
        nextAction:
          base.detectionNextAction !== 'none'
            ? base.detectionNextAction
            : 'Set a reachable BlueBubbles endpoint for this host, prefer a stable IP or explicit candidate list over a .local hostname, then retry the same 1:1 Messages thread.',
        detail: detailParts.join(' '),
      }),
      ...base,
    };
  }

  if (
    effectiveDetectionState === 'suspected_missed_inbound' ||
    effectiveDetectionState === 'mixed_degraded'
  ) {
    const shadowMonitorBlocked =
      shadowMonitorUnstable && base.shadowPollLastError !== 'none';
    const blocker = shadowMonitorBlocked
      ? 'Messages bridge is reachable on this PC, but the same-thread health check is failing, so Andrea cannot trust what it is seeing there yet.'
      : effectiveDetectionState === 'mixed_degraded'
        ? 'BlueBubbles is seeing newer chat activity than Andrea on the webhook side, and a recent reply-back attempt failed too.'
        : 'BlueBubbles server is seeing newer chat activity than Andrea on the webhook side.';
    const detailParts = [
      base.detectionDetail !== 'none' ? base.detectionDetail : null,
      shadowMonitorBlocked && base.shadowPollLastError !== 'none'
        ? `Shadow poll error: ${base.shadowPollLastError}.`
        : null,
      base.shadowPollMostRecentChat !== 'none'
        ? `Most recent server-seen chat: ${base.shadowPollMostRecentChat}.`
        : null,
      base.mostRecentWebhookObservedChatJid !== 'none'
        ? `Most recent webhook-observed chat: ${base.mostRecentWebhookObservedChatJid}.`
        : null,
      base.crossSurfaceFallbackState !== 'idle'
        ? `Telegram fallback: ${base.crossSurfaceFallbackState}${
            base.crossSurfaceFallbackLastSentAt !== 'none'
              ? ` at ${base.crossSurfaceFallbackLastSentAt}`
              : ''
          }.`
        : null,
      channelDetail,
    ].filter(Boolean);
    return {
      ...buildTruth({
        proofState: 'degraded_but_usable',
        blocker: `${blocker} Telegram remains the dependable main messaging surface while this bridge is unstable.`,
        blockerOwner: shadowMonitorBlocked ? 'repo_side' : 'external',
        nextAction:
          base.detectionNextAction !== 'none'
            ? base.detectionNextAction
            : 'Check the Mac-side webhook target and Windows listener reachability, then retry the same Messages thread.',
        detail: detailParts.join(' '),
      }),
      ...base,
    };
  }

  if (
    effectiveDetectionState === 'reply_delivery_broken' &&
    !bluebubblesChannel?.lastError
  ) {
    return {
      ...buildTruth({
        proofState: 'degraded_but_usable',
        blocker:
          'Messages bridge observed a Messages turn, but reply delivery is currently breaking before Andrea can answer back. Telegram remains the dependable main path while this is unstable.',
        blockerOwner: 'repo_side',
        nextAction:
          base.detectionNextAction !== 'none'
            ? base.detectionNextAction
            : 'Inspect the BlueBubbles reply target and send method, then retry that same Messages thread.',
        detail: `${base.detectionDetail !== 'none' ? `${base.detectionDetail} ` : ''}${channelDetail}`,
      }),
      ...base,
    };
  }

  if (bluebubblesChannel?.lastError) {
    if (
      lastInboundObservedAt !== 'none' &&
      base.lastSendErrorDetail !== 'none'
    ) {
      const blocker = lastInboundWasSelfAuthored
        ? 'Messages bridge received your @Andrea message, but reply-back failed in that same chat.'
        : 'Messages bridge received a real inbound message, but reply-back failed in that same chat.';
      const nextAction = lastInboundWasSelfAuthored
        ? 'Retry the same `@Andrea` prompt in this self-chat after the direct-target fix lands. In parallel, you can still use a normal 1:1 or group thread as a second proof target.'
        : 'Retry the same `@Andrea` prompt in that chat and inspect the BlueBubbles direct-target diagnostics if reply-back still fails.';
      const detailPrefix =
        lastInboundChatJid !== 'none'
          ? `Recent inbound reached ${lastInboundChatJid}, but no Andrea reply was delivered back yet.`
          : 'A real Messages bridge inbound reached Andrea, but no Andrea reply was delivered back yet.';
      const targetDetail =
        base.lastOutboundTargetKind !== 'none'
          ? ` Andrea last tried ${base.lastOutboundTargetKind} -> ${base.lastOutboundTarget}.`
          : '';
      const sendErrorDetail =
        base.lastSendErrorDetail !== 'none'
          ? ` BlueBubbles returned: ${base.lastSendErrorDetail}.`
          : '';
      const hydrationDetail =
        base.lastMetadataHydrationSource !== 'none'
          ? ` Metadata hydration: ${base.lastMetadataHydrationSource}.`
          : '';
      const sendMethodDetail =
        base.sendMethod !== 'private-api' ||
        base.privateApiAvailable !== 'unknown'
          ? ` Send method: ${base.sendMethod} (private_api=${base.privateApiAvailable}).`
          : '';
      const attemptedTargetDetail =
        base.attemptedTargetSequence !== 'none'
          ? ` Attempted targets: ${base.attemptedTargetSequence}.`
          : '';
      return {
        ...buildTruth({
          proofState: 'degraded_but_usable',
          blocker,
          blockerOwner: 'repo_side',
          nextAction,
          detail: `${detailPrefix}${targetDetail}${sendErrorDetail}${sendMethodDetail}${hydrationDetail}${attemptedTargetDetail} ${channelDetail}`,
        }),
        ...base,
      };
    }

    const blocker =
      /unauthor/i.test(bluebubblesChannel.lastError) ||
      /forbidden/i.test(bluebubblesChannel.lastError)
        ? 'Messages bridge server auth failed from Andrea on this host.'
        : /secret/i.test(bluebubblesChannel.lastError)
          ? 'Messages bridge webhook secret mismatch is blocking live proof.'
          : `Messages bridge transport is degraded on this host: ${bluebubblesChannel.lastError}`;
    const nextAction = /secret/i.test(bluebubblesChannel.lastError)
      ? 'Update the Mac-side webhook secret to match Andrea and repro one real inbound -> reply -> follow-up flow.'
      : /unauthor|forbidden/i.test(bluebubblesChannel.lastError)
        ? 'Refresh BLUEBUBBLES_PASSWORD from the working BlueBubbles app/server pairing, then restart Andrea.'
        : 'Repair the Mac-side BlueBubbles webhook or server reachability, then repro one real same-thread flow.';
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker,
        blockerOwner: 'external',
        nextAction,
        detail: bluebubblesChannel.detail || snapshot.detail || blocker,
      }),
      ...base,
    };
  }

  if (effectiveWebhookRegistrationState === 'missing') {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          "Messages bridge transport is up, but the live server does not have Andrea's webhook registered yet.",
        blockerOwner: 'external',
        nextAction: `Register Andrea's public webhook on the BlueBubbles server, then send ${blueBubblesWarmupPrompt} from the companion thread.`,
        detail:
          'Andrea is listening on this Windows host and the BlueBubbles server is reachable, but the Mac-side server still needs the matching webhook entry before real inbound traffic can reach Andrea.',
      }),
      ...base,
    };
  }

  if (
    creditedLiveProofChatJid &&
    matchingProofChainMessageAction &&
    (sameThreadProof ||
      (liveProofChatJid &&
        lastInboundObservedAt !== 'none' &&
        lastOutboundResult !== 'none'))
  ) {
    return {
      ...buildTruth({
        proofState: 'live_proven',
        detail: sameThreadContinuationProof
          ? `Messages bridge is available on this host through BlueBubbles. Recent same-thread proof is anchored in ${creditedLiveProofChatJid}, including a fresh message-action decision and a fresh same-thread continuation after it.`
          : sameThreadDecisionConfirmationProof
            ? `Messages bridge is available on this host through BlueBubbles. Recent same-thread proof is anchored in ${creditedLiveProofChatJid}, including a fresh message-action decision and Andrea's confirmation in that same chat.`
            : `Messages bridge is available on this host through BlueBubbles. Recent same-thread proof is anchored in ${creditedLiveProofChatJid}, including a fresh message-action decision in that same chat.`,
      }),
      ...base,
    };
  }

  if (
    (activeProofChat?.chatJid || recentEngagement?.chatJid) &&
    lastInboundObservedAt !== 'none' &&
    lastOutboundResult !== 'none'
  ) {
    const activeChatJid =
      activeProofChat?.chatJid ||
      recentEngagement?.chatJid ||
      'that same BlueBubbles chat';
    return {
      ...buildTruth({
        proofState: 'degraded_but_usable',
        blocker: matchingProofChainMessageAction
          ? 'Messages bridge is available on this host through BlueBubbles, but the full same-thread follow-up proof chain is not fresh enough yet.'
          : 'Messages bridge is available on this host through BlueBubbles, but the same-thread message-action proof leg is still missing.',
        blockerOwner: 'repo_side',
        nextAction: matchingProofChainMessageAction
          ? 'Send one more same-thread BlueBubbles follow-up and confirm Andrea replies in that same conversation again.'
          : 'In that same BlueBubbles chat, ask what you should say back or send back, then use send it or send it later tonight so the message-action leg is proven too.',
        detail: matchingProofChainMessageAction
          ? `Real Messages bridge traffic is flowing on this host through ${activeChatJid}, but the full follow-up proof bar still needs one fresh same-thread continuation.`
          : `Real Messages bridge traffic is flowing on this host through ${activeChatJid}, but a fresh same-chat message-action decision is still missing. ${base.messageActionProofDetail}`,
      }),
      ...base,
    };
  }

  return {
    ...buildTruth({
      proofState: 'near_live_only',
      blocker:
        'A fresh real Messages bridge inbound -> reply -> follow-up roundtrip has not been reproved on this host yet.',
      blockerOwner: 'external',
      nextAction: `Send ${blueBubblesWarmupPrompt}, then ${blueBubblesLooseEndsPrompt}, then ${blueBubblesDraftPrompt} or \`${blueBubblesPromptPrefix}what should I send back\`, and finally ${blueBubblesSendPrompt} or ${blueBubblesSendLaterPrompt} in that same BlueBubbles conversation.`,
      detail: `Messages bridge configuration is present, but this pass still needs a real same-host roundtrip before the surface can be called fully live-proven. ${base.messageActionProofDetail}`,
    }),
    ...base,
  };
}

function buildResearchTruth(
  projectRoot: string,
  outwardResearchStatus?: BuildFieldTrialOperatorTruthOptions['outwardResearchStatus'],
): FieldTrialSurfaceTruth {
  const persisted = readProviderProofState(projectRoot);
  if (persisted?.research) {
    return buildTruth({
      ...persisted.research,
      blockerOwner:
        persisted.research.proofState === 'externally_blocked'
          ? 'external'
          : persisted.research.proofState === 'degraded_but_usable'
            ? 'repo_side'
            : 'none',
    });
  }

  if (outwardResearchStatus === 'available') {
    return buildTruth({
      proofState: 'live_proven',
      detail:
        'Outward research is currently usable and was validated on this host.',
    });
  }

  if (outwardResearchStatus === 'quota_blocked') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is blocked because the direct provider account is out of quota or billing.',
      blockerOwner: 'external',
      nextAction:
        'Restore provider quota or billing for the direct outward research account, then rerun setup -- --step verify.',
      detail:
        'The outward research path is configured but blocked by provider quota or billing.',
    });
  }

  if (outwardResearchStatus === 'misconfigured_native_openai_endpoint') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is blocked because OPENAI_BASE_URL points at native OpenAI instead of the Anthropic-compatible core runtime path.',
      blockerOwner: 'external',
      nextAction:
        'Point the core runtime back at an Anthropic-compatible gateway and keep direct provider keys separate for outward research.',
      detail: 'The research/runtime configuration is mis-keyed on this host.',
    });
  }

  if (outwardResearchStatus === 'degraded') {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker:
        'Outward research is configured but the live provider probe is currently degraded on this host.',
      blockerOwner: 'external',
      nextAction:
        'Repair the direct provider path or gateway health, then rerun setup -- --step verify.',
      detail:
        'The outward research path exists, but the live provider probe is not healthy right now.',
    });
  }

  const providerStatus = getOpenAiProviderStatus();
  if (!providerStatus.configured) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: `Outward research is blocked because ${describeOpenAiConfigBlocker(providerStatus.missing)}`,
      blockerOwner: 'external',
      nextAction:
        'Add a working OPENAI_API_KEY with quota and billing for outward research on this host.',
      detail:
        'The direct outward research path is not configured on this host, even though the local runtime backend may still be healthy.',
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'Outward research is configured, but this pass has not freshly reproved a live direct-provider answer on this host.',
    blockerOwner: 'none',
    nextAction:
      'Run one real outward research question on this host and confirm a provider-backed answer succeeds.',
    detail:
      'The direct outward research path looks configured, but it still needs a same-host live repro.',
  });
}

function buildImageGenerationTruth(
  projectRoot: string,
): FieldTrialSurfaceTruth {
  const persisted = readProviderProofState(projectRoot);
  if (persisted?.imageGeneration) {
    return buildTruth({
      ...persisted.imageGeneration,
      blockerOwner:
        persisted.imageGeneration.proofState === 'externally_blocked'
          ? 'external'
          : persisted.imageGeneration.proofState === 'degraded_but_usable'
            ? 'repo_side'
            : 'none',
    });
  }

  const providerStatus = getMediaProviderStatus();
  if (!providerStatus.configured) {
    return buildTruth({
      proofState: 'externally_blocked',
      blocker: `Image generation is blocked because ${describeOpenAiConfigBlocker(providerStatus.missing)}`,
      blockerOwner: 'external',
      nextAction:
        'Add a working OPENAI_API_KEY with image-generation access and billing on this host.',
      detail:
        'The Telegram image-generation handoff is implemented, but the live provider is not configured on this host.',
    });
  }

  return buildTruth({
    proofState: 'near_live_only',
    blocker:
      'Image generation is configured, but this pass has not freshly reproved a live Telegram image on this host.',
    blockerOwner: 'none',
    nextAction:
      'Run one real Telegram image-generation request and confirm the image artifact comes back.',
    detail:
      'The image-generation provider looks configured, but it still needs a same-host live repro.',
  });
}

function buildGoogleCalendarTruth(projectRoot: string): FieldTrialSurfaceTruth {
  const checkedAt = new Date().toISOString();
  const persisted = readProviderProofState(projectRoot);
  const config = resolveGoogleCalendarConfig();

  if (!hasGoogleCalendarCredentialMaterial(config)) {
    const blocked = buildGoogleCalendarBlockedProofSurface(
      'Set GOOGLE_CALENDAR_ACCESS_TOKEN or GOOGLE_CALENDAR_REFRESH_TOKEN plus GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET.',
      checkedAt,
      'verify',
    );
    return buildTruth({
      ...blocked,
      blockerOwner: 'external',
    });
  }

  if (persisted?.googleCalendar) {
    return buildTruth({
      ...persisted.googleCalendar,
      blockerOwner:
        persisted.googleCalendar.proofState === 'externally_blocked'
          ? 'external'
          : persisted.googleCalendar.proofState === 'degraded_but_usable'
            ? 'repo_side'
            : 'none',
    });
  }

  return buildTruth({
    ...buildGoogleCalendarNearLiveSurface({
      checkedAt,
      source: 'verify',
      validatedCalendars: [],
    }),
    detail:
      config.calendarIds.length > 0
        ? `Google Calendar credentials are configured for ${config.calendarIds.join(', ')}, but this host still needs validate/read/write proof.`
        : 'Google Calendar credentials look configured, but this host still needs validate/read/write proof.',
    nextAction:
      'Run `npm run setup -- --step google-calendar validate`, then `npm run debug:google-calendar`.',
  });
}

function buildJourneyTruths(
  review: PilotReviewSnapshotLike,
  telegramTruth: FieldTrialSurfaceTruth,
  alexaTruth: FieldTrialSurfaceTruth,
): FieldTrialJourneyTruthMap {
  return {
    ordinary_chat: buildJourneyTruthFromEvent({
      label: 'Ordinary chat',
      event: getJourneyEventById(review, 'ordinary_chat'),
      nearLiveDetail:
        telegramTruth.proofState === 'live_proven'
          ? 'Telegram is healthy, but ordinary chat needs one fresh same-host proof turn.'
          : 'Ordinary chat is waiting on the Telegram live surface.',
      nearLiveNextAction: "Send `hi` or `what's up` in Telegram on this host.",
    }),
    daily_guidance: buildJourneyTruthFromEvent({
      label: 'Daily guidance',
      event: getJourneyEventById(review, 'daily_guidance'),
      nearLiveDetail:
        'Daily guidance is ready, but it still needs one fresh `what am I forgetting` or `what should I remember tonight` proof turn.',
      nearLiveNextAction:
        'Run `what am I forgetting` or `what should I remember tonight` in Telegram on this host.',
    }),
    candace_followthrough: buildJourneyTruthFromEvent({
      label: 'Candace follow-through',
      event: getJourneyEventById(review, 'candace_followthrough'),
      nearLiveDetail:
        'Candace follow-through is ready, but it still needs one fresh same-host proof chain.',
      nearLiveNextAction:
        "Run `what's still open with Candace`, `what should I say back`, and `save that for later` in Telegram on this host.",
    }),
    mission_planning: buildJourneyTruthFromEvent({
      label: 'Mission planning',
      event: getJourneyEventById(review, 'mission_planning'),
      nearLiveDetail:
        'Mission planning is ready, but it still needs one fresh same-host proof chain.',
      nearLiveNextAction:
        "Run `help me plan tonight`, `what's the next step`, and `what's blocking this` in Telegram on this host.",
    }),
    work_cockpit: buildJourneyTruthFromEvent({
      label: 'Work cockpit',
      event: getJourneyEventById(review, 'work_cockpit'),
      nearLiveDetail:
        'The `/cursor` work cockpit is ready, but it still needs one fresh same-host dashboard and continuation proof.',
      nearLiveNextAction:
        'Run `/cursor`, `Current Work`, and one reply-linked continuation on this host.',
    }),
    cross_channel_handoff: buildJourneyTruthFromEvent({
      label: 'Cross-channel handoff',
      event: getJourneyEventById(review, 'cross_channel_handoff'),
      nearLiveDetail:
        'Cross-channel save and handoff flows are ready, but they still need one fresh same-host proof turn.',
      nearLiveNextAction:
        'Run `send me the full version` or `save that for later` from a flagship Telegram journey on this host.',
    }),
    alexa_orientation:
      alexaTruth.proofState === 'live_proven'
        ? alexaTruth
        : buildTruth({
            proofState: alexaTruth.proofState,
            blocker: alexaTruth.blocker,
            blockerOwner: alexaTruth.blockerOwner,
            nextAction: alexaTruth.nextAction,
            detail:
              alexaTruth.proofState === 'near_live_only'
                ? 'Alexa orientation stays near-live until one fresh signed turn is recorded on this host.'
                : alexaTruth.detail,
          }),
  };
}

function buildSurfaceTruthFromPilotEvidence(params: {
  label: string;
  review: PilotReviewSnapshotLike;
  predicate: (event: PilotJourneyEventRecord) => boolean;
  nearLiveDetail: string;
  nearLiveNextAction: string;
}): FieldTrialSurfaceTruth {
  return buildJourneyTruthFromEvent({
    label: params.label,
    event: getRecentJourneyEvent(params.review, params.predicate),
    nearLiveDetail: params.nearLiveDetail,
    nearLiveNextAction: params.nearLiveNextAction,
  });
}

export function buildFieldTrialOperatorTruth(
  options: BuildFieldTrialOperatorTruthOptions = {},
): FieldTrialOperatorTruth {
  const projectRoot = options.projectRoot || process.cwd();
  const hostSnapshot =
    options.hostSnapshot || readHostControlSnapshot(projectRoot);
  const windowsHost =
    options.windowsHost === undefined
      ? process.platform === 'win32'
        ? reconcileWindowsHostState({ projectRoot })
        : null
      : options.windowsHost;
  const review = buildPilotReviewSnapshot();
  const latestResponseFeedback =
    listRecentResponseFeedback({ limit: 1 })[0] || null;

  const telegram = buildTelegramTruth(hostSnapshot, windowsHost);
  const alexa = buildAlexaTruth(projectRoot, review);
  const bluebubbles = buildBlueBubblesTruth(projectRoot, hostSnapshot, review);
  const googleCalendar = buildGoogleCalendarTruth(projectRoot);
  const research = buildResearchTruth(
    projectRoot,
    options.outwardResearchStatus,
  );
  const imageGeneration = buildImageGenerationTruth(projectRoot);
  const hostHealth = buildHostHealthTruth(hostSnapshot, windowsHost);
  const journeys = buildJourneyTruths(review, telegram, alexa);

  const workCockpit = buildSurfaceTruthFromPilotEvidence({
    label: 'Work cockpit',
    review,
    predicate: (event) => event.journeyId === 'work_cockpit',
    nearLiveDetail:
      'The work cockpit is ready, but it still needs one fresh `/cursor` and `Current Work` proof chain on this host.',
    nearLiveNextAction:
      'Run `/cursor`, `Current Work`, and one reply-linked continuation on this host.',
  });
  const lifeThreads = buildSurfaceTruthFromPilotEvidence({
    label: 'Life threads',
    review,
    predicate: (event) =>
      event.threadSaved === true ||
      event.routeKey?.startsWith('threads.') === true ||
      event.systemsInvolved.includes('life_threads'),
    nearLiveDetail:
      'Life-thread tracking is ready, but it still needs one fresh same-host save or thread-control proof turn.',
    nearLiveNextAction:
      'Run `save that for later` or another explicit thread-control turn on this host.',
  });
  const communicationCompanion = buildSurfaceTruthFromPilotEvidence({
    label: 'Communication companion',
    review,
    predicate: (event) =>
      event.journeyId === 'candace_followthrough' ||
      event.systemsInvolved.includes('communication_companion'),
    nearLiveDetail:
      'Communication companion flows are ready, but they still need one fresh same-host proof turn.',
    nearLiveNextAction:
      "Run `what's still open with Candace` or `what should I say back` on this host.",
  });
  const chiefOfStaffMissions = buildSurfaceTruthFromPilotEvidence({
    label: 'Chief-of-staff and missions',
    review,
    predicate: (event) =>
      event.journeyId === 'mission_planning' ||
      event.systemsInvolved.includes('missions') ||
      event.systemsInvolved.includes('chief_of_staff'),
    nearLiveDetail:
      'Chief-of-staff and mission flows are ready, but they still need one fresh same-host proof chain.',
    nearLiveNextAction:
      "Run `help me plan tonight`, `what's the next step`, and `what's blocking this` on this host.",
  });
  const knowledgeLibrary = buildSurfaceTruthFromPilotEvidence({
    label: 'Knowledge library',
    review,
    predicate: (event) =>
      event.librarySaved === true ||
      event.systemsInvolved.includes('knowledge_library') ||
      event.routeKey?.startsWith('knowledge.') === true,
    nearLiveDetail:
      'Knowledge-library flows are ready, but they still need one fresh same-host proof save or source-grounded answer.',
    nearLiveNextAction:
      'Run one `use only my saved material` or `save this to my library` proof turn on this host.',
  });
  const actionBundlesDelegationOutcomeReview =
    buildActionBundlesDelegationOutcomeReviewTruth(review);
  const launchReadiness = buildLaunchReadinessTruth({
    projectRoot,
    hostSnapshot,
    windowsHost,
    telegram,
    alexa,
    bluebubbles,
    googleCalendar,
    workCockpit,
    lifeThreads,
    communicationCompanion,
    chiefOfStaffMissions,
    knowledgeLibrary,
    research,
    imageGeneration,
    hostHealth,
    journeys,
    actionBundlesDelegationOutcomeReview,
  });

  return {
    telegram,
    alexa,
    bluebubbles,
    googleCalendar,
    workCockpit,
    lifeThreads,
    communicationCompanion,
    chiefOfStaffMissions,
    knowledgeLibrary,
    actionBundlesDelegationOutcomeReview,
    research,
    imageGeneration,
    hostHealth,
    journeys,
    pilotIssues: {
      loggingEnabled: review.loggingEnabled,
      openCount: review.openIssueCount,
      latestSummary: review.latestOpenIssue?.summaryText || '',
      latestResponseFeedbackStatus: latestResponseFeedback?.status || '',
      latestResponseFeedbackClassification:
        latestResponseFeedback?.classification || '',
      latestResponseFeedbackSummary: latestResponseFeedback
        ? `Ask: ${latestResponseFeedback.originalUserText.slice(0, 80)} | Reply: ${latestResponseFeedback.assistantReplyText.slice(0, 80)}`
        : '',
      localHotfixPending: latestResponseFeedback?.status === 'resolved_locally',
    },
    launchReadiness,
  };
}
