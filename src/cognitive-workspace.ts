import { createHash } from 'node:crypto';

import {
  buildAgencyConvergenceDoctorReport,
  runAgencyConvergenceLoop,
} from './agency-convergence-loop.js';
import { buildAgentOSReport } from './agent-os.js';
import { buildAgentRuntimeSpineReport } from './agent-runtime-spine.js';
import {
  runtimePrivacyJson,
  runtimePrivacyReport,
  runtimeSafeJson,
  runtimeSanitizeId,
} from './agent-runtime-glue.js';
import { redactCouncilText } from './council-safety.js';
import {
  getCognitiveWorkspacePacket,
  isDatabaseInitialized,
  listCognitiveImprovementProposals,
  listCognitiveOptimizationScorecards,
  listCognitivePolicyVariants,
  listCognitiveProgramManifests,
  listCognitiveProgramRuns,
  listCognitiveWorkspaceContextBlocks,
  listCognitiveWorkspacePackets,
  upsertCognitiveImprovementProposal,
  upsertCognitiveOptimizationScorecard,
  upsertCognitivePolicyVariant,
  upsertCognitiveProgramManifest,
  upsertCognitiveProgramRun,
  upsertCognitiveWorkspaceContextBlock,
  upsertCognitiveWorkspacePacket,
} from './db.js';
import { buildHarnessLabReport, runRhoHarnessReplay } from './harness-lab.js';
import { buildLogicKernelReport } from './logic-kernel.js';
import { buildSessionGraphReport } from './session-graph.js';
import { buildTruthEngineReport } from './truth-engine.js';
import { buildWorldModelReport } from './world-model.js';
import type {
  AgencyConvergenceDoctorReport,
  AgentOSReport,
  AgentRuntimeSpineReport,
  CognitiveContextBudget,
  CognitiveGoalStack,
  CognitiveImprovementProposal,
  CognitiveOptimizationScorecard,
  CognitivePolicyVariant,
  CognitiveProgramManifest,
  CognitiveProgramRun,
  CognitiveWorkspaceContextBlock,
  CognitiveWorkspaceDoctorReport,
  CognitiveWorkspacePacket,
  CognitiveWorkspaceStatus,
  HarnessLabReport,
  LogicEvidenceFreshness,
  LogicKernelReport,
  SessionContinuityActionItem,
  SessionGraphDoctorReport,
  TruthEngineReport,
  WorldModelDoctorReport,
} from './types.js';

export const COGNITIVE_WORKSPACE_SOURCE_REFS = [
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:trace/guardrail/run-state glue already adapted in Runtime Spine',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:fail-closed policy/intervention shape already adapted',
  'langgraphjs@c41878187014ff58a4ee8371fa8361edc97b2e84:checkpoint/pending-write pattern already adapted',
  'gbrain@805814451ec9e962ceed1b931b9b512d80f70024:freshness/citation/conflict scoring already adapted',
  'openhands@03aab93625079c24d6f43655c9506931cf43bc17:event-summary/skill-precedence pattern already adapted',
  'openai-evals:eval-template/result-shape clean-room schema for v22 optimizer proposals',
  'dspy:metric-driven optimizer clean-room posture; proposals remain candidate-only',
  'letta:memory-block clean-room context-router posture',
];

