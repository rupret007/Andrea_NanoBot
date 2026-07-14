import type { LifeThread } from './types.js';

export type LifeThreadTemporalKind = 'deadline' | 'scheduled';

export interface ParsedLifeThreadTemporalState {
  activeAt: string;
  kind: LifeThreadTemporalKind;
  dateWasExplicit: boolean;
  timeWasExplicit: boolean;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const MONTHS = new Map([
  ['january', 1],
  ['jan', 1],
  ['february', 2],
  ['feb', 2],
  ['march', 3],
  ['mar', 3],
  ['april', 4],
  ['apr', 4],
  ['may', 5],
  ['june', 6],
  ['jun', 6],
  ['july', 7],
  ['jul', 7],
  ['august', 8],
  ['aug', 8],
  ['september', 9],
  ['sep', 9],
  ['sept', 9],
  ['october', 10],
  ['oct', 10],
  ['november', 11],
  ['nov', 11],
  ['december', 12],
  ['dec', 12],
]);

interface LocalDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return false;
  }
}

export function normalizeLifeThreadTimeZone(value: string | undefined): string {
  if (value && isValidTimeZone(value)) return value;
  const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return system && isValidTimeZone(system) ? system : 'UTC';
}

function localParts(date: Date, timeZone: string): LocalDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const read = (kind: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === kind)?.value || '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
}

function localDateTimeToUtc(
  parts: LocalDateTimeParts,
  timeZone: string,
): Date | null {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  );
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(new Date(candidate), timeZone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
    );
    const delta = desired - observedAsUtc;
    candidate += delta;
    if (delta === 0) break;
  }
  const verified = localParts(new Date(candidate), timeZone);
  if (
    verified.year !== parts.year ||
    verified.month !== parts.month ||
    verified.day !== parts.day ||
    verified.hour !== parts.hour ||
    verified.minute !== parts.minute
  ) {
    return null;
  }
  return new Date(candidate);
}

function addLocalDays(
  parts: LocalDateTimeParts,
  days: number,
): LocalDateTimeParts {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days, 12),
  );
  return {
    ...parts,
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function validCalendarDate(parts: LocalDateTimeParts): boolean {
  const candidate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12),
  );
  return (
    candidate.getUTCFullYear() === parts.year &&
    candidate.getUTCMonth() + 1 === parts.month &&
    candidate.getUTCDate() === parts.day
  );
}

function parseClock(text: string): { hour: number; minute: number } | null {
  const normalized = text.toLowerCase();
  if (/\bnoon\b/.test(normalized)) return { hour: 12, minute: 0 };
  if (/\blunch(?:time)?\b/.test(normalized)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(normalized)) return { hour: 0, minute: 0 };
  if (/\bmorning\b/.test(normalized)) return { hour: 9, minute: 0 };
  if (/\bafternoon\b/.test(normalized)) return { hour: 15, minute: 0 };
  if (/\bevening|tonight\b/.test(normalized)) return { hour: 19, minute: 0 };

  const clock =
    normalized.match(
      /\b(?:at|by|around|for|to|it)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/,
    ) || normalized.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (!clock) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] || '0');
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const meridiem = clock[3].replace(/\./g, '');
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function correctionClause(value: string): string {
  const clauses = value.split(/\bbut\b|[;.]/i).map((part) => part.trim());
  if (/\bscratch\b/i.test(clauses[0] || '')) {
    const replacement = clauses
      .slice(1)
      .find((part) =>
        /\b(?:by|due|deadline|moved?|expects?|now)\b/i.test(part),
      );
    if (replacement) return replacement;
  }
  return (
    clauses.find((part) =>
      /\b(?:deadline|due|moved?|push|reschedul|correction|instead|another week|now)\b/i.test(
        part,
      ),
    ) || value
  );
}

export function isLifeThreadTemporalCorrection(value: string): boolean {
  const normalized = value.toLowerCase();
  if (!normalized.trim()) return false;
  return (
    /\b(?:actually|correction|reschedul(?:e|ed)|push(?:ed)?|moved?|changed?|make it|scratch)\b/.test(
      normalized,
    ) ||
    /\b(?:deadline|due date|scheduled time)\b.{0,40}\b(?:is|to|for)\s+now\b/.test(
      normalized,
    ) ||
    /\b(?:deadline|due date)\b.{0,40}\b(?:moved?|changed?|is now)\b/.test(
      normalized,
    ) ||
    /\b(?:another|one more) week\b/.test(normalized) ||
    /\bdue\b.{0,50}\bnot\b/.test(normalized) ||
    /\b(?:not|no longer)\b.{0,40}\b(?:due|deadline|scheduled)\b/.test(
      normalized,
    )
  );
}

