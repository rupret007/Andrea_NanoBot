/**
 * Named who-do-I-owe / draft-for-Bob-yes policy and Jeff-facing copy.
 * These helpers stay local and unsent so hosted tests can prove the leftover
 * without live Messages send, credentials, or BlueBubbles send HTTP.
 */

import {
  parseNamedDraftIntent,
  parseNamedOpenLoopIntent,
} from './thread-summary-routing.js';
import {
  shouldWithholdThreadGroundedReply,
  type ThreadGroundedSummaryGist,
} from './thread-grounded-wording.js';

export type NamedOpenLoopChannel = 'alexa' | 'telegram' | 'bluebubbles';

export type NamedOpenLoopBinding =
  | { kind: 'denied'; reason: 'untrusted_named' }
  | { kind: 'generic' }
  | { kind: 'named'; query: string; source: 'explicit' | 'seed' };

export type NamedOpenLoopDraftFollowup =
  | { kind: 'none' }
  | { kind: 'denied'; reason: 'untrusted_named' }
  | { kind: 'draft'; query: string; source: 'named_command' | 'soft_yes' };

export type NamedOpenLoopRemindTiming =
  | 'tonight'
  | 'today_morning'
  | 'today_afternoon'
  | 'tomorrow'
  | 'tomorrow_morning'
  | 'tomorrow_afternoon'
  | 'tomorrow_evening';

export type NamedOpenLoopRemindFollowup =
  | { kind: 'none' }
  | { kind: 'denied'; reason: 'untrusted_named' }
  | {
      kind: 'remind';
      query: string;
      timing: NamedOpenLoopRemindTiming;
      source: 'later' | 'timed';
    };

export const GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE =
  'I did not crawl unnamed inbox threads.';
export const GENERIC_OPEN_LOOP_NAMED_HANDOFF =
  "Next: name one person — for example, `what's still open with Bob?`";
export const NAMED_OPEN_LOOP_DRAFT_YES_NOTICE = 'Yes will not send.';
export const NAMED_OPEN_LOOP_REMIND_LATER_PROMPT = 'remind me later';

const NAMED_OPEN_LOOP_SOFT_YES_RE = /^(?:yes|ok|okay|yeah|yep|yup)[.!]?$/i;
const NAMED_OPEN_LOOP_REMIND_RE =
  /^(?:remind me(?: to (?:reply|answer))?(?: later)?(?: (tonight|tomorrow(?: (?:morning|afternoon|evening))?|today(?: (?:morning|afternoon|evening))?))?|remind me about (?:that|this|it)(?: later)?(?: (tonight|tomorrow(?: (?:morning|afternoon|evening))?))?)[.!]?$/i;

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

export function readNamedOpenLoopSeedQuery(
  seedJson?: string | null,
): string | null {
  if (!seedJson?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(seedJson) as { query?: unknown };
    const query = typeof parsed.query === 'string' ? parsed.query.trim() : '';
    return query || null;
  } catch {
    return null;
  }
}

/**
 * Bind a who-do-I-owe ask to one named thread, or keep it generic.
 * Leftover person/thread titles are not inputs here; only an explicit name
 * or a prior named-thread seed can ground Messages. Known-untrusted callers
 * (Karen / QA) get a deny instead of companion-thread theater.
 */
export function resolveNamedOpenLoopBinding(input: {
  text?: string | null;
  canonicalText?: string | null;
  targetChatName?: string | null;
  ownerReviewAllowed?: boolean;
  priorNamedSeedJson?: string | null;
}): NamedOpenLoopBinding {
  const namedIntent = parseNamedOpenLoopIntent(
    input.text || input.canonicalText || '',
  );
  const explicitQuery =
    normalizeText(input.targetChatName) ||
    normalizeText(namedIntent?.arguments.targetChatName);
  const seedQuery = readNamedOpenLoopSeedQuery(input.priorNamedSeedJson);
  const query = explicitQuery || seedQuery;
  if (!query) {
    return { kind: 'generic' };
  }
  if (input.ownerReviewAllowed === false) {
    return { kind: 'denied', reason: 'untrusted_named' };
  }
  if (input.ownerReviewAllowed !== true) {
    return { kind: 'generic' };
  }
  return {
    kind: 'named',
    query,
    source: explicitQuery ? 'explicit' : 'seed',
  };
}

export function namedOpenLoopHistoryQuery(
  binding: NamedOpenLoopBinding | null | undefined,
): string | null {
  return binding?.kind === 'named' ? binding.query : null;
}

export function formatNamedOpenLoopDeniedReply(): string {
  return 'I can only check what is still open from your registered owner control chat. I did not read any Messages bodies or create a draft or send controls.';
}

export function isNamedOpenLoopSoftYes(
  value: string | null | undefined,
): boolean {
  return NAMED_OPEN_LOOP_SOFT_YES_RE.test(normalizeText(value));
}

