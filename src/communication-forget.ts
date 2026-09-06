import {
  communicationThreadFingerprint,
  deleteReviewedCommunicationThread,
  getCommunicationThread,
} from './db.js';

type Channel = 'telegram' | 'bluebubbles' | 'alexa';

interface ReviewSurface {
  ownerReviewAllowed?: boolean;
  groupFolder: string;
  channel: Channel;
  chatJid?: string;
  now?: Date;
}

interface ForgetReview {
  version: 1;
  purpose: 'forget_communication_tracking';
  groupFolder: string;
  threadId: string;
  targetChannel: string;
  targetChatJid: string;
  presentationChannel: Channel;
  presentationChatJid: string;
  reviewedAt: string;
  threadFingerprint: string;
}

const REVIEW_TTL_MS = 10 * 60 * 1000;
const REVIEW_AGAIN =
  'Nothing was deleted. Review one conversation again in your owner control chat, then say "forget this conversation thread completely" on its own. A missing, changed, expired, or multi-conversation review cannot authorize removal.';

// Inspect raw input: normalization must not turn a quote, question, or compound
// request into authorization. Matching mentions also keeps them out of analysis.
export function mentionsCompleteCommunicationForget(text: string): boolean {
  return /\bforget\s+this\s+conversation\s+thread\s+completely\b/i.test(text);
}

export function buildCommunicationForgetReview(
  input: ReviewSurface & { threadId?: string },
): string | undefined {
  if (
    input.ownerReviewAllowed !== true ||
    !input.groupFolder ||
    !input.chatJid?.trim() ||
    !input.threadId
  )
    return undefined;
  const now = input.now || new Date();
  if (!Number.isFinite(now.getTime())) return undefined;
  const thread = getCommunicationThread(input.threadId);
  if (
    !thread ||
    thread.groupFolder !== input.groupFolder ||
    !thread.channel ||
    !thread.channelChatJid?.trim()
  )
    return undefined;
  const review: ForgetReview = {
    version: 1,
    purpose: 'forget_communication_tracking',
    groupFolder: input.groupFolder,
    threadId: thread.id,
    targetChannel: thread.channel,
    targetChatJid: thread.channelChatJid,
    presentationChannel: input.channel,
    presentationChatJid: input.chatJid,
    reviewedAt: now.toISOString(),
    threadFingerprint: communicationThreadFingerprint(thread),
  };
  return JSON.stringify(review);
}

export function forgetReviewedCommunication(
  input: ReviewSurface & {
    text: string;
    threadId?: string;
    reviewJson?: string;
  },
): { ok: boolean; replyText: string } {
  if (
    !/^\s*forget\s+this\s+conversation\s+thread\s+completely[.!]?\s*$/i.test(
      input.text,
    )
  ) {
    return {
      ok: false,
      replyText:
        'Nothing was changed. Complete-forget must be a standalone command, not a quote, question, negation, or combined request.',
    };
  }
  if (input.ownerReviewAllowed !== true) {
    return {
      ok: false,
      replyText:
        'Nothing was deleted. Only your registered owner control chat can remove local conversation tracking.',
    };
  }
  if (
    !input.reviewJson ||
    input.reviewJson.length > 4096 ||
    !input.threadId ||
    !input.chatJid?.trim()
  ) {
    return { ok: false, replyText: REVIEW_AGAIN };
  }
  let review: ForgetReview;
  try {
    review = JSON.parse(input.reviewJson) as ForgetReview;
  } catch {
    return { ok: false, replyText: REVIEW_AGAIN };
  }
  const now = input.now || new Date();
  const reviewedAt =
    typeof review?.reviewedAt === 'string'
      ? Date.parse(review.reviewedAt)
      : NaN;
  if (
    !review ||
    review.version !== 1 ||
    review.purpose !== 'forget_communication_tracking' ||
    review.groupFolder !== input.groupFolder ||
    review.threadId !== input.threadId ||
    review.presentationChannel !== input.channel ||
    review.presentationChatJid !== input.chatJid ||
    typeof review.threadFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(review.threadFingerprint) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isFinite(reviewedAt) ||
    reviewedAt > now.getTime() ||
    now.getTime() - reviewedAt > REVIEW_TTL_MS
  )
    return { ok: false, replyText: REVIEW_AGAIN };

  const thread = getCommunicationThread(input.threadId);
  if (
    !thread ||
    thread.groupFolder !== input.groupFolder ||
    !thread.channelChatJid?.trim() ||
    thread.channel !== review.targetChannel ||
    thread.channelChatJid !== review.targetChatJid
  )
    return { ok: false, replyText: REVIEW_AGAIN };
  try {
    if (
      !deleteReviewedCommunicationThread({
        groupFolder: input.groupFolder,
        threadId: input.threadId,
        expectedFingerprint: review.threadFingerprint,
      })
    )
      return { ok: false, replyText: REVIEW_AGAIN };
  } catch {
    return {
      ok: false,
      replyText:
        'Nothing was deleted. I could not safely remove this local tracking record and its derived history together. The records were kept intact.',
    };
  }
  return {
    ok: true,
    replyText:
      'Removed this local tracking record and its tracking history, including its derived review summary. Original messages, saved profiles and life threads, reminders, and drafts remain. This is not inbox deletion or permanent suppression: explicitly reviewing the original conversation again can create new tracking.',
  };
}
