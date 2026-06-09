import assert from 'node:assert/strict';
import fs from 'node:fs';
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
} from '../src/patch-workbench.js';
import type {
  CandidatePatchPlan,
  ImprovementHypothesis,
  RepairAttemptRecord,
  ToolReliabilityRollup,
} from '../src/types.js';

_initTestDatabase();

const now = '2026-06-09T12:00:00.000Z';

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
assert.equal(evaluatePatchPlanSafety(docsPlan, lowRiskHypothesis).allowed, true);

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

console.log('patch workbench tests passed');

_closeDatabase();
