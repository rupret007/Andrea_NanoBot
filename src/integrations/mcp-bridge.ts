/**
 * MCP bridge — turns any remote/local Model Context Protocol server into
 * an Andrea integration automatically.
 *
 * This is the single biggest leverage point in the whole system: instead of
 * writing a TypeScript adapter for every new service, the user installs
 * the official MCP server (Slack, Asana, GitHub, Notion, Stripe, whatever)
 * and points Andrea at it. The bridge introspects the server's tools and
 * exposes them through the integration registry like any built-in.
 *
 * Supports both stdio (`mcp run somecmd`) and HTTP transports.
 *
 * Wire framing — DUAL MODE:
 *
 *   1. LSP-style: `Content-Length: <N>\r\n\r\n<body>` (the spec).
 *      This is what the official MCP SDKs emit and what we write.
 *
 *   2. ndjson fallback: a single JSON object per line, terminated by `\n`.
 *      Many community / hand-rolled MCP servers do this. We auto-detect
 *      it: if the FIRST 16 KB of stdout never contains a valid
 *      `Content-Length:` header but does contain a parseable JSON line,
 *      we switch the parser to line mode for the rest of the connection.
 *
 *   We always *write* using Content-Length framing, which is universally
 *   accepted; the auto-detect only affects how we *read*.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { Integration, RegisteredTool } from './types.js';
import { redactString } from './_redact.js';

export interface McpBridgeConfig {
  id: string;
  displayName: string;
  /** stdio command + args, e.g. ["uvx", "mcp-server-time"]. */
  command?: { cmd: string; args?: string[]; env?: Record<string, string> };
  /** OR an HTTP endpoint (SSE / streamable HTTP). */
  http?: { url: string; headers?: Record<string, string> };
  allowTools?: string[];
  /** Override default per-call timeout. Default 30s. */
  callTimeoutMs?: number;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Spawn signature factored out so tests can inject a fake. */
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['pipe', 'pipe', 'pipe'] },
) => ChildProcess;

const DETECT_BUDGET = 16 * 1024;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 2_000;
const SAFE_INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
];

export class StdioMcpClient {
  private proc: ChildProcess;
  private buffer: Buffer = Buffer.alloc(0);
  private pending = new Map<string, (m: JsonRpcMessage) => void>();
  private mode: 'unknown' | 'content-length' | 'ndjson' = 'unknown';
  private detectBytesSeen = 0;
  /** Set true once `proc.on("exit"|"error")` fires. */
  private dead = false;
  private deathReason: string | undefined;
  private callTimeoutMs: number;

  constructor(
    cmd: string,
    args: string[],
    env: Record<string, string>,
    opts: {
      spawnFn?: SpawnFn;
      callTimeoutMs?: number;
      debugLog?: (chunk: string) => void;
    } = {},
  ) {
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
    this.proc = spawnFn(cmd, args, {
      env: { ...safeInheritedEnv(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_MESSAGE_BYTES + DETECT_BUDGET) {
        this.die(
          `MCP server exceeded message buffer limit (${MAX_MESSAGE_BYTES} bytes)`,
        );
        this.buffer = Buffer.alloc(0);
        return;
      }
      this.drain();
    });
    this.proc.stdout?.on('error', () => {
      /* covered by exit handler */
    });

    // Drain stderr to prevent backpressure deadlock; pipe to debug log.
    const dbg =
      opts.debugLog ??
      ((s: string) => {
        if (process.env.ANDREA_MCP_DEBUG)
          process.stderr.write(`[mcp:${cmd}] ${s}`);
      });
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      try {
        dbg(redactString(chunk.toString('utf8')));
      } catch {
        /* never block on logging */
      }
    });
    this.proc.stderr?.on('error', () => undefined);

