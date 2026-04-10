import {
  buildBlueBubblesHealthSnapshot,
  buildBlueBubblesWebhookUrl,
  redactBlueBubblesWebhookUrl,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import { getAllChats, listMessageActionsForGroup, listRecentMessagesForChat } from './db.js';
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
  formatAlexaProofAgeLabel,
  readHostControlSnapshot,
  reconcileWindowsHostState,
  type HostControlSnapshot,
  type AlexaLiveProofFreshness,
  type AlexaLiveProofKind,
  type WindowsHostReconciliation,
} from './host-control.js';
import { getMediaProviderStatus } from './media-generation.js';
import { describeOpenAiConfigBlocker, getOpenAiProviderStatus } from './openai-provider.js';
import { buildPilotReviewSnapshot } from './pilot-mode.js';
import { readProviderProofState } from './provider-proof-state.js';
import type { PilotJourneyEventRecord, PilotJourneyId } from './types.js';

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
  configured: boolean;
  serverBaseUrl: string;
  listenerHost: string;
  listenerPort: number;
  publicWebhookUrl: string;
  webhookRegistrationState: string;
  webhookRegistrationDetail: string;
  chatScope: string;
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
  messageActionProofState: 'none' | 'fresh' | 'stale';
  messageActionProofChatJid: string;
  messageActionProofAt: string;
  messageActionProofDetail: string;
}

function parseFieldTrialIsoTime(value: string | null | undefined): number | null {
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

function canonicalizeBlueBubblesProofCandidate(
  candidate: {
    chatJid: string | null | undefined;
    at: string | null | undefined;
  },
): {
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
  const merged = scopedChats.flatMap((chatJid) => listRecentMessagesForChat(chatJid, limit));
  return merged
    .sort(
      (left, right) => Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''),
    )
    .slice(0, limit);
}

function isLikelyBlueBubblesDraftReply(content: string | null | undefined): boolean {
  const normalized = (content || '').toLowerCase();
  if (!normalized) return false;
  return (
    /\bdraft\b/.test(normalized) ||
    /^andrea:\s*(sure|here)/.test(normalized) ||
    normalized.includes('what you can send') ||
    normalized.includes('what you could send')
  );
}

