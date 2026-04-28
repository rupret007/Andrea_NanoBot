import { logger } from './logger.js';
import {
  ANDREA_PLATFORM_COORDINATOR_ENABLED,
  ANDREA_PLATFORM_COORDINATOR_URL,
  ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME,
} from './config.js';
import type { ChannelHealthSnapshot, RuntimeBackendStatus } from './types.js';

const SHELL_GATEWAY_BASE_URL = (
  process.env.ANDREA_PLATFORM_SHELL_GATEWAY_URL || ''
)
  .trim()
  .replace(/\/+$/, '');
const COORDINATOR_BASE_URL = (
  ANDREA_PLATFORM_COORDINATOR_ENABLED &&
  !ANDREA_PLATFORM_FALLBACK_TO_DIRECT_RUNTIME
    ? ANDREA_PLATFORM_COORDINATOR_URL
    : ''
)
  .trim()
  .replace(/\/+$/, '');

type IntentResponseOutcome = 'handled' | 'blocked' | 'degraded' | 'fallback';
type ProofState =
  | 'LIVE_PROVEN'
  | 'NEAR_LIVE_ONLY'
  | 'DEGRADED_BUT_USABLE'
  | 'EXTERNALLY_BLOCKED';
type HealthSeverity =
  | 'healthy'
  | 'degraded'
  | 'faulted'
  | 'blocked_external'
  | 'near_live_only';
type TransportKind =
  | 'telegram'
  | 'bluebubbles'
  | 'alexa'
  | 'backend_http'
  | 'dds'
  | 'webhook'
  | 'gateway'
  | 'provider'
  | 'other';
type TraceKind =
  | 'intent'
  | 'route'
  | 'job'
  | 'proof'
  | 'feedback'
  | 'commit'
  | 'operator'
  | 'config'
  | 'replay';
export type PlatformTaskFamily =
  | 'calendar'
  | 'communication'
  | 'research'
  | 'media'
  | 'assistant'
  | 'operator'
  | 'code'
  | 'unknown';

function shellGatewayRoute(path: string): string | null {
  if (!SHELL_GATEWAY_BASE_URL) return null;
  return `${SHELL_GATEWAY_BASE_URL}${path}`;
}

function coordinatorRoute(path: string): string | null {
  if (!COORDINATOR_BASE_URL) return null;
  return `${COORDINATOR_BASE_URL}${path}`;
}

async function postShellGateway(path: string, payload: object): Promise<void> {
  const url = shellGatewayRoute(path);
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn(
        {
          component: 'andrea_platform_shell_bridge',
          path,
          status: response.status,
        },
        'Andrea platform shell bridge returned a non-2xx response.',
      );
    }
  } catch (err) {
    logger.debug(
      {
        component: 'andrea_platform_shell_bridge',
        path,
        err,
      },
      'Andrea platform shell bridge post failed.',
    );
  }
}

async function postCoordinatorJson(
  path: string,
  payload: object,
): Promise<unknown | null> {
  const url = coordinatorRoute(path);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      logger.warn(
        {
          component: 'andrea_platform_coordinator_bridge',
          path,
          status: response.status,
        },
        'Andrea platform coordinator bridge returned a non-2xx response.',
      );
      return null;
    }
    return (await response.json()) as unknown;
  } catch (err) {
    logger.debug(
      {
        component: 'andrea_platform_coordinator_bridge',
        path,
        err,
      },
      'Andrea platform coordinator bridge post failed.',
    );
    return null;
  }
}

export function isAndreaPlatformShellBridgeEnabled(): boolean {
  return Boolean(SHELL_GATEWAY_BASE_URL);
}

export async function emitAndreaPlatformShellConfigSnapshot(input: {
  component: string;
  configName: string;
  snapshot: Record<string, unknown>;
}): Promise<void> {
  await postShellGateway('/config/snapshot', {
    source: 'andrea_nanobot',
    component: input.component,
    config_name: input.configName,
    snapshot_json: JSON.stringify(input.snapshot),
  });
}

