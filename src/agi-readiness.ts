import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgiScorecardResult } from './agi-scorecard.js';
import type {
  IntegrationDoctorReport,
  IntegrationDoctorState,
  IntegrationStatus,
} from './integration-doctor.js';
import type {
  LiveProofGauntletEntry,
  LiveProofGauntletReport,
} from './types.js';

export type AgiReadinessBlockerCategory =
  | 'repo_fix_required'
  | 'external_config_required'
  | 'manual_live_proof_required'
  | 'optional_capability_unverified'
  | 'optional_capability_blocked'
  | 'publish_blocked';

export type AgiReadinessSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AgiReadinessDoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface AgiReadinessDoctorReport {
  ok: boolean;
  stateDir: string;
  checks: AgiReadinessDoctorCheck[];
}

export interface AgiPublishStatus {
  branch: string;
  remote: string | null;
  aheadBy: number;
  hasTrackedChanges: boolean;
  hasOutOfScopeUntracked: boolean;
  ignoredUntracked: string[];
  ghCliInstalled: boolean;
  ghAuthenticated: boolean;
  pushReady: boolean;
  prReady: boolean;
  blockers: string[];
  detail: string;
}

export interface AgiReadinessBlocker {
  category: AgiReadinessBlockerCategory;
  severity: AgiReadinessSeverity;
  source:
    | 'scorecard'
    | 'agi_doctor'
    | 'integrations'
    | 'live_proof'
    | 'publish';
  id: string;
  label: string;
  status: string;
  owner: 'repo_side' | 'external' | 'manual' | 'mixed' | 'none';
  action: string;
  detail: string;
  blocksLaunch: boolean;
  blocksPublish: boolean;
}

export interface AgiReadinessProofDebtItem {
  proofName: string;
  status: string;
  blockerOwner: string;
  repoWorkRequired: boolean;
  nextStep: string;
  detail: string;
}

export interface AgiReadinessProofDebt {
  liveProven: number;
  total: number;
  debtCount: number;
  repoWorkRequiredCount: number;
  entries: AgiReadinessProofDebtItem[];
}

export interface AgiReadinessDeterministicScorecardSummary {
  overallScore: number;
  grade: string;
  regressions: string[];
  weaknesses: string[];
  weakestDimension: string;
  weakestDimensionScore: number;
  weakestSuite: string;
  weakestSuiteScore: number;
  recommendations: string[];
}

export interface AgiReadinessReport {
  runId: string;
  generatedAt: string;
  overallReadinessScore: number;
  launchGrade: string;
  deterministicScorecard: AgiReadinessDeterministicScorecardSummary;
  proofDebt: AgiReadinessProofDebt;
  blockers: AgiReadinessBlocker[];
  quickWins: string[];
  manualSteps: string[];
  repoWork: string[];
  publishStatus: AgiPublishStatus;
  recommendations: string[];
  artifactPaths?: AgiReadinessArtifacts;
  note: string;
}

export interface BuildAgiReadinessReportOptions {
  generatedAt?: string;
  scorecard: AgiScorecardResult;
  doctor: AgiReadinessDoctorReport;
  integrations: IntegrationDoctorReport;
  liveProof: LiveProofGauntletReport;
  publishStatus?: AgiPublishStatus;
}

export interface AgiReadinessArtifacts {
  dir: string;
  jsonPath: string;
  markdownPath: string;
}

const NOTE =
  'This readiness report measures bounded assistant launch readiness. It is not a claim of general intelligence.';

const OPTIONAL_INTEGRATIONS = new Set([
  'research',
  'image_generation',
  'openai',
  'anthropic',
  'gemini',
  'minimax',
  'brave',
  'google',
  'spotify',
  'notion',
  'linear',
  'github',
  'drive',
  'homeassistant',
  'web',
]);

const OUT_OF_SCOPE_UNTRACKED = [
  'AGENTS.md',
  'agi-upgrade/',
  'andrea-nanobot-agi-upgrade-transfer.tgz',
  'wikipedia-australia-maps/',
];

