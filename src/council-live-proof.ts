import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import { assertValidGroupFolder } from './group-folder.js';

export const COUNCIL_LIVE_PROOF_ESTIMATED_COST_RESERVATION_USD = 0.75;
// The council runner can bound roles, retries, time, and output tokens, but it
// has no pre-call monetary reservation hook. Provider usage is also incomplete
// (and some roles run concurrently), so a threshold cannot honestly be called
// an enforced billing cap at this boundary.
export const COUNCIL_LIVE_PROOF_COST_CONTROL_PROOF_DEBT =
  'provider_runner_has_no_pre_call_billing_cap_or_complete_reconciled_usage';

export interface CouncilLiveProofConfig {
  live: true;
  estimatedCostThresholdUsd: number;
  groupFolder: string;
  estimatedCostReservationUsd: number;
  actualBillingCapEnforced: false;
  acceptanceEligible: false;
  costControlStatus: 'estimate_only_proof_debt';
  costControlProofDebt: typeof COUNCIL_LIVE_PROOF_COST_CONTROL_PROOF_DEBT;
}

export interface CouncilLiveProofAssessment {
  passed: boolean;
  terminal: 'completed' | 'completed_degraded' | 'blocked';
  reasons: string[];
  completedVerifier: boolean;
  providerProvenanceComplete: boolean;
  participationFull: boolean;
  evidenceSufficient: boolean;
  confidenceCalibrated: boolean;
  inputStructureValid: boolean;
  schemaConsistent: boolean;
  memberCountsConsistent: boolean;
  answerGuidanceConsistent: boolean;
  participationRolesClean: boolean;
  modeValid: boolean;
  verdictUsable: boolean;
  approvalBoundaryClean: boolean;
  privacyBoundaryClean: boolean;
  budgetValid: boolean;
  riskStateClean: boolean;
  platformRecordFallback: boolean;
  platformRecordLocalRuntime: boolean;
  evidenceGapIds: string[];
}

export interface CouncilLiveProofCostReservation {
  kind: 'live_eval_cost_reservation';
  value: number;
  metadata: Record<string, string | number | boolean>;
}

export interface RecordedCouncilLiveProofResult {
  result: AndreaPlatformProviderCouncilResult;
  assessment: CouncilLiveProofAssessment;
  latencyMs: number;
}

function readValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

export function resolveCouncilLiveProofConfig(
  args: string[],
): CouncilLiveProofConfig {
  if (!args.includes('--live')) {
    throw new Error('Council live proof requires explicit --live opt-in.');
  }
  const estimatedCostThresholdUsd = Number(
    readValue(args, '--max-cost-usd') || '0',
  );
  if (
    !Number.isFinite(estimatedCostThresholdUsd) ||
    estimatedCostThresholdUsd <= 0
  ) {
    throw new Error('Council live proof requires a positive --max-cost-usd.');
  }
  if (
    estimatedCostThresholdUsd <
    COUNCIL_LIVE_PROOF_ESTIMATED_COST_RESERVATION_USD
  ) {
    throw new Error(
      `Council live proof estimated-cost threshold ${estimatedCostThresholdUsd.toFixed(4)} is below the fixed estimate reservation ${COUNCIL_LIVE_PROOF_ESTIMATED_COST_RESERVATION_USD.toFixed(4)}.`,
    );
  }
  const groupFolder = readValue(args, '--group') || 'main';
  assertValidGroupFolder(groupFolder);
  if (!args.includes('--ack-estimate-only')) {
    throw new Error(
      'Council live proof cannot enforce a provider billing cap with the current runner. --max-cost-usd is only an estimate threshold. Pass --ack-estimate-only to run this non-acceptance diagnostic, or leave it blocked as cost-control proof debt.',
    );
  }
  return {
    live: true,
    estimatedCostThresholdUsd,
    groupFolder,
    estimatedCostReservationUsd:
      COUNCIL_LIVE_PROOF_ESTIMATED_COST_RESERVATION_USD,
    actualBillingCapEnforced: false,
    acceptanceEligible: false,
    costControlStatus: 'estimate_only_proof_debt',
    costControlProofDebt: COUNCIL_LIVE_PROOF_COST_CONTROL_PROOF_DEBT,
  };
}

