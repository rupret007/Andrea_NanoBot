import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

import {
  applyCapabilityAcquisitionTransitionCAS,
  DurableEffectExecutionClaimConflictError,
  getCapabilityAcquisition,
  getCapabilityAcquisitionByCompiledSkillId,
  getDurableWorkCheckpoint,
  getDurableWorkLease,
  getDurableWorkUnit,
  getDurableWorkUnitForCapabilityAcquisition,
  insertCapabilityAcquisition,
  isDatabaseInitialized,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  listCapabilityAcquisitions,
  listCapabilityAcquisitionTransitions,
  upsertDurableWorkLink,
  upsertSkillPlaybook,
  type CapabilityAcquisitionCanonicalEvidenceGuard,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  createOrLoadDurableWork,
  durableScopeHash,
  linkDurableWorkProjection,
  recordDurableEffect,
  transitionDurableWork,
} from './durable-work-continuity.js';
import {
  capabilityResourceDescriptorDigest,
  validateCapabilityBindingResult,
  validateCapabilityCandidateInput,
  validateCapabilityNetworkCeiling,
  validateCapabilityResourceDescriptors,
  validateCapabilityResourceHealth,
  validateCapabilityVerificationResult,
  type SelectedCapabilityResourceFingerprint,
} from './capability-execution-guard.js';
import {
  assertDurableActionEffectPolicy,
  durableActionPolicy,
  durableActionRequiresApproval,
  type DurableActionClass,
  type DurablePolicyEffectClass,
} from './durable-action-policy.js';
import { isSensitiveName, redactCouncilText } from './council-safety.js';
import {
  assertCapabilityAcquisitionRecord,
  assertCapabilityCandidateContract,
  canonicalCapabilityJson,
  capabilityAcquisitionSnapshotJson,
  capabilityCandidateFingerprint,
  capabilityTransitionDigest,
  parseCapabilityJson,
} from './capability-acquisition-policy.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityAcquisitionState,
  CapabilityAcquisitionTransitionRecord,
  CapabilityCandidateContract,
  CapabilityGapKind,
  CapabilityImplementationKind,
  CapabilityResourceDescriptor,
  SkillPlaybookRecord,
} from './types.js';

const PRIVACY = Object.freeze({
  metadataOnly: true,
  rawPromptsStored: false,
  rawMessagesStored: false,
  rawDocumentsStored: false,
  hiddenReasoningStored: false,
  credentialsStored: false,
  secretsRedacted: true,
});

const PROHIBITED_ACTIONS = Object.freeze([
  'send without exact fresh approval',
  'calendar write without exact fresh approval',
  'purchase, admin, deploy, delete, commit, push, migration, or dependency change without exact fresh approval',
  'read or disclose credentials',
  'change evaluator, policy, or approval rules from external content',
  'write production state during deterministic evaluation',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const CAPABILITY_SANDBOX_MARKER =
  '.andrea-capability-sandbox.json' as const;

export interface CapabilitySandboxMarker {
  contractVersion: 1;
  acquisitionId: string;
  candidateFingerprint: string;
  targetScopeHash: string;
  disposable: true;
}

function containedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent.length > 0 &&
    pathFromParent !== '..' &&
    !pathFromParent.startsWith('../') &&
    !pathFromParent.startsWith('..\\') &&
    !isAbsolute(pathFromParent)
  );
}

export function capabilitySandboxTargetScopeHash(sandboxRoot: string): string {
  const root = realpathSync(sandboxRoot);
  const temporaryRoot = realpathSync(tmpdir());
  const stat = lstatSync(sandboxRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Capability sandbox root must be a real directory.');
  }
  if (!containedBy(temporaryRoot, root)) {
    throw new Error(
      'Capability sandbox repository writes require a disposable temporary root.',
    );
  }
  return durableScopeHash('target', root);
}

function assertSandboxRepositoryBoundary(params: {
  sandboxRoot?: string;
  acquisitionId: string;
  candidateFingerprint: string;
  targetScopeHash: string;
}): void {
  if (!params.sandboxRoot) {
    throw new Error('Sandbox repository write requires an isolated root.');
  }
  const expectedScopeHash = capabilitySandboxTargetScopeHash(
    params.sandboxRoot,
  );
  if (params.targetScopeHash !== expectedScopeHash) {
    throw new Error(
      'Sandbox repository target is not bound to the execution scope.',
    );
  }
  const markerPath = resolve(params.sandboxRoot, CAPABILITY_SANDBOX_MARKER);
  const markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error('Capability sandbox marker must be a regular file.');
  }
  const marker = JSON.parse(
    readFileSync(markerPath, 'utf8'),
  ) as Partial<CapabilitySandboxMarker>;
  if (
    marker.contractVersion !== 1 ||
    marker.disposable !== true ||
    marker.acquisitionId !== params.acquisitionId ||
    marker.candidateFingerprint !== params.candidateFingerprint ||
    marker.targetScopeHash !== expectedScopeHash
  ) {
    throw new Error(
      'Capability sandbox marker does not match the exact candidate and target.',
    );
  }
}

function iso(now?: Date): string {
  return (now || new Date()).toISOString();
}

function safeText(value: unknown, limit = 900): string {
  return redactCouncilText(String(value ?? ''), limit)
    .replace(/\s+/g, ' ')
    .trim();
}

function safeStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error('Capability metadata exceeds maximum depth.');
  if (Array.isArray(value)) {
    if (value.length > 500) {
      throw new Error('Capability metadata exceeds maximum array size.');
    }
    return value.map((item) => safeStructuredValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 500) {
      throw new Error('Capability metadata exceeds maximum object size.');
    }
    return Object.fromEntries(
      entries
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [
          safeText(key, 180),
          isSensitiveName(key) &&
          !/(?:requirements?|stored|redacted|state|status|ids?)$/i.test(key)
            ? '[REDACTED_SECRET]'
            : safeStructuredValue(child, depth + 1),
        ]),
    );
  }
  if (typeof value === 'string') return safeText(value, 2400);
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return null;
}

export function capabilityMetadataJson(value: unknown): string {
  return canonicalCapabilityJson(safeStructuredValue(value));
}

function safeId(prefix: string, value: string): string {
  return `${prefix}:${sha256(value).slice(0, 32)}`;
}

function exactOpaqueId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (
    !normalized ||
    normalized.length > 180 ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,179}$/.test(normalized) ||
    isSensitiveName(normalized) ||
    /(?:secret|password|bearer|api[_-]?key|token)[=:]/i.test(normalized)
  ) {
    throw new Error(`Capability ${label} must be an opaque identifier.`);
  }
  return normalized;
}

function parseArray(value: string, field: string): unknown[] {
  const parsed = parseCapabilityJson<unknown>(value, field);
  if (!Array.isArray(parsed)) {
    throw new Error(`Capability acquisition ${field} must be an array.`);
  }
  return parsed;
}

const SAFE_OPAQUE_SOURCE_REF_SCHEMES = new Set([
  'agent-os-card',
  'assistant-capability',
  'distillation',
  'evaluation',
  'fixture',
  'fixture-resource',
  'integration',
  'intent-fingerprint',
  'local-ref',
  'opaque-ref',
  'owner-request',
  'owner-scope',
  'policy',
  'proof',
  'provider',
  'provider-health',
  'receipt',
  'skill-playbook',
  'tool',
  'trace',
  'turn-ref',
]);

function hashedSourceRef(kind: 'local' | 'opaque', value: string): string {
  return `${kind}-ref:${sha256(value).slice(0, 24)}`;
}

function safeSourceRef(value: string): string {
  const normalized = String(value || '').trim();
  const isUnambiguouslyLocalPath =
    /^file:/i.test(normalized) ||
    /^(?:\/|~|\\\\|\/\/)/.test(normalized) ||
    /^[A-Za-z]:(?:[\\/]|$)/.test(normalized) ||
    /^(?:\.{1,2})(?:[\\/]|$)/.test(normalized);
  if (isUnambiguouslyLocalPath) {
    return hashedSourceRef('local', normalized);
  }
  const opaque = normalized.match(
    /^([A-Za-z][A-Za-z0-9+.-]*):([A-Za-z0-9][A-Za-z0-9._:@-]{0,511})$/,
  );
  if (
    opaque &&
    SAFE_OPAQUE_SOURCE_REF_SCHEMES.has(opaque[1].toLowerCase()) &&
    !isSensitiveName(opaque[2]) &&
    !/(?:secret|password|bearer|api[_-]?key|token)[=:]/i.test(opaque[2])
  ) {
    return `${opaque[1].toLowerCase()}:${opaque[2]}`;
  }
  if (URL.canParse(normalized)) {
    const url = new URL(normalized);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      if (
        url.pathname !== '/' &&
        !/^\/source-ref-[a-f0-9]{24}$/.test(url.pathname)
      ) {
        url.pathname = `/source-ref-${sha256(url.pathname).slice(0, 24)}`;
      }
      return safeText(url.toString(), 600);
    }
    return hashedSourceRef('opaque', normalized);
  }
  if (/[\\/]/.test(normalized)) {
    return hashedSourceRef('local', normalized);
  }
  return hashedSourceRef('opaque', normalized);
}

function resourceRef(resource: CapabilityResourceDescriptor): object {
  return {
    resourceId: resource.resourceId,
    kind: resource.kind,
    version: resource.version,
    descriptorDigest: capabilityResourceDescriptorDigest(resource),
    healthState: resource.healthState,
    reliabilityScore: resource.reliabilityScore,
    sourceRefs: resource.sourceRefs.map(safeSourceRef),
    bindingRefs: resource.bindingRefs.map((binding) => ({
      bindingId: binding.bindingId,
      operationId: binding.operationId,
      evaluatorId: binding.evaluatorId,
      executorImplementationDigest: binding.executorImplementationDigest,
      evaluatorImplementationDigest: binding.evaluatorImplementationDigest,
      actionClass: binding.actionClass,
      version: binding.version,
      readOnly: binding.readOnly,
    })),
  };
}

export interface ObserveCapabilityGapInput {
  /** Confirms every free-form field below is derived, bounded metadata. */
  metadataClassification: 'derived_metadata';
  groupFolder: string;
  targetOutcome: string;
  postconditions: string[];
  taskFamily: string;
  gapKind: CapabilityGapKind;
  knownPrerequisites?: string[];
  missingPrerequisites?: string[];
  affectedCapability?: string | null;
  candidateResources?: CapabilityResourceDescriptor[];
  riskLevel?: CapabilityAcquisitionRecord['riskLevel'];
  dataEgressClass?: CapabilityAcquisitionRecord['dataEgressClass'];
  expectedCostBand?: CapabilityAcquisitionRecord['expectedCostBand'];
  expectedLatencyBand?: CapabilityAcquisitionRecord['expectedLatencyBand'];
  authorityRequirements?: string[];
  confidence?: number;
  provenanceRefs: string[];
  evidenceOrigin: CapabilityAcquisitionRecord['evidenceOrigin'];
  environmentFingerprint: string;
  durableWorkId?: string;
  now?: Date;
}