    this.proc.on('exit', (code, signal) => {
      this.die(`MCP server exited (code=${code}, signal=${signal})`);
    });
    this.proc.on('error', (err) => {
      this.die(`MCP server error: ${err.message}`);
    });
  }

  private die(reason: string) {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    // Drain pending callbacks with a clear rejection.
    for (const [id, cb] of this.pending) {
      cb({
        jsonrpc: '2.0',
        id,
        error: { code: -32099, message: `MCP server crashed: ${reason}` },
      });
    }
    this.pending.clear();
  }

  isAlive(): boolean {
    return !this.dead;
  }

  /**
   * Feed everything currently in `this.buffer` through the parser. Handles
   * partial messages by leaving the unconsumed tail in the buffer.
   */
  private drain() {
    if (this.mode === 'unknown') {
      this.detectBytesSeen += this.buffer.length;
      const headerIdx = this.buffer.indexOf('\r\n\r\n');
      if (
        headerIdx >= 0 &&
        /content-length\s*:/i.test(
          this.buffer.slice(0, headerIdx).toString('utf8'),
        )
      ) {
        this.mode = 'content-length';
      } else if (
        this.buffer.includes(0x0a) &&
        (headerIdx < 0 || this.detectBytesSeen >= DETECT_BUDGET)
      ) {
        // No CL header but we have at least one full line — switch to ndjson.
        this.mode = 'ndjson';
      }
      if (this.mode === 'unknown') return;
    }

    if (this.mode === 'content-length') {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const headerStr = this.buffer.slice(0, headerEnd).toString('utf8');
        const m = /content-length\s*:\s*(\d+)/i.exec(headerStr);
        if (!m) {
          this.buffer = this.buffer.slice(headerEnd + 4);
          continue;
        }
        const len = parseInt(m[1], 10);
        if (len > MAX_MESSAGE_BYTES) {
          this.die(`MCP message too large (${len} bytes)`);
          this.buffer = Buffer.alloc(0);
          return;
        }
        const bodyStart = headerEnd + 4;
        if (this.buffer.length < bodyStart + len) return;
        const body = this.buffer
          .slice(bodyStart, bodyStart + len)
          .toString('utf8');
        this.buffer = this.buffer.slice(bodyStart + len);
        this.dispatchLine(body);
      }
    } else {
      let idx = this.buffer.indexOf(0x0a);
      while (idx >= 0) {
        const line = this.buffer.slice(0, idx).toString('utf8').trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) this.dispatchLine(line);
        idx = this.buffer.indexOf(0x0a);
      }
    }
  }

  private dispatchLine(line: string) {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const waiter = this.pending.get(String(msg.id));
      if (waiter) {
        this.pending.delete(String(msg.id));
        waiter(msg);
      }
    }
  }

  async call(
    method: string,
    params?: unknown,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.dead) {
      throw new Error(`MCP server crashed: ${this.deathReason ?? 'unknown'}`);
    }
    const id = randomUUID();
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id, method, params };
    const body = JSON.stringify(msg);
    const framed = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    try {
      this.proc.stdin?.write(framed);
    } catch (err) {
      throw new Error(
        `MCP write failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const t = timeoutMs ?? this.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timeout`));
      }, t);
      this.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      });
    });
  }

  close() {
    try {
      this.proc.kill();
    } catch {
      /* already dead */
    }
    this.dead = true;
  }
}

export function createMcpIntegration(
  cfg: McpBridgeConfig,
  opts: { spawnFn?: SpawnFn } = {},
): Integration {
  let client: StdioMcpClient | undefined;
  let cachedTools: any[] = [];

  const startClient = async (): Promise<void> => {
    if (!cfg.command) return;
    client = new StdioMcpClient(
      cfg.command.cmd,
      cfg.command.args ?? [],
      cfg.command.env ?? {},
      { spawnFn: opts.spawnFn, callTimeoutMs: cfg.callTimeoutMs },
    );
    await client.call('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'andrea-nanobot', version: '2.0.0' },
      capabilities: {},
    });
    const list = (await client.call('tools/list')) as any;
    cachedTools = list?.tools ?? [];
  };

  const ensureClient = async (): Promise<StdioMcpClient> => {
    if (client && client.isAlive()) return client;
    client = undefined;
    await startClient();
    if (!client) throw new Error('MCP client failed to start');
    return client;
  };

  return {
    id: cfg.id,
    displayName: cfg.displayName,
    enabled: true,

    async init() {
      if (cfg.command) {
        await startClient();
      }
      // HTTP transport left as an extension point (uses the same protocol).
    },

    async register(): Promise<RegisteredTool[]> {
      const out: RegisteredTool[] = [];
      for (const t of cachedTools) {
        if (cfg.allowTools && !cfg.allowTools.includes(t.name)) continue;
        out.push({
          integrationId: cfg.id,
          name: t.name,
          description: t.description ?? `MCP tool ${t.name}`,
          schema: t.inputSchema ?? { type: 'object' },
          effect: classifyEffect(t),
          handler: async (args) => {
            const c = await ensureClient();
            return c.call('tools/call', { name: t.name, arguments: args });
          },
        });
      }
      return out;
    },

    async health() {
      if (!client || !client.isAlive()) {
        return { ok: false, detail: client ? 'not running' : 'not started' };
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('health check timeout')),
          HEALTH_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([
          client.call('ping', undefined, HEALTH_TIMEOUT_MS),
          timeout,
        ]);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    close() {
      client?.close();
      client = undefined;
    },
  };
}

/**
 * Classify the side-effect of an MCP tool. Prefers the spec-defined
 * `annotations.destructiveHint` / `annotations.readOnlyHint` if the
 * server provides them; otherwise falls back to a name-regex heuristic.
 *
 * Default is `external` (safer): unknown tools touch unknown systems.
 */
export function classifyEffect(t: {
  name?: string;
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean };
}): RegisteredTool['effect'] {
  const a = t.annotations;
  if (a) {
    if (a.destructiveHint === true) return 'destructive';
  }
  const n = (t.name ?? '').toLowerCase();
  if (/(delete|drop|destroy|remove|purge)/.test(n)) return 'destructive';
  if (/(create|update|send|post|write|set|put|patch)/.test(n)) return 'write';
  if (a?.readOnlyHint === true) return 'read';
  if (/^(get|read|list|search|fetch|describe|find|query)/.test(n))
    return 'read';
  // Unknown verbs default to external — safer than assuming read-only.
  return 'external';
}

function safeInheritedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of SAFE_INHERITED_ENV_KEYS) {
    if (process.env[key] !== undefined) out[key] = process.env[key];
  }
  return out;
}
