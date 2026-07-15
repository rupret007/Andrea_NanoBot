import { createHash } from 'node:crypto';

import { durableActionPolicy } from './durable-action-policy.js';
import type { DurablePolicyEffectClass } from './durable-action-policy.js';
import type {
  CapabilityCandidateContract,
  CapabilityDataEgressClass,
  CapabilityResourceDescriptor,
} from './types.js';

export type CapabilityExecutionGuardFailureCode =
  | 'malformed_input_schema'
  | 'invalid_input'
  | 'malformed_resource_descriptor'
  | 'resource_set_mismatch'
  | 'resource_descriptor_drift'
  | 'resource_version_drift'
  | 'malformed_health_evidence'
  | 'resource_health_unavailable'
  | 'resource_health_stale'
  | 'resource_health_future'
  | 'resource_health_expired'
  | 'malformed_output_schema'
  | 'invalid_binding_result'
  | 'effect_policy_mismatch'
  | 'invalid_verification'
  | 'egress_policy_mismatch'
  | 'network_policy_denied';

export type CapabilityExecutionGuardResult =
  | { ok: true }
  | {
      ok: false;
      code: CapabilityExecutionGuardFailureCode;
      reason: string;
    };

export interface SelectedCapabilityResourceFingerprint {
  resourceId: string;
  version: string;
  descriptorDigest: string;
}

export interface CapabilityResourceHealthEvidence {
  resourceId: string;
  descriptorDigest: string;
  healthState: CapabilityResourceDescriptor['healthState'];
  observedAt: string;
  expiresAt: string;
  maxAgeMs: number;
}

export type CapabilityNetworkAccess = 'none' | 'loopback' | 'external';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_HEALTH_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000;
const NETWORK_ORDER: Readonly<Record<CapabilityNetworkAccess, number>> = {
  none: 0,
  loopback: 1,
  external: 2,
};
const EGRESS_NETWORK_CEILING: Readonly<
  Record<CapabilityDataEgressClass, CapabilityNetworkAccess>
> = {
  none: 'none',
  local_only: 'loopback',
  sanitized_metadata: 'external',
  approved_content: 'external',
  prohibited: 'none',
};

function pass(): CapabilityExecutionGuardResult {
  return { ok: true };
}

function fail(
  code: CapabilityExecutionGuardFailureCode,
  reason: string,
): CapabilityExecutionGuardResult {
  return { ok: false, code, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasUniqueNonEmptyStrings(value: unknown): value is string[] {
  return (
    isStringArray(value) &&
    value.every(Boolean) &&
    new Set(value).size === value.length
  );
}

type ConstrainedPropertyType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

interface ConstrainedInputSchema {
  type: 'object';
  required: string[];
  properties: Record<string, { type: ConstrainedPropertyType }>;
  additionalProperties: boolean;
}

interface ConstrainedOutputSchema {
  type: 'object';
  required: ['result', 'evidenceRefs'];
  additionalProperties: boolean;
}

const PROPERTY_TYPES = new Set<ConstrainedPropertyType>([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

function parseConstrainedInputSchema(
  contract: CapabilityCandidateContract,
): ConstrainedInputSchema | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.inputSchemaJson);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactKeys(parsed, [
      'type',
      'required',
      'properties',
      'additionalProperties',
    ]) ||
    parsed.type !== 'object' ||
    !hasUniqueNonEmptyStrings(parsed.required) ||
    !isPlainObject(parsed.properties) ||
    typeof parsed.additionalProperties !== 'boolean'
  ) {
    return null;
  }
  const properties: Record<string, { type: ConstrainedPropertyType }> =
    Object.create(null) as Record<string, { type: ConstrainedPropertyType }>;
  for (const [name, property] of Object.entries(parsed.properties)) {
    if (
      !name ||
      !isPlainObject(property) ||
      !hasExactKeys(property, ['type']) ||
      typeof property.type !== 'string' ||
      !PROPERTY_TYPES.has(property.type as ConstrainedPropertyType)
    ) {
      return null;
    }
    properties[name] = { type: property.type as ConstrainedPropertyType };
  }
  if (
    !Array.isArray(contract.requiredInputs) ||
    !Array.isArray(contract.optionalInputs)
  ) {
    return null;
  }
  const propertyNames = Object.keys(properties);
  const declaredInputs = [
    ...contract.requiredInputs,
    ...contract.optionalInputs,
  ];
  if (
    !hasUniqueNonEmptyStrings(contract.requiredInputs) ||
    !hasUniqueNonEmptyStrings(contract.optionalInputs) ||
    new Set(declaredInputs).size !== declaredInputs.length ||
    parsed.required.length !== contract.requiredInputs.length ||
    !parsed.required.every((name) => contract.requiredInputs.includes(name)) ||
    propertyNames.length !== declaredInputs.length ||
    !propertyNames.every((name) => declaredInputs.includes(name))
  ) {
    return null;
  }
  return {
    type: 'object',
    required: parsed.required,
    properties,
    additionalProperties: parsed.additionalProperties,
  };
}

function valueMatchesType(
  value: unknown,
  type: ConstrainedPropertyType,
): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return isFiniteNumber(value);
    case 'integer':
      return isFiniteNumber(value) && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
  }
}

