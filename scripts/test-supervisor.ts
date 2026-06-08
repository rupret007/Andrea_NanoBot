import assert from 'node:assert/strict';

import {
  beginAgentRuntimeSpineRun,
  buildAgentRuntimeSpineReport,
} from '../src/agent-runtime-spine.js';
import {
  buildSupervisorDoctorReport,
  formatSupervisorDoctorReport,
} from '../src/supervisor-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listSupervisorRuns,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:58:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body|chain-of-thought|hidden reasoning text/i;

const runtime = beginAgentRuntimeSpineRun({
  turnId: 'supervisor-core',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Inspect Andrea proof debt and decide what safe checks should run next.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime, 'runtime spine should create a run');
assert.ok(runtime.supervisor, 'runtime spine should link supervisor output');
assert.equal(runtime.supervisor.run.runtimeRunId, runtime.run.runtimeRunId);
assert.ok(
  runtime.report.steps.some((step) => step.stepKind === 'supervisor'),
  'runtime report should include a supervisor step',
);
assert.ok(
  runtime.report.evidencePackets.some((packet) => packet.sourceLayer === 'supervisor'),
  'runtime report should include supervisor evidence packet',
);

const runtimeReport = buildAgentRuntimeSpineReport({
  runtimeRunId: runtime.run.runtimeRunId,
  generatedAt,
});
const supervisorReport = buildSupervisorDoctorReport({
  runtimeRunId: runtime.run.runtimeRunId,
  generatedAt,
});
const formatted = formatSupervisorDoctorReport(supervisorReport);
const storedRuns = listSupervisorRuns({ runtimeRunId: runtime.run.runtimeRunId, limit: 5 });

assert.ok(storedRuns.length >= 1, 'supervisor run should persist');
assert.ok(runtimeReport.supervisorReport?.latestRun, 'runtime report should embed supervisor doctor report');
assert.equal(supervisorReport.latestRun?.blackboardId, runtime.supervisor.blackboard.blackboardId);
assert.ok(supervisorReport.handoffs.length >= 4, 'supervisor should record deterministic handoffs');
assert.ok(supervisorReport.decisions.length >= 3, 'supervisor should record route decisions');
assert.match(formatted, /Supervisor Core/);
assert.doesNotMatch(JSON.stringify({ runtimeReport, supervisorReport, formatted }), SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      supervisorRunId: supervisorReport.latestRun?.supervisorRunId,
      activeParticipant: supervisorReport.latestRun?.activeParticipant,
      handoffs: supervisorReport.handoffs.length,
      decisions: supervisorReport.decisions.length,
      termination: supervisorReport.terminations[0]?.reason || 'none',
      nextAction: supervisorReport.nextAction,
      privacy: supervisorReport.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
