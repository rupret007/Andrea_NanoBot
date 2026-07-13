import { createHash } from 'node:crypto';

export const RUNTIME_TOOL_EVIDENCE_VERSION = 1 as const;

export const RUNTIME_TOOL_ACTION_CLASSES = [
  'repository_read',
  'repository_state',
  'repository_write',
  'verification_test',
  'verification_typecheck',
  'verification_build',
  'verification_lint',
  'verification_format',
  'web_research',
  'delegation',
  'external_side_effect',
  'workflow_control',
  'other',
] as const;

export type RuntimeToolActionClass =
  (typeof RUNTIME_TOOL_ACTION_CLASSES)[number];

export type RuntimeToolLastOutcome =
  | 'succeeded'
  | 'failed'
  | 'unresolved'
  | 'none';

export interface RuntimeToolCallCounts {
  observed: number;
  succeeded: number;
  failed: number;
  unresolved: number;
}

export interface RuntimeToolActionEvidence extends RuntimeToolCallCounts {
  class: RuntimeToolActionClass;
  succeededAfterLastRepositoryWrite: number;
  lastOutcome: RuntimeToolLastOutcome;
  recovered: boolean;
}

export interface RuntimeToolStateEvidence {
  preStateFingerprint: string | null;
  postStateFingerprint: string | null;
  repositoryHeadFingerprint: string | null;
}

export interface RuntimeToolEvidenceV1 {
  version: typeof RUNTIME_TOOL_EVIDENCE_VERSION;
  evidenceId: string;
  cumulative: true;
  attempts: number;
  collectorStatus: 'complete' | 'partial';
  calls: RuntimeToolCallCounts;
  actions: RuntimeToolActionEvidence[];
  state: RuntimeToolStateEvidence;
  privacy: {
    metadataOnly: true;
    rawInputsStored: false;
    resultBodiesStored: false;
    toolUseIdsStored: false;
  };
}

const MAX_COUNT = 100_000;
const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATE_FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ROOT_KEYS = [
  'version',
  'evidenceId',
  'cumulative',
  'attempts',
  'collectorStatus',
  'calls',
  'actions',
  'state',
  'privacy',
] as const;
const COUNT_KEYS = ['observed', 'succeeded', 'failed', 'unresolved'] as const;
const ACTION_KEYS = [
  'class',
  'observed',
  'succeeded',
  'failed',
  'unresolved',
  'succeededAfterLastRepositoryWrite',
  'lastOutcome',
  'recovered',
] as const;
const PRIVACY_KEYS = [
  'metadataOnly',
  'rawInputsStored',
  'resultBodiesStored',
  'toolUseIdsStored',
] as const;
const STATE_KEYS = [
  'preStateFingerprint',
  'postStateFingerprint',
  'repositoryHeadFingerprint',
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function isBoundedCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
  );
}

function normalizeCounts(value: unknown): RuntimeToolCallCounts | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, COUNT_KEYS)) return null;

  const { observed, succeeded, failed, unresolved } = value;
  if (
    !isBoundedCount(observed) ||
    !isBoundedCount(succeeded) ||
    !isBoundedCount(failed) ||
    !isBoundedCount(unresolved) ||
    observed !== succeeded + failed + unresolved
  ) {
    return null;
  }

  return { observed, succeeded, failed, unresolved };
}

