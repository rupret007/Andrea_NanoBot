import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  capabilityHealthEvidenceSetDigest,
  capabilityProductionContractDigest,
  assertCapabilityProductionExecutionPreflight,
  assertCapabilityProductionReceiptsReadyForCheckpoint,
  assertCapabilityProductionRecoveryLeasePreflight,
  assertCapabilityProductionRecoveryPreflight,
  applyCapabilityOwnerControlWithToken,
  getCapabilityAcquisition,
  getCapabilityOwnerReviewForRun,
  getCapabilityProductionRun,
  getDurableWorkCheckpoint,
  getDurableWorkLease,
  getDurableWorkUnit,
  getOutcomeBySource,
  expireCapabilityPendingAuthorityAtomic,
  failOrphanCapabilityStagingAtomic,
  insertCapabilityOwnerActionToken,
  insertCapabilityProductionRunWithHealthAtomic,
  insertCapabilityProductionStep,
  isIsolatedTestDatabase,
  listCapabilityAcquisitionTransitions,
  listCapabilityHealthEvidence,
  listCapabilityProductionRuns,
  listCapabilityProductionSteps,
  listCapabilityProductionTransitionReceipts,
  listCapabilityAcquisitions,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listReliabilityObservations,
  listToolReliabilitySubjects,
  reconcileCapabilityProductionEvidenceAtomic,
  recordCapabilityOwnerReviewWithToken,
  refreshCapabilityProductionHealthAtomic,
  reconcileCapabilityProductionFailureAtomic,
  refreshCapabilityProductionRunWorkHead,
  runCapabilityProductionStagingAtomic,
  runCapabilityProductionVerifiedStepAtomic,
  updateCapabilityProductionRunCAS,
  upsertCognitiveRun,
  upsertOutcome,
} from './db.js';
import {
  commitDurableCheckpointCAS,
  consumeResumeGrantAndAcquireLease,
  createOrLoadDurableWork,
  durableProcessGeneration,
  durableScopeHash,
  issueDurableResumeGrant,
  linkDurableWorkProjection,
  recordDurableEffect,
  reconcileDurableWorkOnStartup,
  reconcileExpiredDurableLease,
  releaseDurableLease,
  stageDurableWorkApproval,
  transitionDurableWork,
  type DurableWorkBindingInput,
} from './durable-work-continuity.js';
import {
  assertCapabilityCandidateContract,
  canonicalCapabilityJson,
  parseCapabilityJson,
  capabilityCandidateFingerprint,
} from './capability-acquisition-policy.js';
import type {
  DurableActionClass,
  DurablePolicyEffectClass,
} from './durable-action-policy.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import {
  buildRuntimeCommitTruth,
  readHostControlSnapshot,
} from './host-control.js';
import { probeHostDiskHealth } from './host-resource-health.js';
import { buildIntegrationDoctorReport } from './integration-doctor.js';
import { getOpenClawStatusSummary } from './openclaw-connector.js';
import { getOpenClawAndreaBridgeStatusSummary } from './openclaw-andrea-bridge.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityHealthEvidenceRecord,
  CapabilityOwnerActionTokenRecord,
  CapabilityOwnerReviewVerdict,
  CapabilityProductionRunRecord,
  CapabilityResourceDescriptor,
  CognitiveApprovalPacket,
  RegisteredGroup,
} from './types.js';

const PRODUCTION_PRIVACY = JSON.stringify({
  metadataOnly: true,
  rawContentStored: false,
  rawPromptsStored: false,
  rawRepliesStored: false,
  rawToolOutputStored: false,
  secretsRedacted: true,
});

const DEFAULT_RUN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ACTION_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_HEALTH_EVIDENCE_TTL_MS = 30 * 60 * 1000;
const MAX_LIVE_COST_USD = 25;
const RELEASE_READINESS_RESOURCE_ID = 'andrea.release_readiness_truth';
const RELEASE_READINESS_VERSION = '1.0.0';
const RELEASE_READINESS_BINDING_ID = 'andrea.release_readiness_brief.execute';
const RELEASE_READINESS_OPERATION_ID = 'build_release_readiness_brief';
const RELEASE_READINESS_EVALUATOR_ID = 'andrea.release_readiness_brief.verify';
const RELEASE_READINESS_EXECUTOR_DIGEST = sha256(
  'andrea:bundled-binding:release-readiness-brief:executor:v2',
);
const RELEASE_READINESS_EVALUATOR_DIGEST = sha256(
  'andrea:bundled-binding:release-readiness-brief:evaluator:v2',
);

class ProductionCapabilityQuarantineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionCapabilityQuarantineError';
  }
}

class ProductionCapabilityIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionCapabilityIndeterminateError';
  }
}

export type ProductionCapabilityApprenticeshipBoundary =
  | 'after_effect_before_outcome'
  | 'after_checkpoint_before_outcome'
  | 'after_outcome_before_reconcile'
  | 'after_owner_review_before_reconcile'
  | 'after_active_reuse_lease_before_run'
  | 'after_canary_stage_before_run'
  | 'after_activation_stage_before_run'
  | 'after_receipts_before_checkpoint';

type ProductionCapabilityApprenticeshipTestHook = (event: {
  boundary: ProductionCapabilityApprenticeshipBoundary;
  runId: string;
  stepId?: string;
}) => void | Promise<void>;

class ProductionCapabilitySimulatedCrashError extends Error {
  constructor(boundary: ProductionCapabilityApprenticeshipBoundary) {
    super(`Simulated production apprenticeship crash at ${boundary}.`);
    this.name = 'ProductionCapabilitySimulatedCrashError';
  }
}

let productionCapabilityTestHook: ProductionCapabilityApprenticeshipTestHook | null =
  null;

/** @internal Isolated-database crash certification only. */
export function _setProductionCapabilityApprenticeshipTestHook(
  hook: ProductionCapabilityApprenticeshipTestHook | null,
): void {
  if (hook && !isIsolatedTestDatabase()) {
    throw new Error(
      'Production apprenticeship failpoints require an isolated database.',
    );
  }
  productionCapabilityTestHook = hook;
}

async function emitProductionCapabilityBoundary(event: {
  boundary: ProductionCapabilityApprenticeshipBoundary;
  runId: string;
  stepId?: string;
}): Promise<void> {
  if (!productionCapabilityTestHook) return;
  if (!isIsolatedTestDatabase()) {
    productionCapabilityTestHook = null;
    throw new Error(
      'Production apprenticeship failpoint escaped test isolation.',
    );
  }
  try {
    await productionCapabilityTestHook(event);
  } catch {
    throw new ProductionCapabilitySimulatedCrashError(event.boundary);
  }
}

function emitProductionCapabilityBoundarySync(event: {
  boundary: ProductionCapabilityApprenticeshipBoundary;
  runId: string;
  stepId?: string;
}): void {
  if (!productionCapabilityTestHook) return;
  if (!isIsolatedTestDatabase()) {
    productionCapabilityTestHook = null;
    throw new Error(
      'Production apprenticeship failpoint escaped test isolation.',
    );
  }
  try {
    const result = productionCapabilityTestHook(event);
    if (result && typeof (result as Promise<void>).then === 'function') {
      throw new Error(
        'Synchronous apprenticeship boundaries require a synchronous hook.',
      );
    }
  } catch {
    throw new ProductionCapabilitySimulatedCrashError(event.boundary);
  }
}

function iso(value?: Date | string): string {
  const parsed =
    value instanceof Date ? value : value ? new Date(value) : new Date();
  if (!Number.isFinite(parsed.getTime()))
    throw new Error('Invalid apprenticeship time.');
  return parsed.toISOString();
}

function plusMs(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function productionPostconditionHash(value: string): string {
  return sha256(`andrea:capability-production-postcondition:v1\0${value}`);
}

function assertProductionCandidate(
  acquisition: CapabilityAcquisitionRecord | undefined,
): CapabilityCandidateContract {
  if (!acquisition || acquisition.state !== 'owner_review_required') {
    throw new Error(
      'A production canary may be staged only from owner_review_required.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  const sandbox = parseCapabilityJson<Record<string, unknown>>(
    acquisition.sandboxEvidenceJson,
    'sandboxEvidenceJson',
  );
  const heldOut = parseCapabilityJson<Record<string, unknown>>(
    acquisition.heldOutEvidenceJson,
    'heldOutEvidenceJson',
  );
  if (
    sandbox.verified !== true ||
    sandbox.postconditionVerified !== true ||
    heldOut.passed !== true ||
    Number(heldOut.safetyInvariantRate) !== 1 ||
    Number(heldOut.falseSuccesses) !== 0
  ) {
    throw new Error(
      'Production canary proposal lacks verified preproduction evidence.',
    );
  }
  return contract;
}

export interface CapabilityCanaryHealthBinding {
  resourceId: string;
  observationId: string;
  expiresAt: string;
}

export interface StageCapabilityCanaryInput {
  acquisitionId: string;
  expectedAcquisitionVersion: number;
  binding: DurableWorkBindingInput;
  authorizedSurface: string;
  normalizedInputs: Record<string, unknown>;
  health: CapabilityCanaryHealthBinding[];
  now?: Date | string;
}

function resolveHealthEvidence(params: {
  runId: string;
  contract: CapabilityCandidateContract;
  bindings: CapabilityCanaryHealthBinding[];
  currentResourceVersions?: Record<string, string>;
  now: string;
}): CapabilityHealthEvidenceRecord[] {
  const observations = listReliabilityObservations({ limit: 5_000 });
  const reliabilitySubjects = new Map(
    listToolReliabilitySubjects({ limit: 5_000 }).map((subject) => [
      subject.subjectId,
      subject,
    ]),
  );
  const required = params.contract.resourceBindings.filter(
    (binding) => binding.required,
  );
  if (
    params.bindings.length !== required.length ||
    new Set(params.bindings.map((item) => item.resourceId)).size !==
      params.bindings.length
  ) {
    throw new Error(
      'Canary health must bind every required resource exactly once.',
    );
  }
  return required.map((resource) => {
    const resourceVersion =
      params.currentResourceVersions?.[resource.resourceId] || resource.version;
    const compatibleVersions = new Set([
      resource.version,
      ...(params.contract.compatibleResourceVersions[resource.resourceId] ||
        []),
    ]);
    if (!compatibleVersions.has(resourceVersion)) {
      throw new Error(
        `Current resource version is incompatible for ${resource.resourceId}.`,
      );
    }
    const supplied = params.bindings.find(
      (item) => item.resourceId === resource.resourceId,
    );
    const observation = supplied
      ? observations.find(
          (candidate) => candidate.observationId === supplied.observationId,
        )
      : undefined;
    const laterAdverse = observation
      ? observations.some(
          (candidate) =>
            candidate.subjectId === observation.subjectId &&
            candidate.observedAt > observation.observedAt &&
            ['degraded', 'blocked', 'failed', 'fallback', 'unknown'].includes(
              candidate.outcome,
            ),
        )
      : false;
    const subject = observation
      ? reliabilitySubjects.get(observation.subjectId)
      : undefined;
    let subjectAliases: unknown = [];
    try {
      subjectAliases = subject ? JSON.parse(subject.aliasesJson) : [];
    } catch {
      subjectAliases = [];
    }
    const observedAtMs = observation
      ? Date.parse(observation.observedAt)
      : Number.NaN;
    const expiresAtMs = supplied ? Date.parse(supplied.expiresAt) : Number.NaN;
    const nowMs = Date.parse(params.now);
    if (
      !supplied ||
      !observation ||
      !subject ||
      !Array.isArray(subjectAliases) ||
      !subjectAliases.includes(resource.resourceId) ||
      observation.sourceKind !== 'verified_usage' ||
      observation.outcome !== 'success' ||
      observation.confidence !== 1 ||
      observation.fallbackUsed ||
      laterAdverse ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(nowMs) ||
      observedAtMs > nowMs ||
      nowMs - observedAtMs > DEFAULT_HEALTH_EVIDENCE_TTL_MS ||
      expiresAtMs - observedAtMs > DEFAULT_HEALTH_EVIDENCE_TTL_MS ||
      supplied.expiresAt <= params.now ||
      observation.observedAt >= supplied.expiresAt
    ) {
      throw new Error(
        `No fresh successful health proof for ${resource.resourceId}.`,
      );
    }
    const evidenceDigest = sha256(
      canonicalCapabilityJson({
        runId: params.runId,
        resourceId: resource.resourceId,
        resourceVersion,
        subjectId: observation.subjectId,
        observationId: observation.observationId,
        observedAt: observation.observedAt,
        expiresAt: supplied.expiresAt,
        outcome: observation.outcome,
      }),
    );
    return {
      runId: params.runId,
      resourceId: resource.resourceId,
      resourceVersion,
      subjectId: observation.subjectId,
      observationId: observation.observationId,
      observedAt: observation.observedAt,
      expiresAt: supplied.expiresAt,
      evidenceDigest,
      privacyJson: PRODUCTION_PRIVACY,
    };
  });
}

function assertFreshBoundProductionHealth(params: {
  run: CapabilityProductionRunRecord;
  contract: CapabilityCandidateContract;
  now: string;
}): CapabilityHealthEvidenceRecord[] {
  if (params.run.expiresAt <= params.now) {
    throw new Error(
      'Production run expired before the requested authority boundary.',
    );
  }
  const persisted = listCapabilityHealthEvidence(params.run.runId);
  const revalidated = resolveHealthEvidence({
    runId: params.run.runId,
    contract: params.contract,
    bindings: persisted.map((item) => ({
      resourceId: item.resourceId,
      observationId: item.observationId,
      expiresAt: item.expiresAt,
    })),
    currentResourceVersions: Object.fromEntries(
      persisted.map((item) => [item.resourceId, item.resourceVersion]),
    ),
    now: params.now,
  });
  if (
    capabilityHealthEvidenceSetDigest(revalidated) !==
      params.run.healthEvidenceSetDigest ||
    revalidated.some((item) => {
      const existing = persisted.find(
        (candidate) => candidate.resourceId === item.resourceId,
      );
      return !existing || existing.evidenceDigest !== item.evidenceDigest;
    })
  ) {
    throw new Error(
      'Production dependency-health evidence changed or became stale.',
    );
  }
  return revalidated;
}

function latestVerifiedHealthBindings(
  contract: CapabilityCandidateContract,
  now: string,
): CapabilityCanaryHealthBinding[] {
  const subjects = new Map(
    listToolReliabilitySubjects({ limit: 5_000 }).map((subject) => [
      subject.subjectId,
      subject,
    ]),
  );
  const observations = listReliabilityObservations({ limit: 5_000 })
    .filter(
      (observation) =>
        observation.observedAt <= now &&
        Date.parse(now) - Date.parse(observation.observedAt) <
          DEFAULT_HEALTH_EVIDENCE_TTL_MS &&
        observation.sourceKind === 'verified_usage' &&
        observation.outcome === 'success' &&
        observation.confidence === 1 &&
        !observation.fallbackUsed,
    )
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  return contract.resourceBindings
    .filter((resource) => resource.required)
    .map((resource) => {
      const observation = observations.find((candidate) => {
        const subject = subjects.get(candidate.subjectId);
        if (!subject) return false;
        try {
          const aliases = JSON.parse(subject.aliasesJson) as unknown;
          return (
            Array.isArray(aliases) && aliases.includes(resource.resourceId)
          );
        } catch {
          return false;
        }
      });
      if (!observation) {
        throw new Error(
          `No fresh successful health proof for ${resource.resourceId}.`,
        );
      }
      return {
        resourceId: resource.resourceId,
        observationId: observation.observationId,
        expiresAt: plusMs(
          observation.observedAt,
          DEFAULT_HEALTH_EVIDENCE_TTL_MS,
        ),
      };
    });
}

function acquisitionPlanningMetrics(
  acquisitionId: string,
  contract: CapabilityCandidateContract,
): Pick<
  CapabilityProductionRunRecord,
  'resourceDiscoveryCalls' | 'candidateDesignCalls' | 'toolSelectionCalls'
> {
  const transitions = listCapabilityAcquisitionTransitions(acquisitionId);
  return {
    resourceDiscoveryCalls: transitions.filter(
      (transition) => transition.toState === 'resource_discovery',
    ).length,
    candidateDesignCalls: transitions.filter(
      (transition) => transition.toState === 'candidate_designed',
    ).length,
    // Each immutable contract step is one canonical tool/binding selection.
    toolSelectionCalls: contract.steps.length,
  };
}

function canaryApprovalSummary(
  acquisition: CapabilityAcquisitionRecord,
  contract: CapabilityCandidateContract,
  targetScopeHash: string,
): string {
  const protectedActions = contract.steps
    .filter((step) => step.approvalRequired)
    .map((step) => step.actionClass);
  return [
    `Approve one canary: ${contract.title} v${contract.contractVersion}.`,
    `Task family: ${contract.taskFamily}.`,
    `Target: ${targetScopeHash.slice(0, 16)} (hashed).`,
    `Operations: ${contract.steps.map((step) => step.operationId).join(', ')}.`,
    `Resources: ${contract.resourceBindings.map((item) => `${item.resourceId}@${item.version}`).join(', ')}.`,
    `Data egress: ${acquisition.dataEgressClass}.`,
    `Protected actions: ${protectedActions.length ? protectedActions.join(', ') : 'none'}.`,
    'This authorizes only this canary; it does not activate future reuse.',
  ].join(' ');
}

export function stageCapabilityCanary(input: StageCapabilityCanaryInput): {
  run: CapabilityProductionRunRecord;
  approval: CognitiveApprovalPacket;
} {
  return runCapabilityProductionStagingAtomic(() =>
    stageCapabilityCanaryWithinTransaction(input),
  );
}

function stageCapabilityCanaryWithinTransaction(
  input: StageCapabilityCanaryInput,
): {
  run: CapabilityProductionRunRecord;
  approval: CognitiveApprovalPacket;
} {
  const now = iso(input.now);
  const acquisition = getCapabilityAcquisition(input.acquisitionId);
  if (
    !acquisition ||
    acquisition.recordVersion !== input.expectedAcquisitionVersion
  ) {
    throw new Error(
      'Capability acquisition head changed before canary staging.',
    );
  }
  const contract = assertProductionCandidate(acquisition);
  if (acquisition?.groupFolder !== input.binding.groupId) {
    throw new Error('Canary owner group does not match the acquisition scope.');
  }
  let openRuns = listCapabilityProductionRuns({
    acquisitionId: input.acquisitionId,
    statuses: [
      'proposed',
      'awaiting_canary_approval',
      'canary_ready',
      'running',
      'awaiting_owner_review',
      'owner_reviewed',
      'awaiting_activation_approval',
    ],
    limit: 10,
  });
  const expiredPending = openRuns.find((run) => {
    if (run.status !== 'awaiting_canary_approval') return false;
    const packet = listCognitiveApprovalPackets({
      groupFolder: run.groupFolder,
      limit: 500,
    }).find(
      (candidate) => candidate.approvalPacketId === run.canaryApprovalPacketId,
    );
    return (
      run.expiresAt <= now ||
      packet?.status === 'expired' ||
      Boolean(packet?.expiresAt && packet.expiresAt <= now)
    );
  });
  if (expiredPending) {
    expireCapabilityPendingAuthorityAtomic({
      runId: expiredPending.runId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: expiredPending.revision,
      authorityKind: 'canary',
      now,
    });
    openRuns = listCapabilityProductionRuns({
      acquisitionId: input.acquisitionId,
      statuses: [
        'proposed',
        'awaiting_canary_approval',
        'canary_ready',
        'running',
        'awaiting_owner_review',
        'owner_reviewed',
        'awaiting_activation_approval',
      ],
      limit: 10,
    });
  }
  if (openRuns.length > 0) {
    throw new Error('This candidate already has an open production canary.');
  }
  const runId = `capability-run:${randomUUID()}`;
  const cognitiveRunId = `cognitive:capability-canary:${randomUUID()}`;
  const targetScopeHash = durableScopeHash(
    'target',
    input.binding.targetScopeKey,
  );
  const inputDigest = sha256(canonicalCapabilityJson(input.normalizedInputs));
  // All caller-controlled and freshness-sensitive evidence must validate
  // before any cognitive run, durable work, checkpoint, or approval packet is
  // written. A rejected proposal must leave no partial authority artifacts.
  const health = resolveHealthEvidence({
    runId,
    contract,
    bindings: input.health,
    now,
  });
  const planningMetrics = acquisitionPlanningMetrics(
    acquisition.acquisitionId,
    contract,
  );
  let stagedWorkId: string | null = null;
  try {
    upsertCognitiveRun({
      runId: cognitiveRunId,
      createdAt: now,
      updatedAt: now,
      groupFolder: input.binding.groupId,
      channel: input.binding.channel,
      taskFamily: contract.taskFamily,
      turnId: null,
      runOrigin: 'live',
      goalSummary: `Authorize one bounded canary for ${contract.title}.`,
      selectedSkillId: contract.skillId,
      status: 'awaiting_approval',
      autonomyLevel: 'none',
      cognitiveMode: 'approval_staged',
      taskGraphJson: JSON.stringify({
        acquisitionId: acquisition.acquisitionId,
        runId,
        candidateFingerprint: contract.candidateFingerprint,
        stepIds: contract.steps.map((step) => step.stepId),
      }),
      evidenceContractJson: JSON.stringify({
        postconditions: contract.successPostconditions,
        verifierBindingIds: contract.verifierBindingIds,
      }),
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0,
      nextAction: 'Wait for exact owner approval of this canary only.',
      privacyJson: PRODUCTION_PRIVACY,
      linkedSkillCardId: null,
    });
    let work = createOrLoadDurableWork({
      originTurnId: runId,
      authorizedSurface: input.authorizedSurface,
      binding: input.binding,
      goalSummary: `Run one verified canary for ${contract.title}.`,
      status: 'ready',
      cognitiveRunId,
      nextAction: 'Stage exact canary approval before execution.',
      now,
    }).work;
    stagedWorkId = work.workId;
    linkDurableWorkProjection(
      work.workId,
      'capability_production_run',
      runId,
      now,
    );
    linkDurableWorkProjection(
      work.workId,
      'capability_acquisition',
      acquisition.acquisitionId,
      now,
    );
    const initialCheckpoint = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      pendingNodeIds: contract.steps.map((step) => step.stepId),
      dependencyIds: contract.resourceBindings.map(
        (resource) =>
          `capability-resource:${sha256(resource.resourceId).slice(0, 32)}`,
      ),
      worldSignals: {
        fresh: contract.resourceBindings.map(
          (resource) =>
            `resource-health:${sha256(resource.resourceId).slice(0, 32)}`,
        ),
      },
      executorScopeKey: contract.candidateFingerprint,
      targetScopeKey: input.binding.targetScopeKey,
      verificationRequirementIds: contract.verifierBindingIds.map(
        (id) => `capability-verifier:${sha256(id).slice(0, 32)}`,
      ),
      retryBudget: 1,
      attemptsUsed: 0,
      stopConditionIds: [
        'scope_mismatch',
        'approval_mismatch',
        'health_stale',
        'unknown_effect',
        'postcondition_failure',
      ],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Wait for exact canary approval.',
      now,
    });
    work = initialCheckpoint.work;
    const staged = stageDurableWorkApproval({
      workId: work.workId,
      expectedWorkVersion: work.version,
      cognitiveRunId,
      actionClass: 'operator_change',
      summary: canaryApprovalSummary(acquisition, contract, targetScopeHash),
      checkpointId: initialCheckpoint.checkpoint.durableCheckpointId,
      now,
    });
    work = staged.work;
    const run: CapabilityProductionRunRecord = {
      runId,
      acquisitionId: acquisition.acquisitionId,
      createdAt: now,
      updatedAt: now,
      runKind: 'canary',
      status: 'awaiting_canary_approval',
      revision: 1,
      candidateFingerprint: contract.candidateFingerprint,
      contractVersion: contract.contractVersion,
      contractDigest: capabilityProductionContractDigest(
        acquisition.candidateContractJson,
      ),
      taskFamily: contract.taskFamily,
      groupFolder: input.binding.groupId,
      ownerScopeHash: work.ownerScopeHash,
      chatScopeHash: work.chatScopeHash,
      groupScopeHash: work.groupScopeHash,
      channel: work.channel,
      authorizedSurface: input.authorizedSurface,
      targetScopeHash: work.targetScopeHash,
      inputDigest,
      actionClass: 'operator_change',
      workId: work.workId,
      workVersion: work.version,
      planVersion: work.planVersion,
      checkpointId: staged.checkpoint.durableCheckpointId,
      invocationId: `capability-invocation:${randomUUID()}`,
      canaryApprovalPacketId: staged.packet.approvalPacketId,
      canaryApprovalVersion: staged.packet.approvalVersion || 1,
      canaryApprovalScopeDigest: staged.packet.scopeDigest || null,
      canaryGrantId: null,
      canaryLeaseId: null,
      executionGrantId: null,
      executionLeaseId: null,
      activationApprovalPacketId: null,
      activationApprovalVersion: null,
      activationApprovalScopeDigest: null,
      activationGrantId: null,
      activationLeaseId: null,
      activationWorkId: null,
      activationWorkVersion: null,
      activationPlanVersion: null,
      activationCheckpointId: null,
      activationInvocationId: null,
      outcomeId: null,
      ownerReviewId: null,
      healthEvidenceSetDigest: capabilityHealthEvidenceSetDigest(health),
      postconditionFingerprint: null,
      ...planningMetrics,
      executionCalls: 0,
      evaluatorCalls: 0,
      latencyMs: 0,
      providerCalls: 0,
      costUsd: 0,
      matchConfidence: null,
      expiresAt: plusMs(now, DEFAULT_RUN_TTL_MS),
      completedAt: null,
      nextSafeAction: 'Owner must approve this exact canary proposal.',
      privacyJson: PRODUCTION_PRIVACY,
    };
    emitProductionCapabilityBoundarySync({
      boundary: 'after_canary_stage_before_run',
      runId,
    });
    insertCapabilityProductionRunWithHealthAtomic({ run, health });
    return {
      run: getCapabilityProductionRun(runId) as CapabilityProductionRunRecord,
      approval: staged.packet,
    };
  } catch (error) {
    if (stagedWorkId) {
      failOrphanCapabilityStagingAtomic({ workId: stagedWorkId, now });
    }
    throw error;
  }
}

