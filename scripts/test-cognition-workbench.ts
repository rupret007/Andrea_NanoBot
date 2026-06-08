import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveTraceReport,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveHandoffs,
  listCognitiveWorkbenchStates,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T14:30:00.000Z';
const suffix = Date.now().toString(36);

const healthyProvider: ProviderHealthSnapshot = {
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

const research = beginCognitiveKernelRun({
  turnId: `cognition-workbench-research-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'ultrathink a read-only research plan with local-first evidence, verifier review, and no side effects.',
  requestRoute: 'test:cognition:workbench:research',
  selectedSkillId: 'research.live_or_saved',
  selectedSkillPurpose:
    'Use the governed workbench to gather and verify read-only evidence.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
  thinkingPreference: 'deep',
  thinkingTrigger: 'ultrathink',
});

const operator = beginCognitiveKernelRun({
  turnId: `cognition-workbench-operator-${suffix}`,
  channel: 'system',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Inspect operator diagnostics metadata and stage any repair as approval-only.',
  requestRoute: 'test:cognition:workbench:operator',
  selectedSkillId: 'operator.diagnostics',
  selectedSkillPurpose:
    'Gather read-only operator status and hold repairs behind approval.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const researchHandoffs = listCognitiveHandoffs({
  runId: research.run.runId,
  limit: 20,
});
const operatorWorkbench = listCognitiveWorkbenchStates({
  runId: operator.run.runId,
  limit: 5,
})[0];
const researchTrace = buildCognitiveTraceReport({ runId: research.run.runId });
const operatorTrace = buildCognitiveTraceReport({ runId: operator.run.runId });
const serialized = JSON.stringify({
  research,
  operator,
  researchHandoffs,
  operatorWorkbench,
  researchTrace,
  operatorTrace,
});

assert.ok(
  researchHandoffs.some(
    (handoff) =>
      handoff.fromRole === 'planner' && handoff.toRole === 'memory_curator',
  ),
  'planner should hand off to memory curator',
);
assert.ok(
  researchHandoffs.some(
    (handoff) =>
      handoff.fromRole === 'memory_curator' &&
      handoff.toRole === 'evidence_scout',
  ),
  'memory curator should hand off to evidence scout',
);
assert.ok(
  researchHandoffs.some((handoff) => handoff.toRole === 'final_arbiter'),
  'workbench should end at a final arbiter',
);
assert.ok(operatorWorkbench, 'operator run should persist workbench state');
assert.equal(operatorWorkbench.status, 'awaiting_approval');
assert.ok(operatorWorkbench.approvalPacketCount >= 1);
assert.equal(researchTrace.handoffCount, researchHandoffs.length);
assert.equal(researchTrace.memoryBlockCount, 8);
assert.equal(operatorTrace.workbenchStatus, 'awaiting_approval');
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      researchRunId: research.run.runId,
      researchHandoffCount: researchHandoffs.length,
      researchWorkbench: researchTrace.workbenchStatus,
      operatorRunId: operator.run.runId,
      operatorWorkbench: operatorWorkbench.status,
      operatorApprovalPackets: operatorWorkbench.approvalPacketCount,
      privacy: researchTrace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
