import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import { analyzeMetacognitiveTurn, formatDeliberationReport } from '../src/metacognition.js';

_initTestDatabase();

const deep = analyzeMetacognitiveTurn({
  rawAsk: 'think harder about what should I do next with Andrea',
  channel: 'telegram',
  groupFolder: 'main',
  now: '2026-06-09T20:10:00.000Z',
});

assert.equal(deep.mode, 'deliberate_with_critic');
assert.equal(deep.deliberation.status, 'completed');
assert.equal(deep.deliberation.hiddenReasoningStored, false);
assert.match(deep.deliberation.criticObjectionsJson, /stale_context|tool_unavailable|conflicting_context|proof/i);
assert.match(formatDeliberationReport(), /Hidden reasoning stored: no/);

const send = analyzeMetacognitiveTurn({
  rawAsk: '@Andrea send it later tonight',
  channel: 'bluebubbles',
  groupFolder: 'main',
  now: '2026-06-09T20:11:00.000Z',
});
assert.equal(send.mode, 'verify_then_act');
assert.equal(send.deliberation.approvalRequired, true);

_closeDatabase();
console.log('deliberation tests passed');