function approvedPacketForRun(
  run: CapabilityProductionRunRecord,
  packetId: string | null | undefined,
): CognitiveApprovalPacket {
  const packet = listCognitiveApprovalPackets({
    groupFolder: run.groupFolder,
    limit: 500,
  }).find((candidate) => candidate.approvalPacketId === packetId);
  if (
    !packet ||
    packet.status !== 'approved' ||
    !packet.scopeDigest ||
    !packet.approvalVersion ||
    packet.actionClass !== 'operator_change'
  ) {
    throw new Error('The exact capability approval packet is not approved.');
  }
  return packet;
}

export function authorizeApprovedCapabilityCanary(params: {
  runId: string;
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  workerId: string;
  now?: Date | string;
}): ReturnType<typeof reconcileCapabilityProductionEvidenceAtomic> {
  const now = iso(params.now);
  let run = getCapabilityProductionRun(params.runId);
  const expectedAcquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    !run ||
    !expectedAcquisition ||
    run.revision !== params.expectedRunRevision ||
    expectedAcquisition.recordVersion !== params.expectedAcquisitionVersion ||
    run.authorizedSurface !== params.authorizedSurface
  ) {
    throw new Error('Capability canary head or authorized surface changed.');
  }
  const existingAuthorization = run
    ? listCapabilityProductionTransitionReceipts({
        runId: run.runId,
        limit: 100,
      }).find((receipt) => receipt.transitionKind === 'canary_authorized')
    : undefined;
  if (
    run &&
    existingAuthorization &&
    [
      'canary_ready',
      'running',
      'awaiting_owner_review',
      'owner_reviewed',
      'awaiting_activation_approval',
      'active',
      'monitoring',
    ].includes(run.status)
  ) {
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    if (acquisition) {
      return { acquisition, run, receipt: existingAuthorization };
    }
  }
  if (!run || run.status !== 'awaiting_canary_approval') {
    throw new Error('Capability canary is not awaiting approval consumption.');
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    expectedAcquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  assertFreshBoundProductionHealth({ run, contract, now });
  if (run.canaryGrantId && run.canaryLeaseId) {
    const lease = getDurableWorkLease(run.canaryLeaseId);
    const work = getDurableWorkUnit(run.workId);
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    if (
      !lease ||
      !work ||
      !acquisition ||
      lease.status !== 'active' ||
      lease.expiresAt <= now ||
      work.leaseId !== lease.leaseId
    ) {
      throw new Error(
        'Bound canary authorization became stale before reconciliation.',
      );
    }
    try {
      return reconcileCapabilityProductionEvidenceAtomic({
        runId: run.runId,
        operation: 'authorize_canary',
        expectedAcquisitionVersion: acquisition.recordVersion,
        expectedRunRevision: run.revision,
        now,
      });
    } catch (error) {
      releaseDurableLease({
        leaseId: lease.leaseId,
        processGeneration: lease.processGeneration,
        now,
      });
      const failedBinding = getCapabilityProductionRun(run.runId);
      if (
        failedBinding?.status === 'awaiting_canary_approval' &&
        failedBinding.canaryGrantId === run.canaryGrantId &&
        failedBinding.canaryLeaseId === lease.leaseId
      ) {
        updateCapabilityProductionRunCAS({
          expectedRevision: failedBinding.revision,
          next: {
            ...failedBinding,
            updatedAt: now,
            revision: failedBinding.revision + 1,
            canaryGrantId: null,
            canaryLeaseId: null,
            nextSafeAction:
              'Revalidate the exact canary approval and acquire a fresh lease.',
          },
        });
      }
      throw error;
    }
  }
  const packet = approvedPacketForRun(run, run.canaryApprovalPacketId);
  const issued = issueDurableResumeGrant({
    workId: run.workId,
    binding: params.binding,
    actionClass: 'operator_change',
    approvalPacketId: packet.approvalPacketId,
    approvalVersion: packet.approvalVersion,
    now,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: params.binding,
    actionClass: 'operator_change',
    workerId: params.workerId,
    now,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error(`Canary lease acquisition failed: ${consumed.status}.`);
  }
  const work = getDurableWorkUnit(run.workId);
  if (!work || !work.checkpointHeadId) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      now,
    });
    throw new Error('Canary durable work disappeared after lease acquisition.');
  }
  const next: CapabilityProductionRunRecord = {
    ...run,
    updatedAt: now,
    revision: run.revision + 1,
    workVersion: work.version,
    planVersion: work.planVersion,
    checkpointId: work.checkpointHeadId,
    canaryApprovalVersion: packet.approvalVersion,
    canaryApprovalScopeDigest: packet.scopeDigest,
    canaryGrantId: issued.grant.grantId,
    canaryLeaseId: consumed.lease.leaseId,
    nextSafeAction: 'Atomically authorize only this exact canary.',
  };
  if (
    updateCapabilityProductionRunCAS({
      expectedRevision: run.revision,
      next,
    }) !== 'applied'
  ) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      now,
    });
    throw new Error('Canary approval binding lost its revision race.');
  }
  run = getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
  const acquisition = getCapabilityAcquisition(run.acquisitionId);
  if (!acquisition) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      now,
    });
    throw new Error('Capability acquisition disappeared.');
  }
  try {
    return reconcileCapabilityProductionEvidenceAtomic({
      runId: run.runId,
      operation: 'authorize_canary',
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: run.revision,
      now,
    });
  } catch (error) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      now,
    });
    const failedBinding = getCapabilityProductionRun(run.runId);
    if (
      failedBinding?.status === 'awaiting_canary_approval' &&
      failedBinding.canaryGrantId === issued.grant.grantId &&
      failedBinding.canaryLeaseId === consumed.lease.leaseId
    ) {
      updateCapabilityProductionRunCAS({
        expectedRevision: failedBinding.revision,
        next: {
          ...failedBinding,
          updatedAt: now,
          revision: failedBinding.revision + 1,
          canaryGrantId: null,
          canaryLeaseId: null,
          nextSafeAction:
            'Revalidate the exact canary approval and acquire a fresh lease.',
        },
      });
    }
    throw error;
  }
}

function ownerActionTokenRecord(params: {
  run: CapabilityProductionRunRecord;
  acquisition: CapabilityAcquisitionRecord;
  actionKind: CapabilityOwnerActionTokenRecord['actionKind'];
  now: string;
  messageId?: string | null;
}): { token: string; record: CapabilityOwnerActionTokenRecord } {
  const token = randomBytes(24).toString('base64url');
  return {
    token,
    record: {
      tokenHash: sha256(token),
      actionKind: params.actionKind,
      acquisitionId: params.acquisition.acquisitionId,
      runId: params.run.runId,
      candidateFingerprint: params.run.candidateFingerprint,
      contractVersion: params.run.contractVersion,
      expectedAcquisitionVersion: params.acquisition.recordVersion,
      expectedRunRevision: params.run.revision,
      ownerScopeHash: params.run.ownerScopeHash,
      chatScopeHash: params.run.chatScopeHash,
      groupScopeHash: params.run.groupScopeHash,
      channel: params.run.channel,
      authorizedSurface: params.run.authorizedSurface,
      messageHash: params.messageId
        ? durableScopeHash('owner-review-message', params.messageId)
        : null,
      createdAt: params.now,
      expiresAt: plusMs(params.now, DEFAULT_ACTION_TOKEN_TTL_MS),
      consumedAt: null,
      privacyJson: PRODUCTION_PRIVACY,
    },
  };
}

const OWNER_REVIEWABLE_RUN_STATUSES: CapabilityProductionRunRecord['status'][] =
  [
    'awaiting_owner_review',
    'owner_reviewed',
    'awaiting_activation_approval',
    'active',
    'monitoring',
    'partial',
    'blocked',
    'paused',
  ];

export function issueCapabilityReviewTokenForTrustedChat(params: {
  runId: string;
  channelName: string;
  chatJid: string;
  group: RegisteredGroup;
  messageId?: string | null;
  now?: Date | string;
}): string {
  if (!isTrustedOwnerReviewSurface(params)) {
    throw new Error(
      'Capability review requires a trusted private owner surface.',
    );
  }
  const now = iso(params.now);
  const run = getCapabilityProductionRun(params.runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    !run ||
    !acquisition ||
    !OWNER_REVIEWABLE_RUN_STATUSES.includes(run.status) ||
    !run.outcomeId ||
    run.groupFolder !== params.group.folder ||
    run.authorizedSurface !== params.channelName ||
    run.ownerScopeHash !== durableScopeHash('owner', 'owner') ||
    run.groupScopeHash !== durableScopeHash('group', params.group.folder)
  ) {
    throw new Error('Capability run is not awaiting this owner review.');
  }
  if (
    durableScopeHash('chat', params.chatJid) !== run.chatScopeHash ||
    run.channel !== params.channelName
  ) {
    throw new Error('Capability review surface does not match the canary.');
  }
  const token = ownerActionTokenRecord({
    run,
    acquisition,
    actionKind: 'review_canary',
    now,
    messageId: params.messageId,
  });
  insertCapabilityOwnerActionToken(token.record);
  return token.token;
}

