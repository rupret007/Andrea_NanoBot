import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase, listStrategyLearningSignals } from '../src/db.js';
import { analyzeMetacognitiveTurn } from '../src/metacognition.js';

_initTestDatabase();

const grounded = analyzeMetacognitiveTurn({
  rawAsk: 'what is true right now?',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:15:00.000Z',
});
assert.ok(grounded.calibration.score >= 0 && grounded.calibration.score <= 1);
assert.ok(['low', 'medium', 'high', 'blocked'].includes(grounded.calibration.label));
assert.match(grounded.calibration.reason, /reality=/);

const risky = analyzeMetacognitiveTurn({
  rawAsk: 'send the calendar update and push the fix',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:16:00.000Z',
});
assert.equal(risky.mode, 'verify_then_act');
assert.equal(risky.calibration.actionAllowed, 'approval_only');
assert.ok(risky.warnings.some((warning) => warning.warningKind === 'high_risk_action'));

const signals = listStrategyLearningSignals({ limit: 10 });
assert.ok(signals.some((signal) => signal.frameId === risky.frame.frameId));
assert.doesNotMatch(JSON.stringify(signals), /hidden reasoning|chain-of-thought/i);

_closeDatabase();
console.log('confidence calibration tests passed');
