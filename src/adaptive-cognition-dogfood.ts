/**
 * Evidence accounting for the Adaptive Cognition live dogfood protocol.
 *
 * This module is deliberately pure. It does not read a database, call a
 * provider, send a message, write a calendar, restart a service, push code, or
 * mutate an external system. Callers must supply already-observed metadata.
 */

export const ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION = 1 as const;
export const ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET = 20 as const;
export const ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET = 10 as const;
export const ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE = 2 as const;

export const ADAPTIVE_COGNITION_DOGFOOD_PRIVACY = Object.freeze({
  metadataOnly: true,
  rawUserContentStored: false,
  rawAssistantContentStored: false,
  rawPrivateBodiesStored: false,
  rawToolOutputStored: false,
  hiddenReasoningStored: false,
  secretsStored: false,
} as const);

export const ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY = Object.freeze({
  persistsRecords: false,
  sendsMessages: false,
  writesCalendars: false,
  restartsServices: false,
  pushesCode: false,
  mutatesExternalSystems: false,
} as const);

export const ADAPTIVE_COGNITION_DOGFOOD_TASK_FAMILIES = [
  'analysis',
  'coding',
  'operator',
  'planning',
  'research',
  'verification',
  'mixed',
] as const;

export type AdaptiveCognitionDogfoodTaskFamily =
  (typeof ADAPTIVE_COGNITION_DOGFOOD_TASK_FAMILIES)[number];

export const ADAPTIVE_COGNITION_DOGFOOD_OUTCOMES = [
  'completed',
  'partial',
  'blocked',
  'failed',
] as const;

export type AdaptiveCognitionDogfoodOutcome =
  (typeof ADAPTIVE_COGNITION_DOGFOOD_OUTCOMES)[number];

export const ADAPTIVE_COGNITION_DOGFOOD_OWNER_VERDICTS = [
  'accepted',
  'corrected',
  'rejected',
  'blocked',
] as const;

export type AdaptiveCognitionDogfoodOwnerVerdict =
  (typeof ADAPTIVE_COGNITION_DOGFOOD_OWNER_VERDICTS)[number];

export interface AdaptiveCognitionDogfoodOwnerVerdictRecord {
  verdict: AdaptiveCognitionDogfoodOwnerVerdict;
  verdictRef: string;
  recordedAt: string;
}

export interface AdaptiveCognitionDogfoodTaskRecord {
  protocolVersion: typeof ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION;
  taskId: string;
  runId: string;
  /** Canonical UTC date (`YYYY-MM-DD`) on which the live task completed. */
  workingDate: string;
  /** Canonical ISO instant on the same UTC date as `workingDate`. */
  completedAt: string;
  taskFamily: AdaptiveCognitionDogfoodTaskFamily;
  outcome: AdaptiveCognitionDogfoodOutcome;
  runOrigin: 'live';
  evidenceOrigin: 'direct_live_observation';
  verifierRefs: readonly string[];
  evidenceRefs: readonly string[];
  receiptRefs: readonly string[];
  ownerVerdict: Readonly<AdaptiveCognitionDogfoodOwnerVerdictRecord>;
  privacy: typeof ADAPTIVE_COGNITION_DOGFOOD_PRIVACY;
}

export interface CreateAdaptiveCognitionDogfoodTaskInput {
  taskId: string;
  runId: string;
  workingDate: string;
  completedAt: string;
  taskFamily: AdaptiveCognitionDogfoodTaskFamily;
  outcome: AdaptiveCognitionDogfoodOutcome;
  runOrigin: 'live';
  evidenceOrigin: 'direct_live_observation';
  verifierRefs: readonly string[];
  evidenceRefs: readonly string[];
  receiptRefs: readonly string[];
  ownerVerdict: AdaptiveCognitionDogfoodOwnerVerdictRecord;
}

