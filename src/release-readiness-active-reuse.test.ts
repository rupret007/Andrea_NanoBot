import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyAssistantRequest } from './assistant-routing.js';
import { capabilityCandidateFingerprint } from './capability-acquisition-policy.js';
import { durableScopeHash } from './durable-work-continuity.js';
import {
  buildReleaseReadinessCandidateContract,
  releaseReadinessCapabilityResource,
  type ActiveCapabilityMatch,
  type CapabilityApprenticeshipStatus,
  type CapabilityProductionExecutionResult,
  type ProductionCapabilityEvaluatorBinding,
  type ProductionCapabilityExecutorBinding,
} from './production-capability-apprenticeship.js';
import {
  dispatchActiveReleaseReadinessReuse,
  isReleaseReadinessActiveReuseRequest,
  refreshActiveReleaseReadinessHealth,
  type ReleaseReadinessActiveReuseDependencies,
} from './release-readiness-active-reuse.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityCandidateContract,
  CapabilityProductionRunRecord,
  RegisteredGroup,
  ReliabilityObservation,
} from './types.js';

const NOW = '2026-07-15T12:00:00.000Z';
const TELEGRAM_CHAT = 'tg:owner-main';
const BLUEBUBBLES_CHAT = 'bb:iMessage;-;owner@example.invalid';

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: NOW,
  requiresTrigger: false,
  isMain: true,
};

const blueBubblesGroup: RegisteredGroup = {
  ...mainGroup,
  name: 'Messages (Main)',
  isMain: false,
};

function compiledReleaseReadinessContract(): CapabilityCandidateContract {
  const presentation = buildReleaseReadinessCandidateContract();
  const resource = releaseReadinessCapabilityResource();
  const draft: CapabilityCandidateContract = {
    ...presentation,
    candidateFingerprint: '0'.repeat(64),
    capabilityId: 'acquired-capability:release-readiness',
    skillId: 'acquired-skill:release-readiness',
    steps: presentation.steps.map((step) => ({
      ...step,
      stepId: 'step-1',
      title: resource.displayName,
    })),
  };
  return {
    ...draft,
    candidateFingerprint: capabilityCandidateFingerprint(draft),
  };
}

function acquisition(
  overrides: Partial<CapabilityAcquisitionRecord> = {},
): CapabilityAcquisitionRecord {
  const contract = compiledReleaseReadinessContract();
  return {
    acquisitionId: 'capability-acquisition:release-ready',
    createdAt: NOW,
    updatedAt: NOW,
    groupFolder: 'main',
    targetOutcome: 'Current release readiness is independently verified.',
    postconditionJson: JSON.stringify(contract.successPostconditions),
    taskFamily: contract.taskFamily,
    affectedCapability: contract.capabilityId,
    gapKind: 'workflow_gap',
    knownPrerequisitesJson: '[]',
    missingPrerequisitesJson: '[]',
    candidateResourceRefsJson: '[]',
    selectedResourceRefsJson: JSON.stringify(
      contract.resourceBindings.map((item) => item.resourceId),
    ),
    riskLevel: 'low',
    dataEgressClass: 'none',
    expectedCostBand: 'zero',
    expectedLatencyBand: 'interactive',
    authorityRequirementsJson: '[]',
    evidenceOrigin: 'live',
    confidence: 1,
    provenanceJson: JSON.stringify({ metadataOnly: true }),
    state: 'active',
    nextSafeAction: 'Monitor exact active reuse.',
    recordVersion: 8,
    environmentFingerprint: 'a'.repeat(64),
    candidateContractJson: JSON.stringify(contract),
    sandboxEvidenceJson: JSON.stringify({ verified: true }),
    heldOutEvidenceJson: JSON.stringify({ passed: true }),
    ownerReviewJson: JSON.stringify({ verdict: 'verified' }),
    outcomeIdsJson: '[]',
    compiledSkillId: contract.skillId,
    negativeOutcomeCount: 0,
    correctionCount: 0,
    lastOutcome: 'verified',
    expiresAt: null,
    revalidateAfterAt: null,
    privacyJson: JSON.stringify({ metadataOnly: true }),
    ...overrides,
  };
}

