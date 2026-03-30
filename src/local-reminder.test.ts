import { describe, expect, it } from 'vitest';

import { planSimpleReminder } from './local-reminder.js';

describe('planSimpleReminder', () => {
  it('parses tomorrow reminders into one-off tasks', () => {
    const planned = planSimpleReminder(
      'Remind me tomorrow at 3pm to call Sam',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain("I'll prompt you tomorrow at 3pm");
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

  it('handles a reminder ask with a trailing simple math request', () => {
    const planned = planSimpleReminder(
      'Can you remind me tomorrow at 3pm to call Sam and also what is 5 + 7?',
      'main',
      'tg:123',
      new Date('2026-03-29T10:00:00-05:00'),
    );

    expect(planned).not.toBeNull();
    expect(planned?.confirmation).toContain(
      "I'll prompt you tomorrow at 3pm to call Sam.",
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