export function namedOpenLoopDraftWasOffered(params: {
  gist: ThreadGroundedSummaryGist;
  latestInboundText: string;
  isGroup: boolean;
}): boolean {
  return (
    Boolean(params.gist.ownerOwesReply) &&
    !params.isGroup &&
    !shouldWithholdThreadGroundedReply(params.latestInboundText)
  );
}

export function namedOpenLoopRemindWasOffered(params: {
  gist: ThreadGroundedSummaryGist;
  isGroup: boolean;
}): boolean {
  return Boolean(params.gist.ownerOwesReply) && !params.isGroup;
}

export function parseNamedOpenLoopRemindTiming(
  value: string | null | undefined,
): NamedOpenLoopRemindTiming | null {
  const text = normalizeText(value);
  const match = text.match(NAMED_OPEN_LOOP_REMIND_RE);
  if (!match) {
    return null;
  }
  const when = normalizeText(match[1] || match[2]).toLowerCase();
  if (when === 'today morning') return 'today_morning';
  if (when === 'today afternoon') return 'today_afternoon';
  if (when === 'tomorrow') return 'tomorrow';
  if (when === 'tomorrow morning') return 'tomorrow_morning';
  if (when === 'tomorrow afternoon') return 'tomorrow_afternoon';
  if (when === 'tomorrow evening') return 'tomorrow_evening';
  return 'tonight';
}

export function namedOpenLoopRemindTimingCandidates(
  timing: NamedOpenLoopRemindTiming,
): string[] {
  switch (timing) {
    case 'today_morning':
      return ['today morning', 'tomorrow morning'];
    case 'today_afternoon':
      return ['today afternoon', 'tonight', 'tomorrow afternoon'];
    case 'tomorrow':
      return ['tomorrow evening', 'tomorrow morning'];
    case 'tomorrow_morning':
      return ['tomorrow morning'];
    case 'tomorrow_afternoon':
      return ['tomorrow afternoon'];
    case 'tomorrow_evening':
      return ['tomorrow evening'];
    case 'tonight':
    default:
      return ['tonight', 'today evening', 'tomorrow evening'];
  }
}

/**
 * After a named owed-reply, `draft Bob` or a soft yes creates an unsent
 * draft. Soft yes never sends, never binds leftover person titles, and
 * never crawls an unnamed inbox.
 */
export function resolveNamedOpenLoopDraftFollowup(input: {
  text?: string | null;
  ownerReviewAllowed?: boolean;
  priorNamedSeedJson?: string | null;
  draftOffered?: boolean;
  activeCapabilityId?: string | null;
}): NamedOpenLoopDraftFollowup {
  const namedCommand = parseNamedDraftIntent(input.text || '');
  const commandQuery = normalizeText(namedCommand?.arguments.targetChatName);
  const softYes = !namedCommand && isNamedOpenLoopSoftYes(input.text);
  const seedQuery = readNamedOpenLoopSeedQuery(input.priorNamedSeedJson);

  if (input.ownerReviewAllowed === false) {
    if (commandQuery || (softYes && seedQuery)) {
      return { kind: 'denied', reason: 'untrusted_named' };
    }
    return { kind: 'none' };
  }

  if (softYes) {
    const active = input.activeCapabilityId || '';
    if (
      active !== 'communication.open_loops' &&
      active !== 'communication.summarize_thread'
    ) {
      return { kind: 'none' };
    }
    if (!seedQuery || input.draftOffered !== true) {
      return { kind: 'none' };
    }
    return { kind: 'draft', query: seedQuery, source: 'soft_yes' };
  }

  if (!commandQuery) {
    return { kind: 'none' };
  }
  return {
    kind: 'draft',
    query: commandQuery,
    source: 'named_command',
  };
}

/**
 * After a named owed-reply, `remind me later` / `remind me to reply later
 * tonight` creates a local Jeff reminder. It never sends and never binds
 * leftover person titles from an unnamed inbox.
 */
export function resolveNamedOpenLoopRemindFollowup(input: {
  text?: string | null;
  ownerReviewAllowed?: boolean;
  priorNamedSeedJson?: string | null;
  remindOffered?: boolean;
  activeCapabilityId?: string | null;
}): NamedOpenLoopRemindFollowup {
  const timing = parseNamedOpenLoopRemindTiming(input.text);
  const seedQuery = readNamedOpenLoopSeedQuery(input.priorNamedSeedJson);
  if (!timing) {
    return { kind: 'none' };
  }

  if (input.ownerReviewAllowed === false) {
    if (seedQuery) {
      return { kind: 'denied', reason: 'untrusted_named' };
    }
    return { kind: 'none' };
  }

  const active = input.activeCapabilityId || '';
  if (
    active !== 'communication.open_loops' &&
    active !== 'communication.summarize_thread'
  ) {
    return { kind: 'none' };
  }
  if (!seedQuery || input.remindOffered !== true) {
    return { kind: 'none' };
  }
  return {
    kind: 'remind',
    query: seedQuery,
    timing,
    source: timing === 'tonight' ? 'later' : 'timed',
  };
}

