import { describe, expect, it, vi } from 'vitest';

import {
  advancePendingActionDraft,
  advancePendingActionReminder,
  buildActionLayerResponse,
  shouldInterruptPendingActionLayerFlow,
  type PendingActionDraftState,
} from './action-layer.js';
import type { CalendarActiveEventContext } from './calendar-assistant.js';
import type { SelectedWorkContext } from './daily-command-center.js';
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

describe('buildActionLayerResponse', () => {
  it('leaves broad next-step planning to the shared chief-of-staff layer', async () => {
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

    const response = await buildActionLayerResponse('What should I do next?', {
      now: new Date('2026-04-01T12:00:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
      selectedWork,
    });

    expect(response.kind).toBe('none');
  });

  it('leaves before-next-meeting planning to the shared chief-of-staff layer', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Design review',
              start: { dateTime: '2026-04-01T18:45:00Z' },
              end: { dateTime: '2026-04-01T19:30:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildActionLayerResponse(
      'What should I handle before my next meeting?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
      },
    );

    expect(response.kind).toBe('none');
  });

  it('sizes the next free window as a knock-out block for selected work', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: {
          items: [
            {
              id: 'evt-1',
              summary: 'Late sync',
              start: { dateTime: '2026-04-02T02:00:00Z' },
              end: { dateTime: '2026-04-02T03:00:00Z' },
            },
          ],
        },
      },
    });

    const response = await buildActionLayerResponse(
      'What can I knock out in my next free window?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response.kind).toBe('reply');
    if (response.kind !== 'reply') return;
    expect(response.reply).toContain('Your next free window is');
    expect(response.reply).toContain('Ship docs');
  });

  it('no longer owns generic meeting prep prompts that are now routed through chief-of-staff', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: {
        primary: { items: [] },
      },
    });
    const activeEventContext: CalendarActiveEventContext = {
      providerId: 'google_calendar',
      id: 'evt-1',
      title: 'Design review',
      startIso: '2026-04-01T18:15:00.000Z',
      endIso: '2026-04-01T19:00:00.000Z',
      allDay: false,
      calendarId: 'primary',
      calendarName: 'Google Calendar',
      htmlLink: null,
    };

    const response = await buildActionLayerResponse(
      'Help me prepare for this meeting',
      {
        now: new Date('2026-04-01T12:05:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        activeEventContext,
      },
    );

    expect(response.kind).toBe('none');
  });

  it('asks for a time when turning current work into a reminder', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      'Turn that into a reminder',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        groupFolder: 'main',
        chatJid: 'tg:1',
      },
    );

    expect(response.kind).toBe('awaiting_reminder_time');
    if (response.kind !== 'awaiting_reminder_time') return;
    expect(response.message).toContain('come back to Ship docs');
  });

  it('captures a direct reminder ask before the broader assistant path and keeps BlueBubbles self-thread linkage', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      "@Andrea remind me to create an adoption barrier for Wintrust's new defect with agent login.",
      {
        now: new Date('2026-04-10T10:56:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      },
    );

    expect(response.kind).toBe('awaiting_reminder_time');
    if (response.kind !== 'awaiting_reminder_time') return;
    expect(response.message).toContain(
      "create an adoption barrier for Wintrust's new defect with agent login",
    );
    expect(response.state.label).toContain(
      "create an adoption barrier for Wintrust's new defect with agent login",
    );
    expect(response.state.originChatJid).toBe(
      'bb:iMessage;-;jeffstory007@gmail.com',
    );
    expect(response.state.canonicalChatJid).toBe('bb:iMessage;-;+14695405551');
  });

  it('leaves broad summarize-my-actions asks to the shared chief-of-staff layer', async () => {
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

    const response = await buildActionLayerResponse(
      'Summarize the actions I should take today',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
        tasks: [
          createReminderTask('check on the demo', '2026-04-01T18:30:00.000Z'),
        ],
      },
    );

    expect(response.kind).toBe('none');
  });

  it('asks who the draft is for instead of inventing a recipient', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      'Draft a message about this',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response.kind).toBe('awaiting_draft_input');
    if (response.kind !== 'awaiting_draft_input') return;
    expect(response.message).toBe('Who is it for?');
  });

  it('builds a grounded meeting follow-up draft when recipient and event context are clear', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });
    const activeEventContext: CalendarActiveEventContext = {
      providerId: 'google_calendar',
      id: 'evt-1',
      title: 'Design review',
      startIso: '2026-04-01T18:15:00.000Z',
      endIso: '2026-04-01T19:00:00.000Z',
      allDay: false,
      calendarId: 'primary',
      calendarName: 'Google Calendar',
      htmlLink: null,
    };

    const response = await buildActionLayerResponse(
      'Draft a follow-up for this meeting to Candace',
      {
        now: new Date('2026-04-01T14:10:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        activeEventContext,
      },
    );

    expect(response.kind).toBe('reply');
    if (response.kind !== 'reply') return;
    expect(response.reply).toContain("Here's a short follow-up for Candace.");
    expect(response.reply).toContain('Thanks for the time on Design review.');
    expect(response.activeEventContext?.id).toBe('evt-1');
    expect(response.actionContext?.suggestedReminderLabel).toContain(
      'send note to Candace about Design review',
    );
  });

  it('builds a short email draft for grounded work context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      'Draft an email about this to Candace',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response.kind).toBe('reply');
    if (response.kind !== 'reply') return;
    expect(response.reply).toContain("Here's a short email draft for Candace.");
    expect(response.reply).toContain('Subject: Update on Ship docs');
    expect(response.reply).toContain('Quick update on Ship docs');
  });

  it('builds a note draft for an explicit recipient from grounded task context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      'Help me write a note to Candace about this',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(response.kind).toBe('reply');
    if (response.kind !== 'reply') return;
    expect(response.reply).toContain('draft for Candace');
    expect(response.reply).toContain('Quick update on Ship docs');
  });

  it('asks which meeting the user means when meeting follow-up context is weak', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      'What should I send after this meeting?',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
      },
    );

    expect(response.kind).toBe('awaiting_draft_input');
    if (response.kind !== 'awaiting_draft_input') return;
    expect(response.message).toBe('Which meeting do you mean?');
  });

  it('asks what task the user means when a task follow-up prompt has weak work context', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse(
      "Draft a quick update about what's next",
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
      },
    );

    expect(response.kind).toBe('awaiting_draft_input');
    if (response.kind !== 'awaiting_draft_input') return;
    expect(response.message).toBe('What task do you mean?');
  });

  it('stays out of broad next-step asks even when the context is weak', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const response = await buildActionLayerResponse('What should I do next?', {
      now: new Date('2026-04-01T23:45:00-05:00'),
      timeZone: 'America/Chicago',
      env: baseEnv,
      fetchImpl,
    });

    expect(response.kind).toBe('none');
  });
  it('reuses a communication draft context when turning it into a reminder later', async () => {
    const fetchImpl = createGoogleCalendarFetchMock({
      eventsByCalendar: { primary: { items: [] } },
    });

    const drafted = await buildActionLayerResponse(
      'Help me write a note to Candace about this',
      {
        now: new Date('2026-04-01T12:00:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        selectedWork,
      },
    );

    expect(drafted.kind).toBe('reply');
    if (drafted.kind !== 'reply') return;

    const reminder = await buildActionLayerResponse(
      'Turn this draft into a reminder for later',
      {
        now: new Date('2026-04-01T12:01:00-05:00'),
        timeZone: 'America/Chicago',
        env: baseEnv,
        fetchImpl,
        actionContext: drafted.actionContext,
        groupFolder: 'main',
        chatJid: 'tg:1',
      },
    );

    expect(reminder.kind).toBe('awaiting_reminder_time');
    if (reminder.kind !== 'awaiting_reminder_time') return;
    expect(reminder.message).toContain('send note to Candace about Ship docs');
  });
});