export interface BuildCognitiveWorkspaceInput {
  generatedAt?: string;
  packetId?: string | null;
  persist?: boolean;
  executeAgencyLoop?: boolean;
  optimize?: boolean;
  intentText?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return runtimeSanitizeId(
    `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`,
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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

function unique(
  values: Array<string | null | undefined>,
  limit = 80,
): string[] {
  return Array.from(
    new Set(values.filter((item): item is string => Boolean(item))),
  ).slice(0, limit);
}

function safeJson(value: unknown, limit = 12000): string {
  return runtimeSafeJson(value, limit);
}

function safeIdJson(
  ids: Array<string | null | undefined>,
  limit = 3200,
): string {
  const safeIds = ids
    .map((id) => runtimeSanitizeId(String(id || '')))
    .filter(Boolean);
  const json = JSON.stringify(safeIds);
  if (json.length <= limit) return json;
  const kept: string[] = [];
  for (const id of safeIds) {
    const next = JSON.stringify([...kept, id]);
    if (next.length > limit) break;
    kept.push(id);
  }
  return JSON.stringify(kept);
}

function firstAction(
  report: SessionGraphDoctorReport,
): SessionContinuityActionItem | null {
  return (
    report.cockpit.actionQueue.find(
      (item) => item.kind !== 'review_candidate_link',
    ) ||
    report.cockpit.actionQueue[0] ||
    null
  );
}

function taskFamilyForAction(
  action: SessionContinuityActionItem | null,
): string {
  const text =
    `${action?.summary || ''} ${action?.nextAction || ''}`.toLowerCase();
  if (/calendar|schedule/.test(text)) return 'calendar';
  if (/message|bluebubbles|reply|send|thread/.test(text))
    return 'communication';
  if (/research|search|source|web/.test(text)) return 'research';
  if (/provider|integration|service|proof|alexa|telegram|operator/.test(text)) {
    return 'operator';
  }
  return 'assistant';
}

function freshnessForBlock(
  kind: CognitiveWorkspaceContextBlock['blockKind'],
): LogicEvidenceFreshness {
  if (kind === 'provider_plan' || kind === 'runtime_spine') return 'fresh';
  if (kind === 'session_continuity' || kind === 'world_model') return 'recent';
  if (kind === 'harness_trajectory' || kind === 'memory_skill')
    return 'unknown';
  return 'recent';
}

function makeBlock(input: {
  packetId: string;
  createdAt: string;
  kind: CognitiveWorkspaceContextBlock['blockKind'];
  sourceId: string;
  sourceIds: string[];
  summary: string;
  evidenceIds?: string[];
  conflicts?: string[];
  confidence?: number;
  priority?: number;
  tokenBudget?: number;
  included?: boolean;
  sensitivity?: CognitiveWorkspaceContextBlock['sensitivity'];
  withheldReason?: string | null;
}): CognitiveWorkspaceContextBlock {
  return {
    blockId: hashId(
      'workspace:block',
      `${input.packetId}|${input.kind}|${input.sourceId}`,
    ),
    packetId: input.packetId,
    createdAt: input.createdAt,
    blockKind: input.kind,
    sourceId: runtimeSanitizeId(input.sourceId || input.kind),
    sourceIdsJson: safeIdJson(input.sourceIds, 2400),
    freshness: freshnessForBlock(input.kind),
    sensitivity: input.sensitivity || 'internal',
    confidence: clamp01(input.confidence ?? 0.75),
    priority: input.priority ?? 0.5,
    tokenBudget: Math.max(120, Math.min(1800, input.tokenBudget || 520)),
    included: input.included !== false,
    summary: redactCouncilText(input.summary, 900),
    evidenceIdsJson: safeIdJson(input.evidenceIds || [], 3200),
    conflictsJson: safeJson(input.conflicts || [], 2400),
    withheldReason: input.withheldReason || null,
    privacyJson: runtimePrivacyJson(),
  };
}

function reportEvidenceIds(input: {
  session: SessionGraphDoctorReport;
  world: WorldModelDoctorReport;
  logic: LogicKernelReport;
  truth: TruthEngineReport;
  agency: AgencyConvergenceDoctorReport;
  runtime?: AgentRuntimeSpineReport | null;
}): string[] {
  return unique([
    ...input.session.cockpit.focuses.flatMap(
      (focus) => focus.evidenceIds || [],
    ),
    ...input.session.cockpit.actionQueue.flatMap(
      (action) => action.evidenceIds || [],
    ),
    ...input.world.evidenceRefs.map((ref) => ref.evidenceRefId),
    ...input.world.claims.flatMap((claim) =>
      parseJsonArray(claim.evidenceRefIdsJson),
    ),
    ...input.logic.claims.flatMap((claim) =>
      parseJsonArray(claim.evidenceIdsJson),
    ),
    ...parseJsonArray(input.truth.latestAudit?.evidenceIdsJson),
    ...input.agency.agendas.flatMap((agenda) =>
      parseJsonArray(agenda.evidenceIdsJson),
    ),
    ...(input.runtime?.evidencePackets.flatMap((packet) =>
      parseJsonArray(packet.evidenceIdsJson),
    ) || []),
  ]);
}

function buildGoalStack(input: {
  createdAt: string;
  action: SessionContinuityActionItem | null;
  evidenceIds: string[];
  blockers: string[];
}): CognitiveGoalStack {
  const taskFamily = taskFamilyForAction(input.action);
  return {
    goalStackId: hashId(
      'workspace:goal',
      `${input.createdAt}|${input.action?.actionId || 'status'}`,
    ),
    createdAt: input.createdAt,
    rootGoal:
      'Make Andrea act as one coherent, evidence-grounded task partner.',
    activeGoal:
      input.action?.summary ||
      'Inspect current cognition, proof debt, provider participation, and next safe action.',
    taskFamily,
    selectedActionId: input.action?.actionId || null,
    selectedActionKind: input.action?.kind || null,
    priority: input.action?.priority || 0,
    safeActionOnly: true,
    approvalRequired: Boolean(input.action?.approvalRequired),
    evidenceIdsJson: safeIdJson(input.evidenceIds, 3200),
    blockersJson: safeJson(input.blockers, 2400),
    nextAction:
      input.action?.nextAction ||
      'Inspect the workspace packet and choose the safest useful next action.',
  };
}

function buildContextBlocks(input: {
  packetId: string;
  generatedAt: string;
  session: SessionGraphDoctorReport;
  world: WorldModelDoctorReport;
  logic: LogicKernelReport;
  truth: TruthEngineReport;
  agentOS: AgentOSReport;
  agency: AgencyConvergenceDoctorReport;
  runtime?: AgentRuntimeSpineReport | null;
  harness: HarnessLabReport;
}): CognitiveWorkspaceContextBlock[] {
  const action = firstAction(input.session);
  const providerPlan = input.agency.providerPlans[0] || null;
  const latestOutcome = input.agency.outcomes[0] || null;
  const latestEval = input.agentOS.trajectoryEvals[0] || null;
  const latestScore = input.harness.scorecards[0] || null;
  const blocks = [
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'session_continuity',
      sourceId: input.session.snapshot.snapshotId,
      sourceIds: [
        input.session.snapshot.snapshotId,
        ...(action?.sourceNodeIds || []),
        ...(action?.sourceSuggestionIds || []),
      ],
      summary: `Session Graph has ${input.session.cockpit.focusCount} continuity focus item(s), ${input.session.cockpit.actionCount} queued action(s), and proof debt total ${input.session.cockpit.proofDebt.total}. Top action: ${action?.summary || 'none'}.`,
      evidenceIds: action?.evidenceIds || [],
      conflicts: input.session.reviewNeededCount
        ? ['semantic_links_need_review']
        : [],
      confidence: input.session.ok ? 0.82 : 0.62,
      priority: 0.98,
      tokenBudget: 620,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'world_model',
      sourceId: input.world.snapshot.snapshotId,
      sourceIds: [input.world.snapshot.snapshotId],
      summary: `World Model status ${input.world.snapshot.status}; ${input.world.verificationNeeds.length} verification need(s), ${input.world.openQuestions.length} open question(s), ${input.world.riskStates.length} risk state(s).`,
      evidenceIds: input.world.evidenceRefs
        .map((ref) => ref.evidenceRefId)
        .slice(0, 40),
      conflicts: input.world.riskStates
        .map((risk) => risk.riskClass)
        .slice(0, 12),
      confidence: input.world.ok ? 0.84 : 0.58,
      priority: 0.95,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'logic_belief',
      sourceId: input.logic.beliefState?.beliefStateId || 'logic:none',
      sourceIds: [
        input.logic.beliefState?.beliefStateId || '',
        ...input.logic.claims.map((claim) => claim.claimId).slice(0, 20),
      ].filter(Boolean),
      summary: `Logic Kernel tracks ${input.logic.claims.length} claim(s), ${input.logic.contradictions.length} contradiction(s), and confidence ${input.logic.beliefState?.confidence ?? 'unknown'}.`,
      evidenceIds: input.logic.claims
        .flatMap((claim) => parseJsonArray(claim.evidenceIdsJson))
        .slice(0, 40),
      conflicts: input.logic.contradictions
        .map((item) => item.contradictionId)
        .slice(0, 12),
      confidence: input.logic.beliefState?.confidence ?? 0.65,
      priority: 0.86,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'truth_support',
      sourceId: input.truth.latestAudit?.auditId || 'truth:none',
      sourceIds: [input.truth.latestAudit?.auditId || ''].filter(Boolean),
      summary: `Truth Engine latest audit ${input.truth.latestAudit?.status || 'none'} with ${input.truth.claims.length} claim summary row(s).`,
      evidenceIds: input.truth.evidenceSupports
        .map((support) => support.evidenceId || support.supportId)
        .slice(0, 40),
      conflicts: input.truth.contradictionChecks
        .map((check) => check.checkId)
        .slice(0, 12),
      confidence: input.truth.ok ? 0.84 : 0.56,
      priority: 0.84,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'provider_plan',
      sourceId: providerPlan?.participationPlanId || 'providers:none',
      sourceIds: providerPlan ? [providerPlan.participationPlanId] : [],
      summary: `Provider participation is ${providerPlan?.status || 'unknown'}; skipped providers ${parseJsonArray(providerPlan?.skippedProviderIdsJson).join(', ') || 'none'}.`,
      evidenceIds: [],
      conflicts:
        providerPlan && providerPlan.status !== 'healthy'
          ? [`provider_participation_${providerPlan.status}`]
          : [],
      confidence: providerPlan?.status === 'healthy' ? 0.9 : 0.62,
      priority: 0.82,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'runtime_spine',
      sourceId:
        input.runtime?.latestRun?.runtimeRunId ||
        input.agency.latestRun?.runtimeRunId ||
        'runtime:none',
      sourceIds: [
        input.runtime?.latestRun?.runtimeRunId || '',
        ...(input.runtime?.checkpoints.map(
          (checkpoint) => checkpoint.checkpointId,
        ) || []),
      ].filter(Boolean),
      summary: `Runtime Spine run ${input.runtime?.latestRun?.runtimeRunId || 'none'} has ${input.runtime?.steps.length || 0} step(s), ${input.runtime?.checkpoints.length || 0} checkpoint(s), and ${input.runtime?.guardrails.length || 0} guardrail result(s).`,
      evidenceIds:
        input.runtime?.evidencePackets
          .flatMap((packet) => parseJsonArray(packet.evidenceIdsJson))
          .slice(0, 40) || [],
      confidence: input.runtime?.ok ? 0.82 : 0.55,
      priority: 0.78,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'supervisor_blackboard',
      sourceId:
        input.runtime?.supervisorReport?.blackboard?.blackboardId ||
        input.agency.latestRun?.supervisorRunId ||
        'supervisor:none',
      sourceIds: [
        input.runtime?.supervisorReport?.latestRun?.supervisorRunId || '',
        input.runtime?.supervisorReport?.blackboard?.blackboardId || '',
      ].filter(Boolean),
      summary: `Supervisor has ${input.runtime?.supervisorReport?.handoffs.length || 0} handoff(s), ${input.runtime?.supervisorReport?.blackboardPatches.length || 0} blackboard patch(es), and next action ${input.runtime?.supervisorReport?.nextAction || 'none'}.`,
      evidenceIds: parseJsonArray(
        input.runtime?.supervisorReport?.blackboard?.evidenceIdsJson,
      ).slice(0, 40),
      confidence: input.runtime?.supervisorReport?.ok ? 0.78 : 0.52,
      priority: 0.74,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'agent_os',
      sourceId: input.agentOS.latestEpisode?.episodeId || 'agentos:none',
      sourceIds: [
        input.agentOS.latestEpisode?.episodeId || '',
        ...input.agentOS.skillProposals.map((proposal) => proposal.proposalId),
      ].filter(Boolean),
      summary: `Agent OS has ${input.agentOS.episodeSteps.length} step(s), ${input.agentOS.interrupts.length} interrupt(s), ${input.agentOS.toolCards.length} tool card(s), and latest trajectory score ${latestEval?.overallScore ?? 'none'}.`,
      evidenceIds: parseJsonArray(
        input.agentOS.latestEpisode?.evidenceIdsJson,
      ).slice(0, 40),
      conflicts: input.agentOS.interrupts
        .filter((item) => item.status === 'open')
        .map((item) => item.interruptKind),
      confidence: latestEval?.overallScore ?? (input.agentOS.ok ? 0.74 : 0.5),
      priority: 0.72,
    }),
    makeBlock({
      packetId: input.packetId,
      createdAt: input.generatedAt,
      kind: 'harness_trajectory',
      sourceId: latestScore?.scorecardId || 'harness:none',
      sourceIds: input.harness.scorecards
        .map((scorecard) => scorecard.scorecardId)
        .slice(0, 20),
      summary: `Harness Lab average score ${input.harness.averageScore}; ${input.harness.proposals.length} candidate proposal(s), failing families ${input.harness.failingTaskFamilies.join(', ') || 'none'}.`,
      evidenceIds: input.harness.trajectories
        .flatMap((trajectory) => parseJsonArray(trajectory.evidenceIdsJson))
        .slice(0, 40),
      conflicts: input.harness.failingTaskFamilies,
      confidence: clamp01(input.harness.averageScore || 0.5),
      priority: 0.68,
    }),
  ];

