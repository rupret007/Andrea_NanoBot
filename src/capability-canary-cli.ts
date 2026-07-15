import { createHash } from 'node:crypto';

import {
  assertCapabilityCandidateContract,
  canonicalCapabilityJson,
  parseCapabilityJson,
} from './capability-acquisition-policy.js';
import { validateCapabilityCandidateInput } from './capability-execution-guard.js';
import {
  durableScopeHash,
  type DurableWorkBindingInput,
} from './durable-work-continuity.js';
import { assertValidGroupFolder } from './group-folder.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityHealthEvidenceRecord,
  CapabilityOwnerReviewRecord,
  CapabilityProductionRunRecord,
  CapabilityProductionTransitionReceipt,
  CapabilityResourceDescriptor,
  CognitiveApprovalPacket,
  ReliabilityObservation,
} from './types.js';
import type {
  CapabilityApprenticeshipStatus,
  CapabilityCanaryHealthBinding,
  CapabilityProductionExecutionResult,
  StageCapabilityCanaryInput,
} from './production-capability-apprenticeship.js';

const OPEN_RUN_STATUSES: CapabilityProductionRunRecord['status'][] = [
  'proposed',
  'awaiting_canary_approval',
  'awaiting_action_approval',
  'canary_ready',
  'running',
  'awaiting_owner_review',
  'owner_reviewed',
  'awaiting_activation_approval',
  'active',
  'monitoring',
  'paused',
];

const MUTATION_ONLY_FLAGS = new Set([
  '--owner-id',
  '--chat-id',
  '--channel',
  '--authorized-surface',
  '--target-scope',
  '--inputs-json',
  '--health-json',
  '--run-id',
  '--expected-acquisition-version',
  '--expected-run-revision',
  '--worker-id',
]);

export type CapabilityCanaryCliOperation =
  | 'inspect'
  | 'stage'
  | 'authorize_canary'
  | 'stage_action_approval'
  | 'authorize_action'
  | 'run_canary'
  | 'stage_activation'
  | 'activate';

export interface CapabilityCanaryCliOptions {
  help: boolean;
  json: boolean;
  releaseReadiness: boolean;
  stage: boolean;
  authorizeCanary: boolean;
  stageActionApproval: boolean;
  authorizeAction: boolean;
  runCanary: boolean;
  stageActivation: boolean;
  activate: boolean;
  operation: CapabilityCanaryCliOperation;
  groupFolder: string;
  groupWasExplicit: boolean;
  acquisitionId: string | null;
  runId: string | null;
  expectedAcquisitionVersion: number | null;
  expectedRunRevision: number | null;
  workerId: string | null;
  ownerId: string | null;
  chatId: string | null;
  channel: string | null;
  authorizedSurface: string | null;
  targetScopeKey: string | null;
  normalizedInputs: Record<string, unknown> | null;
  health: CapabilityCanaryHealthBinding[] | null;
}

export interface CapabilityCanaryCliDependencies {
  listAcquisitions(params: {
    groupFolder?: string | null;
    states?: CapabilityAcquisitionRecord['state'][];
    limit?: number;
  }): CapabilityAcquisitionRecord[];
  listRuns(params: {
    groupFolder?: string;
    statuses?: CapabilityProductionRunRecord['status'][];
    limit?: number;
  }): CapabilityProductionRunRecord[];
  listRunHealth(runId: string): CapabilityHealthEvidenceRecord[];
  listApprovals(params: {
    groupFolder?: string;
    limit?: number;
  }): CognitiveApprovalPacket[];
  listReliabilityObservations(params: {
    limit?: number;
  }): ReliabilityObservation[];
  getRun(runId: string): CapabilityProductionRunRecord | undefined;
  getOwnerReview(runId: string): CapabilityOwnerReviewRecord | undefined;
  getCurrentActionApproval(
    run: CapabilityProductionRunRecord,
  ): CognitiveApprovalPacket | undefined;
  getStatus(acquisitionId: string): CapabilityApprenticeshipStatus;
  contractDigest(candidateContractJson: string): string;
  healthEvidenceSetDigest(
    evidence: readonly CapabilityHealthEvidenceRecord[],
  ): string;
  buildReleaseReadinessContract(): CapabilityCandidateContract;
  buildReleaseReadinessResource(): CapabilityResourceDescriptor;
  isTrustedBinding(input: {
    binding: DurableWorkBindingInput;
    authorizedSurface: string;
  }): boolean;
  stageCanary(input: StageCapabilityCanaryInput): {
    run: CapabilityProductionRunRecord;
    approval: CognitiveApprovalPacket;
  };
  authorizeCanary(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    authorizedSurface: string;
    binding: DurableWorkBindingInput;
    workerId: string;
  }): {
    acquisition: CapabilityAcquisitionRecord;
    run: CapabilityProductionRunRecord;
    receipt: CapabilityProductionTransitionReceipt;
  };
  stageActionApproval(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    binding: DurableWorkBindingInput;
  }): {
    run: CapabilityProductionRunRecord;
    approval: CognitiveApprovalPacket;
  };
  authorizeAction(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    binding: DurableWorkBindingInput;
    workerId: string;
  }): {
    run: CapabilityProductionRunRecord;
    approval: CognitiveApprovalPacket;
  };
  executeCanary(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    binding: DurableWorkBindingInput;
    workerId: string;
    values: Record<string, unknown>;
  }): Promise<CapabilityProductionExecutionResult>;
  stageActivation(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    authorizedSurface: string;
    binding: DurableWorkBindingInput;
  }): {
    run: CapabilityProductionRunRecord;
    approval: CognitiveApprovalPacket;
  };
  authorizeActivation(input: {
    runId: string;
    expectedAcquisitionVersion: number;
    expectedRunRevision: number;
    authorizedSurface: string;
    binding: DurableWorkBindingInput;
    workerId: string;
  }): {
    acquisition: CapabilityAcquisitionRecord;
    run: CapabilityProductionRunRecord;
    receipt: CapabilityProductionTransitionReceipt;
  };
  now(): string;
}

interface ResourceSnapshot {
  resourceId: string;
  version: string;
  descriptorDigest: string | null;
  healthState: string;
  reliabilityScore: number | null;
}

interface CapabilityApprovalPresentation {
  approvalPacketId: string;
  status: CognitiveApprovalPacket['status'];
  version: number;
  channel: string | null;
  expiresAt: string | null;
  scopeDigest: string | null;
  summary: string;
  summaryDigest: string | null;
  approvalCommand: string | null;
  targetScopeDigest: string | null;
}

export interface CapabilityCanaryAcquisitionPresentation {
  acquisitionId: string;
  state: CapabilityAcquisitionRecord['state'];
  recordVersion: number;
  title: string;
  taskFamily: string;
  targetOutcome: string;
  candidateFingerprint: string;
  contractVersion: number;
  implementationKind: string;
  requiredInputs: string[];
  optionalInputs: string[];
  resources: ResourceSnapshot[];
  steps: Array<{
    stepId: string;
    bindingId: string;
    operationId: string;
    evaluatorId: string;
    resourceId: string;
    resourceVersion: string;
    actionClass: string;
    readOnly: boolean;
    approvalRequired: boolean;
  }>;
  dataEgress: {
    acquisition: string;
    contract: string;
  };
  authorityRequirements: unknown;
  approvalRequirements: string[];
  credentialRequirements: string[];
  allowedActions: string[];
  prohibitedActions: string[];
  successPostconditions: string[];
  expectedCostBand: string;
  expectedLatencyBand: string;
  nextSafeAction: string;
  pendingAction:
    | CapabilityApprenticeshipStatus['pendingAction']
    | 'canary_staging';
}

export interface CapabilityCanaryRunPresentation {
  runId: string;
  acquisitionId: string;
  runKind: CapabilityProductionRunRecord['runKind'];
  status: CapabilityProductionRunRecord['status'];
  revision: number;
  candidateFingerprint: string;
  contractVersion: number;
  contractDigest: string;
  taskFamily: string;
  ownerScopeHash: string;
  chatScopeHash: string;
  groupScopeHash: string;
  channel: string;
  authorizedSurface: string;
  targetScopeHash: string;
  inputDigest: string;
  actionClass: string;
  workId: string;
  workVersion: number;
  planVersion: number;
  checkpointId: string;
  invocationId: string;
  outcomeId: string | null;
  ownerReviewId: string | null;
  healthEvidenceSetDigest: string | null;
  expiresAt: string;
  nextSafeAction: string;
  canaryApproval: CapabilityApprovalPresentation | null;
  actionApproval: CapabilityApprovalPresentation | null;
  activationApproval: CapabilityApprovalPresentation | null;
  health: Array<{
    resourceId: string;
    resourceVersion: string;
    subjectId: string;
    observationId: string;
    observedAt: string;
    expiresAt: string;
  }>;
}

export interface ReleaseReadinessCandidatePresentation {
  status: 'presentation_only_pending_canonical_acquisition';
  title: string;
  capabilityId: string;
  skillId: string;
  taskFamily: string;
  contractVersion: number;
  candidateFingerprint: string;
  triggerSemantics: string[];
  resources: CapabilityCandidateContract['resourceBindings'];
  steps: CapabilityCandidateContract['steps'];
  dataEgressClass: string;
  allowedActions: string[];
  prohibitedActions: string[];
  successPostconditions: string[];
  verificationProcedure: string[];
  note: string;
}

