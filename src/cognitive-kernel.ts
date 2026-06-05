import { randomUUID } from 'node:crypto';

import type {
  AndreaPlatformProviderCouncilResult,
  PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import { isSensitiveName, redactCouncilText } from './council-safety.js';
import {
  findOpenCognitiveCheckpoint,
  buildCognitiveReplayPacket,
  getCognitiveGoal,
  getCognitiveRun,
  insertCognitiveBenchmarkAttempt,
  insertCognitiveReflection,
  insertCognitiveRewardSignal,
  listCognitiveAutonomyBudgets,
  listCognitiveBenchmarkAttempts,
  listCognitiveBlackboardEntries,
  listCognitiveCheckpoints,
  listCognitiveProviderCooldowns,
  listCognitiveReflections,
  listCognitiveGoals,
  listCognitiveRewardSignals,
  listCognitiveRuns,
  listCognitiveSkillCards,
  listCognitiveSubgoalsForRun,
  listCognitiveToolRegistry,
  listCognitiveWorldBeliefs,
  pruneCognitiveKernelData,
  replaceCognitiveSubgoalsForRun,
  resolveCognitiveCheckpoint,
  upsertCognitiveAutonomyBudget,
  upsertCognitiveBlackboardEntry,
  upsertCognitiveCheckpoint,
  upsertCognitiveGoal,
  upsertCognitiveProviderCooldown,
  upsertCognitiveRun,
  upsertCognitiveSkillCard,
  upsertCognitiveToolSimulation,
  upsertCognitiveTraceSpan,
  upsertCognitiveToolRegistry,
  upsertCognitiveWorldBelief,
} from './db.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type {
  CognitiveAutonomyLevel,
  CognitiveAutonomyBudgetRecord,
  CognitiveBenchmarkAttemptRecord,
  CognitiveBlackboardEntryRecord,
  CognitiveCheckpointRecord,
  CognitiveGoalRecord,
  CognitiveMode,
  CognitiveProviderCooldown,
  CognitiveReflectionRecord,
  CognitiveRunTraceReport,
  CognitiveRewardSignalRecord,
  CognitiveRunRecord,
  CognitiveRunStatus,
  CognitiveSkillCardRecord,
  CognitiveSubgoalRecord,
  CognitiveToolSimulation,
  CognitiveToolRegistryRecord,
  CognitiveTraceSpan,
  CognitiveWorldBeliefRecord,
} from './types.js';

const COGNITIVE_RETENTION_DAYS = 90;
const COGNITIVE_RETAIN_LIMIT = 1000;

export type CognitiveChannel = 'telegram' | 'bluebubbles' | 'alexa' | 'system';

export interface CognitiveFrame {
  runId: string;
  goal: string;
  taskFamily: PlatformTaskFamily;
  channel: CognitiveChannel;
  requestRoute?: string | null;
  trigger: 'simple' | 'normal' | 'deep' | 'approval_required' | 'read_only';
  selectedSkillId: string;
  selectedSkillPurpose: string;
  selectedSkillApprovalNeed: string;
  selectedSkillSideEffectRisk: string;
  selectedSkillEvidenceLevel: string;
}

export interface CognitiveToolCallPlan {
  toolId: string;
  actionClass:
    | 'local_lookup'
    | 'read_only_integration'
    | 'council'
    | 'draft'
    | 'approval_gate'
    | 'operator';
  purpose: string;
  approvalRequired: boolean;
}

export interface CognitiveSubgoal {
  subgoalId: string;
  title: string;
  status: CognitiveSubgoalRecord['status'];
  requiredEvidence: string;
  allowedActions: string[];
  approvalNeed: string;
  stopCondition: string;
  toolPlan: CognitiveToolCallPlan[];
  verification: Record<string, unknown>;
}

export interface CognitiveTaskGraph {
  graphId: string;
  loop: Array<
    | 'perceive'
    | 'frame'
    | 'plan'
    | 'act_read'
    | 'verify'
    | 'answer_stage'
    | 'reflect_learn'
  >;
  subgoals: CognitiveSubgoal[];
  selectedSkillId?: string | null;
}

export interface CognitiveVerificationResult {
  status: 'pending' | 'pass' | 'warn' | 'block';
  criteria: string[];
  evidenceGaps: string[];
  approvalRequired: boolean;
  councilRunId?: string | null;
  councilStatus?: string | null;
  providerUsableCount: number;
  providerDegradedCount: number;
  nextAction: string;
}

export interface CognitiveRewardSignal {
  kind: CognitiveRewardSignalRecord['signalKind'];
  score: number;
  summary: string;
  flags: string[];
}

export interface CognitiveSkillCard {
  skillId: string;
  taskFamily: string;
  triggerSummary: string;
  skillSummary: string;
  promotionState: CognitiveSkillCardRecord['promotionState'];
  latestOutcomeScore: number;
}

export interface CognitiveWorldBelief {
  beliefId: string;
  source:
    | 'provider_health'
    | 'skill_library'
    | 'council_verdict'
    | 'integration_status'
    | 'local_metadata';
  summary: string;
  confidence: number;
  freshness: 'fresh' | 'stale' | 'unknown';
}

export interface BeginCognitiveKernelInput {
  turnId: string;
  channel: CognitiveChannel;
  groupFolder?: string | null;
  taskFamily: PlatformTaskFamily;
  goal: string;
  requestRoute?: string | null;
  selectedSkillId: string;
  selectedSkillPurpose: string;
  selectedSkillApprovalNeed: string;
  selectedSkillSideEffectRisk: string;
  selectedSkillEvidenceLevel: string;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  providerHealthSnapshots?: ProviderHealthSnapshot[];
  knownBlockers?: string[];
  thinkingPreference?: string | null;
  thinkingTrigger?: string | null;
}

export interface CognitiveKernelResult {
  run: CognitiveRunRecord;
  frame: CognitiveFrame;
  taskGraph: CognitiveTaskGraph;
  verification: CognitiveVerificationResult;
  selectedSkill?: CognitiveSkillCard | null;
  worldBeliefs: CognitiveWorldBelief[];
  activeGoal?: CognitiveGoalRecord | null;
  blackboardSnapshot: CognitiveBlackboardEntryRecord[];
  autonomyBudget?: CognitiveAutonomyBudgetRecord | null;
  toolSimulations: CognitiveToolSimulation[];
  traceSpans: CognitiveTraceSpan[];
  providerCooldowns: CognitiveProviderCooldown[];
  rewardPreview: CognitiveRewardSignal;
}

export interface FinalizeCognitiveKernelOutcomeInput {
  cognitiveRun: CognitiveKernelResult | null | undefined;
  evaluationStatus: 'pass' | 'warn' | 'block';
  evidenceGap: 'none' | 'minor' | 'major' | 'blocked';
  evaluatorFlags: string[];
  routeUsed: string;
  answerClass: 'handled' | 'blocked' | 'degraded' | 'fallback' | 'unknown';
  blockerClass?: string | null;
  fallbackUsed?: boolean;
}

export interface CognitiveDoctorReport {
  generatedAt: string;
  ok: boolean;
  summary: string;
  activeRun?: {
    runId: string;
    updatedAt: string;
    taskFamily: string;
    mode: CognitiveMode;
    status: CognitiveRunStatus;
    selectedSkillId: string;
    outcomeScore: number;
    nextAction: string;
    subgoalCount: number;
  } | null;
  recent: {
    totalRuns: number;
    blockedRuns: number;
    approvalRuns: number;
    averageOutcomeScore: number;
    rewardSignals: number;
    reflections: number;
  };
  skills: {
    total: number;
    promoted: number;
    candidates: number;
    quarantined: number;
    latestSkillId?: string | null;
  };
  providerUsability: {
    healthy: number;
    degraded: number;
    blocked: number;
    degradedProviderIds: string[];
  };
  checkpoints: {
    total: number;
    open: number;
    latestKind?: CognitiveCheckpointRecord['checkpointKind'] | null;
    latestNextAction?: string | null;
  };
  toolRegistry: {
    total: number;
    healthy: number;
    approvalGated: number;
    blocked: number;
    highRisk: number;
  };
  worldBeliefs: {
    total: number;
    fresh: number;
    stale: number;
    latestSubject?: string | null;
  };
  benchmarks: {
    total: number;
    latestStatus?: CognitiveBenchmarkAttemptRecord['status'] | null;
    latestScore?: number | null;
    failingTaskIds: string[];
  };
  goals: {
    total: number;
    active: number;
    waitingApproval: number;
    blocked: number;
    latestGoalId?: string | null;
  };
  blackboard: {
    total: number;
    active: number;
    latestKind?: CognitiveBlackboardEntryRecord['entryKind'] | null;
  };
  autonomyBudgets: {
    total: number;
    approvalRequired: number;
    mutatingAllowed: number;
  };
  evidenceGaps: string[];
  approvalBlockers: string[];
  trace: {
    spanCount: number;
    blockedSpanCount: number;
    latestSpanKind?: CognitiveTraceSpan['spanKind'] | null;
  };
  simulation: {
    total: number;
    pass: number;
    warn: number;
    block: number;
    status: 'pass' | 'warn' | 'block' | 'none';
  };
  providerCooldowns: {
    active: number;
    providerIds: string[];
    nextAction?: string | null;
  };
  nextAction: string;
  privacy: {
    metadataOnly: true;
    rawPromptsStored: false;
    rawPrivateBodiesStored: false;
    hiddenReasoningStored: false;
    secretsRedacted: true;
  };
}

export interface CognitiveResumePlan {
  found: boolean;
  checkpoint?: CognitiveCheckpointRecord | null;
  run?: CognitiveRunRecord | null;
  goal?: CognitiveGoalRecord | null;
  blackboardEntries: CognitiveBlackboardEntryRecord[];
  subgoalCount: number;
  nextAction: string;
  privacy: CognitiveDoctorReport['privacy'];
}

export interface CognitiveBenchmarkReport {
  generatedAt: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  attempts: CognitiveBenchmarkAttemptRecord[];
  nextAction: string;
  privacy: CognitiveDoctorReport['privacy'];
}

function nowIso(): string {
  return new Date().toISOString();
}

function redactJsonValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveName(key) && !/redacted/i.test(key)) {
    return '[REDACTED_SECRET]';
  }
  if (typeof value === 'string') return redactCouncilText(value, 2000);
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((child) => redactJsonValue(child));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[childKey] = redactJsonValue(childValue, childKey);
    }
    return output;
  }
  return null;
}

