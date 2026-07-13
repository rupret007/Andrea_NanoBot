import { createHash } from 'node:crypto';

import {
  beginAgentRuntimeSpineRun,
  buildAgentRuntimeSpineReport,
  finalizeAgentRuntimeSpineOutcome,
  recordAgentRuntimeTruthAudit,
} from './agent-runtime-spine.js';
import type { PlatformTaskFamily } from './andrea-platform-bridge.js';
import {
  runtimePrivacyJson,
  runtimePrivacyReport,
  runtimeSafeJson,
  runtimeSanitizeId,
} from './agent-runtime-glue.js';
import { redactCouncilText } from './council-safety.js';
import {
  beginCognitiveKernelRun,
  finalizeCognitiveKernelOutcome,
} from './cognitive-kernel.js';
import {
  getAgencyConvergenceRun,
  isDatabaseInitialized,
  listAgencyConvergenceAgendas,
  listAgencyConvergenceDecisions,
  listAgencyConvergenceRuns,
  listAgencyLoopOutcomes,
  listAgencyProviderParticipationPlans,
  listAgencyResumePlans,
  listCognitiveProviderCooldowns,
  upsertAgencyConvergenceAgenda,
  upsertAgencyConvergenceDecision,
  upsertAgencyConvergenceRun,
  upsertAgencyLoopOutcome,
  upsertAgencyProviderParticipationPlan,
  upsertAgencyResumePlan,
} from './db.js';
import {
  buildDurableContinuityReport,
  formatDurableContinuityForOperator,
  type DurableContinuityReport,
} from './durable-work-continuity.js';
import { beginLogicKernelRun } from './logic-kernel.js';
import { collectProviderHealthSnapshots } from './provider-health.js';
import type { ProviderHealthSnapshot } from './provider-health.js';
import { collectProviderHealthSnapshotsWithLiveProbe } from './provider-live-probe.js';
import {
  buildSessionGraphReport,
  formatSessionContinuityCockpit,
} from './session-graph.js';
import { runTruthEngine } from './truth-engine.js';
import { buildWorldModelReport } from './world-model.js';
import type {
  AgencyConvergenceAgenda,
  AgencyConvergenceDecision,
  AgencyConvergenceDoctorReport,
  AgencyConvergenceMode,
  AgencyConvergenceRun,
  AgencyLoopOutcome,
  AgencyProviderParticipationPlan,
  AgencyResumePlan,
  AgentRuntimeSpineReport,
  SessionContinuityActionItem,
  SessionContinuityActionKind,
  SessionGraphDoctorReport,
} from './types.js';

interface SelectedAgencyAction {
  action: SessionContinuityActionItem | null;
  policyClass: AgencyConvergenceAgenda['policyClass'];
  decisionKind: AgencyConvergenceDecision['decisionKind'];
  decisionStatus: AgencyConvergenceDecision['status'];
  reason: string;
  nextAction: string;
  riskFlags: string[];
}

export interface RunAgencyConvergenceLoopInput {
  generatedAt?: string;
  mode?: AgencyConvergenceMode;
  intentText?: string | null;
  groupFolder?: string;
  persist?: boolean;
  liveProviderProbe?: boolean;
  providerSnapshots?: ProviderHealthSnapshot[];
}

export type AgencyConvergenceContinuityReport =
  AgencyConvergenceDoctorReport & {
    durableContinuity: DurableContinuityReport;
  };

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

function resolveMode(mode?: AgencyConvergenceMode): AgencyConvergenceMode {
  const configured = (
    mode ||
    process.env.AGENCY_CONVERGENCE_MODE ||
    process.env.AGENT_RUNTIME_SPINE_MODE ||
    'assistive'
  ).toLowerCase();
  return configured === 'off' || configured === 'shadow'
    ? configured
    : 'assistive';
}

function wantsResume(intentText?: string | null): boolean {
  return /\b(resume that|keep going|what'?s next|continue|next step)\b/i.test(
    intentText || '',
  );
}

