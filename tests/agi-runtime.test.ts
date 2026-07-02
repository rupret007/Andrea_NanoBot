import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgiRuntime, type AgiRuntimeOptions } from "../src/agi-runtime.js";
import { HashEmbedder } from "../src/models/embedding-client.js";
import type { ProviderAdapter } from "../src/models/router.js";
import type { Integration, RegisteredTool } from "../src/integrations/types.js";
import type { CognitiveResult } from "../src/agi-core/index.js";
import {
  _closeDatabase,
  _initTestDatabase,
  isDatabaseInitialized,
  listWorldFacts,
} from "../src/db.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-runtime-"));
  AgiRuntime.__resetSingletonForTests();
});
afterEach(async () => {
  if (isDatabaseInitialized()) _closeDatabase();
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  AgiRuntime.__resetSingletonForTests();
});

const stubAnthropic = (): ProviderAdapter => ({
  provider: "anthropic",
  models: () => [
    {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      family: "claude-sonnet",
      contextTokens: 1_000_000,
      costInUsdPerMTok: 3,
      costOutUsdPerMTok: 15,
      p50LatencyMs: 900,
      capabilities: ["tool_use", "json_mode", "long_context", "low_latency", "voting"],
      available: true,
    },
    {
      id: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      family: "claude-haiku",
      contextTokens: 200_000,
      costInUsdPerMTok: 0.8,
      costOutUsdPerMTok: 4,
      p50LatencyMs: 350,
      capabilities: ["tool_use", "json_mode", "low_latency", "voting"],
      available: true,
    },
  ],
  complete: async (model) => ({
    text: model.id === "claude-haiku-4-5-20251001" ? "direct" : "stub-reply",
    model: model.id,
    inputTokens: 5,
    outputTokens: 5,
    costUsd: 0.0001,
    latencyMs: 5,
  }),
});

function baseOpts(overrides: Partial<AgiRuntimeOptions> = {}): AgiRuntimeOptions {
  return {
    embed: new HashEmbedder(64),
    providers: [stubAnthropic()],
    integrations: [],
    primaryModelId: "claude-sonnet-4-6",
    smallModelId: "claude-haiku-4-5-20251001",
    panelModelIds: [],
    paths: {
      vector: join(dir, "vec.jsonl"),
      graph: join(dir, "graph.json"),
      episodic: join(dir, "ep.jsonl"),
      audit: join(dir, "audit.jsonl"),
    },
    secretsFor: async () => ({ get: async () => undefined }),
    force: true,
    ...overrides,
  };
}

describe("AgiRuntime.ask resilience", () => {
  it("swallows memory.contextFor failures and still answers", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    const broken = vi
      .spyOn(rt.memory, "contextFor")
      .mockRejectedValue(new Error("vector-store-down"));
    const out = await rt.ask({ scope: "test", text: "hi" });
    expect(out.reply).toBeTruthy();
    expect(out.reply.length).toBeGreaterThan(0);
    expect(out.trace).toBeDefined();
    broken.mockRestore();
  });

  it("swallows memory.logEpisode failures after a successful reply", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    const broken = vi
      .spyOn(rt.memory, "logEpisode")
      .mockRejectedValue(new Error("disk-full"));
    const out = await rt.ask({ scope: "test", text: "hi" });
    expect(out.reply).toBeTruthy();
    broken.mockRestore();
  });

  it("swallows audit.write failures (last line of defense)", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    // Patch only the post-cognition writes by patching after construction.
    const origWrite = rt.audit.write.bind(rt.audit);
    let calls = 0;
    rt.audit.write = (async (entry: Parameters<typeof origWrite>[0]) => {
      calls += 1;
      // Fail every write — simulates audit log unavailable.
      throw new Error("audit-down");
    }) as typeof rt.audit.write;
    const out = await rt.ask({ scope: "test", text: "hi" });
    expect(out.reply).toBeTruthy();
    // We expect at least one safeAudit call to have been attempted.
    expect(calls).toBeGreaterThan(0);
  });

  it("returns the error-reply shape when cognition.think throws", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    vi.spyOn(rt.cognition, "think").mockRejectedValue(new Error("model-meltdown"));
    const out = await rt.ask({ scope: "test", text: "hi" });
    expect(out.reply).toMatch(/Andrea hit an internal error/);
    expect(out.reply).toMatch(/model-meltdown/);
    expect(out.trace).toBeDefined();
    expect(out.trace.nodes).toEqual([]);
  });

  it("returns canonical runtime metadata and truth calibration", async () => {
    _initTestDatabase();
    const rt = await AgiRuntime.create(baseOpts());
    vi.spyOn(rt.cognition, "think").mockResolvedValue({
      answer: "This is a calibrated test answer.",
      strategy: "direct",
      trace: {
        goal: "truth check",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        nodes: [],
        acceptedPath: [],
        answer: "This is a calibrated test answer.",
        tokens: { input: 1, output: 1 },
        latencyMs: 1,
        costUsd: 0,
      },
    });
    const out = await rt.ask({
      scope: "test",
      text: "truth check",
      source: "telegram:test-chat",
    });
    expect(out.runId).toMatch(/^runtime:run:/);
    expect(out.truth?.auditId).toMatch(/^truth:audit:/);
    expect(out.liveProofTags).toContain("telegram_canary");
  });
});

