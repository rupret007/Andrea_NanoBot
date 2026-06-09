import assert from 'node:assert/strict';
import {
  _closeDatabase,
  _initTestDatabase,
  listProactiveOpportunities,
  upsertHierarchicalGoal,
} from '../src/db.js';
import {
  applyProactiveOpportunityControl,
  buildProactiveOpportunityReport,
  formatProactiveOpportunityReport,
} from '../src/proactive-opportunities.js';
import type { HierarchicalGoal } from '../src/types.js';

_initTestDatabase();

const goal: HierarchicalGoal = {
  goalId: 'goal_test_house',
  createdAt: '2026-06-09T14:00:00.000Z',
  updatedAt: '2026-06-09T14:00:00.000Z',
  groupFolder: null,
  title: 'Stay on top of the house',
  objective: 'Keep household open loops from drifting.',
  scope: 'household',
  owner: 'shared',
  status: 'active',
  priority: 'high',
  confidence: 0.86,
  evidenceRefsJson: JSON.stringify(['test:evidence']),
  relatedWorldFactIdsJson: '[]',
  relatedSkillIdsJson: '[]',
  relatedMissionIdsJson: '[]',
  relatedReminderIdsJson: '[]',
  relatedActionBundleIdsJson: '[]',
  reviewCadence: 'weekly',
  approvalBoundary: 'approval_required',
  allowedActionsJson: JSON.stringify(['plan', 'suggest_next_step']),
  disallowedActionsJson: JSON.stringify(['send_without_approval']),
  nextAction: 'Pick one household task to close tonight.',
  privacyJson: JSON.stringify({ policy: 'metadata-only' }),
};
upsertHierarchicalGoal(goal);

const report = buildProactiveOpportunityReport({
  now: new Date('2026-06-09T14:05:00.000Z'),
});
assert.ok(report.opportunities.length >= 1);
assert.ok(report.topOpportunity);
assert.equal(report.topOpportunity?.relatedGoalId, goal.goalId);
assert.match(formatProactiveOpportunityReport(report), /Proactive Opportunities/);

const dismissed = applyProactiveOpportunityControl({
  text: 'stop suggesting that',
  now: new Date('2026-06-09T14:06:00.000Z'),
});
assert.equal(dismissed.handled, true);
assert.match(dismissed.message, /won't keep surfacing/i);
assert.ok(
  listProactiveOpportunities({
    statuses: ['dismissed'],
    limit: 5,
  }).some((item) => item.relatedGoalId === goal.goalId),
);

const afterDismiss = buildProactiveOpportunityReport({
  now: new Date('2026-06-09T14:07:00.000Z'),
});
assert.ok(
  !afterDismiss.topOpportunity ||
    afterDismiss.topOpportunity.relatedGoalId !== goal.goalId,
);

const snooze = applyProactiveOpportunityControl({
  text: 'bring it up later',
  now: new Date('2026-06-09T14:08:00.000Z'),
});
assert.equal(snooze.handled, Boolean(afterDismiss.topOpportunity));

_closeDatabase();
console.log('proactive opportunity tests passed');
