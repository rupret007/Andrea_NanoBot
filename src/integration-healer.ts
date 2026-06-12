import crypto from 'crypto';

import {
  isDatabaseInitialized,
  listRepairAttempts,
  listRepairCooldowns,
  upsertReliabilityObservation,
  upsertRepairAttempt,
  upsertRepairCooldown,
} from './db.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import { reviewAgentAction } from './critic-agent.js';
import { refreshToolReliabilityFromCurrentTruth } from './tool-reliability.js';
import type {
  RepairAttemptRecord,
  RepairCooldownRecord,
  RepairDoctorReport,
  RepairPlaybookId,
  ReliabilityObservation,
} from './types.js';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
} as const;

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function privacyJson(): string {
  return json(PRIVACY);
}

function addMinutes(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

function playbookForIntegration(id: string): RepairPlaybookId {
  const normalized = id.toLowerCase();
  if (normalized.includes('bluebubbles')) return 'bluebubbles_refresh_all';
  if (normalized.includes('telegram'))
    return 'telegram_user_session_auth_check';
  if (normalized.includes('alexa')) return 'alexa_ingress_probe';
  if (
    normalized.includes('google_calendar') ||
    normalized.includes('calendar')
  ) {
    return 'google_calendar_auth_check';
  }
  if (normalized.includes('assistant_session'))
    return 'assistant_session_clear_once';
  if (normalized.includes('work_cockpit') || normalized.includes('cursor')) {
    return 'work_cockpit_reconcile_selection';
  }
  if (
    normalized.includes('scheduled') ||
    normalized.includes('message_action')
  ) {
    return 'scheduled_action_failure_review';
  }
  if (normalized.includes('webhook')) return 'webhook_registration_check';
  return 'provider_quota_cooldown_record';
}

function statusForId(
  id: string,
  report: IntegrationDoctorReport,
): IntegrationStatus | null {
  return (
    report.statuses.find((status) => status.integrationId === id) ||
    report.statuses.find((status) => id.includes(status.integrationId)) ||
    null
  );
}

function providerForId(
  id: string,
  providers: ProviderHealthSnapshot[],
): ProviderHealthSnapshot | null {
  const normalized = id.replace(/^provider:/, '');
  return (
    providers.find((provider) => provider.providerId === normalized) || null
  );
}

function failureClassFor(
  status: IntegrationStatus | null,
  provider: ProviderHealthSnapshot | null,
): string {
  if (provider) return provider.failureClass;
  if (!status) return 'unknown';
  if (status.state === 'needs_auth') return 'auth_failure';
  if (status.state === 'needs_proof') return 'needs_proof';
  if (status.state === 'manual_action_required') return 'manual_external';
  if (status.transportState === 'blocked') return 'transport_error';
  if (status.transportState === 'not_configured') return 'missing_config';
  if (status.state === 'healthy') return 'none';
  return status.state;
}

function safeToApply(playbookId: RepairPlaybookId): boolean {
  return (
    playbookId === 'bluebubbles_refresh_all' ||
    playbookId === 'google_calendar_auth_check' ||
    playbookId === 'telegram_user_session_auth_check' ||
    playbookId === 'provider_quota_cooldown_record' ||
    playbookId === 'work_cockpit_reconcile_selection' ||
    playbookId === 'scheduled_action_failure_review' ||
    playbookId === 'webhook_registration_check' ||
    playbookId === 'alexa_ingress_probe'
  );
}

function playbookSummary(params: {
  playbookId: RepairPlaybookId;
  id: string;
  status: IntegrationStatus | null;
  provider: ProviderHealthSnapshot | null;
  dryRun: boolean;
}): {
  summary: string;
  nextAction: string;
  status: RepairAttemptRecord['status'];
  validation: RepairAttemptRecord['validationStatus'];
  cooldownMinutes: number;
} {
  switch (params.playbookId) {
    case 'bluebubbles_refresh_all':
      return {
        summary: params.dryRun
          ? `Planned BlueBubbles readiness refresh and proof reconciliation for ${params.id}.`
          : `Recorded proof-drill checklist and safe metadata refresh for BlueBubbles ${params.id}.`,
        nextAction:
          'Run npm run debug:bluebubbles -- --live, then complete same-thread proof if still needed.',
        status: params.status?.state === 'healthy' ? 'succeeded' : 'planned',
        validation:
          params.status?.state === 'healthy' ? 'passed' : 'manual_required',
        cooldownMinutes: 15,
      };
    case 'alexa_ingress_probe':
      return {
        summary: params.dryRun
          ? `Planned Alexa local/public ingress status probe for ${params.id}.`
          : `Recorded recovery checklist for Alexa local/public ingress status and signed proof for ${params.id}.`,
        nextAction:
          'Use Alexa Developer Console/app for signed live proof; code will not fake an IntentRequest.',
        status: params.status?.state === 'healthy' ? 'succeeded' : 'planned',
        validation: 'manual_required',
        cooldownMinutes: 30,
      };
    case 'google_calendar_auth_check':
      return {
        summary: params.dryRun
          ? `Planned Google Calendar auth/config classification for ${params.id}.`
          : `Recorded recovery checklist for Google Calendar auth/config classification for ${params.id}.`,
        nextAction:
          params.status?.state === 'needs_auth'
            ? 'Re-run Google Calendar OAuth setup; invalid or missing OAuth cannot be repaired automatically.'
            : 'Run npm run debug:google-calendar to validate the live read/write proof.',
        status: params.status?.state === 'healthy' ? 'succeeded' : 'planned',
        validation:
          params.status?.state === 'healthy' ? 'passed' : 'manual_required',
        cooldownMinutes: 60,
      };
    case 'telegram_user_session_auth_check':
      return {
        summary: params.dryRun
          ? `Planned Telegram user-session config/auth classification for ${params.id}.`
          : `Recorded recovery checklist for Telegram user-session config/auth classification for ${params.id}.`,
        nextAction:
          'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH if missing, run npm run telegram:user:auth if the session is missing, then run npm run telegram:user:smoke.',
        status: params.status?.state === 'healthy' ? 'succeeded' : 'planned',
        validation:
          params.status?.state === 'healthy' ? 'passed' : 'manual_required',
        cooldownMinutes: 60,
      };
    case 'provider_quota_cooldown_record':
      return {
        summary: params.dryRun
          ? `Planned provider quota/auth/transport cooldown classification for ${params.id}.`
          : `Recorded provider quota/auth/transport cooldown classification for ${params.id}.`,
        nextAction:
          params.provider?.nextAction ||
          'Route around the blocked provider and rerun provider diagnostics later.',
        status: params.provider?.state === 'healthy' ? 'succeeded' : 'cooldown',
        validation:
          params.provider?.state === 'healthy' ? 'passed' : 'manual_required',
        cooldownMinutes:
          params.provider?.failureClass === 'quota_or_rate_limit' ? 120 : 45,
      };
    case 'assistant_session_clear_once':
      return {
        summary: params.dryRun
          ? `Planned one-shot stale assistant-session recovery plan for ${params.id}.`
          : `Recorded one-shot stale assistant-session recovery plan for ${params.id}.`,
        nextAction:
          'Clear stale session once only, retry once, then keep the calm fallback if it still fails.',
        status: 'planned',
        validation: 'not_run',
        cooldownMinutes: 20,
      };
    case 'work_cockpit_reconcile_selection':
      return {
        summary: params.dryRun
          ? `Planned stale work-cockpit selection reconciliation for ${params.id}.`
          : `Recorded stale work-cockpit selection reconciliation for ${params.id}.`,
        nextAction:
          'Reconcile current runtime/Cursor lane state before claiming there is no current work.',
        status: 'planned',
        validation: 'not_run',
        cooldownMinutes: 20,
      };
    case 'scheduled_action_failure_review':
      return {
        summary: params.dryRun
          ? `Planned scheduled task/message-action failure review for ${params.id}.`
          : `Recorded scheduled task/message-action failure review for ${params.id}.`,
        nextAction:
          'Preserve draft/state, mark failed or carried over, and retry only transient transport with no receipt.',
        status: 'planned',
        validation: 'not_run',
        cooldownMinutes: 30,
      };
    case 'webhook_registration_check':
      return {
        summary: params.dryRun
          ? `Planned webhook registration diagnosis for ${params.id}.`
          : `Recorded webhook registration diagnosis for ${params.id}.`,
        nextAction:
          'Distinguish missing public base URL from registration failure; only reversible webhook changes are allowed.',
        status: 'planned',
        validation: 'not_run',
        cooldownMinutes: 30,
      };
  }
}

function repairObservation(
  attempt: RepairAttemptRecord,
): ReliabilityObservation {
  return {
    observationId: hashId(
      'relobs',
      `${attempt.attemptId}|repair|${attempt.status}`,
    ),
    subjectId: attempt.integrationId.startsWith('provider:')
      ? attempt.integrationId
      : `integration:${attempt.integrationId}`,
    observedAt: attempt.updatedAt,
    sourceKind: 'repair',
    outcome:
      attempt.status === 'succeeded'
        ? 'success'
        : attempt.status === 'cooldown' || attempt.status === 'blocked'
          ? 'blocked'
          : attempt.status === 'failed'
            ? 'failed'
            : 'degraded',
    failureClass: attempt.failureClass,
    confidence: attempt.status === 'succeeded' ? 0.9 : 0.45,
    fallbackUsed: attempt.status !== 'succeeded',
    latencyMs: null,
    summary: attempt.summary,
    nextAction: attempt.nextAction,
    evidenceIdsJson: attempt.evidenceIdsJson,
    privacyJson: attempt.privacyJson,
  };
}

export async function runIntegrationRepair(params: {
  id: string;
  dryRun?: boolean;
  apply?: boolean;
  now?: Date;
  report?: IntegrationDoctorReport;
  providers?: ProviderHealthSnapshot[];
  persist?: boolean;
}): Promise<RepairAttemptRecord> {
  const now = params.now || new Date();
  const createdAt = nowIso(now);
  const report = params.report || buildIntegrationDoctorReport({ now });
  const providers =
    params.providers || collectProviderHealthSnapshots(createdAt);
  const status = statusForId(params.id, report);
  const provider = providerForId(params.id, providers);
  const playbookId = playbookForIntegration(params.id);
  const failureClass = failureClassFor(status, provider);
  const dryRun = params.dryRun !== false || !params.apply;
  const cooldowns = isDatabaseInitialized()
    ? listRepairCooldowns({
        targetId: params.id,
        activeAt: createdAt,
        limit: 1,
      })
    : [];

  const critic = reviewAgentAction({
    actor: 'repair_agent',
    action: `repair playbook ${playbookId} for ${params.id}`,
    channel: 'internal',
    evidenceIds: [`repair:${params.id}:${createdAt}`],
    allowReadOnly: true,
    persist: params.persist,
    now,
  });

  const summary = playbookSummary({
    playbookId,
    id: params.id,
    status,
    provider,
    dryRun,
  });
  const blockedByCooldown = cooldowns.length > 0 && !dryRun;
  const canApply =
    safeToApply(playbookId) &&
    critic.decision !== 'block' &&
    !blockedByCooldown;
  const attempt: RepairAttemptRecord = {
    attemptId: hashId(
      'repair',
      `${params.id}|${playbookId}|${createdAt}|${dryRun ? 'dry' : 'apply'}`,
    ),
    playbookId,
    integrationId: params.id,
    createdAt,
    updatedAt: createdAt,
    status: blockedByCooldown
      ? 'cooldown'
      : critic.decision === 'block'
        ? 'blocked'
        : dryRun
          ? 'planned'
          : summary.status,
    failureClass,
    safeToApply: canApply,
    dryRun,
    validationStatus: dryRun ? 'not_run' : summary.validation,
    rollbackStatus: 'not_needed',
    summary: summary.summary,
    nextAction:
      cooldowns[0]?.nextAction ||
      (critic.decision === 'block' ? critic.nextAction : summary.nextAction),
    cooldownUntil:
      summary.status === 'cooldown' && !dryRun
        ? addMinutes(now, summary.cooldownMinutes)
        : cooldowns[0]?.expiresAt || null,
    evidenceIdsJson: json(
      [
        `repair:${params.id}:${createdAt}`,
        status ? `integration:${status.integrationId}:${status.state}` : null,
        provider ? `provider:${provider.providerId}:${provider.state}` : null,
      ].filter(Boolean),
    ),
    privacyJson: privacyJson(),
  };

  if (params.persist !== false && isDatabaseInitialized()) {
    upsertRepairAttempt(attempt);
    if (attempt.cooldownUntil) {
      const cooldown: RepairCooldownRecord = {
        cooldownId: hashId(
          'repaircooldown',
          `${params.id}|${playbookId}|${failureClass}`,
        ),
        targetId: params.id,
        playbookId,
        failureClass,
        createdAt,
        expiresAt: attempt.cooldownUntil,
        reason: attempt.summary,
        nextAction: attempt.nextAction,
        privacyJson: privacyJson(),
      };
      upsertRepairCooldown(cooldown);
    }
    upsertReliabilityObservation(repairObservation(attempt));
    await refreshToolReliabilityFromCurrentTruth({
      now,
      providers,
      integrationReport: report,
    });
  }
  return attempt;
}

export function buildRepairDoctorReport(now = new Date()): RepairDoctorReport {
  const generatedAt = nowIso(now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      attempts: [],
      cooldowns: [],
      nextAction: 'Initialize the database before reading repair status.',
      privacy: PRIVACY,
    };
  }
  const attempts = listRepairAttempts({ limit: 20 });
  const cooldowns = listRepairCooldowns({ activeAt: generatedAt, limit: 20 });
  const latest = attempts[0];
  return {
    generatedAt,
    attempts,
    cooldowns,
    nextAction:
      cooldowns[0]?.nextAction ||
      latest?.nextAction ||
      'Run npm run debug:repair -- --dry-run --id bluebubbles to seed one repair trace.',
    privacy: PRIVACY,
  };
}

export function formatRepairDoctorReport(report: RepairDoctorReport): string {
  const lines = ['*Repair Status*'];
  if (report.attempts.length) {
    lines.push('*Recent attempts*');
    for (const attempt of report.attempts.slice(0, 6)) {
      lines.push(
        `- ${attempt.integrationId}/${attempt.playbookId}: ${attempt.status} validation=${attempt.validationStatus} next=${attempt.nextAction}`,
      );
    }
  } else {
    lines.push('- no repair attempts recorded yet');
  }
  if (report.cooldowns.length) {
    lines.push('*Cooldowns*');
    for (const cooldown of report.cooldowns.slice(0, 4)) {
      lines.push(
        `- ${cooldown.targetId}: ${cooldown.failureClass} until ${cooldown.expiresAt}`,
      );
    }
  }
  lines.push(`Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, raw tool output, or secrets are stored.',
  );
  return lines.join('\n');
}
