import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HashEmbedder } from "../src/models/embedding-client.js";
import { VectorStore } from "../src/memory/vector-store.js";

describe("vector store", () => {
  it("upserts and recalls by similarity", async () => {
    const embed = new HashEmbedder(64);
    const store = new VectorStore(embed);
    await store.upsert({
      kind: "semantic",
      content: "Jeff plays guitar in Stalemate and Rad Dad",
      scope: "global",
      importance: 0.9,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
    });
    await store.upsert({
      kind: "semantic",
      content: "Mod Pizza is the kids' favorite",
      scope: "global",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
    });
    const hits = await store.recall({ text: "what bands does Jeff play in", topK: 1 });
    expect(hits[0].entry.content).toMatch(/Stalemate/);
  });

  it("respects scope filter", async () => {
    const embed = new HashEmbedder(64);
    const store = new VectorStore(embed);
    await store.upsert({
      kind: "semantic",
      content: "private fact",
      scope: "user-1",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
    });
    await store.upsert({
      kind: "semantic",
      content: "public fact",
      scope: "global",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
    });
    const hits = await store.recall({ text: "fact", scopes: ["global"], topK: 5 });
    expect(hits.every((h) => h.entry.scope === "global")).toBe(true);
  });

  it("decay drops low-importance, never-accessed entries", async () => {
    const embed = new HashEmbedder(32);
    const store = new VectorStore(embed);
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 365;
    await store.upsert({
      kind: "semantic",
      content: "stale",
      scope: "g",
      importance: 0.1,
      observedAt: ancient,
      lastAccessed: ancient,
    });
    await store.upsert({
      kind: "semantic",
      content: "core",
      scope: "g",
      importance: 0.9,
      observedAt: ancient,
      lastAccessed: ancient,
    });
    const dropped = await store.decay();
    expect(dropped).toBe(1);
    expect(store.size()).toBe(1);
  });

  describe("cosine guards", () => {
    let warnSpy: any;
    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("returns 0 on dim mismatch and does not produce NaN", async () => {
      const embed = new HashEmbedder(32);
      const store = new VectorStore(embed);
      // Insert with the configured dim, then poke a mismatched-embedding
      // entry into place to simulate a stale persisted vector.
      const e = await store.upsert({
        kind: "semantic",
        content: "hello",
        scope: "g",
        importance: 0.5,
        observedAt: Date.now(),
        lastAccessed: Date.now(),
      });
      e.embedding = new Float32Array(8); // mismatched dim
      e.embedding[0] = 1;
      // Query with a 32-dim embedding (correct dim).
      const hits = await store.recall({ text: "hello", topK: 1 });
      // similarity should be 0 (mismatch) — never NaN
      expect(Number.isNaN(hits[0].similarity)).toBe(false);
      expect(hits[0].similarity).toBe(0);
    });

    it("returns 0 when an input contains NaN", async () => {
      const embed = new HashEmbedder(16);
      const store = new VectorStore(embed);
      const e = await store.upsert({
        kind: "semantic",
        content: "boom",
        scope: "g",
        importance: 0.5,
        observedAt: Date.now(),
        lastAccessed: Date.now(),
      });
      // Poison embedding with NaN
      e.embedding = new Float32Array(16);
      e.embedding[0] = Number.NaN;
      const hits = await store.recall({ text: "boom", topK: 1 });
      expect(Number.isFinite(hits[0].similarity)).toBe(true);
      expect(hits[0].similarity).toBe(0);
    });
  });

  it("recency does not exceed 1 when observedAt is in the future", async () => {
    const embed = new HashEmbedder(32);
    const store = new VectorStore(embed);
    const future = Date.now() + 1000 * 60 * 60 * 24 * 365; // a year ahead
    await store.upsert({
      kind: "semantic",
      content: "from the future",
      scope: "g",
      importance: 0,
      observedAt: future,
      lastAccessed: future,
    });
    const hits = await store.recall({ text: "from the future", topK: 1 });
    // score = 0.7 * sim + 0.2 * recency + 0.1 * imp
    // recency must be clamped to <=1 → 0.2 contribution at most
    expect(hits[0].score).toBeLessThanOrEqual(0.7 + 0.2 + 0.0001);
  });

  it("only bumps lastAccessed for entries returned in topK", async () => {
    const embed = new HashEmbedder(32);
    const store = new VectorStore(embed);
    const old = Date.now() - 1000 * 60 * 60 * 24 * 100; // 100d ago
    const a = await store.upsert({
      kind: "semantic",
      content: "Stalemate is a band Jeff plays in",
      scope: "g",
      importance: 0.9,
      observedAt: old,
      lastAccessed: old,
    });
    const b = await store.upsert({
      kind: "semantic",
      content: "completely unrelated topic about gardening tomatoes",
      scope: "g",
      importance: 0.05,
      observedAt: old,
      lastAccessed: old,
    });
    const hits = await store.recall({ text: "Stalemate band", topK: 1 });
    expect(hits).toHaveLength(1);
    // Returned entry got bumped...
    expect(hits[0].entry.lastAccessed).toBeGreaterThan(old);
    // ...the un-returned one did NOT.
    const aStill = store.all().find((x) => x.id === a.id)!;
    const bStill = store.all().find((x) => x.id === b.id)!;
    if (hits[0].entry.id === a.id) {
      expect(bStill.lastAccessed).toBe(old);
    } else {
      expect(aStill.lastAccessed).toBe(old);
    }
  });

  it("decay respects the 'permanent' tag", async () => {
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed);
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 365;
    await store.upsert({
      kind: "semantic",
      content: "load-bearing fact",
      scope: "g",
      importance: 0.1,
      observedAt: ancient,
      lastAccessed: ancient,
      tags: ["permanent"],
    });
    const dropped = await store.decay();
    expect(dropped).toBe(0);
    expect(store.size()).toBe(1);
  });

  it("decay respects fresh access time", async () => {
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed);
    const ancient = Date.now() - 1000 * 60 * 60 * 24 * 365;
    await store.upsert({
      kind: "semantic",
      content: "low importance but recently used",
      scope: "g",
      importance: 0.05,
      observedAt: ancient,
      lastAccessed: Date.now(), // fresh
    });
    const dropped = await store.decay();
    expect(dropped).toBe(0);
  });

  it("flush is atomic — writes via .tmp then renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vstore-flush-"));
    const path = join(dir, "vec.jsonl");
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed, { path });
    await store.upsert({
      kind: "semantic",
      content: "atomicity matters",
      scope: "g",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
    });
    await store.flush();
    const body = await readFile(path, "utf8");
    // Header is on first line
    expect(body.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("__vectorStoreHeader");
    // No partial/truncated mid-line because rename is atomic.
    const lines = body.split("\n").filter(Boolean);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("flush creates the persistence directory when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vstore-missing-parent-"));
    const path = join(dir, "nested", "vec.jsonl");
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed, { path });
    await store.flush();
    const body = await readFile(path, "utf8");
    expect(body).toContain("__vectorStoreHeader");
  });

  it("flush load drops file when persisted embedder doesn't match", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vstore-mismatch-"));
    const path = join(dir, "vec.jsonl");
    // Write a header from a DIFFERENT model first, plus a bogus entry.
    const fakeHeader = JSON.stringify({
      __vectorStoreHeader: true,
      embedModelId: "some-other-model",
      embedDim: 999,
      version: 1,
    });
    const bogus = JSON.stringify({
      id: "x",
      kind: "semantic",
      content: "stale",
      scope: "g",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
      createdAt: Date.now(),
      embedding: new Array(999).fill(0),
    });
    await writeFile(path, fakeHeader + "\n" + bogus + "\n", "utf8");

    const embed = new HashEmbedder(32); // different dim and modelId
    const store = new VectorStore(embed, { path });
    await store.load();
    expect(store.size()).toBe(0);
  });

  it("flush load skips a single corrupt line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vstore-corrupt-"));
    const path = join(dir, "vec.jsonl");
    const embed = new HashEmbedder(16);
    const header = JSON.stringify({
      __vectorStoreHeader: true,
      embedModelId: embed.modelId,
      embedDim: embed.dim,
      version: 1,
    });
    const goodEntry = JSON.stringify({
      id: "ok",
      kind: "semantic",
      content: "ok",
      scope: "g",
      importance: 0.5,
      observedAt: Date.now(),
      lastAccessed: Date.now(),
      createdAt: Date.now(),
      embedding: new Array(16).fill(0),
    });
    await writeFile(path, [header, "{ THIS IS NOT JSON", goodEntry].join("\n") + "\n", "utf8");
    const store = new VectorStore(embed, { path });
    await store.load();
    expect(store.size()).toBe(1);
  });

  it("upsert defaults missing importance/observedAt and rejects bad scope", async () => {
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed);
    const e = await store.upsert({
      kind: "semantic",
      content: "missing fields",
      scope: "g",
      // importance, observedAt, lastAccessed all omitted
    } as any);
    expect(e.importance).toBe(0.5);
    expect(typeof e.observedAt).toBe("number");
    expect(typeof e.lastAccessed).toBe("number");

    await expect(
      store.upsert({
        kind: "semantic",
        content: "no scope",
        importance: 0.5,
        observedAt: Date.now(),
        lastAccessed: Date.now(),
      } as any),
    ).rejects.toThrow(/scope/);
  });

  it("upsert rejects mismatched embedding dim", async () => {
    const embed = new HashEmbedder(16);
    const store = new VectorStore(embed);
    await expect(
      store.upsert({
        kind: "semantic",
        content: "x",
        scope: "g",
        importance: 0.5,
        observedAt: Date.now(),
        lastAccessed: Date.now(),
        embedding: new Float32Array(8),
      }),
    ).rejects.toThrow(/dim/);
  });
});
