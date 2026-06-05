import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveResumePlan,
  buildCognitiveTraceReport,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveToolSimulations,
} from '../src/db.js';

_initTestDatabase();

const base = Date.now().toString(36);

const approvalRun = beginCognitiveKernelRun({
  turnId: `cognition-executor-approval-${base}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal:
    'Communication task from bluebubbles; raw message body stays local. Shape: words=5; question=true; action=true.',
  requestRoute: 'bluebubbles.direct',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Draft a reply and wait for same-thread approval.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
});

const approvalSimulations = listCognitiveToolSimulations({
  runId: approvalRun.run.runId,
  limit: 50,
});
const approvalTrace = buildCognitiveTraceReport({
  runId: approvalRun.run.runId,
});
const resume = buildCognitiveResumePlan({
  groupFolder: 'main',
  channel: 'bluebubbles',
  continuationKey: 'communication:communication.reply_help',
});

assert.equal(approvalRun.run.status, 'awaiting_approval');
assert.ok(
  approvalSimulations.some(
    (simulation) =>
      simulation.toolId === 'bluebubbles_draft' &&
      simulation.approvalRequired &&
      simulation.status !== 'block',
  ),
  'approval-first draft should simulate without executing a send',
);
assert.ok(resume.found, 'approval run should create a resumable checkpoint');
assert.equal(resume.run?.runId, approvalRun.run.runId);
assert.notEqual(
  approvalTrace.simulationStatus,
  'block',
  'approval-gated route should not block when explicit approval is staged',
);

const unsafeRun = beginCognitiveKernelRun({
  turnId: `cognition-executor-unsafe-${base}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal:
    'Communication task from telegram; raw message body stays local. Shape: words=5; question=false; action=true.',
  requestRoute: 'direct_assistant',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Draft a reply without explicit approval.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
});

const unsafeSimulations = listCognitiveToolSimulations({
  runId: unsafeRun.run.runId,
  limit: 50,
});
const unsafeTrace = buildCognitiveTraceReport({ runId: unsafeRun.run.runId });
const unsafeSerialized = JSON.stringify({ unsafeRun, unsafeSimulations, unsafeTrace });

assert.equal(unsafeRun.run.status, 'blocked');
assert.equal(unsafeTrace.simulationStatus, 'block');
assert.ok(
  unsafeSimulations.some(
    (simulation) =>
      simulation.toolId === 'bluebubbles_draft' &&
      /approval/i.test(simulation.issuesJson),
  ),
  'unsafe high-risk draft route should be blocked before tool execution',
);
assert.ok(
  unsafeRun.verification.evidenceGaps.includes('tool_simulation_blocked'),
  'blocked simulation should become a verification gap',
);
assert.doesNotMatch(
  unsafeSerialized,
  /sk-|AIza|Bearer\s+|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      approvalRunId: approvalRun.run.runId,
      approvalSimulationStatus: approvalTrace.simulationStatus,
      resumeFound: resume.found,
      unsafeRunId: unsafeRun.run.runId,
      unsafeSimulationStatus: unsafeTrace.simulationStatus,
      unsafeEvidenceGaps: unsafeRun.verification.evidenceGaps,
      privacy: unsafeTrace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