export function buildCouncilLiveProofCostReservation(params: {
  config: CouncilLiveProofConfig;
  councilRunId: string;
  outcome: 'reserved' | 'structural_pass' | 'blocked';
  latencyMs: number;
  failureClass?: string;
}): CouncilLiveProofCostReservation {
  return {
    kind: 'live_eval_cost_reservation',
    value: params.config.estimatedCostReservationUsd,
    metadata: {
      metricClass: 'live_evaluation',
      surface: 'budgeted_live_council',
      councilRunId: params.councilRunId,
      outcome: params.outcome,
      estimatedCostThresholdUsd: params.config.estimatedCostThresholdUsd,
      estimatedCostReservationUsd: params.config.estimatedCostReservationUsd,
      actualCostKnown: false,
      actualBillingCapEnforced: params.config.actualBillingCapEnforced,
      acceptanceEligible: params.config.acceptanceEligible,
      costControlStatus: params.config.costControlStatus,
      costControlProofDebt: params.config.costControlProofDebt,
      costAccountingClass: 'fixed_estimate_reservation',
      latencyMs: params.latencyMs,
      ...(params.failureClass ? { failureClass: params.failureClass } : {}),
    },
  };
}

const SAFE_ERROR_CLASSES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
]);

function safeErrorClass(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR_CLASSES.has(error.name)) {
    return error.name;
  }
  const primitiveType = typeof error;
  if (error === null) return 'non_error_null';
  if (primitiveType !== 'object' && primitiveType !== 'function') {
    return `non_error_${primitiveType}`;
  }
  return 'unknown_error';
}

export async function runRecordedCouncilLiveProof(params: {
  config: CouncilLiveProofConfig;
  correlationId: string;
  execute: () => Promise<AndreaPlatformProviderCouncilResult | null>;
  record: (reservation: CouncilLiveProofCostReservation) => void;
  nowMs?: () => number;
}): Promise<RecordedCouncilLiveProofResult> {
  const nowMs = params.nowMs || Date.now;
  try {
    params.record(
      buildCouncilLiveProofCostReservation({
        config: params.config,
        councilRunId: params.correlationId,
        outcome: 'reserved',
        latencyMs: 0,
      }),
    );
  } catch (error) {
    // The persistence boundary may include provider details in its error. Expose
    // only the bounded class so diagnostics cannot inherit a secret-bearing cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(
      `Council live proof could not reserve diagnostic evidence (${safeErrorClass(error)}).`,
    );
  }
  const startedAt = nowMs();
  try {
    const result = await params.execute();
    if (!result) throw new Error('Provider council returned no result.');
    const latencyMs = Math.max(0, nowMs() - startedAt);
    const assessment = assessCouncilLiveProof(result);
    params.record(
      buildCouncilLiveProofCostReservation({
        config: params.config,
        councilRunId: result.councilRunId || params.correlationId,
        outcome: assessment.passed ? 'structural_pass' : 'blocked',
        latencyMs,
      }),
    );
    return { result, assessment, latencyMs };
  } catch (error) {
    const failureClass = safeErrorClass(error);
    try {
      params.record(
        buildCouncilLiveProofCostReservation({
          config: params.config,
          councilRunId: params.correlationId,
          outcome: 'blocked',
          latencyMs: Math.max(0, nowMs() - startedAt),
          failureClass,
        }),
      );
    } catch {
      // Preserve the initial reservation if the diagnostic store is unavailable.
    }
    // Provider failures can contain credentials or request material. Keep the
    // public proof error sanitized instead of attaching the raw caught error.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(`Council live proof failed (${failureClass}).`);
  }
}

function evidenceRank(value: string | undefined): number {
  if (value === 'strong') return 3;
  if (value === 'partial') return 2;
  if (value === 'weak') return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function isFiniteInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= minimum
  );
}

