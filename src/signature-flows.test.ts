import { beforeEach, describe, expect, it, vi } from 'vitest';

import { completeAssistantActionFromAlexa } from './assistant-action-completion.js';
import { continueAssistantCapabilityFromPriorSubjectData } from './assistant-capability-router.js';
import { executeAssistantCapability } from './assistant-capabilities.js';
import { analyzeCommunicationMessage } from './communication-companion.js';
import { deliverCompanionHandoff } from './cross-channel-handoffs.js';
import { buildSignatureFlowText } from './signature-flows.js';
import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getCompanionHandoff,
  getMission,
  listKnowledgeSourcesForGroup,
  setRegisteredGroup,
} from './db.js';
import type {
  CompanionContinuationCandidate,
  ScheduledTask,
  SendMessageResult,
} from './types.js';

const selectedWork = {
  laneLabel: 'Cursor',
  title: 'Ship docs',
  statusLabel: 'Running',
  summary: 'Polish the rollout docs and handoff notes.',
};

function createReminderTask(
  groupFolder: string,
  label: string,
  nextRunIso: string,
): ScheduledTask {
  return {
    id: `task-${label.replace(/\s+/g, '-').toLowerCase()}`,
    group_folder: groupFolder,
    chat_jid: 'tg:signature-main',
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

describe('signature flows', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('does not repeat the lead when the first detail line matches it', () => {
    const text = buildSignatureFlowText({
      lead: 'You have about 1431 minutes of usable breathing room.',
      detailLines: [
        'You have about 1431 minutes of usable breathing room.',
        'Keep Open window in view, but it does not need force right now.',
      ],
      nextAction: 'Keep Open window in view, but it does not need force right now.',
      whyLine: 'It is the strongest combined pressure in view right now.',
    });

    expect(text).toContain('You have about 1431 minutes of usable breathing room.');
    expect(text).toContain(
      'Next: Keep Open window in view, but it does not need force right now.',
    );
    expect(text.match(/usable breathing room\./gi)).toHaveLength(1);
  });

  it('keeps Alexa daily orientation and Telegram follow-through in one flow', async () => {
    const groupFolder = 'signature-daily';
    const chatJid = 'tg:signature-daily';
    const now = new Date('2026-04-06T12:00:00.000Z');
    registerMain(groupFolder, chatJid);

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder,
      chatJid,
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now,
    });
    createTask(
      createReminderTask(
        groupFolder,
        'reply to Candace about dinner',
        '2026-04-06T18:30:00.000Z',
      ),
    );

    const daily = await executeAssistantCapability({
      capabilityId: 'daily.loose_ends',
      context: {
        channel: 'alexa',
        groupFolder,
        chatJid,
        now,
        selectedWork,
      },
      input: {
        canonicalText: 'what am I forgetting',
      },
    });

    expect(daily.handled).toBe(true);
    expect(daily.continuationCandidate?.handoffPayload?.text).toContain('Next:');
    expect(daily.continuationCandidate?.handoffPayload?.text).toContain(
      'Why this came up:',
    );
    expect(daily.continuationCandidate?.handoffPayload?.text).not.toContain(
      'Conversation carryover:',
    );

    const sendTelegramMessage = vi.fn(
      async (_targetChatJid: string, _text: string): Promise<SendMessageResult> => ({
        platformMessageId: 'tg-signature-daily-1',
      }),
    );

    const handoff = await completeAssistantActionFromAlexa(
      {
        groupFolder,
        action: 'send_details',
        utterance: 'send me the fuller version',
        conversationSummary:
          daily.conversationSeed?.summaryText || daily.replyText || 'Daily summary',
        priorSubjectData: buildAlexaPriorSubjectData(
          daily.continuationCandidate,
          daily.replyText,
        ),
        now,
      },
      {
        resolveTelegramMainChat: () => ({ chatJid }),
        sendTelegramMessage,
      },
    );

    expect(handoff.handled).toBe(true);
    expect(handoff.replyText).toContain('Telegram');
    expect(handoff.handoffResult?.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      chatJid,
      expect.stringContaining('Why this came up:'),
    );
  });

  it('turns one open loop into a bounded reminder without losing continuity', async () => {
    const groupFolder = 'signature-open-loop';
    const chatJid = 'tg:signature-open-loop';
    const now = new Date('2026-04-06T12:00:00.000Z');
    registerMain(groupFolder, chatJid);
    createTask(
      createReminderTask(
        groupFolder,
        'call Candace',
        '2026-04-06T22:30:00.000Z',
      ),
    );
    const beforeTaskCount = getAllTasks().filter(
      (task) => task.group_folder === groupFolder,
    ).length;

    const daily = await executeAssistantCapability({
      capabilityId: 'daily.loose_ends',
      context: {
        channel: 'alexa',
        groupFolder,
        chatJid,
        now,
      },
      input: {
        canonicalText: 'what am I forgetting',
      },
    });

    const reminder = await completeAssistantActionFromAlexa(
      {
        groupFolder,
        action: 'create_reminder',
        utterance: 'remind me about that tonight',
        conversationSummary:
          daily.conversationSeed?.summaryText || daily.replyText || 'Open loop',
        priorSubjectData: buildAlexaPriorSubjectData(
          daily.continuationCandidate,
          daily.replyText,
        ),
        now,
      },
      {
        resolveTelegramMainChat: () => ({ chatJid }),
      },
    );

    expect(reminder.handled).toBe(true);
    expect(reminder.replyText).toContain('call Candace');
    expect(reminder.replyText).not.toContain(
      'Keep Candace conversation moving',
    );
    expect(
      getAllTasks().filter((task) => task.group_folder === groupFolder).length,
    ).toBeGreaterThan(beforeTaskCount);
  });

  it('carries the Candace flow from open loop to draft to thread save', async () => {
    const groupFolder = 'signature-candace';
    const chatJid = 'tg:signature-candace';
    const now = new Date('2026-04-06T12:00:00.000Z');

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder,
      chatJid,
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now,
    });

    const openLoops = await executeAssistantCapability({
      capabilityId: 'communication.open_loops',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
      },
      input: {
        canonicalText: "what's still open with Candace",
      },
    });

    expect(openLoops.handled).toBe(true);
    expect((openLoops.replyText || '').toLowerCase()).toContain('candace');

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        priorSubjectData: openLoops.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'give me a short reply',
      },
    });

    expect(draft.handled).toBe(true);
    expect(draft.replyText).toContain('Draft:');
    expect(draft.replyText).toContain('whether dinner still works tonight');
    expect(draft.continuationCandidate?.communicationThreadId).toBe(
      openLoops.continuationCandidate?.communicationThreadId,
    );

    const tracked = await executeAssistantCapability({
      capabilityId: 'communication.manage_tracking',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        priorSubjectData:
          draft.conversationSeed?.subjectData || openLoops.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'save this conversation under the Candace thread',
      },
    });

    expect(tracked.handled).toBe(true);
    expect(tracked.replyText).toContain('Candace thread');
    expect(tracked.replyText).toContain('Still open:');
  });

  it('moves from mission proposal to blocker read to confirmed action', async () => {
    const groupFolder = 'signature-mission';
    const chatJid = 'tg:signature-mission';
    const now = new Date('2026-04-06T12:00:00.000Z');

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder,
      chatJid,
      text: 'Candace: Can you let me know if Friday dinner still works after rehearsal?',
      now,
    });

    const proposed = await executeAssistantCapability({
      capabilityId: 'missions.propose',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        selectedWork,
      },
      input: {
        canonicalText: 'help me plan Friday dinner with Candace',
      },
    });

    const missionId = proposed.conversationSeed?.subjectData?.missionId;
    expect(missionId).toBeTruthy();
    expect(
      JSON.parse(proposed.continuationCandidate?.missionBlockersJson || '[]')
        .length,
    ).toBeGreaterThan(0);

    const executed = await executeAssistantCapability({
      capabilityId: 'missions.execute',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        selectedWork,
        priorSubjectData: proposed.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'remind me',
      },
    });

    expect(executed.handled).toBe(true);
    expect(executed.replyText).toContain('Still open:');
    expect(executed.replyText).toContain('check in with Candace');
    expect(getMission(missionId!)?.linkedReminderIds.length || 0).toBeGreaterThan(
      0,
    );
  });

  it('keeps plain mission follow-ups on the same mission in direct chat', async () => {
    const groupFolder = 'signature-mission-continue';
    const chatJid = 'tg:signature-mission-continue';
    const now = new Date('2026-04-06T12:00:00.000Z');

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder,
      chatJid,
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now,
    });

    const openLoops = await executeAssistantCapability({
      capabilityId: 'communication.open_loops',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
      },
      input: {
        canonicalText: "what's still open with Candace",
      },
    });

    const proposed = await executeAssistantCapability({
      capabilityId: 'missions.propose',
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        priorSubjectData: openLoops.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'help me plan tonight',
      },
    });

    const nextStepMatch = continueAssistantCapabilityFromPriorSubjectData(
      "what's the next step",
      proposed.conversationSeed?.subjectData,
    );
    expect(nextStepMatch).toMatchObject({
      capabilityId: 'missions.view',
      continuation: true,
    });

    const nextStep = await executeAssistantCapability({
      capabilityId: nextStepMatch!.capabilityId,
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        priorSubjectData: proposed.conversationSeed?.subjectData,
      },
      input: {
        text: "what's the next step",
        canonicalText: nextStepMatch!.canonicalText,
      },
    });

    expect(nextStep.handled).toBe(true);
    expect(nextStep.replyText).toContain('Next:');
    expect(nextStep.replyText).toContain('Candace');
    expect(nextStep.replyText).not.toContain('Research Summary');

    const blockerMatch = continueAssistantCapabilityFromPriorSubjectData(
      "what's blocking this",
      nextStep.conversationSeed?.subjectData || proposed.conversationSeed?.subjectData,
    );
    expect(blockerMatch).toMatchObject({
      capabilityId: 'missions.explain',
      continuation: true,
    });

    const blocker = await executeAssistantCapability({
      capabilityId: blockerMatch!.capabilityId,
      context: {
        channel: 'telegram',
        groupFolder,
        chatJid,
        now,
        priorSubjectData:
          nextStep.conversationSeed?.subjectData ||
          proposed.conversationSeed?.subjectData,
      },
      input: {
        text: "what's blocking this",
        canonicalText: blockerMatch!.canonicalText,
      },
    });

    expect(blocker.handled).toBe(true);
    expect(blocker.replyText).toContain('The main blocker right now is this:');
    expect(blocker.replyText).toContain('Candace');
    expect(blocker.replyText).not.toContain('Research Summary');
  });

  it('keeps research, richer detail, and library save on the same chain', async () => {
    const groupFolder = 'signature-research';
    const chatJid = 'tg:signature-research';
    const now = new Date('2026-04-06T12:00:00.000Z');
    registerMain(groupFolder, chatJid);

    createTask(
      createReminderTask(
        groupFolder,
        'decide whether to switch dinner plans',
        '2026-04-06T19:00:00.000Z',
      ),
    );

    const research = await executeAssistantCapability({
      capabilityId: 'research.summarize',
      context: {
        channel: 'alexa',
        groupFolder,
        now,
      },
      input: {
        canonicalText: 'Summarize what matters from my current context',
      },
    });

    expect(research.handled).toBe(true);
    expect(research.replyText).toContain('Want');

    const sendTelegramMessage = vi.fn(
      async (_targetChatJid: string, _text: string): Promise<SendMessageResult> => ({
        platformMessageId: 'tg-signature-research-1',
      }),
    );

    const handoff = await completeAssistantActionFromAlexa(
      {
        groupFolder,
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
        now,
      },
      {
        resolveTelegramMainChat: () => ({ chatJid }),
        sendTelegramMessage,
      },
    );

    const save = await completeAssistantActionFromAlexa(
      {
        groupFolder,
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
        now,
      },
      {},
    );

    expect(handoff.handoffResult?.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      chatJid,
      expect.stringContaining('Next:'),
    );
    expect(save.replyText).toContain('Saved');
    expect(save.replyText).not.toContain('The open piece is');
    expect(listKnowledgeSourcesForGroup(groupFolder).length).toBeGreaterThan(0);
  });

  it('handles the BlueBubbles message-help journey and Telegram escalation', async () => {
    const groupFolder = 'signature-bluebubbles';
    const bbChatJid = 'bb:signature-bluebubbles';
    const tgChatJid = 'tg:signature-bluebubbles';
    const now = new Date('2026-04-06T12:00:00.000Z');
    registerMain(groupFolder, tgChatJid);

    const understand = await executeAssistantCapability({
      capabilityId: 'communication.understand_message',
      context: {
        channel: 'bluebubbles',
        groupFolder,
        chatJid: bbChatJid,
        now,
      },
      input: {
        canonicalText:
          'Summarize this message: Band: can you confirm tonight by 6 if you are in?',
      },
    });

    const draft = await executeAssistantCapability({
      capabilityId: 'communication.draft_reply',
      context: {
        channel: 'bluebubbles',
        groupFolder,
        chatJid: bbChatJid,
        now,
        priorSubjectData: understand.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'what should I say back',
      },
    });

    const reminder = await executeAssistantCapability({
      capabilityId: 'communication.manage_tracking',
      context: {
        channel: 'bluebubbles',
        groupFolder,
        chatJid: bbChatJid,
        now,
        priorSubjectData:
          draft.conversationSeed?.subjectData || understand.conversationSeed?.subjectData,
      },
      input: {
        canonicalText: 'remind me to reply later tonight',
      },
    });

    const sendTelegramMessage = vi.fn(
      async (_targetChatJid: string, _text: string): Promise<SendMessageResult> => ({
        platformMessageId: 'tg-signature-bluebubbles-1',
      }),
    );

    const handoff = await deliverCompanionHandoff(
      {
        groupFolder,
        originChannel: 'bluebubbles',
        targetChannel: 'telegram',
        capabilityId: draft.capabilityId,
        voiceSummary: draft.replyText || 'Draft reply',
        payload:
          draft.handoffPayload ||
          draft.continuationCandidate?.handoffPayload || {
            kind: 'message',
            title: 'Draft reply',
            text: draft.replyText || 'Draft reply',
            followupSuggestions: [],
          },
        communicationThreadId:
          draft.continuationCandidate?.communicationThreadId || undefined,
        communicationSubjectIds:
          draft.continuationCandidate?.communicationSubjectIds || [],
        communicationLifeThreadIds:
          draft.continuationCandidate?.communicationLifeThreadIds || [],
        lastCommunicationSummary:
          draft.continuationCandidate?.lastCommunicationSummary || undefined,
        followupSuggestions: draft.continuationCandidate?.followupSuggestions,
      },
      {
        resolveTelegramMainChat: () => ({ chatJid: tgChatJid }),
        sendTelegramMessage,
      },
    );

    expect(understand.handled).toBe(true);
    expect(draft.replyText).toContain('Draft:');
    expect(reminder.replyText).toContain('Still open:');
    expect(handoff.ok).toBe(true);
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      tgChatJid,
      expect.stringContaining('Next:'),
    );

    const record = getCompanionHandoff(handoff.handoffId);
    expect(record?.originChannel).toBe('bluebubbles');
    expect(record?.communicationThreadId).toBeTruthy();
  });
});