export interface CapabilityCanaryCliReport {
  generatedAt: string;
  mode: CapabilityCanaryCliOperation;
  groupFolder: string;
  selectedAcquisitionId: string | null;
  selectedAcquisition: CapabilityCanaryAcquisitionPresentation | null;
  eligibleAcquisitions: CapabilityCanaryAcquisitionPresentation[];
  openRuns: CapabilityCanaryRunPresentation[];
  recentHealthObservations: Array<{
    observationId: string;
    subjectId: string;
    observedAt: string;
    outcome: string;
    confidence: number;
    fallbackUsed: boolean;
  }>;
  releaseReadinessCandidate: ReleaseReadinessCandidatePresentation | null;
  staged: null | {
    acquisitionId: string;
    runId: string;
    runStatus: string;
    acquisitionState: string;
    approvalPacketId: string;
    approvalVersion: number;
    approvalStatus: string;
    approvalSummary: string;
    approvalScopeDigest: string;
    approvalSummaryDigest: string;
    approvalCommand: string;
    nextSafeAction: string;
  };
  action: null | {
    operation: Exclude<CapabilityCanaryCliOperation, 'inspect' | 'stage'>;
    acquisitionId: string;
    acquisitionState: CapabilityAcquisitionRecord['state'];
    acquisitionVersion: number;
    runId: string;
    runStatus: CapabilityProductionRunRecord['status'];
    runRevision: number;
    transitionReceiptId: string | null;
    approvalPacketId: string | null;
    approvalVersion: number | null;
    approvalStatus: CognitiveApprovalPacket['status'] | null;
    approvalSummary: string | null;
    approvalScopeDigest: string | null;
    approvalSummaryDigest: string | null;
    approvalCommand: string | null;
    executionStatus: CapabilityProductionExecutionResult['status'] | null;
    executionReceiptIds: string[];
    evidenceRefs: string[];
    providerCalls: number;
    costUsd: number;
    latencyMs: number;
    ownerReviewId: string | null;
    nextSafeAction: string;
  };
  guardrails: string[];
  nextCommands: string[];
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function safeCliValue(value: string, label: string, maxLength = 512): string {
  const normalized = String(value || '').trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new Error(`Invalid ${label}.`);
  }
  return normalized;
}

