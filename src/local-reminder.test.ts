import { describe, expect, it } from 'vitest';

import {
  planContextualReminder,
  planSimpleReminder,
} from './local-reminder.js';

describe('planSimpleReminder', () => {
  it('parses tomorrow reminders into one-off tasks', () => {
    const planned = planSimpleReminder(
      'Remind me tomorrow at 3pm to call Sam',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "Okay. I'll remind you tomorrow at 3pm",
    );
    expect(planned?.task.schedule_type).toBe('once');
    expect(planned?.task.schedule_value).toBe('2026-03-30T15:00:00');
    expect(planned?.task.prompt).toContain('call Sam');
  });

  it('parses weekday reminders into the next matching weekday', () => {
    const planned = planSimpleReminder(
      'Can you remind me Friday at 2pm to check on the demo?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain('Friday at 2pm');
    expect(planned?.task.schedule_value).toBe('2026-04-03T14:00:00');
  });

  it('parses remember-to phrasing with dayparts', () => {
    const planned = planSimpleReminder(
      'Can you help me remember to call Brian tomorrow morning?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain('tomorrow morning');
    expect(planned?.task.schedule_value).toBe('2026-03-30T09:00:00');
    expect(planned?.task.prompt).toContain('call Brian');
  });

  it('parses reminder asks with a leading greeting', () => {
    const planned = planSimpleReminder(
      'Hi, can you remind me tomorrow at 3pm to call Sam?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "Okay. I'll remind you tomorrow at 3pm",
    );
    expect(planned?.task.prompt).toContain('call Sam');
  });

  it('parses reminder asks with a leading thank-you', () => {
    const planned = planSimpleReminder(
      'Thanks, can you remind me Friday at 2pm to check on the demo?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain('Friday at 2pm');
    expect(planned?.task.prompt).toContain('check on the demo');
  });

  it('handles a reminder ask with a trailing simple math request', () => {
    const planned = planSimpleReminder(
      'Can you remind me tomorrow at 3pm to call Sam and also what is 5 + 7?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "Okay. I'll remind you tomorrow at 3pm to call Sam.",
    );
    expect(planned?.confirmation).toContain('Quick math: 5 + 7 = 12.');
    expect(planned?.task.prompt).toContain('call Sam');
  });

  it('returns null for non-reminder messages', () => {
    const planned = planSimpleReminder(
      'What is the meaning of life?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).toBeNull();
  });
});

describe('planContextualReminder', () => {
  it('supports today-at follow-up timing for action-layer reminder capture', () => {
    const planned = planContextualReminder(
      'today at 5',
      'prepare for Google timed proof',
      'main',
      'tg:123',
      new Date('2026-04-01T12:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "Okay. I'll remind you today at 5pm to prepare for Google timed proof.",
    );
    expect(planned?.task.schedule_value).toBe('2026-04-01T17:00:00');
  });

  it('supports later-today follow-up timing for action-layer reminder capture', () => {
    const planned = planContextualReminder(
      'later today at 5',
      'come back to Ship docs',
      'main',
      'tg:123',
      new Date('2026-04-01T12:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "Okay. I'll remind you today at 5pm to come back to Ship docs.",
    );
    expect(planned?.task.schedule_value).toBe('2026-04-01T17:00:00');
  });

  it('supports time-before-day follow-up phrasing for action-layer reminder capture', () => {
    const planned = planContextualReminder(
      "I'd like it to be at 12:00PM today.",
      "create an adoption barrier for Wintrust's new defect with agent login",
      'main',
      'bb:iMessage;-;jeffstory007@gmail.com',
      new Date('2026-04-10T10:56:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "today at 12pm to create an adoption barrier for Wintrust's new defect with agent login",
    );
    expect(planned?.task.schedule_value).toBe('2026-04-10T12:00:00');
  });
});
