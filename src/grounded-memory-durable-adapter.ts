import { ADAPTIVE_COGNITION_PRIVACY } from './adaptive-cognition-engine.js';
import {
  isDatabaseInitialized,
  listGroundedGoals,
  listGroundedMemoryRecords,
  upsertGroundedGoal,
  upsertGroundedMemoryRecord,
} from './db.js';
import {
  buildGroundedContextBundle,
  completeGroundedCommitment,
  createGroundedGoal,
  explainGroundedMemoryTopic,
  GROUNDED_GOAL_TRANSITIONS,
  groundedGoalEffectiveState,
  normalizeGroundedSubjectKey,
  reconcileGroundedMemory,
  revokeGroundedMemoryRecord,
  transitionGroundedGoal,
  type BuildGroundedContextBundleInput,
  type CreateGroundedGoalInput,
  type GroundedContextBundle,
  type GroundedGoalRecord,
  type GroundedGoalState,
  type GroundedMemoryCandidate,
  type GroundedMemoryChange,
  type GroundedMemoryRecord,
  type GroundedMemoryTopicExplanation,
} from './grounded-memory.js';
import type {
  StoredGroundedGoal,
  StoredGroundedMemoryRecord,
} from './types.js';

/**
 * Durable adapter for Grounded Memory and Goal Continuity.
 *
 * The pure module owns truth maintenance and retrieval ranking; this
 * adapter owns SQLite persistence. Writes are idempotent (stable record
 * ids + upserts), state transitions are guarded at both the adapter and
 * schema layers, and nothing here can execute, schedule, or send anything.
 */

const PRIVACY_JSON = JSON.stringify(ADAPTIVE_COGNITION_PRIVACY);
const DEFAULT_LOAD_LIMIT = 200;