  if (latestOutcome) {
    blocks.push(
      makeBlock({
        packetId: input.packetId,
        createdAt: input.generatedAt,
        kind: 'operating_rule',
        sourceId: latestOutcome.outcomeId,
        sourceIds: [latestOutcome.outcomeId],
        summary: `Agency loop outcome ${latestOutcome.status}; score ${latestOutcome.outcomeScore}; side effects remain approval-staged.`,
        evidenceIds: [],
        conflicts: parseJsonArray(latestOutcome.flagsJson),
        confidence: latestOutcome.outcomeScore,
        priority: 0.66,
      }),
    );
  }
  return blocks
    .sort((a, b) => b.priority - a.priority)
    .map((block, index) => ({
      ...block,
      included: index < 10 && block.sensitivity !== 'secret_excluded',
      withheldReason:
        index < 10
          ? block.withheldReason
          : 'Context budget held this lower-priority block out.',
    }));
}

function buildContextBudget(input: {
  packetId: string;
  createdAt: string;
  blocks: CognitiveWorkspaceContextBlock[];
}): CognitiveContextBudget {
  const included = input.blocks.filter((block) => block.included).length;
  return {
    budgetId: hashId('workspace:budget', input.packetId),
    packetId: input.packetId,
    createdAt: input.createdAt,
    maxBlocks: 10,
    includedBlocks: included,
    withheldBlocks: Math.max(0, input.blocks.length - included),
    freshnessFloor: 'unknown',
    privacyPolicy: 'metadata_only',
    reason:
      'Prioritize source-attributed continuity, proof debt, current belief/truth support, runtime status, and harness outcome metadata.',
  };
}

