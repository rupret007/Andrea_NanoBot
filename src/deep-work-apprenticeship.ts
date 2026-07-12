import { createHash } from 'node:crypto';

import {
  getAgentOSEpisode,
  getVerifiedDeepWorkPacket,
  listAgentOSSkillProposals,
  listCognitiveSkillCards,
  listVerifiedDeepWorkPackets,
  upsertAgentOSEpisode,
  upsertAgentOSSkillProposal,
  upsertAgentOSTrajectoryEval,
  upsertAgentRuntimeSkillManifest,
  upsertCognitiveSkillCard,
  upsertVerifiedDeepWorkPacket,
} from './db.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import { recordCognitiveOwnerReview } from './cognitive-kernel.js';
import type {
  AgentOSEpisode,
  AgentOSSkillProposal,
  AgentOSTrajectoryEval,
  AgentRuntimeSkillManifest,
  CognitiveSkillCardRecord,
  DeepWorkMissionReviewVerdict,
  DeepWorkMissionSnapshot,
  VerifiedDeepWorkPacket,
} from './types.js';

export const REPO_DEEP_WORK_SKILL_ID = 'deep_work.repo_verified_delivery';
export const DEEP_WORK_DOGFOOD_TARGET_DAYS = 10;

export function buildDeepWorkDogfoodReport(
  groupFolder: string,
  now = new Date(),
): {
  targetWorkingDays: 10;
  attemptedWorkingDays: number;
  reviewedMissions: number;
  verifiedMissions: number;
  unreviewedPacketIds: string[];
  baselineEligible: boolean;
  nextAction: string;
} {
  const windowStart = now.getTime() - 21 * 86_400_000;
  const packets = listVerifiedDeepWorkPackets({
    groupFolder,
    limit: 500,
  }).filter(
    (packet) =>
      packet.taskFamily === 'coding' &&
      new Date(packet.createdAt).getTime() >= windowStart,
  );
  const attemptedDays = new Set(
    packets
      .map((packet) => new Date(packet.createdAt))
      .filter((date) => !Number.isNaN(date.getTime()))
      .filter((date) => ![0, 6].includes(date.getDay()))
      .filter((date) => date.getTime() <= now.getTime())
      .map((date) => date.toISOString().slice(0, 10)),
  );
  const reviewed = packets.filter((packet) => packet.review);
  const verified = packets.filter(promotionEligiblePacket);
  const unreviewedPacketIds = packets
    .filter((packet) => !packet.review)
    .map((packet) => packet.packetId);
  return {
    targetWorkingDays: DEEP_WORK_DOGFOOD_TARGET_DAYS,
    attemptedWorkingDays: attemptedDays.size,
    reviewedMissions: reviewed.length,
    verifiedMissions: verified.length,
    unreviewedPacketIds,
    baselineEligible: reviewed.length >= 5,
    nextAction:
      unreviewedPacketIds.length > 0
        ? 'Review the latest completed mission before it contributes to learning.'
        : attemptedDays.size < DEEP_WORK_DOGFOOD_TARGET_DAYS
          ? 'Complete one bounded repository mission on the next working day.'
          : 'Review the ten-day evidence and routing baseline before expanding agency.',
  };
}

export function recordDeepWorkModelRoute(params: {
  packetId: string;
  provider: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  now?: Date;
}): VerifiedDeepWorkPacket {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  const now = params.now || new Date();
  const updated: VerifiedDeepWorkPacket = {
    ...packet,
    modelRoute: {
      provider: clean(params.provider, 80),
      model: clean(params.model, 120),
      latencyMs: Math.max(0, params.latencyMs),
      costUsd: Math.max(0, params.costUsd),
      evaluatedAt: now.toISOString(),
    },
    updatedAt: now.toISOString(),
  };
  upsertVerifiedDeepWorkPacket(updated);
  recordAssistantMetric({
    groupFolder: packet.groupFolder,
    kind: 'latency_sample',
    value: updated.modelRoute!.latencyMs,
    metadata: {
      latencyClass: 'deep_work_route',
      packetId: packet.packetId,
      provider: updated.modelRoute!.provider,
      model: updated.modelRoute!.model,
    },
    now,
  });
  if (updated.modelRoute!.costUsd > 0) {
    recordAssistantMetric({
      groupFolder: packet.groupFolder,
      kind: 'live_eval_cost',
      value: updated.modelRoute!.costUsd,
      metadata: {
        packetId: packet.packetId,
        provider: updated.modelRoute!.provider,
        model: updated.modelRoute!.model,
      },
      now,
    });
  }
  return updated;
}

