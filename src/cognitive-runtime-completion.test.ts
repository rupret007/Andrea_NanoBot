import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  authorizeCognitiveReplyDelivery,
  beginCognitiveKernelRun,
  type CognitiveKernelResult,
} from './cognitive-kernel.js';
import {
  adaptiveCompletionEvidenceFromVerifiedRuntime,
  resolveCognitiveDeliveryPayload,
} from './cognitive-runtime-completion.js';
import { _closeDatabase, _initTestDatabase } from './db.js';
import type {
  RuntimeToolActionEvidence,
  VerifiedDeepWorkPacket,
} from './types.js';

function beginKernel(
  overrides: Partial<Parameters<typeof beginCognitiveKernelRun>[0]> = {},
): CognitiveKernelResult {
  return beginCognitiveKernelRun({
    turnId: 'turn:runtime-completion',
    channel: 'telegram',
    groupFolder: 'main',
    taskFamily: 'assistant',
    goal: 'Inspect the repository and report the verified result.',
    requestRoute: 'direct_assistant',
    runOrigin: 'synthetic',
    selectedSkillId: 'assistant.runtime_completion_test',
    selectedSkillPurpose: 'Report only a verified runtime outcome.',
    selectedSkillApprovalNeed: 'none',
    selectedSkillSideEffectRisk: 'none',
    selectedSkillEvidenceLevel: 'strong',
    ...overrides,
  });
}

function action(
  actionClass: RuntimeToolActionEvidence['class'],
  outcome: RuntimeToolActionEvidence['lastOutcome'] = 'succeeded',
): RuntimeToolActionEvidence {
  return {
    class: actionClass,
    observed: 1,
    succeeded: outcome === 'succeeded' ? 1 : 0,
    failed: outcome === 'failed' ? 1 : 0,
    unresolved: outcome === 'unresolved' ? 1 : 0,
    succeededAfterLastRepositoryWrite: actionClass.startsWith('verification_')
      ? 1
      : 0,
    lastOutcome: outcome,
    recovered: false,
  };
}

