import { describe, expect, it } from 'vitest';

import {
  buildGroundedContextBundle,
  completeGroundedCommitment,
  createGroundedGoal,
  explainGroundedMemoryTopic,
  formatGroundedContextBundle,
  groundedGoalEffectiveState,
  groundedMemoryEffectiveState,
  groundedMemoryRecordFromCandidate,
  normalizeGroundedSubjectKey,
  reconcileGroundedMemory,
  revokeGroundedMemoryRecord,
  transitionGroundedGoal,
  type GroundedMemoryCandidate,
  type GroundedMemoryRecord,
} from './grounded-memory.js';

const T0 = '2026-07-20T12:00:00.000Z';
const T1 = '2026-07-20T13:00:00.000Z';
const T2 = '2026-07-21T12:00:00.000Z';

function candidate(
  overrides: Partial<GroundedMemoryCandidate> = {},
): GroundedMemoryCandidate {
  return {
    kind: 'preference',
    subjectKey: 'preference:reply_style',
    statement: 'Jeff prefers concise replies.',
    value: 'concise',
    confidence: 0.9,
    sourceType: 'user_statement',
    observedAt: T0,
    ...overrides,
  };
}

function reconcile(
  existing: GroundedMemoryRecord[],
  incoming: GroundedMemoryCandidate[],
  now = T1,
) {
  return reconcileGroundedMemory({ existing, incoming, now });
}

describe('normalizeGroundedSubjectKey', () => {
  it('normalizes to a stable lowercase key', () => {
    expect(normalizeGroundedSubjectKey('Preference: Reply Style!')).toBe(
      'preference:_reply_style',
    );
    expect(normalizeGroundedSubjectKey('fact/home wifi')).toBe(
      'fact/home_wifi',
    );
  });
});

