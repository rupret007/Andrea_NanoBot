import assert from 'node:assert/strict';

import { runHarnessLab } from '../src/harness-lab.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listHarnessScorecards,
  listHarnessTrajectories,
} from '../src/db.js';

_initTestDatabase();

const report = runHarnessLab({ generatedAt: '2026-06-06T20:45:00.000Z' });
const storedTrajectories = listHarnessTrajectories({ limit: 50 });
const storedScorecards = listHarnessScorecards({ limit: 50 });

assert.equal(report.tasks.length, 9, 'harness should cover all planned task families');
assert.ok(report.trajectories.length >= 8, 'harness should persist trajectories');
assert.ok(report.scorecards.length >= 8, 'harness should score trajectories');
assert.ok(storedTrajectories.length >= report.trajectories.length);
assert.ok(storedScorecards.length >= report.scorecards.length);
assert.ok(report.averageScore > 0.55, 'harness should produce useful baseline scores');
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.ok(
  report.scorecards.every((scorecard) => scorecard.privacyScore === 1),
  'scorecards should preserve privacy safety',
);

const serialized = JSON.stringify(report);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      tasks: report.tasks.length,
      trajectories: report.trajectories.length,
      scorecards: report.scorecards.length,
      averageScore: report.averageScore,
      proposals: report.proposals.length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