function taskFamilyFor(
  action: SessionContinuityActionItem | null,
): PlatformTaskFamily {
  const text =
    `${action?.summary || ''} ${action?.nextAction || ''}`.toLowerCase();
  if (/calendar|schedule/.test(text)) return 'calendar';
  if (/bluebubbles|message|thread|reply|send/.test(text))
    return 'communication';
  if (/research|search|source|web/.test(text)) return 'research';
  if (/provider|runtime|service|proof|alexa|telegram|operator/.test(text)) {
    return 'operator';
  }
  return 'assistant';
}

function selectAction(
  report: SessionGraphDoctorReport,
  intentText?: string | null,
): SelectedAgencyAction {
  const queue = report.cockpit.actionQueue;
  const resumeCandidate = wantsResume(intentText)
    ? queue.find((item) => item.kind === 'resume_checkpoint')
    : null;
  const action =
    resumeCandidate ||
    queue.find((item) => item.kind !== 'review_candidate_link') ||
    queue[0] ||
    null;
  if (!action) {
    return {
      action: null,
      policyClass: 'inspect_only',
      decisionKind: 'inspect_only',
      decisionStatus: 'warn',
      reason:
        'Session Graph has no queued continuity action; inspect status only.',
      nextAction: report.nextAction,
      riskFlags: ['no_action_queued'],
    };
  }
  if (action.approvalRequired || action.kind === 'review_approval') {
    return {
      action,
      policyClass: 'approval_staged',
      decisionKind: 'stage_approval',
      decisionStatus: 'approval_required',
      reason:
        'Selected continuity item crosses an approval boundary, so agency convergence must stage instructions only.',
      nextAction: action.nextAction,
      riskFlags: ['approval_boundary'],
    };
  }
  if (action.kind === 'complete_manual_proof') {
    return {
      action,
      policyClass: 'manual_proof',
      decisionKind: 'manual_proof',
      decisionStatus: 'manual_required',
      reason:
        'Selected continuity item requires an external live proof turn and cannot be completed by local automation.',
      nextAction: action.nextAction,
      riskFlags: ['manual_proof_required'],
    };
  }
  if (action.kind === 'review_candidate_link') {
    return {
      action,
      policyClass: 'inspect_only',
      decisionKind: 'inspect_only',
      decisionStatus: 'warn',
      reason:
        'Selected continuity item is a semantic link review, so the loop should expose it without executing work.',
      nextAction: action.nextAction,
      riskFlags: ['review_needed'],
    };
  }
  return {
    action,
    policyClass: 'read_only',
    decisionKind:
      action.kind === 'resume_checkpoint'
        ? 'resume_checkpoint'
        : 'execute_read_only',
    decisionStatus: 'pass',
    reason:
      'Selected continuity item is compatible with read-only metadata convergence.',
    nextAction: action.nextAction,
    riskFlags: [],
  };
}

function actionKind(
  action: SessionContinuityActionItem | null,
): SessionContinuityActionKind | null {
  return action?.kind || null;
}

function evidenceIdsFor(action: SessionContinuityActionItem | null): string[] {
  return action?.evidenceIds?.slice(0, 40) || [];
}

function safeIdArrayJson(ids: string[], limit = 3200): string {
  const safeIds = ids.map((id) => runtimeSanitizeId(id)).filter(Boolean);
  const json = JSON.stringify(safeIds);
  if (json.length <= limit) return json;
  const kept: string[] = [];
  for (const id of safeIds) {
    const next = JSON.stringify({
      truncated: true,
      ids: [...kept, id],
    });
    if (next.length > limit) break;
    kept.push(id);
  }
  return JSON.stringify({ truncated: true, ids: kept });
}

function sourceIdsFor(
  sessionReport: SessionGraphDoctorReport,
  action: SessionContinuityActionItem | null,
): string[] {
  return [
    sessionReport.snapshot.snapshotId,
    action?.actionId || '',
    ...(action?.sourceSuggestionIds || []),
    ...(action?.sourceNodeIds || []),
  ].filter(Boolean);
}