export function observeCapabilityGap(
  input: ObserveCapabilityGapInput,
): CapabilityAcquisitionRecord {
  if (!isDatabaseInitialized()) {
    throw new Error(
      'Database must be initialized before observing a capability gap.',
    );
  }
  if (input.metadataClassification !== 'derived_metadata') {
    throw new Error(
      'Capability observation accepts derived metadata only; raw request content is prohibited.',
    );
  }
  if (!input.groupFolder) {
    throw new Error(
      'Capability acquisition requires an explicit owner group scope.',
    );
  }
  const createdAt = iso(input.now);
  const targetOutcome = safeText(input.targetOutcome, 900);
  const taskFamily = safeText(input.taskFamily, 120);
  if (!targetOutcome || !taskFamily || !input.postconditions.length) {
    throw new Error(
      'Capability acquisition requires a target, task family, and postcondition.',
    );
  }
  const identity = canonicalCapabilityJson({
    groupFolder: input.groupFolder,
    targetOutcome,
    postconditions: input.postconditions.map((item) => safeText(item, 500)),
    taskFamily,
  });
  const acquisitionId = safeId('capability-acquisition', identity);
  const existing = getCapabilityAcquisition(acquisitionId);
  if (existing) {
    if (existing.evidenceOrigin !== input.evidenceOrigin) {
      throw new Error(
        'Capability acquisition identity already exists with a different evidence origin.',
      );
    }
    if (input.durableWorkId) {
      upsertDurableWorkLink({
        linkId: safeId(
          'durable-link',
          `${input.durableWorkId}|${existing.acquisitionId}`,
        ),
        workId: input.durableWorkId,
        linkKind: 'capability_acquisition',
        linkedId: existing.acquisitionId,
        createdAt: existing.createdAt,
        privacyJson: existing.privacyJson,
      });
    }
    return existing;
  }
  const record: CapabilityAcquisitionRecord = {
    acquisitionId,
    createdAt,
    updatedAt: createdAt,
    groupFolder: input.groupFolder,
    targetOutcome,
    postconditionJson: capabilityMetadataJson({
      required: input.postconditions.map((item) => safeText(item, 500)),
    }),
    taskFamily,
    affectedCapability: input.affectedCapability
      ? safeText(input.affectedCapability, 220)
      : null,
    gapKind: input.gapKind,
    knownPrerequisitesJson: capabilityMetadataJson(
      input.knownPrerequisites || [],
    ),
    missingPrerequisitesJson: capabilityMetadataJson(
      input.missingPrerequisites || [],
    ),
    candidateResourceRefsJson: capabilityMetadataJson(
      (input.candidateResources || []).map(resourceRef),
    ),
    selectedResourceRefsJson: '[]',
    riskLevel: input.riskLevel || 'low',
    dataEgressClass: input.dataEgressClass || 'local_only',
    expectedCostBand: input.expectedCostBand || 'zero',
    expectedLatencyBand: input.expectedLatencyBand || 'interactive',
    authorityRequirementsJson: capabilityMetadataJson(
      input.authorityRequirements || [],
    ),
    evidenceOrigin: input.evidenceOrigin,
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.5)),
    provenanceJson: capabilityMetadataJson({
      refs: input.provenanceRefs.map(safeSourceRef),
      rawContentStored: false,
    }),
    state: 'observed',
    nextSafeAction: 'Scope the gap and confirm the required postcondition.',
    recordVersion: 1,
    environmentFingerprint: safeText(input.environmentFingerprint, 500),
    candidateContractJson: 'null',
    sandboxEvidenceJson: '{}',
    heldOutEvidenceJson: '{}',
    ownerReviewJson: '{}',
    outcomeIdsJson: '[]',
    compiledSkillId: null,
    negativeOutcomeCount: 0,
    correctionCount: 0,
    lastOutcome: null,
    expiresAt: null,
    revalidateAfterAt: null,
    privacyJson: capabilityMetadataJson(PRIVACY),
  };
  assertCapabilityAcquisitionRecord(record);
  insertCapabilityAcquisition(record);
  if (input.durableWorkId) {
    upsertDurableWorkLink({
      linkId: safeId(
        'durable-link',
        `${input.durableWorkId}|${record.acquisitionId}`,
      ),
      workId: input.durableWorkId,
      linkKind: 'capability_acquisition',
      linkedId: record.acquisitionId,
      createdAt,
      privacyJson: record.privacyJson,
    });
  }
  return getCapabilityAcquisition(record.acquisitionId) || record;
}

export interface CapabilityTransitionInput {
  acquisitionId: string;
  expectedState: CapabilityAcquisitionState;
  toState: CapabilityAcquisitionState;
  actorKind: CapabilityAcquisitionTransitionRecord['actorKind'];
  reason: string;
  evidenceRefs?: string[];
  idempotencyKey: string;
  mutate?: (
    current: CapabilityAcquisitionRecord,
  ) => Partial<CapabilityAcquisitionRecord>;
  canonicalGuard?: CapabilityAcquisitionCanonicalEvidenceGuard;
  now?: Date;
}

function transitionCapabilityAcquisition(
  input: CapabilityTransitionInput,
): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(input.acquisitionId);
  if (!current) throw new Error('Capability acquisition was not found.');
  const normalizedReason = safeText(input.reason, 900);
  const normalizedEvidenceRefs = capabilityMetadataJson(
    (input.evidenceRefs || []).map((item) => safeSourceRef(item)),
  );
  const prior = listCapabilityAcquisitionTransitions(input.acquisitionId).find(
    (item) => item.idempotencyKey === input.idempotencyKey,
  );
  if (prior) {
    if (
      prior.fromState !== input.expectedState ||
      prior.toState !== input.toState ||
      prior.actorKind !== input.actorKind ||
      prior.reason !== normalizedReason ||
      prior.evidenceRefsJson !== normalizedEvidenceRefs
    ) {
      throw new Error('Capability acquisition idempotency key collision.');
    }
    return current;
  }
  const updates = input.mutate?.(current) || {};
  const next: CapabilityAcquisitionRecord = {
    ...current,
    ...updates,
    acquisitionId: current.acquisitionId,
    createdAt: current.createdAt,
    groupFolder: current.groupFolder,
    targetOutcome: current.targetOutcome,
    postconditionJson: current.postconditionJson,
    taskFamily: current.taskFamily,
    state: input.toState,
    updatedAt: iso(input.now),
    recordVersion: current.recordVersion + 1,
  };
  const evidenceRefsJson = normalizedEvidenceRefs;
  const resultingSnapshotJson = capabilityAcquisitionSnapshotJson(next);
  const transitionBase = {
    acquisitionId: current.acquisitionId,
    fromState: input.expectedState,
    toState: input.toState,
    expectedVersion: current.recordVersion,
    resultingVersion: next.recordVersion,
    actorKind: input.actorKind,
    reason: normalizedReason,
    evidenceRefsJson,
    idempotencyKey: safeText(input.idempotencyKey, 500),
    resultingSnapshotJson,
  };
  const transition: CapabilityAcquisitionTransitionRecord = {
    transitionId: safeId(
      'capability-transition',
      `${current.acquisitionId}|${next.recordVersion}|${transitionBase.idempotencyKey}`,
    ),
    createdAt: next.updatedAt,
    ...transitionBase,
    transitionDigest: capabilityTransitionDigest(transitionBase),
    privacyJson: next.privacyJson,
  };
  const result = applyCapabilityAcquisitionTransitionCAS({
    expectedState: input.expectedState,
    next,
    transition,
    canonicalGuard: input.canonicalGuard,
  });
  if (result === 'idempotent') {
    return getCapabilityAcquisition(input.acquisitionId) || next;
  }
  if (result !== 'applied') {
    throw new Error(
      `Capability acquisition transition did not apply: ${result}.`,
    );
  }
  return getCapabilityAcquisition(input.acquisitionId) || next;
}

export function scopeCapabilityAcquisition(params: {
  acquisitionId: string;
  knownPrerequisites: string[];
  missingPrerequisites: string[];
  confidence: number;
  now?: Date;
}): CapabilityAcquisitionRecord {
  return transitionCapabilityAcquisition({
    acquisitionId: params.acquisitionId,
    expectedState: 'observed',
    toState: 'scoped',
    actorKind: 'system',
    reason: 'Capability gap was scoped against a concrete postcondition.',
    evidenceRefs: [],
    idempotencyKey: `${params.acquisitionId}:scope:v1`,
    now: params.now,
    mutate: () => ({
      knownPrerequisitesJson: capabilityMetadataJson(params.knownPrerequisites),
      missingPrerequisitesJson: capabilityMetadataJson(
        params.missingPrerequisites,
      ),
      confidence: Math.max(0, Math.min(1, params.confidence)),
      nextSafeAction: params.missingPrerequisites.length
        ? 'Discover the smallest trusted resource set that can close the missing prerequisites.'
        : 'Discover and rank existing trusted resources before creating anything new.',
    }),
  });
}

export function recordCapabilityResourceDiscovery(params: {
  acquisitionId: string;
  candidates: CapabilityResourceDescriptor[];
  selected: CapabilityResourceDescriptor[];
  rejectedReasons: Record<string, string>;
  now?: Date;
}): CapabilityAcquisitionRecord {
  return transitionCapabilityAcquisition({
    acquisitionId: params.acquisitionId,
    expectedState: 'scoped',
    toState: 'resource_discovery',
    actorKind: 'system',
    reason:
      'Existing resources were compared under trust and authority constraints.',
    evidenceRefs: params.selected.flatMap((item) => item.sourceRefs),
    idempotencyKey: `${params.acquisitionId}:resource-discovery:v1`,
    now: params.now,
    mutate: () => ({
      candidateResourceRefsJson: capabilityMetadataJson({
        resources: params.candidates.map(resourceRef),
        rejectedReasons: params.rejectedReasons,
      }),
      selectedResourceRefsJson: capabilityMetadataJson(
        params.selected.map(resourceRef),
      ),
      nextSafeAction: params.selected.length
        ? 'Compile a typed, version-bound candidate contract.'
        : 'Record the exact external blocker; do not fabricate a capability.',
    }),
  });
}

function implementationKind(
  gap: CapabilityGapKind,
  count: number,
): CapabilityImplementationKind {
  if (gap === 'implementation_gap') return 'repository_code_change';
  if (gap === 'integration_gap') return 'bounded_integration';
  if (gap === 'tool_usage_gap') return 'tool_usage_playbook';
  if (gap === 'knowledge_gap') return 'research_backed_procedure';
  if (count > 1 || gap === 'composable') return 'capability_composition';
  return 'existing_capability';
}

