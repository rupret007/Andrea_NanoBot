import { listAgentRuntimeSkillManifests } from './db.js';
import { makeRuntimeSkillManifest } from './agent-runtime-glue.js';
import {
  exportRedactedOnboardingProfilePack,
  type OnboardingProfilePack,
} from './onboarding-profile-pack.js';
import {
  buildPersonalContextGraph,
  type PersonalContextGraphReport,
} from './personal-context-graph.js';
import { buildCouncilDoctorReport } from './council-quality.js';
import type {
  AgentRuntimeSkillManifest,
  CouncilDoctorReport,
} from './types.js';

export type AndreaSkillSafetyClass =
  | 'read_only'
  | 'approval_gated_write'
  | 'external_manual'
  | 'blocked_until_configured';

export interface AndreaSkillManifestInput {
  generatedAt: string;
  skillId: string;
  summary: string;
  permissions: string[];
  safetyClass: AndreaSkillSafetyClass;
  setupChecklist: string[];
  trigger?: Record<string, unknown>;
  toolRefs?: string[];
  approvalRules?: string[];
  evidenceNeeds?: string[];
}

export interface CouncilGovernedDeepWorkBlueprint {
  generatedAt: string;
  mode: 'council_governed_deep_work';
  stages: Array<{
    stageId:
      | 'plan'
      | 'approval'
      | 'resume'
      | 'verify'
      | 'record_outcome'
      | 'learn_safe_lessons';
    actor: 'provider_council' | 'local_executive' | 'user' | 'outcome_reviewer';
    purpose: string;
    mutationAllowed: boolean;
    requiredGate: string;
  }>;
  safetyInvariants: string[];
}