function candidateProgram(input: {
  packetId: string;
  generatedAt: string;
  goalStack: CognitiveGoalStack;
  blocks: CognitiveWorkspaceContextBlock[];
  agentOS: AgentOSReport;
  harness: HarnessLabReport;
}): CognitiveProgramManifest {
  const candidate = input.agentOS.skillProposals
    .filter((proposal) => proposal.status === 'candidate')
    .sort((a, b) => b.outcomeScore - a.outcomeScore)[0];
  const safeTools = input.agentOS.toolCards
    .filter(
      (card) =>
        card.policyClass === 'local_lookup' ||
        card.policyClass === 'read_only' ||
        card.policyClass === 'council',
    )
    .slice(0, 10);
  const score =
    candidate?.outcomeScore ?? clamp01(input.harness.averageScore || 0.62);
  const programId = hashId(
    'workspace:program',
    `${input.goalStack.taskFamily}|${candidate?.proposalId || input.goalStack.selectedActionKind || 'status'}`,
  );
  const hasVerifiedSuccess = Boolean(candidate && score >= 0.88);
  return {
    programId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status: hasVerifiedSuccess ? 'shadow' : 'candidate',
    taskFamily: input.goalStack.taskFamily,
    triggerSummary:
      candidate?.triggerSummary ||
      `Similar ${input.goalStack.taskFamily} task with current workspace evidence and no hidden context.`,
    programSummary:
      candidate?.skillSummary ||
      `Reusable workspace program: compile context blocks, choose safe read-only route, verify with Logic/Truth, and stage approvals.`,
    sourceTrajectoryIdsJson: safeIdJson(
      input.harness.trajectories
        .filter((trajectory) => trajectory.status === 'pass')
        .map((trajectory) => trajectory.trajectoryId)
        .slice(0, 12),
      2400,
    ),
    requiredEvidenceJson: safeJson(
      input.blocks
        .filter((block) => block.included)
        .map((block) => block.blockKind),
      2400,
    ),
    allowedToolsJson: safeJson(
      safeTools.map((tool) => ({
        toolCardId: tool.toolCardId,
        sourceToolId: tool.sourceToolId,
        policyClass: tool.policyClass,
      })),
      3200,
    ),
    approvalRulesJson: safeJson(
      [
        'mutating_actions_are_approval_staged',
        'no_auto_send',
        'no_calendar_write_without_approval',
        'no_commit_or_push_without_explicit_user_request',
      ],
      1600,
    ),
    verifierChecksJson: safeJson(
      [
        'truth_support_present',
        'world_model_freshness_checked',
        'provider_participation_not_faked',
        'context_blocks_metadata_only',
      ],
      2000,
    ),
    failureModesJson: safeJson(
      [
        ...(input.goalStack.approvalRequired ? ['approval_required'] : []),
        ...input.blocks
          .flatMap((block) => parseJsonArray(block.conflictsJson))
          .slice(0, 10),
      ],
      2400,
    ),
    outcomeScore: score,
    promotionReason: hasVerifiedSuccess
      ? 'Candidate has high outcome score, but remains shadow until user-confirmed success.'
      : 'Needs verified success or explicit confirmation before trusted promotion.',
    nextAction:
      'Run the workspace program in shadow/candidate mode, compare harness score, and promote only after verified success.',
    privacyJson: runtimePrivacyJson(),
  };
}