function buildProviderPlan(input: {
  convergenceRunId: string;
  generatedAt: string;
  providers?: ProviderHealthSnapshot[];
}): AgencyProviderParticipationPlan {
  const providers =
    input.providers || collectProviderHealthSnapshots(input.generatedAt);
  const cooldowns = isDatabaseInitialized()
    ? listCognitiveProviderCooldowns({
        status: 'active',
        activeAt: input.generatedAt,
        limit: 50,
      })
    : [];
  const healthy = providers
    .filter((provider) => provider.state === 'healthy')
    .map((provider) => provider.providerId);
  const blocked = providers
    .filter(
      (provider) =>
        provider.state === 'externally_blocked' ||
        provider.state === 'not_configured' ||
        provider.failureClass === 'auth_failure' ||
        provider.failureClass === 'quota_or_rate_limit',
    )
    .map((provider) => provider.providerId);
  const cooldownProviderIds = cooldowns.map((cooldown) => cooldown.providerId);
  const skipped = Array.from(new Set([...blocked, ...cooldownProviderIds]));
  const status: AgencyProviderParticipationPlan['status'] =
    healthy.length === 0 && skipped.length > 0
      ? 'blocked'
      : skipped.length > 0
        ? 'degraded'
        : 'healthy';
  return {
    participationPlanId: runtimeSanitizeId(
      hashId(
        'agency:providers',
        `${input.convergenceRunId}|${input.generatedAt}`,
      ),
    ),
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    status,
    healthyProviderIdsJson: runtimeSafeJson(healthy, 2400),
    blockedProviderIdsJson: runtimeSafeJson(blocked, 2400),
    skippedProviderIdsJson: runtimeSafeJson(skipped, 2400),
    cooldownProviderIdsJson: runtimeSafeJson(cooldownProviderIds, 2400),
    nextAction:
      status === 'healthy'
        ? 'Provider participation has no static blocker; council runner can choose roles normally.'
        : 'Skip blocked or cooling-down optional providers and report reduced independence honestly.',
    privacyJson: runtimePrivacyJson(),
  };
}

function buildResumePlan(input: {
  convergenceRunId: string;
  generatedAt: string;
  selected: SelectedAgencyAction;
  intentText?: string | null;
  durableContinuity: DurableContinuityReport;
}): AgencyResumePlan {
  const durable = input.durableContinuity;
  const work = durable.work;
  const actionWantsResume =
    wantsResume(input.intentText) ||
    input.selected.action?.kind === 'resume_checkpoint' ||
    input.selected.decisionKind === 'resume_checkpoint';
  const approvalRequired =
    work?.status === 'awaiting_approval' ||
    input.selected.policyClass === 'approval_staged';
  const status: AgencyResumePlan['status'] = approvalRequired
    ? 'approval_required'
    : actionWantsResume
      ? durable.resumeEligible
        ? 'available'
        : 'blocked'
      : 'not_needed';
  const summary = approvalRequired
    ? 'Canonical durable work is waiting for current exact-scope approval. A resume grant cannot substitute for approval.'
    : status === 'available'
      ? 'Canonical durable work has a current checkpoint and an opaque single-use grant eligible for transactional claim.'
      : actionWantsResume
        ? work
          ? 'Canonical durable work is not currently eligible to resume. Legacy Runtime Spine resume identifiers are descriptive only.'
          : 'No canonical durable mission is waiting for recovery. Legacy Runtime Spine resume identifiers are descriptive only.'
        : work
          ? 'Canonical durable continuity is tracking work, but this turn did not request continuation.'
          : 'No canonical durable mission needs continuation.';
  return {
    resumePlanId: runtimeSanitizeId(
      hashId(
        'agency:resume',
        `${input.convergenceRunId}|${work?.workId || 'none'}|${work?.checkpointHeadId || 'none'}|${status}`,
      ),
    ),
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    status,
    runtimeRunId: work?.runtimeRunId || null,
    checkpointId: work?.checkpointHeadId || null,
    // Legacy descriptive resume IDs are deliberately not projected as an
    // executable capability. Opaque durable grants are claimed only through
    // the transactionally scoped continuity boundary.
    resumeTokenId: null,
    summary,
    nextAction:
      status === 'available'
        ? 'Claim the opaque durable grant transactionally, re-inspect dependencies, and execute only the next valid node.'
        : status === 'approval_required'
          ? 'Obtain fresh exact-scope approval on the authorized surface before any mutating continuation.'
          : status === 'blocked'
            ? durable.nextAction
            : 'Continue with the selected safe read-only action.',
    privacyJson: runtimePrivacyJson(),
  };
}

