import { describe, expect, it } from "vitest";
import {
  planAndExecute,
  reactLoop,
  type LlmPlanFn,
  type LlmPlannerFn,
} from "../src/agi-core/planner.js";
import type { ToolDescriptor } from "../src/agi-core/types.js";

describe("planner.reactLoop", () => {
  it("terminates with empty answer when finalAnswer never appears", async () => {
    const tools: ToolDescriptor[] = [
      {
        name: "noop",
        description: "does nothing",
        schema: {},
        effect: "read",
      },
    ];
    let calls = 0;
    const llm: LlmPlannerFn = async () => {
      calls += 1;
      return {
        thought: `step ${calls}`,
        action: { tool: "noop", args: { x: calls }, callId: `c${calls}` },
        tokens: 1,
      };
    };
    const result = await reactLoop({
      initial: [],
      tools,
      llm,
      run: async (call) => ({ callId: call.callId, ok: true, output: "ok" }),
      maxSteps: 4,
    });
    expect(result.answer).toBe("");
    expect(result.steps.length).toBe(4);
    expect(calls).toBe(4);
  });

  it("returns the final answer when the model emits one", async () => {
    const llm: LlmPlannerFn = async () => ({
      thought: "I know it",
      finalAnswer: "42",
      tokens: 1,
    });
    const result = await reactLoop({
      initial: [],
      tools: [],
      llm,
      run: async () => ({ callId: "x", ok: true }),
      maxSteps: 5,
    });
    expect(result.answer).toBe("42");
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].done).toBe(true);
  });
});

describe("planner.planAndExecute", () => {
  const tools: ToolDescriptor[] = [
    {
      name: "writeFile",
      description: "writes a file",
      schema: {},
      effect: "write",
    },
  ];

  it("returns ok:false after maxRevisions exhausted", async () => {
    let planCalls = 0;
    const plan: LlmPlanFn = async () => {
      planCalls += 1;
      return {
        steps: [
          {
            description: "always fails",
            tool: "writeFile",
            args: { path: "/tmp/x" },
          },
        ],
        tokens: 1,
      };
    };
    const result = await planAndExecute({
      goal: "G",
      tools,
      plan,
      run: async (call) => ({
        callId: call.callId,
        ok: false,
        error: "boom",
      }),
      maxRevisions: 2,
    });
    expect(result.ok).toBe(false);
    // initial plan + 2 revisions = 3 plan calls.
    expect(planCalls).toBe(3);
    expect(result.plan.revisions).toBe(2);
  });

  it("carries forward done steps across replans", async () => {
    let planCalls = 0;
    const plan: LlmPlanFn = async () => {
      planCalls += 1;
      if (planCalls === 1) {
        return {
          steps: [
            { description: "step A (ok)", tool: undefined },
            {
              description: "step B (will fail)",
              tool: "writeFile",
              args: { path: "/bad" },
            },
          ],
          tokens: 1,
        };
      }
      // Replan: only the recovery step. The done step from the original
      // plan must still be present in the final plan.
      return {
        steps: [
          {
            description: "step C (recovery)",
            tool: "writeFile",
            args: { path: "/good" },
          },
        ],
        tokens: 1,
      };
    };
    const result = await planAndExecute({
      goal: "G",
      tools,
      plan,
      run: async (call) => ({
        callId: call.callId,
        ok: call.tool === "writeFile" && call.args.path === "/good",
        error:
          call.args.path === "/good" ? undefined : "could not write to /bad",
      }),
      maxRevisions: 2,
    });
    expect(result.ok).toBe(true);
    const descriptions = result.plan.steps.map((s) => s.description);
    expect(descriptions).toContain("step A (ok)");
    expect(descriptions).toContain("step C (recovery)");
    // The done step A must be marked done after replanning.
    const stepA = result.plan.steps.find((s) => s.description === "step A (ok)");
    expect(stepA?.status).toBe("done");
  });

  it("refuses to run a tool step with empty args", async () => {
    let runCalls = 0;
    const plan: LlmPlanFn = async () => ({
      steps: [
        { description: "missing args", tool: "writeFile" },
      ],
      tokens: 1,
    });
    const result = await planAndExecute({
      goal: "G",
      tools,
      plan,
      run: async (call) => {
        runCalls += 1;
        return { callId: call.callId, ok: true };
      },
      maxRevisions: 0,
    });
    // Tool runner must not have been called.
    expect(runCalls).toBe(0);
    expect(result.ok).toBe(false);
    const failed = result.plan.steps.find((s) => s.status === "failed");
    expect(failed?.result?.error).toMatch(/no args/i);
  });
});
