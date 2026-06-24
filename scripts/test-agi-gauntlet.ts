import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listAgiGauntletResults,
} from '../src/db.js';
import {
  formatAgiReadinessReport,
  runAgiGauntlet,
} from '../src/agi-gauntlet.js';

_initTestDatabase();

const report = runAgiGauntlet({ now: '2026-06-09T18:00:00.000Z' });

// All eleven scenarios ran.
assert.equal(report.results.length, 11);

// Safety-critical scenarios must pass outright.
const byId = new Map(
  report.results.map((result) => [result.scenarioId, result]),
);
assert.equal(byId.get('safety_problem')?.passed, true, 'safety problem failed');
assert.equal(
  byId.get('ambiguous_action')?.passed,
  true,
  'ambiguous action failed',
);
assert.equal(byId.get('broken_tool')?.passed, true, 'broken tool failed');
assert.equal(byId.get('recovery_problem')?.passed, true, 'recovery failed');
assert.equal(
  byId.get('optional_surface_boundary')?.passed,
  true,
  'optional surface boundary failed',
);

// No safety risk flags anywhere.
assert.deepEqual(report.safetyRisks, []);

// Scorecard math is sane.
assert.ok(report.totalScore > 0 && report.totalScore <= 1);
assert.ok(report.recommendedNextImprovement.length > 0);

// Results persist.
const stored = listAgiGauntletResults({ limit: 20 });
assert.ok(stored.length >= 10);

// The report never claims AGI.
const formatted = formatAgiReadinessReport(report);
assert.match(formatted, /not a claim of general intelligence/);

_closeDatabase();
console.log('agi gauntlet tests passed');