export function handleDeepWorkApprenticeshipCommand(params: {
  groupFolder: string;
  text: string;
  ownerReviewAllowed?: boolean;
  now?: Date;
}): string | null {
  const text = params.text.trim().toLowerCase();
  const isStatus =
    /(?:today(?:'s)?|current|latest) (?:deep[- ]work )?mission|mission evidence|deep[- ]work status/.test(
      text,
    );
  const verdict = /(?:mark|review).*(?:verified|complete)/.test(text)
    ? 'verified'
    : /(?:mark|review).*(?:partial|partly complete)/.test(text)
      ? 'partial'
      : /(?:mark|review).*(?:blocked)/.test(text)
        ? 'blocked'
        : /(?:mark|review).*(?:correct|needs? correction)/.test(text)
          ? 'corrected'
          : /(?:mark|review).*(?:reject|rejected)/.test(text)
            ? 'rejected'
            : null;
  if (!isStatus && !verdict) return null;
  const packet = selectDeepWorkReviewCandidate(
    listVerifiedDeepWorkPackets({
      groupFolder: params.groupFolder,
      limit: 20,
    }),
  );
  if (!packet) return 'There is no deep-work mission to review yet.';
  if (verdict && params.ownerReviewAllowed !== true) {
    return 'I can show mission evidence here, but only the private owner chat or authenticated cockpit can record an owner verdict.';
  }
  const evidenceGaps = listDeepWorkEvidenceGaps(packet);
  if (verdict === 'verified' && evidenceGaps.length > 0) {
    return `I cannot mark this mission verified yet. Verification still needs ${evidenceGaps.map(deepWorkEvidenceGapLabel).join(', ')}. Current evidence: ${packet.artifacts.length} artifact${packet.artifacts.length === 1 ? '' : 's'} and ${packet.checks.filter((check) => check.passed).length}/${packet.checks.length} passing checks. Next: ${clean(packet.nextDecision, 240) || 'complete the missing evidence, then review it again'}.`;
  }
  const snapshot = verdict
    ? reviewDeepWorkMission({
        packetId: packet.packetId,
        verdict,
        summary: `Owner marked the mission ${verdict} in chat.`,
        now: params.now,
      })
    : buildDeepWorkMissionSnapshot(packet.packetId);
  const current = snapshot.packet;
  const checks = current.checks.filter((check) => check.passed).length;
  const checkDetails = current.checks.length
    ? ` Checks: ${current.checks
        .slice(0, 4)
        .map(
          (check) =>
            `${clean(check.name, 80)} ${check.passed ? 'passed' : 'failed'}`,
        )
        .join('; ')}.`
    : ' Checks: none recorded.';
  const currentEvidenceGaps = listDeepWorkEvidenceGaps(current);
  const evidenceDetail = currentEvidenceGaps.length
    ? ` Verification still needs ${currentEvidenceGaps.map(deepWorkEvidenceGapLabel).join(', ')}.`
    : ' Verification evidence is complete.';
  const replayDetail = hasDeepWorkDeterministicReplayEvidence(current)
    ? ' Deterministic replay evidence: passed.'
    : ' Deterministic replay evidence: still needed for promotion.';
  const review = current.review
    ? ` Owner review: ${current.review.verdict}.`
    : '';
  const next = current.nextDecision
    ? ` Next decision: ${clean(current.nextDecision, 240)}.`
    : '';
  return `${clean(current.objective, 300)} Task family: ${current.taskFamily}. Status: ${current.status}; ${current.artifacts.length} artifact${current.artifacts.length === 1 ? '' : 's'}; ${checks}/${current.checks.length} checks passed.${checkDetails}${evidenceDetail}${replayDetail}${review}${next} Skill evidence: ${snapshot.promotion.verifiedMissions}/${snapshot.promotion.nextThreshold} verified missions (${snapshot.promotion.state}). Review options: verified, partial, honestly blocked, needs correction, or rejected.`;
}

export function buildDeepWorkReviewInvitation(
  packet: VerifiedDeepWorkPacket,
): string | null {
  if (packet.review) return null;
  return listDeepWorkEvidenceGaps(packet).length === 0
    ? 'Mission completion is still a separate owner decision. Reply with one of: “mark this mission verified”; “mark this mission partial”; “mark this mission honestly blocked”; “mark this mission needs correction”; or “mark this mission rejected”.'
    : 'Mission completion is still unreviewed. Reply “show today’s mission evidence” to see what is missing before choosing an honest verdict.';
}

function clean(value: string, limit = 600): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]')
    .trim()
    .slice(0, limit);
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Number((numerator / denominator).toFixed(3)) : 0;
}

