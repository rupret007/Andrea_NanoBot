import { describe, expect, it, vi } from 'vitest';

import {
  advancePendingCalendarAutomation,
  executeCalendarAutomation,
  planCalendarAutomation,
  type CalendarAutomationSummary,
} from './calendar-automations.js';

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
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'token' }), {
        status: 200,
      });
    }

    if (url.includes('/users/me/calendarList')) {
      return new Response(
        JSON.stringify({
          items:
            input.calendarList?.map((calendar) => ({
              ...calendar,
              selected: calendar.selected ?? true,
              primary: calendar.primary ?? false,
              accessRole: 'owner',
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

    return new Response(JSON.stringify({ error: { message: url } }), {
      status: 404,
    });
  });
}

function createAutomationSummary(
  overrides: Partial<CalendarAutomationSummary>,
): CalendarAutomationSummary {
  return {
    taskId: 'task-1',
    chatJid: 'chat-1',
    groupFolder: 'main',
    label: 'Morning brief every weekday at 7:00 AM',
    status: 'active',
    nextRun: '2026-04-02T12:00:00.000Z',
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-01T12:00:00.000Z',
    config: {
      kind: 'briefing',
      scopeKind: 'all',
      schedule: {
        kind: 'cron',
        triggerKind: 'weekdays',
        weekday: null,
        hour: 7,
        minute: 0,
        scheduleType: 'cron',
        scheduleValue: '0 7 * * 1-5',
        description: 'every weekday at 7:00 AM',
      },
      query: 'What should I know about today?',
      anchorOffsetDays: 0,
    },
    dedupeState: null,
    ...overrides,
  };
}

describe('planCalendarAutomation', () => {
  it('creates a weekday morning brief automation draft', () => {
    const result = planCalendarAutomation(
      'Send me a morning brief every weekday at 7 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('create');
    expect(result.state.draft.label).toContain('Morning brief');
    expect(result.state.draft.label).toContain('every weekday at 7:00 AM');
  });

  it('creates a family weekly summary automation draft', () => {
    const result = planCalendarAutomation(
      'Send me a family calendar summary every Sunday night',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.draft.config.kind).toBe('briefing');
    expect(result.state.draft.config.scopeKind).toBe('family_shared');
    expect(result.state.draft.label).toContain('Family calendar summary');
    expect(result.state.draft.label).toContain('every sunday at 8:00 PM');
  });

  it('asks for a time when a one-time watch automation omits one', () => {
    const result = planCalendarAutomation(
      'Let me know if tomorrow afternoon has no 30-minute gaps',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_time');

    const next = advancePendingCalendarAutomation(
      '10 AM',
      result.state,
      new Date('2026-04-01T10:01:00-05:00'),
    );
    expect(next.kind).toBe('awaiting_input');
    if (next.kind !== 'awaiting_input') return;
    expect(next.state.step).toBe('confirm');
    if (next.state.step !== 'confirm') return;
    expect(next.state.draft.config.schedule.kind).toBe('once');
    if (next.state.draft.config.schedule.kind !== 'once') return;
    expect(next.state.draft.config.schedule.runAtIso).toContain('2026-04-02');
  });

  it('asks for an offset when a recurring next-meeting reminder omits one', () => {
    const result = planCalendarAutomation(
      'Remind me before my next meeting every workday',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_offset');

    const next = advancePendingCalendarAutomation(
      '30 minutes before',
      result.state,
      new Date('2026-04-01T10:01:00-05:00'),
    );
    expect(next.kind).toBe('awaiting_input');
    if (next.kind !== 'awaiting_input') return;
    expect(next.state.step).toBe('confirm');
  });

  it('creates a family-scoped first-event reminder automation', () => {
    const result = planCalendarAutomation(
      'Remind me 1 hour before my first event on the family calendar every workday',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.draft.config.kind).toBe('event_reminder');
    if (result.state.draft.config.kind !== 'event_reminder') return;
    expect(result.state.draft.config.selector).toBe('first_event_today');
    expect(result.state.draft.config.scopeKind).toBe('family_shared');
    expect(result.state.draft.config.offsetMinutes).toBe(60);
    expect(result.state.draft.label).toContain('First-event reminder');
  });

  it('offers to replace a matching existing automation', () => {
    const existing = [
      createAutomationSummary({
        label: 'Morning brief every weekday at 7:00 AM',
      }),
    ];
    const result = planCalendarAutomation(
      'Send me a morning brief every weekday at 6:30 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      existing,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('replace');
    expect(result.message).toContain('Current: Morning brief');
  });

  it('lists current automations concisely', () => {
    const result = planCalendarAutomation(
      'Show my calendar automations',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({})],
    );

    expect(result.kind).toBe('list');
    if (result.kind !== 'list') return;
    expect(result.message).toContain('Your calendar automations:');
    expect(result.message).toContain('Morning brief');
  });

  it('offers to disable a matching automation', () => {
    const result = planCalendarAutomation(
      'Turn off my morning brief',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({})],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('disable');
    expect(result.message).toContain('turn off this automation');
  });
});

describe('executeCalendarAutomation', () => {
  it('sends a real briefing message once per window', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Project sync',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
      },
    });
    const automation = createAutomationSummary({});

    const first = await executeCalendarAutomation(automation, {
      now: new Date('2026-04-01T07:00:00-05:00'),
      env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
      fetchImpl,
    });

    expect(first.message).toContain('The rest of today has 1 timed event');
    expect(first.dedupeState?.keys).toHaveLength(1);

    const second = await executeCalendarAutomation(
      {
        ...automation,
        dedupeState: first.dedupeState,
      },
      {
        now: new Date('2026-04-01T07:01:00-05:00'),
        env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
        fetchImpl,
      },
    );

    expect(second.message).toBeNull();
    expect(second.summary).toContain('Skipped duplicate');
  });

  it('mentions incomplete reads instead of overclaiming in a briefing', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Project sync',
              start: { dateTime: '2026-04-01T21:00:00Z' },
              end: { dateTime: '2026-04-01T22:00:00Z' },
            },
          ],
        },
        family: {
          status: 403,
          body: { error: { message: 'forbidden' } },
        },
      },
    });
    const automation = createAutomationSummary({});

    const result = await executeCalendarAutomation(automation, {
      now: new Date('2026-04-01T07:00:00-05:00'),
      env: {
        GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
        GOOGLE_CALENDAR_IDS: 'primary,family',
      },
      fetchImpl,
    });

    expect(result.message).toContain('The rest of today has 1 timed event');
    expect(result.message).toMatch(
      /I couldn't (?:read|confirm) every configured calendar right now\./,
    );
  });

  it('emits a no-gap watch message when there are no 30-minute openings', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Meeting 1',
              start: { dateTime: '2026-04-02T17:00:00Z' },
              end: { dateTime: '2026-04-02T18:30:00Z' },
            },
            {
              id: 'evt-2',
              summary: 'Meeting 2',
              start: { dateTime: '2026-04-02T18:30:00Z' },
              end: { dateTime: '2026-04-02T20:00:00Z' },
            },
            {
              id: 'evt-3',
              summary: 'Meeting 3',
              start: { dateTime: '2026-04-02T20:00:00Z' },
              end: { dateTime: '2026-04-02T22:00:00Z' },
            },
          ],
        },
      },
    });
    const automation = createAutomationSummary({
      label: 'No-30-minute-gap watch for tomorrow afternoon at 10:00 AM',
      config: {
        kind: 'watch',
        scopeKind: 'all',
        schedule: {
          kind: 'once',
          triggerKind: 'once',
          runAtIso: '2026-04-01T15:00:00.000Z',
          hour: 10,
          minute: 0,
          scheduleType: 'once',
          scheduleValue: '2026-04-01T10:00:00',
          description: 'at 10:00 AM',
        },
        condition: 'no_gap',
        query: 'Do I have any gaps tomorrow afternoon?',
        minimumGapMinutes: 30,
      },
    });

    const result = await executeCalendarAutomation(automation, {
      now: new Date('2026-04-01T10:00:00-05:00'),
      env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
      fetchImpl,
    });

    expect(result.message).toContain('no 30-minute gaps');
  });

  it('sends a next-meeting reminder only when the offset is due', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-1',
              summary: 'Design review',
              start: { dateTime: '2026-04-01T20:00:00Z' },
              end: { dateTime: '2026-04-01T21:00:00Z' },
            },
          ],
        },
      },
    });
    const automation = createAutomationSummary({
      label: 'Next-meeting reminder every day (30 minutes before)',
      config: {
        kind: 'event_reminder',
        scopeKind: 'all',
        schedule: {
          kind: 'interval',
          triggerKind: 'daily',
          intervalMinutes: 5,
          scheduleType: 'interval',
          scheduleValue: String(5 * 60 * 1000),
          description: 'every day',
        },
        selector: 'next_meeting',
        offsetMinutes: 30,
        offsetLabel: '30 minutes before',
        weekdays: null,
      },
    });

    const result = await executeCalendarAutomation(automation, {
      now: new Date('2026-04-01T14:30:00-05:00'),
      env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
      fetchImpl,
    });

    expect(result.message).toContain('Design review');
    expect(result.message).toContain('starts Wed 3:00 PM');
  });
});
