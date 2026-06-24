import { beforeEach, describe, expect, it } from 'vitest';

import { buildChiefOfStaffTurn } from './chief-of-staff.js';
import { analyzeCommunicationMessage } from './communication-companion.js';
import {
  upsertLifeThread,
  upsertOperatingProfile,
  upsertProfileFact,
  upsertProfileSubject,
  _initTestDatabase,
} from './db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
} from './life-threads.js';
import { upsertOutcomeRecord } from './outcome-reviews.js';
import type {
  GroundedDaySnapshot,
  SelectedWorkContext,
  UpcomingReminderSummary,
} from './daily-command-center.js';
import type {
  LifeThreadSnapshot,
  OperatingProfilePlan,
  ScheduledTask,
} from './types.js';

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

  it('uses personal context graph coverage as a daily intelligence signal', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const plan: OperatingProfilePlan = {
      summary: 'Andrea should keep family logistics and replies moving.',
      trackedAreas: ['messages'],
      defaultGroups: [],
      routines: ['morning check-in'],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: 'suggest_then_confirm',
    };
    upsertOperatingProfile({
      profileId: 'profile-main',
      groupFolder: 'main',
      status: 'active',
      version: 1,
      basedOnProfileId: null,
      intakeJson: JSON.stringify({
        rawText: 'setup',
        routines: plan.routines,
        trackingPriorities: plan.trackedAreas,
        defaultGroups: [],
        integrationsWanted: ['BlueBubbles'],
        richerSurface: 'telegram',
        scope: 'family',
        notes: [],
      }),
      planJson: JSON.stringify(plan),
      sourceChannel: 'telegram',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      approvedAt: now.toISOString(),
      supersededAt: null,
    });
    upsertProfileSubject({
      id: 'subject-self',
      groupFolder: 'main',
      kind: 'self',
      canonicalName: 'self',
      displayName: 'You',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      disabledAt: null,
    });
    upsertProfileFact({
      id: 'fact-style',
      groupFolder: 'main',
      subjectId: 'subject-self',
      category: 'conversational_style',
      factKey: 'setup.communication_style',
      valueJson: JSON.stringify({
        value: 'Warm and concise.',
        memoryScope: 'user',
        confidence: 0.82,
        freshness: 'current',
        source: 'guided_profile_setup',
      }),
      state: 'accepted',
      sourceChannel: 'telegram',
      sourceSummary: 'Warm and concise.',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      decidedAt: now.toISOString(),
    });

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters most today',
      mode: 'prioritize',
      now,
      groundedSnapshot: createGroundedSnapshot(now),
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.snapshot.signalsUsed).toContain('context_graph');
    expect(result.detailText).toContain('morning check-in');
    expect(result.detailText).toContain('turn this into a reminder');
  });

  it('ranks approved follow-through outcomes above generic context hints', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    upsertOutcomeRecord({
      groupFolder: 'main',
      sourceType: 'followthrough_candidate',
      sourceKey: 'followthrough:school-form',
      status: 'deferred',
      completionSummary: 'Approved local follow-through reminder for #1.',
      nextFollowupText: 'Reminder saved for tonight: check the school form.',
      dueAt: '2026-04-07T01:00:00.000Z',
      linkedRefs: {
        followthroughCandidateId: 'followthrough:school-form',
        reminderTaskId: 'task-school-form',
        agentOSEpisodeId: 'agentos:episode:followthrough:school-form',
      },
      now,
    });

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters most today',
      mode: 'prioritize',
      now,
      groundedSnapshot: createGroundedSnapshot(now),
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.snapshot.mainSignal?.title).toBe('Approved follow-through');
    expect(result.snapshot.mainSignal?.summaryText).toContain('school form');
    expect(result.snapshot.signalsUsed).toContain('followthrough_outcomes');
    expect(result.snapshot.pressurePoints).toContain('Approved follow-through');
  });

  it('lets accepted setup memory make the context graph the ranked daily signal', async () => {
    const now = new Date('2026-04-06T17:30:00.000Z');
    const plan: OperatingProfilePlan = {
      summary: 'Andrea should keep family logistics and replies moving.',
      trackedAreas: ['messages', 'family logistics'],
      defaultGroups: [],
      routines: ['evening reset'],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: 'suggest_then_confirm',
    };
    upsertOperatingProfile({
      profileId: 'profile-main',
      groupFolder: 'main',
      status: 'active',
      version: 1,
      basedOnProfileId: null,
      intakeJson: JSON.stringify({
        rawText: 'setup',
        routines: plan.routines,
        trackingPriorities: plan.trackedAreas,
        defaultGroups: [],
        integrationsWanted: ['BlueBubbles'],
        richerSurface: 'telegram',
        scope: 'family',
        notes: [],
      }),
      planJson: JSON.stringify(plan),
      sourceChannel: 'telegram',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      approvedAt: now.toISOString(),
      supersededAt: null,
    });
    upsertProfileSubject({
      id: 'subject-self',
      groupFolder: 'main',
      kind: 'self',
      canonicalName: 'self',
      displayName: 'You',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      disabledAt: null,
    });
    for (const [index, factKey] of [
      'setup.tracking_priorities',
      'setup.communication_style',
      'setup.first_outcomes',
    ].entries()) {
      upsertProfileFact({
        id: `fact-context-${index}`,
        groupFolder: 'main',
        subjectId: 'subject-self',
        category:
          factKey === 'setup.communication_style'
            ? 'conversational_style'
            : 'recurring_priorities',
        factKey,
        valueJson: JSON.stringify({
          value: `${factKey} accepted`,
          memoryScope: 'user',
          confidence: 0.82,
          freshness: 'current',
          source: 'guided_profile_setup',
        }),
        state: 'accepted',
        sourceChannel: 'telegram',
        sourceSummary: `${factKey} accepted`,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        decidedAt: now.toISOString(),
      });
    }
    upsertLifeThread({
      id: 'life-family-logistics',
      groupFolder: 'main',
      title: 'Family logistics',
      category: 'family',
      status: 'active',
      scope: 'family',
      relatedSubjectIds: ['subject-self'],
      contextTags: ['setup'],
      summary: 'Keep family logistics from slipping.',
      nextAction: 'Review what matters tonight.',
      nextFollowupAt: null,
      sourceKind: 'explicit',
      confidenceKind: 'explicit',
      userConfirmed: true,
      sensitivity: 'normal',
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      createdAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    const groundedSnapshot: GroundedDaySnapshot = {
      ...createGroundedSnapshot(now),
      selectedWork: null,
      currentFocus: {
        ...createGroundedSnapshot(now).currentFocus,
        selectedWork: null,
        reason: 'selected_work',
      },
    };

    const result = await buildChiefOfStaffTurn({
      channel: 'telegram',
      groupFolder: 'main',
      text: 'what matters most today',
      mode: 'prioritize',
      now,
      groundedSnapshot,
      lifeThreadSnapshot: createLifeThreadSnapshot(),
    });

    expect(result.snapshot.mainSignal?.title).toBe('Family logistics');
    expect(result.snapshot.mainSignal?.reasons).toContain(
      'context graph: slipping',
    );
    expect(result.snapshot.summaryText).toContain(
      'Family logistics matters most',
    );
    expect(result.snapshot.mainSignal?.summaryText).toContain(
      'Review what matters tonight',
    );
  });
});
