import {
  computeAdaptiveCalibration,
  type AdaptiveActionCandidate,
  type AdaptiveCalibrationReport,
  type AdaptiveCalibrationSample,
} from './adaptive-cognition-engine.js';
import {
  applyGroundedCorrection,
  applyGroundedOutcome,
  beginGroundedExecutive,
  decideGroundedNextStep,
  deriveGroundedLearning,
  explainGroundedBelief,
  groundedBeliefTier,
  groundedCalibrationReport,
  groundedEvidence,
  observeGroundedEvidence,
  verifyGroundedCompletion,
  type BeginGroundedExecutiveInput,
  type GroundedDecisionKind,
  type GroundedExecutiveState,
} from './grounded-cognitive-executive.js';

/**
 * Deterministic evaluation harness for the grounded cognitive executive.
 *
 * Every scenario uses fixed clocks and synthetic evidence — no network, no
 * live tools, no real messages. Each scenario also runs an ungrounded
 * "act-first" baseline policy (always act when a tool is ready; treat tool
 * success as goal success) so the report shows the measurable improvement
 * the grounded loop provides over the prior behavior.
 */

export const GROUNDED_EVAL_VERSION = '1.0.0';
export const GROUNDED_EVAL_BASELINE_VERSION = '2026-07-20.1';

const NOW = '2026-07-20T12:00:00.000Z';
const LATER = '2026-07-20T12:00:05.000Z';
const MUCH_LATER = '2026-07-20T13:00:00.000Z';
const CRITERION_ID = 'crit-goal';

export interface GroundedEvalScenarioResult {
  scenarioId: string;
  goal: string;
  evidenceSummary: string;
  chosenAction: string;
  confidence: number;
  outcome: string;
  correct: boolean;
  naiveBaselineCorrect: boolean;
  notes: string;
}

export interface GroundedExecutiveEvalReport {
  version: string;
  baselineVersion: string;
  generatedAt: string;
  scenarios: GroundedEvalScenarioResult[];
  passCount: number;
  failCount: number;
  naiveBaselineCorrectCount: number;
  calibration: AdaptiveCalibrationReport;
  naiveCalibration: AdaptiveCalibrationReport;
  regressions: string[];
}

/**
 * Frozen expectations. A regression is any scenario that this baseline
 * expects to pass but the current implementation fails, or whose decision
 * kind drifted from the baseline decision.
 */
export const GROUNDED_EVAL_BASELINE: Record<
  string,
  { correct: true; chosenAction: string }
> = {
  'contradictory-evidence': { correct: true, chosenAction: 'research' },
  'stale-evidence': { correct: true, chosenAction: 'research' },
  'ambiguous-intent': { correct: true, chosenAction: 'ask' },
  'missing-precondition': { correct: true, chosenAction: 'research' },
  'tool-succeeds-goal-fails': { correct: true, chosenAction: 'act' },
  'partial-success': { correct: true, chosenAction: 'act' },
  'failed-dependency-replan': { correct: true, chosenAction: 'act' },
  'degraded-tool-reliability': { correct: true, chosenAction: 'act' },
  'should-ask-before-mutation': { correct: true, chosenAction: 'ask' },
  'should-stop-safely': { correct: true, chosenAction: 'stop_safely' },
  'correction-improves-calibration': { correct: true, chosenAction: 'act' },
  // Acting is correct here: the ready read-only probe is what produces the
  // admissible evidence the inferred claim lacks. The invariant under test is
  // that the inference itself never reaches the verified tier.
  'inference-never-promoted': { correct: true, chosenAction: 'act' },
};

function goalAction(
  overrides: Partial<AdaptiveActionCandidate> = {},
): AdaptiveActionCandidate {
  return {
    actionId: 'action-primary',
    title: 'Probe the target state',
    purpose: 'Gather the observation that satisfies the goal criterion.',
    toolId: 'tool-primary',
    actionClass: 'read_only_integration',
    mutationClass: 'none',
    approvalRequired: false,
    requiredEvidence: [],
    producesCriterionIds: [CRITERION_ID],
    expectedEvidenceClass: 'observed',
    priority: 1,
    maxAttempts: 1,
    timeoutMs: 1_000,
    estimatedCostUnits: 0,
    risk: { level: 'low', flags: [] },
    ...overrides,
  };
}

