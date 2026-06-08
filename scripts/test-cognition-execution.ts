import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveTraceReport,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveExecutionSteps,
  listCognitivePolicyDecisions,
  listCognitivePlanRevisions,
  listCognitiveToolResults,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-05T13:00:00.000Z';
const base = Date.now().toString(36);

const healthyOpenAI: ProviderHealthSnapshot = {
  providerId: 'openai_cloud',
  kind: 'llm',
  state: 'healthy',
  lastHealthyAt: checkedAt,
  lastCheckedAt: checkedAt,
  failureClass: 'none',
  quotaState: 'ok',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: '',
  nextAction: '',
  metadata: {},
};

const readOnlyRun = beginCognitiveKernelRun({
  turnId: `cognition-execution-readonly-${base}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'calendar',
  goal: "What's on my calendar tomorrow? Use read-only evidence and do not change anything.",
  requestRoute: 'direct_assistant',
  selectedSkillId: 'calendar.read',
  selectedSkillPurpose:
    'Answer a calendar question from read-only status/evidence.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyOpenAI],
});

const steps = listCognitiveExecutionSteps({
  runId: readOnlyRun.run.runId,
  limit: 50,
});
const decisions = listCognitivePolicyDecisions({
  runId: readOnlyRun.run.runId,
  limit: 50,
});
const results = listCognitiveToolResults({
  runId: readOnlyRun.run.runId,
  limit: 50,
});
const revisions = listCognitivePlanRevisions({
  runId: readOnlyRun.run.runId,
  limit: 50,
});
const trace = buildCognitiveTraceReport({ runId: readOnlyRun.run.runId });
const serialized = JSON.stringify({
  readOnlyRun,
  steps,
  decisions,
  results,
  revisions,
  trace,
});

assert.ok(steps.length >= 4, 'read-only run should persist execution steps');
assert.equal(decisions.length, steps.length);
assert.equal(results.length, steps.length);
assert.ok(
  steps.some(
    (step) => step.toolId === 'provider_health' && step.status === 'executed',
  ),
  'provider health should execute as read-only metadata',
);
assert.ok(
  results.some((result) => result.toolId === 'integrations_status'),
  'integration doctor status should become a tool result',
);
assert.notEqual(trace.executionStatus, 'none');
assert.ok(trace.executedStepCount >= 1);
assert.ok(
  revisions.length >= 1,
  'executor should record a plan revision or success path',
);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

const approvalRun = beginCognitiveKernelRun({
  turnId: `cognition-execution-approval-${base}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Communication task from bluebubbles; raw message body stays local. Shape: words=6; question=false; action=true.',
  requestRoute: 'bluebubbles.direct',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose:
    'Draft a reply but require explicit same-thread approval.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyOpenAI],
});

const approvalSteps = listCognitiveExecutionSteps({
  runId: approvalRun.run.runId,
  limit: 50,
});
const approvalResults = listCognitiveToolResults({
  runId: approvalRun.run.runId,
  limit: 50,
});

assert.equal(approvalRun.run.status, 'awaiting_approval');
assert.ok(
  approvalSteps.some(
    (step) =>
      step.toolId === 'bluebubbles_draft' && step.status === 'approval_staged',
  ),
  'BlueBubbles draft must stage approval instead of executing a send',
);
assert.ok(
  approvalResults.some(
    (result) =>
      result.toolId === 'bluebubbles_draft' &&
      result.status === 'skipped' &&
      /approval/i.test(result.failureClass || ''),
  ),
  'approval-staged draft should store only a skipped result envelope',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      readOnlyRunId: readOnlyRun.run.runId,
      readOnlySteps: steps.length,
      readOnlyExecutionStatus: trace.executionStatus,
      readOnlyExecutedSteps: trace.executedStepCount,
      approvalRunId: approvalRun.run.runId,
      approvalStaged: approvalSteps.filter(
        (step) => step.status === 'approval_staged',
      ).length,
      privacy: trace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