describe("AgiRuntime.invokeTool / confirmTool flow", () => {
  // A stub external-effect tool that should hit the confirm path.
  const sendEmailTool: RegisteredTool = {
    name: "stub.send_email",
    description: "Send an email",
    schema: {
      type: "object",
      required: ["to"],
      properties: { to: { type: "string" } },
    },
    effect: "external",
    handler: async (args) => ({ sent: true, to: (args as { to: string }).to }),
    integrationId: "stub",
  };
  const writeNoteTool: RegisteredTool = {
    name: "stub.write_note",
    description: "Write a note",
    schema: {
      type: "object",
      required: ["body"],
      properties: { body: { type: "string" } },
    },
    effect: "write",
    handler: async (args) => ({ wrote: true, body: (args as { body: string }).body }),
    integrationId: "stub",
  };
  const readNoteTool: RegisteredTool = {
    name: "stub.read_note",
    description: "Read a note",
    schema: { type: "object" },
    effect: "read",
    handler: async () => ({ body: "note" }),
    integrationId: "stub",
  };

  const stubIntegration: Integration = {
    id: "stub",
    displayName: "Stub",
    enabled: true,
    init: async () => undefined,
    register: async () => [sendEmailTool, writeNoteTool, readNoteTool],
  };

  it("returns pendingId for a confirm-required tool, then runs on approve", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const first = await rt.invokeTool({
      name: "stub.send_email",
      args: { to: "j@example.com" },
      initiatedByUser: true,
      callId: "model-call-id",
      confirmationScope: { chatJid: "chat-1" },
    });
    expect(first.ok).toBe(false);
    expect("pendingId" in first && typeof first.pendingId === "string").toBe(true);
    expect("decision" in first && first.decision?.kind).toBe("confirm");
    const pendingId = (first as { pendingId: string }).pendingId;
    expect(pendingId).not.toBe("model-call-id");
    expect(rt.pendingConfirmations.has(pendingId)).toBe(true);

    const approved = await rt.confirmTool(pendingId, true, { chatJid: "chat-1" });
    expect(approved.ok).toBe(true);
    expect(rt.pendingConfirmations.has(pendingId)).toBe(false);
  });

  it("rejects approval from a mismatched confirmation scope", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const first = await rt.invokeTool({
      name: "stub.send_email",
      args: { to: "j@example.com" },
      initiatedByUser: true,
      confirmationScope: { chatJid: "chat-1" },
    });
    const pendingId = (first as { pendingId: string }).pendingId;
    const rejected = await rt.confirmTool(pendingId, true, { chatJid: "chat-2" });
    expect(rejected.ok).toBe(false);
    expect("error" in rejected && rejected.error).toMatch(/scope mismatch/i);
    expect(rt.pendingConfirmations.has(pendingId)).toBe(true);
  });

  it("decline removes the pending and returns user-declined", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const first = await rt.invokeTool({
      name: "stub.send_email",
      args: { to: "j@example.com" },
      initiatedByUser: true,
    });
    const pendingId = (first as { pendingId: string }).pendingId;
    const declined = await rt.confirmTool(pendingId, false);
    expect(declined.ok).toBe(false);
    expect("error" in declined && declined.error).toMatch(/declined/i);
    expect(rt.pendingConfirmations.has(pendingId)).toBe(false);
  });

  it("expired pending (>5 min) is rejected", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const first = await rt.invokeTool({
      name: "stub.send_email",
      args: { to: "j@example.com" },
      initiatedByUser: true,
    });
    const pendingId = (first as { pendingId: string }).pendingId;
    // Force expiry by rewriting the createdAt.
    const pending = rt.pendingConfirmations.get(pendingId)!;
    pending.createdAt = Date.now() - 10 * 60 * 1000;
    const expired = await rt.confirmTool(pendingId, true);
    expect(expired.ok).toBe(false);
    expect("error" in expired && expired.error).toMatch(/expired|unknown/i);
  });

  it("validates args before policy gate (symmetric with registry)", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const out = await rt.invokeTool({
      name: "stub.send_email",
      // Missing required `to`.
      args: {},
      initiatedByUser: true,
    });
    expect(out.ok).toBe(false);
    expect("error" in out && out.error).toMatch(/Invalid arguments/i);
  });

  it("audits warn policy decisions before executing write tools", async () => {
    const rt = await AgiRuntime.create(baseOpts({ integrations: [stubIntegration] }));
    const out = await rt.invokeTool({
      name: "stub.write_note",
      args: { body: "hello" },
      initiatedByUser: true,
      callId: "write-1",
      confirmationScope: { chatJid: "chat-1" },
    });
    expect(out.ok).toBe(true);

    const auditRaw = await readFile(join(dir, "audit.jsonl"), "utf8");
    const entries = auditRaw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; payload?: { tool?: string } });
    expect(entries.some((entry) => entry.kind === "policy.warn" && entry.payload?.tool === "stub.write_note")).toBe(true);
  });

  it("charges executed tool calls against maxCalls budgets", async () => {
    const rt = await AgiRuntime.create(
      baseOpts({
        integrations: [stubIntegration],
        budgets: { tiny: { windowMs: 60_000, maxCalls: 1 } },
      }),
    );
    const first = await rt.invokeTool({
      name: "stub.read_note",
      args: {},
      initiatedByUser: true,
    });
    expect(first.ok).toBe(true);

    const second = await rt.invokeTool({
      name: "stub.read_note",
      args: {},
      initiatedByUser: true,
    });
    expect(second.ok).toBe(false);
    expect("decision" in second && second.decision?.kind).toBe("deny");
    expect("decision" in second && second.decision?.reason).toMatch(/Budget exceeded/i);
  });

  it("provides built-in memory tools backed by the belief ledger", async () => {
    _initTestDatabase();
    const rt = await AgiRuntime.create(baseOpts());
    const saved = await rt.invokeTool({
      name: "memory.save_fact",
      args: {
        fact: "Jeff prefers concise launch-readiness reports.",
        scope: "test",
        sensitivity: "personal",
      },
      initiatedByUser: true,
    });
    expect(saved.ok).toBe(true);
    const facts = listWorldFacts({ groupFolder: "test", limit: 10 });
    expect(facts.some((fact) => fact.summary.includes("concise"))).toBe(true);

    const factId = facts[0].factId;
    const explained = await rt.invokeTool({
      name: "memory.explain_source",
      args: { factId, scope: "test" },
      initiatedByUser: true,
    });
    expect(explained.ok).toBe(true);
    expect(JSON.stringify("output" in explained ? explained.output : "")).toContain(
      factId,
    );
  });
});

