import fs from 'fs';

import { resolveHostControlPaths } from './host-control.js';

export type BlueBubblesDetectionState =
  | 'healthy'
  | 'transport_unreachable'
  | 'reply_delivery_broken'
  | 'suspected_missed_inbound'
  | 'ignored_by_gate_or_scope'
  | 'mixed_degraded';

export type BlueBubblesFallbackState = 'idle' | 'armed' | 'sent' | 'cooldown';

export type BlueBubblesIgnoredReason = 'mention_required' | 'chat_scope';

export type BlueBubblesEvidenceKind =
  | 'missed_inbound'
  | 'transport_unreachable'
  | 'shadow_poll_unstable'
  | 'reply_delivery_failed';

export interface BlueBubblesMonitorEvidence {
  kind: BlueBubblesEvidenceKind;
  chatJid: string;
  signature: string;
  observedAt: string;
}

export interface BlueBubblesMonitorState {
  updatedAt: string;
  detectionState: BlueBubblesDetectionState;
  detectionDetail: string | null;
  detectionNextAction: string | null;
  lastInboundObservedAt: string | null;
  lastInboundChatJid: string | null;
  lastInboundWasSelfAuthored: boolean | null;
  lastOutboundObservedAt: string | null;
  lastOutboundObservedChatJid: string | null;
  lastOutboundTargetKind: string | null;
  lastOutboundTargetValue: string | null;
  lastSendErrorDetail: string | null;
  lastMetadataHydrationSource: string | null;
  lastAttemptedTargetSequence: string[];
  shadowPollLastOkAt: string | null;
  shadowPollLastError: string | null;
  shadowPollMostRecentChat: string | null;
  activeBaseUrl: string | null;
  candidateProbeResults: Record<string, string>;
  mostRecentServerSeenAt: string | null;
  mostRecentServerSeenChatJid: string | null;
  mostRecentServerSeenMessageId: string | null;
  mostRecentWebhookObservedAt: string | null;
  mostRecentWebhookObservedChatJid: string | null;
  lastIgnoredAt: string | null;
  lastIgnoredChatJid: string | null;
  lastIgnoredReason: BlueBubblesIgnoredReason | null;
  lastReplySendFailureAt: string | null;
  lastReplySendFailureChatJid: string | null;
  lastReplySendFailureStage: string | null;
  crossSurfaceFallbackState: BlueBubblesFallbackState;
  crossSurfaceFallbackLastSentAt: string | null;
  crossSurfaceFallbackLastDetail: string | null;
  recentEvidence: BlueBubblesMonitorEvidence[];
  perChatServerSeen: Record<string, string>;
  perChatWebhookObserved: Record<string, string>;
}

function getMonitorStatePath(projectRoot = process.cwd()): string {
  return `${resolveHostControlPaths(projectRoot).runtimeStateDir}\\bluebubbles-monitor-state.json`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeEvidence(
  value: unknown,
): BlueBubblesMonitorEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<BlueBubblesMonitorEvidence>;
  const kind =
    input.kind === 'missed_inbound' ||
    input.kind === 'reply_delivery_failed' ||
    input.kind === 'shadow_poll_unstable' ||
    input.kind === 'transport_unreachable'
      ? input.kind
      : null;
  if (
    !kind ||
    !isNonEmptyString(input.chatJid) ||
    !isNonEmptyString(input.signature) ||
    !isNonEmptyString(input.observedAt)
  ) {
    return null;
  }
  return {
    kind,
    chatJid: input.chatJid,
    signature: input.signature,
    observedAt: input.observedAt,
  };
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key, entry]) => isNonEmptyString(key) && isNonEmptyString(entry),
    ),
  ) as Record<string, string>;
}