function begin(
  overrides: Partial<BeginGroundedExecutiveInput> = {},
): GroundedExecutiveState {
  return beginGroundedExecutive({
    objective: 'Confirm the nightly backup completed.',
    taskFamily: 'diagnostics',
    channel: 'eval',
    successCriteria: [
      {
        criterionId: CRITERION_ID,
        description: 'The goal state is confirmed by admissible evidence.',
        requiredEvidenceClasses: ['observed', 'user_attested'],
        minimumConfidence: 0.65,
        required: true,
      },
    ],
    actions: [goalAction()],
    now: NOW,
    ...overrides,
  });
}

function observedEvidence(
  value: string,
  overrides: Partial<Parameters<typeof groundedEvidence>[0]> = {},
) {
  return groundedEvidence({
    evidenceClass: 'observed',
    origin: 'synthetic',
    source: 'eval-probe',
    claim: `backup status is ${value}`,
    subject: 'backup-job',
    predicate: 'status',
    value,
    confidence: 0.9,
    verification: 'verified',
    supportsCriterionIds: [CRITERION_ID],
    createdAt: NOW,
    ...overrides,
  });
}

/**
 * The prior, ungrounded policy this eval measures against: act whenever a
 * tool step is ready, never ask or research first, and treat a technically
 * successful tool call as proof the goal was achieved.
 */
function naiveBaselineDecision(hasReadyTool: boolean): GroundedDecisionKind {
  return hasReadyTool ? 'act' : 'stop_safely';
}

interface ScenarioOutcome {
  goal: string;
  evidenceSummary: string;
  chosenAction: string;
  confidence: number;
  outcome: string;
  correct: boolean;
  naiveBaselineCorrect: boolean;
  notes: string;
  calibrationSamples?: AdaptiveCalibrationSample[];
  naiveSamples?: AdaptiveCalibrationSample[];
}

type ScenarioRunner = () => ScenarioOutcome;

function scenarioContradictoryEvidence(): ScenarioOutcome {
  let state = begin();
  state = observeGroundedEvidence(
    state,
    [observedEvidence('complete')],
    NOW,
  ).state;
  state = observeGroundedEvidence(
    state,
    [
      observedEvidence('failed', {
        evidenceId: 'ev-conflict',
        source: 'eval-probe-2',
      }),
    ],
    LATER,
  ).state;
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: LATER,
  });
  const contradicted = state.beliefs.find(
    (belief) => belief.state === 'contradicted' && belief.value === 'complete',
  );
  const bothSidesVisible = Boolean(
    contradicted &&
    contradicted.supportingEvidenceIds.length > 0 &&
    contradicted.contradictingEvidenceIds.includes('ev-conflict'),
  );
  const correct =
    decision.kind !== 'act' &&
    decision.kind === 'research' &&
    bothSidesVisible &&
    /contradict/i.test(decision.reason);
  return {
    goal: 'Do not act on directly contradictory observations.',
    evidenceSummary:
      'Two fresh observed probes disagree: backup complete vs backup failed.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `decision=${decision.kind}; contradiction visible=${bothSidesVisible}`,
    correct,
    // The act-first baseline would have acted across the contradiction.
    naiveBaselineCorrect: naiveBaselineDecision(true) !== 'act',
    notes: decision.reason,
  };
}

function scenarioStaleEvidence(): ScenarioOutcome {
  let state = begin();
  state = observeGroundedEvidence(
    state,
    [observedEvidence('complete', { staleAfterMs: 60_000 })],
    NOW,
  ).state;
  const refreshed = observeGroundedEvidence(state, [], MUCH_LATER);
  state = refreshed.state;
  const belief = state.beliefs.find((item) => item.subject === 'backup-job');
  const tier = belief
    ? groundedBeliefTier(
        belief,
        state.evidenceRecords.map((record) => record.evidence),
      )
    : 'unknown';
  const staleJournaled = state.beliefJournal.some(
    (entry) => entry.cause === 'staleness',
  );
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: MUCH_LATER,
  });
  const correct =
    refreshed.staleChangedEvidenceIds.length > 0 &&
    tier === 'uncertain' &&
    staleJournaled &&
    decision.kind !== 'stop_safely';
  return {
    goal: 'Never treat stale context as current truth.',
    evidenceSummary:
      'A one-hour-old probe with a 60s freshness window is all that exists.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `tier=${tier}; staleness journaled=${staleJournaled}`,
    correct,
    // The baseline would have answered from the stale probe as if current.
    naiveBaselineCorrect: false,
    notes: decision.reason,
  };
}

