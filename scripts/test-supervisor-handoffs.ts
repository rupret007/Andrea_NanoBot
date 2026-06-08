import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listSupervisorHandoffMessages,
  listSupervisorParticipants,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-07T00:00:00.000Z';
const runtime = beginAgentRuntimeSpineRun({
  turnId: 'supervisor-handoffs',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'planning',
  goal: 'Plan the next safe checks and explain why the route is useful.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime?.supervisor, 'supervisor should be created');

const participants = listSupervisorParticipants({
  supervisorRunId: runtime.supervisor.run.supervisorRunId,
  limit: 20,
});
const handoffs = listSupervisorHandoffMessages({
  supervisorRunId: runtime.supervisor.run.supervisorRunId,
  limit: 20,
});

assert.deepEqual(
  participants.map((participant) => participant.role).sort(),
  [
    'approval_stager',
    'evidence_scout',
    'final_arbiter',
    'memory_curator',
    'planner',
    'tool_executor',
    'truth_calibrator',
    'verifier',
  ].sort(),
);
assert.equal(handoffs[0]?.fromRole, 'planner');
assert.equal(handoffs[0]?.toRole, 'memory_curator');
assert.equal(handoffs[1]?.fromRole, 'memory_curator');
assert.equal(handoffs[1]?.toRole, 'evidence_scout');
assert.ok(
  handoffs.every((handoff) => handoff.payloadJson.includes('explicit_handoff_message')),
  'handoff payloads should identify explicit handoff routing',
);
assert.ok(
  handoffs.every((handoff) => !/provider debate|chain-of-thought|raw private/i.test(handoff.payloadJson)),
  'handoff payloads should remain metadata-only',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      supervisorRunId: runtime.supervisor.run.supervisorRunId,
      participants: participants.length,
      handoffs: handoffs.map((handoff) => `${handoff.fromRole}->${handoff.toRole}`),
      activeParticipant: runtime.supervisor.run.activeParticipant,
    },
    null,
    2,
  ),
);

_closeDatabase();
