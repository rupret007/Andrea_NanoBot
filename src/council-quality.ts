import { randomUUID } from 'node:crypto';

import {
  getCouncilRunLedger,
  insertCouncilOutcomeSignal,
  listCouncilOutcomeSignals,
  listCouncilRunLedger,
  upsertCouncilRunLedger,
} from './db.js';
import { redactCouncilText } from './council-safety.js';
import { buildCouncilTaskEaseReport } from './council-task-drills.js';
import { buildIntegrationDoctorReport } from './integration-doctor.js';
import type {
  AndreaPlatformCouncilMode,
  AndreaPlatformProviderCouncilResult,
  PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import type {
  CouncilCalibrationSnapshot,
  CouncilDoctorReport,
  CouncilOutcomeSignalKind,
  CouncilProviderReliabilitySnapshot,
  CouncilRunLedgerRecord,
  CouncilRunOrigin,
} from './types.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';

const LOW_CONFIDENCE_THRESHOLD = 0.55;
const CALIBRATION_LOOKBACK = 40;
const DOCTOR_LOOKBACK = 50;

function normalizedRunOrigin(
  run: Pick<CouncilRunLedgerRecord, 'councilRunId' | 'runOrigin'>,
): CouncilRunOrigin {
  return /^(?:local-council:)?council-challenge-/i.test(run.councilRunId)
    ? 'synthetic'
    : run.runOrigin;
}

function normalizeRunOrigin(
  run: CouncilRunLedgerRecord,
): CouncilRunLedgerRecord {
  const runOrigin = normalizedRunOrigin(run);
  return runOrigin === run.runOrigin ? run : { ...run, runOrigin };
}

interface CouncilMemberStatusForQuality {
  memberId?: string;
  providerId?: string;
  role?: string;
  status?: string;
  verdict?: string;
  confidence?: number;
  schemaStatus?: string;
  riskFlags?: string[];
}

export interface CouncilReplayReport {
  generatedAt: string;
  latestRunId: string | null;
  taskFamily: string | null;
  mode: string | null;
  finalStatus: string | null;
  recommendedAction: string | null;
  confidence: number | null;
  evidenceGrade: string | null;
  approvalNeed: string | null;
  evidenceScorecard: Record<string, unknown>;
  evidenceGaps: string[];
  providerFailures: string[];
  riskFlags: string[];
  members: CouncilMemberStatusForQuality[];
  confidenceMath: Record<string, unknown>;
  budget: Record<string, unknown>;
  replaySummary: string;
  privacy: {
    redactedMetadataOnly: boolean;
    rawPromptsStored: boolean;
    rawPrivateBodiesStored: boolean;
  };
}

export interface CouncilCalibrationInput {
  taskFamily: PlatformTaskFamily;
  requestedMode?: AndreaPlatformCouncilMode | null;
  riskLevel?: 'low' | 'medium' | 'high';
  allowedSideEffects?: 'none' | 'read_only' | 'approval_required';
  thinkingControl?: string | null;
}

export interface RecordCouncilRunLedgerInput {
  councilRunId: string;
  runOrigin?: CouncilRunOrigin;
  groupFolder?: string | null;
  taskFamily: PlatformTaskFamily;
  channel?: string | null;
  requestedMode?: string | null;
  chosenMode: string;
  calibration: CouncilCalibrationSnapshot;
  status?: string | null;
  structuredVerdict?: AndreaPlatformProviderCouncilResult['structuredVerdict'];
  providerFailures?: string[];
  riskFlags?: string[];
  now?: string;
}

export interface RecordCouncilOutcomeSignalInput {
  councilRunId?: string | null;
  signalKind: CouncilOutcomeSignalKind;
  groupFolder?: string | null;
  channel?: string | null;
  routeKey?: string | null;
  capabilityId?: string | null;
  blockerClass?: string | null;
  feedbackId?: string | null;
  repairPlanId?: string | null;
  flags?: string[];
  summary: string;
  now?: string;
}

export function calibrateCouncilMode(
  input: CouncilCalibrationInput,
): CouncilCalibrationSnapshot {
  const requestedMode = input.requestedMode || 'dual_review';
  const recentRuns = safeListCouncilRunLedger({
    taskFamily: input.taskFamily,
    runOrigins: ['live'],
    limit: CALIBRATION_LOOKBACK,
  });
  const providerReliability = buildCouncilProviderReliability(recentRuns);
  const degradedProviderIds = providerReliability
    .filter((provider) => provider.degraded)
    .map((provider) => provider.providerId);
  const qualityAssessments = recentRuns.map(assessCouncilRunQuality);
  const lowConfidenceRuns = qualityAssessments.filter(
    (assessment) => !assessment.confidenceCalibrated,
  ).length;
  const lowQualityRuns = qualityAssessments.filter(
    (assessment) => assessment.score < 0.7,
  ).length;
  const schemaInvalidRuns = recentRuns.filter((run) =>
    hasSchemaInvalidFallback(run),
  ).length;
  const verifierBlockRuns = recentRuns.filter(
    (run, index) =>
      hasVerifierBlock(run) &&
      !qualityAssessments[index]?.appropriatelyCautious,
  ).length;
  const negativeFeedbackRuns = recentRuns.filter((run) =>
    /feedback_negative|repair_linked/i.test(run.outcomeStatus || ''),
  ).length;
  const protectedMode = isProtectedCouncilRoute(input);
  const degradationScore =
    lowQualityRuns +
    lowConfidenceRuns +
    schemaInvalidRuns * 2 +
    verifierBlockRuns * 2 +
    negativeFeedbackRuns * 2 +
    degradedProviderIds.length;
  const shouldPromote = recentRuns.length >= 2 && degradationScore >= 2;
  const chosenMode =
    !protectedMode && shouldPromote
      ? promoteCouncilMode(requestedMode)
      : requestedMode;
  const changedMode = chosenMode !== requestedMode;
  const reason = protectedMode
    ? 'protected_route_no_downshift'
    : changedMode
      ? `promoted_due_to_recent_quality_signals:${degradationScore}`
      : recentRuns.length === 0
        ? 'no_history_default_route'
        : 'history_ok_default_route';

  return {
    taskFamily: input.taskFamily,
    requestedMode,
    chosenMode,
    changedMode,
    protectedMode,
    reason,
    recentRuns: recentRuns.length,
    lowConfidenceRuns,
    schemaInvalidRuns,
    verifierBlockRuns,
    negativeFeedbackRuns,
    degradedProviderIds,
    providerReliability,
  };
}

export function buildCouncilProviderReliability(
  records: CouncilRunLedgerRecord[],
): CouncilProviderReliabilitySnapshot[] {
  const byProvider = new Map<
    string,
    {
      providerId: string;
      role: string;
      runs: number;
      completed: number;
      blocked: number;
      skipped: number;
    }
  >();
  for (const run of records) {
    for (const member of parseMemberStatuses(run.memberStatusesJson)) {
      const providerId = member.providerId || member.memberId || 'unknown';
      const role = member.role || 'unknown';
      const key = `${providerId}:${role}`;
      const bucket = byProvider.get(key) || {
        providerId,
        role,
        runs: 0,
        completed: 0,
        blocked: 0,
        skipped: 0,
      };
      bucket.runs += 1;
      if (member.status === 'completed') bucket.completed += 1;
      else if (member.status === 'skipped') bucket.skipped += 1;
      else bucket.blocked += 1;
      byProvider.set(key, bucket);
    }
  }
  return Array.from(byProvider.values())
    .map((item) => {
      const recentFailureRate =
        item.runs > 0 ? (item.blocked + item.skipped) / item.runs : 0;
      return {
        ...item,
        recentFailureRate: Number(recentFailureRate.toFixed(3)),
        degraded: item.runs >= 3 && recentFailureRate >= 0.67,
      };
    })
    .sort((a, b) => b.recentFailureRate - a.recentFailureRate);
}

export function recordCouncilRunLedger(
  input: RecordCouncilRunLedgerInput,
): CouncilRunLedgerRecord {
  const now = input.now || new Date().toISOString();
  const existing = safeGetCouncilRunLedger(input.councilRunId);
  const verdict = input.structuredVerdict;
  const replayArtifact = verdict?.replayArtifact;
  const record: CouncilRunLedgerRecord = {
    councilRunId: input.councilRunId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    runOrigin: /^(?:local-council:)?council-challenge-/i.test(
      input.councilRunId,
    )
      ? 'synthetic'
      : input.runOrigin || existing?.runOrigin || 'live',
    groupFolder: input.groupFolder || null,
    taskFamily: input.taskFamily,
    channel: input.channel || null,
    requestedMode: input.requestedMode || null,
    chosenMode: input.chosenMode,
    calibrationReason: input.calibration.reason,
    calibrationChanged: input.calibration.changedMode,
    protectedMode: input.calibration.protectedMode,
    status: sanitizeScalar(input.status || 'completed', 80),
    finalStatus: sanitizeScalar(verdict?.status || 'inconclusive', 80),
    recommendedAction: sanitizeScalar(
      verdict?.recommendedAction || 'answer',
      80,
    ),
    confidence: clampConfidence(verdict?.confidence),
    evidenceGrade: sanitizeScalar(verdict?.evidenceGrade || 'unknown', 80),
    approvalNeed: sanitizeScalar(verdict?.approvalNeed || 'none', 80),
    memberStatusesJson: safeJson(
      replayArtifact?.memberStatuses ||
        parseMemberStatuses(existing?.memberStatusesJson || '[]'),
      12000,
    ),
    providerFailuresJson: safeJson(input.providerFailures || [], 8000),
    schemaStatusJson: safeJson(verdict?.schemaStatusSummary || {}, 2000),
    evidenceScorecardJson: safeJson(verdict?.evidenceScorecard || {}, 8000),
    confidenceMathJson: safeJson(verdict?.confidenceMath || {}, 4000),
    budgetJson: safeJson(verdict?.budget || {}, 4000),
    replaySummary: redactCouncilText(verdict?.replaySummary || '', 1000),
    riskFlagsJson: safeJson(input.riskFlags || verdict?.riskFlags || [], 8000),
    outcomeSignalCount: existing?.outcomeSignalCount || 0,
    latestOutcomeAt: existing?.latestOutcomeAt || null,
    outcomeStatus: existing?.outcomeStatus || null,
  };
  try {
    upsertCouncilRunLedger(record);
  } catch {
    // The council runner is allowed to operate in isolated harnesses before DB
    // initialization. Persistence is best-effort; answering should continue.
  }
  return record;
}

export function recordCouncilOutcomeSignal(
  input: RecordCouncilOutcomeSignalInput,
): boolean {
  if (!input.councilRunId) return false;
  const now = input.now || new Date().toISOString();
  try {
    if (!getCouncilRunLedger(input.councilRunId)) return false;
    insertCouncilOutcomeSignal({
      signalId: randomUUID(),
      councilRunId: input.councilRunId,
      createdAt: now,
      groupFolder: input.groupFolder || null,
      channel: input.channel || null,
      signalKind: input.signalKind,
      routeKey: sanitizeNullable(input.routeKey, 120),
      capabilityId: sanitizeNullable(input.capabilityId, 120),
      blockerClass: sanitizeNullable(input.blockerClass, 180),
      feedbackId: sanitizeNullable(input.feedbackId, 120),
      repairPlanId: sanitizeNullable(input.repairPlanId, 120),
      flagsJson: safeJson(input.flags || [], 4000),
      summary: redactCouncilText(input.summary, 700),
    });
    return true;
  } catch {
    return false;
  }
}

function safeGetCouncilRunLedger(
  councilRunId: string,
): CouncilRunLedgerRecord | undefined {
  try {
    return getCouncilRunLedger(councilRunId);
  } catch {
    return undefined;
  }
}

function safeListCouncilRunLedger(params: {
  taskFamily?: string;
  runOrigins?: CouncilRunOrigin[];
  limit?: number;
}): CouncilRunLedgerRecord[] {
  try {
    return listCouncilRunLedger({
      taskFamily: params.taskFamily,
      limit: Math.max(params.limit || 100, 1000),
    })
      .map(normalizeRunOrigin)
      .filter(
        (run) =>
          !params.runOrigins?.length ||
          params.runOrigins.includes(run.runOrigin),
      )
      .slice(0, params.limit || 100);
  } catch {
    return [];
  }
}

export function buildCouncilDoctorReport(
  now = new Date().toISOString(),
  options: {
    providerHealth?: ProviderHealthSnapshot[];
    integrationHealth?: Array<{ integrationId: string; state: string }>;
  } = {},
): CouncilDoctorReport {
  const allRuns = safeListCouncilRunLedger({ limit: DOCTOR_LOOKBACK });
  const runs = allRuns.filter((run) => run.runOrigin === 'live');
  const signals = listCouncilOutcomeSignals({ limit: DOCTOR_LOOKBACK });
  const taskEase = buildCouncilTaskEaseReport({ now: new Date(now) });
  const currentProviderHealth =
    options.providerHealth || safeCollectProviderHealth(now);
  const currentHealthyProviderIds = new Set(
    currentProviderHealth
      .filter((provider) => provider.state === 'healthy')
      .map((provider) => provider.providerId),
  );
  const providerReliability = buildCouncilProviderReliability(runs);
  const providerParticipation = buildLatestProviderParticipation(
    runs,
    currentHealthyProviderIds,
  );
  const qualityAssessments = runs.map(assessCouncilRunQuality);
  const qualityScore = recencyWeightedCouncilQuality(qualityAssessments);
  const decisionAppropriateRuns = qualityAssessments.filter(
    (assessment) => assessment.decisionAppropriate,
  ).length;
  const appropriatelyCautiousRuns = qualityAssessments.filter(
    (assessment) => assessment.appropriatelyCautious,
  ).length;
  const operationallyDegradedRuns = qualityAssessments.filter(
    (assessment) => assessment.operationallyDegraded,
  ).length;
  const uncalibratedRuns = qualityAssessments.filter(
    (assessment) => !assessment.confidenceCalibrated,
  ).length;
  const lowConfidenceRuns = runs.filter(
    (run) => run.confidence < LOW_CONFIDENCE_THRESHOLD,
  ).length;
  const schemaInvalidRuns = runs.filter((run) =>
    hasSchemaInvalidFallback(run),
  ).length;
  const degradedRuns = runs.filter((run) => isDegradedRun(run)).length;
  const blockedRuns = runs.filter(
    (run) =>
      run.recommendedAction === 'block' ||
      run.finalStatus === 'block' ||
      run.finalStatus === 'inconclusive',
  ).length;
  const clarifiedRuns = runs.filter(
    (run) =>
      run.recommendedAction === 'ask_clarifying_question' &&
      run.finalStatus !== 'block' &&
      run.finalStatus !== 'inconclusive',
  ).length;
  const answerableRuns = runs.filter(
    (run) =>
      run.recommendedAction === 'answer' &&
      run.finalStatus !== 'block' &&
      run.finalStatus !== 'inconclusive',
  ).length;
  const averageConfidence =
    runs.length > 0
      ? Number(
          (
            runs.reduce((sum, run) => sum + run.confidence, 0) / runs.length
          ).toFixed(3),
        )
      : 0;
  const lastRun = runs[0];
  const degradedReasons = collectDegradedReasons(runs);
  const latestRunEvidenceGaps = lastRun ? collectEvidenceGaps([lastRun]) : [];
  const historicalRunEvidenceGaps = collectEvidenceGaps(runs.slice(1)).filter(
    (gap) => !latestRunEvidenceGaps.includes(gap),
  );
  const integrationHealth =
    options.integrationHealth || safeCollectIntegrationHealth();
  const resolvedEvidenceGaps = [
    ...latestRunEvidenceGaps,
    ...historicalRunEvidenceGaps,
  ].filter((gap) => evidenceGapIsResolved(gap, integrationHealth));
  const evidenceGaps = latestRunEvidenceGaps.filter(
    (gap) => !resolvedEvidenceGaps.includes(gap),
  );
  const historicalEvidenceGaps = historicalRunEvidenceGaps.filter(
    (gap) => !resolvedEvidenceGaps.includes(gap),
  );
  const ok =
    runs.length > 0 &&
    qualityScore >= 0.85 &&
    uncalibratedRuns === 0 &&
    qualityAssessments[0]?.operationallyDegraded === false &&
    schemaInvalidRuns === 0 &&
    providerReliability.every((provider) => !provider.degraded);
  const hasHistoricallyDegradedProviders = providerReliability.some(
    (provider) => provider.degraded,
  );
  const currentCoreProvidersHealthy = [
    'openai_cloud',
    'anthropic_cloud',
    'gemini_cloud',
    'minimax_cloud',
    'brave_search',
  ].every((providerId) => currentHealthyProviderIds.has(providerId));
  const nextAction =
    runs.length === 0
      ? 'Run one `ultrathink` Telegram proof turn, then rerun npm run debug:council.'
      : ok
        ? 'Run a fresh live `ultrathink` proof after major changes, then keep the challenge ladder green.'
        : currentCoreProvidersHealthy && hasHistoricallyDegradedProviders
          ? 'Providers are currently healthy; run npm run test:council:medium and one live `ultrathink` proof to retire stale degradation history.'
          : 'Run npm run test:council:medium and one live `ultrathink` proof, then inspect degraded provider/replay reasons.';
  return {
    generatedAt: now,
    ok,
    summary:
      runs.length === 0
        ? 'Council quality ledger has no recorded live runs yet; replay and synthetic runs are excluded from promotion signals.'
        : `${runs.length} recent live council run(s); quality ${qualityScore.toFixed(2)}; ${operationallyDegradedRuns} operationally degraded; ${appropriatelyCautiousRuns} appropriately cautious.`,
    lastRun: lastRun
      ? {
          councilRunId: lastRun.councilRunId,
          createdAt: lastRun.createdAt,
          taskFamily: lastRun.taskFamily,
          mode: lastRun.chosenMode,
          finalStatus: lastRun.finalStatus,
          confidence: lastRun.confidence,
          replaySummary: lastRun.replaySummary,
        }
      : null,
    recent: {
      totalRuns: runs.length,
      liveRuns: runs.length,
      replayRuns: allRuns.filter((run) => run.runOrigin === 'replay').length,
      syntheticRuns: allRuns.filter((run) => run.runOrigin === 'synthetic')
        .length,
      degradedRuns,
      answerableRuns,
      clarifiedRuns,
      blockedRuns,
      averageConfidence,
      schemaInvalidRuns,
      lowConfidenceRuns,
      qualityScore,
      decisionAppropriateRuns,
      appropriatelyCautiousRuns,
      operationallyDegradedRuns,
      uncalibratedRuns,
      outcomeSignals: signals.length,
    },
    providerReliability,
    currentProviderHealth: currentProviderHealth.map((provider) => ({
      providerId: provider.providerId,
      state: provider.state,
      failureClass: provider.failureClass,
      quotaState: provider.quotaState,
      credentialState: provider.credentialState,
    })),
    providerParticipation,
    degradedReasons,
    evidenceGaps,
    historicalEvidenceGaps,
    resolvedEvidenceGaps,
    taskEase: {
      status: taskEase.status,
      score: taskEase.score,
      lastAttemptId: taskEase.outcome.attemptId,
      lastOutcome: taskEase.attempts[0]?.outcome || 'none',
      outcomeSignalCount: taskEase.outcome.outcomeSignalCount,
      sourcePatternCoverage: `${taskEase.sourcePatternCoverage.filter((pattern) => pattern.verified).length}/${taskEase.sourcePatternCoverage.length}`,
      qualityGateCoverage: `${taskEase.qualityGates.filter((gate) => gate.status === 'pass').length}/${taskEase.qualityGates.length}`,
      nextAction: taskEase.nextAction,
    },
    nextAction,
    privacy: {
      secretsRedacted: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
    },
  };
}

export function formatCouncilDoctorReport(report: CouncilDoctorReport): string {
  const degradedProviders = report.providerReliability
    .filter((provider) => provider.degraded)
    .slice(0, 5)
    .map(
      (provider) =>
        `${provider.providerId}/${provider.role} ${(provider.recentFailureRate * 100).toFixed(0)}%`,
    );
  const currentProviders = (report.currentProviderHealth || [])
    .slice()
    .sort((a, b) => a.providerId.localeCompare(b.providerId))
    .map((provider) =>
      provider.state === 'healthy'
        ? `${provider.providerId}=healthy`
        : `${provider.providerId}=${provider.state}/${provider.failureClass}`,
    );
  const replay = buildCouncilReplayReport(report.generatedAt);
  const replayLines = replay.latestRunId
    ? [
        `Latest discussion: action=${replay.recommendedAction || 'unknown'} evidence=${String(replay.evidenceScorecard.availableGrade || 'unknown')}/${String(replay.evidenceScorecard.requiredGrade || 'unknown')} members=${replay.members.length}`,
        `Council risks: ${[...replay.providerFailures, ...replay.riskFlags].slice(0, 4).join(', ') || 'none'}`,
      ]
    : ['Latest discussion: none recorded'];
  return [
    'Council Status',
    '',
    `Health: ${report.ok ? 'healthy' : 'needs attention'}`,
    `Summary: ${report.summary}`,
    report.lastRun
      ? `Last run: ${report.lastRun.taskFamily} ${report.lastRun.mode} ${report.lastRun.finalStatus} confidence=${report.lastRun.confidence.toFixed(2)}`
      : 'Last run: none',
    `Outcome signals: ${report.recent.outcomeSignals}`,
    `Schema invalid runs: ${report.recent.schemaInvalidRuns}`,
    `Low-confidence runs: ${report.recent.lowConfidenceRuns}`,
    `Outcome-led quality: ${(report.recent.qualityScore ?? 0).toFixed(2)} appropriate=${report.recent.decisionAppropriateRuns ?? 0}/${report.recent.totalRuns} cautious=${report.recent.appropriatelyCautiousRuns ?? 0} uncalibrated=${report.recent.uncalibratedRuns ?? 0}`,
    `Operationally degraded runs: ${report.recent.operationallyDegradedRuns ?? report.recent.degradedRuns}`,
    `Live outcomes: answerable=${report.recent.answerableRuns || 0} clarify=${report.recent.clarifiedRuns || 0} blocked=${report.recent.blockedRuns || 0}`,
    `Current providers: ${currentProviders.join(', ') || 'unknown'}`,
    `Historical degraded providers: ${degradedProviders.join(', ') || 'none'}`,
    report.providerParticipation
      ? `Provider participation: ${report.providerParticipation.status} skipped=${report.providerParticipation.skippedProviderIds.join(', ') || 'none'} substituted=${report.providerParticipation.substitutedRoles.join(', ') || 'none'}`
      : 'Provider participation: none recorded',
    ...replayLines,
    `Current evidence gaps: ${report.evidenceGaps.slice(0, 4).join(', ') || 'none'}`,
    ...(report.historicalEvidenceGaps?.length
      ? [
          `Historical evidence gaps: ${report.historicalEvidenceGaps.slice(0, 4).join(', ')}`,
        ]
      : []),
    ...(report.resolvedEvidenceGaps?.length
      ? [
          `Resolved recorded gaps: ${report.resolvedEvidenceGaps.slice(0, 4).join(', ')}`,
        ]
      : []),
    report.taskEase
      ? `Task-ease: ${report.taskEase.status} score=${report.taskEase.score.toFixed(2)} source_patterns=${report.taskEase.sourcePatternCoverage} quality_gates=${report.taskEase.qualityGateCoverage} outcome_signals=${report.taskEase.outcomeSignalCount}`
      : 'Task-ease: unavailable',
    `Privacy: secrets redacted, raw prompts stored=${report.privacy.rawPromptsStored}, raw private bodies stored=${report.privacy.rawPrivateBodiesStored}`,
    `Next: ${report.nextAction || report.taskEase?.nextAction || 'rerun npm run debug:council after a proof turn.'}`,
  ].join('\n');
}

export function buildCouncilReplayReport(
  now = new Date().toISOString(),
  councilRunId?: string,
): CouncilReplayReport {
  const latest =
    (councilRunId ? safeGetCouncilRunLedger(councilRunId) : undefined) ||
    listCouncilRunLedger({ limit: 1 })[0] ||
    null;
  const evidenceScorecard = latest
    ? parseJsonObject(latest.evidenceScorecardJson)
    : {};
  const confidenceMath = latest
    ? parseJsonObject(latest.confidenceMathJson)
    : {};
  const budget = latest ? parseJsonObject(latest.budgetJson) : {};
  const evidenceGaps = Array.isArray(evidenceScorecard.gapIds)
    ? evidenceScorecard.gapIds
        .map((gap) => redactCouncilText(String(gap), 120))
        .filter(Boolean)
    : [];
  return {
    generatedAt: now,
    latestRunId: latest?.councilRunId || null,
    taskFamily: latest?.taskFamily || null,
    mode: latest?.chosenMode || null,
    finalStatus: latest?.finalStatus || null,
    recommendedAction: latest?.recommendedAction || null,
    confidence: latest ? latest.confidence : null,
    evidenceGrade: latest?.evidenceGrade || null,
    approvalNeed: latest?.approvalNeed || null,
    evidenceScorecard,
    evidenceGaps,
    providerFailures: latest
      ? parseJsonArray(latest.providerFailuresJson)
          .map((failure) => redactCouncilText(String(failure), 120))
          .filter(Boolean)
      : [],
    riskFlags: latest
      ? parseJsonArray(latest.riskFlagsJson)
          .map((flag) => redactCouncilText(String(flag), 120))
          .filter(Boolean)
      : [],
    members: latest ? parseMemberStatuses(latest.memberStatusesJson) : [],
    confidenceMath,
    budget,
    replaySummary: latest?.replaySummary || 'No council run recorded yet.',
    privacy: {
      redactedMetadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
    },
  };
}

export function formatCouncilReplayReport(report: CouncilReplayReport): string {
  const memberLines = report.members.length
    ? report.members.slice(0, 8).map((member) => {
        const label = `${member.role || 'member'}/${member.providerId || member.memberId || 'unknown'}`;
        const confidence =
          typeof member.confidence === 'number'
            ? ` confidence=${member.confidence.toFixed(2)}`
            : '';
        const risks =
          member.riskFlags && member.riskFlags.length > 0
            ? ` risks=${member.riskFlags.slice(0, 3).join(',')}`
            : '';
        return `- ${label}: ${member.status || 'unknown'} verdict=${member.verdict || 'unknown'}${confidence} schema=${member.schemaStatus || 'unknown'}${risks}`;
      })
    : ['- none recorded'];
  return [
    'Council Replay',
    '',
    `Latest run: ${report.latestRunId || 'none'}`,
    `Task/mode: ${report.taskFamily || 'none'} / ${report.mode || 'none'}`,
    `Final: ${report.finalStatus || 'none'} action=${report.recommendedAction || 'none'} confidence=${typeof report.confidence === 'number' ? report.confidence.toFixed(2) : 'unknown'} approval=${report.approvalNeed || 'unknown'}`,
    `Evidence: ${String(report.evidenceScorecard.availableGrade || 'unknown')}/${String(report.evidenceScorecard.requiredGrade || 'unknown')} gaps=${report.evidenceGaps.join(', ') || 'none'}`,
    `Provider failures: ${report.providerFailures.join(', ') || 'none'}`,
    `Risk flags: ${report.riskFlags.join(', ') || 'none'}`,
    'Members:',
    ...memberLines,
    `Confidence math: ${JSON.stringify(report.confidenceMath)}`,
    `Budget: ${JSON.stringify(report.budget)}`,
    `Replay: ${report.replaySummary}`,
    'Privacy: redacted metadata only; raw prompts/private bodies stored=false',
  ].join('\n');
}

function buildLatestProviderParticipation(
  records: CouncilRunLedgerRecord[],
  currentHealthyProviderIds = new Set<string>(),
): CouncilDoctorReport['providerParticipation'] {
  const latest = records[0];
  if (!latest) {
    return {
      status: 'none',
      skippedProviderIds: [],
      substitutedRoles: [],
      riskFlags: [],
      nextAction:
        'Run one council proof turn before judging provider participation.',
    };
  }
  const members = parseMemberStatuses(latest.memberStatusesJson);
  const skippedProviderIds = Array.from(
    new Set(
      members
        .filter(
          (member) =>
            member.status === 'skipped' || member.status === 'blocked',
        )
        .map((member) => member.providerId || member.memberId || 'unknown')
        .filter((providerId) => providerId !== 'unknown'),
    ),
  );
  const riskFlags = Array.from(
    new Set([
      ...parseJsonArray(latest.providerFailuresJson).map((flag) =>
        redactCouncilText(String(flag), 120),
      ),
      ...members.flatMap((member) =>
        (member.riskFlags || []).map((flag) => redactCouncilText(flag, 120)),
      ),
    ]),
  ).filter(Boolean);
  const substitutedRoles = Array.from(
    new Set(
      members.flatMap((member) => {
        const flags = member.riskFlags || [];
        if (
          member.memberId === 'openai_verifier_fallback' ||
          flags.includes('verifier_substituted_openai_for_gemini')
        ) {
          return ['verifier:gemini_cloud->openai_cloud'];
        }
        return [];
      }),
    ),
  );
  const requiredBlocked = members.some(
    (member) =>
      member.status === 'blocked' &&
      member.role !== 'verifier' &&
      member.role !== 'critic' &&
      member.role !== 'evidence_scout' &&
      !(
        currentHealthyProviderIds.has(
          member.providerId || member.memberId || 'unknown',
        ) &&
        (member.riskFlags || []).some((flag) =>
          /(?:^|_)transport_error$/i.test(flag),
        )
      ),
  );
  const status =
    members.length === 0
      ? 'none'
      : requiredBlocked
        ? 'minimal'
        : skippedProviderIds.length > 0 ||
            substitutedRoles.length > 0 ||
            riskFlags.some((flag) =>
              /provider|quota|auth|rate|blocked/i.test(flag),
            )
          ? 'degraded'
          : 'full';
  return {
    status,
    skippedProviderIds,
    substitutedRoles,
    riskFlags: riskFlags.slice(0, 12),
    nextAction:
      status === 'full'
        ? 'Provider participation is full for the latest council run.'
        : status === 'none'
          ? 'Run one council proof turn before judging provider participation.'
          : currentHealthyProviderIds.size > 0 &&
              skippedProviderIds.every((providerId) =>
                currentHealthyProviderIds.has(providerId),
              )
            ? 'Latest run had degraded participation, but providers are currently healthy; rerun a council proof to refresh the ledger.'
            : status === 'minimal'
              ? 'Repair required provider health before trusting deep council routes.'
              : 'Proceed with degraded-provider wording and rerun provider diagnostics after quota/auth recovery.',
  };
}

export function buildTelegramCouncilStatusText(): string {
  try {
    return formatCouncilDoctorReport(buildCouncilDoctorReport());
  } catch {
    return [
      'Council Status',
      '',
      'Health: unavailable',
      'Summary: council quality ledger is not initialized in this process yet.',
      'Last run: none',
      'Outcome signals: unknown',
      'Schema invalid runs: unknown',
      'Low-confidence runs: unknown',
      'Degraded providers: unknown',
      'Evidence gaps: unknown',
      'Task-ease: unavailable',
      'Privacy: secrets redacted, raw prompts stored=false, raw private bodies stored=false',
      'Next: run npm run debug:council on the host.',
    ].join('\n');
  }
}

export function isCouncilDoctorRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    /\bcouncil\s+(?:status|doctor|health|debug)\b/.test(normalized) ||
    /\bcouncil\s+tasks?\b/.test(normalized) ||
    /\b(?:how|what).*\bcouncil\b.*\b(?:doing|healthy|status)\b/.test(normalized)
  );
}

