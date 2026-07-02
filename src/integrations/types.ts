/**
 * Integration plug-in shape.
 *
 * Every external service (Notion, Linear, Spotify, GitHub, Home Assistant,
 * Drive, etc.) implements `Integration`. The runtime discovers them via
 * `registry.ts` at startup. Integrations get one shot at `register()` to
 * declare the tools they expose; after that, the cognitive core invokes
 * tools through the registry, never directly.
 *
 * MCP servers are first-class: a `McpIntegration` sub-shape wraps a remote
 * MCP server and proxies its tool list. This gives Andrea the entire MCP
 * ecosystem for free.
 */

import type { ToolDescriptor } from '../agi-core/types.js';

export interface IntegrationContext {
  /** User-scoped id for credential lookup. */
  userId: string;
  /** Free-form scope string used by memory + audit log. */
  scope: string;
  /** Async-readable secret store. NEVER log returned values. */
  secrets: { get(key: string): Promise<string | undefined> };
  /** Local filesystem path the integration may use as scratch. */
  workdir: string;
  /** Audit hook — every external call should emit at least one event. */
  audit(event: { kind: string; payload?: unknown }): void;
}

export interface ToolHandler {
  /** Args have already been schema-validated by the runtime. */
  (args: Record<string, unknown>, ctx: IntegrationContext): Promise<unknown>;
}

export interface RegisteredTool extends ToolDescriptor {
  handler: ToolHandler;
  /** Owning integration id, e.g. "notion". */
  integrationId: string;
}

export interface Integration {
  /** Stable id, e.g. "notion", "linear", "github". */
  id: string;
  /** Pretty name for the UI. */
  displayName: string;
  /** Set false to keep an integration installed but disabled. */
  enabled: boolean;
  /** Probe credentials & connectivity. Throws on failure. */
  init(ctx: IntegrationContext): Promise<void>;
  /** Register tools — return a list of `RegisteredTool`s. */
  register(ctx: IntegrationContext): Promise<RegisteredTool[]>;
  /** Optional health check polled by `integrations:doctor`. */
  health?(ctx: IntegrationContext): Promise<{ ok: boolean; detail?: string }>;
  /** Optional lifecycle hook used during graceful runtime shutdown. */
  close?(): Promise<void> | void;
}

export interface McpIntegration extends Integration {
  /** Remote MCP server endpoint or local stdio command. */
  endpoint: string;
  /** Allow-list of tools to expose; empty = all. */
  allowTools?: string[];
}

/**
 * Thrown by the registry when arguments fail JSON-schema validation
 * before a tool's handler is invoked. Catchable by callers that want
 * to distinguish bad input from runtime failures.
 */
export class ValidationError extends Error {
  readonly tool: string;
  readonly issues: string[];
  constructor(tool: string, issues: string[]) {
    super(`Invalid arguments for ${tool}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.tool = tool;
    this.issues = issues;
  }
}

/** Effect classification produced by `classifyEffect` etc. */
export type ToolEffect = 'read' | 'write' | 'external' | 'destructive';