export type AdaptiveCognitionDogfoodExclusionCode =
  | 'unknown_metadata_field'
  | 'unsupported_protocol_version'
  | 'invalid_task_id'
  | 'invalid_run_id'
  | 'invalid_working_date'
  | 'non_working_date'
  | 'invalid_completed_at'
  | 'working_date_mismatch'
  | 'future_observation'
  | 'invalid_task_family'
  | 'invalid_outcome'
  | 'not_live'
  | 'not_direct_live_observation'
  | 'missing_verifier_refs'
  | 'invalid_verifier_ref'
  | 'missing_evidence_refs'
  | 'invalid_evidence_ref'
  | 'missing_receipt_refs'
  | 'invalid_receipt_ref'
  | 'missing_owner_verdict'
  | 'unknown_owner_verdict_field'
  | 'invalid_owner_verdict'
  | 'invalid_owner_verdict_ref'
  | 'invalid_owner_verdict_at'
  | 'owner_verdict_before_completion'
  | 'invalid_privacy_contract'
  | 'duplicate_task_id'
  | 'duplicate_run_id'
  | 'daily_task_limit_exceeded';

export type AdaptiveCognitionDogfoodBlockerCode =
  | AdaptiveCognitionDogfoodExclusionCode
  | 'task_target_remaining'
  | 'working_date_target_remaining'
  | 'working_date_requires_second_task'
  | 'task_outcome_partial'
  | 'task_outcome_blocked'
  | 'task_outcome_failed'
  | 'owner_verdict_rejected'
  | 'owner_verdict_blocked';

export interface AdaptiveCognitionDogfoodExcludedCandidate {
  /** Safe task ID when available; otherwise a generated ordinal reference. */
  candidateRef: string;
  reasonCodes: AdaptiveCognitionDogfoodExclusionCode[];
}

export interface AdaptiveCognitionDogfoodWorkingDateProgress {
  workingDate: string;
  taskCount: number;
  taskRefs: string[];
  explicitOwnerVerdictCount: number;
  complete: boolean;
}

export interface AdaptiveCognitionDogfoodBlocker {
  code: AdaptiveCognitionDogfoodBlockerCode;
  count: number;
  taskRefs: string[];
}

export interface AdaptiveCognitionDogfoodReport {
  protocolVersion: typeof ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION;
  generatedAt: string;
  status: 'not_started' | 'in_progress' | 'complete';
  completionEligible: boolean;
  targetTaskCount: typeof ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET;
  targetWorkingDateCount: typeof ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET;
  tasksPerWorkingDate: typeof ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE;
  candidateCount: number;
  countedTaskCount: number;
  remainingTaskCount: number;
  distinctWorkingDateCount: number;
  completedWorkingDateCount: number;
  remainingWorkingDateCount: number;
  explicitOwnerVerdictCount: number;
  ownerVerdictCounts: Record<AdaptiveCognitionDogfoodOwnerVerdict, number>;
  outcomeCounts: Record<AdaptiveCognitionDogfoodOutcome, number>;
  taskProgressPercent: number;
  workingDateProgressPercent: number;
  workingDates: AdaptiveCognitionDogfoodWorkingDateProgress[];
  excludedCandidateCount: number;
  exclusions: AdaptiveCognitionDogfoodExcludedCandidate[];
  blockers: AdaptiveCognitionDogfoodBlocker[];
  nextActionCode:
    | 'collect_two_live_tasks_on_next_working_date'
    | 'inspect_protocol_exclusions'
    | 'review_live_task_blockers'
    | 'review_completed_protocol';
  privacy: typeof ADAPTIVE_COGNITION_DOGFOOD_PRIVACY;
  boundary: typeof ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY;
}

type UnknownRecord = Record<string, unknown>;

interface CandidateValidation {
  candidateRef: string;
  issues: AdaptiveCognitionDogfoodExclusionCode[];
  record: AdaptiveCognitionDogfoodTaskRecord | null;
}