const SECRET_PATTERNS = [
  /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{16,}\b/g,
  /\bcrsr_[A-Za-z0-9_]{16,}\b/g,
  /\bBSA-[A-Za-z0-9_-]{10,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
];
const SECRET_ASSIGNMENT_PATTERN =
  /\b(password|token|secret|api[_-]?key)=([^;\s]+)/gi;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Number(clampScore(value).toFixed(3));
}

function gradeFor(score: number): string {
  if (score >= 0.97) return 'A+';
  if (score >= 0.93) return 'A';
  if (score >= 0.9) return 'A-';
  if (score >= 0.87) return 'B+';
  if (score >= 0.83) return 'B';
  if (score >= 0.8) return 'B-';
  if (score >= 0.7) return 'C';
  if (score >= 0.6) return 'D';
  return 'F';
}

function runIdFor(generatedAt: string): string {
  const stamp = generatedAt.replace(/[^0-9A-Za-z]+/g, '').slice(0, 14);
  return `agi-readiness-${stamp || Date.now().toString(36)}`;
}

export function redactReadinessText(value: string | null | undefined): string {
  let text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(
    SECRET_ASSIGNMENT_PATTERN,
    (_match, key: string) => `${key}=***`,
  );
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted-secret]');
  }
  return text;
}

function unique(values: string[], limit = 10): string[] {
  return Array.from(
    new Set(values.map(redactReadinessText).filter(Boolean)),
  ).slice(0, limit);
}

function dedupeBlockers(
  blockers: AgiReadinessBlocker[],
): AgiReadinessBlocker[] {
  const severityRank: Record<AgiReadinessSeverity, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  const categoryRank: Record<AgiReadinessBlockerCategory, number> = {
    repo_fix_required: 0,
    external_config_required: 1,
    manual_live_proof_required: 2,
    publish_blocked: 3,
    optional_capability_blocked: 4,
    optional_capability_unverified: 5,
  };
  const byKey = new Map<string, AgiReadinessBlocker>();
  for (const blocker of blockers) {
    const key = `${blocker.category}:${blocker.source}:${blocker.id}`;
    const existing = byKey.get(key);
    if (
      !existing ||
      severityRank[blocker.severity] < severityRank[existing.severity]
    ) {
      byKey.set(key, blocker);
    }
  }
  return Array.from(byKey.values()).sort(
    (left, right) =>
      categoryRank[left.category] - categoryRank[right.category] ||
      severityRank[left.severity] - severityRank[right.severity] ||
      left.id.localeCompare(right.id),
  );
}

function weakestDimension(scorecard: AgiScorecardResult): {
  name: string;
  score: number;
} {
  return Object.entries(scorecard.dimensionScores).sort(
    ([, left], [, right]) => left - right,
  )[0]
    ? {
        name: Object.entries(scorecard.dimensionScores).sort(
          ([, left], [, right]) => left - right,
        )[0][0],
        score: Object.entries(scorecard.dimensionScores).sort(
          ([, left], [, right]) => left - right,
        )[0][1],
      }
    : { name: 'none', score: 0 };
}

function weakestSuite(scorecard: AgiScorecardResult): {
  name: string;
  score: number;
} {
  const weakest = [...scorecard.suiteSummaries].sort(
    (left, right) => left.score - right.score,
  )[0];
  return weakest
    ? { name: weakest.suite, score: weakest.score }
    : { name: 'none', score: 0 };
}

function scorecardBlockers(
  scorecard: AgiScorecardResult,
): AgiReadinessBlocker[] {
  return scorecard.regressions.map((regression) => ({
    category: 'repo_fix_required',
    severity: 'critical',
    source: 'scorecard',
    id: regression,
    label: `Scorecard regression: ${regression}`,
    status: 'regression',
    owner: 'repo_side',
    action: 'Fix the deterministic scorecard regression before publishing.',
    detail: regression,
    blocksLaunch: true,
    blocksPublish: true,
  }));
}

