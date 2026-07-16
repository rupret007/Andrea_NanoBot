import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchCapabilityApprenticeshipOwnerAction,
  parseCapabilityChatOwnerAction,
  type CapabilityChatDispatcherDependencies,
} from './capability-apprenticeship-chat.js';
import { durableScopeHash } from './durable-work-continuity.js';
import type { CapabilityApprenticeshipStatus } from './production-capability-apprenticeship.js';
import type {
  CapabilityAcquisitionRecord,
  CapabilityProductionRunRecord,
  CapabilityProductionTransitionReceipt,
  CognitiveApprovalPacket,
  RegisteredGroup,
} from './types.js';

const mainGroup: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@Andrea',
  added_at: '2026-07-15T00:00:00.000Z',
  requiresTrigger: false,
  isMain: true,
};

const blueBubblesGroup: RegisteredGroup = {
  ...mainGroup,
  name: 'BlueBubbles (Main)',
  isMain: false,
};

function acquisition(
  id = 'capability-acquisition:fixture',
  state: CapabilityAcquisitionRecord['state'] = 'canary_ready',
): CapabilityAcquisitionRecord {
  return {
    acquisitionId: id,
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:05:00.000Z',
    groupFolder: 'main',
    targetOutcome: 'PRIVATE target outcome',
    postconditionJson: '["PRIVATE postcondition"]',
    taskFamily: 'fixture_lookup',
    affectedCapability: null,
    gapKind: 'tool_usage_gap',
    knownPrerequisitesJson: '[]',
    missingPrerequisitesJson: '[]',
    candidateResourceRefsJson: '[]',
    selectedResourceRefsJson: '[]',
    riskLevel: 'low',
    dataEgressClass: 'none',
    expectedCostBand: 'zero',
    expectedLatencyBand: 'instant',
    authorityRequirementsJson: '[]',
    evidenceOrigin: 'live',
    confidence: 0.95,
    provenanceJson: '["PRIVATE provenance"]',
    state,
    nextSafeAction: 'PRIVATE next action',
    recordVersion: 5,
    environmentFingerprint: 'fixture-environment',
    candidateContractJson: '{"PRIVATE":"contract"}',
    sandboxEvidenceJson: '{}',
    heldOutEvidenceJson: '{}',
    ownerReviewJson: '{}',
    outcomeIdsJson:
      '["capability-outcome:fixture","/Users/owner/private-evidence"]',
    compiledSkillId: null,
    negativeOutcomeCount: 0,
    correctionCount: 0,
    lastOutcome: null,
    expiresAt: null,
    revalidateAfterAt: null,
    privacyJson: '{"metadataOnly":true}',
  };
}

function productionRun(input: {
  acquisition: CapabilityAcquisitionRecord;
  runId?: string;
  channel?: 'telegram' | 'bluebubbles';
  chatJid?: string;
  status?: CapabilityProductionRunRecord['status'];
}): CapabilityProductionRunRecord {
  const channel = input.channel || 'telegram';
  const chatJid = input.chatJid || 'tg:100';
  return {
    runId: input.runId || 'capability-run:fixture',
    acquisitionId: input.acquisition.acquisitionId,
    createdAt: '2026-07-15T12:01:00.000Z',
    updatedAt: '2026-07-15T12:04:00.000Z',
    runKind: 'canary',
    status: input.status || 'awaiting_owner_review',
    revision: 4,
    candidateFingerprint: 'a'.repeat(64),
    contractVersion: 1,
    contractDigest: 'b'.repeat(64),
    taskFamily: input.acquisition.taskFamily,
    groupFolder: 'main',
    ownerScopeHash: durableScopeHash('owner', 'owner'),
    chatScopeHash: durableScopeHash('chat', chatJid),
    groupScopeHash: durableScopeHash('group', 'main'),
    channel,
    authorizedSurface: channel,
    targetScopeHash: durableScopeHash('target', 'fixture-target'),
    inputDigest: 'c'.repeat(64),
    actionClass: 'local_lookup',
    workId: 'durable-work:fixture',
    workVersion: 2,
    planVersion: 1,
    checkpointId: 'durable-checkpoint:fixture',
    invocationId: 'capability-invocation:fixture',
    canaryApprovalPacketId: 'capability-approval:fixture',
    canaryApprovalVersion: 1,
    canaryApprovalScopeDigest: 'd'.repeat(64),
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
    healthEvidenceSetDigest: 'e'.repeat(64),
    postconditionFingerprint: 'f'.repeat(64),
    resourceDiscoveryCalls: 1,
    candidateDesignCalls: 1,
    toolSelectionCalls: 1,
    executionCalls: 1,
    evaluatorCalls: 1,
    latencyMs: 10,
    providerCalls: 0,
    costUsd: 0,
    matchConfidence: null,
    expiresAt: '2026-07-15T13:00:00.000Z',
    completedAt: null,
    nextSafeAction: 'PRIVATE run next action',
    privacyJson: '{"metadataOnly":true}',
  };
}