function parseObject(value: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${flag} must contain valid JSON.`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must contain one JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseHealth(value: string): CapabilityCanaryHealthBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('--health-json must contain valid JSON.', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    throw new Error('--health-json must contain 1 to 32 health bindings.');
  }
  const result = parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Health binding ${index + 1} must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join(',') !== 'expiresAt,observationId,resourceId') {
      throw new Error(
        `Health binding ${index + 1} must contain only resourceId, observationId, and expiresAt.`,
      );
    }
    const expiresAt = safeCliValue(
      String(record.expiresAt || ''),
      'health expiry',
    );
    if (!Number.isFinite(Date.parse(expiresAt))) {
      throw new Error(`Health binding ${index + 1} has an invalid expiresAt.`);
    }
    return {
      resourceId: safeCliValue(
        String(record.resourceId || ''),
        'health resource ID',
      ),
      observationId: safeCliValue(
        String(record.observationId || ''),
        'health observation ID',
      ),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  });
  if (
    new Set(result.map((item) => item.resourceId)).size !== result.length ||
    new Set(result.map((item) => item.observationId)).size !== result.length
  ) {
    throw new Error('Health resource and observation IDs must be unique.');
  }
  return result;
}

export function parseCapabilityCanaryArgs(
  args: string[],
): CapabilityCanaryCliOptions {
  const options: CapabilityCanaryCliOptions = {
    help: false,
    json: false,
    releaseReadiness: false,
    stage: false,
    authorizeCanary: false,
    stageActionApproval: false,
    authorizeAction: false,
    runCanary: false,
    stageActivation: false,
    activate: false,
    operation: 'inspect',
    groupFolder: 'main',
    groupWasExplicit: false,
    acquisitionId: null,
    runId: null,
    expectedAcquisitionVersion: null,
    expectedRunRevision: null,
    workerId: null,
    ownerId: null,
    chatId: null,
    channel: null,
    authorizedSurface: null,
    targetScopeKey: null,
    normalizedInputs: null,
    health: null,
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag) && !['--json', '--help'].includes(flag)) {
      throw new Error(`${flag} may be provided only once.`);
    }
    seen.add(flag);
    switch (flag) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '--release-readiness':
        options.releaseReadiness = true;
        break;
      case '--stage':
        options.stage = true;
        break;
      case '--authorize-canary':
        options.authorizeCanary = true;
        break;
      case '--stage-action-approval':
        options.stageActionApproval = true;
        break;
      case '--authorize-action':
        options.authorizeAction = true;
        break;
      case '--run-canary':
        options.runCanary = true;
        break;
      case '--stage-activation':
        options.stageActivation = true;
        break;
      case '--activate':
        options.activate = true;
        break;
      case '--group':
        options.groupFolder = safeCliValue(
          requireFlagValue(args, index, flag),
          'group folder',
          64,
        );
        options.groupWasExplicit = true;
        index += 1;
        break;
      case '--acquisition':
        options.acquisitionId = safeCliValue(
          requireFlagValue(args, index, flag),
          'acquisition ID',
        );
        index += 1;
        break;
      case '--run-id':
        options.runId = safeCliValue(
          requireFlagValue(args, index, flag),
          'production run ID',
        );
        index += 1;
        break;
      case '--expected-acquisition-version':
        options.expectedAcquisitionVersion = parsePositiveInteger(
          requireFlagValue(args, index, flag),
          flag,
        );
        index += 1;
        break;
      case '--expected-run-revision':
        options.expectedRunRevision = parsePositiveInteger(
          requireFlagValue(args, index, flag),
          flag,
        );
        index += 1;
        break;
      case '--worker-id':
        options.workerId = safeCliValue(
          requireFlagValue(args, index, flag),
          'worker ID',
        );
        index += 1;
        break;
      case '--owner-id':
        options.ownerId = safeCliValue(
          requireFlagValue(args, index, flag),
          'owner ID',
        );
        index += 1;
        break;
      case '--chat-id':
        options.chatId = safeCliValue(
          requireFlagValue(args, index, flag),
          'chat ID',
        );
        index += 1;
        break;
      case '--channel':
        options.channel = safeCliValue(
          requireFlagValue(args, index, flag),
          'channel',
          64,
        );
        index += 1;
        break;
      case '--authorized-surface':
        options.authorizedSurface = safeCliValue(
          requireFlagValue(args, index, flag),
          'authorized surface',
          64,
        );
        index += 1;
        break;
      case '--target-scope':
        options.targetScopeKey = safeCliValue(
          requireFlagValue(args, index, flag),
          'target scope',
        );
        index += 1;
        break;
      case '--inputs-json':
        options.normalizedInputs = parseObject(
          requireFlagValue(args, index, flag),
          flag,
        );
        index += 1;
        break;
      case '--health-json':
        options.health = parseHealth(requireFlagValue(args, index, flag));
        index += 1;
        break;
      default:
        throw new Error(`Unknown capability-canary option: ${flag}`);
    }
  }
  assertValidGroupFolder(options.groupFolder);
  if (options.help) return options;
  const selectedOperations: CapabilityCanaryCliOperation[] = [
    options.stage && 'stage',
    options.authorizeCanary && 'authorize_canary',
    options.stageActionApproval && 'stage_action_approval',
    options.authorizeAction && 'authorize_action',
    options.runCanary && 'run_canary',
    options.stageActivation && 'stage_activation',
    options.activate && 'activate',
  ].filter(Boolean) as CapabilityCanaryCliOperation[];
  if (selectedOperations.length > 1) {
    throw new Error('Capability mutation operations are mutually exclusive.');
  }
  options.operation = selectedOperations[0] || 'inspect';
  if (options.operation !== 'inspect' && options.releaseReadiness) {
    throw new Error(
      '--release-readiness presentation and mutation operations are separate.',
    );
  }
  if (options.operation === 'inspect') {
    const suppliedMutationFlag = args.find((flag) =>
      MUTATION_ONLY_FLAGS.has(flag),
    );
    if (suppliedMutationFlag) {
      throw new Error(
        `${suppliedMutationFlag} requires an explicit mutation operation.`,
      );
    }
    return options;
  }
  const missing = [
    !options.acquisitionId && '--acquisition',
    !options.groupWasExplicit && '--group',
    !options.expectedAcquisitionVersion && '--expected-acquisition-version',
    !options.ownerId && '--owner-id',
    !options.chatId && '--chat-id',
    !options.channel && '--channel',
    !options.authorizedSurface && '--authorized-surface',
    !options.targetScopeKey && '--target-scope',
    !options.normalizedInputs && '--inputs-json',
    !options.health && '--health-json',
  ].filter(Boolean) as string[];
  if (options.operation !== 'stage') {
    if (!options.runId) missing.push('--run-id');
    if (!options.expectedRunRevision) missing.push('--expected-run-revision');
  }
  if (
    ['authorize_canary', 'authorize_action', 'run_canary', 'activate'].includes(
      options.operation,
    ) &&
    !options.workerId
  ) {
    missing.push('--worker-id');
  }
  if (missing.length) {
    throw new Error(
      `--${options.operation.replaceAll('_', '-')} requires explicit ${missing.join(', ')}.`,
    );
  }
  if (
    options.workerId &&
    ![
      'authorize_canary',
      'authorize_action',
      'run_canary',
      'activate',
    ].includes(options.operation)
  ) {
    throw new Error(
      '--worker-id is accepted only by --authorize-canary, --authorize-action, --run-canary, or --activate.',
    );
  }
  const allowedSurfaces = new Set(['telegram', 'bluebubbles']);
  if (!allowedSurfaces.has(options.authorizedSurface as string)) {
    throw new Error(
      '--authorized-surface must be an executable trusted chat surface: telegram or bluebubbles. The owner cockpit can review evidence but has no active-reuse route.',
    );
  }
  if (options.ownerId !== 'owner') {
    throw new Error(
      '--owner-id must be the canonical owner identity "owner" for this bundled capability.',
    );
  }
  if (options.channel !== options.authorizedSurface) {
    throw new Error('The channel and authorized surface must match.');
  }
  return options;
}

function selectedResourceSnapshots(
  acquisition: CapabilityAcquisitionRecord,
  contract: CapabilityCandidateContract,
): ResourceSnapshot[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(acquisition.selectedResourceRefsJson);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    parsed = [];
  }
  const records = Array.isArray(parsed) ? parsed : [];
  return contract.resourceBindings.map((binding) => {
    const selected = records.find(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        String((entry as Record<string, unknown>).resourceId || '') ===
          binding.resourceId,
    ) as Record<string, unknown> | undefined;
    return {
      resourceId: binding.resourceId,
      version: binding.version,
      descriptorDigest:
        typeof selected?.descriptorDigest === 'string'
          ? selected.descriptorDigest
          : null,
      healthState: String(selected?.healthState || 'unknown'),
      reliabilityScore:
        typeof selected?.reliabilityScore === 'number'
          ? selected.reliabilityScore
          : null,
    };
  });
}

function parseAuthority(acquisition: CapabilityAcquisitionRecord): unknown {
  try {
    return JSON.parse(acquisition.authorityRequirementsJson);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { malformed: true };
  }
}

function presentAcquisition(
  acquisition: CapabilityAcquisitionRecord,
  pendingAction: CapabilityCanaryAcquisitionPresentation['pendingAction'],
): CapabilityCanaryAcquisitionPresentation {
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  return {
    acquisitionId: acquisition.acquisitionId,
    state: acquisition.state,
    recordVersion: acquisition.recordVersion,
    title: contract.title,
    taskFamily: contract.taskFamily,
    targetOutcome: acquisition.targetOutcome,
    candidateFingerprint: contract.candidateFingerprint,
    contractVersion: contract.contractVersion,
    implementationKind: contract.implementationKind,
    requiredInputs: contract.requiredInputs,
    optionalInputs: contract.optionalInputs,
    resources: selectedResourceSnapshots(acquisition, contract),
    steps: contract.steps.map((step) => ({
      stepId: step.stepId,
      bindingId: step.bindingId,
      operationId: step.operationId,
      evaluatorId: step.evaluatorId,
      resourceId: step.resourceId,
      resourceVersion: step.version,
      actionClass: step.actionClass,
      readOnly: step.readOnly,
      approvalRequired: step.approvalRequired,
    })),
    dataEgress: {
      acquisition: acquisition.dataEgressClass,
      contract: contract.dataEgressClass,
    },
    authorityRequirements: parseAuthority(acquisition),
    approvalRequirements: contract.approvalRequirements,
    credentialRequirements: contract.credentialRequirements,
    allowedActions: contract.allowedActions,
    prohibitedActions: contract.prohibitedActions,
    successPostconditions: contract.successPostconditions,
    expectedCostBand: acquisition.expectedCostBand,
    expectedLatencyBand: acquisition.expectedLatencyBand,
    nextSafeAction: acquisition.nextSafeAction,
    pendingAction,
  };
}

function presentationPendingAction(
  status: CapabilityApprenticeshipStatus,
): CapabilityCanaryAcquisitionPresentation['pendingAction'] {
  return status.acquisition.state === 'owner_review_required' &&
    status.pendingAction === 'none'
    ? 'canary_staging'
    : status.pendingAction;
}

function exactApprovalDecision(packet: CognitiveApprovalPacket): {
  summary: string;
  scopeDigest: string;
  summaryDigest: string;
  command: string;
} {
  const version = packet.approvalVersion || 0;
  const scopeDigest = packet.scopeDigest || '';
  const summaryDigest = packet.summaryDigest || '';
  if (
    packet.status !== 'staged' ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !/^[a-f0-9]{64}$/.test(scopeDigest) ||
    !/^[a-f0-9]{64}$/.test(summaryDigest)
  ) {
    throw new Error(
      'The staged approval packet lacks an exact reviewable version or digest.',
    );
  }
  return {
    summary: packet.summary,
    scopeDigest,
    summaryDigest,
    command: `approve capability packet ${packet.approvalPacketId} version ${version} scope ${scopeDigest} summary ${summaryDigest}`,
  };
}

function approvalCommandOrNull(packet: CognitiveApprovalPacket): string | null {
  const version = packet.approvalVersion || 0;
  return packet.status === 'staged' &&
    Number.isSafeInteger(version) &&
    version > 0 &&
    /^[a-f0-9]{64}$/.test(packet.scopeDigest || '') &&
    /^[a-f0-9]{64}$/.test(packet.summaryDigest || '')
    ? exactApprovalDecision(packet).command
    : null;
}

function presentRun(
  run: CapabilityProductionRunRecord,
  health: CapabilityHealthEvidenceRecord[],
  approvalById: ReadonlyMap<string, CognitiveApprovalPacket>,
  currentActionApproval: CognitiveApprovalPacket | undefined,
): CapabilityCanaryRunPresentation {
  const approvalPresentation = (
    approvalPacketId: string | null | undefined,
  ): CapabilityApprovalPresentation | null => {
    const approval = approvalPacketId
      ? approvalById.get(approvalPacketId)
      : undefined;
    return approval
      ? {
          approvalPacketId: approval.approvalPacketId,
          status: approval.status,
          version: approval.approvalVersion || 1,
          channel: approval.approvalChannel || null,
          expiresAt: approval.expiresAt || null,
          scopeDigest: approval.scopeDigest || null,
          summary: approval.summary,
          summaryDigest: approval.summaryDigest || null,
          approvalCommand: approvalCommandOrNull(approval),
          targetScopeDigest: approval.targetScopeDigest || null,
        }
      : null;
  };
  return {
    runId: run.runId,
    acquisitionId: run.acquisitionId,
    runKind: run.runKind,
    status: run.status,
    revision: run.revision,
    candidateFingerprint: run.candidateFingerprint,
    contractVersion: run.contractVersion,
    contractDigest: run.contractDigest,
    taskFamily: run.taskFamily,
    ownerScopeHash: run.ownerScopeHash,
    chatScopeHash: run.chatScopeHash,
    groupScopeHash: run.groupScopeHash,
    channel: run.channel,
    authorizedSurface: run.authorizedSurface,
    targetScopeHash: run.targetScopeHash,
    inputDigest: run.inputDigest,
    actionClass: run.actionClass,
    workId: run.workId,
    workVersion: run.workVersion,
    planVersion: run.planVersion,
    checkpointId: run.checkpointId,
    invocationId: run.invocationId,
    outcomeId: run.outcomeId || null,
    ownerReviewId: run.ownerReviewId || null,
    healthEvidenceSetDigest: run.healthEvidenceSetDigest || null,
    expiresAt: run.expiresAt,
    nextSafeAction: run.nextSafeAction,
    canaryApproval: approvalPresentation(run.canaryApprovalPacketId),
    actionApproval: approvalPresentation(
      currentActionApproval?.approvalPacketId,
    ),
    activationApproval: approvalPresentation(run.activationApprovalPacketId),
    health: health.map((item) => ({
      resourceId: item.resourceId,
      resourceVersion: item.resourceVersion,
      subjectId: item.subjectId,
      observationId: item.observationId,
      observedAt: item.observedAt,
      expiresAt: item.expiresAt,
    })),
  };
}

function presentReleaseReadiness(
  contract: CapabilityCandidateContract,
): ReleaseReadinessCandidatePresentation {
  assertCapabilityCandidateContract(contract);
  return {
    status: 'presentation_only_pending_canonical_acquisition',
    title: contract.title,
    capabilityId: contract.capabilityId,
    skillId: contract.skillId,
    taskFamily: contract.taskFamily,
    contractVersion: contract.contractVersion,
    candidateFingerprint: contract.candidateFingerprint,
    triggerSemantics: contract.triggerSemantics,
    resources: contract.resourceBindings,
    steps: contract.steps,
    dataEgressClass: contract.dataEgressClass,
    allowedActions: contract.allowedActions,
    prohibitedActions: contract.prohibitedActions,
    successPostconditions: contract.successPostconditions,
    verificationProcedure: contract.verificationProcedure,
    note: 'Presentation only: this does not create an acquisition, run a brief, approve a canary, or provide owner evidence.',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mutationBinding(
  options: CapabilityCanaryCliOptions,
): DurableWorkBindingInput {
  return {
    ownerId: options.ownerId as string,
    chatId: options.chatId as string,
    groupId: options.groupFolder,
    channel: options.channel as string,
    targetScopeKey: options.targetScopeKey as string,
  };
}

function assertAcquisitionHead(
  acquisition: CapabilityAcquisitionRecord,
  options: CapabilityCanaryCliOptions,
): CapabilityCandidateContract {
  if (acquisition.acquisitionId !== options.acquisitionId) {
    throw new Error(
      'The acquisition does not match the explicit current head.',
    );
  }
  if (acquisition.recordVersion !== options.expectedAcquisitionVersion) {
    throw new Error(
      `Acquisition head changed: expected v${options.expectedAcquisitionVersion}, current v${acquisition.recordVersion}.`,
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  const inputValidation = validateCapabilityCandidateInput(
    contract,
    options.normalizedInputs,
  );
  if (!inputValidation.ok) {
    throw new Error(
      `Input does not satisfy the immutable candidate contract: ${inputValidation.code}.`,
    );
  }
  if (options.normalizedInputs?.targetScopeKey !== options.targetScopeKey) {
    throw new Error(
      'The input targetScopeKey must exactly match the bound target scope.',
    );
  }
  return contract;
}

function assertTrustedBinding(
  options: CapabilityCanaryCliOptions,
  dependencies: CapabilityCanaryCliDependencies,
): DurableWorkBindingInput {
  const binding = mutationBinding(options);
  if (
    binding.ownerId !== 'owner' ||
    !['telegram', 'bluebubbles'].includes(options.authorizedSurface || '') ||
    binding.channel !== options.authorizedSurface
  ) {
    throw new Error(
      'Guided canary mutations require canonical owner identity and one exact executable Telegram or BlueBubbles binding.',
    );
  }
  if (
    !dependencies.isTrustedBinding({
      binding,
      authorizedSurface: options.authorizedSurface as string,
    })
  ) {
    throw new Error(
      'Mutation metadata does not identify a trusted owner-bound surface.',
    );
  }
  return binding;
}

function assertRunHead(params: {
  run: CapabilityProductionRunRecord | undefined;
  acquisition: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
  options: CapabilityCanaryCliOptions;
  dependencies: CapabilityCanaryCliDependencies;
  generatedAt: string;
  expectedStatus:
    | CapabilityProductionRunRecord['status']
    | CapabilityProductionRunRecord['status'][];
}): CapabilityProductionRunRecord {
  const { run, acquisition, contract, options, dependencies, generatedAt } =
    params;
  if (!run || run.runId !== options.runId) {
    throw new Error('The explicit production run was not found.');
  }
  if (
    run.acquisitionId !== acquisition.acquisitionId ||
    run.groupFolder !== options.groupFolder
  ) {
    throw new Error(
      'The production run is outside the exact acquisition scope.',
    );
  }
  if (run.revision !== options.expectedRunRevision) {
    throw new Error(
      `Production-run head changed: expected r${options.expectedRunRevision}, current r${run.revision}.`,
    );
  }
  const expectedStatuses = Array.isArray(params.expectedStatus)
    ? params.expectedStatus
    : [params.expectedStatus];
  if (!expectedStatuses.includes(run.status)) {
    throw new Error(
      `Production run must be ${expectedStatuses.join(' or ')}; current status is ${run.status}.`,
    );
  }
  if (
    run.expiresAt <= generatedAt ||
    run.candidateFingerprint !== contract.candidateFingerprint ||
    run.contractVersion !== contract.contractVersion ||
    run.contractDigest !==
      dependencies.contractDigest(acquisition.candidateContractJson) ||
    run.taskFamily !== contract.taskFamily
  ) {
    throw new Error(
      'Production run is expired or no longer matches the immutable contract head.',
    );
  }
  const binding = mutationBinding(options);
  if (
    run.ownerScopeHash !== durableScopeHash('owner', binding.ownerId) ||
    run.chatScopeHash !== durableScopeHash('chat', binding.chatId) ||
    run.groupScopeHash !== durableScopeHash('group', binding.groupId) ||
    run.targetScopeHash !==
      durableScopeHash('target', binding.targetScopeKey) ||
    run.channel !== binding.channel ||
    run.authorizedSurface !== options.authorizedSurface ||
    run.inputDigest !==
      sha256(canonicalCapabilityJson(options.normalizedInputs))
  ) {
    throw new Error(
      'Explicit identity, surface, target, or input does not match the run binding.',
    );
  }
  return run;
}

function assertFreshObservation(
  resourceId: string,
  observationId: string,
  expiresAt: string,
  observations: readonly ReliabilityObservation[],
  generatedAt: string,
): ReliabilityObservation {
  const observation = observations.find(
    (item) => item.observationId === observationId,
  );
  if (
    !observation ||
    observation.outcome !== 'success' ||
    expiresAt <= generatedAt ||
    observation.observedAt >= expiresAt
  ) {
    throw new Error(
      `Health binding is missing, unsuccessful, or expired: ${resourceId}.`,
    );
  }
  return observation;
}

function assertStagingHealth(params: {
  contract: CapabilityCandidateContract;
  supplied: CapabilityCanaryHealthBinding[];
  observations: readonly ReliabilityObservation[];
  generatedAt: string;
}): void {
  const required = params.contract.resourceBindings.filter(
    (resource) => resource.required,
  );
  if (
    params.supplied.length !== required.length ||
    required.some(
      (resource) =>
        !params.supplied.some(
          (item) => item.resourceId === resource.resourceId,
        ),
    )
  ) {
    throw new Error(
      'Health must bind every required contract resource exactly.',
    );
  }
  for (const binding of params.supplied) {
    assertFreshObservation(
      binding.resourceId,
      binding.observationId,
      binding.expiresAt,
      params.observations,
      params.generatedAt,
    );
  }
}

function assertPersistedHealth(params: {
  run: CapabilityProductionRunRecord;
  contract: CapabilityCandidateContract;
  supplied: CapabilityCanaryHealthBinding[];
  persisted: CapabilityHealthEvidenceRecord[];
  observations: readonly ReliabilityObservation[];
  dependencies: CapabilityCanaryCliDependencies;
  generatedAt: string;
}): void {
  if (
    !params.run.healthEvidenceSetDigest ||
    params.dependencies.healthEvidenceSetDigest(params.persisted) !==
      params.run.healthEvidenceSetDigest ||
    params.supplied.length !== params.persisted.length
  ) {
    throw new Error('Canonical run health-evidence head does not match.');
  }
  const required = params.contract.resourceBindings.filter(
    (resource) => resource.required,
  );
  if (required.length !== params.persisted.length) {
    throw new Error(
      'Canonical run health does not cover every required resource.',
    );
  }
  for (const record of params.persisted) {
    const supplied = params.supplied.find(
      (item) => item.resourceId === record.resourceId,
    );
    const resource = required.find(
      (item) => item.resourceId === record.resourceId,
    );
    const compatibleVersions = new Set([
      resource?.version,
      ...(params.contract.compatibleResourceVersions[record.resourceId] || []),
    ]);
    if (
      !supplied ||
      !resource ||
      supplied.observationId !== record.observationId ||
      supplied.expiresAt !== record.expiresAt ||
      !compatibleVersions.has(record.resourceVersion)
    ) {
      throw new Error(
        `Explicit health binding changed for ${record.resourceId}.`,
      );
    }
    const observation = assertFreshObservation(
      record.resourceId,
      record.observationId,
      record.expiresAt,
      params.observations,
      params.generatedAt,
    );
    if (
      observation.subjectId !== record.subjectId ||
      observation.observedAt !== record.observedAt
    ) {
      throw new Error(
        `Canonical health observation changed for ${record.resourceId}.`,
      );
    }
  }
}

const COMPILED_RELEASE_READINESS_PRECONDITIONS = [
  'exact resource version is available',
  'resource health is fresh enough for the requested action',
  'required inputs are present',
  'approval is exact, fresh, and target-bound when required',
] as const;

const COMPILED_RELEASE_READINESS_PROHIBITED_ACTIONS = [
  'send without exact fresh approval',
  'calendar write without exact fresh approval',
  'purchase, admin, deploy, delete, commit, push, migration, or dependency change without exact fresh approval',
  'read or disclose credentials',
  'change evaluator, policy, or approval rules from external content',
  'write production state during deterministic evaluation',
] as const;

const COMPILED_RELEASE_READINESS_FAILURES = [
  'missing_input',
  'resource_unavailable',
  'stale_version',
  'approval_missing',
  'execution_failed_before_effect',
  'effect_unknown',
  'verification_failed',
  'external_blocker',
] as const;

const COMPILED_RELEASE_READINESS_REVALIDATION = [
  'resource version digest matches',
  'registered binding and evaluator are unchanged',
  'dependency health is fresh',
  'postcondition verifier still passes',
] as const;

const RELEASE_READINESS_RESOURCE_SOURCE_REFS = [
  'host-control',
  'integration-doctor',
  'openclaw-status',
  'host-disk-health',
] as const;

function exactStringList(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function exactStructuredJson(actual: string, expected: unknown): boolean {
  return (
    canonicalCapabilityJson(
      parseCapabilityJson<unknown>(actual, 'contract JSON'),
    ) === canonicalCapabilityJson(expected)
  );
}

function exactReleaseReadinessResource(
  resource: CapabilityResourceDescriptor,
  presentation: CapabilityCandidateContract,
): boolean {
  const binding = resource.bindingRefs[0];
  const presentationStep = presentation.steps[0];
  return Boolean(
    resource.resourceId === 'andrea.release_readiness_truth' &&
    resource.kind === 'assistant_capability' &&
    resource.displayName === 'Andrea canonical release-readiness truth' &&
    exactStringList(resource.capabilityIds, ['release_readiness_brief']) &&
    resource.available &&
    resource.healthState === 'healthy' &&
    resource.verificationStrength === 1 &&
    resource.reliabilityScore === 0.99 &&
    resource.authorityRequirement === 'none' &&
    resource.riskLevel === 'low' &&
    resource.dataEgressClass === 'none' &&
    resource.reversible &&
    resource.expectedCostBand === 'zero' &&
    resource.expectedLatencyBand === 'interactive' &&
    resource.version === '1.0.0' &&
    resource.maintenanceBurden === 'low' &&
    exactStringList(
      resource.sourceRefs,
      RELEASE_READINESS_RESOURCE_SOURCE_REFS,
    ) &&
    exactStringList(resource.taskFamilies, [presentation.taskFamily]) &&
    exactStringList(resource.requiredInputs, presentation.requiredInputs) &&
    exactStringList(
      resource.supportedPostconditions,
      presentation.successPostconditions,
    ) &&
    resource.bindingRefs.length === 1 &&
    binding?.readOnly === true &&
    presentationStep?.bindingId === binding.bindingId &&
    presentationStep.operationId === binding.operationId &&
    presentationStep.evaluatorId === binding.evaluatorId &&
    presentationStep.executorImplementationDigest ===
      binding.executorImplementationDigest &&
    presentationStep.evaluatorImplementationDigest ===
      binding.evaluatorImplementationDigest &&
    binding.actionClass === 'local_lookup' &&
    binding.version === resource.version,
  );
}

function assertBundledReadOnlyCanary(
  acquisition: CapabilityAcquisitionRecord,
  contract: CapabilityCandidateContract,
  dependencies: CapabilityCanaryCliDependencies,
): void {
  const bundled = dependencies.buildReleaseReadinessContract();
  const resource = dependencies.buildReleaseReadinessResource();
  assertCapabilityCandidateContract(bundled);
  const resourceBinding = contract.resourceBindings[0];
  const step = contract.steps[0];
  const bundledBinding = resource.bindingRefs[0];
  const expectedCapabilityId = `acquired-capability:${sha256(
    `${bundled.taskFamily}|${bundled.title}`,
  ).slice(0, 32)}`;
  const expectedSkillId = `acquired-skill:${sha256(expectedCapabilityId).slice(
    0,
    32,
  )}`;
  const authorityRequirements = parseCapabilityJson<unknown>(
    acquisition.authorityRequirementsJson,
    'authorityRequirementsJson',
  );
  if (
    !exactReleaseReadinessResource(resource, bundled) ||
    acquisition.targetOutcome !== bundled.title ||
    acquisition.taskFamily !== bundled.taskFamily ||
    acquisition.gapKind !== 'composable' ||
    acquisition.riskLevel !== 'low' ||
    acquisition.dataEgressClass !== 'none' ||
    acquisition.expectedCostBand !== 'zero' ||
    acquisition.expectedLatencyBand !== 'interactive' ||
    acquisition.compiledSkillId !== contract.skillId ||
    !Array.isArray(authorityRequirements) ||
    authorityRequirements.length !== 0 ||
    contract.contractVersion !== bundled.contractVersion ||
    contract.capabilityId !== expectedCapabilityId ||
    contract.skillId !== expectedSkillId ||
    contract.title !== bundled.title ||
    contract.taskFamily !== bundled.taskFamily ||
    contract.implementationKind !== bundled.implementationKind ||
    !exactStringList(contract.triggerSemantics, bundled.triggerSemantics) ||
    !exactStringList(contract.requiredInputs, bundled.requiredInputs) ||
    !exactStringList(contract.optionalInputs, bundled.optionalInputs) ||
    !exactStructuredJson(contract.inputSchemaJson, {
      additionalProperties: false,
      properties: Object.fromEntries(
        [...bundled.requiredInputs, ...bundled.optionalInputs].map((name) => [
          name,
          { type: 'string' },
        ]),
      ),
      required: bundled.requiredInputs,
      type: 'object',
    }) ||
    !exactStructuredJson(contract.outputSchemaJson, {
      additionalProperties: true,
      required: ['result', 'evidenceRefs'],
      type: 'object',
    }) ||
    !exactStringList(
      contract.preconditions,
      COMPILED_RELEASE_READINESS_PRECONDITIONS,
    ) ||
    contract.resourceBindings.length !== 1 ||
    resourceBinding?.resourceId !== resource.resourceId ||
    resourceBinding.bindingKind !== 'assistant_capability' ||
    resourceBinding.version !== resource.version ||
    resourceBinding.required !== true ||
    contract.steps.length !== 1 ||
    step?.stepId !== 'step-1' ||
    step.title !== resource.displayName ||
    step.resourceId !== resource.resourceId ||
    step.bindingId !== bundledBinding?.bindingId ||
    step.operationId !== bundledBinding?.operationId ||
    step.evaluatorId !== bundledBinding?.evaluatorId ||
    step.version !== resource.version ||
    step.executorImplementationDigest !==
      bundledBinding?.executorImplementationDigest ||
    step.evaluatorImplementationDigest !==
      bundledBinding?.evaluatorImplementationDigest ||
    step.actionClass !== 'local_lookup' ||
    step.readOnly !== true ||
    step.approvalRequired !== false ||
    step.idempotencyKeyRequired !== true ||
    !exactStringList(step.expectedEvidence, resource.supportedPostconditions) ||
    !exactStringList(contract.fallbackPaths, bundled.fallbackPaths) ||
    !exactStringList(contract.allowedActions, ['local_lookup']) ||
    !exactStringList(
      contract.prohibitedActions,
      COMPILED_RELEASE_READINESS_PROHIBITED_ACTIONS,
    ) ||
    contract.approvalRequirements.length !== 0 ||
    contract.dataEgressClass !== 'none' ||
    contract.credentialRequirements.length > 0 ||
    contract.expectedOutput !== bundled.expectedOutput ||
    !exactStringList(
      contract.successPostconditions,
      bundled.successPostconditions,
    ) ||
    !exactStringList(contract.verificationProcedure, [
      `Run registered evaluator ${bundledBinding?.evaluatorId}.`,
    ]) ||
    !exactStringList(contract.verifierBindingIds, [
      bundledBinding?.evaluatorId || '',
    ]) ||
    !exactStringList(
      contract.failureClassifications,
      COMPILED_RELEASE_READINESS_FAILURES,
    ) ||
    !exactStringList(contract.rollbackProcedure, [
      'Run only the registered cleanup binding, if present.',
    ]) ||
    contract.rollbackBindingIds.length !== 0 ||
    !exactStringList(
      contract.deterministicScenarioIds,
      bundled.deterministicScenarioIds,
    ) ||
    !exactStringList(contract.heldOutScenarioIds, bundled.heldOutScenarioIds) ||
    canonicalCapabilityJson(contract.compatibleResourceVersions) !==
      canonicalCapabilityJson({ [resource.resourceId]: [resource.version] }) ||
    !exactStringList(
      contract.revalidationRequirements,
      COMPILED_RELEASE_READINESS_REVALIDATION,
    ) ||
    !exactStringList(
      contract.provenanceRefs,
      resource.sourceRefs.map(
        (sourceRef) => `opaque-ref:${sha256(sourceRef).slice(0, 24)}`,
      ),
    )
  ) {
    throw new Error(
      'This guided command executes only the exact bundled, zero-egress, read-only release-readiness canary.',
    );
  }
}

function assertApprovedPacket(params: {
  run: CapabilityProductionRunRecord;
  kind: 'canary' | 'activation';
  approvals: readonly CognitiveApprovalPacket[];
  generatedAt: string;
}): CognitiveApprovalPacket {
  const activation = params.kind === 'activation';
  const packetId = activation
    ? params.run.activationApprovalPacketId
    : params.run.canaryApprovalPacketId;
  const stagedVersion = activation
    ? params.run.activationApprovalVersion
    : params.run.canaryApprovalVersion;
  const scopeDigest = activation
    ? params.run.activationApprovalScopeDigest
    : params.run.canaryApprovalScopeDigest;
  const packet = params.approvals.find(
    (item) => item.approvalPacketId === packetId,
  );
  const expectedWorkId = activation
    ? params.run.activationWorkId
    : params.run.workId;
  const expectedCheckpointId = activation
    ? params.run.activationCheckpointId
    : params.run.checkpointId;
  const expectedPlanVersion = activation
    ? params.run.activationPlanVersion
    : params.run.planVersion;
  if (
    !packet ||
    packet.status !== 'approved' ||
    !stagedVersion ||
    packet.approvalVersion !== stagedVersion + 1 ||
    packet.scopeDigest !== scopeDigest ||
    packet.targetScopeDigest !== params.run.targetScopeHash ||
    packet.actionClass !== 'operator_change' ||
    packet.approvalChannel !== params.run.authorizedSurface ||
    packet.durableWorkId !== expectedWorkId ||
    packet.durableCheckpointId !== expectedCheckpointId ||
    packet.planVersion !== expectedPlanVersion ||
    !packet.expiresAt ||
    packet.expiresAt <= params.generatedAt
  ) {
    throw new Error(
      `The exact ${params.kind} approval packet is not canonically approved and current.`,
    );
  }
  return packet;
}

function assertApprovedActionPacket(params: {
  run: CapabilityProductionRunRecord;
  packet: CognitiveApprovalPacket | undefined;
  generatedAt: string;
}): CognitiveApprovalPacket {
  const { run, packet } = params;
  if (
    !packet ||
    packet.status !== 'approved' ||
    !packet.approvalVersion ||
    !packet.scopeDigest ||
    packet.actionClass !== run.actionClass ||
    packet.approvalChannel !== run.authorizedSurface ||
    packet.durableWorkId !== run.workId ||
    packet.durableCheckpointId !== run.checkpointId ||
    packet.planVersion !== run.planVersion ||
    packet.targetScopeDigest !== run.targetScopeHash ||
    !packet.expiresAt ||
    packet.expiresAt <= params.generatedAt
  ) {
    throw new Error(
      'The exact current production action packet is not canonically approved and current.',
    );
  }
  return packet;
}

function assertVerifiedOwnerReview(
  run: CapabilityProductionRunRecord,
  acquisition: CapabilityAcquisitionRecord,
  review: CapabilityOwnerReviewRecord | undefined,
): CapabilityOwnerReviewRecord {
  if (
    !review ||
    review.reviewId !== run.ownerReviewId ||
    review.runId !== run.runId ||
    review.acquisitionId !== acquisition.acquisitionId ||
    review.outcomeId !== run.outcomeId ||
    review.candidateFingerprint !== run.candidateFingerprint ||
    review.contractVersion !== run.contractVersion ||
    review.ownerScopeHash !== run.ownerScopeHash ||
    review.chatScopeHash !== run.chatScopeHash ||
    review.groupScopeHash !== run.groupScopeHash ||
    review.channel !== run.channel ||
    review.authorizedSurface !== run.authorizedSurface ||
    review.verdict !== 'verified' ||
    Boolean(review.supersededAt)
  ) {
    throw new Error(
      'A current canonical verified owner review is required before activation staging.',
    );
  }
  return review;
}

function stageCommandTemplate(
  acquisitionId: string,
  groupFolder: string,
  acquisitionVersion: number,
  surface: 'telegram' | 'bluebubbles',
): string {
  const chatId =
    surface === 'telegram'
      ? 'REGISTERED_TELEGRAM_CHAT_ID'
      : 'CONFIGURED_BLUEBUBBLES_SELF_THREAD_ID';
  return [
    'npm run capability:canary -- --stage',
    `--acquisition ${shellQuote(acquisitionId)}`,
    `--group ${shellQuote(groupFolder)}`,
    `--expected-acquisition-version ${acquisitionVersion}`,
    '--owner-id owner',
    `--chat-id ${shellQuote(chatId)}`,
    `--channel ${surface}`,
    `--authorized-surface ${surface}`,
    `--target-scope ${shellQuote('TARGET_SCOPE')}`,
    `--inputs-json '{"targetScopeKey":"TARGET_SCOPE"}'`,
    `--health-json '[{"resourceId":"RESOURCE_ID","observationId":"OBSERVATION_ID","expiresAt":"ISO_8601"}]'`,
  ].join(' ');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildCapabilityCanaryUsage(): string {
  return [
    'Guided verified production apprenticeship',
    '',
    'Read-only inspection:',
    '  npm run capability:canary',
    '  npm run capability:canary -- --group main --json',
    '  npm run capability:canary -- --acquisition ACQUISITION_ID',
    '  npm run capability:canary -- --release-readiness',
    '',
    'Explicit multi-invocation operations:',
    '  Choose exactly one executable trusted surface (telegram or bluebubbles), use --owner-id owner, shell-quote the actual chat/scope values, and preserve that exact surface and chat ID through every invocation.',
    '  npm run capability:canary -- --stage --acquisition ACQUISITION_ID --group GROUP --expected-acquisition-version N --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --authorize-canary --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --worker-id WORKER_ID --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --stage-action-approval --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --authorize-action --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --worker-id WORKER_ID --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --run-canary --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --worker-id WORKER_ID --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --stage-activation --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '  npm run capability:canary -- --activate --acquisition ACQUISITION_ID --run-id RUN_ID --group GROUP --expected-acquisition-version N --expected-run-revision N --worker-id WORKER_ID --owner-id owner --chat-id TRUSTED_CHAT_ID --channel TRUSTED_SURFACE --authorized-surface TRUSTED_SURFACE --target-scope TARGET_SCOPE --inputs-json JSON --health-json JSON_ARRAY',
    '',
    'Staging creates only a bounded pending canary proposal and approval packet.',
    'Authorization consumes only an already-approved exact packet. Execution is restricted to the bundled read-only zero-egress canary.',
    'Protected plans require a separate action-specific packet: stage it, approve that exact packet on the same trusted chat, then consume it with --authorize-action. Neither action phase approves or executes the plan.',
    'Each staging phase prints its reviewable summary and exact digest-bound chat command: approve capability packet <id> version <n> scope <64hex> summary <64hex>. Abbreviated approval language is not authority.',
    'Owner review occurs only through a canonical trusted surface; this CLI never approves packets or records verdicts.',
    'Activation is proposed and approved separately. No operation calls providers or mutates external systems.',
  ].join('\n');
}

export async function runCapabilityCanaryCli(
  options: CapabilityCanaryCliOptions,
  dependencies: CapabilityCanaryCliDependencies,
): Promise<CapabilityCanaryCliReport> {
  const generatedAt = dependencies.now();
  const allGroupAcquisitions = dependencies.listAcquisitions({
    groupFolder: options.groupFolder,
    limit: 500,
  });
  const eligible = allGroupAcquisitions.filter(
    (item) =>
      item.groupFolder === options.groupFolder &&
      item.state === 'owner_review_required',
  );
  let selected: CapabilityAcquisitionRecord | null = null;
  let selectedStatus: CapabilityApprenticeshipStatus | null = null;
  if (options.acquisitionId) {
    selectedStatus = dependencies.getStatus(options.acquisitionId);
    if (selectedStatus.acquisition.groupFolder !== options.groupFolder) {
      throw new Error('Selected acquisition is outside the requested group.');
    }
    selected = selectedStatus.acquisition;
  }
  const statusTargets = [
    ...eligible,
    ...(selected &&
    !eligible.some((item) => item.acquisitionId === options.acquisitionId)
      ? [selected]
      : []),
  ];
  const statusByAcquisition = new Map<string, CapabilityApprenticeshipStatus>();
  for (const acquisition of statusTargets) {
    statusByAcquisition.set(
      acquisition.acquisitionId,
      dependencies.getStatus(acquisition.acquisitionId),
    );
  }
  const reliabilityObservations = dependencies.listReliabilityObservations({
    limit: options.operation === 'inspect' ? 100 : 5_000,
  });
  const observations = reliabilityObservations.slice(0, 25).map((item) => ({
    observationId: item.observationId,
    subjectId: item.subjectId,
    observedAt: item.observedAt,
    outcome: item.outcome,
    confidence: item.confidence,
    fallbackUsed: item.fallbackUsed,
  }));
  const approvals = dependencies.listApprovals({
    groupFolder: options.groupFolder,
    limit: 500,
  });
  let staged: CapabilityCanaryCliReport['staged'] = null;
  let action: CapabilityCanaryCliReport['action'] = null;
  if (options.operation !== 'inspect') {
    if (!selected) {
      throw new Error('A selected acquisition is required for mutation.');
    }
    const contract = assertAcquisitionHead(selected, options);
    if (
      !['stage_action_approval', 'authorize_action'].includes(options.operation)
    ) {
      assertBundledReadOnlyCanary(selected, contract, dependencies);
    }
    const binding = assertTrustedBinding(options, dependencies);
    if (options.operation === 'stage') {
      if (!selected || selected.state !== 'owner_review_required') {
        throw new Error(
          'Staging requires the selected acquisition to be owner_review_required.',
        );
      }
      assertStagingHealth({
        contract,
        supplied: options.health as CapabilityCanaryHealthBinding[],
        observations: reliabilityObservations,
        generatedAt,
      });
      const result = dependencies.stageCanary({
        acquisitionId: selected.acquisitionId,
        expectedAcquisitionVersion: selected.recordVersion,
        binding,
        authorizedSurface: options.authorizedSurface as string,
        normalizedInputs: options.normalizedInputs as Record<string, unknown>,
        health: options.health as CapabilityCanaryHealthBinding[],
      });
      const after = dependencies.getStatus(selected.acquisitionId);
      statusByAcquisition.set(selected.acquisitionId, after);
      const approvalDecision = exactApprovalDecision(result.approval);
      staged = {
        acquisitionId: selected.acquisitionId,
        runId: result.run.runId,
        runStatus: result.run.status,
        acquisitionState: after.acquisition.state,
        approvalPacketId: result.approval.approvalPacketId,
        approvalVersion: result.approval.approvalVersion || 1,
        approvalStatus: result.approval.status,
        approvalSummary: approvalDecision.summary,
        approvalScopeDigest: approvalDecision.scopeDigest,
        approvalSummaryDigest: approvalDecision.summaryDigest,
        approvalCommand: approvalDecision.command,
        nextSafeAction: result.run.nextSafeAction,
      };
    } else {
      const expectedStatus:
        | CapabilityProductionRunRecord['status']
        | CapabilityProductionRunRecord['status'][] =
        options.operation === 'authorize_canary'
          ? 'awaiting_canary_approval'
          : options.operation === 'stage_action_approval'
            ? ['canary_ready', 'monitoring']
            : options.operation === 'authorize_action'
              ? 'awaiting_action_approval'
              : options.operation === 'run_canary'
                ? 'canary_ready'
                : options.operation === 'stage_activation'
                  ? 'owner_reviewed'
                  : 'awaiting_activation_approval';
      const run = assertRunHead({
        run: dependencies.getRun(options.runId as string),
        acquisition: selected,
        contract,
        options,
        dependencies,
        generatedAt,
        expectedStatus,
      });
      assertPersistedHealth({
        run,
        contract,
        supplied: options.health as CapabilityCanaryHealthBinding[],
        persisted: dependencies.listRunHealth(run.runId),
        observations: reliabilityObservations,
        dependencies,
        generatedAt,
      });
      let approvalPacket: CognitiveApprovalPacket | null = null;
      let transitionReceiptId: string | null = null;
      let execution: CapabilityProductionExecutionResult | null = null;
      let activationProposal: CognitiveApprovalPacket | null = null;
      let actionProposal: CognitiveApprovalPacket | null = null;
      if (options.operation === 'authorize_canary') {
        approvalPacket = assertApprovedPacket({
          run,
          kind: 'canary',
          approvals,
          generatedAt,
        });
        const result = dependencies.authorizeCanary({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          authorizedSurface: options.authorizedSurface as string,
          binding,
          workerId: options.workerId as string,
        });
        transitionReceiptId = result.receipt.receiptId;
      } else if (options.operation === 'stage_action_approval') {
        const result = dependencies.stageActionApproval({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          binding,
        });
        actionProposal = result.approval;
      } else if (options.operation === 'authorize_action') {
        approvalPacket = assertApprovedActionPacket({
          run,
          packet: dependencies.getCurrentActionApproval(run),
          generatedAt,
        });
        dependencies.authorizeAction({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          binding,
          workerId: options.workerId as string,
        });
      } else if (options.operation === 'run_canary') {
        execution = await dependencies.executeCanary({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          binding,
          workerId: options.workerId as string,
          values: options.normalizedInputs as Record<string, unknown>,
        });
        if (execution.status !== 'verified') {
          throw new Error(
            'The bounded canary did not reach verified completion.',
          );
        }
      } else if (options.operation === 'stage_activation') {
        assertVerifiedOwnerReview(
          run,
          selected,
          dependencies.getOwnerReview(run.runId),
        );
        const result = dependencies.stageActivation({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          authorizedSurface: options.authorizedSurface as string,
          binding,
        });
        activationProposal = result.approval;
      } else {
        approvalPacket = assertApprovedPacket({
          run,
          kind: 'activation',
          approvals,
          generatedAt,
        });
        const result = dependencies.authorizeActivation({
          runId: run.runId,
          expectedAcquisitionVersion: selected.recordVersion,
          expectedRunRevision: run.revision,
          authorizedSurface: options.authorizedSurface as string,
          binding,
          workerId: options.workerId as string,
        });
        transitionReceiptId = result.receipt.receiptId;
      }
      selectedStatus = dependencies.getStatus(selected.acquisitionId);
      selected = selectedStatus.acquisition;
      const afterRun = dependencies.getRun(run.runId);
      if (!afterRun) {
        throw new Error(
          'Production run disappeared after the requested operation.',
        );
      }
      if (
        options.operation === 'run_canary' &&
        afterRun.status !== 'awaiting_owner_review'
      ) {
        throw new Error(
          'Verified canary did not stop at the canonical owner-review boundary.',
        );
      }
      if (
        options.operation === 'stage_action_approval' &&
        afterRun.status !== 'awaiting_action_approval'
      ) {
        throw new Error(
          'Protected production action did not stop at the exact approval boundary.',
        );
      }
      if (
        options.operation === 'authorize_action' &&
        (!['canary_ready', 'monitoring'].includes(afterRun.status) ||
          !afterRun.executionGrantId ||
          !afterRun.executionLeaseId)
      ) {
        throw new Error(
          'Approved production action did not bind one exact execution grant and lease.',
        );
      }
      const stagedApproval = activationProposal || actionProposal;
      const approvalDecision = stagedApproval
        ? exactApprovalDecision(stagedApproval)
        : null;
      action = {
        operation: options.operation,
        acquisitionId: selected.acquisitionId,
        acquisitionState: selected.state,
        acquisitionVersion: selected.recordVersion,
        runId: afterRun.runId,
        runStatus: afterRun.status,
        runRevision: afterRun.revision,
        transitionReceiptId,
        approvalPacketId:
          activationProposal?.approvalPacketId ||
          actionProposal?.approvalPacketId ||
          approvalPacket?.approvalPacketId ||
          null,
        approvalVersion:
          activationProposal?.approvalVersion ||
          actionProposal?.approvalVersion ||
          approvalPacket?.approvalVersion ||
          null,
        approvalStatus:
          activationProposal?.status ||
          actionProposal?.status ||
          approvalPacket?.status ||
          null,
        approvalSummary: approvalDecision?.summary || null,
        approvalScopeDigest: approvalDecision?.scopeDigest || null,
        approvalSummaryDigest: approvalDecision?.summaryDigest || null,
        approvalCommand: approvalDecision?.command || null,
        executionStatus: execution?.status || null,
        executionReceiptIds: execution?.receiptIds || [],
        evidenceRefs: execution?.evidenceRefs || [],
        providerCalls: execution?.providerCalls || 0,
        costUsd: execution?.costUsd || 0,
        latencyMs: execution?.latencyMs || 0,
        ownerReviewId: afterRun.ownerReviewId || null,
        nextSafeAction: afterRun.nextSafeAction,
      };
      statusByAcquisition.set(selected.acquisitionId, selectedStatus);
    }
  }
  const openRuns = dependencies.listRuns({
    groupFolder: options.groupFolder,
    statuses: OPEN_RUN_STATUSES,
    limit: 500,
  });
  const approvalById = new Map(
    dependencies
      .listApprovals({ groupFolder: options.groupFolder, limit: 500 })
      .map((approval) => [approval.approvalPacketId, approval]),
  );
  const commandCandidates = selected
    ? selected.state === 'owner_review_required'
      ? [selected]
      : []
    : eligible;
  const nextCommands = commandCandidates.flatMap((acquisition) => [
    `Choose exactly one registered trusted chat for ${acquisition.acquisitionId}; replace only that route's chat-ID placeholder and the evidence/input placeholders:`,
    stageCommandTemplate(
      acquisition.acquisitionId,
      options.groupFolder,
      acquisition.recordVersion,
      'telegram',
    ),
    stageCommandTemplate(
      acquisition.acquisitionId,
      options.groupFolder,
      acquisition.recordVersion,
      'bluebubbles',
    ),
  ]);
  if (staged) {
    nextCommands.splice(
      0,
      nextCommands.length,
      `npm run capability:canary -- --group ${shellQuote(options.groupFolder)} --acquisition ${shellQuote(staged.acquisitionId)}`,
      `Review the summary and digests, then send this exact command on the bound trusted chat: ${staged.approvalCommand}`,
    );
  } else if (action?.operation === 'authorize_canary') {
    nextCommands.splice(
      0,
      nextCommands.length,
      'Run --run-canary only with the returned acquisition version and run revision plus the same exact binding, input, and health evidence.',
    );
  } else if (action?.operation === 'stage_action_approval') {
    nextCommands.splice(
      0,
      nextCommands.length,
      `Review and approve only the returned action-specific packet on the same exact trusted chat by sending this digest-bound command: ${action.approvalCommand}. After canonical approval, consume the current packet with --authorize-action and the returned run/acquisition heads plus unchanged binding, input, and health evidence.`,
    );
  } else if (action?.operation === 'authorize_action') {
    nextCommands.splice(
      0,
      nextCommands.length,
      'The exact action packet is consumed into one bounded grant and lease. Continue only the already-planned production execution with the returned run/acquisition heads; this command did not execute the protected action.',
    );
  } else if (action?.operation === 'run_canary') {
    nextCommands.splice(
      0,
      nextCommands.length,
      'Provide the exact outcome verdict through the authenticated owner cockpit or trusted bound chat. This CLI stops and cannot record it.',
    );
  } else if (action?.operation === 'stage_activation') {
    nextCommands.splice(
      0,
      nextCommands.length,
      `Review the separate activation summary and digests, then send this exact command on the same bound trusted chat: ${action.approvalCommand}. This CLI did not approve or activate it.`,
    );
  } else if (action?.operation === 'activate') {
    nextCommands.splice(
      0,
      nextCommands.length,
      'Activation completed for this exact contract and scope. Inspect canonical monitoring evidence before reuse.',
    );
  } else if (options.releaseReadiness) {
    nextCommands.push(
      commandCandidates.length > 0
        ? 'A canonical release-readiness acquisition already exists. Use exactly one trusted-chat staging command above; this presentation did not create, approve, or run another candidate.'
        : 'No canonical release-readiness acquisition exists in this group. Create and verify one through the normal acquisition lifecycle; this presentation does not synthesize one.',
    );
  }
  if (
    !staged &&
    !action &&
    openRuns.some((run) => run.status === 'awaiting_action_approval')
  ) {
    nextCommands.push(
      'A protected plan is awaiting an action-specific decision. Approve only its exact current packet on the same bound trusted chat, then use --authorize-action with current heads and the unchanged binding. Inspection does not approve or consume it.',
    );
  }
  return {
    generatedAt,
    mode: options.operation,
    groupFolder: options.groupFolder,
    selectedAcquisitionId: options.acquisitionId,
    selectedAcquisition: selected
      ? presentAcquisition(
          selected,
          statusByAcquisition.has(selected.acquisitionId)
            ? presentationPendingAction(
                statusByAcquisition.get(selected.acquisitionId)!,
              )
            : 'none',
        )
      : null,
    eligibleAcquisitions: eligible.map((acquisition) =>
      presentAcquisition(
        acquisition,
        presentationPendingAction(
          statusByAcquisition.get(acquisition.acquisitionId)!,
        ),
      ),
    ),
    openRuns: openRuns.map((run) =>
      presentRun(
        run,
        dependencies.listRunHealth(run.runId),
        approvalById,
        dependencies.getCurrentActionApproval(run),
      ),
    ),
    recentHealthObservations: observations,
    releaseReadinessCandidate: options.releaseReadiness
      ? presentReleaseReadiness(dependencies.buildReleaseReadinessContract())
      : null,
    staged,
    action,
    guardrails: [
      'Default and candidate-presentation modes are metadata-only and read-only.',
      'Terminal input is never an owner approval, owner verdict, or activation decision.',
      'Every mutation requires explicit current acquisition/run heads, exact scope and input, trusted-surface binding, and current canonical health evidence.',
      'Staging does not authorize or execute the canary.',
      'Authorization consumes only an already-approved exact canonical packet; this CLI never approves a packet.',
      'Protected execution requires a separate action-specific packet approved on the same trusted chat and consumed in a distinct invocation.',
      'The execution phase is limited to the exact bundled, read-only, zero-egress release-readiness binding and stops awaiting canonical owner review.',
      'This CLI never issues owner-review tokens or records owner verdicts.',
      'Activation staging and activation consumption are separate invocations; protected actions retain fresh approval.',
      'No guided operation calls a provider or mutates external systems.',
    ],
    nextCommands,
  };
}