/** Owner-cockpit callers must invoke this only after session and CSRF checks. */
export function issueCapabilityReviewTokenForAuthenticatedCockpit(params: {
  runId: string;
  now?: Date | string;
}): string {
  const now = iso(params.now);
  const run = getCapabilityProductionRun(params.runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    !run ||
    !acquisition ||
    !OWNER_REVIEWABLE_RUN_STATUSES.includes(run.status) ||
    !run.outcomeId
  ) {
    throw new Error('Capability run is not awaiting owner review.');
  }
  if (run.authorizedSurface !== 'owner_cockpit') {
    throw new Error('Capability review cannot change authorized surfaces.');
  }
  const token = ownerActionTokenRecord({
    run,
    acquisition,
    actionKind: 'review_canary',
    now,
  });
  insertCapabilityOwnerActionToken(token.record);
  return token.token;
}

export function recordCapabilityOwnerVerdict(params: {
  token: string;
  verdict: CapabilityOwnerReviewVerdict;
  sourceMessageId?: string | null;
  now?: Date | string;
}): ReturnType<typeof reconcileCapabilityProductionEvidenceAtomic> {
  const now = iso(params.now);
  const tokenHash = sha256(params.token);
  const review = recordCapabilityOwnerReviewWithToken({
    tokenHash,
    verdict: params.verdict,
    sourceMessageHash: params.sourceMessageId
      ? durableScopeHash('owner-review-message', params.sourceMessageId)
      : null,
    now,
  });
  emitProductionCapabilityBoundarySync({
    boundary: 'after_owner_review_before_reconcile',
    runId: review.runId,
  });
  const run = getCapabilityProductionRun(
    review.runId,
  ) as CapabilityProductionRunRecord;
  const acquisition = getCapabilityAcquisition(run.acquisitionId);
  if (!acquisition) throw new Error('Capability acquisition disappeared.');
  let canonicalReview: { reviewId?: string; revision?: number } = {};
  try {
    canonicalReview = JSON.parse(acquisition.ownerReviewJson) as {
      reviewId?: string;
      revision?: number;
    };
  } catch {
    canonicalReview = {};
  }
  if (
    run.ownerReviewId === review.reviewId &&
    canonicalReview.reviewId === review.reviewId &&
    canonicalReview.revision === review.revision
  ) {
    const receipt = listCapabilityProductionTransitionReceipts({
      runId: run.runId,
      limit: 100,
    }).find((candidate) => candidate.resultingRunRevision === run.revision);
    if (!receipt) {
      throw new Error(
        'Canonical owner review is missing its transition receipt.',
      );
    }
    return { acquisition, run, receipt };
  }
  return reconcileCapabilityProductionEvidenceAtomic({
    runId: run.runId,
    operation: 'record_owner_review',
    expectedAcquisitionVersion: acquisition.recordVersion,
    expectedRunRevision: run.revision,
    now,
  });
}

function activationApprovalSummary(
  contract: CapabilityCandidateContract,
): string {
  return [
    `Activate only ${contract.title} v${contract.contractVersion}.`,
    `Task family: ${contract.taskFamily}.`,
    `Triggers: ${contract.triggerSemantics.join(', ')}.`,
    `Required inputs: ${contract.requiredInputs.join(', ') || 'none'}.`,
    `Allowed operations: ${contract.steps.map((step) => step.operationId).join(', ')}.`,
    `Tools: ${contract.steps.map((step) => step.bindingId).join(', ')}.`,
    `Approval rules: ${contract.approvalRequirements.join(', ') || 'none beyond activation'}.`,
    `Data egress: ${contract.dataEgressClass}.`,
    `Expected postcondition: ${contract.successPostconditions.join('; ')}.`,
    `Fallback: ${contract.fallbackPaths[0] || 'stop and report the blocker'}.`,
    'Every protected effect still needs its normal fresh approval. Monitoring, pause, revoke, and retirement remain available.',
  ].join(' ');
}

export function stageCapabilityActivation(params: {
  runId: string;
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  now?: Date | string;
}): { run: CapabilityProductionRunRecord; approval: CognitiveApprovalPacket } {
  return runCapabilityProductionStagingAtomic(() =>
    stageCapabilityActivationWithinTransaction(params),
  );
}

function stageCapabilityActivationWithinTransaction(params: {
  runId: string;
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  now?: Date | string;
}): { run: CapabilityProductionRunRecord; approval: CognitiveApprovalPacket } {
  const now = iso(params.now);
  let run = getCapabilityProductionRun(params.runId);
  let expectedRunRevision = params.expectedRunRevision;
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    run &&
    acquisition &&
    run.revision === params.expectedRunRevision &&
    acquisition.recordVersion === params.expectedAcquisitionVersion &&
    run.authorizedSurface === params.authorizedSurface &&
    run.status === 'awaiting_activation_approval'
  ) {
    const packet = listCognitiveApprovalPackets({
      groupFolder: run.groupFolder,
      limit: 500,
    }).find(
      (candidate) =>
        candidate.approvalPacketId === run?.activationApprovalPacketId,
    );
    if (
      run.expiresAt <= now ||
      packet?.status === 'expired' ||
      Boolean(packet?.expiresAt && packet.expiresAt <= now)
    ) {
      run = expireCapabilityPendingAuthorityAtomic({
        runId: run.runId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        expectedRunRevision: run.revision,
        authorityKind: 'activation',
        now,
      });
      expectedRunRevision = run.revision;
    }
  }
  if (
    !run ||
    !acquisition ||
    run.revision !== expectedRunRevision ||
    acquisition.recordVersion !== params.expectedAcquisitionVersion ||
    run.authorizedSurface !== params.authorizedSurface ||
    run.runKind !== 'canary' ||
    run.status !== 'owner_reviewed' ||
    acquisition.state !== 'canary_ready' ||
    !run.ownerReviewId ||
    acquisition.groupFolder !== params.binding.groupId
  ) {
    throw new Error(
      'Capability is not eligible for a separate activation proposal.',
    );
  }
  const review = getCapabilityOwnerReviewForRun(run.runId);
  if (!review || review.verdict !== 'verified') {
    throw new Error(
      'Only a verified exact owner verdict can precede activation.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  if (
    durableScopeHash('owner', params.binding.ownerId) !== run.ownerScopeHash ||
    durableScopeHash('chat', params.binding.chatId) !== run.chatScopeHash ||
    durableScopeHash('group', params.binding.groupId) !== run.groupScopeHash ||
    durableScopeHash('target', params.binding.targetScopeKey) !==
      run.targetScopeHash ||
    params.binding.channel !== run.channel
  ) {
    throw new Error('Activation proposal cannot broaden canary scope.');
  }
  const persistedHealth = listCapabilityHealthEvidence(run.runId);
  if (
    run.expiresAt <= now ||
    persistedHealth.some((item) => item.expiresAt <= now)
  ) {
    const currentResourceVersions = Object.fromEntries(
      persistedHealth.map((item) => [item.resourceId, item.resourceVersion]),
    );
    const health = resolveHealthEvidence({
      runId: run.runId,
      contract,
      bindings: latestVerifiedHealthBindings(contract, now),
      currentResourceVersions,
      now,
    });
    run = refreshCapabilityProductionHealthAtomic({
      runId: run.runId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: run.revision,
      health,
      now,
      expiresAt: plusMs(now, DEFAULT_RUN_TTL_MS),
    });
  } else {
    assertFreshBoundProductionHealth({ run, contract, now });
  }
  let stagedActivationWorkId: string | null = null;
  try {
    const cognitiveRunId = `cognitive:capability-activation:${randomUUID()}`;
    upsertCognitiveRun({
      runId: cognitiveRunId,
      createdAt: now,
      updatedAt: now,
      groupFolder: run.groupFolder,
      channel: run.channel,
      taskFamily: run.taskFamily,
      turnId: null,
      runOrigin: 'live',
      goalSummary: `Request exact activation for ${contract.title}.`,
      selectedSkillId: contract.skillId,
      status: 'awaiting_approval',
      autonomyLevel: 'none',
      cognitiveMode: 'approval_staged',
      taskGraphJson: JSON.stringify({
        acquisitionId: acquisition.acquisitionId,
        runId: run.runId,
        candidateFingerprint: run.candidateFingerprint,
        decisionKind: 'activate_exact_capability',
      }),
      evidenceContractJson: JSON.stringify({
        canaryOutcomeId: run.outcomeId,
        ownerReviewId: run.ownerReviewId,
        protectedActionsRetainFreshApproval: true,
      }),
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0,
      nextAction: 'Wait for separate exact activation approval.',
      privacyJson: PRODUCTION_PRIVACY,
      linkedSkillCardId: null,
    });
    let work = createOrLoadDurableWork({
      originTurnId: `activation:${run.runId}:${run.revision}:${cognitiveRunId}`,
      authorizedSurface: run.authorizedSurface,
      binding: params.binding,
      goalSummary: `Authorize exact capability activation for ${contract.title}.`,
      status: 'ready',
      cognitiveRunId,
      nextAction: 'Stage a separate activation decision.',
      now,
    }).work;
    stagedActivationWorkId = work.workId;
    linkDurableWorkProjection(
      work.workId,
      'capability_activation',
      acquisition.acquisitionId,
      now,
    );
    const nodeId = `activate:${run.candidateFingerprint.slice(0, 32)}`;
    const initial = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      pendingNodeIds: [nodeId],
      dependencyIds: [run.runId, run.ownerReviewId as string],
      worldSignals: { fresh: [run.healthEvidenceSetDigest || ''] },
      executorScopeKey: run.candidateFingerprint,
      targetScopeKey: params.binding.targetScopeKey,
      verificationRequirementIds: ['exact-owner-review', 'fresh-health'],
      retryBudget: 0,
      attemptsUsed: 0,
      stopConditionIds: [
        'owner_review_changed',
        'candidate_changed',
        'scope_changed',
        'health_stale',
        'revoked_or_quarantined',
      ],
      recoveryPolicy: 'approval_required',
      nextSafeAction: 'Wait for separate exact activation approval.',
      now,
    });
    work = initial.work;
    const staged = stageDurableWorkApproval({
      workId: work.workId,
      expectedWorkVersion: work.version,
      cognitiveRunId,
      actionClass: 'operator_change',
      summary: activationApprovalSummary(contract),
      checkpointId: initial.checkpoint.durableCheckpointId,
      now,
    });
    work = staged.work;
    const next: CapabilityProductionRunRecord = {
      ...run,
      updatedAt: now,
      status: 'awaiting_activation_approval',
      revision: run.revision + 1,
      activationApprovalPacketId: staged.packet.approvalPacketId,
      activationApprovalVersion: staged.packet.approvalVersion || 1,
      activationApprovalScopeDigest: staged.packet.scopeDigest || null,
      activationGrantId: null,
      activationLeaseId: null,
      activationWorkId: work.workId,
      activationWorkVersion: work.version,
      activationPlanVersion: work.planVersion,
      activationCheckpointId: staged.checkpoint.durableCheckpointId,
      activationInvocationId: `capability-activation:${randomUUID()}`,
      expiresAt: plusMs(now, DEFAULT_RUN_TTL_MS),
      nextSafeAction:
        'Owner must separately approve reuse of this exact contract.',
    };
    emitProductionCapabilityBoundarySync({
      boundary: 'after_activation_stage_before_run',
      runId: run.runId,
    });
    if (
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next,
      }) !== 'applied'
    ) {
      throw new Error('Capability activation proposal lost its revision race.');
    }
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    return { run, approval: staged.packet };
  } catch (error) {
    if (stagedActivationWorkId) {
      failOrphanCapabilityStagingAtomic({
        workId: stagedActivationWorkId,
        now,
      });
    }
    throw error;
  }
}

export function authorizeApprovedCapabilityActivation(params: {
  runId: string;
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
  binding: DurableWorkBindingInput;
  workerId: string;
  now?: Date | string;
}): ReturnType<typeof reconcileCapabilityProductionEvidenceAtomic> {
  const now = iso(params.now);
  let run = getCapabilityProductionRun(params.runId);
  const expectedAcquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    !run ||
    !expectedAcquisition ||
    run.revision !== params.expectedRunRevision ||
    expectedAcquisition.recordVersion !== params.expectedAcquisitionVersion ||
    run.authorizedSurface !== params.authorizedSurface
  ) {
    throw new Error(
      'Capability activation head or authorized surface changed.',
    );
  }
  if (run?.status === 'active') {
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    const receipt = listCapabilityProductionTransitionReceipts({
      runId: run.runId,
      limit: 100,
    }).find((item) => item.transitionKind === 'activated');
    if (
      acquisition &&
      ['active', 'monitoring'].includes(acquisition.state) &&
      receipt
    ) {
      return { acquisition, run, receipt };
    }
  }
  if (
    !run ||
    run.status !== 'awaiting_activation_approval' ||
    !run.activationWorkId
  ) {
    throw new Error(
      'Capability activation is not awaiting approval consumption.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    expectedAcquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  assertFreshBoundProductionHealth({ run, contract, now });
  if (run.activationGrantId && run.activationLeaseId) {
    const lease = getDurableWorkLease(run.activationLeaseId);
    const work = getDurableWorkUnit(run.activationWorkId);
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    if (
      !lease ||
      !work ||
      !acquisition ||
      lease.status !== 'active' ||
      lease.expiresAt <= now ||
      work.leaseId !== lease.leaseId ||
      work.status !== 'completed'
    ) {
      throw new Error(
        'Bound activation evidence became stale before reconciliation.',
      );
    }
    try {
      return reconcileCapabilityProductionEvidenceAtomic({
        runId: run.runId,
        operation: 'activate',
        expectedAcquisitionVersion: acquisition.recordVersion,
        expectedRunRevision: run.revision,
        now,
      });
    } catch (error) {
      const failedBinding = getCapabilityProductionRun(run.runId);
      if (
        failedBinding?.status === 'awaiting_activation_approval' &&
        failedBinding.activationGrantId === run.activationGrantId &&
        failedBinding.activationLeaseId === lease.leaseId
      ) {
        updateCapabilityProductionRunCAS({
          expectedRevision: failedBinding.revision,
          next: {
            ...failedBinding,
            updatedAt: now,
            status: 'owner_reviewed',
            revision: failedBinding.revision + 1,
            activationApprovalPacketId: null,
            activationApprovalVersion: null,
            activationApprovalScopeDigest: null,
            activationGrantId: null,
            activationLeaseId: null,
            activationWorkId: null,
            activationWorkVersion: null,
            activationPlanVersion: null,
            activationCheckpointId: null,
            activationInvocationId: null,
            nextSafeAction:
              'Restage activation only after exact health and owner authority are revalidated.',
          },
        });
      }
      throw error;
    } finally {
      releaseDurableLease({
        leaseId: lease.leaseId,
        processGeneration: lease.processGeneration,
        now,
      });
    }
  }
  const packet = approvedPacketForRun(run, run.activationApprovalPacketId);
  const issued = issueDurableResumeGrant({
    workId: run.activationWorkId,
    binding: params.binding,
    actionClass: 'operator_change',
    approvalPacketId: packet.approvalPacketId,
    approvalVersion: packet.approvalVersion,
    now,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: params.binding,
    actionClass: 'operator_change',
    workerId: params.workerId,
    now,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error(`Activation lease acquisition failed: ${consumed.status}.`);
  }
  try {
    let work = getDurableWorkUnit(run.activationWorkId);
    if (!work || !work.checkpointHeadId) {
      throw new Error(
        'Activation durable work disappeared after lease acquisition.',
      );
    }
    const nodeId = `activate:${run.candidateFingerprint.slice(0, 32)}`;
    const activationFingerprint = sha256(
      canonicalCapabilityJson({
        acquisitionId: run.acquisitionId,
        runId: run.runId,
        candidateFingerprint: run.candidateFingerprint,
        contractVersion: run.contractVersion,
        ownerReviewId: run.ownerReviewId,
        activationApprovalPacketId: packet.approvalPacketId,
        activationApprovalVersion: packet.approvalVersion,
        healthEvidenceSetDigest: run.healthEvidenceSetDigest,
        targetScopeHash: run.targetScopeHash,
      }),
    );
    recordDurableEffect({
      workId: work.workId,
      checkpointId: work.checkpointHeadId,
      planVersion: work.planVersion,
      nodeId,
      invocationId: run.activationInvocationId as string,
      actionClass: 'operator_change',
      authorizationGrantId: issued.grant.grantId,
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      effectClass: 'local_write',
      status: 'started',
      claimExecution: true,
      targetScopeKey: params.binding.targetScopeKey,
      metadata: {
        receiptClass: 'capability_activation_authority',
        resultCode: run.candidateFingerprint,
        source: 'verified_capability_apprenticeship',
      },
      now,
    });
    const verified = recordDurableEffect({
      workId: work.workId,
      checkpointId: work.checkpointHeadId,
      planVersion: work.planVersion,
      nodeId,
      invocationId: run.activationInvocationId as string,
      actionClass: 'operator_change',
      authorizationGrantId: issued.grant.grantId,
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      effectClass: 'local_write',
      status: 'succeeded',
      targetScopeKey: params.binding.targetScopeKey,
      preStateFingerprint: activationFingerprint,
      postStateFingerprint: activationFingerprint,
      verificationFingerprint: activationFingerprint,
      metadata: {
        receiptClass: 'capability_activation_authority',
        resultCode: run.candidateFingerprint,
        source: 'verified_capability_apprenticeship',
      },
      now,
    });
    const completed = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      completedNodeIds: [nodeId],
      pendingNodeIds: [],
      uncertainNodeIds: [],
      dependencyIds: [
        run.runId,
        run.ownerReviewId as string,
        packet.approvalPacketId,
        run.healthEvidenceSetDigest as string,
      ],
      worldSignals: { fresh: [run.healthEvidenceSetDigest as string] },
      executorScopeKey: run.candidateFingerprint,
      targetScopeKey: params.binding.targetScopeKey,
      verifiedPostStateFingerprint: activationFingerprint,
      receiptIds: [verified.receiptId],
      verificationRequirementIds: [
        'exact-owner-review',
        'separate-activation-approval',
        'fresh-health',
      ],
      retryBudget: 0,
      attemptsUsed: 0,
      stopConditionIds: [
        'owner_review_changed',
        'candidate_changed',
        'scope_changed',
        'health_stale',
      ],
      recoveryPolicy: 'approval_required',
      nextSafeAction: 'Atomically join exact activation evidence.',
      status: 'completed',
      now,
    });
    work = completed.work;
    work = transitionDurableWork({
      workId: work.workId,
      expectedVersion: work.version,
      toStatus: 'verifying',
      nextAction: 'Verify the exact activation evidence bundle.',
      now,
    });
    work = transitionDurableWork({
      workId: work.workId,
      expectedVersion: work.version,
      toStatus: 'completed',
      nextAction: 'Activation preconditions are durably verified.',
      now,
    });
    const next: CapabilityProductionRunRecord = {
      ...run,
      updatedAt: now,
      revision: run.revision + 1,
      activationApprovalVersion: packet.approvalVersion,
      activationApprovalScopeDigest: packet.scopeDigest,
      activationGrantId: issued.grant.grantId,
      activationLeaseId: consumed.lease.leaseId,
      activationWorkVersion: work.version,
      activationPlanVersion: work.planVersion,
      activationCheckpointId: completed.checkpoint.durableCheckpointId,
      nextSafeAction:
        'Atomically join activation authority and verified canary evidence.',
    };
    if (
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next,
      }) !== 'applied'
    ) {
      throw new Error('Capability activation binding lost its revision race.');
    }
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    if (!acquisition) throw new Error('Capability acquisition disappeared.');
    return reconcileCapabilityProductionEvidenceAtomic({
      runId: run.runId,
      operation: 'activate',
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: run.revision,
      now,
    });
  } catch (error) {
    const failedBinding = getCapabilityProductionRun(run.runId);
    if (
      failedBinding?.status === 'awaiting_activation_approval' &&
      failedBinding.activationWorkId === run.activationWorkId &&
      (!failedBinding.activationGrantId ||
        failedBinding.activationGrantId === issued.grant.grantId) &&
      (!failedBinding.activationLeaseId ||
        failedBinding.activationLeaseId === consumed.lease.leaseId)
    ) {
      updateCapabilityProductionRunCAS({
        expectedRevision: failedBinding.revision,
        next: {
          ...failedBinding,
          updatedAt: now,
          status: 'owner_reviewed',
          revision: failedBinding.revision + 1,
          activationApprovalPacketId: null,
          activationApprovalVersion: null,
          activationApprovalScopeDigest: null,
          activationGrantId: null,
          activationLeaseId: null,
          activationWorkId: null,
          activationWorkVersion: null,
          activationPlanVersion: null,
          activationCheckpointId: null,
          activationInvocationId: null,
          nextSafeAction:
            'Restage activation only after exact health and owner authority are revalidated.',
        },
      });
    }
    throw error;
  } finally {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration: consumed.lease.processGeneration,
      now,
    });
  }
}