export function validateCapabilityCandidateInput(
  contract: CapabilityCandidateContract,
  value: unknown,
): CapabilityExecutionGuardResult {
  const schema = parseConstrainedInputSchema(contract);
  if (!schema) {
    return fail(
      'malformed_input_schema',
      'The candidate input schema is malformed, unsupported, or inconsistent with its declared inputs.',
    );
  }
  if (!isPlainObject(value)) {
    return fail('invalid_input', 'Capability input must be a plain object.');
  }
  for (const required of schema.required) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      return fail('invalid_input', 'A required capability input is missing.');
    }
  }
  for (const [name, input] of Object.entries(value)) {
    const property = schema.properties[name];
    if (!property) {
      if (!schema.additionalProperties) {
        return fail(
          'invalid_input',
          'Capability input contains an undeclared property.',
        );
      }
      continue;
    }
    if (!valueMatchesType(input, property.type)) {
      return fail(
        'invalid_input',
        'Capability input does not match its declared property type.',
      );
    }
  }
  return pass();
}

function parseConstrainedOutputSchema(
  contract: CapabilityCandidateContract,
): ConstrainedOutputSchema | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contract.outputSchemaJson);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    !isPlainObject(parsed) ||
    !hasExactKeys(parsed, ['type', 'required', 'additionalProperties']) ||
    parsed.type !== 'object' ||
    !Array.isArray(parsed.required) ||
    parsed.required.length !== 2 ||
    !parsed.required.includes('result') ||
    !parsed.required.includes('evidenceRefs') ||
    typeof parsed.additionalProperties !== 'boolean'
  ) {
    return null;
  }
  return {
    type: 'object',
    required: ['result', 'evidenceRefs'],
    additionalProperties: parsed.additionalProperties,
  };
}

const BINDING_RESULT_KEYS = [
  'result',
  'evidenceRefs',
  'effectClass',
  'effectStatus',
  'preStateFingerprint',
  'postStateFingerprint',
  'providerCalls',
  'costUsd',
] as const;

function isBoundedEvidenceRefs(value: unknown): value is string[] {
  return (
    hasUniqueNonEmptyStrings(value) &&
    value.length <= 100 &&
    value.every((item) => item.length <= 500)
  );
}

function isBoundedFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}