export function parseLifeThreadTemporalState(params: {
  text: string;
  now: Date;
  timeZone: string;
  currentTemporalAt?: string | null;
  requireCorrection?: boolean;
}): ParsedLifeThreadTemporalState | null {
  const timeZone = normalizeLifeThreadTimeZone(params.timeZone);
  const fullText = params.text.trim();
  if (params.requireCorrection && !isLifeThreadTemporalCorrection(fullText)) {
    return null;
  }
  const text = correctionClause(fullText).toLowerCase();
  const nowParts = localParts(params.now, timeZone);
  const currentDate = params.currentTemporalAt
    ? new Date(params.currentTemporalAt)
    : null;
  const currentParts =
    currentDate && Number.isFinite(currentDate.getTime())
      ? localParts(currentDate, timeZone)
      : null;
  let target: LocalDateTimeParts = {
    ...(currentParts || nowParts),
    hour: currentParts?.hour ?? 9,
    minute: currentParts?.minute ?? 0,
  };
  let dateWasExplicit = false;
  let timeWasExplicit = false;

  if (/\b(?:another|one more) week\b/.test(text)) {
    if (!currentParts) return null;
    target = addLocalDays(currentParts, 7);
    dateWasExplicit = true;
  } else {
    const isoDate = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    const slashDate = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/);
    const monthFirst = text.match(
      /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/,
    );
    const dayFirst = text.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)(?:,?\s+(20\d{2}))?\b/,
    );
    const relative = text.match(/\b(day after tomorrow|tomorrow|today)\b/);
    const weekday = text.match(
      /\b(?:(this|next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
    );
    const ordinal = text.match(/\b(?:on|the|to)\s+(\d{1,2})(?:st|nd|rd|th)\b/);

    if (isoDate) {
      target.year = Number(isoDate[1]);
      target.month = Number(isoDate[2]);
      target.day = Number(isoDate[3]);
      dateWasExplicit = true;
    } else if (slashDate) {
      target.month = Number(slashDate[1]);
      target.day = Number(slashDate[2]);
      target.year = Number(slashDate[3] || nowParts.year);
      dateWasExplicit = true;
    } else if (monthFirst) {
      target.month = MONTHS.get(monthFirst[1])!;
      target.day = Number(monthFirst[2]);
      target.year = Number(monthFirst[3] || nowParts.year);
      dateWasExplicit = true;
    } else if (dayFirst) {
      target.day = Number(dayFirst[1]);
      target.month = MONTHS.get(dayFirst[2])!;
      target.year = Number(dayFirst[3] || nowParts.year);
      dateWasExplicit = true;
    } else if (relative) {
      const days =
        relative[1] === 'today' ? 0 : relative[1] === 'tomorrow' ? 1 : 2;
      target = addLocalDays(
        {
          ...nowParts,
          hour: target.hour,
          minute: target.minute,
        },
        days,
      );
      dateWasExplicit = true;
    } else if (weekday) {
      const desired = WEEKDAYS.indexOf(weekday[2] as (typeof WEEKDAYS)[number]);
      const current = new Date(
        Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day, 12),
      ).getUTCDay();
      let days = (desired - current + 7) % 7;
      if (weekday[1] === 'next') days += 7;
      target = addLocalDays(
        {
          ...nowParts,
          hour: target.hour,
          minute: target.minute,
        },
        days,
      );
      dateWasExplicit = true;
    } else if (ordinal) {
      target.year = currentParts?.year || nowParts.year;
      target.month = currentParts?.month || nowParts.month;
      target.day = Number(ordinal[1]);
      dateWasExplicit = true;
    }
  }

  const clock = parseClock(text);
  if (clock) {
    target.hour = clock.hour;
    target.minute = clock.minute;
    timeWasExplicit = true;
  }

  if (!dateWasExplicit && !timeWasExplicit) return null;
  if (!validCalendarDate(target)) return null;

  if (dateWasExplicit && !timeWasExplicit && !currentParts) {
    const deadlineLike = /\b(?:deadline|due|by)\b/.test(text);
    target.hour = deadlineLike ? 17 : 9;
    target.minute = 0;
  }
  if (!dateWasExplicit && timeWasExplicit && !currentParts) return null;

  let converted = localDateTimeToUtc(target, timeZone);
  if (!converted) return null;
  if (
    dateWasExplicit &&
    /\b(?:this\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/.test(
      text,
    ) &&
    !/\bnext\b/.test(text) &&
    converted.getTime() <= params.now.getTime()
  ) {
    target = addLocalDays(target, 7);
    converted = localDateTimeToUtc(target, timeZone);
    if (!converted) return null;
  }

  return {
    activeAt: converted.toISOString(),
    kind: /\b(?:deadline|due|by|application)\b/.test(text)
      ? 'deadline'
      : 'scheduled',
    dateWasExplicit,
    timeWasExplicit,
  };
}

export function formatLifeThreadTemporalTruth(params: {
  thread: Pick<LifeThread, 'title'>;
  temporal: ParsedLifeThreadTemporalState;
  timeZone: string;
}): string {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizeLifeThreadTimeZone(params.timeZone),
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(params.temporal.activeAt));
  return params.temporal.kind === 'deadline'
    ? `${params.thread.title} is due ${label}.`
    : `${params.thread.title} is scheduled for ${label}.`;
}
