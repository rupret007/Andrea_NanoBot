import {
  buildIntegrationDoctorReport,
  redactIntegrationDoctorText,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import { buildLiveProofGauntletReport } from './live-proof-gauntlet.js';
import {
  buildRepairDoctorReport,
  runIntegrationRepair,
} from './integration-healer.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type {
  LiveProofGauntletReport,
  RepairAttemptRecord,
  RepairDoctorReport,
} from './types.js';

export type IntegrationRecoveryClass =
  | 'healthy'
  | 'missing_config'
  | 'needs_auth'
  | 'manual_proof'
  | 'proof_drill'
  | 'external_blocker'
  | 'provider_blocker'
  | 'repo_fix_available'
  | 'degraded'
  | 'proof_gap';

export interface IntegrationRecoveryItem {
  integrationId: string;
  label: string;
  currentState: string;
  recoveryClass: IntegrationRecoveryClass;
  lastKnownGoodAt: string | null;
  blockedBy: 'none' | 'repo_side' | 'external' | 'manual' | 'mixed';
  canApplySafely: boolean;
  nextHumanStep: string;
  successCheck: string;
  detail: string;
  latestRepairStatus: RepairAttemptRecord['status'] | null;
  latestRepairAt: string | null;
  evidenceIds: string[];
  priority: number;
}

export interface IntegrationRecoveryReport {
  generatedAt: string;
  summary: {
    total: number;
    actionNeeded: number;
    canApplySafely: number;
    manualOrExternal: number;
  };
  targetId: string | null;
  items: IntegrationRecoveryItem[];
  nextAction: string;
  secretsRedacted: true;
}

export interface BuildIntegrationRecoveryReportOptions {
  now?: Date;
  targetId?: string | null;
  integrationReport?: IntegrationDoctorReport;
  proofReport?: LiveProofGauntletReport;
  providers?: ProviderHealthSnapshot[];
  repairReport?: RepairDoctorReport;
}

export type IntegrationRecoveryCommandAction = 'status' | 'plan' | 'apply';

export interface IntegrationRecoveryCommand {
  action: IntegrationRecoveryCommandAction;
  targetId: string | null;
}

export interface IntegrationRecoveryCommandResult {
  command: IntegrationRecoveryCommand;
  report: IntegrationRecoveryReport;
  attempt: RepairAttemptRecord | null;
  text: string;
}

const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_]*(?:password|token|secret|api[_-]?key|api[_-]?hash|access[_-]?token|refresh[_-]?token))=([^;\s]+)/gi;

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bcrsr_[A-Za-z0-9_]{16,}\b/g,
  /\bBSA-[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];

const TARGET_ALIASES: Record<string, string> = {
  alexa: 'alexa',
  anthropic: 'provider:anthropic_cloud',
  anthropic_cloud: 'provider:anthropic_cloud',
  bluebubbles: 'bluebubbles',
  brave: 'provider:brave_search',
  brave_search: 'provider:brave_search',
  calendar: 'google_calendar',
  claude: 'provider:anthropic_cloud',
  feature: 'feature_proofs',
  feature_proofs: 'feature_proofs',
  gemini: 'provider:gemini_cloud',
  gemini_cloud: 'provider:gemini_cloud',
  google: 'google_calendar',
  google_calendar: 'google_calendar',
  imessage: 'bluebubbles',
  messages: 'bluebubbles',
  minimax: 'provider:minimax_cloud',
  minimax_cloud: 'provider:minimax_cloud',
  openai: 'provider:openai_cloud',
  openai_cloud: 'provider:openai_cloud',
  provider_anthropic_cloud: 'provider:anthropic_cloud',
  provider_brave_search: 'provider:brave_search',
  provider_gemini_cloud: 'provider:gemini_cloud',
  provider_minimax_cloud: 'provider:minimax_cloud',
  provider_openai_cloud: 'provider:openai_cloud',
  telegram: 'telegram',
  telegram_user: 'telegram',
  telegram_user_session: 'telegram',
  tg: 'telegram',
};

