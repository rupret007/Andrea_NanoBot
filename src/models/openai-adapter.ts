/**
 * OpenAI Chat Completions adapter.
 *
 * Mirrors AnthropicAdapter — same `ProviderAdapter` shape. Tested against
 * OpenAI's chat/completions API. Reshapes tool messages so they're preceded
 * by an assistant `tool_calls` entry (OpenAI 400s otherwise) and switches
 * `max_tokens` -> `max_completion_tokens` for the gpt-5* family.
 */

import type { Message } from '../agi-core/types.js';
import type {
  CompletionRequest,
  CompletionResult,
  ModelSpec,
  ProviderAdapter,
} from './router.js';
import { fetchWithTimeoutAndRetry } from './http-utils.js';

export interface OpenAIAdapterOptions {
  fetchImpl?: typeof fetch;
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;

  constructor(
    private readonly apiKey: string,
    private readonly catalog: ModelSpec[],
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly options: OpenAIAdapterOptions = {},
  ) {}

  models(): ModelSpec[] {
    return this.catalog.filter((m) => m.provider === 'openai');
  }

  async complete(
    model: ModelSpec,
    req: CompletionRequest,
  ): Promise<CompletionResult> {
    const start = Date.now();
    const messages = toOpenAIMessages(req.system, req.messages);

    const isGpt5 = model.id.startsWith('gpt-5');
    const tokenField = isGpt5 ? 'max_completion_tokens' : 'max_tokens';

    const body: Record<string, unknown> = {
      model: model.id,
      messages,
      temperature: req.temperature ?? 0.4,
      [tokenField]: req.maxTokens ?? 2048,
    };

    const r = await fetchWithTimeoutAndRetry(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      { budgetMs: req.budgetMs, fetchImpl: this.options.fetchImpl },
    );
    if (!r.ok) {
      throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    }
    const data: any = await r.json();
    const text = data.choices?.[0]?.message?.content ?? '';
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
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

/**
 * Convert internal Message[] to OpenAI chat/completions messages.
 *
 * OpenAI requires that every `role: "tool"` message be immediately preceded
 * by an `assistant` message that carries a `tool_calls` array whose `id`
 * matches the tool message's `tool_call_id`. Our internal `Message` shape
 * only stores the assistant text + (optionally) the tool-call descriptor in
 * `metadata.toolCalls`. We rebuild the proper sequence here.
 *
 * If a tool message appears without an upstream assistant carrying a matching
 * `tool_calls` entry (either inline or via `metadata.toolCalls`), throws
 * with a clear remediation message.
 */
export function toOpenAIMessages(system: string | undefined, msgs: Message[]) {
  const out: any[] = [];
  if (system !== undefined) out.push({ role: 'system', content: system });

  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') {
      if (!m.toolCallId) {
        throw new Error(
          'OpenAI tool messages require tool_call_id. Set Message.toolCallId.',
        );
      }
      const prev = out[out.length - 1];
      const prevHasMatch =
        prev?.role === 'assistant' &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls.some((c: any) => c.id === m.toolCallId);
      if (!prevHasMatch) {
        // Try to recover from metadata on a preceding assistant message.
        const upstream = findUpstreamAssistant(msgs, i);
        const meta = upstream?.metadata as { toolCalls?: any[] } | undefined;
        const toolCalls = meta?.toolCalls;
        if (!toolCalls || !toolCalls.some((c: any) => c.id === m.toolCallId)) {
          throw new Error(
            'OpenAI tool messages require a preceding assistant tool_calls block. Pass it through Message.metadata.toolCalls.',
          );
        }
        out.push({
          role: 'assistant',
          content: upstream?.content ?? '',
          tool_calls: toolCalls,
        });
      }
      out.push({
        role: 'tool',
        content: m.content,
        tool_call_id: m.toolCallId,
        ...(m.name ? { name: m.name } : {}),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const meta = m.metadata as { toolCalls?: any[] } | undefined;
      const entry: any = { role: 'assistant', content: m.content };
      if (meta?.toolCalls) entry.tool_calls = meta.toolCalls;
      if (m.name) entry.name = m.name;
      out.push(entry);
      continue;
    }

    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      });
      continue;
    }

    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    }
  }
  return out;
}

function findUpstreamAssistant(
  msgs: Message[],
  from: number,
): Message | undefined {
  for (let i = from - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return msgs[i];
    if (msgs[i].role === 'user') return undefined;
  }
  return undefined;
}
