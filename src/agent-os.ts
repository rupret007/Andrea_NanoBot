import { createHash } from 'node:crypto';

import {
  beginCognitiveKernelRun,
  buildCognitiveTraceReport,
  type BeginCognitiveKernelInput,
  type CognitiveKernelResult,
} from './cognitive-kernel.js';
import { redactCouncilText } from './council-safety.js';
import {
  buildAgentOSCapabilityDiscoveryReport,
  getAgentOSEpisode,
  getAgentOSPlanArtifact,
  listAgentOSEpisodeSteps,
  listAgentOSEpisodes,
  listAgentOSInterrupts,
  listAgentOSPlanArtifacts,
  listAgentOSResumeTokens,
  listAgentOSRoleHandoffs,
  listAgentOSSkillProposals,
  listAgentOSTaskNodes,
  listAgentOSToolCards,
  listAgentOSTrajectoryEvals,
  listAgentRuntimeSkillManifests,
  listCognitiveProviderCooldowns,
  listCognitiveToolRegistry,
  upsertAgentOSEpisode,
  upsertAgentOSEpisodeStep,
  upsertAgentOSInterrupt,
  upsertAgentOSPlanArtifact,
  upsertAgentOSReplayRun,
  upsertAgentOSResumeToken,
  upsertAgentOSRoleHandoff,
  upsertAgentOSSkillProposal,
  upsertAgentOSTaskNode,
  upsertAgentOSToolCard,
  upsertAgentOSTrajectoryEval,
  upsertAgentRuntimeSkillManifest,
} from './db.js';
import { makeRuntimeSkillManifest } from './agent-runtime-glue.js';
import type {
  AgentOSCapabilityDiscoveryReport,
  AgentOSEpisode,
  AgentOSEpisodeMode,
  AgentOSEpisodeStatus,
  AgentOSEpisodeStep,
  AgentOSInterrupt,
  AgentOSPlanArtifact,
  AgentOSPlanPreview,
  AgentOSReplayReport,
  AgentOSReplayRun,
  AgentOSReport,
  AgentOSResumeToken,
  AgentOSRoleHandoff,
  AgentOSSkillProposal,
  AgentOSTaskDAG,
  AgentOSTaskNode,
  AgentOSToolCard,
  AgentOSTrajectoryEval,
  AgentRuntimeSkillManifest,
  CognitiveApprovalPacket,
  CognitiveCheckpointRecord,
  CognitiveHandoff,
  CognitiveMemoryBlock,
  CognitiveToolApprovalPolicy,
  CognitiveToolRegistryRecord,
  CognitiveWorkbenchRole,
  GovernedToolNode,
  ToolCooldownPolicy,
  ToolEvidenceMapping,
  ToolGuardrailDecision,
} from './types.js';

const SOURCE_REFS = [
  'gbrain@805814451ec9e962ceed1b931b9b512d80f70024:source-attribution/gap-analysis',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:tracing/guardrails/hitl-shapes',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:policy-decision-taxonomy',
  'dspy@a3b1ab79f58b75045a697eff6802ea2a337084e1:metric-driven-optimizer-pattern',
  'langgraph-docs:persistence-interrupt-clean-room-pattern',
  'letta-docs:memory-block-clean-room-pattern',
  'openai-evals:trajectory-eval-clean-room-pattern',
  'openhands-docs:microagent-capability-clean-room-pattern',
];

const STATIC_SCRIPT_CARDS: Array<{
  sourceToolId: string;
  displayName: string;
  capabilityKind: AgentOSToolCard['capabilityKind'];
  policyClass: AgentOSToolCard['policyClass'];
  riskLevel: AgentOSToolCard['riskLevel'];
  approvalPolicy: CognitiveToolApprovalPolicy;
  healthState: AgentOSToolCard['healthState'];
  evidenceProduced: string[];
}> = [
  {
    sourceToolId: 'npm:debug:cognition',
    displayName: 'Cognition Doctor',
    capabilityKind: 'debug_surface',
    policyClass: 'local_lookup',
    riskLevel: 'low',
    approvalPolicy: 'none',
    healthState: 'healthy',
    evidenceProduced: ['cognitive_trace_summary', 'workbench_state'],
  },
  {
    sourceToolId: 'npm:debug:council',
    displayName: 'Council Doctor',
    capabilityKind: 'debug_surface',
    policyClass: 'council',
    riskLevel: 'medium',
    approvalPolicy: 'none',
    healthState: 'healthy',
    evidenceProduced: ['council_quality', 'provider_participation'],
  },
  {
    sourceToolId: 'npm:integrations:status',
    displayName: 'Integrations Status',
    capabilityKind: 'integration',
    policyClass: 'read_only',
    riskLevel: 'low',
    approvalPolicy: 'read_only',
    healthState: 'healthy',
    evidenceProduced: ['integration_blockers', 'live_proof_state'],
  },
  {
    sourceToolId: 'npm:debug:providers',
    displayName: 'Provider Health',
    capabilityKind: 'integration',
    policyClass: 'read_only',
    riskLevel: 'low',
    approvalPolicy: 'read_only',
    healthState: 'healthy',
    evidenceProduced: ['provider_health', 'cooldown_state'],
  },
  {
    sourceToolId: 'bluebubbles:send',
    displayName: 'BlueBubbles Send',
    capabilityKind: 'integration',
    policyClass: 'approval_staged',
    riskLevel: 'high',
    approvalPolicy: 'explicit_approval',
    healthState: 'unknown',
    evidenceProduced: ['approval_packet', 'same_thread_policy'],
  },
  {
    sourceToolId: 'calendar:write',
    displayName: 'Calendar Write',
    capabilityKind: 'integration',
    policyClass: 'approval_staged',
    riskLevel: 'high',
    approvalPolicy: 'explicit_approval',
    healthState: 'unknown',
    evidenceProduced: ['approval_packet', 'calendar_write_policy'],
  },
];

export interface BeginAgentOSEpisodeInput extends BeginCognitiveKernelInput {
  episodeId?: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9:_-]+/g, '_').slice(0, 220);
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function safeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(value ?? null);
    if (json.length <= limit) return redactCouncilText(json, limit);
    return JSON.stringify({
      truncated: true,
      summary: redactCouncilText(json, limit - 80),
    });
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

