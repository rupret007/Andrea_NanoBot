import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listCapabilityStates,
} from '../src/db.js';
import {
  buildCapabilitySelfModel,
  formatCapabilityNaturalResponse,
  formatCapabilityReport,
  isCapabilityNaturalRequest,
} from '../src/capability-self-model.js';

_initTestDatabase();

const report = buildCapabilitySelfModel({ now: '2026-06-09T16:00:00.000Z' });
assert.ok(report.states.length >= 8);

// Internal capabilities are proven by construction.
const draft = report.states.find(
  (state) => state.capabilityId === 'messages.draft',
);
assert.ok(draft);
assert.equal(draft.proofStatus, 'live_proven');
assert.equal(draft.approvalRequirement, 'none');

// Missing config is classified as external/config debt — never repo failure.
const userSession = report.states.find(
  (state) => state.capabilityId === 'telegram.user_session',
);
assert.ok(userSession);
if (!process.env.TELEGRAM_USER_API_ID || !process.env.TELEGRAM_USER_API_HASH) {
  assert.equal(userSession.proofStatus, 'missing_config');
  assert.match(userSession.currentBlocker ?? '', /external\/config debt/);
  assert.equal(userSession.enabled, false);
}

// External sends always require explicit approval regardless of proof.
for (const id of [
  'messages.send.telegram',
  'messages.send.bluebubbles',
  'calendar.write',
]) {
  const state = report.states.find((item) => item.capabilityId === id);
  assert.ok(state, `missing capability ${id}`);
  assert.notEqual(state.approvalRequirement, 'none');
  assert.ok(state.autonomyLevel >= 5);
}

// Config is stored by name only — no values.
for (const state of report.states) {
  assert.ok(!/=/.test(state.requiredConfig));
}

// States persist and round-trip.
const stored = listCapabilityStates({ limit: 50 });
assert.ok(stored.length >= 8);

assert.match(formatCapabilityReport(report), /Capability Self-Model/);
assert.equal(
  isCapabilityNaturalRequest('what can you actually do today?'),
  true,
);
assert.equal(isCapabilityNaturalRequest('can you send texts?'), true);
assert.equal(isCapabilityNaturalRequest("why didn't you send it?"), true);

const sendAnswer = formatCapabilityNaturalResponse('can you send texts?');
assert.match(sendAnswer, /approval/i);

const brokenAnswer = formatCapabilityNaturalResponse("what's broken?");
assert.ok(brokenAnswer.length > 0);

_closeDatabase();
console.log('capability self-model tests passed');
