import { createHash, randomUUID } from 'node:crypto';

import { buildAgentOSReport } from './agent-os.js';
import { redactCouncilText } from './council-safety.js';
import {
  getAgentOSEpisode,
  listLogicBeliefStates,
  listLogicBeliefRevisions,
  listLogicClaims,
  listLogicClaimTransitions,
  listLogicContradictions,
  listLogicDecisions,
  listLogicEvidenceLinks,
  listLogicHypotheses,
  listLogicHypothesisSets,
  listLogicMissingPremises,
  listLogicResolutionDecisions,
  listLogicUsefulnessScores,
  upsertLogicBeliefState,
  upsertLogicBeliefRevision,
  upsertLogicClaim,
  upsertLogicClaimTransition,
  upsertLogicContradiction,
  upsertLogicDecision,
  upsertLogicEvidenceLink,
  upsertLogicHypothesis,
  upsertLogicHypothesisSet,
  upsertLogicMissingPremise,
  upsertLogicResolutionDecision,
  upsertLogicUsefulnessScore,
} from './db.js';
import type { CognitiveKernelResult } from './cognitive-kernel.js';
import type {
  AgentOSReport,
  LogicBeliefState,
  LogicBeliefRevision,
  LogicClaim,
  LogicClaimStatus,
  LogicClaimTransition,
  LogicContradiction,
  LogicDecision,
  LogicEvidenceFreshness,
  LogicEvidenceLink,
  LogicHypothesis,
  LogicHypothesisSet,
  LogicKernelReport,
  LogicMissingPremise,
  LogicReconciliationReport,
  LogicResolutionDecision,
  LogicUsefulnessScore,
} from './types.js';

export interface BeginLogicKernelInput {
  subject?: string | null;
  episodeId?: string | null;
  agentOSReport?: AgentOSReport | null;
  cognitiveRun?: CognitiveKernelResult | null;
  answerText?: string | null;
  generatedAt?: string;
}

export interface LogicKernelResult {
  report: LogicKernelReport;
  beliefState: LogicBeliefState;
  decision: LogicDecision;
}

export interface LogicReconciliationInput {
  subject?: string | null;
  episodeId?: string | null;
  generatedAt?: string;
  userControl?:
    | 'mark_current'
    | 'mark_stale'
    | 'resolve'
    | 'what_changed'
    | 'uncertainty_report'
    | null;
}

export interface LogicAnswerEvaluation {
  status: 'pass' | 'warn' | 'block';
  flags: string[];
  summary: string;
  suggestedRewrite?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(value ?? null);
    return redactCouncilText(
      json.length <= limit
        ? json
        : JSON.stringify({
            truncated: true,
            summary: json.slice(0, Math.max(0, limit - 80)),
          }),
      limit,
    );
  } catch {
    return 'null';
  }
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function privacyJson(): string {
  return safeJson({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  });
}

