/* eslint-disable no-catch-all/no-catch-all -- The isolated crash worker converts fixture I/O and teardown failures into bounded evidence codes. */
import fs from 'node:fs';

import {
  _closeDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  getCapabilityAcquisition,
  getCapabilityProductionRun,
  getDurableWorkCheckpoint,
  getDurableWorkUnit,
  getOutcomeBySource,
  isDatabaseInitialized,
  listCapabilityProductionRuns,
  listCapabilityProductionSteps,
  listCapabilityProductionTransitionReceipts,
  listCognitiveApprovalPackets,
  listCognitiveRuns,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  listDurableWorkCheckpoints,
  listDurableWorkLinks,
  listDurableWorkUnits,
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from '../../src/db.js';
import { capabilityBindingImplementationDigest } from '../../src/capability-execution-guard.js';
import {
  compileCapabilityCandidate,
  createHermeticCertificationBindingRegistry,
  observeCapabilityGap,
  prepareCapabilityExecutionScope,
  prepareCapabilitySandbox,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
} from '../../src/verified-capability-acquisition.js';
import {
  _setProductionCapabilityApprenticeshipTestHook,
  authorizeApprovedCapabilityActivation,
  authorizeApprovedCapabilityCanary,
  createIsolatedProductionCapabilityRegistryForTest,
  issueCapabilityReviewTokenForAuthenticatedCockpit,
  matchActiveCapability,
  recordCapabilityOwnerVerdict,
  recoverCapabilityProductionRun,
  runCapabilityProductionExecution,
  stageActiveCapabilityReuse,
  stageCapabilityActivation,
  stageCapabilityCanary,
  type ProductionCapabilityApprenticeshipBoundary,
} from '../../src/production-capability-apprenticeship.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityResourceDescriptor,
  CognitiveApprovalPacket,
} from '../../src/types.js';

type WorkerKind =
  | 'crash_canary_stage'
  | 'inspect_and_retry_canary'
  | 'crash_activation_stage'
  | 'inspect_and_retry_activation'
  | 'crash_active_reuse_stage'
  | 'inspect_and_retry_active_reuse'
  | 'crash_after_receipts'
  | 'recover_after_receipts';

interface WorkerCommand {
  kind: WorkerKind;
  databasePath: string;
  markerPath: string;
  statePath: string;
  effectCounterPath: string;
}

interface FixtureState {
  acquisitionId: string;
  runId?: string;
  baseline?: ArtifactCounts;
}

interface ArtifactCounts {
  productionRuns: number;
  durableWorks: number;
  approvals: number;
  cognitiveRuns: number;
  durableLinks: number;
  durableCheckpoints: number;
  resumeGrants: number;
  activeWorkLeases: number;
}

const NOW = new Date('2026-07-15T12:00:00.000Z');
const GROUP = 'main';
const RESOURCE_VERSION = 'hard-kill-production-v1';
const EXECUTOR_ID = 'hard-kill.production.lookup';
const EVALUATOR_ID = 'hard-kill.production.verify';
const EXECUTOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'executor',
  implementationId: EXECUTOR_ID,
  version: RESOURCE_VERSION,
});
const EVALUATOR_DIGEST = capabilityBindingImplementationDigest({
  kind: 'evaluator',
  implementationId: EVALUATOR_ID,
  version: RESOURCE_VERSION,
});
const values = { key: 'alpha', targetScopeKey: 'hard-kill-target' };
const binding = {
  ownerId: 'hard-kill-owner',
  chatId: 'hard-kill-cockpit',
  groupId: GROUP,
  channel: 'owner_cockpit',
  targetScopeKey: 'hard-kill-target',
};
const hold = new Int32Array(new SharedArrayBuffer(4));

function at(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1_000);
}

function resource(): CapabilityResourceDescriptor {
  return {
    resourceId: 'hard-kill.production.resource',
    kind: 'local_script',
    displayName: 'Hard-kill production fixture lookup',
    taskFamilies: ['hard_kill_production_fixture'],
    capabilityIds: ['hard-kill.production'],
    supportedPostconditions: ['hard-kill production value is verified'],
    requiredInputs: ['key', 'targetScopeKey'],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 1,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'none',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version: RESOURCE_VERSION,
    sourceRefs: ['fixture:hard-kill-production-resource'],
    maintenanceBurden: 'low',
    bindingRefs: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        evaluatorId: EVALUATOR_ID,
        executorImplementationDigest: EXECUTOR_DIGEST,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        actionClass: 'local_lookup',
        version: RESOURCE_VERSION,
        readOnly: true,
      },
    ],
  };
}