const TASK_FAMILY_SET = new Set<string>(
  ADAPTIVE_COGNITION_DOGFOOD_TASK_FAMILIES,
);
const OUTCOME_SET = new Set<string>(ADAPTIVE_COGNITION_DOGFOOD_OUTCOMES);
const OWNER_VERDICT_SET = new Set<string>(
  ADAPTIVE_COGNITION_DOGFOOD_OWNER_VERDICTS,
);

const INPUT_KEYS = new Set([
  'taskId',
  'runId',
  'workingDate',
  'completedAt',
  'taskFamily',
  'outcome',
  'runOrigin',
  'evidenceOrigin',
  'verifierRefs',
  'evidenceRefs',
  'receiptRefs',
  'ownerVerdict',
]);

const RECORD_KEYS = new Set([...INPUT_KEYS, 'protocolVersion', 'privacy']);
const OWNER_VERDICT_KEYS = new Set(['verdict', 'verdictRef', 'recordedAt']);
const PRIVACY_KEYS = new Set(Object.keys(ADAPTIVE_COGNITION_DOGFOOD_PRIVACY));
const OPAQUE_REF_RE =
  /^(?:[A-Za-z][A-Za-z0-9_.-]{0,31}:){1,3}(?:[A-Fa-f0-9]{16,64}|[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[1-5][A-Fa-f0-9]{3}-[89ABab][A-Fa-f0-9]{3}-[A-Fa-f0-9]{12})$/;
const SECRET_LIKE_REF_RE = /(?:sk-|AIza|gh[pousr]_|password|secret|token)/i;

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnknownKeys(value: UnknownRecord, allowed: Set<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isOpaqueRef(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    OPAQUE_REF_RE.test(value) &&
    !SECRET_LIKE_REF_RE.test(value) &&
    !/^\d{7,}$/.test(value)
  );
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function parseDateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
}

function isWorkingDate(value: string): boolean {
  const date = parseDateOnly(value);
  return date !== null && ![0, 6].includes(date.getUTCDay());
}

function validateRefList(
  value: unknown,
  missingCode:
    | 'missing_verifier_refs'
    | 'missing_evidence_refs'
    | 'missing_receipt_refs',
  invalidCode:
    | 'invalid_verifier_ref'
    | 'invalid_evidence_ref'
    | 'invalid_receipt_ref',
  issues: AdaptiveCognitionDogfoodExclusionCode[],
): value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(missingCode);
    return false;
  }
  const valid =
    value.every(isOpaqueRef) &&
    new Set(value as string[]).size === value.length;
  if (!valid) issues.push(invalidCode);
  return valid;
}

function privacyContractMatches(value: unknown): boolean {
  if (!isUnknownRecord(value) || hasUnknownKeys(value, PRIVACY_KEYS)) {
    return false;
  }
  return Object.entries(ADAPTIVE_COGNITION_DOGFOOD_PRIVACY).every(
    ([key, expected]) => value[key] === expected,
  );
}

function candidateRef(value: unknown, ordinal: number): string {
  if (isUnknownRecord(value) && isOpaqueRef(value.taskId)) return value.taskId;
  return `candidate:${String(ordinal + 1).padStart(4, '0')}`;
}

