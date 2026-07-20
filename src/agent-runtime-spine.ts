import { buildAgentOSReport } from './agent-os.js';
import {
  compileAdaptiveDurablePlan,
  createAdaptiveDurableWork,
  type AdaptiveDurableCompiledPlan,
  type AdaptiveDurableNodeBinding,
  type AdaptiveDurableWorkCreationResult,
} from './adaptive-cognition-durable-adapter.js';
import { advanceAdaptiveCognition } from './adaptive-cognition-engine.js';
import type { AndreaPlatformProviderCouncilResult } from './andrea-platform-bridge.js';
import type { CognitiveKernelResult } from './cognitive-kernel.js';
import { redactCouncilText } from './council-safety.js';
import { durableActionRequiresApproval } from './durable-action-policy.js';
import {
  commitDurableCheckpointCAS,
  createOrLoadDurableWork,
  durableScopeHash,
  shouldCreateDurableWork,
  stageDurableWorkApproval,
} from './durable-work-continuity.js';
import type { IntegrationDoctorReport } from './integration-doctor.js';
import {
  getAgentOSEpisode,
  getAgentRuntimeRun,
  getDurableWorkCheckpoint,
  getDurableWorkUnit,
  isDatabaseInitialized,
  listAgentOSEpisodeSteps,
  listAgentRuntimeCheckpoints,
  listAgentRuntimeEvidencePackets,
  listAgentRuntimeEvents,
  listAgentRuntimeGuardrailResults,
  listAgentRuntimeInterrupts,
  listAgentRuntimeResumeTokens,
  listAgentRuntimeRuns,
  listAgentRuntimeSkillManifests,
  listAgentRuntimeSteps,
  listAgentRuntimeWrites,
  upsertAgentOSEpisode,
  upsertAgentOSEpisodeStep,
  upsertAgentOSTrajectoryEval,
  upsertAgentRuntimeCheckpoint,
  upsertAgentRuntimeEvidencePacket,
  upsertAgentRuntimeEvent,
  upsertAgentRuntimeGuardrailResult,
  upsertAgentRuntimeInterrupt,
  upsertAgentRuntimeResumeToken,
  upsertAgentRuntimeRun,
  upsertAgentRuntimeSkillManifest,
  upsertAgentRuntimeStep,
  upsertAgentRuntimeWrite,
} from './db.js';
import type { LogicKernelResult } from './logic-kernel.js';
import { buildWorldModelReport } from './world-model.js';
import {
  beginSupervisorKernelRun,
  buildSupervisorDoctorReport,
  buildSupervisorStatusText,
  isSupervisorNaturalRequest,
  persistSupervisorKernelResult,
} from './supervisor-kernel.js';
import type { SupervisorKernelResult } from './supervisor-kernel.js';
import {
  AGENT_RUNTIME_SOURCE_REFS,
  RuntimeToolGuardrailOutputFactory,
  makeRuntimeCheckpoint,
  makeRuntimeEvidencePacket,
  makeRuntimeGuardrailResult,
  makeRuntimeSkillManifest,
  makeRuntimeWrite,
  runtimeHashId,
  runtimeParseJsonArray,
  runtimePrivacyJson,
  runtimePrivacyReport,
  runtimeSafeJson,
  runtimeSanitizeId,
  summarizeRuntimeEvent,
} from './agent-runtime-glue.js';
import type {
  AgentOSCapabilityDiscoveryReport,
  AgentOSEpisode,
  AgentOSEpisodeStep,
  AgentOSTrajectoryEval,
  AgentOSReport,
  AgentRuntimeCheckpoint,
  AgentRuntimeEvidencePacket,
  AgentRuntimeEvent,
  AgentRuntimeGuardrailResult,
  AgentRuntimeInterrupt,
  AgentRuntimeResumeToken,
  AgentRuntimeRun,
  AgentRuntimeSkillManifest,
  AgentRuntimeSpineMode,
  AgentRuntimeSpineReport,
  AgentRuntimeStep,
  AgentRuntimeWrite,
  DurableWorkCheckpoint,
  DurableWorkUnit,
  CognitiveReplayPacket,
  TruthEngineReport,
  TruthVerdict,
  SupervisorDoctorReport,
  WorldModelDoctorReport,
} from './types.js';

export interface BeginAgentRuntimeSpineInput {
  turnId?: string | null;
  channel?: string | null;
  groupFolder?: string | null;
  actorId?: string | null;
  chatId?: string | null;
  targetScopeKey?: string | null;
  explicitlyDurable?: boolean;
  requestRoute?: string | null;
  taskFamily?: string | null;
  goal: string;
  generatedAt?: string;
  mode?: AgentRuntimeSpineMode;
  cognitiveRun?: CognitiveKernelResult | null;
  /**
   * Exact adaptive-node bindings supplied by a trusted planner/adapter. Runtime
   * Spine never derives these contracts from goal text or tool names.
   */
  adaptiveDurable?: {
    bindings: AdaptiveDurableNodeBinding[];
    preparedWork?: AdaptiveDurableWorkCreationResult | null;
  } | null;
  logicRun?: LogicKernelResult | null;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  persist?: boolean;
}

export interface AgentRuntimeSpineResult {
  run: AgentRuntimeRun;
  report: AgentRuntimeSpineReport;
  worldReport: WorldModelDoctorReport;
  supervisor?: SupervisorKernelResult | null;
  durableWork?: DurableWorkUnit | null;
  adaptiveDurable?: {
    disposition: 'authoritative' | 'legacy_pinned';
    compiled: AdaptiveDurableCompiledPlan | null;
    checkpoint: DurableWorkCheckpoint | null;
    nextNodeId: string | null;
  } | null;
}

export interface RecordAgentRuntimeTruthInput {
  runtimeRunId?: string | null;
  runtime?: AgentRuntimeSpineResult | null;
  truthVerdict: TruthVerdict;
  generatedAt?: string;
  textShape?: string | null;
}

export interface FinalizeAgentRuntimeOutcomeInput {
  runtimeRunId?: string | null;
  runtime?: AgentRuntimeSpineResult | null;
  generatedAt?: string;
  evaluationStatus?: 'pass' | 'warn' | 'block';
  evidenceGap?: string | null;
  evaluatorFlags?: string[];
  routeUsed?: string | null;
  answerClass?: string | null;
  blockerClass?: string | null;
}

export interface AgentRuntimeLifecycleReconciliation {
  inspected: number;
  interrupted: number;
  episodeSynced: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function resolveAgentRuntimeSpineMode(
  explicit?: AgentRuntimeSpineMode,
): AgentRuntimeSpineMode {
  if (explicit) return explicit;
  const raw = (
    process.env.AGENT_RUNTIME_SPINE_MODE || 'assistive'
  ).toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'assistive') return raw;
  return 'assistive';
}

function taskFamilyForGoal(goal: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const lower = goal.toLowerCase();
  if (/calendar|meeting|schedule|tomorrow|today/.test(lower)) return 'calendar';
  if (/bluebubbles|message|text|reply|thread|send/.test(lower))
    return 'communication';
  if (
    /provider|integration|diagnostic|service|status|operator|logs?/.test(lower)
  )
    return 'operator';
  if (/research|search|source|evidence|lookup|web/.test(lower))
    return 'research';
  if (/memory|remember|forget|preference|belief/.test(lower)) return 'memory';
  if (/plan|goal|steps|project/.test(lower)) return 'planning';
  return 'general';
}