function scenarioAmbiguousIntent(): ScenarioOutcome {
  const state = begin({
    unknowns: [
      {
        description: 'Which backup — the laptop or the server — do you mean?',
        impact: 'blocking',
      },
    ],
  });
  const { decision } = decideGroundedNextStep(state, { now: NOW });
  const correct =
    decision.kind === 'ask' &&
    Boolean(decision.question) &&
    /laptop|server/.test(decision.question || '');
  return {
    goal: 'Ask one concrete question when intent is ambiguous.',
    evidenceSummary: 'The request has a blocking ambiguity and no evidence.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `question=${decision.question || 'none'}`,
    correct,
    naiveBaselineCorrect: naiveBaselineDecision(true) === 'ask',
    notes: decision.reason,
  };
}

function scenarioMissingPrecondition(): ScenarioOutcome {
  const state = begin({
    actions: [
      goalAction({ preconditions: ['precond:backup-job/enabled/true'] }),
    ],
  });
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  const correct =
    decision.kind === 'research' &&
    decision.reason.includes('precond:backup-job/enabled/true');
  return {
    goal: 'Do not act while a required precondition is unestablished.',
    evidenceSummary:
      'The step requires the belief backup-job/enabled/true at likely or better; no evidence exists.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `reason=${decision.reason}`,
    correct,
    naiveBaselineCorrect: naiveBaselineDecision(true) !== 'act',
    notes: decision.whatWouldChangeMind.join(' | '),
  };
}

function scenarioToolSucceedsGoalFails(): ScenarioOutcome {
  let state = begin();
  const decided = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  state = decided.state;
  const { state: next, verification } = applyGroundedOutcome(state, {
    observation: {
      status: 'success',
      summary: 'The command exited 0 but returned no status payload.',
      evidence: [],
    },
    now: LATER,
  });
  const completion = verifyGroundedCompletion(next);
  const correct =
    decided.decision.kind === 'act' &&
    verification.verdict === 'uncertain' &&
    !completion.report.completionAuthorized &&
    next.calibrationSamples.some((sample) => sample.outcome === 0);
  return {
    goal: 'Tool-call success must not count as goal achievement.',
    evidenceSummary:
      'The probe ran successfully but produced no admissible goal evidence.',
    chosenAction: decided.decision.kind,
    confidence: decided.decision.confidence,
    outcome: `verdict=${verification.verdict}; completionAuthorized=${completion.report.completionAuthorized}`,
    correct,
    // The baseline treats exit 0 as done — a false completion.
    naiveBaselineCorrect: false,
    notes: verification.causalExplanation,
    calibrationSamples: next.calibrationSamples.map((sample) => ({
      confidence: sample.predictedConfidence,
      outcome: sample.outcome,
    })),
    naiveSamples: [{ confidence: 0.95, outcome: 0 }],
  };
}

function scenarioPartialSuccess(): ScenarioOutcome {
  let state = begin();
  const decided = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  state = decided.state;
  const { state: next, verification } = applyGroundedOutcome(state, {
    observation: {
      status: 'degraded',
      summary: 'Only one of two backup shards reported completion.',
      evidence: [],
      failureClass: 'partial_result',
    },
    now: LATER,
  });
  const completion = verifyGroundedCompletion(next);
  const correct =
    verification.verdict === 'partial' &&
    !completion.report.completionAuthorized &&
    /partial/i.test(verification.causalExplanation);
  return {
    goal: 'A partially successful step stays partial, not done.',
    evidenceSummary: 'The probe reported a degraded, one-of-two-shards result.',
    chosenAction: decided.decision.kind,
    confidence: decided.decision.confidence,
    outcome: `verdict=${verification.verdict}; completionAuthorized=${completion.report.completionAuthorized}`,
    correct,
    // The baseline counts any non-error exit as full success.
    naiveBaselineCorrect: false,
    notes: verification.causalExplanation,
  };
}