function validateCandidate(
  value: unknown,
  ordinal: number,
  asOf?: string,
): CandidateValidation {
  const reference = candidateRef(value, ordinal);
  const issues: AdaptiveCognitionDogfoodExclusionCode[] = [];
  if (!isUnknownRecord(value)) {
    return {
      candidateRef: reference,
      issues: ['unknown_metadata_field'],
      record: null,
    };
  }
  if (hasUnknownKeys(value, RECORD_KEYS)) issues.push('unknown_metadata_field');
  if (value.protocolVersion !== ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION) {
    issues.push('unsupported_protocol_version');
  }
  if (!isOpaqueRef(value.taskId)) issues.push('invalid_task_id');
  if (!isOpaqueRef(value.runId)) issues.push('invalid_run_id');

  const parsedWorkingDate = parseDateOnly(value.workingDate);
  if (!parsedWorkingDate) {
    issues.push('invalid_working_date');
  } else if (!isWorkingDate(value.workingDate as string)) {
    issues.push('non_working_date');
  }

  const completedAt = value.completedAt;
  const completedAtValid = isCanonicalIsoInstant(completedAt);
  if (!completedAtValid) {
    issues.push('invalid_completed_at');
  } else if (
    parsedWorkingDate &&
    completedAt.slice(0, 10) !== value.workingDate
  ) {
    issues.push('working_date_mismatch');
  }
  if (asOf && completedAtValid && Date.parse(completedAt) > Date.parse(asOf)) {
    issues.push('future_observation');
  }

  if (
    typeof value.taskFamily !== 'string' ||
    !TASK_FAMILY_SET.has(value.taskFamily)
  ) {
    issues.push('invalid_task_family');
  }
  if (typeof value.outcome !== 'string' || !OUTCOME_SET.has(value.outcome)) {
    issues.push('invalid_outcome');
  }
  if (value.runOrigin !== 'live') issues.push('not_live');
  if (value.evidenceOrigin !== 'direct_live_observation') {
    issues.push('not_direct_live_observation');
  }

  const verifierRefsValid = validateRefList(
    value.verifierRefs,
    'missing_verifier_refs',
    'invalid_verifier_ref',
    issues,
  );
  const evidenceRefsValid = validateRefList(
    value.evidenceRefs,
    'missing_evidence_refs',
    'invalid_evidence_ref',
    issues,
  );
  const receiptRefsValid = validateRefList(
    value.receiptRefs,
    'missing_receipt_refs',
    'invalid_receipt_ref',
    issues,
  );

  let ownerVerdictValid = false;
  if (!isUnknownRecord(value.ownerVerdict)) {
    issues.push('missing_owner_verdict');
  } else {
    const ownerVerdictValue = value.ownerVerdict;
    if (hasUnknownKeys(ownerVerdictValue, OWNER_VERDICT_KEYS)) {
      issues.push('unknown_owner_verdict_field');
    }
    if (
      typeof ownerVerdictValue.verdict !== 'string' ||
      !OWNER_VERDICT_SET.has(ownerVerdictValue.verdict)
    ) {
      issues.push('invalid_owner_verdict');
    }
    if (!isOpaqueRef(ownerVerdictValue.verdictRef)) {
      issues.push('invalid_owner_verdict_ref');
    }
    const verdictRecordedAt = ownerVerdictValue.recordedAt;
    const verdictAtValid = isCanonicalIsoInstant(verdictRecordedAt);
    if (!verdictAtValid) {
      issues.push('invalid_owner_verdict_at');
    } else {
      if (
        completedAtValid &&
        Date.parse(verdictRecordedAt) < Date.parse(completedAt)
      ) {
        issues.push('owner_verdict_before_completion');
      }
      if (asOf && Date.parse(verdictRecordedAt) > Date.parse(asOf)) {
        issues.push('future_observation');
      }
    }
    ownerVerdictValid =
      !hasUnknownKeys(ownerVerdictValue, OWNER_VERDICT_KEYS) &&
      typeof ownerVerdictValue.verdict === 'string' &&
      OWNER_VERDICT_SET.has(ownerVerdictValue.verdict) &&
      isOpaqueRef(ownerVerdictValue.verdictRef) &&
      verdictAtValid;
  }

  if (!privacyContractMatches(value.privacy)) {
    issues.push('invalid_privacy_contract');
  }

  const uniqueIssues = [...new Set(issues)];
  if (
    uniqueIssues.length > 0 ||
    !verifierRefsValid ||
    !evidenceRefsValid ||
    !receiptRefsValid ||
    !ownerVerdictValid
  ) {
    return {
      candidateRef: reference,
      issues: uniqueIssues,
      record: null,
    };
  }

  const ownerVerdict = value.ownerVerdict as UnknownRecord;
  return {
    candidateRef: reference,
    issues: [],
    record: Object.freeze({
      protocolVersion: ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION,
      taskId: value.taskId as string,
      runId: value.runId as string,
      workingDate: value.workingDate as string,
      completedAt: value.completedAt as string,
      taskFamily: value.taskFamily as AdaptiveCognitionDogfoodTaskFamily,
      outcome: value.outcome as AdaptiveCognitionDogfoodOutcome,
      runOrigin: 'live',
      evidenceOrigin: 'direct_live_observation',
      verifierRefs: Object.freeze([...(value.verifierRefs as string[])]),
      evidenceRefs: Object.freeze([...(value.evidenceRefs as string[])]),
      receiptRefs: Object.freeze([...(value.receiptRefs as string[])]),
      ownerVerdict: Object.freeze({
        verdict: ownerVerdict.verdict as AdaptiveCognitionDogfoodOwnerVerdict,
        verdictRef: ownerVerdict.verdictRef as string,
        recordedAt: ownerVerdict.recordedAt as string,
      }),
      privacy: ADAPTIVE_COGNITION_DOGFOOD_PRIVACY,
    }),
  };
}

