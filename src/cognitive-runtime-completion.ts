import { createHash } from 'node:crypto';

import {
  adaptiveEvidence,
  type AdaptiveEvidence,
} from './adaptive-cognition-engine.js';
import type {
  CognitiveDeliveryAuthorization,
  CognitiveKernelResult,
} from './cognitive-kernel.js';
import type { VerifiedDeepWorkPacket } from './types.js';

const MAX_RUNTIME_COMPLETION_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000;

/** Applies a completed pre-send decision without retaining denied controls. */
export function resolveCognitiveDeliveryPayload<TSendOptions>(input: {
  authorization: CognitiveDeliveryAuthorization;
  requestedText: string;
  requestedSendOptions?: TSendOptions;
}): { text: string; sendOptions?: TSendOptions } {
  if (!input.authorization.allowed) {
    return { text: input.authorization.safeFallbackText };
  }
  return {
    text: input.requestedText,
    ...(input.requestedSendOptions === undefined
      ? {}
      : { sendOptions: input.requestedSendOptions }),
  };
}

function expectedRuntimeEvidenceScope(
  packet: VerifiedDeepWorkPacket,
  turnId: string,
): string {
  return createHash('sha256')
    .update(
      ['andrea-runtime-evidence-scope-v1', packet.groupFolder, turnId].join(
        '\n',
      ),
    )
    .digest('hex')
    .slice(0, 32);
}

function explicitCriterionBinding(
  cognitiveRun: CognitiveKernelResult,
  refPrefix: 'runtime_outcome_criterion:' | 'completion_criterion:',
): { criterionId: string; target: string } | null {
  const frame = cognitiveRun.taskGraph.adaptiveFrame;
  if (!frame) return null;
  const criterionRefs = frame.contextRefs.filter((ref) =>
    ref.startsWith(refPrefix),
  );
  if (criterionRefs.length !== 1) return null;
  const criterionId = criterionRefs[0]!.slice(refPrefix.length).trim();
  if (!criterionId) return null;
  const criterion = frame.successCriteria.find(
    (candidate) => candidate.criterionId === criterionId,
  );
  if (!criterion?.required) return null;
  const targetPrefix = `target:${criterion.criterionId}:`;
  const target = frame.contextRefs
    .find((ref) => ref.startsWith(targetPrefix))
    ?.slice(targetPrefix.length)
    .trim();
  return target ? { criterionId: criterion.criterionId, target } : null;
}

function runtimeCriterionBinding(
  cognitiveRun: CognitiveKernelResult,
): { criterionIds: string[]; target: string } | null {
  const outcome = explicitCriterionBinding(
    cognitiveRun,
    'runtime_outcome_criterion:',
  );
  const completion = explicitCriterionBinding(
    cognitiveRun,
    'completion_criterion:',
  );
  if (!outcome || !completion || outcome.target !== completion.target) {
    return null;
  }
  return {
    criterionIds: [outcome.criterionId, completion.criterionId],
    target: completion.target,
  };
}

/**
 * Converts a host-reconciled, same-turn deep-work outcome into the one piece of
 * adaptive evidence that the container cannot mint for itself: target-bound
 * verification of the final outcome. Untrusted runtime metadata alone is
 * never sufficient, and external effects require their dedicated receipt
 * adapter instead of this bridge.
 */
export function adaptiveCompletionEvidenceFromVerifiedRuntime(input: {
  cognitiveRun: CognitiveKernelResult | null | undefined;
  packet: VerifiedDeepWorkPacket | null | undefined;
  now?: Date | string;
}): AdaptiveEvidence[] {
  const cognitiveRun = input.cognitiveRun;
  const packet = input.packet;
  if (!cognitiveRun || !packet) return [];
  const frame = cognitiveRun.taskGraph.adaptiveFrame;
  const binding = runtimeCriterionBinding(cognitiveRun);
  const runtimeEvidence = packet.runtimeExecutionEvidence;
  const turnId = cognitiveRun.run.turnId;
  if (!frame || !binding || !runtimeEvidence || !turnId) return [];
  if (
    packet.status !== 'completed' ||
    packet.evidencePolicyVersion !== 2 ||
    packet.cognitiveRunId !== cognitiveRun.run.runId ||
    packet.sourceTurnId !== turnId ||
    runtimeEvidence.sourceTurnId !== turnId ||
    runtimeEvidence.collectorStatus !== 'complete' ||
    runtimeEvidence.calls.observed === 0 ||
    runtimeEvidence.calls.unresolved > 0 ||
    packet.unresolvedRisks.length > 0 ||
    runtimeEvidence.scopeKey !== expectedRuntimeEvidenceScope(packet, turnId)
  ) {
    return [];
  }
  if (
    runtimeEvidence.actions.some(
      (action) =>
        action.unresolved > 0 ||
        action.lastOutcome === 'unresolved' ||
        (action.class === 'external_side_effect' && action.observed > 0) ||
        (action.class === 'other' && action.observed > 0),
    ) ||
    !runtimeEvidence.actions.some(
      (action) =>
        action.class.startsWith('verification_') &&
        action.succeeded > 0 &&
        action.failed === 0,
    )
  ) {
    return [];
  }
  // A generic container receipt cannot satisfy an effect-bound criterion.
  // Those completions must come from adaptiveEvidenceFromVerifiedReceipt().
  if (
    binding.criterionIds.some((criterionId) =>
      frame.contextRefs.includes(`receipt_required:${criterionId}`),
    )
  ) {
    return [];
  }
  const nowMs =
    input.now instanceof Date
      ? input.now.getTime()
      : Date.parse(input.now || new Date().toISOString());
  const reconciledAtMs = Date.parse(runtimeEvidence.reconciledAt);
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(reconciledAtMs) ||
    reconciledAtMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS ||
    nowMs - reconciledAtMs > MAX_RUNTIME_COMPLETION_EVIDENCE_AGE_MS
  ) {
    return [];
  }
  const evidenceSeed = [
    cognitiveRun.run.runId,
    packet.packetId,
    runtimeEvidence.evidenceId,
    runtimeEvidence.scopeKey,
    ...binding.criterionIds,
    binding.target,
    runtimeEvidence.state.postStateFingerprint || '',
    runtimeEvidence.state.repositoryHeadFingerprint || '',
  ].join('|');
  const evidenceId = `adaptive:runtime:${createHash('sha256')
    .update(evidenceSeed)
    .digest('hex')}`;
  return [
    adaptiveEvidence({
      evidenceId,
      createdAt: runtimeEvidence.reconciledAt,
      evidenceClass: 'observed',
      origin: cognitiveRun.run.runOrigin,
      source: `verified_deep_work:${packet.packetId}`,
      claim:
        'The host reconciled same-turn runtime execution and deterministic postcondition checks.',
      subject: binding.target,
      predicate: 'verified_runtime_outcome',
      value: 'verified',
      confidence: 0.98,
      freshness: 'fresh',
      scope: frame.authority.actorScope,
      verification: 'verified',
      supportsCriterionIds: [...binding.criterionIds],
      provenanceRefs: [
        `verification_receipt:verified_deep_work:${packet.packetId}`,
        `runtime_evidence:${runtimeEvidence.evidenceId}`,
        `runtime_scope:${runtimeEvidence.scopeKey}`,
        ...(runtimeEvidence.state.postStateFingerprint
          ? [`post_state:${runtimeEvidence.state.postStateFingerprint}`]
          : []),
        ...(runtimeEvidence.state.repositoryHeadFingerprint
          ? [
              `repository_head:${runtimeEvidence.state.repositoryHeadFingerprint}`,
            ]
          : []),
      ],
    }),
  ];
}
