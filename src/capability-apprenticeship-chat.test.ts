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

function dependencies(
  statuses: CapabilityApprenticeshipStatus[],
): CapabilityChatDispatcherDependencies & {
  listAcquisitions: ReturnType<typeof vi.fn>;
  getStatus: ReturnType<typeof vi.fn>;
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
  return {
    listAcquisitions: vi.fn(() => statuses.map((item) => item.acquisition)),
    getStatus: vi.fn(
      (id: string) => byId.get(id) as CapabilityApprenticeshipStatus,
    ),
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
    getStatus: ReturnType<typeof vi.fn>;
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
  it('parses only explicit capability verdicts and controls', () => {
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
    for (const text of [
      'Helpful',
      'that was helpful',
      'blocked',
      'verified',
      'show capability status',
      'activate capability',
      'approve the capability',
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
      },
      blueDeps,
    );
    expect(blue.action).toBe('restricted');
    expect(blueDeps.listAcquisitions).not.toHaveBeenCalled();
  });

  it('allows only the configured BlueBubbles self-thread with exact run scope', () => {
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
        messageId: 'bluebubbles-message:fixture',
        now: '2026-07-15T12:07:00.000Z',
      },
      deps,
    );
    expect(result.action).toBe('control');
    expect(deps.issueControlToken).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid, channelName: 'bluebubbles' }),
    );

    const alias = dispatchCapabilityApprenticeshipOwnerAction(
      {
        text: 'retire that capability',
        channelName: 'bluebubbles',
        chatJid: 'bb:iMessage;-;attacker@example.invalid',
        group: blueBubblesGroup,
      },
      deps,
    );
    expect(alias.action).toBe('restricted');
  });

  it('leaves generic Helpful and status requests to their existing handlers', () => {
    const record = acquisition();
    const run = productionRun({ acquisition: record });
    const deps = dependencies([status(record, run)]);
    for (const text of ['Helpful', 'show capability status']) {
      expect(
        dispatchCapabilityApprenticeshipOwnerAction(telegramInput(text), deps),
      ).toEqual({ handled: false });
    }
    expect(deps.listAcquisitions).not.toHaveBeenCalled();
    expect(deps.issueReviewToken).not.toHaveBeenCalled();
    expect(deps.issueControlToken).not.toHaveBeenCalled();
  });
});
