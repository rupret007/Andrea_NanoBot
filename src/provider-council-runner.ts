import {
  emitAndreaPlatformCouncilEvent,
  emitAndreaPlatformCouncilMemberResult,
  emitAndreaPlatformProviderCouncil,
  finalizeAndreaPlatformCouncil,
  type AndreaPlatformCouncilAnswerGuidance,
  type AndreaPlatformCouncilEventInput,
  type AndreaPlatformCouncilMemberResultInput,
  type AndreaPlatformCouncilMode,
  type AndreaPlatformProviderCouncilResult,
  type PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import { runAnthropicText } from './anthropic-provider.js';
import { searchBraveWeb } from './brave-search.js';
import {
  buildCouncilVerdict,
  parseCouncilMemberArtifact,
  type CouncilMemberArtifact,
  type CouncilUltrathinkTrace,
  type CouncilVerdict,
} from './council-contracts.js';
import {
  buildCouncilEvidencePack,
  refreshCouncilEvidencePackScorecard,
  summarizeCouncilEvidencePack,
} from './council-evidence.js';
import {
  CouncilFailureGuard,
  finalizeCouncilRunBudget,
  resolveCouncilRunBudget,
} from './council-run-guards.js';
import {
  calibrateCouncilMode,
  recordCouncilRunLedger,
} from './council-quality.js';
import {
  redactCouncilMetadata,
  redactCouncilText,
  Semaphore,
} from './council-safety.js';
import { runGeminiOpenAiText } from './gemini-provider.js';
import { runMiniMaxAnthropicText } from './minimax-provider.js';
import { runOpenAiChatText } from './openai-provider.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import { listCognitiveProviderCooldowns } from './db.js';

type CouncilRole =
  | 'planner'
  | 'critic'
  | 'evidence_scout'
  | 'synthesizer'
  | 'verifier';

interface TextProviderResult {
  text?: string;
  model?: string;
  requestId?: string;
  providerFailure?: string;
  status?: number;
  thinkingTrace?: CouncilUltrathinkTrace;
}

export interface ObservableProviderCouncilInput {
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
}

export interface ProviderCouncilRunnerDeps {
  emitProviderCouncil?: typeof emitAndreaPlatformProviderCouncil;
  emitCouncilEvent?: typeof emitAndreaPlatformCouncilEvent;
  emitMemberResult?: typeof emitAndreaPlatformCouncilMemberResult;
  finalizeCouncil?: typeof finalizeAndreaPlatformCouncil;
  runOpenAi?: typeof runOpenAiChatText;
  runAnthropic?: typeof runAnthropicText;
  runMiniMax?: typeof runMiniMaxAnthropicText;
  runGemini?: typeof runGeminiOpenAiText;
  searchBrave?: typeof searchBraveWeb;
  providerHealthSnapshots?: ProviderHealthSnapshot[];
  now?: () => number;
}

const COUNCIL_ROLE_TIMEOUT_MS = 25_000;

function sanitizeObservableText(value: string, limit = 6000): string {
  return redactCouncilText(value, limit);
}

function estimateTokens(...values: string[]): number {
  const chars = values.join('\n').length;
  return Math.max(1, Math.ceil(chars / 4));
}

function memberPrompt(input: {
  role: CouncilRole;
  goal: string;
  taskFamily: PlatformTaskFamily;
  evidenceSummary: string;
  plannerText?: string;
  synthesizerText?: string;
  criticText?: string;
}): string {
  const base = [
    `Andrea council assignment: ${input.role}.`,
    `Task family: ${input.taskFamily}.`,
    `Sanitized goal: ${input.goal}.`,
    `Evidence summary: ${input.evidenceSummary || 'No live evidence was gathered.'}`,
    'Return visible notes only. Do not include hidden chain-of-thought, secrets, private memory, raw message bodies, or provider debate transcripts.',
    'Return ONLY JSON with: verdict ("pass"|"warn"|"clarify"|"block"), confidence (0-1), evidence_grade ("strong"|"partial"|"weak"|"unknown"), recommended_action ("answer"|"ask_clarifying_question"|"hold"|"draft_only"|"block"), answer_direction, uncertainty, risk_flags, evidence_ids, approval_need ("none"|"conditional"|"explicit"), blocker, clarifying_question.',
  ];
  if (input.role === 'planner') {
    return [
      ...base,
      'Produce: route recommendation, expected evidence, risk flags, and concise next steps.',
    ].join('\n');
  }
  if (input.role === 'critic') {
    return [
      ...base,
      `Planner artifact: ${input.plannerText || 'missing'}`,
      `Independent reasoning artifact: ${input.synthesizerText || 'missing'}`,
      'Challenge the plan. Name missing evidence, unsafe assumptions, and a safer alternate route if needed.',
    ].join('\n');
  }
  if (input.role === 'synthesizer') {
    return [
      ...base,
      `Planner artifact: ${input.plannerText || 'missing'}`,
      'Independently reason about the user-visible answer direction. Name ambiguity, missing context, and the simplest useful answer shape. Keep it concise.',
    ].join('\n');
  }
  if (input.role === 'verifier') {
    return [
      ...base,
      `Planner artifact: ${input.plannerText || 'missing'}`,
      `Independent reasoning artifact: ${input.synthesizerText || 'missing'}`,
      `Critic artifact: ${input.criticText || 'missing'}`,
      'Verify whether the answer may proceed, needs clarification, approval, blocker wording, or platform override.',
    ].join('\n');
  }
  return base.join('\n');
}

function shouldUseEvidenceScout(
  mode: AndreaPlatformCouncilMode | undefined,
  taskFamily: PlatformTaskFamily,
): boolean {
  return (
    mode === 'max_iq_council' ||
    mode === 'repair_council' ||
    taskFamily === 'research'
  );
}

function shouldUseReviewer(
  mode: AndreaPlatformCouncilMode | undefined,
): boolean {
  return (
    mode === 'dual_review' ||
    mode === 'max_iq_council' ||
    mode === 'repair_council'
  );
}

type ProviderParticipationAction = 'call' | 'skip' | 'substitute_openai';

interface ProviderParticipationRolePlan {
  role: CouncilRole;
  providerId: string;
  memberId: string;
  required: boolean;
  action: ProviderParticipationAction;
  substituteProviderId?: string;
  reason: string;
  riskFlag: string;
  healthState?: ProviderHealthSnapshot['state'];
  failureClass?: ProviderHealthSnapshot['failureClass'];
}

interface ProviderParticipationPlan {
  generatedAt: string;
  mode: string;
  status: 'full' | 'degraded' | 'minimal';
  roles: ProviderParticipationRolePlan[];
  skippedProviderIds: string[];
  substitutedRoles: string[];
  riskFlags: string[];
  nextAction: string;
}

function healthForProvider(
  snapshots: ProviderHealthSnapshot[],
  providerId: string,
): ProviderHealthSnapshot | undefined {
  return snapshots.find((snapshot) => snapshot.providerId === providerId);
}

function providerHealthBlocksParticipation(
  snapshot: ProviderHealthSnapshot | undefined,
): boolean {
  return (
    snapshot?.state === 'externally_blocked' ||
    snapshot?.state === 'not_configured' ||
    snapshot?.credentialState === 'missing' ||
    snapshot?.credentialState === 'invalid'
  );
}

function providerFailureSlug(
  snapshot: ProviderHealthSnapshot | undefined,
): string {
  if (!snapshot) return 'unknown';
  if (snapshot.failureClass && snapshot.failureClass !== 'none') {
    return snapshot.failureClass;
  }
  return snapshot.state || 'unknown';
}

function providerBlockReason(
  providerId: string,
  snapshot: ProviderHealthSnapshot | undefined,
): string {
  if (!snapshot) return `${providerId} has no current health snapshot.`;
  if (snapshot.blocker) return snapshot.blocker;
  if (snapshot.nextAction) return snapshot.nextAction;
  return `${providerId} is ${snapshot.state}.`;
}

function runtimeFailureFlag(
  providerId: string,
  fallbackFlag: string,
  failure: string | null | undefined,
): string {
  const normalized = String(failure || '').toLowerCase();
  if (
    /\b(quota|rate[- ]?limit|billing|balance|insufficient|resource_exhausted)\b/.test(
      normalized,
    )
  ) {
    return `${providerId}_quota_or_rate_limit`;
  }
  if (
    /\b(api key|unauthorized|auth|credential|permission)\b/.test(normalized)
  ) {
    return `${providerId}_auth_failure`;
  }
  if (/\b(timeout|timed out|transport|network|fetch|dns)\b/.test(normalized)) {
    return `${providerId}_transport_error`;
  }
  return fallbackFlag;
}

function applyActiveProviderCooldowns(
  snapshots: ProviderHealthSnapshot[],
  checkedAt: string,
): ProviderHealthSnapshot[] {
  let cooldowns: ReturnType<typeof listCognitiveProviderCooldowns> = [];
  try {
    cooldowns = listCognitiveProviderCooldowns({
      status: 'active',
      activeAt: checkedAt,
      limit: 50,
    });
  } catch {
    return snapshots;
  }
  if (cooldowns.length === 0) return snapshots;
  const byProvider = new Map(
    cooldowns.map((cooldown) => [cooldown.providerId, cooldown]),
  );
  return snapshots.map((snapshot) => {
    const cooldown = byProvider.get(snapshot.providerId);
    if (
      !cooldown ||
      (snapshot.state === 'healthy' && snapshot.metadata.liveProbe === 'ok')
    ) {
      return snapshot;
    }
    return {
      ...snapshot,
      state: 'externally_blocked',
      failureClass:
        cooldown.failureClass === 'auth_failure' ||
        cooldown.failureClass === 'quota_or_rate_limit' ||
        cooldown.failureClass === 'transport_error' ||
        cooldown.failureClass === 'missing_credentials' ||
        cooldown.failureClass === 'manual_external'
          ? cooldown.failureClass
          : 'unknown',
      quotaState:
        cooldown.failureClass === 'quota_or_rate_limit'
          ? 'blocked'
          : snapshot.quotaState,
      blocker: cooldown.lastFailure || snapshot.blocker,
      nextAction: cooldown.nextAction || snapshot.nextAction,
      metadata: {
        ...snapshot.metadata,
        cognitiveCooldown: 'active',
        cognitiveCooldownUntil: cooldown.cooldownUntil,
      },
    };
  });
}

function buildProviderParticipationPlan(input: {
  mode: string;
  taskFamily: PlatformTaskFamily;
  useEvidenceScout: boolean;
  useReviewers: boolean;
  calibration: ReturnType<typeof calibrateCouncilMode>;
  providerHealthSnapshots: ProviderHealthSnapshot[];
  generatedAt: string;
}): ProviderParticipationPlan {
  const roles: ProviderParticipationRolePlan[] = [];
  const addRole = (
    role: Omit<ProviderParticipationRolePlan, 'healthState' | 'failureClass'>,
  ) => {
    const snapshot = healthForProvider(
      input.providerHealthSnapshots,
      role.providerId,
    );
    roles.push({
      ...role,
      healthState: snapshot?.state,
      failureClass: snapshot?.failureClass,
    });
  };
  const isHistoryDegraded = (providerId: string) =>
    input.calibration.degradedProviderIds.includes(providerId);
  const skipForHealth = (
    role: CouncilRole,
    providerId: string,
    required: boolean,
  ): ProviderParticipationRolePlan | null => {
    const snapshot = healthForProvider(
      input.providerHealthSnapshots,
      providerId,
    );
    if (!providerHealthBlocksParticipation(snapshot)) return null;
    const slug = providerFailureSlug(snapshot);
    return {
      role,
      providerId,
      memberId: providerId,
      required,
      action: 'skip',
      reason: providerBlockReason(providerId, snapshot),
      riskFlag: `${providerId}_${slug}`,
    };
  };

  if (input.useEvidenceScout) {
    addRole(
      skipForHealth('evidence_scout', 'brave_search', false) || {
        role: 'evidence_scout',
        providerId: 'brave_search',
        memberId: 'brave_search',
        required: false,
        action: 'call',
        reason: 'Public/live evidence scout is available when needed.',
        riskFlag: '',
      },
    );
  }

  addRole(
    skipForHealth('planner', 'openai_cloud', true) || {
      role: 'planner',
      providerId: 'openai_cloud',
      memberId: 'openai_cloud',
      required: true,
      action: 'call',
      reason: 'OpenAI planner remains the primary synthesis route.',
      riskFlag: '',
    },
  );

  if (input.useReviewers) {
    const anthropicHealthSkip = skipForHealth(
      'synthesizer',
      'anthropic_cloud',
      input.mode === 'max_iq_council' || input.mode === 'repair_council',
    );
    addRole(
      anthropicHealthSkip || {
        role: 'synthesizer',
        providerId: 'anthropic_cloud',
        memberId: 'anthropic_cloud',
        required:
          input.mode === 'max_iq_council' || input.mode === 'repair_council',
        action: 'call',
        reason: isHistoryDegraded('anthropic_cloud')
          ? 'Independent reasoner is currently available; recent quality history is degraded and should lower confidence if this role fails again.'
          : 'Independent reasoner is available.',
        riskFlag: '',
      },
    );

    const miniMaxHealthSkip = skipForHealth('critic', 'minimax_cloud', false);
    addRole(
      miniMaxHealthSkip || {
        role: 'critic',
        providerId: 'minimax_cloud',
        memberId: 'minimax_cloud',
        required: false,
        action: 'call',
        reason: isHistoryDegraded('minimax_cloud')
          ? 'Critic route is currently available; recent quality history is degraded and should lower confidence if this role fails again.'
          : 'Critic route is available.',
        riskFlag: '',
      },
    );

    const geminiSnapshot = healthForProvider(
      input.providerHealthSnapshots,
      'gemini_cloud',
    );
    const openAiSnapshot = healthForProvider(
      input.providerHealthSnapshots,
      'openai_cloud',
    );
    const geminiBlocked = providerHealthBlocksParticipation(geminiSnapshot);
    const openAiUsable = !providerHealthBlocksParticipation(openAiSnapshot);
    if (geminiBlocked && openAiUsable) {
      addRole({
        role: 'verifier',
        providerId: 'gemini_cloud',
        memberId: 'gemini_cloud',
        required: true,
        action: 'skip',
        reason: providerBlockReason('gemini_cloud', geminiSnapshot),
        riskFlag: `gemini_cloud_${providerFailureSlug(geminiSnapshot)}`,
      });
      addRole({
        role: 'verifier',
        providerId: 'openai_cloud',
        memberId: 'openai_verifier_fallback',
        required: true,
        action: 'substitute_openai',
        substituteProviderId: 'gemini_cloud',
        reason:
          'OpenAI verifier fallback is planned because Gemini verifier is unavailable or recently degraded.',
        riskFlag: 'verifier_substituted_openai_for_gemini',
      });
    } else {
      addRole(
        skipForHealth('verifier', 'gemini_cloud', true) || {
          role: 'verifier',
          providerId: 'gemini_cloud',
          memberId: 'gemini_cloud',
          required: true,
          action: 'call',
          reason: isHistoryDegraded('gemini_cloud')
            ? 'Gemini verifier is currently available; recent quality history is degraded and should lower confidence if this role fails again.'
            : 'Gemini verifier is available.',
          riskFlag: '',
        },
      );
    }
  }

  const riskFlags = Array.from(
    new Set(roles.filter((role) => role.riskFlag).map((role) => role.riskFlag)),
  );
  const skippedProviderIds = Array.from(
    new Set(
      roles
        .filter((role) => role.action === 'skip')
        .map((role) => role.providerId),
    ),
  );
  const substitutedRoles = roles
    .filter((role) => role.action === 'substitute_openai')
    .map(
      (role) => `${role.role}:${role.substituteProviderId}->${role.providerId}`,
    );
  const requiredBlocked = roles.some(
    (role) =>
      role.required && role.action === 'skip' && role.role !== 'verifier',
  );
  const status =
    requiredBlocked || roles.every((role) => role.action !== 'call')
      ? 'minimal'
      : skippedProviderIds.length > 0 || substitutedRoles.length > 0
        ? 'degraded'
        : 'full';
  return {
    generatedAt: input.generatedAt,
    mode: input.mode,
    status,
    roles,
    skippedProviderIds,
    substitutedRoles,
    riskFlags,
    nextAction:
      status === 'full'
        ? 'Run the council with all planned providers.'
        : status === 'minimal'
          ? 'Use the available fallback answer and repair required provider health before trusting deep council routes.'
          : 'Proceed with degraded-provider wording and rerun provider checks after quota/auth recovery.',
  };
}

function plannedRole(
  plan: ProviderParticipationPlan,
  role: CouncilRole,
  memberId?: string,
): ProviderParticipationRolePlan | undefined {
  return plan.roles.find(
    (item) => item.role === role && (!memberId || item.memberId === memberId),
  );
}

async function callTimed<T>(
  fn: () => Promise<T>,
  now: () => number,
  onError?: (err: unknown) => T,
  timeoutMs = COUNCIL_ROLE_TIMEOUT_MS,
  onTimeout?: () => T,
): Promise<{ result: T; latencyMs: number }> {
  const started = now();
  let result: T;
  try {
    result = await withTimeout(fn(), timeoutMs, onTimeout);
  } catch (err) {
    if (!onError) throw err;
    result = onError(err);
  }
  return { result, latencyMs: Math.max(0, Math.round(now() - started)) };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => T,
): Promise<T> {
  if (!timeoutMs || timeoutMs < 1) return promise;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      if (onTimeout) {
        resolve(onTimeout());
      } else {
        reject(new Error(`council role timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeProviderArtifact(result: unknown): TextProviderResult {
  if (!result || typeof result !== 'object') return {};
  return result as TextProviderResult;
}

function providerFailureFromException(
  providerName: string,
  err: unknown,
): { providerFailure: string; status?: number; requestId?: string } {
  const detail =
    err instanceof Error && err.message
      ? ` ${sanitizeObservableText(err.message, 240)}`
      : '';
  return {
    providerFailure: `${providerName} request failed before Andrea could receive a provider response.${detail}`,
  };
}

function buildCouncilAnswerGuidance(
  verdict: CouncilVerdict,
): AndreaPlatformCouncilAnswerGuidance {
  const status = verdict.status === 'inconclusive' ? 'warn' : verdict.status;
  const bestDirection =
    verdict.answerDirection ||
    'Use the best available local answer and be explicit about uncertainty.';
  const visibleVerdict =
    status === 'pass'
      ? `Proceed with a concise verified answer. ${bestDirection}`
      : status === 'warn'
        ? `Proceed carefully and name uncertainty. ${bestDirection}`
        : status === 'clarify'
          ? `Ask one clarifying question before acting. ${bestDirection}`
          : `Hold or block until the missing requirement is resolved. ${bestDirection}`;
  return {
    status,
    visibleVerdict: sanitizeObservableText(visibleVerdict, 360),
    answerDirection: sanitizeObservableText(bestDirection, 360),
    confidence: verdict.confidence,
    uncertainty: sanitizeObservableText(verdict.uncertainty, 320),
    clarifyingQuestion: verdict.clarifyingQuestion || null,
    blocker: verdict.blocker || null,
    sourceMemberIds: Array.from(new Set(verdict.sourceMemberIds)),
    recommendedAction: verdict.recommendedAction,
    approvalNeed: verdict.approvalNeed,
    evidenceGrade: verdict.evidenceGrade,
    evidenceIds: Array.from(new Set(verdict.evidenceIds)),
    riskFlags: Array.from(new Set(verdict.riskFlags)),
    actionDirectives: verdict.actionDirectives,
  };
}

function buildRunnerUltrathinkTrace(input: {
  mode: string;
  metadata?: Record<string, string>;
  anthropicTrace?: CouncilUltrathinkTrace;
}): CouncilUltrathinkTrace | undefined {
  const triggerValue = input.metadata?.thinking_trigger || '';
  const trigger =
    triggerValue === 'ultracode'
      ? 'ultracode'
      : triggerValue === 'ultrathink'
        ? 'ultrathink'
        : input.metadata?.thinking_control === 'deep'
          ? 'deep'
          : input.mode === 'max_iq_council'
            ? 'deep'
            : 'none';
  const requested =
    trigger !== 'none' ||
    input.mode === 'max_iq_council' ||
    input.mode === 'repair_council';
  if (!requested) return undefined;
  return {
    requested,
    trigger,
    mode: input.mode,
    providerId: input.anthropicTrace?.providerId || 'anthropic_cloud',
    model: input.anthropicTrace?.model || null,
    adaptiveThinkingRequested:
      input.anthropicTrace?.adaptiveThinkingRequested ?? true,
    adaptiveThinkingSupported:
      input.anthropicTrace?.adaptiveThinkingSupported ?? false,
    effortRequested:
      input.anthropicTrace?.effortRequested ||
      (input.mode === 'max_iq_council' ? 'max' : 'high'),
    effortSent: input.anthropicTrace?.effortSent || null,
    display: input.anthropicTrace?.display || 'unsupported',
    rawThinkingStored: false,
    hiddenReasoningExposed: false,
  };
}

function sanitizeCouncilEvent(
  event: AndreaPlatformCouncilEventInput,
): AndreaPlatformCouncilEventInput {
  return {
    ...event,
    inputSummary: event.inputSummary
      ? sanitizeObservableText(event.inputSummary, 420)
      : undefined,
    outputSummary: event.outputSummary
      ? sanitizeObservableText(event.outputSummary, 420)
      : undefined,
    visiblePrompt: event.visiblePrompt
      ? sanitizeObservableText(event.visiblePrompt, 1800)
      : event.visiblePrompt,
    visibleResponse: event.visibleResponse
      ? sanitizeObservableText(event.visibleResponse, 1800)
      : event.visibleResponse,
    riskFlags: event.riskFlags?.map((flag) =>
      sanitizeObservableText(flag, 100),
    ),
    metadata: redactCouncilMetadata(event.metadata, 420),
  };
}

function sanitizeCouncilMember(
  member: AndreaPlatformCouncilMemberResultInput,
): AndreaPlatformCouncilMemberResultInput {
  return {
    ...member,
    inputSummary: member.inputSummary
      ? sanitizeObservableText(member.inputSummary, 420)
      : undefined,
    outputSummary: member.outputSummary
      ? sanitizeObservableText(member.outputSummary, 420)
      : undefined,
    visiblePrompt: member.visiblePrompt
      ? sanitizeObservableText(member.visiblePrompt, 1800)
      : member.visiblePrompt,
    visibleResponse: member.visibleResponse
      ? sanitizeObservableText(member.visibleResponse, 1800)
      : member.visibleResponse,
    riskFlags: member.riskFlags?.map((flag) =>
      sanitizeObservableText(flag, 100),
    ),
    metadata: redactCouncilMetadata(member.metadata, 420),
    memberId: member.memberId,
    role: member.role,
    summary: sanitizeObservableText(member.summary, 420),
    critique: member.critique
      ? sanitizeObservableText(member.critique, 1200)
      : member.critique,
    recommendedRoute: member.recommendedRoute
      ? sanitizeObservableText(member.recommendedRoute, 160)
      : member.recommendedRoute,
    confidence: member.confidence,
  };
}

export async function runObservableProviderCouncil(
  input: ObservableProviderCouncilInput,
  deps: ProviderCouncilRunnerDeps = {},
): Promise<AndreaPlatformProviderCouncilResult | null> {
  const emitProviderCouncil =
    deps.emitProviderCouncil || emitAndreaPlatformProviderCouncil;
  const emitCouncilEvent =
    deps.emitCouncilEvent || emitAndreaPlatformCouncilEvent;
  const emitMemberResult =
    deps.emitMemberResult || emitAndreaPlatformCouncilMemberResult;
  const finalizeCouncil = deps.finalizeCouncil || finalizeAndreaPlatformCouncil;
  const runOpenAi = deps.runOpenAi || runOpenAiChatText;
  const runAnthropic = deps.runAnthropic || runAnthropicText;
  const runMiniMax = deps.runMiniMax || runMiniMaxAnthropicText;
  const runGemini = deps.runGemini || runGeminiOpenAiText;
  const searchBrave = deps.searchBrave || searchBraveWeb;
  const now = deps.now || (() => Date.now());

  const requestedMode = input.requestedMode || 'dual_review';
  const calibration = calibrateCouncilMode({
    taskFamily: input.taskFamily,
    requestedMode,
    riskLevel: input.riskLevel,
    allowedSideEffects: input.allowedSideEffects,
    thinkingControl: input.metadata?.thinking_control || null,
  });
  const calibratedInput: ObservableProviderCouncilInput = {
    ...input,
    requestedMode: calibration.chosenMode as AndreaPlatformCouncilMode,
    metadata: {
      ...(input.metadata || {}),
      council_v3_calibration_reason: calibration.reason,
      council_v3_calibration_changed: String(calibration.changedMode),
      council_v3_recent_runs: String(calibration.recentRuns),
      council_v3_degraded_providers: calibration.degradedProviderIds.join(','),
    },
  };
  const emittedCouncil = await emitProviderCouncil(calibratedInput);
  const localCouncilRunId = `local-council:${input.correlationId || now().toString(36)}`;
  const council: AndreaPlatformProviderCouncilResult =
    emittedCouncil?.councilRunId
      ? emittedCouncil
      : {
          councilRunId: localCouncilRunId,
          mode: calibratedInput.requestedMode || 'dual_review',
          status: 'local_only',
          traceId: input.correlationId || localCouncilRunId,
          finalRoute: calibratedInput.requestedMode || 'dual_review',
          answerStrategy: 'local_verified_synthesis',
          confidence: 0.5,
          approvalRequired: input.allowedSideEffects === 'approval_required',
          memberCount: 0,
          skippedMemberCount: 0,
          blockedMemberCount: 0,
          riskFlags: ['platform_council_record_local_fallback'],
        };

  const councilRunId = council.councilRunId || localCouncilRunId;
  const mode =
    council.mode ||
    calibratedInput.requestedMode ||
    input.requestedMode ||
    'single_model';
  const budgetPolicy = resolveCouncilRunBudget(mode);
  const checkedAt = new Date().toISOString();
  const rawProviderHealthSnapshots =
    deps.providerHealthSnapshots || collectProviderHealthSnapshots(checkedAt);
  const providerHealthSnapshots = applyActiveProviderCooldowns(
    rawProviderHealthSnapshots,
    checkedAt,
  );
  const evidenceScoutEnabled = shouldUseEvidenceScout(mode, input.taskFamily);
  const reviewersEnabled = shouldUseReviewer(mode);
  const participationPlan = buildProviderParticipationPlan({
    mode,
    taskFamily: input.taskFamily,
    useEvidenceScout: evidenceScoutEnabled,
    useReviewers: reviewersEnabled,
    calibration,
    providerHealthSnapshots,
    generatedAt: checkedAt,
  });
  const roleSemaphore = new Semaphore(budgetPolicy.maxConcurrency);
  const failureGuard = new CouncilFailureGuard(2);
  const correlationId = input.correlationId || council.traceId || councilRunId;
  const goal = sanitizeObservableText(input.goal, 900);
  const evidencePack = buildCouncilEvidencePack({
    goal,
    taskFamily: input.taskFamily,
    groupFolder: input.groupFolder,
    correlationId,
    requiredEvidence: input.requiredEvidence || 'unknown',
    rawContentPolicy: input.rawContentPolicy || 'sanitized_snippets',
    metadata: input.metadata,
  });
  const observedMemberIds: string[] = [];
  const observedRoles: string[] = [];
  const emittedEventIds: string[] = [];
  const providerFailures: string[] = [];
  const observedEvidenceIds: string[] = [];
  const memberArtifacts: CouncilMemberArtifact[] = [];
  let anthropicThinkingTrace: CouncilUltrathinkTrace | undefined;
  let retryCount = 0;
  let loopGuardTriggered = false;
  let evidenceSummary = summarizeCouncilEvidencePack(evidencePack);
  let evidenceIds: string[] = evidencePack.cards.map((card) => card.evidenceId);

  function recordFailureSignature(input: {
    role: string;
    providerId: string;
    failure: string;
  }): string[] {
    const result = failureGuard.record(input);
    if (!result.repeated || !result.riskFlag) return [];
    loopGuardTriggered = true;
    return [result.riskFlag];
  }

  async function recordEvent(
    event: AndreaPlatformCouncilEventInput,
  ): Promise<void> {
    const sanitized = sanitizeCouncilEvent(event);
    const response = await emitCouncilEvent(sanitized);
    const eventRecord =
      response && typeof response === 'object'
        ? ((response as Record<string, unknown>).event as
            | Record<string, unknown>
            | undefined) || (response as Record<string, unknown>)
        : undefined;
    const eventId =
      typeof eventRecord?.event_id === 'string'
        ? eventRecord.event_id
        : typeof eventRecord?.eventId === 'string'
          ? eventRecord.eventId
          : undefined;
    if (eventId) emittedEventIds.push(eventId);
    if (sanitized.evidenceIds?.length)
      observedEvidenceIds.push(...sanitized.evidenceIds);
  }

  async function recordMember(
    member: AndreaPlatformCouncilMemberResultInput,
  ): Promise<void> {
    const sanitized = sanitizeCouncilMember(member);
    observedMemberIds.push(sanitized.memberId);
    observedRoles.push(sanitized.role);
    if (sanitized.evidenceIds?.length)
      observedEvidenceIds.push(...sanitized.evidenceIds);
    if (sanitized.status === 'blocked') {
      const repeatedFailureFlags = recordFailureSignature({
        role: sanitized.role,
        providerId: sanitized.providerId || sanitized.memberId,
        failure:
          sanitized.visibleResponse ||
          sanitized.summary ||
          sanitized.riskFlags?.[0] ||
          `${sanitized.memberId}_unavailable`,
      });
      if (repeatedFailureFlags.length > 0) {
        sanitized.riskFlags = Array.from(
          new Set([...(sanitized.riskFlags || []), ...repeatedFailureFlags]),
        );
        providerFailures.push(...repeatedFailureFlags);
      }
      providerFailures.push(
        sanitized.riskFlags?.[0] || `${sanitized.memberId}_unavailable`,
      );
    }
    memberArtifacts.push(
      parseCouncilMemberArtifact({
        memberId: sanitized.memberId,
        providerId: sanitized.providerId || sanitized.memberId,
        role: sanitized.role,
        text:
          sanitized.visibleResponse ||
          sanitized.critique ||
          sanitized.summary ||
          '',
        status:
          sanitized.status === 'completed'
            ? 'completed'
            : sanitized.status === 'blocked'
              ? 'blocked'
              : 'skipped',
        defaultConfidence:
          typeof sanitized.confidence === 'number' ? sanitized.confidence : 0.5,
        defaultRiskFlags: sanitized.riskFlags,
        evidenceIds: sanitized.evidenceIds,
      }),
    );
    const response = await emitMemberResult(sanitized);
    const eventRecord =
      response && typeof response === 'object'
        ? ((response as Record<string, unknown>).event as
            | Record<string, unknown>
            | undefined)
        : undefined;
    const eventId =
      typeof eventRecord?.event_id === 'string'
        ? eventRecord.event_id
        : typeof eventRecord?.eventId === 'string'
          ? eventRecord.eventId
          : undefined;
    if (eventId) emittedEventIds.push(eventId);
  }

  await recordEvent({
    councilRunId,
    correlationId,
    eventType: 'start',
    actorId: 'andrea_conductor',
    actorRole: 'conductor',
    providerId: 'andrea_platform',
    status: 'running',
    inputSummary: `Start ${mode} for ${input.taskFamily}.`,
    outputSummary: 'Typed council assignments will run in bounded order.',
    visiblePrompt: `Council goal: ${goal}`,
    visibleResponse:
      'Conductor will assign evidence scout, planner, independent reasoner, critic, verifier, and platform arbiter as policy allows.',
    estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
    metadata: {
      mode,
      task_family: input.taskFamily,
      budget_max_roles: String(budgetPolicy.maxRoles),
      budget_timeout_ms: String(budgetPolicy.roleTimeoutMs),
      provider_participation_status: participationPlan.status,
      provider_participation_skipped:
        participationPlan.skippedProviderIds.join(','),
      provider_participation_substitutions:
        participationPlan.substitutedRoles.join(','),
    },
  });

  async function recordPlannedSkip(
    rolePlan: ProviderParticipationRolePlan,
    prompt: string,
  ): Promise<void> {
    await recordMember({
      councilRunId,
      correlationId,
      memberId: rolePlan.memberId,
      role: rolePlan.role,
      providerId: rolePlan.providerId,
      status: rolePlan.required ? 'blocked' : 'skipped',
      summary: rolePlan.reason,
      confidence: 0,
      visiblePrompt: prompt,
      visibleResponse: rolePlan.reason,
      latencyMs: 0,
      estimatedTokenCount: estimateTokens(prompt, rolePlan.reason),
      estimatedCostTier: 'low',
      riskFlags: [rolePlan.riskFlag].filter(Boolean),
      metadata: {
        provider_participation_action: rolePlan.action,
        health_state: rolePlan.healthState || '',
        failure_class: rolePlan.failureClass || '',
      },
    });
  }

  if (evidenceScoutEnabled) {
    const prompt = `Gather public/live evidence for this sanitized Andrea task: ${goal}`;
    const scoutPlan = plannedRole(participationPlan, 'evidence_scout');
    if (scoutPlan?.action === 'skip') {
      await recordPlannedSkip(scoutPlan, prompt);
    } else {
      const { result, latencyMs } = await callTimed(
        () => searchBrave(goal),
        now,
        (err) => providerFailureFromException('Brave Search', err),
        budgetPolicy.roleTimeoutMs,
      );
      const brave = result && typeof result === 'object' ? result : null;
      if (brave && 'results' in brave && Array.isArray(brave.results)) {
        evidenceSummary = brave.results
          .slice(0, 3)
          .map((item) => `${item.title}: ${item.description} (${item.url})`)
          .join('\n');
        evidenceIds = brave.results
          .slice(0, 3)
          .map((item, index) => `brave:${index + 1}:${item.url.slice(0, 80)}`);
        brave.results.slice(0, 3).forEach((item, index) => {
          evidencePack.cards.push({
            evidenceId: evidenceIds[index] || `brave:${index + 1}`,
            sourceClass: 'public_web',
            evidenceGrade: 'partial',
            freshness: 'fresh',
            sensitivity: 'public',
            summary: sanitizeObservableText(
              `${item.title}: ${item.description} (${item.url})`,
              360,
            ),
          });
        });
        refreshCouncilEvidencePackScorecard(evidencePack);
        await recordMember({
          councilRunId,
          correlationId,
          memberId: 'brave_search',
          role: 'evidence_scout',
          providerId: 'brave_search',
          status: 'completed',
          summary: `Brave returned ${brave.results.length} public evidence result(s).`,
          confidence: brave.results.length > 0 ? 0.82 : 0.35,
          visiblePrompt: prompt,
          visibleResponse: evidenceSummary || 'No Brave results returned.',
          evidenceIds,
          latencyMs,
          estimatedTokenCount: estimateTokens(prompt, evidenceSummary),
          estimatedCostTier: 'low',
          metadata: {
            brave_request_id: brave.requestId || '',
            result_count: String(brave.results.length),
          },
        });
      } else {
        const failure = normalizeProviderArtifact(brave);
        await recordMember({
          councilRunId,
          correlationId,
          memberId: 'brave_search',
          role: 'evidence_scout',
          providerId: 'brave_search',
          status: 'blocked',
          summary:
            failure.providerFailure ||
            'Brave Search is unavailable for this council run.',
          confidence: 0,
          visiblePrompt: prompt,
          visibleResponse:
            failure.providerFailure || 'No live evidence available.',
          latencyMs,
          estimatedCostTier: 'low',
          riskFlags: ['brave_unavailable_saved_context'],
        });
      }
    }
  }

  const plannerPrompt = memberPrompt({
    role: 'planner',
    goal,
    taskFamily: input.taskFamily,
    evidenceSummary,
  });
  const synthesizerPrompt = reviewersEnabled
    ? memberPrompt({
        role: 'synthesizer',
        goal,
        taskFamily: input.taskFamily,
        evidenceSummary,
      })
    : null;
  const plannerPlan = plannedRole(participationPlan, 'planner', 'openai_cloud');
  const plannerTask =
    plannerPlan?.action === 'skip'
      ? Promise.resolve({
          result: { providerFailure: plannerPlan.reason },
          latencyMs: 0,
        })
      : callTimed(
          () =>
            roleSemaphore.run(() =>
              runOpenAi({
                system:
                  'You are Andrea council chief planner. Be concise, evidence-aware, and approval-aware.',
                prompt: plannerPrompt,
                modelTier:
                  mode === 'max_iq_council' || mode === 'repair_council'
                    ? 'complex'
                    : 'standard',
                maxTokens: 700,
                temperature: 0.2,
              }),
            ),
          now,
          (err) => providerFailureFromException('OpenAI planner', err),
          budgetPolicy.roleTimeoutMs,
        );
  const synthesizerPlan = plannedRole(
    participationPlan,
    'synthesizer',
    'anthropic_cloud',
  );
  const synthesizerTask = synthesizerPrompt
    ? synthesizerPlan?.action === 'skip'
      ? Promise.resolve({
          result: { providerFailure: synthesizerPlan.reason },
          latencyMs: 0,
        })
      : callTimed(
          () =>
            roleSemaphore.run(() =>
              runAnthropic({
                system:
                  'You are Andrea council independent reasoner. Find ambiguity, missing context, and the best concise answer direction.',
                prompt: synthesizerPrompt,
                modelTier: mode === 'max_iq_council' ? 'complex' : 'fast',
                reasoningEffort: mode === 'max_iq_council' ? 'max' : 'medium',
                adaptiveThinking: mode === 'max_iq_council',
                maxTokens: 700,
                temperature: 0.2,
              }),
            ),
          now,
          (err) => providerFailureFromException('Anthropic reasoner', err),
          budgetPolicy.roleTimeoutMs,
        )
    : Promise.resolve(null);
  const [plannerSettled, synthesizerSettled] = await Promise.allSettled([
    plannerTask,
    synthesizerTask,
  ]);
  const plannerCall =
    plannerSettled.status === 'fulfilled'
      ? plannerSettled.value
      : {
          result: providerFailureFromException(
            'OpenAI planner',
            plannerSettled.reason,
          ),
          latencyMs: 0,
        };
  const planner = normalizeProviderArtifact(plannerCall.result);
  const plannerText =
    planner.text ||
    planner.providerFailure ||
    'OpenAI planner produced no artifact.';
  await recordMember({
    councilRunId,
    correlationId,
    memberId: 'openai_cloud',
    role: 'planner',
    providerId: 'openai_cloud',
    status: planner.text ? 'completed' : 'blocked',
    model: planner.model || 'openai_configured_model',
    summary: planner.text
      ? 'OpenAI planner produced an evidence-aware plan.'
      : plannerText,
    confidence: planner.text ? 0.82 : 0,
    visiblePrompt: plannerPrompt,
    visibleResponse: plannerText,
    evidenceIds,
    latencyMs: plannerCall.latencyMs,
    estimatedTokenCount: estimateTokens(plannerPrompt, plannerText),
    estimatedCostTier:
      mode === 'max_iq_council' || mode === 'repair_council'
        ? 'high'
        : 'medium',
    riskFlags: planner.text
      ? []
      : [
          plannerPlan?.riskFlag ||
            runtimeFailureFlag(
              'openai_cloud',
              'openai_planner_unavailable',
              plannerText,
            ),
        ].filter(Boolean),
    metadata: {
      request_id: planner.requestId || '',
      provider_participation_action: plannerPlan?.action || 'call',
    },
  });

  let synthesizerText = '';
  let criticText = '';
  let verifierText = '';
  if (reviewersEnabled && synthesizerPrompt) {
    const synthesizerCall =
      synthesizerSettled.status === 'fulfilled' && synthesizerSettled.value
        ? synthesizerSettled.value
        : {
            result: providerFailureFromException(
              'Anthropic reasoner',
              synthesizerSettled.status === 'rejected'
                ? synthesizerSettled.reason
                : new Error('Anthropic reasoner was not scheduled.'),
            ),
            latencyMs: 0,
          };
    const synthesizer = normalizeProviderArtifact(synthesizerCall.result);
    anthropicThinkingTrace = synthesizer.thinkingTrace;
    synthesizerText =
      synthesizer.text ||
      synthesizer.providerFailure ||
      'Anthropic independent reasoner produced no artifact.';
    await recordMember({
      councilRunId,
      correlationId,
      memberId: 'anthropic_cloud',
      role: 'synthesizer',
      providerId: 'anthropic_cloud',
      status: synthesizer.text
        ? 'completed'
        : synthesizerPlan?.action === 'skip' && !synthesizerPlan.required
          ? 'skipped'
          : 'blocked',
      model: synthesizer.model || 'claude_configured_model',
      summary: synthesizer.text
        ? 'Anthropic independently reasoned about ambiguity and answer shape.'
        : synthesizerText,
      critique: synthesizerText,
      confidence: synthesizer.text ? 0.8 : 0,
      visiblePrompt: synthesizerPrompt,
      visibleResponse: synthesizerText,
      evidenceIds,
      latencyMs: synthesizerCall.latencyMs,
      estimatedTokenCount: estimateTokens(synthesizerPrompt, synthesizerText),
      estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
      riskFlags: synthesizer.text
        ? []
        : [
            synthesizerPlan?.riskFlag ||
              runtimeFailureFlag(
                'anthropic_cloud',
                'anthropic_reasoner_unavailable',
                synthesizerText,
              ),
          ].filter(Boolean),
      metadata: {
        request_id: synthesizer.requestId || '',
        provider_participation_action: synthesizerPlan?.action || 'call',
        adaptive_thinking_requested: String(
          synthesizer.thinkingTrace?.adaptiveThinkingRequested === true,
        ),
        adaptive_thinking_supported: String(
          synthesizer.thinkingTrace?.adaptiveThinkingSupported === true,
        ),
        thinking_effort_sent: synthesizer.thinkingTrace?.effortSent || '',
        thinking_display: synthesizer.thinkingTrace?.display || '',
        raw_thinking_stored: 'false',
      },
    });

    const criticPrompt = memberPrompt({
      role: 'critic',
      goal,
      taskFamily: input.taskFamily,
      evidenceSummary,
      plannerText,
      synthesizerText,
    });
    const criticPlan = plannedRole(
      participationPlan,
      'critic',
      'minimax_cloud',
    );
    if (criticPlan?.action === 'skip') {
      criticText = criticPlan.reason;
      await recordPlannedSkip(criticPlan, criticPrompt);
    } else {
      let criticCall = await callTimed(
        () =>
          roleSemaphore.run(() =>
            runMiniMax({
              system:
                'You are Andrea council challenger. Find missing assumptions and safer alternatives.',
              prompt: criticPrompt,
              modelTier: mode === 'max_iq_council' ? 'complex' : 'fast',
              maxTokens: 700,
              temperature: 0.25,
            }),
          ),
        now,
        (err) => providerFailureFromException('MiniMax critic', err),
        budgetPolicy.roleTimeoutMs,
      );
      let critic = normalizeProviderArtifact(criticCall.result);
      let criticFallbackReason = '';
      if (!critic.text && budgetPolicy.fallbackAllowed) {
        criticFallbackReason =
          critic.providerFailure ||
          'MiniMax complex critic produced no artifact.';
        retryCount += 1;
        recordFailureSignature({
          role: 'critic',
          providerId: 'minimax_cloud',
          failure: criticFallbackReason,
        }).forEach((flag) => providerFailures.push(flag));
        const fallbackCall = await callTimed(
          () =>
            roleSemaphore.run(() =>
              runMiniMax({
                system:
                  'You are Andrea council challenger. Use the fast critic route to find missing assumptions and safer alternatives.',
                prompt: [
                  criticPrompt,
                  `Primary MiniMax critic fallback reason: ${criticFallbackReason}`,
                  'Produce a concise challenge now.',
                ].join('\n'),
                modelTier: 'fast',
                maxTokens: 700,
                temperature: 0.2,
              }),
            ),
          now,
          (err) => providerFailureFromException('MiniMax fast critic', err),
          budgetPolicy.roleTimeoutMs,
        );
        const fallback = normalizeProviderArtifact(fallbackCall.result);
        if (fallback.text) {
          critic = fallback;
          criticCall = {
            result: fallbackCall.result,
            latencyMs: criticCall.latencyMs + fallbackCall.latencyMs,
          };
        }
      }
      criticText =
        critic.text ||
        critic.providerFailure ||
        'MiniMax critic produced no artifact.';
      await recordMember({
        councilRunId,
        correlationId,
        memberId: 'minimax_cloud',
        role: 'critic',
        providerId: 'minimax_cloud',
        status: critic.text ? 'completed' : 'blocked',
        model: critic.model || 'MiniMax-M2.7',
        summary: critic.text
          ? 'MiniMax critic challenged the plan.'
          : criticText,
        critique: criticText,
        confidence: critic.text ? 0.78 : 0,
        visiblePrompt: criticPrompt,
        visibleResponse: criticText,
        evidenceIds,
        latencyMs: criticCall.latencyMs,
        estimatedTokenCount: estimateTokens(criticPrompt, criticText),
        estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
        riskFlags: critic.text
          ? criticFallbackReason
            ? ['minimax_fast_fallback_used']
            : []
          : [
              criticPlan?.riskFlag ||
                runtimeFailureFlag(
                  'minimax_cloud',
                  'minimax_critic_unavailable',
                  criticText,
                ),
            ].filter(Boolean),
        metadata: {
          request_id: critic.requestId || '',
          provider_participation_action: criticPlan?.action || 'call',
          fallback_reason: critic.text ? criticFallbackReason : '',
        },
      });
    }

    const verifierPrompt = memberPrompt({
      role: 'verifier',
      goal,
      taskFamily: input.taskFamily,
      evidenceSummary,
      plannerText,
      synthesizerText,
      criticText,
    });
    let verifierPromptForCall = verifierPrompt;
    const geminiVerifierPlan = plannedRole(
      participationPlan,
      'verifier',
      'gemini_cloud',
    );
    const openAiVerifierPlan = plannedRole(
      participationPlan,
      'verifier',
      'openai_verifier_fallback',
    );
    let verifierCall: { result: unknown; latencyMs: number } = {
      result: {},
      latencyMs: 0,
    };
    let verifier: TextProviderResult = {};
    let verifierFallbackReason = '';
    if (
      geminiVerifierPlan?.action === 'skip' &&
      openAiVerifierPlan?.action === 'substitute_openai'
    ) {
      await recordPlannedSkip(geminiVerifierPlan, verifierPrompt);
      verifierFallbackReason = geminiVerifierPlan.reason;
      verifierPromptForCall = [
        verifierPrompt,
        `Gemini verifier skipped before call: ${verifierFallbackReason}`,
        'Act as the fallback verifier. Name the reduced provider independence and produce a concise pass/warn/block verdict.',
      ].join('\n');
      verifierCall = await callTimed(
        () =>
          roleSemaphore.run(() =>
            runOpenAi({
              system:
                'You are Andrea council fallback verifier. Verify independently from the planner as much as possible, and name reduced provider independence.',
              prompt: verifierPromptForCall,
              modelTier:
                mode === 'max_iq_council' || mode === 'repair_council'
                  ? 'complex'
                  : 'standard',
              maxTokens: 700,
              temperature: 0.15,
            }),
          ),
        now,
        (err) => providerFailureFromException('OpenAI fallback verifier', err),
        budgetPolicy.roleTimeoutMs,
      );
      verifier = normalizeProviderArtifact(verifierCall.result);
      verifierText =
        verifier.text ||
        verifier.providerFailure ||
        'OpenAI fallback verifier produced no artifact.';
      await recordMember({
        councilRunId,
        correlationId,
        memberId: 'openai_verifier_fallback',
        role: 'verifier',
        providerId: 'openai_cloud',
        status: verifier.text ? 'completed' : 'blocked',
        model: verifier.model || 'openai_configured_model',
        summary: verifier.text
          ? 'OpenAI fallback verifier checked the council result after Gemini was skipped.'
          : verifierText,
        critique: verifierText,
        confidence: verifier.text ? 0.68 : 0,
        visiblePrompt: verifierPromptForCall,
        visibleResponse: verifierText,
        evidenceIds,
        latencyMs: verifierCall.latencyMs,
        estimatedTokenCount: estimateTokens(verifierPrompt, verifierText),
        estimatedCostTier:
          mode === 'max_iq_council' || mode === 'repair_council'
            ? 'high'
            : 'medium',
        riskFlags: verifier.text
          ? [
              'verifier_substituted_openai_for_gemini',
              'provider_independence_reduced',
            ]
          : [
              openAiVerifierPlan.riskFlag,
              'openai_fallback_verifier_unavailable',
            ],
        metadata: {
          request_id: verifier.requestId || '',
          provider_participation_action: 'substitute_openai',
          substitutes_for: 'gemini_cloud',
          fallback_reason: verifierFallbackReason,
        },
      });
    } else if (geminiVerifierPlan?.action === 'skip') {
      verifierFallbackReason = geminiVerifierPlan.reason;
      verifier = { providerFailure: verifierFallbackReason };
      await recordPlannedSkip(geminiVerifierPlan, verifierPrompt);
    } else {
      verifierCall = await callTimed(
        () =>
          roleSemaphore.run(() =>
            runGemini({
              system:
                'You are Andrea council independent verifier. Produce a pass/warn/block verdict with evidence and safety notes.',
              prompt: verifierPromptForCall,
              modelTier: mode === 'max_iq_council' ? 'critic' : 'fast',
              maxTokens: 700,
              temperature: 0.2,
            }),
          ),
        now,
        (err) => providerFailureFromException('Gemini verifier', err),
        budgetPolicy.roleTimeoutMs,
      );
      verifier = normalizeProviderArtifact(verifierCall.result);
    }
    if (
      !verifier.text &&
      budgetPolicy.fallbackAllowed &&
      geminiVerifierPlan?.action !== 'skip'
    ) {
      verifierFallbackReason =
        verifier.providerFailure || 'Gemini Pro verifier produced no artifact.';
      retryCount += 1;
      recordFailureSignature({
        role: 'verifier',
        providerId: 'gemini_cloud',
        failure: verifierFallbackReason,
      }).forEach((flag) => providerFailures.push(flag));
      verifierPromptForCall = [
        verifierPrompt,
        `Primary Gemini Pro verifier fallback reason: ${verifierFallbackReason}`,
        'Use the fast verifier model to produce a concise pass/warn/block verdict now.',
      ].join('\n');
      const fallbackCall = await callTimed(
        () =>
          roleSemaphore.run(() =>
            runGemini({
              system:
                'You are Andrea council independent verifier. Produce a concise pass/warn/block verdict with evidence and safety notes.',
              prompt: verifierPromptForCall,
              modelTier: 'fast',
              maxTokens: 700,
              temperature: 0.15,
            }),
          ),
        now,
        (err) => providerFailureFromException('Gemini fast verifier', err),
        budgetPolicy.roleTimeoutMs,
      );
      const fallback = normalizeProviderArtifact(fallbackCall.result);
      if (fallback.text) {
        verifier = fallback;
        verifierCall = {
          result: fallbackCall.result,
          latencyMs: verifierCall.latencyMs + fallbackCall.latencyMs,
        };
      }
    }
    verifierText =
      verifier.text ||
      verifier.providerFailure ||
      'Gemini verifier produced no artifact.';
    if (geminiVerifierPlan?.action !== 'skip') {
      await recordMember({
        councilRunId,
        correlationId,
        memberId: 'gemini_cloud',
        role: 'verifier',
        providerId: 'gemini_cloud',
        status: verifier.text ? 'completed' : 'blocked',
        model: verifier.model || 'gemini-2.5-pro',
        summary: verifier.text
          ? verifierFallbackReason
            ? 'Gemini fast verifier checked the council result after Pro fallback.'
            : 'Gemini verifier checked the council result.'
          : verifierText,
        critique: verifierText,
        confidence: verifier.text ? 0.8 : 0,
        visiblePrompt: verifierPromptForCall,
        visibleResponse: verifierText,
        evidenceIds,
        latencyMs: verifierCall.latencyMs,
        estimatedTokenCount: estimateTokens(verifierPrompt, verifierText),
        estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
        riskFlags: verifier.text
          ? verifierFallbackReason
            ? ['gemini_fast_fallback_used']
            : []
          : [
              geminiVerifierPlan?.riskFlag ||
                runtimeFailureFlag(
                  'gemini_cloud',
                  'gemini_verifier_unavailable',
                  verifierText,
                ),
            ],
        metadata: {
          request_id: verifier.requestId || '',
          provider_participation_action: geminiVerifierPlan?.action || 'call',
          fallback_reason: verifier.text ? verifierFallbackReason : '',
        },
      });
    }
  }

  const providerFailuresUnique = Array.from(
    new Set([...providerFailures, ...participationPlan.riskFlags]),
  );
  const finalBudget = finalizeCouncilRunBudget(budgetPolicy, {
    usedRoles: memberArtifacts.length,
    retryCount,
    loopGuardTriggered,
  });
  const ultrathinkTrace = buildRunnerUltrathinkTrace({
    mode,
    metadata: calibratedInput.metadata,
    anthropicTrace: anthropicThinkingTrace,
  });
  const structuredVerdict = buildCouncilVerdict({
    mode,
    artifacts: memberArtifacts,
    evidencePack,
    providerFailures: providerFailuresUnique,
    allowedSideEffects: input.allowedSideEffects,
    runBudget: finalBudget,
    councilRunId,
    ultrathinkTrace,
  });
  const answerGuidance = buildCouncilAnswerGuidance(structuredVerdict);
  const skippedMemberCount = memberArtifacts.filter(
    (artifact) => artifact.status === 'skipped',
  ).length;
  const blockedMemberCount = structuredVerdict.blockedMemberCount;
  const structuredVerdictSummary = {
    status: structuredVerdict.status,
    recommendedAction: structuredVerdict.recommendedAction,
    confidence: structuredVerdict.confidence,
    evidenceGrade: structuredVerdict.evidenceGrade,
    approvalNeed: structuredVerdict.approvalNeed,
    riskFlags: Array.from(new Set(structuredVerdict.riskFlags)),
    evidenceIds: Array.from(new Set(structuredVerdict.evidenceIds)),
    actionDirectives: structuredVerdict.actionDirectives,
    ultrathinkTrace: structuredVerdict.ultrathinkTrace,
    usableMemberCount: structuredVerdict.usableMemberCount,
    blockedMemberCount,
    confidenceMath: structuredVerdict.confidenceMath,
    schemaStatusSummary: structuredVerdict.schemaStatusSummary,
    evidenceScorecard: structuredVerdict.replayArtifact?.evidenceScorecard,
    budget: finalBudget,
    providerParticipation: {
      status: participationPlan.status,
      generatedAt: participationPlan.generatedAt,
      skippedProviderIds: participationPlan.skippedProviderIds,
      substitutedRoles: participationPlan.substitutedRoles,
      riskFlags: participationPlan.riskFlags,
      nextAction: participationPlan.nextAction,
      roles: participationPlan.roles.map((role) => ({
        role: role.role,
        providerId: role.providerId,
        memberId: role.memberId,
        required: role.required,
        action: role.action,
        substituteProviderId: role.substituteProviderId || null,
        reason: sanitizeObservableText(role.reason, 240),
        riskFlag: role.riskFlag,
        healthState: role.healthState || '',
        failureClass: role.failureClass || '',
      })),
    },
    replaySummary: structuredVerdict.replayArtifact?.replaySummary || '',
    replayArtifact: structuredVerdict.replayArtifact,
    quality: {
      ledgerVersion: 'v3',
      retention: '90d_or_1000_runs',
      rawPromptsStored: false,
      rawPrivateBodiesStored: false,
      outcomeSignalCount: 0,
    },
    calibration: {
      requestedMode: calibration.requestedMode,
      chosenMode: mode,
      changedMode: calibration.changedMode,
      protectedMode: calibration.protectedMode,
      reason: calibration.reason,
      recentRuns: calibration.recentRuns,
      lowConfidenceRuns: calibration.lowConfidenceRuns,
      schemaInvalidRuns: calibration.schemaInvalidRuns,
      verifierBlockRuns: calibration.verifierBlockRuns,
      negativeFeedbackRuns: calibration.negativeFeedbackRuns,
      degradedProviderIds: calibration.degradedProviderIds,
      providerReliability: calibration.providerReliability,
    },
  };

  await finalizeCouncil({
    councilRunId,
    correlationId,
    finalRoute: council.finalRoute,
    platformArbitrationReason:
      'Platform arbitration completed after observable provider artifacts, evidence links, policy gates, and pre-send safety posture were recorded.',
    metadata: {
      mode,
      task_family: input.taskFamily,
      observable_provider_council: 'true',
      answer_guidance_status: answerGuidance.status,
      answer_guidance_confidence: answerGuidance.confidence.toFixed(2),
      structured_verdict_status: structuredVerdict.status,
      structured_verdict_action: structuredVerdict.recommendedAction,
      council_evidence_grade: structuredVerdict.evidenceGrade,
      council_approval_need: structuredVerdict.approvalNeed,
      council_usable_member_count: String(structuredVerdict.usableMemberCount),
      council_blocked_member_count: String(
        structuredVerdict.blockedMemberCount,
      ),
      council_schema_valid_count: String(
        structuredVerdict.schemaStatusSummary.valid,
      ),
      council_schema_repaired_count: String(
        structuredVerdict.schemaStatusSummary.repaired,
      ),
      council_schema_invalid_count: String(
        structuredVerdict.schemaStatusSummary.invalid_fallback,
      ),
      council_budget_status: finalBudget.status,
      council_budget_used_roles: String(finalBudget.usedRoles),
      council_budget_retry_count: String(finalBudget.retryCount),
      council_evidence_gap_count: String(evidencePack.scorecard.gapCount),
      provider_participation_status: participationPlan.status,
      provider_participation_skipped:
        participationPlan.skippedProviderIds.join(','),
      provider_participation_substitutions:
        participationPlan.substitutedRoles.join(','),
      council_v3_calibration_reason: calibration.reason,
      council_v3_calibration_changed: String(calibration.changedMode),
      council_v3_protected_mode: String(calibration.protectedMode),
      council_ultrathink_requested: String(ultrathinkTrace?.requested === true),
      council_ultrathink_trigger: ultrathinkTrace?.trigger || '',
      council_ultrathink_effort_sent: ultrathinkTrace?.effortSent || '',
      council_ultrathink_supported: String(
        ultrathinkTrace?.adaptiveThinkingSupported === true,
      ),
      council_replay_summary:
        structuredVerdict.replayArtifact?.replaySummary || '',
    },
  });

  recordCouncilRunLedger({
    councilRunId,
    groupFolder: input.groupFolder,
    taskFamily: input.taskFamily,
    channel: input.channel,
    requestedMode: requestedMode,
    chosenMode: mode,
    calibration: {
      ...calibration,
      chosenMode: mode,
      changedMode: mode !== calibration.requestedMode,
    },
    status: council.status,
    structuredVerdict: structuredVerdictSummary,
    providerFailures: providerFailuresUnique,
    riskFlags: [...(council.riskFlags || []), ...structuredVerdict.riskFlags],
  });

  return {
    ...council,
    observedMemberIds: Array.from(new Set(observedMemberIds)),
    observedRoles: Array.from(new Set(observedRoles)),
    eventIds: Array.from(new Set(emittedEventIds)),
    evidenceIds: Array.from(
      new Set([
        ...evidenceIds,
        ...observedEvidenceIds,
        ...structuredVerdict.evidenceIds,
      ]),
    ),
    providerFailures: providerFailuresUnique,
    answerGuidance,
    structuredVerdict: structuredVerdictSummary,
    memberCount: Array.from(new Set(observedMemberIds)).length,
    skippedMemberCount,
    blockedMemberCount,
    confidence: structuredVerdict.confidence,
    riskFlags: Array.from(
      new Set([...(council.riskFlags || []), ...structuredVerdict.riskFlags]),
    ),
    estimatedCostTier: finalBudget.estimatedCostTier,
  };
}
