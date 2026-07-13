import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { isMcpToolAllowed, parseAllowedMcpTools } from './mcp-tool-boundary.js';

function childEnvironment(rawAllowlist: string | undefined) {
  const env: Record<string, string> = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    NANOCLAW_CHAT_JID: 'test-chat',
    NANOCLAW_GROUP_FOLDER: 'test-group',
    NANOCLAW_IS_MAIN: '0',
    NANOCLAW_REQUEST_ROUTE: 'protected_assistant',
    NANOCLAW_REQUEST_REASON: 'boundary test',
  };
  if (rawAllowlist !== undefined) {
    env.NANOCLAW_ALLOWED_MCP_TOOLS = rawAllowlist;
  }
  return env;
}

async function listExposedToolDescriptors(rawAllowlist: string | undefined) {
  const serverPath = fileURLToPath(
    new URL('./ipc-mcp-stdio.js', import.meta.url),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: childEnvironment(rawAllowlist),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'boundary-test', version: '1.0.0' });

  try {
    await client.connect(transport);
    if (!client.getServerCapabilities()?.tools) return [];
    const response = await client.listTools();
    return response.tools;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function listExposedTools(
  rawAllowlist: string | undefined,
): Promise<string[]> {
  const tools = await listExposedToolDescriptors(rawAllowlist);
  return tools.map((tool) => tool.name).sort();
}

describe('container MCP tool boundary', () => {
  it('treats missing and malformed allowlists as deny-all', () => {
    const malformed = [
      undefined,
      '',
      'not-json',
      '{}',
      '["mcp__nanoclaw__list_tasks", 7]',
      '["list_tasks"]',
      '["mcp__nanoclaw__*"]',
    ];

    for (const raw of malformed) {
      const allowed = parseAllowedMcpTools(raw);
      assert.equal(allowed.size, 0, `expected deny-all for ${String(raw)}`);
      assert.equal(isMcpToolAllowed(allowed, 'list_tasks'), false);
    }
  });

  it(
    'ListTools exposes exactly the qualified names in the allowlist',
    { timeout: 15_000 },
    async () => {
      const tools = await listExposedTools(
        JSON.stringify([
          'mcp__nanoclaw__list_tasks',
          'mcp__nanoclaw__schedule_task',
        ]),
      );
      assert.deepEqual(tools, ['list_tasks', 'schedule_task']);
      assert.equal(tools.includes('send_message'), false);
      assert.equal(tools.includes('register_group'), false);
    },
  );

  it(
    'ListTools exposes nothing when the allowlist is missing or malformed',
    { timeout: 15_000 },
    async () => {
      assert.deepEqual(await listExposedTools(undefined), []);
      assert.deepEqual(await listExposedTools('{broken'), []);
    },
  );

  it(
    'does not expose script injection through scheduled-task MCP schemas',
    { timeout: 15_000 },
    async () => {
      const tools = await listExposedToolDescriptors(
        JSON.stringify([
          'mcp__nanoclaw__schedule_task',
          'mcp__nanoclaw__update_task',
        ]),
      );
      for (const toolName of ['schedule_task', 'update_task']) {
        const tool = tools.find((entry) => entry.name === toolName);
        assert.ok(tool, `${toolName} should be exposed for this test`);
        const properties = (
          tool.inputSchema as { properties?: Record<string, unknown> }
        ).properties;
        assert.equal(properties && 'script' in properties, false);
      }
    },
  );
});