export function classifyRuntimeMutatingAction(goal: string): string | null {
  const normalized = String(goal || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (
    /\b(create|write|update|change|move|reschedule|schedule|cancel|delete)\b.*\b(calendar|event|meeting)\b|\b(calendar|event|meeting)\b.*\b(create|write|update|change|move|reschedule|schedule|cancel|delete)\b|\bschedule it\b|\bwrite calendar\b/.test(
      normalized,
    )
  )
    return 'calendar_write';
  if (/\b(buy|purchase|order)\b/.test(normalized)) return 'purchase';
  if (/\bpush\b/.test(normalized)) return 'push';
  if (/\bcommit\b/.test(normalized)) return 'commit';
  if (/\bdeploy\b/.test(normalized)) return 'deploy';
  if (/\b(migrate|migration)\b/.test(normalized)) return 'migration';
  if (
    /\b(install|upgrade|update|remove|change)\b.*\b(dependency|dependencies|package|packages)\b|\b(dependency|dependencies|package|packages)\b.*\b(install|upgrade|update|remove|change)\b/.test(
      normalized,
    )
  )
    return 'dependency_change';
  if (
    /\b(restart|stop service|start service|change service|admin)\b/.test(
      normalized,
    )
  )
    return 'admin';
  if (/\bsend\b/.test(normalized)) return 'send';
  if (/\b(delete|remove|cancel)\b/.test(normalized)) return 'delete';
  if (
    /\b(edit|write|modify|change|fix|implement|patch|create)\b.*\b(file|code|repository|repo|source|readme|docs?|test)\b|\b(file|code|repository|repo|source|readme|docs?|test)\b.*\b(edit|write|modify|change|fix|implement|patch|create)\b/.test(
      normalized,
    )
  )
    return 'repository_write';
  return null;
}

function mutatingActionNeeded(goal: string): boolean {
  return classifyRuntimeMutatingAction(goal) !== null;
}

function sourceLayerFromStep(step: string): AgentRuntimeStep['layer'] {
  if (step.includes('world')) return 'world_model';
  if (step.includes('supervisor')) return 'supervisor';
  if (step.includes('logic')) return 'logic';
  if (step.includes('truth')) return 'truth';
  if (step.includes('guardrail')) return 'runtime_spine';
  if (step.includes('approval')) return 'approval';
  return 'runtime_spine';
}

function linkedAgentOSEpisode(input: {
  runtimeRunId: string;
  generatedAt: string;
  goal: string;
  taskFamily: string;
  groupFolder?: string | null;
  channel?: string | null;
  cognitiveRun?: CognitiveKernelResult | null;
  persist: boolean;
}): AgentOSEpisode {
  const episodeId = runtimeSanitizeId(`runtime:agentos:${input.runtimeRunId}`);
  const cognitiveRunId = input.cognitiveRun?.run.runId || null;
  const episode: AgentOSEpisode = {
    episodeId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    groupFolder:
      input.groupFolder || input.cognitiveRun?.run.groupFolder || null,
    channel: input.channel || input.cognitiveRun?.run.channel || null,
    rootRunId: cognitiveRunId,
    activeRunId: cognitiveRunId,
    goalSummary: redactCouncilText(input.goal, 640),
    taskFamily: input.taskFamily,
    status:
      input.cognitiveRun?.run.status === 'awaiting_approval'
        ? 'awaiting_approval'
        : 'active',
    mode:
      input.cognitiveRun?.run.cognitiveMode === 'council_verified'
        ? 'council_verified_episode'
        : input.cognitiveRun?.run.cognitiveMode === 'read_only_react'
          ? 'read_only_episode'
          : mutatingActionNeeded(input.goal)
            ? 'approval_staged_episode'
            : 'quick_episode',
    priority: mutatingActionNeeded(input.goal) ? 0.88 : 0.58,
    linkedRunIdsJson: runtimeSafeJson(
      cognitiveRunId ? [cognitiveRunId] : [],
      1200,
    ),
    councilRunIdsJson: runtimeSafeJson(
      input.cognitiveRun?.run.councilRunId
        ? [input.cognitiveRun.run.councilRunId]
        : [],
      1200,
    ),
    evidenceIdsJson: runtimeSafeJson(
      input.cognitiveRun?.evidenceArtifacts.map(
        (artifact) => artifact.artifactId,
      ) || [],
      2400,
    ),
    interruptIdsJson: runtimeSafeJson([], 1200),
    approvalPacketIdsJson: runtimeSafeJson(
      input.cognitiveRun?.approvalPackets.map(
        (packet) => packet.approvalPacketId,
      ) || [],
      2400,
    ),
    memoryBlockIdsJson: runtimeSafeJson(
      input.cognitiveRun?.memoryBlocks.map((block) => block.blockId) || [],
      2400,
    ),
    trajectoryEvalIdsJson: runtimeSafeJson([], 1200),
    sourceCoverageJson: runtimeSafeJson(
      {
        sourceIds: [
          input.runtimeRunId,
          ...(input.cognitiveRun?.evidenceArtifacts.map(
            (artifact) => artifact.artifactId,
          ) || []),
        ],
        sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
        score: input.cognitiveRun?.evidenceArtifacts.length ? 0.74 : 0.55,
      },
      3200,
    ),
    nextAction: mutatingActionNeeded(input.goal)
      ? 'Use runtime spine approval staging before any side effect.'
      : 'Use runtime spine checkpoints to continue safe read-only progress.',
    privacyJson: runtimePrivacyJson(),
    completedAt: null,
  };
  if (input.persist) upsertAgentOSEpisode(episode);
  const step: AgentOSEpisodeStep = {
    stepId: runtimeSanitizeId(
      `runtime:agentos:step:${episodeId}:runtime_spine`,
    ),
    episodeId,
    runId: cognitiveRunId,
    createdAt: input.generatedAt,
    position: 1,
    stepKind: 'frame',
    actorRole: 'planner',
    status: 'completed',
    summary:
      'Runtime spine linked this episode to world, logic, truth, and checkpoints.',
    evidenceRefsJson: runtimeSafeJson(
      [input.runtimeRunId, cognitiveRunId].filter(Boolean),
      1200,
    ),
    governanceDecisionIdsJson: runtimeSafeJson([], 1200),
    nextAction: 'Continue through runtime-spine guardrails and checkpoints.',
    privacyJson: runtimePrivacyJson(),
  };
  if (input.persist) upsertAgentOSEpisodeStep(step);
  return episode;
}

function fallbackAgentOSReport(input: {
  generatedAt: string;
  episode: AgentOSEpisode;
}): AgentOSReport {
  const capabilityDiscovery: AgentOSCapabilityDiscoveryReport = {
    generatedAt: input.generatedAt,
    toolCards: [],
    healthy: 0,
    degraded: 0,
    blocked: 0,
    approvalStaged: 0,
    readOnly: 0,
    sourceCoverage: [...AGENT_RUNTIME_SOURCE_REFS],
    nextAction:
      'Agent OS store is unavailable in this context; continue with in-memory runtime-spine metadata.',
    privacy: runtimePrivacyReport(),
  };
  return {
    generatedAt: input.generatedAt,
    ok: true,
    summary: `Agent OS episode ${input.episode.episodeId} is linked in memory for runtime-spine orchestration.`,
    latestEpisode: input.episode,
    episodeSteps: [],
    interrupts: [],
    resumeTokens: [],
    toolCards: [],
    handoffs: [],
    trajectoryEvals: [],
    skillProposals: [],
    runtimeSkillManifests: [],
    capabilityDiscovery,
    nextAction:
      'Initialize the database before expecting durable Agent OS episode history.',
    privacy: runtimePrivacyReport(),
  };
}

function fallbackIntegrationReport(
  generatedAt: string,
): IntegrationDoctorReport {
  return {
    generatedAt,
    summary: {
      total: 1,
      healthy: 0,
      actionNeeded: 1,
      needsProof: 0,
      manualOrExternal: 0,
    },
    statuses: [
      {
        integrationId: 'agent_runtime_spine.storage',
        label: 'Runtime spine storage',
        state: 'repo_fix_available',
        credentialState: 'not_required',
        transportState: 'unknown',
        proofState: 'repo_fix_available',
        lastHealthyAt: null,
        lastFailure: 'Database is not initialized in this execution context.',
        blockerOwner: 'repo_side',
        nextAction:
          'Initialize SQLite before durable runtime-spine integration proof is expected.',
        repairability: 'status_only',
        safeActions: [
          'Run under the service host or a test database when durable proof is required.',
        ],
        detail:
          'Pure harness mode uses in-memory runtime-spine metadata and does not inspect live integration tables.',
      },
    ],
    secretsRedacted: true,
  };
}

function fallbackTruthReport(generatedAt: string): TruthEngineReport {
  return {
    generatedAt,
    ok: false,
    latestAudit: null,
    claims: [],
    evidenceSupports: [],
    contradictionChecks: [],
    rewriteDirectives: [],
    sourceCoverage: [],
    nextAction:
      'Run Truth Engine during final reply evaluation before making confident factual claims.',
    privacy: runtimePrivacyReport(),
  };
}

function makeRuntimeStep(input: {
  runtimeRunId: string;
  generatedAt: string;
  position: number;
  stepKind: AgentRuntimeStep['stepKind'];
  layer?: AgentRuntimeStep['layer'];
  status?: AgentRuntimeStep['status'];
  summary: string;
  refs?: string[];
  evidencePacketIds?: string[];
  guardrailResultIds?: string[];
  checkpointId?: string | null;
  writeId?: string | null;
  nextAction: string;
}): AgentRuntimeStep {
  return {
    stepId: runtimeSanitizeId(
      runtimeHashId(
        'runtime:step',
        [
          input.runtimeRunId,
          String(input.position),
          input.stepKind,
          input.summary,
        ].join('|'),
      ),
    ),
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    position: input.position,
    stepKind: input.stepKind,
    layer: input.layer || sourceLayerFromStep(input.stepKind),
    status: input.status || 'completed',
    summary: redactCouncilText(input.summary, 900),
    refsJson: runtimeSafeJson(input.refs || [], 3200),
    evidencePacketIdsJson: runtimeSafeJson(input.evidencePacketIds || [], 2400),
    guardrailResultIdsJson: runtimeSafeJson(
      input.guardrailResultIds || [],
      2400,
    ),
    checkpointId: input.checkpointId || null,
    writeId: input.writeId || null,
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

function buildRuntimeInterrupt(input: {
  runtimeRunId: string;
  checkpoint: AgentRuntimeCheckpoint;
  write?: AgentRuntimeWrite | null;
  guardrail: AgentRuntimeGuardrailResult;
  approvalPacketId?: string | null;
  generatedAt: string;
}): { interrupt: AgentRuntimeInterrupt; token: AgentRuntimeResumeToken } {
  const interruptId = runtimeSanitizeId(
    runtimeHashId(
      'runtime:interrupt',
      `${input.runtimeRunId}|approval_required`,
    ),
  );
  const resumeTokenId = runtimeSanitizeId(
    runtimeHashId('runtime:resume', `${input.runtimeRunId}|${interruptId}`),
  );
  const interrupt: AgentRuntimeInterrupt = {
    interruptId,
    runtimeRunId: input.runtimeRunId,
    checkpointId: input.checkpoint.checkpointId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    interruptKind: 'approval_required',
    status: 'open',
    payloadJson: runtimeSafeJson(
      {
        checkpointId: input.checkpoint.checkpointId,
        writeId: input.write?.writeId || null,
        guardrailResultId: input.guardrail.guardrailResultId,
        approvalPacketId: input.approvalPacketId || null,
        approvalPolicy: 'explicit_approval_required',
      },
      2400,
    ),
    // Historical Runtime Spine resume IDs are descriptive projections only.
    // Authority-bearing continuation is issued by durable-work-continuity as
    // an opaque, scoped, expiring, single-use grant after exact approval.
    resumeTokenId: null,
    nextAction:
      'Wait for explicit user approval, then resume from the checkpoint without replaying completed nodes.',
    privacyJson: runtimePrivacyJson(),
  };
  const token: AgentRuntimeResumeToken = {
    resumeTokenId,
    runtimeRunId: input.runtimeRunId,
    interruptId,
    checkpointId: input.checkpoint.checkpointId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status: 'revoked',
    continuationKey: `${input.runtimeRunId}:approval`,
    safeStateJson: runtimeSafeJson(
      {
        runtimeRunId: input.runtimeRunId,
        checkpointId: input.checkpoint.checkpointId,
        pendingWriteId: input.write?.writeId || null,
        resumePolicy: 'durable_grant_required',
        projectionOnly: true,
      },
      3200,
    ),
    expiresAt: input.generatedAt,
    usedAt: input.generatedAt,
    privacyJson: runtimePrivacyJson(),
  };
  return { interrupt, token };
}

function runtimeReportFromParts(input: {
  generatedAt: string;
  run: AgentRuntimeRun;
  steps: AgentRuntimeStep[];
  checkpoints: AgentRuntimeCheckpoint[];
  writes: AgentRuntimeWrite[];
  guardrails: AgentRuntimeGuardrailResult[];
  interrupts: AgentRuntimeInterrupt[];
  resumeTokens: AgentRuntimeResumeToken[];
  events: AgentRuntimeEvent[];
  evidencePackets: AgentRuntimeEvidencePacket[];
  skillManifests: AgentRuntimeSkillManifest[];
  supervisorReport?: SupervisorDoctorReport | null;
}): AgentRuntimeSpineReport {
  const blockedGuardrails = input.guardrails.filter(
    (guardrail) => guardrail.status === 'block',
  ).length;
  const approvalRequired = input.interrupts.some(
    (interrupt) =>
      interrupt.interruptKind === 'approval_required' &&
      interrupt.status === 'open',
  );
  return {
    generatedAt: input.generatedAt,
    ok: blockedGuardrails === 0,
    mode: input.run.mode,
    latestRun: input.run,
    steps: input.steps,
    checkpoints: input.checkpoints,
    writes: input.writes,
    guardrails: input.guardrails,
    interrupts: input.interrupts,
    resumeTokens: input.resumeTokens,
    events: input.events,
    evidencePackets: input.evidencePackets,
    skillManifests: input.skillManifests,
    supervisorReport: input.supervisorReport || null,
    sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
    nextAction: approvalRequired
      ? 'Approve or decline the exact staged action; a scoped durable resume grant is required before any side effect.'
      : input.run.nextAction,
    privacy: runtimePrivacyReport(),
  };
}

export function beginAgentRuntimeSpineRun(
  input: BeginAgentRuntimeSpineInput,
): AgentRuntimeSpineResult | null {
  const generatedAt = input.generatedAt || nowIso();
  const mode = resolveAgentRuntimeSpineMode(input.mode);
  if (mode === 'off') return null;
  const persist = input.persist !== false && isDatabaseInitialized();
  const goal = redactCouncilText(
    input.goal || 'Inspect current Andrea state.',
    900,
  );
  const taskFamily = taskFamilyForGoal(goal, input.taskFamily);
  const runtimeRunId = runtimeSanitizeId(
    input.turnId
      ? `runtime:run:${input.turnId}`
      : runtimeHashId('runtime:run', `${generatedAt}|${taskFamily}|${goal}`),
  );
  const durableTargetScopeKey =
    input.targetScopeKey ||
    `runtime:${input.channel || 'unknown'}:${input.chatId || input.turnId || runtimeRunId}`;
  const adaptiveDurableRequest = input.adaptiveDurable || null;
  let adaptiveCompiledPreview: AdaptiveDurableCompiledPlan | null = null;
  let adaptiveNextNodeId: string | null = null;
  let adaptiveNextBinding: AdaptiveDurableNodeBinding | null = null;
  if (adaptiveDurableRequest) {
    const frame = input.cognitiveRun?.taskGraph.adaptiveFrame;
    const graph = input.cognitiveRun?.taskGraph.adaptivePlan;
    if (!input.cognitiveRun?.run.runId || !frame || !graph) {
      throw new Error(
        'Adaptive durable Runtime Spine work requires the canonical cognitive graph.',
      );
    }
    if (!input.targetScopeKey?.trim()) {
      throw new Error(
        'Adaptive durable Runtime Spine work requires an exact target scope.',
      );
    }
    const planVersion =
      adaptiveDurableRequest.preparedWork?.work.planVersion || 1;
    adaptiveCompiledPreview = compileAdaptiveDurablePlan({
      frame,
      graph,
      bindings: adaptiveDurableRequest.bindings,
      targetScopeKey: durableTargetScopeKey,
      planVersion,
    });
    const directive = advanceAdaptiveCognition({
      frame,
      graph,
      beliefs: input.cognitiveRun.taskGraph.adaptiveBeliefs || [],
      evidence: input.cognitiveRun.taskGraph.adaptiveEvidence || [],
      now: () => generatedAt,
    });
    const awaitingApprovalNodes = directive.result.graph.nodes.filter(
      (node) =>
        ['act', 'recover'].includes(node.kind) &&
        node.status === 'awaiting_approval',
    );
    if (!directive.node && awaitingApprovalNodes.length > 1) {
      throw new Error(
        'Adaptive durable Runtime Spine work has an ambiguous approval node.',
      );
    }
    const nextNode = directive.node || awaitingApprovalNodes[0] || null;
    adaptiveNextNodeId = nextNode?.nodeId || null;
    if (nextNode) {
      adaptiveNextBinding =
        adaptiveDurableRequest.bindings.find(
          (binding) => binding.nodeId === nextNode.nodeId,
        ) || null;
      if (!adaptiveNextBinding) {
        throw new Error(
          'Adaptive durable Runtime Spine work lacks the exact next-node binding.',
        );
      }
    }
  }
  const mutatingActionClass = classifyRuntimeMutatingAction(goal);
  const needsApproval = adaptiveDurableRequest
    ? Boolean(
        adaptiveNextBinding &&
        durableActionRequiresApproval(adaptiveNextBinding.durableActionClass),
      )
    : mutatingActionClass !== null;
  const linkedEpisode = linkedAgentOSEpisode({
    runtimeRunId,
    generatedAt,
    goal,
    taskFamily,
    groupFolder: input.groupFolder || null,
    channel: input.channel || null,
    cognitiveRun: input.cognitiveRun || null,
    persist,
  });
  const hasExactMutatingTarget = Boolean(input.targetScopeKey?.trim());
  const durableWorkEligible =
    persist &&
    shouldCreateDurableWork({
      taskFamily,
      requestRoute: input.requestRoute,
      approvalRequired: needsApproval,
      explicitlyDurable:
        input.explicitlyDurable || Boolean(adaptiveDurableRequest),
    });
  let durableWork =
    durableWorkEligible && !adaptiveDurableRequest
      ? createOrLoadDurableWork({
          originTurnId: input.turnId || runtimeRunId,
          authorizedSurface: input.channel || 'system',
          binding: {
            ownerId:
              input.actorId || input.chatId || input.groupFolder || 'system',
            chatId: input.chatId || input.turnId || runtimeRunId,
            groupId: input.groupFolder || 'main',
            channel: input.channel || 'system',
            targetScopeKey: durableTargetScopeKey,
          },
          goalSummary: goal,
          status: needsApproval ? 'awaiting_approval' : 'ready',
          runtimeRunId,
          agentOSEpisodeId: linkedEpisode.episodeId,
          cognitiveRunId: input.cognitiveRun?.run.runId || null,
          nextAction: needsApproval
            ? hasExactMutatingTarget
              ? 'Wait for exact-scope approval before issuing a resume grant.'
              : 'Resolve the exact mutation target before staging approval.'
            : 'Commit a bounded checkpoint before executing the next plan node.',
          now: generatedAt,
        }).work
      : null;
  const agentOSReport = persist
    ? buildAgentOSReport({
        episodeId: linkedEpisode.episodeId,
        generatedAt,
      })
    : fallbackAgentOSReport({ generatedAt, episode: linkedEpisode });
  const logicReport = input.logicRun?.report || null;
  const worldReport = buildWorldModelReport({
    generatedAt,
    subject: goal,
    agentOSReport,
    logicReport: logicReport || undefined,
    integrationReport: persist
      ? undefined
      : fallbackIntegrationReport(generatedAt),
    truthReport: persist ? undefined : fallbackTruthReport(generatedAt),
    persist,
  });
  const checkpoint = makeRuntimeCheckpoint({
    runtimeRunId,
    generatedAt,
    threadId: input.turnId || runtimeRunId,
    checkpointNs: 'agent_runtime_spine',
    status: needsApproval ? 'interrupted' : 'completed',
    state: {
      goal,
      taskFamily,
      worldSnapshotId: worldReport.snapshot.snapshotId,
      agentOSEpisodeId: linkedEpisode.episodeId,
      cognitiveRunId: input.cognitiveRun?.run.runId || null,
      logicBeliefStateId: logicReport?.beliefState?.beliefStateId || null,
      sideEffectPolicy: needsApproval ? 'approval_staged' : 'read_only_allowed',
    },
    metadata: {
      mode,
      requestRoute: input.requestRoute || null,
      sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
    },
    nextAction: needsApproval
      ? 'Stage approval and wait for explicit resume.'
      : 'Continue through Truth Engine and final answer calibration.',
  });
  const write = needsApproval
    ? makeRuntimeWrite({
        runtimeRunId,
        checkpointId: checkpoint.checkpointId,
        generatedAt,
        taskId: 'approval_packet',
        idx: 0,
        channel: input.channel || 'unknown',
        writeType: 'approval_packet',
        status: 'pending',
        valueSummary: {
          action: 'side_effect_staged',
          mutatingActionDetected: true,
          noSideEffectExecuted: true,
        },
      })
    : makeRuntimeWrite({
        runtimeRunId,
        checkpointId: checkpoint.checkpointId,
        generatedAt,
        taskId: 'world_evidence',
        idx: 0,
        channel: input.channel || 'unknown',
        writeType: 'evidence',
        status: 'applied',
        valueSummary: {
          worldSnapshotId: worldReport.snapshot.snapshotId,
          evidenceRefCount: worldReport.evidenceRefs.length,
        },
      });
  checkpoint.pendingWriteIdsJson = runtimeSafeJson(
    write.status === 'pending' ? [write.writeId] : [],
    1200,
  );
  const guardrail = makeRuntimeGuardrailResult({
    runtimeRunId,
    generatedAt,
    interventionPoint: 'pre_tool',
    guardrailName: 'runtime_spine_side_effect_policy',
    behavior: needsApproval
      ? RuntimeToolGuardrailOutputFactory.stageApproval(
          'Mutating action detected; runtime spine must stage approval.',
        )
      : RuntimeToolGuardrailOutputFactory.allow({
          policyClass: 'read_only_or_metadata',
        }),
    reason: needsApproval
      ? 'Sends, writes, service changes, commits, pushes, deletes, and purchases require explicit approval.'
      : 'Goal is compatible with read-only metadata and evidence checks.',
    riskFlags: needsApproval ? ['mutating_action_detected'] : [],
  });
  const supervisor = beginSupervisorKernelRun({
    runtimeRunId,
    generatedAt,
    mode,
    goal,
    taskFamily,
    worldReport,
    checkpoint,
    needsApproval,
    persist: false,
  });
  checkpoint.checkpointJson = runtimeSafeJson(
    {
      ...safeObject(checkpoint.checkpointJson),
      supervisorRunId: supervisor.run.supervisorRunId,
      blackboardId: supervisor.blackboard.blackboardId,
      pendingHandoffIds: supervisor.handoffs
        .filter(
          (handoff) =>
            handoff.status === 'requested' || handoff.status === 'accepted',
        )
        .map((handoff) => handoff.handoffId),
    },
    6400,
  );
  checkpoint.metadataJson = runtimeSafeJson(
    {
      ...safeObject(checkpoint.metadataJson),
      supervisorRunId: supervisor.run.supervisorRunId,
      blackboardId: supervisor.blackboard.blackboardId,
      terminationReason: supervisor.termination.reason,
    },
    3200,
  );
  let adaptiveDurableState: AgentRuntimeSpineResult['adaptiveDurable'] = null;
  let durableCheckpoint: {
    work: DurableWorkUnit;
    checkpoint: DurableWorkCheckpoint;
  } | null = null;
  if (adaptiveDurableRequest) {
    if (!durableWorkEligible || !adaptiveCompiledPreview) {
      throw new Error(
        'Adaptive durable Runtime Spine work requires initialized durable storage.',
      );
    }
    const prepared = adaptiveDurableRequest.preparedWork;
    if (prepared) {
      const currentWork = getDurableWorkUnit(prepared.work.workId);
      const currentCheckpoint = currentWork?.checkpointHeadId
        ? getDurableWorkCheckpoint(currentWork.checkpointHeadId)
        : null;
      if (
        !currentWork ||
        !currentCheckpoint ||
        currentWork.cognitiveRunId !== input.cognitiveRun?.run.runId ||
        currentWork.planId !== adaptiveCompiledPreview.plan.planId ||
        currentWork.targetScopeHash !==
          durableScopeHash('target', durableTargetScopeKey) ||
        currentCheckpoint.workId !== currentWork.workId ||
        currentCheckpoint.planVersion !== currentWork.planVersion ||
        prepared.compiled.plan.planId !== adaptiveCompiledPreview.plan.planId ||
        prepared.compiled.plan.planVersion !== currentWork.planVersion ||
        JSON.stringify(prepared.compiled.plan.nodes) !==
          JSON.stringify(adaptiveCompiledPreview.plan.nodes)
      ) {
        throw new Error(
          'Prepared adaptive durable work no longer matches Runtime Spine scope.',
        );
      }
      durableWork = currentWork;
      durableCheckpoint = { work: currentWork, checkpoint: currentCheckpoint };
      adaptiveDurableState = {
        disposition: 'authoritative',
        compiled: adaptiveCompiledPreview,
        checkpoint: currentCheckpoint,
        nextNodeId: adaptiveNextNodeId,
      };
    } else {
      try {
        const created = createAdaptiveDurableWork({
          originTurnId: input.turnId || runtimeRunId,
          authorizedSurface: input.channel || 'system',
          binding: {
            ownerId:
              input.actorId || input.chatId || input.groupFolder || 'system',
            chatId: input.chatId || input.turnId || runtimeRunId,
            groupId: input.groupFolder || 'main',
            channel: input.channel || 'system',
            targetScopeKey: durableTargetScopeKey,
          },
          goalSummary: goal,
          cognitiveRunId: input.cognitiveRun!.run.runId,
          runtimeRunId,
          agentOSEpisodeId: linkedEpisode.episodeId,
          frame: input.cognitiveRun!.taskGraph.adaptiveFrame!,
          graph: input.cognitiveRun!.taskGraph.adaptivePlan!,
          bindings: adaptiveDurableRequest.bindings,
          executorScopeKey: `runtime-spine:${mode}`,
          targetScopeKey: durableTargetScopeKey,
          runtimeCheckpointId: checkpoint.checkpointId,
          now: generatedAt,
        });
        durableWork = created.work;
        durableCheckpoint = {
          work: created.work,
          checkpoint: created.checkpoint,
        };
        adaptiveDurableState = {
          disposition: 'authoritative',
          compiled: created.compiled,
          checkpoint: created.checkpoint,
          nextNodeId: adaptiveNextNodeId,
        };
      } catch (error) {
        const pinned = createOrLoadDurableWork({
          originTurnId: input.turnId || runtimeRunId,
          authorizedSurface: input.channel || 'system',
          binding: {
            ownerId:
              input.actorId || input.chatId || input.groupFolder || 'system',
            chatId: input.chatId || input.turnId || runtimeRunId,
            groupId: input.groupFolder || 'main',
            channel: input.channel || 'system',
            targetScopeKey: durableTargetScopeKey,
          },
          goalSummary: goal,
          status: needsApproval ? 'awaiting_approval' : 'ready',
          runtimeRunId,
          agentOSEpisodeId: linkedEpisode.episodeId,
          cognitiveRunId: input.cognitiveRun!.run.runId,
          nextAction: 'Continue only through the already-pinned durable plan.',
          now: generatedAt,
        });
        if (
          pinned.created ||
          pinned.work.planId === adaptiveCompiledPreview.plan.planId
        ) {
          throw error;
        }
        durableWork = pinned.work;
        const pinnedCheckpoint = pinned.work.checkpointHeadId
          ? getDurableWorkCheckpoint(pinned.work.checkpointHeadId)
          : null;
        durableCheckpoint = pinnedCheckpoint
          ? { work: pinned.work, checkpoint: pinnedCheckpoint }
          : null;
        adaptiveDurableState = {
          disposition: 'legacy_pinned',
          compiled: null,
          checkpoint: pinnedCheckpoint,
          nextNodeId: null,
        };
      }
    }
  }
  if (!durableCheckpoint && durableWork) {
    const existingCheckpoint = durableWork.checkpointHeadId
      ? getDurableWorkCheckpoint(durableWork.checkpointHeadId)
      : null;
    durableCheckpoint = existingCheckpoint
      ? { work: durableWork, checkpoint: existingCheckpoint }
      : commitDurableCheckpointCAS({
          workId: durableWork.workId,
          expectedWorkVersion: durableWork.version,
          runtimeCheckpointId: checkpoint.checkpointId,
          // World, goal, and guardrail evidence is linked below as checkpoint
          // dependencies. It is not predeclared as completed execution work:
          // terminal durable nodes require their own verified effect receipts.
          completedNodeIds: [],
          pendingNodeIds: needsApproval
            ? ['approval', 'tool_step', 'verification', 'outcome']
            : ['tool_step', 'verification', 'outcome'],
          uncertainNodeIds: [],
          dependencyIds: [
            worldReport.snapshot.snapshotId,
            linkedEpisode.episodeId,
            input.cognitiveRun?.run.runId || '',
          ].filter(Boolean),
          worldSignals: {
            fresh: [worldReport.snapshot.snapshotId],
            stale: [],
            missing: worldReport.verificationNeeds
              .filter((need) => need.status !== 'resolved')
              .map((need) => need.needId),
          },
          executorScopeKey: `runtime-spine:${mode}`,
          targetScopeKey: durableTargetScopeKey,
          verificationRequirementIds: ['truth_audit', 'postcondition'],
          retryBudget: 3,
          attemptsUsed: 0,
          stopConditionIds: [
            'approval_boundary',
            'terminal_runtime_error',
            'retry_budget',
          ],
          recoveryPolicy: needsApproval
            ? 'approval_required'
            : 'inspect_then_resume',
          nextSafeAction: needsApproval
            ? 'Revalidate the target and approval before any mutating continuation.'
            : 'Execute only the next dependency-ready node and verify it.',
          status: needsApproval ? 'interrupted' : 'open',
          now: generatedAt,
        });
  }
  const adaptiveNode = adaptiveNextNodeId
    ? input.cognitiveRun?.taskGraph.adaptivePlan?.nodes.find(
        (node) => node.nodeId === adaptiveNextNodeId,
      ) || null
    : null;
  const durableApproval =
    adaptiveDurableState?.disposition === 'authoritative' &&
    needsApproval &&
    adaptiveNextBinding &&
    adaptiveNode &&
    durableCheckpoint &&
    input.cognitiveRun?.run.runId &&
    durableCheckpoint.work.status !== 'awaiting_approval'
      ? stageDurableWorkApproval({
          workId: durableCheckpoint.work.workId,
          expectedWorkVersion: durableCheckpoint.work.version,
          cognitiveRunId: input.cognitiveRun.run.runId,
          actionClass: adaptiveNextBinding.durableActionClass,
          nodeId: adaptiveNode.nodeId,
          summary: redactCouncilText(
            `Approve exact adaptive action ${adaptiveNode.actionId || adaptiveNode.nodeId}: ${adaptiveNode.title}`,
            620,
          ),
          checkpointId: durableCheckpoint.checkpoint.durableCheckpointId,
          now: generatedAt,
        })
      : adaptiveDurableState?.disposition === 'authoritative'
        ? null
        : needsApproval &&
            mutatingActionClass &&
            hasExactMutatingTarget &&
            durableCheckpoint &&
            input.cognitiveRun?.run.runId
          ? stageDurableWorkApproval({
              workId: durableCheckpoint.work.workId,
              expectedWorkVersion: durableCheckpoint.work.version,
              cognitiveRunId: input.cognitiveRun.run.runId,
              actionClass: mutatingActionClass,
              summary: redactCouncilText(
                `Approve one exact ${mutatingActionClass.replaceAll('_', ' ')} action: ${goal}`,
                620,
              ),
              checkpointId: durableCheckpoint.checkpoint.durableCheckpointId,
              now: generatedAt,
            })
          : null;
  if (adaptiveDurableState?.disposition === 'authoritative') {
    adaptiveDurableState = {
      ...adaptiveDurableState,
      checkpoint:
        durableApproval?.checkpoint || adaptiveDurableState.checkpoint,
    };
  }
  const worldEvidencePacket = makeRuntimeEvidencePacket({
    runtimeRunId,
    generatedAt,
    sourceLayer: 'world_model',
    sourceId: worldReport.snapshot.snapshotId,
    evidenceIds: [
      worldReport.snapshot.snapshotId,
      ...worldReport.evidenceRefs.map((ref) => ref.evidenceRefId),
      ...worldReport.verificationNeeds.map((need) => need.needId),
    ].slice(0, 80),
    summary: worldReport.snapshot.summary,
    createdAt: worldReport.snapshot.createdAt,
    confidence: worldReport.snapshot.confidence,
    textForCitation: worldReport.snapshot.summary,
    intent: taskFamily === 'calendar' ? 'temporal' : 'general',
  });
  const logicEvidencePacket = logicReport
    ? makeRuntimeEvidencePacket({
        runtimeRunId,
        generatedAt,
        sourceLayer: 'logic',
        sourceId: logicReport.beliefState?.beliefStateId || logicReport.subject,
        evidenceIds: [
          logicReport.beliefState?.beliefStateId || '',
          ...logicReport.claims.map((claim) => claim.claimId),
          ...logicReport.evidenceLinks.map((link) => link.evidenceId),
        ]
          .filter(Boolean)
          .slice(0, 80),
        summary: logicReport.summary,
        createdAt: logicReport.beliefState?.updatedAt || generatedAt,
        confidence: logicReport.confidence,
        textForCitation: logicReport.summary,
      })
    : null;
  const supervisorEvidencePacket = makeRuntimeEvidencePacket({
    runtimeRunId,
    generatedAt,
    sourceLayer: 'supervisor',
    sourceId: supervisor.run.supervisorRunId,
    evidenceIds: [
      supervisor.run.supervisorRunId,
      supervisor.blackboard.blackboardId,
      ...supervisor.blackboardPatches.map((patch) => patch.patchId),
      ...supervisor.decisions.map((decision) => decision.decisionId),
    ].slice(0, 80),
    summary: `Supervisor ${supervisor.run.status} with ${supervisor.handoffs.length} handoff(s), ${supervisor.blackboardPatches.length} blackboard patch(es), and termination ${supervisor.termination.reason}.`,
    createdAt: supervisor.run.createdAt,
    confidence: supervisor.report.ok ? 0.78 : 0.45,
    textForCitation: supervisor.report.nextAction,
  });
  const skillManifest = makeRuntimeSkillManifest({
    generatedAt,
    skillId: `runtime-spine.${taskFamily}`,
    sourceKind: 'runtime',
    frontmatter: {
      mode,
      taskFamily,
      approval: needsApproval ? 'required' : 'read_only_ok',
    },
    trigger: { taskFamily, requestRoute: input.requestRoute || null },
    toolRefs: ['world_model', 'agent_os', 'logic_kernel', 'truth_engine'],
    approvalRules: ['mutating_actions_stage_only', 'resume_from_checkpoint'],
    evidenceNeeds: ['world_snapshot', 'truth_audit', 'logic_belief_state'],
    summary: `Runtime spine skill manifest for ${taskFamily}; candidate-only until verified outcomes prove it.`,
  });
  const interruptBundle = needsApproval
    ? buildRuntimeInterrupt({
        runtimeRunId,
        checkpoint,
        write,
        guardrail,
        approvalPacketId: durableApproval?.packet.approvalPacketId || null,
        generatedAt,
      })
    : null;
  const steps = [
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 1,
      stepKind: 'goal_plan',
      summary: `Runtime spine framed ${taskFamily} goal in ${mode} mode.`,
      refs: [linkedEpisode.episodeId],
      nextAction: 'Apply guardrails before tool or answer work.',
    }),
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 2,
      stepKind: 'guardrail',
      status:
        guardrail.status === 'approval_required'
          ? 'approval_staged'
          : 'completed',
      summary: guardrail.reason,
      refs: [guardrail.guardrailResultId],
      guardrailResultIds: [guardrail.guardrailResultId],
      nextAction: guardrail.nextAction,
    }),
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 3,
      stepKind: 'world_snapshot',
      summary: `World Model snapshot ${worldReport.snapshot.status} with ${worldReport.proofDebt.total} proof-debt item(s).`,
      refs: [worldReport.snapshot.snapshotId],
      evidencePacketIds: [worldEvidencePacket.evidencePacketId],
      checkpointId: checkpoint.checkpointId,
      nextAction: worldReport.nextAction,
    }),
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 4,
      stepKind: 'supervisor',
      layer: 'supervisor',
      status:
        supervisor.run.status === 'awaiting_approval'
          ? 'approval_staged'
          : supervisor.report.ok
            ? 'completed'
            : 'warn',
      summary: `Supervisor ${supervisor.run.activeParticipant} stopped on ${supervisor.termination.reason}.`,
      refs: [
        supervisor.run.supervisorRunId,
        supervisor.blackboard.blackboardId,
        supervisor.replayPacket.replayPacketId,
      ],
      evidencePacketIds: [supervisorEvidencePacket.evidencePacketId],
      checkpointId: checkpoint.checkpointId,
      nextAction: supervisor.run.nextAction,
    }),
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 5,
      stepKind: 'checkpoint',
      status:
        checkpoint.status === 'interrupted' ? 'approval_staged' : 'completed',
      summary: 'Saved runtime checkpoint and pending writes.',
      refs: [checkpoint.checkpointId],
      checkpointId: checkpoint.checkpointId,
      writeId: write.writeId,
      nextAction: checkpoint.nextAction,
    }),
    makeRuntimeStep({
      runtimeRunId,
      generatedAt,
      position: 6,
      stepKind: 'logic',
      status: logicReport ? 'completed' : 'skipped',
      summary: logicReport
        ? `Linked Logic belief state at confidence ${logicReport.confidence.toFixed(2)}.`
        : 'No Logic Kernel report was available at runtime start.',
      refs: logicReport?.beliefState
        ? [logicReport.beliefState.beliefStateId]
        : [],
      evidencePacketIds: logicEvidencePacket
        ? [logicEvidencePacket.evidencePacketId]
        : [],
      nextAction:
        logicReport?.selectedNextAction ||
        'Run Logic Kernel before high-certainty answers.',
    }),
    ...(needsApproval
      ? [
          makeRuntimeStep({
            runtimeRunId,
            generatedAt,
            position: 7,
            stepKind: 'approval',
            status: 'approval_staged',
            summary:
              'Mutating action is staged as a pending write; no continuation capability has been issued.',
            refs: [
              interruptBundle?.interrupt.interruptId || '',
              write.writeId,
              durableApproval?.packet.approvalPacketId || '',
            ].filter(Boolean),
            checkpointId: checkpoint.checkpointId,
            writeId: write.writeId,
            guardrailResultIds: [guardrail.guardrailResultId],
            nextAction:
              'Wait for explicit approval before executing any side effect.',
          }),
        ]
      : []),
  ];
  const events = [
    summarizeRuntimeEvent({
      runtimeRunId,
      generatedAt,
      eventKind: 'world',
      label: 'World Model linked',
      detail: worldReport.snapshot.summary,
      refs: [worldReport.snapshot.snapshotId],
    }),
    summarizeRuntimeEvent({
      runtimeRunId,
      generatedAt,
      eventKind: 'handoff',
      label: 'Supervisor blackboard coordinated',
      detail: `Supervisor ${supervisor.run.supervisorRunId} routed ${supervisor.handoffs.length} handoff(s) and stopped on ${supervisor.termination.reason}.`,
      refs: [
        supervisor.run.supervisorRunId,
        supervisor.blackboard.blackboardId,
        supervisor.replayPacket.replayPacketId,
      ],
    }),
    summarizeRuntimeEvent({
      runtimeRunId,
      generatedAt,
      eventKind: 'checkpoint',
      label: 'Runtime checkpoint saved',
      detail: checkpoint.nextAction,
      refs: [checkpoint.checkpointId, write.writeId],
    }),
  ];
  const evidencePackets = [
    worldEvidencePacket,
    supervisorEvidencePacket,
    ...(logicEvidencePacket ? [logicEvidencePacket] : []),
  ];
  const run: AgentRuntimeRun = {
    runtimeRunId,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    mode,
    status:
      mode === 'shadow'
        ? 'shadowed'
        : needsApproval
          ? 'awaiting_approval'
          : 'active',
    turnId: input.turnId || null,
    channel: input.channel || null,
    groupFolder: input.groupFolder || null,
    goalSummary: goal,
    taskFamily,
    worldSnapshotId: worldReport.snapshot.snapshotId,
    agentOSEpisodeId: linkedEpisode.episodeId,
    cognitiveRunId: input.cognitiveRun?.run.runId || null,
    councilRunId:
      input.cognitiveRun?.run.councilRunId ||
      input.providerCouncil?.councilRunId ||
      null,
    logicBeliefStateId: logicReport?.beliefState?.beliefStateId || null,
    truthAuditId: null,
    checkpointIdsJson: runtimeSafeJson([checkpoint.checkpointId], 1200),
    writeIdsJson: runtimeSafeJson([write.writeId], 1200),
    stepIdsJson: runtimeSafeJson(
      steps.map((step) => step.stepId),
      2400,
    ),
    evidencePacketIdsJson: runtimeSafeJson(
      evidencePackets.map((packet) => packet.evidencePacketId),
      2400,
    ),
    interruptIdsJson: runtimeSafeJson(
      interruptBundle ? [interruptBundle.interrupt.interruptId] : [],
      1200,
    ),
    guardrailResultIdsJson: runtimeSafeJson(
      [guardrail.guardrailResultId],
      1200,
    ),
    outcomeJson: runtimeSafeJson(
      {
        status: 'pending_truth_and_answer',
        mode,
        supervisorRunId: supervisor.run.supervisorRunId,
        supervisorTermination: supervisor.termination.reason,
        sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
      },
      3200,
    ),
    nextAction: needsApproval
      ? 'Wait for explicit approval before side effects; otherwise continue with read-only evidence.'
      : 'Run Truth Engine and final answer calibration, then close the runtime run.',
    privacyJson: runtimePrivacyJson(),
  };
  if (persist) {
    upsertAgentRuntimeRun(run);
    persistSupervisorKernelResult(supervisor);
    upsertAgentRuntimeCheckpoint(checkpoint);
    upsertAgentRuntimeWrite(write);
    upsertAgentRuntimeGuardrailResult(guardrail);
    for (const packet of evidencePackets)
      upsertAgentRuntimeEvidencePacket(packet);
    upsertAgentRuntimeSkillManifest(skillManifest);
    for (const step of steps) upsertAgentRuntimeStep(step);
    for (const event of events) upsertAgentRuntimeEvent(event);
    if (interruptBundle) {
      upsertAgentRuntimeInterrupt(interruptBundle.interrupt);
      upsertAgentRuntimeResumeToken(interruptBundle.token);
    }
  }
  return {
    run,
    worldReport,
    durableWork:
      durableApproval?.work || durableCheckpoint?.work || durableWork,
    adaptiveDurable: adaptiveDurableState,
    report: persist
      ? buildAgentRuntimeSpineReport({ runtimeRunId, generatedAt })
      : runtimeReportFromParts({
          generatedAt,
          run,
          steps,
          checkpoints: [checkpoint],
          writes: [write],
          guardrails: [guardrail],
          interrupts: interruptBundle ? [interruptBundle.interrupt] : [],
          resumeTokens: interruptBundle ? [interruptBundle.token] : [],
          events,
          evidencePackets,
          skillManifests: [skillManifest],
          supervisorReport: supervisor.report,
        }),
    supervisor,
  };
}

