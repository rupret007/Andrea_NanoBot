import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  upsertRepairAttempt,
  upsertResponseFeedback,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  beginCognitiveExecutiveTurn,
  finalizeCognitiveExecutiveTurn,
} from '../src/cognitive-executive.js';
import { buildAutonomousImprovementLabReport } from '../src/autonomous-improvement-lab.js';
import type {
  RepairAttemptRecord,
  ResponseFeedbackRecord,
  ToolReliabilityRollup,
} from '../src/types.js';

_initTestDatabase();

const now = '2026-06-07T20:00:00.000Z';

function seedReflection(turnId: string): void {
  const context = beginCognitiveExecutiveTurn({
    rawAsk: 'what should I do next',
    channel: 'telegram',
    groupFolder: 'main',
    turnId,
    now: new Date(now),
  });
  assert.ok(context, 'executive context should be created');
  finalizeCognitiveExecutiveTurn({
    context,
    status: 'failed',
    resultSummary: 'Route needed a clearer next-step decision.',
    failureSummary: 'Route confidence was too high for missing context.',
    nextAction:
      'Ask one clarifying question before choosing a high-risk action.',
    blockerClass: 'route_confidence_mismatch',
    fallbackUsed: true,
    now: new Date(now),
  });
}

seedReflection('self-improve-turn-1');
seedReflection('self-improve-turn-2');

function seedSuccessfulRoute(turnId: string, fallbackUsed = false): void {
  const context = beginCognitiveExecutiveTurn({
    rawAsk: 'what am I forgetting',
    channel: 'telegram',
    groupFolder: 'main',
    turnId,
    now: new Date(now),
  });
  assert.ok(context, 'successful executive context should be created');
  finalizeCognitiveExecutiveTurn({
    context,
    status: 'handled',
    resultSummary: 'Loose-ends route answered with grounded context.',
    nextAction: 'Use the suggested next step if it still matters.',
    fallbackUsed,
    now: new Date(now),
  });
}

seedSuccessfulRoute('self-improve-success-1', true);
seedSuccessfulRoute('self-improve-success-2', true);

