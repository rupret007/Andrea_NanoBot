import {
  buildMessageActionPresentation,
  createOrRefreshMessageActionFromDraft,
  parseExplicitBlueBubblesThreadSendIntent,
  resolveBlueBubblesThreadTargetByName,
  type MessageActionPresentation,
  type ResolvedBlueBubblesThreadTarget,
} from './message-actions.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import type { MessageActionRecord, RegisteredGroup } from './types.js';

type OutboundRequestChannel = 'telegram' | 'bluebubbles';

export type BlueBubblesOutboundRequestResult =
  | { handled: false }
  | {
      handled: true;
      state:
        | 'restricted'
        | 'missing_target'
        | 'ambiguous_target'
        | 'unsupported_target';
      replyText: string;
    }
  | {
      handled: true;
      state: 'staged';
      action: MessageActionRecord;
      presentation: MessageActionPresentation;
    };

export interface StageBlueBubblesOutboundRequestParams {
  groupFolder: string;
  channel: OutboundRequestChannel;
  chatJid: string;
  group: RegisteredGroup;
  rawText: string;
  inboundMessageId?: string | null;
  recipientResolution?:
    | { state: 'resolved'; target: ResolvedBlueBubblesThreadTarget }
    | { state: 'ambiguous'; matches: ResolvedBlueBubblesThreadTarget[] }
    | { state: 'missing' };
  now?: Date;
}

function buildSourceKey(params: {
  channel: OutboundRequestChannel;
  chatJid: string;
  inboundMessageId?: string | null;
  targetChatJid: string;
  draftText: string;
}): string {
  const inboundIdentity = params.inboundMessageId?.trim();
  if (inboundIdentity) {
    return `outbound-message:${params.channel}:${params.chatJid}:${inboundIdentity}`;
  }
  return `outbound-message:${params.channel}:${params.chatJid}:${params.targetChatJid}:${params.draftText
    .trim()
    .toLowerCase()
    .slice(0, 120)}`;
}

/**
 * Turns an explicit owner request into an approval-bound BlueBubbles draft.
 * This function never sends. The exact target and body are persisted together
 * so a later action-card approval cannot drift to another recipient or draft.
 */
export function stageBlueBubblesOutboundRequest(
  params: StageBlueBubblesOutboundRequestParams,
): BlueBubblesOutboundRequestResult {
  const intent = parseExplicitBlueBubblesThreadSendIntent(params.rawText);
  if (!intent) return { handled: false };

  if (
    !isTrustedOwnerReviewSurface({
      channelName: params.channel,
      chatJid: params.chatJid,
      group: params.group,
    })
  ) {
    return {
      handled: true,
      state: 'restricted',
      replyText:
        'Andrea: Sending a Messages text is private to your registered main Telegram chat or configured Messages self-thread. I did not create or send anything here.',
    };
  }

  const resolution =
    params.recipientResolution ||
    resolveBlueBubblesThreadTargetByName(intent.targetLabel);
  if (resolution.state === 'missing') {
    return {
      handled: true,
      state: 'missing_target',
      replyText: `Andrea: I could not match "${intent.targetLabel}" to an existing Messages conversation or exact BlueBubbles/macOS contact.\n\nUse the exact contact/conversation name or a phone/email address, like \`text Rad Dad: Dinner is ready.\` or \`text +1 202 555 0123: Dinner is ready.\` I did not create or send anything.`,
    };
  }
  if (resolution.state === 'ambiguous') {
    const options = resolution.matches
      .map((match) => match.displayName)
      .join(', ');
    return {
      handled: true,
      state: 'ambiguous_target',
      replyText: `Andrea: I found more than one Messages recipient that could be "${intent.targetLabel}".\n\nRepeat the request with one exact name, phone number, or email from: ${options}. I did not create or send anything.`,
    };
  }

  const target = resolution.target;
  if (target.isGroup) {
    return {
      handled: true,
      state: 'unsupported_target',
      replyText: `Andrea: "${target.displayName}" is a group conversation. Telegram-to-Messages sending is limited to an existing one-to-one conversation, so I did not create or send anything.`,
    };
  }
  const action = createOrRefreshMessageActionFromDraft({
    groupFolder: params.groupFolder,
    presentationChannel: params.channel,
    presentationChatJid: params.chatJid,
    sourceType: 'manual_prompt',
    sourceKey: buildSourceKey({
      channel: params.channel,
      chatJid: params.chatJid,
      inboundMessageId: params.inboundMessageId,
      targetChatJid: target.chatJid,
      draftText: intent.draftText,
    }),
    sourceSummary: `Draft text message to ${target.displayName}.`,
    draftText: intent.draftText,
    personName: target.displayName,
    threadTitle: target.displayName,
    communicationContext: 'general',
    // An explicit request prepares the message; it is not the separate fresh
    // approval that authorizes delivery, even when a delegation rule exists.
    forceApproval: true,
    targetOverride: {
      kind: 'external_thread',
      chatJid: target.chatJid,
      threadId: null,
      replyToMessageId: null,
      isGroup: target.isGroup,
      personName: target.displayName,
      ...(target.blueBubblesCreateChatAddress
        ? {
            blueBubblesCreateChatAddress: target.blueBubblesCreateChatAddress,
          }
        : {}),
    },
    targetChannelOverride: 'bluebubbles',
    now: params.now,
  });

  return {
    handled: true,
    state: 'staged',
    action,
    presentation: buildMessageActionPresentation(action, params.channel),
  };
}
