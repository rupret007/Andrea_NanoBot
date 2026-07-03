import type { CalendarLookupSnapshot } from '../src/calendar-assistant.js';
import { buildChiefOfStaffTurn } from '../src/chief-of-staff.js';
import { analyzeCommunicationMessage } from '../src/communication-companion.js';
import {
  buildCurrentFocusSnapshot,
  type GroundedDaySnapshot,
  type UpcomingReminderSummary,
} from '../src/daily-command-center.js';
import { _initTestDatabase, createTask } from '../src/db.js';
import { handleLifeThreadCommand } from '../src/life-threads.js';

function printBlock(title: string, lines: string[]): void {
  process.stdout.write(`${title}\n`);
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }
  process.stdout.write('\n');
}

function buildFixtureGroundedSnapshot(
  now: Date,
  selectedWork: GroundedDaySnapshot['selectedWork'],
): GroundedDaySnapshot {
  const nextEvent = {
    id: 'fixture-dinner',
    providerId: 'fixture' as const,
    providerLabel: 'Fixture',
    title: 'Dinner planning',
    startIso: '2026-04-06T18:00:00.000Z',
    endIso: '2026-04-06T19:00:00.000Z',
    allDay: false,
    calendarId: 'fixture',
    calendarName: 'Fixture',
  };
  const openWindow = {
    start: new Date('2026-04-06T15:00:00.000Z'),
    end: new Date('2026-04-06T17:30:00.000Z'),
  };
  const calendar: CalendarLookupSnapshot = {
    unavailableReply: null,
    fullyConfirmed: true,
    incompleteNoteBody: '',
    timedEvents: [nextEvent],
    allDayEvents: [],
    nextTimedEvent: nextEvent,
    activeAllDayEvents: [],
    openWindows: [openWindow],
    conflictGroups: [],
    adjacencyClusters: [],
    densityLine: 'Fixture calendar has one anchor and one open window.',
  };
  const reminders: UpcomingReminderSummary[] = [
    {
      id: 'chief-reminder',
      label: 'Reply to Candace about dinner tonight',
      nextRunIso: '2026-04-06T19:00:00.000Z',
    },
    {
      id: 'chief-band-reminder',
      label: 'Bring the band set list before rehearsal',
      nextRunIso: '2026-04-06T22:00:00.000Z',
    },
  ];
  const todayReminders = reminders;
  const meaningfulOpenWindows = [openWindow];
  return {
    now,
    timeZone: 'America/Chicago',
    calendar,
    selectedWork,
    reminders,
    todayReminders,
    meaningfulOpenWindows,
    currentFocus: buildCurrentFocusSnapshot({
      now,
      nextReminder: reminders[0] || null,
      nextEvent,
      nextMeaningfulOpenWindow: openWindow,
      selectedWork,
    }),
  };
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

  const selectedWork = {
    laneLabel: 'Cursor',
    title: 'Ship release notes',
    statusLabel: 'Running',
    summary: 'Tighten the release note draft and prep the handoff blurb.',
  };
  const context = {
    groupFolder,
    chatJid,
    now,
    selectedWork,
    groundedSnapshot: buildFixtureGroundedSnapshot(now, selectedWork),
  } as const;

  const matters = await buildChiefOfStaffTurn({
    channel: 'telegram',
    ...context,
    text: 'what matters most today',
    mode: 'prioritize',
  });

  const forgetting = await buildChiefOfStaffTurn({
    channel: 'telegram',
    ...context,
    text: 'what am I forgetting',
    mode: 'prioritize',
  });

  const tonight = await buildChiefOfStaffTurn({
    channel: 'alexa',
    ...context,
    text: 'what should I remember tonight',
    mode: 'plan_horizon',
  });

  const candace = await buildChiefOfStaffTurn({
    channel: 'telegram',
    ...context,
    text: "what's still open with Candace",
    mode: 'prioritize',
  });

  const nextMove = await buildChiefOfStaffTurn({
    channel: 'alexa',
    ...context,
    text: 'what should I do next',
    mode: 'prioritize',
  });

  const explain = await buildChiefOfStaffTurn({
    channel: 'telegram',
    ...context,
    text: 'why are you bringing that up',
    mode: 'explain',
    priorChiefOfStaffContextJson: JSON.stringify(matters.context),
  });

  printBlock('WHAT MATTERS TODAY', [
    'handled: true',
    `reply: ${matters.replyText || 'none'}`,
    `signals: ${matters.snapshot.signalsUsed.join(', ') || 'none'}`,
  ]);

  printBlock('WHAT AM I FORGETTING', [
    'handled: true',
    `reply: ${forgetting.replyText || 'none'}`,
    `signals: ${forgetting.snapshot.signalsUsed.join(', ') || 'none'}`,
  ]);

  printBlock('WHAT SHOULD I REMEMBER TONIGHT', [
    'handled: true',
    `reply: ${tonight.replyText || 'none'}`,
  ]);

  printBlock("WHAT'S STILL OPEN WITH CANDACE", [
    'handled: true',
    `reply: ${candace.replyText || 'none'}`,
  ]);

  printBlock('WHAT SHOULD I DO NEXT', [
    'handled: true',
    `reply: ${nextMove.replyText || 'none'}`,
  ]);

  printBlock('WHY ARE YOU BRINGING THAT UP', [
    'handled: true',
    `reply: ${explain.replyText || 'none'}`,
    `chief_of_staff_context: ${explain.context ? 'present' : 'missing'}`,
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
