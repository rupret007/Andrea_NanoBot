/**
 * Person- and thread-grounded local wording for Texts summarize/draft.
 * Suggested replies and acknowledgements stay unsent. Callers must still
 * withhold owner-answer questions, automated notices, and group send.
 */

export type ThreadGroundedAckStyle =
  | 'warm'
  | 'brief'
  | 'direct'
  | 'careful'
  | 'timing';

export interface ThreadGroundedSuggestedReply {
  label: string;
  text: string;
}

const OWNER_ANSWER_RE =
  /\?|\b(?:can you|could you|would you|will you|do you|did you|are you|were you|should we|should i|do you want|let me know|lmk|need you to|please\s+(?:send|share|confirm|call|bring|reply|tell)|send me|share with me|tell me|confirm)\b/i;

const ACK_ONLY_RE =
  /^(?:ok(?:ay)?|thanks(?: so much)?|thank you|thx|got it|sounds good|perfect|great|cool|nice|no worries|you(?:'re| are) welcome|lol|haha)[!. ]*$/i;

const INFORMATIONAL_GLUE_RE =
  /\b(?:just (?:keeping you posted|sharing the update|letting you know|an update)|fyi|heads-?up)\b/gi;

const GENERIC_ANCHOR_WORDS = new Set([
  'a',
  'an',
  'hey',
  'hi',
  'hello',
  'i',
  'just',
  'ok',
  'okay',
  'thanks',
  'that',
  'the',
  'this',
  'we',
  'yeah',
  'yes',
  'you',
  'your',
]);

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function clipAnchor(value: string, max = 80): string {
  const normalized = normalizeText(value).replace(/[\s,;:.!]+$/g, '');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function cleanedInformationalInbound(
  inboundText: string | null | undefined,
): string {
  return clipAnchor(
    normalizeText(inboundText).replace(INFORMATIONAL_GLUE_RE, ' '),
    160,
  );
}

function capitalizeAnchor(value: string): string {
  const normalized = normalizeText(value);
  if (!normalized) return normalized;
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function shouldWithholdThreadGroundedReply(
  inboundText: string | null | undefined,
): boolean {
  const content = normalizeText(inboundText);
  if (!content || content.length < 8) return true;
  if (ACK_ONLY_RE.test(content)) return true;
  return OWNER_ANSWER_RE.test(content);
}

export function extractConcreteThreadUpdateAnchor(
  inboundText: string | null | undefined,
): string | null {
  if (shouldWithholdThreadGroundedReply(inboundText)) return null;
  const cleaned = cleanedInformationalInbound(inboundText);
  if (!cleaned) return null;

  const moved = cleaned.match(/^(.{2,48}?)\s+moved to\s+(.+)$/i);
  if (moved?.[1] && moved[2]) {
    return clipAnchor(`${moved[1]} at ${moved[2]}`);
  }
  const starts = cleaned.match(
    /^(.{2,48}?)\s+(?:starts?|is|are)\s+at\s+(.+)$/i,
  );
  if (starts?.[1] && starts[2]) {
    return clipAnchor(`${starts[1]} at ${starts[2]}`);
  }
  return null;
}

export function extractThreadUpdateAnchor(
  inboundText: string | null | undefined,
): string | null {
  const concrete = extractConcreteThreadUpdateAnchor(inboundText);
  if (concrete) return concrete;
  if (shouldWithholdThreadGroundedReply(inboundText)) return null;
  const cleaned = cleanedInformationalInbound(inboundText);
  if (!cleaned) return null;

  for (const match of cleaned.matchAll(
    /\b([A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+){0,2})\b/g,
  )) {
    const topic = match[1] || '';
    if (
      topic &&
      topic.length >= 3 &&
      !GENERIC_ANCHOR_WORDS.has(topic.toLowerCase())
    ) {
      return topic;
    }
  }
  return null;
}

export function buildThreadGroundedAcknowledgement(input: {
  inboundText: string;
  style: ThreadGroundedAckStyle;
  requireConcreteUpdate?: boolean;
}): string | null {
  if (shouldWithholdThreadGroundedReply(input.inboundText)) return null;
  const anchor = input.requireConcreteUpdate
    ? extractConcreteThreadUpdateAnchor(input.inboundText)
    : extractThreadUpdateAnchor(input.inboundText);
  if (input.requireConcreteUpdate && !anchor) {
    return null;
  }
  if (!anchor) {
    switch (input.style) {
      case 'warm':
        return 'Thanks for the heads-up. I appreciate it.';
      case 'careful':
        return 'I hear you. Thanks for telling me directly.';
      case 'timing':
        return 'Thanks for the timing update.';
      case 'direct':
        return 'Thanks for the update.';
      case 'brief':
        return 'Got it.';
    }
  }

  switch (input.style) {
    case 'warm':
      return `Thanks for the heads-up — ${anchor}.`;
    case 'brief':
      return `Got it—${anchor}.`;
    case 'direct':
      return `${capitalizeAnchor(anchor)}. Thanks.`;
    case 'careful':
      return `I hear you on ${anchor}.`;
    case 'timing':
      return `Thanks for the timing update on ${anchor}.`;
  }
}

export function buildThreadGroundedSuggestedReplies(input: {
  inboundText: string;
  isGroup: boolean;
  sensitive?: boolean;
  deadline?: boolean;
  toneStyleHints?: string[];
  contextConfidence?: 'high' | 'medium' | 'low';
  withhold?: boolean;
}): ThreadGroundedSuggestedReply[] {
  if (input.withhold || shouldWithholdThreadGroundedReply(input.inboundText)) {
    return [];
  }

  const tone = (input.toneStyleHints || []).join(' ').toLowerCase();
  const preferWarm = /\bwarm|careful|avoid_overcommitment/.test(tone);
  const preferDirect = /\bconcise|direct/.test(tone);

  if (input.isGroup || input.contextConfidence === 'low') {
    return [
      {
        label: input.isGroup ? 'careful' : 'careful',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'careful',
          }) || 'Thanks for the update.',
      },
      {
        label: 'brief',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'brief',
          }) || 'Got it.',
      },
    ];
  }

  if (input.sensitive) {
    return [
      {
        label: 'warm',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'careful',
          }) || 'I hear you. Thanks for telling me directly.',
      },
      {
        label: 'direct',
        text: "I hear what you're saying.",
      },
      {
        label: 'brief',
        text: 'I saw your message. I hear you.',
      },
    ];
  }

  if (preferWarm) {
    return [
      {
        label: 'warm',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'warm',
          }) || 'Thanks for the heads-up. I appreciate it.',
      },
      {
        label: 'direct',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'direct',
          }) || 'Thanks for the update.',
      },
      {
        label: 'brief',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'brief',
          }) || 'Got it.',
      },
    ];
  }

  if (preferDirect) {
    return [
      {
        label: 'direct',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'direct',
          }) || 'Thanks for the update.',
      },
      {
        label: 'brief',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'brief',
          }) || 'Got it.',
      },
    ];
  }

  if (input.deadline) {
    return [
      {
        label: 'warm',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'timing',
          }) || 'Thanks for the timing update.',
      },
      {
        label: 'direct',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'direct',
          }) || 'Got the timing update.',
      },
      {
        label: 'brief',
        text:
          buildThreadGroundedAcknowledgement({
            inboundText: input.inboundText,
            style: 'brief',
          }) || 'Got it.',
      },
    ];
  }

  return [
    {
      label: 'warm',
      text:
        buildThreadGroundedAcknowledgement({
          inboundText: input.inboundText,
          style: 'warm',
        }) || 'Thanks for the update.',
    },
    {
      label: 'brief',
      text:
        buildThreadGroundedAcknowledgement({
          inboundText: input.inboundText,
          style: 'brief',
        }) || 'Got it.',
    },
  ];
}

export function companionStyleToThreadAckStyle(
  style: 'balanced' | 'warmer' | 'direct' | 'short',
  toneHints: string[] = [],
): ThreadGroundedAckStyle {
  if (style === 'warmer') return 'warm';
  if (style === 'short') return 'brief';
  if (style === 'direct') return 'direct';
  const tone = toneHints.join(' ').toLowerCase();
  if (/\bwarm|careful|avoid_overcommitment/.test(tone)) return 'warm';
  if (/\bconcise|direct/.test(tone)) return 'direct';
  return 'warm';
}
