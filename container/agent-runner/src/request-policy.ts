export interface RuntimeRequestPolicy {
  route: string;
  reason: string;
  builtinTools: string[];
  mcpTools: string[];
  guidance: string;
}

const KNOWN_ROUTES = new Set([
  'direct_assistant',
  'protected_assistant',
  'control_plane',
  'advanced_helper',
  'code_plane',
]);

const COMPATIBILITY_BUILTIN_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;

const COMPATIBILITY_MCP_TOOLS = [
  'mcp__nanoclaw__search_openclaw_skills',
  'mcp__nanoclaw__enable_openclaw_skill',
  'mcp__nanoclaw__install_openclaw_skill',
  'mcp__nanoclaw__disable_openclaw_skill',
  'mcp__nanoclaw__list_enabled_openclaw_skills',
  'mcp__nanoclaw__list_cursor_agents',
  'mcp__nanoclaw__create_cursor_agent',
  'mcp__nanoclaw__followup_cursor_agent',
  'mcp__nanoclaw__stop_cursor_agent',
  'mcp__nanoclaw__sync_cursor_agent',
  'mcp__nanoclaw__list_cursor_agent_artifacts',
  'mcp__nanoclaw__search_amazon_products',
  'mcp__nanoclaw__request_amazon_purchase',
  'mcp__nanoclaw__list_amazon_purchase_requests',
  'mcp__nanoclaw__approve_amazon_purchase_request',
  'mcp__nanoclaw__cancel_amazon_purchase_request',
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__list_tasks',
  'mcp__nanoclaw__pause_task',
  'mcp__nanoclaw__resume_task',
  'mcp__nanoclaw__cancel_task',
  'mcp__nanoclaw__update_task',
  'mcp__nanoclaw__register_group',
] as const;

const KNOWN_BUILTIN_TOOLS = new Set<string>(COMPATIBILITY_BUILTIN_TOOLS);
const KNOWN_MCP_TOOLS = new Set<string>(COMPATIBILITY_MCP_TOOLS);
const HOST_ACTION_INCOMPATIBLE_BUILTINS = new Set([
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'TodoWrite',
  'ToolSearch',
  'Skill',
]);

const ROUTE_BUILTIN_MAXIMUMS: Record<string, ReadonlySet<string>> = {
  direct_assistant: new Set(),
  protected_assistant: new Set([
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
  ]),
  control_plane: new Set(['Read', 'Glob', 'Grep']),
  advanced_helper: KNOWN_BUILTIN_TOOLS,
  code_plane: KNOWN_BUILTIN_TOOLS,
};

const ROUTE_MCP_MAXIMUMS: Record<string, ReadonlySet<string>> = {
  direct_assistant: new Set(),
  protected_assistant: new Set([
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__pause_task',
    'mcp__nanoclaw__resume_task',
    'mcp__nanoclaw__cancel_task',
    'mcp__nanoclaw__update_task',
    'mcp__nanoclaw__search_amazon_products',
    'mcp__nanoclaw__request_amazon_purchase',
    'mcp__nanoclaw__list_amazon_purchase_requests',
  ]),
  control_plane: new Set([
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__pause_task',
    'mcp__nanoclaw__resume_task',
    'mcp__nanoclaw__cancel_task',
    'mcp__nanoclaw__update_task',
    'mcp__nanoclaw__list_cursor_agents',
    'mcp__nanoclaw__followup_cursor_agent',
    'mcp__nanoclaw__stop_cursor_agent',
    'mcp__nanoclaw__sync_cursor_agent',
    'mcp__nanoclaw__list_cursor_agent_artifacts',
    'mcp__nanoclaw__list_amazon_purchase_requests',
    'mcp__nanoclaw__approve_amazon_purchase_request',
    'mcp__nanoclaw__cancel_amazon_purchase_request',
    'mcp__nanoclaw__register_group',
  ]),
  advanced_helper: new Set([
    'mcp__nanoclaw__search_openclaw_skills',
    'mcp__nanoclaw__enable_openclaw_skill',
    'mcp__nanoclaw__install_openclaw_skill',
    'mcp__nanoclaw__disable_openclaw_skill',
    'mcp__nanoclaw__list_enabled_openclaw_skills',
    'mcp__nanoclaw__list_cursor_agents',
    'mcp__nanoclaw__create_cursor_agent',
  ]),
  code_plane: new Set(),
};

