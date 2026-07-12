import fs from 'node:fs';
import path from 'node:path';

import { writeJsonFileAtomic } from './atomic-json-file.js';
import type {
  ProviderFailureClass,
  ProviderHealthSnapshot,
  ProviderHealthState,
} from './provider-health.js';

export const PROVIDER_LIVE_HEALTH_MAX_AGE_MS = 30 * 60 * 1_000;

type CachedLiveProbeState = Extract<
  ProviderHealthState,
  'healthy' | 'degraded' | 'externally_blocked'
>;

export interface ProviderLiveHealthCacheEntry {
  providerId: string;
  checkedAt: string;
  state: CachedLiveProbeState;
  failureClass: ProviderFailureClass;
  quotaState: ProviderHealthSnapshot['quotaState'];
  lastHealthyAt: string | null;
  liveProbe: 'ok' | 'failed';
  liveModel: string;
  nextAction: string;
}

export interface ProviderLiveHealthState {
  version: 1;
  updatedAt: string;
  providers: ProviderLiveHealthCacheEntry[];
}

function statePath(projectRoot: string): string {
  return path.join(
    projectRoot,
    'data',
    'runtime',
    'provider-live-health-state.json',
  );
}

function safeText(value: unknown, limit = 320): string {
  return String(value || '')
    .replace(
      /\b(?:sk-|AIza|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/gi,
      '[redacted-secret]',
    )
    .replace(
      /\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
      (_match, key: string) => `${key}=***`,
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function validIso(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

function normalizeEntry(value: unknown): ProviderLiveHealthCacheEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const checkedAt = validIso(record.checkedAt);
  const providerId = safeText(record.providerId, 80);
  const state = record.state;
  const failureClass = record.failureClass;
  const quotaState = record.quotaState;
  const liveProbe = record.liveProbe;
  if (
    !providerId ||
    !checkedAt ||
    !['healthy', 'degraded', 'externally_blocked'].includes(String(state)) ||
    ![
      'none',
      'missing_credentials',
      'auth_failure',
      'quota_or_rate_limit',
      'transport_error',
      'manual_external',
      'unknown',
    ].includes(String(failureClass)) ||
    !['ok', 'blocked', 'unknown'].includes(String(quotaState)) ||
    !['ok', 'failed'].includes(String(liveProbe))
  ) {
    return null;
  }
  return {
    providerId,
    checkedAt,
    state: state as CachedLiveProbeState,
    failureClass: failureClass as ProviderFailureClass,
    quotaState: quotaState as ProviderHealthSnapshot['quotaState'],
    lastHealthyAt: validIso(record.lastHealthyAt),
    liveProbe: liveProbe as ProviderLiveHealthCacheEntry['liveProbe'],
    liveModel: safeText(record.liveModel, 120),
    nextAction: safeText(record.nextAction),
  };
}

export function readProviderLiveHealthState(
  projectRoot = process.cwd(),
): ProviderLiveHealthState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(statePath(projectRoot), 'utf8'),
    ) as Record<string, unknown>;
    const updatedAt = validIso(parsed.updatedAt);
    const providers = Array.isArray(parsed.providers)
      ? parsed.providers.map(normalizeEntry).filter(Boolean)
      : [];
    if (!updatedAt || providers.length === 0) return null;
    return {
      version: 1,
      updatedAt,
      providers: providers as ProviderLiveHealthCacheEntry[],
    };
  } catch {
    return null;
  }
}

export function writeProviderLiveHealthState(
  snapshots: ProviderHealthSnapshot[],
  checkedAt: string,
  projectRoot = process.cwd(),
): ProviderLiveHealthState | null {
  const normalizedCheckedAt = validIso(checkedAt);
  if (!normalizedCheckedAt) return null;
  const providers = snapshots
    .filter(
      (snapshot) =>
        snapshot.credentialState === 'configured' &&
        snapshot.metadata.healthEvidence === 'live_probe' &&
        (snapshot.metadata.liveProbe === 'ok' ||
          snapshot.metadata.liveProbe === 'failed') &&
        ['healthy', 'degraded', 'externally_blocked'].includes(snapshot.state),
    )
    .map(
      (snapshot): ProviderLiveHealthCacheEntry => ({
        providerId: safeText(snapshot.providerId, 80),
        checkedAt: normalizedCheckedAt,
        state: snapshot.state as CachedLiveProbeState,
        failureClass: snapshot.failureClass,
        quotaState: snapshot.quotaState,
        lastHealthyAt: validIso(snapshot.lastHealthyAt),
        liveProbe: snapshot.metadata.liveProbe as 'ok' | 'failed',
        liveModel: safeText(snapshot.metadata.liveModel, 120),
        nextAction: safeText(snapshot.nextAction),
      }),
    );
  if (providers.length === 0) return null;
  const state: ProviderLiveHealthState = {
    version: 1,
    updatedAt: normalizedCheckedAt,
    providers,
  };
  writeJsonFileAtomic(statePath(projectRoot), state);
  return state;
}

export function applyRecentProviderLiveHealth(
  snapshots: ProviderHealthSnapshot[],
  checkedAt: string,
  options: {
    projectRoot?: string;
    maxAgeMs?: number;
  } = {},
): ProviderHealthSnapshot[] {
  const referenceMs = Date.parse(checkedAt);
  const state = readProviderLiveHealthState(options.projectRoot);
  if (!state || !Number.isFinite(referenceMs)) return snapshots;
  const maxAgeMs = Math.max(
    1,
    options.maxAgeMs || PROVIDER_LIVE_HEALTH_MAX_AGE_MS,
  );
  const byProvider = new Map(
    state.providers
      .filter((entry) => {
        const ageMs = referenceMs - Date.parse(entry.checkedAt);
        return ageMs >= 0 && ageMs <= maxAgeMs;
      })
      .map((entry) => [entry.providerId, entry]),
  );
  return snapshots.map((snapshot) => {
    const cached = byProvider.get(snapshot.providerId);
    if (
      !cached ||
      snapshot.credentialState !== 'configured' ||
      snapshot.state === 'externally_blocked'
    ) {
      return snapshot;
    }
    return {
      ...snapshot,
      state: cached.state,
      lastHealthyAt: cached.lastHealthyAt,
      lastCheckedAt: cached.checkedAt,
      failureClass: cached.failureClass,
      quotaState: cached.quotaState,
      blocker:
        cached.liveProbe === 'failed'
          ? `Recent live probe failed with ${cached.failureClass}.`
          : '',
      nextAction: cached.nextAction,
      metadata: {
        ...snapshot.metadata,
        healthEvidence: 'cached_live_probe',
        liveProbe: cached.liveProbe,
        liveCheckedAt: cached.checkedAt,
        liveModel: cached.liveModel,
        liveFreshUntil: new Date(
          Date.parse(cached.checkedAt) + maxAgeMs,
        ).toISOString(),
      },
    };
  });
}
