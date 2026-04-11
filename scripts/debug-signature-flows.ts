import { completeAssistantActionFromAlexa } from '../src/assistant-action-completion.js';
import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { analyzeCommunicationMessage } from '../src/communication-companion.js';
import { deliverCompanionHandoff } from '../src/cross-channel-handoffs.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getMission,
  listKnowledgeSourcesForGroup,
  setRegisteredGroup,
} from '../src/db.js';
import type {
  CompanionContinuationCandidate,
  ScheduledTask,
  SendMessageResult,
} from '../src/types.js';

const selectedWork = {
  laneLabel: 'Cursor',
  title: 'Ship docs',
  statusLabel: 'Running',
  summary: 'Polish the rollout docs and handoff notes.',
};

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

function extractLabelLine(
  text: string | null | undefined,
  label: string,
): string {
  return (
    text
      ?.split('\n')
      .find((line) => line.startsWith(`${label}:`))
      ?.trim() || 'none'
  );
}

function createReminderTask(
  groupFolder: string,
  label: string,
  nextRunIso: string,
): ScheduledTask {
  return {
    id: `task-${label.replace(/\s+/g, '-').toLowerCase()}`,
    group_folder: groupFolder,
    chat_jid: 'tg:signature-debug',
    prompt: `Send a concise reminder telling the user to ${label}.`,
    script: null,
    schedule_type: 'once',
    schedule_value: nextRunIso,
    context_mode: 'isolated',
    next_run: nextRunIso,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-06T12:00:00.000Z',
  };
}

function registerMain(groupFolder: string, chatJid: string): void {
  setRegisteredGroup(chatJid, {
    name: `${groupFolder} main`,
    folder: groupFolder,
    trigger: '@Andrea',
    added_at: '2026-04-06T12:00:00.000Z',
    requiresTrigger: false,
    isMain: true,
  });
}

function buildAlexaPriorSubjectData(
  candidate: CompanionContinuationCandidate | undefined,
  replyText: string | null | undefined,
) {
  return {
    lastAnswerSummary: replyText || '',
    companionContinuationJson: candidate
      ? JSON.stringify(candidate)
      : undefined,
  };
}

