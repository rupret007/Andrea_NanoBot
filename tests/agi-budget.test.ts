import { describe, expect, it } from "vitest";
import { BudgetMeter } from "../src/safety/budget.js";

describe("budget meter", () => {
  it("tracks usd in window and reports exceeded", () => {
    const m = new BudgetMeter({ test: { windowMs: 60_000, maxUsd: 1 } });
    m.charge(0.5);
    expect(m.exceeded()).toBeNull();
    m.charge(0.6);
    expect(m.exceeded()?.window).toBe("test");
  });

  it("rolls off entries outside the window", async () => {
    const m = new BudgetMeter({ test: { windowMs: 50, maxUsd: 1 } });
    m.charge(2);
    expect(m.exceeded()).not.toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    // Trigger gc by another charge.
    m.charge(0);
    expect(m.exceeded()).toBeNull();
  });

  it("counts tool calls separately from model spend", () => {
    const m = new BudgetMeter({ test: { windowMs: 60_000, maxCalls: 1 } });
    m.charge(0.5, "model-a");
    expect(m.exceeded()).toBeNull();
    m.chargeToolCall("tool-a");
    expect(m.exceeded()?.reason).toMatch(/Call budget hit: 1/);
  });
});
