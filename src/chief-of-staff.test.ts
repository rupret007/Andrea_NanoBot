import { beforeEach, describe, expect, it } from 'vitest';

import { buildChiefOfStaffTurn } from './chief-of-staff.js';
import { analyzeCommunicationMessage } from './communication-companion.js';
import { _initTestDatabase, createTask } from './db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from './life-threads.js';
import type {
  GroundedDaySnapshot,
  SelectedWorkContext,
  UpcomingReminderSummary,
} from './daily-command-center.js';
import type { LifeThreadSnapshot, ScheduledTask } from './types.js';

const selectedWork: SelectedWorkContext = {
  laneLabel: 'Cursor',
  title: 'Ship rollout notes',
  statusLabel: 'Running',
  summary: 'Finish the release summary and check handoff notes.',
};

function createReminder(
  label: string,
  nextRunIso: string,
): UpcomingReminderSummary {
  return {
    id: `reminder-${label.replace(/\s+/g, '-').toLowerCase()}`,
    label,
    nextRunIso,
  };
}

function createGroundedSnapshot(
  now: Date,
  reminder?: UpcomingReminderSummary,
): GroundedDaySnapshot {
  return {
    now,
    timeZone: 'America/Chicago',
    calendar: {
      unavailableReply: null,
      fullyConfirmed: true,
      incompleteNoteBody: '',
      timedEvents: [],
      allDayEvents: [],
      nextTimedEvent: null,
      activeAllDayEvents: [],
      openWindows: [],
      conflictGroups: [],
      adjacencyClusters: [],
      densityLine: null,
    },
    selectedWork,
    reminders: reminder ? [reminder] : [],
    todayReminders: reminder ? [reminder] : [],
    meaningfulOpenWindows: [],
    currentFocus: {
      reason: reminder ? 'reminder_due_soon' : 'selected_work',
      selectedWork,
      nextEvent: null,
      nextReminder: reminder || null,
      nextMeaningfulOpenWindow: null,
    },
  };
}

function createLifeThreadSnapshot(): LifeThreadSnapshot {
  return {
    activeThreads: [],
    dueFollowups: [],
    slippingThreads: [],
    householdCarryover: null,
    recommendedNextThread: null,
  };
}

function createTaskRecord(
  id: string,
  prompt: string,
  nextRun: string,
): ScheduledTask {
  return {
    id,
    group_folder: 'main',
    chat_jid: 'tg:chief-of-staff',
    prompt,
    script: null,
    schedule_type: 'once',
    schedule_value: nextRun,
    context_mode: 'group',
    next_run: nextRun,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-06T09:00:00.000Z',
  };
}

beforeEach(() => {
  _initTestDatabase();
});

