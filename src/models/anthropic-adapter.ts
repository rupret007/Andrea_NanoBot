/**
 * Anthropic Messages API adapter.
 *
 * Single-call wrapper that conforms to the router's `ProviderAdapter` shape.
 * Uses raw fetch so this file has zero runtime deps. Adds a per-call
 * AbortController timeout and a single retry on 429 (Retry-After honored,
 * capped by remaining budget).
 */

import type { Message } from '../agi-core/types.js';
import type {
  CompletionRequest,
  CompletionResult,
  ModelSpec,
  ProviderAdapter,
} from './router.js';
import { fetchWithTimeoutAndRetry } from './http-utils.js';

export interface AnthropicAdapterOptions {
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;

  constructor(
    private readonly apiKey: string,
    private readonly catalog: ModelSpec[],
    private readonly baseUrl = 'https://api.anthropic.com/v1',
    private readonly options: AnthropicAdapterOptions = {},
  ) {}

  models(): ModelSpec[] {
    return this.catalog.filter((m) => m.provider === 'anthropic');
  }

  async complete(
    model: ModelSpec,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: model.id,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.4,
      messages: toAnthropicMessages(req.messages),
    };
    // Empty system string is valid; only `undefined` means "omit the field".
    if (req.system !== undefined) body.system = req.system;

    const r = await fetchWithTimeoutAndRetry(
      `${this.baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { budgetMs: req.budgetMs, fetchImpl: this.options.fetchImpl },
    );
    if (!r.ok) {
      throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    }
    const data: any = await r.json();
    const text = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const inputTokens = data.usage?.input_tokens ?? 0;
    const outputTokens = data.usage?.output_tokens ?? 0;
    const costUsd =
      (inputTokens / 1_000_000) * model.costInUsdPerMTok +
      (outputTokens / 1_000_000) * model.costOutUsdPerMTok;
    return {
      text,
      model: model.id,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs: Date.now() - start,
    };
  }
}

export function toAnthropicMessages(msgs: Message[]) {
  return msgs
    .filter(
      (m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool',
    )
    .map((m) => {
      if (m.role === 'tool') {
        if (!m.toolCallId) {
          throw new Error(
            'Anthropic tool messages require a non-empty toolCallId (mapped to tool_use_id).',
          );
        }
        // Anthropic accepts string OR an array of content blocks for tool_result.
        // Normalize to string for predictable round-tripping.
        const content =
          typeof m.content === 'string' ? m.content : String(m.content ?? '');
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: m.toolCallId,
              content,
            },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
}