function sortRecords(
  left: AdaptiveCognitionDogfoodTaskRecord,
  right: AdaptiveCognitionDogfoodTaskRecord,
): number {
  return (
    left.workingDate.localeCompare(right.workingDate) ||
    left.completedAt.localeCompare(right.completedAt) ||
    left.taskId.localeCompare(right.taskId) ||
    left.runId.localeCompare(right.runId)
  );
}

function percent(numerator: number, denominator: number): number {
  return Number(
    (Math.min(1, Math.max(0, numerator) / denominator) * 100).toFixed(1),
  );
}

/**
 * Creates one admissible metadata-only live record. The function records
 * nothing itself; "create" means construct and validate an immutable value.
 */
export function createAdaptiveCognitionDogfoodTaskRecord(
  input: CreateAdaptiveCognitionDogfoodTaskInput,
): AdaptiveCognitionDogfoodTaskRecord {
  const rawInput = input as unknown;
  if (!isUnknownRecord(rawInput) || hasUnknownKeys(rawInput, INPUT_KEYS)) {
    throw new Error(
      'Adaptive cognition dogfood record rejected: unknown_metadata_field.',
    );
  }
  if (
    !isUnknownRecord(rawInput.ownerVerdict) ||
    hasUnknownKeys(rawInput.ownerVerdict, OWNER_VERDICT_KEYS)
  ) {
    throw new Error(
      'Adaptive cognition dogfood record rejected: unknown_owner_verdict_field.',
    );
  }
  const candidate = {
    ...input,
    protocolVersion: ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION,
    privacy: ADAPTIVE_COGNITION_DOGFOOD_PRIVACY,
  };
  const validation = validateCandidate(candidate, 0);
  if (!validation.record) {
    throw new Error(
      `Adaptive cognition dogfood record rejected: ${validation.issues.join(', ')}.`,
    );
  }
  return validation.record;
}

function addBlocker(
  map: Map<AdaptiveCognitionDogfoodBlockerCode, Set<string>>,
  code: AdaptiveCognitionDogfoodBlockerCode,
  taskRef: string,
): void {
  const refs = map.get(code) ?? new Set<string>();
  if (taskRef) refs.add(taskRef);
  map.set(code, refs);
}

/**
 * Builds deterministic progress from untrusted candidate records. Candidates
 * that do not prove direct live observation are reported but never counted.
 */