function normalizeAction(value: unknown): RuntimeToolActionEvidence | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ACTION_KEYS)) return null;

  if (
    typeof value.class !== 'string' ||
    !RUNTIME_TOOL_ACTION_CLASSES.includes(
      value.class as RuntimeToolActionClass,
    ) ||
    typeof value.recovered !== 'boolean' ||
    !isBoundedCount(value.succeededAfterLastRepositoryWrite) ||
    typeof value.lastOutcome !== 'string' ||
    !['succeeded', 'failed', 'unresolved', 'none'].includes(value.lastOutcome)
  ) {
    return null;
  }

  const counts = normalizeCounts({
    observed: value.observed,
    succeeded: value.succeeded,
    failed: value.failed,
    unresolved: value.unresolved,
  });
  if (!counts) return null;
  if (counts.observed === 0) return null;

  const lastOutcome = value.lastOutcome as RuntimeToolLastOutcome;
  if (
    (lastOutcome === 'none' && counts.observed !== 0) ||
    (lastOutcome !== 'none' && counts.observed === 0) ||
    (lastOutcome === 'succeeded' && counts.succeeded === 0) ||
    (lastOutcome === 'failed' && counts.failed === 0) ||
    (lastOutcome === 'unresolved' && counts.unresolved === 0) ||
    value.succeededAfterLastRepositoryWrite > counts.succeeded ||
    (value.recovered &&
      (counts.failed === 0 ||
        counts.succeeded === 0 ||
        lastOutcome !== 'succeeded'))
  ) {
    return null;
  }

  return {
    class: value.class as RuntimeToolActionClass,
    ...counts,
    succeededAfterLastRepositoryWrite: value.succeededAfterLastRepositoryWrite,
    lastOutcome,
    recovered: value.recovered,
  };
}

function normalizeState(value: unknown): RuntimeToolStateEvidence | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, STATE_KEYS)) return null;

  const values = [
    value.preStateFingerprint,
    value.postStateFingerprint,
    value.repositoryHeadFingerprint,
  ];
  if (
    values.some(
      (fingerprint) =>
        fingerprint !== null &&
        (typeof fingerprint !== 'string' ||
          !STATE_FINGERPRINT_PATTERN.test(fingerprint)),
    )
  ) {
    return null;
  }

  return {
    preStateFingerprint: value.preStateFingerprint as string | null,
    postStateFingerprint: value.postStateFingerprint as string | null,
    repositoryHeadFingerprint: value.repositoryHeadFingerprint as string | null,
  };
}

/**
 * Validate untrusted container evidence and return a detached canonical value.
 * Unknown fields and future versions are rejected so they cannot silently alter
 * the host's interpretation of execution evidence.
 */