describe('truth maintenance', () => {
  it('creates a new active record from a user statement', () => {
    const { records, changes } = reconcile([], [candidate()], T0);
    expect(records.length).toBe(1);
    expect(records[0]!.state).toBe('active');
    expect(changes[0]!.kind).toBe('created');
  });

  it('is idempotent: the same candidate twice refreshes, never duplicates', () => {
    const first = reconcile([], [candidate()], T0);
    const second = reconcile(first.records, [candidate()], T1);
    expect(second.records.length).toBe(1);
    expect(second.changes[0]!.kind).toBe('refreshed');
    expect(second.records[0]!.updatedAt).toBe(T1);
  });

  it('a changed user preference supersedes without erasing history', () => {
    const first = reconcile([], [candidate()], T0);
    const second = reconcile(
      first.records,
      [candidate({ value: 'detailed', observedAt: T1 })],
      T1,
    );
    expect(second.records.length).toBe(2);
    const old = second.records.find((record) => record.value === 'concise')!;
    const current = second.records.find(
      (record) => record.value === 'detailed',
    )!;
    expect(old.state).toBe('superseded');
    expect(old.supersededByRecordId).toBe(current.recordId);
    expect(old.stateReason).toContain('changed preference');
    expect(current.state).toBe('active');
    expect(second.changes.some((c) => c.kind === 'superseded')).toBe(true);
  });

  it('newer direct evidence supersedes older inference', () => {
    const inferred = reconcile(
      [],
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:favorite_venue',
          sourceType: 'inference',
          value: 'the-blue-room',
          confidence: 0.7,
          observedAt: T0,
        }),
      ],
      T0,
    );
    const direct = reconcile(
      inferred.records,
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:favorite_venue',
          sourceType: 'direct_observation',
          value: 'the-red-hall',
          confidence: 0.9,
          observedAt: T1,
        }),
      ],
      T1,
    );
    const old = direct.records.find((r) => r.value === 'the-blue-room')!;
    const current = direct.records.find((r) => r.value === 'the-red-hall')!;
    expect(old.state).toBe('superseded');
    expect(current.state).toBe('active');
    expect(old.stateReason).toContain('direct_observation');
  });

  it('inference never displaces an existing user statement', () => {
    const stated = reconcile(
      [],
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:home_city',
          value: 'austin',
          sourceType: 'user_statement',
          observedAt: T0,
        }),
      ],
      T0,
    );
    const inferred = reconcile(
      stated.records,
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:home_city',
          value: 'dallas',
          sourceType: 'inference',
          confidence: 0.95,
          observedAt: T1,
        }),
      ],
      T1,
    );
    const statedRecord = inferred.records.find((r) => r.value === 'austin')!;
    const inferredRecord = inferred.records.find((r) => r.value === 'dallas')!;
    expect(statedRecord.state).toBe('active');
    expect(inferredRecord.state).toBe('uncertain');
    expect(inferredRecord.stateReason).toContain(
      'inference never displaces direct evidence',
    );
    expect(statedRecord.conflictingRecordIds).toContain(
      inferredRecord.recordId,
    );
    expect(inferredRecord.conflictingRecordIds).toContain(
      statedRecord.recordId,
    );
  });

  it('equal-strength contradictions keep both records visible and lower confidence', () => {
    const first = reconcile(
      [],
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:backup_status',
          value: 'complete',
          sourceType: 'direct_observation',
          confidence: 0.9,
          observedAt: T1,
        }),
      ],
      T1,
    );
    const second = reconcile(
      first.records,
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:backup_status',
          value: 'failed',
          sourceType: 'direct_observation',
          confidence: 0.9,
          observedAt: T0,
        }),
      ],
      T1,
    );
    const complete = second.records.find((r) => r.value === 'complete')!;
    const failed = second.records.find((r) => r.value === 'failed')!;
    expect(complete.state).toBe('uncertain');
    expect(failed.state).toBe('uncertain');
    expect(complete.confidence).toBeLessThan(0.9);
    expect(failed.confidence).toBeLessThan(0.9);
    expect(second.changes.some((c) => c.kind === 'contradiction_flagged')).toBe(
      true,
    );
  });

  it('low-confidence inference enters and stays uncertain', () => {
    const { records, changes } = reconcile(
      [],
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:mood',
          value: 'stressed',
          sourceType: 'inference',
          confidence: 0.4,
        }),
      ],
      T0,
    );
    expect(records[0]!.state).toBe('uncertain');
    expect(changes[0]!.kind).toBe('kept_uncertain');
    expect(records[0]!.stateReason).toContain('never treated as fact');
  });

  it('revocation is terminal and idempotent', () => {
    const { records } = reconcile([], [candidate()], T0);
    const revoked = revokeGroundedMemoryRecord(
      records,
      records[0]!.recordId,
      'The user asked to forget this.',
      T1,
    );
    expect(revoked.records[0]!.state).toBe('revoked');
    expect(revoked.changes[0]!.kind).toBe('revoked');
    const again = revokeGroundedMemoryRecord(
      revoked.records,
      records[0]!.recordId,
      'again',
      T2,
    );
    expect(again.changes.length).toBe(0);
    expect(again.records[0]!.state).toBe('revoked');
  });

  it('completing a commitment yields an outcome record and preserves the commitment', () => {
    const { records } = reconcile(
      [],
      [
        candidate({
          kind: 'commitment',
          subjectKey: 'commitment:send_setlist',
          statement: 'Jeff committed to drafting the setlist by Friday.',
          value: 'draft_setlist_by_friday',
        }),
      ],
      T0,
    );
    const completed = completeGroundedCommitment({
      records,
      commitmentRecordId: records[0]!.recordId,
      outcomeStatement: 'The setlist draft was completed on Thursday.',
      now: T1,
    });
    expect(completed.records.length).toBe(2);
    const commitment = completed.records.find((r) => r.kind === 'commitment')!;
    const outcome = completed.records.find((r) => r.kind === 'outcome')!;
    expect(commitment.state).toBe('superseded');
    expect(commitment.supersededByRecordId).toBe(outcome.recordId);
    expect(outcome.state).toBe('active');
    expect(outcome.provenanceRefs).toContain(commitment.recordId);
    expect(completed.changes[0]!.kind).toBe('completed');
  });

  it('expiry is a derived state, not a rewrite', () => {
    const record = groundedMemoryRecordFromCandidate(
      candidate({ effectiveUntil: T1 }),
      T0,
    );
    expect(groundedMemoryEffectiveState(record, T0)).toBe('active');
    expect(groundedMemoryEffectiveState(record, T2)).toBe('expired');
    expect(record.state).toBe('active');
  });
});

