import assert from 'node:assert/strict';
import {
  _closeDatabase,
  _initTestDatabase,
  listGoalMilestones,
  listGoalPlanSteps,
  listHierarchicalGoals,
} from '../src/db.js';
import {
  buildHierarchicalPlannerReport,
  formatGoalPlannerReport,
  planGoalDirectedRequest,
} from '../src/goal-planner.js';

_initTestDatabase();

const weekend = planGoalDirectedRequest({
  text: 'help me prepare for the weekend',
  channel: 'telegram',
  now: '2026-06-09T12:00:00.000Z',
});

assert.equal(weekend.goal?.status, 'proposed');
assert.equal(weekend.goal?.scope, 'household');
assert.equal(weekend.milestones.length, 3);
assert.ok(weekend.steps.length >= 2);
assert.ok(
  weekend.steps.some((step) => step.approvalRequirement === 'approval_required'),
);
assert.match(weekend.response, /Proposed goal: Prepare for the weekend/);

const storedGoals = listHierarchicalGoals({ statuses: ['proposed'], limit: 5 });
assert.ok(storedGoals.some((goal) => goal.title === 'Prepare for the weekend'));
const storedMilestones = listGoalMilestones({
  goalId: weekend.goal?.goalId,
  limit: 10,
});
const storedSteps = listGoalPlanSteps({ goalId: weekend.goal?.goalId, limit: 10 });
assert.equal(storedMilestones.length, 3);
assert.ok(storedSteps.length >= 2);

const andrea = planGoalDirectedRequest({
  text: 'help me get Andrea closer to done',
  channel: 'operator',
  now: '2026-06-09T12:05:00.000Z',
});
assert.equal(andrea.goal?.scope, 'andrea_project');
assert.ok(andrea.steps.some((step) => step.requiredTool === 'improvement_lab'));
assert.ok(andrea.run.approvalRequired);
assert.match(andrea.response, /Approval: required/);

const report = buildHierarchicalPlannerReport({
  requestText: 'what should I do next',
  now: '2026-06-09T12:10:00.000Z',
});
const formatted = formatGoalPlannerReport(report);
assert.match(formatted, /Hierarchical Goal Planner/);
assert.match(formatted, /Causal Beliefs/);
assert.doesNotMatch(formatted, /sk-[A-Za-z0-9_-]{12,}/);

_closeDatabase();
console.log('goal planning tests passed');
