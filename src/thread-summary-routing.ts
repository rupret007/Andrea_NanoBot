import type {
  CompanionRouteArguments,
  CompanionRouteTimeWindowKind,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

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
  'past',
  'please',
  'pls',
  'previous',
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

const TEXT_MESSAGE_RE = /\b(?:text(?: message)?s?|messages?|texts)\b/i;
const SUMMARY_RE = /\b(?:summari[sz]e|summerize|sumarize|summary)\b/i;
const BLUEBUBBLES_RE = /\b(?:blue\s*bubbles|bluebubbles|synced messages)\b/i;

function stripAssistantAddressing(value: string): string {
  return value
    .replace(/(^|[\s([{-])@(andrea|openclaw)\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(value: string): string {
  return stripAssistantAddressing(normalizeVoicePrompt(normalizeText(value)));
}

function stripTrailingWindowGlue(value: string): string {
  let current = normalizeText(value);
  let previous = '';
  while (current && current !== previous) {
    previous = current;
    current = normalizeText(
      current
        .replace(/\b(?:from|in|for|over)(?:\s+the)?\s*$/i, '')
        .replace(/\bthe\s*$/i, ''),
    );
  }
  return current;
}

function parseWindow(text: string): {
  cleanedText: string;
  kind: CompanionRouteTimeWindowKind;
  value: number | null;
} {
  const normalized = normalizeText(text);
  const patterns: Array<{
    pattern: RegExp;
    kind: CompanionRouteTimeWindowKind;
    parseValue?(match: RegExpMatchArray): number | null;
  }> = [
    {
      pattern: /\b(?:last|past|previous)\s+(\d+)\s+hours?\b/i,
      kind: 'last_hours',
      parseValue: (match) => Number.parseInt(match[1] || '', 10) || null,
    },
    {
      pattern: /\b(?:last|past|previous)\s+(\d+)\s+days?\b/i,
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
      cleanedText: stripTrailingWindowGlue(
        normalized.replace(candidate.pattern, ' ').replace(/[.,!?]+$/g, ''),
      ),
      kind: candidate.kind,
      value: candidate.parseValue ? candidate.parseValue(match) : null,
    };
  }

  return {
    cleanedText: stripTrailingWindowGlue(normalized.replace(/[.,!?]+$/g, '')),
    kind: 'default_24h',
    value: 24,
  };
}

function cleanChatName(value: string): string {
  return stripTrailingWindowGlue(
    normalizeText(value)
      .replace(/^(?:from|in|for|over)\s+/i, '')
      .replace(/^the\s+/i, '')
      .replace(
        /\b(?:text(?: message)?s?|messages?|message|thread|chat|conversation|group(?: chat)?|space)\b/gi,
        ' ',
      )
      .replace(/\b(?:please|pls)\b/gi, ' ')
      .replace(/["']/g, '')
      .replace(/[.,!?]+$/g, ''),
  );
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

const BARE_CHAT_NAME_CLAUSE_TOKENS = new Set([
  'about',
  'because',
  'could',
  'everything',
  'how',
  'if',
  'it',
  'leave',
  'need',
  'needs',
  'said',
  'says',
  'should',
  'stuff',
  'that',
  'want',
  'we',
  'what',
  'whether',
  'why',
  'would',
]);

const BARE_CHAT_NAME_SOLO_REJECT = new Set([
  'afternoon',
  'agenda',
  'article',
  'brief',
  'calendar',
  'day',
  'days',
  'email',
  'emails',
  'evening',
  'inbox',
  'mail',
  'month',
  'morning',
  'news',
  'schedule',
  'tonight',
  'week',
  'weekend',
  'weeks',
  'year',
]);

function isPlausibleBareChatName(value: string): boolean {
  if (!isSpecificChatName(value)) {
    return false;
  }
  const tokens = cleanChatName(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) {
    return false;
  }
  if (tokens.length === 1 && BARE_CHAT_NAME_SOLO_REJECT.has(tokens[0] || '')) {
    return false;
  }
  if (tokens.some((token) => BARE_CHAT_NAME_CLAUSE_TOKENS.has(token))) {
    return false;
  }
  return tokens.every((token) => /^[a-z][a-z0-9'&.-]*$/i.test(token));
}

function looksLikeSummarizeThisPrompt(lower: string): boolean {
  return (
    /^summari[sz]e this\b/.test(lower) ||
    /^summerize this\b/.test(lower) ||
    /^sumarize this\b/.test(lower) ||
    /^summari[sz]e this message\b/.test(lower)
  );
}

function looksLikeThreadSummaryPrompt(value: string): boolean {
  const lower = value.toLowerCase();
  if (!SUMMARY_RE.test(lower) && !/\bsummary of\b/.test(lower)) {
    return false;
  }
  if (/\b(news|article|website|page|video|podcast)\b/.test(lower)) {
    return false;
  }
  if (looksLikeSummarizeThisPrompt(lower)) {
    return false;
  }
  return (
    TEXT_MESSAGE_RE.test(lower) ||
    /\b(?:thread|chat|conversation)\b/.test(lower)
  );
}

function referencesSpecificChatForBroadSummary(lower: string): boolean {
  return /\b(?:in|from|with)\s+(?!(?:today\b|yesterday\b|this week\b|the\s+(?:last|past|previous)\b|(?:last|past|previous)\s+\d+\b|all\b|my\b|recent\b|latest\b))[a-z0-9]/i.test(
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

export function parseRecentTextReviewIntent(
  rawText: string | null | undefined,
): ThreadSummaryIntent | null {
  const normalized = normalizeForMatch(rawText || '');
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (/\b(news|article|website|page|video|podcast|email|mail)\b/.test(lower)) {
    return null;
  }
  const matchesReview =
    /\b(?:review|check|scan)\s+(?:my\s+)?(?:recent\s+|latest\s+|today'?s\s+|todays\s+)?(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    ) ||
    /\b(?:what|which)\s+(?:texts?|text messages?|messages?)\s+(?:need|needs|require|requires)\s+(?:me|my reply|a reply|an answer|attention)\b/.test(
      lower,
    ) ||
    /\b(?:what should i|what do i need to|who should i)\s+(?:reply|respond|answer)\s+(?:to|back to)?\b/.test(
      lower,
    ) ||
    /\b(?:summari[sz]e|summerize|sumarize)\s+(?:my\s+)?recent interactions\b/.test(
      lower,
    ) ||
    /\b(?:texts?|messages?)\s+(?:i owe|that i owe|waiting on me|needing me|need a reply)\b/.test(
      lower,
    );
  if (!matchesReview) return null;

  const { kind, value } = parseWindow(normalized);
  const canonicalText =
    kind === 'today'
      ? 'review recent text messages from today'
      : kind === 'yesterday'
        ? 'review recent text messages from yesterday'
        : kind === 'this_week'
          ? 'review recent text messages from this week'
          : kind === 'last_hours'
            ? `review recent text messages from the last ${value || 1} hours`
            : kind === 'last_days'
              ? `review recent text messages from the last ${value || 1} days`
              : 'review recent text messages from the last 24 hours';
  return {
    canonicalText,
    arguments: {
      targetChatJid: ALL_SYNCED_MESSAGES_TARGET,
      targetChatName: 'all synced Messages',
      threadTitle: 'recent text review',
      timeWindowKind: kind,
      timeWindowValue: value,
    },
  };
}

export function parseAllSyncedMessagesSummaryIntent(
  rawText: string | null | undefined,
): ThreadSummaryIntent | null {
  const normalized = normalizeForMatch(rawText || '');
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    /\b(?:news|article|website|page|video|podcast|email|mail)\b/.test(lower)
  ) {
    return null;
  }
  const missesBroadTextLead =
    !/^(?:(?:yeah|yes|yep|sure|ok(?:ay)?)\s+)?(?:all\s+)?(?:my\s+)?(?:(?:recent|latest|today'?s|todays)\s+)?(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    ) &&
    !/^(?:what are|show me|give me|list)\s+(?:all\s+)?(?:my\s+)?(?:(?:recent|latest|today'?s|todays)\s+)?(?:text(?: message)?s?|messages|texts)\b/.test(
      lower,
    );
  const broadSummaryAsk =
    SUMMARY_RE.test(lower) &&
    TEXT_MESSAGE_RE.test(lower) &&
    (/\b(?:my|all|synced)\b/.test(lower) || BLUEBUBBLES_RE.test(lower));
  if (missesBroadTextLead && !broadSummaryAsk) {
    return null;
  }
  if (
    /\b(?:thread|chat|conversation)\b/.test(lower) &&
    !/\ball\b/.test(lower)
  ) {
    return null;
  }
  if (referencesSpecificChatForBroadSummary(lower) && !/\ball\b/.test(lower)) {
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
  if (!normalized) {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (!SUMMARY_RE.test(lower) && !/\bsummary of\b/.test(lower)) {
    return null;
  }
  if (/\b(news|article|website|page|video|podcast|email|mail)\b/.test(lower)) {
    return null;
  }
  if (looksLikeSummarizeThisPrompt(lower)) {
    return null;
  }

  const hasThreadCue =
    TEXT_MESSAGE_RE.test(lower) ||
    /\b(?:thread|chat|conversation)\b/.test(lower);

  const { cleanedText, kind, value } = parseWindow(normalized);
  const withoutLead = stripTrailingWindowGlue(
    normalizeText(
      normalizeText(
        cleanedText
          .replace(/^(?:can you|could you|please|hey|hi|hello)\s+/i, '')
          .replace(/\b(?:summari[sz]e|summerize|sumarize|summary of)\b/i, ''),
      )
        .replace(/^my\s+/i, '')
        .replace(/^(?:the\s+)?(?:text(?: message)?s?|messages?|texts?)\s+/i, '')
        .replace(/^(?:in|from|for|over)\s+/i, ''),
    ),
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
  if (!hasThreadCue && !isPlausibleBareChatName(targetChatName)) {
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
