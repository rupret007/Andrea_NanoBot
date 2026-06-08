import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentRuntimeCheckpoints,
  listSupervisorAgendaItems,
  listSupervisorBudgets,
  listSupervisorDecisions,
  listSupervisorLoopStates,
  listSupervisorTerminationConditions,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-07T00:01:00.000Z';
const runtime = beginAgentRuntimeSpineRun({
  turnId: 'supervisor-loop-approval',
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Send this message later tonight after drafting it.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime?.supervisor, 'supervisor should be created');
assert.equal(runtime.run.status, 'awaiting_approval');
assert.equal(runtime.supervisor.run.status, 'awaiting_approval');
assert.equal(runtime.supervisor.termination.reason, 'approval_required');
assert.equal(runtime.supervisor.run.activeParticipant, 'approval_stager');

const supervisorRunId = runtime.supervisor.run.supervisorRunId;
const decisions = listSupervisorDecisions({ supervisorRunId, limit: 50 });
const agenda = listSupervisorAgendaItems({ supervisorRunId, limit: 50 });
const loopStates = listSupervisorLoopStates({ supervisorRunId, limit: 10 });
const budgets = listSupervisorBudgets({ supervisorRunId, limit: 10 });
const terminations = listSupervisorTerminationConditions({ supervisorRunId, limit: 10 });
const checkpoints = listAgentRuntimeCheckpoints({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 10,
});

assert.ok(decisions.some((decision) => decision.decision === 'stage_approval'));
assert.ok(agenda.some((item) => item.itemKind === 'stage_approval' && item.status === 'approval_staged'));
assert.equal(loopStates[0]?.status, 'awaiting_approval');
assert.equal(budgets[0]?.usedCouncilCalls, 0, 'supervisor should not fake a council call');
assert.equal(budgets[0]?.usedReadOnlyToolSteps, 0, 'mutating path should not execute read-only tools first');
assert.equal(terminations[0]?.reason, 'approval_required');
assert.ok(
  checkpoints[0]?.metadataJson.includes(runtime.supervisor.blackboard.blackboardId),
  'runtime checkpoint should reference supervisor blackboard for resume',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      supervisorRunId,
      termination: terminations[0]?.reason,
      loopStatus: loopStates[0]?.status,
      stagedAgenda: agenda.filter((item) => item.status === 'approval_staged').length,
      nextAction: runtime.supervisor.run.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