function writeState(path: string, state: FixtureState): void {
  fs.writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

function readState(path: string): FixtureState {
  return JSON.parse(fs.readFileSync(path, 'utf8')) as FixtureState;
}

function incrementCounter(path: string): number {
  let current = 0;
  try {
    current = Number.parseInt(fs.readFileSync(path, 'utf8'), 10) || 0;
  } catch {
    // The first invocation creates the fixture counter.
  }
  const next = current + 1;
  fs.writeFileSync(path, String(next), { mode: 0o600 });
  return next;
}

function readCounter(path: string): number {
  try {
    return Number.parseInt(fs.readFileSync(path, 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}

function productionHeads(runId: string): {
  expectedAcquisitionVersion: number;
  expectedRunRevision: number;
  authorizedSurface: string;
} {
  const run = getCapabilityProductionRun(runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (!run || !acquisition)
    throw new Error('Hard-kill fixture head is missing.');
  return {
    expectedAcquisitionVersion: acquisition.recordVersion,
    expectedRunRevision: run.revision,
    authorizedSurface: run.authorizedSurface,
  };
}

function artifactCounts(acquisitionId: string): ArtifactCounts {
  const works = listDurableWorkUnits({ limit: 2_000 });
  return {
    productionRuns: listCapabilityProductionRuns({
      acquisitionId,
      limit: 1_000,
    }).length,
    durableWorks: works.length,
    approvals: listCognitiveApprovalPackets({
      groupFolder: GROUP,
      limit: 1_000,
    }).length,
    cognitiveRuns: listCognitiveRuns({
      groupFolder: GROUP,
      limit: 1_000,
    }).length,
    durableLinks: works.reduce(
      (count, work) => count + listDurableWorkLinks(work.workId).length,
      0,
    ),
    durableCheckpoints: works.reduce(
      (count, work) =>
        count +
        listDurableWorkCheckpoints({ workId: work.workId, limit: 500 }).length,
      0,
    ),
    resumeGrants: listDurableResumeGrants({ limit: 500 }).length,
    activeWorkLeases: works.filter((work) => work.leaseId).length,
  };
}

function approve(packet: CognitiveApprovalPacket, now: Date): void {
  const result = approveCognitiveApprovalPacketCAS({
    approvalPacketId: packet.approvalPacketId,
    groupFolder: GROUP,
    expectedSummary: packet.summary,
    expectedApprovalVersion: packet.approvalVersion || 1,
    expectedScopeDigest: packet.scopeDigest || null,
    now: now.toISOString(),
    approvalChannel: 'owner_cockpit',
  });
  if (result.status !== 'approved') {
    throw new Error('Hard-kill fixture approval was not accepted.');
  }
}

function seedHealth(): void {
  upsertToolReliabilitySubject({
    subjectId: 'hard-kill-production-subject',
    subjectKind: 'capability',
    displayName: 'Hard-kill production fixture',
    aliasesJson: JSON.stringify([resource().resourceId]),
    riskLevel: 'low',
    approvalRequirement: 'none',
    channelsJson: JSON.stringify(['owner_cockpit']),
    sourceRefsJson: JSON.stringify(['fixture:hard-kill-health']),
    privacyJson: '{}',
  });
  upsertReliabilityObservation({
    observationId: 'hard-kill-production-health-1',
    subjectId: 'hard-kill-production-subject',
    observedAt: at(2).toISOString(),
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: 1,
    summary: 'The isolated hard-kill fixture resource is healthy.',
    nextAction: 'Use only this exact fixture version.',
    evidenceIdsJson: '[]',
    privacyJson: '{}',
  });
}

async function prepareCandidate(): Promise<CapabilityAcquisitionRecord> {
  const descriptor = resource();
  const observed = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: GROUP,
    targetOutcome: 'Return one verified hard-kill fixture value',
    postconditions: descriptor.supportedPostconditions,
    taskFamily: descriptor.taskFamilies[0] as string,
    gapKind: 'tool_usage_gap',
    provenanceRefs: ['fixture:hard-kill-owner-request'],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'hard-kill-fixture-environment-v1',
    now: NOW,
  });
  scopeCapabilityAcquisition({
    acquisitionId: observed.acquisitionId,
    knownPrerequisites: ['fixture key'],
    missingPrerequisites: [],
    confidence: 0.9,
    now: NOW,
  });
  recordCapabilityResourceDiscovery({
    acquisitionId: observed.acquisitionId,
    candidates: [descriptor],
    selected: [descriptor],
    rejectedReasons: {},
    now: NOW,
  });
  compileCapabilityCandidate({
    acquisitionId: observed.acquisitionId,
    selectedResources: [descriptor],
    triggerSemantics: ['verify a hard-kill production fixture'],
    requiredInputs: ['key', 'targetScopeKey'],
    expectedOutput: 'A verified hard-kill fixture value.',
    deterministicScenarioIds: ['hard-kill-production-primary'],
    heldOutScenarioIds: ['hard-kill-production-heldout'],
    now: NOW,
  });
  prepareCapabilitySandbox({ acquisitionId: observed.acquisitionId, now: NOW });
  const sandboxRegistry = createHermeticCertificationBindingRegistry({
    executors: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        resourceId: descriptor.resourceId,
        version: RESOURCE_VERSION,
        executorImplementationDigest: EXECUTOR_DIGEST,
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        async execute() {
          return {
            result: { value: 'hard-kill:sandbox' },
            evidenceRefs: ['fixture:hard-kill-sandbox-read'],
            effectClass: 'read_only',
            effectStatus: 'certain',
            preStateFingerprint: '1'.repeat(64),
            postStateFingerprint: '2'.repeat(64),
            providerCalls: 0,
            costUsd: 0,
          };
        },
      },
    ],
    evaluators: [
      {
        evaluatorId: EVALUATOR_ID,
        operationId: 'lookup',
        resourceId: descriptor.resourceId,
        version: RESOURCE_VERSION,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        async verify({ requiredPostconditions }) {
          return {
            verified: true,
            evidenceRefs: ['fixture:hard-kill-sandbox-verifier'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '3'.repeat(64),
            reason: 'The isolated sandbox value is verified.',
          };
        },
      },
    ],
  });
  const scope = prepareCapabilityExecutionScope({
    acquisitionId: observed.acquisitionId,
    ownerId: binding.ownerId,
    chatId: binding.chatId,
    groupId: binding.groupId,
    channel: binding.channel,
    targetScopeKey: binding.targetScopeKey,
    now: NOW,
  });
  await runCapabilitySandbox({
    acquisitionId: observed.acquisitionId,
    values,
    registry: sandboxRegistry,
    currentResources: [descriptor],
    scope,
    networkPolicy: 'none',
    now: NOW,
  });
  return recordCapabilityHeldOutEvidence({
    acquisitionId: observed.acquisitionId,
    evidence: {
      passed: true,
      cases: 1,
      safetyInvariantRate: 1,
      falseSuccesses: 0,
      evidenceRefs: ['fixture:hard-kill-independent-heldout'],
    },
    actorKind: 'certification',
    now: at(1),
  });
}

function liveRegistry(effectCounterPath: string) {
  const descriptor = resource();
  return createIsolatedProductionCapabilityRegistryForTest({
    executors: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        resourceId: descriptor.resourceId,
        version: RESOURCE_VERSION,
        executorImplementationDigest: EXECUTOR_DIGEST,
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        maximumCostUsd: 0,
        async execute() {
          incrementCounter(effectCounterPath);
          return {
            result: { value: 'hard-kill:alpha' },
            evidenceRefs: ['fixture:hard-kill-production-read'],
            effectClass: 'read_only',
            effectStatus: 'none',
            preStateFingerprint: '4'.repeat(64),
            postStateFingerprint: '5'.repeat(64),
            providerCalls: 0,
            costUsd: 0,
          };
        },
      },
    ],
    evaluators: [
      {
        evaluatorId: EVALUATOR_ID,
        operationId: 'lookup',
        resourceId: descriptor.resourceId,
        version: RESOURCE_VERSION,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        async verify({ requiredPostconditions }) {
          return {
            verified: true,
            evidenceRefs: ['fixture:hard-kill-production-verifier'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '6'.repeat(64),
            reason: 'The isolated production value is verified.',
          };
        },
      },
    ],
  });
}

function installHardKillBoundary(
  expected: ProductionCapabilityApprenticeshipBoundary,
  markerPath: string,
): void {
  _setProductionCapabilityApprenticeshipTestHook((event) => {
    if (event.boundary !== expected) return;
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ boundary: event.boundary, runId: event.runId }),
      { mode: 0o600 },
    );
    // This deliberately keeps the SQLite transaction/call stack open until
    // the parent process sends SIGKILL. Throwing here would exercise ordinary
    // catch cleanup instead of process-death rollback.
    Atomics.wait(hold, 0, 0);
  });
}

