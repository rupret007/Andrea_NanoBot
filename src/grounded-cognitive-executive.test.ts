import { describe, expect, it } from 'vitest';

import type { AdaptiveActionCandidate } from './adaptive-cognition-engine.js';
import {
  applyGroundedCorrection,
  applyGroundedLearningToPlanning,
  applyGroundedOutcome,
  beginGroundedExecutive,
  decideGroundedNextStep,
  deriveGroundedLearning,
  explainGroundedBelief,
  formatGroundedDiagnostics,
  groundedBeliefTier,
  groundedCalibrationReport,
  groundedEvidence,
  groundedExecutiveDiagnostics,
  observeGroundedEvidence,
  refreshGroundedFreshness,
  verifyGroundedCompletion,
} from './grounded-cognitive-executive.js';
import type {
  GroundedExecutiveState,
  GroundedLearningRecord,
} from './grounded-cognitive-executive.js';

const NOW = '2026-07-20T12:00:00.000Z';
const LATER = '2026-07-20T12:00:05.000Z';
const MUCH_LATER = '2026-07-20T13:00:00.000Z';
const CRITERION_ID = 'crit-goal';

function goalAction(
  overrides: Partial<AdaptiveActionCandidate> = {},
): AdaptiveActionCandidate {
  return {
    actionId: 'action-primary',
    title: 'Read the target state',
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
  overrides: Partial<Parameters<typeof beginGroundedExecutive>[0]> = {},
): GroundedExecutiveState {
  return beginGroundedExecutive({
    objective: 'Confirm the backup job completed for today.',
    taskFamily: 'diagnostics',
    channel: 'test',
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
    source: 'test-probe',
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

describe('groundedBeliefTier', () => {
  it('never promotes inferred evidence to verified, regardless of confidence', () => {
    const record = observedEvidence('complete', {
      evidenceClass: 'inferred',
      confidence: 0.99,
    });
    const state = observeGroundedEvidence(begin(), [record], NOW).state;
    const belief = state.beliefs.find((item) => item.subject === 'backup-job');
    expect(belief).toBeDefined();
    expect(belief!.state).toBe('hypothesis');
    expect(
      groundedBeliefTier(
        belief!,
        state.evidenceRecords.map((item) => item.evidence),
      ),
    ).toBe('uncertain');
  });

  it('reaches verified only with high-confidence admissible support', () => {
    const state = observeGroundedEvidence(
      begin(),
      [
        observedEvidence('complete', { confidence: 0.95 }),
        observedEvidence('complete', {
          evidenceId: 'ev-second',
          source: 'test-probe-2',
          confidence: 0.9,
        }),
      ],
      NOW,
    ).state;
    const belief = state.beliefs.find((item) => item.subject === 'backup-job');
    expect(belief!.state).toBe('supported');
    expect(
      groundedBeliefTier(
        belief!,
        state.evidenceRecords.map((item) => item.evidence),
      ),
    ).toBe('verified');
  });
});

describe('refreshGroundedFreshness', () => {
  it('flips evidence past its staleness window and downgrades the belief', () => {
    const record = observedEvidence('complete', { staleAfterMs: 60_000 });
    let state = observeGroundedEvidence(begin(), [record], NOW).state;
    const before = state.beliefs.find((item) => item.subject === 'backup-job');
    expect(before!.state).toBe('supported');

    const result = observeGroundedEvidence(state, [], MUCH_LATER);
    expect(result.staleChangedEvidenceIds).toContain(
      record.evidence.evidenceId,
    );
    state = result.state;
    const after = state.beliefs.find((item) => item.subject === 'backup-job');
    expect(after!.state).toBe('stale');
    expect(
      groundedBeliefTier(
        after!,
        state.evidenceRecords.map((item) => item.evidence),
      ),
    ).toBe('uncertain');
    const journalEntry = state.beliefJournal.find(
      (entry) =>
        entry.beliefId === after!.beliefId && entry.cause === 'staleness',
    );
    expect(journalEntry).toBeDefined();
    expect(journalEntry!.explanation).toContain('freshness window');
  });

  it('leaves evidence without a staleness policy untouched', () => {
    const record = observedEvidence('complete');
    const { records, staleChangedEvidenceIds } = refreshGroundedFreshness(
      [record],
      MUCH_LATER,
    );
    expect(staleChangedEvidenceIds).toEqual([]);
    expect(records[0]!.evidence.freshness).toBe('fresh');
  });
});

describe('contradiction handling', () => {
  function contradictedState(): GroundedExecutiveState {
    let state = observeGroundedEvidence(
      begin(),
      [observedEvidence('complete')],
      NOW,
    ).state;
    state = observeGroundedEvidence(
      state,
      [
        observedEvidence('failed', {
          evidenceId: 'ev-conflict',
          source: 'test-probe-2',
        }),
      ],
      LATER,
    ).state;
    return state;
  }

  it('keeps both sides visible and lowers the belief tier', () => {
    const state = contradictedState();
    const contradicted = state.beliefs.filter(
      (belief) => belief.state === 'contradicted',
    );
    expect(contradicted.length).toBeGreaterThan(0);
    const original = contradicted.find((belief) => belief.value === 'complete');
    expect(original).toBeDefined();
    expect(original!.supportingEvidenceIds.length).toBeGreaterThan(0);
    expect(original!.contradictingEvidenceIds).toContain('ev-conflict');
    expect(
      groundedBeliefTier(
        original!,
        state.evidenceRecords.map((item) => item.evidence),
      ),
    ).toBe('uncertain');
  });

  it('never proposes acting across an unresolved contradiction', () => {
    const { decision } = decideGroundedNextStep(contradictedState(), {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: LATER,
    });
    expect(decision.kind).not.toBe('act');
    expect(decision.kind).toBe('research');
    expect(decision.reason).toContain('contradict');
    expect(decision.whatWouldChangeMind.join(' ')).toContain('contradiction');
  });
});

describe('decideGroundedNextStep', () => {
  it('acts when evidence, health, and confidence are sufficient', () => {
    const { decision, directiveNodeId } = decideGroundedNextStep(begin(), {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    });
    expect(decision.kind).toBe('act');
    expect(decision.targetNodeId).toBe(directiveNodeId);
    expect(decision.authorityNote).toContain('approval layer');
  });

  it('asks when a blocking ambiguity exists', () => {
    const state = begin({
      unknowns: [
        {
          description: 'Which environment does "the backup" refer to?',
          impact: 'blocking',
        },
      ],
    });
    const { decision } = decideGroundedNextStep(state, { now: NOW });
    expect(decision.kind).toBe('ask');
    expect(decision.question).toContain('environment');
  });

  it('researches instead of acting when a parsed precondition is unmet', () => {
    const state = begin({
      actions: [
        goalAction({
          preconditions: ['precond:backup-job/enabled/true'],
        }),
      ],
    });
    const { decision } = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    });
    expect(decision.kind).toBe('research');
    expect(decision.reason).toContain('precond:backup-job/enabled/true');
  });

  it('defers when the tool is blocked', () => {
    const { decision } = decideGroundedNextStep(begin(), {
      toolHealthBySubject: { 'tool-primary': 'blocked' },
      now: NOW,
    });
    expect(decision.kind).not.toBe('act');
  });

  it('asks before acting on a low-confidence mutating step', () => {
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
    expect(['ask', 'defer']).toContain(decision.kind);
    expect(decision.kind).not.toBe('act');
    expect(decision.authorityNote).toContain('cannot grant');
  });
});

describe('applyGroundedOutcome', () => {
  it('verifies a step whose observation carries admissible goal evidence', () => {
    let state = begin();
    const decided = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    });
    state = decided.state;
    const { state: next, verification } = applyGroundedOutcome(state, {
      observation: {
        status: 'success',
        summary: 'Probe confirmed the backup completed.',
        evidence: [observedEvidence('complete').evidence],
      },
      now: LATER,
    });
    expect(verification.verdict).toBe('verified');
    expect(verification.calibrationSampleId).not.toBeNull();
    const sample = next.calibrationSamples.find(
      (item) => item.sampleId === verification.calibrationSampleId,
    );
    expect(sample!.outcome).toBe(1);
    const completion = verifyGroundedCompletion(next);
    expect(completion.report.completionAuthorized).toBe(true);
    expect(completion.state.phase).toBe('done');
  });

  it('does not treat a technically successful tool call as goal achievement', () => {
    let state = begin();
    const decided = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    });
    expect(decided.decision.kind).toBe('act');
    state = decided.state;
    const { state: next, verification } = applyGroundedOutcome(state, {
      observation: {
        status: 'success',
        summary: 'The command exited 0 but returned no status payload.',
        evidence: [
          observedEvidence('complete', {
            evidenceClass: 'model_generated',
            verification: 'unverified',
            evidenceId: 'ev-model-guess',
          }).evidence,
        ],
      },
      now: LATER,
    });
    expect(verification.verdict).toBe('uncertain');
    expect(verification.causalExplanation).toContain('unverified');
    const sample = next.calibrationSamples.find(
      (item) => item.sampleId === verification.calibrationSampleId,
    );
    expect(sample!.outcome).toBe(0);
    expect(verifyGroundedCompletion(next).report.completionAuthorized).toBe(
      false,
    );
  });

  it('marks degraded observations as partial and failures as failed', () => {
    let state = begin();
    state = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    }).state;
    const { verification } = applyGroundedOutcome(state, {
      observation: {
        status: 'degraded',
        summary: 'Only one of two shards reported.',
        evidence: [],
        failureClass: 'partial_result',
      },
      now: LATER,
    });
    expect(verification.verdict).toBe('partial');
  });
});

