import { describe, expect, it } from 'vitest';

import {
  parseNamedReplyDelayTiming,
  planNamedReplyDelayReminder,
} from './named-reply-delay.js';

describe('bounded named reply delay grammar', () => {
  it.each([
    ['remind me in 30 minutes', 30],
    ['remind me to reply in 2 hours', 120],
    ['remind me to answer in 1 minute.', 1],
    ['remind me about that in 1 hour!', 60],
    ['  REMIND  ME about this in 90 minutes  ', 90],
    ['remind me about it in 1440 minutes', 1440],
    ['remind me in 24 hours', 1440],
  ])('inherits timing only for %s', (text, minutes) => {
    expect(parseNamedReplyDelayTiming(text as string)).toEqual({
      kind: 'delay',
      minutes,
    });
  });

  it.each([
    'remind me in 0 minutes',
    'remind me in -1 hour',
    'remind me in +30 minutes',
    'remind me in 1.5 hours',
    'remind me in 0.1 minutes',
    'remind me in 1441 minutes',
    'remind me in 25 hours',
    'remind me in 999999999999999999999999 hours',
    'remind me in Infinity minutes',
    'remind me in NaN minutes',
  ])('refuses invalid delays without a tonight fallback: %s', (text) => {
    expect(parseNamedReplyDelayTiming(text)).toEqual({ kind: 'invalid_delay' });
  });

  it.each([
    'remind me in 30 minutes and send it',
    'remind me in 30 minutes; send now',
    'remind me in 30 minutes to buy milk',
    'remind me to reply to Sam in 30 minutes',
    'remind me about the bills in 30 minutes',
    'remind me to call Sam in 2 hours',
    'remind me in 2 days',
    'send it in 30 minutes',
    'remind me later',
    'remind me next Friday at 9am',
  ])('does not substitute a body or inherit another request: %s', (text) => {
    expect(parseNamedReplyDelayTiming(text)).toBeNull();
  });
});

const receivedAt = '2026-09-06T00:30:15.123Z';
const input: Parameters<typeof planNamedReplyDelayReminder>[0] = {
  timing: { kind: 'delay', minutes: 30 },
  receivedAt,
  now: new Date('2026-09-06T00:31:00.000Z'),
  reminderBody: 'reply to Bob',
  groupFolder: 'synthetic-owner',
  chatJid: 'tg:synthetic-owner',
  timeZone: 'America/Chicago',
  channel: 'telegram',
  inboundId: 'synthetic-delay-1',
};

describe('named reply elapsed-time planning', () => {
  it('keeps the exact receipt-based instant on delayed retries', () => {
    const first = planNamedReplyDelayReminder(input)!;
    const retry = planNamedReplyDelayReminder({
      ...input,
      now: new Date('2026-09-06T00:40:00.000Z'),
    })!;
    expect(first.task.next_run).toBe('2026-09-06T01:00:15.123Z');
    expect(retry.task.id).toBe(first.task.id);
    expect(retry.task.schedule_value).toBe(first.task.schedule_value);
    expect(retry.confirmation).toBe(first.confirmation);
    expect(first.confirmation).toContain('Sep 5, 2026');
    expect(first.confirmation).toMatch(/8:00\s*PM CDT/);
    expect(first.confirmation).toContain('(America/Chicago) to reply to Bob.');
  });

  it.each([
    ['2026-03-08T07:45:00.000Z', '2026-03-08T08:15:00.000Z', 'CDT'],
    ['2026-11-01T06:45:00.000Z', '2026-11-01T07:15:00.000Z', 'CST'],
  ])(
    'uses elapsed minutes across a DST transition at %s',
    (stamp, due, zone) => {
      const result = planNamedReplyDelayReminder({
        ...input,
        receivedAt: stamp,
        now: new Date(stamp),
      })!;
      expect(result.task.next_run).toBe(due);
      expect(result.confirmation).toContain(zone);
    },
  );

  it('uses the timezone for display without changing the elapsed instant', () => {
    const result = planNamedReplyDelayReminder({
      ...input,
      timeZone: 'Asia/Tokyo',
    })!;
    expect(result.task.next_run).toBe('2026-09-06T01:00:15.123Z');
    expect(result.confirmation).toContain('Sep 6, 2026');
    expect(result.confirmation).toContain('(Asia/Tokyo)');
  });

  it.each([
    { receivedAt: null },
    { receivedAt: 'invalid' },
    { receivedAt: '2026-02-31T00:00:00.000Z' },
    { receivedAt: '2026-09-06T00:30:00' },
    { receivedAt: '2026-09-06T00:32:00.000Z' },
    { now: new Date('2026-09-06T01:00:15.123Z') },
    { now: new Date('2026-09-06T01:01:00.000Z') },
    { now: new Date('invalid') },
    { timeZone: 'Mars/Olympus_Mons' },
    { timeZone: '' },
    { inboundId: '' },
    { groupFolder: '' },
    { chatJid: '' },
    { reminderBody: '' },
    { timing: { kind: 'invalid_delay' as const } },
    { timing: { kind: 'delay' as const, minutes: 0.5 } },
    { timing: { kind: 'delay' as const, minutes: 1441 } },
  ])('refuses unverifiable or expired planning input %j', (overrides) => {
    expect(planNamedReplyDelayReminder({ ...input, ...overrides })).toBeNull();
  });

  it.each([
    { inboundId: 'different-message' },
    { chatJid: 'tg:different-owner' },
    { groupFolder: 'different-group' },
    { channel: 'bluebubbles' as const },
    { reminderBody: 'reply to Sam' },
    { timing: { kind: 'delay' as const, minutes: 60 } },
  ])('keeps a distinct identity for changed scope %j', (overrides) => {
    expect(
      planNamedReplyDelayReminder({ ...input, ...overrides })?.task.id,
    ).not.toBe(planNamedReplyDelayReminder(input)?.task.id);
  });
});