export function validateCapabilityBindingResult(params: {
  contract: CapabilityCandidateContract;
  declaredEffectClass: DurablePolicyEffectClass;
  value: unknown;
}): CapabilityExecutionGuardResult {
  const schema = parseConstrainedOutputSchema(params.contract);
  if (!schema) {
    return fail(
      'malformed_output_schema',
      'The candidate output schema is malformed or unsupported.',
    );
  }
  if (
    !isPlainObject(params.value) ||
    !hasExactKeys(params.value, BINDING_RESULT_KEYS) ||
    !Object.prototype.hasOwnProperty.call(params.value, 'result') ||
    !isBoundedEvidenceRefs(params.value.evidenceRefs) ||
    params.value.effectStatus !== 'certain' ||
    !isBoundedFingerprint(params.value.postStateFingerprint) ||
    (params.value.preStateFingerprint !== undefined &&
      !isBoundedFingerprint(params.value.preStateFingerprint)) ||
    (params.value.providerCalls !== undefined &&
      (!isFiniteNumber(params.value.providerCalls) ||
        params.value.providerCalls < 0 ||
        !Number.isInteger(params.value.providerCalls))) ||
    (params.value.costUsd !== undefined &&
      (!isFiniteNumber(params.value.costUsd) || params.value.costUsd < 0))
  ) {
    return fail(
      'invalid_binding_result',
      'The executor result is incomplete, uncertain, or malformed.',
    );
  }
  try {
    canonicalJson(params.value.result);
  } catch {
    return fail(
      'invalid_binding_result',
      'The executor result is not bounded canonical JSON.',
    );
  }
  if (params.value.effectClass !== params.declaredEffectClass) {
    return fail(
      'effect_policy_mismatch',
      'The executor result effect class differs from its registered declaration.',
    );
  }
  return pass();
}

export function validateCapabilityVerificationResult(params: {
  expectedEvidence: readonly string[];
  value: unknown;
}): CapabilityExecutionGuardResult {
  if (
    !params.expectedEvidence.length ||
    !params.expectedEvidence.every(
      (item) => typeof item === 'string' && item.length > 0,
    ) ||
    !isPlainObject(params.value) ||
    !hasExactKeys(params.value, [
      'verified',
      'evidenceRefs',
      'verifiedPostconditions',
      'postconditionFingerprint',
      'reason',
    ]) ||
    typeof params.value.verified !== 'boolean' ||
    !isBoundedEvidenceRefs(params.value.evidenceRefs) ||
    !hasUniqueNonEmptyStrings(params.value.verifiedPostconditions) ||
    params.value.verifiedPostconditions.length > 100 ||
    params.value.verifiedPostconditions.some((item) => item.length > 500) ||
    typeof params.value.reason !== 'string' ||
    !params.value.reason.trim() ||
    params.value.reason.length > 900 ||
    (params.value.verified &&
      !isBoundedFingerprint(params.value.postconditionFingerprint)) ||
    (!params.value.verified &&
      params.value.postconditionFingerprint !== undefined)
  ) {
    return fail(
      'invalid_verification',
      'The independent evaluator result is malformed or lacks exact evidence.',
    );
  }
  const expected = new Set(params.expectedEvidence);
  const verified = new Set(params.value.verifiedPostconditions);
  if (
    (params.value.verified &&
      (expected.size !== verified.size ||
        [...expected].some((item) => !verified.has(item)))) ||
    (!params.value.verified && verified.size > 0)
  ) {
    return fail(
      'invalid_verification',
      'The evaluator did not prove the exact step-scoped postconditions.',
    );
  }
  return pass();
}

function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const visit = (input: unknown): unknown => {
    if (
      input === null ||
      typeof input === 'string' ||
      typeof input === 'boolean'
    ) {
      return input;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Non-finite number.');
      return input;
    }
    if (Array.isArray(input)) {
      if (active.has(input)) throw new Error('Cyclic array.');
      active.add(input);
      const output = input.map(visit);
      active.delete(input);
      return output;
    }
    if (!isPlainObject(input)) throw new Error('Unsupported JSON value.');
    if (active.has(input)) throw new Error('Cyclic object.');
    active.add(input);
    const output = Object.fromEntries(
      Object.keys(input)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, visit(input[key])]),
    );
    active.delete(input);
    return output;
  };
  return JSON.stringify(visit(value));
}