function canary(params: {
  channel: string;
  chatJid: string;
  groupFolder?: string;
  overrides?: Partial<CapabilityProductionRunRecord>;
}): CapabilityProductionRunRecord {
  const contract = compiledReleaseReadinessContract();
  const groupFolder = params.groupFolder || 'main';
  return {
    runId: 'capability-run:canary',
    acquisitionId: 'capability-acquisition:release-ready',
    createdAt: NOW,
    updatedAt: NOW,
    runKind: 'canary',
    status: 'active',
    revision: 12,
    candidateFingerprint: contract.candidateFingerprint,
    contractVersion: contract.contractVersion,
    contractDigest: 'b'.repeat(64),
    taskFamily: contract.taskFamily,
    groupFolder,
    ownerScopeHash: durableScopeHash('owner', 'owner'),
    chatScopeHash: durableScopeHash('chat', params.chatJid),
    groupScopeHash: durableScopeHash('group', groupFolder),
    channel: params.channel,
    authorizedSurface: params.channel,
    targetScopeHash: durableScopeHash('target', 'release-readiness'),
    inputDigest: 'c'.repeat(64),
    actionClass: 'local_lookup',
    workId: 'durable-work:canary',
    workVersion: 4,
    planVersion: 3,
    checkpointId: 'durable-checkpoint:canary',
    invocationId: 'capability-invocation:canary',
    canaryApprovalPacketId: 'approval:canary',
    canaryApprovalVersion: 1,
    canaryApprovalScopeDigest: 'd'.repeat(64),
    canaryGrantId: null,
    canaryLeaseId: null,
    executionGrantId: null,
    executionLeaseId: null,
    activationApprovalPacketId: 'approval:activation',
    activationApprovalVersion: 1,
    activationApprovalScopeDigest: 'e'.repeat(64),
    activationGrantId: null,
    activationLeaseId: null,
    activationWorkId: 'durable-work:activation',
    activationWorkVersion: 3,
    activationPlanVersion: 2,
    activationCheckpointId: 'durable-checkpoint:activation',
    activationInvocationId: 'capability-invocation:activation',
    outcomeId: 'outcome:canary',
    ownerReviewId: 'owner-review:canary',
    healthEvidenceSetDigest: 'f'.repeat(64),
    postconditionFingerprint: '1'.repeat(64),
    resourceDiscoveryCalls: 1,
    candidateDesignCalls: 1,
    toolSelectionCalls: 1,
    executionCalls: 1,
    evaluatorCalls: 1,
    latencyMs: 20,
    providerCalls: 0,
    costUsd: 0,
    matchConfidence: 1,
    expiresAt: '2026-07-16T12:00:00.000Z',
    completedAt: NOW,
    nextSafeAction: 'Monitor exact active reuse.',
    privacyJson: JSON.stringify({ metadataOnly: true }),
    ...params.overrides,
  };
}

function reuseRun(
  source: CapabilityProductionRunRecord,
): CapabilityProductionRunRecord {
  return {
    ...source,
    runId: 'capability-run:active-reuse',
    runKind: 'active_reuse',
    status: 'monitoring',
    revision: 1,
    workId: 'durable-work:active-reuse',
    checkpointId: 'durable-checkpoint:active-reuse',
    invocationId: 'capability-invocation:active-reuse',
    executionGrantId: 'resume-grant:active-reuse',
    executionLeaseId: 'durable-lease:active-reuse',
  };
}

function health(
  overrides: Partial<ReliabilityObservation> = {},
): ReliabilityObservation {
  return {
    observationId: 'release-readiness-health:fresh',
    subjectId: 'capability-resource:andrea.release_readiness_truth',
    observedAt: '2026-07-15T11:50:00.000Z',
    sourceKind: 'verified_usage',
    outcome: 'success',
    failureClass: 'none',
    confidence: 1,
    fallbackUsed: false,
    latencyMs: 0,
    summary: 'Bundled lookup and evaluator agreed.',
    nextAction: 'Use the exact version-pinned binding.',
    evidenceIdsJson: '[]',
    privacyJson: JSON.stringify({ metadataOnly: true }),
    ...overrides,
  };
}