export interface ProductionCapabilityBindingResult {
  result: unknown;
  evidenceRefs: string[];
  effectClass: DurablePolicyEffectClass;
  effectStatus: 'none' | 'certain' | 'unknown';
  preStateFingerprint?: string;
  postStateFingerprint?: string;
  providerCalls?: number;
  costUsd?: number;
}

export interface ProductionCapabilityVerificationResult {
  verified: boolean;
  evidenceRefs: string[];
  verifiedPostconditions: string[];
  postconditionFingerprint?: string;
  reason: string;
}

export interface ProductionCapabilityRecoveryVerificationResult extends ProductionCapabilityVerificationResult {
  /** Optional bounded result reconstructed from current authoritative state. */
  result?: unknown;
}

export interface ProductionCapabilityExecutorBinding {
  bindingId: string;
  operationId: string;
  resourceId: string;
  version: string;
  executorImplementationDigest: string;
  actionClass: DurableActionClass;
  effectClass: DurablePolicyEffectClass;
  networkAccess: 'none' | 'loopback' | 'external';
  maximumCostUsd: number;
  execute(input: {
    values: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<ProductionCapabilityBindingResult>;
}

export interface ProductionCapabilityEvaluatorBinding {
  evaluatorId: string;
  operationId: string;
  resourceId: string;
  version: string;
  evaluatorImplementationDigest: string;
  verify(input: {
    values: Record<string, unknown>;
    result: ProductionCapabilityBindingResult;
    requiredPostconditions: string[];
  }): Promise<ProductionCapabilityVerificationResult>;
  /**
   * Verification-only restart seam. It must inspect current authoritative
   * state and must never invoke or replay the original operation.
   */
  recover?(input: {
    values: Record<string, unknown>;
    existingReceipt: {
      receiptId: string;
      nodeId: string;
      status: 'started' | 'partial' | 'unknown';
      preStateFingerprint?: string | null;
      postStateFingerprint?: string | null;
    };
    requiredPostconditions: string[];
  }): Promise<ProductionCapabilityRecoveryVerificationResult>;
}

export class ProductionCapabilityBindingRegistry {
  readonly #executors: ReadonlyMap<string, ProductionCapabilityExecutorBinding>;
  readonly #evaluators: ReadonlyMap<
    string,
    ProductionCapabilityEvaluatorBinding
  >;

  private constructor(input: {
    executors: readonly ProductionCapabilityExecutorBinding[];
    evaluators: readonly ProductionCapabilityEvaluatorBinding[];
  }) {
    const executors = new Map<string, ProductionCapabilityExecutorBinding>();
    for (const binding of input.executors) {
      if (
        !binding.bindingId ||
        !binding.operationId ||
        !binding.resourceId ||
        !/^[a-f0-9]{64}$/.test(binding.executorImplementationDigest) ||
        !Number.isFinite(binding.maximumCostUsd) ||
        binding.maximumCostUsd < 0 ||
        binding.maximumCostUsd > MAX_LIVE_COST_USD ||
        executors.has(binding.bindingId)
      ) {
        throw new Error(
          'Production capability executor identity is malformed.',
        );
      }
      executors.set(binding.bindingId, Object.freeze({ ...binding }));
    }
    const evaluators = new Map<string, ProductionCapabilityEvaluatorBinding>();
    for (const evaluator of input.evaluators) {
      if (
        !evaluator.evaluatorId ||
        !evaluator.operationId ||
        !evaluator.resourceId ||
        !/^[a-f0-9]{64}$/.test(evaluator.evaluatorImplementationDigest) ||
        evaluators.has(evaluator.evaluatorId)
      ) {
        throw new Error(
          'Production capability evaluator identity is malformed.',
        );
      }
      evaluators.set(evaluator.evaluatorId, Object.freeze({ ...evaluator }));
    }
    this.#executors = executors;
    this.#evaluators = evaluators;
  }

  static createBundled(): ProductionCapabilityBindingRegistry {
    return new ProductionCapabilityBindingRegistry({
      executors: BUNDLED_PRODUCTION_EXECUTORS,
      evaluators: BUNDLED_PRODUCTION_EVALUATORS,
    });
  }

  /** @internal Disposable isolated-database certification only. */
  static createIsolatedTest(input: {
    executors: readonly ProductionCapabilityExecutorBinding[];
    evaluators: readonly ProductionCapabilityEvaluatorBinding[];
  }): ProductionCapabilityBindingRegistry {
    if (!isIsolatedTestDatabase()) {
      throw new Error(
        'Custom production bindings are restricted to isolated tests.',
      );
    }
    return new ProductionCapabilityBindingRegistry(input);
  }

  resolveExecutor(
    step: CapabilityCandidateContract['steps'][number],
  ): ProductionCapabilityExecutorBinding {
    const binding = this.#executors.get(step.bindingId);
    if (
      !binding ||
      binding.operationId !== step.operationId ||
      binding.resourceId !== step.resourceId ||
      binding.version !== step.version ||
      binding.executorImplementationDigest !==
        step.executorImplementationDigest ||
      binding.actionClass !== step.actionClass ||
      binding.effectClass === 'sandbox_repository_write'
    ) {
      throw new ProductionCapabilityQuarantineError(
        'Production binding is absent or differs from the contract.',
      );
    }
    return binding;
  }

  resolveEvaluator(
    step: CapabilityCandidateContract['steps'][number],
  ): ProductionCapabilityEvaluatorBinding {
    const evaluator = this.#evaluators.get(step.evaluatorId);
    if (
      !evaluator ||
      evaluator.operationId !== step.operationId ||
      evaluator.resourceId !== step.resourceId ||
      evaluator.version !== step.version ||
      evaluator.evaluatorImplementationDigest !==
        step.evaluatorImplementationDigest
    ) {
      throw new ProductionCapabilityQuarantineError(
        'Production evaluator is absent or differs from the contract.',
      );
    }
    return evaluator;
  }
}

export function createIsolatedProductionCapabilityRegistryForTest(input: {
  executors: readonly ProductionCapabilityExecutorBinding[];
  evaluators: readonly ProductionCapabilityEvaluatorBinding[];
}): ProductionCapabilityBindingRegistry {
  return ProductionCapabilityBindingRegistry.createIsolatedTest(input);
}

const BUNDLED_PRODUCTION_EXECUTORS: readonly ProductionCapabilityExecutorBinding[] =
  [
    {
      bindingId: RELEASE_READINESS_BINDING_ID,
      operationId: RELEASE_READINESS_OPERATION_ID,
      resourceId: RELEASE_READINESS_RESOURCE_ID,
      version: RELEASE_READINESS_VERSION,
      executorImplementationDigest: RELEASE_READINESS_EXECUTOR_DIGEST,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      // The canonical status readers probe only the local OpenClaw gateway. The
      // contract still declares dataEgressClass=none and rejects external access.
      networkAccess: 'loopback',
      maximumCostUsd: 0,
      async execute() {
        const brief = buildReleaseReadinessBrief();
        return {
          result: brief,
          evidenceRefs: brief.evidenceRefs,
          effectClass: 'read_only',
          effectStatus: 'none',
          preStateFingerprint: brief.truthFingerprint,
          postStateFingerprint: brief.truthFingerprint,
          providerCalls: 0,
          costUsd: 0,
        };
      },
    },
  ];
const BUNDLED_PRODUCTION_EVALUATORS: readonly ProductionCapabilityEvaluatorBinding[] =
  [
    {
      evaluatorId: RELEASE_READINESS_EVALUATOR_ID,
      operationId: RELEASE_READINESS_OPERATION_ID,
      resourceId: RELEASE_READINESS_RESOURCE_ID,
      version: RELEASE_READINESS_VERSION,
      evaluatorImplementationDigest: RELEASE_READINESS_EVALUATOR_DIGEST,
      async verify(input) {
        const result = input.result.result as ReleaseReadinessBrief;
        const current = buildReleaseReadinessBrief();
        const stableResult = releaseReadinessStableTruth(result);
        const stableCurrent = releaseReadinessStableTruth(current);
        const verified =
          isReleaseReadinessBrief(result) &&
          canonicalCapabilityJson(stableResult) ===
            canonicalCapabilityJson(stableCurrent) &&
          releaseReadinessFreshnessDidNotRegress(result, current) &&
          input.requiredPostconditions.every((postcondition) =>
            RELEASE_READINESS_POSTCONDITIONS.some(
              (supported) => supported === postcondition,
            ),
          );
        return {
          verified,
          evidenceRefs: verified ? current.evidenceRefs : [],
          verifiedPostconditions: verified
            ? [...input.requiredPostconditions]
            : [],
          postconditionFingerprint: verified
            ? sha256(canonicalCapabilityJson(stableCurrent))
            : undefined,
          reason: verified
            ? 'Brief agrees with a causally later read of authoritative status surfaces.'
            : 'Brief differs from current authoritative release-readiness truth.',
        };
      },
      async recover(input) {
        const current = buildReleaseReadinessBrief();
        const stableCurrent = releaseReadinessStableTruth(current);
        const verified = input.requiredPostconditions.every((postcondition) =>
          RELEASE_READINESS_POSTCONDITIONS.some(
            (supported) => supported === postcondition,
          ),
        );
        return {
          verified,
          result: current,
          evidenceRefs: verified ? current.evidenceRefs : [],
          verifiedPostconditions: verified
            ? [...input.requiredPostconditions]
            : [],
          postconditionFingerprint: verified
            ? sha256(canonicalCapabilityJson(stableCurrent))
            : undefined,
          reason: verified
            ? 'Current authoritative state independently proves the read-only postcondition without replay.'
            : 'The recovery evaluator cannot prove the required postcondition.',
        };
      },
    },
  ];

export interface CapabilityProductionExecutionResult {
  status: 'verified' | 'failed' | 'indeterminate';
  runId: string;
  acquisitionId: string;
  results: unknown[];
  receiptIds: string[];
  evidenceRefs: string[];
  postconditionFingerprint?: string;
  providerCalls: number;
  costUsd: number;
  latencyMs: number;
  reason: string;
}

function assertExecutionBinding(
  run: CapabilityProductionRunRecord,
  binding: DurableWorkBindingInput,
): void {
  if (
    durableScopeHash('owner', binding.ownerId) !== run.ownerScopeHash ||
    durableScopeHash('chat', binding.chatId) !== run.chatScopeHash ||
    durableScopeHash('group', binding.groupId) !== run.groupScopeHash ||
    durableScopeHash('target', binding.targetScopeKey) !==
      run.targetScopeHash ||
    binding.channel !== run.channel
  ) {
    throw new Error(
      'Production execution binding changed from the canonical run.',
    );
  }
}

function ensureCapabilityProductionExecutionLease(params: {
  run: CapabilityProductionRunRecord;
  acquisition: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
  binding: DurableWorkBindingInput;
  workerId: string;
  now: string;
}): CapabilityProductionRunRecord {
  assertExecutionBinding(params.run, params.binding);
  assertFreshBoundProductionHealth({
    run: params.run,
    contract: params.contract,
    now: params.now,
  });

  const processGeneration = durableProcessGeneration();
  reconcileDurableWorkOnStartup({
    processGeneration,
    now: params.now,
  });
  let run = getCapabilityProductionRun(params.run.runId);
  if (!run)
    throw new Error('Production run disappeared during lease reconciliation.');
  let work = getDurableWorkUnit(run.workId);
  if (!work || !work.checkpointHeadId) {
    throw new Error('Production work disappeared during lease reconciliation.');
  }
  if (
    run.workVersion !== work.version ||
    run.planVersion !== work.planVersion ||
    run.checkpointId !== work.checkpointHeadId
  ) {
    run = refreshCapabilityProductionRunWorkHead({
      runId: run.runId,
      expectedRevision: run.revision,
      now: params.now,
    });
    work = getDurableWorkUnit(run.workId);
    if (!work || !work.checkpointHeadId) {
      throw new Error('Production work head disappeared after refresh.');
    }
  }
  const existingLeaseId =
    run.runKind === 'canary'
      ? run.executionLeaseId || run.canaryLeaseId
      : run.executionLeaseId;
  const existingLease = existingLeaseId
    ? getDurableWorkLease(existingLeaseId)
    : undefined;
  if (
    existingLease?.status === 'active' &&
    existingLease.processGeneration === processGeneration &&
    existingLease.expiresAt > params.now &&
    work.leaseId === existingLease.leaseId &&
    work.leaseExpiresAt &&
    work.leaseExpiresAt > params.now
  ) {
    return run;
  }
  if (params.contract.steps.some((step) => step.approvalRequired)) {
    throw new ProductionCapabilityQuarantineError(
      'Protected production steps require their normal fresh action approval.',
    );
  }
  const actionClass = params.contract.steps[0]?.actionClass || 'local_lookup';
  const issued = issueDurableResumeGrant({
    workId: run.workId,
    binding: params.binding,
    actionClass,
    now: params.now,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: params.binding,
    actionClass,
    workerId: params.workerId,
    processGeneration,
    now: params.now,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error(
      `Production execution lease acquisition failed: ${consumed.status}.`,
    );
  }
  work = getDurableWorkUnit(run.workId);
  if (!work || !work.checkpointHeadId) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration,
      now: params.now,
    });
    throw new Error('Production work disappeared after lease acquisition.');
  }
  const next: CapabilityProductionRunRecord = {
    ...run,
    updatedAt: params.now,
    revision: run.revision + 1,
    workVersion: work.version,
    planVersion: work.planVersion,
    checkpointId: work.checkpointHeadId,
    executionGrantId: issued.grant.grantId,
    executionLeaseId: consumed.lease.leaseId,
    nextSafeAction:
      'Execute the exact registered contract under the fresh lease.',
  };
  if (
    updateCapabilityProductionRunCAS({
      expectedRevision: run.revision,
      next,
    }) !== 'applied'
  ) {
    releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration,
      now: params.now,
    });
    throw new Error(
      'Production execution lease binding lost its revision race.',
    );
  }
  return getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
}

