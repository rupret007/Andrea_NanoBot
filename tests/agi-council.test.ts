import { describe, expect, it } from "vitest";
import { runCouncil } from "../src/agi-core/council.js";

describe("council", () => {
  it("declares a winner on unanimous vote", async () => {
    const candidates = [
      { id: "claude", answer: "A" },
      { id: "gpt", answer: "B" },
    ];
    const outcome = await runCouncil({
      question: "?",
      candidates,
      voters: ["claude", "gpt"],
      vote: async () => ({ voter: "_", candidate: 0, confidence: 1, rationale: "" }),
      synthesize: async () => "synth",
    });
    expect(outcome.winner?.id).toBe("claude");
    expect(outcome.unanimous).toBe(true);
  });

  it("synthesizes when margin is below threshold", async () => {
    const candidates = [
      { id: "a", answer: "A" },
      { id: "b", answer: "B" },
      { id: "c", answer: "C" },
    ];
    let i = 0;
    const outcome = await runCouncil({
      question: "?",
      candidates,
      voters: ["a", "b", "c"],
      vote: async () => ({
        voter: "_",
        candidate: (i++) % 3, // perfectly split
        confidence: 1,
        rationale: "",
      }),
      synthesize: async () => "synthesized",
      synthesisThreshold: 0.5,
    });
    expect(outcome.synthesized).toBe("synthesized");
    expect(outcome.winner).toBeUndefined();
  });

  it("returns the only candidate without voting", async () => {
    const outcome = await runCouncil({
      question: "?",
      candidates: [{ id: "x", answer: "X" }],
      voters: ["x"],
      vote: async () => {
        throw new Error("should not be called");
      },
      synthesize: async () => "",
    });
    expect(outcome.winner?.id).toBe("x");
    expect(outcome.unanimous).toBe(true);
  });

  it("synthesizes (and never claims unanimous) when voters is empty", async () => {
    const candidates = [
      { id: "a", answer: "A" },
      { id: "b", answer: "B" },
    ];
    const outcome = await runCouncil({
      question: "?",
      candidates,
      voters: [],
      vote: async () => {
        throw new Error("should not be called");
      },
      synthesize: async () => "synthesized",
    });
    expect(outcome.winner).toBeUndefined();
    expect(outcome.unanimous).toBe(false);
    expect(outcome.synthesized).toBe("synthesized");
  });

  it("synthesizes when every vote has an out-of-range candidate index", async () => {
    const candidates = [
      { id: "a", answer: "A" },
      { id: "b", answer: "B" },
    ];
    const outcome = await runCouncil({
      question: "?",
      candidates,
      voters: ["a", "b"],
      vote: async () => ({
        voter: "_",
        candidate: 99,
        confidence: 1,
        rationale: "",
      }),
      synthesize: async () => "synthesized",
    });
    expect(outcome.winner).toBeUndefined();
    expect(outcome.unanimous).toBe(false);
    expect(outcome.synthesized).toBe("synthesized");
  });

  it("handles NaN confidence without crashing or skewing the tally", async () => {
    const candidates = [
      { id: "a", answer: "A" },
      { id: "b", answer: "B" },
    ];
    const outcome = await runCouncil({
      question: "?",
      candidates,
      voters: ["a", "b"],
      vote: async () => ({
        voter: "_",
        candidate: 0,
        confidence: Number.NaN,
        rationale: "",
      }),
      synthesize: async () => "synthesized",
    });
    // All confidence is NaN -> totalScore is 0 -> synthesize.
    expect(outcome.winner).toBeUndefined();
    expect(outcome.unanimous).toBe(false);
    expect(outcome.synthesized).toBe("synthesized");
  });
});