function doctorBlockers(
  doctor: AgiReadinessDoctorReport,
): AgiReadinessBlocker[] {
  const blockers: AgiReadinessBlocker[] = [];
  for (const check of doctor.checks) {
    if (check.status === 'ok') continue;
    const detail = redactReadinessText(check.detail);
    if (check.name === 'model_providers') {
      blockers.push({
        category: 'external_config_required',
        severity: 'critical',
        source: 'agi_doctor',
        id: check.name,
        label: 'Model provider missing',
        status: check.status,
        owner: 'external',
        action:
          'Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or OLLAMA_BASE_URL/local Ollama before enabling AGI live channels.',
        detail,
        blocksLaunch: true,
        blocksPublish: false,
      });
      continue;
    }
    if (check.name === 'telegram_canary') {
      const activationDisabled = /ANDREA_USE_AGI is disabled/i.test(detail);
      blockers.push({
        category: activationDisabled
          ? 'manual_live_proof_required'
          : 'external_config_required',
        severity: check.status === 'fail' ? 'critical' : 'medium',
        source: 'agi_doctor',
        id: check.name,
        label: activationDisabled
          ? 'Telegram AGI canary is intentionally disabled'
          : 'Telegram AGI canary not live-ready',
        status: check.status,
        owner: activationDisabled ? 'manual' : 'external',
        action: activationDisabled
          ? 'Enable ANDREA_USE_AGI=1 only when intentionally starting the Telegram AGI canary; credential and transport health are assessed separately.'
          : 'Configure TELEGRAM_BOT_TOKEN for the enabled Telegram AGI canary.',
        detail,
        blocksLaunch: true,
        blocksPublish: false,
      });
      continue;
    }
    if (check.status === 'fail') {
      blockers.push({
        category: 'repo_fix_required',
        severity: check.name === 'state_dir' ? 'critical' : 'high',
        source: 'agi_doctor',
        id: check.name,
        label: `AGI doctor failure: ${check.name}`,
        status: check.status,
        owner: 'repo_side',
        action: `Resolve AGI doctor check ${check.name}.`,
        detail,
        blocksLaunch: true,
        blocksPublish: check.name === 'audit_chain',
      });
    }
  }
  return blockers;
}

function integrationStateScore(state: IntegrationDoctorState): number {
  switch (state) {
    case 'healthy':
      return 1;
    case 'degraded_but_usable':
      return 0.72;
    case 'near_live_only':
      return 0.62;
    case 'needs_proof':
      return 0.55;
    case 'manual_action_required':
      return 0.42;
    case 'externally_blocked':
      return 0.28;
    case 'needs_auth':
      return 0.22;
    case 'repo_fix_available':
      return 0.15;
  }
}

function isOptionalIntegration(id: string): boolean {
  return (
    OPTIONAL_INTEGRATIONS.has(id) ||
    /_(?:cloud|search)$/.test(id) ||
    /^provider_/.test(id)
  );
}

function integrationCategory(
  status: IntegrationStatus,
): AgiReadinessBlockerCategory | null {
  if (status.state === 'healthy') return null;
  if (
    status.blockerOwner === 'repo_side' ||
    status.state === 'repo_fix_available' ||
    status.repairability === 'repo_fix_available'
  ) {
    return 'repo_fix_required';
  }
  if (isOptionalIntegration(status.integrationId)) {
    if (
      status.state === 'near_live_only' &&
      status.credentialState === 'configured' &&
      status.transportState === 'unknown' &&
      !status.lastFailure
    ) {
      return 'optional_capability_unverified';
    }
    return 'optional_capability_blocked';
  }
  if (
    status.state === 'needs_auth' ||
    status.state === 'externally_blocked' ||
    status.credentialState === 'missing' ||
    status.credentialState === 'invalid'
  ) {
    return 'external_config_required';
  }
  if (
    status.state === 'manual_action_required' ||
    status.state === 'needs_proof' ||
    status.state === 'near_live_only' ||
    status.state === 'degraded_but_usable'
  ) {
    return 'manual_live_proof_required';
  }
  return null;
}

