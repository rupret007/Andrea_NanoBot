import { describe, expect, it, vi } from 'vitest';

import {
  buildCalendarAssistantResponse,
  buildCalendarAssistantReply,
  planCalendarAssistantLookup,
} from './calendar-assistant.js';

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

describe('planCalendarAssistantLookup', () => {
  it('parses schedule asks for tomorrow', () => {
    const plan = planCalendarAssistantLookup(
      "Hey what's on my schedule tomorrow",
      new Date('2026-03-31T23:55:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.intent).toBe('agenda');
    expect(plan?.label).toBe('tomorrow');
    expect(plan?.start.toISOString()).toBe('2026-04-01T05:00:00.000Z');
    expect(plan?.end.toISOString()).toBe('2026-04-02T05:00:00.000Z');
    expect(plan?.pointInTime).toBeNull();
  });

  it('parses availability asks with dayparts', () => {
    const plan = planCalendarAssistantLookup(
      'Am I free tomorrow afternoon?',
      new Date('2026-03-31T23:55:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.intent).toBe('availability');
    expect(plan?.label).toBe('tomorrow afternoon');
    expect(plan?.start.toISOString()).toBe('2026-04-01T17:00:00.000Z');
    expect(plan?.end.toISOString()).toBe('2026-04-01T22:00:00.000Z');
    expect(plan?.pointInTime).toBeNull();
  });

  it('parses exact-time availability asks', () => {
    const plan = planCalendarAssistantLookup(
      'Do I have anything at 3pm tomorrow?',
      new Date('2026-03-31T23:55:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.intent).toBe('availability');
    expect(plan?.label).toBe('at 3 PM tomorrow');
    expect(plan?.start.toISOString()).toBe('2026-04-01T05:00:00.000Z');
    expect(plan?.end.toISOString()).toBe('2026-04-02T05:00:00.000Z');
    expect(plan?.pointInTime?.toISOString()).toBe('2026-04-01T20:00:00.000Z');
  });

  it('parses after-time availability ranges naturally', () => {
    const plan = planCalendarAssistantLookup(
      'Am I free after 3 tomorrow?',
      new Date('2026-03-31T23:55:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.intent).toBe('availability');
    expect(plan?.label).toBe('after 3 PM tomorrow');
    expect(plan?.start.toISOString()).toBe('2026-04-01T20:00:00.000Z');
    expect(plan?.end.toISOString()).toBe('2026-04-02T05:00:00.000Z');
  });

  it('flags vague anchors for clarification', () => {
    const plan = planCalendarAssistantLookup(
      'What do I have after work today?',
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.clarificationQuestion).toBe('What time counts as after work?');
  });

  it('captures duration-fit availability requests', () => {
    const plan = planCalendarAssistantLookup(
      'Do I have time at 4 for a one-hour meeting tomorrow?',
      new Date('2026-03-31T23:55:00-05:00'),
      'America/Chicago',
    );

    expect(plan?.reasoningMode).toBe('availability_duration');
    expect(plan?.durationMinutes).toBe(60);
    expect(plan?.requestedTitle).toBe('meeting');
    expect(plan?.pointInTime?.toISOString()).toBe('2026-04-01T21:00:00.000Z');
  });

  it('parses daily and weekly briefing asks', () => {
    const tomorrowPlan = planCalendarAssistantLookup(
      "What's my day look like tomorrow?",
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );
    const weekPlan = planCalendarAssistantLookup(
      "What's coming up this week?",
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );

    expect(tomorrowPlan?.reasoningMode).toBe('agenda_briefing_day');
    expect(tomorrowPlan?.label).toBe('tomorrow');
    expect(weekPlan?.reasoningMode).toBe('agenda_briefing_week');
    expect(weekPlan?.label).toBe('this week');
  });

  it('uses bounded awareness windows for coming-up-soon and rest-of-day asks', () => {
    const now = new Date('2026-04-01T10:15:00-05:00');
    const soonPlan = planCalendarAssistantLookup(
      'What do I have coming up soon?',
      now,
      'America/Chicago',
    );
    const todayPlan = planCalendarAssistantLookup(
      'What should I know about today?',
      now,
      'America/Chicago',
    );
    const morningBriefPlan = planCalendarAssistantLookup(
      'Give me a morning brief for tomorrow',
      now,
      'America/Chicago',
    );

    expect(soonPlan?.reasoningMode).toBe('agenda_next');
    expect(soonPlan?.awarenessKind).toBe('coming_up_soon');
    expect(soonPlan?.lookaheadMinutes).toBe(120);
    expect(soonPlan?.start.toISOString()).toBe(now.toISOString());
    expect(soonPlan?.end.toISOString()).toBe('2026-04-01T17:15:00.000Z');

    expect(todayPlan?.awarenessKind).toBe('rest_of_day');
    expect(todayPlan?.label).toBe('the rest of today');
    expect(todayPlan?.start.toISOString()).toBe(now.toISOString());
    expect(todayPlan?.end.toISOString()).toBe('2026-04-02T05:00:00.000Z');

    expect(morningBriefPlan?.awarenessKind).toBe('morning_brief');
    expect(morningBriefPlan?.reasoningMode).toBe('agenda_briefing_day');
  });

  it('parses next-event, open-window, conflict, and family-calendar asks', () => {
    const nextPlan = planCalendarAssistantLookup(
      "What's my next meeting?",
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );
    const openingsPlan = planCalendarAssistantLookup(
      'When am I free for an hour tomorrow?',
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );
    const conflictsPlan = planCalendarAssistantLookup(
      'Do I have any conflicts this week?',
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );
    const familyPlan = planCalendarAssistantLookup(
      "What's on the family calendar this week?",
      new Date('2026-04-01T10:00:00-05:00'),
      'America/Chicago',
    );

    expect(nextPlan?.reasoningMode).toBe('agenda_next');
    expect(nextPlan?.nextTimedOnly).toBe(true);
    expect(openingsPlan?.reasoningMode).toBe('availability_open_windows');
    expect(openingsPlan?.minimumOpenMinutes).toBe(60);
    expect(conflictsPlan?.reasoningMode).toBe('availability_conflicts');
    expect(familyPlan?.scopeFilter?.kind).toBe('family_shared');
    expect(familyPlan?.forceIncludeCalendarNames).toBe(true);
  });
});

describe('buildCalendarAssistantReply', () => {
  it('formats daily briefings with all-day events and conflicts', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'all-day-1',
              summary: 'Spring break',
              start: { date: '2026-04-02' },
              end: { date: '2026-04-03' },
            },
            {
              id: 'evt-1',
              summary: 'Overlap A',
              start: { dateTime: '2026-04-02T15:00:00Z' },
              end: { dateTime: '2026-04-02T16:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Overlap B',
              start: { dateTime: '2026-04-02T15:30:00Z' },
              end: { dateTime: '2026-04-02T16:30:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      "What's my day look like tomorrow?",
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Tomorrow has 1 all-day event');
    expect(reply).toContain('2 timed events');
    expect(reply).toContain('1 conflict');
    expect(reply).toContain('All day Spring break');
    expect(reply).toContain('I can list the rest if you want.');
  });

  it('answers next-event asks and records a single active Google event context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Dentist',
              start: { dateTime: '2026-04-02T14:00:00Z' },
              end: { dateTime: '2026-04-02T15:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Project sync',
              start: { dateTime: '2026-04-02T18:00:00Z' },
              end: { dateTime: '2026-04-02T19:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildCalendarAssistantResponse(
      "What's next on my calendar?",
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(response?.reply).toContain('Next up: 9:00 AM-10:00 AM Dentist');
    expect(response?.activeEventContext?.id).toBe('evt-1');
  });

  it('answers bounded coming-up-soon prompts without surfacing later events', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-soon-1',
              summary: 'School pickup',
              start: { dateTime: '2026-04-01T16:00:00Z' },
              end: { dateTime: '2026-04-01T16:30:00Z' },
            },
            {
              id: 'evt-soon-2',
              summary: 'Call Mom',
              start: { dateTime: '2026-04-01T16:45:00Z' },
              end: { dateTime: '2026-04-01T17:15:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildCalendarAssistantResponse(
      'Anything coming up in the next two hours?',
      {
        now: new Date('2026-04-01T10:15:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(response?.reply).toContain(
      'In the next 2 hours, you have 2 timed events.',
    );
    expect(response?.reply).toContain('11:00 AM-11:30 AM School pickup');
    expect(response?.reply).toContain('11:45 AM-12:15 PM Call Mom');
    expect(response?.activeEventContext).toBeNull();
  });

  it('adds morning emphasis to tomorrow brief replies', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Breakfast meeting',
              start: { dateTime: '2026-04-02T13:30:00Z' },
              end: { dateTime: '2026-04-02T14:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Afternoon call',
              start: { dateTime: '2026-04-02T19:00:00Z' },
              end: { dateTime: '2026-04-02T19:30:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      'Give me a morning brief for tomorrow',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Tomorrow has 2 timed events');
    expect(reply).toContain(
      'Morning starts with 8:30 AM-9:00 AM Breakfast meeting.',
    );
  });

  it('uses active event context for after-this next-event questions', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Current meeting',
              start: { dateTime: '2026-04-01T14:30:00Z' },
              end: { dateTime: '2026-04-01T15:30:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Next meeting',
              start: { dateTime: '2026-04-01T16:00:00Z' },
              end: { dateTime: '2026-04-01T17:00:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      'What do I have after this?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
        activeEventContext: {
          providerId: 'google_calendar',
          id: 'evt-1',
          title: 'Current meeting',
          startIso: '2026-04-01T14:30:00.000Z',
          endIso: '2026-04-01T15:30:00.000Z',
          allDay: false,
          calendarId: 'primary',
          calendarName: 'Jeff',
          htmlLink: null,
        },
      },
    );

    expect(reply).toContain('After this: 11:00 AM-12:00 PM Next meeting');
  });

  it('summarizes open windows without setting active event context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Dentist',
              start: { dateTime: '2026-04-02T14:00:00Z' },
              end: { dateTime: '2026-04-02T15:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Project sync',
              start: { dateTime: '2026-04-02T18:00:00Z' },
              end: { dateTime: '2026-04-02T19:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildCalendarAssistantResponse(
      'When am I free for an hour tomorrow?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(response?.reply).toContain(
      'You have 3 60-minute openings tomorrow.',
    );
    expect(response?.reply).toContain('Open: 10:00 AM-1:00 PM');
    expect(response?.activeEventContext).toBeNull();
  });

  it('summarizes conflicts this week without calling tight stretches conflicts', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Overlap A',
              start: { dateTime: '2026-04-03T15:00:00Z' },
              end: { dateTime: '2026-04-03T16:00:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Overlap B',
              start: { dateTime: '2026-04-03T15:30:00Z' },
              end: { dateTime: '2026-04-03T16:30:00Z' },
            },
            {
              id: 'evt-3',
              summary: 'Tight but separate',
              start: { dateTime: '2026-04-03T16:40:00Z' },
              end: { dateTime: '2026-04-03T17:10:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      'Do I have any conflicts this week?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('You do have conflicts this week:');
    expect(reply).toContain('Overlap A overlaps 10:30 AM-11:30 AM Overlap B');
    expect(reply).not.toContain('Tight but separate');
  });

  it('filters weekly summaries to configured family and shared calendars', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      calendarList: [
        { id: 'primary', summary: 'Jeff', primary: true },
        {
          id: 'family@group.calendar.google.com',
          summary: 'Family',
        },
        {
          id: 'candace-story',
          summary: 'Jeff & Candace Story',
        },
      ],
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Dentist',
              start: { dateTime: '2026-04-02T14:00:00Z' },
              end: { dateTime: '2026-04-02T15:00:00Z' },
            },
          ],
        },
        'family@group.calendar.google.com': {
          summary: 'Family',
          items: [
            {
              id: 'fam-1',
              summary: 'Soccer practice',
              start: { dateTime: '2026-04-02T22:00:00Z' },
              end: { dateTime: '2026-04-02T23:00:00Z' },
            },
          ],
        },
        'candace-story': {
          summary: 'Jeff & Candace Story',
          items: [
            {
              id: 'shared-1',
              summary: 'Date night',
              start: { dateTime: '2026-04-03T00:00:00Z' },
              end: { dateTime: '2026-04-03T02:00:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      'What do Candace and I have coming up?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS:
            'primary,family@group.calendar.google.com,candace-story',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Coming up has 2 timed events');
    expect(reply).toContain('Soccer practice [Family]');
    expect(reply).toContain('Date night [Jeff & Candace Story]');
    expect(reply).not.toContain('Dentist [Jeff]');
  });

  it('keeps partial-read honesty for next-event and open-window answers', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Dentist',
              start: { dateTime: '2026-04-02T14:00:00Z' },
              end: { dateTime: '2026-04-02T15:00:00Z' },
            },
          ],
        },
        'missing@group.calendar.google.com': {
          status: 404,
          body: {
            error: {
              message: 'Calendar not found.',
            },
          },
        },
      },
    });

    const nextReply = await buildCalendarAssistantReply(
      "What's next on my calendar?",
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,missing@group.calendar.google.com',
        },
        fetchImpl,
      },
    );
    const openingsReply = await buildCalendarAssistantReply(
      'When am I free for an hour tomorrow?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,missing@group.calendar.google.com',
        },
        fetchImpl,
      },
    );

    expect(nextReply).toContain('Next up: 9:00 AM-10:00 AM Dentist');
    expect(nextReply).toContain(
      "I couldn't confirm every configured calendar right now.",
    );
    expect(openingsReply).toContain('You have 2 60-minute openings tomorrow.');
    expect(openingsReply).toContain(
      "I couldn't confirm every configured calendar right now.",
    );
  });

  it('stays timezone-correct around late-night next-event boundaries', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Late movie',
              start: { dateTime: '2026-04-02T05:15:00Z' },
              end: { dateTime: '2026-04-02T06:00:00Z' },
            },
          ],
        },
      },
    });

    const reply = await buildCalendarAssistantReply(
      "What's next on my calendar?",
      {
        now: new Date('2026-04-01T22:30:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Next up: 12:15 AM-1:00 AM Late movie');
  });

  it('returns a truthful setup reply when no providers are ready', async () => {
    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {},
      },
    );

    expect(reply).toContain("I can't check your calendar yet");
    expect(reply).toContain('Google Calendar with a configured OAuth token');
    expect(reply).toContain('Apple Calendar directly on a Mac');
    expect(reply).toContain('Outlook calendars through Microsoft Graph');
  });

  it('reads Google Calendar events through an access token across multiple calendars', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/calendars/primary/events')) {
        return new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'google-1',
                summary: 'School pickup',
                start: {
                  dateTime: '2026-04-01T20:00:00Z',
                },
                end: {
                  dateTime: '2026-04-01T20:30:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      expect(url).toContain(
        '/calendars/family%40group.calendar.google.com/events',
      );
      return new Response(
        JSON.stringify({
          summary: 'Family',
          items: [
            {
              id: 'google-2',
              summary: 'Soccer practice',
              start: {
                dateTime: '2026-04-01T22:00:00Z',
              },
              end: {
                dateTime: '2026-04-01T23:00:00Z',
              },
              location: 'Field 2',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'google-token',
          GOOGLE_CALENDAR_IDS: 'primary,family@group.calendar.google.com',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Tomorrow has 2 timed events.');
    expect(reply).toContain('3:00 PM-3:30 PM School pickup');
    expect(reply).toContain('5:00 PM-6:00 PM Soccer practice @ Field 2');
    expect(reply).toContain('[Jeff]');
    expect(reply).toContain('[Family]');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refreshes a Google access token when only a refresh token is configured', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-google-token',
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          summary: 'Jeff',
          items: [
            {
              id: 'google-3',
              summary: 'Family dinner',
              start: {
                dateTime: '2026-04-01T23:00:00Z',
              },
              end: {
                dateTime: '2026-04-02T00:00:00Z',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
          GOOGLE_CALENDAR_CLIENT_ID: 'client-id',
          GOOGLE_CALENDAR_CLIENT_SECRET: 'client-secret',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Family dinner');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads Outlook events through Microsoft Graph', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).toContain('graph.microsoft.com/v1.0/me/calendarView');
      return new Response(
        JSON.stringify({
          value: [
            {
              id: 'evt-1',
              subject: 'Product sync',
              isAllDay: false,
              start: {
                dateTime: '2026-04-01T15:00:00',
                timeZone: 'UTC',
              },
              end: {
                dateTime: '2026-04-01T16:00:00',
                timeZone: 'UTC',
              },
              location: {
                displayName: 'Zoom',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          OUTLOOK_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Tomorrow has one timed event.');
    expect(reply).toContain('10:00 AM-11:00 AM Product sync @ Zoom');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes an Outlook access token when only a refresh token is configured', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/oauth2/v2.0/token')) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-token',
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          value: [
            {
              id: 'evt-2',
              subject: 'Quarterly review',
              isAllDay: false,
              start: {
                dateTime: '2026-04-01T18:00:00',
                timeZone: 'UTC',
              },
              end: {
                dateTime: '2026-04-01T19:00:00',
                timeZone: 'UTC',
              },
            },
          ],
        }),
        { status: 200 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          OUTLOOK_CALENDAR_REFRESH_TOKEN: 'refresh-token',
          OUTLOOK_CALENDAR_CLIENT_ID: 'client-id',
          OUTLOOK_CALENDAR_TENANT_ID: 'common',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Quarterly review');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads CalDAV events from calendar data', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <propstat>
      <prop>
        <c:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
UID:caldav-1
DTSTART:20260401T150000Z
DTEND:20260401T153000Z
SUMMARY:Dentist
LOCATION:Main Street
END:VEVENT
END:VCALENDAR</c:calendar-data>
      </prop>
    </propstat>
  </response>
</multistatus>`;

    const fetchImpl = vi.fn(async () => new Response(xml, { status: 207 }));

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          APPLE_CALDAV_URL: 'https://example.com/caldav/calendar',
          APPLE_CALDAV_USERNAME: 'jeff@example.com',
          APPLE_CALDAV_PASSWORD: 'secret',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Dentist @ Main Street');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports open availability when configured providers return no events', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ value: [] }), { status: 200 }),
    );

    const reply = await buildCalendarAssistantReply(
      'Am I free tomorrow afternoon?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          OUTLOOK_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toBe('You look open tomorrow afternoon.');
  });

  it('summarizes partial open time after a requested boundary', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'google-7',
                summary: 'School pickup',
                start: {
                  dateTime: '2026-04-01T20:00:00Z',
                },
                end: {
                  dateTime: '2026-04-01T20:30:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      'Am I free after 3 tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("You're partly open after 3 PM tomorrow.");
    expect(reply).toContain('3:00 PM-3:30 PM School pickup');
    expect(reply).toContain('Open: 3:30 PM-12:00 AM');
  });

  it('checks duration-fit availability against the full interval', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'google-8',
                summary: 'Project sync',
                start: {
                  dateTime: '2026-04-01T21:30:00Z',
                },
                end: {
                  dateTime: '2026-04-01T22:00:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      'Do I have time at 4 for a one-hour meeting tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("don't have a full 1 hour at 4 PM tomorrow");
    expect(reply).toContain('4:30 PM-5:00 PM Project sync');
  });

  it('reports back-to-back meetings as clusters', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'google-9',
                summary: '1:1',
                start: {
                  dateTime: '2026-04-01T15:00:00Z',
                },
                end: {
                  dateTime: '2026-04-01T15:30:00Z',
                },
              },
              {
                id: 'google-10',
                summary: 'Team sync',
                start: {
                  dateTime: '2026-04-01T15:40:00Z',
                },
                end: {
                  dateTime: '2026-04-01T16:10:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      'Do I have back-to-back meetings tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('You do have back-to-back meetings tomorrow:');
    expect(reply).toContain(
      '10:00 AM-10:30 AM 1:1 -> 10:40 AM-11:10 AM Team sync',
    );
  });

  it('asks a concise follow-up for vague anchors', async () => {
    const response = await buildCalendarAssistantResponse(
      'What do I have after work today?',
      {
        now: new Date('2026-04-01T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
      },
    );

    expect(response?.reply).toBe('What time counts as after work?');
  });

  it('records active event context only for a single Google event', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'evt-1',
                summary: 'Dentist appointment',
                htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
                start: {
                  dateTime: '2026-04-02T19:00:00Z',
                },
                end: {
                  dateTime: '2026-04-02T20:00:00Z',
                },
              },
            ],
          }),
        ),
    );

    const response = await buildCalendarAssistantResponse(
      'Do I have anything at 2pm tomorrow?',
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(response?.activeEventContext?.id).toBe('evt-1');
    expect(response?.activeEventContext?.calendarId).toBe('primary');
  });

  it('does not record active event context for multi-event agenda replies', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'evt-1',
                summary: 'Dentist appointment',
                start: {
                  dateTime: '2026-04-02T19:00:00Z',
                },
                end: {
                  dateTime: '2026-04-02T20:00:00Z',
                },
              },
              {
                id: 'evt-2',
                summary: 'Soccer practice',
                start: {
                  dateTime: '2026-04-02T22:00:00Z',
                },
                end: {
                  dateTime: '2026-04-02T23:00:00Z',
                },
              },
            ],
          }),
        ),
    );

    const response = await buildCalendarAssistantResponse(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(response?.activeEventContext).toBeNull();
  });

  it('checks exact-time overlap conservatively for Google availability', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Family',
            items: [
              {
                id: 'google-4',
                summary: 'Dental appointment',
                start: {
                  dateTime: '2026-04-01T19:30:00Z',
                },
                end: {
                  dateTime: '2026-04-01T20:30:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      'Do I have anything at 3pm tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("You're not free at 3 PM tomorrow.");
    expect(reply).toContain('2:30 PM-3:30 PM Dental appointment');
  });

  it('formats Google all-day events as all day', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Family',
            items: [
              {
                id: 'google-5',
                summary: 'Spring break',
                start: {
                  date: '2026-04-01',
                },
                end: {
                  date: '2026-04-02',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('All day Spring break');
  });

  it('does not leak a next-day all-day event into tomorrow agenda results', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Family',
            items: [
              {
                id: 'google-5b',
                summary: 'Friday all day',
                start: {
                  date: '2026-04-03',
                },
                end: {
                  date: '2026-04-04',
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-04-01T11:40:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toBe("I don't see anything on your calendar tomorrow.");
  });

  it('fails clearly instead of claiming open time when Google access fails', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Request had invalid authentication credentials.',
            },
          }),
          { status: 401 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      'Do I have anything at 3pm tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'bad-token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("I can't confirm your calendar right now");
    expect(reply).not.toContain('You look free');
    expect(reply).not.toContain("I don't see anything");
  });

  it('shows confirmed Google events with a partial warning when one configured calendar fails', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/calendars/primary/events')) {
        return new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [
              {
                id: 'google-6',
                summary: 'Doctor visit',
                start: {
                  dateTime: '2026-04-01T16:00:00Z',
                },
                end: {
                  dateTime: '2026-04-01T17:00:00Z',
                },
              },
            ],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            message: 'Calendar not found.',
          },
        }),
        { status: 404 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar tomorrow?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,missing@group.calendar.google.com',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain('Doctor visit');
    expect(reply).toContain(
      "I couldn't confirm every configured calendar right now.",
    );
    expect(reply).toContain('missing@group.calendar.google.com');
  });

  it('does not claim empty or free time when Google results are incomplete', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/calendars/primary/events')) {
        return new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: [],
          }),
          { status: 200 },
        );
      }

      return new Response(
        JSON.stringify({
          error: {
            message: 'Not Found',
          },
        }),
        { status: 404 },
      );
    });

    const reply = await buildCalendarAssistantReply(
      'Do I have anything at 3pm tomorrow?',
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,missing@group.calendar.google.com',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("I didn't find anything blocking at 3 PM tomorrow");
    expect(reply).toContain(
      "I couldn't confirm every configured calendar right now.",
    );
    expect(reply).not.toContain('You look free');
  });

  it('fails clearly on malformed Google payloads', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: 'Jeff',
            items: 'not-an-array',
          }),
          { status: 200 },
        ),
    );

    const reply = await buildCalendarAssistantReply(
      "What's on my calendar this week?",
      {
        now: new Date('2026-03-31T23:55:00-05:00'),
        timeZone: 'America/Chicago',
        platform: 'win32',
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        },
        fetchImpl,
      },
    );

    expect(reply).toContain("I can't confirm your calendar right now");
    expect(reply).toContain('invalid events payload');
  });
});