export interface AgiLeapReadinessReport {
  generatedAt: string;
  groupFolder: string;
  setupCompletenessScore: number;
  memoryQualityScore: number;
  contextGraphScore: number;
  textReviewScore: number;
  skillSystemScore: number;
  councilHealthScore: number;
  durableAutonomyScore: number;
  overallScore: number;
  profilePack: OnboardingProfilePack;
  contextGraph: PersonalContextGraphReport;
  installedSkillManifests: number;
  deepWorkBlueprint: CouncilGovernedDeepWorkBlueprint;
  topNextImprovement: string;
  privacy: {
    metadataOnly: true;
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    automaticSendsEnabled: false;
    calendarWritesEnabled: false;
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Number(clamp01(value).toFixed(3));
}

export function makeAndreaSkillManifest(
  input: AndreaSkillManifestInput,
): AgentRuntimeSkillManifest {
  return makeRuntimeSkillManifest({
    generatedAt: input.generatedAt,
    skillId: input.skillId,
    sourceKind: 'project',
    frontmatter: {
      permissions: input.permissions,
      safetyClass: input.safetyClass,
      setupChecklist: input.setupChecklist,
      marketplaceReady: input.setupChecklist.length === 0,
    },
    trigger: input.trigger || {},
    toolRefs: input.toolRefs || [],
    approvalRules: [
      ...(input.approvalRules || []),
      input.safetyClass === 'approval_gated_write'
        ? 'Require explicit user approval before mutation.'
        : 'No mutation without a separate approved action.',
    ],
    evidenceNeeds: [
      ...(input.evidenceNeeds || []),
      'Tool reliability and privacy class must be visible before execution.',
    ],
    summary: input.summary,
  });
}

export function buildCouncilGovernedDeepWorkBlueprint(
  params: {
    generatedAt?: string;
  } = {},
): CouncilGovernedDeepWorkBlueprint {
  const generatedAt = params.generatedAt || new Date().toISOString();
  return {
    generatedAt,
    mode: 'council_governed_deep_work',
    stages: [
      {
        stageId: 'plan',
        actor: 'provider_council',
        purpose: 'Propose a plan, risks, evidence gaps, and confidence math.',
        mutationAllowed: false,
        requiredGate: 'redacted council replay available',
      },
      {
        stageId: 'approval',
        actor: 'user',
        purpose: 'Approve, edit, or reject any high-risk or mutating step.',
        mutationAllowed: false,
        requiredGate:
          'explicit approval for sends, writes, repairs, commits, or restarts',
      },
      {
        stageId: 'resume',
        actor: 'local_executive',
        purpose:
          'Resume the durable episode from saved metadata, not hidden reasoning.',
        mutationAllowed: false,
        requiredGate: 'fresh preflight and tool-truth check',
      },
      {
        stageId: 'verify',
        actor: 'local_executive',
        purpose:
          'Verify result against evidence and current integration truth.',
        mutationAllowed: false,
        requiredGate: 'post-action observation or explicit external blocker',
      },
      {
        stageId: 'record_outcome',
        actor: 'outcome_reviewer',
        purpose:
          'Record what changed, what was blocked, and user-visible next step.',
        mutationAllowed: false,
        requiredGate: 'privacy-safe outcome record',
      },
      {
        stageId: 'learn_safe_lessons',
        actor: 'local_executive',
        purpose:
          'Suggest memory or skill updates without silently accepting sensitive facts.',
        mutationAllowed: false,
        requiredGate: 'suggest-then-confirm memory policy',
      },
    ],
    safetyInvariants: [
      'No automatic message sends.',
      'No automatic calendar writes.',
      'No credential changes.',
      'No live proof fakery.',
      'High-risk actions require explicit approval and fresh preflight.',
      'Sensitive personal facts stay proposed until the user accepts them.',
    ],
  };
}

function scoreSetup(pack: OnboardingProfilePack): number {
  return round3(
    (pack.setupCompleteness.hasActiveProfile ? 0.35 : 0) +
      Math.min(pack.setupCompleteness.answeredSetupAreas.length, 7) * 0.07 +
      Math.min(pack.setupCompleteness.lifeThreads, 2) * 0.08,
  );
}

function scoreMemory(pack: OnboardingProfilePack): number {
  const accepted = pack.memoryQuality.acceptedFacts;
  if (accepted === 0) return 0;
  return round3(
    Math.min(accepted, 8) * 0.06 +
      Math.min(pack.memoryQuality.factsWithConfidence / accepted, 1) * 0.18 +
      Math.min(pack.memoryQuality.factsWithFreshness / accepted, 1) * 0.18 +
      Math.min(pack.memoryQuality.factsWithSource / accepted, 1) * 0.18,
  );
}

function scoreSkills(manifestCount: number): number {
  return round3(
    manifestCount > 0 ? 0.65 + Math.min(manifestCount, 8) * 0.035 : 0.28,
  );
}

export function scoreCouncilHealth(report: CouncilDoctorReport): number {
  const totalRuns = report.recent.liveRuns;
  const blockedRuns = report.recent.blockedRuns ?? 0;
  const clarifiedRuns = report.recent.clarifiedRuns ?? 0;
  const answerableRuns =
    report.recent.answerableRuns ??
    Math.max(0, totalRuns - blockedRuns - clarifiedRuns);
  const outcomeScore =
    totalRuns > 0
      ? clamp01(
          (answerableRuns + clarifiedRuns * 0.75 + blockedRuns * 0.25) /
            totalRuns,
        )
      : 0;
  const schemaScore =
    totalRuns > 0
      ? clamp01(1 - report.recent.schemaInvalidRuns / totalRuns)
      : 0;
  const coreProviders = new Set([
    'openai_cloud',
    'anthropic_cloud',
    'gemini_cloud',
    'minimax_cloud',
    'brave_search',
  ]);
  const currentProviders = (report.currentProviderHealth || []).filter(
    (provider) => coreProviders.has(provider.providerId),
  );
  const providerScore =
    currentProviders.length > 0
      ? currentProviders.filter((provider) => provider.state === 'healthy')
          .length / coreProviders.size
      : 0.4;
  const participationScore =
    report.providerParticipation?.status === 'full'
      ? 1
      : report.providerParticipation?.status === 'degraded'
        ? 0.7
        : report.providerParticipation?.status === 'minimal'
          ? 0.35
          : 0.25;
  const evidenceScore = clamp01(1 - report.evidenceGaps.length * 0.15);
  const taskEaseScore = report.taskEase?.score ?? 0.5;
  const liveSampleScore = clamp01(totalRuns / 5);
  const outcomeLedQuality = report.recent.qualityScore;
  return round3(
    (outcomeLedQuality !== undefined
      ? outcomeLedQuality * 0.4
      : outcomeScore * 0.25 + report.recent.averageConfidence * 0.15) +
      schemaScore * 0.1 +
      providerScore * 0.15 +
      participationScore * 0.1 +
      evidenceScore * 0.1 +
      taskEaseScore * 0.1 +
      liveSampleScore * 0.05,
  );
}

function scoreTextReview(
  contextGraphScore: number,
  report: PersonalContextGraphReport,
): number {
  const communicationCoverage =
    report.coverage.communicationThreads > 0
      ? Math.min(
          report.coverage.linkedCommunicationThreads /
            report.coverage.communicationThreads,
          1,
        )
      : 0;
  return round3(
    Math.min(report.coverage.communicationThreads, 4) * 0.12 +
      communicationCoverage * 0.32 +
      contextGraphScore * 0.2,
  );
}

function scoreDurableAutonomy(report: PersonalContextGraphReport): number {
  const followthroughNodes = report.nodes.filter(
    (node) => node.nodeKind === 'followthrough_candidate',
  );
  const hasVerifiedFollowthrough = followthroughNodes.some(
    (node) =>
      node.refs?.hasReminder === true || node.refs?.outcomeKind === 'approved',
  );
  const hasRecordedOutcome =
    followthroughNodes.some(
      (node) =>
        typeof node.refs?.outcomeKind === 'string' &&
        node.refs.outcomeKind !== 'proposed',
    ) ||
    report.rankedInsights.some((insight) =>
      insight.riskFlags.some((flag) => /^followthrough_/.test(flag)),
    );
  const hasApprovalGate = report.rankedInsights.some((insight) =>
    /approval|confirm|review before|do not|no automatic/i.test(
      `${insight.nextAction} ${insight.reason} ${insight.riskFlags.join(' ')}`,
    ),
  );

  return round3(
    (report.coverage.activeProfile ? 0.16 : 0) +
      report.readinessScore * 0.14 +
      0.18 +
      (hasVerifiedFollowthrough
        ? 0.18
        : report.coverage.followthroughCandidates > 0
          ? 0.08
          : 0) +
      (hasRecordedOutcome ? 0.07 : 0) +
      (report.coverage.reminders > 0 ? 0.07 : 0) +
      (hasApprovalGate ? 0.06 : 0),
  );
}

export function buildAgiLeapReadinessReport(params: {
  groupFolder: string;
  now?: Date;
}): AgiLeapReadinessReport {
  const now = params.now || new Date();
  const generatedAt = now.toISOString();
  const profilePack = exportRedactedOnboardingProfilePack({
    groupFolder: params.groupFolder,
    now,
  });
  const contextGraph = buildPersonalContextGraph({
    groupFolder: params.groupFolder,
    now,
  });
  const installedSkillManifests = listAgentRuntimeSkillManifests({
    limit: 100,
  }).length;
  const setupCompletenessScore = scoreSetup(profilePack);
  const memoryQualityScore = scoreMemory(profilePack);
  const contextGraphScore = contextGraph.readinessScore;
  const textReviewScore = scoreTextReview(contextGraphScore, contextGraph);
  const skillSystemScore = scoreSkills(installedSkillManifests);
  const councilReport = buildCouncilDoctorReport(generatedAt);
  const councilHealthScore = scoreCouncilHealth(councilReport);
  const durableAutonomyScore = scoreDurableAutonomy(contextGraph);
  const overallScore = round3(
    setupCompletenessScore * 0.2 +
      memoryQualityScore * 0.2 +
      contextGraphScore * 0.18 +
      textReviewScore * 0.12 +
      skillSystemScore * 0.12 +
      councilHealthScore * 0.08 +
      durableAutonomyScore * 0.1,
  );
  const topNextImprovement =
    contextGraph.topGaps[0] ||
    (memoryQualityScore < 0.7
      ? 'Run the daily learning review and accept or reject proposed memory updates.'
      : councilHealthScore < 0.85
        ? councilReport.nextAction
        : 'Promote the strongest repeated assistant workflow into a tested skill manifest.');

  return {
    generatedAt,
    groupFolder: params.groupFolder,
    setupCompletenessScore,
    memoryQualityScore,
    contextGraphScore,
    textReviewScore,
    skillSystemScore,
    councilHealthScore,
    durableAutonomyScore,
    overallScore,
    profilePack,
    contextGraph,
    installedSkillManifests,
    deepWorkBlueprint: buildCouncilGovernedDeepWorkBlueprint({ generatedAt }),
    topNextImprovement,
    privacy: {
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      automaticSendsEnabled: false,
      calendarWritesEnabled: false,
    },
  };
}

export function formatAgiLeapReadinessReport(
  report: AgiLeapReadinessReport,
): string {
  return [
    `AGI daily-agent readiness: ${Math.round(report.overallScore * 100)}%`,
    `Setup ${Math.round(report.setupCompletenessScore * 100)}%, memory ${Math.round(
      report.memoryQualityScore * 100,
    )}%, context graph ${Math.round(report.contextGraphScore * 100)}%, skills ${Math.round(
      report.skillSystemScore * 100,
    )}%, texts ${Math.round(report.textReviewScore * 100)}%, council ${Math.round(
      report.councilHealthScore * 100,
    )}%.`,
    `Top next improvement: ${report.topNextImprovement}`,
  ].join('\n');
}