export function recordAgentRuntimeTruthAudit(
  input: RecordAgentRuntimeTruthInput,
): AgentRuntimeRun | null {
  const runtimeRunId =
    input.runtimeRunId || input.runtime?.run.runtimeRunId || null;
  if (!runtimeRunId) return null;
  if (!isDatabaseInitialized()) return null;
  const existing = getAgentRuntimeRun(runtimeRunId);
  if (!existing) return null;
  const generatedAt =
    input.generatedAt || input.truthVerdict.generatedAt || nowIso();
  const evidenceIds = [
    input.truthVerdict.audit.auditId,
    ...input.truthVerdict.claims.map((claim) => claim.claimId),
    ...input.truthVerdict.evidenceSupports.map((support) => support.evidenceId),
  ].slice(0, 80);
  const packet = makeRuntimeEvidencePacket({
    runtimeRunId,
    generatedAt,
    sourceLayer: 'truth',
    sourceId: input.truthVerdict.audit.auditId,
    evidenceIds,
    summary: input.truthVerdict.summary,
    createdAt: input.truthVerdict.audit.updatedAt,
    confidence: input.truthVerdict.calibration.confidence,
    textForCitation: input.truthVerdict.rewrittenText,
    intent: 'general',
  });
  const step = makeRuntimeStep({
    runtimeRunId,
    generatedAt,
    position: listAgentRuntimeSteps({ runtimeRunId, limit: 500 }).length + 1,
    stepKind: 'truth',
    status:
      input.truthVerdict.calibration.status === 'block'
        ? 'blocked'
        : input.truthVerdict.calibration.status === 'warn' ||
            input.truthVerdict.calibration.status === 'clarify'
          ? 'warn'
          : 'completed',
    summary: input.truthVerdict.summary,
    refs: [input.truthVerdict.audit.auditId],
    evidencePacketIds: [packet.evidencePacketId],
    nextAction: input.truthVerdict.bestNextAction,
  });
  const event = summarizeRuntimeEvent({
    runtimeRunId,
    generatedAt,
    eventKind: 'truth',
    severity:
      step.status === 'blocked'
        ? 'block'
        : step.status === 'warn'
          ? 'warn'
          : 'info',
    label: 'Truth Engine audit linked',
    detail: input.truthVerdict.summary,
    refs: [input.truthVerdict.audit.auditId],
  });
  const evidencePacketIds = Array.from(
    new Set([
      ...runtimeParseJsonArray(existing.evidencePacketIdsJson),
      packet.evidencePacketId,
    ]),
  );
  const stepIds = Array.from(
    new Set([...runtimeParseJsonArray(existing.stepIdsJson), step.stepId]),
  );
  const updated: AgentRuntimeRun = {
    ...existing,
    updatedAt: generatedAt,
    truthAuditId: input.truthVerdict.audit.auditId,
    status:
      existing.status === 'awaiting_approval'
        ? existing.status
        : input.truthVerdict.calibration.status === 'block'
          ? 'blocked'
          : existing.mode === 'shadow'
            ? 'shadowed'
            : 'active',
    evidencePacketIdsJson: runtimeSafeJson(evidencePacketIds, 2400),
    stepIdsJson: runtimeSafeJson(stepIds, 2400),
    outcomeJson: runtimeSafeJson(
      {
        ...safeObject(existing.outcomeJson),
        truthAuditId: input.truthVerdict.audit.auditId,
        truthStatus: input.truthVerdict.calibration.status,
        confidence: input.truthVerdict.calibration.confidence,
        textShape: input.textShape || null,
      },
      3200,
    ),
    nextAction: input.truthVerdict.bestNextAction,
  };
  upsertAgentRuntimeEvidencePacket(packet);
  upsertAgentRuntimeStep(step);
  upsertAgentRuntimeEvent(event);
  upsertAgentRuntimeRun(updated);
  return updated;
}