export function createDefaultBlueBubblesMonitorState(
  nowIso = new Date().toISOString(),
): BlueBubblesMonitorState {
  return {
    updatedAt: nowIso,
    detectionState: 'healthy',
    detectionDetail: null,
    detectionNextAction: null,
    lastInboundObservedAt: null,
    lastInboundChatJid: null,
    lastInboundWasSelfAuthored: null,
    lastOutboundObservedAt: null,
    lastOutboundObservedChatJid: null,
    lastOutboundTargetKind: null,
    lastOutboundTargetValue: null,
    lastSendErrorDetail: null,
    lastMetadataHydrationSource: null,
    lastAttemptedTargetSequence: [],
    shadowPollLastOkAt: null,
    shadowPollLastError: null,
    shadowPollMostRecentChat: null,
    activeBaseUrl: null,
    candidateProbeResults: {},
    mostRecentServerSeenAt: null,
    mostRecentServerSeenChatJid: null,
    mostRecentServerSeenMessageId: null,
    mostRecentWebhookObservedAt: null,
    mostRecentWebhookObservedChatJid: null,
    lastIgnoredAt: null,
    lastIgnoredChatJid: null,
    lastIgnoredReason: null,
    lastReplySendFailureAt: null,
    lastReplySendFailureChatJid: null,
    lastReplySendFailureStage: null,
    crossSurfaceFallbackState: 'idle',
    crossSurfaceFallbackLastSentAt: null,
    crossSurfaceFallbackLastDetail: null,
    recentEvidence: [],
    perChatServerSeen: {},
    perChatWebhookObserved: {},
  };
}