function privacyReport(): LogicKernelReport['privacy'] {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

function normalizeClaimText(input: {
  subject: string;
  predicate: string;
  objectSummary: string;
}): string {
  return [input.subject, input.predicate, input.objectSummary]
    .join(' | ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreFromSourceCoverage(report: AgentOSReport): {
  score: number;
  conflictCount: number;
  sourceIds: string[];
} {
  const coverage = parseJsonObject(report.latestEpisode?.sourceCoverageJson);
  const score =
    typeof coverage.score === 'number'
      ? clamp01(coverage.score)
      : typeof coverage.sourceIdCount === 'number'
        ? clamp01(coverage.sourceIdCount / 8)
        : report.episodeSteps.length > 0
          ? 0.58
          : 0.2;
  const conflictCount =
    typeof coverage.conflictCount === 'number' ? coverage.conflictCount : 0;
  const sourceIds = Array.isArray(coverage.sourceIds)
    ? coverage.sourceIds.map((sourceId) => String(sourceId)).slice(0, 40)
    : [];
  return { score, conflictCount, sourceIds };
}

function evidenceIdsForReport(report: AgentOSReport): string[] {
  const episodeEvidence = parseJsonArray(report.latestEpisode?.evidenceIdsJson);
  const memoryBlocks = parseJsonArray(report.latestEpisode?.memoryBlockIdsJson);
  const trajectory = parseJsonArray(
    report.latestEpisode?.trajectoryEvalIdsJson,
  );
  const stepEvidence = report.episodeSteps.flatMap((step) =>
    parseJsonArray(step.evidenceRefsJson),
  );
  return Array.from(
    new Set([
      ...(report.latestEpisode?.episodeId
        ? [report.latestEpisode.episodeId]
        : []),
      ...episodeEvidence,
      ...memoryBlocks,
      ...trajectory,
      ...stepEvidence,
    ]),
  ).slice(0, 80);
}

function reportFromCognitiveRun(
  cognitiveRun: CognitiveKernelResult,
  generatedAt: string,
): AgentOSReport {
  const evidenceIds = cognitiveRun.evidenceArtifacts
    .map((artifact) => artifact.artifactId)
    .slice(0, 40);
  return {
    generatedAt,
    ok: cognitiveRun.verification.status !== 'block',
    summary: `Logic Kernel synthesized Agent OS metadata from cognitive run ${cognitiveRun.run.runId}.`,
    latestEpisode: null,
    episodeSteps: [
      {
        stepId: `logic:synthetic-step:${cognitiveRun.run.runId}`,
        episodeId: `logic:synthetic-episode:${cognitiveRun.run.runId}`,
        runId: cognitiveRun.run.runId,
        createdAt: generatedAt,
        position: 1,
        stepKind: 'frame',
        actorRole: 'planner',
        status:
          cognitiveRun.verification.status === 'block'
            ? 'blocked'
            : 'completed',
        summary: cognitiveRun.run.goalSummary,
        evidenceRefsJson: safeJson(
          [cognitiveRun.run.runId, ...evidenceIds],
          2400,
        ),
        governanceDecisionIdsJson: safeJson(
          cognitiveRun.governanceDecisions.map(
            (decision) => decision.decisionId,
          ),
          2400,
        ),
        nextAction: cognitiveRun.run.nextAction,
        privacyJson: privacyJson(),
      },
    ],
    interrupts: [],
    resumeTokens: [],
    toolCards: [],
    handoffs: [],
    trajectoryEvals: [],
    skillProposals: [],
    capabilityDiscovery: {
      generatedAt,
      toolCards: [],
      healthy: 0,
      degraded: 0,
      blocked: 0,
      approvalStaged: cognitiveRun.approvalPackets.length,
      readOnly: cognitiveRun.executionSteps.filter(
        (step) => step.toolId && step.status === 'executed',
      ).length,
      sourceCoverage: evidenceIds,
      nextAction: cognitiveRun.run.nextAction,
      privacy: privacyReport(),
    },
    nextAction: cognitiveRun.run.nextAction,
    privacy: privacyReport(),
  };
}

function evidenceKind(evidenceId: string): LogicEvidenceLink['evidenceKind'] {
  if (evidenceId.startsWith('agentos:episode:')) return 'agent_os_episode';
  if (evidenceId.startsWith('cogmem:')) return 'memory_block';
  if (evidenceId.startsWith('cogartifact:')) return 'manual_metadata';
  if (evidenceId.startsWith('agentos:eval:')) return 'trajectory_eval';
  if (evidenceId.startsWith('agentos:tool:')) return 'tool_card';
  if (evidenceId.startsWith('provider:')) return 'provider_health';
  if (evidenceId.startsWith('integrations:')) return 'integration_status';
  if (evidenceId.startsWith('cog:')) return 'cognitive_run';
  return 'manual_metadata';
}

function makeClaim(input: {
  subject: string;
  predicate: string;
  objectSummary: string;
  claimKind: LogicClaim['claimKind'];
  confidence: number;
  probability?: number;
  evidenceIds: string[];
  sourceEpisodeId?: string | null;
  sourceRunId?: string | null;
  requiresConfirmation?: boolean;
  sensitivity?: LogicClaim['sensitivity'];
  now: string;
}): LogicClaim {
  const normalizedText = normalizeClaimText(input);
  const evidenceIds = Array.from(new Set(input.evidenceIds)).slice(0, 40);
  return {
    claimId: hashId('logic:claim', normalizedText),
    createdAt: input.now,
    updatedAt: input.now,
    subject: redactCouncilText(input.subject, 320),
    predicate: redactCouncilText(input.predicate, 120),
    objectSummary: redactCouncilText(input.objectSummary, 640),
    normalizedText,
    claimKind: input.claimKind,
    confidence: clamp01(input.confidence),
    probability: clamp01(input.probability ?? input.confidence),
    sensitivity: input.sensitivity || 'normal',
    status: input.requiresConfirmation ? 'needs_confirmation' : 'active',
    sourceEpisodeId: input.sourceEpisodeId || null,
    sourceRunId: input.sourceRunId || null,
    evidenceIdsJson: safeJson(evidenceIds, 2400),
    contradictionIdsJson: safeJson([], 1200),
    supersedesClaimId: null,
    requiresConfirmation: input.requiresConfirmation === true,
    privacyJson: privacyJson(),
  };
}

function makeEvidenceLinks(claim: LogicClaim): LogicEvidenceLink[] {
  return parseJsonArray(claim.evidenceIdsJson).map((evidenceId) => ({
    linkId: hashId('logic:evidence', `${claim.claimId}|${evidenceId}`),
    claimId: claim.claimId,
    evidenceId,
    evidenceKind: evidenceKind(evidenceId),
    sourceId: evidenceId,
    support: 'supports',
    strength: claim.confidence,
    freshness: 'fresh',
    sensitivity: claim.sensitivity,
    summary: `Evidence ${evidenceId} supports the claim "${claim.predicate}".`,
    privacyJson: privacyJson(),
  }));
}

function makeContradiction(input: {
  subject: string;
  claimIdA: string;
  claimIdB?: string | null;
  severity: LogicContradiction['severity'];
  summary: string;
  nextAction: string;
  now: string;
}): LogicContradiction {
  return {
    contradictionId: hashId(
      'logic:contradiction',
      `${input.subject}|${input.claimIdA}|${input.claimIdB || ''}|${input.summary}`,
    ),
    subject: redactCouncilText(input.subject, 320),
    claimIdA: input.claimIdA,
    claimIdB: input.claimIdB || null,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'open',
    severity: input.severity,
    summary: redactCouncilText(input.summary, 640),
    nextAction: redactCouncilText(input.nextAction, 640),
    privacyJson: privacyJson(),
  };
}

function claimsFromReport(input: {
  subject: string;
  report: AgentOSReport;
  cognitiveRun?: CognitiveKernelResult | null;
  now: string;
}): LogicClaim[] {
  const report = input.report;
  const episode = report.latestEpisode || null;
  const evidenceIds = evidenceIdsForReport(report);
  const coverage = scoreFromSourceCoverage(report);
  const trajectory = report.trajectoryEvals[0] || null;
  const openInterrupts = report.interrupts.filter(
    (interrupt) => interrupt.status === 'open',
  );
  const approvalStaged = report.capabilityDiscovery.approvalStaged;
  const blockedTools = report.capabilityDiscovery.blocked;
  const claims: LogicClaim[] = [];

  if (episode) {
    claims.push(
      makeClaim({
        subject: input.subject,
        predicate: 'episode_status',
        objectSummary: `Agent OS episode ${episode.episodeId} is ${episode.status}.`,
        claimKind: 'episode_state',
        confidence: episode.status === 'completed' ? 0.9 : 0.72,
        evidenceIds: [episode.episodeId, ...evidenceIds],
        sourceEpisodeId: episode.episodeId,
        sourceRunId: episode.activeRunId || episode.rootRunId || null,
        now: input.now,
      }),
    );
  }

  claims.push(
    makeClaim({
      subject: input.subject,
      predicate: 'source_coverage',
      objectSummary:
        coverage.score >= 0.75
          ? 'Current evidence coverage is strong enough to answer with cited caveats.'
          : coverage.score >= 0.5
            ? 'Current evidence coverage is partial and should be caveated.'
            : 'Current evidence coverage is weak and needs more evidence or clarification.',
      claimKind: 'memory_fact',
      confidence: coverage.score,
      probability: coverage.score,
      evidenceIds: evidenceIds.length
        ? evidenceIds
        : ['source_coverage:missing'],
      sourceEpisodeId: episode?.episodeId || null,
      sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
      now: input.now,
    }),
  );

  claims.push(
    makeClaim({
      subject: input.subject,
      predicate: 'approval_policy',
      objectSummary:
        approvalStaged > 0
          ? 'Mutating or side-effect-adjacent actions are staged for explicit approval.'
          : 'No approval-staged tool cards were discovered in the latest Agent OS report.',
      claimKind: 'safety_policy',
      confidence: approvalStaged > 0 ? 0.98 : 0.64,
      evidenceIds: [
        ...(episode?.episodeId ? [episode.episodeId] : []),
        ...report.toolCards
          .filter((card) => card.policyClass === 'approval_staged')
          .map((card) => card.toolCardId)
          .slice(0, 12),
      ],
      sourceEpisodeId: episode?.episodeId || null,
      sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
      now: input.now,
    }),
  );

  if (openInterrupts.length > 0) {
    claims.push(
      makeClaim({
        subject: input.subject,
        predicate: 'open_interrupt',
        objectSummary: `There are ${openInterrupts.length} open interrupt(s), so Andrea should name the blocker before acting.`,
        claimKind: 'episode_state',
        confidence: 0.86,
        evidenceIds: openInterrupts.map((interrupt) => interrupt.interruptId),
        sourceEpisodeId: episode?.episodeId || null,
        sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
        now: input.now,
      }),
    );
  }

  if (blockedTools > 0) {
    claims.push(
      makeClaim({
        subject: input.subject,
        predicate: 'tool_availability',
        objectSummary: `${blockedTools} Agent OS tool card(s) are blocked and should be excluded from optional routes.`,
        claimKind: 'tool_health',
        confidence: 0.84,
        evidenceIds: report.toolCards
          .filter((card) => card.healthState === 'blocked')
          .map((card) => card.toolCardId),
        sourceEpisodeId: episode?.episodeId || null,
        sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
        now: input.now,
      }),
    );
  }

  if (trajectory) {
    claims.push(
      makeClaim({
        subject: input.subject,
        predicate: 'trajectory_quality',
        objectSummary: `Latest Agent OS trajectory status is ${trajectory.status} with score ${trajectory.overallScore}.`,
        claimKind: 'episode_state',
        confidence: trajectory.overallScore,
        evidenceIds: [trajectory.evalId],
        sourceEpisodeId: episode?.episodeId || null,
        sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
        now: input.now,
      }),
    );
  }

  claims.push(
    makeClaim({
      subject: input.subject,
      predicate: 'best_next_action',
      objectSummary:
        report.nextAction || 'No next action is currently recorded.',
      claimKind: 'next_action',
      confidence: report.nextAction ? 0.8 : 0.45,
      evidenceIds: episode?.episodeId
        ? [episode.episodeId]
        : ['agent_os:no_episode'],
      sourceEpisodeId: episode?.episodeId || null,
      sourceRunId: episode?.activeRunId || episode?.rootRunId || null,
      now: input.now,
    }),
  );

  if (input.cognitiveRun) {
    claims.push(
      makeClaim({
        subject: input.subject,
        predicate: 'cognitive_run_status',
        objectSummary: `Cognitive run ${input.cognitiveRun.run.runId} is ${input.cognitiveRun.run.status}.`,
        claimKind: 'episode_state',
        confidence:
          input.cognitiveRun.verification.status === 'pass' ? 0.86 : 0.66,
        evidenceIds: [input.cognitiveRun.run.runId],
        sourceRunId: input.cognitiveRun.run.runId,
        now: input.now,
      }),
    );
  }

  return claims;
}

function contradictionPairs(claims: LogicClaim[]): LogicContradiction[] {
  const contradictions: LogicContradiction[] = [];
  const byPredicate = new Map<string, LogicClaim[]>();
  for (const claim of claims) {
    const key = `${claim.subject}|${claim.predicate}`;
    byPredicate.set(key, [...(byPredicate.get(key) || []), claim]);
  }
  for (const group of byPredicate.values()) {
    if (group.length < 2) continue;
    const objectSet = new Set(group.map((claim) => claim.objectSummary));
    if (objectSet.size < 2) continue;
    const [a, b] = group;
    contradictions.push(
      makeContradiction({
        subject: a.subject,
        claimIdA: a.claimId,
        claimIdB: b.claimId,
        severity: 'medium',
        summary: `Multiple active claims disagree about ${a.predicate}.`,
        nextAction:
          'Keep both candidate beliefs visible, lower confidence, and ask for or gather stronger evidence before acting.',
        now: a.updatedAt,
      }),
    );
  }
  return contradictions;
}

function missingPremisesFor(input: {
  subject: string;
  report: AgentOSReport;
  claims: LogicClaim[];
  contradictions: LogicContradiction[];
  coverageScore: number;
  conflictCount: number;
  now: string;
}): LogicMissingPremise[] {
  const episodeId = input.report.latestEpisode?.episodeId || null;
  const premises: LogicMissingPremise[] = [];
  const openInterrupt = input.report.interrupts.find(
    (interrupt) => interrupt.status === 'open',
  );
  if (!input.report.latestEpisode) {
    premises.push({
      premiseId: hashId('logic:premise', `${input.subject}|no_episode`),
      subject: input.subject,
      episodeId,
      createdAt: input.now,
      updatedAt: input.now,
      status: 'open',
      question:
        'No Agent OS episode is available yet. Run a task drill or a real task turn first.',
      blockerClass: 'missing_episode',
      requiredEvidenceJson: safeJson(['agent_os_episode']),
      nextAction: 'Run npm run debug:agent-os -- --task-drill --json.',
      privacyJson: privacyJson(),
    });
  }
  if (input.coverageScore < 0.55) {
    premises.push({
      premiseId: hashId(
        'logic:premise',
        `${input.subject}|weak_source_coverage`,
      ),
      subject: input.subject,
      episodeId,
      createdAt: input.now,
      updatedAt: input.now,
      status: 'open',
      question:
        'Which evidence source should Andrea trust before answering this with confidence?',
      blockerClass: 'weak_source_coverage',
      requiredEvidenceJson: safeJson([
        'source_coverage>=0.55',
        'fresh_evidence_id',
      ]),
      nextAction:
        'Gather one more read-only evidence source or ask a clarifying question.',
      privacyJson: privacyJson(),
    });
  }
  if (input.contradictions.length > 0 || input.conflictCount > 0) {
    premises.push({
      premiseId: hashId('logic:premise', `${input.subject}|contradiction`),
      subject: input.subject,
      episodeId,
      createdAt: input.now,
      updatedAt: input.now,
      status: 'open',
      question: 'Which conflicting belief should Andrea treat as current?',
      blockerClass: 'belief_conflict',
      requiredEvidenceJson: safeJson([
        'newer_source_id',
        'conflict_resolution',
      ]),
      nextAction:
        'Surface the conflict, keep alternatives visible, and avoid presenting certainty.',
      privacyJson: privacyJson(),
    });
  }
  if (openInterrupt) {
    premises.push({
      premiseId: hashId(
        'logic:premise',
        `${input.subject}|${openInterrupt.interruptId}`,
      ),
      subject: input.subject,
      episodeId,
      createdAt: input.now,
      updatedAt: input.now,
      status: 'open',
      question: openInterrupt.nextAction,
      blockerClass: openInterrupt.interruptKind,
      requiredEvidenceJson: safeJson([openInterrupt.interruptId]),
      nextAction: openInterrupt.nextAction,
      privacyJson: privacyJson(),
    });
  }
  return premises;
}

function actionScore(input: {
  actionId: string;
  subject: string;
  episodeId?: string | null;
  actionLabel: string;
  actionKind: LogicUsefulnessScore['actionKind'];
  expectedUsefulness: number;
  effort: number;
  reversibility: number;
  risk: number;
  urgency: number;
  userPreferenceFit: number;
  evidenceSufficiency: number;
  approvalRequired?: boolean;
  evidenceIds: string[];
  nextAction: string;
  now: string;
}): LogicUsefulnessScore {
  const totalScore = clamp01(
    input.expectedUsefulness * 0.3 +
      input.reversibility * 0.15 +
      input.urgency * 0.12 +
      input.userPreferenceFit * 0.13 +
      input.evidenceSufficiency * 0.22 +
      (1 - input.effort) * 0.04 +
      (1 - input.risk) * 0.04,
  );
  return {
    actionId: input.actionId,
    subject: input.subject,
    episodeId: input.episodeId || null,
    createdAt: input.now,
    actionLabel: redactCouncilText(input.actionLabel, 640),
    actionKind: input.actionKind,
    expectedUsefulness: clamp01(input.expectedUsefulness),
    effort: clamp01(input.effort),
    reversibility: clamp01(input.reversibility),
    risk: clamp01(input.risk),
    urgency: clamp01(input.urgency),
    userPreferenceFit: clamp01(input.userPreferenceFit),
    evidenceSufficiency: clamp01(input.evidenceSufficiency),
    totalScore: Number(totalScore.toFixed(3)),
    approvalRequired: input.approvalRequired === true,
    evidenceIdsJson: safeJson(input.evidenceIds.slice(0, 40), 2400),
    nextAction: redactCouncilText(input.nextAction, 640),
    privacyJson: privacyJson(),
  };
}

function usefulnessScoresFor(input: {
  subject: string;
  report: AgentOSReport;
  evidenceIds: string[];
  coverageScore: number;
  missingPremises: LogicMissingPremise[];
  contradictions: LogicContradiction[];
  now: string;
}): LogicUsefulnessScore[] {
  const episodeId = input.report.latestEpisode?.episodeId || null;
  const answerScore = actionScore({
    actionId: hashId('logic:action', `${input.subject}|answer`),
    subject: input.subject,
    episodeId,
    actionLabel:
      'Answer now with cited caveats and the safest useful next action.',
    actionKind: 'answer',
    expectedUsefulness: input.coverageScore >= 0.55 ? 0.82 : 0.5,
    effort: 0.18,
    reversibility: 0.92,
    risk: input.contradictions.length > 0 ? 0.44 : 0.18,
    urgency: 0.62,
    userPreferenceFit: 0.82,
    evidenceSufficiency: input.coverageScore,
    evidenceIds: input.evidenceIds,
    nextAction: input.report.nextAction,
    now: input.now,
  });
  const clarifyScore = actionScore({
    actionId: hashId('logic:action', `${input.subject}|clarify`),
    subject: input.subject,
    episodeId,
    actionLabel:
      input.missingPremises[0]?.question || 'Ask one clarifying question.',
    actionKind: 'clarification',
    expectedUsefulness: input.missingPremises.length > 0 ? 0.9 : 0.35,
    effort: 0.28,
    reversibility: 1,
    risk: 0.05,
    urgency: input.missingPremises.length > 0 ? 0.76 : 0.24,
    userPreferenceFit: input.missingPremises.length > 0 ? 0.74 : 0.4,
    evidenceSufficiency: input.coverageScore,
    evidenceIds: input.evidenceIds,
    nextAction:
      input.missingPremises[0]?.nextAction ||
      'Proceed without clarification if evidence is sufficient.',
    now: input.now,
  });
  const readOnlyScore = actionScore({
    actionId: hashId('logic:action', `${input.subject}|read_only_evidence`),
    subject: input.subject,
    episodeId,
    actionLabel:
      'Gather one more read-only diagnostic/evidence source before answering.',
    actionKind: 'read_only',
    expectedUsefulness: input.coverageScore < 0.75 ? 0.78 : 0.42,
    effort: 0.38,
    reversibility: 0.98,
    risk: 0.08,
    urgency: 0.52,
    userPreferenceFit: 0.72,
    evidenceSufficiency: input.coverageScore,
    evidenceIds: input.evidenceIds,
    nextAction:
      'Use healthy read-only tool cards; do not mutate external systems.',
    now: input.now,
  });
  const approvalInterrupt = input.report.interrupts.find(
    (interrupt) =>
      interrupt.status === 'open' &&
      interrupt.interruptKind === 'approval_required',
  );
  const approvalScore = actionScore({
    actionId: hashId('logic:action', `${input.subject}|approval_stage`),
    subject: input.subject,
    episodeId,
    actionLabel: 'Stage the side-effectful step for explicit approval.',
    actionKind: 'approval_stage',
    expectedUsefulness: approvalInterrupt ? 0.86 : 0.25,
    effort: 0.3,
    reversibility: 0.86,
    risk: 0.35,
    urgency: approvalInterrupt ? 0.7 : 0.2,
    userPreferenceFit: 0.88,
    evidenceSufficiency: input.coverageScore,
    approvalRequired: true,
    evidenceIds: approvalInterrupt
      ? [approvalInterrupt.interruptId]
      : input.evidenceIds,
    nextAction:
      approvalInterrupt?.nextAction ||
      'Only stage approval if a side effect is actually requested.',
    now: input.now,
  });
  return [answerScore, clarifyScore, readOnlyScore, approvalScore].sort(
    (a, b) => b.totalScore - a.totalScore,
  );
}

function hypothesesFor(input: {
  subject: string;
  claims: LogicClaim[];
  evidenceIds: string[];
  missingPremises: LogicMissingPremise[];
  contradictions: LogicContradiction[];
  now: string;
}): LogicHypothesis[] {
  const claimIds = input.claims.map((claim) => claim.claimId);
  const canAnswerProbability =
    input.missingPremises.length === 0 && input.contradictions.length === 0
      ? 0.82
      : input.contradictions.length > 0
        ? 0.46
        : 0.58;
  return [
    {
      hypothesisId: hashId('logic:hypothesis', `${input.subject}|answer`),
      subject: input.subject,
      createdAt: input.now,
      updatedAt: input.now,
      claimIdsJson: safeJson(claimIds, 2400),
      evidenceIdsJson: safeJson(input.evidenceIds, 2400),
      probability: clamp01(canAnswerProbability),
      status: canAnswerProbability >= 0.7 ? 'preferred' : 'candidate',
      summary:
        canAnswerProbability >= 0.7
          ? 'Andrea can answer directly with evidence-backed caveats.'
          : 'Andrea can answer only with visible uncertainty or after one more evidence step.',
      nextAction:
        canAnswerProbability >= 0.7
          ? 'Answer with cited claims and the selected useful next action.'
          : 'Clarify the missing premise or gather one more safe evidence source.',
      privacyJson: privacyJson(),
    },
    {
      hypothesisId: hashId('logic:hypothesis', `${input.subject}|uncertain`),
      subject: input.subject,
      createdAt: input.now,
      updatedAt: input.now,
      claimIdsJson: safeJson(claimIds, 2400),
      evidenceIdsJson: safeJson(input.evidenceIds, 2400),
      probability: clamp01(1 - canAnswerProbability),
      status: canAnswerProbability < 0.7 ? 'preferred' : 'disfavored',
      summary:
        'Andrea should preserve uncertainty, name missing premises, and avoid overclaiming.',
      nextAction:
        'Ask one clarifying question or run a read-only evidence step.',
      privacyJson: privacyJson(),
    },
  ];
}

function decisionFor(input: {
  subject: string;
  report: AgentOSReport;
  claims: LogicClaim[];
  hypotheses: LogicHypothesis[];
  usefulnessScores: LogicUsefulnessScore[];
  missingPremises: LogicMissingPremise[];
  contradictions: LogicContradiction[];
  coverageScore: number;
  now: string;
}): LogicDecision {
  const episode = input.report.latestEpisode || null;
  const approvalAction = input.usefulnessScores.find(
    (score) =>
      score.actionKind === 'approval_stage' && score.totalScore >= 0.65,
  );
  const clarifyAction = input.usefulnessScores.find(
    (score) => score.actionKind === 'clarification',
  );
  const bestAction = input.usefulnessScores[0] || clarifyAction || null;
  const preferredHypothesis =
    input.hypotheses.find((hypothesis) => hypothesis.status === 'preferred') ||
    input.hypotheses[0] ||
    null;
  let status: LogicDecision['status'] = 'answer';
  if (approvalAction) status = 'stage_approval';
  else if (input.missingPremises.length > 0 && input.coverageScore < 0.72) {
    status = 'clarify';
  } else if (input.contradictions.some((item) => item.severity === 'high')) {
    status = 'blocked';
  }
  const confidence = clamp01(
    input.coverageScore -
      input.missingPremises.length * 0.1 -
      input.contradictions.length * 0.14,
  );
  return {
    decisionId: hashId(
      'logic:decision',
      `${input.subject}|${episode?.episodeId || 'no_episode'}|${status}`,
    ),
    subject: input.subject,
    episodeId: episode?.episodeId || null,
    runId: episode?.activeRunId || episode?.rootRunId || null,
    createdAt: input.now,
    updatedAt: input.now,
    status,
    selectedClaimIdsJson: safeJson(
      input.claims
        .filter((claim) => claim.status === 'active')
        .slice(0, 8)
        .map((claim) => claim.claimId),
      2400,
    ),
    selectedHypothesisId: preferredHypothesis?.hypothesisId || null,
    selectedActionId: bestAction?.actionId || null,
    confidence,
    utility: bestAction?.totalScore || 0,
    rationaleSummary:
      status === 'clarify'
        ? 'Confidence is limited by missing premises, so the safest useful move is one clarification or evidence step.'
        : status === 'stage_approval'
          ? 'The most useful next step touches an approval-gated path, so Andrea should stage it and wait.'
          : status === 'blocked'
            ? 'A high-severity contradiction blocks a confident answer.'
            : 'Available claims are sufficiently supported for a direct answer with caveats.',
    nextAction:
      bestAction?.nextAction ||
      input.report.nextAction ||
      'Gather more evidence before answering.',
    privacyJson: privacyJson(),
  };
}

function beliefStateFor(input: {
  subject: string;
  claims: LogicClaim[];
  hypotheses: LogicHypothesis[];
  contradictions: LogicContradiction[];
  missingPremises: LogicMissingPremise[];
  decision: LogicDecision;
  now: string;
}): LogicBeliefState {
  const status: LogicBeliefState['status'] =
    input.contradictions.length > 0
      ? 'conflicted'
      : input.missingPremises.length > 0
        ? 'needs_clarification'
        : input.decision.confidence >= 0.72
          ? 'stable'
          : 'uncertain';
  return {
    beliefStateId: hashId('logic:belief', input.subject),
    subject: input.subject,
    createdAt: input.now,
    updatedAt: input.now,
    status,
    topClaimIdsJson: safeJson(
      input.claims.slice(0, 8).map((claim) => claim.claimId),
      2400,
    ),
    hypothesisIdsJson: safeJson(
      input.hypotheses.map((hypothesis) => hypothesis.hypothesisId),
      2400,
    ),
    contradictionIdsJson: safeJson(
      input.contradictions.map(
        (contradiction) => contradiction.contradictionId,
      ),
      2400,
    ),
    missingPremiseIdsJson: safeJson(
      input.missingPremises.map((premise) => premise.premiseId),
      2400,
    ),
    decisionId: input.decision.decisionId,
    confidence: input.decision.confidence,
    probability:
      input.hypotheses.find((hypothesis) => hypothesis.status === 'preferred')
        ?.probability || input.decision.confidence,
    summary:
      status === 'stable'
        ? 'Logic Kernel has enough cited metadata to answer directly.'
        : status === 'conflicted'
          ? 'Logic Kernel found conflicting claims and will preserve uncertainty.'
          : status === 'needs_clarification'
            ? 'Logic Kernel found a missing premise before a confident answer.'
            : 'Logic Kernel can answer only with caveats.',
    nextAction: input.decision.nextAction,
    privacyJson: privacyJson(),
  };
}

function persistLogic(input: {
  claims: LogicClaim[];
  evidenceLinks: LogicEvidenceLink[];
  contradictions: LogicContradiction[];
  hypotheses: LogicHypothesis[];
  missingPremises: LogicMissingPremise[];
  usefulnessScores: LogicUsefulnessScore[];
  decision: LogicDecision;
  beliefState: LogicBeliefState;
}): void {
  try {
    for (const claim of input.claims) upsertLogicClaim(claim);
    for (const link of input.evidenceLinks) upsertLogicEvidenceLink(link);
    for (const contradiction of input.contradictions) {
      upsertLogicContradiction(contradiction);
    }
    for (const hypothesis of input.hypotheses)
      upsertLogicHypothesis(hypothesis);
    for (const premise of input.missingPremises) {
      upsertLogicMissingPremise(premise);
    }
    for (const score of input.usefulnessScores)
      upsertLogicUsefulnessScore(score);
    upsertLogicDecision(input.decision);
    upsertLogicBeliefState(input.beliefState);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/reading 'prepare'|reading "prepare"|database is not initialized/i.test(
        message,
      )
    ) {
      throw error;
    }
  }
}

export function beginLogicKernelRun(
  input: BeginLogicKernelInput = {},
): LogicKernelResult {
  const generatedAt = input.generatedAt || nowIso();
  const report =
    input.agentOSReport ||
    (input.cognitiveRun
      ? reportFromCognitiveRun(input.cognitiveRun, generatedAt)
      : buildAgentOSReport({ episodeId: input.episodeId, generatedAt }));
  const subject = redactCouncilText(
    input.subject ||
      report.latestEpisode?.goalSummary ||
      input.cognitiveRun?.run.goalSummary ||
      'Andrea current operating belief',
    320,
  );
  const coverage = scoreFromSourceCoverage(report);
  const claims = claimsFromReport({
    subject,
    report,
    cognitiveRun: input.cognitiveRun,
    now: generatedAt,
  });
  const explicitContradictions = contradictionPairs(claims);
  const sourceContradictions =
    coverage.conflictCount > 0 && claims.length > 0
      ? [
          makeContradiction({
            subject,
            claimIdA: claims[0].claimId,
            severity: coverage.conflictCount >= 2 ? 'high' : 'medium',
            summary: `Source coverage reports ${coverage.conflictCount} conflict(s).`,
            nextAction:
              'Name the conflict and avoid presenting the affected claim as certain.',
            now: generatedAt,
          }),
        ]
      : [];
  const contradictions = [...explicitContradictions, ...sourceContradictions];
  const missingPremises = missingPremisesFor({
    subject,
    report,
    claims,
    contradictions,
    coverageScore: coverage.score,
    conflictCount: coverage.conflictCount,
    now: generatedAt,
  });
  const evidenceIds = evidenceIdsForReport(report);
  const usefulnessScores = usefulnessScoresFor({
    subject,
    report,
    evidenceIds,
    coverageScore: coverage.score,
    missingPremises,
    contradictions,
    now: generatedAt,
  });
  const hypotheses = hypothesesFor({
    subject,
    claims,
    evidenceIds,
    missingPremises,
    contradictions,
    now: generatedAt,
  });
  const decision = decisionFor({
    subject,
    report,
    claims,
    hypotheses,
    usefulnessScores,
    missingPremises,
    contradictions,
    coverageScore: coverage.score,
    now: generatedAt,
  });
  const beliefState = beliefStateFor({
    subject,
    claims,
    hypotheses,
    contradictions,
    missingPremises,
    decision,
    now: generatedAt,
  });
  const contradictionIds = contradictions.map(
    (contradiction) => contradiction.contradictionId,
  );
  const claimsWithContradictions = claims.map((claim) => ({
    ...claim,
    contradictionIdsJson: safeJson(
      contradictions
        .filter(
          (contradiction) =>
            contradiction.claimIdA === claim.claimId ||
            contradiction.claimIdB === claim.claimId,
        )
        .map((contradiction) => contradiction.contradictionId),
      1200,
    ),
  }));
  const evidenceLinks = claimsWithContradictions.flatMap((claim) =>
    makeEvidenceLinks(claim),
  );
  persistLogic({
    claims: claimsWithContradictions,
    evidenceLinks,
    contradictions,
    hypotheses,
    missingPremises,
    usefulnessScores,
    decision,
    beliefState,
  });
  const logicReport: LogicKernelReport = {
    generatedAt,
    ok:
      beliefState.status !== 'conflicted' &&
      decision.status !== 'blocked' &&
      contradictionIds.length === 0,
    subject,
    beliefState,
    claims: claimsWithContradictions,
    evidenceLinks,
    contradictions,
    hypotheses,
    missingPremises,
    usefulnessScores,
    decision,
    confidence: decision.confidence,
    selectedNextAction: decision.nextAction,
    summary: `${beliefState.summary} Decision=${decision.status}; confidence=${decision.confidence.toFixed(2)}; action=${decision.nextAction}`,
    privacy: privacyReport(),
  };
  return { report: logicReport, beliefState, decision };
}

export function buildLogicKernelReport(
  params: {
    subject?: string | null;
    episodeId?: string | null;
    generatedAt?: string;
  } = {},
): LogicKernelReport {
  const generatedAt = params.generatedAt || nowIso();
  const subject = params.subject
    ? redactCouncilText(params.subject, 320)
    : undefined;
  const storedBeliefs = subject
    ? listLogicBeliefStates({ subject, limit: 1 })
    : listLogicBeliefStates({ limit: 1 });
  if (!storedBeliefs.length) {
    return beginLogicKernelRun({
      subject,
      episodeId: params.episodeId,
      generatedAt,
    }).report;
  }
  const beliefState = storedBeliefs[0];
  const claims = listLogicClaims({ subject: beliefState.subject, limit: 50 });
  const evidenceLinks = claims.flatMap((claim) =>
    listLogicEvidenceLinks({ claimId: claim.claimId, limit: 50 }),
  );
  const contradictions = listLogicContradictions({
    subject: beliefState.subject,
    limit: 50,
  });
  const hypotheses = listLogicHypotheses({
    subject: beliefState.subject,
    limit: 20,
  });
  const missingPremises = listLogicMissingPremises({
    subject: beliefState.subject,
    limit: 20,
  });
  const usefulnessScores = listLogicUsefulnessScores({
    subject: beliefState.subject,
    limit: 20,
  });
  const decision =
    (beliefState.decisionId
      ? listLogicDecisions({ subject: beliefState.subject, limit: 20 }).find(
          (item) => item.decisionId === beliefState.decisionId,
        )
      : null) ||
    listLogicDecisions({ subject: beliefState.subject, limit: 1 })[0] ||
    null;
  return {
    generatedAt,
    ok: beliefState.status === 'stable' || beliefState.status === 'uncertain',
    subject: beliefState.subject,
    beliefState,
    claims,
    evidenceLinks,
    contradictions,
    hypotheses,
    missingPremises,
    usefulnessScores,
    decision,
    confidence: beliefState.confidence,
    selectedNextAction: decision?.nextAction || beliefState.nextAction,
    summary: `${beliefState.summary} Confidence=${beliefState.confidence.toFixed(2)}.`,
    privacy: privacyReport(),
  };
}

function ageDays(iso: string, now: string): number {
  const thenMs = Date.parse(iso);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(thenMs) || !Number.isFinite(nowMs)) return 999;
  return Math.max(0, (nowMs - thenMs) / (24 * 60 * 60 * 1000));
}