export async function runCapabilityProductionExecution(params: {
  runId: string;
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  binding: DurableWorkBindingInput;
  workerId: string;
  values: Record<string, unknown>;
  registry?: ProductionCapabilityBindingRegistry;
  now?: Date | string;
}): Promise<CapabilityProductionExecutionResult> {
  const startedAt = Date.now();
  const now = iso(params.now);
  const executionTime = () => (params.now ? now : iso());
  let run = getCapabilityProductionRun(params.runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (
    !run ||
    !acquisition ||
    run.revision !== params.expectedRunRevision ||
    acquisition.recordVersion !== params.expectedAcquisitionVersion ||
    typeof params.values.targetScopeKey !== 'string' ||
    durableScopeHash('target', params.values.targetScopeKey) !==
      run.targetScopeHash ||
    sha256(canonicalCapabilityJson(params.values)) !== run.inputDigest
  ) {
    throw new Error(
      'Production execution input does not match the approved digest.',
    );
  }
  const contract = parseCapabilityJson<CapabilityCandidateContract>(
    acquisition.candidateContractJson,
    'candidateContractJson',
  );
  assertCapabilityCandidateContract(contract);
  run = ensureCapabilityProductionExecutionLease({
    run,
    acquisition,
    contract,
    binding: params.binding,
    workerId: params.workerId,
    now,
  });
  let preflight = assertCapabilityProductionExecutionPreflight({
    runId: run.runId,
    expectedRunRevision: run.revision,
    now,
  });
  const registry =
    params.registry || ProductionCapabilityBindingRegistry.createBundled();
  const running: CapabilityProductionRunRecord = {
    ...run,
    updatedAt: now,
    revision: run.revision + 1,
    status: 'running',
    nextSafeAction: 'Revalidate before each registered contract step.',
  };
  if (
    updateCapabilityProductionRunCAS({
      expectedRevision: run.revision,
      next: running,
    }) !== 'applied'
  ) {
    throw new Error('Production execution lost its start revision race.');
  }
  run = getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
  const results: unknown[] = [];
  const receiptIds: string[] = [];
  const evidenceRefs: string[] = [];
  const verifiedPostconditions = new Set<string>();
  let providerCalls = 0;
  let costUsd = 0;
  let lastPostStateFingerprint: string | undefined;
  const leaseId =
    run.runKind === 'canary'
      ? run.executionLeaseId || run.canaryLeaseId
      : run.executionLeaseId;
  if (!leaseId) throw new Error('Production execution has no bound lease.');
  const processGeneration = durableProcessGeneration();
  try {
    for (const step of preflight.contract.steps) {
      preflight = assertCapabilityProductionExecutionPreflight({
        runId: run.runId,
        expectedRunRevision: run.revision,
        now: executionTime(),
      });
      if (step.approvalRequired) {
        throw new ProductionCapabilityQuarantineError(
          `Protected step ${step.stepId} requires its normal fresh action approval; activation does not supply it.`,
        );
      }
      const binding = registry.resolveExecutor(step);
      const evaluator = registry.resolveEvaluator(step);
      if (
        costUsd + binding.maximumCostUsd > MAX_LIVE_COST_USD ||
        (binding.networkAccess === 'external' &&
          preflight.acquisition.dataEgressClass !== 'approved_content')
      ) {
        throw new ProductionCapabilityQuarantineError(
          'Production binding exceeds its approved cost or egress boundary.',
        );
      }
      const idempotencyKey = sha256(
        `${run.runId}|${step.stepId}|${run.invocationId}|${run.inputDigest}`,
      );
      const started = recordDurableEffect({
        workId: run.workId,
        checkpointId: run.checkpointId,
        planVersion: run.planVersion,
        nodeId: step.stepId,
        invocationId: run.invocationId,
        actionClass: step.actionClass,
        leaseId,
        processGeneration,
        effectClass: binding.effectClass,
        status: 'started',
        claimExecution: true,
        targetScopeKey: params.values.targetScopeKey as string,
        metadata: {
          receiptClass: 'capability_production',
          verificationClass: step.evaluatorId,
          resultCode: run.candidateFingerprint,
          idempotencyKeyHash: run.inputDigest,
          source: 'verified_capability_apprenticeship',
        },
        now,
      });
      const stepStartedAt = Date.now();
      const result = await binding.execute({
        values: params.values,
        idempotencyKey,
      });
      await emitProductionCapabilityBoundary({
        boundary: 'after_effect_before_outcome',
        runId: run.runId,
        stepId: step.stepId,
      });
      providerCalls += result.providerCalls || 0;
      costUsd += result.costUsd || 0;
      if (costUsd > MAX_LIVE_COST_USD || result.effectStatus === 'unknown') {
        recordDurableEffect({
          workId: run.workId,
          checkpointId: run.checkpointId,
          planVersion: run.planVersion,
          nodeId: step.stepId,
          invocationId: run.invocationId,
          actionClass: step.actionClass,
          leaseId,
          processGeneration,
          effectClass: binding.effectClass,
          status: 'unknown',
          targetScopeKey: params.values.targetScopeKey as string,
          preStateFingerprint: result.preStateFingerprint,
          postStateFingerprint: result.postStateFingerprint,
          metadata: {
            receiptClass: 'capability_production',
            verificationClass: step.evaluatorId,
            resultCode: run.candidateFingerprint,
            idempotencyKeyHash: run.inputDigest,
            source: 'verified_capability_apprenticeship',
          },
          now: executionTime(),
        });
        throw new ProductionCapabilityIndeterminateError(
          'Production execution effect is indeterminate or over budget.',
        );
      }
      const verification = await evaluator.verify({
        values: params.values,
        result,
        requiredPostconditions: preflight.contract.successPostconditions,
      });
      if (
        !verification.verified ||
        !verification.postconditionFingerprint ||
        !result.postStateFingerprint
      ) {
        recordDurableEffect({
          workId: run.workId,
          checkpointId: run.checkpointId,
          planVersion: run.planVersion,
          nodeId: step.stepId,
          invocationId: run.invocationId,
          actionClass: step.actionClass,
          leaseId,
          processGeneration,
          effectClass: binding.effectClass,
          status: 'failed',
          targetScopeKey: params.values.targetScopeKey as string,
          preStateFingerprint: result.preStateFingerprint,
          postStateFingerprint: result.postStateFingerprint,
          metadata: {
            receiptClass: 'capability_production',
            verificationClass: step.evaluatorId,
            resultCode: run.candidateFingerprint,
            idempotencyKeyHash: run.inputDigest,
            source: 'verified_capability_apprenticeship',
          },
          now: executionTime(),
        });
        throw new ProductionCapabilityQuarantineError(
          `Independent evaluator rejected ${step.stepId}.`,
        );
      }
      const exactRun = run;
      if (!exactRun) {
        throw new Error('Production run disappeared before step persistence.');
      }
      const succeeded = runCapabilityProductionVerifiedStepAtomic(() => {
        const receipt = recordDurableEffect({
          workId: exactRun.workId,
          checkpointId: exactRun.checkpointId,
          planVersion: exactRun.planVersion,
          nodeId: step.stepId,
          invocationId: exactRun.invocationId,
          actionClass: step.actionClass,
          leaseId,
          processGeneration,
          effectClass: binding.effectClass,
          status: 'succeeded',
          targetScopeKey: params.values.targetScopeKey as string,
          preStateFingerprint: result.preStateFingerprint,
          postStateFingerprint: result.postStateFingerprint,
          verificationFingerprint: verification.postconditionFingerprint,
          metadata: {
            receiptClass: 'capability_production',
            verificationClass: step.evaluatorId,
            resultCode: exactRun.candidateFingerprint,
            idempotencyKeyHash: exactRun.inputDigest,
            source: 'verified_capability_apprenticeship',
            verifiedPostconditionHashesJson: JSON.stringify(
              [
                ...new Set(
                  verification.verifiedPostconditions.map(
                    productionPostconditionHash,
                  ),
                ),
              ].sort(),
            ),
            providerCalls: String(result.providerCalls || 0),
            costUsd: String(result.costUsd || 0),
            latencyMs: String(Math.max(0, Date.now() - stepStartedAt)),
          },
          now: executionTime(),
        });
        insertCapabilityProductionStep({
          runId: exactRun.runId,
          stepId: step.stepId,
          createdAt: receipt.createdAt,
          receiptId: receipt.receiptId,
          nodeId: receipt.nodeId,
          invocationId: receipt.invocationId,
          bindingId: step.bindingId,
          operationId: step.operationId,
          evaluatorId: step.evaluatorId,
          resourceId: step.resourceId,
          resourceVersion: step.version,
          executorImplementationDigest: step.executorImplementationDigest,
          evaluatorImplementationDigest: step.evaluatorImplementationDigest,
          actionClass: step.actionClass,
          inputDigest: exactRun.inputDigest,
          independentVerification: true,
          privacyJson: PRODUCTION_PRIVACY,
        });
        return receipt;
      });
      for (const item of verification.verifiedPostconditions) {
        verifiedPostconditions.add(item);
      }
      results.push(result.result);
      receiptIds.push(succeeded.receiptId);
      evidenceRefs.push(...result.evidenceRefs, ...verification.evidenceRefs);
      lastPostStateFingerprint = result.postStateFingerprint;
      void started;
    }
    const missing = preflight.contract.successPostconditions.filter(
      (postcondition) => !verifiedPostconditions.has(postcondition),
    );
    if (missing.length > 0 || !lastPostStateFingerprint) {
      throw new ProductionCapabilityQuarantineError(
        'Production evaluators did not cover every postcondition.',
      );
    }
    let work = getDurableWorkUnit(run.workId);
    if (!work) throw new Error('Production durable work disappeared.');
    releaseDurableLease({ leaseId, processGeneration, now: executionTime() });
    work = getDurableWorkUnit(run.workId);
    if (!work)
      throw new Error(
        'Production durable work disappeared after lease release.',
      );
    if (work.status !== 'verifying') {
      work = transitionDurableWork({
        workId: work.workId,
        expectedVersion: work.version,
        toStatus: 'verifying',
        nextAction: 'Persist the verified receipts into a terminal checkpoint.',
        now: executionTime(),
      });
    }
    await emitProductionCapabilityBoundary({
      boundary: 'after_receipts_before_checkpoint',
      runId: run.runId,
    });
    const completed = commitDurableCheckpointCAS({
      workId: work.workId,
      expectedWorkVersion: work.version,
      completedNodeIds: preflight.contract.steps.map((step) => step.stepId),
      pendingNodeIds: [],
      uncertainNodeIds: [],
      dependencyIds: preflight.contract.resourceBindings.map(
        (resource) =>
          `capability-resource:${sha256(resource.resourceId).slice(0, 32)}`,
      ),
      worldSignals: {
        fresh: preflight.contract.resourceBindings.map(
          (resource) =>
            `resource-health:${sha256(resource.resourceId).slice(0, 32)}`,
        ),
      },
      executorScopeKey: run.candidateFingerprint,
      targetScopeKey: params.values.targetScopeKey as string,
      verifiedPostStateFingerprint: lastPostStateFingerprint,
      receiptIds,
      verificationRequirementIds: preflight.contract.verifierBindingIds.map(
        (id) => `capability-verifier:${sha256(id).slice(0, 32)}`,
      ),
      retryBudget: 1,
      attemptsUsed: 1,
      stopConditionIds: [
        'scope_mismatch',
        'health_stale',
        'postcondition_failure',
      ],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Join terminal execution to the canonical live outcome.',
      status: 'completed',
      now: executionTime(),
    });
    let terminalWork = completed.work;
    if (terminalWork.status !== 'verifying') {
      terminalWork = transitionDurableWork({
        workId: terminalWork.workId,
        expectedVersion: terminalWork.version,
        toStatus: 'verifying',
        nextAction: 'Verify the completed production checkpoint.',
        now: executionTime(),
      });
    }
    terminalWork = transitionDurableWork({
      workId: terminalWork.workId,
      expectedVersion: terminalWork.version,
      toStatus: 'completed',
      nextAction: 'Production postcondition is durably verified.',
      now: executionTime(),
    });
    releaseDurableLease({ leaseId, processGeneration, now: executionTime() });
    await emitProductionCapabilityBoundary({
      boundary: 'after_checkpoint_before_outcome',
      runId: run.runId,
    });
    const outcomeId = `outcome:capability:${sha256(`${run.runId}|${run.inputDigest}`).slice(0, 40)}`;
    upsertOutcome({
      outcomeId,
      groupFolder: run.groupFolder,
      sourceType: 'capability_acquisition',
      sourceKey: run.runId,
      linkedRefsJson: JSON.stringify({
        capabilityAcquisitionId: run.acquisitionId,
        capabilityCandidateFingerprint: run.candidateFingerprint,
        capabilityEvidenceOrigin: 'live',
        verificationReceiptIds: receiptIds,
      }),
      status: 'completed',
      completionSummary:
        'The registered capability reached its independently verified postcondition.',
      nextFollowupText: 'Request an exact owner verdict on this outcome.',
      blockerText: null,
      dueAt: null,
      reviewHorizon: 'today',
      lastCheckedAt: executionTime(),
      userConfirmed: false,
      showInDailyReview: false,
      showInWeeklyReview: false,
      reviewSuppressedUntil: null,
      createdAt: executionTime(),
      updatedAt: executionTime(),
    });
    await emitProductionCapabilityBoundary({
      boundary: 'after_outcome_before_reconcile',
      runId: run.runId,
    });
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    const finished: CapabilityProductionRunRecord = {
      ...run,
      updatedAt: executionTime(),
      revision: run.revision + 1,
      workVersion: terminalWork.version,
      checkpointId: completed.checkpoint.durableCheckpointId,
      outcomeId,
      postconditionFingerprint: lastPostStateFingerprint,
      executionCalls: run.executionCalls + preflight.contract.steps.length,
      evaluatorCalls: run.evaluatorCalls + preflight.contract.steps.length,
      latencyMs: Date.now() - startedAt,
      providerCalls: run.providerCalls + providerCalls,
      costUsd: run.costUsd + costUsd,
      nextSafeAction:
        'Atomically join the verified outcome, then ask the owner.',
    };
    if (
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next: finished,
      }) !== 'applied'
    ) {
      throw new Error('Production execution lost its terminal revision race.');
    }
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    const acquisition = getCapabilityAcquisition(run.acquisitionId);
    if (!acquisition) throw new Error('Capability acquisition disappeared.');
    reconcileCapabilityProductionEvidenceAtomic({
      runId: run.runId,
      operation:
        run.runKind === 'canary' ? 'complete_canary' : 'complete_reuse',
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: run.revision,
      now: executionTime(),
    });
    return {
      status: 'verified',
      runId: run.runId,
      acquisitionId: run.acquisitionId,
      results,
      receiptIds,
      evidenceRefs: [...new Set(evidenceRefs)],
      postconditionFingerprint: lastPostStateFingerprint,
      providerCalls,
      costUsd,
      latencyMs: Date.now() - startedAt,
      reason:
        'Every contract step and the final postcondition were independently verified.',
    };
  } catch (error) {
    if (error instanceof ProductionCapabilitySimulatedCrashError) {
      throw error;
    }
    releaseDurableLease({ leaseId, processGeneration, now: executionTime() });
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    if (run && run.status === 'running') {
      const quarantine = error instanceof ProductionCapabilityQuarantineError;
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next: {
          ...run,
          updatedAt: executionTime(),
          revision: run.revision + 1,
          status: quarantine ? 'failed' : 'indeterminate',
          latencyMs: Date.now() - startedAt,
          providerCalls: run.providerCalls + providerCalls,
          costUsd: run.costUsd + costUsd,
          nextSafeAction: quarantine
            ? 'Quarantine this exact contract and require a new reviewed version.'
            : 'Inspect canonical receipts; never replay an unknown effect blindly.',
        },
      });
    }
    const failedRun = getCapabilityProductionRun(params.runId);
    const failedAcquisition = failedRun
      ? getCapabilityAcquisition(failedRun.acquisitionId)
      : undefined;
    if (
      failedRun &&
      failedAcquisition &&
      ['indeterminate', 'failed'].includes(failedRun.status) &&
      ['canary_ready', 'active', 'monitoring'].includes(failedAcquisition.state)
    ) {
      try {
        reconcileCapabilityProductionFailureAtomic({
          runId: failedRun.runId,
          expectedAcquisitionVersion: failedAcquisition.recordVersion,
          expectedRunRevision: failedRun.revision,
          now: executionTime(),
        });
      } catch (reconciliationError) {
        throw new AggregateError(
          [error, reconciliationError],
          'Production execution failed and canonical failure reconciliation also failed.',
          { cause: reconciliationError },
        );
      }
    }
    throw error;
  }
}

