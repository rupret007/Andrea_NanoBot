import { createHash, randomUUID } from 'crypto';

import {
  createTask,
  claimBlueBubblesMessageActionDispatch,
  getAllChats,
  getTaskById,
  getCommunicationThread,
  getMessageAction,
  getMessageActionByScheduledTaskId,
  getMessageActionBySource,
  findLatestOpenMessageActionForChat,
  listMessageActionsForGroup,
  listMessagesByProviderIdempotencyKey,
  listRecentMessagesForChat,
  updateCommunicationThread,
  updateMessageAction,
  updateMessageActionIfSendStatus,
  updateTask,
  upsertMessageAction,
} from './db.js';
import {
  findMatchingDelegationRule,
  recordDelegationRuleOverride,
  recordDelegationRuleUsage,
} from './delegation-rules.js';
import { handleLifeThreadCommand } from './life-threads.js';
import { planContextualReminder } from './local-reminder.js';
import { runActionPreflight } from './action-preflight.js';
import {
  isChannelDeliveryRejectedBeforeDispatchError,
  ChannelDeliveryUnverifiedError,
  isChannelDeliveryUnverifiedError,
  requireCompleteChannelDelivery,
} from './channel-delivery.js';
import { recordCognitiveOwnerReview } from './cognitive-kernel.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';
import {
  captureMessagingOutboundAuthorizationFence,
  getMessagingOutboundPauseState,
  isMessagingOutboundPaused,
} from './messaging-outbound-pause.js';
import {
  syncOutcomeFromMessageActionRecord,
  syncOutcomeFromReminderTask,
} from './outcome-reviews.js';
import {
  isBlueBubblesDirectChatJidForAddress,
  resolveBlueBubblesConfig,
} from './channels/bluebubbles.js';
import {
  canonicalizeBlueBubblesSelfThreadJid,
  expandBlueBubblesLogicalSelfThreadJids,
  getBlueBubblesCanonicalSelfThreadJid,
  isConfiguredBlueBubblesSelfThreadAliasJid,
  isBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import { rewriteBlueBubblesMessageDraft } from './messages-fluidity.js';
import {
  isExactNonEmptyMessagesHistoryRefreshReceipt,
  validateMessagesThreadSnapshotBinding,
} from './recent-text-review.js';
import { parseAssistantMessageActionIntent } from './assistant-action-intent.js';
import {
  formatRuntimeCapabilityOutcome,
  runtimeCapabilityRegistry,
} from './runtime-capability-registry.js';
import type {
  BlueBubblesConversationalEligibility,
  BlueBubblesConversationKind,
  BlueBubblesDecisionPolicy,
  BlueBubblesProofDrillState,
  ChannelInlineAction,
  MessageActionExplanation,
  MessageActionDraftProvenance,
  MessageActionLinkedRefs,
  MessageActionNamedMessagesSummaryLink,
  MessageActionRecentTextReviewLink,
  MessageActionRecord,
  MessageActionSendStatus,
  MessageActionSourceType,
  MessageActionTargetChannel,
  MessageActionTargetKind,
  MessageActionTrustLevel,
  ScheduledTask,
  SendMessageOptions,
  SendMessageResult,
} from './types.js';
import type { AssistantPresentation } from './assistant-presentation.js';

type PresentationChannel = 'telegram' | 'bluebubbles' | 'alexa';

interface ExternalThreadTarget {
  kind: 'external_thread';
  chatJid: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
  isGroup?: boolean | null;
  personName?: string | null;
  blueBubblesCreateChatAddress?: string | null;
}

interface SelfCompanionTarget {
  kind: 'self_companion';
  chatJid: string;
  threadId?: string | null;
}

type MessageTarget = ExternalThreadTarget | SelfCompanionTarget;

export interface BlueBubblesExplicitThreadSendIntent {
  targetLabel: string;
  draftText: string;
}

export interface ResolvedBlueBubblesThreadTarget {
  chatJid: string;
  displayName: string;
  isGroup: boolean;
  blueBubblesCreateChatAddress?: string | null;
}

export interface CreateMessageActionFromDraftParams {
  groupFolder: string;
  presentationChannel: Exclude<PresentationChannel, 'alexa'>;
  presentationChatJid: string;
  presentationThreadId?: string | null;
  sourceType: MessageActionSourceType;
  sourceKey: string;
  sourceSummary?: string | null;
  /** Who supplied the exact recipient-facing bytes shown in the draft card. */
  draftProvenance?: MessageActionDraftProvenance;
  draftText: string;
  personName?: string | null;
  threadTitle?: string | null;
  communicationThreadId?: string | null;
  recentTextReview?: MessageActionRecentTextReviewLink | null;
  namedMessagesSummary?: MessageActionNamedMessagesSummaryLink | null;
  threadId?: string | null;
  missionId?: string | null;
  handoffId?: string | null;
  currentWorkRef?: string | null;
  actionBundleId?: string | null;
  reminderTaskId?: string | null;
  communicationContext?:
    | 'reply_followthrough'
    | 'household_followthrough'
    | 'general'
    | null;
  forceApproval?: boolean;
  /** The current trusted owner utterance explicitly authorizes this action. */
  explicitApproval?: boolean;
  delegationRuleId?: string | null;
  delegationMode?: MessageActionRecord['delegationMode'];
  delegationExplanation?: string | null;
  targetOverride?: MessageTarget | null;
  targetChannelOverride?: MessageActionTargetChannel | null;
  now?: Date;
}

export interface MessageActionPresentation {
  text: string;
  summaryText: string;
  inlineActionRows: ChannelInlineAction[][];
  focusMessageActionIds: string[];
  primaryMessageActionId: string;
  structured: AssistantPresentation;
}

export interface ParsedMessageActionPresentation {
  targetLabel: string | null;
  draftText: string;
}

export type MessageActionOperation =
  | { kind: 'show' }
  | { kind: 'show_draft' }
  | { kind: 'send' }
  | { kind: 'send_again' }
  | { kind: 'defer'; timingHint?: string | null }
  | { kind: 'cancel_deferred' }
  | { kind: 'remind_instead'; timingHint?: string | null }
  | { kind: 'keep_draft' }
  | { kind: 'save_to_thread' }
  | { kind: 'rewrite'; style: 'shorter' | 'warmer' | 'more_direct' }
  | { kind: 'rewrite_and_send'; style: 'shorter' | 'warmer' | 'more_direct' }
  | { kind: 'skip' }
  | { kind: 'why' };

export interface ApplyMessageActionOperationResult {
  handled: boolean;
  action?: MessageActionRecord;
  presentation?: MessageActionPresentation;
  replyText?: string;
}

export interface MessageActionExecutionDeps {
  groupFolder: string;
  channel: PresentationChannel;
  chatJid: string;
  currentTime?: Date;
  /** Immutable local receipt time of the owner action authorizing this work. */
  ownerAuthorizationAt?: string;
  /** Read-only exact-thread refresh used to revalidate context-bound drafts. */
  primeMessagesChatHistory?: (chatJid: string) => Promise<unknown>;
  sendToTarget: (
    targetChannel: MessageActionTargetChannel,
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
  /**
   * Post-receipt bookkeeping only. This callback cannot authorize, redirect,
   * or dispatch a message and must never be consulted before provider proof.
   */
  onVerifiedSend?: (action: MessageActionRecord) => void;
}

export function isMessageActionBoundToPresentationSurface(params: {
  action: Pick<MessageActionRecord, 'presentationChatJid'>;
  channel: PresentationChannel;
  chatJid: string;
}): boolean {
  const presentationChatJid = normalizeText(params.action.presentationChatJid);
  const currentChatJid = normalizeText(params.chatJid);
  if (!presentationChatJid || !currentChatJid) return false;
  if (presentationChatJid === currentChatJid) return true;
  if (params.channel !== 'bluebubbles') return false;
  return (
    isConfiguredBlueBubblesSelfThreadAliasJid(presentationChatJid) &&
    isConfiguredBlueBubblesSelfThreadAliasJid(currentChatJid)
  );
}

export function isMessageActionBoundToPresentationMessage(params: {
  action: Pick<
    MessageActionRecord,
    'presentationMessageId' | 'presentationThreadId'
  >;
  presentationMessageId?: string | null;
  presentationThreadId?: string | null;
}): boolean {
  const expectedMessageId = normalizeText(params.action.presentationMessageId);
  const observedMessageId = normalizeText(params.presentationMessageId);
  if (!expectedMessageId || !observedMessageId) return false;
  if (expectedMessageId !== observedMessageId) return false;
  const expectedThreadId = normalizeText(params.action.presentationThreadId);
  const observedThreadId = normalizeText(params.presentationThreadId);
  return expectedThreadId === observedThreadId;
}

interface SendExecutionResult {
  action: MessageActionRecord;
  replyText: string;
  target: MessageTarget;
  didSend: boolean;
}

function notifyVerifiedSend(
  deps: MessageActionExecutionDeps,
  action: MessageActionRecord,
): void {
  if (
    action.sendStatus !== 'sent' ||
    !normalizeText(action.platformMessageId) ||
    !deps.onVerifiedSend
  ) {
    return;
  }
  try {
    deps.onVerifiedSend(action);
  } catch {
    // Provider truth is already durable. Optional lifecycle bookkeeping must
    // never turn a verified success into an apparent failure or invite replay.
  }
}

export interface ResolveMessageActionForPromptParams {
  groupFolder: string;
  chatJid: string;
  rawText: string;
  /** Exact platform message referenced by a native reply gesture. */
  replyToMessageId?: string | null;
  /** Return one exact stale match only so the caller can present a denial. */
  includeStaleForDenial?: boolean;
  now?: Date;
}

export interface BlueBubblesMessageActionContinuityAction {
  action: MessageActionRecord;
  presentationChatJid: string;
  targetChatJid: string | null;
  engagedAt: string;
  conversationKind: BlueBubblesConversationKind;
  decisionPolicy: BlueBubblesDecisionPolicy;
  conversationalEligibility: BlueBubblesConversationalEligibility;
  requiresExplicitMention: boolean;
  activePresentationAt: string | null;
  eligibleFollowups: string[];
  isActive: boolean;
}

export interface BlueBubblesMessageActionContinuitySnapshot {
  sourceSelfThreadChatJid: string | null;
  canonicalSelfThreadChatJid: string | null;
  conversationKind: BlueBubblesConversationKind;
  decisionPolicy: BlueBubblesDecisionPolicy;
  conversationalEligibility: BlueBubblesConversationalEligibility;
  requiresExplicitMention: boolean;
  activeMessageActionId: string | null;
  activeAction: MessageActionRecord | null;
  activePresentationAt: string | null;
  recentTargetChatJid: string;
  recentTargetAt: string;
  openMessageActionCount: number;
  continuityState: 'idle' | 'draft_open' | 'awaiting_decision' | 'proof_gap';
  proofCandidateChatJid: string;
  eligibleFollowups: string[];
  openActions: BlueBubblesMessageActionContinuityAction[];
  rehydratedActionId: string | null;
  supersededActionIds: string[];
}

export type BlueBubblesSelfThreadContinuityAction =
  BlueBubblesMessageActionContinuityAction;

export type BlueBubblesSelfThreadContinuitySnapshot =
  BlueBubblesMessageActionContinuitySnapshot;

export const MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS = 30 * 60 * 1000;
export const BLUEBUBBLES_PROOF_DRILL_SOURCE_KEY_PREFIX =
  'bluebubbles-proof-drill:self-thread';
export const BLUEBUBBLES_PROOF_DRILL_NEXT_STEP =
  'In the same BlueBubbles self-thread, say `send it later tonight` to record the safe deferred proof decision.';

const BLUEBUBBLES_PROOF_DRILL_DRAFT_TEXT =
  'BlueBubbles proof drill: keep this unsent and use send it later tonight to record the deferred same-thread decision.';

const BLUEBUBBLES_SELF_THREAD_ELIGIBLE_FOLLOWUPS = [
  'show it again',
  'make it shorter',
  'make it more direct',
  'save that',
  'remind me instead',
  'send it later',
  'send it later tonight',
] as const;

const BLUEBUBBLES_EXPLICIT_ONLY_ELIGIBLE_FOLLOWUPS = [
  'show it again',
  'make it shorter',
  'make it more direct',
] as const;

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeMessageActionBodyForEquality(value: string): string {
  return value.replace(/\r\n/g, '\n');
}

function messageActionBodiesEqual(left: string, right: string): boolean {
  return (
    normalizeMessageActionBodyForEquality(left) ===
    normalizeMessageActionBodyForEquality(right)
  );
}

function messageActionBodyFingerprint(value: string): string {
  return createHash('sha256')
    .update(normalizeMessageActionBodyForEquality(value), 'utf8')
    .digest('hex');
}

function normalizeMessageActionCommand(
  value: string | null | undefined,
): string {
  return normalizeText(value)
    .replace(/^@andrea\b[,:;!?-]*/i, '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBlueBubblesConversationChatJid(
  chatJid: string | null | undefined,
): string | null {
  const normalized =
    canonicalizeBlueBubblesSelfThreadJid(chatJid) ||
    normalizeText(chatJid || null) ||
    null;
  return normalized || null;
}

function resolveBlueBubblesConversationKind(
  chatJid: string | null | undefined,
): BlueBubblesConversationKind {
  if (isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)) {
    return 'self_thread';
  }
  const normalizedChatJid = normalizeBlueBubblesConversationChatJid(chatJid);
  const knownChat = normalizedChatJid
    ? getAllChats().find((chat) => chat.jid === normalizedChatJid)
    : null;
  return knownChat?.is_group ? 'group' : 'direct_1to1';
}

function isBlueBubblesSemiAutoDecisionPolicy(
  policy: BlueBubblesDecisionPolicy,
): boolean {
  return (
    policy === 'semi_auto_self_thread' ||
    policy === 'semi_auto_recent_direct_1to1'
  );
}

function resolveBlueBubblesDecisionPolicy(
  conversationKind: BlueBubblesConversationKind,
  context: {
    hasFreshActiveAction: boolean;
    hasFreshDraftPresentation: boolean;
    hasFreshAndreaContext: boolean;
  },
): BlueBubblesDecisionPolicy {
  if (conversationKind === 'self_thread') {
    return 'semi_auto_self_thread';
  }
  if (
    conversationKind === 'direct_1to1' &&
    (context.hasFreshActiveAction ||
      context.hasFreshDraftPresentation ||
      context.hasFreshAndreaContext)
  ) {
    return 'semi_auto_recent_direct_1to1';
  }
  return 'explicit_only';
}

function resolveBlueBubblesConversationalEligibility(
  decisionPolicy: BlueBubblesDecisionPolicy,
): BlueBubblesConversationalEligibility {
  return isBlueBubblesSemiAutoDecisionPolicy(decisionPolicy)
    ? 'conversational_now'
    : 'explicit_only';
}

function resolveBlueBubblesRequiresExplicitMention(
  decisionPolicy: BlueBubblesDecisionPolicy,
): boolean {
  return decisionPolicy === 'explicit_only';
}

function resolveBlueBubblesEligibleFollowups(
  decisionPolicy: BlueBubblesDecisionPolicy,
): string[] {
  return isBlueBubblesSemiAutoDecisionPolicy(decisionPolicy)
    ? [...BLUEBUBBLES_SELF_THREAD_ELIGIBLE_FOLLOWUPS]
    : [...BLUEBUBBLES_EXPLICIT_ONLY_ELIGIBLE_FOLLOWUPS];
}

function findFreshBlueBubblesAndreaContextMessage(params: {
  chatJids: string[];
  now: Date;
}): ReturnType<typeof listRecentMessagesForChat>[number] | null {
  const freshnessCutoff =
    params.now.getTime() - MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS;
  let freshest: ReturnType<typeof listRecentMessagesForChat>[number] | null =
    null;
  let freshestTimestamp = Number.NEGATIVE_INFINITY;
  for (const chatJid of [...new Set(params.chatJids)]) {
    for (const message of listRecentMessagesForChat(chatJid, 12)) {
      const timestamp = Date.parse(message.timestamp || '');
      if (!Number.isFinite(timestamp) || timestamp < freshnessCutoff) {
        continue;
      }
      const fromAndrea =
        Boolean(message.is_bot_message) ||
        (Boolean(message.is_from_me) &&
          /^\s*Andrea:/i.test(message.content || ''));
      if (!fromAndrea || timestamp <= freshestTimestamp) {
        continue;
      }
      freshest = message;
      freshestTimestamp = timestamp;
    }
  }
  return freshest;
}

function normalizeBlueBubblesChatLookup(
  value: string | null | undefined,
): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(
      /\b(?:thread|chat|conversation|group|text(?:\s+message)?s?|messages?|message|space)\b/g,
      ' ',
    )
    .replace(/[“”"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function blueBubblesRecipientAddressKeys(
  value: string | null | undefined,
): string[] {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return [];
  if (normalized.includes('@')) return [`email:${normalized}`];
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7) return [];
  const keys = new Set([`phone:${digits}`]);
  if (digits.length === 11 && digits.startsWith('1')) {
    keys.add(`phone:${digits.slice(1)}`);
  }
  return [...keys];
}

function blueBubblesDirectAddressFromJid(jid: string): string | null {
  const match = jid.replace(/^bb:/, '').match(/^[^;]+;-;(.+)$/);
  return match?.[1]?.trim() || null;
}

function buildBlueBubblesChatDisplayName(params: {
  jid: string;
  name: string | null | undefined;
}): string {
  const normalizedName = normalizeText(params.name);
  if (normalizedName && normalizedName !== params.jid) {
    return normalizedName;
  }
  return params.jid.replace(/^bb:/, '');
}

function clipText(value: string | null | undefined, max = 140): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function buildLinkedRefs(
  params: CreateMessageActionFromDraftParams,
): MessageActionLinkedRefs {
  return {
    actionBundleId: params.actionBundleId || undefined,
    communicationThreadId: params.communicationThreadId || undefined,
    threadId: params.threadId || undefined,
    missionId: params.missionId || undefined,
    handoffId: params.handoffId || undefined,
    reminderTaskId: params.reminderTaskId || undefined,
    currentWorkRef: params.currentWorkRef || undefined,
    chatJid: params.presentationChatJid,
    personName: params.personName || undefined,
    delegationRuleId: params.delegationRuleId || undefined,
    delegationMode: params.delegationMode || null,
    delegationExplanation: params.delegationExplanation || null,
    conversationSnapshotRequired: params.recentTextReview
      ? 'recent_text_review'
      : params.namedMessagesSummary
        ? 'named_messages_summary'
        : undefined,
    recentTextReview: params.recentTextReview || undefined,
    namedMessagesSummary: params.namedMessagesSummary || undefined,
  };
}

function parseTargetConversation(
  action: Pick<MessageActionRecord, 'targetConversationJson'>,
): {
  chatJid: string | null;
  personName: string | null;
} {
  const parsed = parseJsonSafe<{
    chatJid?: string | null;
    personName?: string | null;
  }>(action.targetConversationJson, {});
  return {
    chatJid: normalizeText(parsed.chatJid || null) || null,
    personName: normalizeText(parsed.personName || null) || null,
  };
}

function isOpenMessageActionStatus(status: MessageActionSendStatus): boolean {
  return (
    status !== 'sent' &&
    status !== 'skipped' &&
    status !== 'delivery_unverified'
  );
}

function isActionableBlueBubblesDecisionStatus(
  status: MessageActionSendStatus,
): boolean {
  return status === 'drafted' || status === 'approved' || status === 'failed';
}

function isBlueBubblesDispatchableStatus(
  status: MessageActionSendStatus,
): status is 'drafted' | 'approved' | 'deferred' {
  return status === 'drafted' || status === 'approved' || status === 'deferred';
}

type MessageActionUpdates = Parameters<typeof updateMessageAction>[1];

interface MessageActionMutationResult {
  applied: boolean;
  action: MessageActionRecord;
}

function nextMessageActionVersion(
  action: Pick<MessageActionRecord, 'lastUpdatedAt'>,
  proposedAt: string,
): string {
  const previousMs = Date.parse(action.lastUpdatedAt);
  const proposedMs = Date.parse(proposedAt);
  if (!Number.isFinite(previousMs)) return proposedAt;
  if (!Number.isFinite(proposedMs) || proposedMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return proposedAt;
}

/**
 * Applies an action mutation from the exact row snapshot the caller acted on.
 * BlueBubbles rows use a durable status+version CAS and terminal delivery rows
 * are never eligible. Other channels retain the existing partial-update API.
 */
function updateMessageActionFromSnapshot(params: {
  action: MessageActionRecord;
  updates: MessageActionUpdates;
  expectedStatuses?: readonly MessageActionSendStatus[];
}): MessageActionMutationResult {
  if (params.action.targetChannel !== 'bluebubbles') {
    updateMessageAction(params.action.messageActionId, params.updates);
    return {
      applied: true,
      action: getMessageAction(params.action.messageActionId) || params.action,
    };
  }
  if (
    params.action.sendStatus === 'sent' ||
    params.action.sendStatus === 'delivery_unverified'
  ) {
    return {
      applied: false,
      action: getMessageAction(params.action.messageActionId) || params.action,
    };
  }
  const expectedStatuses = params.expectedStatuses || [
    params.action.sendStatus,
  ];
  if (
    expectedStatuses.includes('sent') ||
    expectedStatuses.includes('delivery_unverified')
  ) {
    return {
      applied: false,
      action: getMessageAction(params.action.messageActionId) || params.action,
    };
  }
  const proposedLastUpdatedAt =
    params.updates.lastUpdatedAt || new Date().toISOString();
  const applied = updateMessageActionIfSendStatus(
    params.action.messageActionId,
    expectedStatuses,
    params.action.lastUpdatedAt,
    {
      ...params.updates,
      lastUpdatedAt: nextMessageActionVersion(
        params.action,
        proposedLastUpdatedAt,
      ),
    },
  );
  return {
    applied,
    action: getMessageAction(params.action.messageActionId) || params.action,
  };
}

function staleBlueBubblesMutationReply(
  action: MessageActionRecord,
  attemptedAction: string,
): string {
  if (action.sendStatus === 'sent') {
    return `Andrea: That message already went out, so I did not ${attemptedAction}. Create a fresh message action if you want to send something else.`;
  }
  if (action.sendStatus === 'delivery_unverified') {
    return `Andrea: Delivery is unverified, so I did not ${attemptedAction} or change the fenced action. Check the target conversation first; create a fresh message action if another message is needed.`;
  }
  return `Andrea: This action changed to ${action.sendStatus} before I could ${attemptedAction}, so I did not apply the stale change. The current status shown here is authoritative.`;
}

function skipBlueBubblesContinuityAction(
  action: MessageActionRecord,
  now: Date,
): MessageActionRecord {
  const nowIso = now.toISOString();
  const refreshed = updateMessageActionFromSnapshot({
    action,
    updates: {
      sendStatus: 'skipped',
      followupAt: null,
      scheduledTaskId: null,
      requiresApproval: false,
      approvedAt: null,
      lastActionKind: 'skipped',
      lastActionAt: nowIso,
      lastUpdatedAt: nowIso,
    },
  }).action;
  syncOutcomeFromMessageActionRecord(refreshed, now);
  return refreshed;
}

function resolveBlueBubblesConversationPresentationChatJid(
  action: Pick<MessageActionRecord, 'presentationChatJid'>,
): string | null {
  return normalizeBlueBubblesConversationChatJid(action.presentationChatJid);
}

function buildBlueBubblesMessageActionContinuityKey(
  action: Pick<
    MessageActionRecord,
    | 'presentationChatJid'
    | 'targetConversationJson'
    | 'draftText'
    | 'targetChannel'
    | 'targetKind'
  >,
): string | null {
  if (
    action.targetChannel !== 'bluebubbles' ||
    action.targetKind !== 'external_thread'
  ) {
    return null;
  }
  const presentationChatJid =
    resolveBlueBubblesConversationPresentationChatJid(action);
  const targetChatJid = parseTargetConversation(action).chatJid;
  const normalizedDraft = normalizeMessageActionBodyForEquality(
    action.draftText,
  );
  if (!presentationChatJid || !targetChatJid || !normalizedDraft) {
    return null;
  }
  return JSON.stringify([presentationChatJid, targetChatJid, normalizedDraft]);
}

function findFreshBlueBubblesDraftPresentation(params: {
  chatJids: string[];
  now: Date;
}): ReturnType<typeof listRecentMessagesForChat>[number] | null {
  const cutoff = params.now.getTime() - MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS;
  return (
    params.chatJids
      .flatMap((chatJid) => listRecentMessagesForChat(chatJid, 8))
      .filter((message) => Boolean(message.is_bot_message))
      .sort(
        (left, right) =>
          Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''),
      )
      .find((message) => {
        const timestamp = Date.parse(message.timestamp || '');
        if (!Number.isFinite(timestamp) || timestamp < cutoff) {
          return false;
        }
        return Boolean(
          parseMessageActionPresentationText(message.content || ''),
        );
      }) || null
  );
}

function listBlueBubblesMessageActionContinuityCandidates(params: {
  groupFolder: string;
  canonicalChatJid: string;
}): Array<{
  action: MessageActionRecord;
  presentationChatJid: string;
  targetChatJid: string | null;
  engagedAt: string;
  engagedAtMs: number;
  continuityKey: string | null;
}> {
  return listMessageActionsForGroup({
    groupFolder: params.groupFolder,
    includeSent: false,
    limit: 200,
  })
    .filter((action) => action.targetChannel === 'bluebubbles')
    .filter((action) => action.targetKind === 'external_thread')
    .filter((action) => isOpenMessageActionStatus(action.sendStatus))
    .map((action) => {
      const presentationChatJid =
        resolveBlueBubblesConversationPresentationChatJid(action);
      if (presentationChatJid !== params.canonicalChatJid) {
        return null;
      }
      const engagedAt =
        action.lastActionAt || action.lastUpdatedAt || action.createdAt;
      const engagedAtMs = Date.parse(engagedAt || '');
      if (!Number.isFinite(engagedAtMs)) {
        return null;
      }
      return {
        action,
        presentationChatJid,
        targetChatJid: parseTargetConversation(action).chatJid,
        engagedAt,
        engagedAtMs,
        continuityKey: buildBlueBubblesMessageActionContinuityKey(action),
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        action: MessageActionRecord;
        presentationChatJid: string;
        targetChatJid: string | null;
        engagedAt: string;
        engagedAtMs: number;
        continuityKey: string | null;
      } => Boolean(entry),
    )
    .sort((left, right) => right.engagedAtMs - left.engagedAtMs);
}

function containsHighRiskMessagingCue(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;
  return [
    /\b(?:sorry|apologize|upset|angry|hurt|disappointed)\b/,
    /\b(?:money|pay|invoice|rent|salary|bank)\b/,
    /\b(?:calendar|meeting|reschedule|commit|promise|deadline)\b/,
    /\b(?:medical|doctor|hospital|emergency)\b/,
    /\b(?:love you|break up|relationship)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function inferTarget(params: CreateMessageActionFromDraftParams): {
  targetKind: MessageActionTargetKind;
  targetChannel: MessageActionTargetChannel;
  target: MessageTarget;
} {
  if (params.targetOverride) {
    return {
      targetKind:
        params.targetOverride.kind === 'external_thread'
          ? 'external_thread'
          : 'self_companion',
      targetChannel:
        params.targetChannelOverride ||
        (params.presentationChannel === 'bluebubbles'
          ? 'bluebubbles'
          : 'telegram'),
      target: params.targetOverride,
    };
  }

  const thread = params.communicationThreadId
    ? getCommunicationThread(params.communicationThreadId)
    : undefined;
  const isExternalThread =
    (thread?.channel === 'bluebubbles' || thread?.channel === 'telegram') &&
    Boolean(thread.channelChatJid);

  if (isExternalThread && thread?.channelChatJid) {
    return {
      targetKind: 'external_thread',
      targetChannel: thread.channel === 'telegram' ? 'telegram' : 'bluebubbles',
      target: {
        kind: 'external_thread',
        chatJid: thread.channelChatJid,
        threadId: params.presentationThreadId || null,
        replyToMessageId: thread.lastMessageId || null,
        isGroup: thread.title.includes(',') || thread.title.includes('&'),
        personName: params.personName || thread.title,
      },
    };
  }

  return {
    targetKind: 'self_companion',
    targetChannel:
      params.presentationChannel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
    target: {
      kind: 'self_companion',
      chatJid: params.presentationChatJid,
      threadId: params.presentationThreadId || null,
    },
  };
}

function classifyTrustLevel(params: {
  draftText: string;
  targetKind: MessageActionTargetKind;
  targetChannel: MessageActionTargetChannel;
  target: MessageTarget;
}): MessageActionTrustLevel {
  if (params.targetKind === 'self_companion') return 'draft_only';
  if (params.targetChannel !== 'bluebubbles') return 'draft_only';
  if (params.target.kind === 'external_thread' && params.target.isGroup) {
    return 'draft_only';
  }
  if (
    containsHighRiskMessagingCue(params.draftText) ||
    normalizeText(params.draftText).length > 220
  ) {
    return 'draft_only';
  }
  return 'approve_before_send';
}

function isNarrowSafeDelegatedSendCandidate(
  action: Pick<
    MessageActionRecord,
    'targetChannel' | 'targetKind' | 'draftText' | 'trustLevel'
  >,
  target: MessageTarget,
): boolean {
  if (action.targetChannel !== 'bluebubbles') return false;
  if (action.targetKind !== 'external_thread') return false;
  if (
    action.trustLevel === 'draft_only' ||
    action.trustLevel === 'never_automate'
  ) {
    return false;
  }
  if (target.kind !== 'external_thread' || target.isGroup) return false;
  if (containsHighRiskMessagingCue(action.draftText)) return false;
  const normalized = normalizeText(action.draftText);
  if (!normalized || normalized.length > 180) return false;
  const lineCount = action.draftText.split(/\r?\n/).filter(Boolean).length;
  return lineCount <= 3;
}

function buildExplanation(params: {
  sourceSummary?: string | null;
  draftProvenance?: MessageActionDraftProvenance;
  trustLevel: MessageActionTrustLevel;
  requiresApproval: boolean;
  delegationExplanation?: string | null;
}): MessageActionExplanation {
  return {
    sourceSummary: params.sourceSummary || null,
    draftProvenance: params.draftProvenance,
    approvalReason: params.requiresApproval
      ? 'This still needs your approval before it goes out.'
      : 'This matched a narrow rule you already approved for safe reuse.',
    safetyReason:
      params.trustLevel === 'draft_only'
        ? 'This looks better as a draft than an automatic send.'
        : params.trustLevel === 'approve_before_send'
          ? 'Andrea can prepare it, but you stay in control of the actual send.'
          : params.trustLevel === 'delegated_safe_send'
            ? 'This fit your narrow low-risk messaging default.'
            : null,
    delegationNote: params.delegationExplanation || null,
    trustNote:
      params.trustLevel === 'schedule_send'
        ? 'Send later keeps the draft and brings it back for approval.'
        : null,
  };
}

function buildDedupeKey(params: {
  groupFolder: string;
  sourceType: MessageActionSourceType;
  sourceKey: string;
  targetChannel: MessageActionTargetChannel;
  targetConversationJson: string;
  draftText: string;
  seed?: string | null;
}): string {
  return [
    params.groupFolder,
    params.sourceType,
    params.sourceKey,
    params.targetChannel,
    clipText(params.targetConversationJson, 80),
    messageActionBodyFingerprint(params.draftText),
    params.seed || '',
  ]
    .map((value) => normalizeText(value))
    .join('|');
}

function buildInboundMessageActionId(params: {
  groupFolder: string;
  sourceType: MessageActionSourceType;
  sourceKey: string;
}): string {
  const digest = createHash('sha256')
    .update(
      `${params.groupFolder}\u0000${params.sourceType}\u0000${params.sourceKey}`,
      'utf8',
    )
    .digest('hex');
  // A stable UUID-shaped provider key lets independent processes converge on
  // one durable action and one BlueBubbles tempGuid for the same inbound event.
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(
    13,
    16,
  )}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function createOrRefreshMessageActionFromDraft(
  params: CreateMessageActionFromDraftParams,
): MessageActionRecord {
  const now = params.now || new Date();
  const targetInfo = inferTarget(params);
  const baseTrustLevel = classifyTrustLevel({
    draftText: params.draftText,
    targetKind: targetInfo.targetKind,
    targetChannel: targetInfo.targetChannel,
    target: targetInfo.target,
  });
  const ruleMatch = findMatchingDelegationRule({
    groupFolder: params.groupFolder,
    channel: params.presentationChannel,
    actionType: 'send_message',
    originKind:
      params.sourceType === 'mission'
        ? 'mission'
        : params.sourceType === 'ritual_review'
          ? 'daily_guidance'
          : 'communication',
    personName: params.personName,
    threadTitle: params.threadTitle,
    communicationContext: params.communicationContext || 'general',
  });
  // A stored delegation rule may shape a draft, but it must never turn the
  // creation of an outward message action into dispatch approval. Every
  // external recipient requires a separately presented, fresh owner action.
  const externalRecipient = targetInfo.targetKind === 'external_thread';
  const autoSendEligible =
    !externalRecipient &&
    !params.forceApproval &&
    Boolean(ruleMatch.rule) &&
    ruleMatch.autoApplied &&
    isNarrowSafeDelegatedSendCandidate(
      {
        targetChannel: targetInfo.targetChannel,
        targetKind: targetInfo.targetKind,
        draftText: params.draftText,
        trustLevel: baseTrustLevel,
      },
      targetInfo.target,
    );
  const explicitlyApproved =
    !externalRecipient && Boolean(params.explicitApproval);
  const trustLevel: MessageActionTrustLevel = autoSendEligible
    ? 'delegated_safe_send'
    : baseTrustLevel;
  const requiresApproval = !autoSendEligible && !explicitlyApproved;
  const sendStatus: MessageActionSendStatus =
    autoSendEligible || explicitlyApproved ? 'approved' : 'drafted';
  const targetConversationJson = JSON.stringify(targetInfo.target);
  const existing = getMessageActionBySource(
    params.groupFolder,
    params.sourceType,
    params.sourceKey,
  );
  // A retried inbound platform event is the same owner instruction. Preserve
  // its original recipient, payload, state, and receipt rather than allowing
  // refreshed directory metadata to create a second external side effect.
  if (existing && params.sourceKey.includes(':inbound:')) {
    return existing;
  }
  const reuseExisting =
    existing &&
    isOpenMessageActionStatus(existing.sendStatus) &&
    existing.targetKind === targetInfo.targetKind &&
    existing.targetChannel === targetInfo.targetChannel &&
    existing.targetConversationJson === targetConversationJson &&
    normalizeText(existing.presentationChatJid) ===
      normalizeText(params.presentationChatJid) &&
    normalizeText(existing.presentationThreadId) ===
      normalizeText(params.presentationThreadId) &&
    messageActionBodiesEqual(existing.draftText, params.draftText);
  if (
    existing &&
    !reuseExisting &&
    isOpenMessageActionStatus(existing.sendStatus)
  ) {
    updateMessageAction(existing.messageActionId, {
      sendStatus: 'skipped',
      followupAt: null,
      scheduledTaskId: null,
      lastActionKind: 'skipped',
      lastActionAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    });
  }
  const inboundIdentity = params.sourceKey.includes(':inbound:');
  const record: MessageActionRecord = {
    messageActionId: reuseExisting
      ? existing!.messageActionId
      : inboundIdentity
        ? buildInboundMessageActionId(params)
        : randomUUID(),
    groupFolder: params.groupFolder,
    sourceType: params.sourceType,
    sourceKey: params.sourceKey,
    sourceSummary: params.sourceSummary || null,
    targetKind: targetInfo.targetKind,
    targetChannel: targetInfo.targetChannel,
    targetConversationJson,
    draftText: params.draftText,
    trustLevel,
    sendStatus,
    followupAt: reuseExisting ? existing?.followupAt || null : null,
    requiresApproval,
    delegationRuleId: params.forceApproval
      ? null
      : params.delegationRuleId || ruleMatch.rule?.ruleId || null,
    delegationMode: params.forceApproval
      ? null
      : params.delegationMode || ruleMatch.effectiveApprovalMode || null,
    explanationJson: JSON.stringify(
      buildExplanation({
        sourceSummary: params.sourceSummary,
        draftProvenance: params.draftProvenance,
        trustLevel,
        requiresApproval,
        delegationExplanation: params.forceApproval
          ? null
          : params.delegationExplanation || ruleMatch.explanation || null,
      }),
    ),
    linkedRefsJson: JSON.stringify(
      buildLinkedRefs({
        ...params,
        delegationRuleId: params.forceApproval
          ? null
          : params.delegationRuleId || ruleMatch.rule?.ruleId || null,
        delegationMode: params.forceApproval
          ? null
          : params.delegationMode || ruleMatch.effectiveApprovalMode || null,
        delegationExplanation: params.forceApproval
          ? null
          : params.delegationExplanation || ruleMatch.explanation || null,
      }),
    ),
    platformMessageId: reuseExisting
      ? existing?.platformMessageId || null
      : null,
    scheduledTaskId: reuseExisting ? existing?.scheduledTaskId || null : null,
    approvedAt: reuseExisting
      ? existing?.approvedAt || null
      : sendStatus === 'approved'
        ? now.toISOString()
        : null,
    lastActionKind: reuseExisting
      ? existing?.lastActionKind || null
      : sendStatus === 'approved'
        ? 'approved'
        : 'drafted',
    lastActionAt: reuseExisting
      ? existing?.lastActionAt || null
      : now.toISOString(),
    dedupeKey: buildDedupeKey({
      groupFolder: params.groupFolder,
      sourceType: params.sourceType,
      sourceKey: params.sourceKey,
      targetChannel: targetInfo.targetChannel,
      targetConversationJson,
      draftText: params.draftText,
      seed: reuseExisting ? existing?.messageActionId : now.toISOString(),
    }),
    presentationChatJid: params.presentationChatJid,
    presentationThreadId: params.presentationThreadId || null,
    presentationMessageId: reuseExisting
      ? existing?.presentationMessageId || null
      : null,
    createdAt: reuseExisting ? existing!.createdAt : now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    sentAt: reuseExisting ? existing?.sentAt || null : null,
  };
  let saved: MessageActionRecord;
  if (reuseExisting && existing?.targetChannel === 'bluebubbles') {
    saved = updateMessageActionFromSnapshot({
      action: existing,
      updates: {
        sourceSummary: record.sourceSummary,
        targetConversationJson: record.targetConversationJson,
        draftText: record.draftText,
        trustLevel: record.trustLevel,
        sendStatus: record.sendStatus,
        followupAt: record.followupAt,
        requiresApproval: record.requiresApproval,
        delegationRuleId: record.delegationRuleId,
        delegationMode: record.delegationMode,
        explanationJson: record.explanationJson,
        linkedRefsJson: record.linkedRefsJson,
        platformMessageId: record.platformMessageId,
        scheduledTaskId: record.scheduledTaskId,
        approvedAt: record.approvedAt,
        lastActionKind: record.lastActionKind,
        lastActionAt: record.lastActionAt,
        presentationChatJid: record.presentationChatJid,
        presentationThreadId: record.presentationThreadId,
        presentationMessageId: record.presentationMessageId,
        lastUpdatedAt: record.lastUpdatedAt,
        sentAt: record.sentAt,
      },
    }).action;
  } else {
    upsertMessageAction(record, {
      insertOnly: inboundIdentity || record.targetChannel === 'bluebubbles',
    });
    saved = getMessageAction(record.messageActionId) || record;
  }
  syncOutcomeFromMessageActionRecord(saved, now);
  return saved;
}

function parseTarget(record: MessageActionRecord): MessageTarget {
  return parseJsonSafe<MessageTarget>(record.targetConversationJson, {
    kind:
      record.targetKind === 'external_thread'
        ? 'external_thread'
        : 'self_companion',
    chatJid: record.presentationChatJid || '',
  } as MessageTarget);
}

function isGroupExternalMessageTarget(target: MessageTarget): boolean {
  return (
    target.kind === 'external_thread' &&
    (target.isGroup === true || /^(?:bb:)?[^;]+;\+;/.test(target.chatJid))
  );
}

function isGroupExternalMessageAction(record: MessageActionRecord): boolean {
  return isGroupExternalMessageTarget(parseTarget(record));
}

const GROUP_DRAFT_ONLY_REPLY =
  'Andrea: I kept that as a group draft only. I cannot send it or queue it for later; you can still review, rewrite, save, set a reminder, or discard it.';

function parseLinkedRefs(record: MessageActionRecord): MessageActionLinkedRefs {
  return parseJsonSafe<MessageActionLinkedRefs>(record.linkedRefsJson, {});
}

function fingerprintMessageActionSnapshotValue(
  domain: string,
  value: string,
): string {
  return createHash('sha256')
    .update(`${domain}\u0000${value}`, 'utf8')
    .digest('hex');
}

function computeRecentTextReviewSnapshotLinkFingerprint(
  link: Omit<MessageActionRecentTextReviewLink, 'linkFingerprint'>,
): string {
  return fingerprintMessageActionSnapshotValue(
    'message-action-recent-text-review-link',
    [
      link.version,
      link.seedFingerprint,
      link.reviewedAt,
      link.itemId,
      link.itemRank,
      link.communicationThreadId,
      link.historyStartTimestamp,
      link.freshnessSnapshot.latestMessageIdentityHash,
      link.freshnessSnapshot.latestMessageAt,
      link.freshnessSnapshot.latestInboundAt || '',
      link.freshnessSnapshot.latestOutboundAt || '',
      link.freshnessSnapshot.messageCount,
      link.freshnessSnapshot.snapshotHash,
      link.freshnessSnapshot.transcriptHash,
      link.targetChatFingerprint,
      link.presentationScopeFingerprint,
    ].join('\u0000'),
  );
}

function computeNamedMessagesSummarySnapshotLinkFingerprint(
  link: Omit<MessageActionNamedMessagesSummaryLink, 'linkFingerprint'>,
): string {
  return fingerprintMessageActionSnapshotValue(
    'message-action-named-messages-summary-link',
    [
      link.version,
      link.queryFingerprint,
      link.historyStartTimestamp,
      link.freshnessSnapshot.latestMessageIdentityHash,
      link.freshnessSnapshot.latestMessageAt,
      link.freshnessSnapshot.latestInboundAt || '',
      link.freshnessSnapshot.latestOutboundAt || '',
      link.freshnessSnapshot.messageCount,
      link.freshnessSnapshot.snapshotHash,
      link.freshnessSnapshot.transcriptHash,
      link.targetChatFingerprint,
      link.presentationScopeFingerprint,
    ].join('\u0000'),
  );
}

function parseMessageActionFreshnessSnapshot(
  value: unknown,
): MessageActionRecentTextReviewLink['freshnessSnapshot'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.latestMessageIdentityHash !== 'string' ||
    !/^[a-f0-9]{16}$/i.test(snapshot.latestMessageIdentityHash) ||
    typeof snapshot.latestMessageAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.latestMessageAt)) ||
    !(
      snapshot.latestInboundAt === null ||
      typeof snapshot.latestInboundAt === 'string'
    ) ||
    !(
      snapshot.latestOutboundAt === null ||
      typeof snapshot.latestOutboundAt === 'string'
    ) ||
    typeof snapshot.messageCount !== 'number' ||
    !Number.isInteger(snapshot.messageCount) ||
    snapshot.messageCount < 1 ||
    typeof snapshot.snapshotHash !== 'string' ||
    !/^[a-f0-9]{16}$/i.test(snapshot.snapshotHash) ||
    typeof snapshot.transcriptHash !== 'string' ||
    !/^[a-f0-9]{16}$/i.test(snapshot.transcriptHash)
  ) {
    return null;
  }
  return {
    latestMessageIdentityHash: snapshot.latestMessageIdentityHash,
    latestMessageAt: snapshot.latestMessageAt,
    latestInboundAt: snapshot.latestInboundAt,
    latestOutboundAt: snapshot.latestOutboundAt,
    messageCount: snapshot.messageCount,
    snapshotHash: snapshot.snapshotHash,
    transcriptHash: snapshot.transcriptHash,
  };
}

function parseRecentTextReviewSnapshotLink(
  value: unknown,
): MessageActionRecentTextReviewLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const freshnessSnapshot = parseMessageActionFreshnessSnapshot(
    candidate.freshnessSnapshot,
  );
  if (
    candidate.version !== 2 ||
    typeof candidate.seedFingerprint !== 'string' ||
    typeof candidate.reviewedAt !== 'string' ||
    typeof candidate.itemId !== 'string' ||
    typeof candidate.itemRank !== 'number' ||
    typeof candidate.communicationThreadId !== 'string' ||
    typeof candidate.historyStartTimestamp !== 'string' ||
    !freshnessSnapshot ||
    typeof candidate.targetChatFingerprint !== 'string' ||
    typeof candidate.presentationScopeFingerprint !== 'string' ||
    typeof candidate.linkFingerprint !== 'string'
  ) {
    return null;
  }
  const link: MessageActionRecentTextReviewLink = {
    version: 2,
    seedFingerprint: candidate.seedFingerprint,
    reviewedAt: candidate.reviewedAt,
    itemId: candidate.itemId,
    itemRank: candidate.itemRank,
    communicationThreadId: candidate.communicationThreadId,
    historyStartTimestamp: candidate.historyStartTimestamp,
    freshnessSnapshot,
    targetChatFingerprint: candidate.targetChatFingerprint,
    presentationScopeFingerprint: candidate.presentationScopeFingerprint,
    linkFingerprint: candidate.linkFingerprint,
  };
  const fingerprints = [
    link.seedFingerprint,
    link.targetChatFingerprint,
    link.presentationScopeFingerprint,
    link.linkFingerprint,
  ];
  const { linkFingerprint: _linkFingerprint, ...linkWithoutFingerprint } = link;
  return fingerprints.every((value) => /^[a-f0-9]{64}$/i.test(value)) &&
    Number.isFinite(Date.parse(link.reviewedAt)) &&
    Number.isFinite(Date.parse(link.historyStartTimestamp)) &&
    /^text-review:[a-f0-9]{16,64}$/i.test(link.itemId) &&
    Number.isInteger(link.itemRank) &&
    link.itemRank >= 1 &&
    link.itemRank <= 8 &&
    /^[a-z0-9][a-z0-9:._-]{0,199}$/i.test(link.communicationThreadId) &&
    computeRecentTextReviewSnapshotLinkFingerprint(linkWithoutFingerprint) ===
      link.linkFingerprint
    ? link
    : null;
}

function parseNamedMessagesSummarySnapshotLink(
  value: unknown,
): MessageActionNamedMessagesSummaryLink | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const freshnessSnapshot = parseMessageActionFreshnessSnapshot(
    candidate.freshnessSnapshot,
  );
  if (
    candidate.version !== 1 ||
    typeof candidate.queryFingerprint !== 'string' ||
    typeof candidate.historyStartTimestamp !== 'string' ||
    !freshnessSnapshot ||
    typeof candidate.targetChatFingerprint !== 'string' ||
    typeof candidate.presentationScopeFingerprint !== 'string' ||
    typeof candidate.linkFingerprint !== 'string'
  ) {
    return null;
  }
  const link: MessageActionNamedMessagesSummaryLink = {
    version: 1,
    queryFingerprint: candidate.queryFingerprint,
    historyStartTimestamp: candidate.historyStartTimestamp,
    freshnessSnapshot,
    targetChatFingerprint: candidate.targetChatFingerprint,
    presentationScopeFingerprint: candidate.presentationScopeFingerprint,
    linkFingerprint: candidate.linkFingerprint,
  };
  const fingerprints = [
    link.queryFingerprint,
    link.targetChatFingerprint,
    link.presentationScopeFingerprint,
    link.linkFingerprint,
  ];
  const { linkFingerprint: _linkFingerprint, ...linkWithoutFingerprint } = link;
  return fingerprints.every((fingerprint) =>
    /^[a-f0-9]{64}$/i.test(fingerprint),
  ) &&
    Number.isFinite(Date.parse(link.historyStartTimestamp)) &&
    computeNamedMessagesSummarySnapshotLinkFingerprint(
      linkWithoutFingerprint,
    ) === link.linkFingerprint
    ? link
    : null;
}