function executionResult(
  overrides: Partial<CapabilityProductionExecutionResult> = {},
): CapabilityProductionExecutionResult {
  return {
    status: 'verified',
    runId: 'capability-run:active-reuse',
    acquisitionId: 'capability-acquisition:release-ready',
    results: [
      {
        truthFingerprint: '2'.repeat(64),
        formattedBrief: 'Andrea release-readiness brief\nBlockers: none.',
        evidenceRefs: ['workspace-head:abc'],
      },
    ],
    receiptIds: ['effect-receipt:release-ready'],
    evidenceRefs: ['workspace-head:abc'],
    postconditionFingerprint: '3'.repeat(64),
    providerCalls: 0,
    costUsd: 0,
    latencyMs: 12,
    reason: 'Independently verified.',
    ...overrides,
  };
}

function matched(
  record: CapabilityAcquisitionRecord,
  overrides: Partial<ActiveCapabilityMatch> = {},
): ActiveCapabilityMatch {
  return {
    status: 'matched',
    acquisition: record,
    contract: compiledReleaseReadinessContract(),
    confidence: 1,
    candidateIds: [record.acquisitionId],
    resourceVersionDigest: '4'.repeat(64),
    reason: 'Exact active contract matched.',
    ...overrides,
  };
}

function status(
  record: CapabilityAcquisitionRecord,
  run: CapabilityProductionRunRecord,
): CapabilityApprenticeshipStatus {
  return {
    acquisition: record,
    runs: [run],
    pendingAction: 'monitoring',
    stateLabel: record.state,
    ownerControlSummary: 'Owner controls remain separate.',
  };
}

function successfulDependencies(params: {
  channel: string;
  chatJid: string;
  groupFolder?: string;
}) {
  const record = acquisition({ groupFolder: params.groupFolder || 'main' });
  const activeCanary = canary(params);
  const match = vi.fn(() => matched(record));
  const getStatus = vi.fn(() => status(record, activeCanary));
  const listHealth = vi.fn(() => [health()]);
  const refreshHealth = vi.fn<
    ReleaseReadinessActiveReuseDependencies['refreshHealth']
  >(async () => null);
  const staged = reuseRun(activeCanary);
  const stage = vi.fn(() => staged);
  const execute = vi.fn(async () => executionResult());
  const dependencies = {
    match,
    getStatus,
    listHealth,
    refreshHealth,
    stage,
    execute,
  } satisfies Partial<ReleaseReadinessActiveReuseDependencies>;
  return {
    record,
    activeCanary,
    staged,
    dependencies,
    match,
    getStatus,
    listHealth,
    refreshHealth,
    stage,
    execute,
  };
}

