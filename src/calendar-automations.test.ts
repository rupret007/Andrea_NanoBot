import { describe, expect, it, vi } from 'vitest';

import {
  advancePendingCalendarAutomation,
  executeCalendarAutomation,
  planCalendarAutomation,
  type CalendarAutomationConfig,
  type CalendarAutomationDedupeState,
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
  overrides: Partial<CalendarAutomationSummary> & {
    config?: CalendarAutomationConfig;
    dedupeState?: CalendarAutomationDedupeState | null;
  },
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
  it('creates a weekday morning brief automation draft', async () => {
    const result = await planCalendarAutomation(
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
    expect(result.message).toContain('Scope: All calendars');
  });

  it('creates a family weekly summary automation draft', async () => {
    const result = await planCalendarAutomation(
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
    expect(result.message).toContain('Scope: Family/shared');
  });

  it('lists automations with type, scope, status, and next-run preview', async () => {
    const result = await planCalendarAutomation(
      'Show my calendar automations',
      new Date('2026-04-01T10:00:00-05:00'),
      [
        createAutomationSummary({}),
        createAutomationSummary({
          taskId: 'task-2',
          label: 'Family calendar summary every sunday at 8:00 PM',
          status: 'paused',
          config: {
            kind: 'briefing',
            scopeKind: 'family_shared',
            schedule: {
              kind: 'cron',
              triggerKind: 'weekly',
              weekday: 0,
              hour: 20,
              minute: 0,
              scheduleType: 'cron',
              scheduleValue: '0 20 * * 0',
              description: 'every sunday at 8:00 PM',
            },
            query: "What's on the family calendar this week?",
            anchorOffsetDays: 1,
          },
        }),
      ],
    );

    expect(result.kind).toBe('list');
    if (result.kind !== 'list') return;
    expect(result.message).toContain('1 active, 1 paused.');
    expect(result.message).toContain('Briefing: Morning brief');
    expect(result.message).toContain('Scope: All calendars');
    expect(result.message).toContain('Scope: Family/shared');
    expect(result.message).toContain('Next when resumed');
  });

  it('filters automation list to active entries only', async () => {
    const result = await planCalendarAutomation(
      'Which schedule automations are active?',
      new Date('2026-04-01T10:00:00-05:00'),
      [
        createAutomationSummary({}),
        createAutomationSummary({
          taskId: 'task-2',
          label: 'Family calendar summary every sunday at 8:00 PM',
          status: 'paused',
        }),
      ],
    );

    expect(result.kind).toBe('list');
    if (result.kind !== 'list') return;
    expect(result.message).toContain('1 active.');
    expect(result.message).toContain('Morning brief');
    expect(result.message).not.toContain('Family calendar summary');
  });

  it('asks for a time when a one-time watch automation omits one', async () => {
    const result = await planCalendarAutomation(
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
  });

  it('asks for an offset when a recurring next-meeting reminder omits one', async () => {
    const result = await planCalendarAutomation(
      'Remind me before my next meeting every workday',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_offset');
  });

  it('offers to resume an exact paused automation instead of duplicating it', async () => {
    const result = await planCalendarAutomation(
      'Send me a morning brief every weekday at 7 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({ status: 'paused' })],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('resume');
    expect(result.message).toContain('is paused');
  });

  it('offers to replace a matching active automation with a changed schedule', async () => {
    const result = await planCalendarAutomation(
      'Send me a morning brief every weekday at 6:30 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({})],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('replace');
  });

  it('supports pause and resume management flows', async () => {
    const paused = createAutomationSummary({ status: 'paused' });
    const pause = await planCalendarAutomation(
      'Turn off my morning brief',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({})],
    );
    expect(pause.kind).toBe('awaiting_input');
    if (pause.kind !== 'awaiting_input') return;
    expect(pause.state.step).toBe('confirm');
    if (pause.state.step !== 'confirm') return;
    expect(pause.state.mode).toBe('pause');

    const resume = await planCalendarAutomation(
      'Resume the morning brief',
      new Date('2026-04-01T10:00:00-05:00'),
      [paused],
    );
    expect(resume.kind).toBe('awaiting_input');
    if (resume.kind !== 'awaiting_input') return;
    expect(resume.state.step).toBe('confirm');
    if (resume.state.step !== 'confirm') return;
    expect(resume.state.mode).toBe('resume');
  });

  it('supports change phrasing for schedule updates', async () => {
    const result = await planCalendarAutomation(
      'Change the morning brief to 8 PM',
      new Date('2026-04-01T10:00:00-05:00'),
      [createAutomationSummary({})],
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.mode).toBe('replace');
    expect(result.message).toContain(
      'New: Morning brief every weekday at 8:00 PM',
    );
  });

  it('resolves a friendly named calendar scope when it matches one configured calendar', async () => {
    const result = await planCalendarAutomation(
      'Send me a brief for the Musak calendar every weekday at 7 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
      {
        configuredCalendars: [
          {
            id: 'primary',
            summary: 'Jeff',
            primary: true,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
          {
            id: 'musak',
            summary: 'Musak Calendar',
            primary: false,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
        ],
      },
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    if (result.state.step !== 'confirm') return;
    expect(result.state.draft.config.scopeKind).toBe('named_calendar');
    expect(result.state.draft.config.scopeCalendarId).toBe('musak');
    expect(result.message).toContain('Scope: Musak Calendar');
  });

  it('asks briefly when multiple named calendars match', async () => {
    const result = await planCalendarAutomation(
      'Send me a brief for the Story calendar every weekday at 7 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
      {
        configuredCalendars: [
          {
            id: 'story-1',
            summary: 'Jeff Story',
            primary: false,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
          {
            id: 'story-2',
            summary: 'Jeff & Candace Story',
            primary: false,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
        ],
      },
    );

    expect(result.kind).toBe('list');
    if (result.kind !== 'list') return;
    expect(result.message).toContain('more than one configured calendar');
    expect(result.message).toContain('Jeff Story');
    expect(result.message).toContain('Jeff & Candace Story');
  });

  it('fails clearly when a named calendar is not configured', async () => {
    const result = await planCalendarAutomation(
      'Send me a brief for the Soccer calendar every weekday at 7 AM',
      new Date('2026-04-01T10:00:00-05:00'),
      [],
      {
        configuredCalendars: [
          {
            id: 'primary',
            summary: 'Jeff',
            primary: true,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
          {
            id: 'musak',
            summary: 'Musak Calendar',
            primary: false,
            accessRole: 'owner',
            writable: true,
            selected: true,
          },
        ],
      },
    );

    expect(result.kind).toBe('list');
    if (result.kind !== 'list') return;
    expect(result.message).toContain(
      'couldn\'t find a configured calendar matching "soccer"',
    );
    expect(result.message).toContain('Musak Calendar');
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

    expect(first.message).toContain('Good morning -');
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

    const result = await executeCalendarAutomation(
      createAutomationSummary({}),
      {
        now: new Date('2026-04-01T07:00:00-05:00'),
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,family',
        },
        fetchImpl,
      },
    );

    expect(result.message).toContain('Good morning -');
    expect(result.message).toMatch(
      /I couldn't (?:read|confirm) every configured calendar right now\./,
    );
  });

  it('scopes reminder automations to a named calendar', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      calendarList: [
        { id: 'primary', summary: 'Jeff', primary: true },
        { id: 'musak', summary: 'Musak Calendar' },
      ],
      eventsByCalendar: {
        primary: {
          summary: 'Jeff',
          items: [
            {
              id: 'evt-primary',
              summary: 'Primary meeting',
              start: { dateTime: '2026-04-01T20:00:00Z' },
              end: { dateTime: '2026-04-01T21:00:00Z' },
            },
          ],
        },
        musak: {
          summary: 'Musak Calendar',
          items: [
            {
              id: 'evt-musak',
              summary: 'Band rehearsal',
              start: { dateTime: '2026-04-01T20:00:00Z' },
              end: { dateTime: '2026-04-01T21:00:00Z' },
            },
          ],
        },
      },
    });

    const result = await executeCalendarAutomation(
      createAutomationSummary({
        label: 'Next-meeting reminder every day (30 minutes before)',
        config: {
          kind: 'event_reminder',
          scopeKind: 'named_calendar',
          scopeCalendarId: 'musak',
          scopeCalendarSummary: 'Musak Calendar',
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
      }),
      {
        now: new Date('2026-04-01T14:30:00-05:00'),
        env: {
          GOOGLE_CALENDAR_ACCESS_TOKEN: 'token',
          GOOGLE_CALENDAR_IDS: 'primary,musak',
        },
        fetchImpl,
      },
    );

    expect(result.message).toContain('Band rehearsal');
    expect(result.message).not.toContain('Primary meeting');
  });

  it('suppresses repeated event reminders using persisted dedupe state', async () => {
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
      dedupeState: {
        version: 1,
        keys: ['reminder:evt-1:2026-04-01T19:30:00.000Z:30'],
        updatedAt: '2026-04-01T19:30:00.000Z',
      },
    });

    const result = await executeCalendarAutomation(automation, {
      now: new Date('2026-04-01T14:30:00-05:00'),
      env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
      fetchImpl,
    });

    expect(result.message).toBeNull();
    expect(result.summary).toContain('Skipped duplicate');
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

    const result = await executeCalendarAutomation(
      createAutomationSummary({
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
      }),
      {
        now: new Date('2026-04-01T10:00:00-05:00'),
        env: { GOOGLE_CALENDAR_ACCESS_TOKEN: 'token' },
        fetchImpl,
      },
    );

    expect(result.message).toContain("doesn't have a 30-minute opening");
  });
});