export function formatNamedOpenLoopDraftNextStep(params: {
  channel: NamedOpenLoopChannel;
  personLabel: string;
  withheld: boolean;
  ownerOwesReply: boolean;
  isGroup: boolean;
}): string | undefined {
  if (!params.ownerOwesReply) {
    return undefined;
  }
  if (params.withheld) {
    if (params.isGroup) {
      return "I won't guess your answer. Tell me what you want to say, and I can draft it unsent.";
    }
    if (params.channel === 'alexa') {
      return `I won't guess your answer. Tell me what you want to say, and I can draft it unsent. Or say ${NAMED_OPEN_LOOP_REMIND_LATER_PROMPT}.`;
    }
    return `I won't guess your answer. Tell me what you want to say, and I can draft it unsent. Or say \`${NAMED_OPEN_LOOP_REMIND_LATER_PROMPT}\` for a tonight reminder.`;
  }
  if (params.isGroup) {
    return 'I can draft wording, but I will not create send controls for a group.';
  }
  if (params.channel === 'alexa') {
    return `Say draft ${params.personLabel} to create an unsent draft, or ${NAMED_OPEN_LOOP_REMIND_LATER_PROMPT}. ${NAMED_OPEN_LOOP_DRAFT_YES_NOTICE}`;
  }
  return `Next: say \`draft ${params.personLabel}\` or yes for an unsent draft, or \`${NAMED_OPEN_LOOP_REMIND_LATER_PROMPT}\` for a tonight reminder. That draft stays unsent and requires approval. ${NAMED_OPEN_LOOP_DRAFT_YES_NOTICE}`;
}

export function appendNamedOpenLoopDraftCreatedNotice(
  channel: NamedOpenLoopChannel,
  replyText: string,
  personLabel: string,
): string {
  if (channel === 'alexa') {
    return `${replyText} This draft for ${personLabel} stays unsent. ${NAMED_OPEN_LOOP_DRAFT_YES_NOTICE}`;
  }
  return `${replyText}\n\nNext: this draft for ${personLabel} stays unsent. Review it first. Only \`send it\`, \`send it now\`, or \`send now\` can send. Yes still will not send.`;
}

export function appendNamedOpenLoopRemindCreatedNotice(
  channel: NamedOpenLoopChannel,
  replyText: string,
  personLabel: string,
): string {
  if (channel === 'alexa') {
    return `${replyText} I did not send anything. Say draft ${personLabel} when you want an unsent draft.`;
  }
  return `${replyText}\n\nI did not send anything. Next: say \`draft ${personLabel}\` when you want an unsent draft. Only \`send it\`, \`send it now\`, or \`send now\` can send.`;
}

export function appendGenericOpenLoopNoCrawlNotice(
  channel: NamedOpenLoopChannel,
  replyText: string,
  offerNamedHandoff = false,
): string {
  const handoff = offerNamedHandoff
    ? channel === 'alexa'
      ? " Name one person and ask what's still open with them."
      : `\n${GENERIC_OPEN_LOOP_NAMED_HANDOFF}`
    : '';
  if (channel === 'alexa') {
    return `${replyText} ${GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE}${handoff}`;
  }
  return `${replyText}\n\n${GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE}${handoff}`;
}

export function formatNamedMessagesOpenLoopReply(params: {
  channel: NamedOpenLoopChannel;
  personLabel: string;
  isGroup: boolean;
  gist: ThreadGroundedSummaryGist;
  latestInboundText: string;
}): string {
  const digest = params.gist.digestSentences.join(' ');
  const withheld = shouldWithholdThreadGroundedReply(params.latestInboundText);
  const lead = params.gist.ownerOwesReply
    ? params.isGroup
      ? `${params.personLabel} still has an open turn in that group.`
      : `You owe ${params.personLabel} a reply.`
    : `Nothing open with ${params.personLabel}.`;
  const nextStep = formatNamedOpenLoopDraftNextStep({
    channel: params.channel,
    personLabel: params.personLabel,
    withheld,
    ownerOwesReply: params.gist.ownerOwesReply,
    isGroup: params.isGroup,
  });
  const coverage =
    'This is the current thread state from the available local synced snapshot, not device unread status. I did not send anything.';
  if (params.channel === 'alexa') {
    return [lead, digest, nextStep].filter(Boolean).join(' ');
  }
  if (params.channel === 'bluebubbles') {
    return [lead, digest, nextStep, coverage].filter(Boolean).join('\n');
  }
  return [lead, '', digest, nextStep ? '' : null, nextStep, '', coverage]
    .filter((line) => line !== null)
    .join('\n');
}
