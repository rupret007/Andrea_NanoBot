import { describe, expect, it } from 'vitest';

import {
  advancePendingGoogleCalendarCreate,
  buildPendingGoogleCalendarCreateState,
  formatGoogleCalendarCreatePrompt,
  planGoogleCalendarCreate,
} from './google-calendar-create.js';

const writableCalendars = [
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

describe('planGoogleCalendarCreate', () => {
  it('ignores reminder phrasing', () => {
    const plan = planGoogleCalendarCreate(
      'Remind me tomorrow at 3pm to call Sam.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('none');
  });

  it('builds a timed draft for explicit create asks', () => {
    const plan = planGoogleCalendarCreate(
      'Add dentist appointment to my calendar tomorrow at 3pm.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('dentist appointment');
    expect(plan.draft.startIso).toBe('2026-04-02T20:00:00.000Z');
    expect(plan.draft.endIso).toBe('2026-04-02T21:00:00.000Z');
    expect(plan.draft.allDay).toBe(false);
  });

  it('builds an all-day draft and auto-selects a named calendar', () => {
    const plan = planGoogleCalendarCreate(
      'Create an event called Mason birthday on Family calendar April 15 all day.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('Mason birthday');
    expect(plan.draft.allDay).toBe(true);
    expect(plan.selectedCalendarId).toBe('family@group.calendar.google.com');
  });

  it('accepts hyphenated all-day phrasing', () => {
    const plan = planGoogleCalendarCreate(
      'Create an all-day event called Google all-day proof on Friday on my calendar.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('Google all-day proof');
    expect(plan.draft.allDay).toBe(true);
  });

  it('asks for a missing start time when the event is not all-day', () => {
    const plan = planGoogleCalendarCreate(
      'Add dinner to my calendar tomorrow.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('needs_details');
    if (plan.kind !== 'needs_details') return;
    expect(plan.message).toContain('still need the start time');
  });
});

describe('google calendar create pending flow', () => {
  it('asks for a calendar when multiple writable calendars exist', () => {
    const draft = planGoogleCalendarCreate(
      'Add project sync to my calendar tomorrow at 4pm.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(draft.kind).toBe('draft');
    if (draft.kind !== 'draft') return;

    const pending = buildPendingGoogleCalendarCreateState({
      draft: draft.draft,
      writableCalendars: [...writableCalendars],
      selectedCalendarId: null,
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    expect(pending.step).toBe('choose_calendar');
    expect(formatGoogleCalendarCreatePrompt(pending)).toContain(
      'Which calendar should I use?',
    );
  });

  it('moves from calendar selection to confirmation', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: null,
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate('Family', pending);
    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm_create');
    expect(result.state.selectedCalendarId).toBe(
      'family@group.calendar.google.com',
    );
    expect(result.message).toContain('Reply "yes" to create it');
  });

  it('confirms creation after yes', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate('yes', pending);
    expect(result.kind).toBe('confirmed');
    if (result.kind !== 'confirmed') return;
    expect(result.calendarId).toBe('primary');
  });
});
