import assert from 'node:assert/strict';

import {
  formatAgentOSPlanPreview,
  previewAgentOSPlan,
} from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getAgentOSPlanArtifact,
  listAgentOSTaskNodes,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T20:15:00.000Z';
const preview = previewAgentOSPlan({
  goal: 'Research the safest next architecture move and show the plan first.',
  generatedAt,
});

const stored = getAgentOSPlanArtifact(preview.plan.planId);
const nodes = listAgentOSTaskNodes({ planId: preview.plan.planId, limit: 50 });
const text = formatAgentOSPlanPreview(preview);

assert.ok(stored, 'plan-only should persist a plan artifact');
assert.equal(preview.plan.planOnly, true);
assert.equal(preview.approvalRequired, false);
assert.ok(preview.nodes.length >= 6, 'planner should create a useful DAG');
assert.ok(nodes.some((node) => node.nodeKind === 'planner'));
assert.ok(nodes.some((node) => node.nodeKind === 'evidence_scout'));
assert.ok(nodes.some((node) => node.nodeKind === 'verifier'));
assert.ok(nodes.every((node) => node.stopCondition.length > 0));
assert.ok(
  preview.guardrailDecisions.every((decision) => decision.status === 'pass'),
  'read-only plan should pass deterministic guardrails',
);
assert.match(text, /Agent OS Plan Preview/);
assert.equal(preview.privacy.rawPromptsStored, false);
assert.equal(preview.privacy.rawPrivateBodiesStored, false);
assert.equal(preview.privacy.hiddenReasoningStored, false);

const serialized = JSON.stringify({ preview, stored, nodes, text });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      planId: preview.plan.planId,
      taskFamily: preview.plan.taskFamily,
      nodes: preview.nodes.length,
      executableReadOnlyNodeCount: preview.executableReadOnlyNodeCount,
      nextAction: preview.nextAction,
      privacy: preview.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
