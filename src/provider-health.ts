import {
  describeBraveConfigBlocker,
  getBraveSearchStatus,
} from './brave-search.js';
import {
  describeMiniMaxConfigBlocker,
  getMiniMaxProviderStatus,
} from './minimax-provider.js';
import {
  describeGeminiConfigBlocker,
  getGeminiProviderStatus,
} from './gemini-provider.js';
import {
  describeOpenAiConfigBlocker,
  getOpenAiProviderStatus,
} from './openai-provider.js';
import { readEnvFile } from './env.js';

export type ProviderHealthState =
  | 'healthy'
  | 'degraded'
  | 'externally_blocked'
  | 'not_configured'
  | 'unknown';

export type ProviderFailureClass =
  | 'none'
  | 'missing_credentials'
  | 'auth_failure'
  | 'quota_or_rate_limit'
  | 'transport_error'
  | 'manual_external'
  | 'unknown';

export interface ProviderHealthSnapshot {
  providerId: string;
  kind: 'llm' | 'search' | 'transport' | 'integration';
  state: ProviderHealthState;
  lastHealthyAt: string | null;
  lastCheckedAt: string;
  failureClass: ProviderFailureClass;
  quotaState: 'ok' | 'blocked' | 'unknown';
  credentialState: 'configured' | 'missing' | 'invalid' | 'unknown';
  knownExpiresAt: string | null;
  rotationDueAt: string | null;
  blocker: string;
  nextAction: string;
  metadata: Record<string, string>;
}

export interface CredentialHealthSnapshot {
  providerId: string;
  credentialState: ProviderHealthSnapshot['credentialState'];
  lastCheckedAt: string;
  lastHealthyAt: string | null;
  knownExpiresAt: string | null;
  rotationDueAt: string | null;
  failureClass: ProviderFailureClass;
  nextAction: string;
}

export interface AlertEventSnapshot {
  alertId: string;
  providerId: string;
  severity: 'info' | 'warning' | 'critical';
  transition: 'down' | 'recovered' | 'degraded' | 'rotation_due';
  summary: string;
  nextAction: string;
  channelsAttempted: string[];
  dedupeKey: string;
  cooldownUntil: string;
  ackState: 'unacked' | 'acked';
}

export interface SystemAlertConfig {
  enabled: boolean;
  channels: Array<'telegram' | 'bluebubbles'>;
  cooldownMinutes: number;
  credentialLookaheadDays: number;
  providerHealthIntervalMinutes: number;
}

const alertEnvConfig = readEnvFile([
  'SYSTEM_ALERTS_ENABLED',
  'SYSTEM_ALERT_CHANNELS',
  'SYSTEM_ALERT_COOLDOWN_MINUTES',
  'CREDENTIAL_ALERT_LOOKAHEAD_DAYS',
  'PROVIDER_HEALTH_INTERVAL_MINUTES',
]);