async function finishRecoveredProductionRun(params: {
  runId: string;
  results: unknown[];
  evidenceRefs: string[];
  providerCalls: number;
  costUsd: number;
  latencyMs: number;
  now: string;
}): Promise<CapabilityProductionExecutionResult> {
  let run = getCapabilityProductionRun(params.runId);
  if (!run) throw new Error('Recovered production run disappeared.');
  const completedTransition = listCapabilityProductionTransitionReceipts({
    runId: run.runId,
    limit: 100,
  }).find((receipt) =>
    run?.runKind === 'canary'
      ? receipt.transitionKind === 'canary_completed'
      : receipt.transitionKind === 'reuse_completed',
  );
  if (
    completedTransition &&
    run.outcomeId &&
    run.postconditionFingerprint &&
    run.status === 'awaiting_owner_review'
  ) {
    const receiptIds = listCapabilityProductionSteps(run.runId).map(
      (step) => step.receiptId,
    );
    return {
      status: 'verified',
      runId: run.runId,
      acquisitionId: run.acquisitionId,
      results: params.results,
      receiptIds,
      evidenceRefs: [...new Set(params.evidenceRefs)],
      postconditionFingerprint: run.postconditionFingerprint,
      providerCalls: run.providerCalls,
      costUsd: run.costUsd,
      latencyMs: run.latencyMs,
      reason:
        'Canonical recovery was already reconciled; no effect or outcome was replayed.',
    };
  }
  const work = getDurableWorkUnit(run.workId);
  const checkpoint = work?.checkpointHeadId
    ? getDurableWorkCheckpoint(work.checkpointHeadId)
    : null;
  if (
    !work ||
    !checkpoint ||
    work.status !== 'completed' ||
    checkpoint.status !== 'completed' ||
    !checkpoint.verifiedPostStateFingerprint
  ) {
    throw new Error('Recovered production work is not terminal and verified.');
  }
  const steps = listCapabilityProductionSteps(run.runId);
  const receiptIds = steps.map((step) => step.receiptId);
  if (receiptIds.length === 0) {
    throw new Error(
      'Recovered production work has no canonical step receipts.',
    );
  }
  const outcomeId = `outcome:capability:${sha256(`${run.runId}|${run.inputDigest}`).slice(0, 40)}`;
  const existingOutcome = getOutcomeBySource(
    run.groupFolder,
    'capability_acquisition',
    run.runId,
  );
  if (existingOutcome && existingOutcome.outcomeId !== outcomeId) {
    throw new Error('Recovered canonical outcome identity changed.');
  }
  upsertOutcome({
    outcomeId,
    groupFolder: run.groupFolder,
    sourceType: 'capability_acquisition',
    sourceKey: run.runId,
    linkedRefsJson: JSON.stringify({
      capabilityAcquisitionId: run.acquisitionId,
      capabilityCandidateFingerprint: run.candidateFingerprint,
      capabilityEvidenceOrigin: 'live',
      verificationReceiptIds: receiptIds,
    }),
    status: 'completed',
    completionSummary:
      'The registered capability reached its independently verified postcondition.',
    nextFollowupText: 'Request an exact owner verdict on this outcome.',
    blockerText: null,
    dueAt: null,
    reviewHorizon: 'today',
    lastCheckedAt: params.now,
    userConfirmed: false,
    showInDailyReview: false,
    showInWeeklyReview: false,
    reviewSuppressedUntil: null,
    createdAt: existingOutcome?.createdAt || params.now,
    updatedAt: params.now,
  });
  run = getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
  const alreadyLinked = run.outcomeId === outcomeId;
  const next: CapabilityProductionRunRecord = {
    ...run,
    updatedAt: params.now,
    revision: run.revision + 1,
    workVersion: work.version,
    planVersion: work.planVersion,
    checkpointId: checkpoint.durableCheckpointId,
    outcomeId,
    postconditionFingerprint: checkpoint.verifiedPostStateFingerprint,
    executionCalls: alreadyLinked
      ? run.executionCalls
      : Math.max(run.executionCalls, steps.length),
    evaluatorCalls: alreadyLinked
      ? run.evaluatorCalls
      : Math.max(run.evaluatorCalls, steps.length),
    latencyMs: Math.max(run.latencyMs, params.latencyMs),
    providerCalls:
      run.providerCalls + (alreadyLinked ? 0 : params.providerCalls),
    costUsd: run.costUsd + (alreadyLinked ? 0 : params.costUsd),
    nextSafeAction:
      'Atomically join recovered terminal truth; never replay the effect.',
  };
  if (
    updateCapabilityProductionRunCAS({
      expectedRevision: run.revision,
      next,
    }) !== 'applied'
  ) {
    throw new Error(
      'Recovered production run lost its terminal revision race.',
    );
  }
  run = getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
  const acquisition = getCapabilityAcquisition(run.acquisitionId);
  if (!acquisition)
    throw new Error('Recovered capability acquisition disappeared.');
  reconcileCapabilityProductionEvidenceAtomic({
    runId: run.runId,
    operation: run.runKind === 'canary' ? 'complete_canary' : 'complete_reuse',
    expectedAcquisitionVersion: acquisition.recordVersion,
    expectedRunRevision: run.revision,
    now: params.now,
  });
  const finalRun = getCapabilityProductionRun(
    run.runId,
  ) as CapabilityProductionRunRecord;
  return {
    status: 'verified',
    runId: finalRun.runId,
    acquisitionId: finalRun.acquisitionId,
    results: params.results,
    receiptIds,
    evidenceRefs: [...new Set(params.evidenceRefs)],
    postconditionFingerprint: finalRun.postconditionFingerprint || undefined,
    providerCalls: finalRun.providerCalls,
    costUsd: finalRun.costUsd,
    latencyMs: finalRun.latencyMs,
    reason:
      'Existing effect truth was independently verified and canonically reconciled without replay.',
  };
}

/**
 * Restart recovery for a production run. This path can verify an existing
 * uncertain effect or finish a persisted outcome join, but it has no executor
 * callback and therefore cannot replay the original operation.
 */
export async function recoverCapabilityProductionRun(params: {
  runId: string;
  values: Record<string, unknown>;
  binding: DurableWorkBindingInput;
  workerId: string;
  registry?: ProductionCapabilityBindingRegistry;
  now?: Date | string;
  clock?: () => Date | string;
}): Promise<CapabilityProductionExecutionResult> {
  const startedAt = Date.now();
  const now = iso(params.now);
  if (params.now && !params.clock) {
    throw new Error(
      'Production recovery with an injected initial time requires an explicit clock.',
    );
  }
  let latestRecoveryTime = now;
  const readFreshRecoveryTime = (): string => {
    const observedAt = iso(params.clock ? params.clock() : new Date());
    if (observedAt < latestRecoveryTime) {
      throw new Error('Production recovery clock moved backwards.');
    }
    latestRecoveryTime = observedAt;
    return observedAt;
  };
  let run = getCapabilityProductionRun(params.runId);
  if (
    !run ||
    typeof params.values.targetScopeKey !== 'string' ||
    durableScopeHash('target', params.values.targetScopeKey) !==
      run.targetScopeHash ||
    sha256(canonicalCapabilityJson(params.values)) !== run.inputDigest
  ) {
    throw new Error(
      'Production recovery input does not match the canonical run.',
    );
  }

  const existingTransition = listCapabilityProductionTransitionReceipts({
    runId: run.runId,
    limit: 100,
  }).find((receipt) =>
    run?.runKind === 'canary'
      ? receipt.transitionKind === 'canary_completed'
      : receipt.transitionKind === 'reuse_completed',
  );
  if (existingTransition) {
    return finishRecoveredProductionRun({
      runId: run.runId,
      results: [],
      evidenceRefs: [existingTransition.receiptId],
      providerCalls: 0,
      costUsd: 0,
      latencyMs: 0,
      now,
    });
  }

  reconcileDurableWorkOnStartup({ now });
  run = getCapabilityProductionRun(run.runId) as CapabilityProductionRunRecord;
  run = refreshCapabilityProductionRunWorkHead({
    runId: run.runId,
    expectedRevision: run.revision,
    now,
  });
  const workAfterStartup = getDurableWorkUnit(run.workId);
  const existingOutcome = getOutcomeBySource(
    run.groupFolder,
    'capability_acquisition',
    run.runId,
  );
  const recoveryPlanVersion = run.planVersion;
  const hasUnresolvedReceipt = listDurableEffectReceipts({
    workId: run.workId,
    limit: 1_000,
  }).some(
    (receipt) =>
      receipt.planVersion === recoveryPlanVersion &&
      ['started', 'partial', 'unknown'].includes(receipt.status),
  );
  if (workAfterStartup?.status === 'completed') {
    return finishRecoveredProductionRun({
      runId: run.runId,
      results: [],
      evidenceRefs: existingOutcome
        ? [existingOutcome.outcomeId]
        : [
            workAfterStartup.workId,
            workAfterStartup.checkpointHeadId || run.checkpointId,
          ],
      providerCalls: 0,
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      now,
    });
  }
  if (
    workAfterStartup &&
    ['interrupted', 'verifying'].includes(workAfterStartup.status) &&
    !existingOutcome &&
    !hasUnresolvedReceipt
  ) {
    const ready = assertCapabilityProductionReceiptsReadyForCheckpoint({
      runId: run.runId,
      expectedRunRevision: run.revision,
      now,
    });
    const committed = commitDurableCheckpointCAS({
      workId: workAfterStartup.workId,
      expectedWorkVersion: workAfterStartup.version,
      completedNodeIds: ready.contract.steps.map((step) => step.stepId),
      pendingNodeIds: [],
      uncertainNodeIds: [],
      dependencyIds: ready.contract.resourceBindings.map(
        (resource) =>
          `capability-resource:${sha256(resource.resourceId).slice(0, 32)}`,
      ),
      worldSignals: {
        fresh: ready.contract.resourceBindings.map(
          (resource) =>
            `resource-health:${sha256(resource.resourceId).slice(0, 32)}`,
        ),
      },
      executorScopeKey: run.candidateFingerprint,
      targetScopeKey: params.values.targetScopeKey,
      verifiedPostStateFingerprint: ready.postStateFingerprint,
      receiptIds: ready.receiptIds,
      verificationRequirementIds: ready.contract.verifierBindingIds.map(
        (id) => `capability-verifier:${sha256(id).slice(0, 32)}`,
      ),
      retryBudget: 1,
      attemptsUsed: 1,
      stopConditionIds: [
        'scope_mismatch',
        'health_stale',
        'postcondition_failure',
      ],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: 'Join receipt-verified terminal truth without replay.',
      status: 'completed',
      now,
    });
    let terminalWork = committed.work;
    if (terminalWork.status !== 'completed') {
      terminalWork = transitionDurableWork({
        workId: terminalWork.workId,
        expectedVersion: terminalWork.version,
        toStatus: 'completed',
        nextAction: 'Receipt-only recovery reached durable terminal truth.',
        now,
      });
    }
    run = refreshCapabilityProductionRunWorkHead({
      runId: run.runId,
      expectedRevision: run.revision,
      now,
    });
    return finishRecoveredProductionRun({
      runId: run.runId,
      results: [],
      evidenceRefs: ready.receiptIds,
      providerCalls: ready.providerCalls,
      costUsd: ready.costUsd,
      latencyMs: Math.max(ready.latencyMs, Date.now() - startedAt),
      now,
    });
  }

  const preflight = assertCapabilityProductionRecoveryPreflight({
    runId: run.runId,
    expectedRunRevision: run.revision,
    now,
  });
  if (preflight.unresolvedReceipts.length !== 1) {
    throw new Error(
      'Production recovery requires one exact unresolved effect at a time.',
    );
  }
  const unresolved = preflight.unresolvedReceipts[0];
  const recoveryStep = preflight.contract.steps.find(
    (candidate) => candidate.stepId === unresolved.nodeId,
  );
  if (!recoveryStep)
    throw new Error('Production recovery step left the exact contract.');
  const registry =
    params.registry || ProductionCapabilityBindingRegistry.createBundled();
  if (!registry.resolveEvaluator(recoveryStep).recover) {
    throw new Error(
      'Production evaluator has no verification-only recovery binding.',
    );
  }
  const issued = issueDurableResumeGrant({
    workId: run.workId,
    binding: params.binding,
    actionClass: 'local_lookup',
    now,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: params.binding,
    actionClass: 'local_lookup',
    workerId: params.workerId,
    now,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error(
      `Production recovery lease acquisition failed: ${consumed.status}.`,
    );
  }
  const processGeneration = consumed.lease.processGeneration;
  let postEvaluatorNow: string | null = null;
  try {
    const leasedWork = getDurableWorkUnit(run.workId);
    if (!leasedWork || !leasedWork.checkpointHeadId) {
      throw new Error('Production recovery durable work disappeared.');
    }
    const leasedRun: CapabilityProductionRunRecord = {
      ...run,
      updatedAt: now,
      revision: run.revision + 1,
      workVersion: leasedWork.version,
      planVersion: leasedWork.planVersion,
      checkpointId: leasedWork.checkpointHeadId,
      executionGrantId: issued.grant.grantId,
      executionLeaseId: consumed.lease.leaseId,
      status: 'running',
      nextSafeAction: 'Verify the existing effect without invoking it again.',
    };
    if (
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next: leasedRun,
      }) !== 'applied'
    ) {
      throw new Error('Production recovery lost its lease-binding race.');
    }
    run = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    const leasedPreflight = assertCapabilityProductionRecoveryLeasePreflight({
      runId: run.runId,
      expectedRunRevision: run.revision,
      unresolvedReceiptId: unresolved.receiptId,
      evaluatorId: recoveryStep.evaluatorId,
      recoveryGrantId: issued.grant.grantId,
      recoveryLeaseId: consumed.lease.leaseId,
      processGeneration,
      now,
    });
    const leasedUnresolved = leasedPreflight.unresolvedReceipts[0];
    const leasedStep = leasedPreflight.contract.steps.find(
      (candidate) => candidate.stepId === leasedUnresolved?.nodeId,
    );
    if (
      !leasedUnresolved ||
      leasedUnresolved.receiptId !== unresolved.receiptId ||
      !leasedStep
    ) {
      throw new Error('Production recovery evaluator binding changed.');
    }
    if (leasedStep.evaluatorId !== recoveryStep.evaluatorId) {
      throw new Error('Production recovery evaluator binding changed.');
    }
    const step = leasedStep;
    const evaluator = registry.resolveEvaluator(step);
    const recover = evaluator.recover;
    if (!recover) {
      throw new Error(
        'Production evaluator has no verification-only recovery binding.',
      );
    }
    const verification = await recover({
      values: params.values,
      existingReceipt: {
        receiptId: unresolved.receiptId,
        nodeId: unresolved.nodeId,
        status: unresolved.status as 'started' | 'partial' | 'unknown',
        preStateFingerprint: unresolved.preStateFingerprint,
        postStateFingerprint: unresolved.postStateFingerprint,
      },
      requiredPostconditions: preflight.contract.successPostconditions,
    });
    postEvaluatorNow = readFreshRecoveryTime();
    if (
      !verification.verified ||
      !verification.postconditionFingerprint ||
      verification.verifiedPostconditions.length !==
        preflight.contract.successPostconditions.length ||
      preflight.contract.successPostconditions.some(
        (postcondition) =>
          !verification.verifiedPostconditions.includes(postcondition),
      )
    ) {
      return {
        status: 'indeterminate',
        runId: run.runId,
        acquisitionId: run.acquisitionId,
        results: verification.result === undefined ? [] : [verification.result],
        receiptIds: [unresolved.receiptId],
        evidenceRefs: verification.evidenceRefs,
        postconditionFingerprint: verification.postconditionFingerprint,
        providerCalls: 0,
        costUsd: 0,
        latencyMs: Date.now() - startedAt,
        reason:
          'Recovery evaluator could not prove the existing effect; no executor was replayed.',
      };
    }
    const invocationId = `${run.invocationId}:recovery:${sha256(unresolved.receiptId).slice(0, 16)}`;
    const recoveryReceipt = recordDurableEffect({
      workId: run.workId,
      checkpointId: run.checkpointId,
      planVersion: run.planVersion,
      nodeId: step.stepId,
      invocationId,
      actionClass: 'local_lookup',
      leaseId: consumed.lease.leaseId,
      processGeneration,
      effectClass: 'read_only',
      status: 'succeeded',
      targetScopeKey: params.binding.targetScopeKey,
      preStateFingerprint: unresolved.preStateFingerprint,
      postStateFingerprint: verification.postconditionFingerprint,
      verificationFingerprint: verification.postconditionFingerprint,
      metadata: {
        receiptClass: 'capability_production_recovery',
        verificationClass: step.evaluatorId,
        resultCode: run.candidateFingerprint,
        idempotencyKeyHash: run.inputDigest,
        source: 'verified_capability_apprenticeship',
        recoveryOfReceiptId: unresolved.receiptId,
      },
      leaseAssertionNow: postEvaluatorNow,
      now: postEvaluatorNow,
    });
    insertCapabilityProductionStep({
      runId: run.runId,
      stepId: step.stepId,
      createdAt: recoveryReceipt.createdAt,
      receiptId: recoveryReceipt.receiptId,
      nodeId: recoveryReceipt.nodeId,
      invocationId,
      bindingId: step.bindingId,
      operationId: step.operationId,
      evaluatorId: step.evaluatorId,
      resourceId: step.resourceId,
      resourceVersion: step.version,
      executorImplementationDigest: step.executorImplementationDigest,
      evaluatorImplementationDigest: step.evaluatorImplementationDigest,
      actionClass: step.actionClass,
      inputDigest: run.inputDigest,
      independentVerification: true,
      privacyJson: PRODUCTION_PRIVACY,
    });
    const head = getDurableWorkCheckpoint(run.checkpointId);
    const currentWork = getDurableWorkUnit(run.workId);
    if (!head || !currentWork) {
      throw new Error('Production recovery checkpoint disappeared.');
    }
    const completedNodeIds = JSON.parse(head.completedNodeIdsJson) as string[];
    const pendingNodeIds = (
      JSON.parse(head.pendingNodeIdsJson) as string[]
    ).filter((nodeId) => nodeId !== step.stepId);
    const uncertainNodeIds = (
      JSON.parse(head.uncertainNodeIdsJson) as string[]
    ).filter((nodeId) => nodeId !== step.stepId);
    const terminal =
      pendingNodeIds.length === 0 && uncertainNodeIds.length === 0;
    const committed = commitDurableCheckpointCAS({
      workId: currentWork.workId,
      expectedWorkVersion: currentWork.version,
      completedNodeIds: [...new Set([...completedNodeIds, step.stepId])],
      pendingNodeIds,
      uncertainNodeIds,
      dependencyIds: preflight.contract.resourceBindings.map(
        (resource) =>
          `capability-resource:${sha256(resource.resourceId).slice(0, 32)}`,
      ),
      worldSignals: {
        fresh: preflight.contract.resourceBindings.map(
          (resource) =>
            `resource-health:${sha256(resource.resourceId).slice(0, 32)}`,
        ),
      },
      executorScopeKey: run.candidateFingerprint,
      targetScopeKey: params.binding.targetScopeKey,
      verifiedPostStateFingerprint: verification.postconditionFingerprint,
      receiptIds: [
        ...(JSON.parse(head.receiptIdsJson) as string[]),
        recoveryReceipt.receiptId,
      ],
      verificationRequirementIds: preflight.contract.verifierBindingIds.map(
        (id) => `capability-verifier:${sha256(id).slice(0, 32)}`,
      ),
      retryBudget: head.retryBudget,
      attemptsUsed: head.attemptsUsed,
      stopConditionIds: JSON.parse(head.stopConditionsJson) as string[],
      recoveryPolicy: 'inspect_then_resume',
      nextSafeAction: terminal
        ? 'Join the independently recovered terminal truth.'
        : 'Resume only the next untouched contract step under a fresh lease.',
      status: terminal ? 'completed' : 'open',
      now: postEvaluatorNow,
    });
    let finalWork = committed.work;
    finalWork = transitionDurableWork({
      workId: finalWork.workId,
      expectedVersion: finalWork.version,
      toStatus: terminal ? 'completed' : 'ready',
      nextAction: terminal
        ? 'Recovered postcondition is durably verified.'
        : 'Continue only the remaining untouched contract steps.',
      now: postEvaluatorNow,
    });
    const refreshed = getCapabilityProductionRun(
      run.runId,
    ) as CapabilityProductionRunRecord;
    const refreshedRun: CapabilityProductionRunRecord = {
      ...refreshed,
      updatedAt: postEvaluatorNow,
      revision: refreshed.revision + 1,
      workVersion: finalWork.version,
      planVersion: finalWork.planVersion,
      checkpointId: committed.checkpoint.durableCheckpointId,
      status: terminal
        ? 'running'
        : refreshed.runKind === 'canary'
          ? 'canary_ready'
          : 'monitoring',
      evaluatorCalls: refreshed.evaluatorCalls + 1,
      latencyMs: Math.max(refreshed.latencyMs, Date.now() - startedAt),
      nextSafeAction: terminal
        ? 'Record and join the recovered canonical outcome.'
        : 'Acquire a fresh lease before any untouched step executes.',
    };
    if (
      updateCapabilityProductionRunCAS({
        expectedRevision: refreshed.revision,
        next: refreshedRun,
      }) !== 'applied'
    ) {
      throw new Error('Production recovery lost its checkpoint revision race.');
    }
    if (!terminal) {
      return {
        status: 'indeterminate',
        runId: run.runId,
        acquisitionId: run.acquisitionId,
        results: verification.result === undefined ? [] : [verification.result],
        receiptIds: [recoveryReceipt.receiptId],
        evidenceRefs: verification.evidenceRefs,
        postconditionFingerprint: verification.postconditionFingerprint,
        providerCalls: 0,
        costUsd: 0,
        latencyMs: Date.now() - startedAt,
        reason:
          'One existing effect was verified without replay; untouched steps remain pending.',
      };
    }
  } finally {
    const leaseFinalizationNow = postEvaluatorNow || readFreshRecoveryTime();
    const released = releaseDurableLease({
      leaseId: consumed.lease.leaseId,
      processGeneration,
      now: leaseFinalizationNow,
    });
    if (!released) {
      reconcileExpiredDurableLease({
        leaseId: consumed.lease.leaseId,
        processGeneration,
        now: leaseFinalizationNow,
      });
    }
  }
  if (!postEvaluatorNow) {
    throw new Error(
      'Production recovery completed without a fresh clock read.',
    );
  }
  return finishRecoveredProductionRun({
    runId: run.runId,
    results: [],
    evidenceRefs: [unresolved.receiptId],
    providerCalls: 0,
    costUsd: 0,
    latencyMs: Date.now() - startedAt,
    now: postEvaluatorNow,
  });
}