function safeJson(value: unknown, limit = 12000): string {
  try {
    const json = JSON.stringify(redactJsonValue(value ?? null));
    if (json.length <= limit) return json;
    return JSON.stringify({
      truncated: true,
      summary: redactCouncilText(json, limit - 80),
    });
  } catch {
    return 'null';
  }
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeDb<T>(fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function privacyPolicyJson(): string {
  return safeJson({
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  });
}

function defaultToolRegistryRecords(
  now: string,
): CognitiveToolRegistryRecord[] {
  const privacyJson = privacyPolicyJson();
  const tool = (
    record: Omit<
      CognitiveToolRegistryRecord,
      | 'createdAt'
      | 'updatedAt'
      | 'allowedActionsJson'
      | 'evidenceProducedJson'
      | 'failureModesJson'
      | 'privacyJson'
    > & {
      allowedActions: string[];
      evidenceProduced: string[];
      failureModes: string[];
    },
  ): CognitiveToolRegistryRecord => ({
    toolId: record.toolId,
    createdAt: now,
    updatedAt: now,
    toolKind: record.toolKind,
    displayName: record.displayName,
    purpose: redactCouncilText(record.purpose, 520),
    allowedActionsJson: safeJson(record.allowedActions, 1600),
    approvalPolicy: record.approvalPolicy,
    riskLevel: record.riskLevel,
    evidenceProducedJson: safeJson(record.evidenceProduced, 1600),
    failureModesJson: safeJson(record.failureModes, 1600),
    lastVerifiedAt: now,
    healthState: record.healthState,
    privacyJson,
  });
  return [
    tool({
      toolId: 'local_skill_library',
      toolKind: 'local_lookup',
      displayName: 'Skill Library',
      purpose: 'Retrieve reusable sanitized task patterns and failure modes.',
      allowedActions: [
        'read_skill_metadata',
        'read_previous_outcome_summaries',
      ],
      approvalPolicy: 'none',
      riskLevel: 'low',
      evidenceProduced: ['skill_card_ids', 'verification_checklists'],
      failureModes: ['no_matching_skill', 'quarantined_skill'],
      healthState: 'healthy',
    }),
    tool({
      toolId: 'provider_health',
      toolKind: 'local_lookup',
      displayName: 'Provider Health',
      purpose: 'Read model/provider usability before assigning roles.',
      allowedActions: ['read_provider_status'],
      approvalPolicy: 'none',
      riskLevel: 'low',
      evidenceProduced: ['provider_states', 'degraded_provider_ids'],
      failureModes: ['provider_probe_unavailable'],
      healthState: 'healthy',
    }),
    tool({
      toolId: 'provider_council',
      toolKind: 'council',
      displayName: 'Provider Council',
      purpose: 'Use multi-model planner/verifier guidance as evidence.',
      allowedActions: ['request_structured_verdict'],
      approvalPolicy: 'none',
      riskLevel: 'medium',
      evidenceProduced: ['council_run_id', 'verdict_status', 'risk_flags'],
      failureModes: ['degraded_provider', 'schema_invalid', 'verifier_stop'],
      healthState: 'unknown',
    }),
    tool({
      toolId: 'google_calendar_read',
      toolKind: 'read_only_integration',
      displayName: 'Google Calendar Read',
      purpose:
        'Read calendar metadata when a calendar answer needs live evidence.',
      allowedActions: ['read_calendar_events'],
      approvalPolicy: 'read_only',
      riskLevel: 'medium',
      evidenceProduced: ['calendar_read_metadata', 'calendar_blocker'],
      failureModes: ['oauth_missing', 'calendar_unreachable'],
      healthState: 'unknown',
    }),
    tool({
      toolId: 'brave_search',
      toolKind: 'read_only_integration',
      displayName: 'Brave Search',
      purpose:
        'Fill public/live evidence gaps after local-first evidence is insufficient.',
      allowedActions: ['public_web_search'],
      approvalPolicy: 'read_only',
      riskLevel: 'medium',
      evidenceProduced: ['public_source_ids', 'freshness_notes'],
      failureModes: ['search_key_missing', 'rate_limited'],
      healthState: 'unknown',
    }),
    tool({
      toolId: 'bluebubbles_draft',
      toolKind: 'draft',
      displayName: 'BlueBubbles Draft',
      purpose: 'Draft or revise Messages replies without sending.',
      allowedActions: ['draft_reply', 'revise_draft', 'defer_draft'],
      approvalPolicy: 'explicit_approval',
      riskLevel: 'high',
      evidenceProduced: ['draft_id', 'same_thread_policy'],
      failureModes: [
        'same_thread_missing',
        'stale_approval',
        'send_policy_blocked',
      ],
      healthState: 'unknown',
    }),
    tool({
      toolId: 'approval_stage',
      toolKind: 'approval_gate',
      displayName: 'Approval Stage',
      purpose:
        'Hold mutating actions until explicit same-channel approval is recorded.',
      allowedActions: ['stage_approval', 'explain_waiting_state'],
      approvalPolicy: 'explicit_approval',
      riskLevel: 'high',
      evidenceProduced: ['approval_checkpoint_id', 'approval_ttl'],
      failureModes: ['approval_missing', 'approval_expired', 'wrong_thread'],
      healthState: 'healthy',
    }),
    tool({
      toolId: 'operator_diagnostics',
      toolKind: 'operator',
      displayName: 'Operator Diagnostics',
      purpose:
        'Read service/debug status and stage repair plans for operator review.',
      allowedActions: ['read_status', 'stage_repair_plan'],
      approvalPolicy: 'explicit_approval',
      riskLevel: 'high',
      evidenceProduced: ['status_summary', 'repair_blocker'],
      failureModes: ['main_control_missing', 'mutation_requires_approval'],
      healthState: 'unknown',
    }),
  ];
}

function ensureCognitiveToolRegistry(
  now = nowIso(),
): CognitiveToolRegistryRecord[] {
  safeDb(undefined, () => {
    for (const record of defaultToolRegistryRecords(now)) {
      upsertCognitiveToolRegistry(record);
    }
    return undefined;
  });
  return safeDb(defaultToolRegistryRecords(now), () =>
    listCognitiveToolRegistry({ limit: 100 }),
  );
}

function validateToolPlanAgainstRegistry(
  plans: CognitiveToolCallPlan[],
  registry: CognitiveToolRegistryRecord[],
): {
  pass: boolean;
  issues: string[];
  allowedToolIds: string[];
} {
  const byId = new Map(registry.map((tool) => [tool.toolId, tool]));
  const issues: string[] = [];
  for (const plan of plans) {
    const tool = byId.get(plan.toolId);
    if (!tool) {
      issues.push(`unknown_tool:${plan.toolId}`);
      continue;
    }
    if (tool.approvalPolicy === 'forbidden') {
      issues.push(`forbidden_tool:${plan.toolId}`);
    }
    if (
      (tool.approvalPolicy === 'explicit_approval' ||
        tool.riskLevel === 'high') &&
      !plan.approvalRequired
    ) {
      issues.push(`approval_missing:${plan.toolId}`);
    }
    if (tool.healthState === 'blocked') {
      issues.push(`tool_blocked:${plan.toolId}`);
    }
  }
  return {
    pass: issues.length === 0,
    issues,
    allowedToolIds: plans
      .filter((plan) => byId.has(plan.toolId))
      .map((plan) => plan.toolId),
  };
}

function describeTextShape(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  const words = trimmed.split(/\s+/).length;
  const hasQuestion = /\?|\b(what|when|why|how|should|can|could)\b/i.test(
    trimmed,
  );
  const hasAction =
    /\b(send|create|delete|move|cancel|schedule|remember|forget|approve|buy|deploy|restart|commit|push)\b/i.test(
      trimmed,
    );
  return `words=${words}; question=${hasQuestion}; action=${hasAction}`;
}

function summarizeGoal(
  goal: string,
  taskFamily: PlatformTaskFamily,
  channel: CognitiveChannel,
): string {
  if (taskFamily === 'communication') {
    return redactCouncilText(
      `Communication task from ${channel}; raw message body stays local. Shape: ${describeTextShape(goal)}.`,
      480,
    );
  }
  return redactCouncilText(goal, 480);
}

function providerUsability(providers = collectProviderHealthSnapshots()): {
  healthy: number;
  degraded: number;
  blocked: number;
  degradedProviderIds: string[];
  snapshots: Array<Record<string, unknown>>;
} {
  const degradedProviderIds = providers
    .filter((provider) => provider.state !== 'healthy')
    .map((provider) => provider.providerId);
  return {
    healthy: providers.filter((provider) => provider.state === 'healthy')
      .length,
    degraded: providers.filter((provider) => provider.state === 'degraded')
      .length,
    blocked: providers.filter(
      (provider) =>
        provider.state === 'externally_blocked' ||
        provider.state === 'not_configured',
    ).length,
    degradedProviderIds,
    snapshots: providers.map((provider) => ({
      providerId: provider.providerId,
      state: provider.state,
      credentialState: provider.credentialState,
      blocker: redactCouncilText(provider.blocker || '', 220),
      checkedAt: provider.lastCheckedAt,
    })),
  };
}

function cooldownUntilFor(
  snapshot: ProviderHealthSnapshot,
  now: string,
): string {
  const base = Date.parse(now);
  const minutes =
    snapshot.failureClass === 'quota_or_rate_limit'
      ? 30
      : snapshot.failureClass === 'auth_failure' ||
          snapshot.failureClass === 'missing_credentials'
        ? 24 * 60
        : snapshot.failureClass === 'transport_error'
          ? 10
          : snapshot.failureClass === 'manual_external'
            ? 12 * 60
            : 15;
  return new Date(base + minutes * 60 * 1000).toISOString();
}

function persistProviderCooldowns(input: {
  snapshots: ProviderHealthSnapshot[];
  runId?: string | null;
  now: string;
}): CognitiveProviderCooldown[] {
  const records: CognitiveProviderCooldown[] = [];
  for (const snapshot of input.snapshots) {
    const blocked =
      snapshot.state === 'externally_blocked' ||
      snapshot.state === 'not_configured' ||
      snapshot.credentialState === 'missing' ||
      snapshot.credentialState === 'invalid';
    const record: CognitiveProviderCooldown = {
      providerId: snapshot.providerId,
      createdAt: input.now,
      updatedAt: input.now,
      status: blocked ? 'active' : 'cleared',
      failureClass: snapshot.failureClass || 'none',
      source: 'cognition',
      runId: input.runId || null,
      cooldownUntil: blocked
        ? cooldownUntilFor(snapshot, input.now)
        : input.now,
      lastFailure: blocked
        ? snapshot.blocker ||
          snapshot.nextAction ||
          `${snapshot.providerId} blocked.`
        : '',
      nextAction: blocked
        ? snapshot.nextAction ||
          `Wait for ${snapshot.providerId} recovery, then rerun provider diagnostics.`
        : '',
      metadataJson: safeJson({
        state: snapshot.state,
        quotaState: snapshot.quotaState,
        credentialState: snapshot.credentialState,
        liveFailureClass: snapshot.metadata.liveFailureClass || '',
      }),
      privacyJson: privacyPolicyJson(),
    };
    records.push(record);
    safeDb(undefined, () => upsertCognitiveProviderCooldown(record));
  }
  return records.filter((record) => record.status === 'active');
}

function activeProviderCooldowns(now = nowIso()): CognitiveProviderCooldown[] {
  return safeDb([], () =>
    listCognitiveProviderCooldowns({
      status: 'active',
      activeAt: now,
      limit: 25,
    }),
  );
}

function simulateToolPlan(input: {
  runId: string;
  plans: CognitiveToolCallPlan[];
  registry: CognitiveToolRegistryRecord[];
  autonomyBudget: CognitiveAutonomyBudgetRecord;
  budgetPolicy: ReturnType<typeof validateAutonomyBudget>;
  now: string;
}): CognitiveToolSimulation[] {
  const byId = new Map(input.registry.map((tool) => [tool.toolId, tool]));
  return input.plans.map((plan, index) => {
    const tool = byId.get(plan.toolId);
    const issues: string[] = [];
    if (!tool) issues.push(`unknown_tool:${plan.toolId}`);
    if (tool?.approvalPolicy === 'forbidden') issues.push('tool_forbidden');
    if (tool?.healthState === 'blocked') issues.push('tool_blocked');
    if (
      (tool?.approvalPolicy === 'explicit_approval' ||
        tool?.riskLevel === 'high') &&
      !plan.approvalRequired
    ) {
      issues.push('approval_required_missing');
    }
    if (
      !input.autonomyBudget.mutatingAllowed &&
      /\b(send|delete|create|commit|push|restart|buy|purchase)\b/i.test(
        plan.purpose,
      ) &&
      !plan.approvalRequired
    ) {
      issues.push('mutating_action_not_allowed');
    }
    if (!input.budgetPolicy.pass) {
      issues.push(
        ...input.budgetPolicy.issues.map((issue) => `budget:${issue}`),
      );
    }
    const status: CognitiveToolSimulation['status'] = issues.some((issue) =>
      /unknown|forbidden|blocked|approval_required_missing|mutating|budget:/.test(
        issue,
      ),
    )
      ? 'block'
      : tool?.healthState === 'unknown' || tool?.healthState === 'degraded'
        ? 'warn'
        : 'pass';
    const record: CognitiveToolSimulation = {
      simulationId: sanitizeId(
        `cogsim:${input.runId}:${String(index + 1).padStart(2, '0')}:${plan.toolId}`,
      ),
      createdAt: input.now,
      runId: input.runId,
      toolId: plan.toolId,
      actionClass: plan.actionClass,
      status,
      approvalRequired: plan.approvalRequired,
      readOnly: ['local_lookup', 'read_only_integration', 'council'].includes(
        plan.actionClass,
      ),
      riskLevel: tool?.riskLevel || 'unknown',
      evidenceExpectedJson: safeJson(
        parseJsonSafe<string[]>(tool?.evidenceProducedJson, []),
        1600,
      ),
      failureModesJson: safeJson(
        parseJsonSafe<string[]>(tool?.failureModesJson, []),
        1600,
      ),
      issuesJson: safeJson(issues, 1600),
      nextAction:
        status === 'block'
          ? 'Repair tool policy, approval gate, or autonomy budget before acting.'
          : status === 'warn'
            ? 'Proceed only with explicit degraded-tool wording.'
            : 'Tool simulation passed; proceed within policy.',
      privacyJson: privacyPolicyJson(),
    };
    safeDb(undefined, () => upsertCognitiveToolSimulation(record));
    return record;
  });
}

function simulationAggregate(
  simulations: CognitiveToolSimulation[],
): CognitiveDoctorReport['simulation'] {
  const block = simulations.filter(
    (simulation) => simulation.status === 'block',
  ).length;
  const warn = simulations.filter(
    (simulation) => simulation.status === 'warn',
  ).length;
  const pass = simulations.filter(
    (simulation) => simulation.status === 'pass',
  ).length;
  return {
    total: simulations.length,
    pass,
    warn,
    block,
    status:
      simulations.length === 0
        ? 'none'
        : block > 0
          ? 'block'
          : warn > 0
            ? 'warn'
            : 'pass',
  };
}

function traceSpan(input: {
  runId?: string | null;
  goalId?: string | null;
  parentSpanId?: string | null;
  spanKind: CognitiveTraceSpan['spanKind'];
  status: CognitiveTraceSpan['status'];
  summary: string;
  inputSummary?: string;
  outputSummary?: string;
  metadata?: Record<string, unknown>;
  now: string;
}): CognitiveTraceSpan {
  return {
    spanId: sanitizeId(
      `cogspan:${input.runId || 'global'}:${input.spanKind}:${randomUUID()}`,
    ),
    createdAt: input.now,
    endedAt: input.now,
    runId: input.runId || null,
    goalId: input.goalId || null,
    parentSpanId: input.parentSpanId || null,
    spanKind: input.spanKind,
    status: input.status,
    summary: redactCouncilText(input.summary, 520),
    inputSummary: redactCouncilText(input.inputSummary || '', 520),
    outputSummary: redactCouncilText(input.outputSummary || '', 520),
    metadataJson: safeJson(input.metadata || {}, 2400),
    privacyJson: privacyPolicyJson(),
  };
}

function persistTraceSpans(spans: CognitiveTraceSpan[]): CognitiveTraceSpan[] {
  safeDb(undefined, () => {
    for (const span of spans) upsertCognitiveTraceSpan(span);
    return undefined;
  });
  return spans;
}

function selectCognitiveMode(input: BeginCognitiveKernelInput): {
  cognitiveMode: CognitiveMode;
  autonomyLevel: CognitiveAutonomyLevel;
  trigger: CognitiveFrame['trigger'];
} {
  const text = input.goal.toLowerCase();
  const forceDeep =
    input.thinkingPreference === 'deep' ||
    /\b(ultrathink|ultracode|think harder|max[- ]?iq|use all models)\b/i.test(
      input.goal,
    );
  const approvalRequired =
    input.selectedSkillApprovalNeed === 'explicit' ||
    /\b(send|delete|buy|purchase|cancel|move|create|schedule|forget|approve|deploy|restart|commit|push)\b/i.test(
      text,
    );
  if (approvalRequired) {
    return {
      cognitiveMode: 'approval_staged',
      autonomyLevel: 'plan_draft_only',
      trigger: 'approval_required',
    };
  }
  if (forceDeep || input.providerCouncil) {
    return {
      cognitiveMode: 'council_verified',
      autonomyLevel: 'read_only_tools',
      trigger: forceDeep ? 'deep' : 'normal',
    };
  }
  if (
    input.taskFamily === 'calendar' ||
    input.taskFamily === 'research' ||
    /\b(calendar|schedule|research|latest|search|status|diagnose|debug)\b/i.test(
      text,
    )
  ) {
    return {
      cognitiveMode: 'read_only_react',
      autonomyLevel: 'read_only_tools',
      trigger: 'read_only',
    };
  }
  return {
    cognitiveMode: 'reactive_plan',
    autonomyLevel: 'plan_draft_only',
    trigger: 'normal',
  };
}

function buildEvidenceContract(input: BeginCognitiveKernelInput): {
  required: string[];
  localFirstOrder: string[];
  liveSearchAllowed: boolean;
  rawContentPolicy: string;
  knownBlockers: string[];
} {
  const required = ['sanitized_goal', 'selected_skill_policy'];
  if (input.selectedSkillEvidenceLevel !== 'unknown') {
    required.push(`skill_evidence:${input.selectedSkillEvidenceLevel}`);
  }
  if (input.providerCouncil?.councilRunId) required.push('council_verdict');
  if (input.taskFamily === 'calendar') required.push('calendar_read_metadata');
  if (input.taskFamily === 'communication') {
    required.push('thread_metadata_or_sanitized_digest');
  }
  return {
    required,
    localFirstOrder: [
      'skill_library',
      'profile_facts',
      'life_threads',
      'knowledge_chunks',
      'previous_outcomes',
      'provider_health',
      'integration_status',
      'live_search_when_needed',
    ],
    liveSearchAllowed:
      input.taskFamily === 'research' ||
      /\b(latest|today|current|search|research|web|public)\b/i.test(input.goal),
    rawContentPolicy:
      'metadata_only; no raw prompts, hidden reasoning, private bodies, secrets, or raw tool output',
    knownBlockers: (input.knownBlockers || []).map((blocker) =>
      redactCouncilText(blocker, 240),
    ),
  };
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9:_.-]/g, '_').slice(0, 180);
}