type ContextBoundMessageActionFreshnessResult =
  | { ok: true }
  | { ok: false; detail: string };

function resolveMessageActionSnapshotRequirement(
  action: MessageActionRecord,
): MessageActionLinkedRefs['conversationSnapshotRequired'] | null {
  const refs = parseLinkedRefs(action);
  if (
    refs.conversationSnapshotRequired === 'recent_text_review' ||
    refs.conversationSnapshotRequired === 'named_messages_summary'
  ) {
    return refs.conversationSnapshotRequired;
  }
  if (
    action.sourceKey.startsWith('recent-text-review-bound:') ||
    action.sourceKey.startsWith('text-review:') ||
    refs.recentTextReview
  ) {
    return 'recent_text_review';
  }
  if (
    action.sourceKey.startsWith('named-messages-summary-draft:') ||
    refs.namedMessagesSummary
  ) {
    return 'named_messages_summary';
  }
  return null;
}

async function validateContextBoundMessageActionFreshness(input: {
  action: MessageActionRecord;
  target: MessageTarget;
  deps: MessageActionExecutionDeps;
}): Promise<ContextBoundMessageActionFreshnessResult> {
  const requirement = resolveMessageActionSnapshotRequirement(input.action);
  if (!requirement) return { ok: true };
  if (
    input.target.kind !== 'external_thread' ||
    !input.target.chatJid.startsWith('bb:')
  ) {
    return {
      ok: false,
      detail: 'the context-bound draft no longer has one exact Messages target',
    };
  }
  const refs = parseLinkedRefs(input.action);
  const presentationScope = `${input.action.groupFolder}\u0000${input.action.presentationChatJid}`;
  const binding =
    requirement === 'recent_text_review'
      ? parseRecentTextReviewSnapshotLink(refs.recentTextReview)
      : parseNamedMessagesSummarySnapshotLink(refs.namedMessagesSummary);
  if (!binding) {
    return {
      ok: false,
      detail: `the ${requirement.replaceAll('_', ' ')} snapshot link is missing or corrupt`,
    };
  }
  const expectedTargetFingerprint = fingerprintMessageActionSnapshotValue(
    requirement === 'recent_text_review'
      ? 'recent-text-review-target-chat'
      : 'named-messages-summary-target-chat',
    input.target.chatJid,
  );
  const expectedPresentationFingerprint = fingerprintMessageActionSnapshotValue(
    requirement === 'recent_text_review'
      ? 'recent-text-review-presentation-scope'
      : 'named-messages-summary-presentation-scope',
    presentationScope,
  );
  if (
    binding.targetChatFingerprint !== expectedTargetFingerprint ||
    binding.presentationScopeFingerprint !== expectedPresentationFingerprint ||
    (requirement === 'recent_text_review' &&
      (!('communicationThreadId' in binding) ||
        refs.communicationThreadId !== binding.communicationThreadId))
  ) {
    return {
      ok: false,
      detail:
        'the context-bound draft target or private presentation scope changed',
    };
  }
  if (!input.deps.primeMessagesChatHistory) {
    return {
      ok: false,
      detail:
        'the exact Messages thread refresh capability is unavailable at dispatch',
    };
  }
  let receipt: unknown;
  try {
    receipt = await input.deps.primeMessagesChatHistory(input.target.chatJid);
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return {
      ok: false,
      detail: 'the exact Messages thread could not be refreshed at dispatch',
    };
  }
  if (
    !isExactNonEmptyMessagesHistoryRefreshReceipt({
      receipt,
      expectedChatJid: input.target.chatJid,
    })
  ) {
    return {
      ok: false,
      detail:
        'the exact Messages thread refresh returned no verifiable target rows',
    };
  }
  const snapshotValidation = validateMessagesThreadSnapshotBinding({
    chatJid: input.target.chatJid,
    historyStartTimestamp: binding.historyStartTimestamp,
    freshnessSnapshot: binding.freshnessSnapshot,
  });
  return snapshotValidation.ok
    ? { ok: true }
    : { ok: false, detail: snapshotValidation.detail };
}

