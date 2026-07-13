import assert from 'node:assert/strict';

import {
  buildCouncilTaskEaseReport,
  formatCouncilTaskEaseReport,
} from '../src/council-task-drills.js';
import {
  calibrateCouncilMode,
  recordCouncilRunLedger,
} from '../src/council-quality.js';
import { _initTestDatabase, getCouncilRunLedger } from '../src/db.js';
import type { AndreaPlatformProviderCouncilResult } from '../src/andrea-platform-bridge.js';

_initTestDatabase();

const now = new Date('2026-06-07T13:05:00.000Z');
const structuredVerdict: NonNullable<
  AndreaPlatformProviderCouncilResult['structuredVerdict']
> = {
  status: 'pass',
  recommendedAction: 'answer',
  confidence: 0.9,
  evidenceGrade: 'partial',
  approvalNeed: 'none',
  riskFlags: [],
  evidenceIds: ['fixture:council-task'],
  usableMemberCount: 1,
  blockedMemberCount: 0,
  schemaStatusSummary: { valid: 1, repaired: 0, invalid_fallback: 0 },
  budget: {
    mode: 'single_model',
    maxRoles: 2,
    roleTimeoutMs: 12_000,
    maxRetries: 0,
    maxConcurrency: 1,
    fallbackAllowed: false,
    estimatedCostTier: 'low',
    usedRoles: 1,
    retryCount: 0,
    loopGuardTriggered: false,
    status: 'within_budget',
  },
  replaySummary: 'Synthetic council task fixture with redacted metadata.',
  replayArtifact: {
    replaySummary: 'Synthetic council task fixture with redacted metadata.',
    memberStatuses: [
      {
        memberId: 'fixture-planner',
        providerId: 'fixture-provider',
        role: 'planner',
        status: 'completed',
        verdict: 'pass',
        confidence: 0.9,
        schemaStatus: 'valid',
        schemaIssues: [],
        evidenceIds: ['fixture:council-task'],
        riskFlags: [],
      },
    ],
  },
};
recordCouncilRunLedger({
  councilRunId: 'council-task-isolated-fixture',
  taskFamily: 'assistant',
  channel: 'system',
  requestedMode: 'single_model',
  chosenMode: 'single_model',
  calibration: calibrateCouncilMode({
    taskFamily: 'assistant',
    requestedMode: 'single_model',
  }),
  structuredVerdict,
  riskFlags: [],
  now: now.toISOString(),
});

const json = process.argv.includes('--json');
const report = buildCouncilTaskEaseReport({
  now,
  recordOutcomeSignal: true,
});
assert.notEqual(report.status, 'fail');
assert.equal(
  getCouncilRunLedger('council-task-isolated-fixture')?.outcomeSignalCount,
  1,
);
assert.doesNotMatch(
  report.nextAction,
  /attach a sanitized task outcome signal/i,
);

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(formatCouncilTaskEaseReport(report));
}

if (report.status === 'fail') {
  process.exitCode = 1;
}