function blockerOwnerFor(
  status: IntegrationStatus,
): AgiReadinessBlocker['owner'] {
  return status.blockerOwner;
}

function integrationBlockers(
  integrations: IntegrationDoctorReport,
): AgiReadinessBlocker[] {
  const blockers: AgiReadinessBlocker[] = [];
  for (const status of integrations.statuses) {
    // This is an aggregate pseudo-integration. The readiness report already
    // receives the exact live-proof entries, so including both would duplicate
    // one proof gap as a generic blocker and an actionable blocker.
    if (status.integrationId === 'feature_proofs') continue;
    const category = integrationCategory(status);
    if (!category) continue;
    const coreLaunch =
      category !== 'optional_capability_blocked' &&
      category !== 'optional_capability_unverified';
    blockers.push({
      category,
      severity:
        category === 'repo_fix_required'
          ? 'critical'
          : category === 'external_config_required'
            ? 'high'
            : category === 'manual_live_proof_required'
              ? 'medium'
              : 'low',
      source: 'integrations',
      id: status.integrationId,
      label: status.label,
      status: status.state,
      owner: blockerOwnerFor(status),
      action:
        redactReadinessText(status.nextAction) ||
        `Refresh ${status.label} integration status.`,
      detail:
        redactReadinessText(status.lastFailure || status.detail) ||
        `${status.label} is ${status.state}.`,
      blocksLaunch: coreLaunch,
      blocksPublish: category === 'repo_fix_required',
    });
  }
  return blockers;
}

function isOptionalProof(entry: LiveProofGauntletEntry): boolean {
  return /research|image generation/i.test(entry.proofName);
}

function liveProofCategory(
  entry: LiveProofGauntletEntry,
): AgiReadinessBlockerCategory | null {
  if (entry.status === 'live_proven') return null;
  if (entry.repoWorkRequired) return 'repo_fix_required';
  if (isOptionalProof(entry)) return 'optional_capability_blocked';
  if (
    entry.status === 'missing_config' ||
    entry.status === 'externally_blocked'
  ) {
    return 'external_config_required';
  }
  return 'manual_live_proof_required';
}

function liveProofBlockers(
  liveProof: LiveProofGauntletReport,
): AgiReadinessBlocker[] {
  const blockers: AgiReadinessBlocker[] = [];
  for (const entry of liveProof.entries) {
    const category = liveProofCategory(entry);
    if (!category) continue;
    blockers.push({
      category,
      severity:
        category === 'repo_fix_required'
          ? 'critical'
          : category === 'external_config_required'
            ? 'high'
            : category === 'manual_live_proof_required'
              ? 'medium'
              : 'low',
      source: 'live_proof',
      id: entry.proofId,
      label: entry.proofName,
      status: entry.status,
      owner: entry.blockerOwner,
      action: redactReadinessText(entry.nextStep),
      detail: redactReadinessText(entry.detail),
      blocksLaunch:
        category !== 'optional_capability_blocked' &&
        category !== 'optional_capability_unverified',
      blocksPublish: category === 'repo_fix_required',
    });
  }
  return blockers;
}

function publishBlockers(status: AgiPublishStatus): AgiReadinessBlocker[] {
  return status.blockers.map((blocker, index) => ({
    category: 'publish_blocked',
    severity: /gh|auth|credential|tracked changes|commit/i.test(blocker)
      ? 'high'
      : 'medium',
    source: 'publish',
    id: `publish_${index + 1}`,
    label: 'Publish flow blocked',
    status: 'blocked',
    owner: 'external',
    action: redactReadinessText(blocker),
    detail: redactReadinessText(status.detail),
    blocksLaunch: false,
    blocksPublish: true,
  }));
}

function doctorScore(doctor: AgiReadinessDoctorReport): number {
  if (!doctor.checks.length) return 0;
  const total = doctor.checks.reduce((sum, check) => {
    if (check.status === 'ok') return sum + 1;
    if (check.status === 'warn') return sum + 0.7;
    return sum;
  }, 0);
  return roundScore(total / doctor.checks.length);
}