describe('learning', () => {
  it('derives authority-free lessons and pins appliesToAuthority to false', () => {
    let state = begin();
    state = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    }).state;
    const { state: next, verification } = applyGroundedOutcome(state, {
      observation: {
        status: 'terminal_failure',
        summary: 'The probe endpoint returned 500.',
        evidence: [],
        failureClass: 'upstream_error',
      },
      now: LATER,
    });
    const lessons = deriveGroundedLearning(next, verification, LATER);
    expect(lessons.length).toBeGreaterThan(0);
    for (const lesson of lessons) {
      expect(lesson.appliesToAuthority).toBe(false);
      expect(lesson.status).toBe('proposed');
    }
    expect(lessons.some((lesson) => lesson.kind === 'tool_reliability')).toBe(
      true,
    );
  });

  it('adjusts only planning estimates, never approval requirements', () => {
    const lesson: GroundedLearningRecord = {
      recordId: 'learn-1',
      createdAt: NOW,
      kind: 'tool_reliability',
      status: 'accepted',
      subject: 'tool-primary',
      contextKey: 'diagnostics|test',
      lesson: 'tool-primary has been failing in this context.',
      evidenceRefs: [],
      counterEvidenceRefs: [],
      appliesToAuthority: false,
      reviewNote: null,
      sourceTurnId: null,
    };
    const candidates = [
      {
        candidateId: 'execute:tool-primary',
        action: 'execute',
        usefulness: 0.8,
        successProbability: 0.8,
        cost: 0.1,
        latency: 0.1,
        risk: 0.2,
        reversibility: 0.5,
        informationGain: 0.3,
        approvalRequired: true,
        toolHealth: 'healthy' as const,
      },
    ];
    const adjusted = applyGroundedLearningToPlanning([lesson], candidates);
    expect(adjusted[0]!.approvalRequired).toBe(true);
    expect(adjusted[0]!.action).toBe('execute');
    expect(adjusted[0]!.successProbability).toBeLessThan(0.8);
    expect(adjusted[0]!.toolHealth).toBe('degraded');
  });

  it('ignores proposed (not yet accepted) lessons', () => {
    const lesson: GroundedLearningRecord = {
      recordId: 'learn-2',
      createdAt: NOW,
      kind: 'tool_reliability',
      status: 'proposed',
      subject: 'tool-primary',
      contextKey: 'diagnostics|test',
      lesson: 'unreviewed lesson',
      evidenceRefs: [],
      counterEvidenceRefs: [],
      appliesToAuthority: false,
      reviewNote: null,
      sourceTurnId: null,
    };
    const candidates = [
      {
        candidateId: 'execute:tool-primary',
        action: 'execute',
        usefulness: 0.8,
        successProbability: 0.8,
        cost: 0.1,
        latency: 0.1,
        risk: 0.2,
        reversibility: 0.5,
        informationGain: 0.3,
        approvalRequired: false,
        toolHealth: 'healthy' as const,
      },
    ];
    expect(applyGroundedLearningToPlanning([lesson], candidates)).toEqual(
      candidates,
    );
  });
});

