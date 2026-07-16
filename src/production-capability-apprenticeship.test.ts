import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  _closeDatabase,
  _initTestDatabase,
  _initTestDatabaseAtPath,
  approveCognitiveApprovalPacketCAS,
  getCapabilityAcquisition,
  getCapabilityOwnerReviewForRun,
  getCapabilityProductionRun,
  getDurableWorkLease,
  getDurableWorkUnit,
  getOutcomeBySource,
  insertCapabilityOwnerActionToken,
  listCapabilityProductionRuns,
  listCapabilityProductionTransitionReceipts,
  listCognitiveApprovalPackets,
  listDurableEffectReceipts,
  listDurableResumeGrants,
  listDurableWorkCheckpoints,
  listDurableWorkLinks,
  listDurableWorkUnits,
  recordCapabilityOwnerReviewWithToken,
  updateCapabilityProductionRunCAS,
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from './db.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import { assertCapabilityCandidateContract } from './capability-acquisition-policy.js';
import {
  _setDurableContinuityTestHook,
  consumeResumeGrantAndAcquireLease,
  durableScopeHash,
  issueDurableResumeGrant,
  reconcileDurableWorkOnStartup,
  releaseDurableLease,
} from './durable-work-continuity.js';
import {
  authorizeCapabilitySandbox,
  CAPABILITY_SANDBOX_MARKER,
  capabilitySandboxTargetScopeHash,
  compileCapabilityCandidate,
  createHermeticCertificationBindingRegistry,
  observeCapabilityGap,
  prepareCapabilityExecutionScope,
  prepareCapabilitySandbox,
  recordCapabilityHeldOutEvidence,
  recordCapabilityResourceDiscovery,
  runCapabilitySandbox,
  scopeCapabilityAcquisition,
  stageCapabilitySandboxApproval,
} from './verified-capability-acquisition.js';
import {
  _renderProductionApprovalSummaryForTest,
  authorizeApprovedCapabilityActivation,
  authorizeApprovedCapabilityCanary,
  authorizeApprovedCapabilityProductionAction,
  _setProductionCapabilityApprenticeshipTestHook,
  applyCapabilityOwnerControl,
  createIsolatedProductionCapabilityRegistryForTest,
  issueCapabilityReviewTokenForAuthenticatedCockpit,
  issueCapabilityReviewTokenForTrustedChat,
  issueCapabilityControlTokenForAuthenticatedCockpit,
  issueCapabilityControlTokenForTrustedChat,
  recordCapabilityOwnerVerdict,
  recoverCapabilityProductionRun,
  runCapabilityProductionExecution,
  matchActiveCapability,
  stageActiveCapabilityReuse,
  stageCapabilityActivation,
  stageCapabilityCanary,
  stageCapabilityProductionActionApproval,
} from './production-capability-apprenticeship.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityResourceDescriptor,
  RegisteredGroup,
} from './types.js';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const RESOURCE_VERSION = 'fixture-production-v1';
const EXECUTOR_ID = 'fixture.production.lookup';
const EVALUATOR_ID = 'fixture.production.verify';
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

function resource(): CapabilityResourceDescriptor {
  return {
    resourceId: 'fixture.production.resource',
    kind: 'local_script',
    displayName: 'Production fixture lookup',
    taskFamilies: ['production_fixture'],
    capabilityIds: ['fixture.production'],
    supportedPostconditions: ['fixture production value is verified'],
    requiredInputs: ['key', 'targetScopeKey'],
    available: true,
    healthState: 'healthy',
    verificationStrength: 1,
    reliabilityScore: 0.99,
    authorityRequirement: 'none',
    riskLevel: 'low',
    dataEgressClass: 'none',
    reversible: true,
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    version: RESOURCE_VERSION,
    sourceRefs: ['fixture:production-resource'],
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

function productionHeads(runId: string) {
  const run = getCapabilityProductionRun(runId);
  const acquisition = run
    ? getCapabilityAcquisition(run.acquisitionId)
    : undefined;
  if (!run || !acquisition) throw new Error('Fixture production head missing.');
  return {
    expectedAcquisitionVersion: acquisition.recordVersion,
    expectedRunRevision: run.revision,
    authorizedSurface: run.authorizedSurface,
  };
}

async function ownerReviewRequiredAcquisition(targetSuffix = '') {
  const observed = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: 'main',
    targetOutcome: `Return one verified production fixture value${targetSuffix}`,
    postconditions: ['fixture production value is verified'],
    taskFamily: 'production_fixture',
    gapKind: 'tool_usage_gap',
    provenanceRefs: ['fixture:owner-request'],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'fixture-environment-v1',
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
    candidates: [resource()],
    selected: [resource()],
    rejectedReasons: {},
    now: NOW,
  });
  compileCapabilityCandidate({
    acquisitionId: observed.acquisitionId,
    selectedResources: [resource()],
    triggerSemantics: ['verify a production fixture'],
    requiredInputs: ['key', 'targetScopeKey'],
    expectedOutput: 'A verified fixture value.',
    deterministicScenarioIds: ['production-fixture-primary'],
    heldOutScenarioIds: ['production-fixture-heldout'],
    now: NOW,
  });
  prepareCapabilitySandbox({ acquisitionId: observed.acquisitionId, now: NOW });
  const registry = createHermeticCertificationBindingRegistry({
    executors: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        executorImplementationDigest: EXECUTOR_DIGEST,
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        async execute({ values }) {
          return {
            result: { value: `fixture:${String(values.key)}` },
            evidenceRefs: ['fixture:sandbox-read'],
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
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        async verify({ requiredPostconditions }) {
          return {
            verified: true,
            evidenceRefs: ['fixture:sandbox-verifier'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '3'.repeat(64),
            reason: 'Fixture value is present.',
          };
        },
      },
    ],
  });
  const scope = prepareCapabilityExecutionScope({
    acquisitionId: observed.acquisitionId,
    ownerId: 'owner',
    chatId: 'cockpit',
    groupId: 'main',
    channel: 'owner_cockpit',
    targetScopeKey: 'fixture-target',
    now: NOW,
  });
  await runCapabilitySandbox({
    acquisitionId: observed.acquisitionId,
    values: { key: 'alpha', targetScopeKey: 'fixture-target' },
    registry,
    currentResources: [resource()],
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
      evidenceRefs: ['fixture:independent-heldout'],
    },
    actorKind: 'certification',
    now: new Date(NOW.getTime() + 1_000),
  });
}

function seedHealth() {
  upsertToolReliabilitySubject({
    subjectId: 'fixture-production-subject',
    subjectKind: 'capability',
    displayName: 'Production fixture',
    aliasesJson: JSON.stringify([resource().resourceId]),
    riskLevel: 'low',
    approvalRequirement: 'none',
    channelsJson: '["owner_cockpit"]',
    sourceRefsJson: '["fixture:health"]',
    privacyJson: '{}',
  });
  upsertReliabilityObservation({
    observationId: 'fixture-production-health-1',
    subjectId: 'fixture-production-subject',
    observedAt: new Date(NOW.getTime() + 2_000).toISOString(),
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: 1,
    summary: 'Fixture resource is healthy.',
    nextAction: 'Use only the version-pinned fixture.',
    evidenceIdsJson: '[]',
    privacyJson: '{}',
  });
}

function approve(
  packet: {
    approvalPacketId: string;
    summary: string;
    approvalVersion?: number;
    scopeDigest?: string | null;
  },
  now: string,
  approvalChannel = 'owner_cockpit',
) {
  const result = approveCognitiveApprovalPacketCAS({
    approvalPacketId: packet.approvalPacketId,
    groupFolder: 'main',
    expectedSummary: packet.summary,
    expectedApprovalVersion: packet.approvalVersion || 1,
    expectedScopeDigest: packet.scopeDigest || null,
    now,
    approvalChannel,
  });
  expect(result.status).toBe('approved');
}

const fixtureValues = { key: 'alpha', targetScopeKey: 'fixture-target' };
const fixtureBinding = {
  ownerId: 'owner',
  chatId: 'cockpit',
  groupId: 'main',
  channel: 'owner_cockpit',
  targetScopeKey: 'fixture-target',
};

function liveRegistry(
  counter?: { executions: number },
  telemetry: {
    providerCalls?: number;
    costUsd?: number;
    recoveryVerified?: boolean;
    afterRecoveryRead?: () => void;
  } = {},
) {
  return createIsolatedProductionCapabilityRegistryForTest({
    executors: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        executorImplementationDigest: EXECUTOR_DIGEST,
        actionClass: 'local_lookup',
        effectClass: 'read_only',
        networkAccess: 'none',
        maximumCostUsd: 0,
        async execute() {
          if (counter) counter.executions += 1;
          return {
            result: { value: 'fixture:alpha' },
            evidenceRefs: ['fixture:production-read'],
            effectClass: 'read_only',
            effectStatus: 'none',
            preStateFingerprint: '4'.repeat(64),
            postStateFingerprint: '5'.repeat(64),
            providerCalls: telemetry.providerCalls || 0,
            costUsd: telemetry.costUsd || 0,
          };
        },
      },
    ],
    evaluators: [
      {
        evaluatorId: EVALUATOR_ID,
        operationId: 'lookup',
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        async verify({ requiredPostconditions }) {
          return {
            verified: true,
            evidenceRefs: ['fixture:production-verifier'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: '6'.repeat(64),
            reason: 'Production fixture is verified.',
          };
        },
        async recover({ requiredPostconditions }) {
          telemetry.afterRecoveryRead?.();
          const verified = telemetry.recoveryVerified !== false;
          return {
            verified,
            result: verified ? { value: 'fixture:alpha' } : undefined,
            evidenceRefs: verified ? ['fixture:recovery-verifier'] : [],
            verifiedPostconditions: verified ? requiredPostconditions : [],
            postconditionFingerprint: verified ? '7'.repeat(64) : undefined,
            reason: verified
              ? 'Current fixture state independently proves the effect.'
              : 'Current fixture state is not yet conclusive.',
          };
        },
      },
    ],
  });
}

