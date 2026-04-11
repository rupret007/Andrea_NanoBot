import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handlePersonalizationCommand } from './assistant-personalization.js';
import {
  buildDailyCompanionResponse,
  isPotentialDailyCompanionPrompt,
  type DailyCompanionContext,
} from './daily-companion.js';
import { _initTestDatabase } from './db.js';
import { analyzeCommunicationMessage } from './communication-companion.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { handleRitualCommand } from './rituals.js';
import type { ScheduledTask } from './types.js';

function createGoogleCalendarFetchMock(input: {
  calendarList?: Array<{
    id: string;
    summary: string;
    selected?: boolean;
    primary?: boolean;
  }>;
  eventsByCalendar: Record<
    string,
    {
      status?: number;
      summary?: string;
      items?: unknown[];
      body?: unknown;
    }
  >;
}) {
  return vi.fn(async (request: string | URL | Request) => {
    const url = String(request);
    if (url.includes('/users/me/calendarList')) {
      return new Response(
        JSON.stringify({
          items:
            input.calendarList?.map((calendar) => ({
              ...calendar,
              selected: calendar.selected ?? true,
              primary: calendar.primary ?? false,
            })) || [],
        }),
        { status: 200 },
      );
    }

    for (const [calendarId, response] of Object.entries(input.eventsByCalendar)) {
      if (url.includes(`/calendars/${encodeURIComponent(calendarId)}/events`)) {
        return new Response(
          JSON.stringify(
            response.body ?? {
              summary: response.summary || calendarId,
              items: response.items || [],
            },
          ),
          { status: response.status ?? 200 },
        );
      }
    }

    return new Response(
      JSON.stringify({
        error: { message: `Unexpected URL: ${url}` },
      }),
      { status: 404 },
    );
  });
}

function createReminderTask(
  label: string,
  nextRunIso: string,
  id = `task-${label.replace(/\s+/g, '-').toLowerCase()}`,
): ScheduledTask {
  return {
    id,
    group_folder: 'main',
    chat_jid: 'tg:8004355504',
    prompt: `Send a concise reminder telling the user to ${label}.`,
    script: null,
    schedule_type: 'once',
    schedule_value: nextRunIso,
    context_mode: 'isolated',
    next_run: nextRunIso,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-04T11:30:00.000Z',
  };
}

const baseEnv = {
  GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
  GOOGLE_CALENDAR_IDS: 'primary',
};

const selectedWork = {
  laneLabel: 'Cursor',
  title: 'Ship docs',
  statusLabel: 'Running',
  summary: 'Polish the rollout docs',
};

beforeEach(() => {
  _initTestDatabase();
});

describe('isPotentialDailyCompanionPrompt', () => {
  it('recognizes the grounded ritual prompts', () => {
    expect(isPotentialDailyCompanionPrompt('Give me my morning brief')).toBe(
      true,
    );
    expect(
      isPotentialDailyCompanionPrompt('What do Candace and I have coming up?'),
    ).toBe(true);
    expect(
      isPotentialDailyCompanionPrompt('What is on my calendar tomorrow?'),
    ).toBe(true);
    expect(isPotentialDailyCompanionPrompt('Can you write a poem')).toBe(
      false,
    );
  });
});