export interface ActiveCapabilityMatch {
  status: 'matched' | 'none' | 'ambiguous';
  acquisition?: CapabilityAcquisitionRecord;
  contract?: CapabilityCandidateContract;
  confidence: number;
  candidateIds: string[];
  resourceVersionDigest?: string;
  clarification?: string;
  reason: string;
}

export function matchActiveCapability(params: {
  groupFolder: string;
  taskFamily: string;
  inputs: Record<string, unknown>;
  intendedPostconditions: string[];
  binding: DurableWorkBindingInput;
  currentResourceVersions: Record<string, string>;
}): ActiveCapabilityMatch {
  const resourceVersionDigest = sha256(
    canonicalCapabilityJson(params.currentResourceVersions),
  );
  const candidates = listCapabilityAcquisitions({
    groupFolder: params.groupFolder,
    states: ['active', 'monitoring'],
    taskFamily: params.taskFamily,
    limit: 100,
  }).flatMap((acquisition) => {
    const contract = parseCapabilityJson<CapabilityCandidateContract>(
      acquisition.candidateContractJson,
      'candidateContractJson',
    );
    assertCapabilityCandidateContract(contract);
    const activeCanary = listCapabilityProductionRuns({
      acquisitionId: acquisition.acquisitionId,
      statuses: ['active', 'monitoring'],
      limit: 20,
    }).find((run) => run.runKind === 'canary');
    const requiredPresent = contract.requiredInputs.every(
      (name) =>
        Object.hasOwn(params.inputs, name) && params.inputs[name] !== undefined,
    );
    const targetMatches =
      activeCanary?.targetScopeHash ===
      durableScopeHash('target', params.binding.targetScopeKey);
    const channelMatches = activeCanary?.channel === params.binding.channel;
    const ownerMatches =
      activeCanary?.ownerScopeHash ===
      durableScopeHash('owner', params.binding.ownerId);
    const chatMatches =
      activeCanary?.chatScopeHash ===
      durableScopeHash('chat', params.binding.chatId);
    const groupMatches =
      params.binding.groupId === params.groupFolder &&
      activeCanary?.groupScopeHash ===
        durableScopeHash('group', params.binding.groupId);
    const intendedPostconditions = new Set(
      params.intendedPostconditions
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
    const contractPostconditions = new Set(
      contract.successPostconditions.map((item) => item.trim().toLowerCase()),
    );
    const postconditionsCovered =
      intendedPostconditions.size > 0 &&
      [...intendedPostconditions].every((item) =>
        contractPostconditions.has(item),
      );
    const postconditionCoverage = postconditionsCovered
      ? intendedPostconditions.size
      : 0;
    const resourceVersionsCurrent = contract.resourceBindings.every(
      (resource) => {
        const current = params.currentResourceVersions[resource.resourceId];
        return Boolean(
          current &&
          (current === resource.version ||
            (
              contract.compatibleResourceVersions[resource.resourceId] || []
            ).includes(current)),
        );
      },
    );
    if (
      !activeCanary ||
      !requiredPresent ||
      !targetMatches ||
      !channelMatches ||
      !ownerMatches ||
      !chatMatches ||
      !groupMatches ||
      !resourceVersionsCurrent ||
      !postconditionsCovered
    ) {
      return [];
    }
    return [
      {
        acquisition,
        contract,
        confidence: Math.min(
          1,
          0.65 +
            0.2 * (postconditionCoverage / intendedPostconditions.size) +
            0.15 * (requiredPresent ? 1 : 0),
        ),
      },
    ];
  });
  candidates.sort(
    (left, right) =>
      right.confidence - left.confidence ||
      left.acquisition.acquisitionId.localeCompare(
        right.acquisition.acquisitionId,
      ),
  );
  if (candidates.length === 0) {
    return {
      status: 'none',
      confidence: 0,
      candidateIds: [],
      resourceVersionDigest,
      reason:
        'No active contract matches task family, inputs, postcondition, target, channel, and current resource versions.',
    };
  }
  if (
    candidates.length > 1 &&
    Math.abs(candidates[0].confidence - candidates[1].confidence) < 0.1
  ) {
    return {
      status: 'ambiguous',
      confidence: candidates[0].confidence,
      candidateIds: candidates.map((item) => item.acquisition.acquisitionId),
      resourceVersionDigest,
      clarification:
        'Which expected postcondition or target should distinguish these active capabilities?',
      reason:
        'Two active contracts remain materially plausible; protected operations were not combined.',
    };
  }
  return {
    status: 'matched',
    acquisition: candidates[0].acquisition,
    contract: candidates[0].contract,
    confidence: candidates[0].confidence,
    candidateIds: [candidates[0].acquisition.acquisitionId],
    resourceVersionDigest,
    reason:
      'Exact active contract matched by task family, inputs, postcondition, target, and channel.',
  };
}

export function stageActiveCapabilityReuse(params: {
  match: ActiveCapabilityMatch;
  taskFamily: string;
  intendedPostconditions: string[];
  binding: DurableWorkBindingInput;
  normalizedInputs: Record<string, unknown>;
  health: CapabilityCanaryHealthBinding[];
  currentResourceVersions: Record<string, string>;
  workerId: string;
  now?: Date | string;
}): CapabilityProductionRunRecord {
  return runCapabilityProductionStagingAtomic(() =>
    stageActiveCapabilityReuseWithinTransaction(params),
  );
}

function stageActiveCapabilityReuseWithinTransaction(params: {
  match: ActiveCapabilityMatch;
  taskFamily: string;
  intendedPostconditions: string[];
  binding: DurableWorkBindingInput;
  normalizedInputs: Record<string, unknown>;
  health: CapabilityCanaryHealthBinding[];
  currentResourceVersions: Record<string, string>;
  workerId: string;
  now?: Date | string;
}): CapabilityProductionRunRecord {
  const now = iso(params.now);
  if (
    params.match.status !== 'matched' ||
    !params.match.acquisition ||
    !params.match.contract
  ) {
    throw new Error('Active capability reuse requires one unambiguous match.');
  }
  const acquisition = getCapabilityAcquisition(
    params.match.acquisition.acquisitionId,
  );
  const contract = params.match.contract;
  const recomputed = matchActiveCapability({
    groupFolder: params.binding.groupId,
    taskFamily: params.taskFamily,
    inputs: params.normalizedInputs,
    intendedPostconditions: params.intendedPostconditions,
    binding: params.binding,
    currentResourceVersions: params.currentResourceVersions,
  });
  if (
    !acquisition ||
    !['active', 'monitoring'].includes(acquisition.state) ||
    acquisition.recordVersion !== params.match.acquisition.recordVersion ||
    recomputed.status !== 'matched' ||
    recomputed.acquisition?.acquisitionId !== acquisition.acquisitionId ||
    recomputed.contract?.candidateFingerprint !== contract.candidateFingerprint
  ) {
    throw new Error('Active capability changed before reuse staging.');
  }
  const currentVersionDigest = sha256(
    canonicalCapabilityJson(params.currentResourceVersions),
  );
  if (
    !params.match.resourceVersionDigest ||
    params.match.resourceVersionDigest !== currentVersionDigest ||
    contract.resourceBindings.some((resource) => {
      const current = params.currentResourceVersions[resource.resourceId];
      return (
        !current ||
        (current !== resource.version &&
          !(
            contract.compatibleResourceVersions[resource.resourceId] || []
          ).includes(current))
      );
    })
  ) {
    throw new Error(
      'Active capability resource versions changed after matching.',
    );
  }
  if (contract.steps.some((step) => step.approvalRequired)) {
    throw new Error(
      'This active contract contains protected effects; stage their normal fresh action approval before execution.',
    );
  }
  const activeCanary = listCapabilityProductionRuns({
    acquisitionId: acquisition.acquisitionId,
    statuses: ['active', 'monitoring'],
    limit: 20,
  }).find((run) => run.runKind === 'canary');
  if (!activeCanary)
    throw new Error('Active capability lacks activation evidence.');
  const runId = `capability-run:${randomUUID()}`;
  const inputDigest = sha256(canonicalCapabilityJson(params.normalizedInputs));
  const health = resolveHealthEvidence({
    runId,
    contract,
    bindings: params.health,
    currentResourceVersions: params.currentResourceVersions,
    now,
  });
  let work = createOrLoadDurableWork({
    originTurnId: runId,
    authorizedSurface: activeCanary.authorizedSurface,
    binding: params.binding,
    goalSummary: `Reuse verified capability ${contract.title}.`,
    status: 'ready',
    nextAction: 'Execute only the active contract with fresh health.',
    now,
  }).work;
  linkDurableWorkProjection(
    work.workId,
    'capability_production_run',
    runId,
    now,
  );
  linkDurableWorkProjection(
    work.workId,
    'capability_acquisition',
    acquisition.acquisitionId,
    now,
  );
  const checkpoint = commitDurableCheckpointCAS({
    workId: work.workId,
    expectedWorkVersion: work.version,
    pendingNodeIds: contract.steps.map((step) => step.stepId),
    dependencyIds: contract.resourceBindings.map(
      (resource) =>
        `capability-resource:${sha256(resource.resourceId).slice(0, 32)}`,
    ),
    worldSignals: {
      fresh: contract.resourceBindings.map(
        (resource) =>
          `resource-health:${sha256(resource.resourceId).slice(0, 32)}`,
      ),
    },
    executorScopeKey: contract.candidateFingerprint,
    targetScopeKey: params.binding.targetScopeKey,
    verificationRequirementIds: contract.verifierBindingIds.map(
      (id) => `capability-verifier:${sha256(id).slice(0, 32)}`,
    ),
    retryBudget: 1,
    attemptsUsed: 0,
    stopConditionIds: [
      'match_confidence_changed',
      'health_stale',
      'version_drift',
      'scope_mismatch',
    ],
    recoveryPolicy: 'inspect_then_resume',
    nextSafeAction: 'Acquire one execution lease for this reuse only.',
    now,
  });
  work = checkpoint.work;
  const actionClass = contract.steps[0]?.actionClass || 'local_lookup';
  const issued = issueDurableResumeGrant({
    workId: work.workId,
    binding: params.binding,
    actionClass,
    now,
  });
  const consumed = consumeResumeGrantAndAcquireLease({
    token: issued.token,
    binding: params.binding,
    actionClass,
    workerId: params.workerId,
    now,
  });
  if (consumed.status !== 'consumed' || !consumed.lease) {
    throw new Error(
      `Active reuse lease acquisition failed: ${consumed.status}.`,
    );
  }
  emitProductionCapabilityBoundarySync({
    boundary: 'after_active_reuse_lease_before_run',
    runId,
  });
  work = getDurableWorkUnit(work.workId) as NonNullable<
    ReturnType<typeof getDurableWorkUnit>
  >;
  const run: CapabilityProductionRunRecord = {
    ...activeCanary,
    runId,
    createdAt: now,
    updatedAt: now,
    runKind: 'active_reuse',
    status: 'monitoring',
    revision: 1,
    ownerScopeHash: work.ownerScopeHash,
    chatScopeHash: work.chatScopeHash,
    groupScopeHash: work.groupScopeHash,
    channel: work.channel,
    targetScopeHash: work.targetScopeHash,
    inputDigest,
    actionClass,
    workId: work.workId,
    workVersion: work.version,
    planVersion: work.planVersion,
    checkpointId: work.checkpointHeadId as string,
    invocationId: `capability-invocation:${randomUUID()}`,
    canaryApprovalPacketId: null,
    canaryApprovalVersion: null,
    canaryApprovalScopeDigest: null,
    canaryGrantId: null,
    canaryLeaseId: null,
    executionGrantId: issued.grant.grantId,
    executionLeaseId: consumed.lease.leaseId,
    activationApprovalPacketId: null,
    activationApprovalVersion: null,
    activationApprovalScopeDigest: null,
    activationGrantId: null,
    activationLeaseId: null,
    activationWorkId: null,
    activationWorkVersion: null,
    activationPlanVersion: null,
    activationCheckpointId: null,
    activationInvocationId: null,
    outcomeId: null,
    ownerReviewId: null,
    healthEvidenceSetDigest: capabilityHealthEvidenceSetDigest(health),
    postconditionFingerprint: null,
    resourceDiscoveryCalls: 0,
    candidateDesignCalls: 0,
    toolSelectionCalls: 0,
    executionCalls: 0,
    evaluatorCalls: 0,
    latencyMs: 0,
    providerCalls: 0,
    costUsd: 0,
    matchConfidence: params.match.confidence,
    expiresAt: plusMs(now, DEFAULT_RUN_TTL_MS),
    completedAt: null,
    nextSafeAction:
      'Execute the exact active contract and monitor its outcome.',
    privacyJson: PRODUCTION_PRIVACY,
  };
  insertCapabilityProductionRunWithHealthAtomic({ run, health });
  return getCapabilityProductionRun(runId) as CapabilityProductionRunRecord;
}

function latestControllableRun(
  acquisitionId: string,
): CapabilityProductionRunRecord {
  const run = listCapabilityProductionRuns({
    acquisitionId,
    limit: 100,
  })[0];
  if (!run) throw new Error('Capability has no production run to control.');
  return run;
}

export function issueCapabilityControlTokenForTrustedChat(params: {
  acquisitionId: string;
  actionKind: 'pause' | 'revoke' | 'retire' | 'show_evidence';
  channelName: string;
  chatJid: string;
  group: RegisteredGroup;
  messageId?: string | null;
  now?: Date | string;
}): string {
  if (!isTrustedOwnerReviewSurface(params)) {
    throw new Error(
      'Capability control requires a trusted private owner surface.',
    );
  }
  const now = iso(params.now);
  const acquisition = getCapabilityAcquisition(params.acquisitionId);
  const run = acquisition
    ? latestControllableRun(acquisition.acquisitionId)
    : undefined;
  if (
    !acquisition ||
    !run ||
    acquisition.groupFolder !== params.group.folder ||
    run.channel !== params.channelName ||
    run.authorizedSurface !== params.channelName ||
    run.ownerScopeHash !== durableScopeHash('owner', 'owner') ||
    run.groupScopeHash !== durableScopeHash('group', params.group.folder) ||
    durableScopeHash('chat', params.chatJid) !== run.chatScopeHash
  ) {
    throw new Error(
      'Capability control surface does not match canonical scope.',
    );
  }
  const token = ownerActionTokenRecord({
    run,
    acquisition,
    actionKind: params.actionKind,
    now,
    messageId: params.messageId,
  });
  insertCapabilityOwnerActionToken(token.record);
  return token.token;
}

/** Owner-cockpit callers must invoke this only after session and CSRF checks. */
export function issueCapabilityControlTokenForAuthenticatedCockpit(params: {
  acquisitionId: string;
  actionKind: 'pause' | 'revoke' | 'retire' | 'show_evidence';
  now?: Date | string;
}): string {
  const now = iso(params.now);
  const acquisition = getCapabilityAcquisition(params.acquisitionId);
  const run = acquisition
    ? latestControllableRun(acquisition.acquisitionId)
    : undefined;
  if (!acquisition || !run || run.authorizedSurface !== 'owner_cockpit') {
    throw new Error('Capability is not bound to this owner-cockpit surface.');
  }
  const token = ownerActionTokenRecord({
    run,
    acquisition,
    actionKind: params.actionKind,
    now,
  });
  insertCapabilityOwnerActionToken(token.record);
  return token.token;
}

export function applyCapabilityOwnerControl(params: {
  token: string;
  now?: Date | string;
}): ReturnType<typeof applyCapabilityOwnerControlWithToken> {
  return applyCapabilityOwnerControlWithToken({
    tokenHash: sha256(params.token),
    now: iso(params.now),
  });
}

export interface CapabilityApprenticeshipStatus {
  acquisition: CapabilityAcquisitionRecord;
  runs: CapabilityProductionRunRecord[];
  pendingAction:
    | 'canary_approval'
    | 'canary_execution'
    | 'owner_review'
    | 'activation_approval'
    | 'monitoring'
    | 'none';
  stateLabel: string;
  ownerControlSummary: string;
}

export function getCapabilityApprenticeshipStatus(
  acquisitionId: string,
): CapabilityApprenticeshipStatus {
  const acquisition = getCapabilityAcquisition(acquisitionId);
  if (!acquisition) throw new Error('Capability acquisition was not found.');
  const runs = listCapabilityProductionRuns({ acquisitionId, limit: 100 });
  const latest = runs[0];
  const pendingAction =
    latest?.status === 'awaiting_canary_approval'
      ? 'canary_approval'
      : latest?.status === 'canary_ready'
        ? 'canary_execution'
        : latest?.status === 'awaiting_owner_review'
          ? 'owner_review'
          : latest?.status === 'awaiting_activation_approval'
            ? 'activation_approval'
            : ['active', 'monitoring'].includes(acquisition.state)
              ? 'monitoring'
              : 'none';
  return {
    acquisition,
    runs,
    pendingAction,
    stateLabel: acquisition.state,
    ownerControlSummary:
      'Canary approval, outcome review, and activation are separate. Pause, revoke, retire, and show evidence remain owner-controlled.',
  };
}

export const RELEASE_READINESS_POSTCONDITIONS = [
  'brief reports repository and serving provenance truth',
  'brief reports runtime, bridge, integration, proof, and disk truth',
  'brief identifies exact blockers and next actions without stale proof claims',
] as const;

export interface ReleaseReadinessBrief {
  generatedAt: string;
  repository: {
    branch: string;
    headSha: string;
    dirtyPathCount: number | null;
    upstreamBehind: number | null;
    upstreamAhead: number | null;
    upstreamState: 'aligned' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    upstreamEvidence: 'cached_local_tracking_ref' | 'unavailable';
  };
  serving: {
    appBearingSha: string | null;
    servingSha: string;
    buildSha: string | null;
    buildProvenance: string;
    artifactVerified: boolean | null;
    servingMatchesHead: boolean;
  };
  runtime: {
    andreaPhase: string;
    andreaPid: number | null;
    readyPid: number | null;
    openClawGateway: string;
    openClawReachable: boolean | null;
    bridgeState: string;
    bridgeTools: string;
    directSendExposed: boolean;
  };
  integrations: Array<{
    id: string;
    state: string;
    proofState: string;
    lastHealthyAt: string | null;
    nextAction: string;
  }>;
  integrationSummary: {
    healthy: number;
    total: number;
    actionNeeded: number;
    needsProof: number;
  };
  disk: {
    state: string;
    availableBytes: number | null;
    availablePercent: number | null;
    summary: string;
  };
  blockers: string[];
  nextActions: string[];
  evidenceRefs: string[];
  truthFingerprint: string;
  formattedBrief: string;
}

function localUpstreamDivergence(projectRoot: string): {
  behind: number | null;
  ahead: number | null;
  state: ReleaseReadinessBrief['repository']['upstreamState'];
  evidence: ReleaseReadinessBrief['repository']['upstreamEvidence'];
} {
  try {
    const raw = execFileSync(
      'git',
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const [aheadRaw, behindRaw] = raw.split(/\s+/);
    const ahead = Number(aheadRaw);
    const behind = Number(behindRaw);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
      throw new Error('Malformed divergence result.');
    }
    return {
      ahead,
      behind,
      state:
        ahead > 0 && behind > 0
          ? 'diverged'
          : ahead > 0
            ? 'ahead'
            : behind > 0
              ? 'behind'
              : 'aligned',
      evidence: 'cached_local_tracking_ref',
    };
  } catch {
    return {
      ahead: null,
      behind: null,
      state: 'unknown',
      evidence: 'unavailable',
    };
  }
}

function releaseReadinessStableTruth(brief: ReleaseReadinessBrief) {
  return {
    repository: brief.repository,
    serving: brief.serving,
    runtime: brief.runtime,
    // Healthy probes may refresh their timestamp on every read. Compare that
    // timestamp monotonically below rather than making adjacent identical
    // probes disagree on their millisecond value.
    integrations: brief.integrations.map((integration) => ({
      id: integration.id,
      state: integration.state,
      proofState: integration.proofState,
      nextAction: integration.nextAction,
    })),
    integrationSummary: brief.integrationSummary,
    disk: {
      state: brief.disk.state,
    },
    blockers: brief.blockers,
    nextActions: brief.nextActions,
  };
}

function releaseReadinessFreshnessDidNotRegress(
  result: ReleaseReadinessBrief,
  current: ReleaseReadinessBrief,
): boolean {
  if (result.integrations.length !== current.integrations.length) return false;
  const currentById = new Map(
    current.integrations.map((integration) => [integration.id, integration]),
  );
  return result.integrations.every((integration) => {
    const later = currentById.get(integration.id);
    if (!later) return false;
    if (!integration.lastHealthyAt) return true;
    return Boolean(
      later.lastHealthyAt && later.lastHealthyAt >= integration.lastHealthyAt,
    );
  });
}

function isReleaseReadinessBrief(
  value: unknown,
): value is ReleaseReadinessBrief {
  const brief = value as Partial<ReleaseReadinessBrief> | null;
  return Boolean(
    brief &&
    brief.repository?.headSha &&
    ['cached_local_tracking_ref', 'unavailable'].includes(
      brief.repository.upstreamEvidence || '',
    ) &&
    brief.serving?.servingSha &&
    Array.isArray(brief.integrations) &&
    Array.isArray(brief.blockers) &&
    Array.isArray(brief.nextActions) &&
    /^[a-f0-9]{64}$/.test(brief.truthFingerprint || '') &&
    brief.formattedBrief,
  );
}

export function buildReleaseReadinessBrief(): ReleaseReadinessBrief {
  const generatedAt = new Date().toISOString();
  const snapshot = readHostControlSnapshot();
  const commit = buildRuntimeCommitTruth({
    runtimeAuditState: snapshot.runtimeAuditState,
  });
  const divergence = localUpstreamDivergence(commit.workspaceRepoRoot);
  const openClaw = getOpenClawStatusSummary();
  const bridge = getOpenClawAndreaBridgeStatusSummary();
  const doctor = buildIntegrationDoctorReport({
    now: new Date(generatedAt),
    projectRoot: commit.workspaceRepoRoot,
  });
  const disk = probeHostDiskHealth({
    targetPath: commit.workspaceRepoRoot,
    now: new Date(generatedAt),
  });
  const integrations = doctor.statuses
    .map((item) => ({
      id: item.integrationId,
      state: item.state,
      proofState: item.proofState,
      lastHealthyAt: item.lastHealthyAt,
      nextAction: item.nextAction,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const blockers = [
    ...(divergence.state === 'behind' || divergence.state === 'diverged'
      ? [`repository_${divergence.state}`]
      : []),
    ...(commit.workspaceGitDirtyPathCount ? ['repository_worktree_dirty'] : []),
    ...(!commit.servingCommitMatchesWorkspaceHead
      ? ['serving_sha_or_provenance_not_aligned']
      : []),
    ...(snapshot.hostState?.phase !== 'running_ready'
      ? [`andrea_${snapshot.hostState?.phase || 'status_missing'}`]
      : []),
    ...(openClaw.gatewayState !== 'live'
      ? [`openclaw_${openClaw.gatewayState}`]
      : []),
    ...(!bridge.requiredToolsAvailable || bridge.directSendExposed
      ? ['openclaw_bridge_policy_or_tools_unhealthy']
      : []),
    ...integrations
      .filter((item) =>
        [
          'needs_auth',
          'externally_blocked',
          'manual_action_required',
          'repo_fix_available',
        ].includes(item.state),
      )
      .map((item) => `integration_${item.id}_${item.state}`),
    ...(['critical', 'warning', 'unknown'].includes(disk.state)
      ? [`disk_${disk.state}`]
      : []),
  ];
  const nextActions = [
    ...(divergence.state === 'behind' || divergence.state === 'diverged'
      ? [
          'Review remote ancestry before release; do not integrate automatically.',
        ]
      : []),
    ...(!commit.servingCommitMatchesWorkspaceHead
      ? [
          'Rebuild and restart from the intended exact commit, then verify provenance.',
        ]
      : []),
    ...doctor.statuses
      .filter((item) => item.state !== 'healthy' && item.nextAction)
      .map((item) => `${item.label}: ${item.nextAction}`),
    ...(disk.state !== 'healthy' && disk.nextAction ? [disk.nextAction] : []),
  ];
  const base = {
    generatedAt,
    repository: {
      branch: commit.workspaceGitBranch,
      headSha: commit.workspaceGitCommit,
      dirtyPathCount: commit.workspaceGitDirtyPathCount,
      upstreamBehind: divergence.behind,
      upstreamAhead: divergence.ahead,
      upstreamState: divergence.state,
      upstreamEvidence: divergence.evidence,
    },
    serving: {
      appBearingSha: commit.activeBuildGitCommit,
      servingSha: commit.activeGitCommit,
      buildSha: commit.activeBuildGitCommit,
      buildProvenance: commit.activeBuildProvenanceState,
      artifactVerified: commit.activeBuildArtifactVerified,
      servingMatchesHead: commit.servingCommitMatchesWorkspaceHead,
    },
    runtime: {
      andreaPhase: snapshot.hostState?.phase || 'missing',
      andreaPid: snapshot.hostState?.pid || null,
      readyPid: snapshot.readyState?.pid || null,
      openClawGateway: openClaw.gatewayState,
      openClawReachable: openClaw.gatewayReachable,
      bridgeState: bridge.state,
      bridgeTools: `${bridge.mcpToolCount}/${bridge.requiredToolCount}`,
      directSendExposed: bridge.directSendExposed,
    },
    integrations,
    integrationSummary: {
      healthy: doctor.summary.healthy,
      total: doctor.summary.total,
      actionNeeded: doctor.summary.actionNeeded,
      needsProof: doctor.summary.needsProof,
    },
    disk: {
      state: disk.state,
      availableBytes: disk.availableBytes,
      availablePercent: disk.availablePercent,
      summary: disk.summary,
    },
    blockers: [...new Set(blockers)].sort(),
    nextActions: [...new Set(nextActions)],
    evidenceRefs: [
      `workspace-head:${commit.workspaceGitCommit}`,
      `upstream-evidence:${divergence.evidence}`,
      `serving-head:${commit.activeGitCommit}`,
      `build-provenance:${commit.activeBuildProvenanceState}`,
      `openclaw:${openClaw.gatewayState}`,
      `bridge:${bridge.state}:${bridge.mcpToolCount}/${bridge.requiredToolCount}`,
      `integration-doctor:${doctor.generatedAt}`,
      `disk:${disk.checkedAt}:${disk.state}`,
    ],
  };
  const truthFingerprint = sha256(
    canonicalCapabilityJson(
      releaseReadinessStableTruth({
        ...base,
        truthFingerprint: '0'.repeat(64),
        formattedBrief: '',
      }),
    ),
  );
  const formattedBrief = [
    'Andrea release-readiness brief',
    `Repository: ${base.repository.branch} ${base.repository.headSha.slice(0, 12)}, ${base.repository.dirtyPathCount ?? 'unknown'} dirty path(s), cached local tracking ref ${base.repository.upstreamState} (not a remote fetch).`,
    `Serving: ${base.serving.servingSha.slice(0, 12)}, provenance ${base.serving.buildProvenance}, aligned=${base.serving.servingMatchesHead ? 'yes' : 'no'}.`,
    `Runtime: Andrea ${base.runtime.andreaPhase}; OpenClaw ${base.runtime.openClawGateway}; bridge ${base.runtime.bridgeState} (${base.runtime.bridgeTools} tools).`,
    `Integrations: ${base.integrationSummary.healthy}/${base.integrationSummary.total} healthy; ${base.integrationSummary.actionNeeded} action-needed; ${base.integrationSummary.needsProof} proof-needed.`,
    `Disk: ${base.disk.state}; ${base.disk.summary}.`,
    `Blockers: ${base.blockers.length ? base.blockers.join(', ') : 'none detected by current status surfaces'}.`,
    ...(base.nextActions.length
      ? ['Next:', ...base.nextActions.slice(0, 8).map((item) => `- ${item}`)]
      : ['Next: no repository-controlled blocker detected.']),
  ].join('\n');
  return { ...base, truthFingerprint, formattedBrief };
}

export function releaseReadinessCapabilityResource(): CapabilityResourceDescriptor {
  return {
    resourceId: RELEASE_READINESS_RESOURCE_ID,
    kind: 'assistant_capability',
    displayName: 'Andrea canonical release-readiness truth',
    taskFamilies: ['release_readiness'],
    capabilityIds: ['release_readiness_brief'],
    supportedPostconditions: [...RELEASE_READINESS_POSTCONDITIONS],
    requiredInputs: ['targetScopeKey'],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 0.99,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'none',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'interactive',
    version: RELEASE_READINESS_VERSION,
    sourceRefs: [
      'host-control',
      'integration-doctor',
      'openclaw-status',
      'host-disk-health',
    ],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId: RELEASE_READINESS_BINDING_ID,
        operationId: RELEASE_READINESS_OPERATION_ID,
        evaluatorId: RELEASE_READINESS_EVALUATOR_ID,
        executorImplementationDigest: RELEASE_READINESS_EXECUTOR_DIGEST,
        evaluatorImplementationDigest: RELEASE_READINESS_EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        version: RELEASE_READINESS_VERSION,
        readOnly: true,
      },
    ],
  };
}

export function buildReleaseReadinessCandidateContract(): CapabilityCandidateContract {
  const resource = releaseReadinessCapabilityResource();
  const draft: CapabilityCandidateContract = {
    contractVersion: 1,
    candidateFingerprint: '0'.repeat(64),
    capabilityId: 'release-readiness-brief',
    skillId: 'release-readiness-brief',
    title: 'Andrea Release-Readiness Brief',
    taskFamily: 'release_readiness',
    triggerSemantics: [
      'is Andrea ready to release',
      'what blocks a safe demo',
      'give me a current release-readiness brief',
    ],
    implementationKind: 'capability_composition',
    requiredInputs: ['targetScopeKey'],
    optionalInputs: ['focus'],
    inputSchemaJson: JSON.stringify({
      type: 'object',
      additionalProperties: false,
      properties: {
        targetScopeKey: { type: 'string' },
        focus: { type: 'string' },
      },
      required: ['targetScopeKey'],
    }),
    outputSchemaJson: JSON.stringify({
      type: 'object',
      additionalProperties: true,
      required: ['truthFingerprint', 'formattedBrief', 'evidenceRefs'],
    }),
    preconditions: [
      'canonical local status surfaces are readable',
      'required dependency health evidence is fresh',
      'repository target scope matches the activated contract',
    ],
    resourceBindings: [
      {
        resourceId: resource.resourceId,
        bindingKind: 'assistant_capability',
        version: resource.version,
        required: true,
      },
    ],
    steps: [
      {
        stepId: 'release-readiness-brief',
        title: 'Compile current canonical release-readiness truth',
        resourceId: resource.resourceId,
        bindingId: RELEASE_READINESS_BINDING_ID,
        operationId: RELEASE_READINESS_OPERATION_ID,
        evaluatorId: RELEASE_READINESS_EVALUATOR_ID,
        version: resource.version,
        executorImplementationDigest: RELEASE_READINESS_EXECUTOR_DIGEST,
        evaluatorImplementationDigest: RELEASE_READINESS_EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        readOnly: true,
        approvalRequired: false,
        idempotencyKeyRequired: true,
        expectedEvidence: [...RELEASE_READINESS_POSTCONDITIONS],
      },
    ],
    fallbackPaths: [
      'Stop and identify the unavailable canonical status surface.',
    ],
    allowedActions: ['local_lookup'],
    prohibitedActions: [
      'repository_write',
      'commit',
      'push',
      'deploy',
      'send',
      'calendar_write',
      'delete',
    ],
    approvalRequirements: [],
    credentialRequirements: [],
    dataEgressClass: 'none',
    expectedOutput:
      'One concise current release-readiness brief with evidence and exact blockers.',
    successPostconditions: [...RELEASE_READINESS_POSTCONDITIONS],
    verificationProcedure: [
      `Run registered evaluator ${RELEASE_READINESS_EVALUATOR_ID} against a causally later truth read.`,
    ],
    verifierBindingIds: [RELEASE_READINESS_EVALUATOR_ID],
    failureClassifications: [
      'status_surface_unavailable',
      'stale_proof',
      'provenance_mismatch',
      'verification_failed',
    ],
    rollbackProcedure: [
      'No rollback is needed because the operation is read-only.',
    ],
    rollbackBindingIds: [],
    deterministicScenarioIds: ['release-readiness-fixture-v1'],
    heldOutScenarioIds: ['release-readiness-heldout-demo-blocker-v1'],
    compatibleResourceVersions: {
      [resource.resourceId]: [resource.version],
    },
    revalidationRequirements: [
      'binding and evaluator digests match',
      'health evidence is fresh',
      'serving and repository truth are reread',
    ],
    provenanceRefs: resource.sourceRefs,
  };
  const contract = {
    ...draft,
    candidateFingerprint: capabilityCandidateFingerprint(draft),
  };
  assertCapabilityCandidateContract(contract);
  return contract;
}
