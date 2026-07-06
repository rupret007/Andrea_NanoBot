import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabase,
  listShadowCandidateSelections,
  listShadowPatchReports,
  listSyntheticGauntletScenarioResults,
  upsertRepairAttempt,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  buildShadowImprovementReport,
  selectShadowImprovementCandidates,
} from '../src/shadow-improvement-runner.js';
import type {
  ImprovementHypothesis,
  RepairAttemptRecord,
  ToolReliabilityRollup,
} from '../src/types.js';

// Run from an isolated temp directory so live host truth markers (for example
// data/runtime/telegram-roundtrip-health.json) cannot leak into the integration
// doctor report and hide the seeded blocked-Telegram hypothesis.
process.chdir(mkdtempSync(path.join(os.tmpdir(), 'shadow-improvement-test-')));

_initTestDatabase();

const now = '2026-06-09T11:00:00.000Z';

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

const externalTelegram: ToolReliabilityRollup = {
  subjectId: 'integration:telegram',
  updatedAt: now,
  sampleCount: 3,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 1,
  reliabilityScore: 0,
  currentHealth: 'blocked',
  confidenceCap: 0.15,
  cooldownUntil: null,
  nextAction:
    'Configure TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH outside the repo.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

function unknownTool(subjectId: string): ToolReliabilityRollup {
  return {
    subjectId,
    updatedAt: now,
    sampleCount: 0,
    successRate: 0,
    degradedRate: 0,
    blockedRate: 0,
    fallbackRate: 0,
    reliabilityScore: 0,
    currentHealth: 'unknown',
    confidenceCap: 0.5,
    cooldownUntil: null,
    nextAction: `Collect one ${subjectId} observation.`,
    privacyJson: JSON.stringify({ metadataOnly: true }),
  };
}

upsertToolReliabilityRollup(degradedBlueBubbles);
upsertToolReliabilityRollup(externalTelegram);
upsertToolReliabilityRollup(unknownTool('tool:calendar'));
upsertToolReliabilityRollup(unknownTool('tool:research'));
upsertRepairAttempt(
  repair(
    'shadow-work-cockpit-1',
    'work_cockpit',
    'work_cockpit_reconcile_selection',
  ),
);
upsertRepairAttempt(
  repair(
    'shadow-message-action-1',
    'message_action',
    'scheduled_action_failure_review',
  ),
);

const report = buildShadowImprovementReport({
  now: new Date(now),
  persist: true,
  selectedLimit: 3,
});

assert.equal(report.policy.appliesPatches, false);
assert.equal(report.policy.createsBranchesOrWorktrees, false);
assert.equal(report.policy.mergesOrPushes, false);
assert.equal(report.baseline.results.length, 10);
assert.equal(report.candidate.results.length, 10);
assert.ok(report.run.baselineScore > 0);
assert.ok(report.run.candidateScore >= report.run.baselineScore);

const selected = report.selections.filter(
  (selection) => selection.decision === 'selected',
);
assert.equal(selected.length, 3, 'top three low-risk repo-side candidates selected');
assert.ok(
  selected.some((selection) => selection.hypothesisId.includes('improve:')),
  'selection ids should link to mined hypotheses',
);
assert.ok(
  report.patchReports.length >= 3,
  'selected candidates should receive shadow patch reports',
);
assert.ok(
  report.patchReports.every((item) => item.outcome !== 'regressed'),
  'first-pass plan-only candidates should not regress the deterministic gauntlet',
);
assert.ok(
  report.externalBlockers.some((item) => item.affectedCapability === 'integration:telegram'),
  'external Telegram config blocker should stay classified as external',
);

const persistedSelections = listShadowCandidateSelections({
  runId: report.run.runId,
  limit: 20,
});
const persistedResults = listSyntheticGauntletScenarioResults({
  runId: report.run.runId,
  limit: 40,
});
const persistedPatchReports = listShadowPatchReports({
  runId: report.run.runId,
  limit: 20,
});

assert.equal(persistedSelections.length >= selected.length, true);
assert.equal(persistedResults.length, 20);
assert.equal(persistedPatchReports.length, report.patchReports.length);

const manualProof: ImprovementHypothesis = {
  hypothesisId: 'improve:manual-proof',
  createdAt: now,
  updatedAt: now,
  title: 'Alexa signed IntentRequest missing',
  sourceSignalKind: 'pilot_proof_gap',
  sourceSignalIdsJson: JSON.stringify(['proof:alexa']),
  affectedCapability: 'alexa_signed_intentrequest',
  expectedBenefit: 'Keep proof debt honest.',
  riskLevel: 'medium',
  confidence: 0.8,
  priorityScore: 0.9,
  proposedTest: 'Use real Alexa device proof.',
  status: 'proposed',
  fixClass: 'external_manual_proof',
  externalBlocker: true,
  safetyNotes: 'Manual external proof only.',
  nextAction: 'Use Alexa app/device to generate signed IntentRequest.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
const risky: ImprovementHypothesis = {
  ...manualProof,
  hypothesisId: 'improve:risky-send',
  title: 'message send behavior change',
  affectedCapability: 'tool:message_actions',
  riskLevel: 'high',
  fixClass: 'repair_playbook',
  externalBlocker: false,
};
const allowed: ImprovementHypothesis = {
  ...manualProof,
  hypothesisId: 'improve:allowed-debug',
  title: 'debug wording improvement',
  affectedCapability: 'tool:research',
  riskLevel: 'low',
  fixClass: 'debug_wording',
  externalBlocker: false,
};
const decisions = selectShadowImprovementCandidates([
  manualProof,
  risky,
  allowed,
]).decisions;
assert.equal(
  decisions.find((item) => item.hypothesis === manualProof)?.decision,
  'external_blocker',
);
assert.equal(
  decisions.find((item) => item.hypothesis === risky)?.decision,
  'requires_approval',
);
assert.equal(
  decisions.find((item) => item.hypothesis === allowed)?.decision,
  'selected',
);

assert.doesNotMatch(
  JSON.stringify(report),
  /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

console.log('shadow improvement tests passed');

_closeDatabase();