export function linkMessageActionCognitiveContext(params: {
  messageActionId: string;
  cognitiveRunId?: string | null;
  cognitiveSkillId?: string | null;
  cognitiveTrajectoryId?: string | null;
  agentRuntimeRunId?: string | null;
  now?: Date;
}): MessageActionRecord | undefined {
  const action = getMessageAction(params.messageActionId);
  if (!action) return undefined;
  const linkedRefs: MessageActionLinkedRefs = {
    ...parseLinkedRefs(action),
    ...(params.cognitiveRunId ? { cognitiveRunId: params.cognitiveRunId } : {}),
    ...(params.cognitiveSkillId
      ? { cognitiveSkillId: params.cognitiveSkillId }
      : {}),
    ...(params.cognitiveTrajectoryId
      ? { cognitiveTrajectoryId: params.cognitiveTrajectoryId }
      : {}),
    ...(params.agentRuntimeRunId
      ? { agentRuntimeRunId: params.agentRuntimeRunId }
      : {}),
  };
  return updateMessageActionFromSnapshot({
    action,
    updates: {
      linkedRefsJson: JSON.stringify(linkedRefs),
      lastUpdatedAt: (params.now || new Date()).toISOString(),
    },
  }).action;
}

function recordMessageActionOwnerDecision(params: {
  action: MessageActionRecord;
  verdict: 'accepted' | 'rejected';
  decisionKind: string;
  now: Date;
}): MessageActionRecord {
  let action = params.action;
  if (isBlueBubblesProofDrillAction(action)) {
    return action;
  }
  const linkedRefs = parseLinkedRefs(action);
  const review = recordCognitiveOwnerReview({
    runId: linkedRefs.cognitiveRunId,
    feedbackId: `message-action-${action.messageActionId}`,
    verdict: params.verdict,
    reviewedAt: params.now.toISOString(),
  });
  if (review.signalId) {
    const nextLinkedRefs: MessageActionLinkedRefs = {
      ...linkedRefs,
      cognitiveOwnerReviewSignalId: review.signalId,
    };
    action = updateMessageActionFromSnapshot({
      action,
      updates: {
        linkedRefsJson: JSON.stringify(nextLinkedRefs),
        lastUpdatedAt: params.now.toISOString(),
      },
    }).action;
  }
  recordAssistantMetric({
    eventId: `message-action:${action.messageActionId}:owner-review`,
    groupFolder: action.groupFolder,
    kind:
      params.verdict === 'accepted'
        ? 'recommendation_accepted'
        : 'recommendation_rejected',
    metadata: {
      metricClass: 'owner_review',
      outcomeId: action.messageActionId,
      decisionKind: params.decisionKind,
      cognitiveRunId: linkedRefs.cognitiveRunId || '',
      channel: action.targetChannel,
    },
    now: params.now,
  });
  if (params.verdict === 'accepted' && action.sendStatus === 'sent') {
    recordAssistantMetric({
      eventId: `message-action:${action.messageActionId}:completion`,
      groupFolder: action.groupFolder,
      kind: 'completion_verified',
      metadata: {
        metricClass: 'owner_review',
        outcomeId: action.messageActionId,
        decisionKind: params.decisionKind,
        cognitiveRunId: linkedRefs.cognitiveRunId || '',
      },
      now: params.now,
    });
  }
  return action;
}

function parseLinkedRefsRecord(
  record: MessageActionRecord,
): Record<string, unknown> {
  return parseJsonSafe<Record<string, unknown>>(record.linkedRefsJson, {});
}

export function isBlueBubblesProofDrillAction(
  action: Pick<MessageActionRecord, 'sourceKey' | 'linkedRefsJson'>,
): boolean {
  if (action.sourceKey.startsWith(BLUEBUBBLES_PROOF_DRILL_SOURCE_KEY_PREFIX)) {
    return true;
  }
  const linkedRefs = parseJsonSafe<Record<string, unknown>>(
    action.linkedRefsJson,
    {},
  );
  return linkedRefs.bluebubblesProofDrill === true;
}

function resolveProofDrillStartedAt(action: MessageActionRecord): string {
  const linkedRefs = parseLinkedRefsRecord(action);
  return typeof linkedRefs.proofDrillStartedAt === 'string'
    ? linkedRefs.proofDrillStartedAt
    : action.createdAt;
}

function proofDrillTouchedAt(action: MessageActionRecord): string {
  return (
    action.lastActionAt ||
    action.lastUpdatedAt ||
    action.createdAt ||
    resolveProofDrillStartedAt(action)
  );
}

function proofDrillTouchedAtMs(action: MessageActionRecord): number {
  const parsed = Date.parse(proofDrillTouchedAt(action));
  return Number.isFinite(parsed) ? parsed : 0;
}

function listBlueBubblesProofDrillActions(
  groupFolder: string,
): MessageActionRecord[] {
  return listMessageActionsForGroup({
    groupFolder,
    includeSent: true,
    limit: 200,
  })
    .filter(isBlueBubblesProofDrillAction)
    .sort(
      (left, right) =>
        proofDrillTouchedAtMs(right) - proofDrillTouchedAtMs(left),
    );
}

function stampBlueBubblesProofDrillAction(params: {
  action: MessageActionRecord;
  chatJid: string;
  now: Date;
}): MessageActionRecord {
  const nowIso = params.now.toISOString();
  const linkedRefs = {
    ...parseLinkedRefsRecord(params.action),
    bluebubblesProofDrill: true,
    proofDrillStartedAt: nowIso,
    proofDrillNextStep: BLUEBUBBLES_PROOF_DRILL_NEXT_STEP,
    chatJid: params.chatJid,
    personName: 'Andrea self-thread',
  };
  return updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sourceSummary: 'BlueBubbles same-thread proof drill.',
      draftText: BLUEBUBBLES_PROOF_DRILL_DRAFT_TEXT,
      trustLevel: 'draft_only',
      sendStatus: 'drafted',
      followupAt: null,
      scheduledTaskId: null,
      requiresApproval: true,
      approvedAt: null,
      lastActionKind: 'drafted',
      lastActionAt: nowIso,
      presentationChatJid: params.chatJid,
      linkedRefsJson: JSON.stringify(linkedRefs),
      lastUpdatedAt: nowIso,
    },
  }).action;
}

function recordBlueBubblesProofDrillDeferredDecision(params: {
  action: MessageActionRecord;
  now: Date;
}): MessageActionMutationResult {
  const nowIso = params.now.toISOString();
  const linkedRefs = {
    ...parseLinkedRefsRecord(params.action),
    bluebubblesProofDrill: true,
    proofDrillDeferredAt: nowIso,
    proofDrillDecision: 'send_it_later_tonight',
  };
  const mutation = updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sendStatus: 'deferred',
      followupAt: null,
      scheduledTaskId: null,
      requiresApproval: false,
      trustLevel: 'draft_only',
      approvedAt: null,
      lastActionKind: 'remind_instead',
      lastActionAt: nowIso,
      linkedRefsJson: JSON.stringify(linkedRefs),
      lastUpdatedAt: nowIso,
    },
  });
  if (mutation.applied) pauseScheduledTask(params.action.scheduledTaskId);
  const updatedAction = mutation.action;
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return { ...mutation, action: updatedAction };
}

export interface BlueBubblesProofDrillSnapshot {
  proofDrillState: BlueBubblesProofDrillState;
  proofDrillActionId: string;
  proofDrillStartedAt: string;
  proofDrillNextStep: string;
}

export interface BlueBubblesProofDrillStartResult {
  action: MessageActionRecord;
  presentationText: string;
  snapshot: BlueBubblesProofDrillSnapshot;
}

export function resolveBlueBubblesProofDrillSnapshot(params: {
  groupFolder: string;
  now?: Date;
}): BlueBubblesProofDrillSnapshot {
  const now = params.now || new Date();
  const actions = listBlueBubblesProofDrillActions(params.groupFolder);
  const latest = actions[0] || null;
  if (!latest) {
    return {
      proofDrillState: 'idle',
      proofDrillActionId: 'none',
      proofDrillStartedAt: 'none',
      proofDrillNextStep:
        'Start the BlueBubbles proof drill from the control API, MCP, or the canonical self-thread.',
    };
  }
  const touchedAt = proofDrillTouchedAt(latest);
  const touchedAtMs = Date.parse(touchedAt);
  const isFresh =
    Number.isFinite(touchedAtMs) &&
    touchedAtMs + MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS >= now.getTime();
  const isOpen = isActionableBlueBubblesDecisionStatus(latest.sendStatus);
  if (latest.sendStatus === 'deferred') {
    return {
      proofDrillState: 'deferred',
      proofDrillActionId: latest.messageActionId,
      proofDrillStartedAt: resolveProofDrillStartedAt(latest),
      proofDrillNextStep:
        'Deferred same-thread proof decision is recorded; confirm status after the BlueBubbles same-thread confirmation posts.',
    };
  }
  if (isOpen && isFresh) {
    return {
      proofDrillState: 'active',
      proofDrillActionId: latest.messageActionId,
      proofDrillStartedAt: resolveProofDrillStartedAt(latest),
      proofDrillNextStep: BLUEBUBBLES_PROOF_DRILL_NEXT_STEP,
    };
  }
  return {
    proofDrillState: 'stale',
    proofDrillActionId: latest.messageActionId,
    proofDrillStartedAt: resolveProofDrillStartedAt(latest),
    proofDrillNextStep:
      'Start a fresh BlueBubbles proof drill; the previous drill is no longer fresh.',
  };
}

export function buildBlueBubblesProofDrillPresentationText(
  action: MessageActionRecord,
): string {
  return [
    'Andrea: BlueBubbles proof drill is ready.',
    '',
    'Target: Andrea self-thread proof lane in Messages.',
    '',
    'Draft:',
    action.draftText,
    '',
    'Status: ready for a deferred same-thread decision. I will not send this immediately.',
    `Next: ${BLUEBUBBLES_PROOF_DRILL_NEXT_STEP}`,
  ].join('\n');
}

export function startBlueBubblesProofDrill(params: {
  groupFolder: string;
  chatJid?: string | null;
  now?: Date;
}): BlueBubblesProofDrillStartResult {
  const now = params.now || new Date();
  const chatJid =
    canonicalizeBlueBubblesSelfThreadJid(params.chatJid) ||
    (params.chatJid && isBlueBubblesSelfThreadAliasJid(params.chatJid)
      ? params.chatJid
      : null) ||
    getBlueBubblesCanonicalSelfThreadJid();
  if (!isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)) {
    throw new Error(
      'BlueBubbles proof drill requires an explicitly configured owner self-thread.',
    );
  }

  const freshnessCutoff =
    now.getTime() - MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS;
  let activeProofDrill = listBlueBubblesProofDrillActions(
    params.groupFolder,
  ).find(
    (action) =>
      isActionableBlueBubblesDecisionStatus(action.sendStatus) &&
      proofDrillTouchedAtMs(action) >= freshnessCutoff,
  );
  for (const action of listBlueBubblesProofDrillActions(params.groupFolder)) {
    if (action.messageActionId === activeProofDrill?.messageActionId) {
      continue;
    }
    if (isActionableBlueBubblesDecisionStatus(action.sendStatus)) {
      skipBlueBubblesContinuityAction(action, now);
    }
  }

  if (activeProofDrill) {
    activeProofDrill = stampBlueBubblesProofDrillAction({
      action: activeProofDrill,
      chatJid,
      now,
    });
  } else {
    const created = createOrRefreshMessageActionFromDraft({
      groupFolder: params.groupFolder,
      presentationChannel: 'bluebubbles',
      presentationChatJid: chatJid,
      sourceType: 'manual_prompt',
      sourceKey: `${BLUEBUBBLES_PROOF_DRILL_SOURCE_KEY_PREFIX}:${now.getTime()}`,
      sourceSummary: 'BlueBubbles same-thread proof drill.',
      draftText: BLUEBUBBLES_PROOF_DRILL_DRAFT_TEXT,
      personName: 'Andrea self-thread',
      threadTitle: 'Andrea self-thread proof lane',
      communicationContext: 'reply_followthrough',
      targetOverride: {
        kind: 'external_thread',
        chatJid,
        threadId: null,
        replyToMessageId: null,
        isGroup: false,
        personName: 'Andrea self-thread',
      },
      targetChannelOverride: 'bluebubbles',
      now,
    });
    activeProofDrill = stampBlueBubblesProofDrillAction({
      action: created,
      chatJid,
      now,
    });
  }

  reconcileBlueBubblesSelfThreadContinuity({
    groupFolder: params.groupFolder,
    chatJid,
    now,
    allowRehydrate: false,
  });
  const action =
    getMessageAction(activeProofDrill.messageActionId) || activeProofDrill;
  return {
    action,
    presentationText: buildBlueBubblesProofDrillPresentationText(action),
    snapshot: resolveBlueBubblesProofDrillSnapshot({
      groupFolder: params.groupFolder,
      now,
    }),
  };
}

function parseExplanation(
  record: MessageActionRecord,
): MessageActionExplanation {
  return parseJsonSafe<MessageActionExplanation>(record.explanationJson, {});
}

function formatWhenLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function normalizeReminderTimingHint(
  rawHint: string | null | undefined,
  fallbackHint: string,
): { normalizedHint: string; usedDefault: boolean } {
  const normalized = normalizeText(rawHint).toLowerCase();
  if (!normalized) {
    return {
      normalizedHint: fallbackHint,
      usedDefault: true,
    };
  }

  switch (normalized) {
    case 'tonight':
    case 'later tonight':
    case 'this evening':
      return { normalizedHint: 'today tonight', usedDefault: false };
    case 'this afternoon':
    case 'later this afternoon':
    case 'afternoon':
      return { normalizedHint: 'today afternoon', usedDefault: false };
    case 'this morning':
    case 'morning':
      return { normalizedHint: 'tomorrow morning', usedDefault: false };
    case 'tomorrow':
      return { normalizedHint: 'tomorrow morning', usedDefault: false };
    default:
      return { normalizedHint: normalized, usedDefault: false };
  }
}

function planMessageFollowupTiming(params: {
  timingHint?: string | null;
  fallbackHint: string;
  reminderBody: string;
  groupFolder: string;
  chatJid: string;
  now: Date;
}): {
  planned: ReturnType<typeof planContextualReminder>;
  normalizedHint: string;
} {
  const { normalizedHint, usedDefault } = normalizeReminderTimingHint(
    params.timingHint,
    params.fallbackHint,
  );
  const candidateHints = [normalizedHint];
  if (usedDefault && normalizedHint === 'today tonight') {
    candidateHints.push('tomorrow morning');
  }

  for (const candidateHint of candidateHints) {
    const planned = planContextualReminder(
      candidateHint,
      params.reminderBody,
      params.groupFolder,
      params.chatJid,
      params.now,
    );
    if (planned) {
      return {
        planned,
        normalizedHint: candidateHint,
      };
    }
  }

  return {
    planned: null,
    normalizedHint,
  };
}

