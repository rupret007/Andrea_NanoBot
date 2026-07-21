import { createHash } from 'node:crypto';

import type { RealitySensitivity } from './types.js';

/**
 * Grounded Memory and Goal Continuity v1 — pure, deterministic core.
 *
 * Durable, evidence-backed memory records and informational goals with
 * explicit truth maintenance: contradictions stay visible, changed
 * preferences supersede (never overwrite) history, direct evidence beats
 * old inference, and low-confidence inference stays uncertain.
 *
 * This module owns no persistence, transports, tools, or approvals.
 * Memory and goals are planning/context truth only: nothing here can send
 * messages, schedule work, execute tools, or alter safety policy.
 */

export const GROUNDED_MEMORY_VERSION = '1.0.0';

export type GroundedMemoryKind =
  | 'fact'
  | 'preference'
  | 'commitment'
  | 'outcome'
  | 'constraint'
  | 'open_question';

export type GroundedMemorySourceType =
  | 'direct_observation'
  | 'user_statement'
  | 'inference'
  | 'assumption';

export type GroundedMemoryState =
  | 'active'
  | 'uncertain'
  | 'superseded'
  | 'revoked';

/** Effective state adds derived expiry on top of the stored state. */
export type GroundedMemoryEffectiveState = GroundedMemoryState | 'expired';

export interface GroundedMemoryRecord {
  recordId: string;
  createdAt: string;
  updatedAt: string;
  kind: GroundedMemoryKind;
  /** Normalized topic key, e.g. `preference:reply_style` or `fact:home_wifi`. */
  subjectKey: string;
  /** Bounded human-readable statement. Never a raw message body. */
  statement: string;
  /** Normalized comparison value for contradiction detection. */
  value: string;
  confidence: number;
  sourceType: GroundedMemorySourceType;
  provenanceRefs: string[];
  observedAt: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  state: GroundedMemoryState;
  /** Why the record is in its current state — explainability, not audit theater. */
  stateReason: string;
  supersededByRecordId: string | null;
  conflictingRecordIds: string[];
  sensitivity: RealitySensitivity;
  groupFolder: string | null;
  sourceTurnId: string | null;
}

export interface GroundedMemoryCandidate {
  recordId?: string;
  kind: GroundedMemoryKind;
  subjectKey: string;
  statement: string;
  value: string;
  confidence: number;
  sourceType: GroundedMemorySourceType;
  provenanceRefs?: string[];
  observedAt: string;
  effectiveFrom?: string | null;
  effectiveUntil?: string | null;
  sensitivity?: RealitySensitivity;
  groupFolder?: string | null;
  sourceTurnId?: string | null;
}

export type GroundedMemoryChangeKind =
  | 'created'
  | 'refreshed'
  | 'superseded'
  | 'contradiction_flagged'
  | 'kept_uncertain'
  | 'revoked'
  | 'completed';

export interface GroundedMemoryChange {
  changeId: string;
  createdAt: string;
  kind: GroundedMemoryChangeKind;
  recordId: string;
  relatedRecordId: string | null;
  subjectKey: string;
  explanation: string;
}

export type GroundedGoalState =
  | 'proposed'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'stale';

export interface GroundedGoalRecord {
  goalId: string;
  parentGoalId: string | null;
  createdAt: string;
  updatedAt: string;
  title: string;
  objective: string;
  state: GroundedGoalState;
  stateReason: string;
  owner: 'user' | 'andrea_proposed';
  sourceType: GroundedMemorySourceType;
  evidenceRefs: string[];
  constraints: string[];
  successCriteria: string[];
  blockers: string[];
  /**
   * Informational only. This is text a human or planner may read; nothing
   * in this subsystem executes it, schedules it, or turns it into a tool
   * call. The durable schema pins execution_authority to 0.
   */
  nextProposedStep: string | null;
  executionAuthority: false;
  lastVerifiedOutcome: string | null;
  lastVerifiedAt: string | null;
  reviewBy: string | null;
  sensitivity: RealitySensitivity;
  groupFolder: string | null;
  sourceTurnId: string | null;
}

const BOUNDED_TEXT_LIMIT = 420;
/** Inference/assumption below this enters and stays `uncertain`. */
export const UNCERTAIN_INFERENCE_CONFIDENCE = 0.6;
/** Conflicting records lose this fraction of confidence, floored at 0.05. */
const CONTRADICTION_CONFIDENCE_PENALTY = 0.25;

