/**
 * Local Ollama adapter — for offline / privacy-sensitive workloads.
 *
 * Same shape as the cloud adapters. Unavailable if the local server isn't
 * reachable; the router will skip it.
 *
 * Catalog `id` is sent verbatim to Ollama's `/api/chat` as the model tag
 * (e.g. `"llama3.3:70b"`). If you maintain different ids, populate
 * `tagOverrides` to map id -> Ollama tag.
 */

import type {
  CompletionRequest,
  CompletionResult,
  ModelSpec,
  ProviderAdapter,
} from './router.js';
import { fetchWithTimeoutAndRetry } from './http-utils.js';

interface OllamaTagDetails {
  family?: unknown;
  context_length?: unknown;
}

interface OllamaTagInfo {
  name?: unknown;
  model?: unknown;
  details?: OllamaTagDetails;
  capabilities?: unknown;
}

interface OllamaTagsResponse {
  models?: unknown;
}

export function modelSpecFromOllamaTag(tag: OllamaTagInfo): ModelSpec | null {
  const id =
    typeof tag.model === 'string' && tag.model.trim()
      ? tag.model.trim()
      : typeof tag.name === 'string' && tag.name.trim()
        ? tag.name.trim()
        : '';
  if (!id) return null;

  const family =
    typeof tag.details?.family === 'string' && tag.details.family.trim()
      ? tag.details.family.trim()
      : id.split(':')[0] || 'local';
  const contextTokens =
    typeof tag.details?.context_length === 'number' &&
    Number.isFinite(tag.details.context_length) &&
    tag.details.context_length > 0
      ? tag.details.context_length
      : 32_768;
  const reportedCapabilities = Array.isArray(tag.capabilities)
    ? tag.capabilities.map((cap) => String(cap).toLowerCase())
    : [];
  const capabilities: ModelSpec['capabilities'] = [
    'json_mode',
    'code',
    'math',
    'voting',
  ];
  if (reportedCapabilities.includes('tools')) capabilities.unshift('tool_use');

  return {
    id,
    provider: 'local',
    family,
    contextTokens,
    costInUsdPerMTok: 0,
    costOutUsdPerMTok: 0,
    p50LatencyMs: 5000,
    capabilities,
    available: true,
  };
}

export async function discoverOllamaModels(
  baseUrl = 'http://localhost:11434',
  fetchImpl: typeof fetch = fetch,
): Promise<ModelSpec[]> {
  const r = await fetchImpl(`${baseUrl}/api/tags`);
  if (!r.ok) return [];
  const data = (await r.json()) as OllamaTagsResponse;
  const rawModels = Array.isArray(data.models) ? data.models : [];
  const seen = new Set<string>();
  const models: ModelSpec[] = [];
  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;
    const spec = modelSpecFromOllamaTag(raw as OllamaTagInfo);
    if (!spec || seen.has(spec.id)) continue;
    seen.add(spec.id);
    models.push(spec);
  }
  return models;
}

export interface OllamaAdapterOptions {
  fetchImpl?: typeof fetch;
  /** Map catalog id -> Ollama tag, when they need to differ. */
  tagOverrides?: Record<string, string>;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly provider = 'local' as const;

  constructor(
    private readonly catalog: ModelSpec[],
    private readonly baseUrl = 'http://localhost:11434',
    private readonly options: OllamaAdapterOptions = {},
  ) {}

  models(): ModelSpec[] {
    return this.catalog.filter((m) => m.provider === 'local');
  }

  async healthCheck(): Promise<boolean> {
    try {
      const r = await fetch(`${this.baseUrl}/api/tags`);
      return r.ok;
    } catch {
      return false;
    }
  }

  async complete(
    model: ModelSpec,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    const start = Date.now();
    const tag = this.options.tagOverrides?.[model.id] ?? model.id;
    const r = await fetchWithTimeoutAndRetry(
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: tag,
          messages: [
            ...(req.system !== undefined
              ? [{ role: 'system', content: req.system }]
              : []),
            ...req.messages.map((m) => ({ role: m.role, content: m.content })),
          ],
          options: {
            temperature: req.temperature ?? 0.4,
            num_predict: req.maxTokens ?? 2048,
          },
          stream: false,
        }),
      },
      { budgetMs: req.budgetMs, fetchImpl: this.options.fetchImpl },
    );
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
    const data: any = await r.json();
    const text = data.message?.content ?? '';
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return {
      text,
      model: model.id,
      inputTokens,
      outputTokens,
      costUsd: 0,
      latencyMs: Date.now() - start,
    };
  }
}