export function assessCouncilLiveProof(
  result: AndreaPlatformProviderCouncilResult,
): CouncilLiveProofAssessment {
  const verdict = result.structuredVerdict;
  const schema = verdict?.schemaStatusSummary;
  const evidence = verdict?.evidenceScorecard;
  const participation = verdict?.providerParticipation;
  const rawMembers: unknown = verdict?.replayArtifact?.memberStatuses;
  const members = Array.isArray(rawMembers) ? rawMembers : [];
  const rawParticipationRoles: unknown = participation?.roles;
  const participationRoles = Array.isArray(rawParticipationRoles)
    ? rawParticipationRoles
    : [];
  const skippedProviderIds = isStringArray(participation?.skippedProviderIds)
    ? participation.skippedProviderIds
    : [];
  const substitutedRoles = isStringArray(participation?.substitutedRoles)
    ? participation.substitutedRoles
    : [];
  const providerFailures = isStringArray(result.providerFailures)
    ? result.providerFailures
    : [];
  const resultRiskFlags = isStringArray(result.riskFlags)
    ? result.riskFlags
    : [];
  const verdictRiskFlags = isStringArray(verdict?.riskFlags)
    ? verdict.riskFlags
    : [];
  const participationRiskFlags = isStringArray(participation?.riskFlags)
    ? participation.riskFlags
    : [];
  const rawActionDirectives: unknown = verdict?.actionDirectives;
  const actionDirectives = Array.isArray(rawActionDirectives)
    ? rawActionDirectives
    : [];
  const answerGuidance = result.answerGuidance;
  const rawEvidenceGapIds: unknown = evidence?.gapIds;
  const evidenceGapIds = isStringArray(rawEvidenceGapIds)
    ? rawEvidenceGapIds.filter(isNonEmptyString).slice(0, 24)
    : [];
  const membersStructurallyValid =
    Array.isArray(rawMembers) &&
    members.length > 0 &&
    members.every(
      (member) =>
        isRecord(member) &&
        isNonEmptyString(member.memberId) &&
        isNonEmptyString(member.providerId) &&
        isNonEmptyString(member.role) &&
        isNonEmptyString(member.status) &&
        isNonEmptyString(member.verdict) &&
        (member.schemaStatus === 'valid' ||
          member.schemaStatus === 'repaired') &&
        isStringArray(member.schemaIssues) &&
        isStringArray(member.evidenceIds) &&
        isStringArray(member.riskFlags),
    );
  const participationStructurallyValid =
    Boolean(participation) &&
    isStringArray(participation?.skippedProviderIds) &&
    isStringArray(participation?.substitutedRoles) &&
    isStringArray(participation?.riskFlags) &&
    Array.isArray(rawParticipationRoles) &&
    participationRoles.every(
      (role) =>
        isRecord(role) &&
        isNonEmptyString(role.role) &&
        isNonEmptyString(role.providerId) &&
        isNonEmptyString(role.memberId) &&
        isNonEmptyString(role.action) &&
        typeof role.required === 'boolean' &&
        isNonEmptyString(role.reason) &&
        typeof role.riskFlag === 'string' &&
        typeof role.healthState === 'string' &&
        typeof role.failureClass === 'string',
    );
  const evidenceStructurallyValid =
    Boolean(evidence) &&
    isStringArray(rawEvidenceGapIds) &&
    isStringArray(evidence?.sourceClasses) &&
    isRecord(evidence?.sourceCoverage) &&
    isRecord(evidence?.freshnessCoverage);
  const resultCollectionsValid =
    (result.providerFailures === undefined ||
      isStringArray(result.providerFailures)) &&
    (result.riskFlags === undefined || isStringArray(result.riskFlags));
  const verdictCollectionsValid =
    Boolean(verdict) &&
    isStringArray(verdict?.evidenceIds) &&
    isStringArray(verdict?.riskFlags) &&
    Array.isArray(rawActionDirectives);
  const inputStructureValid =
    resultCollectionsValid &&
    verdictCollectionsValid &&
    membersStructurallyValid &&
    participationStructurallyValid &&
    evidenceStructurallyValid;
  const schemaCounts = members.reduce(
    (counts, member) => {
      if (!isRecord(member)) return counts;
      if (member.schemaStatus === 'valid') counts.valid += 1;
      else if (member.schemaStatus === 'repaired') counts.repaired += 1;
      else counts.invalid_fallback += 1;
      return counts;
    },
    { valid: 0, repaired: 0, invalid_fallback: 0 },
  );
  const schemaConsistent =
    Boolean(schema) &&
    isFiniteInteger(schema?.valid) &&
    isFiniteInteger(schema?.repaired) &&
    isFiniteInteger(schema?.invalid_fallback) &&
    schema!.valid === schemaCounts.valid &&
    schema!.repaired === schemaCounts.repaired &&
    schema!.invalid_fallback === schemaCounts.invalid_fallback &&
    schema!.valid + schema!.repaired + schema!.invalid_fallback ===
      members.length;
  const completedVerifier = members.some(
    (member) =>
      isRecord(member) &&
      member.role === 'verifier' &&
      member.status === 'completed' &&
      (member.schemaStatus === 'valid' || member.schemaStatus === 'repaired') &&
      (member.verdict === 'pass' || member.verdict === 'warn') &&
      isStringArray(member.evidenceIds) &&
      member.evidenceIds.length > 0 &&
      isStringArray(member.riskFlags) &&
      member.riskFlags.length === 0,
  );
  const memberIds = new Set(
    members.filter(isRecord).map((member) => String(member.memberId || '')),
  );
  const providerIds = new Set(
    members
      .filter(
        (member) =>
          isRecord(member) &&
          member.memberId &&
          member.providerId &&
          member.role,
      )
      .map((member) => String((member as Record<string, unknown>).providerId)),
  );
  const providerProvenanceComplete =
    members.length >= 3 &&
    memberIds.size === members.length &&
    providerIds.size >= 3 &&
    members.every(
      (member) =>
        isRecord(member) &&
        isNonEmptyString(member.memberId) &&
        isNonEmptyString(member.providerId) &&
        isNonEmptyString(member.role),
    );
  const allMembersCompleted =
    members.length > 0 &&
    members.every(
      (member) =>
        isRecord(member) &&
        member.status === 'completed' &&
        (member.schemaStatus === 'valid' ||
          member.schemaStatus === 'repaired') &&
        (member.verdict === 'pass' || member.verdict === 'warn'),
    );
  const completedMemberIds = members
    .filter((member) => isRecord(member) && member.status === 'completed')
    .map((member) => String((member as Record<string, unknown>).memberId));
  const blockedMemberCount = members.filter(
    (member) => isRecord(member) && member.status === 'blocked',
  ).length;
  const skippedMemberCount = members.filter(
    (member) => isRecord(member) && member.status === 'skipped',
  ).length;
  const memberCountsConsistent =
    isFiniteInteger(result.memberCount) &&
    result.memberCount === members.length &&
    isFiniteInteger(result.blockedMemberCount) &&
    result.blockedMemberCount === blockedMemberCount &&
    isFiniteInteger(result.skippedMemberCount) &&
    result.skippedMemberCount === skippedMemberCount &&
    isFiniteInteger(verdict?.usableMemberCount) &&
    verdict!.usableMemberCount === completedMemberIds.length &&
    isFiniteInteger(verdict?.blockedMemberCount) &&
    verdict!.blockedMemberCount === blockedMemberCount;
  const participationMemberIds = new Set(
    participationRoles
      .filter(isRecord)
      .map((role) => String(role.memberId || '')),
  );
  const participationRoleProvenanceComplete =
    participationRoles.length === members.length &&
    participationMemberIds.size === members.length &&
    [...memberIds].every((memberId) => participationMemberIds.has(memberId)) &&
    participationRoles.every(
      (role) =>
        isRecord(role) &&
        role.action === 'call' &&
        members.some(
          (member) =>
            isRecord(member) &&
            member.memberId === role.memberId &&
            member.providerId === role.providerId &&
            member.role === role.role,
        ),
    );
  const requiredCouncilRoles = new Set(['planner', 'synthesizer', 'verifier']);
  const participationRolesClean = participationRoles.every(
    (role) =>
      isRecord(role) &&
      role.action === 'call' &&
      role.healthState === 'healthy' &&
      role.failureClass === 'none' &&
      role.riskFlag === '' &&
      (role.substituteProviderId === null ||
        role.substituteProviderId === undefined) &&
      (!requiredCouncilRoles.has(String(role.role)) || role.required === true),
  );
  const participationFull =
    participation?.status === 'full' &&
    skippedProviderIds.length === 0 &&
    substitutedRoles.length === 0 &&
    allMembersCompleted &&
    participationRoleProvenanceComplete &&
    participationRolesClean;
  const requiredEvidenceRank = evidenceRank(evidence?.requiredGrade);
  const availableEvidenceRank = evidenceRank(evidence?.availableGrade);
  const sourceCoverageEntries = isRecord(evidence?.sourceCoverage)
    ? Object.values(evidence.sourceCoverage)
    : [];
  const sourceCoveragePresent =
    sourceCoverageEntries.length > 0 &&
    sourceCoverageEntries.some(
      (value) =>
        typeof value === 'number' && Number.isFinite(value) && value > 0,
    );
  const evidenceSufficient =
    evidenceStructurallyValid &&
    requiredEvidenceRank > 0 &&
    availableEvidenceRank >= requiredEvidenceRank &&
    evidence?.gapCount === evidenceGapIds.length &&
    evidenceGapIds.length === 0 &&
    sourceCoveragePresent;
  const confidence = verdict?.confidence;
  const confidenceMath = verdict?.confidenceMath;
  const confidenceMathFields = confidenceMath
    ? [
        confidenceMath.base,
        confidenceMath.degradedParticipationPenalty,
        confidenceMath.providerFailurePenalty,
        confidenceMath.evidencePenalty,
        confidenceMath.verdictPenalty,
        confidenceMath.schemaPenalty,
        confidenceMath.final,
      ]
    : [];
  const expectedConfidence = confidenceMath
    ? Math.max(
        0.05,
        Math.min(
          0.95,
          Number(
            (
              confidenceMath.base -
              confidenceMath.degradedParticipationPenalty -
              confidenceMath.providerFailurePenalty -
              confidenceMath.evidencePenalty -
              confidenceMath.verdictPenalty -
              confidenceMath.schemaPenalty
            ).toFixed(2),
          ),
        ),
      )
    : Number.NaN;
  const confidenceCalibrated =
    typeof confidence === 'number' &&
    confidence >= 0.55 &&
    confidence <= 1 &&
    confidenceMathFields.length === 7 &&
    confidenceMathFields.every(Number.isFinite) &&
    Math.abs(confidence - confidenceMath!.final) <= 0.011 &&
    Math.abs(expectedConfidence - confidenceMath!.final) <= 0.011;
  const platformRecordFallback = resultRiskFlags.includes(
    'platform_council_record_local_fallback',
  );
  const platformRecordLocalRuntime = resultRiskFlags.includes(
    'platform_council_record_local_runtime',
  );
  const modeValid =
    result.mode === 'max_iq_council' &&
    verdict?.budget?.mode === 'max_iq_council' &&
    verdict?.ultrathinkTrace?.mode === 'max_iq_council';
  const allowedDirectives = new Set([
    'answer_constraint',
    'memory_learning_candidate',
  ]);
  const actionDirectivesSafe =
    actionDirectives.length > 0 &&
    actionDirectives.every(
      (directive) =>
        isRecord(directive) &&
        isNonEmptyString(directive.directive) &&
        allowedDirectives.has(directive.directive) &&
        (directive.approvalNeed === undefined ||
          directive.approvalNeed === null ||
          directive.approvalNeed === 'none') &&
        (directive.stopReason === undefined ||
          directive.stopReason === null ||
          directive.stopReason === '') &&
        (directive.riskFlags === undefined ||
          (isStringArray(directive.riskFlags) &&
            directive.riskFlags.length === 0)),
    );
  const verdictUsable =
    (verdict?.status === 'pass' || verdict?.status === 'warn') &&
    verdict.recommendedAction === 'answer' &&
    actionDirectivesSafe;
  const guidanceSourceMemberIds = isStringArray(answerGuidance?.sourceMemberIds)
    ? answerGuidance.sourceMemberIds
    : [];
  const answerGuidanceDirectives = Array.isArray(
    answerGuidance?.actionDirectives,
  )
    ? answerGuidance.actionDirectives
    : [];
  const answerGuidanceConsistent =
    Boolean(answerGuidance) &&
    (answerGuidance?.status === 'pass' || answerGuidance?.status === 'warn') &&
    answerGuidance.status === verdict?.status &&
    answerGuidance.recommendedAction === verdict?.recommendedAction &&
    answerGuidance.approvalNeed === verdict?.approvalNeed &&
    answerGuidance.evidenceGrade === verdict?.evidenceGrade &&
    typeof answerGuidance.confidence === 'number' &&
    Math.abs(answerGuidance.confidence - (verdict?.confidence ?? -1)) <=
      0.011 &&
    isStringArray(answerGuidance.riskFlags) &&
    answerGuidance.riskFlags.length === 0 &&
    guidanceSourceMemberIds.length === completedMemberIds.length &&
    new Set(guidanceSourceMemberIds).size === completedMemberIds.length &&
    completedMemberIds.every((memberId) =>
      guidanceSourceMemberIds.includes(memberId),
    ) &&
    answerGuidanceDirectives.length === actionDirectives.length &&
    answerGuidanceDirectives.every(
      (directive, index) =>
        directive.directive ===
        (isRecord(actionDirectives[index])
          ? actionDirectives[index].directive
          : undefined),
    );
  const approvalBoundaryClean =
    result.approvalRequired === false &&
    verdict?.approvalNeed === 'none' &&
    answerGuidance?.approvalNeed === 'none';
  const privacyBoundaryClean =
    evidence?.privateContentPolicy === 'metadata_only' &&
    verdict?.quality?.rawPromptsStored === false &&
    verdict?.quality?.rawPrivateBodiesStored === false &&
    verdict?.ultrathinkTrace?.rawThinkingStored === false &&
    verdict?.ultrathinkTrace?.hiddenReasoningExposed === false;
  const budget = verdict?.budget;
  const budgetValid =
    budget?.status === 'within_budget' &&
    budget.loopGuardTriggered === false &&
    isFiniteInteger(budget.maxRoles, 1) &&
    isFiniteInteger(budget.usedRoles, 1) &&
    budget.usedRoles === members.length &&
    budget.usedRoles <= budget.maxRoles &&
    isFiniteInteger(budget.maxRetries) &&
    isFiniteInteger(budget.retryCount) &&
    budget.retryCount <= budget.maxRetries &&
    isFiniteInteger(budget.maxConcurrency, 1) &&
    isFiniteInteger(budget.roleTimeoutMs, 1_000);
  const resultRiskFlagsAllowed = resultRiskFlags.every(
    (flag) => flag === 'platform_council_record_local_runtime',
  );
  const memberRiskFlagsClean = members.every(
    (member) =>
      isRecord(member) &&
      isStringArray(member.riskFlags) &&
      member.riskFlags.length === 0,
  );
  const riskStateClean =
    resultRiskFlagsAllowed &&
    verdictRiskFlags.length === 0 &&
    participationRiskFlags.length === 0 &&
    memberRiskFlagsClean &&
    isStringArray(answerGuidance?.riskFlags) &&
    answerGuidance.riskFlags.length === 0 &&
    providerFailures.length === 0;
  const reasons: string[] = [];
  if (!inputStructureValid) reasons.push('proof_shape_invalid');
  if (!result.councilRunId) reasons.push('council_run_missing');
  if (!modeValid) reasons.push('council_mode_invalid');
  if (!schemaConsistent) reasons.push('schema_summary_inconsistent');
  if (schema?.invalid_fallback !== 0) reasons.push('schema_invalid_fallback');
  if (!memberCountsConsistent) reasons.push('member_counts_inconsistent');
  if (!isStringArray(verdict?.evidenceIds) || !verdict.evidenceIds.length)
    reasons.push('evidence_ids_missing');
  if (!evidenceSufficient) reasons.push('evidence_insufficient');
  if (evidenceGapIds.length > 0) reasons.push('evidence_gaps_present');
  if (!completedVerifier) reasons.push('completed_verifier_missing');
  if (!providerProvenanceComplete)
    reasons.push('provider_provenance_incomplete');
  if (!participationFull) reasons.push('provider_participation_degraded');
  if (!participationRolesClean)
    reasons.push('participation_role_state_unclean');
  if (providerFailures.length > 0) reasons.push('provider_failure');
  if (!confidenceCalibrated) reasons.push('confidence_uncalibrated');
  if (!budgetValid) reasons.push('run_budget_not_clean');
  if (!verdictUsable) reasons.push('verdict_not_usable');
  if (!answerGuidanceConsistent) reasons.push('answer_guidance_inconsistent');
  if (!approvalBoundaryClean) reasons.push('approval_boundary_not_clean');
  if (!privacyBoundaryClean) reasons.push('privacy_boundary_not_clean');
  if (!riskStateClean) reasons.push('risk_state_not_clean');
  if (
    verdict?.ultrathinkTrace?.requested !== true ||
    verdict.ultrathinkTrace.display !== 'omitted'
  )
    reasons.push('ultrathink_trace_missing');
  if (platformRecordFallback) reasons.push('platform_record_fallback');
  const passed = reasons.length === 0;
  return {
    passed,
    terminal: passed
      ? 'completed'
      : platformRecordFallback ||
          participation?.status === 'degraded' ||
          substitutedRoles.length
        ? 'completed_degraded'
        : 'blocked',
    reasons,
    completedVerifier,
    providerProvenanceComplete,
    participationFull,
    evidenceSufficient,
    confidenceCalibrated,
    inputStructureValid,
    schemaConsistent,
    memberCountsConsistent,
    answerGuidanceConsistent,
    participationRolesClean,
    modeValid,
    verdictUsable,
    approvalBoundaryClean,
    privacyBoundaryClean,
    budgetValid,
    riskStateClean,
    platformRecordFallback,
    platformRecordLocalRuntime,
    evidenceGapIds,
  };
}