export function normalizeRuntimeToolEvidenceV1(
  value: unknown,
): RuntimeToolEvidenceV1 | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ROOT_KEYS)) return null;
  if (
    value.version !== RUNTIME_TOOL_EVIDENCE_VERSION ||
    value.cumulative !== true ||
    typeof value.evidenceId !== 'string' ||
    !EVIDENCE_ID_PATTERN.test(value.evidenceId) ||
    !isBoundedCount(value.attempts) ||
    (value.collectorStatus !== 'complete' &&
      value.collectorStatus !== 'partial') ||
    !Array.isArray(value.actions) ||
    value.actions.length > RUNTIME_TOOL_ACTION_CLASSES.length
  ) {
    return null;
  }

  const calls = normalizeCounts(value.calls);
  const state = normalizeState(value.state);
  if (!calls || !state) return null;

  if (
    (value.collectorStatus === 'complete' && calls.unresolved !== 0) ||
    (calls.observed === 0 &&
      (state.preStateFingerprint !== null ||
        state.postStateFingerprint !== null ||
        state.repositoryHeadFingerprint !== null)) ||
    (value.attempts === 0 &&
      (value.collectorStatus !== 'partial' ||
        calls.observed !== 0 ||
        value.actions.length !== 0))
  ) {
    return null;
  }

  if (
    !isPlainRecord(value.privacy) ||
    !hasExactKeys(value.privacy, PRIVACY_KEYS)
  ) {
    return null;
  }
  if (
    value.privacy.metadataOnly !== true ||
    value.privacy.rawInputsStored !== false ||
    value.privacy.resultBodiesStored !== false ||
    value.privacy.toolUseIdsStored !== false
  ) {
    return null;
  }

  const actions: RuntimeToolActionEvidence[] = [];
  const seenClasses = new Set<RuntimeToolActionClass>();
  for (const rawAction of value.actions) {
    const action = normalizeAction(rawAction);
    if (!action || seenClasses.has(action.class)) return null;
    seenClasses.add(action.class);
    actions.push(action);
  }

  const exceedsCallTotals = actions.some(
    (action) =>
      action.observed > calls.observed ||
      action.succeeded > calls.succeeded ||
      action.failed > calls.failed ||
      action.unresolved > calls.unresolved,
  );
  const repositoryState = actions.find(
    (action) => action.class === 'repository_state',
  );
  const repositoryWrite = actions.find(
    (action) => action.class === 'repository_write',
  );
  const claimsPostWriteSuccess = actions.some(
    (action) => action.succeededAfterLastRepositoryWrite > 0,
  );
  const hasStateFingerprint =
    state.preStateFingerprint !== null ||
    state.postStateFingerprint !== null ||
    state.repositoryHeadFingerprint !== null;
  if (
    exceedsCallTotals ||
    (calls.observed === 0 ? actions.length !== 0 : actions.length === 0) ||
    (hasStateFingerprint && !repositoryState?.succeeded) ||
    (claimsPostWriteSuccess && !repositoryWrite?.observed) ||
    ((state.preStateFingerprint !== null ||
      state.postStateFingerprint !== null) &&
      !repositoryWrite?.observed)
  ) {
    return null;
  }

  actions.sort(
    (left, right) =>
      RUNTIME_TOOL_ACTION_CLASSES.indexOf(left.class) -
      RUNTIME_TOOL_ACTION_CLASSES.indexOf(right.class),
  );

  return {
    version: RUNTIME_TOOL_EVIDENCE_VERSION,
    evidenceId: value.evidenceId,
    cumulative: true,
    attempts: value.attempts,
    collectorStatus: value.collectorStatus,
    calls,
    actions,
    state,
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
  };
}

function mergeSameEvidenceState(
  current: RuntimeToolStateEvidence,
  incoming: RuntimeToolStateEvidence,
): { state: RuntimeToolStateEvidence; conflict: boolean } {
  const mergeFingerprint = (
    currentValue: string | null,
    incomingValue: string | null,
  ): { value: string | null; conflict: boolean } => {
    if (currentValue && incomingValue && currentValue !== incomingValue) {
      return { value: null, conflict: true };
    }
    return { value: currentValue ?? incomingValue, conflict: false };
  };

  const preStateFingerprint = mergeFingerprint(
    current.preStateFingerprint,
    incoming.preStateFingerprint,
  );
  const postStateFingerprint = mergeFingerprint(
    current.postStateFingerprint,
    incoming.postStateFingerprint,
  );
  const repositoryHeadFingerprint = mergeFingerprint(
    current.repositoryHeadFingerprint,
    incoming.repositoryHeadFingerprint,
  );
  return {
    state: {
      preStateFingerprint: preStateFingerprint.value,
      postStateFingerprint: postStateFingerprint.value,
      repositoryHeadFingerprint: repositoryHeadFingerprint.value,
    },
    conflict:
      preStateFingerprint.conflict ||
      postStateFingerprint.conflict ||
      repositoryHeadFingerprint.conflict,
  };
}

function isMonotonicSnapshot(
  current: RuntimeToolEvidenceV1,
  incoming: RuntimeToolEvidenceV1,
): boolean {
  if (incoming.attempts < current.attempts) return false;
  if (
    incoming.calls.observed < current.calls.observed ||
    incoming.calls.succeeded < current.calls.succeeded ||
    incoming.calls.failed < current.calls.failed
  ) {
    return false;
  }
  const incomingActions = new Map(
    incoming.actions.map((action) => [action.class, action]),
  );
  for (const currentAction of current.actions) {
    const incomingAction = incomingActions.get(currentAction.class);
    if (
      !incomingAction ||
      incomingAction.observed < currentAction.observed ||
      incomingAction.succeeded < currentAction.succeeded ||
      incomingAction.failed < currentAction.failed
    ) {
      return false;
    }
  }

  return true;
}