describe('action-layer pending flows', () => {
  it('interrupts pending reminder follow-through when a fresh calendar create ask arrives', () => {
    expect(
      shouldInterruptPendingActionLayerFlow(
        'Add Andrea QA disposable event Friday at 3PM to my calendar',
        {
          now: new Date('2026-04-15T09:00:00-05:00'),
          timeZone: 'America/Chicago',
          groupFolder: 'main',
          chatJid: 'tg:1',
        },
      ),
    ).toBe(true);
  });

  it('does not treat a bare timing follow-up as an interrupting new intent', () => {
    expect(
      shouldInterruptPendingActionLayerFlow('Start time is 11AM', {
        now: new Date('2026-04-15T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        groupFolder: 'main',
        chatJid: 'tg:1',
      }),
    ).toBe(false);
  });

  it('treats fresh communication and list read asks as interrupting new intents', () => {
    expect(
      shouldInterruptPendingActionLayerFlow('What texts need me right now', {
        now: new Date('2026-04-15T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        groupFolder: 'main',
        chatJid: 'tg:1',
      }),
    ).toBe(true);
    expect(
      shouldInterruptPendingActionLayerFlow("What's still on my errands list", {
        now: new Date('2026-04-15T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        groupFolder: 'main',
        chatJid: 'tg:1',
      }),
    ).toBe(true);
  });

  it('treats fresh work-cockpit and discovery asks as interrupting new intents', () => {
    expect(
      shouldInterruptPendingActionLayerFlow(
        "show me what's running right now",
        {
          now: new Date('2026-04-15T09:00:00-05:00'),
          timeZone: 'America/Chicago',
          groupFolder: 'main',
          chatJid: 'tg:1',
        },
      ),
    ).toBe(true);
    expect(
      shouldInterruptPendingActionLayerFlow("what's on deck for my repos", {
        now: new Date('2026-04-15T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        groupFolder: 'main',
        chatJid: 'tg:1',
      }),
    ).toBe(true);
    expect(
      shouldInterruptPendingActionLayerFlow('what all can you handle again', {
        now: new Date('2026-04-15T09:00:00-05:00'),
        timeZone: 'America/Chicago',
        groupFolder: 'main',
        chatJid: 'tg:1',
      }),
    ).toBe(true);
  });

  it('turns a pending follow-through reminder into a plain reminder task from a timing-only reply', () => {
    const result = advancePendingActionReminder(
      'at 4',
      {
        version: 1,
        createdAt: '2026-04-01T17:00:00.000Z',
        label: 'come back to Ship docs',
      },
      {
        groupFolder: 'main',
        chatJid: 'tg:1',
        now: new Date('2026-04-01T12:00:00-05:00'),
      },
    );

    expect(result.kind).toBe('created_reminder');
    if (result.kind !== 'created_reminder') return;
    expect(result.confirmation).toContain('come back to Ship docs');
    expect(result.task.prompt).toContain('come back to Ship docs');
  });

  it('turns a pending follow-through reminder into a plain reminder task from a today-at reply', () => {
    const result = advancePendingActionReminder(
      'today at 5',
      {
        version: 1,
        createdAt: '2026-04-01T17:00:00.000Z',
        label: 'prepare for Google timed proof',
      },
      {
        groupFolder: 'main',
        chatJid: 'tg:1',
        now: new Date('2026-04-01T12:00:00-05:00'),
      },
    );

    expect(result.kind).toBe('created_reminder');
    if (result.kind !== 'created_reminder') return;
    expect(result.confirmation).toContain(
      'today at 5pm to prepare for Google timed proof',
    );
    expect(result.task.schedule_value).toBe('2026-04-01T17:00:00');
  });

  it('keeps the reminder subject on a natural time-only follow-up and stores an idempotent created state', () => {
    const result = advancePendingActionReminder(
      "I'd like it to be at 12:00PM today.",
      {
        version: 1,
        createdAt: '2026-04-10T10:55:00.000Z',
        label:
          "create an adoption barrier for Wintrust's new defect with agent login",
        originChatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        canonicalChatJid: 'bb:iMessage;-;+14695405551',
      },
      {
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        now: new Date('2026-04-10T10:56:00-05:00'),
      },
    );

    expect(result.kind).toBe('created_reminder');
    if (result.kind !== 'created_reminder') return;
    expect(result.confirmation).toContain(
      "today at 12pm to create an adoption barrier for Wintrust's new defect with agent login",
    );
    expect(result.state?.status).toBe('created');
    expect(result.state?.confirmation).toContain(
      "today at 12pm to create an adoption barrier for Wintrust's new defect with agent login",
    );
  });

  it('treats duplicate timing replies and "you get that" follow-ups as idempotent reminder confirmation', () => {
    const createdState = {
      version: 1 as const,
      createdAt: '2026-04-10T10:56:00.000Z',
      label:
        "create an adoption barrier for Wintrust's new defect with agent login",
      status: 'created' as const,
      originChatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
      canonicalChatJid: 'bb:iMessage;-;+14695405551',
      confirmation:
        "Okay. I'll remind you today at 12pm to create an adoption barrier for Wintrust's new defect with agent login.",
      taskId: 'task-proof-1',
    };

    const duplicateTiming = advancePendingActionReminder(
      "I'd like it to be at 12:00PM today.",
      createdState,
      {
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        now: new Date('2026-04-10T10:57:00-05:00'),
      },
    );
    expect(duplicateTiming.kind).toBe('reply');
    if (duplicateTiming.kind !== 'reply') return;
    expect(duplicateTiming.reply).toContain(
      "today at 12pm to create an adoption barrier for Wintrust's new defect with agent login",
    );

    const confirmation = advancePendingActionReminder(
      '@andrea you get that?',
      createdState,
      {
        groupFolder: 'main',
        chatJid: 'bb:iMessage;-;jeffstory007@gmail.com',
        now: new Date('2026-04-10T10:58:00-05:00'),
      },
    );
    expect(confirmation.kind).toBe('reply');
    if (confirmation.kind !== 'reply') return;
    expect(confirmation.reply).toContain(
      "today at 12pm to create an adoption barrier for Wintrust's new defect with agent login",
    );
  });

  it('keeps asking when the timing reply is still incomplete', () => {
    const result = advancePendingActionReminder(
      'later today',
      {
        version: 1,
        createdAt: '2026-04-01T17:00:00.000Z',
        label: 'follow up on Design review',
      },
      {
        groupFolder: 'main',
        chatJid: 'tg:1',
        now: new Date('2026-04-01T12:00:00-05:00'),
      },
    );

    expect(result.kind).toBe('awaiting_reminder_time');
    if (result.kind !== 'awaiting_reminder_time') return;
    expect(result.message).toContain('What time should I use?');
  });

  it('turns a pending draft into text once the recipient is supplied', () => {
    const draftState: PendingActionDraftState = {
      version: 1,
      createdAt: '2026-04-01T17:00:00.000Z',
      step: 'clarify_recipient',
      draftKind: 'message',
      topicLabel: 'Ship docs',
      recipient: null,
      selectedWork,
      event: null,
      sourceLabel: 'Ship docs',
    };

    const result = advancePendingActionDraft('Candace', draftState);

    expect(result.kind).toBe('reply');
    if (result.kind !== 'reply') return;
    expect(result.reply).toContain('draft for Candace');
    expect(result.reply).toContain('Quick update on Ship docs');
  });
});
