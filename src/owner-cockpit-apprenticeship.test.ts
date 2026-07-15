import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apprenticeship = vi.hoisted(() => ({
  applyControl: vi.fn(),
  authorizeActivation: vi.fn(),
  getStatus: vi.fn(),
  issueControlToken: vi.fn(),
  issueReviewToken: vi.fn(),
  recordVerdict: vi.fn(),
  stageActivation: vi.fn(),
}));

vi.mock('./production-capability-apprenticeship.js', () => ({
  applyCapabilityOwnerControl: apprenticeship.applyControl,
  authorizeApprovedCapabilityActivation: apprenticeship.authorizeActivation,
  getCapabilityApprenticeshipStatus: apprenticeship.getStatus,
  issueCapabilityControlTokenForAuthenticatedCockpit:
    apprenticeship.issueControlToken,
  issueCapabilityReviewTokenForAuthenticatedCockpit:
    apprenticeship.issueReviewToken,
  recordCapabilityOwnerVerdict: apprenticeship.recordVerdict,
  runCapabilityProductionExecution: vi.fn(),
  stageCapabilityActivation: apprenticeship.stageActivation,
}));

import {
  _closeDatabase,
  _initTestDatabase,
  insertCapabilityProductionRun,
  insertDurableWorkCheckpoint,
  insertDurableWorkUnit,
  listCognitiveApprovalPackets,
  upsertCognitiveApprovalPacket,
  upsertCognitiveRun,
} from './db.js';
import { durableScopeHash } from './durable-work-continuity.js';
import {
  createOwnerCockpitHttpServer,
  type OwnerCockpitConfig,
} from './owner-cockpit-server.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityProductionRunRecord,
  DurableWorkCheckpoint,
  DurableWorkEvent,
  DurableWorkUnit,
} from './types.js';
import { observeCapabilityGap } from './verified-capability-acquisition.js';

const config: OwnerCockpitConfig = {
  enabled: true,
  host: '127.0.0.1',
  port: 4320,
  secret: 'a-test-secret-that-is-long-enough',
  sessionMinutes: 30,
  groupFolder: 'main',
};

const servers: ReturnType<typeof createOwnerCockpitHttpServer>[] = [];

function productionRun(
  acquisition: CapabilityAcquisitionRecord,
  overrides: Partial<CapabilityProductionRunRecord> = {},
): CapabilityProductionRunRecord {
  return {
    runId: 'capability-run:owner-cockpit-fixture',
    acquisitionId: acquisition.acquisitionId,
    createdAt: '2026-07-15T12:01:00.000Z',
    updatedAt: '2026-07-15T12:02:00.000Z',
    runKind: 'canary',
    status: 'awaiting_owner_review',
    revision: 4,
    candidateFingerprint: 'a'.repeat(64),
    contractVersion: 1,
    contractDigest: 'b'.repeat(64),
    taskFamily: acquisition.taskFamily,
    groupFolder: 'main',
    ownerScopeHash: durableScopeHash('owner', 'owner'),
    chatScopeHash: durableScopeHash('chat', 'cockpit'),
    groupScopeHash: durableScopeHash('group', 'main'),
    channel: 'owner_cockpit',
    authorizedSurface: 'owner_cockpit',
    targetScopeHash: durableScopeHash('target', 'fixture-target'),
    inputDigest: '0'.repeat(64),
    actionClass: 'local_lookup',
    workId: 'durable-work:fixture',
    workVersion: 2,
    planVersion: 1,
    checkpointId: 'durable-checkpoint:fixture',
    invocationId: 'capability-invocation:fixture',
    canaryApprovalPacketId: 'capability-approval:fixture',
    canaryApprovalVersion: 1,
    canaryApprovalScopeDigest: '1'.repeat(64),
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
    outcomeId: 'capability-outcome:fixture',
    ownerReviewId: null,
    healthEvidenceSetDigest: '2'.repeat(64),
    postconditionFingerprint: '3'.repeat(64),
    resourceDiscoveryCalls: 1,
    candidateDesignCalls: 1,
    toolSelectionCalls: 1,
    executionCalls: 1,
    evaluatorCalls: 1,
    latencyMs: 125,
    providerCalls: 0,
    costUsd: 0,
    matchConfidence: 0.92,
    expiresAt: '2026-07-15T13:00:00.000Z',
    completedAt: null,
    nextSafeAction: 'Private raw next action must not reach the cockpit.',
    privacyJson: '{"metadataOnly":true}',
    ...overrides,
  };
}