function programRunFor(input: {
  packetId: string;
  generatedAt: string;
  program: CognitiveProgramManifest;
  evidenceIds: string[];
  approvalBlockers: string[];
}): CognitiveProgramRun {
  const status: CognitiveProgramRun['status'] =
    input.approvalBlockers.length > 0
      ? 'blocked'
      : input.program.status === 'shadow'
        ? 'shadowed'
        : 'selected';
  return {
    programRunId: hashId(
      'workspace:program_run',
      `${input.packetId}|${input.program.programId}`,
    ),
    packetId: input.packetId,
    programId: input.program.programId,
    createdAt: input.generatedAt,
    status,
    selected: true,
    evidenceIdsJson: safeIdJson(input.evidenceIds, 3200),
    policyResultJson: safeJson(
      {
        status,
        sideEffectsExecuted: false,
        approvalBlockers: input.approvalBlockers,
      },
      2400,
    ),
    outcomeScore: input.approvalBlockers.length
      ? 0.55
      : input.program.outcomeScore,
    nextAction:
      status === 'blocked'
        ? 'Stage approval or manual-proof instructions; do not execute side effects.'
        : 'Use this candidate program as guidance for the next safe workspace turn.',
    privacyJson: runtimePrivacyJson(),
  };
}

function policyVariantFor(input: {
  generatedAt: string;
  blocks: CognitiveWorkspaceContextBlock[];
  providerStatus: string;
}): CognitivePolicyVariant {
  const withheld = input.blocks.filter((block) => !block.included).length;
  const variantKind: CognitivePolicyVariant['variantKind'] =
    withheld > 0 ? 'context_budget' : 'eval_template';
  return {
    variantId: hashId(
      'workspace:variant',
      `${variantKind}|${input.providerStatus}|${withheld}`,
    ),
    createdAt: input.generatedAt,
    status: 'candidate',
    variantKind,
    summary:
      variantKind === 'context_budget'
        ? 'Candidate: increase context block budget only when evidence gaps remain after current packet.'
        : 'Candidate: add an OpenAI Evals-style task template for workspace route usefulness.',
    changedKnobsJson: safeJson(
      variantKind === 'context_budget'
        ? ['max_context_blocks:+2_when_truth_warns', 'privacy_policy:unchanged']
        : ['eval_family:cognitive_workspace_route', 'scorecard:deterministic'],
      1600,
    ),
    safetyBaselineJson: safeJson(
      [
        'metadata_only',
        'approval_gates_unchanged',
        'provider_health_not_faked',
      ],
      1600,
    ),
    sourceRefsJson: safeJson(COGNITIVE_WORKSPACE_SOURCE_REFS, 3200),
    privacyJson: runtimePrivacyJson(),
  };
}

function scoreWorkspace(input: {
  generatedAt: string;
  packetId: string;
  proposalId: string;
  variantId: string;
  blocks: CognitiveWorkspaceContextBlock[];
  programRun: CognitiveProgramRun;
  evidenceIds: string[];
  truth: TruthEngineReport;
  approvalBlockers: string[];
  providerStatus: string;
}): CognitiveOptimizationScorecard {
  const included = input.blocks.filter((block) => block.included).length;
  const contextScore = clamp01(
    included / Math.max(1, Math.min(10, input.blocks.length)),
  );
  const evidenceScore = clamp01(input.evidenceIds.length / 8);
  const truthScore = input.truth.ok ? 0.92 : 0.62;
  const policySafetyScore =
    input.approvalBlockers.length > 0 || input.providerStatus === 'blocked'
      ? 0.86
      : 1;
  const programScore = input.programRun.outcomeScore;
  const privacyScore = 1;
  const totalScore = Number(
    (
      contextScore * 0.18 +
      programScore * 0.18 +
      policySafetyScore * 0.22 +
      evidenceScore * 0.16 +
      truthScore * 0.16 +
      privacyScore * 0.1
    ).toFixed(3),
  );
  const flags = [
    ...(contextScore < 0.7 ? ['context_under_budget'] : []),
    ...(evidenceScore < 0.5 ? ['evidence_sparse'] : []),
    ...(truthScore < 0.8 ? ['truth_warn'] : []),
    ...(input.providerStatus !== 'healthy'
      ? [`provider_${input.providerStatus}`]
      : []),
    ...input.approvalBlockers,
  ];
  return {
    scorecardId: hashId(
      'workspace:scorecard',
      `${input.packetId}|${totalScore}`,
    ),
    packetId: input.packetId,
    proposalId: input.proposalId,
    variantId: input.variantId,
    createdAt: input.generatedAt,
    status: totalScore >= 0.84 ? 'pass' : totalScore >= 0.65 ? 'warn' : 'fail',
    contextScore,
    programScore,
    policySafetyScore,
    evidenceScore,
    truthScore,
    privacyScore,
    totalScore,
    failureFlagsJson: safeJson(flags, 2400),
    nextAction:
      totalScore >= 0.84
        ? 'Keep this workspace route as a candidate pattern; wait for user-confirmed success before trust.'
        : 'Create a candidate-only improvement proposal and rerun workspace tests.',
    privacyJson: runtimePrivacyJson(),
  };
}

