import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  finalizeCognitiveKernelOutcome,
} from '../src/cognitive-kernel.js';
import {
  getCognitiveRun,
  _closeDatabase,
  _initTestDatabase,
  listCognitiveRewardSignals,
  listCognitiveSubgoalsForRun,
} from '../src/db.js';

_initTestDatabase();

const turnId = `cognition-test-${Date.now().toString(36)}`;
const councilRunId = `council-${turnId}`;

const kernel = beginCognitiveKernelRun({
  turnId,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal:
    'Handle operator turn from telegram via direct_assistant. Safe user intent: ultrathink a read-only diagnosis and draft repair plan.',
  requestRoute: 'direct_assistant',
  selectedSkillId: 'operator.repair',
  selectedSkillPurpose: 'Diagnose and stage repairs while preserving approval.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerCouncil: {
    councilRunId,
    mode: 'max_iq_council',
    status: 'completed',
    answerGuidance: {
      status: 'pass',
      visibleVerdict: 'Draft only; no mutation.',
      answerDirection: 'Stage an approval-first repair plan.',
      confidence: 0.86,
      uncertainty: 'Live mutation was not requested.',
      sourceMemberIds: ['planner', 'verifier'],
      approvalNeed: 'explicit',
      evidenceGrade: 'partial',
      evidenceIds: [`intent:${turnId}`, 'policy:approval_first'],
      riskFlags: ['approval_required'],
    },
  },
  knownBlockers: [],
  thinkingPreference: 'deep',
  thinkingTrigger: 'ultrathink',
});

assert.equal(kernel.run.cognitiveMode, 'approval_staged');
assert.equal(kernel.verification.approvalRequired, true);
assert.ok(kernel.taskGraph.subgoals.length >= 5);
assert.ok(
  kernel.taskGraph.subgoals.every(
    (subgoal) => subgoal.requiredEvidence && subgoal.stopCondition,
  ),
  'every subgoal should declare evidence and stop condition',
);
assert.ok(
  kernel.taskGraph.subgoals.some((subgoal) =>
    subgoal.toolPlan.some((plan) => plan.approvalRequired),
  ),
  'approval-required tasks should stage an approval tool plan',
);

finalizeCognitiveKernelOutcome({
  cognitiveRun: kernel,
  evaluationStatus: 'pass',
  evidenceGap: 'none',
  evaluatorFlags: ['provider_council_guidance_applied', 'approval_required'],
  routeUsed: 'operator.repair_plan',
  answerClass: 'handled',
});

const stored = getCognitiveRun(kernel.run.runId);
assert.ok(stored, 'run should persist');
assert.equal(stored?.status, 'awaiting_approval');
assert.ok(stored?.linkedSkillCardId, 'run should link a skill card');

const subgoals = listCognitiveSubgoalsForRun(kernel.run.runId);
assert.equal(subgoals.length, kernel.taskGraph.subgoals.length);
assert.ok(
  subgoals.every(
    (subgoal) => subgoal.requiredEvidence.length > 0 && subgoal.stopCondition.length > 0,
  ),
  'every subgoal should persist evidence and stop-condition metadata',
);
assert.ok(
  subgoals.some((subgoal) => /approval/i.test(subgoal.stopCondition)),
  'approval-required run should preserve an approval stop condition',
);

const rewards = listCognitiveRewardSignals({ runId: kernel.run.runId });
assert.equal(rewards[0]?.signalKind, 'approval_required');

const doctor = buildCognitiveDoctorReport();
assert.ok(doctor.recent.totalRuns >= 1);
assert.equal(doctor.privacy.rawPrivateBodiesStored, false);
assert.equal(doctor.privacy.hiddenReasoningStored, false);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runId: kernel.run.runId,
      mode: stored?.cognitiveMode,
      runStatus: stored?.status,
      subgoals: subgoals.length,
      rewardSignals: rewards.length,
      linkedSkillCardId: stored?.linkedSkillCardId,
      nextAction: stored?.nextAction,
      privacy: doctor.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
