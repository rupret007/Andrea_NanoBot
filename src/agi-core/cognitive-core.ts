/**
 * Cognitive core — top-level orchestrator that selects the right reasoning
 * strategy for the question and stitches together tree-of-thoughts, ReAct,
 * the council, and self-refine into one trace.
 *
 * Strategy selection (cheap classifier, runs on the small model):
 *
 *   simple chitchat / lookup            → direct generation
 *   factual question with retrieval     → ReAct with tools
 *   open-ended reasoning, no tools      → tree-of-thoughts + self-refine
 *   high-stakes / contested             → council (3+ models) + self-refine
 *
 * The classifier is itself wrong sometimes, so each strategy has an
 * escape-hatch that escalates to the next one if its confidence drops.
 */

import { randomUUID } from 'node:crypto';
import { runCouncil } from './council.js';
import { reactLoop } from './planner.js';
import { refine } from './self-critique.js';
import { searchTreeOfThoughts } from './tree-of-thoughts.js';
import {
  DEFAULT_COGNITION_CONFIG,
  type CognitionConfig,
  type CognitionTrace,
  type Message,
  type ToolDescriptor,
  type ToolResult,
} from './types.js';

export type Strategy = 'direct' | 'react' | 'tot' | 'council';

/**
 * Shared budget tracker threaded through every strategy. Mutating a single
 * tracker means TOT, ReAct, council, and refine all observe the same wall-
 * clock / token / dollar limits.
 */
export interface CognitionBudget {
  startedAt: number;
  budgetMs: number;
  budgetTokens: number;
  budgetUsd: number;
  tokensUsed: number;
  costUsd: number;
}

function newBudget(cfg: CognitionConfig): CognitionBudget {
  return {
    startedAt: Date.now(),
    budgetMs: cfg.budgetMs,
    budgetTokens: cfg.budgetTokens,
    budgetUsd: cfg.budgetUsd,
    tokensUsed: 0,
    costUsd: 0,
  };
}

function budgetExceeded(b: CognitionBudget): boolean {
  if (Date.now() - b.startedAt >= b.budgetMs) return true;
  if (b.tokensUsed >= b.budgetTokens) return true;
  if (b.costUsd >= b.budgetUsd) return true;
  return false;
}

function chargeBudget(
  b: CognitionBudget,
  out: { inputTokens: number; outputTokens: number; costUsd: number },
): void {
  b.tokensUsed += (out.inputTokens || 0) + (out.outputTokens || 0);
  b.costUsd += out.costUsd || 0;
}