function integrationScore(integrations: IntegrationDoctorReport): number {
  if (!integrations.statuses.length) return 0;
  const total = integrations.statuses.reduce(
    (sum, status) => sum + integrationStateScore(status.state),
    0,
  );
  return roundScore(total / integrations.statuses.length);
}

function proofScore(liveProof: LiveProofGauntletReport): number {
  if (!liveProof.entries.length) return 0;
  return roundScore(liveProof.liveProvenCount / liveProof.entries.length);
}

function readinessScore(params: {
  scorecard: AgiScorecardResult;
  doctor: AgiReadinessDoctorReport;
  integrations: IntegrationDoctorReport;
  liveProof: LiveProofGauntletReport;
  blockers: AgiReadinessBlocker[];
}): number {
  const base =
    params.scorecard.overallScore * 0.45 +
    doctorScore(params.doctor) * 0.15 +
    integrationScore(params.integrations) * 0.2 +
    proofScore(params.liveProof) * 0.2;
  const launchCritical = params.blockers.filter(
    (blocker) => blocker.blocksLaunch && blocker.severity === 'critical',
  ).length;
  const repoBlockers = params.blockers.filter(
    (blocker) => blocker.category === 'repo_fix_required',
  ).length;
  const regressionPenalty = Math.min(
    0.18,
    params.scorecard.regressions.length * 0.06,
  );
  const launchPenalty = Math.min(0.16, launchCritical * 0.04);
  const repoPenalty = Math.min(0.18, repoBlockers * 0.05);
  return roundScore(base - regressionPenalty - launchPenalty - repoPenalty);
}

function proofDebt(liveProof: LiveProofGauntletReport): AgiReadinessProofDebt {
  return {
    liveProven: liveProof.liveProvenCount,
    total: liveProof.entries.length,
    debtCount: liveProof.proofDebtCount,
    repoWorkRequiredCount: liveProof.repoWorkRequiredCount,
    entries: liveProof.entries
      .filter((entry) => entry.status !== 'live_proven')
      .map((entry) => ({
        proofName: entry.proofName,
        status: entry.status,
        blockerOwner: entry.blockerOwner,
        repoWorkRequired: entry.repoWorkRequired,
        nextStep: redactReadinessText(entry.nextStep),
        detail: redactReadinessText(entry.detail),
      })),
  };
}

function recommendationsFor(params: {
  scorecard: AgiScorecardResult;
  blockers: AgiReadinessBlocker[];
  liveProof: LiveProofGauntletReport;
  publishStatus: AgiPublishStatus;
}): string[] {
  const recs: string[] = [];
  const repo = params.blockers.find(
    (blocker) => blocker.category === 'repo_fix_required',
  );
  const provider = params.blockers.find(
    (blocker) => blocker.id === 'model_providers',
  );
  const telegram = params.blockers.find(
    (blocker) =>
      blocker.id === 'telegram_canary' || /telegram/i.test(blocker.label),
  );
  const manual = params.blockers.find(
    (blocker) => blocker.category === 'manual_live_proof_required',
  );
  const optional = params.blockers.find(
    (blocker) => blocker.category === 'optional_capability_blocked',
  );
  const optionalUnverified = params.blockers.find(
    (blocker) => blocker.category === 'optional_capability_unverified',
  );
  const publish = params.blockers.find(
    (blocker) => blocker.category === 'publish_blocked',
  );

  if (params.scorecard.regressions.length) {
    recs.push(
      'Fix deterministic scorecard regressions before any launch or PR claim.',
    );
  }
  if (repo) recs.push(`Fix repo-side blocker: ${repo.label} - ${repo.action}`);
  if (provider) {
    recs.push(
      'Configure one model provider or local Ollama, then rerun npm run agi:doctor.',
    );
  }
  if (telegram) {
    recs.push(`Telegram canary: ${telegram.action}`);
  }
  if (manual)
    recs.push(`Complete live proof: ${manual.label} - ${manual.action}`);
  if (optional) {
    recs.push(
      `Keep optional lane honest: ${optional.label} is blocked, so do not demo it as live-proven until refreshed.`,
    );
  }
  if (optionalUnverified) {
    recs.push(
      `Optional lane not recently observed: ${optionalUnverified.label}. ${optionalUnverified.action}`,
    );
  }
  if (publish) recs.push(`Publish remains blocked: ${publish.action}`);
  recs.push(...params.scorecard.recommendations.slice(0, 2));
  if (params.liveProof.proofDebtCount > 0) {
    recs.push(
      `Next live proof step: ${redactReadinessText(params.liveProof.nextAction)}`,
    );
  }
  if (
    params.publishStatus.hasOutOfScopeUntracked &&
    params.publishStatus.ignoredUntracked.length
  ) {
    recs.push(
      `Keep out-of-scope artifacts unstaged: ${params.publishStatus.ignoredUntracked.join(', ')}.`,
    );
  }
  return unique(recs, 10);
}

