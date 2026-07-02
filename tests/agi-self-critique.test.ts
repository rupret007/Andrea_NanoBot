import { describe, expect, it } from "vitest";
import { refine } from "../src/agi-core/self-critique.js";

describe("self-refine", () => {
  it("stops when the critic accepts", async () => {
    const result = await refine({
      question: "Q",
      draft: "first",
      critic: async () => ({ acceptable: true, severity: 0, issues: [], tokens: 1 }),
      rewrite: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result.finalAnswer).toBe("first");
  });

  it("does not return a worse-rated rewrite", async () => {
    let critiqueCall = 0;
    const result = await refine({
      question: "Q",
      draft: "first",
      critic: async () => {
        critiqueCall += 1;
        // First critique: bad. Second (after rewrite): worse. Should keep "first".
        return {
          acceptable: false,
          severity: critiqueCall === 1 ? 0.5 : 0.9,
          issues: ["bad"],
          tokens: 1,
        };
      },
      rewrite: async () => ({ revised: "worse", tokens: 1 }),
      maxIterations: 2,
    });
    expect(result.finalAnswer).toBe("first");
  });

  it("accepts a rewrite that improves", async () => {
    let call = 0;
    const result = await refine({
      question: "Q",
      draft: "first",
      critic: async () => {
        call += 1;
        return {
          acceptable: false,
          severity: call === 1 ? 0.7 : 0.1,
          issues: ["x"],
          tokens: 1,
        };
      },
      rewrite: async () => ({ revised: "better", tokens: 1 }),
      maxIterations: 2,
      acceptThreshold: 0.2,
    });
    expect(result.finalAnswer).toBe("better");
  });

  it("returns the input untouched when maxIterations is 0", async () => {
    let criticCalls = 0;
    const result = await refine({
      question: "Q",
      draft: "untouched",
      critic: async () => {
        criticCalls += 1;
        return { acceptable: false, severity: 1, issues: ["x"], tokens: 1 };
      },
      rewrite: async () => {
        throw new Error("should not be called");
      },
      maxIterations: 0,
    });
    expect(result.finalAnswer).toBe("untouched");
    expect(criticCalls).toBe(0);
    expect(result.iterations).toEqual([]);
  });

  it("stops at the best draft when rewrite improves then regresses", async () => {
    // Call 1 (initial): severity 0.7 (bad) → rewrite to v2.
    // Call 2 (recheck of v2): severity 0.3 (better) → accept v2, reuse 0.3.
    // Iteration 2 reuses 0.3 as the critique → not acceptable, rewrite to v3.
    // Call 3 (recheck of v3): severity 0.5 (worse) → keep v2.
    let call = 0;
    let rewriteCall = 0;
    const result = await refine({
      question: "Q",
      draft: "v1",
      critic: async () => {
        call += 1;
        let severity: number;
        if (call === 1) severity = 0.7;
        else if (call === 2) severity = 0.3;
        else severity = 0.5;
        return { acceptable: false, severity, issues: ["x"], tokens: 1 };
      },
      rewrite: async () => {
        rewriteCall += 1;
        return { revised: rewriteCall === 1 ? "v2" : "v3", tokens: 1 };
      },
      maxIterations: 3,
      acceptThreshold: 0.05,
    });
    expect(result.finalAnswer).toBe("v2");
    // Recheck should have been reused — without reuse the critic would have
    // been called more times.
    expect(call).toBe(3);
  });

  it("reuses recheck as the next iteration's critique (no extra critic call)", async () => {
    let criticCalls = 0;
    const result = await refine({
      question: "Q",
      draft: "v1",
      critic: async () => {
        criticCalls += 1;
        // call 1: bad, call 2: improved enough to accept on next iteration.
        return {
          acceptable: false,
          severity: criticCalls === 1 ? 0.8 : 0.05,
          issues: ["x"],
          tokens: 1,
        };
      },
      rewrite: async () => ({ revised: "v2", tokens: 1 }),
      maxIterations: 3,
      acceptThreshold: 0.1,
    });
    expect(result.finalAnswer).toBe("v2");
    // Without recheck reuse, iteration 2 would have called critic a 3rd time.
    expect(criticCalls).toBe(2);
  });
});