function isScheduledSendAction(record: MessageActionRecord): boolean {
  return (
    record.sendStatus === 'deferred' &&
    record.trustLevel === 'schedule_send' &&
    Boolean(record.scheduledTaskId)
  );
}

function normalizeTrustLevelAfterQueue(
  record: MessageActionRecord,
): MessageActionTrustLevel {
  if (
    record.delegationMode === 'auto_apply_when_safe' &&
    record.delegationRuleId &&
    isNarrowSafeDelegatedSendCandidate(record, parseTarget(record))
  ) {
    return 'delegated_safe_send';
  }
  if (
    record.targetKind === 'external_thread' &&
    record.targetChannel === 'bluebubbles'
  ) {
    return 'approve_before_send';
  }
  return classifyTrustLevel({
    draftText: record.draftText,
    targetKind: record.targetKind,
    targetChannel: record.targetChannel,
    target: parseTarget(record),
  });
}

function pauseScheduledTask(taskId: string | null | undefined): void {
  if (!taskId) return;
  const task = getTaskById(taskId);
  if (!task) return;
  updateTask(taskId, {
    status: 'paused',
    next_run: null,
  });
}

function inferUrgencyFromDueAt(
  dueAt: string | null | undefined,
  now: Date,
): 'none' | 'soon' | 'tonight' | 'tomorrow' | 'overdue' {
  if (!dueAt) return 'soon';
  const parsed = Date.parse(dueAt);
  if (!Number.isFinite(parsed)) return 'soon';
  const diffHours = (parsed - now.getTime()) / (60 * 60 * 1000);
  if (diffHours < 0) return 'overdue';
  if (diffHours <= 12) return 'tonight';
  if (diffHours <= 36) return 'tomorrow';
  return 'soon';
}

function syncCommunicationThreadState(params: {
  action: MessageActionRecord;
  now: Date;
  mode:
    | 'sent'
    | 'scheduled_send'
    | 'reminder'
    | 'thread_saved'
    | 'drafted'
    | 'failed';
  platformMessageId?: string | null;
  dueAt?: string | null;
}): void {
  const linkedRefs = parseLinkedRefs(params.action);
  const communicationThreadId = linkedRefs.communicationThreadId;
  if (!communicationThreadId) return;
  const thread = getCommunicationThread(communicationThreadId);
  if (!thread) return;

  if (params.mode === 'sent') {
    updateCommunicationThread(communicationThreadId, {
      lastOutboundSummary:
        clipText(params.action.draftText, 220) || thread.lastOutboundSummary,
      lastMessageId: params.platformMessageId || thread.lastMessageId,
      followupState: 'waiting_on_them',
      followupDueAt: null,
      urgency: 'none',
      suggestedNextAction: 'ignore',
      updatedAt: params.now.toISOString(),
    });
    return;
  }

  if (params.mode === 'scheduled_send') {
    updateCommunicationThread(communicationThreadId, {
      followupState: 'scheduled',
      followupDueAt: params.dueAt || params.action.followupAt || null,
      urgency: inferUrgencyFromDueAt(
        params.dueAt || params.action.followupAt || null,
        params.now,
      ),
      updatedAt: params.now.toISOString(),
    });
    return;
  }

  if (params.mode === 'reminder') {
    updateCommunicationThread(communicationThreadId, {
      linkedTaskId: linkedRefs.reminderTaskId || thread.linkedTaskId || null,
      followupState: 'scheduled',
      followupDueAt: params.dueAt || params.action.followupAt || null,
      urgency: inferUrgencyFromDueAt(
        params.dueAt || params.action.followupAt || null,
        params.now,
      ),
      updatedAt: params.now.toISOString(),
    });
    return;
  }

  if (params.mode === 'thread_saved') {
    updateCommunicationThread(communicationThreadId, {
      followupState: 'reply_needed',
      suggestedNextAction: 'save_for_later',
      updatedAt: params.now.toISOString(),
    });
    return;
  }

  if (params.mode === 'drafted') {
    updateCommunicationThread(communicationThreadId, {
      followupState: 'reply_needed',
      suggestedNextAction: 'draft_reply',
      updatedAt: params.now.toISOString(),
    });
    return;
  }

  updateCommunicationThread(communicationThreadId, {
    followupState: 'reply_needed',
    suggestedNextAction: 'draft_reply',
    updatedAt: params.now.toISOString(),
  });
}

function resolveOwnerAuthorizationAt(
  deps: MessageActionExecutionDeps,
  now: Date,
): string {
  return deps.ownerAuthorizationAt === undefined
    ? now.toISOString()
    : deps.ownerAuthorizationAt;
}

function validateScheduledSendEligibility(
  action: MessageActionRecord,
  options: { authorizationAt?: string | null } = {},
): {
  ok: boolean;
  reason?: string;
  target: MessageTarget;
} {
  const target = parseTarget(action);
  if (isMessagingOutboundPaused()) {
    return {
      ok: false,
      reason: 'Outbound messaging is paused by the owner.',
      target,
    };
  }
  const authorizationAt = options.authorizationAt || action.approvedAt;
  const authorizationAtMs = Date.parse(authorizationAt || '');
  if (!Number.isFinite(authorizationAtMs)) {
    return {
      ok: false,
      reason:
        'This scheduled send is missing a durable owner-authorization timestamp.',
      target,
    };
  }
  const lastPausedAt = getMessagingOutboundPauseState()?.lastPausedAt || null;
  const lastPausedAtMs = Date.parse(lastPausedAt || '');
  if (Number.isFinite(lastPausedAtMs) && authorizationAtMs <= lastPausedAtMs) {
    return {
      ok: false,
      reason:
        'The owner paused Messages after this scheduled send was authorized, so it needs a fresh owner action.',
      target,
    };
  }
  if (
    action.targetChannel !== 'bluebubbles' ||
    action.targetKind !== 'external_thread'
  ) {
    return {
      ok: false,
      reason:
        'This kind of message is safer as a draft or reminder than a queued send.',
      target,
    };
  }
  if (target.kind !== 'external_thread' || target.isGroup) {
    return {
      ok: false,
      reason:
        'Queued send is only available for an existing 1:1 Messages thread.',
      target,
    };
  }
  if (
    action.trustLevel === 'draft_only' ||
    action.trustLevel === 'never_automate'
  ) {
    return {
      ok: false,
      reason: 'This still looks too sensitive for scheduled delivery.',
      target,
    };
  }
  const linkedRefs = parseLinkedRefs(action);
  const communicationThreadId = linkedRefs.communicationThreadId;
  if (!communicationThreadId) {
    return {
      ok: false,
      reason: 'I only queue sends for an existing linked conversation.',
      target,
    };
  }
  const thread = getCommunicationThread(communicationThreadId);
  if (
    !thread ||
    thread.channel !== 'bluebubbles' ||
    !thread.channelChatJid ||
    thread.channelChatJid !== target.chatJid
  ) {
    return {
      ok: false,
      reason:
        'I could not confirm the exact Messages thread for that queued send.',
      target,
    };
  }
  if (!resolveBlueBubblesConfig().sendEnabled) {
    return {
      ok: false,
      reason: 'BlueBubbles send is not enabled on this host right now.',
      target,
    };
  }
  return { ok: true, target };
}

function buildTargetLine(record: MessageActionRecord): string {
  const target = parseTarget(record);
  if (target.kind === 'external_thread') {
    return `Target: ${target.personName || 'that conversation'} in Messages.`;
  }
  return record.targetChannel === 'bluebubbles'
    ? 'Target: your Messages companion.'
    : 'Target: your Telegram companion.';
}

export function parseMessageActionPresentationText(
  rawText: string,
): ParsedMessageActionPresentation | null {
  const normalized = rawText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return null;
  const targetMatch = normalized.match(/^Target:\s*(.+?)(?: in Messages\.)$/im);
  const draftMatch = normalized.match(
    /(?:^|\n)Draft:\n([\s\S]*?)(?:\n\nStatus:|\nStatus:)/m,
  );
  if (!draftMatch?.[1]) {
    return null;
  }
  const targetLabel =
    targetMatch?.[1]?.trim() &&
    targetMatch[1].trim().toLowerCase() !== 'that conversation'
      ? targetMatch[1].trim()
      : null;
  const draftText = draftMatch[1].trim();
  if (!draftText) {
    return null;
  }
  return {
    targetLabel,
    draftText,
  };
}