function defaultPublishStatus(): AgiPublishStatus {
  return {
    branch: 'unknown',
    remote: null,
    aheadBy: 0,
    hasTrackedChanges: false,
    hasOutOfScopeUntracked: false,
    ignoredUntracked: [],
    ghCliInstalled: false,
    ghAuthenticated: false,
    pushReady: false,
    prReady: false,
    blockers: ['Publish status was not collected.'],
    detail: 'No publish status was supplied to the readiness builder.',
  };
}

function sanitizePublishStatus(status: AgiPublishStatus): AgiPublishStatus {
  return {
    ...status,
    remote: status.remote ? redactReadinessText(status.remote) : null,
    ignoredUntracked: status.ignoredUntracked.map(redactReadinessText),
    blockers: status.blockers.map(redactReadinessText),
    detail: redactReadinessText(status.detail),
  };
}

export function buildAgiReadinessReport(
  opts: BuildAgiReadinessReportOptions,
): AgiReadinessReport {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const publishStatus = sanitizePublishStatus(
    opts.publishStatus ?? defaultPublishStatus(),
  );
  const dimension = weakestDimension(opts.scorecard);
  const suite = weakestSuite(opts.scorecard);
  const blockers = dedupeBlockers([
    ...scorecardBlockers(opts.scorecard),
    ...doctorBlockers(opts.doctor),
    ...integrationBlockers(opts.integrations),
    ...liveProofBlockers(opts.liveProof),
    ...publishBlockers(publishStatus),
  ]);
  const overallReadinessScore = readinessScore({
    scorecard: opts.scorecard,
    doctor: opts.doctor,
    integrations: opts.integrations,
    liveProof: opts.liveProof,
    blockers,
  });
  const repoWork = blockers
    .filter((blocker) => blocker.category === 'repo_fix_required')
    .map((blocker) => `${blocker.label}: ${blocker.action}`);
  const manualSteps = blockers
    .filter((blocker) =>
      [
        'external_config_required',
        'manual_live_proof_required',
        'publish_blocked',
      ].includes(blocker.category),
    )
    .map((blocker) => `${blocker.label}: ${blocker.action}`);
  const quickWins = blockers
    .filter((blocker) => blocker.category !== 'repo_fix_required')
    .slice(0, 6)
    .map((blocker) => `${blocker.label}: ${blocker.action}`);

  return {
    runId: runIdFor(generatedAt),
    generatedAt,
    overallReadinessScore,
    launchGrade: gradeFor(overallReadinessScore),
    deterministicScorecard: {
      overallScore: opts.scorecard.overallScore,
      grade: opts.scorecard.grade,
      regressions: opts.scorecard.regressions,
      weaknesses: opts.scorecard.weaknesses,
      weakestDimension: dimension.name,
      weakestDimensionScore: dimension.score,
      weakestSuite: suite.name,
      weakestSuiteScore: suite.score,
      recommendations: opts.scorecard.recommendations,
    },
    proofDebt: proofDebt(opts.liveProof),
    blockers,
    quickWins: unique(quickWins, 8),
    manualSteps: unique(manualSteps, 10),
    repoWork: unique(repoWork, 8),
    publishStatus,
    recommendations: recommendationsFor({
      scorecard: opts.scorecard,
      blockers,
      liveProof: opts.liveProof,
      publishStatus,
    }),
    note: NOTE,
  };
}

