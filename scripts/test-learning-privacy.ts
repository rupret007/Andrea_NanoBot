import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  upsertReliabilityObservation,
} from '../src/db.js';
import {
  beginCognitiveExecutiveTurn,
  finalizeCognitiveExecutiveTurn,
} from '../src/cognitive-executive.js';
import { buildLearningDistillationReport } from '../src/memory-distillation.js';
import { buildSkillLibraryReport } from '../src/skill-library.js';
import type { ReliabilityObservation } from '../src/types.js';

_initTestDatabase();

const now = '2026-06-07T18:20:00.000Z';
const secretish =
  'save this sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 raw private body text';

const context = beginCognitiveExecutiveTurn({
  rawAsk: 'save that for later',
  channel: 'telegram',
  groupFolder: 'main',
  turnId: 'privacy-turn',
  now: new Date(now),
});
assert.ok(context);
finalizeCognitiveExecutiveTurn({
  context,
  status: 'failed',
  resultSummary: secretish,
  failureSummary: secretish,
  nextAction: secretish,
  blockerClass: 'privacy-test',
  fallbackUsed: true,
  now: new Date(now),
});

const observation: ReliabilityObservation = {
  observationId: 'privacy-observation',
  subjectId: 'provider:openai_cloud',
  observedAt: now,
  sourceKind: 'provider_health',
  outcome: 'blocked',
  failureClass: 'quota_or_rate_limit',
  confidence: 0.5,
  fallbackUsed: true,
  latencyMs: null,
  summary: secretish,
  nextAction: secretish,
  evidenceIdsJson: JSON.stringify(['privacy-observation']),
  privacyJson: JSON.stringify({ metadataOnly: true }),
};
upsertReliabilityObservation(observation);

const learning = buildLearningDistillationReport({
  groupFolder: 'main',
  now: new Date(now),
});
const skills = buildSkillLibraryReport({
  groupFolder: 'main',
  now: new Date(now),
});
const serialized = JSON.stringify({ learning, skills });

assert.doesNotMatch(
  serialized,
  /sk-proj-|abcdefghijklmnopqrstuvwxyz1234567890|raw private body text|hidden reasoning|Bearer\s+/i,
);
assert.match(serialized, /metadataOnly/);

console.log('learning privacy tests passed');

_closeDatabase();