export async function emitAndreaPlatformShellHealth(input: {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/system/health', {
    source: 'andrea_nanobot',
    component: 'andrea.shell',
    owner: 'shell',
    severity: input.severity,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformProofEvent(input: {
  surface: string;
  state: ProofState;
  summary: string;
  journey?: string | null;
  blocker?: string | null;
  nextAction?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/proof/event', {
    source: 'andrea_nanobot',
    surface: input.surface,
    ...(input.journey ? { journey: input.journey } : {}),
    state: input.state,
    summary: input.summary,
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.nextAction ? { next_action: input.nextAction } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformTransportEvent(input: {
  transportId: string;
  transportKind: TransportKind;
  state: HealthSeverity;
  summary: string;
  detail?: string | null;
  latencyMs?: number | null;
  freshnessSeconds?: number | null;
  deliverySemantics?: string | null;
  fallbackTarget?: string | null;
  blocker?: string | null;
  nextAction?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/transport/event', {
    source: 'andrea_nanobot',
    transport_id: input.transportId,
    transport_kind: input.transportKind,
    state: input.state,
    summary: input.summary,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.latencyMs !== undefined && input.latencyMs !== null
      ? { latency_ms: input.latencyMs }
      : {}),
    ...(input.freshnessSeconds !== undefined && input.freshnessSeconds !== null
      ? { freshness_seconds: input.freshnessSeconds }
      : {}),
    ...(input.deliverySemantics
      ? { delivery_semantics: input.deliverySemantics }
      : {}),
    ...(input.fallbackTarget ? { fallback_target: input.fallbackTarget } : {}),
    ...(input.blocker ? { blocker: input.blocker } : {}),
    ...(input.nextAction ? { next_action: input.nextAction } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformTraceEvent(input: {
  traceId: string;
  traceKind: TraceKind;
  title: string;
  summary: string;
  refs?: Record<string, string>;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/trace/event', {
    source: 'andrea_nanobot',
    trace_id: input.traceId,
    trace_kind: input.traceKind,
    title: input.title,
    summary: input.summary,
    ...(input.refs ? { refs: input.refs } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export interface AndreaPlatformFeedbackReflectionResult {
  feedbackId: string;
  taskLedgerId?: string;
  progressLedgerId?: string;
  reflectionId?: string;
  evaluationId?: string;
  learningId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return strings.length > 0 ? strings : undefined;
}

function pickRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickNestedString(
  body: Record<string, unknown>,
  objectKey: string,
  fieldKey: string,
): string | undefined {
  return pickString(pickRecord(body[objectKey])?.[fieldKey]);
}

function pickTraceGradeId(body: Record<string, unknown>): string | undefined {
  return (
    pickNestedString(body, 'trace_grade', 'grade_id') ||
    pickNestedString(body, 'trace_grade', 'trace_grade_id')
  );
}

function pickTraceGradeStatus(
  body: Record<string, unknown>,
): string | undefined {
  return pickNestedString(body, 'trace_grade', 'status');
}

function pickRouteScores(
  value: unknown,
): AndreaPlatformDeliberationResult['routeScores'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scores = value
    .map((item) => {
      const record = pickRecord(item);
      if (!record) return null;
      const routeId = pickString(record.route_id) || pickString(record.routeId);
      const score = pickNumber(record.score);
      const confidence = pickNumber(record.confidence);
      if (!routeId || score === undefined || confidence === undefined) {
        return null;
      }
      return {
        routeId,
        score,
        confidence,
        evidenceRequirement:
          pickString(record.evidence_requirement) ||
          pickString(record.evidenceRequirement),
        approvalRequired:
          pickBoolean(record.approval_required) ||
          pickBoolean(record.approvalRequired),
        blockerClass:
          pickString(record.blocker_class) || pickString(record.blockerClass),
        reason: pickString(record.reason),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return scores.length > 0 ? scores : undefined;
}

function pickEvidenceCards(
  value: unknown,
): AndreaPlatformDeliberationResult['evidenceCards'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cards = value
    .map((item) => {
      const record = pickRecord(item);
      if (!record) return null;
      const routeId = pickString(record.route_id) || pickString(record.routeId);
      if (!routeId) return null;
      return {
        routeId,
        sourceClass:
          pickString(record.source_class) || pickString(record.sourceClass),
        expectedLevel:
          pickString(record.expected_level) || pickString(record.expectedLevel),
        actualLevel:
          pickString(record.actual_level) || pickString(record.actualLevel),
        freshness: pickString(record.freshness),
        blockerClass:
          pickString(record.blocker_class) || pickString(record.blockerClass),
        confidenceImpact:
          pickNumber(record.confidence_impact) ||
          pickNumber(record.confidenceImpact),
        summary: pickString(record.summary),
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return cards.length > 0 ? cards : undefined;
}

export interface AndreaPlatformDeliberationResult {
  taskLedgerId?: string;
  progressLedgerId?: string;
  evaluationId?: string;
  planId?: string;
  decisionId?: string;
  selectedRoute?: string;
  selectedWorker?: string;
  executionPosture?: string;
  answerStrategy?: string;
  selectedPolicyId?: string;
  requiredApproval?: boolean;
  confidence?: number;
  missingInformation?: string[];
  policyHoldReason?: string;
  expectedEvidence?: string;
  sideEffectBudget?: string;
  riskFlags?: string[];
  routeScores?: Array<{
    routeId: string;
    score: number;
    confidence: number;
    evidenceRequirement?: string;
    approvalRequired?: boolean;
    blockerClass?: string;
    reason?: string;
  }>;
  evidenceCards?: Array<{
    routeId: string;
    sourceClass?: string;
    expectedLevel?: string;
    actualLevel?: string;
    freshness?: string;
    blockerClass?: string;
    confidenceImpact?: number;
    summary?: string;
  }>;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

export interface AndreaPlatformTurnReflectionResult {
  taskLedgerId?: string;
  progressLedgerId?: string;
  reflectionId?: string;
  evaluationId?: string;
  learningId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

export async function emitAndreaPlatformDeliberation(input: {
  goal: string;
  taskFamily: PlatformTaskFamily;
  channel?: 'telegram' | 'bluebubbles' | 'alexa' | 'system';
  groupFolder?: string | null;
  correlationId?: string | null;
  approvalPosture?: string | null;
  routeCandidates?: string[];
  memoryMetadata?: Record<string, string>;
  knownBlockers?: string[];
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformDeliberationResult | null> {
  const response = await postCoordinatorJson('/deliberate', {
    goal: input.goal,
    category: input.taskFamily,
    channel: input.channel || 'telegram',
    ...(input.groupFolder ? { groupFolder: input.groupFolder } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.approvalPosture
      ? { approvalPosture: input.approvalPosture }
      : {}),
    ...(input.routeCandidates && input.routeCandidates.length > 0
      ? { routeCandidates: input.routeCandidates }
      : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      turn_intelligence_version: 'v7',
      ...(input.memoryMetadata || {}),
      ...(input.knownBlockers && input.knownBlockers.length > 0
        ? { known_blockers: input.knownBlockers.join(',') }
        : {}),
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const decision = pickRecord(body.decision);
  return {
    taskLedgerId:
      pickNestedString(body, 'task', 'task_ledger_id') ||
      pickString(decision?.task_ledger_id),
    progressLedgerId:
      pickNestedString(body, 'progress', 'progress_ledger_id') ||
      pickString(decision?.progress_ledger_id),
    evaluationId:
      pickNestedString(body, 'evaluation', 'evaluation_id') ||
      pickString(decision?.evaluation_id),
    planId:
      pickNestedString(body, 'plan', 'plan_id') ||
      pickString(decision?.plan_id),
    decisionId: pickString(decision?.decision_id),
    selectedRoute:
      pickString(decision?.selected_route) ||
      pickNestedString(body, 'plan', 'route'),
    selectedWorker:
      pickString(decision?.selected_worker) ||
      pickStringArray(pickRecord(body.plan)?.selected_workers)?.[0],
    executionPosture: pickString(decision?.execution_posture),
    answerStrategy: pickString(decision?.answer_strategy),
    selectedPolicyId: pickString(decision?.selected_policy_id),
    requiredApproval: pickBoolean(decision?.required_approval),
    confidence:
      pickNumber(decision?.confidence) ||
      pickNumber(pickRecord(body.plan)?.confidence),
    missingInformation: pickStringArray(decision?.missing_information),
    policyHoldReason: pickString(decision?.policy_hold_reason),
    expectedEvidence: pickString(decision?.expected_evidence),
    sideEffectBudget: pickString(decision?.side_effect_budget),
    riskFlags: pickStringArray(decision?.risk_flags),
    routeScores: pickRouteScores(decision?.route_scores),
    evidenceCards: pickEvidenceCards(decision?.evidence_cards),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export async function emitAndreaPlatformTurnReflection(input: {
  taskLedgerId: string;
  progressLedgerId?: string | null;
  planId?: string | null;
  feedbackId?: string | null;
  trigger?: string | null;
  summary: string;
  planCorrectness?: 'strong' | 'partial' | 'weak';
  workerFit?: 'strong' | 'partial' | 'weak';
  memoryEffect?: 'helpful' | 'neutral' | 'harmful' | 'unknown';
  approvalCorrectness?: 'correct' | 'needs_review' | 'unknown';
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformTurnReflectionResult | null> {
  const response = await postCoordinatorJson('/reflect', {
    taskLedgerId: input.taskLedgerId,
    ...(input.progressLedgerId
      ? { progressLedgerId: input.progressLedgerId }
      : {}),
    ...(input.planId ? { planId: input.planId } : {}),
    ...(input.feedbackId ? { feedbackId: input.feedbackId } : {}),
    trigger: input.trigger || 'turn_agent_harness',
    summary: input.summary,
    planCorrectness: input.planCorrectness || 'partial',
    workerFit: input.workerFit || 'partial',
    memoryEffect: input.memoryEffect || 'unknown',
    approvalCorrectness: input.approvalCorrectness || 'unknown',
    metadata: {
      sourceSystem: 'andrea_nanobot',
      turn_intelligence_version: 'v8',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const reflection = pickRecord(body.reflection);
  const evaluation = pickRecord(body.evaluation);
  const learning = pickRecord(body.learning);
  return {
    taskLedgerId: input.taskLedgerId,
    progressLedgerId: input.progressLedgerId || undefined,
    reflectionId: pickString(reflection?.reflection_id),
    evaluationId: pickString(evaluation?.evaluation_id),
    learningId: pickString(learning?.learning_id),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export async function emitAndreaPlatformFeedbackReflection(input: {
  feedbackId: string;
  issueId?: string | null;
  status: string;
  classification: string;
  taskFamily: PlatformTaskFamily;
  channel: 'telegram';
  groupFolder: string;
  chatJid: string;
  threadId?: string | null;
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  blockerClass?: string | null;
  blockerOwner?: string | null;
  platformMessageId?: string | null;
  userMessageId?: string | null;
  remediationLaneId?: string | null;
  remediationJobId?: string | null;
  originalUserPreview?: string | null;
  assistantReplyPreview?: string | null;
  summary: string;
  nextAction?: string | null;
}): Promise<AndreaPlatformFeedbackReflectionResult | null> {
  const response = await postCoordinatorJson('/feedback/reflection', {
    feedbackId: input.feedbackId,
    correlationId: input.feedbackId,
    taskFamily: input.taskFamily,
    sentiment: 'negative',
    outcome:
      input.classification === 'externally_blocked' ||
      input.classification === 'manual_sync_only'
        ? 'blocked'
        : 'degraded',
    normalizedGoal: `Review user feedback for ${input.taskFamily} response ${input.feedbackId}.`,
    summary: input.summary,
    channel: input.channel,
    sourceSystem: 'andrea_nanobot',
    nextAction:
      input.nextAction ||
      'Use this downvote to guide the next narrow fix or routing rule.',
    jobId: input.remediationJobId || undefined,
    metadata: {
      feedbackId: input.feedbackId,
      issueId: input.issueId || '',
      status: input.status,
      classification: input.classification,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      threadId: input.threadId || '',
      routeKey: input.routeKey || '',
      capabilityId: input.capabilityId || '',
      handlerKind: input.handlerKind || '',
      responseSource: input.responseSource || '',
      blockerClass: input.blockerClass || '',
      blockerOwner: input.blockerOwner || '',
      platformMessageId: input.platformMessageId || '',
      userMessageId: input.userMessageId || '',
      remediationLaneId: input.remediationLaneId || '',
      remediationJobId: input.remediationJobId || '',
      originalUserPreview: input.originalUserPreview || '',
      assistantReplyPreview: input.assistantReplyPreview || '',
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const task = body.task as Record<string, unknown> | undefined;
  const progress = body.progress as Record<string, unknown> | undefined;
  const reflection = body.reflection as Record<string, unknown> | undefined;
  const evaluation = body.evaluation as Record<string, unknown> | undefined;
  const learning = body.learning as Record<string, unknown> | undefined;
  return {
    feedbackId: input.feedbackId,
    taskLedgerId: pickString(task?.task_ledger_id),
    progressLedgerId: pickString(progress?.progress_ledger_id),
    reflectionId: pickString(reflection?.reflection_id),
    evaluationId: pickString(evaluation?.evaluation_id),
    learningId: pickString(learning?.learning_id),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export interface AndreaPlatformDiagnosisResult {
  diagnosisId?: string;
  status?: string;
  suspectedCause?: string;
  repairRunId?: string;
}

export async function emitAndreaPlatformDiagnosis(input: {
  goal: string;
  correlationId?: string | null;
  taskFamily?: PlatformTaskFamily;
  channel?: 'telegram' | 'bluebubbles' | 'alexa' | 'system';
  includePlatformSignals?: boolean;
  signals?: Array<Record<string, unknown>>;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformDiagnosisResult | null> {
  const response = await postCoordinatorJson('/diagnose', {
    goal: input.goal,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.taskFamily ? { category: input.taskFamily } : {}),
    channel: input.channel || 'telegram',
    includePlatformSignals: input.includePlatformSignals ?? true,
    ...(input.signals && input.signals.length > 0
      ? { signals: input.signals }
      : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const diagnosis = pickRecord(body.diagnosis);
  const repairRun = pickRecord(body.repair_run);
  return {
    diagnosisId: pickString(diagnosis?.diagnosis_id),
    status: pickString(diagnosis?.status),
    suspectedCause: pickString(diagnosis?.suspected_cause),
    repairRunId: pickString(repairRun?.repair_run_id),
  };
}

export interface AndreaPlatformRepairPlanResult {
  diagnosisId?: string;
  repairPlanId?: string;
  repairRunId?: string;
  status?: string;
  workerId?: string;
  cloudWorkerId?: string;
  approvalSummary?: string;
}

export async function emitAndreaPlatformRepairPlan(input: {
  goal: string;
  diagnosisId?: string | null;
  correlationId?: string | null;
  title?: string | null;
  workerId?: string | null;
  cloudWorkerId?: string | null;
  affectedRepos?: string[];
  affectedServices?: string[];
  testsRequired?: string[];
  restartRequired?: boolean;
  deployAllowed?: boolean;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformRepairPlanResult | null> {
  const response = await postCoordinatorJson('/repair/plan', {
    goal: input.goal,
    ...(input.diagnosisId ? { diagnosisId: input.diagnosisId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.workerId ? { workerId: input.workerId } : {}),
    ...(input.cloudWorkerId ? { cloudWorkerId: input.cloudWorkerId } : {}),
    ...(input.affectedRepos && input.affectedRepos.length > 0
      ? { affectedRepos: input.affectedRepos }
      : {}),
    ...(input.affectedServices && input.affectedServices.length > 0
      ? { affectedServices: input.affectedServices }
      : {}),
    ...(input.testsRequired && input.testsRequired.length > 0
      ? { testsRequired: input.testsRequired }
      : {}),
    restartRequired: input.restartRequired ?? false,
    deployAllowed: input.deployAllowed ?? false,
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const diagnosis = pickRecord(body.diagnosis);
  const plan = pickRecord(body.repair_plan);
  const run = pickRecord(body.repair_run);
  return {
    diagnosisId: pickString(diagnosis?.diagnosis_id),
    repairPlanId: pickString(plan?.repair_plan_id),
    repairRunId: pickString(run?.repair_run_id),
    status: pickString(plan?.status) || pickString(run?.status),
    workerId: pickString(plan?.worker_id),
    cloudWorkerId: pickString(plan?.cloud_worker_id),
    approvalSummary: pickString(plan?.approval_summary),
  };
}

export async function emitAndreaPlatformRepairApproval(input: {
  repairPlanId: string;
  approvedBy?: string | null;
  metadata?: Record<string, string>;
}): Promise<{ approvalId?: string; repairRunId?: string } | null> {
  const response = await postCoordinatorJson('/repair/approve', {
    repairPlanId: input.repairPlanId,
    approvedBy: input.approvedBy || 'andrea_nanobot',
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  return {
    approvalId: pickNestedString(body, 'approval', 'approval_id'),
    repairRunId: pickNestedString(body, 'repair_run', 'repair_run_id'),
  };
}

export interface AndreaPlatformRepairExecutionResult {
  repairPlanId?: string;
  repairRunId?: string;
  executionId?: string;
  verificationEvidenceId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

export async function emitAndreaPlatformRepairExecution(input: {
  repairPlanId: string;
  approvalId?: string | null;
  groupFolder?: string | null;
  channel?: 'telegram' | 'bluebubbles' | 'alexa' | 'system';
  actorId?: string | null;
  externalJobId?: string | null;
  externalLaneId?: string | null;
  workerId?: string | null;
  jobStatus?: string | null;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformRepairExecutionResult | null> {
  const response = await postCoordinatorJson('/repair/execute', {
    repairPlanId: input.repairPlanId,
    ...(input.approvalId ? { approvalId: input.approvalId } : {}),
    ...(input.groupFolder ? { groupFolder: input.groupFolder } : {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.externalJobId ? { externalJobId: input.externalJobId } : {}),
    ...(input.externalLaneId ? { externalLaneId: input.externalLaneId } : {}),
    ...(input.workerId ? { workerId: input.workerId } : {}),
    ...(input.jobStatus ? { jobStatus: input.jobStatus } : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const plan = pickRecord(body.repair_plan);
  const run = pickRecord(body.repair_run);
  const execution = pickRecord(body.execution);
  const verification = pickRecord(body.verification);
  return {
    repairPlanId: pickString(plan?.repair_plan_id) || input.repairPlanId,
    repairRunId: pickString(run?.repair_run_id),
    executionId: pickString(execution?.execution_id),
    verificationEvidenceId: pickString(verification?.evidence_id),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export async function emitAndreaPlatformIntentRequest(input: {
  channel: 'telegram' | 'bluebubbles';
  text: string;
  actorId?: string | null;
  groupFolder?: string | null;
  routeHint?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/intent/request', {
    source: 'andrea_nanobot',
    channel: input.channel,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    ...(input.groupFolder ? { group_folder: input.groupFolder } : {}),
    text: input.text,
    ...(input.routeHint ? { route_hint: input.routeHint } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export async function emitAndreaPlatformIntentResponse(input: {
  channel: 'telegram' | 'bluebubbles';
  summary: string;
  outcome: IntentResponseOutcome;
  actorId?: string | null;
  groupFolder?: string | null;
  metadata?: Record<string, string>;
}): Promise<void> {
  await postShellGateway('/intent/response', {
    source: 'andrea_nanobot',
    channel: input.channel,
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    ...(input.groupFolder ? { group_folder: input.groupFolder } : {}),
    summary: input.summary,
    outcome: input.outcome,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

export function mapShellHealthFromBackendStatus(status: RuntimeBackendStatus): {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
} {
  switch (status.state) {
    case 'available':
      return {
        severity: 'healthy',
        summary: 'NanoBot can reach the loopback runtime backend.',
        detail: status.detail,
      };
    case 'auth_required':
      return {
        severity: 'near_live_only',
        summary:
          'NanoBot can reach the runtime backend, but local auth is still required.',
        detail: status.detail,
      };
    case 'not_ready':
      return {
        severity: 'degraded',
        summary:
          'NanoBot can reach the runtime backend, but the execution lane is not ready.',
        detail: status.detail,
      };
    case 'not_enabled':
      return {
        severity: 'degraded',
        summary: 'NanoBot runtime backend bridge is disabled.',
        detail: status.detail,
      };
    case 'unavailable':
    default:
      return {
        severity: 'degraded',
        summary: 'NanoBot cannot currently reach the loopback runtime backend.',
        detail: status.detail,
      };
  }
}

export function mapShellHealthFromChannelHealth(
  channelHealth: readonly ChannelHealthSnapshot[],
): {
  severity: HealthSeverity;
  summary: string;
  detail?: string | null;
  metadata?: Record<string, string>;
} {
  const configuredChannels = channelHealth.filter(
    (channel) => channel.configured,
  );
  const readyChannels = configuredChannels.filter(
    (channel) => channel.state === 'ready',
  );
  const unhealthyChannels = configuredChannels.filter(
    (channel) => channel.state !== 'ready',
  );

  if (configuredChannels.length === 0) {
    return {
      severity: 'degraded',
      summary:
        'NanoBot shell is running, but no interactive channels are configured yet.',
      detail:
        'Configure at least one interactive channel so the platform can treat the shell as live.',
      metadata: {
        configuredChannels: '0',
        readyChannels: '0',
      },
    };
  }

  if (unhealthyChannels.length > 0) {
    const detail = unhealthyChannels
      .map((channel) => {
        const reason = channel.lastError || channel.detail || channel.state;
        return `${channel.name}: ${reason}`;
      })
      .join('; ');
    return {
      severity: 'degraded',
      summary:
        'NanoBot shell is running, but one or more configured channels are not ready yet.',
      detail,
      metadata: {
        configuredChannels: String(configuredChannels.length),
        readyChannels: String(readyChannels.length),
      },
    };
  }

  return {
    severity: 'healthy',
    summary: 'NanoBot shell is running and all configured channels are ready.',
    detail: readyChannels.map((channel) => channel.name).join(', '),
    metadata: {
      configuredChannels: String(configuredChannels.length),
      readyChannels: String(readyChannels.length),
    },
  };
}