function hasOutcomeProgress(
  current: RuntimeToolEvidenceV1,
  incoming: RuntimeToolEvidenceV1,
): boolean {
  return (
    incoming.attempts > current.attempts ||
    incoming.calls.observed > current.calls.observed ||
    incoming.calls.succeeded > current.calls.succeeded ||
    incoming.calls.failed > current.calls.failed
  );
}

function compositeEvidenceId(evidenceIds: readonly string[]): string {
  const digest = createHash('sha256')
    .update([...evidenceIds].sort().join('\0'))
    .digest('hex')
    .slice(0, 32);
  return `composite:${digest}`;
}

function addBounded(left: number, right: number): number | null {
  const total = left + right;
  return total <= MAX_COUNT ? total : null;
}

function hasRepositoryTransitionPair(evidence: RuntimeToolEvidenceV1): boolean {
  return Boolean(
    evidence.state.preStateFingerprint && evidence.state.postStateFingerprint,
  );
}

function hasRepositoryTransitionFragment(
  evidence: RuntimeToolEvidenceV1,
): boolean {
  return Boolean(
    evidence.state.preStateFingerprint || evidence.state.postStateFingerprint,
  );
}

function containsRepositoryWrite(evidence: RuntimeToolEvidenceV1): boolean {
  return evidence.actions.some(
    (action) => action.class === 'repository_write' && action.observed > 0,
  );
}

function selectDistinctEvidenceState(
  current: RuntimeToolEvidenceV1,
  incoming: RuntimeToolEvidenceV1,
): {
  state: RuntimeToolStateEvidence;
  headConflict: boolean;
  incoherentTransition: boolean;
} {
  const headConflict = Boolean(
    current.state.repositoryHeadFingerprint &&
    incoming.state.repositoryHeadFingerprint &&
    current.state.repositoryHeadFingerprint !==
      incoming.state.repositoryHeadFingerprint,
  );
  const transitionSource = containsRepositoryWrite(incoming)
    ? hasRepositoryTransitionPair(incoming)
      ? incoming
      : null
    : hasRepositoryTransitionPair(current)
      ? current
      : hasRepositoryTransitionPair(incoming)
        ? incoming
        : null;
  const hasTransitionFragment =
    hasRepositoryTransitionFragment(current) ||
    hasRepositoryTransitionFragment(incoming);

  if (transitionSource) {
    return {
      state: {
        preStateFingerprint: transitionSource.state.preStateFingerprint,
        postStateFingerprint: transitionSource.state.postStateFingerprint,
        repositoryHeadFingerprint: headConflict
          ? null
          : transitionSource.state.repositoryHeadFingerprint,
      },
      headConflict,
      incoherentTransition: false,
    };
  }

  if (hasTransitionFragment) {
    return {
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
      headConflict,
      incoherentTransition: true,
    };
  }

  const headSource = incoming.state.repositoryHeadFingerprint
    ? incoming
    : current.state.repositoryHeadFingerprint
      ? current
      : null;
  return {
    state: {
      preStateFingerprint: null,
      postStateFingerprint: null,
      repositoryHeadFingerprint: headConflict
        ? null
        : (headSource?.state.repositoryHeadFingerprint ?? null),
    },
    headConflict,
    incoherentTransition: false,
  };
}

