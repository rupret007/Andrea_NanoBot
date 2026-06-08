import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import { runAgencyConvergenceLoop } from '../src/agency-convergence-loop.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

beginAgentRuntimeSpineRun({
  turnId: 'agency-loop-resume-seed',
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Send the drafted BlueBubbles message later tonight.',
  generatedAt: '2026-06-07T01:11:00.000Z',
  mode: 'assistive',
});

const report = await runAgencyConvergenceLoop({
  generatedAt: '2026-06-07T01:11:01.000Z',
  mode: 'assistive',
  intentText: 'resume that',
  liveProviderProbe: false,
});
const resumePlan = report.resumePlans[0];
const decision = report.decisions[0];
const agenda = report.agendas[0];

assert.ok(resumePlan, 'agency loop should create a resume plan');
assert.ok(
  resumePlan.status === 'approval_required' ||
    resumePlan.status === 'available' ||
    resumePlan.status === 'not_needed',
  'resume plan should be explicit',
);
assert.notEqual(
  decision.decisionKind,
  'execute_read_only',
  'resume request against mutating work should not be treated as ordinary execution when approval is queued',
);
if (agenda.policyClass === 'approval_staged') {
  assert.equal(report.latestRun?.status, 'awaiting_approval');
  assert.ok(!report.latestRun?.runtimeRunId, 'approval-staged resume should not execute');
}
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      run: report.latestRun?.convergenceRunId,
      agendaPolicy: agenda.policyClass,
      decision: decision.decisionKind,
      resumeStatus: resumePlan.status,
      nextAction: report.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