function extractExplicitPersonName(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  const match = normalized.match(
    /^send (?:(?:this|that|it)(?: reply)?|the (?:shorter|warmer|more direct|full) version) to ([a-z][a-z' -]+)$/i,
  );
  return match?.[1]?.trim() || null;
}

function tokenizePersonName(value: string | null | undefined): string[] {
  const normalized = normalizeText(value).normalize('NFKC').toLocaleLowerCase();
  return Array.from(
    normalized.matchAll(/[\p{L}\p{N}]+/gu),
    (match) => match[0],
  );
}

function normalizeStructuredTargetLabel(
  value: string | null | undefined,
): string {
  return tokenizePersonName(value).join(' ');
}

function actionMatchesPersonName(
  action: MessageActionRecord,
  personName: string,
): boolean {
  const requestedLabel = normalizeStructuredTargetLabel(personName);
  if (!requestedLabel) return false;
  const target = parseTarget(action);
  const linkedRefs = parseLinkedRefs(action);
  const structuredTargetLabel = normalizeStructuredTargetLabel(
    target.kind === 'external_thread'
      ? target.personName || linkedRefs.personName
      : linkedRefs.personName,
  );
  return (
    Boolean(structuredTargetLabel) && requestedLabel === structuredTargetLabel
  );
}

function actionIsBoundToPromptChat(
  action: MessageActionRecord,
  chatJid: string,
): boolean {
  const presentationChatJid = normalizeText(action.presentationChatJid);
  if (!presentationChatJid) return false;
  if (presentationChatJid === normalizeText(chatJid)) return true;
  return (
    chatJid.startsWith('bb:') &&
    isConfiguredBlueBubblesSelfThreadAliasJid(presentationChatJid) &&
    isConfiguredBlueBubblesSelfThreadAliasJid(chatJid) &&
    canonicalizeBlueBubblesSelfThreadJid(presentationChatJid) ===
      canonicalizeBlueBubblesSelfThreadJid(chatJid)
  );
}

function isMessageActionFreshForFollowup(
  action: MessageActionRecord,
  now: Date,
): boolean {
  const lastTouchedAtMs = Date.parse(
    action.lastActionAt || action.lastUpdatedAt || action.createdAt,
  );
  return (
    Number.isFinite(lastTouchedAtMs) &&
    lastTouchedAtMs + MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS >= now.getTime()
  );
}

export interface MessageActionFollowupContextValidation {
  ok: boolean;
  reason?: 'stale_action_context' | 'stale_owner_authorization';
}

export function validateMessageActionFollowupContext(params: {
  action: Pick<
    MessageActionRecord,
    'lastActionAt' | 'lastUpdatedAt' | 'createdAt'
  >;
  now: Date;
  ownerAuthorizationAt?: string | null;
}): MessageActionFollowupContextValidation {
  const lastTouchedAtMs = Date.parse(
    params.action.lastActionAt ||
      params.action.lastUpdatedAt ||
      params.action.createdAt,
  );
  if (
    !Number.isFinite(lastTouchedAtMs) ||
    lastTouchedAtMs + MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS <
      params.now.getTime()
  ) {
    return { ok: false, reason: 'stale_action_context' };
  }
  if (params.ownerAuthorizationAt !== undefined) {
    const ownerAuthorizationAtMs = Date.parse(
      params.ownerAuthorizationAt || '',
    );
    if (
      !Number.isFinite(ownerAuthorizationAtMs) ||
      ownerAuthorizationAtMs + MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS <
        params.now.getTime()
    ) {
      return { ok: false, reason: 'stale_owner_authorization' };
    }
  }
  return { ok: true };
}

function buildActionLead(record: MessageActionRecord): string {
  if (isBlueBubblesProofDrillAction(record)) {
    return record.sendStatus === 'deferred'
      ? 'Andrea: BlueBubbles proof drill deferred decision is recorded.'
      : 'Andrea: BlueBubbles proof drill is ready.';
  }
  if (isScheduledSendAction(record)) {
    return 'Andrea: I queued that to send later.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'save_to_thread'
  ) {
    return 'Andrea: I saved that under the thread.';
  }
  switch (record.sendStatus) {
    case 'sent':
      return 'Andrea: That went out.';
    case 'deferred':
      return record.lastActionKind === 'remind_instead'
        ? 'Andrea: I kept that unsent and set a reminder.'
        : 'Andrea: I saved that to revisit before sending.';
    case 'failed':
      return "Andrea: I couldn't send that right now.";
    case 'delivery_unverified':
      return 'Andrea: I could not verify whether that message arrived.';
    case 'approved':
      return 'Andrea: This is approved and ready.';
    case 'skipped':
      return 'Andrea: Okay, I left that unsent.';
    case 'drafted':
    default:
      return parseExplanation(record).draftProvenance === 'owner_literal'
        ? 'Andrea: I staged your exact text.'
        : 'Andrea: I drafted a reply.';
  }
}

function buildStatusLine(record: MessageActionRecord): string {
  if (
    isGroupExternalMessageAction(record) &&
    isOpenMessageActionStatus(record.sendStatus)
  ) {
    return 'Status: group draft only; Andrea will not send or schedule it.';
  }
  if (isScheduledSendAction(record)) {
    return `Status: queued to send around ${
      formatWhenLabel(record.followupAt) || record.followupAt || 'later'
    }.`;
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'save_to_thread'
  ) {
    return 'Status: saved under the thread for later follow-through.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'remind_instead'
  ) {
    return `Status: kept unsent with a reminder${
      formatWhenLabel(record.followupAt)
        ? ` for ${formatWhenLabel(record.followupAt)}`
        : ''
    }.`;
  }
  if (record.sendStatus === 'deferred' && record.followupAt) {
    return `Status: saved to revisit around ${
      formatWhenLabel(record.followupAt) || record.followupAt
    }.`;
  }
  if (record.sendStatus === 'sent') {
    return 'Status: sent.';
  }
  if (record.sendStatus === 'approved') {
    return 'Status: approved and ready to send.';
  }
  if (record.sendStatus === 'failed') {
    return 'Status: send failed, but the draft is still saved.';
  }
  if (record.sendStatus === 'delivery_unverified') {
    return 'Status: delivery unverified; resending is blocked to prevent a duplicate.';
  }
  if (record.sendStatus === 'skipped') {
    return 'Status: discarded and unsent.';
  }
  return record.requiresApproval
    ? 'Status: waiting for your approval before sending.'
    : 'Status: ready to send.';
}

function buildStateNote(record: MessageActionRecord): string | null {
  if (
    isGroupExternalMessageAction(record) &&
    isOpenMessageActionStatus(record.sendStatus)
  ) {
    return 'This group reply is an unsent draft. Andrea cannot deliver it or queue it for later.';
  }
  if (record.sendStatus === 'sent') {
    return null;
  }
  if (isScheduledSendAction(record)) {
    return 'This draft is already approved. Andrea will send it at the scheduled time unless you revise it, cancel it, or switch to a reminder.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'remind_instead'
  ) {
    return 'This message is still unsent. Andrea only set a reminder.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'save_to_thread'
  ) {
    return 'This message is still unsent. Andrea saved it under the thread for later follow-through.';
  }
  if (record.sendStatus === 'approved') {
    return 'This message is approved, but it has not gone out yet.';
  }
  if (record.sendStatus === 'drafted') {
    return 'This message is still just a draft.';
  }
  if (record.sendStatus === 'delivery_unverified') {
    const evidence = parseExplanation(record).deliveryVerification;
    const confirmedPrefix = evidence?.confirmedReceiptCount
      ? ` The provider confirmed ${evidence.confirmedReceiptCount} message part${evidence.confirmedReceiptCount === 1 ? '' : 's'} before verification stopped.`
      : '';
    return `The send may have arrived in whole or in part.${confirmedPrefix}`;
  }
  return null;
}

function nextStepLine(record: MessageActionRecord): string {
  if (isBlueBubblesProofDrillAction(record)) {
    return record.sendStatus === 'deferred'
      ? 'Next: proof drill decision is recorded. I will keep this unsent.'
      : `Next: ${BLUEBUBBLES_PROOF_DRILL_NEXT_STEP}`;
  }
  if (record.sendStatus === 'sent') {
    return record.targetChannel === 'bluebubbles'
      ? 'Next: create a fresh message action if you want to send another message.'
      : 'Next: review it later if you want to track the follow-through.';
  }
  if (record.sendStatus === 'delivery_unverified') {
    return 'Next: check the target conversation before deciding whether any new message is needed.';
  }
  if (record.sendStatus === 'skipped') {
    return 'Next: create and review a fresh draft if you still want to send a message.';
  }
  if (
    isGroupExternalMessageAction(record) &&
    isOpenMessageActionStatus(record.sendStatus)
  ) {
    return 'Next: discard this group draft. I will not send it.';
  }
  if (isScheduledSendAction(record)) {
    return 'Next: say send it now or cancel.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'save_to_thread'
  ) {
    return 'Next: say send it when you are ready, or discard.';
  }
  if (
    record.sendStatus === 'deferred' &&
    record.lastActionKind === 'remind_instead'
  ) {
    return 'Next: say send it when you are ready, or discard.';
  }
  if (record.sendStatus === 'deferred') {
    return 'Next: say send it when you are ready, or discard.';
  }
  return 'Next: say send it or discard. I can also make it shorter.';
}

function buildInlineRows(record: MessageActionRecord): ChannelInlineAction[][] {
  if (
    record.sendStatus === 'delivery_unverified' ||
    record.sendStatus === 'skipped'
  ) {
    return [];
  }
  if (isBlueBubblesProofDrillAction(record)) {
    return [
      [
        {
          label: 'Send later tonight',
          actionId: `/message-later ${record.messageActionId}`,
        },
      ],
    ];
  }
  if (
    isGroupExternalMessageAction(record) &&
    isOpenMessageActionStatus(record.sendStatus)
  ) {
    return [
      [
        {
          label: 'Show draft',
          actionId: `/message-show ${record.messageActionId}`,
        },
        {
          label: 'Discard draft',
          actionId: `/message-skip ${record.messageActionId}`,
        },
      ],
    ];
  }
  if (record.sendStatus === 'sent') {
    if (record.targetChannel === 'bluebubbles') {
      return [
        [
          {
            label: 'Show draft',
            actionId: `/message-show ${record.messageActionId}`,
          },
        ],
      ];
    }
    return [
      [
        {
          label: 'Show draft',
          actionId: `/message-show ${record.messageActionId}`,
        },
        {
          label: 'Send again',
          actionId: `/message-send-again ${record.messageActionId}`,
        },
      ],
    ];
  }
  if (isScheduledSendAction(record)) {
    return [
      [
        {
          label: 'Send now',
          actionId: `/message-send ${record.messageActionId}`,
        },
        {
          label: 'Cancel send later',
          actionId: `/message-cancel-later ${record.messageActionId}`,
        },
      ],
    ];
  }
  return [
    [
      {
        label: 'Send now',
        actionId: `/message-send ${record.messageActionId}`,
      },
      {
        label: 'Discard draft',
        actionId: `/message-skip ${record.messageActionId}`,
      },
    ],
  ];
}

export function buildMessageActionPresentation(
  record: MessageActionRecord,
  channel: Exclude<PresentationChannel, 'alexa'>,
): MessageActionPresentation {
  const explanation = parseExplanation(record);
  const linkedRefs = parseLinkedRefs(record);
  const lines = [
    buildActionLead(record),
    '',
    buildTargetLine(record),
    '',
    'Draft:',
    record.draftText,
    '',
    buildStatusLine(record),
  ];
  const stateNote = buildStateNote(record);
  if (stateNote) {
    lines.push(stateNote);
  }
  if (linkedRefs.delegationRuleId) {
    lines.push(explanation.delegationNote || 'Used your usual rule here.');
  }
  if (record.requiresApproval && explanation.approvalReason) {
    lines.push(explanation.approvalReason);
  }
  if (record.sendStatus === 'failed') {
    lines.push('I kept the draft here so you can try again or send it later.');
  }
  lines.push(nextStepLine(record));
  return {
    text: lines.join('\n'),
    summaryText:
      clipText(record.sourceSummary || record.draftText, 120) ||
      'Message follow-through',
    inlineActionRows: channel === 'telegram' ? buildInlineRows(record) : [],
    focusMessageActionIds: [record.messageActionId],
    primaryMessageActionId: record.messageActionId,
    structured: {
      kind: 'message_draft',
      title: 'Message draft',
      lead: buildActionLead(record),
      facts: [buildTargetLine(record), buildStatusLine(record)],
      state:
        record.sendStatus === 'delivery_unverified'
          ? 'blocked'
          : record.sendStatus === 'failed'
            ? 'failed'
            : record.sendStatus === 'sent'
              ? 'verified'
              : 'ready',
      nextAction: nextStepLine(record),
      actions:
        channel === 'telegram'
          ? buildInlineRows(record)
              .flat()
              .slice(0, 3)
              .map((action, index) => ({
                label: action.label,
                actionId: action.actionId || action.url || '',
                kind: index === 0 ? 'primary' : 'secondary',
                externalEffect: /send/i.test(action.label),
              }))
          : [],
    },
  };
}

function rewriteDraft(
  draftText: string,
  style: 'shorter' | 'warmer' | 'more_direct',
): string {
  const normalized = draftText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return draftText;
  if (style === 'shorter') {
    const firstSentence = normalized
      .match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0]
      ?.trim();
    return clipText(firstSentence || normalized, 140);
  }
  if (style === 'warmer') {
    if (/^(hey|hi|hello)\b/i.test(normalized)) {
      return normalized.replace(/\bcan you\b/i, 'could you');
    }
    return `Hey, ${normalized}`.trim();
  }
  return normalized
    .replace(/\bjust wanted to\b/gi, 'want to')
    .replace(/\bi was wondering if\b/gi, 'can you')
    .replace(/\bmaybe\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function humanSendFailure(): string {
  return "Andrea: I couldn't send that right now.\n\nThe draft is still here if you want to try again or send it later.";
}

function describeSendSuccess(
  record: MessageActionRecord,
  target: MessageTarget,
  receipt: SendMessageResult,
): string {
  const providerReceiptId =
    receipt.platformMessageId || receipt.platformMessageIds?.[0] || '';
  const recipient =
    target.kind === 'external_thread'
      ? target.personName || target.chatJid
      : 'your companion chat';
  return `Andrea: ${formatRuntimeCapabilityOutcome({
    state: 'verified_success',
    capabilityId:
      record.targetChannel === 'bluebubbles'
        ? 'messages.send.bluebubbles'
        : 'messages.send.telegram',
    receipt: {
      verification: 'verified',
      providerReceiptId,
      recipient,
      exactContent: record.draftText,
      recordedAt: record.sentAt || undefined,
      idempotencyKey: record.messageActionId,
    },
  })}`;
}

function parseTimingHintFromUtterance(rawText: string): string | null {
  const normalized = normalizeMessageActionCommand(rawText).toLowerCase();
  if (
    /^send it later tonight$/.test(normalized) ||
    /^send it tonight$/.test(normalized)
  ) {
    return 'today tonight';
  }
  if (/^send it tomorrow$/.test(normalized)) {
    return 'tomorrow morning';
  }
  if (/^remind me later tonight$/.test(normalized)) {
    return 'today tonight';
  }
  if (/^remind me tomorrow$/.test(normalized)) {
    return 'tomorrow morning';
  }
  const explicit =
    normalized.match(/^send it later (.+)$/)?.[1] ||
    normalized.match(/^send it (?:around|at) (.+)$/)?.[1] ||
    normalized.match(/^remind me later (.+)$/)?.[1];
  return explicit ? explicit.trim() : null;
}

export function interpretMessageActionFollowup(
  rawText: string,
): MessageActionOperation | null {
  const normalized = normalizeMessageActionCommand(rawText).toLowerCase();
  if (!normalized) return null;
  if (
    /^(show (?:the )?draft|show it again|(?:ok|okay)\s+(?:let'?s|lets)\s+see (?:the )?draft again|(?:let'?s|lets)\s+see (?:the )?draft again|show me (?:the )?draft again|let me see (?:the )?draft again)$/.test(
      normalized,
    )
  ) {
    return { kind: 'show_draft' };
  }
  if (/^send it again$/.test(normalized)) {
    return { kind: 'send_again' };
  }
  if (
    /^(send using blue bubbles|send (?:it|that|this)(?: reply)? using blue bubbles|send (?:it|that|this)(?: reply)? with blue bubbles)$/.test(
      normalized,
    ) ||
    /^(send it|send now|send that|send that reply|send this reply)$/.test(
      normalized,
    ) ||
    /^send (?:this|that|it)(?: reply)? to [a-z][a-z' -]+$/i.test(normalized)
  ) {
    return { kind: 'send' };
  }
  if (/^send the shorter version(?: to [a-z][a-z' -]+)?$/i.test(normalized)) {
    return { kind: 'rewrite_and_send', style: 'shorter' };
  }
  if (/^send the warmer version(?: to [a-z][a-z' -]+)?$/i.test(normalized)) {
    return { kind: 'rewrite_and_send', style: 'warmer' };
  }
  if (
    /^send the more direct version(?: to [a-z][a-z' -]+)?$/i.test(normalized)
  ) {
    return { kind: 'rewrite_and_send', style: 'more_direct' };
  }
  if (/^send it later\b/.test(normalized)) {
    return { kind: 'defer', timingHint: parseTimingHintFromUtterance(rawText) };
  }
  if (
    /^(cancel send later|cancel the scheduled send|don't send that later|unschedule that)\b/.test(
      normalized,
    )
  ) {
    return { kind: 'cancel_deferred' };
  }
  if (/^(remind me later|remind me instead)\b/.test(normalized)) {
    return {
      kind: 'remind_instead',
      timingHint: parseTimingHintFromUtterance(rawText),
    };
  }
  if (
    /^(keep (?:it|that)(?: as)? (?:a )?draft|keep as draft|leave it as draft)$/.test(
      normalized,
    )
  ) {
    return { kind: 'keep_draft' };
  }
  if (
    /^(save that|save this|save under (?:the )?thread|save it under (?:the )?thread)$/.test(
      normalized,
    )
  ) {
    return { kind: 'save_to_thread' };
  }
  if (/^(shorter|make it shorter)$/.test(normalized)) {
    return { kind: 'rewrite', style: 'shorter' };
  }
  if (
    /^(?:make (?:it|that)(?: a little)? warmer|warmer|make (?:it|that) less stiff|less stiff)$/.test(
      normalized,
    )
  ) {
    return { kind: 'rewrite', style: 'warmer' };
  }
  if (
    /^(?:more direct|make (?:it|that) more direct|more blunt|make (?:it|that) more blunt)$/.test(
      normalized,
    )
  ) {
    return { kind: 'rewrite', style: 'more_direct' };
  }
  if (/^(skip that|not now)$/.test(normalized)) {
    return { kind: 'skip' };
  }
  if (/^why (?:does )?(?:this|that) need approval$/.test(normalized)) {
    return { kind: 'why' };
  }
  return null;
}

export function isBlueBubblesExplicitSendAlias(rawText: string): boolean {
  const normalized = normalizeMessageActionCommand(rawText).toLowerCase();
  return /^(send using blue bubbles|send (?:it|that|this)(?: reply)? using blue bubbles|send (?:it|that|this)(?: reply)? with blue bubbles)$/.test(
    normalized,
  );
}

export function parseExplicitBlueBubblesThreadSendIntent(
  rawText: string,
): BlueBubblesExplicitThreadSendIntent | null {
  const intent = parseAssistantMessageActionIntent(rawText);
  if (
    intent?.kind !== 'message_send' ||
    intent.mode !== 'execute' ||
    !intent.targetLabel ||
    !intent.content
  ) {
    return null;
  }
  return {
    targetLabel: intent.targetLabel,
    draftText: intent.content,
  };
}

export function resolveBlueBubblesThreadTargetByName(
  query: string,
):
  | { state: 'resolved'; target: ResolvedBlueBubblesThreadTarget }
  | { state: 'ambiguous'; matches: ResolvedBlueBubblesThreadTarget[] }
  | { state: 'missing' } {
  const normalizedQuery = normalizeBlueBubblesChatLookup(query);
  if (!normalizedQuery) return { state: 'missing' };
  const queryAddressKeys = blueBubblesRecipientAddressKeys(query);

  const candidates = getAllChats()
    .filter(
      (chat) => chat.channel === 'bluebubbles' || chat.jid.startsWith('bb:'),
    )
    .filter(
      (chat) =>
        canonicalizeBlueBubblesSelfThreadJid(chat.jid) !==
        getBlueBubblesCanonicalSelfThreadJid(),
    )
    .map((chat) => ({
      chatJid: chat.jid,
      displayName: buildBlueBubblesChatDisplayName({
        jid: chat.jid,
        name: chat.name,
      }),
      // The BlueBubbles chat GUID itself is authoritative when persisted
      // metadata is stale or missing: `+` is a group and `-` is direct.
      isGroup:
        Boolean(chat.is_group) || /^bb:[^;]+;\+;/.test(chat.jid.toLowerCase()),
      normalizedName: normalizeBlueBubblesChatLookup(
        buildBlueBubblesChatDisplayName({ jid: chat.jid, name: chat.name }),
      ),
      addressKeys: blueBubblesRecipientAddressKeys(
        blueBubblesDirectAddressFromJid(chat.jid),
      ),
      lastMessageTime: chat.last_message_time,
    }));

  const exactMatches = candidates.filter(
    (candidate) =>
      candidate.normalizedName === normalizedQuery ||
      candidate.chatJid.toLowerCase() === normalizedQuery ||
      (queryAddressKeys.length > 0 &&
        queryAddressKeys.some((key) => candidate.addressKeys.includes(key))),
  );
  if (exactMatches.length === 1) {
    const {
      normalizedName: _normalizedName,
      addressKeys: _addressKeys,
      lastMessageTime: _lastMessageTime,
      ...target
    } = exactMatches[0]!;
    return { state: 'resolved', target };
  }
  if (exactMatches.length > 1) {
    return {
      state: 'ambiguous',
      matches: exactMatches
        .sort(
          (left, right) =>
            Date.parse(right.lastMessageTime || '') -
            Date.parse(left.lastMessageTime || ''),
        )
        .slice(0, 3)
        .map(
          ({
            normalizedName: _normalizedName,
            addressKeys: _addressKeys,
            lastMessageTime: _lastMessageTime,
            ...target
          }) => target,
        ),
    };
  }

  const fuzzyMatches = candidates.filter(
    (candidate) =>
      candidate.normalizedName.includes(normalizedQuery) ||
      normalizedQuery.includes(candidate.normalizedName),
  );
  if (fuzzyMatches.length > 0) {
    return {
      state: 'ambiguous',
      matches: fuzzyMatches
        .sort(
          (left, right) =>
            Date.parse(right.lastMessageTime || '') -
            Date.parse(left.lastMessageTime || ''),
        )
        .slice(0, 3)
        .map(
          ({
            normalizedName: _normalizedName,
            addressKeys: _addressKeys,
            lastMessageTime: _lastMessageTime,
            ...target
          }) => target,
        ),
    };
  }

  return { state: 'missing' };
}

async function persistDeferredReminder(params: {
  action: MessageActionRecord;
  timingHint?: string | null;
  deps: MessageActionExecutionDeps;
  now: Date;
  reminderOnly: boolean;
}): Promise<{
  replyText: string;
  updatedAction: MessageActionRecord;
  applied: boolean;
}> {
  const { planned } = planMessageFollowupTiming({
    timingHint: params.timingHint,
    fallbackHint: 'tomorrow morning',
    reminderBody: 'Revisit this draft reply',
    groupFolder: params.action.groupFolder,
    chatJid: params.action.presentationChatJid || params.deps.chatJid,
    now: params.now,
  });
  if (!planned) {
    return {
      replyText: 'Andrea: I could not pin down the timing for that yet.',
      updatedAction: params.action,
      applied: false,
    };
  }
  const linkedRefs = {
    ...parseLinkedRefs(params.action),
    reminderTaskId: planned.task.id,
    messageActionId: params.action.messageActionId,
  };
  const mutation = updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sendStatus: 'deferred',
      followupAt: planned.task.next_run || null,
      scheduledTaskId: null,
      trustLevel: normalizeTrustLevelAfterQueue(params.action),
      approvedAt: params.reminderOnly ? null : params.action.approvedAt,
      lastActionKind: 'remind_instead',
      lastActionAt: params.now.toISOString(),
      linkedRefsJson: JSON.stringify(linkedRefs),
      lastUpdatedAt: params.now.toISOString(),
    },
  });
  if (!mutation.applied) {
    return {
      replyText: staleBlueBubblesMutationReply(
        mutation.action,
        params.reminderOnly ? 'set that reminder' : 'defer that message',
      ),
      updatedAction: mutation.action,
      applied: false,
    };
  }
  createTask(planned.task);
  pauseScheduledTask(params.action.scheduledTaskId);
  const updatedAction = mutation.action;
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'reminder',
    dueAt: planned.task.next_run || null,
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  syncOutcomeFromReminderTask(planned.task, {
    linkedRefs: {
      messageActionId: updatedAction.messageActionId,
      communicationThreadId: linkedRefs.communicationThreadId,
      threadId: linkedRefs.threadId,
      missionId: linkedRefs.missionId,
      chatJid: updatedAction.presentationChatJid || params.deps.chatJid,
      personName: linkedRefs.personName,
      delegationRuleId: linkedRefs.delegationRuleId,
      delegationMode: linkedRefs.delegationMode || null,
      delegationExplanation: linkedRefs.delegationExplanation || null,
    },
    summaryText: params.reminderOnly
      ? 'A reminder will bring this reply back into view later.'
      : 'This draft is saved to revisit before sending.',
    now: params.now,
  });
  const hint = formatWhenLabel(planned.task.next_run) || 'then';
  return {
    replyText: params.reminderOnly
      ? `Andrea: I kept the draft unsent and I'll remind you about it around ${hint}.`
      : `Andrea: I saved that to revisit before sending, and I'll bring it back around ${hint}.`,
    updatedAction,
    applied: true,
  };
}

function buildScheduledTask(params: {
  action: MessageActionRecord;
  dueAt: string;
  now: Date;
  deps: MessageActionExecutionDeps;
}): ScheduledTask {
  const linkedRefs = parseLinkedRefs(params.action);
  const personName =
    linkedRefs.personName ||
    clipText(params.action.sourceSummary, 48) ||
    'that thread';
  return {
    id: randomUUID(),
    group_folder: params.action.groupFolder,
    chat_jid: params.action.presentationChatJid || params.deps.chatJid,
    prompt: `Scheduled message send for ${personName}`,
    schedule_type: 'once',
    schedule_value: params.dueAt,
    context_mode: 'isolated',
    next_run: params.dueAt,
    status: 'active',
    created_at: params.now.toISOString(),
    last_run: null,
    last_result: null,
  };
}

async function createScheduledSend(params: {
  action: MessageActionRecord;
  timingHint?: string | null;
  deps: MessageActionExecutionDeps;
  now: Date;
}): Promise<{
  replyText: string;
  updatedAction: MessageActionRecord;
  applied: boolean;
}> {
  const { planned } = planMessageFollowupTiming({
    timingHint: params.timingHint,
    fallbackHint: 'today tonight',
    reminderBody: 'Send this draft later',
    groupFolder: params.action.groupFolder,
    chatJid: params.action.presentationChatJid || params.deps.chatJid,
    now: params.now,
  });
  if (!planned?.task.next_run) {
    return {
      replyText: 'Andrea: I could not pin down the timing for that yet.',
      updatedAction: params.action,
      applied: false,
    };
  }

  const scheduledTask = buildScheduledTask({
    action: params.action,
    dueAt: planned.task.next_run,
    now: params.now,
    deps: params.deps,
  });
  const linkedRefs = {
    ...parseLinkedRefs(params.action),
    messageActionId: params.action.messageActionId,
    reminderTaskId: undefined,
  };
  const mutation = updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sendStatus: 'deferred',
      followupAt: planned.task.next_run,
      scheduledTaskId: scheduledTask.id,
      requiresApproval: false,
      trustLevel: 'schedule_send',
      // The defer/schedule utterance is the authorization for this future
      // side effect. Do not carry an older approval across an owner stop.
      approvedAt: resolveOwnerAuthorizationAt(params.deps, params.now),
      lastActionKind: 'scheduled_send',
      lastActionAt: params.now.toISOString(),
      linkedRefsJson: JSON.stringify(linkedRefs),
      lastUpdatedAt: params.now.toISOString(),
    },
  });
  if (!mutation.applied) {
    return {
      replyText: staleBlueBubblesMutationReply(
        mutation.action,
        'schedule that message',
      ),
      updatedAction: mutation.action,
      applied: false,
    };
  }
  createTask(scheduledTask);
  pauseScheduledTask(params.action.scheduledTaskId);
  const updatedAction = mutation.action;
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'scheduled_send',
    dueAt: planned.task.next_run,
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  const whenLabel = formatWhenLabel(planned.task.next_run) || 'then';
  return {
    replyText: `Andrea: I queued that to send around ${whenLabel}.`,
    updatedAction,
    applied: true,
  };
}

function cancelScheduledSend(params: {
  action: MessageActionRecord;
  now: Date;
}): {
  replyText: string;
  updatedAction: MessageActionRecord;
  applied: boolean;
} {
  if (!isScheduledSendAction(params.action)) {
    return {
      replyText: 'Andrea: There is no queued send on that right now.',
      updatedAction: params.action,
      applied: false,
    };
  }
  const mutation = updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sendStatus: 'approved',
      followupAt: null,
      scheduledTaskId: null,
      requiresApproval: false,
      trustLevel: normalizeTrustLevelAfterQueue(params.action),
      approvedAt: params.action.approvedAt || params.now.toISOString(),
      lastActionKind: 'approved',
      lastActionAt: params.now.toISOString(),
      lastUpdatedAt: params.now.toISOString(),
    },
  });
  if (!mutation.applied) {
    return {
      replyText: staleBlueBubblesMutationReply(
        mutation.action,
        'cancel the scheduled send',
      ),
      updatedAction: mutation.action,
      applied: false,
    };
  }
  pauseScheduledTask(params.action.scheduledTaskId);
  const updatedAction = mutation.action;
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'failed',
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return {
    replyText:
      'Andrea: Okay, I canceled the scheduled send and kept the draft ready.',
    updatedAction,
    applied: true,
  };
}

function keepMessageAsDraft(params: {
  action: MessageActionRecord;
  now: Date;
}): {
  replyText: string;
  updatedAction: MessageActionRecord;
  applied: boolean;
} {
  const mutation = updateMessageActionFromSnapshot({
    action: params.action,
    updates: {
      sendStatus: 'drafted',
      followupAt: null,
      scheduledTaskId: null,
      requiresApproval: true,
      trustLevel: normalizeTrustLevelAfterQueue(params.action),
      approvedAt: null,
      lastActionKind: 'drafted',
      lastActionAt: params.now.toISOString(),
      lastUpdatedAt: params.now.toISOString(),
    },
  });
  if (!mutation.applied) {
    return {
      replyText: staleBlueBubblesMutationReply(
        mutation.action,
        'keep that stale version as a draft',
      ),
      updatedAction: mutation.action,
      applied: false,
    };
  }
  if (params.action.delegationRuleId) {
    recordDelegationRuleOverride(params.action.delegationRuleId, params.now);
  }
  pauseScheduledTask(params.action.scheduledTaskId);
  const updatedAction = mutation.action;
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'drafted',
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return {
    replyText:
      'Andrea: Okay, I kept it as a draft. It will not send unless you come back to it.',
    updatedAction,
    applied: true,
  };
}

function buildPersistedSentResult(
  action: MessageActionRecord,
  target: MessageTarget,
): SendExecutionResult {
  return {
    action,
    replyText: describeSendSuccess(action, target, {
      platformMessageId: action.platformMessageId || undefined,
    }),
    target,
    didSend: true,
  };
}

async function markFailedSend(params: {
  action: MessageActionRecord;
  deps: MessageActionExecutionDeps;
  now: Date;
  expectedBlueBubblesStatuses?: readonly MessageActionSendStatus[];
  expectedBlueBubblesLastUpdatedAt?: string;
  failureExplanationJson?: string;
}): Promise<SendExecutionResult> {
  const target = parseTarget(params.action);
  const expectedLastUpdatedAt =
    params.expectedBlueBubblesLastUpdatedAt || params.action.lastUpdatedAt;
  const updates = {
    sendStatus: 'failed',
    followupAt: null,
    scheduledTaskId: null,
    requiresApproval: false,
    trustLevel: normalizeTrustLevelAfterQueue(params.action),
    approvedAt: params.action.approvedAt || params.now.toISOString(),
    lastActionKind: 'failed',
    lastActionAt: params.now.toISOString(),
    ...(params.failureExplanationJson
      ? { explanationJson: params.failureExplanationJson }
      : {}),
    lastUpdatedAt:
      params.action.targetChannel === 'bluebubbles'
        ? nextMessageActionVersion(
            { lastUpdatedAt: expectedLastUpdatedAt },
            params.now.toISOString(),
          )
        : params.now.toISOString(),
  } as const;
  const applied =
    params.action.targetChannel === 'bluebubbles'
      ? updateMessageActionIfSendStatus(
          params.action.messageActionId,
          params.expectedBlueBubblesStatuses || [params.action.sendStatus],
          expectedLastUpdatedAt,
          updates,
        )
      : (updateMessageAction(params.action.messageActionId, updates), true);
  const updatedAction =
    getMessageAction(params.action.messageActionId) || params.action;
  if (!applied) {
    if (updatedAction.sendStatus === 'sent') {
      return buildPersistedSentResult(updatedAction, target);
    }
    syncOutcomeFromMessageActionRecord(updatedAction, params.now);
    return {
      action: updatedAction,
      replyText:
        updatedAction.sendStatus === 'delivery_unverified'
          ? 'Andrea: This BlueBubbles action remains inside its durable dispatch fence. I will not retry it without exact provider evidence.'
          : humanSendFailure(),
      target,
      didSend: false,
    };
  }
  pauseScheduledTask(params.action.scheduledTaskId);
  if (updatedAction.delegationRuleId) {
    recordDelegationRuleUsage({
      ruleId: updatedAction.delegationRuleId,
      autoApplied:
        updatedAction.delegationMode === 'auto_apply_when_safe' &&
        params.action.trustLevel === 'delegated_safe_send',
      outcomeStatus: 'failed',
      now: params.now,
    });
  }
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'failed',
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return {
    action: updatedAction,
    replyText: humanSendFailure(),
    target,
    didSend: false,
  };
}

async function markDeliveryUnverified(params: {
  action: MessageActionRecord;
  now: Date;
  error: ChannelDeliveryUnverifiedError;
  expectedBlueBubblesLastUpdatedAt?: string;
  dispatchExplanation?: MessageActionExplanation;
}): Promise<SendExecutionResult> {
  const target = parseTarget(params.action);
  const evidence = params.error.evidence;
  const currentAction =
    getMessageAction(params.action.messageActionId) || params.action;
  const currentExplanation =
    params.dispatchExplanation || parseExplanation(currentAction);
  const updates = {
    sendStatus: 'delivery_unverified',
    followupAt: null,
    scheduledTaskId: null,
    requiresApproval: false,
    trustLevel: 'never_automate',
    platformMessageId:
      evidence.confirmedReceiptIds[0] ||
      currentAction.platformMessageId ||
      null,
    lastActionKind: 'delivery_unverified',
    lastActionAt: params.now.toISOString(),
    explanationJson: JSON.stringify({
      ...currentExplanation,
      safetyReason:
        'Delivery could not be verified. Check the target conversation before considering a new message.',
      deliveryVerification: {
        ...evidence,
        retryPolicy: 'verify_before_resend',
      },
      dispatchAttempt: currentExplanation.dispatchAttempt
        ? {
            ...currentExplanation.dispatchAttempt,
            state: 'unverified',
            completedAt: params.now.toISOString(),
          }
        : undefined,
    }),
    lastUpdatedAt:
      params.action.targetChannel === 'bluebubbles'
        ? nextMessageActionVersion(
            {
              lastUpdatedAt:
                params.expectedBlueBubblesLastUpdatedAt ||
                currentAction.lastUpdatedAt,
            },
            params.now.toISOString(),
          )
        : params.now.toISOString(),
  } as const;
  const applied =
    params.action.targetChannel === 'bluebubbles'
      ? updateMessageActionIfSendStatus(
          params.action.messageActionId,
          ['delivery_unverified'],
          params.expectedBlueBubblesLastUpdatedAt ||
            currentAction.lastUpdatedAt,
          updates,
        )
      : (updateMessageAction(params.action.messageActionId, updates), true);
  const updatedAction =
    getMessageAction(params.action.messageActionId) || params.action;
  if (!applied && updatedAction.sendStatus === 'sent') {
    return buildPersistedSentResult(updatedAction, target);
  }
  if (applied || params.action.targetChannel !== 'bluebubbles') {
    pauseScheduledTask(params.action.scheduledTaskId);
  }
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return {
    action: updatedAction,
    replyText:
      'Andrea: I could not confirm whether all of that message arrived. I will not retry it because that could duplicate all or part of the message. Check the target conversation before deciding what to do next.',
    target,
    didSend: false,
  };
}

const inFlightMessageActionSends = new Map<
  string,
  Promise<SendExecutionResult>
>();

function discardStaleContextBoundMessageAction(input: {
  action: MessageActionRecord;
  target: MessageTarget;
  now: Date;
  detail: string;
}): SendExecutionResult {
  const mutation = updateMessageActionFromSnapshot({
    action: input.action,
    updates: {
      sendStatus: 'skipped',
      requiresApproval: false,
      approvedAt: null,
      followupAt: null,
      scheduledTaskId: null,
      lastActionKind: 'skipped',
      lastActionAt: input.now.toISOString(),
      lastUpdatedAt: input.now.toISOString(),
    },
  });
  const action = mutation.action;
  if (mutation.applied) {
    pauseScheduledTask(input.action.scheduledTaskId);
    syncOutcomeFromMessageActionRecord(action, input.now);
  }
  return {
    action,
    target: input.target,
    didSend: false,
    replyText: mutation.applied
      ? `Andrea: I discarded that stale context-bound draft and did not send it because ${input.detail}. Review the exact Messages thread again and create a fresh draft if a reply is still needed.`
      : staleBlueBubblesMutationReply(
          action,
          'discard that stale context-bound draft',
        ),
  };
}

async function executeSendOperationUnlocked(params: {
  action: MessageActionRecord;
  deps: MessageActionExecutionDeps;
  now: Date;
  hasExplicitUserApproval?: boolean;
  blueBubblesAuthorizationAt?: string;
}): Promise<SendExecutionResult> {
  const target = parseTarget(params.action);
  if (isGroupExternalMessageTarget(target)) {
    return {
      action: params.action,
      replyText: GROUP_DRAFT_ONLY_REPLY,
      target,
      didSend: false,
    };
  }
  if (
    params.action.targetChannel === 'bluebubbles' &&
    isMessagingOutboundPaused()
  ) {
    return {
      action: params.action,
      replyText:
        'Andrea: Outbound Messages sending is paused by the owner, so I did not send this draft.',
      target,
      didSend: false,
    };
  }
  const contextFreshness = await validateContextBoundMessageActionFreshness({
    action: params.action,
    target,
    deps: params.deps,
  });
  if (!contextFreshness.ok) {
    return discardStaleContextBoundMessageAction({
      action: params.action,
      target,
      now: params.now,
      detail: contextFreshness.detail,
    });
  }
  // Persisted approval/trust metadata is not authority to contact another
  // person. External delivery must arrive through a caller that just handled
  // a fresh owner approval (or the separately fenced scheduled-send runner).
  const hasDispatchAuthorization =
    target.kind === 'external_thread'
      ? Boolean(params.hasExplicitUserApproval)
      : Boolean(
          params.hasExplicitUserApproval ||
          params.action.approvedAt ||
          params.action.sendStatus === 'approved' ||
          params.action.trustLevel === 'schedule_send' ||
          params.action.trustLevel === 'delegated_safe_send',
        );
  const preflight = runActionPreflight({
    actionId: params.action.messageActionId,
    actionSummary: `send message to ${
      target.kind === 'external_thread'
        ? target.personName || params.action.sourceSummary || 'external thread'
        : 'self companion thread'
    }`,
    actionType: 'message_send',
    channel: params.action.targetChannel,
    hasExplicitUserApproval: hasDispatchAuthorization,
    approvedCapability:
      params.action.targetChannel === 'telegram'
        ? 'messages.send.telegram'
        : 'messages.send.bluebubbles',
    mainControlVerified: params.deps.channel === 'telegram',
    objectClear: true,
    requiredInfo: [
      { name: 'target chat', present: Boolean(target.chatJid) },
      { name: 'draft text', present: Boolean(params.action.draftText.trim()) },
    ],
  });
  if (preflight.verdict !== 'proceed') {
    const mutation = updateMessageActionFromSnapshot({
      action: params.action,
      updates: {
        sendStatus: 'drafted',
        followupAt: null,
        scheduledTaskId: null,
        requiresApproval: true,
        trustLevel: normalizeTrustLevelAfterQueue(params.action),
        approvedAt: null,
        lastActionKind: 'drafted',
        lastActionAt: params.now.toISOString(),
        lastUpdatedAt: params.now.toISOString(),
      },
    });
    const updatedAction = mutation.action;
    if (!mutation.applied) {
      return {
        action: updatedAction,
        replyText: staleBlueBubblesMutationReply(
          updatedAction,
          'rewrite its current state after preflight',
        ),
        target,
        didSend: false,
      };
    }
    pauseScheduledTask(params.action.scheduledTaskId);
    syncCommunicationThreadState({
      action: updatedAction,
      now: params.now,
      mode: 'drafted',
    });
    syncOutcomeFromMessageActionRecord(updatedAction, params.now);
    return {
      action: updatedAction,
      replyText: `Andrea: I kept that as a draft because the final action preflight returned ${preflight.verdict}: ${preflight.record.blockerSummary}`,
      target,
      didSend: false,
    };
  }
  const blueBubblesAuthorizationFence =
    params.action.targetChannel === 'bluebubbles'
      ? captureMessagingOutboundAuthorizationFence(
          params.blueBubblesAuthorizationAt || '',
        )
      : null;
  const sendOptions: SendMessageOptions =
    target.kind === 'external_thread'
      ? {
          threadId: target.threadId || undefined,
          replyToMessageId: target.replyToMessageId || undefined,
          suppressSenderLabel: true,
          blueBubblesCreateChatAddress:
            target.blueBubblesCreateChatAddress || undefined,
          idempotencyKey: params.action.messageActionId,
          blueBubblesAuthorizationAt:
            blueBubblesAuthorizationFence?.authorizationAt,
          blueBubblesPauseGeneration:
            blueBubblesAuthorizationFence?.pauseGeneration,
        }
      : {
          threadId: target.threadId || undefined,
          idempotencyKey: params.action.messageActionId,
          blueBubblesAuthorizationAt:
            blueBubblesAuthorizationFence?.authorizationAt,
          blueBubblesPauseGeneration:
            blueBubblesAuthorizationFence?.pauseGeneration,
        };
  const dispatchedDraftText = params.action.draftText;
  const dispatchedTargetConversationJson = params.action.targetConversationJson;
  let enteredExternalDispatchWindow = false;
  let claimedLastUpdatedAt: string | null = null;
  let dispatchExplanation: MessageActionExplanation | undefined;
  try {
    if (params.action.targetChannel === 'bluebubbles') {
      if (!isBlueBubblesDispatchableStatus(params.action.sendStatus)) {
        const currentAction =
          getMessageAction(params.action.messageActionId) || params.action;
        return {
          action: currentAction,
          replyText: staleBlueBubblesMutationReply(
            currentAction,
            'dispatch that stale action',
          ),
          target,
          didSend: false,
        };
      }
      dispatchExplanation = {
        ...parseExplanation(params.action),
        safetyReason:
          'BlueBubbles delivery entered its external side-effect window. Verify the target conversation before any replay.',
        deliveryVerification: {
          outcome: 'unknown',
          confirmedReceiptIds: [],
          confirmedReceiptCount: 0,
          retryPolicy: 'verify_before_resend',
        },
        dispatchAttempt: {
          state: 'dispatching',
          provider: params.action.targetChannel,
          idempotencyKey: params.action.messageActionId,
          targetChatJid: target.chatJid,
          startedAt: params.now.toISOString(),
        },
      };
      claimedLastUpdatedAt = nextMessageActionVersion(
        params.action,
        params.now.toISOString(),
      );
      const claimed = claimBlueBubblesMessageActionDispatch({
        messageActionId: params.action.messageActionId,
        expectedSendStatus: params.action.sendStatus,
        expectedLastUpdatedAt: params.action.lastUpdatedAt,
        approvedAt: params.action.approvedAt || params.now.toISOString(),
        explanationJson: JSON.stringify(dispatchExplanation),
        attemptedAt: params.now.toISOString(),
        claimedLastUpdatedAt,
      });
      if (!claimed) {
        const competingAction =
          getMessageAction(params.action.messageActionId) || params.action;
        if (
          competingAction.sendStatus === 'sent' &&
          competingAction.platformMessageId
        ) {
          return {
            action: competingAction,
            replyText: describeSendSuccess(competingAction, target, {
              platformMessageId: competingAction.platformMessageId,
            }),
            target,
            didSend: true,
          };
        }
        return {
          action: competingAction,
          replyText:
            competingAction.sendStatus === 'delivery_unverified'
              ? 'Andrea: This BlueBubbles action is already inside a durable dispatch fence. I will not issue a second provider POST or claim success until its exact receipt is reconciled.'
              : 'Andrea: I could not atomically acquire the BlueBubbles dispatch fence, so I did not issue a provider POST.',
          target,
          didSend: false,
        };
      }
      enteredExternalDispatchWindow = true;
      pauseScheduledTask(params.action.scheduledTaskId);
    } else {
      const currentAction =
        getMessageAction(params.action.messageActionId) || params.action;
      const terminalStatusChanged =
        currentAction.sendStatus === 'skipped' ||
        currentAction.sendStatus === 'delivery_unverified' ||
        (currentAction.sendStatus === 'sent' &&
          params.action.sendStatus !== 'sent');
      const snapshotChanged =
        currentAction.lastUpdatedAt !== params.action.lastUpdatedAt ||
        currentAction.sendStatus !== params.action.sendStatus ||
        !messageActionBodiesEqual(
          currentAction.draftText,
          params.action.draftText,
        ) ||
        currentAction.targetConversationJson !==
          params.action.targetConversationJson;
      if (terminalStatusChanged || snapshotChanged) {
        return {
          action: currentAction,
          replyText:
            currentAction.sendStatus === 'skipped'
              ? 'Andrea: That draft was discarded before dispatch, so I did not send it. Create and review a fresh draft if you still want to message them.'
              : 'Andrea: That message action changed before dispatch, so I did not send the stale recipient/body snapshot. Show or create a fresh draft and review it again.',
          target,
          didSend: false,
        };
      }
      pauseScheduledTask(params.action.scheduledTaskId);
    }
    const receipt = requireCompleteChannelDelivery(
      await params.deps.sendToTarget(
        params.action.targetChannel,
        target.chatJid,
        dispatchedDraftText,
        sendOptions,
      ),
    );
    if (
      target.kind === 'external_thread' &&
      target.blueBubblesCreateChatAddress &&
      !isBlueBubblesDirectChatJidForAddress(
        receipt.threadId,
        target.blueBubblesCreateChatAddress,
      )
    ) {
      const confirmedReceiptIds = Array.from(
        new Set(
          [
            receipt.platformMessageId,
            ...(receipt.platformMessageIds || []),
          ].filter((value): value is string => Boolean(value)),
        ),
      );
      throw new ChannelDeliveryUnverifiedError({
        outcome: 'unknown',
        confirmedReceiptIds,
        confirmedReceiptCount: confirmedReceiptIds.length,
      });
    }
    const receiptIds = Array.from(
      new Set(
        [
          receipt.platformMessageId,
          ...(receipt.platformMessageIds || []),
        ].filter((value): value is string => Boolean(value)),
      ),
    );
    const explanationBeforeReceipt =
      dispatchExplanation || parseExplanation(params.action);
    const recipient =
      target.kind === 'external_thread'
        ? target.personName || target.chatJid
        : 'your companion chat';
    const sentUpdates = {
      sendStatus: 'sent',
      requiresApproval: false,
      followupAt: null,
      scheduledTaskId: null,
      trustLevel: normalizeTrustLevelAfterQueue(params.action),
      approvedAt: params.action.approvedAt || params.now.toISOString(),
      platformMessageId:
        receipt.platformMessageId || receipt.platformMessageIds?.[0] || null,
      explanationJson: JSON.stringify({
        ...explanationBeforeReceipt,
        safetyReason: null,
        deliveryVerification: undefined,
        dispatchAttempt: {
          state: 'confirmed',
          provider: params.action.targetChannel,
          idempotencyKey: params.action.messageActionId,
          targetChatJid: receipt.threadId || target.chatJid,
          startedAt:
            explanationBeforeReceipt.dispatchAttempt?.startedAt ||
            params.now.toISOString(),
          completedAt: params.now.toISOString(),
        },
        executionReceipt: {
          verification: 'verified',
          provider: params.action.targetChannel,
          providerReceiptId: receiptIds[0]!,
          providerReceiptIds: receiptIds,
          recipient,
          exactContent: dispatchedDraftText,
          threadId: receipt.threadId || target.chatJid,
          recordedAt: params.now.toISOString(),
          idempotencyKey: params.action.messageActionId,
        },
      }),
      targetConversationJson:
        target.kind === 'external_thread' &&
        target.blueBubblesCreateChatAddress &&
        isBlueBubblesDirectChatJidForAddress(
          receipt.threadId,
          target.blueBubblesCreateChatAddress,
        )
          ? JSON.stringify({
              ...target,
              chatJid: receipt.threadId,
              threadId: null,
              blueBubblesCreateChatAddress: null,
            } satisfies ExternalThreadTarget)
          : dispatchedTargetConversationJson,
      sentAt: params.now.toISOString(),
      lastActionKind: 'sent',
      lastActionAt: params.now.toISOString(),
      lastUpdatedAt:
        params.action.targetChannel === 'bluebubbles' && claimedLastUpdatedAt
          ? nextMessageActionVersion(
              { lastUpdatedAt: claimedLastUpdatedAt },
              params.now.toISOString(),
            )
          : params.now.toISOString(),
    } as const;
    let transitioned = true;
    if (params.action.targetChannel === 'bluebubbles') {
      transitioned = Boolean(
        claimedLastUpdatedAt &&
        updateMessageActionIfSendStatus(
          params.action.messageActionId,
          ['delivery_unverified'],
          claimedLastUpdatedAt,
          sentUpdates,
        ),
      );
    } else {
      updateMessageAction(params.action.messageActionId, sentUpdates);
    }
    const updatedAction =
      getMessageAction(params.action.messageActionId) || params.action;
    if (!transitioned && updatedAction.sendStatus !== 'sent') {
      syncOutcomeFromMessageActionRecord(updatedAction, params.now);
      return {
        action: updatedAction,
        replyText:
          updatedAction.sendStatus === 'delivery_unverified'
            ? 'Andrea: The provider returned a receipt, but the durable dispatch snapshot changed before I could record it. I left delivery unverified and will not retry this action.'
            : staleBlueBubblesMutationReply(
                updatedAction,
                'record a success from the stale dispatch callback',
              ),
        target,
        didSend: false,
      };
    }
    if (updatedAction.delegationRuleId) {
      recordDelegationRuleUsage({
        ruleId: updatedAction.delegationRuleId,
        autoApplied:
          updatedAction.delegationMode === 'auto_apply_when_safe' &&
          params.action.trustLevel === 'delegated_safe_send',
        outcomeStatus: 'completed',
        now: params.now,
      });
    }
    syncCommunicationThreadState({
      action: updatedAction,
      now: params.now,
      mode: 'sent',
      platformMessageId:
        receipt.platformMessageId || receipt.platformMessageIds?.[0] || null,
    });
    syncOutcomeFromMessageActionRecord(updatedAction, params.now);
    return {
      action: updatedAction,
      replyText: describeSendSuccess(
        { ...updatedAction, draftText: dispatchedDraftText },
        target,
        receipt,
      ),
      target,
      didSend: true,
    };
  } catch (error) {
    if (
      enteredExternalDispatchWindow &&
      params.action.targetChannel === 'bluebubbles'
    ) {
      if (isChannelDeliveryRejectedBeforeDispatchError(error)) {
        const explanation =
          dispatchExplanation || parseExplanation(params.action);
        return markFailedSend({
          action: params.action,
          deps: params.deps,
          now: params.now,
          expectedBlueBubblesStatuses: ['delivery_unverified'],
          expectedBlueBubblesLastUpdatedAt:
            claimedLastUpdatedAt || params.action.lastUpdatedAt,
          failureExplanationJson: JSON.stringify({
            ...explanation,
            safetyReason: error.message,
            deliveryVerification: undefined,
            dispatchAttempt: explanation.dispatchAttempt
              ? {
                  ...explanation.dispatchAttempt,
                  state: 'rejected',
                  completedAt: params.now.toISOString(),
                }
              : undefined,
          }),
        });
      }
      return markDeliveryUnverified({
        action: params.action,
        now: params.now,
        error: isChannelDeliveryUnverifiedError(error)
          ? error
          : new ChannelDeliveryUnverifiedError({
              outcome: 'unknown',
              confirmedReceiptIds: [],
              confirmedReceiptCount: 0,
            }),
        expectedBlueBubblesLastUpdatedAt:
          claimedLastUpdatedAt || params.action.lastUpdatedAt,
        dispatchExplanation,
      });
    }
    if (isChannelDeliveryRejectedBeforeDispatchError(error)) {
      const explanation = parseExplanation(params.action);
      return markFailedSend({
        action: params.action,
        deps: params.deps,
        now: params.now,
        expectedBlueBubblesStatuses:
          params.action.targetChannel === 'bluebubbles'
            ? [params.action.sendStatus]
            : undefined,
        expectedBlueBubblesLastUpdatedAt: params.action.lastUpdatedAt,
        failureExplanationJson: JSON.stringify({
          ...explanation,
          safetyReason: error.message,
          deliveryVerification: undefined,
          dispatchAttempt: explanation.dispatchAttempt
            ? {
                ...explanation.dispatchAttempt,
                state: 'rejected',
                completedAt: params.now.toISOString(),
              }
            : undefined,
        }),
      });
    }
    if (isChannelDeliveryUnverifiedError(error)) {
      return markDeliveryUnverified({
        action: params.action,
        now: params.now,
        error,
      });
    }
    return markFailedSend(params);
  }
}

async function executeSendOperation(params: {
  action: MessageActionRecord;
  deps: MessageActionExecutionDeps;
  now: Date;
  hasExplicitUserApproval?: boolean;
  blueBubblesAuthorizationAt?: string;
}): Promise<SendExecutionResult> {
  const existing = inFlightMessageActionSends.get(
    params.action.messageActionId,
  );
  if (existing) {
    const result = await existing;
    notifyVerifiedSend(params.deps, result.action);
    return result;
  }

  const execution = executeSendOperationUnlocked(params);
  inFlightMessageActionSends.set(params.action.messageActionId, execution);
  try {
    const result = await execution;
    notifyVerifiedSend(params.deps, result.action);
    return result;
  } finally {
    if (
      inFlightMessageActionSends.get(params.action.messageActionId) ===
      execution
    ) {
      inFlightMessageActionSends.delete(params.action.messageActionId);
    }
  }
}

/**
 * Executes a recipient-bound action when the current trusted owner utterance
 * itself is the confirmation required by the capability contract. This path
 * intentionally does not require a prior draft-card presentation receipt.
 */
export async function executeExplicitlyAuthorizedMessageAction(
  messageActionId: string,
  deps: MessageActionExecutionDeps,
): Promise<ApplyMessageActionOperationResult> {
  const inFlight = inFlightMessageActionSends.get(messageActionId);
  if (inFlight) {
    const executed = await inFlight;
    return {
      handled: true,
      action: executed.action,
      replyText: executed.replyText,
    };
  }
  const action = getMessageAction(messageActionId);
  if (!action) return { handled: false };
  const now = deps.currentTime || new Date();
  const target = parseTarget(action);
  if (action.sendStatus === 'skipped') {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: That draft was discarded, so I did not revive or send it. Create a fresh message action and review the exact recipient and text first.',
    };
  }
  if (action.sendStatus === 'delivery_unverified') {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: The prior BlueBubbles attempt is still unverified. I will not resend it or claim success until the exact provider outcome is reconciled.',
    };
  }
  if (action.sendStatus === 'sent') {
    if (!action.platformMessageId) {
      return {
        handled: true,
        action,
        replyText:
          'Andrea: The action is recorded as sent, but its provider receipt is missing. I will not resend it or make a fresh success claim.',
      };
    }
    notifyVerifiedSend(deps, action);
    return {
      handled: true,
      action,
      replyText: describeSendSuccess(action, target, {
        platformMessageId: action.platformMessageId,
      }),
    };
  }
  if (
    action.sendStatus === 'failed' &&
    action.sourceKey.includes(':inbound:')
  ) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: That exact inbound request previously failed before dispatch. I did not replay it automatically; send a fresh instruction if you want a new attempt.',
    };
  }
  const contextValidation = validateMessageActionFollowupContext({
    action,
    now,
    ownerAuthorizationAt: deps.ownerAuthorizationAt,
  });
  if (!contextValidation.ok) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: This owner authorization is too old to dispatch that message action. I kept it unsent; create a fresh action and review the exact recipient and text first.',
    };
  }
  if (
    action.targetChannel !== 'bluebubbles' &&
    (!action.approvedAt || action.sendStatus !== 'approved')
  ) {
    updateMessageAction(action.messageActionId, {
      sendStatus: 'approved',
      requiresApproval: false,
      approvedAt: now.toISOString(),
      lastActionKind: 'approved',
      lastActionAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    });
  }
  // For BlueBubbles the explicit owner utterance is carried directly into the
  // dispatch claim. Writing `approved` first would let a stale process
  // overwrite a newer fence before it attempted the real CAS.
  const approvedAction =
    action.targetChannel === 'bluebubbles'
      ? action
      : getMessageAction(action.messageActionId) || action;
  const executed = await executeSendOperation({
    action: approvedAction,
    deps,
    now,
    hasExplicitUserApproval: true,
    blueBubblesAuthorizationAt: resolveOwnerAuthorizationAt(deps, now),
  });
  return {
    handled: true,
    action: executed.action,
    replyText: executed.replyText,
  };
}