function goalIdFor(input: {
  groupFolder?: string | null;
  taskFamily: PlatformTaskFamily | string;
  selectedSkillId: string;
}): string {
  return sanitizeId(
    `coggoal:${input.groupFolder || 'global'}:${input.taskFamily}:${input.selectedSkillId}`,
  );
}

function buildAutonomyBudget(input: {
  mode: CognitiveMode;
  taskFamily: PlatformTaskFamily;
  approvalRequired: boolean;
  now: string;
}): CognitiveAutonomyBudgetRecord {
  const readOnly =
    input.mode === 'read_only_react' || input.mode === 'council_verified';
  const approval = input.approvalRequired || input.mode === 'approval_staged';
  const budget = {
    localFirst: true,
    readOnlyAutonomy: readOnly,
    approvalFirst: approval,
    hiddenReasoningStored: false,
    rawToolOutputStored: false,
  };
  return {
    budgetId: sanitizeId(`cogbudget:${input.mode}:${input.taskFamily}`),
    createdAt: input.now,
    updatedAt: input.now,
    cognitiveMode: input.mode,
    taskFamily: input.taskFamily,
    maxToolSteps:
      input.mode === 'council_verified'
        ? 8
        : input.mode === 'approval_staged'
          ? 6
          : 4,
    maxCouncilCalls: input.mode === 'council_verified' ? 1 : 0,
    maxReadOnlyCalls: readOnly ? 3 : 1,
    mutatingAllowed: false,
    approvalRequired: approval,
    maxRuntimeMs: input.mode === 'council_verified' ? 45000 : 15000,
    clarificationAfterBlockedSteps: 1,
    budgetJson: safeJson(budget, 1600),
    privacyJson: privacyPolicyJson(),
  };
}

function validateAutonomyBudget(input: {
  budget: CognitiveAutonomyBudgetRecord;
  plans: CognitiveToolCallPlan[];
}): {
  pass: boolean;
  issues: string[];
  usedToolSteps: number;
  usedReadOnlyCalls: number;
  usedCouncilCalls: number;
} {
  const usedToolSteps = input.plans.length;
  const usedReadOnlyCalls = input.plans.filter(
    (plan) => plan.actionClass === 'read_only_integration',
  ).length;
  const usedCouncilCalls = input.plans.filter(
    (plan) => plan.actionClass === 'council',
  ).length;
  const issues: string[] = [];
  if (usedToolSteps > input.budget.maxToolSteps)
    issues.push('tool_step_budget_exceeded');
  if (usedReadOnlyCalls > input.budget.maxReadOnlyCalls) {
    issues.push('read_only_budget_exceeded');
  }
  if (usedCouncilCalls > input.budget.maxCouncilCalls) {
    issues.push('council_budget_exceeded');
  }
  if (
    !input.budget.mutatingAllowed &&
    input.plans.some(
      (plan) =>
        !['draft', 'approval_gate'].includes(plan.actionClass) &&
        /\b(send|delete|create|commit|push|restart|buy|purchase)\b/i.test(
          plan.purpose,
        ),
    )
  ) {
    issues.push('mutating_action_not_allowed');
  }
  if (
    input.budget.approvalRequired &&
    !input.plans.some((plan) => plan.toolId === 'approval_stage')
  ) {
    issues.push('approval_gate_missing');
  }
  return {
    pass: issues.length === 0,
    issues,
    usedToolSteps,
    usedReadOnlyCalls,
    usedCouncilCalls,
  };
}

function goalStatusForRun(
  run: CognitiveRunRecord,
  verification: CognitiveVerificationResult,
): CognitiveGoalRecord['status'] {
  if (run.status === 'awaiting_approval') return 'waiting_approval';
  if (run.status === 'awaiting_evidence') return 'waiting_evidence';
  if (run.status === 'blocked' || verification.status === 'block')
    return 'blocked';
  if (run.status === 'answered' || run.status === 'learned') return 'satisfied';
  if (verification.evidenceGaps.length > 0) return 'waiting_evidence';
  return 'active';
}

function upsertGoalForRun(input: {
  run: CognitiveRunRecord;
  graph: CognitiveTaskGraph;
  verification: CognitiveVerificationResult;
  activeCheckpointId?: string | null;
  now: string;
}): CognitiveGoalRecord {
  const goalId = goalIdFor(input.run);
  const existing = safeDb<CognitiveGoalRecord | undefined>(undefined, () =>
    getCognitiveGoal(goalId),
  );
  const linked = Array.from(
    new Set([
      ...parseJsonSafe<string[]>(existing?.linkedRunIdsJson, []),
      input.run.runId,
    ]),
  ).slice(-25);
  const status = goalStatusForRun(input.run, input.verification);
  const closedAt =
    status === 'satisfied' || status === 'blocked' || status === 'abandoned'
      ? input.now
      : null;
  const record: CognitiveGoalRecord = {
    goalId,
    createdAt: existing?.createdAt || input.now,
    updatedAt: input.now,
    groupFolder: input.run.groupFolder || null,
    parentGoalId: existing?.parentGoalId || null,
    rootRunId: existing?.rootRunId || input.run.runId,
    taskFamily: input.run.taskFamily,
    objectiveSummary: redactCouncilText(input.run.goalSummary, 520),
    status,
    priority:
      input.run.cognitiveMode === 'approval_staged'
        ? 0.9
        : input.run.cognitiveMode === 'council_verified'
          ? 0.8
          : 0.6,
    successCriteriaJson: safeJson(
      {
        criteria: [
          'evidence contract satisfied or blocker named',
          'approval-first boundary preserved',
          'outcome signal captured',
        ],
        verificationStatus: input.verification.status,
      },
      1800,
    ),
    decompositionJson: safeJson(
      input.graph.subgoals.map((subgoal, index) => ({
        position: index + 1,
        title: subgoal.title,
        approvalNeed: subgoal.approvalNeed,
        stopCondition: subgoal.stopCondition,
      })),
      3200,
    ),
    linkedRunIdsJson: safeJson(linked, 1600),
    activeCheckpointId:
      input.activeCheckpointId || existing?.activeCheckpointId || null,
    rewardScore: input.run.outcomeScore || existing?.rewardScore || 0,
    nextAction: redactCouncilText(input.run.nextAction, 420),
    closedAt,
    privacyJson: privacyPolicyJson(),
  };
  upsertCognitiveGoal(record);
  return record;
}

function blackboardEntry(input: {
  goalId?: string | null;
  runId?: string | null;
  groupFolder?: string | null;
  entryKind: CognitiveBlackboardEntryRecord['entryKind'];
  source: CognitiveBlackboardEntryRecord['source'];
  status?: CognitiveBlackboardEntryRecord['status'];
  summary: string;
  evidenceRefs: string[];
  confidence: number;
  now: string;
}): CognitiveBlackboardEntryRecord {
  return {
    entryId: sanitizeId(
      `cogbb:${input.runId || input.goalId || 'global'}:${input.entryKind}:${input.source}:${randomUUID()}`,
    ),
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    goalId: input.goalId || null,
    runId: input.runId || null,
    entryKind: input.entryKind,
    source: input.source,
    status: input.status || 'active',
    summary: redactCouncilText(input.summary, 520),
    evidenceRefsJson: safeJson(
      input.evidenceRefs.map((ref) => redactCouncilText(ref, 160)),
    ),
    confidence: clamp01(input.confidence),
    expiresAt: null,
    privacyJson: privacyPolicyJson(),
  };
}

function persistInitialBlackboard(input: {
  run: CognitiveRunRecord;
  goal: CognitiveGoalRecord;
  verification: CognitiveVerificationResult;
  toolPolicy: ReturnType<typeof validateToolPlanAgainstRegistry>;
  budgetPolicy: ReturnType<typeof validateAutonomyBudget>;
  checkpoints: CognitiveCheckpointRecord[];
  now: string;
}): CognitiveBlackboardEntryRecord[] {
  const checkpointRefs = input.checkpoints.map(
    (checkpoint) => checkpoint.checkpointId,
  );
  const entries = [
    blackboardEntry({
      goalId: input.goal.goalId,
      runId: input.run.runId,
      groupFolder: input.run.groupFolder || null,
      entryKind: 'observation',
      source: 'kernel',
      summary: `Goal framed for ${input.run.taskFamily} through ${input.run.cognitiveMode}.`,
      evidenceRefs: [input.run.runId, ...checkpointRefs.slice(0, 2)],
      confidence: 0.75,
      now: input.now,
    }),
    blackboardEntry({
      goalId: input.goal.goalId,
      runId: input.run.runId,
      groupFolder: input.run.groupFolder || null,
      entryKind: 'constraint',
      source: 'tool_registry',
      status:
        input.toolPolicy.pass && input.budgetPolicy.pass ? 'active' : 'blocked',
      summary:
        input.toolPolicy.pass && input.budgetPolicy.pass
          ? 'Tool and autonomy budgets allow only bounded, approval-aware execution.'
          : 'Tool or autonomy budget requires repair before acting.',
      evidenceRefs: [
        'tool_policy',
        'autonomy_budget',
        ...input.toolPolicy.allowedToolIds,
      ],
      confidence: input.toolPolicy.pass && input.budgetPolicy.pass ? 0.9 : 0.45,
      now: input.now,
    }),
    blackboardEntry({
      goalId: input.goal.goalId,
      runId: input.run.runId,
      groupFolder: input.run.groupFolder || null,
      entryKind: 'verification',
      source: 'checkpoint',
      status: input.verification.status === 'block' ? 'blocked' : 'active',
      summary: `Verification status ${input.verification.status}; next action is metadata-only.`,
      evidenceRefs: checkpointRefs,
      confidence:
        input.verification.status === 'block'
          ? 0.35
          : input.verification.status === 'warn'
            ? 0.62
            : 0.8,
      now: input.now,
    }),
  ];
  for (const entry of entries) upsertCognitiveBlackboardEntry(entry);
  return entries;
}

function toolPlanFor(
  input: BeginCognitiveKernelInput,
): CognitiveToolCallPlan[] {
  const plans: CognitiveToolCallPlan[] = [
    {
      toolId: 'local_skill_library',
      actionClass: 'local_lookup',
      purpose: 'Retrieve reusable safe task pattern before provider work.',
      approvalRequired: false,
    },
    {
      toolId: 'provider_health',
      actionClass: 'local_lookup',
      purpose: 'Fold live provider usability into route choice.',
      approvalRequired: false,
    },
  ];
  if (input.providerCouncil?.councilRunId) {
    plans.push({
      toolId: 'provider_council',
      actionClass: 'council',
      purpose: 'Use council verdict as planner/verifier input.',
      approvalRequired: false,
    });
  }
  if (input.taskFamily === 'calendar' || input.taskFamily === 'research') {
    plans.push({
      toolId:
        input.taskFamily === 'calendar'
          ? 'google_calendar_read'
          : 'brave_search',
      actionClass: 'read_only_integration',
      purpose:
        input.taskFamily === 'calendar'
          ? 'Read calendar metadata needed for the answer.'
          : 'Fill live/public evidence gaps only when local memory is insufficient.',
      approvalRequired: false,
    });
  }
  if (input.taskFamily === 'communication') {
    plans.push({
      toolId: 'bluebubbles_draft',
      actionClass: 'draft',
      purpose:
        'Draft or revise message help while preserving approval-first sends.',
      approvalRequired: input.selectedSkillApprovalNeed === 'explicit',
    });
  }
  if (input.taskFamily === 'operator') {
    plans.push({
      toolId: 'operator_diagnostics',
      actionClass: 'operator',
      purpose: 'Read operator status and stage any repair plan for approval.',
      approvalRequired: input.selectedSkillApprovalNeed === 'explicit',
    });
  }
  if (input.selectedSkillApprovalNeed === 'explicit') {
    plans.push({
      toolId: 'approval_stage',
      actionClass: 'approval_gate',
      purpose:
        'Stage mutating action or send as a draft until explicit approval.',
      approvalRequired: true,
    });
  }
  return plans;
}