function scenarioFailedDependencyReplan(): ScenarioOutcome {
  let state = begin({
    actions: [
      goalAction(),
      goalAction({
        actionId: 'action-fallback',
        title: 'Probe the mirror endpoint',
        toolId: 'tool-fallback',
        alternativeForActionId: 'action-primary',
        recoveryForFailureClasses: ['upstream_error'],
      }),
    ],
  });
  const decided = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  state = decided.state;
  const { state: next, verification } = applyGroundedOutcome(state, {
    observation: {
      status: 'retryable_failure',
      summary: 'The primary probe endpoint returned 500.',
      evidence: [],
      failureClass: 'upstream_error',
    },
    now: LATER,
  });
  const followUp = decideGroundedNextStep(next, {
    toolHealthBySubject: { 'tool-fallback': 'healthy' },
    now: LATER,
  });
  const fallbackReady = next.graph.nodes.some(
    (node) => node.actionId === 'action-fallback' && node.status !== 'dormant',
  );
  const lessons = deriveGroundedLearning(next, verification, LATER);
  const correct =
    verification.verdict === 'failed' &&
    verification.replanTriggered &&
    fallbackReady &&
    followUp.decision.kind === 'act' &&
    lessons.some((lesson) => lesson.kind === 'plan_pattern');
  return {
    goal: 'A failed dependency triggers a bounded replan onto the fallback.',
    evidenceSummary:
      'The primary probe failed with upstream_error; a pre-authorized fallback exists.',
    chosenAction: decided.decision.kind,
    confidence: decided.decision.confidence,
    outcome: `verdict=${verification.verdict}; replanTriggered=${verification.replanTriggered}; nextDecision=${followUp.decision.kind}`,
    correct,
    // The baseline retries the same failed step with no plan revision.
    naiveBaselineCorrect: false,
    notes: verification.causalExplanation,
  };
}

function scenarioDegradedToolReliability(): ScenarioOutcome {
  const healthy = decideGroundedNextStep(begin(), {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  const degraded = decideGroundedNextStep(begin(), {
    toolHealthBySubject: { 'tool-primary': 'degraded' },
    now: NOW,
  });
  const blocked = decideGroundedNextStep(begin(), {
    toolHealthBySubject: { 'tool-primary': 'blocked' },
    now: NOW,
  });
  const scoreFor = (decision: (typeof healthy)['decision']): number =>
    decision.candidateScores.find((score) => score.action === 'execute')
      ?.score ?? Number.NEGATIVE_INFINITY;
  const degradedPenalized =
    scoreFor(degraded.decision) < scoreFor(healthy.decision);
  const correct =
    healthy.decision.kind === 'act' &&
    degradedPenalized &&
    blocked.decision.kind !== 'act';
  return {
    goal: 'Degraded history penalizes a tool; a blocked tool is never used.',
    evidenceSummary:
      'The same plan scored under healthy, degraded, and blocked tool health.',
    chosenAction: healthy.decision.kind,
    confidence: healthy.decision.confidence,
    outcome: `healthy=${healthy.decision.kind}; degradedPenalized=${degradedPenalized}; blocked=${blocked.decision.kind}`,
    correct,
    // The baseline ignores reliability history entirely.
    naiveBaselineCorrect: false,
    notes: blocked.decision.reason,
  };
}

function scenarioShouldAskBeforeMutation(): ScenarioOutcome {
  const state = begin({
    authority: { maximumActionClass: 'approval_gated_mutation' },
    actions: [
      goalAction({
        actionClass: 'mutation',
        mutationClass: 'external_reversible',
        approvalRequired: true,
        risk: { level: 'high', flags: ['external_effect'] },
      }),
    ],
  });
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'unknown' },
    now: NOW,
  });
  const correct =
    decision.kind === 'ask' && decision.authorityNote.includes('cannot grant');
  return {
    goal: 'Ask before a low-confidence step with external effects.',
    evidenceSummary:
      'The only ready step is a high-risk external mutation with no supporting evidence.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `decision=${decision.kind}; authorityNote present=${decision.authorityNote.length > 0}`,
    correct,
    naiveBaselineCorrect: naiveBaselineDecision(true) === 'ask',
    notes: decision.reason,
  };
}

function scenarioShouldStopSafely(): ScenarioOutcome {
  const state = begin({ budget: { maxNodeExecutions: 1 } });
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  const correct =
    decision.kind === 'stop_safely' && /stop/i.test(decision.reason);
  return {
    goal: 'Stop safely when the execution budget is exhausted.',
    evidenceSummary: 'The node-execution budget allows no further steps.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `decision=${decision.kind}`,
    correct,
    // The baseline keeps acting past its budget.
    naiveBaselineCorrect: false,
    notes: decision.reason,
  };
}

