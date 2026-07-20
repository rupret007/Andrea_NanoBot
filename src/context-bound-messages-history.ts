import type { ResolvedBlueBubblesThreadTarget } from './message-actions.js';

export type ContextBoundRecipientResolution =
  | { state: 'resolved'; target: ResolvedBlueBubblesThreadTarget }
  | { state: 'ambiguous'; matches: ResolvedBlueBubblesThreadTarget[] }
  | { state: 'missing' };

export interface ContextBoundInboundMessage {
  id?: string;
  content: string;
  timestamp?: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export type RefreshedContextBoundRecipientResult =
  | {
      state: 'resolved';
      recipientResolution: Extract<
        ContextBoundRecipientResolution,
        { state: 'resolved' }
      >;
      latestInbound: ContextBoundInboundMessage;
    }
  | {
      state: 'context_stale';
      target: ResolvedBlueBubblesThreadTarget;
      latestInbound: ContextBoundInboundMessage;
    }
  | { state: 'missing' }
  | {
      state: 'ambiguous';
      matches: ResolvedBlueBubblesThreadTarget[];
    }
  | { state: 'global_refresh_failed'; error: unknown }
  | {
      state: 'targeted_refresh_failed';
      target: ResolvedBlueBubblesThreadTarget;
      error: unknown;
    }
  | {
      state: 'no_latest_inbound';
      target: ResolvedBlueBubblesThreadTarget;
    };

function isIndirectPickupReply(content: string | null | undefined): boolean {
  return /\bif\s+(?:she|he|they)\s+could\s+pick\s+(?:them|it)\s+up\b/i.test(
    content || '',
  );
}

function normalizeContextText(content: string | null | undefined): string {
  return (content || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inboundMessagesHaveSameIdentity(
  before: ContextBoundInboundMessage,
  after: ContextBoundInboundMessage,
): boolean {
  if (before.id && after.id) {
    return (
      before.id === after.id &&
      normalizeContextText(before.content) ===
        normalizeContextText(after.content)
    );
  }
  if (before.timestamp && after.timestamp) {
    return (
      before.timestamp === after.timestamp &&
      normalizeContextText(before.content) ===
        normalizeContextText(after.content)
    );
  }
  return (
    normalizeContextText(before.content) === normalizeContextText(after.content)
  );
}

function isThreadClosure(content: string | null | undefined): boolean {
  return /\b(?:never\s*mind|no\s+need|all\s+set|disregard|ignore\s+(?:that|this|it)|already\s+(?:handled|done|fixed|sorted|took\s+care\s+of)|(?:it|that)['’]?s\s+(?:handled|done|fixed|sorted)|cancel(?:led|ed)?(?:\s+it)?)\b/i.test(
    content || '',
  );
}

function isClosureAcknowledgement(content: string | null | undefined): boolean {
  return /^(?:ok(?:ay)?|got\s+it|understood|sounds\s+good|no\s+problem|thanks|thank\s+you|glad\s+(?:you|it)|perfect)\b/i.test(
    normalizeContextText(content),
  );
}

function latestInboundStillMatchesReply(params: {
  replyContent: string | null | undefined;
  latestInboundContent: string | null | undefined;
}): boolean {
  if (
    isThreadClosure(params.latestInboundContent) &&
    !isClosureAcknowledgement(params.replyContent)
  ) {
    return false;
  }
  if (!isIndirectPickupReply(params.replyContent)) return true;
  return /\bpick\b[\s\S]{0,80}\bup\b/i.test(params.latestInboundContent || '');
}

/**
 * Resolves one named Messages thread and refreshes that exact thread before
 * consulting its latest inbound message. The broad recent-history slice is
 * used only to discover metadata for a locally unknown recipient; it is never
 * treated as current conversation context for an already-known quiet thread.
 */
export async function resolveRefreshedContextBoundRecipient(params: {
  targetLabel: string;
  replyContent: string | null | undefined;
  resolveRecipient: (label: string) => ContextBoundRecipientResolution;
  primeRecentHistory: () => Promise<unknown>;
  primeChatHistory: (chatJid: string) => Promise<unknown>;
  listRecentMessagesForChat: (
    chatJid: string,
    limit: number,
  ) => ContextBoundInboundMessage[];
}): Promise<RefreshedContextBoundRecipientResult> {
  let resolution = params.resolveRecipient(params.targetLabel);
  if (resolution.state === 'missing') {
    try {
      await params.primeRecentHistory();
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (error) {
      return { state: 'global_refresh_failed', error };
    }
    resolution = params.resolveRecipient(params.targetLabel);
  }

  if (resolution.state === 'missing') return resolution;
  if (resolution.state === 'ambiguous') return resolution;

  // Capture the exact locally observed inbound turn before asking the provider
  // for current history. A contextual instruction is bound to that turn; if a
  // newer inbound arrives during the refresh, the instruction must not slide
  // forward to the new conversation state.
  const baselineInbound = params
    .listRecentMessagesForChat(resolution.target.chatJid, 40)
    .find((message) => !message.is_from_me && !message.is_bot_message);
  if (!baselineInbound) {
    return { state: 'no_latest_inbound', target: resolution.target };
  }

  try {
    await params.primeChatHistory(resolution.target.chatJid);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    return {
      state: 'targeted_refresh_failed',
      target: resolution.target,
      error,
    };
  }

  const latestInbound = params
    .listRecentMessagesForChat(resolution.target.chatJid, 40)
    .find((message) => !message.is_from_me && !message.is_bot_message);
  if (!latestInbound) {
    return { state: 'no_latest_inbound', target: resolution.target };
  }
  if (
    !inboundMessagesHaveSameIdentity(baselineInbound, latestInbound) ||
    !latestInboundStillMatchesReply({
      replyContent: params.replyContent,
      latestInboundContent: latestInbound.content,
    })
  ) {
    return {
      state: 'context_stale',
      target: resolution.target,
      latestInbound,
    };
  }
  return {
    state: 'resolved',
    recipientResolution: resolution,
    latestInbound,
  };
}
