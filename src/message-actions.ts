import { randomUUID } from 'crypto';

import {
  createTask,
  getAllChats,
  getTaskById,
  getCommunicationThread,
  getMessageAction,
  getMessageActionByScheduledTaskId,
  getMessageActionBySource,
  findLatestOpenMessageActionForChat,
  listCommunicationThreadsForGroup,
  listMessageActionsForGroup,
  updateCommunicationThread,
  updateMessageAction,
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
import {
  syncOutcomeFromMessageActionRecord,
  syncOutcomeFromReminderTask,
} from './outcome-reviews.js';
import { resolveBlueBubblesConfig } from './channels/bluebubbles.js';
import {
  BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  canonicalizeBlueBubblesSelfThreadJid,
  expandBlueBubblesLogicalSelfThreadJids,
} from './bluebubbles-self-thread.js';
import { rewriteBlueBubblesMessageDraft } from './messages-fluidity.js';
import type {
  ChannelInlineAction,
  MessageActionExplanation,
  MessageActionLinkedRefs,
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

type PresentationChannel = 'telegram' | 'bluebubbles' | 'alexa';

interface ExternalThreadTarget {
  kind: 'external_thread';
  chatJid: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
  isGroup?: boolean | null;
  personName?: string | null;
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
}

export interface CreateMessageActionFromDraftParams {
  groupFolder: string;
  presentationChannel: Exclude<PresentationChannel, 'alexa'>;
  presentationChatJid: string;
  presentationThreadId?: string | null;
  sourceType: MessageActionSourceType;
  sourceKey: string;
  sourceSummary?: string | null;
  draftText: string;
  personName?: string | null;
  threadTitle?: string | null;
  communicationThreadId?: string | null;
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
  sendToTarget: (
    targetChannel: MessageActionTargetChannel,
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ) => Promise<SendMessageResult>;
}

interface SendExecutionResult {
  action: MessageActionRecord;
  replyText: string;
  target: MessageTarget;
  didSend: boolean;
}

export interface ResolveMessageActionForPromptParams {
  groupFolder: string;
  chatJid: string;
  rawText: string;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeBlueBubblesChatLookup(value: string | null | undefined): string {
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

function buildLinkedRefs(params: CreateMessageActionFromDraftParams): MessageActionLinkedRefs {
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
  };
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

function inferTarget(
  params: CreateMessageActionFromDraftParams,
): {
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
        (params.presentationChannel === 'bluebubbles' ? 'bluebubbles' : 'telegram'),
      target: params.targetOverride,
    };
  }

  const thread =
    params.communicationThreadId
      ? getCommunicationThread(params.communicationThreadId)
      : undefined;
  const isBlueBubblesExternal =
    thread?.channel === 'bluebubbles' && Boolean(thread.channelChatJid);

  if (isBlueBubblesExternal && thread?.channelChatJid) {
    return {
      targetKind: 'external_thread',
      targetChannel: 'bluebubbles',
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
  if (action.trustLevel === 'draft_only' || action.trustLevel === 'never_automate') {
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
  trustLevel: MessageActionTrustLevel;
  requiresApproval: boolean;
  delegationExplanation?: string | null;
}): MessageActionExplanation {
  return {
    sourceSummary: params.sourceSummary || null,
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
    clipText(params.draftText.toLowerCase(), 120),
    params.seed || '',
  ]
    .map((value) => normalizeText(value))
    .join('|');
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
  const autoSendEligible =
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
  const trustLevel: MessageActionTrustLevel = autoSendEligible
    ? 'delegated_safe_send'
    : baseTrustLevel;
  const requiresApproval = !autoSendEligible;
  const sendStatus: MessageActionSendStatus = autoSendEligible
    ? 'approved'
    : 'drafted';
  const targetConversationJson = JSON.stringify(targetInfo.target);
  const existing = getMessageActionBySource(
    params.groupFolder,
    params.sourceType,
    params.sourceKey,
  );
  const reuseExisting =
    existing &&
    existing.sendStatus !== 'sent' &&
    normalizeText(existing.draftText).toLowerCase() ===
      normalizeText(params.draftText).toLowerCase();
  const record: MessageActionRecord = {
    messageActionId: reuseExisting ? existing!.messageActionId : randomUUID(),
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
    delegationRuleId:
      params.delegationRuleId || ruleMatch.rule?.ruleId || null,
    delegationMode:
      params.delegationMode || ruleMatch.effectiveApprovalMode || null,
    explanationJson: JSON.stringify(
      buildExplanation({
        sourceSummary: params.sourceSummary,
        trustLevel,
        requiresApproval,
        delegationExplanation:
          params.delegationExplanation || ruleMatch.explanation || null,
      }),
    ),
    linkedRefsJson: JSON.stringify(
      buildLinkedRefs({
        ...params,
        delegationRuleId:
          params.delegationRuleId || ruleMatch.rule?.ruleId || null,
        delegationMode:
          params.delegationMode || ruleMatch.effectiveApprovalMode || null,
        delegationExplanation:
          params.delegationExplanation || ruleMatch.explanation || null,
      }),
    ),
    platformMessageId: reuseExisting ? existing?.platformMessageId || null : null,
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
    lastActionAt: reuseExisting ? existing?.lastActionAt || null : now.toISOString(),
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
    presentationMessageId: reuseExisting ? existing?.presentationMessageId || null : null,
    createdAt: reuseExisting ? existing!.createdAt : now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    sentAt: reuseExisting ? existing?.sentAt || null : null,
  };
  upsertMessageAction(record);
  const saved = getMessageAction(record.messageActionId) || record;
  syncOutcomeFromMessageActionRecord(saved, now);
  return saved;
}

function parseTarget(record: MessageActionRecord): MessageTarget {
  return parseJsonSafe<MessageTarget>(record.targetConversationJson, {
    kind: record.targetKind === 'external_thread' ? 'external_thread' : 'self_companion',
    chatJid: record.presentationChatJid || '',
  } as MessageTarget);
}

function parseLinkedRefs(record: MessageActionRecord): MessageActionLinkedRefs {
  return parseJsonSafe<MessageActionLinkedRefs>(record.linkedRefsJson, {});
}

function parseExplanation(record: MessageActionRecord): MessageActionExplanation {
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
}): { planned: ReturnType<typeof planContextualReminder>; normalizedHint: string } {
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
  if (record.targetKind === 'external_thread' && record.targetChannel === 'bluebubbles') {
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
  mode: 'sent' | 'scheduled_send' | 'reminder' | 'thread_saved' | 'drafted' | 'failed';
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
      lastOutboundSummary: clipText(params.action.draftText, 220) || thread.lastOutboundSummary,
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

function validateScheduledSendEligibility(
  action: MessageActionRecord,
): { ok: boolean; reason?: string; target: MessageTarget } {
  const target = parseTarget(action);
  if (action.targetChannel !== 'bluebubbles' || action.targetKind !== 'external_thread') {
    return {
      ok: false,
      reason: 'This kind of message is safer as a draft or reminder than a queued send.',
      target,
    };
  }
  if (target.kind !== 'external_thread' || target.isGroup) {
    return {
      ok: false,
      reason: 'Queued send is only available for an existing 1:1 Messages thread.',
      target,
    };
  }
  if (action.trustLevel === 'draft_only' || action.trustLevel === 'never_automate') {
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
      reason: 'I could not confirm the exact Messages thread for that queued send.',
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

function extractExplicitPersonName(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  const match = normalized.match(
    /^send (?:(?:this|that|it)(?: reply)?|the (?:shorter|warmer|more direct|full) version) to ([a-z][a-z' -]+)$/i,
  );
  return match?.[1]?.trim() || null;
}

function actionMatchesPersonName(
  action: MessageActionRecord,
  personName: string,
): boolean {
  const normalizedPerson = personName.toLowerCase();
  const target = parseTarget(action);
  const linkedRefs = parseLinkedRefs(action);
  const candidates = [
    linkedRefs.personName,
    action.sourceSummary,
    target.kind === 'external_thread' ? target.personName : null,
  ]
    .map((value) => normalizeText(value).toLowerCase())
    .filter(Boolean);
  return candidates.some((value) => value.includes(normalizedPerson));
}

function buildActionLead(record: MessageActionRecord): string {
  if (isScheduledSendAction(record)) {
    return 'Andrea: I queued that to send later.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'save_to_thread') {
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
    case 'approved':
      return 'Andrea: This is approved and ready.';
    case 'skipped':
      return 'Andrea: Okay, I left that unsent.';
    case 'drafted':
    default:
      return 'Andrea: I drafted a reply.';
  }
}

function buildStatusLine(record: MessageActionRecord): string {
  if (isScheduledSendAction(record)) {
    return `Status: queued to send around ${
      formatWhenLabel(record.followupAt) || record.followupAt || 'later'
    }.`;
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'save_to_thread') {
    return 'Status: saved under the thread for later follow-through.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'remind_instead') {
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
  if (record.sendStatus === 'skipped') {
    return 'Status: skipped for now.';
  }
  return record.requiresApproval
    ? 'Status: waiting for your approval before sending.'
    : 'Status: ready to send.';
}

function buildStateNote(record: MessageActionRecord): string | null {
  if (record.sendStatus === 'sent') {
    return null;
  }
  if (isScheduledSendAction(record)) {
    return 'This draft is already approved. Andrea will send it at the scheduled time unless you revise it, cancel it, or switch to a reminder.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'remind_instead') {
    return 'This message is still unsent. Andrea only set a reminder.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'save_to_thread') {
    return 'This message is still unsent. Andrea saved it under the thread for later follow-through.';
  }
  if (record.sendStatus === 'approved') {
    return 'This message is approved, but it has not gone out yet.';
  }
  if (record.sendStatus === 'drafted') {
    return 'This message is still just a draft.';
  }
  return null;
}

function nextStepLine(record: MessageActionRecord): string {
  if (record.sendStatus === 'sent') {
    return 'Next: review it later if you want to track the follow-through.';
  }
  if (isScheduledSendAction(record)) {
    return 'Next: send it now, cancel the scheduled send, remind yourself instead, or revise it.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'save_to_thread') {
    return 'Next: show the draft again, send it, send it later, or remind yourself instead.';
  }
  if (record.sendStatus === 'deferred' && record.lastActionKind === 'remind_instead') {
    return 'Next: send it when you are ready, change the reminder, save it under the thread, or keep editing it.';
  }
  if (record.sendStatus === 'deferred') {
    return 'Next: I can show the draft again, remind you instead, or send it when you are ready.';
  }
  return 'Next: send it, send it later, remind me instead, save it under the thread, or keep editing it.';
}

function buildInlineRows(record: MessageActionRecord): ChannelInlineAction[][] {
  if (record.sendStatus === 'sent') {
    return [
      [
        { label: 'Show draft', actionId: `/message-show ${record.messageActionId}` },
        { label: 'Send again', actionId: `/message-send-again ${record.messageActionId}` },
      ],
    ];
  }
  if (isScheduledSendAction(record)) {
    return [
      [
        { label: 'Show draft', actionId: `/message-show ${record.messageActionId}` },
        { label: 'Send now', actionId: `/message-send ${record.messageActionId}` },
        { label: 'Cancel send later', actionId: `/message-cancel-later ${record.messageActionId}` },
      ],
      [
        { label: 'Shorter', actionId: `/message-rewrite ${record.messageActionId} shorter` },
        { label: 'Warmer', actionId: `/message-rewrite ${record.messageActionId} warmer` },
        { label: 'Remind me instead', actionId: `/message-remind ${record.messageActionId}` },
      ],
    ];
  }
  return [
    [
      { label: 'Show draft', actionId: `/message-show ${record.messageActionId}` },
      { label: 'Shorter', actionId: `/message-rewrite ${record.messageActionId} shorter` },
      { label: 'Warmer', actionId: `/message-rewrite ${record.messageActionId} warmer` },
    ],
    [
      { label: 'More direct', actionId: `/message-rewrite ${record.messageActionId} direct` },
      { label: 'Send now', actionId: `/message-send ${record.messageActionId}` },
      { label: 'Send later', actionId: `/message-later ${record.messageActionId}` },
    ],
    [
      { label: 'Remind me instead', actionId: `/message-remind ${record.messageActionId}` },
      { label: 'Save under thread', actionId: `/message-save-thread ${record.messageActionId}` },
      { label: 'Why this needs approval', actionId: `/message-why ${record.messageActionId}` },
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
  };
}

function rewriteDraft(
  draftText: string,
  style: 'shorter' | 'warmer' | 'more_direct',
): string {
  const normalized = draftText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return draftText;
  if (style === 'shorter') {
    const firstSentence = normalized.match(/^[\s\S]*?[.!?](?:\s|$)/)?.[0]?.trim();
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

function describeSendSuccess(record: MessageActionRecord, target: MessageTarget): string {
  if (target.kind === 'external_thread') {
    return `Andrea: I sent that${target.personName ? ` to ${target.personName}` : ' in the same thread'}.`;
  }
  return 'Andrea: I sent that to your companion chat.';
}

function parseTimingHintFromUtterance(rawText: string): string | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (/^send it later tonight$/.test(normalized) || /^send it tonight$/.test(normalized)) {
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
  const normalized = normalizeText(rawText).toLowerCase();
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
    /^(send it|send now|send that|send that reply|send this reply)$/.test(normalized) ||
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
  if (/^send the more direct version(?: to [a-z][a-z' -]+)?$/i.test(normalized)) {
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
  if (/^(keep (?:it|that)(?: as)? (?:a )?draft|keep as draft|leave it as draft)$/.test(normalized)) {
    return { kind: 'keep_draft' };
  }
  if (/^(save under (?:the )?thread|save it under (?:the )?thread)$/.test(normalized)) {
    return { kind: 'save_to_thread' };
  }
  if (/^(shorter|make it shorter)$/.test(normalized)) {
    return { kind: 'rewrite', style: 'shorter' };
  }
  if (/^(make it warmer|warmer)$/.test(normalized)) {
    return { kind: 'rewrite', style: 'warmer' };
  }
  if (/^(more direct|make it more direct)$/.test(normalized)) {
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
  const normalized = normalizeText(rawText).toLowerCase();
  return /^(send using blue bubbles|send (?:it|that|this)(?: reply)? using blue bubbles|send (?:it|that|this)(?: reply)? with blue bubbles)$/.test(
    normalized,
  );
}

export function parseExplicitBlueBubblesThreadSendIntent(
  rawText: string,
): BlueBubblesExplicitThreadSendIntent | null {
  const normalized = normalizeText(rawText);
  if (!normalized) return null;
  const patterns = [
    /^send (?:a )?(?:text )?message to\s+(.+?):\s*(.+)$/i,
    /^send (?:a )?(?:text )?to\s+(.+?):\s*(.+)$/i,
    /^text\s+(.+?):\s*(.+)$/i,
    /^send (?:a )?(?:text )?message to\s+(.+?)\s+saying\s+(.+)$/i,
    /^send (?:a )?message to\s+(.+?)\s+saying\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const targetLabel = normalizeText(match?.[1]);
    const draftText = normalizeText(match?.[2]);
    if (targetLabel && draftText) {
      return { targetLabel, draftText };
    }
  }
  return null;
}

export function resolveBlueBubblesThreadTargetByName(
  query: string,
):
  | { state: 'resolved'; target: ResolvedBlueBubblesThreadTarget }
  | { state: 'ambiguous'; matches: ResolvedBlueBubblesThreadTarget[] }
  | { state: 'missing' } {
  const normalizedQuery = normalizeBlueBubblesChatLookup(query);
  if (!normalizedQuery) return { state: 'missing' };

  const candidates = getAllChats()
    .filter((chat) => chat.channel === 'bluebubbles' || chat.jid.startsWith('bb:'))
    .filter(
      (chat) =>
        canonicalizeBlueBubblesSelfThreadJid(chat.jid) !==
        BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    )
    .map((chat) => ({
      chatJid: chat.jid,
      displayName: buildBlueBubblesChatDisplayName({
        jid: chat.jid,
        name: chat.name,
      }),
      isGroup: Boolean(chat.is_group),
      normalizedName: normalizeBlueBubblesChatLookup(
        buildBlueBubblesChatDisplayName({ jid: chat.jid, name: chat.name }),
      ),
      lastMessageTime: chat.last_message_time,
    }));

  const exactMatches = candidates.filter(
    (candidate) =>
      candidate.normalizedName === normalizedQuery ||
      candidate.chatJid.toLowerCase() === normalizedQuery,
  );
  if (exactMatches.length === 1) {
    const { normalizedName: _normalizedName, lastMessageTime: _lastMessageTime, ...target } =
      exactMatches[0]!;
    return { state: 'resolved', target };
  }
  if (exactMatches.length > 1) {
    return {
      state: 'ambiguous',
      matches: exactMatches
        .sort(
          (left, right) =>
            Date.parse(right.lastMessageTime || '') - Date.parse(left.lastMessageTime || ''),
        )
        .slice(0, 3)
        .map(({ normalizedName: _normalizedName, lastMessageTime: _lastMessageTime, ...target }) => target),
    };
  }

  const fuzzyMatches = candidates.filter(
    (candidate) =>
      candidate.normalizedName.includes(normalizedQuery) ||
      normalizedQuery.includes(candidate.normalizedName),
  );
  if (fuzzyMatches.length === 1) {
    const { normalizedName: _normalizedName, lastMessageTime: _lastMessageTime, ...target } =
      fuzzyMatches[0]!;
    return { state: 'resolved', target };
  }
  if (fuzzyMatches.length > 1) {
    return {
      state: 'ambiguous',
      matches: fuzzyMatches
        .sort(
          (left, right) =>
            Date.parse(right.lastMessageTime || '') - Date.parse(left.lastMessageTime || ''),
        )
        .slice(0, 3)
        .map(({ normalizedName: _normalizedName, lastMessageTime: _lastMessageTime, ...target }) => target),
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
}): Promise<{ replyText: string; updatedAction: MessageActionRecord }> {
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
    };
  }
  createTask(planned.task);
  const linkedRefs = {
    ...parseLinkedRefs(params.action),
    reminderTaskId: planned.task.id,
    messageActionId: params.action.messageActionId,
  };
  pauseScheduledTask(params.action.scheduledTaskId);
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'deferred',
    followupAt: planned.task.next_run || null,
    scheduledTaskId: null,
    trustLevel: normalizeTrustLevelAfterQueue(params.action),
    approvedAt: params.reminderOnly ? null : params.action.approvedAt,
    lastActionKind: 'remind_instead',
    lastActionAt: params.now.toISOString(),
    linkedRefsJson: JSON.stringify(linkedRefs),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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
    summaryText:
      params.reminderOnly
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
  };
  const replyText = params.reminderOnly
    ? `Andrea: I'll remind you about that ${hint}.`
    : `Andrea: I saved that to revisit before sending, and I'll bring it back ${hint}.`;
  return {
    replyText: params.reminderOnly
      ? `Andrea: I’ll remind you about that ${hint}.`
      : `Andrea: I saved that to send later and I’ll bring it back ${hint}.`,
    updatedAction,
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
    linkedRefs.personName || clipText(params.action.sourceSummary, 48) || 'that thread';
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
}): Promise<{ replyText: string; updatedAction: MessageActionRecord }> {
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
    };
  }

  pauseScheduledTask(params.action.scheduledTaskId);
  const scheduledTask = buildScheduledTask({
    action: params.action,
    dueAt: planned.task.next_run,
    now: params.now,
    deps: params.deps,
  });
  createTask(scheduledTask);

  const linkedRefs = {
    ...parseLinkedRefs(params.action),
    messageActionId: params.action.messageActionId,
    reminderTaskId: undefined,
  };
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'deferred',
    followupAt: planned.task.next_run,
    scheduledTaskId: scheduledTask.id,
    requiresApproval: false,
    trustLevel: 'schedule_send',
    approvedAt: params.action.approvedAt || params.now.toISOString(),
    lastActionKind: 'scheduled_send',
    lastActionAt: params.now.toISOString(),
    linkedRefsJson: JSON.stringify(linkedRefs),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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
  };
}

function cancelScheduledSend(params: {
  action: MessageActionRecord;
  now: Date;
}): { replyText: string; updatedAction: MessageActionRecord } {
  if (!isScheduledSendAction(params.action)) {
    return {
      replyText: 'Andrea: There is no queued send on that right now.',
      updatedAction: params.action,
    };
  }
  pauseScheduledTask(params.action.scheduledTaskId);
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'approved',
    followupAt: null,
    scheduledTaskId: null,
    requiresApproval: false,
    trustLevel: normalizeTrustLevelAfterQueue(params.action),
    approvedAt: params.action.approvedAt || params.now.toISOString(),
    lastActionKind: 'approved',
    lastActionAt: params.now.toISOString(),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
  syncCommunicationThreadState({
    action: updatedAction,
    now: params.now,
    mode: 'failed',
  });
  syncOutcomeFromMessageActionRecord(updatedAction, params.now);
  return {
    replyText: 'Andrea: Okay, I canceled the scheduled send and kept the draft ready.',
    updatedAction,
  };
}

function keepMessageAsDraft(params: {
  action: MessageActionRecord;
  now: Date;
}): { replyText: string; updatedAction: MessageActionRecord } {
  if (params.action.delegationRuleId) {
    recordDelegationRuleOverride(params.action.delegationRuleId, params.now);
  }
  pauseScheduledTask(params.action.scheduledTaskId);
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'drafted',
    followupAt: null,
    scheduledTaskId: null,
    requiresApproval: true,
    trustLevel: normalizeTrustLevelAfterQueue(params.action),
    approvedAt: null,
    lastActionKind: 'drafted',
    lastActionAt: params.now.toISOString(),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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
  };
}

async function markFailedSend(params: {
  action: MessageActionRecord;
  deps: MessageActionExecutionDeps;
  now: Date;
}): Promise<SendExecutionResult> {
  const target = parseTarget(params.action);
  pauseScheduledTask(params.action.scheduledTaskId);
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'failed',
    followupAt: null,
    scheduledTaskId: null,
    requiresApproval: false,
    trustLevel: normalizeTrustLevelAfterQueue(params.action),
    approvedAt: params.action.approvedAt || params.now.toISOString(),
    lastActionKind: 'failed',
    lastActionAt: params.now.toISOString(),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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

async function executeSendOperation(params: {
  action: MessageActionRecord;
  deps: MessageActionExecutionDeps;
  now: Date;
}): Promise<SendExecutionResult> {
  const target = parseTarget(params.action);
  const sendOptions: SendMessageOptions =
    target.kind === 'external_thread'
      ? {
          threadId: target.threadId || undefined,
          replyToMessageId: target.replyToMessageId || undefined,
          suppressSenderLabel: true,
        }
      : {
          threadId: target.threadId || undefined,
        };
  try {
    pauseScheduledTask(params.action.scheduledTaskId);
    const receipt = await params.deps.sendToTarget(
      params.action.targetChannel,
      target.chatJid,
      params.action.draftText,
      sendOptions,
    );
    updateMessageAction(params.action.messageActionId, {
      sendStatus: 'sent',
      requiresApproval: false,
      followupAt: null,
      scheduledTaskId: null,
      trustLevel: normalizeTrustLevelAfterQueue(params.action),
      approvedAt: params.action.approvedAt || params.now.toISOString(),
      platformMessageId:
        receipt.platformMessageId || receipt.platformMessageIds?.[0] || null,
      sentAt: params.now.toISOString(),
      lastActionKind: 'sent',
      lastActionAt: params.now.toISOString(),
      lastUpdatedAt: params.now.toISOString(),
    });
    const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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
      replyText: describeSendSuccess(updatedAction, target),
      target,
      didSend: true,
    };
  } catch {
    return markFailedSend(params);
  }
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
        "Andrea: I still want your approval before sending that.",
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
    const linkedRefs = parseLinkedRefs(action);
    const modelRewrite =
      deps.channel === 'bluebubbles'
        ? await rewriteBlueBubblesMessageDraft({
            draftText: action.draftText,
            style: operation.style,
            personName: linkedRefs.personName || null,
          })
        : null;
    pauseScheduledTask(action.scheduledTaskId);
    updateMessageAction(action.messageActionId, {
      draftText:
        modelRewrite?.draftText || rewriteDraft(action.draftText, operation.style),
      sendStatus: 'drafted',
      requiresApproval: true,
      followupAt: null,
      scheduledTaskId: null,
      trustLevel: normalizeTrustLevelAfterQueue(action),
      approvedAt: null,
      lastActionKind: 'rewrite',
      lastActionAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    });
    const updatedAction = getMessageAction(action.messageActionId) || action;
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
    const refreshed = getMessageAction(action.messageActionId);
    if (!rewritten.handled || !refreshed) {
      return rewritten;
    }
    return applyMessageActionOperation(
      refreshed.messageActionId,
      { kind: 'send' },
      {
        ...deps,
        currentTime: now,
      },
    );
  }

  if (operation.kind === 'skip') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    pauseScheduledTask(action.scheduledTaskId);
    updateMessageAction(action.messageActionId, {
      sendStatus: 'skipped',
      followupAt: null,
      scheduledTaskId: null,
      trustLevel: normalizeTrustLevelAfterQueue(action),
      lastActionKind: 'skipped',
      lastActionAt: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
    });
    const updatedAction = getMessageAction(action.messageActionId) || action;
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    return {
      handled: true,
      action: updatedAction,
      replyText: 'Andrea: Okay, I left that unsent.',
      presentation: buildMessageActionPresentation(
        updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'cancel_deferred') {
    const cancelled = cancelScheduledSend({ action, now });
    return {
      handled: true,
      action: cancelled.updatedAction,
      replyText: cancelled.replyText,
      presentation: buildMessageActionPresentation(
        cancelled.updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'keep_draft') {
    const kept = keepMessageAsDraft({
      action,
      now,
    });
    return {
      handled: true,
      action: kept.updatedAction,
      replyText: kept.replyText,
      presentation: buildMessageActionPresentation(
        kept.updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'save_to_thread') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
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
      threadId: result.referencedThread?.id || existingLinkedRefs.threadId || undefined,
    };
    updateMessageAction(action.messageActionId, {
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
    });
    const updatedAction = getMessageAction(action.messageActionId) || action;
    syncCommunicationThreadState({
      action: updatedAction,
      now,
      mode: 'thread_saved',
    });
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    return {
      handled: Boolean(result.handled),
      action: updatedAction,
      replyText:
        result.responseText ||
        'Andrea: I saved that under the thread. The message is still unsent.',
      presentation: buildMessageActionPresentation(
        updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'defer') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    const eligibility = validateScheduledSendEligibility(action);
    if (eligibility.ok) {
      const scheduled = await createScheduledSend({
        action,
        timingHint: operation.timingHint || null,
        deps,
        now,
      });
      return {
        handled: true,
        action: scheduled.updatedAction,
        replyText: scheduled.replyText,
        presentation: buildMessageActionPresentation(
          scheduled.updatedAction,
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
    return {
      handled: true,
      action: deferred.updatedAction,
      replyText: eligibility.reason
        ? `${deferred.replyText}\n\nAndrea: I kept this as a reminder because ${eligibility.reason.toLowerCase()}`
        : deferred.replyText,
      presentation: buildMessageActionPresentation(
        deferred.updatedAction,
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
    return {
      handled: true,
      action: deferred.updatedAction,
      replyText: deferred.replyText,
      presentation: buildMessageActionPresentation(
        deferred.updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'send' || operation.kind === 'send_again') {
    if (action.sendStatus === 'sent' && operation.kind !== 'send_again') {
      return {
        handled: true,
        action,
        replyText:
          'Andrea: That one already went out. Say send it again if you really want me to resend it.',
      };
    }
    const executed = await executeSendOperation({
      action,
      deps,
      now,
    });
    return {
      handled: true,
      action: executed.action,
      replyText: executed.replyText,
      presentation: buildMessageActionPresentation(
        executed.action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  return { handled: false };
}

export function resolveMessageActionForFollowup(
  params: ResolveMessageActionForPromptParams,
): MessageActionRecord | undefined {
  const current = findLatestChatMessageAction({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
  });
  const explicitPersonName = extractExplicitPersonName(params.rawText);
  if (!explicitPersonName) {
    return current;
  }
  if (current && actionMatchesPersonName(current, explicitPersonName)) {
    return current;
  }

  const matchedAction = listOpenMessageActionsForGroup(params.groupFolder)
    .filter((action) => action.sendStatus !== 'skipped')
    .filter((action) => actionMatchesPersonName(action, explicitPersonName))
    .sort(
      (left, right) =>
        Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt),
    )[0];
  if (matchedAction) {
    return matchedAction;
  }

  const matchedThread = listCommunicationThreadsForGroup({
    groupFolder: params.groupFolder,
    includeDisabled: false,
    limit: 80,
  })
    .filter((thread) =>
      normalizeText(thread.title)
        .toLowerCase()
        .includes(explicitPersonName.toLowerCase()),
    )
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )[0];
  if (!matchedThread) {
    return current;
  }
  return (
    getMessageActionBySource(
      params.groupFolder,
      'communication_thread',
      matchedThread.id,
    ) || current
  );
}

export function findLatestChatMessageAction(params: {
  groupFolder: string;
  chatJid: string;
}): MessageActionRecord | undefined {
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

export function listOpenMessageActionsForGroup(groupFolder: string): MessageActionRecord[] {
  return listMessageActionsForGroup({
    groupFolder,
    includeSent: false,
    limit: 100,
  });
}