function dedupeTools(tools: readonly string[]): string[] {
  return [...new Set(tools)];
}

function hasOnlyKnownTools(
  tools: readonly string[],
  known: ReadonlySet<string>,
): boolean {
  return tools.every((tool) => known.has(tool));
}

function failClosedPolicy(reason: string): RuntimeRequestPolicy {
  return {
    route: 'direct_assistant',
    reason,
    builtinTools: [],
    mcpTools: [],
    guidance:
      'Answer directly from the visible prompt. No tools, external actions, or hidden context are available for this turn.',
  };
}

export function normalizeRequestPolicy(
  policy?: RuntimeRequestPolicy,
): RuntimeRequestPolicy {
  if (!policy) {
    return failClosedPolicy('missing request policy');
  }

  if (
    typeof policy.route !== 'string' ||
    typeof policy.reason !== 'string' ||
    !Array.isArray(policy.builtinTools) ||
    !policy.builtinTools.every((tool) => typeof tool === 'string') ||
    !Array.isArray(policy.mcpTools) ||
    !policy.mcpTools.every((tool) => typeof tool === 'string') ||
    typeof policy.guidance !== 'string'
  ) {
    return failClosedPolicy('malformed request policy');
  }

  if (!KNOWN_ROUTES.has(policy.route)) {
    return failClosedPolicy('unknown request policy route');
  }

  // Direct conversation is a deliberately tool-free trust boundary. Do not
  // honor a stale or tampered host policy that tries to widen it.
  if (policy.route === 'direct_assistant') {
    return {
      ...policy,
      builtinTools: [],
      mcpTools: [],
    };
  }

  const builtinTools = dedupeTools(policy.builtinTools);
  const mcpTools = dedupeTools(policy.mcpTools);
  // A shell-capable turn must never share the writable host-action IPC/MCP
  // surface. Host routing uses separate no-shell capability profiles.
  if (
    mcpTools.length > 0 &&
    builtinTools.some((tool) => HOST_ACTION_INCOMPATIBLE_BUILTINS.has(tool))
  ) {
    return failClosedPolicy('shell and host-action tools cannot be combined');
  }
  if (
    !hasOnlyKnownTools(builtinTools, KNOWN_BUILTIN_TOOLS) ||
    !hasOnlyKnownTools(mcpTools, KNOWN_MCP_TOOLS) ||
    !hasOnlyKnownTools(builtinTools, ROUTE_BUILTIN_MAXIMUMS[policy.route]!) ||
    !hasOnlyKnownTools(mcpTools, ROUTE_MCP_MAXIMUMS[policy.route]!)
  ) {
    return failClosedPolicy('request policy tools exceed route boundary');
  }
  return { ...policy, builtinTools, mcpTools };
}

export interface SdkToolPolicy {
  tools: string[];
  allowedTools: string[];
  useMcpServer: boolean;
}

export interface SdkMcpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface SdkMcpBoundaryConfig {
  strictMcpConfig: true;
  mcpServers: Record<string, SdkMcpServerSpec> | undefined;
}

/**
 * Keep the SDK from merging MCP servers discovered from ambient settings.
 * Only the explicitly constructed NanoClaw server may be visible for a turn.
 */
export function buildSdkMcpBoundaryConfig(
  useMcpServer: boolean,
  nanoclawServer: SdkMcpServerSpec,
): SdkMcpBoundaryConfig {
  return {
    strictMcpConfig: true,
    mcpServers: useMcpServer ? { nanoclaw: nanoclawServer } : undefined,
  };
}

export function buildSdkToolPolicy(
  policy: RuntimeRequestPolicy,
  options: { fallbackMode?: boolean; disableMcpServer?: boolean } = {},
): SdkToolPolicy {
  const normalized = normalizeRequestPolicy(policy);
  const useMcpServer =
    normalized.route !== 'direct_assistant' &&
    !options.fallbackMode &&
    options.disableMcpServer !== true &&
    normalized.mcpTools.length > 0;

  return {
    // `allowedTools` only controls automatic permission approval in the SDK.
    // `tools` is the option that actually removes unavailable built-ins.
    tools: [...normalized.builtinTools],
    allowedTools: dedupeTools([
      ...normalized.builtinTools,
      ...(useMcpServer ? normalized.mcpTools : []),
    ]),
    useMcpServer,
  };
}