const PRIORITY: Record<string, number> = {
  telegram: 10,
  google_calendar: 20,
  bluebubbles: 30,
  alexa: 40,
  feature_proofs: 60,
};

function redactRecoveryText(value: string): string {
  let cleaned = redactIntegrationDoctorText(value).replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string) => `${key}=***`,
  );
  for (const pattern of SECRET_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[redacted-secret]');
  }
  return cleaned.trim();
}

export function normalizeRecoveryTarget(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/['"]/g, '')
    .replace(/\s+/g, '_')
    .replace(/-/g, '_');
  if (!normalized) return null;
  if (normalized.startsWith('provider:')) return normalized;
  return TARGET_ALIASES[normalized] || normalized;
}

function proofLastKnownGood(value: string | null | undefined): string | null {
  const trimmed = String(value || '').trim();
  return trimmed && trimmed !== 'none' ? trimmed : null;
}

function ownerFromProof(
  owner: 'none' | 'repo_side' | 'external',
): IntegrationRecoveryItem['blockedBy'] {
  return owner;
}

function recoveryClassFor(params: {
  status?: IntegrationStatus | null;
  proofStatus?: string | null;
  provider?: ProviderHealthSnapshot | null;
}): IntegrationRecoveryClass {
  if (params.provider) {
    if (params.provider.state === 'healthy') return 'healthy';
    if (params.provider.failureClass === 'quota_or_rate_limit') {
      return 'provider_blocker';
    }
    if (
      params.provider.failureClass === 'missing_credentials' ||
      params.provider.failureClass === 'auth_failure'
    ) {
      return 'missing_config';
    }
    return 'external_blocker';
  }

  if (
    params.status?.state === 'healthy' &&
    (!params.proofStatus || params.proofStatus === 'live_proven')
  )
    return 'healthy';
  if (!params.status && params.proofStatus === 'live_proven') return 'healthy';
  if (params.status?.state === 'needs_auth') return 'needs_auth';
  if (params.proofStatus === 'missing_config') return 'missing_config';
  if (params.status?.state === 'needs_proof') return 'proof_drill';
  if (params.proofStatus === 'stale') return 'manual_proof';
  if (params.status?.state === 'manual_action_required') return 'manual_proof';
  if (params.status?.state === 'externally_blocked') return 'external_blocker';
  if (params.status?.state === 'repo_fix_available')
    return 'repo_fix_available';
  if (params.proofStatus === 'near_live_only') return 'proof_gap';
  if (params.status?.state === 'degraded_but_usable') return 'degraded';
  if (params.status?.state === 'near_live_only') return 'proof_gap';
  return 'degraded';
}

function shouldPreferProof(
  status: IntegrationStatus | null | undefined,
  proof: LiveProofGauntletReport['entries'][number] | null | undefined,
): boolean {
  if (!proof || proof.status === 'live_proven') return false;
  if (proof.status === 'missing_config') return true;
  return (
    !status || status.state === 'healthy' || status.state === 'near_live_only'
  );
}

function statusById(
  report: IntegrationDoctorReport,
  id: string,
): IntegrationStatus | null {
  return report.statuses.find((status) => status.integrationId === id) || null;
}

function proofByName(
  report: LiveProofGauntletReport,
  pattern: RegExp,
): LiveProofGauntletReport['entries'][number] | null {
  return report.entries.find((entry) => pattern.test(entry.proofName)) || null;
}

function latestRepairFor(
  report: RepairDoctorReport,
  id: string,
): RepairAttemptRecord | null {
  return (
    report.attempts.find(
      (attempt) =>
        attempt.integrationId === id ||
        attempt.integrationId === id.replace(/^provider:/, ''),
    ) || null
  );
}

function canApplyChecklist(
  itemId: string,
  recoveryClass: IntegrationRecoveryClass,
) {
  if (recoveryClass === 'healthy') return false;
  if (itemId === 'feature_proofs') return false;
  return (
    ['telegram', 'google_calendar', 'bluebubbles', 'alexa'].includes(itemId) ||
    itemId.startsWith('provider:') ||
    itemId.includes('assistant_session') ||
    itemId.includes('work_cockpit') ||
    itemId.includes('scheduled') ||
    itemId.includes('message_action') ||
    itemId.includes('webhook')
  );
}

function currentStateFor(params: {
  status?: IntegrationStatus | null;
  proof?: LiveProofGauntletReport['entries'][number] | null;
  provider?: ProviderHealthSnapshot | null;
}): string {
  if (params.provider) return params.provider.state;
  if (shouldPreferProof(params.status, params.proof)) {
    return params.proof?.status || 'unknown';
  }
  if (params.status && params.status.state !== 'healthy') {
    return params.status.state;
  }
  if (params.proof && params.proof.status !== 'live_proven') {
    return params.proof.status;
  }
  return params.status?.state || params.proof?.status || 'unknown';
}

function ownerFor(params: {
  status?: IntegrationStatus | null;
  proof?: LiveProofGauntletReport['entries'][number] | null;
  provider?: ProviderHealthSnapshot | null;
}): IntegrationRecoveryItem['blockedBy'] {
  if (params.provider) {
    if (params.provider.failureClass === 'none') return 'none';
    if (
      params.provider.failureClass === 'missing_credentials' ||
      params.provider.failureClass === 'auth_failure' ||
      params.provider.failureClass === 'quota_or_rate_limit' ||
      params.provider.failureClass === 'manual_external'
    ) {
      return 'external';
    }
    return 'mixed';
  }
  if (shouldPreferProof(params.status, params.proof)) {
    if (params.proof?.status === 'missing_config') return 'external';
    if (params.proof?.blockerOwner && params.proof.blockerOwner !== 'none') {
      return ownerFromProof(params.proof.blockerOwner);
    }
  }
  if (params.status?.blockerOwner && params.status.blockerOwner !== 'none') {
    return params.status.blockerOwner;
  }
  if (params.proof?.blockerOwner && params.proof.blockerOwner !== 'none') {
    return ownerFromProof(params.proof.blockerOwner);
  }
  return params.status?.blockerOwner || 'none';
}

function commandForSuccessCheck(id: string): string {
  if (id === 'telegram') {
    return 'Run npm run telegram:user:auth if the user session is missing, then npm run telegram:user:smoke and rerun /integrations.';
  }
  if (id === 'google_calendar') {
    return 'Run npm run setup -- --step google-calendar validate, then npm run debug:google-calendar and rerun /integrations.';
  }
  if (id === 'bluebubbles') {
    return 'Run npm run debug:bluebubbles -- --live, complete the same-thread proof drill, then rerun /integrations.';
  }
  if (id === 'alexa') {
    return 'Run /alexa-status, make one real signed simulator/device IntentRequest, then confirm npm run services:status.';
  }
  if (id === 'feature_proofs') {
    return 'Run npm run debug:pilot after the fresh proof journey turns are complete.';
  }
  if (id.startsWith('provider:')) {
    return 'Run npm run debug:providers and rerun /integrations after quota or credentials recover.';
  }
  return 'Run npm run integrations:doctor and rerun /integrations.';
}

function itemFromSurface(params: {
  id: string;
  label: string;
  status?: IntegrationStatus | null;
  proof?: LiveProofGauntletReport['entries'][number] | null;
  provider?: ProviderHealthSnapshot | null;
  repairReport: RepairDoctorReport;
  priority?: number;
}): IntegrationRecoveryItem {
  const recoveryClass = recoveryClassFor({
    status: params.status,
    proofStatus: params.proof?.status,
    provider: params.provider,
  });
  const repair = latestRepairFor(params.repairReport, params.id);
  const currentState = currentStateFor(params);
  const owner = ownerFor(params);
  const proofFirst = shouldPreferProof(params.status, params.proof);
  const detail =
    (proofFirst
      ? params.proof?.detail || params.status?.detail
      : params.status?.detail || params.proof?.detail) ||
    params.provider?.blocker ||
    '';
  const nextHumanStep =
    (proofFirst
      ? params.proof?.nextStep || params.status?.nextAction
      : params.status?.nextAction || params.proof?.nextStep) ||
    params.provider?.nextAction ||
    'No action needed.';

  return {
    integrationId: params.id,
    label: params.label,
    currentState,
    recoveryClass,
    lastKnownGoodAt:
      proofLastKnownGood(params.proof?.lastProofAt) ||
      params.provider?.lastHealthyAt ||
      null,
    blockedBy: owner,
    canApplySafely: canApplyChecklist(params.id, recoveryClass),
    nextHumanStep: redactRecoveryText(nextHumanStep),
    successCheck: commandForSuccessCheck(params.id),
    detail: redactRecoveryText(detail),
    latestRepairStatus: repair?.status || null,
    latestRepairAt: repair?.updatedAt || null,
    evidenceIds: [
      params.proof?.proofId,
      params.status ? `integration:${params.status.integrationId}` : null,
      params.provider ? `provider:${params.provider.providerId}` : null,
      repair?.attemptId,
    ].filter((value): value is string => Boolean(value)),
    priority:
      params.priority ??
      PRIORITY[params.id] ??
      (params.id.startsWith('provider:') ? 50 : 90),
  };
}

function shouldIncludeItem(item: IntegrationRecoveryItem): boolean {
  return item.recoveryClass !== 'healthy' || item.currentState !== 'healthy';
}

function providerLabel(providerId: string): string {
  return providerId.replace(/_/g, ' ');
}

export function buildIntegrationRecoveryReport(
  options: BuildIntegrationRecoveryReportOptions = {},
): IntegrationRecoveryReport {
  const now = options.now || new Date();
  const generatedAt = now.toISOString();
  const providers =
    options.providers || collectProviderHealthSnapshots(generatedAt);
  const integrationReport =
    options.integrationReport ||
    buildIntegrationDoctorReport({ now, providers });
  const proofReport =
    options.proofReport || buildLiveProofGauntletReport({ now });
  const repairReport = options.repairReport || buildRepairDoctorReport(now);
  const targetId = normalizeRecoveryTarget(options.targetId);
  const items: IntegrationRecoveryItem[] = [];
  const seen = new Set<string>();

  const add = (item: IntegrationRecoveryItem) => {
    if (seen.has(item.integrationId) || !shouldIncludeItem(item)) return;
    seen.add(item.integrationId);
    items.push(item);
  };

  const telegramStatus = statusById(integrationReport, 'telegram');
  const telegramProof = proofByName(proofReport, /telegram user-session/i);
  if (telegramStatus || telegramProof) {
    add(
      itemFromSurface({
        id: 'telegram',
        label: 'Telegram user-session proof',
        status: telegramStatus,
        proof: telegramProof,
        repairReport,
        priority: PRIORITY.telegram,
      }),
    );
  }
  const calendarStatus = statusById(integrationReport, 'google_calendar');
  const calendarProof = proofByName(proofReport, /google calendar/i);
  if (calendarStatus || calendarProof) {
    add(
      itemFromSurface({
        id: 'google_calendar',
        label: 'Google Calendar',
        status: calendarStatus,
        proof: calendarProof,
        repairReport,
        priority: PRIORITY.google_calendar,
      }),
    );
  }
  const bluebubblesStatus = statusById(integrationReport, 'bluebubbles');
  const bluebubblesProof = proofByName(proofReport, /bluebubbles/i);
  if (bluebubblesStatus || bluebubblesProof) {
    add(
      itemFromSurface({
        id: 'bluebubbles',
        label: 'BlueBubbles / iMessage',
        status: bluebubblesStatus,
        proof: bluebubblesProof,
        repairReport,
        priority: PRIORITY.bluebubbles,
      }),
    );
  }
  const alexaStatus = statusById(integrationReport, 'alexa');
  const alexaProof = proofByName(proofReport, /alexa signed/i);
  if (alexaStatus || alexaProof) {
    add(
      itemFromSurface({
        id: 'alexa',
        label: 'Alexa signed IntentRequest',
        status: alexaStatus,
        proof: alexaProof,
        repairReport,
        priority: PRIORITY.alexa,
      }),
    );
  }

  for (const provider of providers) {
    if (provider.state === 'healthy') continue;
    add(
      itemFromSurface({
        id: `provider:${provider.providerId}`,
        label: providerLabel(provider.providerId),
        provider,
        status: statusById(integrationReport, provider.providerId),
        repairReport,
        priority: 50,
      }),
    );
  }

  const featureProofsStatus = statusById(integrationReport, 'feature_proofs');
  if (featureProofsStatus) {
    add(
      itemFromSurface({
        id: 'feature_proofs',
        label: 'Flagship journey proof gaps',
        status: featureProofsStatus,
        repairReport,
        priority: PRIORITY.feature_proofs,
      }),
    );
  }

  for (const status of integrationReport.statuses) {
    if (
      seen.has(status.integrationId) ||
      ['telegram', 'google_calendar', 'bluebubbles', 'alexa'].includes(
        status.integrationId,
      )
    ) {
      continue;
    }
    if (
      providers.some((provider) => provider.providerId === status.integrationId)
    ) {
      continue;
    }
    add(
      itemFromSurface({
        id: status.integrationId,
        label: status.label,
        status,
        repairReport,
      }),
    );
  }

  const sorted = items.sort(
    (left, right) =>
      left.priority - right.priority ||
      left.integrationId.localeCompare(right.integrationId),
  );
  const filtered = targetId
    ? sorted.filter((item) => item.integrationId === targetId)
    : sorted;
  const next = filtered[0];
  return {
    generatedAt,
    summary: {
      total: filtered.length,
      actionNeeded: filtered.filter((item) => item.recoveryClass !== 'healthy')
        .length,
      canApplySafely: filtered.filter((item) => item.canApplySafely).length,
      manualOrExternal: filtered.filter((item) =>
        ['external', 'manual', 'mixed'].includes(item.blockedBy),
      ).length,
    },
    targetId,
    items: filtered,
    nextAction: next
      ? `${next.label}: ${next.nextHumanStep}`
      : targetId
        ? `No current recovery item matched ${targetId}.`
        : 'No blocked or proof-needed integrations are currently visible.',
    secretsRedacted: true,
  };
}

function renderLastKnownGood(item: IntegrationRecoveryItem): string {
  return item.lastKnownGoodAt || 'not currently proven';
}

export function formatIntegrationRecoveryReport(
  report: IntegrationRecoveryReport,
): string {
  const lines = [
    '*Integration Recovery*',
    `Generated: ${report.generatedAt}`,
    `Summary: ${report.summary.actionNeeded}/${report.summary.total} need action, ${report.summary.canApplySafely} safe guided action(s), ${report.summary.manualOrExternal} manual/external blocker(s). Secrets are redacted.`,
  ];

  if (report.items.length === 0) {
    lines.push('', report.nextAction);
    return redactRecoveryText(lines.join('\n'));
  }

  lines.push('', '*Recovery Queue*');
  for (const item of report.items) {
    lines.push(
      `- ${item.label}: ${item.recoveryClass} / state=${item.currentState} / owner=${item.blockedBy}`,
    );
    lines.push(`  last_known_good=${renderLastKnownGood(item)}`);
    if (item.latestRepairStatus) {
      lines.push(
        `  latest_repair=${item.latestRepairStatus} at ${item.latestRepairAt || 'unknown'}`,
      );
    }
    if (item.detail) {
      lines.push(`  detail=${item.detail}`);
    }
    lines.push(`  next=${item.nextHumanStep}`);
    lines.push(`  check=${item.successCheck}`);
    lines.push(
      `  safe_guided=${item.canApplySafely ? `yes, /integrations plan ${item.integrationId}` : 'no'}`,
    );
  }
  lines.push('', `Next: ${report.nextAction}`);
  lines.push(
    'Apply policy: /integrations apply <id> records only whitelisted metadata, cooldown, or checklist repairs. OAuth grants, credentials, message sends, calendar writes, and Alexa signed turns remain human/external steps.',
  );
  return redactRecoveryText(lines.join('\n'));
}

export function parseIntegrationRecoveryCommand(
  rawText: string,
): IntegrationRecoveryCommand {
  const args = rawText.trim().split(/\s+/).slice(1);
  const first = args[0]?.toLowerCase();
  if (first === 'plan' || first === 'apply') {
    return {
      action: first,
      targetId: normalizeRecoveryTarget(args.slice(1).join(' ') || null),
    };
  }
  return {
    action: 'status',
    targetId: normalizeRecoveryTarget(args.join(' ') || null),
  };
}

function formatAttempt(attempt: RepairAttemptRecord): string {
  return redactRecoveryText(
    [
      '*Recovery Action*',
      `Target: ${attempt.integrationId}`,
      `Playbook: ${attempt.playbookId}`,
      `Status: ${attempt.status}`,
      `Dry run: ${attempt.dryRun}`,
      `Validation: ${attempt.validationStatus}`,
      `Safe to apply: ${attempt.safeToApply}`,
      `Summary: ${attempt.summary}`,
      `Next: ${attempt.nextAction}`,
    ].join('\n'),
  );
}

export async function runIntegrationRecoveryCommand(
  rawText: string,
): Promise<IntegrationRecoveryCommandResult> {
  const command = parseIntegrationRecoveryCommand(rawText);
  if (command.action === 'status') {
    const report = buildIntegrationRecoveryReport({
      targetId: command.targetId,
    });
    return {
      command,
      report,
      attempt: null,
      text: formatIntegrationRecoveryReport(report),
    };
  }

  if (!command.targetId) {
    const report = buildIntegrationRecoveryReport();
    return {
      command,
      report,
      attempt: null,
      text: redactRecoveryText(
        [
          'Usage: /integrations plan <id> or /integrations apply <id>',
          '',
          formatIntegrationRecoveryReport(report),
        ].join('\n'),
      ),
    };
  }

  const reportBefore = buildIntegrationRecoveryReport({
    targetId: command.targetId,
  });
  const item = reportBefore.items[0];
  if (!item) {
    return {
      command,
      report: reportBefore,
      attempt: null,
      text: formatIntegrationRecoveryReport(reportBefore),
    };
  }
  if (command.action === 'apply' && !item.canApplySafely) {
    return {
      command,
      report: reportBefore,
      attempt: null,
      text: redactRecoveryText(
        [
          '*Recovery Action Blocked*',
          `${item.label} does not have a safe metadata-only apply path.`,
          `Next: ${item.nextHumanStep}`,
          '',
          formatIntegrationRecoveryReport(reportBefore),
        ].join('\n'),
      ),
    };
  }

  const attempt = await runIntegrationRepair({
    id: command.targetId,
    dryRun: command.action === 'plan',
    apply: command.action === 'apply',
  });
  const report = buildIntegrationRecoveryReport({
    targetId: command.targetId,
  });
  return {
    command,
    report,
    attempt,
    text: [formatAttempt(attempt), '', formatIntegrationRecoveryReport(report)]
      .join('\n')
      .trim(),
  };
}
