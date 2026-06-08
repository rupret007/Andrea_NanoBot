import { redactCouncilText } from './council-safety.js';
import {
  isDatabaseInitialized,
  listSupervisorAgendaItems,
  listSupervisorBlackboardPatches,
  listSupervisorBlackboards,
  listSupervisorBudgets,
  listSupervisorDecisions,
  listSupervisorHandoffMessages,
  listSupervisorLoopStates,
  listSupervisorParticipants,
  listSupervisorReplayPackets,
  listSupervisorRuns,
  listSupervisorTerminationConditions,
  upsertSupervisorAgendaItem,
  upsertSupervisorBlackboard,
  upsertSupervisorBlackboardPatch,
  upsertSupervisorBudget,
  upsertSupervisorDecision,
  upsertSupervisorHandoffMessage,
  upsertSupervisorLoopState,
  upsertSupervisorParticipant,
  upsertSupervisorReplayPacket,
  upsertSupervisorRun,
  upsertSupervisorTerminationCondition,
} from './db.js';
import {
  AGENT_RUNTIME_SOURCE_REFS,
  runtimeHashId,
  runtimeParseJsonArray,
  runtimePrivacyJson,
  runtimePrivacyReport,
  runtimeSafeJson,
  runtimeSanitizeId,
} from './agent-runtime-glue.js';
import type {
  AgentRuntimeCheckpoint,
  AgentRuntimeSpineMode,
  SupervisorAgendaItem,
  SupervisorBlackboard,
  SupervisorBlackboardPatch,
  SupervisorBudget,
  SupervisorDecision,
  SupervisorDoctorReport,
  SupervisorHandoffMessage,
  SupervisorLoopState,
  SupervisorParticipant,
  SupervisorParticipantRole,
  SupervisorReplayPacket,
  SupervisorRun,
  SupervisorTerminationCondition,
  WorldModelDoctorReport,
} from './types.js';

export const SUPERVISOR_SOURCE_REFS = [
  'openai-swarm@6af0b4caf37dca4526dfd98e9fbd8ce36e7eeb22:core.py/types.py agent-response/context-variable/handoff shape',
  'microsoft-autogen@027ecf0a379bcc1d09956d46d12d44a3ad9cee14:_swarm_group_chat.py/_base_group_chat.py next-speaker-from-handoff/max-turn termination pattern',
  'semantic-kernel@417d62f8b1131e94058488396b670d32661a9318:group_chat.py orchestration lifecycle/result naming',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:run-loop/guardrail/tracing glue already adapted in runtime spine',
  'langgraphjs@133d0bd52ec0effbc9ac6d4b2c3050f4b0dabb72:checkpoint/resume primitives re-reviewed for pending handoff replay',
];

const PARTICIPANT_ROLES: SupervisorParticipantRole[] = [
  'planner',
  'memory_curator',
  'evidence_scout',
  'tool_executor',
  'verifier',
  'truth_calibrator',
  'approval_stager',
  'final_arbiter',
];

const DEFAULT_BUDGET = {
  maxTurns: 6,
  maxReadOnlyToolSteps: 4,
  maxCouncilCalls: 1,
  maxClarificationRequests: 1,
};

const UNSAFE_BLACKBOARD_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|raw private (?:body|message)|raw message body|provider debate|chain[- ]of[- ]thought|hidden reasoning|full prompt|secret[:=]/i;

export interface BeginSupervisorKernelInput {
  runtimeRunId: string;
  generatedAt: string;
  mode: AgentRuntimeSpineMode;
  goal: string;
  taskFamily: string;
  worldReport: WorldModelDoctorReport;
  checkpoint?: AgentRuntimeCheckpoint | null;
  needsApproval?: boolean;
  persist?: boolean;
}

export interface SupervisorKernelResult {
  run: SupervisorRun;
  report: SupervisorDoctorReport;
  participants: SupervisorParticipant[];
  blackboard: SupervisorBlackboard;
  blackboardPatches: SupervisorBlackboardPatch[];
  agendaItems: SupervisorAgendaItem[];
  handoffs: SupervisorHandoffMessage[];
  decisions: SupervisorDecision[];
  termination: SupervisorTerminationCondition;
  loopState: SupervisorLoopState;
  budget: SupervisorBudget;
  replayPacket: SupervisorReplayPacket;
}

function sourceRefsJson(): string {
  return runtimeSafeJson(
    [...SUPERVISOR_SOURCE_REFS, ...AGENT_RUNTIME_SOURCE_REFS],
    3600,
  );
}

function participantTargets(
  role: SupervisorParticipantRole,
): SupervisorParticipantRole[] {
  switch (role) {
    case 'planner':
      return ['memory_curator', 'evidence_scout', 'approval_stager'];
    case 'memory_curator':
      return ['evidence_scout', 'verifier'];
    case 'evidence_scout':
      return ['tool_executor', 'verifier'];
    case 'tool_executor':
      return ['verifier', 'approval_stager'];
    case 'verifier':
      return ['truth_calibrator', 'approval_stager'];
    case 'truth_calibrator':
      return ['final_arbiter', 'approval_stager'];
    case 'approval_stager':
      return ['final_arbiter'];
    case 'final_arbiter':
      return [];
  }
}

