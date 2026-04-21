import type {
  CompanionRouteArguments,
  CompanionRouteTimeWindowKind,
} from './types.js';

export interface ThreadSummaryIntent {
  canonicalText: string;
  arguments: CompanionRouteArguments;
}

export const ALL_SYNCED_MESSAGES_TARGET = '__all_synced_messages__';

const GENERIC_THREAD_NAME_TOKENS = new Set([
  'a',
  'an',
  'for',
  'from',
  'in',
  'last',
  'message',
  'messages',
  'my',
  'please',
  'pls',
  'recent',
  'text',
  'texts',
  'that',
  'the',
  'this',
  'thread',
  'today',
  'week',
  'yesterday',
]);

function normalizeText(value: string): string {
  return value
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAndreaAddressing(value: string): string {
  return value
    .replace(/(^|[\s([{-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(value: string): string {
  return stripAndreaAddressing(normalizeText(value));
}

function parseWindow(
  text: string,
): { cleanedText: string; kind: CompanionRouteTimeWindowKind; value: number | null } {
  const normalized = normalizeText(text);
  const lower = normalized.toLowerCase();
  const patterns: Array<{
    pattern: RegExp;
    kind: CompanionRouteTimeWindowKind;
    parseValue?(match: RegExpMatchArray): number | null;
  }> = [
    {
      pattern: /\blast\s+(\d+)\s+hours?\b/i,
      kind: 'last_hours',
      parseValue: (match) => Number.parseInt(match[1] || '', 10) || null,
    },
    {
      pattern: /\blast\s+(\d+)\s+days?\b/i,
      kind: 'last_days',
      parseValue: (match) => Number.parseInt(match[1] || '', 10) || null,
    },
    {
      pattern: /\btoday\b/i,
      kind: 'today',
    },
    {
      pattern: /\byesterday\b/i,
      kind: 'yesterday',
    },
    {
      pattern: /\bthis week\b/i,
      kind: 'this_week',
    },
  ];

  for (const candidate of patterns) {
    const match = normalized.match(candidate.pattern);
    if (!match) continue;
    return {
      cleanedText: normalizeText(
        normalized.replace(candidate.pattern, ' ').replace(/[.,!?]+$/g, ''),
      ),
      kind: candidate.kind,
      value: candidate.parseValue ? candidate.parseValue(match) : null,
    };
  }

  return {
    cleanedText: lower.replace(/[.,!?]+$/g, '').trim(),
    kind: 'default_24h',
    value: 24,
  };
}

function cleanChatName(value: string): string {
  return normalizeText(value)
    .replace(/^(?:from|in)\s+/i, '')
    .replace(/^the\s+/i, '')
    .replace(
      /\b(?:text(?: message)?s?|messages?|message|thread|chat|conversation|group(?: chat)?|space)\b/gi,
      ' ',
    )
    .replace(/\b(?:please|pls)\b/gi, ' ')
    .replace(/["']/g, '')
    .replace(/\b(?:from|in)\b\s*$/i, '')
    .replace(/[.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSpecificChatName(value: string): boolean {
  const normalized = cleanChatName(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  if (
    /^(?:for|today|yesterday|this week|recent|my|my texts?|my messages?|text messages?|messages?|texts?)$/i.test(
      normalized,
    )
  ) {
    return false;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  return tokens.some((token) => !GENERIC_THREAD_NAME_TOKENS.has(token));
}

function looksLikeThreadSummaryPrompt(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    !/\b(?:summari[sz]e|summerize|sumarize)\b/.test(lower) &&
    !/\bsummary of\b/.test(lower)
  ) {
    return false;
  }
  if (/\b(news|article|website|page|video|podcast)\b/.test(lower)) {
    return false;
  }
  if (
    /^summari[sz]e this\b/.test(lower) ||
    /^summerize this\b/.test(lower) ||
    /^sumarize this\b/.test(lower) ||
    /^summari[sz]e this message\b/.test(lower)
  ) {
    return false;
  }
  return /\b(?:text(?: message)?s?|messages|texts|thread|chat|conversation)\b/.test(
    lower,
  );
}

export function looksLikeGenericThreadSummaryPrompt(
  rawText: string | null | undefined,
): boolean {
  const normalized = normalizeForMatch(rawText || '');
  if (!normalized) {
    return false;
  }
  if (parseThreadSummaryIntent(normalized)) {
    return false;
  }
  if (looksLikeThreadSummaryPrompt(normalized)) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return (
    Boolean(parseAllSyncedMessagesSummaryIntent(normalized)) ||
    /^(?:what are|show me|give me|list)\s+(?:my\s+)?(?:recent|latest|today'?s|todays)?\s*(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    ) ||
    /^(?:what were|what was in)\s+(?:my\s+)?(?:recent|latest|today'?s|todays)?\s*(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    )
  );
}

export function parseAllSyncedMessagesSummaryIntent(
  rawText: string | null | undefined,
): ThreadSummaryIntent | null {
  const normalized = normalizeForMatch(rawText || '');
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    !/^(?:(?:yeah|yes|yep|sure|ok(?:ay)?)\s+)?(?:all\s+)?(?:my\s+)?(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    ) &&
    !/^(?:what are|show me|give me|list)\s+(?:all\s+)?(?:my\s+)?(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    )
  ) {
    return null;
  }
  if (
    /\b(?:thread|chat|conversation)\b/.test(lower) &&
    !/\ball\b/.test(lower)
  ) {
    return null;
  }
  if (
    /\b(?:in|from)\s+(?!today\b|yesterday\b|this week\b|the last\b|last\s+\d+\b)[a-z0-9]/.test(
      lower,
    ) &&
    !/\ball\b/.test(lower)
  ) {
    return null;
  }
  const { kind, value } = parseWindow(normalized);
  const canonicalText =
    kind === 'today'
      ? 'summarize all synced text messages from today'
      : kind === 'yesterday'
        ? 'summarize all synced text messages from yesterday'
        : kind === 'this_week'
          ? 'summarize all synced text messages from this week'
          : kind === 'last_hours'
            ? `summarize all synced text messages from the last ${value || 1} hours`
            : kind === 'last_days'
              ? `summarize all synced text messages from the last ${value || 1} days`
              : 'summarize all synced text messages from the last 24 hours';
  return {
    canonicalText,
    arguments: {
      targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
      targetChatName: 'all synced Messages',
      threadTitle: 'all synced Messages',
      timeWindowKind: kind,
      timeWindowValue: value,
    },
  };
}

export function parseThreadSummaryIntent(
  rawText: string | null | undefined,
): ThreadSummaryIntent | null {
  const normalized = normalizeForMatch(rawText || '');
  if (!normalized || !looksLikeThreadSummaryPrompt(normalized)) {
    return null;
  }

  const { cleanedText, kind, value } = parseWindow(normalized);
  const withoutLead = normalizeText(
    normalizeText(
      cleanedText
        .replace(
          /^(?:can you|could you|please|hey|hi|hello)\s+/i,
          '',
        )
        .replace(/\b(?:summari[sz]e|summerize|sumarize)\b/i, ''),
    )
      .replace(/^my\s+/i, '')
      .replace(/^(?:the\s+)?(?:text(?: message)?s?|messages?|texts?)\s+/i, '')
      .replace(/^(?:in|from)\s+/i, ''),
  );

  const extractionPatterns = [
    /^(?:my\s+)?(?:text(?: message)?s?|messages?|texts?)\s+(?:in|from)\s+(.+)$/i,
    /^(?:in|from)\s+(.+)$/i,
    /^(.+?)\s+(?:text(?: message)?s?|messages?|thread|chat|conversation)$/i,
    /^(.+)$/i,
  ];

  let targetChatName = '';
  for (const pattern of extractionPatterns) {
    const match = withoutLead.match(pattern);
    if (!match) continue;
    targetChatName = cleanChatName(match[1] || '');
    if (targetChatName && isSpecificChatName(targetChatName)) break;
  }

  if (!targetChatName || !isSpecificChatName(targetChatName)) {
    return null;
  }

  const canonicalText =
    kind === 'default_24h'
      ? `summarize my text messages in ${targetChatName}`
      : kind === 'last_hours'
        ? `summarize my text messages in ${targetChatName} from the last ${value || 1} hours`
        : kind === 'last_days'
          ? `summarize my text messages in ${targetChatName} from the last ${value || 1} days`
          : kind === 'today'
            ? `summarize my text messages in ${targetChatName} from today`
            : kind === 'yesterday'
              ? `summarize my text messages in ${targetChatName} from yesterday`
              : `summarize my text messages in ${targetChatName} from this week`;

  return {
    canonicalText,
    arguments: {
      targetChatName,
      threadTitle: targetChatName,
      timeWindowKind: kind,
      timeWindowValue: value,
    },
  };
}

export function formatThreadSummaryWindowLabel(
  kind: CompanionRouteTimeWindowKind | null | undefined,
  value: number | null | undefined,
): string {
  switch (kind) {
    case 'last_hours':
      return `the last ${value || 1} hour${value === 1 ? '' : 's'}`;
    case 'last_days':
      return `the last ${value || 1} day${value === 1 ? '' : 's'}`;
    case 'today':
      return 'today';
    case 'yesterday':
      return 'yesterday';
    case 'this_week':
      return 'this week';
    case 'default_24h':
    default:
      return 'the last 24 hours';
  }
}
