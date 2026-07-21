import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  listGroundedGoals,
  listGroundedMemoryRecords,
  upsertGroundedGoal,
  upsertGroundedMemoryRecord,
} from './db.js';
import {
  completeGroundedCommitmentDurably,
  createGroundedGoalDurably,
  diffGroundedMemorySince,
  explainGroundedMemoryTopicDurably,
  groundedMemoryDurableDiagnostics,
  loadGroundedContextBundle,
  loadGroundedGoals,
  loadGroundedMemoryRecords,
  rememberGroundedMemory,
  revokeGroundedMemory,
  transitionGroundedGoalDurably,
} from './grounded-memory-durable-adapter.js';
import type { GroundedMemoryCandidate } from './grounded-memory.js';

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

describe('grounded memory durable adapter (in-memory db)', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('persists reconciled memory idempotently', () => {
    const first = rememberGroundedMemory({
      candidates: [candidate()],
      now: T0,
    });
    expect(first.persisted).toBe(true);
    const second = rememberGroundedMemory({
      candidates: [candidate()],
      now: T1,
    });
    expect(second.changes[0]!.kind).toBe('refreshed');
    expect(listGroundedMemoryRecords({ limit: 50 }).length).toBe(1);
  });

  it('runs the changed-preference supersession through the store', () => {
    rememberGroundedMemory({ candidates: [candidate()], now: T0 });
    rememberGroundedMemory({
      candidates: [candidate({ value: 'detailed', observedAt: T1 })],
      now: T1,
    });
    const records = loadGroundedMemoryRecords({
      subjectKey: 'preference:reply_style',
    });
    expect(records.length).toBe(2);
    expect(records.find((r) => r.value === 'concise')!.state).toBe(
      'superseded',
    );
    expect(records.find((r) => r.value === 'detailed')!.state).toBe('active');
  });

  it('guards memory state transitions at the db layer', () => {
    rememberGroundedMemory({ candidates: [candidate()], now: T0 });
    const stored = listGroundedMemoryRecords({ limit: 10 })[0]!;
    revokeGroundedMemory(stored.recordId, 'forget it', T1);
    expect(() =>
      upsertGroundedMemoryRecord({
        ...listGroundedMemoryRecords({ limit: 10 })[0]!,
        state: 'active',
      }),
    ).toThrow(/not allowed/);
  });

  it('completes commitments durably with history preserved', () => {
    rememberGroundedMemory({
      candidates: [
        candidate({
          kind: 'commitment',
          subjectKey: 'commitment:send_setlist',
          value: 'draft_setlist_by_friday',
        }),
      ],
      now: T0,
    });
    const commitment = listGroundedMemoryRecords({ kind: 'commitment' })[0]!;
    const changes = completeGroundedCommitmentDurably({
      commitmentRecordId: commitment.recordId,
      outcomeStatement: 'Setlist drafted Thursday.',
      now: T1,
    });
    expect(changes[0]!.kind).toBe('completed');
    expect(listGroundedMemoryRecords({ kind: 'outcome' }).length).toBe(1);
    expect(listGroundedMemoryRecords({ kind: 'commitment' })[0]!.state).toBe(
      'superseded',
    );
  });

  it('creates, transitions, and terminally pins goals', () => {
    const goal = createGroundedGoalDurably({
      title: 'Book rehearsal space',
      objective: 'Reserve a room for August practice.',
      nextProposedStep: 'Compare the usual three venues.',
      now: T0,
    })!;
    transitionGroundedGoalDurably({
      goalId: goal.goalId,
      state: 'active',
      reason: 'Confirmed by the user.',
      now: T0,
    });
    transitionGroundedGoalDurably({
      goalId: goal.goalId,
      state: 'cancelled',
      reason: 'The user cancelled it.',
      now: T1,
    });
    expect(
      transitionGroundedGoalDurably({
        goalId: goal.goalId,
        state: 'active',
        reason: 'try to reactivate',
        now: T2,
      }),
    ).toBeNull();
    expect(listGroundedGoals({ limit: 10 })[0]!.state).toBe('cancelled');
  });

  it('rejects direct db writes that resurrect terminal goals', () => {
    const goal = createGroundedGoalDurably({
      title: 'G',
      objective: 'O',
      now: T0,
    })!;
    transitionGroundedGoalDurably({
      goalId: goal.goalId,
      state: 'cancelled',
      reason: 'cancelled',
      now: T0,
    });
    const stored = listGroundedGoals({ limit: 10 })[0]!;
    expect(() => upsertGroundedGoal({ ...stored, state: 'active' })).toThrow(
      /not allowed/,
    );
  });

  it('builds a bounded bundle from the durable store', () => {
    rememberGroundedMemory({
      candidates: [
        candidate(),
        candidate({
          kind: 'fact',
          subjectKey: 'fact:band_practice_day',
          statement: 'Rad Dad practices on Tuesdays.',
          value: 'tuesday',
        }),
      ],
      now: T0,
    });
    createGroundedGoalDurably({
      title: 'Plan practice schedule',
      objective: 'Keep the Tuesday practice cadence.',
      now: T0,
    });
    const bundle = loadGroundedContextBundle({
      topics: ['practice'],
      now: T1,
      maxItems: 5,
    });
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.goals.length).toBe(1);
    expect(bundle.retrievalReasoning.length).toBeGreaterThan(0);
  });

  it('explains topics and diffs changes read-only', () => {
    rememberGroundedMemory({ candidates: [candidate()], now: T0 });
    rememberGroundedMemory({
      candidates: [candidate({ value: 'detailed', observedAt: T1 })],
      now: T1,
    });
    const explanation = explainGroundedMemoryTopicDurably({
      topic: 'preference:reply_style',
      now: T1,
    });
    expect(explanation.active[0]!.value).toBe('detailed');
    expect(explanation.history[0]!.value).toBe('concise');
    const diff = diffGroundedMemorySince(T0, {});
    expect(diff.memory.length).toBeGreaterThan(0);
    const diagnostics = groundedMemoryDurableDiagnostics(T1);
    expect(diagnostics.memoryCounts.active).toBe(1);
    expect(diagnostics.memoryCounts.superseded).toBe(1);
  });
});

