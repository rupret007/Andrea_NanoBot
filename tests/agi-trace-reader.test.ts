import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAgiTraces, summarizeTrace } from "../scripts/agi-trace.js";
import type { CognitionTrace } from "../src/agi-core/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agi-trace-reader-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("AGI trace reader", () => {
  it("reads direct traces, runtime envelopes, and audit payload envelopes from JSONL", async () => {
    const trace = sampleTrace();
    const path = join(dir, "trace.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify(trace),
        JSON.stringify({ reply: "ok", trace }),
        JSON.stringify({ kind: "trace.summary", trace, toolsUsed: ["memory.search"] }),
        JSON.stringify({ kind: "trace.snapshot", payload: { cognitionTrace: trace } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await readAgiTraces(path);

    expect(result.errors).toEqual([]);
    expect(result.records).toHaveLength(4);
    expect(result.records[0].line).toBe(1);
    expect(result.records.map((record) => summarizeTrace(record.trace).nodeCount)).toEqual([2, 2, 2, 2]);
  });

  it("reports malformed JSONL lines without dropping valid traces", async () => {
    const path = join(dir, "trace.jsonl");
    await writeFile(path, `${JSON.stringify(sampleTrace())}\nnot-json\n`, "utf8");

    const result = await readAgiTraces(path);

    expect(result.records).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].line).toBe(2);
  });
});

function sampleTrace(): CognitionTrace {
  return {
    goal: "test goal",
    startedAt: 100,
    finishedAt: 150,
    nodes: [
      {
        id: "root",
        thought: "start",
        depth: 0,
        createdAt: 101,
      },
      {
        id: "tool",
        parentId: "root",
        thought: "call",
        depth: 1,
        createdAt: 102,
        toolCall: { tool: "memory.search", args: { q: "x" }, callId: "call-1" },
      },
    ],
    acceptedPath: ["root", "tool"],
    answer: "done",
    tokens: { input: 3, output: 4 },
    latencyMs: 50,
    costUsd: 0.01,
  };
}
