import {
  buildAutonomousImprovementLabReport,
  type AutonomousImprovementLabReport,
} from './autonomous-improvement-lab.js';
import {
  buildCognitiveDoctorReport,
  type CognitiveDoctorReport,
} from './cognitive-kernel.js';
import {
  buildCouncilDoctorReport,
  buildCouncilReplayReport,
  type CouncilReplayReport,
} from './council-quality.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
} from './integration-doctor.js';
import {
  buildCurrentIntelligenceProgressReport,
  formatIntelligenceProgressReport,
  type IntelligenceProgressReport,
} from './intelligence-progress.js';
import { buildLiveProofGauntletReport } from './live-proof-gauntlet.js';
import {
  buildPilotReviewDigest,
  type PilotReviewDigest,
} from './pilot-mode.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type { CouncilDoctorReport, LiveProofGauntletReport } from './types.js';

export type AgiLabGateStatus = 'pass' | 'warn' | 'fail';
export type AgiLabReadinessDecision = 'advance' | 'hold' | 'block';

export interface AgiLabReadinessGate {
  gateId: string;
  label: string;
  status: AgiLabGateStatus;
  score: number;
  summary: string;
  nextAction: string;
}

export interface AgiLabReadinessReport {
  generatedAt: string;
  decision: AgiLabReadinessDecision;
  overallScore: number;
  gates: AgiLabReadinessGate[];
  topRisks: string[];
  nextExperiment: string;
  promotionPath: string[];
  sourceSummary: {
    integrationsHealthy: number;
    integrationsTotal: number;
    proofLive: number;
    proofDebt: number;
    pilotOpenIssues: number;
    intelligenceProgress: number;
    councilAverageConfidence: number;
    cognitiveAverageOutcome: number;
    improvementPatchPlans: number;
    improvementTopCandidates: number;
  };
  privacy: {
    metadataOnly: true;
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
    liveActionsExecuted: false;
  };
  sources: {
    integrationReport: IntegrationDoctorReport;
    proofReport: LiveProofGauntletReport;
    councilReport: CouncilDoctorReport;
    councilReplay: CouncilReplayReport;
    cognitiveReport: CognitiveDoctorReport;
    intelligenceProgress: IntelligenceProgressReport;
    improvementReport: AutonomousImprovementLabReport;
    pilotReview: PilotReviewDigest;
  };
}

export interface BuildAgiLabReadinessOptions {
  now?: Date;
  groupFolder?: string;
  fullRegression?: boolean;
  providers?: ProviderHealthSnapshot[];
  integrationReport?: IntegrationDoctorReport;
  proofReport?: LiveProofGauntletReport;
  councilReport?: CouncilDoctorReport;
  councilReplay?: CouncilReplayReport;
  cognitiveReport?: CognitiveDoctorReport;
  intelligenceProgress?: IntelligenceProgressReport;
  improvementReport?: AutonomousImprovementLabReport;
  pilotReview?: PilotReviewDigest;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Number(clamp01(value).toFixed(3));
}

function statusForScore(score: number, warnFloor = 0.75): AgiLabGateStatus {
  if (score >= 0.9) return 'pass';
  if (score >= warnFloor) return 'warn';
  return 'fail';
}

function proofGate(report: LiveProofGauntletReport): AgiLabReadinessGate {
  const total = report.liveProvenCount + report.proofDebtCount;
  const score = total > 0 ? report.liveProvenCount / total : 1;
  const repoWork = report.repoWorkRequiredCount;
  const status: AgiLabGateStatus =
    repoWork > 0 ? 'fail' : report.proofDebtCount > 0 ? 'warn' : 'pass';
  return {
    gateId: 'live_proof',
    label: 'Live proof truth',
    status,
    score: round3(score),
    summary: `${report.liveProvenCount}/${total || 0} proofs live; ${report.proofDebtCount} proof debt; ${repoWork} repo-work proof issue(s).`,
    nextAction:
      report.nextAction ||
      (status === 'pass'
        ? 'Keep proof freshness refreshed before demos.'
        : 'Close manual proof debt before promoting AGI-lab claims.'),
  };
}