function readAlertConfigValue(
  key: keyof typeof alertEnvConfig | string,
): string {
  return process.env[key] || alertEnvConfig[key] || '';
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSystemAlertConfig(): SystemAlertConfig {
  const enabledValue = readAlertConfigValue('SYSTEM_ALERTS_ENABLED');
  const channelsValue =
    readAlertConfigValue('SYSTEM_ALERT_CHANNELS') || 'telegram,bluebubbles';
  const channels = channelsValue
    .split(',')
    .map((channel) => channel.trim().toLowerCase())
    .filter(
      (channel): channel is 'telegram' | 'bluebubbles' =>
        channel === 'telegram' || channel === 'bluebubbles',
    );
  return {
    enabled: enabledValue === '' ? true : enabledValue !== 'false',
    channels: channels.length > 0 ? channels : ['telegram'],
    cooldownMinutes: parsePositiveInteger(
      readAlertConfigValue('SYSTEM_ALERT_COOLDOWN_MINUTES'),
      60,
    ),
    credentialLookaheadDays: parsePositiveInteger(
      readAlertConfigValue('CREDENTIAL_ALERT_LOOKAHEAD_DAYS'),
      14,
    ),
    providerHealthIntervalMinutes: parsePositiveInteger(
      readAlertConfigValue('PROVIDER_HEALTH_INTERVAL_MINUTES'),
      30,
    ),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function rotationDueAt(days = 90): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

export function collectProviderHealthSnapshots(
  checkedAt = nowIso(),
): ProviderHealthSnapshot[] {
  const openAi = getOpenAiProviderStatus();
  const miniMax = getMiniMaxProviderStatus();
  const gemini = getGeminiProviderStatus();
  const brave = getBraveSearchStatus();
  const miniMaxQuotaBlocked =
    miniMax.configured && miniMax.quotaState === 'blocked';
  const geminiQuotaBlocked =
    gemini.configured && gemini.quotaState === 'blocked';
  return [
    {
      providerId: 'openai_cloud',
      kind: 'llm',
      state: openAi.configured ? 'healthy' : 'not_configured',
      lastHealthyAt: openAi.configured ? checkedAt : null,
      lastCheckedAt: checkedAt,
      failureClass: openAi.configured ? 'none' : 'missing_credentials',
      quotaState: 'unknown',
      credentialState: openAi.configured ? 'configured' : 'missing',
      knownExpiresAt: null,
      rotationDueAt: rotationDueAt(),
      blocker: openAi.configured
        ? ''
        : describeOpenAiConfigBlocker(openAi.missing),
      nextAction: openAi.configured
        ? ''
        : 'Set a valid OpenAI API key in local environment config, then rerun provider checks.',
      metadata: {
        baseUrl: openAi.baseUrl,
        fallbackModel: openAi.researchModel,
      },
    },
    {
      providerId: 'minimax_cloud',
      kind: 'llm',
      state: miniMaxQuotaBlocked
        ? 'externally_blocked'
        : miniMax.configured
          ? 'healthy'
          : miniMax.enabled
            ? 'degraded'
            : 'not_configured',
      lastHealthyAt:
        miniMax.configured && !miniMaxQuotaBlocked ? checkedAt : null,
      lastCheckedAt: checkedAt,
      failureClass: miniMaxQuotaBlocked
        ? 'quota_or_rate_limit'
        : miniMax.configured
          ? 'none'
          : 'missing_credentials',
      quotaState: miniMaxQuotaBlocked ? 'blocked' : 'unknown',
      credentialState: miniMax.configured ? 'configured' : 'missing',
      knownExpiresAt: null,
      rotationDueAt: rotationDueAt(),
      blocker: miniMaxQuotaBlocked
        ? 'MiniMax account balance or quota is blocked.'
        : miniMax.configured
          ? ''
          : describeMiniMaxConfigBlocker(miniMax.missing),
      nextAction: miniMaxQuotaBlocked
        ? 'Add MiniMax balance or wait for quota/rate-limit recovery, then clear MINIMAX_QUOTA_STATE and rerun provider checks.'
        : miniMax.configured
          ? ''
          : 'Set MINIMAX_API_KEY in local environment config, then rerun provider checks.',
      metadata: {
        anthropicBaseUrl: miniMax.anthropicBaseUrl,
        openAiBaseUrl: miniMax.openAiBaseUrl,
        complexModel: miniMax.complexModel,
        fastModel: miniMax.fastModel,
      },
    },
    {
      providerId: 'gemini_cloud',
      kind: 'llm',
      state: geminiQuotaBlocked
        ? 'externally_blocked'
        : gemini.configured
          ? 'healthy'
          : gemini.enabled
            ? 'degraded'
            : 'not_configured',
      lastHealthyAt:
        gemini.configured && !geminiQuotaBlocked ? checkedAt : null,
      lastCheckedAt: checkedAt,
      failureClass: geminiQuotaBlocked
        ? 'quota_or_rate_limit'
        : gemini.configured
          ? 'none'
          : 'missing_credentials',
      quotaState: geminiQuotaBlocked ? 'blocked' : 'unknown',
      credentialState: gemini.configured ? 'configured' : 'missing',
      knownExpiresAt: null,
      rotationDueAt: rotationDueAt(),
      blocker: geminiQuotaBlocked
        ? 'Gemini account quota or rate limit is blocked.'
        : gemini.configured
          ? ''
          : describeGeminiConfigBlocker(gemini.missing),
      nextAction: geminiQuotaBlocked
        ? 'Wait for Gemini quota/rate-limit recovery or adjust the Gemini plan, then clear GEMINI_QUOTA_STATE and rerun provider checks.'
        : gemini.configured
          ? ''
          : 'Set GEMINI_API_KEY in local environment config, then rerun provider checks.',
      metadata: {
        openAiBaseUrl: gemini.openAiBaseUrl,
        criticModel: gemini.criticModel,
        fastModel: gemini.fastModel,
        role: 'critic_verifier',
      },
    },
    {
      providerId: 'brave_search',
      kind: 'search',
      state: brave.configured ? 'healthy' : 'not_configured',
      lastHealthyAt: brave.configured ? checkedAt : null,
      lastCheckedAt: checkedAt,
      failureClass: brave.configured ? 'none' : 'missing_credentials',
      quotaState: 'unknown',
      credentialState: brave.configured ? 'configured' : 'missing',
      knownExpiresAt: null,
      rotationDueAt: rotationDueAt(),
      blocker: brave.configured
        ? ''
        : describeBraveConfigBlocker(brave.missing),
      nextAction: brave.configured
        ? ''
        : 'Set BRAVE_SEARCH_API_KEY or BRACE_SEARCH_API_KEY in local environment config, then rerun provider checks.',
      metadata: {
        baseUrl: brave.baseUrl,
        count: String(brave.count),
        aliasUsed: brave.aliasUsed || '',
      },
    },
  ];
}

export function collectCredentialHealthSnapshots(
  checkedAt = nowIso(),
): CredentialHealthSnapshot[] {
  return collectProviderHealthSnapshots(checkedAt).map((provider) => ({
    providerId: provider.providerId,
    credentialState: provider.credentialState,
    lastCheckedAt: provider.lastCheckedAt,
    lastHealthyAt: provider.lastHealthyAt,
    knownExpiresAt: provider.knownExpiresAt,
    rotationDueAt: provider.rotationDueAt,
    failureClass: provider.failureClass,
    nextAction:
      provider.credentialState === 'configured'
        ? 'Expiry unknown for static API key; health probes and rotation-age reminders are active.'
        : provider.nextAction,
  }));
}

export function buildProviderAlertEvents(
  providers = collectProviderHealthSnapshots(),
  checkedAt = nowIso(),
): AlertEventSnapshot[] {
  const cooldown = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return providers
    .filter((provider) => provider.state !== 'healthy')
    .map((provider) => ({
      alertId: `alert-${provider.providerId}-${provider.failureClass}-${checkedAt}`,
      providerId: provider.providerId,
      severity:
        provider.state === 'externally_blocked' || provider.state === 'degraded'
          ? 'warning'
          : 'info',
      transition:
        provider.state === 'degraded' || provider.state === 'externally_blocked'
          ? 'degraded'
          : 'down',
      summary: provider.blocker || `${provider.providerId} is not healthy.`,
      nextAction: provider.nextAction,
      channelsAttempted: ['telegram', 'bluebubbles'],
      dedupeKey: `${provider.providerId}:${provider.failureClass}`,
      cooldownUntil: cooldown,
      ackState: 'unacked',
    }));
}

export function formatProviderHealthAlertMessage(params: {
  provider: ProviderHealthSnapshot;
  transition: 'down' | 'degraded' | 'recovered';
  severity: AlertEventSnapshot['severity'];
}): string {
  const { provider, transition, severity } = params;
  const symptom =
    transition === 'recovered'
      ? `${provider.providerId} recovered and is reporting healthy again.`
      : provider.blocker || `${provider.providerId} is not healthy.`;
  const likelyCause =
    provider.failureClass === 'none'
      ? 'Health probe recovered.'
      : provider.failureClass.replace(/_/g, ' ');
  const nextAction =
    transition === 'recovered'
      ? 'No action needed. Andrea will keep monitoring.'
      : provider.nextAction ||
        'Review provider health and rerun debug:providers.';
  const owner =
    provider.failureClass === 'missing_credentials' ||
    provider.failureClass === 'manual_external' ||
    provider.failureClass === 'quota_or_rate_limit'
      ? 'external/manual'
      : 'repo-or-host';
  return [
    'Andrea system alert',
    `System: ${provider.providerId}`,
    `Severity: ${severity}`,
    `Transition: ${transition}`,
    `Symptom: ${symptom}`,
    `Likely cause: ${likelyCause}`,
    `Next action: ${nextAction}`,
    `Class: ${owner}`,
  ].join('\n');
}
