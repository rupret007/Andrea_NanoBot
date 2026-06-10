import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  analyzeMetacognitiveTurn,
  formatMetacognitionNaturalResponse,
  formatMetacognitionReport,
  isMetacognitionNaturalRequest,
} from '../src/metacognition.js';

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
assert.ok(sure.warnings.some((warning) => warning.warningKind === 'user_uncertainty_check'));

assert.equal(isMetacognitionNaturalRequest('what context are you using?'), true);
assert.match(formatMetacognitionNaturalResponse('are you sure?'), /confidence/i);
assert.match(formatMetacognitionReport(), /Metacognition/);

_closeDatabase();
console.log('metacognition tests passed');
