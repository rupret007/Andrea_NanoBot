import {
  emitAndreaPlatformCouncilEvent,
  emitAndreaPlatformCouncilMemberResult,
  emitAndreaPlatformProviderCouncil,
  finalizeAndreaPlatformCouncil,
  type AndreaPlatformCouncilMode,
  type AndreaPlatformProviderCouncilResult,
  type PlatformTaskFamily,
} from './andrea-platform-bridge.js';
import { searchBraveWeb } from './brave-search.js';
import { runGeminiOpenAiText } from './gemini-provider.js';
import { runMiniMaxAnthropicText } from './minimax-provider.js';
import { runOpenAiChatText } from './openai-provider.js';

type CouncilRole = 'planner' | 'critic' | 'evidence_scout' | 'verifier';

interface TextProviderResult {
  text?: string;
  model?: string;
  requestId?: string;
  providerFailure?: string;
  status?: number;
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
  runMiniMax?: typeof runMiniMaxAnthropicText;
  runGemini?: typeof runGeminiOpenAiText;
  searchBrave?: typeof searchBraveWeb;
  now?: () => number;
}

const SECRET_PATTERNS = [
  /sk-(?:proj-|ant-api\d*-|api-)?[A-Za-z0-9_-]{16,}/g,
  /AIza[A-Za-z0-9_-]{20,}/g,
  /BSA-[A-Za-z0-9_-]{12,}/g,
  /ghp_[A-Za-z0-9_]{16,}/g,
  /crsr_[A-Za-z0-9_]{16,}/g,
  /\b\d{7,}:[A-Za-z0-9_-]{20,}/g,
  /(password|api[_-]?key|token|secret)\s*[:=]\s*[^,\s]+/gi,
];

