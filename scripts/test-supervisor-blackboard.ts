import assert from 'node:assert/strict';

import {
  beginAgentRuntimeSpineRun,
} from '../src/agent-runtime-spine.js';
import {
  makeSupervisorBlackboardPatch,
} from '../src/supervisor-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listSupervisorBlackboardPatches,
  listSupervisorBlackboards,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:59:00.000Z';
const runtime = beginAgentRuntimeSpineRun({
  turnId: 'supervisor-blackboard',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Check safe evidence and explain the next useful action.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime?.supervisor, 'supervisor should be created');

const blackboards = listSupervisorBlackboards({
  supervisorRunId: runtime.supervisor.run.supervisorRunId,
  limit: 10,
});
const patches = listSupervisorBlackboardPatches({
  supervisorRunId: runtime.supervisor.run.supervisorRunId,
  limit: 50,
});

assert.equal(blackboards.length, 1, 'one supervisor blackboard should persist');
assert.ok(patches.length >= 4, 'blackboard patches should persist');
assert.equal(patches.filter((patch) => patch.rejected).length, 0);
assert.equal(blackboards[0]?.privacyJson.includes('rawPrivateBodiesStored'), true);

const unsafePatch = makeSupervisorBlackboardPatch({
  blackboardId: runtime.supervisor.blackboard.blackboardId,
  supervisorRunId: runtime.supervisor.run.supervisorRunId,
  generatedAt,
  participantRole: 'evidence_scout',
  patchKind: 'tool_result',
  summary: 'Attempted unsafe raw body persistence',
  refs: ['unsafe-ref'],
  patch: {
    raw: 'raw private body text with sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
  },
});

assert.equal(unsafePatch.rejected, true);
assert.match(unsafePatch.rejectionReason || '', /unsafe_or_raw_content_detected/);
assert.doesNotMatch(unsafePatch.patchJson, /sk-proj-|raw private body text/);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      blackboardId: blackboards[0]?.blackboardId,
      storedPatches: patches.length,
      unsafePatchRejected: unsafePatch.rejected,
      nextAction: blackboards[0]?.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
