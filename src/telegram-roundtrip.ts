import { ASSISTANT_NAME } from './config.js';
import {
  DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS,
  readHostControlSnapshot,
  readTelegramRoundtripState,
  type TelegramRoundtripAssessment,
  type TelegramRoundtripSource,
  type TelegramRoundtripState,
  writeTelegramRoundtripState,
  assessTelegramRoundtripState,
} from './host-control.js';
import {
  buildAndreaPingPresenceReply,
  computeNextTelegramRoundtripDueAt,
  matchesAndreaPingPresenceReply,
} from './ping-presence.js';
import type { TelegramLiveReply } from './telegram-user-session.js';

export const TELEGRAM_PING_PROBE_MESSAGE = '/ping';

export interface TelegramRoundtripUpdateParams {
  source: TelegramRoundtripSource;
  status: TelegramRoundtripState['status'];
  detail: string;
  target?: string | null;
  expectedReply?: string | null;
  observedAt?: string;
  probeAt?: string | null;
  resetFailures?: boolean;
}

export interface TelegramPingProbeEvaluation {
  ok: boolean;
  detail: string;
  matchedReply: TelegramLiveReply | null;
}

function normalizeIsoTimestamp(value?: string | null): string {
  if (!value) return new Date().toISOString();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
}

function computeNextDueAt(
  lastSuccessAt: string | null,
  probeIntervalMs = DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS,
): string | null {
  if (!lastSuccessAt) return null;
  return (
    computeNextTelegramRoundtripDueAt(lastSuccessAt) ??
    (() => {
      const parsed = Date.parse(lastSuccessAt);
      if (!Number.isFinite(parsed)) return null;
      return new Date(parsed + probeIntervalMs).toISOString();
    })()
  );
}

export function buildExpectedTelegramPingReply(
  assistantName = ASSISTANT_NAME,
  reference?: Date | string | null,
): string {
  return buildAndreaPingPresenceReply(assistantName, reference);
}

export function evaluateTelegramPingReplies(
  replies: TelegramLiveReply[],
  assistantName = ASSISTANT_NAME,
): TelegramPingProbeEvaluation {
  const matchedReply =
    replies.find((reply) =>
      matchesAndreaPingPresenceReply(reply.text.trim(), assistantName),
    ) || null;
  if (matchedReply) {
    return {
      ok: true,
      detail: 'Received expected Telegram /ping reply.',
      matchedReply,
    };
  }
  if (replies.length === 0) {
    return {
      ok: false,
      detail: 'No Telegram reply arrived before the roundtrip timeout.',
      matchedReply: null,
    };
  }
  const unexpectedPreview = replies
    .map((reply) =>
      reply.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' / '),
    )
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
  return {
    ok: false,
    detail: unexpectedPreview
      ? `Telegram replied, but not with the expected /ping confirmation. Saw: ${unexpectedPreview}`
      : 'Telegram replied, but the response text was empty or unusable.',
    matchedReply: null,
  };
}

export function persistTelegramRoundtripState(
  params: TelegramRoundtripUpdateParams,
  projectRoot = process.cwd(),
): TelegramRoundtripState {
  const snapshot = readHostControlSnapshot(projectRoot);
  const previous = readTelegramRoundtripState(projectRoot);
  const observedAt = normalizeIsoTimestamp(params.observedAt);
  const lastSuccessAt =
    params.status === 'healthy' ? observedAt : previous?.lastSuccessAt || null;
  const lastProbeAt = params.probeAt
    ? normalizeIsoTimestamp(params.probeAt)
    : previous?.lastProbeAt || null;
  const consecutiveFailures =
    params.status === 'healthy' || params.resetFailures
      ? 0
      : params.status === 'failed'
        ? (previous?.consecutiveFailures || 0) + 1
        : previous?.consecutiveFailures || 0;

  const state: TelegramRoundtripState = {
    bootId: snapshot.hostState?.bootId || previous?.bootId || '',
    pid:
      snapshot.hostState?.pid ??
      snapshot.readyState?.pid ??
      previous?.pid ??
      null,
    status: params.status,
    source: params.source,
    detail: params.detail,
    chatTarget: params.target ?? previous?.chatTarget ?? null,
    expectedReply: params.expectedReply ?? previous?.expectedReply ?? null,
    updatedAt: observedAt,
    lastSuccessAt,
    lastProbeAt,
    nextDueAt: computeNextDueAt(lastSuccessAt),
    consecutiveFailures,
  };

  return writeTelegramRoundtripState(state, projectRoot);
}