async function main(): Promise<void> {
  _initTestDatabase();

  const telegramSends: Array<{ chatJid: string; text: string }> = [];
  const sendTelegramMessage = async (
    chatJid: string,
    text: string,
  ): Promise<SendMessageResult> => {
    telegramSends.push({ chatJid, text });
    return { platformMessageId: `tg-signature-${telegramSends.length}` };
  };

  const dailyGroup = 'signature-debug-daily';
  const dailyChat = 'tg:signature-debug-daily';
  const dailyNow = new Date('2026-04-06T12:00:00.000Z');
  registerMain(dailyGroup, dailyChat);
  analyzeCommunicationMessage({
    channel: 'telegram',
    groupFolder: dailyGroup,
    chatJid: dailyChat,
    text: 'Candace: Can you let me know if dinner still works tonight?',
    now: dailyNow,
  });
  createTask(
    createReminderTask(
      dailyGroup,
      'reply to Candace about dinner',
      '2026-04-06T18:30:00.000Z',
    ),
  );
  const daily = await executeAssistantCapability({
    capabilityId: 'daily.loose_ends',
    context: {
      channel: 'alexa',
      groupFolder: dailyGroup,
      chatJid: dailyChat,
      now: dailyNow,
      selectedWork,
    },
    input: {
      canonicalText: 'what am I forgetting',
    },
  });
  const dailyHandoff = await completeAssistantActionFromAlexa(
    {
      groupFolder: dailyGroup,
      action: 'send_details',
      utterance: 'send me the fuller version',
      conversationSummary:
        daily.conversationSeed?.summaryText || daily.replyText || 'Daily summary',
      priorSubjectData: buildAlexaPriorSubjectData(
        daily.continuationCandidate,
        daily.replyText,
      ),
      now: dailyNow,
    },
    {
      resolveTelegramMainChat: () => ({ chatJid: dailyChat }),
      sendTelegramMessage,
    },
  );

  printBlock('ALEXA DAILY ORIENTATION -> TELEGRAM', [
    `prompt: what am I forgetting`,
    `lead_reply: ${daily.replyText || 'none'}`,
    `next_action: ${extractLabelLine(daily.continuationCandidate?.handoffPayload?.text, 'Next')}`,
    `handoff_status: ${dailyHandoff.handoffResult?.status || 'none'}`,
  ]);

  const openLoopReminder = await completeAssistantActionFromAlexa(
    {
      groupFolder: dailyGroup,
      action: 'create_reminder',
      utterance: 'remind me about that tonight',
      conversationSummary:
        daily.conversationSeed?.summaryText || daily.replyText || 'Open loop',
      priorSubjectData: buildAlexaPriorSubjectData(
        daily.continuationCandidate,
        daily.replyText,
      ),
      now: dailyNow,
    },
    {
      resolveTelegramMainChat: () => ({ chatJid: dailyChat }),
    },
  );

  printBlock('OPEN-LOOPS RECOVERY', [
    `prompt: remind me about that tonight`,
    `reply: ${openLoopReminder.replyText || 'none'}`,
    `still_open: ${
      openLoopReminder.replyText?.match(
        /(?:The open piece is|That still leaves)\s+(.+?)(?:\.|$)/i,
      )?.[1] || 'none'
    }`,
    `task_count: ${getAllTasks().filter((task) => task.group_folder === dailyGroup).length}`,
  ]);

  const candaceGroup = 'signature-debug-candace';
  const candaceChat = 'tg:signature-debug-candace';
  const candaceNow = new Date('2026-04-06T12:15:00.000Z');
  analyzeCommunicationMessage({
    channel: 'telegram',
    groupFolder: candaceGroup,
    chatJid: candaceChat,
    text: 'Candace: Can you let me know if dinner still works tonight?',
    now: candaceNow,
  });
  const candaceOpen = await executeAssistantCapability({
    capabilityId: 'communication.open_loops',
    context: {
      channel: 'telegram',
      groupFolder: candaceGroup,
      chatJid: candaceChat,
      now: candaceNow,
    },
    input: {
      canonicalText: "what's still open with Candace",
    },
  });
  const candaceDraft = await executeAssistantCapability({
    capabilityId: 'communication.draft_reply',
    context: {
      channel: 'telegram',
      groupFolder: candaceGroup,
      chatJid: candaceChat,
      now: candaceNow,
      priorSubjectData: candaceOpen.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'give me a short reply',
    },
  });
  const candaceTrack = await executeAssistantCapability({
    capabilityId: 'communication.manage_tracking',
    context: {
      channel: 'telegram',
      groupFolder: candaceGroup,
      chatJid: candaceChat,
      now: candaceNow,
      priorSubjectData:
        candaceDraft.conversationSeed?.subjectData ||
        candaceOpen.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'save this conversation under the Candace thread',
    },
  });

  printBlock('CANDACE RELATIONSHIP FOLLOW-THROUGH', [
    `prompt: what's still open with Candace`,
    `lead_reply: ${candaceOpen.replyText || 'none'}`,
    `draft: ${candaceDraft.replyText || 'none'}`,
    `tracked: ${candaceTrack.replyText || 'none'}`,
    `still_open: ${extractLabelLine(candaceTrack.replyText, 'Still open')}`,
  ]);

  const missionGroup = 'signature-debug-mission';
  const missionChat = 'tg:signature-debug-mission';
  const missionNow = new Date('2026-04-06T12:30:00.000Z');
  analyzeCommunicationMessage({
    channel: 'telegram',
    groupFolder: missionGroup,
    chatJid: missionChat,
    text: 'Candace: Can you let me know if Friday dinner still works after rehearsal?',
    now: missionNow,
  });
  const mission = await executeAssistantCapability({
    capabilityId: 'missions.propose',
    context: {
      channel: 'telegram',
      groupFolder: missionGroup,
      chatJid: missionChat,
      now: missionNow,
      selectedWork,
    },
    input: {
      canonicalText: 'help me plan Friday dinner with Candace',
    },
  });
  const missionExecute = await executeAssistantCapability({
    capabilityId: 'missions.execute',
    context: {
      channel: 'telegram',
      groupFolder: missionGroup,
      chatJid: missionChat,
      now: missionNow,
      selectedWork,
      priorSubjectData: mission.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'remind me',
    },
  });
  const missionId = mission.conversationSeed?.subjectData?.missionId || 'none';

  printBlock('PLAN TONIGHT / THIS WEEKEND', [
    `prompt: help me plan Friday dinner with Candace`,
    `mission_id: ${missionId}`,
    `plan: ${mission.replyText || 'none'}`,
    `blockers: ${mission.continuationCandidate?.missionBlockersJson || '[]'}`,
    `executed: ${missionExecute.replyText || 'none'}`,
    `still_open: ${extractLabelLine(missionExecute.replyText, 'Still open')}`,
    `linked_reminders: ${getMission(missionId)?.linkedReminderIds.join(', ') || 'none'}`,
  ]);

  const researchGroup = 'signature-debug-research';
  const researchChat = 'tg:signature-debug-research';
  const researchNow = new Date('2026-04-06T12:45:00.000Z');
  registerMain(researchGroup, researchChat);
  createTask(
    createReminderTask(
      researchGroup,
      'decide whether to switch dinner plans',
      '2026-04-06T19:00:00.000Z',
    ),
  );
  const research = await executeAssistantCapability({
    capabilityId: 'research.summarize',
    context: {
      channel: 'alexa',
      groupFolder: researchGroup,
      now: researchNow,
    },
    input: {
      canonicalText: 'Summarize what matters from my current context',
    },
  });
  const researchHandoff = await completeAssistantActionFromAlexa(
    {
      groupFolder: researchGroup,
      action: 'send_details',
      utterance: 'send me the full version',
      conversationSummary:
        research.conversationSeed?.summaryText ||
        research.replyText ||
        'Research summary',
      priorSubjectData: buildAlexaPriorSubjectData(
        research.continuationCandidate,
        research.replyText,
      ),
      now: researchNow,
    },
    {
      resolveTelegramMainChat: () => ({ chatJid: researchChat }),
      sendTelegramMessage,
    },
  );
  const researchSave = await completeAssistantActionFromAlexa(
    {
      groupFolder: researchGroup,
      action: 'save_to_library',
      utterance: 'save this to my library',
      conversationSummary:
        research.conversationSeed?.summaryText ||
        research.replyText ||
        'Research summary',
      priorSubjectData: buildAlexaPriorSubjectData(
        research.continuationCandidate,
        research.replyText,
      ),
      now: researchNow,
    },
    {},
  );

  printBlock('RESEARCH -> SAVEABLE OUTPUT', [
    `prompt: summarize what matters from my current context`,
    `voice_reply: ${research.replyText || 'none'}`,
    `handoff_status: ${researchHandoff.handoffResult?.status || 'none'}`,
    `save_reply: ${researchSave.replyText || 'none'}`,
    `still_open: ${extractLabelLine(researchSave.replyText, 'Still open')}`,
    `library_count: ${listKnowledgeSourcesForGroup(researchGroup).length}`,
  ]);

  const blueGroup = 'signature-debug-bluebubbles';
  const blueChat = 'bb:signature-debug-bluebubbles';
  const blueTelegramChat = 'tg:signature-debug-bluebubbles';
  const blueNow = new Date('2026-04-06T13:00:00.000Z');
  registerMain(blueGroup, blueTelegramChat);
  const blueUnderstand = await executeAssistantCapability({
    capabilityId: 'communication.understand_message',
    context: {
      channel: 'bluebubbles',
      groupFolder: blueGroup,
      chatJid: blueChat,
      now: blueNow,
    },
    input: {
      canonicalText:
        'Summarize this message: Band: can you confirm tonight by 6 if you are in?',
    },
  });
  const blueDraft = await executeAssistantCapability({
    capabilityId: 'communication.draft_reply',
    context: {
      channel: 'bluebubbles',
      groupFolder: blueGroup,
      chatJid: blueChat,
      now: blueNow,
      priorSubjectData: blueUnderstand.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'what should I say back',
    },
  });
  const blueReminder = await executeAssistantCapability({
    capabilityId: 'communication.manage_tracking',
    context: {
      channel: 'bluebubbles',
      groupFolder: blueGroup,
      chatJid: blueChat,
      now: blueNow,
      priorSubjectData:
        blueDraft.conversationSeed?.subjectData ||
        blueUnderstand.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'remind me to reply later tonight',
    },
  });
  const blueHandoff = await deliverCompanionHandoff(
    {
      groupFolder: blueGroup,
      originChannel: 'bluebubbles',
      targetChannel: 'telegram',
      capabilityId: blueDraft.capabilityId,
      voiceSummary: blueDraft.replyText || 'Draft reply',
      payload:
        blueDraft.handoffPayload ||
        blueDraft.continuationCandidate?.handoffPayload || {
          kind: 'message',
          title: 'Draft reply',
          text: blueDraft.replyText || 'Draft reply',
          followupSuggestions: [],
        },
      communicationThreadId:
        blueDraft.continuationCandidate?.communicationThreadId || undefined,
      communicationSubjectIds:
        blueDraft.continuationCandidate?.communicationSubjectIds || [],
      communicationLifeThreadIds:
        blueDraft.continuationCandidate?.communicationLifeThreadIds || [],
      lastCommunicationSummary:
        blueDraft.continuationCandidate?.lastCommunicationSummary || undefined,
      followupSuggestions: blueDraft.continuationCandidate?.followupSuggestions,
    },
    {
      resolveTelegramMainChat: () => ({ chatJid: blueTelegramChat }),
      sendTelegramMessage,
    },
  );

  printBlock('BLUEBUBBLES MESSAGE HELP', [
    `prompt: summarize this message`,
    `summary: ${blueUnderstand.replyText || 'none'}`,
    `draft: ${blueDraft.replyText || 'none'}`,
    `remind_later: ${blueReminder.replyText || 'none'}`,
    `still_open: ${extractLabelLine(blueReminder.replyText, 'Still open')}`,
    `handoff_status: ${blueHandoff.status}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-signature-flows failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