function participantInstructions(role: SupervisorParticipantRole): string {
  switch (role) {
    case 'planner':
      return 'Frames the user goal, task family, stop condition, and safe next handoff.';
    case 'memory_curator':
      return 'Selects sanitized memory, skill, and project metadata without raw private content.';
    case 'evidence_scout':
      return 'Collects evidence IDs, proof debt, and freshness gaps before tools or answer work.';
    case 'tool_executor':
      return 'Runs or stages only policy-approved read-only work; mutations become approval packets.';
    case 'verifier':
      return 'Checks support, provider/integration blockers, budget, and fake participation risk.';
    case 'truth_calibrator':
      return 'Shapes answer certainty around supported claims, stale proof, and missing premises.';
    case 'approval_stager':
      return 'Stops side effects and emits a resume-ready approval path.';
    case 'final_arbiter':
      return 'Chooses final answer, clarification, blocker, or next safe action.';
  }
}

function makeParticipant(input: {
  supervisorRunId: string;
  role: SupervisorParticipantRole;
  activeRole: SupervisorParticipantRole;
}): SupervisorParticipant {
  return {
    participantId: runtimeSanitizeId(
      `supervisor:participant:${input.supervisorRunId}:${input.role}`,
    ),
    supervisorRunId: input.supervisorRunId,
    role: input.role,
    displayName: input.role
      .split('_')
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(' '),
    status: input.role === input.activeRole ? 'active' : 'available',
    instructionsSummary: participantInstructions(input.role),
    toolPolicyJson: runtimeSafeJson(
      {
        readOnlyAllowed:
          input.role === 'tool_executor' || input.role === 'evidence_scout',
        mutatingActions: 'approval_staged_only',
        maxReadOnlyToolSteps: DEFAULT_BUDGET.maxReadOnlyToolSteps,
      },
      1200,
    ),
    handoffTargetsJson: runtimeSafeJson(participantTargets(input.role), 1200),
    sourceRefsJson: sourceRefsJson(),
    privacyJson: runtimePrivacyJson(),
  };
}

function extractEvidenceIds(worldReport: WorldModelDoctorReport): string[] {
  return Array.from(
    new Set(
      [
        worldReport.snapshot.snapshotId,
        ...worldReport.evidenceRefs.map((ref) => ref.evidenceRefId),
        ...worldReport.claims.map((claim) => claim.claimId),
        ...worldReport.verificationNeeds.map((need) => need.needId),
        ...worldReport.openQuestions.map((question) => question.questionId),
      ].filter(Boolean),
    ),
  ).slice(0, 120);
}

function unsafeBlackboardPayload(value: unknown): string | null {
  const serialized = JSON.stringify(value ?? null);
  if (UNSAFE_BLACKBOARD_RE.test(serialized)) {
    return 'unsafe_or_raw_content_detected';
  }
  return null;
}

export function makeSupervisorBlackboardPatch(input: {
  blackboardId: string;
  supervisorRunId: string;
  generatedAt: string;
  participantRole: SupervisorParticipantRole;
  patchKind: SupervisorBlackboardPatch['patchKind'];
  summary: string;
  refs?: string[];
  patch: Record<string, unknown>;
}): SupervisorBlackboardPatch {
  const rejectionReason = unsafeBlackboardPayload(input.patch);
  return {
    patchId: runtimeSanitizeId(
      runtimeHashId(
        'supervisor:patch',
        [
          input.supervisorRunId,
          input.blackboardId,
          input.participantRole,
          input.patchKind,
          input.summary,
          (input.refs || []).join(','),
        ].join('|'),
      ),
    ),
    blackboardId: input.blackboardId,
    supervisorRunId: input.supervisorRunId,
    createdAt: input.generatedAt,
    participantRole: input.participantRole,
    patchKind: input.patchKind,
    summary: redactCouncilText(input.summary, 900),
    refsJson: runtimeSafeJson(input.refs || [], 2400),
    patchJson: rejectionReason
      ? runtimeSafeJson(
          {
            rejected: true,
            rejectionReason,
            metadataOnly: true,
          },
          1200,
        )
      : runtimeSafeJson(input.patch, 3200),
    rejected: Boolean(rejectionReason),
    rejectionReason,
    privacyJson: runtimePrivacyJson(),
  };
}

