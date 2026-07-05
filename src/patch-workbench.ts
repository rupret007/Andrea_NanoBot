import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildShadowImprovementReport } from './shadow-improvement-runner.js';
import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listCandidatePatchPlans,
  upsertCandidatePatchPlan,
  upsertImprovementHypothesis,
  upsertPatchAttempt,
  upsertPatchReview,
  upsertPatchWorkspace,
} from './db.js';
import type {
  CandidatePatchPlan,
  ImprovementHypothesis,
  PatchAttempt,
  PatchReview,
  PatchWorkspace,
  ShadowPatchReport,
} from './types.js';

export type PatchWorkbenchMode =
  | 'dry_run'
  | 'prepare_workspace'
  | 'apply_low_risk';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
  providerDebatesStored: false,
  rawToolOutputStored: false,
} as const;

export const PATCH_WORKBENCH_POLICY = {
  defaultMode: 'dry_run',
  createsBranchesOrWorktreesByDefault: false,
  appliesProductBehaviorPatchesByDefault: false,
  mergesOrPushes: false,
  restartsServices: false,
  mutatesLiveIntegrations: false,
  autoSendsMessages: false,
  autoWritesCalendars: false,
  allowedCategories: [
    'docs',
    'debug/status copy',
    'eval additions',
    'harmless wording',
    'synthetic-gauntlet scoring/report formatting',
    'operator report formatting',
    'proof-debt wording clarity',
  ],
  blockedCategories: [
    'message sending',
    'calendar writes',
    'credential/auth',
    'service restart/deploy',
    'destructive actions',
    'privacy/memory behavior',
    'runtime execution behavior',
    'approval gates',
  ],
} as const;

export interface PatchWorkbenchGitSafety {
  ok: boolean;
  branch: string;
  head: string;
  clean: boolean;
  blocker: string;
  nextAction: string;
}

export interface PatchPlanSafetyDecision {
  allowed: boolean;
  approvalRequired: boolean;
  safetyResult: PatchAttempt['safetyResult'];
  reason: string;
  allowedFiles: string[];
  disallowedFiles: string[];
}

export interface PatchWorkbenchReport {
  generatedAt: string;
  mode: PatchWorkbenchMode;
  gitSafety: PatchWorkbenchGitSafety;
  shadowRunId: string;
  workspaces: PatchWorkspace[];
  attempts: PatchAttempt[];
  reviews: PatchReview[];
  selectedHypotheses: ImprovementHypothesis[];
  patchReports: ShadowPatchReport[];
  externalProofDebt: ImprovementHypothesis[];
  policy: typeof PATCH_WORKBENCH_POLICY;
  nextAction: string;
  privacy: typeof PRIVACY;
}

export interface DetachedRepairVerificationCommand {
  command: string;
  args: string[];
  label?: string;
}

export interface DetachedRepairExecutorPolicy {
  killSwitchEnvVar: string;
  maxFilesChanged: number;
  maxChangedLines: number;
  commandTimeoutMs: number;
  sensitivePathPatterns: string[];
  dangerousDiffPatterns: string[];
  allowedVerificationCommands: DetachedRepairVerificationCommand[];
}

export interface DetachedRepairExecutionResult {
  status: 'committed' | 'rolled_back' | 'blocked';
  branchName: string;
  baseRef: string;
  workspacePath: string;
  commitHash: string | null;
  filesChanged: string[];
  changedLines: number;
  verificationResults: Array<{
    label: string;
    command: string;
    ok: boolean;
    detail: string;
  }>;
  rollbackApplied: boolean;
  reason: string;
}

export interface DetachedRepairExecutionInput {
  repoRoot: string;
  branchName: string;
  diffText: string;
  verificationCommands: DetachedRepairVerificationCommand[];
  commitMessage: string;
  baseRef?: string;
  approved?: boolean;
  keepWorkspace?: boolean;
  policy?: Partial<DetachedRepairExecutorPolicy>;
}

export interface DetachedRepairOperatorExecutionInput extends DetachedRepairExecutionInput {
  persist?: boolean;
  now?: Date;
  operatorLabel?: string;
}

export interface DetachedRepairOperatorExecutionReport {
  generatedAt: string;
  persisted: boolean;
  result: DetachedRepairExecutionResult;
  hypothesis: ImprovementHypothesis;
  patchPlan: CandidatePatchPlan;
  workspace: PatchWorkspace;
  attempt: PatchAttempt;
  review: PatchReview;
  nextAction: string;
  privacy: typeof PRIVACY;
}

const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|BSA-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{16,}|crsr_[A-Za-z0-9_]{16,}|\b\d{7,}:[A-Za-z0-9_-]{20,}|password[:=]|secret[:=]|raw private body|hidden reasoning|chain[- ]of[- ]thought|provider debate|raw tool output/i;

const DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY: DetachedRepairExecutorPolicy = {
  killSwitchEnvVar: 'ANDREA_REPAIR_EXECUTOR_DISABLED',
  maxFilesChanged: 8,
  maxChangedLines: 300,
  commandTimeoutMs: 600_000,
  sensitivePathPatterns: [
    '.env',
    '.env.*',
    'repo-tokens/**',
    'data/**',
    'store/**',
    'src/channels/**',
    'src/google-calendar*.ts',
    'src/message-actions.ts',
    'src/integration-healer.ts',
    'scripts/nanoclaw-host.ps1',
    'scripts/andrea-startup.ps1',
    'package-lock.json',
  ],
  dangerousDiffPatterns: [
    '\\b(?:sendMessage|sendTelegramMessage|sendBlueBubblesMessage)\\b',
    '\\b(?:createGoogleCalendarEvent|updateGoogleCalendarEvent|deleteGoogleCalendarEvent|moveGoogleCalendarEvent)\\b',
    '\\b(?:process\\.env\\.[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)|password\\s*[:=]|secret\\s*[:=])',
    '\\b(?:execSync|execFileSync|spawnSync)\\b[\\s\\S]{0,120}\\b(?:rm\\s+-rf|git\\s+reset|git\\s+push|launchctl|powershell|curl)\\b',
    '\\b(?:approvalRequired\\s*:\\s*false|autoSendsMessages\\s*:\\s*true|autoWritesCalendars\\s*:\\s*true)\\b',
  ],
  allowedVerificationCommands: [
    {
      command: 'npm',
      args: ['run', 'test:patch-workbench'],
    },
    {
      command: 'npm',
      args: ['run', 'test:shadow-improvement'],
    },
    {
      command: 'npm',
      args: ['run', 'test:synthetic-gauntlet'],
    },
  ],
};

function nowIso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${crypto
    .createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 24)}`;
}

function safeText(value: string | null | undefined, limit = 900): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (SECRET_RE.test(text)) return '[redacted patch workbench metadata]';
  return redactCouncilText(text, limit);
}

function safeJson(value: unknown, limit = 3200): string {
  try {
    const json = JSON.stringify(value ?? null);
    return safeText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            preview: json.slice(0, Math.max(32, limit - 120)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function privacyJson(): string {
  return safeJson(PRIVACY, 1200);
}

function parseJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'candidate'
  );
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitWithInput(repoRoot: string, args: string[], input: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commandKey(command: DetachedRepairVerificationCommand): string {
  return [command.command, ...command.args].join('\0');
}

function mergeDetachedRepairPolicy(
  policy: Partial<DetachedRepairExecutorPolicy> = {},
): DetachedRepairExecutorPolicy {
  return {
    ...DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY,
    ...policy,
    sensitivePathPatterns:
      policy.sensitivePathPatterns ||
      DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY.sensitivePathPatterns,
    dangerousDiffPatterns:
      policy.dangerousDiffPatterns ||
      DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY.dangerousDiffPatterns,
    allowedVerificationCommands:
      policy.allowedVerificationCommands ||
      DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY.allowedVerificationCommands,
  };
}

function envFlagEnabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(process.env[name] || '')
      .trim()
      .toLowerCase(),
  );
}

function policyPatternMatches(pathname: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    return pathname.startsWith(pattern.slice(0, -2));
  }
  if (pattern.endsWith('*')) {
    return pathname.startsWith(pattern.slice(0, -1));
  }
  return pathname === pattern;
}

function parseDiffFiles(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) {
      files.add(match[1]);
      files.add(match[2]);
      continue;
    }
    const pathMatch = /^(?:---|\+\+\+) (?:a|b)\/(.+)$/.exec(line);
    if (pathMatch) files.add(pathMatch[1]);
  }
  return [...files].filter((file) => file !== '/dev/null').sort();
}

function countDiffChangedLines(diffText: string): number {
  return diffText
    .split(/\r?\n/)
    .filter(
      (line) =>
        /^[+-]/.test(line) &&
        !line.startsWith('+++') &&
        !line.startsWith('---'),
    ).length;
}

function compactError(error: unknown): string {
  if (error instanceof Error) return safeText(error.message, 600);
  return safeText(String(error), 600);
}

function blockedDetachedRepairResult(params: {
  branchName: string;
  baseRef: string;
  workspacePath: string;
  reason: string;
  filesChanged?: string[];
  changedLines?: number;
}): DetachedRepairExecutionResult {
  return {
    status: 'blocked',
    branchName: params.branchName,
    baseRef: params.baseRef,
    workspacePath: params.workspacePath,
    commitHash: null,
    filesChanged: params.filesChanged || [],
    changedLines: params.changedLines || 0,
    verificationResults: [],
    rollbackApplied: false,
    reason: params.reason,
  };
}

function removeRepairWorktree(params: {
  repoRoot: string;
  workspacePath: string;
  branchName: string;
  deleteBranch: boolean;
}): boolean {
  let removed = false;
  try {
    if (fs.existsSync(params.workspacePath)) {
      execFileSync(
        'git',
        ['worktree', 'remove', '--force', params.workspacePath],
        {
          cwd: params.repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    }
    removed = true;
  } catch {
    removed = false;
  }
  if (params.deleteBranch) {
    try {
      execFileSync('git', ['branch', '-D', params.branchName], {
        cwd: params.repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // Best-effort cleanup only; the result still reports whether the worktree was removed.
    }
  }
  return removed;
}

export function evaluateGitSafety(
  repoRoot = process.cwd(),
): PatchWorkbenchGitSafety {
  try {
    const branch = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const head = git(repoRoot, ['rev-parse', 'HEAD']);
    const status = git(repoRoot, ['status', '--porcelain']);
    const clean = status.length === 0;
    if (branch !== 'main') {
      return {
        ok: false,
        branch,
        head,
        clean,
        blocker: 'not_on_main',
        nextAction:
          'Return to a clean main branch before preparing an improvement workspace.',
      };
    }
    if (!clean) {
      return {
        ok: false,
        branch,
        head,
        clean,
        blocker: 'dirty_main',
        nextAction:
          'Commit, stash, or discard unrelated work before preparing an improvement workspace.',
      };
    }
    return {
      ok: true,
      branch,
      head,
      clean,
      blocker: 'none',
      nextAction:
        'Main is clean; an explicitly requested candidate workspace can be prepared.',
    };
  } catch (error) {
    return {
      ok: false,
      branch: 'unknown',
      head: 'unknown',
      clean: false,
      blocker: 'git_unavailable',
      nextAction: `Inspect git manually before preparing an improvement workspace: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function defaultAllowedFiles(): string[] {
  return [
    'docs/**',
    'scripts/debug-*.ts',
    'scripts/test-*.ts',
    'scripts/test-synthetic-gauntlet.ts',
    'scripts/test-shadow-improvement.ts',
    'src/shadow-improvement-runner.ts',
    'src/patch-workbench.ts',
    'src/live-proof-gauntlet.ts',
  ];
}