function selectSkillCard(
  input: BeginCognitiveKernelInput,
): CognitiveSkillCardRecord | null {
  const candidates = safeDb([], () =>
    listCognitiveSkillCards({
      groupFolder: input.groupFolder,
      taskFamily: input.taskFamily,
      promotionStates: ['promoted', 'candidate'],
      limit: 20,
    }),
  );
  const normalizedGoal = input.goal.toLowerCase();
  return (
    candidates.find((skill) => {
      const haystack =
        `${skill.triggerSummary} ${skill.skillSummary}`.toLowerCase();
      return haystack
        .split(/\W+/)
        .filter((word) => word.length >= 5)
        .some((word) => normalizedGoal.includes(word));
    }) ||
    candidates.find((skill) => skill.skillId.includes(input.selectedSkillId)) ||
    null
  );
}

function buildTaskGraph(
  input: BeginCognitiveKernelInput,
  mode: CognitiveMode,
): CognitiveTaskGraph {
  const baseTools = toolPlanFor(input);
  const approvalNeed =
    mode === 'approval_staged' || input.selectedSkillApprovalNeed === 'explicit'
      ? 'explicit'
      : input.selectedSkillApprovalNeed;
  const subgoals: CognitiveSubgoal[] = [
    {
      subgoalId: `subgoal:${randomUUID()}`,
      title: 'Perceive request and retrieve local task memory',
      status: 'ready',
      requiredEvidence: 'sanitized_goal, skill_library, previous_outcomes',
      allowedActions: ['local_lookup'],
      approvalNeed: 'none',
      stopCondition: 'Goal is framed without raw private content.',
      toolPlan: baseTools.filter((plan) => plan.actionClass === 'local_lookup'),
      verification: { metadataOnly: true },
    },
    {
      subgoalId: `subgoal:${randomUUID()}`,
      title: 'Gather missing read-only evidence',
      status: mode === 'reactive_plan' ? 'verified' : 'ready',
      requiredEvidence:
        'provider_health, integration_status, evidence_contract',
      allowedActions:
        mode === 'approval_staged'
          ? ['local_lookup', 'read_only_integration', 'draft_only']
          : ['local_lookup', 'read_only_integration'],
      approvalNeed: 'none',
      stopCondition:
        'No required read-only evidence gap remains or blocker is explicit.',
      toolPlan: baseTools.filter(
        (plan) => plan.actionClass === 'read_only_integration',
      ),
      verification: { liveSearchOnlyForPublicGaps: true },
    },
    {
      subgoalId: `subgoal:${randomUUID()}`,
      title: 'Plan answer or safe staged action',
      status: 'pending',
      requiredEvidence:
        mode === 'council_verified'
          ? 'council_verdict, evidence_ids'
          : 'selected_skill_policy, evidence_contract',
      allowedActions: ['draft_only', 'council'],
      approvalNeed,
      stopCondition:
        approvalNeed === 'explicit'
          ? 'Draft is staged and waiting for explicit same-channel approval.'
          : 'Answer plan satisfies evidence contract and route policy.',
      toolPlan: baseTools.filter(
        (plan) =>
          plan.actionClass === 'council' ||
          plan.actionClass === 'draft' ||
          plan.actionClass === 'approval_gate' ||
          plan.actionClass === 'operator',
      ),
      verification: {
        councilRunId: input.providerCouncil?.councilRunId || null,
        approvalFirstCannotBeOverridden: true,
      },
    },
    {
      subgoalId: `subgoal:${randomUUID()}`,
      title: 'Verify completion and safety boundary',
      status: 'pending',
      requiredEvidence:
        'pre_send_evaluation, approval_policy, blocker_taxonomy',
      allowedActions: ['local_lookup'],
      approvalNeed,
      stopCondition:
        'Kernel can answer, ask one clarifier, explain a blocker, or stage approval.',
      toolPlan: [],
      verification: {
        noRawPrivateBodies: true,
        noHiddenReasoning: true,
        secretsRedacted: true,
      },
    },
    {
      subgoalId: `subgoal:${randomUUID()}`,
      title: 'Reflect and update reusable skill metadata',
      status: 'pending',
      requiredEvidence: 'outcome_signal, verification_result',
      allowedActions: ['metadata_learning'],
      approvalNeed: 'none',
      stopCondition:
        'Outcome metadata is saved, and durable skill stays candidate until verified.',
      toolPlan: [],
      verification: {
        retention: '90_days_runs_1000_limit_skills_until_changed',
      },
    },
  ];
  return {
    graphId: `graph:${randomUUID()}`,
    loop: [
      'perceive',
      'frame',
      'plan',
      'act_read',
      'verify',
      'answer_stage',
      'reflect_learn',
    ],
    subgoals,
  };
}

function buildVerification(
  input: BeginCognitiveKernelInput,
  usability: ReturnType<typeof providerUsability>,
  mode: CognitiveMode,
  toolPolicy?: ReturnType<typeof validateToolPlanAgainstRegistry>,
  budgetPolicy?: ReturnType<typeof validateAutonomyBudget>,
  simulations?: CognitiveToolSimulation[],
): CognitiveVerificationResult {
  const evidenceGaps: string[] = [];
  if (input.knownBlockers?.length) evidenceGaps.push('known_blockers_present');
  if (input.selectedSkillEvidenceLevel === 'weak')
    evidenceGaps.push('weak_skill_evidence');
  if (toolPolicy && !toolPolicy.pass) {
    evidenceGaps.push(
      ...toolPolicy.issues.map((issue) => `tool_policy:${issue}`),
    );
  }
  if (budgetPolicy && !budgetPolicy.pass) {
    evidenceGaps.push(
      ...budgetPolicy.issues.map((issue) => `autonomy_budget:${issue}`),
    );
  }
  if (simulations?.some((simulation) => simulation.status === 'block')) {
    evidenceGaps.push('tool_simulation_blocked');
  }
  const directives =
    input.providerCouncil?.structuredVerdict?.actionDirectives ||
    input.providerCouncil?.answerGuidance?.actionDirectives ||
    [];
  const verifierStop = directives.some(
    (directive) => directive.directive === 'verifier_stop',
  );
  if (verifierStop) evidenceGaps.push('council_verifier_stop');
  const approvalRequired =
    mode === 'approval_staged' ||
    input.providerCouncil?.approvalRequired === true;
  const status = verifierStop
    ? 'block'
    : evidenceGaps.some((gap) =>
          /tool_policy:approval_missing|tool_policy:forbidden|autonomy_budget:/.test(
            gap,
          ),
        )
      ? 'block'
      : evidenceGaps.includes('tool_simulation_blocked')
        ? 'block'
        : evidenceGaps.length > 0 || usability.blocked > 0
          ? 'warn'
          : 'pending';
  const nextAction = verifierStop
    ? 'Resolve the council verifier stop before acting.'
    : evidenceGaps.some((gap) => gap.startsWith('tool_policy:'))
      ? 'Fix the cognitive tool policy before acting; mutating or high-risk tools must remain approval-gated.'
      : evidenceGaps.some((gap) => gap.startsWith('autonomy_budget:'))
        ? 'Repair the autonomy budget before acting; bounded read-only and approval gates are mandatory.'
        : approvalRequired
          ? 'Stage a draft and wait for explicit approval before any mutating action.'
          : evidenceGaps.length
            ? 'Answer with the evidence gap named, or gather read-only evidence if available.'
            : 'Proceed with concise answer, then record outcome metadata.';
  return {
    status,
    criteria: [
      'evidence contract satisfied or blocker named',
      'approval-first boundary preserved',
      'provider participation reported honestly',
      'no raw private content or hidden reasoning persisted',
    ],
    evidenceGaps,
    approvalRequired,
    councilRunId: input.providerCouncil?.councilRunId || null,
    councilStatus:
      input.providerCouncil?.answerGuidance?.status ||
      input.providerCouncil?.status ||
      null,
    providerUsableCount: usability.healthy,
    providerDegradedCount: usability.degraded + usability.blocked,
    nextAction,
  };
}

function buildWorldBeliefs(
  input: BeginCognitiveKernelInput,
  usability: ReturnType<typeof providerUsability>,
  selectedSkill: CognitiveSkillCardRecord | null,
): CognitiveWorldBelief[] {
  const beliefs: CognitiveWorldBelief[] = [
    {
      beliefId: `belief:provider:${input.turnId}`,
      source: 'provider_health',
      summary: `${usability.healthy} providers healthy; ${usability.degraded + usability.blocked} degraded or blocked.`,
      confidence: usability.healthy > 0 ? 0.8 : 0.35,
      freshness: 'fresh',
    },
  ];
  if (selectedSkill) {
    beliefs.push({
      beliefId: `belief:skill:${selectedSkill.skillId}`,
      source: 'skill_library',
      summary: `Reusable skill ${selectedSkill.skillId} matched this ${input.taskFamily} task.`,
      confidence: clamp01(selectedSkill.latestOutcomeScore || 0.5),
      freshness: selectedSkill.lastUsedAt ? 'fresh' : 'unknown',
    });
  }
  if (input.providerCouncil?.councilRunId) {
    beliefs.push({
      beliefId: `belief:council:${input.providerCouncil.councilRunId}`,
      source: 'council_verdict',
      summary: `Council ${input.providerCouncil.mode || 'unknown'} returned ${input.providerCouncil.answerGuidance?.status || input.providerCouncil.status || 'unknown'} guidance.`,
      confidence: clamp01(
        input.providerCouncil.answerGuidance?.confidence ?? 0.5,
      ),
      freshness: 'fresh',
    });
  }
  return beliefs;
}

function buildRunRecord(input: {
  frame: CognitiveFrame;
  mode: CognitiveMode;
  autonomyLevel: CognitiveAutonomyLevel;
  taskGraph: CognitiveTaskGraph;
  evidenceContract: ReturnType<typeof buildEvidenceContract>;
  provider: ReturnType<typeof providerUsability>;
  verification: CognitiveVerificationResult;
  selectedSkill: CognitiveSkillCardRecord | null;
  now: string;
  groupFolder?: string | null;
  turnId: string;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
}): CognitiveRunRecord {
  return {
    runId: input.frame.runId,
    createdAt: input.now,
    updatedAt: input.now,
    groupFolder: input.groupFolder || null,
    channel: input.frame.channel,
    taskFamily: input.frame.taskFamily,
    turnId: input.turnId,
    goalSummary: input.frame.goal,
    selectedSkillId: input.frame.selectedSkillId,
    status:
      input.verification.status === 'block'
        ? 'blocked'
        : input.mode === 'approval_staged'
          ? 'awaiting_approval'
          : 'planned',
    autonomyLevel: input.autonomyLevel,
    cognitiveMode: input.mode,
    taskGraphJson: safeJson(input.taskGraph),
    evidenceContractJson: safeJson(input.evidenceContract),
    providerUsabilityJson: safeJson(input.provider),
    councilRunId: input.providerCouncil?.councilRunId || null,
    verificationJson: safeJson(input.verification),
    outcomeScore: 0,
    nextAction: redactCouncilText(input.verification.nextAction, 360),
    privacyJson: safeJson({
      metadataOnly: true,
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      hiddenReasoningStored: false,
      secretsRedacted: true,
    }),
    linkedSkillCardId: input.selectedSkill?.skillId || null,
  };
}

function subgoalRecords(
  runId: string,
  graph: CognitiveTaskGraph,
  createdAt: string,
): CognitiveSubgoalRecord[] {
  return graph.subgoals.map((subgoal, index) => ({
    subgoalId: subgoal.subgoalId,
    runId,
    position: index + 1,
    title: redactCouncilText(subgoal.title, 220),
    status: subgoal.status,
    requiredEvidence: redactCouncilText(subgoal.requiredEvidence, 420),
    allowedActionsJson: safeJson(subgoal.allowedActions, 1200),
    approvalNeed: redactCouncilText(subgoal.approvalNeed, 80),
    stopCondition: redactCouncilText(subgoal.stopCondition, 420),
    toolPlanJson: safeJson(subgoal.toolPlan, 2400),
    verificationJson: safeJson(subgoal.verification, 2400),
    createdAt,
    updatedAt: createdAt,
  }));
}

function checkpointPrivacy(): string {
  return privacyPolicyJson();
}

function persistCognitiveWorldBeliefs(input: {
  run: CognitiveRunRecord;
  worldBeliefs: CognitiveWorldBelief[];
  now: string;
}): void {
  for (const belief of input.worldBeliefs) {
    const record: CognitiveWorldBeliefRecord = {
      beliefId: belief.beliefId,
      createdAt: input.now,
      updatedAt: input.now,
      groupFolder: input.run.groupFolder || null,
      runId: input.run.runId,
      source: belief.source,
      subject: belief.source,
      summary: redactCouncilText(belief.summary, 520),
      confidence: clamp01(belief.confidence),
      freshness: belief.freshness,
      supersedesBeliefId: null,
      privacyJson: checkpointPrivacy(),
    };
    upsertCognitiveWorldBelief(record);
  }
}

