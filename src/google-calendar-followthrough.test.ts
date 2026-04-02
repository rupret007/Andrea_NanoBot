import { describe, expect, it } from 'vitest';

import {
  advancePendingCalendarReminder,
  advancePendingGoogleCalendarEventAction,
  buildActiveGoogleCalendarEventContextState,
  buildPendingCalendarReminderStateFromMatches,
  buildSameDaySuggestions,
  matchGoogleCalendarTrackedEvents,
  planCalendarEventReminder,
  planGoogleCalendarEventAction,
  resolveCalendarReminderLookup,
} from './google-calendar-followthrough.js';

const familyCalendars = [
  {
    id: 'primary',
    summary: 'Jeff',
    primary: true,
    accessRole: 'owner',
    writable: true,
    selected: true,
  },
  {
    id: 'family@group.calendar.google.com',
    summary: 'Family',
    primary: false,
    accessRole: 'writer',
    writable: true,
    selected: true,
  },
] as const;

const dentistEvent = {
  id: 'evt-1',
  title: 'Dentist appointment',
  startIso: '2026-04-02T19:00:00.000Z',
  endIso: '2026-04-02T20:00:00.000Z',
  allDay: false,
  calendarId: 'family@group.calendar.google.com',
  calendarName: 'Family',
  htmlLink: 'https://calendar.google.com/calendar/event?eid=dentist',
};

