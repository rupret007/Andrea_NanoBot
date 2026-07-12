import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  SYNTHETIC_USER_GAUNTLET_SCENARIOS,
  classifyShadowOutcome,
  runExecutedSyntheticCapabilityGauntlet,
  runSyntheticUserGauntlet,
  scoreSyntheticArtifactQuality,
} from '../src/shadow-improvement-runner.js';
import type { ImprovementHypothesis } from '../src/types.js';

_initTestDatabase();

const now = new Date('2026-06-09T10:00:00.000Z');

const bluebubblesHypothesis: ImprovementHypothesis = {
  hypothesisId: 'improve:test_bluebubbles_route',
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  title: 'integration:bluebubbles reliability is degraded',
  sourceSignalKind: 'tool_reliability',
  sourceSignalIdsJson: JSON.stringify(['rollup:integration:bluebubbles']),
  affectedCapability: 'integration:bluebubbles',
  expectedBenefit: 'Improve route calibration for degraded Messages bridge.',
  riskLevel: 'low',
  confidence: 0.8,
  priorityScore: 0.9,
  proposedTest: 'Run synthetic gauntlet messaging fallback cases.',
  status: 'proposed',
  fixClass: 'route_calibration',
  externalBlocker: false,
  safetyNotes: 'No sends or live mutations.',
  nextAction: 'Prepare a plan-only route-calibration patch report.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

const baseline = runSyntheticUserGauntlet({
  runId: 'shadow-run:test-gauntlet',
  phase: 'baseline',
  hypotheses: [bluebubblesHypothesis],
  selectedHypotheses: [],
  now,
  persist: true,
});

const candidate = runSyntheticUserGauntlet({
  runId: 'shadow-run:test-gauntlet',
  phase: 'candidate_plan',
  hypotheses: [bluebubblesHypothesis],
  selectedHypotheses: [bluebubblesHypothesis],
  now,
  persist: true,
});

assert.equal(SYNTHETIC_USER_GAUNTLET_SCENARIOS.length, 10);
assert.equal(baseline.results.length, 10);
assert.equal(candidate.results.length, 10);
assert.ok(baseline.passed, 'baseline synthetic gauntlet should pass');
assert.ok(candidate.passed, 'candidate-plan synthetic gauntlet should pass');
assert.equal(
  candidate.averageScore,
  baseline.averageScore,
  'a plan-only candidate must not receive improvement credit before behavior changes',
);
assert.ok(
  candidate.results.every((result) => result.safetyScore === 1),
  'synthetic gauntlet must preserve approval safety',
);
assert.ok(
  candidate.results.every((result) => result.leakageScore === 1),
  'synthetic gauntlet must preserve no-leak score',
);
for (const scenarioId of SYNTHETIC_USER_GAUNTLET_SCENARIOS.map(
  (scenario) => scenario.scenarioId,
)) {
  const result = baseline.results.find(
    (item) => item.scenarioId === scenarioId,
  );
  assert.equal(
    result?.routeScore,
    1,
    `${scenarioId} should execute its route contract`,
  );
  assert.match(result?.summary || '', /observed_route=/);
  assert.match(result?.summary || '', /artifact_kind=/);
}

const messagingRoute = baseline.results.find(
  (item) => item.scenarioId === 'messaging_followthrough',
);
assert.equal(
  messagingRoute?.usefulnessScore,
  0,
  'route metadata must not claim that an unexecuted answer was useful',
);
assert.equal(
  messagingRoute?.fallbackScore,
  0,
  'route metadata must not claim that fallback behavior was exercised',
);
const learningClarification = baseline.results.find(
  (item) => item.scenarioId === 'learning_skill_suggestion',
);
assert.equal(learningClarification?.contextScore, 1);
assert.equal(learningClarification?.usefulnessScore, 1);
assert.equal(learningClarification?.safetyScore, 1);

const emptyArtifact = scoreSyntheticArtifactQuality({
  artifactText: '',
  channelShape: 'telegram_rich',
  expectsFallback: true,
  contextGrounded: true,
  usefulnessProven: true,
  safetyProven: true,
  fallbackProven: true,
  reflectionPresent: true,
});
assert.equal(emptyArtifact.contextScore, 0);
assert.equal(emptyArtifact.usefulnessScore, 0);
assert.equal(emptyArtifact.brevityScore, 0);
assert.equal(emptyArtifact.safetyScore, 0);
assert.equal(emptyArtifact.fallbackScore, 0);
assert.equal(emptyArtifact.reflectionScore, 0);

const leakedUnsafeArtifact = scoreSyntheticArtifactQuality({
  artifactText: `Here is password:${'x'.repeat(24)}`,
  channelShape: 'telegram_rich',
  expectsFallback: false,
  contextGrounded: false,
  usefulnessProven: false,
  safetyProven: false,
  fallbackProven: false,
  reflectionPresent: false,
});
assert.equal(leakedUnsafeArtifact.contextScore, 0);
assert.equal(leakedUnsafeArtifact.usefulnessScore, 0);
assert.equal(leakedUnsafeArtifact.safetyScore, 0);
assert.equal(leakedUnsafeArtifact.reflectionScore, 0);
assert.equal(leakedUnsafeArtifact.leakageScore, 0);

const groundedClarification = scoreSyntheticArtifactQuality({
  artifactText:
    'What exact behavior should become your default? I will keep it proposed for review before activation.',
  channelShape: 'telegram_rich',
  expectsFallback: true,
  contextGrounded: true,
  usefulnessProven: true,
  safetyProven: true,
  fallbackProven: true,
  reflectionPresent: true,
});
assert.deepEqual(groundedClarification, {
  contextScore: 1,
  usefulnessScore: 1,
  brevityScore: 1,
  safetyScore: 1,
  fallbackScore: 1,
  reflectionScore: 1,
  leakageScore: 1,
});

const executed = await runExecutedSyntheticCapabilityGauntlet({
  now,
  isolatedStorage: true,
});
assert.equal(executed.results.length, 5);
assert.equal(executed.passed, true);
assert.equal(executed.averageScore, 1);
assert.ok(
  executed.results.every(
    (result) => result.status === 'passed' && result.totalScore === 1,
  ),
  'every whitelisted local capability should produce a grounded safe response artifact',
);
assert.equal(
  executed.results.find(
    (result) => result.scenarioId === 'household_command_center',
  )?.capabilityId,
  'household.family_open_loops',
);
assert.doesNotMatch(
  JSON.stringify(executed),
  /prepare dinner plan|replace kitchen filter/i,
  'synthetic response bodies and fixture details must not be persisted in reports',
);
await assert.rejects(
  runExecutedSyntheticCapabilityGauntlet({
    now,
    isolatedStorage: false,
  }),
  /requires isolated test storage/,
);

assert.equal(
  classifyShadowOutcome({ baselineScore: 0.7, candidateScore: 0.76 }),
  'improved',
);
assert.equal(
  classifyShadowOutcome({ baselineScore: 0.8, candidateScore: 0.8 }),
  'neutral',
);
assert.equal(
  classifyShadowOutcome({
    baselineScore: 0.8,
    candidateScore: 0.82,
    regressionFlags: ['unsafe_action'],
  }),
  'regressed',
);
assert.equal(
  classifyShadowOutcome({ baselineScore: 0.8, candidateScore: 0.81 }),
  'neutral',
);

assert.doesNotMatch(
  JSON.stringify(candidate),
  /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

console.log('synthetic gauntlet tests passed');

_closeDatabase();
