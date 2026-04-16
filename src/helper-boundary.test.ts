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
    const directQuickReplyIndex = source.indexOf(
      "if (requestPolicy.route === 'direct_assistant' && quickReply)",
    );

    expect(continuationIndex).toBeGreaterThan(-1);
    expect(directQuickReplyIndex).toBeGreaterThan(-1);
    expect(continuationIndex).toBeLessThan(directQuickReplyIndex);
  });

  it('lets fresh day, calendar, reminder, and slash-command prompts interrupt pending action continuations', () => {
    const indexSource = readRepoFile('src/index.ts');
    const actionLayerSource = readRepoFile('src/action-layer.ts');

    expect(indexSource).toContain('shouldInterruptPendingActionLayerFlow(');
    expect(actionLayerSource).toContain('trimmed.startsWith(\'/\')');
    expect(actionLayerSource).toContain(
      'isPotentialDailyCompanionPrompt(message)',
    );
    expect(actionLayerSource).toContain(
      'planCalendarAssistantLookup(message, now, timeZone)',
    );
    expect(actionLayerSource).toContain(
      'isExplicitGoogleCalendarCreateRequest(message)',
    );
    expect(actionLayerSource).toContain(
      'planSimpleReminder(message, params.groupFolder, params.chatJid, now)',
    );
  });

  it('persists shared capability follow-up context so plain Telegram continuations do not fall back to stale daily context', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain(
      'continueAssistantCapabilityFromPriorSubjectData(',
    );
    expect(source).toContain(
      'const priorAssistantCapabilitySeed = getSharedAssistantCapabilitySeed(',
    );
    expect(source).toContain(
      'priorAssistantCapabilitySeed?.subjectData,',
    );
    expect(source).toContain(
      'priorSubjectData: priorAssistantCapabilitySeed?.subjectData',
    );
    expect(source).toContain(
      'setSharedAssistantCapabilitySeed(chatJid, result.conversationSeed, now);',
    );
    expect(source).toContain('clearSharedAssistantCapabilitySeed(chatJid);');
  });

  it('lets pending BlueBubbles local continuations bypass the fresh @Andrea wake gate without widening ordinary chatter', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain(
      'const pendingLocalContinuationKind =',
    );
    expect(source).toContain(
      'getPendingBlueBubblesLocalContinuationKind(chatJid, companionNow);',
    );
    expect(source).toContain('decideBlueBubblesCompanionIngress(');
    expect(source).toContain(
      'Enqueued BlueBubbles same-thread follow-up for pending local continuation',
    );
    expect(source).toContain(
      'Ignored BlueBubbles chatter without an @Andrea mention or pending local continuation',
    );
  });

  it('reconciles work-cockpit current-work panels against the visible lane state before clearing selection', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain('reconcileWorkCockpitCurrentSelection({');
    expect(source).toContain('runtimeJobId: runtimeSelection?.selected?.handle.jobId || null');
    expect(source).toContain('cursorJobId: selection?.selected?.id || null');
    expect(source).toContain('shouldClearStaleWorkCockpitSelection({');
  });

  it('keeps a plain Current Work request on the cockpit dashboard path', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain('function isCurrentWorkQuickOpenPhrase(');
    expect(source).toContain(".replace(/[’‘]/g, \"'\")");
    expect(source).toContain("normalized === 'current work'");
    expect(source).toContain(`normalized === "show me what's running"`);
    expect(source).toContain("normalized === 'what work is active right now'");
    expect(source).toContain(`normalized === "what's the latest from runtime"`);
    expect(source).toContain("state: { kind: 'work_current' }");
    expect(source).toContain('forceNew: true');
    expect(source).toContain('getRegisteredMainChat()?.jid === chatJid');
  });

  it('routes shared assistant save and reminder follow-ups before generic direct action-layer fallbacks', () => {
    const source = readRepoFile('src/index.ts');
    const sharedCompletionIndex = source.indexOf(
      'if (await tryHandleSharedAssistantCompletion()) {',
    );
    const directActionLayerIndex = source.indexOf(
      "if (await tryHandleLocalActionLayer('direct')) {",
    );

    expect(source).toContain(
      'const tryHandleSharedAssistantCompletion = async (): Promise<boolean> => {',
    );
    expect(source).toContain(
      'const followup = resolveAlexaConversationFollowup(lastContent, state);',
    );
    expect(source).toContain('completeAssistantActionFromAlexa(');
    expect(sharedCompletionIndex).toBeGreaterThan(-1);
    expect(directActionLayerIndex).toBeGreaterThan(-1);
    expect(sharedCompletionIndex).toBeLessThan(directActionLayerIndex);
  });

  it('checks shared assistant completion follow-ups before reopening shared capability routing', () => {
    const source = readRepoFile('src/index.ts');
    const sharedCompletionIndex = source.indexOf(
      'if (await tryHandleSharedAssistantCompletion()) {',
    );
    const sharedCapabilityIndex = source.indexOf(
      'if (await tryHandleSharedAssistantCapability()) {',
    );

    expect(sharedCompletionIndex).toBeGreaterThan(-1);
    expect(sharedCapabilityIndex).toBeGreaterThan(-1);
    expect(sharedCompletionIndex).toBeLessThan(sharedCapabilityIndex);
  });
});
