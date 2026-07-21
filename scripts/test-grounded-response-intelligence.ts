import assert from 'node:assert/strict';

import {
  formatGroundedResponseEvalReport,
  GROUNDED_RESPONSE_FIXTURES,
  runGroundedResponseIntelligenceEval,
} from '../src/grounded-response-intelligence-eval.js';

const report = runGroundedResponseIntelligenceEval();
console.log(formatGroundedResponseEvalReport(report));

assert.ok(
  GROUNDED_RESPONSE_FIXTURES.length >= 30,
  'at least 30 frozen scenarios are required',
);
assert.equal(report.scenarioCount, GROUNDED_RESPONSE_FIXTURES.length);
assert.equal(
  report.passed,
  true,
  `acceptance gates failed: ${JSON.stringify(report.gates)}`,
);
assert.ok(
  report.improvementPoints >= 15,
  'assistive quality must improve by at least 15 points',
);
assert.ok(
  report.scenarios.every((scenario) => scenario.repairAttempts <= 1),
  'no scenario may use more than one repair',
);

console.log('');
console.log('test-grounded-response-intelligence: all checks passed.');
