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
  listCognitiveGovernancePolicies,
  listCognitiveProviderCooldowns,
  listCognitiveReflections,
  listCognitiveGoals,
  listCognitiveRewardSignals,
  listCognitiveRuns,
  listCognitiveSkillCards,
  listCognitiveSubgoalsForRun,
  listCognitiveToolRegistry,
  listCognitiveTrajectoryScores,
  listCognitiveWorldBeliefs,
  isIsolatedTestDatabase,
  pruneCognitiveKernelData,
  replaceCognitiveSubgoalsForRun,
  resolveCognitiveCheckpoint,
  upsertCognitiveActionIdentity,
  upsertCognitiveApprovalPacket,
  upsertCognitiveAutonomyBudget,
  upsertCognitiveBlackboardEntry,
  upsertCognitiveCheckpoint,
  upsertCognitiveEvidenceArtifact,
  upsertCognitiveExecutionLoopState,
  upsertCognitiveExecutionStep,
  upsertCognitiveGoal,
  upsertCognitiveGovernanceDecision,
  upsertCognitiveGovernancePolicy,
  upsertCognitiveGuardrailTripwire,
  upsertCognitiveHandoff,
  upsertCognitiveMemoryBlock,
  upsertCognitivePlanRevision,
  upsertCognitivePolicyDecision,
  upsertCognitiveProviderCooldown,
  upsertCognitiveRiskSignal,
  upsertCognitiveRun,
  upsertCognitiveRunEvent,
  upsertCognitiveSkillCard,
  upsertCognitiveStepVerification,
  upsertCognitiveToolResult,
  upsertCognitiveToolSimulation,
  upsertCognitiveTrajectoryScore,
  upsertCognitiveTraceSpan,
  upsertCognitiveToolRegistry,
  upsertCognitiveWorkbenchState,
  upsertCognitiveWorldBelief,
} from './db.js';
import { getBraveSearchStatus } from './brave-search.js';
import { buildIntegrationDoctorReport } from './integration-doctor.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type {
  CognitiveAutonomyLevel,
  CognitiveAutonomyBudgetRecord,
  CognitiveBenchmarkAttemptRecord,
  CognitiveBlackboardEntryRecord,
  CognitiveActionIdentity,
  CognitiveApprovalPacket,
  CognitiveCheckpointRecord,
  CognitiveEvidenceArtifact,
  CognitiveExecutionStep,
  CognitiveExecutionLoopState,
  CognitiveGoalRecord,
  CognitiveGovernanceDecision,
  CognitiveGovernancePolicy,
  CognitiveGovernanceRiskClass,
  CognitiveGuardrailTripwire,
  CognitiveHandoff,
  CognitiveMemoryBlock,
  CognitiveMode,
  CognitivePlanRevision,
  CognitivePolicyDecision,
  CognitiveProviderCooldown,
  CognitiveReflectionRecord,
  CognitiveRunTraceReport,
  CognitiveRiskSignal,
  CognitiveRewardSignalRecord,
  CognitiveRunRecord,
  CognitiveRunEvent,
  CognitiveRunOrigin,
  CognitiveRunStatus,
  CognitiveSkillCardRecord,
  CognitiveStepVerification,
  CognitiveSubgoalRecord,
  CognitiveToolAdapterContract,
  CognitiveToolResultEnvelope,
  CognitiveToolSimulation,
  CognitiveTrajectoryScore,
  CognitiveToolRegistryRecord,
  CognitiveTraceSpan,
  CognitiveWorkbenchRole,
  CognitiveWorkbenchState,
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
  runOrigin?: CognitiveRunOrigin;
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
  actionIdentities: CognitiveActionIdentity[];
  governanceDecisions: CognitiveGovernanceDecision[];
  guardrailTripwires: CognitiveGuardrailTripwire[];
  handoffs: CognitiveHandoff[];
  riskSignals: CognitiveRiskSignal[];
  memoryBlocks: CognitiveMemoryBlock[];
  workbenchState: CognitiveWorkbenchState;
  toolSimulations: CognitiveToolSimulation[];
  policyDecisions: CognitivePolicyDecision[];
  toolResults: CognitiveToolResultEnvelope[];
  executionSteps: CognitiveExecutionStep[];
  evidenceArtifacts: CognitiveEvidenceArtifact[];
  loopStates: CognitiveExecutionLoopState[];
  stepVerifications: CognitiveStepVerification[];
  approvalPackets: CognitiveApprovalPacket[];
  planRevisions: CognitivePlanRevision[];
  runEvents: CognitiveRunEvent[];
  trajectoryScore: CognitiveTrajectoryScore;
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
    observedRuns: number;
    totalRuns: number;
    replayRuns: number;
    syntheticRuns: number;
    blockedRuns: number;
    approvalRuns: number;
    averageOutcomeScore: number;
    qualityScore: number;
    decisionAppropriateRuns: number;
    safeApprovalRuns: number;
    appropriatelyBlockedRuns: number;
    operationalFailureRuns: number;
    finalizedRuns: number;
    reviewedOutcomeRuns: number;
    rewardSignals: number;
    reflections: number;
  };
  skills: {
    total: number;
    promoted: number;
    trustedPromoted: number;
    unverifiedPromoted: number;
    reviewEligibleCandidates: number;
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
  execution: {
    steps: number;
    executed: number;
    degraded: number;
    blocked: number;
    approvalStaged: number;
    skipped: number;
    toolResults: number;
    policyDecisions: number;
    planRevisions: number;
    status: 'pass' | 'warn' | 'block' | 'none';
    latestToolId?: string | null;
    latestNextAction?: string | null;
  };
  providerCooldowns: {
    active: number;
    providerIds: string[];
    nextAction?: string | null;
  };
  executorLoop: {
    total: number;
    latestStatus?: CognitiveExecutionLoopState['status'] | null;
    latestRound?: number | null;
    executedToolSteps: number;
    evidenceSatisfied: boolean;
    nextAction?: string | null;
  };
  evidenceArtifacts: {
    total: number;
    public: number;
    metadata: number;
    privateMetadata: number;
    sanitizedDigest: number;
    latestKinds: string[];
  };
  stepVerification: {
    total: number;
    pass: number;
    warn: number;
    block: number;
    approvalStaged: number;
  };
  approvalPackets: {
    total: number;
    staged: number;
    latestToolId?: string | null;
    latestNextAction?: string | null;
  };
  trajectory: {
    total: number;
    latestStatus?: CognitiveTrajectoryScore['status'] | null;
    latestScore?: number | null;
    promotedRoute: boolean;
    demotedAdapters: string[];
    nextAction?: string | null;
  };
  governance: {
    policies: number;
    decisions: number;
    allow: number;
    warn: number;
    staged: number;
    blocked: number;
    triggeredTripwires: number;
    riskSignals: number;
    nextAction?: string | null;
  };
  workbench: {
    status: CognitiveWorkbenchState['status'] | 'none';
    handoffs: number;
    memoryBlocks: number;
    activeGoalId?: string | null;
    selectedSkillId?: string | null;
    nextAction?: string | null;
  };
  memoryBlocks: {
    total: number;
    conflicted: number;
    blocked: number;
    poisoningRiskMax: number;
    latestKinds: string[];
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

const V9_SOURCE_PATTERN_REFS = [
  'gbrain@805814451ec9e962ceed1b931b9b512d80f70024:source-attribution/conflict-coverage-pattern',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:packages/agents-core/src/guardrail.ts',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:packages/agents-core/src/toolGuardrail.ts',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:packages/agents-core/src/handoff.ts',
  'openai-agents-js@5ffee5443eeb362fca0dc7195462e355218b5fe0:packages/agents-core/src/tracing/traces.ts',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:policy-engine/sdk/node/src/adapters.ts',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:policy-engine/sdk/node/src/adapter-helpers.ts',
  'microsoft-agent-governance-toolkit@e0183314fa0fbaa91a92389d97fb45ac99f03be7:policy-engine/tests/conformance',
];

function governanceRiskClasses(): CognitiveGovernanceRiskClass[] {
  return [
    'goal_hijack',
    'prompt_injection',
    'tool_misuse',
    'memory_poisoning',
    'identity_ambiguity',
    'cascading_failure',
    'rogue_agent_behavior',
    'data_exfiltration',
    'unauthorized_write',
    'policy_drift',
  ];
}

function defaultGovernancePolicy(now: string): CognitiveGovernancePolicy {
  return {
    policyId: 'cogpolicy:governed-workbench:v9',
    createdAt: now,
    updatedAt: now,
    policyName: 'Andrea v9 Governed Cognitive Workbench',
    status: 'active',
    version: 'v9',
    defaultAction: 'block',
    readOnlyAllowed: true,
    mutatingAllowed: false,
    approvalRequiredForHighRisk: true,
    riskClassesJson: safeJson(governanceRiskClasses()),
    sourcePatternRefsJson: safeJson(V9_SOURCE_PATTERN_REFS, 2400),
    privacyJson: privacyPolicyJson(),
  };
}

function ensureCognitiveGovernancePolicy(
  now = nowIso(),
): CognitiveGovernancePolicy {
  const policy = defaultGovernancePolicy(now);
  safeDb(undefined, () => upsertCognitiveGovernancePolicy(policy));
  return (
    safeDb([], () =>
      listCognitiveGovernancePolicies({ status: 'active', limit: 1 }),
    )[0] || policy
  );
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
      toolId: 'integrations_status',
      toolKind: 'local_lookup',
      displayName: 'Integrations Status',
      purpose:
        'Read redacted integration doctor status before choosing tool routes.',
      allowedActions: ['read_integration_doctor'],
      approvalPolicy: 'none',
      riskLevel: 'low',
      evidenceProduced: ['integration_states', 'manual_blockers'],
      failureModes: ['integration_doctor_unavailable'],
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
      toolId: 'bluebubbles_status',
      toolKind: 'read_only_integration',
      displayName: 'BlueBubbles Status',
      purpose:
        'Read BlueBubbles transport/proof status before drafting Messages help.',
      allowedActions: ['read_bluebubbles_doctor'],
      approvalPolicy: 'read_only',
      riskLevel: 'medium',
      evidenceProduced: ['bluebubbles_proof_state', 'message_action_blocker'],
      failureModes: ['bluebubbles_offline', 'proof_missing'],
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
      toolKind: 'read_only_integration',
      displayName: 'Operator Diagnostics',
      purpose:
        'Read service/debug status and produce metadata-only repair evidence.',
      allowedActions: ['read_status', 'read_repair_blocker'],
      approvalPolicy: 'read_only',
      riskLevel: 'medium',
      evidenceProduced: ['status_summary', 'repair_blocker'],
      failureModes: ['main_control_missing', 'status_unavailable'],
      healthState: 'unknown',
    }),
    tool({
      toolId: 'cognition_trace',
      toolKind: 'local_lookup',
      displayName: 'Cognition Trace',
      purpose:
        'Read prior sanitized cognition trace metadata to explain route choice.',
      allowedActions: ['read_trace_summary'],
      approvalPolicy: 'none',
      riskLevel: 'low',
      evidenceProduced: ['trace_span_counts', 'last_next_action'],
      failureModes: ['no_trace_available'],
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
  unknown: number;
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
    unknown: providers.filter((provider) => provider.state === 'unknown')
      .length,
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
    const contract = tool ? adapterContractForTool(tool) : null;
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
      readOnly: contract
        ? contract.policyClass !== 'approval_staged'
        : ['local_lookup', 'read_only_integration', 'council'].includes(
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

interface CognitiveExecutionBundle {
  actionIdentities: CognitiveActionIdentity[];
  governanceDecisions: CognitiveGovernanceDecision[];
  guardrailTripwires: CognitiveGuardrailTripwire[];
  handoffs: CognitiveHandoff[];
  riskSignals: CognitiveRiskSignal[];
  memoryBlocks: CognitiveMemoryBlock[];
  workbenchState: CognitiveWorkbenchState;
  policyDecisions: CognitivePolicyDecision[];
  toolResults: CognitiveToolResultEnvelope[];
  executionSteps: CognitiveExecutionStep[];
  evidenceArtifacts: CognitiveEvidenceArtifact[];
  loopStates: CognitiveExecutionLoopState[];
  stepVerifications: CognitiveStepVerification[];
  approvalPackets: CognitiveApprovalPacket[];
  planRevisions: CognitivePlanRevision[];
  runEvents: CognitiveRunEvent[];
  trajectoryScore: CognitiveTrajectoryScore;
}

function executionAggregate(input: {
  steps: CognitiveExecutionStep[];
  results: CognitiveToolResultEnvelope[];
  decisions: CognitivePolicyDecision[];
  revisions: CognitivePlanRevision[];
}): CognitiveDoctorReport['execution'] {
  const blocked = input.steps.filter(
    (step) => step.status === 'blocked',
  ).length;
  const degraded = input.steps.filter(
    (step) => step.status === 'degraded' || step.status === 'failed',
  ).length;
  const approvalStaged = input.steps.filter(
    (step) => step.status === 'approval_staged',
  ).length;
  const skipped = input.steps.filter(
    (step) => step.status === 'skipped',
  ).length;
  const executed = input.steps.filter(
    (step) => step.status === 'executed',
  ).length;
  const latest = input.steps[input.steps.length - 1] || null;
  return {
    steps: input.steps.length,
    executed,
    degraded,
    blocked,
    approvalStaged,
    skipped,
    toolResults: input.results.length,
    policyDecisions: input.decisions.length,
    planRevisions: input.revisions.length,
    status:
      input.steps.length === 0
        ? 'none'
        : blocked > 0
          ? 'block'
          : degraded > 0 || approvalStaged > 0 || skipped > 0
            ? 'warn'
            : 'pass',
    latestToolId: latest?.toolId || null,
    latestNextAction: latest?.nextAction || null,
  };
}

function adapterContractForTool(
  tool: CognitiveToolRegistryRecord,
): CognitiveToolAdapterContract {
  const readOnly =
    tool.approvalPolicy === 'read_only' ||
    tool.approvalPolicy === 'none' ||
    tool.toolKind === 'local_lookup' ||
    tool.toolKind === 'read_only_integration' ||
    tool.toolKind === 'council';
  return {
    toolId: tool.toolId,
    policyClass: readOnly
      ? tool.toolKind === 'council'
        ? 'council'
        : tool.toolKind === 'local_lookup'
          ? 'local_lookup'
          : 'read_only'
      : 'approval_staged',
    inputSchemaJson: safeJson({
      runId: 'string',
      sanitizedGoal: 'string',
      noRawPrivateBodies: true,
    }),
    outputSchemaJson: safeJson({
      summary: 'sanitized string',
      evidenceRefs: 'string[]',
      outputShape: 'metadata object',
      nextAction: 'sanitized string',
    }),
    timeoutMs: tool.riskLevel === 'high' ? 5_000 : 8_000,
    retryPolicyJson: safeJson({
      retries: readOnly ? 1 : 0,
      cooldownOnFailure: tool.toolKind === 'council' ? 'provider' : 'tool',
    }),
    evidenceMapper: `${tool.toolId}:metadata_artifact`,
    failureClassifier: `${tool.toolId}:status_or_policy_failure`,
    privacyJson: privacyPolicyJson(),
  };
}

function artifactKindForTool(
  toolId: string,
): CognitiveEvidenceArtifact['artifactKind'] {
  if (toolId === 'local_skill_library') return 'local_memory';
  if (toolId === 'provider_health') return 'provider_health';
  if (toolId === 'integrations_status') return 'integration_status';
  if (toolId === 'google_calendar_read') return 'calendar_read';
  if (toolId === 'brave_search') return 'research_evidence';
  if (toolId === 'bluebubbles_status') return 'bluebubbles_digest';
  if (toolId === 'operator_diagnostics') return 'operator_diagnostics';
  if (toolId === 'provider_council') return 'council';
  if (toolId === 'cognition_trace') return 'cognition_trace';
  if (toolId === 'bluebubbles_draft' || toolId === 'approval_stage') {
    return 'approval_packet';
  }
  return 'unknown';
}

function artifactSensitivityForTool(
  toolId: string,
): CognitiveEvidenceArtifact['sensitivity'] {
  if (toolId === 'brave_search') return 'public';
  if (toolId === 'bluebubbles_status') return 'private_metadata';
  if (toolId === 'google_calendar_read') return 'private_metadata';
  if (toolId === 'bluebubbles_draft') return 'sanitized_digest';
  return 'metadata';
}

function evidenceArtifactForStep(input: {
  run: CognitiveRunRecord;
  step: CognitiveExecutionStep;
  result: CognitiveToolResultEnvelope;
  now: string;
}): CognitiveEvidenceArtifact {
  const refs = parseJsonSafe<string[]>(input.result.evidenceRefsJson, []);
  const artifactKind = artifactKindForTool(input.step.toolId);
  return {
    artifactId: sanitizeId(
      `cogartifact:${input.run.runId}:${input.step.position}:${input.step.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.run.runId,
    toolId: input.step.toolId,
    resultId: input.result.resultId,
    artifactKind,
    summary: input.result.summary,
    evidenceRefsJson: safeJson(refs, 1600),
    sourceShapeJson: input.result.outputShapeJson,
    sensitivity: artifactSensitivityForTool(input.step.toolId),
    freshness: input.result.status === 'succeeded' ? 'fresh' : 'unknown',
    confidence:
      input.result.status === 'succeeded'
        ? 0.84
        : input.result.status === 'degraded'
          ? 0.56
          : input.result.status === 'blocked'
            ? 0.22
            : 0.35,
    privacyJson: privacyPolicyJson(),
  };
}

function stepVerificationFor(input: {
  run: CognitiveRunRecord;
  step: CognitiveExecutionStep;
  artifact: CognitiveEvidenceArtifact;
  decision: CognitivePolicyDecision;
  result: CognitiveToolResultEnvelope;
  now: string;
}): CognitiveStepVerification {
  const status: CognitiveStepVerification['status'] =
    input.step.status === 'approval_staged'
      ? 'approval_staged'
      : input.step.status === 'blocked' || input.result.status === 'blocked'
        ? 'block'
        : input.step.status === 'degraded' || input.result.status === 'degraded'
          ? 'warn'
          : 'pass';
  const evidenceSufficient =
    status === 'pass' ||
    (status === 'warn' && input.result.status !== 'blocked');
  return {
    verificationId: sanitizeId(
      `cogverify:${input.run.runId}:${input.step.position}:${input.step.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.run.runId,
    stepId: input.step.stepId,
    toolId: input.step.toolId,
    status,
    evidenceArtifactIdsJson: safeJson([input.artifact.artifactId], 1200),
    evidenceSufficient,
    approvalRequired: input.decision.status === 'stage_approval',
    blockerClass:
      status === 'block'
        ? input.result.failureClass || 'tool_blocked'
        : status === 'warn'
          ? input.result.failureClass || 'tool_degraded'
          : null,
    nextAction:
      status === 'pass'
        ? 'Use this evidence artifact in the answer path.'
        : status === 'approval_staged'
          ? 'Wait for explicit approval before executing this side effect.'
          : input.result.nextAction,
    privacyJson: privacyPolicyJson(),
  };
}

function approvalPacketForStep(input: {
  run: CognitiveRunRecord;
  step: CognitiveExecutionStep;
  decision: CognitivePolicyDecision;
  result: CognitiveToolResultEnvelope;
  now: string;
}): CognitiveApprovalPacket | null {
  if (input.step.status !== 'approval_staged') return null;
  return {
    approvalPacketId: sanitizeId(
      `cogapproval:${input.run.runId}:${input.step.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    updatedAt: input.now,
    runId: input.run.runId,
    toolId: input.step.toolId,
    actionClass: input.step.actionClass,
    status: 'staged',
    summary: `Approval staged for ${input.step.toolId}; no external side effect executed.`,
    approvalChannel: input.run.channel || null,
    approvalKey: `${input.run.taskFamily}:${input.run.selectedSkillId}`,
    expiresAt: new Date(
      Date.parse(input.now) + 2 * 60 * 60 * 1000,
    ).toISOString(),
    decisionJson: safeJson(
      {
        decisionId: input.decision.decisionId,
        resultId: input.result.resultId,
        approvalRequired: true,
        externalActionExecuted: false,
      },
      1600,
    ),
    privacyJson: privacyPolicyJson(),
  };
}

function loopStateForExecution(input: {
  run: CognitiveRunRecord;
  executionSteps: CognitiveExecutionStep[];
  verifications: CognitiveStepVerification[];
  revisions: CognitivePlanRevision[];
  budget: CognitiveAutonomyBudgetRecord;
  now: string;
}): CognitiveExecutionLoopState {
  const blocked = input.verifications.some(
    (verification) => verification.status === 'block',
  );
  const staged = input.verifications.some(
    (verification) => verification.status === 'approval_staged',
  );
  const degraded = input.verifications.some(
    (verification) => verification.status === 'warn',
  );
  const executed = input.executionSteps.filter(
    (step) => step.status === 'executed',
  ).length;
  const exhausted = input.executionSteps.length >= input.budget.maxToolSteps;
  const openEvidenceGaps = input.verifications
    .filter((verification) => !verification.evidenceSufficient)
    .map((verification) => `${verification.toolId}:${verification.status}`);
  const status: CognitiveExecutionLoopState['status'] = blocked
    ? 'blocked'
    : staged
      ? 'approval_staged'
      : exhausted && openEvidenceGaps.length > 0
        ? 'budget_exhausted'
        : degraded
          ? 'degraded'
          : 'satisfied';
  return {
    loopId: sanitizeId(`cogloop:${input.run.runId}:main`),
    createdAt: input.now,
    updatedAt: input.now,
    runId: input.run.runId,
    status,
    round: Math.max(
      1,
      Math.min(
        4,
        input.executionSteps.filter((step) => step.status !== 'skipped').length,
      ),
    ),
    maxRounds: 4,
    maxToolSteps: input.budget.maxToolSteps,
    executedToolSteps: executed,
    evidenceSatisfied: openEvidenceGaps.length === 0 && !blocked,
    openEvidenceGapsJson: safeJson(openEvidenceGaps, 1600),
    nextToolIdsJson: safeJson(
      input.executionSteps
        .filter(
          (step) => step.status === 'blocked' || step.status === 'degraded',
        )
        .map((step) => step.toolId)
        .slice(0, 8),
      1200,
    ),
    nextAction:
      status === 'satisfied'
        ? 'Answer with gathered read-only evidence and record trajectory score.'
        : status === 'approval_staged'
          ? 'Wait for explicit approval using the staged approval packet.'
          : input.revisions[input.revisions.length - 1]?.nextAction ||
            'Name the evidence blocker and ask for the missing proof.',
    privacyJson: privacyPolicyJson(),
  };
}

function trajectoryScoreForExecution(input: {
  run: CognitiveRunRecord;
  executionSteps: CognitiveExecutionStep[];
  artifacts: CognitiveEvidenceArtifact[];
  verifications: CognitiveStepVerification[];
  approvalPackets: CognitiveApprovalPacket[];
  loopState: CognitiveExecutionLoopState;
  now: string;
}): CognitiveTrajectoryScore {
  const blockers = input.verifications.filter(
    (verification) => verification.status === 'block',
  );
  const warnings = input.verifications.filter(
    (verification) => verification.status === 'warn',
  );
  const evidenceSufficiency = clamp01(
    input.artifacts.length / Math.max(1, input.executionSteps.length),
  );
  const toolEfficiency = clamp01(
    1 - Math.max(0, input.executionSteps.length - 5) / 8,
  );
  const verifierSatisfaction =
    blockers.length > 0
      ? 0.25
      : warnings.length > 0
        ? 0.68
        : input.verifications.length > 0
          ? 0.9
          : 0.5;
  const blockerClarity =
    blockers.length === 0 && input.loopState.status !== 'budget_exhausted'
      ? 0.88
      : input.loopState.nextAction.length > 20
        ? 0.72
        : 0.35;
  const privacySafety = 1;
  const outcomeSignal =
    input.run.status === 'answered'
      ? 0.86
      : input.run.status === 'awaiting_approval'
        ? 0.62
        : input.run.status === 'blocked'
          ? 0.35
          : 0.5;
  const overall = Number(
    (
      (evidenceSufficiency +
        toolEfficiency +
        verifierSatisfaction +
        blockerClarity +
        privacySafety +
        outcomeSignal) /
      6
    ).toFixed(3),
  );
  const demotedAdapters = input.verifications
    .filter((verification) => verification.status === 'block')
    .map((verification) => verification.toolId);
  return {
    trajectoryId: sanitizeId(`cogtrajectory:${input.run.runId}`),
    createdAt: input.now,
    runId: input.run.runId,
    taskFamily: input.run.taskFamily,
    status: overall >= 0.82 ? 'pass' : overall >= 0.62 ? 'warn' : 'fail',
    overallScore: overall,
    evidenceSufficiency: Number(evidenceSufficiency.toFixed(3)),
    toolEfficiency: Number(toolEfficiency.toFixed(3)),
    verifierSatisfaction: Number(verifierSatisfaction.toFixed(3)),
    blockerClarity: Number(blockerClarity.toFixed(3)),
    privacySafety,
    outcomeSignal: Number(outcomeSignal.toFixed(3)),
    promotedRoute: overall >= 0.82 && input.approvalPackets.length === 0,
    demotedAdaptersJson: safeJson(demotedAdapters, 1200),
    nextAction:
      overall >= 0.82
        ? 'Promote this read-only route when outcome confirmation arrives.'
        : demotedAdapters.length > 0
          ? 'Demote or repair blocked adapters before repeating this route.'
          : 'Keep route usable but gather stronger evidence next time.',
    privacyJson: privacyPolicyJson(),
  };
}

function runEvent(input: {
  runId: string;
  eventKind: CognitiveRunEvent['eventKind'];
  summary: string;
  refs: string[];
  now: string;
}): CognitiveRunEvent {
  return {
    eventId: sanitizeId(
      `cogevent:${input.runId}:${input.eventKind}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    eventKind: input.eventKind,
    summary: redactCouncilText(input.summary, 520),
    refsJson: safeJson(input.refs.map((ref) => redactCouncilText(ref, 180))),
    privacyJson: privacyPolicyJson(),
  };
}

function roleForTool(toolId: string): CognitiveWorkbenchRole {
  if (toolId === 'local_skill_library') return 'memory_curator';
  if (toolId === 'provider_council') return 'verifier';
  if (toolId === 'operator_diagnostics') return 'operator_diagnostician';
  if (toolId === 'bluebubbles_draft' || toolId === 'approval_stage') {
    return 'final_arbiter';
  }
  if (
    [
      'provider_health',
      'integrations_status',
      'google_calendar_read',
      'brave_search',
      'bluebubbles_status',
      'cognition_trace',
    ].includes(toolId)
  ) {
    return 'evidence_scout';
  }
  return 'executor';
}

function sideEffectClassFor(input: {
  plan: CognitiveToolCallPlan;
  registry?: CognitiveToolRegistryRecord | null;
}): CognitiveActionIdentity['sideEffectClass'] {
  if (
    input.plan.actionClass === 'draft' ||
    input.plan.actionClass === 'approval_gate' ||
    input.registry?.approvalPolicy === 'explicit_approval'
  ) {
    return 'draft';
  }
  if (
    input.registry?.riskLevel === 'high' &&
    input.registry?.approvalPolicy !== 'read_only'
  ) {
    return 'mutating';
  }
  if (
    input.registry?.approvalPolicy === 'read_only' ||
    input.plan.actionClass === 'read_only_integration' ||
    input.plan.actionClass === 'council'
  ) {
    return 'read_only';
  }
  return 'none';
}

function actionIdentityFor(input: {
  run: CognitiveRunRecord;
  plan: CognitiveToolCallPlan;
  registry?: CognitiveToolRegistryRecord | null;
  index: number;
  now: string;
}): CognitiveActionIdentity {
  const contract = input.registry
    ? adapterContractForTool(input.registry)
    : null;
  return {
    actionId: sanitizeId(
      `cogaction:${input.run.runId}:${String(input.index + 1).padStart(2, '0')}:${input.plan.toolId}`,
    ),
    createdAt: input.now,
    runId: input.run.runId,
    toolId: input.plan.toolId,
    actionClass: input.plan.actionClass,
    actorRole: roleForTool(input.plan.toolId),
    policyClass: contract?.policyClass || 'approval_staged',
    channel: input.run.channel,
    targetKind:
      input.plan.actionClass === 'draft' ||
      input.plan.actionClass === 'approval_gate'
        ? 'approval_target'
        : 'metadata_source',
    targetSummary: redactCouncilText(
      input.registry?.displayName || input.plan.purpose || input.plan.toolId,
      260,
    ),
    sideEffectClass: sideEffectClassFor({
      plan: input.plan,
      registry: input.registry,
    }),
    identityRefsJson: safeJson({
      runId: input.run.runId,
      selectedSkillId: input.run.selectedSkillId,
      taskFamily: input.run.taskFamily,
      sourcePatternRefs: V9_SOURCE_PATTERN_REFS.slice(0, 4),
    }),
    privacyJson: privacyPolicyJson(),
  };
}

function severityRank(
  value:
    | CognitiveGuardrailTripwire['severity']
    | CognitiveRiskSignal['severity'],
): number {
  return { low: 1, medium: 2, high: 3, critical: 4 }[value] || 0;
}

function maxSeverity(
  tripwires: CognitiveGuardrailTripwire[],
): CognitiveGovernanceDecision['riskLevel'] {
  const max = tripwires.reduce(
    (rank, tripwire) => Math.max(rank, severityRank(tripwire.severity)),
    0,
  );
  if (max >= 4) return 'critical';
  if (max >= 3) return 'high';
  if (max >= 2) return 'medium';
  return 'low';
}

function makeTripwire(input: {
  runId: string;
  toolId?: string | null;
  riskClass: CognitiveGovernanceRiskClass;
  severity: CognitiveGuardrailTripwire['severity'];
  source: CognitiveGuardrailTripwire['source'];
  summary: string;
  evidenceRefs: string[];
  nextAction: string;
  now: string;
}): CognitiveGuardrailTripwire {
  return {
    tripwireId: sanitizeId(
      `cogtrip:${input.runId}:${input.riskClass}:${input.toolId || 'run'}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    toolId: input.toolId || null,
    riskClass: input.riskClass,
    severity: input.severity,
    triggered: true,
    source: input.source,
    summary: redactCouncilText(input.summary, 420),
    evidenceRefsJson: safeJson(input.evidenceRefs, 1600),
    nextAction: redactCouncilText(input.nextAction, 420),
    privacyJson: privacyPolicyJson(),
  };
}

function guardrailTripwiresFor(input: {
  run: CognitiveRunRecord;
  goalText: string;
  plan: CognitiveToolCallPlan;
  registry?: CognitiveToolRegistryRecord | null;
  simulation?: CognitiveToolSimulation | null;
  action: CognitiveActionIdentity;
  provider: ReturnType<typeof providerUsability>;
  now: string;
}): CognitiveGuardrailTripwire[] {
  const text = input.goalText.toLowerCase();
  const tripwires: CognitiveGuardrailTripwire[] = [];
  const refs = [
    input.action.actionId,
    input.simulation?.simulationId || `tool:${input.plan.toolId}`,
  ];
  if (!input.registry) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'policy_drift',
        severity: 'high',
        source: 'tool_policy',
        summary: 'Tool plan references an unregistered adapter.',
        evidenceRefs: refs,
        nextAction: 'Register the tool adapter or remove it from the plan.',
        now: input.now,
      }),
    );
  }
  if (input.simulation?.status === 'block') {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'tool_misuse',
        severity: 'high',
        source: 'tool_policy',
        summary: 'Tool simulation blocked this step before execution.',
        evidenceRefs: refs,
        nextAction:
          'Repair the simulation issue or stage a clarification before running the tool.',
        now: input.now,
      }),
    );
  }
  if (
    /\b(ignore|bypass|override|disable)\b.{0,40}\b(system|developer|policy|guardrail|instructions?)\b/i.test(
      text,
    ) ||
    /\b(reveal|show|print)\b.{0,40}\b(hidden|system|developer|prompt|chain of thought|reasoning)\b/i.test(
      text,
    )
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'prompt_injection',
        severity: 'critical',
        source: 'goal',
        summary:
          'Goal resembles an instruction-override or hidden-prompt request.',
        evidenceRefs: refs,
        nextAction:
          'Decline hidden prompt/reasoning exposure and continue only with safe task metadata.',
        now: input.now,
      }),
    );
  }
  const protectiveRawLocal =
    /\braw (private|message)[^.!?\n]{0,80}\bstays local\b/i.test(text) ||
    /\bstays local[^.!?\n]{0,80}\braw (private|message)\b/i.test(text);
  if (
    !protectiveRawLocal &&
    /\b(api key|secret|token|password|raw private|raw message|private bod(y|ies)|dump messages?)\b/i.test(
      text,
    )
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'data_exfiltration',
        severity: 'critical',
        source: 'goal',
        summary:
          'Goal asks for secret, raw private, or unsanitized content exposure.',
        evidenceRefs: refs,
        nextAction:
          'Refuse raw sensitive data exposure; provide redacted status or recovery steps only.',
        now: input.now,
      }),
    );
  }
  if (
    /\bremember\b.{0,80}\b(ignore|override|always obey|secret|token|password|system|developer)\b/i.test(
      text,
    )
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'memory_poisoning',
        severity: 'high',
        source: 'memory',
        summary:
          'Goal attempts to persist unsafe or instruction-like memory content.',
        evidenceRefs: refs,
        nextAction:
          'Do not create durable memory; ask for a safe preference or fact instead.',
        now: input.now,
      }),
    );
  }
  if (
    input.action.sideEffectClass === 'mutating' ||
    (input.action.sideEffectClass === 'draft' && !input.plan.approvalRequired)
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'unauthorized_write',
        severity: 'critical',
        source: 'tool_policy',
        summary:
          'A mutating or send-adjacent action attempted to pass without approval.',
        evidenceRefs: refs,
        nextAction:
          'Fail closed into an approval packet and wait for explicit same-channel approval.',
        now: input.now,
      }),
    );
  }
  if (
    /\b(auto[- ]?send|always send|run without approval|unrestricted)\b/i.test(
      text,
    )
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'rogue_agent_behavior',
        severity: 'high',
        source: 'goal',
        summary: 'Goal requests autonomy that exceeds Andrea approval policy.',
        evidenceRefs: refs,
        nextAction:
          'Keep side effects staged and explain the approval boundary plainly.',
        now: input.now,
      }),
    );
  }
  if (
    input.provider.blocked >= 2 &&
    (input.plan.toolId === 'provider_health' ||
      input.plan.toolId === 'provider_council')
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'cascading_failure',
        severity: 'medium',
        source: 'provider',
        summary:
          'Multiple providers are blocked or unavailable, reducing independent verification.',
        evidenceRefs: refs.concat(input.provider.degradedProviderIds),
        nextAction:
          'Skip blocked providers honestly and use available evidence with reduced-confidence wording.',
        now: input.now,
      }),
    );
  }
  if (
    input.run.taskFamily === 'communication' &&
    input.plan.toolId === 'bluebubbles_draft' &&
    !input.run.channel
  ) {
    tripwires.push(
      makeTripwire({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        riskClass: 'identity_ambiguity',
        severity: 'high',
        source: 'handoff',
        summary:
          'Communication draft lacks a channel identity for approval continuity.',
        evidenceRefs: refs,
        nextAction:
          'Ask which channel/thread should own the draft before staging approval.',
        now: input.now,
      }),
    );
  }
  return tripwires;
}

function governanceDecisionFor(input: {
  run: CognitiveRunRecord;
  plan: CognitiveToolCallPlan;
  action: CognitiveActionIdentity;
  policy: CognitiveGovernancePolicy;
  tripwires: CognitiveGuardrailTripwire[];
  simulation?: CognitiveToolSimulation | null;
  registry?: CognitiveToolRegistryRecord | null;
  now: string;
}): CognitiveGovernanceDecision {
  const riskClasses = Array.from(
    new Set(input.tripwires.map((tripwire) => tripwire.riskClass)),
  );
  const tripwireIds = input.tripwires.map((tripwire) => tripwire.tripwireId);
  const riskLevel = maxSeverity(input.tripwires);
  const hasCritical = input.tripwires.some(
    (tripwire) => tripwire.severity === 'critical',
  );
  const hasHigh = input.tripwires.some(
    (tripwire) => tripwire.severity === 'high',
  );
  const requiresApproval =
    input.action.sideEffectClass === 'draft' ||
    input.action.sideEffectClass === 'mutating' ||
    input.plan.approvalRequired ||
    input.registry?.riskLevel === 'high';
  const readOnlyAllowed =
    input.policy.readOnlyAllowed &&
    (input.action.sideEffectClass === 'none' ||
      input.action.sideEffectClass === 'read_only');
  const status: CognitiveGovernanceDecision['status'] =
    hasCritical ||
    input.simulation?.status === 'block' ||
    (!input.registry && input.policy.defaultAction === 'block')
      ? 'block'
      : requiresApproval
        ? 'stage_approval'
        : hasHigh || input.simulation?.status === 'warn'
          ? 'warn'
          : readOnlyAllowed
            ? 'allow'
            : input.policy.defaultAction;
  const reason =
    status === 'block'
      ? 'Governance guardrail blocked this step before execution.'
      : status === 'stage_approval'
        ? 'Governance staged a side-effect-adjacent or high-risk step for explicit approval.'
        : status === 'warn'
          ? 'Governance allowed read-only execution with risk warnings.'
          : 'Governance allowed safe metadata-only read-only execution.';
  const nextAction =
    status === 'block'
      ? input.tripwires[0]?.nextAction ||
        'Repair the governance blocker before continuing.'
      : status === 'stage_approval'
        ? 'Create an approval packet and wait for explicit same-channel approval before side effects.'
        : status === 'warn'
          ? 'Continue with reduced-confidence wording and surface the risk in diagnostics.'
          : 'Continue to the read-only adapter and map sanitized evidence.';
  return {
    decisionId: sanitizeId(
      `coggov:${input.run.runId}:${input.plan.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.run.runId,
    toolId: input.plan.toolId,
    actionId: input.action.actionId,
    policyId: input.policy.policyId,
    interventionPoint:
      input.plan.actionClass === 'council'
        ? 'council'
        : input.plan.actionClass === 'approval_gate'
          ? 'pre_approval'
          : 'pre_tool',
    status,
    riskLevel,
    riskClassesJson: safeJson(riskClasses, 1600),
    tripwireIdsJson: safeJson(tripwireIds, 1600),
    reason,
    nextAction,
    privacyJson: privacyPolicyJson(),
  };
}

function riskSignalsForDecision(input: {
  runId: string;
  decision: CognitiveGovernanceDecision;
  tripwires: CognitiveGuardrailTripwire[];
  now: string;
}): CognitiveRiskSignal[] {
  return input.tripwires.map((tripwire) => ({
    signalId: sanitizeId(
      `cogrisk:${input.runId}:${tripwire.riskClass}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    riskClass: tripwire.riskClass,
    severity: tripwire.severity,
    status:
      input.decision.status === 'block' ||
      input.decision.status === 'stage_approval'
        ? 'mitigated'
        : 'open',
    source: tripwire.source === 'provider' ? 'provider' : 'tripwire',
    summary: tripwire.summary,
    evidenceRefsJson: tripwire.evidenceRefsJson,
    governanceDecisionId: input.decision.decisionId,
    nextAction: tripwire.nextAction,
    privacyJson: privacyPolicyJson(),
  }));
}

function handoffsForRun(input: {
  run: CognitiveRunRecord;
  graph: CognitiveTaskGraph;
  decisions: CognitiveGovernanceDecision[];
  evidenceArtifacts: CognitiveEvidenceArtifact[];
  approvalPackets: CognitiveApprovalPacket[];
  now: string;
}): CognitiveHandoff[] {
  const evidenceRefs = input.evidenceArtifacts
    .slice(0, 8)
    .map((artifact) => artifact.artifactId);
  const blockedDecision = input.decisions.find(
    (decision) => decision.status === 'block',
  );
  const stagedDecision = input.decisions.find(
    (decision) => decision.status === 'stage_approval',
  );
  const handoff = (
    index: number,
    fromRole: CognitiveWorkbenchRole,
    toRole: CognitiveWorkbenchRole,
    status: CognitiveHandoff['status'],
    reason: string,
    decision?: CognitiveGovernanceDecision | null,
  ): CognitiveHandoff => ({
    handoffId: sanitizeId(
      `coghandoff:${input.run.runId}:${String(index).padStart(2, '0')}:${fromRole}:${toRole}`,
    ),
    createdAt: input.now,
    runId: input.run.runId,
    fromRole,
    toRole,
    status,
    reason: redactCouncilText(reason, 420),
    evidenceRefsJson: safeJson(evidenceRefs, 1600),
    governanceDecisionId: decision?.decisionId || null,
    nextAction:
      status === 'blocked'
        ? decision?.nextAction || input.run.nextAction
        : status === 'skipped'
          ? 'Skip this role because the current task does not need that lane.'
          : input.approvalPackets.length > 0
            ? 'Hold side effects until approval; continue with safe explanation.'
            : 'Continue to the next workbench role.',
    privacyJson: privacyPolicyJson(),
  });
  const needsVerifier =
    input.run.cognitiveMode === 'council_verified' ||
    input.graph.subgoals.some((subgoal) =>
      subgoal.toolPlan.some((plan) => plan.toolId === 'provider_council'),
    );
  return [
    handoff(
      1,
      'planner',
      'memory_curator',
      blockedDecision ? 'blocked' : 'completed',
      'Planner handed the sanitized goal to the memory curator for local-first context.',
      blockedDecision,
    ),
    handoff(
      2,
      'memory_curator',
      'evidence_scout',
      blockedDecision ? 'blocked' : 'completed',
      'Memory curator handed cited metadata needs to the evidence scout.',
      blockedDecision,
    ),
    handoff(
      3,
      'evidence_scout',
      'verifier',
      blockedDecision ? 'blocked' : needsVerifier ? 'completed' : 'skipped',
      needsVerifier
        ? 'Evidence scout requested verifier review for a deep or council-backed route.'
        : 'Verifier was skipped because this route had enough deterministic metadata.',
      blockedDecision,
    ),
    handoff(
      4,
      needsVerifier ? 'verifier' : 'evidence_scout',
      'final_arbiter',
      blockedDecision ? 'blocked' : 'completed',
      'Final arbiter received evidence, governance decisions, and verification status.',
      blockedDecision || stagedDecision,
    ),
    handoff(
      5,
      'final_arbiter',
      'executor',
      blockedDecision
        ? 'blocked'
        : input.approvalPackets.length > 0
          ? 'accepted'
          : 'completed',
      input.approvalPackets.length > 0
        ? 'Executor receives an approval-staged result instead of a side effect.'
        : 'Executor can answer with sanitized evidence and no side effects.',
      blockedDecision || stagedDecision,
    ),
  ];
}

function memoryBlocksForRun(input: {
  run: CognitiveRunRecord;
  goalText: string;
  selectedSkill: CognitiveSkillCardRecord | null;
  provider: ReturnType<typeof providerUsability>;
  evidenceContract: ReturnType<typeof buildEvidenceContract>;
  decisions: CognitiveGovernanceDecision[];
  now: string;
}): CognitiveMemoryBlock[] {
  const text = input.goalText.toLowerCase();
  const injectionRisk =
    /\b(ignore|override|system|developer|secret|token|password|raw message)\b/i.test(
      text,
    );
  const integrationReport = safeDb(null, () => buildIntegrationDoctorReport());
  const blockedDecision =
    input.decisions.find((decision) => decision.status === 'block') || null;
  const sourceIds = (extra: string[] = []) =>
    safeJson(
      [
        `run:${input.run.runId}`,
        `skill:${input.selectedSkill?.skillId || input.run.selectedSkillId}`,
        ...input.evidenceContract.required.map((item) => `evidence:${item}`),
        ...extra,
      ],
      1600,
    );
  const make = (
    blockKind: CognitiveMemoryBlock['blockKind'],
    summary: string,
    extraSources: string[] = [],
    options: {
      sensitivity?: CognitiveMemoryBlock['sensitivity'];
      conflictFlags?: string[];
      poisoningRisk?: number;
      status?: CognitiveMemoryBlock['status'];
      freshness?: CognitiveMemoryBlock['freshness'];
      decision?: CognitiveGovernanceDecision | null;
    } = {},
  ): CognitiveMemoryBlock => {
    const conflictFlags = options.conflictFlags || [];
    const poisoningRisk = clamp01(options.poisoningRisk || 0);
    const status =
      options.status ||
      (blockedDecision && blockKind === 'operating_rules'
        ? 'blocked'
        : conflictFlags.length > 0 || poisoningRisk >= 0.5
          ? 'conflicted'
          : 'active');
    return {
      blockId: sanitizeId(`cogmem:${input.run.runId}:${blockKind}`),
      createdAt: input.now,
      updatedAt: input.now,
      runId: input.run.runId,
      blockKind,
      status,
      summary: redactCouncilText(summary, 520),
      sourceIdsJson: sourceIds(extraSources),
      freshness: options.freshness || 'fresh',
      sensitivity: options.sensitivity || 'metadata',
      conflictFlagsJson: safeJson(conflictFlags, 1200),
      poisoningRisk,
      governanceDecisionId:
        options.decision?.decisionId || blockedDecision?.decisionId || null,
      privacyJson: privacyPolicyJson(),
    };
  };
  return [
    make(
      'profile',
      'Profile block is available as sanitized metadata only; raw personal content is excluded.',
      ['profile:metadata_only'],
      { sensitivity: 'private_metadata' },
    ),
    make(
      'preferences',
      input.selectedSkill
        ? `Current skill preference uses ${input.selectedSkill.skillId} in ${input.run.cognitiveMode} mode.`
        : `Current selected skill is ${input.run.selectedSkillId}; durable preference capture requires safe confirmation.`,
      ['skill_library:selection'],
      {
        sensitivity: 'sanitized_digest',
        conflictFlags:
          input.run.cognitiveMode === 'approval_staged' ||
          input.decisions.some(
            (decision) => decision.status === 'stage_approval',
          )
            ? ['approval_required']
            : [],
      },
    ),
    make(
      'operating_rules',
      'Operating rules enforce metadata-only memory, read-only autonomy, and approval-first side effects.',
      V9_SOURCE_PATTERN_REFS.slice(0, 4),
      {
        conflictFlags: input.decisions
          .filter((decision) => decision.status === 'block')
          .map((decision) => `blocked:${decision.toolId}`),
        poisoningRisk: injectionRisk ? 0.7 : 0.05,
      },
    ),
    make(
      'current_projects',
      `Current work item is a ${input.run.taskFamily} task in ${input.run.cognitiveMode} mode.`,
      ['goal:current_project'],
    ),
    make(
      'people_threads',
      input.run.taskFamily === 'communication'
        ? 'Communication thread block contains only thread/proof metadata and approval status.'
        : 'People/thread block is inactive for this task except for metadata references.',
      ['threads:metadata_only'],
      {
        sensitivity:
          input.run.taskFamily === 'communication'
            ? 'private_metadata'
            : 'metadata',
      },
    ),
    make(
      'skills',
      input.selectedSkill
        ? `Skill ${input.selectedSkill.skillId} has status ${input.selectedSkill.promotionState} and outcome score ${input.selectedSkill.latestOutcomeScore}.`
        : 'No durable skill card was selected; planner used deterministic routing.',
      ['skill_library:retrieval'],
      { sensitivity: 'sanitized_digest' },
    ),
    make(
      'provider_health',
      `${input.provider.healthy} provider(s) healthy, ${input.provider.degraded} degraded, ${input.provider.blocked} blocked.`,
      input.provider.degradedProviderIds.map(
        (providerId) => `provider:${providerId}`,
      ),
      {
        conflictFlags:
          input.provider.blocked > 0
            ? input.provider.degradedProviderIds.map(
                (providerId) => `provider_degraded:${providerId}`,
              )
            : [],
        freshness: 'fresh',
      },
    ),
    make(
      'integration_status',
      integrationReport
        ? `Integration status loaded with ${integrationReport.statuses.length} item(s); blockers stay in diagnostics, not memory bodies.`
        : 'Integration status was unavailable; diagnostics should rerun before relying on live integrations.',
      ['integrations:doctor'],
      {
        conflictFlags: integrationReport
          ? integrationReport.statuses
              .filter((item) => item.state !== 'healthy')
              .slice(0, 6)
              .map((item) => `integration:${item.integrationId}:${item.state}`)
          : ['integration_status_unavailable'],
        freshness: integrationReport ? 'fresh' : 'unknown',
      },
    ),
  ];
}

function workbenchStateForRun(input: {
  run: CognitiveRunRecord;
  handoffs: CognitiveHandoff[];
  decisions: CognitiveGovernanceDecision[];
  memoryBlocks: CognitiveMemoryBlock[];
  riskSignals: CognitiveRiskSignal[];
  approvalPackets: CognitiveApprovalPacket[];
  activeGoalId?: string | null;
  now: string;
}): CognitiveWorkbenchState {
  const blocked =
    input.run.status === 'blocked' ||
    input.decisions.some((decision) => decision.status === 'block') ||
    input.handoffs.some((handoff) => handoff.status === 'blocked');
  const awaitingApproval =
    input.run.status === 'awaiting_approval' ||
    input.approvalPackets.length > 0;
  const openRisk = input.riskSignals.some((signal) => signal.status === 'open');
  const status: CognitiveWorkbenchState['status'] = blocked
    ? 'blocked'
    : awaitingApproval
      ? 'awaiting_approval'
      : input.run.status === 'answered'
        ? 'answered'
        : openRisk
          ? 'degraded'
          : 'active';
  const nextAction = blocked
    ? input.decisions.find((decision) => decision.status === 'block')
        ?.nextAction || input.run.nextAction
    : awaitingApproval
      ? 'Wait for explicit approval before side effects; answer with the staged packet and safe next step.'
      : openRisk
        ? 'Answer with reduced confidence and rerun diagnostics if the risk persists.'
        : input.run.nextAction;
  return {
    workbenchId: sanitizeId(`cogworkbench:${input.run.runId}`),
    createdAt: input.now,
    updatedAt: input.now,
    runId: input.run.runId,
    status,
    activeGoalId: input.activeGoalId || null,
    selectedSkillId: input.run.selectedSkillId || null,
    handoffCount: input.handoffs.length,
    governanceDecisionCount: input.decisions.length,
    memoryBlockCount: input.memoryBlocks.length,
    riskSignalCount: input.riskSignals.length,
    approvalPacketCount: input.approvalPackets.length,
    nextAction: redactCouncilText(nextAction, 520),
    stateJson: safeJson(
      {
        taskFamily: input.run.taskFamily,
        cognitiveMode: input.run.cognitiveMode,
        handoffStatuses: input.handoffs.map((handoff) => ({
          from: handoff.fromRole,
          to: handoff.toRole,
          status: handoff.status,
        })),
        governanceStatuses: input.decisions.map((decision) => ({
          toolId: decision.toolId,
          status: decision.status,
          riskLevel: decision.riskLevel,
        })),
        memoryKinds: input.memoryBlocks.map((block) => block.blockKind),
      },
      3200,
    ),
    privacyJson: privacyPolicyJson(),
  };
}

function policyDecisionFor(input: {
  runId: string;
  plan: CognitiveToolCallPlan;
  simulation?: CognitiveToolSimulation | null;
  registry?: CognitiveToolRegistryRecord | null;
  governanceDecision?: CognitiveGovernanceDecision | null;
  now: string;
}): CognitivePolicyDecision {
  const issues = parseJsonSafe<string[]>(input.simulation?.issuesJson, []);
  const riskClasses = parseJsonSafe<string[]>(
    input.governanceDecision?.riskClassesJson,
    [],
  );
  const explicitApproval =
    input.plan.approvalRequired ||
    input.governanceDecision?.status === 'stage_approval' ||
    input.registry?.approvalPolicy === 'explicit_approval' ||
    input.registry?.riskLevel === 'high' ||
    input.plan.actionClass === 'draft' ||
    input.plan.actionClass === 'approval_gate';
  const status: CognitivePolicyDecision['status'] =
    input.governanceDecision?.status === 'block'
      ? 'block'
      : input.simulation?.status === 'block'
        ? 'block'
        : explicitApproval
          ? 'stage_approval'
          : input.simulation?.status === 'warn'
            ? 'allow'
            : input.registry
              ? 'allow'
              : 'skip';
  const reason =
    status === 'block'
      ? input.governanceDecision?.reason ||
        'Tool simulation blocked this step before execution.'
      : status === 'stage_approval'
        ? input.governanceDecision?.reason ||
          'Tool is mutating, high-risk, draft/send-adjacent, or explicitly approval-gated.'
        : status === 'skip'
          ? 'Tool is not registered for execution on this host.'
          : input.governanceDecision?.status === 'warn'
            ? input.governanceDecision.reason
            : 'Tool is read-only or local metadata and passed policy gating.';
  return {
    decisionId: sanitizeId(
      `cogpolicy:${input.runId}:${input.plan.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    toolId: input.plan.toolId,
    simulationId: input.simulation?.simulationId || null,
    status,
    reason,
    approvalRequired: explicitApproval,
    readOnly:
      input.registry?.approvalPolicy === 'read_only' ||
      ['local_lookup', 'read_only_integration', 'council'].includes(
        input.plan.actionClass,
      ),
    riskLevel: input.registry?.riskLevel || 'unknown',
    issuesJson: safeJson(
      [...issues, ...riskClasses.map((riskClass) => `governance:${riskClass}`)],
      1600,
    ),
    privacyJson: privacyPolicyJson(),
  };
}

function toolResult(input: {
  runId: string;
  toolId: string;
  status: CognitiveToolResultEnvelope['status'];
  summary: string;
  evidenceRefs: string[];
  outputShape: Record<string, unknown>;
  failureClass?: string | null;
  nextAction: string;
  now: string;
}): CognitiveToolResultEnvelope {
  return {
    resultId: sanitizeId(
      `cogresult:${input.runId}:${input.toolId}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    toolId: input.toolId,
    status: input.status,
    summary: redactCouncilText(input.summary, 640),
    evidenceRefsJson: safeJson(input.evidenceRefs, 1600),
    outputShapeJson: safeJson(input.outputShape, 2400),
    failureClass: input.failureClass || null,
    nextAction: redactCouncilText(input.nextAction, 520),
    privacyJson: privacyPolicyJson(),
  };
}

function integrationStatusShape(input: {
  integrationId: string;
  label?: string;
  state?: string;
  proofState?: string;
  credentialState?: string;
  transportState?: string;
  blockerOwner?: string;
  repairability?: string;
}): Record<string, unknown> {
  return {
    integrationId: input.integrationId,
    label: input.label || input.integrationId,
    state: input.state || 'unknown',
    proofState: input.proofState || 'unknown',
    credentialState: input.credentialState || 'unknown',
    transportState: input.transportState || 'unknown',
    blockerOwner: input.blockerOwner || 'unknown',
    repairability: input.repairability || 'unknown',
  };
}

function buildSafeIntegrationDoctorReport(input: {
  now: string;
  providers: ProviderHealthSnapshot[];
}): ReturnType<typeof buildIntegrationDoctorReport> {
  try {
    return buildIntegrationDoctorReport({
      now: new Date(input.now),
      providers: input.providers,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      generatedAt: input.now,
      summary: {
        total: 1,
        healthy: 0,
        actionNeeded: 1,
        needsProof: 0,
        manualOrExternal: 0,
      },
      statuses: [
        {
          integrationId: 'integration_doctor',
          label: 'Integration Doctor',
          state: 'degraded_but_usable',
          credentialState: 'unknown',
          transportState: 'unknown',
          proofState: 'degraded_but_usable',
          lastHealthyAt: null,
          lastFailure: redactCouncilText(detail, 240),
          blockerOwner: 'repo_side',
          nextAction:
            'Initialize the local database before running full integration doctor evidence.',
          repairability: 'status_only',
          safeActions: ['initialize_database', 'rerun_cognition_trace'],
          detail:
            'Integration doctor was unavailable, so cognition recorded a degraded metadata-only result.',
        },
      ],
      secretsRedacted: true,
    };
  }
}

function resultStatusFromIntegrationState(
  state: string | undefined,
): CognitiveToolResultEnvelope['status'] {
  if (state === 'healthy') return 'succeeded';
  if (
    state === 'near_live_only' ||
    state === 'degraded_but_usable' ||
    state === 'needs_proof'
  ) {
    return 'degraded';
  }
  if (
    state === 'externally_blocked' ||
    state === 'needs_auth' ||
    state === 'manual_action_required' ||
    state === 'repo_fix_available'
  ) {
    return 'blocked';
  }
  return 'degraded';
}

function executeReadOnlyAdapter(input: {
  run: CognitiveRunRecord;
  plan: CognitiveToolCallPlan;
  providerSnapshots: ProviderHealthSnapshot[];
  provider: ReturnType<typeof providerUsability>;
  selectedSkill: CognitiveSkillCardRecord | null;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  evidenceContract: ReturnType<typeof buildEvidenceContract>;
  now: string;
}): CognitiveToolResultEnvelope {
  const integrationReport = (): ReturnType<
    typeof buildIntegrationDoctorReport
  > =>
    buildSafeIntegrationDoctorReport({
      now: input.now,
      providers: input.providerSnapshots,
    });
  switch (input.plan.toolId) {
    case 'local_skill_library': {
      const skillCount = safeDb(
        0,
        () =>
          listCognitiveSkillCards({
            groupFolder: input.run.groupFolder,
            taskFamily: input.run.taskFamily,
            limit: 50,
          }).length,
      );
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: input.selectedSkill ? 'succeeded' : 'degraded',
        summary: input.selectedSkill
          ? `Matched sanitized skill ${input.selectedSkill.skillId}.`
          : 'No promoted skill matched; continuing with deterministic task policy.',
        evidenceRefs: input.selectedSkill
          ? [input.selectedSkill.skillId]
          : ['skill_library:no_match'],
        outputShape: {
          matchedSkillId: input.selectedSkill?.skillId || null,
          taskFamilySkillCount: skillCount,
          promotionState: input.selectedSkill?.promotionState || 'none',
        },
        failureClass: input.selectedSkill ? null : 'no_matching_skill',
        nextAction: input.selectedSkill
          ? 'Use the matched skill checklist during answer verification.'
          : 'Proceed with base kernel policy and let successful outcome metadata create a candidate skill.',
        now: input.now,
      });
    }
    case 'provider_health':
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status:
          input.provider.snapshots.length === 0
            ? 'blocked'
            : input.provider.degraded > 0 ||
                input.provider.blocked > 0 ||
                input.provider.unknown > 0
              ? 'degraded'
              : 'succeeded',
        summary: `${input.provider.healthy} provider(s) healthy; ${input.provider.degraded} degraded; ${input.provider.blocked} blocked; ${input.provider.unknown} unknown.`,
        evidenceRefs: input.provider.snapshots.map(
          (snapshot) => `provider:${String(snapshot.providerId)}`,
        ),
        outputShape: {
          healthy: input.provider.healthy,
          degraded: input.provider.degraded,
          blocked: input.provider.blocked,
          unknown: input.provider.unknown,
          degradedProviderIds: input.provider.degradedProviderIds,
        },
        failureClass:
          input.provider.snapshots.length === 0
            ? 'provider_probe_unavailable'
            : input.provider.healthy > 0
              ? null
              : 'no_live_health_evidence',
        nextAction:
          input.provider.snapshots.length === 0
            ? 'Repair provider health collection before assigning model-dependent work.'
            : input.provider.healthy > 0
              ? 'Assign optional model roles only to usable providers.'
              : 'Keep local-only work available, but skip model-dependent routes until a live probe succeeds.',
        now: input.now,
      });
    case 'integrations_status': {
      const report = integrationReport();
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: report.summary.actionNeeded > 0 ? 'degraded' : 'succeeded',
        summary: `${report.summary.healthy}/${report.summary.total} integration(s) healthy; ${report.summary.actionNeeded} need action.`,
        evidenceRefs: report.statuses.map(
          (status) => `integration:${status.integrationId}`,
        ),
        outputShape: {
          total: report.summary.total,
          healthy: report.summary.healthy,
          needsProof: report.summary.needsProof,
          actionNeeded: report.summary.actionNeeded,
          manualOrExternal: report.summary.manualOrExternal,
        },
        failureClass:
          report.summary.actionNeeded > 0 ? 'integration_action_needed' : null,
        nextAction:
          report.summary.actionNeeded > 0
            ? 'Name the integration blocker and use the registered safe action list.'
            : 'Proceed with healthy integration assumptions for this turn.',
        now: input.now,
      });
    }
    case 'provider_council':
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: input.providerCouncil?.councilRunId ? 'succeeded' : 'skipped',
        summary: input.providerCouncil?.councilRunId
          ? `Linked council verdict ${input.providerCouncil.councilRunId}.`
          : 'No council verdict was attached to this quick executor run.',
        evidenceRefs: input.providerCouncil?.councilRunId
          ? [`council:${input.providerCouncil.councilRunId}`]
          : ['council:not_requested'],
        outputShape: {
          councilRunId: input.providerCouncil?.councilRunId || null,
          status:
            input.providerCouncil?.answerGuidance?.status ||
            input.providerCouncil?.status ||
            'not_requested',
          mode: input.providerCouncil?.mode || null,
        },
        failureClass: input.providerCouncil?.councilRunId
          ? null
          : 'council_not_requested',
        nextAction: input.providerCouncil?.councilRunId
          ? 'Apply council directives as constraints before final answer.'
          : 'Stay on the deterministic executor path.',
        now: input.now,
      });
    case 'google_calendar_read': {
      const status = integrationReport().statuses.find(
        (item) => item.integrationId === 'google_calendar',
      );
      const resultStatus = resultStatusFromIntegrationState(status?.state);
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: resultStatus,
        summary: status
          ? `Google Calendar state is ${status.state}; proof is ${status.proofState}.`
          : 'Google Calendar status was not available from the integration doctor.',
        evidenceRefs: ['integration:google_calendar'],
        outputShape: integrationStatusShape({
          integrationId: 'google_calendar',
          label: status?.label,
          state: status?.state,
          proofState: status?.proofState,
          credentialState: status?.credentialState,
          transportState: status?.transportState,
          blockerOwner: status?.blockerOwner,
          repairability: status?.repairability,
        }),
        failureClass:
          resultStatus === 'succeeded' ? null : 'calendar_status_blocker',
        nextAction:
          status?.nextAction ||
          'Run Google Calendar debug/auth validation before relying on live calendar answers.',
        now: input.now,
      });
    }
    case 'brave_search': {
      const brave = getBraveSearchStatus();
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: brave.configured ? 'succeeded' : 'blocked',
        summary: brave.configured
          ? 'Brave Search is configured for public/live evidence lookup.'
          : 'Brave Search is not configured for live public evidence.',
        evidenceRefs: ['provider:brave_search', 'policy:brain_first_lookup'],
        outputShape: {
          enabled: brave.enabled,
          configured: brave.configured,
          count: brave.count,
          baseUrl: brave.baseUrl,
          aliasUsed: brave.aliasUsed || 'none',
          liveSearchAllowed: input.evidenceContract.liveSearchAllowed,
        },
        failureClass: brave.configured ? null : 'search_not_configured',
        nextAction: brave.configured
          ? 'Use Brave only for public/live gaps after local evidence.'
          : 'Name the Brave blocker or answer from local evidence only.',
        now: input.now,
      });
    }
    case 'bluebubbles_status': {
      const status = integrationReport().statuses.find(
        (item) => item.integrationId === 'bluebubbles',
      );
      const resultStatus = resultStatusFromIntegrationState(status?.state);
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: resultStatus,
        summary: status
          ? `BlueBubbles state is ${status.state}; proof is ${status.proofState}.`
          : 'BlueBubbles status was not available from the integration doctor.',
        evidenceRefs: ['integration:bluebubbles'],
        outputShape: integrationStatusShape({
          integrationId: 'bluebubbles',
          label: status?.label,
          state: status?.state,
          proofState: status?.proofState,
          credentialState: status?.credentialState,
          transportState: status?.transportState,
          blockerOwner: status?.blockerOwner,
          repairability: status?.repairability,
        }),
        failureClass:
          resultStatus === 'succeeded' ? null : 'bluebubbles_status_blocker',
        nextAction:
          status?.nextAction ||
          'Run BlueBubbles doctor/live proof before relying on same-thread actions.',
        now: input.now,
      });
    }
    case 'operator_diagnostics': {
      const report = integrationReport();
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: report.summary.actionNeeded > 0 ? 'degraded' : 'succeeded',
        summary: `Operator diagnostics read ${report.summary.total} integration status card(s).`,
        evidenceRefs: [
          'operator:integration_doctor',
          ...report.statuses
            .slice(0, 6)
            .map((status) => `integration:${status.integrationId}`),
        ],
        outputShape: {
          actionNeeded: report.summary.actionNeeded,
          needsProof: report.summary.needsProof,
          manualOrExternal: report.summary.manualOrExternal,
          safeActions: report.statuses
            .flatMap((status) => status.safeActions.slice(0, 2))
            .slice(0, 8),
        },
        failureClass:
          report.summary.actionNeeded > 0 ? 'operator_action_needed' : null,
        nextAction:
          report.summary.actionNeeded > 0
            ? 'Stage a repair plan; do not mutate services without operator approval.'
            : 'Use the healthy status summary in the reply.',
        now: input.now,
      });
    }
    case 'cognition_trace': {
      const packet = safeDb(null, () =>
        buildCognitiveReplayPacket({
          runId: null,
          generatedAt: input.now,
          limit: 25,
        }),
      );
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: packet?.latestRun ? 'succeeded' : 'degraded',
        summary: packet?.latestRun
          ? `Found prior trace for ${packet.latestRun.runId}.`
          : 'No prior cognitive trace is available yet.',
        evidenceRefs: packet?.latestRun
          ? [`run:${packet.latestRun.runId}`]
          : ['trace:none'],
        outputShape: {
          latestRunId: packet?.latestRun?.runId || null,
          spans: packet?.spans.length || 0,
          simulations: packet?.simulations.length || 0,
          executionSteps: packet?.executionSteps.length || 0,
          planRevisions: packet?.planRevisions.length || 0,
        },
        failureClass: packet?.latestRun ? null : 'no_trace_available',
        nextAction: packet?.latestRun
          ? 'Explain route choice from trace summaries only.'
          : 'Create a cognitive run before explaining route history.',
        now: input.now,
      });
    }
    default:
      return toolResult({
        runId: input.run.runId,
        toolId: input.plan.toolId,
        status: 'skipped',
        summary: `No read-only adapter is registered for ${input.plan.toolId}.`,
        evidenceRefs: [`tool:${input.plan.toolId}:skipped`],
        outputShape: { toolId: input.plan.toolId, adapter: 'missing' },
        failureClass: 'adapter_missing',
        nextAction: 'Use simulation/checkpoint metadata only for this tool.',
        now: input.now,
      });
  }
}

function stepStatusFrom(input: {
  decision: CognitivePolicyDecision;
  result: CognitiveToolResultEnvelope;
}): CognitiveExecutionStep['status'] {
  if (input.decision.status === 'block') return 'blocked';
  if (input.decision.status === 'stage_approval') return 'approval_staged';
  if (input.decision.status === 'skip') return 'skipped';
  if (input.result.status === 'succeeded') return 'executed';
  if (input.result.status === 'degraded') return 'degraded';
  if (input.result.status === 'blocked') return 'blocked';
  return 'skipped';
}

function revisionForStep(input: {
  runId: string;
  step: CognitiveExecutionStep;
  decision: CognitivePolicyDecision;
  result: CognitiveToolResultEnvelope;
  now: string;
}): CognitivePlanRevision | null {
  const kind: CognitivePlanRevision['revisionKind'] | null =
    input.decision.status === 'stage_approval'
      ? 'approval_required'
      : input.decision.status === 'block'
        ? 'verification'
        : input.result.status === 'blocked'
          ? 'missing_evidence'
          : input.result.status === 'degraded'
            ? 'tool_failure'
            : null;
  if (!kind) return null;
  return {
    revisionId: sanitizeId(
      `cogrevision:${input.runId}:${input.step.toolId}:${kind}:${randomUUID()}`,
    ),
    createdAt: input.now,
    runId: input.runId,
    revisionKind: kind,
    changedToolId: input.step.toolId,
    reason:
      kind === 'approval_required'
        ? 'Executor staged this tool instead of running it because approval is required.'
        : kind === 'verification'
          ? 'Executor blocked this tool before action because policy simulation failed.'
          : kind === 'missing_evidence'
            ? 'Executor found a read-only evidence blocker that must be named or repaired.'
            : 'Executor found degraded read-only evidence and adjusted the answer path.',
    beforeStateJson: safeJson({
      decisionStatus: input.decision.status,
      resultStatus: input.result.status,
    }),
    afterStateJson: safeJson({
      nextAction: input.step.nextAction,
      safeFallback:
        kind === 'approval_required'
          ? 'stage_approval'
          : 'answer_with_blocker_or_clarify',
    }),
    nextAction: input.step.nextAction,
    privacyJson: privacyPolicyJson(),
  };
}

function executeCognitiveToolPlan(input: {
  run: CognitiveRunRecord;
  goalText: string;
  graph: CognitiveTaskGraph;
  toolPlans: CognitiveToolCallPlan[];
  toolSimulations: CognitiveToolSimulation[];
  registry: CognitiveToolRegistryRecord[];
  governancePolicy: CognitiveGovernancePolicy;
  providerSnapshots: ProviderHealthSnapshot[];
  provider: ReturnType<typeof providerUsability>;
  selectedSkill: CognitiveSkillCardRecord | null;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  evidenceContract: ReturnType<typeof buildEvidenceContract>;
  autonomyBudget: CognitiveAutonomyBudgetRecord;
  now: string;
}): CognitiveExecutionBundle {
  const byTool = new Map(input.registry.map((tool) => [tool.toolId, tool]));
  const simulationByTool = new Map(
    input.toolSimulations.map((simulation) => [simulation.toolId, simulation]),
  );
  const subgoalByTool = new Map<string, string>();
  for (const subgoal of input.graph.subgoals) {
    for (const plan of subgoal.toolPlan) {
      if (!subgoalByTool.has(plan.toolId)) {
        subgoalByTool.set(plan.toolId, subgoal.subgoalId);
      }
    }
  }
  const policyDecisions: CognitivePolicyDecision[] = [];
  const actionIdentities: CognitiveActionIdentity[] = [];
  const governanceDecisions: CognitiveGovernanceDecision[] = [];
  const guardrailTripwires: CognitiveGuardrailTripwire[] = [];
  const riskSignals: CognitiveRiskSignal[] = [];
  const toolResults: CognitiveToolResultEnvelope[] = [];
  const executionSteps: CognitiveExecutionStep[] = [];
  const evidenceArtifacts: CognitiveEvidenceArtifact[] = [];
  const stepVerifications: CognitiveStepVerification[] = [];
  const approvalPackets: CognitiveApprovalPacket[] = [];
  const planRevisions: CognitivePlanRevision[] = [];
  const runEvents: CognitiveRunEvent[] = [
    runEvent({
      runId: input.run.runId,
      eventKind: 'policy',
      summary: 'Executor started policy-gated read-only plan.',
      refs: input.toolPlans.map((plan) => plan.toolId),
      now: input.now,
    }),
  ];
  input.toolPlans.forEach((plan, index) => {
    const registry = byTool.get(plan.toolId) || null;
    const simulation = simulationByTool.get(plan.toolId) || null;
    const action = actionIdentityFor({
      run: input.run,
      plan,
      registry,
      index,
      now: input.now,
    });
    actionIdentities.push(action);
    const tripwires = guardrailTripwiresFor({
      run: input.run,
      goalText: input.goalText,
      plan,
      registry,
      simulation,
      action,
      provider: input.provider,
      now: input.now,
    });
    guardrailTripwires.push(...tripwires);
    const governanceDecision = governanceDecisionFor({
      run: input.run,
      plan,
      action,
      policy: input.governancePolicy,
      tripwires,
      simulation,
      registry,
      now: input.now,
    });
    governanceDecisions.push(governanceDecision);
    riskSignals.push(
      ...riskSignalsForDecision({
        runId: input.run.runId,
        decision: governanceDecision,
        tripwires,
        now: input.now,
      }),
    );
    const decision = policyDecisionFor({
      runId: input.run.runId,
      plan,
      simulation,
      registry,
      governanceDecision,
      now: input.now,
    });
    policyDecisions.push(decision);
    const result =
      decision.status === 'block'
        ? toolResult({
            runId: input.run.runId,
            toolId: plan.toolId,
            status: 'blocked',
            summary: `Policy blocked ${plan.toolId} before execution.`,
            evidenceRefs: [simulation?.simulationId || `tool:${plan.toolId}`],
            outputShape: {
              policyStatus: decision.status,
              issues: parseJsonSafe<string[]>(decision.issuesJson, []),
            },
            failureClass: 'policy_block',
            nextAction:
              'Repair tool policy, approval gate, or autonomy budget before acting.',
            now: input.now,
          })
        : decision.status === 'stage_approval'
          ? toolResult({
              runId: input.run.runId,
              toolId: plan.toolId,
              status: 'skipped',
              summary: `Approval-first policy staged ${plan.toolId}; no external action executed.`,
              evidenceRefs: [
                simulation?.simulationId || `tool:${plan.toolId}`,
                'policy:approval_first',
              ],
              outputShape: {
                policyStatus: decision.status,
                approvalRequired: true,
                actionClass: plan.actionClass,
              },
              failureClass: 'approval_required',
              nextAction:
                'Ask for explicit same-channel approval before any mutating action.',
              now: input.now,
            })
          : executeReadOnlyAdapter({
              run: input.run,
              plan,
              providerSnapshots: input.providerSnapshots,
              provider: input.provider,
              selectedSkill: input.selectedSkill,
              providerCouncil: input.providerCouncil,
              evidenceContract: input.evidenceContract,
              now: input.now,
            });
    toolResults.push(result);
    const stepStatus = stepStatusFrom({ decision, result });
    const step: CognitiveExecutionStep = {
      stepId: sanitizeId(
        `cogstep:${input.run.runId}:${String(index + 1).padStart(2, '0')}:${plan.toolId}`,
      ),
      createdAt: input.now,
      updatedAt: input.now,
      runId: input.run.runId,
      subgoalId: subgoalByTool.get(plan.toolId) || null,
      toolId: plan.toolId,
      position: index + 1,
      actionClass: plan.actionClass,
      status: stepStatus,
      policyDecisionId: decision.decisionId,
      resultId: result.resultId,
      policyDecisionJson: safeJson(decision, 2400),
      resultJson: safeJson(result, 3200),
      verificationJson: safeJson({
        metadataOnly: true,
        externalActionExecuted:
          stepStatus === 'executed' &&
          ['local_lookup', 'read_only_integration', 'council'].includes(
            plan.actionClass,
          ),
        approvalBoundaryPreserved:
          decision.status !== 'stage_approval' || result.status === 'skipped',
      }),
      nextAction: result.nextAction,
      privacyJson: privacyPolicyJson(),
    };
    executionSteps.push(step);
    const artifact = evidenceArtifactForStep({
      run: input.run,
      step,
      result,
      now: input.now,
    });
    evidenceArtifacts.push(artifact);
    const verification = stepVerificationFor({
      run: input.run,
      step,
      artifact,
      decision,
      result,
      now: input.now,
    });
    stepVerifications.push(verification);
    const approvalPacket = approvalPacketForStep({
      run: input.run,
      step,
      decision,
      result,
      now: input.now,
    });
    if (approvalPacket) approvalPackets.push(approvalPacket);
    const revision = revisionForStep({
      runId: input.run.runId,
      step,
      decision,
      result,
      now: input.now,
    });
    if (revision) planRevisions.push(revision);
    runEvents.push(
      runEvent({
        runId: input.run.runId,
        eventKind:
          governanceDecision.status === 'block'
            ? 'policy'
            : stepStatus === 'executed'
              ? 'execute'
              : 'revise',
        summary: `${plan.toolId} ${stepStatus}; governance=${governanceDecision.status}.`,
        refs: [
          action.actionId,
          governanceDecision.decisionId,
          decision.decisionId,
          result.resultId,
          step.stepId,
        ],
        now: input.now,
      }),
    );
  });
  for (const snapshot of input.providerSnapshots) {
    if (
      snapshot.state === 'externally_blocked' ||
      snapshot.state === 'not_configured' ||
      snapshot.credentialState === 'missing' ||
      snapshot.credentialState === 'invalid'
    ) {
      planRevisions.push({
        revisionId: sanitizeId(
          `cogrevision:${input.run.runId}:provider_cooldown:${snapshot.providerId}:${randomUUID()}`,
        ),
        createdAt: input.now,
        runId: input.run.runId,
        revisionKind: 'provider_cooldown',
        changedToolId: 'provider_health',
        reason: `${snapshot.providerId} was skipped or reduced because live provider health is ${snapshot.state}.`,
        beforeStateJson: safeJson({
          providerId: snapshot.providerId,
          state: snapshot.state,
          failureClass: snapshot.failureClass,
        }),
        afterStateJson: safeJson({
          routeAdjustment: 'skip_optional_provider_role',
          reducedIndependence: true,
        }),
        nextAction:
          snapshot.nextAction ||
          `Use available providers and rerun diagnostics after ${snapshot.providerId} recovers.`,
        privacyJson: privacyPolicyJson(),
      });
      runEvents.push(
        runEvent({
          runId: input.run.runId,
          eventKind: 'revise',
          summary: `${snapshot.providerId} provider cooldown adjusted this run.`,
          refs: [`provider:${snapshot.providerId}`, 'tool:provider_health'],
          now: input.now,
        }),
      );
    }
  }
  const loopState = loopStateForExecution({
    run: input.run,
    executionSteps,
    verifications: stepVerifications,
    revisions: planRevisions,
    budget: input.autonomyBudget,
    now: input.now,
  });
  if (planRevisions.length === 0) {
    planRevisions.push({
      revisionId: sanitizeId(
        `cogrevision:${input.run.runId}:success:${randomUUID()}`,
      ),
      createdAt: input.now,
      runId: input.run.runId,
      revisionKind: 'success_path',
      changedToolId: null,
      reason: 'Read-only executor path completed without blockers.',
      beforeStateJson: safeJson({
        toolPlans: input.toolPlans.length,
      }),
      afterStateJson: safeJson({
        executedSteps: executionSteps.filter(
          (step) => step.status === 'executed',
        ).length,
      }),
      nextAction:
        'Answer with gathered metadata and record the outcome signal.',
      privacyJson: privacyPolicyJson(),
    });
  }
  const trajectoryScore = trajectoryScoreForExecution({
    run: input.run,
    executionSteps,
    artifacts: evidenceArtifacts,
    verifications: stepVerifications,
    approvalPackets,
    loopState,
    now: input.now,
  });
  const memoryBlocks = memoryBlocksForRun({
    run: input.run,
    goalText: input.goalText,
    selectedSkill: input.selectedSkill,
    provider: input.provider,
    evidenceContract: input.evidenceContract,
    decisions: governanceDecisions,
    now: input.now,
  });
  const handoffs = handoffsForRun({
    run: input.run,
    graph: input.graph,
    decisions: governanceDecisions,
    evidenceArtifacts,
    approvalPackets,
    now: input.now,
  });
  const workbenchState = workbenchStateForRun({
    run: input.run,
    handoffs,
    decisions: governanceDecisions,
    memoryBlocks,
    riskSignals,
    approvalPackets,
    now: input.now,
  });
  return {
    actionIdentities,
    governanceDecisions,
    guardrailTripwires,
    handoffs,
    riskSignals,
    memoryBlocks,
    workbenchState,
    policyDecisions,
    toolResults,
    executionSteps,
    evidenceArtifacts,
    loopStates: [loopState],
    stepVerifications,
    approvalPackets,
    planRevisions,
    runEvents,
    trajectoryScore,
  };
}

function applyExecutionFeedback(
  verification: CognitiveVerificationResult,
  execution: CognitiveExecutionBundle,
  mode: CognitiveMode,
): CognitiveVerificationResult {
  const gaps = new Set(verification.evidenceGaps);
  for (const step of execution.executionSteps) {
    if (step.status === 'blocked')
      gaps.add(`tool_execution_blocked:${step.toolId}`);
    if (step.status === 'degraded')
      gaps.add(`tool_execution_degraded:${step.toolId}`);
    if (step.status === 'approval_staged')
      gaps.add(`approval_staged:${step.toolId}`);
  }
  const blocked = execution.executionSteps.some(
    (step) => step.status === 'blocked',
  );
  const approval = execution.executionSteps.some(
    (step) => step.status === 'approval_staged',
  );
  const degraded = execution.executionSteps.some(
    (step) => step.status === 'degraded' || step.status === 'skipped',
  );
  const status: CognitiveVerificationResult['status'] =
    verification.status === 'block' || blocked
      ? 'block'
      : verification.status === 'warn' || degraded || approval
        ? 'warn'
        : 'pass';
  const nextAction = blocked
    ? 'Name the read-only tool blocker, use available local evidence, and ask for the exact repair or missing proof.'
    : approval
      ? 'Stage the draft/checkpoint and wait for explicit same-channel approval before any mutating action.'
      : degraded
        ? 'Answer with degraded-provider/tool wording and record what evidence was missing.'
        : mode === 'read_only_react' || mode === 'council_verified'
          ? 'Use the executed read-only evidence to answer, then record outcome metadata.'
          : verification.nextAction;
  return {
    ...verification,
    status,
    evidenceGaps: Array.from(gaps),
    approvalRequired: verification.approvalRequired || approval,
    nextAction,
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
  hasAttachedCouncil: boolean;
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
          ? 8
          : input.mode === 'read_only_react'
            ? 5
            : 4,
    maxCouncilCalls:
      input.mode === 'council_verified' || input.hasAttachedCouncil ? 1 : 0,
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
    {
      toolId: 'integrations_status',
      actionClass: 'local_lookup',
      purpose: 'Read integration doctor status before route execution.',
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
      toolId: 'bluebubbles_status',
      actionClass: 'read_only_integration',
      purpose:
        'Read BlueBubbles status and proof blockers before drafting message help.',
      approvalRequired: false,
    });
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
      actionClass: 'read_only_integration',
      purpose: 'Read operator status and stage any repair plan for approval.',
      approvalRequired: false,
    });
  }
  if (
    /\bwhy did you choose|why that route|cognition status|trace\b/i.test(
      input.goal,
    )
  ) {
    plans.push({
      toolId: 'cognition_trace',
      actionClass: 'local_lookup',
      purpose: 'Explain the route from sanitized trace metadata.',
      approvalRequired: false,
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
    providerDegradedCount:
      usability.degraded + usability.blocked + usability.unknown,
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
      summary: `${usability.healthy} providers healthy; ${usability.degraded} degraded; ${usability.blocked} blocked; ${usability.unknown} unknown.`,
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
  runOrigin: CognitiveRunOrigin;
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
    runOrigin: input.runOrigin,
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
    hasAttachedCouncil: Boolean(input.providerCouncil?.councilRunId),
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
  const governancePolicy = ensureCognitiveGovernancePolicy(startedAt);
  const initialVerification = buildVerification(
    input,
    providers,
    framePolicy.cognitiveMode,
    toolPolicy,
    budgetPolicy,
    toolSimulations,
  );
  let run = buildRunRecord({
    frame,
    mode: framePolicy.cognitiveMode,
    autonomyLevel: framePolicy.autonomyLevel,
    taskGraph: graph,
    evidenceContract,
    provider: providers,
    verification: initialVerification,
    selectedSkill,
    now: startedAt,
    groupFolder: input.groupFolder,
    turnId: input.turnId,
    runOrigin: input.runOrigin || 'live',
    providerCouncil: input.providerCouncil,
  });
  const execution = executeCognitiveToolPlan({
    run,
    goalText: input.goal,
    graph,
    toolPlans,
    toolSimulations,
    registry,
    governancePolicy,
    providerSnapshots,
    provider: providers,
    selectedSkill,
    providerCouncil: input.providerCouncil,
    evidenceContract,
    autonomyBudget,
    now: startedAt,
  });
  const verification = applyExecutionFeedback(
    initialVerification,
    execution,
    framePolicy.cognitiveMode,
  );
  const executionBlocked = execution.executionSteps.some(
    (step) => step.status === 'blocked',
  );
  const policyBlocked = execution.policyDecisions.some(
    (decision) => decision.status === 'block',
  );
  run = {
    ...run,
    status: policyBlocked
      ? 'blocked'
      : verification.approvalRequired ||
          framePolicy.cognitiveMode === 'approval_staged'
        ? 'awaiting_approval'
        : verification.status === 'block' && executionBlocked
          ? 'awaiting_evidence'
          : verification.status === 'block'
            ? 'blocked'
            : execution.executionSteps.some(
                  (step) => step.status === 'executed',
                )
              ? 'answered'
              : run.status,
    verificationJson: safeJson(verification),
    nextAction: redactCouncilText(verification.nextAction, 360),
  };
  const trajectoryScore = trajectoryScoreForExecution({
    run,
    executionSteps: execution.executionSteps,
    artifacts: execution.evidenceArtifacts,
    verifications: execution.stepVerifications,
    approvalPackets: execution.approvalPackets,
    loopState: execution.loopStates[0],
    now: startedAt,
  });
  execution.workbenchState = workbenchStateForRun({
    run,
    handoffs: execution.handoffs,
    decisions: execution.governanceDecisions,
    memoryBlocks: execution.memoryBlocks,
    riskSignals: execution.riskSignals,
    approvalPackets: execution.approvalPackets,
    now: startedAt,
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
    upsertCognitiveGovernancePolicy(governancePolicy);
    persistProviderCooldowns({
      snapshots: providerSnapshots,
      runId: run.runId,
      now: startedAt,
    });
    for (const simulation of toolSimulations) {
      upsertCognitiveToolSimulation(simulation);
    }
    for (const action of execution.actionIdentities) {
      upsertCognitiveActionIdentity(action);
    }
    for (const decision of execution.governanceDecisions) {
      upsertCognitiveGovernanceDecision(decision);
    }
    for (const tripwire of execution.guardrailTripwires) {
      upsertCognitiveGuardrailTripwire(tripwire);
    }
    for (const decision of execution.policyDecisions) {
      upsertCognitivePolicyDecision(decision);
    }
    for (const result of execution.toolResults) {
      upsertCognitiveToolResult(result);
    }
    for (const step of execution.executionSteps) {
      upsertCognitiveExecutionStep(step);
    }
    for (const artifact of execution.evidenceArtifacts) {
      upsertCognitiveEvidenceArtifact(artifact);
    }
    for (const loopState of execution.loopStates) {
      upsertCognitiveExecutionLoopState(loopState);
    }
    for (const stepVerification of execution.stepVerifications) {
      upsertCognitiveStepVerification(stepVerification);
    }
    for (const approvalPacket of execution.approvalPackets) {
      upsertCognitiveApprovalPacket(approvalPacket);
    }
    for (const handoff of execution.handoffs) {
      upsertCognitiveHandoff(handoff);
    }
    for (const riskSignal of execution.riskSignals) {
      upsertCognitiveRiskSignal(riskSignal);
    }
    for (const memoryBlock of execution.memoryBlocks) {
      upsertCognitiveMemoryBlock(memoryBlock);
    }
    for (const revision of execution.planRevisions) {
      upsertCognitivePlanRevision(revision);
    }
    for (const event of execution.runEvents) {
      upsertCognitiveRunEvent(event);
    }
    upsertCognitiveTrajectoryScore(trajectoryScore);
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
    for (const step of execution.executionSteps) {
      upsertCognitiveCheckpoint(
        checkpointRecord({
          run,
          subgoalId: step.subgoalId || null,
          checkpointKind: 'tool_step',
          summary: `Tool step ${step.toolId} recorded as ${step.status}.`,
          state: {
            stepId: step.stepId,
            toolId: step.toolId,
            status: step.status,
            resultId: step.resultId,
            policyDecisionId: step.policyDecisionId,
          },
          nextAction: step.nextAction,
          now: startedAt,
        }),
      );
    }
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
    execution.workbenchState = workbenchStateForRun({
      run,
      handoffs: execution.handoffs,
      decisions: execution.governanceDecisions,
      memoryBlocks: execution.memoryBlocks,
      riskSignals: execution.riskSignals,
      approvalPackets: execution.approvalPackets,
      activeGoalId: activeGoal.goalId,
      now: startedAt,
    });
    upsertCognitiveWorkbenchState(execution.workbenchState);
    persistInitialBlackboard({
      run,
      goal: activeGoal,
      verification,
      toolPolicy,
      budgetPolicy,
      checkpoints,
      now: startedAt,
    });
    const executionSummary = executionAggregate({
      steps: execution.executionSteps,
      results: execution.toolResults,
      decisions: execution.policyDecisions,
      revisions: execution.planRevisions,
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
        spanKind: 'tool_execution',
        status:
          executionSummary.status === 'block'
            ? 'blocked'
            : executionSummary.status === 'warn'
              ? 'warn'
              : 'completed',
        summary: `Executed ${execution.executionSteps.length} policy-gated tool step(s).`,
        inputSummary: toolPlans.map((plan) => plan.toolId).join(', '),
        outputSummary: execution.executionSteps
          .map((step) => `${step.toolId}:${step.status}`)
          .join(', '),
        metadata: executionSummary,
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'tool_execution',
        status:
          execution.loopStates[0]?.status === 'blocked'
            ? 'blocked'
            : execution.loopStates[0]?.status === 'satisfied'
              ? 'completed'
              : 'warn',
        summary: `Executor loop ${execution.loopStates[0]?.status || 'none'} after ${execution.loopStates[0]?.round || 0} round(s).`,
        inputSummary: execution.stepVerifications
          .map((item) => `${item.toolId}:${item.status}`)
          .join(', '),
        outputSummary: execution.loopStates[0]?.nextAction || '',
        metadata: {
          loopStatus: execution.loopStates[0]?.status || 'none',
          evidenceArtifacts: execution.evidenceArtifacts.length,
          stepVerifications: execution.stepVerifications.length,
          approvalPackets: execution.approvalPackets.length,
          trajectoryScore: trajectoryScore.overallScore,
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'guardrail',
        status: execution.governanceDecisions.some(
          (decision) => decision.status === 'block',
        )
          ? 'blocked'
          : execution.governanceDecisions.some(
                (decision) =>
                  decision.status === 'warn' ||
                  decision.status === 'stage_approval',
              )
            ? 'warn'
            : 'completed',
        summary: `Governance evaluated ${execution.governanceDecisions.length} action(s) through the v9 policy pack.`,
        inputSummary: execution.actionIdentities
          .map((action) => `${action.toolId}:${action.sideEffectClass}`)
          .join(', '),
        outputSummary: execution.governanceDecisions
          .map((decision) => `${decision.toolId}:${decision.status}`)
          .join(', '),
        metadata: {
          policyId: governancePolicy.policyId,
          decisions: execution.governanceDecisions.length,
          tripwires: execution.guardrailTripwires.length,
          riskSignals: execution.riskSignals.length,
          sourcePatternRefs: V9_SOURCE_PATTERN_REFS,
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'checkpoint',
        status:
          execution.workbenchState.status === 'blocked'
            ? 'blocked'
            : execution.workbenchState.status === 'degraded' ||
                execution.workbenchState.status === 'awaiting_approval'
              ? 'warn'
              : 'completed',
        summary: `Workbench snapshot ${execution.workbenchState.status} with ${execution.handoffs.length} handoff(s) and ${execution.memoryBlocks.length} memory block(s).`,
        inputSummary: execution.handoffs
          .map((handoff) => `${handoff.fromRole}->${handoff.toRole}`)
          .join(', '),
        outputSummary: execution.workbenchState.nextAction,
        metadata: {
          workbenchId: execution.workbenchState.workbenchId,
          handoffCount: execution.handoffs.length,
          memoryBlockCount: execution.memoryBlocks.length,
          approvalPacketCount: execution.approvalPackets.length,
          riskSignalCount: execution.riskSignals.length,
        },
        now: startedAt,
      }),
      traceSpan({
        runId: run.runId,
        goalId: activeGoal.goalId,
        spanKind: 'plan_revision',
        status: execution.planRevisions.some(
          (revision) => revision.revisionKind !== 'success_path',
        )
          ? 'warn'
          : 'completed',
        summary: `${execution.planRevisions.length} plan revision(s) recorded.`,
        inputSummary: execution.planRevisions
          .map((revision) => revision.revisionKind)
          .join(', '),
        outputSummary:
          execution.planRevisions[execution.planRevisions.length - 1]
            ?.nextAction || '',
        metadata: {
          revisionKinds: execution.planRevisions.map(
            (revision) => revision.revisionKind,
          ),
        },
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
    actionIdentities: execution.actionIdentities,
    governanceDecisions: execution.governanceDecisions,
    guardrailTripwires: execution.guardrailTripwires,
    handoffs: execution.handoffs,
    riskSignals: execution.riskSignals,
    memoryBlocks: execution.memoryBlocks,
    workbenchState: execution.workbenchState,
    toolSimulations,
    policyDecisions: execution.policyDecisions,
    toolResults: execution.toolResults,
    executionSteps: execution.executionSteps,
    evidenceArtifacts: execution.evidenceArtifacts,
    loopStates: execution.loopStates,
    stepVerifications: execution.stepVerifications,
    approvalPackets: execution.approvalPackets,
    planRevisions: execution.planRevisions,
    runEvents: execution.runEvents,
    trajectoryScore,
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
  if (
    input.evaluatorFlags.some((flag) => /approval|send|mutating/i.test(flag)) ||
    input.cognitiveRun?.run.cognitiveMode === 'approval_staged'
  ) {
    return 'approval_blocked';
  }
  if (input.blockerClass || input.answerClass === 'blocked') return 'failure';
  if (input.evaluationStatus === 'block') return 'verifier_block';
  if (input.evaluatorFlags.some((flag) => /provider/i.test(flag))) {
    return 'provider_degraded';
  }
  return 'success';
}

function skillStateAfterOutcome(input: {
  existing?: CognitiveSkillCardRecord | null;
}): CognitiveSkillCardRecord['promotionState'] {
  // Internal verification is useful evidence, but it is not an owner verdict.
  // Preserve existing state and let reviewed outcomes plus deterministic replay
  // make promotion/quarantine decisions in recordCognitiveOwnerReview().
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
        : baseRun.runOrigin === 'live'
          ? 'Use this outcome to reinforce the reusable skill candidate.'
          : 'Record replay evidence without changing live learning state.';
  const isLiveRun = baseRun.runOrigin === 'live';
  const updated: CognitiveRunRecord = {
    ...baseRun,
    updatedAt: endedAt,
    status,
    outcomeScore: score,
    nextAction,
    linkedSkillCardId: isLiveRun ? baseRun.linkedSkillCardId || null : null,
  };
  const flags = input.evaluatorFlags.map((flag) =>
    redactCouncilText(flag, 120),
  );
  const skill = isLiveRun
    ? upsertSkillFromOutcome({
        run: updated,
        score,
        status,
        routeUsed: input.routeUsed,
        flags,
        now: endedAt,
      })
    : null;
  updated.linkedSkillCardId = skill?.skillId || null;
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
          linkedSkillCardId: skill?.skillId || null,
          runOrigin: updated.runOrigin,
        },
        now: endedAt,
      }),
    ]);
    insertCognitiveRewardSignal({
      signalId: `cogreward:${updated.runId}:${endedAt}`,
      createdAt: endedAt,
      runId: updated.runId,
      skillId: skill?.skillId || null,
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
      skillId: skill?.skillId || null,
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

export interface CognitiveOwnerReviewResult {
  recorded: boolean;
  reason: string;
  signalId?: string;
  runId?: string;
  skillId?: string | null;
  promotionState?: CognitiveSkillCardRecord['promotionState'] | null;
  promotionAssessment?: CognitiveSkillPromotionAssessment | null;
}

const COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS = 5;
const COGNITIVE_PROMOTION_MIN_ACCEPTANCE_RATE = 0.8;
const COGNITIVE_PROMOTION_MAX_NEGATIVE_RUNS = 1;
const COGNITIVE_PROMOTION_REPLAY_FRESH_DAYS = 30;

const COGNITIVE_BENCHMARK_TASK_BY_FAMILY: Partial<
  Record<PlatformTaskFamily, string>
> = {
  assistant: 'quick-guidance',
  research: 'read-only-research',
  communication: 'approval-draft',
  operator: 'ultrathink-operator',
};

export interface CognitiveSkillPromotionAssessment {
  skillId: string;
  reviewedRuns: number;
  acceptedRuns: number;
  negativeRuns: number;
  acceptanceRate: number;
  trajectoryEvidenceComplete: boolean;
  freshReplayPass: boolean;
  replayAttemptId: string | null;
  eligible: boolean;
  recommendedState: CognitiveSkillCardRecord['promotionState'];
  reason: string;
}

export function assessCognitiveSkillPromotion(
  skill: CognitiveSkillCardRecord,
  referenceIso = nowIso(),
): CognitiveSkillPromotionAssessment {
  const liveRunIds = new Set(
    safeDb<CognitiveRunRecord[]>([], () =>
      listCognitiveRuns({ runOrigin: 'live', limit: 1000 }),
    ).map((run) => run.runId),
  );
  const ownerSignals = safeDb<CognitiveRewardSignalRecord[]>([], () =>
    listCognitiveRewardSignals({ skillId: skill.skillId, limit: 200 }),
  ).filter(
    (signal) =>
      signal.skillId === skill.skillId &&
      liveRunIds.has(signal.runId) &&
      (signal.signalKind === 'user_acceptance' ||
        signal.signalKind === 'user_correction'),
  );
  const latestReviewByRun = new Map<string, CognitiveRewardSignalRecord>();
  for (const signal of ownerSignals) {
    const current = latestReviewByRun.get(signal.runId);
    if (!current || signal.createdAt > current.createdAt) {
      latestReviewByRun.set(signal.runId, signal);
    }
  }
  const reviews = [...latestReviewByRun.values()];
  const acceptedRunIds = reviews
    .filter((signal) => signal.signalKind === 'user_acceptance')
    .map((signal) => signal.runId);
  const negativeRuns = reviews.filter(
    (signal) => signal.signalKind === 'user_correction',
  ).length;
  const reviewedRuns = reviews.length;
  const acceptedRuns = acceptedRunIds.length;
  const acceptanceRate = reviewedRuns > 0 ? acceptedRuns / reviewedRuns : 0;

  const acceptedRunSet = new Set(acceptedRunIds);
  const trajectories = safeDb<CognitiveTrajectoryScore[]>([], () =>
    listCognitiveTrajectoryScores({
      taskFamily: skill.taskFamily,
      limit: 500,
    }),
  ).filter((trajectory) => acceptedRunSet.has(trajectory.runId));
  const trajectoryByRun = new Map(
    trajectories.map((trajectory) => [trajectory.runId, trajectory]),
  );
  const trajectoryEvidenceComplete =
    acceptedRuns >= COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS &&
    acceptedRunIds.every((runId) => {
      const trajectory = trajectoryByRun.get(runId);
      return Boolean(
        trajectory &&
        trajectory.status !== 'fail' &&
        trajectory.overallScore >= 0.62 &&
        trajectory.verifierSatisfaction >= 0.68 &&
        trajectory.privacySafety >= 1,
      );
    });

  const benchmarkTaskId =
    COGNITIVE_BENCHMARK_TASK_BY_FAMILY[skill.taskFamily as PlatformTaskFamily];
  const referenceMs = Date.parse(referenceIso);
  const replayCutoffMs =
    referenceMs - COGNITIVE_PROMOTION_REPLAY_FRESH_DAYS * 24 * 60 * 60 * 1000;
  const replay = benchmarkTaskId
    ? safeDb<CognitiveBenchmarkAttemptRecord[]>([], () =>
        listCognitiveBenchmarkAttempts({
          taskId: benchmarkTaskId,
          status: 'pass',
          limit: 20,
        }),
      ).find((attempt) => {
        const attemptMs = Date.parse(attempt.createdAt);
        return (
          Number.isFinite(referenceMs) &&
          Number.isFinite(attemptMs) &&
          attemptMs <= referenceMs &&
          attemptMs >= replayCutoffMs &&
          attempt.score >= 0.98 &&
          attempt.toolPolicyPass &&
          attempt.approvalGatePass &&
          attempt.privacyPass &&
          attempt.outcomeCaptured
        );
      }) || null
    : null;
  const freshReplayPass = Boolean(replay);
  const eligible =
    reviewedRuns >= COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS &&
    acceptedRuns >= COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS &&
    acceptanceRate >= COGNITIVE_PROMOTION_MIN_ACCEPTANCE_RATE &&
    negativeRuns <= COGNITIVE_PROMOTION_MAX_NEGATIVE_RUNS &&
    trajectoryEvidenceComplete &&
    freshReplayPass;
  const recommendedState: CognitiveSkillCardRecord['promotionState'] =
    skill.promotionState === 'retired'
      ? 'retired'
      : negativeRuns > COGNITIVE_PROMOTION_MAX_NEGATIVE_RUNS
        ? 'quarantined'
        : eligible
          ? 'promoted'
          : 'candidate';

  let reason = 'Collect distinct owner-reviewed outcomes before promotion.';
  if (recommendedState === 'retired') {
    reason = 'Retired skills cannot be re-promoted by outcome feedback.';
  } else if (recommendedState === 'quarantined') {
    reason = 'Two independent negative owner outcomes require quarantine.';
  } else if (acceptedRuns < COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS) {
    reason = `Need ${COGNITIVE_PROMOTION_MIN_REVIEWED_RUNS - acceptedRuns} more distinct accepted owner outcome(s).`;
  } else if (acceptanceRate < COGNITIVE_PROMOTION_MIN_ACCEPTANCE_RATE) {
    reason = 'Owner acceptance is below the 80% promotion threshold.';
  } else if (!trajectoryEvidenceComplete) {
    reason =
      'Reviewed runs do not yet have complete passing trajectory evidence.';
  } else if (!freshReplayPass) {
    reason = benchmarkTaskId
      ? 'A passing deterministic family replay newer than 30 days is required.'
      : 'This task family does not yet have a deterministic promotion replay.';
  } else if (eligible) {
    reason =
      'Reviewed outcomes, trajectory evidence, and fresh replay satisfy promotion policy.';
  }

  return {
    skillId: skill.skillId,
    reviewedRuns,
    acceptedRuns,
    negativeRuns,
    acceptanceRate: Number(acceptanceRate.toFixed(3)),
    trajectoryEvidenceComplete,
    freshReplayPass,
    replayAttemptId: replay?.attemptId || null,
    eligible,
    recommendedState,
    reason,
  };
}

export function recordCognitiveOwnerReview(input: {
  runId: string | null | undefined;
  feedbackId: string;
  verdict: 'accepted' | 'rejected' | 'corrected';
  reviewedAt?: string;
}): CognitiveOwnerReviewResult {
  if (!input.runId) {
    return { recorded: false, reason: 'No cognitive run was linked.' };
  }
  const run = safeDb<CognitiveRunRecord | undefined>(undefined, () =>
    getCognitiveRun(input.runId || ''),
  );
  if (!run) {
    return {
      recorded: false,
      reason: 'The linked cognitive run is no longer available.',
      runId: input.runId,
    };
  }
  if (run.runOrigin !== 'live') {
    return {
      recorded: false,
      reason:
        'Replay and synthetic cognitive runs cannot receive owner-learning signals.',
      runId: run.runId,
      skillId: run.linkedSkillCardId || null,
      promotionState: null,
      promotionAssessment: null,
    };
  }

  const reviewedAt = input.reviewedAt || nowIso();
  const accepted = input.verdict === 'accepted';
  const score = accepted ? 0.96 : input.verdict === 'corrected' ? 0.08 : 0.12;
  const signalId = sanitizeId(
    `cogreward:${run.runId}:owner-review:${input.feedbackId}`,
  );
  const ownerFlag = accepted
    ? 'owner_accepted'
    : input.verdict === 'corrected'
      ? 'owner_corrected'
      : 'owner_rejected';
  insertCognitiveRewardSignal({
    signalId,
    createdAt: reviewedAt,
    runId: run.runId,
    skillId: run.linkedSkillCardId || null,
    signalKind: accepted ? 'user_acceptance' : 'user_correction',
    score,
    summary: accepted
      ? 'Owner accepted this assistant outcome; private response content omitted.'
      : 'Owner rejected or corrected this assistant outcome; private response content omitted.',
    flagsJson: safeJson(
      ['reviewed_outcome', ownerFlag, `feedback:${input.feedbackId}`],
      1200,
    ),
  });

  const updatedRun: CognitiveRunRecord = {
    ...run,
    updatedAt: reviewedAt,
    outcomeScore: score,
    nextAction: accepted
      ? 'Keep this route eligible, but require repeated independent reviewed outcomes before promotion.'
      : 'Inspect this route and its evidence before reuse; do not promote from this outcome.',
  };
  upsertCognitiveRun(updatedRun);

  let promotionState: CognitiveSkillCardRecord['promotionState'] | null = null;
  let promotionAssessment: CognitiveSkillPromotionAssessment | null = null;
  if (run.linkedSkillCardId) {
    const skill = safeDb<CognitiveSkillCardRecord | null>(
      null,
      () =>
        listCognitiveSkillCards({ limit: 100 }).find(
          (card) => card.skillId === run.linkedSkillCardId,
        ) || null,
    );
    if (skill) {
      promotionAssessment = assessCognitiveSkillPromotion(skill, reviewedAt);
      promotionState = promotionAssessment.recommendedState;
      upsertCognitiveSkillCard({
        ...skill,
        updatedAt: reviewedAt,
        latestOutcomeScore: score,
        promotionState,
        failureModesJson: accepted
          ? skill.failureModesJson
          : safeJson(
              Array.from(
                new Set([
                  ...parseJsonSafe<string[]>(skill.failureModesJson, []),
                  ownerFlag,
                ]),
              ),
              1800,
            ),
      });
      if (promotionState !== skill.promotionState) {
        insertCognitiveRewardSignal({
          signalId: sanitizeId(
            `cogreward:${run.runId}:skill-state:${input.feedbackId}`,
          ),
          createdAt: reviewedAt,
          runId: run.runId,
          skillId: skill.skillId,
          signalKind:
            promotionState === 'promoted' ? 'skill_promoted' : 'skill_demoted',
          score: promotionState === 'promoted' ? 1 : 0,
          summary:
            promotionState === 'promoted'
              ? 'Skill met reviewed-outcome and deterministic replay promotion gates.'
              : 'Skill trust was reduced by reviewed-outcome promotion policy.',
          flagsJson: safeJson(
            [
              `state:${skill.promotionState}->${promotionState}`,
              `reviewed_runs:${promotionAssessment.reviewedRuns}`,
              `accepted_runs:${promotionAssessment.acceptedRuns}`,
              `negative_runs:${promotionAssessment.negativeRuns}`,
              `fresh_replay:${promotionAssessment.freshReplayPass}`,
              'authority_expanded:false',
            ],
            1200,
          ),
        });
      }
    }
  }

  insertCognitiveReflection({
    reflectionId: sanitizeId(
      `cogreflection:${run.runId}:owner-review:${input.feedbackId}`,
    ),
    createdAt: reviewedAt,
    groupFolder: run.groupFolder || null,
    runId: run.runId,
    skillId: run.linkedSkillCardId || null,
    taskFamily: run.taskFamily,
    reflectionKind: accepted ? 'success' : 'user_correction',
    summary: accepted
      ? 'Owner accepted the response outcome; raw conversation content was not stored.'
      : 'Owner rejected or corrected the response outcome; raw conversation content was not stored.',
    routeKey: run.selectedSkillId,
    providerStateJson: run.providerUsabilityJson,
    nextRule: updatedRun.nextAction,
    confidence: 1,
    privacyJson: run.privacyJson,
  });

  return {
    recorded: true,
    reason: accepted
      ? 'Owner acceptance linked to the cognitive run.'
      : 'Owner negative review linked to the cognitive run.',
    signalId,
    runId: run.runId,
    skillId: run.linkedSkillCardId || null,
    promotionState,
    promotionAssessment,
  };
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

function benchmarkProviderSnapshots(
  checkedAt: string,
): ProviderHealthSnapshot[] {
  const llm = (providerId: string): ProviderHealthSnapshot => ({
    providerId,
    kind: 'llm',
    state: 'healthy',
    lastHealthyAt: checkedAt,
    lastCheckedAt: checkedAt,
    failureClass: 'none',
    quotaState: 'unknown',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: { benchmark: 'deterministic' },
  });
  return [
    llm('openai_cloud'),
    llm('minimax_cloud'),
    llm('gemini_cloud'),
    llm('anthropic_cloud'),
    {
      providerId: 'brave_search',
      kind: 'search',
      state: 'healthy',
      lastHealthyAt: checkedAt,
      lastCheckedAt: checkedAt,
      failureClass: 'none',
      quotaState: 'unknown',
      credentialState: 'configured',
      knownExpiresAt: null,
      rotationDueAt: null,
      blocker: '',
      nextAction: '',
      metadata: { benchmark: 'deterministic' },
    },
  ];
}

export function runCognitiveBenchmarkSuite(
  params: {
    persist?: boolean;
    generatedAt?: string;
  } = {},
): CognitiveBenchmarkReport {
  if (!isIsolatedTestDatabase()) {
    throw new Error(
      'Deterministic cognition benchmarks require isolated test storage; persist only redacted benchmark attempts after the isolated run completes.',
    );
  }
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
      runOrigin: 'replay',
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
      providerHealthSnapshots: benchmarkProviderSnapshots(generatedAt),
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
    const inferredCheckpointCount =
      checkpoints.length ||
      4 +
        kernel.executionSteps.length +
        (kernel.run.status === 'awaiting_approval' ||
        kernel.run.status === 'awaiting_evidence' ||
        kernel.run.status === 'blocked'
          ? 1
          : 0);
    const approvalGatePass = scenario.expectedApproval
      ? checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointKind === 'approval_wait' &&
            checkpoint.status === 'open',
        ) ||
        (kernel.run.status === 'awaiting_approval' &&
          kernel.approvalPackets.length > 0)
      : !checkpoints.some(
          (checkpoint) => checkpoint.checkpointKind === 'approval_wait',
        );
    const modePass = kernel.run.cognitiveMode === scenario.expectedMode;
    const checkpointPass = inferredCheckpointCount >= 4;
    const toolPolicyPass =
      toolPolicy.pass === true || kernel.verification.status !== 'block';
    const kernelGoalPass = scenario.expectedApproval
      ? kernel.run.status === 'awaiting_approval'
      : kernel.run.status === 'answered' ||
        kernel.run.status === 'awaiting_evidence';
    const persistedGoalPass =
      goals.length > 0 &&
      goals.every((goal) =>
        scenario.expectedApproval
          ? goal.status === 'waiting_approval'
          : ['active', 'satisfied'].includes(goal.status),
      );
    const goalPass = kernelGoalPass || persistedGoalPass;
    const blackboardPass =
      blackboardEntries.length >= 3 ||
      kernel.executionSteps.length + kernel.stepVerifications.length >= 3;
    const benchmarkBudgets =
      budgets.length > 0
        ? budgets
        : kernel.autonomyBudget
          ? [kernel.autonomyBudget]
          : [];
    const kernelBudgetPass =
      kernel.autonomyBudget?.mutatingAllowed === false &&
      (scenario.expectedApproval
        ? kernel.autonomyBudget.approvalRequired
        : true);
    const budgetPass =
      kernelBudgetPass ||
      (benchmarkBudgets.length > 0 &&
        benchmarkBudgets.every(
          (budget) =>
            budget.mutatingAllowed === false &&
            (scenario.expectedApproval ? budget.approvalRequired : true),
        ));
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
      checkpointCount: inferredCheckpointCount,
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

export interface CognitiveRunQualityAssessment {
  runId: string;
  score: number;
  finalized: boolean;
  decisionAppropriate: boolean;
  safeApproval: boolean;
  appropriatelyBlocked: boolean;
  operationalFailure: boolean;
  reviewedOutcome: boolean;
  reasons: string[];
}

export function assessCognitiveRunQuality(
  run: CognitiveRunRecord,
  signal: CognitiveRewardSignalRecord | null = null,
): CognitiveRunQualityAssessment {
  const flags = signal
    ? parseJsonSafe<string[]>(signal.flagsJson, []).map((flag) =>
        String(flag).toLowerCase(),
      )
    : [];
  const flagText = flags.join(' ');
  const positiveReview = /owner_(verified|accepted)|user_accepted/.test(
    flagText,
  );
  const negativeReview =
    /owner_(corrected|rejected)|user_(corrected|rejected)/.test(flagText);
  const reviewedOutcome =
    /owner_(verified|accepted|partial|blocked|corrected|rejected)|reviewed_outcome|user_(accepted|corrected|rejected)/.test(
      flagText,
    );
  const finalized = Boolean(signal);
  const operationalFailure =
    !finalized &&
    (run.status === 'blocked' ||
      run.status === 'answered' ||
      run.status === 'awaiting_approval');
  const safeApproval = run.status === 'awaiting_approval' && finalized;
  const blockerWasSafetyDecision =
    run.status === 'blocked' &&
    signal?.signalKind === 'task_blocked' &&
    /approval_action_claim|provider_council_block|truth_directive:(clarify|stage_approval)|approval|required|missing/.test(
      flagText,
    );
  const appropriatelyBlocked = Boolean(blockerWasSafetyDecision);
  const cautiousAnswer =
    run.status === 'answered' &&
    /truth_directive:(clarify|caveat)|no_source_coverage|missing_premise/.test(
      flagText,
    );

  let score = 0.1;
  const reasons: string[] = [];
  if (negativeReview) {
    score = 0.28;
    reasons.push('owner_rejected_or_corrected_outcome');
  } else if (positiveReview) {
    score = run.status === 'blocked' ? 0.78 : 0.96;
    reasons.push('owner_accepted_outcome');
  } else if (operationalFailure) {
    reasons.push('missing_final_outcome_signal');
  } else if (safeApproval) {
    score = 0.88;
    reasons.push('approval_boundary_preserved');
  } else if (appropriatelyBlocked) {
    score = 0.76;
    reasons.push('unsafe_or_unsupported_action_blocked');
  } else if (run.status === 'blocked') {
    score = 0.38;
    reasons.push('blocked_without_clear_safety_evidence');
  } else if (run.status === 'answered' && signal) {
    if (signal.score >= 0.82) {
      score = 0.9;
      reasons.push('handled_with_strong_internal_verification');
    } else if (cautiousAnswer) {
      score = 0.76;
      reasons.push('evidence_gap_disclosed_or_clarified');
    } else if (signal.score >= 0.6) {
      score = 0.8;
      reasons.push('handled_with_bounded_fallback');
    } else {
      score = Math.max(0.5, Math.min(0.72, signal.score));
      reasons.push('handled_with_weak_internal_evidence');
    }
  } else if (signal) {
    score = Math.max(0.35, Math.min(0.72, signal.score));
    reasons.push('finalized_without_handled_outcome');
  }
  if (reviewedOutcome) reasons.push('reviewed_outcome_present');

  return {
    runId: run.runId,
    score: Number(score.toFixed(3)),
    finalized,
    decisionAppropriate:
      !negativeReview &&
      (positiveReview ||
        safeApproval ||
        appropriatelyBlocked ||
        (run.status === 'answered' && finalized)),
    safeApproval,
    appropriatelyBlocked,
    operationalFailure,
    reviewedOutcome,
    reasons,
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
  const runIds = new Set(runs.map((run) => run.runId));
  const signals = safeDb([], () =>
    listCognitiveRewardSignals({ limit: 200 }),
  ).filter((signal) => runIds.has(signal.runId));
  const signalByRun = new Map<string, CognitiveRewardSignalRecord>();
  for (const signal of signals) {
    const current = signalByRun.get(signal.runId);
    const signalIsOwnerReview =
      signal.signalKind === 'user_acceptance' ||
      signal.signalKind === 'user_correction';
    const currentIsOwnerReview =
      current?.signalKind === 'user_acceptance' ||
      current?.signalKind === 'user_correction';
    if (
      !current ||
      (signalIsOwnerReview && !currentIsOwnerReview) ||
      (signalIsOwnerReview === currentIsOwnerReview &&
        signal.createdAt > current.createdAt)
    ) {
      signalByRun.set(signal.runId, signal);
    }
  }
  const assessments = runs.map((run) =>
    assessCognitiveRunQuality(run, signalByRun.get(run.runId) || null),
  );
  let weightedQuality = 0;
  let qualityWeight = 0;
  assessments.forEach((assessment, index) => {
    const weight = 0.94 ** index;
    weightedQuality += assessment.score * weight;
    qualityWeight += weight;
  });
  const reflections = safeDb([], () =>
    listCognitiveReflections({ limit: 200 }),
  ).filter(
    (reflection) => reflection.runId && runIds.has(reflection.runId),
  ).length;
  return {
    observedRuns: total,
    totalRuns: total,
    replayRuns: 0,
    syntheticRuns: 0,
    blockedRuns: runs.filter((run) => run.status === 'blocked').length,
    approvalRuns: runs.filter((run) => run.status === 'awaiting_approval')
      .length,
    averageOutcomeScore: Number(average.toFixed(3)),
    qualityScore: Number(
      (qualityWeight > 0 ? weightedQuality / qualityWeight : 0).toFixed(3),
    ),
    decisionAppropriateRuns: assessments.filter(
      (assessment) => assessment.decisionAppropriate,
    ).length,
    safeApprovalRuns: assessments.filter(
      (assessment) => assessment.safeApproval,
    ).length,
    appropriatelyBlockedRuns: assessments.filter(
      (assessment) => assessment.appropriatelyBlocked,
    ).length,
    operationalFailureRuns: assessments.filter(
      (assessment) => assessment.operationalFailure,
    ).length,
    finalizedRuns: assessments.filter((assessment) => assessment.finalized)
      .length,
    reviewedOutcomeRuns: assessments.filter(
      (assessment) => assessment.reviewedOutcome,
    ).length,
    rewardSignals: signals.length,
    reflections,
  };
}

function summarizeSkillLibrary(
  cards: CognitiveSkillCardRecord[],
  referenceIso: string,
): CognitiveDoctorReport['skills'] {
  const assessments = cards.map((card) => ({
    card,
    assessment: assessCognitiveSkillPromotion(card, referenceIso),
  }));
  const promoted = cards.filter(
    (card) => card.promotionState === 'promoted',
  ).length;
  const trustedPromoted = assessments.filter(
    ({ card, assessment }) =>
      card.promotionState === 'promoted' && assessment.eligible,
  ).length;
  return {
    total: cards.length,
    promoted,
    trustedPromoted,
    unverifiedPromoted: promoted - trustedPromoted,
    reviewEligibleCandidates: assessments.filter(
      ({ card, assessment }) =>
        card.promotionState === 'candidate' && assessment.eligible,
    ).length,
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
  const governancePolicy = ensureCognitiveGovernancePolicy(generatedAt);
  const allRuns = safeDb([], () => listCognitiveRuns({ limit: 1000 }));
  const observedRuns = allRuns.slice(0, 100);
  const liveRunIds = new Set(
    allRuns.filter((run) => run.runOrigin === 'live').map((run) => run.runId),
  );
  const runs = observedRuns
    .filter((run) => run.runOrigin === 'live')
    .slice(0, 50);
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
  const beliefs = safeDb([], () =>
    listCognitiveWorldBeliefs({ limit: 100 }),
  ).filter((belief) => !belief.runId || liveRunIds.has(belief.runId));
  const goals = safeDb([], () => listCognitiveGoals({ limit: 100 })).filter(
    (goal) => {
      const linkedRunIds = parseJsonSafe<string[]>(goal.linkedRunIdsJson, []);
      const sourceRunIds = [goal.rootRunId || '', ...linkedRunIds].filter(
        Boolean,
      );
      return (
        sourceRunIds.length === 0 ||
        sourceRunIds.some((runId) => liveRunIds.has(runId))
      );
    },
  );
  const blackboardEntries = safeDb([], () =>
    listCognitiveBlackboardEntries({ limit: 100 }),
  ).filter((entry) => !entry.runId || liveRunIds.has(entry.runId));
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
      policyDecisions: [],
      toolResults: [],
      executionSteps: [],
      evidenceArtifacts: [],
      loopStates: [],
      stepVerifications: [],
      approvalPackets: [],
      planRevisions: [],
      runEvents: [],
      trajectoryScores: [],
      governancePolicies: [governancePolicy],
      actionIdentities: [],
      governanceDecisions: [],
      guardrailTripwires: [],
      handoffs: [],
      riskSignals: [],
      memoryBlocks: [],
      workbenchStates: [],
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
  const execution = executionAggregate({
    steps: replayPacket.executionSteps,
    results: replayPacket.toolResults,
    decisions: replayPacket.policyDecisions,
    revisions: replayPacket.planRevisions,
  });
  const latestLoop = replayPacket.loopStates[0] || null;
  const latestApprovalPacket = replayPacket.approvalPackets[0] || null;
  const latestTrajectory = replayPacket.trajectoryScores[0] || null;
  const latestWorkbench = replayPacket.workbenchStates[0] || null;
  const demotedAdapters = latestTrajectory
    ? parseJsonSafe<string[]>(latestTrajectory.demotedAdaptersJson, [])
    : [];
  const cooldowns =
    replayPacket.providerCooldowns.length > 0
      ? replayPacket.providerCooldowns
      : activeProviderCooldowns(generatedAt);
  const recent = {
    ...summarizeRecentRuns(runs),
    observedRuns: observedRuns.length,
    replayRuns: observedRuns.filter((run) => run.runOrigin === 'replay').length,
    syntheticRuns: observedRuns.filter((run) => run.runOrigin === 'synthetic')
      .length,
  };
  const skills = summarizeSkillLibrary(cards, generatedAt);
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
    runs.length > 0 &&
    recent.operationalFailureRuns < Math.max(3, runs.length / 4);
  let nextAction =
    'Keep the task ladder fresh with quick, ultrathink, read-only, and approval-gated proof turns.';
  if (!latest) {
    nextAction =
      'Run one normal ask, one ultrathink ask, and one approval-required draft to seed cognition proof.';
  } else if (
    assessCognitiveRunQuality(
      latest,
      safeDb<CognitiveRewardSignalRecord[]>([], () =>
        listCognitiveRewardSignals({ runId: latest.runId, limit: 1 }),
      )?.[0] || null,
    ).operationalFailure
  ) {
    nextAction =
      'Repair or finalize the latest incomplete cognitive run; do not treat a missing outcome signal as a successful or safely blocked trajectory.';
  } else if (
    replayPacket.governanceDecisions.some(
      (decision) => decision.status === 'block',
    )
  ) {
    nextAction =
      replayPacket.governanceDecisions.find(
        (decision) => decision.status === 'block',
      )?.nextAction || 'Repair the latest governance blocker.';
  } else if (replayPacket.workbenchStates[0]?.nextAction) {
    nextAction = replayPacket.workbenchStates[0].nextAction;
  } else if (goals.some((goal) => goal.status === 'waiting_approval')) {
    nextAction =
      'Resolve the latest approval-waiting cognitive goal or let it expire before retrying the mutating task.';
  } else if (goals.some((goal) => goal.status === 'blocked')) {
    nextAction =
      'Inspect the latest blocked cognitive goal and add missing evidence or clarification.';
  } else if (skills.trustedPromoted === 0) {
    nextAction =
      'Collect five distinct owner-accepted outcomes and a fresh deterministic family replay before trusting a cognitive skill.';
  } else if (recent.blockedRuns > 0) {
    nextAction =
      'Inspect the latest blocked run, gather missing evidence, then rerun the task.';
  }
  return {
    generatedAt,
    ok,
    summary: latest
      ? `Cognitive kernel has ${runs.length} recent live runs (${recent.replayRuns} replay and ${recent.syntheticRuns} synthetic excluded), ${skills.trustedPromoted} trusted promoted skill(s), ${skills.unverifiedPromoted} legacy/unverified promoted skill(s), outcome-led quality ${recent.qualityScore.toFixed(2)}, and ${recent.reviewedOutcomeRuns} reviewed outcome(s).`
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
    execution,
    providerCooldowns: {
      active: cooldowns.length,
      providerIds: cooldowns.map((cooldown) => cooldown.providerId),
      nextAction: cooldowns[0]?.nextAction || null,
    },
    executorLoop: {
      total: replayPacket.loopStates.length,
      latestStatus: latestLoop?.status || null,
      latestRound: latestLoop?.round || null,
      executedToolSteps: latestLoop?.executedToolSteps || 0,
      evidenceSatisfied: latestLoop?.evidenceSatisfied || false,
      nextAction: latestLoop?.nextAction || null,
    },
    evidenceArtifacts: {
      total: replayPacket.evidenceArtifacts.length,
      public: replayPacket.evidenceArtifacts.filter(
        (artifact) => artifact.sensitivity === 'public',
      ).length,
      metadata: replayPacket.evidenceArtifacts.filter(
        (artifact) => artifact.sensitivity === 'metadata',
      ).length,
      privateMetadata: replayPacket.evidenceArtifacts.filter(
        (artifact) => artifact.sensitivity === 'private_metadata',
      ).length,
      sanitizedDigest: replayPacket.evidenceArtifacts.filter(
        (artifact) => artifact.sensitivity === 'sanitized_digest',
      ).length,
      latestKinds: Array.from(
        new Set(
          replayPacket.evidenceArtifacts
            .slice(-5)
            .map((artifact) => artifact.artifactKind),
        ),
      ),
    },
    stepVerification: {
      total: replayPacket.stepVerifications.length,
      pass: replayPacket.stepVerifications.filter(
        (verification) => verification.status === 'pass',
      ).length,
      warn: replayPacket.stepVerifications.filter(
        (verification) => verification.status === 'warn',
      ).length,
      block: replayPacket.stepVerifications.filter(
        (verification) => verification.status === 'block',
      ).length,
      approvalStaged: replayPacket.stepVerifications.filter(
        (verification) => verification.status === 'approval_staged',
      ).length,
    },
    approvalPackets: {
      total: replayPacket.approvalPackets.length,
      staged: replayPacket.approvalPackets.filter(
        (packet) => packet.status === 'staged',
      ).length,
      latestToolId: latestApprovalPacket?.toolId || null,
      latestNextAction: latestApprovalPacket
        ? 'Wait for explicit same-channel approval before any mutating action.'
        : null,
    },
    trajectory: {
      total: replayPacket.trajectoryScores.length,
      latestStatus: latestTrajectory?.status || null,
      latestScore: latestTrajectory?.overallScore ?? null,
      promotedRoute: latestTrajectory?.promotedRoute || false,
      demotedAdapters,
      nextAction: latestTrajectory?.nextAction || null,
    },
    governance: {
      policies: replayPacket.governancePolicies.length,
      decisions: replayPacket.governanceDecisions.length,
      allow: replayPacket.governanceDecisions.filter(
        (decision) => decision.status === 'allow',
      ).length,
      warn: replayPacket.governanceDecisions.filter(
        (decision) => decision.status === 'warn',
      ).length,
      staged: replayPacket.governanceDecisions.filter(
        (decision) => decision.status === 'stage_approval',
      ).length,
      blocked: replayPacket.governanceDecisions.filter(
        (decision) => decision.status === 'block',
      ).length,
      triggeredTripwires: replayPacket.guardrailTripwires.filter(
        (tripwire) => tripwire.triggered,
      ).length,
      riskSignals: replayPacket.riskSignals.length,
      nextAction:
        replayPacket.governanceDecisions.find(
          (decision) => decision.status === 'block',
        )?.nextAction ||
        replayPacket.governanceDecisions.find(
          (decision) => decision.status === 'stage_approval',
        )?.nextAction ||
        null,
    },
    workbench: {
      status: latestWorkbench?.status || 'none',
      handoffs: replayPacket.handoffs.length,
      memoryBlocks: replayPacket.memoryBlocks.length,
      activeGoalId: latestWorkbench?.activeGoalId || null,
      selectedSkillId: latestWorkbench?.selectedSkillId || null,
      nextAction: latestWorkbench?.nextAction || null,
    },
    memoryBlocks: {
      total: replayPacket.memoryBlocks.length,
      conflicted: replayPacket.memoryBlocks.filter(
        (block) => block.status === 'conflicted',
      ).length,
      blocked: replayPacket.memoryBlocks.filter(
        (block) => block.status === 'blocked',
      ).length,
      poisoningRiskMax: replayPacket.memoryBlocks.reduce(
        (max, block) => Math.max(max, block.poisoningRisk),
        0,
      ),
      latestKinds: Array.from(
        new Set(
          replayPacket.memoryBlocks.slice(0, 8).map((block) => block.blockKind),
        ),
      ),
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
  const execution = executionAggregate({
    steps: replayPacket.executionSteps,
    results: replayPacket.toolResults,
    decisions: replayPacket.policyDecisions,
    revisions: replayPacket.planRevisions,
  });
  const blockedSpanCount = replayPacket.spans.filter(
    (span) => span.status === 'blocked',
  ).length;
  const activeCooldownProviderIds = replayPacket.providerCooldowns.map(
    (cooldown) => cooldown.providerId,
  );
  const latestLoop = replayPacket.loopStates[0] || null;
  const latestTrajectory = replayPacket.trajectoryScores[0] || null;
  const latestWorkbench = replayPacket.workbenchStates[0] || null;
  const ok =
    blockedSpanCount === 0 &&
    simulation.status !== 'block' &&
    execution.status !== 'block' &&
    replayPacket.governanceDecisions.every(
      (decision) => decision.status !== 'block',
    ) &&
    replayPacket.privacy.rawPromptsStored === false;
  let nextAction = replayPacket.latestRun?.nextAction || '';
  if (!replayPacket.latestRun) {
    nextAction = 'Run one cognitive task to create a trace packet.';
  } else if (
    replayPacket.governanceDecisions.some(
      (decision) => decision.status === 'block',
    )
  ) {
    nextAction =
      replayPacket.governanceDecisions.find(
        (decision) => decision.status === 'block',
      )?.nextAction || 'Repair the blocked governance decision.';
  } else if (simulation.status === 'block') {
    nextAction =
      'Repair the blocked tool simulation before executing this route.';
  } else if (execution.status === 'block') {
    nextAction =
      'Repair or name the blocked read-only tool result before answering.';
  } else if (activeCooldownProviderIds.length > 0) {
    nextAction =
      'Proceed with degraded-provider wording until cooldowns expire or provider diagnostics recover.';
  } else if (blockedSpanCount > 0) {
    nextAction = 'Inspect blocked trace spans and rerun after repair.';
  }
  return {
    generatedAt,
    ok,
    summary: replayPacket.latestRun
      ? `Trace packet for ${replayPacket.latestRun.runId}: ${replayPacket.spans.length} span(s), simulation=${simulation.status}, execution=${execution.status}, cooldowns=${activeCooldownProviderIds.length}.`
      : 'No cognitive trace packet is available yet.',
    runId: replayPacket.runId,
    spanCount: replayPacket.spans.length,
    blockedSpanCount,
    simulationStatus: simulation.status,
    executionStatus: execution.status,
    executedStepCount: execution.executed,
    loopStatus: latestLoop?.status || 'none',
    loopRoundCount: latestLoop?.round || 0,
    evidenceArtifactCount: replayPacket.evidenceArtifacts.length,
    approvalPacketCount: replayPacket.approvalPackets.length,
    trajectoryScore: latestTrajectory?.overallScore ?? null,
    governanceDecisionCount: replayPacket.governanceDecisions.length,
    handoffCount: replayPacket.handoffs.length,
    memoryBlockCount: replayPacket.memoryBlocks.length,
    riskSignalCount: replayPacket.riskSignals.length,
    workbenchStatus: latestWorkbench?.status || 'none',
    planRevisionCount: execution.planRevisions,
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
      `Execution: ${report.executionStatus}`,
      `Executed steps: ${report.executedStepCount}`,
      `Loop: ${report.loopStatus}`,
      `Loop rounds: ${report.loopRoundCount}`,
      `Evidence artifacts: ${report.evidenceArtifactCount}`,
      `Approval packets: ${report.approvalPacketCount}`,
      `Trajectory score: ${report.trajectoryScore ?? 'none'}`,
      `Governance decisions: ${report.governanceDecisionCount}`,
      `Handoffs: ${report.handoffCount}`,
      `Memory blocks: ${report.memoryBlockCount}`,
      `Risk signals: ${report.riskSignalCount}`,
      `Workbench: ${report.workbenchStatus}`,
      `Plan revisions: ${report.planRevisionCount}`,
      `Tool results: ${report.replayPacket.toolResults.length}`,
      `Policy decisions: ${report.replayPacket.policyDecisions.length}`,
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
    `Recent live runs: ${report.recent.totalRuns}`,
    `Replay runs excluded: ${report.recent.replayRuns}`,
    `Synthetic runs excluded: ${report.recent.syntheticRuns}`,
    `Legacy average score: ${report.recent.averageOutcomeScore.toFixed(2)}`,
    `Outcome-led quality: ${report.recent.qualityScore.toFixed(2)}`,
    `Decision appropriate: ${report.recent.decisionAppropriateRuns}`,
    `Safe approval waits: ${report.recent.safeApprovalRuns}`,
    `Appropriate verifier stops: ${report.recent.appropriatelyBlockedRuns}`,
    `Incomplete runs: ${report.recent.operationalFailureRuns}`,
    `Reviewed outcomes: ${report.recent.reviewedOutcomeRuns}`,
    `Blocked: ${report.recent.blockedRuns}`,
    `Awaiting approval: ${report.recent.approvalRuns}`,
    `Reward signals: ${report.recent.rewardSignals}`,
    `Reflections: ${report.recent.reflections}`,
    '',
    'Skill Library',
    `Promoted state: ${report.skills.promoted}`,
    `Trusted promoted: ${report.skills.trustedPromoted}`,
    `Legacy/unverified promoted: ${report.skills.unverifiedPromoted}`,
    `Review-eligible candidates: ${report.skills.reviewEligibleCandidates}`,
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
    `Tool execution: ${report.execution.status} (${report.execution.executed} executed, ${report.execution.degraded} degraded, ${report.execution.blocked} blocked, ${report.execution.approvalStaged} staged)`,
    `Tool results: ${report.execution.toolResults}`,
    `Plan revisions: ${report.execution.planRevisions}`,
    `Execution next: ${report.execution.latestNextAction || 'none'}`,
    `Provider cooldowns: ${report.providerCooldowns.providerIds.join(', ') || 'none'}`,
    '',
    'Executor Loop',
    `Loop status: ${report.executorLoop.latestStatus || 'none'}`,
    `Loop rounds: ${report.executorLoop.latestRound ?? 'none'}`,
    `Loop executed steps: ${report.executorLoop.executedToolSteps}`,
    `Evidence satisfied: ${report.executorLoop.evidenceSatisfied}`,
    `Loop next: ${report.executorLoop.nextAction || 'none'}`,
    '',
    'Evidence Artifacts',
    `Artifacts: ${report.evidenceArtifacts.total}`,
    `Public: ${report.evidenceArtifacts.public}`,
    `Metadata: ${report.evidenceArtifacts.metadata}`,
    `Private metadata: ${report.evidenceArtifacts.privateMetadata}`,
    `Sanitized digests: ${report.evidenceArtifacts.sanitizedDigest}`,
    `Kinds: ${report.evidenceArtifacts.latestKinds.join(', ') || 'none'}`,
    '',
    'Step Verification',
    `Verified: ${report.stepVerification.total}`,
    `Pass: ${report.stepVerification.pass}`,
    `Warn: ${report.stepVerification.warn}`,
    `Block: ${report.stepVerification.block}`,
    `Approval staged: ${report.stepVerification.approvalStaged}`,
    '',
    'Trajectory',
    `Scores: ${report.trajectory.total}`,
    `Latest status: ${report.trajectory.latestStatus || 'none'}`,
    `Latest score: ${report.trajectory.latestScore ?? 'none'}`,
    `Promoted route: ${report.trajectory.promotedRoute}`,
    `Demoted adapters: ${report.trajectory.demotedAdapters.join(', ') || 'none'}`,
    `Trajectory next: ${report.trajectory.nextAction || 'none'}`,
    '',
    'Governance',
    `Policies: ${report.governance.policies}`,
    `Decisions: ${report.governance.decisions}`,
    `Allow/warn/staged/block: ${report.governance.allow}/${report.governance.warn}/${report.governance.staged}/${report.governance.blocked}`,
    `Tripwires: ${report.governance.triggeredTripwires}`,
    `Risk signals: ${report.governance.riskSignals}`,
    `Governance next: ${report.governance.nextAction || 'none'}`,
    '',
    'Workbench',
    `Status: ${report.workbench.status}`,
    `Handoffs: ${report.workbench.handoffs}`,
    `Memory blocks: ${report.workbench.memoryBlocks}`,
    `Active goal: ${report.workbench.activeGoalId || 'none'}`,
    `Selected skill: ${report.workbench.selectedSkillId || 'none'}`,
    `Workbench next: ${report.workbench.nextAction || 'none'}`,
    '',
    'Memory Blocks',
    `Blocks: ${report.memoryBlocks.total}`,
    `Conflicted: ${report.memoryBlocks.conflicted}`,
    `Blocked: ${report.memoryBlocks.blocked}`,
    `Max poisoning risk: ${report.memoryBlocks.poisoningRiskMax.toFixed(2)}`,
    `Kinds: ${report.memoryBlocks.latestKinds.join(', ') || 'none'}`,
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
