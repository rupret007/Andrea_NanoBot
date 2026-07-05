import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabase,
  listPatchAttempts,
  listPatchReviews,
  listPatchWorkspaces,
  upsertRepairAttempt,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  applyProofDebtReportClarityRecipe,
  buildPatchWorkbenchReport,
  createTempPatchRecipeWorkspace,
  evaluatePatchPlanSafety,
  executeApprovedDetachedRepairCandidate,
  executeDetachedRepairCandidate,
} from '../src/patch-workbench.js';
import type {
  CandidatePatchPlan,
  ImprovementHypothesis,
  RepairAttemptRecord,
  ToolReliabilityRollup,
} from '../src/types.js';

_initTestDatabase();

const now = '2026-06-09T12:00:00.000Z';

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createRepairExecutorRepo(label: string): {
  repoRoot: string;
  diffText: string;
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `andrea-${label}-`));
  const baseLines = Array.from(
    { length: 20 },
    (_, index) => `line-${String(index + 1).padStart(2, '0')}`,
  );
  baseLines[4] = 'beta';
  baseLines[19] = 'omega';
  const patchedLines = [...baseLines];
  patchedLines[4] = 'BETA';
  const driftedLines = [...baseLines];
  driftedLines[19] = 'GAMMA';
  git(repoRoot, ['init', '-b', 'main']);
  git(repoRoot, ['config', 'user.email', 'andrea-test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Andrea Test']);
  fs.writeFileSync(
    path.join(repoRoot, 'file.txt'),
    `${baseLines.join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'check.js'),
    [
      "const fs = require('fs');",
      "const text = fs.readFileSync('file.txt', 'utf8');",
      "if (!text.includes('BETA') || !text.includes('GAMMA')) process.exit(1);",
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'fail.js'),
    'process.exit(1);\n',
    'utf8',
  );
  git(repoRoot, ['add', 'file.txt', 'check.js', 'fail.js']);
  git(repoRoot, ['commit', '-m', 'initial']);

  fs.writeFileSync(
    path.join(repoRoot, 'file.txt'),
    `${patchedLines.join('\n')}\n`,
    'utf8',
  );
  const diffText = `${git(repoRoot, ['diff', 'HEAD', '--', 'file.txt'])}\n`;
  fs.writeFileSync(
    path.join(repoRoot, 'file.txt'),
    `${baseLines.join('\n')}\n`,
    'utf8',
  );
  assert.equal(git(repoRoot, ['status', '--porcelain']), '');

  fs.writeFileSync(
    path.join(repoRoot, 'file.txt'),
    `${driftedLines.join('\n')}\n`,
    'utf8',
  );
  git(repoRoot, ['add', 'file.txt']);
  git(repoRoot, ['commit', '-m', 'change context']);
  return { repoRoot, diffText };
}

function branchExists(repoRoot: string, branchName: string): boolean {
  try {
    git(repoRoot, ['rev-parse', '--verify', branchName]);
    return true;
  } catch {
    return false;
  }
}

function cleanupRepairExecutorRepo(repoRoot: string): void {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(
    path.join(
      path.dirname(repoRoot),
      `${path.basename(repoRoot)}-improvement-worktrees`,
    ),
    { recursive: true, force: true },
  );
}

function repair(
  attemptId: string,
  integrationId: string,
  playbookId: RepairAttemptRecord['playbookId'],
): RepairAttemptRecord {
  return {
    attemptId,
    playbookId,
    integrationId,
    createdAt: now,
    updatedAt: now,
    status: 'planned',
    failureClass: 'transport_error',
    safeToApply: true,
    dryRun: true,
    validationStatus: 'not_run',
    rollbackStatus: 'not_needed',
    summary: `${integrationId} needs clearer validation.`,
    nextAction: 'Prepare a focused eval/status patch plan.',
    cooldownUntil: null,
    evidenceIdsJson: JSON.stringify([`repair:${attemptId}`]),
    privacyJson: JSON.stringify({ metadataOnly: true }),
  };
}

const degradedBlueBubbles: ToolReliabilityRollup = {
  subjectId: 'integration:bluebubbles',
  updatedAt: now,
  sampleCount: 4,
  successRate: 0.25,
  degradedRate: 0.75,
  blockedRate: 0,
  fallbackRate: 0.5,
  reliabilityScore: 0.35,
  currentHealth: 'degraded',
  confidenceCap: 0.55,
  cooldownUntil: null,
  nextAction: 'Keep BlueBubbles fallback wording honest.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

upsertToolReliabilityRollup(degradedBlueBubbles);
upsertRepairAttempt(
  repair(
    'patch-workbench-work-cockpit-1',
    'work_cockpit',
    'work_cockpit_reconcile_selection',
  ),
);
upsertRepairAttempt(
  repair(
    'patch-workbench-message-action-1',
    'message_action',
    'scheduled_action_failure_review',
  ),
);

const report = buildPatchWorkbenchReport({
  now: new Date(now),
  persist: true,
  mode: 'dry_run',
});

assert.equal(report.mode, 'dry_run');
assert.ok(report.workspaces.length >= 1, 'workspaces should be planned');
assert.ok(report.attempts.length >= 1, 'attempts should be recorded');
assert.ok(report.reviews.length >= 1, 'reviews should be recorded');
assert.ok(
  report.reviews.every((review) => review.approvalRequired),
  'candidate work remains approval-gated',
);
assert.ok(
  report.workspaces.every((workspace) => workspace.status !== 'merged'),
  'workbench must not merge anything',
);

const persistedWorkspaces = listPatchWorkspaces({ limit: 10 });
const persistedAttempts = listPatchAttempts({ limit: 10 });
const persistedReviews = listPatchReviews({ limit: 10 });
assert.ok(persistedWorkspaces.length >= report.workspaces.length);
assert.ok(persistedAttempts.length >= report.attempts.length);
assert.ok(persistedReviews.length >= report.reviews.length);

const lowRiskHypothesis: ImprovementHypothesis = {
  hypothesisId: 'improve:docs-only',
  createdAt: now,
  updatedAt: now,
  title: 'debug proof-debt wording clarity',
  sourceSignalKind: 'harness_proposal',
  sourceSignalIdsJson: JSON.stringify(['harness:test']),
  affectedCapability: 'debug:improvement',
  expectedBenefit: 'Clearer proof-debt reporting.',
  riskLevel: 'low',
  confidence: 0.8,
  priorityScore: 0.8,
  proposedTest: 'Run patch workbench tests.',
  status: 'proposed',
  fixClass: 'debug_wording',
  externalBlocker: false,
  safetyNotes: 'Docs/debug only.',
  nextAction: 'Prepare docs/debug patch.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
const docsPlan: CandidatePatchPlan = {
  patchPlanId: 'patchplan:docs-only',
  hypothesisId: lowRiskHypothesis.hypothesisId,
  createdAt: now,
  updatedAt: now,
  filesLikelyAffectedJson: JSON.stringify([
    'docs/TESTING_AND_RELEASE_RUNBOOK.md',
    'scripts/test-patch-workbench.ts',
  ]),
  changeIntent: 'Improve docs and eval wording only.',
  testPlanJson: JSON.stringify(['npm run test:patch-workbench']),
  rollbackPlan: 'Discard the candidate branch.',
  approvalRequirement: 'explicit_approval',
  riskLevel: 'low',
  status: 'planned',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
assert.equal(
  evaluatePatchPlanSafety(docsPlan, lowRiskHypothesis).allowed,
  true,
);

const runtimePlan: CandidatePatchPlan = {
  ...docsPlan,
  patchPlanId: 'patchplan:runtime',
  filesLikelyAffectedJson: JSON.stringify(['src/message-actions.ts']),
};
assert.equal(
  evaluatePatchPlanSafety(runtimePlan, lowRiskHypothesis).allowed,
  false,
);

const riskyHypothesis: ImprovementHypothesis = {
  ...lowRiskHypothesis,
  hypothesisId: 'improve:risky',
  riskLevel: 'high',
  title: 'change message sending behavior',
  affectedCapability: 'tool:message_actions',
};
assert.equal(evaluatePatchPlanSafety(docsPlan, riskyHypothesis).allowed, false);

const recipeWorkspace = createTempPatchRecipeWorkspace();
const applied = applyProofDebtReportClarityRecipe({
  workspacePath: recipeWorkspace,
  generatedAt: now,
  selectedReports: report.patchReports,
});
assert.deepEqual(applied.filesChanged, [
  'docs/improvement-patch-reports/proof-debt-report-clarity.md',
]);
assert.ok(
  fs.existsSync(
    path.join(
      recipeWorkspace,
      'docs',
      'improvement-patch-reports',
      'proof-debt-report-clarity.md',
    ),
  ),
);

assert.doesNotMatch(
  JSON.stringify(report),
  /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

const successRepo = createRepairExecutorRepo('repair-executor-success');
try {
  const successBranch = 'codex/improvement/test-detached-success';
  const success = executeDetachedRepairCandidate({
    repoRoot: successRepo.repoRoot,
    branchName: successBranch,
    diffText: successRepo.diffText,
    verificationCommands: [
      {
        command: process.execPath,
        args: ['check.js'],
      },
    ],
    commitMessage: 'Apply detached repair candidate',
    approved: true,
    policy: {
      allowedVerificationCommands: [
        {
          command: process.execPath,
          args: ['check.js'],
        },
      ],
    },
  });

  assert.equal(success.status, 'committed', success.reason);
  assert.ok(success.commitHash);
  assert.equal(success.verificationResults[0]?.ok, true);
  assert.ok(branchExists(successRepo.repoRoot, successBranch));
  assert.equal(fs.existsSync(success.workspacePath), false);
  const successFile = git(successRepo.repoRoot, [
    'show',
    `${successBranch}:file.txt`,
  ]);
  assert.match(successFile, /\bBETA\b/);
  assert.match(successFile, /\bGAMMA\b/);
  assert.equal(git(successRepo.repoRoot, ['status', '--porcelain']), '');
} finally {
  cleanupRepairExecutorRepo(successRepo.repoRoot);
}

const failingRepo = createRepairExecutorRepo('repair-executor-failing');
try {
  const failingBranch = 'codex/improvement/test-detached-failing';
  const failure = executeDetachedRepairCandidate({
    repoRoot: failingRepo.repoRoot,
    branchName: failingBranch,
    diffText: failingRepo.diffText,
    verificationCommands: [
      {
        command: process.execPath,
        args: ['fail.js'],
      },
    ],
    commitMessage: 'Apply failing detached repair candidate',
    approved: true,
    policy: {
      allowedVerificationCommands: [
        {
          command: process.execPath,
          args: ['fail.js'],
        },
      ],
    },
  });

  assert.equal(failure.status, 'rolled_back');
  assert.equal(failure.commitHash, null);
  assert.equal(failure.verificationResults[0]?.ok, false);
  assert.equal(failure.rollbackApplied, true);
  assert.equal(branchExists(failingRepo.repoRoot, failingBranch), false);
  assert.equal(fs.existsSync(failure.workspacePath), false);
  const failingHeadFile = git(failingRepo.repoRoot, ['show', 'HEAD:file.txt']);
  assert.match(failingHeadFile, /\bbeta\b/);
  assert.match(failingHeadFile, /\bGAMMA\b/);
  assert.equal(git(failingRepo.repoRoot, ['status', '--porcelain']), '');
} finally {
  cleanupRepairExecutorRepo(failingRepo.repoRoot);
}

const blockedRepo = createRepairExecutorRepo('repair-executor-blocked');
try {
  const blocked = executeDetachedRepairCandidate({
    repoRoot: blockedRepo.repoRoot,
    branchName: 'codex/improvement/test-detached-blocked',
    diffText: [
      'diff --git a/.env b/.env',
      '--- a/.env',
      '+++ b/.env',
      '@@ -0,0 +1 @@',
      '+SECRET=not-allowed',
      '',
    ].join('\n'),
    verificationCommands: [],
    commitMessage: 'Blocked candidate',
    approved: true,
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /sensitive paths|dangerous-change/i);
} finally {
  cleanupRepairExecutorRepo(blockedRepo.repoRoot);
}

const persistedRepo = createRepairExecutorRepo('repair-executor-persisted');
try {
  const persistedBranch = 'codex/improvement/test-detached-persisted';
  const persisted = executeApprovedDetachedRepairCandidate({
    repoRoot: persistedRepo.repoRoot,
    branchName: persistedBranch,
    diffText: persistedRepo.diffText,
    verificationCommands: [
      {
        command: process.execPath,
        args: ['check.js'],
      },
    ],
    commitMessage: 'Apply persisted detached repair candidate',
    approved: true,
    operatorLabel: 'Persisted detached repair test',
    policy: {
      allowedVerificationCommands: [
        {
          command: process.execPath,
          args: ['check.js'],
        },
      ],
    },
  });

  assert.equal(persisted.result.status, 'committed', persisted.result.reason);
  assert.equal(persisted.persisted, true);
  assert.equal(persisted.review.approvalRequired, true);
  assert.equal(persisted.review.mergeReadiness, 'ready_after_approval');
  assert.equal(branchExists(persistedRepo.repoRoot, persistedBranch), true);
  assert.equal(
    listPatchWorkspaces({
      hypothesisId: persisted.hypothesis.hypothesisId,
      limit: 5,
    }).some(
      (workspace) => workspace.workspaceId === persisted.workspace.workspaceId,
    ),
    true,
  );
  assert.equal(
    listPatchAttempts({
      workspaceId: persisted.workspace.workspaceId,
      limit: 5,
    }).some((attempt) => attempt.attemptId === persisted.attempt.attemptId),
    true,
  );
  assert.equal(
    listPatchReviews({
      attemptId: persisted.attempt.attemptId,
      limit: 5,
    }).some((review) => review.reviewId === persisted.review.reviewId),
    true,
  );
} finally {
  cleanupRepairExecutorRepo(persistedRepo.repoRoot);
}

console.log('patch workbench tests passed');

_closeDatabase();
