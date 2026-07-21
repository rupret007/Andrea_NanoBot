import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  listGroundedMemoryRecords,
} from './db.js';
import {
  completeGroundedCommitmentDurably,
  createGroundedGoalDurably,
  explainGroundedMemoryTopicDurably,
  loadGroundedContextBundle,
  loadGroundedGoals,
  loadGroundedMemoryRecords,
  rememberGroundedMemory,
  revokeGroundedMemory,
  transitionGroundedGoalDurably,
} from './grounded-memory-durable-adapter.js';
import {
  groundedGoalEffectiveState,
  type GroundedMemoryCandidate,
} from './grounded-memory.js';

/**
 * Deterministic cross-turn evaluation for Grounded Memory and Goal
 * Continuity. Every scenario runs against a hermetic database (in-memory,
 * or a throwaway file for restart continuity), with fixed clocks and
 * synthetic content — no network, no live tools, no real messages, no
 * schedules. Goals and next proposed steps are asserted to be
 * informational only.
 */

export const GROUNDED_MEMORY_EVAL_VERSION = '1.0.0';
export const GROUNDED_MEMORY_EVAL_BASELINE_VERSION = '2026-07-21.1';

const T0 = '2026-07-20T12:00:00.000Z';
const T1 = '2026-07-20T13:00:00.000Z';
const T2 = '2026-07-21T12:00:00.000Z';

export interface GroundedMemoryEvalScenarioResult {
  scenarioId: string;
  description: string;
  retrieved: number;
  excluded: number;
  confidenceNote: string;
  contradictionNote: string;
  goalState: string;
  expected: string;
  actual: string;
  correct: boolean;
}

export interface GroundedMemoryEvalReport {
  version: string;
  baselineVersion: string;
  generatedAt: string;
  scenarios: GroundedMemoryEvalScenarioResult[];
  passCount: number;
  failCount: number;
  regressions: string[];
}

/** Frozen expectations: every scenario is expected to pass. */
export const GROUNDED_MEMORY_EVAL_BASELINE: Record<string, { correct: true }> =
  {
    'preference-recorded': { correct: true },
    'preference-changed-supersedes': { correct: true },
    'preference-history-preserved': { correct: true },
    'stale-fact-expires': { correct: true },
    'contradictory-sources-both-visible': { correct: true },
    'contradiction-lowers-confidence': { correct: true },
    'low-confidence-inference-uncertain': { correct: true },
    'direct-evidence-beats-old-inference': { correct: true },
    'inference-never-displaces-user-statement': { correct: true },
    'commitment-completed-outcome': { correct: true },
    'commitment-cancelled-stays-revoked': { correct: true },
    'duplicate-write-idempotent': { correct: true },
    'memory-survives-restart': { correct: true },
    'goal-survives-restart': { correct: true },
    'cancelled-goal-stays-cancelled-across-restart': { correct: true },
    'completed-goal-terminal': { correct: true },
    'blocked-goal-visible-with-blocker': { correct: true },
    'goal-stale-past-review': { correct: true },
    'proposed-step-never-executes': { correct: true },
    'bounded-retrieval-budget': { correct: true },
    'irrelevant-and-secret-excluded': { correct: true },
    'revoked-excluded-with-reason': { correct: true },
    'retrieval-explains-every-inclusion': { correct: true },
    'recent-direct-beats-old-inference-ranking': { correct: true },
  };

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

interface ScenarioOutcome {
  description: string;
  retrieved: number;
  excluded: number;
  confidenceNote: string;
  contradictionNote: string;
  goalState: string;
  expected: string;
  actual: string;
  correct: boolean;
}

type ScenarioRunner = () => ScenarioOutcome;

function withHermeticDb(run: () => ScenarioOutcome): ScenarioOutcome {
  _initTestDatabase();
  try {
    return run();
  } finally {
    _closeDatabase();
  }
}

