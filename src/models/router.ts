/**
 * Multi-provider model router.
 *
 * Routes a request to the best model given:
 *   - capability requirements (long-context, tool-use, JSON-mode, vision)
 *   - latency budget
 *   - cost budget
 *   - availability (provider health)
 *   - "diversity" needs (council requires distinct providers)
 *
 * Provider adapters live next to this file. Adding a new provider is a
 * single new adapter and a registry entry — the rest of the system speaks
 * one shape: `ModelClient.complete()`.
 */

import type { Message } from '../agi-core/types.js';

export type Capability =
  | 'tool_use'
  | 'json_mode'
  | 'vision'
  | 'long_context'
  | 'low_latency'
  | 'code'
  | 'math'
  | 'voting';

export interface ModelSpec {
  /** Stable id used everywhere. */
  id: string;
  provider:
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'meta'
    | 'mistral'
    | 'local'
    | 'xai'
    | 'deepseek';
  family: string;
  /** Context window in tokens. */
  contextTokens: number;
  /** Approximate cost USD/1M input tokens. */
  costInUsdPerMTok: number;
  /** Approximate cost USD/1M output tokens. */
  costOutUsdPerMTok: number;
  /** Approximate p50 first-token latency in ms. */
  p50LatencyMs: number;
  capabilities: Capability[];
  /** Disabled if missing creds, blocked, or down. */
  available: boolean;
  /** Last health check timestamp. */
  checkedAt?: number;
}

export interface CompletionRequest {
  system?: string;
  messages: Message[];
  temperature?: number;
  maxTokens?: number;
  /** Required capabilities — router will only consider models that have ALL of these. */
  requires?: Capability[];
  /** Optional override — pin to a specific id. */
  preferId?: string;
  /**
   * If true, a missing/unavailable `preferId` falls back to scoring instead
   * of throwing. Default behavior (false/undefined) is to throw — callers
   * like the reflector pin a small/cheap model deliberately and silent
   * fallback masks a configuration bug.
   */
  preferIdOptional?: boolean;
  /**
   * USD ceiling for this single call. Compared against an approximate per-call
   * cost estimated from the request's input length and `maxTokens` output budget.
   */
  budgetUsd?: number;
  /** Wall-clock ceiling. */
  budgetMs?: number;
  /** Diversity hint for council: avoid these providers. */
  excludeProviders?: ModelSpec['provider'][];
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface ProviderAdapter {
  readonly provider: ModelSpec['provider'];
  /** Models this adapter can serve. */
  models(): ModelSpec[];
  complete(model: ModelSpec, req: CompletionRequest): Promise<CompletionResult>;
  /** Optional embedding endpoint (router-level fan-out is fine). */
  embed?(input: string[]): Promise<Float32Array[]>;
}

/**
 * Default catalog. Costs and latencies are typical-as-of-2026 estimates;
 * the live router refreshes from providers' pricing endpoints when
 * available, otherwise these values bias scheduling reasonably.
 */
export const DEFAULT_CATALOG: ModelSpec[] = [
  // Anthropic
  {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    family: 'claude-opus',
    contextTokens: 1_000_000,
    costInUsdPerMTok: 15,
    costOutUsdPerMTok: 75,
    p50LatencyMs: 1800,
    capabilities: [
      'tool_use',
      'json_mode',
      'vision',
      'long_context',
      'code',
      'math',
      'voting',
    ],
    available: true,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    family: 'claude-sonnet',
    contextTokens: 1_000_000,
    costInUsdPerMTok: 3,
    costOutUsdPerMTok: 15,
    p50LatencyMs: 900,
    capabilities: [
      'tool_use',
      'json_mode',
      'vision',
      'long_context',
      'code',
      'math',
      'low_latency',
      'voting',
    ],
    available: true,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    family: 'claude-haiku',
    contextTokens: 200_000,
    costInUsdPerMTok: 0.8,
    costOutUsdPerMTok: 4,
    p50LatencyMs: 350,
    capabilities: ['tool_use', 'json_mode', 'vision', 'low_latency', 'voting'],
    available: true,
  },
  // OpenAI
  {
    id: 'gpt-5',
    provider: 'openai',
    family: 'gpt-5',
    contextTokens: 1_000_000,
    costInUsdPerMTok: 10,
    costOutUsdPerMTok: 40,
    p50LatencyMs: 1500,
    capabilities: [
      'tool_use',
      'json_mode',
      'vision',
      'long_context',
      'code',
      'math',
      'voting',
    ],
    available: true,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    family: 'gpt-5',
    contextTokens: 400_000,
    costInUsdPerMTok: 1,
    costOutUsdPerMTok: 4,
    p50LatencyMs: 600,
    capabilities: ['tool_use', 'json_mode', 'vision', 'low_latency', 'voting'],
    available: true,
  },
  // Google
  {
    id: 'gemini-2.5-pro',
    provider: 'google',
    family: 'gemini',
    contextTokens: 2_000_000,
    costInUsdPerMTok: 5,
    costOutUsdPerMTok: 20,
    p50LatencyMs: 1300,
    capabilities: [
      'tool_use',
      'json_mode',
      'vision',
      'long_context',
      'code',
      'math',
      'voting',
    ],
    available: true,
  },
  // Local fallback (Ollama). The catalog id IS the Ollama tag — no transform.
  {
    id: 'llama3.3:70b',
    provider: 'local',
    family: 'llama',
    contextTokens: 128_000,
    costInUsdPerMTok: 0,
    costOutUsdPerMTok: 0,
    p50LatencyMs: 5000,
    capabilities: ['tool_use', 'json_mode', 'code', 'voting'],
    available: false, // flipped on if local server reachable
  },
];

export interface RouterOptions {
  catalog?: ModelSpec[];
  /** Default capability score function for tie-breaking. */
  scoreFn?: (m: ModelSpec, req: CompletionRequest) => number;
  /** Number of fallbacks to try on failure. */
  maxFallbacks?: number;
  /** Optional budget meter callback for global cost tracking. */
  onSpend?: (usd: number, modelId: string) => void;
  /** How long (ms) to keep a failed model out of the rotation. Default 30s. */
  cooldownMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

/**
 * Aggregate error raised when no model in the pool succeeded. Carries the
 * per-model causes so callers can log the full chain. We avoid the built-in
 * `AggregateError` (Node-only quirks; some toolchains don't expose it
 * cleanly under strict `lib`) and ship a Node-friendly equivalent.
 */
export class RouterAggregateError extends Error {
  readonly errors: unknown[];
  readonly attempts: { modelId: string; error: unknown }[];
  constructor(
    message: string,
    attempts: { modelId: string; error: unknown }[],
  ) {
    super(message);
    this.name = 'RouterAggregateError';
    this.attempts = attempts;
    this.errors = attempts.map((a) => a.error);
  }
}

export class ModelRouter {
  private adapters = new Map<ModelSpec['provider'], ProviderAdapter>();
  private catalog: ModelSpec[];
  private opts: RouterOptions;
  /** Per-router cooldown map: modelId -> resumeAt ms timestamp. */
  private cooldown = new Map<string, number>();

