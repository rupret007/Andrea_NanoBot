import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listLearningDistillations,
} from '../src/db.js';
import {
  beginCognitiveExecutiveTurn,
  finalizeCognitiveExecutiveTurn,
} from '../src/cognitive-executive.js';
import {
  buildLearningDistillationReport,
  parseLearningDefaultRequest,
} from '../src/memory-distillation.js';

_initTestDatabase();

const now = '2026-06-07T18:00:00.000Z';

function saveLaterTurn(id: string, text: string) {
  const context = beginCognitiveExecutiveTurn({
    rawAsk: text,
    channel: 'telegram',
    groupFolder: 'main',
    turnId: id,
    now: new Date(now),
  });
  assert.ok(context, 'save-for-later ask should enter executive loop');
  finalizeCognitiveExecutiveTurn({
    context,
    status: 'handled',
    resultSummary: text,
    nextAction: 'Offer tomorrow morning as the default follow-up.',
    now: new Date(now),
  });
}

saveLaterTurn('save-later-1', 'save that for later');
saveLaterTurn('save-later-2', 'save this reminder for later');

const report = buildLearningDistillationReport({
  groupFolder: 'main',
  now: new Date(now),
});

const skillCandidate = report.candidates.find(
  (item) =>
    item.outputKind === 'skill' && item.targetId?.includes('save_for_later'),
);
assert.ok(skillCandidate, 'repeated save-for-later should suggest a skill');
assert.equal(skillCandidate?.status, 'suggested');
assert.match(skillCandidate?.whySuggested || '', /recent executive outcomes/);

const stored = listLearningDistillations({ groupFolder: 'main', limit: 20 });
assert.ok(
  stored.some((item) => item.distillationId === skillCandidate?.distillationId),
);
assert.doesNotMatch(
  JSON.stringify(report),
  /sk-|AIza|Bearer\s+|raw private body|hidden reasoning/i,
);

const unresolvedDefault = parseLearningDefaultRequest(
  'make this my default for dinner planning',
);
assert.deepEqual(unresolvedDefault, {
  reference: 'this',
  topic: 'dinner planning',
  objectClear: false,
  clarificationQuestion:
    'What exact behavior should become your default for dinner planning? I will keep it proposed for review before activation.',
});
assert.equal(
  parseLearningDefaultRequest('make this my default'),
  null,
  'a default request without a domain remains outside this bounded parser',
);

console.log('memory distillation tests passed');

_closeDatabase();
