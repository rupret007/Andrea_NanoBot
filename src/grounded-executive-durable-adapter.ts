import {
  insertGroundedBeliefJournalEntry,
  insertGroundedCalibrationSample,
  insertGroundedDecisionJournalEntry,
  isDatabaseInitialized,
  listGroundedBeliefJournal,
  listGroundedCalibrationSamples,
  listGroundedDecisionJournal,
  listGroundedLearningRecords,
  upsertGroundedLearningRecord,
} from './db.js';
import { ADAPTIVE_COGNITION_PRIVACY } from './adaptive-cognition-engine.js';
import type { AdaptiveCalibrationSample } from './adaptive-cognition-engine.js';
import { recordVerifiedUsageReliability } from './tool-reliability.js';
import type {
  StoredGroundedBeliefJournalEntry,
  StoredGroundedCalibrationSample,
  StoredGroundedDecisionJournalEntry,
  StoredGroundedLearningRecord,
} from './types.js';
import type {
  GroundedExecutiveState,
  GroundedLearningRecord,
  GroundedOutcomeVerification,
} from './grounded-cognitive-executive.js';

/**
 * Durable adapter for the grounded cognitive executive.
 *
 * The pure module owns reasoning; this adapter owns persistence, following
 * the adaptive-cognition-durable-adapter pattern: every write is gated on an
 * initialized database, journals are append-only, and learning records are
 * reviewable (proposed -> accepted -> retired) with a schema-level guarantee
 * that they can never carry action authority.
 */

const PRIVACY_JSON = JSON.stringify(ADAPTIVE_COGNITION_PRIVACY);
const DEFAULT_PLANNING_LIMIT = 24;

export interface PersistGroundedTurnJournalResult {
  persisted: boolean;
  beliefEntries: number;
  decisionEntries: number;
  calibrationSamples: number;
}

/** Journals belief changes, decisions, and calibration samples for a turn. */
export function persistGroundedTurnJournal(
  state: GroundedExecutiveState,
  turnId: string | null = state.turnRef,
): PersistGroundedTurnJournalResult {
  if (!isDatabaseInitialized()) {
    return {
      persisted: false,
      beliefEntries: 0,
      decisionEntries: 0,
      calibrationSamples: 0,
    };
  }
  for (const change of state.beliefJournal) {
    const entry: StoredGroundedBeliefJournalEntry = {
      entryId: change.changeId,
      createdAt: change.createdAt,
      turnId,
      beliefId: change.beliefId,
      subject: change.subject,
      predicate: change.predicate,
      value: change.value,
      previousTier: change.previousTier,
      newTier: change.newTier,
      previousConfidence: change.previousConfidence,
      newConfidence: change.newConfidence,
      cause: change.cause,
      explanation: change.explanation,
      evidenceRefsJson: JSON.stringify(change.evidenceRefs),
      privacyJson: PRIVACY_JSON,
    };
    insertGroundedBeliefJournalEntry(entry);
  }
  for (const decision of state.decisions) {
    const entry: StoredGroundedDecisionJournalEntry = {
      entryId: decision.decisionId,
      createdAt: decision.createdAt,
      turnId,
      decisionId: decision.decisionId,
      kind: decision.kind,
      confidence: decision.confidence,
      reason: decision.reason,
      whatWouldChangeMindJson: JSON.stringify(decision.whatWouldChangeMind),
      candidateScoresJson: JSON.stringify(decision.candidateScores),
      selectedRef:
        decision.targetNodeId ??
        decision.researchTarget ??
        decision.question ??
        null,
      privacyJson: PRIVACY_JSON,
    };
    insertGroundedDecisionJournalEntry(entry);
  }
  for (const sample of state.calibrationSamples) {
    const stored: StoredGroundedCalibrationSample = {
      sampleId: sample.sampleId,
      createdAt: sample.createdAt,
      turnId,
      contextKey: sample.contextKey,
      predictedConfidence: sample.predictedConfidence,
      outcome: sample.outcome,
      verdict: sample.verdict,
      source: sample.source,
      privacyJson: PRIVACY_JSON,
    };
    insertGroundedCalibrationSample(stored);
  }
  return {
    persisted: true,
    beliefEntries: state.beliefJournal.length,
    decisionEntries: state.decisions.length,
    calibrationSamples: state.calibrationSamples.length,
  };
}

function toStoredLearningRecord(
  record: GroundedLearningRecord,
  now: string,
): StoredGroundedLearningRecord {
  return {
    recordId: record.recordId,
    createdAt: record.createdAt,
    updatedAt: now,
    kind: record.kind,
    status: record.status,
    subject: record.subject,
    contextKey: record.contextKey,
    lesson: record.lesson,
    evidenceRefsJson: JSON.stringify(record.evidenceRefs),
    counterEvidenceRefsJson: JSON.stringify(record.counterEvidenceRefs),
    appliesToAuthority: false,
    reviewNote: record.reviewNote,
    sourceTurnId: record.sourceTurnId,
    privacyJson: PRIVACY_JSON,
  };
}

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

