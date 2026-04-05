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
    expect(source).toContain('requestPolicy.mcpTools');
    expect(source).toContain('mcp__nanoclaw__search_amazon_products');
    expect(source).toContain('mcp__nanoclaw__request_amazon_purchase');
    expect(source).toContain('mcp__nanoclaw__approve_amazon_purchase_request');
  });

  it('retries direct-assistant execution failures without dropping request-policy guardrails', () => {
    const source = readRepoFile('container/agent-runner/src/index.ts');

    expect(source).toContain('planDirectAssistantRecoveryRetry');
    expect(source).toContain('classifyDirectAssistantError');
    expect(source).toContain('retry_suppressed_first_error');
    expect(source).toContain('retry_started');
    expect(source).toContain(
      '!directAssistantMinimalMode && options.disableMcpServer !== true',
    );
    expect(source).toContain(
      'options.fallbackMode || directAssistantMinimalMode',
    );
    expect(source).toContain(
      'End the prompt stream and exit this query immediately so the outer',
    );
    expect(source).toContain('stream.end();');
    expect(source).toContain(
      'Retrying direct assistant request in recovery mode',
    );
      expect(source).toContain('disableMcpServer');
      expect(source).toContain(
        'Answer directly and concisely from the user prompt without helper orchestration.',
      );
    });

  it('keeps send_message as Andrea-only instead of advertising a second bot identity', () => {
    const source = readRepoFile('container/agent-runner/src/ipc-mcp-stdio.ts');

    expect(source).toContain(
      'Legacy no-op field. Public messages still appear as Andrea',
    );
    expect(source).not.toContain('dedicated bot in Telegram');
  });

  it('prioritizes pending action-layer continuations ahead of direct quick replies', () => {
    const source = readRepoFile('src/index.ts');
    const continuationIndex = source.indexOf(
      'const hasPendingActionLayerContinuation = Boolean(',
    );
    const directQuickReplyMatch = source.match(
      /if \(requestPolicy\.route === 'direct_assistant'\) \{\s+if \(quickReply\)/,
    );
    const directQuickReplyIndex = directQuickReplyMatch?.index ?? -1;

    expect(continuationIndex).toBeGreaterThan(-1);
    expect(directQuickReplyIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeLessThan(directQuickReplyIndex);
  });

  it('lets fresh day, calendar, reminder, and slash-command prompts interrupt pending action continuations', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain(
      'const shouldInterruptPendingActionFlow = Boolean(',
    );
    expect(source).toContain("lastContent.trim().startsWith('/')");
    expect(source).toContain('isPotentialDailyCompanionPrompt(lastContent)');
    expect(source).toContain(
      'planCalendarAssistantLookup(lastContent, now, TIMEZONE)',
    );
    expect(source).toContain(
      'planSimpleReminder(lastContent, group.folder, chatJid, now)',
    );
  });
});