function freshnessForClaim(
  claim: LogicClaim,
  generatedAt: string,
): LogicEvidenceFreshness {
  const days = ageDays(claim.updatedAt || claim.createdAt, generatedAt);
  if (days <= 1) return 'fresh';
  if (days <= 7) return 'recent';
  if (days <= 30) return 'stale';
  return 'expired';
}

function isStaleDrillClaim(claim: LogicClaim): boolean {
  if (!claim.sourceEpisodeId) return false;
  const episode = getAgentOSEpisode(claim.sourceEpisodeId);
  if (!episode) return false;
  const summary = `${episode.goalSummary} ${episode.nextAction}`.toLowerCase();
  const isDrill =
    summary.includes('drill') ||
    summary.includes('debug:agent-os') ||
    summary.includes('task-drill');
  return (
    isDrill &&
    (episode.status === 'interrupted' ||
      episode.status === 'blocked' ||
      episode.status === 'abandoned')
  );
}

function parseLogicControl(
  text: string | null | undefined,
): LogicReconciliationInput['userControl'] {
  const normalized = (text || '').trim().toLowerCase();
  if (normalized === 'mark that current' || normalized === 'that is current') {
    return 'mark_current';
  }
  if (normalized === 'that is stale' || normalized === 'mark that stale') {
    return 'mark_stale';
  }
  if (normalized === 'resolve that' || normalized === 'mark that resolved') {
    return 'resolve';
  }
  if (normalized === 'what changed?' || normalized === 'what changed') {
    return 'what_changed';
  }
  if (
    normalized === 'what is still uncertain?' ||
    normalized === 'what is still uncertain'
  ) {
    return 'uncertainty_report';
  }
  return null;
}