function seedCapability() {
  const acquisition = observeCapabilityGap({
    metadataClassification: 'derived_metadata',
    groupFolder: 'main',
    targetOutcome:
      'PRIVATE raw owner request at /Users/owner/private should never render.',
    postconditions: ['PRIVATE document body should never render.'],
    taskFamily: 'cockpit_fixture',
    gapKind: 'tool_usage_gap',
    provenanceRefs: ['PRIVATE raw provenance'],
    evidenceOrigin: 'synthetic',
    environmentFingerprint: 'fixture-environment-v1',
    now: new Date('2026-07-15T12:00:00.000Z'),
  });
  const run = productionRun(acquisition);
  apprenticeship.getStatus.mockReturnValue({
    acquisition,
    runs: [run],
    pendingAction: 'owner_review',
    stateLabel: acquisition.state,
    ownerControlSummary: 'Metadata only.',
  });
  apprenticeship.issueReviewToken.mockReturnValue('private-review-token');
  apprenticeship.issueControlToken.mockImplementation(
    ({ actionKind }: { actionKind: string }) => `private-${actionKind}-token`,
  );
  apprenticeship.recordVerdict.mockReturnValue({
    acquisition,
    run: { ...run, status: 'owner_reviewed', revision: 5 },
    receipt: {
      receiptId: 'capability-production-receipt:review-fixture',
    },
  });
  apprenticeship.stageActivation.mockReturnValue({
    run: {
      ...run,
      status: 'awaiting_activation_approval',
      revision: run.revision + 1,
      activationApprovalPacketId: 'capability-activation-approval:fixture',
    },
    approval: {
      approvalPacketId: 'capability-activation-approval:fixture',
      status: 'staged',
      actionClass: 'operator_change',
      approvalVersion: 1,
      scopeDigest: '4'.repeat(64),
      expiresAt: '2026-07-15T13:00:00.000Z',
      summary: 'PRIVATE activation approval summary must not be returned.',
    },
  });
  apprenticeship.authorizeActivation.mockReturnValue({
    acquisition: {
      ...acquisition,
      state: 'active',
      recordVersion: acquisition.recordVersion + 1,
    },
    run: { ...run, status: 'active', revision: run.revision + 2 },
    receipt: {
      receiptId: 'capability-production-receipt:activation-fixture',
    },
  });
  apprenticeship.applyControl.mockImplementation(
    ({ token }: { token: string }) => {
      const action = token.replace(/^private-/, '').replace(/-token$/, '');
      return {
        acquisition: {
          ...acquisition,
          state:
            action === 'pause'
              ? 'paused'
              : action === 'retire'
                ? 'retired'
                : action === 'revoke'
                  ? 'quarantined'
                  : acquisition.state,
          recordVersion: acquisition.recordVersion + 1,
        },
        run,
        receipt: {
          receiptId: `capability-production-receipt:${action}-fixture`,
        },
      };
    },
  );
  return { acquisition, run };
}

function insertCurrentActionWork(
  run: CapabilityProductionRunRecord,
  approvalPacketId: string,
): void {
  const work: DurableWorkUnit = {
    workId: run.workId,
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    status: 'awaiting_approval',
    version: run.workVersion,
    planVersion: run.planVersion,
    originTurnHash: '4'.repeat(64),
    authorizedSurface: run.authorizedSurface,
    ownerScopeHash: run.ownerScopeHash,
    chatScopeHash: run.chatScopeHash,
    groupScopeHash: run.groupScopeHash,
    channel: run.channel,
    goalSummary: 'Approve one exact protected plan.',
    missionId: null,
    goalId: null,
    runtimeRunId: null,
    agentOSEpisodeId: null,
    trajectoryId: null,
    cognitiveRunId: 'cognitive:trusted-chat-action',
    deepWorkPacketId: null,
    approvalPacketId,
    approvalVersion: 1,
    checkpointHeadId: run.checkpointId,
    planId: null,
    targetScopeHash: run.targetScopeHash,
    executionEvidenceRefsJson: '[]',
    deliveryState: 'not_started',
    ownerReviewId: null,
    skillCandidateId: null,
    leaseId: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    expiresAt: null,
    interruptedAt: null,
    completedAt: null,
    nextAction: 'Wait for the exact trusted-chat decision.',
    privacyJson: '{"metadataOnly":true}',
  };
  const createdEvent: DurableWorkEvent = {
    eventId: 'durable:event:trusted-chat-action',
    workId: run.workId,
    createdAt: '2026-07-15T12:00:00.000Z',
    eventKind: 'created',
    fromStatus: null,
    toStatus: 'awaiting_approval',
    workVersion: run.workVersion,
    planVersion: run.planVersion,
    summary: 'Created action-approval fixture work.',
    refsJson: '[]',
    privacyJson: '{"metadataOnly":true}',
  };
  insertDurableWorkUnit({ record: work, createdEvent });
}