function scenarioCorrectionImprovesCalibration(): ScenarioOutcome {
  let state = begin();
  const decided = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  state = decided.state;
  const outcome = applyGroundedOutcome(state, {
    observation: {
      status: 'success',
      summary: 'Command exited 0 with no payload.',
      evidence: [],
    },
    now: LATER,
  });
  state = outcome.state;
  const before = groundedCalibrationReport(state);
  const corrected = applyGroundedCorrection(state, {
    verificationId: outcome.verification.verificationId,
    correctedOutcome: 1,
    evidence: [
      observedEvidence('complete', {
        evidenceClass: 'user_attested',
        evidenceId: 'ev-owner-correction',
        source: 'owner',
        createdAt: MUCH_LATER,
      }),
    ],
    reason: 'The owner confirmed the backup completed.',
    now: MUCH_LATER,
  });
  const after = groundedCalibrationReport(corrected.state);
  const correct =
    corrected.correctionSample !== null &&
    after.sampleCount === before.sampleCount + 1 &&
    after.brierScore < before.brierScore &&
    corrected.state.learning.some((lesson) => lesson.kind === 'calibration') &&
    corrected.state.beliefJournal.some((entry) => entry.cause === 'correction');
  return {
    goal: 'An attested correction improves later confidence calibration.',
    evidenceSummary:
      'The owner corrected an uncertain outcome with attested evidence.',
    chosenAction: decided.decision.kind,
    confidence: decided.decision.confidence,
    outcome: `brier ${before.brierScore.toFixed(3)} -> ${after.brierScore.toFixed(3)}; samples ${before.sampleCount} -> ${after.sampleCount}`,
    correct,
    // The baseline has no correction path at all.
    naiveBaselineCorrect: false,
    notes:
      corrected.state.learning.find((lesson) => lesson.kind === 'calibration')
        ?.lesson || '',
    calibrationSamples: corrected.state.calibrationSamples.map((sample) => ({
      confidence: sample.predictedConfidence,
      outcome: sample.outcome,
    })),
  };
}

function scenarioInferenceNeverPromoted(): ScenarioOutcome {
  let state = begin();
  state = observeGroundedEvidence(
    state,
    [
      observedEvidence('complete', {
        evidenceClass: 'inferred',
        confidence: 0.99,
        disproofConditions: ['A fresh probe showing the backup job failed.'],
      }),
    ],
    NOW,
  ).state;
  const belief = state.beliefs.find((item) => item.subject === 'backup-job');
  const tier = belief
    ? groundedBeliefTier(
        belief,
        state.evidenceRecords.map((record) => record.evidence),
      )
    : 'unknown';
  const completion = verifyGroundedCompletion(state);
  const explanation = belief
    ? explainGroundedBelief(state, belief.beliefId)
    : null;
  const { decision } = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  });
  const correct =
    tier !== 'verified' &&
    tier !== 'likely' &&
    !completion.report.completionAuthorized &&
    explanation !== null &&
    explanation.whatWouldChangeMind.length > 0;
  return {
    goal: 'High-confidence inference is never promoted to verified fact.',
    evidenceSummary:
      'Only an inferred claim (confidence 0.99) supports the goal criterion.',
    chosenAction: decision.kind,
    confidence: decision.confidence,
    outcome: `tier=${tier}; completionAuthorized=${completion.report.completionAuthorized}`,
    correct,
    // The baseline treats its own inference as fact.
    naiveBaselineCorrect: false,
    notes: explanation?.whatWouldChangeMind.join(' | ') || '',
  };
}