const externalProvider: ToolReliabilityRollup = {
  subjectId: 'provider:test_blocked_cloud',
  updatedAt: now,
  sampleCount: 3,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 1,
  reliabilityScore: 0,
  currentHealth: 'blocked',
  confidenceCap: 0.2,
  cooldownUntil: null,
  nextAction: 'Wait for quota or rotate provider credentials outside the repo.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertToolReliabilityRollup(externalProvider);

const observationGap: ToolReliabilityRollup = {
  subjectId: 'tool:research',
  updatedAt: now,
  sampleCount: 0,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 0,
  fallbackRate: 0,
  reliabilityScore: 0,
  currentHealth: 'unknown',
  confidenceCap: 0.5,
  cooldownUntil: null,
  nextAction: 'Collect one research status observation.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertToolReliabilityRollup(observationGap);

const highRiskTool: ToolReliabilityRollup = {
  subjectId: 'tool:message_actions',
  updatedAt: now,
  sampleCount: 2,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 0,
  reliabilityScore: 0,
  currentHealth: 'blocked',
  confidenceCap: 0.15,
  cooldownUntil: null,
  nextAction: 'Require explicit approval and preserve the draft.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertToolReliabilityRollup(highRiskTool);

const repair: RepairAttemptRecord = {
  attemptId: 'self-improve-repair-1',
  playbookId: 'bluebubbles_refresh_all',
  integrationId: 'bluebubbles',
  createdAt: now,
  updatedAt: now,
  status: 'planned',
  failureClass: 'needs_proof',
  safeToApply: true,
  dryRun: true,
  validationStatus: 'manual_required',
  rollbackStatus: 'not_needed',
  summary: 'Same-thread proof still needs manual confirmation.',
  nextAction: 'Complete same-thread BlueBubbles proof.',
  cooldownUntil: null,
  evidenceIdsJson: JSON.stringify(['proof:bluebubbles']),
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertRepairAttempt(repair);

const feedback: ResponseFeedbackRecord = {
  feedbackId: 'self-improve-feedback-1',
  createdAt: now,
  updatedAt: now,
  status: 'captured',
  classification: 'repo_side_rough_edge',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'test-chat',
  threadId: null,
  platformMessageId: 'msg-1',
  userMessageId: 'user-msg-1',
  issueId: null,
  routeKey: 'cognitive_executive.daily_companion',
  capabilityId: 'daily_companion',
  handlerKind: 'cognitive_executive',
  responseSource: 'test',
  traceReason: 'wording_rough_edge',
  traceNotes: ['classification only'],
  blockerClass: 'none',
  blockerOwner: 'repo_side',
  originalUserText:
    'secret-ish input sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 raw private body',
  assistantReplyText: 'rough wording',
  linkedRefs: {},
  remediationLaneId: null,
  remediationJobId: null,
  remediationRuntimePreference: null,
  remediationPrompt: null,
  operatorNote: null,
};
upsertResponseFeedback(feedback);
upsertResponseFeedback({
  ...feedback,
  feedbackId: 'self-improve-feedback-resolved',
  status: 'resolved_locally',
  capabilityId: 'daily.resolved_fixture',
});

const report = buildAutonomousImprovementLabReport({
  now: new Date(now),
  persist: true,
  selectedLimit: 8,
});

assert.ok(report.hypotheses.length >= 4, 'expected mined hypotheses');
assert.equal(report.patchPlanPolicy.plansOnly, true);
assert.equal(report.patchPlanPolicy.autoAppliesProductPatches, false);
assert.equal(report.patchPlanPolicy.pushesWithoutValidation, false);
assert.ok(report.topCandidates.length > 0, 'expected ranked top candidates');
assert.notEqual(
  report.topCandidates[0]?.fixClass,
  'repair_playbook',
  'daily-agent learning and feedback should outrank generic repair churn when both are actionable',
);
assert.ok(
  ['executive_reflection', 'response_feedback'].includes(
    report.topCandidates[0]?.sourceSignalKind ?? '',
  ),
  'top candidate should be daily-agent feedback or executive learning',
);

const external = report.hypotheses.find(
  (item) => item.affectedCapability === 'provider:test_blocked_cloud',
);
assert.ok(external, 'blocked external provider should become a hypothesis');
assert.equal(external?.externalBlocker, true);
assert.equal(
  report.patchPlans.some(
    (plan) => plan.hypothesisId === external?.hypothesisId,
  ),
  false,
  'blocked external provider should not become a repo patch plan',
);

const lowRisk = report.hypotheses.find(
  (item) => item.affectedCapability === 'tool:research',
);
assert.ok(lowRisk, 'unknown research reliability should be mined');
assert.equal(lowRisk?.fixClass, 'diagnostic_observation');
assert.ok(
  report.patchPlans.some((plan) => plan.hypothesisId === lowRisk?.hypothesisId),
  'low-risk observation gap should become a plan-only patch candidate',
);

const highRisk = report.hypotheses.find(
  (item) => item.affectedCapability === 'tool:message_actions',
);
assert.ok(highRisk, 'message action risk should be represented');
assert.equal(highRisk?.riskLevel, 'high');
const highRiskExperiment = report.experiments.find(
  (item) => item.hypothesisId === highRisk?.hypothesisId,
);
assert.equal(highRiskExperiment?.decision, 'needs_approval');

assert.ok(
  report.hypotheses.some(
    (item) => item.sourceSignalKind === 'executive_reflection',
  ),
  'repeated executive friction should become a hypothesis',
);
assert.equal(
  report.hypotheses.some(
    (item) =>
      item.sourceSignalKind === 'executive_reflection' &&
      item.affectedCapability === 'daily.loose_ends',
  ),
  false,
  'successful deterministic fallback answers must not be mined as friction',
);
assert.ok(
  report.hypotheses.some(
    (item) => item.sourceSignalKind === 'response_feedback',
  ),
  'repo-side feedback should become a hypothesis',
);
assert.equal(
  report.hypotheses.some(
    (item) => item.affectedCapability === 'daily.resolved_fixture',
  ),
  false,
  'resolved feedback must stay in validation/proof status instead of creating another patch hypothesis',
);
assert.doesNotMatch(
  JSON.stringify(report),
  /sk-proj-|abcdefghijklmnopqrstuvwxyz1234567890|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

console.log('self-improvement tests passed');

_closeDatabase();
