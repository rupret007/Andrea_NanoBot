import assert from 'node:assert/strict';

import { runHarnessLab } from '../src/harness-lab.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listHarnessScorecards,
  listHarnessTrajectories,
  listTruthAnswerAudits,
} from '../src/db.js';

_initTestDatabase();

const report = runHarnessLab({ generatedAt: '2026-06-06T22:30:00.000Z' });
const truthTask = report.tasks.find((task) => task.taskFamily === 'truth');
assert.ok(truthTask, 'harness should include a truth task family');

const truthTrajectory = report.trajectories.find(
  (trajectory) => trajectory.taskId === truthTask.taskId,
);
assert.ok(truthTrajectory, 'truth task should persist a trajectory');
assert.equal(
  truthTrajectory.status,
  'pass',
  'truth trajectory should pass when adversarial overclaims are caught',
);

const truthScorecard = report.scorecards.find(
  (scorecard) => scorecard.trajectoryId === truthTrajectory.trajectoryId,
);
assert.ok(truthScorecard, 'truth trajectory should have a scorecard');
assert.ok(
  (truthScorecard.claimSupportScore || 0) >= 0.8,
  'truth scorecard should grade claim support',
);
assert.ok(
  (truthScorecard.calibrationScore || 0) >= 0.8,
  'truth scorecard should grade calibration',
);
assert.ok(
  (truthScorecard.approvalIntegrityScore || 0) >= 0.8,
  'truth scorecard should preserve approval integrity',
);

const persistedTrajectories = listHarnessTrajectories({ limit: 50 });
const persistedScorecards = listHarnessScorecards({ limit: 50 });
const truthAudits = listTruthAnswerAudits({ limit: 20 });

assert.ok(
  persistedTrajectories.some(
    (trajectory) => trajectory.trajectoryId === truthTrajectory.trajectoryId,
  ),
  'truth trajectory should be persisted',
);
assert.ok(
  persistedScorecards.some(
    (scorecard) => scorecard.trajectoryId === truthTrajectory.trajectoryId,
  ),
  'truth scorecard should be persisted',
);
assert.ok(truthAudits.length >= 1, 'truth harness should persist a truth audit');

const serialized = JSON.stringify({ report, persistedTrajectories, truthAudits });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      tasks: report.tasks.length,
      truthTrajectory: truthTrajectory.status,
      truthScore: truthScorecard.totalScore,
      claimSupportScore: truthScorecard.claimSupportScore,
      calibrationScore: truthScorecard.calibrationScore,
      truthAudits: truthAudits.length,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
