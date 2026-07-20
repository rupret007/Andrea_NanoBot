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
  formatRuntimeCapabilityOutcome,
  type RuntimeCapabilityFacts,
  type RuntimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import { isTrustedOwnerReviewSurface } from './trusted-owner-review-surface.js';
import type {
  MessageActionRecentTextReviewLink,
  MessageActionRecord,
  RegisteredGroup,
} from './types.js';

type OutboundRequestChannel = 'telegram' | 'bluebubbles';

export type BlueBubblesOutboundRequestResult =
  | { handled: false }
  | {
      handled: true;
      state:
        | 'restricted'
        | 'context_unavailable'
        | 'context_stale'
        | 'context_mismatch'
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
        | 'capability_status'
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
  /** Inert provenance for exact recent-review lifecycle bookkeeping. */
  recentTextReview?: MessageActionRecentTextReviewLink | null;
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

function normalizeRecipientReplyLabel(
  value: string | null | undefined,
): string {
  const normalized = (value || '')
    .normalize('NFKC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157).trimEnd()}...`;
}

function quoteRecipientReplyLabel(value: string | null | undefined): string {
  const normalized = normalizeRecipientReplyLabel(value) || 'that recipient';
  return `"${normalized.replace(/"/g, "'")}"`;
}

function normalizeExactRecipientAddress(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 254) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (!/^\+?[\d\s().-]+$/.test(normalized)) return null;
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return normalized;
}

function directRecipientAddress(
  target: ResolvedBlueBubblesThreadTarget,
): string | null {
  const explicitAddress = normalizeExactRecipientAddress(
    target.blueBubblesCreateChatAddress,
  );
  if (explicitAddress) return explicitAddress;
  const chatGuid = target.chatJid.replace(/^bb:/i, '');
  return normalizeExactRecipientAddress(/^[^;]+;-;(.+)$/.exec(chatGuid)?.[1]);
}

function isInternalBlueBubblesIdentifier(value: string): boolean {
  return /^(?:bb:)?[^;\s]+;[+-];/i.test(value);
}

function buildRecipientRepromptChoices(
  matches: ResolvedBlueBubblesThreadTarget[],
): Array<{ displayLabel: string; exactTarget: string | null }> {
  const displayNames = matches.map((match) =>
    normalizeRecipientReplyLabel(match.displayName),
  );
  const displayNameCounts = new Map<string, number>();
  for (const displayName of displayNames) {
    const key = displayName.toLowerCase();
    if (!key) continue;
    displayNameCounts.set(key, (displayNameCounts.get(key) || 0) + 1);
  }

  return matches.map((match, index) => {
    const displayName = displayNames[index] || '';
    const address = directRecipientAddress(match);
    const displayNameIsUnique =
      Boolean(displayName) &&
      displayNameCounts.get(displayName.toLowerCase()) === 1;
    const displayNameCanBeRetyped =
      displayNameIsUnique &&
      !isInternalBlueBubblesIdentifier(displayName) &&
      !/[\r\n:]/.test(displayName);
    // Live contact candidates carry their exact address because their display
    // label (for example, "Alex at +1 ...") is explanatory, not itself a
    // resolvable contact query. Stored fuzzy matches can safely use a unique
    // full conversation name, minimizing unnecessary address disclosure.
    const exactTarget = match.blueBubblesCreateChatAddress
      ? address
      : displayNameCanBeRetyped
        ? displayName
        : address;
    const safeDisplay =
      displayName && !isInternalBlueBubblesIdentifier(displayName)
        ? displayName
        : exactTarget || `Messages recipient ${index + 1}`;
    return { displayLabel: safeDisplay, exactTarget };
  });
}

function freshRecipientRequestNextStep(params: {
  draftText: string;
  exactTarget?: string | null;
  exampleOnly?: boolean;
}): string {
  const target =
    params.exactTarget || '[exact contact name, phone number, or email]';
  const lead = params.exampleOnly
    ? 'Then repeat the complete request with one exact choice and the same body, for example:'
    : 'Repeat the complete request with an exact recipient, keeping the body unchanged:';
  return `${lead}\nText ${target}: ${params.draftText}\n\nThat fresh request will only stage an unsent recipient-bound card. Review that card, then use a separate fresh \`Send now\` or \`send it\` approval. I did not create or send anything.`;
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
 * Non-executing recipient/body card builder. Fresh `execute`, `draft`, and
 * `prepare` wording all enter this boundary: the exact target and body are
 * persisted together so a later, separate approval cannot drift.
 */
export function stageBlueBubblesOutboundRequest(
  params: StageBlueBubblesOutboundRequestParams,
): BlueBubblesOutboundRequestResult {
  const actionIntent = parseAssistantMessageActionIntent(params.rawText);
  if (
    actionIntent?.kind !== 'message_send' ||
    !['execute', 'draft', 'prepare'].includes(actionIntent.mode) ||
    (!actionIntent.targetLabel &&
      params.recipientResolution?.state !== 'resolved') ||
    !actionIntent.content
  ) {
    return { handled: false };
  }
  const draftText = composeAssistantMessageContent(actionIntent);
  if (!draftText) return { handled: false };
  const draftProvenance =
    draftText === actionIntent.content ? ('owner_literal' as const) : undefined;

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
    resolveBlueBubblesThreadTargetByName(actionIntent.targetLabel!);
  if (resolution.state === 'missing') {
    return {
      handled: true,
      state: 'missing_target',
      replyText: `Andrea: I could not match ${quoteRecipientReplyLabel(actionIntent.targetLabel)} to an existing Messages conversation or exact BlueBubbles/macOS contact.\n\n${freshRecipientRequestNextStep({ draftText })}`,
    };
  }
  if (resolution.state === 'ambiguous') {
    const choices = buildRecipientRepromptChoices(resolution.matches);
    if (choices.length === 0) {
      return {
        handled: true,
        state: 'ambiguous_target',
        replyText: `Andrea: I could not identify a usable Messages recipient for ${quoteRecipientReplyLabel(actionIntent.targetLabel)}, so I did not select one.\n\n${freshRecipientRequestNextStep({ draftText })}`,
      };
    }
    if (choices.length === 1) {
      const choice = choices[0]!;
      const suggestion = choice.exactTarget
        ? `If you mean ${quoteRecipientReplyLabel(choice.displayLabel)}, use this exact recipient:\n\n${freshRecipientRequestNextStep(
            {
              draftText,
              exactTarget: choice.exactTarget,
            },
          )}`
        : freshRecipientRequestNextStep({ draftText });
      return {
        handled: true,
        state: 'ambiguous_target',
        replyText: `Andrea: I found one possible Messages recipient for ${quoteRecipientReplyLabel(actionIntent.targetLabel)}, but it was not an exact match, so I did not select it.\n\n${suggestion}`,
      };
    }
    const optionLines = choices
      .map((choice, index) => {
        const exactHint =
          choice.exactTarget && choice.exactTarget !== choice.displayLabel
            ? ` — use ${choice.exactTarget}`
            : '';
        return `${index + 1}. ${choice.displayLabel}${exactHint}`;
      })
      .join('\n');
    const firstExactTarget = choices.find(
      (choice) => choice.exactTarget,
    )?.exactTarget;
    return {
      handled: true,
      state: 'ambiguous_target',
      replyText: `Andrea: I found more than one Messages recipient that could be ${quoteRecipientReplyLabel(actionIntent.targetLabel)}, so I did not select one.\n\nChoose one exact recipient:\n${optionLines}\n\n${freshRecipientRequestNextStep(
        {
          draftText,
          exactTarget: firstExactTarget,
          exampleOnly: Boolean(firstExactTarget),
        },
      )}`,
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
    sourceKey: (() => {
      const baseSourceKey = buildSourceKey({
        channel: params.channel,
        chatJid: params.chatJid,
        inboundMessageId: params.inboundMessageId,
        targetChatJid: target.chatJid,
        draftText,
      });
      return params.recentTextReview
        ? `recent-text-review-bound:${params.recentTextReview.linkFingerprint}:${baseSourceKey}`
        : baseSourceKey;
    })(),
    sourceSummary: `Draft text message to ${target.displayName}.`,
    draftProvenance,
    draftText,
    personName: target.displayName,
    threadTitle: target.displayName,
    communicationContext: 'general',
    communicationThreadId:
      params.recentTextReview?.communicationThreadId || null,
    recentTextReview: params.recentTextReview || null,
    // The initial imperative selects the exact recipient/body only. A separate
    // fresh Send now/send it action is always required for provider dispatch.
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
 * Handles a normalized owner send request. Historical terminal inbound actions
 * are replayed as read-only delivery truth; every fresh request is staged as an
 * exact recipient/body card and cannot dispatch until a separate fresh owner
 * approval enters the message-action boundary.
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
    (!intent.targetLabel && params.recipientResolution?.state !== 'resolved') ||
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

  return stageBlueBubblesOutboundRequest(params);
}