function isProtectedCouncilRoute(input: CouncilCalibrationInput): boolean {
  return (
    input.thinkingControl === 'deep' ||
    input.taskFamily === 'operator' ||
    input.taskFamily === 'code' ||
    input.requestedMode === 'max_iq_council' ||
    input.requestedMode === 'repair_council' ||
    input.allowedSideEffects === 'approval_required' ||
    input.riskLevel === 'high'
  );
}

function promoteCouncilMode(
  mode: AndreaPlatformCouncilMode,
): AndreaPlatformCouncilMode {
  if (mode === 'single_model') return 'dual_review';
  if (mode === 'dual_review') return 'max_iq_council';
  return mode;
}

function hasSchemaInvalidFallback(run: CouncilRunLedgerRecord): boolean {
  const schema = parseJsonObject(run.schemaStatusJson);
  return Number(schema.invalid_fallback || 0) > 0;
}

function hasVerifierBlock(run: CouncilRunLedgerRecord): boolean {
  if (run.finalStatus === 'block') return true;
  return parseMemberStatuses(run.memberStatusesJson).some(
    (member) => member.role === 'verifier' && member.verdict === 'block',
  );
}

export interface CouncilRunQualityAssessment {
  score: number;
  decisionAppropriate: boolean;
  appropriatelyCautious: boolean;
  confidenceCalibrated: boolean;
  operationallyDegraded: boolean;
  schemaValid: boolean;
  citationCoverage: number;
}

