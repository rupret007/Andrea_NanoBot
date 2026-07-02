import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { StdioMcpClient, classifyEffect, type SpawnFn } from "../src/integrations/mcp-bridge.js";

class FakeChild extends EventEmitter {
  stdin: Writable & { _written: Buffer };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;
  pid = 1234;

  constructor() {
    super();
    const writtenRef = { buf: Buffer.alloc(0) };
    const stdinImpl = new Writable({
      write: (chunk, _enc, cb) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        writtenRef.buf = Buffer.concat([writtenRef.buf, b]);
        cb();
      },
    }) as Writable & { _written: Buffer };
    Object.defineProperty(stdinImpl, "_written", { get() { return writtenRef.buf; } });
    this.stdin = stdinImpl;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  pushStdout(b: Buffer | string) {
    this.stdout.emit("data", typeof b === "string" ? Buffer.from(b, "utf8") : b);
  }
  pushStderr(b: Buffer | string) {
    this.stderr.emit("data", typeof b === "string" ? Buffer.from(b, "utf8") : b);
  }
  crash(code = 1, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }
  kill() { this.killed = true; }
}

function frame(body: string): string {
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function makeSpawn(child: FakeChild): SpawnFn {
  return ((_cmd, _args, _opts) => child as unknown as ReturnType<SpawnFn>) as SpawnFn;
}

function reqIdsWritten(child: FakeChild): string[] {
  const written = child.stdin._written.toString("utf8");
  const parts = written.split("Content-Length:").filter(Boolean);
  const ids: string[] = [];
  for (const part of parts) {
    const j = part.indexOf("\r\n\r\n");
    if (j < 0) continue;
    const body = part.slice(j + 4);
    try { ids.push(JSON.parse(body).id); } catch { /* ignore */ }
  }
  return ids;
}

describe("StdioMcpClient framing", () => {
  it("writes Content-Length framed messages on stdin", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p = c.call("ping");
    queueMicrotask(() => {
      const written = child.stdin._written.toString("utf8");
      expect(written.startsWith("Content-Length:")).toBe(true);
      const ids = reqIdsWritten(child);
      child.pushStdout(frame(JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: "ok" })));
    });
    const r = await p;
    expect(r).toBe("ok");
    c.close();
  });

  it("does not inherit global secrets into MCP child env", () => {
    const child = new FakeChild();
    let seenEnv: NodeJS.ProcessEnv | undefined;
    vi.stubEnv("OPENAI_API_KEY", "sk-proj-secretsecretsecretsecretsecret");
    try {
      const c = new StdioMcpClient("x", [], { EXPLICIT_TOKEN: "ok" }, {
        spawnFn: ((_cmd, _args, opts) => {
          seenEnv = opts.env;
          return child as unknown as ReturnType<SpawnFn>;
        }) as SpawnFn,
      });
      expect(seenEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(seenEnv?.EXPLICIT_TOKEN).toBe("ok");
      c.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("Content-Length parser handles split chunks", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p = c.call("ping");
    setTimeout(() => {
      const ids = reqIdsWritten(child);
      const body = JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: 42 });
      const full = frame(body);
      child.pushStdout(full.slice(0, 8));
      child.pushStdout(full.slice(8, 30));
      child.pushStdout(full.slice(30));
    }, 0);
    const r = await p;
    expect(r).toBe(42);
    c.close();
  });

  it("handles back-to-back Content-Length messages in a single chunk", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p1 = c.call("a");
    const p2 = c.call("b");
    setTimeout(() => {
      const ids = reqIdsWritten(child);
      const r1 = JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: "A" });
      const r2 = JSON.stringify({ jsonrpc: "2.0", id: ids[1], result: "B" });
      child.pushStdout(frame(r1) + frame(r2));
    }, 0);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe("A");
    expect(b).toBe("B");
    c.close();
  });

  it("falls back to ndjson when no Content-Length header is seen", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p = c.call("ping");
    setTimeout(() => {
      const ids = reqIdsWritten(child);
      child.pushStdout(JSON.stringify({ jsonrpc: "2.0", id: ids[0], result: "newline" }) + "\n");
    }, 0);
    const r = await p;
    expect(r).toBe("newline");
    c.close();
  });

  it("rejects in-flight calls when the child crashes", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p = c.call("ping");
    setTimeout(() => child.crash(137), 0);
    await expect(p).rejects.toThrow(/MCP server crashed/);
    expect(c.isAlive()).toBe(false);
    await expect(c.call("anything")).rejects.toThrow(/crashed/);
  });

  it("rejects oversized Content-Length messages", async () => {
    const child = new FakeChild();
    const c = new StdioMcpClient("x", [], {}, { spawnFn: makeSpawn(child) });
    const p = c.call("ping");
    child.pushStdout("Content-Length: 10485761\r\n\r\n");
    await expect(p).rejects.toThrow(/too large|buffer limit/);
    c.close();
  });

  it("times out when no response ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const c = new StdioMcpClient("x", [], {}, {
        spawnFn: makeSpawn(child),
        callTimeoutMs: 100,
      });
      const p = c.call("ping").then(
        () => "resolved",
        (e) => `rejected:${(e as Error).message}`,
      );
      await vi.advanceTimersByTimeAsync(200);
      const r = await p;
      expect(r).toMatch(/timeout/);
      c.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains stderr without backpressure", () => {
    const child = new FakeChild();
    const logged: string[] = [];
    const c = new StdioMcpClient("x", [], {}, {
      spawnFn: makeSpawn(child),
      debugLog: (s) => logged.push(s),
    });
    child.pushStderr("warn: hello\n");
    child.pushStderr("warn: Authorization: Bearer supersecretvalue\n");
    expect(logged.join("")).toContain("hello");
    expect(logged.join("")).toContain("Authorization: <redacted>");
    expect(logged.join("")).not.toContain("supersecretvalue");
    c.close();
  });
});

describe("classifyEffect", () => {
  it("respects MCP destructiveHint annotation", () => {
    expect(classifyEffect({ name: "anything", annotations: { destructiveHint: true } })).toBe("destructive");
  });
  it("does not let MCP readOnlyHint downgrade mutating verbs", () => {
    expect(classifyEffect({ name: "send_message", annotations: { readOnlyHint: true } })).toBe("write");
  });
  it("uses MCP readOnlyHint for non-mutating names", () => {
    expect(classifyEffect({ name: "current_status", annotations: { readOnlyHint: true } })).toBe("read");
  });
  it("falls back to regex for delete-like names", () => {
    expect(classifyEffect({ name: "delete_thing" })).toBe("destructive");
  });
  it("falls back to read for get/list/search", () => {
    expect(classifyEffect({ name: "list_files" })).toBe("read");
    expect(classifyEffect({ name: "search_users" })).toBe("read");
  });
  it("defaults to external (not read) for unknown verbs", () => {
    expect(classifyEffect({ name: "frobnicate" })).toBe("external");
  });
});
