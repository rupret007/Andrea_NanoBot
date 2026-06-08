import assert from 'node:assert/strict';

import {
  previewAgentOSPlan,
  replayAgentOSPlan,
} from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentOSReplayRuns,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T20:30:00.000Z';

const readOnly = previewAgentOSPlan({
  goal: 'Run safe read-only checks for provider health and integration status.',
  generatedAt,
});
const readOnlyReplay = replayAgentOSPlan({
  planId: readOnly.plan.planId,
  generatedAt,
});
assert.equal(readOnlyReplay.replay.status, 'replayed');
assert.equal(readOnlyReplay.replay.plannerSkipped, true);
assert.equal(readOnlyReplay.replay.approvalRequired, false);
assert.ok(JSON.parse(readOnlyReplay.replay.replayedNodeIdsJson).length >= 4);

const mutating = previewAgentOSPlan({
  goal: 'Draft and send a BlueBubbles text later tonight.',
  generatedAt,
});
const mutatingReplay = replayAgentOSPlan({
  planId: mutating.plan.planId,
  generatedAt,
});
assert.equal(mutating.approvalRequired, true);
assert.equal(mutatingReplay.replay.status, 'approval_staged');
assert.equal(mutatingReplay.replay.plannerSkipped, true);
assert.equal(mutatingReplay.replay.approvalRequired, true);
assert.ok(
  mutating.nodes.some(
    (node) => node.nodeKind === 'approval_stager' && node.approvalRequired,
  ),
  'mutating plan should include an approval stager node',
);

const storedReplays = listAgentOSReplayRuns({ planId: mutating.plan.planId, limit: 10 });
assert.ok(storedReplays.some((replay) => replay.replayId === mutatingReplay.replay.replayId));

const serialized = JSON.stringify({ readOnlyReplay, mutatingReplay });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      readOnlyReplay: readOnlyReplay.replay.status,
      mutatingReplay: mutatingReplay.replay.status,
      plannerSkipped: mutatingReplay.replay.plannerSkipped,
      approvalRequired: mutatingReplay.replay.approvalRequired,
      nextAction: mutatingReplay.nextAction,
      privacy: mutatingReplay.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