function privacyReport(): AgentOSReport['privacy'] {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

function policyClassForTool(
  tool: CognitiveToolRegistryRecord,
): AgentOSToolCard['policyClass'] {
  if (tool.approvalPolicy === 'forbidden') return 'forbidden';
  if (tool.approvalPolicy === 'explicit_approval') return 'approval_staged';
  if (tool.toolKind === 'council') return 'council';
  if (tool.approvalPolicy === 'read_only') return 'read_only';
  if (tool.toolKind === 'local_lookup') return 'local_lookup';
  return 'read_only';
}

function capabilityKindForTool(
  tool: CognitiveToolRegistryRecord,
): AgentOSToolCard['capabilityKind'] {
  if (tool.toolKind === 'council') return 'council_mode';
  if (tool.toolKind === 'local_lookup') return 'cognition_tool';
  if (tool.toolKind === 'operator') return 'debug_surface';
  if (tool.toolKind === 'draft' || tool.toolKind === 'approval_gate') {
    return 'integration';
  }
  return 'integration';
}

export function discoverAgentOSToolCards(now = nowIso()): AgentOSToolCard[] {
  const cooldowns = listCognitiveProviderCooldowns({
    status: 'active',
    activeAt: now,
    limit: 25,
  });
  const cooldownJson = safeJson(
    cooldowns.map((cooldown) => ({
      providerId: cooldown.providerId,
      failureClass: cooldown.failureClass,
      cooldownUntil: cooldown.cooldownUntil,
      nextAction: cooldown.nextAction,
    })),
    2400,
  );
  const cognitiveCards = listCognitiveToolRegistry({ limit: 200 }).map(
    (tool): AgentOSToolCard => ({
      toolCardId: sanitizeId(`agentos:tool:${tool.toolId}`),
      createdAt: now,
      updatedAt: now,
      sourceToolId: tool.toolId,
      displayName: tool.displayName,
      capabilityKind: capabilityKindForTool(tool),
      policyClass: policyClassForTool(tool),
      riskLevel: tool.riskLevel,
      approvalPolicy: tool.approvalPolicy,
      healthState: tool.healthState,
      evidenceProducedJson: tool.evidenceProducedJson,
      cooldownJson,
      sourceRefsJson: safeJson(SOURCE_REFS, 2400),
      privacyJson: privacyJson(),
    }),
  );
  const staticCards = STATIC_SCRIPT_CARDS.map(
    (tool): AgentOSToolCard => ({
      toolCardId: sanitizeId(`agentos:tool:${tool.sourceToolId}`),
      createdAt: now,
      updatedAt: now,
      sourceToolId: tool.sourceToolId,
      displayName: tool.displayName,
      capabilityKind: tool.capabilityKind,
      policyClass: tool.policyClass,
      riskLevel: tool.riskLevel,
      approvalPolicy: tool.approvalPolicy,
      healthState: tool.healthState,
      evidenceProducedJson: safeJson(tool.evidenceProduced, 1200),
      cooldownJson,
      sourceRefsJson: safeJson(SOURCE_REFS, 2400),
      privacyJson: privacyJson(),
    }),
  );
  const byId = new Map<string, AgentOSToolCard>();
  for (const card of [...staticCards, ...cognitiveCards]) {
    byId.set(card.toolCardId, card);
  }
  const cards = Array.from(byId.values());
  for (const card of cards) upsertAgentOSToolCard(card);
  return cards;
}

function modeForRun(run: CognitiveKernelResult['run']): AgentOSEpisodeMode {
  if (run.status === 'awaiting_approval') return 'approval_staged_episode';
  if (run.taskFamily === 'operator') return 'operator_episode';
  if (run.cognitiveMode === 'council_verified') {
    return 'council_verified_episode';
  }
  if (run.cognitiveMode === 'read_only_react') return 'read_only_episode';
  return 'quick_episode';
}

function statusForRun(
  run: CognitiveKernelResult['run'],
  approvalPackets: CognitiveApprovalPacket[],
  checkpoints: CognitiveCheckpointRecord[],
): AgentOSEpisodeStatus {
  if (approvalPackets.some((packet) => packet.status === 'staged')) {
    return 'awaiting_approval';
  }
  if (
    checkpoints.some(
      (checkpoint) =>
        checkpoint.status === 'open' && checkpoint.checkpointKind !== 'outcome',
    )
  ) {
    return 'interrupted';
  }
  if (run.status === 'blocked') return 'blocked';
  if (run.status === 'answered' || run.status === 'learned') {
    return 'completed';
  }
  return 'active';
}

function stepStatusFromRunStatus(
  status: CognitiveKernelResult['run']['status'],
): AgentOSEpisodeStep['status'] {
  if (status === 'blocked') return 'blocked';
  if (status === 'awaiting_approval') return 'approval_staged';
  return 'completed';
}

function createEpisodeSteps(input: {
  episode: AgentOSEpisode;
  kernel: CognitiveKernelResult;
  trace: ReturnType<typeof buildCognitiveTraceReport>;
  now: string;
}): AgentOSEpisodeStep[] {
  const steps: AgentOSEpisodeStep[] = [
    {
      stepId: sanitizeId(`agentos:step:${input.episode.episodeId}:001:frame`),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: input.now,
      position: 1,
      stepKind: 'frame',
      actorRole: 'planner',
      status: 'completed',
      summary: `Framed ${input.kernel.run.taskFamily} episode with ${input.kernel.run.cognitiveMode}.`,
      evidenceRefsJson: safeJson([input.kernel.run.runId]),
      governanceDecisionIdsJson: safeJson([]),
      nextAction: 'Use the episode frame to choose safe tools and evidence.',
      privacyJson: privacyJson(),
    },
    {
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:002:tool_discovery`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: input.now,
      position: 2,
      stepKind: 'tool_discovery',
      actorRole: 'planner',
      status: 'completed',
      summary: `Discovered ${listAgentOSToolCards({ limit: 500 }).length} Agent OS tool card(s).`,
      evidenceRefsJson: safeJson(
        listAgentOSToolCards({ limit: 20 }).map((card) => card.toolCardId),
      ),
      governanceDecisionIdsJson: safeJson([]),
      nextAction: 'Prefer healthy read-only cards and stage side effects.',
      privacyJson: privacyJson(),
    },
    {
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:003:memory_compile`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: input.now,
      position: 3,
      stepKind: 'memory_compile',
      actorRole: 'memory_curator',
      status: input.kernel.memoryBlocks.some(
        (block) => block.status === 'blocked',
      )
        ? 'blocked'
        : input.kernel.memoryBlocks.some(
              (block) => block.status === 'conflicted',
            )
          ? 'warn'
          : 'completed',
      summary: `Compiled ${input.kernel.memoryBlocks.length} sanitized memory block(s) for this episode.`,
      evidenceRefsJson: safeJson(
        input.kernel.memoryBlocks.map((block) => block.blockId),
      ),
      governanceDecisionIdsJson: safeJson(
        input.kernel.governanceDecisions.map((decision) => decision.decisionId),
      ),
      nextAction:
        'Use memory block summaries as context; do not persist raw private content.',
      privacyJson: privacyJson(),
    },
  ];
  let position = 4;
  for (const handoff of input.kernel.handoffs) {
    steps.push({
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:${String(position).padStart(3, '0')}:handoff:${handoff.handoffId}`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: handoff.createdAt,
      position,
      stepKind: 'handoff',
      actorRole: handoff.toRole,
      status:
        handoff.status === 'blocked'
          ? 'blocked'
          : handoff.status === 'skipped'
            ? 'warn'
            : 'completed',
      summary: `${handoff.fromRole} -> ${handoff.toRole}: ${handoff.reason}`,
      evidenceRefsJson: handoff.evidenceRefsJson,
      governanceDecisionIdsJson: safeJson(
        handoff.governanceDecisionId ? [handoff.governanceDecisionId] : [],
      ),
      nextAction: handoff.nextAction,
      privacyJson: privacyJson(),
    });
    position += 1;
  }
  for (const executionStep of input.trace.replayPacket.executionSteps) {
    steps.push({
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:${String(position).padStart(3, '0')}:tool:${executionStep.stepId}`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: executionStep.createdAt,
      position,
      stepKind: 'tool_step',
      actorRole: 'executor',
      status:
        executionStep.status === 'blocked' || executionStep.status === 'failed'
          ? 'blocked'
          : executionStep.status === 'approval_staged'
            ? 'approval_staged'
            : executionStep.status === 'degraded' ||
                executionStep.status === 'skipped'
              ? 'warn'
              : 'completed',
      summary: `${executionStep.toolId}: ${executionStep.status}`,
      evidenceRefsJson: safeJson(
        input.trace.replayPacket.evidenceArtifacts
          .filter((artifact) => artifact.toolId === executionStep.toolId)
          .map((artifact) => artifact.artifactId),
      ),
      governanceDecisionIdsJson: safeJson(
        input.trace.replayPacket.governanceDecisions
          .filter((decision) => decision.toolId === executionStep.toolId)
          .map((decision) => decision.decisionId),
      ),
      nextAction: executionStep.nextAction,
      privacyJson: privacyJson(),
    });
    position += 1;
  }
  if (input.kernel.run.councilRunId) {
    steps.push({
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:${String(position).padStart(3, '0')}:council`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: input.now,
      position,
      stepKind: 'council',
      actorRole: 'verifier',
      status: 'completed',
      summary: `Linked council run ${input.kernel.run.councilRunId}.`,
      evidenceRefsJson: safeJson([input.kernel.run.councilRunId]),
      governanceDecisionIdsJson: safeJson([]),
      nextAction:
        'Use council verdict as verifier evidence, not as authority to bypass approvals.',
      privacyJson: privacyJson(),
    });
    position += 1;
  }
  for (const interrupt of listAgentOSInterrupts({
    episodeId: input.episode.episodeId,
    limit: 20,
  })) {
    steps.push({
      stepId: sanitizeId(
        `agentos:step:${input.episode.episodeId}:${String(position).padStart(3, '0')}:interrupt:${interrupt.interruptId}`,
      ),
      episodeId: input.episode.episodeId,
      runId: input.kernel.run.runId,
      createdAt: interrupt.createdAt,
      position,
      stepKind: 'interrupt',
      actorRole: 'final_arbiter',
      status:
        interrupt.interruptKind === 'approval_required'
          ? 'approval_staged'
          : 'blocked',
      summary: `${interrupt.interruptKind}: ${interrupt.status}`,
      evidenceRefsJson: safeJson([interrupt.interruptId]),
      governanceDecisionIdsJson: safeJson([]),
      nextAction: interrupt.nextAction,
      privacyJson: privacyJson(),
    });
    position += 1;
  }
  steps.push({
    stepId: sanitizeId(
      `agentos:step:${input.episode.episodeId}:${String(position).padStart(3, '0')}:outcome`,
    ),
    episodeId: input.episode.episodeId,
    runId: input.kernel.run.runId,
    createdAt: input.now,
    position,
    stepKind: 'outcome',
    actorRole: 'final_arbiter',
    status: stepStatusFromRunStatus(input.kernel.run.status),
    summary: `Episode outcome is ${input.episode.status}; run score ${input.kernel.run.outcomeScore.toFixed(2)}.`,
    evidenceRefsJson: safeJson([input.kernel.run.runId]),
    governanceDecisionIdsJson: safeJson(
      input.kernel.governanceDecisions.map((decision) => decision.decisionId),
    ),
    nextAction: input.episode.nextAction,
    privacyJson: privacyJson(),
  });
  return steps;
}

function createRoleHandoffs(input: {
  episode: AgentOSEpisode;
  handoffs: CognitiveHandoff[];
  now: string;
}): AgentOSRoleHandoff[] {
  return input.handoffs.map(
    (handoff): AgentOSRoleHandoff => ({
      handoffId: sanitizeId(
        `agentos:${input.episode.episodeId}:${handoff.handoffId}`,
      ),
      episodeId: input.episode.episodeId,
      runId: handoff.runId,
      createdAt: handoff.createdAt || input.now,
      fromRole: handoff.fromRole,
      toRole: handoff.toRole,
      status: handoff.status,
      reason: handoff.reason,
      evidenceRefsJson: handoff.evidenceRefsJson,
      governanceDecisionIdsJson: safeJson(
        handoff.governanceDecisionId ? [handoff.governanceDecisionId] : [],
      ),
      nextAction: handoff.nextAction,
      privacyJson: privacyJson(),
    }),
  );
}

function buildInterrupt(input: {
  episode: AgentOSEpisode;
  approvalPackets: CognitiveApprovalPacket[];
  checkpoints: CognitiveCheckpointRecord[];
  providerCooldowns: string[];
  now: string;
}): { interrupt: AgentOSInterrupt; token: AgentOSResumeToken } | null {
  const approval = input.approvalPackets.find(
    (packet) => packet.status === 'staged',
  );
  const checkpoint =
    input.checkpoints.find((item) => item.status === 'open') || null;
  const kind: AgentOSInterrupt['interruptKind'] = approval
    ? 'approval_required'
    : checkpoint?.checkpointKind === 'evidence_wait'
      ? 'evidence_gap'
      : input.providerCooldowns.length > 0
        ? 'provider_blocked'
        : checkpoint
          ? 'clarification_required'
          : 'policy_blocked';
  if (!approval && !checkpoint && input.providerCooldowns.length === 0) {
    return null;
  }
  const interruptId = sanitizeId(
    `agentos:interrupt:${input.episode.episodeId}:${kind}`,
  );
  const resumeTokenId = sanitizeId(
    `agentos:resume:${input.episode.episodeId}:${kind}`,
  );
  const continuationKey =
    checkpoint?.continuationKey ||
    approval?.approvalKey ||
    `${input.episode.taskFamily}:${input.episode.episodeId}`;
  const nextAction = approval
    ? 'Wait for explicit same-channel approval before executing the staged side effect.'
    : checkpoint?.nextAction ||
      'Resolve the evidence gap or provider blocker, then resume the episode.';
  const interrupt: AgentOSInterrupt = {
    interruptId,
    episodeId: input.episode.episodeId,
    runId: input.episode.activeRunId || input.episode.rootRunId || null,
    checkpointId: checkpoint?.checkpointId || null,
    createdAt: input.now,
    updatedAt: input.now,
    interruptKind: kind,
    status: 'open',
    payloadJson: safeJson(
      {
        approvalPacketId: approval?.approvalPacketId || null,
        checkpointId: checkpoint?.checkpointId || null,
        providerCooldowns: input.providerCooldowns,
        metadataOnly: true,
      },
      2400,
    ),
    resumeTokenId,
    nextAction,
    privacyJson: privacyJson(),
  };
  const token: AgentOSResumeToken = {
    resumeTokenId,
    episodeId: input.episode.episodeId,
    interruptId,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'active',
    continuationKey,
    safeStateJson: safeJson(
      {
        episodeId: input.episode.episodeId,
        runId: input.episode.activeRunId || input.episode.rootRunId || null,
        checkpointId: checkpoint?.checkpointId || null,
        approvalPacketId: approval?.approvalPacketId || null,
        resumePolicy: 'resume_from_checkpoint_without_replaying_side_effects',
      },
      3200,
    ),
    expiresAt: approval?.expiresAt || checkpoint?.expiresAt || null,
    privacyJson: privacyJson(),
  };
  return { interrupt, token };
}

function sourceCoverageFor(input: {
  memoryBlocks: CognitiveMemoryBlock[];
  evidenceIds: string[];
  toolCardIds: string[];
}): {
  score: number;
  detail: Record<string, unknown>;
} {
  const sourceIds = new Set<string>();
  for (const block of input.memoryBlocks) {
    for (const sourceId of parseJsonArray(block.sourceIdsJson)) {
      sourceIds.add(sourceId);
    }
  }
  for (const evidenceId of input.evidenceIds) sourceIds.add(evidenceId);
  for (const toolCardId of input.toolCardIds.slice(0, 8)) {
    sourceIds.add(toolCardId);
  }
  const conflictCount = input.memoryBlocks.filter(
    (block) => block.status === 'conflicted' || block.status === 'blocked',
  ).length;
  const score = Math.max(
    0,
    Math.min(1, sourceIds.size / 8 - conflictCount * 0.08),
  );
  return {
    score,
    detail: {
      sourceIds: Array.from(sourceIds).slice(0, 40),
      sourceIdCount: sourceIds.size,
      conflictCount,
      sourceRefs: SOURCE_REFS,
      gapPolicy:
        'Every factual answer should cite evidence IDs or name the missing evidence gap.',
    },
  };
}

function trajectoryEvalFor(input: {
  episode: AgentOSEpisode;
  trace: ReturnType<typeof buildCognitiveTraceReport>;
  sourceCoverage: number;
  interruptCount: number;
  approvalPacketCount: number;
  now: string;
}): AgentOSTrajectoryEval {
  const trajectory = input.trace.replayPacket.trajectoryScores[0];
  const cognitiveScore = trajectory?.overallScore ?? 0.58;
  const interruptSafety =
    input.interruptCount === 0 ||
    input.episode.status === 'interrupted' ||
    input.episode.status === 'awaiting_approval'
      ? 1
      : 0.7;
  const approvalSafety =
    input.approvalPacketCount > 0 &&
    input.episode.status !== 'awaiting_approval'
      ? 0.4
      : 1;
  const toolUsefulness =
    input.trace.executedStepCount > 0
      ? Math.min(
          1,
          input.trace.evidenceArtifactCount / input.trace.executedStepCount,
        )
      : 0.55;
  const verificationStrength =
    input.trace.replayPacket.stepVerifications.length > 0 ? 0.86 : 0.58;
  const privacySafety =
    input.trace.replayPacket.privacy.rawPromptsStored === false &&
    input.trace.replayPacket.privacy.rawPrivateBodiesStored === false
      ? 1
      : 0;
  const overallScore = Number(
    (
      (cognitiveScore +
        input.sourceCoverage +
        interruptSafety +
        approvalSafety +
        toolUsefulness +
        verificationStrength +
        privacySafety) /
      7
    ).toFixed(3),
  );
  const status: AgentOSTrajectoryEval['status'] =
    overallScore >= 0.78 ? 'pass' : overallScore >= 0.55 ? 'warn' : 'fail';
  const demotionSignals: string[] = [];
  if (input.sourceCoverage < 0.55) demotionSignals.push('weak_source_coverage');
  if (approvalSafety < 1) demotionSignals.push('approval_state_mismatch');
  if (privacySafety < 1) demotionSignals.push('privacy_policy_failure');
  if (input.trace.executionStatus === 'block') {
    demotionSignals.push('blocked_execution');
  }
  return {
    evalId: sanitizeId(`agentos:eval:${input.episode.episodeId}`),
    episodeId: input.episode.episodeId,
    runId: input.episode.activeRunId || input.episode.rootRunId || null,
    createdAt: input.now,
    status,
    overallScore,
    sourceCoverage: input.sourceCoverage,
    interruptSafety,
    approvalSafety,
    toolUsefulness,
    verificationStrength,
    privacySafety,
    promotionEligible:
      status === 'pass' &&
      input.episode.status === 'completed' &&
      input.approvalPacketCount === 0,
    demotionSignalsJson: safeJson(demotionSignals, 1200),
    nextAction:
      status === 'pass'
        ? 'Retain this episode as a candidate task pattern after user-confirmed success.'
        : 'Repair source coverage, blocked tools, or approval state before promoting a skill.',
    privacyJson: privacyJson(),
  };
}

function skillProposalFor(input: {
  episode: AgentOSEpisode;
  evalRecord: AgentOSTrajectoryEval;
  toolCards: AgentOSToolCard[];
  now: string;
}): AgentOSSkillProposal | null {
  if (!input.evalRecord.promotionEligible) return null;
  const safeTools = input.toolCards
    .filter(
      (card) =>
        card.policyClass === 'local_lookup' ||
        card.policyClass === 'read_only' ||
        card.policyClass === 'council',
    )
    .slice(0, 8);
  return {
    proposalId: sanitizeId(`agentos:skill:${input.episode.episodeId}`),
    episodeId: input.episode.episodeId,
    createdAt: input.now,
    updatedAt: input.now,
    status: 'candidate',
    taskFamily: input.episode.taskFamily,
    triggerSummary: `Similar ${input.episode.taskFamily} goal with verified read-only evidence and no unresolved approvals.`,
    skillSummary: `Reusable Agent OS episode pattern for ${input.episode.taskFamily}; requires cited evidence and final verifier pass.`,
    requiredToolCardIdsJson: safeJson(
      safeTools.map((card) => card.toolCardId),
      1200,
    ),
    evidenceNeedsJson: safeJson(
      ['source_coverage>=0.55', 'verification_strength>=0.75'],
      1200,
    ),
    approvalRulesJson: safeJson(
      ['mutating_actions_remain_approval_staged', 'no_auto_send'],
      1200,
    ),
    verificationChecklistJson: safeJson(
      [
        'episode_has_steps',
        'source_ids_present',
        'privacy_metadata_only',
        'no_blocked_governance_decision',
      ],
      1600,
    ),
    outcomeScore: input.evalRecord.overallScore,
    sourceEpisodeIdsJson: safeJson([input.episode.episodeId], 1200),
    nextAction:
      'Wait for verified success or explicit user confirmation before promotion.',
    privacyJson: privacyJson(),
  };
}

function runtimeSkillManifestForProposal(input: {
  proposal: AgentOSSkillProposal;
  toolCards: AgentOSToolCard[];
  now: string;
}): AgentRuntimeSkillManifest {
  const requiredToolCardIds = parseJsonArray(
    input.proposal.requiredToolCardIdsJson,
  );
  const requiredCards = input.toolCards.filter((card) =>
    requiredToolCardIds.includes(card.toolCardId),
  );
  const approvalRules = parseJsonArray(input.proposal.approvalRulesJson);
  const evidenceNeeds = parseJsonArray(input.proposal.evidenceNeedsJson);
  const mutatingCardPresent = requiredCards.some(
    (card) =>
      card.policyClass === 'approval_staged' ||
      card.approvalPolicy === 'explicit_approval' ||
      card.riskLevel === 'high',
  );
  return makeRuntimeSkillManifest({
    generatedAt: input.now,
    skillId: `agent_os.${input.proposal.taskFamily}.episode_pattern`,
    sourceKind: 'runtime',
    frontmatter: {
      sourceProposalId: input.proposal.proposalId,
      sourceEpisodeIds: parseJsonArray(input.proposal.sourceEpisodeIdsJson),
      safetyClass: mutatingCardPresent ? 'approval_gated_write' : 'read_only',
      promotionState: input.proposal.status,
      outcomeScore: input.proposal.outcomeScore,
      marketplaceReady: false,
    },
    trigger: {
      taskFamily: input.proposal.taskFamily,
      summary: input.proposal.triggerSummary,
    },
    toolRefs: requiredCards.map((card) => card.sourceToolId),
    approvalRules: [
      ...approvalRules,
      'Runtime candidate manifests do not grant new permissions.',
      'Promotion requires explicit confirmation after verified success.',
    ],
    evidenceNeeds: [
      ...evidenceNeeds,
      'Agent OS replay remains metadata-only.',
      'Action preflight must pass before any mutating step.',
    ],
    summary: input.proposal.skillSummary,
  });
}

function taskFamilyForGoal(goal: string): string {
  const normalized = goal.toLowerCase();
  if (/calendar|meeting|schedule|tomorrow|today/.test(normalized))
    return 'calendar';
  if (/bluebubbles|message|text|reply|thread|send/.test(normalized)) {
    return 'communication';
  }
  if (
    /provider|integration|diagnostic|service|status|operator|logs?/.test(
      normalized,
    )
  ) {
    return 'operator';
  }
  if (/research|search|source|evidence|lookup|web/.test(normalized))
    return 'research';
  if (/memory|remember|forget|preference|belief/.test(normalized))
    return 'memory';
  if (/plan|goal|steps|project/.test(normalized)) return 'planning';
  return 'general';
}

function goalNeedsApproval(goal: string): boolean {
  return /\b(send|delete|remove|buy|purchase|order|commit|push|restart|stop service|change service|create event|schedule it|write calendar|cancel)\b/i.test(
    goal,
  );
}

function toolCardsForPlan(
  goal: string,
  cards: AgentOSToolCard[],
): AgentOSToolCard[] {
  const normalized = goal.toLowerCase();
  const desired = new Set<string>();
  desired.add('npm:debug:cognition');
  desired.add('npm:integrations:status');
  desired.add('npm:debug:providers');
  if (/council|verify|think|ultra|hard/.test(normalized)) {
    desired.add('npm:debug:council');
  }
  if (/message|text|bluebubbles|send/.test(normalized)) {
    desired.add('bluebubbles:send');
  }
  if (/calendar|schedule|meeting/.test(normalized)) {
    desired.add('calendar:write');
  }
  return cards
    .filter(
      (card) =>
        desired.has(card.sourceToolId) ||
        (card.policyClass === 'read_only' && card.healthState !== 'blocked'),
    )
    .slice(0, 10);
}

function guardrailDecisionForNode(input: {
  node: AgentOSTaskNode;
  now: string;
}): ToolGuardrailDecision {
  const status: ToolGuardrailDecision['status'] = input.node.approvalRequired
    ? 'approval_required'
    : input.node.policyClass === 'forbidden'
      ? 'blocked'
      : 'pass';
  return {
    decisionId: sanitizeId(`agentos:guardrail:${input.node.nodeId}`),
    nodeId: input.node.nodeId,
    allowed: status === 'pass',
    status,
    riskFlagsJson: safeJson(
      [
        ...(input.node.approvalRequired ? ['approval_required'] : []),
        ...(input.node.policyClass === 'forbidden' ? ['forbidden_tool'] : []),
      ],
      1200,
    ),
    reason:
      status === 'pass'
        ? 'Read-only or local node passes deterministic policy.'
        : status === 'approval_required'
          ? 'Node touches a side-effectful action and must be staged.'
          : 'Node is forbidden by policy.',
    nextAction:
      status === 'pass'
        ? 'Execute or replay the read-only node under budget.'
        : 'Create an approval packet or blocker; do not execute side effects.',
    privacyJson: privacyJson(),
  };
}

function buildPlanNodes(input: {
  planId: string;
  goal: string;
  taskFamily: string;
  toolCards: AgentOSToolCard[];
  now: string;
}): AgentOSTaskNode[] {
  const approvalRequired = goalNeedsApproval(input.goal);
  const readOnlyToolCardIds = input.toolCards
    .filter(
      (card) =>
        card.policyClass === 'read_only' ||
        card.policyClass === 'local_lookup' ||
        card.policyClass === 'council',
    )
    .map((card) => card.toolCardId)
    .slice(0, 8);
  const approvalToolCardIds = input.toolCards
    .filter((card) => card.policyClass === 'approval_staged')
    .map((card) => card.toolCardId)
    .slice(0, 4);
  const base = `agentos:node:${input.planId}`;
  const node = (
    suffix: string,
    position: number,
    nodeKind: AgentOSTaskNode['nodeKind'],
    role: CognitiveWorkbenchRole,
    policyClass: AgentOSTaskNode['policyClass'],
    dependsOn: string[],
    requiredEvidence: string[],
    stopCondition: string,
    toolCardIds: string[],
    nextAction: string,
    options: { approval?: boolean; parallel?: boolean } = {},
  ): AgentOSTaskNode => ({
    nodeId: sanitizeId(`${base}:${suffix}`),
    planId: input.planId,
    position,
    nodeKind,
    role,
    status: options.approval ? 'approval_staged' : 'planned',
    policyClass,
    approvalRequired: options.approval === true,
    canRunInParallel: options.parallel === true,
    dependsOnNodeIdsJson: safeJson(dependsOn, 1200),
    requiredEvidenceJson: safeJson(requiredEvidence, 1600),
    stopCondition,
    toolCardIdsJson: safeJson(toolCardIds, 1600),
    guardrailJson: safeJson(
      {
        prePolicy: policyClass,
        timeoutMs: policyClass === 'council' ? 90000 : 30000,
        outputRedaction: 'metadata_only',
        approvalBehavior: options.approval
          ? 'stage_approval'
          : 'execute_read_only',
      },
      2000,
    ),
    outputEvidenceIdsJson: safeJson(
      [`agentos:evidence:${input.planId}:${suffix}`],
      1200,
    ),
    nextAction,
    privacyJson: privacyJson(),
  });
  const planner = node(
    'planner',
    1,
    'planner',
    'planner',
    'local_lookup',
    [],
    ['goal_summary', 'task_family'],
    'Goal is classified and safety policy is known.',
    [],
    'Pass the deterministic DAG to evidence and memory nodes.',
  );
  const memory = node(
    'memory_curator',
    2,
    'memory_curator',
    'memory_curator',
    'local_lookup',
    [planner.nodeId],
    ['profile_rules', 'skill_cards', 'belief_state'],
    'Relevant memory blocks are summarized and source-attributed.',
    readOnlyToolCardIds.filter((id) => /cognition|memory/i.test(id)),
    'Compile local-first memory blocks before external evidence.',
    { parallel: true },
  );
  const scout = node(
    'evidence_scout',
    3,
    'evidence_scout',
    'evidence_scout',
    'read_only',
    [planner.nodeId],
    ['integration_status', 'provider_health', 'source_coverage'],
    'Required read-only evidence has IDs or an explicit gap.',
    readOnlyToolCardIds,
    'Run bounded read-only evidence checks only.',
    { parallel: true },
  );
  const executor = node(
    'tool_executor',
    4,
    'tool_executor',
    'executor',
    approvalRequired ? 'approval_staged' : 'read_only',
    [memory.nodeId, scout.nodeId],
    ['tool_result_summary', 'guardrail_decision'],
    approvalRequired
      ? 'Side effect is represented as an approval packet, not executed.'
      : 'Read-only tool outputs are mapped into evidence artifacts.',
    approvalRequired ? approvalToolCardIds : readOnlyToolCardIds,
    approvalRequired
      ? 'Stage approval and wait for explicit resume.'
      : 'Map read-only tool summaries into evidence IDs.',
    { approval: approvalRequired },
  );
  const verifier = node(
    'verifier',
    5,
    'verifier',
    'verifier',
    'council',
    [executor.nodeId],
    ['evidence_ids', 'policy_decisions'],
    'Verifier confirms evidence sufficiency or names the repair gap.',
    readOnlyToolCardIds.filter((id) => /council/i.test(id)),
    'Verify the answer route without overriding approval gates.',
  );
  const approval = approvalRequired
    ? [
        node(
          'approval_stager',
          6,
          'approval_stager',
          'final_arbiter',
          'approval_staged',
          [verifier.nodeId],
          ['approval_packet', 'resume_token'],
          'Approval packet is staged and no side effect has run.',
          approvalToolCardIds,
          'Ask for explicit approval or wait for resume.',
          { approval: true },
        ),
      ]
    : [];
  const arbiterPosition = approvalRequired ? 7 : 6;
  const arbiter = node(
    'arbiter',
    arbiterPosition,
    'arbiter',
    'final_arbiter',
    'local_lookup',
    [approvalRequired ? approval[0].nodeId : verifier.nodeId],
    ['final_decision', 'next_safe_action'],
    'Final response is evidence-backed and approval-safe.',
    [],
    'Answer, clarify, or present the approval checkpoint.',
  );
  return [planner, memory, scout, executor, verifier, ...approval, arbiter];
}

function dagForNodes(input: {
  planId: string;
  taskFamily: string;
  nodes: AgentOSTaskNode[];
  now: string;
}): AgentOSTaskDAG {
  const edges = input.nodes.flatMap((node) =>
    parseJsonArray(node.dependsOnNodeIdsJson).map(
      (dependsOn) => `${dependsOn}->${node.nodeId}`,
    ),
  );
  return {
    dagId: sanitizeId(`agentos:dag:${input.planId}`),
    planId: input.planId,
    createdAt: input.now,
    taskFamily: input.taskFamily,
    status: 'planned',
    nodeIdsJson: safeJson(
      input.nodes.map((node) => node.nodeId),
      2400,
    ),
    edgeIdsJson: safeJson(edges, 2400),
    parallelGroupIdsJson: safeJson(
      input.nodes
        .filter((node) => node.canRunInParallel)
        .map((node) => node.nodeId),
      1200,
    ),
    approvalNodeIdsJson: safeJson(
      input.nodes
        .filter((node) => node.approvalRequired)
        .map((node) => node.nodeId),
      1200,
    ),
    evidenceContractJson: safeJson(
      input.nodes.map((node) => ({
        nodeId: node.nodeId,
        requiredEvidence: parseJsonArray(node.requiredEvidenceJson),
        stopCondition: node.stopCondition,
      })),
      3200,
    ),
    nextAction:
      'Replay the saved DAG or execute safe read-only nodes under governance.',
    privacyJson: privacyJson(),
  };
}

export function buildAgentOSPlanArtifact(input: {
  goal: string;
  generatedAt?: string;
  planOnly?: boolean;
}): AgentOSPlanPreview {
  const now = input.generatedAt || nowIso();
  const goal = redactCouncilText(
    input.goal || 'Inspect current Andrea task state.',
    640,
  );
  const taskFamily = taskFamilyForGoal(goal);
  const planId = sanitizeId(hashId('agentos:plan', `${taskFamily}|${goal}`));
  const toolCards = toolCardsForPlan(goal, discoverAgentOSToolCards(now));
  const nodes = buildPlanNodes({
    planId,
    goal,
    taskFamily,
    toolCards,
    now,
  });
  const dag = dagForNodes({ planId, taskFamily, nodes, now });
  const guardrailDecisions = nodes.map((node) =>
    guardrailDecisionForNode({ node, now }),
  );
  const evidenceMappings: ToolEvidenceMapping[] = nodes.map((node) => ({
    mappingId: sanitizeId(`agentos:mapping:${node.nodeId}`),
    nodeId: node.nodeId,
    evidenceIdsJson: node.outputEvidenceIdsJson,
    sourceClassesJson: safeJson(
      parseJsonArray(node.requiredEvidenceJson),
      1200,
    ),
    freshness: 'fresh',
    summary: `Node ${node.nodeKind} maps redacted outputs to evidence IDs only.`,
    privacyJson: privacyJson(),
  }));
  const governedToolNodes: GovernedToolNode[] = nodes
    .filter((node) => parseJsonArray(node.toolCardIdsJson).length > 0)
    .map((node) => {
      const guardrail = parseJsonObject(node.guardrailJson);
      return {
        nodeId: node.nodeId,
        toolCardId:
          parseJsonArray(node.toolCardIdsJson)[0] || 'agentos:tool:none',
        policyClass: node.policyClass,
        prePolicy: String(guardrail.prePolicy || node.policyClass),
        postPolicy: node.approvalRequired
          ? 'stage_approval_packet'
          : 'map_redacted_evidence',
        timeoutMs:
          typeof guardrail.timeoutMs === 'number' ? guardrail.timeoutMs : 30000,
        outputRedaction: 'metadata_only',
        retryPolicy:
          node.policyClass === 'approval_staged' ? 'none' : 'cooldown_skip',
        approvalBehavior: node.approvalRequired
          ? 'stage_approval'
          : node.policyClass === 'forbidden'
            ? 'fail_closed'
            : 'execute_read_only',
      };
    });
  const cooldownPolicies: ToolCooldownPolicy[] = toolCards.map((card) => ({
    policyId: sanitizeId(`agentos:cooldown:${planId}:${card.toolCardId}`),
    toolCardId: card.toolCardId,
    failureClassesJson: safeJson(
      ['auth', 'quota', 'rate_limit', 'unreachable'],
      1200,
    ),
    cooldownMs:
      card.healthState === 'blocked' ? 60 * 60 * 1000 : 10 * 60 * 1000,
    skipWhenActive: true,
    nextAction:
      card.healthState === 'blocked'
        ? 'Skip this optional tool until cooldown or credentials recover.'
        : 'Use this tool only if policy passes and no active cooldown exists.',
    privacyJson: privacyJson(),
  }));
  const approvalRequired = nodes.some((node) => node.approvalRequired);
  const plan: AgentOSPlanArtifact = {
    planId,
    createdAt: now,
    updatedAt: now,
    goal,
    taskFamily,
    status: 'replay_ready',
    planOnly: input.planOnly !== false,
    dagJson: safeJson(dag, 6400),
    nodeIdsJson: safeJson(
      nodes.map((node) => node.nodeId),
      2400,
    ),
    governedToolNodesJson: safeJson(governedToolNodes, 6400),
    guardrailDecisionsJson: safeJson(guardrailDecisions, 6400),
    evidenceMappingsJson: safeJson(evidenceMappings, 6400),
    cooldownPoliciesJson: safeJson(cooldownPolicies, 3200),
    approvalPacketJson: safeJson(
      approvalRequired
        ? {
            status: 'staged',
            reason:
              'Goal includes side-effectful action; replay cannot execute it.',
            resumeToken: sanitizeId(`agentos:resume:${planId}:approval`),
          }
        : null,
      2400,
    ),
    sourcePatternRefsJson: safeJson(
      [
        'open-multi-agent@7eb3e708d329505ea17b3e037f22fca07310ec67:goal-to-dag-clean-room',
        'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:guardrail-shape',
        'microsoft-agt@e0183314fa0fbaa91a92389d97fb45ac99f03be7:policy-decision-shape',
        'langgraph-docs:persistence-replay-clean-room',
      ],
      2400,
    ),
    nextAction: approvalRequired
      ? 'Review the saved plan; replay will stage approval instead of executing side effects.'
      : 'Replay the saved plan to run safe read-only checks without replanning.',
    privacyJson: privacyJson(),
  };
  upsertAgentOSPlanArtifact(plan);
  for (const node of nodes) upsertAgentOSTaskNode(node);
  return {
    generatedAt: now,
    plan,
    dag,
    nodes,
    governedToolNodes,
    guardrailDecisions,
    evidenceMappings,
    cooldownPolicies,
    approvalRequired,
    executableReadOnlyNodeCount: nodes.filter(
      (node) => !node.approvalRequired && node.policyClass !== 'forbidden',
    ).length,
    nextAction: plan.nextAction,
    privacy: privacyReport(),
  };
}

export function previewAgentOSPlan(input: {
  goal: string;
  generatedAt?: string;
}): AgentOSPlanPreview {
  return buildAgentOSPlanArtifact({
    goal: input.goal,
    generatedAt: input.generatedAt,
    planOnly: true,
  });
}

export function replayAgentOSPlan(input: {
  planId: string;
  generatedAt?: string;
}): AgentOSReplayReport {
  const now = input.generatedAt || nowIso();
  const plan =
    getAgentOSPlanArtifact(input.planId) ||
    listAgentOSPlanArtifacts({ limit: 1 })[0];
  if (!plan) {
    throw new Error('No Agent OS plan artifact is available to replay.');
  }
  const nodes = listAgentOSTaskNodes({ planId: plan.planId, limit: 200 });
  const approvalRequired = nodes.some((node) => node.approvalRequired);
  const replayedNodes = nodes.filter(
    (node) => !node.approvalRequired && node.policyClass !== 'forbidden',
  );
  const evidenceIds = Array.from(
    new Set(
      replayedNodes.flatMap((node) =>
        parseJsonArray(node.outputEvidenceIdsJson),
      ),
    ),
  );
  const guardrailDecisionIds = nodes.map((node) =>
    sanitizeId(`agentos:guardrail:${node.nodeId}`),
  );
  const replay: AgentOSReplayRun = {
    replayId: sanitizeId(
      `agentos:replay:${plan.planId}:${Date.now().toString(36)}`,
    ),
    planId: plan.planId,
    createdAt: now,
    status: approvalRequired ? 'approval_staged' : 'replayed',
    replayedNodeIdsJson: safeJson(
      replayedNodes.map((node) => node.nodeId),
      2400,
    ),
    evidenceIdsJson: safeJson(evidenceIds, 2400),
    policyDecisionsJson: safeJson(guardrailDecisionIds, 2400),
    plannerSkipped: true,
    approvalRequired,
    summary: approvalRequired
      ? 'Replay used the saved DAG and staged side-effectful nodes for approval.'
      : 'Replay used the saved DAG and executed only read-only metadata steps.',
    nextAction: approvalRequired
      ? 'Ask for explicit approval with the resume token before any side effect.'
      : 'Use the replay evidence IDs to answer or verify the task.',
    privacyJson: privacyJson(),
  };
  upsertAgentOSReplayRun(replay);
  upsertAgentOSPlanArtifact({
    ...plan,
    updatedAt: now,
    status: 'replayed',
  });
  return {
    generatedAt: now,
    plan,
    replay,
    nodes,
    nextAction: replay.nextAction,
    privacy: privacyReport(),
  };
}

export function formatAgentOSPlanPreview(preview: AgentOSPlanPreview): string {
  return redactCouncilText(
    [
      'Agent OS Plan Preview',
      '',
      `Plan: ${preview.plan.planId}`,
      `Goal: ${preview.plan.goal}`,
      `Task family: ${preview.plan.taskFamily}`,
      `Nodes: ${preview.nodes.length}`,
      `Read-only executable nodes: ${preview.executableReadOnlyNodeCount}`,
      `Approval required: ${preview.approvalRequired ? 'yes' : 'no'}`,
      `Next: ${preview.nextAction}`,
      '',
      'Nodes',
      ...preview.nodes.map(
        (node) =>
          `- ${node.position}. ${node.nodeKind} (${node.policyClass}) -> ${node.stopCondition}`,
      ),
      '',
      'Privacy: metadata-only; replay uses saved graph and does not store raw prompts, private bodies, hidden reasoning, raw tool output, or secrets.',
    ].join('\n'),
    5000,
  );
}

export function formatAgentOSReplayReport(report: AgentOSReplayReport): string {
  return redactCouncilText(
    [
      'Agent OS Plan Replay',
      '',
      `Plan: ${report.plan.planId}`,
      `Replay: ${report.replay.replayId}`,
      `Status: ${report.replay.status}`,
      `Planner skipped: ${report.replay.plannerSkipped ? 'yes' : 'no'}`,
      `Approval required: ${report.replay.approvalRequired ? 'yes' : 'no'}`,
      `Replayed nodes: ${parseJsonArray(report.replay.replayedNodeIdsJson).length}`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only; no side effects are replayed.',
    ].join('\n'),
    4000,
  );
}

export function beginAgentOSEpisode(input: BeginAgentOSEpisodeInput): {
  kernel: CognitiveKernelResult;
  episode: AgentOSEpisode;
  report: AgentOSReport;
} {
  const now = nowIso();
  const kernel = beginCognitiveKernelRun(input);
  const toolCards = discoverAgentOSToolCards(now);
  const trace = buildCognitiveTraceReport({
    runId: kernel.run.runId,
    generatedAt: now,
  });
  const evidenceIds = trace.replayPacket.evidenceArtifacts.map(
    (artifact) => artifact.artifactId,
  );
  const approvalPacketIds = trace.replayPacket.approvalPackets.map(
    (packet) => packet.approvalPacketId,
  );
  const memoryBlockIds = kernel.memoryBlocks.map((block) => block.blockId);
  const sourceCoverage = sourceCoverageFor({
    memoryBlocks: kernel.memoryBlocks,
    evidenceIds,
    toolCardIds: toolCards.map((card) => card.toolCardId),
  });
  const episodeId = sanitizeId(
    input.episodeId || `agentos:episode:${kernel.run.runId}`,
  );
  const episode: AgentOSEpisode = {
    episodeId,
    createdAt: now,
    updatedAt: now,
    groupFolder: kernel.run.groupFolder || input.groupFolder || null,
    channel: kernel.run.channel || input.channel || null,
    rootRunId: kernel.run.runId,
    activeRunId: kernel.run.runId,
    goalSummary: kernel.run.goalSummary,
    taskFamily: kernel.run.taskFamily,
    status: statusForRun(
      kernel.run,
      trace.replayPacket.approvalPackets,
      trace.replayPacket.checkpoints,
    ),
    mode: modeForRun(kernel.run),
    priority:
      kernel.run.status === 'awaiting_approval' ||
      kernel.run.status === 'blocked'
        ? 0.9
        : 0.55,
    linkedRunIdsJson: safeJson([kernel.run.runId], 1200),
    councilRunIdsJson: safeJson(
      kernel.run.councilRunId ? [kernel.run.councilRunId] : [],
      1200,
    ),
    evidenceIdsJson: safeJson(evidenceIds, 2400),
    interruptIdsJson: safeJson([], 1200),
    approvalPacketIdsJson: safeJson(approvalPacketIds, 2400),
    memoryBlockIdsJson: safeJson(memoryBlockIds, 2400),
    trajectoryEvalIdsJson: safeJson([], 1200),
    sourceCoverageJson: safeJson(sourceCoverage.detail, 3200),
    nextAction:
      kernel.run.status === 'awaiting_approval'
        ? 'Resume only after explicit approval; do not replay side effects.'
        : kernel.run.nextAction,
    privacyJson: privacyJson(),
    completedAt:
      kernel.run.status === 'answered' || kernel.run.status === 'learned'
        ? now
        : null,
  };
  upsertAgentOSEpisode(episode);

  const providerCooldownIds = trace.activeCooldownProviderIds;
  const interruptBundle = buildInterrupt({
    episode,
    approvalPackets: trace.replayPacket.approvalPackets,
    checkpoints: trace.replayPacket.checkpoints,
    providerCooldowns: providerCooldownIds,
    now,
  });
  if (interruptBundle) {
    upsertAgentOSInterrupt(interruptBundle.interrupt);
    upsertAgentOSResumeToken(interruptBundle.token);
    episode.interruptIdsJson = safeJson([
      interruptBundle.interrupt.interruptId,
    ]);
    episode.status =
      interruptBundle.interrupt.interruptKind === 'approval_required'
        ? 'awaiting_approval'
        : 'interrupted';
    episode.nextAction = interruptBundle.interrupt.nextAction;
    upsertAgentOSEpisode(episode);
  }

  const roleHandoffs = createRoleHandoffs({
    episode,
    handoffs: kernel.handoffs,
    now,
  });
  for (const handoff of roleHandoffs) upsertAgentOSRoleHandoff(handoff);

  const steps = createEpisodeSteps({ episode, kernel, trace, now });
  for (const step of steps) upsertAgentOSEpisodeStep(step);

  const evalRecord = trajectoryEvalFor({
    episode,
    trace,
    sourceCoverage: sourceCoverage.score,
    interruptCount: interruptBundle ? 1 : 0,
    approvalPacketCount: approvalPacketIds.length,
    now,
  });
  upsertAgentOSTrajectoryEval(evalRecord);
  episode.trajectoryEvalIdsJson = safeJson([evalRecord.evalId], 1200);
  episode.sourceCoverageJson = safeJson(
    { ...sourceCoverage.detail, score: sourceCoverage.score },
    3200,
  );
  upsertAgentOSEpisode(episode);

  const proposal = skillProposalFor({ episode, evalRecord, toolCards, now });
  if (proposal) {
    upsertAgentOSSkillProposal(proposal);
    upsertAgentRuntimeSkillManifest(
      runtimeSkillManifestForProposal({ proposal, toolCards, now }),
    );
  }

  return {
    kernel,
    episode,
    report: buildAgentOSReport({
      episodeId: episode.episodeId,
      generatedAt: now,
    }),
  };
}

export function buildAgentOSReport(
  params: { episodeId?: string | null; generatedAt?: string } = {},
): AgentOSReport {
  const generatedAt = params.generatedAt || nowIso();
  const latestEpisode =
    (params.episodeId ? getAgentOSEpisode(params.episodeId) : undefined) ||
    listAgentOSEpisodes({ limit: 1 })[0] ||
    null;
  const episodeId = latestEpisode?.episodeId || null;
  const toolCards = listAgentOSToolCards({ limit: 200 });
  const capabilityDiscovery =
    buildAgentOSCapabilityDiscoveryReport({
      generatedAt,
      limit: 200,
    }) ||
    ({
      generatedAt,
      toolCards,
      healthy: 0,
      degraded: 0,
      blocked: 0,
      approvalStaged: 0,
      readOnly: 0,
      sourceCoverage: [],
      nextAction: 'Run tool discovery.',
      privacy: privacyReport(),
    } satisfies AgentOSCapabilityDiscoveryReport);
  const episodeSteps = episodeId
    ? listAgentOSEpisodeSteps({ episodeId, limit: 200 })
    : [];
  const interrupts = episodeId
    ? listAgentOSInterrupts({ episodeId, limit: 50 })
    : [];
  const resumeTokens = episodeId
    ? listAgentOSResumeTokens({ episodeId, limit: 50 })
    : [];
  const handoffs = episodeId
    ? listAgentOSRoleHandoffs({ episodeId, limit: 100 })
    : [];
  const trajectoryEvals = episodeId
    ? listAgentOSTrajectoryEvals({ episodeId, limit: 20 })
    : [];
  const skillProposals = episodeId
    ? listAgentOSSkillProposals({ episodeId, limit: 20 })
    : [];
  const runtimeSkillManifests = listAgentRuntimeSkillManifests({
    status: 'candidate',
    limit: 20,
  });
  const blockingInterrupt = interrupts.find(
    (interrupt) => interrupt.status === 'open',
  );
  const latestEval = trajectoryEvals[0] || null;
  const ok =
    !!latestEpisode &&
    capabilityDiscovery.toolCards.length > 0 &&
    !interrupts.some(
      (interrupt) =>
        interrupt.status === 'open' &&
        interrupt.interruptKind === 'policy_blocked',
    ) &&
    (latestEval?.privacySafety ?? 1) === 1;
  let nextAction =
    'Run a quick ask, one read-only task, and one approval-staged draft to keep Agent OS proof fresh.';
  if (!latestEpisode) {
    nextAction =
      'Run npm run debug:agent-os -- --task-drill --json to seed the first Agent OS episode.';
  } else if (blockingInterrupt) {
    nextAction = blockingInterrupt.nextAction;
  } else if (latestEval?.status === 'fail') {
    nextAction = latestEval.nextAction;
  } else if (
    skillProposals.some((proposal) => proposal.status === 'candidate')
  ) {
    nextAction =
      'Review candidate skill proposals and promote only after verified success or explicit confirmation.';
  } else if (capabilityDiscovery.blocked > 0) {
    nextAction =
      'Review blocked Agent OS tool cards and keep those providers/tools out of optional routes.';
  }
  return {
    generatedAt,
    ok,
    summary: latestEpisode
      ? `Agent OS has episode ${latestEpisode.episodeId} (${latestEpisode.status}) with ${episodeSteps.length} step(s), ${interrupts.length} interrupt(s), and ${toolCards.length} tool card(s).`
      : 'Agent OS is installed but has no recorded episodes yet.',
    latestEpisode,
    episodeSteps,
    interrupts,
    resumeTokens,
    toolCards,
    handoffs,
    trajectoryEvals,
    skillProposals,
    runtimeSkillManifests,
    capabilityDiscovery,
    nextAction,
    privacy: privacyReport(),
  };
}

export function formatAgentOSReport(report: AgentOSReport): string {
  const episode = report.latestEpisode;
  const latestEval = report.trajectoryEvals[0] || null;
  const openInterrupts = report.interrupts.filter(
    (interrupt) => interrupt.status === 'open',
  );
  return redactCouncilText(
    [
      'Agent OS',
      '',
      `Summary: ${report.summary}`,
      `Episode: ${episode?.episodeId || 'none'}`,
      `Status: ${episode?.status || 'none'}`,
      `Mode: ${episode?.mode || 'none'}`,
      `Task: ${episode?.taskFamily || 'none'}`,
      `Steps: ${report.episodeSteps.length}`,
      `Handoffs: ${report.handoffs.length}`,
      `Interrupts: ${report.interrupts.length}`,
      `Open interrupts: ${openInterrupts.length}`,
      `Resume tokens: ${report.resumeTokens.length}`,
      `Tool cards: ${report.toolCards.length}`,
      `Read-only cards: ${report.capabilityDiscovery.readOnly}`,
      `Approval-staged cards: ${report.capabilityDiscovery.approvalStaged}`,
      `Blocked cards: ${report.capabilityDiscovery.blocked}`,
      `Trajectory score: ${latestEval?.overallScore ?? 'none'}`,
      `Source coverage: ${latestEval?.sourceCoverage ?? 'none'}`,
      `Skill proposals: ${report.skillProposals.length}`,
      `Runtime skill manifests: ${report.runtimeSkillManifests.length}`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    4000,
  );
}

export function buildAgentOSStatusText(): string {
  return formatAgentOSReport(buildAgentOSReport());
}

export function isAgentOSNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'what are you working on?' ||
    normalized === 'what are you working on' ||
    normalized === 'resume that' ||
    normalized === 'what is blocking this?' ||
    normalized === "what's blocking this?" ||
    normalized === 'what is blocking this' ||
    normalized === "what's blocking this" ||
    normalized === 'show the plan first' ||
    normalized === 'run the safe checks' ||
    normalized === 'what evidence supports this?' ||
    normalized === 'what evidence supports this' ||
    normalized === 'what is stale?' ||
    normalized === 'what is stale'
  );
}

export function _testAgentOSPrivacyJson(): string {
  return privacyJson();
}
