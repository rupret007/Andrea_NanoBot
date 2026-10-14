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
  isGoalPlannerNaturalRequest,
  planGoalDirectedRequest,
} from '../src/goal-planner.js';
import { buildRealityGroundingReport } from '../src/reality-grounding.js';
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
  weekend.steps.some(
    (step) => step.approvalRequirement === 'approval_required',
  ),
);
assert.match(weekend.response, /Proposed goal: Prepare for the weekend/);

const storedGoals = listHierarchicalGoals({ statuses: ['proposed'], limit: 5 });
assert.ok(storedGoals.some((goal) => goal.title === 'Prepare for the weekend'));
const storedMilestones = listGoalMilestones({
  goalId: weekend.goal?.goalId,
  limit: 10,
});
const storedSteps = listGoalPlanSteps({
  goalId: weekend.goal?.goalId,
  limit: 10,
});
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

const oldReality = buildRealityGroundingReport({
  requestText: 'old planner proof state',
  channel: 'operator',
  persist: false,
  now: new Date('2026-06-09T12:04:00.000Z'),
});
oldReality.snapshot.snapshotId = 'reality-old-telegram-gap';
oldReality.verificationNeeds = [
  {
    needId: 'need-old-telegram-gap',
    snapshotId: oldReality.snapshot.snapshotId,
    createdAt: oldReality.generatedAt,
    updatedAt: oldReality.generatedAt,
    question: 'Is Telegram user-session proof configured?',
    reason: 'Historical test-only proof gap.',
    neededBeforeAction: false,
    possibleSourceTool: 'telegram_user_session',
    riskIfSkipped: 'low',
    urgency: 'low',
    status: 'manual_proof',
    evidenceIdsJson: '[]',
    nextAction:
      'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH, then rerun the proof.',
    privacyJson: JSON.stringify({ metadataOnly: true }),
  },
];
planGoalDirectedRequest({
  text: 'help me get Andrea closer to done',
  channel: 'operator',
  now: '2026-06-09T12:04:30.000Z',
  reality: oldReality,
  persist: true,
});

const currentReality = structuredClone(oldReality);
currentReality.snapshot.snapshotId = 'reality-current-bluebubbles-gap';
currentReality.verificationNeeds = currentReality.verificationNeeds.map(
  (need) => ({
    ...need,
    needId: 'need-current-bluebubbles-gap',
    snapshotId: currentReality.snapshot.snapshotId,
    question: 'Is BlueBubbles same-thread proof fresh?',
    nextAction: 'Refresh the BlueBubbles same-thread proof.',
  }),
);
const reconciledReport = buildHierarchicalPlannerReport({
  requestText: 'help me get Andrea closer to done',
  now: '2026-06-09T12:05:00.000Z',
  persist: false,
  reality: currentReality,
});
assert.ok(reconciledReport.stalePlanStepsSuppressed > 0);
assert.ok(
  reconciledReport.planSteps.some((step) =>
    /BlueBubbles same-thread proof/i.test(step.nextAction),
  ),
);
assert.doesNotMatch(
  formatGoalPlannerReport(reconciledReport),
  /TELEGRAM_USER_API_ID/,
);

const manualProofOpportunity: ProactiveOpportunity = {
  opportunityId: 'opportunity_manual_bluebubbles_proof',
  createdAt: '2026-06-09T12:05:30.000Z',
  updatedAt: '2026-06-09T12:05:30.000Z',
  groupFolder: null,
  triggerSource: 'proof:bluebubbles_manual',
  relatedGoalId: null,
  opportunitySummary: 'BlueBubbles proof requires a real phone turn.',
  reason: 'Manual proof debt should not become household planning advice.',
  urgency: 'normal',
  confidence: 0.8,
  suggestedAction:
    'Use a real iPhone and send a same-thread BlueBubbles message.',
  approvalRequirement: 'manual_external',
  status: 'proposed',
  snoozedUntil: null,
  evidenceRefsJson: JSON.stringify(['proof:bluebubbles']),
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertProactiveOpportunity(manualProofOpportunity);
const tonight = planGoalDirectedRequest({
  text: 'help me plan tonight',
  channel: 'telegram',
  now: '2026-06-09T12:06:00.000Z',
});
assert.doesNotMatch(tonight.response, /real iPhone|same-thread BlueBubbles/);

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
assert.equal(isGoalPlannerNaturalRequest('what should I do next?'), false);
assert.equal(isGoalPlannerNaturalRequest('show me the plan'), true);
assert.equal(isGoalPlannerNaturalRequest('what if we do nothing?'), true);

_closeDatabase();
console.log('goal planning tests passed');
