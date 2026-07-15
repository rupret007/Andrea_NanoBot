import { createHash } from 'node:crypto';

import {
  durableActionPolicy,
  durableActionRequiresApproval,
} from './durable-action-policy.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityAcquisitionState,
  CapabilityAcquisitionTransitionRecord,
  CapabilityCandidateContract,
} from './types.js';

export const CAPABILITY_ACQUISITION_STATES = [
  'observed',
  'scoped',
  'resource_discovery',
  'candidate_designed',
  'sandbox_ready',
  'sandbox_running',
  'sandbox_verified',
  'owner_review_required',
  'canary_ready',
  'active',
  'monitoring',
  'paused',
  'quarantined',
  'retired',
  'externally_blocked',
  'failed',
  'indeterminate',
] as const satisfies readonly CapabilityAcquisitionState[];

const LEGAL_TRANSITIONS: Readonly<
  Record<CapabilityAcquisitionState, readonly CapabilityAcquisitionState[]>
> = {
  observed: ['scoped', 'externally_blocked', 'failed', 'quarantined'],
  scoped: ['resource_discovery', 'externally_blocked', 'failed', 'quarantined'],
  resource_discovery: [
    'candidate_designed',
    'externally_blocked',
    'failed',
    'quarantined',
  ],
  candidate_designed: [
    'candidate_designed',
    'sandbox_ready',
    'owner_review_required',
    'paused',
    'failed',
    'quarantined',
  ],
  sandbox_ready: ['sandbox_running', 'paused', 'failed', 'quarantined'],
  sandbox_running: [
    'sandbox_verified',
    'indeterminate',
    'failed',
    'quarantined',
  ],
  sandbox_verified: [
    'owner_review_required',
    'canary_ready',
    'paused',
    'quarantined',
  ],
  owner_review_required: [
    'sandbox_ready',
    'canary_ready',
    'paused',
    'quarantined',
    'retired',
  ],
  canary_ready: ['canary_ready', 'active', 'paused', 'quarantined', 'retired'],
  active: ['active', 'monitoring', 'paused', 'quarantined', 'retired'],
  monitoring: ['active', 'monitoring', 'paused', 'quarantined', 'retired'],
  paused: [
    'paused',
    'scoped',
    'resource_discovery',
    'candidate_designed',
    'sandbox_ready',
    'quarantined',
    'retired',
  ],
  quarantined: ['retired'],
  retired: [],
  externally_blocked: ['scoped', 'resource_discovery', 'retired'],
  failed: ['scoped', 'resource_discovery', 'quarantined', 'retired'],
  indeterminate: ['sandbox_ready', 'paused', 'failed', 'quarantined'],
};

const JSON_FIELDS = [
  'postconditionJson',
  'knownPrerequisitesJson',
  'missingPrerequisitesJson',
  'candidateResourceRefsJson',
  'selectedResourceRefsJson',
  'authorityRequirementsJson',
  'provenanceJson',
  'candidateContractJson',
  'sandboxEvidenceJson',
  'heldOutEvidenceJson',
  'ownerReviewJson',
  'outcomeIdsJson',
  'privacyJson',
] as const satisfies readonly (keyof CapabilityAcquisitionRecord)[];

export function isCapabilityAcquisitionState(
  value: unknown,
): value is CapabilityAcquisitionState {
  return (
    typeof value === 'string' &&
    (CAPABILITY_ACQUISITION_STATES as readonly string[]).includes(value)
  );
}