function transitionForClaim(input: {
  claim: LogicClaim;
  toStatus: LogicClaimStatus;
  reason: string;
  freshness: LogicEvidenceFreshness;
  actor: LogicClaimTransition['actor'];
  now: string;
}): LogicClaimTransition {
  return {
    transitionId: hashId(
      'logic:transition',
      `${input.claim.claimId}|${input.claim.status}|${input.toStatus}|${input.reason}`,
    ),
    claimId: input.claim.claimId,
    subject: input.claim.subject,
    createdAt: input.now,
    fromStatus: input.claim.status,
    toStatus: input.toStatus,
    reason: redactCouncilText(input.reason, 640),
    evidenceFreshness: input.freshness,
    sourceIdsJson: safeJson(parseJsonArray(input.claim.evidenceIdsJson), 2400),
    actor: input.actor,
    nextAction:
      input.toStatus === 'active'
        ? 'Treat the claim as current only while fresh evidence still supports it.'
        : input.toStatus === 'resolved'
          ? 'Keep the historical record, but remove this from active blockers.'
          : input.toStatus === 'stale'
            ? 'Gather fresh evidence before using this claim for current answers.'
            : 'Keep the claim visible with uncertainty.',
    privacyJson: privacyJson(),
  };
}

function reconciledStatusForClaim(input: {
  claim: LogicClaim;
  freshness: LogicEvidenceFreshness;
  userControl?: LogicReconciliationInput['userControl'];
}): {
  status: LogicClaimStatus;
  reason: string;
  actor: LogicClaimTransition['actor'];
} {
  if (input.userControl === 'mark_current') {
    return {
      status: 'active',
      reason: 'User marked the belief as current.',
      actor: 'user',
    };
  }
  if (input.userControl === 'mark_stale') {
    return {
      status: 'stale',
      reason: 'User marked the belief as stale.',
      actor: 'user',
    };
  }
  if (input.userControl === 'resolve') {
    return {
      status: 'resolved',
      reason: 'User resolved the stale or conflicting belief.',
      actor: 'user',
    };
  }
  if (
    input.claim.requiresConfirmation ||
    input.claim.sensitivity === 'sensitive'
  ) {
    return {
      status: 'needs_confirmation',
      reason:
        'High-impact or sensitive belief requires confirmation before durable promotion.',
      actor: 'logic_kernel',
    };
  }
  if (isStaleDrillClaim(input.claim)) {
    return {
      status: 'stale',
      reason:
        'Interrupted drill evidence is no longer allowed to block unrelated current answers.',
      actor: 'logic_kernel',
    };
  }
  if (input.freshness === 'expired') {
    return {
      status: 'stale',
      reason: 'Evidence expired under the Logic Kernel freshness policy.',
      actor: 'logic_kernel',
    };
  }
  if (
    input.freshness === 'stale' &&
    (input.claim.predicate === 'open_interrupt' ||
      input.claim.claimKind === 'episode_state')
  ) {
    return {
      status: 'stale',
      reason:
        'Episode-state evidence is stale and needs a fresh proof before blocking.',
      actor: 'logic_kernel',
    };
  }
  if (input.claim.status === 'contradicted') {
    return {
      status: 'contradicted',
      reason:
        'Contradicted claim remains visible until stronger evidence resolves it.',
      actor: 'logic_kernel',
    };
  }
  return {
    status: input.claim.status === 'stale' ? 'stale' : 'active',
    reason: 'Claim remains current under available evidence.',
    actor: 'logic_kernel',
  };
}