function makeRun(input: {
  convergenceRunId: string;
  generatedAt: string;
  mode: AgencyConvergenceMode;
  selected: SelectedAgencyAction;
  sessionReport: SessionGraphDoctorReport;
  providerPlan: AgencyProviderParticipationPlan;
  worldSnapshotId?: string | null;
  runtimeRunId?: string | null;
  supervisorRunId?: string | null;
  cognitiveRunId?: string | null;
  logicBeliefStateId?: string | null;
  truthAuditId?: string | null;
  refreshedSessionSnapshotId?: string | null;
  outcome?: AgencyLoopOutcome | null;
}): AgencyConvergenceRun {
  const action = input.selected.action;
  const status: AgencyConvergenceRun['status'] =
    input.mode === 'shadow'
      ? 'shadowed'
      : input.selected.policyClass === 'approval_staged'
        ? 'awaiting_approval'
        : input.selected.policyClass === 'manual_proof'
          ? 'manual_proof_required'
          : input.outcome?.status === 'blocked' ||
              input.providerPlan.status === 'blocked'
            ? 'blocked'
            : input.outcome?.status === 'completed'
              ? 'completed'
              : 'running';
  return {
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    updatedAt: input.generatedAt,
    mode: input.mode,
    status,
    selectedActionId: action?.actionId || null,
    selectedActionKind: actionKind(action),
    sessionSnapshotId: input.sessionReport.snapshot.snapshotId,
    refreshedSessionSnapshotId: input.refreshedSessionSnapshotId || null,
    worldSnapshotId: input.worldSnapshotId || null,
    runtimeRunId: input.runtimeRunId || null,
    supervisorRunId: input.supervisorRunId || null,
    cognitiveRunId: input.cognitiveRunId || null,
    logicBeliefStateId: input.logicBeliefStateId || null,
    truthAuditId: input.truthAuditId || null,
    harnessTrajectoryId: null,
    sourceIdsJson: safeIdArrayJson(
      sourceIdsFor(input.sessionReport, action),
      3200,
    ),
    evidenceIdsJson: runtimeSafeJson(evidenceIdsFor(action), 3200),
    outcomeJson: runtimeSafeJson(
      {
        providerStatus: input.providerPlan.status,
        outcomeStatus: input.outcome?.status || null,
        selectedPolicy: input.selected.policyClass,
      },
      3200,
    ),
    nextAction: input.outcome?.nextAction || input.selected.nextAction,
    privacyJson: runtimePrivacyJson(),
  };
}

function makeAgenda(input: {
  convergenceRunId: string;
  generatedAt: string;
  selected: SelectedAgencyAction;
}): AgencyConvergenceAgenda {
  const action = input.selected.action;
  return {
    agendaId: runtimeSanitizeId(
      hashId(
        'agency:agenda',
        `${input.convergenceRunId}|${action?.actionId || 'none'}`,
      ),
    ),
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    status:
      input.selected.policyClass === 'approval_staged'
        ? 'approval_required'
        : input.selected.policyClass === 'manual_proof'
          ? 'manual_required'
          : input.selected.policyClass === 'inspect_only'
            ? 'skipped'
            : 'ready',
    policyClass: input.selected.policyClass,
    selectedActionId: action?.actionId || null,
    actionKind: actionKind(action),
    priority: action?.priority || 0,
    actionSummary: redactCouncilText(
      action?.summary || 'Inspect current agency convergence state.',
      900,
    ),
    evidenceIdsJson: runtimeSafeJson(evidenceIdsFor(action), 3200),
    nextAction: input.selected.nextAction,
    privacyJson: runtimePrivacyJson(),
  };
}

