import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf-8');
}

describe('helper boundary wiring', () => {
  it('guards every exposed IPC MCP tool with route checks', () => {
    const source = readRepoFile('container/agent-runner/src/ipc-mcp-stdio.ts');
    const toolNames = [...source.matchAll(/server\.tool\(\s*'([^']+)'/g)].map(
      (match) => match[1],
    );

    expect(toolNames.length).toBeGreaterThan(0);

    for (const toolName of toolNames) {
      expect(source).toContain(`guardMcpTool('${toolName}')`);
    }
  });

  it('passes request policy guidance and MCP allowlist into the container helper runtime', () => {
    const source = readRepoFile('container/agent-runner/src/index.ts');

    expect(source).toContain('requestPolicy.guidance');
    expect(source).toContain('NANOCLAW_ALLOWED_MCP_TOOLS');
    expect(source).toContain('...requestPolicy.mcpTools');
    expect(source).toContain('mcp__nanoclaw__search_amazon_products');
    expect(source).toContain('mcp__nanoclaw__request_amazon_purchase');
    expect(source).toContain('mcp__nanoclaw__approve_amazon_purchase_request');
  });

  it('retries one transient direct-assistant failure without exposing helper errors first', () => {
    const source = readRepoFile('container/agent-runner/src/index.ts');

    expect(source).toContain("route === 'direct_assistant'");
    expect(source).toContain('suppressFirstErrorForRetry');
    expect(source).toContain('suppressedTransientError');
    expect(source).toContain(
      'Retrying direct assistant request in recovery mode',
    );
    expect(source).toContain('disableMcpServer');
    expect(source).toContain(
      'Recovery mode: previous attempt hit a transient execution failure',
    );
  });

  it('keeps send_message as Andrea-only instead of advertising a second bot identity', () => {
    const source = readRepoFile('container/agent-runner/src/ipc-mcp-stdio.ts');

    expect(source).toContain(
      'Legacy no-op field. Public messages still appear as Andrea',
    );
    expect(source).not.toContain('dedicated bot in Telegram');
  });
});
