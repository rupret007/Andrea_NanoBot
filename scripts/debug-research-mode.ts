import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { initDatabase } from '../src/db.js';
import { runResearchOrchestrator } from '../src/research-orchestrator.js';

function parseArgs(argv: string[]): {
  groupFolder: string;
  localPrompt: string;
  externalPrompt: string;
  imagePrompt: string;
} {
  let groupFolder = 'main';
  let localPrompt = 'Summarize what matters from my current context';
  let externalPrompt = 'Compare meal delivery options for this week';
  let imagePrompt = 'a calm reading nook with warm afternoon light';

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value) continue;
    if (value === '--group' && argv[i + 1]) {
      groupFolder = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (value === '--local' && argv[i + 1]) {
      localPrompt = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (value === '--external' && argv[i + 1]) {
      externalPrompt = argv[i + 1]!;
      i += 1;
      continue;
    }
    if (value === '--image' && argv[i + 1]) {
      imagePrompt = argv[i + 1]!;
      i += 1;
    }
  }

  return {
    groupFolder,
    localPrompt,
    externalPrompt,
    imagePrompt,
  };
}

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  initDatabase();
  const { groupFolder, localPrompt, externalPrompt, imagePrompt } = parseArgs(
    process.argv.slice(2),
  );
  const now = new Date();

  const local = await runResearchOrchestrator({
    query: localPrompt,
    channel: 'telegram',
    groupFolder,
    now,
  });
  const external = await runResearchOrchestrator({
    query: externalPrompt,
    channel: 'telegram',
    groupFolder,
    now,
  });
  const media = await executeAssistantCapability({
    capabilityId: 'media.image_generate',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText: imagePrompt,
    },
  });

  printBlock('LOCAL CONTEXT RESEARCH', [
    `handled: ${local.handled}`,
    `provider: ${local.providerUsed || 'none'}`,
    `summary: ${local.summaryText || 'none'}`,
    `route: ${local.routeExplanation}`,
    `findings: ${local.structuredFindings.map((section) => `${section.title}=${section.items.length}`).join(', ') || 'none'}`,
    `debug: ${local.debugPath.join(' | ') || 'none'}`,
  ]);

  printBlock('OPENAI-BACKED RESEARCH OR BLOCKER', [
    `handled: ${external.handled}`,
    `provider: ${external.providerUsed || 'none'}`,
    `summary: ${external.summaryText || 'none'}`,
    `route: ${external.routeExplanation}`,
    `followups: ${external.followupSuggestions.join(' | ') || 'none'}`,
    `debug: ${external.debugPath.join(' | ') || 'none'}`,
  ]);

  printBlock('MEDIA IMAGE GENERATION', [
    `handled: ${media.handled}`,
    `reply: ${media.replyText || 'none'}`,
    `artifact: ${media.mediaResult?.artifact ? 'present' : 'none'}`,
    `route: ${media.mediaResult?.routeExplanation || media.trace?.reason || 'none'}`,
    `debug: ${media.mediaResult?.debugPath.join(' | ') || media.trace?.notes.join(' | ') || 'none'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-research-mode failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
