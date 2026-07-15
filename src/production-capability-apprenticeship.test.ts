import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
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
  upsertReliabilityObservation,
  upsertToolReliabilitySubject,
} from './db.js';
import { capabilityBindingImplementationDigest } from './capability-execution-guard.js';
import { assertCapabilityCandidateContract } from './capability-acquisition-policy.js';
import {
  consumeResumeGrantAndAcquireLease,
  durableScopeHash,
  issueDurableResumeGrant,
  reconcileDurableWorkOnStartup,
} from './durable-work-continuity.js';
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
} from './verified-capability-acquisition.js';
import {
  authorizeApprovedCapabilityActivation,
  authorizeApprovedCapabilityCanary,
  _setProductionCapabilityApprenticeshipTestHook,
  applyCapabilityOwnerControl,
  createIsolatedProductionCapabilityRegistryForTest,
  issueCapabilityReviewTokenForAuthenticatedCockpit,
  issueCapabilityReviewTokenForTrustedChat,
  issueCapabilityControlTokenForAuthenticatedCockpit,
  recordCapabilityOwnerVerdict,
  recoverCapabilityProductionRun,
  runCapabilityProductionExecution,
  matchActiveCapability,
  stageActiveCapabilityReuse,
  stageCapabilityActivation,
  stageCapabilityCanary,
} from './production-capability-apprenticeship.js';
import type { CapabilityResourceDescriptor, RegisteredGroup } from './types.js';

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
) {
  const result = approveCognitiveApprovalPacketCAS({
    approvalPacketId: packet.approvalPacketId,
    groupFolder: 'main',
    expectedSummary: packet.summary,
    expectedApprovalVersion: packet.approvalVersion || 1,
    expectedScopeDigest: packet.scopeDigest || null,
    now,
    approvalChannel: 'owner_cockpit',
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
  approve(staged.approval, new Date(NOW.getTime() + 4_000).toISOString());
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

beforeEach(() => {
  vi.stubEnv('ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT', '1');
  vi.stubEnv('ANDREA_TEST_NETWORK_GUARD_ACTIVE', '1');
  _initTestDatabase();
});

afterEach(() => {
  _setProductionCapabilityApprenticeshipTestHook(null);
  _closeDatabase();
  vi.unstubAllEnvs();
});

describe('production capability apprenticeship', () => {
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
    ) as { taskFamily: string; successPostconditions: string[] };
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
      inputs: values,
      intendedPostconditions: activeContract.successPostconditions,
      binding,
      currentResourceVersions,
    });
    expect(exactMatch.status).toBe('matched');
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: activeContract.taskFamily,
        inputs: values,
        intendedPostconditions: [
          ...activeContract.successPostconditions,
          'an additional unverified postcondition',
        ],
        binding,
        currentResourceVersions,
      }).status,
    ).toBe('none');
    const widenedBinding = { ...binding, ownerId: 'different-owner' };
    expect(
      matchActiveCapability({
        groupFolder: 'main',
        taskFamily: activeContract.taskFamily,
        inputs: values,
        intendedPostconditions: activeContract.successPostconditions,
        binding: widenedBinding,
        currentResourceVersions,
      }).status,
    ).toBe('none');
    expect(() =>
      stageActiveCapabilityReuse({
        match: exactMatch,
        taskFamily: activeContract.taskFamily,
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
        registry: liveRegistry(counter, { providerCalls: 2, costUsd: 0.25 }),
        now: new Date(NOW.getTime() + 6_000),
      }),
    ).rejects.toThrow(/simulated production apprenticeship crash/i);
    _setProductionCapabilityApprenticeshipTestHook(null);

    const crashedRun = getCapabilityProductionRun(prepared.staged.run.runId)!;
    expect(counter.executions).toBe(1);
    expect(getDurableWorkUnit(crashedRun.workId)?.status).toBe('verifying');
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
    expect(recovered.costUsd).toBe(0.25);
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
      successPostconditions: string[];
    };
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };

    const executeReuse = async (sequence: number) => {
      const match = matchActiveCapability({
        groupFolder: 'main',
        taskFamily: contract.taskFamily,
        inputs: fixtureValues,
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        currentResourceVersions,
      });
      expect(match.status).toBe('matched');
      const run = stageActiveCapabilityReuse({
        match,
        taskFamily: contract.taskFamily,
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
        inputs: fixtureValues,
        intendedPostconditions: contract.successPostconditions,
        binding: prepared.binding,
        currentResourceVersions,
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
      successPostconditions: string[];
    };
    const currentResourceVersions = {
      [resource().resourceId]: resource().version,
    };
    const match = matchActiveCapability({
      groupFolder: 'main',
      taskFamily: contract.taskFamily,
      inputs: fixtureValues,
      intendedPostconditions: contract.successPostconditions,
      binding: prepared.binding,
      currentResourceVersions,
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

  it('rejects a trusted-chat review when the stored authorized surface differs', async () => {
    const telegramBinding = {
      ...fixtureBinding,
      chatId: 'tg:main',
      channel: 'telegram',
    };
    const prepared = await prepareCompletedCanary(undefined, {
      binding: telegramBinding,
      authorizedSurface: 'owner_cockpit',
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
        messageId: 'message-1',
        now: new Date(NOW.getTime() + 7_000),
      }),
    ).toThrow(/not awaiting this owner review/i);
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
});