describe("AgiRuntime system-prompt assembly", () => {
  it("does not produce a leading blank section when persona is whitespace", async () => {
    let capturedSystem: string | undefined;
    const rt = await AgiRuntime.create(baseOpts({ persona: "   \n\t  " }));
    vi.spyOn(rt.cognition, "think").mockImplementation(async (ctx) => {
      capturedSystem = ctx.system;
      const result: CognitiveResult = {
        answer: "ok",
        strategy: "direct",
        trace: {
          goal: ctx.goal,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          nodes: [],
          acceptedPath: [],
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          costUsd: 0,
        },
      };
      return result;
    });
    await rt.ask({ scope: "s", text: "hi" });
    expect(capturedSystem).toBeDefined();
    // Should NOT begin with whitespace or a stray blank section before the
    // constitution heading.
    expect(capturedSystem!).not.toMatch(/^\s*\n\n/);
    expect(capturedSystem!.startsWith("\n")).toBe(false);
  });
});

describe("AgiRuntime integration context", () => {
  it("assigns per-integration workdirs under the configured workdir root", async () => {
    let seenWorkdir = "";
    const integration: Integration = {
      id: "mcp/demo.server",
      displayName: "Demo",
      enabled: true,
      init: async (ctx) => {
        seenWorkdir = ctx.workdir;
      },
      register: async () => [],
    };

    await AgiRuntime.create(
      baseOpts({
        integrations: [integration],
        paths: {
          vector: join(dir, "vec.jsonl"),
          graph: join(dir, "graph.json"),
          episodic: join(dir, "ep.jsonl"),
          audit: join(dir, "audit.jsonl"),
          workdirRoot: join(dir, "workdirs"),
        },
      }),
    );

    expect(seenWorkdir).toBe(join(dir, "workdirs", "mcp_demo.server"));
  });
});