const DESCRIPTOR_KEYS = [
  'resourceId',
  'kind',
  'displayName',
  'taskFamilies',
  'capabilityIds',
  'supportedPostconditions',
  'requiredInputs',
  'available',
  'healthState',
  'verificationStrength',
  'reliabilityScore',
  'authorityRequirement',
  'riskLevel',
  'dataEgressClass',
  'reversible',
  'expectedCostBand',
  'expectedLatencyBand',
  'version',
  'sourceRefs',
  'maintenanceBurden',
  'bindingRefs',
] as const;

const BINDING_KEYS = [
  'bindingId',
  'operationId',
  'evaluatorId',
  'executorImplementationDigest',
  'evaluatorImplementationDigest',
  'actionClass',
  'version',
  'readOnly',
] as const;

const RESOURCE_KINDS = new Set<CapabilityResourceDescriptor['kind']>([
  'assistant_capability',
  'skill_playbook',
  'agent_os_tool',
  'mission_node',
  'openclaw_tool',
  'local_script',
  'trusted_documentation',
  'knowledge_source',
  'provider',
  'container',
  'code_lane',
  'patch_workbench',
]);

function isValidDescriptor(
  value: unknown,
): value is CapabilityResourceDescriptor {
  if (!isPlainObject(value) || !hasExactKeys(value, DESCRIPTOR_KEYS))
    return false;
  if (
    typeof value.resourceId !== 'string' ||
    !value.resourceId ||
    typeof value.kind !== 'string' ||
    !RESOURCE_KINDS.has(value.kind as CapabilityResourceDescriptor['kind']) ||
    typeof value.displayName !== 'string' ||
    !value.displayName ||
    !isStringArray(value.taskFamilies) ||
    !isStringArray(value.capabilityIds) ||
    !isStringArray(value.supportedPostconditions) ||
    !isStringArray(value.requiredInputs) ||
    typeof value.available !== 'boolean' ||
    !['healthy', 'degraded', 'blocked', 'unknown'].includes(
      String(value.healthState),
    ) ||
    !isFiniteNumber(value.verificationStrength) ||
    value.verificationStrength < 0 ||
    value.verificationStrength > 1 ||
    !isFiniteNumber(value.reliabilityScore) ||
    value.reliabilityScore < 0 ||
    value.reliabilityScore > 1 ||
    !['none', 'explicit_approval', 'operator_context'].includes(
      String(value.authorityRequirement),
    ) ||
    !['low', 'medium', 'high', 'critical'].includes(String(value.riskLevel)) ||
    !Object.prototype.hasOwnProperty.call(
      EGRESS_NETWORK_CEILING,
      String(value.dataEgressClass),
    ) ||
    typeof value.reversible !== 'boolean' ||
    !['zero', 'low', 'medium', 'high', 'unknown'].includes(
      String(value.expectedCostBand),
    ) ||
    ![
      'instant',
      'interactive',
      'background',
      'long_running',
      'unknown',
    ].includes(String(value.expectedLatencyBand)) ||
    typeof value.version !== 'string' ||
    !value.version ||
    !isStringArray(value.sourceRefs) ||
    !['low', 'medium', 'high'].includes(String(value.maintenanceBurden)) ||
    !Array.isArray(value.bindingRefs)
  ) {
    return false;
  }
  const bindingIdentities = new Set<string>();
  for (const candidate of value.bindingRefs) {
    if (
      !isPlainObject(candidate) ||
      !hasExactKeys(candidate, BINDING_KEYS) ||
      typeof candidate.bindingId !== 'string' ||
      !candidate.bindingId ||
      typeof candidate.operationId !== 'string' ||
      !candidate.operationId ||
      typeof candidate.evaluatorId !== 'string' ||
      !candidate.evaluatorId ||
      typeof candidate.executorImplementationDigest !== 'string' ||
      !DIGEST_PATTERN.test(candidate.executorImplementationDigest) ||
      typeof candidate.evaluatorImplementationDigest !== 'string' ||
      !DIGEST_PATTERN.test(candidate.evaluatorImplementationDigest) ||
      typeof candidate.actionClass !== 'string' ||
      !durableActionPolicy(candidate.actionClass) ||
      typeof candidate.version !== 'string' ||
      !candidate.version ||
      typeof candidate.readOnly !== 'boolean'
    ) {
      return false;
    }
    const identity = `${candidate.bindingId}\u0000${candidate.operationId}\u0000${candidate.evaluatorId}`;
    if (bindingIdentities.has(identity)) return false;
    bindingIdentities.add(identity);
  }
  return true;
}