const EVIDENCE_GRADE_RANK: Record<string, number> = {
  unknown: 0,
  weak: 1,
  partial: 2,
  strong: 3,
};

export function assessCouncilRunQuality(
  run: CouncilRunLedgerRecord,
): CouncilRunQualityAssessment {
  const scorecard = parseJsonObject(run.evidenceScorecardJson);
  const requiredRank =
    EVIDENCE_GRADE_RANK[String(scorecard.requiredGrade || 'unknown')] || 0;
  const availableRank =
    EVIDENCE_GRADE_RANK[String(scorecard.availableGrade || 'unknown')] || 0;
  const evidenceShortfall = requiredRank > 0 && availableRank < requiredRank;
  const gapCount = Number(scorecard.gapCount || 0);
  const providerFailures = parseJsonArray(run.providerFailuresJson);
  const riskFlags = parseJsonArray(run.riskFlagsJson).map(String);
  const members = parseMemberStatuses(run.memberStatusesJson);
  const verifier = members.find((member) => member.role === 'verifier');
  const ambiguityOrMissingEvidence =
    evidenceShortfall ||
    gapCount > 0 ||
    riskFlags.some((flag) =>
      /(?:missing|ambiguous|incomplete|evidence_gap|no_saved|unclear|stale)/i.test(
        flag,
      ),
    );
  const action = run.recommendedAction;
  const decisionAppropriate =
    action === 'answer'
      ? verifier?.verdict !== 'block' &&
        !evidenceShortfall &&
        run.confidence >= LOW_CONFIDENCE_THRESHOLD
      : action === 'ask_clarifying_question'
        ? ambiguityOrMissingEvidence ||
          providerFailures.length > 0 ||
          verifier?.verdict === 'clarify'
        : action === 'block'
          ? providerFailures.length > 0 ||
            hasVerifierBlock(run) ||
            evidenceShortfall ||
            run.approvalNeed === 'explicit'
          : action === 'hold' || action === 'draft_only'
            ? ambiguityOrMissingEvidence ||
              providerFailures.length > 0 ||
              run.approvalNeed !== 'none'
            : false;
  const uncertaintyDriven =
    ambiguityOrMissingEvidence || providerFailures.length > 0;
  const confidenceCalibrated =
    run.confidence >= 0.1 &&
    (uncertaintyDriven
      ? run.confidence <= 0.75
      : run.confidence >= LOW_CONFIDENCE_THRESHOLD);
  const budget = parseJsonObject(run.budgetJson);
  const budgetStatus = String(budget.status || 'within_budget');
  const blockedMembers = members.filter(
    (member) => member.status === 'blocked',
  ).length;
  const operationallyDegraded =
    providerFailures.length > 0 ||
    budgetStatus !== 'within_budget' ||
    blockedMembers > 0;
  const operationalScore =
    budgetStatus === 'exceeded'
      ? 0
      : providerFailures.length > 0 || blockedMembers > 0
        ? 0.25
        : budgetStatus === 'degraded'
          ? 0.75
          : 1;
  const schemaValid = !hasSchemaInvalidFallback(run);
  const citationCoverageRecord =
    scorecard.citationCoverage &&
    typeof scorecard.citationCoverage === 'object' &&
    !Array.isArray(scorecard.citationCoverage)
      ? (scorecard.citationCoverage as Record<string, unknown>)
      : {};
  const citationTotal = Number(citationCoverageRecord.total || 0);
  const citationCount = Number(citationCoverageRecord.cited || 0);
  const citationCoverage =
    citationTotal > 0
      ? Math.max(0, Math.min(1, citationCount / citationTotal))
      : 0.5;
  const negativeOutcome = /feedback_negative|repair_linked/i.test(
    run.outcomeStatus || '',
  );
  const positiveOutcome =
    /guidance_applied|answer_sent|answer_clarified|safe_rewrite/i.test(
      run.outcomeStatus || '',
    );
  const baseScore =
    (decisionAppropriate ? 1 : 0) * 0.35 +
    (confidenceCalibrated ? 1 : 0) * 0.2 +
    operationalScore * 0.2 +
    (schemaValid ? 1 : 0) * 0.15 +
    citationCoverage * 0.1;
  const outcomeAdjustment = negativeOutcome
    ? -0.25
    : positiveOutcome
      ? 0.05
      : 0;
  const score = Number(
    Math.max(0, Math.min(1, baseScore + outcomeAdjustment)).toFixed(3),
  );
  return {
    score,
    decisionAppropriate,
    appropriatelyCautious:
      decisionAppropriate &&
      ['ask_clarifying_question', 'block', 'hold', 'draft_only'].includes(
        action,
      ),
    confidenceCalibrated,
    operationallyDegraded,
    schemaValid,
    citationCoverage: Number(citationCoverage.toFixed(3)),
  };
}