  constructor(opts: RouterOptions = {}) {
    this.catalog = opts.catalog ?? DEFAULT_CATALOG.map((m) => ({ ...m }));
    this.opts = opts;
  }

  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
    // Mark adapter's catalog entries available.
    for (const m of adapter.models()) {
      const existing = this.catalog.find((c) => c.id === m.id);
      if (existing) existing.available = true;
      else this.catalog.push({ ...m, available: true });
    }
  }

  list(): ModelSpec[] {
    return [...this.catalog];
  }

  private nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  private isInCooldown(id: string): boolean {
    const until = this.cooldown.get(id);
    if (until === undefined) return false;
    if (this.nowMs() >= until) {
      this.cooldown.delete(id);
      return false;
    }
    return true;
  }

  /** Pick the model. Exposed for tests and the council. */
  pick(req: CompletionRequest): ModelSpec[] {
    const requires = req.requires ?? [];
    const pool = this.catalog.filter((m) => {
      if (!m.available) return false;
      if (!this.adapters.has(m.provider)) return false;
      if (req.excludeProviders && req.excludeProviders.includes(m.provider))
        return false;
      if (!requires.every((c) => m.capabilities.includes(c))) return false;
      if (this.isInCooldown(m.id)) return false;
      return true;
    });

    const ranked = [...pool].sort(
      (a, b) => this.score(b, req) - this.score(a, req),
    );

    if (req.preferId) {
      const idx = ranked.findIndex((m) => m.id === req.preferId);
      if (idx >= 0) {
        if (idx > 0) {
          const [picked] = ranked.splice(idx, 1);
          ranked.unshift(picked);
        }
      } else if (!req.preferIdOptional) {
        const reasons: string[] = [];
        const known = this.catalog.find((m) => m.id === req.preferId);
        if (!known) {
          reasons.push('not in catalog');
        } else {
          if (!this.adapters.has(known.provider))
            reasons.push(
              `no registered adapter for provider "${known.provider}"`,
            );
          if (!known.available) reasons.push('marked unavailable');
          if (
            req.excludeProviders &&
            req.excludeProviders.includes(known.provider)
          )
            reasons.push(`provider "${known.provider}" excluded`);
          if (!requires.every((c) => known.capabilities.includes(c)))
            reasons.push(
              `missing required capabilities (${requires.join(',')})`,
            );
          if (this.isInCooldown(known.id))
            reasons.push('in cooldown after recent failure');
        }
        const why = reasons.length ? reasons.join('; ') : 'unknown';
        throw new Error(`preferId "${req.preferId}" not available: ${why}`);
      }
    }
    return ranked;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const ranked = this.pick(req);
    if (ranked.length === 0) {
      throw new RouterAggregateError('No models available', []);
    }
    const tries = Math.min(ranked.length, (this.opts.maxFallbacks ?? 2) + 1);
    const attempts: { modelId: string; error: unknown }[] = [];
    const cooldownMs = this.opts.cooldownMs ?? 30_000;
    for (let i = 0; i < tries; i++) {
      const model = ranked[i];
      const adapter = this.adapters.get(model.provider);
      if (!adapter) {
        attempts.push({
          modelId: model.id,
          error: new Error(`No adapter for provider ${model.provider}`),
        });
        continue;
      }
      try {
        const start = this.nowMs();
        const out = await adapter.complete(model, req);
        out.latencyMs = out.latencyMs ?? this.nowMs() - start;
        this.opts.onSpend?.(out.costUsd, out.model);
        return out;
      } catch (err) {
        attempts.push({ modelId: model.id, error: err });
        // Per-router cooldown — don't mutate the shared catalog.
        this.cooldown.set(model.id, this.nowMs() + cooldownMs);
      }
    }
    const summary = attempts
      .map(
        (a) =>
          `${a.modelId}: ${(a.error as Error)?.message ?? String(a.error)}`,
      )
      .join(' | ');
    throw new RouterAggregateError(
      `All ${attempts.length} model attempts failed: ${summary}`,
      attempts,
    );
  }