export function compileCapabilityCandidate(params: {
  acquisitionId: string;
  selectedResources: CapabilityResourceDescriptor[];
  triggerSemantics: string[];
  requiredInputs: string[];
  optionalInputs?: string[];
  expectedOutput: string;
  fallbackPaths?: string[];
  deterministicScenarioIds?: string[];
  heldOutScenarioIds?: string[];
  now?: Date;
}): {
  record: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
} {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current) throw new Error('Capability acquisition was not found.');
  if (!params.selectedResources.length) {
    throw new Error(
      'Cannot compile a candidate without a trusted resource binding.',
    );
  }
  const selectedResourceFingerprints = new Set(
    parseArray(
      current.selectedResourceRefsJson,
      'selectedResourceRefsJson',
    ).map((item) => canonicalCapabilityJson(item)),
  );
  if (
    params.selectedResources.some(
      (item) =>
        !selectedResourceFingerprints.has(
          canonicalCapabilityJson(resourceRef(item)),
        ),
    )
  ) {
    throw new Error(
      'Candidate resource does not exactly match the broker-selected descriptor.',
    );
  }
  if (current.state !== 'resource_discovery') {
    const existing = parseCapabilityJson<CapabilityCandidateContract>(
      current.candidateContractJson,
      'candidateContractJson',
    );
    assertCapabilityCandidateContract(existing);
    const exactRetry =
      canonicalCapabilityJson(existing.triggerSemantics) ===
        canonicalCapabilityJson(
          params.triggerSemantics.map((item) => safeText(item, 240)),
        ) &&
      canonicalCapabilityJson(existing.requiredInputs) ===
        canonicalCapabilityJson(
          params.requiredInputs.map((item) => safeText(item, 120)),
        ) &&
      canonicalCapabilityJson(existing.optionalInputs) ===
        canonicalCapabilityJson(
          (params.optionalInputs || []).map((item) => safeText(item, 120)),
        ) &&
      existing.expectedOutput === safeText(params.expectedOutput, 900) &&
      canonicalCapabilityJson(existing.fallbackPaths) ===
        canonicalCapabilityJson(
          (params.fallbackPaths || []).map((item) => safeText(item, 500)),
        ) &&
      canonicalCapabilityJson(existing.deterministicScenarioIds) ===
        canonicalCapabilityJson(params.deterministicScenarioIds || []) &&
      canonicalCapabilityJson(existing.heldOutScenarioIds) ===
        canonicalCapabilityJson(params.heldOutScenarioIds || []) &&
      canonicalCapabilityJson(existing.resourceBindings) ===
        canonicalCapabilityJson(
          params.selectedResources.map((resource) => ({
            resourceId: resource.resourceId,
            bindingKind:
              resource.kind === 'assistant_capability'
                ? 'assistant_capability'
                : resource.kind === 'mission_node'
                  ? 'mission_node'
                  : resource.kind === 'patch_workbench'
                    ? 'patch_workbench'
                    : 'execution_adapter',
            version: resource.version,
            required: true,
          })),
        );
    if (!exactRetry) {
      throw new Error(
        'Candidate compilation retry does not match the persisted immutable contract.',
      );
    }
    return { record: current, contract: existing };
  }
  const bindings = params.selectedResources.flatMap((resource) =>
    resource.bindingRefs.map((binding) => ({ resource, binding })),
  );
  if (!bindings.length) {
    throw new Error('Selected resources do not expose a compile-time binding.');
  }
  const capabilityId = safeId(
    'acquired-capability',
    `${current.taskFamily}|${current.targetOutcome}`,
  );
  const skillId = safeId('acquired-skill', capabilityId);
  const postconditions = parseCapabilityJson<{ required?: unknown[] }>(
    current.postconditionJson,
    'postconditionJson',
  ).required;
  const draft: CapabilityCandidateContract = {
    contractVersion: 1,
    candidateFingerprint: '0'.repeat(64),
    capabilityId,
    skillId,
    title: safeText(current.targetOutcome, 180),
    taskFamily: current.taskFamily,
    triggerSemantics: params.triggerSemantics.map((item) =>
      safeText(item, 240),
    ),
    implementationKind: implementationKind(current.gapKind, bindings.length),
    requiredInputs: params.requiredInputs.map((item) => safeText(item, 120)),
    optionalInputs: (params.optionalInputs || []).map((item) =>
      safeText(item, 120),
    ),
    inputSchemaJson: capabilityMetadataJson({
      additionalProperties: false,
      properties: Object.fromEntries(
        [...params.requiredInputs, ...(params.optionalInputs || [])].map(
          (key) => [safeText(key, 120), { type: 'string' }],
        ),
      ),
      required: params.requiredInputs.map((item) => safeText(item, 120)),
      type: 'object',
    }),
    outputSchemaJson: capabilityMetadataJson({
      additionalProperties: true,
      required: ['result', 'evidenceRefs'],
      type: 'object',
    }),
    preconditions: [
      'exact resource version is available',
      'resource health is fresh enough for the requested action',
      'required inputs are present',
      'approval is exact, fresh, and target-bound when required',
    ],
    resourceBindings: params.selectedResources.map((resource) => ({
      resourceId: resource.resourceId,
      bindingKind:
        resource.kind === 'assistant_capability'
          ? 'assistant_capability'
          : resource.kind === 'mission_node'
            ? 'mission_node'
            : resource.kind === 'patch_workbench'
              ? 'patch_workbench'
              : 'execution_adapter',
      version: resource.version,
      required: true,
    })),
    steps: bindings.map(({ resource, binding }, index) => {
      const policy = durableActionPolicy(binding.actionClass);
      if (!policy)
        throw new Error('Candidate binding uses an unknown action class.');
      return {
        stepId: `step-${index + 1}`,
        title: safeText(resource.displayName, 180),
        resourceId: resource.resourceId,
        bindingId: binding.bindingId,
        operationId: binding.operationId,
        evaluatorId: binding.evaluatorId,
        version: binding.version,
        executorImplementationDigest: binding.executorImplementationDigest,
        evaluatorImplementationDigest: binding.evaluatorImplementationDigest,
        actionClass: binding.actionClass,
        readOnly:
          binding.readOnly && policy.allowedEffects.includes('read_only'),
        approvalRequired: durableActionRequiresApproval(binding.actionClass),
        idempotencyKeyRequired: true,
        expectedEvidence: resource.supportedPostconditions,
      };
    }),
    fallbackPaths: (params.fallbackPaths || []).map((item) =>
      safeText(item, 500),
    ),
    allowedActions: [
      ...new Set(bindings.map((item) => item.binding.actionClass)),
    ],
    prohibitedActions: [...PROHIBITED_ACTIONS],
    approvalRequirements: [
      ...new Set(
        bindings
          .filter((item) =>
            durableActionRequiresApproval(item.binding.actionClass),
          )
          .map(
            (item) =>
              `fresh exact-scope owner approval:${item.binding.actionClass}`,
          ),
      ),
    ],
    credentialRequirements: [],
    dataEgressClass: current.dataEgressClass,
    expectedOutput: safeText(params.expectedOutput, 900),
    successPostconditions: Array.isArray(postconditions)
      ? postconditions.map((item) => safeText(item, 500))
      : [],
    verificationProcedure: bindings.map(
      (item) => `Run registered evaluator ${item.binding.evaluatorId}.`,
    ),
    verifierBindingIds: bindings.map((item) => item.binding.evaluatorId),
    failureClassifications: [
      'missing_input',
      'resource_unavailable',
      'stale_version',
      'approval_missing',
      'execution_failed_before_effect',
      'effect_unknown',
      'verification_failed',
      'external_blocker',
    ],
    rollbackProcedure: ['Run only the registered cleanup binding, if present.'],
    rollbackBindingIds: [],
    deterministicScenarioIds: params.deterministicScenarioIds || [],
    heldOutScenarioIds: params.heldOutScenarioIds || [],
    compatibleResourceVersions: Object.fromEntries(
      params.selectedResources.map((resource) => [
        resource.resourceId,
        [resource.version],
      ]),
    ),
    revalidationRequirements: [
      'resource version digest matches',
      'registered binding and evaluator are unchanged',
      'dependency health is fresh',
      'postcondition verifier still passes',
    ],
    provenanceRefs: params.selectedResources.flatMap((resource) =>
      resource.sourceRefs.map(safeSourceRef),
    ),
  };
  const contract: CapabilityCandidateContract = {
    ...draft,
    candidateFingerprint: capabilityCandidateFingerprint(draft),
  };
  assertCapabilityCandidateContract(contract);
  const record = transitionCapabilityAcquisition({
    acquisitionId: current.acquisitionId,
    expectedState: 'resource_discovery',
    toState: 'candidate_designed',
    actorKind: 'system',
    reason: 'Compiled a typed contract over closed, versioned bindings.',
    evidenceRefs: contract.provenanceRefs,
    idempotencyKey: `${current.acquisitionId}:candidate:${contract.candidateFingerprint}`,
    now: params.now,
    mutate: () => ({
      candidateContractJson: capabilityMetadataJson(contract),
      compiledSkillId: contract.skillId,
      nextSafeAction: contract.steps.some((step) => step.approvalRequired)
        ? 'Stage exact owner review before any approval-bound sandbox step.'
        : 'Prepare the candidate for isolated sandbox execution.',
    }),
  });
  projectCapabilityAcquisitionSkill(record);
  return { record, contract };
}

export function markCapabilityExternallyBlocked(params: {
  acquisitionId: string;
  expectedState: 'observed' | 'scoped' | 'resource_discovery';
  blocker: string;
  evidenceRefs: string[];
  now?: Date;
}): CapabilityAcquisitionRecord {
  return transitionCapabilityAcquisition({
    acquisitionId: params.acquisitionId,
    expectedState: params.expectedState,
    toState: 'externally_blocked',
    actorKind: 'system',
    reason: 'A required external prerequisite is unavailable.',
    evidenceRefs: params.evidenceRefs,
    idempotencyKey: `${params.acquisitionId}:external-block:${sha256(params.blocker).slice(0, 16)}`,
    now: params.now,
    mutate: () => ({
      nextSafeAction: safeText(params.blocker, 900),
      lastOutcome: 'externally_blocked',
    }),
  });
}

export type CapabilityCandidateNegativeEvaluationClass =
  | 'malformed_candidate'
  | 'deterministic_rejection'
  | 'heldout_correction'
  | 'authority_violation'
  | 'privacy_violation';

export function recordCapabilityCandidateNegativeEvaluation(params: {
  acquisitionId: string;
  evaluationId: string;
  failureClass: CapabilityCandidateNegativeEvaluationClass;
  evidenceRefs: string[];
  actorKind: 'system' | 'certification';
  now?: Date;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current) throw new Error('Capability acquisition was not found.');
  if (params.actorKind === 'certification') {
    assertHermeticCapabilityCertificationProcess();
  }
  const evaluationId = exactOpaqueId(params.evaluationId, 'evaluation ID');
  const evidenceRefs = [
    evaluationId,
    ...params.evidenceRefs.map((item) => safeSourceRef(item)),
  ];
  const idempotencyKey = `${current.acquisitionId}:negative-evaluation:${evaluationId}`;
  const prior = listCapabilityAcquisitionTransitions(
    current.acquisitionId,
  ).find((item) => item.idempotencyKey === idempotencyKey);
  if (prior) {
    const priorSnapshot = parseCapabilityJson<CapabilityAcquisitionRecord>(
      prior.resultingSnapshotJson,
      'negativeEvaluation.resultingSnapshotJson',
    );
    const priorHeldOut = parseCapabilityJson<Record<string, unknown>>(
      priorSnapshot.heldOutEvidenceJson,
      'negativeEvaluation.heldOutEvidenceJson',
    );
    if (
      prior.actorKind !== params.actorKind ||
      prior.evidenceRefsJson !== capabilityMetadataJson(evidenceRefs) ||
      priorHeldOut.lastNegativeClass !== params.failureClass
    ) {
      throw new Error('Capability negative evaluation identity collision.');
    }
    return current;
  }
  if (
    current.state !== 'resource_discovery' &&
    current.state !== 'candidate_designed'
  ) {
    throw new Error(
      'Candidate negative evaluation requires discovery or candidate state.',
    );
  }
  const nextNegativeCount = current.negativeOutcomeCount + 1;
  const safetyViolation =
    params.failureClass === 'authority_violation' ||
    params.failureClass === 'privacy_violation';
  const toState: CapabilityAcquisitionState =
    safetyViolation || nextNegativeCount >= 2
      ? 'quarantined'
      : current.state === 'resource_discovery'
        ? 'failed'
        : 'candidate_designed';
  const heldOut = parseCapabilityJson<Record<string, unknown>>(
    current.heldOutEvidenceJson,
    'heldOutEvidenceJson',
  );
  const priorEvaluations = Array.isArray(heldOut.negativeEvaluationIds)
    ? heldOut.negativeEvaluationIds.map(String)
    : [];
  return transitionCapabilityAcquisition({
    acquisitionId: current.acquisitionId,
    expectedState: current.state,
    toState,
    actorKind: params.actorKind,
    reason:
      toState === 'quarantined'
        ? 'Negative candidate evidence crossed the quarantine boundary.'
        : 'A bounded candidate evaluation rejected the current design.',
    evidenceRefs,
    idempotencyKey,
    now: params.now,
    mutate: () => ({
      negativeOutcomeCount: nextNegativeCount,
      correctionCount:
        current.correctionCount +
        (params.failureClass === 'heldout_correction' ? 1 : 0),
      heldOutEvidenceJson: capabilityMetadataJson({
        ...heldOut,
        negativeEvaluationIds: [...priorEvaluations, evaluationId],
        lastNegativeClass: params.failureClass,
      }),
      lastOutcome: params.failureClass,
      nextSafeAction:
        toState === 'quarantined'
          ? 'Create a remediated contract version; this candidate cannot be reactivated.'
          : 'Correct the rejected candidate before another evaluation.',
    }),
  });
}

export interface CapabilityBindingResult {
  result: unknown;
  evidenceRefs: string[];
  effectClass: DurablePolicyEffectClass;
  effectStatus: 'none' | 'certain' | 'unknown';
  preStateFingerprint?: string;
  postStateFingerprint?: string;
  providerCalls?: number;
  costUsd?: number;
}

export interface CapabilityVerificationResult {
  verified: boolean;
  evidenceRefs: string[];
  verifiedPostconditions: string[];
  postconditionFingerprint?: string;
  reason: string;
}

export interface CapabilityExecutorBinding {
  bindingId: string;
  operationId: string;
  resourceId: string;
  version: string;
  executorImplementationDigest: string;
  actionClass: DurableActionClass;
  effectClass: DurablePolicyEffectClass;
  networkAccess: 'none' | 'loopback' | 'external';
  execute(input: {
    values: Record<string, unknown>;
    idempotencyKey: string;
    sandboxRoot?: string;
  }): Promise<CapabilityBindingResult>;
  cleanup?(input: {
    values: Record<string, unknown>;
    result?: CapabilityBindingResult;
    sandboxRoot?: string;
  }): Promise<boolean>;
}

export interface CapabilityEvaluatorBinding {
  evaluatorId: string;
  operationId: string;
  resourceId: string;
  version: string;
  evaluatorImplementationDigest: string;
  verify(input: {
    values: Record<string, unknown>;
    result: CapabilityBindingResult;
    requiredPostconditions: string[];
    recovery: boolean;
  }): Promise<CapabilityVerificationResult>;
}

const CAPABILITY_IMPLEMENTATION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const HERMETIC_CERTIFICATION_REGISTRY_BRAND = Symbol(
  'andrea.hermetic-capability-certification-registry',
);

function assertHermeticCapabilityCertificationProcess(): void {
  if (
    process.env.ANDREA_TEST_NETWORK_GUARD_ACTIVE !== '1' ||
    process.env.ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT !== '1'
  ) {
    throw new Error(
      'Capability binding execution is available only inside the hermetic guarded certification process.',
    );
  }
}

