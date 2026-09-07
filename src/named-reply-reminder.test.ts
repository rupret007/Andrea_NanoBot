import { afterEach, describe, expect, it } from 'vitest';

import {
  formatNamedReplyClockTiming,
  parseNamedReplyClockTiming,
  planNamedReplyClockReminder,
  type NamedReplyClockTiming,
} from './named-reply-reminder.js';

describe('named reply exact-clock timing grammar', () => {
  it.each([
    ['remind me tomorrow at 9am', 'tomorrow', 9, 0, undefined],
    ['remind me to reply tomorrow at 9:05am', 'tomorrow', 9, 5, undefined],
    ['remind me to answer at 8:45PM today.', 'today', 20, 45, undefined],
    ['remind me about that tomorrow at 12am', 'tomorrow', 0, 0, undefined],
    ['remind me about this today at12pm', 'today', 12, 0, undefined],
    ['remind me about it at 11:59pm tomorrow!', 'tomorrow', 23, 59, undefined],
    ['  REMIND  ME to reply today at 09:00 AM  ', 'today', 9, 0, undefined],
    ['remind me Friday at 9am', 'friday', 9, 0, undefined],
    ['remind me on monday at 9:30pm', 'monday', 21, 30, undefined],
    ['remind me to reply Saturday at 12pm', 'saturday', 12, 0, undefined],
    ['remind me about that at 8:15AM on Sunday', 'sunday', 8, 15, undefined],
    ['remind me at 7pm Wednesday', 'wednesday', 19, 0, undefined],
    ['remind me next Friday at 9am', 'friday', 9, 0, true],
    ['remind me on next monday at 9:30pm', 'monday', 21, 30, true],
    ['remind me to reply next Saturday at 12pm', 'saturday', 12, 0, true],
    ['remind me about that at 8:15AM on next Sunday', 'sunday', 8, 15, true],
    ['remind me at 7pm next Wednesday', 'wednesday', 19, 0, true],
  ])(
    'parses only the selected timing in %s',
    (text, day, hour24, minute, nextWeek) => {
      expect(parseNamedReplyClockTiming(text as string)).toEqual({
        kind: 'clock',
        day,
        hour24,
        minute,
        ...(nextWeek ? { nextWeek: true } : {}),
      });
    },
  );

  it.each([
    'remind me tomorrow at 0am',
    'remind me to reply tomorrow at 13pm',
    'remind me about that today at 25am',
    'remind me tomorrow at 9:60am',
    'remind me tomorrow at 9:5am',
    'remind me tomorrow at 9:000am',
    'remind me at 9 tomorrow',
    'remind me tomorrow at 21:00',
    'remind me tomorrow at -1am',
    'remind me tomorrow at +9am',
    'remind me tomorrow at 999999am',
    'remind me Friday at 0am',
    'remind me Friday at 13pm',
    'remind me Friday at 9:60am',
    'remind me Friday at 21:00',
    'remind me next Friday at 0am',
    'remind me next Friday at 13pm',
    'remind me next Friday at 9:60am',
    'remind me next Friday at 21:00',
  ])('keeps invalid clock-shaped input from a daypart fallback: %s', (text) => {
    expect(parseNamedReplyClockTiming(text)).toEqual({ kind: 'invalid_clock' });
  });

  it.each([
    'remind me later',
    'remind me in 30 minutes',
    'remind me tomorrow morning',
    'remind me this Friday at 9am',
    'remind me the next Friday at 9am',
    'remind me next week at 9am',
    'remind me next next Friday at 9am',
    'remind me September 8 at 9am',
    'remind me at 9am',
    'remind me to call Sam Friday at 9am',
    'remind me to call Sam next Friday at 9am',
    'remind me to reply to Sam Friday at 9am',
    'remind me about my bills Friday at 9am',
    'remind me Friday at 9am to buy milk',
    'remind me next Friday at 9am to buy milk',
    'remind me Friday at 9am and send it',
    'remind me next Friday at 9am and send it',
    'remind me Friday at 9am; send it',
    'send it Friday at 9am',
    'yes',
  ])('does not inherit a named person for another request: %s', (text) => {
    expect(parseNamedReplyClockTiming(text)).toBeNull();
  });

  it('formats round-trippable explicit timing without dropping the clock', () => {
    const timing = parseNamedReplyClockTiming('remind me at 9am tomorrow');
    expect(timing).not.toBeNull();
    const formatted = formatNamedReplyClockTiming(timing!);
    expect(formatted).toBe('tomorrow at 9:00am');
    expect(parseNamedReplyClockTiming(`remind me ${formatted}`)).toEqual(
      timing,
    );
    const weekday = parseNamedReplyClockTiming('remind me Friday at 9am');
    expect(formatNamedReplyClockTiming(weekday!)).toBe('friday at 9:00am');
    expect(parseNamedReplyClockTiming('remind me friday at 9:00am')).toEqual(
      weekday,
    );
    const nextWeekday = parseNamedReplyClockTiming(
      'remind me next Friday at 9am',
    );
    expect(formatNamedReplyClockTiming(nextWeekday!)).toBe(
      'next friday at 9:00am',
    );
    expect(
      parseNamedReplyClockTiming(
        `remind me ${formatNamedReplyClockTiming(nextWeekday!)}`,
      ),
    ).toEqual(nextWeekday);
    expect(formatNamedReplyClockTiming({ kind: 'invalid_clock' })).toBe(
      'at an invalid time',
    );
  });
});