function shortDigest(value: string): string {
  return value.length > 20 ? `${value.slice(0, 16)}…` : value;
}

function formatAcquisitionPresentation(
  item: CapabilityCanaryAcquisitionPresentation,
): string[] {
  return [
    `${item.title} (${item.acquisitionId})`,
    `  State: ${item.state} v${item.recordVersion}; pending=${item.pendingAction}`,
    `  Contract: v${item.contractVersion} ${shortDigest(item.candidateFingerprint)}`,
    `  Task: ${item.taskFamily}; implementation=${item.implementationKind}`,
    `  Target outcome: ${item.targetOutcome}`,
    `  Egress: acquisition=${item.dataEgress.acquisition}; contract=${item.dataEgress.contract}`,
    `  Authority: ${JSON.stringify(item.authorityRequirements)}`,
    `  Allowed: ${item.allowedActions.join(', ') || 'none'}`,
    `  Prohibited: ${item.prohibitedActions.join(', ') || 'none'}`,
    `  Cost/latency: ${item.expectedCostBand}/${item.expectedLatencyBand}`,
    '  Resources (health is the discovery snapshot, not fresh canary proof):',
    ...item.resources.map(
      (resource) =>
        `    - ${resource.resourceId}@${resource.version}: ${resource.healthState}; reliability=${resource.reliabilityScore ?? 'unknown'}; digest=${resource.descriptorDigest ? shortDigest(resource.descriptorDigest) : 'missing'}`,
    ),
    '  Exact steps:',
    ...item.steps.map(
      (step) =>
        `    - ${step.stepId}: ${step.bindingId}/${step.operationId}; evaluator=${step.evaluatorId}; resource=${step.resourceId}@${step.resourceVersion}; action=${step.actionClass}; readOnly=${step.readOnly}; approval=${step.approvalRequired}`,
    ),
    '  Postconditions:',
    ...item.successPostconditions.map((value) => `    - ${value}`),
    `  Next: ${item.nextSafeAction}`,
  ];
}

