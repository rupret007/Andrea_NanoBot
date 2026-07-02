import { describe, expect, it } from "vitest";
import { searchTreeOfThoughts } from "../src/agi-core/tree-of-thoughts.js";
import { DEFAULT_COGNITION_CONFIG } from "../src/agi-core/types.js";

describe("tree-of-thoughts", () => {
  it("accepts early when a branch crosses the threshold", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 3,
      branchingFactor: 2,
      beamWidth: 1,
      acceptThreshold: 0.9,
    };
    let n = 0;
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => ({ thought: "step " + ++n, tokens: 5 }),
      async () => ({ score: 0.95, critique: "good", tokens: 1 }),
    );
    expect(result.reason).toBe("accepted");
    expect(result.best?.score).toBeGreaterThanOrEqual(0.9);
    expect(result.acceptedPath.length).toBeGreaterThan(0);
  });

  it("falls back to best-found when nothing crosses threshold", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 2,
      branchingFactor: 2,
      beamWidth: 1,
      acceptThreshold: 0.99,
    };
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => ({ thought: "x", tokens: 1 }),
      async () => ({ score: 0.5, critique: "meh", tokens: 1 }),
    );
    expect(result.reason).toBe("exhausted");
    expect(result.best?.score).toBeCloseTo(0.5, 5);
  });

  it("respects token budget", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 5,
      branchingFactor: 4,
      beamWidth: 4,
      acceptThreshold: 0.99,
      budgetTokens: 30,
    };
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => ({ thought: "x", tokens: 10 }),
      async () => ({ score: 0.4, critique: "", tokens: 10 }),
    );
    expect(result.reason).toBe("budget");
  });

  it("returns no best when branchingFactor is 0", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 3,
      branchingFactor: 0,
      beamWidth: 2,
      acceptThreshold: 0.9,
    };
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => {
        throw new Error("propose should not be called");
      },
      async () => {
        throw new Error("critique should not be called");
      },
    );
    expect(result.best).toBeUndefined();
    expect(["stuck", "exhausted"]).toContain(result.reason);
  });

  it("returns no best when maxDepth is 0", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 0,
      branchingFactor: 3,
      beamWidth: 2,
      acceptThreshold: 0.9,
    };
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => {
        throw new Error("propose should not be called");
      },
      async () => {
        throw new Error("critique should not be called");
      },
    );
    expect(result.best).toBeUndefined();
    expect(["stuck", "exhausted"]).toContain(result.reason);
  });

  it("honours the token budget at exact equality", async () => {
    // budget=20, propose=10, critique=10 → after one full proposal the
    // budget is exactly hit and a second iteration must NOT start.
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 5,
      branchingFactor: 4,
      beamWidth: 4,
      acceptThreshold: 0.99,
      budgetTokens: 20,
    };
    let proposeCalls = 0;
    let critiqueCalls = 0;
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => {
        proposeCalls += 1;
        return { thought: "x", tokens: 10 };
      },
      async () => {
        critiqueCalls += 1;
        return { score: 0.4, critique: "", tokens: 10 };
      },
    );
    expect(result.reason).toBe("budget");
    // At most one full propose+critique pair should fire before the
    // exact-equality boundary stops the search.
    expect(proposeCalls).toBe(1);
    expect(critiqueCalls).toBe(1);
  });

  it("prunes correctly so beam width is respected", async () => {
    const cfg = {
      ...DEFAULT_COGNITION_CONFIG,
      maxDepth: 2,
      branchingFactor: 4,
      beamWidth: 2,
      acceptThreshold: 0.99,
    };
    let counter = 0;
    const result = await searchTreeOfThoughts(
      "test",
      cfg,
      async () => ({ thought: "x" + counter++, tokens: 1 }),
      async ({ node }) => ({
        score: Number(node.thought.slice(1)) / 100,
        critique: "",
        tokens: 1,
      }),
    );
    const depth1Survivors = result.nodes.filter((n) => n.depth === 1 && !n.pruned);
    expect(depth1Survivors.length).toBeLessThanOrEqual(cfg.beamWidth);
  });
});