describe('corrections and calibration', () => {
  it('records an attested correction as a new sample plus a calibration lesson', () => {
    let state = begin();
    state = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    }).state;
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
    expect(corrected.correctionSample).not.toBeNull();
    expect(corrected.correctionSample!.source).toBe('correction');
    const after = groundedCalibrationReport(corrected.state);
    expect(after.sampleCount).toBe(before.sampleCount + 1);
    expect(after.brierScore).toBeLessThan(before.brierScore);
    expect(
      corrected.state.learning.some((item) => item.kind === 'calibration'),
    ).toBe(true);
    const journal = corrected.state.beliefJournal.filter(
      (entry) => entry.cause === 'correction',
    );
    expect(journal.length).toBeGreaterThan(0);
  });
});

describe('diagnostics', () => {
  it('explains why a belief is held and what would change it', () => {
    const record = observedEvidence('complete', {
      disproofConditions: ['A fresh probe showing the backup job failed.'],
    });
    const state = observeGroundedEvidence(begin(), [record], NOW).state;
    const belief = state.beliefs.find((item) => item.subject === 'backup-job');
    const explanation = explainGroundedBelief(state, belief!.beliefId);
    expect(explanation).not.toBeNull();
    expect(explanation!.statement).toBe('backup-job status complete');
    expect(explanation!.supportingEvidence[0]!.source).toBe('test-probe');
    expect(explanation!.whatWouldChangeMind.join(' ')).toContain(
      'backup job failed',
    );
    expect(explanation!.history.length).toBeGreaterThan(0);
  });

  it('formats a full operator-readable diagnostics report', () => {
    let state = observeGroundedEvidence(
      begin(),
      [observedEvidence('complete')],
      NOW,
    ).state;
    state = decideGroundedNextStep(state, {
      toolHealthBySubject: { 'tool-primary': 'healthy' },
      now: NOW,
    }).state;
    const text = formatGroundedDiagnostics(groundedExecutiveDiagnostics(state));
    expect(text).toContain('backup-job status complete');
    expect(text).toContain('Decisions:');
    expect(text).toContain('Calibration:');
  });
});