export interface ModelClient {
  /** Generate a single completion. */
  complete(params: {
    model: string;
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;

  /** Available models, in preference order for "primary". */
  primary: string;
  /** Smaller / cheaper model for the classifier and critic. */
  small: string;
  /** Heterogeneous panel for the council. */
  panel: string[];
}

export interface CognitiveContext {
  /** Stable id used to correlate this cognition across modules. */
  traceId: string;
  /** User's question or directive. */
  goal: string;
  /** Pre-prepended system prompt(s) — typically constitution + persona. */
  system?: string;
  /** Conversational history (memory module fills this in). */
  history?: Message[];
  /** Tools the agent may invoke. */
  tools?: ToolDescriptor[];
  /**
   * Runtime-owned tool executor. The cognitive core decides when a tool is
   * useful, but execution stays at the runtime boundary so policy, audit,
   * confirmation, and integration validation are never bypassed.
   */
  toolRunner?: (call: {
    tool: string;
    args: Record<string, unknown>;
    callId: string;
  }) => Promise<ToolResult>;
  /** Override default config. */
  config?: Partial<CognitionConfig>;
}

export interface CognitiveResult {
  answer: string;
  trace: CognitionTrace;
  strategy: Strategy;
}

export class CognitiveCore {
  constructor(private readonly model: ModelClient) {}

  async think(ctx: CognitiveContext): Promise<CognitiveResult> {
    const cfg: CognitionConfig = {
      ...DEFAULT_COGNITION_CONFIG,
      ...ctx.config,
    };

    const trace: CognitionTrace = {
      goal: ctx.goal,
      startedAt: Date.now(),
      nodes: [],
      acceptedPath: [],
      tokens: { input: 0, output: 0 },
      costUsd: 0,
    };

    const budget = newBudget(cfg);

    const strategy = await this.classify(ctx, trace, budget);
    let answer = '';
    switch (strategy) {
      case 'direct':
        answer = await this.direct(ctx, trace, budget);
        break;
      case 'react':
        answer = await this.react(ctx, trace, budget);
        break;
      case 'tot':
        answer = await this.tot(ctx, cfg, trace, budget);
        break;
      case 'council':
        answer = await this.council(ctx, cfg, trace, budget);
        break;
    }

    if (cfg.reflectAfter && strategy !== 'direct' && !budgetExceeded(budget)) {
      answer = await this.refine(ctx, answer, trace, budget);
    }

    trace.answer = answer;
    trace.finishedAt = Date.now();
    trace.latencyMs = trace.finishedAt - trace.startedAt;
    return { answer, trace, strategy };
  }

  // -- Strategy: direct -----------------------------------------------------

  private async classify(
    ctx: CognitiveContext,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<Strategy> {
    let out;
    try {
      out = await this.model.complete({
        model: this.model.small,
        system:
          "Classify the user's request into exactly one of: direct, react, tot, council. " +
          'Respond with the label only.\n' +
          '- direct: chitchat, simple lookup, paraphrase, format change.\n' +
          '- react: needs tools (search, files, APIs) but no deep reasoning.\n' +
          '- tot: open-ended reasoning, planning, math, code design — no tools.\n' +
          '- council: high-stakes, contested, ambiguous, or values-laden.',
        messages: [{ role: 'user', content: ctx.goal }],
        temperature: 0,
        maxTokens: 8,
      });
    } catch (err) {
      // Classifier crashed — fall back to the cheapest, safest path.
      console.warn(
        '[cognitive-core] classifier threw, defaulting to direct:',
        err,
      );
      return 'direct';
    }
    accumulate(trace, out);
    chargeBudget(budget, out);
    const label = out.text.trim().toLowerCase();
    // Whitelist exact labels only; anything else falls through to direct.
    if (label === 'react') return 'react';
    if (label === 'tot') return 'tot';
    if (label === 'council') return 'council';
    if (label === 'direct') return 'direct';
    console.warn(
      `[cognitive-core] classifier returned non-whitelisted label "${out.text.trim()}", defaulting to direct`,
    );
    return 'direct';
  }

  private async direct(
    ctx: CognitiveContext,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<string> {
    if (budgetExceeded(budget)) return '';
    const out = await this.model.complete({
      model: this.model.primary,
      system: ctx.system,
      messages: [...(ctx.history ?? []), { role: 'user', content: ctx.goal }],
    });
    accumulate(trace, out);
    chargeBudget(budget, out);
    return out.text;
  }

  // -- Strategy: ReAct ------------------------------------------------------

  private async react(
    ctx: CognitiveContext,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<string> {
    if (!ctx.tools || ctx.tools.length === 0) {
      // No tools available — fall through to direct generation rather than
      // burning budget on a ReAct loop that can't act.
      return this.direct(ctx, trace, budget);
    }
    if (!ctx.toolRunner) {
      return this.direct(ctx, trace, budget);
    }
    let bestSoFar = '';
    const result = await reactLoop({
      initial: [...(ctx.history ?? []), { role: 'user', content: ctx.goal }],
      tools: ctx.tools,
      llm: async ({ history, tools }) => {
        if (budgetExceeded(budget)) {
          // Signal completion with whatever we have to terminate the loop.
          return {
            thought: '(budget exhausted)',
            finalAnswer: bestSoFar,
            tokens: 0,
          };
        }
        const out = await this.model.complete({
          model: this.model.primary,
          system: (ctx.system ?? '') + '\n' + reactPrompt(tools),
          messages: history,
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        const parsed = tryParseReact(out.text);
        // Track partial reasoning so we can return something useful if we
        // run out of budget mid-loop.
        if (parsed.thought) bestSoFar = parsed.thought;
        if (parsed.finalAnswer) bestSoFar = parsed.finalAnswer;
        return { ...parsed, tokens: out.outputTokens };
      },
      run: ctx.toolRunner,
    });
    let parentId: string | undefined;
    for (const [index, step] of result.steps.entries()) {
      const id = `${ctx.traceId}:react:${index}`;
      trace.nodes.push({
        id,
        parentId,
        thought: step.thought,
        depth: index + 1,
        createdAt: Date.now(),
        toolCall: step.action,
        toolResult: step.observation,
      });
      trace.acceptedPath.push(id);
      parentId = id;
    }
    return result.answer || bestSoFar || '(no answer)';
  }

  // -- Strategy: tree-of-thoughts ------------------------------------------

  private async tot(
    ctx: CognitiveContext,
    cfg: CognitionConfig,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<string> {
    const result = await searchTreeOfThoughts(
      ctx.goal,
      cfg,
      async ({ goal, parent, depth }) => {
        if (budgetExceeded(budget)) {
          return { thought: '(budget exhausted)', tokens: 0 };
        }
        const parentText = parent?.thought ?? '';
        const out = await this.model.complete({
          model: this.model.primary,
          system: ctx.system,
          messages: [
            ...(ctx.history ?? []),
            { role: 'user', content: goal },
            {
              role: 'assistant',
              content:
                `Step ${depth}. Building on: ${parentText}\n` +
                `Propose ONE next reasoning step toward the goal. Be concrete.`,
            },
          ],
          temperature: 0.7,
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        return { thought: out.text, tokens: out.outputTokens };
      },
      async ({ goal, node }) => {
        if (budgetExceeded(budget)) {
          return { score: 0, critique: '(budget exhausted)', tokens: 0 };
        }
        const out = await this.model.complete({
          model: this.model.small,
          system:
            'You are a strict critic. Return JSON: {score: 0..1, critique: string}. ' +
            'Score based on: is this step factually correct, does it advance toward the goal, is it well-formed?',
          messages: [
            { role: 'user', content: `Goal: ${goal}\nStep: ${node.thought}` },
          ],
          temperature: 0,
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        const parsed = tryParseScore(out.text);
        return { ...parsed, tokens: out.outputTokens };
      },
    );

    trace.nodes.push(...result.nodes);
    trace.acceptedPath = result.acceptedPath;

    // Skip the synth pass entirely when the search produced no usable best
    // node — calling the synthesizer with placeholder text just wastes
    // budget on critic+rewrite later.
    if (!result.best) return "I couldn't reach a confident answer.";

    if (budgetExceeded(budget)) {
      // Out of budget — return the best raw thought instead of paying for a
      // synth pass we can't afford.
      return result.best.thought || "I couldn't reach a confident answer.";
    }

    // Filter the accepted path by node id, skipping the synthetic root.
    // Filtering by truthiness of `thought` would have leaked the literal
    // "<root>" string into the synth prompt.
    const rootId = result.nodes.find((n) => !n.parentId)?.id;
    const reasoningTrace = result.acceptedPath
      .filter((id) => id !== rootId)
      .map((id) => result.nodes.find((n) => n.id === id)?.thought ?? '')
      .filter((t) => t && t !== '<root>')
      .join('\n');

    // Synthesize the accepted reasoning into a final answer.
    const synth = await this.model.complete({
      model: this.model.primary,
      system: ctx.system,
      messages: [
        { role: 'user', content: ctx.goal },
        {
          role: 'assistant',
          content: 'My reasoning trace:\n' + reasoningTrace,
        },
        {
          role: 'user',
          content: 'Now state the final answer to the original question.',
        },
      ],
    });
    accumulate(trace, synth);
    chargeBudget(budget, synth);
    return synth.text;
  }

  // -- Strategy: council ---------------------------------------------------

  private async council(
    ctx: CognitiveContext,
    cfg: CognitionConfig,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<string> {
    const panel = cfg.council.length ? cfg.council : this.model.panel;
    // Need at least two panelists for a meaningful vote — otherwise fall
    // through to ToT.
    if (panel.length < 2) return this.tot(ctx, cfg, trace, budget);

    // Each panelist generates an answer. Best-so-far tracking lets us bail
    // out of the council early if the budget is blown after candidate gen.
    const candidates: { id: string; answer: string }[] = [];
    for (const m of panel) {
      if (budgetExceeded(budget)) break;
      const out = await this.model.complete({
        model: m,
        system: ctx.system,
        messages: [...(ctx.history ?? []), { role: 'user', content: ctx.goal }],
      });
      accumulate(trace, out);
      chargeBudget(budget, out);
      candidates.push({ id: m, answer: out.text });
    }

    if (candidates.length < 2) {
      // Couldn't gather enough candidates within budget. Return whatever
      // single answer we got, or fall through to ToT if none.
      if (candidates.length === 1) return candidates[0].answer;
      return this.tot(ctx, cfg, trace, budget);
    }

    const outcome = await runCouncil({
      question: ctx.goal,
      candidates,
      voters: panel.slice(0, candidates.length),
      vote: async ({ voter, question, candidates }) => {
        if (budgetExceeded(budget)) {
          // Synthesize an abstain vote that won't tip the tally.
          return {
            voter,
            candidate: -1,
            confidence: 0,
            rationale: '(budget exhausted)',
          };
        }
        const ballot = candidates
          .map((c, i) => `[${i}] ${c.answer}`)
          .join('\n\n');
        const out = await this.model.complete({
          model: voter,
          system:
            'You are a judge. Pick the BEST candidate by index. Return JSON ' +
            '{candidate: int, confidence: 0..1, rationale: string}.',
          messages: [
            { role: 'user', content: `Question: ${question}\n\n${ballot}` },
          ],
          temperature: 0,
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        const v = tryParseVote(out.text);
        return { voter, ...v };
      },
      synthesize: async ({ question, candidates }) => {
        if (budgetExceeded(budget)) {
          // Out of budget — fall back to the first candidate verbatim
          // rather than paying for another model call.
          return candidates[0]?.answer ?? '';
        }
        const all = candidates.map((c, i) => `[${i}] ${c.answer}`).join('\n\n');
        const out = await this.model.complete({
          model: this.model.primary,
          system:
            'Several models disagree. Synthesize a single answer that ' +
            'preserves what all candidates agree on, flags genuine disputes, ' +
            'and resolves with the most defensible position.',
          messages: [{ role: 'user', content: `Q: ${question}\n\n${all}` }],
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        return out.text;
      },
    });

    trace.votes = outcome.votes;
    return outcome.synthesized ?? outcome.winner?.answer ?? '(no consensus)';
  }

  // -- Self-refine pass -----------------------------------------------------

  private async refine(
    ctx: CognitiveContext,
    draft: string,
    trace: CognitionTrace,
    budget: CognitionBudget,
  ): Promise<string> {
    const result = await refine({
      question: ctx.goal,
      draft,
      critic: async ({ question, draft }) => {
        if (budgetExceeded(budget)) {
          // Pretend the draft is acceptable so the loop returns immediately.
          return { acceptable: true, severity: 0, issues: [], tokens: 0 };
        }
        const out = await this.model.complete({
          model: this.model.small,
          system:
            'You are a strict reviewer. Return JSON: ' +
            '{acceptable: bool, severity: 0..1, issues: string[], fixPrompt: string}. ' +
            'Look specifically for: factual errors, missed constraints, hallucinated tool output, vague hedging, contradictions.',
          messages: [
            { role: 'user', content: `Question: ${question}\nDraft: ${draft}` },
          ],
          temperature: 0,
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        const parsed = tryParseCritique(out.text);
        return { ...parsed, tokens: out.outputTokens };
      },
      rewrite: async ({ question, draft, critique }) => {
        if (budgetExceeded(budget)) {
          // Out of budget — return the draft unchanged. The refine loop's
          // recheck will then see no improvement and stop.
          return { revised: draft, tokens: 0 };
        }
        const out = await this.model.complete({
          model: this.model.primary,
          system: ctx.system,
          messages: [
            { role: 'user', content: question },
            { role: 'assistant', content: draft },
            {
              role: 'user',
              content:
                'A reviewer flagged these issues:\n' +
                critique.issues.map((i) => `- ${i}`).join('\n') +
                '\nRewrite to address them. ' +
                (critique.fixPrompt ?? ''),
            },
          ],
        });
        accumulate(trace, out);
        chargeBudget(budget, out);
        return { revised: out.text, tokens: out.outputTokens };
      },
    });
    return result.finalAnswer;
  }
}

// -- helpers --------------------------------------------------------------

function accumulate(
  trace: CognitionTrace,
  out: { inputTokens: number; outputTokens: number; costUsd: number },
) {
  trace.tokens = trace.tokens ?? { input: 0, output: 0 };
  trace.tokens.input += out.inputTokens;
  trace.tokens.output += out.outputTokens;
  trace.costUsd = (trace.costUsd ?? 0) + out.costUsd;
}

function reactPrompt(tools: ToolDescriptor[]): string {
  return [
    'You can call tools. Reply in JSON of one of the forms:',
    `{"thought": "...", "action": {"tool": "...", "args": {...}, "callId": "..."}}`,
    `{"thought": "...", "finalAnswer": "..."}`,
    'Tools:',
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
  ].join('\n');
}

export function tryParseReact(s: string): {
  thought: string;
  action?: { tool: string; args: Record<string, unknown>; callId: string };
  finalAnswer?: string;
} {
  try {
    const j = JSON.parse(extractJson(s));
    return {
      thought: typeof j.thought === 'string' ? j.thought : '',
      action: j.action
        ? {
            tool: String(j.action.tool ?? ''),
            args:
              j.action.args && typeof j.action.args === 'object'
                ? j.action.args
                : {},
            callId:
              typeof j.action.callId === 'string' && j.action.callId
                ? j.action.callId
                : randomUUID(),
          }
        : undefined,
      finalAnswer:
        typeof j.finalAnswer === 'string' ? j.finalAnswer : undefined,
    };
  } catch {
    // Don't terminate the ReAct loop with raw garbage as the answer —
    // surface it as a thought so the loop can continue or time out.
    return { thought: s };
  }
}

export function tryParseScore(s: string): { score: number; critique: string } {
  try {
    const j = JSON.parse(extractJson(s));
    return {
      score: clamp01(Number(j.score)),
      critique:
        typeof j.critique === 'string' ? j.critique : String(j.critique ?? ''),
    };
  } catch {
    // Malformed — score 0 so the branch gets pruned.
    return { score: 0, critique: s.slice(0, 200) };
  }
}

export function tryParseVote(s: string): {
  candidate: number;
  confidence: number;
  rationale: string;
} {
  try {
    const j = JSON.parse(extractJson(s));
    const candidateNum = Number(j.candidate);
    return {
      candidate: Number.isFinite(candidateNum)
        ? Math.max(0, Math.floor(candidateNum))
        : 0,
      confidence: clamp01(Number(j.confidence)),
      rationale:
        typeof j.rationale === 'string'
          ? j.rationale
          : String(j.rationale ?? ''),
    };
  } catch {
    return { candidate: 0, confidence: 0, rationale: s.slice(0, 200) };
  }
}

export function tryParseCritique(s: string): {
  acceptable: boolean;
  severity: number;
  issues: string[];
  fixPrompt?: string;
} {
  try {
    const j = JSON.parse(extractJson(s));
    return {
      acceptable: Boolean(j.acceptable),
      severity: clamp01(Number(j.severity)),
      issues: Array.isArray(j.issues)
        ? j.issues.map((x: unknown) => String(x))
        : [],
      fixPrompt: j.fixPrompt ? String(j.fixPrompt) : undefined,
    };
  } catch {
    return { acceptable: true, severity: 0, issues: [] };
  }
}

export function extractJson(s: string): string {
  // Tolerate ``` fences and prose around a JSON blob.
  const m = s.match(/\{[\s\S]*\}/);
  return m ? m[0] : s;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