function integrationGate(report: IntegrationDoctorReport): AgiLabReadinessGate {
  const score = report.summary.total
    ? report.summary.healthy / report.summary.total
    : 1;
  const status: AgiLabGateStatus =
    report.summary.actionNeeded > 0 ? 'warn' : statusForScore(score);
  const next =
    report.statuses.find((item) => item.state !== 'healthy')?.nextAction ||
    'No integration action needed.';
  return {
    gateId: 'integration_health',
    label: 'Integration health',
    status,
    score: round3(score),
    summary: `${report.summary.healthy}/${report.summary.total} integrations healthy; ${report.summary.actionNeeded} action-needed; ${report.summary.needsProof} needs-proof.`,
    nextAction: next,
  };
}

function regressionGate(
  report: IntelligenceProgressReport,
): AgiLabReadinessGate {
  const score = report.dimensionScores.regression_stability;
  const status: AgiLabGateStatus =
    report.criticalRegressions.length > 0 ? 'fail' : statusForScore(score);
  return {
    gateId: 'regression_stability',
    label: 'Regression stability',
    status,
    score,
    summary: `${Math.round(score * 100)}% regression stability; ${report.criticalRegressions.length} critical regression(s); decision=${report.promotionDecision}.`,
    nextAction:
      report.criticalRegressions[0] ||
      report.nonCriticalRegressions[0] ||
      report.topNextImprovement,
  };
}

function councilGate(report: CouncilDoctorReport): AgiLabReadinessGate {
  const confidenceScore = report.recent.averageConfidence;
  const lowConfidencePenalty = report.recent.totalRuns
    ? report.recent.lowConfidenceRuns / report.recent.totalRuns
    : 0;
  const degradedPenalty = report.recent.totalRuns
    ? report.recent.degradedRuns / report.recent.totalRuns
    : 0;
  const score = round3(
    confidenceScore * 0.55 +
      (1 - lowConfidencePenalty) * 0.25 +
      (1 - degradedPenalty) * 0.2,
  );
  const status: AgiLabGateStatus = report.ok
    ? 'pass'
    : statusForScore(score, 0.55);
  return {
    gateId: 'council_quality',
    label: 'Council quality',
    status,
    score,
    summary: `${report.recent.totalRuns} recent council run(s); ${report.recent.degradedRuns} degraded; avg confidence ${report.recent.averageConfidence.toFixed(2)}; low-confidence ${report.recent.lowConfidenceRuns}.`,
    nextAction: report.nextAction,
  };
}

function cognitionGate(report: CognitiveDoctorReport): AgiLabReadinessGate {
  const score = round3(
    report.recent.averageOutcomeScore * 0.55 +
      (report.recent.totalRuns > 0
        ? (1 - report.recent.blockedRuns / report.recent.totalRuns) * 0.25
        : 0.25) +
      (report.skills.total > 0
        ? (report.skills.promoted / report.skills.total) * 0.2
        : 0),
  );
  const status: AgiLabGateStatus = report.ok
    ? statusForScore(score, 0.55)
    : 'fail';
  return {
    gateId: 'cognitive_trajectory',
    label: 'Cognitive trajectory',
    status,
    score,
    summary: `${report.recent.totalRuns} recent cognitive run(s); average outcome ${report.recent.averageOutcomeScore.toFixed(2)}; ${report.skills.promoted} promoted skill(s); ${report.recent.approvalRuns} approval-waiting run(s).`,
    nextAction:
      report.activeRun?.nextAction ||
      report.checkpoints.latestNextAction ||
      'Run one verified cognitive trajectory and record outcome confirmation.',
  };
}

function pilotGate(report: PilotReviewDigest): AgiLabReadinessGate {
  const score = round3(
    1 -
      Math.min(0.7, report.openIssueCount * 0.18) -
      Math.min(0.25, report.currentActionableProblemEvents.length * 0.08),
  );
  const status: AgiLabGateStatus =
    report.openIssueCount === 0
      ? 'pass'
      : report.openIssueCount <= 2
        ? 'warn'
        : 'fail';
  return {
    gateId: 'pilot_feedback',
    label: 'Pilot feedback',
    status,
    score,
    summary: `${report.openIssueCount} open pilot issue(s); ${report.totalUsage24h} flagship use(s) in 24h; ${report.totalUsage7d} in 7d.`,
    nextAction:
      report.latestOpenIssue?.summaryText ||
      'Convert the next real feedback item into a regression scenario.',
  };
}

