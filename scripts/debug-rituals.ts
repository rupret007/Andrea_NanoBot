import { executeAssistantCapability } from '../src/assistant-capabilities.js';
import { buildDailyCompanionResponse } from '../src/daily-companion.js';
import { createTask, getTaskById, initDatabase } from '../src/db.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  initDatabase();
  const groupFolder = 'ritual-debug';
  const chatJid = 'tg:ritual-debug';

  createTask({
    id: 'ritual-debug-reminder',
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: 'Send a concise reminder telling the user to confirm the dinner timing.',
    script: null,
    schedule_type: 'once',
    schedule_value: '2026-04-05T23:30:00.000Z',
    context_mode: 'group',
    next_run: '2026-04-05T23:30:00.000Z',
    status: 'active',
    created_at: '2026-04-05T09:00:00.000Z',
  });

  handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: 'save this under the Candace thread',
    replyText: 'Talk through dinner timing after rehearsal tonight.',
    now: new Date('2026-04-05T08:00:00.000Z'),
  });
  handleLifeThreadCommand({
    groupFolder,
    channel: 'telegram',
    chatJid,
    text: "don't let me forget this band thing tonight",
    replyText: 'Confirm the rehearsal set list before you leave.',
    now: new Date('2026-04-05T08:10:00.000Z'),
  });

  const enabledMorning = await executeAssistantCapability({
    capabilityId: 'rituals.configure',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T08:30:00.000Z'),
    },
    input: {
      canonicalText: 'enable morning brief',
    },
  });
  const enabledEvening = await executeAssistantCapability({
    capabilityId: 'rituals.configure',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T08:31:00.000Z'),
    },
    input: {
      canonicalText: 'enable evening reset',
    },
  });
  const ritualStatus = await executeAssistantCapability({
    capabilityId: 'rituals.status',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T08:32:00.000Z'),
    },
    input: {
      canonicalText: 'what rituals do I have enabled',
    },
  });

  const morningBrief = await executeAssistantCapability({
    capabilityId: 'daily.morning_brief',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T08:45:00.000Z'),
    },
    input: {
      canonicalText: 'good morning',
    },
  });

  const looseEnds = await executeAssistantCapability({
    capabilityId: 'daily.loose_ends',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T20:30:00.000Z'),
    },
    input: {
      canonicalText: 'what am I forgetting',
    },
  });

  const whyThis = await buildDailyCompanionResponse('why are you bringing that up', {
    channel: 'telegram',
    groupFolder,
    tasks: [],
    now: new Date('2026-04-05T20:31:00.000Z'),
    priorContext: looseEnds.dailyResponse?.context || null,
  });

  const alexaEvening = await executeAssistantCapability({
    capabilityId: 'daily.evening_reset',
    context: {
      channel: 'alexa',
      groupFolder,
      now: new Date('2026-04-05T20:32:00.000Z'),
    },
    input: {
      canonicalText: 'what should I remember tonight',
    },
  });

  const alexaCandace = await executeAssistantCapability({
    capabilityId: 'household.candace_upcoming',
    context: {
      channel: 'alexa',
      groupFolder,
      now: new Date('2026-04-05T20:33:00.000Z'),
    },
    input: {
      canonicalText: "what's still open with Candace",
      personName: 'Candace',
    },
  });

  const shorter = await executeAssistantCapability({
    capabilityId: 'rituals.configure',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T20:34:00.000Z'),
    },
    input: {
      canonicalText: 'make the morning brief shorter',
    },
  });
  const familyOff = await executeAssistantCapability({
    capabilityId: 'rituals.configure',
    context: {
      channel: 'telegram',
      groupFolder,
      chatJid,
      now: new Date('2026-04-05T20:35:00.000Z'),
    },
    input: {
      canonicalText: 'stop surfacing family context automatically',
    },
  });

  const morningTask = getTaskById(`${groupFolder}:ritual-task:morning_brief`);
  const eveningTask = getTaskById(`${groupFolder}:ritual-task:evening_reset`);

  printBlock('RITUAL SCHEDULE', [
    `enable_morning: ${enabledMorning.replyText || 'none'}`,
    `enable_evening: ${enabledEvening.replyText || 'none'}`,
    `morning_task_status: ${morningTask?.status || 'missing'}`,
    `morning_task_next_run: ${morningTask?.next_run || 'missing'}`,
    `evening_task_status: ${eveningTask?.status || 'missing'}`,
    `evening_task_next_run: ${eveningTask?.next_run || 'missing'}`,
  ]);

  printBlock('TELEGRAM RITUAL STATUS', [
    `handled: ${ritualStatus.handled}`,
    `reply: ${ritualStatus.replyText || 'none'}`,
  ]);

  printBlock('TELEGRAM MORNING BRIEF', [
    `handled: ${morningBrief.handled}`,
    `reply: ${morningBrief.replyText || 'none'}`,
    `source: ${morningBrief.trace?.responseSource || 'none'}`,
  ]);

  printBlock('TELEGRAM LOOSE ENDS', [
    `handled: ${looseEnds.handled}`,
    `reply: ${looseEnds.replyText || 'none'}`,
    `source: ${looseEnds.trace?.responseSource || 'none'}`,
  ]);

  printBlock('WHY THIS SURFACED', [`reply: ${whyThis?.reply || 'none'}`]);

  printBlock('ALEXA EVENING RESET', [
    `handled: ${alexaEvening.handled}`,
    `reply: ${alexaEvening.replyText || 'none'}`,
    `shape: ${alexaEvening.outputShape || 'none'}`,
  ]);

  printBlock('ALEXA CANDACE FOLLOW-THROUGH', [
    `handled: ${alexaCandace.handled}`,
    `reply: ${alexaCandace.replyText || 'none'}`,
    `shape: ${alexaCandace.outputShape || 'none'}`,
  ]);

  printBlock('CONTROL TURNS', [
    `shorter: ${shorter.replyText || 'none'}`,
    `family_off: ${familyOff.replyText || 'none'}`,
  ]);
}

main().catch((error) => {
  process.stderr.write(
    `debug-rituals failed: ${
      error instanceof Error ? error.stack || error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