function insertProductionRunDurableState(
  run: CapabilityProductionRunRecord,
): void {
  const initialWorkVersion = run.workVersion - 1;
  if (initialWorkVersion < 1) {
    throw new Error(
      'Production-run fixture requires a post-checkpoint version.',
    );
  }
  const createdAt = run.createdAt;
  const work: DurableWorkUnit = {
    workId: run.workId,
    createdAt,
    updatedAt: createdAt,
    status: 'planned',
    version: initialWorkVersion,
    planVersion: run.planVersion,
    originTurnHash: durableScopeHash('origin', run.runId),
    authorizedSurface: run.authorizedSurface,
    ownerScopeHash: run.ownerScopeHash,
    chatScopeHash: run.chatScopeHash,
    groupScopeHash: run.groupScopeHash,
    channel: run.channel,
    goalSummary: 'Persist one bounded cockpit pagination fixture.',
    missionId: null,
    goalId: null,
    runtimeRunId: null,
    agentOSEpisodeId: null,
    trajectoryId: null,
    cognitiveRunId: null,
    deepWorkPacketId: null,
    approvalPacketId: null,
    approvalVersion: null,
    checkpointHeadId: null,
    planId: null,
    targetScopeHash: run.targetScopeHash,
    executionEvidenceRefsJson: '[]',
    deliveryState: 'not_started',
    ownerReviewId: null,
    skillCandidateId: null,
    leaseId: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    expiresAt: null,
    interruptedAt: null,
    completedAt: null,
    nextAction: 'Preserve the exact persisted approval boundary.',
    privacyJson: '{"metadataOnly":true}',
  };
  insertDurableWorkUnit({
    record: work,
    createdEvent: {
      eventId: `durable:event:created:${run.runId}`,
      workId: run.workId,
      createdAt,
      eventKind: 'created',
      fromStatus: null,
      toStatus: work.status,
      workVersion: initialWorkVersion,
      planVersion: run.planVersion,
      summary: 'Created persisted pagination fixture work.',
      refsJson: '[]',
      privacyJson: '{"metadataOnly":true}',
    },
  });
  const checkpoint: DurableWorkCheckpoint = {
    durableCheckpointId: run.checkpointId,
    workId: run.workId,
    runtimeCheckpointId: null,
    parentCheckpointId: null,
    createdAt,
    updatedAt: run.updatedAt,
    status: 'open',
    workVersion: run.workVersion,
    planVersion: run.planVersion,
    sequence: 1,
    completedNodeIdsJson: '[]',
    pendingNodeIdsJson: '[]',
    uncertainNodeIdsJson: '[]',
    dependencyIdsJson: '[]',
    worldSignalStateJson: '{"fresh":[],"stale":[],"missing":[]}',
    approvalScopeJson: '{}',
    executorScopeHash: durableScopeHash('executor', run.runId),
    targetScopeHash: run.targetScopeHash,
    preStateFingerprint: null,
    verifiedPostStateFingerprint: null,
    receiptIdsJson: '[]',
    verificationRequirementsJson: '[]',
    retryBudget: 1,
    attemptsUsed: 0,
    stopConditionsJson: '[]',
    recoveryPolicy: 'approval_required',
    nextSafeAction: 'Wait for the exact owner decision.',
    privacyJson: '{"metadataOnly":true}',
  };
  const committed = insertDurableWorkCheckpoint({
    checkpoint,
    expectedWorkVersion: initialWorkVersion,
    event: {
      eventId: `durable:event:checkpoint:${run.runId}`,
      workId: run.workId,
      createdAt: run.updatedAt,
      eventKind: 'checkpoint',
      fromStatus: work.status,
      toStatus: work.status,
      workVersion: run.workVersion,
      planVersion: run.planVersion,
      summary: 'Committed persisted pagination fixture checkpoint.',
      refsJson: JSON.stringify([run.checkpointId]),
      privacyJson: '{"metadataOnly":true}',
    },
  });
  if (!committed) {
    throw new Error('Could not commit production-run fixture checkpoint.');
  }
}

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  _closeDatabase();
});