function buildHypothesisSet(input: {
  subject: string;
  hypotheses: LogicHypothesis[];
  activeClaimCount: number;
  staleClaimCount: number;
  now: string;
}): LogicHypothesisSet {
  const preferred =
    input.hypotheses.find((hypothesis) => hypothesis.status === 'preferred') ||
    input.hypotheses[0] ||
    null;
  return {
    hypothesisSetId: hashId(
      'logic:hypothesis_set',
      `${input.subject}|${input.hypotheses.map((item) => item.hypothesisId).join('|')}`,
    ),
    subject: input.subject,
    createdAt: input.now,
    updatedAt: input.now,
    hypothesisIdsJson: safeJson(
      input.hypotheses.map((hypothesis) => hypothesis.hypothesisId),
      2400,
    ),
    preferredHypothesisId: preferred?.hypothesisId || null,
    probabilitySummaryJson: safeJson(
      input.hypotheses.map((hypothesis) => ({
        hypothesisId: hypothesis.hypothesisId,
        probability: hypothesis.probability,
        status: hypothesis.status,
      })),
      2400,
    ),
    uncertaintySummary:
      input.staleClaimCount > 0
        ? `${input.staleClaimCount} stale claim(s) retired from active confidence; ${input.activeClaimCount} current claim(s) remain.`
        : 'No stale belief retirement was required.',
    nextAction:
      input.staleClaimCount > 0
        ? 'Use current claims first and request fresh evidence for stale proof paths.'
        : 'Proceed with the preferred hypothesis while citing evidence IDs.',
    privacyJson: privacyJson(),
  };
}