function makeDecision(input: {
  convergenceRunId: string;
  generatedAt: string;
  selected: SelectedAgencyAction;
}): AgencyConvergenceDecision {
  return {
    decisionId: runtimeSanitizeId(
      hashId(
        'agency:decision',
        `${input.convergenceRunId}|${input.selected.decisionKind}`,
      ),
    ),
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    decisionKind: input.selected.decisionKind,
    status: input.selected.decisionStatus,
    reason: redactCouncilText(input.selected.reason, 900),
    evidenceIdsJson: runtimeSafeJson(
      evidenceIdsFor(input.selected.action),
      3200,
    ),
    riskFlagsJson: runtimeSafeJson(input.selected.riskFlags, 2400),
    nextAction: input.selected.nextAction,
    privacyJson: runtimePrivacyJson(),
  };
}

function makeOutcome(input: {
  convergenceRunId: string;
  generatedAt: string;
  selected: SelectedAgencyAction;
  providerPlan: AgencyProviderParticipationPlan;
  runtimeRunId?: string | null;
  truthAuditId?: string | null;
  refreshedSessionSnapshotId?: string | null;
  truthStatus?: string | null;
}): AgencyLoopOutcome {
  const status: AgencyLoopOutcome['status'] =
    input.selected.policyClass === 'approval_staged'
      ? 'approval_required'
      : input.selected.policyClass === 'manual_proof'
        ? 'manual_required'
        : input.selected.decisionStatus === 'block'
          ? 'blocked'
          : 'completed';
  const providerPenalty =
    input.providerPlan.status === 'healthy'
      ? 0
      : input.providerPlan.status === 'degraded'
        ? 0.12
        : 0.25;
  const policyScore =
    status === 'completed'
      ? 0.9
      : status === 'manual_required'
        ? 0.58
        : status === 'approval_required'
          ? 0.5
          : 0.25;
  const flags = [
    input.providerPlan.status !== 'healthy'
      ? `provider_participation_${input.providerPlan.status}`
      : '',
    input.selected.policyClass === 'manual_proof'
      ? 'manual_proof_required'
      : '',
    input.selected.policyClass === 'approval_staged' ? 'approval_required' : '',
    input.truthStatus && input.truthStatus !== 'pass'
      ? `truth_${input.truthStatus}`
      : '',
  ].filter(Boolean);
  return {
    outcomeId: runtimeSanitizeId(
      hashId('agency:outcome', `${input.convergenceRunId}|${status}`),
    ),
    convergenceRunId: input.convergenceRunId,
    createdAt: input.generatedAt,
    status,
    runtimeRunId: input.runtimeRunId || null,
    truthAuditId: input.truthAuditId || null,
    refreshedSessionSnapshotId: input.refreshedSessionSnapshotId || null,
    outcomeScore: clamp01(policyScore - providerPenalty),
    flagsJson: runtimeSafeJson(flags, 2400),
    summary:
      status === 'completed'
        ? 'Agency convergence executed a read-only metadata loop and refreshed continuity.'
        : input.selected.reason,
    nextAction:
      status === 'completed'
        ? 'Inspect debug:agency-loop and the refreshed Session Graph cockpit for the next safe action.'
        : input.selected.nextAction,
    privacyJson: runtimePrivacyJson(),
  };
}

function persistAgencyArtifacts(input: {
  persist: boolean;
  run: AgencyConvergenceRun;
  agenda: AgencyConvergenceAgenda;
  decision: AgencyConvergenceDecision;
  resumePlan: AgencyResumePlan;
  providerPlan: AgencyProviderParticipationPlan;
  outcome: AgencyLoopOutcome;
}): void {
  if (!input.persist || !isDatabaseInitialized()) return;
  upsertAgencyConvergenceRun(input.run);
  upsertAgencyConvergenceAgenda(input.agenda);
  upsertAgencyConvergenceDecision(input.decision);
  upsertAgencyResumePlan(input.resumePlan);
  upsertAgencyProviderParticipationPlan(input.providerPlan);
  upsertAgencyLoopOutcome(input.outcome);
}