function expectedScope(groupFolder: string, turnId: string): string {
  return createHash('sha256')
    .update(
      ['andrea-runtime-evidence-scope-v1', groupFolder, turnId].join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
}

function completedPacket(input: {
  kernel: CognitiveKernelResult;
  now: Date;
  actions?: RuntimeToolActionEvidence[];
}): VerifiedDeepWorkPacket {
  const turnId = input.kernel.run.turnId!;
  const actions = input.actions || [
    action('repository_read'),
    action('verification_test'),
  ];
  const calls = actions.reduce(
    (total, candidate) => ({
      observed: total.observed + candidate.observed,
      succeeded: total.succeeded + candidate.succeeded,
      failed: total.failed + candidate.failed,
      unresolved: total.unresolved + candidate.unresolved,
    }),
    { observed: 0, succeeded: 0, failed: 0, unresolved: 0 },
  );
  return {
    packetId: 'packet:runtime-completion',
    groupFolder: 'main',
    taskFamily: 'coding',
    objective: 'Inspect the repository and report the verified result.',
    status: 'completed',
    currentStage: 'record_outcome',
    stagesCompleted: ['plan', 'inspect', 'execute', 'verify', 'record_outcome'],
    checkpointVersion: 6,
    evidencePolicyVersion: 2,
    sourceTurnId: turnId,
    runtimeExecutionEvidence: {
      version: 1,
      evidenceId: 'runtime:evidence:completion',
      cumulative: true,
      attempts: 1,
      collectorStatus: 'complete',
      calls,
      actions,
      state: {
        preStateFingerprint: null,
        postStateFingerprint: null,
        repositoryHeadFingerprint: null,
      },
      privacy: {
        metadataOnly: true,
        rawInputsStored: false,
        resultBodiesStored: false,
        toolUseIdsStored: false,
      },
      scopeKey: expectedScope('main', turnId),
      sourceTurnId: turnId,
      approvalRef: null,
      reconciledAt: input.now.toISOString(),
    },
    approvalRequired: false,
    approvalRef: null,
    sources: [],
    artifacts: [],
    checks: [
      {
        name: 'runtime verification',
        passed: true,
        evidenceRef: 'runtime:evidence:completion',
      },
    ],
    toolSnapshots: [],
    unresolvedRisks: [],
    outcomeSummary: 'The read-only runtime outcome passed verification.',
    nextDecision: 'Deliver the verified result.',
    cognitiveRunId: input.kernel.run.runId,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
  };
}

describe('adaptive runtime completion evidence', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('accepts an exact same-run fresh verified read-only packet', () => {
    const now = new Date();
    const kernel = beginKernel();
    const packet = completedPacket({ kernel, now });

    const evidence = adaptiveCompletionEvidenceFromVerifiedRuntime({
      cognitiveRun: kernel,
      packet,
      now,
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      evidenceClass: 'observed',
      verification: 'verified',
      scope: kernel.taskGraph.adaptiveFrame?.authority.actorScope,
      provenanceRefs: expect.arrayContaining([
        `verification_receipt:verified_deep_work:${packet.packetId}`,
        `runtime_evidence:${packet.runtimeExecutionEvidence?.evidenceId}`,
      ]),
    });
    expect(
      authorizeCognitiveReplyDelivery({
        cognitiveRun: kernel,
        replyKind: 'completion',
        completionEvidence: evidence,
        now: now.toISOString(),
      }),
    ).toMatchObject({
      allowed: true,
      completionAuthorized: true,
      adaptiveStatus: 'satisfied',
    });
  });

  it('never passes denied completion text or its controls to the send boundary', () => {
    const kernel = beginKernel({ executionMode: 'prepare_only' });
    const originalText = 'Everything is complete and already delivered.';
    const authorization = authorizeCognitiveReplyDelivery({
      cognitiveRun: kernel,
      replyKind: 'completion',
    });
    const payload = resolveCognitiveDeliveryPayload({
      authorization,
      requestedText: originalText,
      requestedSendOptions: { inlineActionRows: [['unsafe-control']] },
    });
    const send = vi.fn();

    send(payload.text, payload.sendOptions);

    expect(authorization.allowed).toBe(false);
    expect(send).not.toHaveBeenCalledWith(originalText, expect.anything());
    expect(send).toHaveBeenCalledWith(
      authorization.safeFallbackText,
      undefined,
    );
  });

  it('rejects a packet bound to the wrong cognitive run or source turn', () => {
    const now = new Date();
    const kernel = beginKernel();
    const packet = completedPacket({ kernel, now });
    const wrongRun = { ...packet, cognitiveRunId: 'cog:other-run' };
    const wrongPacketTurn = { ...packet, sourceTurnId: 'turn:other' };
    const wrongRuntimeTurn = {
      ...packet,
      runtimeExecutionEvidence: {
        ...packet.runtimeExecutionEvidence!,
        sourceTurnId: 'turn:other',
      },
    };

    for (const candidate of [wrongRun, wrongPacketTurn, wrongRuntimeTurn]) {
      expect(
        adaptiveCompletionEvidenceFromVerifiedRuntime({
          cognitiveRun: kernel,
          packet: candidate,
          now,
        }),
      ).toEqual([]);
    }
  });

  it('rejects stale and materially future reconciliation timestamps', () => {
    const now = new Date();
    const kernel = beginKernel();
    const packet = completedPacket({ kernel, now });
    const stale = {
      ...packet,
      runtimeExecutionEvidence: {
        ...packet.runtimeExecutionEvidence!,
        reconciledAt: new Date(now.getTime() - 6 * 60 * 1000).toISOString(),
      },
    };
    const future = {
      ...packet,
      runtimeExecutionEvidence: {
        ...packet.runtimeExecutionEvidence!,
        reconciledAt: new Date(now.getTime() + 6_000).toISOString(),
      },
    };

    for (const candidate of [stale, future]) {
      expect(
        adaptiveCompletionEvidenceFromVerifiedRuntime({
          cognitiveRun: kernel,
          packet: candidate,
          now,
        }),
      ).toEqual([]);
    }
  });

  it('rejects unresolved runtime calls and packet risks', () => {
    const now = new Date();
    const kernel = beginKernel();
    const unresolved = completedPacket({
      kernel,
      now,
      actions: [
        action('repository_read'),
        action('verification_test', 'unresolved'),
      ],
    });
    const risky = {
      ...completedPacket({ kernel, now }),
      unresolvedRisks: ['runtime_execution_unresolved'],
    };

    expect(
      adaptiveCompletionEvidenceFromVerifiedRuntime({
        cognitiveRun: kernel,
        packet: unresolved,
        now,
      }),
    ).toEqual([]);
    expect(
      adaptiveCompletionEvidenceFromVerifiedRuntime({
        cognitiveRun: kernel,
        packet: risky,
        now,
      }),
    ).toEqual([]);
  });

  it('rejects external-side-effect and unclassified other actions', () => {
    const now = new Date();
    const kernel = beginKernel();
    for (const actionClass of ['external_side_effect', 'other'] as const) {
      const packet = completedPacket({
        kernel,
        now,
        actions: [action(actionClass), action('verification_test')],
      });
      expect(
        adaptiveCompletionEvidenceFromVerifiedRuntime({
          cognitiveRun: kernel,
          packet,
          now,
        }),
      ).toEqual([]);
    }
  });

  it('rejects a packet with no successful verification action', () => {
    const now = new Date();
    const kernel = beginKernel();
    const packet = completedPacket({
      kernel,
      now,
      actions: [action('repository_read')],
    });

    expect(
      adaptiveCompletionEvidenceFromVerifiedRuntime({
        cognitiveRun: kernel,
        packet,
        now,
      }),
    ).toEqual([]);
  });

  it('does not let a generic runtime packet satisfy a receipt-required criterion', () => {
    const now = new Date();
    const kernel = beginKernel({
      goal: 'Send the verified result to the external target.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
    });
    const completionCriterionRef =
      kernel.taskGraph.adaptiveFrame?.contextRefs.find((ref) =>
        ref.startsWith('completion_criterion:'),
      );
    const completionCriterionId = completionCriterionRef?.slice(
      'completion_criterion:'.length,
    );
    expect(completionCriterionId).toBeTruthy();
    expect(kernel.taskGraph.adaptiveFrame?.contextRefs).toContain(
      `receipt_required:${completionCriterionId}`,
    );

    expect(
      adaptiveCompletionEvidenceFromVerifiedRuntime({
        cognitiveRun: kernel,
        packet: completedPacket({ kernel, now }),
        now,
      }),
    ).toEqual([]);
  });
});
