import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  analyzeMetacognitiveTurn,
  formatMetacognitionNaturalResponse,
  formatMetacognitionReport,
  isMetacognitionNaturalRequest,
} from '../src/metacognition.js';
import type { CognitiveWorldSnapshotItem } from '../src/types.js';

_initTestDatabase();

const simple = analyzeMetacognitiveTurn({
  rawAsk: "don't overthink it, quick answer: should I drink water?",
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:05:00.000Z',
});
assert.equal(simple.mode, 'fast_direct');

const calendar = analyzeMetacognitiveTurn({
  rawAsk: 'add that to my calendar',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:06:00.000Z',
});
assert.equal(calendar.mode, 'clarify_first');
assert.equal(calendar.calibration.actionAllowed, 'clarify');

const sure = analyzeMetacognitiveTurn({
  rawAsk: 'are you sure?',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:07:00.000Z',
});
assert.equal(sure.mode, 'retrieve_grounded');
assert.ok(
  sure.warnings.some(
    (warning) => warning.warningKind === 'user_uncertainty_check',
  ),
);

const highPrioritySnapshotItem: CognitiveWorldSnapshotItem = {
  itemId: 'snapshot:urgent-mission',
  itemKind: 'mission',
  sourceId: 'mission:urgent',
  sourceIdsJson: '["mission:urgent"]',
  summary: 'Urgent mission should stay salient.',
  freshness: 'fresh',
  confidence: 0.91,
  priority: 0.94,
  reasonUsed: 'regression fixture for priority salience',
};
const salience = analyzeMetacognitiveTurn({
  rawAsk: 'what should stay in focus?',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:08:00.000Z',
  persist: false,
  snapshotItems: [highPrioritySnapshotItem],
});
const urgentMissionMemory = salience.items.find(
  (item) => item.sourceId === 'mission:urgent',
);
assert.equal(urgentMissionMemory?.relevance, 0.94);

assert.equal(
  isMetacognitionNaturalRequest('what context are you using?'),
  true,
);
assert.match(
  formatMetacognitionNaturalResponse('are you sure?'),
  /confidence/i,
);
assert.match(formatMetacognitionReport(), /Metacognition/);

_closeDatabase();
console.log('metacognition tests passed');