export function formatAgiReadinessMarkdown(report: AgiReadinessReport): string {
  const lines: string[] = [
    '# Andrea AGI Live Readiness',
    '',
    `Generated: ${report.generatedAt}`,
    `Overall readiness: ${(report.overallReadinessScore * 100).toFixed(1)}% (${report.launchGrade})`,
    `Deterministic scorecard: ${(report.deterministicScorecard.overallScore * 100).toFixed(1)}% (${report.deterministicScorecard.grade})`,
    `Live proof: ${report.proofDebt.liveProven}/${report.proofDebt.total} proven; ${report.proofDebt.debtCount} debt item(s)`,
    '',
    '## Blockers',
  ];
  if (!report.blockers.length) {
    lines.push('- none');
  } else {
    for (const blocker of report.blockers.slice(0, 30)) {
      lines.push(
        `- [${blocker.category}/${blocker.severity}] ${blocker.label}: ${blocker.action}`,
      );
    }
  }

  lines.push('', '## Repo Work');
  if (!report.repoWork.length) {
    lines.push('- none');
  } else {
    lines.push(...report.repoWork.map((item) => `- ${item}`));
  }

  lines.push('', '## Manual / External Steps');
  if (!report.manualSteps.length) {
    lines.push('- none');
  } else {
    lines.push(...report.manualSteps.map((item) => `- ${item}`));
  }

  lines.push('', '## Publish Status');
  lines.push(`- Branch: ${report.publishStatus.branch}`);
  lines.push(`- Ahead by: ${report.publishStatus.aheadBy}`);
  lines.push(
    `- GitHub CLI: ${report.publishStatus.ghCliInstalled ? 'installed' : 'missing'}, auth=${report.publishStatus.ghAuthenticated ? 'ok' : 'blocked'}`,
  );
  if (report.publishStatus.blockers.length) {
    for (const blocker of report.publishStatus.blockers) {
      lines.push(`- ${redactReadinessText(blocker)}`);
    }
  } else {
    lines.push('- publish path appears clear');
  }

  lines.push('', '## Recommendations');
  for (const recommendation of report.recommendations) {
    lines.push(`- ${recommendation}`);
  }

  lines.push('', `Note: ${report.note}`);
  return `${lines.join('\n')}\n`;
}

