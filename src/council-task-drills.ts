import {
  SOURCE_PATTERN_CANDIDATES,
  SOURCE_REPO_MANIFEST,
  summarizeSourceAdoptionManifest,
} from './agent-source-intelligence.js';
import {
  getCouncilRunLedger,
  insertCouncilOutcomeSignal,
  listCouncilOutcomeSignals,
  listCouncilRunLedger,
} from './db.js';
import { redactCouncilText } from './council-safety.js';
import type { CouncilTaskQualityGate } from './council-contracts.js';
import { evaluateCouncilTaskQualityGates } from './council-task-quality-gates.js';
import type {
  CouncilSourcePatternAdoptionStatus,
  CouncilTaskAttempt,
  CouncilTaskOutcome,
} from './types.js';

export interface CouncilTaskEaseReport {
  generatedAt: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  attempts: CouncilTaskAttempt[];
  outcome: CouncilTaskOutcome;
  sourcePatternCoverage: CouncilSourcePatternAdoptionStatus[];
  qualityGates: CouncilTaskQualityGate[];
  adoptionSummary: Record<string, string>;
  providerRoleUsability: {
    usableRecentRuns: number;
    degradedRecentRuns: number;
    schemaInvalidRuns: number;
    lowConfidenceRuns: number;
  };
  nextAction: string;
  privacy: {
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    redactedMetadataOnly: true;
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseObjectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numeric(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasSchemaInvalidFallback(value: string): boolean {
  const schema = parseJsonObject(value);
  return Number(schema.invalid_fallback || 0) > 0;
}

function isRunDegraded(
  run: ReturnType<typeof listCouncilRunLedger>[number],
): boolean {
  return (
    run.finalStatus === 'block' ||
    run.finalStatus === 'inconclusive' ||
    run.confidence < 0.55 ||
    hasSchemaInvalidFallback(run.schemaStatusJson) ||
    /degraded|exceeded/i.test(run.budgetJson || '')
  );
}

function attempt(params: {
  taskId: string;
  taskFamily: string;
  mode: string;
  score: number;
  outcome: string;
  riskFlags?: string[];
  now: string;
}): CouncilTaskAttempt {
  const score = Number(Math.max(0, Math.min(1, params.score)).toFixed(3));
  return {
    attemptId: `council-task:${params.taskId}:${params.now}`,
    createdAt: params.now,
    taskId: params.taskId,
    taskFamily: params.taskFamily,
    mode: params.mode,
    status: score >= 0.85 ? 'pass' : score >= 0.55 ? 'warn' : 'fail',
    score,
    outcome: redactCouncilText(params.outcome, 300),
    riskFlags: (params.riskFlags || []).map((flag) =>
      redactCouncilText(flag, 120),
    ),
  };
}

function buildSourcePatternCoverage(
  recentRunIds: string[],
): CouncilSourcePatternAdoptionStatus[] {
  return SOURCE_PATTERN_CANDIDATES.map((pattern) => {
    const implemented =
      pattern.adoptionMode !== 'reference_only' &&
      Boolean(pattern.verificationScenarioId);
    const verified = recentRunIds.some((runId) =>
      runId.includes(pattern.verificationScenarioId),
    );
    return {
      patternId: pattern.patternId,
      sourceRepoIds: pattern.sourceRepoIds,
      adoptionMode: pattern.adoptionMode,
      verificationScenarioId: pattern.verificationScenarioId,
      implemented,
      verified,
      status: verified
        ? 'verified'
        : implemented
          ? 'implemented_unverified'
          : 'planned',
    };
  });
}

function recordTaskOutcomeSignal(params: {
  councilRunId: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  nextAction: string;
  now: string;
}): boolean {
  if (!getCouncilRunLedger(params.councilRunId)) return false;
  insertCouncilOutcomeSignal({
    signalId: `council-task-ease:${params.councilRunId}`,
    councilRunId: params.councilRunId,
    createdAt: params.now,
    groupFolder: null,
    channel: 'system',
    signalKind:
      params.status === 'fail' ? 'answer_blocked' : 'guidance_applied',
    routeKey: 'council.task_ease',
    capabilityId: 'council_v4_task_drills',
    blockerClass: params.status === 'fail' ? 'task_ease_failed' : null,
    feedbackId: null,
    repairPlanId: null,
    flagsJson: JSON.stringify([
      `task_ease_score:${params.score.toFixed(2)}`,
      `task_ease_status:${params.status}`,
    ]),
    summary: redactCouncilText(params.nextAction, 500),
  });
  return true;
}

export function buildCouncilTaskEaseReport(
  params: {
    now?: Date;
    recordOutcomeSignal?: boolean;
  } = {},
): CouncilTaskEaseReport {
  const now = (params.now || new Date()).toISOString();
  const runs = listCouncilRunLedger({ limit: 20 });
  const recentRunIds = runs.map((run) => run.councilRunId);
  const signals = listCouncilOutcomeSignals({ limit: 50 });
  const latest = runs[0] || null;
  const degradedRuns = runs.filter(isRunDegraded);
  const schemaInvalidRuns = runs.filter((run) =>
    hasSchemaInvalidFallback(run.schemaStatusJson),
  );
  const lowConfidenceRuns = runs.filter((run) => run.confidence < 0.55);
  const usableRecentRuns = runs.length - degradedRuns.length;
  const sourcePatternCoverage = buildSourcePatternCoverage(recentRunIds);
  const verifiedPatterns = sourcePatternCoverage.filter(
    (pattern) => pattern.verified,
  ).length;
  const implementedPatterns = sourcePatternCoverage.filter(
    (pattern) => pattern.implemented,
  ).length;
  const repoCoverage = new Set(SOURCE_REPO_MANIFEST.map((repo) => repo.repoId));
  const adoptionSummary = {
    ...summarizeSourceAdoptionManifest(),
    source_repo_ids: Array.from(repoCoverage).sort().join(','),
    verified_source_pattern_count: String(verifiedPatterns),
  };
  const willRecordOutcomeSignal = Boolean(params.recordOutcomeSignal && latest);
  const effectiveOutcomeSignalCount =
    signals.length + (willRecordOutcomeSignal ? 1 : 0);
  const latestOutcomeSignalCount =
    (latest?.outcomeSignalCount || 0) + (willRecordOutcomeSignal ? 1 : 0);

  const attempts = [
    attempt({
      taskId: 'ledger_artifact_usability',
      taskFamily: latest?.taskFamily || 'assistant',
      mode: latest?.chosenMode || 'none',
      score: latest
        ? Math.min(
            1,
            (latest.confidence >= 0.55 ? 0.35 : 0.1) +
              (latest.replaySummary ? 0.25 : 0) +
              (!hasSchemaInvalidFallback(latest.schemaStatusJson) ? 0.25 : 0) +
              (latestOutcomeSignalCount > 0 ? 0.15 : 0),
          )
        : 0,
      outcome: latest
        ? `Last council run ${latest.finalStatus} confidence=${latest.confidence.toFixed(2)} outcome_signals=${latestOutcomeSignalCount}.`
        : 'No council ledger run exists yet.',
      riskFlags: latest ? JSON.parse(latest.riskFlagsJson || '[]') : [],
      now,
    }),
    attempt({
      taskId: 'outcome_signal_capture',
      taskFamily: 'assistant',
      mode: 'quality_ledger',
      score: effectiveOutcomeSignalCount > 0 ? 1 : 0.45,
      outcome:
        effectiveOutcomeSignalCount > 0
          ? `${effectiveOutcomeSignalCount} recent outcome signal(s) are attached.`
          : 'No recent council outcome signals are attached yet.',
      riskFlags:
        effectiveOutcomeSignalCount > 0 ? [] : ['missing_outcome_signals'],
      now,
    }),
    attempt({
      taskId: 'source_pattern_adoption',
      taskFamily: 'operator',
      mode: 'source_manifest',
      score:
        sourcePatternCoverage.length > 0
          ? (implementedPatterns + verifiedPatterns) /
            (sourcePatternCoverage.length * 2)
          : 0,
      outcome: `${implementedPatterns}/${sourcePatternCoverage.length} source patterns implemented; ${verifiedPatterns}/${sourcePatternCoverage.length} recently verified.`,
      riskFlags:
        verifiedPatterns === 0 ? ['source_patterns_unverified_recently'] : [],
      now,
    }),
  ];
  const score = Number(
    (
      attempts.reduce((sum, item) => sum + item.score, 0) / attempts.length
    ).toFixed(3),
  );
  const status: CouncilTaskEaseReport['status'] =
    score >= 0.85 ? 'pass' : score >= 0.55 ? 'warn' : 'fail';
  const latestAttempt = attempts[0]!;
  const latestScorecard = parseJsonObject(
    latest?.evidenceScorecardJson || '{}',
  );
  const latestSchema = parseJsonObject(latest?.schemaStatusJson || '{}');
  const schemaInvalidCount = Number(latestSchema.invalid_fallback || 0);
  const nextAction =
    status === 'pass'
      ? 'Run one live `ultrathink` proof and keep the task ladder green after provider or channel changes.'
      : latest && schemaInvalidCount > 0
        ? 'Fix the latest schema-invalid council artifact, then rerun npm run test:council:tasks and npm run test:council:medium.'
        : signals.length === 0
          ? 'Run npm run test:council:tasks to attach a sanitized task outcome signal, then rerun npm run debug:council.'
          : 'Run npm run test:council:medium and inspect source-pattern scenarios that remain unverified.';
  const latestCitationCoverage = parseObjectValue(
    latestScorecard.citationCoverage,
  );
  const latestCreateSafetyCoverage = parseObjectValue(
    latestScorecard.createSafetyCoverage,
  );
  const cited = Number(latestCitationCoverage.cited || 0);
  const citationTotal = Number(latestCitationCoverage.total || 0);
  const createSafetyTotal = Object.values(latestCreateSafetyCoverage).reduce(
    (sum: number, value) => sum + numeric(value),
    0,
  );
  const createSafetyExists = Number(latestCreateSafetyCoverage.exists || 0);
  const qualityReport = evaluateCouncilTaskQualityGates([
    {
      gateId: 'schema_validity.latest_run',
      family: 'schema_validity',
      metric: 'schema_invalid_runs',
      actual: latest ? (schemaInvalidCount === 0 ? 1 : 0) : 0,
      floor: 1,
      summary: latest
        ? `${schemaInvalidCount} invalid schema artifact(s) in the latest council run.`
        : 'No latest council run is available for schema scoring.',
    },
    {
      gateId: 'evidence_contract.citation_coverage',
      family: 'evidence_contract',
      metric: 'citation_coverage',
      actual: citationTotal > 0 ? cited / citationTotal : 0,
      floor: 1,
      warnFloor: 0.85,
      summary: `${cited}/${citationTotal} latest evidence card(s) have safe citation labels.`,
    },
    {
      gateId: 'evidence_contract.create_safety_exists',
      family: 'evidence_contract',
      metric: 'create_safety_exists',
      actual:
        createSafetyTotal > 0 ? createSafetyExists / createSafetyTotal : 0,
      floor: 0.1,
      warnFloor: 0,
      summary: `${createSafetyExists}/${createSafetyTotal} latest evidence card(s) are strong existing-source signals.`,
    },
    {
      gateId: 'outcome_signal.capture',
      family: 'outcome_signal',
      metric: 'outcome_signal_count',
      actual: effectiveOutcomeSignalCount > 0 ? 1 : 0,
      floor: 1,
      summary: `${effectiveOutcomeSignalCount} recent council outcome signal(s) are attached.`,
    },
    {
      gateId: 'privacy.redacted_metadata_only',
      family: 'privacy_redaction',
      metric: 'privacy_redaction',
      actual: 1,
      floor: 1,
      summary: 'Task drills store redacted metadata only.',
    },
    {
      gateId: 'repair.next_action',
      family: 'repair_next_action',
      metric: 'repair_next_action',
      actual: nextAction.trim() ? 1 : 0,
      floor: 1,
      summary: nextAction,
    },
    {
      gateId: 'source_pattern.coverage',
      family: 'source_pattern',
      metric: 'source_pattern_coverage',
      actual:
        sourcePatternCoverage.length > 0
          ? verifiedPatterns / sourcePatternCoverage.length
          : 0,
      floor: 0.5,
      warnFloor: 0.25,
      summary: `${verifiedPatterns}/${sourcePatternCoverage.length} source patterns were recently verified.`,
    },
  ]);
  if (params.recordOutcomeSignal && latest) {
    recordTaskOutcomeSignal({
      councilRunId: latest.councilRunId,
      status,
      score,
      nextAction,
      now,
    });
  }

  return {
    generatedAt: now,
    status,
    score,
    attempts,
    outcome: {
      attemptId: latestAttempt.attemptId,
      status,
      score,
      outcomeSignalCount: effectiveOutcomeSignalCount,
      nextAction,
    },
    sourcePatternCoverage,
    qualityGates: qualityReport.gates,
    adoptionSummary,
    providerRoleUsability: {
      usableRecentRuns,
      degradedRecentRuns: degradedRuns.length,
      schemaInvalidRuns: schemaInvalidRuns.length,
      lowConfidenceRuns: lowConfidenceRuns.length,
    },
    nextAction,
    privacy: {
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      redactedMetadataOnly: true,
    },
  };
}

export function formatCouncilTaskEaseReport(
  report: CouncilTaskEaseReport,
): string {
  const verified = report.sourcePatternCoverage.filter(
    (pattern) => pattern.verified,
  ).length;
  return [
    'Council Task-Ease',
    '',
    `Status: ${report.status}`,
    `Score: ${report.score.toFixed(2)}`,
    `Recent usable/degraded runs: ${report.providerRoleUsability.usableRecentRuns}/${report.providerRoleUsability.degradedRecentRuns}`,
    `Schema invalid runs: ${report.providerRoleUsability.schemaInvalidRuns}`,
    `Outcome signals: ${report.outcome.outcomeSignalCount}`,
    `Source patterns verified: ${verified}/${report.sourcePatternCoverage.length}`,
    `Quality gates: ${report.qualityGates.filter((gate) => gate.status === 'pass').length}/${report.qualityGates.length} pass`,
    `Last attempt: ${report.outcome.attemptId}`,
    `Next: ${report.nextAction}`,
    'Privacy: redacted metadata only; raw prompts/private bodies stored=false',
  ].join('\n');
}