function proposalFor(input: {
  generatedAt: string;
  packetId: string;
  scorecardId: string;
  scorecardStatus: CognitiveOptimizationScorecard['status'];
}): CognitiveImprovementProposal {
  const status: CognitiveImprovementProposal['status'] = 'candidate';
  return {
    improvementProposalId: hashId(
      'workspace:proposal',
      `${input.packetId}|${input.scorecardId}`,
    ),
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status,
    proposalKind:
      input.scorecardStatus === 'pass' ? 'program' : 'context_budget',
    sourcePacketId: input.packetId,
    sourceScorecardId: input.scorecardId,
    summary:
      input.scorecardStatus === 'pass'
        ? 'Candidate program promotion: retain this workspace route as a shadow program until real-world success confirms it.'
        : 'Candidate context-router improvement: add one more cited block or targeted eval before answering low-evidence tasks.',
    expectedScoreDelta: input.scorecardStatus === 'pass' ? 0.04 : 0.08,
    safetyRegression: false,
    changedArtifactsJson: safeJson(
      [
        'candidate_only',
        'no_code_mutation',
        'no_secret_change',
        'no_live_channel_mutation',
        'approval_policy_unchanged',
      ],
      1600,
    ),
    nextAction:
      'Review proposal after focused workspace tests; do not apply automatically.',
    privacyJson: runtimePrivacyJson(),
  };
}

function statusFor(input: {
  action: SessionContinuityActionItem | null;
  agency: AgencyConvergenceDoctorReport;
  world: WorldModelDoctorReport;
  providerStatus: string;
}): CognitiveWorkspaceStatus {
  if (input.agency.latestRun?.mode === 'shadow') return 'shadow';
  if (input.action?.approvalRequired) return 'approval_required';
  if (
    input.providerStatus === 'blocked' ||
    input.agency.latestRun?.status === 'blocked'
  ) {
    return 'blocked';
  }
  if (
    input.action?.kind === 'complete_manual_proof' ||
    input.world.verificationNeeds.length > 0
  ) {
    return 'needs_verification';
  }
  return 'ready';
}

function loadStoredReport(
  packetId: string,
  generatedAt: string,
): CognitiveWorkspaceDoctorReport | null {
  const packet = isDatabaseInitialized()
    ? getCognitiveWorkspacePacket(packetId) || null
    : null;
  if (!packet) return null;
  const contextBlocks = listCognitiveWorkspaceContextBlocks({
    packetId,
    limit: 100,
  });
  const programRuns = listCognitiveProgramRuns({ packetId, limit: 20 });
  const programManifests = listCognitiveProgramManifests({ limit: 50 });
  const policyVariants = listCognitivePolicyVariants({ limit: 50 });
  const optimizationScorecards = listCognitiveOptimizationScorecards({
    packetId,
    limit: 20,
  });
  const improvementProposals = listCognitiveImprovementProposals({ limit: 50 });
  return {
    generatedAt,
    ok: packet.status !== 'blocked',
    packet,
    contextBlocks,
    programManifests,
    programRuns,
    policyVariants,
    optimizationScorecards,
    improvementProposals,
    goalStack: parseJsonObject<CognitiveGoalStack>(packet.goalStackJson),
    contextBudget: parseJsonObject<CognitiveContextBudget>(
      packet.contextBudgetJson,
    ),
    sourceRefs: COGNITIVE_WORKSPACE_SOURCE_REFS,
    nextAction: packet.nextSafeAction,
    privacy: runtimePrivacyReport(),
  };
}

function parseJsonObject<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function persistWorkspace(input: {
  persist: boolean;
  packet: CognitiveWorkspacePacket;
  blocks: CognitiveWorkspaceContextBlock[];
  program: CognitiveProgramManifest;
  programRun: CognitiveProgramRun;
  variant: CognitivePolicyVariant;
  proposal: CognitiveImprovementProposal;
  scorecard: CognitiveOptimizationScorecard;
}): void {
  if (!input.persist || !isDatabaseInitialized()) return;
  upsertCognitiveProgramManifest(input.program);
  upsertCognitivePolicyVariant(input.variant);
  upsertCognitiveImprovementProposal(input.proposal);
  upsertCognitiveWorkspacePacket(input.packet);
  for (const block of input.blocks) upsertCognitiveWorkspaceContextBlock(block);
  upsertCognitiveProgramRun(input.programRun);
  upsertCognitiveOptimizationScorecard(input.scorecard);
}

