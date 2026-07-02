import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CognitionTrace } from "../src/agi-core/types.js";

export interface TraceRecord {
  sourcePath: string;
  line?: number;
  trace: CognitionTrace;
}

export interface TraceReadError {
  sourcePath: string;
  line?: number;
  error: string;
}

export interface TraceReadResult {
  records: TraceRecord[];
  errors: TraceReadError[];
}

export interface TraceSummary {
  goal: string;
  answer?: string;
  nodeCount: number;
  acceptedPathLength: number;
  prunedCount: number;
  toolCallCount: number;
  voteCount: number;
  latencyMs?: number;
  costUsd?: number;
  tokens?: { input: number; output: number };
  startedAt: number;
  finishedAt?: number;
}

export async function readAgiTraces(sourcePath: string): Promise<TraceReadResult> {
  const raw = await readFile(sourcePath, "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return { records: [], errors: [] };

  const records: TraceRecord[] = [];
  const errors: TraceReadError[] = [];

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const trace = extractTrace(item);
        if (trace) records.push({ sourcePath, trace });
        else errors.push({ sourcePath, error: "JSON item did not contain a cognition trace" });
      }
      return { records, errors };
    } catch {
      // Fall through to JSONL parsing. Some JSONL files start with a JSON
      // object line, so a whole-file parse failure is not necessarily fatal.
    }
  }

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const trace = extractTrace(parsed);
      if (trace) records.push({ sourcePath, line: i + 1, trace });
      else errors.push({ sourcePath, line: i + 1, error: "Line did not contain a cognition trace" });
    } catch (err) {
      errors.push({
        sourcePath,
        line: i + 1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { records, errors };
}

export function summarizeTrace(trace: CognitionTrace): TraceSummary {
  return {
    goal: trace.goal,
    answer: trace.answer,
    nodeCount: trace.nodes.length,
    acceptedPathLength: trace.acceptedPath.length,
    prunedCount: trace.nodes.filter((node) => node.pruned).length,
    toolCallCount: trace.nodes.filter((node) => node.toolCall).length,
    voteCount: trace.votes?.length ?? 0,
    latencyMs: trace.latencyMs,
    costUsd: trace.costUsd,
    tokens: trace.tokens,
    startedAt: trace.startedAt,
    finishedAt: trace.finishedAt,
  };
}

export function extractTrace(value: unknown): CognitionTrace | undefined {
  if (isTrace(value)) return value;
  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  if (isTrace(record.trace)) return record.trace;
  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (isTrace(payload.trace)) return payload.trace;
    if (isTrace(payload.cognitionTrace)) return payload.cognitionTrace;
  }
  return undefined;
}

export function isTrace(value: unknown): value is CognitionTrace {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.goal === "string" &&
    typeof record.startedAt === "number" &&
    Array.isArray(record.nodes) &&
    Array.isArray(record.acceptedPath)
  );
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: tsx scripts/agi-trace.ts <trace.json|trace.jsonl> [...]");
    process.exitCode = 2;
    return;
  }

  for (const sourcePath of paths) {
    const result = await readAgiTraces(sourcePath);
    for (const record of result.records) {
      console.log(JSON.stringify({ sourcePath: record.sourcePath, line: record.line, ...summarizeTrace(record.trace) }));
    }
    for (const error of result.errors) {
      console.error(JSON.stringify({ sourcePath: error.sourcePath, line: error.line, error: error.error }));
    }
    if (result.errors.length) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