describe('grounded memory restart continuity (file-backed db)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    _closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounded-memory-'));
    tempDirs.push(dir);
    return path.join(dir, 'test.db');
  }

  it('memory and goals survive a database restart', () => {
    const dbPath = tempDbPath();
    _initTestDatabaseAtPath(dbPath);
    rememberGroundedMemory({ candidates: [candidate()], now: T0 });
    const goal = createGroundedGoalDurably({
      title: 'Book rehearsal space',
      objective: 'Reserve a room for August practice.',
      nextProposedStep: 'Compare the usual three venues.',
      now: T0,
    })!;
    transitionGroundedGoalDurably({
      goalId: goal.goalId,
      state: 'active',
      reason: 'Confirmed.',
      now: T0,
    });
    _closeDatabase();

    _initTestDatabaseAtPath(dbPath);
    const records = loadGroundedMemoryRecords({});
    expect(records.length).toBe(1);
    expect(records[0]!.value).toBe('concise');
    const goals = loadGroundedGoals({});
    expect(goals.length).toBe(1);
    expect(goals[0]!.state).toBe('active');
    expect(goals[0]!.nextProposedStep).toContain('Compare');
  });

  it('cancelled goals stay cancelled across restart', () => {
    const dbPath = tempDbPath();
    _initTestDatabaseAtPath(dbPath);
    const goal = createGroundedGoalDurably({
      title: 'G',
      objective: 'O',
      now: T0,
    })!;
    transitionGroundedGoalDurably({
      goalId: goal.goalId,
      state: 'cancelled',
      reason: 'cancelled by the user',
      now: T0,
    });
    _closeDatabase();

    _initTestDatabaseAtPath(dbPath);
    expect(loadGroundedGoals({})[0]!.state).toBe('cancelled');
    expect(
      transitionGroundedGoalDurably({
        goalId: goal.goalId,
        state: 'active',
        reason: 'reactivate after restart',
        now: T1,
      }),
    ).toBeNull();
    expect(loadGroundedGoals({})[0]!.state).toBe('cancelled');
  });

  it('upgrades a pre-feature database in place without touching other data', () => {
    const dbPath = tempDbPath();
    // Simulate a representative pre-upgrade database: full prior schema plus
    // data, minus the grounded memory/goal tables.
    _initTestDatabaseAtPath(dbPath);
    rememberGroundedMemory({ candidates: [candidate()], now: T0 });
    _closeDatabase();
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE grounded_memory_records; DROP TABLE grounded_goals;');
    raw.exec(
      `CREATE TABLE IF NOT EXISTS legacy_probe (id TEXT PRIMARY KEY, note TEXT);
       INSERT INTO legacy_probe (id, note) VALUES ('probe-1', 'survives upgrade');`,
    );
    raw.close();

    // Reopening through the normal path recreates the tables (idempotent
    // CREATE TABLE IF NOT EXISTS migration) and leaves other data intact.
    _initTestDatabaseAtPath(dbPath);
    expect(loadGroundedMemoryRecords({}).length).toBe(0);
    rememberGroundedMemory({ candidates: [candidate()], now: T1 });
    expect(loadGroundedMemoryRecords({}).length).toBe(1);
    _closeDatabase();
    const verify = new Database(dbPath, { readonly: true });
    const probe = verify
      .prepare('SELECT note FROM legacy_probe WHERE id = ?')
      .get('probe-1') as { note: string } | undefined;
    verify.close();
    expect(probe?.note).toBe('survives upgrade');
  });
});