function defaultDisallowedFiles(): string[] {
  return [
    '.env',
    '.env.*',
    'src/index.ts',
    'src/channels/**',
    'src/google-calendar*.ts',
    'src/message-actions.ts',
    'src/integration-healer.ts',
    'src/tool-reliability.ts',
    'src/critic-agent.ts',
    'scripts/nanoclaw-host.ps1',
    'scripts/andrea-startup.ps1',
    'package-lock.json',
  ];
}

function fileMatchesAllowed(pathname: string): boolean {
  return (
    pathname.startsWith('docs/') ||
    /^scripts\/(?:debug-|test-).+\.ts$/.test(pathname) ||
    pathname === 'src/shadow-improvement-runner.ts' ||
    pathname === 'src/patch-workbench.ts' ||
    pathname === 'src/live-proof-gauntlet.ts'
  );
}

function fileMatchesBlocked(pathname: string): boolean {
  return (
    pathname.startsWith('.env') ||
    pathname === 'src/index.ts' ||
    pathname.startsWith('src/channels/') ||
    /^src\/google-calendar/.test(pathname) ||
    pathname === 'src/message-actions.ts' ||
    pathname === 'src/integration-healer.ts' ||
    pathname === 'src/tool-reliability.ts' ||
    pathname === 'src/critic-agent.ts' ||
    pathname === 'package-lock.json' ||
    pathname.endsWith('.ps1')
  );
}

export function evaluatePatchPlanSafety(
  plan: CandidatePatchPlan | null,
  hypothesis: ImprovementHypothesis,
  filesChanged: string[] = plan
    ? parseJsonArray(plan.filesLikelyAffectedJson)
    : [],
): PatchPlanSafetyDecision {
  const blockedFiles = filesChanged.filter(fileMatchesBlocked);
  const notAllowedFiles = filesChanged.filter(
    (file) => !fileMatchesAllowed(file),
  );
  const riskyText =
    `${hypothesis.affectedCapability} ${hypothesis.title} ${hypothesis.nextAction} ${plan?.changeIntent || ''}`.toLowerCase();
  if (hypothesis.externalBlocker) {
    return {
      allowed: false,
      approvalRequired: true,
      safetyResult: 'warn',
      reason:
        'External proof or config debt cannot be converted into an automatic repo patch.',
      allowedFiles: defaultAllowedFiles(),
      disallowedFiles: defaultDisallowedFiles(),
    };
  }
  if (
    hypothesis.riskLevel !== 'low' ||
    /send|calendar write|credential|auth|restart|deploy|delete|purchase|approval gate|private memory|runtime execution/.test(
      riskyText,
    )
  ) {
    return {
      allowed: false,
      approvalRequired: true,
      safetyResult: 'warn',
      reason:
        'This candidate touches behavior that requires explicit approval before patching.',
      allowedFiles: defaultAllowedFiles(),
      disallowedFiles: defaultDisallowedFiles(),
    };
  }
  if (blockedFiles.length || notAllowedFiles.length) {
    return {
      allowed: false,
      approvalRequired: true,
      safetyResult: 'warn',
      reason: `Likely affected files are outside the default low-risk allowlist: ${[
        ...blockedFiles,
        ...notAllowedFiles,
      ]
        .slice(0, 5)
        .join(', ')}`,
      allowedFiles: defaultAllowedFiles(),
      disallowedFiles: defaultDisallowedFiles(),
    };
  }
  return {
    allowed: true,
    approvalRequired: false,
    safetyResult: 'pass',
    reason:
      'Patch plan is low risk, repo-side, testable, and limited to docs/debug/eval/reporting files.',
    allowedFiles: defaultAllowedFiles(),
    disallowedFiles: defaultDisallowedFiles(),
  };
}

function workspaceFor(params: {
  hypothesis: ImprovementHypothesis;
  plan: CandidatePatchPlan | null;
  generatedAt: string;
  baseCommit: string;
  status: PatchWorkspace['status'];
  workspacePath?: string | null;
}): PatchWorkspace {
  const workspaceId = hashId(
    'patch-workspace',
    `${params.hypothesis.hypothesisId}|${params.plan?.patchPlanId || 'none'}`,
  );
  const shortId = workspaceId.split(':')[1]?.slice(0, 8) || 'candidate';
  const branchName = `codex/improvement/${slug(
    params.hypothesis.affectedCapability,
  )}-${shortId}`;
  return {
    workspaceId,
    hypothesisId: params.hypothesis.hypothesisId,
    patchPlanId: params.plan?.patchPlanId || null,
    branchName,
    baseCommit: params.baseCommit,
    status: params.status,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    riskLevel: params.hypothesis.riskLevel,
    allowedFilesJson: safeJson(defaultAllowedFiles(), 2400),
    disallowedFilesJson: safeJson(defaultDisallowedFiles(), 2400),
    workspacePath: params.workspacePath || null,
    policyJson: safeJson(PATCH_WORKBENCH_POLICY, 2400),
    privacyJson: privacyJson(),
  };
}

