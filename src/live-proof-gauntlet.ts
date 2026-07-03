import crypto from 'node:crypto';

import {
  buildFieldTrialOperatorTruth,
  type FieldTrialBlockerOwner,
  type FieldTrialProofState,
  type FieldTrialSurfaceTruth,
} from './field-trial-readiness.js';
import { redactCouncilText } from './council-safety.js';
import { readEnvFile } from './env.js';
import type {
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
  LiveProofGauntletStatus,
} from './types.js';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  rawToolOutputStored: false,
} as const;

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 20)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted proof metadata]';
  return redactCouncilText(text, limit);
}

function safeJson(value: unknown, limit = 1600): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(json, limit);
  } catch {
    return 'null';
  }
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function evidenceJson(ids: string[]): string {
  return JSON.stringify(
    Array.from(
      new Set(
        ids
          .map((id) =>
            String(id)
              .replace(/[^A-Za-z0-9:_-]+/g, '_')
              .slice(0, 180),
          )
          .filter(Boolean),
      ),
    ).slice(0, 40),
  );
}

function envHas(key: string, env: Record<string, string | undefined>): boolean {
  return Boolean(env[key] && String(env[key]).trim());
}

function gauntletStatusForSurface(
  surface: FieldTrialSurfaceTruth,
): LiveProofGauntletStatus {
  if (surface.proofState === 'live_proven') return 'live_proven';
  if (surface.blockerOwner === 'external') {
    return /credential|config|env|api id|api hash|missing/i.test(
      `${surface.blocker} ${surface.nextAction} ${surface.detail}`,
    )
      ? 'missing_config'
      : 'externally_blocked';
  }
  if (surface.proofState === 'externally_blocked') return 'externally_blocked';
  if (surface.proofState === 'degraded_but_usable') return 'near_live_only';
  if (surface.proofState === 'near_live_only') return 'near_live_only';
  return 'failed';
}

function repoWorkRequiredFor(surface: FieldTrialSurfaceTruth): boolean {
  return (
    surface.blockerOwner === 'repo_side' &&
    surface.proofState !== 'live_proven' &&
    !/proof|manual|credential|config|external|app|device|console|quota/i.test(
      `${surface.blocker} ${surface.nextAction} ${surface.detail}`,
    )
  );
}

function isOptionalProofEntry(entry: LiveProofGauntletEntry): boolean {
  return /Alexa signed IntentRequest/i.test(entry.proofName);
}

function entryFromSurface(params: {
  proofName: string;
  surface: FieldTrialSurfaceTruth;
  lastProofAt?: string | null;
  evidenceIds?: string[];
  nextStepOverride?: string;
  statusOverride?: LiveProofGauntletStatus;
  repoWorkRequiredOverride?: boolean;
}): LiveProofGauntletEntry {
  const status =
    params.statusOverride || gauntletStatusForSurface(params.surface);
  return {
    proofId: hashId('proof', params.proofName),
    proofName: params.proofName,
    status,
    lastProofAt: params.lastProofAt || 'none',
    nextStep: safeText(
      params.nextStepOverride ||
        params.surface.nextAction ||
        params.surface.blocker ||
        'No action needed.',
      900,
    ),
    repoWorkRequired:
      typeof params.repoWorkRequiredOverride === 'boolean'
        ? params.repoWorkRequiredOverride
        : repoWorkRequiredFor(params.surface),
    blockerOwner: params.surface.blockerOwner,
    evidenceIdsJson: evidenceJson(params.evidenceIds || [params.proofName]),
    detail: safeText(params.surface.detail || params.surface.blocker, 1200),
    privacyJson: privacyJson(),
  };
}