export function buildAdaptiveCognitionDogfoodReport(input: {
  candidates: readonly unknown[];
  asOf: string;
}): AdaptiveCognitionDogfoodReport {
  if (!isCanonicalIsoInstant(input.asOf)) {
    throw new Error(
      'Adaptive cognition dogfood asOf must be a canonical ISO instant.',
    );
  }

  const exclusions: AdaptiveCognitionDogfoodExcludedCandidate[] = [];
  const blockerRefs = new Map<
    AdaptiveCognitionDogfoodBlockerCode,
    Set<string>
  >();
  const validated: AdaptiveCognitionDogfoodTaskRecord[] = [];

  input.candidates.forEach((candidate, ordinal) => {
    const result = validateCandidate(candidate, ordinal, input.asOf);
    if (!result.record) {
      exclusions.push({
        candidateRef: result.candidateRef,
        reasonCodes: result.issues,
      });
      for (const code of result.issues) {
        addBlocker(blockerRefs, code, result.candidateRef);
      }
      return;
    }
    validated.push(result.record);
  });

  const deduplicated: AdaptiveCognitionDogfoodTaskRecord[] = [];
  const seenTaskIds = new Set<string>();
  const seenRunIds = new Set<string>();
  for (const record of [...validated].sort(sortRecords)) {
    const reasonCodes: AdaptiveCognitionDogfoodExclusionCode[] = [];
    if (seenTaskIds.has(record.taskId)) reasonCodes.push('duplicate_task_id');
    if (seenRunIds.has(record.runId)) reasonCodes.push('duplicate_run_id');
    if (reasonCodes.length > 0) {
      exclusions.push({ candidateRef: record.taskId, reasonCodes });
      for (const code of reasonCodes) {
        addBlocker(blockerRefs, code, record.taskId);
      }
      continue;
    }
    seenTaskIds.add(record.taskId);
    seenRunIds.add(record.runId);
    deduplicated.push(record);
  }

  const recordsByDate = new Map<string, AdaptiveCognitionDogfoodTaskRecord[]>();
  for (const record of deduplicated) {
    const bucket = recordsByDate.get(record.workingDate) ?? [];
    bucket.push(record);
    recordsByDate.set(record.workingDate, bucket);
  }

  const counted: AdaptiveCognitionDogfoodTaskRecord[] = [];
  const workingDates: AdaptiveCognitionDogfoodWorkingDateProgress[] = [];
  for (const [workingDate, unsorted] of [...recordsByDate.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const sorted = [...unsorted].sort(sortRecords);
    const admitted = sorted.slice(
      0,
      ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE,
    );
    const overflow = sorted.slice(
      ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE,
    );
    for (const record of overflow) {
      exclusions.push({
        candidateRef: record.taskId,
        reasonCodes: ['daily_task_limit_exceeded'],
      });
      addBlocker(blockerRefs, 'daily_task_limit_exceeded', record.taskId);
    }
    counted.push(...admitted);
    const complete =
      admitted.length === ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE;
    if (!complete) {
      for (const record of admitted) {
        addBlocker(
          blockerRefs,
          'working_date_requires_second_task',
          record.taskId,
        );
      }
    }
    workingDates.push({
      workingDate,
      taskCount: admitted.length,
      taskRefs: admitted.map((record) => record.taskId),
      explicitOwnerVerdictCount: admitted.length,
      complete,
    });
  }

  const ownerVerdictCounts: Record<
    AdaptiveCognitionDogfoodOwnerVerdict,
    number
  > = { accepted: 0, corrected: 0, rejected: 0, blocked: 0 };
  const outcomeCounts: Record<AdaptiveCognitionDogfoodOutcome, number> = {
    completed: 0,
    partial: 0,
    blocked: 0,
    failed: 0,
  };
  for (const record of counted) {
    ownerVerdictCounts[record.ownerVerdict.verdict] += 1;
    outcomeCounts[record.outcome] += 1;
    if (record.outcome !== 'completed') {
      addBlocker(
        blockerRefs,
        `task_outcome_${record.outcome}` as
          | 'task_outcome_partial'
          | 'task_outcome_blocked'
          | 'task_outcome_failed',
        record.taskId,
      );
    }
    if (record.ownerVerdict.verdict === 'rejected') {
      addBlocker(blockerRefs, 'owner_verdict_rejected', record.taskId);
    } else if (record.ownerVerdict.verdict === 'blocked') {
      addBlocker(blockerRefs, 'owner_verdict_blocked', record.taskId);
    }
  }

  const completedWorkingDateCount = workingDates.filter(
    (entry) => entry.complete,
  ).length;
  const remainingTaskCount = Math.max(
    0,
    ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET - counted.length,
  );
  const remainingWorkingDateCount = Math.max(
    0,
    ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET - completedWorkingDateCount,
  );
  const completionEligible =
    counted.length >= ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET &&
    completedWorkingDateCount >= ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET;

  const blockers: AdaptiveCognitionDogfoodBlocker[] = [...blockerRefs.entries()]
    .map(([code, refs]) => ({
      code,
      count: refs.size,
      taskRefs: [...refs].sort(),
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
  if (remainingTaskCount > 0) {
    blockers.push({
      code: 'task_target_remaining',
      count: remainingTaskCount,
      taskRefs: [],
    });
  }
  if (remainingWorkingDateCount > 0) {
    blockers.push({
      code: 'working_date_target_remaining',
      count: remainingWorkingDateCount,
      taskRefs: [],
    });
  }

  const liveTaskBlockers =
    outcomeCounts.partial +
    outcomeCounts.blocked +
    outcomeCounts.failed +
    ownerVerdictCounts.rejected +
    ownerVerdictCounts.blocked;
  const status: AdaptiveCognitionDogfoodReport['status'] = completionEligible
    ? 'complete'
    : counted.length === 0
      ? 'not_started'
      : 'in_progress';
  const nextActionCode: AdaptiveCognitionDogfoodReport['nextActionCode'] =
    completionEligible
      ? 'review_completed_protocol'
      : exclusions.length > 0
        ? 'inspect_protocol_exclusions'
        : liveTaskBlockers > 0
          ? 'review_live_task_blockers'
          : 'collect_two_live_tasks_on_next_working_date';

  return {
    protocolVersion: ADAPTIVE_COGNITION_DOGFOOD_PROTOCOL_VERSION,
    generatedAt: input.asOf,
    status,
    completionEligible,
    targetTaskCount: ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET,
    targetWorkingDateCount: ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET,
    tasksPerWorkingDate: ADAPTIVE_COGNITION_DOGFOOD_TASKS_PER_WORKING_DATE,
    candidateCount: input.candidates.length,
    countedTaskCount: counted.length,
    remainingTaskCount,
    distinctWorkingDateCount: workingDates.length,
    completedWorkingDateCount,
    remainingWorkingDateCount,
    explicitOwnerVerdictCount: counted.length,
    ownerVerdictCounts,
    outcomeCounts,
    taskProgressPercent: percent(
      counted.length,
      ADAPTIVE_COGNITION_DOGFOOD_TASK_TARGET,
    ),
    workingDateProgressPercent: percent(
      completedWorkingDateCount,
      ADAPTIVE_COGNITION_DOGFOOD_WORKING_DATE_TARGET,
    ),
    workingDates,
    excludedCandidateCount: exclusions.length,
    exclusions: exclusions.sort(
      (left, right) =>
        left.candidateRef.localeCompare(right.candidateRef) ||
        left.reasonCodes.join(':').localeCompare(right.reasonCodes.join(':')),
    ),
    blockers,
    nextActionCode,
    privacy: ADAPTIVE_COGNITION_DOGFOOD_PRIVACY,
    boundary: ADAPTIVE_COGNITION_DOGFOOD_BOUNDARY,
  };
}
