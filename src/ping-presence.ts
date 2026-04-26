import { CronExpressionParser } from 'cron-parser';

import { ASSISTANT_NAME, TIMEZONE } from './config.js';

export const ANDREA_PING_PERSONALITY_LINES = [
  'Status green. Chaos remains politely outside.',
  'Online and keeping the tiny control tower tidy.',
  'Systems steady. Drama is staying in the lobby.',
  'Present and accounted for. The checklists can exhale.',
  'Operational, alert, and only mildly suspicious of loose ends.',
  'The lights are on. The chaos is filling out paperwork.',
] as const;

const TELEGRAM_TOP_OF_HOUR_CRON = '0 * * * *';

function normalizeReferenceDate(reference?: Date | string | null): Date | null {
  if (reference instanceof Date) {
    return Number.isFinite(reference.getTime()) ? new Date(reference) : null;
  }
  if (typeof reference === 'string' && reference.trim()) {
    const parsed = Date.parse(reference);
    return Number.isFinite(parsed) ? new Date(parsed) : null;
  }
  if (reference == null) {
    return new Date();
  }
  return null;
}

function buildHourBucket(reference: Date, timeZone = TIMEZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(reference);

  const values = new Map(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return `${values.get('year')}-${values.get('month')}-${values.get('day')}T${values.get('hour')}`;
}

function pickDeterministicVariant(
  seed: string,
  variants: readonly string[],
): string {
  const sum = [...seed].reduce((total, char) => total + char.charCodeAt(0), 0);
  return variants[sum % variants.length] || variants[0] || '';
}

function normalizeReplyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function resolveAndreaPingPresenceLine(
  reference?: Date | string | null,
  timeZone = TIMEZONE,
): string {
  const normalized = normalizeReferenceDate(reference) || new Date();
  return pickDeterministicVariant(
    buildHourBucket(normalized, timeZone),
    ANDREA_PING_PERSONALITY_LINES,
  );
}

export function buildAndreaPingPresenceReply(
  assistantName = ASSISTANT_NAME,
  reference?: Date | string | null,
  timeZone = TIMEZONE,
): string {
  return `${assistantName} is online.\n${resolveAndreaPingPresenceLine(reference, timeZone)}`;
}

export function isApprovedAndreaPingPresenceLine(
  line: string | null | undefined,
): boolean {
  if (!line) return false;
  return ANDREA_PING_PERSONALITY_LINES.includes(
    line.trim() as (typeof ANDREA_PING_PERSONALITY_LINES)[number],
  );
}

export function matchesAndreaPingPresenceReply(
  text: string,
  assistantName = ASSISTANT_NAME,
): boolean {
  const lines = normalizeReplyLines(text);
  const primaryLine = `${assistantName} is online.`;

  if (lines.length === 1) {
    return lines[0] === primaryLine;
  }

  if (lines.length !== 2) {
    return false;
  }

  return lines[0] === primaryLine && isApprovedAndreaPingPresenceLine(lines[1]);
}

export function computeNextTelegramRoundtripDueAt(
  reference?: Date | string | null,
  timeZone = TIMEZONE,
): string | null {
  const normalized = normalizeReferenceDate(reference);
  if (!normalized) return null;

  try {
    return CronExpressionParser.parse(TELEGRAM_TOP_OF_HOUR_CRON, {
      currentDate: normalized,
      tz: timeZone,
    })
      .next()
      .toISOString();
  } catch {
    return null;
  }
}
