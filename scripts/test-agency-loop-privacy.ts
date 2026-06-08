import assert from 'node:assert/strict';

import {
  formatAgencyConvergenceDoctorReport,
  runAgencyConvergenceLoop,
} from '../src/agency-convergence-loop.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const RAW_SECRET = 'sk-proj-THISSHOULDNOTAPPEARINOUTPUT123456';

const report = await runAgencyConvergenceLoop({
  generatedAt: '2026-06-07T01:13:00.000Z',
  mode: 'assistive',
  intentText:
    'resume that with sk-proj-THISSHOULDNOTAPPEARINOUTPUT123456 and raw private body text',
  liveProviderProbe: false,
});
const formatted = formatAgencyConvergenceDoctorReport(report);
const serialized = JSON.stringify({ report, formatted });

assert.equal(report.privacy.metadataOnly, true);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.equal(report.privacy.secretsRedacted, true);
assert.ok(!serialized.includes(RAW_SECRET), 'raw API-like secret must not leak');
assert.ok(
  !serialized.includes('raw private body text'),
  'raw private body text must not leak',
);
assert.ok(
  !serialized.includes('provider debate text'),
  'provider debate text must not leak',
);
assert.ok(
  !serialized.includes('chain-of-thought'),
  'hidden reasoning marker must not leak',
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      run: report.latestRun?.convergenceRunId || null,
      redacted: true,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