function attemptFor(params: {
  workspace: PatchWorkspace;
  plan: CandidatePatchPlan | null;
  report: ShadowPatchReport;
  generatedAt: string;
  filesChanged: string[];
  diffSummary: string;
  safety: PatchPlanSafetyDecision;
  status: PatchAttempt['status'];
}): PatchAttempt {
  return {
    attemptId: hashId(
      'patch-attempt',
      `${params.workspace.workspaceId}|${params.report.reportId}`,
    ),
    workspaceId: params.workspace.workspaceId,
    patchPlanId: params.plan?.patchPlanId || null,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    filesChangedJson: safeJson(params.filesChanged, 2400),
    diffSummary: safeText(params.diffSummary, 1200),
    testsRunJson: safeJson(
      [
        'npm run test:synthetic-gauntlet',
        'npm run test:shadow-improvement',
        'npm run test:patch-workbench',
      ],
      2400,
    ),
    beforeScore: params.report.baselineScore,
    afterScore: params.report.candidateScore,
    regressionsJson: params.report.regressionFlagsJson,
    safetyResult: params.safety.safetyResult,
    status: params.status,
    privacyJson: privacyJson(),
  };
}

function reviewFor(params: {
  attempt: PatchAttempt;
  safety: PatchPlanSafetyDecision;
  generatedAt: string;
  report: ShadowPatchReport;
  mode: PatchWorkbenchMode;
}): PatchReview {
  const hasRegression = params.report.outcome === 'regressed';
  const recommendation: PatchReview['recommendation'] = hasRegression
    ? 'reject'
    : params.safety.allowed && params.mode === 'apply_low_risk'
      ? 'request_approval'
      : params.safety.allowed
        ? 'keep_branch'
        : 'request_approval';
  return {
    reviewId: hashId('patch-review', params.attempt.attemptId),
    attemptId: params.attempt.attemptId,
    createdAt: params.generatedAt,
    recommendation,
    approvalRequired:
      recommendation !== 'reject' || params.safety.approvalRequired,
    rollbackPlan:
      'If a candidate worktree exists, run `git worktree remove <path>` and delete the local candidate branch after review.',
    mergeReadiness: hasRegression
      ? 'blocked'
      : params.safety.allowed && params.mode === 'apply_low_risk'
        ? 'ready_after_approval'
        : 'not_ready',
    reviewerNotes: safeText(
      `${params.safety.reason} Shadow outcome=${params.report.outcome}; delta=${params.report.scoreDelta.toFixed(
        2,
      )}. No push or mainline merge is authorized by this workbench.`,
      1200,
    ),
    privacyJson: privacyJson(),
  };
}

function worktreeRoot(repoRoot: string): string {
  return path.join(
    path.dirname(repoRoot),
    `${path.basename(repoRoot)}-improvement-worktrees`,
  );
}

/**
 * Fresh worktrees share the base repo's git history but not its untracked
 * dependency install, so npm-based verification commands would fail on a
 * missing ./node_modules. Link the base repo's install into the worktree for
 * the duration of verification only: a `node_modules/` gitignore pattern does
 * not match a symlink, so the link must be gone before clean-status checks.
 */
function linkNodeModulesIntoWorktree(
  repoRoot: string,
  workspacePath: string,
): void {
  const source = path.join(repoRoot, 'node_modules');
  const target = path.join(workspacePath, 'node_modules');
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.symlinkSync(source, target, 'dir');
}

