/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export type OwnerCalendarWindowKind =
  | 'default_24h'
  | 'last_hours'
  | 'last_days'
  | 'today'
  | 'yesterday'
  | 'this_week';

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function readZonedDateTimeParts(
  date: Date,
  timeZone: string,
): ZonedDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveTimezone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value || '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

function addCivilDays(
  year: number,
  month: number,
  day: number,
  days: number,
): Pick<ZonedDateTimeParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedCivilToUtc(
  parts: Partial<ZonedDateTimeParts> &
    Pick<ZonedDateTimeParts, 'year' | 'month' | 'day'>,
  timeZone: string,
): Date {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = readZonedDateTimeParts(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const delta = desired - observedAsUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  return new Date(candidate);
}

function startOfZonedDay(date: Date, timeZone: string): Date {
  const parts = readZonedDateTimeParts(date, timeZone);
  return zonedCivilToUtc(
    { year: parts.year, month: parts.month, day: parts.day },
    timeZone,
  );
}

/**
 * Resolve a Texts/recent-text calendar window in the owner timezone.
 * Host-local Date.setHours midnight must not decide "today" / "yesterday"
 * / "this week" — those labels are owner-calendar claims.
 */
export function resolveOwnerCalendarWindow(params: {
  now: Date;
  kind: OwnerCalendarWindowKind | null | undefined;
  value?: number | null;
  timeZone: string;
}): { startTimestamp: string; endTimestamp: string | null } {
  const timeZone = resolveTimezone(params.timeZone);
  const now = params.now;
  switch (params.kind) {
    case 'last_hours': {
      const hours = Math.max(1, params.value || 1);
      return {
        startTimestamp: new Date(
          now.getTime() - hours * 60 * 60 * 1000,
        ).toISOString(),
        endTimestamp: null,
      };
    }
    case 'last_days': {
      const days = Math.max(1, params.value || 1);
      const parts = readZonedDateTimeParts(now, timeZone);
      const earlier = addCivilDays(parts.year, parts.month, parts.day, -days);
      return {
        startTimestamp: zonedCivilToUtc(
          {
            ...earlier,
            hour: parts.hour,
            minute: parts.minute,
            second: parts.second,
          },
          timeZone,
        ).toISOString(),
        endTimestamp: null,
      };
    }
    case 'today':
      return {
        startTimestamp: startOfZonedDay(now, timeZone).toISOString(),
        endTimestamp: null,
      };
    case 'yesterday': {
      const todayStart = startOfZonedDay(now, timeZone);
      const todayParts = readZonedDateTimeParts(todayStart, timeZone);
      const yesterday = addCivilDays(
        todayParts.year,
        todayParts.month,
        todayParts.day,
        -1,
      );
      return {
        startTimestamp: zonedCivilToUtc(yesterday, timeZone).toISOString(),
        endTimestamp: todayStart.toISOString(),
      };
    }
    case 'this_week': {
      const parts = readZonedDateTimeParts(now, timeZone);
      const weekday = new Date(
        Date.UTC(parts.year, parts.month - 1, parts.day),
      ).getUTCDay();
      const mondayOffset = weekday === 0 ? 6 : weekday - 1;
      const monday = addCivilDays(
        parts.year,
        parts.month,
        parts.day,
        -mondayOffset,
      );
      return {
        startTimestamp: zonedCivilToUtc(monday, timeZone).toISOString(),
        endTimestamp: null,
      };
    }
    case 'default_24h':
    default:
      return {
        startTimestamp: new Date(
          now.getTime() - 24 * 60 * 60 * 1000,
        ).toISOString(),
        endTimestamp: null,
      };
  }
}
