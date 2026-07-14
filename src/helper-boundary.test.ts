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
    const policySource = readRepoFile(
      'container/agent-runner/src/request-policy.ts',
    );

    expect(source).toContain('requestPolicy.guidance');
    expect(source).toContain('NANOCLAW_ALLOWED_MCP_TOOLS');
    expect(source).toContain('requestPolicy.mcpTools');
    expect(source).toContain('buildSdkToolPolicy(requestPolicy, options)');
    expect(source).toContain('tools,');
    expect(policySource).toContain('mcp__nanoclaw__search_amazon_products');
    expect(policySource).toContain('mcp__nanoclaw__request_amazon_purchase');
    expect(policySource).toContain(
      'mcp__nanoclaw__approve_amazon_purchase_request',
    );
  });

  it('retries direct-assistant execution failures without dropping request-policy guardrails', () => {
    const source = readRepoFile('container/agent-runner/src/index.ts');

    expect(source).toContain('planDirectAssistantRecoveryRetry');
    expect(source).toContain('classifyDirectAssistantError');
    expect(source).toContain('retry_suppressed_first_error');
    expect(source).toContain('retry_started');
    expect(source).toContain('buildSdkToolPolicy(requestPolicy, options)');
    expect(source).toContain('buildSdkMcpBoundaryConfig(useMcpServer');
    expect(source).toContain('strictMcpConfig: mcpBoundary.strictMcpConfig');
    expect(source).toContain('mcpServers: mcpBoundary.mcpServers');
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
    expect(actionLayerSource).toContain("trimmed.startsWith('/')");
    expect(actionLayerSource).toContain(
      'looksLikeFreshDiscoveryPrompt(message)',
    );
    expect(actionLayerSource).toContain(
      'looksLikeFreshWorkCockpitPrompt(message)',
    );
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
      'matchAssistantCapabilityRequest(message)',
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
    expect(source).toContain('priorAssistantCapabilitySeed?.subjectData,');
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

    expect(source).toContain('const pendingLocalContinuationKind =');
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

  it('routes private BlueBubbles self-thread OpenClaw asks before the companion container queue', () => {
    const source = readRepoFile('src/index.ts');
    const ingressIndex = source.indexOf(
      "if (companionIngressDecision.kind === 'explicit_ask') {",
    );
    const openClawRouteIndex = source.indexOf(
      'const selfThreadOpenClawRoute = resolveOpenClawDelegationRoute({',
      ingressIndex,
    );
    const companionQueueIndex = source.indexOf(
      'queue.enqueueMessageCheck(chatJid);',
      openClawRouteIndex,
    );

    expect(ingressIndex).toBeGreaterThan(-1);
    expect(openClawRouteIndex).toBeGreaterThan(ingressIndex);
    expect(companionQueueIndex).toBeGreaterThan(openClawRouteIndex);
    expect(source).toContain(
      'blueBubblesSelfThread: isBlueBubblesSelfThreadAliasJid(chatJid)',
    );
    expect(source).toContain(
      "'BlueBubbles self-thread OpenClaw delegation error'",
    );

    const durableRouteIndex = source.indexOf(
      'const queuedOpenClawRoute = resolveOpenClawDelegationRoute({',
    );
    const genericTurnIndex = source.indexOf(
      'const turnDequeuedAt = Date.now();',
      durableRouteIndex,
    );
    expect(durableRouteIndex).toBeGreaterThan(-1);
    expect(genericTurnIndex).toBeGreaterThan(durableRouteIndex);
    const durableRouteSource = source.slice(
      durableRouteIndex,
      genericTurnIndex,
    );
    expect(durableRouteSource).toContain("ingress: 'durable_queue'");
    expect(durableRouteSource).toContain(
      'await prepareOpenClawDelegationResponse({',
    );
    expect(durableRouteSource).toContain(
      'OpenClaw delegation prepared for same-chat delivery',
    );
    expect(durableRouteSource).not.toContain('replyToMessageId:');
    expect(durableRouteSource).not.toContain('Asking OpenClaw…');
  });

  it('reconciles work-cockpit current-work panels against the visible lane state before clearing selection', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain('reconcileWorkCockpitCurrentSelection({');
    expect(source).toContain(
      'runtimeJobId: runtimeSelection?.selected?.handle.jobId || null',
    );
    expect(source).toContain('cursorJobId: selection?.selected?.id || null');
    expect(source).toContain('shouldClearStaleWorkCockpitSelection({');
  });

  it('keeps a plain Current Work request on the cockpit dashboard path', () => {
    const source = readRepoFile('src/index.ts');

    expect(source).toContain('function isCurrentWorkQuickOpenPhrase(');
    expect(source).toContain('.replace(/[’‘]/g, "\'")');
    expect(source).toContain("normalized === 'current work'");
    expect(source).toContain(`normalized === "show me what's running"`);
    expect(source).toContain(
      `normalized === "show me what's running right now"`,
    );
    expect(source).toContain("normalized === 'what work is active right now'");
    expect(source).toContain("normalized === 'open the current task again'");
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

  it('checks shared assistant capabilities before the AGI runtime fallback', () => {
    const source = readRepoFile('src/index.ts');
    const sharedCapabilityIndex = source.indexOf(
      'if (await tryHandleSharedAssistantCapability()) {',
    );
    const agiRuntimeIndex = source.indexOf(
      'if (await tryHandleAgiRuntimeTurn()) {',
    );

    expect(sharedCapabilityIndex).toBeGreaterThan(-1);
    expect(agiRuntimeIndex).toBeGreaterThan(-1);
    expect(sharedCapabilityIndex).toBeLessThan(agiRuntimeIndex);
  });
});