export function finalizeAgentRuntimeSpineOutcome(
  input: FinalizeAgentRuntimeOutcomeInput,
): AgentRuntimeRun | null {
  const runtimeRunId =
    input.runtimeRunId || input.runtime?.run.runtimeRunId || null;
  if (!runtimeRunId) return null;
  if (!isDatabaseInitialized()) return null;
  const existing = getAgentRuntimeRun(runtimeRunId);
  if (!existing) return null;
  const generatedAt = input.generatedAt || nowIso();
  const blocked =
    input.evaluationStatus === 'block' || Boolean(input.blockerClass);
  const warn = input.evaluationStatus === 'warn';
  const status: AgentRuntimeRun['status'] =
    existing.mode === 'shadow'
      ? 'shadowed'
      : existing.status === 'awaiting_approval'
        ? 'awaiting_approval'
        : blocked
          ? 'blocked'
          : 'completed';
  const step = makeRuntimeStep({
    runtimeRunId,
    generatedAt,
    position: listAgentRuntimeSteps({ runtimeRunId, limit: 500 }).length + 1,
    stepKind: 'outcome',
    status: blocked ? 'blocked' : warn ? 'warn' : 'completed',
    summary: `Runtime outcome ${input.evaluationStatus || 'pass'} on route ${input.routeUsed || 'unknown'}.`,
    refs: [existing.truthAuditId || '', existing.worldSnapshotId || ''].filter(
      Boolean,
    ),
    nextAction:
      status === 'completed'
        ? 'Use this runtime trajectory as replayable evidence for future similar turns.'
        : existing.nextAction,
  });
  const event = summarizeRuntimeEvent({
    runtimeRunId,
    generatedAt,
    eventKind: 'outcome',
    severity: blocked ? 'block' : warn ? 'warn' : 'info',
    label: 'Runtime outcome finalized',
    detail: step.summary,
    refs: [step.stepId],
  });
  const updated: AgentRuntimeRun = {
    ...existing,
    updatedAt: generatedAt,
    status,
    stepIdsJson: runtimeSafeJson(
      Array.from(
        new Set([...runtimeParseJsonArray(existing.stepIdsJson), step.stepId]),
      ),
      2400,
    ),
    outcomeJson: runtimeSafeJson(
      {
        ...safeObject(existing.outcomeJson),
        finalStatus: input.evaluationStatus || 'pass',
        evidenceGap: input.evidenceGap || 'none',
        evaluatorFlags: input.evaluatorFlags || [],
        routeUsed: input.routeUsed || null,
        answerClass: input.answerClass || null,
        blockerClass: input.blockerClass || null,
      },
      3200,
    ),
    nextAction:
      status === 'completed'
        ? 'Runtime run is complete; use debug:runtime-spine for replay metadata.'
        : existing.nextAction,
  };
  upsertAgentRuntimeStep(step);
  upsertAgentRuntimeEvent(event);
  upsertAgentRuntimeRun(updated);
  syncAgentOSEpisodeFromRuntime(updated, generatedAt);
  return updated;
}