export function capabilityResourceDescriptorDigest(
  descriptor: CapabilityResourceDescriptor,
): string {
  if (!isValidDescriptor(descriptor)) {
    throw new Error('Capability resource descriptor is malformed.');
  }
  return createHash('sha256').update(canonicalJson(descriptor)).digest('hex');
}

export function capabilityBindingImplementationDigest(input: {
  kind: 'executor' | 'evaluator';
  implementationId: string;
  version: string;
}): string {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ['kind', 'implementationId', 'version']) ||
    (input.kind !== 'executor' && input.kind !== 'evaluator') ||
    !input.implementationId ||
    input.implementationId.length > 500 ||
    !input.version ||
    input.version.length > 180
  ) {
    throw new Error('Capability binding implementation identity is malformed.');
  }
  return createHash('sha256')
    .update(
      canonicalJson({
        domain: 'andrea-capability-binding-implementation-v1',
        implementationId: input.implementationId,
        kind: input.kind,
        version: input.version,
      }),
    )
    .digest('hex');
}

function validateSelectedFingerprints(
  selected: readonly SelectedCapabilityResourceFingerprint[],
): boolean {
  return (
    selected.length > 0 &&
    selected.every(
      (item) =>
        isPlainObject(item) &&
        hasExactKeys(item, ['resourceId', 'version', 'descriptorDigest']) &&
        typeof item.resourceId === 'string' &&
        Boolean(item.resourceId) &&
        typeof item.version === 'string' &&
        Boolean(item.version) &&
        typeof item.descriptorDigest === 'string' &&
        DIGEST_PATTERN.test(item.descriptorDigest),
    ) &&
    new Set(selected.map((item) => item.resourceId)).size === selected.length
  );
}