export async function runAgencyConvergenceLoop(
  input: RunAgencyConvergenceLoopInput = {},
): Promise<AgencyConvergenceContinuityReport> {
  const generatedAt = input.generatedAt || nowIso();
  const groupFolder = input.groupFolder || 'main';
  const mode = resolveMode(input.mode);
  const persist = input.persist !== false;
  const durableContinuity = buildDurableContinuityReport({
    groupId: groupFolder,
    now: generatedAt,
  });
  const sessionGraph = buildSessionGraphReport({ generatedAt, persist });
  const selected = selectAction(sessionGraph, input.intentText);
  const providerSnapshots =
    input.providerSnapshots ||
    (input.liveProviderProbe === false
      ? collectProviderHealthSnapshots(generatedAt)
      : await collectProviderHealthSnapshotsWithLiveProbe(generatedAt));
  const convergenceRunId = runtimeSanitizeId(
    hashId(
      'agency:run',
      [
        generatedAt,
        mode,
        selected.action?.actionId || sessionGraph.snapshot.snapshotId,
        input.intentText || '',
      ].join('|'),
    ),
  );
  const providerPlan = buildProviderPlan({
    convergenceRunId,
    generatedAt,
    providers: providerSnapshots,
  });
  const resumePlan = buildResumePlan({
    convergenceRunId,
    generatedAt,
    selected,
    intentText: input.intentText,
    durableContinuity,
  });
  const agenda = makeAgenda({ convergenceRunId, generatedAt, selected });
  const decision = makeDecision({ convergenceRunId, generatedAt, selected });
  const taskFamily = taskFamilyFor(selected.action);
  const goal = redactCouncilText(
    `${selected.nextAction} Agency convergence mode: ${mode}. Do not mutate external services.`,
    900,
  );
  const world = buildWorldModelReport({
    generatedAt,
    subject: goal,
    providers: providerSnapshots,
    persist,
  });

  let runtimeRunId: string | null = null;
  let supervisorRunId: string | null = null;
  let cognitiveRunId: string | null = null;
  let logicBeliefStateId: string | null = null;
  let truthAuditId: string | null = null;
  let runtimeReport: AgentRuntimeSpineReport | null = null;
  let refreshedSession = sessionGraph;
  let truthStatus: string | null = null;

  if (mode !== 'off' && selected.policyClass === 'read_only') {
    const cognitive = beginCognitiveKernelRun({
      turnId: convergenceRunId,
      channel: 'system',
      groupFolder,
      taskFamily,
      goal,
      requestRoute: 'agency.convergence_loop',
      selectedSkillId: 'agency.convergence_loop',
      selectedSkillPurpose:
        'Close the loop between Session Graph continuity, Runtime Spine execution, and Truth/World refresh.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'low',
      selectedSkillEvidenceLevel: 'partial',
      providerHealthSnapshots: collectProviderHealthSnapshots(generatedAt),
      knownBlockers: selected.riskFlags,
      thinkingPreference: null,
      thinkingTrigger: 'agency_convergence',
    });
    const logic = beginLogicKernelRun({
      subject: goal,
      cognitiveRun: cognitive,
      generatedAt,
    });
    const runtime = beginAgentRuntimeSpineRun({
      turnId: convergenceRunId,
      channel: 'system',
      groupFolder,
      requestRoute: 'agency.convergence_loop',
      taskFamily,
      goal,
      generatedAt,
      mode,
      cognitiveRun: cognitive,
      logicRun: logic,
    });
    if (runtime) {
      const truth = runTruthEngine({
        text: `Agency convergence selected a read-only action: ${selected.nextAction}`,
        turnId: convergenceRunId,
        channel: 'system',
        taskFamily,
        subject: goal,
        routeKey: 'agency.convergence_loop',
        capabilityId: 'agency.convergence',
        handlerKind: 'local_agency_loop',
        responseSource: 'local_metadata',
        logicReport: logic.report,
        generatedAt,
      });
      recordAgentRuntimeTruthAudit({
        runtime,
        truthVerdict: truth,
        generatedAt,
      });
      truthStatus = truth.calibration.status;
      const evaluationStatus =
        truth.calibration.status === 'block'
          ? 'block'
          : truth.calibration.status === 'warn' ||
              truth.calibration.status === 'clarify'
            ? 'warn'
            : 'pass';
      finalizeCognitiveKernelOutcome({
        cognitiveRun: cognitive,
        evaluationStatus,
        evidenceGap: evaluationStatus === 'pass' ? 'none' : 'minor',
        evaluatorFlags: [
          'agency_convergence_loop',
          ...(providerPlan.status !== 'healthy'
            ? [`provider_participation_${providerPlan.status}`]
            : []),
        ],
        routeUsed: 'agency.convergence_loop',
        answerClass: evaluationStatus === 'block' ? 'blocked' : 'handled',
        blockerClass: evaluationStatus === 'block' ? 'truth_block' : null,
        fallbackUsed: false,
      });
      finalizeAgentRuntimeSpineOutcome({
        runtime,
        generatedAt,
        evaluationStatus,
        evidenceGap: evaluationStatus === 'pass' ? 'none' : 'minor',
        evaluatorFlags: ['agency_convergence_loop'],
        routeUsed: 'agency.convergence_loop',
        answerClass: evaluationStatus === 'block' ? 'blocked' : 'handled',
        blockerClass: evaluationStatus === 'block' ? 'truth_block' : null,
      });
      runtimeRunId = runtime.run.runtimeRunId;
      supervisorRunId = runtime.supervisor?.run.supervisorRunId || null;
      cognitiveRunId = cognitive.run.runId;
      logicBeliefStateId = logic.report.beliefState?.beliefStateId || null;
      truthAuditId = truth.audit.auditId;
      runtimeReport = buildAgentRuntimeSpineReport({
        runtimeRunId,
        generatedAt,
      });
      buildWorldModelReport({
        generatedAt,
        subject: goal,
        logicReport: logic.report,
        persist,
      });
      refreshedSession = buildSessionGraphReport({ generatedAt, persist });
    }
  }

  const outcome = makeOutcome({
    convergenceRunId,
    generatedAt,
    selected,
    providerPlan,
    runtimeRunId,
    truthAuditId,
    refreshedSessionSnapshotId:
      refreshedSession.snapshot.snapshotId !== sessionGraph.snapshot.snapshotId
        ? refreshedSession.snapshot.snapshotId
        : null,
    truthStatus,
  });
  const run = makeRun({
    convergenceRunId,
    generatedAt,
    mode,
    selected,
    sessionReport: sessionGraph,
    providerPlan,
    worldSnapshotId: world.snapshot.snapshotId,
    runtimeRunId,
    supervisorRunId,
    cognitiveRunId,
    logicBeliefStateId,
    truthAuditId,
    refreshedSessionSnapshotId: outcome.refreshedSessionSnapshotId,
    outcome,
  });
  const finalAgenda: AgencyConvergenceAgenda = {
    ...agenda,
    status:
      selected.policyClass === 'read_only' && runtimeRunId
        ? 'executed'
        : agenda.status,
  };
  persistAgencyArtifacts({
    persist,
    run,
    agenda: finalAgenda,
    decision,
    resumePlan,
    providerPlan,
    outcome,
  });
  return buildAgencyConvergenceDoctorReport({
    convergenceRunId,
    generatedAt,
    sessionGraph: refreshedSession,
    runtimeReport,
    groupFolder,
    durableContinuity,
  });
}