export function buildLiveProofGauntletReport(
  params: {
    now?: Date;
    env?: Record<string, string | undefined>;
    truth?: ReturnType<typeof buildFieldTrialOperatorTruth>;
  } = {},
): LiveProofGauntletReport {
  const generatedAt = nowIso(params.now);
  const envFile = readEnvFile([
    'TELEGRAM_USER_API_ID',
    'TELEGRAM_USER_API_HASH',
  ]);
  const env = { ...envFile, ...process.env, ...(params.env || {}) };
  const truth = params.truth || buildFieldTrialOperatorTruth();
  const telegramUserConfigured =
    envHas('TELEGRAM_USER_API_ID', env) &&
    envHas('TELEGRAM_USER_API_HASH', env);
  const telegramUser = entryFromSurface({
    proofName: 'Telegram user-session proof',
    surface: truth.telegram,
    evidenceIds: ['proof:telegram_user_session'],
    statusOverride: telegramUserConfigured
      ? gauntletStatusForSurface(truth.telegram)
      : 'missing_config',
    nextStepOverride: telegramUserConfigured
      ? truth.telegram.nextAction
      : 'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH, then run npm run telegram:user:smoke.',
    repoWorkRequiredOverride: false,
  });
  const telegramBot = entryFromSurface({
    proofName: 'Telegram bot proof',
    surface: truth.telegram,
    evidenceIds: ['proof:telegram_bot', 'surface:telegram'],
    nextStepOverride:
      truth.telegram.proofState === 'live_proven'
        ? 'No action needed.'
        : truth.journeys.ordinary_chat.nextAction ||
          'Send `hi` or `what am I forgetting` in Telegram, then rerun npm run debug:pilot.',
    repoWorkRequiredOverride: false,
  });
  const alexa = entryFromSurface({
    proofName: 'Alexa signed IntentRequest proof',
    surface: truth.alexa,
    lastProofAt:
      truth.alexa.lastHandledProofAt || truth.alexa.lastSignedRequestAt,
    evidenceIds: ['proof:alexa_signed_intentrequest'],
    nextStepOverride:
      truth.alexa.nextAction ||
      'Use a real device or authenticated Alexa simulator, say `Open Andrea Assistant`, then `What am I forgetting?`.',
    statusOverride:
      truth.alexa.proofFreshness === 'stale'
        ? 'stale'
        : gauntletStatusForSurface(truth.alexa),
    repoWorkRequiredOverride: false,
  });
  const bluebubbles = entryFromSurface({
    proofName: 'BlueBubbles same-thread message-action proof',
    surface: truth.bluebubbles,
    lastProofAt: truth.bluebubbles.messageActionProofAt,
    evidenceIds: [
      'proof:bluebubbles_same_thread',
      truth.bluebubbles.messageActionProofChatJid || 'proof:bluebubbles',
    ],
    nextStepOverride:
      truth.bluebubbles.nextAction ||
      'In the canonical self-thread, send `@Andrea what should I say back`, then `@Andrea send it later tonight`.',
    statusOverride:
      truth.bluebubbles.messageActionProofState === 'stale'
        ? 'stale'
        : truth.bluebubbles.proofState === 'degraded_but_usable' ||
            truth.bluebubbles.proofState === 'near_live_only'
          ? 'near_live_only'
          : gauntletStatusForSurface(truth.bluebubbles),
    repoWorkRequiredOverride: false,
  });
  const calendar = entryFromSurface({
    proofName: 'Google Calendar live write proof',
    surface: truth.googleCalendar,
    evidenceIds: ['proof:google_calendar'],
  });
  const research = entryFromSurface({
    proofName: 'Research/provider proof',
    surface: truth.research,
    evidenceIds: ['proof:research'],
  });
  const image = entryFromSurface({
    proofName: 'Image generation proof',
    surface: truth.imageGeneration,
    evidenceIds: ['proof:image_generation'],
  });
  const entries = [
    telegramUser,
    telegramBot,
    alexa,
    bluebubbles,
    calendar,
    research,
    image,
  ];
  const liveProvenCount = entries.filter(
    (entry) => entry.status === 'live_proven',
  ).length;
  const dailyCoreEntries = entries.filter(
    (entry) => !isOptionalProofEntry(entry),
  );
  const dailyCoreLiveProvenCount = dailyCoreEntries.filter(
    (entry) => entry.status === 'live_proven',
  ).length;
  const repoWorkRequiredCount = entries.filter(
    (entry) => entry.repoWorkRequired,
  ).length;
  const proofDebtCount = entries.length - liveProvenCount;
  const dailyCoreProofDebtCount =
    dailyCoreEntries.length - dailyCoreLiveProvenCount;
  const optionalProofDebtCount = entries.filter(
    (entry) => isOptionalProofEntry(entry) && entry.status !== 'live_proven',
  ).length;
  const firstDailyCoreDebt = dailyCoreEntries.find(
    (entry) => entry.status !== 'live_proven',
  );
  const firstOptionalDebt = entries.find(
    (entry) => isOptionalProofEntry(entry) && entry.status !== 'live_proven',
  );
  return {
    generatedAt,
    entries,
    liveProvenCount,
    proofDebtCount,
    dailyCoreLiveProvenCount,
    dailyCoreProofDebtCount,
    optionalProofDebtCount,
    repoWorkRequiredCount,
    nextAction: firstDailyCoreDebt
      ? `${firstDailyCoreDebt.proofName}: ${firstDailyCoreDebt.nextStep}`
      : firstOptionalDebt
        ? `Daily-core proofs are current. Optional ${firstOptionalDebt.proofName}: ${firstOptionalDebt.nextStep}`
        : 'All tracked live proof surfaces are currently live-proven.',
    privacyJson: privacyJson(),
  };
}

export function formatLiveProofGauntletReport(
  report: LiveProofGauntletReport,
): string {
  const lines = [
    '*Live Proof Gauntlet*',
    `Generated: ${report.generatedAt}`,
    `Live proven: ${report.liveProvenCount}/${report.entries.length}`,
    `Proof debt: ${report.proofDebtCount}`,
    `Daily-core live proven: ${report.dailyCoreLiveProvenCount}/${report.entries.length - 1}`,
    `Daily-core proof debt: ${report.dailyCoreProofDebtCount}`,
    `Optional proof debt: ${report.optionalProofDebtCount}`,
    `Repo work required: ${report.repoWorkRequiredCount}`,
    '',
    '*Proof Entries*',
  ];
  for (const entry of report.entries) {
    lines.push(
      `- ${entry.proofName}: ${entry.status} / owner=${entry.blockerOwner} / repo_work=${entry.repoWorkRequired ? 'yes' : 'no'} / last=${entry.lastProofAt}`,
    );
    lines.push(`  next=${entry.nextStep}`);
  }
  lines.push('', `Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw private bodies, prompts, hidden reasoning, raw tool output, or secrets.',
  );
  return lines.join('\n');
}

export function proofStateToGauntletStatus(
  proofState: FieldTrialProofState,
  blockerOwner: FieldTrialBlockerOwner = 'none',
): LiveProofGauntletStatus {
  return gauntletStatusForSurface({
    proofState,
    blocker: '',
    blockerOwner,
    nextAction: '',
    detail: '',
  });
}