function checkpointRecord(input: {
  run: CognitiveRunRecord;
  subgoalId?: string | null;
  checkpointKind: CognitiveCheckpointRecord['checkpointKind'];
  status?: CognitiveCheckpointRecord['status'];
  summary: string;
  state: unknown;
  nextAction: string;
  continuationKey?: string | null;
  expiresAt?: string | null;
  now: string;
}): CognitiveCheckpointRecord {
  return {
    checkpointId: `cogcheckpoint:${input.run.runId}:${input.checkpointKind}:${randomUUID()}`,
    createdAt: input.now,
    updatedAt: input.now,
    runId: input.run.runId,
    subgoalId: input.subgoalId || null,
    groupFolder: input.run.groupFolder || null,
    channel: input.run.channel || null,
    checkpointKind: input.checkpointKind,
    status: input.status || 'closed',
    summary: redactCouncilText(input.summary, 520),
    stateJson: safeJson(input.state, 3600),
    nextAction: redactCouncilText(input.nextAction, 420),
    continuationKey: input.continuationKey || null,
    expiresAt: input.expiresAt || null,
    resolvedAt: input.status === 'open' ? null : input.now,
    privacyJson: checkpointPrivacy(),
  };
}

function openCheckpointKindForRun(
  run: CognitiveRunRecord,
  verification: CognitiveVerificationResult,
): CognitiveCheckpointRecord['checkpointKind'] | null {
  if (run.status === 'awaiting_approval' || verification.approvalRequired) {
    return 'approval_wait';
  }
  if (run.status === 'blocked') return 'clarification_wait';
  if (verification.evidenceGaps.length > 0) return 'evidence_wait';
  return null;
}

function persistInitialCheckpoints(input: {
  run: CognitiveRunRecord;
  frame: CognitiveFrame;
  graph: CognitiveTaskGraph;
  evidenceContract: ReturnType<typeof buildEvidenceContract>;
  verification: CognitiveVerificationResult;
  toolPolicy: ReturnType<typeof validateToolPlanAgainstRegistry>;
  now: string;
}): void {
  const [frameSubgoal, evidenceSubgoal, planSubgoal, verifySubgoal] =
    input.graph.subgoals;
  const records = [
    checkpointRecord({
      run: input.run,
      subgoalId: frameSubgoal?.subgoalId,
      checkpointKind: 'frame',
      summary: 'Request framed into a sanitized cognitive run.',
      state: {
        goalSummary: input.frame.goal,
        taskFamily: input.frame.taskFamily,
        trigger: input.frame.trigger,
      },
      nextAction: 'Use the task graph to gather evidence or answer safely.',
      now: input.now,
    }),
    checkpointRecord({
      run: input.run,
      subgoalId: evidenceSubgoal?.subgoalId,
      checkpointKind: 'plan',
      summary: 'Task graph and local-first evidence order selected.',
      state: {
        graphId: input.graph.graphId,
        subgoalCount: input.graph.subgoals.length,
        evidenceContract: input.evidenceContract,
      },
      nextAction:
        'Gather read-only evidence only when the contract requires it.',
      now: input.now,
    }),
    checkpointRecord({
      run: input.run,
      subgoalId: planSubgoal?.subgoalId,
      checkpointKind: 'tool_policy',
      summary: input.toolPolicy.pass
        ? 'Tool plan validated against the cognitive registry.'
        : 'Tool plan failed validation and must be repaired before acting.',
      state: input.toolPolicy,
      nextAction: input.toolPolicy.pass
        ? 'Proceed within registered tool constraints.'
        : 'Repair the tool plan; high-risk tools require explicit approval.',
      now: input.now,
    }),
    checkpointRecord({
      run: input.run,
      subgoalId: verifySubgoal?.subgoalId,
      checkpointKind: 'verification',
      summary: 'Verification policy and next action recorded.',
      state: input.verification,
      nextAction: input.verification.nextAction,
      now: input.now,
    }),
  ];
  const openKind = openCheckpointKindForRun(input.run, input.verification);
  if (openKind) {
    records.push(
      checkpointRecord({
        run: input.run,
        subgoalId: planSubgoal?.subgoalId,
        checkpointKind: openKind,
        status: 'open',
        summary:
          openKind === 'approval_wait'
            ? 'Run is paused for explicit same-channel approval.'
            : openKind === 'evidence_wait'
              ? 'Run is paused until missing read-only evidence is gathered or named.'
              : 'Run is paused for clarification or blocker repair.',
        state: {
          status: input.run.status,
          evidenceGaps: input.verification.evidenceGaps,
          approvalRequired: input.verification.approvalRequired,
        },
        nextAction: input.verification.nextAction,
        continuationKey: `${input.run.taskFamily}:${input.run.selectedSkillId}`,
        expiresAt:
          openKind === 'approval_wait'
            ? new Date(Date.parse(input.now) + 2 * 60 * 60 * 1000).toISOString()
            : null,
        now: input.now,
      }),
    );
  }
  for (const record of records) upsertCognitiveCheckpoint(record);
}

export function beginCognitiveKernelRun(
  input: BeginCognitiveKernelInput,
): CognitiveKernelResult {
  const startedAt = nowIso();
  const registry = ensureCognitiveToolRegistry(startedAt);
  const providerSnapshots =
    input.providerHealthSnapshots || collectProviderHealthSnapshots(startedAt);
  const framePolicy = selectCognitiveMode(input);
  const selectedSkill = selectSkillCard(input);
  const frame: CognitiveFrame = {
    runId: `cog:${input.turnId || randomUUID()}`,
    goal: summarizeGoal(input.goal, input.taskFamily, input.channel),
    taskFamily: input.taskFamily,
    channel: input.channel,
    requestRoute: input.requestRoute || null,
    trigger: framePolicy.trigger,
    selectedSkillId: input.selectedSkillId,
    selectedSkillPurpose: redactCouncilText(input.selectedSkillPurpose, 320),
    selectedSkillApprovalNeed: input.selectedSkillApprovalNeed,
    selectedSkillSideEffectRisk: input.selectedSkillSideEffectRisk,
    selectedSkillEvidenceLevel: input.selectedSkillEvidenceLevel,
  };
  const evidenceContract = buildEvidenceContract(input);
  const graph = buildTaskGraph(input, framePolicy.cognitiveMode);
  graph.selectedSkillId = selectedSkill?.skillId || null;
  const toolPolicy = validateToolPlanAgainstRegistry(
    graph.subgoals.flatMap((subgoal) => subgoal.toolPlan),
    registry,
  );
  const autonomyBudget = buildAutonomyBudget({
    mode: framePolicy.cognitiveMode,
    taskFamily: input.taskFamily,
    approvalRequired:
      framePolicy.cognitiveMode === 'approval_staged' ||
      input.selectedSkillApprovalNeed === 'explicit',
    now: startedAt,
  });
  const budgetPolicy = validateAutonomyBudget({
    budget: autonomyBudget,
    plans: graph.subgoals.flatMap((subgoal) => subgoal.toolPlan),
  });
  const toolPlans = graph.subgoals.flatMap((subgoal) => subgoal.toolPlan);
  const toolSimulations = simulateToolPlan({
    runId: frame.runId,
    plans: toolPlans,
    registry,
    autonomyBudget,
    budgetPolicy,
    now: startedAt,
  });
  const providers = providerUsability(providerSnapshots);
  const verification = buildVerification(
    input,
    providers,
    framePolicy.cognitiveMode,
    toolPolicy,
    budgetPolicy,
    toolSimulations,
  );
  const run = buildRunRecord({
    frame,
    mode: framePolicy.cognitiveMode,
    autonomyLevel: framePolicy.autonomyLevel,
    taskGraph: graph,
    evidenceContract,
    provider: providers,
    verification,
    selectedSkill,
    now: startedAt,
    groupFolder: input.groupFolder,
    turnId: input.turnId,
    providerCouncil: input.providerCouncil,
  });
  const worldBeliefs = buildWorldBeliefs(input, providers, selectedSkill);
  const providerCooldowns = persistProviderCooldowns({
    snapshots: providerSnapshots,
    runId: run.runId,
    now: startedAt,
  });
  const rewardPreview: CognitiveRewardSignal = {
    kind:
      run.status === 'awaiting_approval'
        ? 'approval_required'
        : run.status === 'blocked'
          ? 'task_blocked'
          : 'task_answered',
    score: 0,
    summary: redactCouncilText(
      `Cognitive run planned ${input.taskFamily} task with ${framePolicy.cognitiveMode}.`,
      360,
    ),
    flags: verification.evidenceGaps,
  };
  safeDb(undefined, () => {
    upsertCognitiveRun(run);
    persistProviderCooldowns({
      snapshots: providerSnapshots,
      runId: run.runId,
      now: startedAt,
    });
    for (const simulation of toolSimulations) {
      upsertCognitiveToolSimulation(simulation);
    }
    replaceCognitiveSubgoalsForRun(
      run.runId,
      subgoalRecords(run.runId, graph, startedAt),
    );
    persistCognitiveWorldBeliefs({
      run,
      worldBeliefs,
      now: startedAt,
    });
    persistInitialCheckpoints({
      run,
      frame,
      graph,
      evidenceContract,
      verification,
      toolPolicy,
      now: startedAt,
    });
    const checkpoints = listCognitiveCheckpoints({
      runId: run.runId,
      limit: 20,
    });
    const activeCheckpoint = checkpoints.find(
      (checkpoint) => checkpoint.status === 'open',
    );
    upsertCognitiveAutonomyBudget(autonomyBudget);
    const activeGoal = upsertGoalForRun({
      run,
      graph,
      verification,
      activeCheckpointId: activeCheckpoint?.checkpointId || null,
      now: startedAt,
    });
    persistInitialBlackboard({
      run,
      goal: activeGoal,
      verification,
      toolPolicy,
      budgetPolicy,
      checkpoints,
      now: startedAt,
    });
    persistTraceSpans([
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'run',
        status: run.status === 'blocked' ? 'blocked' : 'completed',
        summary: `Cognitive run initialized in ${run.cognitiveMode}.`,
        inputSummary: frame.goal,
        outputSummary: run.nextAction,
        metadata: {
          taskFamily: run.taskFamily,
          autonomyLevel: run.autonomyLevel,
          selectedSkillId: run.selectedSkillId,
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'frame',
        status: 'completed',
        summary: 'Request framed without raw private content.',
        inputSummary: describeTextShape(input.goal),
        outputSummary: frame.trigger,
        metadata: {
          requestRoute: frame.requestRoute || '',
          selectedSkillEvidenceLevel: frame.selectedSkillEvidenceLevel,
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'provider_health',
        status: providerCooldowns.length > 0 ? 'warn' : 'completed',
        summary: `${providers.healthy} provider(s) healthy; ${providers.blocked} blocked.`,
        inputSummary: 'provider snapshots',
        outputSummary: providerCooldowns
          .map((cooldown) => cooldown.providerId)
          .join(', '),
        metadata: {
          blockedProviderIds: providers.degradedProviderIds,
          activeCooldowns: providerCooldowns.map(
            (cooldown) => cooldown.providerId,
          ),
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'tool_simulation',
        status: toolSimulations.some(
          (simulation) => simulation.status === 'block',
        )
          ? 'blocked'
          : toolSimulations.some((simulation) => simulation.status === 'warn')
            ? 'warn'
            : 'completed',
        summary: `Simulated ${toolSimulations.length} tool plan step(s).`,
        inputSummary: toolPlans.map((plan) => plan.toolId).join(', '),
        outputSummary: simulationAggregate(toolSimulations).status,
        metadata: simulationAggregate(toolSimulations),
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'guardrail',
        status: toolPolicy.pass && budgetPolicy.pass ? 'completed' : 'blocked',
        summary: 'Tool and autonomy guardrails evaluated before action.',
        inputSummary: 'tool_policy + autonomy_budget',
        outputSummary: verification.nextAction,
        metadata: {
          toolPolicyPass: toolPolicy.pass,
          budgetPolicyPass: budgetPolicy.pass,
          toolIssues: toolPolicy.issues,
          budgetIssues: budgetPolicy.issues,
        },
        now: startedAt,
      }),
      ...(input.providerCouncil?.councilRunId
        ? [
            traceSpan({
              runId: run.runId,
              goalId: activeGoal.goalId,
              spanKind: 'council',
              status:
                input.providerCouncil.answerGuidance?.status === 'block'
                  ? 'blocked'
                  : input.providerCouncil.answerGuidance?.status === 'warn'
                    ? 'warn'
                    : 'completed',
              summary: `Council guidance linked: ${input.providerCouncil.councilRunId}.`,
              inputSummary: input.providerCouncil.mode || '',
              outputSummary:
                input.providerCouncil.answerGuidance?.visibleVerdict ||
                input.providerCouncil.status ||
                '',
              metadata: {
                councilRunId: input.providerCouncil.councilRunId,
                status: input.providerCouncil.answerGuidance?.status || '',
                providerParticipation:
                  input.providerCouncil.structuredVerdict
                    ?.providerParticipation || null,
              },
              now: startedAt,
            }),
          ]
        : []),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'checkpoint',
        status: activeCheckpoint ? 'warn' : 'completed',
        summary: `${checkpoints.length} checkpoint(s) persisted for resume/replay.`,
        inputSummary: checkpoints
          .map((checkpoint) => checkpoint.checkpointKind)
          .join(', '),
        outputSummary: activeCheckpoint?.nextAction || 'no open checkpoint',
        metadata: {
          openCheckpointId: activeCheckpoint?.checkpointId || '',
          openCheckpointKind: activeCheckpoint?.checkpointKind || '',
        },
        now: startedAt,
      }),
    ]);
    pruneOldCognitiveData(startedAt);
    if (selectedSkill) {
      upsertCognitiveSkillCard({
        ...selectedSkill,
        usageCount: selectedSkill.usageCount + 1,
        lastUsedAt: startedAt,
        updatedAt: startedAt,
      });
    }
    return undefined;
  });
  return {
    run,
    frame,
    taskGraph: graph,
    verification,
    selectedSkill: selectedSkill
      ? {
          skillId: selectedSkill.skillId,
          taskFamily: selectedSkill.taskFamily,
          triggerSummary: selectedSkill.triggerSummary,
          skillSummary: selectedSkill.skillSummary,
          promotionState: selectedSkill.promotionState,
          latestOutcomeScore: selectedSkill.latestOutcomeScore,
        }
      : null,
    worldBeliefs,
    activeGoal: safeDb<CognitiveGoalRecord | null>(
      null,
      () => getCognitiveGoal(goalIdFor(run)) || null,
    ),
    blackboardSnapshot: safeDb([], () =>
      listCognitiveBlackboardEntries({ runId: run.runId, limit: 10 }),
    ),
    autonomyBudget,
    toolSimulations,
    traceSpans: safeDb(
      [],
      () =>
        buildCognitiveReplayPacket({
          runId: run.runId,
          generatedAt: startedAt,
        }).spans,
    ),
    providerCooldowns,
    rewardPreview,
  };
}