export function buildAgencyConvergenceDoctorReport(
  input: {
    convergenceRunId?: string | null;
    generatedAt?: string;
    groupFolder?: string;
    sessionGraph?: SessionGraphDoctorReport;
    runtimeReport?: AgentRuntimeSpineReport | null;
    durableContinuity?: DurableContinuityReport;
  } = {},
): AgencyConvergenceContinuityReport {
  const generatedAt = input.generatedAt || nowIso();
  const latestRun =
    (input.convergenceRunId
      ? getAgencyConvergenceRun(input.convergenceRunId) || null
      : listAgencyConvergenceRuns({ limit: 1 })[0] || null) || null;
  const runId = input.convergenceRunId || latestRun?.convergenceRunId || null;
  const agendas = runId
    ? listAgencyConvergenceAgendas({ convergenceRunId: runId, limit: 20 })
    : [];
  const decisions = runId
    ? listAgencyConvergenceDecisions({ convergenceRunId: runId, limit: 20 })
    : [];
  const resumePlans = runId
    ? listAgencyResumePlans({ convergenceRunId: runId, limit: 20 })
    : [];
  const providerPlans = runId
    ? listAgencyProviderParticipationPlans({
        convergenceRunId: runId,
        limit: 20,
      })
    : [];
  const outcomes = runId
    ? listAgencyLoopOutcomes({ convergenceRunId: runId, limit: 20 })
    : [];
  const runtimeReport =
    input.runtimeReport ||
    (latestRun?.runtimeRunId
      ? buildAgentRuntimeSpineReport({
          runtimeRunId: latestRun.runtimeRunId,
          generatedAt,
        })
      : null);
  const sessionGraph =
    input.sessionGraph || buildSessionGraphReport({ generatedAt });
  const durableContinuity =
    input.durableContinuity ||
    buildDurableContinuityReport({
      groupId: input.groupFolder || 'main',
      now: generatedAt,
    });
  const blocked =
    latestRun?.status === 'blocked' ||
    decisions.some((decision) => decision.status === 'block') ||
    ['blocked', 'verification_failed', 'delivery_unverified'].includes(
      durableContinuity.work?.status || '',
    );
  const nextAction =
    durableContinuity.work?.nextAction ||
    outcomes[0]?.nextAction ||
    latestRun?.nextAction ||
    sessionGraph.cockpit.nextAction;
  return {
    generatedAt,
    ok: !blocked,
    latestRun,
    agendas,
    decisions,
    resumePlans,
    providerPlans,
    outcomes,
    sessionGraph,
    runtimeReport,
    durableContinuity,
    nextAction,
    privacy: runtimePrivacyReport(),
  };
}

