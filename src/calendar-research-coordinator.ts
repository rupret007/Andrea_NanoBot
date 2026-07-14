import { isExplicitGoogleCalendarCreateRequest } from './google-calendar-create.js';

export interface CompoundCalendarResearchPlan {
  calendarText: string;
  researchText: string;
  requestedDepth: 'standard' | 'deep';
  allowWebSearch: true;
  explicitMaxEffort: boolean;
}

const MAX_EFFORT_RE =
  /\b(?:use|using)\s+(?:(?:all|every)\s+(?:the\s+)?(?:available\s+)?resources(?:\s+available)?|everything)|\ball\s+(?:the\s+)?(?:available\s+)?resources(?:\s+available)?\b|\beverything\b|\bmax[- ]?iq\b|\bultrathink\b|\bcomprehensive(?:ly)?\b|\bthorough(?:ly)?\b|\bdeep\s+dive\b/i;

const RESEARCH_BOUNDARY_RE =
  /\s*;\s*|\s*,?\s+(?:and\s+then|then)\s+|\s*,?\s+and\s+/gi;

const STRONG_AND_CUE_RE =
  /^(?:(?:also|please)\b|(?:can|could|would)\s+you\b|(?:kick\s+off|start)\s+(?:some\s+)?research\b|(?:use|using)\s+(?:(?:all|every)\s+(?:the\s+)?(?:available\s+)?resources(?:\s+available)?|everything)\b)/i;

const EXPLICIT_RESEARCH_LAUNCH_RE =
  /^(?:(?:also|please)\s+)*(?:(?:can|could|would)\s+you\s+)?(?:(?:also|please)\s+)*(?:have\s+(?:it|you)\s+)?(?:kick\s+off|start)\s+(?:some\s+)?research\b/i;

const RESEARCH_PREFIX_RE =
  /^(?:(?:also|please)\s+)*(?:(?:can|could|would)\s+you\s+)?(?:(?:also|please)\s+)*(?:have\s+(?:it|you)\s+)?/i;