function outcomeScore(input: FinalizeCognitiveKernelOutcomeInput): number {
  if (input.evaluationStatus === 'block' || input.answerClass === 'blocked') {
    return 0.2;
  }
  if (input.blockerClass) return 0.35;
  if (input.answerClass === 'degraded' || input.evaluationStatus === 'warn') {
    return 0.58;
  }
  if (input.fallbackUsed) return 0.62;
  if (input.answerClass === 'handled' && input.evidenceGap === 'none') {
    return 0.88;
  }
  return 0.72;
}

function finalStatus(
  input: FinalizeCognitiveKernelOutcomeInput,
): CognitiveRunStatus {
  if (input.evaluationStatus === 'block' || input.answerClass === 'blocked') {
    return 'blocked';
  }
  if (
    input.evaluatorFlags.some((flag) => /approval|send|mutating/i.test(flag)) ||
    input.cognitiveRun?.run.cognitiveMode === 'approval_staged'
  ) {
    return 'awaiting_approval';
  }
  return 'answered';
}

function signalKind(
  input: FinalizeCognitiveKernelOutcomeInput,
): CognitiveRewardSignalRecord['signalKind'] {
  const status = finalStatus(input);
  if (status === 'blocked') return 'task_blocked';
  if (status === 'awaiting_approval') return 'approval_required';
  return 'task_answered';
}

function reflectionKind(
  input: FinalizeCognitiveKernelOutcomeInput,
): CognitiveReflectionRecord['reflectionKind'] {
  if (input.blockerClass || input.answerClass === 'blocked') return 'failure';
  if (input.evaluationStatus === 'block') return 'verifier_block';
  if (
    input.evaluatorFlags.some((flag) => /approval|send|mutating/i.test(flag)) ||
    input.cognitiveRun?.run.cognitiveMode === 'approval_staged'
  ) {
    return 'approval_blocked';
  }
  if (input.evaluatorFlags.some((flag) => /provider/i.test(flag))) {
    return 'provider_degraded';
  }
  return 'success';
}

function skillStateAfterOutcome(input: {
  existing?: CognitiveSkillCardRecord | null;
  score: number;
  blocked: boolean;
}): CognitiveSkillCardRecord['promotionState'] {
  if (input.blocked) return 'quarantined';
  if (input.existing?.promotionState === 'promoted' && input.score >= 0.55) {
    return 'promoted';
  }
  if (input.existing?.promotionState === 'candidate' && input.score >= 0.82) {
    return 'promoted';
  }
  if (input.score >= 0.7) return 'candidate';
  return input.existing?.promotionState || 'candidate';
}

function upsertSkillFromOutcome(input: {
  run: CognitiveRunRecord;
  score: number;
  status: CognitiveRunStatus;
  routeUsed: string;
  flags: string[];
  now: string;
}): CognitiveSkillCardRecord {
  const skillId =
    `cogskill:${input.run.taskFamily}:${input.run.selectedSkillId}`.replace(
      /[^a-zA-Z0-9:_.-]/g,
      '_',
    );
  const existing = safeDb<CognitiveSkillCardRecord | null>(
    null,
    () =>
      listCognitiveSkillCards({
        groupFolder: input.run.groupFolder,
        taskFamily: input.run.taskFamily,
        limit: 100,
      }).find((skill) => skill.skillId === skillId) || null,
  );
  const state = skillStateAfterOutcome({
    existing,
    score: input.score,
    blocked: input.status === 'blocked',
  });
  const record: CognitiveSkillCardRecord = {
    skillId,
    createdAt: existing?.createdAt || input.now,
    updatedAt: input.now,
    groupFolder: input.run.groupFolder || null,
    taskFamily: input.run.taskFamily,
    triggerSummary: redactCouncilText(input.run.goalSummary, 320),
    skillSummary: redactCouncilText(
      `Use ${input.run.selectedSkillId} for ${input.run.taskFamily} tasks through ${input.routeUsed}; verify evidence and approval boundaries before acting.`,
      520,
    ),
    requiredToolsJson: safeJson(
      parseJsonSafe<{ subgoals?: CognitiveSubgoal[] }>(
        input.run.taskGraphJson,
        {},
      ).subgoals?.flatMap((subgoal) =>
        (subgoal.toolPlan || []).map((plan) => plan.toolId),
      ) || ['local_skill_library', 'provider_health'],
      1800,
    ),
    evidenceNeedsJson: input.run.evidenceContractJson,
    approvalRulesJson: safeJson({
      approvalFirst:
        input.run.cognitiveMode === 'approval_staged' ||
        /approval_required/.test(input.run.status),
      mutatingActions: 'draft_or_stage_until_explicit_approval',
    }),
    failureModesJson: safeJson(
      Array.from(
        new Set(
          [
            ...input.flags.filter((flag) => flag !== 'none'),
            input.status === 'blocked' ? 'blocked_outcome' : '',
          ].filter(Boolean),
        ),
      ),
    ),
    verificationChecklistJson: input.run.verificationJson,
    latestOutcomeScore: input.score,
    promotionState: state,
    usageCount: (existing?.usageCount || 0) + 1,
    lastUsedAt: input.now,
  };
  safeDb(undefined, () => upsertCognitiveSkillCard(record));
  return record;
}

function persistFinalCheckpoint(input: {
  updated: CognitiveRunRecord;
  input: FinalizeCognitiveKernelOutcomeInput;
  score: number;
  now: string;
}): void {
  const open = findOpenCognitiveCheckpoint({
    groupFolder: input.updated.groupFolder || null,
    channel: input.updated.channel || null,
    continuationKey: `${input.updated.taskFamily}:${input.updated.selectedSkillId}`,
  });
  if (
    open?.runId === input.updated.runId &&
    input.updated.status !== 'awaiting_approval'
  ) {
    resolveCognitiveCheckpoint(open.checkpointId, {
      status: input.updated.status === 'blocked' ? 'blocked' : 'closed',
      resolvedAt: input.now,
      nextAction: input.updated.nextAction,
    });
  }
  upsertCognitiveCheckpoint(
    checkpointRecord({
      run: input.updated,
      checkpointKind: 'outcome',
      summary: `Outcome recorded as ${input.updated.status} with ${input.input.answerClass}.`,
      state: {
        status: input.updated.status,
        score: input.score,
        answerClass: input.input.answerClass,
        evidenceGap: input.input.evidenceGap,
        routeUsed: input.input.routeUsed,
        flags: input.input.evaluatorFlags,
      },
      nextAction: input.updated.nextAction,
      now: input.now,
    }),
  );
}

function persistGoalOutcome(input: {
  updated: CognitiveRunRecord;
  outcome: FinalizeCognitiveKernelOutcomeInput;
  score: number;
  now: string;
}): void {
  const graph = parseJsonSafe<CognitiveTaskGraph>(input.updated.taskGraphJson, {
    graphId: 'unknown',
    loop: [],
    subgoals: [],
  });
  const verification = parseJsonSafe<CognitiveVerificationResult>(
    input.updated.verificationJson,
    {
      status: input.outcome.evaluationStatus,
      criteria: [],
      evidenceGaps: [],
      approvalRequired: input.updated.status === 'awaiting_approval',
      providerUsableCount: 0,
      providerDegradedCount: 0,
      nextAction: input.updated.nextAction,
    },
  );
  const open = findOpenCognitiveCheckpoint({
    groupFolder: input.updated.groupFolder || null,
    channel: input.updated.channel || null,
    continuationKey: `${input.updated.taskFamily}:${input.updated.selectedSkillId}`,
  });
  const goal = upsertGoalForRun({
    run: input.updated,
    graph,
    verification,
    activeCheckpointId:
      open?.runId === input.updated.runId ? open.checkpointId : null,
    now: input.now,
  });
  const outcomeEntry = blackboardEntry({
    goalId: goal.goalId,
    runId: input.updated.runId,
    groupFolder: input.updated.groupFolder || null,
    entryKind:
      input.updated.status === 'blocked' || input.outcome.blockerClass
        ? 'repair'
        : 'outcome',
    source: 'kernel',
    status: input.updated.status === 'blocked' ? 'blocked' : 'active',
    summary: `Outcome ${input.updated.status}; class=${input.outcome.answerClass}; score=${input.score.toFixed(2)}.`,
    evidenceRefs: [
      input.updated.runId,
      input.updated.linkedSkillCardId || '',
      open?.checkpointId || '',
    ].filter(Boolean),
    confidence: input.score,
    now: input.now,
  });
  upsertCognitiveBlackboardEntry(outcomeEntry);
}

export function finalizeCognitiveKernelOutcome(
  input: FinalizeCognitiveKernelOutcomeInput,
): void {
  const kernel = input.cognitiveRun;
  if (!kernel?.run.runId) return;
  const stored = safeDb<CognitiveRunRecord | undefined>(undefined, () =>
    getCognitiveRun(kernel.run.runId),
  );
  const baseRun = stored || kernel.run;
  const endedAt = nowIso();
  const score = outcomeScore(input);
  const status = finalStatus(input);
  const nextAction =
    status === 'blocked'
      ? 'Name the blocker and collect the missing read-only evidence or user clarification.'
      : status === 'awaiting_approval'
        ? 'Wait for explicit same-channel approval before any mutating action.'
        : 'Use this outcome to reinforce the reusable skill candidate.';
  const updated: CognitiveRunRecord = {
    ...baseRun,
    updatedAt: endedAt,
    status,
    outcomeScore: score,
    nextAction,
  };
  const flags = input.evaluatorFlags.map((flag) =>
    redactCouncilText(flag, 120),
  );
  const skill = upsertSkillFromOutcome({
    run: updated,
    score,
    status,
    routeUsed: input.routeUsed,
    flags,
    now: endedAt,
  });
  updated.linkedSkillCardId = skill.skillId;
  safeDb(undefined, () => {
    upsertCognitiveRun(updated);
    persistFinalCheckpoint({
      updated,
      input,
      score,
      now: endedAt,
    });
    persistGoalOutcome({
      updated,
      outcome: input,
      score,
      now: endedAt,
    });
    persistTraceSpans([
      traceSpan({
        runId: updated.runId,
        goalId: goalIdFor(updated),
        spanKind: 'outcome',
        status:
          status === 'blocked'
            ? 'blocked'
            : status === 'awaiting_approval'
              ? 'warn'
              : 'completed',
        summary: `Cognitive run finalized as ${status}.`,
        inputSummary: input.routeUsed,
        outputSummary: nextAction,
        metadata: {
          score,
          answerClass: input.answerClass,
          evidenceGap: input.evidenceGap,
          blockerClass: input.blockerClass || '',
          evaluatorFlags: flags,
          linkedSkillCardId: skill.skillId,
        },
        now: endedAt,
      }),
    ]);
    insertCognitiveRewardSignal({
      signalId: `cogreward:${updated.runId}:${endedAt}`,
      createdAt: endedAt,
      runId: updated.runId,
      skillId: skill.skillId,
      signalKind: signalKind(input),
      score,
      summary: redactCouncilText(
        `Cognitive run ${updated.runId} ended as ${status}; answer=${input.answerClass}; route=${input.routeUsed}; gap=${input.evidenceGap}.`,
        520,
      ),
      flagsJson: safeJson(flags, 2400),
    });
    insertCognitiveReflection({
      reflectionId: `cogreflection:${updated.runId}:${endedAt}`,
      createdAt: endedAt,
      groupFolder: updated.groupFolder || null,
      runId: updated.runId,
      skillId: skill.skillId,
      taskFamily: updated.taskFamily,
      reflectionKind: reflectionKind(input),
      summary: redactCouncilText(
        `${updated.taskFamily} route ${input.routeUsed} produced ${input.answerClass} with ${input.evaluationStatus} verification; raw content omitted.`,
        520,
      ),
      routeKey: redactCouncilText(input.routeUsed, 160),
      providerStateJson: updated.providerUsabilityJson,
      nextRule: redactCouncilText(nextAction, 420),
      confidence: score,
      privacyJson: updated.privacyJson,
    });
    return undefined;
  });
  kernel.run = updated;
}

function pruneOldCognitiveData(referenceIso: string): void {
  const cutoffMs =
    new Date(referenceIso).getTime() -
    COGNITIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  pruneCognitiveKernelData({
    cutoffIso,
    retainLimit: COGNITIVE_RETAIN_LIMIT,
  });
}

function privacyReport(): CognitiveDoctorReport['privacy'] {
  return {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  };
}

