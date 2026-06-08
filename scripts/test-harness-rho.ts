import assert from 'node:assert/strict';

import {
  runHarnessLab,
  runRhoHarnessReplay,
} from '../src/harness-lab.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T21:00:00.000Z';
const baseline = runHarnessLab({ generatedAt });
const replay = runRhoHarnessReplay({ generatedAt });

assert.ok(replay.scorecards.length >= baseline.scorecards.length);
assert.ok(
  replay.proposals.every((proposal) => proposal.status === 'candidate'),
  'RHO-style proposals must remain candidate-only',
);
assert.ok(
  replay.proposals.every((proposal) => proposal.safetyRegression === false),
  'candidate improvements cannot introduce safety regressions',
);
assert.equal(replay.privacy.rawPromptsStored, false);
assert.equal(replay.privacy.rawPrivateBodiesStored, false);
assert.equal(replay.privacy.hiddenReasoningStored, false);

const serialized = JSON.stringify({ baseline, replay });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      baselineScorecards: baseline.scorecards.length,
      replayScorecards: replay.scorecards.length,
      proposals: replay.proposals.length,
      averageScore: replay.averageScore,
      nextAction: replay.nextAction,
      privacy: replay.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
