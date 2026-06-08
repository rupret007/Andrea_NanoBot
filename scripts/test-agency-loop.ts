import assert from 'node:assert/strict';

import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  runAgencyConvergenceLoop,
  formatAgencyConvergenceDoctorReport,
} from '../src/agency-convergence-loop.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-07T01:10:00.000Z';
const FORBIDDEN_TEXT = [
  'raw private body text',
  'provider debate text',
  'hidden reasoning text',
];

beginAgentRuntimeSpineRun({
  turnId: 'agency-loop-seed-safe',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Inspect current proof debt and choose the safest read-only status check.',
  generatedAt,
  mode: 'assistive',
});

const report = await runAgencyConvergenceLoop({
  generatedAt: '2026-06-07T01:10:01.000Z',
  mode: 'assistive',
  liveProviderProbe: false,
});
const text = formatAgencyConvergenceDoctorReport(report);

assert.ok(report.latestRun, 'agency loop should persist a latest run');
assert.ok(report.agendas.length >= 1, 'agency loop should persist an agenda');
assert.ok(report.decisions.length >= 1, 'agency loop should persist a decision');
assert.ok(report.providerPlans.length >= 1, 'agency loop should persist provider plan');
assert.ok(report.outcomes.length >= 1, 'agency loop should persist outcome');
assert.equal(report.privacy.metadataOnly, true);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.equal(report.privacy.secretsRedacted, true);
const sourceIds = JSON.parse(report.latestRun.sourceIdsJson || '[]');
assert.ok(Array.isArray(sourceIds), 'sourceIdsJson should stay parseable');
assert.ok(sourceIds.length >= 1, 'sourceIdsJson should preserve replay links');
assert.ok(
  sourceIds.every((id) => !String(id).includes('[REDACTED_SECRET]')),
  'internal replay IDs should not be destroyed by prose redaction',
);

const agenda = report.agendas[0];
const outcome = report.outcomes[0];
if (agenda.policyClass === 'read_only') {
  assert.ok(
    report.latestRun?.runtimeRunId,
    'read-only agency action should become a Runtime Spine run',
  );
  assert.ok(
    report.latestRun?.cognitiveRunId,
    'read-only agency action should link a cognitive run',
  );
  assert.ok(
    report.latestRun?.truthAuditId,
    'read-only agency action should link truth audit',
  );
  assert.equal(outcome.status, 'completed');
} else {
  assert.ok(
    agenda.policyClass === 'manual_proof' ||
      agenda.policyClass === 'approval_staged' ||
      agenda.policyClass === 'inspect_only',
    'non-read-only action should be explicitly classified',
  );
  assert.ok(!report.latestRun?.runtimeRunId, 'blocked/manual action should not fake execution');
}
const serialized = JSON.stringify({
  latestRun: report.latestRun,
  agendas: report.agendas,
  decisions: report.decisions,
  outcomes: report.outcomes,
  text,
});
for (const forbidden of FORBIDDEN_TEXT) {
  assert.ok(!serialized.includes(forbidden), `should not include ${forbidden}`);
}

console.log(
  JSON.stringify(
    {
      status: 'pass',
      run: report.latestRun?.convergenceRunId,
      policy: agenda.policyClass,
      outcome: outcome.status,
      runtimeRunId: report.latestRun?.runtimeRunId || null,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