describe("AgiRuntime traceId uniqueness under concurrent ask()", () => {
  it("generates distinct traceIds for parallel ask() calls in same scope+ms", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    const seen = new Set<string>();
    vi.spyOn(rt.cognition, "think").mockImplementation(async (ctx) => {
      seen.add(ctx.traceId);
      const result: CognitiveResult = {
        answer: "ok",
        strategy: "direct",
        trace: {
          goal: ctx.goal,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          nodes: [],
          acceptedPath: [],
          tokens: { input: 0, output: 0 },
          latencyMs: 0,
          costUsd: 0,
        },
      };
      return result;
    });
    const N = 16;
    await Promise.all(
      Array.from({ length: N }, () => rt.ask({ scope: "same", text: "hi" })),
    );
    expect(seen.size).toBe(N);
  });
});

describe("AgiRuntime trace summaries", () => {
  it("writes actual tools used to the JSONL trace summary", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    vi.spyOn(rt.cognition, "think").mockResolvedValue({
      answer: "used tool",
      strategy: "react",
      trace: {
        goal: "lookup",
        startedAt: Date.now(),
        finishedAt: Date.now(),
        nodes: [
          {
            id: "n1",
            thought: "search",
            depth: 1,
            createdAt: Date.now(),
            toolCall: { tool: "memory.search", args: { query: "x" }, callId: "c1" },
            toolResult: { callId: "c1", ok: true, output: { hits: [] } },
          },
        ],
        acceptedPath: ["n1"],
        tokens: { input: 1, output: 1 },
        latencyMs: 2,
        costUsd: 0.001,
      },
    });

    await rt.ask({ scope: "test", text: "lookup" });

    const raw = await readFile(join(dir, "audit.jsonl.traces.jsonl"), "utf8");
    const summary = JSON.parse(raw.trim()) as { toolsUsed?: string[] };
    expect(summary.toolsUsed).toEqual(["memory.search"]);
  });
});

describe("AgiRuntime singleton enforcement", () => {
  it("throws on second create() unless force is true", async () => {
    const rt1 = await AgiRuntime.create(baseOpts());
    expect(rt1).toBeDefined();
    let caught: unknown;
    try {
      await AgiRuntime.create({ ...baseOpts(), force: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/already instantiated/i);
  });

  it("force: true bypasses the guard", async () => {
    const rt1 = await AgiRuntime.create(baseOpts());
    expect(rt1).toBeDefined();
    const rt2 = await AgiRuntime.create({ ...baseOpts(), force: true });
    expect(rt2).toBeDefined();
  });
});

describe("AgiRuntime.shutdown", () => {
  it("flushes memory without throwing", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    const flushSpy = vi.spyOn(rt.memory, "flush").mockResolvedValue(undefined);
    await rt.shutdown();
    expect(flushSpy).toHaveBeenCalled();
  });

  it("closes the integration registry without throwing to callers", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    const closeSpy = vi.spyOn(rt.registry, "close").mockResolvedValue(undefined);
    await rt.shutdown();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("swallows registry close failures during shutdown", async () => {
    const rt = await AgiRuntime.create(baseOpts());
    vi.spyOn(rt.registry, "close").mockRejectedValue(new Error("close-failed"));
    await expect(rt.shutdown()).resolves.toBeUndefined();
  });
});
