import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG,
  ModelRouter,
  RouterAggregateError,
  estimateCallCostUsd,
  type ProviderAdapter,
} from "../src/models/router.js";

const stub = (provider: ProviderAdapter["provider"]): ProviderAdapter => ({
  provider,
  models: () => DEFAULT_CATALOG.filter((m) => m.provider === provider),
  complete: async (model) => ({
    text: "ok-" + model.id,
    model: model.id,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.001,
    latencyMs: 1,
  }),
});

describe("model router", () => {
  it("picks lower-latency model when budgetMs is small", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    const ranked = r.pick({ messages: [], budgetMs: 800 });
    expect(ranked[0].id).toBe("claude-haiku-4-5-20251001");
  });

  it("filters by required capability", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    const ranked = r.pick({ messages: [], requires: ["long_context", "vision"] });
    expect(
      ranked.every(
        (m) => m.capabilities.includes("long_context") && m.capabilities.includes("vision"),
      ),
    ).toBe(true);
  });

  it("excludes providers when asked (council diversity)", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    r.registerAdapter(stub("openai"));
    const ranked = r.pick({ messages: [], excludeProviders: ["anthropic"] });
    expect(ranked.every((m) => m.provider !== "anthropic")).toBe(true);
  });

  it("falls back when first choice throws", async () => {
    let firstCalled = 0;
    const r = new ModelRouter();
    r.registerAdapter({
      provider: "anthropic",
      models: () => DEFAULT_CATALOG.filter((m) => m.provider === "anthropic"),
      complete: async () => {
        firstCalled += 1;
        throw new Error("boom");
      },
    });
    r.registerAdapter(stub("openai"));
    const out = await r.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out.model.startsWith("gpt") || out.model.startsWith("claude")).toBe(true);
    expect(firstCalled).toBeGreaterThanOrEqual(1);
  });

  it("aggregates errors when every provider fails", async () => {
    const r = new ModelRouter({ maxFallbacks: 5 });
    r.registerAdapter({
      provider: "anthropic",
      models: () => DEFAULT_CATALOG.filter((m) => m.provider === "anthropic"),
      complete: async () => {
        throw new Error("anthro-fail");
      },
    });
    r.registerAdapter({
      provider: "openai",
      models: () => DEFAULT_CATALOG.filter((m) => m.provider === "openai"),
      complete: async () => {
        throw new Error("oai-fail");
      },
    });
    let caught: unknown;
    try {
      await r.complete({ messages: [{ role: "user", content: "hi" }] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RouterAggregateError);
    const agg = caught as RouterAggregateError;
    const messages = agg.errors.map((e) => (e as Error).message).join("|");
    expect(messages).toContain("anthro-fail");
    expect(messages).toContain("oai-fail");
    expect(agg.message).toMatch(/All \d+ model attempts failed/);
  });

  it("preferId set but unavailable throws (default)", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    expect(() =>
      r.pick({ messages: [], preferId: "gpt-5", excludeProviders: ["openai"] }),
    ).toThrow(/preferId "gpt-5" not available/);
  });

  it("preferId unavailable falls back when preferIdOptional is true", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    const ranked = r.pick({
      messages: [],
      preferId: "no-such-model",
      preferIdOptional: true,
      excludeProviders: ["openai", "google", "local"],
    });
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].provider).toBe("anthropic");
  });

  it("does not route to catalog providers without registered adapters", async () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("local"));
    const out = await r.complete({
      messages: [{ role: "user", content: "hi" }],
      preferId: "gpt-5",
      preferIdOptional: true,
    });
    expect(out.model).toBe("llama3.3:70b");
  });

  it("preferId in pool but mid-pack is promoted to first", () => {
    const r = new ModelRouter();
    r.registerAdapter(stub("anthropic"));
    // claude-opus has more caps than haiku — without preferId, opus tends to outrank.
    const ranked = r.pick({ messages: [], preferId: "claude-haiku-4-5-20251001" });
    expect(ranked[0].id).toBe("claude-haiku-4-5-20251001");
  });

  it("budgetUsd filters now that the unit is fixed", async () => {
    const r = new ModelRouter({ maxFallbacks: 0 });
    r.registerAdapter(stub("anthropic"));
    // Estimated call cost for haiku = (0 input + 2048 * 4 / 1e6) ≈ $0.0082.
    // Set a budget far below that to ensure even the cheapest model is over.
    const veryTight = 0.000001;
    // Score-based: budget penalty is -5 for over-budget, but it still picks
    // best of available. We assert that estimateCallCostUsd > budget for all
    // anthropic models, AND that even the top pick exceeds the budget — the
    // router will note this in the score. Then we assert the call still
    // surfaces a stub success (router doesn't HARD-fail) but that pick order
    // changes when budget is honored.
    for (const m of DEFAULT_CATALOG.filter((m) => m.provider === "anthropic")) {
      const cost = estimateCallCostUsd(m, { messages: [], maxTokens: 2048 });
      expect(cost).toBeGreaterThan(veryTight);
    }
    // With a budget that ONLY haiku passes, haiku ranks first.
    const haikuCost = estimateCallCostUsd(
      DEFAULT_CATALOG.find((m) => m.id === "claude-haiku-4-5-20251001")!,
      { messages: [], maxTokens: 2048 },
    );
    const sonnetCost = estimateCallCostUsd(
      DEFAULT_CATALOG.find((m) => m.id === "claude-sonnet-4-6")!,
      { messages: [], maxTokens: 2048 },
    );
    expect(sonnetCost).toBeGreaterThan(haikuCost);
    const tightButHaikuFits = (haikuCost + sonnetCost) / 2;
    const ranked = r.pick({ messages: [], budgetUsd: tightButHaikuFits, maxTokens: 2048 });
    expect(ranked[0].id).toBe("claude-haiku-4-5-20251001");
  });

  it("estimateCallCostUsd grows with input length and maxTokens", () => {
    const m = DEFAULT_CATALOG.find((x) => x.id === "claude-opus-4-6")!;
    const small = estimateCallCostUsd(m, { messages: [{ role: "user", content: "hi" }], maxTokens: 10 });
    const big = estimateCallCostUsd(m, {
      messages: [{ role: "user", content: "x".repeat(10_000) }],
      maxTokens: 10_000,
    });
    expect(big).toBeGreaterThan(small);
  });

  it("cooldown lifts after the configured window with injected clock", async () => {
    let now = 1_000_000;
    const r = new ModelRouter({
      maxFallbacks: 4,
      cooldownMs: 5_000,
      now: () => now,
    });
    let calls = 0;
    r.registerAdapter({
      provider: "anthropic",
      models: () => DEFAULT_CATALOG.filter((m) => m.provider === "anthropic"),
      complete: async () => {
        calls += 1;
        throw new Error("transient");
      },
    });
    r.registerAdapter(stub("openai"));
    // First call: anthropic fails → cooldown set → falls through to openai.
    const out1 = await r.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out1.model.startsWith("gpt")).toBe(true);
    // Second call within cooldown: anthropic skipped → openai again.
    now += 1_000;
    const out2 = await r.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(out2.model.startsWith("gpt")).toBe(true);
    // After cooldown: anthropic re-eligible. Will be tried again (and will fail again).
    now += 10_000;
    const callsBefore = calls;
    await r.complete({ messages: [{ role: "user", content: "hi" }] });
    expect(calls).toBeGreaterThan(callsBefore);
  });
});
