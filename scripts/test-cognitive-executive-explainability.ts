import assert from 'node:assert/strict';

import {
  beginCognitiveExecutiveTurn,
  finalizeCognitiveExecutiveTurn,
  formatLatestCognitiveExecutiveExplanation,
  buildCognitiveExecutiveStatusText,
} from '../src/cognitive-executive.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const context = beginCognitiveExecutiveTurn({
  rawAsk: 'what should I do next?',
  channel: 'telegram',
  groupFolder: 'main',
  chatJid: 'telegram:main',
  turnId: 'explain:next-action',
  now: new Date('2026-06-07T11:40:00.000Z'),
});

assert.ok(context, 'executive context should exist');
finalizeCognitiveExecutiveTurn({
  context,
  status: 'handled',
  resultSummary: 'Suggested the highest-value next action.',
  nextAction: 'Take the smallest reversible next step.',
  now: new Date('2026-06-07T11:40:01.000Z'),
});

const explanation = formatLatestCognitiveExecutiveExplanation();
const status = buildCognitiveExecutiveStatusText();

assert.match(explanation, /I chose/);
assert.match(explanation, /Next:/);
assert.match(status, /Cognitive Executive/);
assert.match(status, /Privacy: metadata-only/);
assert.doesNotMatch(
  `${explanation}\n${status}`,
  /raw private body text|provider debate text|hidden reasoning text|chain-of-thought|sk-|AIza/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      route: context?.plan.routeKey,
      explanation,
    },
    null,
    2,
  ),
);

_closeDatabase();
