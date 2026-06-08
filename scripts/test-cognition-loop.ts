import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveTraceReport,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveCheckpoints,
  listCognitiveEvidenceArtifacts,
  listCognitiveExecutionLoopStates,
  listCognitiveExecutionSteps,
  listCognitiveStepVerifications,
  listCognitiveTrajectoryScores,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T12:00:00.000Z';
const runIdSuffix = Date.now().toString(36);

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

const kernel = beginCognitiveKernelRun({
  turnId: `cognition-loop-${runIdSuffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Research a safe public question using bounded read-only execution; stop when evidence metadata is sufficient.',
  requestRoute: 'direct_assistant',
  selectedSkillId: 'research.live_or_saved',
  selectedSkillPurpose:
    'Use local-first evidence, then public lookup metadata only when needed.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const steps = listCognitiveExecutionSteps({
  runId: kernel.run.runId,
  limit: 50,
});
const loopStates = listCognitiveExecutionLoopStates({
  runId: kernel.run.runId,
  limit: 10,
});
const artifacts = listCognitiveEvidenceArtifacts({
  runId: kernel.run.runId,
  limit: 50,
});
const verifications = listCognitiveStepVerifications({
  runId: kernel.run.runId,
  limit: 50,
});
const checkpoints = listCognitiveCheckpoints({
  runId: kernel.run.runId,
  limit: 100,
});
const trajectories = listCognitiveTrajectoryScores({
  runId: kernel.run.runId,
  limit: 10,
});
const trace = buildCognitiveTraceReport({ runId: kernel.run.runId });
const serialized = JSON.stringify({
  kernel,
  loopStates,
  artifacts,
  verifications,
  trajectories,
  trace,
});

assert.ok(loopStates.length >= 1, 'executor loop state should be persisted');
assert.ok(
  ['satisfied', 'degraded', 'budget_exhausted'].includes(loopStates[0].status),
  `unexpected loop status ${loopStates[0].status}`,
);
assert.ok(loopStates[0].round <= 4, 'loop rounds must stay bounded');
assert.ok(steps.length <= 8, 'tool steps must stay under v8 budget');
assert.equal(artifacts.length, steps.length);
assert.equal(verifications.length, steps.length);
assert.ok(
  checkpoints.filter((checkpoint) => checkpoint.checkpointKind === 'tool_step')
    .length >= steps.length,
  'every step should have a replay checkpoint',
);
assert.ok(trajectories.length >= 1, 'trajectory score should be persisted');
assert.equal(trace.loopStatus, loopStates[0].status);
assert.equal(trace.evidenceArtifactCount, artifacts.length);
assert.equal(trace.trajectoryScore, trajectories[0].overallScore);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body|raw message body|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runId: kernel.run.runId,
      loopStatus: loopStates[0].status,
      loopRound: loopStates[0].round,
      steps: steps.length,
      artifacts: artifacts.length,
      stepVerifications: verifications.length,
      trajectoryScore: trajectories[0].overallScore,
      privacy: trace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
