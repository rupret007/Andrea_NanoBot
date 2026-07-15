import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  canonicalCapabilityJson,
  capabilityCandidateFingerprint,
} from './capability-acquisition-policy.js';
import {
  buildCapabilityCanaryUsage,
  parseCapabilityCanaryArgs,
  runCapabilityCanaryCli,
  type CapabilityCanaryCliDependencies,
} from './capability-canary-cli.js';
import { durableScopeHash } from './durable-work-continuity.js';
import {
  buildReleaseReadinessCandidateContract,
  releaseReadinessCapabilityResource,
  type CapabilityApprenticeshipStatus,
} from './production-capability-apprenticeship.js';
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

const NOW = '2026-07-15T12:00:00.000Z';
const INPUTS = { targetScopeKey: 'release-readiness' };

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function compiledReleaseReadinessContract(): CapabilityCandidateContract {
  const presentation = buildReleaseReadinessCandidateContract();
  const resource = releaseReadinessCapabilityResource();
  const binding = resource.bindingRefs[0]!;
  const capabilityId = `acquired-capability:${sha256(
    `${presentation.taskFamily}|${presentation.title}`,
  ).slice(0, 32)}`;
  const draft: CapabilityCandidateContract = {
    contractVersion: presentation.contractVersion,
    candidateFingerprint: '0'.repeat(64),
    capabilityId,
    skillId: `acquired-skill:${sha256(capabilityId).slice(0, 32)}`,
    title: presentation.title,
    taskFamily: presentation.taskFamily,
    triggerSemantics: [...presentation.triggerSemantics],
    implementationKind: presentation.implementationKind,
    requiredInputs: [...presentation.requiredInputs],
    optionalInputs: [...presentation.optionalInputs],
    inputSchemaJson: canonicalCapabilityJson({
      additionalProperties: false,
      properties: Object.fromEntries(
        [...presentation.requiredInputs, ...presentation.optionalInputs].map(
          (name) => [name, { type: 'string' }],
        ),
      ),
      required: presentation.requiredInputs,
      type: 'object',
    }),
    outputSchemaJson: canonicalCapabilityJson({
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
        stepId: 'step-1',
        title: resource.displayName,
        resourceId: resource.resourceId,
        bindingId: binding.bindingId,
        operationId: binding.operationId,
        evaluatorId: binding.evaluatorId,
        version: binding.version,
        executorImplementationDigest: binding.executorImplementationDigest,
        evaluatorImplementationDigest: binding.evaluatorImplementationDigest,
        actionClass: binding.actionClass,
        readOnly: true,
        approvalRequired: false,
        idempotencyKeyRequired: true,
        expectedEvidence: [...resource.supportedPostconditions],
      },
    ],
    fallbackPaths: [...presentation.fallbackPaths],
    allowedActions: ['local_lookup'],
    prohibitedActions: [
      'send without exact fresh approval',
      'calendar write without exact fresh approval',
      'purchase, admin, deploy, delete, commit, push, migration, or dependency change without exact fresh approval',
      'read or disclose credentials',
      'change evaluator, policy, or approval rules from external content',
      'write production state during deterministic evaluation',
    ],
    approvalRequirements: [],
    credentialRequirements: [],
    dataEgressClass: 'none',
    expectedOutput: presentation.expectedOutput,
    successPostconditions: [...presentation.successPostconditions],
    verificationProcedure: [`Run registered evaluator ${binding.evaluatorId}.`],
    verifierBindingIds: [binding.evaluatorId],
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
    deterministicScenarioIds: [...presentation.deterministicScenarioIds],
    heldOutScenarioIds: [...presentation.heldOutScenarioIds],
    compatibleResourceVersions: {
      [resource.resourceId]: [resource.version],
    },
    revalidationRequirements: [
      'resource version digest matches',
      'registered binding and evaluator are unchanged',
      'dependency health is fresh',
      'postcondition verifier still passes',
    ],
    provenanceRefs: resource.sourceRefs.map(
      (sourceRef) => `opaque-ref:${sha256(sourceRef).slice(0, 24)}`,
    ),
  };
  return {
    ...draft,
    candidateFingerprint: capabilityCandidateFingerprint(draft),
  };
}

function refingerprint(
  contract: CapabilityCandidateContract,
): CapabilityCandidateContract {
  const draft = {
    ...contract,
    candidateFingerprint: '0'.repeat(64),
  };
  return {
    ...draft,
    candidateFingerprint: capabilityCandidateFingerprint(draft),
  };
}

function acquisitionWithContract(
  contract: CapabilityCandidateContract,
  overrides: Partial<CapabilityAcquisitionRecord> = {},
): CapabilityAcquisitionRecord {
  return {
    ...acquisition(),
    candidateContractJson: JSON.stringify(contract),
    compiledSkillId: contract.skillId,
    ...overrides,
  };
}