describe('active release-readiness semantic reuse', () => {
  const originalDisable = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
  const originalCanonical = process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const originalAliases = process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDisable == null) {
      delete process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE;
    } else {
      process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = originalDisable;
    }
    if (originalCanonical == null) {
      delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    } else {
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID = originalCanonical;
    }
    if (originalAliases == null) {
      delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    } else {
      process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = originalAliases;
    }
  });

  it('recognizes only bounded release-readiness semantic variants', () => {
    for (const text of [
      'Is Andrea ready to release?',
      'Are we ready for release?',
      'Is this build ready to ship?',
      'What blocks a safe demo?',
      'Give me a current release-readiness brief.',
      'Please show me the current release readiness status.',
    ]) {
      expect(isReleaseReadinessActiveReuseRequest(text), text).toBe(true);
    }
    for (const text of [
      'Release it',
      'Deploy this build',
      'Push main and tell me if it is ready',
      'Are we ready to release and, if so, deploy it?',
      'Show capability status',
      'Helpful',
      'Activate release readiness',
    ]) {
      expect(isReleaseReadinessActiveReuseRequest(text), text).toBe(false);
    }
  });

  it('keeps the semantic request on the tool-free direct runtime and handles it before generic cognition', () => {
    const policy = classifyAssistantRequest([
      { content: 'Is Andrea ready to release?' },
    ]);
    expect(policy).toMatchObject({
      route: 'direct_assistant',
      builtinTools: [],
      mcpTools: [],
    });

    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const call = source.indexOf(
      'if (await tryHandleActiveReleaseReadinessReuse())',
    );
    const directRouteGuard = source.lastIndexOf(
      "requestPolicy.route === 'direct_assistant'",
      call,
    );
    const genericLearning = source.indexOf(
      'if (await tryHandleLearningStatus())',
      call,
    );
    expect(source).toContain('shouldHandleReleaseReadinessReuseLocally ||');
    expect(directRouteGuard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(directRouteGuard);
    expect(genericLearning).toBeGreaterThan(call);
  });

  it('executes a fresh verified zero-egress reuse from the trusted Telegram direct runtime', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Is Andrea ready to release?',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );

    expect(result).toMatchObject({
      handled: true,
      action: 'verified',
      runId: setup.staged.runId,
    });
    expect(result.text).toContain('Andrea release-readiness brief');
    expect(result.text).toContain('provider calls: 0; cost: $0');
    expect(setup.match).toHaveBeenCalledWith({
      groupFolder: 'main',
      taskFamily: 'release_readiness',
      triggerText: 'Is Andrea ready to release?',
      inputs: { targetScopeKey: 'release-readiness' },
      intendedPostconditions: [
        'brief reports repository and serving provenance truth',
        'brief reports runtime, bridge, integration, proof, and disk truth',
        'brief identifies exact blockers and next actions without stale proof claims',
      ],
      binding: {
        ownerId: 'owner',
        chatId: TELEGRAM_CHAT,
        groupId: 'main',
        channel: 'telegram',
        targetScopeKey: 'release-readiness',
      },
      currentResourceVersions: {
        'andrea.release_readiness_truth': '1.0.0',
      },
      now: NOW,
    });
    expect(setup.listHealth).toHaveBeenCalledWith({
      subjectId: 'capability-resource:andrea.release_readiness_truth',
      limit: 100,
    });
    expect(setup.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskFamily: 'release_readiness',
        triggerText: 'Is Andrea ready to release?',
        intendedPostconditions: [
          'brief reports repository and serving provenance truth',
          'brief reports runtime, bridge, integration, proof, and disk truth',
          'brief identifies exact blockers and next actions without stale proof claims',
        ],
        normalizedInputs: { targetScopeKey: 'release-readiness' },
        workerId: 'andrea:release-readiness-active-reuse',
        health: [
          {
            resourceId: 'andrea.release_readiness_truth',
            observationId: 'release-readiness-health:fresh',
            expiresAt: '2026-07-15T12:20:00.000Z',
          },
        ],
      }),
    );
    expect(setup.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: setup.staged.runId,
        expectedAcquisitionVersion: setup.record.recordVersion,
        expectedRunRevision: 1,
        binding: {
          ownerId: 'owner',
          chatId: TELEGRAM_CHAT,
          groupId: 'main',
          channel: 'telegram',
          targetScopeKey: 'release-readiness',
        },
        workerId: 'andrea:release-readiness-active-reuse',
        values: { targetScopeKey: 'release-readiness' },
      }),
    );
  });

  it('reports deterministic bounded match, health, stage, execute, and total timing', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const ticks = [0, 5, 15, 25, 35, 50];
    const monotonicNow = vi.fn(() => ticks.shift() as number);

    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Is Andrea ready to release?',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      { ...setup.dependencies, monotonicNow },
    );

    expect(result.timings).toEqual({
      matchMs: 10,
      healthMs: 10,
      stageMs: 10,
      executeMs: 15,
      totalMs: 50,
    });
    expect(result.text).toContain(
      'Dispatch timing (local): match 10 ms · health 10 ms · stage 10 ms · execute 15 ms · total 50 ms.',
    );
    expect(monotonicNow).toHaveBeenCalledTimes(6);
  });

  it('does not enter matching, health, staging, or execution for ordinary chat', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Help me summarize this ordinary note.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );

    expect(result.handled).toBe(false);
    expect(setup.match).not.toHaveBeenCalled();
    expect(setup.getStatus).not.toHaveBeenCalled();
    expect(setup.listHealth).not.toHaveBeenCalled();
    expect(setup.refreshHealth).not.toHaveBeenCalled();
    expect(setup.stage).not.toHaveBeenCalled();
    expect(setup.execute).not.toHaveBeenCalled();
  });

  it('executes only on an explicitly configured BlueBubbles self-thread', async () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    const setup = successfulDependencies({
      channel: 'bluebubbles',
      chatJid: BLUEBUBBLES_CHAT,
    });

    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'bluebubbles',
        chatJid: BLUEBUBBLES_CHAT,
        group: blueBubblesGroup,
        now: NOW,
      },
      setup.dependencies,
    );

    expect(result.action).toBe('verified');
    expect(setup.stage).toHaveBeenCalledOnce();
    expect(setup.execute).toHaveBeenCalledOnce();
  });

  it('restricts unconfigured BlueBubbles aliases before any capability read', async () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    const setup = successfulDependencies({
      channel: 'bluebubbles',
      chatJid: 'bb:iMessage;-;+12025550101',
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;+12025550101',
        group: blueBubblesGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('restricted');
    expect(setup.match).not.toHaveBeenCalled();
    expect(setup.getStatus).not.toHaveBeenCalled();
    expect(setup.listHealth).not.toHaveBeenCalled();
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it('does not stage when no active contract matches', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.match.mockReturnValue({
      status: 'none',
      confidence: 0,
      candidateIds: [],
      reason: 'No match.',
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'What blocks a safe demo?',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('not_active');
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it('does not choose between ambiguous active contracts', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.match.mockReturnValue({
      status: 'ambiguous',
      confidence: 0.9,
      candidateIds: [
        'capability-acquisition:one',
        'capability-acquisition:two',
      ],
      reason: 'Ambiguous.',
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Give me a current release-readiness brief.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('ambiguous');
    expect(result.text).toContain('capability-acquisition:one');
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it.each([
    ['chat', { chatScopeHash: durableScopeHash('chat', 'tg:attacker') }],
    ['group', { groupScopeHash: durableScopeHash('group', 'other') }],
    ['target', { targetScopeHash: durableScopeHash('target', 'other') }],
    ['channel', { channel: 'bluebubbles' }],
    ['surface', { authorizedSurface: 'owner_cockpit' }],
  ])(
    'rejects a %s-bound active canary before staging',
    async (_label, overrides) => {
      const setup = successfulDependencies({
        channel: 'telegram',
        chatJid: TELEGRAM_CHAT,
      });
      setup.getStatus.mockReturnValue(
        status(
          setup.record,
          canary({
            channel: 'telegram',
            chatJid: TELEGRAM_CHAT,
            overrides,
          }),
        ),
      );
      const result = await dispatchActiveReleaseReadinessReuse(
        {
          text: 'Are we ready to release?',
          channelName: 'telegram',
          chatJid: TELEGRAM_CHAT,
          group: mainGroup,
          now: NOW,
        },
        setup.dependencies,
      );
      expect(result.action).toBe('scope_mismatch');
      expect(setup.stage).not.toHaveBeenCalled();
    },
  );

  it('requires fresh, non-future successful health before staging', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.listHealth.mockReturnValue([
      health({ observedAt: '2026-07-15T11:29:59.999Z' }),
      health({
        observationId: 'release-readiness-health:future',
        observedAt: '2026-07-15T12:00:00.001Z',
      }),
      health({
        observationId: 'release-readiness-health:failed',
        outcome: 'failed',
      }),
    ]);
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('freshness_gap');
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it('refreshes an expired 31-minute health proof before successful dispatch', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.listHealth.mockReturnValue([
      health({
        observationId: 'release-readiness-health:expired',
        observedAt: '2026-07-15T11:29:00.000Z',
      }),
    ]);
    setup.refreshHealth.mockResolvedValue({
      resourceId: 'andrea.release_readiness_truth',
      observationId: 'release-readiness-health:refreshed',
      expiresAt: '2026-07-15T12:30:00.000Z',
    });

    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );

    expect(result.action).toBe('verified');
    expect(setup.refreshHealth).toHaveBeenCalledWith({
      acquisitionId: setup.record.acquisitionId,
      groupFolder: 'main',
      now: NOW,
    });
    expect(setup.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        health: [
          {
            resourceId: 'andrea.release_readiness_truth',
            observationId: 'release-readiness-health:refreshed',
            expiresAt: '2026-07-15T12:30:00.000Z',
          },
        ],
      }),
    );
    expect(setup.execute).toHaveBeenCalledOnce();
  });

  it('refreshes health only through the exact active local zero-provider binding', async () => {
    const record = acquisition();
    const contract = compiledReleaseReadinessContract();
    const step = contract.steps[0]!;
    const execute = vi.fn(async () => ({
      result: { formattedBrief: 'bounded local truth' },
      evidenceRefs: ['workspace-head:abc123'],
      effectClass: 'read_only' as const,
      effectStatus: 'none' as const,
      preStateFingerprint: '5'.repeat(64),
      postStateFingerprint: '5'.repeat(64),
      providerCalls: 0,
      costUsd: 0,
    }));
    const executor: ProductionCapabilityExecutorBinding = {
      bindingId: step.bindingId,
      operationId: step.operationId,
      resourceId: step.resourceId,
      version: step.version,
      executorImplementationDigest: step.executorImplementationDigest,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'loopback',
      maximumCostUsd: 0,
      execute,
    };
    const verify = vi.fn(async () => ({
      verified: true,
      evidenceRefs: ['integration-doctor:current'],
      verifiedPostconditions: [...contract.successPostconditions],
      postconditionFingerprint: '6'.repeat(64),
      reason: 'A later bounded local read agreed.',
    }));
    const evaluator: ProductionCapabilityEvaluatorBinding = {
      evaluatorId: step.evaluatorId,
      operationId: step.operationId,
      resourceId: step.resourceId,
      version: step.version,
      evaluatorImplementationDigest: step.evaluatorImplementationDigest,
      verify,
    };
    const getAcquisition = vi.fn(() => record);
    const recordObservation = vi.fn();

    const refreshed = await refreshActiveReleaseReadinessHealth(
      {
        acquisitionId: record.acquisitionId,
        groupFolder: 'main',
        now: NOW,
      },
      {
        getAcquisition,
        resolveBindings: () => ({ executor, evaluator }),
        recordObservation,
      },
    );

    expect(refreshed).toMatchObject({
      resourceId: 'andrea.release_readiness_truth',
      expiresAt: '2026-07-15T12:30:00.000Z',
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        values: { targetScopeKey: 'release-readiness' },
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(verify).toHaveBeenCalledOnce();
    expect(recordObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'verified_usage',
        outcome: 'success',
        confidence: 1,
        fallbackUsed: false,
      }),
    );
    expect(
      JSON.parse(recordObservation.mock.calls[0]![0].privacyJson),
    ).toMatchObject({
      providerCalls: 0,
      externalNetwork: false,
      authorityExpanded: false,
    });
  });

  it('refuses health evidence from external-network or provider-using probes', async () => {
    const record = acquisition();
    const contract = compiledReleaseReadinessContract();
    const step = contract.steps[0]!;
    const baseExecutor: ProductionCapabilityExecutorBinding = {
      bindingId: step.bindingId,
      operationId: step.operationId,
      resourceId: step.resourceId,
      version: step.version,
      executorImplementationDigest: step.executorImplementationDigest,
      actionClass: 'local_lookup',
      effectClass: 'read_only',
      networkAccess: 'loopback',
      maximumCostUsd: 0,
      async execute() {
        return {
          result: {},
          evidenceRefs: ['workspace-head:abc123'],
          effectClass: 'read_only',
          effectStatus: 'none',
          postStateFingerprint: '5'.repeat(64),
          providerCalls: 1,
          costUsd: 0,
        };
      },
    };
    const evaluator: ProductionCapabilityEvaluatorBinding = {
      evaluatorId: step.evaluatorId,
      operationId: step.operationId,
      resourceId: step.resourceId,
      version: step.version,
      evaluatorImplementationDigest: step.evaluatorImplementationDigest,
      async verify() {
        return {
          verified: true,
          evidenceRefs: ['integration-doctor:current'],
          verifiedPostconditions: [...contract.successPostconditions],
          postconditionFingerprint: '6'.repeat(64),
          reason: 'verified',
        };
      },
    };
    const recordObservation = vi.fn();
    const getAcquisition = vi.fn(() => record);

    for (const executor of [
      { ...baseExecutor, networkAccess: 'external' as const },
      baseExecutor,
    ]) {
      await expect(
        refreshActiveReleaseReadinessHealth(
          {
            acquisitionId: record.acquisitionId,
            groupFolder: 'main',
            now: NOW,
          },
          {
            getAcquisition,
            resolveBindings: () => ({ executor, evaluator }),
            recordObservation,
          },
        ),
      ).resolves.toBeNull();
    }
    expect(recordObservation).not.toHaveBeenCalled();
  });

  it('rejects noncanonical contract and resource authority changes', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const canonical = compiledReleaseReadinessContract();
    setup.match.mockReturnValue(
      matched(setup.record, {
        contract: {
          ...canonical,
          candidateFingerprint: '9'.repeat(64),
          approvalRequirements: ['fresh approval'],
        },
      }),
    );
    let result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('version_gap');
    expect(setup.stage).not.toHaveBeenCalled();

    const resource = releaseReadinessCapabilityResource();
    result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      {
        ...setup.dependencies,
        getResource: () => ({
          ...resource,
          authorityRequirement: 'explicit_approval',
        }),
      },
    );
    expect(result.action).toBe('version_gap');
    expect(setup.match).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'trigger semantics',
      (contract: CapabilityCandidateContract) => ({
        ...contract,
        triggerSemantics: ['release it now'],
      }),
    ],
    [
      'postconditions',
      (contract: CapabilityCandidateContract) => ({
        ...contract,
        successPostconditions: ['looks plausible'],
      }),
    ],
    [
      'executor digest',
      (contract: CapabilityCandidateContract) => ({
        ...contract,
        steps: contract.steps.map((step) => ({
          ...step,
          executorImplementationDigest: '8'.repeat(64),
        })),
      }),
    ],
    [
      'credential requirement',
      (contract: CapabilityCandidateContract) => ({
        ...contract,
        credentialRequirements: ['provider credential'],
      }),
    ],
  ])('rejects drift in exact %s before staging', async (_label, mutate) => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const contract = mutate(compiledReleaseReadinessContract());
    setup.match.mockReturnValue(matched(setup.record, { contract }));
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('version_gap');
    expect(setup.getStatus).not.toHaveBeenCalled();
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it('requires exact active acquisition policy and canary fingerprint', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    const paid = acquisition({ expectedCostBand: 'low' });
    setup.match.mockReturnValue(matched(paid));
    let result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('version_gap');
    expect(setup.stage).not.toHaveBeenCalled();

    setup.match.mockReturnValue(matched(setup.record));
    setup.getStatus.mockReturnValue(
      status(
        setup.record,
        canary({
          channel: 'telegram',
          chatJid: TELEGRAM_CHAT,
          overrides: { candidateFingerprint: '7'.repeat(64) },
        }),
      ),
    );
    result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('scope_mismatch');
    expect(setup.stage).not.toHaveBeenCalled();
  });

  it('fails closed when freshness changes during staging', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.stage.mockImplementation(() => {
      throw new Error(
        'Active capability resource versions changed after matching.',
      );
    });
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Show release readiness.',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('freshness_gap');
    expect(setup.execute).not.toHaveBeenCalled();
  });

  it('does not claim success for verifier failure, cost, or provider use', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.execute.mockResolvedValue(
      executionResult({ providerCalls: 1, costUsd: 0.01 }),
    );
    const result = await dispatchActiveReleaseReadinessReuse(
      {
        text: 'Is this build ready to ship?',
        channelName: 'telegram',
        chatJid: TELEGRAM_CHAT,
        group: mainGroup,
        now: NOW,
      },
      setup.dependencies,
    );
    expect(result.action).toBe('execution_failed');
    expect(result.text).not.toContain('independent postcondition check passed');
  });

  it('propagates unrelated staging failures instead of hiding them', async () => {
    const setup = successfulDependencies({
      channel: 'telegram',
      chatJid: TELEGRAM_CHAT,
    });
    setup.stage.mockImplementation(() => {
      throw new Error('database filesystem is unavailable');
    });
    await expect(
      dispatchActiveReleaseReadinessReuse(
        {
          text: 'Show release readiness.',
          channelName: 'telegram',
          chatJid: TELEGRAM_CHAT,
          group: mainGroup,
          now: NOW,
        },
        setup.dependencies,
      ),
    ).rejects.toThrow('database filesystem is unavailable');
    expect(setup.execute).not.toHaveBeenCalled();
  });
});