export async function writeAgiReadinessArtifacts(
  report: AgiReadinessReport,
  opts: { stateDir?: string } = {},
): Promise<AgiReadinessArtifacts> {
  const stateDir = expandHome(
    opts.stateDir ?? process.env.ANDREA_STATE_DIR ?? join(homedir(), '.andrea'),
  );
  const dir = join(stateDir, 'evals', report.runId);
  const jsonPath = join(dir, 'readiness.json');
  const markdownPath = join(dir, 'readiness.md');
  await mkdir(dir, { recursive: true });
  const artifactPaths = { dir, jsonPath, markdownPath };
  const withArtifacts = { ...report, artifactPaths };
  await writeFile(
    jsonPath,
    `${JSON.stringify(withArtifacts, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    markdownPath,
    formatAgiReadinessMarkdown(withArtifacts),
    'utf8',
  );
  return artifactPaths;
}

export function collectPublishStatus(
  opts: {
    cwd?: string;
    knownOutOfScope?: string[];
    commandRunner?: (
      command: string,
      args: string[],
      cwd: string,
    ) => OptionalCommandResult;
  } = {},
): AgiPublishStatus {
  const cwd = opts.cwd ?? process.cwd();
  const knownOutOfScope = opts.knownOutOfScope ?? OUT_OF_SCOPE_UNTRACKED;
  const commandRunner = opts.commandRunner ?? runOptional;
  const branch =
    commandRunner('git', ['branch', '--show-current'], cwd).stdout || 'unknown';
  const remoteResult = commandRunner(
    'git',
    ['remote', 'get-url', 'origin'],
    cwd,
  );
  const remote = remoteResult.ok ? remoteResult.stdout : null;
  const aheadBy = parseAheadCount(cwd, commandRunner);
  const status = commandRunner('git', ['status', '--short'], cwd)
    .stdout.split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const trackedChanges = status.filter((line) => !line.startsWith('??'));
  const untracked = status
    .filter((line) => line.startsWith('??'))
    .map((line) => line.replace(/^\?\?\s+/, ''));
  const ignoredUntracked = untracked.filter((path) =>
    knownOutOfScope.some((known) => path === known || path.startsWith(known)),
  );
  const unexpectedUntracked = untracked.filter(
    (path) => !ignoredUntracked.includes(path),
  );
  const ghVersion = commandRunner('gh', ['--version'], cwd);
  const ghAuth = ghVersion.ok
    ? commandRunner('gh', ['auth', 'status'], cwd)
    : ghVersion;
  const blockers: string[] = [];
  if (
    (branch === 'main' || branch === 'master') &&
    (aheadBy > 0 || trackedChanges.length > 0 || unexpectedUntracked.length > 0)
  ) {
    blockers.push('Create or switch to a codex/* branch before publishing.');
  }
  if (trackedChanges.length || unexpectedUntracked.length) {
    blockers.push(
      'Commit or explicitly exclude intended working-tree changes before publishing.',
    );
  }
  if (!ghVersion.ok)
    blockers.push('Install GitHub CLI `gh` before opening a PR.');
  if (ghVersion.ok && !ghAuth.ok) {
    blockers.push(
      'Authenticate GitHub CLI with `gh auth login` before push/PR.',
    );
  }
  if (!remote) blockers.push('Configure an origin remote before publishing.');

  const pushReady = blockers.length === 0 && aheadBy > 0;
  return {
    branch,
    remote,
    aheadBy,
    hasTrackedChanges:
      trackedChanges.length > 0 || unexpectedUntracked.length > 0,
    hasOutOfScopeUntracked: ignoredUntracked.length > 0,
    ignoredUntracked,
    ghCliInstalled: ghVersion.ok,
    ghAuthenticated: ghVersion.ok && ghAuth.ok,
    pushReady,
    prReady: pushReady,
    blockers: unique(blockers, 8),
    detail: redactReadinessText(
      [
        `branch=${branch}`,
        `ahead=${aheadBy}`,
        `trackedChanges=${trackedChanges.length}`,
        `unexpectedUntracked=${unexpectedUntracked.length}`,
        `ignoredUntracked=${ignoredUntracked.length}`,
      ].join(' '),
    ),
  };
}

function parseAheadCount(
  cwd: string,
  commandRunner: (
    command: string,
    args: string[],
    cwd: string,
  ) => OptionalCommandResult = runOptional,
): number {
  const originMain = commandRunner(
    'git',
    ['rev-list', '--left-right', '--count', 'origin/main...HEAD'],
    cwd,
  );
  if (originMain.ok) {
    const [, ahead] = originMain.stdout.split(/\s+/).map(Number);
    return Number.isFinite(ahead) ? ahead : 0;
  }
  const upstream = commandRunner(
    'git',
    ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
    cwd,
  );
  if (!upstream.ok) return 0;
  const [, ahead] = upstream.stdout.split(/\s+/).map(Number);
  return Number.isFinite(ahead) ? ahead : 0;
}

interface OptionalCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runOptional(
  command: string,
  args: string[],
  cwd: string,
): OptionalCommandResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
    // Publish readiness probes must stay best-effort: missing git/gh/auth is
    // reported in the readiness JSON instead of crashing the whole command.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (err) {
    const error = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      message?: string;
    };
    return {
      ok: false,
      stdout: Buffer.isBuffer(error.stdout)
        ? error.stdout.toString('utf8').trim()
        : String(error.stdout || '').trim(),
      stderr: Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8').trim()
        : String(error.stderr || error.message || '').trim(),
    };
  }
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