export function reconcileLogicBeliefs(
  input: LogicReconciliationInput = {},
): LogicReconciliationReport {
  const generatedAt = input.generatedAt || nowIso();
  const initialReport = buildLogicKernelReport({
    subject: input.subject,
    episodeId: input.episodeId,
    generatedAt,
  });
  const subject = initialReport.subject;
  const userControl =
    input.userControl || parseLogicControl(input.subject || null) || null;
  const storedClaims = listLogicClaims({ subject, limit: 200 });
  const transitions: LogicClaimTransition[] = [];
  const reconciledClaims: LogicClaim[] = [];
  const freshnessCounts: LogicReconciliationReport['freshness'] = {
    fresh: 0,
    recent: 0,
    stale: 0,
    expired: 0,
    unknown: 0,
  };

  for (const claim of storedClaims) {
    const freshness = freshnessForClaim(claim, generatedAt);
    freshnessCounts[freshness] += 1;
    const target = reconciledStatusForClaim({
      claim,
      freshness,
      userControl,
    });
    const nextClaim: LogicClaim = {
      ...claim,
      updatedAt: generatedAt,
      status: target.status,
    };
    if (target.status !== claim.status) {
      const transition = transitionForClaim({
        claim,
        toStatus: target.status,
        reason: target.reason,
        freshness,
        actor: target.actor,
        now: generatedAt,
      });
      transitions.push(transition);
      upsertLogicClaimTransition(transition);
      upsertLogicClaim(nextClaim);
    }
    reconciledClaims.push(nextClaim);
  }

  const staleClaims = reconciledClaims.filter(
    (claim) => claim.status === 'stale',
  );
  const activeClaims = reconciledClaims.filter(
    (claim) => claim.status === 'active',
  );
  const staleClaimIds = new Set(staleClaims.map((claim) => claim.claimId));
  const unresolvedContradictions: LogicContradiction[] = [];
  const resolvedContradictions: LogicContradiction[] = [];
  for (const contradiction of listLogicContradictions({
    subject,
    limit: 100,
  })) {
    if (
      contradiction.status === 'open' &&
      staleClaimIds.has(contradiction.claimIdA) &&
      (!contradiction.claimIdB || staleClaimIds.has(contradiction.claimIdB))
    ) {
      const resolved = {
        ...contradiction,
        updatedAt: generatedAt,
        status: 'resolved' as const,
        nextAction:
          'Resolved because the underlying claim evidence is stale or retired.',
      };
      upsertLogicContradiction(resolved);
      resolvedContradictions.push(resolved);
    } else if (contradiction.status === 'open') {
      unresolvedContradictions.push(contradiction);
    }
  }

  const hypotheses = listLogicHypotheses({ subject, limit: 50 });
  const hypothesisSet = buildHypothesisSet({
    subject,
    hypotheses,
    activeClaimCount: activeClaims.length,
    staleClaimCount: staleClaims.length,
    now: generatedAt,
  });
  upsertLogicHypothesisSet(hypothesisSet);

  const previousBelief = initialReport.beliefState || null;
  const confidenceAfter = clamp01(
    (previousBelief?.confidence ?? initialReport.confidence) +
      transitions.filter((item) => item.toStatus === 'resolved').length * 0.04 -
      unresolvedContradictions.length * 0.08 -
      staleClaims.length * 0.015,
  );
  const nextBelief: LogicBeliefState | null = previousBelief
    ? {
        ...previousBelief,
        updatedAt: generatedAt,
        status:
          unresolvedContradictions.length > 0
            ? 'conflicted'
            : activeClaims.length > 0
              ? 'stable'
              : 'uncertain',
        topClaimIdsJson: safeJson(
          activeClaims.slice(0, 8).map((claim) => claim.claimId),
          2400,
        ),
        contradictionIdsJson: safeJson(
          unresolvedContradictions.map((item) => item.contradictionId),
          2400,
        ),
        confidence: confidenceAfter,
        probability: confidenceAfter,
        summary:
          unresolvedContradictions.length > 0
            ? 'Logic reconciliation kept live contradictions visible and retired stale blockers.'
            : staleClaims.length > 0
              ? 'Logic reconciliation retired stale blockers and preserved current claims.'
              : 'Logic reconciliation found the current belief state usable.',
        nextAction:
          unresolvedContradictions.length > 0
            ? 'Gather fresh evidence or ask which claim should be treated as current.'
            : staleClaims.length > 0
              ? 'Use current claims; rerun proof for stale integrations only when needed.'
              : initialReport.selectedNextAction,
      }
    : null;
  if (nextBelief) upsertLogicBeliefState(nextBelief);

  const revision: LogicBeliefRevision = {
    revisionId: hashId(
      'logic:revision',
      `${subject}|${generatedAt}|${transitions.map((item) => item.transitionId).join('|')}`,
    ),
    subject,
    createdAt: generatedAt,
    previousBeliefStateId: previousBelief?.beliefStateId || null,
    nextBeliefStateId: nextBelief?.beliefStateId || null,
    transitionIdsJson: safeJson(
      transitions.map((transition) => transition.transitionId),
      2400,
    ),
    hypothesisSetId: hypothesisSet.hypothesisSetId,
    confidenceBefore: previousBelief?.confidence ?? initialReport.confidence,
    confidenceAfter,
    summary:
      transitions.length > 0
        ? `Applied ${transitions.length} claim lifecycle transition(s).`
        : 'No claim lifecycle transitions were needed.',
    nextAction:
      unresolvedContradictions.length > 0
        ? 'Resolve live contradictions with fresh evidence or user confirmation.'
        : 'Proceed with current claims and keep stale proof paths out of confidence math.',
    privacyJson: privacyJson(),
  };
  upsertLogicBeliefRevision(revision);

  const resolution: LogicResolutionDecision = {
    resolutionId: hashId('logic:resolution', `${subject}|${generatedAt}`),
    subject,
    createdAt: generatedAt,
    status:
      unresolvedContradictions.length > 0
        ? 'kept_uncertain'
        : transitions.some((item) => item.toStatus === 'resolved')
          ? 'resolved'
          : staleClaims.length > 0
            ? 'retired_stale'
            : reconciledClaims.some(
                  (claim) => claim.status === 'needs_confirmation',
                )
              ? 'needs_confirmation'
              : 'resolved',
    claimIdsJson: safeJson(
      reconciledClaims.map((claim) => claim.claimId),
      2400,
    ),
    transitionIdsJson: revision.transitionIdsJson,
    resolvedContradictionIdsJson: safeJson(
      resolvedContradictions.map((item) => item.contradictionId),
      2400,
    ),
    confidence: confidenceAfter,
    rationaleSummary:
      staleClaims.length > 0
        ? 'Stale or drill-derived blockers were removed from active confidence while historical claims remain stored.'
        : 'Current claims remain usable without stale blocker retirement.',
    nextAction: revision.nextAction,
    privacyJson: privacyJson(),
  };
  upsertLogicResolutionDecision(resolution);

  const report: LogicReconciliationReport = {
    generatedAt,
    ok: unresolvedContradictions.length === 0,
    subject,
    beliefState: nextBelief || previousBelief,
    revisions: [revision, ...listLogicBeliefRevisions({ subject, limit: 9 })],
    transitions: [
      ...transitions,
      ...listLogicClaimTransitions({ subject, limit: 20 }).filter(
        (item) =>
          !transitions.some(
            (transition) => transition.transitionId === item.transitionId,
          ),
      ),
    ],
    hypothesisSets: [
      hypothesisSet,
      ...listLogicHypothesisSets({ subject, limit: 9 }).filter(
        (item) => item.hypothesisSetId !== hypothesisSet.hypothesisSetId,
      ),
    ],
    resolutionDecisions: [
      resolution,
      ...listLogicResolutionDecisions({ subject, limit: 9 }).filter(
        (item) => item.resolutionId !== resolution.resolutionId,
      ),
    ],
    staleClaims,
    activeClaims,
    unresolvedContradictions,
    freshness: freshnessCounts,
    confidence: confidenceAfter,
    nextAction: resolution.nextAction,
    summary: `${revision.summary} ${resolution.rationaleSummary}`,
    privacy: privacyReport(),
  };
  return report;
}