function runtimeSourceCoverage(episode: AgentOSEpisode): number {
  const raw = safeObject(episode.sourceCoverageJson).score;
  return typeof raw === 'number' && Number.isFinite(raw)
    ? Math.max(0, Math.min(1, raw))
    : 0.55;
}

function agentOSEpisodeStatusForRuntime(
  status: AgentRuntimeRun['status'],
): AgentOSEpisode['status'] {
  if (status === 'completed' || status === 'shadowed') return 'completed';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  if (status === 'blocked') return 'blocked';
  if (status === 'interrupted') return 'interrupted';
  return 'active';
}

function runtimeTrajectoryEval(input: {
  run: AgentRuntimeRun;
  episode: AgentOSEpisode;
  generatedAt: string;
}): AgentOSTrajectoryEval {
  const outcome = safeObject(input.run.outcomeJson);
  const finalStatus = String(outcome.finalStatus || 'unknown');
  const sourceCoverage = runtimeSourceCoverage(input.episode);
  const openApprovalInterrupt = listAgentRuntimeInterrupts({
    runtimeRunId: input.run.runtimeRunId,
    status: 'open',
    limit: 100,
  }).some((interrupt) => interrupt.interruptKind === 'approval_required');
  const approvalSafety =
    !openApprovalInterrupt || input.run.status === 'awaiting_approval'
      ? 1
      : 0.4;
  const interruptSafety = input.run.status === 'interrupted' ? 0.7 : 1;
  const toolUsefulness = Math.min(
    1,
    0.55 +
      listAgentRuntimeEvidencePackets({
        runtimeRunId: input.run.runtimeRunId,
        limit: 20,
      }).length *
        0.08,
  );
  const verificationStrength = input.run.truthAuditId
    ? finalStatus === 'pass'
      ? 0.86
      : finalStatus === 'warn'
        ? 0.65
        : 0.4
    : 0.3;
  const privacy = safeObject(input.run.privacyJson);
  const privacySafety =
    privacy.rawPromptsStored === false &&
    privacy.rawPrivateBodiesStored === false &&
    privacy.hiddenReasoningStored === false
      ? 1
      : 0;
  const overallScore = Number(
    (
      (sourceCoverage +
        interruptSafety +
        approvalSafety +
        toolUsefulness +
        verificationStrength +
        privacySafety) /
      6
    ).toFixed(3),
  );
  const status: AgentOSTrajectoryEval['status'] =
    input.run.status === 'blocked' || input.run.status === 'interrupted'
      ? 'fail'
      : overallScore >= 0.78
        ? 'pass'
        : overallScore >= 0.55
          ? 'warn'
          : 'fail';
  const demotionSignals: string[] = [];
  if (!input.run.truthAuditId) demotionSignals.push('missing_truth_audit');
  if (input.run.status === 'blocked') demotionSignals.push('blocked_runtime');
  if (input.run.status === 'interrupted') {
    demotionSignals.push('interrupted_before_outcome_verification');
  }
  if (approvalSafety < 1) demotionSignals.push('approval_state_mismatch');
  if (finalStatus === 'warn') demotionSignals.push('warned_evaluation');
  if (finalStatus === 'block') demotionSignals.push('blocked_evaluation');
  if (privacySafety < 1) demotionSignals.push('privacy_policy_failure');
  return {
    evalId: runtimeSanitizeId(`runtime:agentos:eval:${input.run.runtimeRunId}`),
    episodeId: input.episode.episodeId,
    runId: input.episode.activeRunId || input.episode.rootRunId || null,
    createdAt: input.generatedAt,
    status,
    overallScore,
    sourceCoverage,
    interruptSafety,
    approvalSafety,
    toolUsefulness,
    verificationStrength,
    privacySafety,
    // A runtime completion is not an owner verdict and cannot grant authority.
    promotionEligible: false,
    demotionSignalsJson: runtimeSafeJson(demotionSignals, 1200),
    nextAction:
      'Require an owner-reviewed outcome before this runtime trajectory can influence skill promotion.',
    privacyJson: runtimePrivacyJson(),
  };
}

