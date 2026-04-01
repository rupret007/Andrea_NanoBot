import { describe, expect, it, vi } from 'vitest';

import {
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
    expect(reply).toContain('Apple Calendar directly on a Mac');
    expect(reply).toContain('Outlook calendars through Microsoft Graph');
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
});
