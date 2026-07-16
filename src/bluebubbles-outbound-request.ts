import {
  buildMessageActionPresentation,
  createOrRefreshMessageActionFromDraft,
  executeExplicitlyAuthorizedMessageAction,
  resolveBlueBubblesThreadTargetByName,
  type MessageActionExecutionDeps,
  type MessageActionPresentation,
  type ResolvedBlueBubblesThreadTarget,
} from './message-actions.js';
import { getMessageActionBySource } from './db.js';
import {
  composeAssistantMessageContent,
  parseAssistantMessageActionIntent,
} from './assistant-action-intent.js';
import {
  formatRuntimeCapabilityEvaluation,
  formatRuntimeCapabilityOutcome,
  runtimeCapabilityRegistry,
  type RuntimeCapabilityFacts,
  type RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';
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

export type ExecuteBlueBubblesOutboundRequestResult =
  | BlueBubblesOutboundRequestResult
  | {
      handled: true;
      state:
        | 'unavailable_capability'
        | 'unhealthy_provider'
        | 'missing_permission'
        | 'confirmation_required';
      replyText: string;
    }
  | {
      handled: true;
      state: 'sent' | 'delivery_unverified' | 'execution_failure';
      action: MessageActionRecord;
      replyText: string;
    };

export interface StageBlueBubblesOutboundRequestParams {
  groupFolder: string;
  channel: OutboundRequestChannel;
  chatJid: string;
  group: RegisteredGroup;
  /** Exact authorship fact from the inbound message that opened this turn. */
  readonly ownerAuthored?: boolean | null;
  rawText: string;
  inboundMessageId?: string | null;
  recipientResolution?:
    | { state: 'resolved'; target: ResolvedBlueBubblesThreadTarget }
    | { state: 'ambiguous'; matches: ResolvedBlueBubblesThreadTarget[] }
    | { state: 'missing' };
  now?: Date;
}

export interface ExecuteBlueBubblesOutboundRequestParams extends StageBlueBubblesOutboundRequestParams {
  capabilityFacts: RuntimeCapabilityFacts;
  executionDeps: MessageActionExecutionDeps;
  capabilityRegistry?: RuntimeCapabilityRegistry;
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
    return `outbound-message:${params.channel}:${params.chatJid}:inbound:${inboundIdentity}`;
  }
  return `outbound-message:${params.channel}:${params.chatJid}:${params.targetChatJid}:${params.draftText
    .trim()
    .toLowerCase()
    .slice(0, 120)}`;
}

function buildLegacyInboundSourceKey(params: {
  channel: OutboundRequestChannel;
  chatJid: string;
  inboundMessageId: string;
}): string {
  return `outbound-message:${params.channel}:${params.chatJid}:${params.inboundMessageId}`;
}

/**
 * Reads a terminal outcome for a retried inbound platform event. A confirmed,
 * uncertain, or proven-failed prior attempt is historical truth, so replaying
 * that same event must not depend on current provider health or directory
 * availability and must never reopen the side-effect window.
 */