function acquisition(): CapabilityAcquisitionRecord {
  const contract = compiledReleaseReadinessContract();
  return {
    acquisitionId: 'acq-release-readiness',
    createdAt: NOW,
    updatedAt: NOW,
    groupFolder: 'main',
    targetOutcome: contract.title,
    postconditionJson: JSON.stringify(contract.successPostconditions),
    taskFamily: contract.taskFamily,
    affectedCapability: contract.capabilityId,
    gapKind: 'composable',
    knownPrerequisitesJson: '[]',
    missingPrerequisitesJson: '[]',
    candidateResourceRefsJson: '[]',
    selectedResourceRefsJson: JSON.stringify(
      contract.resourceBindings.map((resource) => ({
        resourceId: resource.resourceId,
        version: resource.version,
        descriptorDigest: 'a'.repeat(64),
        healthState: 'healthy',
        reliabilityScore: 0.99,
      })),
    ),
    riskLevel: 'low',
    dataEgressClass: 'none',
    expectedCostBand: 'zero',
    expectedLatencyBand: 'interactive',
    authorityRequirementsJson: '[]',
    evidenceOrigin: 'synthetic',
    confidence: 0.99,
    provenanceJson: '{}',
    state: 'owner_review_required',
    nextSafeAction: 'Present one exact canary proposal to the owner.',
    recordVersion: 8,
    environmentFingerprint: 'b'.repeat(64),
    candidateContractJson: JSON.stringify(contract),
    sandboxEvidenceJson: JSON.stringify({
      verified: true,
      postconditionVerified: true,
    }),
    heldOutEvidenceJson: JSON.stringify({
      passed: true,
      safetyInvariantRate: 1,
      falseSuccesses: 0,
    }),
    ownerReviewJson: '{}',
    outcomeIdsJson: '[]',
    compiledSkillId: contract.skillId,
    negativeOutcomeCount: 0,
    correctionCount: 0,
    lastOutcome: 'held_out_verified',
    expiresAt: null,
    revalidateAfterAt: null,
    privacyJson: '{}',
  };
}

function run(): CapabilityProductionRunRecord {
  const contract = compiledReleaseReadinessContract();
  return {
    runId: 'run-release-readiness',
    acquisitionId: 'acq-release-readiness',
    createdAt: NOW,
    updatedAt: NOW,
    runKind: 'canary',
    status: 'awaiting_canary_approval',
    revision: 1,
    candidateFingerprint: contract.candidateFingerprint,
    contractVersion: contract.contractVersion,
    contractDigest: 'c'.repeat(64),
    taskFamily: contract.taskFamily,
    groupFolder: 'main',
    ownerScopeHash: durableScopeHash('owner', 'owner'),
    chatScopeHash: durableScopeHash('chat', 'cockpit'),
    groupScopeHash: durableScopeHash('group', 'main'),
    channel: 'owner_cockpit',
    authorizedSurface: 'owner_cockpit',
    targetScopeHash: durableScopeHash('target', 'release-readiness'),
    inputDigest: sha256(canonicalCapabilityJson(INPUTS)),
    actionClass: 'operator_change',
    workId: 'work-release-readiness',
    workVersion: 3,
    planVersion: 1,
    checkpointId: 'checkpoint-release-readiness',
    invocationId: 'invocation-release-readiness',
    canaryApprovalPacketId: 'approval-release-readiness',
    canaryApprovalVersion: 1,
    canaryApprovalScopeDigest: '3'.repeat(64),
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
    healthEvidenceSetDigest: '4'.repeat(64),
    postconditionFingerprint: null,
    resourceDiscoveryCalls: 0,
    candidateDesignCalls: 0,
    toolSelectionCalls: 0,
    executionCalls: 0,
    evaluatorCalls: 0,
    latencyMs: 0,
    providerCalls: 0,
    costUsd: 0,
    matchConfidence: null,
    expiresAt: '2026-07-15T12:30:00.000Z',
    completedAt: null,
    nextSafeAction: 'Wait for exact owner approval of this canary only.',
    privacyJson: '{}',
  };
}

function approval(): CognitiveApprovalPacket {
  return {
    approvalPacketId: 'approval-release-readiness',
    createdAt: NOW,
    updatedAt: NOW,
    runId: 'cognitive-release-readiness',
    toolId: 'capability:acq-release-readiness',
    actionClass: 'operator_change',
    status: 'staged',
    summary: 'Approve one exact release-readiness canary.',
    approvalChannel: null,
    approvalKey: 'capability-canary',
    expiresAt: '2026-07-15T12:10:00.000Z',
    approvalVersion: 1,
    scopeDigest: '3'.repeat(64),
    summaryDigest: '6'.repeat(64),
    durableWorkId: 'work-release-readiness',
    durableCheckpointId: 'checkpoint-release-readiness',
    planVersion: 1,
    targetScopeDigest: durableScopeHash('target', 'release-readiness'),
    decisionJson: '{}',
    privacyJson: '{}',
  };
}

function healthEvidence(): CapabilityHealthEvidenceRecord {
  return {
    runId: 'run-release-readiness',
    resourceId: 'andrea.release_readiness_truth',
    resourceVersion: '1.0.0',
    subjectId: 'andrea.release_readiness_truth',
    observationId: 'health-release-readiness',
    observedAt: NOW,
    expiresAt: '2026-07-15T12:20:00.000Z',
    evidenceDigest: '7'.repeat(64),
    privacyJson: '{}',
  };
}

