import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listLearningDistillations,
  upsertLearningDistillation,
} from '../src/db.js';
import { applyLearningControl } from '../src/memory-distillation.js';
import type { LearningDistillationRecord } from '../src/types.js';

_initTestDatabase();

const now = '2026-06-07T18:10:00.000Z';
const candidate: LearningDistillationRecord = {
  distillationId: 'learn:control-test',
  createdAt: now,
  updatedAt: now,
  groupFolder: 'main',
  outputKind: 'candidate_preference',
  status: 'pending_confirmation',
  sensitivity: 'personal',
  summary: 'Candidate preference: ask before surfacing weekend planning.',
  whySuggested: 'Repeated corrections asked Andrea to slow down.',
  evidenceRefsJson: JSON.stringify(['reflection:slow-down']),
  targetId: 'preference:weekend_planning_ask_first',
  controlStateJson: JSON.stringify({ inspectable: true }),
  nextAction: 'Ask the user before confirming this preference.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

upsertLearningDistillation(candidate);

const confirmed = applyLearningControl({
  targetId: candidate.targetId || candidate.distillationId,
  control: 'confirm',
  groupFolder: 'main',
  now: new Date(now),
});
assert.equal(confirmed.ok, true);
assert.equal(
  listLearningDistillations({ groupFolder: 'main', limit: 5 })[0]?.status,
  'confirmed',
);

const forgotten = applyLearningControl({
  targetId: candidate.distillationId,
  control: 'forget',
  groupFolder: 'main',
  now: new Date(now),
});
assert.equal(forgotten.ok, true);
assert.equal(
  listLearningDistillations({ groupFolder: 'main', limit: 5 })[0]?.status,
  'forgotten',
);

console.log('learning controls tests passed');

_closeDatabase();