function reviewPriority(packet: VerifiedDeepWorkPacket): number {
  const awaitingReview = packet.review ? 0 : 100;
  const reviewReady = ['completed', 'blocked'].includes(packet.status) ? 50 : 0;
  const codingEvidence = packet.taskFamily === 'coding' ? 25 : 0;
  const active = packet.status === 'active' ? 10 : 0;
  return awaitingReview + reviewReady + codingEvidence + active;
}

export function selectDeepWorkReviewCandidate(
  packets: VerifiedDeepWorkPacket[],
): VerifiedDeepWorkPacket | null {
  return (
    [...packets].sort((left, right) => {
      const priority = reviewPriority(right) - reviewPriority(left);
      if (priority !== 0) return priority;
      const rightUpdatedAt = new Date(right.updatedAt).getTime();
      const leftUpdatedAt = new Date(left.updatedAt).getTime();
      return (
        (Number.isFinite(rightUpdatedAt) ? rightUpdatedAt : 0) -
        (Number.isFinite(leftUpdatedAt) ? leftUpdatedAt : 0)
      );
    })[0] || null
  );
}

function reviewedRepoPackets(groupFolder: string): VerifiedDeepWorkPacket[] {
  return listVerifiedDeepWorkPackets({ groupFolder, limit: 500 }).filter(
    (packet) => packet.taskFamily === 'coding' && packet.review,
  );
}

export function isDeepWorkEvidenceComplete(
  packet: VerifiedDeepWorkPacket,
): boolean {
  return listDeepWorkEvidenceGaps(packet).length === 0;
}

export type DeepWorkEvidenceGap =
  | 'artifact_missing'
  | 'check_missing'
  | 'check_failed'
  | 'risk_unresolved'
  | 'approval_evidence_missing';

export function deepWorkEvidenceGapLabel(gap: DeepWorkEvidenceGap): string {
  switch (gap) {
    case 'artifact_missing':
      return 'an artifact';
    case 'check_missing':
      return 'a recorded check';
    case 'check_failed':
      return 'all checks to pass';
    case 'risk_unresolved':
      return 'unresolved risks to be cleared';
    case 'approval_evidence_missing':
      return 'fresh approval evidence';
  }
}

export function listDeepWorkEvidenceGaps(
  packet: VerifiedDeepWorkPacket,
): DeepWorkEvidenceGap[] {
  const gaps: DeepWorkEvidenceGap[] = [];
  if (packet.artifacts.length === 0) gaps.push('artifact_missing');
  if (packet.checks.length === 0) gaps.push('check_missing');
  if (packet.checks.some((check) => !check.passed)) gaps.push('check_failed');
  if (packet.unresolvedRisks.length > 0) gaps.push('risk_unresolved');
  if (
    packet.approvalRequired &&
    !packet.approvalPacketId &&
    !packet.approvalRef
  ) {
    gaps.push('approval_evidence_missing');
  }
  return gaps;
}

export function hasDeepWorkDeterministicReplayEvidence(
  packet: VerifiedDeepWorkPacket,
): boolean {
  return (
    packet.deterministicReplayPassed === true ||
    packet.checks.some(
      (check) =>
        check.passed &&
        /(?:deterministic|replay|test|typecheck|build)/i.test(check.name),
    )
  );
}

function promotionEligiblePacket(packet: VerifiedDeepWorkPacket): boolean {
  return (
    packet.review?.verdict === 'verified' &&
    isDeepWorkEvidenceComplete(packet) &&
    hasDeepWorkDeterministicReplayEvidence(packet)
  );
}