function improvementGate(
  report: AutonomousImprovementLabReport,
): AgiLabReadinessGate {
  const score = round3(
    Math.min(1, report.patchPlans.length / 3) * 0.45 +
      Math.min(1, report.topCandidates.length / 5) * 0.35 +
      (report.patchPlanPolicy.autoAppliesProductPatches ? 0 : 0.2),
  );
  return {
    gateId: 'improvement_pipeline',
    label: 'Improvement pipeline',
    status: statusForScore(score, 0.65),
    score,
    summary: `${report.hypotheses.length} hypotheses; ${report.experiments.length} experiments; ${report.patchPlans.length} candidate patch plan(s); auto-apply=${report.patchPlanPolicy.autoAppliesProductPatches}.`,
    nextAction: report.nextAction,
  };
}

function gateWeight(gate: AgiLabReadinessGate): number {
  switch (gate.gateId) {
    case 'regression_stability':
      return 0.2;
    case 'council_quality':
      return 0.18;
    case 'cognitive_trajectory':
      return 0.18;
    case 'live_proof':
      return 0.16;
    case 'pilot_feedback':
      return 0.12;
    case 'integration_health':
      return 0.08;
    case 'improvement_pipeline':
      return 0.08;
    default:
      return 0.1;
  }
}

function decide(gates: AgiLabReadinessGate[]): AgiLabReadinessDecision {
  if (gates.some((gate) => gate.status === 'fail')) return 'block';
  if (gates.some((gate) => gate.status === 'warn')) return 'hold';
  return 'advance';
}

function topRisks(gates: AgiLabReadinessGate[]): string[] {
  return gates
    .filter((gate) => gate.status !== 'pass')
    .sort((a, b) => a.score - b.score)
    .slice(0, 5)
    .map((gate) => `${gate.label}: ${gate.summary} Next: ${gate.nextAction}`);
}

function nextExperiment(params: {
  gates: AgiLabReadinessGate[];
  improvementReport: AutonomousImprovementLabReport;
  councilReport: CouncilDoctorReport;
}): string {
  const failing = params.gates
    .filter((gate) => gate.status !== 'pass')
    .sort((a, b) => a.score - b.score)[0];
  if (failing?.gateId === 'council_quality') {
    return 'Run a council-quality experiment: replay the latest low-confidence council route, add evidence-gap classification, and require confidence calibration before promotion.';
  }
  if (failing?.gateId === 'cognitive_trajectory') {
    return 'Run a trajectory experiment: pick one approval-waiting cognitive workflow, complete or expire it, then record outcome confirmation.';
  }
  const candidate = params.improvementReport.topCandidates.find(
    (item) => !item.externalBlocker,
  );
  return (
    candidate?.nextAction ||
    failing?.nextAction ||
    params.councilReport.nextAction ||
    'Promote the strongest repeated assistant workflow into a tested skill manifest.'
  );
}