function recencyWeightedCouncilQuality(
  assessments: CouncilRunQualityAssessment[],
): number {
  if (!assessments.length) return 0;
  let weightedScore = 0;
  let totalWeight = 0;
  assessments.forEach((assessment, index) => {
    const weight = 0.7 ** index;
    weightedScore += assessment.score * weight;
    totalWeight += weight;
  });
  return Number((weightedScore / totalWeight).toFixed(3));
}

function isDegradedRun(run: CouncilRunLedgerRecord): boolean {
  return (
    run.finalStatus === 'inconclusive' ||
    hasSchemaInvalidFallback(run) ||
    parseJsonArray(run.providerFailuresJson).length > 0 ||
    /degraded|exceeded/i.test(run.budgetJson)
  );
}

function collectDegradedReasons(records: CouncilRunLedgerRecord[]): string[] {
  const reasons = new Set<string>();
  for (const run of records.slice(0, DOCTOR_LOOKBACK)) {
    const assessment = assessCouncilRunQuality(run);
    if (!assessment.confidenceCalibrated) {
      reasons.add(`uncalibrated_confidence:${run.taskFamily}`);
    }
    if (!assessment.decisionAppropriate) {
      reasons.add(`decision_not_supported:${run.taskFamily}`);
    }
    if (hasSchemaInvalidFallback(run)) reasons.add('schema_invalid_fallback');
    for (const failure of parseJsonArray(run.providerFailuresJson).slice(
      0,
      5,
    )) {
      reasons.add(redactCouncilText(String(failure), 120));
    }
    for (const flag of parseJsonArray(run.riskFlagsJson).slice(0, 5)) {
      if (
        /schema|repeated|provider|evidence|block|degraded/i.test(String(flag))
      ) {
        reasons.add(redactCouncilText(String(flag), 120));
      }
    }
  }
  return Array.from(reasons).slice(0, 10);
}