describe('calendar follow-through reminders', () => {
  it('parses named event reminders into a lookup request', () => {
    const result = planCalendarEventReminder(
      'remind me 30 minutes before my dentist appointment',
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(result.kind).toBe('lookup');
    if (result.kind !== 'lookup') return;
    expect(result.queryText).toBe('dentist');
  });

  it('uses the active event context for pronoun-based reminders', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const result = planCalendarEventReminder(
      'remind me an hour before that meeting',
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    expect(result.message).toContain('1 hour before');
  });

  it('asks for an offset before the next meeting when none is provided', () => {
    const result = planCalendarEventReminder(
      'remind me before my next meeting',
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(result.kind).toBe('lookup');
    if (result.kind !== 'lookup') return;
    expect(result.selectorMode).toBe('next_timed');
    expect(result.queryText).toBeNull();
  });

  it('targets the first timed event tomorrow when asked', () => {
    const result = planCalendarEventReminder(
      'remind me before my first event tomorrow',
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(result.kind).toBe('lookup');
    if (result.kind !== 'lookup') return;
    expect(result.selectorMode).toBe('first_timed_in_window');
    expect(result.searchStart.toISOString()).toBe('2026-04-02T05:00:00.000Z');
    expect(result.searchEnd.toISOString()).toBe('2026-04-03T05:00:00.000Z');
  });

  it('asks for an exact time for night-before reminders', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const result = planCalendarEventReminder(
      'remind me the night before that meeting',
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_time');
    expect(result.message).toContain('What time should I use the night before');
  });

  it('asks for clarification when multiple event matches exist', () => {
    const result = buildPendingCalendarReminderStateFromMatches({
      events: [
        dentistEvent,
        {
          ...dentistEvent,
          id: 'evt-2',
          startIso: '2026-04-03T19:00:00.000Z',
          endIso: '2026-04-03T20:00:00.000Z',
        },
      ],
      offset: {
        kind: 'minutes_before',
        minutes: 30,
        label: '30 minutes before',
      },
      targetLabel: 'dentist appointment',
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_event');
    const selected = advancePendingCalendarReminder('2', result.state);
    expect(selected.kind).toBe('awaiting_input');
  });

  it('matches events by normalized title tokens', () => {
    const matches = matchGoogleCalendarTrackedEvents(
      [
        dentistEvent,
        {
          ...dentistEvent,
          id: 'evt-2',
          title: 'Soccer practice',
        },
      ],
      'dentist appointment',
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]?.id).toBe('evt-1');
  });

  it('builds a grouped confirmation for timed events in a requested range', () => {
    const result = resolveCalendarReminderLookup({
      events: [
        {
          id: 'evt-1',
          title: 'Soccer practice',
          startIso: '2026-04-02T19:00:00.000Z',
          endIso: '2026-04-02T20:00:00.000Z',
          allDay: false,
          calendarId: 'family@group.calendar.google.com',
          calendarName: 'Family',
        },
        {
          id: 'evt-2',
          title: 'Dinner reservation',
          startIso: '2026-04-02T21:00:00.000Z',
          endIso: '2026-04-02T22:00:00.000Z',
          allDay: false,
          calendarId: 'primary',
          calendarName: 'Jeff',
        },
      ],
      offset: {
        kind: 'minutes_before',
        minutes: 30,
        label: '30 minutes before',
      },
      targetLabel: 'anything on my calendar tomorrow afternoon',
      selectorMode: 'all_timed_in_window',
      queryText: null,
      scopeFilter: null,
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    expect(result.state.targetEvents).toHaveLength(2);
    expect(result.message).toContain('I can set 2 reminders');
  });

  it('asks the user to narrow a grouped reminder range with too many matches', () => {
    const result = resolveCalendarReminderLookup({
      events: [1, 2, 3, 4].map((index) => ({
        id: `evt-${index}`,
        title: `Event ${index}`,
        startIso: `2026-04-02T1${index}:00:00.000Z`,
        endIso: `2026-04-02T1${index}:30:00.000Z`,
        allDay: false,
        calendarId: 'primary',
        calendarName: 'Jeff',
      })),
      offset: {
        kind: 'minutes_before',
        minutes: 30,
        label: '30 minutes before',
      },
      targetLabel: 'anything on my calendar tomorrow afternoon',
      selectorMode: 'all_timed_in_window',
      queryText: null,
      scopeFilter: null,
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.message).toContain('more than 3 events');
  });

  it('keeps selector-based reminders honest when calendar reads are partial', () => {
    const result = resolveCalendarReminderLookup({
      events: [
        {
          ...dentistEvent,
        },
      ],
      failures: ['Family calendar unavailable'],
      offset: {
        kind: 'unspecified_before',
        minutes: null,
        label: 'before',
      },
      targetLabel: 'your next meeting',
      selectorMode: 'next_timed',
      queryText: null,
      scopeFilter: null,
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('invalid');
    if (result.kind !== 'invalid') return;
    expect(result.message).toContain("couldn't read every configured calendar");
  });

  it('asks for an explicit reminder time for all-day events', () => {
    const result = buildPendingCalendarReminderStateFromMatches({
      events: [
        {
          ...dentistEvent,
          allDay: true,
          startIso: '2026-04-03T05:00:00.000Z',
          endIso: '2026-04-04T05:00:00.000Z',
        },
      ],
      offset: {
        kind: 'minutes_before',
        minutes: 30,
        label: '30 minutes before',
      },
      targetLabel: 'dentist appointment',
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('clarify_time');
    expect(result.message).toContain('all day');
  });

  it('filters family calendar reminder asks by shared calendar metadata', () => {
    const result = planCalendarEventReminder(
      'remind me before the family calendar event on friday',
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(result.kind).toBe('lookup');
    if (result.kind !== 'lookup') return;
    expect(result.selectorMode).toBe('single_in_window');
    expect(result.scopeFilter?.kind).toBe('family_shared');
  });

  it('keeps tomorrow family reminder lookups inside the requested day window', () => {
    const plan = planCalendarEventReminder(
      'remind me 30 minutes before the family calendar event tomorrow',
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(plan.kind).toBe('lookup');
    if (plan.kind !== 'lookup') return;

    const result = resolveCalendarReminderLookup({
      events: [
        {
          id: 'evt-family-tomorrow',
          title: 'Family closeout proof',
          startIso: '2026-04-02T16:00:00.000Z',
          endIso: '2026-04-02T17:00:00.000Z',
          allDay: false,
          calendarId: 'family@group.calendar.google.com',
          calendarName: 'Family',
        },
        {
          id: 'evt-family-friday',
          title: 'Google all-day proof',
          startIso: '2026-04-03T05:00:00.000Z',
          endIso: '2026-04-04T05:00:00.000Z',
          allDay: true,
          calendarId: 'family@group.calendar.google.com',
          calendarName: 'Family',
        },
      ],
      offset: plan.offset,
      targetLabel: plan.targetLabel,
      selectorMode: plan.selectorMode,
      queryText: plan.queryText,
      scopeFilter: plan.scopeFilter,
      searchStart: plan.searchStart,
      searchEnd: plan.searchEnd,
      now: new Date('2026-04-01T10:00:00-05:00'),
    });

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm');
    expect(result.state.targetEvent?.id).toBe('evt-family-tomorrow');
    expect(result.message).toContain('Family closeout proof');
    expect(result.message).not.toContain('Google all-day proof');
  });
});

describe('calendar follow-through event actions', () => {
  it('does not treat plain calendar reads as event actions', () => {
    const result = planGoogleCalendarEventAction(
      "What's on my calendar tomorrow?",
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      null,
    );

    expect(result.kind).toBe('none');
  });

  it('does not intercept draft scheduling phrasing meant for calendar create', () => {
    const result = planGoogleCalendarEventAction(
      'Put that on my calendar Friday afternoon',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      null,
    );

    expect(result.kind).toBe('none');
  });

  it('asks for a target when no event context exists', () => {
    const result = planGoogleCalendarEventAction(
      'move that to 4',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      null,
    );

    expect(result.kind).toBe('needs_event_context');
  });

  it('builds a timed move from the active event context', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const result = planGoogleCalendarEventAction(
      'move that to 4',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.action).toBe('move');
    expect(result.state.proposedEvent?.startIso).toBe(
      '2026-04-02T21:00:00.000Z',
    );
  });

  it('builds a duration change for shorten-it phrasing', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const result = planGoogleCalendarEventAction(
      'shorten it to 30 minutes',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.action).toBe('resize');
    expect(result.state.proposedEvent?.endIso).toBe('2026-04-02T19:30:00.000Z');
  });

  it('builds a calendar reassignment when the family calendar is named', () => {
    const context = buildActiveGoogleCalendarEventContextState({
      ...dentistEvent,
      calendarId: 'primary',
      calendarName: 'Jeff',
    });
    const result = planGoogleCalendarEventAction(
      'put it on the family calendar instead',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.action).toBe('reassign');
    expect(result.state.selectedCalendarId).toBe(
      'family@group.calendar.google.com',
    );
  });

  it('builds a delete confirmation for cancel-that-event', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const result = planGoogleCalendarEventAction(
      'cancel that event',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.action).toBe('delete');
  });

  it('supports anchor-based moves and follow-up confirmation', () => {
    const context = buildActiveGoogleCalendarEventContextState(dentistEvent);
    const planned = planGoogleCalendarEventAction(
      'move it after my 2pm meeting',
      [...familyCalendars],
      new Date('2026-04-01T10:00:00-05:00'),
      context,
    );

    expect(planned.kind).toBe('resolve_anchor');
    if (planned.kind !== 'resolve_anchor') return;

    const moved = advancePendingGoogleCalendarEventAction('move that to 4', {
      ...planned.state,
      action: 'move',
      proposedEvent: dentistEvent,
    });
    expect(moved.kind).toBe('awaiting_input');
  });

  it('offers same-day slot suggestions around a blocked interval', () => {
    const suggestions = buildSameDaySuggestions({
      events: [
        {
          ...dentistEvent,
          id: 'evt-2',
          startIso: '2026-04-02T21:00:00.000Z',
          endIso: '2026-04-02T21:30:00.000Z',
        },
      ],
      sourceEventId: 'evt-1',
      targetStart: new Date('2026-04-02T21:00:00.000Z'),
      durationMinutes: 30,
      timeZone: 'America/Chicago',
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.startIso).toBe('2026-04-02T21:30:00.000Z');
  });
});
