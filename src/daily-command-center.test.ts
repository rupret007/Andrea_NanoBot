import { describe, expect, it, vi } from 'vitest';

import {
  buildDailyCommandCenterResponse,
  planDailyCommandCenterIntent,
  type SelectedWorkContext,
} from './daily-command-center.js';
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

    for (const [calendarId, response] of Object.entries(
      input.eventsByCalendar,
    )) {
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
    chat_jid: 'tg:1',
    prompt: `Send a concise reminder telling the user to ${label}.`,
    script: null,
    schedule_type: 'once',
    schedule_value: nextRunIso,
    context_mode: 'isolated',
    next_run: nextRunIso,
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-04-01T12:00:00.000Z',
  };
}

const selectedWork: SelectedWorkContext = {
  laneLabel: 'Cursor',
  title: 'Ship docs',
  statusLabel: 'Running',
  summary: 'Polish the rollout docs',
};

const baseEnv = {
  GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
  GOOGLE_CALENDAR_IDS: 'primary',
};

describe('planDailyCommandCenterIntent', () => {
  it('recognizes bounded day and fit prompts', () => {
    expect(planDailyCommandCenterIntent('Give me my day')?.kind).toBe(
      'day_overview',
    );
    expect(
      planDailyCommandCenterIntent('Andrea, can you give me my day?')?.kind,
    ).toBe('day_overview');
    expect(
      planDailyCommandCenterIntent(
        'Do I have time to work on this before my next meeting?',
      )?.kind,
    ).toBe('fit_before_next_meeting');
    expect(
      planDailyCommandCenterIntent(
        "What's next on my calendar and what could I do before then?",
      )?.kind,
    ).toBe('next_and_before_then');
  });
});

describe('buildDailyCommandCenterResponse', () => {
  it('builds a concise day view with reminders, next event, and work context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse('Give me my day', {
      now: new Date('2026-04-01T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
      tasks: [
        createReminderTask(
          'check on the demo',
          '2026-04-01T18:30:00.000Z',
          'reminder-1',
        ),
      ],
    });

    expect(response?.reply).toContain('You have time for Ship docs right now.');
    expect(response?.reply).toContain('Next: 4:00 PM-5:00 PM Team sync');
    expect(response?.reply).toContain('Reminder: 1:30 PM check on the demo');
    expect(response?.activeEventContext).toBeNull();
  });

  it('prioritizes the current meeting window over selected work when focus is tight', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Design review',
              start: { dateTime: '2026-04-01T18:10:00Z' },
              end: { dateTime: '2026-04-01T19:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      "What's my current focus?",
      {
        now: new Date('2026-04-01T12:55:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response?.reply).toContain('Your next meeting is close');
    expect(response?.reply).toContain('Next: 1:10 PM-2:00 PM Design review');
    expect(response?.currentFocus.reason).toBe('meeting_soon');
  });

  it('uses the selected task when there is a clean block for focus', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      'What should I focus on today?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response?.reply).toContain(
      'Resuming Ship docs looks like the best grounded next step.',
    );
    expect(response?.reply).toContain('Focus: Ship docs (Cursor)');
    expect(response?.currentFocus.reason).toBe('selected_work');
  });

  it('falls back honestly when no selected work exists before the next meeting', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-01T18:45:00Z' },
              end: { dateTime: '2026-04-01T19:30:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      'Do I have time to work on this before my next meeting?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
      },
    );

    expect(response?.reply).toContain('This is schedule-based guidance only.');
    expect(response?.reply).toContain('Next: 1:45 PM-2:30 PM Team sync');
  });

  it('sizes the next free window against the selected task', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Lunch',
              start: { dateTime: '2026-04-01T17:00:00Z' },
              end: { dateTime: '2026-04-01T18:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Review',
              start: { dateTime: '2026-04-01T20:30:00Z' },
              end: { dateTime: '2026-04-01T21:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      'What can I fit into my next free window?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response?.reply).toContain(
      'Your next free window is 1:00 PM-3:30 PM',
    );
    expect(response?.reply).toContain(
      'you could make meaningful progress on Ship docs',
    );
  });

  it('surfaces the no-window case honestly', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Busy A',
              start: { dateTime: '2026-04-01T17:05:00Z' },
              end: { dateTime: '2026-04-01T18:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Busy B',
              start: { dateTime: '2026-04-01T18:05:00Z' },
              end: { dateTime: '2026-04-02T05:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      'What can I fit into my next free window?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
      },
    );

    expect(response?.reply).toContain(
      "I don't see a meaningful free window left today.",
    );
  });

  it('supports explicit before-my-4-PM-meeting reasoning', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Four PM review',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse(
      'What should I tackle before my 4 PM meeting?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response?.reply).toContain('Before Four PM review');
    expect(response?.reply).toContain('Next: 4:00 PM-5:00 PM Four PM review');
  });

  it('does not surface tomorrow reminders in today views', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [],
        },
      },
    });

    const response = await buildDailyCommandCenterResponse('Give me my day', {
      now: new Date('2026-04-01T23:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      tasks: [
        createReminderTask(
          'check on the demo',
          '2026-04-02T20:30:00.000Z',
          'reminder-tomorrow',
        ),
      ],
    });

    expect(response?.reply).not.toContain('Reminder:');
  });

  it('adds an incompleteness note when calendar reads are partial', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Team sync',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
        'missing@group.calendar.google.com': {
          status: 500,
          body: { error: { message: 'calendar failed' } },
        },
      },
    });

    const response = await buildDailyCommandCenterResponse('Give me my day', {
      now: new Date('2026-04-01T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: {
        GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        GOOGLE_CALENDAR_IDS: 'primary,missing@group.calendar.google.com',
      },
      fetchImpl,
      selectedWork,
    });

    expect(response?.reply).toContain('Calendar:');
    expect(response?.reply).toContain('Google Calendar');
  });
});