function syncAgentOSEpisodeFromRuntime(
  run: AgentRuntimeRun,
  generatedAt: string,
): boolean {
  if (!run.agentOSEpisodeId) return false;
  const episode = getAgentOSEpisode(run.agentOSEpisodeId);
  if (!episode) return false;
  const status = agentOSEpisodeStatusForRuntime(run.status);
  const terminal = ['completed', 'blocked', 'interrupted'].includes(status);
  const evalRecord = terminal
    ? runtimeTrajectoryEval({ run, episode, generatedAt })
    : null;
  const priorEvalIds = runtimeParseJsonArray(episode.trajectoryEvalIdsJson);
  const evalIds = evalRecord
    ? Array.from(new Set([...priorEvalIds, evalRecord.evalId]))
    : priorEvalIds;
  const priorLinkedRunIds = runtimeParseJsonArray(episode.linkedRunIdsJson);
  const linkedRunIds = Array.from(
    new Set([...priorLinkedRunIds, run.runtimeRunId]),
  );
  const priorEvidenceIds = runtimeParseJsonArray(episode.evidenceIdsJson);
  const evidenceIds = Array.from(
    new Set([
      ...priorEvidenceIds,
      ...runtimeParseJsonArray(run.evidencePacketIdsJson),
      ...(run.truthAuditId ? [run.truthAuditId] : []),
    ]),
  );
  const nextAction =
    status === 'completed'
      ? 'Await an owner-reviewed outcome before using this trajectory for promotion.'
      : status === 'interrupted'
        ? 'Treat this prior-process turn as interrupted; do not infer success without outcome evidence.'
        : status === 'blocked'
          ? 'Resolve the recorded blocker and start a fresh verified turn.'
          : status === 'awaiting_approval'
            ? 'Wait for explicit approval before resuming the staged action.'
            : episode.nextAction;
  const updatedEpisode: AgentOSEpisode = {
    ...episode,
    updatedAt: generatedAt,
    status,
    linkedRunIdsJson: runtimeSafeJson(linkedRunIds, 2400),
    evidenceIdsJson: runtimeSafeJson(evidenceIds, 2400),
    trajectoryEvalIdsJson: runtimeSafeJson(evalIds, 1200),
    nextAction,
    completedAt: status === 'completed' ? generatedAt : null,
  };
  const outcomeStepId = runtimeSanitizeId(
    `runtime:agentos:step:${episode.episodeId}:outcome`,
  );
  const existingSteps = listAgentOSEpisodeSteps({
    episodeId: episode.episodeId,
    limit: 500,
  });
  const existingOutcomeStep = existingSteps.find(
    (step) => step.stepId === outcomeStepId,
  );
  const alreadySynced =
    episode.status === status &&
    priorLinkedRunIds.includes(run.runtimeRunId) &&
    evidenceIds.every((id) => priorEvidenceIds.includes(id)) &&
    (!evalRecord || priorEvalIds.includes(evalRecord.evalId)) &&
    Boolean(existingOutcomeStep) &&
    (status !== 'completed' || episode.completedAt !== null);
  if (alreadySynced) return false;
  const outcomeStep: AgentOSEpisodeStep = {
    stepId: outcomeStepId,
    episodeId: episode.episodeId,
    runId: episode.activeRunId || episode.rootRunId || null,
    createdAt: generatedAt,
    position:
      existingOutcomeStep?.position ||
      Math.max(0, ...existingSteps.map((step) => step.position)) + 1,
    stepKind: 'outcome',
    actorRole: 'final_arbiter',
    status:
      status === 'completed'
        ? 'completed'
        : status === 'awaiting_approval'
          ? 'approval_staged'
          : status === 'active'
            ? 'planned'
            : status === 'blocked'
              ? 'blocked'
              : 'warn',
    summary: `Runtime-linked episode reconciled as ${status}.`,
    evidenceRefsJson: runtimeSafeJson(
      [run.runtimeRunId, run.truthAuditId].filter(Boolean),
      1200,
    ),
    governanceDecisionIdsJson: runtimeSafeJson([], 1200),
    nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  upsertAgentOSEpisode(updatedEpisode);
  upsertAgentOSEpisodeStep(outcomeStep);
  if (evalRecord) upsertAgentOSTrajectoryEval(evalRecord);
  return true;
}

/**
 * Reconciles per-turn runtime runs left by a prior process generation. Active
 * runs cannot resume across a host restart, so they are marked interrupted
 * instead of being silently treated as successful.
 */
export function reconcileInterruptedAgentRuntimeRuns(
  params: { generatedAt?: string; limit?: number } = {},
): AgentRuntimeLifecycleReconciliation {
  if (!isDatabaseInitialized()) {
    return { inspected: 0, interrupted: 0, episodeSynced: 0 };
  }
  const generatedAt = params.generatedAt || nowIso();
  const runs = listAgentRuntimeRuns({ limit: params.limit || 2_000 });
  let interrupted = 0;
  let episodeSynced = 0;
  for (const run of runs) {
    let reconciledRun = run;
    if (run.status === 'active') {
      reconciledRun = {
        ...run,
        updatedAt: generatedAt,
        status: 'interrupted',
        outcomeJson: runtimeSafeJson(
          {
            ...safeObject(run.outcomeJson),
            finalStatus: 'interrupted',
            evidenceGap: 'prior_process_ended_before_outcome_verification',
            evaluatorFlags: ['interrupted_process_reconciliation'],
          },
          3200,
        ),
        nextAction:
          'Start a fresh turn; do not infer success from this interrupted runtime run.',
      };
      upsertAgentRuntimeRun(reconciledRun);
      interrupted += 1;
    }
    if (
      reconciledRun.status !== 'active' &&
      syncAgentOSEpisodeFromRuntime(reconciledRun, generatedAt)
    ) {
      episodeSynced += 1;
    }
  }
  return { inspected: runs.length, interrupted, episodeSynced };
}

function safeObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function buildAgentRuntimeSpineReport(
  params: { runtimeRunId?: string | null; generatedAt?: string } = {},
): AgentRuntimeSpineReport {
  const generatedAt = params.generatedAt || nowIso();
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      ok: false,
      mode: resolveAgentRuntimeSpineMode(),
      latestRun: null,
      steps: [],
      checkpoints: [],
      writes: [],
      guardrails: [],
      interrupts: [],
      resumeTokens: [],
      events: [],
      evidencePackets: [],
      skillManifests: [],
      supervisorReport: null,
      sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
      nextAction:
        'Database is not initialized in this context; run a live debug command or process a turn under the service host.',
      privacy: runtimePrivacyReport(),
    };
  }
  const latestRun = params.runtimeRunId
    ? getAgentRuntimeRun(params.runtimeRunId) || null
    : listAgentRuntimeRuns({ cognitiveRunOrigin: 'live', limit: 1 })[0] || null;
  const runtimeRunId = latestRun?.runtimeRunId || null;
  const guardrails = runtimeRunId
    ? listAgentRuntimeGuardrailResults({ runtimeRunId, limit: 100 })
    : [];
  const interrupts = runtimeRunId
    ? listAgentRuntimeInterrupts({ runtimeRunId, limit: 100 })
    : [];
  const evidencePackets = runtimeRunId
    ? listAgentRuntimeEvidencePackets({ runtimeRunId, limit: 100 })
    : [];
  const blockedGuardrails = guardrails.filter(
    (guardrail) => guardrail.status === 'block',
  ).length;
  const approvalRequired = interrupts.some(
    (interrupt) =>
      interrupt.interruptKind === 'approval_required' &&
      interrupt.status === 'open',
  );
  const ok = Boolean(latestRun) && blockedGuardrails === 0;
  return {
    generatedAt,
    ok,
    mode: latestRun?.mode || resolveAgentRuntimeSpineMode(),
    latestRun,
    steps: runtimeRunId
      ? listAgentRuntimeSteps({ runtimeRunId, limit: 200 })
      : [],
    checkpoints: runtimeRunId
      ? listAgentRuntimeCheckpoints({ runtimeRunId, limit: 100 })
      : [],
    writes: runtimeRunId
      ? listAgentRuntimeWrites({ runtimeRunId, limit: 100 })
      : [],
    guardrails,
    interrupts,
    resumeTokens: runtimeRunId
      ? listAgentRuntimeResumeTokens({ runtimeRunId, limit: 100 })
      : [],
    events: runtimeRunId
      ? listAgentRuntimeEvents({ runtimeRunId, limit: 200 })
      : [],
    evidencePackets,
    skillManifests: listAgentRuntimeSkillManifests({ limit: 50 }),
    supervisorReport: runtimeRunId
      ? buildSupervisorDoctorReport({ runtimeRunId, generatedAt })
      : null,
    sourceRefs: AGENT_RUNTIME_SOURCE_REFS,
    nextAction: latestRun
      ? approvalRequired
        ? 'Approve or decline the exact staged action; a scoped durable resume grant is required before any side effect.'
        : latestRun.nextAction
      : 'No runtime spine run exists yet; process a meaningful turn or run debug:runtime-spine -- --json.',
    privacy: runtimePrivacyReport(),
  };
}