function normalizeState(value: unknown): BlueBubblesMonitorState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<BlueBubblesMonitorState> & {
    recentEvidence?: unknown[];
  };
  const detectionState: BlueBubblesDetectionState =
    input.detectionState === 'transport_unreachable' ||
    input.detectionState === 'reply_delivery_broken' ||
    input.detectionState === 'suspected_missed_inbound' ||
    input.detectionState === 'ignored_by_gate_or_scope' ||
    input.detectionState === 'mixed_degraded'
      ? input.detectionState
      : 'healthy';
  const fallbackState: BlueBubblesFallbackState =
    input.crossSurfaceFallbackState === 'armed' ||
    input.crossSurfaceFallbackState === 'sent' ||
    input.crossSurfaceFallbackState === 'cooldown'
      ? input.crossSurfaceFallbackState
      : 'idle';
  return {
    ...createDefaultBlueBubblesMonitorState(
      isNonEmptyString(input.updatedAt) ? input.updatedAt : new Date().toISOString(),
    ),
    updatedAt: isNonEmptyString(input.updatedAt)
      ? input.updatedAt
      : new Date().toISOString(),
    detectionState,
    detectionDetail: isNonEmptyString(input.detectionDetail)
      ? input.detectionDetail
      : null,
    detectionNextAction: isNonEmptyString(input.detectionNextAction)
      ? input.detectionNextAction
      : null,
    lastInboundObservedAt: isNonEmptyString(input.lastInboundObservedAt)
      ? input.lastInboundObservedAt
      : null,
    lastInboundChatJid: isNonEmptyString(input.lastInboundChatJid)
      ? input.lastInboundChatJid
      : null,
    lastInboundWasSelfAuthored:
      typeof input.lastInboundWasSelfAuthored === 'boolean'
        ? input.lastInboundWasSelfAuthored
        : null,
    lastOutboundObservedAt: isNonEmptyString(input.lastOutboundObservedAt)
      ? input.lastOutboundObservedAt
      : null,
    lastOutboundObservedChatJid: isNonEmptyString(input.lastOutboundObservedChatJid)
      ? input.lastOutboundObservedChatJid
      : null,
    lastOutboundTargetKind: isNonEmptyString(input.lastOutboundTargetKind)
      ? input.lastOutboundTargetKind
      : null,
    lastOutboundTargetValue: isNonEmptyString(input.lastOutboundTargetValue)
      ? input.lastOutboundTargetValue
      : null,
    lastSendErrorDetail: isNonEmptyString(input.lastSendErrorDetail)
      ? input.lastSendErrorDetail
      : null,
    lastMetadataHydrationSource: isNonEmptyString(input.lastMetadataHydrationSource)
      ? input.lastMetadataHydrationSource
      : null,
    lastAttemptedTargetSequence: Array.isArray(input.lastAttemptedTargetSequence)
      ? input.lastAttemptedTargetSequence.filter(
          (entry): entry is string => isNonEmptyString(entry),
        )
      : [],
    shadowPollLastOkAt: isNonEmptyString(input.shadowPollLastOkAt)
      ? input.shadowPollLastOkAt
      : null,
    shadowPollLastError: isNonEmptyString(input.shadowPollLastError)
      ? input.shadowPollLastError
      : null,
    shadowPollMostRecentChat: isNonEmptyString(input.shadowPollMostRecentChat)
      ? input.shadowPollMostRecentChat
      : null,
    activeBaseUrl: isNonEmptyString(input.activeBaseUrl)
      ? input.activeBaseUrl
      : null,
    candidateProbeResults: normalizeStringMap(input.candidateProbeResults),
    mostRecentServerSeenAt: isNonEmptyString(input.mostRecentServerSeenAt)
      ? input.mostRecentServerSeenAt
      : null,
    mostRecentServerSeenChatJid: isNonEmptyString(input.mostRecentServerSeenChatJid)
      ? input.mostRecentServerSeenChatJid
      : null,
    mostRecentServerSeenMessageId: isNonEmptyString(input.mostRecentServerSeenMessageId)
      ? input.mostRecentServerSeenMessageId
      : null,
    mostRecentWebhookObservedAt: isNonEmptyString(input.mostRecentWebhookObservedAt)
      ? input.mostRecentWebhookObservedAt
      : null,
    mostRecentWebhookObservedChatJid: isNonEmptyString(
      input.mostRecentWebhookObservedChatJid,
    )
      ? input.mostRecentWebhookObservedChatJid
      : null,
    lastIgnoredAt: isNonEmptyString(input.lastIgnoredAt) ? input.lastIgnoredAt : null,
    lastIgnoredChatJid: isNonEmptyString(input.lastIgnoredChatJid)
      ? input.lastIgnoredChatJid
      : null,
    lastIgnoredReason:
      input.lastIgnoredReason === 'mention_required' ||
      input.lastIgnoredReason === 'chat_scope'
        ? input.lastIgnoredReason
        : null,
    lastReplySendFailureAt: isNonEmptyString(input.lastReplySendFailureAt)
      ? input.lastReplySendFailureAt
      : null,
    lastReplySendFailureChatJid: isNonEmptyString(input.lastReplySendFailureChatJid)
      ? input.lastReplySendFailureChatJid
      : null,
    lastReplySendFailureStage: isNonEmptyString(input.lastReplySendFailureStage)
      ? input.lastReplySendFailureStage
      : null,
    crossSurfaceFallbackState: fallbackState,
    crossSurfaceFallbackLastSentAt: isNonEmptyString(
      input.crossSurfaceFallbackLastSentAt,
    )
      ? input.crossSurfaceFallbackLastSentAt
      : null,
    crossSurfaceFallbackLastDetail: isNonEmptyString(
      input.crossSurfaceFallbackLastDetail,
    )
      ? input.crossSurfaceFallbackLastDetail
      : null,
    recentEvidence: Array.isArray(input.recentEvidence)
      ? input.recentEvidence
          .map((entry) => normalizeEvidence(entry))
          .filter((entry): entry is BlueBubblesMonitorEvidence => entry != null)
      : [],
    perChatServerSeen: normalizeStringMap(input.perChatServerSeen),
    perChatWebhookObserved: normalizeStringMap(input.perChatWebhookObserved),
  };
}

export function readBlueBubblesMonitorState(
  projectRoot = process.cwd(),
): BlueBubblesMonitorState {
  const statePath = getMonitorStatePath(projectRoot);
  if (!fs.existsSync(statePath)) {
    return createDefaultBlueBubblesMonitorState();
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '');
    return normalizeState(JSON.parse(raw)) || createDefaultBlueBubblesMonitorState();
  } catch {
    return createDefaultBlueBubblesMonitorState();
  }
}

export function writeBlueBubblesMonitorState(
  state: BlueBubblesMonitorState,
  projectRoot = process.cwd(),
): BlueBubblesMonitorState {
  const statePath = getMonitorStatePath(projectRoot);
  const next = {
    ...createDefaultBlueBubblesMonitorState(state.updatedAt || new Date().toISOString()),
    ...state,
  };
  fs.mkdirSync(resolveHostControlPaths(projectRoot).runtimeStateDir, {
    recursive: true,
  });
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function clearBlueBubblesMonitorState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getMonitorStatePath(projectRoot), { force: true });
  } catch {
    // best effort
  }
}
