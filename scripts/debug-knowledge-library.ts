import fs from 'fs';
import os from 'os';
import path from 'path';

import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { initDatabase } from '../src/db.js';
import {
  importKnowledgeFile,
  saveKnowledgeSource,
} from '../src/knowledge-library.js';

function parseArgs(argv: string[]): { groupFolder: string } {
  let groupFolder = 'knowledge-debug';
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--group' && argv[i + 1]) {
      groupFolder = argv[i + 1]!;
      i += 1;
    }
  }
  return { groupFolder };
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
  const { groupFolder } = parseArgs(process.argv.slice(2));
  const now = new Date();

  const savedNote = saveKnowledgeSource({
    groupFolder,
    sourceId: 'knowledge-debug-candace-note',
    title: 'Candace Dinner Note',
    content:
      'Candace wants Friday dinner after rehearsal because pickup timing stays simpler and bedtime does not get squeezed.',
    sourceType: 'manual_reference',
    tags: ['candace', 'dinner'],
    now,
  });

  const savedResearch = saveKnowledgeSource({
    groupFolder,
    sourceId: 'knowledge-debug-candace-summary',
    title: 'Candace Planning Summary',
    content:
      'Saved planning summary: Saturday dinner leaves more prep time, but Friday after rehearsal keeps the handoff simpler and avoids a late bedtime.',
    sourceType: 'saved_research_result',
    tags: ['candace', 'planning', 'dinner'],
    now,
  });

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'andrea-knowledge-debug-'),
  );
  const filePath = path.join(tempDir, 'candace-planning.md');
  fs.writeFileSync(
    filePath,
    '# Candace Planning File\n\nImported note: Friday dinner works better for pickup timing, while Saturday dinner gives more prep space if rehearsal runs long.',
    'utf8',
  );
  const importedFile = importKnowledgeFile({
    groupFolder,
    filePath,
    sourceId: 'knowledge-debug-candace-file',
    now,
  });

  const telegramSummary = await executeAssistantCapability({
    capabilityId: 'knowledge.summarize_saved',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText:
        'What do my saved notes say about Candace and dinner timing?',
    },
  });

  const telegramSavedOnly = await executeAssistantCapability({
    capabilityId: 'knowledge.summarize_saved',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText:
        'Use only my saved material to summarize what I saved about Candace dinner timing.',
    },
  });

  const telegramCompare = await executeAssistantCapability({
    capabilityId: 'knowledge.compare_saved',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText:
        'Use only my saved material to compare these saved sources about Candace dinner timing and planning.',
    },
  });

  const telegramSources = await executeAssistantCapability({
    capabilityId: 'knowledge.list_sources',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText:
        'Show me the relevant saved items for Candace dinner timing and planning',
    },
  });

  const telegramExplain = await executeAssistantCapability({
    capabilityId: 'knowledge.explain_sources',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: 'tg:debug',
      now,
    },
    input: {
      canonicalText:
        'What sources are you using for the Candace dinner planning answer?',
    },
  });

  const alexaSummary = await executeAssistantCapability({
    capabilityId: 'knowledge.summarize_saved',
    context: {
      channel: 'alexa',
      groupFolder,
      now,
    },
    input: {
      canonicalText: 'What do I already know about Candace dinner timing?',
    },
  });

  printBlock('KNOWLEDGE SAVE', [
    `note_saved: ${savedNote.ok}`,
    `research_saved: ${savedResearch.ok}`,
    `file_saved: ${importedFile.ok}`,
    `note_title: ${savedNote.source?.title || 'none'}`,
    `research_title: ${savedResearch.source?.title || 'none'}`,
    `file_title: ${importedFile.source?.title || 'none'}`,
  ]);

  printBlock('TELEGRAM KNOWLEDGE SUMMARY', [
    `handled: ${telegramSummary.handled}`,
    `reply: ${telegramSummary.replyText || 'none'}`,
    `trace: ${telegramSummary.trace?.responseSource || 'none'}`,
  ]);

  printBlock('TELEGRAM KNOWLEDGE ONLY', [
    `handled: ${telegramSavedOnly.handled}`,
    `reply: ${telegramSavedOnly.replyText || 'none'}`,
    `trace: ${telegramSavedOnly.trace?.responseSource || 'none'}`,
  ]);

  printBlock('TELEGRAM KNOWLEDGE COMPARE', [
    `handled: ${telegramCompare.handled}`,
    `reply: ${telegramCompare.replyText || 'none'}`,
    `trace: ${telegramCompare.trace?.responseSource || 'none'}`,
  ]);

  printBlock('TELEGRAM SOURCE LIST', [
    `handled: ${telegramSources.handled}`,
    `reply: ${telegramSources.replyText || 'none'}`,
    `trace: ${telegramSources.trace?.responseSource || 'none'}`,
  ]);

  printBlock('TELEGRAM SOURCE EXPLAIN', [
    `handled: ${telegramExplain.handled}`,
    `reply: ${telegramExplain.replyText || 'none'}`,
    `trace: ${telegramExplain.trace?.responseSource || 'none'}`,
  ]);

  printBlock('ALEXA SOURCE SUMMARY', [
    `handled: ${alexaSummary.handled}`,
    `reply: ${alexaSummary.replyText || 'none'}`,
    `handoff: ${alexaSummary.handoffOffer || 'none'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-knowledge-library failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
