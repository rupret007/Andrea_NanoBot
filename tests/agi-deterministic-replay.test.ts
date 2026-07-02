import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgiRuntime } from "../src/agi-runtime.js";
import { replayQuestions, type ReplayPaths } from "../scripts/agi-replay.js";

let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
  AgiRuntime.__resetSingletonForTests();
});

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  AgiRuntime.__resetSingletonForTests();
});

describe("deterministic AGI replay", () => {
  it("replays the same question with stable replies and normalized traces", async () => {
    const first = await replayQuestions({
      paths: await tempPaths(),
      questions: [{ scope: "replay", text: "Summarize the current plan." }],
    });
    const second = await replayQuestions({
      paths: await tempPaths(),
      questions: [{ scope: "replay", text: "Summarize the current plan." }],
    });

    expect(first[0].reply).toBe(second[0].reply);
    expect(first[0].normalizedTrace).toEqual(second[0].normalizedTrace);
    expect(first[0].normalizedTrace.goal).toBe("Summarize the current plan.");
    expect(first[0].normalizedTrace.answer).toBe(first[0].reply);
  });

  it("preserves question order in batch replay", async () => {
    const results = await replayQuestions({
      paths: await tempPaths(),
      questions: [
        { scope: "replay", text: "First task" },
        { scope: "replay", text: "Second task" },
      ],
    });

    expect(results.map((result) => result.question.text)).toEqual(["First task", "Second task"]);
    expect(results[0].reply).not.toBe(results[1].reply);
  });
});

async function tempPaths(): Promise<ReplayPaths> {
  const dir = await mkdtemp(join(tmpdir(), "agi-replay-test-"));
  dirs.push(dir);
  return {
    vector: join(dir, "vectors.jsonl"),
    graph: join(dir, "graph.json"),
    episodic: join(dir, "episodes.jsonl"),
    audit: join(dir, "audit.jsonl"),
  };
}