function normalizeInput(value: string): string {
  return value
    .replace(/(^|[\s([{-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimClause(value: string): string {
  return value
    .replace(/^[,;:\s]+/, '')
    .replace(/\s+(?:please|thanks|thank you)[.!?]*$/i, '')
    .replace(/[.!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeCalendarClause(value: string): string {
  return trimClause(value)
    .replace(
      /\b(?:morning|afternoon|evening)\s+(?=at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)\b)/i,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === '\\';
    cursor--
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function isWordCharacter(value: string | undefined): boolean {
  return Boolean(value && /[\p{L}\p{N}]/u.test(value));
}

function isApostrophe(value: string, index: number): boolean {
  return isWordCharacter(value[index - 1]) && isWordCharacter(value[index + 1]);
}

function isInsideSymmetricDelimiter(
  value: string,
  index: number,
  delimiter: '"' | "'" | '`',
): boolean {
  const positions: number[] = [];
  for (let cursor = 0; cursor < value.length; cursor++) {
    if (value[cursor] !== delimiter || isEscaped(value, cursor)) continue;
    if (delimiter === "'" && isApostrophe(value, cursor)) continue;
    positions.push(cursor);
  }

  const before = positions.filter((position) => position < index).length;
  const after = positions.length - before;
  return before % 2 === 1 || after % 2 === 1;
}

function isInsidePairedDelimiter(
  value: string,
  index: number,
  opener: string,
  closer: string,
): boolean {
  const openers: number[] = [];
  const unmatchedClosers: number[] = [];
  const spans: Array<{ start: number; end: number }> = [];

  for (let cursor = 0; cursor < value.length; cursor++) {
    const character = value[cursor];
    if (character === opener) {
      openers.push(cursor);
      continue;
    }
    if (character !== closer) continue;
    if (closer === '’' && isApostrophe(value, cursor)) continue;

    const start = openers.pop();
    if (start === undefined) {
      unmatchedClosers.push(cursor);
    } else {
      spans.push({ start, end: cursor });
    }
  }

  return (
    spans.some((span) => span.start < index && index < span.end) ||
    openers.some((position) => position < index) ||
    unmatchedClosers.some((position) => position > index)
  );
}

function isInsideProtectedTitleBoundary(value: string, index: number): boolean {
  if (
    isInsideSymmetricDelimiter(value, index, '"') ||
    isInsideSymmetricDelimiter(value, index, "'") ||
    isInsideSymmetricDelimiter(value, index, '`')
  ) {
    return true;
  }

  return [
    ['“', '”'],
    ['‘', '’'],
    ['«', '»'],
    ['‹', '›'],
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ].some(([opener, closer]) =>
    isInsidePairedDelimiter(value, index, opener, closer),
  );
}

function isPlainAndBoundary(boundary: string): boolean {
  return (
    !boundary.includes(';') &&
    /\band\b/i.test(boundary) &&
    !/\bthen\b/i.test(boundary)
  );
}

function hasUnboundedTitleIntroducer(calendarPrefix: string): boolean {
  const titleMatch = [
    ...calendarPrefix.matchAll(/\b(?:titled|called|named)\b/gi),
  ].at(-1);
  if (titleMatch?.index === undefined) return false;
  const titleRemainder = calendarPrefix.slice(
    titleMatch.index + titleMatch[0].length,
  );
  return !/\b(?:today|tonight|tomorrow|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|am|pm)?)\b/i.test(
    titleRemainder,
  );
}

function canonicalizeResearchClause(value: string): string | null {
  let clause = trimClause(value).replace(RESEARCH_PREFIX_RE, '').trim();
  clause = clause
    .replace(
      /^(?:use|using)\s+(?:(?:all|every)\s+(?:the\s+)?(?:available\s+)?resources(?:\s+available)?|everything)(?:\s+to)?\s+/i,
      '',
    )
    .replace(/^(?:comprehensive(?:ly)?|thorough(?:ly)?)\s+/i, '')
    .replace(/^deep\s+dive\s+(?:on|into)\s+/i, 'research ')
    .trim();

  const match = clause.match(
    /^(research|(?:kick\s+off|start)\s+(?:some\s+)?research|look\s+for|look\s+up|look\s+into|find|investigate|compare|recommend)\b\s*(.+)$/i,
  );
  if (!match?.[2]?.trim()) return null;

  const verb = match[1].toLowerCase().replace(/\s+/g, ' ');
  const subject = trimClause(match[2])
    .replace(/^on\s+/i, '')
    .replace(
      /\s+(?:and|then)\s+(?:provide|send|give)(?:\s+me)?\s+(?:the\s+)?(?:results?|findings?|answer|report)(?:\s+back)?$/i,
      '',
    )
    .trim();
  if (!subject) return null;

  if (verb === 'compare') return `compare ${subject}`;
  if (verb === 'recommend') return `recommend ${subject}`;
  if (/^(?:kick off|start)(?: some)? research$/.test(verb)) {
    return `research ${subject}`;
  }
  if (
    (verb === 'look for' || verb === 'find') &&
    /^(?:me\s+)?(?:(?:a|an|the|some)\s+)?(?:good|best|right|suitable|recommended)\b/i.test(
      subject,
    )
  ) {
    return `recommend ${subject}`;
  }
  return `research ${subject}`;
}

/**
 * Conservatively splits one explicit calendar-create request from a following
 * research sidecar. General conjunctions remain part of the event title; a
 * split is possible only at a clause boundary immediately followed by an
 * unmistakable research verb.
 */
export function planCompoundCalendarResearchRequest(
  text: string,
): CompoundCalendarResearchPlan | null {
  const normalized = normalizeInput(text);
  if (!normalized) return null;

  RESEARCH_BOUNDARY_RE.lastIndex = 0;
  for (const match of normalized.matchAll(RESEARCH_BOUNDARY_RE)) {
    if (match.index === undefined) continue;
    if (isInsideProtectedTitleBoundary(normalized, match.index)) continue;
    const researchClause = normalized.slice(match.index + match[0].length);
    if (
      isPlainAndBoundary(match[0]) &&
      !STRONG_AND_CUE_RE.test(researchClause)
    ) {
      continue;
    }
    const calendarText = sanitizeCalendarClause(
      normalized.slice(0, match.index),
    );
    if (hasUnboundedTitleIntroducer(calendarText)) continue;
    const researchText = canonicalizeResearchClause(researchClause);
    if (
      !calendarText ||
      !researchText ||
      !isExplicitGoogleCalendarCreateRequest(calendarText)
    ) {
      continue;
    }

    const explicitMaxEffort = MAX_EFFORT_RE.test(researchClause);
    return {
      calendarText,
      researchText,
      requestedDepth:
        explicitMaxEffort || EXPLICIT_RESEARCH_LAUNCH_RE.test(researchClause)
          ? 'deep'
          : 'standard',
      allowWebSearch: true,
      explicitMaxEffort,
    };
  }

  return null;
}