export function buildCognitiveResumePlan(
  params: {
    groupFolder?: string | null;
    channel?: CognitiveChannel | string | null;
    continuationKey?: string | null;
  } = {},
): CognitiveResumePlan {
  const checkpoint = safeDb<CognitiveCheckpointRecord | undefined>(
    undefined,
    () =>
      findOpenCognitiveCheckpoint({
        groupFolder: params.groupFolder || null,
        channel: params.channel || null,
        continuationKey: params.continuationKey || null,
      }),
  );
  if (!checkpoint) {
    return {
      found: false,
      checkpoint: null,
      run: null,
      goal: null,
      blackboardEntries: [],
      subgoalCount: 0,
      nextAction: 'No open cognitive checkpoint is waiting in this scope.',
      privacy: privacyReport(),
    };
  }
  const run = safeDb<CognitiveRunRecord | undefined>(undefined, () =>
    getCognitiveRun(checkpoint.runId),
  );
  const subgoals = run
    ? safeDb([], () => listCognitiveSubgoalsForRun(run.runId))
    : [];
  const goals = run
    ? safeDb([], () =>
        listCognitiveGoals({
          groupFolder: run.groupFolder || null,
          taskFamily: run.taskFamily,
          limit: 20,
        }),
      )
    : [];
  const goal =
    goals.find((candidate) =>
      parseJsonSafe<string[]>(candidate.linkedRunIdsJson, []).includes(
        run?.runId || '',
      ),
    ) ||
    goals.find((candidate) => candidate.rootRunId === run?.runId) ||
    null;
  const blackboardEntries = run
    ? safeDb([], () =>
        listCognitiveBlackboardEntries({ runId: run.runId, limit: 8 }),
      )
    : [];
  return {
    found: Boolean(run),
    checkpoint,
    run: run || null,
    goal,
    blackboardEntries,
    subgoalCount: subgoals.length,
    nextAction: checkpoint.nextAction,
    privacy: privacyReport(),
  };
}

function benchmarkScenarios(): Array<{
  taskId: string;
  taskFamily: PlatformTaskFamily;
  goal: string;
  selectedSkillId: string;
  selectedSkillPurpose: string;
  selectedSkillApprovalNeed: string;
  selectedSkillSideEffectRisk: string;
  selectedSkillEvidenceLevel: string;
  expectedMode: CognitiveMode;
  expectedApproval: boolean;
}> {
  return [
    {
      taskId: 'quick-guidance',
      taskFamily: 'assistant',
      goal: 'give me a grounded next step for today',
      selectedSkillId: 'assistant.daily_guidance',
      selectedSkillPurpose: 'Offer concise guidance from local context.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'partial',
      expectedMode: 'reactive_plan',
      expectedApproval: false,
    },
    {
      taskId: 'read-only-research',
      taskFamily: 'research',
      goal: 'research this only if local memory is insufficient',
      selectedSkillId: 'research.live_or_saved',
      selectedSkillPurpose:
        'Use local evidence first, then public search for gaps.',
      selectedSkillApprovalNeed: 'none',
      selectedSkillSideEffectRisk: 'none',
      selectedSkillEvidenceLevel: 'strong',
      expectedMode: 'read_only_react',
      expectedApproval: false,
    },
    {
      taskId: 'approval-draft',
      taskFamily: 'communication',
      goal: 'Communication task from bluebubbles; raw message body stays local. Shape: words=5; question=false; action=true.',
      selectedSkillId: 'communication.reply_help',
      selectedSkillPurpose: 'Draft a safe reply without sending.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
      expectedMode: 'approval_staged',
      expectedApproval: true,
    },
    {
      taskId: 'ultrathink-operator',
      taskFamily: 'operator',
      goal: 'ultrathink a read-only operator repair plan without mutating state',
      selectedSkillId: 'operator.diagnostics',
      selectedSkillPurpose: 'Diagnose and stage repairs for approval.',
      selectedSkillApprovalNeed: 'explicit',
      selectedSkillSideEffectRisk: 'high',
      selectedSkillEvidenceLevel: 'partial',
      expectedMode: 'approval_staged',
      expectedApproval: true,
    },
  ];
}

function hasPrivacyLeak(value: unknown): boolean {
  return /sk-|Bearer\s+|AIza|BEGIN PRIVATE KEY|raw private body|raw message body text|chain-of-thought|provider debate transcript/i.test(
    JSON.stringify(value),
  );
}

export function runCognitiveBenchmarkSuite(
  params: {
    persist?: boolean;
    generatedAt?: string;
  } = {},
): CognitiveBenchmarkReport {
  const generatedAt = params.generatedAt || nowIso();
  const attempts: CognitiveBenchmarkAttemptRecord[] = [];
  for (const scenario of benchmarkScenarios()) {
    const kernel = beginCognitiveKernelRun({
      turnId: `cog-bench-${scenario.taskId}-${Date.parse(generatedAt) || Date.now()}`,
      channel: 'system',
      groupFolder: 'main',
      taskFamily: scenario.taskFamily,
      goal: scenario.goal,
      requestRoute: 'cognition.benchmark',
      selectedSkillId: scenario.selectedSkillId,
      selectedSkillPurpose: scenario.selectedSkillPurpose,
      selectedSkillApprovalNeed: scenario.selectedSkillApprovalNeed,
      selectedSkillSideEffectRisk: scenario.selectedSkillSideEffectRisk,
      selectedSkillEvidenceLevel: scenario.selectedSkillEvidenceLevel,
      knownBlockers: [],
      thinkingPreference: scenario.taskId.includes('ultrathink')
        ? 'deep'
        : null,
      thinkingTrigger: scenario.taskId.includes('ultrathink')
        ? 'ultrathink'
        : null,
    });
    finalizeCognitiveKernelOutcome({
      cognitiveRun: kernel,
      evaluationStatus: 'pass',
      evidenceGap: 'none',
      evaluatorFlags: scenario.expectedApproval
        ? ['approval_required']
        : ['none'],
      routeUsed: scenario.selectedSkillId,
      answerClass: 'handled',
    });
    const checkpoints = safeDb([], () =>
      listCognitiveCheckpoints({ runId: kernel.run.runId, limit: 20 }),
    );
    const rewards = safeDb([], () =>
      listCognitiveRewardSignals({ runId: kernel.run.runId, limit: 10 }),
    );
    const goals = safeDb([], () =>
      listCognitiveGoals({
        groupFolder: kernel.run.groupFolder || null,
        taskFamily: kernel.run.taskFamily,
        limit: 20,
      }),
    ).filter((goal) =>
      parseJsonSafe<string[]>(goal.linkedRunIdsJson, []).includes(
        kernel.run.runId,
      ),
    );
    const blackboardEntries = safeDb([], () =>
      listCognitiveBlackboardEntries({ runId: kernel.run.runId, limit: 20 }),
    );
    const budgets = safeDb([], () =>
      listCognitiveAutonomyBudgets({
        cognitiveMode: kernel.run.cognitiveMode,
        taskFamily: kernel.run.taskFamily,
        limit: 10,
      }),
    );
    const toolPolicyCheckpoint = checkpoints.find(
      (checkpoint) => checkpoint.checkpointKind === 'tool_policy',
    );
    const toolPolicy = parseJsonSafe<{ pass?: boolean; issues?: string[] }>(
      toolPolicyCheckpoint?.stateJson,
      {},
    );
    const approvalGatePass = scenario.expectedApproval
      ? checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointKind === 'approval_wait' &&
            checkpoint.status === 'open',
        )
      : !checkpoints.some(
          (checkpoint) => checkpoint.checkpointKind === 'approval_wait',
        );
    const modePass = kernel.run.cognitiveMode === scenario.expectedMode;
    const checkpointPass = checkpoints.length >= 4;
    const toolPolicyPass = toolPolicy.pass === true;
    const goalPass =
      goals.length > 0 &&
      goals.every((goal) =>
        scenario.expectedApproval
          ? goal.status === 'waiting_approval'
          : ['active', 'satisfied'].includes(goal.status),
      );
    const blackboardPass = blackboardEntries.length >= 3;
    const budgetPass =
      budgets.length > 0 &&
      budgets.every(
        (budget) =>
          budget.mutatingAllowed === false &&
          (scenario.expectedApproval ? budget.approvalRequired : true),
      );
    const outcomeCaptured = rewards.length > 0;
    const privacyPass = !hasPrivacyLeak({
      kernel,
      checkpoints,
      rewards,
      goals,
      blackboardEntries,
      budgets,
    });
    const scoreParts = [
      modePass,
      checkpointPass,
      toolPolicyPass,
      approvalGatePass,
      goalPass,
      blackboardPass,
      budgetPass,
      privacyPass,
      outcomeCaptured,
    ];
    const score = scoreParts.filter(Boolean).length / scoreParts.length;
    const status: CognitiveBenchmarkAttemptRecord['status'] =
      score >= 0.98 ? 'pass' : score >= 0.75 ? 'warn' : 'fail';
    const nextAction =
      status === 'pass'
        ? 'Keep this drill in the recurring cognition benchmark ladder.'
        : !toolPolicyPass
          ? 'Repair cognitive tool registry or tool plan validation.'
          : !approvalGatePass
            ? 'Repair approval checkpoint creation for approval-staged tasks.'
            : !checkpointPass
              ? 'Repair cognitive checkpoint persistence.'
              : !goalPass
                ? 'Repair cognitive goal lifecycle persistence and status transitions.'
                : !blackboardPass
                  ? 'Repair cognitive blackboard timeline persistence.'
                  : !budgetPass
                    ? 'Repair autonomy budget persistence or enforcement.'
                    : !privacyPass
                      ? 'Repair redaction before running live tasks.'
                      : 'Repair outcome signal capture for benchmarked tasks.';
    const attempt: CognitiveBenchmarkAttemptRecord = {
      attemptId: `cogbench:${scenario.taskId}:${generatedAt}`,
      createdAt: generatedAt,
      taskId: scenario.taskId,
      taskFamily: scenario.taskFamily,
      status,
      score: Number(score.toFixed(3)),
      runId: kernel.run.runId,
      checkpointCount: checkpoints.length,
      toolPolicyPass,
      approvalGatePass,
      privacyPass,
      outcomeCaptured,
      nextAction,
      detailJson: safeJson({
        mode: kernel.run.cognitiveMode,
        expectedMode: scenario.expectedMode,
        checkpointPass,
        goalPass,
        blackboardPass,
        budgetPass,
        toolPolicyIssues: toolPolicy.issues || [],
        modePass,
      }),
    };
    if (params.persist !== false) {
      safeDb(undefined, () => {
        insertCognitiveBenchmarkAttempt(attempt);
        return undefined;
      });
    }
    attempts.push(attempt);
  }
  const average =
    attempts.reduce((sum, attempt) => sum + attempt.score, 0) /
    Math.max(1, attempts.length);
  const status: CognitiveBenchmarkReport['status'] = attempts.some(
    (attempt) => attempt.status === 'fail',
  )
    ? 'fail'
    : attempts.some((attempt) => attempt.status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    generatedAt,
    status,
    score: Number(average.toFixed(3)),
    attempts,
    nextAction:
      status === 'pass'
        ? 'Cognitive benchmark ladder is passing; keep live proof turns fresh.'
        : attempts.find((attempt) => attempt.status !== 'pass')?.nextAction ||
          'Inspect cognition benchmark failures.',
    privacy: privacyReport(),
  };
}

function summarizeRecentRuns(
  runs: CognitiveRunRecord[],
): CognitiveDoctorReport['recent'] {
  const total = runs.length;
  const average =
    total > 0
      ? runs.reduce((sum, run) => sum + (run.outcomeScore || 0), 0) / total
      : 0;
  const rewardSignals = safeDb([], () =>
    listCognitiveRewardSignals({ limit: 200 }),
  ).length;
  const reflections = safeDb([], () =>
    listCognitiveReflections({ limit: 200 }),
  ).length;
  return {
    totalRuns: total,
    blockedRuns: runs.filter((run) => run.status === 'blocked').length,
    approvalRuns: runs.filter((run) => run.status === 'awaiting_approval')
      .length,
    averageOutcomeScore: Number(average.toFixed(3)),
    rewardSignals,
    reflections,
  };
}

function summarizeSkillLibrary(
  cards: CognitiveSkillCardRecord[],
): CognitiveDoctorReport['skills'] {
  return {
    total: cards.length,
    promoted: cards.filter((card) => card.promotionState === 'promoted').length,
    candidates: cards.filter((card) => card.promotionState === 'candidate')
      .length,
    quarantined: cards.filter((card) => card.promotionState === 'quarantined')
      .length,
    latestSkillId: cards[0]?.skillId || null,
  };
}