describe('goal continuity', () => {
  it('creates informational goals with pinned-false execution authority', () => {
    const goal = createGroundedGoal({
      title: 'Book rehearsal space',
      objective: 'Find and reserve a rehearsal space for Rad Dad in August.',
      nextProposedStep: 'Research availability at the usual three venues.',
      now: T0,
    });
    expect(goal.state).toBe('proposed');
    expect(goal.executionAuthority).toBe(false);
    expect(goal.nextProposedStep).toContain('Research availability');
  });

  it('enforces state transitions; cancelled stays cancelled', () => {
    let goal = createGroundedGoal({ title: 'G', objective: 'O', now: T0 });
    goal = transitionGroundedGoal({
      goal,
      state: 'active',
      reason: 'Confirmed by the user.',
      now: T0,
    });
    goal = transitionGroundedGoal({
      goal,
      state: 'cancelled',
      reason: 'The user cancelled it.',
      now: T1,
    });
    expect(goal.state).toBe('cancelled');
    expect(() =>
      transitionGroundedGoal({
        goal,
        state: 'active',
        reason: 'reactivate',
        now: T2,
      }),
    ).toThrow(/not allowed/);
    // Terminal self-transition stays legal (idempotent re-persist).
    expect(
      transitionGroundedGoal({
        goal,
        state: 'cancelled',
        reason: 'still cancelled',
        now: T2,
      }).state,
    ).toBe('cancelled');
  });

  it('blocked goals carry blockers and a verified outcome trail', () => {
    let goal = createGroundedGoal({ title: 'G', objective: 'O', now: T0 });
    goal = transitionGroundedGoal({
      goal,
      state: 'active',
      reason: 'Confirmed.',
      now: T0,
    });
    goal = transitionGroundedGoal({
      goal,
      state: 'blocked',
      reason: 'Waiting on the venue to reply.',
      blockers: ['Venue has not replied to the availability request.'],
      verifiedOutcome: 'Availability request was sent and acknowledged.',
      now: T1,
    });
    expect(goal.blockers.length).toBe(1);
    expect(goal.lastVerifiedOutcome).toContain('acknowledged');
    expect(goal.lastVerifiedAt).toBe(T1);
  });

  it('reads as stale past its review deadline without a state rewrite', () => {
    let goal = createGroundedGoal({
      title: 'G',
      objective: 'O',
      reviewBy: T1,
      now: T0,
    });
    goal = transitionGroundedGoal({
      goal,
      state: 'active',
      reason: 'Confirmed.',
      now: T0,
    });
    expect(groundedGoalEffectiveState(goal, T0)).toBe('active');
    expect(groundedGoalEffectiveState(goal, T2)).toBe('stale');
    expect(goal.state).toBe('active');
  });
});

