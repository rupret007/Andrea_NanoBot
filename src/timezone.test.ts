import { describe, it, expect } from 'vitest';

import {
  formatLocalTime,
  isValidTimezone,
  resolveOwnerCalendarWindow,
  resolveTimezone,
} from './timezone.js';

// --- formatLocalTime ---

describe('formatLocalTime', () => {
  it('converts UTC to local time display', () => {
    // 2026-02-04T18:30:00Z in America/New_York (EST, UTC-5) = 1:30 PM
    const result = formatLocalTime(
      '2026-02-04T18:30:00.000Z',
      'America/New_York',
    );
    expect(result).toContain('1:30');
    expect(result).toContain('PM');
    expect(result).toContain('Feb');
    expect(result).toContain('2026');
  });

  it('handles different timezones', () => {
    // Same UTC time should produce different local times
    const utc = '2026-06-15T12:00:00.000Z';
    const ny = formatLocalTime(utc, 'America/New_York');
    const tokyo = formatLocalTime(utc, 'Asia/Tokyo');
    // NY is UTC-4 in summer (EDT), Tokyo is UTC+9
    expect(ny).toContain('8:00');
    expect(tokyo).toContain('9:00');
  });

  it('does not throw on invalid timezone, falls back to UTC', () => {
    expect(() =>
      formatLocalTime('2026-01-01T00:00:00.000Z', 'IST-2'),
    ).not.toThrow();
    const result = formatLocalTime('2026-01-01T12:00:00.000Z', 'IST-2');
    // Should format as UTC (noon UTC = 12:00 PM)
    expect(result).toContain('12:00');
    expect(result).toContain('PM');
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA identifiers', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('Asia/Jerusalem')).toBe(true);
  });

  it('rejects invalid timezone strings', () => {
    expect(isValidTimezone('IST-2')).toBe(false);
    expect(isValidTimezone('XYZ+3')).toBe(false);
  });

  it('rejects empty and garbage strings', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('NotATimezone')).toBe(false);
  });
});

describe('resolveTimezone', () => {
  it('returns the timezone if valid', () => {
    expect(resolveTimezone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for invalid timezone', () => {
    expect(resolveTimezone('IST-2')).toBe('UTC');
    expect(resolveTimezone('')).toBe('UTC');
  });
});

describe('resolveOwnerCalendarWindow', () => {
  const chicagoEvening = new Date('2026-04-15T19:00:00-05:00');
  const ownerTodayMessage = '2026-04-15T16:46:28.314Z';

  it('keeps today on the owner calendar even when host midnight has already rolled', () => {
    const chicago = resolveOwnerCalendarWindow({
      now: chicagoEvening,
      kind: 'today',
      timeZone: 'America/Chicago',
    });
    const utc = resolveOwnerCalendarWindow({
      now: chicagoEvening,
      kind: 'today',
      timeZone: 'UTC',
    });

    expect(chicago.startTimestamp).toBe('2026-04-15T05:00:00.000Z');
    expect(chicago.endTimestamp).toBeNull();
    expect(ownerTodayMessage >= chicago.startTimestamp).toBe(true);
    expect(utc.startTimestamp).toBe('2026-04-16T00:00:00.000Z');
    expect(ownerTodayMessage >= utc.startTimestamp).toBe(false);
  });

  it('bounds yesterday to the owner calendar day, not the host day', () => {
    const chicago = resolveOwnerCalendarWindow({
      now: chicagoEvening,
      kind: 'yesterday',
      timeZone: 'America/Chicago',
    });

    expect(chicago.startTimestamp).toBe('2026-04-14T05:00:00.000Z');
    expect(chicago.endTimestamp).toBe('2026-04-15T05:00:00.000Z');
    expect(ownerTodayMessage >= chicago.endTimestamp!).toBe(true);
  });

  it('starts this week on Monday midnight in the owner timezone', () => {
    const chicago = resolveOwnerCalendarWindow({
      now: chicagoEvening,
      kind: 'this_week',
      timeZone: 'America/Chicago',
    });

    expect(chicago.startTimestamp).toBe('2026-04-13T05:00:00.000Z');
    expect(chicago.endTimestamp).toBeNull();
  });

  it('keeps last-hours windows as exact durations from now', () => {
    const window = resolveOwnerCalendarWindow({
      now: chicagoEvening,
      kind: 'last_hours',
      value: 6,
      timeZone: 'UTC',
    });

    expect(window.startTimestamp).toBe('2026-04-15T18:00:00.000Z');
    expect(window.endTimestamp).toBeNull();
  });
});