function deriveBlueBubblesWebhookRegistrationTruth(detail: string): {
  state: string;
  detail: string;
} {
  const normalized = detail.toLowerCase();
  const registrationMatch = detail.match(
    /webhook registration ([^|]+?)(?: \| |$)/i,
  );
  const registrationDetail = registrationMatch?.[1]?.trim() || 'not checked yet';
  if (normalized.includes('webhook registration registered on the bluebubbles server')) {
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
    new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([^|]+?)(?: \\| |$)`),
  );
  return match?.[1]?.trim() || null;
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
      extractBlueBubblesDetailField(detail, 'last outbound target kind') || 'none',
    lastOutboundTarget:
      extractBlueBubblesDetailField(detail, 'last outbound target value') || 'none',
    lastSendErrorDetail:
      extractBlueBubblesDetailField(detail, 'last send error') || 'none',
    sendMethod:
      extractBlueBubblesDetailField(detail, 'send method') || 'private-api',
    privateApiAvailable:
      extractBlueBubblesDetailField(detail, 'private api available') || 'unknown',
    lastMetadataHydrationSource:
      extractBlueBubblesDetailField(detail, 'last metadata hydration') || 'none',
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
  research: FieldTrialSurfaceTruth;
  imageGeneration: FieldTrialSurfaceTruth;
  hostHealth: FieldTrialSurfaceTruth;
  journeys: FieldTrialJourneyTruthMap;
  pilotIssues: FieldTrialPilotIssueTruth;
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

interface PilotReviewSnapshotLike {
  loggingEnabled: boolean;
  recentEvents: PilotJourneyEventRecord[];
  openIssueCount: number;
  latestOpenIssue: { summaryText: string } | null;
}

function buildTruth(
  truth: Partial<FieldTrialSurfaceTruth> & Pick<FieldTrialSurfaceTruth, 'proofState'>,
): FieldTrialSurfaceTruth {
  return {
    blocker: '',
    blockerOwner: 'none',
    nextAction: '',
    detail: '',
    ...truth,
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

function formatBlockerClass(value: string | null | undefined, fallback: string): string {
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
  return getRecentJourneyEvent(review, (event) => event.journeyId === journeyId);
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
      detail: describeRecentJourney(params.label, params.event, 'degraded but usable'),
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
    windowsHost?.serviceState ||
    hostSnapshot.hostState?.phase ||
    'stopped';
  const dependencyState =
    windowsHost?.dependencyState || hostSnapshot.hostState?.dependencyState || 'unknown';
  const dependencyError =
    windowsHost?.dependencyError || hostSnapshot.hostState?.dependencyError || '';

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
      nextAction: 'Wait for the host to reach running_ready, then rerun services:status.',
      detail: 'The host is starting and not ready to claim a full pilot proof yet.',
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

  if (transport?.status === 'ready' && roundtrip.status === 'healthy') {
    return buildTruth({
      proofState: 'live_proven',
      detail: roundtrip.detail || 'Telegram transport and roundtrip proof are healthy on this host.',
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
    proofState: assistantHealth.status === 'healthy' ? 'near_live_only' : 'externally_blocked',
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
  const proofKind = pilotProofFallback ? 'handled_intent' : assessment.proofKind;
  const proofFreshness = pilotProofFallback ? 'fresh' : assessment.proofFreshness;
  const proofAgeMs = pilotProofFallback ? pilotProofFallback.proofAgeMs : assessment.proofAgeMs;
  const proofAgeMinutes = pilotProofFallback
    ? pilotProofFallback.proofAgeMinutes
    : assessment.proofAgeMinutes;
  const proofAgeLabel = pilotProofFallback
    ? pilotProofFallback.proofAgeLabel
    : formatAlexaProofAgeLabel(assessment.proofAgeMs);
  const detail =
    pilotProofFallback
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
            : 'Alexa listener, ingress, and account-link health can still be green even when no fresh handled signed live turn has been recorded on this host.';

  return {
    ...buildTruth({
      proofState,
      blocker: pilotProofFallback ? '' : assessment.blocker,
      blockerOwner:
        proofState === 'live_proven' ? 'none' : 'external',
      nextAction:
        pilotProofFallback
          ? ''
          : assessment.nextAction ||
        'Use a real device or authenticated Alexa Developer Console simulator, say `Open Andrea Assistant`, then `What am I forgetting?`, and run `npm run services:status`.',
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
  hostSnapshot: HostControlSnapshot,
  review: PilotReviewSnapshotLike,
): FieldTrialBlueBubblesTruth {
  const config = resolveBlueBubblesConfig();
  const snapshot = buildBlueBubblesHealthSnapshot(config);
  const bluebubblesChannel =
    hostSnapshot.assistantHealthState?.channels.find(
      (channel) => channel.name === 'bluebubbles',
    ) || null;
  const channelDetail =
    bluebubblesChannel?.detail || snapshot.detail || 'No BlueBubbles transport detail is available yet.';
  const webhookRegistration = deriveBlueBubblesWebhookRegistrationTruth(
    channelDetail,
  );
  const transportDiagnostics = deriveBlueBubblesTransportDiagnostics(channelDetail);
  const bluebubblesChats = getAllChats().filter((chat) => chat.jid.startsWith('bb:'));
  const recentEngagement = review.recentEvents.find(
    (event) =>
      event.channel === 'bluebubbles' &&
      event.chatJid?.startsWith('bb:') === true &&
      (event.outcome === 'success' || event.outcome === 'degraded_usable'),
  );
  const freshProofCutoff = Date.now() - 24 * 60 * 60 * 1000;
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
      const observedProofChatJid = resolveBlueBubblesMessageActionProofTarget(action);
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

  let lastInboundObservedAt = 'none';
  let lastOutboundResult = 'none';
  let lastOutboundObservedAt = 'none';
  let lastOutboundChatJid = 'none';
  let lastInboundChatJid = transportDiagnostics.lastInboundChatJid;
  let lastInboundWasSelfAuthored =
    transportDiagnostics.lastInboundWasSelfAuthored ?? false;
  for (const chat of bluebubblesChats) {
    const recentMessages = listRecentMessagesForChat(chat.jid, 12);
    const inbound = recentMessages.find(
      (message) => !message.is_bot_message,
    );
    const outbound = recentMessages.find((message) => message.is_bot_message);
    if (inbound && (lastInboundObservedAt === 'none' || inbound.timestamp > lastInboundObservedAt)) {
      lastInboundObservedAt = inbound.timestamp;
      lastInboundChatJid = chat.jid;
      lastInboundWasSelfAuthored = Boolean(inbound.is_from_me);
    }
    if (outbound && (lastOutboundResult === 'none' || outbound.timestamp > lastOutboundResult)) {
      lastOutboundResult = `${outbound.timestamp} (${chat.jid})`;
      lastOutboundObservedAt = outbound.timestamp;
      lastOutboundChatJid = chat.jid;
    }
  }

  const activeSelfThreadChat =
    pickMostRecentBlueBubblesChat([
      canonicalizeBlueBubblesProofCandidate({
        chatJid: recentEngagement?.chatJid || null,
        at: recentEngagement?.completedAt || recentEngagement?.startedAt || null,
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
        at: recentEngagement?.completedAt || recentEngagement?.startedAt || null,
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
  const blueBubblesSelfThreadAliasDetail =
    isBlueBubblesSelfThreadAliasJid(lastInboundChatJid) ||
    isBlueBubblesSelfThreadAliasJid(lastOutboundChatJid) ||
    isBlueBubblesSelfThreadAliasJid(recentEngagement?.chatJid)
      ? ` Canonical self-thread: ${BLUEBUBBLES_CANONICAL_SELF_THREAD_JID}. Alias support stays enabled for bb:iMessage;-;jeffstory007@gmail.com.`
      : '';

  const base: Omit<FieldTrialBlueBubblesTruth, keyof FieldTrialSurfaceTruth> = {
    configured: snapshot.configured,
    serverBaseUrl: config.baseUrl || 'none',
    listenerHost: config.host,
    listenerPort: config.port,
    publicWebhookUrl:
      config.enabled === true
        ? redactBlueBubblesWebhookUrl(buildBlueBubblesWebhookUrl(config))
        : 'none',
    webhookRegistrationState: webhookRegistration.state,
    webhookRegistrationDetail: webhookRegistration.detail,
    chatScope: config.chatScope,
    replyGateMode: 'mention_required',
    mostRecentEngagedChatJid: activeProofChat?.chatJid || recentEngagement?.chatJid || 'none',
    mostRecentEngagedAt:
      activeProofChat?.at ||
      recentEngagement?.completedAt ||
      recentEngagement?.startedAt ||
      'none',
    lastInboundObservedAt,
    lastInboundChatJid,
    lastInboundWasSelfAuthored,
    lastOutboundResult,
    lastOutboundTargetKind: transportDiagnostics.lastOutboundTargetKind,
    lastOutboundTarget: transportDiagnostics.lastOutboundTarget,
    lastSendErrorDetail:
      transportDiagnostics.lastSendErrorDetail !== 'none'
        ? transportDiagnostics.lastSendErrorDetail
        : bluebubblesChannel?.lastError || 'none',
    sendMethod: transportDiagnostics.sendMethod,
    privateApiAvailable: transportDiagnostics.privateApiAvailable,
    lastMetadataHydrationSource:
      transportDiagnostics.lastMetadataHydrationSource,
    attemptedTargetSequence: transportDiagnostics.attemptedTargetSequence,
    transportState: bluebubblesChannel?.state || snapshot.state,
    transportDetail: channelDetail,
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
      : draftLikeReplyWithoutAction && proofChainChatJid
        ? `Andrea drafted in ${draftLikeReplyMessage?.chat_jid || proofChainChatJid}, but no fresh message-action record was created yet.${blueBubblesSelfThreadAliasDetail}`
      : recentMessageActionProofs.length > 0
        ? `A recent BlueBubbles message-action decision exists in ${recentMessageActionProofs[0]!.proofChatJid}, but not in the same chat as the current proof chain.${blueBubblesSelfThreadAliasDetail}`
        : `No fresh BlueBubbles message-action decision is recorded yet.${blueBubblesSelfThreadAliasDetail}`,
  };

  if (
    !config.enabled &&
    !config.baseUrl &&
    !config.password &&
    config.allowedChatGuids.length === 0
  ) {
    return {
      ...buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles is not configured in Andrea on this host.',
      blockerOwner: 'external',
      nextAction:
        'Load the BLUEBUBBLES_* connection values on this Windows host, wire the Mac-side webhook to Andrea, and repro one real inbound -> reply -> follow-up flow.',
      detail:
        'Repo-side BlueBubbles harnesses can still pass here, but Andrea does not currently have a live BlueBubbles server/webhook configuration loaded on this PC.',
      }),
      ...base,
    };
  }

  if (!config.enabled) {
    return {
      ...buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles is disabled on this host.',
      blockerOwner: 'external',
      nextAction:
        'Enable BLUEBUBBLES_ENABLED and point this host at the reachable BlueBubbles server/webhook.',
      detail:
        'BlueBubbles code is present, but the channel is intentionally disabled on this machine.',
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
        'BlueBubbles is enabled but still missing the live server or chat-scope configuration.',
      blockerOwner: 'external',
      nextAction:
        config.chatScope === 'allowlist'
          ? 'Finish the BLUEBUBBLES_* connection values and set one or more allowed chat GUIDs for this host.'
          : 'Finish the BLUEBUBBLES_* connection values for this host.',
      detail:
        'The BlueBubbles channel is enabled in code, but this host is not yet configured for live scoped conversations.',
      }),
      ...base,
    };
  }

  if (!config.webhookPublicBaseUrl) {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker: 'BlueBubbles does not have a public webhook URL configured for this Windows host.',
        blockerOwner: 'external',
        nextAction:
          'Set BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL to the Mac-reachable Andrea listener URL, then update the Mac-side BlueBubbles webhook.',
        detail:
          'Andrea can listen locally, but the Mac-side BlueBubbles server needs a public webhook target that points back to this Windows host.',
      }),
      ...base,
    };
  }

  if (!config.sendEnabled) {
    return {
      ...buildTruth({
      proofState: 'externally_blocked',
      blocker: 'BlueBubbles outbound reply-back is still disabled on this host.',
      blockerOwner: 'external',
      nextAction:
        'Enable BLUEBUBBLES_SEND_ENABLED and repro one real inbound -> reply -> follow-up flow.',
      detail:
        'Inbound webhook handling is configured, but this host cannot yet prove a full live reply-back flow.',
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
        ? 'BlueBubbles received your @Andrea message, but reply-back failed in that same chat.'
        : 'BlueBubbles received a real inbound message, but reply-back failed in that same chat.';
      const nextAction = lastInboundWasSelfAuthored
        ? 'Retry the same `@Andrea` prompt in this self-chat after the direct-target fix lands. In parallel, you can still use a normal 1:1 or group thread as a second proof target.'
        : 'Retry the same `@Andrea` prompt in that chat and inspect the BlueBubbles direct-target diagnostics if reply-back still fails.';
      const detailPrefix = lastInboundChatJid !== 'none'
        ? `Recent inbound reached ${lastInboundChatJid}, but no Andrea reply was delivered back yet.`
        : 'A real BlueBubbles inbound reached Andrea, but no Andrea reply was delivered back yet.';
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
        base.sendMethod !== 'private-api' || base.privateApiAvailable !== 'unknown'
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
        ? 'BlueBubbles server auth failed from Andrea on this host.'
        : /secret/i.test(bluebubblesChannel.lastError)
          ? 'BlueBubbles webhook secret mismatch is blocking live proof.'
          : `BlueBubbles transport is degraded on this host: ${bluebubblesChannel.lastError}`;
    const nextAction =
      /secret/i.test(bluebubblesChannel.lastError)
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

  if (webhookRegistration.state === 'missing') {
    return {
      ...buildTruth({
        proofState: 'externally_blocked',
        blocker:
          'BlueBubbles transport is up, but the live server does not have Andrea’s webhook registered yet.',
        blockerOwner: 'external',
        nextAction:
        'Register Andrea’s public webhook on the BlueBubbles server, then send `@Andrea hi` from any synced chat.',
        detail:
          'Andrea is listening on this Windows host and the BlueBubbles server is reachable, but the Mac-side server still needs the matching webhook entry before real inbound traffic can reach Andrea.',
      }),
      ...base,
    };
  }

  if (
    liveProofChatJid &&
    matchingProofChainMessageAction &&
    lastInboundObservedAt !== 'none' &&
    lastOutboundResult !== 'none'
  ) {
    return {
      ...buildTruth({
        proofState: 'live_proven',
        detail:
          `BlueBubbles is live-proven on this host. Recent same-thread proof is anchored in ${liveProofChatJid}, including a fresh message-action decision in that same chat.`,
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
      activeProofChat?.chatJid || recentEngagement?.chatJid || 'that same BlueBubbles chat';
    return {
      ...buildTruth({
        proofState: 'degraded_but_usable',
        blocker:
          matchingProofChainMessageAction
            ? 'BlueBubbles has real traffic on this host, but the full same-thread follow-up proof chain is not fresh enough yet.'
            : 'BlueBubbles has real traffic on this host, but the same-thread message-action proof leg is still missing.',
        blockerOwner: 'repo_side',
        nextAction:
          matchingProofChainMessageAction
            ? 'Send one more same-thread BlueBubbles follow-up and confirm Andrea replies in that same conversation again.'
            : 'In that same BlueBubbles chat, ask what you should say back or send back, then use send it or send it later tonight so the message-action leg is proven too.',
        detail:
          matchingProofChainMessageAction
            ? `Real BlueBubbles traffic is flowing on this host through ${activeChatJid}, but the full follow-up proof bar still needs one fresh same-thread continuation.`
            : `Real BlueBubbles traffic is flowing on this host through ${activeChatJid}, but a fresh same-chat message-action decision is still missing. ${base.messageActionProofDetail}`,
      }),
      ...base,
    };
  }

  return {
    ...buildTruth({
      proofState: 'near_live_only',
      blocker:
        'A fresh real BlueBubbles inbound -> reply -> follow-up roundtrip has not been reproved on this host.',
      blockerOwner: 'external',
      nextAction:
        'Send `@Andrea hi`, then `@Andrea what am I forgetting`, then `@Andrea what should I say back` or `@Andrea what should I send back`, and finally `@Andrea send it` or `@Andrea send it later tonight` in that same BlueBubbles conversation.',
      detail:
        `BlueBubbles configuration is present, but this pass still needs a real same-host roundtrip before the surface can be called fully live-proven. ${base.messageActionProofDetail}`,
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
      detail: 'Outward research is currently usable and was validated on this host.',
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

function buildImageGenerationTruth(projectRoot: string): FieldTrialSurfaceTruth {
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
      nearLiveNextAction: 'Send `hi` or `what\'s up` in Telegram on this host.',
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
        'Run `what\'s still open with Candace`, `what should I say back`, and `save that for later` in Telegram on this host.',
    }),
    mission_planning: buildJourneyTruthFromEvent({
      label: 'Mission planning',
      event: getJourneyEventById(review, 'mission_planning'),
      nearLiveDetail:
        'Mission planning is ready, but it still needs one fresh same-host proof chain.',
      nearLiveNextAction:
        'Run `help me plan tonight`, `what\'s the next step`, and `what\'s blocking this` in Telegram on this host.',
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
  const hostSnapshot = options.hostSnapshot || readHostControlSnapshot(projectRoot);
  const windowsHost =
    options.windowsHost === undefined
      ? process.platform === 'win32'
        ? reconcileWindowsHostState({ projectRoot })
        : null
      : options.windowsHost;
  const review = buildPilotReviewSnapshot();

  const telegram = buildTelegramTruth(hostSnapshot, windowsHost);
  const alexa = buildAlexaTruth(projectRoot, review);
  const bluebubbles = buildBlueBubblesTruth(hostSnapshot, review);
  const googleCalendar = buildGoogleCalendarTruth(projectRoot);
  const research = buildResearchTruth(projectRoot, options.outwardResearchStatus);
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
      'Run `what\'s still open with Candace` or `what should I say back` on this host.',
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
      'Run `help me plan tonight`, `what\'s the next step`, and `what\'s blocking this` on this host.',
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
    research,
    imageGeneration,
    hostHealth,
    journeys,
    pilotIssues: {
      loggingEnabled: review.loggingEnabled,
      openCount: review.openIssueCount,
      latestSummary: review.latestOpenIssue?.summaryText || '',
    },
  };
}