function toPureLearningRecord(
  stored: StoredGroundedLearningRecord,
): GroundedLearningRecord {
  return {
    recordId: stored.recordId,
    createdAt: stored.createdAt,
    kind: stored.kind,
    status: stored.status,
    subject: stored.subject,
    contextKey: stored.contextKey,
    lesson: stored.lesson,
    evidenceRefs: parseRefs(stored.evidenceRefsJson),
    counterEvidenceRefs: parseRefs(stored.counterEvidenceRefsJson),
    appliesToAuthority: false,
    reviewNote: stored.reviewNote,
    sourceTurnId: stored.sourceTurnId,
  };
}

export function persistGroundedLearning(
  records: GroundedLearningRecord[],
  now: string,
): number {
  if (!isDatabaseInitialized()) return 0;
  for (const record of records) {
    upsertGroundedLearningRecord(toStoredLearningRecord(record, now));
  }
  return records.length;
}

function reviewGroundedLearningRecord(
  recordId: string,
  status: 'accepted' | 'retired',
  reviewNote: string,
  now: string,
): StoredGroundedLearningRecord | null {
  if (!isDatabaseInitialized()) return null;
  const existing = listGroundedLearningRecords({ limit: 500 }).find(
    (record) => record.recordId === recordId,
  );
  if (!existing) return null;
  const updated: StoredGroundedLearningRecord = {
    ...existing,
    status,
    reviewNote,
    updatedAt: now,
  };
  upsertGroundedLearningRecord(updated);
  return updated;
}

/** Owner review: activates a proposed lesson for planning use. */
export function acceptGroundedLearningRecord(
  recordId: string,
  reviewNote: string,
  now: string,
): StoredGroundedLearningRecord | null {
  return reviewGroundedLearningRecord(recordId, 'accepted', reviewNote, now);
}

/** The reversal path: a retired lesson no longer influences planning. */
export function retireGroundedLearningRecord(
  recordId: string,
  reviewNote: string,
  now: string,
): StoredGroundedLearningRecord | null {
  return reviewGroundedLearningRecord(recordId, 'retired', reviewNote, now);
}

/** Only accepted (owner-reviewed) lessons flow back into planning. */
export function loadGroundedLearningForPlanning(
  params: { contextKey?: string; limit?: number } = {},
): GroundedLearningRecord[] {
  return listGroundedLearningRecords({
    status: 'accepted',
    contextKey: params.contextKey,
    limit: params.limit ?? DEFAULT_PLANNING_LIMIT,
  }).map((stored) => toPureLearningRecord(stored));
}

export function loadGroundedCalibrationSamples(
  params: { contextKey?: string; limit?: number } = {},
): AdaptiveCalibrationSample[] {
  return listGroundedCalibrationSamples(params).map((sample) => ({
    confidence: sample.predictedConfidence,
    outcome: sample.outcome,
  }));
}

const VERDICT_TO_RELIABILITY_OUTCOME: Record<
  GroundedOutcomeVerification['verdict'],
  'success' | 'degraded' | 'blocked' | 'failed' | null
> = {
  verified: 'success',
  partial: 'degraded',
  blocked: 'blocked',
  failed: 'failed',
  // Uncertain outcomes are not reliability evidence either way.
  uncertain: null,
};

/**
 * Bridges a grounded verification into the existing tool-reliability
 * registry. Subjects not present in the seeded registry are dropped by
 * recordVerifiedUsageReliability itself, so this is a safe no-op for
 * unregistered tools.
 */
export function recordGroundedToolReliability(
  verification: GroundedOutcomeVerification,
  subjectIds: string[],
  now: string,
): number {
  if (!isDatabaseInitialized() || subjectIds.length === 0) return 0;
  const outcome = VERDICT_TO_RELIABILITY_OUTCOME[verification.verdict];
  if (!outcome) return 0;
  return recordVerifiedUsageReliability({
    subjectIds,
    observedAt: now,
    outcome,
    failureClass: outcome === 'success' ? undefined : verification.verdict,
    summary: verification.causalExplanation,
    evidenceRef: verification.verificationId,
  }).length;
}

export interface GroundedDurableDiagnostics {
  learningCounts: Record<'proposed' | 'accepted' | 'retired', number>;
  beliefJournalCount: number;
  decisionJournalCount: number;
  calibrationSampleCount: number;
}

/** Operator view of what the executive has durably recorded. */
export function groundedDurableDiagnostics(
  params: { turnId?: string } = {},
): GroundedDurableDiagnostics {
  const counts = { proposed: 0, accepted: 0, retired: 0 };
  for (const record of listGroundedLearningRecords({ limit: 500 })) {
    counts[record.status] += 1;
  }
  return {
    learningCounts: counts,
    beliefJournalCount: listGroundedBeliefJournal({
      turnId: params.turnId,
      limit: 500,
    }).length,
    decisionJournalCount: listGroundedDecisionJournal({
      turnId: params.turnId,
      limit: 500,
    }).length,
    calibrationSampleCount: listGroundedCalibrationSamples({ limit: 500 })
      .length,
  };
}