describe('buildDailyCompanionResponse', () => {
  it('builds a grounded Telegram morning brief with reminders, events, and focus', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-04T21:00:00Z' },
              end: { dateTime: '2026-04-04T22:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCompanionResponse(
      'Give me my morning brief',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [
          createReminderTask(
            'check on the demo',
            '2026-04-04T18:30:00.000Z',
            'reminder-1',
          ),
        ],
      },
    );

    expect(response?.mode).toBe('morning_brief');
    expect(response?.reply).toContain('The first thing I would keep in mind is');
    expect(response?.reply).toContain('Next: 4:00 PM-5:00 PM Team sync');
    expect(response?.reply).toContain('Reminder: 1:30 PM check on the demo');
    expect(response?.reply).toContain('Suggestion:');
    expect(response?.grounded?.selectedWork?.title).toBe('Ship docs');
  });

  it('builds midday re-grounding around selected work and open time', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Client review',
              start: { dateTime: '2026-04-04T20:00:00Z' },
              end: { dateTime: '2026-04-04T21:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCompanionResponse('What should I do now?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
      tasks: [],
    });

    expect(response?.mode).toBe('midday_reground');
    expect(response?.reply).toContain('The best next move is still Ship docs.');
    expect(response?.reply).toContain('Current work: Ship docs (Running)');
    expect(response?.recommendationKind).toBe('do_now');
  });

  it('surfaces thread carryover in daily guidance when an active thread would otherwise slip', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T11:00:00-05:00'),
    });

    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCompanionResponse('What should I do next?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
    });

    expect(response?.reply).toContain('Candace');
    expect(response?.signalsUsed).toContain('life_threads');
    expect(response?.context.usedThreadTitles).toContain('Candace');
  });

  it('layers chief-of-staff synthesis into loose-ends guidance without replacing the daily renderer', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCompanionResponse('What am I forgetting?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
      tasks: [
        createReminderTask(
          'reply to Candace about dinner',
          '2026-04-04T18:30:00.000Z',
          'reminder-chief-of-staff',
        ),
      ],
    });

    expect(response?.mode).toBe('open_guidance');
    expect(response?.signalsUsed).toContain('chief_of_staff');
  });

  it('can include one open communication carryover in daily guidance', async () => {
    analyzeCommunicationMessage({
      channel: 'telegram',
      groupFolder: 'main',
      chatJid: 'tg:8004355504',
      text: 'Candace: Can you let me know if dinner still works tonight?',
      now: new Date('2026-04-04T11:00:00-05:00'),
    });

    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCompanionResponse('What am I forgetting?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
    });

    expect(response?.reply).toContain('Candace wants a follow-up');
    expect(response?.reply).toContain('Why this came up:');
    expect(response?.signalsUsed).toContain('communication_threads');
  });

  it('answers what changed from the prior companion context instead of falling back', async () => {
    const firstFetch = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-04T21:00:00Z' },
              end: { dateTime: '2026-04-04T22:00:00Z' },
            },
          ],
        },
      },
    });
    const secondFetch = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-2',
              summary: 'Client call',
              start: { dateTime: '2026-04-04T19:00:00Z' },
              end: { dateTime: '2026-04-04T19:30:00Z' },
            },
          ],
        },
      },
    });

    const first = await buildDailyCompanionResponse('Give me my day', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T09:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: firstFetch,
      selectedWork,
      tasks: [
        createReminderTask(
          'check on the demo',
          '2026-04-04T18:30:00.000Z',
          'reminder-1',
        ),
      ],
    });

    const changed = await buildDailyCompanionResponse('What changed?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:30:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: secondFetch,
      selectedWork,
      tasks: [
        createReminderTask(
          'call Candace',
          '2026-04-04T17:45:00.000Z',
          'reminder-2',
        ),
      ],
      priorContext: first?.context as DailyCompanionContext,
    });

    expect(changed?.reply).toContain('What changed:');
    expect(changed?.reply).toContain('the next calendar anchor shifted');
    expect(changed?.reply).toContain('the reminder pressure changed');
  });

  it('keeps household context relevant-only unless explicitly requested', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Dinner with Candace',
              start: { dateTime: '2026-04-04T23:30:00Z' },
              end: { dateTime: '2026-04-05T01:00:00Z' },
            },
          ],
        },
      },
    });

    handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'use less family context',
    });

    const broad = await buildDailyCompanionResponse('What should I do next?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
      tasks: [],
    });
    const explicit = await buildDailyCompanionResponse(
      'What do Candace and I have coming up?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [],
      },
    );

    expect(broad?.reply).not.toContain('Household:');
    expect(explicit?.mode).toBe('household_guidance');
    expect(explicit?.reply).toContain('Candace');
  });

  it('uses a real loose-ends path for what am I forgetting instead of the generic midday builder', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Tomorrow kickoff',
              start: { dateTime: '2026-04-05T15:00:00Z' },
              end: { dateTime: '2026-04-05T16:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCompanionResponse('What am I forgetting?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T16:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [
        createReminderTask(
          'call Candace',
          '2026-04-04T22:30:00.000Z',
          'reminder-call-candace',
        ),
      ],
    });

    expect(response?.mode).toBe('open_guidance');
    expect(response?.leadReason).toBe('due_reminder');
    expect(response?.reply).toContain('The easiest thing to forget right now is call Candace.');
    expect(response?.reply).not.toContain(
      'The next grounded thing is your schedule, because I do not have a better signal than that yet.',
    );
  });

  it('lets explicit Candace questions use a manual-only thread without auto-surfacing it broadly', async () => {
    const saved = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T09:00:00-05:00'),
    });

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: "don't bring this up automatically",
      priorContext: {
        summaryText: 'Candace dinner plans',
        usedThreadIds: [saved.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Talk through dinner plans tonight.'],
      },
      now: new Date('2026-04-04T09:05:00-05:00'),
    });

    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const explicit = await buildDailyCompanionResponse(
      "What's still open with Candace?",
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        tasks: [],
      },
    );
    const broad = await buildDailyCompanionResponse('What am I forgetting?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:05:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
    });

    expect(explicit?.mode).toBe('household_guidance');
    expect(explicit?.reply).toContain('Candace');
    expect(explicit?.reply).toContain('dinner plans tonight');
    expect(explicit?.context.usedThreadTitles).toContain('Candace');
    expect(broad?.context.usedThreadTitles).not.toContain('Candace');
    expect(broad?.reply).not.toContain('Candace');
  });

  it('uses explicit Candace thread context for shared-plans questions even when the thread is manual-only', async () => {
    const saved = handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Confirm dinner plans and pickup timing.',
      now: new Date('2026-04-04T10:00:00-05:00'),
    });

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: "don't bring this up automatically",
      priorContext: {
        summaryText: 'Candace dinner plans',
        usedThreadIds: [saved.referencedThread!.id],
        usedThreadTitles: ['Candace'],
        usedThreadReasons: ['it was the active thread in the last answer'],
        threadSummaryLines: ['Candace: Confirm dinner plans and pickup timing.'],
      },
      now: new Date('2026-04-04T10:05:00-05:00'),
    });

    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCompanionResponse(
      'What do Candace and I have coming up?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T12:30:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        tasks: [],
      },
    );

    expect(response?.mode).toBe('household_guidance');
    expect(response?.reply).toContain('Candace');
    expect(response?.reply).toContain('Confirm dinner plans and pickup timing');
    expect(response?.context.usedThreadTitles).toContain('Candace');
  });

  it('answers what should I talk to Candace about with a natural household follow-up lead', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Confirm dinner plans and pickup timing.',
      now: new Date('2026-04-04T10:00:00-05:00'),
    });

    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCompanionResponse(
      'What should I talk to Candace about?',
      {
        channel: 'alexa',
        groupFolder: 'main',
        now: new Date('2026-04-04T12:30:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        tasks: [],
      },
    );

    expect(response?.mode).toBe('household_guidance');
    expect(response?.reply).toContain('talk to Candace about');
    expect(response?.reply).toContain('Confirm dinner plans and pickup timing');
  });

  it('answers what about Candace by reusing the saved Candace thread naturally', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the Candace thread',
      replyText: 'Talk through dinner plans tonight.',
      now: new Date('2026-04-04T10:00:00-05:00'),
    });

    const response = await buildDailyCompanionResponse('What about Candace', {
      channel: 'alexa',
      groupFolder: 'main',
      now: new Date('2026-04-04T12:30:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: createGoogleCalendarFetchMock({
        eventsByCalendar: {
          primary: {
            items: [],
          },
        },
      }),
      tasks: [],
    });

    expect(response?.mode).toBe('household_guidance');
    expect(response?.reply).toContain('Candace');
    expect(response?.reply).toContain('dinner plans tonight');
    expect(response?.context.usedThreadTitles).toContain('Candace');
  });

  it('renders Alexa shorter than Telegram while using the same grounded snapshot', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Late client call',
              start: { dateTime: '2026-04-04T22:00:00Z' },
              end: { dateTime: '2026-04-04T23:00:00Z' },
            },
          ],
        },
      },
    });

    const telegram = await buildDailyCompanionResponse(
      'What should I remember tonight?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T17:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [
          createReminderTask(
            'send the follow-up',
            '2026-04-04T23:30:00.000Z',
            'reminder-1',
          ),
        ],
      },
    );
    const alexa = await buildDailyCompanionResponse(
      'What should I remember tonight?',
      {
        channel: 'alexa',
        groupFolder: 'main',
        now: new Date('2026-04-04T17:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [
          createReminderTask(
            'send the follow-up',
            '2026-04-04T23:30:00.000Z',
            'reminder-1',
          ),
        ],
      },
    );

    expect(telegram?.grounded?.currentFocus.reason).toBe(
      alexa?.grounded?.currentFocus.reason,
    );
    expect(telegram?.reply).toContain('Next:');
    expect(telegram?.reply).toContain('Why this came up:');
    expect(alexa?.reply).not.toContain('- ');
    expect((alexa?.reply.split('\n').length || 0) <= 3).toBe(true);
    expect(alexa?.reply).not.toContain('Reminder:');
    expect(alexa?.reply).not.toContain('Thread:');
  });

  it('makes Alexa anything-else follow-ups add a new point before recapping', async () => {
    const priorContext: DailyCompanionContext = {
      version: 1,
      mode: 'open_guidance',
      channel: 'alexa',
      generatedAt: '2026-04-04T17:00:00.000Z',
      summaryText: 'Dinner plans tonight still need a clean answer.',
      shortText: 'Dinner plans tonight still need a clean answer.',
      extendedText:
        'Dinner plans tonight still need a clean answer. Pickup after rehearsal keeps it simpler. A reminder before 6 would help.',
      leadReason: 'communication_carryover',
      signalsUsed: ['communication_threads'],
      signalsOmitted: [],
      householdSignals: ['Candace still needs a dinner answer.'],
      recommendationKind: 'do_now',
      recommendationText: 'A reminder before 6 would help.',
      subjectKind: 'household',
      supportedFollowups: [
        'anything_else',
        'shorter',
        'say_more',
        'save_that',
        'save_for_later',
        'create_reminder',
        'send_details',
      ],
      subjectData: {
        personName: 'Candace',
        activePeople: ['Candace'],
        householdFocus: true,
      },
      extraDetails: [
        'Dinner plans tonight still need a clean answer.',
        'Pickup after rehearsal keeps it simpler.',
      ],
      memoryLines: [],
      usedThreadIds: ['thread-candace'],
      usedThreadTitles: ['Candace'],
      usedThreadReasons: ['communication carryover'],
      threadSummaryLines: ['Candace still needs a dinner answer.'],
      comparisonKeys: {
        nextEvent: null,
        nextReminder: null,
        recommendation: 'A reminder before 6 would help.',
        household: 'Candace',
        focus: 'Dinner plans tonight',
        thread: 'Candace',
      },
      toneProfile: 'balanced',
    };

    const response = await buildDailyCompanionResponse('Anything else?', {
      channel: 'alexa',
      groupFolder: 'main',
      now: new Date('2026-04-04T17:05:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: createGoogleCalendarFetchMock({
        eventsByCalendar: {
          primary: {
            items: [],
          },
        },
      }),
      tasks: [],
      priorContext,
    });

    expect(response?.reply.startsWith('Pickup after rehearsal keeps it simpler.')).toBe(
      true,
    );
    expect(response?.reply).not.toContain(
      'Dinner plans tonight still need a clean answer. Dinner plans tonight still need a clean answer.',
    );
  });

  it('surfaces slipping thread pressure during midday re-grounding', async () => {
    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'remind me to talk to Candace about dinner plans tonight',
      now: new Date('2026-04-04T09:00:00-05:00'),
    });

    const response = await buildDailyCompanionResponse('Anything I should know?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T21:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: createGoogleCalendarFetchMock({
        eventsByCalendar: {
          primary: {
            items: [],
          },
        },
      }),
      tasks: [],
    });

    expect(response?.mode).toBe('midday_reground');
    expect(response?.leadReason).toBe('thread_followup');
    expect(response?.reply).toContain('The main loose end right now is Candace');
    expect(response?.reply).toContain('Thread follow-up: Candace');
    expect(response?.context.usedThreadTitles).toContain('Candace');
  });

  it('carries ritual shaping into explainability after the morning brief is shortened', async () => {
    handleRitualCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'make the morning brief shorter',
      now: new Date('2026-04-04T07:00:00-05:00'),
    });

    const brief = await buildDailyCompanionResponse('Good morning', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T07:15:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl: createGoogleCalendarFetchMock({
        eventsByCalendar: {
          primary: {
            items: [],
          },
        },
      }),
      tasks: [
        createReminderTask(
          'check on the demo',
          '2026-04-04T18:30:00.000Z',
          'reminder-ritual-brief',
        ),
      ],
    });

    const explain = await buildDailyCompanionResponse(
      'Why are you bringing that up?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T07:16:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl: createGoogleCalendarFetchMock({
          eventsByCalendar: {
            primary: {
              items: [],
            },
          },
        }),
        tasks: [],
        priorContext: brief?.context as DailyCompanionContext,
      },
    );

    expect(brief?.context.ritualType).toBe('morning_brief');
    expect(brief?.context.ritualToneStyle).toBe('brief');
    expect(explain?.reply).toContain('Ritual shaping in play: morning brief');
  });

  it('supports explainability and remembered-context follow-ups from prior companion context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-04T21:00:00Z' },
              end: { dateTime: '2026-04-04T22:00:00Z' },
            },
          ],
        },
      },
    });

    handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'be more direct',
    });
    handlePersonalizationCommand({
      groupFolder: 'main',
      channel: 'telegram',
      text: 'use less family context',
    });

    const first = await buildDailyCompanionResponse('Give me my day', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T09:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
      tasks: [],
    });

    const explain = await buildDailyCompanionResponse(
      'What are you using to answer this?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T09:05:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [],
        priorContext: first?.context as DailyCompanionContext,
      },
    );
    const memory = await buildDailyCompanionResponse(
      'What do you remember that affects this?',
      {
        channel: 'telegram',
        groupFolder: 'main',
        now: new Date('2026-04-04T09:05:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [],
        priorContext: first?.context as DailyCompanionContext,
      },
    );

    expect(explain?.reply).toContain('I answered from');
    expect(explain?.reply).toContain('calendar');
    expect(memory?.reply).toContain('Remembered context affecting this');
    expect(memory?.reply).toContain('shorter, more direct');
    expect(memory?.reply).toContain('family context should stay lighter');
  });

  it('includes active thread context in explainability and remembered-context follow-ups', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    handleLifeThreadCommand({
      groupFolder: 'main',
      channel: 'telegram',
      chatJid: 'tg:8004355504',
      text: 'save this under the band thread',
      replyText: 'Confirm rehearsal time with the drummer.',
      now: new Date('2026-04-04T08:30:00-05:00'),
    });

    const first = await buildDailyCompanionResponse('What am I forgetting?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T09:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
    });

    const explain = await buildDailyCompanionResponse('What are you using to answer this?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T09:05:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
      priorContext: first?.context as DailyCompanionContext,
    });
    const memory = await buildDailyCompanionResponse('What do you remember that affects this?', {
      channel: 'telegram',
      groupFolder: 'main',
      now: new Date('2026-04-04T09:05:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [],
      priorContext: first?.context as DailyCompanionContext,
    });

    expect(explain?.reply).toContain('Thread context in play');
    expect(explain?.reply).toContain('Band');
    expect(memory?.reply).toContain('Active thread context in play');
    expect(memory?.reply).toContain('Band');
  });
});