export interface BlueBubblesDeliveryReconciliationResult {
  inspected: number;
  reconciled: number;
  stillUnverified: number;
}

/**
 * Reconciles crash/timeout fences only from one action-correlated outbound
 * provider row: the stable BlueBubbles tempGuid or a receipt captured from the
 * original POST must match in addition to chat, bytes, authorship, and time.
 * First-contact sends use the tempGuid to find the provider-created direct chat
 * and safely replace their provisional target. Zero or multiple correlated
 * matches remain unverified. This function never dispatches or retries a
 * message.
 */
export function reconcileBlueBubblesUnverifiedMessageActions(params: {
  groupFolder: string;
  now?: Date;
  dispatchWindowMs?: number;
}): BlueBubblesDeliveryReconciliationResult {
  const recoveryContract = runtimeCapabilityRegistry.get(
    'messages.send.bluebubbles',
  );
  if (
    !recoveryContract?.idempotency.required ||
    recoveryContract.idempotency.strategy !== 'stable_action_key' ||
    !recoveryContract.receipt.required
  ) {
    return { inspected: 0, reconciled: 0, stillUnverified: 0 };
  }
  const now = params.now || new Date();
  const dispatchWindowMs = Math.max(
    30_000,
    Math.min(params.dispatchWindowMs || 10 * 60_000, 30 * 60_000),
  );
  const actions = listMessageActionsForGroup({
    groupFolder: params.groupFolder,
    statuses: ['delivery_unverified'],
    targetChannels: ['bluebubbles'],
    limit: 200,
  });
  let reconciled = 0;

  for (const action of actions) {
    const explanation = parseExplanation(action);
    const attempt = explanation.dispatchAttempt;
    const target = parseTarget(action);
    const dispatchStartedAt = Date.parse(attempt?.startedAt || '');
    if (
      !attempt ||
      attempt.idempotencyKey !== action.messageActionId ||
      !Number.isFinite(dispatchStartedAt) ||
      !target.chatJid
    ) {
      continue;
    }
    const normalizedBody = action.draftText.replace(/\r\n/g, '\n');
    const providerReceiptIds = new Set(
      explanation.deliveryVerification?.confirmedReceiptIds || [],
    );
    const isFirstContact =
      target.kind === 'external_thread' &&
      Boolean(target.blueBubblesCreateChatAddress?.trim());
    const candidates = isFirstContact
      ? listMessagesByProviderIdempotencyKey(action.messageActionId, 100)
      : listRecentMessagesForChat(target.chatJid, 100);
    const matches = candidates.filter((message) => {
      const observedAt = Date.parse(message.timestamp || '');
      const hasStableActionKey =
        message.provider_idempotency_key === action.messageActionId;
      const actionCorrelated = isFirstContact
        ? hasStableActionKey
        : hasStableActionKey || providerReceiptIds.has(message.id);
      return (
        actionCorrelated &&
        (!isFirstContact ||
          (target.kind === 'external_thread' &&
            isBlueBubblesDirectChatJidForAddress(
              message.chat_jid,
              target.blueBubblesCreateChatAddress,
            ))) &&
        Boolean(message.is_from_me) &&
        Boolean(message.id) &&
        message.content.replace(/\r\n/g, '\n') === normalizedBody &&
        Number.isFinite(observedAt) &&
        observedAt >= dispatchStartedAt - 5_000 &&
        observedAt <= dispatchStartedAt + dispatchWindowMs
      );
    });
    if (matches.length !== 1) continue;

    const match = matches[0]!;
    const reconciledTarget: MessageTarget =
      isFirstContact && target.kind === 'external_thread'
        ? {
            ...target,
            chatJid: match.chat_jid,
            threadId: null,
            replyToMessageId: null,
            blueBubblesCreateChatAddress: null,
          }
        : target;
    const recipient =
      target.kind === 'external_thread'
        ? target.personName || target.chatJid
        : 'your companion chat';
    const transitioned = updateMessageActionIfSendStatus(
      action.messageActionId,
      ['delivery_unverified'],
      action.lastUpdatedAt,
      {
        targetConversationJson: JSON.stringify(reconciledTarget),
        sendStatus: 'sent',
        requiresApproval: false,
        trustLevel: normalizeTrustLevelAfterQueue(action),
        platformMessageId: match.id,
        sentAt: match.timestamp,
        lastActionKind: 'sent',
        lastActionAt: now.toISOString(),
        explanationJson: JSON.stringify({
          ...explanation,
          safetyReason: null,
          deliveryVerification: undefined,
          dispatchAttempt: {
            ...attempt,
            state: 'confirmed',
            completedAt: now.toISOString(),
          },
          executionReceipt: {
            verification: 'verified',
            provider: 'bluebubbles',
            providerReceiptId: match.id,
            providerReceiptIds: [match.id],
            recipient,
            exactContent: action.draftText,
            threadId: reconciledTarget.chatJid,
            recordedAt: now.toISOString(),
            idempotencyKey: action.messageActionId,
          },
        }),
        lastUpdatedAt: nextMessageActionVersion(action, now.toISOString()),
      },
    );
    if (!transitioned) continue;
    const updated = getMessageAction(action.messageActionId) || action;
    syncCommunicationThreadState({
      action: updated,
      now,
      mode: 'sent',
      platformMessageId: match.id,
    });
    syncOutcomeFromMessageActionRecord(updated, now);
    reconciled += 1;
  }

  return {
    inspected: actions.length,
    reconciled,
    stillUnverified: actions.length - reconciled,
  };
}

