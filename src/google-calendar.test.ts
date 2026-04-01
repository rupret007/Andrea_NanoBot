import { describe, expect, it, vi } from 'vitest';

import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  listGoogleCalendars,
  moveGoogleCalendarEvent,
  resolveGoogleCalendarConfig,
  updateGoogleCalendarEvent,
} from './google-calendar.js';

describe('resolveGoogleCalendarConfig', () => {
  it('defaults calendar ids to primary', () => {
    const config = resolveGoogleCalendarConfig({});
    expect(config.calendarIds).toEqual(['primary']);
  });
});

describe('listGoogleCalendars', () => {
  it('flags writable and selected calendars from calendarList', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'token' }), {
          status: 200,
        });
      }

      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'primary',
              summary: 'Jeff',
              primary: true,
              accessRole: 'owner',
            },
            {
              id: 'family@group.calendar.google.com',
              summary: 'Family',
              accessRole: 'writer',
            },
            {
              id: 'readonly@group.calendar.google.com',
              summary: 'Readonly',
              accessRole: 'reader',
            },
          ],
        }),
        { status: 200 },
      );
    });

    const calendars = await listGoogleCalendars(
      {
        accessToken: null,
        refreshToken: 'refresh',
        clientId: 'client',
        clientSecret: 'secret',
        calendarIds: ['primary', 'family@group.calendar.google.com'],
      },
      fetchImpl,
    );

    expect(calendars).toHaveLength(3);
    expect(calendars[0]).toMatchObject({
      id: 'primary',
      primary: true,
      writable: true,
      selected: true,
    });
    expect(calendars[1]?.id).toBe('family@group.calendar.google.com');
    expect(calendars[1]?.selected).toBe(true);
    expect(calendars[1]?.writable).toBe(true);
    expect(calendars[2]?.writable).toBe(false);
  });
});

describe('createGoogleCalendarEvent', () => {
  it('creates a timed event and parses the response', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'token' }), {
            status: 200,
          });
        }

        expect(init?.method).toBe('POST');
        expect(String(init?.body)).toContain('"summary":"Project sync"');
        return new Response(
          JSON.stringify({
            id: 'evt-1',
            summary: 'Project sync',
            htmlLink: 'https://calendar.google.com/calendar/event?eid=abc',
            start: {
              dateTime: '2026-04-02T21:00:00Z',
            },
            end: {
              dateTime: '2026-04-02T22:00:00Z',
            },
          }),
          { status: 200 },
        );
      },
    );

    const created = await createGoogleCalendarEvent(
      {
        calendarId: 'primary',
        title: 'Project sync',
        start: new Date('2026-04-02T21:00:00Z'),
        end: new Date('2026-04-02T22:00:00Z'),
        timeZone: 'America/Chicago',
        allDay: false,
      },
      {
        accessToken: null,
        refreshToken: 'refresh',
        clientId: 'client',
        clientSecret: 'secret',
        calendarIds: ['primary'],
      },
      fetchImpl,
    );

    expect(created.id).toBe('evt-1');
    expect(created.title).toBe('Project sync');
    expect(created.htmlLink).toContain('calendar.google.com');
  });
});

describe('google calendar event follow-through operations', () => {
  it('patches an existing timed event and parses the response', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'fresh-token' }));
        }
        expect(url).toContain('/calendars/primary/events/event-1');
        expect(init?.method).toBe('PATCH');
        return new Response(
          JSON.stringify({
            id: 'event-1',
            summary: 'Project sync',
            htmlLink: 'https://calendar.google.com/calendar/event?eid=patched',
            start: {
              dateTime: '2026-04-02T22:00:00Z',
            },
            end: {
              dateTime: '2026-04-02T22:30:00Z',
            },
            organizer: {
              displayName: 'Jeff',
            },
          }),
        );
      },
    );

    const updated = await updateGoogleCalendarEvent(
      {
        calendarId: 'primary',
        eventId: 'event-1',
        start: new Date('2026-04-02T22:00:00Z'),
        end: new Date('2026-04-02T22:30:00Z'),
        timeZone: 'America/Chicago',
        allDay: false,
      },
      {
        accessToken: null,
        refreshToken: 'refresh',
        clientId: 'client',
        clientSecret: 'secret',
        calendarIds: ['primary'],
      },
      fetchImpl,
    );

    expect(updated.id).toBe('event-1');
    expect(updated.startIso).toBe('2026-04-02T22:00:00.000Z');
    expect(updated.endIso).toBe('2026-04-02T22:30:00.000Z');
  });

  it('moves an event to another calendar', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'fresh-token' }));
        }
        expect(url).toContain('/events/event-1/move');
        expect(url).toContain('destination=family%40group.calendar.google.com');
        expect(init?.method).toBe('POST');
        return new Response(
          JSON.stringify({
            id: 'event-1',
            summary: 'Project sync',
            htmlLink: 'https://calendar.google.com/calendar/event?eid=moved',
            start: {
              dateTime: '2026-04-02T22:00:00Z',
            },
            end: {
              dateTime: '2026-04-02T22:30:00Z',
            },
            organizer: {
              displayName: 'Family',
            },
          }),
        );
      },
    );

    const moved = await moveGoogleCalendarEvent(
      {
        sourceCalendarId: 'primary',
        destinationCalendarId: 'family@group.calendar.google.com',
        eventId: 'event-1',
      },
      {
        accessToken: null,
        refreshToken: 'refresh',
        clientId: 'client',
        clientSecret: 'secret',
        calendarIds: ['primary'],
      },
      fetchImpl,
    );

    expect(moved.calendarId).toBe('family@group.calendar.google.com');
    expect(moved.calendarName).toBe('Family');
  });

  it('deletes an event cleanly', async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'fresh-token' }));
        }
        expect(url).toContain('/calendars/primary/events/event-1');
        expect(init?.method).toBe('DELETE');
        return new Response(null, { status: 204 });
      },
    );

    await expect(
      deleteGoogleCalendarEvent(
        {
          calendarId: 'primary',
          eventId: 'event-1',
        },
        {
          accessToken: null,
          refreshToken: 'refresh',
          clientId: 'client',
          clientSecret: 'secret',
          calendarIds: ['primary'],
        },
        fetchImpl,
      ),
    ).resolves.toBeUndefined();
  });
});
