/**
 * Named who-do-I-owe / draft-for-Bob-yes policy and Jeff-facing copy.
 * These helpers stay local and unsent so hosted tests can prove the leftover
 * without live Messages send, credentials, or BlueBubbles send HTTP.
 */

import { parseNamedOpenLoopIntent } from './thread-summary-routing.js';
import {
  shouldWithholdThreadGroundedReply,
  type ThreadGroundedSummaryGist,
} from './thread-grounded-wording.js';

export type NamedOpenLoopChannel = 'alexa' | 'telegram' | 'bluebubbles';

export type NamedOpenLoopBinding =
  | { kind: 'denied'; reason: 'untrusted_named' }
  | { kind: 'generic' }
  | { kind: 'named'; query: string; source: 'explicit' | 'seed' };

export const GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE =
  'I did not crawl unnamed inbox threads.';

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

export function appendGenericOpenLoopNoCrawlNotice(
  channel: NamedOpenLoopChannel,
  replyText: string,
): string {
  if (channel === 'alexa') {
    return `${replyText} ${GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE}`;
  }
  return `${replyText}\n\n${GENERIC_OPEN_LOOP_NO_CRAWL_NOTICE}`;
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
  const nextStep = params.gist.ownerOwesReply
    ? withheld
      ? "I won't guess your answer. Tell me what you want to say, and I can draft it unsent."
      : params.isGroup
        ? 'I can draft wording, but I will not create send controls for a group.'
        : `I can draft a reply with \`draft ${params.personLabel}\`. That draft stays unsent and requires approval. Saying yes or ok will not send.`
    : undefined;
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