export function validateCapabilityResourceDescriptors(params: {
  contract: CapabilityCandidateContract;
  selected: readonly SelectedCapabilityResourceFingerprint[];
  currentResources: readonly CapabilityResourceDescriptor[];
}): CapabilityExecutionGuardResult {
  if (!validateSelectedFingerprints(params.selected)) {
    return fail(
      'malformed_resource_descriptor',
      'Selected resource fingerprints are malformed or ambiguous.',
    );
  }
  if (
    !Array.isArray(params.contract.resourceBindings) ||
    !isPlainObject(params.contract.compatibleResourceVersions) ||
    params.contract.resourceBindings.length !== params.selected.length ||
    params.currentResources.length !== params.selected.length
  ) {
    return fail(
      'resource_set_mismatch',
      'The current, selected, and contracted resource sets differ.',
    );
  }
  for (const binding of params.contract.resourceBindings) {
    if (
      !isPlainObject(binding) ||
      !hasExactKeys(binding, [
        'resourceId',
        'bindingKind',
        'version',
        'required',
      ]) ||
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
      ].includes(String(binding.bindingKind)) ||
      typeof binding.required !== 'boolean' ||
      !binding.required
    ) {
      return fail(
        'resource_set_mismatch',
        'The contracted resource set is malformed or optional at execution time.',
      );
    }
  }
  if (!params.currentResources.every(isValidDescriptor)) {
    return fail(
      'malformed_resource_descriptor',
      'A current resource descriptor is malformed.',
    );
  }
  const contracted = new Map(
    params.contract.resourceBindings.map((binding) => [
      binding.resourceId,
      binding,
    ]),
  );
  const current = new Map(
    params.currentResources.map((resource) => [resource.resourceId, resource]),
  );
  if (
    contracted.size !== params.contract.resourceBindings.length ||
    current.size !== params.currentResources.length
  ) {
    return fail('resource_set_mismatch', 'Resource identities must be unique.');
  }
  for (const selected of params.selected) {
    const binding = contracted.get(selected.resourceId);
    const descriptor = current.get(selected.resourceId);
    if (!binding || !descriptor) {
      return fail(
        'resource_set_mismatch',
        'A selected resource is missing from the contract or current inventory.',
      );
    }
    if (!isValidDescriptor(descriptor)) {
      return fail(
        'malformed_resource_descriptor',
        'A current resource descriptor is malformed.',
      );
    }
    const currentDigest = capabilityResourceDescriptorDigest(descriptor);
    if (currentDigest !== selected.descriptorDigest) {
      return fail(
        'resource_descriptor_drift',
        'A current resource descriptor differs from the exact selected descriptor.',
      );
    }
    const compatible =
      params.contract.compatibleResourceVersions[selected.resourceId];
    if (
      binding.version !== selected.version ||
      descriptor.version !== selected.version ||
      !Array.isArray(compatible) ||
      !compatible.includes(selected.version)
    ) {
      return fail(
        'resource_version_drift',
        'A resource version differs from the selected and compatible contract versions.',
      );
    }
  }
  for (const step of params.contract.steps) {
    if (
      !isPlainObject(step) ||
      typeof step.resourceId !== 'string' ||
      typeof step.bindingId !== 'string' ||
      typeof step.operationId !== 'string' ||
      typeof step.evaluatorId !== 'string' ||
      typeof step.version !== 'string' ||
      !DIGEST_PATTERN.test(String(step.executorImplementationDigest)) ||
      !DIGEST_PATTERN.test(String(step.evaluatorImplementationDigest))
    ) {
      return fail(
        'malformed_resource_descriptor',
        'A contracted execution binding has malformed implementation identity.',
      );
    }
    const descriptor = current.get(step.resourceId);
    const descriptorBinding = descriptor?.bindingRefs.find(
      (candidate) => candidate.bindingId === step.bindingId,
    );
    if (
      !descriptorBinding ||
      descriptorBinding.operationId !== step.operationId ||
      descriptorBinding.evaluatorId !== step.evaluatorId ||
      descriptorBinding.version !== step.version ||
      descriptorBinding.executorImplementationDigest !==
        step.executorImplementationDigest ||
      descriptorBinding.evaluatorImplementationDigest !==
        step.evaluatorImplementationDigest
    ) {
      return fail(
        'resource_descriptor_drift',
        'A contracted execution binding differs from the selected implementation identity.',
      );
    }
  }
  return pass();
}