function withRestart(
  before: () => void,
  after: () => ScenarioOutcome,
): ScenarioOutcome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounded-memory-eval-'));
  const dbPath = path.join(dir, 'eval.db');
  try {
    _initTestDatabaseAtPath(dbPath);
    before();
    _closeDatabase();
    _initTestDatabaseAtPath(dbPath);
    try {
      return after();
    } finally {
      _closeDatabase();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const none = {
  retrieved: 0,
  excluded: 0,
  confidenceNote: '',
  contradictionNote: 'none',
  goalState: 'n/a',
};

const SCENARIOS: Array<{ scenarioId: string; run: ScenarioRunner }> = [
  {
    scenarioId: 'preference-recorded',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        const records = loadGroundedMemoryRecords({
          subjectKey: 'preference:reply_style',
        });
        const actual = `${records.length} record(s), state=${records[0]?.state}, source=${records[0]?.sourceType}`;
        return {
          ...none,
          description: 'A stated preference becomes an active durable record.',
          confidenceNote: `confidence=${records[0]?.confidence.toFixed(2)}`,
          expected: '1 record(s), state=active, source=user_statement',
          actual,
          correct:
            actual === '1 record(s), state=active, source=user_statement',
        };
      }),
  },
  {
    scenarioId: 'preference-changed-supersedes',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        rememberGroundedMemory({
          candidates: [candidate({ value: 'detailed', observedAt: T1 })],
          now: T1,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['reply style'],
          now: T1,
        });
        const actual = `retrieved=${bundle.items.map((item) => item.value).join(',')}`;
        return {
          ...none,
          description:
            'A changed preference wins retrieval; the old one is superseded.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'retrieved=detailed',
          actual,
          correct: actual === 'retrieved=detailed',
        };
      }),
  },
  {
    scenarioId: 'preference-history-preserved',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        rememberGroundedMemory({
          candidates: [candidate({ value: 'detailed', observedAt: T1 })],
          now: T1,
        });
        const explanation = explainGroundedMemoryTopicDurably({
          topic: 'preference:reply_style',
          now: T1,
        });
        const history = explanation.history[0];
        const actual = `history=${history?.value}:${history?.state}; reason mentions change=${history?.stateReason.includes('changed preference')}`;
        return {
          ...none,
          description:
            'Supersession preserves the old preference with an explanation.',
          expected: 'history=concise:superseded; reason mentions change=true',
          actual,
          correct:
            actual ===
            'history=concise:superseded; reason mentions change=true',
        };
      }),
  },
  {
    scenarioId: 'stale-fact-expires',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:practice_room_booking',
              statement: 'The practice room is booked through today.',
              value: 'booked',
              sourceType: 'direct_observation',
              effectiveUntil: T1,
            }),
          ],
          now: T0,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['practice room'],
          now: T2,
        });
        const reason = bundle.excluded[0]?.reason;
        return {
          ...none,
          description: 'A fact past its expiry never reads as current truth.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'retrieved=0, excludedReason=expired',
          actual: `retrieved=${bundle.items.length}, excludedReason=${reason}`,
          correct: bundle.items.length === 0 && reason === 'expired',
        };
      }),
  },
  {
    scenarioId: 'contradictory-sources-both-visible',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:backup_status',
              value: 'complete',
              sourceType: 'direct_observation',
            }),
          ],
          now: T0,
        });
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:backup_status',
              value: 'failed',
              sourceType: 'direct_observation',
              observedAt: T0,
            }),
          ],
          now: T1,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['backup'],
          now: T1,
        });
        const records = loadGroundedMemoryRecords({
          subjectKey: 'fact:backup_status',
        });
        const bothUncertain = records.every(
          (record) => record.state === 'uncertain',
        );
        return {
          ...none,
          description:
            'Equal-strength conflicting observations both stay visible.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          contradictionNote: bundle.contradictions[0]?.note ?? 'missing',
          expected: 'bothUncertain=true, contradictionsSurfaced=1',
          actual: `bothUncertain=${bothUncertain}, contradictionsSurfaced=${bundle.contradictions.length}`,
          correct: bothUncertain && bundle.contradictions.length === 1,
        };
      }),
  },
  {
    scenarioId: 'contradiction-lowers-confidence',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:backup_status',
              value: 'complete',
              sourceType: 'direct_observation',
              confidence: 0.9,
            }),
          ],
          now: T0,
        });
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:backup_status',
              value: 'failed',
              sourceType: 'direct_observation',
              confidence: 0.9,
              observedAt: T0,
            }),
          ],
          now: T1,
        });
        const records = loadGroundedMemoryRecords({
          subjectKey: 'fact:backup_status',
        });
        const maxConfidence = Math.max(
          ...records.map((record) => record.confidence),
        );
        return {
          ...none,
          description: 'A contradiction lowers confidence on both sides.',
          confidenceNote: `max confidence after conflict=${maxConfidence.toFixed(2)}`,
          expected: 'maxConfidence<0.9',
          actual: `maxConfidence=${maxConfidence.toFixed(2)}`,
          correct: maxConfidence < 0.9,
        };
      }),
  },
  {
    scenarioId: 'low-confidence-inference-uncertain',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:mood',
              statement: 'Jeff seems stressed lately.',
              value: 'stressed',
              sourceType: 'inference',
              confidence: 0.45,
            }),
          ],
          now: T0,
        });
        const record = loadGroundedMemoryRecords({
          subjectKey: 'fact:mood',
        })[0];
        const bundle = loadGroundedContextBundle({ topics: ['mood'], now: T0 });
        return {
          ...none,
          description:
            'Low-confidence inference stays uncertain and out of default retrieval.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          confidenceNote: `stored state=${record?.state}`,
          expected: 'state=uncertain, retrieved=0',
          actual: `state=${record?.state}, retrieved=${bundle.items.length}`,
          correct: record?.state === 'uncertain' && bundle.items.length === 0,
        };
      }),
  },
  {
    scenarioId: 'direct-evidence-beats-old-inference',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:favorite_venue',
              value: 'the-blue-room',
              sourceType: 'inference',
              confidence: 0.7,
            }),
          ],
          now: T0,
        });
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:favorite_venue',
              value: 'the-red-hall',
              sourceType: 'direct_observation',
              observedAt: T1,
            }),
          ],
          now: T1,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['favorite venue'],
          now: T1,
        });
        const records = loadGroundedMemoryRecords({
          subjectKey: 'fact:favorite_venue',
        });
        const inference = records.find((r) => r.value === 'the-blue-room');
        return {
          ...none,
          description: 'Fresh direct evidence supersedes the old inference.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'retrieved=the-red-hall, inferenceState=superseded',
          actual: `retrieved=${bundle.items.map((i) => i.value).join(',')}, inferenceState=${inference?.state}`,
          correct:
            bundle.items.length === 1 &&
            bundle.items[0]!.value === 'the-red-hall' &&
            inference?.state === 'superseded',
        };
      }),
  },
  {
    scenarioId: 'inference-never-displaces-user-statement',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:home_city',
              value: 'austin',
              sourceType: 'user_statement',
            }),
          ],
          now: T0,
        });
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:home_city',
              value: 'dallas',
              sourceType: 'inference',
              confidence: 0.95,
              observedAt: T1,
            }),
          ],
          now: T1,
        });
        const records = loadGroundedMemoryRecords({
          subjectKey: 'fact:home_city',
        });
        const stated = records.find((r) => r.value === 'austin');
        const inferred = records.find((r) => r.value === 'dallas');
        return {
          ...none,
          description:
            'A high-confidence inference cannot displace a user statement.',
          contradictionNote: inferred?.stateReason ?? '',
          expected: 'stated=active, inferred=uncertain',
          actual: `stated=${stated?.state}, inferred=${inferred?.state}`,
          correct:
            stated?.state === 'active' && inferred?.state === 'uncertain',
        };
      }),
  },
  {
    scenarioId: 'commitment-completed-outcome',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'commitment',
              subjectKey: 'commitment:send_setlist',
              statement: 'Jeff committed to drafting the setlist by Friday.',
              value: 'draft_setlist_by_friday',
            }),
          ],
          now: T0,
        });
        const commitment = listGroundedMemoryRecords({
          kind: 'commitment',
        })[0]!;
        completeGroundedCommitmentDurably({
          commitmentRecordId: commitment.recordId,
          outcomeStatement: 'The setlist draft was completed on Thursday.',
          now: T1,
        });
        const outcome = listGroundedMemoryRecords({ kind: 'outcome' })[0];
        const after = listGroundedMemoryRecords({ kind: 'commitment' })[0]!;
        return {
          ...none,
          description:
            'Completing a commitment records an outcome and closes the commitment.',
          expected: 'commitment=superseded, outcome=active',
          actual: `commitment=${after.state}, outcome=${outcome?.state}`,
          correct: after.state === 'superseded' && outcome?.state === 'active',
        };
      }),
  },
  {
    scenarioId: 'commitment-cancelled-stays-revoked',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'commitment',
              subjectKey: 'commitment:book_show',
              value: 'book_show_in_august',
            }),
          ],
          now: T0,
        });
        const record = listGroundedMemoryRecords({ kind: 'commitment' })[0]!;
        revokeGroundedMemory(record.recordId, 'The show was cancelled.', T1);
        // A replayed observation of the same commitment must not resurrect it.
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'commitment',
              subjectKey: 'commitment:book_show',
              value: 'book_show_in_august',
            }),
          ],
          now: T2,
        });
        const states = listGroundedMemoryRecords({ kind: 'commitment' }).map(
          (r) => r.state,
        );
        const revokedStays = states.includes('revoked');
        return {
          ...none,
          description: 'A cancelled commitment stays revoked even on replay.',
          expected: 'revoked record persists',
          actual: `states=${states.sort().join(',')}`,
          correct: revokedStays,
        };
      }),
  },
  {
    scenarioId: 'duplicate-write-idempotent',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        rememberGroundedMemory({ candidates: [candidate()], now: T1 });
        rememberGroundedMemory({ candidates: [candidate()], now: T2 });
        const count = loadGroundedMemoryRecords({
          subjectKey: 'preference:reply_style',
        }).length;
        return {
          ...none,
          description: 'Replayed identical candidates never duplicate rows.',
          expected: '1 record',
          actual: `${count} record(s)`,
          correct: count === 1,
        };
      }),
  },
  {
    scenarioId: 'memory-survives-restart',
    run: () =>
      withRestart(
        () => {
          rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        },
        () => {
          const records = loadGroundedMemoryRecords({
            subjectKey: 'preference:reply_style',
          });
          return {
            ...none,
            description: 'Memory records survive a process/database restart.',
            expected: '1 active record after restart',
            actual: `${records.length} record(s), state=${records[0]?.state}`,
            correct: records.length === 1 && records[0]!.state === 'active',
          };
        },
      ),
  },
  {
    scenarioId: 'goal-survives-restart',
    run: () =>
      withRestart(
        () => {
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
        },
        () => {
          const goal = loadGroundedGoals({})[0];
          return {
            ...none,
            description:
              'An active goal and its next proposed step survive restart.',
            goalState: goal?.state ?? 'missing',
            expected: 'state=active, nextStep preserved',
            actual: `state=${goal?.state}, nextStep=${goal?.nextProposedStep?.slice(0, 24)}`,
            correct:
              goal?.state === 'active' &&
              Boolean(goal?.nextProposedStep?.includes('Compare')),
          };
        },
      ),
  },
  {
    scenarioId: 'cancelled-goal-stays-cancelled-across-restart',
    run: () =>
      withRestart(
        () => {
          const goal = createGroundedGoalDurably({
            title: 'Old goal',
            objective: 'Something the user cancelled.',
            now: T0,
          })!;
          transitionGroundedGoalDurably({
            goalId: goal.goalId,
            state: 'cancelled',
            reason: 'Cancelled by the user.',
            now: T0,
          });
        },
        () => {
          const goal = loadGroundedGoals({})[0]!;
          const reactivation = transitionGroundedGoalDurably({
            goalId: goal.goalId,
            state: 'active',
            reason: 'attempt to reactivate after restart',
            now: T1,
          });
          const after = loadGroundedGoals({})[0]!;
          return {
            ...none,
            description: 'A cancelled goal stays cancelled across restart.',
            goalState: after.state,
            expected: 'reactivation rejected, state=cancelled',
            actual: `reactivation=${reactivation === null ? 'rejected' : 'allowed'}, state=${after.state}`,
            correct: reactivation === null && after.state === 'cancelled',
          };
        },
      ),
  },
  {
    scenarioId: 'completed-goal-terminal',
    run: () =>
      withHermeticDb(() => {
        const goal = createGroundedGoalDurably({
          title: 'G',
          objective: 'O',
          now: T0,
        })!;
        transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'active',
          reason: 'Confirmed.',
          now: T0,
        });
        transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'completed',
          reason: 'Verified done.',
          verifiedOutcome: 'The room was booked and confirmed.',
          now: T1,
        });
        const blocked = transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'blocked',
          reason: 'should be rejected',
          now: T2,
        });
        const after = loadGroundedGoals({})[0]!;
        return {
          ...none,
          description: 'A completed goal is terminal with a verified outcome.',
          goalState: after.state,
          expected:
            'state=completed, laterTransition=rejected, outcome recorded',
          actual: `state=${after.state}, laterTransition=${blocked === null ? 'rejected' : 'allowed'}, outcome=${after.lastVerifiedOutcome ? 'recorded' : 'missing'}`,
          correct:
            after.state === 'completed' &&
            blocked === null &&
            Boolean(after.lastVerifiedOutcome),
        };
      }),
  },
  {
    scenarioId: 'blocked-goal-visible-with-blocker',
    run: () =>
      withHermeticDb(() => {
        const goal = createGroundedGoalDurably({
          title: 'Book rehearsal space',
          objective: 'Reserve a room for August practice.',
          now: T0,
        })!;
        transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'active',
          reason: 'Confirmed.',
          now: T0,
        });
        transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'blocked',
          reason: 'Waiting on the venue.',
          blockers: ['Venue has not replied to the availability request.'],
          nextProposedStep: 'Ask Jeff whether to try the backup venue.',
          now: T1,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['rehearsal'],
          now: T1,
        });
        const goalItem = bundle.goals[0];
        return {
          ...none,
          description: 'A blocked goal surfaces its blocker in retrieval.',
          retrieved: bundle.items.length,
          goalState: goalItem?.state ?? 'missing',
          expected: 'state=blocked with 1 blocker and informational next step',
          actual: `state=${goalItem?.state}, blockers=${goalItem?.blockers.length}, next=${goalItem?.nextProposedStep ? 'present' : 'missing'}`,
          correct:
            goalItem?.state === 'blocked' &&
            goalItem.blockers.length === 1 &&
            Boolean(goalItem.nextProposedStep),
        };
      }),
  },
  {
    scenarioId: 'goal-stale-past-review',
    run: () =>
      withHermeticDb(() => {
        const goal = createGroundedGoalDurably({
          title: 'G',
          objective: 'O',
          reviewBy: T1,
          now: T0,
        })!;
        transitionGroundedGoalDurably({
          goalId: goal.goalId,
          state: 'active',
          reason: 'Confirmed.',
          now: T0,
        });
        const current = loadGroundedGoals({})[0]!;
        const effective = groundedGoalEffectiveState(current, T2);
        return {
          ...none,
          description:
            'A goal past its review deadline reads as stale without a rewrite.',
          goalState: effective,
          expected: 'effective=stale, stored=active',
          actual: `effective=${effective}, stored=${current.state}`,
          correct: effective === 'stale' && current.state === 'active',
        };
      }),
  },
  {
    scenarioId: 'proposed-step-never-executes',
    run: () =>
      withHermeticDb(() => {
        const goal = createGroundedGoalDurably({
          title: 'Send the setlist to the band',
          objective: 'Get the August setlist to Rad Dad.',
          nextProposedStep:
            'Draft a message for Jeff to review — never send anything.',
          now: T0,
        })!;
        const stored = loadGroundedGoals({})[0]!;
        // The record carries no authority: the flag is type- and
        // schema-pinned to false, and this subsystem exposes no execution,
        // scheduling, or messaging surface for the step text to reach.
        return {
          ...none,
          description:
            'A proposed next step is text with no execution authority.',
          goalState: stored.state,
          expected: 'executionAuthority=false, step is inert text',
          actual: `executionAuthority=${String(goal.executionAuthority)}/${String(stored.executionAuthority)}, step=${stored.nextProposedStep ? 'text-only' : 'missing'}`,
          correct:
            goal.executionAuthority === false &&
            stored.executionAuthority === false &&
            Boolean(stored.nextProposedStep),
        };
      }),
  },
  {
    scenarioId: 'bounded-retrieval-budget',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: Array.from({ length: 30 }, (_, index) =>
            candidate({
              kind: 'fact',
              subjectKey: `fact:practice_item_${index}`,
              statement: `Practice-related fact number ${index}.`,
              value: `v${index}`,
              sourceType: 'direct_observation',
            }),
          ),
          now: T0,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['practice'],
          now: T1,
          maxItems: 8,
        });
        const budgetExcluded = bundle.excluded.filter(
          (entry) => entry.reason === 'budget',
        ).length;
        return {
          ...none,
          description: 'Retrieval respects a hard item budget.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'items=8, budgetExcluded=22, truncated=true',
          actual: `items=${bundle.items.length}, budgetExcluded=${budgetExcluded}, truncated=${bundle.budget.truncated}`,
          correct:
            bundle.items.length === 8 &&
            budgetExcluded === 22 &&
            bundle.budget.truncated,
        };
      }),
  },
  {
    scenarioId: 'irrelevant-and-secret-excluded',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:band_practice_day',
              statement: 'Rad Dad practices on Tuesdays.',
              value: 'tuesday',
              sourceType: 'user_statement',
            }),
            candidate({
              kind: 'fact',
              subjectKey: 'fact:garage_code',
              statement: 'The garage door code was rotated.',
              value: 'rotated',
              sourceType: 'direct_observation',
              sensitivity: 'secret',
            }),
            candidate({
              kind: 'fact',
              subjectKey: 'fact:unrelated_topic',
              statement: 'The neighbor got a new dog.',
              value: 'new_dog',
              sourceType: 'user_statement',
            }),
          ],
          now: T0,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['band practice'],
          now: T1,
        });
        const reasons = bundle.excluded.map((entry) => entry.reason).sort();
        return {
          ...none,
          description:
            'Secret-sensitivity and irrelevant records never enter the bundle.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'items=1, reasons include sensitivity and irrelevant',
          actual: `items=${bundle.items.length}, reasons=${reasons.join(',')}`,
          correct:
            bundle.items.length === 1 &&
            reasons.includes('sensitivity') &&
            reasons.includes('irrelevant'),
        };
      }),
  },
  {
    scenarioId: 'revoked-excluded-with-reason',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({ candidates: [candidate()], now: T0 });
        const record = loadGroundedMemoryRecords({})[0]!;
        revokeGroundedMemory(record.recordId, 'The user asked to forget.', T1);
        const bundle = loadGroundedContextBundle({
          topics: ['reply style'],
          now: T1,
        });
        return {
          ...none,
          description: 'Revoked records are excluded with an explicit reason.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'items=0, reason=revoked',
          actual: `items=${bundle.items.length}, reason=${bundle.excluded[0]?.reason}`,
          correct:
            bundle.items.length === 0 &&
            bundle.excluded[0]?.reason === 'revoked',
        };
      }),
  },
  {
    scenarioId: 'retrieval-explains-every-inclusion',
    run: () =>
      withHermeticDb(() => {
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
        const bundle = loadGroundedContextBundle({
          topics: ['reply style', 'practice'],
          now: T1,
        });
        const allExplained =
          bundle.items.every((item) => item.inclusionReason.length > 0) &&
          bundle.retrievalReasoning.length >= 2;
        return {
          ...none,
          description:
            'Every included record carries a reason; retrieval explains itself.',
          retrieved: bundle.items.length,
          excluded: bundle.excluded.length,
          expected: 'allExplained=true',
          actual: `allExplained=${allExplained}`,
          correct: allExplained,
        };
      }),
  },
  {
    scenarioId: 'recent-direct-beats-old-inference-ranking',
    run: () =>
      withHermeticDb(() => {
        rememberGroundedMemory({
          candidates: [
            candidate({
              kind: 'fact',
              subjectKey: 'fact:venue_hint',
              statement: 'Venue guess from month-old inference.',
              value: 'guess',
              sourceType: 'inference',
              confidence: 0.9,
              observedAt: '2026-06-01T00:00:00.000Z',
            }),
            candidate({
              kind: 'fact',
              subjectKey: 'fact:venue_confirmed',
              statement: 'Venue confirmed by direct observation today.',
              value: 'confirmed',
              sourceType: 'direct_observation',
              confidence: 0.9,
              observedAt: T0,
            }),
          ],
          now: T0,
        });
        const bundle = loadGroundedContextBundle({
          topics: ['venue'],
          now: T1,
        });
        return {
          ...none,
          description:
            'Ranking prefers recent direct evidence over old inference.',
          retrieved: bundle.items.length,
          expected: 'top=fact:venue_confirmed',
          actual: `top=${bundle.items[0]?.subjectKey}`,
          correct: bundle.items[0]?.subjectKey === 'fact:venue_confirmed',
        };
      }),
  },
];

