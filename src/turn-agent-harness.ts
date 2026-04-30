import {
  buildMemoryReadPlan,
  type AndreaMemoryTaskFamily,
  type AndreaMemoryTierId,
  type MemoryReadPlan,
} from './assistant-memory-intelligence.js';
import {
  emitAndreaPlatformDeliberation,
  emitAndreaPlatformSkillCandidate,
  emitAndreaPlatformTurnReflection,
  listAndreaPlatformActiveSkillCandidates,
  type AndreaPlatformDeliberationResult,
  type AndreaPlatformSkillCandidateSummary,
  type AndreaPlatformTurnReflectionResult,
  type PlatformTaskFamily,
} from './andrea-platform-bridge.js';

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
}

export interface PostTurnReflection {
  routeUsed: string;
  answerClass: 'handled' | 'blocked' | 'degraded' | 'fallback' | 'unknown';
  blockerClass?: string | null;
  fallbackUsed: boolean;
  reflection?: AndreaPlatformTurnReflectionResult | null;
}

export interface TurnAgentHarnessContext {
  turnId: string;
  channel: TurnAgentChannel;
  groupFolder?: string | null;
  requestRoute?: string | null;
  taskFamily: PlatformTaskFamily;
  meaningful: boolean;
  selectedSkill: SkillAffordanceCard;
  contextCompile: ContextCompileResult;
  deliberation?: AndreaPlatformDeliberationResult | null;
  platformHoldReply?: string | null;
  actorId?: string | null;
}

export interface BeginTurnAgentHarnessInput {
  turnId: string;
  channel: TurnAgentChannel;
  groupFolder?: string | null;
  text: string;
  requestRoute?: string | null;
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

const SIMPLE_TURN_PATTERN =
  /^(?:hi|hey|hello|yo|thanks|thank you|ok|okay|cool|great|nice|yes|no|yep|nope|what'?s up|whats up)$/i;

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
  if (
    /\b(research|news|weather|rain|changed today|compare|recommend|buy)\b/.test(
      haystack,
    )
  ) {
    return 'research';
  }
  if (/\b(image|picture|generate art|media)\b/.test(haystack)) {
    return 'media';
  }
  if (
    /\b(runtime|cursor|codex|repo|debug|diagnose|repair|deploy|service|commit|push)\b/.test(
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
): Promise<ContextCompileResult> {
  const activeSkillCandidates =
    await listAndreaPlatformActiveSkillCandidates(taskFamily);
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
  return `Handle ${taskFamily} turn from ${input.channel} via ${route}.`;
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

export async function beginTurnAgentHarness(
  input: BeginTurnAgentHarnessInput,
): Promise<TurnAgentHarnessContext | null> {
  if (isSimpleTurn(input.text)) return null;
  const taskFamily = classifyTurnTaskFamily(input);
  const contextCompile = await attachActiveSkillCandidates(
    compileTurnContext({
      taskFamily,
      channel: input.channel,
      text: input.text,
      capabilityId: input.capabilityId,
      stateChanging:
        /\b(send|create|move|cancel|delete|forget|remember|repair|deploy|push)\b/i.test(
          input.text,
        ),
    }),
    taskFamily,
  );
  const approvalPosture =
    contextCompile.selectedSkill.approvalNeed === 'explicit'
      ? 'approval_required'
      : contextCompile.selectedSkill.approvalNeed === 'conditional'
        ? 'approval_aware'
        : 'low_risk_auto';
  const deliberation = await emitAndreaPlatformDeliberation({
    goal: buildSanitizedGoal(input, taskFamily),
    taskFamily,
    channel: input.channel,
    groupFolder: input.groupFolder,
    correlationId: input.turnId,
    approvalPosture,
    routeCandidates: routeCandidatesForSkill(contextCompile.selectedSkill),
    memoryMetadata: contextCompile.metadata,
    knownBlockers: input.knownBlockers,
    actorId: input.actorId,
    metadata: {
      request_route: input.requestRoute || '',
      capability_id: input.capabilityId || '',
      turn_agent_harness: 'v10',
      text_shape: sanitizeMetadataValue(describeTextShape(input.text)),
    },
  });
  return {
    turnId: input.turnId,
    channel: input.channel,
    groupFolder: input.groupFolder,
    requestRoute: input.requestRoute,
    taskFamily,
    meaningful: true,
    selectedSkill: contextCompile.selectedSkill,
    contextCompile,
    deliberation,
    platformHoldReply: buildPlatformHoldReply(deliberation, contextCompile),
    actorId: input.actorId,
  };
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
  return /\b(codex_local|openai_cloud|claude_legacy|task_ledger|progress_ledger|trace_grade|platform coordinator|worker_id|selected_policy_id)\b/i.test(
    text,
  );
}

function stripInternalLeakage(text: string): string {
  return text
    .replace(
      /\b(?:codex_local|openai_cloud|claude_legacy)\b/gi,
      'the best available worker',
    )
    .replace(/\btask_ledger\b/gi, 'task record')
    .replace(/\bprogress_ledger\b/gi, 'progress record')
    .replace(/\btrace_grade\b/gi, 'trace check')
    .replace(/\bselected_policy_id\b/gi, 'selected policy')
    .replace(/\bplatform coordinator\b/gi, 'control plane');
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
  if (!/\b(i sent|sent it|message sent)\b/i.test(text)) return text;
  return text.replace(
    /\b(i sent|sent it|message sent)\b/gi,
    'I drafted it for approval',
  );
}

function repairCommunicationSendOverreachExtended(text: string): string {
  return text.replace(
    /\b(?:i'?ll send it|i am sending|i'?m sending|sending it now|i'?ll text them|i'?ll reply for you|i replied for you|i'?ll fire that off)\b/gi,
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
    /\b(provider|quota|externally_blocked|auth)\b/i.test(input.blockerClass);
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
    /\b(i sent|sent it|message sent)\b/i.test(rewritten)
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

  const actualEvidence = evidence[0]?.actualLevel || 'unknown';
  const evidenceGap =
    input.blockerClass || actualEvidence === 'weak'
      ? 'blocked'
      : input.context?.deliberation?.expectedEvidence === 'strong' &&
          actualEvidence !== 'strong'
        ? 'minor'
        : 'none';
  const status = evidenceGap === 'blocked' ? 'warn' : 'pass';
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
  };
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
  return {
    routeUsed: input.routeUsed,
    answerClass: input.answerClass || 'unknown',
    blockerClass: input.blockerClass || null,
    fallbackUsed: input.fallbackUsed === true,
    reflection,
  };
}

export function listSkillAffordances(): SkillAffordanceCard[] {
  return [...SKILL_AFFORDANCES];
}