export function assessDeepWorkSkillPromotion(
  groupFolder: string,
): DeepWorkMissionSnapshot['promotion'] {
  const packets = reviewedRepoPackets(groupFolder);
  const accepted = packets.filter((packet) => packet.review?.ownerAccepted);
  const verified = packets.filter(promotionEligiblePacket);
  const negative = packets.filter((packet) =>
    ['corrected', 'rejected'].includes(packet.review?.verdict || ''),
  );
  const acceptanceRate = ratio(accepted.length, packets.length);
  const existing = listCognitiveSkillCards({
    groupFolder,
    taskFamily: 'coding',
    limit: 100,
  }).find((skill) => skill.skillId === REPO_DEEP_WORK_SKILL_ID);
  const promotable =
    packets.length >= 5 &&
    verified.length >= 5 &&
    acceptanceRate >= 0.8 &&
    negative.length < 2;
  const candidate = packets.length >= 3 && verified.length >= 3;
  const state =
    negative.length >= 2
      ? 'blocked'
      : promotable || existing?.promotionState === 'promoted'
        ? 'promoted'
        : candidate
          ? 'candidate'
          : 'insufficient_evidence';
  return {
    skillId: REPO_DEEP_WORK_SKILL_ID,
    state,
    reviewedMissions: packets.length,
    verifiedMissions: verified.length,
    acceptanceRate,
    negativeOutcomes: negative.length,
    nextThreshold: state === 'insufficient_evidence' ? 3 : 5,
  };
}

function privacyJson(): string {
  return JSON.stringify({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    authorityExpanded: false,
  });
}

