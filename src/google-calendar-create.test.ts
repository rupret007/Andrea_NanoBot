import { describe, expect, it } from 'vitest';

import {
  advancePendingGoogleCalendarCreate,
  buildGoogleCalendarSchedulingContextState,
  buildPendingGoogleCalendarCreateState,
  getGoogleCalendarCreateIdempotencyKey,
  formatGoogleCalendarCreatePrompt,
  getGoogleCalendarCreateConfirmationActionId,
  isExplicitGoogleCalendarCreateRequest,
  isPendingGoogleCalendarCreateExpired,
  planGoogleCalendarCreate,
  getPendingGoogleCalendarCreatedEvent,
  recordPendingGoogleCalendarCreateSuccess,
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
  it('recognizes self-contained explicit calendar create asks', () => {
    expect(
      isExplicitGoogleCalendarCreateRequest(
        "Add check air filters to Jeff's calendar tomorrow at 4pm.",
      ),
    ).toBe(true);
    expect(
      isExplicitGoogleCalendarCreateRequest(
        'Add dinner with Candace tomorrow at 6:30 PM.',
      ),
    ).toBe(true);
    expect(
      isExplicitGoogleCalendarCreateRequest(
        'Schedule dinner with Candace tomorrow at 6:30 PM.',
      ),
    ).toBe(true);
    expect(
      isExplicitGoogleCalendarCreateRequest(
        'Put Andrea calendar live proof lunch with Sam on tomorrow afternoon.',
      ),
    ).toBe(true);
    expect(
      isExplicitGoogleCalendarCreateRequest('Remind me tomorrow at 3pm.'),
    ).toBe(false);
  });

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

  it('accepts natural put-on phrasing for a timed calendar event', () => {
    const plan = planGoogleCalendarCreate(
      'Put Andrea calendar live proof lunch with Sam on tomorrow afternoon.',
      [...writableCalendars],
      new Date('2026-04-16T11:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('Andrea calendar live proof lunch with Sam');
    expect(plan.draft.startIso).toBe('2026-04-17T17:00:00.000Z');
    expect(plan.draft.endIso).toBe('2026-04-17T18:00:00.000Z');
    expect(plan.selectedCalendarId).toBeNull();
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

  it('strips possessive calendar-target phrasing out of the event title', () => {
    const plan = planGoogleCalendarCreate(
      "Add Andrea calendar proof to Jeff's calendar tomorrow at 4pm.",
      [...writableCalendars],
      new Date('2026-04-09T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('Andrea calendar proof');
    expect(plan.selectedCalendarId).toBe('primary');
  });

  it('strips possessive calendar-target phrasing even when only a primary calendar is selected', () => {
    const plan = planGoogleCalendarCreate(
      "Add check air filters to Jeff's calendar tomorrow at 4pm.",
      [
        {
          id: 'owner@example.com',
          summary: 'owner@example.com',
          primary: true,
          accessRole: 'owner',
          writable: true,
          selected: true,
        },
      ],
      new Date('2026-04-09T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('check air filters');
    expect(plan.selectedCalendarId).toBeNull();
  });

  it('accepts main-calendar phrasing as the primary selected calendar', () => {
    const plan = planGoogleCalendarCreate(
      'Add check air filters to my main calendar tomorrow at 4pm.',
      [
        {
          id: 'owner@example.com',
          summary: 'owner@example.com',
          primary: true,
          accessRole: 'owner',
          writable: true,
          selected: true,
        },
      ],
      new Date('2026-04-09T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('check air filters');
    expect(plan.selectedCalendarId).toBe('owner@example.com');
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
    expect(plan.message).toContain('What time should it start');
  });

  it('keeps a resumable pending state when only the start time is missing', () => {
    const plan = planGoogleCalendarCreate(
      'Add dinner to my calendar tomorrow.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('needs_details');
    if (plan.kind !== 'needs_details') return;
    expect(plan.pendingState).toBeTruthy();
    expect(plan.pendingState?.draft.title).toBe('dinner');
    expect(plan.pendingState?.draft.startIso).toBe('2026-04-02T05:00:00.000Z');
    expect(plan.pendingState?.draft.endIso).toBe('2026-04-02T06:00:00.000Z');
    expect(plan.pendingState?.step).toBe('choose_calendar');
  });

  it('uses scheduling context for pronoun-based follow-through', () => {
    const context = buildGoogleCalendarSchedulingContextState({
      draft: {
        title: 'Project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const plan = planGoogleCalendarCreate(
      'Put that on my calendar Friday afternoon.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
      context,
    );

    expect(plan.kind).toBe('draft');
    if (plan.kind !== 'draft') return;
    expect(plan.draft.title).toBe('Project sync');
    expect(plan.draft.startIso).toBe('2026-04-03T17:00:00.000Z');
    expect(plan.draft.endIso).toBe('2026-04-03T18:00:00.000Z');
  });
});

describe('calendar-create idempotency state', () => {
  it('keeps one private provider idempotency identity across restart-safe pending-state reloads', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'Project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    expect(pending.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(getGoogleCalendarCreateIdempotencyKey({ ...pending })).toBe(
      pending.idempotencyKey,
    );
    expect(
      getGoogleCalendarCreateIdempotencyKey(
        Object.fromEntries(
          Object.entries(pending).filter(([key]) => key !== 'idempotencyKey'),
        ) as typeof pending,
      ),
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it('retains a provider receipt long enough to reconcile a restart before delivery', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'Project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });
    const completed = recordPendingGoogleCalendarCreateSuccess(
      pending,
      {
        id: 'event-1',
        title: 'Project sync',
        startIso: '2026-04-02T21:00:00.000Z',
        endIso: '2026-04-02T22:00:00.000Z',
        allDay: false,
        calendarId: 'primary',
        calendarName: 'Jeff',
        htmlLink: 'https://calendar.google.test/event-1',
      },
      new Date('2026-04-01T10:00:00-05:00'),
    );

    expect(getPendingGoogleCalendarCreatedEvent(completed)).toMatchObject({
      id: 'event-1',
      title: 'Project sync',
    });
    expect(
      isPendingGoogleCalendarCreateExpired(
        completed,
        new Date('2026-04-02T09:59:59-05:00'),
      ),
    ).toBe(false);
    expect(
      isPendingGoogleCalendarCreateExpired(
        completed,
        new Date('2026-04-02T10:00:01-05:00'),
      ),
    ).toBe(true);
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
      'Should I create "project sync" on Jeff (primary) or Family?',
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
    expect(getGoogleCalendarCreateConfirmationActionId(pending)).toBe('yes');
    expect(result.kind).toBe('confirmed');
    if (result.kind !== 'confirmed') return;
    expect(result.calendarId).toBe('primary');
  });

  it('requires an explicit calendar-targeted confirmation for compound drafts', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'meditation',
        startIso: '2026-04-02T13:00:00.000Z',
        endIso: '2026-04-02T14:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      confirmationMode: 'calendar_targeted',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    expect(getGoogleCalendarCreateConfirmationActionId(pending)).toBe(
      'confirm calendar event',
    );
    expect(formatGoogleCalendarCreatePrompt(pending)).toContain(
      'Reply "confirm calendar event" to create it',
    );
    for (const acknowledgement of [
      'yes',
      'yep',
      'ok',
      'okay',
      'go ahead',
      'looks good',
    ]) {
      expect(
        advancePendingGoogleCalendarCreate(acknowledgement, pending),
      ).toEqual({ kind: 'no_match' });
    }
    for (const confirmation of [
      'confirm calendar event',
      'confirm the calendar event',
      'confirm the calendar event, please.',
      'create calendar event',
      'create the event on my calendar',
    ]) {
      expect(
        advancePendingGoogleCalendarCreate(confirmation, pending),
      ).toMatchObject({ kind: 'confirmed', calendarId: 'primary' });
    }
    for (const contradictory of [
      'confirm calendar event but do not create it',
      'confirm calendar event, wait',
      'create calendar event unless there is a conflict',
      'confirm calendar event?',
    ]) {
      expect(
        advancePendingGoogleCalendarCreate(contradictory, pending),
      ).toEqual({ kind: 'no_match' });
    }
  });

  it('preserves targeted confirmation after choosing a calendar', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'meditation',
        startIso: '2026-04-02T13:00:00.000Z',
        endIso: '2026-04-02T14:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: null,
      confirmationMode: 'calendar_targeted',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const selection = advancePendingGoogleCalendarCreate('Family', pending);
    expect(selection.kind).toBe('awaiting_input');
    if (selection.kind !== 'awaiting_input') return;
    expect(selection.state.confirmationMode).toBe('calendar_targeted');
    expect(selection.message).toContain(
      'Reply "confirm calendar event" to create it',
    );
    expect(advancePendingGoogleCalendarCreate('yes', selection.state)).toEqual({
      kind: 'no_match',
    });
  });

  it('updates a pending draft when the user retimes it', () => {
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

    const result = advancePendingGoogleCalendarCreate(
      'Put that on my calendar Friday afternoon',
      pending,
    );
    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-03T17:00:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-03T18:00:00.000Z');
  });

  it('resumes a missing-time draft when the follow-up supplies the start time', () => {
    const plan = planGoogleCalendarCreate(
      'Add dinner to my calendar tomorrow.',
      [...writableCalendars],
      new Date('2026-04-01T09:00:00-05:00'),
      'America/Chicago',
    );

    expect(plan.kind).toBe('needs_details');
    if (plan.kind !== 'needs_details' || !plan.pendingState) return;

    const result = advancePendingGoogleCalendarCreate(
      'Start time is 11AM',
      plan.pendingState,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-02T16:00:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-02T17:00:00.000Z');
    expect(result.state.step).toBe('choose_calendar');
  });

  it('applies time and main-calendar selection from the same choose-calendar follow-up', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'proof lunch with Sam',
        startIso: '2026-04-02T17:00:00.000Z',
        endIso: '2026-04-02T18:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [
        {
          id: 'owner@example.com',
          summary: 'owner@example.com',
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
      ],
      selectedCalendarId: null,
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate(
      '3pm on my main calendar',
      pending,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.step).toBe('confirm_create');
    expect(result.state.selectedCalendarId).toBe('owner@example.com');
    expect(result.state.draft.startIso).toBe('2026-04-02T20:00:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-02T21:00:00.000Z');
  });

  it('updates a pending draft when the user says move that to a new time', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'project sync',
        startIso: '2026-04-02T20:15:00.000Z',
        endIso: '2026-04-02T21:15:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate(
      'move that to 3:30 PM',
      pending,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-02T20:30:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-02T21:30:00.000Z');
  });

  it('updates a pending draft when the user gives a bare retime follow-up', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'project sync',
        startIso: '2026-04-02T17:00:00.000Z',
        endIso: '2026-04-02T18:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate(
      'move that to 3 instead',
      pending,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-02T20:00:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-02T21:00:00.000Z');
  });

  it('updates a pending draft when the user moves it to after lunch', () => {
    const pending = buildPendingGoogleCalendarCreateState({
      draft: {
        title: 'project sync',
        startIso: '2026-04-02T17:00:00.000Z',
        endIso: '2026-04-02T18:00:00.000Z',
        allDay: false,
        timeZone: 'America/Chicago',
      },
      writableCalendars: [...writableCalendars],
      selectedCalendarId: 'primary',
      now: new Date('2026-04-01T09:00:00-05:00'),
    });

    const result = advancePendingGoogleCalendarCreate(
      'move that to after lunch',
      pending,
    );

    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-02T18:00:00.000Z');
    expect(result.state.draft.endIso).toBe('2026-04-02T19:00:00.000Z');
  });

  it('treats delete that as cancelling a pending draft', () => {
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

    const result = advancePendingGoogleCalendarCreate('delete that', pending);
    expect(result.kind).toBe('cancelled');
  });

  it('treats scratch-that follow-ups as cancelling a pending draft', () => {
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

    const result = advancePendingGoogleCalendarCreate(
      'actually scratch that',
      pending,
    );
    expect(result.kind).toBe('cancelled');
  });

  it('does not treat unrelated asks with date or time words as calendar draft adjustments', () => {
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

    expect(
      advancePendingGoogleCalendarCreate(
        'Remind me on Thursday evening 7PM to ask Lucky about the changes.',
        pending,
      ).kind,
    ).toBe('no_match');
    expect(
      advancePendingGoogleCalendarCreate(
        'what should I say back to "sounds good see you at 7"',
        pending,
      ).kind,
    ).toBe('no_match');
    expect(
      advancePendingGoogleCalendarCreate(
        "What's on my schedule for Saturday?",
        pending,
      ).kind,
    ).toBe('no_match');
    expect(
      advancePendingGoogleCalendarCreate("what's the news today", pending).kind,
    ).toBe('no_match');
  });

  it('switches calendars from a follow-up phrase', () => {
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

    const result = advancePendingGoogleCalendarCreate(
      'Add that to the family calendar',
      pending,
    );
    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.selectedCalendarId).toBe(
      'family@group.calendar.google.com',
    );
  });

  it('surfaces conflict suggestions in the confirmation prompt', () => {
    const pending = {
      ...buildPendingGoogleCalendarCreateState({
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
      }),
      conflictSummary: {
        blockingEvents: [
          {
            title: 'Doctor visit',
            startIso: '2026-04-02T21:00:00.000Z',
            endIso: '2026-04-02T21:30:00.000Z',
            allDay: false,
            calendarName: 'Family',
          },
        ],
        suggestions: [
          {
            startIso: '2026-04-02T21:30:00.000Z',
            endIso: '2026-04-02T22:30:00.000Z',
            label: 'Thu, Apr 2, 4:30 PM-5:30 PM',
          },
        ],
        selectedSuggestionStartIso: null,
      },
    };

    const prompt = formatGoogleCalendarCreatePrompt(pending);
    expect(prompt).toContain('That time conflicts with:');
    expect(prompt).toContain('Doctor visit [Family]');
    expect(prompt).toContain('You could also use:');
    expect(prompt).toContain('1. Thu, Apr 2, 2026, 4:30 PM-5:30 PM');
  });

  it('lets the user pick a suggested conflict alternative', () => {
    const pending = {
      ...buildPendingGoogleCalendarCreateState({
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
      }),
      conflictSummary: {
        blockingEvents: [
          {
            title: 'Doctor visit',
            startIso: '2026-04-02T21:00:00.000Z',
            endIso: '2026-04-02T21:30:00.000Z',
            allDay: false,
            calendarName: 'Family',
          },
        ],
        suggestions: [
          {
            startIso: '2026-04-02T21:30:00.000Z',
            endIso: '2026-04-02T22:30:00.000Z',
            label: 'Thu, Apr 2, 4:30 PM-5:30 PM',
          },
        ],
        selectedSuggestionStartIso: null,
      },
    };

    const result = advancePendingGoogleCalendarCreate('1', pending);
    expect(result.kind).toBe('awaiting_input');
    if (result.kind !== 'awaiting_input') return;
    expect(result.state.draft.startIso).toBe('2026-04-02T21:30:00.000Z');
    expect(result.state.conflictSummary).toBeNull();
  });

  it('asks index-level anchor resolution for after-my-meeting phrasing', () => {
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

    const result = advancePendingGoogleCalendarCreate(
      'Move it to after my 2pm meeting',
      pending,
    );
    expect(result.kind).toBe('resolve_anchor');
    if (result.kind !== 'resolve_anchor') return;
    expect(result.anchorTime.displayLabel).toBe('2 PM');
  });
});