export async function runScheduledMessageActionByTaskId(
  scheduledTaskId: string,
  deps: MessageActionExecutionDeps,
): Promise<{
  handled: boolean;
  resultSummary: string;
  notificationChatJid?: string | null;
  notificationText?: string | null;
  action?: MessageActionRecord;
}> {
  const action = getMessageActionByScheduledTaskId(scheduledTaskId);
  if (!action) {
    return {
      handled: false,
      resultSummary: 'No linked scheduled message action was found.',
    };
  }
  const now = deps.currentTime || new Date();
  if (
    action.sendStatus !== 'deferred' ||
    action.scheduledTaskId !== scheduledTaskId ||
    !isScheduledSendAction(action)
  ) {
    return {
      handled: true,
      action,
      resultSummary: 'Scheduled message no longer needed to send.',
    };
  }

  const eligibility = validateScheduledSendEligibility(action);
  if (!eligibility.ok) {
    const failed = await markFailedSend({
      action,
      deps,
      now,
    });
    return {
      handled: true,
      action: failed.action,
      resultSummary: `Scheduled message blocked: ${
        eligibility.reason || 'unsafe to send now'
      }`,
      notificationChatJid:
        failed.action.presentationChatJid &&
        failed.action.presentationChatJid !== eligibility.target.chatJid
          ? failed.action.presentationChatJid
          : null,
      notificationText:
        failed.action.presentationChatJid &&
        failed.action.presentationChatJid !== eligibility.target.chatJid
          ? failed.replyText
          : null,
    };
  }

  const executed = await executeSendOperation({
    action,
    deps,
    now,
    hasExplicitUserApproval: true,
    blueBubblesAuthorizationAt: action.approvedAt || '',
  });
  return {
    handled: true,
    action: executed.action,
    resultSummary: executed.didSend
      ? `Sent scheduled message${
          eligibility.target.kind === 'external_thread' &&
          eligibility.target.personName
            ? ` to ${eligibility.target.personName}`
            : ''
        }.`
      : executed.action.sendStatus === 'delivery_unverified'
        ? 'Scheduled message delivery could not be verified; automatic retry is blocked.'
        : 'Scheduled message send failed.',
    notificationChatJid:
      executed.action.presentationChatJid &&
      executed.action.presentationChatJid !== eligibility.target.chatJid
        ? executed.action.presentationChatJid
        : null,
    notificationText:
      executed.action.presentationChatJid &&
      executed.action.presentationChatJid !== eligibility.target.chatJid
        ? executed.replyText
        : null,
  };
}