export function buildLogicReconciliationReport(
  input: LogicReconciliationInput = {},
): LogicReconciliationReport {
  return reconcileLogicBeliefs(input);
}

export function formatLogicReconciliationReport(
  report: LogicReconciliationReport,
): string {
  return redactCouncilText(
    [
      'Logic Reconciliation',
      '',
      `Subject: ${report.subject}`,
      `OK: ${report.ok ? 'yes' : 'no'}`,
      `Belief: ${report.beliefState?.status || 'none'}`,
      `Confidence: ${report.confidence.toFixed(2)}`,
      `Active claims: ${report.activeClaims.length}`,
      `Stale claims: ${report.staleClaims.length}`,
      `Transitions: ${report.transitions.length}`,
      `Unresolved contradictions: ${report.unresolvedContradictions.length}`,
      `Freshness: fresh=${report.freshness.fresh}, recent=${report.freshness.recent}, stale=${report.freshness.stale}, expired=${report.freshness.expired}`,
      `Next: ${report.nextAction}`,
      '',
      'Recent Transitions',
      ...report.transitions
        .slice(0, 5)
        .map(
          (transition) =>
            `- ${transition.fromStatus} -> ${transition.toStatus}: ${transition.reason}`,
        ),
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    5000,
  );
}

export function formatLogicKernelReport(report: LogicKernelReport): string {
  const topClaims = report.claims.slice(0, 5);
  const bestAction = report.usefulnessScores[0] || null;
  return redactCouncilText(
    [
      'Logic Kernel',
      '',
      `Subject: ${report.subject}`,
      `Belief: ${report.beliefState?.status || 'none'}`,
      `Confidence: ${report.confidence.toFixed(2)}`,
      `Decision: ${report.decision?.status || 'none'}`,
      `Claims: ${report.claims.length}`,
      `Contradictions: ${report.contradictions.length}`,
      `Missing premises: ${report.missingPremises.length}`,
      `Best action: ${bestAction?.actionLabel || 'none'}`,
      `Best action score: ${bestAction?.totalScore ?? 'none'}`,
      `Next: ${report.selectedNextAction}`,
      '',
      'Top Claims',
      ...topClaims.map(
        (claim) =>
          `- ${claim.predicate}: ${claim.objectSummary} (${claim.confidence.toFixed(2)})`,
      ),
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    4000,
  );
}

export function buildLogicStatusText(): string {
  return formatLogicKernelReport(buildLogicKernelReport());
}

export function isLogicNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'why do you believe that?' ||
    normalized === 'why do you believe that' ||
    normalized === 'what are the alternatives?' ||
    normalized === 'what are the alternatives' ||
    normalized === "what's missing?" ||
    normalized === "what's missing" ||
    normalized === 'what is missing?' ||
    normalized === 'what is missing' ||
    normalized === "what's most useful next?" ||
    normalized === "what's most useful next" ||
    normalized === 'what is most useful next?' ||
    normalized === 'what is most useful next' ||
    normalized === 'mark that current' ||
    normalized === 'that is current' ||
    normalized === 'that is stale' ||
    normalized === 'mark that stale' ||
    normalized === 'resolve that' ||
    normalized === 'mark that resolved' ||
    normalized === 'what changed?' ||
    normalized === 'what changed' ||
    normalized === 'what is still uncertain?' ||
    normalized === 'what is still uncertain'
  );
}