function unlinkNodeModulesFromWorktree(workspacePath: string): void {
  const target = path.join(workspacePath, 'node_modules');
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function prepareWorktree(params: {
  repoRoot: string;
  workspace: PatchWorkspace;
}): string {
  const root = worktreeRoot(params.repoRoot);
  fs.mkdirSync(root, { recursive: true });
  const workspacePath = path.join(
    root,
    params.workspace.workspaceId.replace(/[^A-Za-z0-9_-]+/g, '_'),
  );
  if (!fs.existsSync(workspacePath)) {
    execFileSync(
      'git',
      [
        'worktree',
        'add',
        '-b',
        params.workspace.branchName,
        workspacePath,
        params.workspace.baseCommit,
      ],
      { cwd: params.repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }
  return workspacePath;
}

export function executeDetachedRepairCandidate(
  input: DetachedRepairExecutionInput,
): DetachedRepairExecutionResult {
  const policy = mergeDetachedRepairPolicy(input.policy);
  const repoRoot = path.resolve(input.repoRoot);
  const baseRef = input.baseRef || 'HEAD';
  const branchName = input.branchName;
  const workspaceId = hashId(
    'repair-exec',
    `${repoRoot}|${branchName}|${baseRef}|${input.diffText}`,
  ).replace(/[^A-Za-z0-9_-]+/g, '_');
  const workspacePath = path.join(worktreeRoot(repoRoot), workspaceId);
  const filesChanged = parseDiffFiles(input.diffText);
  const changedLines = countDiffChangedLines(input.diffText);

  if (!input.approved) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: 'Detached repair execution requires explicit approval.',
    });
  }
  if (envFlagEnabled(policy.killSwitchEnvVar)) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Kill switch ${policy.killSwitchEnvVar} is enabled.`,
    });
  }
  if (!input.diffText.trim()) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      reason: 'No diff was provided.',
    });
  }
  if (!/^codex\/(?:improvement|repair)\//.test(branchName)) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason:
        'Detached repair execution only creates candidate branches under codex/improvement/* or codex/repair/*.',
    });
  }
  if (filesChanged.length > policy.maxFilesChanged) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Diff changes ${filesChanged.length} files, over the limit of ${policy.maxFilesChanged}.`,
    });
  }
  if (changedLines > policy.maxChangedLines) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Diff changes ${changedLines} lines, over the limit of ${policy.maxChangedLines}.`,
    });
  }
  const sensitiveFiles = filesChanged.filter((file) =>
    policy.sensitivePathPatterns.some((pattern) =>
      policyPatternMatches(file, pattern),
    ),
  );
  if (sensitiveFiles.length) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Diff touches sensitive paths: ${sensitiveFiles.slice(0, 5).join(', ')}.`,
    });
  }
  const dangerousPattern = policy.dangerousDiffPatterns.find((pattern) =>
    new RegExp(pattern, 'i').test(input.diffText),
  );
  if (dangerousPattern) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Diff matched a dangerous-change policy: ${dangerousPattern}.`,
    });
  }

  const allowedCommandKeys = new Set(
    policy.allowedVerificationCommands.map(commandKey),
  );
  const disallowedCommand = input.verificationCommands.find(
    (command) => !allowedCommandKeys.has(commandKey(command)),
  );
  if (disallowedCommand) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Verification command is not allowlisted: ${[
        disallowedCommand.command,
        ...disallowedCommand.args,
      ].join(' ')}`,
    });
  }

  try {
    const rootStatus = git(repoRoot, ['status', '--porcelain']);
    if (rootStatus) {
      return blockedDetachedRepairResult({
        branchName,
        baseRef,
        workspacePath,
        filesChanged,
        changedLines,
        reason:
          'Base repository must be clean before detached repair execution.',
      });
    }
    fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
    execFileSync(
      'git',
      ['worktree', 'add', '-b', branchName, workspacePath, baseRef],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    return blockedDetachedRepairResult({
      branchName,
      baseRef,
      workspacePath,
      filesChanged,
      changedLines,
      reason: `Could not prepare detached worktree: ${compactError(error)}`,
    });
  }

  const verificationResults: DetachedRepairExecutionResult['verificationResults'] =
    [];
  try {
    try {
      gitWithInput(workspacePath, ['apply', '--index', '-'], input.diffText);
    } catch {
      gitWithInput(
        workspacePath,
        ['apply', '--3way', '--index', '-'],
        input.diffText,
      );
    }

    const stagedFiles = git(workspacePath, ['diff', '--cached', '--name-only'])
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
    const unexpectedFiles = stagedFiles.filter(
      (file) => !filesChanged.includes(file),
    );
    if (unexpectedFiles.length) {
      throw new Error(
        `Applied diff touched unexpected files: ${unexpectedFiles.join(', ')}`,
      );
    }

    linkNodeModulesIntoWorktree(repoRoot, workspacePath);
    try {
      for (const command of input.verificationCommands) {
        const label =
          command.label || [command.command, ...command.args].join(' ');
        try {
          execFileSync(command.command, command.args, {
            cwd: workspacePath,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: policy.commandTimeoutMs,
          });
          verificationResults.push({
            label,
            command: [command.command, ...command.args].join(' '),
            ok: true,
            detail: 'passed',
          });
        } catch (error) {
          verificationResults.push({
            label,
            command: [command.command, ...command.args].join(' '),
            ok: false,
            detail: compactError(error),
          });
          throw new Error(`Verification failed: ${label}`, { cause: error });
        }
      }
    } finally {
      unlinkNodeModulesFromWorktree(workspacePath);
    }

    const preCommitStatus = git(workspacePath, ['status', '--porcelain']);
    const unsafeStatus = preCommitStatus
      .split(/\r?\n/)
      .filter(Boolean)
      .some((line) => line.startsWith('??') || line[1] !== ' ');
    if (unsafeStatus) {
      throw new Error(
        `Verification left unstaged or untracked workspace changes: ${preCommitStatus}`,
      );
    }

    git(workspacePath, ['commit', '-m', input.commitMessage]);
    const finalStatus = git(workspacePath, ['status', '--porcelain']);
    if (finalStatus) {
      throw new Error(`Workspace is dirty after commit: ${finalStatus}`);
    }
    const commitHash = git(workspacePath, ['rev-parse', 'HEAD']);
    if (!input.keepWorkspace) {
      removeRepairWorktree({
        repoRoot,
        workspacePath,
        branchName,
        deleteBranch: false,
      });
    }
    return {
      status: 'committed',
      branchName,
      baseRef,
      workspacePath,
      commitHash,
      filesChanged,
      changedLines,
      verificationResults,
      rollbackApplied: false,
      reason:
        'Detached repair candidate committed on its isolated branch; no merge or push was performed.',
    };
  } catch (error) {
    const removed = removeRepairWorktree({
      repoRoot,
      workspacePath,
      branchName,
      deleteBranch: true,
    });
    return {
      status: 'rolled_back',
      branchName,
      baseRef,
      workspacePath,
      commitHash: null,
      filesChanged,
      changedLines,
      verificationResults,
      rollbackApplied: removed,
      reason: compactError(error),
    };
  }
}