function combineDistinctEvidence(
  current: RuntimeToolEvidenceV1,
  incoming: RuntimeToolEvidenceV1,
): RuntimeToolEvidenceV1 | null {
  const attempts = addBounded(current.attempts, incoming.attempts);
  const calls = {
    observed: addBounded(current.calls.observed, incoming.calls.observed),
    succeeded: addBounded(current.calls.succeeded, incoming.calls.succeeded),
    failed: addBounded(current.calls.failed, incoming.calls.failed),
    unresolved: addBounded(current.calls.unresolved, incoming.calls.unresolved),
  };
  if (
    attempts === null ||
    calls.observed === null ||
    calls.succeeded === null ||
    calls.failed === null ||
    calls.unresolved === null
  ) {
    return null;
  }

  const currentActions = new Map(
    current.actions.map((action) => [action.class, action]),
  );
  const incomingActions = new Map(
    incoming.actions.map((action) => [action.class, action]),
  );
  const incomingContainsRepositoryWrite =
    (incomingActions.get('repository_write')?.observed ?? 0) > 0;
  const actions: RuntimeToolActionEvidence[] = [];

  for (const actionClass of RUNTIME_TOOL_ACTION_CLASSES) {
    const left = currentActions.get(actionClass);
    const right = incomingActions.get(actionClass);
    if (!left && !right) continue;

    const observed = addBounded(left?.observed ?? 0, right?.observed ?? 0);
    const succeeded = addBounded(left?.succeeded ?? 0, right?.succeeded ?? 0);
    const failed = addBounded(left?.failed ?? 0, right?.failed ?? 0);
    const unresolved = addBounded(
      left?.unresolved ?? 0,
      right?.unresolved ?? 0,
    );
    const succeededAfterLastRepositoryWrite = incomingContainsRepositoryWrite
      ? (right?.succeededAfterLastRepositoryWrite ?? 0)
      : addBounded(
          left?.succeededAfterLastRepositoryWrite ?? 0,
          right?.succeededAfterLastRepositoryWrite ?? 0,
        );
    if (
      observed === null ||
      succeeded === null ||
      failed === null ||
      unresolved === null ||
      succeededAfterLastRepositoryWrite === null
    ) {
      return null;
    }

    const rightHasOutcome = Boolean(right && right.observed > 0);
    const lastOutcome = rightHasOutcome
      ? right!.lastOutcome
      : (left?.lastOutcome ?? 'none');
    const orderedCrossRunRecovery = Boolean(
      left &&
      left.failed > 0 &&
      right &&
      right.succeeded > 0 &&
      right.lastOutcome === 'succeeded',
    );
    const recovered =
      lastOutcome === 'succeeded' &&
      Boolean(
        right?.recovered ||
        (!rightHasOutcome && left?.recovered) ||
        orderedCrossRunRecovery,
      );

    actions.push({
      class: actionClass,
      observed,
      succeeded,
      failed,
      unresolved,
      succeededAfterLastRepositoryWrite,
      lastOutcome,
      recovered,
    });
  }

  const stateSelection = selectDistinctEvidenceState(current, incoming);

  return {
    version: RUNTIME_TOOL_EVIDENCE_VERSION,
    evidenceId: compositeEvidenceId([current.evidenceId, incoming.evidenceId]),
    cumulative: true,
    attempts,
    collectorStatus:
      current.collectorStatus === 'complete' &&
      incoming.collectorStatus === 'complete' &&
      calls.unresolved === 0 &&
      !stateSelection.headConflict &&
      !stateSelection.incoherentTransition
        ? 'complete'
        : 'partial',
    calls: {
      observed: calls.observed,
      succeeded: calls.succeeded,
      failed: calls.failed,
      unresolved: calls.unresolved,
    },
    actions,
    state: stateSelection.state,
    privacy: {
      metadataOnly: true,
      rawInputsStored: false,
      resultBodiesStored: false,
      toolUseIdsStored: false,
    },
  };
}

/**
 * Merge cumulative snapshots without double-counting. For the same evidence ID,
 * only a valid monotonic replacement is accepted. Invalid, stale, or regressive
 * updates leave the last trusted value unchanged. Conflicting cumulative state
 * is retained only as a partial receipt with the disputed fingerprint removed.
 * A later partial receipt poisons the same snapshot position until additional
 * attempts or observed outcomes provide new evidence.
 */