export class VerifiedCapabilityBindingRegistry {
  readonly #executors: ReadonlyMap<string, CapabilityExecutorBinding>;
  readonly #evaluators: ReadonlyMap<string, CapabilityEvaluatorBinding>;
  readonly #brand: symbol;

  private constructor(
    input: {
      executors: readonly CapabilityExecutorBinding[];
      evaluators: readonly CapabilityEvaluatorBinding[];
    },
    brand: symbol,
  ) {
    const executors = new Map<string, CapabilityExecutorBinding>();
    for (const binding of input.executors) {
      if (
        !binding.bindingId ||
        !binding.operationId ||
        !binding.resourceId ||
        !binding.version ||
        !CAPABILITY_IMPLEMENTATION_DIGEST_PATTERN.test(
          binding.executorImplementationDigest,
        )
      ) {
        throw new Error('Malformed capability executor identity.');
      }
      if (executors.has(binding.bindingId)) {
        throw new Error('Duplicate capability binding identity.');
      }
      assertDurableActionEffectPolicy(binding.actionClass, binding.effectClass);
      if (
        binding.effectClass === 'sandbox_repository_write' &&
        typeof binding.cleanup !== 'function'
      ) {
        throw new Error(
          'Sandbox repository write bindings require a registered cleanup verifier.',
        );
      }
      executors.set(binding.bindingId, Object.freeze({ ...binding }));
    }
    const evaluators = new Map<string, CapabilityEvaluatorBinding>();
    for (const evaluator of input.evaluators) {
      if (
        !evaluator.evaluatorId ||
        !evaluator.operationId ||
        !evaluator.resourceId ||
        !evaluator.version ||
        !CAPABILITY_IMPLEMENTATION_DIGEST_PATTERN.test(
          evaluator.evaluatorImplementationDigest,
        )
      ) {
        throw new Error('Malformed capability evaluator identity.');
      }
      if (evaluators.has(evaluator.evaluatorId)) {
        throw new Error('Duplicate capability evaluator identity.');
      }
      evaluators.set(evaluator.evaluatorId, Object.freeze({ ...evaluator }));
    }
    this.#executors = executors;
    this.#evaluators = evaluators;
    this.#brand = brand;
  }

  static createHermeticCertification(input: {
    executors: readonly CapabilityExecutorBinding[];
    evaluators: readonly CapabilityEvaluatorBinding[];
  }): VerifiedCapabilityBindingRegistry {
    assertHermeticCapabilityCertificationProcess();
    return new VerifiedCapabilityBindingRegistry(
      input,
      HERMETIC_CERTIFICATION_REGISTRY_BRAND,
    );
  }

  assertHermeticCertificationRegistry(): void {
    assertHermeticCapabilityCertificationProcess();
    if (this.#brand !== HERMETIC_CERTIFICATION_REGISTRY_BRAND) {
      throw new Error(
        'Capability binding registry is not hermetically branded.',
      );
    }
  }

  resolveExecutor(
    step: CapabilityCandidateContract['steps'][number],
  ): CapabilityExecutorBinding {
    const binding = this.#executors.get(step.bindingId);
    if (
      !binding ||
      binding.operationId !== step.operationId ||
      binding.resourceId !== step.resourceId ||
      binding.version !== step.version ||
      binding.executorImplementationDigest !==
        step.executorImplementationDigest ||
      binding.actionClass !== step.actionClass
    ) {
      throw new Error(
        'Candidate binding is unavailable or does not match the compiled contract.',
      );
    }
    return binding;
  }

  resolveEvaluator(
    step: CapabilityCandidateContract['steps'][number],
  ): CapabilityEvaluatorBinding {
    const evaluator = this.#evaluators.get(step.evaluatorId);
    if (
      !evaluator ||
      evaluator.operationId !== step.operationId ||
      evaluator.resourceId !== step.resourceId ||
      evaluator.version !== step.version ||
      evaluator.evaluatorImplementationDigest !==
        step.evaluatorImplementationDigest
    ) {
      throw new Error(
        'Candidate evaluator is unavailable or does not match the compiled contract.',
      );
    }
    return evaluator;
  }
}

export function createHermeticCertificationBindingRegistry(input: {
  executors: readonly CapabilityExecutorBinding[];
  evaluators: readonly CapabilityEvaluatorBinding[];
}): VerifiedCapabilityBindingRegistry {
  return VerifiedCapabilityBindingRegistry.createHermeticCertification(input);
}

export interface CapabilityExecutionReceipt {
  receiptId: string;
  idempotencyKey: string;
  bindingId: string;
  actionClass: DurableActionClass;
  status: 'started' | 'succeeded' | 'failed' | 'unknown';
  effectClass: DurablePolicyEffectClass;
  preStateFingerprint?: string;
  postStateFingerprint?: string;
  verificationFingerprint?: string;
  evidenceRefs: string[];
}

export interface CapabilityExecutionScope {
  targetScopeKey: string;
  targetScopeHash: string;
  ownerScopeHash: string;
  chatScopeHash: string;
  groupScopeHash: string;
  channel: string;
  workId: string;
  checkpointId: string;
  planVersion: number;
}

export interface CapabilityExecutionAuthorization {
  grantId: string;
  leaseId: string;
  processGeneration: string;
}

export function prepareCapabilityExecutionScope(params: {
  acquisitionId: string;
  ownerId: string;
  chatId: string;
  groupId: string;
  channel: string;
  targetScopeKey: string;
  now?: Date;
}): CapabilityExecutionScope {
  const acquisition = getCapabilityAcquisition(params.acquisitionId);
  if (!acquisition || !acquisition.groupFolder) {
    throw new Error('Capability acquisition does not have an owner scope.');
  }
  if (acquisition.groupFolder !== params.groupId) {
    throw new Error(
      'Capability durable work group does not match the acquisition scope.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  const expectedBinding = {
    ownerScopeHash: durableScopeHash('owner', params.ownerId),
    chatScopeHash: durableScopeHash('chat', params.chatId),
    groupScopeHash: durableScopeHash('group', params.groupId),
    channel: safeText(params.channel, 120),
    targetScopeHash: durableScopeHash('target', params.targetScopeKey),
  };
  let work = getDurableWorkUnitForCapabilityAcquisition(
    acquisition.acquisitionId,
  );
  if (!work) {
    const created = createOrLoadDurableWork({
      originTurnId: acquisition.acquisitionId,
      authorizedSurface: 'capability_acquisition',
      binding: {
        ownerId: params.ownerId,
        chatId: params.chatId,
        groupId: params.groupId,
        channel: params.channel,
        targetScopeKey: params.targetScopeKey,
      },
      goalSummary: `Verify capability acquisition ${acquisition.acquisitionId}.`,
      status: 'ready',
      nextAction:
        'Execute only the candidate contract through canonical receipts.',
      now: params.now,
    });
    work = created.work;
    linkDurableWorkProjection(
      work.workId,
      'capability_acquisition_execution',
      acquisition.acquisitionId,
      params.now,
    );
  }
  if (
    work.ownerScopeHash !== expectedBinding.ownerScopeHash ||
    work.chatScopeHash !== expectedBinding.chatScopeHash ||
    work.groupScopeHash !== expectedBinding.groupScopeHash ||
    work.channel !== expectedBinding.channel ||
    work.targetScopeHash !== expectedBinding.targetScopeHash
  ) {
    throw new Error(
      'Capability durable work identity does not match the requested execution scope.',
    );
  }
  let checkpoint = work.checkpointHeadId
    ? getDurableWorkCheckpoint(work.checkpointHeadId)
    : null;
  if (!checkpoint) {
    const committed = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      pendingNodeIds: contract.steps.map((step) => step.stepId),
      dependencyIds: contract.resourceBindings.map(
        (binding) =>
          `capability-resource:${sha256(binding.resourceId).slice(0, 32)}`,
      ),
      worldSignals: {
        fresh: contract.resourceBindings.map(
          (binding) =>
            `resource-health:${sha256(binding.resourceId).slice(0, 32)}`,
        ),
      },
      executorScopeKey: contract.candidateFingerprint,
      targetScopeKey: params.targetScopeKey,
      verificationRequirementIds: contract.verifierBindingIds.map(
        (verifierId) =>
          `capability-verifier:${sha256(verifierId).slice(0, 32)}`,
      ),
      retryBudget: 1,
      attemptsUsed: 0,
      stopConditionIds: [
        'approval_or_scope_mismatch',
        'unknown_effect',
        'postcondition_failure',
      ],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction:
        'Preflight every binding and write a started receipt before any effect.',
      now: params.now,
    });
    work = committed.work;
    checkpoint = committed.checkpoint;
  }
  if (
    checkpoint.workId !== work.workId ||
    checkpoint.planVersion !== work.planVersion ||
    checkpoint.targetScopeHash !== work.targetScopeHash ||
    work.checkpointHeadId !== checkpoint.durableCheckpointId
  ) {
    throw new Error('Capability durable checkpoint identity is stale.');
  }
  return {
    targetScopeKey: params.targetScopeKey,
    targetScopeHash: work.targetScopeHash,
    ownerScopeHash: work.ownerScopeHash,
    chatScopeHash: work.chatScopeHash,
    groupScopeHash: work.groupScopeHash,
    channel: work.channel,
    workId: work.workId,
    checkpointId: checkpoint.durableCheckpointId,
    planVersion: work.planVersion,
  };
}

function parseIdArrayJson(value: string, label: string): string[] {
  const parsed = parseCapabilityJson<unknown>(value, label);
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`${label} must contain identifier strings.`);
  }
  return parsed as string[];
}

function completedCapabilityReceiptIds(params: {
  scope: CapabilityExecutionScope;
  contract: CapabilityCandidateContract;
  values: Record<string, unknown>;
}): string[] | null {
  const work = getDurableWorkUnit(params.scope.workId);
  const checkpoint = getDurableWorkCheckpoint(params.scope.checkpointId);
  if (
    !work ||
    !checkpoint ||
    checkpoint.status !== 'completed' ||
    work.checkpointHeadId !== checkpoint.durableCheckpointId ||
    checkpoint.workId !== work.workId ||
    checkpoint.planVersion !== work.planVersion ||
    parseIdArrayJson(checkpoint.pendingNodeIdsJson, 'pendingNodeIdsJson')
      .length > 0 ||
    parseIdArrayJson(checkpoint.uncertainNodeIdsJson, 'uncertainNodeIdsJson')
      .length > 0
  ) {
    return null;
  }
  const completed = new Set(
    parseIdArrayJson(checkpoint.completedNodeIdsJson, 'completedNodeIdsJson'),
  );
  const referenced = new Set(
    parseIdArrayJson(checkpoint.receiptIdsJson, 'receiptIdsJson'),
  );
  const receipts = listDurableEffectReceipts({
    workId: work.workId,
    limit: 1_000,
  }).filter((receipt) => referenced.has(receipt.receiptId));
  if (
    completed.size !== params.contract.steps.length ||
    receipts.length !== params.contract.steps.length
  ) {
    return null;
  }
  const receiptIds: string[] = [];
  const expectedInputDigest = sha256(canonicalCapabilityJson(params.values));
  for (const step of params.contract.steps) {
    const receipt = receipts.find(
      (candidate) => candidate.nodeId === step.stepId,
    );
    let metadata: Record<string, unknown> = {};
    try {
      metadata = receipt
        ? (JSON.parse(receipt.metadataJson) as Record<string, unknown>)
        : {};
    } catch {
      return null;
    }
    if (
      !completed.has(step.stepId) ||
      !receipt ||
      receipt.status !== 'succeeded' ||
      receipt.checkpointId !== checkpoint.parentCheckpointId ||
      receipt.planVersion !== work.planVersion ||
      receipt.targetScopeHash !== work.targetScopeHash ||
      receipt.actionClass !== step.actionClass ||
      !receipt.postStateFingerprint ||
      !receipt.verificationFingerprint ||
      metadata.receiptClass !== 'capability_acquisition' ||
      metadata.resultCode !== params.contract.candidateFingerprint ||
      metadata.idempotencyKeyHash !== expectedInputDigest
    ) {
      return null;
    }
    receiptIds.push(receipt.receiptId);
  }
  return receiptIds;
}

