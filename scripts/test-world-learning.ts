import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listWorldFacts,
  upsertReliabilityObservation,
} from '../src/db.js';
import { buildLearningDistillationReport } from '../src/memory-distillation.js';
import { buildWorldModelReport } from '../src/world-model.js';
import type { ReliabilityObservation } from '../src/types.js';

_initTestDatabase();

const now = '2026-06-07T18:15:00.000Z';
const observation: ReliabilityObservation = {
  observationId: 'obs:bluebubbles-down',
  subjectId: 'integration:bluebubbles',
  observedAt: now,
  sourceKind: 'integration_doctor',
  outcome: 'degraded',
  failureClass: 'needs_proof',
  confidence: 0.8,
  fallbackUsed: true,
  latencyMs: null,
  summary: 'BlueBubbles transport is up but same-thread proof is missing.',
  nextAction: 'Use Telegram fallback until proof is fresh.',
  evidenceIdsJson: JSON.stringify(['integration:bluebubbles']),
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

upsertReliabilityObservation(observation);
const learning = buildLearningDistillationReport({
  groupFolder: 'main',
  now: new Date(now),
});
assert.ok(
  learning.worldFacts.some((fact) => fact.factType === 'tool_health'),
  'degraded tool observation should become a suggested world fact',
);

const world = buildWorldModelReport({
  generatedAt: now,
  persist: false,
});
assert.ok(
  world.learnedFacts.some((fact) => fact.summary.includes('bluebubbles')),
  'world report should include learned facts',
);
assert.ok(listWorldFacts({ groupFolder: 'main', limit: 5 }).length >= 1);
assert.doesNotMatch(
  JSON.stringify(world.learnedFacts),
  /sk-|AIza|Bearer\s+|raw private body/i,
);

console.log('world learning tests passed');

_closeDatabase();