function syncAgentOSSkillEvidence(
  packet: VerifiedDeepWorkPacket,
  now: Date,
): { trajectoryEvalId: string; skillProposalId?: string } {
  const episodeId = packet.episodeId || `deep-work:${packet.packetId}`;
  const evalId = `deep-work-eval:${packet.packetId}`;
  const complete = isDeepWorkEvidenceComplete(packet);
  const replayPassed = hasDeepWorkDeterministicReplayEvidence(packet);
  const approvalSafe =
    !packet.approvalRequired ||
    Boolean(packet.approvalPacketId || packet.approvalRef);
  const promotionEligible =
    packet.review?.verdict === 'verified' &&
    complete &&
    replayPassed &&
    approvalSafe;
  const evidenceRefs = Array.from(
    new Set([
      ...packet.sources,
      ...packet.artifacts,
      ...packet.checks.map((check) => check.evidenceRef),
    ]),
  );
  const existingEpisode = getAgentOSEpisode(episodeId);
  const episode: AgentOSEpisode = {
    episodeId,
    createdAt: existingEpisode?.createdAt || packet.createdAt,
    updatedAt: now.toISOString(),
    groupFolder: packet.groupFolder,
    channel: existingEpisode?.channel || 'owner_review',
    rootRunId: existingEpisode?.rootRunId || null,
    activeRunId: existingEpisode?.activeRunId || null,
    goalSummary: packet.objective,
    taskFamily: 'coding',
    status:
      packet.review?.verdict === 'verified'
        ? 'completed'
        : packet.status === 'blocked'
          ? 'blocked'
          : 'active',
    mode: existingEpisode?.mode || 'operator_episode',
    priority: existingEpisode?.priority || 0.75,
    linkedRunIdsJson: existingEpisode?.linkedRunIdsJson || JSON.stringify([]),
    councilRunIdsJson: existingEpisode?.councilRunIdsJson || JSON.stringify([]),
    evidenceIdsJson: JSON.stringify(evidenceRefs),
    interruptIdsJson: existingEpisode?.interruptIdsJson || JSON.stringify([]),
    approvalPacketIdsJson: JSON.stringify(
      [packet.approvalPacketId || packet.approvalRef].filter(Boolean),
    ),
    memoryBlockIdsJson:
      existingEpisode?.memoryBlockIdsJson || JSON.stringify([]),
    trajectoryEvalIdsJson: JSON.stringify([evalId]),
    sourceCoverageJson: JSON.stringify({
      sources: packet.sources.length,
      artifacts: packet.artifacts.length,
      checks: packet.checks.length,
      complete,
      replayPassed,
    }),
    nextAction: packet.nextDecision,
    privacyJson: privacyJson(),
    completedAt:
      packet.review?.verdict === 'verified' ? now.toISOString() : null,
  };
  upsertAgentOSEpisode(episode);
  const evalRecord: AgentOSTrajectoryEval = {
    evalId,
    episodeId,
    runId: existingEpisode?.activeRunId || null,
    createdAt: now.toISOString(),
    status: promotionEligible ? 'pass' : complete ? 'warn' : 'fail',
    overallScore: promotionEligible ? 1 : complete ? 0.7 : 0.35,
    sourceCoverage: evidenceRefs.length > 0 ? 1 : 0,
    interruptSafety: 1,
    approvalSafety: approvalSafe ? 1 : 0,
    toolUsefulness: packet.toolSnapshots.length > 0 ? 1 : 0.6,
    verificationStrength: complete && replayPassed ? 1 : complete ? 0.7 : 0.3,
    privacySafety: 1,
    promotionEligible,
    demotionSignalsJson: JSON.stringify(
      [
        !complete ? 'incomplete_evidence' : null,
        !replayPassed ? 'deterministic_replay_missing' : null,
        !approvalSafe ? 'approval_missing' : null,
        ['corrected', 'rejected'].includes(packet.review?.verdict || '')
          ? 'negative_owner_outcome'
          : null,
      ].filter(Boolean),
    ),
    nextAction: promotionEligible
      ? 'Retain as verified apprenticeship evidence.'
      : 'Repair evidence, replay, approval, or owner-review gaps before promotion.',
    privacyJson: privacyJson(),
  };
  upsertAgentOSTrajectoryEval(evalRecord);

  const promotion = assessDeepWorkSkillPromotion(packet.groupFolder);
  if (promotion.state === 'insufficient_evidence') {
    return { trajectoryEvalId: evalId };
  }
  const proposalId = `agentos:${REPO_DEEP_WORK_SKILL_ID}`;
  const existingProposal = listAgentOSSkillProposals({
    taskFamily: 'coding',
    limit: 100,
  }).find((proposal) => proposal.proposalId === proposalId);
  const sourceEpisodeIds = reviewedRepoPackets(packet.groupFolder)
    .filter(promotionEligiblePacket)
    .map((item) => item.episodeId || `deep-work:${item.packetId}`);
  const proposal: AgentOSSkillProposal = {
    proposalId,
    episodeId,
    createdAt: existingProposal?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    status:
      promotion.state === 'promoted'
        ? 'accepted'
        : promotion.state === 'blocked'
          ? 'quarantined'
          : 'candidate',
    taskFamily: 'coding',
    triggerSummary: 'A bounded repository mission needs verified delivery.',
    skillSummary:
      'Inspect, plan, stage approval, execute, verify deterministic checks, review the diff, and record an owner-reviewed outcome.',
    requiredToolCardIdsJson: JSON.stringify([
      'repository_inspection',
      'tests',
      'diff_review',
    ]),
    evidenceNeedsJson: JSON.stringify([
      'artifacts_present',
      'checks_passed',
      'deterministic_replay_passed',
      'owner_reviewed',
    ]),
    approvalRulesJson: JSON.stringify([
      'fresh_approval_for_commit_push_deploy_migration_dependencies_delete',
      'runtime_skill_never_expands_authority',
    ]),
    verificationChecklistJson: JSON.stringify([
      'repository_state_fresh',
      'postconditions_passed',
      'privacy_metadata_only',
      'negative_outcomes_below_threshold',
    ]),
    outcomeScore: promotion.acceptanceRate,
    sourceEpisodeIdsJson: JSON.stringify(sourceEpisodeIds),
    nextAction:
      promotion.state === 'promoted'
        ? 'Use for routing and planning only; preserve fresh approval gates.'
        : 'Collect more verified owner-reviewed missions.',
    privacyJson: privacyJson(),
  };
  upsertAgentOSSkillProposal(proposal);
  const manifest: AgentRuntimeSkillManifest = {
    manifestId: `runtime:${REPO_DEEP_WORK_SKILL_ID}`,
    createdAt: existingProposal?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    skillId: REPO_DEEP_WORK_SKILL_ID,
    sourceKind: 'runtime',
    precedence: 30,
    status:
      promotion.state === 'promoted'
        ? 'trusted'
        : promotion.state === 'blocked'
          ? 'quarantined'
          : 'candidate',
    frontmatterJson: JSON.stringify({
      sourceProposalId: proposalId,
      sourceEpisodeIds,
      promotionState: promotion.state,
      authorityExpanded: false,
    }),
    triggerJson: JSON.stringify({
      taskFamily: 'coding',
      summary: proposal.triggerSummary,
    }),
    toolRefsJson: proposal.requiredToolCardIdsJson,
    approvalRulesJson: proposal.approvalRulesJson,
    evidenceNeedsJson: proposal.evidenceNeedsJson,
    summary: proposal.skillSummary,
    privacyJson: privacyJson(),
  };
  upsertAgentRuntimeSkillManifest(manifest);
  return { trajectoryEvalId: evalId, skillProposalId: proposalId };
}

