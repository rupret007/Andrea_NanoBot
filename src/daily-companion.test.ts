import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handlePersonalizationCommand } from './assistant-personalization.js';
import {
  buildDailyCompanionResponse,
  isPotentialDailyCompanionPrompt,
  type DailyCompanionContext,
} from './daily-companion.js';
import { _initTestDatabase } from './db.js';
import { handleLifeThreadCommand } from './life-threads.js';
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
    expect(response?.reply).toContain('The first thing to watch is');
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
    expect(response?.reply).toContain('The best next move is to stay with Ship docs.');
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
    expect(telegram?.reply).toContain('- ');
    expect(alexa?.reply).not.toContain('- ');
    expect((alexa?.reply.split('\n').length || 0) <= 3).toBe(true);
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