function makeAgendaItem(input: {
  supervisorRunId: string;
  generatedAt: string;
  position: number;
  ownerRole: SupervisorParticipantRole;
  itemKind: SupervisorAgendaItem['itemKind'];
  status: SupervisorAgendaItem['status'];
  policyClass: SupervisorAgendaItem['policyClass'];
  requiredEvidence?: string[];
  resultRefs?: string[];
  summary: string;
  nextAction: string;
}): SupervisorAgendaItem {
  return {
    agendaItemId: runtimeSanitizeId(
      `supervisor:agenda:${input.supervisorRunId}:${input.position}:${input.itemKind}`,
    ),
    supervisorRunId: input.supervisorRunId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    position: input.position,
    ownerRole: input.ownerRole,
    itemKind: input.itemKind,
    status: input.status,
    policyClass: input.policyClass,
    requiredEvidenceJson: runtimeSafeJson(input.requiredEvidence || [], 2400),
    resultRefsJson: runtimeSafeJson(input.resultRefs || [], 2400),
    summary: redactCouncilText(input.summary, 900),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

function makeHandoff(input: {
  supervisorRunId: string;
  generatedAt: string;
  fromRole: SupervisorParticipantRole;
  toRole: SupervisorParticipantRole;
  status?: SupervisorHandoffMessage['status'];
  reason: string;
  payload?: Record<string, unknown>;
  nextAction: string;
}): SupervisorHandoffMessage {
  return {
    handoffId: runtimeSanitizeId(
      runtimeHashId(
        'supervisor:handoff',
        [
          input.supervisorRunId,
          input.fromRole,
          input.toRole,
          input.reason,
        ].join('|'),
      ),
    ),
    supervisorRunId: input.supervisorRunId,
    createdAt: input.generatedAt,
    fromRole: input.fromRole,
    toRole: input.toRole,
    status: input.status || 'completed',
    reason: redactCouncilText(input.reason, 900),
    payloadJson: runtimeSafeJson(
      {
        ...(input.payload || {}),
        swarmStyle: 'explicit_handoff_message',
      },
      2400,
    ),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

function makeDecision(input: {
  supervisorRunId: string;
  generatedAt: string;
  participantRole: SupervisorParticipantRole;
  decisionKind: SupervisorDecision['decisionKind'];
  decision: SupervisorDecision['decision'];
  confidence: number;
  evidenceRefs?: string[];
  riskFlags?: string[];
  reason: string;
  nextAction: string;
}): SupervisorDecision {
  return {
    decisionId: runtimeSanitizeId(
      runtimeHashId(
        'supervisor:decision',
        [
          input.supervisorRunId,
          input.participantRole,
          input.decisionKind,
          input.decision,
          input.reason,
        ].join('|'),
      ),
    ),
    supervisorRunId: input.supervisorRunId,
    createdAt: input.generatedAt,
    participantRole: input.participantRole,
    decisionKind: input.decisionKind,
    decision: input.decision,
    confidence: Number(Math.max(0, Math.min(1, input.confidence)).toFixed(3)),
    evidenceRefsJson: runtimeSafeJson(input.evidenceRefs || [], 2400),
    riskFlagsJson: runtimeSafeJson(input.riskFlags || [], 2400),
    reason: redactCouncilText(input.reason, 900),
    nextAction: redactCouncilText(input.nextAction, 900),
    privacyJson: runtimePrivacyJson(),
  };
}

function terminationReasonFor(input: {
  mode: AgentRuntimeSpineMode;
  needsApproval: boolean;
  worldReport: WorldModelDoctorReport;
}): SupervisorTerminationCondition['reason'] {
  if (input.mode === 'shadow') return 'shadow_mode';
  if (input.needsApproval || input.worldReport.proofDebt.approvalRequired > 0) {
    return 'approval_required';
  }
  if (
    input.worldReport.openQuestions.length > 0 &&
    input.worldReport.snapshot.confidence < 0.45
  ) {
    return 'evidence_gap';
  }
  return 'final_answer_ready';
}

function nextActionForTermination(
  reason: SupervisorTerminationCondition['reason'],
  worldReport: WorldModelDoctorReport,
): string {
  if (reason === 'approval_required') {
    return 'Stage approval and resume only after explicit user confirmation.';
  }
  if (reason === 'evidence_gap') {
    return (
      worldReport.openQuestions[0]?.nextAction ||
      'Ask one clarifying question before making a high-certainty claim.'
    );
  }
  if (reason === 'shadow_mode') {
    return 'Runtime spine is in shadow mode; report supervisor diagnostics without steering behavior.';
  }
  return (
    worldReport.nextAction ||
    'Finalize the answer with current evidence and the safest useful next action.'
  );
}

function buildSupervisorArtifacts(
  input: BeginSupervisorKernelInput,
): SupervisorKernelResult {
  const goal = redactCouncilText(input.goal || 'Inspect Andrea state.', 900);
  const supervisorRunId = runtimeSanitizeId(
    runtimeHashId(
      'supervisor:run',
      `${input.runtimeRunId}|${input.generatedAt}|${goal}`,
    ),
  );
  const blackboardId = runtimeSanitizeId(
    `supervisor:blackboard:${supervisorRunId}`,
  );
  const budgetId = runtimeSanitizeId(`supervisor:budget:${supervisorRunId}`);
  const evidenceIds = extractEvidenceIds(input.worldReport);
  const claimIds = input.worldReport.claims
    .map((claim) => claim.claimId)
    .slice(0, 80);
  const needsApproval = Boolean(input.needsApproval);
  const terminationReason = terminationReasonFor({
    mode: input.mode,
    needsApproval,
    worldReport: input.worldReport,
  });
  const nextAction = nextActionForTermination(
    terminationReason,
    input.worldReport,
  );
  const activeRole: SupervisorParticipantRole =
    terminationReason === 'approval_required'
      ? 'approval_stager'
      : 'final_arbiter';
  const status: SupervisorRun['status'] =
    input.mode === 'shadow'
      ? 'shadowed'
      : terminationReason === 'approval_required'
        ? 'awaiting_approval'
        : terminationReason === 'evidence_gap'
          ? 'terminated'
          : 'completed';

  const participants = PARTICIPANT_ROLES.map((role) =>
    makeParticipant({ supervisorRunId, role, activeRole }),
  );
  const blackboard: SupervisorBlackboard = {
    blackboardId,
    supervisorRunId,
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status:
      status === 'completed' || status === 'shadowed'
        ? 'closed'
        : 'checkpointed',
    goalSummary: goal,
    evidenceIdsJson: runtimeSafeJson(evidenceIds, 3200),
    claimIdsJson: runtimeSafeJson(claimIds, 2400),
    proofDebtJson: runtimeSafeJson(input.worldReport.proofDebt, 1200),
    blockerJson: runtimeSafeJson(
      {
        terminationReason,
        riskStates: input.worldReport.riskStates.map((risk) => ({
          riskId: risk.riskId,
          riskClass: risk.riskClass,
          severity: risk.severity,
          status: risk.status,
        })),
      },
      2400,
    ),
    handoffStateJson: runtimeSafeJson(
      {
        activeRole,
        explicitHandoffPolicy: 'handoff_message_first_then_supervisor_policy',
        maxTurns: DEFAULT_BUDGET.maxTurns,
      },
      1200,
    ),
    approvalStateJson: runtimeSafeJson(
      {
        approvalRequired: terminationReason === 'approval_required',
        mutatingActionsExecuted: false,
        resumeTokenRequired: terminationReason === 'approval_required',
      },
      1200,
    ),
    nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  const blackboardPatches = [
    makeSupervisorBlackboardPatch({
      blackboardId,
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'planner',
      patchKind: 'goal',
      summary: `Supervisor framed ${input.taskFamily} goal with deterministic budget.`,
      refs: [input.runtimeRunId],
      patch: {
        goalSummary: goal,
        taskFamily: input.taskFamily,
        mode: input.mode,
        maxTurns: DEFAULT_BUDGET.maxTurns,
      },
    }),
    makeSupervisorBlackboardPatch({
      blackboardId,
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'evidence_scout',
      patchKind: 'evidence',
      summary: `World Model contributed ${evidenceIds.length} evidence/proof refs.`,
      refs: evidenceIds,
      patch: {
        evidenceIds,
        snapshotId: input.worldReport.snapshot.snapshotId,
        snapshotStatus: input.worldReport.snapshot.status,
        confidence: input.worldReport.snapshot.confidence,
      },
    }),
    makeSupervisorBlackboardPatch({
      blackboardId,
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'verifier',
      patchKind: 'proof_debt',
      summary: `Proof debt totals ${input.worldReport.proofDebt.total}; approval-required debt ${input.worldReport.proofDebt.approvalRequired}.`,
      refs: input.worldReport.verificationNeeds.map((need) => need.needId),
      patch: {
        proofDebt: input.worldReport.proofDebt,
        runnableReadOnlyNeeds: input.worldReport.verificationNeeds
          .filter((need) => need.status === 'runnable_read_only')
          .map((need) => need.needId),
      },
    }),
    makeSupervisorBlackboardPatch({
      blackboardId,
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: activeRole,
      patchKind:
        terminationReason === 'approval_required' ? 'approval' : 'next_action',
      summary: nextAction,
      refs: [input.checkpoint?.checkpointId || '', blackboardId].filter(
        Boolean,
      ),
      patch: {
        terminationReason,
        nextAction,
        sideEffectsExecuted: false,
        approvalRequired: terminationReason === 'approval_required',
      },
    }),
  ];

  const readOnlyNeedIds = input.worldReport.verificationNeeds
    .filter(
      (need) =>
        need.safeToRunAutomatically && need.actionKind === 'read_only_check',
    )
    .map((need) => need.needId);
  const readOnlyAgendaStatus: SupervisorAgendaItem['status'] = input.worldReport
    .safeVerificationRan
    ? 'completed'
    : readOnlyNeedIds.length > 0 && !needsApproval
      ? 'planned'
      : 'skipped';
  const agendaItems = [
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 1,
      ownerRole: 'planner',
      itemKind: 'frame_goal',
      status: 'completed',
      policyClass: 'local_lookup',
      resultRefs: [input.runtimeRunId],
      summary: 'Goal framed and supervisor budget selected.',
      nextAction: 'Hand off to memory curator and evidence scout.',
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 2,
      ownerRole: 'memory_curator',
      itemKind: 'compile_memory',
      status: input.worldReport.skillTrust.length ? 'completed' : 'skipped',
      policyClass: 'local_lookup',
      resultRefs: input.worldReport.skillTrust.map(
        (skill) => skill.skillTrustId,
      ),
      summary:
        'Compiled sanitized skill trust and memory-block style metadata.',
      nextAction: 'Use source IDs only; never raw private bodies.',
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 3,
      ownerRole: 'evidence_scout',
      itemKind: 'gather_evidence',
      status: 'completed',
      policyClass: 'local_lookup',
      requiredEvidence: ['world_snapshot', 'claim_ids', 'verification_needs'],
      resultRefs: evidenceIds,
      summary:
        'Gathered current World Model evidence IDs and proof-debt metadata.',
      nextAction: 'Decide whether a policy-approved read-only check is useful.',
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 4,
      ownerRole: 'tool_executor',
      itemKind: 'run_read_only_tool',
      status: readOnlyAgendaStatus,
      policyClass: needsApproval ? 'approval_staged' : 'read_only',
      requiredEvidence: readOnlyNeedIds,
      resultRefs: input.worldReport.safeVerificationRan ? readOnlyNeedIds : [],
      summary: input.worldReport.safeVerificationRan
        ? 'Safe read-only verification has already run and is represented as evidence metadata.'
        : readOnlyNeedIds.length
          ? 'Safe read-only verification is available for the next bounded executor pass.'
          : 'No safe automatic read-only check is required for this turn.',
      nextAction: needsApproval
        ? 'Do not run tools; stage approval first.'
        : 'Proceed to verifier with current evidence and runnable proof debt.',
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 5,
      ownerRole: 'verifier',
      itemKind: 'verify',
      status: 'completed',
      policyClass: 'local_lookup',
      requiredEvidence: evidenceIds.slice(0, 20),
      resultRefs: claimIds,
      summary:
        'Verified that routing should respect proof debt, provider blockers, and approval boundaries.',
      nextAction: 'Hand off to truth calibrator.',
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 6,
      ownerRole: 'truth_calibrator',
      itemKind: 'calibrate_truth',
      status: 'completed',
      policyClass: 'local_lookup',
      resultRefs: [input.worldReport.snapshot.snapshotId],
      summary:
        'Calibrated answer shape against current evidence and stale proof.',
      nextAction,
    }),
    makeAgendaItem({
      supervisorRunId,
      generatedAt: input.generatedAt,
      position: 7,
      ownerRole:
        terminationReason === 'approval_required'
          ? 'approval_stager'
          : 'final_arbiter',
      itemKind:
        terminationReason === 'approval_required'
          ? 'stage_approval'
          : 'finalize',
      status:
        terminationReason === 'approval_required'
          ? 'approval_staged'
          : 'completed',
      policyClass:
        terminationReason === 'approval_required'
          ? 'approval_staged'
          : 'local_lookup',
      resultRefs: [blackboardId],
      summary:
        terminationReason === 'approval_required'
          ? 'Stopped immediately at approval-required boundary.'
          : 'Final arbiter can answer or name the next safe verification step.',
      nextAction,
    }),
  ];

  const handoffs = [
    makeHandoff({
      supervisorRunId,
      generatedAt: input.generatedAt,
      fromRole: 'planner',
      toRole: 'memory_curator',
      reason:
        'Planner requested sanitized memory/skill context before evidence routing.',
      nextAction: 'Memory curator forwards source IDs to evidence scout.',
    }),
    makeHandoff({
      supervisorRunId,
      generatedAt: input.generatedAt,
      fromRole: 'memory_curator',
      toRole: 'evidence_scout',
      reason:
        'Memory context compiled; evidence scout should inspect proof debt and source coverage.',
      nextAction: 'Evidence scout updates blackboard with proof debt.',
    }),
    makeHandoff({
      supervisorRunId,
      generatedAt: input.generatedAt,
      fromRole: 'evidence_scout',
      toRole: 'verifier',
      reason:
        'Evidence IDs and verification needs are available for support checking.',
      nextAction: 'Verifier checks blocker and fake-participation risk.',
    }),
    makeHandoff({
      supervisorRunId,
      generatedAt: input.generatedAt,
      fromRole: 'verifier',
      toRole: 'truth_calibrator',
      reason: 'Verifier passed current metadata to truth calibration.',
      nextAction:
        'Truth calibrator selects certainty, caveat, or clarification shape.',
    }),
    makeHandoff({
      supervisorRunId,
      generatedAt: input.generatedAt,
      fromRole: 'truth_calibrator',
      toRole: activeRole,
      reason:
        activeRole === 'approval_stager'
          ? 'Truth calibration found an approval-required boundary.'
          : 'Truth calibration found enough metadata for final arbiter.',
      nextAction,
    }),
  ];
  const decisions = [
    makeDecision({
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'planner',
      decisionKind: 'route',
      decision: 'handoff',
      confidence: 0.82,
      evidenceRefs: [input.runtimeRunId],
      reason:
        'Use explicit handoffs and a bounded turn budget instead of free-form role chatter.',
      nextAction: 'Route to memory curator, then evidence scout.',
    }),
    makeDecision({
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'tool_executor',
      decisionKind: 'tool_policy',
      decision:
        terminationReason === 'approval_required'
          ? 'stage_approval'
          : readOnlyAgendaStatus === 'planned'
            ? 'run_read_only'
            : 'continue',
      confidence: terminationReason === 'approval_required' ? 0.96 : 0.74,
      evidenceRefs: readOnlyNeedIds,
      riskFlags:
        terminationReason === 'approval_required' ? ['approval_required'] : [],
      reason:
        terminationReason === 'approval_required'
          ? 'Mutating or approval-required state detected; no tool side effect may run.'
          : 'Read-only verification is safe only when World Model marks it runnable.',
      nextAction,
    }),
    makeDecision({
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: 'verifier',
      decisionKind: 'answer_shape',
      decision:
        terminationReason === 'evidence_gap' ? 'ask_clarification' : 'finalize',
      confidence: Number(input.worldReport.snapshot.confidence.toFixed(3)),
      evidenceRefs: evidenceIds.slice(0, 40),
      riskFlags: input.worldReport.riskStates.map((risk) => risk.riskClass),
      reason:
        'Answer shape is constrained by current evidence freshness and proof debt.',
      nextAction,
    }),
    makeDecision({
      supervisorRunId,
      generatedAt: input.generatedAt,
      participantRole: activeRole,
      decisionKind: 'termination',
      decision:
        terminationReason === 'approval_required'
          ? 'stage_approval'
          : 'finalize',
      confidence: terminationReason === 'approval_required' ? 0.97 : 0.78,
      evidenceRefs: [blackboardId, input.checkpoint?.checkpointId || ''].filter(
        Boolean,
      ),
      riskFlags:
        terminationReason === 'approval_required'
          ? ['side_effect_boundary']
          : [],
      reason: `Supervisor termination condition met: ${terminationReason}.`,
      nextAction,
    }),
  ];
  const termination: SupervisorTerminationCondition = {
    terminationId: runtimeSanitizeId(
      `supervisor:termination:${supervisorRunId}`,
    ),
    supervisorRunId,
    createdAt: input.generatedAt,
    reason: terminationReason,
    status: 'met',
    summary: redactCouncilText(
      `Supervisor stopped with ${terminationReason}.`,
      900,
    ),
    nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  const completedAgendaIds = agendaItems
    .filter(
      (item) =>
        item.status === 'completed' || item.status === 'approval_staged',
    )
    .map((item) => item.agendaItemId);
  const pendingAgendaIds = agendaItems
    .filter((item) => item.status === 'planned' || item.status === 'running')
    .map((item) => item.agendaItemId);
  const loopState: SupervisorLoopState = {
    loopStateId: runtimeSanitizeId(`supervisor:loop:${supervisorRunId}`),
    supervisorRunId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    turnIndex: Math.min(DEFAULT_BUDGET.maxTurns, handoffs.length + 1),
    activeRole,
    nextRole: pendingAgendaIds.length ? 'tool_executor' : null,
    maxTurns: DEFAULT_BUDGET.maxTurns,
    completedAgendaIdsJson: runtimeSafeJson(completedAgendaIds, 2400),
    pendingAgendaIdsJson: runtimeSafeJson(pendingAgendaIds, 2400),
    terminationId: termination.terminationId,
    status:
      terminationReason === 'approval_required'
        ? 'awaiting_approval'
        : 'terminated',
    privacyJson: runtimePrivacyJson(),
  };
  const budget: SupervisorBudget = {
    budgetId,
    supervisorRunId,
    createdAt: input.generatedAt,
    maxTurns: DEFAULT_BUDGET.maxTurns,
    maxReadOnlyToolSteps: DEFAULT_BUDGET.maxReadOnlyToolSteps,
    maxCouncilCalls: DEFAULT_BUDGET.maxCouncilCalls,
    maxClarificationRequests: DEFAULT_BUDGET.maxClarificationRequests,
    usedTurns: loopState.turnIndex,
    usedReadOnlyToolSteps: input.worldReport.safeVerificationRan ? 1 : 0,
    usedCouncilCalls: 0,
    usedClarificationRequests: terminationReason === 'evidence_gap' ? 1 : 0,
    exhausted: loopState.turnIndex >= DEFAULT_BUDGET.maxTurns,
    nextAction:
      loopState.turnIndex >= DEFAULT_BUDGET.maxTurns
        ? 'Stop supervisor loop and report max-turn termination before another handoff.'
        : nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  const replayPacket: SupervisorReplayPacket = {
    replayPacketId: runtimeSanitizeId(`supervisor:replay:${supervisorRunId}`),
    supervisorRunId,
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    blackboardId,
    checkpointIdsJson: runtimeSafeJson(
      [input.checkpoint?.checkpointId].filter(Boolean),
      1200,
    ),
    handoffIdsJson: runtimeSafeJson(
      handoffs.map((handoff) => handoff.handoffId),
      2400,
    ),
    decisionIdsJson: runtimeSafeJson(
      decisions.map((decision) => decision.decisionId),
      2400,
    ),
    agendaItemIdsJson: runtimeSafeJson(
      agendaItems.map((item) => item.agendaItemId),
      2400,
    ),
    terminationId: termination.terminationId,
    summary: redactCouncilText(
      `Replay supervisor blackboard ${blackboardId} with ${handoffs.length} handoff(s), ${decisions.length} decision(s), termination ${terminationReason}.`,
      900,
    ),
    privacy: runtimePrivacyReport(),
  };
  const run: SupervisorRun = {
    supervisorRunId,
    runtimeRunId: input.runtimeRunId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    status,
    mode: input.mode,
    goalSummary: goal,
    activeParticipant: activeRole,
    turnCount: loopState.turnIndex,
    readOnlyToolSteps: budget.usedReadOnlyToolSteps,
    councilCalls: budget.usedCouncilCalls,
    clarificationRequests: budget.usedClarificationRequests,
    blackboardId,
    budgetId,
    terminationId: termination.terminationId,
    participantIdsJson: runtimeSafeJson(
      participants.map((participant) => participant.participantId),
      2400,
    ),
    agendaItemIdsJson: runtimeSafeJson(
      agendaItems.map((item) => item.agendaItemId),
      2400,
    ),
    handoffIdsJson: runtimeSafeJson(
      handoffs.map((handoff) => handoff.handoffId),
      2400,
    ),
    decisionIdsJson: runtimeSafeJson(
      decisions.map((decision) => decision.decisionId),
      2400,
    ),
    blackboardPatchIdsJson: runtimeSafeJson(
      blackboardPatches.map((patch) => patch.patchId),
      2400,
    ),
    replayPacketId: replayPacket.replayPacketId,
    nextAction,
    privacyJson: runtimePrivacyJson(),
  };
  const report = supervisorReportFromParts({
    generatedAt: input.generatedAt,
    run,
    participants,
    blackboard,
    blackboardPatches,
    agendaItems,
    handoffs,
    decisions,
    terminations: [termination],
    loopStates: [loopState],
    budgets: [budget],
    replayPackets: [replayPacket],
  });
  return {
    run,
    report,
    participants,
    blackboard,
    blackboardPatches,
    agendaItems,
    handoffs,
    decisions,
    termination,
    loopState,
    budget,
    replayPacket,
  };
}

export function persistSupervisorKernelResult(
  result: SupervisorKernelResult,
): void {
  upsertSupervisorRun(result.run);
  for (const participant of result.participants)
    upsertSupervisorParticipant(participant);
  upsertSupervisorBlackboard(result.blackboard);
  for (const patch of result.blackboardPatches)
    upsertSupervisorBlackboardPatch(patch);
  for (const item of result.agendaItems) upsertSupervisorAgendaItem(item);
  for (const handoff of result.handoffs)
    upsertSupervisorHandoffMessage(handoff);
  for (const decision of result.decisions) upsertSupervisorDecision(decision);
  upsertSupervisorTerminationCondition(result.termination);
  upsertSupervisorLoopState(result.loopState);
  upsertSupervisorBudget(result.budget);
  upsertSupervisorReplayPacket(result.replayPacket);
}

export function beginSupervisorKernelRun(
  input: BeginSupervisorKernelInput,
): SupervisorKernelResult {
  const result = buildSupervisorArtifacts(input);
  const persist = input.persist !== false && isDatabaseInitialized();
  if (persist) {
    persistSupervisorKernelResult(result);
    return {
      ...result,
      report: buildSupervisorDoctorReport({
        supervisorRunId: result.run.supervisorRunId,
        generatedAt: input.generatedAt,
      }),
    };
  }
  return result;
}

function supervisorReportFromParts(input: {
  generatedAt: string;
  run: SupervisorRun | null;
  participants: SupervisorParticipant[];
  blackboard: SupervisorBlackboard | null;
  blackboardPatches: SupervisorBlackboardPatch[];
  agendaItems: SupervisorAgendaItem[];
  handoffs: SupervisorHandoffMessage[];
  decisions: SupervisorDecision[];
  terminations: SupervisorTerminationCondition[];
  loopStates: SupervisorLoopState[];
  budgets: SupervisorBudget[];
  replayPackets: SupervisorReplayPacket[];
}): SupervisorDoctorReport {
  const rejectedPatches = input.blackboardPatches.filter(
    (patch) => patch.rejected,
  ).length;
  const blockedDecisions = input.decisions.filter(
    (decision) => decision.decision === 'block',
  ).length;
  return {
    generatedAt: input.generatedAt,
    ok: Boolean(input.run) && rejectedPatches === 0 && blockedDecisions === 0,
    latestRun: input.run,
    participants: input.participants,
    blackboard: input.blackboard,
    blackboardPatches: input.blackboardPatches,
    agendaItems: input.agendaItems,
    handoffs: input.handoffs,
    decisions: input.decisions,
    terminations: input.terminations,
    loopStates: input.loopStates,
    budgets: input.budgets,
    replayPackets: input.replayPackets,
    nextAction: input.run
      ? input.run.nextAction
      : 'No supervisor run exists yet; process a runtime-spine turn or run debug:supervisor after Andrea handles a goal.',
    privacy: runtimePrivacyReport(),
  };
}

export function buildSupervisorDoctorReport(
  params: {
    supervisorRunId?: string | null;
    runtimeRunId?: string | null;
    generatedAt?: string;
  } = {},
): SupervisorDoctorReport {
  const generatedAt = params.generatedAt || new Date().toISOString();
  if (!isDatabaseInitialized()) {
    return supervisorReportFromParts({
      generatedAt,
      run: null,
      participants: [],
      blackboard: null,
      blackboardPatches: [],
      agendaItems: [],
      handoffs: [],
      decisions: [],
      terminations: [],
      loopStates: [],
      budgets: [],
      replayPackets: [],
    });
  }
  const run = params.supervisorRunId
    ? listSupervisorRuns({ limit: 500 }).find(
        (item) => item.supervisorRunId === params.supervisorRunId,
      ) || null
    : params.runtimeRunId
      ? listSupervisorRuns({
          runtimeRunId: params.runtimeRunId,
          limit: 1,
        })[0] || null
      : listSupervisorRuns({ limit: 1 })[0] || null;
  if (!run) {
    return supervisorReportFromParts({
      generatedAt,
      run: null,
      participants: [],
      blackboard: null,
      blackboardPatches: [],
      agendaItems: [],
      handoffs: [],
      decisions: [],
      terminations: [],
      loopStates: [],
      budgets: [],
      replayPackets: [],
    });
  }
  const blackboard =
    listSupervisorBlackboards({
      supervisorRunId: run.supervisorRunId,
      limit: 1,
    })[0] || null;
  return supervisorReportFromParts({
    generatedAt,
    run,
    participants: listSupervisorParticipants({
      supervisorRunId: run.supervisorRunId,
      limit: 50,
    }),
    blackboard,
    blackboardPatches: listSupervisorBlackboardPatches({
      supervisorRunId: run.supervisorRunId,
      limit: 200,
    }),
    agendaItems: listSupervisorAgendaItems({
      supervisorRunId: run.supervisorRunId,
      limit: 100,
    }),
    handoffs: listSupervisorHandoffMessages({
      supervisorRunId: run.supervisorRunId,
      limit: 100,
    }),
    decisions: listSupervisorDecisions({
      supervisorRunId: run.supervisorRunId,
      limit: 100,
    }),
    terminations: listSupervisorTerminationConditions({
      supervisorRunId: run.supervisorRunId,
      limit: 20,
    }),
    loopStates: listSupervisorLoopStates({
      supervisorRunId: run.supervisorRunId,
      limit: 20,
    }),
    budgets: listSupervisorBudgets({
      supervisorRunId: run.supervisorRunId,
      limit: 20,
    }),
    replayPackets: listSupervisorReplayPackets({
      supervisorRunId: run.supervisorRunId,
      limit: 20,
    }),
  });
}

export function formatSupervisorDoctorReport(
  report: SupervisorDoctorReport,
): string {
  const run = report.latestRun;
  const termination = report.terminations[0];
  return redactCouncilText(
    [
      'Supervisor Core',
      '',
      `Status: ${run?.status || 'none'}`,
      `Run: ${run?.supervisorRunId || 'none'}`,
      `Runtime run: ${run?.runtimeRunId || 'none'}`,
      `Active participant: ${run?.activeParticipant || 'none'}`,
      `Blackboard: ${report.blackboard?.blackboardId || 'none'}`,
      `Patches: ${report.blackboardPatches.length} (${report.blackboardPatches.filter((patch) => patch.rejected).length} rejected)`,
      `Agenda: ${report.agendaItems.length}`,
      `Handoffs: ${report.handoffs.length}`,
      `Decisions: ${report.decisions.length}`,
      `Termination: ${termination?.reason || 'none'}`,
      `Budget: ${run?.turnCount || 0}/${report.budgets[0]?.maxTurns || DEFAULT_BUDGET.maxTurns} turns, ${run?.readOnlyToolSteps || 0}/${report.budgets[0]?.maxReadOnlyToolSteps || DEFAULT_BUDGET.maxReadOnlyToolSteps} read-only tool steps`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only blackboard; no raw prompts, private message bodies, hidden reasoning, provider debates, raw tool output, or secrets are stored.',
    ].join('\n'),
    5000,
  );
}

export function buildSupervisorStatusText(): string {
  return formatSupervisorDoctorReport(buildSupervisorDoctorReport());
}

export function isSupervisorNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'supervisor status' ||
    normalized === 'blackboard status' ||
    normalized === 'what are you working on?' ||
    normalized === 'what should you verify next?' ||
    normalized === 'resume that' ||
    normalized === 'why did you choose that?' ||
    /\bsupervisor\b.*\b(status|blackboard|handoff|working|verify)\b/i.test(
      normalized,
    )
  );
}

export function buildSupervisorReplayPacket(
  supervisorRunId: string,
): SupervisorReplayPacket | null {
  if (!isDatabaseInitialized()) return null;
  return listSupervisorReplayPackets({ supervisorRunId, limit: 1 })[0] || null;
}

export function supervisorCompletedAgendaIds(
  report: SupervisorDoctorReport,
): string[] {
  return report.loopStates.flatMap((state) =>
    runtimeParseJsonArray(state.completedAgendaIdsJson),
  );
}