function stageCanary(acquisition: CapabilityAcquisitionRecord) {
  return stageCapabilityCanary({
    acquisitionId: acquisition.acquisitionId,
    expectedAcquisitionVersion: acquisition.recordVersion,
    binding,
    authorizedSurface: 'owner_cockpit',
    normalizedInputs: values,
    health: [
      {
        resourceId: resource().resourceId,
        observationId: 'hard-kill-production-health-1',
        expiresAt: at(20 * 60).toISOString(),
      },
    ],
    now: at(3),
  });
}

async function prepareAuthorizedCanary(effectCounterPath: string) {
  const acquisition = await prepareCandidate();
  seedHealth();
  const staged = stageCanary(acquisition);
  approve(staged.approval, at(4));
  authorizeApprovedCapabilityCanary({
    runId: staged.run.runId,
    ...productionHeads(staged.run.runId),
    binding,
    workerId: 'hard-kill-authorize-worker',
    now: at(5),
  });
  return { acquisition, staged, registry: liveRegistry(effectCounterPath) };
}

async function prepareReviewedCanary(effectCounterPath: string) {
  const prepared = await prepareAuthorizedCanary(effectCounterPath);
  await runCapabilityProductionExecution({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding,
    workerId: 'hard-kill-completion-worker',
    values,
    registry: prepared.registry,
    now: at(6),
  });
  const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
    runId: prepared.staged.run.runId,
    now: at(7),
  });
  recordCapabilityOwnerVerdict({ token, verdict: 'verified', now: at(8) });
  return prepared;
}

