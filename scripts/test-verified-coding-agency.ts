import assert from 'node:assert/strict';

import {
  formatVerifiedCodingAgencyEvalReport,
  runVerifiedCodingAgencyEval,
} from '../src/verified-coding-agency-eval.js';

const report = runVerifiedCodingAgencyEval();
process.stdout.write(`${formatVerifiedCodingAgencyEvalReport(report)}\n`);
assert.ok(
  report.scenarioCount >= 30,
  'at least 30 frozen scenarios are required',
);
assert.equal(
  report.failCount,
  0,
  `failed: ${report.invariantFailures.join(', ')}`,
);
assert.equal(report.passed, true);
assert.deepEqual(
  runVerifiedCodingAgencyEval(),
  report,
  'evaluation output must be deterministic across repeated runs',
);
process.stdout.write('test-verified-coding-agency: all checks passed.\n');
