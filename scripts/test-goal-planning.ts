import assert from 'node:assert/strict';
import {
  _closeDatabase,
  _initTestDatabase,
  listGoalMilestones,
  listGoalPlanSteps,
  listHierarchicalGoals,
  upsertProactiveOpportunity,
} from '../src/db.js';
import {
  buildHierarchicalPlannerReport,
  formatGoalPlannerReport,
  planGoalDirectedRequest,
} from '../src/goal-planner.js';
import type { ProactiveOpportunity } from '../src/types.js';

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

const staleBraveOpportunity: ProactiveOpportunity = {
  opportunityId: 'opportunity_stale_brave_blocker',
  createdAt: '2026-06-09T12:06:00.000Z',
  updatedAt: '2026-06-09T12:06:00.000Z',
  groupFolder: null,
  triggerSource: 'contradiction:provider_vs_route',
  relatedGoalId: null,
  opportunitySummary:
    'Research routes must not claim Brave participation while Brave Search is blocked.',
  reason: 'Old persisted provider contradiction.',
  urgency: 'normal',
  confidence: 0.72,
  suggestedAction:
    'Use local knowledge or healthy providers until Brave quota recovers.',
  approvalRequirement: 'read_only',
  status: 'proposed',
  snoozedUntil: null,
  evidenceRefsJson: JSON.stringify(['contradiction:old_brave']),
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertProactiveOpportunity(staleBraveOpportunity);

const report = buildHierarchicalPlannerReport({
  requestText: 'what should I do next',
  now: '2026-06-09T12:10:00.000Z',
});
const formatted = formatGoalPlannerReport(report);
assert.match(formatted, /Hierarchical Goal Planner/);
assert.match(formatted, /Causal Beliefs/);
assert.doesNotMatch(formatted, /Brave Search is blocked/);
assert.doesNotMatch(formatted, /sk-[A-Za-z0-9_-]{12,}/);

_closeDatabase();
console.log('goal planning tests passed');
