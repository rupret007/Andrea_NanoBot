import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listGroundedBeliefJournal,
  listGroundedCalibrationSamples,
  listGroundedDecisionJournal,
  listGroundedLearningRecords,
} from '../src/db.js';
import {
  formatGroundedExecutiveEvalReport,
  GROUNDED_EVAL_BASELINE,
  runGroundedExecutiveEval,
} from '../src/grounded-executive-eval.js';
import {
  applyGroundedOutcome,
  beginGroundedExecutive,
  decideGroundedNextStep,
  deriveGroundedLearning,
  formatGroundedDiagnostics,
  groundedExecutiveDiagnostics,
} from '../src/grounded-cognitive-executive.js';
import {
  acceptGroundedLearningRecord,
  loadGroundedLearningForPlanning,
  persistGroundedLearning,
  persistGroundedTurnJournal,
  retireGroundedLearningRecord,
} from '../src/grounded-executive-durable-adapter.js';

const NOW = '2026-07-20T12:00:00.000Z';
const LATER = '2026-07-20T12:00:05.000Z';

function runEvalSuite(): void {
  const report = runGroundedExecutiveEval();
  console.log(formatGroundedExecutiveEvalReport(report));
  console.log('');
  assert.equal(
    report.scenarios.length,
    Object.keys(GROUNDED_EVAL_BASELINE).length,
    'every baseline scenario must run',
  );
  const failed = report.scenarios.filter((scenario) => !scenario.correct);
  assert.equal(
    report.failCount,
    0,
    `all scenarios must pass; failed: ${failed
      .map((scenario) => scenario.scenarioId)
      .join(', ')}`,
  );
  assert.deepEqual(
    report.regressions,
    [],
    'no regressions versus the frozen baseline',
  );
  assert.ok(
    report.passCount > report.naiveBaselineCorrectCount,
    'the grounded executive must beat the ungrounded act-first baseline',
  );
  // Determinism: a second run must produce the identical report.
  const second = runGroundedExecutiveEval();
  assert.deepEqual(second, report, 'the evaluation must be deterministic');
}

function runDurableRoundTrip(): void {
  _initTestDatabase();
  try {
    let state = beginGroundedExecutive({
      objective: 'Confirm the nightly backup completed.',
      taskFamily: 'diagnostics',
      channel: 'eval',
      turnRef: 'eval-turn-1',
      successCriteria: [
        {
          criterionId: 'crit-goal',
          description: 'The goal state is confirmed by admissible evidence.',
          requiredEvidenceClasses: ['observed', 'user_attested'],
          minimumConfidence: 0.65,
          required: true,
        },
      ],
      actions: [
        {
          actionId: 'action-primary',
          title: 'Probe the target state',
          purpose: 'Gather the observation that satisfies the goal criterion.',
          toolId: 'tool-primary',
          actionClass: 'read_only_integration',
          mutationClass: 'none',
          approvalRequired: false,
          requiredEvidence: [],
          producesCriterionIds: ['crit-goal'],
          expectedEvidenceClass: 'observed',
          priority: 1,
          maxAttempts: 1,
          timeoutMs: 1_000,
          estimatedCostUnits: 0,
          risk: { level: 'low', flags: [] },
        },
      ],
      now: NOW,
    });
    state = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    }).state;
    const outcome = applyGroundedOutcome(state, {
      observation: {
        status: 'terminal_failure',
        summary: 'The probe endpoint returned 500.',
        evidence: [],
        failureClass: 'upstream_error',
      },
      now: LATER,
    });
    state = outcome.state;
    const journal = persistGroundedTurnJournal(state);
    assert.ok(journal.persisted, 'journal must persist with a database');
    assert.ok(
      listGroundedDecisionJournal({ turnId: 'eval-turn-1' }).length > 0,
      'decision journal round-trips',
    );
    assert.ok(
      listGroundedBeliefJournal({ turnId: 'eval-turn-1' }).length >= 0,
      'belief journal readable',
    );
    assert.equal(
      listGroundedCalibrationSamples({ limit: 10 }).length,
      state.calibrationSamples.length,
      'calibration samples round-trip',
    );

    const lessons = deriveGroundedLearning(state, outcome.verification, LATER);
    assert.ok(lessons.length > 0, 'a failed outcome yields proposed lessons');
    assert.ok(
      lessons.every((lesson) => lesson.appliesToAuthority === false),
      'no lesson can carry authority',
    );
    persistGroundedLearning(lessons, LATER);
    assert.equal(
      loadGroundedLearningForPlanning().length,
      0,
      'proposed lessons never influence planning before review',
    );
    const first = lessons[0]!;
    acceptGroundedLearningRecord(first.recordId, 'Reviewed in eval.', LATER);
    assert.equal(
      loadGroundedLearningForPlanning({ contextKey: first.contextKey }).length,
      1,
      'accepted lessons become available to planning',
    );
    retireGroundedLearningRecord(first.recordId, 'Reversed in eval.', LATER);
    assert.equal(
      loadGroundedLearningForPlanning().length,
      0,
      'retired lessons stop influencing planning',
    );
    assert.equal(
      listGroundedLearningRecords({ status: 'retired' }).length,
      1,
      'retired lessons stay reviewable',
    );

    console.log('Durable round-trip: journal, calibration, and reviewable');
    console.log(
      'learning lifecycle (proposed -> accepted -> retired) verified.',
    );
    console.log('');
    console.log('Operator diagnostics sample:');
    console.log(formatGroundedDiagnostics(groundedExecutiveDiagnostics(state)));
  } finally {
    _closeDatabase();
  }
}

runEvalSuite();
runDurableRoundTrip();
console.log('');
console.log('test-grounded-executive: all checks passed.');
