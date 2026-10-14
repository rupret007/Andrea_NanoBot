import assert from 'node:assert/strict';

import '../src/channels/index.js';

import {
  _closeDatabase,
  _initTestDatabase,
  listAgiGauntletResults,
} from '../src/db.js';
import {
  formatAgiReadinessReport,
  runAgiGauntlet,
} from '../src/agi-gauntlet.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../src/runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from '../src/runtime-capability-registry.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);
_initTestDatabase();

const report = runAgiGauntlet({ now: '2026-06-09T18:00:00.000Z' });

// All ten supported scenarios ran after retiring the Alexa handoff scenario.
assert.equal(report.results.length, 10);

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
assert.equal(byId.get('optional_surface_boundary')?.score, 1);
assert.match(
  byId.get('optional_surface_boundary')?.detail ?? '',
  /daily_core_attention=0; optional_surface=telegram\.user_session; optional_state=missing_config; configured_optional_state=live_proven; operator_attention=1/,
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