export function formatAgentRuntimeSpineReport(
  report: AgentRuntimeSpineReport,
): string {
  const run = report.latestRun;
  return redactCouncilText(
    [
      'Agent Runtime Spine',
      '',
      `Mode: ${report.mode}`,
      `Status: ${run?.status || 'none'}`,
      `Run: ${run?.runtimeRunId || 'none'}`,
      `Goal: ${run?.goalSummary || 'none'}`,
      `World snapshot: ${run?.worldSnapshotId || 'none'}`,
      `Agent OS episode: ${run?.agentOSEpisodeId || 'none'}`,
      `Supervisor: ${report.supervisorReport?.latestRun?.supervisorRunId || 'none'}`,
      `Supervisor active: ${report.supervisorReport?.latestRun?.activeParticipant || 'none'}`,
      `Supervisor handoffs: ${report.supervisorReport?.handoffs.length || 0}`,
      `Supervisor termination: ${report.supervisorReport?.terminations[0]?.reason || 'none'}`,
      `Logic belief: ${run?.logicBeliefStateId || 'none'}`,
      `Truth audit: ${run?.truthAuditId || 'none'}`,
      `Steps: ${report.steps.length}`,
      `Checkpoints: ${report.checkpoints.length}`,
      `Pending writes: ${report.writes.filter((write) => write.status === 'pending').length}`,
      `Guardrails blocked: ${report.guardrails.filter((guardrail) => guardrail.status === 'block').length}`,
      `Evidence packets: ${report.evidencePackets.length}`,
      `Interrupts: ${report.interrupts.filter((interrupt) => interrupt.status === 'open').length}`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, raw tool output, or secrets are stored.',
    ].join('\n'),
    5000,
  );
}