export function runGroundedMemoryEval(): GroundedMemoryEvalReport {
  const scenarios: GroundedMemoryEvalScenarioResult[] = [];
  for (const { scenarioId, run } of SCENARIOS) {
    const outcome = run();
    scenarios.push({ scenarioId, ...outcome });
  }
  const regressions = scenarios
    .filter(
      (scenario) =>
        GROUNDED_MEMORY_EVAL_BASELINE[scenario.scenarioId]?.correct &&
        !scenario.correct,
    )
    .map((scenario) => scenario.scenarioId);
  return {
    version: GROUNDED_MEMORY_EVAL_VERSION,
    baselineVersion: GROUNDED_MEMORY_EVAL_BASELINE_VERSION,
    generatedAt: T0,
    scenarios,
    passCount: scenarios.filter((scenario) => scenario.correct).length,
    failCount: scenarios.filter((scenario) => !scenario.correct).length,
    regressions,
  };
}

export function formatGroundedMemoryEvalReport(
  report: GroundedMemoryEvalReport,
): string {
  const lines: string[] = [
    `Grounded memory and goal continuity evaluation v${report.version} (baseline ${report.baselineVersion})`,
    `Result: ${report.passCount}/${report.scenarios.length} scenarios correct.`,
    report.regressions.length
      ? `REGRESSIONS: ${report.regressions.join(', ')}`
      : 'No regressions versus the frozen baseline.',
    '',
  ];
  for (const scenario of report.scenarios) {
    lines.push(
      `[${scenario.correct ? 'PASS' : 'FAIL'}] ${scenario.scenarioId}`,
      `  ${scenario.description}`,
      `  retrieved=${scenario.retrieved} excluded=${scenario.excluded} goal=${scenario.goalState}`,
      scenario.confidenceNote ? `  confidence: ${scenario.confidenceNote}` : '',
      scenario.contradictionNote && scenario.contradictionNote !== 'none'
        ? `  contradiction: ${scenario.contradictionNote}`
        : '',
      `  expected: ${scenario.expected}`,
      `  actual:   ${scenario.actual}`,
    );
  }
  return lines.filter(Boolean).join('\n');
}