describe('grounded context bundle', () => {
  function corpus(): GroundedMemoryRecord[] {
    const base = reconcile(
      [],
      [
        candidate(),
        candidate({
          kind: 'fact',
          subjectKey: 'fact:band_practice_day',
          statement: 'Rad Dad practices on Tuesdays.',
          value: 'tuesday',
          sourceType: 'user_statement',
        }),
        candidate({
          kind: 'fact',
          subjectKey: 'fact:unrelated_trivia',
          statement: 'The garage door code was rotated.',
          value: 'rotated',
          sourceType: 'direct_observation',
          sensitivity: 'secret',
        }),
        candidate({
          kind: 'fact',
          subjectKey: 'fact:old_venue',
          statement: 'The old venue may be closing.',
          value: 'closing',
          sourceType: 'inference',
          confidence: 0.3,
        }),
        candidate({
          kind: 'fact',
          subjectKey: 'fact:practice_room',
          statement: 'Practice room booking expires soon.',
          value: 'booked',
          sourceType: 'direct_observation',
          effectiveUntil: T1,
        }),
      ],
      T0,
    );
    return base.records;
  }

  it('excludes revoked, expired, secret, and low-confidence records with reasons', () => {
    const records = corpus();
    const revoked = revokeGroundedMemoryRecord(
      records,
      records[0]!.recordId,
      'forget it',
      T1,
    ).records;
    const bundle = buildGroundedContextBundle({
      records: revoked,
      topics: ['practice', 'band', 'reply style'],
      now: T2,
    });
    const reasons = new Map(
      bundle.excluded.map((entry) => [entry.recordId, entry.reason]),
    );
    expect(reasons.get(records[0]!.recordId)).toBe('revoked');
    const secret = revoked.find((r) => r.sensitivity === 'secret')!;
    expect(reasons.get(secret.recordId)).toBe('sensitivity');
    const expired = revoked.find((r) => r.effectiveUntil === T1)!;
    expect(reasons.get(expired.recordId)).toBe('expired');
    const lowConfidence = revoked.find((r) => r.confidence === 0.3)!;
    expect(reasons.get(lowConfidence.recordId)).toBe('uncertain_by_default');
    expect(bundle.items.every((item) => item.inclusionReason.length > 0)).toBe(
      true,
    );
  });

  it('enforces the item budget deterministically and reports truncation', () => {
    const many = reconcile(
      [],
      Array.from({ length: 30 }, (_, index) =>
        candidate({
          kind: 'fact',
          subjectKey: `fact:practice_item_${index}`,
          statement: `Practice-related fact number ${index}.`,
          value: `v${index}`,
          sourceType: 'direct_observation',
        }),
      ),
      T0,
    ).records;
    const bundle = buildGroundedContextBundle({
      records: many,
      topics: ['practice'],
      now: T1,
      maxItems: 8,
    });
    expect(bundle.items.length).toBe(8);
    expect(bundle.budget.truncated).toBe(true);
    expect(
      bundle.excluded.filter((entry) => entry.reason === 'budget').length,
    ).toBe(22);
    const again = buildGroundedContextBundle({
      records: many,
      topics: ['practice'],
      now: T1,
      maxItems: 8,
    });
    expect(again.items.map((i) => i.recordId)).toEqual(
      bundle.items.map((i) => i.recordId),
    );
  });

  it('surfaces contradictions instead of picking a winner', () => {
    const conflicted = reconcile(
      reconcile(
        [],
        [
          candidate({
            kind: 'fact',
            subjectKey: 'fact:backup_status',
            value: 'complete',
            sourceType: 'direct_observation',
            observedAt: T0,
          }),
        ],
        T0,
      ).records,
      [
        candidate({
          kind: 'fact',
          subjectKey: 'fact:backup_status',
          value: 'failed',
          sourceType: 'direct_observation',
          observedAt: T0,
        }),
      ],
      T1,
    ).records;
    const bundle = buildGroundedContextBundle({
      records: conflicted,
      topics: ['backup'],
      now: T1,
      includeUncertain: true,
    });
    expect(bundle.contradictions.length).toBe(1);
    expect(bundle.contradictions[0]!.subjectKey).toBe('fact:backup_status');
    expect(bundle.uncertainties.join(' ')).toContain('backup_status');
  });

  it('prefers recent direct evidence over older inference in ranking', () => {
    const records = [
      groundedMemoryRecordFromCandidate(
        candidate({
          kind: 'fact',
          subjectKey: 'fact:venue_hint',
          statement: 'Venue guess from inference.',
          value: 'guess',
          sourceType: 'inference',
          confidence: 0.9,
          observedAt: '2026-06-01T00:00:00.000Z',
        }),
        T0,
      ),
      groundedMemoryRecordFromCandidate(
        candidate({
          kind: 'fact',
          subjectKey: 'fact:venue_confirmed',
          statement: 'Venue confirmed by direct observation.',
          value: 'confirmed',
          sourceType: 'direct_observation',
          confidence: 0.9,
          observedAt: T0,
        }),
        T0,
      ),
    ];
    const bundle = buildGroundedContextBundle({
      records,
      topics: ['venue'],
      now: T1,
    });
    expect(bundle.items[0]!.subjectKey).toBe('fact:venue_confirmed');
    expect(bundle.items[0]!.relevance).toBeGreaterThan(
      bundle.items[1]!.relevance,
    );
  });

  it('includes only informational goal summaries and formats cleanly', () => {
    let goal = createGroundedGoal({
      title: 'Book rehearsal space',
      objective: 'Reserve a room for August practice.',
      nextProposedStep: 'Compare the three usual venues.',
      now: T0,
    });
    goal = transitionGroundedGoal({
      goal,
      state: 'active',
      reason: 'Confirmed.',
      now: T0,
    });
    const bundle = buildGroundedContextBundle({
      records: corpus(),
      goals: [goal],
      topics: ['practice'],
      now: T0,
    });
    expect(bundle.goals.length).toBe(1);
    expect(bundle.goals[0]!.inclusionReason).toContain(
      'no execution authority',
    );
    const text = formatGroundedContextBundle(bundle);
    expect(text).toContain('Grounded context bundle');
    expect(text).toContain('next(informational)');
  });
});

describe('explainGroundedMemoryTopic', () => {
  it('shows active beliefs, history, and contradictions for a topic', () => {
    const first = reconcile([], [candidate()], T0);
    const second = reconcile(
      first.records,
      [candidate({ value: 'detailed', observedAt: T1 })],
      T1,
    );
    const explanation = explainGroundedMemoryTopic({
      records: second.records,
      topic: 'preference:reply_style',
      now: T1,
    });
    expect(explanation.active.length).toBe(1);
    expect(explanation.active[0]!.value).toBe('detailed');
    expect(explanation.history.length).toBe(1);
    expect(explanation.history[0]!.value).toBe('concise');
    expect(explanation.history[0]!.stateReason).toContain('changed preference');
  });
});