  /**
   * Confidence-weighted scoring: sum of capability matches normalized by
   * cost and latency, with explicit budget honoring.
   *
   * When the caller supplies a tight `budgetMs`, latency dominates — being
   * fast matters more than being slightly more capable. When there is no
   * latency pressure, capability and cost dominate.
   */
  private score(m: ModelSpec, req: CompletionRequest): number {
    if (this.opts.scoreFn) return this.opts.scoreFn(m, req);
    let score = m.capabilities.length;

    const budgetMs = req.budgetMs ?? 0;
    const wantSpeed = budgetMs > 0 && budgetMs <= 1500;
    if (wantSpeed) {
      score += m.capabilities.includes('low_latency') ? 4 : -2;
      // Single latency penalty — previously double-counted (over-budget term
      // PLUS absolute term). Keep the absolute one: it differentiates between
      // models even when both fit the budget, and degrades gracefully when
      // both don't.
      score -= m.p50LatencyMs / 100; // 100ms = 1 score unit
    } else {
      score -= m.p50LatencyMs / 1000;
    }

    const ceilingUsd = req.budgetUsd ?? Infinity;
    const approxCost = estimateCallCostUsd(m, req);
    if (approxCost > ceilingUsd) score -= 5;
    score -= approxCost * 0.5;

    return score;
  }
}

/**
 * Approximate per-call cost in USD. Estimates input tokens from a rough
 * "4 chars per token" heuristic across `req.system` plus every message body,
 * and assumes the caller's `maxTokens` worth of output. Coarse — used for
 * budget gating and cost-bias scoring, not for billing.
 */
export function estimateCallCostUsd(
  m: ModelSpec,
  req: CompletionRequest,
): number {
  const inputChars =
    (req.system?.length ?? 0) +
    req.messages.reduce((acc, msg) => acc + (msg.content?.length ?? 0), 0);
  const estimatedInputTokens = Math.ceil(inputChars / 4);
  const estimatedOutputTokens = req.maxTokens ?? 2048;
  return (
    (estimatedInputTokens * m.costInUsdPerMTok +
      estimatedOutputTokens * m.costOutUsdPerMTok) /
    1_000_000
  );
}