function completeRecoveredCapabilityDurableWork(params: {
  scope: CapabilityExecutionScope;
  now?: Date;
}): void {
  let work = getDurableWorkUnit(params.scope.workId);
  if (!work) {
    throw new Error('Recovered capability durable work was not found.');
  }
  if (work.status === 'completed') return;
  if (work.status === 'ready' || work.status === 'executing') {
    work = transitionDurableWork({
      workId: work.workId,
      expectedVersion: work.version,
      toStatus: 'verifying',
      nextAction:
        'Recover verification from the completed canonical sandbox checkpoint.',
      now: params.now,
    });
  }
  if (work.status !== 'verifying') {
    throw new Error(
      'Recovered capability durable work is not at a completion-safe phase.',
    );
  }
  transitionDurableWork({
    workId: work.workId,
    expectedVersion: work.version,
    toStatus: 'completed',
    nextAction:
      'Sandbox postcondition and cleanup were recovered without replay.',
    now: params.now,
  });
}

function assertCanonicalExecutionScope(params: {
  scope: CapabilityExecutionScope;
  contract: CapabilityCandidateContract;
}): void {
  const candidate = getCapabilityAcquisitionByCompiledSkillId(
    params.contract.skillId,
  );
  const scopedWork = candidate
    ? getDurableWorkUnitForCapabilityAcquisition(candidate.acquisitionId)
    : null;
  const checkpoint = getDurableWorkCheckpoint(params.scope.checkpointId);
  if (
    !scopedWork ||
    !checkpoint ||
    scopedWork.workId !== params.scope.workId ||
    scopedWork.checkpointHeadId !== checkpoint.durableCheckpointId ||
    checkpoint.workId !== scopedWork.workId ||
    scopedWork.planVersion !== params.scope.planVersion ||
    checkpoint.planVersion !== params.scope.planVersion ||
    scopedWork.ownerScopeHash !== params.scope.ownerScopeHash ||
    scopedWork.chatScopeHash !== params.scope.chatScopeHash ||
    scopedWork.groupScopeHash !== params.scope.groupScopeHash ||
    scopedWork.channel !== params.scope.channel ||
    scopedWork.targetScopeHash !== params.scope.targetScopeHash ||
    checkpoint.targetScopeHash !== params.scope.targetScopeHash ||
    durableScopeHash('target', params.scope.targetScopeKey) !==
      params.scope.targetScopeHash
  ) {
    throw new Error(
      'Capability execution scope is not bound to canonical durable work.',
    );
  }
  const plannedNodes = new Set([
    ...parseIdArrayJson(checkpoint.pendingNodeIdsJson, 'pendingNodeIdsJson'),
    ...parseIdArrayJson(
      checkpoint.completedNodeIdsJson,
      'completedNodeIdsJson',
    ),
    ...parseIdArrayJson(
      checkpoint.uncertainNodeIdsJson,
      'uncertainNodeIdsJson',
    ),
  ]);
  if (params.contract.steps.some((step) => !plannedNodes.has(step.stepId))) {
    throw new Error(
      'Capability durable checkpoint does not contain every candidate step.',
    );
  }
}

function canonicalAuthorizationForStep(params: {
  step: CapabilityCandidateContract['steps'][number];
  scope: CapabilityExecutionScope;
  authorizations?: CapabilityExecutionAuthorization[];
  now: string;
}): CapabilityExecutionAuthorization | null {
  if (!durableActionRequiresApproval(params.step.actionClass)) return null;
  const grants = listDurableResumeGrants({
    workId: params.scope.workId,
    limit: 100,
  });
  for (const authorization of params.authorizations || []) {
    const grant = grants.find(
      (candidate) => candidate.grantId === authorization.grantId,
    );
    const lease = getDurableWorkLease(authorization.leaseId);
    const approval = grant?.approvalPacketId
      ? listCognitiveApprovalPackets({ limit: 1_000 }).find(
          (candidate) => candidate.approvalPacketId === grant.approvalPacketId,
        )
      : null;
    if (
      grant?.status === 'consumed' &&
      grant.workId === params.scope.workId &&
      grant.checkpointId === params.scope.checkpointId &&
      grant.planVersion === params.scope.planVersion &&
      grant.ownerScopeHash === params.scope.ownerScopeHash &&
      grant.chatScopeHash === params.scope.chatScopeHash &&
      grant.groupScopeHash === params.scope.groupScopeHash &&
      grant.channel === params.scope.channel &&
      grant.targetScopeHash === params.scope.targetScopeHash &&
      grant.actionClass === params.step.actionClass &&
      grant.consumedLeaseId === authorization.leaseId &&
      lease?.status === 'active' &&
      lease.workId === params.scope.workId &&
      lease.processGeneration === authorization.processGeneration &&
      lease.expiresAt > params.now &&
      approval?.status === 'approved' &&
      approval.durableWorkId === params.scope.workId &&
      approval.durableCheckpointId === params.scope.checkpointId &&
      approval.planVersion === params.scope.planVersion &&
      approval.targetScopeDigest === params.scope.targetScopeHash &&
      approval.actionClass === params.step.actionClass &&
      approval.approvalVersion === grant.approvalVersion &&
      approval.scopeDigest === grant.approvalScopeHash &&
      (!approval.expiresAt || approval.expiresAt > params.now)
    ) {
      return authorization;
    }
  }
  throw new Error(
    'Exact canonical owner approval, consumed grant, and active lease are required.',
  );
}

function capabilityInvocationIdentity(params: {
  acquisitionId: string;
  contract: CapabilityCandidateContract;
  step: CapabilityCandidateContract['steps'][number];
  scope: CapabilityExecutionScope;
  values: Record<string, unknown>;
  executionId: string;
}): { invocationId: string; inputDigest: string; idempotencyKey: string } {
  const inputDigest = sha256(canonicalCapabilityJson(params.values));
  const idempotencyKey = sha256(
    canonicalCapabilityJson({
      acquisitionId: params.acquisitionId,
      candidateFingerprint: params.contract.candidateFingerprint,
      executionId: params.executionId,
      stepId: params.step.stepId,
      inputDigest,
      workId: params.scope.workId,
      checkpointId: params.scope.checkpointId,
      planVersion: params.scope.planVersion,
      ownerScopeHash: params.scope.ownerScopeHash,
      chatScopeHash: params.scope.chatScopeHash,
      groupScopeHash: params.scope.groupScopeHash,
      channel: params.scope.channel,
      targetScopeHash: params.scope.targetScopeHash,
    }),
  );
  return {
    invocationId: `capability-invocation:${idempotencyKey.slice(0, 40)}`,
    inputDigest,
    idempotencyKey,
  };
}

function findCanonicalCapabilityReceipt(params: {
  scope: CapabilityExecutionScope;
  step: CapabilityCandidateContract['steps'][number];
  binding: CapabilityExecutorBinding;
  invocationId: string;
  candidateFingerprint: string;
  inputDigest: string;
}): CapabilityExecutionReceipt | null {
  const nodeReceipts = listDurableEffectReceipts({
    workId: params.scope.workId,
    checkpointId: params.scope.checkpointId,
    limit: 1_000,
  }).filter((candidate) => candidate.nodeId === params.step.stepId);
  if (nodeReceipts.some((candidate) => candidate.status === 'started')) {
    throw new DurableEffectExecutionClaimConflictError();
  }
  if (
    nodeReceipts.some(
      (candidate) => candidate.invocationId !== params.invocationId,
    )
  ) {
    throw new Error(
      'Capability execution input or scope changed for an existing durable plan node.',
    );
  }
  const receipt = nodeReceipts.find(
    (candidate) => candidate.invocationId === params.invocationId,
  );
  if (!receipt) return null;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(receipt.metadataJson) as Record<string, unknown>;
  } catch (error) {
    throw new Error('Canonical capability receipt metadata is malformed.', {
      cause: error,
    });
  }
  if (
    receipt.actionClass !== params.step.actionClass ||
    receipt.effectClass !== params.binding.effectClass ||
    receipt.targetScopeHash !== params.scope.targetScopeHash ||
    metadata.receiptClass !== 'capability_acquisition' ||
    metadata.resultCode !== params.candidateFingerprint ||
    metadata.idempotencyKeyHash !== params.inputDigest
  ) {
    throw new Error('Canonical capability receipt identity does not match.');
  }
  return {
    receiptId: receipt.receiptId,
    idempotencyKey: params.invocationId,
    bindingId: params.binding.bindingId,
    actionClass: params.step.actionClass,
    status: receipt.status === 'partial' ? 'unknown' : receipt.status,
    effectClass: params.binding.effectClass,
    preStateFingerprint: receipt.preStateFingerprint || undefined,
    postStateFingerprint: receipt.postStateFingerprint || undefined,
    verificationFingerprint: receipt.verificationFingerprint || undefined,
    evidenceRefs: [receipt.receiptId],
  };
}

function recordCanonicalCapabilityReceipt(params: {
  scope: CapabilityExecutionScope;
  step: CapabilityCandidateContract['steps'][number];
  binding: CapabilityExecutorBinding;
  invocationId: string;
  inputDigest: string;
  candidateFingerprint: string;
  status: 'started' | 'succeeded' | 'failed' | 'unknown';
  claimExecution?: boolean;
  authorization: CapabilityExecutionAuthorization | null;
  preStateFingerprint?: string;
  postStateFingerprint?: string;
  verificationFingerprint?: string;
  now?: Date;
}): CapabilityExecutionReceipt {
  const receipt = recordDurableEffect({
    workId: params.scope.workId,
    checkpointId: params.scope.checkpointId,
    planVersion: params.scope.planVersion,
    nodeId: params.step.stepId,
    invocationId: params.invocationId,
    actionClass: params.step.actionClass,
    authorizationGrantId: params.authorization?.grantId,
    leaseId: params.authorization?.leaseId,
    processGeneration: params.authorization?.processGeneration,
    executionSurface: 'capability_sandbox',
    effectClass: params.binding.effectClass,
    status: params.status,
    claimExecution: params.claimExecution,
    targetScopeKey: params.scope.targetScopeKey,
    preStateFingerprint: params.preStateFingerprint,
    postStateFingerprint: params.postStateFingerprint,
    verificationFingerprint: params.verificationFingerprint,
    metadata: {
      receiptClass: 'capability_acquisition',
      verificationClass: params.step.evaluatorId,
      resultCode: params.candidateFingerprint,
      idempotencyKeyHash: params.inputDigest,
      source: 'verified_capability_acquisition',
    },
    now: params.now,
  });
  return {
    receiptId: receipt.receiptId,
    idempotencyKey: params.invocationId,
    bindingId: params.binding.bindingId,
    actionClass: params.step.actionClass,
    status: receipt.status === 'partial' ? 'unknown' : receipt.status,
    effectClass: params.binding.effectClass,
    preStateFingerprint: receipt.preStateFingerprint || undefined,
    postStateFingerprint: receipt.postStateFingerprint || undefined,
    verificationFingerprint: receipt.verificationFingerprint || undefined,
    evidenceRefs: [receipt.receiptId],
  };
}