function plan(
  text = 'remind me to reply tomorrow at 9am',
  overrides: Partial<Parameters<typeof planNamedReplyClockReminder>[0]> = {},
) {
  return planNamedReplyClockReminder({
    timing: parseNamedReplyClockTiming(text)!,
    reminderBody: 'reply to Bob',
    groupFolder: 'synthetic-owner',
    chatJid: 'tg:synthetic-owner',
    now: new Date('2026-09-06T01:30:00.000Z'),
    timeZone: 'America/Chicago',
    identity: { channel: 'telegram', inboundId: 'synthetic-request-1' },
    ...overrides,
  });
}

describe('named reply clock planning uses the owner calendar', () => {
  const originalHostTimeZone = process.env.TZ;
  afterEach(() => {
    if (originalHostTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalHostTimeZone;
  });

  it('uses tomorrow in Chicago when UTC has already reached the next day', () => {
    const result = plan();
    expect(result?.task.next_run).toBe('2026-09-06T14:00:00.000Z');
    expect(result?.task.schedule_value).toBe(result?.task.next_run);
    expect(result?.confirmation).toContain('Sep 6, 2026');
    expect(result?.confirmation).toMatch(/9:00\s*AM CDT/);
    expect(result?.confirmation).toContain('(America/Chicago) to reply to Bob');
    expect(result?.task).toMatchObject({
      group_folder: 'synthetic-owner',
      chat_jid: 'tg:synthetic-owner',
      prompt: 'Send a concise reminder telling the user to reply to Bob.',
      script: null,
      schedule_type: 'once',
      context_mode: 'isolated',
      status: 'active',
    });
  });

  it.each(['UTC', 'Pacific/Honolulu', 'Asia/Tokyo'])(
    'does not use the process timezone %s to choose the due instant',
    (hostTimeZone) => {
      process.env.TZ = hostTimeZone;
      expect(plan()?.task.next_run).toBe('2026-09-06T14:00:00.000Z');
    },
  );

  it.each([
    ['2026-01-16T01:30:00.000Z', '2026-01-16T15:00:00.000Z', 'CST'],
    ['2026-07-16T01:30:00.000Z', '2026-07-16T14:00:00.000Z', 'CDT'],
  ])('uses the correct seasonal offset on %s', (now, expected, label) => {
    const result = plan(undefined, { now: new Date(now) });
    expect(result?.task.next_run).toBe(expected);
    expect(result?.confirmation).toContain(label);
  });

  it('handles an owner date already ahead of UTC and a fractional offset', () => {
    expect(
      plan(undefined, {
        now: new Date('2026-09-05T20:00:00.000Z'),
        timeZone: 'Asia/Kolkata',
      })?.task.next_run,
    ).toBe('2026-09-07T03:30:00.000Z');
  });

  it.each([
    ['remind me tomorrow at 12am', '2026-09-06T05:00:00.000Z'],
    ['remind me tomorrow at 12pm', '2026-09-06T17:00:00.000Z'],
  ])('keeps noon and midnight distinct: %s', (text, expected) => {
    expect(plan(text)?.task.next_run).toBe(expected);
  });

  it('can keep a future clock on the current owner date', () => {
    expect(plan('remind me today at 9pm')?.task.next_run).toBe(
      '2026-09-06T02:00:00.000Z',
    );
  });

  it.each([
    ['remind me Friday at 9am', '2026-09-11T14:00:00.000Z'],
    ['remind me Saturday at 9am', '2026-09-12T14:00:00.000Z'],
    ['remind me Saturday at 9:30pm', '2026-09-06T02:30:00.000Z'],
    ['remind me on Sunday at 9am', '2026-09-06T14:00:00.000Z'],
    ['remind me Monday at 9am', '2026-09-07T14:00:00.000Z'],
    ['remind me at 9am Friday', '2026-09-11T14:00:00.000Z'],
    ['remind me next Friday at 9am', '2026-09-18T14:00:00.000Z'],
    ['remind me next Saturday at 9am', '2026-09-12T14:00:00.000Z'],
    ['remind me next Saturday at 9:30pm', '2026-09-13T02:30:00.000Z'],
    ['remind me on next Sunday at 9am', '2026-09-13T14:00:00.000Z'],
    ['remind me next Monday at 9am', '2026-09-14T14:00:00.000Z'],
    ['remind me at 9am next Friday', '2026-09-18T14:00:00.000Z'],
  ])('keeps weekday %s on the owner calendar', (text, expected) => {
    const result = plan(text);
    expect(result?.task.next_run).toBe(expected);
    expect(result?.task.schedule_value).toBe(expected);
    expect(result?.confirmation).toContain('America/Chicago');
    expect(result?.confirmation).toContain('to reply to Bob');
  });

  it('keeps next Friday one week after this Friday without a second roll', () => {
    const fridayEvening = { now: new Date('2026-09-12T03:00:00.000Z') };
    const fridayMorning = { now: new Date('2026-09-11T13:00:00.000Z') };
    expect(plan('remind me Friday at 9am', fridayEvening)?.task.next_run).toBe(
      '2026-09-18T14:00:00.000Z',
    );
    expect(
      plan('remind me next Friday at 9am', fridayEvening)?.task.next_run,
    ).toBe('2026-09-18T14:00:00.000Z');
    expect(plan('remind me Friday at 9am', fridayMorning)?.task.next_run).toBe(
      '2026-09-11T14:00:00.000Z',
    );
    expect(
      plan('remind me next Friday at 9am', fridayMorning)?.task.next_run,
    ).toBe('2026-09-18T14:00:00.000Z');
  });

  it.each(['UTC', 'Pacific/Honolulu', 'Asia/Tokyo'])(
    'does not use the process timezone %s to choose a weekday due instant',
    (hostTimeZone) => {
      process.env.TZ = hostTimeZone;
      expect(plan('remind me Friday at 9am')?.task.next_run).toBe(
        '2026-09-11T14:00:00.000Z',
      );
      expect(plan('remind me next Friday at 9am')?.task.next_run).toBe(
        '2026-09-18T14:00:00.000Z',
      );
    },
  );

  it.each(['remind me today at 8pm', 'remind me today at 8:30pm'])(
    'rejects an elapsed or equal today time without rolling it forward: %s',
    (text) => {
      expect(plan(text)).toBeNull();
    },
  );

  it('rejects a nonexistent spring clock instead of shifting it', () => {
    expect(
      plan('remind me tomorrow at 2:30am', {
        now: new Date('2026-03-07T18:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      plan('remind me Sunday at 2:30am', {
        now: new Date('2026-03-07T18:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      plan('remind me next Sunday at 2:30am', {
        now: new Date('2026-03-07T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-03-15T07:30:00.000Z');
    expect(
      plan('remind me tomorrow at 3:30am', {
        now: new Date('2026-03-07T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-03-08T08:30:00.000Z');
    expect(
      plan('remind me Sunday at 3:30am', {
        now: new Date('2026-03-07T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-03-08T08:30:00.000Z');
  });

  it('rejects an ambiguous autumn clock instead of choosing one occurrence', () => {
    expect(
      plan('remind me tomorrow at 1:30am', {
        now: new Date('2026-10-31T18:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      plan('remind me Sunday at 1:30am', {
        now: new Date('2026-10-31T18:00:00.000Z'),
      }),
    ).toBeNull();
    expect(
      plan('remind me next Sunday at 1:30am', {
        now: new Date('2026-10-31T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-11-08T07:30:00.000Z');
    expect(
      plan('remind me tomorrow at 2:30am', {
        now: new Date('2026-10-31T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-11-01T08:30:00.000Z');
    expect(
      plan('remind me Sunday at 2:30am', {
        now: new Date('2026-10-31T18:00:00.000Z'),
      })?.task.next_run,
    ).toBe('2026-11-01T08:30:00.000Z');
  });

  it('does not assume that repeated clocks differ by a whole hour', () => {
    expect(
      plan('remind me tomorrow at 1:45am', {
        now: new Date('2026-04-04T02:00:00.000Z'),
        timeZone: 'Australia/Lord_Howe',
      }),
    ).toBeNull();
  });

  it.each(['', 'Mars/Olympus_Mons'])(
    'rejects invalid timezone %s',
    (timeZone) => {
      expect(plan(undefined, { timeZone })).toBeNull();
    },
  );

  it('rejects malformed clock objects and unusable planning inputs', () => {
    expect(plan('remind me tomorrow at 25am')).toBeNull();
    expect(
      plan(undefined, {
        timing: { kind: 'clock', day: 'today', hour24: 25, minute: 0 },
      }),
    ).toBeNull();
    expect(
      plan(undefined, {
        timing: {
          kind: 'clock',
          day: 'today',
          hour24: 9,
          minute: 60,
        } as NamedReplyClockTiming,
      }),
    ).toBeNull();
    expect(plan(undefined, { now: new Date('invalid') })).toBeNull();
    expect(plan(undefined, { reminderBody: ' ' })).toBeNull();
    expect(plan(undefined, { groupFolder: '' })).toBeNull();
    expect(plan(undefined, { chatJid: '' })).toBeNull();
  });

  it('gives the same operation and instant one stable task identity', () => {
    const first = plan();
    const replay = plan();
    expect(first).not.toBeNull();
    expect(replay).toEqual(first);
    expect(
      plan(undefined, { now: new Date('2026-09-06T01:31:00.000Z') })?.task.id,
    ).toBe(first?.task.id);
    expect(first?.task.id).toMatch(/^reminder-[a-f0-9]{32}$/);
  });

  it('does not reuse an identity for another recipient, scope, date, or request', () => {
    const original = plan()!.task.id;
    for (const overrides of [
      { reminderBody: 'reply to Avery' },
      { chatJid: 'tg:another-owner' },
      { groupFolder: 'another-group' },
      { timeZone: 'UTC' },
      { now: new Date('2026-09-07T01:30:00.000Z') },
      { identity: { channel: 'telegram' as const, inboundId: 'request-2' } },
      {
        identity: {
          channel: 'bluebubbles' as const,
          inboundId: 'synthetic-request-1',
        },
      },
    ]) {
      expect(plan(undefined, overrides)?.task.id).not.toBe(original);
    }
  });
});