function protectedLiveRegistry(counter: { executions: number }) {
  return createIsolatedProductionCapabilityRegistryForTest({
    executors: [
      {
        bindingId: EXECUTOR_ID,
        operationId: 'lookup',
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        executorImplementationDigest: EXECUTOR_DIGEST,
        actionClass: 'repository_write',
        effectClass: 'repository_write',
        networkAccess: 'none',
        maximumCostUsd: 0,
        async execute() {
          counter.executions += 1;
          return {
            result: { value: 'fixture:alpha' },
            evidenceRefs: ['fixture:protected-production-write'],
            effectClass: 'repository_write',
            effectStatus: 'certain',
            preStateFingerprint: '8'.repeat(64),
            postStateFingerprint: '9'.repeat(64),
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
        resourceId: resource().resourceId,
        version: RESOURCE_VERSION,
        evaluatorImplementationDigest: EVALUATOR_DIGEST,
        async verify({ requiredPostconditions }) {
          return {
            verified: true,
            evidenceRefs: ['fixture:protected-production-verifier'],
            verifiedPostconditions: requiredPostconditions,
            postconditionFingerprint: 'a'.repeat(64),
            reason: 'The protected fixture postcondition is verified.',
          };
        },
      },
    ],
  });
}

function protectedResource(): CapabilityResourceDescriptor {
  const descriptor = resource();
  return {
    ...descriptor,
    authorityRequirement: 'explicit_approval',
    riskLevel: 'medium',
    bindingRefs: descriptor.bindingRefs.map((binding) => ({
      ...binding,
      actionClass: 'repository_write',
      readOnly: false,
    })),
  };
}

async function ownerReviewRequiredProtectedAcquisition(): Promise<{
  acquisition: CapabilityAcquisitionRecord;
  contract: CapabilityCandidateContract;
}> {
  const selected = protectedResource();
  const observed = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: 'main',
    targetOutcome: 'Return one verified protected production fixture value',
    postconditions: ['fixture production value is verified'],
    taskFamily: 'production_fixture',
    gapKind: 'tool_usage_gap',
    provenanceRefs: ['fixture:protected-owner-request'],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'fixture-protected-environment-v1',
    authorityRequirements: [
      'fresh exact-scope owner approval:repository_write',
    ],
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
    candidates: [selected],
    selected: [selected],
    rejectedReasons: {},
    now: NOW,
  });
  const candidate = compileCapabilityCandidate({
    acquisitionId: observed.acquisitionId,
    selectedResources: [selected],
    triggerSemantics: ['verify a protected production fixture'],
    requiredInputs: ['key', 'targetScopeKey'],
    expectedOutput: 'A verified protected fixture value.',
    deterministicScenarioIds: ['protected-production-fixture-primary'],
    heldOutScenarioIds: ['protected-production-fixture-heldout'],
    now: NOW,
  });
  prepareCapabilitySandbox({ acquisitionId: observed.acquisitionId, now: NOW });
  const sandboxRoot = mkdtempSync(
    join(tmpdir(), 'andrea-protected-production-sandbox-'),
  );
  try {
    const sandboxBinding = {
      ownerId: 'owner',
      chatId: 'cockpit',
      groupId: 'main',
      channel: 'owner_cockpit',
      targetScopeKey: realpathSync(sandboxRoot),
    };
    const scope = prepareCapabilityExecutionScope({
      acquisitionId: observed.acquisitionId,
      ...sandboxBinding,
      now: NOW,
    });
    writeFileSync(
      join(sandboxRoot, CAPABILITY_SANDBOX_MARKER),
      JSON.stringify({
        contractVersion: 1,
        acquisitionId: observed.acquisitionId,
        candidateFingerprint: candidate.contract.candidateFingerprint,
        targetScopeHash: capabilitySandboxTargetScopeHash(sandboxRoot),
        disposable: true,
      }),
    );
    const staged = stageCapabilitySandboxApproval({
      acquisitionId: observed.acquisitionId,
      scope,
      now: NOW,
    });
    const approval = approveCognitiveApprovalPacketCAS({
      approvalPacketId: staged.approval.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: staged.approval.summary,
      expectedApprovalVersion: staged.approval.approvalVersion || 1,
      expectedScopeDigest: staged.approval.scopeDigest || null,
      now: new Date(NOW.getTime() + 100).toISOString(),
      approvalChannel: 'owner_cockpit',
    });
    if (approval.status !== 'approved' || !approval.approvalVersion) {
      throw new Error('Protected sandbox approval failed.');
    }
    const authorized = authorizeCapabilitySandbox({
      acquisitionId: observed.acquisitionId,
      scope: staged.scope,
      binding: sandboxBinding,
      approvalPacketId: staged.approval.approvalPacketId,
      approvalVersion: approval.approvalVersion,
      workerId: 'protected-sandbox-authorizer',
      processGeneration: 'process:protected-production-sandbox',
      now: new Date(NOW.getTime() + 200),
    });
    const registry = createHermeticCertificationBindingRegistry({
      executors: [
        {
          bindingId: EXECUTOR_ID,
          operationId: 'lookup',
          resourceId: selected.resourceId,
          version: selected.version,
          executorImplementationDigest: EXECUTOR_DIGEST,
          actionClass: 'repository_write',
          effectClass: 'repository_write',
          networkAccess: 'none',
          sandboxSimulation: true,
          async execute({ values, sandboxRoot: isolatedRoot }) {
            return {
              result: {
                value: `fixture:${String(values.key)}`,
                isolated: isolatedRoot === sandboxRoot,
              },
              evidenceRefs: ['fixture:protected-sandbox-write'],
              effectClass: 'repository_write',
              effectStatus: 'certain',
              preStateFingerprint: '1'.repeat(64),
              postStateFingerprint: '2'.repeat(64),
              providerCalls: 0,
              costUsd: 0,
            };
          },
          async cleanup() {
            return true;
          },
        },
      ],
      evaluators: [
        {
          evaluatorId: EVALUATOR_ID,
          operationId: 'lookup',
          resourceId: selected.resourceId,
          version: selected.version,
          evaluatorImplementationDigest: EVALUATOR_DIGEST,
          async verify({ requiredPostconditions }) {
            return {
              verified: true,
              evidenceRefs: ['fixture:protected-sandbox-verifier'],
              verifiedPostconditions: requiredPostconditions,
              postconditionFingerprint: '3'.repeat(64),
              reason: 'Protected sandbox fixture is verified.',
            };
          },
          async verifyCleanup({ cleanupSucceeded }) {
            return {
              verified: cleanupSucceeded,
              evidenceRefs: ['fixture:protected-cleanup-verifier'],
              cleanupFingerprint: '4'.repeat(64),
              reason: 'Protected sandbox cleanup is independently verified.',
            };
          },
        },
      ],
    });
    await runCapabilitySandbox({
      acquisitionId: observed.acquisitionId,
      values: fixtureValues,
      registry,
      currentResources: [selected],
      scope: staged.scope,
      networkPolicy: 'none',
      sandboxRoot,
      authorizations: [authorized.authorization],
      now: new Date(NOW.getTime() + 300),
    });
  } finally {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
  const acquisition = recordCapabilityHeldOutEvidence({
    acquisitionId: observed.acquisitionId,
    evidence: {
      passed: true,
      cases: 1,
      safetyInvariantRate: 1,
      falseSuccesses: 0,
      evidenceRefs: ['fixture:protected-independent-heldout'],
    },
    actorKind: 'certification',
    now: new Date(NOW.getTime() + 1_000),
  });
  return { acquisition, contract: candidate.contract };
}

async function prepareProtectedAuthorizedCanary() {
  const prepared = await ownerReviewRequiredProtectedAcquisition();
  const current = getCapabilityAcquisition(prepared.acquisition.acquisitionId);
  if (!current) throw new Error('Protected fixture acquisition disappeared.');
  seedHealth();
  const staged = stageCapabilityCanary({
    acquisitionId: current.acquisitionId,
    expectedAcquisitionVersion: current.recordVersion,
    binding: fixtureBinding,
    authorizedSurface: fixtureBinding.channel,
    normalizedInputs: fixtureValues,
    health: [
      {
        resourceId: resource().resourceId,
        observationId: 'fixture-production-health-1',
        expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      },
    ],
    now: new Date(NOW.getTime() + 3_000),
  });
  approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
  authorizeApprovedCapabilityCanary({
    runId: staged.run.runId,
    ...productionHeads(staged.run.runId),
    binding: fixtureBinding,
    workerId: 'protected-canary-authorizer',
    now: new Date(NOW.getTime() + 5_000),
  });
  return { acquisition: current, contract: prepared.contract, staged };
}

function useProtectedFixtureDatabase(): {
  cleanup: () => void;
} {
  _closeDatabase();
  const directory = mkdtempSync(join(tmpdir(), 'andrea-protected-action-'));
  const dbPath = join(directory, 'fixture.sqlite');
  _initTestDatabaseAtPath(dbPath);
  return {
    cleanup() {
      _closeDatabase();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function prepareAuthorizedCanary(
  options: {
    binding?: typeof fixtureBinding;
    authorizedSurface?: string;
    acquisitionTargetSuffix?: string;
  } = {},
) {
  const binding = options.binding || fixtureBinding;
  const acquisition = await ownerReviewRequiredAcquisition(
    options.acquisitionTargetSuffix,
  );
  seedHealth();
  const staged = stageCapabilityCanary({
    acquisitionId: acquisition.acquisitionId,
    expectedAcquisitionVersion: acquisition.recordVersion,
    binding,
    authorizedSurface: options.authorizedSurface || 'owner_cockpit',
    normalizedInputs: fixtureValues,
    health: [
      {
        resourceId: resource().resourceId,
        observationId: 'fixture-production-health-1',
        expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
      },
    ],
    now: new Date(NOW.getTime() + 3_000),
  });
  approve(
    staged.approval,
    new Date(NOW.getTime() + 4_000).toISOString(),
    binding.channel,
  );
  authorizeApprovedCapabilityCanary({
    runId: staged.run.runId,
    ...productionHeads(staged.run.runId),
    binding,
    workerId: 'fixture-authorize-worker',
    now: new Date(NOW.getTime() + 5_000),
  });
  return { acquisition, staged, binding };
}

async function prepareCompletedCanary(
  counter?: { executions: number },
  options: Parameters<typeof prepareAuthorizedCanary>[0] = {},
) {
  const prepared = await prepareAuthorizedCanary(options);
  await runCapabilityProductionExecution({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding: prepared.binding,
    workerId: 'fixture-execution-worker',
    values: fixtureValues,
    registry: liveRegistry(counter),
    now: new Date(NOW.getTime() + 6_000),
  });
  return prepared;
}

async function prepareActiveCapability() {
  const prepared = await prepareCompletedCanary();
  const reviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
    runId: prepared.staged.run.runId,
    now: new Date(NOW.getTime() + 7_000),
  });
  recordCapabilityOwnerVerdict({
    token: reviewToken,
    verdict: 'verified',
    now: new Date(NOW.getTime() + 8_000),
  });
  const activation = stageCapabilityActivation({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding: prepared.binding,
    now: new Date(NOW.getTime() + 9_000),
  });
  approve(activation.approval, new Date(NOW.getTime() + 10_000).toISOString());
  const activated = authorizeApprovedCapabilityActivation({
    runId: prepared.staged.run.runId,
    ...productionHeads(prepared.staged.run.runId),
    binding: prepared.binding,
    workerId: 'active-fixture-worker',
    now: new Date(NOW.getTime() + 11_000),
  });
  const contract = JSON.parse(activated.acquisition.candidateContractJson) as {
    taskFamily: string;
    triggerSemantics: string[];
    successPostconditions: string[];
  };
  return { ...prepared, activation, activated, contract };
}

beforeEach(() => {
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
  vi.stubEnv('ANDREA_TEST_NETWORK_GUARD_ACTIVE', '1');
  _initTestDatabase();
});

afterEach(() => {
  _setDurableContinuityTestHook(null);
  _setProductionCapabilityApprenticeshipTestHook(null);
  _closeDatabase();
  vi.unstubAllEnvs();
});

describe('production capability apprenticeship', () => {
  it('stages and consumes a separate exact action approval before a protected canary effect', async () => {
    const fixture = useProtectedFixtureDatabase();
    try {
      const prepared = await prepareProtectedAuthorizedCanary();
      const counter = { executions: 0 };
      await expect(
        runCapabilityProductionExecution({
          runId: prepared.staged.run.runId,
          ...productionHeads(prepared.staged.run.runId),
          binding: fixtureBinding,
          workerId: 'protected-before-approval',
          values: fixtureValues,
          registry: protectedLiveRegistry(counter),
          now: new Date(NOW.getTime() + 6_000),
        }),
      ).rejects.toThrow(/stopped before effect and staged/i);
      expect(counter.executions).toBe(0);

      const pending = getCapabilityProductionRun(prepared.staged.run.runId);
      const work = pending ? getDurableWorkUnit(pending.workId) : undefined;
      const actionPacket = work?.approvalPacketId
        ? listCognitiveApprovalPackets({
            groupFolder: 'main',
            limit: 100,
          }).find((packet) => packet.approvalPacketId === work.approvalPacketId)
        : undefined;
      expect(pending?.status).toBe('awaiting_action_approval');
      expect(actionPacket?.actionClass).toBe('repository_write');
      expect(actionPacket?.summary.length).toBeLessThanOrEqual(640);
      expect(actionPacket?.summary).toMatch(/exact=[a-f0-9]{64}/);
      expect(actionPacket?.summary).toContain(
        'steps=step-1=lookup>r1[repository_write]',
      );
      expect(actionPacket?.summary).toContain(
        'res=r1=fixture.production.resource@fixture-production-v1[execution_adapter|required]',
      );
      expect(actionPacket?.summary).toContain(
        'post=1:"fixture production value is verified"',
      );
      expect(actionPacket?.summary).toContain('egress:local_only');
      expect(actionPacket?.summary).toContain('creds:none');
      expect(actionPacket?.summary).toContain('rollback:none');
      expect(actionPacket?.summary).toContain('cost:$0');
      expect(actionPacket?.summary).toContain('risk:low');
      expect(actionPacket?.summary).toContain('authority=fresh-action-only');
      expect(actionPacket?.summary).toMatch(/target=[a-f0-9]{12}/);
      if (!actionPacket) throw new Error('Action packet was not staged.');
      approve(actionPacket, new Date(NOW.getTime() + 7_000).toISOString());
      const authorized = authorizeApprovedCapabilityProductionAction({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        workerId: 'protected-action-authorizer',
        now: new Date(NOW.getTime() + 8_000),
      });
      expect(authorized.run.status).toBe('canary_ready');
      expect(authorized.run.executionGrantId).toBeTruthy();
      expect(authorized.run.executionLeaseId).toBeTruthy();

      const executed = await runCapabilityProductionExecution({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        workerId: 'protected-executor',
        values: fixtureValues,
        registry: protectedLiveRegistry(counter),
        now: new Date(NOW.getTime() + 9_000),
      });
      expect(executed.status).toBe('verified');
      expect(counter.executions).toBe(1);
      const receipt = listDurableEffectReceipts({
        workId: authorized.run.workId,
        limit: 100,
      }).find((candidate) => candidate.status === 'succeeded');
      expect(receipt?.grantId).toBe(authorized.run.executionGrantId);
      expect(receipt?.approvalPacketId).toBe(actionPacket.approvalPacketId);
      expect(receipt?.actionClass).toBe('repository_write');

      const reviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
        runId: prepared.staged.run.runId,
        now: new Date(NOW.getTime() + 10_000),
      });
      recordCapabilityOwnerVerdict({
        token: reviewToken,
        verdict: 'verified',
        now: new Date(NOW.getTime() + 11_000),
      });
      const activation = stageCapabilityActivation({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        now: new Date(NOW.getTime() + 12_000),
      });
      approve(
        activation.approval,
        new Date(NOW.getTime() + 13_000).toISOString(),
      );
      const active = authorizeApprovedCapabilityActivation({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        workerId: 'protected-activation-authorizer',
        now: new Date(NOW.getTime() + 14_000),
      });
      const currentResourceVersions = {
        [resource().resourceId]: resource().version,
      };
      const beforeProtectedReuseRuns = listCapabilityProductionRuns({
        acquisitionId: prepared.acquisition.acquisitionId,
        limit: 100,
      }).length;
      for (const triggerText of [
        'protected production fixture verify',
        'do not verify a protected production fixture',
        'verify verify a protected production fixture',
      ]) {
        expect(
          matchActiveCapability({
            groupFolder: 'main',
            taskFamily: prepared.contract.taskFamily,
            triggerText,
            inputs: fixtureValues,
            intendedPostconditions: prepared.contract.successPostconditions,
            binding: fixtureBinding,
            currentResourceVersions,
            now: new Date(NOW.getTime() + 15_000),
          }).status,
        ).toBe('none');
      }
      expect(
        listCapabilityProductionRuns({
          acquisitionId: prepared.acquisition.acquisitionId,
          limit: 100,
        }),
      ).toHaveLength(beforeProtectedReuseRuns);
      const match = matchActiveCapability({
        groupFolder: 'main',
        taskFamily: prepared.contract.taskFamily,
        triggerText: prepared.contract.triggerSemantics[0],
        inputs: fixtureValues,
        intendedPostconditions: prepared.contract.successPostconditions,
        binding: fixtureBinding,
        currentResourceVersions,
        now: new Date(NOW.getTime() + 15_000),
      });
      expect(active.acquisition.state).toBe('active');
      expect(match.status).toBe('matched');
      const reuse = stageActiveCapabilityReuse({
        match,
        taskFamily: prepared.contract.taskFamily,
        triggerText: prepared.contract.triggerSemantics[0],
        intendedPostconditions: prepared.contract.successPostconditions,
        binding: fixtureBinding,
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: 'protected-reuse-stager',
        now: new Date(NOW.getTime() + 16_000),
      });
      expect(reuse.status).toBe('awaiting_action_approval');
      expect(reuse.executionGrantId).toBeNull();
      expect(reuse.executionLeaseId).toBeNull();
      const reuseWork = getDurableWorkUnit(reuse.workId);
      const reusePacket = reuseWork?.approvalPacketId
        ? listCognitiveApprovalPackets({
            groupFolder: 'main',
            limit: 100,
          }).find(
            (packet) => packet.approvalPacketId === reuseWork.approvalPacketId,
          )
        : undefined;
      if (!reusePacket) throw new Error('Reuse action packet was not staged.');
      approve(reusePacket, new Date(NOW.getTime() + 17_000).toISOString());
      const authorizedReuse = authorizeApprovedCapabilityProductionAction({
        runId: reuse.runId,
        ...productionHeads(reuse.runId),
        binding: fixtureBinding,
        workerId: 'protected-reuse-authorizer',
        now: new Date(NOW.getTime() + 18_000),
      });
      expect(authorizedReuse.run.status).toBe('monitoring');
      const reuseExecution = await runCapabilityProductionExecution({
        runId: reuse.runId,
        ...productionHeads(reuse.runId),
        binding: fixtureBinding,
        workerId: 'protected-reuse-executor',
        values: fixtureValues,
        registry: protectedLiveRegistry(counter),
        now: new Date(NOW.getTime() + 19_000),
      });
      expect(reuseExecution.status).toBe('verified');
      expect(counter.executions).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a protected action approval decided on the wrong channel without invoking the executor', async () => {
    const fixture = useProtectedFixtureDatabase();
    try {
      const prepared = await prepareProtectedAuthorizedCanary();
      const staged = stageCapabilityProductionActionApproval({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        now: new Date(NOW.getTime() + 6_000),
      });
      expect(
        approveCognitiveApprovalPacketCAS({
          approvalPacketId: staged.approval.approvalPacketId,
          groupFolder: 'main',
          expectedSummary: staged.approval.summary,
          expectedApprovalVersion: staged.approval.approvalVersion || 1,
          expectedScopeDigest: staged.approval.scopeDigest || null,
          now: new Date(NOW.getTime() + 7_000).toISOString(),
          approvalChannel: 'telegram',
        }).status,
      ).toBe('not_found_or_scope_mismatch');
      expect(() =>
        authorizeApprovedCapabilityProductionAction({
          runId: staged.run.runId,
          ...productionHeads(staged.run.runId),
          binding: fixtureBinding,
          workerId: 'wrong-channel-authorizer',
          now: new Date(NOW.getTime() + 8_000),
        }),
      ).toThrow(/exact current production action packet/i);
      expect(
        getCapabilityProductionRun(staged.run.runId)?.executionGrantId,
      ).toBe(null);
      expect(
        listDurableResumeGrants({
          workId: staged.run.workId,
          limit: 100,
        }).filter((grant) => grant.actionClass === 'repository_write'),
      ).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects expired or target-mismatched protected authority without invocation', async () => {
    const fixture = useProtectedFixtureDatabase();
    try {
      const prepared = await prepareProtectedAuthorizedCanary();
      const staged = stageCapabilityProductionActionApproval({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: fixtureBinding,
        now: new Date(NOW.getTime() + 6_000),
      });
      expect(() =>
        authorizeApprovedCapabilityProductionAction({
          runId: staged.run.runId,
          ...productionHeads(staged.run.runId),
          binding: { ...fixtureBinding, targetScopeKey: 'wrong-target' },
          workerId: 'wrong-target-authorizer',
          now: new Date(NOW.getTime() + 7_000),
        }),
      ).toThrow(/binding changed/i);
      const approvalExpiredAt = new Date(
        Date.parse(staged.approval.expiresAt as string) + 1,
      ).toISOString();
      const expired = approveCognitiveApprovalPacketCAS({
        approvalPacketId: staged.approval.approvalPacketId,
        groupFolder: 'main',
        expectedSummary: staged.approval.summary,
        expectedApprovalVersion: staged.approval.approvalVersion || 1,
        expectedScopeDigest: staged.approval.scopeDigest || null,
        now: approvalExpiredAt,
        approvalChannel: fixtureBinding.channel,
      });
      expect(expired.status).toBe('expired');
      expect(() =>
        authorizeApprovedCapabilityProductionAction({
          runId: staged.run.runId,
          ...productionHeads(staged.run.runId),
          binding: fixtureBinding,
          workerId: 'expired-action-authorizer',
          now: approvalExpiredAt,
        }),
      ).toThrow();
      expect(
        getCapabilityProductionRun(staged.run.runId)?.executionGrantId,
      ).toBe(null);
    } finally {
      fixture.cleanup();
    }
  });

  it('does not consume generic canary or activation approval from another channel', async () => {
    const acquisition = await ownerReviewRequiredAcquisition('-channel');
    seedHealth();
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: fixtureBinding.channel,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(
      approveCognitiveApprovalPacketCAS({
        approvalPacketId: staged.approval.approvalPacketId,
        groupFolder: 'main',
        expectedSummary: staged.approval.summary,
        expectedApprovalVersion: staged.approval.approvalVersion || 1,
        expectedScopeDigest: staged.approval.scopeDigest || null,
        now: new Date(NOW.getTime() + 4_000).toISOString(),
        approvalChannel: 'telegram',
      }).status,
    ).toBe('not_found_or_scope_mismatch');
    expect(() =>
      authorizeApprovedCapabilityCanary({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        binding: fixtureBinding,
        workerId: 'wrong-channel-canary',
        now: new Date(NOW.getTime() + 5_000),
      }),
    ).toThrow(/exact capability approval packet/i);
    expect(
      listDurableResumeGrants({ workId: staged.run.workId, limit: 100 }),
    ).toHaveLength(0);

    const completed = await prepareCompletedCanary(undefined, {
      acquisitionTargetSuffix: '-activation-channel',
    });
    const reviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: completed.staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    recordCapabilityOwnerVerdict({
      token: reviewToken,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    const activation = stageCapabilityActivation({
      runId: completed.staged.run.runId,
      ...productionHeads(completed.staged.run.runId),
      binding: fixtureBinding,
      now: new Date(NOW.getTime() + 9_000),
    });
    expect(
      approveCognitiveApprovalPacketCAS({
        approvalPacketId: activation.approval.approvalPacketId,
        groupFolder: 'main',
        expectedSummary: activation.approval.summary,
        expectedApprovalVersion: activation.approval.approvalVersion || 1,
        expectedScopeDigest: activation.approval.scopeDigest || null,
        now: new Date(NOW.getTime() + 10_000).toISOString(),
        approvalChannel: 'telegram',
      }).status,
    ).toBe('not_found_or_scope_mismatch');
    expect(() =>
      authorizeApprovedCapabilityActivation({
        runId: completed.staged.run.runId,
        ...productionHeads(completed.staged.run.runId),
        binding: fixtureBinding,
        workerId: 'wrong-channel-activation',
        now: new Date(NOW.getTime() + 11_000),
      }),
    ).toThrow(/exact capability approval packet/i);
  });

  it('joins canary, execution, owner review, and separate activation authority', async () => {
    const acquisition = await ownerReviewRequiredAcquisition();
    seedHealth();
    const values = { key: 'alpha', targetScopeKey: 'fixture-target' };
    const binding = {
      ownerId: 'owner',
      chatId: 'cockpit',
      groupId: 'main',
      channel: 'owner_cockpit',
      targetScopeKey: 'fixture-target',
    };
    upsertToolReliabilitySubject({
      subjectId: 'foreign-production-subject',
      subjectKind: 'capability',
      displayName: 'Foreign production fixture',
      aliasesJson: '["foreign.production.resource"]',
      riskLevel: 'low',
      approvalRequirement: 'none',
      channelsJson: '["owner_cockpit"]',
      sourceRefsJson: '["fixture:foreign-health"]',
      privacyJson: '{}',
    });
    upsertReliabilityObservation({
      observationId: 'foreign-production-health-1',
      subjectId: 'foreign-production-subject',
      observedAt: new Date(NOW.getTime() + 2_000).toISOString(),
      sourceKind: 'verified_usage',
      outcome: 'success',
      failureClass: 'none',
      confidence: 1,
      fallbackUsed: false,
      latencyMs: 1,
      summary: 'Foreign fixture is healthy.',
      nextAction: 'Do not borrow this proof.',
      evidenceIdsJson: '[]',
      privacyJson: '{}',
    });
    expect(() =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        binding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: values,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'foreign-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      }),
    ).toThrow(/fresh successful health proof/i);
    expect(() =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        binding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: values,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 40 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      }),
    ).toThrow(/fresh successful health proof/i);
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: values,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(staged.run.status).toBe('awaiting_canary_approval');
    expect(staged.approval.summary.length).toBeLessThanOrEqual(640);
    expect(staged.approval.summary).toMatch(/exact=[a-f0-9]{64}$/);
    expect(staged.approval.summary).toContain(
      'steps=step-1=lookup>r1[local_lookup]',
    );
    expect(staged.approval.summary).toContain(
      'res=r1=fixture.production.resource@fixture-production-v1[execution_adapter|required]',
    );
    expect(staged.approval.summary).toContain(
      'post=1:"fixture production value is verified"',
    );
    expect(staged.approval.summary).toContain('egress:local_only');
    expect(staged.approval.summary).toContain('creds:none');
    expect(staged.approval.summary).toContain('rollback:none');
    expect(staged.approval.summary).toContain('cost:$0');
    expect(staged.approval.summary).toContain('risk:low');
    expect(staged.approval.summary).toContain('authority=canary-only');
    expect(staged.approval.summary).toMatch(/target=[a-f0-9]{12}/);
    expect(() =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion - 1,
        binding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: values,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      }),
    ).toThrow(/acquisition head changed/i);
    expect(getCapabilityAcquisition(acquisition.acquisitionId)?.state).toBe(
      'owner_review_required',
    );
    approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
    expect(() =>
      authorizeApprovedCapabilityCanary({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        expectedRunRevision: staged.run.revision - 1,
        binding,
        workerId: 'stale-fixture-worker',
        now: new Date(NOW.getTime() + 5_000),
      }),
    ).toThrow(/head or authorized surface changed/i);
    const authorized = authorizeApprovedCapabilityCanary({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      workerId: 'fixture-worker',
      now: new Date(NOW.getTime() + 5_000),
    });
    expect(authorized.acquisition.state).toBe('canary_ready');
    const productionRegistry =
      createIsolatedProductionCapabilityRegistryForTest({
        executors: [
          {
            bindingId: EXECUTOR_ID,
            operationId: 'lookup',
            resourceId: resource().resourceId,
            version: RESOURCE_VERSION,
            executorImplementationDigest: EXECUTOR_DIGEST,
            actionClass: 'local_lookup',
            effectClass: 'read_only',
            networkAccess: 'none',
            maximumCostUsd: 0,
            async execute({ values: actual }) {
              return {
                result: { value: `fixture:${String(actual.key)}` },
                evidenceRefs: ['fixture:production-read'],
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
            resourceId: resource().resourceId,
            version: RESOURCE_VERSION,
            evaluatorImplementationDigest: EVALUATOR_DIGEST,
            async verify({ requiredPostconditions }) {
              return {
                verified: true,
                evidenceRefs: ['fixture:production-verifier'],
                verifiedPostconditions: requiredPostconditions,
                postconditionFingerprint: '6'.repeat(64),
                reason: 'Production fixture agrees with the expected value.',
              };
            },
          },
        ],
      });
    await expect(
      runCapabilityProductionExecution({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        expectedRunRevision:
          productionHeads(staged.run.runId).expectedRunRevision - 1,
        binding,
        workerId: 'stale-execution-worker',
        values,
        registry: productionRegistry,
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/input does not match|head/i);
    const execution = await runCapabilityProductionExecution({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      workerId: 'fixture-execution-worker',
      values,
      registry: productionRegistry,
      now: new Date(NOW.getTime() + 6_000),
    });
    expect(execution.status).toBe('verified');
    expect(getCapabilityProductionRun(staged.run.runId)?.status).toBe(
      'awaiting_owner_review',
    );
    expect(getCapabilityAcquisition(acquisition.acquisitionId)?.state).toBe(
      'canary_ready',
    );
    const reviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    const reviewed = recordCapabilityOwnerVerdict({
      token: reviewToken,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    expect(reviewed.run.status).toBe('owner_reviewed');
    expect(reviewed.acquisition.state).toBe('canary_ready');
    expect(() =>
      stageCapabilityActivation({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        expectedRunRevision:
          productionHeads(staged.run.runId).expectedRunRevision - 1,
        binding,
        now: new Date(NOW.getTime() + 9_000),
      }),
    ).toThrow(/not eligible/i);
    const activation = stageCapabilityActivation({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      now: new Date(NOW.getTime() + 9_000),
    });
    expect(activation.run.status).toBe('awaiting_activation_approval');
    expect(activation.approval.summary.length).toBeLessThanOrEqual(640);
    expect(activation.approval.summary).toMatch(/exact=[a-f0-9]{64}$/);
    expect(activation.approval.summary).toContain('ACTIVATE;steps=');
    expect(activation.approval.summary).toContain(
      'steps=step-1=lookup>r1[local_lookup]',
    );
    expect(activation.approval.summary).toContain('post=1:');
    expect(activation.approval.summary).toContain('creds:none');
    expect(activation.approval.summary).toContain(
      'authority=reuse-only/no-new-actions',
    );
    approve(
      activation.approval,
      new Date(NOW.getTime() + 10_000).toISOString(),
    );
    expect(() =>
      authorizeApprovedCapabilityActivation({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        authorizedSurface: 'telegram',
        binding,
        workerId: 'wrong-surface-worker',
        now: new Date(NOW.getTime() + 11_000),
      }),
    ).toThrow(/head or authorized surface changed/i);
    const activated = authorizeApprovedCapabilityActivation({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      workerId: 'fixture-activation-worker',
      now: new Date(NOW.getTime() + 11_000),
    });
    expect(activated.acquisition.state).toBe('active');
    expect(activated.run.status).toBe('active');
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const activeContract = JSON.parse(
      activated.acquisition.candidateContractJson,
    ) as {
      taskFamily: string;
      triggerSemantics: string[];
      successPostconditions: string[];
    };
    expect(() =>
      assertCapabilityCandidateContract({
        ...JSON.parse(activated.acquisition.candidateContractJson),
        successPostconditions: Array.from(
          { length: 13 },
          (_, index) => `bounded postcondition ${index}`,
        ),
      }),
    ).toThrow(/bounded non-empty string set/i);
    const exactMatch = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: activeContract.taskFamily,
      triggerText: activeContract.triggerSemantics[0],
      inputs: values,
      intendedPostconditions: activeContract.successPostconditions,
      binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(exactMatch.status).toBe('matched');
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: activeContract.taskFamily,
        triggerText: activeContract.triggerSemantics[0],
        inputs: values,
        intendedPostconditions: [
          ...activeContract.successPostconditions,
          'an additional unverified postcondition',
        ],
        binding,
        currentResourceVersions,
        now: new Date(NOW.getTime() + 12_000),
      }).status,
    ).toBe('none');
    const widenedBinding = { ...binding, ownerId: 'different-owner' };
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: activeContract.taskFamily,
        triggerText: activeContract.triggerSemantics[0],
        inputs: values,
        intendedPostconditions: activeContract.successPostconditions,
        binding: widenedBinding,
        currentResourceVersions,
        now: new Date(NOW.getTime() + 12_000),
      }).status,
    ).toBe('none');
    expect(() =>
      stageActiveCapabilityReuse({
        match: exactMatch,
        taskFamily: activeContract.taskFamily,
        triggerText: activeContract.triggerSemantics[0],
        intendedPostconditions: activeContract.successPostconditions,
        binding: widenedBinding,
        normalizedInputs: values,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: 'widened-reuse-worker',
        now: new Date(NOW.getTime() + 12_000),
      }),
    ).toThrow(/active capability changed/i);
    expect(
      listCapabilityProductionTransitionReceipts({
        runId: staged.run.runId,
      }).map((receipt) => receipt.transitionKind),
    ).toEqual([
      'canary_authorized',
      'canary_completed',
      'owner_reviewed',
      'activated',
    ]);
  });

  it('rolls back a failed canary authorization so its exact approval can be retried once', async () => {
    const acquisition = await ownerReviewRequiredAcquisition(
      '-atomic-canary-authorization',
    );
    seedHealth();
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: fixtureBinding.channel,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
    let failedAtLeaseBoundary = false;
    _setDurableContinuityTestHook(({ boundary, workId }) => {
      if (
        boundary === 'after_lease_acquisition' &&
        workId === staged.run.workId
      ) {
        failedAtLeaseBoundary = true;
        throw new Error('simulated atomic canary authorization loss');
      }
    });
    expect(() =>
      authorizeApprovedCapabilityCanary({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        binding: fixtureBinding,
        workerId: 'atomic-canary-failure-worker',
        now: new Date(NOW.getTime() + 5_000),
      }),
    ).toThrow(/atomic canary authorization loss/i);
    _setDurableContinuityTestHook(null);
    expect(failedAtLeaseBoundary).toBe(true);
    expect(
      listDurableResumeGrants({ workId: staged.run.workId, limit: 100 }),
    ).toHaveLength(0);
    expect(getCapabilityProductionRun(staged.run.runId)).toMatchObject({
      status: 'awaiting_canary_approval',
      canaryGrantId: null,
      canaryLeaseId: null,
    });
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).find(
        (packet) =>
          packet.approvalPacketId === staged.approval.approvalPacketId,
      )?.status,
    ).toBe('approved');

    const retried = authorizeApprovedCapabilityCanary({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding: fixtureBinding,
      workerId: 'atomic-canary-retry-worker',
      now: new Date(NOW.getTime() + 6_000),
    });
    expect(retried.run.status).toBe('canary_ready');
    expect(
      listDurableResumeGrants({ workId: staged.run.workId, limit: 100 }),
    ).toHaveLength(1);
  });

  it('burns a persisted stale canary authorization and requires a newly staged approval', async () => {
    const acquisition = await ownerReviewRequiredAcquisition(
      '-burn-stale-canary-authorization',
    );
    seedHealth();
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: fixtureBinding.channel,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
    const packet = listCognitiveApprovalPackets({
      groupFolder: 'main',
      limit: 500,
    }).find(
      (candidate) =>
        candidate.approvalPacketId === staged.approval.approvalPacketId,
    );
    expect(packet?.status).toBe('approved');
    const issued = issueDurableResumeGrant({
      workId: staged.run.workId,
      binding: fixtureBinding,
      actionClass: 'operator_change',
      approvalPacketId: packet!.approvalPacketId,
      approvalVersion: packet!.approvalVersion,
      now: new Date(NOW.getTime() + 5_000),
    });
    const consumed = consumeResumeGrantAndAcquireLease({
      token: issued.token,
      binding: fixtureBinding,
      actionClass: 'operator_change',
      workerId: 'stale-canary-authority-worker',
      now: new Date(NOW.getTime() + 5_000),
    });
    expect(consumed.status).toBe('consumed');
    const work = getDurableWorkUnit(staged.run.workId)!;
    const run = getCapabilityProductionRun(staged.run.runId)!;
    expect(
      updateCapabilityProductionRunCAS({
        expectedRevision: run.revision,
        next: {
          ...run,
          updatedAt: new Date(NOW.getTime() + 5_000).toISOString(),
          revision: run.revision + 1,
          workVersion: work.version,
          planVersion: work.planVersion,
          checkpointId: work.checkpointHeadId!,
          canaryApprovalVersion: packet!.approvalVersion || null,
          canaryApprovalScopeDigest: packet!.scopeDigest || null,
          canaryGrantId: issued.grant.grantId,
          canaryLeaseId: consumed.lease!.leaseId,
          nextSafeAction: 'Reconcile the exact persisted canary authority.',
        },
      }),
    ).toBe('applied');
    releaseDurableLease({
      leaseId: consumed.lease!.leaseId,
      processGeneration: consumed.lease!.processGeneration,
      now: new Date(NOW.getTime() + 5_500),
    });

    expect(() =>
      authorizeApprovedCapabilityCanary({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        binding: fixtureBinding,
        workerId: 'stale-canary-recovery-worker',
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).toThrow(/was burned.*restage/i);
    expect(getCapabilityProductionRun(staged.run.runId)).toMatchObject({
      status: 'blocked',
      canaryApprovalPacketId: null,
      canaryGrantId: null,
      canaryLeaseId: null,
      nextSafeAction: expect.stringMatching(/restage a fresh bounded canary/i),
    });
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).find(
        (candidate) => candidate.approvalPacketId === packet!.approvalPacketId,
      )?.status,
    ).toBe('expired');

    const restaged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: fixtureBinding.channel,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 7_000),
    });
    expect(restaged.run.runId).not.toBe(staged.run.runId);
    expect(restaged.approval.approvalPacketId).not.toBe(
      packet!.approvalPacketId,
    );
  });

  it('does not treat a merely helpful verdict as activation evidence', async () => {
    const acquisition = await ownerReviewRequiredAcquisition();
    seedHealth();
    const values = { key: 'alpha', targetScopeKey: 'fixture-target' };
    const binding = {
      ownerId: 'owner',
      chatId: 'cockpit',
      groupId: 'main',
      channel: 'owner_cockpit',
      targetScopeKey: 'fixture-target',
    };
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: values,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
    authorizeApprovedCapabilityCanary({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      workerId: 'fixture-worker',
      now: new Date(NOW.getTime() + 5_000),
    });
    const initiallyAuthorized = getCapabilityProductionRun(staged.run.runId);
    expect(initiallyAuthorized?.canaryLeaseId).toBeTruthy();
    const registry = createIsolatedProductionCapabilityRegistryForTest({
      executors: [
        {
          bindingId: EXECUTOR_ID,
          operationId: 'lookup',
          resourceId: resource().resourceId,
          version: RESOURCE_VERSION,
          executorImplementationDigest: EXECUTOR_DIGEST,
          actionClass: 'local_lookup',
          effectClass: 'read_only',
          networkAccess: 'none',
          maximumCostUsd: 0,
          async execute() {
            return {
              result: { value: 'fixture:alpha' },
              evidenceRefs: ['fixture:production-read'],
              effectClass: 'read_only',
              effectStatus: 'none',
              preStateFingerprint: '4'.repeat(64),
              postStateFingerprint: '5'.repeat(64),
            };
          },
        },
      ],
      evaluators: [
        {
          evaluatorId: EVALUATOR_ID,
          operationId: 'lookup',
          resourceId: resource().resourceId,
          version: RESOURCE_VERSION,
          evaluatorImplementationDigest: EVALUATOR_DIGEST,
          async verify({ requiredPostconditions }) {
            return {
              verified: true,
              evidenceRefs: ['fixture:production-verifier'],
              verifiedPostconditions: requiredPostconditions,
              postconditionFingerprint: '6'.repeat(64),
              reason: 'verified',
            };
          },
        },
      ],
    });
    await runCapabilityProductionExecution({
      runId: staged.run.runId,
      ...productionHeads(staged.run.runId),
      binding,
      workerId: 'fixture-execution-worker',
      values,
      registry,
      now: new Date(NOW.getTime() + 66_000),
    });
    const executedAfterLeaseRefresh = getCapabilityProductionRun(
      staged.run.runId,
    );
    expect(executedAfterLeaseRefresh?.executionLeaseId).toBeTruthy();
    expect(executedAfterLeaseRefresh?.executionLeaseId).not.toBe(
      initiallyAuthorized?.canaryLeaseId,
    );
    const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: staged.run.runId,
      now: new Date(NOW.getTime() + 67_000),
    });
    const reviewed = recordCapabilityOwnerVerdict({
      token,
      verdict: 'helpful',
      now: new Date(NOW.getTime() + 68_000),
    });
    expect(reviewed.acquisition.state).toBe('canary_ready');
    expect(() =>
      stageCapabilityActivation({
        runId: staged.run.runId,
        ...productionHeads(staged.run.runId),
        binding,
        now: new Date(NOW.getTime() + 69_000),
      }),
    ).toThrow(/verified exact owner verdict/i);
  });

  it('keeps private inputs, paths, and credentials out of reviewable approval text', async () => {
    const acquisition = await ownerReviewRequiredAcquisition('-private-input');
    seedHealth();
    const privateTarget = '/Users/owner/private/research';
    const privateKey = ['BSA', 'reviewability-secret-123456'].join('-');
    const binding = {
      ...fixtureBinding,
      targetScopeKey: privateTarget,
    };
    const staged = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: {
        key: privateKey,
        targetScopeKey: privateTarget,
      },
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    expect(staged.approval.summary.length).toBeLessThanOrEqual(640);
    expect(staged.approval.summary).toMatch(/exact=[a-f0-9]{64}$/);
    expect(staged.approval.summary).toMatch(/target=[a-f0-9]{12}/);
    expect(staged.approval.summary).not.toContain(privateKey);
    expect(staged.approval.summary).not.toContain('BSA-');
    expect(staged.approval.summary).not.toContain(privateTarget);
    expect(staged.approval.summary).not.toContain('/Users/');

    const contract = JSON.parse(
      acquisition.candidateContractJson,
    ) as CapabilityCandidateContract;
    const privatePaths = [
      '/Volumes/private/item',
      '/mnt/private/item',
      '/srv/private/item',
      '/root/private/item',
      '~/private/item',
      String.raw`\\server\share\private\item`,
      '../private/item',
      'private/item',
    ];
    const rendered = _renderProductionApprovalSummaryForTest({
      decision: 'canary',
      acquisition,
      contract: {
        ...contract,
        successPostconditions: [
          `private material remains absent: ${privatePaths.join(' ')}`,
        ],
      },
      contractDigest: 'a'.repeat(64),
      scopeDigest: 'b'.repeat(64),
      inputDigest: 'c'.repeat(64),
      targetDigest: 'd'.repeat(64),
    });
    for (const privatePath of privatePaths) {
      expect(rendered).not.toContain(privatePath);
    }
    expect(rendered).toContain('[redacted-path]');
  });

  it('renders every protected step literally or fails closed at the review bound', async () => {
    const acquisition = await ownerReviewRequiredAcquisition('-multi-step');
    const base = JSON.parse(
      acquisition.candidateContractJson,
    ) as CapabilityCandidateContract;
    const first = {
      ...base.steps[0],
      actionClass: 'repository_write' as const,
      approvalRequired: true,
    };
    const second = {
      ...first,
      stepId: 'step-2',
      operationId: 'archive',
      resourceId: 'fixture.production.archive',
      bindingId: 'fixture.production.archive',
      evaluatorId: 'fixture.production.archive.verify',
    };
    const contract: CapabilityCandidateContract = {
      ...base,
      steps: [first, second],
      resourceBindings: [
        ...base.resourceBindings,
        {
          resourceId: second.resourceId,
          bindingKind: 'execution_adapter',
          version: second.version,
          required: true,
        },
      ],
    };
    const summary = _renderProductionApprovalSummaryForTest({
      decision: 'canary',
      acquisition,
      contract,
      contractDigest: 'a'.repeat(64),
      scopeDigest: 'b'.repeat(64),
      inputDigest: 'c'.repeat(64),
      targetDigest: '1'.repeat(64),
    });
    expect(summary.length).toBeLessThanOrEqual(640);
    expect(summary).toContain('r1=fixture.production.resource@');
    expect(summary).toContain('r2=fixture.production.archive@');
    expect(summary).toContain('step-1=lookup>r1[repository_write]');
    expect(summary).toContain('step-2=archive>r2[repository_write]');
    for (const postcondition of contract.successPostconditions) {
      expect(summary).toContain(postcondition);
    }
    expect(summary).toMatch(/exact=[a-f0-9]{64}$/);

    const oversized: CapabilityCandidateContract = {
      ...contract,
      steps: Array.from({ length: 12 }, (_, index) => ({
        ...second,
        stepId: `step-${index + 1}`,
        operationId: `archive-${index + 1}`,
        resourceId: `fixture.production.archive-${index + 1}`,
        bindingId: `fixture.production.archive-${index + 1}`,
        evaluatorId: `fixture.production.archive-${index + 1}.verify`,
      })),
    };
    expect(() =>
      _renderProductionApprovalSummaryForTest({
        decision: 'canary',
        acquisition,
        contract: oversized,
        contractDigest: 'd'.repeat(64),
        scopeDigest: 'e'.repeat(64),
        inputDigest: 'f'.repeat(64),
        targetDigest: '2'.repeat(64),
      }),
    ).toThrow(/reviewable bound/i);
  });

  it('requires provenance-complete dependency health', async () => {
    const acquisition = await ownerReviewRequiredAcquisition();
    seedHealth();
    const attempt = (observationId: string) =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        binding: fixtureBinding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId,
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      });
    for (const observation of [
      {
        observationId: 'health-synthetic',
        sourceKind: 'simulation' as const,
        confidence: 1,
        fallbackUsed: false,
      },
      {
        observationId: 'health-low-confidence',
        sourceKind: 'verified_usage' as const,
        confidence: 0.99,
        fallbackUsed: false,
      },
      {
        observationId: 'health-fallback',
        sourceKind: 'verified_usage' as const,
        confidence: 1,
        fallbackUsed: true,
      },
    ]) {
      upsertReliabilityObservation({
        observationId: observation.observationId,
        subjectId: 'fixture-production-subject',
        observedAt: new Date(NOW.getTime() + 2_500).toISOString(),
        sourceKind: observation.sourceKind,
        outcome: 'success',
        failureClass: 'none',
        confidence: observation.confidence,
        fallbackUsed: observation.fallbackUsed,
        latencyMs: 1,
        summary: 'This proof must not authorize production.',
        nextAction: 'Require exact verified usage.',
        evidenceIdsJson: '[]',
        privacyJson: '{}',
      });
      expect(() => attempt(observation.observationId)).toThrow(
        /fresh successful health proof/i,
      );
    }
  });

  it('recovers a completed checkpoint without replaying its effect or requiring an existing outcome', async () => {
    const counter = { executions: 0 };
    const prepared = await prepareAuthorizedCanary();
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_checkpoint_before_outcome') {
        throw new Error('simulated restart');
      }
    });
    await expect(
      runCapabilityProductionExecution({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: prepared.binding,
        workerId: 'checkpoint-crash-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);
    expect(counter.executions).toBe(1);
    expect(
      getOutcomeBySource(
        'main',
        'capability_acquisition',
        prepared.staged.run.runId,
      ),
    ).toBeUndefined();
    expect(
      getDurableWorkUnit(
        getCapabilityProductionRun(prepared.staged.run.runId)!.workId,
      )?.status,
    ).toBe('completed');

    const recovered = await recoverCapabilityProductionRun({
      runId: prepared.staged.run.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'restart-recovery-worker',
      registry: liveRegistry(counter),
      now: new Date(NOW.getTime() + 7_000),
      clock: () => new Date(NOW.getTime() + 7_000),
    });
    expect(recovered.status).toBe('verified');
    expect(counter.executions).toBe(1);
    expect(
      getOutcomeBySource(
        'main',
        'capability_acquisition',
        prepared.staged.run.runId,
      )?.status,
    ).toBe('completed');
    expect(
      listCapabilityProductionTransitionReceipts({
        runId: prepared.staged.run.runId,
      }).filter((receipt) => receipt.transitionKind === 'canary_completed'),
    ).toHaveLength(1);
  });

  it('joins simultaneous terminal recovery without double-counting or failing the original caller', async () => {
    const counter = { executions: 0 };
    const prepared = await prepareAuthorizedCanary();
    let releaseOriginal!: () => void;
    let markCheckpointReached!: () => void;
    const originalMayContinue = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    const checkpointReached = new Promise<void>((resolve) => {
      markCheckpointReached = resolve;
    });
    _setProductionCapabilityApprenticeshipTestHook(async (event) => {
      if (event.boundary === 'after_checkpoint_before_outcome') {
        markCheckpointReached();
        await originalMayContinue;
      }
    });

    const originalPromise = runCapabilityProductionExecution({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      workerId: 'simultaneous-terminal-original-worker',
      values: fixtureValues,
      registry: liveRegistry(counter, { providerCalls: 2, costUsd: 0 }),
      now: new Date(NOW.getTime() + 6_000),
    });
    await checkpointReached;

    const recoverySettlement = await recoverCapabilityProductionRun({
      runId: prepared.staged.run.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'simultaneous-terminal-recovery-worker',
      registry: liveRegistry(counter),
      now: new Date(NOW.getTime() + 7_000),
      clock: () => new Date(NOW.getTime() + 7_000),
    })
      .then(
        (result) => ({ status: 'fulfilled' as const, result }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => releaseOriginal());
    const original = await originalPromise;
    if (recoverySettlement.status === 'rejected') {
      throw recoverySettlement.error;
    }

    expect(recoverySettlement.result.status).toBe('verified');
    expect(original.status).toBe('verified');
    expect(counter.executions).toBe(1);
    const finalRun = getCapabilityProductionRun(prepared.staged.run.runId)!;
    expect(finalRun).toMatchObject({
      status: 'awaiting_owner_review',
      executionCalls: 1,
      evaluatorCalls: 1,
      providerCalls: 2,
      costUsd: 0,
    });
    expect(
      listCapabilityProductionTransitionReceipts({
        runId: finalRun.runId,
      }).filter((receipt) => receipt.transitionKind === 'canary_completed'),
    ).toHaveLength(1);
    const terminalOutcome = getOutcomeBySource(
      'main',
      'capability_acquisition',
      finalRun.runId,
    );
    expect(terminalOutcome?.status).toBe('completed');
    expect(Date.parse(terminalOutcome!.updatedAt)).toBeGreaterThanOrEqual(
      NOW.getTime() + 7_000,
    );
  });

  it('recovers succeeded receipts before checkpoint commit without replaying the effect', async () => {
    const counter = { executions: 0 };
    const prepared = await prepareAuthorizedCanary();
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_receipts_before_checkpoint') {
        throw new Error('simulated restart before checkpoint');
      }
    });
    await expect(
      runCapabilityProductionExecution({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: prepared.binding,
        workerId: 'receipt-crash-worker',
        values: fixtureValues,
        registry: liveRegistry(counter, { providerCalls: 2, costUsd: 0 }),
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);

    const crashedRun = getCapabilityProductionRun(prepared.staged.run.runId)!;
    expect(counter.executions).toBe(1);
    expect(getDurableWorkUnit(crashedRun.workId)?.status).toBe('executing');
    expect(
      getOutcomeBySource('main', 'capability_acquisition', crashedRun.runId),
    ).toBeUndefined();

    const recovered = await recoverCapabilityProductionRun({
      runId: crashedRun.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'receipt-recovery-worker',
      registry: liveRegistry(counter),
      now: new Date(NOW.getTime() + 31 * 60_000),
      clock: () => new Date(NOW.getTime() + 31 * 60_000),
    });
    expect(recovered.status).toBe('verified');
    expect(counter.executions).toBe(1);
    expect(recovered.providerCalls).toBe(2);
    expect(recovered.costUsd).toBe(0);
    expect(getDurableWorkUnit(crashedRun.workId)?.status).toBe('completed');
    expect(
      getOutcomeBySource('main', 'capability_acquisition', crashedRun.runId)
        ?.status,
    ).toBe('completed');
  });

  it('recovers an unresolved effect after run and health expiry using only an exact evaluator lease', async () => {
    const counter = { executions: 0 };
    const prepared = await prepareAuthorizedCanary();
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_effect_before_outcome') {
        throw new Error('simulated restart after the effect began');
      }
    });
    await expect(
      runCapabilityProductionExecution({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: prepared.binding,
        workerId: 'expired-effect-crash-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);
    expect(counter.executions).toBe(1);

    upsertReliabilityObservation({
      observationId: 'fixture-production-health-later-failure',
      subjectId: 'fixture-production-subject',
      observedAt: new Date(NOW.getTime() + 25 * 60_000).toISOString(),
      sourceKind: 'verified_usage',
      outcome: 'failed',
      failureClass: 'transport',
      confidence: 1,
      fallbackUsed: false,
      latencyMs: 1,
      summary: 'A later failure must not authorize or erase the past effect.',
      nextAction: 'Use only verification-only recovery.',
      evidenceIdsJson: '[]',
      privacyJson: '{}',
    });

    const inconclusive = await recoverCapabilityProductionRun({
      runId: prepared.staged.run.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'expired-effect-indeterminate-worker',
      registry: liveRegistry(counter, { recoveryVerified: false }),
      now: new Date(NOW.getTime() + 31 * 60_000),
      clock: () => new Date(NOW.getTime() + 31 * 60_000),
    });
    expect(inconclusive.status).toBe('indeterminate');
    expect(inconclusive.reason).toMatch(/no executor was replayed/i);
    expect(counter.executions).toBe(1);

    const recovered = await recoverCapabilityProductionRun({
      runId: prepared.staged.run.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'expired-effect-verification-worker',
      registry: liveRegistry(counter),
      now: new Date(NOW.getTime() + 32 * 60_000),
      clock: () => new Date(NOW.getTime() + 32 * 60_000),
    });
    expect(recovered.status).toBe('verified');
    expect(counter.executions).toBe(1);
    expect(
      getDurableWorkUnit(getCapabilityProductionRun(recovered.runId)!.workId)
        ?.status,
    ).toBe('completed');
  });

  it('fails closed and reconciles when recovery verification crosses its lease expiry', async () => {
    const counter = { executions: 0 };
    const prepared = await prepareAuthorizedCanary();
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_effect_before_outcome') {
        throw new Error('simulated restart after the effect began');
      }
    });
    await expect(
      runCapabilityProductionExecution({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: prepared.binding,
        workerId: 'lease-expiry-effect-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);
    expect(counter.executions).toBe(1);

    const recoveryStartedAt = new Date(NOW.getTime() + 31 * 60_000);
    const unrelated = await prepareAuthorizedCanary({
      acquisitionTargetSuffix: ' for unrelated lease isolation',
    });
    reconcileDurableWorkOnStartup({ now: recoveryStartedAt });
    const unrelatedGrant = issueDurableResumeGrant({
      workId: unrelated.staged.run.workId,
      binding: unrelated.binding,
      actionClass: 'local_lookup',
      now: recoveryStartedAt,
    });
    const unrelatedLease = consumeResumeGrantAndAcquireLease({
      token: unrelatedGrant.token,
      binding: unrelated.binding,
      actionClass: 'local_lookup',
      workerId: 'unrelated-lease-worker',
      now: recoveryStartedAt,
    });
    expect(unrelatedLease.status).toBe('consumed');
    expect(unrelatedLease.lease).toBeDefined();

    let recoveryClock = recoveryStartedAt;
    await expect(
      recoverCapabilityProductionRun({
        runId: prepared.staged.run.runId,
        values: fixtureValues,
        binding: prepared.binding,
        workerId: 'lease-expiry-recovery-worker',
        registry: liveRegistry(counter, {
          afterRecoveryRead: () => {
            recoveryClock = new Date(recoveryStartedAt.getTime() + 61_000);
          },
        }),
        now: recoveryStartedAt,
        clock: () => recoveryClock,
      }),
    ).rejects.toThrow(/active bound lease generation/i);

    const failedRun = getCapabilityProductionRun(prepared.staged.run.runId)!;
    const failedWork = getDurableWorkUnit(failedRun.workId)!;
    expect(counter.executions).toBe(1);
    expect(failedRun.executionLeaseId).toEqual(expect.any(String));
    expect(getDurableWorkLease(failedRun.executionLeaseId!)?.status).toBe(
      'expired',
    );
    expect(failedWork.leaseId).toBeNull();
    expect(failedWork.status).toBe('verifying');
    expect(getDurableWorkLease(unrelatedLease.lease!.leaseId)?.status).toBe(
      'active',
    );
    expect(getDurableWorkUnit(unrelated.staged.run.workId)?.leaseId).toBe(
      unrelatedLease.lease!.leaseId,
    );
    expect(
      listDurableEffectReceipts({ workId: failedRun.workId }).filter(
        (receipt) =>
          JSON.parse(receipt.metadataJson).receiptClass ===
          'capability_production_recovery',
      ),
    ).toHaveLength(0);
    expect(
      getOutcomeBySource('main', 'capability_acquisition', failedRun.runId),
    ).toBeUndefined();

    const safeRetryAt = new Date(recoveryClock.getTime() + 1_000);
    const recovered = await recoverCapabilityProductionRun({
      runId: failedRun.runId,
      values: fixtureValues,
      binding: prepared.binding,
      workerId: 'lease-expiry-safe-retry-worker',
      registry: liveRegistry(counter),
      now: safeRetryAt,
      clock: () => safeRetryAt,
    });
    expect(recovered.status).toBe('verified');
    expect(recovered.reason).toMatch(/without replay/i);
    expect(counter.executions).toBe(1);
    expect(
      getOutcomeBySource('main', 'capability_acquisition', failedRun.runId)
        ?.status,
    ).toBe('completed');
  });

  it('retries the consumed owner-review token after a review/reconcile crash exactly once', async () => {
    const prepared = await prepareCompletedCanary();
    const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: prepared.staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_owner_review_before_reconcile') {
        throw new Error('simulated restart');
      }
    });
    expect(() =>
      recordCapabilityOwnerVerdict({
        token,
        verdict: 'verified',
        now: new Date(NOW.getTime() + 8_000),
      }),
    ).toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);

    const reconciled = recordCapabilityOwnerVerdict({
      token,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 9_000),
    });
    expect(reconciled.run.status).toBe('owner_reviewed');
    expect(
      getCapabilityOwnerReviewForRun(prepared.staged.run.runId)?.revision,
    ).toBe(1);
    expect(
      listCapabilityProductionTransitionReceipts({
        runId: prepared.staged.run.runId,
      }).filter((receipt) => receipt.transitionKind === 'owner_reviewed'),
    ).toHaveLength(1);
  });

  it('requires the exact source message bound into a trusted review token', async () => {
    const prepared = await prepareCompletedCanary();
    const run = getCapabilityProductionRun(prepared.staged.run.runId)!;
    const acquisition = getCapabilityAcquisition(run.acquisitionId)!;
    const tokenHash = 'a'.repeat(64);
    const expectedMessageHash = durableScopeHash(
      'owner-review-message',
      'message-exact',
    );
    insertCapabilityOwnerActionToken({
      tokenHash,
      actionKind: 'review_canary',
      acquisitionId: acquisition.acquisitionId,
      runId: run.runId,
      candidateFingerprint: run.candidateFingerprint,
      contractVersion: run.contractVersion,
      expectedAcquisitionVersion: acquisition.recordVersion,
      expectedRunRevision: run.revision,
      ownerScopeHash: run.ownerScopeHash,
      chatScopeHash: run.chatScopeHash,
      groupScopeHash: run.groupScopeHash,
      channel: run.channel,
      authorizedSurface: run.authorizedSurface,
      messageHash: expectedMessageHash,
      createdAt: new Date(NOW.getTime() + 7_000).toISOString(),
      expiresAt: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      consumedAt: null,
      privacyJson: '{}',
    });
    expect(() =>
      recordCapabilityOwnerReviewWithToken({
        tokenHash,
        verdict: 'verified',
        sourceMessageHash: durableScopeHash(
          'owner-review-message',
          'message-other',
        ),
        now: new Date(NOW.getTime() + 8_000).toISOString(),
      }),
    ).toThrow(/message does not match/i);
    expect(
      recordCapabilityOwnerReviewWithToken({
        tokenHash,
        verdict: 'verified',
        sourceMessageHash: expectedMessageHash,
        now: new Date(NOW.getTime() + 8_000).toISOString(),
      }).revision,
    ).toBe(1);
  });

  it('keeps completed evidence reviewable after 30 minutes and activates only with refreshed health and approval', async () => {
    const prepared = await prepareCompletedCanary();
    const lateReviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: prepared.staged.run.runId,
      now: new Date(NOW.getTime() + 31 * 60_000),
    });
    const reviewed = recordCapabilityOwnerVerdict({
      token: lateReviewToken,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 31 * 60_000 + 1_000),
    });
    expect(reviewed.run.status).toBe('owner_reviewed');
    upsertReliabilityObservation({
      observationId: 'fixture-production-health-refreshed',
      subjectId: 'fixture-production-subject',
      observedAt: new Date(NOW.getTime() + 31 * 60_000 + 2_000).toISOString(),
      sourceKind: 'verified_usage',
      outcome: 'success',
      failureClass: 'none',
      confidence: 1,
      fallbackUsed: false,
      latencyMs: 1,
      summary: 'Fixture resource was freshly verified for activation.',
      nextAction: 'Bind only this exact activation decision.',
      evidenceIdsJson: '[]',
      privacyJson: '{}',
    });
    const activation = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 31 * 60_000 + 3_000),
    });
    expect(activation.run.expiresAt).toBe(
      new Date(NOW.getTime() + 61 * 60_000 + 3_000).toISOString(),
    );
    approve(
      activation.approval,
      new Date(NOW.getTime() + 31 * 60_000 + 4_000).toISOString(),
    );
    const activated = authorizeApprovedCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      workerId: 'late-activation-worker',
      now: new Date(NOW.getTime() + 31 * 60_000 + 5_000),
    });
    expect(activated.acquisition.state).toBe('active');
    const activationRun = getCapabilityProductionRun(
      prepared.staged.run.runId,
    )!;
    const activationReceipts = listDurableEffectReceipts({
      workId: activationRun.activationWorkId!,
    });
    expect(
      activationReceipts.some(
        (receipt) =>
          receipt.status === 'succeeded' &&
          receipt.actionClass === 'operator_change' &&
          receipt.effectClass === 'local_write' &&
          receipt.grantId === activationRun.activationGrantId,
      ),
    ).toBe(true);

    const originalReviewId = getCapabilityOwnerReviewForRun(
      prepared.staged.run.runId,
    )!.reviewId;
    for (const [index, verdict] of [
      'corrected',
      'corrected',
      'verified',
    ].entries()) {
      const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
        runId: prepared.staged.run.runId,
        now: new Date(NOW.getTime() + 31 * 60_000 + 6_000 + index * 2_000),
      });
      recordCapabilityOwnerVerdict({
        token,
        verdict: verdict as 'corrected' | 'verified',
        now: new Date(NOW.getTime() + 31 * 60_000 + 7_000 + index * 2_000),
      });
    }
    const finalReview = getCapabilityOwnerReviewForRun(
      prepared.staged.run.runId,
    )!;
    const finalAcquisition = getCapabilityAcquisition(
      prepared.acquisition.acquisitionId,
    )!;
    expect(finalReview.reviewId).toBe(originalReviewId);
    expect(finalReview.revision).toBe(4);
    expect(finalAcquisition.state).toBe('paused');
    expect(finalAcquisition.negativeOutcomeCount).toBe(1);
    expect(finalAcquisition.correctionCount).toBe(1);
  });

  it('counts two distinct adverse reuse reviews independently and quarantines the contract', async () => {
    const prepared = await prepareCompletedCanary();
    const canaryReviewToken = issueCapabilityReviewTokenForAuthenticatedCockpit(
      {
        runId: prepared.staged.run.runId,
        now: new Date(NOW.getTime() + 7_000),
      },
    );
    recordCapabilityOwnerVerdict({
      token: canaryReviewToken,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    const activation = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 9_000),
    });
    approve(
      activation.approval,
      new Date(NOW.getTime() + 10_000).toISOString(),
    );
    const activated = authorizeApprovedCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      workerId: 'two-negative-activation-worker',
      now: new Date(NOW.getTime() + 11_000),
    });
    const contract = JSON.parse(
      activated.acquisition.candidateContractJson,
    ) as {
      taskFamily: string;
      triggerSemantics: string[];
      successPostconditions: string[];
    };
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };

    const executeReuse = async (sequence: number) => {
      const match = matchActiveCapability({
        groupFolder: 'main',
        taskFamily: contract.taskFamily,
        triggerText: contract.triggerSemantics[0],
        inputs: fixtureValues,
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        currentResourceVersions,
        now: new Date(NOW.getTime() + (11 + sequence * 2) * 1_000),
      });
      expect(match.status).toBe('matched');
      const run = stageActiveCapabilityReuse({
        match,
        taskFamily: contract.taskFamily,
        triggerText: contract.triggerSemantics[0],
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: `two-negative-stage-${sequence}`,
        now: new Date(NOW.getTime() + (11 + sequence * 2) * 1_000),
      });
      await runCapabilityProductionExecution({
        runId: run.runId,
        ...productionHeads(run.runId),
        binding: prepared.binding,
        workerId: `two-negative-execute-${sequence}`,
        values: fixtureValues,
        registry: liveRegistry(),
        now: new Date(NOW.getTime() + (12 + sequence * 2) * 1_000),
      });
      return run.runId;
    };

    const firstRunId = await executeReuse(1);
    const secondRunId = await executeReuse(2);
    const firstToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: firstRunId,
      now: new Date(NOW.getTime() + 17_000),
    });
    const firstReview = recordCapabilityOwnerVerdict({
      token: firstToken,
      verdict: 'corrected',
      now: new Date(NOW.getTime() + 18_000),
    });
    expect(firstReview.acquisition.state).toBe('paused');
    expect(firstReview.acquisition.negativeOutcomeCount).toBe(1);

    const secondToken = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: secondRunId,
      now: new Date(NOW.getTime() + 19_000),
    });
    const secondReview = recordCapabilityOwnerVerdict({
      token: secondToken,
      verdict: 'rejected',
      now: new Date(NOW.getTime() + 20_000),
    });
    expect(secondReview.acquisition.negativeOutcomeCount).toBe(2);
    expect(secondReview.acquisition.correctionCount).toBe(1);
    expect(secondReview.acquisition.state).toBe('quarantined');
    expect(secondReview.run.status).toBe('quarantined');
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: contract.taskFamily,
        triggerText: contract.triggerSemantics[0],
        inputs: fixtureValues,
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        currentResourceVersions,
        now: new Date(NOW.getTime() + 21_000),
      }).status,
    ).toBe('none');
  });

  it('restages an expired canary approval without reusing authority', async () => {
    const acquisition = await ownerReviewRequiredAcquisition();
    seedHealth();
    const first = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 3_000),
    });
    const restagedCanary = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 16 * 60_000),
    });
    expect(restagedCanary.run.runId).not.toBe(first.run.runId);
    expect(getCapabilityProductionRun(first.run.runId)?.status).toBe('blocked');
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).find(
        (packet) => packet.approvalPacketId === first.approval.approvalPacketId,
      )?.status,
    ).toBe('expired');
  });

  it('rolls back canary work when staging crashes before the canonical run insert', async () => {
    const acquisition = await ownerReviewRequiredAcquisition();
    seedHealth();
    const priorWorkIds = new Set(
      listDurableWorkUnits({ limit: 500 }).map((work) => work.workId),
    );
    const priorApprovalIds = new Set(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).map(
        (packet) => packet.approvalPacketId,
      ),
    );
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_canary_stage_before_run') {
        throw new Error('simulated canary staging crash');
      }
    });
    expect(() =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        binding: fixtureBinding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      }),
    ).toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);

    expect(
      listDurableWorkUnits({ limit: 500 }).filter(
        (work) => !priorWorkIds.has(work.workId),
      ),
    ).toHaveLength(0);
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).filter(
        (packet) => !priorApprovalIds.has(packet.approvalPacketId),
      ),
    ).toHaveLength(0);

    const retried = stageCapabilityCanary({
      acquisitionId: acquisition.acquisitionId,
      expectedAcquisitionVersion: acquisition.recordVersion,
      binding: fixtureBinding,
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      now: new Date(NOW.getTime() + 4_000),
    });
    expect(retried.run.status).toBe('awaiting_canary_approval');
    expect(priorWorkIds.has(retried.run.workId)).toBe(false);
  });

  it('restages an expired activation approval without reusing authority', async () => {
    const prepared = await prepareCompletedCanary();
    const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: prepared.staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    recordCapabilityOwnerVerdict({
      token,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    const first = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 9_000),
    });
    const restaged = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 16 * 60_000),
    });
    expect(restaged.run.status).toBe('awaiting_activation_approval');
    expect(restaged.approval.approvalPacketId).not.toBe(
      first.approval.approvalPacketId,
    );
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).find(
        (packet) => packet.approvalPacketId === first.approval.approvalPacketId,
      )?.status,
    ).toBe('expired');
  });

  it('rolls back activation work when staging crashes before the run CAS', async () => {
    const prepared = await prepareCompletedCanary();
    const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: prepared.staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    recordCapabilityOwnerVerdict({
      token,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    const priorWorkIds = new Set(
      listDurableWorkUnits({ limit: 500 }).map((work) => work.workId),
    );
    const priorApprovalIds = new Set(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).map(
        (packet) => packet.approvalPacketId,
      ),
    );
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_activation_stage_before_run') {
        throw new Error('simulated activation staging crash');
      }
    });
    expect(() =>
      stageCapabilityActivation({
        runId: prepared.staged.run.runId,
        ...productionHeads(prepared.staged.run.runId),
        binding: prepared.binding,
        now: new Date(NOW.getTime() + 9_000),
      }),
    ).toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);

    expect(
      listDurableWorkUnits({ limit: 500 }).filter(
        (work) => !priorWorkIds.has(work.workId),
      ),
    ).toHaveLength(0);
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).filter(
        (packet) => !priorApprovalIds.has(packet.approvalPacketId),
      ),
    ).toHaveLength(0);
    expect(
      getCapabilityProductionRun(prepared.staged.run.runId)?.activationWorkId,
    ).toBeNull();

    const retried = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 10_000),
    });
    expect(retried.run.status).toBe('awaiting_activation_approval');
    expect(priorWorkIds.has(retried.run.activationWorkId!)).toBe(false);
  });

  it('cancels the exact linked execution lease when the owner pauses', async () => {
    const prepared = await prepareAuthorizedCanary();
    const before = getCapabilityProductionRun(prepared.staged.run.runId)!;
    const leaseId = before.canaryLeaseId!;
    expect(getDurableWorkLease(leaseId)?.status).toBe('active');
    const token = issueCapabilityControlTokenForAuthenticatedCockpit({
      acquisitionId: prepared.acquisition.acquisitionId,
      actionKind: 'pause',
      now: new Date(NOW.getTime() + 6_000),
    });
    const paused = applyCapabilityOwnerControl({
      token,
      now: new Date(NOW.getTime() + 7_000),
    });
    expect(paused.acquisition.state).toBe('paused');
    expect(getDurableWorkLease(leaseId)?.status).toBe('released');
    expect(getDurableWorkUnit(before.workId)?.leaseId).toBeNull();
  });

  it('rolls back every active-reuse staging row and permits one clean retry', async () => {
    const prepared = await prepareCompletedCanary();
    const token = issueCapabilityReviewTokenForAuthenticatedCockpit({
      runId: prepared.staged.run.runId,
      now: new Date(NOW.getTime() + 7_000),
    });
    recordCapabilityOwnerVerdict({
      token,
      verdict: 'verified',
      now: new Date(NOW.getTime() + 8_000),
    });
    const activation = stageCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      now: new Date(NOW.getTime() + 9_000),
    });
    approve(
      activation.approval,
      new Date(NOW.getTime() + 10_000).toISOString(),
    );
    const activated = authorizeApprovedCapabilityActivation({
      runId: prepared.staged.run.runId,
      ...productionHeads(prepared.staged.run.runId),
      binding: prepared.binding,
      workerId: 'fixture-activation-worker',
      now: new Date(NOW.getTime() + 11_000),
    });
    const contract = JSON.parse(
      activated.acquisition.candidateContractJson,
    ) as {
      taskFamily: string;
      triggerSemantics: string[];
      successPostconditions: string[];
    };
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const match = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: contract.taskFamily,
      triggerText: contract.triggerSemantics[0],
      inputs: fixtureValues,
      intendedPostconditions: contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(match.status).toBe('matched');
    const snapshot = () => {
      const works = listDurableWorkUnits({ limit: 2_000 });
      return {
        runs: listCapabilityProductionRuns({
          acquisitionId: activated.acquisition.acquisitionId,
          limit: 1_000,
        }).map((run) => [run.runId, run.revision, run.status]),
        works: works.map((work) => [
          work.workId,
          work.version,
          work.planVersion,
          work.status,
          work.leaseId,
        ]),
        links: works.flatMap((work) =>
          listDurableWorkLinks(work.workId).map((link) => [
            link.linkId,
            link.workId,
            link.linkKind,
            link.linkedId,
          ]),
        ),
        checkpoints: works.flatMap((work) =>
          listDurableWorkCheckpoints({ workId: work.workId, limit: 500 }).map(
            (checkpoint) => [
              checkpoint.durableCheckpointId,
              checkpoint.workId,
              checkpoint.sequence,
              checkpoint.status,
            ],
          ),
        ),
        grants: listDurableResumeGrants({ limit: 500 }).map((grant) => [
          grant.grantId,
          grant.workId,
          grant.checkpointId,
          grant.status,
          grant.consumedLeaseId,
        ]),
      };
    };
    const beforeCrash = snapshot();
    let crashedRunId: string | undefined;
    _setProductionCapabilityApprenticeshipTestHook((event) => {
      if (event.boundary === 'after_active_reuse_lease_before_run') {
        crashedRunId = event.runId;
        throw new Error('simulated persistence crash');
      }
    });
    expect(() =>
      stageActiveCapabilityReuse({
        match,
        taskFamily: contract.taskFamily,
        triggerText: contract.triggerSemantics[0],
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: 'reuse-persistence-crash-worker',
        now: new Date(NOW.getTime() + 12_000),
      }),
    ).toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);
    expect(crashedRunId).toEqual(expect.any(String));
    expect(getCapabilityProductionRun(crashedRunId!)).toBeUndefined();
    expect(snapshot()).toEqual(beforeCrash);

    const retried = stageActiveCapabilityReuse({
      match,
      taskFamily: contract.taskFamily,
      triggerText: contract.triggerSemantics[0],
      intendedPostconditions: contract.successPostconditions,
      binding: prepared.binding,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      currentResourceVersions,
      workerId: 'reuse-persistence-retry-worker',
      now: new Date(NOW.getTime() + 13_000),
    });
    const afterRetry = snapshot();
    expect(retried.runKind).toBe('active_reuse');
    expect(retried.status).toBe('monitoring');
    expect(afterRetry.runs).toHaveLength(beforeCrash.runs.length + 1);
    expect(afterRetry.works).toHaveLength(beforeCrash.works.length + 1);
    expect(afterRetry.links).toHaveLength(beforeCrash.links.length + 2);
    expect(afterRetry.checkpoints).toHaveLength(
      beforeCrash.checkpoints.length + 1,
    );
    expect(afterRetry.grants).toHaveLength(beforeCrash.grants.length + 1);
    expect(getDurableWorkLease(retried.executionLeaseId!)?.status).toBe(
      'active',
    );
    expect(
      listDurableWorkLinks(retried.workId).map((link) => [
        link.linkKind,
        link.linkedId,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['capability_production_run', retried.runId],
        ['capability_acquisition', activated.acquisition.acquisitionId],
      ]),
    );
  });

  it('rejects a canary whose approval surface differs from its canonical channel', async () => {
    const telegramBinding = {
      ...fixtureBinding,
      chatId: 'tg:main',
      channel: 'telegram',
    };
    const acquisition = await ownerReviewRequiredAcquisition('-surface');
    seedHealth();
    expect(() =>
      stageCapabilityCanary({
        acquisitionId: acquisition.acquisitionId,
        expectedAcquisitionVersion: acquisition.recordVersion,
        binding: telegramBinding,
        authorizedSurface: 'owner_cockpit',
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        now: new Date(NOW.getTime() + 3_000),
      }),
    ).toThrow(/canonical execution channel/i);
  });

  it('rejects a trusted-chat review bound to a noncanonical owner identity', async () => {
    const telegramBinding = {
      ...fixtureBinding,
      ownerId: 'not-the-canonical-owner',
      chatId: 'tg:main',
      channel: 'telegram',
    };
    const prepared = await prepareCompletedCanary(undefined, {
      binding: telegramBinding,
      authorizedSurface: 'telegram',
    });
    const group: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andrea',
      added_at: NOW.toISOString(),
      requiresTrigger: false,
      isMain: true,
    };
    expect(() =>
      issueCapabilityReviewTokenForTrustedChat({
        runId: prepared.staged.run.runId,
        channelName: 'telegram',
        chatJid: 'tg:main',
        group,
        messageId: 'message-2',
        now: new Date(NOW.getTime() + 7_000),
      }),
    ).toThrow(/not awaiting this owner review/i);
  });

  it('requires exact current-message owner authorship before BlueBubbles review or control reads', () => {
    vi.stubEnv('ANDREA_TEST_DISABLE_OWNER_ENV_FILE', '1');
    vi.stubEnv(
      'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
      'iMessage;-;owner@example.invalid',
    );
    const group: RegisteredGroup = {
      name: 'Messages (Main)',
      folder: 'main',
      trigger: '@Andrea',
      added_at: NOW.toISOString(),
      requiresTrigger: false,
      isMain: false,
    };
    const surface = {
      channelName: 'bluebubbles',
      chatJid: 'bb:iMessage;-;owner@example.invalid',
      group,
      now: new Date(NOW.getTime() + 7_000),
    };

    for (const ownerAuthored of [undefined, false] as const) {
      expect(() =>
        issueCapabilityReviewTokenForTrustedChat({
          ...surface,
          ownerAuthored,
          runId: 'capability-run:missing',
        }),
      ).toThrow(/trusted private owner surface/i);
      expect(() =>
        issueCapabilityControlTokenForTrustedChat({
          ...surface,
          ownerAuthored,
          acquisitionId: 'capability-acquisition:missing',
          actionKind: 'pause',
        }),
      ).toThrow(/trusted private owner surface/i);
    }

    expect(() =>
      issueCapabilityReviewTokenForTrustedChat({
        ...surface,
        ownerAuthored: true,
        runId: 'capability-run:missing',
      }),
    ).toThrow(/not awaiting this owner review/i);
    expect(() =>
      issueCapabilityControlTokenForTrustedChat({
        ...surface,
        ownerAuthored: true,
        acquisitionId: 'capability-acquisition:missing',
        actionKind: 'pause',
      }),
    ).toThrow(/does not match canonical scope/i);
  });

  it('rejects a run whose named execution grant does not own its exact lease', async () => {
    const prepared = await prepareActiveCapability();
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const match = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: prepared.contract.triggerSemantics[0],
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    const reuse = stageActiveCapabilityReuse({
      match,
      taskFamily: prepared.contract.taskFamily,
      triggerText: prepared.contract.triggerSemantics[0],
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
        },
      ],
      currentResourceVersions,
      workerId: 'grant-tamper-stage-worker',
      now: new Date(NOW.getTime() + 12_000),
    });
    const current = getCapabilityProductionRun(reuse.runId)!;
    expect(
      updateCapabilityProductionRunCAS({
        expectedRevision: current.revision,
        next: {
          ...current,
          updatedAt: new Date(NOW.getTime() + 13_000).toISOString(),
          revision: current.revision + 1,
          executionGrantId: prepared.activated.run.activationGrantId,
        },
      }),
    ).toBe('applied');
    const counter = { executions: 0 };
    await expect(
      runCapabilityProductionExecution({
        runId: reuse.runId,
        ...productionHeads(reuse.runId),
        binding: prepared.binding,
        workerId: 'grant-tamper-execution-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: new Date(NOW.getTime() + 14_000),
      }),
    ).rejects.toThrow(/execution authority is not exact/i);
    expect(counter.executions).toBe(0);
    expect(getDurableWorkLease(reuse.executionLeaseId!)?.status).toBe(
      'released',
    );
    expect(
      getCapabilityAcquisition(prepared.acquisition.acquisitionId)?.state,
    ).toBe('active');
  });

  it('atomically pauses matching and existing runs on authoritative version drift', async () => {
    const prepared = await prepareActiveCapability();
    const result = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: prepared.contract.triggerSemantics[0],
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions: {
        [resource().resourceId]: `${resource().version}-incompatible`,
      },
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(result.status).toBe('none');
    const paused = getCapabilityAcquisition(
      prepared.acquisition.acquisitionId,
    )!;
    expect(paused.state).toBe('paused');
    expect(paused.lastOutcome).toBe('version_drift');
    expect(getCapabilityProductionRun(prepared.staged.run.runId)?.status).toBe(
      'paused',
    );
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: prepared.contract.taskFamily,
        triggerText: prepared.contract.triggerSemantics[0],
        inputs: fixtureValues,
        intendedPostconditions: prepared.contract.successPostconditions,
        binding: prepared.binding,
        currentResourceVersions: {
          [resource().resourceId]: resource().version,
        },
        now: new Date(NOW.getTime() + 12_000),
      }).status,
    ).toBe('none');
  });

  it('atomically pauses an active capability when canonical health is stale', async () => {
    const prepared = await prepareActiveCapability();
    const result = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: prepared.contract.triggerSemantics[0],
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions: {
        [resource().resourceId]: resource().version,
      },
      now: new Date(NOW.getTime() + 21 * 60_000),
    });
    expect(result.status).toBe('none');
    const paused = getCapabilityAcquisition(
      prepared.acquisition.acquisitionId,
    )!;
    expect(paused.state).toBe('paused');
    expect(paused.lastOutcome).toBe('health_stale');
    expect(getCapabilityProductionRun(prepared.staged.run.runId)?.status).toBe(
      'paused',
    );
  });

  it('binds active reuse to the observed trigger instead of caller-declared task semantics', async () => {
    const prepared = await prepareActiveCapability();
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const unrelated = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: 'delete unrelated files and publish them',
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(unrelated.status).toBe('none');
    expect(
      getCapabilityAcquisition(prepared.acquisition.acquisitionId)?.state,
    ).toBe('active');

    const exact = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: 'Please verify the production fixture.',
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(exact).toMatchObject({
      status: 'matched',
      triggerEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      triggerSemanticDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const beforeRuns = listCapabilityProductionRuns({
      acquisitionId: prepared.acquisition.acquisitionId,
      limit: 100,
    }).length;
    expect(() =>
      stageActiveCapabilityReuse({
        match: exact,
        taskFamily: prepared.contract.taskFamily,
        triggerText: 'delete unrelated files and publish them',
        intendedPostconditions: prepared.contract.successPostconditions,
        binding: prepared.binding,
        normalizedInputs: fixtureValues,
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: 'semantic-tamper-worker',
        now: new Date(NOW.getTime() + 12_000),
      }),
    ).toThrow(/active capability changed/i);
    expect(
      listCapabilityProductionRuns({
        acquisitionId: prepared.acquisition.acquisitionId,
        limit: 100,
      }),
    ).toHaveLength(beforeRuns);
  });

  it('preserves trigger order, repetition, negation, and exact input-role values', async () => {
    const prepared = await prepareActiveCapability();
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    for (const triggerText of [
      'production fixture verify',
      'do not verify a production fixture',
      'verify verify a production fixture',
      'verify a production fixture from another source',
      'verify Andrea production fixture',
    ]) {
      expect(
        matchActiveCapability({
          groupFolder: 'main',
          taskFamily: prepared.contract.taskFamily,
          triggerText,
          inputs: fixtureValues,
          intendedPostconditions: prepared.contract.successPostconditions,
          binding: prepared.binding,
          currentResourceVersions,
          now: new Date(NOW.getTime() + 12_000),
        }).status,
      ).toBe('none');
    }

    const exact = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText: 'Please verify the production fixture.',
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    expect(exact).toMatchObject({
      status: 'matched',
      inputEvidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const beforeRuns = listCapabilityProductionRuns({
      acquisitionId: prepared.acquisition.acquisitionId,
      limit: 100,
    }).length;
    expect(() =>
      stageActiveCapabilityReuse({
        match: exact,
        taskFamily: prepared.contract.taskFamily,
        triggerText: 'Please verify the production fixture.',
        intendedPostconditions: prepared.contract.successPostconditions,
        binding: prepared.binding,
        normalizedInputs: { ...fixtureValues, key: 'role-value-was-swapped' },
        health: [
          {
            resourceId: resource().resourceId,
            observationId: 'fixture-production-health-1',
            expiresAt: new Date(NOW.getTime() + 20 * 60_000).toISOString(),
          },
        ],
        currentResourceVersions,
        workerId: 'input-role-tamper-worker',
        now: new Date(NOW.getTime() + 12_000),
      }),
    ).toThrow(/active capability changed/i);
    expect(
      listCapabilityProductionRuns({
        acquisitionId: prepared.acquisition.acquisitionId,
        limit: 100,
      }),
    ).toHaveLength(beforeRuns);
  });

  it('advances execution time and refuses success when health expires after the effect', async () => {
    const prepared = await prepareActiveCapability();
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const triggerText = prepared.contract.triggerSemantics[0];
    const match = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText,
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    const reuse = stageActiveCapabilityReuse({
      match,
      taskFamily: prepared.contract.taskFamily,
      triggerText,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 15_000).toISOString(),
        },
      ],
      currentResourceVersions,
      workerId: 'advancing-clock-stage-worker',
      now: new Date(NOW.getTime() + 12_000),
    });
    const boundaryTimes = [13_000, 14_000, 16_000, 17_000].map(
      (offset) => new Date(NOW.getTime() + offset),
    );
    let clockRead = 0;
    const counter = { executions: 0 };
    await expect(
      runCapabilityProductionExecution({
        runId: reuse.runId,
        ...productionHeads(reuse.runId),
        binding: prepared.binding,
        workerId: 'advancing-clock-execution-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: boundaryTimes[0],
        clock: () =>
          boundaryTimes[Math.min(clockRead++, boundaryTimes.length - 1)],
      }),
    ).rejects.toThrow(/health expired after the effect|indeterminate/i);
    expect(counter.executions).toBe(1);
    expect(getCapabilityProductionRun(reuse.runId)?.status).not.toBe(
      'awaiting_owner_review',
    );
    expect(
      listDurableEffectReceipts({ workId: reuse.workId, limit: 100 }).some(
        (receipt) => receipt.status === 'unknown',
      ),
    ).toBe(true);
  });

  it('rechecks authority after the async receipt boundary before terminal success', async () => {
    const prepared = await prepareActiveCapability();
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const triggerText = prepared.contract.triggerSemantics[0];
    const match = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: prepared.contract.taskFamily,
      triggerText,
      inputs: fixtureValues,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
      now: new Date(NOW.getTime() + 12_000),
    });
    const reuse = stageActiveCapabilityReuse({
      match,
      taskFamily: prepared.contract.taskFamily,
      triggerText,
      intendedPostconditions: prepared.contract.successPostconditions,
      binding: prepared.binding,
      normalizedInputs: fixtureValues,
      health: [
        {
          resourceId: resource().resourceId,
          observationId: 'fixture-production-health-1',
          expiresAt: new Date(NOW.getTime() + 20_000).toISOString(),
        },
      ],
      currentResourceVersions,
      workerId: 'terminal-boundary-stage-worker',
      now: new Date(NOW.getTime() + 12_000),
    });
    _setProductionCapabilityApprenticeshipTestHook(async (event) => {
      if (event.boundary === 'after_receipts_before_checkpoint') {
        await Promise.resolve();
      }
    });
    const boundaryTimes = [13_000, 14_000, 15_000, 16_000, 17_000, 21_000].map(
      (offset) => new Date(NOW.getTime() + offset),
    );
    let clockRead = 0;
    const counter = { executions: 0 };
    await expect(
      runCapabilityProductionExecution({
        runId: reuse.runId,
        ...productionHeads(reuse.runId),
        binding: prepared.binding,
        workerId: 'terminal-boundary-execution-worker',
        values: fixtureValues,
        registry: liveRegistry(counter),
        now: boundaryTimes[0],
        clock: () =>
          boundaryTimes[Math.min(clockRead++, boundaryTimes.length - 1)],
      }),
    ).rejects.toThrow(/preflight is stale|health|indeterminate/i);
    expect(counter.executions).toBe(1);
    // The execution is first made indeterminate; canonical stale-health
    // reconciliation then applies the stricter paused terminal state.
    expect(getCapabilityProductionRun(reuse.runId)?.status).toBe('paused');
    expect(
      getOutcomeBySource('main', 'capability_acquisition', reuse.runId),
    ).toBeUndefined();
    expect(
      listDurableWorkCheckpoints({ workId: reuse.workId, limit: 100 }).some(
        (checkpoint) => checkpoint.status === 'completed',
      ),
    ).toBe(false);
  });
});