function status(
  record: CapabilityAcquisitionRecord,
  run: CapabilityProductionRunRecord,
): CapabilityApprenticeshipStatus {
  return {
    acquisition: record,
    runs: [run],
    pendingAction:
      run.status === 'awaiting_owner_review' ? 'owner_review' : 'monitoring',
    stateLabel: record.state,
    ownerControlSummary: 'Metadata only.',
  };
}

function receipt(
  record: CapabilityAcquisitionRecord,
  run: CapabilityProductionRunRecord,
): CapabilityProductionTransitionReceipt {
  return {
    receiptId: 'capability-production-receipt:fixture',
    acquisitionId: record.acquisitionId,
    runId: run.runId,
    transitionKind: 'owner_reviewed',
    expectedAcquisitionVersion: record.recordVersion,
    resultingAcquisitionVersion: record.recordVersion + 1,
    expectedRunRevision: run.revision,
    resultingRunRevision: run.revision + 1,
    evidenceDigest: '1'.repeat(64),
    createdAt: '2026-07-15T12:06:00.000Z',
    privacyJson: '{"metadataOnly":true}',
  };
}

function approvalPacket(
  run: CapabilityProductionRunRecord,
  overrides: Partial<CognitiveApprovalPacket> = {},
): CognitiveApprovalPacket {
  return {
    approvalPacketId: run.canaryApprovalPacketId as string,
    createdAt: '2026-07-15T12:00:00.000Z',
    updatedAt: '2026-07-15T12:00:00.000Z',
    runId: 'cognitive:capability-approval-fixture',
    toolId: 'durable:operator_change',
    actionClass: 'operator_change',
    status: 'staged',
    summary: 'Approve one exact bounded canary.',
    approvalChannel: null,
    approvalKey: 'capability-approval-fixture',
    expiresAt: '2026-07-15T13:00:00.000Z',
    approvalVersion: 1,
    scopeDigest: '1'.repeat(64),
    summaryDigest: '2'.repeat(64),
    durableWorkId: run.workId,
    durableCheckpointId: run.checkpointId,
    planVersion: run.planVersion,
    targetScopeDigest: run.targetScopeHash,
    decisionJson: '{}',
    privacyJson: '{"metadataOnly":true}',
    ...overrides,
  };
}

function approvalCommand(packet: CognitiveApprovalPacket): string {
  return `approve capability packet ${packet.approvalPacketId} version ${packet.status === 'approved' ? (packet.approvalVersion || 1) - 1 : packet.approvalVersion} scope ${packet.scopeDigest} summary ${packet.summaryDigest}`;
}

function dependencies(
  statuses: CapabilityApprenticeshipStatus[],
): CapabilityChatDispatcherDependencies & {
  listAcquisitions: ReturnType<typeof vi.fn>;
  getAcquisition: ReturnType<typeof vi.fn>;
  getRun: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
  getApprovalPacket: ReturnType<typeof vi.fn>;
  getApprovalBinding: ReturnType<typeof vi.fn>;
  approvePacket: ReturnType<typeof vi.fn>;
  issueReviewToken: ReturnType<typeof vi.fn>;
  recordVerdict: ReturnType<typeof vi.fn>;
  issueControlToken: ReturnType<typeof vi.fn>;
  applyControl: ReturnType<typeof vi.fn>;
} {
  const byId = new Map(
    statuses.map((item) => [item.acquisition.acquisitionId, item]),
  );
  const first = statuses[0]!;
  const firstRun = first.runs[0]!;
  const runById = new Map(
    statuses.flatMap((item) =>
      item.runs.map((run) => [run.runId, run] as const),
    ),
  );
  return {
    listAcquisitions: vi.fn(() => statuses.map((item) => item.acquisition)),
    getAcquisition: vi.fn((id: string) => byId.get(id)?.acquisition),
    getRun: vi.fn((id: string) => runById.get(id)),
    getStatus: vi.fn(
      (id: string) => byId.get(id) as CapabilityApprenticeshipStatus,
    ),
    getApprovalPacket: vi.fn(() => undefined),
    getApprovalBinding: vi.fn(() => null),
    approvePacket: vi.fn(() => ({ status: 'not_found_or_scope_mismatch' })),
    issueReviewToken: vi.fn(() => 'private-review-token'),
    recordVerdict: vi.fn(() => ({
      acquisition: { ...first.acquisition, state: 'canary_ready' },
      run: {
        ...firstRun,
        status: 'owner_reviewed',
        revision: firstRun.revision + 1,
      },
      receipt: receipt(first.acquisition, firstRun),
    })),
    issueControlToken: vi.fn(() => 'private-control-token'),
    applyControl: vi.fn(() => ({
      acquisition: { ...first.acquisition, state: 'paused' },
      run: { ...firstRun, status: 'paused', revision: firstRun.revision + 1 },
      receipt: {
        ...receipt(first.acquisition, firstRun),
        transitionKind: 'paused',
      },
    })),
  } as CapabilityChatDispatcherDependencies & {
    listAcquisitions: ReturnType<typeof vi.fn>;
    getAcquisition: ReturnType<typeof vi.fn>;
    getRun: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    getApprovalPacket: ReturnType<typeof vi.fn>;
    getApprovalBinding: ReturnType<typeof vi.fn>;
    approvePacket: ReturnType<typeof vi.fn>;
    issueReviewToken: ReturnType<typeof vi.fn>;
    recordVerdict: ReturnType<typeof vi.fn>;
    issueControlToken: ReturnType<typeof vi.fn>;
    applyControl: ReturnType<typeof vi.fn>;
  };
}

