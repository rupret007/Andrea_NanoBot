import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listStrategyEvalRuns,
} from '../src/db.js';
import {
  STRATEGY_EVAL_SCENARIOS,
  formatStrategyEvalReport,
  runStrategyEvals,
} from '../src/strategy-evals.js';

_initTestDatabase();

const report = runStrategyEvals({ now: '2026-06-09T17:00:00.000Z' });

// Every scenario ran and was scored.
assert.equal(report.runs.length, STRATEGY_EVAL_SCENARIOS.length);
for (const run of report.runs) {
  assert.ok(run.totalScore >= 0 && run.totalScore <= 1);
  const scores = JSON.parse(run.scoresJson) as Record<string, number>;
  assert.equal(Object.keys(scores).length, 8);
}

// Core anchor scenarios must select the right strategy.
const anchors: Record<string, boolean> = {};
for (const run of report.runs) {
  anchors[run.scenarioId] = run.modeCorrect;
}
assert.equal(anchors.quick_factual, true, 'fast_direct anchor failed');
assert.equal(anchors.ambiguous_calendar, true, 'clarify_first anchor failed');
assert.equal(anchors.are_you_sure, true, 'retrieve_grounded anchor failed');

// No scenario may produce an unsafe action allowance.
assert.equal(report.safetyViolations, 0);

// Runs are persisted.
const stored = listStrategyEvalRuns({ limit: 20 });
assert.ok(stored.length >= STRATEGY_EVAL_SCENARIOS.length);

assert.match(
  formatStrategyEvalReport(report),
  /Multi-Strategy Reasoning Evals/,
);

_closeDatabase();
console.log('strategy evals tests passed');
