import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { analyzeCommunicationMessage } from '../src/communication-companion.js';
import { _initTestDatabase, createTask } from '../src/db.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  _initTestDatabase();
  const groupFolder = 'chief-of-staff-debug';
  const chatJid = 'tg:chief-of-staff-debug';
  const now = new Date('2026-04-06T09:00:00.000Z');

  createTask({
    id: 'chief-reminder',
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: 'Reply to Candace about dinner tonight',
    schedule_type: 'once',
    schedule_value: '2026-04-06T19:00:00.000Z',
    context_mode: 'group',
    next_run: '2026-04-06T19:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-06T08:30:00.000Z',
  });
  createTask({
    id: 'chief-band-reminder',
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: 'Bring the band set list before rehearsal',
    schedule_type: 'once',
    schedule_value: '2026-04-06T22:00:00.000Z',
    context_mode: 'group',
    next_run: '2026-04-06T22:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-06T08:35:00.000Z',
  });

  handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: 'save this under the Candace thread',
    replyText: 'Dinner timing still needs a clear answer tonight.',
    now,
  });

  analyzeCommunicationMessage({
    channel: 'bluebubbles',
    groupFolder,
    chatJid: 'bb:chief-of-staff-debug',
    text: 'Candace: can you let me know if dinner still works tonight, and whether pickup is easier after rehearsal?',
    now,
  });

  const context = {
    groupFolder,
    chatJid,
    now,
    selectedWork: {
      laneLabel: 'Cursor',
      title: 'Ship release notes',
      statusLabel: 'Running',
      summary: 'Tighten the release note draft and prep the handoff blurb.',
    },
  } as const;

  const matters = await executeAssistantCapability({
    capabilityId: 'staff.prioritize',
    context: {
      channel: 'telegram',
      ...context,
    },
    input: {
      canonicalText: 'what matters most today',
    },
  });

  const forgetting = await executeAssistantCapability({
    capabilityId: 'daily.loose_ends',
    context: {
      channel: 'telegram',
      ...context,
    },
    input: {
      canonicalText: 'what am I forgetting',
    },
  });

  const tonight = await executeAssistantCapability({
    capabilityId: 'daily.evening_reset',
    context: {
      channel: 'alexa',
      ...context,
    },
    input: {
      canonicalText: 'what should I remember tonight',
    },
  });

  const candace = await executeAssistantCapability({
    capabilityId: 'household.candace_upcoming',
    context: {
      channel: 'telegram',
      ...context,
    },
    input: {
      canonicalText: "what's still open with Candace",
    },
  });

  const nextMove = await executeAssistantCapability({
    capabilityId: 'staff.prioritize',
    context: {
      channel: 'alexa',
      ...context,
    },
    input: {
      canonicalText: 'what should I do next',
    },
  });

  const explain = await executeAssistantCapability({
    capabilityId: 'staff.explain',
    context: {
      channel: 'telegram',
      ...context,
      priorSubjectData: matters.conversationSeed?.subjectData,
    },
    input: {
      canonicalText: 'why are you bringing that up',
    },
  });

  printBlock('WHAT MATTERS TODAY', [
    `handled: ${matters.handled}`,
    `reply: ${matters.replyText || 'none'}`,
    `signals: ${
      matters.continuationCandidate?.chiefOfStaffContextJson
        ? JSON.parse(matters.continuationCandidate.chiefOfStaffContextJson).snapshot.signalsUsed.join(', ')
        : 'none'
    }`,
  ]);

  printBlock('WHAT AM I FORGETTING', [
    `handled: ${forgetting.handled}`,
    `reply: ${forgetting.replyText || 'none'}`,
    `signals: ${forgetting.dailyResponse?.context.signalsUsed.join(', ') || 'none'}`,
  ]);

  printBlock('WHAT SHOULD I REMEMBER TONIGHT', [
    `handled: ${tonight.handled}`,
    `reply: ${tonight.replyText || 'none'}`,
  ]);

  printBlock("WHAT'S STILL OPEN WITH CANDACE", [
    `handled: ${candace.handled}`,
    `reply: ${candace.replyText || 'none'}`,
  ]);

  printBlock('WHAT SHOULD I DO NEXT', [
    `handled: ${nextMove.handled}`,
    `reply: ${nextMove.replyText || 'none'}`,
  ]);

  printBlock('WHY ARE YOU BRINGING THAT UP', [
    `handled: ${explain.handled}`,
    `reply: ${explain.replyText || 'none'}`,
    `chief_of_staff_context: ${
      explain.conversationSeed?.subjectData?.chiefOfStaffContextJson ? 'present' : 'missing'
    }`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-chief-of-staff failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