function telegramInput(text: string) {
  return {
    text,
    channelName: 'telegram',
    chatJid: 'tg:100',
    group: mainGroup,
    messageId: 'telegram-message:fixture',
    now: '2026-07-15T12:07:00.000Z',
  };
}

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

describe('capability apprenticeship trusted-chat actions', () => {
  it('parses only explicit capability verdicts, controls, and bounded status intents', () => {
    for (const verdict of [
      'verified',
      'helpful',
      'partial',
      'blocked',
      'corrected',
      'rejected',
    ] as const) {
      expect(
        parseCapabilityChatOwnerAction(`capability verdict: ${verdict}`),
      ).toEqual({
        kind: 'review',
        verdict,
        reference: null,
      });
    }
    expect(
      parseCapabilityChatOwnerAction(
        'review capability capability-run:fixture as corrected',
      ),
    ).toEqual({
      kind: 'review',
      verdict: 'corrected',
      reference: 'capability-run:fixture',
    });
    expect(parseCapabilityChatOwnerAction('pause that capability')).toEqual({
      kind: 'control',
      actionKind: 'pause',
      reference: null,
    });
    expect(
      parseCapabilityChatOwnerAction(
        'show evidence for capability capability-acquisition:fixture',
      ),
    ).toEqual({
      kind: 'control',
      actionKind: 'show_evidence',
      reference: 'capability-acquisition:fixture',
    });
    expect(parseCapabilityChatOwnerAction('What are you learning?')).toEqual({
      kind: 'status',
      queryKind: 'learning',
      reference: null,
    });
    expect(
      parseCapabilityChatOwnerAction(
        'is capability capability-acquisition:fixture ready for a canary?',
      ),
    ).toEqual({
      kind: 'status',
      queryKind: 'canary_readiness',
      reference: 'capability-acquisition:fixture',
    });
    expect(
      parseCapabilityChatOwnerAction('what capability needs review?'),
    ).toEqual({
      kind: 'status',
      queryKind: 'review_needed',
      reference: null,
    });
    expect(parseCapabilityChatOwnerAction('show capability status')).toEqual({
      kind: 'status',
      queryKind: 'current_state',
      reference: null,
    });
    expect(
      parseCapabilityChatOwnerAction(
        'activate capability capability-acquisition:fixture exact version',
      ),
    ).toEqual({
      kind: 'status',
      queryKind: 'activate_exact_version',
      reference: 'capability-acquisition:fixture',
    });
    expect(
      parseCapabilityChatOwnerAction(
        `approve capability packet capability-approval:fixture version 1 scope ${'1'.repeat(64)} summary ${'2'.repeat(64)}`,
      ),
    ).toEqual({
      kind: 'approval',
      approvalPacketId: 'capability-approval:fixture',
      approvalVersion: 1,
      scopeDigest: '1'.repeat(64),
      summaryDigest: '2'.repeat(64),
    });
    for (const text of [
      'Helpful',
      'that was helpful',
      'blocked',
      'verified',
      'activate capability',
      'approve the capability',
      'approve the production action',
      `approve capability packet capability-approval:fixture version 1 scope ${'1'.repeat(63)} summary ${'2'.repeat(64)}`,
      `approve capability packet capability-approval:fixture version 1 scope ${'1'.repeat(64)} summary ${'2'.repeat(64)} please`,
      'pause that skill',
      'capability verdict: unsupported',
    ]) {
      expect(parseCapabilityChatOwnerAction(text)).toBeNull();
    }
  });

  it('records one exact Telegram verdict through a one-time canonical token', () => {
    const record = acquisition();
    const run = productionRun({ acquisition: record });
    const deps = dependencies([status(record, run)]);
    const result = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('capability verdict: verified'),
      deps,
    );

    expect(result).toMatchObject({ handled: true, action: 'review' });
    expect(deps.issueReviewToken).toHaveBeenCalledWith({
      runId: run.runId,
      channelName: 'telegram',
      chatJid: 'tg:100',
      group: mainGroup,
      ownerAuthored: undefined,
      messageId: 'telegram-message:fixture',
      now: '2026-07-15T12:07:00.000Z',
    });
    expect(deps.recordVerdict).toHaveBeenCalledWith({
      token: 'private-review-token',
      verdict: 'verified',
      sourceMessageId: 'telegram-message:fixture',
      now: '2026-07-15T12:07:00.000Z',
    });
    expect(result.text).toContain('Activation was not proposed or approved');
    expect(result.text).not.toContain('private-review-token');
    expect(result.text).not.toContain('PRIVATE');
  });

  it('approves one exact current packet on its bound Telegram conversation', () => {
    const record = acquisition('capability-acquisition:approval');
    const run = productionRun({
      acquisition: record,
      runId: 'capability-run:approval',
      status: 'awaiting_canary_approval',
    });
    let packet = approvalPacket(run);
    const deps = dependencies([status(record, run)]);
    deps.getApprovalPacket.mockImplementation(() => packet);
    deps.getApprovalBinding.mockReturnValue({
      run,
      authorizedSurface: 'telegram',
      trustedChatSurface: 'telegram',
      ambiguous: false,
    });
    deps.approvePacket.mockImplementation(() => {
      packet = {
        ...packet,
        status: 'approved',
        approvalVersion: 2,
        approvalChannel: 'telegram',
      };
      return { status: 'approved', approvalVersion: 2 };
    });

    const result = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(approvalCommand(packet)),
      deps,
    );

    expect(result).toMatchObject({ handled: true, action: 'approval' });
    expect(result.text).toContain('Approved exact capability packet');
    expect(result.text).toContain('no capability action was executed');
    expect(deps.approvePacket).toHaveBeenCalledWith({
      approvalPacketId: packet.approvalPacketId,
      groupFolder: 'main',
      expectedSummary: packet.summary,
      expectedApprovalVersion: 1,
      expectedScopeDigest: '1'.repeat(64),
      now: '2026-07-15T12:07:00.000Z',
      approvalChannel: 'telegram',
    });
  });

  it.each([
    ['version', { approvalVersion: 2 }],
    ['scope', { scopeDigest: '3'.repeat(64) }],
    ['summary', { summaryDigest: '4'.repeat(64) }],
  ] as const)(
    'refuses a command with the wrong exact %s binding',
    (_label, commandOverride) => {
      const record = acquisition('capability-acquisition:mismatch');
      const run = productionRun({
        acquisition: record,
        runId: 'capability-run:mismatch',
        status: 'awaiting_canary_approval',
      });
      const packet = approvalPacket(run);
      const commandPacket = { ...packet, ...commandOverride };
      const deps = dependencies([status(record, run)]);
      deps.getApprovalPacket.mockReturnValue(packet);
      deps.getApprovalBinding.mockReturnValue({
        run,
        authorizedSurface: 'telegram',
        trustedChatSurface: 'telegram',
        ambiguous: false,
      });

      const result = dispatchCapabilityApprenticeshipOwnerAction(
        telegramInput(approvalCommand(commandPacket)),
        deps,
      );

      expect(result.action).toBe('approval');
      expect(result.text).toContain('no longer matches canonical truth');
      expect(deps.approvePacket).not.toHaveBeenCalled();
    },
  );

  it('refuses a wrong chat, wrong channel binding, and ambiguous packet without CAS', () => {
    const record = acquisition('capability-acquisition:surface');
    const run = productionRun({
      acquisition: record,
      runId: 'capability-run:surface',
      status: 'awaiting_canary_approval',
    });
    const packet = approvalPacket(run);
    const deps = dependencies([status(record, run)]);
    deps.getApprovalPacket.mockReturnValue(packet);
    deps.getApprovalBinding.mockReturnValue({
      run,
      authorizedSurface: 'telegram',
      trustedChatSurface: 'telegram',
      ambiguous: false,
    });

    const wrongChat = dispatchCapabilityApprenticeshipOwnerAction(
      { ...telegramInput(approvalCommand(packet)), chatJid: 'tg:other' },
      deps,
    );
    expect(wrongChat.action).toBe('restricted');

    deps.getApprovalBinding.mockReturnValueOnce({
      run,
      authorizedSurface: 'bluebubbles',
      trustedChatSurface: 'bluebubbles',
      ambiguous: false,
    });
    const wrongChannel = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(approvalCommand(packet)),
      deps,
    );
    expect(wrongChannel.action).toBe('restricted');

    deps.getApprovalBinding.mockReturnValueOnce({
      run: null,
      authorizedSurface: 'ambiguous',
      trustedChatSurface: 'telegram',
      ambiguous: true,
    });
    const ambiguous = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(approvalCommand(packet)),
      deps,
    );
    expect(ambiguous.text).toContain(
      'No one exact canonical capability packet',
    );
    expect(deps.approvePacket).not.toHaveBeenCalled();
  });

  it('reports expiration and idempotent replay from current packet truth', () => {
    const record = acquisition('capability-acquisition:decision-truth');
    const run = productionRun({
      acquisition: record,
      runId: 'capability-run:decision-truth',
      status: 'awaiting_canary_approval',
    });
    let packet = approvalPacket(run);
    const deps = dependencies([status(record, run)]);
    deps.getApprovalPacket.mockImplementation(() => packet);
    deps.getApprovalBinding.mockReturnValue({
      run,
      authorizedSurface: 'telegram',
      trustedChatSurface: 'telegram',
      ambiguous: false,
    });
    deps.approvePacket.mockImplementation(() => {
      packet = { ...packet, status: 'expired' };
      return { status: 'expired' };
    });

    const expired = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(approvalCommand(packet)),
      deps,
    );
    expect(expired.text).toContain('is expired');
    expect(deps.approvePacket).toHaveBeenCalledTimes(1);

    packet = {
      ...approvalPacket(run),
      status: 'approved',
      approvalVersion: 2,
      approvalChannel: 'telegram',
    };
    deps.approvePacket.mockClear();
    const replay = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(approvalCommand(packet)),
      deps,
    );
    expect(replay.text).toContain('already approved on this exact telegram');
    expect(deps.approvePacket).not.toHaveBeenCalled();
  });

  it.each([
    'awaiting_owner_review',
    'owner_reviewed',
    'awaiting_activation_approval',
    'active',
    'monitoring',
    'partial',
    'blocked',
    'paused',
  ] as const)(
    'allows an explicit re-review for a current %s run with an outcome',
    (runStatus) => {
      const record = acquisition();
      const run = {
        ...productionRun({ acquisition: record, status: runStatus }),
        ownerReviewId:
          runStatus === 'awaiting_owner_review'
            ? null
            : 'capability-owner-review:existing',
        revision: 9,
      };
      const deps = dependencies([status(record, run)]);
      const result = dispatchCapabilityApprenticeshipOwnerAction(
        telegramInput(`review capability ${run.runId} as helpful`),
        deps,
      );

      expect(result).toMatchObject({ handled: true, action: 'review' });
      expect(deps.issueReviewToken).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.runId }),
      );
      expect(deps.recordVerdict).toHaveBeenCalledWith(
        expect.objectContaining({ verdict: 'helpful' }),
      );
    },
  );

  it.each(['failed', 'quarantined', 'revoked', 'retired'] as const)(
    'does not offer re-review for a terminal %s run',
    (runStatus) => {
      const record = acquisition();
      const run = productionRun({ acquisition: record, status: runStatus });
      const deps = dependencies([status(record, run)]);
      const result = dispatchCapabilityApprenticeshipOwnerAction(
        telegramInput(`capability verdict: verified ${run.runId}`),
        deps,
      );

      expect(result).toMatchObject({
        handled: true,
        action: 'disambiguation',
      });
      expect(deps.issueReviewToken).not.toHaveBeenCalled();
      expect(deps.recordVerdict).not.toHaveBeenCalled();
    },
  );

  it('requires disambiguation and honors an exact run identifier', () => {
    const first = acquisition('capability-acquisition:first');
    const firstRun = productionRun({
      acquisition: first,
      runId: 'capability-run:first',
    });
    const second = acquisition('capability-acquisition:second');
    const secondRun = productionRun({
      acquisition: second,
      runId: 'capability-run:second',
    });
    const deps = dependencies([
      status(first, firstRun),
      status(second, secondRun),
    ]);

    const ambiguous = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('mark that canary partial'),
      deps,
    );
    expect(ambiguous).toMatchObject({
      handled: true,
      action: 'disambiguation',
    });
    expect(ambiguous.text).toContain(firstRun.runId);
    expect(ambiguous.text).toContain(secondRun.runId);
    expect(deps.issueReviewToken).not.toHaveBeenCalled();

    const exact = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`capability verdict: partial ${secondRun.runId}`),
      deps,
    );
    expect(exact.action).toBe('review');
    expect(deps.issueReviewToken).toHaveBeenCalledWith(
      expect.objectContaining({ runId: secondRun.runId }),
    );
  });

  it('also disambiguates controls and accepts one exact acquisition identifier', () => {
    const first = acquisition('capability-acquisition:first');
    const firstRun = productionRun({
      acquisition: first,
      runId: 'capability-run:first',
      status: 'active',
    });
    const second = acquisition('capability-acquisition:second');
    const secondRun = productionRun({
      acquisition: second,
      runId: 'capability-run:second',
      status: 'active',
    });
    const deps = dependencies([
      status(first, firstRun),
      status(second, secondRun),
    ]);

    const ambiguous = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('pause that capability'),
      deps,
    );
    expect(ambiguous.action).toBe('disambiguation');
    expect(deps.issueControlToken).not.toHaveBeenCalled();

    const exact = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`pause capability ${second.acquisitionId}`),
      deps,
    );
    expect(exact.action).toBe('control');
    expect(deps.issueControlToken).toHaveBeenCalledWith(
      expect.objectContaining({ acquisitionId: second.acquisitionId }),
    );
  });

  it('resolves an explicit acquisition and run outside the 20-item overview window', () => {
    const statuses = Array.from({ length: 21 }, (_, index) => {
      const record = acquisition(
        `capability-acquisition:page-${index}`,
        'active',
      );
      const run = productionRun({
        acquisition: record,
        runId: `capability-run:page-${index}`,
        status: 'active',
      });
      return status(record, run);
    });
    const target = statuses[20]!;
    const targetRun = target.runs[0]!;
    const deps = dependencies(statuses);
    deps.listAcquisitions.mockReturnValue(
      statuses.slice(0, 20).map((item) => item.acquisition),
    );

    const byAcquisition = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(
        `is capability ${target.acquisition.acquisitionId} active?`,
      ),
      deps,
    );
    expect(byAcquisition.text).toContain(
      `Capability ${target.acquisition.acquisitionId} is active`,
    );

    const byRun = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`capability verdict: helpful ${targetRun.runId}`),
      deps,
    );
    expect(byRun.action).toBe('review');
    expect(deps.issueReviewToken).toHaveBeenCalledWith(
      expect.objectContaining({ runId: targetRun.runId }),
    );
    expect(deps.listAcquisitions).not.toHaveBeenCalled();
  });

  it('does not retarget lifecycle control from an exact older run to the latest run', () => {
    const record = acquisition('capability-acquisition:old-run', 'active');
    const latest = productionRun({
      acquisition: record,
      runId: 'capability-run:latest',
      status: 'active',
    });
    const older = {
      ...productionRun({
        acquisition: record,
        runId: 'capability-run:older-than-window',
        status: 'active',
      }),
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    const deps = dependencies([status(record, latest)]);
    deps.getRun.mockImplementation((id: string) =>
      id === older.runId ? older : id === latest.runId ? latest : undefined,
    );

    const result = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`pause capability ${older.runId}`),
      deps,
    );

    expect(result.action).toBe('disambiguation');
    expect(deps.issueControlToken).not.toHaveBeenCalled();
  });

  it.each([
    ['pause capability', 'pause'],
    ['revoke that canary', 'revoke'],
    ['retire capability', 'retire'],
    ['show me the evidence for that capability', 'show_evidence'],
  ] as const)('applies the exact %s control only', (text, actionKind) => {
    const record = acquisition();
    const run = productionRun({
      acquisition: record,
      status: 'active',
    });
    const deps = dependencies([status(record, run)]);
    const result = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(text),
      deps,
    );

    expect(result).toMatchObject({ handled: true, action: 'control' });
    expect(deps.issueControlToken).toHaveBeenCalledWith({
      acquisitionId: record.acquisitionId,
      actionKind,
      channelName: 'telegram',
      chatJid: 'tg:100',
      group: mainGroup,
      ownerAuthored: undefined,
      messageId: 'telegram-message:fixture',
      now: '2026-07-15T12:07:00.000Z',
    });
    expect(deps.applyControl).toHaveBeenCalledWith({
      token: 'private-control-token',
      now: '2026-07-15T12:07:00.000Z',
    });
    expect(result.text).not.toContain('private-control-token');
    expect(result.text).not.toContain('/Users/');
    expect(result.text).not.toContain('PRIVATE');
  });

  it('rejects unregistered Telegram chats and fallback BlueBubbles aliases before reads', () => {
    const record = acquisition();
    const run = productionRun({ acquisition: record });
    const telegramDeps = dependencies([status(record, run)]);
    const telegram = dispatchCapabilityApprenticeshipOwnerAction(
      {
        ...telegramInput('capability verdict: rejected'),
        group: { ...mainGroup, isMain: false },
      },
      telegramDeps,
    );
    expect(telegram.action).toBe('restricted');
    expect(telegramDeps.listAcquisitions).not.toHaveBeenCalled();

    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    delete process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
    delete process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS;
    const blueDeps = dependencies([status(record, run)]);
    const blue = dispatchCapabilityApprenticeshipOwnerAction(
      {
        text: 'pause that capability',
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;+12025550101',
        group: blueBubblesGroup,
        ownerAuthored: true,
      },
      blueDeps,
    );
    expect(blue.action).toBe('restricted');
    expect(blueDeps.listAcquisitions).not.toHaveBeenCalled();
  });

  it('allows only a current owner-authored message in the configured BlueBubbles self-thread with exact run scope', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    const chatJid = 'bb:iMessage;-;owner@example.invalid';
    const record = acquisition();
    const run = productionRun({
      acquisition: record,
      channel: 'bluebubbles',
      chatJid,
      status: 'active',
    });
    const deps = dependencies([status(record, run)]);
    const result = dispatchCapabilityApprenticeshipOwnerAction(
      {
        text: 'retire that capability',
        channelName: 'bluebubbles',
        chatJid,
        group: blueBubblesGroup,
        ownerAuthored: true,
        messageId: 'bluebubbles-message:fixture',
        now: '2026-07-15T12:07:00.000Z',
      },
      deps,
    );
    expect(result.action).toBe('control');
    expect(deps.issueControlToken).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid,
        channelName: 'bluebubbles',
        ownerAuthored: true,
      }),
    );

    const alias = dispatchCapabilityApprenticeshipOwnerAction(
      {
        text: 'retire that capability',
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;attacker@example.invalid',
        group: blueBubblesGroup,
        ownerAuthored: true,
      },
      deps,
    );
    expect(alias.action).toBe('restricted');
  });

  it.each([undefined, false] as const)(
    'restricts a configured BlueBubbles self-thread before reads when current-message owner authorship is %s',
    (ownerAuthored) => {
      process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
        'iMessage;-;owner@example.invalid';
      const record = acquisition();
      const run = productionRun({ acquisition: record });
      const deps = dependencies([status(record, run)]);

      const result = dispatchCapabilityApprenticeshipOwnerAction(
        {
          text: 'pause that capability',
          channelName: 'bluebubbles',
          chatJid: 'bb:iMessage;-;owner@example.invalid',
          group: blueBubblesGroup,
          ownerAuthored,
        },
        deps,
      );

      expect(result.action).toBe('restricted');
      expect(result.text).toContain('current owner-authored message');
      expect(deps.listAcquisitions).not.toHaveBeenCalled();
      expect(deps.issueControlToken).not.toHaveBeenCalled();
    },
  );

  it('approves only on the configured BlueBubbles self-thread binding', () => {
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE = '1';
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
      'iMessage;-;owner@example.invalid';
    const chatJid = 'bb:iMessage;-;owner@example.invalid';
    const record = acquisition('capability-acquisition:bb-approval');
    const run = productionRun({
      acquisition: record,
      channel: 'bluebubbles',
      chatJid,
      status: 'awaiting_canary_approval',
    });
    let packet = approvalPacket(run);
    const deps = dependencies([status(record, run)]);
    deps.getApprovalPacket.mockImplementation(() => packet);
    deps.getApprovalBinding.mockReturnValue({
      run,
      authorizedSurface: 'bluebubbles',
      trustedChatSurface: 'bluebubbles',
      ambiguous: false,
    });
    deps.approvePacket.mockImplementation(() => {
      packet = {
        ...packet,
        status: 'approved',
        approvalVersion: 2,
        approvalChannel: 'bluebubbles',
      };
      return { status: 'approved', approvalVersion: 2 };
    });

    const result = dispatchCapabilityApprenticeshipOwnerAction(
      {
        text: approvalCommand(packet),
        channelName: 'bluebubbles',
        chatJid,
        group: blueBubblesGroup,
        ownerAuthored: true,
        now: '2026-07-15T12:07:00.000Z',
      },
      deps,
    );
    expect(result.text).toContain('this bluebubbles conversation');
    expect(deps.approvePacket).toHaveBeenCalledWith(
      expect.objectContaining({ approvalChannel: 'bluebubbles' }),
    );
  });

  it('reports bounded learning and truthful pre-canary staging state without mutation', () => {
    const record = acquisition(
      'capability-acquisition:pre-canary',
      'owner_review_required',
    );
    const candidateStatus: CapabilityApprenticeshipStatus = {
      acquisition: record,
      runs: [],
      pendingAction: 'none',
      stateLabel: 'owner_review_required',
      ownerControlSummary: 'Metadata only.',
    };
    const deps = dependencies([candidateStatus]);
    let tick = 100;
    deps.monotonicNow = vi.fn(() => {
      const value = tick;
      tick += 7.5;
      return value;
    });

    const learning = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('What are you learning?'),
      deps,
    );
    expect(learning).toMatchObject({ handled: true, action: 'status' });
    expect(learning.text).toContain('pending canary_staging');
    expect(learning.timings).toEqual({ totalMs: 7.5 });
    expect(learning.text).toContain('Status lookup timing (local): 7.5 ms.');
    expect(learning.text).not.toContain('PRIVATE');

    const ready = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(
        `is capability ${record.acquisitionId} ready for a canary?`,
      ),
      deps,
    );
    expect(ready.text).toContain(
      'canonical candidate exists; ready for exact trusted-chat canary staging',
    );
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
  });

  it('explains a pending action-specific approval without approving or consuming it', () => {
    const record = acquisition('capability-acquisition:protected');
    const run = productionRun({
      acquisition: record,
      runId: 'capability-run:protected',
      status: 'awaiting_action_approval',
    });
    const deps = dependencies([
      {
        acquisition: record,
        runs: [run],
        pendingAction: 'action_approval',
        stateLabel: record.state,
        ownerControlSummary: 'Metadata only.',
      },
    ]);

    const result = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(
        `is capability ${record.acquisitionId} ready for a canary?`,
      ),
      deps,
    );

    expect(result).toMatchObject({ handled: true, action: 'status' });
    expect(result.text).toContain(
      'awaiting a separate action-specific approval on this exact trusted chat',
    );
    expect(result.text).toContain(
      'canary or activation approval cannot substitute',
    );
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
    expect(deps.applyControl).not.toHaveBeenCalled();
  });

  it('reports review, active, and pause truth without fabricating state', () => {
    const paused = {
      ...acquisition('capability-acquisition:paused', 'paused'),
      correctionCount: 1,
      negativeOutcomeCount: 1,
    };
    const pausedRun = productionRun({
      acquisition: paused,
      runId: 'capability-run:paused',
      status: 'paused',
    });
    const review = acquisition('capability-acquisition:review');
    const reviewRun = productionRun({
      acquisition: review,
      runId: 'capability-run:review',
      status: 'awaiting_owner_review',
    });
    const deps = dependencies([
      status(paused, pausedRun),
      status(review, reviewRun),
    ]);

    const needsReview = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('what capability needs review?'),
      deps,
    );
    expect(needsReview.text).toContain(reviewRun.runId);
    expect(needsReview.text).not.toContain(pausedRun.runId);

    const why = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`why is capability ${paused.acquisitionId} paused?`),
      deps,
    );
    expect(why.text).toContain('Recorded correction count: 1');
    expect(why.text).toContain('negative outcome count: 1');
    expect(why.text).toContain('does not invent a pause reason');

    const ambiguous = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput('is that capability active?'),
      deps,
    );
    expect(ambiguous.action).toBe('disambiguation');
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
  });

  it('treats canary-only and exact-version activation language as safe lifecycle guidance', () => {
    const record = acquisition();
    const run = productionRun({
      acquisition: record,
      status: 'owner_reviewed',
    });
    const deps = dependencies([status(record, run)]);

    const canaryOnly = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(`keep capability ${record.acquisitionId} canary-only`),
      deps,
    );
    expect(canaryOnly).toMatchObject({ handled: true, action: 'status' });
    expect(canaryOnly.text).toContain('I did not activate it');

    const activate = dispatchCapabilityApprenticeshipOwnerAction(
      telegramInput(
        `activate capability ${record.acquisitionId} exact version`,
      ),
      deps,
    );
    expect(activate.text).toContain('Exact activation request recognized');
    expect(activate.text).toContain(
      'I did not activate it, stage an approval, approve a packet, or invent an owner review',
    );
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.recordVerdict).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
    expect(deps.applyControl).not.toHaveBeenCalled();
  });

  it('leaves ordinary non-apprenticeship chat with its existing handler', () => {
    const record = acquisition();
    const run = productionRun({ acquisition: record });
    const deps = dependencies([status(record, run)]);
    for (const text of ['Helpful', 'Help me summarize this ordinary note.']) {
      expect(
        dispatchCapabilityApprenticeshipOwnerAction(telegramInput(text), deps),
      ).toEqual({ handled: false });
    }
    expect(deps.listAcquisitions).not.toHaveBeenCalled();
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
  });
});
