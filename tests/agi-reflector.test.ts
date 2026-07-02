import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reflector, type ReflectorModel } from "../src/reflection/reflector.js";
import { MemoryFacade } from "../src/memory/index.js";
import { HashEmbedder } from "../src/models/embedding-client.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-reflector-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeMemory(): MemoryFacade {
  return new MemoryFacade(new HashEmbedder(64), {
    vectorPath: join(dir, "v.jsonl"),
    graphPath: join(dir, "g.json"),
    episodicPath: join(dir, "e.jsonl"),
  });
}

describe("Reflector empty-day short-circuit", () => {
  it("returns the no-activity patch with zero model calls", async () => {
    const memory = makeMemory();
    await memory.load();
    const calls = { n: 0 };
    const model: ReflectorModel = {
      complete: async () => {
        calls.n += 1;
        return { text: "" };
      },
    };
    const r = new Reflector(model, memory);
    const dayStart = Date.UTC(2026, 4, 8, 0, 0, 0);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const patch = await r.runDaily("test", dayStart, dayEnd);
    expect(calls.n).toBe(0);
    expect(patch.summary).toBe("No activity.");
    expect(patch.proposal).toMatch(/No interactions today/);
    expect(patch.touches).toEqual([]);
  });
});

describe("Reflector propose() fallback", () => {
  it("when model returns prose, falls back to bounded code-fenced body", async () => {
    const memory = makeMemory();
    await memory.load();
    await memory.logEpisode({
      id: "ep1",
      scope: "test",
      actor: "user",
      content: "I asked for an update",
      at: Date.UTC(2026, 4, 8, 12, 0, 0),
    });
    const longProse = "this is some prose ".repeat(2000);
    const model: ReflectorModel = {
      complete: async (params) => {
        const sys = params.system ?? "";
        if (sys.includes("introspective journal")) {
          return { text: '{"summary": "fine", "facts": []}' };
        }
        if (sys.includes("Find moments")) {
          return { text: '{"lessons": ["be more specific"]}' };
        }
        return { text: longProse };
      },
    };
    const r = new Reflector(model, memory);
    const dayStart = Date.UTC(2026, 4, 8, 0, 0, 0);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const patch = await r.runDaily("test", dayStart, dayEnd);
    expect(patch.proposal.startsWith("```md\n")).toBe(true);
    expect(patch.proposal.endsWith("\n```")).toBe(true);
    expect(patch.proposal.length).toBeLessThan(8200);
    expect(patch.proposal).toMatch(/truncated/);
  });
});

describe("Reflector timezone handling", () => {
  it("respects the tz option for the date string", async () => {
    const memory = makeMemory();
    await memory.load();
    const model: ReflectorModel = { complete: async () => ({ text: "" }) };
    const ms = Date.UTC(2026, 4, 8, 23, 0, 0);
    const dayEndMs = ms + 60 * 60 * 1000;
    const r1 = new Reflector(model, memory, { tz: "America/New_York" });
    const r2 = new Reflector(model, memory, { tz: "Asia/Tokyo" });
    const p1 = await r1.runDaily("scope-empty", ms, dayEndMs);
    const p2 = await r2.runDaily("scope-empty", ms, dayEndMs);
    expect(p1.date).toBe("2026-05-08");
    expect(p2.date).toBe("2026-05-09");
  });
});

describe("Reflector transcript truncation", () => {
  it("keeps the tail of the transcript (most recent activity)", async () => {
    const memory = makeMemory();
    await memory.load();
    const HEAD_SENTINEL = "HEAD_MARKER_ZZZ";
    const TAIL_SENTINEL = "TAIL_MARKER_ZZZ";
    const dayStart = Date.UTC(2026, 4, 8, 0, 0, 0);
    await memory.logEpisode({
      id: "ep-head",
      scope: "test",
      actor: "user",
      content: HEAD_SENTINEL,
      at: dayStart + 1000,
    });
    for (let i = 0; i < 50; i++) {
      await memory.logEpisode({
        id: "ep-pad-" + i,
        scope: "test",
        actor: "user",
        content: "padding ".repeat(200),
        at: dayStart + 1000 + (i + 1) * 1000,
      });
    }
    await memory.logEpisode({
      id: "ep-tail",
      scope: "test",
      actor: "user",
      content: TAIL_SENTINEL,
      at: dayStart + 1000 + 60 * 1000,
    });

    let observed = "";
    const model: ReflectorModel = {
      complete: async (params) => {
        const userMsg = params.messages.find((m) => m.role === "user");
        if (userMsg && typeof userMsg.content === "string") {
          observed += userMsg.content;
        }
        return { text: '{"summary":"x","facts":[]}' };
      },
    };
    const r = new Reflector(model, memory);
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    await r.runDaily("test", dayStart, dayEnd);
    expect(observed).toContain(TAIL_SENTINEL);
    expect(observed).not.toContain(HEAD_SENTINEL);
  });
});
