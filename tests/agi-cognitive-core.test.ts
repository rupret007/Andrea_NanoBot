import { describe, expect, it, vi } from "vitest";
import {
  CognitiveCore,
  extractJson,
  tryParseCritique,
  tryParseReact,
  tryParseScore,
  tryParseVote,
  type ModelClient,
} from "../src/agi-core/cognitive-core.js";
import type { ToolDescriptor, ToolInvocation, ToolResult } from "../src/agi-core/types.js";

/**
 * Build a deterministic ModelClient stub. Each call goes through `respond`,
 * which is given the model id and the messages so the test can branch on
 * who's being called (classifier vs primary vs panel member).
 */
function makeStub(
  respond: (params: {
    model: string;
    messages: { role: string; content: string }[];
    system?: string;
  }) => string | Error,
  panel: string[] = [],
): ModelClient {
  return {
    primary: "primary",
    small: "small",
    panel,
    async complete(params) {
      const result = respond({
        model: params.model,
        messages: params.messages,
        system: params.system,
      });
      if (result instanceof Error) throw result;
      return {
        text: result,
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.0001,
      };
    },
  };
}

describe("CognitiveCore.classify fallbacks", () => {
  it("falls through to direct when the classifier throws", async () => {
    const client = makeStub(({ model }) => {
      if (model === "small") return new Error("classifier exploded");
      return "the answer";
    });
    // Spy on console.warn so the test doesn't pollute output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const core = new CognitiveCore(client);
    const result = await core.think({
      traceId: "t",
      goal: "hello",
    });
    expect(result.strategy).toBe("direct");
    expect(result.answer).toBe("the answer");
    warn.mockRestore();
  });

  it("falls through to direct on a non-whitelisted classifier label", async () => {
    const client = makeStub(({ model }) => {
      if (model === "small") return "MAYBE-COUNCIL?"; // garbage
      return "primary answer";
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const core = new CognitiveCore(client);
    const result = await core.think({
      traceId: "t",
      goal: "hi",
    });
    expect(result.strategy).toBe("direct");
    expect(result.answer).toBe("primary answer");
    warn.mockRestore();
  });

  it("falls through to direct when ReAct has no tools", async () => {
    const client = makeStub(({ model }) => {
      if (model === "small") return "react";
      return "primary direct answer";
    });
    const core = new CognitiveCore(client);
    const result = await core.think({
      traceId: "t",
      goal: "do something",
      tools: [],
    });
    // Classifier said "react", but with no tools we should fall through.
    expect(result.strategy).toBe("react");
    expect(result.answer).toBe("primary direct answer");
  });

  it("executes ReAct tools through the runtime runner and records them in the trace", async () => {
    const tool: ToolDescriptor = {
      name: "memory.search",
      description: "Search memory",
      schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      effect: "read",
    };
    const runner = vi.fn(async (call: ToolInvocation): Promise<ToolResult> => ({
      callId: call.callId,
      ok: true,
      output: { hits: ["alpha"] },
      latencyMs: 3,
    }));
    const client = makeStub(({ model, messages }) => {
      if (model === "small") {
        const last = messages[messages.length - 1]?.content ?? "";
        if (last.includes("Draft:")) {
          return JSON.stringify({ acceptable: true, severity: 0, issues: [] });
        }
        return "react";
      }
      if (messages.some((m) => m.role === "tool")) {
        return JSON.stringify({ thought: "I found it", finalAnswer: "alpha" });
      }
      return JSON.stringify({
        thought: "Need memory",
        action: { tool: "memory.search", args: { query: "alpha" }, callId: "call-1" },
      });
    });
    const core = new CognitiveCore(client);

    const result = await core.think({
      traceId: "trace",
      goal: "Find alpha",
      tools: [tool],
      toolRunner: runner,
    });

    expect(result.strategy).toBe("react");
    expect(result.answer).toBe("alpha");
    expect(runner).toHaveBeenCalledWith({
      tool: "memory.search",
      args: { query: "alpha" },
      callId: "call-1",
    });
    expect(result.trace.nodes.map((node) => node.toolCall?.tool).filter(Boolean)).toEqual([
      "memory.search",
    ]);
    expect(result.trace.nodes[0].toolResult?.output).toEqual({ hits: ["alpha"] });
  });

  it("council with fewer than 2 panelists falls through to ToT", async () => {
    // Panel of 1 forces the fallthrough to ToT.
    const client = makeStub(({ model, messages }) => {
      if (model === "small") {
        // Classifier or critic. Distinguish by message content.
        const last = messages[messages.length - 1]?.content ?? "";
        if (last.startsWith("Goal:")) {
          // ToT critic
          return JSON.stringify({ score: 0.95, critique: "good" });
        }
        if (last.includes("Draft:")) {
          // Refine critic
          return JSON.stringify({ acceptable: true, severity: 0, issues: [] });
        }
        return "council";
      }
      // Primary: produce ToT propose / synth answer.
      return "tot answer";
    }, ["only-one"]);
    const core = new CognitiveCore(client);
    const result = await core.think({
      traceId: "t",
      goal: "high stakes",
      config: { council: ["only-one"], maxDepth: 1, branchingFactor: 1 },
    });
    expect(result.strategy).toBe("council");
    // Even though strategy is "council", actual execution went through tot.
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
  });
});

describe("parser helpers", () => {
  describe("tryParseScore", () => {
    it("parses a clean JSON object", () => {
      expect(tryParseScore('{"score": 0.7, "critique": "ok"}')).toEqual({
        score: 0.7,
        critique: "ok",
      });
    });

    it("clamps scores out of [0,1]", () => {
      expect(tryParseScore('{"score": 1.5, "critique": "x"}').score).toBe(1);
      expect(tryParseScore('{"score": -0.5, "critique": "x"}').score).toBe(0);
    });

    it("returns score 0 on prose (so the branch is pruned)", () => {
      const r = tryParseScore("this is not JSON at all");
      expect(r.score).toBe(0);
    });

    it("returns score 0 on NaN values", () => {
      const r = tryParseScore('{"score": "banana", "critique": "x"}');
      expect(r.score).toBe(0);
    });

    it("tolerates fence-wrapped JSON", () => {
      const r = tryParseScore('```json\n{"score": 0.5, "critique": "ok"}\n```');
      expect(r.score).toBe(0.5);
    });

    it("handles partial JSON gracefully", () => {
      const r = tryParseScore('{"score": 0.5, "critique":');
      expect(r.score).toBe(0);
    });
  });

  describe("tryParseVote", () => {
    it("parses a clean JSON vote", () => {
      const v = tryParseVote('{"candidate": 1, "confidence": 0.8, "rationale": "r"}');
      expect(v).toEqual({ candidate: 1, confidence: 0.8, rationale: "r" });
    });

    it("clamps NaN confidence to 0", () => {
      const v = tryParseVote('{"candidate": 0, "confidence": "nope", "rationale": ""}');
      expect(v.confidence).toBe(0);
    });

    it("falls back on prose with confidence 0", () => {
      const v = tryParseVote("just rambling, no json");
      expect(v.confidence).toBe(0);
    });

    it("handles fence-wrapped JSON", () => {
      const v = tryParseVote('```\n{"candidate": 2, "confidence": 0.5, "rationale": "x"}\n```');
      expect(v.candidate).toBe(2);
    });
  });

  describe("tryParseCritique", () => {
    it("parses a clean critique", () => {
      const c = tryParseCritique(
        '{"acceptable": false, "severity": 0.6, "issues": ["a", "b"], "fixPrompt": "fix"}',
      );
      expect(c).toEqual({
        acceptable: false,
        severity: 0.6,
        issues: ["a", "b"],
        fixPrompt: "fix",
      });
    });

    it("clamps NaN severity to 0", () => {
      const c = tryParseCritique('{"acceptable": false, "severity": "x", "issues": []}');
      expect(c.severity).toBe(0);
    });

    it("returns a permissive default on garbage so the loop terminates", () => {
      const c = tryParseCritique("totally garbage prose");
      expect(c.acceptable).toBe(true);
      expect(c.severity).toBe(0);
      expect(c.issues).toEqual([]);
    });

    it("handles fence-wrapped JSON", () => {
      const c = tryParseCritique(
        '```json\n{"acceptable": true, "severity": 0, "issues": []}\n```',
      );
      expect(c.acceptable).toBe(true);
    });
  });

  describe("tryParseReact", () => {
    it("parses a final answer", () => {
      const r = tryParseReact('{"thought": "t", "finalAnswer": "42"}');
      expect(r.finalAnswer).toBe("42");
      expect(r.thought).toBe("t");
    });

    it("parses an action with args", () => {
      const r = tryParseReact(
        '{"thought": "go", "action": {"tool": "search", "args": {"q": "x"}, "callId": "c1"}}',
      );
      expect(r.action?.tool).toBe("search");
      expect(r.action?.args).toEqual({ q: "x" });
      expect(r.action?.callId).toBe("c1");
    });

    it("does NOT set finalAnswer when given prose", () => {
      const r = tryParseReact("just thinking out loud, no JSON");
      expect(r.finalAnswer).toBeUndefined();
      expect(r.thought).toBe("just thinking out loud, no JSON");
    });

    it("synthesizes a callId when one is missing", () => {
      const r = tryParseReact(
        '{"thought": "t", "action": {"tool": "x", "args": {"y": 1}}}',
      );
      expect(r.action?.callId).toBeTruthy();
    });

    it("tolerates fence-wrapped JSON", () => {
      const r = tryParseReact(
        '```json\n{"thought": "t", "finalAnswer": "ok"}\n```',
      );
      expect(r.finalAnswer).toBe("ok");
    });
  });

  describe("extractJson", () => {
    it("extracts the JSON blob from prose", () => {
      const out = extractJson('Some prose {"a": 1} trailing');
      expect(out).toBe('{"a": 1}');
    });

    it("returns the input when no braces are present", () => {
      expect(extractJson("nothing here")).toBe("nothing here");
    });

    it("captures the outermost braces of multi-line JSON", () => {
      const blob = '```\n{\n  "a": 1\n}\n```';
      const out = extractJson(blob);
      expect(JSON.parse(out)).toEqual({ a: 1 });
    });
  });
});
