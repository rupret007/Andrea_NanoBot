import {
  buildMemoryReadPlan,
  classifyMemoryCandidate,
  decideMemoryPromotion,
  type AndreaMemoryTaskFamily,
  type AndreaMemoryTierId,
  type MemoryReadPlan,
} from './assistant-memory-intelligence.js';
import {
  emitAndreaPlatformDeliberation,
  emitAndreaPlatformSkillCandidate,
  emitAndreaPlatformTurnReflection,
  listAndreaPlatformActiveSkillCandidates,
  type AndreaPlatformCouncilAnswerGuidance,
  type AndreaPlatformDeliberationResult,
  type AndreaPlatformCouncilMode,
  type AndreaPlatformProviderCouncilResult,
  type AndreaPlatformSkillCandidateSummary,
  type AndreaPlatformTurnReflectionResult,
  type PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import { runObservableProviderCouncil } from './provider-council-runner.js';
import {
  detectThinkingControlPreference,
  detectThinkingControlTrigger,
  sanitizeCouncilIntentSnippet,
} from './thinking-controls.js';
import { planCalendarAssistantLookup } from './calendar-assistant.js';
import { recordCouncilOutcomeSignal } from './council-quality.js';
import { isDatabaseInitialized } from './db.js';
import { buildPersonalContextPacket } from './personal-context-packet.js';
import { classifyCouncilLearningCandidate } from './council-learning-classifier.js';
import {
  beginCognitiveKernelRun,
  finalizeCognitiveKernelOutcome,
  type CognitiveKernelResult,
} from './cognitive-kernel.js';
import {
  beginLogicKernelRun,
  evaluateLogicAnswerSupport,
  type LogicKernelResult,
} from './logic-kernel.js';
import {
  beginAgentRuntimeSpineRun,
  finalizeAgentRuntimeSpineOutcome,
  recordAgentRuntimeTruthAudit,
  type AgentRuntimeSpineResult,
} from './agent-runtime-spine.js';
import { runTruthEngine } from './truth-engine.js';
import {
  beginVerifiedDeepWorkForTurn,
  captureCurrentRepositorySnapshot,
  reconcileVerifiedDeepWorkExecution,
} from './verified-deep-work.js';
import type {
  CouncilOutcomeSignalKind,
  CognitiveRunOrigin,
  LogicKernelReport,
  LogicMissingPremise,
  TruthVerdict,
  PersonalContextPacket,
  VerifiedDeepWorkPacket,
} from './types.js';

export type TurnAgentChannel = 'telegram' | 'bluebubbles' | 'alexa' | 'system';

export type SkillSideEffectRisk = 'none' | 'low' | 'medium' | 'high';
export type SkillApprovalNeed = 'none' | 'conditional' | 'explicit';
export type EvidenceLevel = 'strong' | 'partial' | 'weak' | 'unknown';
export type EvidenceFreshness =
  | 'fresh'
  | 'stale'
  | 'unknown'
  | 'not_applicable';
export type TurnExecutionPosture =
  | 'execute_now'
  | 'clarify_first'
  | 'learn_first'
  | 'approval_first'
  | 'blocked';

export interface SkillAffordanceCard {
  skillId: string;
  taskFamily: PlatformTaskFamily;
  purpose: string;
  inputs: string[];
  outputs: string[];
  evidenceLevel: EvidenceLevel;
  sideEffectRisk: SkillSideEffectRisk;
  approvalNeed: SkillApprovalNeed;
  failureModes: string[];
  examples: string[];
}

export type ActiveSkillDirective =
  | 'narrow_calendar_wording'
  | 'explain_provider_blocker'
  | 'require_send_approval'
  | 'bluebubbles_same_thread_proof'
  | 'downvote_to_repair_handoff'
  | 'strip_internal_leakage'
  | 'abstain_low_confidence'
  | 'request_clarification'
  | 'recursive_intent_check_required'
  | 'belief_aware_communication'
  | 'extended_reasoning_engaged'
  | 'verifier_chain_engaged';

export const SUPPORTED_ACTIVE_SKILL_DIRECTIVES: readonly ActiveSkillDirective[] =
  [
    'narrow_calendar_wording',
    'explain_provider_blocker',
    'require_send_approval',
    'bluebubbles_same_thread_proof',
    'downvote_to_repair_handoff',
    'strip_internal_leakage',
    'abstain_low_confidence',
    'request_clarification',
    'recursive_intent_check_required',
    'belief_aware_communication',
    'extended_reasoning_engaged',
    'verifier_chain_engaged',
  ];

export interface ContextCompileResult {
  readPlan: MemoryReadPlan;
  selectedSkill: SkillAffordanceCard;
  activeSkillCandidates?: AndreaPlatformSkillCandidateSummary[];
  effectiveDirectives?: ActiveSkillDirective[];
  memoryTiers: AndreaMemoryTierId[];
  metadata: Record<string, string>;
}

export interface TurnEvidenceCard {
  routeId: string;
  sourceClass:
    | 'local_memory'
    | 'direct_integration'
    | 'runtime'
    | 'saved_context'
    | 'user_input'
    | 'policy'
    | 'none';
  expectedLevel: EvidenceLevel;
  actualLevel: EvidenceLevel;
  freshness: EvidenceFreshness;
  blockerClass?: string | null;
  confidenceImpact: number;
  rawContentLocalOnly: boolean;
  summary: string;
}

export interface PreSendEvaluation {
  status: 'pass' | 'warn' | 'block';
  evidenceLevel: EvidenceLevel;
  evidenceGap: 'none' | 'minor' | 'major' | 'blocked';
  evaluatorFlags: string[];
  safeRewriteApplied: boolean;
  rewrittenText: string;
  approvalCorrectness: 'correct' | 'needs_review' | 'unknown';
  memoryEffect: 'helpful' | 'neutral' | 'harmful' | 'unknown';
  summary: string;
  truthVerdict?: TruthVerdict | null;
}

export interface CouncilGuidedReply {
  text: string;
  applied: boolean;
  flags: string[];
}

export interface PostTurnReflection {
  routeUsed: string;
  answerClass: 'handled' | 'blocked' | 'degraded' | 'fallback' | 'unknown';
  blockerClass?: string | null;
  fallbackUsed: boolean;
  reflection?: AndreaPlatformTurnReflectionResult | null;
}

export interface ReconcileTurnRuntimeEvidenceInput {
  context: TurnAgentHarnessContext | null;
  evaluation: PreSendEvaluation | null;
  runtimeToolEvidence?: unknown;
  runtimeStatus: 'success' | 'error';
  routeUsed: string;
  blockerClass?: string | null;
}

export interface TurnAgentHarnessContext {
  turnId: string;
  channel: TurnAgentChannel;
  groupFolder?: string | null;
  requestRoute?: string | null;
  runOrigin?: CognitiveRunOrigin;
  taskFamily: PlatformTaskFamily;
  meaningful: boolean;
  selectedSkill: SkillAffordanceCard;
  contextCompile: ContextCompileResult;
  deliberation?: AndreaPlatformDeliberationResult | null;
  providerCouncil?: AndreaPlatformProviderCouncilResult | null;
  cognitiveRun?: CognitiveKernelResult | null;
  logicRun?: LogicKernelResult | null;
  runtimeSpine?: AgentRuntimeSpineResult | null;
  platformHoldReply?: string | null;
  actorId?: string | null;
  personalContextPacket?: PersonalContextPacket | null;
  verifiedDeepWorkPacket?: VerifiedDeepWorkPacket | null;
}

export interface BeginTurnAgentHarnessInput {
  turnId: string;
  channel: TurnAgentChannel;
  groupFolder?: string | null;
  text: string;
  requestRoute?: string | null;
  runOrigin?: CognitiveRunOrigin;
  capabilityId?: string | null;
  knownBlockers?: string[];
  actorId?: string | null;
}

export interface EvaluateTurnReplyInput {
  context: TurnAgentHarnessContext | null;
  text: string;
  routeKey?: string | null;
  capabilityId?: string | null;
  handlerKind?: string | null;
  responseSource?: string | null;
  blockerClass?: string | null;
}

function isPlatformProofOnlyMissingPremise(
  premise: LogicMissingPremise,
): boolean {
  return (
    premise.blockerClass === 'missing_episode' ||
    /No Agent OS episode is available yet/i.test(premise.question)
  );
}

function shouldSuppressPlatformProofDebtForLocalReply(
  input: EvaluateTurnReplyInput,
): boolean {
  if (input.blockerClass || input.responseSource !== 'local_companion') {
    return false;
  }
  const routeShape = [
    input.routeKey,
    input.capabilityId,
    input.handlerKind,
    input.context?.deliberation?.selectedRoute,
  ]
    .filter(Boolean)
    .join(' ');
  return !/\b(fallback|failure|blocked|unavailable|hold)\b/i.test(routeShape);
}

function logicReportForUserFacingReply(input: EvaluateTurnReplyInput): {
  report: LogicKernelReport | null;
  suppressedPlatformProofDebt: boolean;
} {
  const report = input.context?.logicRun?.report || null;
  if (!report || !shouldSuppressPlatformProofDebtForLocalReply(input)) {
    return { report, suppressedPlatformProofDebt: false };
  }
  const missingPremises = report.missingPremises.filter(
    (premise) => !isPlatformProofOnlyMissingPremise(premise),
  );
  if (missingPremises.length === report.missingPremises.length) {
    return { report, suppressedPlatformProofDebt: false };
  }
  return {
    report: { ...report, missingPremises },
    suppressedPlatformProofDebt: true,
  };
}

const SIMPLE_TURN_PATTERN =
  /^(?:hi|hey|hello|yo|thanks|thank you|ok|okay|cool|great|nice|yes|no|yep|nope|what'?s up|whats up)$/i;
const ORDINARY_PLATFORM_COORDINATOR_TIMEOUT_MS = 1_000;

const SKILL_AFFORDANCES: SkillAffordanceCard[] = [
  {
    skillId: 'assistant.daily_guidance',
    taskFamily: 'assistant',
    purpose: 'Plan, prioritize, and orient the user with local memory context.',
    inputs: ['current priorities', 'open loops', 'ritual context'],
    outputs: ['bounded guidance reply', 'follow-up suggestions'],
    evidenceLevel: 'partial',
    sideEffectRisk: 'none',
    approvalNeed: 'none',
    failureModes: ['missing continuity', 'over-broad advice'],
    examples: ['what am I forgetting', 'what matters tonight'],
  },
  {
    skillId: 'calendar.availability',
    taskFamily: 'calendar',
    purpose: 'Read or stage calendar actions with careful certainty wording.',
    inputs: ['calendar query', 'date/time evidence'],
    outputs: ['availability answer', 'draft calendar action'],
    evidenceLevel: 'strong',
    sideEffectRisk: 'medium',
    approvalNeed: 'conditional',
    failureModes: [
      'provider unavailable',
      'ambiguous time',
      'overconfident availability',
    ],
    examples: ['do I have anything at 3 tomorrow', 'move that to after lunch'],
  },
  {
    skillId: 'communication.reply_help',
    taskFamily: 'communication',
    purpose:
      'Draft, rewrite, or inspect communication while preserving approval gates.',
    inputs: ['thread continuity', 'message action context'],
    outputs: ['draft reply', 'message action'],
    evidenceLevel: 'partial',
    sideEffectRisk: 'high',
    approvalNeed: 'explicit',
    failureModes: ['missing thread context', 'unsafe send assumption'],
    examples: ['what should I text back', 'make that less stiff'],
  },
  {
    skillId: 'research.live_or_saved',
    taskFamily: 'research',
    purpose:
      'Answer from live providers or saved context with honest blocker wording.',
    inputs: ['query', 'provider health', 'saved context'],
    outputs: ['grounded answer', 'provider blocker explanation'],
    evidenceLevel: 'strong',
    sideEffectRisk: 'none',
    approvalNeed: 'none',
    failureModes: ['quota blocked', 'stale saved context'],
    examples: ['what changed today', 'is it going to rain tonight'],
  },
  {
    skillId: 'code.assistance',
    taskFamily: 'code',
    purpose:
      'Explain, inspect, plan, or implement bounded code work with repository evidence.',
    inputs: ['coding question', 'repository state', 'validation evidence'],
    outputs: ['grounded explanation', 'bounded implementation plan or patch'],
    evidenceLevel: 'strong',
    sideEffectRisk: 'medium',
    approvalNeed: 'conditional',
    failureModes: ['stale repository state', 'missing validation evidence'],
    examples: ['explain this function', 'help me build a small game'],
  },
  {
    skillId: 'memory.arbitration',
    taskFamily: 'assistant',
    purpose:
      'Read, stage, explain, or forget memory without silent risky promotion.',
    inputs: ['memory command', 'profile facts', 'ledger metadata'],
    outputs: ['memory control answer', 'staged candidate'],
    evidenceLevel: 'partial',
    sideEffectRisk: 'medium',
    approvalNeed: 'conditional',
    failureModes: ['sensitive claim', 'conflicting memory'],
    examples: ['what did you remember', 'forget that'],
  },
  {
    skillId: 'bluebubbles.continuity',
    taskFamily: 'communication',
    purpose: 'Handle Messages continuity and same-thread draft decisions.',
    inputs: ['active message action', 'conversation policy'],
    outputs: ['draft follow-up', 'deferred decision'],
    evidenceLevel: 'partial',
    sideEffectRisk: 'high',
    approvalNeed: 'explicit',
    failureModes: ['stale action', 'missed inbound', 'wrong chat target'],
    examples: ['send it later tonight', 'show it again'],
  },
  {
    skillId: 'operator.runtime_work',
    taskFamily: 'operator',
    purpose:
      'Route repo, runtime, and repair work through the conductor/runtime lane.',
    inputs: ['operator goal', 'runtime health', 'approval posture'],
    outputs: ['runtime job', 'repair plan', 'status answer'],
    evidenceLevel: 'strong',
    sideEffectRisk: 'high',
    approvalNeed: 'explicit',
    failureModes: ['worker unavailable', 'dirty repo', 'unapproved deploy'],
    examples: ['diagnose this', 'fix and deploy'],
  },
  {
    skillId: 'unknown.learn_first',
    taskFamily: 'unknown',
    purpose:
      'Inspect available skills and ask or propose a learning path before acting.',
    inputs: ['unknown goal', 'available affordances'],
    outputs: ['capability gap', 'clarifying question'],
    evidenceLevel: 'unknown',
    sideEffectRisk: 'none',
    approvalNeed: 'none',
    failureModes: ['bluffing unsupported capability'],
    examples: ['do this new thing I have not set up yet'],
  },
];

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sanitizeMetadataValue(value: string, max = 160): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function hasHighRiskPlanningIntent(text: string): boolean {
  const normalized = normalize(text);
  const asksForPlanning =
    /\b(plan|review|design|assess|strategy|architecture|safest|how should|threat model|rollout)\b/.test(
      normalized,
    );
  const hazardousDomain =
    /\b(production|deploy(?:ment)?|release|migration|database|schema|security|credential|secret|privacy|delete|deletion|rollback|admin|purchase|payment)\b/.test(
      normalized,
    );
  return asksForPlanning && hazardousDomain;
}

export function isSimpleTurn(text: string): boolean {
  const normalized = normalize(text);
  return normalized.length <= 40 && SIMPLE_TURN_PATTERN.test(normalized);
}

export function classifyTurnTaskFamily(input: {
  text: string;
  requestRoute?: string | null;
  capabilityId?: string | null;
  channel?: TurnAgentChannel;
}): PlatformTaskFamily {
  const haystack = [
    input.text,
    input.requestRoute || '',
    input.capabilityId || '',
    input.channel || '',
  ]
    .join(' ')
    .toLowerCase();
  // High-risk planning must be classified before generic research terms such
  // as "recommend", "latest", and "architecture review". The council gate
  // deliberately relies on an operator/code family so a research-first match
  // here would silently downgrade production and security planning.
  if (hasHighRiskPlanningIntent(haystack)) {
    return 'operator';
  }
  if (
    /\b(research|news|weather|rain|changed today|compare|recommend|buy|model council|architecture review|evidence scout|latest)\b/.test(
      haystack,
    )
  ) {
    return 'research';
  }
  if (
    /\b(calendar|schedule|reschedule|event|meeting|tomorrow|today|3pm|3 pm)\b/.test(
      haystack,
    )
  ) {
    return 'calendar';
  }
  if (
    /\b(text|message|reply|draft|say back|bluebubbles|imessage|send it|less stiff|warmer|direct)\b/.test(
      haystack,
    )
  ) {
    return 'communication';
  }
  if (/\b(image|picture|generate art|media)\b/.test(haystack)) {
    return 'media';
  }
  const repositoryOperatorAction = /\b(commit|push|deploy|merge|rebase)\b/.test(
    haystack,
  );
  const serviceLifecycleAction =
    /\b(restart|start|stop|status|health|logs?|rebuild)\b/.test(haystack) &&
    /\b(service|services|runtime|host|gateway|process|openclaw)\b/.test(
      haystack,
    );
  if (repositoryOperatorAction || serviceLifecycleAction) {
    return 'operator';
  }
  const directCodeTask =
    /\b(code|coding|codebase|repository|repo|refactor|unit tests?|test suite|typecheck|lint|compile|compiler|typescript|javascript|python)\b/.test(
      haystack,
    );
  const technicalChangeTask =
    /\b(implement|patch|debug|fix|repair)\b.*\b(app|api|backend|frontend|database|build|bug|test|function|module)\b/.test(
      haystack,
    );
  if (directCodeTask || technicalChangeTask) {
    return 'code';
  }
  if (
    /\b(runtime|cursor|codex|repo|debug|diagnose|repair|deploy|service|commit|push)\b/.test(
      haystack,
    )
  ) {
    return 'operator';
  }
  if (
    /\b(approval|approve|approved|do it|go ahead|start the repair|repair and land|fix it)\b/.test(
      haystack,
    ) &&
    /\b(approval|repair|feedback|fix|self[- ]?improvement|not helpful)\b/.test(
      haystack,
    )
  ) {
    return 'operator';
  }
  if (
    /\b(remember|memory|forget|profile|preference|call this)\b/.test(haystack)
  ) {
    return 'assistant';
  }
  if (
    /\b(what matters|forgetting|plan|priority|tonight|morning|next step|blocking)\b/.test(
      haystack,
    )
  ) {
    return 'assistant';
  }
  return input.requestRoute === 'direct_assistant' ||
    input.requestRoute === 'protected_assistant'
    ? 'assistant'
    : 'unknown';
}

function toMemoryTaskFamily(
  taskFamily: PlatformTaskFamily,
): AndreaMemoryTaskFamily {
  if (taskFamily === 'operator' || taskFamily === 'code')
    return 'repo_operator';
  if (taskFamily === 'media') return 'research';
  if (
    taskFamily === 'assistant' ||
    taskFamily === 'calendar' ||
    taskFamily === 'communication' ||
    taskFamily === 'research' ||
    taskFamily === 'unknown'
  ) {
    return taskFamily;
  }
  return 'unknown';
}

export function selectSkillAffordance(input: {
  taskFamily: PlatformTaskFamily;
  channel?: TurnAgentChannel;
  text?: string;
  capabilityId?: string | null;
}): SkillAffordanceCard {
  const text = normalize(
    [input.text || '', input.capabilityId || '', input.channel || ''].join(' '),
  );
  if (input.channel === 'bluebubbles' || text.includes('bluebubbles')) {
    return SKILL_AFFORDANCES.find(
      (card) => card.skillId === 'bluebubbles.continuity',
    )!;
  }
  if (/\b(remember|memory|forget|preference|profile)\b/.test(text)) {
    return SKILL_AFFORDANCES.find(
      (card) => card.skillId === 'memory.arbitration',
    )!;
  }
  const exact = SKILL_AFFORDANCES.find(
    (card) => card.taskFamily === input.taskFamily,
  );
  return exact || SKILL_AFFORDANCES[SKILL_AFFORDANCES.length - 1]!;
}

export function compileTurnContext(input: {
  taskFamily: PlatformTaskFamily;
  channel?: TurnAgentChannel;
  text?: string;
  capabilityId?: string | null;
  stateChanging?: boolean;
}): ContextCompileResult {
  const selectedSkill = selectSkillAffordance(input);
  const readPlan = buildMemoryReadPlan({
    taskFamily: toMemoryTaskFamily(input.taskFamily),
    asksForMemory:
      input.taskFamily === 'assistant' ||
      input.taskFamily === 'communication' ||
      /\b(saved|remember|context|profile|preference)\b/i.test(input.text || ''),
    stateChanging: input.stateChanging,
  });
  const metadata = {
    skill_id: selectedSkill.skillId,
    skill_task_family: selectedSkill.taskFamily,
    skill_side_effect_risk: selectedSkill.sideEffectRisk,
    skill_approval_need: selectedSkill.approvalNeed,
    skill_evidence_level: selectedSkill.evidenceLevel,
    memory_read_tiers: readPlan.readTiers.join(','),
    memory_safe_write_classes: readPlan.safeWriteClasses.join(','),
    memory_hot_path: String(readPlan.hotPath),
    memory_source_count: String(readPlan.sources.length),
    raw_content_policy: 'local_only',
  };
  return {
    readPlan,
    selectedSkill,
    memoryTiers: readPlan.readTiers,
    metadata,
  };
}

function isLowRiskReadOnlyCandidate(
  candidate: AndreaPlatformSkillCandidateSummary,
): boolean {
  if (candidate.lifecycleStatus !== 'active') return false;
  if (candidate.approvalRequired) return false;
  return candidate.riskLevel === 'none' || candidate.riskLevel === 'low';
}

function collectEffectiveDirectives(
  candidates: AndreaPlatformSkillCandidateSummary[],
): ActiveSkillDirective[] {
  const allowed = new Set<string>(SUPPORTED_ACTIVE_SKILL_DIRECTIVES);
  const seen = new Set<ActiveSkillDirective>();
  const out: ActiveSkillDirective[] = [];
  for (const candidate of candidates) {
    if (!isLowRiskReadOnlyCandidate(candidate)) continue;
    for (const directive of candidate.directives) {
      if (!allowed.has(directive)) continue;
      const typed = directive as ActiveSkillDirective;
      if (seen.has(typed)) continue;
      seen.add(typed);
      out.push(typed);
    }
  }
  return out;
}

async function attachActiveSkillCandidates(
  context: ContextCompileResult,
  taskFamily: PlatformTaskFamily,
  coordinatorTimeoutMs?: number,
): Promise<ContextCompileResult> {
  const activeSkillCandidates = await listAndreaPlatformActiveSkillCandidates(
    taskFamily,
    {
      timeoutMs: coordinatorTimeoutMs,
    },
  );
  if (activeSkillCandidates.length === 0) return context;
  const candidateIds = activeSkillCandidates.map(
    (candidate) => candidate.candidateId,
  );
  const skillIds = activeSkillCandidates.map((candidate) => candidate.skillId);
  const effectiveDirectives = collectEffectiveDirectives(activeSkillCandidates);
  const directiveMetadata: Record<string, string> = effectiveDirectives.length
    ? {
        active_skill_directives: effectiveDirectives.join(','),
        active_skill_directive_mode: 'low_risk_read_only',
      }
    : {};
  return {
    ...context,
    activeSkillCandidates,
    effectiveDirectives,
    metadata: {
      ...context.metadata,
      active_skill_candidate_count: String(activeSkillCandidates.length),
      active_skill_candidate_ids: candidateIds.join(','),
      active_skill_ids: skillIds.join(','),
      skill_evolution_mode: 'active_verified_only',
      ...directiveMetadata,
    },
  };
}

function routeCandidatesForSkill(skill: SkillAffordanceCard): string[] {
  const candidates = ['local_capability', 'clarify_first', 'learn_first'];
  if (skill.taskFamily === 'calendar' || skill.taskFamily === 'research') {
    candidates.unshift('direct_integration');
  }
  if (skill.taskFamily === 'operator' || skill.taskFamily === 'code') {
    candidates.unshift('runtime_conductor');
  }
  if (skill.approvalNeed !== 'none') candidates.push('approval_first');
  candidates.push('blocked', 'saved_context_answer');
  return Array.from(new Set(candidates));
}

function buildSanitizedGoal(
  input: BeginTurnAgentHarnessInput,
  taskFamily: PlatformTaskFamily,
): string {
  const route = input.requestRoute || 'unknown_route';
  const sanitizedIntent =
    taskFamily === 'communication'
      ? `Communication help requested; raw thread/message body stays local. Shape: ${describeTextShape(input.text)}.`
      : sanitizeCouncilIntentSnippet(input.text, 240);
  return `Handle ${taskFamily} turn from ${input.channel} via ${route}. Safe user intent: ${sanitizedIntent || 'unspecified'}.`;
}

function buildPlatformHoldReply(
  decision: AndreaPlatformDeliberationResult | null | undefined,
  context: ContextCompileResult,
): string | null {
  const posture = decision?.executionPosture as
    | TurnExecutionPosture
    | undefined;
  if (!posture || posture === 'execute_now') return null;
  if (!decision) return null;
  if (decision.abstentionDirective === 'abstain_low_confidence') {
    const probText =
      typeof decision.abstentionPosteriorProb === 'number'
        ? ` (confidence ${(decision.abstentionPosteriorProb * 100).toFixed(0)}%)`
        : '';
    return `I'd rather not guess on this${probText}. Want me to ask one clarifying question, or lean on saved context instead?`;
  }
  if (posture === 'clarify_first') {
    const missing = decision.missingInformation?.[0];
    return missing
      ? `I need one detail before I do that: ${missing}.`
      : 'I need one detail before I do that. What should I use as the target?';
  }
  if (posture === 'approval_first') {
    return `I can do that, but I need your explicit approval first because this uses ${context.selectedSkill.skillId.replace(
      /\./g,
      ' ',
    )} and may have side effects.`;
  }
  if (posture === 'blocked') {
    return (
      decision.policyHoldReason ||
      'I cannot complete that safely right now because one required provider or worker is blocked. I can explain the blocker or use saved/local context instead.'
    );
  }
  if (posture === 'learn_first') {
    return (
      decision.policyHoldReason ||
      "I don't want to bluff that path. I can inspect the available tools and integrations, then propose the smallest safe way to learn or add it."
    );
  }
  return null;
}

export type ProviderCouncilDecisionReason =
  | 'explicit_deep'
  | 'material_route_disagreement'
  | 'high_risk_plan'
  | 'explicit_quick'
  | 'safe_local_lookup'
  | 'ordinary_single_model';

export interface ProviderCouncilDecision {
  run: boolean;
  reason: ProviderCouncilDecisionReason;
  mode: AndreaPlatformCouncilMode | null;
}

function hasMaterialRouteDisagreement(
  deliberation: AndreaPlatformDeliberationResult | null | undefined,
): boolean {
  if (
    deliberation?.riskFlags?.some((flag) =>
      /(?:material_)?route_disagreement/i.test(flag),
    )
  ) {
    return true;
  }
  const viable = (deliberation?.routeScores || [])
    .filter(
      (route) =>
        route.score >= 0.5 &&
        route.confidence >= 0.5 &&
        !route.blockerClass?.trim(),
    )
    .sort((left, right) => right.score - left.score);
  return (
    viable.length >= 2 &&
    viable[0]!.routeId !== viable[1]!.routeId &&
    Math.abs(viable[0]!.score - viable[1]!.score) <= 0.08
  );
}

function isHighRiskPlanningTurn(input: {
  text: string;
  taskFamily: PlatformTaskFamily;
}): boolean {
  if (input.taskFamily !== 'operator' && input.taskFamily !== 'code') {
    return false;
  }
  return hasHighRiskPlanningIntent(input.text);
}

function coordinatorTimeoutForTurn(input: {
  text: string;
  stateChanging: boolean;
  selectedSkill: SkillAffordanceCard;
}): number | undefined {
  const safetySensitive =
    input.stateChanging ||
    input.selectedSkill.sideEffectRisk === 'high' ||
    input.selectedSkill.approvalNeed === 'explicit' ||
    detectThinkingControlPreference(input.text) === 'deep' ||
    hasHighRiskPlanningIntent(input.text);
  return safetySensitive ? undefined : ORDINARY_PLATFORM_COORDINATOR_TIMEOUT_MS;
}

export function decideProviderCouncil(input: {
  text: string;
  taskFamily: PlatformTaskFamily;
  selectedSkill: SkillAffordanceCard;
  deliberation?: AndreaPlatformDeliberationResult | null;
}): ProviderCouncilDecision {
  const text = normalize(input.text);
  const thinkingControl = detectThinkingControlPreference(input.text);
  if (thinkingControl === 'deep') {
    return {
      run: true,
      reason: 'explicit_deep',
      mode: 'max_iq_council',
    };
  }
  if (isHighRiskPlanningTurn(input)) {
    return {
      run: true,
      reason: 'high_risk_plan',
      mode: /\b(repair|fix|recover|remediat)\b/.test(text)
        ? 'repair_council'
        : 'max_iq_council',
    };
  }
  if (thinkingControl === 'quick') {
    return { run: false, reason: 'explicit_quick', mode: null };
  }
  if (
    input.taskFamily === 'calendar' &&
    isSafeReadOnlyCalendarLookupAsk(input.text)
  ) {
    return { run: false, reason: 'safe_local_lookup', mode: null };
  }
  if (hasMaterialRouteDisagreement(input.deliberation)) {
    return {
      run: true,
      reason: 'material_route_disagreement',
      mode: 'dual_review',
    };
  }
  return { run: false, reason: 'ordinary_single_model', mode: null };
}

export function isSafeReadOnlyCalendarLookupAsk(text: string): boolean {
  if (!planCalendarAssistantLookup(text)) return false;
  return !/\b(?:add|create|book|move|reschedule|cancel|delete|remove|change|edit|update)\b[\s\S]{0,80}\b(?:calendar|event|meeting|appointment|call)\b/i.test(
    text,
  );
}

function riskLevelForCouncil(
  skill: SkillAffordanceCard,
): 'low' | 'medium' | 'high' {
  return skill.sideEffectRisk === 'high'
    ? 'high'
    : skill.sideEffectRisk === 'medium'
      ? 'medium'
      : 'low';
}

function sideEffectsForCouncil(
  skill: SkillAffordanceCard,
): 'none' | 'read_only' | 'approval_required' {
  if (skill.approvalNeed === 'explicit') return 'approval_required';
  if (skill.sideEffectRisk === 'none') return 'none';
  return 'read_only';
}

export async function beginTurnAgentHarness(
  input: BeginTurnAgentHarnessInput,
): Promise<TurnAgentHarnessContext | null> {
  if (isSimpleTurn(input.text)) return null;
  const runOrigin = input.runOrigin || 'live';
  const taskFamily = classifyTurnTaskFamily(input);
  const stateChanging =
    /\b(send|create|move|cancel|delete|forget|remember|repair|deploy|push)\b/i.test(
      input.text,
    );
  const baseContextCompile = compileTurnContext({
    taskFamily,
    channel: input.channel,
    text: input.text,
    capabilityId: input.capabilityId,
    stateChanging,
  });
  const coordinatorTimeoutMs = coordinatorTimeoutForTurn({
    text: input.text,
    stateChanging,
    selectedSkill: baseContextCompile.selectedSkill,
  });
  baseContextCompile.metadata.platform_coordinator_timeout_class =
    coordinatorTimeoutMs === undefined
      ? 'safety_default'
      : `ordinary_${coordinatorTimeoutMs}ms`;
  const contextCompile =
    runOrigin === 'live'
      ? await attachActiveSkillCandidates(
          baseContextCompile,
          taskFamily,
          coordinatorTimeoutMs,
        )
      : baseContextCompile;
  const personalContextPacket =
    runOrigin === 'live' && input.groupFolder && isDatabaseInitialized()
      ? await buildPersonalContextPacket({
          groupFolder: input.groupFolder,
          query: input.text,
          limit: 12,
        })
      : null;
  if (personalContextPacket) {
    contextCompile.metadata.personal_context_item_count = String(
      personalContextPacket.items.length,
    );
    contextCompile.metadata.personal_context_citation_count = String(
      personalContextPacket.citations.length,
    );
    contextCompile.metadata.personal_context_conflict_count = String(
      personalContextPacket.conflicts.length,
    );
    contextCompile.metadata.personal_context_raw_messages_stored = 'false';
    contextCompile.metadata.active_perception_refresh_count = String(
      personalContextPacket.perception?.refreshRequests.length || 0,
    );
    contextCompile.metadata.active_perception_refresh_signals =
      personalContextPacket.perception?.refreshRequests.join(',') || 'none';
  }
  const approvalPosture =
    contextCompile.selectedSkill.approvalNeed === 'explicit'
      ? 'approval_required'
      : contextCompile.selectedSkill.approvalNeed === 'conditional'
        ? 'approval_aware'
        : 'low_risk_auto';
  const deliberation =
    runOrigin === 'live'
      ? await emitAndreaPlatformDeliberation({
          goal: buildSanitizedGoal(input, taskFamily),
          taskFamily,
          channel: input.channel,
          groupFolder: input.groupFolder,
          correlationId: input.turnId,
          approvalPosture,
          routeCandidates: routeCandidatesForSkill(
            contextCompile.selectedSkill,
          ),
          memoryMetadata: contextCompile.metadata,
          knownBlockers: input.knownBlockers,
          actorId: input.actorId,
          coordinatorTimeoutMs,
          metadata: {
            request_route: input.requestRoute || '',
            capability_id: input.capabilityId || '',
            turn_agent_harness: 'v10',
            run_origin: runOrigin,
            text_shape: sanitizeMetadataValue(describeTextShape(input.text)),
          },
        })
      : null;
  const providerCouncilDecision = decideProviderCouncil({
    text: input.text,
    taskFamily,
    selectedSkill: contextCompile.selectedSkill,
    deliberation,
  });
  contextCompile.metadata.provider_council_gate_reason =
    providerCouncilDecision.reason;
  contextCompile.metadata.provider_council_gate_run = String(
    providerCouncilDecision.run,
  );
  const providerCouncil =
    runOrigin === 'live' &&
    providerCouncilDecision.run &&
    providerCouncilDecision.mode
      ? await runObservableProviderCouncil({
          goal: buildSanitizedGoal(input, taskFamily),
          taskFamily,
          channel: input.channel,
          groupFolder: input.groupFolder,
          correlationId: input.turnId,
          requestedMode: providerCouncilDecision.mode,
          riskLevel: riskLevelForCouncil(contextCompile.selectedSkill),
          requiredEvidence: contextCompile.selectedSkill.evidenceLevel,
          allowedSideEffects: sideEffectsForCouncil(
            contextCompile.selectedSkill,
          ),
          rawContentPolicy: 'sanitized_snippets',
          runOrigin: 'live',
          publicEvidenceRequired: taskFamily === 'research',
          metadata: {
            request_route: input.requestRoute || '',
            capability_id: input.capabilityId || '',
            turn_agent_harness: 'v16_empirical_council_gate',
            council_gate_reason: providerCouncilDecision.reason,
            skill_id: contextCompile.selectedSkill.skillId,
            selected_policy_id: deliberation?.selectedPolicyId || '',
            raw_content_policy: 'sanitized_snippets',
            thinking_control: detectThinkingControlPreference(input.text),
            thinking_trigger: detectThinkingControlTrigger(input.text),
          },
        })
      : null;
  const councilHoldReply = buildCouncilDirectiveHoldReply(providerCouncil);
  const cognitiveRun = beginCognitiveKernelRun({
    turnId: input.turnId,
    channel: input.channel,
    groupFolder: input.groupFolder,
    taskFamily,
    goal: buildSanitizedGoal(input, taskFamily),
    requestRoute: input.requestRoute,
    runOrigin,
    selectedSkillId: contextCompile.selectedSkill.skillId,
    selectedSkillPurpose: contextCompile.selectedSkill.purpose,
    selectedSkillApprovalNeed: contextCompile.selectedSkill.approvalNeed,
    selectedSkillSideEffectRisk: contextCompile.selectedSkill.sideEffectRisk,
    selectedSkillEvidenceLevel: contextCompile.selectedSkill.evidenceLevel,
    providerCouncil,
    knownBlockers: input.knownBlockers,
    thinkingPreference: detectThinkingControlPreference(input.text),
    thinkingTrigger: detectThinkingControlTrigger(input.text),
  });
  const logicRun =
    runOrigin === 'live'
      ? beginLogicKernelRun({
          subject: buildSanitizedGoal(input, taskFamily),
          cognitiveRun,
          generatedAt: new Date().toISOString(),
        })
      : null;
  const runtimeSpine =
    runOrigin === 'live'
      ? beginAgentRuntimeSpineRun({
          turnId: input.turnId,
          channel: input.channel,
          groupFolder: input.groupFolder,
          requestRoute: input.requestRoute,
          taskFamily,
          goal: buildSanitizedGoal(input, taskFamily),
          cognitiveRun,
          logicRun,
          providerCouncil,
        })
      : null;
  const verifiedDeepWorkPacket =
    runOrigin === 'live' && input.groupFolder && isDatabaseInitialized()
      ? beginVerifiedDeepWorkForTurn({
          groupFolder: input.groupFolder,
          turnId: input.turnId,
          taskFamily,
          objective: buildSanitizedGoal(input, taskFamily),
          approvalRequired:
            contextCompile.selectedSkill.approvalNeed === 'explicit',
          cognitiveRunId: cognitiveRun?.run.runId || null,
          sourceRefs: [
            ...(personalContextPacket?.citations || []),
            deliberation?.taskLedgerId || '',
            providerCouncil?.councilRunId || '',
          ].filter(Boolean),
          knownBlockers: input.knownBlockers,
          resumePendingApproval: input.requestRoute === 'repair_approval',
          repositorySnapshotProvider:
            taskFamily === 'code'
              ? () => captureCurrentRepositorySnapshot()
              : undefined,
        })
      : null;
  return {
    turnId: input.turnId,
    channel: input.channel,
    groupFolder: input.groupFolder,
    requestRoute: input.requestRoute,
    runOrigin,
    taskFamily,
    meaningful: true,
    selectedSkill: contextCompile.selectedSkill,
    contextCompile,
    deliberation,
    providerCouncil,
    cognitiveRun,
    logicRun,
    runtimeSpine,
    platformHoldReply:
      councilHoldReply || buildPlatformHoldReply(deliberation, contextCompile),
    actorId: input.actorId,
    personalContextPacket,
    verifiedDeepWorkPacket,
  };
}

function buildCouncilDirectiveHoldReply(
  providerCouncil: AndreaPlatformProviderCouncilResult | null | undefined,
): string | null {
  const guidance = providerCouncil?.answerGuidance;
  const directives =
    providerCouncil?.structuredVerdict?.actionDirectives ||
    guidance?.actionDirectives ||
    [];
  const stop = directives.find(
    (directive) => directive.directive === 'verifier_stop',
  );
  if (stop) {
    return (
      guidance?.blocker ||
      stop.stopReason ||
      stop.reason ||
      'I need to hold this until the council blocker is resolved.'
    );
  }
  const clarify = directives.find(
    (directive) => directive.directive === 'ask_clarifying_question',
  );
  if (clarify?.question) {
    return clarify.question;
  }
  return null;
}

function describeTextShape(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return 'empty';
  const words = trimmed.split(/\s+/).length;
  const hasQuestion = /\?|\b(what|when|why|how|do i|can you|should i)\b/i.test(
    trimmed,
  );
  const hasAction =
    /\b(send|create|move|cancel|delete|remember|forget|repair|deploy)\b/i.test(
      trimmed,
    );
  return `${words}_words:${hasQuestion ? 'question' : 'statement'}:${hasAction ? 'action' : 'read'}`;
}

export function buildTurnEvidenceCards(
  input: EvaluateTurnReplyInput,
): TurnEvidenceCard[] {
  const context = input.context;
  const taskFamily =
    context?.taskFamily ||
    classifyTurnTaskFamily({
      text: '',
      requestRoute: input.routeKey,
      capabilityId: input.capabilityId,
    });
  const routeId =
    context?.deliberation?.selectedPolicyId ||
    context?.deliberation?.selectedRoute ||
    input.routeKey ||
    'unknown_route';
  const blockerClass = input.blockerClass || null;
  const sourceClass: TurnEvidenceCard['sourceClass'] = blockerClass
    ? 'policy'
    : input.responseSource === 'container_agent'
      ? 'runtime'
      : taskFamily === 'calendar' || taskFamily === 'research'
        ? 'direct_integration'
        : taskFamily === 'communication'
          ? 'local_memory'
          : 'saved_context';
  const actualLevel: EvidenceLevel = blockerClass
    ? 'weak'
    : sourceClass === 'direct_integration'
      ? 'partial'
      : sourceClass === 'runtime'
        ? 'partial'
        : 'partial';
  return [
    {
      routeId,
      sourceClass,
      expectedLevel:
        (context?.deliberation?.expectedEvidence as
          | EvidenceLevel
          | undefined) ||
        context?.selectedSkill.evidenceLevel ||
        'unknown',
      actualLevel,
      freshness: blockerClass ? 'unknown' : 'fresh',
      blockerClass,
      confidenceImpact: blockerClass ? -0.45 : 0.2,
      rawContentLocalOnly: true,
      summary: blockerClass
        ? `Turn evidence is blocked by ${blockerClass}.`
        : `Turn used ${sourceClass} evidence for ${taskFamily}.`,
    },
  ];
}

function hasInternalLeakage(text: string): boolean {
  return /\b(codex_local|openai_cloud|anthropic_cloud|minimax_cloud|gemini_cloud|claude_legacy|task_ledger|progress_ledger|trace_grade|platform coordinator|worker_id|selected_policy_id|selected policy|route_calibration|manual_sync_only|repo_side|provider_council|agent os episode|task drill)\b/i.test(
    text,
  );
}

function stripInternalLeakage(text: string): string {
  return text
    .replace(
      /\n?\s*(?:Before I treat that as certain:\s*)?No Agent OS episode is available yet\.?\s*Run a task drill or a real task turn first\.?/gi,
      '',
    )
    .replace(
      /\b(?:codex_local|openai_cloud|anthropic_cloud|minimax_cloud|gemini_cloud|claude_legacy)\b/gi,
      'the best available worker',
    )
    .replace(/\btask_ledger\b/gi, 'task record')
    .replace(/\bprogress_ledger\b/gi, 'progress record')
    .replace(/\btrace_grade\b/gi, 'trace check')
    .replace(/\bselected_policy_id\b/gi, 'approval setting')
    .replace(/\bselected policy\b/gi, 'approval setting')
    .replace(/\bplatform coordinator\b/gi, 'control plane')
    .replace(/\broute_calibration\b/gi, 'routing tune-up')
    .replace(/\bmanual_sync_only\b/gi, 'manual setup step')
    .replace(/\brepo_side\b/gi, 'local app side')
    .replace(/\bprovider_council\b/gi, 'review');
}

function narrowCalendarCertainty(text: string): string {
  return text.replace(
    /\b(?:you look free|you are free|you're free)\b/gi,
    "I don't see anything",
  );
}

function narrowCalendarCertaintyExtended(text: string): string {
  return text
    .replace(
      /\b(?:your calendar is clear|nothing is on your calendar|you have nothing on your calendar|you're wide open|you are wide open)\b/gi,
      "I don't see anything in the calendar evidence I checked",
    )
    .replace(
      /\b(?:you have nothing|you've got nothing|you have no events|you have no meetings)\b/gi,
      "I don't see anything",
    );
}

function repairCommunicationSendOverreach(text: string): string {
  if (
    !/\b(i sent|sent it|message sent|i'?ll send it|i am sending|i'?m sending|sending it now|i'?ll text them|i'?ll reply for you|i replied for you|i'?ll fire that off)\b/i.test(
      text,
    )
  ) {
    return text;
  }
  return text.replace(
    /\b(i sent|sent it|message sent|i'?ll send it|i am sending|i'?m sending|sending it now|i'?ll text them|i'?ll reply for you|i replied for you|i'?ll fire that off)\b/gi,
    'I drafted it for approval',
  );
}

function repairCommunicationSendOverreachExtended(text: string): string {
  return text.replace(
    /\b(?:i'?ll send it|i am sending|i'?m sending|sending it now|i'?ll text them|i'?ll reply for you|i replied for you|i'?ll fire that off|i drafted it for approval)\b/gi,
    'I drafted it for your approval',
  );
}

function appendBluebubblesContinuityProof(text: string): string {
  if (/same[- ]thread proof/i.test(text)) return text;
  return `${text.trimEnd()} (Same-thread BlueBubbles proof is still pending until I see the inbound continuation.)`;
}

function appendDownvoteRepairHandoff(text: string): string {
  if (/rerun|repair|fix again/i.test(text)) return text;
  return `${text.trimEnd()} If this still misses, I can stage a repair plan and rerun with explicit approval.`;
}

function explainProviderBlockerSoft(text: string): string {
  if (/\b(provider|quota|block|unavailable|saved context)\b/i.test(text)) {
    return text;
  }
  return `Heads up: I'm answering from saved context because the live provider lane isn't currently verified. ${text}`;
}

function visibleGuidanceLine(
  guidance: AndreaPlatformCouncilAnswerGuidance,
): string {
  const cleaned = guidance.visibleVerdict
    .replace(/^Proceed with a concise verified answer\.\s*/i, '')
    .replace(/^Proceed carefully and name uncertainty\.\s*/i, '')
    .replace(/^Ask one clarifying question before acting\.\s*/i, '')
    .replace(
      /^Hold or block until the missing requirement is resolved\.\s*/i,
      '',
    )
    .trim();
  if (
    /\b(?:cannot|can't)\s+say\s+every\s+provider\s+participated\b/i.test(
      cleaned,
    ) ||
    /\bprovider(?:s)?\s+participated\b/i.test(cleaned)
  ) {
    return '';
  }
  const words = cleaned
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const verdict =
    words.length <= 24 ? words.join(' ') : `${words.slice(0, 24).join(' ')}...`;
  if (!verdict) return '';
  return `Quick check: ${verdict}`;
}

function visibleBlockerText(blocker: string): string {
  const cleaned = blocker.replace(/\s+/g, ' ').trim();
  if (
    /\b(?:openai|anthropic|gemini|minimax|brave|codex)_(?:cloud|local|search|[a-z_]+)|(?:transport|provider|quota|auth|credential)_error\b/i.test(
      cleaned,
    )
  ) {
    return 'a provider transport or verification issue';
  }
  return cleaned
    .replace(
      /\b(?:task_ledger|progress_ledger|selected_policy_id|worker_id)\b/gi,
      'internal tracking',
    )
    .replace(/\bplatform coordinator\b/gi, 'review step');
}

export function applyCouncilGuidanceToReply(
  context: TurnAgentHarnessContext | null,
  text: string,
  options?: { groundedLocalReply?: boolean },
): CouncilGuidedReply {
  const guidance = context?.providerCouncil?.answerGuidance;
  if (!guidance || !guidance.visibleVerdict.trim()) {
    return { text, applied: false, flags: [] };
  }
  if (/^council check:/i.test(text.trim())) {
    return { text, applied: false, flags: [] };
  }
  const guidanceLine = visibleGuidanceLine(guidance);
  if (!guidanceLine) {
    return { text, applied: false, flags: [] };
  }
  if (guidance.status === 'block' && guidance.blocker) {
    return {
      text: `I need to hold this until the blocker is resolved: ${visibleBlockerText(
        guidance.blocker,
      )}`,
      applied: true,
      flags: ['provider_council_guidance_applied', 'provider_council_block'],
    };
  }
  if (guidance.status === 'clarify' && !/\?\s*$/.test(text.trim())) {
    if (options?.groundedLocalReply) {
      // A deterministic local capability already produced a grounded answer;
      // replacing it with a council clarifying question would discard real
      // data the user asked for. Deliver the answer and record the skip.
      return {
        text,
        applied: false,
        flags: ['provider_council_clarify_skipped_for_grounded_reply'],
      };
    }
    const question =
      guidance.clarifyingQuestion ||
      (guidance.answerDirection &&
      !/^ask one clarifying question/i.test(guidance.answerDirection)
        ? guidance.answerDirection
        : null) ||
      'What context should I use before I answer that?';
    return {
      text: question,
      applied: true,
      flags: ['provider_council_guidance_applied', 'provider_council_clarify'],
    };
  }
  return {
    text: `${guidanceLine}\n\n${text}`,
    applied: true,
    flags: ['provider_council_guidance_applied'],
  };
}

export function evaluateTurnReply(
  input: EvaluateTurnReplyInput,
): PreSendEvaluation {
  const evidence = buildTurnEvidenceCards(input);
  const flags: string[] = [];
  let rewritten = input.text;
  let safeRewriteApplied = false;
  const directives = new Set<ActiveSkillDirective>(
    input.context?.contextCompile.effectiveDirectives || [],
  );

  const councilGuided = applyCouncilGuidanceToReply(input.context, rewritten, {
    groundedLocalReply: input.responseSource === 'local_companion',
  });
  if (councilGuided.applied) {
    rewritten = councilGuided.text;
    flags.push(...councilGuided.flags);
    safeRewriteApplied = true;
  } else if (councilGuided.flags.length > 0) {
    flags.push(...councilGuided.flags);
  }

  if (
    input.context?.taskFamily === 'calendar' &&
    /\b(you look free|you are free|you're free)\b/i.test(rewritten)
  ) {
    rewritten = narrowCalendarCertainty(rewritten);
    flags.push('calendar_certainty_repaired');
    safeRewriteApplied = true;
  }

  if (
    directives.has('narrow_calendar_wording') &&
    input.context?.taskFamily === 'calendar'
  ) {
    const before = rewritten;
    rewritten = narrowCalendarCertaintyExtended(rewritten);
    if (rewritten !== before) {
      flags.push('directive:narrow_calendar_wording');
      safeRewriteApplied = true;
    }
  }

  const providerBlocked =
    input.blockerClass &&
    /(?:^|[_\W])(provider|quota|externally_blocked|auth)(?:$|[_\W])/i.test(
      input.blockerClass,
    );
  if (
    providerBlocked &&
    !/\b(block|quota|provider|unavailable|cannot|can't)\b/i.test(rewritten)
  ) {
    rewritten = `I can't verify that live right now because the provider lane is blocked. ${rewritten}`;
    flags.push('provider_blocker_explained');
    safeRewriteApplied = true;
  } else if (
    !providerBlocked &&
    directives.has('explain_provider_blocker') &&
    input.context?.taskFamily === 'research'
  ) {
    const before = rewritten;
    rewritten = explainProviderBlockerSoft(rewritten);
    if (rewritten !== before) {
      flags.push('directive:explain_provider_blocker');
      safeRewriteApplied = true;
    }
  }

  const communicationSendRisk =
    input.context?.taskFamily === 'communication' ||
    /\bcommunication|reply|message|text\b/i.test(
      [input.routeKey, input.capabilityId, input.handlerKind]
        .filter(Boolean)
        .join(' '),
    );
  if (
    communicationSendRisk &&
    /\b(i sent|sent it|message sent|i'?ll send it|i am sending|i'?m sending|sending it now|i'?ll text them|i'?ll reply for you|i replied for you|i'?ll fire that off)\b/i.test(
      rewritten,
    )
  ) {
    rewritten = repairCommunicationSendOverreach(rewritten);
    flags.push('communication_send_repaired');
    safeRewriteApplied = true;
  }

  if (
    directives.has('require_send_approval') &&
    input.context?.taskFamily === 'communication'
  ) {
    const before = rewritten;
    rewritten = repairCommunicationSendOverreachExtended(rewritten);
    if (rewritten !== before) {
      flags.push('directive:require_send_approval');
      safeRewriteApplied = true;
    }
  }

  if (
    directives.has('bluebubbles_same_thread_proof') &&
    input.context?.channel === 'bluebubbles'
  ) {
    const before = rewritten;
    rewritten = appendBluebubblesContinuityProof(rewritten);
    if (rewritten !== before) {
      flags.push('directive:bluebubbles_same_thread_proof');
      safeRewriteApplied = true;
    }
  }

  if (
    directives.has('downvote_to_repair_handoff') &&
    /\b(downvote|not helpful|feedback|missed)\b/i.test(
      [
        input.routeKey,
        input.capabilityId,
        input.handlerKind,
        input.responseSource,
      ]
        .filter(Boolean)
        .join(' '),
    )
  ) {
    const before = rewritten;
    rewritten = appendDownvoteRepairHandoff(rewritten);
    if (rewritten !== before) {
      flags.push('directive:downvote_to_repair_handoff');
      safeRewriteApplied = true;
    }
  }

  if (hasInternalLeakage(rewritten)) {
    rewritten = stripInternalLeakage(rewritten);
    flags.push('operator_leakage_repaired');
    safeRewriteApplied = true;
  }
  if (directives.has('strip_internal_leakage')) {
    flags.push('directive:strip_internal_leakage_active');
  }

  const userFacingLogic = logicReportForUserFacingReply(input);
  if (userFacingLogic.suppressedPlatformProofDebt) {
    flags.push('logic:platform_proof_debt_suppressed');
  }
  const logicEvaluation = evaluateLogicAnswerSupport({
    report: userFacingLogic.report,
    text: rewritten,
  });
  if (logicEvaluation.status !== 'pass') {
    flags.push(...logicEvaluation.flags.map((flag) => `logic:${flag}`));
    if (logicEvaluation.suggestedRewrite) {
      rewritten = logicEvaluation.suggestedRewrite;
      safeRewriteApplied = true;
    } else if (
      logicEvaluation.flags.includes('missing_premise_not_disclosed') &&
      userFacingLogic.report?.missingPremises[0]?.question
    ) {
      rewritten = [
        rewritten,
        '',
        userFacingLogic.report.missingPremises[0].question,
      ].join('\n');
      safeRewriteApplied = true;
    } else if (
      logicEvaluation.flags.includes('contradicted_claim_presented_as_certain')
    ) {
      rewritten = rewritten.replace(
        /\b(definitely|certainly|no doubt|guaranteed|for sure)\b/gi,
        'based on the current evidence',
      );
      safeRewriteApplied = true;
    }
  }

  const truthVerdict = runTruthEngine({
    text: rewritten,
    turnId: input.context?.turnId || null,
    channel: input.context?.channel || null,
    taskFamily: input.context?.taskFamily || null,
    subject: input.context?.logicRun?.report.subject || null,
    routeKey: input.routeKey,
    capabilityId: input.capabilityId,
    handlerKind: input.handlerKind,
    responseSource: input.responseSource,
    blockerClass: input.blockerClass,
    logicReport: userFacingLogic.report,
    providerCouncil: input.context?.providerCouncil || null,
  });
  recordAgentRuntimeTruthAudit({
    runtime: input.context?.runtimeSpine || null,
    truthVerdict,
    textShape: describeTextShape(rewritten),
  });
  if (truthVerdict.calibration.status !== 'pass') {
    const suppressRoutineResearchCaveat =
      input.context?.taskFamily === 'research' &&
      input.responseSource === 'research_local' &&
      !input.blockerClass &&
      truthVerdict.rewriteDirectives[0]?.directive === 'caveat';
    flags.push(
      ...truthVerdict.calibration.flags
        .filter((flag) => flag !== 'truth_supported')
        .map((flag) => `truth:${flag}`),
    );
    if (
      truthVerdict.rewrittenText !== rewritten &&
      !suppressRoutineResearchCaveat
    ) {
      rewritten = truthVerdict.rewrittenText;
      safeRewriteApplied = true;
      flags.push(
        `truth_directive:${truthVerdict.rewriteDirectives[0]?.directive || 'rewrite'}`,
      );
    }
  }
  if (hasInternalLeakage(rewritten)) {
    rewritten = stripInternalLeakage(rewritten);
    flags.push('operator_leakage_repaired');
    safeRewriteApplied = true;
  }

  const actualEvidence = evidence[0]?.actualLevel || 'unknown';
  const councilDirectives =
    input.context?.providerCouncil?.structuredVerdict?.actionDirectives ||
    input.context?.providerCouncil?.answerGuidance?.actionDirectives ||
    [];
  const verifierStop = councilDirectives.some(
    (directive) => directive.directive === 'verifier_stop',
  );
  const truthEvidenceGap =
    truthVerdict.calibration.status === 'block'
      ? 'blocked'
      : truthVerdict.calibration.status === 'clarify'
        ? 'major'
        : truthVerdict.calibration.status === 'warn'
          ? 'minor'
          : 'none';
  const evidenceGap =
    verifierStop || input.blockerClass || actualEvidence === 'weak'
      ? 'blocked'
      : truthEvidenceGap !== 'none'
        ? truthEvidenceGap
        : input.context?.deliberation?.expectedEvidence === 'strong' &&
            actualEvidence !== 'strong'
          ? 'minor'
          : 'none';
  const status = verifierStop
    ? 'block'
    : truthVerdict.calibration.status === 'block'
      ? 'block'
      : evidenceGap === 'blocked'
        ? 'warn'
        : truthVerdict.calibration.status === 'clarify' ||
            truthVerdict.calibration.status === 'warn'
          ? 'warn'
          : 'pass';
  return {
    status,
    evidenceLevel: actualEvidence,
    evidenceGap,
    evaluatorFlags: flags.length > 0 ? flags : ['none'],
    safeRewriteApplied,
    rewrittenText: rewritten,
    approvalCorrectness: communicationSendRisk ? 'correct' : 'unknown',
    memoryEffect: input.context?.contextCompile.memoryTiers.length
      ? 'neutral'
      : 'unknown',
    summary:
      flags.length > 0
        ? `Pre-send evaluator applied ${flags.join(', ')}.`
        : 'Pre-send evaluator found no blocking issue.',
    truthVerdict,
  };
}

function recordCouncilOutcomeSignalsForTurn(input: {
  context: TurnAgentHarnessContext | null;
  evaluation: PreSendEvaluation;
  routeUsed: string;
  answerClass: PostTurnReflection['answerClass'];
  blockerClass?: string | null;
}): void {
  const councilRunId = input.context?.providerCouncil?.councilRunId;
  if (!councilRunId || !input.context?.providerCouncil?.answerGuidance) {
    return;
  }
  const flags = input.evaluation.evaluatorFlags.filter(
    (flag) => flag && flag !== 'none',
  );
  const kinds = new Set<CouncilOutcomeSignalKind>();
  if (flags.includes('provider_council_guidance_applied')) {
    kinds.add('guidance_applied');
  }
  if (input.evaluation.safeRewriteApplied) {
    kinds.add('safe_rewrite');
  }
  if (
    input.evaluation.status === 'block' ||
    input.answerClass === 'blocked' ||
    input.blockerClass
  ) {
    kinds.add('answer_blocked');
  } else if (flags.includes('provider_council_clarify')) {
    kinds.add('answer_clarified');
  } else {
    kinds.add('answer_sent');
  }
  for (const signalKind of kinds) {
    recordCouncilOutcomeSignal({
      councilRunId,
      signalKind,
      groupFolder: input.context.groupFolder,
      channel: input.context.channel,
      routeKey: input.routeUsed,
      capabilityId: input.context.selectedSkill.skillId,
      blockerClass: input.blockerClass,
      flags,
      summary: `Council outcome ${signalKind} for ${input.context.taskFamily}; evaluation=${input.evaluation.status}; answer_class=${input.answerClass}; route=${input.routeUsed}.`,
    });
  }
}

export async function reflectTurnAgentOutcome(input: {
  context: TurnAgentHarnessContext | null;
  evaluation: PreSendEvaluation;
  routeUsed: string;
  answerClass?: PostTurnReflection['answerClass'];
  blockerClass?: string | null;
  fallbackUsed?: boolean;
}): Promise<PostTurnReflection> {
  const context = input.context;
  recordCouncilOutcomeSignalsForTurn({
    context,
    evaluation: input.evaluation,
    routeUsed: input.routeUsed,
    answerClass: input.answerClass || 'unknown',
    blockerClass: input.blockerClass,
  });
  finalizeCognitiveKernelOutcome({
    cognitiveRun: context?.cognitiveRun,
    evaluationStatus: input.evaluation.status,
    evidenceGap: input.evaluation.evidenceGap,
    evaluatorFlags: input.evaluation.evaluatorFlags,
    routeUsed: input.routeUsed,
    answerClass: input.answerClass || 'unknown',
    blockerClass: input.blockerClass,
    fallbackUsed: input.fallbackUsed,
  });
  finalizeAgentRuntimeSpineOutcome({
    runtime: context?.runtimeSpine || null,
    evaluationStatus: input.evaluation.status,
    evidenceGap: input.evaluation.evidenceGap,
    evaluatorFlags: input.evaluation.evaluatorFlags,
    routeUsed: input.routeUsed,
    answerClass: input.answerClass || 'unknown',
    blockerClass: input.blockerClass,
  });
  if (!context?.deliberation?.taskLedgerId) {
    return {
      routeUsed: input.routeUsed,
      answerClass: input.answerClass || 'unknown',
      blockerClass: input.blockerClass || null,
      fallbackUsed: input.fallbackUsed === true,
      reflection: null,
    };
  }
  const evidenceCards = buildTurnEvidenceCards({
    context,
    text: input.evaluation.rewrittenText,
    routeKey: input.routeUsed,
    blockerClass: input.blockerClass,
  });
  const reflection = await emitAndreaPlatformTurnReflection({
    taskLedgerId: context.deliberation.taskLedgerId,
    progressLedgerId: context.deliberation.progressLedgerId,
    planId: context.deliberation.planId,
    trigger: 'turn_agent_harness',
    summary: `Handled ${context.taskFamily} turn through ${input.routeUsed} with ${input.evaluation.status} self-check.`,
    planCorrectness:
      input.evaluation.evidenceGap === 'blocked' ? 'weak' : 'partial',
    workerFit: 'partial',
    memoryEffect: input.evaluation.memoryEffect,
    approvalCorrectness: input.evaluation.approvalCorrectness,
    actorId: context.actorId,
    metadata: {
      selected_policy_id: context.deliberation.selectedPolicyId || '',
      selected_route: context.deliberation.selectedRoute || '',
      answer_strategy: context.deliberation.answerStrategy || '',
      execution_posture: context.deliberation.executionPosture || '',
      provider_council_id: context.providerCouncil?.councilRunId || '',
      provider_council_mode: context.providerCouncil?.mode || '',
      provider_council_verdict: context.providerCouncil?.finalRoute || '',
      provider_council_approval_required: String(
        context.providerCouncil?.approvalRequired === true,
      ),
      cognitive_run_id: context.cognitiveRun?.run.runId || '',
      cognitive_mode: context.cognitiveRun?.run.cognitiveMode || '',
      cognitive_status: context.cognitiveRun?.run.status || '',
      cognitive_skill_id: context.cognitiveRun?.run.linkedSkillCardId || '',
      cognitive_next_action: context.cognitiveRun?.run.nextAction || '',
      truth_audit_id: input.evaluation.truthVerdict?.audit.auditId || '',
      truth_status: input.evaluation.truthVerdict?.calibration.status || '',
      truth_support_grade:
        input.evaluation.truthVerdict?.calibration.supportGrade || '',
      truth_confidence: String(
        input.evaluation.truthVerdict?.calibration.confidence || '',
      ),
      route_used: input.routeUsed,
      answer_class: input.answerClass || 'unknown',
      self_check_status: input.evaluation.status,
      expected_evidence: context.deliberation.expectedEvidence || '',
      actual_evidence: input.evaluation.evidenceLevel,
      evidence_gap: input.evaluation.evidenceGap,
      evaluator_flags: input.evaluation.evaluatorFlags.join(','),
      safe_rewrite_applied: String(input.evaluation.safeRewriteApplied),
      route_overridden: String(
        Boolean(
          context.deliberation.selectedRoute &&
          context.deliberation.selectedRoute !== input.routeUsed,
        ),
      ),
      capability_gap_created: String(
        context.deliberation.executionPosture === 'learn_first',
      ),
      fallback_used: String(input.fallbackUsed === true),
      blocker_class: input.blockerClass || '',
      evidence_cards_json: JSON.stringify(
        evidenceCards.map((card) => ({
          route_id: card.routeId,
          source_class: card.sourceClass,
          expected_level: card.expectedLevel,
          actual_level: card.actualLevel,
          freshness: card.freshness,
          blocker_class: card.blockerClass || '',
          raw_content_local_only: String(card.rawContentLocalOnly),
        })),
      ),
    },
  });
  const evaluatorFlags = input.evaluation.evaluatorFlags.filter(
    (flag) => flag && flag !== 'none',
  );
  const shouldStageSkillCandidate =
    evaluatorFlags.length > 0 ||
    input.evaluation.evidenceGap === 'major' ||
    input.evaluation.evidenceGap === 'blocked' ||
    input.evaluation.safeRewriteApplied ||
    (input.evaluation.status === 'pass' &&
      !input.blockerClass &&
      input.answerClass === 'handled');
  if (shouldStageSkillCandidate) {
    const sourceKind =
      input.evaluation.evidenceGap === 'blocked'
        ? 'capability_gap'
        : evaluatorFlags.some((flag) =>
              /\b(approval|leakage|send|provider|calendar|guardrail)\b/i.test(
                flag,
              ),
            )
          ? 'guardrail_trip'
          : input.evaluation.status === 'pass'
            ? 'repeated_success'
            : 'eval_failure';
    await emitAndreaPlatformSkillCandidate({
      skillId: context.selectedSkill.skillId,
      taskFamily: context.taskFamily,
      sourceKind,
      summary:
        sourceKind === 'repeated_success'
          ? `Successful ${context.taskFamily} turn reinforced ${context.selectedSkill.skillId}.`
          : `Evaluator staged a reusable ${context.taskFamily} skill candidate from ${sourceKind}.`,
      evidenceCount: sourceKind === 'repeated_success' ? 1 : 1,
      riskLevel: context.selectedSkill.sideEffectRisk,
      approvalRequired: context.selectedSkill.approvalNeed !== 'none',
      linkedTraceIds: [
        context.deliberation.taskLedgerId,
        context.deliberation.traceGradeId || '',
      ].filter(Boolean),
      linkedEvaluationIds: [
        reflection?.evaluationId || context.deliberation.evaluationId || '',
      ].filter(Boolean),
      metadata: {
        source_system: 'andrea_nanobot',
        trigger: 'post_turn_reflection',
        selected_policy_id: context.deliberation.selectedPolicyId || '',
        self_check_status: input.evaluation.status,
        evaluator_flags: evaluatorFlags.join(',') || 'none',
        evidence_gap: input.evaluation.evidenceGap,
        safe_rewrite_applied: String(input.evaluation.safeRewriteApplied),
        raw_content_policy: 'metadata_only',
      },
    });
  }
  const councilGuidance = context.providerCouncil?.answerGuidance;
  if (councilGuidance) {
    const learning = classifyMemoryCandidate({
      taskFamily: toMemoryTaskFamily(context.taskFamily),
      summary: `Council-guided ${context.taskFamily} turn ended with ${councilGuidance.status} guidance and ${input.evaluation.status} pre-send check.`,
      evidenceMode: 'outcome_review',
      grounded: true,
      conflictRisk:
        councilGuidance.status === 'block' ||
        councilGuidance.status === 'clarify'
          ? 'medium'
          : 'low',
    });
    const learningClassification = classifyCouncilLearningCandidate({
      summary: learning.summary,
      candidates: [
        {
          id: context.selectedSkill.skillId,
          summary: context.selectedSkill.purpose,
        },
        ...(context.contextCompile.activeSkillCandidates || [])
          .slice(0, 5)
          .map((candidate) => ({
            id: candidate.candidateId || candidate.skillId,
            summary: candidate.summary || candidate.skillId,
          })),
      ],
    });
    const promotion = decideMemoryPromotion(learning);
    await emitAndreaPlatformSkillCandidate({
      skillId: `${context.selectedSkill.skillId}.council_learning`,
      taskFamily: context.taskFamily,
      sourceKind: 'operator_review',
      summary: learning.summary,
      evidenceCount: Math.max(
        1,
        context.providerCouncil?.observedMemberIds?.length || 1,
      ),
      riskLevel: context.selectedSkill.sideEffectRisk,
      approvalRequired:
        promotion.decision === 'require_confirmation' ||
        context.selectedSkill.approvalNeed !== 'none',
      linkedTraceIds: [
        context.deliberation.taskLedgerId,
        context.deliberation.traceGradeId || '',
        context.providerCouncil?.councilRunId || '',
      ].filter(Boolean),
      linkedEvaluationIds: [
        reflection?.evaluationId || context.deliberation.evaluationId || '',
      ].filter(Boolean),
      metadata: {
        source_system: 'andrea_nanobot',
        trigger: 'post_turn_council_learning',
        memory_candidate_id: learning.candidateId,
        memory_write_class: learning.writeClass,
        memory_target_tier: learning.targetTier,
        memory_promotion_decision: promotion.decision,
        memory_retention: 'keep_until_changed',
        council_status: councilGuidance.status,
        council_confidence: councilGuidance.confidence.toFixed(2),
        council_source_members: councilGuidance.sourceMemberIds.join(','),
        council_learning_decision: learningClassification.decision,
        council_learning_match_id:
          'matchedId' in learningClassification
            ? learningClassification.matchedId
            : '',
        council_learning_similarity: learningClassification.score.toFixed(3),
        council_learning_reason: learningClassification.reason,
        raw_content_policy: 'metadata_only',
        durable_learning_policy:
          'sanitized_summaries_only_no_raw_reasoning_or_private_bodies',
      },
    });
  }
  return {
    routeUsed: input.routeUsed,
    answerClass: input.answerClass || 'unknown',
    blockerClass: input.blockerClass || null,
    fallbackUsed: input.fallbackUsed === true,
    reflection,
  };
}

/**
 * Reconcile execution-requiring work once, after the final runtime attempt.
 * Post-delivery reflection intentionally cannot call this boundary: delivery
 * and answer quality prove communication, not tool execution or postconditions.
 */
export function reconcileTurnRuntimeEvidence(
  input: ReconcileTurnRuntimeEvidenceInput,
): VerifiedDeepWorkPacket | null {
  const context = input.context;
  const packet = context?.verifiedDeepWorkPacket;
  if (!context || !packet || !isDatabaseInitialized()) return packet || null;
  const evaluation = input.evaluation;
  context.verifiedDeepWorkPacket = reconcileVerifiedDeepWorkExecution({
    packetId: packet.packetId,
    turnId: context.turnId,
    runtimeToolEvidence: input.runtimeToolEvidence,
    runtimeStatus: input.runtimeStatus,
    evaluationStatus: evaluation?.status || 'block',
    evidenceGap: evaluation?.evidenceGap || 'blocked',
    outcomeSummary:
      evaluation?.summary ||
      `Runtime ${input.runtimeStatus} on ${input.routeUsed}; no delivered answer evaluation was available.`,
    blocker: input.blockerClass || null,
  });
  return context.verifiedDeepWorkPacket;
}

export function listSkillAffordances(): SkillAffordanceCard[] {
  return [...SKILL_AFFORDANCES];
}
