import { describe, expect, it } from "vitest";
import {
  AnthropicAdapter,
  toAnthropicMessages,
} from "../src/models/anthropic-adapter.js";
import {
  OpenAIAdapter,
  toOpenAIMessages,
} from "../src/models/openai-adapter.js";
import {
  OllamaAdapter,
  modelSpecFromOllamaTag,
} from "../src/models/local-ollama-adapter.js";
import { HashEmbedder } from "../src/models/embedding-client.js";
import { fetchWithTimeoutAndRetry } from "../src/models/http-utils.js";
import { DEFAULT_CATALOG, type ModelSpec } from "../src/models/router.js";

const cat = (id: string): ModelSpec => DEFAULT_CATALOG.find((m) => m.id === id)!;

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function makeStubFetch(
  response:
    | { status: number; body: any; headers?: Record<string, string> }
    | ((req: CapturedRequest, attempt: number) => {
        status: number;
        body: any;
        headers?: Record<string, string>;
      }),
): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const f = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const resolved =
      typeof response === "function" ? response({ url, init }, calls.length) : response;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { "content-type": "application/json", ...(resolved.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

describe("adapter request body shapes", () => {
  it("OpenAI: tool messages reshape into assistant tool_calls + tool", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch({
      status: 200,
      body: {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    });
    const adapter = new OpenAIAdapter(
      "test",
      [cat("gpt-5")],
      "https://api.openai.com/v1",
      { fetchImpl: stubFetch },
    );
    await adapter.complete(cat("gpt-5"), {
      messages: [
        { role: "user", content: "what's the weather?" },
        {
          role: "assistant",
          content: "",
          metadata: {
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"sf"}' },
              },
            ],
          },
        },
        { role: "tool", content: "72F", toolCallId: "call_1", name: "get_weather" },
      ],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("gpt-5");
    // gpt-5 family uses max_completion_tokens, not max_tokens.
    expect(body).toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_tokens");
    // The reshaped messages: user, assistant w/ tool_calls, tool.
    const m = body.messages;
    expect(m.map((x: any) => x.role)).toEqual(["user", "assistant", "tool"]);
    expect(m[1].tool_calls[0].id).toBe("call_1");
    expect(m[2].tool_call_id).toBe("call_1");
    expect(m[2].content).toBe("72F");
  });

  it("OpenAI: max_tokens used for non-gpt-5 ids", async () => {
    const legacy: ModelSpec = { ...cat("gpt-5"), id: "gpt-4o" };
    const { fetch: stubFetch, calls } = makeStubFetch({
      status: 200,
      body: { choices: [{ message: { content: "ok" } }], usage: {} },
    });
    const adapter = new OpenAIAdapter("test", [legacy], "https://api.openai.com/v1", {
      fetchImpl: stubFetch,
    });
    await adapter.complete(legacy, { messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("OpenAI: tool message without preceding tool_calls metadata throws clear error", () => {
    expect(() =>
      toOpenAIMessages(undefined, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "calling tool" },
        { role: "tool", content: "result", toolCallId: "call_x" },
      ]),
    ).toThrow(/preceding assistant tool_calls block/);
  });

  it("Anthropic: tool messages serialize as tool_result content blocks", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch({
      status: 200,
      body: {
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const adapter = new AnthropicAdapter(
      "test",
      [cat("claude-sonnet-4-6")],
      "https://api.anthropic.com/v1",
      { fetchImpl: stubFetch },
    );
    await adapter.complete(cat("claude-sonnet-4-6"), {
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", content: "72F", toolCallId: "tu_abc" },
      ],
    });
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    // No `system` field when undefined.
    expect(body).not.toHaveProperty("system");
    expect(body.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tu_abc",
      content: "72F",
    });
  });

  it("Anthropic: empty tool_call_id throws", () => {
    expect(() =>
      toAnthropicMessages([{ role: "tool", content: "x", toolCallId: "" }]),
    ).toThrow(/non-empty toolCallId/);
  });

  it("Anthropic: empty system string is preserved, undefined is omitted", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch({
      status: 200,
      body: {
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    const adapter = new AnthropicAdapter(
      "test",
      [cat("claude-sonnet-4-6")],
      "https://api.anthropic.com/v1",
      { fetchImpl: stubFetch },
    );
    await adapter.complete(cat("claude-sonnet-4-6"), {
      system: "",
      messages: [{ role: "user", content: "hi" }],
    });
    const b1 = JSON.parse(String(calls[0].init.body));
    expect(b1.system).toBe("");

    await adapter.complete(cat("claude-sonnet-4-6"), {
      messages: [{ role: "user", content: "hi" }],
    });
    const b2 = JSON.parse(String(calls[1].init.body));
    expect(b2).not.toHaveProperty("system");
  });

  it("Ollama: catalog id is sent verbatim to /api/chat", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch({
      status: 200,
      body: { message: { content: "ok" } },
    });
    const local: ModelSpec = {
      id: "llama3.3:70b",
      provider: "local",
      family: "llama",
      contextTokens: 128_000,
      costInUsdPerMTok: 0,
      costOutUsdPerMTok: 0,
      p50LatencyMs: 5000,
      capabilities: ["tool_use"],
      available: true,
    };
    const adapter = new OllamaAdapter([local], "http://localhost:11434", {
      fetchImpl: stubFetch,
    });
    await adapter.complete(local, { messages: [{ role: "user", content: "hi" }] });
    expect(calls[0].url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("llama3.3:70b");
  });

  it("Ollama: converts discovered local tags into routable model specs", () => {
    const spec = modelSpecFromOllamaTag({
      name: "qwen2.5:0.5b",
      model: "qwen2.5:0.5b",
      details: { family: "qwen2", context_length: 32768 },
      capabilities: ["completion", "tools"],
    });
    expect(spec).toMatchObject({
      id: "qwen2.5:0.5b",
      provider: "local",
      family: "qwen2",
      contextTokens: 32768,
      available: true,
    });
    expect(spec?.capabilities).toContain("tool_use");
  });
});

describe("HTTP retry & timeout", () => {
  it("retries once on 429 and succeeds on second call", async () => {
    const { fetch: stubFetch, calls } = makeStubFetch((_, attempt) => {
      if (attempt === 1)
        return { status: 429, body: { error: "rate" }, headers: { "retry-after": "0.1" } };
      return { status: 200, body: { ok: true } };
    });
    const r = await fetchWithTimeoutAndRetry(
      "https://example.test/x",
      { method: "GET" },
      { fetchImpl: stubFetch, budgetMs: 5000 },
    );
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    const body = await r.json();
    expect(body).toEqual({ ok: true });
  });

  it("aborts on timeout when fetch never resolves", async () => {
    const stubFetch = (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init.signal as AbortSignal | undefined;
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;

    const start = Date.now();
    let caught: unknown;
    try {
      await fetchWithTimeoutAndRetry(
        "https://example.test/x",
        { method: "GET" },
        { fetchImpl: stubFetch, budgetMs: 80 },
      );
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/timed out/i);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("HashEmbedder determinism", () => {
  it("produces the same vector for the same input", async () => {
    const e = new HashEmbedder(64);
    const [a, b] = await Promise.all([e.embed(["hello world"]), e.embed(["hello world"])]);
    expect(a[0].length).toBe(64);
    for (let i = 0; i < a[0].length; i++) {
      expect(a[0][i]).toBe(b[0][i]);
    }
  });

  it("non-negative indices: never throws RangeError on assorted inputs", async () => {
    const e = new HashEmbedder(128);
    const inputs = [
      "the quick brown fox",
      "lorem ipsum dolor sit amet",
      "ÿþýü",
      "a",
      "",
      "123 456 789",
      "abcdefghijklmnopqrstuvwxyz".repeat(10),
    ];
    const out = await e.embed(inputs);
    expect(out.length).toBe(inputs.length);
    for (const v of out) expect(v.length).toBe(128);
  });

  it("different inputs produce different vectors (sanity sample)", async () => {
    const e = new HashEmbedder(256);
    const out = await e.embed([
      "alpha beta gamma",
      "completely different text",
      "yet another distinct string here",
    ]);
    let differences = 0;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        // Cosine distance > some small epsilon.
        let dot = 0;
        for (let k = 0; k < out[i].length; k++) dot += out[i][k] * out[j][k];
        if (Math.abs(1 - dot) > 1e-6) differences += 1;
      }
    }
    expect(differences).toBe(3);
  });
});