export function formatAgencyConvergenceDoctorReport(
  report: AgencyConvergenceDoctorReport & {
    durableContinuity?: DurableContinuityReport;
  },
): string {
  const latest = report.latestRun;
  const agenda = report.agendas[0] || null;
  const decision = report.decisions[0] || null;
  const provider = report.providerPlans[0] || null;
  const outcome = report.outcomes[0] || null;
  const durableContinuity =
    report.durableContinuity || buildDurableContinuityReport();
  return [
    'Agency Convergence Loop',
    '',
    `Status: ${latest?.status || 'not_run'}`,
    `Mode: ${latest?.mode || 'assistive'}`,
    `Run: ${latest?.convergenceRunId || 'none'}`,
    `Selected action: ${agenda?.actionKind || latest?.selectedActionKind || 'none'}`,
    `Policy: ${agenda?.policyClass || 'none'}`,
    `Decision: ${decision?.decisionKind || 'none'} (${decision?.status || 'none'})`,
    `Provider route: ${provider?.status || 'unknown'}`,
    `Outcome: ${outcome?.status || 'none'} score=${outcome?.outcomeScore ?? 'none'}`,
    `Runtime: ${latest?.runtimeRunId || 'none'}`,
    `Truth audit: ${latest?.truthAuditId || 'none'}`,
    `Session snapshot: ${latest?.refreshedSessionSnapshotId || latest?.sessionSnapshotId || report.sessionGraph.snapshot.snapshotId}`,
    '',
    'Canonical recovery state:',
    formatDurableContinuityForOperator(durableContinuity),
    '',
    'Session Graph compatibility view (descriptive only; legacy resume identifiers do not authorize or execute continuation):',
    formatSessionContinuityCockpit(report.sessionGraph.cockpit),
    '',
    `Next: ${report.nextAction}`,
    '',
    'Privacy: metadata-only; no raw prompts, private message bodies, provider debates, hidden reasoning, raw tool output, or secrets are stored.',
  ].join('\n');
}

export function buildAgencyConvergenceStatusText(): string {
  return formatAgencyConvergenceDoctorReport(
    buildAgencyConvergenceDoctorReport(),
  );
}

export function isAgencyConvergenceNaturalRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === 'agency loop status' ||
    normalized === 'convergence status' ||
    normalized === 'runtime convergence status' ||
    normalized === 'what is the agency loop doing?' ||
    /\b(agency loop|convergence loop|closed-loop agency|what are you working on|what changed|what is stale|what should you verify next)\b/i.test(
      text,
    )
  );
}