function parseRefs(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toStoredMemory(
  record: GroundedMemoryRecord,
): StoredGroundedMemoryRecord {
  return {
    recordId: record.recordId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: record.kind,
    subjectKey: record.subjectKey,
    statement: record.statement,
    value: record.value,
    confidence: record.confidence,
    sourceType: record.sourceType,
    provenanceRefsJson: JSON.stringify(record.provenanceRefs),
    observedAt: record.observedAt,
    effectiveFrom: record.effectiveFrom,
    effectiveUntil: record.effectiveUntil,
    state: record.state,
    stateReason: record.stateReason,
    supersededByRecordId: record.supersededByRecordId,
    conflictingRecordIdsJson: JSON.stringify(record.conflictingRecordIds),
    sensitivity: record.sensitivity,
    groupFolder: record.groupFolder,
    sourceTurnId: record.sourceTurnId,
    privacyJson: PRIVACY_JSON,
  };
}

function toPureMemory(
  stored: StoredGroundedMemoryRecord,
): GroundedMemoryRecord {
  return {
    recordId: stored.recordId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    kind: stored.kind,
    subjectKey: stored.subjectKey,
    statement: stored.statement,
    value: stored.value,
    confidence: stored.confidence,
    sourceType: stored.sourceType,
    provenanceRefs: parseRefs(stored.provenanceRefsJson),
    observedAt: stored.observedAt,
    effectiveFrom: stored.effectiveFrom,
    effectiveUntil: stored.effectiveUntil,
    state: stored.state,
    stateReason: stored.stateReason,
    supersededByRecordId: stored.supersededByRecordId,
    conflictingRecordIds: parseRefs(stored.conflictingRecordIdsJson),
    sensitivity: stored.sensitivity,
    groupFolder: stored.groupFolder,
    sourceTurnId: stored.sourceTurnId,
  };
}

function toStoredGoal(goal: GroundedGoalRecord): StoredGroundedGoal {
  return {
    goalId: goal.goalId,
    parentGoalId: goal.parentGoalId,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    title: goal.title,
    objective: goal.objective,
    state: goal.state,
    stateReason: goal.stateReason,
    owner: goal.owner,
    sourceType: goal.sourceType,
    evidenceRefsJson: JSON.stringify(goal.evidenceRefs),
    constraintsJson: JSON.stringify(goal.constraints),
    successCriteriaJson: JSON.stringify(goal.successCriteria),
    blockersJson: JSON.stringify(goal.blockers),
    nextProposedStep: goal.nextProposedStep,
    executionAuthority: false,
    lastVerifiedOutcome: goal.lastVerifiedOutcome,
    lastVerifiedAt: goal.lastVerifiedAt,
    reviewBy: goal.reviewBy,
    sensitivity: goal.sensitivity,
    groupFolder: goal.groupFolder,
    sourceTurnId: goal.sourceTurnId,
    privacyJson: PRIVACY_JSON,
  };
}

function toPureGoal(stored: StoredGroundedGoal): GroundedGoalRecord {
  return {
    goalId: stored.goalId,
    parentGoalId: stored.parentGoalId,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    title: stored.title,
    objective: stored.objective,
    state: stored.state,
    stateReason: stored.stateReason,
    owner: stored.owner,
    sourceType: stored.sourceType,
    evidenceRefs: parseRefs(stored.evidenceRefsJson),
    constraints: parseRefs(stored.constraintsJson),
    successCriteria: parseRefs(stored.successCriteriaJson),
    blockers: parseRefs(stored.blockersJson),
    nextProposedStep: stored.nextProposedStep,
    executionAuthority: false,
    lastVerifiedOutcome: stored.lastVerifiedOutcome,
    lastVerifiedAt: stored.lastVerifiedAt,
    reviewBy: stored.reviewBy,
    sensitivity: stored.sensitivity,
    groupFolder: stored.groupFolder,
    sourceTurnId: stored.sourceTurnId,
  };
}

export function loadGroundedMemoryRecords(
  params: {
    subjectKey?: string;
    subjectKeyPrefix?: string;
    groupFolder?: string;
    limit?: number;
  } = {},
): GroundedMemoryRecord[] {
  return listGroundedMemoryRecords({
    ...params,
    limit: params.limit ?? DEFAULT_LOAD_LIMIT,
  }).map((stored) => toPureMemory(stored));
}

export function loadGroundedGoals(
  params: { groupFolder?: string; limit?: number } = {},
): GroundedGoalRecord[] {
  return listGroundedGoals({
    groupFolder: params.groupFolder,
    limit: params.limit ?? DEFAULT_LOAD_LIMIT,
  }).map((stored) => toPureGoal(stored));
}

export interface RememberGroundedMemoryResult {
  persisted: boolean;
  changes: GroundedMemoryChange[];
  records: GroundedMemoryRecord[];
}

/**
 * Runs deterministic truth maintenance against the durable store and
 * persists the outcome. Re-submitting identical candidates is a no-op
 * refresh, never a duplicate row.
 */
export function rememberGroundedMemory(input: {
  candidates: GroundedMemoryCandidate[];
  groupFolder?: string | null;
  now: string;
}): RememberGroundedMemoryResult {
  if (!isDatabaseInitialized() || input.candidates.length === 0) {
    return { persisted: false, changes: [], records: [] };
  }
  const subjectKeys = Array.from(
    new Set(
      input.candidates.map((candidate) =>
        normalizeGroundedSubjectKey(candidate.subjectKey),
      ),
    ),
  );
  const existing = subjectKeys.flatMap((subjectKey) =>
    loadGroundedMemoryRecords({
      subjectKey,
      groupFolder: input.groupFolder ?? undefined,
    }),
  );
  const result = reconcileGroundedMemory({
    existing,
    incoming: input.candidates.map((candidate) => ({
      ...candidate,
      groupFolder: candidate.groupFolder ?? input.groupFolder ?? null,
    })),
    now: input.now,
  });
  for (const record of result.records) {
    upsertGroundedMemoryRecord(toStoredMemory(record));
  }
  return { persisted: true, changes: result.changes, records: result.records };
}

/** Terminal, idempotent revocation with an explanation. */
export function revokeGroundedMemory(
  recordId: string,
  reason: string,
  now: string,
): GroundedMemoryChange[] {
  if (!isDatabaseInitialized()) return [];
  const stored = listGroundedMemoryRecords({ limit: 500 }).find(
    (record) => record.recordId === recordId,
  );
  if (!stored) return [];
  const result = revokeGroundedMemoryRecord(
    [toPureMemory(stored)],
    recordId,
    reason,
    now,
  );
  for (const record of result.records) {
    upsertGroundedMemoryRecord(toStoredMemory(record));
  }
  return result.changes;
}

/** Completes a commitment into an outcome record, preserving history. */
export function completeGroundedCommitmentDurably(input: {
  commitmentRecordId: string;
  outcomeStatement: string;
  provenanceRefs?: string[];
  now: string;
}): GroundedMemoryChange[] {
  if (!isDatabaseInitialized()) return [];
  const stored = listGroundedMemoryRecords({ limit: 500 }).find(
    (record) => record.recordId === input.commitmentRecordId,
  );
  if (!stored) return [];
  const result = completeGroundedCommitment({
    records: [toPureMemory(stored)],
    commitmentRecordId: input.commitmentRecordId,
    outcomeStatement: input.outcomeStatement,
    provenanceRefs: input.provenanceRefs,
    now: input.now,
  });
  for (const record of result.records) {
    upsertGroundedMemoryRecord(toStoredMemory(record));
  }
  return result.changes;
}

export function persistGroundedGoal(goal: GroundedGoalRecord): boolean {
  if (!isDatabaseInitialized()) return false;
  upsertGroundedGoal(toStoredGoal(goal));
  return true;
}

export function createGroundedGoalDurably(
  input: CreateGroundedGoalInput,
): GroundedGoalRecord | null {
  if (!isDatabaseInitialized()) return null;
  const goal = createGroundedGoal(input);
  upsertGroundedGoal(toStoredGoal(goal));
  return goal;
}

/**
 * Guarded transition; terminal states (completed/cancelled) stay put. A
 * disallowed transition is rejected with `null` rather than thrown so a
 * replayed or stale request can never resurrect a terminal goal.
 */
export function transitionGroundedGoalDurably(input: {
  goalId: string;
  state: GroundedGoalState;
  reason: string;
  blockers?: string[];
  nextProposedStep?: string | null;
  verifiedOutcome?: string | null;
  now: string;
}): GroundedGoalRecord | null {
  if (!isDatabaseInitialized()) return null;
  const stored = listGroundedGoals({ limit: 500 }).find(
    (goal) => goal.goalId === input.goalId,
  );
  if (!stored) return null;
  if (!GROUNDED_GOAL_TRANSITIONS[stored.state].includes(input.state)) {
    return null;
  }
  const next = transitionGroundedGoal({
    goal: toPureGoal(stored),
    state: input.state,
    reason: input.reason,
    blockers: input.blockers,
    nextProposedStep: input.nextProposedStep,
    verifiedOutcome: input.verifiedOutcome,
    now: input.now,
  });
  upsertGroundedGoal(toStoredGoal(next));
  return next;
}

/**
 * Loads relevant durable memory and goals and builds the bounded,
 * read-only context bundle for a turn or goal review.
 */
export function loadGroundedContextBundle(
  input: Omit<BuildGroundedContextBundleInput, 'records' | 'goals'> & {
    groupFolder?: string | null;
  },
): GroundedContextBundle {
  const records = isDatabaseInitialized()
    ? loadGroundedMemoryRecords({
        groupFolder: input.groupFolder ?? undefined,
        limit: 500,
      })
    : [];
  const goals = isDatabaseInitialized()
    ? loadGroundedGoals({ groupFolder: input.groupFolder ?? undefined })
    : [];
  return buildGroundedContextBundle({ ...input, records, goals });
}

/** Read-only topic diagnostics over the durable store. */
export function explainGroundedMemoryTopicDurably(input: {
  topic: string;
  groupFolder?: string | null;
  now: string;
}): GroundedMemoryTopicExplanation {
  return explainGroundedMemoryTopic({
    records: isDatabaseInitialized()
      ? loadGroundedMemoryRecords({
          groupFolder: input.groupFolder ?? undefined,
          limit: 500,
        })
      : [],
    goals: isDatabaseInitialized() ? loadGroundedGoals({}) : [],
    topic: input.topic,
    now: input.now,
  });
}

export interface GroundedMemoryDiffEntry {
  recordId: string;
  subjectKey: string;
  state: GroundedMemoryRecord['state'];
  stateReason: string;
  updatedAt: string;
}

/** What changed since a prior time — read-only, bounded. */
export function diffGroundedMemorySince(
  sinceIso: string,
  params: { groupFolder?: string | null; limit?: number } = {},
): {
  memory: GroundedMemoryDiffEntry[];
  goals: Array<{
    goalId: string;
    title: string;
    state: GroundedGoalState;
    stateReason: string;
    updatedAt: string;
  }>;
} {
  const sinceMs = Date.parse(sinceIso);
  const limit = Math.max(1, Math.min(100, params.limit ?? 50));
  const memory = loadGroundedMemoryRecords({
    groupFolder: params.groupFolder ?? undefined,
    limit: 500,
  })
    .filter((record) => Date.parse(record.updatedAt) > sinceMs)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map((record) => ({
      recordId: record.recordId,
      subjectKey: record.subjectKey,
      state: record.state,
      stateReason: record.stateReason,
      updatedAt: record.updatedAt,
    }));
  const goals = loadGroundedGoals({
    groupFolder: params.groupFolder ?? undefined,
  })
    .filter((goal) => Date.parse(goal.updatedAt) > sinceMs)
    .slice(0, limit)
    .map((goal) => ({
      goalId: goal.goalId,
      title: goal.title,
      state: goal.state,
      stateReason: goal.stateReason,
      updatedAt: goal.updatedAt,
    }));
  return { memory, goals };
}

export interface GroundedMemoryDurableDiagnostics {
  memoryCounts: Record<GroundedMemoryRecord['state'], number>;
  goalCounts: Record<GroundedGoalState, number>;
  contradictedSubjects: string[];
  staleGoals: string[];
}

export function groundedMemoryDurableDiagnostics(
  now: string,
): GroundedMemoryDurableDiagnostics {
  const memoryCounts: GroundedMemoryDurableDiagnostics['memoryCounts'] = {
    active: 0,
    uncertain: 0,
    superseded: 0,
    revoked: 0,
  };
  const contradictedSubjects = new Set<string>();
  for (const record of loadGroundedMemoryRecords({ limit: 500 })) {
    memoryCounts[record.state] += 1;
    if (record.conflictingRecordIds.length > 0) {
      contradictedSubjects.add(record.subjectKey);
    }
  }
  const goalCounts: GroundedMemoryDurableDiagnostics['goalCounts'] = {
    proposed: 0,
    active: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
    stale: 0,
  };
  const staleGoals: string[] = [];
  for (const goal of loadGroundedGoals({})) {
    goalCounts[goal.state] += 1;
    if (
      goal.state !== 'stale' &&
      groundedGoalEffectiveState(goal, now) === 'stale'
    ) {
      staleGoals.push(goal.goalId);
    }
  }
  return {
    memoryCounts,
    goalCounts,
    contradictedSubjects: Array.from(contradictedSubjects).sort(),
    staleGoals,
  };
}
