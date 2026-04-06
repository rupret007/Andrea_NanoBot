import { Buffer } from 'buffer';

import { completeAssistantActionFromAlexa } from '../src/assistant-action-completion.js';
import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { seedConfiguredAlexaLinkedAccount } from '../src/alexa-identity.js';
import {
  getCompanionHandoff,
  getTaskById,
  listKnowledgeSourcesForGroup,
  setRegisteredGroup,
  _initTestDatabase,
} from '../src/db.js';
import { saveKnowledgeSource } from '../src/knowledge-library.js';
import type {
  ChannelArtifact,
  CompanionContinuationCandidate,
  SendMessageResult,
} from '../src/types.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  _initTestDatabase();
  const groupFolder = 'handoff-debug';
  const chatJid = 'tg:handoff-debug';

  setRegisteredGroup(chatJid, {
    name: 'Andrea Handoff Debug',
    folder: groupFolder,
    trigger: '@Andrea',
    added_at: '2026-04-05T09:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
  });
  seedConfiguredAlexaLinkedAccount({
    ALEXA_LINKED_ACCOUNT_TOKEN: 'handoff-debug-token',
    ALEXA_LINKED_ACCOUNT_NAME: 'Andrea Handoff Debug',
    ALEXA_LINKED_ACCOUNT_GROUP_FOLDER: groupFolder,
    ALEXA_LINKED_ACCOUNT_ALLOWED_USER_ID: 'amzn1.ask.account.debug',
    ALEXA_LINKED_ACCOUNT_ALLOWED_PERSON_ID: 'amzn1.ask.person.debug',
  });

  saveKnowledgeSource({
    groupFolder,
    title: 'Candace Dinner Note',
    shortSummary: 'Pickup works better after rehearsal tonight.',
    content:
      'Candace still needs a dinner answer tonight, and pickup works better after rehearsal because the handoff stays simpler.',
    sourceType: 'manual_reference',
    tags: ['candace', 'dinner'],
    now: new Date('2026-04-05T09:05:00.000Z'),
  });

  const sentMessages: Array<{ chatJid: string; text: string }> = [];
  const sentArtifacts: Array<{
    chatJid: string;
    artifact: ChannelArtifact;
    caption?: string;
  }> = [];

  const sendTelegramMessage = async (
    targetChatJid: string,
    text: string,
  ): Promise<SendMessageResult> => {
    sentMessages.push({ chatJid: targetChatJid, text });
    return {
      platformMessageId: `tg-msg-${sentMessages.length}`,
    };
  };

  const sendTelegramArtifact = async (
    targetChatJid: string,
    artifact: ChannelArtifact,
    options?: { caption?: string },
  ): Promise<SendMessageResult> => {
    sentArtifacts.push({
      chatJid: targetChatJid,
      artifact,
      caption: options?.caption,
    });
    return {
      platformMessageId: `tg-artifact-${sentArtifacts.length}`,
    };
  };

  const handoffDeps = {
    resolveTelegramMainChat: (targetGroupFolder: string) =>
      targetGroupFolder === groupFolder ? { chatJid } : undefined,
    sendTelegramMessage,
    sendTelegramArtifact,
  };

  const researchCandidate: CompanionContinuationCandidate = {
    capabilityId: 'research.compare',
    voiceSummary: 'Kindle is the safer battery pick.',
    completionText:
      'Kindle Paperwhite is the safer night-reading choice because battery life is stronger and the display is easier on the eyes in the dark.',
    handoffPayload: {
      kind: 'message',
      title: 'Full comparison',
      text: [
        '*Research Summary*',
        '',
        'Kindle Paperwhite is the safer night-reading choice.',
        '',
        '*Tradeoffs*',
        '- Paperwhite wins on battery life and simplicity.',
        '- Kobo Clara Colour adds color, but battery is usually the weaker trade.',
      ].join('\n'),
      followupSuggestions: ['Save it if useful.'],
    },
    followupSuggestions: ['Save it if useful.'],
  };

  const researchHandoff = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'send_details',
      utterance: 'send me the details',
      conversationSummary: 'Kindle comparison',
      priorSubjectData: {
        lastAnswerSummary: researchCandidate.voiceSummary,
        companionContinuationJson: JSON.stringify(researchCandidate),
      },
      now: new Date('2026-04-05T09:10:00.000Z'),
    },
    handoffDeps,
  );

  const knowledgeAnswer = await executeAssistantCapability({
    capabilityId: 'knowledge.summarize_saved',
    context: {
      channel: 'alexa',
      groupFolder,
      now: new Date('2026-04-05T09:12:00.000Z'),
    },
    input: {
      canonicalText: 'What do my saved notes say about Candace dinner timing?',
    },
  });
  const knowledgeHandoff = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'send_details',
      utterance: 'send the full version to Telegram',
      conversationSummary:
        knowledgeAnswer.conversationSeed?.summaryText ||
        knowledgeAnswer.replyText ||
        'Saved material summary',
      priorSubjectData: {
        lastAnswerSummary: knowledgeAnswer.replyText || '',
        companionContinuationJson: knowledgeAnswer.continuationCandidate
          ? JSON.stringify(knowledgeAnswer.continuationCandidate)
          : undefined,
      },
      now: new Date('2026-04-05T09:13:00.000Z'),
    },
    handoffDeps,
  );

  const mediaCandidate: CompanionContinuationCandidate = {
    capabilityId: 'media.image_generate',
    voiceSummary: 'I can send that image to Telegram.',
    completionText:
      'Generate an image of a calm reading nook with warm afternoon light, a blue chair, and a stack of books.',
    handoffPayload: {
      kind: 'artifact',
      title: 'Reading nook concept',
      text: 'A calm reading nook with warm afternoon light.',
      caption:
        'Reading nook concept: warm afternoon light, a blue chair, and a stack of books.',
      artifact: {
        kind: 'image',
        filename: 'reading-nook.png',
        mimeType: 'image/png',
        bytesBase64: Buffer.from('andrea-cross-channel-proof-image').toString(
          'base64',
        ),
        altText:
          'A calm reading nook with warm afternoon light, a blue chair, and a stack of books.',
      },
      followupSuggestions: ['Save it to your library if useful.'],
    },
    followupSuggestions: ['Save it to your library if useful.'],
  };
  const mediaHandoff = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'send_details',
      utterance: 'yes',
      conversationSummary: 'Reading nook image',
      priorSubjectData: {
        lastAnswerSummary: mediaCandidate.voiceSummary,
        companionContinuationJson: JSON.stringify(mediaCandidate),
      },
      now: new Date('2026-04-05T09:15:00.000Z'),
    },
    handoffDeps,
  );

  const librarySave = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'save_to_library',
      utterance: 'save that in my library',
      conversationSummary: 'Kindle comparison',
      priorSubjectData: {
        lastAnswerSummary: researchCandidate.voiceSummary,
        companionContinuationJson: JSON.stringify(researchCandidate),
      },
      now: new Date('2026-04-05T09:16:00.000Z'),
    },
    handoffDeps,
  );

  const reminderSave = await completeAssistantActionFromAlexa(
    {
      groupFolder,
      action: 'create_reminder',
      utterance: 'turn that into a reminder tonight',
      conversationSummary: 'Candace dinner follow-up',
      priorSubjectData: {
        lastAnswerSummary:
          'Send Candace the dinner answer before rehearsal ends.',
        companionContinuationJson: JSON.stringify({
          capabilityId: 'daily.loose_ends',
          voiceSummary: 'Do not forget the dinner answer.',
          completionText:
            'Send Candace the dinner answer before rehearsal ends.',
        } satisfies CompanionContinuationCandidate),
      },
      now: new Date('2026-04-05T16:00:00.000Z'),
    },
    handoffDeps,
  );

  const researchRecord = researchHandoff.handoffResult?.handoffId
    ? getCompanionHandoff(researchHandoff.handoffResult.handoffId)
    : null;
  const knowledgeRecord = knowledgeHandoff.handoffResult?.handoffId
    ? getCompanionHandoff(knowledgeHandoff.handoffResult.handoffId)
    : null;
  const mediaRecord = mediaHandoff.handoffResult?.handoffId
    ? getCompanionHandoff(mediaHandoff.handoffResult.handoffId)
    : null;
  const reminderTask = reminderSave.reminderTaskId
    ? getTaskById(reminderSave.reminderTaskId)
    : null;

  printBlock('HANDOFF SEED', [
    `group_folder: ${groupFolder}`,
    `telegram_main_chat: ${chatJid}`,
    `knowledge_sources: ${listKnowledgeSourcesForGroup(groupFolder).length}`,
  ]);

  printBlock('RESEARCH HANDOFF', [
    `handled: ${researchHandoff.handled}`,
    `speech: ${researchHandoff.replyText || 'none'}`,
    `status: ${researchRecord?.status || 'missing'}`,
    `target: ${researchRecord?.targetChatJid || 'missing'}`,
    `delivered_message_id: ${researchRecord?.deliveredMessageId || 'missing'}`,
    `delivered_text: ${sentMessages[0]?.text || 'missing'}`,
  ]);

  printBlock('KNOWLEDGE HANDOFF', [
    `handled: ${knowledgeHandoff.handled}`,
    `speech: ${knowledgeHandoff.replyText || 'none'}`,
    `status: ${knowledgeRecord?.status || 'missing'}`,
    `target: ${knowledgeRecord?.targetChatJid || 'missing'}`,
    `delivered_message_id: ${knowledgeRecord?.deliveredMessageId || 'missing'}`,
    `delivered_text: ${sentMessages[1]?.text || 'missing'}`,
  ]);

  printBlock('MEDIA HANDOFF', [
    `handled: ${mediaHandoff.handled}`,
    `speech: ${mediaHandoff.replyText || 'none'}`,
    `status: ${mediaRecord?.status || 'missing'}`,
    `target: ${mediaRecord?.targetChatJid || 'missing'}`,
    `artifact_message_id: ${mediaRecord?.deliveredMessageId || 'missing'}`,
    `artifact_filename: ${sentArtifacts[0]?.artifact.filename || 'missing'}`,
    `artifact_caption: ${sentArtifacts[0]?.caption || 'missing'}`,
  ]);

  printBlock('SAVE TO LIBRARY', [
    `handled: ${librarySave.handled}`,
    `reply: ${librarySave.replyText || 'none'}`,
    `library_count_after_save: ${listKnowledgeSourcesForGroup(groupFolder).length}`,
  ]);

  printBlock('VOICE REMINDER COMPLETION', [
    `handled: ${reminderSave.handled}`,
    `reply: ${reminderSave.replyText || 'none'}`,
    `task_id: ${reminderTask?.id || 'missing'}`,
    `task_next_run: ${reminderTask?.next_run || 'missing'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-cross-channel-handoffs failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