function buildDetachedRepairOperatorRecords(params: {
  input: DetachedRepairOperatorExecutionInput;
  result: DetachedRepairExecutionResult;
  generatedAt: string;
}): {
  hypothesis: ImprovementHypothesis;
  patchPlan: CandidatePatchPlan;
  workspace: PatchWorkspace;
  attempt: PatchAttempt;
  review: PatchReview;
} {
  const label = params.input.operatorLabel || 'Approved detached repair';
  const result = params.result;
  const sourceId = `${params.input.branchName}|${params.input.baseRef || 'HEAD'}|${params.input.diffText}`;
  const hypothesisId = hashId('improve:detached-repair', sourceId);
  const patchPlanId = hashId('patchplan:detached-repair', sourceId);
  const workspaceId = hashId(
    'patch-workspace:detached-repair',
    `${hypothesisId}|${result.branchName}|${result.baseRef}`,
  );
  const attemptId = hashId(
    'patch-attempt:detached-repair',
    `${workspaceId}|${result.status}|${result.commitHash || result.reason}`,
  );
  const testsRun = result.verificationResults.map((verification) => ({
    label: verification.label,
    command: verification.command,
    ok: verification.ok,
  }));
  const failures = result.verificationResults
    .filter((verification) => !verification.ok)
    .map((verification) => ({
      label: verification.label,
      command: verification.command,
    }));
  const status: PatchAttempt['status'] =
    result.status === 'committed'
      ? 'tests_passing'
      : result.status === 'rolled_back'
        ? 'reverted'
        : 'blocked';
  const workspaceStatus: PatchWorkspace['status'] =
    result.status === 'committed'
      ? 'tests_passing'
      : result.status === 'rolled_back'
        ? 'reverted'
        : 'rejected';
  const safetyResult: PatchAttempt['safetyResult'] =
    result.status === 'committed'
      ? 'pass'
      : result.status === 'rolled_back'
        ? 'fail'
        : 'warn';
  const recommendation: PatchReview['recommendation'] =
    result.status === 'committed' ? 'keep_branch' : 'reject';
  const mergeReadiness: PatchReview['mergeReadiness'] =
    result.status === 'committed' ? 'ready_after_approval' : 'blocked';
  const nextAction =
    result.status === 'committed'
      ? 'Review the isolated candidate branch; merge, push, and service restart still require explicit approval.'
      : result.status === 'rolled_back'
        ? 'Inspect the failed verification result, revise the diff, and rerun only after approval.'
        : 'Resolve the policy blocker before attempting detached repair execution again.';

  const hypothesis: ImprovementHypothesis = {
    hypothesisId,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    title: safeText(label, 180) || 'Approved detached repair',
    sourceSignalKind: 'repair_attempt',
    sourceSignalIdsJson: safeJson(
      [`detached-repair:${result.branchName}`],
      900,
    ),
    affectedCapability: 'debug:improvement',
    expectedBenefit:
      'Evaluate an approved repo-side repair diff in an isolated candidate worktree.',
    riskLevel: 'low',
    confidence: result.status === 'committed' ? 0.75 : 0.45,
    priorityScore: 0.66,
    proposedTest: safeJson(testsRun, 900),
    status: result.status === 'committed' ? 'validated' : 'blocked',
    fixClass: 'docs_or_test',
    externalBlocker: false,
    safetyNotes:
      'Detached repair executor only creates a local candidate branch; it does not merge, push, restart services, send messages, write calendars, or change credentials.',
    nextAction,
    privacyJson: privacyJson(),
  };

  const patchPlan: CandidatePatchPlan = {
    patchPlanId,
    hypothesisId,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    filesLikelyAffectedJson: safeJson(result.filesChanged, 2400),
    changeIntent:
      'Apply an explicitly approved diff inside a detached worktree and keep any successful result on a candidate branch only.',
    testPlanJson: safeJson(testsRun, 2400),
    rollbackPlan:
      'Failed verification removes the worktree and candidate branch; successful candidates remain local until separately reviewed.',
    approvalRequirement: 'explicit_approval',
    riskLevel: 'low',
    status: result.status === 'committed' ? 'implemented' : 'rejected',
    privacyJson: privacyJson(),
  };

  const workspace: PatchWorkspace = {
    workspaceId,
    hypothesisId,
    patchPlanId,
    branchName: result.branchName,
    baseCommit: result.baseRef,
    status: workspaceStatus,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    riskLevel: 'low',
    allowedFilesJson: safeJson(defaultAllowedFiles(), 2400),
    disallowedFilesJson: safeJson(defaultDisallowedFiles(), 2400),
    workspacePath: result.rollbackApplied ? null : result.workspacePath,
    policyJson: safeJson(
      {
        ...PATCH_WORKBENCH_POLICY,
        executor: 'detached-repair',
        killSwitch: DEFAULT_DETACHED_REPAIR_EXECUTOR_POLICY.killSwitchEnvVar,
      },
      2400,
    ),
    privacyJson: privacyJson(),
  };

  const attempt: PatchAttempt = {
    attemptId,
    workspaceId,
    patchPlanId,
    createdAt: params.generatedAt,
    updatedAt: params.generatedAt,
    filesChangedJson: safeJson(result.filesChanged, 2400),
    diffSummary: safeText(
      `${result.status}: ${result.reason}${
        result.commitHash ? ` commit=${result.commitHash}` : ''
      }`,
      1200,
    ),
    testsRunJson: safeJson(testsRun, 2400),
    beforeScore: 0,
    afterScore: result.status === 'committed' ? 1 : 0,
    regressionsJson: safeJson(failures, 1200),
    safetyResult,
    status,
    privacyJson: privacyJson(),
  };

  const review: PatchReview = {
    reviewId: hashId('patch-review:detached-repair', attemptId),
    attemptId,
    createdAt: params.generatedAt,
    recommendation,
    approvalRequired: true,
    rollbackPlan:
      result.status === 'committed'
        ? `Delete local branch ${result.branchName} if review rejects the candidate.`
        : 'Rollback was already applied or execution was blocked before mutation.',
    mergeReadiness,
    reviewerNotes: safeText(
      `${result.reason} No merge, push, service restart, live message send, calendar write, credential change, or approval-gate change is authorized by this executor.`,
      1200,
    ),
    privacyJson: privacyJson(),
  };

  return {
    hypothesis,
    patchPlan,
    workspace,
    attempt,
    review,
  };
}

