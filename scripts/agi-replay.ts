import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { AgiRuntime, type AgiRuntimeOptions } from "../src/agi-runtime.js";
import type { CognitionTrace, Message } from "../src/agi-core/types.js";
import { HashEmbedder } from "../src/models/embedding-client.js";
import type { CompletionRequest, CompletionResult, ProviderAdapter } from "../src/models/router.js";

export interface ReplayPaths {
  vector: string;
  graph: string;
  episodic: string;
  audit: string;
}

export interface ReplayQuestion {
  scope?: string;
  text: string;
  source?: string;
  untrusted?: boolean;
  history?: { role: "user" | "assistant"; content: string }[];
}

export interface ReplayOptions {
  questions: ReplayQuestion[];
  paths?: ReplayPaths;
  persona?: string;
}

export interface ReplayResult {
  question: ReplayQuestion;
  reply: string;
  trace: CognitionTrace;
  normalizedTrace: NormalizedTrace;
}

export type NormalizedTrace = Omit<CognitionTrace, "startedAt" | "finishedAt" | "latencyMs" | "nodes"> & {
  startedAt: 0;
  finishedAt?: 0;
  latencyMs?: 0;
  nodes: Array<Omit<CognitionTrace["nodes"][number], "id" | "parentId" | "createdAt"> & {
    id: string;
    parentId?: string;
    createdAt: 0;
  }>;
};

export function deterministicStubProvider(): ProviderAdapter {
  return {
    provider: "local",
    models: () => [
      {
        id: "stub-primary",
        provider: "local",
        family: "stub",
        contextTokens: 128_000,
        costInUsdPerMTok: 0,
        costOutUsdPerMTok: 0,
        p50LatencyMs: 1,
        capabilities: ["tool_use", "json_mode", "low_latency", "voting"],
        available: true,
      },
      {
        id: "stub-small",
        provider: "local",
        family: "stub",
        contextTokens: 128_000,
        costInUsdPerMTok: 0,
        costOutUsdPerMTok: 0,
        p50LatencyMs: 1,
        capabilities: ["tool_use", "json_mode", "low_latency", "voting"],
        available: true,
      },
    ],
    complete: async (model, req) => completeDeterministically(model.id, req),
  };
}

export async function replayQuestions(opts: ReplayOptions): Promise<ReplayResult[]> {
  const paths = opts.paths ?? (await tempReplayPaths());
  AgiRuntime.__resetSingletonForTests();
  const runtime = await AgiRuntime.create({
    embed: new HashEmbedder(64),
    providers: [deterministicStubProvider()],
    integrations: [],
    primaryModelId: "stub-primary",
    smallModelId: "stub-small",
    panelModelIds: [],
    paths,
    persona: opts.persona,
    secretsFor: async () => ({ get: async () => undefined }),
    force: true,
  } satisfies AgiRuntimeOptions);

  try {
    const results: ReplayResult[] = [];
    for (const question of opts.questions) {
      const out = await runtime.ask({
        scope: question.scope ?? "replay",
        text: question.text,
        source: question.source,
        untrusted: question.untrusted,
        history: question.history,
      });
      results.push({
        question,
        reply: out.reply,
        trace: out.trace,
        normalizedTrace: normalizeTrace(out.trace),
      });
    }
    return results;
  } finally {
    await runtime.shutdown();
    AgiRuntime.__resetSingletonForTests();
  }
}

export function normalizeTrace(trace: CognitionTrace): NormalizedTrace {
  const idMap = new Map<string, string>();
  const nodes = trace.nodes.map((node, index) => {
    const id = `node-${index + 1}`;
    idMap.set(node.id, id);
    return node;
  });

  return {
    ...trace,
    startedAt: 0,
    finishedAt: trace.finishedAt === undefined ? undefined : 0,
    latencyMs: trace.latencyMs === undefined ? undefined : 0,
    acceptedPath: trace.acceptedPath.map((id) => idMap.get(id) ?? id),
    nodes: nodes.map((node, index) => ({
      ...node,
      id: idMap.get(node.id) ?? `node-${index + 1}`,
      parentId: node.parentId ? (idMap.get(node.parentId) ?? node.parentId) : undefined,
      createdAt: 0,
    })),
  };
}

async function tempReplayPaths(): Promise<ReplayPaths> {
  const dir = await mkdtemp(join(tmpdir(), "agi-replay-"));
  return {
    vector: join(dir, "vectors.jsonl"),
    graph: join(dir, "graph.json"),
    episodic: join(dir, "episodes.jsonl"),
    audit: join(dir, "audit.jsonl"),
  };
}

function completeDeterministically(modelId: string, req: CompletionRequest): CompletionResult {
  const system = req.system ?? "";
  const prompt = lastUserMessage(req.messages);
  let text: string;

  if (system.startsWith("Classify the user's request into exactly one of:")) {
    text = "direct";
  } else if (system.includes("strict critic")) {
    text = JSON.stringify({ score: 0.9, critique: "deterministic-pass" });
  } else {
    text = `stub:${digest([modelId, system, serializeMessages(req.messages)].join("\n"))}`;
    if (prompt) text += `:${digest(prompt).slice(0, 8)}`;
  }

  return {
    text,
    model: modelId,
    inputTokens: estimateTokens(system, req.messages),
    outputTokens: Math.max(1, Math.ceil(text.length / 4)),
    costUsd: 0,
    latencyMs: 0,
  };
}

function lastUserMessage(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

function serializeMessages(messages: Message[]): string {
  return messages.map((message) => `${message.role}:${message.name ?? ""}:${message.content}`).join("\n");
}

function estimateTokens(system: string, messages: Message[]): number {
  const chars = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

async function main(): Promise<void> {
  const questions = process.argv.slice(2).map((text) => ({ text }));
  if (questions.length === 0) {
    console.error("Usage: tsx scripts/agi-replay.ts <question> [...]");
    process.exitCode = 2;
    return;
  }
  const results = await replayQuestions({ questions });
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
