import assert from 'node:assert/strict';

import {
  formatGroundedMemoryEvalReport,
  GROUNDED_MEMORY_EVAL_BASELINE,
  runGroundedMemoryEval,
} from '../src/grounded-memory-eval.js';

const report = runGroundedMemoryEval();
console.log(formatGroundedMemoryEvalReport(report));
console.log('');

assert.equal(
  report.scenarios.length,
  Object.keys(GROUNDED_MEMORY_EVAL_BASELINE).length,
  'every baseline scenario must run',
);
const failed = report.scenarios.filter((scenario) => !scenario.correct);
assert.equal(
  report.failCount,
  0,
  `all scenarios must pass; failed: ${failed
    .map((scenario) => scenario.scenarioId)
    .join(', ')}`,
);
assert.deepEqual(report.regressions, [], 'no regressions versus the baseline');

// Determinism: a second full run produces an identical report.
const second = runGroundedMemoryEval();
assert.deepEqual(second, report, 'the evaluation must be deterministic');

console.log('test-grounded-memory: all checks passed.');