export async function buildCognitiveWorkspaceReport(
  input: BuildCognitiveWorkspaceInput = {},
): Promise<CognitiveWorkspaceDoctorReport> {
  const generatedAt = input.generatedAt || nowIso();
  if (input.packetId) {
    const stored = loadStoredReport(input.packetId, generatedAt);
    if (stored) return stored;
  }
  const persist = input.persist !== false;
  const session = buildSessionGraphReport({ generatedAt, persist });
  const agency = input.executeAgencyLoop
    ? await runAgencyConvergenceLoop({
        generatedAt,
        intentText: input.intentText,
        liveProviderProbe: false,
        persist,
      })
    : buildAgencyConvergenceDoctorReport({
        generatedAt,
        sessionGraph: session,
      });
  const runtime =
    agency.runtimeReport ||
    (agency.latestRun?.runtimeRunId
      ? buildAgentRuntimeSpineReport({
          runtimeRunId: agency.latestRun.runtimeRunId,
          generatedAt,
        })
      : null);
  const agentOS = buildAgentOSReport({
    episodeId:
      runtime?.latestRun?.agentOSEpisodeId ||
      agency.latestRun?.cognitiveRunId ||
      null,
    generatedAt,
  });
  const logic = buildLogicKernelReport({ generatedAt });
  const truth = buildTruthEngineReport({ generatedAt });
  const world = buildWorldModelReport({ generatedAt, persist });
  const harness = input.optimize
    ? runRhoHarnessReplay({ generatedAt })
    : buildHarnessLabReport({ generatedAt, ensureSeeded: false });
  const action = firstAction(session);
  const providerStatus = agency.providerPlans[0]?.status || 'unknown';
  const evidenceIds = reportEvidenceIds({
    session,
    world,
    logic,
    truth,
    agency,
    runtime,
  });
  const approvalBlockers = unique([
    ...(action?.approvalRequired ? ['selected_action_requires_approval'] : []),
    ...(action?.kind === 'complete_manual_proof'
      ? ['manual_proof_required']
      : []),
    ...agency.resumePlans
      .filter((plan) => plan.status === 'approval_required')
      .map((plan) => `resume:${plan.resumePlanId}`),
  ]);
  const packetId = hashId(
    'workspace:packet',
    [
      generatedAt,
      session.snapshot.snapshotId,
      agency.latestRun?.convergenceRunId || 'no-agency-run',
      action?.actionId || 'no-action',
    ].join('|'),
  );
  const goalStack = buildGoalStack({
    createdAt: generatedAt,
    action,
    evidenceIds,
    blockers: approvalBlockers,
  });
  const blocks = buildContextBlocks({
    packetId,
    generatedAt,
    session,
    world,
    logic,
    truth,
    agentOS,
    agency,
    runtime,
    harness,
  });
  const contextBudget = buildContextBudget({
    packetId,
    createdAt: generatedAt,
    blocks,
  });
  const program = candidateProgram({
    packetId,
    generatedAt,
    goalStack,
    blocks,
    agentOS,
    harness,
  });
  const programRun = programRunFor({
    packetId,
    generatedAt,
    program,
    evidenceIds,
    approvalBlockers,
  });
  const variant = policyVariantFor({
    generatedAt,
    blocks,
    providerStatus,
  });
  const preScorecardId = hashId('workspace:scorecard', `${packetId}|pending`);
  const proposal = proposalFor({
    generatedAt,
    packetId,
    scorecardId: preScorecardId,
    scorecardStatus: 'warn',
  });
  const scorecard = scoreWorkspace({
    generatedAt,
    packetId,
    proposalId: proposal.improvementProposalId,
    variantId: variant.variantId,
    blocks,
    programRun,
    evidenceIds,
    truth,
    approvalBlockers,
    providerStatus,
  });
  const finalProposal = {
    ...proposal,
    sourceScorecardId: scorecard.scorecardId,
    proposalKind: scorecard.status === 'pass' ? 'program' : 'context_budget',
    expectedScoreDelta: scorecard.status === 'pass' ? 0.04 : 0.08,
    summary:
      scorecard.status === 'pass'
        ? 'Candidate program promotion: retain this workspace route as a shadow program until real-world success confirms it.'
        : 'Candidate context-router improvement: add one more cited block or targeted eval before answering low-evidence tasks.',
  } satisfies CognitiveImprovementProposal;
  const status = statusFor({ action, agency, world, providerStatus });
  const packet: CognitiveWorkspacePacket = {
    packetId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status,
    goalStackJson: safeJson(goalStack, 3200),
    contextBudgetJson: safeJson(contextBudget, 2400),
    sessionSnapshotId: session.snapshot.snapshotId,
    sessionClusterId:
      action?.clusterId || session.cockpit.focuses[0]?.clusterId || null,
    convergenceRunId: agency.latestRun?.convergenceRunId || null,
    worldSnapshotId: world.snapshot.snapshotId,
    runtimeRunId:
      runtime?.latestRun?.runtimeRunId ||
      agency.latestRun?.runtimeRunId ||
      null,
    supervisorRunId:
      runtime?.supervisorReport?.latestRun?.supervisorRunId ||
      agency.latestRun?.supervisorRunId ||
      null,
    agentOSEpisodeId: agentOS.latestEpisode?.episodeId || null,
    cognitiveRunId: agency.latestRun?.cognitiveRunId || null,
    logicBeliefStateId:
      logic.beliefState?.beliefStateId ||
      agency.latestRun?.logicBeliefStateId ||
      null,
    truthAuditId:
      truth.latestAudit?.auditId || agency.latestRun?.truthAuditId || null,
    councilRunId: null,
    providerPlanId: agency.providerPlans[0]?.participationPlanId || null,
    selectedProgramId: program.programId,
    contextBlockIdsJson: safeIdJson(
      blocks.map((block) => block.blockId),
      3200,
    ),
    evidenceIdsJson: safeIdJson(evidenceIds, 3200),
    approvalBlockersJson: safeJson(approvalBlockers, 2400),
    checkpointIdsJson: safeIdJson(
      [
        ...(runtime?.checkpoints.map((checkpoint) => checkpoint.checkpointId) ||
          []),
        ...agency.resumePlans
          .map((plan) => plan.checkpointId || '')
          .filter(Boolean),
      ],
      3200,
    ),
    optimizationScorecardId: scorecard.scorecardId,
    nextSafeAction:
      status === 'approval_required' || status === 'needs_verification'
        ? action?.nextAction || agency.nextAction
        : scorecard.nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  persistWorkspace({
    persist,
    packet,
    blocks,
    program,
    programRun,
    variant,
    proposal: finalProposal,
    scorecard: {
      ...scorecard,
      proposalId: finalProposal.improvementProposalId,
    },
  });
  return {
    generatedAt,
    ok: status !== 'blocked',
    packet,
    contextBlocks: blocks,
    programManifests: [
      program,
      ...listCognitiveProgramManifests({ limit: 20 }).filter(
        (item) => item.programId !== program.programId,
      ),
    ],
    programRuns: [programRun],
    policyVariants: [variant],
    optimizationScorecards: [
      { ...scorecard, proposalId: finalProposal.improvementProposalId },
    ],
    improvementProposals: [finalProposal],
    goalStack,
    contextBudget,
    sourceRefs: COGNITIVE_WORKSPACE_SOURCE_REFS,
    nextAction: packet.nextSafeAction,
    privacy: runtimePrivacyReport(),
  };
}

export function buildStoredCognitiveWorkspaceReport(
  input: { generatedAt?: string; packetId?: string | null } = {},
): CognitiveWorkspaceDoctorReport {
  const generatedAt = input.generatedAt || nowIso();
  const packet =
    (input.packetId
      ? getCognitiveWorkspacePacket(input.packetId)
      : undefined) ||
    listCognitiveWorkspacePackets({ limit: 1 })[0] ||
    null;
  if (!packet) {
    return {
      generatedAt,
      ok: false,
      packet: null,
      contextBlocks: [],
      programManifests: listCognitiveProgramManifests({ limit: 20 }),
      programRuns: [],
      policyVariants: listCognitivePolicyVariants({ limit: 20 }),
      optimizationScorecards: listCognitiveOptimizationScorecards({
        limit: 20,
      }),
      improvementProposals: listCognitiveImprovementProposals({ limit: 20 }),
      goalStack: null,
      contextBudget: null,
      sourceRefs: COGNITIVE_WORKSPACE_SOURCE_REFS,
      nextAction:
        'Run npm run debug:cognitive-workspace -- --json to build the first packet.',
      privacy: runtimePrivacyReport(),
    };
  }
  return (
    loadStoredReport(packet.packetId, generatedAt) || {
      generatedAt,
      ok: false,
      packet,
      contextBlocks: [],
      programManifests: [],
      programRuns: [],
      policyVariants: [],
      optimizationScorecards: [],
      improvementProposals: [],
      goalStack: parseJsonObject<CognitiveGoalStack>(packet.goalStackJson),
      contextBudget: parseJsonObject<CognitiveContextBudget>(
        packet.contextBudgetJson,
      ),
      sourceRefs: COGNITIVE_WORKSPACE_SOURCE_REFS,
      nextAction: packet.nextSafeAction,
      privacy: runtimePrivacyReport(),
    }
  );
}

export function formatCognitiveWorkspaceReport(
  report: CognitiveWorkspaceDoctorReport,
): string {
  const packet = report.packet;
  const selectedProgram = report.programManifests.find(
    (program) => program.programId === packet?.selectedProgramId,
  );
  const scorecard =
    report.optimizationScorecards.find(
      (item) => item.scorecardId === packet?.optimizationScorecardId,
    ) ||
    report.optimizationScorecards[0] ||
    null;
  const included = report.contextBlocks.filter((block) => block.included);
  const withheld = report.contextBlocks.filter((block) => !block.included);
  return redactCouncilText(
    [
      'Cognitive Workspace',
      '',
      `Status: ${packet?.status || 'not_built'}`,
      `Packet: ${packet?.packetId || 'none'}`,
      `Goal: ${report.goalStack?.activeGoal || 'none'}`,
      `Task family: ${report.goalStack?.taskFamily || 'none'}`,
      `Context blocks: ${included.length} included, ${withheld.length} withheld`,
      `Selected program: ${selectedProgram?.programId || 'none'} (${selectedProgram?.status || 'none'})`,
      `Program score: ${selectedProgram?.outcomeScore ?? 'none'}`,
      `Optimization score: ${scorecard?.totalScore ?? 'none'} (${scorecard?.status || 'none'})`,
      `Evidence IDs: ${parseJsonArray(packet?.evidenceIdsJson).length}`,
      `Approval blockers: ${parseJsonArray(packet?.approvalBlockersJson).join(', ') || 'none'}`,
      `Provider plan: ${packet?.providerPlanId || 'none'}`,
      `Runtime: ${packet?.runtimeRunId || 'none'}`,
      `Supervisor: ${packet?.supervisorRunId || 'none'}`,
      `Truth audit: ${packet?.truthAuditId || 'none'}`,
      `Candidate proposals: ${report.improvementProposals.length}`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, provider debates, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    5000,
  );
}

export function buildCognitiveWorkspaceStatusText(): string {
  return formatCognitiveWorkspaceReport(buildStoredCognitiveWorkspaceReport());
}

export function isCognitiveWorkspaceNaturalRequest(text: string): boolean {
  return /\b(cognitive workspace|workspace status|what are you working on|what should you verify next|what'?s most useful now|why did you choose that)\b/i.test(
    text,
  );
}