function transitionReceipt(
  transitionKind: CapabilityProductionTransitionReceipt['transitionKind'],
): CapabilityProductionTransitionReceipt {
  return {
    receiptId: `receipt-${transitionKind}`,
    acquisitionId: 'acq-release-readiness',
    runId: 'run-release-readiness',
    transitionKind,
    expectedAcquisitionVersion: 8,
    resultingAcquisitionVersion: 9,
    expectedRunRevision: 1,
    resultingRunRevision: 2,
    evidenceDigest: '8'.repeat(64),
    createdAt: NOW,
    privacyJson: '{}',
  };
}

function dependencies(
  overrides: Partial<CapabilityCanaryCliDependencies> = {},
): CapabilityCanaryCliDependencies {
  const record = acquisition();
  const observations: ReliabilityObservation[] = [
    {
      observationId: 'health-release-readiness',
      subjectId: 'andrea.release_readiness_truth',
      observedAt: NOW,
      sourceKind: 'verified_usage',
      outcome: 'success',
      failureClass: 'none',
      confidence: 1,
      fallbackUsed: false,
      latencyMs: 2,
      summary: 'Healthy.',
      nextAction: 'Use exact observation only while fresh.',
      evidenceIdsJson: '[]',
      privacyJson: '{}',
    },
  ];
  const status: CapabilityApprenticeshipStatus = {
    acquisition: record,
    runs: [],
    pendingAction: 'none',
    stateLabel: 'owner_review_required',
    ownerControlSummary: 'Owner control remains separate.',
  };
  return {
    listAcquisitions: vi.fn(() => [record]),
    listRuns: vi.fn(() => []),
    listRunHealth: vi.fn(() => []),
    listApprovals: vi.fn(() => [approval()]),
    listReliabilityObservations: vi.fn(() => observations),
    getRun: vi.fn(() => undefined),
    getOwnerReview: vi.fn(() => undefined),
    getStatus: vi.fn(() => status),
    contractDigest: vi.fn(() => 'c'.repeat(64)),
    healthEvidenceSetDigest: vi.fn(() => '4'.repeat(64)),
    buildReleaseReadinessContract: vi.fn(
      buildReleaseReadinessCandidateContract,
    ),
    buildReleaseReadinessResource: vi.fn(releaseReadinessCapabilityResource),
    isTrustedBinding: vi.fn(() => true),
    stageCanary: vi.fn(() => ({ run: run(), approval: approval() })),
    authorizeCanary: vi.fn(() => ({
      acquisition: record,
      run: run(),
      receipt: transitionReceipt('canary_authorized'),
    })),
    executeCanary: vi.fn(async () => ({
      status: 'verified' as const,
      runId: 'run-release-readiness',
      acquisitionId: 'acq-release-readiness',
      results: [],
      receiptIds: ['execution-receipt'],
      evidenceRefs: ['release-readiness:proof'],
      providerCalls: 0,
      costUsd: 0,
      latencyMs: 3,
      reason: 'verified',
    })),
    stageActivation: vi.fn(() => ({ run: run(), approval: approval() })),
    authorizeActivation: vi.fn(() => ({
      acquisition: record,
      run: run(),
      receipt: transitionReceipt('activated'),
    })),
    now: () => NOW,
    ...overrides,
  };
}

function mutationArgs(
  operation:
    | '--authorize-canary'
    | '--run-canary'
    | '--stage-activation'
    | '--activate',
  versions: { acquisition: number; run: number },
): string[] {
  return [
    operation,
    '--acquisition',
    'acq-release-readiness',
    '--run-id',
    'run-release-readiness',
    '--group',
    'main',
    '--expected-acquisition-version',
    String(versions.acquisition),
    '--expected-run-revision',
    String(versions.run),
    ...(['--authorize-canary', '--run-canary', '--activate'].includes(operation)
      ? ['--worker-id', 'guided-worker']
      : []),
    '--owner-id',
    'owner',
    '--chat-id',
    'cockpit',
    '--channel',
    'owner_cockpit',
    '--authorized-surface',
    'owner_cockpit',
    '--target-scope',
    'release-readiness',
    '--inputs-json',
    JSON.stringify(INPUTS),
    '--health-json',
    '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
  ];
}

function stagingArgs(): string[] {
  return [
    '--stage',
    '--acquisition',
    'acq-release-readiness',
    '--group',
    'main',
    '--expected-acquisition-version',
    '8',
    '--owner-id',
    'owner',
    '--chat-id',
    'cockpit',
    '--channel',
    'owner_cockpit',
    '--authorized-surface',
    'owner_cockpit',
    '--target-scope',
    'release-readiness',
    '--inputs-json',
    JSON.stringify(INPUTS),
    '--health-json',
    '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
  ];
}

function approvedCanaryPacket(): CognitiveApprovalPacket {
  return {
    ...approval(),
    status: 'approved',
    approvalChannel: 'owner_cockpit',
    approvalVersion: 2,
  };
}

function activationPacket(
  status: CognitiveApprovalPacket['status'] = 'staged',
): CognitiveApprovalPacket {
  return {
    ...approval(),
    approvalPacketId: 'approval-activation',
    status,
    approvalChannel: status === 'approved' ? 'owner_cockpit' : null,
    approvalVersion: status === 'approved' ? 2 : 1,
    scopeDigest: '9'.repeat(64),
    durableWorkId: 'activation-work',
    durableCheckpointId: 'activation-checkpoint',
    planVersion: 1,
  };
}