export async function runCapabilitySandbox(params: {
  acquisitionId: string;
  values: Record<string, unknown>;
  registry: VerifiedCapabilityBindingRegistry;
  currentResources: CapabilityResourceDescriptor[];
  scope: CapabilityExecutionScope;
  networkPolicy: 'none' | 'loopback';
  sandboxRoot?: string;
  executionId?: string;
  authorizations?: CapabilityExecutionAuthorization[];
  now?: Date;
}): Promise<CapabilityAcquisitionRecord> {
  const initial = getCapabilityAcquisition(params.acquisitionId);
  if (
    !initial ||
    !['sandbox_ready', 'sandbox_running', 'sandbox_verified'].includes(
      initial.state,
    )
  ) {
    throw new Error(
      'Sandbox execution requires sandbox_ready or restart-recoverable sandbox_running state.',
    );
  }
  params.registry.assertHermeticCertificationRegistry();
  if (initial.evidenceOrigin !== 'synthetic') {
    throw new Error(
      'In-process capability sandbox execution is certification-only; live and replay acquisitions remain fail closed.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    initial.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  assertCanonicalExecutionScope({ scope: params.scope, contract });
  const recoveredReceiptIds = completedCapabilityReceiptIds({
    scope: params.scope,
    contract,
    values: params.values,
  });
  if (recoveredReceiptIds) {
    if (initial.state === 'sandbox_ready') {
      throw new Error(
        'Completed sandbox receipts cannot precede the canonical running state.',
      );
    }
    completeRecoveredCapabilityDurableWork({
      scope: params.scope,
      now: params.now,
    });
  }
  if (initial.state === 'sandbox_verified') {
    if (!recoveredReceiptIds) {
      throw new Error(
        'Completed capability retry does not match canonical input or durable completion evidence.',
      );
    }
    return initial;
  }
  if (initial.state === 'sandbox_running' && recoveredReceiptIds) {
    return transitionCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      expectedState: 'sandbox_running',
      toState: 'sandbox_verified',
      actorKind: 'system',
      reason:
        'Recovered sandbox verification from a completed canonical durable checkpoint without replay.',
      evidenceRefs: recoveredReceiptIds,
      idempotencyKey: `${initial.acquisitionId}:sandbox-verified:${contract.candidateFingerprint}`,
      canonicalGuard: {
        kind: 'sandbox_completion',
        durableWorkId: params.scope.workId,
        checkpointId: params.scope.checkpointId,
        candidateFingerprint: contract.candidateFingerprint,
        receiptIds: recoveredReceiptIds,
      },
      now: params.now,
      mutate: () => ({
        sandboxEvidenceJson: capabilityMetadataJson({
          cleanupVerified: true,
          duplicateEffects: 0,
          falseSuccesses: 0,
          networkDenied: true,
          postconditionVerified: true,
          receiptIds: recoveredReceiptIds,
          recoveredFromDurableCompletion: true,
          unauthorizedEffects: 0,
          verificationReceiptIds: recoveredReceiptIds,
          verified: true,
        }),
        lastOutcome: 'sandbox_verified',
        nextSafeAction:
          'Run independently authored held-out cases; no sandbox effect was replayed.',
      }),
    });
  }
  const now = iso(params.now);
  const selected = parseArray(
    initial.selectedResourceRefsJson,
    'selectedResourceRefsJson',
  ).map((item) => {
    const record =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return {
      resourceId: String(record.resourceId || ''),
      version: String(record.version || ''),
      descriptorDigest: String(record.descriptorDigest || ''),
    } satisfies SelectedCapabilityResourceFingerprint;
  });
  const inputValidation = validateCapabilityCandidateInput(
    contract,
    params.values,
  );
  const resourceValidation = validateCapabilityResourceDescriptors({
    contract,
    selected,
    currentResources: params.currentResources,
  });
  const resourceDiscoveryTransition = listCapabilityAcquisitionTransitions(
    initial.acquisitionId,
  ).find((transition) => transition.toState === 'resource_discovery');
  const healthObservedAt = resourceDiscoveryTransition?.createdAt || '';
  const healthObservedAtMs = Date.parse(healthObservedAt);
  const healthMaxAgeMs = 15 * 60 * 1_000;
  const healthValidation = validateCapabilityResourceHealth({
    selected,
    evidence: selected.map((item) => ({
      resourceId: item.resourceId,
      descriptorDigest: item.descriptorDigest,
      healthState:
        params.currentResources.find(
          (resource) => resource.resourceId === item.resourceId,
        )?.healthState || 'unknown',
      observedAt: healthObservedAt,
      expiresAt: Number.isFinite(healthObservedAtMs)
        ? new Date(healthObservedAtMs + healthMaxAgeMs).toISOString()
        : '',
      maxAgeMs: healthMaxAgeMs,
    })),
    now: params.now || new Date(),
  });
  const firstGuardFailure = [
    inputValidation,
    resourceValidation,
    healthValidation,
  ].find((result) => !result.ok);
  if (firstGuardFailure && !firstGuardFailure.ok) {
    return transitionCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      expectedState: initial.state,
      toState: initial.state === 'sandbox_ready' ? 'paused' : 'indeterminate',
      actorKind: 'system',
      reason:
        'Capability input, resource, or freshness validation failed before execution.',
      evidenceRefs: [],
      idempotencyKey: `${initial.acquisitionId}:execution-guard:${firstGuardFailure.code}:${initial.recordVersion}`,
      now: params.now,
      mutate: () => ({
        lastOutcome: firstGuardFailure.code,
        sandboxEvidenceJson: capabilityMetadataJson({
          guardFailureCode: firstGuardFailure.code,
          invokedAfterPreflightFailure: false,
        }),
        nextSafeAction:
          'Repair or refresh the exact input and resource evidence before retrying.',
      }),
    });
  }
  if (
    (initial.expiresAt && initial.expiresAt <= now) ||
    (initial.revalidateAfterAt && initial.revalidateAfterAt <= now)
  ) {
    return transitionCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      expectedState: initial.state,
      toState: initial.state === 'sandbox_ready' ? 'paused' : 'indeterminate',
      actorKind: 'system',
      reason: 'Capability evidence expired before sandbox execution.',
      evidenceRefs: [],
      idempotencyKey: `${initial.acquisitionId}:sandbox-stale:${initial.recordVersion}`,
      now: params.now,
      mutate: () => ({
        lastOutcome: 'stale_state',
        nextSafeAction:
          'Refresh dependency evidence and revalidate the candidate before execution.',
      }),
    });
  }
  const resources = new Map(
    params.currentResources.map((resource) => [resource.resourceId, resource]),
  );
  for (const binding of contract.resourceBindings) {
    const resource = resources.get(binding.resourceId);
    if (
      !resource ||
      !resource.available ||
      resource.healthState !== 'healthy' ||
      !contract.compatibleResourceVersions[binding.resourceId]?.includes(
        resource.version,
      )
    ) {
      return transitionCapabilityAcquisition({
        acquisitionId: initial.acquisitionId,
        expectedState: initial.state,
        toState: initial.state === 'sandbox_ready' ? 'paused' : 'indeterminate',
        actorKind: 'system',
        reason:
          'Resource health or version drift invalidated the candidate before invocation.',
        evidenceRefs: resource?.sourceRefs || [],
        idempotencyKey: `${initial.acquisitionId}:drift:${binding.resourceId}:${resource?.version || 'missing'}`,
        now: params.now,
        mutate: () => ({
          environmentFingerprint: safeId(
            'environment',
            `${initial.environmentFingerprint}|${resource?.version || 'missing'}`,
          ),
          nextSafeAction:
            'Re-run discovery and full candidate validation against the current resource version.',
        }),
      });
    }
  }
  for (const required of contract.requiredInputs) {
    if (!(required in params.values)) {
      return transitionCapabilityAcquisition({
        acquisitionId: initial.acquisitionId,
        expectedState: initial.state,
        toState: initial.state === 'sandbox_ready' ? 'paused' : 'indeterminate',
        actorKind: 'system',
        reason: 'A required candidate input is missing before execution.',
        evidenceRefs: [],
        idempotencyKey: `${initial.acquisitionId}:missing-input:${sha256(required).slice(0, 16)}`,
        now: params.now,
        mutate: () => ({
          lastOutcome: 'missing_input',
          nextSafeAction: `Provide the required input ${safeText(required, 120)} before retrying.`,
        }),
      });
    }
  }
  const executionId = safeText(
    params.executionId || `sandbox:${contract.candidateFingerprint}`,
    220,
  );
  let preflight: Array<{
    step: CapabilityCandidateContract['steps'][number];
    binding: CapabilityExecutorBinding;
    evaluator: CapabilityEvaluatorBinding;
    authorization: CapabilityExecutionAuthorization | null;
    identity: ReturnType<typeof capabilityInvocationIdentity>;
    existing: CapabilityExecutionReceipt | null;
  }>;
  try {
    preflight = contract.steps.map((step) => {
      const binding = params.registry.resolveExecutor(step);
      const evaluator = params.registry.resolveEvaluator(step);
      const expectedVersion =
        contract.compatibleResourceVersions[step.resourceId]?.[0];
      if (
        binding.version !== expectedVersion ||
        evaluator.version !== expectedVersion
      ) {
        throw new Error(
          'Registered binding version drifted before invocation.',
        );
      }
      if (
        binding.networkAccess === 'external' ||
        (binding.networkAccess === 'loopback' &&
          params.networkPolicy === 'none')
      ) {
        throw new Error('Sandbox network policy denied a registered binding.');
      }
      if (
        binding.effectClass !== 'read_only' &&
        binding.effectClass !== 'sandbox_repository_write'
      ) {
        throw new Error(
          'Sandbox execution permits only read-only effects or the exact isolated repository effect.',
        );
      }
      const networkValidation = validateCapabilityNetworkCeiling({
        contractDataEgressClass: contract.dataEgressClass,
        acquisitionDataEgressClass: initial.dataEgressClass,
        requestedNetworkAccess: binding.networkAccess,
      });
      if (!networkValidation.ok) {
        throw new Error(
          `Capability network ceiling denied the binding: ${networkValidation.code}.`,
        );
      }
      if (step.actionClass === 'sandbox_repository_write') {
        if (
          binding.effectClass !== 'sandbox_repository_write' ||
          binding.networkAccess !== 'none'
        ) {
          throw new Error(
            'Sandbox repository writes must use the isolated fixture effect with no network access.',
          );
        }
        assertSandboxRepositoryBoundary({
          sandboxRoot: params.sandboxRoot,
          acquisitionId: initial.acquisitionId,
          candidateFingerprint: contract.candidateFingerprint,
          targetScopeHash: params.scope.targetScopeHash,
        });
        if (typeof binding.cleanup !== 'function') {
          throw new Error(
            'Sandbox repository write bindings require a registered cleanup verifier.',
          );
        }
      }
      const authorization = canonicalAuthorizationForStep({
        step,
        scope: params.scope,
        authorizations: params.authorizations,
        now,
      });
      const identity = capabilityInvocationIdentity({
        acquisitionId: initial.acquisitionId,
        contract,
        step,
        scope: params.scope,
        values: params.values,
        executionId,
      });
      const existing = findCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        candidateFingerprint: contract.candidateFingerprint,
        inputDigest: identity.inputDigest,
      });
      if (
        existing &&
        (existing.status !== 'succeeded' ||
          !existing.verificationFingerprint ||
          !existing.postStateFingerprint)
      ) {
        throw new Error(
          'A prior canonical receipt has uncertain or unverified effects.',
        );
      }
      return {
        step,
        binding,
        evaluator,
        authorization,
        identity,
        existing,
      };
    });
  } catch (error) {
    if (error instanceof DurableEffectExecutionClaimConflictError) {
      return getCapabilityAcquisition(initial.acquisitionId) || initial;
    }
    const receiptIds = listDurableEffectReceipts({
      workId: params.scope.workId,
      checkpointId: params.scope.checkpointId,
      limit: 1_000,
    }).map((receipt) => receipt.receiptId);
    return transitionCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      expectedState: initial.state,
      toState: initial.state === 'sandbox_ready' ? 'paused' : 'indeterminate',
      actorKind: 'system',
      reason:
        'Whole-plan preflight failed before any new capability effect was invoked.',
      evidenceRefs: receiptIds,
      idempotencyKey: `${initial.acquisitionId}:preflight-failed:${sha256(`${initial.recordVersion}|${error instanceof Error ? error.name : 'unknown'}`).slice(0, 24)}`,
      now: params.now,
      mutate: () => ({
        lastOutcome:
          initial.state === 'sandbox_ready'
            ? 'preflight_blocked'
            : 'indeterminate',
        sandboxEvidenceJson: capabilityMetadataJson({
          errorClass: error instanceof Error ? error.name : 'unknown_error',
          receiptIds,
          invokedAfterPreflightFailure: false,
        }),
        nextSafeAction:
          initial.state === 'sandbox_ready'
            ? 'Repair the binding, evaluator, authority, or scope evidence before retrying.'
            : 'Inspect canonical receipts before any retry.',
      }),
    });
  }
  let running = initial;
  if (initial.state === 'sandbox_ready') {
    running = transitionCapabilityAcquisition({
      acquisitionId: initial.acquisitionId,
      expectedState: 'sandbox_ready',
      toState: 'sandbox_running',
      actorKind: 'system',
      reason:
        'Whole-plan preflight passed before isolated registered execution.',
      evidenceRefs: [],
      idempotencyKey: `${initial.acquisitionId}:sandbox-running:${contract.candidateFingerprint}:${sha256(executionId).slice(0, 16)}`,
      now: params.now,
      mutate: () => ({
        nextSafeAction:
          'Verify every effect and postcondition before claiming success.',
      }),
    });
  }
  const receipts: CapabilityExecutionReceipt[] = [];
  const verificationReceipts: string[] = [];
  const evidenceRefs: string[] = [];
  const verifiedPostconditionCoverage = new Set<string>();
  let providerCalls = 0;
  let costUsd = 0;
  let cleanupVerified = true;
  for (const item of preflight) {
    const { step, binding, evaluator, authorization, identity, existing } =
      item;
    if (existing) {
      receipts.push(existing);
      verificationReceipts.push(existing.receiptId);
      evidenceRefs.push(existing.receiptId);
      for (const postcondition of step.expectedEvidence) {
        verifiedPostconditionCoverage.add(postcondition);
      }
      continue;
    }
    let started: CapabilityExecutionReceipt;
    try {
      started = recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'started',
        claimExecution: true,
        authorization,
        now: params.now,
      });
    } catch (error) {
      if (error instanceof DurableEffectExecutionClaimConflictError) {
        return getCapabilityAcquisition(running.acquisitionId) || running;
      }
      throw error;
    }
    let result: CapabilityBindingResult;
    try {
      result = await binding.execute({
        values: params.values,
        idempotencyKey: identity.idempotencyKey,
        sandboxRoot: params.sandboxRoot,
      });
    } catch (error) {
      const unknown = recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'unknown',
        authorization,
        now: params.now,
      });
      return transitionCapabilityAcquisition({
        acquisitionId: running.acquisitionId,
        expectedState: 'sandbox_running',
        toState: 'indeterminate',
        actorKind: 'system',
        reason:
          'The registered executor raised after its started receipt; effect status is unknown and replay is prohibited.',
        evidenceRefs: [unknown.receiptId],
        idempotencyKey: `${running.acquisitionId}:executor-unknown:${identity.idempotencyKey}`,
        now: params.now,
        mutate: () => ({
          sandboxEvidenceJson: capabilityMetadataJson({
            errorClass: error instanceof Error ? error.name : 'unknown_error',
            receiptIds: [unknown.receiptId],
            replayed: false,
          }),
          lastOutcome: 'indeterminate',
          nextSafeAction: 'Inspect the prior effect before any retry.',
        }),
      });
    }
    const resultValidation = validateCapabilityBindingResult({
      contract,
      declaredEffectClass: binding.effectClass,
      value: result,
    });
    if (!resultValidation.ok) {
      const unknown = recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'unknown',
        authorization,
        now: params.now,
      });
      receipts.push(unknown);
      return transitionCapabilityAcquisition({
        acquisitionId: running.acquisitionId,
        expectedState: 'sandbox_running',
        toState: 'indeterminate',
        actorKind: 'system',
        reason:
          'Binding returned an invalid, uncertain, or policy-inconsistent result; retry is prohibited.',
        evidenceRefs: [unknown.receiptId],
        idempotencyKey: `${running.acquisitionId}:invalid-effect-result:${identity.idempotencyKey}`,
        now: params.now,
        mutate: () => ({
          sandboxEvidenceJson: capabilityMetadataJson({
            receiptIds: [unknown.receiptId],
            guardFailureCode: resultValidation.code,
            replayed: false,
          }),
          nextSafeAction:
            'Inspect and reconcile the uncertain effect before any retry.',
        }),
      });
    }
    result = {
      ...result,
      evidenceRefs: result.evidenceRefs.map((item) => safeSourceRef(item)),
    };
    assertDurableActionEffectPolicy(binding.actionClass, result.effectClass);
    let verification: CapabilityVerificationResult;
    try {
      verification = await evaluator.verify({
        values: params.values,
        result,
        requiredPostconditions: step.expectedEvidence,
        recovery: false,
      });
    } catch (error) {
      const unknown = recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'unknown',
        preStateFingerprint: result.preStateFingerprint,
        postStateFingerprint: result.postStateFingerprint,
        authorization,
        now: params.now,
      });
      return transitionCapabilityAcquisition({
        acquisitionId: running.acquisitionId,
        expectedState: 'sandbox_running',
        toState: 'indeterminate',
        actorKind: 'system',
        reason:
          'The independent evaluator raised after a certain effect; verification is indeterminate.',
        evidenceRefs: [unknown.receiptId],
        idempotencyKey: `${running.acquisitionId}:evaluator-unknown:${identity.idempotencyKey}`,
        now: params.now,
        mutate: () => ({
          sandboxEvidenceJson: capabilityMetadataJson({
            errorClass: error instanceof Error ? error.name : 'unknown_error',
            receiptIds: [unknown.receiptId],
            replayed: false,
          }),
          lastOutcome: 'indeterminate',
          nextSafeAction:
            'Inspect the effect and rerun verification only; do not replay execution.',
        }),
      });
    }
    const verificationValidation = validateCapabilityVerificationResult({
      expectedEvidence: step.expectedEvidence,
      value: verification,
    });
    if (!verificationValidation.ok) {
      verification = {
        verified: false,
        evidenceRefs: [],
        verifiedPostconditions: [],
        reason: verificationValidation.reason,
      };
    } else {
      verification = {
        ...verification,
        evidenceRefs: verification.evidenceRefs.map((item) =>
          safeSourceRef(item),
        ),
        verifiedPostconditions: [...verification.verifiedPostconditions],
      };
    }
    if (
      !verification.verified ||
      !verification.postconditionFingerprint ||
      verification.evidenceRefs.length === 0
    ) {
      recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'failed',
        authorization,
        preStateFingerprint: result.preStateFingerprint,
        postStateFingerprint: result.postStateFingerprint,
        now: params.now,
      });
      return transitionCapabilityAcquisition({
        acquisitionId: running.acquisitionId,
        expectedState: 'sandbox_running',
        toState: 'failed',
        actorKind: 'system',
        reason: 'The independent evaluator rejected the postcondition.',
        evidenceRefs: verification.evidenceRefs,
        idempotencyKey: `${running.acquisitionId}:verification-failed:${identity.idempotencyKey}`,
        now: params.now,
        mutate: () => ({
          lastOutcome: 'verification_failure',
          sandboxEvidenceJson: capabilityMetadataJson({
            cleanupVerified: false,
            receiptIds: [started.receiptId],
            verified: false,
          }),
          nextSafeAction:
            'Revise the candidate or evaluator before another sandbox run.',
        }),
      });
    }
    for (const postcondition of verification.verifiedPostconditions) {
      verifiedPostconditionCoverage.add(postcondition);
    }
    if (binding.cleanup) {
      cleanupVerified = await binding.cleanup({
        values: params.values,
        result,
        sandboxRoot: params.sandboxRoot,
      });
    }
    if (!cleanupVerified) {
      recordCanonicalCapabilityReceipt({
        scope: params.scope,
        step,
        binding,
        invocationId: identity.invocationId,
        inputDigest: identity.inputDigest,
        candidateFingerprint: contract.candidateFingerprint,
        status: 'failed',
        authorization,
        postStateFingerprint: result.postStateFingerprint,
        now: params.now,
      });
      return transitionCapabilityAcquisition({
        acquisitionId: running.acquisitionId,
        expectedState: 'sandbox_running',
        toState: 'failed',
        actorKind: 'system',
        reason: 'Sandbox cleanup could not be verified.',
        evidenceRefs: [started.receiptId],
        idempotencyKey: `${running.acquisitionId}:cleanup-failed:${identity.idempotencyKey}`,
        now: params.now,
        mutate: () => ({
          lastOutcome: 'cleanup_failure',
          nextSafeAction:
            'Inspect and clean the isolated fixture before any retry.',
        }),
      });
    }
    const succeeded = recordCanonicalCapabilityReceipt({
      scope: params.scope,
      step,
      binding,
      invocationId: identity.invocationId,
      inputDigest: identity.inputDigest,
      candidateFingerprint: contract.candidateFingerprint,
      status: 'succeeded',
      authorization,
      preStateFingerprint: result.preStateFingerprint,
      postStateFingerprint: result.postStateFingerprint,
      verificationFingerprint: verification.postconditionFingerprint,
      now: params.now,
    });
    receipts.push(succeeded);
    verificationReceipts.push(succeeded.receiptId);
    evidenceRefs.push(
      succeeded.receiptId,
      ...result.evidenceRefs,
      ...verification.evidenceRefs,
    );
    providerCalls += result.providerCalls || 0;
    costUsd += result.costUsd || 0;
  }
  const uncoveredPostconditions = contract.successPostconditions.filter(
    (postcondition) => !verifiedPostconditionCoverage.has(postcondition),
  );
  if (uncoveredPostconditions.length > 0) {
    return transitionCapabilityAcquisition({
      acquisitionId: running.acquisitionId,
      expectedState: 'sandbox_running',
      toState: 'failed',
      actorKind: 'system',
      reason:
        'Step-scoped evaluator evidence did not cover every candidate success postcondition.',
      evidenceRefs: receipts.map((receipt) => receipt.receiptId),
      idempotencyKey: `${running.acquisitionId}:postcondition-coverage:${contract.candidateFingerprint}`,
      now: params.now,
      mutate: () => ({
        sandboxEvidenceJson: capabilityMetadataJson({
          falseSuccesses: 0,
          postconditionVerified: false,
          receiptIds: receipts.map((receipt) => receipt.receiptId),
          uncoveredPostconditionCount: uncoveredPostconditions.length,
          verified: false,
        }),
        lastOutcome: 'postcondition_coverage_failed',
        nextSafeAction:
          'Correct the step evidence contract and rerun in a new bounded candidate.',
      }),
    });
  }
  const durableWork = getDurableWorkUnit(params.scope.workId);
  const terminalPostState = receipts.at(-1)?.postStateFingerprint;
  if (!durableWork || !terminalPostState) {
    throw new Error(
      'Sandbox verification requires canonical durable work and a terminal post-state fingerprint.',
    );
  }
  const completedCheckpoint = commitDurableCheckpointCAS({
    workId: durableWork.workId,
    expectedWorkVersion: durableWork.version,
    completedNodeIds: contract.steps.map((step) => step.stepId),
    pendingNodeIds: [],
    uncertainNodeIds: [],
    dependencyIds: contract.resourceBindings.map(
      (binding) =>
        `capability-resource:${sha256(binding.resourceId).slice(0, 32)}`,
    ),
    worldSignals: {
      fresh: contract.resourceBindings.map(
        (binding) =>
          `resource-health:${sha256(binding.resourceId).slice(0, 32)}`,
      ),
    },
    executorScopeKey: contract.candidateFingerprint,
    targetScopeKey: params.scope.targetScopeKey,
    preStateFingerprint: receipts[0]?.preStateFingerprint,
    verifiedPostStateFingerprint: terminalPostState,
    receiptIds: receipts.map((receipt) => receipt.receiptId),
    verificationRequirementIds: contract.verifierBindingIds.map(
      (verifierId) => `capability-verifier:${sha256(verifierId).slice(0, 32)}`,
    ),
    retryBudget: 1,
    attemptsUsed: 1,
    stopConditionIds: [
      'approval_or_scope_mismatch',
      'unknown_effect',
      'postcondition_failure',
    ],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction:
      'Use the completed checkpoint as the only sandbox verification authority.',
    status: 'completed',
    now: params.now,
  });
  let terminalWork = completedCheckpoint.work;
  if (terminalWork.status !== 'verifying') {
    terminalWork = transitionDurableWork({
      workId: terminalWork.workId,
      expectedVersion: terminalWork.version,
      toStatus: 'verifying',
      nextAction: 'Verify the completed canonical sandbox checkpoint.',
      now: params.now,
    });
  }
  transitionDurableWork({
    workId: terminalWork.workId,
    expectedVersion: terminalWork.version,
    toStatus: 'completed',
    nextAction: 'Sandbox postcondition and cleanup are durably verified.',
    now: params.now,
  });
  return transitionCapabilityAcquisition({
    acquisitionId: running.acquisitionId,
    expectedState: 'sandbox_running',
    toState: 'sandbox_verified',
    actorKind: 'system',
    reason:
      'Every step has a causally later verified postcondition and cleanup proof.',
    evidenceRefs,
    idempotencyKey: `${running.acquisitionId}:sandbox-verified:${contract.candidateFingerprint}`,
    canonicalGuard: {
      kind: 'sandbox_completion',
      durableWorkId: params.scope.workId,
      checkpointId: completedCheckpoint.checkpoint.durableCheckpointId,
      candidateFingerprint: contract.candidateFingerprint,
      receiptIds: receipts.map((item) => item.receiptId),
    },
    now: params.now,
    mutate: () => ({
      sandboxEvidenceJson: capabilityMetadataJson({
        cleanupVerified: true,
        costUsd,
        duplicateEffects: 0,
        falseSuccesses: 0,
        networkDenied: true,
        postconditionVerified: true,
        providerCalls,
        receiptIds: receipts.map((item) => item.receiptId),
        unauthorizedEffects: 0,
        verificationReceiptIds: verificationReceipts,
        verified: true,
      }),
      lastOutcome: 'sandbox_verified',
      nextSafeAction:
        'Run independently authored held-out cases, then require owner review before a live canary.',
    }),
  });
}