export async function applyMessageActionOperation(
  messageActionId: string,
  operation: MessageActionOperation,
  deps: MessageActionExecutionDeps,
): Promise<ApplyMessageActionOperationResult> {
  const action = getMessageAction(messageActionId);
  if (!action) return { handled: false };
  const now = deps.currentTime || new Date();
  if (
    action.sendStatus === 'skipped' &&
    operation.kind !== 'show' &&
    operation.kind !== 'show_draft' &&
    operation.kind !== 'why'
  ) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: That draft was discarded, so this old control cannot change, schedule, or send it. Create a fresh draft, review the exact recipient and message, then approve the new card.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }
  const requiresFreshFollowupContext =
    operation.kind !== 'show' &&
    operation.kind !== 'show_draft' &&
    operation.kind !== 'why' &&
    operation.kind !== 'skip' &&
    operation.kind !== 'cancel_deferred' &&
    !(
      action.sendStatus === 'sent' &&
      (operation.kind === 'send' || operation.kind === 'rewrite_and_send')
    );
  if (requiresFreshFollowupContext) {
    const contextValidation = validateMessageActionFollowupContext({
      action,
      now,
      ownerAuthorizationAt: deps.ownerAuthorizationAt,
    });
    if (!contextValidation.ok) {
      return {
        handled: true,
        action,
        replyText:
          'Andrea: This draft card or follow-up context is too old to authorize changing, sending, or scheduling this action. I kept it unsent. Create or show a fresh draft, review the exact recipient and message, then use the new card.',
      };
    }
  }
  if (
    action.targetChannel === 'bluebubbles' &&
    operation.kind === 'send_again'
  ) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: I will not resend from or reuse this BlueBubbles action or its idempotency key; create a new draft as a fresh message action if you want to send another message.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }
  if (
    operation.kind === 'send' ||
    operation.kind === 'send_again' ||
    operation.kind === 'rewrite_and_send'
  ) {
    // A replayed inbound platform event must observe the durable fence instead
    // of waiting on process-local state. Ordinary simultaneous UI approvals
    // can still share the same in-flight promise below.
    if (
      action.sendStatus === 'delivery_unverified' &&
      action.sourceKey.includes(':inbound:')
    ) {
      return {
        handled: true,
        action,
        replyText:
          'Andrea: Delivery is still unverified, so I will not resend, rewrite-and-send, defer, or relabel this attempt. Check the target conversation first; if another message is needed after that, create a new draft.',
        presentation: buildMessageActionPresentation(
          action,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
    const inFlight = inFlightMessageActionSends.get(messageActionId);
    if (inFlight) {
      const executed = await inFlight;
      return {
        handled: true,
        action: executed.action,
        replyText: executed.replyText,
      };
    }
  }
  if (
    isBlueBubblesProofDrillAction(action) &&
    (operation.kind === 'send' ||
      operation.kind === 'send_again' ||
      operation.kind === 'rewrite_and_send')
  ) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: I will not send the BlueBubbles proof drill immediately. Use `send it later tonight` to record the safe deferred proof decision.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }
  if (
    isGroupExternalMessageAction(action) &&
    (operation.kind === 'send' ||
      operation.kind === 'send_again' ||
      operation.kind === 'rewrite_and_send' ||
      operation.kind === 'defer')
  ) {
    return {
      handled: true,
      action,
      replyText: GROUP_DRAFT_ONLY_REPLY,
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'show' || operation.kind === 'show_draft') {
    return {
      handled: true,
      action,
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'why') {
    const explanation = parseExplanation(action);
    return {
      handled: true,
      action,
      replyText:
        explanation.approvalReason ||
        explanation.safetyReason ||
        'Andrea: I still want your approval before sending that.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  const requiresConfirmedOutboundPresentation =
    action.targetKind === 'external_thread' &&
    !normalizeText(action.presentationMessageId) &&
    (operation.kind === 'send' ||
      operation.kind === 'send_again' ||
      operation.kind === 'rewrite_and_send' ||
      operation.kind === 'defer');
  if (requiresConfirmedOutboundPresentation) {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: I could not verify that the recipient-bound draft card reached this private owner chat, so I did not send or schedule it. Show the draft again, review the exact recipient and message, then approve it.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (action.sendStatus === 'delivery_unverified') {
    return {
      handled: true,
      action,
      replyText:
        'Andrea: Delivery is still unverified, so I will not resend, rewrite-and-send, defer, or relabel this attempt. Check the target conversation first; if another message is needed after that, create a new draft.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'rewrite') {
    if (action.sendStatus === 'sent') {
      return {
        handled: true,
        action,
        replyText:
          'Andrea: That one already went out. Ask me to draft a new version if you want to send another reply.',
      };
    }
    // Fence the old presentation and any scheduled delivery synchronously,
    // before the model rewrite can yield. A Send tap on the stale card must be
    // rejected for the entire rewrite window, not only after new text exists.
    const fence = updateMessageActionFromSnapshot({
      action,
      updates: {
        sendStatus: 'drafted',
        requiresApproval: true,
        followupAt: null,
        scheduledTaskId: null,
        presentationMessageId: null,
        presentationThreadId: null,
        trustLevel: normalizeTrustLevelAfterQueue(action),
        approvedAt: null,
        lastActionKind: 'rewrite',
        lastActionAt: now.toISOString(),
        lastUpdatedAt: now.toISOString(),
      },
    });
    if (!fence.applied) {
      return {
        handled: true,
        action: fence.action,
        presentation: buildMessageActionPresentation(
          fence.action,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
        replyText: staleBlueBubblesMutationReply(
          fence.action,
          'rewrite that stale draft',
        ),
      };
    }
    pauseScheduledTask(action.scheduledTaskId);
    const rewriteBase = fence.action;
    const linkedRefs = parseLinkedRefs(rewriteBase);
    const modelRewrite =
      deps.channel === 'bluebubbles'
        ? await rewriteBlueBubblesMessageDraft({
            draftText: rewriteBase.draftText,
            style: operation.style,
            personName: linkedRefs.personName || null,
          })
        : null;
    const mutation = updateMessageActionFromSnapshot({
      action: rewriteBase,
      updates: {
        draftText:
          modelRewrite?.draftText ||
          rewriteDraft(rewriteBase.draftText, operation.style),
        explanationJson: JSON.stringify({
          ...parseExplanation(rewriteBase),
          draftProvenance: 'assistant_authored',
        }),
        lastActionAt: now.toISOString(),
        lastUpdatedAt: now.toISOString(),
      },
    });
    const updatedAction = mutation.action;
    if (!mutation.applied) {
      return {
        handled: true,
        action: updatedAction,
        presentation: buildMessageActionPresentation(
          updatedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
        replyText: staleBlueBubblesMutationReply(
          updatedAction,
          'rewrite that stale draft',
        ),
      };
    }
    syncCommunicationThreadState({
      action: updatedAction,
      now,
      mode: 'failed',
    });
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    return {
      handled: true,
      action: updatedAction,
      presentation: buildMessageActionPresentation(
        updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
      replyText: modelRewrite?.draftText
        ? operation.style === 'shorter'
          ? 'Andrea: I tightened it up.'
          : operation.style === 'warmer'
            ? 'Andrea: I made it warmer.'
            : 'Andrea: I made it more direct.'
        : modelRewrite?.fallbackNote ||
          (operation.style === 'shorter'
            ? 'Andrea: I tightened it up.'
            : operation.style === 'warmer'
              ? 'Andrea: I made it warmer.'
              : 'Andrea: I made it more direct.'),
    };
  }

  if (operation.kind === 'rewrite_and_send') {
    const rewritten = await applyMessageActionOperation(
      action.messageActionId,
      { kind: 'rewrite', style: operation.style },
      deps,
    );
    if (!rewritten.handled) {
      return rewritten;
    }
    const refreshed = getMessageAction(action.messageActionId);
    if (
      !refreshed ||
      refreshed.sendStatus !== 'drafted' ||
      !refreshed.requiresApproval ||
      refreshed.lastActionKind !== 'rewrite'
    ) {
      return rewritten;
    }
    return {
      handled: true,
      action: refreshed,
      presentation: buildMessageActionPresentation(
        refreshed,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
      replyText: `${rewritten.replyText || 'Andrea: I rewrote the draft.'}\n\nAndrea: I kept the changed draft unsent. Review the new draft card and approve it separately if you still want to send it.`,
    };
  }

  if (operation.kind === 'skip') {
    const mutation = updateMessageActionFromSnapshot({
      action,
      updates: {
        sendStatus: 'skipped',
        followupAt: null,
        scheduledTaskId: null,
        trustLevel: normalizeTrustLevelAfterQueue(action),
        lastActionKind: 'skipped',
        lastActionAt: now.toISOString(),
        lastUpdatedAt: now.toISOString(),
      },
    });
    const updatedAction = mutation.action;
    if (!mutation.applied) {
      return {
        handled: true,
        action: updatedAction,
        replyText: staleBlueBubblesMutationReply(
          updatedAction,
          'skip that stale action',
        ),
        presentation: buildMessageActionPresentation(
          updatedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    pauseScheduledTask(action.scheduledTaskId);
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    const reviewedAction = recordMessageActionOwnerDecision({
      action: updatedAction,
      verdict: 'rejected',
      decisionKind: 'skip',
      now,
    });
    return {
      handled: true,
      action: reviewedAction,
      replyText: 'Andrea: Okay, I left that unsent.',
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'cancel_deferred') {
    const cancelled = cancelScheduledSend({ action, now });
    const reviewedAction = cancelled.applied
      ? recordMessageActionOwnerDecision({
          action: cancelled.updatedAction,
          verdict: 'rejected',
          decisionKind: 'cancel_deferred',
          now,
        })
      : cancelled.updatedAction;
    return {
      handled: true,
      action: reviewedAction,
      replyText: cancelled.replyText,
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'keep_draft') {
    const kept = keepMessageAsDraft({
      action,
      now,
    });
    const reviewedAction = kept.applied
      ? recordMessageActionOwnerDecision({
          action: kept.updatedAction,
          verdict: 'accepted',
          decisionKind: 'keep_draft',
          now,
        })
      : kept.updatedAction;
    return {
      handled: true,
      action: reviewedAction,
      replyText: kept.replyText,
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'save_to_thread') {
    const result = handleLifeThreadCommand({
      groupFolder: action.groupFolder,
      channel: deps.channel,
      chatJid: deps.chatJid,
      text: 'save this for later',
      replyText: action.draftText,
      conversationSummary: action.sourceSummary || 'Draft follow-through',
      now,
    });
    if (!result.handled) {
      return { handled: false };
    }
    const existingLinkedRefs = parseLinkedRefs(action);
    const nextLinkedRefs = {
      ...existingLinkedRefs,
      threadId:
        result.referencedThread?.id || existingLinkedRefs.threadId || undefined,
    };
    const mutation = updateMessageActionFromSnapshot({
      action,
      updates: {
        sendStatus: 'deferred',
        followupAt: null,
        scheduledTaskId: null,
        requiresApproval: false,
        trustLevel: normalizeTrustLevelAfterQueue(action),
        approvedAt: null,
        lastActionKind: 'save_to_thread',
        lastActionAt: now.toISOString(),
        linkedRefsJson: JSON.stringify(nextLinkedRefs),
        lastUpdatedAt: now.toISOString(),
      },
    });
    const updatedAction = mutation.action;
    if (!mutation.applied) {
      return {
        handled: true,
        action: updatedAction,
        replyText: staleBlueBubblesMutationReply(
          updatedAction,
          'save that stale message action under the thread',
        ),
        presentation: buildMessageActionPresentation(
          updatedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    syncCommunicationThreadState({
      action: updatedAction,
      now,
      mode: 'thread_saved',
    });
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    const reviewedAction = recordMessageActionOwnerDecision({
      action: updatedAction,
      verdict: 'accepted',
      decisionKind: 'save_to_thread',
      now,
    });
    return {
      handled: Boolean(result.handled),
      action: reviewedAction,
      replyText:
        result.responseText ||
        'Andrea: I saved that under the thread. The message is still unsent.',
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'defer') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    if (isBlueBubblesProofDrillAction(action)) {
      const deferredProof = recordBlueBubblesProofDrillDeferredDecision({
        action,
        now,
      });
      const reviewedAction = deferredProof.applied
        ? recordMessageActionOwnerDecision({
            action: deferredProof.action,
            verdict: 'accepted',
            decisionKind: 'defer',
            now,
          })
        : deferredProof.action;
      return {
        handled: true,
        action: reviewedAction,
        replyText: deferredProof.applied
          ? 'Andrea: BlueBubbles proof drill deferred decision is recorded.'
          : staleBlueBubblesMutationReply(
              reviewedAction,
              'record that stale proof-drill deferral',
            ),
        presentation: buildMessageActionPresentation(
          reviewedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
    const eligibility = validateScheduledSendEligibility(action, {
      authorizationAt: resolveOwnerAuthorizationAt(deps, now),
    });
    if (eligibility.ok) {
      const scheduled = await createScheduledSend({
        action,
        timingHint: operation.timingHint || null,
        deps,
        now,
      });
      const reviewedAction = scheduled.applied
        ? recordMessageActionOwnerDecision({
            action: scheduled.updatedAction,
            verdict: 'accepted',
            decisionKind: 'defer',
            now,
          })
        : scheduled.updatedAction;
      return {
        handled: true,
        action: reviewedAction,
        replyText: scheduled.replyText,
        presentation: buildMessageActionPresentation(
          reviewedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
    const deferred = await persistDeferredReminder({
      action,
      timingHint: operation.timingHint || null,
      deps,
      now,
      reminderOnly: false,
    });
    const reviewedAction = deferred.applied
      ? recordMessageActionOwnerDecision({
          action: deferred.updatedAction,
          verdict: 'accepted',
          decisionKind: 'defer',
          now,
        })
      : deferred.updatedAction;
    return {
      handled: true,
      action: reviewedAction,
      replyText:
        eligibility.reason && deferred.applied
          ? `${deferred.replyText}\n\nAndrea: I kept this as a reminder because ${eligibility.reason.toLowerCase()}`
          : deferred.replyText,
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'remind_instead') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    const deferred = await persistDeferredReminder({
      action,
      timingHint: operation.timingHint || null,
      deps,
      now,
      reminderOnly: true,
    });
    const reviewedAction = deferred.applied
      ? recordMessageActionOwnerDecision({
          action: deferred.updatedAction,
          verdict: 'accepted',
          decisionKind: 'remind_instead',
          now,
        })
      : deferred.updatedAction;
    return {
      handled: true,
      action: reviewedAction,
      replyText: deferred.replyText,
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'send' || operation.kind === 'send_again') {
    if (action.sendStatus === 'sent' && operation.kind !== 'send_again') {
      notifyVerifiedSend(deps, action);
      return {
        handled: true,
        action,
        replyText:
          action.targetChannel === 'bluebubbles'
            ? 'Andrea: That one already went out. Create a fresh message action if you want to send something else.'
            : 'Andrea: That one already went out. Say send it again if you really want me to resend it.',
      };
    }
    const executed = await executeSendOperation({
      action,
      deps,
      now,
      hasExplicitUserApproval: true,
      blueBubblesAuthorizationAt: resolveOwnerAuthorizationAt(deps, now),
    });
    const reviewedAction = recordMessageActionOwnerDecision({
      action: executed.action,
      verdict: 'accepted',
      decisionKind: operation.kind,
      now,
    });
    return {
      handled: true,
      action: reviewedAction,
      replyText: executed.replyText,
      presentation: buildMessageActionPresentation(
        reviewedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  return { handled: false };
}

export function resolveMessageActionForFollowup(
  params: ResolveMessageActionForPromptParams,
): MessageActionRecord | undefined {
  const now = params.now || new Date();
  const recoverCurrent = (): MessageActionRecord | undefined => {
    if (params.chatJid.startsWith('bb:')) {
      return (
        reconcileBlueBubblesMessageActionContinuity({
          groupFolder: params.groupFolder,
          chatJid: params.chatJid,
          now,
          allowRehydrate: true,
        }).activeAction || undefined
      );
    }
    return rehydrateBlueBubblesSelfThreadMessageAction(params);
  };
  const continuity = params.chatJid.startsWith('bb:')
    ? reconcileBlueBubblesMessageActionContinuity({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        now,
        allowRehydrate: true,
      })
    : null;
  const current =
    continuity?.activeAction ||
    findLatestChatMessageAction({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
    });
  const explicitPersonName = extractExplicitPersonName(params.rawText);
  const openSurfaceActions = listOpenMessageActionsForGroup(params.groupFolder)
    .filter((action) => isOpenMessageActionStatus(action.sendStatus))
    .filter((action) => actionIsBoundToPromptChat(action, params.chatJid));
  const replyToMessageId = normalizeText(params.replyToMessageId);
  if (replyToMessageId) {
    const replyMatches = openSurfaceActions.filter(
      (action) =>
        normalizeText(action.presentationMessageId) === replyToMessageId,
    );
    if (replyMatches.length !== 1) return undefined;
    const replyBoundAction = replyMatches[0];
    if (
      explicitPersonName &&
      !actionMatchesPersonName(replyBoundAction, explicitPersonName)
    ) {
      return undefined;
    }
    if (
      !isMessageActionFreshForFollowup(replyBoundAction, now) &&
      !params.includeStaleForDenial
    ) {
      return undefined;
    }
    return replyBoundAction;
  }
  const collectEligibleActions = (
    recovered?: MessageActionRecord,
    includeStale = false,
  ): MessageActionRecord[] => {
    const candidates = [
      ...listOpenMessageActionsForGroup(params.groupFolder),
      ...(current ? [current] : []),
      ...(recovered ? [recovered] : []),
    ]
      .filter(
        (action, index, actions) =>
          actions.findIndex(
            (candidate) => candidate.messageActionId === action.messageActionId,
          ) === index,
      )
      .filter((action) => actionIsBoundToPromptChat(action, params.chatJid))
      .filter((action) => isOpenMessageActionStatus(action.sendStatus))
      // Natural send/rewrite followups are card followups, not a separate
      // explicit-send syntax. Without a confirmed presentation receipt there
      // is no reviewed recipient/body pair to approve.
      .filter(
        (action) =>
          action.targetKind !== 'external_thread' ||
          Boolean(normalizeText(action.presentationMessageId)),
      )
      .filter(
        (action) =>
          includeStale || isMessageActionFreshForFollowup(action, now),
      );
    return explicitPersonName
      ? candidates.filter((action) =>
          actionMatchesPersonName(action, explicitPersonName),
        )
      : candidates;
  };

  let eligibleActions = collectEligibleActions();
  if (eligibleActions.length === 0) {
    eligibleActions = collectEligibleActions(recoverCurrent());
  }
  if (eligibleActions.length === 0 && params.includeStaleForDenial) {
    const staleActions = collectEligibleActions(undefined, true).filter(
      (action) => !isMessageActionFreshForFollowup(action, now),
    );
    return staleActions.length === 1 ? staleActions[0] : undefined;
  }
  return eligibleActions.length === 1 ? eligibleActions[0] : undefined;
}

export function findLatestChatMessageAction(params: {
  groupFolder: string;
  chatJid: string;
  now?: Date;
}): MessageActionRecord | undefined {
  if (params.chatJid.startsWith('bb:')) {
    const continuity = reconcileBlueBubblesMessageActionContinuity({
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      now: params.now,
      allowRehydrate: false,
    });
    return (
      continuity.activeAction ||
      continuity.openActions.find((entry) => entry.isActive)?.action ||
      (continuity.conversationKind === 'self_thread'
        ? undefined
        : continuity.openActions[0]?.action)
    );
  }
  const candidateChatJids = [
    ...new Set(expandBlueBubblesLogicalSelfThreadJids(params.chatJid)),
  ];
  return candidateChatJids
    .map((chatJid) =>
      findLatestOpenMessageActionForChat({
        groupFolder: params.groupFolder,
        chatJid,
      }),
    )
    .filter((action): action is MessageActionRecord => Boolean(action))
    .sort(
      (left, right) =>
        Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt),
    )[0];
}

export function listOpenMessageActionsForGroup(
  groupFolder: string,
): MessageActionRecord[] {
  return listMessageActionsForGroup({
    groupFolder,
    includeSent: false,
    limit: 100,
  }).filter((action) => action.sendStatus !== 'skipped');
}

function compareBlueBubblesContinuitySnapshots(
  left: BlueBubblesMessageActionContinuitySnapshot,
  right: BlueBubblesMessageActionContinuitySnapshot,
): number {
  const leftActive = left.activeMessageActionId ? 0 : 1;
  const rightActive = right.activeMessageActionId ? 0 : 1;
  if (leftActive !== rightActive) {
    return leftActive - rightActive;
  }
  const priority = (kind: BlueBubblesConversationKind): number => {
    switch (kind) {
      case 'self_thread':
        return 0;
      case 'direct_1to1':
        return 1;
      case 'group':
        return 2;
    }
  };
  const leftKind = priority(left.conversationKind);
  const rightKind = priority(right.conversationKind);
  if (leftKind !== rightKind) {
    return leftKind - rightKind;
  }
  return (
    Date.parse(right.recentTargetAt || '') -
    Date.parse(left.recentTargetAt || '')
  );
}

export function reconcileBlueBubblesMessageActionContinuity(params: {
  groupFolder: string;
  chatJid?: string | null;
  now?: Date;
  allowRehydrate?: boolean;
}): BlueBubblesMessageActionContinuitySnapshot {
  const now = params.now || new Date();
  const sourceSelfThreadChatJid =
    params.chatJid && normalizeBlueBubblesConversationChatJid(params.chatJid)
      ? params.chatJid
      : getBlueBubblesCanonicalSelfThreadJid();
  const canonicalSelfThreadChatJid =
    normalizeBlueBubblesConversationChatJid(sourceSelfThreadChatJid) ||
    getBlueBubblesCanonicalSelfThreadJid();
  const conversationKind = resolveBlueBubblesConversationKind(
    canonicalSelfThreadChatJid,
  );
  const supersededActionIds: string[] = [];
  const freshnessCutoff =
    now.getTime() - MESSAGE_ACTION_FOLLOWUP_CONTEXT_TTL_MS;
  let continuityCandidates = listBlueBubblesMessageActionContinuityCandidates({
    groupFolder: params.groupFolder,
    canonicalChatJid: canonicalSelfThreadChatJid,
  });
  const duplicateActionGroups = new Map<
    string,
    Array<(typeof continuityCandidates)[number]>
  >();
  for (const candidate of continuityCandidates) {
    if (
      !candidate.continuityKey ||
      !isActionableBlueBubblesDecisionStatus(candidate.action.sendStatus)
    ) {
      continue;
    }
    const group = duplicateActionGroups.get(candidate.continuityKey) || [];
    group.push(candidate);
    duplicateActionGroups.set(candidate.continuityKey, group);
  }
  for (const duplicates of duplicateActionGroups.values()) {
    if (duplicates.length < 2) {
      continue;
    }
    duplicates
      .sort((left, right) => right.engagedAtMs - left.engagedAtMs)
      .slice(1)
      .forEach((duplicate) => {
        skipBlueBubblesContinuityAction(duplicate.action, now);
        supersededActionIds.push(duplicate.action.messageActionId);
      });
  }
  if (supersededActionIds.length > 0) {
    continuityCandidates = listBlueBubblesMessageActionContinuityCandidates({
      groupFolder: params.groupFolder,
      canonicalChatJid: canonicalSelfThreadChatJid,
    });
  }
  if (conversationKind === 'self_thread') {
    const staleSelfThreadActions = continuityCandidates.filter(
      (candidate) =>
        isActionableBlueBubblesDecisionStatus(candidate.action.sendStatus) &&
        candidate.engagedAtMs < freshnessCutoff,
    );
    for (const staleAction of staleSelfThreadActions) {
      skipBlueBubblesContinuityAction(staleAction.action, now);
      supersededActionIds.push(staleAction.action.messageActionId);
    }
    if (staleSelfThreadActions.length > 0) {
      continuityCandidates = listBlueBubblesMessageActionContinuityCandidates({
        groupFolder: params.groupFolder,
        canonicalChatJid: canonicalSelfThreadChatJid,
      });
    }
  }

  let rehydratedActionId: string | null = null;
  let recoveredFromChatJid: string | null = null;
  let activeActionCandidate =
    continuityCandidates.find(
      (candidate) =>
        isActionableBlueBubblesDecisionStatus(candidate.action.sendStatus) &&
        candidate.engagedAtMs >= freshnessCutoff,
    ) || null;
  if (!activeActionCandidate && params.allowRehydrate) {
    const draftChatJids =
      conversationKind === 'self_thread'
        ? [
            ...new Set(
              expandBlueBubblesLogicalSelfThreadJids(sourceSelfThreadChatJid),
            ),
          ]
        : [canonicalSelfThreadChatJid];
    const freshDraftPresentation = findFreshBlueBubblesDraftPresentation({
      chatJids: draftChatJids,
      now,
    });
    if (freshDraftPresentation) {
      const recovered = createRehydratedBlueBubblesMessageAction({
        groupFolder: params.groupFolder,
        chatJid: freshDraftPresentation.chat_jid,
        presentationText: freshDraftPresentation.content || '',
        presentationMessageId: freshDraftPresentation.id,
        now,
      });
      if (recovered) {
        rehydratedActionId = recovered.messageActionId;
        recoveredFromChatJid = freshDraftPresentation.chat_jid;
        continuityCandidates = listBlueBubblesMessageActionContinuityCandidates(
          {
            groupFolder: params.groupFolder,
            canonicalChatJid: canonicalSelfThreadChatJid,
          },
        );
        activeActionCandidate =
          continuityCandidates.find(
            (candidate) =>
              isActionableBlueBubblesDecisionStatus(
                candidate.action.sendStatus,
              ) && candidate.engagedAtMs >= freshnessCutoff,
          ) || null;
      }
    }
  }

  const freshDraftPresentation = findFreshBlueBubblesDraftPresentation({
    chatJids:
      conversationKind === 'self_thread'
        ? [
            ...new Set(
              expandBlueBubblesLogicalSelfThreadJids(sourceSelfThreadChatJid),
            ),
          ]
        : [canonicalSelfThreadChatJid],
    now,
  });
  const recentAndreaContextMessage = findFreshBlueBubblesAndreaContextMessage({
    chatJids:
      conversationKind === 'self_thread'
        ? [
            ...new Set(
              expandBlueBubblesLogicalSelfThreadJids(sourceSelfThreadChatJid),
            ),
          ]
        : [canonicalSelfThreadChatJid],
    now,
  });
  const decisionPolicy = resolveBlueBubblesDecisionPolicy(conversationKind, {
    hasFreshActiveAction: Boolean(activeActionCandidate),
    hasFreshDraftPresentation: Boolean(freshDraftPresentation),
    hasFreshAndreaContext: Boolean(recentAndreaContextMessage),
  });
  const conversationalEligibility =
    resolveBlueBubblesConversationalEligibility(decisionPolicy);
  const requiresExplicitMention =
    resolveBlueBubblesRequiresExplicitMention(decisionPolicy);
  const eligibleFollowups = resolveBlueBubblesEligibleFollowups(decisionPolicy);
  const continuityState:
    | 'idle'
    | 'draft_open'
    | 'awaiting_decision'
    | 'proof_gap' = activeActionCandidate
    ? activeActionCandidate.action.sendStatus === 'approved'
      ? 'awaiting_decision'
      : 'draft_open'
    : freshDraftPresentation
      ? 'proof_gap'
      : 'idle';
  const recentTargetChatJid =
    activeActionCandidate?.presentationChatJid ||
    normalizeBlueBubblesConversationChatJid(freshDraftPresentation?.chat_jid) ||
    normalizeBlueBubblesConversationChatJid(
      recentAndreaContextMessage?.chat_jid,
    ) ||
    freshDraftPresentation?.chat_jid ||
    recentAndreaContextMessage?.chat_jid ||
    'none';
  const recentTargetAt =
    activeActionCandidate?.engagedAt ||
    freshDraftPresentation?.timestamp ||
    recentAndreaContextMessage?.timestamp ||
    'none';
  const activePresentationAt = activeActionCandidate?.engagedAt || null;
  const openActions = continuityCandidates
    .filter((candidate) =>
      isActionableBlueBubblesDecisionStatus(candidate.action.sendStatus),
    )
    .map((candidate) => ({
      action: candidate.action,
      presentationChatJid: candidate.presentationChatJid,
      targetChatJid: candidate.targetChatJid,
      engagedAt: candidate.engagedAt,
      conversationKind,
      decisionPolicy,
      conversationalEligibility,
      requiresExplicitMention,
      activePresentationAt: candidate.engagedAt,
      eligibleFollowups: [...eligibleFollowups],
      isActive:
        activeActionCandidate?.action.messageActionId ===
        candidate.action.messageActionId,
    }))
    .sort((left, right) => {
      if (left.isActive !== right.isActive) {
        return left.isActive ? -1 : 1;
      }
      return Date.parse(right.engagedAt) - Date.parse(left.engagedAt);
    });

  return {
    sourceSelfThreadChatJid:
      recoveredFromChatJid || sourceSelfThreadChatJid || null,
    canonicalSelfThreadChatJid,
    conversationKind,
    decisionPolicy,
    conversationalEligibility,
    requiresExplicitMention,
    activeMessageActionId:
      activeActionCandidate?.action.messageActionId || null,
    activeAction: activeActionCandidate?.action || null,
    activePresentationAt,
    recentTargetChatJid,
    recentTargetAt,
    openMessageActionCount: openActions.length,
    continuityState,
    proofCandidateChatJid:
      activeActionCandidate?.presentationChatJid ||
      normalizeBlueBubblesConversationChatJid(
        freshDraftPresentation?.chat_jid,
      ) ||
      freshDraftPresentation?.chat_jid ||
      'none',
    eligibleFollowups: continuityState === 'idle' ? [] : [...eligibleFollowups],
    openActions,
    rehydratedActionId,
    supersededActionIds,
  };
}

export function reconcileBlueBubblesSelfThreadContinuity(params: {
  groupFolder: string;
  chatJid?: string | null;
  now?: Date;
  allowRehydrate?: boolean;
}): BlueBubblesSelfThreadContinuitySnapshot {
  return reconcileBlueBubblesMessageActionContinuity(params);
}

export function listBlueBubblesMessageActionContinuitySnapshots(params: {
  groupFolder: string;
  now?: Date;
  allowRehydrate?: boolean;
}): BlueBubblesMessageActionContinuitySnapshot[] {
  const now = params.now || new Date();
  const candidateChatJids = new Set<string>([
    getBlueBubblesCanonicalSelfThreadJid(),
  ]);
  for (const chat of getAllChats()) {
    if (!chat.jid.startsWith('bb:')) continue;
    const normalizedChatJid = normalizeBlueBubblesConversationChatJid(chat.jid);
    if (normalizedChatJid) {
      candidateChatJids.add(normalizedChatJid);
    }
  }
  for (const action of listMessageActionsForGroup({
    groupFolder: params.groupFolder,
    includeSent: false,
    limit: 200,
  })) {
    if (
      action.targetChannel !== 'bluebubbles' ||
      action.targetKind !== 'external_thread'
    ) {
      continue;
    }
    const presentationChatJid =
      resolveBlueBubblesConversationPresentationChatJid(action);
    if (presentationChatJid) {
      candidateChatJids.add(presentationChatJid);
    }
  }
  return [...candidateChatJids]
    .map((chatJid) =>
      reconcileBlueBubblesMessageActionContinuity({
        groupFolder: params.groupFolder,
        chatJid,
        now,
        allowRehydrate: params.allowRehydrate,
      }),
    )
    .filter(
      (snapshot) =>
        snapshot.openMessageActionCount > 0 ||
        snapshot.continuityState !== 'idle' ||
        (snapshot.conversationKind === 'direct_1to1' &&
          snapshot.decisionPolicy === 'semi_auto_recent_direct_1to1' &&
          snapshot.recentTargetChatJid !== 'none'),
    )
    .sort(compareBlueBubblesContinuitySnapshots);
}

function isBlueBubblesAndreaDirectedInstruction(rawText: string): boolean {
  const normalized = normalizeText(rawText).toLowerCase();
  return /(?:^|[\s([{-])@andrea\b/.test(normalized);
}

export function canUseBareBlueBubblesMessageActionFollowup(params: {
  rawText: string;
  operation: MessageActionOperation;
  continuity: BlueBubblesMessageActionContinuitySnapshot;
}): boolean {
  if (!params.continuity.activeAction) {
    return false;
  }
  if (isBlueBubblesSemiAutoDecisionPolicy(params.continuity.decisionPolicy)) {
    return (
      params.operation.kind === 'show' ||
      params.operation.kind === 'show_draft' ||
      params.operation.kind === 'rewrite' ||
      params.operation.kind === 'defer' ||
      params.operation.kind === 'remind_instead' ||
      params.operation.kind === 'save_to_thread'
    );
  }
  return (
    params.operation.kind === 'show' ||
    params.operation.kind === 'show_draft' ||
    params.operation.kind === 'rewrite' ||
    params.operation.kind === 'why'
  );
}

export function canApplyBlueBubblesMessageActionFollowup(params: {
  rawText: string;
  operation: MessageActionOperation;
  continuity: BlueBubblesMessageActionContinuitySnapshot;
}): boolean {
  if (canUseBareBlueBubblesMessageActionFollowup(params)) {
    return true;
  }
  if (params.continuity.conversationKind === 'self_thread') {
    return (
      isBlueBubblesAndreaDirectedInstruction(params.rawText) ||
      isBlueBubblesExplicitSendAlias(params.rawText)
    );
  }
  return isBlueBubblesAndreaDirectedInstruction(params.rawText);
}

export function ensureBlueBubblesSelfThreadMessageActionForReplyText(params: {
  groupFolder: string;
  chatJid: string;
  replyText: string;
  presentationMessageId?: string | null;
  now?: Date;
}): MessageActionRecord | undefined {
  if (!isConfiguredBlueBubblesSelfThreadAliasJid(params.chatJid)) {
    return undefined;
  }
  const created = createRehydratedBlueBubblesMessageAction({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
    presentationText: params.replyText,
    presentationMessageId: params.presentationMessageId || null,
    now: params.now,
  });
  const continuity = reconcileBlueBubblesSelfThreadContinuity({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
    now: params.now,
    allowRehydrate: false,
  });
  return continuity.activeAction || created;
}

function createRehydratedBlueBubblesMessageAction(params: {
  groupFolder: string;
  chatJid: string;
  presentationText: string;
  presentationMessageId?: string | null;
  now?: Date;
}): MessageActionRecord | undefined {
  const now = params.now || new Date();
  const parsed = parseMessageActionPresentationText(params.presentationText);
  if (!parsed?.targetLabel || !parsed.draftText) {
    return undefined;
  }
  const resolution = resolveBlueBubblesThreadTargetByName(parsed.targetLabel);
  if (resolution.state !== 'resolved') {
    return undefined;
  }
  const presentationChatJid =
    normalizeBlueBubblesConversationChatJid(params.chatJid) || params.chatJid;
  const dedupeSeed = messageActionBodyFingerprint(parsed.draftText);
  const action = createOrRefreshMessageActionFromDraft({
    groupFolder: params.groupFolder,
    presentationChannel: 'bluebubbles',
    presentationChatJid,
    sourceType: 'manual_prompt',
    sourceKey: `rehydrated-bluebubbles-draft:${resolution.target.chatJid}:${dedupeSeed}`,
    sourceSummary: `Draft text message to ${resolution.target.displayName}.`,
    draftText: parsed.draftText,
    personName: resolution.target.displayName,
    threadTitle: resolution.target.displayName,
    communicationContext: 'general',
    targetOverride: {
      kind: 'external_thread',
      chatJid: resolution.target.chatJid,
      threadId: null,
      replyToMessageId: null,
      isGroup: resolution.target.isGroup,
      personName: resolution.target.displayName,
    },
    targetChannelOverride: 'bluebubbles',
    now,
  });
  if (params.presentationMessageId) {
    return updateMessageActionFromSnapshot({
      action,
      updates: {
        presentationMessageId: params.presentationMessageId,
        presentationChatJid,
        lastUpdatedAt: now.toISOString(),
      },
    }).action;
  }
  return action;
}

function rehydrateBlueBubblesSelfThreadMessageAction(
  params: ResolveMessageActionForPromptParams,
): MessageActionRecord | undefined {
  const continuity = isConfiguredBlueBubblesSelfThreadAliasJid(params.chatJid)
    ? reconcileBlueBubblesSelfThreadContinuity({
        groupFolder: params.groupFolder,
        chatJid: params.chatJid,
        now: params.now,
        allowRehydrate: true,
      })
    : null;
  const recovered = continuity?.activeAction || null;
  const explicitPersonName = extractExplicitPersonName(params.rawText);
  if (
    recovered &&
    (!explicitPersonName ||
      actionMatchesPersonName(recovered, explicitPersonName))
  ) {
    return recovered;
  }
  return undefined;
}
