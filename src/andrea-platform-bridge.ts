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
const DEFAULT_PLATFORM_BRIDGE_TIMEOUT_MS = 15_000;

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
  | 'replay'
  | 'council';
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

function platformBridgeSignal(): AbortSignal | undefined {
  const timeout = (
    AbortSignal as unknown as {
      timeout?: (ms: number) => AbortSignal;
    }
  ).timeout;
  const parsed = Number.parseInt(
    process.env.ANDREA_PLATFORM_BRIDGE_TIMEOUT_MS || '',
    10,
  );
  const timeoutMs = Number.isFinite(parsed)
    ? Math.max(1000, Math.min(parsed, 60_000))
    : DEFAULT_PLATFORM_BRIDGE_TIMEOUT_MS;
  return typeof timeout === 'function' ? timeout(timeoutMs) : undefined;
}

async function postShellGateway(path: string, payload: object): Promise<void> {
  const url = shellGatewayRoute(path);
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: platformBridgeSignal(),
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
      signal: platformBridgeSignal(),
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

async function getCoordinatorJson(path: string): Promise<unknown | null> {
  const url = coordinatorRoute(path);
  if (!url) return null;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: platformBridgeSignal(),
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
      'Andrea platform coordinator bridge get failed.',
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
  skillCandidateId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

export interface AndreaPlatformSkillCandidateSummary {
  candidateId: string;
  skillId: string;
  taskFamily: PlatformTaskFamily;
  lifecycleStatus: string;
  summary: string;
  evidenceCount: number;
  riskLevel: string;
  approvalRequired: boolean;
  directives: string[];
}

export interface AndreaPlatformSkillCandidateResult {
  candidate?: AndreaPlatformSkillCandidateSummary;
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

const DIRECTIVE_TOKEN_PATTERN = /^[a-z0-9_.]{1,60}$/;

function parseDirectiveList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const cleaned = item.trim().toLowerCase();
      if (DIRECTIVE_TOKEN_PATTERN.test(cleaned) && !seen.has(cleaned)) {
        seen.add(cleaned);
        out.push(cleaned);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const token of value.split(',')) {
      const cleaned = token.trim().toLowerCase();
      if (DIRECTIVE_TOKEN_PATTERN.test(cleaned) && !seen.has(cleaned)) {
        seen.add(cleaned);
        out.push(cleaned);
      }
    }
    return out;
  }
  return [];
}

function pickSkillCandidateSummary(
  value: unknown,
): AndreaPlatformSkillCandidateSummary | undefined {
  const record = pickRecord(value);
  if (!record) return undefined;
  const candidateId =
    pickString(record.candidate_id) || pickString(record.candidateId);
  const skillId = pickString(record.skill_id) || pickString(record.skillId);
  const taskFamily = (pickString(record.task_family) ||
    pickString(record.taskFamily)) as PlatformTaskFamily | undefined;
  if (!candidateId || !skillId || !taskFamily) return undefined;
  const metadata = pickRecord(record.metadata);
  const directives = parseDirectiveList(metadata?.directives);
  return {
    candidateId,
    skillId,
    taskFamily,
    lifecycleStatus:
      pickString(record.lifecycle_status) ||
      pickString(record.lifecycleStatus) ||
      'staged',
    summary: pickString(record.summary) || '',
    evidenceCount:
      pickNumber(record.evidence_count) ||
      pickNumber(record.evidenceCount) ||
      1,
    riskLevel:
      pickString(record.risk_level) || pickString(record.riskLevel) || 'low',
    approvalRequired:
      pickBoolean(record.approval_required) ||
      pickBoolean(record.approvalRequired) ||
      false,
    directives,
  };
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
  contextDirectives?: string[];
  abstentionDirective?: string;
  abstentionPosteriorProb?: number;
  evidencePosteriorProb?: number;
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

export type AndreaPlatformCouncilMode =
  | 'single_model'
  | 'dual_review'
  | 'max_iq_council'
  | 'repair_council';

export interface AndreaPlatformProviderCouncilResult {
  councilRunId?: string;
  requestId?: string;
  verdictId?: string;
  mode?: AndreaPlatformCouncilMode;
  status?: string;
  traceId?: string;
  finalRoute?: string;
  answerStrategy?: string;
  confidence?: number;
  approvalRequired?: boolean;
  memberCount?: number;
  skippedMemberCount?: number;
  blockedMemberCount?: number;
  riskFlags?: string[];
  observedMemberIds?: string[];
  observedRoles?: string[];
  eventIds?: string[];
  evidenceIds?: string[];
  providerFailures?: string[];
  estimatedCostTier?: 'low' | 'medium' | 'high' | 'unknown';
}

export interface AndreaPlatformCouncilChallengeResult {
  runId?: string;
  status?: 'pass' | 'warn' | 'fail' | 'degraded';
  totalScore?: number;
  criticalFailureCount?: number;
  issueCount?: number;
}

export type AndreaPlatformCouncilEventType =
  | 'assignment'
  | 'start'
  | 'prompt_sent'
  | 'response_received'
  | 'critique'
  | 'handoff'
  | 'tool_call'
  | 'tool_result'
  | 'verifier_verdict'
  | 'platform_arbitration'
  | 'blocked'
  | 'error'
  | 'completion';

export interface AndreaPlatformCouncilEventInput {
  councilRunId: string;
  correlationId?: string | null;
  eventType: AndreaPlatformCouncilEventType;
  actorId: string;
  actorRole:
    | 'planner'
    | 'critic'
    | 'evidence_scout'
    | 'repair_worker'
    | 'synthesizer'
    | 'verifier'
    | 'platform_arbiter'
    | 'conductor';
  providerId?: string | null;
  model?: string | null;
  status?: 'planned' | 'running' | 'completed' | 'blocked' | 'error';
  inputSummary?: string;
  outputSummary?: string;
  visiblePrompt?: string | null;
  visibleResponse?: string | null;
  evidenceIds?: string[];
  handoffTarget?: string | null;
  latencyMs?: number | null;
  estimatedTokenCount?: number | null;
  estimatedCostTier?: 'low' | 'medium' | 'high' | 'unknown';
  riskFlags?: string[];
  metadata?: Record<string, string>;
}

export interface AndreaPlatformCouncilMemberResultInput extends Omit<
  AndreaPlatformCouncilEventInput,
  'eventType' | 'actorId' | 'actorRole'
> {
  memberId: string;
  role:
    | 'planner'
    | 'critic'
    | 'evidence_scout'
    | 'repair_worker'
    | 'synthesizer'
    | 'verifier';
  summary: string;
  critique?: string | null;
  recommendedRoute?: string | null;
  confidence?: number;
}

export interface AndreaPlatformIntelligenceScenarioResult {
  scenarioId: string;
  scenarioTitle: string;
  taskFamily: PlatformTaskFamily | 'simple';
  critical: boolean;
  passed: boolean;
  score: number;
  gates: Array<{
    gateId: string;
    passed: boolean;
    score: number;
    summary: string;
    critical?: boolean;
  }>;
  expected: Record<string, string>;
  actual: Record<string, string>;
  traceIds?: string[];
  metadata?: Record<string, string>;
}

export interface AndreaPlatformIntelligenceRegressionResult {
  reportId?: string;
  status?: 'pass' | 'warn' | 'fail';
  mode?: 'baseline' | 'regression';
  totalScore?: number;
  criticalScore?: number;
  scenarioCount?: number;
  criticalFailureCount?: number;
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
  actorId?: string | null;
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
    ...(input.actorId ? { actorId: input.actorId } : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      turn_intelligence_version: 'v10',
      ...(input.actorId ? { actor_id: input.actorId } : {}),
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
    contextDirectives: pickStringArray(decision?.context_directives),
    abstentionDirective: pickString(
      pickRecord(decision?.metadata)?.abstention_directive,
    ),
    abstentionPosteriorProb: (() => {
      const raw = pickString(
        pickRecord(decision?.metadata)?.abstention_posterior_prob,
      );
      const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : undefined;
    })(),
    evidencePosteriorProb: (() => {
      const cards = Array.isArray(decision?.evidence_cards)
        ? decision?.evidence_cards
        : [];
      for (const card of cards) {
        const meta = pickRecord((card as Record<string, unknown>)?.metadata);
        const raw = pickString(meta?.evidence_posterior_prob);
        if (!raw) continue;
        const parsed = Number.parseFloat(raw);
        if (Number.isFinite(parsed)) return parsed;
      }
      return undefined;
    })(),
  };
}

export async function emitAndreaPlatformProviderCouncil(input: {
  goal: string;
  taskFamily: PlatformTaskFamily;
  channel?: 'telegram' | 'bluebubbles' | 'alexa' | 'system';
  groupFolder?: string | null;
  correlationId?: string | null;
  requestedMode?: AndreaPlatformCouncilMode | null;
  riskLevel?: 'low' | 'medium' | 'high';
  requiredEvidence?: 'strong' | 'partial' | 'weak' | 'unknown';
  allowedSideEffects?: 'none' | 'read_only' | 'approval_required';
  rawContentPolicy?: 'metadata_only' | 'local_only' | 'sanitized_snippets';
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformProviderCouncilResult | null> {
  const response = await postCoordinatorJson('/council-run', {
    goal: input.goal,
    taskFamily: input.taskFamily,
    channel: input.channel || 'telegram',
    ...(input.groupFolder ? { groupFolder: input.groupFolder } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.requestedMode ? { requestedMode: input.requestedMode } : {}),
    ...(input.riskLevel ? { riskLevel: input.riskLevel } : {}),
    ...(input.requiredEvidence
      ? { requiredEvidence: input.requiredEvidence }
      : {}),
    ...(input.allowedSideEffects
      ? { allowedSideEffects: input.allowedSideEffects }
      : {}),
    ...(input.rawContentPolicy
      ? { rawContentPolicy: input.rawContentPolicy }
      : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      council_bridge_version: 'v1',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const council = pickRecord(body.council);
  const verdict = pickRecord(body.verdict) || pickRecord(council?.verdict);
  const members = Array.isArray(council?.members) ? council.members : [];
  const skippedMemberCount = members.filter(
    (member) =>
      pickString((member as Record<string, unknown>)?.status) === 'skipped',
  ).length;
  const blockedMemberCount = members.filter(
    (member) =>
      pickString((member as Record<string, unknown>)?.status) === 'blocked',
  ).length;
  return {
    councilRunId: pickString(council?.council_run_id),
    requestId: pickString(council?.request_id),
    verdictId: pickString(verdict?.verdict_id),
    mode: pickString(council?.mode) as AndreaPlatformCouncilMode | undefined,
    status: pickString(council?.status),
    traceId: pickString(council?.trace_id),
    finalRoute: pickString(verdict?.final_route),
    answerStrategy: pickString(verdict?.answer_strategy),
    confidence: pickNumber(verdict?.confidence),
    approvalRequired: pickBoolean(verdict?.approval_required),
    memberCount: members.length,
    skippedMemberCount,
    blockedMemberCount,
    riskFlags: pickStringArray(verdict?.risk_flags),
  };
}

export async function emitAndreaPlatformCouncilEvent(
  input: AndreaPlatformCouncilEventInput,
): Promise<Record<string, unknown> | null> {
  const response = await postCoordinatorJson('/council/event', {
    councilRunId: input.councilRunId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    eventType: input.eventType,
    actorId: input.actorId,
    actorRole: input.actorRole,
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    status: input.status || 'planned',
    inputSummary: input.inputSummary || '',
    outputSummary: input.outputSummary || '',
    ...(input.visiblePrompt ? { visiblePrompt: input.visiblePrompt } : {}),
    ...(input.visibleResponse
      ? { visibleResponse: input.visibleResponse }
      : {}),
    ...(input.evidenceIds?.length ? { evidenceIds: input.evidenceIds } : {}),
    ...(input.handoffTarget ? { handoffTarget: input.handoffTarget } : {}),
    ...(typeof input.latencyMs === 'number'
      ? { latencyMs: Math.max(0, Math.round(input.latencyMs)) }
      : {}),
    ...(typeof input.estimatedTokenCount === 'number'
      ? {
          estimatedTokenCount: Math.max(
            0,
            Math.round(input.estimatedTokenCount),
          ),
        }
      : {}),
    estimatedCostTier: input.estimatedCostTier || 'unknown',
    riskFlags: input.riskFlags || [],
    metadata: {
      sourceSystem: 'andrea_nanobot',
      council_observatory_version: 'v1',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  return pickRecord(response) || null;
}

export async function emitAndreaPlatformCouncilMemberResult(
  input: AndreaPlatformCouncilMemberResultInput,
): Promise<Record<string, unknown> | null> {
  const response = await postCoordinatorJson('/council/member-result', {
    councilRunId: input.councilRunId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    memberId: input.memberId,
    role: input.role,
    status: input.status || 'completed',
    summary: input.summary,
    ...(input.critique ? { critique: input.critique } : {}),
    ...(input.recommendedRoute
      ? { recommendedRoute: input.recommendedRoute }
      : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(typeof input.confidence === 'number'
      ? { confidence: input.confidence }
      : {}),
    inputSummary: input.inputSummary || '',
    outputSummary: input.outputSummary || input.summary,
    ...(input.visiblePrompt ? { visiblePrompt: input.visiblePrompt } : {}),
    ...(input.visibleResponse
      ? { visibleResponse: input.visibleResponse }
      : {}),
    ...(input.evidenceIds?.length ? { evidenceIds: input.evidenceIds } : {}),
    ...(typeof input.latencyMs === 'number'
      ? { latencyMs: Math.max(0, Math.round(input.latencyMs)) }
      : {}),
    ...(typeof input.estimatedTokenCount === 'number'
      ? {
          estimatedTokenCount: Math.max(
            0,
            Math.round(input.estimatedTokenCount),
          ),
        }
      : {}),
    estimatedCostTier: input.estimatedCostTier || 'unknown',
    riskFlags: input.riskFlags || [],
    metadata: {
      sourceSystem: 'andrea_nanobot',
      council_observatory_version: 'v1',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  return pickRecord(response) || null;
}

export async function finalizeAndreaPlatformCouncil(input: {
  councilRunId: string;
  correlationId?: string | null;
  finalRoute?: string | null;
  platformArbitrationReason: string;
  metadata?: Record<string, string>;
}): Promise<Record<string, unknown> | null> {
  const response = await postCoordinatorJson('/council/finalize', {
    councilRunId: input.councilRunId,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.finalRoute ? { finalRoute: input.finalRoute } : {}),
    platformArbitrationReason: input.platformArbitrationReason,
    metadata: {
      sourceSystem: 'andrea_nanobot',
      council_observatory_version: 'v1',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  return pickRecord(response) || null;
}

export async function emitAndreaPlatformCouncilChallenge(input: {
  runId: string;
  tier: 'small' | 'medium' | 'large' | 'xl' | 'ladder';
  mode?: 'mostly_live' | 'mocked' | 'baseline';
  status: 'pass' | 'warn' | 'fail' | 'degraded';
  totalScore: number;
  criticalFailureCount: number;
  providerHealth?: Record<string, string>;
  scenarios: Array<Record<string, unknown>>;
  results: Array<Record<string, unknown>>;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformCouncilChallengeResult | null> {
  const response = await postCoordinatorJson('/council-challenge', {
    runId: input.runId,
    tier: input.tier,
    mode: input.mode || 'mostly_live',
    status: input.status,
    totalScore: input.totalScore,
    criticalFailureCount: input.criticalFailureCount,
    providerHealth: input.providerHealth || {},
    scenarios: input.scenarios,
    results: input.results,
    metadata: {
      sourceSystem: 'andrea_nanobot',
      council_challenge_version: 'v2',
      one_approval_required_for_mutation: 'true',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const run = pickRecord(body.run);
  const issues = Array.isArray(body.issues) ? body.issues : [];
  return {
    runId: pickString(run?.run_id),
    status: pickString(run?.status) as
      | AndreaPlatformCouncilChallengeResult['status']
      | undefined,
    totalScore: pickNumber(run?.total_score),
    criticalFailureCount: pickNumber(run?.critical_failure_count),
    issueCount: issues.length,
  };
}

export async function emitAndreaPlatformIntelligenceRegression(input: {
  runId: string;
  mode: 'baseline' | 'regression';
  status: 'pass' | 'warn' | 'fail';
  totalScore: number;
  criticalScore: number;
  criticalFailureCount?: number;
  scenarioResults: AndreaPlatformIntelligenceScenarioResult[];
  baselineReportId?: string | null;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformIntelligenceRegressionResult | null> {
  const response = await postCoordinatorJson('/intelligence-regression', {
    runId: input.runId,
    mode: input.mode,
    status: input.status,
    totalScore: input.totalScore,
    criticalScore: input.criticalScore,
    ...(input.criticalFailureCount !== undefined
      ? { criticalFailureCount: input.criticalFailureCount }
      : {}),
    scenarioResults: input.scenarioResults,
    ...(input.baselineReportId
      ? { baselineReportId: input.baselineReportId }
      : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      harness_version: 'v14',
      raw_private_memory_allowed: 'false',
      secret_material_allowed: 'false',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  const report = pickRecord(body.report);
  return {
    reportId: pickString(report?.report_id),
    status: pickString(report?.status) as
      | AndreaPlatformIntelligenceRegressionResult['status']
      | undefined,
    mode: pickString(report?.mode) as
      | AndreaPlatformIntelligenceRegressionResult['mode']
      | undefined,
    totalScore: pickNumber(report?.total_score),
    criticalScore: pickNumber(report?.critical_score),
    scenarioCount: pickNumber(report?.scenario_count),
    criticalFailureCount: pickNumber(report?.critical_failure_count),
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
  actorId?: string | null;
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
    ...(input.actorId ? { actorId: input.actorId } : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      turn_intelligence_version: 'v10',
      ...(input.actorId ? { actor_id: input.actorId } : {}),
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

export async function emitAndreaPlatformSkillCandidate(input: {
  skillId: string;
  taskFamily: PlatformTaskFamily;
  sourceKind:
    | 'repeated_success'
    | 'downvote'
    | 'repair_success'
    | 'eval_failure'
    | 'guardrail_trip'
    | 'capability_gap'
    | 'operator_review';
  summary: string;
  evidenceCount?: number;
  riskLevel?: 'none' | 'low' | 'medium' | 'high';
  approvalRequired?: boolean;
  linkedTraceIds?: string[];
  linkedFeedbackIds?: string[];
  linkedRepairPlanIds?: string[];
  linkedEvaluationIds?: string[];
  linkedCapabilityGapIds?: string[];
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformSkillCandidateResult | null> {
  const response = await postCoordinatorJson('/skill-candidate', {
    skillId: input.skillId,
    taskFamily: input.taskFamily,
    sourceKind: input.sourceKind,
    summary: input.summary,
    evidenceCount: input.evidenceCount || 1,
    riskLevel: input.riskLevel || 'low',
    approvalRequired: input.approvalRequired || false,
    ...(input.linkedTraceIds && input.linkedTraceIds.length > 0
      ? { linkedTraceIds: input.linkedTraceIds }
      : {}),
    ...(input.linkedFeedbackIds && input.linkedFeedbackIds.length > 0
      ? { linkedFeedbackIds: input.linkedFeedbackIds }
      : {}),
    ...(input.linkedRepairPlanIds && input.linkedRepairPlanIds.length > 0
      ? { linkedRepairPlanIds: input.linkedRepairPlanIds }
      : {}),
    ...(input.linkedEvaluationIds && input.linkedEvaluationIds.length > 0
      ? { linkedEvaluationIds: input.linkedEvaluationIds }
      : {}),
    ...(input.linkedCapabilityGapIds && input.linkedCapabilityGapIds.length > 0
      ? { linkedCapabilityGapIds: input.linkedCapabilityGapIds }
      : {}),
    metadata: {
      sourceSystem: 'andrea_nanobot',
      raw_content_policy: 'metadata_only',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  return {
    candidate: pickSkillCandidateSummary(body.candidate),
  };
}

export async function listAndreaPlatformActiveSkillCandidates(
  taskFamily?: PlatformTaskFamily | null,
): Promise<AndreaPlatformSkillCandidateSummary[]> {
  const response = await getCoordinatorJson('/skill-evolution-report');
  if (!response || typeof response !== 'object') return [];
  const body = response as Record<string, unknown>;
  const active = Array.isArray(body.active_skills) ? body.active_skills : [];
  return active
    .map((item) => pickSkillCandidateSummary(item))
    .filter((item): item is AndreaPlatformSkillCandidateSummary => {
      if (!item) return false;
      return !taskFamily || item.taskFamily === taskFamily;
    })
    .slice(0, 8);
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
  const skillCandidate = pickRecord(body.skill_candidate);
  return {
    feedbackId: input.feedbackId,
    taskLedgerId: pickString(task?.task_ledger_id),
    progressLedgerId: pickString(progress?.progress_ledger_id),
    reflectionId: pickString(reflection?.reflection_id),
    evaluationId: pickString(evaluation?.evaluation_id),
    learningId: pickString(learning?.learning_id),
    skillCandidateId: pickString(skillCandidate?.candidate_id),
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

export interface AndreaPlatformRepairEvidenceResult {
  repairPlanId?: string;
  repairRunId?: string;
  executionId?: string;
  verificationEvidenceId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
}

export async function emitAndreaPlatformRepairEvidence(input: {
  repairPlanId: string;
  executionId?: string | null;
  correlationId?: string | null;
  evidenceKind?:
    | 'test'
    | 'build'
    | 'status'
    | 'smoke'
    | 'audit'
    | 'trace'
    | 'manual';
  command?: string | null;
  passed: boolean;
  summary: string;
  artifactPath?: string | null;
  final?: boolean;
  metadata?: Record<string, string>;
}): Promise<AndreaPlatformRepairEvidenceResult | null> {
  const response = await postCoordinatorJson('/repair/evidence', {
    repairPlanId: input.repairPlanId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    evidenceKind: input.evidenceKind || 'manual',
    ...(input.command ? { command: input.command } : {}),
    passed: input.passed,
    summary: input.summary,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    final: input.final ?? true,
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
    executionId:
      pickString(execution?.execution_id) || input.executionId || undefined,
    verificationEvidenceId: pickString(verification?.evidence_id),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export async function emitAndreaPlatformRepairDeployment(input: {
  repairPlanId: string;
  executionId?: string | null;
  correlationId?: string | null;
  commitSha?: string | null;
  services?: string[];
  status?: 'not_started' | 'restarted' | 'deployed' | 'failed' | 'blocked';
  verificationEvidenceIds?: string[];
  summary: string;
  metadata?: Record<string, string>;
}): Promise<{
  deploymentId?: string;
  repairRunId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
} | null> {
  const response = await postCoordinatorJson('/repair/deployment', {
    repairPlanId: input.repairPlanId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    ...(input.services && input.services.length > 0
      ? { services: input.services }
      : {}),
    status: input.status || 'not_started',
    ...(input.verificationEvidenceIds &&
    input.verificationEvidenceIds.length > 0
      ? { verificationEvidenceIds: input.verificationEvidenceIds }
      : {}),
    summary: input.summary,
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  return {
    deploymentId: pickNestedString(body, 'deployment', 'deployment_id'),
    repairRunId: pickNestedString(body, 'repair_run', 'repair_run_id'),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
  };
}

export async function emitAndreaPlatformRepairComplete(input: {
  repairPlanId: string;
  executionId?: string | null;
  deploymentId?: string | null;
  correlationId?: string | null;
  status?: 'completed' | 'blocked' | 'cancelled';
  finalHealthState?: string | null;
  summary: string;
  metadata?: Record<string, string>;
}): Promise<{
  repairRunId?: string;
  traceGradeId?: string;
  traceGradeStatus?: string;
  skillCandidateId?: string;
} | null> {
  const response = await postCoordinatorJson('/repair/complete', {
    repairPlanId: input.repairPlanId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.deploymentId ? { deploymentId: input.deploymentId } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    status: input.status || 'completed',
    ...(input.finalHealthState
      ? { finalHealthState: input.finalHealthState }
      : {}),
    summary: input.summary,
    metadata: {
      sourceSystem: 'andrea_nanobot',
      ...(input.metadata || {}),
    },
  });
  if (!response || typeof response !== 'object') return null;
  const body = response as Record<string, unknown>;
  return {
    repairRunId: pickNestedString(body, 'repair_run', 'repair_run_id'),
    traceGradeId: pickTraceGradeId(body),
    traceGradeStatus: pickTraceGradeStatus(body),
    skillCandidateId: pickNestedString(body, 'skill_candidate', 'candidate_id'),
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