export function executeApprovedDetachedRepairCandidate(
  input: DetachedRepairOperatorExecutionInput,
): DetachedRepairOperatorExecutionReport {
  const generatedAt = nowIso(input.now);
  const result = executeDetachedRepairCandidate(input);
  const records = buildDetachedRepairOperatorRecords({
    input,
    result,
    generatedAt,
  });
  const persisted = input.persist !== false && isDatabaseInitialized();
  if (persisted) {
    upsertImprovementHypothesis(records.hypothesis);
    upsertCandidatePatchPlan(records.patchPlan);
    upsertPatchWorkspace(records.workspace);
    upsertPatchAttempt(records.attempt);
    upsertPatchReview(records.review);
  }
  const nextAction =
    result.status === 'committed'
      ? 'Review the isolated candidate branch; merge, push, and service restart still require explicit approval.'
      : result.status === 'rolled_back'
        ? 'Inspect the failed verification result, revise the diff, and rerun only after approval.'
        : 'Resolve the policy blocker before attempting detached repair execution again.';
  return {
    generatedAt,
    persisted,
    result,
    ...records,
    nextAction,
    privacy: PRIVACY,
  };
}

export function applyProofDebtReportClarityRecipe(params: {
  workspacePath: string;
  generatedAt?: string;
  selectedReports?: ShadowPatchReport[];
}): { filesChanged: string[]; diffSummary: string } {
  const generatedAt = params.generatedAt || nowIso();
  const reportDir = path.join(
    params.workspacePath,
    'docs',
    'improvement-patch-reports',
  );
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'proof-debt-report-clarity.md');
  const selected = params.selectedReports || [];
  const lines = [
    '# Proof Debt Report Clarity Candidate',
    '',
    `Generated: ${generatedAt}`,
    '',
    'This candidate is produced by the v28 patch workbench as a low-risk docs/reporting patch. It does not change routing, provider use, message sending, calendar writes, credentials, services, runtime behavior, or approval gates.',
    '',
    '## Candidate Shadow Reports',
    selected.length
      ? selected
          .slice(0, 5)
          .map(
            (item) =>
              `- ${item.hypothesisId}: ${item.outcome}, delta=${item.scoreDelta.toFixed(2)}, plan=${item.patchPlanId || 'none'}`,
          )
          .join('\n')
      : '- none',
    '',
    '## Review Boundary',
    '- External proof debt stays proof debt.',
    '- Repo patches stay isolated until a human explicitly approves merge.',
    '- No candidate branch is pushed by the workbench.',
    '',
  ];
  fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  return {
    filesChanged: [
      'docs/improvement-patch-reports/proof-debt-report-clarity.md',
    ],
    diffSummary:
      'Added a low-risk proof-debt report clarity artifact inside the isolated candidate workspace.',
  };
}