function ownerReview(
  productionRun: CapabilityProductionRunRecord,
): CapabilityOwnerReviewRecord {
  return {
    reviewId: 'owner-review-release-readiness',
    acquisitionId: productionRun.acquisitionId,
    runId: productionRun.runId,
    outcomeId: productionRun.outcomeId as string,
    candidateFingerprint: productionRun.candidateFingerprint,
    contractVersion: productionRun.contractVersion,
    ownerScopeHash: productionRun.ownerScopeHash,
    chatScopeHash: productionRun.chatScopeHash,
    groupScopeHash: productionRun.groupScopeHash,
    channel: productionRun.channel,
    authorizedSurface: productionRun.authorizedSurface,
    verdict: 'verified',
    revision: 1,
    sourceMessageHash: 'a'.repeat(64),
    createdAt: NOW,
    updatedAt: NOW,
    supersededAt: null,
    privacyJson: '{}',
  };
}

describe('capability canary CLI parser', () => {
  it('defaults to read-only inspection', () => {
    expect(parseCapabilityCanaryArgs([])).toMatchObject({
      stage: false,
      json: false,
      groupFolder: 'main',
      acquisitionId: null,
    });
  });

  it('rejects mutation metadata unless an operation is explicit', () => {
    expect(() => parseCapabilityCanaryArgs(['--owner-id', 'owner'])).toThrow(
      '--owner-id requires an explicit mutation operation',
    );
  });

  it('requires the complete explicit staging identity', () => {
    expect(() => parseCapabilityCanaryArgs(['--stage'])).toThrow(
      '--stage requires explicit --acquisition, --group, --expected-acquisition-version',
    );
  });

  it('documents the required run worker and rejects it on non-worker operations', () => {
    const usage = buildCapabilityCanaryUsage();
    const runLine = usage
      .split('\n')
      .find((line) => line.includes('--run-canary'));
    expect(runLine).toContain('--worker-id WORKER_ID');
    expect(() =>
      parseCapabilityCanaryArgs([...stagingArgs(), '--worker-id', 'worker']),
    ).toThrow(
      '--worker-id is accepted only by --authorize-canary, --run-canary, or --activate',
    );
  });

  it('parses one bounded explicit staging request', () => {
    const options = parseCapabilityCanaryArgs([
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'cockpit',
      '--channel',
      'owner_cockpit',
      '--authorized-surface',
      'owner_cockpit',
      '--target-scope',
      'release-readiness',
      '--inputs-json',
      '{"targetScopeKey":"release-readiness"}',
      '--health-json',
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ]);
    expect(options).toMatchObject({
      stage: true,
      groupWasExplicit: true,
      acquisitionId: 'acq-release-readiness',
      authorizedSurface: 'owner_cockpit',
      normalizedInputs: { targetScopeKey: 'release-readiness' },
    });
    expect(options.health).toEqual([
      {
        resourceId: 'andrea.release_readiness_truth',
        observationId: 'health-release-readiness',
        expiresAt: '2026-07-15T12:20:00.000Z',
      },
    ]);
  });

  it('rejects a channel/surface mismatch', () => {
    const args = [
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'chat',
      '--channel',
      'telegram',
      '--authorized-surface',
      'bluebubbles',
      '--target-scope',
      'scope',
      '--inputs-json',
      '{}',
      '--health-json',
      '[{"resourceId":"resource","observationId":"observation","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ];
    expect(() => parseCapabilityCanaryArgs(args)).toThrow(
      'channel and authorized surface must match',
    );
  });
});

describe('capability canary CLI effects', () => {
  it('lists exact candidate evidence without invoking the staging boundary', async () => {
    const deps = dependencies();
    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs([]),
      deps,
    );
    expect(report.mode).toBe('inspect');
    expect(report.selectedAcquisition).toBeNull();
    expect(report.eligibleAcquisitions).toHaveLength(1);
    expect(report.eligibleAcquisitions[0]).toMatchObject({
      state: 'owner_review_required',
      taskFamily: 'release_readiness',
      dataEgress: { acquisition: 'none', contract: 'none' },
    });
    expect(report.staged).toBeNull();
    expect(deps.stageCanary).not.toHaveBeenCalled();
    expect(deps.isTrustedBinding).not.toHaveBeenCalled();
    expect(deps.buildReleaseReadinessContract).not.toHaveBeenCalled();
  });

  it('presents the release-readiness contract without executing or staging it', async () => {
    const deps = dependencies({ listAcquisitions: vi.fn(() => []) });
    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(['--release-readiness']),
      deps,
    );
    expect(report.releaseReadinessCandidate).toMatchObject({
      status: 'presentation_only_pending_canonical_acquisition',
      title: 'Andrea Release-Readiness Brief',
      dataEgressClass: 'none',
    });
    expect(report.releaseReadinessCandidate?.prohibitedActions).toContain(
      'deploy',
    );
    expect(report.staged).toBeNull();
    expect(deps.stageCanary).not.toHaveBeenCalled();
    expect(deps.isTrustedBinding).not.toHaveBeenCalled();
  });

  it('shows canonical approval state for an open run without consuming it', async () => {
    const deps = dependencies({ listRuns: vi.fn(() => [run()]) });
    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs([]),
      deps,
    );
    expect(report.openRuns[0].canaryApproval).toMatchObject({
      approvalPacketId: 'approval-release-readiness',
      status: 'staged',
      version: 1,
    });
    expect(report.openRuns[0].activationApproval).toBeNull();
    expect(deps.stageCanary).not.toHaveBeenCalled();
  });

  it('stages only after complete explicit trusted metadata', async () => {
    const deps = dependencies();
    const options = parseCapabilityCanaryArgs([
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'cockpit',
      '--channel',
      'owner_cockpit',
      '--authorized-surface',
      'owner_cockpit',
      '--target-scope',
      'release-readiness',
      '--inputs-json',
      '{"targetScopeKey":"release-readiness"}',
      '--health-json',
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ]);
    const report = await runCapabilityCanaryCli(options, deps);
    expect(deps.isTrustedBinding).toHaveBeenCalledOnce();
    expect(deps.stageCanary).toHaveBeenCalledOnce();
    expect(deps.stageCanary).toHaveBeenCalledWith(
      expect.objectContaining({
        acquisitionId: 'acq-release-readiness',
        authorizedSurface: 'owner_cockpit',
        binding: {
          ownerId: 'owner',
          chatId: 'cockpit',
          groupId: 'main',
          channel: 'owner_cockpit',
          targetScopeKey: 'release-readiness',
        },
      }),
    );
    expect(report.staged).toMatchObject({
      runStatus: 'awaiting_canary_approval',
      acquisitionState: 'owner_review_required',
      approvalStatus: 'staged',
    });
    expect(report.guardrails).toContain(
      'Staging does not authorize or execute the canary.',
    );
  });

  it.each([
    [
      'credential requirement',
      () => {
        const contract = compiledReleaseReadinessContract();
        contract.credentialRequirements = ['BRAVE_API_KEY'];
        return {
          record: acquisitionWithContract(refingerprint(contract)),
          resource: releaseReadinessCapabilityResource(),
        };
      },
    ],
    [
      'removed prohibition',
      () => {
        const contract = compiledReleaseReadinessContract();
        contract.prohibitedActions = contract.prohibitedActions.slice(0, -1);
        return {
          record: acquisitionWithContract(refingerprint(contract)),
          resource: releaseReadinessCapabilityResource(),
        };
      },
    ],
    [
      'additional optional input',
      () => {
        const contract = compiledReleaseReadinessContract();
        contract.optionalInputs = [
          ...contract.optionalInputs,
          'broaderContext',
        ];
        contract.inputSchemaJson = canonicalCapabilityJson({
          additionalProperties: false,
          properties: {
            broaderContext: { type: 'string' },
            focus: { type: 'string' },
            targetScopeKey: { type: 'string' },
          },
          required: ['targetScopeKey'],
          type: 'object',
        });
        return {
          record: acquisitionWithContract(refingerprint(contract)),
          resource: releaseReadinessCapabilityResource(),
        };
      },
    ],
    [
      'changed executor digest',
      () => {
        const contract = compiledReleaseReadinessContract();
        contract.steps[0]!.executorImplementationDigest = 'f'.repeat(64);
        return {
          record: acquisitionWithContract(refingerprint(contract)),
          resource: releaseReadinessCapabilityResource(),
        };
      },
    ],
    [
      'acquisition authority expansion',
      () => ({
        record: acquisitionWithContract(compiledReleaseReadinessContract(), {
          authorityRequirementsJson: '["calendar_write"]',
        }),
        resource: releaseReadinessCapabilityResource(),
      }),
    ],
    [
      'resource authority expansion',
      () => ({
        record: acquisition(),
        resource: {
          ...releaseReadinessCapabilityResource(),
          authorityRequirement: 'explicit_approval' as const,
        },
      }),
    ],
    [
      'resource capability expansion',
      () => ({
        record: acquisition(),
        resource: {
          ...releaseReadinessCapabilityResource(),
          capabilityIds: [
            ...releaseReadinessCapabilityResource().capabilityIds,
            'repository_write',
          ],
        },
      }),
    ],
  ] as Array<
    [
      string,
      () => {
        record: CapabilityAcquisitionRecord;
        resource: CapabilityResourceDescriptor;
      },
    ]
  >)(
    'fails closed before staging after a %s',
    async (_label, broadenedCandidate) => {
      const { record, resource } = broadenedCandidate();
      const status: CapabilityApprenticeshipStatus = {
        acquisition: record,
        runs: [],
        pendingAction: 'none',
        stateLabel: record.state,
        ownerControlSummary: 'Owner control remains separate.',
      };
      const deps = dependencies({
        listAcquisitions: vi.fn(() => [record]),
        getStatus: vi.fn(() => status),
        buildReleaseReadinessResource: vi.fn(() => resource),
      });
      await expect(
        runCapabilityCanaryCli(parseCapabilityCanaryArgs(stagingArgs()), deps),
      ).rejects.toThrow(
        'only the exact bundled, zero-egress, read-only release-readiness canary',
      );
      expect(deps.stageCanary).not.toHaveBeenCalled();
      expect(deps.isTrustedBinding).not.toHaveBeenCalled();
    },
  );

  it('rejects untrusted binding metadata before staging', async () => {
    const deps = dependencies({ isTrustedBinding: vi.fn(() => false) });
    const options = parseCapabilityCanaryArgs([
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'wrong-chat',
      '--channel',
      'telegram',
      '--authorized-surface',
      'telegram',
      '--target-scope',
      'release-readiness',
      '--inputs-json',
      '{"targetScopeKey":"release-readiness"}',
      '--health-json',
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ]);
    await expect(runCapabilityCanaryCli(options, deps)).rejects.toThrow(
      'trusted owner-bound surface',
    );
    expect(deps.stageCanary).not.toHaveBeenCalled();
  });

  it('rejects inputs that do not satisfy the immutable contract', async () => {
    const deps = dependencies();
    const options = parseCapabilityCanaryArgs([
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'cockpit',
      '--channel',
      'owner_cockpit',
      '--authorized-surface',
      'owner_cockpit',
      '--target-scope',
      'release-readiness',
      '--inputs-json',
      '{}',
      '--health-json',
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"health-release-readiness","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ]);
    await expect(runCapabilityCanaryCli(options, deps)).rejects.toThrow(
      'immutable candidate contract',
    );
    expect(deps.stageCanary).not.toHaveBeenCalled();
  });

  it('rejects a health ID that is not present in canonical observations', async () => {
    const deps = dependencies({
      listReliabilityObservations: vi.fn(() => []),
    });
    const options = parseCapabilityCanaryArgs([
      '--stage',
      '--acquisition',
      'acq-release-readiness',
      '--group',
      'main',
      '--expected-acquisition-version',
      '8',
      '--owner-id',
      'owner',
      '--chat-id',
      'cockpit',
      '--channel',
      'owner_cockpit',
      '--authorized-surface',
      'owner_cockpit',
      '--target-scope',
      'release-readiness',
      '--inputs-json',
      '{"targetScopeKey":"release-readiness"}',
      '--health-json',
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"missing-health","expiresAt":"2026-07-15T12:20:00.000Z"}]',
    ]);
    await expect(runCapabilityCanaryCli(options, deps)).rejects.toThrow(
      'missing, unsuccessful, or expired',
    );
    expect(deps.stageCanary).not.toHaveBeenCalled();
  });

  it('consumes only an already approved exact canary packet', async () => {
    const beforeAcquisition = acquisition();
    const afterAcquisition = {
      ...beforeAcquisition,
      state: 'canary_ready' as const,
      recordVersion: 9,
    };
    const beforeRun = run();
    const afterRun = {
      ...beforeRun,
      status: 'canary_ready' as const,
      revision: 3,
      canaryApprovalVersion: 2,
      canaryGrantId: 'grant-canary',
      canaryLeaseId: 'lease-canary',
      nextSafeAction: 'Execute the exact registered canary.',
    };
    let acted = false;
    const authorizeCanary = vi.fn(() => {
      acted = true;
      return {
        acquisition: afterAcquisition,
        run: afterRun,
        receipt: transitionReceipt('canary_authorized'),
      };
    });
    const deps = dependencies({
      listAcquisitions: vi.fn(() => [beforeAcquisition]),
      listRuns: vi.fn(() => [acted ? afterRun : beforeRun]),
      listRunHealth: vi.fn(() => [healthEvidence()]),
      listApprovals: vi.fn(() => [approvedCanaryPacket()]),
      getRun: vi.fn(() => (acted ? afterRun : beforeRun)),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: acted ? afterAcquisition : beforeAcquisition,
          runs: [acted ? afterRun : beforeRun],
          pendingAction: acted ? 'canary_execution' : 'canary_approval',
          stateLabel: acted ? 'canary_ready' : 'owner_review_required',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
      authorizeCanary,
    });

    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs('--authorize-canary', { acquisition: 8, run: 1 }),
      ),
      deps,
    );

    expect(authorizeCanary).toHaveBeenCalledOnce();
    expect(report.action).toMatchObject({
      operation: 'authorize_canary',
      acquisitionState: 'canary_ready',
      runStatus: 'canary_ready',
      approvalPacketId: 'approval-release-readiness',
      approvalStatus: 'approved',
      transitionReceiptId: 'receipt-canary_authorized',
    });
    expect(deps.executeCanary).not.toHaveBeenCalled();
  });

  it('executes only the bounded registered canary and stops for owner review', async () => {
    const beforeAcquisition = {
      ...acquisition(),
      state: 'canary_ready' as const,
      recordVersion: 9,
    };
    const beforeRun = {
      ...run(),
      status: 'canary_ready' as const,
      revision: 3,
      canaryApprovalVersion: 2,
      canaryGrantId: 'grant-canary',
      canaryLeaseId: 'lease-canary',
    };
    const afterAcquisition = {
      ...beforeAcquisition,
      recordVersion: 10,
    };
    const afterRun = {
      ...beforeRun,
      status: 'awaiting_owner_review' as const,
      revision: 6,
      outcomeId: 'outcome-release-readiness',
      nextSafeAction: 'Wait for the exact owner verdict.',
    };
    let acted = false;
    const executeCanary = vi.fn(async () => {
      acted = true;
      return {
        status: 'verified' as const,
        runId: beforeRun.runId,
        acquisitionId: beforeAcquisition.acquisitionId,
        results: [{ truthFingerprint: 'truth' }],
        receiptIds: ['execution-receipt'],
        evidenceRefs: ['release-readiness:proof'],
        providerCalls: 0,
        costUsd: 0,
        latencyMs: 4,
        reason: 'verified',
      };
    });
    const deps = dependencies({
      listAcquisitions: vi.fn(() => [beforeAcquisition]),
      listRuns: vi.fn(() => [acted ? afterRun : beforeRun]),
      listRunHealth: vi.fn(() => [healthEvidence()]),
      getRun: vi.fn(() => (acted ? afterRun : beforeRun)),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: acted ? afterAcquisition : beforeAcquisition,
          runs: [acted ? afterRun : beforeRun],
          pendingAction: acted ? 'owner_review' : 'canary_execution',
          stateLabel: 'canary_ready',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
      executeCanary,
    });

    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs('--run-canary', { acquisition: 9, run: 3 }),
      ),
      deps,
    );

    expect(executeCanary).toHaveBeenCalledOnce();
    expect(report.action).toMatchObject({
      operation: 'run_canary',
      executionStatus: 'verified',
      runStatus: 'awaiting_owner_review',
      ownerReviewId: null,
      providerCalls: 0,
      costUsd: 0,
    });
    expect(report.nextCommands.join(' ')).toContain(
      'authenticated owner cockpit or trusted bound chat',
    );
    expect(deps.stageActivation).not.toHaveBeenCalled();
  });

  it('stages a separate activation proposal only after canonical verified review', async () => {
    const beforeAcquisition = {
      ...acquisition(),
      state: 'canary_ready' as const,
      recordVersion: 10,
    };
    const beforeRun = {
      ...run(),
      status: 'owner_reviewed' as const,
      revision: 8,
      canaryApprovalVersion: 2,
      outcomeId: 'outcome-release-readiness',
      ownerReviewId: 'owner-review-release-readiness',
    };
    const afterRun = {
      ...beforeRun,
      status: 'awaiting_activation_approval' as const,
      revision: 9,
      activationApprovalPacketId: 'approval-activation',
      activationApprovalVersion: 1,
      activationApprovalScopeDigest: '9'.repeat(64),
      activationWorkId: 'activation-work',
      activationWorkVersion: 3,
      activationPlanVersion: 1,
      activationCheckpointId: 'activation-checkpoint',
      activationInvocationId: 'activation-invocation',
      nextSafeAction: 'Wait for exact activation approval.',
    };
    let acted = false;
    const stageActivation = vi.fn(() => {
      acted = true;
      return { run: afterRun, approval: activationPacket() };
    });
    const deps = dependencies({
      listAcquisitions: vi.fn(() => [beforeAcquisition]),
      listRuns: vi.fn(() => [acted ? afterRun : beforeRun]),
      listRunHealth: vi.fn(() => [healthEvidence()]),
      getRun: vi.fn(() => (acted ? afterRun : beforeRun)),
      getOwnerReview: vi.fn(() => ownerReview(beforeRun)),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: beforeAcquisition,
          runs: [acted ? afterRun : beforeRun],
          pendingAction: acted ? 'activation_approval' : 'none',
          stateLabel: 'canary_ready',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
      stageActivation,
    });

    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs('--stage-activation', { acquisition: 10, run: 8 }),
      ),
      deps,
    );

    expect(stageActivation).toHaveBeenCalledOnce();
    expect(report.action).toMatchObject({
      operation: 'stage_activation',
      runStatus: 'awaiting_activation_approval',
      approvalPacketId: 'approval-activation',
      approvalStatus: 'staged',
    });
    expect(deps.authorizeActivation).not.toHaveBeenCalled();
  });

  it('activates only after consuming the separately approved exact packet', async () => {
    const beforeAcquisition = {
      ...acquisition(),
      state: 'canary_ready' as const,
      recordVersion: 10,
    };
    const beforeRun = {
      ...run(),
      status: 'awaiting_activation_approval' as const,
      revision: 9,
      canaryApprovalVersion: 2,
      outcomeId: 'outcome-release-readiness',
      ownerReviewId: 'owner-review-release-readiness',
      activationApprovalPacketId: 'approval-activation',
      activationApprovalVersion: 1,
      activationApprovalScopeDigest: '9'.repeat(64),
      activationWorkId: 'activation-work',
      activationWorkVersion: 3,
      activationPlanVersion: 1,
      activationCheckpointId: 'activation-checkpoint',
      activationInvocationId: 'activation-invocation',
    };
    const afterAcquisition = {
      ...beforeAcquisition,
      state: 'active' as const,
      recordVersion: 11,
    };
    const afterRun = {
      ...beforeRun,
      status: 'active' as const,
      revision: 12,
      activationApprovalVersion: 2,
      activationGrantId: 'activation-grant',
      activationLeaseId: 'activation-lease',
      nextSafeAction: 'Monitor the exact activated contract.',
    };
    let acted = false;
    const authorizeActivation = vi.fn(() => {
      acted = true;
      return {
        acquisition: afterAcquisition,
        run: afterRun,
        receipt: transitionReceipt('activated'),
      };
    });
    const deps = dependencies({
      listAcquisitions: vi.fn(() => [beforeAcquisition]),
      listRuns: vi.fn(() => [acted ? afterRun : beforeRun]),
      listRunHealth: vi.fn(() => [healthEvidence()]),
      listApprovals: vi.fn(() => [activationPacket('approved')]),
      getRun: vi.fn(() => (acted ? afterRun : beforeRun)),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: acted ? afterAcquisition : beforeAcquisition,
          runs: [acted ? afterRun : beforeRun],
          pendingAction: acted ? 'monitoring' : 'activation_approval',
          stateLabel: acted ? 'active' : 'canary_ready',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
      authorizeActivation,
    });

    const report = await runCapabilityCanaryCli(
      parseCapabilityCanaryArgs(
        mutationArgs('--activate', { acquisition: 10, run: 9 }),
      ),
      deps,
    );

    expect(authorizeActivation).toHaveBeenCalledOnce();
    expect(report.action).toMatchObject({
      operation: 'activate',
      acquisitionState: 'active',
      runStatus: 'active',
      approvalPacketId: 'approval-activation',
      approvalStatus: 'approved',
      transitionReceiptId: 'receipt-activated',
    });
  });

  it('rejects stale current-head and non-approved packet evidence before effects', async () => {
    const currentRun = run();
    const deps = dependencies({
      listRunHealth: vi.fn(() => [healthEvidence()]),
      getRun: vi.fn(() => currentRun),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: acquisition(),
          runs: [currentRun],
          pendingAction: 'canary_approval',
          stateLabel: 'owner_review_required',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
    });
    const stale = mutationArgs('--authorize-canary', {
      acquisition: 7,
      run: 1,
    });
    await expect(
      runCapabilityCanaryCli(parseCapabilityCanaryArgs(stale), deps),
    ).rejects.toThrow('Acquisition head changed');
    expect(deps.authorizeCanary).not.toHaveBeenCalled();

    const unapproved = mutationArgs('--authorize-canary', {
      acquisition: 8,
      run: 1,
    });
    await expect(
      runCapabilityCanaryCli(parseCapabilityCanaryArgs(unapproved), deps),
    ).rejects.toThrow('not canonically approved');
    expect(deps.authorizeCanary).not.toHaveBeenCalled();
  });

  it('rejects changed binding and persisted health evidence before effects', async () => {
    const currentRun = run();
    const deps = dependencies({
      listRunHealth: vi.fn(() => [healthEvidence()]),
      listApprovals: vi.fn(() => [approvedCanaryPacket()]),
      getRun: vi.fn(() => currentRun),
      getStatus: vi.fn(
        (): CapabilityApprenticeshipStatus => ({
          acquisition: acquisition(),
          runs: [currentRun],
          pendingAction: 'canary_approval',
          stateLabel: 'owner_review_required',
          ownerControlSummary: 'Owner control remains separate.',
        }),
      ),
    });
    const changedBinding = mutationArgs('--authorize-canary', {
      acquisition: 8,
      run: 1,
    });
    changedBinding[changedBinding.indexOf('--target-scope') + 1] =
      'different-target';
    changedBinding[changedBinding.indexOf('--inputs-json') + 1] =
      JSON.stringify({
        targetScopeKey: 'different-target',
      });
    await expect(
      runCapabilityCanaryCli(parseCapabilityCanaryArgs(changedBinding), deps),
    ).rejects.toThrow('does not match the run binding');

    const changedHealth = mutationArgs('--authorize-canary', {
      acquisition: 8,
      run: 1,
    });
    changedHealth[changedHealth.indexOf('--health-json') + 1] =
      '[{"resourceId":"andrea.release_readiness_truth","observationId":"different-observation","expiresAt":"2026-07-15T12:20:00.000Z"}]';
    await expect(
      runCapabilityCanaryCli(parseCapabilityCanaryArgs(changedHealth), deps),
    ).rejects.toThrow('Explicit health binding changed');
    expect(deps.authorizeCanary).not.toHaveBeenCalled();
  });

  it('uses lifecycle boundaries without importing packet approval or verdict APIs', () => {
    const source = [
      'scripts/capability-canary.ts',
      'src/capability-canary-runtime.ts',
    ]
      .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
      .join('\n');
    expect(source).toContain('stageCapabilityCanary');
    expect(source).toContain('authorizeApprovedCapabilityCanary');
    expect(source).toContain('runCapabilityProductionExecution');
    expect(source).toContain('stageCapabilityActivation');
    expect(source).toContain('authorizeApprovedCapabilityActivation');
    expect(source).not.toMatch(
      /approveCognitiveApprovalPacketCAS|recordCapabilityOwnerVerdict|issueCapabilityReviewToken/,
    );
    expect(buildCapabilityCanaryUsage()).toContain(
      'never approves packets or records verdicts',
    );
  });
});