function upsertApprenticeshipSkill(
  groupFolder: string,
  now: Date,
): CognitiveSkillCardRecord | null {
  const promotion = assessDeepWorkSkillPromotion(groupFolder);
  if (promotion.state === 'insufficient_evidence') return null;
  const existing = listCognitiveSkillCards({
    groupFolder,
    taskFamily: 'coding',
    limit: 100,
  }).find((skill) => skill.skillId === REPO_DEEP_WORK_SKILL_ID);
  const record: CognitiveSkillCardRecord = {
    skillId: REPO_DEEP_WORK_SKILL_ID,
    createdAt: existing?.createdAt || now.toISOString(),
    updatedAt: now.toISOString(),
    groupFolder,
    taskFamily: 'coding',
    triggerSummary:
      'A bounded repository or coding mission needs evidence-backed delivery.',
    skillSummary:
      'Plan, inspect, obtain fresh approval, execute a bounded repository change, verify artifacts and postconditions, then record an owner-reviewed outcome.',
    requiredToolsJson: JSON.stringify([
      'repository_inspection',
      'tests',
      'diff_review',
    ]),
    evidenceNeedsJson: JSON.stringify([
      'source_refs',
      'artifacts',
      'checks',
      'postconditions',
    ]),
    approvalRulesJson: JSON.stringify({
      freshApproval: [
        'commit',
        'push',
        'deploy',
        'migration',
        'dependency_change',
        'delete',
      ],
      authorityExpanded: false,
    }),
    failureModesJson: JSON.stringify([
      'stale_repository',
      'tool_degraded',
      'postcondition_failed',
      'approval_expired',
    ]),
    verificationChecklistJson: JSON.stringify([
      'scope_reviewed',
      'checks_passed',
      'diff_reviewed',
      'risks_reported',
      'owner_reviewed',
    ]),
    latestOutcomeScore:
      promotion.verifiedMissions / Math.max(1, promotion.reviewedMissions),
    promotionState:
      promotion.state === 'promoted'
        ? 'promoted'
        : promotion.state === 'blocked'
          ? 'quarantined'
          : 'candidate',
    usageCount: promotion.reviewedMissions,
    lastUsedAt: now.toISOString(),
  };
  upsertCognitiveSkillCard(record);
  return record;
}

export function linkDeepWorkMission(params: {
  packetId: string;
  missionId: string;
  goalId?: string | null;
  episodeId?: string | null;
  approvalPacketId?: string | null;
  repository?: VerifiedDeepWorkPacket['repository'];
  now?: Date;
}): VerifiedDeepWorkPacket {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  const updated = {
    ...packet,
    missionId: clean(params.missionId, 120),
    goalId: params.goalId ? clean(params.goalId, 120) : null,
    episodeId: params.episodeId ? clean(params.episodeId, 120) : null,
    approvalPacketId: params.approvalPacketId
      ? clean(params.approvalPacketId, 120)
      : null,
    repository: params.repository || packet.repository || null,
    updatedAt: (params.now || new Date()).toISOString(),
  } satisfies VerifiedDeepWorkPacket;
  upsertVerifiedDeepWorkPacket(updated);
  return updated;
}