function parseExactTimestamp(value: unknown): number | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateCapabilityResourceHealth(params: {
  selected: readonly SelectedCapabilityResourceFingerprint[];
  evidence: readonly CapabilityResourceHealthEvidence[];
  now: Date;
}): CapabilityExecutionGuardResult {
  if (
    !validateSelectedFingerprints(params.selected) ||
    !(params.now instanceof Date) ||
    !Number.isFinite(params.now.getTime()) ||
    params.evidence.length !== params.selected.length
  ) {
    return fail(
      'malformed_health_evidence',
      'Health validation inputs are malformed or incomplete.',
    );
  }
  if (
    params.evidence.some(
      (item) => !isPlainObject(item) || typeof item.resourceId !== 'string',
    )
  ) {
    return fail(
      'malformed_health_evidence',
      'Health evidence entries must be typed objects.',
    );
  }
  const evidenceByResource = new Map(
    params.evidence.map((item) => [item.resourceId, item]),
  );
  if (evidenceByResource.size !== params.evidence.length) {
    return fail(
      'malformed_health_evidence',
      'Health evidence identities must be unique.',
    );
  }
  const nowMs = params.now.getTime();
  for (const selected of params.selected) {
    const evidence = evidenceByResource.get(selected.resourceId);
    if (
      !evidence ||
      !isPlainObject(evidence) ||
      !hasExactKeys(evidence, [
        'resourceId',
        'descriptorDigest',
        'healthState',
        'observedAt',
        'expiresAt',
        'maxAgeMs',
      ]) ||
      evidence.descriptorDigest !== selected.descriptorDigest ||
      typeof evidence.maxAgeMs !== 'number' ||
      !Number.isSafeInteger(evidence.maxAgeMs) ||
      evidence.maxAgeMs <= 0 ||
      evidence.maxAgeMs > MAX_HEALTH_EVIDENCE_AGE_MS
    ) {
      return fail(
        'malformed_health_evidence',
        'Health evidence is malformed or is not bound to the selected descriptor.',
      );
    }
    if (evidence.healthState !== 'healthy') {
      return fail(
        'resource_health_unavailable',
        'Selected resource health is not healthy.',
      );
    }
    const observedAt = parseExactTimestamp(evidence.observedAt);
    const expiresAt = parseExactTimestamp(evidence.expiresAt);
    if (observedAt === null || expiresAt === null || expiresAt <= observedAt) {
      return fail(
        'malformed_health_evidence',
        'Health evidence timestamps are malformed or inconsistent.',
      );
    }
    if (observedAt > nowMs) {
      return fail(
        'resource_health_future',
        'Health evidence was observed in the future.',
      );
    }
    if (expiresAt <= nowMs) {
      return fail('resource_health_expired', 'Health evidence has expired.');
    }
    if (nowMs - observedAt > evidence.maxAgeMs) {
      return fail(
        'resource_health_stale',
        'Health evidence exceeds its maximum accepted age.',
      );
    }
  }
  return pass();
}

export function networkCeilingForCapabilityEgress(
  dataEgressClass: CapabilityDataEgressClass,
): CapabilityNetworkAccess | null {
  return EGRESS_NETWORK_CEILING[dataEgressClass] ?? null;
}

export function validateCapabilityNetworkCeiling(params: {
  contractDataEgressClass: CapabilityDataEgressClass;
  acquisitionDataEgressClass: CapabilityDataEgressClass;
  requestedNetworkAccess: CapabilityNetworkAccess;
}): CapabilityExecutionGuardResult {
  const contractCeiling = networkCeilingForCapabilityEgress(
    params.contractDataEgressClass,
  );
  const acquisitionCeiling = networkCeilingForCapabilityEgress(
    params.acquisitionDataEgressClass,
  );
  if (
    !contractCeiling ||
    !acquisitionCeiling ||
    !Object.prototype.hasOwnProperty.call(
      NETWORK_ORDER,
      params.requestedNetworkAccess,
    )
  ) {
    return fail('network_policy_denied', 'Network policy input is unknown.');
  }
  if (params.contractDataEgressClass !== params.acquisitionDataEgressClass) {
    return fail(
      'egress_policy_mismatch',
      'The candidate and acquisition data-egress policies differ.',
    );
  }
  if (
    NETWORK_ORDER[params.requestedNetworkAccess] >
    NETWORK_ORDER[contractCeiling]
  ) {
    return fail(
      'network_policy_denied',
      'Requested network access exceeds the capability data-egress ceiling.',
    );
  }
  return pass();
}