export interface ActiveCapabilityExecutionResult {
  status: 'verified' | 'blocked' | 'indeterminate' | 'failed';
  acquisitionId: string;
  candidateFingerprint: string;
  results: unknown[];
  evidenceRefs: string[];
  receiptIds: string[];
  providerCalls: number;
  costUsd: number;
  reason: string;
}

export async function executeActiveCapability(params: {
  acquisitionId: string;
  executionId: string;
}): Promise<ActiveCapabilityExecutionResult> {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (
    !current ||
    (current.state !== 'active' && current.state !== 'monitoring')
  ) {
    throw new Error(
      'Production capability execution requires canonical active or monitoring state.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    current.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  return {
    status: 'blocked',
    acquisitionId: current.acquisitionId,
    candidateFingerprint: contract.candidateFingerprint,
    results: [],
    evidenceRefs: [],
    receiptIds: [],
    providerCalls: 0,
    costUsd: 0,
    reason:
      'canonical_live_execution_work_and_owner_activation_are_not_yet_available',
  };
}

export function prepareCapabilitySandbox(params: {
  acquisitionId: string;
  now?: Date;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current) throw new Error('Capability acquisition was not found.');
  if (
    current.state === 'sandbox_ready' ||
    current.state === 'sandbox_running' ||
    current.state === 'sandbox_verified'
  ) {
    return current;
  }
  if (current.state === 'candidate_designed') {
    const contract = parseCapabilityJson<CapabilityCandidateContract>(
      current.candidateContractJson,
      'candidateContractJson',
    );
    assertCapabilityCandidateContract(contract);
    if (contract.steps.some((step) => step.approvalRequired)) {
      return transitionCapabilityAcquisition({
        acquisitionId: current.acquisitionId,
        expectedState: 'candidate_designed',
        toState: 'owner_review_required',
        actorKind: 'system',
        reason: 'Approval-bound sandbox scope requires exact owner review.',
        evidenceRefs: [],
        idempotencyKey: `${current.acquisitionId}:sandbox-owner-review`,
        now: params.now,
        mutate: () => ({
          nextSafeAction: 'Review the exact sandbox target and action class.',
        }),
      });
    }
    return transitionCapabilityAcquisition({
      acquisitionId: current.acquisitionId,
      expectedState: 'candidate_designed',
      toState: 'sandbox_ready',
      actorKind: 'system',
      reason: 'Read-only/local reversible candidate is ready for isolation.',
      evidenceRefs: [],
      idempotencyKey: `${current.acquisitionId}:sandbox-ready`,
      now: params.now,
      mutate: () => ({
        nextSafeAction: 'Execute only registered bindings in isolated storage.',
      }),
    });
  }
  if (current.state === 'owner_review_required') {
    const contract = parseCapabilityJson<CapabilityCandidateContract>(
      current.candidateContractJson,
      'candidateContractJson',
    );
    assertCapabilityCandidateContract(contract);
    if (contract.steps.some((step) => step.approvalRequired)) return current;
  }
  throw new Error(
    'Capability acquisition is not ready for sandbox preparation; approval-bound work requires canonical durable approval.',
  );
}

export function recordCapabilityHeldOutEvidence(params: {
  acquisitionId: string;
  evidence: {
    passed: boolean;
    cases: number;
    safetyInvariantRate: number;
    falseSuccesses: number;
    evidenceRefs: string[];
  };
  actorKind: 'system' | 'certification';
  now?: Date;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current || current.state !== 'sandbox_verified') {
    throw new Error(
      'Held-out evidence requires a canonically verified sandbox acquisition.',
    );
  }
  if (params.actorKind === 'certification') {
    assertHermeticCapabilityCertificationProcess();
  }
  if (
    !Number.isInteger(params.evidence.cases) ||
    params.evidence.cases <= 0 ||
    params.evidence.cases > 10_000 ||
    params.evidence.evidenceRefs.length === 0
  ) {
    throw new Error(
      'Held-out evidence requires bounded cases and nonempty provenance.',
    );
  }
  const evidenceRefs = params.evidence.evidenceRefs.map((item) =>
    safeSourceRef(item),
  );
  const evidence = { ...params.evidence, evidenceRefs };
  const toState: CapabilityAcquisitionState = 'owner_review_required';
  return transitionCapabilityAcquisition({
    acquisitionId: params.acquisitionId,
    expectedState: 'sandbox_verified',
    toState,
    actorKind: params.actorKind,
    reason: params.evidence.passed
      ? 'Independent held-out evaluation passed without authority expansion.'
      : 'Held-out evaluation requires owner review and remediation.',
    evidenceRefs,
    idempotencyKey: `${params.acquisitionId}:heldout:${sha256(capabilityMetadataJson(evidence)).slice(0, 16)}`,
    now: params.now,
    mutate: () => ({
      heldOutEvidenceJson: capabilityMetadataJson(evidence),
      nextSafeAction:
        'Owner must review the evidence before any canary; certification self-attestation never advances readiness.',
    }),
  });
}

export function approveCapabilityCanary(params: {
  acquisitionId: string;
  ownerReviewSignalId: string;
}): CapabilityAcquisitionRecord {
  void params;
  throw new Error(
    'Capability canary approval requires an exact canonical durable approval packet; a review identifier alone is not authority.',
  );
}

export function recordCapabilityCanaryOutcome(params: {
  acquisitionId: string;
  durableWorkId: string;
  outcomeId: string;
  ownerReviewSignalId: string;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current || current.state !== 'canary_ready') {
    throw new Error('Live canary evidence requires canary_ready state.');
  }
  void params.durableWorkId;
  void params.outcomeId;
  void params.ownerReviewSignalId;
  throw new Error(
    'Capability canary evidence must be projected from completed canonical durable work and a live owner-review signal; caller-supplied receipt or health claims are rejected.',
  );
}

export function activateVerifiedCapability(params: {
  acquisitionId: string;
  activationWorkId: string;
  canaryWorkId: string;
  outcomeId: string;
  ownerReviewSignalId: string;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current || current.state !== 'canary_ready') {
    throw new Error('Capability activation requires canary_ready state.');
  }
  void params.activationWorkId;
  void params.canaryWorkId;
  void params.outcomeId;
  void params.ownerReviewSignalId;
  throw new Error(
    'Capability activation requires a consumed exact-scope activation grant, active lease, completed canary work, confirmed canonical outcome, owner signal, and fresh dependency evidence; activation is closed until that atomic join is available.',
  );
}

export type CapabilityOutcomeVerdict =
  | 'verified'
  | 'partial'
  | 'honestly_blocked'
  | 'corrected'
  | 'rejected'
  | 'approval_violation'
  | 'privacy_violation'
  | 'stale_state'
  | 'verification_failure';

export function recordCapabilityOutcome(params: {
  acquisitionId: string;
  durableWorkId: string;
  outcomeId: string;
  ownerReviewSignalId: string;
}): CapabilityAcquisitionRecord {
  const current = getCapabilityAcquisition(params.acquisitionId);
  if (!current) throw new Error('Capability acquisition was not found.');
  if (!['active', 'monitoring'].includes(current.state)) {
    throw new Error(
      'Only active or monitoring capabilities can record production outcomes.',
    );
  }
  void params.durableWorkId;
  void params.outcomeId;
  void params.ownerReviewSignalId;
  throw new Error(
    'Capability learning accepts only a canonical outcome and owner-review signal joined to completed durable work; caller-authored verdicts and confirmation booleans are rejected.',
  );
}

export function projectCapabilityAcquisitionSkill(
  record: CapabilityAcquisitionRecord,
): SkillPlaybookRecord | null {
  if (!record.compiledSkillId || record.candidateContractJson === 'null') {
    return null;
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    record.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  const active = record.state === 'active' || record.state === 'monitoring';
  const paused = record.state === 'paused' || record.state === 'quarantined';
  const skill: SkillPlaybookRecord = {
    skillId: record.compiledSkillId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    groupFolder: record.groupFolder || null,
    title: contract.title,
    triggerPattern: contract.triggerSemantics.join('; '),
    taskFamily: record.taskFamily,
    requiredContextJson: capabilityMetadataJson({
      required: contract.requiredInputs,
    }),
    allowedActionsJson: capabilityMetadataJson(contract.allowedActions),
    disallowedActionsJson: capabilityMetadataJson(contract.prohibitedActions),
    approvalRequirementsJson: capabilityMetadataJson(
      contract.approvalRequirements,
    ),
    expectedToolsJson: capabilityMetadataJson(
      contract.steps.map((step) => step.bindingId),
    ),
    fallbackPlan:
      contract.fallbackPaths[0] || 'Stop honestly and report the blocker.',
    successCriteriaJson: capabilityMetadataJson(contract.successPostconditions),
    evalScenariosJson: capabilityMetadataJson([
      ...contract.deterministicScenarioIds,
      ...contract.heldOutScenarioIds,
    ]),
    usageCount: parseArray(record.outcomeIdsJson, 'outcomeIdsJson').length,
    lastOutcome: record.lastOutcome,
    reliabilityScore: Math.max(
      0.1,
      Math.min(0.99, record.confidence - record.negativeOutcomeCount * 0.15),
    ),
    status: active ? 'active' : paused ? 'paused' : 'suggested',
    sourceDistillationId: null,
    nextAction: active
      ? 'Use only the exact compiled binding; every side effect still requires its normal approval.'
      : paused
        ? 'Canonical acquisition is paused or quarantined; do not execute this projection.'
        : 'Canonical acquisition has not passed live activation; keep this as a reviewable suggestion.',
    privacyJson: capabilityMetadataJson({
      ...PRIVACY,
      capabilityAcquisitionId: record.acquisitionId,
      candidateFingerprint: contract.candidateFingerprint,
      projectionOnly: true,
    }),
  };
  upsertSkillPlaybook(skill);
  return skill;
}

export interface CapabilityAcquisitionReport {
  generatedAt: string;
  records: CapabilityAcquisitionRecord[];
  counts: Record<CapabilityAcquisitionState, number>;
  recentTransitions: CapabilityAcquisitionTransitionRecord[];
  nextAction: string;
  privacy: typeof PRIVACY;
}

export function buildCapabilityAcquisitionReport(params: {
  groupFolder: string;
  now?: Date;
}): CapabilityAcquisitionReport {
  if (!params.groupFolder) {
    throw new Error('Capability report requires an explicit group scope.');
  }
  const records = listCapabilityAcquisitions({
    groupFolder: params.groupFolder,
    limit: 100,
  }).filter((record) => record.groupFolder === params.groupFolder);
  const states: CapabilityAcquisitionState[] = [
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
  ];
  const counts = Object.fromEntries(
    states.map((state) => [
      state,
      records.filter((record) => record.state === state).length,
    ]),
  ) as Record<CapabilityAcquisitionState, number>;
  const recentTransitions = records
    .flatMap((record) =>
      listCapabilityAcquisitionTransitions(record.acquisitionId),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 30);
  return {
    generatedAt: iso(params.now),
    records,
    counts,
    recentTransitions,
    nextAction:
      records.find((record) =>
        [
          'owner_review_required',
          'externally_blocked',
          'failed',
          'indeterminate',
          'quarantined',
        ].includes(record.state),
      )?.nextSafeAction ||
      'Use Andrea normally; create a gap only when a concrete postcondition is unsupported.',
    privacy: PRIVACY,
  };
}

export function formatCapabilityAcquisitionReport(
  report: CapabilityAcquisitionReport,
): string {
  const active = report.counts.active + report.counts.monitoring;
  const proving =
    report.counts.sandbox_ready +
    report.counts.sandbox_running +
    report.counts.sandbox_verified +
    report.counts.canary_ready;
  const blocked =
    report.counts.externally_blocked +
    report.counts.failed +
    report.counts.indeterminate +
    report.counts.quarantined;
  return [
    '*Verified Capability Acquisition*',
    `Tracked: ${report.records.length}`,
    `Active/monitoring: ${active}`,
    `In verification: ${proving}`,
    `Blocked/quarantined: ${blocked}`,
    '',
    '*Recent capabilities*',
    ...(report.records.length
      ? report.records
          .slice(0, 8)
          .map(
            (record) =>
              `- ${record.targetOutcome}: ${record.state}; gap=${record.gapKind}; authority gained=none; next=${record.nextSafeAction}`,
          )
      : ['- none']),
    '',
    `Next: ${report.nextAction}`,
    'Privacy: structured metadata and provenance only; no raw messages, documents, credentials, or hidden reasoning.',
  ].join('\n');
}
