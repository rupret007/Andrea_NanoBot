/**
 * ReAct + plan-and-execute planner.
 *
 * Two complementary loops:
 *   1. ReAct (Reason → Act → Observe) for short, tool-driven tasks.
 *   2. Plan-and-execute for long-horizon tasks where committing to a plan up
 *      front, then re-planning only on failure, is cheaper and more coherent
 *      than re-deriving the plan after every tool call.
 *
 * The planner doesn't know about specific tools — it receives a `ToolDescriptor`
 * list and emits structured calls. The runner executes them (subject to
 * `safety/policy.ts` checks).
 *
 * References:
 *   Yao et al. 2022, "ReAct: Synergizing Reasoning and Acting in LLMs"
 *   Wang et al. 2023, "Plan-and-Solve Prompting"
 */

import { randomUUID } from 'node:crypto';
import type {
  Message,
  ToolDescriptor,
  ToolInvocation,
  ToolResult,
} from './types.js';

export interface PlanStep {
  id: string;
  description: string;
  /** If non-null, this step expects to call this tool. */
  tool?: string;
  /** Concrete arguments the planner emitted for this tool call. */
  args?: Record<string, unknown>;
  /** Pre-conditions that must be satisfied before running. */
  requires?: string[];
  /** Post-conditions this step asserts on success. */
  produces?: string[];
  /** Has this step succeeded? */
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: ToolResult;
  attempts: number;
}

export interface Plan {
  id: string;
  goal: string;
  steps: PlanStep[];
  /** Number of times the plan has been re-derived after a failure. */
  revisions: number;
}

export interface ReactStep {
  thought: string;
  action?: ToolInvocation;
  observation?: ToolResult;
  /** Final-answer marker. */
  done?: boolean;
  answer?: string;
}

export type LlmPlannerFn = (params: {
  history: Message[];
  tools: ToolDescriptor[];
}) => Promise<{
  thought: string;
  action?: ToolInvocation;
  finalAnswer?: string;
  tokens: number;
}>;

export type LlmPlanFn = (params: {
  goal: string;
  tools: ToolDescriptor[];
  observations?: string[];
}) => Promise<{
  steps: Omit<PlanStep, 'id' | 'status' | 'attempts'>[];
  tokens: number;
}>;

export type ToolRunner = (call: ToolInvocation) => Promise<ToolResult>;

/**
 * Run the ReAct loop. Best for tasks of <= ~10 tool calls where each
 * observation could change the plan.
 */
export async function reactLoop(params: {
  initial: Message[];
  tools: ToolDescriptor[];
  llm: LlmPlannerFn;
  run: ToolRunner;
  maxSteps?: number;
}): Promise<{ steps: ReactStep[]; answer: string; tokens: number }> {
  const maxSteps = params.maxSteps ?? 12;
  const history: Message[] = [...params.initial];
  const steps: ReactStep[] = [];
  let tokens = 0;

  for (let i = 0; i < maxSteps; i++) {
    const out = await params.llm({ history, tools: params.tools });
    tokens += out.tokens;

    const step: ReactStep = { thought: out.thought };

    if (out.finalAnswer) {
      step.done = true;
      step.answer = out.finalAnswer;
      steps.push(step);
      return { steps, answer: out.finalAnswer, tokens };
    }

    if (out.action) {
      step.action = out.action;
      const obs = await params.run(out.action);
      step.observation = obs;
      history.push({
        role: 'assistant',
        content: out.thought,
      });
      history.push({
        role: 'tool',
        content: stringify(obs.output ?? obs.error ?? ''),
        name: out.action.tool,
        toolCallId: out.action.callId,
      });
    }

    steps.push(step);
  }

  return { steps, answer: '', tokens };
}

/**
 * Build a plan, then execute. On a step failure, ask the planner to revise
 * — but only `maxRevisions` times before bailing out.
 */
export async function planAndExecute(params: {
  goal: string;
  tools: ToolDescriptor[];
  plan: LlmPlanFn;
  run: ToolRunner;
  maxRevisions?: number;
}): Promise<{ plan: Plan; tokens: number; ok: boolean }> {
  const maxRevisions = params.maxRevisions ?? 2;
  let tokens = 0;

  const planned = await params.plan({ goal: params.goal, tools: params.tools });
  tokens += planned.tokens;

  const plan: Plan = {
    id: randomUUID(),
    goal: params.goal,
    steps: planned.steps.map((s) => ({
      ...s,
      id: randomUUID(),
      status: 'pending',
      attempts: 0,
    })),
    revisions: 0,
  };

  while (true) {
    const next = plan.steps.find((s) => s.status === 'pending');
    if (!next) break;

    next.status = 'running';
    next.attempts += 1;

    if (next.tool) {
      const args = next.args ?? {};
      // Refuse to run a tool step with empty/missing args. A planner that
      // forgot to bind concrete arguments shouldn't blindly call the tool;
      // surface this as a step failure so replanning can fix it.
      if (!next.args || Object.keys(args).length === 0) {
        next.result = {
          callId: randomUUID(),
          ok: false,
          error: `Planner emitted no args for tool "${next.tool}".`,
        };
        next.status = 'failed';
      } else {
        const call: ToolInvocation = {
          tool: next.tool,
          args,
          callId: randomUUID(),
        };
        const obs = await params.run(call);
        next.result = obs;
        next.status = obs.ok ? 'done' : 'failed';
      }
    } else {
      // Non-tool steps are reasoning placeholders — mark done.
      next.status = 'done';
    }

    if (next.status === 'failed' && plan.revisions < maxRevisions) {
      plan.revisions += 1;
      // Carry forward already-done steps as observations; only replan the
      // pending tail. Discarding past successful work would force re-doing
      // it (and re-spending tokens / tool side-effects).
      const completedSteps = plan.steps.filter(
        (s) => s.status === 'done' || s.status === 'skipped',
      );
      const observations = plan.steps
        .filter((s) => s.result || s.status === 'done')
        .map((s) => {
          if (s.status === 'failed') {
            return `${s.description}: FAILED — ${s.result?.error ?? 'unknown error'}`;
          }
          if (s.status === 'done') {
            return `${s.description}: done`;
          }
          return `${s.description}: ${s.result?.error ?? 'ok'}`;
        });
      const replan = await params.plan({
        goal: plan.goal,
        tools: params.tools,
        observations,
      });
      tokens += replan.tokens;
      const newSteps = replan.steps.map((s) => ({
        ...s,
        id: randomUUID(),
        status: 'pending' as const,
        attempts: 0,
      }));
      // Preserve done steps; replace only the pending/failed tail with the
      // freshly-planned remainder.
      plan.steps = [...completedSteps, ...newSteps];
    } else if (next.status === 'failed') {
      return { plan, tokens, ok: false };
    }
  }

  return { plan, tokens, ok: true };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