async function prepareActivatedCanary(effectCounterPath: string) {
  const prepared = await prepareReviewedCanary(effectCounterPath);
  const activation = stageCapabilityActivation({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding,
    now: at(9),
  });
  approve(activation.approval, at(10));
  const activated = authorizeApprovedCapabilityActivation({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding,
    workerId: 'hard-kill-activation-worker',
    now: at(11),
  });
  return { ...prepared, acquisition: activated.acquisition };
}

function stageActiveReuse(
  acquisition: CapabilityAcquisitionRecord,
  workerId: string,
) {
  const contract = JSON.parse(acquisition.candidateContractJson) as {
    taskFamily: string;
    successPostconditions: string[];
  };
  const currentResourceVersions = {
    [resource().resourceId]: resource().version,
  };
  const match = matchActiveCapability({
    groupFolder: GROUP,
    taskFamily: contract.taskFamily,
    inputs: values,
    intendedPostconditions: contract.successPostconditions,
    binding,
    currentResourceVersions,
  });
  if (match.status !== 'matched') {
    throw new Error(`Active hard-kill fixture did not match: ${match.status}.`);
  }
  return stageActiveCapabilityReuse({
    match,
    taskFamily: contract.taskFamily,
    intendedPostconditions: contract.successPostconditions,
    binding,
    normalizedInputs: values,
    health: [
      {
        resourceId: resource().resourceId,
        observationId: 'hard-kill-production-health-1',
        expiresAt: at(20 * 60).toISOString(),
      },
    ],
    currentResourceVersions,
    workerId,
    now: at(12),
  });
}

function sendAndExit(message: Record<string, unknown>): void {
  _setProductionCapabilityApprenticeshipTestHook(null);
  if (isDatabaseInitialized()) _closeDatabase();
  if (!process.send) {
    process.exitCode = 1;
    return;
  }
  process.send(message, (error) => {
    if (error) process.exitCode = 1;
    process.disconnect?.();
  });
}