function collectEvidenceGaps(records: CouncilRunLedgerRecord[]): string[] {
  const gaps = new Set<string>();
  for (const run of records.slice(0, DOCTOR_LOOKBACK)) {
    const scorecard = parseJsonObject(run.evidenceScorecardJson);
    const gapIds = Array.isArray(scorecard.gapIds) ? scorecard.gapIds : [];
    for (const gap of gapIds.slice(0, 6)) {
      gaps.add(redactCouncilText(String(gap), 120));
    }
  }
  return Array.from(gaps).slice(0, 10);
}

function safeCollectIntegrationHealth(): Array<{
  integrationId: string;
  state: string;
}> {
  try {
    return buildIntegrationDoctorReport().statuses.map((status) => ({
      integrationId: status.integrationId,
      state: status.state,
    }));
  } catch {
    return [];
  }
}

function evidenceGapIsResolved(
  gap: string,
  integrationHealth: Array<{ integrationId: string; state: string }>,
): boolean {
  return integrationHealth.some(
    (status) =>
      status.state === 'healthy' &&
      gap.startsWith(`integration_${status.integrationId}_`),
  );
}

function parseMemberStatuses(value: string): CouncilMemberStatusForQuality[] {
  return parseJsonArray(value)
    .filter((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === 'object' && !Array.isArray(item)),
    )
    .map((item) => ({
      memberId: typeof item.memberId === 'string' ? item.memberId : undefined,
      providerId:
        typeof item.providerId === 'string' ? item.providerId : undefined,
      role: typeof item.role === 'string' ? item.role : undefined,
      status: typeof item.status === 'string' ? item.status : undefined,
      verdict: typeof item.verdict === 'string' ? item.verdict : undefined,
      confidence:
        typeof item.confidence === 'number' ? item.confidence : undefined,
      schemaStatus:
        typeof item.schemaStatus === 'string' ? item.schemaStatus : undefined,
      riskFlags: Array.isArray(item.riskFlags)
        ? item.riskFlags.filter(
            (flag): flag is string => typeof flag === 'string',
          )
        : [],
    }));
}

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeCollectProviderHealth(now: string): ProviderHealthSnapshot[] {
  try {
    return collectProviderHealthSnapshots(now);
  } catch {
    return [];
  }
}

function safeJson(value: unknown, limit: number): string {
  try {
    return redactCouncilText(JSON.stringify(value ?? null), limit) || 'null';
  } catch {
    return 'null';
  }
}

function sanitizeScalar(value: string, limit: number): string {
  return redactCouncilText(String(value || ''), limit);
}

function sanitizeNullable(
  value: string | null | undefined,
  limit: number,
): string | null {
  const sanitized = sanitizeScalar(value || '', limit);
  return sanitized || null;
}

function clampConfidence(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}
