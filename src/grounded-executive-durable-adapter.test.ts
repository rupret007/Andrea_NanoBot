import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  insertGroundedBeliefJournalEntry,
  listGroundedBeliefJournal,
  listGroundedCalibrationSamples,
  listGroundedDecisionJournal,
  listGroundedLearningRecords,
  upsertGroundedLearningRecord,
} from './db.js';
import {
  acceptGroundedLearningRecord,
  groundedDurableDiagnostics,
  loadGroundedCalibrationSamples,
  loadGroundedLearningForPlanning,
  persistGroundedLearning,
  persistGroundedTurnJournal,
  recordGroundedToolReliability,
  retireGroundedLearningRecord,
} from './grounded-executive-durable-adapter.js';
import {
  applyGroundedOutcome,
  beginGroundedExecutive,
  decideGroundedNextStep,
  groundedEvidence,
  observeGroundedEvidence,
} from './grounded-cognitive-executive.js';
import type {
  GroundedExecutiveState,
  GroundedLearningRecord,
  GroundedOutcomeVerification,
} from './grounded-cognitive-executive.js';
import type { StoredGroundedLearningRecord } from './types.js';

const NOW = '2026-07-20T12:00:00.000Z';
const LATER = '2026-07-20T12:00:05.000Z';
const CRITERION_ID = 'crit-goal';

function lesson(
  overrides: Partial<GroundedLearningRecord> = {},
): GroundedLearningRecord {
  return {
    recordId: 'learn-1',
    createdAt: NOW,
    kind: 'tool_reliability',
    status: 'proposed',
    subject: 'tool-primary',
    contextKey: 'diagnostics|test',
    lesson: 'tool-primary produced a failed outcome in context diagnostics.',
    evidenceRefs: ['verification-1'],
    counterEvidenceRefs: [],
    appliesToAuthority: false,
    reviewNote: null,
    sourceTurnId: 'turn-1',
    ...overrides,
  };
}

function runOneTurn(): GroundedExecutiveState {
  let state = beginGroundedExecutive({
    objective: 'Confirm the backup job completed for today.',
    taskFamily: 'diagnostics',
    channel: 'test',
    turnRef: 'turn-1',
    successCriteria: [
      {
        criterionId: CRITERION_ID,
        description: 'The goal state is confirmed by admissible evidence.',
        requiredEvidenceClasses: ['observed', 'user_attested'],
        minimumConfidence: 0.65,
        required: true,
      },
    ],
    actions: [
      {
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
      },
    ],
    now: NOW,
  });
  state = observeGroundedEvidence(
    state,
    [
      groundedEvidence({
        evidenceClass: 'observed',
        origin: 'synthetic',
        source: 'test-probe',
        claim: 'backup status is running',
        subject: 'backup-job',
        predicate: 'status',
        value: 'running',
        confidence: 0.8,
        verification: 'verified',
        createdAt: NOW,
      }),
    ],
    NOW,
  ).state;
  state = decideGroundedNextStep(state, {
    toolHealthBySubject: { 'tool-primary': 'healthy' },
    now: NOW,
  }).state;
  state = applyGroundedOutcome(state, {
    observation: {
      status: 'success',
      summary: 'Probe confirmed the backup completed.',
      evidence: [
        groundedEvidence({
          evidenceClass: 'observed',
          origin: 'synthetic',
          source: 'test-probe',
          claim: 'backup completed',
          subject: 'backup-job',
          predicate: 'status',
          value: 'complete',
          confidence: 0.9,
          verification: 'verified',
          supportsCriterionIds: [CRITERION_ID],
          createdAt: LATER,
        }).evidence,
      ],
    },
    now: LATER,
  }).state;
  return state;
}