export async function buildAgiLabReadinessReport(
  options: BuildAgiLabReadinessOptions = {},
): Promise<AgiLabReadinessReport> {
  const now = options.now || new Date();
  const generatedAt = now.toISOString();
  const groupFolder = options.groupFolder || 'main';
  const providers =
    options.providers || collectProviderHealthSnapshots(generatedAt);
  const integrationReport =
    options.integrationReport ||
    buildIntegrationDoctorReport({ now, providers });
  const proofReport =
    options.proofReport || buildLiveProofGauntletReport({ now });
  const councilReport =
    options.councilReport ||
    buildCouncilDoctorReport(generatedAt, { providerHealth: providers });
  const councilReplay =
    options.councilReplay || buildCouncilReplayReport(generatedAt);
  const cognitiveReport =
    options.cognitiveReport || buildCognitiveDoctorReport(generatedAt);
  const intelligenceProgress =
    options.intelligenceProgress ||
    (await buildCurrentIntelligenceProgressReport({
      groupFolder,
      now,
      fullRegression: Boolean(options.fullRegression),
    }));
  const improvementReport =
    options.improvementReport ||
    buildAutonomousImprovementLabReport({ now, persist: false });
  const pilotReview = options.pilotReview || buildPilotReviewDigest(now);

  const gates = [
    integrationGate(integrationReport),
    proofGate(proofReport),
    regressionGate(intelligenceProgress),
    councilGate(councilReport),
    cognitionGate(cognitiveReport),
    pilotGate(pilotReview),
    improvementGate(improvementReport),
  ];
  const weightSum = gates.reduce((sum, gate) => sum + gateWeight(gate), 0);
  const overallScore = round3(
    gates.reduce((sum, gate) => sum + gate.score * gateWeight(gate), 0) /
      (weightSum || 1),
  );
  const decision = decide(gates);
  return {
    generatedAt,
    decision,
    overallScore,
    gates,
    topRisks: topRisks(gates),
    nextExperiment: nextExperiment({
      gates,
      improvementReport,
      councilReport,
    }),
    promotionPath: [
      'Keep typecheck/test/build green before trusting any AGI-lab score.',
      'Require no critical regression in approval, blocker honesty, memory safety, or internal-leakage gates.',
      'Improve council quality before claiming a reasoning upgrade.',
      'Promote one repeated workflow only after it passes the expanded daily suite and proof-honesty checks.',
    ],
    sourceSummary: {
      integrationsHealthy: integrationReport.summary.healthy,
      integrationsTotal: integrationReport.summary.total,
      proofLive: proofReport.liveProvenCount,
      proofDebt: proofReport.proofDebtCount,
      pilotOpenIssues: pilotReview.openIssueCount,
      intelligenceProgress: intelligenceProgress.overallScore,
      councilAverageConfidence: councilReport.recent.averageConfidence,
      cognitiveAverageOutcome: cognitiveReport.recent.averageOutcomeScore,
      improvementPatchPlans: improvementReport.patchPlans.length,
      improvementTopCandidates: improvementReport.topCandidates.length,
    },
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
      liveActionsExecuted: false,
    },
    sources: {
      integrationReport,
      proofReport,
      councilReport,
      councilReplay,
      cognitiveReport,
      intelligenceProgress,
      improvementReport,
      pilotReview,
    },
  };
}

function percent(value: number): string {
  return `${Math.round(clamp01(value) * 100)}%`;
}

export function formatAgiLabReadinessReport(
  report: AgiLabReadinessReport,
): string {
  const gateLines = report.gates.map(
    (gate) =>
      `- ${gate.label}: ${gate.status} ${percent(gate.score)} :: ${gate.summary}`,
  );
  const riskLines =
    report.topRisks.length > 0
      ? report.topRisks.map((risk) => `- ${risk}`)
      : ['- none'];
  return [
    `AGI Lab Readiness: ${report.decision} (${percent(report.overallScore)})`,
    `Generated: ${report.generatedAt}`,
    '',
    'Gates',
    ...gateLines,
    '',
    'Top Risks',
    ...riskLines,
    '',
    `Next Experiment: ${report.nextExperiment}`,
    '',
    'Promotion Path',
    ...report.promotionPath.map((item) => `- ${item}`),
    '',
    'Intelligence Progress',
    formatIntelligenceProgressReport(report.sources.intelligenceProgress),
    '',
    `Council Replay: ${report.sources.councilReplay.latestRunId || 'none'} confidence=${
      typeof report.sources.councilReplay.confidence === 'number'
        ? report.sources.councilReplay.confidence.toFixed(2)
        : 'unknown'
    } evidence=${String(
      report.sources.councilReplay.evidenceScorecard.availableGrade ||
        'unknown',
    )}/${String(
      report.sources.councilReplay.evidenceScorecard.requiredGrade || 'unknown',
    )}`,
    `Privacy: metadata-only; raw prompts/private bodies/hidden reasoning stored=false; live actions executed=false`,
  ].join('\n');
}