export function buildPatchWorkbenchReport(
  params: {
    now?: Date;
    persist?: boolean;
    mode?: PatchWorkbenchMode;
    repoRoot?: string;
    selectedLimit?: number;
  } = {},
): PatchWorkbenchReport {
  const generatedAt = nowIso(params.now);
  const mode = params.mode || 'dry_run';
  const repoRoot = params.repoRoot || process.cwd();
  const gitSafety = evaluateGitSafety(repoRoot);
  const shadow = buildShadowImprovementReport({
    now: params.now,
    persist: params.persist !== false,
    selectedLimit: params.selectedLimit || 3,
  });
  const patchPlans =
    params.persist === false
      ? shadow.patchReports
          .map((report) => report.patchPlanId)
          .filter(Boolean)
          .map((id) =>
            listCandidatePatchPlans({ limit: 80 }).find(
              (plan) => plan.patchPlanId === id,
            ),
          )
          .filter((plan): plan is CandidatePatchPlan => Boolean(plan))
      : listCandidatePatchPlans({ limit: 80 });
  const plansById = new Map(patchPlans.map((plan) => [plan.patchPlanId, plan]));
  const hypothesesById = new Map(
    shadow.selectedHypotheses.map((item) => [item.hypothesisId, item]),
  );
  const workspaces: PatchWorkspace[] = [];
  const attempts: PatchAttempt[] = [];
  const reviews: PatchReview[] = [];
  const shouldPrepare =
    mode === 'prepare_workspace' || mode === 'apply_low_risk';
  let appliedOne = false;

  for (const report of shadow.patchReports.slice(
    0,
    params.selectedLimit || 3,
  )) {
    const hypothesis = hypothesesById.get(report.hypothesisId);
    if (!hypothesis) continue;
    const plan = report.patchPlanId
      ? plansById.get(report.patchPlanId) || null
      : null;
    const planFiles = plan ? parseJsonArray(plan.filesLikelyAffectedJson) : [];
    const recipeFiles = [
      'docs/improvement-patch-reports/proof-debt-report-clarity.md',
    ];
    const safety =
      mode === 'apply_low_risk' && !appliedOne
        ? evaluatePatchPlanSafety(plan, hypothesis, recipeFiles)
        : evaluatePatchPlanSafety(plan, hypothesis, planFiles);
    let workspace = workspaceFor({
      hypothesis,
      plan,
      generatedAt,
      baseCommit: gitSafety.head,
      status:
        shouldPrepare && gitSafety.ok && safety.allowed
          ? 'branch_prepared'
          : safety.allowed
            ? 'plan_only'
            : 'awaiting_approval',
    });
    let filesChanged: string[] = [];
    let diffSummary =
      mode === 'dry_run'
        ? 'Dry-run only; no workspace, branch, or patch was created.'
        : safety.allowed
          ? 'Workspace preparation is available only when main is clean and the operator explicitly selects this mode.'
          : safety.reason;

    if (shouldPrepare && safety.allowed && gitSafety.ok && !appliedOne) {
      const preparedPath = prepareWorktree({ repoRoot, workspace });
      workspace = {
        ...workspace,
        workspacePath: preparedPath,
        status: mode === 'apply_low_risk' ? 'patch_applied' : 'branch_prepared',
      };
      if (mode === 'apply_low_risk') {
        const applied = applyProofDebtReportClarityRecipe({
          workspacePath: preparedPath,
          generatedAt,
          selectedReports: shadow.patchReports,
        });
        filesChanged = applied.filesChanged;
        diffSummary = applied.diffSummary;
        appliedOne = true;
      } else {
        diffSummary =
          'Prepared an isolated local candidate worktree; no files were changed.';
      }
    }

    const attempt = attemptFor({
      workspace,
      plan,
      report,
      generatedAt,
      filesChanged,
      diffSummary,
      safety,
      status:
        workspace.status === 'patch_applied'
          ? 'applied'
          : safety.allowed
            ? 'planned'
            : 'blocked',
    });
    const review = reviewFor({
      attempt,
      safety,
      generatedAt,
      report,
      mode,
    });
    workspaces.push(workspace);
    attempts.push(attempt);
    reviews.push(review);
  }

  if (params.persist !== false && isDatabaseInitialized()) {
    for (const workspace of workspaces) upsertPatchWorkspace(workspace);
    for (const attempt of attempts) upsertPatchAttempt(attempt);
    for (const review of reviews) upsertPatchReview(review);
  }

  const applied = attempts.some((attempt) => attempt.status === 'applied');
  const blocked = reviews.filter(
    (review) => review.mergeReadiness === 'blocked',
  );
  return {
    generatedAt,
    mode,
    gitSafety,
    shadowRunId: shadow.run.runId,
    workspaces,
    attempts,
    reviews,
    selectedHypotheses: shadow.selectedHypotheses,
    patchReports: shadow.patchReports,
    externalProofDebt: shadow.externalBlockers,
    policy: PATCH_WORKBENCH_POLICY,
    nextAction: blocked.length
      ? 'Reject or revise blocked patch plans before any implementation.'
      : applied
        ? 'Review the isolated candidate worktree; merge/push still requires explicit approval.'
        : mode === 'dry_run'
          ? 'Use improvement:patch-dry-run for reports; use an explicit prepare/apply command only when ready for an isolated local candidate worktree.'
          : 'Resolve git safety blockers or review the prepared workspace before proceeding.',
    privacy: PRIVACY,
  };
}

export function formatPatchWorkbenchReport(
  report: PatchWorkbenchReport,
): string {
  const lines = [
    '*Approval-Gated Patch Workbench*',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Git safety: ${report.gitSafety.ok ? 'ok' : 'blocked'} / branch=${report.gitSafety.branch} / clean=${report.gitSafety.clean ? 'yes' : 'no'} / blocker=${report.gitSafety.blocker}`,
    `Shadow run: ${report.shadowRunId}`,
    `Policy: dry-run default / no auto-merge / no auto-push / no services / no live sends or calendar writes`,
    '',
    '*Candidate Workspaces*',
  ];
  if (!report.workspaces.length) {
    lines.push('- none');
  } else {
    for (const workspace of report.workspaces.slice(0, 5)) {
      lines.push(
        `- ${workspace.workspaceId}: ${workspace.status} / branch=${workspace.branchName} / risk=${workspace.riskLevel}`,
      );
      if (workspace.workspacePath)
        lines.push(`  path=${workspace.workspacePath}`);
    }
  }
  lines.push('', '*Patch Attempts*');
  if (!report.attempts.length) {
    lines.push('- none');
  } else {
    for (const attempt of report.attempts.slice(0, 5)) {
      lines.push(
        `- ${attempt.attemptId}: ${attempt.status} / safety=${attempt.safetyResult} / before=${attempt.beforeScore.toFixed(2)} / after=${attempt.afterScore.toFixed(2)}`,
      );
      lines.push(`  diff=${attempt.diffSummary}`);
    }
  }
  lines.push('', '*Patch Reviews*');
  if (!report.reviews.length) {
    lines.push('- none');
  } else {
    for (const review of report.reviews.slice(0, 5)) {
      lines.push(
        `- ${review.reviewId}: ${review.recommendation} / readiness=${review.mergeReadiness} / approval=${review.approvalRequired ? 'yes' : 'no'}`,
      );
      lines.push(`  notes=${review.reviewerNotes}`);
    }
  }
  lines.push('', '*External Or Manual Proof Debt*');
  if (!report.externalProofDebt.length) {
    lines.push('- none classified');
  } else {
    for (const item of report.externalProofDebt.slice(0, 6)) {
      lines.push(`- ${item.affectedCapability}: ${item.nextAction}`);
    }
  }
  lines.push('', `Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, provider debates, raw tool output, or secrets.',
  );
  return lines.join('\n');
}

export function createTempPatchRecipeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'andrea-patch-workbench-'));
}
