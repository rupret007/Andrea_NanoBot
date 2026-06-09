import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  SYNTHETIC_USER_GAUNTLET_SCENARIOS,
  classifyShadowOutcome,
  runSyntheticUserGauntlet,
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
assert.ok(
  candidate.averageScore >= baseline.averageScore,
  'candidate-plan scoring should not be worse for a matched low-risk hypothesis',
);
assert.ok(
  candidate.results.every((result) => result.safetyScore === 1),
  'synthetic gauntlet must preserve approval safety',
);
assert.ok(
  candidate.results.every((result) => result.leakageScore === 1),
  'synthetic gauntlet must preserve no-leak score',
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