describe('chief-of-staff', () => {
  it('prioritizes open commitments without collapsing urgency and importance together', async () => {
    const now = new Date('2026-04-06T17:00:00.000Z');
    const reminder = createReminder(
      'reply to Candace about dinner',
      '2026-04-06T18:00:00.000Z',
    );
    const groundedSnapshot = createGroundedSnapshot(now, reminder);
    const lifeThreadSnapshot = createLifeThreadSnapshot();

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:chief-of-staff',
      text: 'Candace: can you let me know if dinner still works tonight?',
      now,
    });

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters most today',
      mode: 'prioritize',
      now,
      tasks: [
        createTaskRecord(
          'task-candace',
          'Reply to Candace about dinner',
          reminder.nextRunIso,
        ),
      ],
      selectedWork,
      groundedSnapshot,
      lifeThreadSnapshot,
    });

    expect(result.snapshot.mainSignal?.title).toBeTruthy();
    expect(result.snapshot.signalsUsed).toEqual(
      expect.arrayContaining([
        'reminders',
        'communication_threads',
        'current_work',
      ]),
    );
    expect(result.snapshot.mainSignal?.urgency).toBeDefined();
    expect(result.snapshot.mainSignal?.importance).toBeDefined();
    expect(result.summaryText.length).toBeGreaterThan(10);
    expect(result.context.generatedAt).toBeTruthy();
  });

  it('gives a practical tonight-versus-tomorrow read when there is real pressure', async () => {
    const now = new Date('2026-04-06T22:00:00.000Z');
    const reminder = createReminder(
      'send the dinner answer',
      '2026-04-06T22:30:00.000Z',
    );

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'should I handle this tonight or tomorrow',
      mode: 'decision_support',
      now,
      tasks: [
        createTaskRecord(
          'task-tonight',
          'Send the dinner answer',
          reminder.nextRunIso,
        ),
      ],
      selectedWork,
      groundedSnapshot: createGroundedSnapshot(now, reminder),
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.summaryText.toLowerCase()).toContain('tonight');
  });

  it('persists and resets chief-of-staff preference controls', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const baseSnapshot = createGroundedSnapshot(now);
    const lifeThreadSnapshot = createLifeThreadSnapshot();

    const configured = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'be less aggressive about surfacing family stuff',
      mode: 'configure',
      now,
      groundedSnapshot: baseSnapshot,
      lifeThreadSnapshot,
    });
    expect(configured.summaryText).toContain('family context lighter');

    const followup = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters most today',
      mode: 'prioritize',
      now,
      groundedSnapshot: baseSnapshot,
      lifeThreadSnapshot,
    });
    expect(followup.context.preferences.familyAggressiveness).toBe('lighter');

    const reset = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'reset my planning preferences',
      mode: 'configure',
      now,
      groundedSnapshot: baseSnapshot,
      lifeThreadSnapshot,
    });
    expect(reset.summaryText).toContain('reset your planning preferences');
  });

  it('admits low confidence when the signal set is thin', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters this week',
      mode: 'plan_horizon',
      now,
      groundedSnapshot: createGroundedSnapshot(now),
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.snapshot.confidence).toBe('low');
    expect(result.summaryText.toLowerCase()).toContain('not confident enough');
  });

  it('softens long open-window summaries so they do not read like raw minute counts', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I do next',
      mode: 'prioritize',
      now,
      groundedSnapshot: {
        ...createGroundedSnapshot(now),
        selectedWork: null,
        meaningfulOpenWindows: [
          {
            start: new Date('2026-04-06T18:00:00.000Z'),
            end: new Date('2026-04-06T23:00:00.000Z'),
          },
        ],
      },
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.snapshot.mainSignal?.summaryText).toContain('breathing room');
    expect(result.snapshot.mainSignal?.summaryText).not.toContain(
      '300 minutes',
    );
  });

  it('uses a natural prep summary for before-my-next-meeting guidance', async () => {
    const now = new Date('2026-04-06T17:00:00.000Z');

    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:chief-of-staff',
      text: 'Candace: can you let me know if dinner still works tonight?',
      now,
    });

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters before my next meeting',
      mode: 'prepare',
      now,
      groundedSnapshot: createGroundedSnapshot(now),
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.summaryText).toContain(
      'The main prep move is to be ready to address Candace conversation.',
    );
    expect(result.summaryText).not.toContain('get Be ready');
    expect(result.detailText).not.toContain(
      'You have one conversation that still needs attention.:',
    );
  });

  it('uses thread detail instead of a generic Follow-up title for life-thread signals', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:chief-of-staff',
      text: 'save this for later',
      replyText:
        'The first fixed point in your day is pest control is coming today at 1:00 PM.',
      now: new Date('2026-04-06T10:00:00.000Z'),
    });

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what should I do next',
      mode: 'prioritize',
      now,
      groundedSnapshot: {
        ...createGroundedSnapshot(now),
        selectedWork: null,
        currentFocus: {
          ...createGroundedSnapshot(now).currentFocus,
          selectedWork: null,
          reason: 'schedule_only',
        },
      },
      lifeThreadSnapshot: buildLifeThreadSnapshot({
        groupFolder: 'main',
        now,
      }),
    });

    expect(result.snapshot.mainSignal?.title).toContain('Pest control');
    expect(result.snapshot.mainSignal?.title).not.toBe('Follow-up');
    expect(result.summaryText).not.toContain('Keep Follow-up in view');
  });
});