export function formatCapabilityCanaryReport(
  report: CapabilityCanaryCliReport,
): string {
  const lines = [
    'Andrea verified production apprenticeship',
    `Mode: ${report.mode}`,
    `Group: ${report.groupFolder}`,
    'Terminal input is not owner approval, review, execution, or activation.',
  ];
  if (report.selectedAcquisition) {
    lines.push(
      '',
      'Selected acquisition:',
      ...formatAcquisitionPresentation(report.selectedAcquisition),
    );
  }
  lines.push(
    '',
    `Eligible owner_review_required acquisitions: ${report.eligibleAcquisitions.length}`,
  );
  for (const item of report.eligibleAcquisitions) {
    if (item.acquisitionId === report.selectedAcquisition?.acquisitionId) {
      lines.push(`  - selected: ${item.acquisitionId}`);
      continue;
    }
    lines.push('', ...formatAcquisitionPresentation(item));
  }
  lines.push('', `Open production runs: ${report.openRuns.length}`);
  for (const run of report.openRuns) {
    lines.push(
      `  - ${run.runId}: ${run.status} (${run.runKind}); acquisition=${run.acquisitionId}; work=${run.workId} v${run.workVersion}/plan${run.planVersion}; channel=${run.channel}; surface=${run.authorizedSurface}; health=${run.health.length}`,
      `      contract=v${run.contractVersion}/${shortDigest(run.candidateFingerprint)}/${shortDigest(run.contractDigest)}; owner=${shortDigest(run.ownerScopeHash)}; chat=${shortDigest(run.chatScopeHash)}; group=${shortDigest(run.groupScopeHash)}; target=${shortDigest(run.targetScopeHash)}; input=${shortDigest(run.inputDigest)}; health-set=${run.healthEvidenceSetDigest ? shortDigest(run.healthEvidenceSetDigest) : 'missing'}`,
    );
    for (const [kind, approval] of [
      ['canary', run.canaryApproval],
      ['action', run.actionApproval],
      ['activation', run.activationApproval],
    ] as const) {
      if (!approval) continue;
      lines.push(
        `      ${kind} approval ${approval.approvalPacketId} v${approval.version}: ${approval.status}; channel=${approval.channel || 'none'}; scope=${approval.scopeDigest ? shortDigest(approval.scopeDigest) : 'missing'}; target=${approval.targetScopeDigest ? shortDigest(approval.targetScopeDigest) : 'missing'}; expires=${approval.expiresAt || 'none'}`,
      );
      if (approval.approvalCommand) {
        lines.push(
          `        Review: ${approval.summary}`,
          `        Summary digest: ${approval.summaryDigest}`,
          `        Exact same-chat decision: ${approval.approvalCommand}`,
        );
      }
    }
    for (const health of run.health) {
      lines.push(
        `      health ${health.resourceId}@${health.resourceVersion}: observation=${health.observationId}; subject=${health.subjectId}; observed=${health.observedAt}; expires=${health.expiresAt}`,
      );
    }
  }
  lines.push(
    '',
    `Recent canonical health observations available for explicit binding: ${report.recentHealthObservations.length}`,
    ...report.recentHealthObservations.map(
      (item) =>
        `  - ${item.observationId}: subject=${item.subjectId}; ${item.outcome}; observed=${item.observedAt}; confidence=${item.confidence}; fallback=${item.fallbackUsed}`,
    ),
  );
  if (report.releaseReadinessCandidate) {
    const candidate = report.releaseReadinessCandidate;
    lines.push(
      '',
      'Release-readiness candidate presentation',
      `  Status: ${candidate.status}`,
      `  ${candidate.title} v${candidate.contractVersion} (${shortDigest(candidate.candidateFingerprint)})`,
      `  Task: ${candidate.taskFamily}; egress=${candidate.dataEgressClass}`,
      `  Resources: ${candidate.resources.map((item) => `${item.resourceId}@${item.version}`).join(', ')}`,
      `  Allowed: ${candidate.allowedActions.join(', ')}`,
      `  Prohibited: ${candidate.prohibitedActions.join(', ')}`,
      '  Postconditions:',
      ...candidate.successPostconditions.map((item) => `    - ${item}`),
      `  ${candidate.note}`,
    );
  }
  if (report.staged) {
    lines.push(
      '',
      'Canary proposal staged',
      `  Run: ${report.staged.runId}`,
      `  Run status: ${report.staged.runStatus}`,
      `  Acquisition state: ${report.staged.acquisitionState}`,
      `  Approval packet: ${report.staged.approvalPacketId} v${report.staged.approvalVersion} (${report.staged.approvalStatus})`,
      `  Review: ${report.staged.approvalSummary}`,
      `  Scope digest: ${report.staged.approvalScopeDigest}`,
      `  Summary digest: ${report.staged.approvalSummaryDigest}`,
      `  Exact same-chat decision: ${report.staged.approvalCommand}`,
      `  Next: ${report.staged.nextSafeAction}`,
      '  No approval or execution occurred.',
    );
  }
  if (report.action) {
    const action = report.action;
    lines.push(
      '',
      `Completed guided phase: ${action.operation}`,
      `  Acquisition: ${action.acquisitionId} (${action.acquisitionState} v${action.acquisitionVersion})`,
      `  Run: ${action.runId} (${action.runStatus} r${action.runRevision})`,
    );
    if (action.transitionReceiptId) {
      lines.push(`  Transition receipt: ${action.transitionReceiptId}`);
    }
    if (action.approvalPacketId) {
      lines.push(
        `  Exact approval packet: ${action.approvalPacketId} v${action.approvalVersion} (${action.approvalStatus})`,
      );
    }
    if (action.approvalCommand) {
      lines.push(
        `  Review: ${action.approvalSummary}`,
        `  Scope digest: ${action.approvalScopeDigest}`,
        `  Summary digest: ${action.approvalSummaryDigest}`,
        `  Exact same-chat decision: ${action.approvalCommand}`,
      );
    }
    if (action.executionStatus) {
      lines.push(
        `  Execution: ${action.executionStatus}; receipts=${action.executionReceiptIds.length}; evidence=${action.evidenceRefs.length}; providers=${action.providerCalls}; cost=$${action.costUsd.toFixed(4)}; latency=${action.latencyMs}ms`,
        `  Owner review: ${action.ownerReviewId || 'awaiting exact canonical owner review'}`,
      );
    }
    lines.push(`  Next: ${action.nextSafeAction}`);
    if (action.operation === 'run_canary') {
      lines.push(
        '  STOP: no terminal verdict was accepted. Review must arrive through a canonical trusted owner surface.',
      );
    } else if (action.operation === 'stage_activation') {
      lines.push(
        '  No activation occurred. The separate exact activation packet still needs canonical owner approval.',
      );
    } else if (action.operation === 'stage_action_approval') {
      lines.push(
        '  No approval or protected execution occurred. Decide the exact action packet on the same bound trusted chat.',
      );
    } else if (action.operation === 'authorize_action') {
      lines.push(
        '  The approved packet was consumed into one bounded grant and lease; the protected action was not executed by this phase.',
      );
    }
  }
  lines.push('', 'Next commands:');
  if (report.nextCommands.length) {
    lines.push(...report.nextCommands.map((item) => `  ${item}`));
  } else {
    lines.push(
      '  No eligible candidate is currently available. Inspection made no changes.',
    );
  }
  lines.push(
    '',
    'Guardrails:',
    ...report.guardrails.map((item) => `  - ${item}`),
  );
  return lines.join('\n');
}
