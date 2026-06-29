import { describe, expect, it } from "vitest";
import type { ToolDescriptor } from "../src/agi-core/types.js";
import { evaluate } from "../src/safety/policy.js";

const tool = (effect: ToolDescriptor["effect"]): ToolDescriptor => ({
  name: "x",
  description: "",
  schema: {},
  effect,
});

const ctx = (overrides: Partial<Parameters<typeof evaluate>[2]> = {}) => ({
  initiatedByUser: true,
  inConfirmationFlow: false,
  budgetExceeded: false,
  allowed: new Set<string>(),
  denied: new Set<string>(),
  alwaysConfirm: new Set<string>(),
  ...overrides,
});

const inv = { tool: "x", args: {}, callId: "1" };

describe("policy gate", () => {
  it("denies background destructive calls", () => {
    const d = evaluate(tool("destructive"), inv, ctx({ initiatedByUser: false }));
    expect(d.kind).toBe("deny");
  });

  it("requires confirmation on user-initiated external calls", () => {
    const d = evaluate(tool("external"), inv, ctx());
    expect(d.kind).toBe("confirm");
  });

  it("allows read calls without confirmation", () => {
    const d = evaluate(tool("read"), inv, ctx());
    expect(d.kind).toBe("allow");
  });

  it("respects user blocklist", () => {
    const d = evaluate(tool("read"), inv, ctx({ denied: new Set(["x"]) }));
    expect(d.kind).toBe("deny");
  });

  it("denies when budget exceeded", () => {
    const d = evaluate(tool("read"), inv, ctx({ budgetExceeded: true }));
    expect(d.kind).toBe("deny");
  });

  it("write returns warn (not allow) outside confirmation flow", () => {
    const d = evaluate(tool("write"), inv, ctx());
    expect(d.kind).toBe("warn");
    if (d.kind === "warn") {
      expect(d.reason).toMatch(/silent allow/i);
    }
  });

  it("write returns allow inside confirmation flow", () => {
    const d = evaluate(tool("write"), inv, ctx({ inConfirmationFlow: true }));
    expect(d.kind).toBe("allow");
  });
});

describe("policy precedence", () => {
  it("denied overrides allowed", () => {
    const d = evaluate(
      tool("read"),
      inv,
      ctx({ allowed: new Set(["x"]), denied: new Set(["x"]) }),
    );
    expect(d.kind).toBe("deny");
  });

  it("allowed overrides alwaysConfirm", () => {
    const d = evaluate(
      tool("destructive"),
      inv,
      ctx({ allowed: new Set(["x"]), alwaysConfirm: new Set(["x"]) }),
    );
    expect(d.kind).toBe("allow");
  });

  it("budgetExceeded overrides allowed", () => {
    const d = evaluate(
      tool("read"),
      inv,
      ctx({ allowed: new Set(["x"]), budgetExceeded: true }),
    );
    expect(d.kind).toBe("deny");
  });

  it("alwaysConfirm fires for foreground calls when not on allowed list", () => {
    const d = evaluate(
      tool("read"),
      inv,
      ctx({ alwaysConfirm: new Set(["x"]) }),
    );
    expect(d.kind).toBe("confirm");
  });
});

describe("policy background paths", () => {
  it("background-initiated read is allowed", () => {
    const d = evaluate(tool("read"), inv, ctx({ initiatedByUser: false }));
    expect(d.kind).toBe("allow");
  });

  it("background-initiated write returns warn (logged)", () => {
    const d = evaluate(tool("write"), inv, ctx({ initiatedByUser: false }));
    expect(d.kind).toBe("warn");
  });

  it("background-initiated external is denied", () => {
    const d = evaluate(tool("external"), inv, ctx({ initiatedByUser: false }));
    expect(d.kind).toBe("deny");
  });

  it("background-initiated destructive is denied", () => {
    const d = evaluate(tool("destructive"), inv, ctx({ initiatedByUser: false }));
    expect(d.kind).toBe("deny");
  });

  it("background-initiated denied entry stays denied", () => {
    const d = evaluate(
      tool("read"),
      inv,
      ctx({ initiatedByUser: false, denied: new Set(["x"]) }),
    );
    expect(d.kind).toBe("deny");
  });

  it("background-initiated allowed entry is honored (universal override)", () => {
    const d = evaluate(
      tool("destructive"),
      inv,
      ctx({ initiatedByUser: false, allowed: new Set(["x"]) }),
    );
    expect(d.kind).toBe("allow");
  });
});