export function isLegalCapabilityAcquisitionTransition(
  from: CapabilityAcquisitionState,
  to: CapabilityAcquisitionState,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function parseCapabilityJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Capability acquisition ${field} must be valid JSON.`, {
      cause: error,
    });
  }
}

function assertIso(value: string | null | undefined, field: string): void {
  if (!value) return;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || !value.includes('T')) {
    throw new Error(
      `Capability acquisition ${field} must be an ISO timestamp.`,
    );
  }
}

export function canonicalCapabilityJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(visit(value));
}

export function capabilityAcquisitionSnapshotJson(
  record: CapabilityAcquisitionRecord,
): string {
  return canonicalCapabilityJson(record);
}

export function capabilityTransitionDigest(params: {
  acquisitionId: string;
  fromState: CapabilityAcquisitionState;
  toState: CapabilityAcquisitionState;
  expectedVersion: number;
  resultingVersion: number;
  actorKind: CapabilityAcquisitionTransitionRecord['actorKind'];
  reason: string;
  evidenceRefsJson: string;
  idempotencyKey: string;
  resultingSnapshotJson: string;
}): string {
  return createHash('sha256')
    .update(canonicalCapabilityJson(params))
    .digest('hex');
}

export function assertCapabilityCandidateContract(
  value: unknown,
): asserts value is CapabilityCandidateContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capability candidate contract must be an object.');
  }
  const contract = value as Partial<CapabilityCandidateContract>;
  if (
    !Number.isInteger(contract.contractVersion) ||
    Number(contract.contractVersion) < 1 ||
    typeof contract.capabilityId !== 'string' ||
    !contract.capabilityId ||
    typeof contract.skillId !== 'string' ||
    !contract.skillId ||
    typeof contract.candidateFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(contract.candidateFingerprint) ||
    typeof contract.taskFamily !== 'string' ||
    !contract.taskFamily ||
    typeof contract.inputSchemaJson !== 'string' ||
    typeof contract.outputSchemaJson !== 'string' ||
    !Array.isArray(contract.triggerSemantics) ||
    !Array.isArray(contract.requiredInputs) ||
    !Array.isArray(contract.optionalInputs) ||
    !Array.isArray(contract.preconditions) ||
    !Array.isArray(contract.resourceBindings) ||
    !Array.isArray(contract.steps) ||
    !Array.isArray(contract.allowedActions) ||
    !Array.isArray(contract.prohibitedActions) ||
    !Array.isArray(contract.approvalRequirements) ||
    !Array.isArray(contract.credentialRequirements) ||
    !Array.isArray(contract.successPostconditions) ||
    !Array.isArray(contract.verificationProcedure) ||
    !Array.isArray(contract.verifierBindingIds) ||
    !Array.isArray(contract.failureClassifications) ||
    !Array.isArray(contract.rollbackProcedure) ||
    !Array.isArray(contract.rollbackBindingIds) ||
    !Array.isArray(contract.deterministicScenarioIds) ||
    !Array.isArray(contract.heldOutScenarioIds) ||
    !Array.isArray(contract.revalidationRequirements) ||
    !Array.isArray(contract.provenanceRefs) ||
    !contract.compatibleResourceVersions ||
    typeof contract.compatibleResourceVersions !== 'object'
  ) {
    throw new Error(
      'Capability candidate contract is incomplete or malformed.',
    );
  }
  const inputSchema = parseCapabilityJson<unknown>(
    contract.inputSchemaJson,
    'contract.inputSchemaJson',
  );
  const outputSchema = parseCapabilityJson<unknown>(
    contract.outputSchemaJson,
    'contract.outputSchemaJson',
  );
  if (
    contract.successPostconditions.length < 1 ||
    contract.successPostconditions.length > 12 ||
    contract.successPostconditions.some(
      (postcondition) =>
        typeof postcondition !== 'string' || !postcondition.trim(),
    )
  ) {
    throw new Error(
      'Capability candidate success postconditions must be a bounded non-empty string set.',
    );
  }
  if (
    !inputSchema ||
    typeof inputSchema !== 'object' ||
    Array.isArray(inputSchema) ||
    !outputSchema ||
    typeof outputSchema !== 'object' ||
    Array.isArray(outputSchema)
  ) {
    throw new Error('Capability candidate schemas must be JSON objects.');
  }
  if (
    contract.resourceBindings.some(
      (binding) =>
        !binding ||
        typeof binding.resourceId !== 'string' ||
        !binding.resourceId ||
        typeof binding.version !== 'string' ||
        !binding.version ||
        ![
          'assistant_capability',
          'mission_node',
          'tool_schema',
          'execution_adapter',
          'patch_workbench',
        ].includes(binding.bindingKind),
    )
  ) {
    throw new Error(
      'Capability candidate contains an invalid resource binding.',
    );
  }
  if (
    contract.steps.some((step) => {
      if (
        !step ||
        typeof step.stepId !== 'string' ||
        !step.stepId ||
        typeof step.resourceId !== 'string' ||
        !step.resourceId ||
        typeof step.bindingId !== 'string' ||
        !step.bindingId ||
        typeof step.operationId !== 'string' ||
        !step.operationId ||
        typeof step.evaluatorId !== 'string' ||
        !step.evaluatorId ||
        typeof step.version !== 'string' ||
        !step.version ||
        typeof step.executorImplementationDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(step.executorImplementationDigest) ||
        typeof step.evaluatorImplementationDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(step.evaluatorImplementationDigest) ||
        typeof step.actionClass !== 'string' ||
        !step.actionClass ||
        !Array.isArray(step.expectedEvidence)
      ) {
        return true;
      }
      const policy = durableActionPolicy(step.actionClass);
      return (
        !policy ||
        (durableActionRequiresApproval(step.actionClass) &&
          !step.approvalRequired) ||
        (step.readOnly && !policy.allowedEffects.includes('read_only'))
      );
    })
  ) {
    throw new Error('Capability candidate contract contains an invalid step.');
  }
  const stepIds = contract.steps.map((step) => step.stepId);
  const bindingIds = contract.steps.map((step) => step.bindingId);
  if (
    new Set(stepIds).size !== stepIds.length ||
    new Set(bindingIds).size !== bindingIds.length
  ) {
    throw new Error(
      'Capability candidate step and binding identities must be unique.',
    );
  }
  const resourceIds = new Set(
    contract.resourceBindings.map((binding) => binding.resourceId),
  );
  const compatibleResourceVersions = contract.compatibleResourceVersions;
  if (
    contract.steps.some(
      (step) =>
        !resourceIds.has(step.resourceId) ||
        !compatibleResourceVersions[step.resourceId]?.length,
    )
  ) {
    throw new Error(
      'Capability candidate steps must reference a version-bound resource.',
    );
  }
  const expectedActions = [
    ...new Set(contract.steps.map((step) => step.actionClass)),
  ]
    .sort()
    .join('|');
  const declaredActions = [...new Set(contract.allowedActions)]
    .sort()
    .join('|');
  if (expectedActions !== declaredActions) {
    throw new Error(
      'Capability candidate allowed actions must match its bound steps.',
    );
  }
  const expectedVerifiers = contract.steps
    .map((step) => step.evaluatorId)
    .sort()
    .join('|');
  const declaredVerifiers = [...contract.verifierBindingIds].sort().join('|');
  if (expectedVerifiers !== declaredVerifiers) {
    throw new Error(
      'Capability candidate verifier bindings must match its steps.',
    );
  }
  for (const step of contract.steps) {
    if (
      durableActionRequiresApproval(step.actionClass) &&
      !contract.approvalRequirements.some((requirement) =>
        requirement.includes(step.actionClass),
      )
    ) {
      throw new Error(
        'Capability candidate omitted a required approval declaration.',
      );
    }
  }
  if (
    contract.credentialRequirements.some(
      (item) =>
        typeof item !== 'string' ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(item),
    )
  ) {
    throw new Error(
      'Capability candidate credential requirements may contain names only.',
    );
  }
  const fingerprint = capabilityCandidateFingerprint(
    contract as CapabilityCandidateContract,
  );
  if (fingerprint !== contract.candidateFingerprint) {
    throw new Error('Capability candidate fingerprint mismatch.');
  }
}

export function capabilityCandidateFingerprint(
  contract: CapabilityCandidateContract,
): string {
  const { candidateFingerprint: _ignored, ...fingerprinted } = contract;
  return createHash('sha256')
    .update(canonicalCapabilityJson(fingerprinted))
    .digest('hex');
}

export function assertCapabilityAcquisitionRecord(
  record: CapabilityAcquisitionRecord,
): void {
  if (!record.acquisitionId || !record.targetOutcome || !record.taskFamily) {
    throw new Error('Capability acquisition identity and target are required.');
  }
  if (!isCapabilityAcquisitionState(record.state)) {
    throw new Error('Capability acquisition has an unknown state.');
  }
  if (!['synthetic', 'replay', 'live'].includes(record.evidenceOrigin)) {
    throw new Error('Capability acquisition has an unknown evidence origin.');
  }
  if (!Number.isInteger(record.recordVersion) || record.recordVersion < 1) {
    throw new Error('Capability acquisition recordVersion must be positive.');
  }
  if (
    !Number.isFinite(record.confidence) ||
    record.confidence < 0 ||
    record.confidence > 1
  ) {
    throw new Error(
      'Capability acquisition confidence must be between zero and one.',
    );
  }
  if (
    !Number.isInteger(record.negativeOutcomeCount) ||
    record.negativeOutcomeCount < 0 ||
    !Number.isInteger(record.correctionCount) ||
    record.correctionCount < 0
  ) {
    throw new Error(
      'Capability acquisition outcome counters must be non-negative integers.',
    );
  }
  assertIso(record.createdAt, 'createdAt');
  assertIso(record.updatedAt, 'updatedAt');
  assertIso(record.expiresAt, 'expiresAt');
  assertIso(record.revalidateAfterAt, 'revalidateAfterAt');
  for (const field of JSON_FIELDS) {
    const value = record[field];
    if (typeof value !== 'string') {
      throw new Error(
        `Capability acquisition ${String(field)} must be JSON text.`,
      );
    }
    parseCapabilityJson(value, String(field));
  }
  const contract = parseCapabilityJson<unknown>(
    record.candidateContractJson,
    'candidateContractJson',
  );
  if (
    [
      'candidate_designed',
      'sandbox_ready',
      'sandbox_running',
      'sandbox_verified',
      'owner_review_required',
      'canary_ready',
      'active',
      'monitoring',
      'paused',
    ].includes(record.state)
  ) {
    assertCapabilityCandidateContract(contract);
  }
}

export function assertCapabilityAcquisitionTransition(params: {
  current: CapabilityAcquisitionRecord;
  next: CapabilityAcquisitionRecord;
  transition: CapabilityAcquisitionTransitionRecord;
  expectedState: CapabilityAcquisitionState;
}): void {
  const { current, next, transition, expectedState } = params;
  assertCapabilityAcquisitionRecord(current);
  if (!isCapabilityAcquisitionState(next.state)) {
    throw new Error('Capability acquisition has an unknown next state.');
  }
  if (!isLegalCapabilityAcquisitionTransition(expectedState, next.state)) {
    throw new Error(
      `Illegal capability acquisition transition: ${expectedState} -> ${next.state}.`,
    );
  }
  assertCapabilityAcquisitionRecord(next);
  if (
    current.acquisitionId !== next.acquisitionId ||
    transition.acquisitionId !== next.acquisitionId
  ) {
    throw new Error('Capability acquisition transition identity mismatch.');
  }
  if (
    current.state !== expectedState ||
    transition.fromState !== expectedState ||
    transition.toState !== next.state
  ) {
    throw new Error('Capability acquisition transition state mismatch.');
  }
  const immutablePairs: Array<[unknown, unknown, string]> = [
    [current.createdAt, next.createdAt, 'createdAt'],
    [current.groupFolder || null, next.groupFolder || null, 'groupFolder'],
    [current.targetOutcome, next.targetOutcome, 'targetOutcome'],
    [current.postconditionJson, next.postconditionJson, 'postconditionJson'],
    [current.taskFamily, next.taskFamily, 'taskFamily'],
  ];
  for (const [before, after, field] of immutablePairs) {
    if (before !== after) {
      throw new Error(`Capability acquisition ${field} is immutable.`);
    }
  }
  if (
    current.compiledSkillId &&
    current.compiledSkillId !== next.compiledSkillId
  ) {
    throw new Error(
      'Capability acquisition compiled skill identity is immutable.',
    );
  }
  if (current.candidateContractJson !== 'null') {
    const contractImmutablePairs: Array<[unknown, unknown, string]> = [
      [
        current.candidateContractJson,
        next.candidateContractJson,
        'candidateContractJson',
      ],
      [
        current.selectedResourceRefsJson,
        next.selectedResourceRefsJson,
        'selectedResourceRefsJson',
      ],
      [current.riskLevel, next.riskLevel, 'riskLevel'],
      [current.dataEgressClass, next.dataEgressClass, 'dataEgressClass'],
      [
        current.authorityRequirementsJson,
        next.authorityRequirementsJson,
        'authorityRequirementsJson',
      ],
    ];
    for (const [before, after, field] of contractImmutablePairs) {
      if (before !== after) {
        throw new Error(
          `Capability acquisition ${field} is immutable after compilation.`,
        );
      }
    }
  }
  if (
    next.negativeOutcomeCount < current.negativeOutcomeCount ||
    next.negativeOutcomeCount > current.negativeOutcomeCount + 1 ||
    next.correctionCount < current.correctionCount ||
    next.correctionCount > current.correctionCount + 1
  ) {
    throw new Error(
      'Capability acquisition outcome counters changed illegally.',
    );
  }
  const currentOutcomes = parseCapabilityJson<unknown[]>(
    current.outcomeIdsJson,
    'outcomeIdsJson',
  );
  const nextOutcomes = parseCapabilityJson<unknown[]>(
    next.outcomeIdsJson,
    'outcomeIdsJson',
  );
  if (
    !Array.isArray(currentOutcomes) ||
    !Array.isArray(nextOutcomes) ||
    currentOutcomes.some((item) => !nextOutcomes.includes(item))
  ) {
    throw new Error('Capability acquisition outcome links are append-only.');
  }
  if (current.evidenceOrigin === 'live' && next.evidenceOrigin !== 'live') {
    throw new Error(
      'Capability acquisition live evidence cannot be downgraded.',
    );
  }
  if (
    current.ownerReviewJson !== next.ownerReviewJson &&
    transition.actorKind !== 'owner' &&
    transition.actorKind !== 'operator'
  ) {
    throw new Error(
      'Capability acquisition owner review may only be changed by the owner or operator.',
    );
  }
  if (
    transition.expectedVersion !== current.recordVersion ||
    next.recordVersion !== current.recordVersion + 1 ||
    transition.resultingVersion !== next.recordVersion
  ) {
    throw new Error('Capability acquisition transition version mismatch.');
  }
  const evidence = parseCapabilityJson<unknown[]>(
    transition.evidenceRefsJson,
    'transition.evidenceRefsJson',
  );
  if (!Array.isArray(evidence)) {
    throw new Error(
      'Capability acquisition transition evidence must be an array.',
    );
  }
  const expectedSnapshot = capabilityAcquisitionSnapshotJson(next);
  if (transition.resultingSnapshotJson !== expectedSnapshot) {
    throw new Error('Capability acquisition transition snapshot mismatch.');
  }
  const expectedDigest = capabilityTransitionDigest({
    acquisitionId: transition.acquisitionId,
    fromState: transition.fromState,
    toState: transition.toState,
    expectedVersion: transition.expectedVersion,
    resultingVersion: transition.resultingVersion,
    actorKind: transition.actorKind,
    reason: transition.reason,
    evidenceRefsJson: transition.evidenceRefsJson,
    idempotencyKey: transition.idempotencyKey,
    resultingSnapshotJson: transition.resultingSnapshotJson,
  });
  if (transition.transitionDigest !== expectedDigest) {
    throw new Error('Capability acquisition transition digest mismatch.');
  }
  assertCapabilityTransitionEvidenceGates({ current, next, transition });
}

function parseObjectField(
  value: string,
  field: string,
): Record<string, unknown> {
  const parsed = parseCapabilityJson<unknown>(value, field);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Capability acquisition ${field} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function assertCapabilityTransitionEvidenceGates(params: {
  current: CapabilityAcquisitionRecord;
  next: CapabilityAcquisitionRecord;
  transition: CapabilityAcquisitionTransitionRecord;
}): void {
  const { current, next, transition } = params;
  const missing = parseCapabilityJson<unknown[]>(
    next.missingPrerequisitesJson,
    'missingPrerequisitesJson',
  );
  const selected = parseCapabilityJson<unknown[]>(
    next.selectedResourceRefsJson,
    'selectedResourceRefsJson',
  );
  if (!Array.isArray(missing) || !Array.isArray(selected)) {
    throw new Error(
      'Capability acquisition prerequisite/resource refs must be arrays.',
    );
  }
  if (next.state === 'sandbox_verified') {
    const evidence = parseObjectField(
      next.sandboxEvidenceJson,
      'sandboxEvidenceJson',
    );
    if (
      evidence.verified !== true ||
      evidence.postconditionVerified !== true ||
      evidence.cleanupVerified !== true ||
      evidence.networkDenied !== true ||
      Number(evidence.unauthorizedEffects) !== 0 ||
      Number(evidence.duplicateEffects) !== 0 ||
      Number(evidence.falseSuccesses) !== 0 ||
      !Array.isArray(evidence.verificationReceiptIds) ||
      evidence.verificationReceiptIds.length === 0
    ) {
      throw new Error('Sandbox verification evidence is incomplete.');
    }
  }
  if (next.state === 'canary_ready' || next.state === 'active') {
    const sandbox = parseObjectField(
      next.sandboxEvidenceJson,
      'sandboxEvidenceJson',
    );
    const heldOut = parseObjectField(
      next.heldOutEvidenceJson,
      'heldOutEvidenceJson',
    );
    if (
      sandbox.verified !== true ||
      sandbox.postconditionVerified !== true ||
      heldOut.passed !== true ||
      Number(heldOut.safetyInvariantRate) !== 1 ||
      Number(heldOut.falseSuccesses) !== 0 ||
      missing.length > 0 ||
      selected.length === 0
    ) {
      throw new Error('Capability acquisition canary evidence is incomplete.');
    }
  }
  if (next.state === 'active') {
    const review = parseObjectField(next.ownerReviewJson, 'ownerReviewJson');
    const sandbox = parseObjectField(
      next.sandboxEvidenceJson,
      'sandboxEvidenceJson',
    );
    const outcomes = parseCapabilityJson<unknown[]>(
      next.outcomeIdsJson,
      'outcomeIdsJson',
    );
    if (
      next.evidenceOrigin !== 'live' ||
      transition.actorKind !== 'owner' ||
      review.approved !== true ||
      review.ownerVerified !== true ||
      typeof review.reviewId !== 'string' ||
      !review.reviewId ||
      sandbox.liveCanaryVerified !== true ||
      sandbox.freshDependencyHealth !== true ||
      !Array.isArray(outcomes) ||
      outcomes.length === 0 ||
      next.lastOutcome !== 'verified'
    ) {
      throw new Error(
        'Activation requires a live verified canary, fresh health, an outcome, and exact owner review.',
      );
    }
  }
  if (
    (current.state === 'failed' ||
      current.state === 'externally_blocked' ||
      current.state === 'indeterminate') &&
    (next.state === 'scoped' ||
      next.state === 'resource_discovery' ||
      next.state === 'sandbox_ready') &&
    current.environmentFingerprint === next.environmentFingerprint &&
    current.missingPrerequisitesJson === next.missingPrerequisitesJson
  ) {
    throw new Error(
      'A blocked or indeterminate acquisition may retry only after evidence or environment changes.',
    );
  }
}