export function mergeRuntimeToolEvidenceV1(
  currentValue: unknown,
  incomingValue: unknown,
): RuntimeToolEvidenceV1 | null {
  const current = normalizeRuntimeToolEvidenceV1(currentValue);
  const incoming = normalizeRuntimeToolEvidenceV1(incomingValue);

  if (!incoming) return current;
  if (!current) return incoming;
  if (current.evidenceId !== incoming.evidenceId) {
    return combineDistinctEvidence(current, incoming) ?? current;
  }
  if (!isMonotonicSnapshot(current, incoming)) return current;
  const stateMerge = mergeSameEvidenceState(current.state, incoming.state);
  const preservePartialStatus =
    current.collectorStatus === 'partial' &&
    incoming.collectorStatus === 'complete' &&
    !hasOutcomeProgress(current, incoming);
  return {
    ...incoming,
    collectorStatus:
      stateMerge.conflict || preservePartialStatus
        ? 'partial'
        : incoming.collectorStatus,
    state: stateMerge.state,
  };
}

/**
 * Collapse source snapshots once per evidence ID. The local map prevents retry
 * updates from being counted twice while the persisted value remains aggregate
 * metadata with a deterministic, bounded composite ID.
 */
export function collapseRuntimeToolEvidenceV1(
  values: readonly unknown[],
): RuntimeToolEvidenceV1 | null {
  const evidenceById = new Map<string, RuntimeToolEvidenceV1>();
  for (const value of values) {
    const evidence = normalizeRuntimeToolEvidenceV1(value);
    if (!evidence) continue;
    const current = evidenceById.get(evidence.evidenceId);
    evidenceById.set(
      evidence.evidenceId,
      current
        ? (mergeRuntimeToolEvidenceV1(current, evidence) ?? current)
        : evidence,
    );
  }

  const evidence = [...evidenceById.values()];
  if (evidence.length === 0) return null;
  if (evidence.length === 1) return evidence[0];

  let combined = evidence[0];
  for (let index = 1; index < evidence.length; index += 1) {
    const next = combineDistinctEvidence(combined, evidence[index]);
    if (!next) return null;
    combined = next;
  }
  const repositoryHeads = new Set(
    evidence
      .map((item) => item.state.repositoryHeadFingerprint)
      .filter((item): item is string => item !== null),
  );
  const headConflict = repositoryHeads.size > 1;
  let latestRepositoryWriteEvidence: RuntimeToolEvidenceV1 | null = null;
  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    if (containsRepositoryWrite(evidence[index])) {
      latestRepositoryWriteEvidence = evidence[index];
      break;
    }
  }
  const coherentTransitionSource =
    latestRepositoryWriteEvidence &&
    hasRepositoryTransitionPair(latestRepositoryWriteEvidence)
      ? latestRepositoryWriteEvidence
      : null;
  const hasTransitionFragment = evidence.some(hasRepositoryTransitionFragment);
  const incoherentTransition =
    hasTransitionFragment && !coherentTransitionSource;
  const headOnlySource = !hasTransitionFragment
    ? [...evidence]
        .reverse()
        .find((item) => item.state.repositoryHeadFingerprint !== null)
    : null;
  return {
    ...combined,
    evidenceId: compositeEvidenceId([...evidenceById.keys()]),
    collectorStatus:
      evidence.every((item) => item.collectorStatus === 'complete') &&
      combined.calls.unresolved === 0 &&
      !headConflict &&
      !incoherentTransition
        ? 'complete'
        : 'partial',
    state: {
      preStateFingerprint:
        coherentTransitionSource?.state.preStateFingerprint ?? null,
      postStateFingerprint:
        coherentTransitionSource?.state.postStateFingerprint ?? null,
      repositoryHeadFingerprint: headConflict
        ? null
        : (coherentTransitionSource?.state.repositoryHeadFingerprint ??
          headOnlySource?.state.repositoryHeadFingerprint ??
          null),
    },
  };
}
