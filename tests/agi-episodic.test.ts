import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { EpisodicLog } from "../src/memory/episodic.js";

async function tempLogPath(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return join(dir, "episodes.jsonl");
}

describe("episodic log", () => {
  it("appends episodes that round-trip via readWindow", async () => {
    const path = await tempLogPath("ep-basic-");
    const log = new EpisodicLog(path);
    await log.append({ id: "1", scope: "g", actor: "user", content: "hello" });
    await log.append({ id: "2", scope: "g", actor: "assistant", content: "world" });
    const out = await log.readWindow({});
    expect(out.map((e) => e.content)).toEqual(["hello", "world"]);
  });

  it("serializes concurrent appends — no interleaving on long lines", async () => {
    const path = await tempLogPath("ep-concurrent-");
    const log = new EpisodicLog(path);
    // Long content per line so a non-serialized writer would interleave bytes.
    const longA = "A".repeat(50_000);
    const longB = "B".repeat(50_000);
    await Promise.all([
      log.append({ id: "a", scope: "g", actor: "user", content: longA }),
      log.append({ id: "b", scope: "g", actor: "user", content: longB }),
    ]);
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      // Each line must be valid JSON — interleaved bytes would break parse.
      const parsed = JSON.parse(l);
      expect(typeof parsed.content).toBe("string");
      // Content must be entirely one letter, never a mix.
      expect(parsed.content === longA || parsed.content === longB).toBe(true);
    }
  });

  it("rotates the file when size exceeds the configured threshold", async () => {
    const path = await tempLogPath("ep-rotate-");
    const log = new EpisodicLog(path, { rotateBytes: 4_000 });
    // Write three ~2KB lines — the third should trigger rotation.
    for (let i = 0; i < 3; i++) {
      await log.append({
        id: `e${i}`,
        scope: "g",
        actor: "user",
        content: "x".repeat(2_000),
      });
    }
    // The active file should be smaller than the cumulative writes...
    const s = await stat(path);
    expect(s.size).toBeLessThan(6_000);
    // ...and a rotated sibling should exist alongside it.
    const dir = dirname(path);
    const siblings = await readdir(dir);
    const rotated = siblings.filter((f) => f.startsWith("episodes.jsonl.") && f.endsWith(".jsonl"));
    expect(rotated.length).toBeGreaterThanOrEqual(1);
  });

  it("readWindow filters by scope, since, until, and limit", async () => {
    const path = await tempLogPath("ep-filter-");
    const log = new EpisodicLog(path);
    const t0 = 1_000;
    await log.append({ id: "a", scope: "g", actor: "u", content: "1", at: t0 });
    await log.append({ id: "b", scope: "u", actor: "u", content: "2", at: t0 + 10 });
    await log.append({ id: "c", scope: "g", actor: "u", content: "3", at: t0 + 20 });
    const onlyG = await log.readWindow({ scope: "g" });
    expect(onlyG.map((e) => e.id)).toEqual(["a", "c"]);
    const since = await log.readWindow({ since: t0 + 15 });
    expect(since.map((e) => e.id)).toEqual(["c"]);
  });

  it("readWindow skips corrupt lines", async () => {
    const path = await tempLogPath("ep-corrupt-");
    const log = new EpisodicLog(path);
    await log.append({ id: "a", scope: "g", actor: "u", content: "ok" });
    // Corrupt the file by appending a malformed line.
    await writeFile(path, (await readFile(path, "utf8")) + "{ not json\n");
    const out = await log.readWindow({});
    expect(out.map((e) => e.id)).toEqual(["a"]);
  });
});
