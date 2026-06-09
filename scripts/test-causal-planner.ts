import assert from 'node:assert/strict';
import {
  _closeDatabase,
  _initTestDatabase,
  listCausalBeliefs,
} from '../src/db.js';
import {
  formatGoalPlannerNaturalResponse,
  planGoalDirectedRequest,
} from '../src/goal-planner.js';

_initTestDatabase();

const counterfactual = planGoalDirectedRequest({
  text: 'what if we do nothing about this?',
  channel: 'telegram',
  now: '2026-06-09T13:00:00.000Z',
});
assert.equal(counterfactual.run.intent, 'counterfactual');
assert.ok(counterfactual.comparison);
assert.equal(counterfactual.options.length, 3);
assert.ok(
  counterfactual.options.some((option) =>
    /Do nothing/.test(option.actionSummary),
  ),
);
assert.match(counterfactual.response, /Best move:/);

const calendar = planGoalDirectedRequest({
  text: 'add that to my calendar',
  channel: 'telegram',
  now: '2026-06-09T13:05:00.000Z',
});
assert.ok(calendar.steps[0]);
assert.equal(calendar.steps[0].requiredTool, 'calendar');
assert.equal(calendar.steps[0].status, 'blocked');
assert.match(calendar.steps[0].nextAction, /time/i);

const message = planGoalDirectedRequest({
  text: '@Andrea send that text later tonight',
  channel: 'bluebubbles',
  now: '2026-06-09T13:10:00.000Z',
});
assert.ok(
  message.steps.some((step) => step.approvalRequirement === 'manual_external'),
);
assert.doesNotMatch(message.response, /\bsent\b/i);

const beliefs = listCausalBeliefs({ limit: 20 });
assert.ok(
  beliefs.some(
    (belief) => belief.beliefId === 'causal_rejected_default_lowers_confidence',
  ),
);
assert.ok(
  beliefs.some(
    (belief) =>
      belief.beliefId === 'causal_bluebubbles_stale_proof_blocks_send_claims',
  ),
);

const natural = formatGoalPlannerNaturalResponse('what if we do nothing');
assert.match(natural, /Best move:/);
assert.doesNotMatch(natural, /hidden reasoning|provider debate/i);

_closeDatabase();
console.log('causal planner tests passed');
