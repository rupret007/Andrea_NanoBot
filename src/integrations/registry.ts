/**
 * Integration registry.
 *
 * On boot, `register(integration)` is called for every plugin. The registry
 * resolves tool name collisions by namespacing (`notion.search_pages`),
 * validates schemas (a minimal JSON-schema subset — see `validateArgs`
 * below), and exposes a single `invoke(name, args)` entry point the
 * cognitive core uses.
 *
 * Registration is atomic: if any tool in a batch collides or is malformed,
 * NONE of that integration's tools are committed and the integration is
 * not added to the list. This prevents half-state on partial failure.
 */

import type {
  ToolDescriptor,
  ToolInvocation,
  ToolResult,
} from '../agi-core/types.js';
import {
  ValidationError,
  type Integration,
  type IntegrationContext,
  type RegisteredTool,
} from './types.js';

export class IntegrationRegistry {
  private integrations: Integration[] = [];
  private tools = new Map<string, RegisteredTool>();

  constructor(
    private readonly ctxFactory: (id: string) => IntegrationContext,
  ) {}

  async register(integration: Integration): Promise<void> {
    if (!integration.enabled) return;
    const ctx = this.ctxFactory(integration.id);
    await integration.init(ctx);
    const tools = await integration.register(ctx);

    // Stage every tool first; commit only if the whole batch is clean.
    const staged: { fq: string; tool: RegisteredTool }[] = [];
    const seenInBatch = new Set<string>();
    for (const t of tools) {
      if (!t.name || typeof t.name !== 'string') {
        throw new Error(
          `Integration ${integration.id} produced a tool with no name`,
        );
      }
      const fq = qualify(integration.id, t.name);
      if (seenInBatch.has(fq)) {
        throw new Error(`Duplicate tool name within ${integration.id}: ${fq}`);
      }
      if (this.tools.has(fq)) {
        throw new Error(`Tool collision on ${fq}`);
      }
      seenInBatch.add(fq);
      staged.push({
        fq,
        tool: { ...t, name: fq, integrationId: integration.id },
      });
    }

    // Atomic commit.
    for (const { fq, tool } of staged) this.tools.set(fq, tool);
    this.integrations.push(integration);
  }

  list(): ToolDescriptor[] {
    return Array.from(this.tools.values()).map(
      ({ handler: _h, integrationId: _i, ...rest }) => rest,
    );
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async invoke(call: ToolInvocation): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    const start = Date.now();
    if (!tool) {
      return {
        callId: call.callId,
        ok: false,
        error: `Unknown tool ${call.tool}`,
      };
    }
    const ctx = this.ctxFactory(tool.integrationId);
    try {
      const issues = validateArgs(tool.schema, call.args);
      if (issues.length) {
        throw new ValidationError(call.tool, issues);
      }
      const out = await tool.handler(call.args, ctx);
      ctx.audit({
        kind: 'tool_call.ok',
        payload: {
          tool: call.tool,
          callId: call.callId,
          latencyMs: Date.now() - start,
        },
      });
      return {
        callId: call.callId,
        ok: true,
        output: out,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.audit({
        kind: 'tool_call.fail',
        payload: { tool: call.tool, callId: call.callId, error: message },
      });
      return {
        callId: call.callId,
        ok: false,
        error: message,
        latencyMs: Date.now() - start,
      };
    }
  }

  async healthAll(): Promise<{ id: string; ok: boolean; detail?: string }[]> {
    return Promise.all(
      this.integrations.map(async (i) => {
        if (!i.health) return { id: i.id, ok: true };
        try {
          const ctx = this.ctxFactory(i.id);
          const r = await i.health(ctx);
          return { id: i.id, ...r };
        } catch (err) {
          return {
            id: i.id,
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }

  async close(): Promise<void> {
    const errors: { id: string; error: string }[] = [];
    for (const integration of [...this.integrations].reverse()) {
      if (!integration.close) continue;
      try {
        await integration.close();
      } catch (err) {
        errors.push({
          id: integration.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (errors.length) {
      throw new Error(
        `Integration shutdown failed: ${errors
          .map((e) => `${e.id}: ${e.error}`)
          .join('; ')}`,
      );
    }
  }
}

/**
 * Always namespace tool names by their owning integration id. If a tool
 * itself contains a `.` (e.g. it came from an MCP server that uses dotted
 * names like `slack.send_message`), replace dots with `_` before
 * prefixing — otherwise an MCP tool could masquerade as a built-in
 * (`notion.search_pages` vs the real Notion integration).
 */
export function qualify(integrationId: string, toolName: string): string {
  const ownPrefix = `${integrationId}.`;
  const localName = toolName.startsWith(ownPrefix)
    ? toolName.slice(ownPrefix.length)
    : toolName;
  const safe = localName.replace(/\./g, '_');
  return `${integrationId}.${safe}`;
}

/**
 * Minimal JSON-schema validator. Supports:
 *   - top-level `type: "object"` with `required: []` and `properties`
 *   - per-property `type` constraints: string, number, boolean, object, array
 *   - nested objects (recursive)
 *
 * Returns a list of issue strings; empty array means valid. We keep this
 * tiny on purpose — pulling in ajv would balloon the dep graph for what
 * is at most a handful of arguments per tool call.
 */
export function validateArgs(
  schema: Record<string, unknown> | undefined,
  args: unknown,
): string[] {
  if (!schema || typeof schema !== 'object') return [];
  return validateValue(schema, args, '$');
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): string[] {
  const issues: string[] = [];
  const t = schema.type as string | undefined;

  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      issues.push(`${path}: expected object, got ${typeName(value)}`);
      return issues;
    }
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const r of required) {
      if (!(r in obj)) issues.push(`${path}.${r}: required`);
    }
    const props =
      (schema.properties as
        | Record<string, Record<string, unknown>>
        | undefined) ?? {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj) {
        issues.push(...validateValue(propSchema, obj[k], `${path}.${k}`));
      }
    }
    return issues;
  }

  if (t === 'string') {
    if (typeof value !== 'string')
      issues.push(`${path}: expected string, got ${typeName(value)}`);
    return issues;
  }
  if (t === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      issues.push(`${path}: expected number, got ${typeName(value)}`);
    }
    return issues;
  }
  if (t === 'boolean') {
    if (typeof value !== 'boolean')
      issues.push(`${path}: expected boolean, got ${typeName(value)}`);
    return issues;
  }
  if (t === 'array') {
    if (!Array.isArray(value))
      issues.push(`${path}: expected array, got ${typeName(value)}`);
    return issues;
  }
  // Unknown / unspecified type — accept.
  return issues;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