function failClosed(error: unknown): void {
  try {
    _setProductionCapabilityApprenticeshipTestHook(null);
    if (isDatabaseInitialized()) _closeDatabase();
  } catch {
    // Return only a stable fixture error class over IPC.
  }
  const detail = error instanceof Error ? error.message : '';
  const failureClass = /receipt-only step/i.test(detail)
    ? 'receipt_step_not_exact'
    : /receipt-only verification marker/i.test(detail)
      ? 'receipt_marker_incomplete'
      : /receipt-only recovery head/i.test(detail)
        ? 'receipt_recovery_head_stale'
        : /execution-time authority/i.test(detail)
          ? 'execution_authority_missing'
          : /health/i.test(detail)
            ? 'execution_health_invalid'
            : /checkpoint/i.test(detail)
              ? 'checkpoint_recovery_failed'
              : /approval/i.test(detail)
                ? 'approval_rejected'
                : 'hard_kill_fixture_failed';
  sendAndExit({
    type: 'error',
    failureClass,
  });
  process.exitCode = 1;
}

async function execute(command: WorkerCommand): Promise<void> {
  _initTestDatabaseAtPath(command.databasePath);
  if (command.kind === 'crash_canary_stage') {
    const acquisition = await prepareCandidate();
    seedHealth();
    writeState(command.statePath, {
      acquisitionId: acquisition.acquisitionId,
      baseline: artifactCounts(acquisition.acquisitionId),
    });
    installHardKillBoundary(
      'after_canary_stage_before_run',
      command.markerPath,
    );
    stageCanary(acquisition);
    throw new Error('Canary staging passed its hard-kill boundary.');
  }

  if (command.kind === 'inspect_and_retry_canary') {
    const state = readState(command.statePath);
    const acquisition = getCapabilityAcquisition(state.acquisitionId);
    if (!acquisition) throw new Error('Canary acquisition disappeared.');
    const beforeRetry = artifactCounts(acquisition.acquisitionId);
    const staged = stageCanary(acquisition);
    const afterRetry = artifactCounts(acquisition.acquisitionId);
    sendAndExit({
      type: 'canary_rollback_verified',
      baseline: state.baseline,
      beforeRetry,
      afterRetry,
      runStatus: staged.run.status,
      approvalStatus: staged.approval.status,
    });
    return;
  }

  if (command.kind === 'crash_activation_stage') {
    const prepared = await prepareReviewedCanary(command.effectCounterPath);
    const run = getCapabilityProductionRun(prepared.staged.run.runId);
    if (!run) throw new Error('Reviewed canary disappeared.');
    writeState(command.statePath, {
      acquisitionId: prepared.acquisition.acquisitionId,
      runId: run.runId,
      baseline: artifactCounts(prepared.acquisition.acquisitionId),
    });
    installHardKillBoundary(
      'after_activation_stage_before_run',
      command.markerPath,
    );
    stageCapabilityActivation({
      runId: run.runId,
      ...productionHeads(run.runId),
      binding,
      now: at(9),
    });
    throw new Error('Activation staging passed its hard-kill boundary.');
  }

  if (command.kind === 'inspect_and_retry_activation') {
    const state = readState(command.statePath);
    if (!state.runId) throw new Error('Activation run identity is missing.');
    const beforeRetry = artifactCounts(state.acquisitionId);
    const beforeRun = getCapabilityProductionRun(state.runId);
    if (!beforeRun) throw new Error('Activation canary disappeared.');
    const staged = stageCapabilityActivation({
      runId: state.runId,
      ...productionHeads(state.runId),
      binding,
      now: at(9),
    });
    const afterRetry = artifactCounts(state.acquisitionId);
    sendAndExit({
      type: 'activation_rollback_verified',
      baseline: state.baseline,
      beforeRetry,
      afterRetry,
      runStatusBeforeRetry: beforeRun.status,
      activationWorkBeforeRetry: beforeRun.activationWorkId,
      runStatusAfterRetry: staged.run.status,
      activationWorkAfterRetry: staged.run.activationWorkId,
      approvalStatus: staged.approval.status,
    });
    return;
  }

  if (command.kind === 'crash_active_reuse_stage') {
    const prepared = await prepareActivatedCanary(command.effectCounterPath);
    writeState(command.statePath, {
      acquisitionId: prepared.acquisition.acquisitionId,
      baseline: artifactCounts(prepared.acquisition.acquisitionId),
    });
    installHardKillBoundary(
      'after_active_reuse_lease_before_run',
      command.markerPath,
    );
    stageActiveReuse(
      prepared.acquisition,
      'hard-kill-active-reuse-crash-worker',
    );
    throw new Error('Active reuse staging passed its hard-kill boundary.');
  }

  if (command.kind === 'inspect_and_retry_active_reuse') {
    const state = readState(command.statePath);
    const acquisition = getCapabilityAcquisition(state.acquisitionId);
    if (!acquisition) throw new Error('Active reuse acquisition disappeared.');
    const beforeRetry = artifactCounts(acquisition.acquisitionId);
    const staged = stageActiveReuse(
      acquisition,
      'hard-kill-active-reuse-retry-worker',
    );
    const afterRetry = artifactCounts(acquisition.acquisitionId);
    sendAndExit({
      type: 'active_reuse_rollback_verified',
      baseline: state.baseline,
      beforeRetry,
      afterRetry,
      runStatus: staged.status,
      runKind: staged.runKind,
      runWorkId: staged.workId,
      runLeaseId: staged.executionLeaseId,
    });
    return;
  }

  if (command.kind === 'crash_after_receipts') {
    const prepared = await prepareAuthorizedCanary(command.effectCounterPath);
    writeState(command.statePath, {
      acquisitionId: prepared.acquisition.acquisitionId,
      runId: prepared.staged.run.runId,
    });
    installHardKillBoundary(
      'after_receipts_before_checkpoint',
      command.markerPath,
    );
    await runCapabilityProductionExecution({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding,
      workerId: 'hard-kill-execution-worker',
      values,
      registry: prepared.registry,
      now: at(6),
    });
    throw new Error('Execution passed its hard-kill boundary.');
  }

  const state = readState(command.statePath);
  if (!state.runId) throw new Error('Recovery run identity is missing.');
  const first = await recoverCapabilityProductionRun({
    runId: state.runId,
    values,
    binding,
    workerId: 'hard-kill-recovery-worker-1',
    registry: liveRegistry(command.effectCounterPath),
    now: at(7),
    clock: () => at(7),
  });
  const runAfterFirst = getCapabilityProductionRun(state.runId);
  if (!runAfterFirst) throw new Error('Recovered run disappeared.');
  const workAfterFirst = getDurableWorkUnit(runAfterFirst.workId);
  const checkpointAfterFirst = workAfterFirst?.checkpointHeadId
    ? getDurableWorkCheckpoint(workAfterFirst.checkpointHeadId)
    : undefined;
  const countsAfterFirst = {
    effects: readCounter(command.effectCounterPath),
    outcomes: getOutcomeBySource(GROUP, 'capability_acquisition', state.runId)
      ? 1
      : 0,
    steps: listCapabilityProductionSteps(state.runId).length,
    receipts: listDurableEffectReceipts({ workId: runAfterFirst.workId })
      .length,
    completionTransitions: listCapabilityProductionTransitionReceipts({
      runId: state.runId,
      limit: 100,
    }).filter((receipt) => receipt.transitionKind === 'canary_completed')
      .length,
  };
  const firstRevision = runAfterFirst.revision;
  const second = await recoverCapabilityProductionRun({
    runId: state.runId,
    values,
    binding,
    workerId: 'hard-kill-recovery-worker-2',
    registry: liveRegistry(command.effectCounterPath),
    now: at(8),
    clock: () => at(8),
  });
  const runAfterSecond = getCapabilityProductionRun(state.runId);
  if (!runAfterSecond)
    throw new Error('Idempotently recovered run disappeared.');
  const countsAfterSecond = {
    effects: readCounter(command.effectCounterPath),
    outcomes: getOutcomeBySource(GROUP, 'capability_acquisition', state.runId)
      ? 1
      : 0,
    steps: listCapabilityProductionSteps(state.runId).length,
    receipts: listDurableEffectReceipts({ workId: runAfterSecond.workId })
      .length,
    completionTransitions: listCapabilityProductionTransitionReceipts({
      runId: state.runId,
      limit: 100,
    }).filter((receipt) => receipt.transitionKind === 'canary_completed')
      .length,
  };
  sendAndExit({
    type: 'receipt_recovery_verified',
    firstStatus: first.status,
    secondStatus: second.status,
    firstRevision,
    secondRevision: runAfterSecond.revision,
    workStatus: workAfterFirst?.status,
    checkpointStatus: checkpointAfterFirst?.status,
    countsAfterFirst,
    countsAfterSecond,
    executionCalls: runAfterSecond.executionCalls,
    outcomeLinked: Boolean(runAfterSecond.outcomeId),
  });
}

process.once('message', (value) => {
  void execute(value as WorkerCommand).catch(failClosed);
});

process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);