const SOURCE_STRENGTH: Record<GroundedMemorySourceType, number> = {
  direct_observation: 3,
  user_statement: 3,
  inference: 1,
  assumption: 0,
};

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function bounded(
  value: string | null | undefined,
  limit = BOUNDED_TEXT_LIMIT,
): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function dedupe(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => bounded(value, 240)).filter(Boolean)),
  );
}

export function normalizeGroundedSubjectKey(value: string): string {
  return bounded(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function groundedMemoryRecordFromCandidate(
  candidate: GroundedMemoryCandidate,
  now: string,
): GroundedMemoryRecord {
  const subjectKey = normalizeGroundedSubjectKey(candidate.subjectKey);
  const value = bounded(candidate.value, 240);
  const lowConfidenceInference =
    ['inference', 'assumption'].includes(candidate.sourceType) &&
    clamp01(candidate.confidence) < UNCERTAIN_INFERENCE_CONFIDENCE;
  return {
    recordId:
      candidate.recordId ||
      hashId(
        'gmem',
        `${candidate.kind}|${subjectKey}|${value}|${candidate.sourceType}|${candidate.observedAt}`,
      ),
    createdAt: now,
    updatedAt: now,
    kind: candidate.kind,
    subjectKey,
    statement: bounded(candidate.statement),
    value,
    confidence: clamp01(candidate.confidence),
    sourceType: candidate.sourceType,
    provenanceRefs: dedupe(candidate.provenanceRefs || []),
    observedAt: candidate.observedAt,
    effectiveFrom: candidate.effectiveFrom ?? null,
    effectiveUntil: candidate.effectiveUntil ?? null,
    state: lowConfidenceInference ? 'uncertain' : 'active',
    stateReason: lowConfidenceInference
      ? `Entered uncertain: ${candidate.sourceType} below the ${UNCERTAIN_INFERENCE_CONFIDENCE} confidence bar is never treated as fact.`
      : 'Entered active from admissible source.',
    supersededByRecordId: null,
    conflictingRecordIds: [],
    sensitivity: candidate.sensitivity ?? 'personal',
    groupFolder: candidate.groupFolder ?? null,
    sourceTurnId: candidate.sourceTurnId ?? null,
  };
}

/** Derived state: stored state plus time-based expiry. */
export function groundedMemoryEffectiveState(
  record: GroundedMemoryRecord,
  now: string,
): GroundedMemoryEffectiveState {
  if (record.state !== 'active' && record.state !== 'uncertain') {
    return record.state;
  }
  if (
    record.effectiveUntil &&
    Date.parse(record.effectiveUntil) <= Date.parse(now)
  ) {
    return 'expired';
  }
  return record.state;
}

export interface ReconcileGroundedMemoryResult {
  records: GroundedMemoryRecord[];
  changes: GroundedMemoryChange[];
}

function change(
  input: Omit<GroundedMemoryChange, 'changeId'>,
): GroundedMemoryChange {
  return {
    ...input,
    explanation: bounded(input.explanation),
    changeId: hashId(
      'gmem:change',
      `${input.createdAt}|${input.kind}|${input.recordId}|${input.relatedRecordId ?? ''}|${input.explanation}`,
    ),
  };
}

function linkConflict(
  left: GroundedMemoryRecord,
  right: GroundedMemoryRecord,
  now: string,
): void {
  left.conflictingRecordIds = dedupe([
    ...left.conflictingRecordIds,
    right.recordId,
  ]);
  right.conflictingRecordIds = dedupe([
    ...right.conflictingRecordIds,
    left.recordId,
  ]);
  left.confidence = Math.max(
    0.05,
    left.confidence - CONTRADICTION_CONFIDENCE_PENALTY,
  );
  right.confidence = Math.max(
    0.05,
    right.confidence - CONTRADICTION_CONFIDENCE_PENALTY,
  );
  left.updatedAt = now;
  right.updatedAt = now;
}

/**
 * Deterministic truth maintenance. Never last-write-wins, never silent
 * overwrite: every outcome is a typed change with an explanation, prior
 * records survive as `superseded`/`uncertain` with links to what replaced
 * or contradicts them.
 *
 * Rules, in order, per incoming candidate:
 * 1. Same subject and value → refresh the existing record (idempotent).
 * 2. Changed preference stated by the user → supersede the old preference.
 * 3. Direct evidence (observation/user statement) vs an older
 *    inference/assumption → the direct record supersedes it.
 * 4. Inference vs an existing direct record → the inference enters
 *    `uncertain` with a conflict link; the direct record stays active.
 * 5. Equal-strength disagreement → both flagged `uncertain` with conflict
 *    links and lowered confidence: the contradiction stays visible.
 */
export function reconcileGroundedMemory(input: {
  existing: GroundedMemoryRecord[];
  incoming: GroundedMemoryCandidate[];
  now: string;
}): ReconcileGroundedMemoryResult {
  const records = input.existing.map((record) => ({
    ...record,
    provenanceRefs: [...record.provenanceRefs],
    conflictingRecordIds: [...record.conflictingRecordIds],
  }));
  const changes: GroundedMemoryChange[] = [];
  for (const candidate of input.incoming) {
    const incoming = groundedMemoryRecordFromCandidate(candidate, input.now);
    const existingSameId = records.find(
      (record) => record.recordId === incoming.recordId,
    );
    const openMatches = records.filter(
      (record) =>
        record.subjectKey === incoming.subjectKey &&
        record.kind === incoming.kind &&
        ['active', 'uncertain'].includes(record.state),
    );
    const sameValue =
      existingSameId ??
      openMatches.find((record) => record.value === incoming.value);
    if (sameValue) {
      // Rule 1: idempotent refresh.
      sameValue.updatedAt = input.now;
      sameValue.observedAt =
        Date.parse(incoming.observedAt) > Date.parse(sameValue.observedAt)
          ? incoming.observedAt
          : sameValue.observedAt;
      sameValue.confidence = clamp01(
        Math.max(sameValue.confidence, incoming.confidence),
      );
      sameValue.provenanceRefs = dedupe([
        ...sameValue.provenanceRefs,
        ...incoming.provenanceRefs,
      ]);
      changes.push(
        change({
          createdAt: input.now,
          kind: 'refreshed',
          recordId: sameValue.recordId,
          relatedRecordId: null,
          subjectKey: sameValue.subjectKey,
          explanation: `Re-observed the same ${sameValue.kind} value; refreshed freshness and provenance without creating a duplicate.`,
        }),
      );
      continue;
    }
    const conflicting = openMatches.filter(
      (record) => record.value !== incoming.value,
    );
    if (conflicting.length === 0) {
      records.push(incoming);
      changes.push(
        change({
          createdAt: input.now,
          kind: incoming.state === 'uncertain' ? 'kept_uncertain' : 'created',
          recordId: incoming.recordId,
          relatedRecordId: null,
          subjectKey: incoming.subjectKey,
          explanation:
            incoming.state === 'uncertain'
              ? incoming.stateReason
              : `Recorded a new ${incoming.kind} from ${incoming.sourceType}.`,
        }),
      );
      continue;
    }
    const incomingStrength = SOURCE_STRENGTH[incoming.sourceType];
    for (const prior of conflicting) {
      const priorStrength = SOURCE_STRENGTH[prior.sourceType];
      const isChangedPreference =
        incoming.kind === 'preference' &&
        incoming.sourceType === 'user_statement';
      const incomingIsNewer =
        Date.parse(incoming.observedAt) >= Date.parse(prior.observedAt);
      if (
        isChangedPreference ||
        (incomingStrength > priorStrength && incomingIsNewer)
      ) {
        // Rules 2 and 3: supersede, preserving the prior record.
        prior.state = 'superseded';
        prior.supersededByRecordId = incoming.recordId;
        prior.stateReason = isChangedPreference
          ? `Superseded: the user stated a changed preference ("${incoming.value}") on ${incoming.observedAt}; the earlier preference ("${prior.value}") is preserved as history.`
          : `Superseded: newer ${incoming.sourceType} ("${incoming.value}") outweighs older ${prior.sourceType} ("${prior.value}").`;
        prior.updatedAt = input.now;
        changes.push(
          change({
            createdAt: input.now,
            kind: 'superseded',
            recordId: prior.recordId,
            relatedRecordId: incoming.recordId,
            subjectKey: prior.subjectKey,
            explanation: prior.stateReason,
          }),
        );
      } else if (incomingStrength < priorStrength) {
        // Rule 4: inference never displaces direct evidence.
        incoming.state = 'uncertain';
        incoming.stateReason = `Kept uncertain: this ${incoming.sourceType} ("${incoming.value}") conflicts with ${prior.sourceType} ("${prior.value}"), and inference never displaces direct evidence.`;
        linkConflict(prior, incoming, input.now);
        changes.push(
          change({
            createdAt: input.now,
            kind: 'kept_uncertain',
            recordId: incoming.recordId,
            relatedRecordId: prior.recordId,
            subjectKey: incoming.subjectKey,
            explanation: incoming.stateReason,
          }),
        );
      } else {
        // Rule 5: equal-strength contradiction — both visible, both uncertain.
        prior.state = 'uncertain';
        prior.stateReason = `Uncertain: contradicted by equal-strength ${incoming.sourceType} ("${incoming.value}"); both readings are preserved until fresh evidence resolves them.`;
        incoming.state = 'uncertain';
        incoming.stateReason = `Uncertain: contradicts equal-strength ${prior.sourceType} ("${prior.value}"); both readings are preserved until fresh evidence resolves them.`;
        linkConflict(prior, incoming, input.now);
        changes.push(
          change({
            createdAt: input.now,
            kind: 'contradiction_flagged',
            recordId: incoming.recordId,
            relatedRecordId: prior.recordId,
            subjectKey: incoming.subjectKey,
            explanation: incoming.stateReason,
          }),
        );
      }
    }
    records.push(incoming);
  }
  return { records, changes };
}

/** Explicit revocation. Terminal and idempotent; history is preserved. */
export function revokeGroundedMemoryRecord(
  records: GroundedMemoryRecord[],
  recordId: string,
  reason: string,
  now: string,
): ReconcileGroundedMemoryResult {
  const next = records.map((record) => ({ ...record }));
  const target = next.find((record) => record.recordId === recordId);
  if (!target || target.state === 'revoked') {
    return { records: next, changes: [] };
  }
  target.state = 'revoked';
  target.stateReason = bounded(`Revoked: ${reason}`);
  target.updatedAt = now;
  return {
    records: next,
    changes: [
      change({
        createdAt: now,
        kind: 'revoked',
        recordId,
        relatedRecordId: null,
        subjectKey: target.subjectKey,
        explanation: target.stateReason,
      }),
    ],
  };
}

/**
 * Completing a commitment produces an `outcome` record and supersedes the
 * commitment with an explanation, instead of deleting or editing it.
 */
export function completeGroundedCommitment(input: {
  records: GroundedMemoryRecord[];
  commitmentRecordId: string;
  outcomeStatement: string;
  provenanceRefs?: string[];
  now: string;
}): ReconcileGroundedMemoryResult {
  const records = input.records.map((record) => ({ ...record }));
  const commitment = records.find(
    (record) =>
      record.recordId === input.commitmentRecordId &&
      record.kind === 'commitment',
  );
  if (!commitment || commitment.state === 'superseded') {
    return { records, changes: [] };
  }
  const outcome = groundedMemoryRecordFromCandidate(
    {
      kind: 'outcome',
      subjectKey: commitment.subjectKey,
      statement: input.outcomeStatement,
      value: `completed:${commitment.value}`,
      confidence: Math.max(commitment.confidence, 0.8),
      sourceType: 'direct_observation',
      provenanceRefs: [commitment.recordId, ...(input.provenanceRefs || [])],
      observedAt: input.now,
      groupFolder: commitment.groupFolder,
      sensitivity: commitment.sensitivity,
    },
    input.now,
  );
  commitment.state = 'superseded';
  commitment.supersededByRecordId = outcome.recordId;
  commitment.stateReason = `Completed: ${bounded(input.outcomeStatement, 200)}`;
  commitment.updatedAt = input.now;
  records.push(outcome);
  return {
    records,
    changes: [
      change({
        createdAt: input.now,
        kind: 'completed',
        recordId: commitment.recordId,
        relatedRecordId: outcome.recordId,
        subjectKey: commitment.subjectKey,
        explanation: commitment.stateReason,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Goals — informational continuity only, never execution authority.
// ---------------------------------------------------------------------------

export interface CreateGroundedGoalInput {
  goalId?: string;
  parentGoalId?: string | null;
  title: string;
  objective: string;
  owner?: GroundedGoalRecord['owner'];
  sourceType?: GroundedMemorySourceType;
  evidenceRefs?: string[];
  constraints?: string[];
  successCriteria?: string[];
  blockers?: string[];
  nextProposedStep?: string | null;
  reviewBy?: string | null;
  sensitivity?: RealitySensitivity;
  groupFolder?: string | null;
  sourceTurnId?: string | null;
  now: string;
}

export function createGroundedGoal(
  input: CreateGroundedGoalInput,
): GroundedGoalRecord {
  return {
    goalId:
      input.goalId ||
      hashId('ggoal', `${bounded(input.title, 200)}|${input.now}`),
    parentGoalId: input.parentGoalId ?? null,
    createdAt: input.now,
    updatedAt: input.now,
    title: bounded(input.title, 200),
    objective: bounded(input.objective),
    state: 'proposed',
    stateReason: 'Proposed; not yet confirmed as active.',
    owner: input.owner ?? 'user',
    sourceType: input.sourceType ?? 'user_statement',
    evidenceRefs: dedupe(input.evidenceRefs || []),
    constraints: (input.constraints || []).map((item) => bounded(item, 240)),
    successCriteria: (input.successCriteria || []).map((item) =>
      bounded(item, 240),
    ),
    blockers: (input.blockers || []).map((item) => bounded(item, 240)),
    nextProposedStep: input.nextProposedStep
      ? bounded(input.nextProposedStep)
      : null,
    executionAuthority: false,
    lastVerifiedOutcome: null,
    lastVerifiedAt: null,
    reviewBy: input.reviewBy ?? null,
    sensitivity: input.sensitivity ?? 'personal',
    groupFolder: input.groupFolder ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
  };
}

/** Terminal states can only repeat themselves — cancelled stays cancelled. */
export const GROUNDED_GOAL_TRANSITIONS: Record<
  GroundedGoalState,
  GroundedGoalState[]
> = {
  proposed: ['proposed', 'active', 'cancelled'],
  active: ['active', 'blocked', 'completed', 'cancelled', 'stale'],
  blocked: ['blocked', 'active', 'cancelled', 'stale'],
  stale: ['stale', 'active', 'cancelled'],
  completed: ['completed'],
  cancelled: ['cancelled'],
};

export function transitionGroundedGoal(input: {
  goal: GroundedGoalRecord;
  state: GroundedGoalState;
  reason: string;
  blockers?: string[];
  nextProposedStep?: string | null;
  verifiedOutcome?: string | null;
  now: string;
}): GroundedGoalRecord {
  if (!GROUNDED_GOAL_TRANSITIONS[input.goal.state].includes(input.state)) {
    throw new Error(
      `Grounded goal transition ${input.goal.state} -> ${input.state} is not allowed.`,
    );
  }
  return {
    ...input.goal,
    state: input.state,
    stateReason: bounded(input.reason),
    blockers:
      input.blockers !== undefined
        ? input.blockers.map((item) => bounded(item, 240))
        : input.goal.blockers,
    nextProposedStep:
      input.nextProposedStep !== undefined
        ? input.nextProposedStep
          ? bounded(input.nextProposedStep)
          : null
        : input.goal.nextProposedStep,
    lastVerifiedOutcome: input.verifiedOutcome
      ? bounded(input.verifiedOutcome)
      : input.goal.lastVerifiedOutcome,
    lastVerifiedAt: input.verifiedOutcome
      ? input.now
      : input.goal.lastVerifiedAt,
    executionAuthority: false,
    updatedAt: input.now,
  };
}

/** A goal past its review deadline reads as stale without a state rewrite. */
export function groundedGoalEffectiveState(
  goal: GroundedGoalRecord,
  now: string,
): GroundedGoalState {
  if (
    ['active', 'blocked'].includes(goal.state) &&
    goal.reviewBy &&
    Date.parse(goal.reviewBy) <= Date.parse(now)
  ) {
    return 'stale';
  }
  return goal.state;
}

// ---------------------------------------------------------------------------
// Grounded context bundle — bounded, explainable, read-only retrieval.
// ---------------------------------------------------------------------------

export type GroundedExclusionReason =
  | 'revoked'
  | 'superseded'
  | 'expired'
  | 'low_confidence'
  | 'uncertain_by_default'
  | 'sensitivity'
  | 'irrelevant'
  | 'budget';

export interface GroundedContextItem {
  recordId: string;
  kind: GroundedMemoryKind;
  subjectKey: string;
  statement: string;
  value: string;
  confidence: number;
  sourceType: GroundedMemorySourceType;
  observedAt: string;
  relevance: number;
  inclusionReason: string;
  provenanceRefs: string[];
}

export interface GroundedContextGoalItem {
  goalId: string;
  title: string;
  state: GroundedGoalState;
  blockers: string[];
  nextProposedStep: string | null;
  inclusionReason: string;
}

export interface GroundedContextBundle {
  bundleId: string;
  generatedAt: string;
  topics: string[];
  items: GroundedContextItem[];
  goals: GroundedContextGoalItem[];
  contradictions: Array<{
    subjectKey: string;
    recordIds: string[];
    note: string;
  }>;
  uncertainties: string[];
  excluded: Array<{ recordId: string; reason: GroundedExclusionReason }>;
  budget: {
    maxItems: number;
    maxChars: number;
    usedChars: number;
    truncated: boolean;
  };
  retrievalReasoning: string[];
}

export interface BuildGroundedContextBundleInput {
  records: GroundedMemoryRecord[];
  goals?: GroundedGoalRecord[];
  /** Free-form topic hints; matched against subject keys and statements. */
  topics: string[];
  now: string;
  maxItems?: number;
  maxChars?: number;
  minimumConfidence?: number;
  /** Sensitivities allowed into the bundle. `secret` is never included. */
  includeSensitivities?: RealitySensitivity[];
  /** Include `uncertain` records (flagged) instead of excluding them. */
  includeUncertain?: boolean;
}

function topicTokens(topics: string[]): string[] {
  return dedupe(
    topics.flatMap((topic) =>
      normalizeGroundedSubjectKey(topic)
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 3),
    ),
  );
}

function relevanceFor(
  record: GroundedMemoryRecord,
  tokens: string[],
  now: string,
): number {
  const haystack = `${record.subjectKey} ${record.statement} ${record.value}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const matches = tokens.filter((token) => haystack.includes(token)).length;
  if (tokens.length > 0 && matches === 0) return 0;
  const topicScore = tokens.length > 0 ? matches / tokens.length : 0.5;
  const ageMs = Math.max(0, Date.parse(now) - Date.parse(record.observedAt));
  const recency = 1 / (1 + ageMs / (7 * 24 * 60 * 60 * 1000));
  const sourceWeight = 0.7 + SOURCE_STRENGTH[record.sourceType] * 0.1;
  return clamp01(
    (0.5 * topicScore + 0.3 * recency + 0.2 * record.confidence) * sourceWeight,
  );
}

/**
 * Builds the bounded, read-only context bundle for a turn or goal review.
 * Recent direct evidence outranks old inference; revoked, superseded,
 * expired, low-confidence, and secret records are excluded by default with
 * an explicit reason; contradictions and uncertainty stay visible.
 */
export function buildGroundedContextBundle(
  input: BuildGroundedContextBundleInput,
): GroundedContextBundle {
  const maxItems = Math.max(1, Math.min(50, input.maxItems ?? 12));
  const maxChars = Math.max(400, Math.min(20_000, input.maxChars ?? 4_000));
  const minimumConfidence = clamp01(input.minimumConfidence ?? 0.4);
  const includeSensitivities: RealitySensitivity[] = (
    input.includeSensitivities ?? ['low', 'personal', 'sensitive']
  ).filter((sensitivity) => sensitivity !== 'secret');
  const tokens = topicTokens(input.topics);
  const excluded: GroundedContextBundle['excluded'] = [];
  const reasoning: string[] = [
    `Topics normalized to ${tokens.length} token(s): ${tokens.join(', ') || '(none — recency/confidence ranking only)'}.`,
    `Budget: ${maxItems} item(s), ${maxChars} chars; minimum confidence ${minimumConfidence}; sensitivities ${includeSensitivities.join('/')}; secret always excluded.`,
  ];
  const candidates: Array<{
    record: GroundedMemoryRecord;
    relevance: number;
  }> = [];
  for (const record of input.records) {
    const effectiveState = groundedMemoryEffectiveState(record, input.now);
    if (effectiveState === 'revoked') {
      excluded.push({ recordId: record.recordId, reason: 'revoked' });
      continue;
    }
    if (effectiveState === 'superseded') {
      excluded.push({ recordId: record.recordId, reason: 'superseded' });
      continue;
    }
    if (effectiveState === 'expired') {
      excluded.push({ recordId: record.recordId, reason: 'expired' });
      continue;
    }
    if (!includeSensitivities.includes(record.sensitivity)) {
      excluded.push({ recordId: record.recordId, reason: 'sensitivity' });
      continue;
    }
    if (effectiveState === 'uncertain' && !input.includeUncertain) {
      excluded.push({
        recordId: record.recordId,
        reason: 'uncertain_by_default',
      });
      continue;
    }
    if (record.confidence < minimumConfidence) {
      excluded.push({ recordId: record.recordId, reason: 'low_confidence' });
      continue;
    }
    const relevance = relevanceFor(record, tokens, input.now);
    if (relevance <= 0) {
      excluded.push({ recordId: record.recordId, reason: 'irrelevant' });
      continue;
    }
    candidates.push({ record, relevance });
  }
  candidates.sort(
    (left, right) =>
      right.relevance - left.relevance ||
      Date.parse(right.record.observedAt) -
        Date.parse(left.record.observedAt) ||
      left.record.recordId.localeCompare(right.record.recordId),
  );
  const items: GroundedContextItem[] = [];
  let usedChars = 0;
  let truncated = false;
  for (const { record, relevance } of candidates) {
    const cost = record.statement.length + record.subjectKey.length + 24;
    if (items.length >= maxItems || usedChars + cost > maxChars) {
      excluded.push({ recordId: record.recordId, reason: 'budget' });
      truncated = true;
      continue;
    }
    usedChars += cost;
    items.push({
      recordId: record.recordId,
      kind: record.kind,
      subjectKey: record.subjectKey,
      statement: record.statement,
      value: record.value,
      confidence: record.confidence,
      sourceType: record.sourceType,
      observedAt: record.observedAt,
      relevance,
      inclusionReason: bounded(
        `Included: ${record.state === 'uncertain' ? 'uncertain (flagged) ' : ''}${record.sourceType} at confidence ${record.confidence.toFixed(2)}, relevance ${relevance.toFixed(2)} to [${tokens.join(', ') || 'recency'}].`,
      ),
      provenanceRefs: record.provenanceRefs,
    });
  }
  const includedIds = new Set(items.map((item) => item.recordId));
  const contradictionMap = new Map<string, Set<string>>();
  for (const record of input.records) {
    if (record.conflictingRecordIds.length === 0) continue;
    if (
      !includedIds.has(record.recordId) &&
      !record.conflictingRecordIds.some((id) => includedIds.has(id))
    ) {
      continue;
    }
    const set = contradictionMap.get(record.subjectKey) ?? new Set<string>();
    set.add(record.recordId);
    for (const id of record.conflictingRecordIds) set.add(id);
    contradictionMap.set(record.subjectKey, set);
  }
  const contradictions = Array.from(contradictionMap.entries()).map(
    ([subjectKey, ids]) => ({
      subjectKey,
      recordIds: Array.from(ids).sort(),
      note: `Conflicting records exist for ${subjectKey}; do not treat either value as settled.`,
    }),
  );
  const uncertainties = dedupe([
    ...items
      .filter((item) => item.confidence < 0.6)
      .map(
        (item) =>
          `${item.subjectKey} is low-confidence (${item.confidence.toFixed(2)}).`,
      ),
    ...contradictions.map((entry) => entry.note),
  ]);
  const goalItems: GroundedContextGoalItem[] = (input.goals || [])
    .filter((goal) =>
      ['active', 'blocked', 'proposed'].includes(
        groundedGoalEffectiveState(goal, input.now),
      ),
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        left.goalId.localeCompare(right.goalId),
    )
    .slice(0, Math.max(1, Math.min(10, maxItems)))
    .map((goal) => ({
      goalId: goal.goalId,
      title: goal.title,
      state: groundedGoalEffectiveState(goal, input.now),
      blockers: goal.blockers,
      nextProposedStep: goal.nextProposedStep,
      inclusionReason: `Included: ${groundedGoalEffectiveState(goal, input.now)} goal, informational only (no execution authority).`,
    }));
  reasoning.push(
    `Included ${items.length} record(s) and ${goalItems.length} goal(s); excluded ${excluded.length} (${summarizeExclusions(excluded)}).`,
  );
  return {
    bundleId: hashId(
      'gbundle',
      `${input.now}|${tokens.join(',')}|${items.map((item) => item.recordId).join(',')}`,
    ),
    generatedAt: input.now,
    topics: tokens,
    items,
    goals: goalItems,
    contradictions,
    uncertainties,
    excluded,
    budget: { maxItems, maxChars, usedChars, truncated },
    retrievalReasoning: reasoning,
  };
}

function summarizeExclusions(
  excluded: GroundedContextBundle['excluded'],
): string {
  const counts = new Map<string, number>();
  for (const entry of excluded) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return (
    Array.from(counts.entries())
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ') || 'none'
  );
}

// ---------------------------------------------------------------------------
// Diagnostics — read-only explanations.
// ---------------------------------------------------------------------------

export interface GroundedMemoryTopicExplanation {
  subjectKey: string;
  active: Array<{
    recordId: string;
    kind: GroundedMemoryKind;
    statement: string;
    value: string;
    confidence: number;
    sourceType: GroundedMemorySourceType;
    effectiveState: GroundedMemoryEffectiveState;
    stateReason: string;
    provenanceRefs: string[];
  }>;
  history: Array<{
    recordId: string;
    state: GroundedMemoryState;
    value: string;
    stateReason: string;
    supersededByRecordId: string | null;
  }>;
  contradictions: string[][];
  goals: Array<{
    goalId: string;
    title: string;
    state: GroundedGoalState;
    blockers: string[];
    nextProposedStep: string | null;
    stateReason: string;
  }>;
}

export function explainGroundedMemoryTopic(input: {
  records: GroundedMemoryRecord[];
  goals?: GroundedGoalRecord[];
  topic: string;
  now: string;
}): GroundedMemoryTopicExplanation {
  const key = normalizeGroundedSubjectKey(input.topic);
  const matches = input.records.filter(
    (record) => record.subjectKey === key || record.subjectKey.includes(key),
  );
  const contradictionGroups = new Map<string, Set<string>>();
  for (const record of matches) {
    if (record.conflictingRecordIds.length === 0) continue;
    const set = contradictionGroups.get(record.subjectKey) ?? new Set<string>();
    set.add(record.recordId);
    for (const id of record.conflictingRecordIds) set.add(id);
    contradictionGroups.set(record.subjectKey, set);
  }
  return {
    subjectKey: key,
    active: matches
      .filter((record) =>
        ['active', 'uncertain'].includes(
          groundedMemoryEffectiveState(record, input.now),
        ),
      )
      .map((record) => ({
        recordId: record.recordId,
        kind: record.kind,
        statement: record.statement,
        value: record.value,
        confidence: record.confidence,
        sourceType: record.sourceType,
        effectiveState: groundedMemoryEffectiveState(record, input.now),
        stateReason: record.stateReason,
        provenanceRefs: record.provenanceRefs,
      })),
    history: matches
      .filter((record) => ['superseded', 'revoked'].includes(record.state))
      .map((record) => ({
        recordId: record.recordId,
        state: record.state,
        value: record.value,
        stateReason: record.stateReason,
        supersededByRecordId: record.supersededByRecordId,
      })),
    contradictions: Array.from(contradictionGroups.values()).map((set) =>
      Array.from(set).sort(),
    ),
    goals: (input.goals || [])
      .filter(
        (goal) =>
          normalizeGroundedSubjectKey(goal.title).includes(key) ||
          normalizeGroundedSubjectKey(goal.objective).includes(key),
      )
      .map((goal) => ({
        goalId: goal.goalId,
        title: goal.title,
        state: groundedGoalEffectiveState(goal, input.now),
        blockers: goal.blockers,
        nextProposedStep: goal.nextProposedStep,
        stateReason: goal.stateReason,
      })),
  };
}

export function formatGroundedContextBundle(
  bundle: GroundedContextBundle,
): string {
  const lines: string[] = [
    `Grounded context bundle ${bundle.bundleId} (${bundle.generatedAt})`,
    ...bundle.retrievalReasoning.map((line) => `  ${line}`),
    `Items (${bundle.items.length}):`,
    ...bundle.items.map(
      (item) =>
        `  [${item.kind}/${item.sourceType} c=${item.confidence.toFixed(2)} r=${item.relevance.toFixed(2)}] ${item.subjectKey}: ${item.statement}`,
    ),
    `Goals (${bundle.goals.length}):`,
    ...bundle.goals.map(
      (goal) =>
        `  [${goal.state}] ${goal.title}${goal.blockers.length ? ` (blockers: ${goal.blockers.join('; ')})` : ''}${goal.nextProposedStep ? ` next(informational): ${goal.nextProposedStep}` : ''}`,
    ),
    bundle.contradictions.length
      ? `Contradictions: ${bundle.contradictions.map((entry) => entry.subjectKey).join(', ')}`
      : 'Contradictions: none',
    bundle.uncertainties.length
      ? `Uncertainties: ${bundle.uncertainties.join(' | ')}`
      : 'Uncertainties: none',
    `Excluded: ${summarizeExclusions(bundle.excluded)}`,
  ];
  return lines.join('\n');
}