export function buildCognitiveDoctorReport(
  generatedAt = nowIso(),
  providerSnapshots?: ProviderHealthSnapshot[],
): CognitiveDoctorReport {
  const registry = ensureCognitiveToolRegistry(generatedAt);
  const runs = safeDb([], () => listCognitiveRuns({ limit: 50 }));
  const latest = runs[0];
  const subgoals = latest
    ? safeDb([], () => listCognitiveSubgoalsForRun(latest.runId))
    : [];
  const checkpoints = latest
    ? safeDb([], () =>
        listCognitiveCheckpoints({ runId: latest.runId, limit: 50 }),
      )
    : safeDb([], () => listCognitiveCheckpoints({ status: 'open', limit: 50 }));
  const cards = safeDb([], () => listCognitiveSkillCards({ limit: 100 }));
  const beliefs = safeDb([], () => listCognitiveWorldBeliefs({ limit: 100 }));
  const goals = safeDb([], () => listCognitiveGoals({ limit: 100 }));
  const blackboardEntries = safeDb([], () =>
    listCognitiveBlackboardEntries({ limit: 100 }),
  );
  const autonomyBudgets = safeDb([], () =>
    listCognitiveAutonomyBudgets({ limit: 100 }),
  );
  const benchmarkAttempts = safeDb([], () =>
    listCognitiveBenchmarkAttempts({ limit: 20 }),
  );
  const providers = providerUsability(providerSnapshots);
  if (providerSnapshots) {
    persistProviderCooldowns({
      snapshots: providerSnapshots,
      runId: latest?.runId || null,
      now: generatedAt,
    });
  }
  const replayPacket = safeDb(
    {
      generatedAt,
      runId: latest?.runId || null,
      latestRun: latest || null,
      spans: [],
      simulations: [],
      providerCooldowns: [],
      checkpoints: latest ? checkpoints : [],
      privacy: privacyReport(),
    },
    () =>
      buildCognitiveReplayPacket({
        runId: latest?.runId || null,
        generatedAt,
      }),
  );
  const traceSpans = replayPacket.spans;
  const simulations = replayPacket.simulations;
  const simulation = simulationAggregate(simulations);
  const cooldowns =
    replayPacket.providerCooldowns.length > 0
      ? replayPacket.providerCooldowns
      : activeProviderCooldowns(generatedAt);
  const recent = summarizeRecentRuns(runs);
  const skills = summarizeSkillLibrary(cards);
  const evidenceGaps = latest
    ? parseJsonSafe<CognitiveVerificationResult>(latest.verificationJson, {
        status: 'pending',
        criteria: [],
        evidenceGaps: [],
        approvalRequired: false,
        providerUsableCount: 0,
        providerDegradedCount: 0,
        nextAction: latest.nextAction,
      }).evidenceGaps || []
    : [];
  const approvalBlockers = runs
    .filter((run) => run.status === 'awaiting_approval')
    .slice(0, 5)
    .map((run) => `${run.taskFamily}:${run.selectedSkillId}`);
  const ok =
    runs.length > 0 && recent.blockedRuns < Math.max(3, runs.length / 2);
  const nextAction = !latest
    ? 'Run one normal ask, one ultrathink ask, and one approval-required draft to seed cognition proof.'
    : goals.some((goal) => goal.status === 'waiting_approval')
      ? 'Resolve the latest approval-waiting cognitive goal or let it expire before retrying the mutating task.'
      : goals.some((goal) => goal.status === 'blocked')
        ? 'Inspect the latest blocked cognitive goal and add missing evidence or clarification.'
        : skills.promoted === 0
          ? 'Let a verified successful run promote at least one cognitive skill card.'
          : recent.blockedRuns > 0
            ? 'Inspect the latest blocked run, gather missing evidence, then rerun the task.'
            : 'Keep the task ladder fresh with quick, ultrathink, read-only, and approval-gated proof turns.';
  return {
    generatedAt,
    ok,
    summary: latest
      ? `Cognitive kernel has ${runs.length} recent runs, ${skills.promoted} promoted skills, average score ${recent.averageOutcomeScore.toFixed(2)}.`
      : 'Cognitive kernel is installed but has no recorded runs yet.',
    activeRun: latest
      ? {
          runId: latest.runId,
          updatedAt: latest.updatedAt,
          taskFamily: latest.taskFamily,
          mode: latest.cognitiveMode,
          status: latest.status,
          selectedSkillId: latest.selectedSkillId,
          outcomeScore: latest.outcomeScore,
          nextAction: latest.nextAction,
          subgoalCount: subgoals.length,
        }
      : null,
    recent,
    skills,
    providerUsability: {
      healthy: providers.healthy,
      degraded: providers.degraded,
      blocked: providers.blocked,
      degradedProviderIds: providers.degradedProviderIds,
    },
    checkpoints: {
      total: checkpoints.length,
      open: checkpoints.filter((checkpoint) => checkpoint.status === 'open')
        .length,
      latestKind: checkpoints[0]?.checkpointKind || null,
      latestNextAction: checkpoints[0]?.nextAction || null,
    },
    toolRegistry: {
      total: registry.length,
      healthy: registry.filter((tool) => tool.healthState === 'healthy').length,
      approvalGated: registry.filter(
        (tool) => tool.approvalPolicy === 'explicit_approval',
      ).length,
      blocked: registry.filter((tool) => tool.healthState === 'blocked').length,
      highRisk: registry.filter((tool) => tool.riskLevel === 'high').length,
    },
    worldBeliefs: {
      total: beliefs.length,
      fresh: beliefs.filter((belief) => belief.freshness === 'fresh').length,
      stale: beliefs.filter((belief) => belief.freshness === 'stale').length,
      latestSubject: beliefs[0]?.subject || null,
    },
    benchmarks: {
      total: benchmarkAttempts.length,
      latestStatus: benchmarkAttempts[0]?.status || null,
      latestScore: benchmarkAttempts[0]?.score || null,
      failingTaskIds: benchmarkAttempts
        .filter((attempt) => attempt.status === 'fail')
        .slice(0, 5)
        .map((attempt) => attempt.taskId),
    },
    goals: {
      total: goals.length,
      active: goals.filter((goal) => goal.status === 'active').length,
      waitingApproval: goals.filter(
        (goal) => goal.status === 'waiting_approval',
      ).length,
      blocked: goals.filter((goal) => goal.status === 'blocked').length,
      latestGoalId: goals[0]?.goalId || null,
    },
    blackboard: {
      total: blackboardEntries.length,
      active: blackboardEntries.filter((entry) => entry.status === 'active')
        .length,
      latestKind: blackboardEntries[0]?.entryKind || null,
    },
    autonomyBudgets: {
      total: autonomyBudgets.length,
      approvalRequired: autonomyBudgets.filter(
        (budget) => budget.approvalRequired,
      ).length,
      mutatingAllowed: autonomyBudgets.filter(
        (budget) => budget.mutatingAllowed,
      ).length,
    },
    evidenceGaps,
    approvalBlockers,
    trace: {
      spanCount: traceSpans.length,
      blockedSpanCount: traceSpans.filter((span) => span.status === 'blocked')
        .length,
      latestSpanKind: traceSpans[traceSpans.length - 1]?.spanKind || null,
    },
    simulation,
    providerCooldowns: {
      active: cooldowns.length,
      providerIds: cooldowns.map((cooldown) => cooldown.providerId),
      nextAction: cooldowns[0]?.nextAction || null,
    },
    nextAction,
    privacy: privacyReport(),
  };
}

export function buildCognitiveTraceReport(
  params: {
    runId?: string | null;
    generatedAt?: string;
  } = {},
): CognitiveRunTraceReport {
  const generatedAt = params.generatedAt || nowIso();
  const replayPacket = buildCognitiveReplayPacket({
    runId: params.runId || null,
    generatedAt,
  });
  const simulation = simulationAggregate(replayPacket.simulations);
  const blockedSpanCount = replayPacket.spans.filter(
    (span) => span.status === 'blocked',
  ).length;
  const activeCooldownProviderIds = replayPacket.providerCooldowns.map(
    (cooldown) => cooldown.providerId,
  );
  const ok =
    blockedSpanCount === 0 &&
    simulation.status !== 'block' &&
    replayPacket.privacy.rawPromptsStored === false;
  const nextAction = !replayPacket.latestRun
    ? 'Run one cognitive task to create a trace packet.'
    : simulation.status === 'block'
      ? 'Repair the blocked tool simulation before executing this route.'
      : activeCooldownProviderIds.length > 0
        ? 'Proceed with degraded-provider wording until cooldowns expire or provider diagnostics recover.'
        : blockedSpanCount > 0
          ? 'Inspect blocked trace spans and rerun after repair.'
          : replayPacket.latestRun.nextAction;
  return {
    generatedAt,
    ok,
    summary: replayPacket.latestRun
      ? `Trace packet for ${replayPacket.latestRun.runId}: ${replayPacket.spans.length} span(s), simulation=${simulation.status}, cooldowns=${activeCooldownProviderIds.length}.`
      : 'No cognitive trace packet is available yet.',
    runId: replayPacket.runId,
    spanCount: replayPacket.spans.length,
    blockedSpanCount,
    simulationStatus: simulation.status,
    activeCooldownProviderIds,
    nextAction,
    replayPacket,
  };
}

export function formatCognitiveTraceReport(
  report: CognitiveRunTraceReport,
): string {
  return redactCouncilText(
    [
      'Cognition Trace',
      '',
      `Summary: ${report.summary}`,
      `Run: ${report.runId || 'none'}`,
      `Spans: ${report.spanCount}`,
      `Blocked spans: ${report.blockedSpanCount}`,
      `Simulation: ${report.simulationStatus}`,
      `Provider cooldowns: ${report.activeCooldownProviderIds.join(', ') || 'none'}`,
      `Checkpoints: ${report.replayPacket.checkpoints.length}`,
      `Next: ${report.nextAction}`,
      '',
      'Privacy: metadata-only replay; no raw prompts, private bodies, hidden reasoning, or secrets are stored.',
    ].join('\n'),
    3000,
  );
}

export function formatCognitiveDoctorReport(
  report: CognitiveDoctorReport,
): string {
  const lines = [
    'Cognition Status',
    '',
    `Summary: ${report.summary}`,
    `Recent runs: ${report.recent.totalRuns}`,
    `Average score: ${report.recent.averageOutcomeScore.toFixed(2)}`,
    `Blocked: ${report.recent.blockedRuns}`,
    `Awaiting approval: ${report.recent.approvalRuns}`,
    `Reward signals: ${report.recent.rewardSignals}`,
    `Reflections: ${report.recent.reflections}`,
    '',
    'Skill Library',
    `Promoted: ${report.skills.promoted}`,
    `Candidates: ${report.skills.candidates}`,
    `Quarantined: ${report.skills.quarantined}`,
    `Latest skill: ${report.skills.latestSkillId || 'none'}`,
    '',
    'Provider Usability',
    `Healthy: ${report.providerUsability.healthy}`,
    `Degraded: ${report.providerUsability.degraded}`,
    `Blocked: ${report.providerUsability.blocked}`,
    `Degraded providers: ${report.providerUsability.degradedProviderIds.join(', ') || 'none'}`,
    '',
    'Checkpoints',
    `Total: ${report.checkpoints.total}`,
    `Open: ${report.checkpoints.open}`,
    `Latest: ${report.checkpoints.latestKind || 'none'}`,
    `Checkpoint next: ${report.checkpoints.latestNextAction || 'none'}`,
    '',
    'Tool Registry',
    `Registered: ${report.toolRegistry.total}`,
    `Healthy: ${report.toolRegistry.healthy}`,
    `Approval gated: ${report.toolRegistry.approvalGated}`,
    `High risk: ${report.toolRegistry.highRisk}`,
    `Blocked tools: ${report.toolRegistry.blocked}`,
    '',
    'World Beliefs',
    `Total: ${report.worldBeliefs.total}`,
    `Fresh: ${report.worldBeliefs.fresh}`,
    `Stale: ${report.worldBeliefs.stale}`,
    `Latest subject: ${report.worldBeliefs.latestSubject || 'none'}`,
    '',
    'Benchmarks',
    `Attempts: ${report.benchmarks.total}`,
    `Latest status: ${report.benchmarks.latestStatus || 'none'}`,
    `Latest score: ${report.benchmarks.latestScore ?? 'none'}`,
    `Failing tasks: ${report.benchmarks.failingTaskIds.join(', ') || 'none'}`,
    '',
    'Goal Lifecycle',
    `Goals: ${report.goals.total}`,
    `Active: ${report.goals.active}`,
    `Waiting approval: ${report.goals.waitingApproval}`,
    `Blocked goals: ${report.goals.blocked}`,
    `Latest goal: ${report.goals.latestGoalId || 'none'}`,
    '',
    'Blackboard',
    `Entries: ${report.blackboard.total}`,
    `Active entries: ${report.blackboard.active}`,
    `Latest kind: ${report.blackboard.latestKind || 'none'}`,
    '',
    'Autonomy Budgets',
    `Budgets: ${report.autonomyBudgets.total}`,
    `Approval required: ${report.autonomyBudgets.approvalRequired}`,
    `Mutating allowed: ${report.autonomyBudgets.mutatingAllowed}`,
    '',
    'Harness Trace',
    `Spans: ${report.trace.spanCount}`,
    `Blocked spans: ${report.trace.blockedSpanCount}`,
    `Latest span: ${report.trace.latestSpanKind || 'none'}`,
    `Tool simulation: ${report.simulation.status} (${report.simulation.pass}/${report.simulation.warn}/${report.simulation.block})`,
    `Provider cooldowns: ${report.providerCooldowns.providerIds.join(', ') || 'none'}`,
  ];
  if (report.activeRun) {
    lines.push(
      '',
      'Active Run',
      `Run: ${report.activeRun.runId}`,
      `Mode: ${report.activeRun.mode}`,
      `Status: ${report.activeRun.status}`,
      `Task: ${report.activeRun.taskFamily}`,
      `Skill: ${report.activeRun.selectedSkillId}`,
      `Subgoals: ${report.activeRun.subgoalCount}`,
      `Run next: ${report.activeRun.nextAction}`,
    );
  }
  lines.push(
    '',
    `Evidence gaps: ${report.evidenceGaps.join(', ') || 'none'}`,
    `Approval blockers: ${report.approvalBlockers.join(', ') || 'none'}`,
    `Next: ${report.nextAction}`,
    '',
    'Privacy: metadata-only; no raw prompts, private message bodies, hidden reasoning, or secrets are stored.',
  );
  return redactCouncilText(lines.join('\n'), 4000);
}

export function buildTelegramCognitionStatusText(): string {
  return formatCognitiveDoctorReport(buildCognitiveDoctorReport());
}

export function isCognitionDoctorRequest(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === '/cognition' ||
    normalized === 'cognition status' ||
    normalized === 'cognitive status' ||
    normalized === 'why did you choose that?' ||
    normalized === 'why did you choose that'
  );
}

export function _testProviderUsability(
  providers: ProviderHealthSnapshot[],
): ReturnType<typeof providerUsability> {
  return providerUsability(providers);
}
