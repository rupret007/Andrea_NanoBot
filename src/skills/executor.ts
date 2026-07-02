/**
 * Skill executor — walk a workflow's steps with a model in the loop.
 *
 * For each step the executor:
 *   1. Builds a focused prompt with just that step's body + the running
 *      transcript so far.
 *   2. Calls the model once.
 *   3. If the step is a verification gate, asks the critic to score
 *      whether evidence was actually produced (not just claimed).
 *   4. Records the trace so the reflector can replay it later.
 *
 * The executor never auto-invokes external tools — that path goes through
 * the cognitive core's ReAct strategy. Skills are reasoning workflows; tool
 * use is delegated. This keeps the policy gate / audit log invariants
 * intact (every tool call still flows through agi-runtime.invokeTool).
 */

import type { Message } from '../agi-core/types.js';
import type {
  Skill,
  SkillExecutionResult,
  SkillExecutionStep,
  SkillStep,
} from './types.js';

export interface SkillExecutorModel {
  complete(params: {
    system?: string;
    messages: Message[];
    temperature?: number;
    maxTokens?: number;
    model?: string;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }>;
  primary?: string;
  small?: string;
}

export interface ExecuteSkillParams {
  skill: Skill;
  goal: string;
  /** Optional history to ground the workflow in the current conversation. */
  history?: Message[];
  /** Optional caller-supplied system prompt (constitution + persona + memory). */
  system?: string;
  /** Hard cap on combined output tokens — prevents runaway workflows. */
  maxOutputTokens?: number;
}

export async function executeSkill(
  model: SkillExecutorModel,
  params: ExecuteSkillParams,
): Promise<SkillExecutionResult> {
  const { skill, goal } = params;
  const startedAt = Date.now();
  const trace: SkillExecutionStep[] = [];

  // Workflow with no parsed steps — fall back to a single "follow body"
  // pass so we still produce a coherent answer.
  const steps: SkillStep[] = skill.steps.length
    ? skill.steps
    : [
        {
          index: 1,
          title: skill.name,
          body: skill.body,
          verification: false,
        },
      ];

  const baseSystem = [
    params.system,
    `You are following the "${skill.name}" workflow from ${skill.sourceId}.`,
    `Workflow purpose: ${skill.description}`,
    skill.rationalizations.length
      ? `Anti-rationalizations to resist:\n` +
        skill.rationalizations
          .slice(0, 6)
          .map((r) => `- "${r.excuse}" → ${r.rebuttal}`)
          .join('\n')
      : '',
    skill.redFlags.length
      ? `Red flags:\n${skill.redFlags.map((r) => `- ${r}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const transcript: Message[] = [...(params.history ?? [])];
  transcript.push({ role: 'user', content: goal });

  let outcome: SkillExecutionResult['outcome'] = 'completed';
  let failureReason: string | undefined;
  let outputBudget = params.maxOutputTokens ?? 4000;

  for (const step of steps) {
    if (outputBudget <= 0) {
      outcome = 'incomplete';
      failureReason = 'output budget exhausted';
      break;
    }
    const stepEntry: SkillExecutionStep = {
      step,
      startedAt: Date.now(),
      output: '',
      satisfied: false,
    };

    const stepPrompt =
      `Step ${step.index}: ${step.title}\n\n${step.body}\n\n` +
      (step.verification
        ? 'This is a verification gate — produce concrete evidence, not just a claim of completion.'
        : "Produce the step's deliverable. Be concrete; cite specifics.");

    try {
      const out = await model.complete({
        system: baseSystem,
        messages: [
          ...transcript,
          { role: 'assistant', content: `(working on step ${step.index})` },
          { role: 'user', content: stepPrompt },
        ],
        temperature: 0.2,
        maxTokens: Math.min(800, outputBudget),
        model: model.primary,
      });
      outputBudget -= out.outputTokens;
      stepEntry.output = out.text;
      // Push assistant turn into transcript so subsequent steps see it.
      transcript.push({ role: 'assistant', content: out.text });

      if (step.verification) {
        // Cheap critic pass — does the output actually contain evidence?
        const verdict = await model.complete({
          system:
            'You are a strict verifier. Reply with JSON {satisfied: bool, evidence: string, reason: string}. ' +
            'Mark satisfied=true ONLY if the previous answer contains concrete, checkable evidence (file diff, test output, link, code, measurement). ' +
            'Vague claims of completion are NOT evidence.',
          messages: [{ role: 'user', content: stepEntry.output }],
          temperature: 0,
          maxTokens: 200,
          model: model.small ?? model.primary,
        });
        outputBudget -= verdict.outputTokens;
        const parsed = safeParse(verdict.text, {
          satisfied: true,
          evidence: '',
          reason: '',
        });
        stepEntry.satisfied = Boolean(parsed.satisfied);
        stepEntry.evidence = String(parsed.evidence ?? '').slice(0, 500);
        if (!stepEntry.satisfied) {
          // Verification failed — record it but continue. Reflector will
          // notice the unsatisfied gate and queue a refinement proposal.
          outcome = 'incomplete';
          failureReason =
            failureReason ??
            `step ${step.index} failed verification: ${parsed.reason}`;
        }
      } else {
        stepEntry.satisfied = stepEntry.output.trim().length > 0;
      }
    } catch (err) {
      stepEntry.output = `(error: ${err instanceof Error ? err.message : String(err)})`;
      stepEntry.satisfied = false;
      outcome = 'aborted';
      failureReason = stepEntry.output;
      stepEntry.finishedAt = Date.now();
      trace.push(stepEntry);
      break;
    }

    stepEntry.finishedAt = Date.now();
    trace.push(stepEntry);
  }

  // Synthesize the final answer from the step trace. This is what the user
  // actually sees — keeps the response coherent even when the workflow has
  // 5+ steps.
  const synthesisSection = trace
    .map((t) => `## Step ${t.step.index} — ${t.step.title}\n${t.output}`)
    .join('\n\n');

  let finalAnswer = synthesisSection;
  if (trace.length > 1 && outputBudget > 200) {
    try {
      const synth = await model.complete({
        system:
          'Synthesize the step outputs below into a single answer for the user. ' +
          'Lead with the headline conclusion or deliverable. Inline only the most important details. ' +
          'If any step failed verification, flag it briefly at the end.',
        messages: [
          { role: 'user', content: `Goal: ${goal}\n\n${synthesisSection}` },
        ],
        temperature: 0.2,
        maxTokens: Math.min(1000, outputBudget),
      });
      finalAnswer = synth.text;
    } catch {
      // Synthesis failed — fall back to the raw step trace.
    }
  }

  const finishedAt = Date.now();
  return {
    skillId: skill.id,
    goal,
    startedAt,
    finishedAt,
    answer: finalAnswer,
    trace,
    citations: [
      {
        sourceId: skill.sourceId,
        sourcePath: skill.sourcePath,
        upstreamUrl: skill.upstreamUrl,
      },
    ],
    outcome,
    failureReason,
  };
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    const m = s.match(/\{[\s\S]*\}/);
    return JSON.parse(m ? m[0] : s) as T;
  } catch {
    return fallback;
  }
}