const SCENARIOS: Array<{ scenarioId: string; run: ScenarioRunner }> = [
  { scenarioId: 'contradictory-evidence', run: scenarioContradictoryEvidence },
  { scenarioId: 'stale-evidence', run: scenarioStaleEvidence },
  { scenarioId: 'ambiguous-intent', run: scenarioAmbiguousIntent },
  { scenarioId: 'missing-precondition', run: scenarioMissingPrecondition },
  {
    scenarioId: 'tool-succeeds-goal-fails',
    run: scenarioToolSucceedsGoalFails,
  },
  { scenarioId: 'partial-success', run: scenarioPartialSuccess },
  {
    scenarioId: 'failed-dependency-replan',
    run: scenarioFailedDependencyReplan,
  },
  {
    scenarioId: 'degraded-tool-reliability',
    run: scenarioDegradedToolReliability,
  },
  {
    scenarioId: 'should-ask-before-mutation',
    run: scenarioShouldAskBeforeMutation,
  },
  { scenarioId: 'should-stop-safely', run: scenarioShouldStopSafely },
  {
    scenarioId: 'correction-improves-calibration',
    run: scenarioCorrectionImprovesCalibration,
  },
  {
    scenarioId: 'inference-never-promoted',
    run: scenarioInferenceNeverPromoted,
  },
];

export function runGroundedExecutiveEval(): GroundedExecutiveEvalReport {
  const scenarios: GroundedEvalScenarioResult[] = [];
  const calibrationSamples: AdaptiveCalibrationSample[] = [];
  const naiveSamples: AdaptiveCalibrationSample[] = [];
  for (const { scenarioId, run } of SCENARIOS) {
    const outcome = run();
    calibrationSamples.push(...(outcome.calibrationSamples || []));
    naiveSamples.push(...(outcome.naiveSamples || []));
    scenarios.push({
      scenarioId,
      goal: outcome.goal,
      evidenceSummary: outcome.evidenceSummary,
      chosenAction: outcome.chosenAction,
      confidence: outcome.confidence,
      outcome: outcome.outcome,
      correct: outcome.correct,
      naiveBaselineCorrect: outcome.naiveBaselineCorrect,
      notes: outcome.notes,
    });
  }
  const regressions = scenarios
    .filter((scenario) => {
      const baseline = GROUNDED_EVAL_BASELINE[scenario.scenarioId];
      if (!baseline) return false;
      return (
        (baseline.correct && !scenario.correct) ||
        baseline.chosenAction !== scenario.chosenAction
      );
    })
    .map((scenario) => scenario.scenarioId);
  return {
    version: GROUNDED_EVAL_VERSION,
    baselineVersion: GROUNDED_EVAL_BASELINE_VERSION,
    generatedAt: NOW,
    scenarios,
    passCount: scenarios.filter((scenario) => scenario.correct).length,
    failCount: scenarios.filter((scenario) => !scenario.correct).length,
    naiveBaselineCorrectCount: scenarios.filter(
      (scenario) => scenario.naiveBaselineCorrect,
    ).length,
    calibration: computeAdaptiveCalibration(calibrationSamples),
    naiveCalibration: computeAdaptiveCalibration(naiveSamples),
    regressions,
  };
}

export function formatGroundedExecutiveEvalReport(
  report: GroundedExecutiveEvalReport,
): string {
  const lines: string[] = [
    `Grounded cognitive executive evaluation v${report.version} (baseline ${report.baselineVersion})`,
    `Result: ${report.passCount}/${report.scenarios.length} scenarios correct; ungrounded act-first baseline: ${report.naiveBaselineCorrectCount}/${report.scenarios.length}.`,
    `Calibration (grounded samples): n=${report.calibration.sampleCount}, Brier ${report.calibration.brierScore.toFixed(3)}, ECE ${report.calibration.expectedCalibrationError.toFixed(3)}.`,
    report.naiveCalibration.sampleCount > 0
      ? `Calibration (naive false-completion samples): n=${report.naiveCalibration.sampleCount}, Brier ${report.naiveCalibration.brierScore.toFixed(3)}.`
      : '',
    report.regressions.length
      ? `REGRESSIONS vs baseline: ${report.regressions.join(', ')}`
      : 'No regressions versus the frozen baseline.',
    '',
  ].filter(Boolean);
  for (const scenario of report.scenarios) {
    lines.push(
      `[${scenario.correct ? 'PASS' : 'FAIL'}] ${scenario.scenarioId}`,
      `  goal: ${scenario.goal}`,
      `  evidence: ${scenario.evidenceSummary}`,
      `  decision: ${scenario.chosenAction} (confidence ${scenario.confidence.toFixed(2)})`,
      `  outcome: ${scenario.outcome}`,
      `  ungrounded baseline correct: ${scenario.naiveBaselineCorrect}`,
      scenario.notes ? `  notes: ${scenario.notes}` : '',
    );
  }
  return lines.filter(Boolean).join('\n');
}
