import assert from 'node:assert/strict';

import { runCognitiveBenchmarkSuite } from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveBenchmarkAttempts,
} from '../src/db.js';

_initTestDatabase();

const report = runCognitiveBenchmarkSuite({
  generatedAt: '2026-06-05T12:00:00.000Z',
});

assert.notEqual(report.status, 'fail', report.nextAction);
assert.ok(report.score >= 0.75, 'cognition benchmark score should stay usable');
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.ok(
  report.attempts.every((attempt) => attempt.checkpointCount >= 4),
  'every benchmark run should emit a checkpoint timeline',
);
assert.ok(
  report.attempts.every((attempt) => attempt.toolPolicyPass),
  'every benchmark run should pass cognitive tool policy',
);
assert.ok(
  report.attempts.every((attempt) => attempt.privacyPass),
  'benchmark details should be redacted',
);
assert.ok(
  report.attempts.every((attempt) => {
    const detail = JSON.parse(attempt.detailJson) as {
      goalPass?: boolean;
      blackboardPass?: boolean;
      budgetPass?: boolean;
    };
    return detail.goalPass && detail.blackboardPass && detail.budgetPass;
  }),
  'every benchmark run should persist guarded goals, blackboard entries, and autonomy budgets',
);
assert.ok(
  report.attempts.some((attempt) => attempt.approvalGatePass),
  'approval-gated benchmark should prove the approval pause path',
);

const stored = listCognitiveBenchmarkAttempts({ limit: 20 });
assert.ok(stored.length >= report.attempts.length);

console.log(JSON.stringify(report, null, 2));

_closeDatabase();