describe('grounded executive durable adapter', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('persists a turn journal and reloads it', () => {
    const state = runOneTurn();
    const result = persistGroundedTurnJournal(state);
    expect(result.persisted).toBe(true);
    expect(result.beliefEntries).toBeGreaterThan(0);
    expect(result.decisionEntries).toBeGreaterThan(0);
    expect(result.calibrationSamples).toBe(1);

    const beliefRows = listGroundedBeliefJournal({ turnId: 'turn-1' });
    expect(beliefRows.length).toBe(result.beliefEntries);
    expect(beliefRows[0]!.explanation.length).toBeGreaterThan(0);

    const decisionRows = listGroundedDecisionJournal({ turnId: 'turn-1' });
    expect(decisionRows.length).toBe(result.decisionEntries);
    expect(decisionRows[0]!.kind).toBe('act');

    const samples = listGroundedCalibrationSamples({
      contextKey: 'diagnostics|test',
    });
    expect(samples.length).toBe(1);
    expect(samples[0]!.outcome).toBe(1);
    expect(loadGroundedCalibrationSamples()[0]!.outcome).toBe(1);
  });

  it('re-persisting the same journal is idempotent', () => {
    const state = runOneTurn();
    persistGroundedTurnJournal(state);
    persistGroundedTurnJournal(state);
    expect(listGroundedBeliefJournal({ limit: 100 }).length).toBe(
      state.beliefJournal.length,
    );
    expect(listGroundedDecisionJournal({ limit: 100 }).length).toBe(
      state.decisions.length,
    );
    expect(listGroundedCalibrationSamples({ limit: 100 }).length).toBe(
      state.calibrationSamples.length,
    );
  });

  it('journal inserts never overwrite existing entries', () => {
    const state = runOneTurn();
    persistGroundedTurnJournal(state);
    const original = listGroundedBeliefJournal({ limit: 1 })[0]!;
    insertGroundedBeliefJournalEntry({
      ...original,
      explanation: 'attempted overwrite',
    });
    const after = listGroundedBeliefJournal({ limit: 100 }).find(
      (entry) => entry.entryId === original.entryId,
    );
    expect(after!.explanation).toBe(original.explanation);
  });

  it('follows the proposed -> accepted -> retired review lifecycle', () => {
    persistGroundedLearning([lesson()], NOW);
    expect(loadGroundedLearningForPlanning().length).toBe(0);

    const accepted = acceptGroundedLearningRecord(
      'learn-1',
      'Owner confirmed the failure pattern.',
      LATER,
    );
    expect(accepted!.status).toBe('accepted');
    const planning = loadGroundedLearningForPlanning({
      contextKey: 'diagnostics|test',
    });
    expect(planning.length).toBe(1);
    expect(planning[0]!.appliesToAuthority).toBe(false);

    const retired = retireGroundedLearningRecord(
      'learn-1',
      'The tool was fixed upstream.',
      LATER,
    );
    expect(retired!.status).toBe('retired');
    expect(loadGroundedLearningForPlanning().length).toBe(0);
    expect(
      listGroundedLearningRecords({ status: 'retired' })[0]!.reviewNote,
    ).toContain('fixed upstream');
  });

  it('rejects invalid learning status transitions', () => {
    persistGroundedLearning([lesson()], NOW);
    retireGroundedLearningRecord('learn-1', 'retired', LATER);
    expect(() =>
      upsertGroundedLearningRecord({
        ...listGroundedLearningRecords({ limit: 10 })[0]!,
        status: 'accepted',
      }),
    ).toThrow(/not allowed/);
  });

  it('never stores an authority-bearing learning row (insert path pins 0; CHECK guards the column)', () => {
    persistGroundedLearning([lesson()], NOW);
    const stored = listGroundedLearningRecords({ limit: 10 })[0]!;
    expect(stored.appliesToAuthority).toBe(false);
    expect(() =>
      upsertGroundedLearningRecord({
        ...stored,
        appliesToAuthority: true,
      } as unknown as StoredGroundedLearningRecord),
    ).not.toThrow();
    // The insert path hardcodes 0 and the CHECK constraint guards the column;
    // verify no row ever carries authority.
    for (const record of listGroundedLearningRecords({ limit: 10 })) {
      expect(record.appliesToAuthority).toBe(false);
    }
  });

  it('bridges verdicts to tool reliability without failing on unknown subjects', () => {
    const verification: GroundedOutcomeVerification = {
      verificationId: 'verification-1',
      createdAt: LATER,
      nodeId: 'node-1',
      verdict: 'failed',
      expected: 'Fresh typed evidence.',
      actual: 'The probe endpoint returned 500.',
      causalExplanation: 'Step failed (upstream_error).',
      invalidatedBeliefIds: [],
      replanTriggered: false,
      calibrationSampleId: null,
    };
    // Unregistered subject: safe no-op.
    expect(
      recordGroundedToolReliability(
        verification,
        ['not-a-real-subject'],
        LATER,
      ),
    ).toBe(0);
    // Uncertain verdicts are never reliability evidence.
    expect(
      recordGroundedToolReliability(
        { ...verification, verdict: 'uncertain' },
        ['not-a-real-subject'],
        LATER,
      ),
    ).toBe(0);
  });

  it('reports durable diagnostics counts', () => {
    const state = runOneTurn();
    persistGroundedTurnJournal(state);
    persistGroundedLearning([lesson()], NOW);
    const diagnostics = groundedDurableDiagnostics({ turnId: 'turn-1' });
    expect(diagnostics.learningCounts.proposed).toBe(1);
    expect(diagnostics.beliefJournalCount).toBeGreaterThan(0);
    expect(diagnostics.decisionJournalCount).toBeGreaterThan(0);
    expect(diagnostics.calibrationSampleCount).toBe(1);
  });
});