function sanitizeObservableText(value: string, limit = 6000): string {
  let redacted = value.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted.slice(0, limit);
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
  criticText?: string;
}): string {
  const base = [
    `Andrea council assignment: ${input.role}.`,
    `Task family: ${input.taskFamily}.`,
    `Sanitized goal: ${input.goal}.`,
    `Evidence summary: ${input.evidenceSummary || 'No live evidence was gathered.'}`,
    'Return visible notes only. Do not include hidden chain-of-thought, secrets, private memory, or raw message bodies.',
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
      'Challenge the plan. Name missing evidence, unsafe assumptions, and a safer alternate route if needed.',
    ].join('\n');
  }
  if (input.role === 'verifier') {
    return [
      ...base,
      `Planner artifact: ${input.plannerText || 'missing'}`,
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

async function callTimed<T>(
  fn: () => Promise<T>,
  now: () => number,
): Promise<{ result: T; latencyMs: number }> {
  const started = now();
  const result = await fn();
  return { result, latencyMs: Math.max(0, Math.round(now() - started)) };
}

function normalizeProviderArtifact(result: unknown): TextProviderResult {
  if (!result || typeof result !== 'object') return {};
  return result as TextProviderResult;
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
  const runMiniMax = deps.runMiniMax || runMiniMaxAnthropicText;
  const runGemini = deps.runGemini || runGeminiOpenAiText;
  const searchBrave = deps.searchBrave || searchBraveWeb;
  const now = deps.now || (() => Date.now());

  const council = await emitProviderCouncil(input);
  if (!council?.councilRunId) return council;

  const councilRunId = council.councilRunId;
  const mode = council.mode || input.requestedMode || 'single_model';
  const correlationId = input.correlationId || council.traceId || councilRunId;
  const goal = sanitizeObservableText(input.goal, 900);
  let evidenceSummary =
    'No live evidence gathered; rely on local metadata and provider health truth.';
  let evidenceIds: string[] = [];

  await emitCouncilEvent({
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
      'Conductor will assign evidence scout, planner, critic, verifier, and platform arbiter as policy allows.',
    estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
    metadata: {
      mode,
      task_family: input.taskFamily,
    },
  });

  if (shouldUseEvidenceScout(mode, input.taskFamily)) {
    const prompt = `Gather public/live evidence for this sanitized Andrea task: ${goal}`;
    const { result, latencyMs } = await callTimed(() => searchBrave(goal), now);
    const brave = result && typeof result === 'object' ? result : null;
    if (brave && 'results' in brave && Array.isArray(brave.results)) {
      evidenceSummary = brave.results
        .slice(0, 3)
        .map((item) => `${item.title}: ${item.description} (${item.url})`)
        .join('\n');
      evidenceIds = brave.results
        .slice(0, 3)
        .map((item, index) => `brave:${index + 1}:${item.url.slice(0, 80)}`);
      await emitMemberResult({
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
      await emitMemberResult({
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

  const plannerPrompt = memberPrompt({
    role: 'planner',
    goal,
    taskFamily: input.taskFamily,
    evidenceSummary,
  });
  const plannerCall = await callTimed(
    () =>
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
    now,
  );
  const planner = normalizeProviderArtifact(plannerCall.result);
  const plannerText =
    planner.text ||
    planner.providerFailure ||
    'OpenAI planner produced no artifact.';
  await emitMemberResult({
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
    riskFlags: planner.text ? [] : ['openai_planner_unavailable'],
    metadata: { request_id: planner.requestId || '' },
  });

  let criticText = '';
  if (shouldUseReviewer(mode)) {
    const criticPrompt = memberPrompt({
      role: 'critic',
      goal,
      taskFamily: input.taskFamily,
      evidenceSummary,
      plannerText,
    });
    const criticCall = await callTimed(
      () =>
        runMiniMax({
          system:
            'You are Andrea council challenger. Find missing assumptions and safer alternatives.',
          prompt: criticPrompt,
          modelTier: mode === 'max_iq_council' ? 'complex' : 'fast',
          maxTokens: 700,
          temperature: 0.25,
        }),
      now,
    );
    const critic = normalizeProviderArtifact(criticCall.result);
    criticText =
      critic.text ||
      critic.providerFailure ||
      'MiniMax critic produced no artifact.';
    await emitMemberResult({
      councilRunId,
      correlationId,
      memberId: 'minimax_cloud',
      role: 'critic',
      providerId: 'minimax_cloud',
      status: critic.text ? 'completed' : 'blocked',
      model: critic.model || 'MiniMax-M2.7',
      summary: critic.text ? 'MiniMax critic challenged the plan.' : criticText,
      critique: criticText,
      confidence: critic.text ? 0.78 : 0,
      visiblePrompt: criticPrompt,
      visibleResponse: criticText,
      evidenceIds,
      latencyMs: criticCall.latencyMs,
      estimatedTokenCount: estimateTokens(criticPrompt, criticText),
      estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
      riskFlags: critic.text ? [] : ['minimax_critic_unavailable'],
      metadata: { request_id: critic.requestId || '' },
    });

    const verifierPrompt = memberPrompt({
      role: 'verifier',
      goal,
      taskFamily: input.taskFamily,
      evidenceSummary,
      plannerText,
      criticText,
    });
    const verifierCall = await callTimed(
      () =>
        runGemini({
          system:
            'You are Andrea council independent verifier. Produce a pass/warn/block verdict with evidence and safety notes.',
          prompt: verifierPrompt,
          modelTier: mode === 'max_iq_council' ? 'critic' : 'fast',
          maxTokens: 700,
          temperature: 0.2,
        }),
      now,
    );
    const verifier = normalizeProviderArtifact(verifierCall.result);
    const verifierText =
      verifier.text ||
      verifier.providerFailure ||
      'Gemini verifier produced no artifact.';
    await emitMemberResult({
      councilRunId,
      correlationId,
      memberId: 'gemini_cloud',
      role: 'verifier',
      providerId: 'gemini_cloud',
      status: verifier.text ? 'completed' : 'blocked',
      model: verifier.model || 'gemini-2.5-pro',
      summary: verifier.text
        ? 'Gemini verifier checked the council result.'
        : verifierText,
      critique: verifierText,
      confidence: verifier.text ? 0.8 : 0,
      visiblePrompt: verifierPrompt,
      visibleResponse: verifierText,
      evidenceIds,
      latencyMs: verifierCall.latencyMs,
      estimatedTokenCount: estimateTokens(verifierPrompt, verifierText),
      estimatedCostTier: mode === 'max_iq_council' ? 'high' : 'medium',
      riskFlags: verifier.text ? [] : ['gemini_verifier_unavailable'],
      metadata: { request_id: verifier.requestId || '' },
    });
  }

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
    },
  });

  return council;
}