export async function readTerminalBlueBubblesOutboundReplay(
  params: Pick<
    ExecuteBlueBubblesOutboundRequestParams,
    | 'groupFolder'
    | 'channel'
    | 'chatJid'
    | 'group'
    | 'ownerAuthored'
    | 'rawText'
    | 'inboundMessageId'
    | 'executionDeps'
  >,
): Promise<ExecuteBlueBubblesOutboundRequestResult | null> {
  const inboundMessageId = params.inboundMessageId?.trim();
  const intent = parseAssistantMessageActionIntent(params.rawText);
  if (
    !inboundMessageId ||
    intent?.kind !== 'message_send' ||
    intent.mode !== 'execute' ||
    !intent.explicitlyAuthorizesExecution ||
    !isTrustedOwnerReviewSurface({
      channelName: params.channel,
      chatJid: params.chatJid,
      group: params.group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return null;
  }

  const currentSourceKey = buildSourceKey({
    channel: params.channel,
    chatJid: params.chatJid,
    inboundMessageId,
    targetChatJid: '',
    draftText: '',
  });
  const currentAction = getMessageActionBySource(
    params.groupFolder,
    'manual_prompt',
    currentSourceKey,
  );
  if (
    currentAction &&
    !['sent', 'delivery_unverified', 'failed'].includes(
      currentAction.sendStatus,
    )
  ) {
    // Once the post-upgrade identity exists it is authoritative, even if an
    // older row with the legacy key is also present.
    return null;
  }

  const legacyAction = currentAction
    ? null
    : getMessageActionBySource(
        params.groupFolder,
        'manual_prompt',
        buildLegacyInboundSourceKey({
          channel: params.channel,
          chatJid: params.chatJid,
          inboundMessageId,
        }),
      );
  const action = currentAction || legacyAction;
  if (!action) return null;

  if (
    legacyAction &&
    !['sent', 'delivery_unverified', 'failed'].includes(legacyAction.sendStatus)
  ) {
    return {
      handled: true,
      state: 'confirmation_required',
      replyText: `Andrea: I found this pre-upgrade request in the persisted "${legacyAction.sendStatus}" state. I did not send or resume it automatically. Send a fresh instruction or use its existing action control after reviewing the recipient and exact text.`,
    };
  }

  if (legacyAction?.sendStatus === 'failed') {
    return {
      handled: true,
      state: 'execution_failure',
      action: legacyAction,
      replyText:
        'Andrea: That pre-upgrade request previously failed. I did not replay it automatically; send a fresh instruction if you want a new attempt.',
    };
  }

  const replay = await executeExplicitlyAuthorizedMessageAction(
    action.messageActionId,
    params.executionDeps,
  );
  const replayedAction = replay.action || action;
  const state =
    replayedAction.sendStatus === 'sent'
      ? 'sent'
      : replayedAction.sendStatus === 'delivery_unverified'
        ? 'delivery_unverified'
        : 'execution_failure';
  return {
    handled: true,
    state,
    action: replayedAction,
    replyText:
      replay.replyText ||
      formatRuntimeCapabilityOutcome({
        state:
          state === 'delivery_unverified'
            ? 'uncertain_outcome'
            : 'execution_failure',
        capabilityId: intent.capabilityId,
      }),
  };
}

/**
 * Non-executing draft-card builder. The production dispatcher calls this only
 * for `draft`/`prepare` semantics; it remains exported for review workflows and
 * tests that deliberately stage an explicit request. The exact target and body
 * are persisted together so a later approval cannot drift.
 */
export function stageBlueBubblesOutboundRequest(
  params: StageBlueBubblesOutboundRequestParams,
): BlueBubblesOutboundRequestResult {
  const actionIntent = parseAssistantMessageActionIntent(params.rawText);
  if (
    actionIntent?.kind !== 'message_send' ||
    !['execute', 'draft', 'prepare'].includes(actionIntent.mode) ||
    !actionIntent.targetLabel ||
    !actionIntent.content
  ) {
    return { handled: false };
  }
  const draftText = composeAssistantMessageContent(actionIntent);
  if (!draftText) return { handled: false };

  if (
    !isTrustedOwnerReviewSurface({
      channelName: params.channel,
      chatJid: params.chatJid,
      group: params.group,
      ownerAuthored: params.ownerAuthored,
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
    resolveBlueBubblesThreadTargetByName(actionIntent.targetLabel);
  if (resolution.state === 'missing') {
    return {
      handled: true,
      state: 'missing_target',
      replyText: `Andrea: I could not match "${actionIntent.targetLabel}" to an existing Messages conversation or exact BlueBubbles/macOS contact.\n\nUse the exact contact/conversation name or a phone/email address, like \`text Rad Dad: Dinner is ready.\` or \`text +1 202 555 0123: Dinner is ready.\` I did not create or send anything.`,
    };
  }
  if (resolution.state === 'ambiguous') {
    const options = resolution.matches
      .map((match) => match.displayName)
      .join(', ');
    return {
      handled: true,
      state: 'ambiguous_target',
      replyText: `Andrea: I found more than one Messages recipient that could be "${actionIntent.targetLabel}".\n\nRepeat the request with one exact name, phone number, or email from: ${options}. I did not create or send anything.`,
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
      draftText,
    }),
    sourceSummary: `Draft text message to ${target.displayName}.`,
    draftText,
    personName: target.displayName,
    threadTitle: target.displayName,
    communicationContext: 'general',
    // This is the intentionally non-executing API. The execution API below
    // treats a normalized send imperative as explicit approval instead.
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

/**
 * Executes a normalized owner send request through the same capability
 * contract used by planning and outcome wording. Draft/prepare wording stays
 * in the non-executing staging path.
 */
export async function executeBlueBubblesOutboundRequest(
  params: ExecuteBlueBubblesOutboundRequestParams,
): Promise<ExecuteBlueBubblesOutboundRequestResult> {
  const intent = parseAssistantMessageActionIntent(params.rawText);
  if (intent?.kind !== 'message_send') return { handled: false };
  if (intent.mode === 'draft' || intent.mode === 'prepare') {
    return stageBlueBubblesOutboundRequest(params);
  }
  if (
    intent.mode !== 'execute' ||
    !intent.explicitlyAuthorizesExecution ||
    !intent.targetLabel ||
    !intent.content
  ) {
    return { handled: false };
  }

  if (
    !isTrustedOwnerReviewSurface({
      channelName: params.channel,
      chatJid: params.chatJid,
      group: params.group,
      ownerAuthored: params.ownerAuthored,
    })
  ) {
    return {
      handled: true,
      state: 'restricted',
      replyText:
        'Andrea: BlueBubbles execution is private to your registered main Telegram chat or configured Messages self-thread. I did not create or send anything here.',
    };
  }

  const terminalReplay = await readTerminalBlueBubblesOutboundReplay(params);
  if (terminalReplay) return terminalReplay;

  const capability = (
    params.capabilityRegistry ?? runtimeCapabilityRegistry
  ).evaluate(
    {
      capabilityId: intent.capabilityId,
      action: 'send',
      sourceChannel: params.channel,
    },
    params.capabilityFacts,
  );
  if (capability.state !== 'available') {
    return {
      handled: true,
      state: capability.state,
      replyText: `Andrea: ${formatRuntimeCapabilityEvaluation(capability)}`,
    };
  }

  const resolution =
    params.recipientResolution ||
    resolveBlueBubblesThreadTargetByName(intent.targetLabel);
  if (resolution.state === 'missing') {
    return {
      handled: true,
      state: 'missing_target',
      replyText: `Andrea: I could not match "${intent.targetLabel}" to one exact Messages conversation or contact. I did not dispatch anything.`,
    };
  }
  if (resolution.state === 'ambiguous') {
    return {
      handled: true,
      state: 'ambiguous_target',
      replyText: `Andrea: ${formatRuntimeCapabilityOutcome({
        state: 'ambiguous_entity',
        capabilityId: intent.capabilityId,
        entity: `the Messages recipient "${intent.targetLabel}"`,
        candidates: resolution.matches.map((match) => match.displayName),
      })}`,
    };
  }
  if (resolution.target.isGroup) {
    return {
      handled: true,
      state: 'unsupported_target',
      replyText: `Andrea: "${resolution.target.displayName}" is a group conversation, not the exact one-to-one recipient required by this request. I did not dispatch anything.`,
    };
  }

  const draftText = composeAssistantMessageContent(intent);
  if (!draftText) {
    return {
      handled: true,
      state: 'execution_failure',
      action: createOrRefreshMessageActionFromDraft({
        groupFolder: params.groupFolder,
        presentationChannel: params.channel,
        presentationChatJid: params.chatJid,
        sourceType: 'manual_prompt',
        sourceKey: buildSourceKey({
          channel: params.channel,
          chatJid: params.chatJid,
          inboundMessageId: params.inboundMessageId,
          targetChatJid: resolution.target.chatJid,
          draftText: intent.content,
        }),
        draftText: intent.content,
        forceApproval: true,
        targetOverride: {
          kind: 'external_thread',
          chatJid: resolution.target.chatJid,
          isGroup: false,
          personName: resolution.target.displayName,
        },
        targetChannelOverride: 'bluebubbles',
        now: params.now,
      }),
      replyText:
        'Andrea: I could not produce a non-empty message body, so I did not dispatch anything.',
    };
  }

  const target = resolution.target;
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
      draftText,
    }),
    sourceSummary: `Explicitly authorized message to ${target.displayName}.`,
    draftText,
    personName: target.displayName,
    threadTitle: target.displayName,
    communicationContext: 'general',
    explicitApproval: true,
    targetOverride: {
      kind: 'external_thread',
      chatJid: target.chatJid,
      threadId: null,
      replyToMessageId: null,
      isGroup: false,
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
  const executed = await executeExplicitlyAuthorizedMessageAction(
    action.messageActionId,
    params.executionDeps,
  );
  const executedAction = executed.action || action;
  const state =
    executedAction.sendStatus === 'sent'
      ? 'sent'
      : executedAction.sendStatus === 'delivery_unverified'
        ? 'delivery_unverified'
        : 'execution_failure';
  return {
    handled: true,
    state,
    action: executedAction,
    replyText:
      executed.replyText ||
      formatRuntimeCapabilityOutcome({
        state:
          state === 'delivery_unverified'
            ? 'uncertain_outcome'
            : 'execution_failure',
        capabilityId: intent.capabilityId,
      }),
  };
}
