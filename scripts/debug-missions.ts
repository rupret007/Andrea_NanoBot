import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { analyzeCommunicationMessage } from '../src/communication-companion.js';
import { _initTestDatabase, getMission } from '../src/db.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';
import { deliverCompanionHandoff } from '../src/cross-channel-handoffs.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  _initTestDatabase();
  const groupFolder = 'missions-debug';
  const chatJid = 'tg:missions-debug';
  const now = new Date('2026-04-06T17:00:00.000Z');

  analyzeCommunicationMessage({
    channel: 'bluebubbles',
    groupFolder,
    chatJid: 'bb:missions-debug',
    text: 'Candace: can you let me know if Friday dinner still works after rehearsal?',
    now,
  });

  handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: 'save this under the Candace thread',
    replyText: 'Friday dinner timing is still open.',
    now,
  });

  const proposed = await executeAssistantCapability({
    capabilityId: 'missions.propose',
    context: {
      channel: 'alexa',
      groupFolder,
      chatJid,
      now,
      selectedWork: {
        laneLabel: 'Cursor',
        title: 'Ship release notes',
        statusLabel: 'Running',
        summary: 'Finish the release note draft and prep the handoff blurb.',
      },
    },
    input: {
      canonicalText: 'help me plan Friday dinner with Candace',
    },
  });

  const missionId =
    proposed.conversationSeed?.subjectData?.missionId || 'missing';
  const stored = missionId !== 'missing' ? getMission(missionId) : null;

  const executed = await executeAssistantCapability({
    capabilityId: 'missions.execute',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now,
      selectedWork: {
        laneLabel: 'Cursor',
        title: 'Ship release notes',
        statusLabel: 'Running',
        summary: 'Finish the release note draft and prep the handoff blurb.',
      },
      priorSubjectData: proposed.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'remind me',
    },
  });

  const handoff = await deliverCompanionHandoff(
    {
      groupFolder,
      originChannel: 'alexa',
      capabilityId: proposed.capabilityId,
      voiceSummary:
        proposed.continuationCandidate?.voiceSummary ||
        proposed.replyText ||
        'Mission summary',
      payload: proposed.continuationCandidate?.handoffPayload || {
        kind: 'message',
        title: 'Mission plan',
        text: proposed.replyText || 'Mission summary',
        followupSuggestions: [],
      },
      missionId: proposed.continuationCandidate?.missionId,
      missionSummary: proposed.continuationCandidate?.missionSummary,
      missionSuggestedActionsJson:
        proposed.continuationCandidate?.missionSuggestedActionsJson,
      missionBlockersJson: proposed.continuationCandidate?.missionBlockersJson,
      missionStepFocusJson:
        proposed.continuationCandidate?.missionStepFocusJson,
      followupSuggestions: proposed.continuationCandidate?.followupSuggestions,
    },
    {
      resolveTelegramMainChat: () => ({ chatJid }),
      sendTelegramMessage: async () => ({ platformMessageId: 'tg-mission-1' }),
    },
  );

  printBlock('MISSION CREATION', [
    `handled: ${proposed.handled}`,
    `mission_id: ${missionId}`,
    `status: ${stored?.status || 'missing'}`,
    `summary: ${proposed.replyText || 'none'}`,
  ]);

  printBlock('MISSION BLOCKERS', [
    `blockers: ${proposed.continuationCandidate?.missionBlockersJson || '[]'}`,
    `suggested_actions: ${
      proposed.continuationCandidate?.missionSuggestedActionsJson || '[]'
    }`,
  ]);

  printBlock('CONFIRMED EXECUTION', [
    `handled: ${executed.handled}`,
    `reply: ${executed.replyText || 'none'}`,
    `linked_reminders: ${getMission(missionId)?.linkedReminderIds.join(', ') || 'none'}`,
  ]);

  printBlock('PLAN HANDOFF', [
    `ok: ${handoff.ok}`,
    `status: ${handoff.status}`,
    `target: ${handoff.targetChatJid || 'none'}`,
    `speech: ${handoff.speech}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-missions failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
