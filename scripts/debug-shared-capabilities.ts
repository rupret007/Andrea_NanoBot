import {
  executeAssistantCapability,
  getAssistantCapability,
  isAssistantCapabilityAllowed,
} from '../src/assistant-capabilities.js';
import { initDatabase } from '../src/db.js';

function parseArgs(argv: string[]): {
  groupFolder: string;
  researchPrompt: string;
} {
  let groupFolder = 'main';
  const promptParts: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value) continue;
    if (value === '--group' && argv[i + 1]) {
      groupFolder = argv[i + 1]!;
      i += 1;
      continue;
    }
    promptParts.push(value);
  }

  return {
    groupFolder,
    researchPrompt:
      promptParts.join(' ').trim() ||
      'Compare meal delivery options for this week and summarize the tradeoffs',
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
  const { groupFolder, researchPrompt } = parseArgs(process.argv.slice(2));
  const now = new Date();

  const telegramLooseEnds = await executeAssistantCapability({
    capabilityId: 'daily.loose_ends',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      text: 'what am I forgetting',
      canonicalText: 'what am I forgetting',
    },
  });

  const alexaHousehold = await executeAssistantCapability({
    capabilityId: 'household.candace_upcoming',
    context: {
      channel: 'alexa',
      groupFolder,
      now,
    },
    input: {
      text: 'what about Candace',
      canonicalText: 'what about Candace',
      personName: 'Candace',
    },
  });

  const alexaResearch = await executeAssistantCapability({
    capabilityId: 'research.compare',
    context: {
      channel: 'alexa',
      groupFolder,
      now,
    },
    input: {
      text: researchPrompt,
      canonicalText: researchPrompt,
    },
  });

  const telegramResearch = await executeAssistantCapability({
    capabilityId: 'research.compare',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      text: researchPrompt,
      canonicalText: researchPrompt,
    },
  });

  const workLogsCapability = getAssistantCapability('work.current_logs');

  printBlock('TELEGRAM DAILY', [
    `handled: ${telegramLooseEnds.handled}`,
    `reply: ${telegramLooseEnds.replyText || 'none'}`,
    `source: ${telegramLooseEnds.trace?.responseSource || 'none'}`,
    `shape: ${telegramLooseEnds.outputShape || 'none'}`,
  ]);

  printBlock('ALEXA HOUSEHOLD', [
    `handled: ${alexaHousehold.handled}`,
    `reply: ${alexaHousehold.replyText || 'none'}`,
    `source: ${alexaHousehold.trace?.responseSource || 'none'}`,
    `shape: ${alexaHousehold.outputShape || 'none'}`,
  ]);

  printBlock('ALEXA RESEARCH', [
    `handled: ${alexaResearch.handled}`,
    `provider: ${alexaResearch.researchResult?.providerUsed || 'none'}`,
    `reply: ${alexaResearch.replyText || 'none'}`,
    `handoff: ${alexaResearch.handoffOffer || 'none'}`,
    `shape: ${alexaResearch.outputShape || 'none'}`,
  ]);

  printBlock('TELEGRAM RESEARCH', [
    `handled: ${telegramResearch.handled}`,
    `provider: ${telegramResearch.researchResult?.providerUsed || 'none'}`,
    `reply: ${telegramResearch.replyText || 'none'}`,
    `full: ${telegramResearch.researchResult?.fullText || 'none'}`,
    `shape: ${telegramResearch.outputShape || 'none'}`,
  ]);

  printBlock('SAFETY GATE', [
    `work.current_logs allowed on Alexa: ${
      workLogsCapability
        ? isAssistantCapabilityAllowed(workLogsCapability, 'alexa')
        : 'unknown'
    }`,
    `work.current_logs allowed on Telegram: ${
      workLogsCapability
        ? isAssistantCapabilityAllowed(workLogsCapability, 'telegram')
        : 'unknown'
    }`,
    `handlerKind: ${workLogsCapability?.handlerKind || 'unknown'}`,
    `note: ${workLogsCapability?.availabilityNote || 'none'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-shared-capabilities failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