export function recordOrganicTelegramRoundtripSuccess(
  params: {
    detail?: string;
    target?: string | null;
    observedAt?: string;
  },
  projectRoot = process.cwd(),
): TelegramRoundtripState {
  return persistTelegramRoundtripState(
    {
      source: 'organic',
      status: 'healthy',
      detail:
        params.detail ||
        'Observed a real Telegram request/response exchange in the operator chat.',
      target: params.target ?? null,
      expectedReply: buildExpectedTelegramPingReply(
        undefined,
        params.observedAt,
      ),
      observedAt: params.observedAt,
      resetFailures: true,
    },
    projectRoot,
  );
}

export function recordTelegramProbeSuccess(
  params: {
    source: Extract<TelegramRoundtripSource, 'scheduled_probe' | 'live_smoke'>;
    target?: string | null;
    observedAt?: string;
  },
  projectRoot = process.cwd(),
): TelegramRoundtripState {
  const observedAt = normalizeIsoTimestamp(params.observedAt);
  return persistTelegramRoundtripState(
    {
      source: params.source,
      status: 'healthy',
      detail:
        'Telegram roundtrip probe succeeded with the expected /ping reply.',
      target: params.target ?? null,
      expectedReply: buildExpectedTelegramPingReply(undefined, observedAt),
      observedAt,
      probeAt: observedAt,
      resetFailures: true,
    },
    projectRoot,
  );
}

export function recordTelegramProbeFailure(
  params: {
    source: Extract<TelegramRoundtripSource, 'scheduled_probe' | 'live_smoke'>;
    detail: string;
    target?: string | null;
    observedAt?: string;
  },
  projectRoot = process.cwd(),
): TelegramRoundtripState {
  const observedAt = normalizeIsoTimestamp(params.observedAt);
  return persistTelegramRoundtripState(
    {
      source: params.source,
      status: 'failed',
      detail: params.detail,
      target: params.target ?? null,
      expectedReply: buildExpectedTelegramPingReply(undefined, observedAt),
      observedAt,
      probeAt: observedAt,
    },
    projectRoot,
  );
}

export function recordTelegramProbeUnconfigured(
  detail: string,
  projectRoot = process.cwd(),
  options: {
    source?: TelegramRoundtripSource;
    target?: string | null;
    observedAt?: string;
  } = {},
): TelegramRoundtripState {
  const observedAt = normalizeIsoTimestamp(options.observedAt);
  return persistTelegramRoundtripState(
    {
      source: options.source ?? 'startup',
      status: 'unconfigured',
      detail,
      target: options.target ?? null,
      expectedReply: buildExpectedTelegramPingReply(undefined, observedAt),
      observedAt,
      probeAt: observedAt,
      resetFailures: true,
    },
    projectRoot,
  );
}

export function getTelegramRoundtripAssessment(
  projectRoot = process.cwd(),
): TelegramRoundtripAssessment {
  const snapshot = readHostControlSnapshot(projectRoot);
  return assessTelegramRoundtripState({
    assistantHealthState: snapshot.assistantHealthState,
    telegramRoundtripState: snapshot.telegramRoundtripState,
    telegramTransportState: snapshot.telegramTransportState,
    hostState: snapshot.hostState,
    readyState: snapshot.readyState,
  });
}
