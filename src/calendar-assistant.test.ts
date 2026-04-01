import { describe, expect, it, vi } from 'vitest';

import {
  buildCalendarAssistantResponse,
  buildCalendarAssistantReply,
  planCalendarAssistantLookup,
} from './calendar-assistant.js';

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

    expect(plan?.clarificationQuestion).toBe(
      'What time should I treat as after work?',
    );
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
});

describe('buildCalendarAssistantReply', () => {
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

    expect(reply).toContain("Here's what's on your calendar tomorrow:");
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

    expect(reply).toContain("Here's what's on your calendar tomorrow:");
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

    expect(response?.reply).toBe('What time should I treat as after work?');
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
      "I found these events, but I couldn't read every configured calendar right now.",
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
