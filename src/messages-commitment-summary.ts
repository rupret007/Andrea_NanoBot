import { TIMEZONE } from './config.js';
import type { NewMessage } from './types.js';

export type GroundedMessagesPlanKind =
  | 'commitment'
  | 'decision'
  | 'pending_proposal'
  | 'pending_request';

export interface GroundedMessagesPlanFact {
  kind: GroundedMessagesPlanKind;
  actor: string;
  /** Speaker who supplied this plan claim; used only for safe supersession. */
  sourceSpeaker: string;
  action: string;
  deadline: string | null;
  evidence: string;
  messageId: string;
  timestamp: string;
}

function normalizePlanText(value: string | null | undefined): string {
  return (value || '').replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

function cleanAction(value: string): string {
  return normalizePlanText(value)
    .replace(/[.!?]+$/g, '')
    .replace(/\s+instead$/i, '')
    .trim();
}

function splitExplicitDeadline(value: string): {
  action: string;
  deadline: string | null;
} {
  const action = cleanAction(value);
  const time =
    '(?:noon|midnight|\\d{1,2}(?::\\d{2})?(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?))?)';
  const weekday =
    '(?:(?:this|next)\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
  const monthDate =
    '(?:january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?';
  const numericDate =
    '(?:\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?|\\d{4}-\\d{2}-\\d{2})';
  const relativeDate =
    '(?:today|tomorrow|tonight)(?:\\s+(?:morning|afternoon|evening|night))?';
  const namedDeadline = `(?:${relativeDate}|${weekday}|${monthDate}|${numericDate}|the end of (?:the )?day|end of (?:the )?day|the weekend|this (?:morning|afternoon|evening|week|weekend)|next week)`;
  const patterns: Array<{ pattern: RegExp; prefixed: boolean }> = [
    {
      pattern: new RegExp(
        `\\s+\\b(by|before)\\s+(${namedDeadline}|${time})(?:\\s+at\\s+${time})?$`,
        'i',
      ),
      prefixed: true,
    },
    {
      pattern: new RegExp(
        `\\s+\\b(on)\\s+(${namedDeadline})(?:\\s+at\\s+${time})?$`,
        'i',
      ),
      prefixed: true,
    },
    {
      pattern: new RegExp(`\\s+(${namedDeadline})(?:\\s+at\\s+${time})?$`, 'i'),
      prefixed: false,
    },
    {
      pattern: new RegExp(`\\s+\\b(at)\\s+(${time})$`, 'i'),
      prefixed: true,
    },
  ];
  for (const { pattern, prefixed } of patterns) {
    const match = action.match(pattern);
    if (!match?.index || !match[1]) continue;
    const withoutDeadline = cleanAction(action.slice(0, match.index));
    if (!prefixed && /\b(?:to|for|from|until)$/i.test(withoutDeadline)) {
      continue;
    }
    const deadline = normalizePlanText(match[0]);
    return {
      action: withoutDeadline,
      deadline: prefixed
        ? deadline
            .replace(/^\s+/, '')
            .replace(/^([A-Za-z]+)/, (prefix) => prefix.toLowerCase())
        : deadline.trim(),
    };
  }
  return { action, deadline: null };
}

function explicitReplacementCue(value: string): boolean {
  return /\b(?:actually|change of plans?|plans? changed|scratch that|instead|rather than|no longer)\b/i.test(
    value,
  );
}

function explicitPlanInvalidationCue(value: string): boolean {
  return /\b(?:change of plans?|plans? changed|scratch that|no longer|cancel(?:led|ed)?|called off)\b/i.test(
    value,
  );
}

function stripReplacementLead(value: string): string {
  return value
    .replace(
      /^(?:(?:actually|change of plans?|plans? changed|scratch that)\s*[,:—-]*\s*)+/i,
      '',
    )
    .trim();
}

function isTentativePlanClaim(value: string): boolean {
  const normalized = normalizePlanText(value);
  return (
    /\b(?:maybe|perhaps|possibly|probably|tentatively|hopefully|ideally|might|may)\b/i.test(
      normalized,
    ) ||
    /\b(?:try|trying|attempt|attempting|hope|hoping|aim|aiming|expect|expecting|intend|intending|want|wanting)\s+(?:to\s+)?/i.test(
      normalized,
    ) ||
    /\bwould\s+(?:like|hope|prefer)\s+to\b/i.test(normalized) ||
    /\b(?:if|unless|depending\s+on)\b/i.test(normalized)
  );
}

function assertedPlanKind(params: {
  requestedKind: GroundedMessagesPlanKind;
  evidence: string;
  rawAction: string;
}): GroundedMessagesPlanKind {
  if (
    (params.requestedKind === 'commitment' ||
      params.requestedKind === 'decision') &&
    (/[?]\s*$/.test(params.evidence) || isTentativePlanClaim(params.rawAction))
  ) {
    return 'pending_proposal';
  }
  return params.requestedKind;
}

function buildFact(params: {
  message: NewMessage;
  kind: GroundedMessagesPlanKind;
  actor: string;
  sourceSpeaker: string;
  rawAction: string;
}): GroundedMessagesPlanFact | null {
  const actor = normalizePlanText(params.actor);
  const { action, deadline } = splitExplicitDeadline(params.rawAction);
  if (!actor || !action || action.length < 2) return null;
  return {
    kind: assertedPlanKind({
      requestedKind: params.kind,
      evidence: params.message.content,
      rawAction: params.rawAction,
    }),
    actor,
    sourceSpeaker: normalizePlanText(params.sourceSpeaker),
    action,
    deadline,
    evidence: normalizePlanText(params.message.content),
    messageId: params.message.id,
    timestamp: params.message.timestamp,
  };
}

function parseMessagePlanFact(params: {
  message: NewMessage;
  speaker: string;
  secondPerson: string | null;
}): GroundedMessagesPlanFact | null {
  const evidence = normalizePlanText(params.message.content);
  if (!evidence) return null;
  const text = stripReplacementLead(evidence);
  let match: RegExpMatchArray | null;

  match = text.match(
    /^(?:i(?:\s+will|'ll|\s+am\s+going\s+to|'m\s+going\s+to)|i\s+(?:promise|commit)\s+to)\s+(.+)$/i,
  );
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'commitment',
      actor: params.speaker,
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^i\s+(?:decided|agreed|confirmed)\s+to\s+(.+)$/i);
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'decision',
      actor: params.speaker,
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^we\s+(?:decided|agreed|confirmed)\s+to\s+(.+)$/i);
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'decision',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^(?:the\s+)?plan\s+is\s+(?:to\s+)?(.+)$/i);
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'decision',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^we(?:'re|\s+are)\s+going\s+to\s+(.+)$/i);
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'decision',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(
    /^(?:maybe\s+|perhaps\s+)?(?:we\s+(?:should|could)|should\s+we|could\s+we|what\s+if\s+we|let(?:'s|\s+us))\s+(.+?)\??$/i,
  );
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'pending_proposal',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^how\s+about\s+(.+?)\??$/i);
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'pending_proposal',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(
    /^(?:maybe\s+|perhaps\s+)?i\s+(?:should|could)\s+(.+?)\??$/i,
  );
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'pending_proposal',
      actor: params.speaker,
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(
    /^(?:maybe\s+|perhaps\s+)?i\s+(?:might|may|hope\s+to|am\s+trying\s+to|'m\s+trying\s+to|would\s+like\s+to)\s+(.+?)\??$/i,
  );
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'pending_proposal',
      actor: params.speaker,
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(
    /^(?:maybe\s+|perhaps\s+)?we\s+(?:might|may|hope\s+to|are\s+trying\s+to|'re\s+trying\s+to|would\s+like\s+to)\s+(.+?)\??$/i,
  );
  if (match?.[1]) {
    return buildFact({
      message: params.message,
      kind: 'pending_proposal',
      actor: 'Shared plan',
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  match = text.match(/^(?:can|could|would|will)\s+you\s+(.+?)\??$/i);
  if (match?.[1] && params.secondPerson) {
    return buildFact({
      message: params.message,
      kind: 'pending_request',
      actor: params.secondPerson,
      sourceSpeaker: params.speaker,
      rawAction: match[1],
    });
  }

  return null;
}

/**
 * Extracts only explicit plan language from a bounded Messages transcript.
 * Questions and proposals remain pending. An explicit later replacement drops
 * the latest active plan for the same stated actor before adding the new one.
 */
export function extractGroundedMessagesPlanFacts(params: {
  messages: NewMessage[];
  getSpeakerLabel: (message: NewMessage) => string;
  getSecondPersonLabel?: (message: NewMessage) => string | null;
}): GroundedMessagesPlanFact[] {
  const ordered = params.messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const chronological = left.message.timestamp.localeCompare(
        right.message.timestamp,
      );
      return chronological || left.index - right.index;
    });
  const active: GroundedMessagesPlanFact[] = [];
  for (const { message } of ordered) {
    const speaker = params.getSpeakerLabel(message);
    const fact = parseMessagePlanFact({
      message,
      speaker,
      secondPerson: params.getSecondPersonLabel?.(message) || null,
    });
    if (!fact) {
      if (explicitPlanInvalidationCue(message.content)) {
        for (let index = active.length - 1; index >= 0; index -= 1) {
          if (
            active[index]?.sourceSpeaker.toLowerCase() === speaker.toLowerCase()
          ) {
            active.splice(index, 1);
            break;
          }
        }
      }
      continue;
    }
    if (explicitReplacementCue(message.content)) {
      let replacementIndex = -1;
      for (let index = active.length - 1; index >= 0; index -= 1) {
        if (
          active[index]?.actor.toLowerCase() === fact.actor.toLowerCase() &&
          active[index]?.sourceSpeaker.toLowerCase() ===
            fact.sourceSpeaker.toLowerCase()
        ) {
          replacementIndex = index;
          break;
        }
      }
      if (replacementIndex >= 0) active.splice(replacementIndex, 1);
    }
    active.push(fact);
  }
  return active;
}

export function formatGroundedMessagesPlanFact(
  fact: GroundedMessagesPlanFact,
  options: { timeZone?: string } = {},
): string {
  const state =
    fact.kind === 'commitment'
      ? 'Committed'
      : fact.kind === 'decision'
        ? 'Decided'
        : fact.kind === 'pending_request'
          ? 'Pending request'
          : 'Pending proposal';
  const action = fact.action.replace(/[.!?]+$/g, '').trim();
  const statedAt = formatGroundedMessagesPlanTimestamp(
    fact.timestamp,
    options.timeZone || TIMEZONE,
  );
  return `${state} — ${fact.actor}: ${action}. Deadline: ${fact.deadline || 'not stated'}.${statedAt ? ` Stated: ${statedAt}.` : ''}`;
}

export function formatGroundedMessagesPlanTimestamp(
  value: string | null | undefined,
  timeZone = TIMEZONE,
): string | null {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return null;
  }
}