export function reviewDeepWorkMission(params: {
  packetId: string;
  verdict: DeepWorkMissionReviewVerdict;
  summary: string;
  now?: Date;
}): DeepWorkMissionSnapshot {
  const packet = getVerifiedDeepWorkPacket(params.packetId);
  if (!packet)
    throw new Error(`Deep-work packet ${params.packetId} not found.`);
  const now = params.now || new Date();
  if (params.verdict === 'verified' && !isDeepWorkEvidenceComplete(packet)) {
    throw new Error(
      'A mission cannot be marked verified until artifacts, passing checks, approval evidence, and resolved risks are recorded.',
    );
  }
  const ownerAccepted = ['verified', 'partial', 'blocked'].includes(
    params.verdict,
  );
  const updated: VerifiedDeepWorkPacket = {
    ...packet,
    status:
      params.verdict === 'verified'
        ? 'completed'
        : params.verdict === 'partial' || params.verdict === 'blocked'
          ? 'blocked'
          : packet.status,
    review: {
      verdict: params.verdict,
      ownerAccepted,
      summary: clean(params.summary),
      reviewedAt: now.toISOString(),
    },
    updatedAt: now.toISOString(),
  };
  upsertVerifiedDeepWorkPacket(updated);
  const cognitiveReview = recordCognitiveOwnerReview({
    runId: packet.cognitiveRunId,
    feedbackId: `deep-work-${packet.packetId}`,
    verdict: params.verdict === 'verified' ? 'accepted' : params.verdict,
    reviewedAt: now.toISOString(),
  });
  updated.cognitiveOwnerReviewSignalId = cognitiveReview.signalId || null;
  recordAssistantMetric({
    groupFolder: packet.groupFolder,
    kind: ownerAccepted ? 'recommendation_accepted' : 'recommendation_rejected',
    metadata: {
      metricClass: 'owner_review',
      packetId: packet.packetId,
      verdict: params.verdict,
    },
    now,
  });
  if (params.verdict === 'verified') {
    recordAssistantMetric({
      groupFolder: packet.groupFolder,
      kind: 'completion_verified',
      metadata: {
        metricClass: 'owner_review',
        packetId: packet.packetId,
      },
      now,
    });
  } else if (params.verdict === 'corrected') {
    recordAssistantMetric({
      groupFolder: packet.groupFolder,
      kind: 'correction',
      metadata: {
        metricClass: 'owner_review',
        packetId: packet.packetId,
      },
      now,
    });
  } else if (params.verdict === 'rejected') {
    recordAssistantMetric({
      groupFolder: packet.groupFolder,
      kind: 'override',
      metadata: {
        metricClass: 'owner_review',
        packetId: packet.packetId,
      },
      now,
    });
  }
  if (packet.taskFamily === 'coding') {
    const skill = upsertApprenticeshipSkill(packet.groupFolder, now);
    const agentEvidence = syncAgentOSSkillEvidence(updated, now);
    updated.trajectoryEvalId = agentEvidence.trajectoryEvalId;
    updated.skillProposalId = agentEvidence.skillProposalId || null;
    if (skill) {
      updated.skillCandidateId = skill.skillId;
    }
  }
  upsertVerifiedDeepWorkPacket(updated);
  return buildDeepWorkMissionSnapshot(updated.packetId);
}

export function buildDeepWorkMissionSnapshot(
  packetId: string,
  currentRepository?: { branch: string; headSha: string; dirtyPaths: string[] },
): DeepWorkMissionSnapshot {
  const packet = getVerifiedDeepWorkPacket(packetId);
  if (!packet) throw new Error(`Deep-work packet ${packetId} not found.`);
  const staleRepository = Boolean(
    packet.repository &&
    currentRepository &&
    repositorySnapshotId(currentRepository) !==
      repositorySnapshotId(packet.repository),
  );
  return {
    version: 1,
    packet,
    evidenceComplete: isDeepWorkEvidenceComplete(packet),
    staleRepository,
    promotion: assessDeepWorkSkillPromotion(packet.groupFolder),
  };
}

export function repositorySnapshotId(input: {
  branch: string;
  headSha: string;
  dirtyPaths: string[];
}): string {
  return createHash('sha256')
    .update(
      `${input.branch}|${input.headSha}|${[...input.dirtyPaths].sort().join('|')}`,
    )
    .digest('hex')
    .slice(0, 16);
}