async function start() {
  const server = createOwnerCockpitHttpServer(config);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function authenticate(base: string) {
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    body: new URLSearchParams({ secret: config.secret }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]!;
  const response = await fetch(`${base}/api/v1/snapshot`, {
    headers: { cookie },
  });
  const snapshot = (await response.json()) as {
    csrfToken: string;
    apprenticeship: unknown;
    approvals: Array<{ id: string }>;
  };
  return { cookie, snapshot };
}

function post(input: {
  base: string;
  cookie?: string;
  csrfToken?: string;
  path: string;
  body: Record<string, unknown>;
}) {
  return fetch(`${input.base}${input.path}`, {
    method: 'POST',
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.csrfToken
        ? { 'x-csrf-token': input.csrfToken, origin: input.base }
        : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
  });
}

describe('owner cockpit production capability apprenticeship', () => {
  it('projects only bounded metadata, metrics, and evidence identifiers', async () => {
    const { run } = seedCapability();
    const base = await start();
    const { snapshot } = await authenticate(base);
    const serialized = JSON.stringify(snapshot.apprenticeship);

    expect(snapshot.apprenticeship).toMatchObject({
      metrics: {
        acquisitionCount: 1,
        runCount: 1,
        pendingOwnerReviewCount: 1,
        totalLatencyMs: 125,
        totalCostUsd: 0,
      },
      acquisitions: [
        {
          taskFamily: 'cockpit_fixture',
          pendingAction: 'owner_review',
          activationProposalRunId: null,
          activationRunId: null,
          activationAvailable: false,
          activationGuidance: expect.stringContaining(
            'no active-reuse request lane',
          ),
          ownerReviewRunId: run.runId,
          runs: [
            {
              id: run.runId,
              status: 'awaiting_owner_review',
              reviewEligible: true,
              metrics: { latencyMs: 125, providerCalls: 0, costUsd: 0 },
            },
          ],
        },
      ],
    });
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('targetOutcome');
    expect(serialized).not.toContain('candidateContractJson');
    expect(serialized).not.toContain('nextSafeAction');
    expect(serialized).not.toContain('private-review-token');
    expect(serialized).toContain('capability-outcome:fixture');
  });

  it('shows truthful canary staging as the next action for a prepared acquisition', async () => {
    const { acquisition } = seedCapability();
    apprenticeship.getStatus.mockReturnValue({
      acquisition: {
        ...acquisition,
        state: 'owner_review_required',
      },
      runs: [],
      pendingAction: 'none',
      stateLabel: 'owner_review_required',
      ownerControlSummary: 'Metadata only.',
    });
    const base = await start();
    const { snapshot } = await authenticate(base);

    expect(snapshot.apprenticeship).toMatchObject({
      acquisitions: [
        {
          state: 'owner_review_required',
          pendingAction: 'canary_staging',
          activationAvailable: false,
        },
      ],
    });
  });

  it('keeps a trusted-chat action packet as evidence metadata and never relabels it', async () => {
    const { acquisition, run } = seedCapability();
    const approvalPacketId = 'approval:trusted-chat-action';
    const cognitiveRunId = 'cognitive:trusted-chat-action';
    const chatRun = {
      ...run,
      status: 'awaiting_action_approval' as const,
      channel: 'telegram',
      authorizedSurface: 'telegram',
      chatScopeHash: durableScopeHash('chat', 'tg:owner'),
      outcomeId: null,
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition,
      runs: [chatRun],
      pendingAction: 'action_approval',
      stateLabel: acquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    upsertCognitiveRun({
      runId: cognitiveRunId,
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
      groupFolder: 'main',
      channel: 'telegram',
      taskFamily: 'release_readiness',
      turnId: null,
      runOrigin: 'live',
      goalSummary: 'Approve one bounded protected action.',
      selectedSkillId: 'protected-action',
      status: 'awaiting_approval',
      autonomyLevel: 'none',
      cognitiveMode: 'approval_staged',
      taskGraphJson: '{}',
      evidenceContractJson: '{}',
      providerUsabilityJson: '{}',
      councilRunId: null,
      verificationJson: '{}',
      outcomeScore: 0,
      nextAction: 'Wait for exact Telegram approval.',
      privacyJson: '{"metadataOnly":true}',
      linkedSkillCardId: null,
    });
    insertCurrentActionWork(chatRun, approvalPacketId);
    upsertCognitiveApprovalPacket({
      approvalPacketId,
      createdAt: '2026-07-15T12:00:00.000Z',
      updatedAt: '2026-07-15T12:00:00.000Z',
      runId: cognitiveRunId,
      toolId: 'durable:operator_change',
      actionClass: 'operator_change',
      status: 'staged',
      summary: 'Approve the exact trusted-chat action.',
      approvalChannel: null,
      approvalKey: 'trusted-chat-action',
      expiresAt: '2099-01-01T00:00:00.000Z',
      approvalVersion: 1,
      scopeDigest: '5'.repeat(64),
      durableWorkId: chatRun.workId,
      durableCheckpointId: chatRun.checkpointId,
      planVersion: chatRun.planVersion,
      targetScopeDigest: chatRun.targetScopeHash,
      decisionJson: '{}',
      privacyJson: '{"metadataOnly":true}',
    });

    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    expect(snapshot.approvals.map((approval) => approval.id)).not.toContain(
      approvalPacketId,
    );
    expect(JSON.stringify(snapshot.apprenticeship)).toContain(approvalPacketId);
    expect(snapshot.apprenticeship).toMatchObject({
      acquisitions: [
        {
          pendingAction: 'action_approval',
          runs: [
            {
              status: 'awaiting_action_approval',
              evidenceIds: expect.arrayContaining([approvalPacketId]),
            },
          ],
        },
      ],
    });

    const response = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `/api/v1/approvals/${encodeURIComponent(approvalPacketId)}/confirm`,
      body: {
        confirmation: 'APPROVE',
        summary: 'Approve the exact trusted-chat action.',
        approvalVersion: 1,
        scopeDigest: '5'.repeat(64),
      },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('exact telegram conversation'),
    });
    expect(
      listCognitiveApprovalPackets({ groupFolder: 'main', limit: 20 }).find(
        (packet) => packet.approvalPacketId === approvalPacketId,
      )?.status,
    ).toBe('staged');
  });

  it.each(['telegram', 'bluebubbles'] as const)(
    'protects an older persisted %s packet outside the 20-acquisition cockpit window',
    async (surface) => {
      const statuses = new Map<
        string,
        ReturnType<typeof apprenticeship.getStatus>
      >();
      const olderAcquisition = observeCapabilityGap({
        metadataClassification: 'derived_metadata',
        groupFolder: 'main',
        targetOutcome: `Older ${surface} approval remains surface-bound.`,
        postconditions: ['The exact approval surface remains unchanged.'],
        taskFamily: `older_${surface}_approval`,
        gapKind: 'tool_usage_gap',
        provenanceRefs: [`fixture:${surface}:older`],
        evidenceOrigin: 'synthetic',
        environmentFingerprint: `fixture:${surface}:older`,
        now: new Date('2026-07-15T10:00:00.000Z'),
      });
      const approvalPacketId = `approval:outside-window:${surface}`;
      const chatJid =
        surface === 'telegram'
          ? 'tg:outside-window-owner'
          : 'bb:iMessage;-;outside-window-owner@example.invalid';
      const olderRun = productionRun(olderAcquisition, {
        runId: `capability-run:outside-window:${surface}`,
        createdAt: '2026-07-15T10:01:00.000Z',
        updatedAt: '2026-07-15T10:02:00.000Z',
        status: 'awaiting_canary_approval',
        channel: surface,
        authorizedSurface: surface,
        chatScopeHash: durableScopeHash('chat', chatJid),
        workId: `durable-work:outside-window:${surface}`,
        checkpointId: `durable-checkpoint:outside-window:${surface}`,
        invocationId: `capability-invocation:outside-window:${surface}`,
        canaryApprovalPacketId: approvalPacketId,
        outcomeId: null,
      });
      const cognitiveRunId = `cognitive:outside-window:${surface}`;
      upsertCognitiveRun({
        runId: cognitiveRunId,
        createdAt: '2026-07-15T10:00:00.000Z',
        updatedAt: '2026-07-15T10:00:00.000Z',
        groupFolder: 'main',
        channel: surface,
        taskFamily: olderAcquisition.taskFamily,
        turnId: null,
        runOrigin: 'live',
        goalSummary: 'Preserve the exact trusted-chat approval surface.',
        selectedSkillId: 'outside-window-approval',
        status: 'awaiting_approval',
        autonomyLevel: 'none',
        cognitiveMode: 'approval_staged',
        taskGraphJson: '{}',
        evidenceContractJson: '{}',
        providerUsabilityJson: '{}',
        councilRunId: null,
        verificationJson: '{}',
        outcomeScore: 0,
        nextAction: 'Wait for the same-chat owner decision.',
        privacyJson: '{"metadataOnly":true}',
        linkedSkillCardId: null,
      });
      upsertCognitiveApprovalPacket({
        approvalPacketId,
        createdAt: '2026-07-15T10:00:00.000Z',
        updatedAt: '2026-07-15T10:00:00.000Z',
        runId: cognitiveRunId,
        toolId: 'durable:operator_change',
        actionClass: 'operator_change',
        status: 'staged',
        summary: `Approve the older exact ${surface} canary.`,
        approvalChannel: null,
        approvalKey: `outside-window:${surface}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
        approvalVersion: 1,
        scopeDigest: olderRun.canaryApprovalScopeDigest,
        durableWorkId: null,
        durableCheckpointId: null,
        planVersion: null,
        targetScopeDigest: olderRun.targetScopeHash,
        decisionJson: '{}',
        privacyJson: '{"metadataOnly":true}',
      });
      insertProductionRunDurableState(olderRun);
      insertCapabilityProductionRun(olderRun);
      statuses.set(olderAcquisition.acquisitionId, {
        acquisition: olderAcquisition,
        runs: [olderRun],
        pendingAction: 'canary_approval',
        stateLabel: olderAcquisition.state,
        ownerControlSummary: 'Metadata only.',
      });

      for (let index = 0; index < 21; index += 1) {
        const newerAcquisition = observeCapabilityGap({
          metadataClassification: 'derived_metadata',
          groupFolder: 'main',
          targetOutcome: `Newer cockpit fixture ${index}.`,
          postconditions: [`Newer fixture ${index} remains bounded.`],
          taskFamily: `newer_cockpit_fixture_${index}`,
          gapKind: 'tool_usage_gap',
          provenanceRefs: [`fixture:newer:${index}`],
          evidenceOrigin: 'synthetic',
          environmentFingerprint: `fixture:newer:${index}`,
          now: new Date(
            Date.parse('2026-07-15T11:00:00.000Z') + index * 60_000,
          ),
        });
        const newerRun = productionRun(newerAcquisition, {
          runId: `capability-run:newer:${index}`,
          createdAt: '2026-07-15T11:30:00.000Z',
          updatedAt: new Date(
            Date.parse('2026-07-15T11:31:00.000Z') + index * 60_000,
          ).toISOString(),
          workId: `durable-work:newer:${index}`,
          checkpointId: `durable-checkpoint:newer:${index}`,
          invocationId: `capability-invocation:newer:${index}`,
          canaryApprovalPacketId: null,
          canaryApprovalVersion: null,
          canaryApprovalScopeDigest: null,
          outcomeId: null,
        });
        insertProductionRunDurableState(newerRun);
        insertCapabilityProductionRun(newerRun);
        statuses.set(newerAcquisition.acquisitionId, {
          acquisition: newerAcquisition,
          runs: [newerRun],
          pendingAction: 'owner_review',
          stateLabel: newerAcquisition.state,
          ownerControlSummary: 'Metadata only.',
        });
      }
      apprenticeship.getStatus.mockImplementation((acquisitionId: string) =>
        statuses.get(acquisitionId),
      );
      const persistedPacket = listCognitiveApprovalPackets({
        groupFolder: 'main',
        limit: 500,
      }).find((packet) => packet.approvalPacketId === approvalPacketId)!;

      const base = await start();
      const { cookie, snapshot } = await authenticate(base);
      expect(snapshot.approvals.map((approval) => approval.id)).not.toContain(
        approvalPacketId,
      );
      expect(JSON.stringify(snapshot.apprenticeship)).not.toContain(
        olderAcquisition.acquisitionId,
      );

      const response = await post({
        base,
        cookie,
        csrfToken: snapshot.csrfToken,
        path: `/api/v1/approvals/${encodeURIComponent(approvalPacketId)}/confirm`,
        body: {
          confirmation: 'APPROVE',
          summary: persistedPacket.summary,
          approvalVersion: persistedPacket.approvalVersion,
          scopeDigest: persistedPacket.scopeDigest,
        },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining(`exact ${surface} conversation`),
      });
      expect(
        listCognitiveApprovalPackets({ groupFolder: 'main', limit: 500 }).find(
          (packet) => packet.approvalPacketId === approvalPacketId,
        )?.status,
      ).toBe('staged');
    },
  );

  it('projects every eligible run for review and counts pending runs, not acquisitions', async () => {
    const { acquisition, run } = seedCapability();
    const latestReuse = productionRun(acquisition, {
      runId: 'capability-run:latest-reuse',
      runKind: 'active_reuse',
      status: 'awaiting_owner_review',
      createdAt: '2026-07-15T12:10:00.000Z',
      updatedAt: '2026-07-15T12:11:00.000Z',
    });
    const olderReviewedCanary = {
      ...run,
      status: 'owner_reviewed' as const,
      ownerReviewId: 'capability-review:older-canary',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: { ...acquisition, state: 'canary_ready' },
      runs: [latestReuse, olderReviewedCanary],
      pendingAction: 'owner_review',
      stateLabel: 'canary_ready',
      ownerControlSummary: 'Metadata only.',
    });
    const base = await start();
    const { snapshot } = await authenticate(base);

    expect(snapshot.apprenticeship).toMatchObject({
      metrics: {
        acquisitionCount: 1,
        runCount: 2,
        pendingOwnerReviewCount: 1,
        reviewableRunCount: 2,
      },
      acquisitions: [
        {
          ownerReviewRunId: latestReuse.runId,
          activationProposalRunId: null,
          runs: [
            {
              id: latestReuse.runId,
              reviewEligible: true,
            },
            {
              id: olderReviewedCanary.runId,
              reviewEligible: true,
            },
          ],
        },
      ],
    });
  });

  it('requires authentication, same-origin CSRF, and an exact canary verdict', async () => {
    const { acquisition, run } = seedCapability();
    const base = await start();
    const path = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}/review`;

    expect(
      (
        await post({
          base,
          path,
          body: { confirmation: 'REVIEW_CANARY', verdict: 'verified' },
        })
      ).status,
    ).toBe(401);
    const { cookie, snapshot } = await authenticate(base);
    expect(
      (
        await post({
          base,
          cookie,
          path,
          body: { confirmation: 'REVIEW_CANARY', verdict: 'verified' },
        })
      ).status,
    ).toBe(403);
    const exactHelpful = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: { confirmation: 'REVIEW_CANARY', verdict: 'helpful' },
    });
    expect(exactHelpful.status).toBe(200);
    expect(apprenticeship.recordVerdict).toHaveBeenLastCalledWith({
      token: 'private-review-token',
      verdict: 'helpful',
      now: expect.any(Date),
    });
    const mixedReview = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: {
        confirmation: 'REVIEW_CANARY',
        verdict: 'verified',
        summary: 'Helpful; also activate it.',
      },
    });
    expect(mixedReview.status).toBe(400);
    expect(apprenticeship.issueReviewToken).toHaveBeenCalledTimes(1);

    const reviewed = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: { confirmation: 'REVIEW_CANARY', verdict: 'verified' },
    });
    expect(reviewed.status).toBe(200);
    expect(apprenticeship.issueReviewToken).toHaveBeenCalledWith({
      runId: run.runId,
      now: expect.any(Date),
    });
    expect(apprenticeship.recordVerdict).toHaveBeenCalledWith({
      token: 'private-review-token',
      verdict: 'verified',
      now: expect.any(Date),
    });
    expect(JSON.stringify(await reviewed.json())).not.toContain(
      'private-review-token',
    );
  });

  it('accepts all six explicit canary verdicts and allows exact re-review', async () => {
    const { acquisition, run } = seedCapability();
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const path = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}/review`;
    const verdicts = [
      'verified',
      'helpful',
      'partial',
      'blocked',
      'corrected',
      'rejected',
    ] as const;

    for (const [index, verdict] of verdicts.entries()) {
      apprenticeship.getStatus.mockReturnValue({
        acquisition,
        runs: [
          {
            ...run,
            status:
              index === 0
                ? 'awaiting_owner_review'
                : index === 1
                  ? 'owner_reviewed'
                  : index === 2
                    ? 'awaiting_activation_approval'
                    : index === 3
                      ? 'active'
                      : index === 4
                        ? 'monitoring'
                        : 'paused',
          },
        ],
        pendingAction: index === 0 ? 'owner_review' : 'monitoring',
        stateLabel: acquisition.state,
        ownerControlSummary: 'Metadata only.',
      });
      const response = await post({
        base,
        cookie,
        csrfToken: snapshot.csrfToken,
        path,
        body: { confirmation: 'REVIEW_CANARY', verdict },
      });
      expect(response.status).toBe(200);
      expect(apprenticeship.recordVerdict).toHaveBeenLastCalledWith({
        token: 'private-review-token',
        verdict,
        now: expect.any(Date),
      });
    }
    expect(apprenticeship.issueReviewToken).toHaveBeenCalledTimes(6);
  });

  it('does not let stale, cross-surface, or status requests mint a token', async () => {
    const { acquisition, run } = seedCapability();
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const basePath = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}`;

    apprenticeship.getStatus.mockReturnValueOnce({
      acquisition,
      runs: [{ ...run, channel: 'telegram' }],
      pendingAction: 'owner_review',
      stateLabel: acquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    const crossSurface = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${basePath}/runs/${encodeURIComponent(run.runId)}/review`,
      body: { confirmation: 'REVIEW_CANARY', verdict: 'verified' },
    });
    expect(crossSurface.status).toBe(409);

    apprenticeship.getStatus.mockImplementationOnce(() => {
      throw new Error('Capability acquisition was not found.');
    });
    const stale = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${basePath}/runs/${encodeURIComponent(run.runId)}/review`,
      body: { confirmation: 'REVIEW_CANARY', verdict: 'verified' },
    });
    expect(stale.status).toBe(409);

    const statusRequest = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${basePath}/status`,
      body: { confirmation: 'SHOW_EVIDENCE' },
    });
    expect(statusRequest.status).toBe(404);
    expect(apprenticeship.issueReviewToken).not.toHaveBeenCalled();
    expect(apprenticeship.issueControlToken).not.toHaveBeenCalled();
  });

  it('keeps cockpit-bound activation unavailable because there is no cockpit reuse route', async () => {
    const { acquisition, run } = seedCapability();
    const readyAcquisition = {
      ...acquisition,
      state: 'canary_ready' as const,
      recordVersion: 5,
    };
    const reviewedRun = {
      ...run,
      status: 'owner_reviewed' as const,
      ownerReviewId: 'capability-review:fixture',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: readyAcquisition,
      runs: [reviewedRun],
      pendingAction: 'activation_approval',
      stateLabel: readyAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const runPath = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}`;

    const missingCsrf = await post({
      base,
      cookie,
      path: `${runPath}/activation-proposal`,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(missingCsrf.status).toBe(403);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();

    const proposed = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activation-proposal`,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(proposed.status).toBe(409);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();
    expect(apprenticeship.authorizeActivation).not.toHaveBeenCalled();
    const proposedPayload = await proposed.json();
    expect(proposedPayload).toMatchObject({
      error: expect.stringContaining('no active-reuse route'),
    });
    expect(JSON.stringify(proposedPayload)).not.toContain('PRIVATE');
    expect(JSON.stringify(proposedPayload)).not.toContain('summary');
    expect(JSON.stringify(proposedPayload)).not.toContain('fixture-target');

    const awaitingRun = {
      ...reviewedRun,
      status: 'awaiting_activation_approval' as const,
      activationApprovalPacketId: 'capability-activation-approval:fixture',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: readyAcquisition,
      runs: [awaitingRun],
      pendingAction: 'activation_approval',
      stateLabel: readyAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    const duplicateProposal = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activation-proposal`,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(duplicateProposal.status).toBe(409);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();

    const activated = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activate`,
      body: {
        confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(activated.status).toBe(409);
    expect(await activated.json()).toMatchObject({
      error: expect.stringContaining('no active-reuse route'),
    });
    expect(apprenticeship.authorizeActivation).not.toHaveBeenCalled();
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();
  });

  it('rejects wrong targets, mixed actions, and non-positive owner review', async () => {
    const { acquisition, run } = seedCapability();
    const readyAcquisition = {
      ...acquisition,
      state: 'canary_ready' as const,
      recordVersion: 5,
    };
    const reviewedRun = {
      ...run,
      status: 'owner_reviewed' as const,
      ownerReviewId: 'capability-review:helpful-fixture',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: readyAcquisition,
      runs: [reviewedRun],
      pendingAction: 'activation_approval',
      stateLabel: readyAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const path = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}/activation-proposal`;

    const wrongTarget = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'different-target',
      },
    });
    expect(wrongTarget.status).toBe(409);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();

    const mixed = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
        verdict: 'verified',
      },
    });
    expect(mixed.status).toBe(400);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();

    apprenticeship.stageActivation.mockImplementationOnce(() => {
      throw new Error(
        'Only a verified exact owner verdict can precede activation.',
      );
    });
    const merelyHelpful = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(merelyHelpful.status).toBe(409);
    expect(apprenticeship.authorizeActivation).not.toHaveBeenCalled();
  });

  it('fails closed on stale/racing proposals and unapproved activation packets', async () => {
    const { acquisition, run } = seedCapability();
    const readyAcquisition = {
      ...acquisition,
      state: 'canary_ready' as const,
      recordVersion: 5,
    };
    const reviewedRun = {
      ...run,
      status: 'owner_reviewed' as const,
      ownerReviewId: 'capability-review:fixture',
    };
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const runPath = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}`;
    apprenticeship.getStatus.mockReturnValue({
      acquisition: readyAcquisition,
      runs: [reviewedRun],
      pendingAction: 'activation_approval',
      stateLabel: readyAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    apprenticeship.stageActivation.mockImplementationOnce(() => {
      throw new Error('Capability activation proposal lost its revision race.');
    });
    const racedProposal = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activation-proposal`,
      body: {
        confirmation: 'PROPOSE_ACTIVATION',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(racedProposal.status).toBe(409);

    const awaitingRun = {
      ...reviewedRun,
      status: 'awaiting_activation_approval' as const,
      activationApprovalPacketId: 'capability-activation-approval:fixture',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: readyAcquisition,
      runs: [awaitingRun],
      pendingAction: 'activation_approval',
      stateLabel: readyAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    apprenticeship.authorizeActivation.mockImplementationOnce(() => {
      throw new Error('The exact capability approval packet is not approved.');
    });
    const unapproved = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activate`,
      body: {
        confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(unapproved.status).toBe(409);
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();

    apprenticeship.authorizeActivation.mockImplementationOnce(() => {
      throw new Error('Capability activation binding lost its revision race.');
    });
    const racedActivation = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}/activate`,
      body: {
        confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(racedActivation.status).toBe(409);

    const staleRun = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `${runPath}-stale/activate`,
      body: {
        confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
        targetScopeKey: 'fixture-target',
      },
    });
    expect(staleRun.status).toBe(409);
  });

  it('rejects cockpit idempotent activation replay as an unusable binding', async () => {
    const { acquisition, run } = seedCapability();
    const activeAcquisition = {
      ...acquisition,
      state: 'active' as const,
      recordVersion: 7,
    };
    const activeRun = {
      ...run,
      status: 'active' as const,
      revision: 9,
      ownerReviewId: 'capability-review:fixture',
      activationApprovalPacketId: 'capability-activation-approval:fixture',
    };
    apprenticeship.getStatus.mockReturnValue({
      acquisition: activeAcquisition,
      runs: [activeRun],
      pendingAction: 'monitoring',
      stateLabel: activeAcquisition.state,
      ownerControlSummary: 'Metadata only.',
    });
    apprenticeship.authorizeActivation.mockReturnValue({
      acquisition: activeAcquisition,
      run: activeRun,
      receipt: {
        receiptId: 'capability-production-receipt:activation-fixture',
      },
    });
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const path = `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/runs/${encodeURIComponent(run.runId)}/activate`;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const replay = await post({
        base,
        cookie,
        csrfToken: snapshot.csrfToken,
        path,
        body: {
          confirmation: 'ACTIVATE_APPROVED_CAPABILITY',
          targetScopeKey: 'fixture-target',
        },
      });
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({
        error: expect.stringContaining('no active-reuse route'),
      });
    }
    expect(apprenticeship.authorizeActivation).not.toHaveBeenCalled();
    expect(apprenticeship.stageActivation).not.toHaveBeenCalled();
  });

  it('issues and consumes only the four exact owner controls', async () => {
    const { acquisition } = seedCapability();
    const base = await start();
    const { cookie, snapshot } = await authenticate(base);
    const cases = [
      ['pause', 'pause', 'PAUSE'],
      ['revoke', 'revoke', 'REVOKE'],
      ['retire', 'retire', 'RETIRE'],
      ['show-evidence', 'show_evidence', 'SHOW_EVIDENCE'],
    ] as const;

    const unconfirmed = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/pause`,
      body: { confirmation: 'SHOW_STATUS' },
    });
    expect(unconfirmed.status).toBe(400);
    expect(apprenticeship.issueControlToken).not.toHaveBeenCalled();

    for (const [route, actionKind, confirmation] of cases) {
      const response = await post({
        base,
        cookie,
        csrfToken: snapshot.csrfToken,
        path: `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/${route}`,
        body: { confirmation },
      });
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        action: string;
        evidenceIds: string[];
      };
      expect(payload.action).toBe(actionKind);
      expect(payload.evidenceIds.every((id) => !id.includes('/'))).toBe(true);
      expect(apprenticeship.issueControlToken).toHaveBeenCalledWith({
        acquisitionId: acquisition.acquisitionId,
        actionKind,
        now: expect.any(Date),
      });
      expect(apprenticeship.applyControl).toHaveBeenCalledWith({
        token: `private-${actionKind}-token`,
        now: expect.any(Date),
      });
    }

    const activation = await post({
      base,
      cookie,
      csrfToken: snapshot.csrfToken,
      path: `/api/v1/capability-apprenticeship/acquisitions/${encodeURIComponent(acquisition.acquisitionId)}/activate`,
      body: { confirmation: 'ACTIVATE' },
    });
    expect(activation.status).toBe(404);
  });
});
