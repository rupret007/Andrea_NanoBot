import { completeAssistantActionFromAlexa } from '../src/assistant-action-completion.js';
import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import {
  _initTestDatabase,
  getAllTasks,
  getCompanionHandoff,
  setRegisteredGroup,
} from '../src/db.js';
import type { SendMessageResult } from '../src/types.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  _initTestDatabase();
  const groupFolder = 'communication-debug';
  const telegramChatJid = 'tg:communication-debug';
  const now = new Date('2026-04-06T09:00:00.000Z');

  setRegisteredGroup(telegramChatJid, {
    name: 'Communication Debug',
    folder: groupFolder,
    trigger: '@Andrea',
    added_at: now.toISOString(),
    requiresTrigger: false,
    isMain: true,
  });

  const understand = await executeAssistantCapability({
    capabilityId: 'communication.understand_message',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: telegramChatJid,
      now,
    },
    input: {
      canonicalText:
        'Summarize this message: Candace: Can you let me know if dinner still works tonight? If not, we should move it.',
    },
  });

  const draft = await executeAssistantCapability({
    capabilityId: 'communication.draft_reply',
    context: {
      channel: 'bluebubbles',
      groupFolder,
      chatJid: 'bb:communication-debug',
      now,
      priorSubjectData: understand.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'make it warmer',
    },
  });

  const reminder = await executeAssistantCapability({
    capabilityId: 'communication.manage_tracking',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid: telegramChatJid,
      now,
      priorSubjectData: understand.conversationSeed?.subjectData,
    },
    input: {
      canonicalText:
        'Remind me to reply later tonight: Candace: Can you let me know if dinner still works tonight?',
    },
  });

  const openLoops = await executeAssistantCapability({
    capabilityId: 'communication.open_loops',
    context: {
      channel: 'alexa',
      groupFolder,
      now,
    },
    input: {
      canonicalText: 'what do I owe people',
    },
  });

  const sentMessages: Array<{ chatJid: string; text: string }> = [];
  const sendTelegramMessage = async (
    chatJid: string,
    text: string,
  ): Promise<SendMessageResult> => {
    sentMessages.push({ chatJid, text });
    return { platformMessageId: `tg-debug-${sentMessages.length}` };
  };

  const handoff = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'send_details',
      utterance: 'send the details to Telegram',
      conversationSummary:
        draft.conversationSeed?.summaryText || draft.replyText || 'Draft reply',
      priorSubjectData: {
        ...draft.conversationSeed?.subjectData,
        lastAnswerSummary: draft.replyText || '',
        companionContinuationJson: draft.continuationCandidate
          ? JSON.stringify(draft.continuationCandidate)
          : undefined,
      },
      now,
    },
    {
      resolveTelegramMainChat: (targetGroupFolder: string) =>
        targetGroupFolder === groupFolder
          ? { chatJid: telegramChatJid }
          : undefined,
      sendTelegramMessage,
    },
  );

  const handoffRecord = handoff.handoffResult?.handoffId
    ? getCompanionHandoff(handoff.handoffResult.handoffId)
    : null;

  printBlock('COMMUNICATION UNDERSTAND', [
    `handled: ${understand.handled}`,
    `reply: ${understand.replyText || 'none'}`,
    `communication_thread_id: ${
      understand.continuationCandidate?.communicationThreadId || 'none'
    }`,
  ]);

  printBlock('COMMUNICATION DRAFT', [
    `handled: ${draft.handled}`,
    `reply: ${draft.replyText || 'none'}`,
    `handoff_ready: ${draft.handoffPayload?.kind || 'none'}`,
  ]);

  printBlock('COMMUNICATION REMINDER', [
    `handled: ${reminder.handled}`,
    `reply: ${reminder.replyText || 'none'}`,
    `task_count: ${getAllTasks().filter((task) => task.group_folder === groupFolder).length}`,
  ]);

  printBlock('COMMUNICATION OPEN LOOPS', [
    `handled: ${openLoops.handled}`,
    `reply: ${openLoops.replyText || 'none'}`,
  ]);

  printBlock('COMMUNICATION HANDOFF', [
    `handled: ${handoff.handled}`,
    `reply: ${handoff.replyText || 'none'}`,
    `sent_count: ${sentMessages.length}`,
    `handoff_status: ${handoffRecord?.status || 'none'}`,
    `handoff_thread_id: ${handoffRecord?.communicationThreadId || 'none'}`,
    `handoff_last_summary: ${handoffRecord?.lastCommunicationSummary || 'none'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-communication-companion failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
