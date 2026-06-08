import assert from 'node:assert/strict';

import {
  beginCognitiveExecutiveTurn,
  detectCognitiveExecutiveIntent,
} from '../src/cognitive-executive.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const now = new Date('2026-06-07T11:10:00.000Z');
const scenarios = [
  ['what should I do next?', 'next_action'],
  ['what am I forgetting?', 'loose_ends'],
  ['help me plan tonight', 'plan_tonight'],
  ["what's still open?", 'open_loops'],
  ['what should I say back?', 'reply_help'],
  ['save that for later', 'save_for_later'],
  ["what's on my list?", 'list_status'],
  ['handle this for me', 'ambiguous_action'],
] as const;

for (const [text, expected] of scenarios) {
  const detected = detectCognitiveExecutiveIntent(text);
  assert.equal(
    detected.family,
    expected,
    `${text} should classify as ${expected}`,
  );
  assert.ok(
    detected.confidence >= 0.8,
    `${text} should have confident routing`,
  );
  const context = beginCognitiveExecutiveTurn({
    rawAsk: text,
    channel: 'telegram',
    groupFolder: 'main',
    chatJid: 'telegram:main',
    turnId: `route:${expected}`,
    now,
  });
  assert.ok(context, `${text} should create executive context`);
  assert.equal(context?.request.intentFamily, expected);
  assert.notEqual(context?.plan.selectedRoute, 'unsupported');
}

const ambiguous = beginCognitiveExecutiveTurn({
  rawAsk: 'handle this for me',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  turnId: 'route:ambiguous',
  now,
});
assert.equal(ambiguous?.plan.selectedRoute, 'clarify');
assert.equal(ambiguous?.plan.approvalRequired, false);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      scenarios: scenarios.length,
      ambiguousRoute: ambiguous?.plan.selectedRoute,
    },
    null,
    2,
  ),
);

_closeDatabase();
