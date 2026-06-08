import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  finalizeCognitiveKernelOutcome,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveApprovalPackets,
  listCognitiveTrajectoryScores,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T13:00:00.000Z';
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

const safeResearch = beginCognitiveKernelRun({
  turnId: `cognition-trajectory-safe-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Run safe read-only research trajectory scoring with enough metadata evidence to answer.',
  requestRoute: 'test:cognition:trajectory:safe',
  selectedSkillId: 'research.live_or_saved',
  selectedSkillPurpose: 'Use read-only metadata evidence and score trajectory.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

finalizeCognitiveKernelOutcome({
  cognitiveRun: safeResearch,
  evaluationStatus: 'pass',
  evidenceGap: 'none',
  evaluatorFlags: ['trajectory_recorded'],
  routeUsed: 'research.live_or_saved',
  answerClass: 'handled',
});

const approvalCommunication = beginCognitiveKernelRun({
  turnId: `cognition-trajectory-approval-${suffix}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Draft a reply from sanitized BlueBubbles metadata and wait for same-thread approval.',
  requestRoute: 'test:cognition:trajectory:approval',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Draft reply help without sending.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const unsafeCommunication = beginCognitiveKernelRun({
  turnId: `cognition-trajectory-unsafe-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Draft and send-adjacent communication task without explicit approval; this should be blocked before side effects.',
  requestRoute: 'test:cognition:trajectory:unsafe',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Attempt unsafe send-adjacent work without approval.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const safeScores = listCognitiveTrajectoryScores({
  runId: safeResearch.run.runId,
  limit: 10,
});
const approvalScores = listCognitiveTrajectoryScores({
  runId: approvalCommunication.run.runId,
  limit: 10,
});
const unsafeScores = listCognitiveTrajectoryScores({
  runId: unsafeCommunication.run.runId,
  limit: 10,
});
const approvalPackets = listCognitiveApprovalPackets({
  runId: approvalCommunication.run.runId,
  status: 'staged',
  limit: 20,
});
const unsafeDemoted = JSON.parse(
  unsafeScores[0]?.demotedAdaptersJson || '[]',
) as string[];
const serialized = JSON.stringify({
  safeResearch,
  approvalCommunication,
  unsafeCommunication,
  safeScores,
  approvalScores,
  unsafeScores,
});

assert.ok(safeScores[0].overallScore >= 0.7);
assert.ok(
  safeScores[0].promotedRoute,
  'successful read-only route should become promotable',
);
assert.ok(approvalPackets.length >= 1);
assert.equal(
  approvalScores[0].promotedRoute,
  false,
  'approval-staged routes should not auto-promote side effects',
);
assert.equal(unsafeCommunication.run.status, 'blocked');
assert.ok(
  unsafeDemoted.includes('bluebubbles_draft'),
  'blocked send-adjacent adapter should be demoted for this trajectory',
);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      safeScore: safeScores[0].overallScore,
      safePromotedRoute: safeScores[0].promotedRoute,
      approvalPackets: approvalPackets.length,
      approvalPromotedRoute: approvalScores[0].promotedRoute,
      unsafeStatus: unsafeCommunication.run.status,
      unsafeDemoted,
    },
    null,
    2,
  ),
);

_closeDatabase();