export function evaluateLogicAnswerSupport(input: {
  report: LogicKernelReport | null | undefined;
  text: string;
}): LogicAnswerEvaluation {
  const text = input.text.trim();
  const report = input.report;
  const flags: string[] = [];
  if (!report) {
    if (
      !/\b(is|are|will|must|should|because|done|sent|deleted|created|changed|free|calendar|provider|proof|guaranteed|certainly|definitely)\b/i.test(
        text,
      ) ||
      /^(?:here|this|that)\s+(?:is|are)\b.*\b(plan|summary|answer|draft|reply)\b/i.test(
        text,
      )
    ) {
      return {
        status: 'pass',
        flags: ['logic_not_required'],
        summary:
          'Logic Kernel report was not required for this non-factual framing text.',
      };
    }
    return {
      status: 'warn',
      flags: ['logic_report_missing'],
      summary: 'Logic Kernel report was not available for answer evaluation.',
    };
  }
  if (/sk-|AIza|Bearer\s+|chain-of-thought|raw private body/i.test(text)) {
    return {
      status: 'block',
      flags: ['logic_privacy_leak'],
      summary: 'Logic evaluator detected secret/private-reasoning leakage.',
      suggestedRewrite: 'I need to answer without exposing private material.',
    };
  }
  if (
    report.contradictions.length > 0 &&
    /\b(definitely|certainly|no doubt|guaranteed|for sure)\b/i.test(text)
  ) {
    flags.push('contradicted_claim_presented_as_certain');
  }
  if (
    report.missingPremises.length > 0 &&
    !/[?]|\b(I need|missing|uncertain|not enough|gap|before I can)\b/i.test(
      text,
    )
  ) {
    flags.push('missing_premise_not_disclosed');
  }
  if (
    report.claims.length === 0 &&
    /\b(is|are|will|must|should|because)\b/i.test(text)
  ) {
    flags.push('unsupported_factual_claim');
  }
  if (
    report.decision?.status === 'stage_approval' &&
    /\b(done|sent|deleted|created|changed|committed|pushed)\b/i.test(text)
  ) {
    flags.push('approval_gate_overreach');
  }
  const status: LogicAnswerEvaluation['status'] = flags.some((flag) =>
    /privacy|approval/.test(flag),
  )
    ? 'block'
    : flags.length
      ? 'warn'
      : 'pass';
  return {
    status,
    flags: flags.length ? flags : ['logic_supported'],
    summary:
      status === 'pass'
        ? 'Logic evaluator found claims, uncertainty, and approval posture aligned.'
        : `Logic evaluator found ${flags.join(', ')}.`,
    suggestedRewrite:
      status === 'block'
        ? `I need to keep this approval-safe and evidence-backed. ${report.selectedNextAction}`
        : null,
  };
}

export function _testLogicPrivacyJson(): string {
  return privacyJson();
}

export function _testLogicSubjectHash(
  subject = `logic-test-${randomUUID()}`,
): string {
  return hashId('logic:subject', subject);
}
