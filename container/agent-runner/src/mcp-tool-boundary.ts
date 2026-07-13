const NANOCLAW_MCP_TOOL_PREFIX = 'mcp__nanoclaw__';
const NANOCLAW_MCP_TOOL_NAME = /^mcp__nanoclaw__[a-z0-9_]+$/;

/**
 * Parse the host-provided MCP allowlist as an exact, qualified-name set.
 * Any missing or malformed value invalidates the entire list so a partially
 * valid attacker-controlled value can never widen the exposed tool surface.
 */
export function parseAllowedMcpTools(
  raw: string | undefined,
): ReadonlySet<string> {
  if (!raw) return new Set();

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (entry): entry is string =>
          typeof entry === 'string' && NANOCLAW_MCP_TOOL_NAME.test(entry),
      )
    ) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

export function isMcpToolAllowed(
  allowedTools: ReadonlySet<string>,
  toolName: string,
): boolean {
  return allowedTools.has(`${NANOCLAW_MCP_TOOL_PREFIX}${toolName}`);
}