export function buildAgentRuntimeSpineStatusText(): string {
  return formatAgentRuntimeSpineReport(buildAgentRuntimeSpineReport());
}

export function isAgentRuntimeSpineNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'runtime spine status' ||
    normalized === 'agent runtime status' ||
    normalized === 'what should you verify next?' ||
    normalized === 'what changed?' ||
    normalized === 'what is stale?' ||
    /\bwhy did you choose that\b/i.test(normalized) ||
    isSupervisorNaturalRequest(text)
  );
}

export { buildSupervisorStatusText, isSupervisorNaturalRequest };

export function buildAgentRuntimeReplayPacket(runtimeRunId: string): Pick<
  CognitiveReplayPacket,
  'generatedAt' | 'runId' | 'checkpoints' | 'privacy'
> & {
  runtimeRun: AgentRuntimeRun | null;
  runtimeCheckpoints: AgentRuntimeCheckpoint[];
  runtimeWrites: AgentRuntimeWrite[];
} {
  const generatedAt = nowIso();
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      runId: runtimeRunId,
      latestRun: null,
      checkpoints: [],
      runtimeRun: null,
      runtimeCheckpoints: [],
      runtimeWrites: [],
      privacy: runtimePrivacyReport(),
    } as Pick<
      CognitiveReplayPacket,
      'generatedAt' | 'runId' | 'checkpoints' | 'privacy'
    > & {
      runtimeRun: AgentRuntimeRun | null;
      runtimeCheckpoints: AgentRuntimeCheckpoint[];
      runtimeWrites: AgentRuntimeWrite[];
    };
  }
  const run = getAgentRuntimeRun(runtimeRunId) || null;
  return {
    generatedAt,
    runId: run?.cognitiveRunId || runtimeRunId,
    latestRun: null,
    checkpoints: [],
    runtimeRun: run,
    runtimeCheckpoints: listAgentRuntimeCheckpoints({
      runtimeRunId,
      limit: 100,
    }),
    runtimeWrites: listAgentRuntimeWrites({ runtimeRunId, limit: 100 }),
    privacy: runtimePrivacyReport(),
  } as Pick<
    CognitiveReplayPacket,
    'generatedAt' | 'runId' | 'checkpoints' | 'privacy'
  > & {
    runtimeRun: AgentRuntimeRun | null;
    runtimeCheckpoints: AgentRuntimeCheckpoint[];
    runtimeWrites: AgentRuntimeWrite[];
  };
}
