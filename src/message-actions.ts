import { randomUUID } from 'crypto';

import {
  createTask,
  getCommunicationThread,
  getMessageAction,
  getMessageActionBySource,
  findLatestOpenMessageActionForChat,
  listMessageActionsForGroup,
  updateMessageAction,
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
  | { kind: 'remind_instead'; timingHint?: string | null }
  | { kind: 'save_to_thread' }
  | { kind: 'rewrite'; style: 'shorter' | 'warmer' | 'more_direct' }
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

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
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

function buildActionLead(record: MessageActionRecord): string {
  switch (record.sendStatus) {
    case 'sent':
      return 'Andrea: I sent that.';
    case 'deferred':
      return 'Andrea: I saved that to send later.';
    case 'failed':
      return "Andrea: I couldn't send that right now.";
    case 'approved':
      return 'Andrea: This is ready to go.';
    case 'skipped':
      return 'Andrea: Okay — I left that unsent.';
    case 'drafted':
    default:
      return 'Andrea: I drafted a reply.';
  }
}

function buildStatusLine(record: MessageActionRecord): string {
  if (record.sendStatus === 'deferred' && record.followupAt) {
    return `Status: saved to revisit around ${record.followupAt}.`;
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

function nextStepLine(record: MessageActionRecord): string {
  if (record.sendStatus === 'sent') {
    return 'Next: review it later if you want to track the follow-through.';
  }
  if (record.sendStatus === 'deferred') {
    return 'Next: I can show the draft again, remind you instead, or send it when you are ready.';
  }
  return 'Next: send it, send it later, remind me instead, or keep editing it.';
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
    'Draft:',
    record.draftText,
    '',
    buildStatusLine(record),
  ];
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
  const explicit =
    normalized.match(/^send it later (.+)$/)?.[1] ||
    normalized.match(/^send it (?:around|at|tomorrow|tonight) (.+)$/)?.[1] ||
    normalized.match(/^remind me later (.+)$/)?.[1];
  return explicit ? explicit.trim() : null;
}

export function interpretMessageActionFollowup(
  rawText: string,
): MessageActionOperation | null {
  const normalized = normalizeText(rawText).toLowerCase();
  if (!normalized) return null;
  if (/^(show (?:the )?draft|show it again)$/.test(normalized)) {
    return { kind: 'show_draft' };
  }
  if (/^send it again$/.test(normalized)) {
    return { kind: 'send_again' };
  }
  if (/^(send it|send now|send that)$/.test(normalized)) {
    return { kind: 'send' };
  }
  if (/^send it later\b/.test(normalized)) {
    return { kind: 'defer', timingHint: parseTimingHintFromUtterance(rawText) };
  }
  if (/^(remind me later|remind me instead)\b/.test(normalized)) {
    return {
      kind: 'remind_instead',
      timingHint: parseTimingHintFromUtterance(rawText),
    };
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

async function persistDeferredReminder(params: {
  action: MessageActionRecord;
  timingHint?: string | null;
  deps: MessageActionExecutionDeps;
  now: Date;
  reminderOnly: boolean;
}): Promise<{ replyText: string; updatedAction: MessageActionRecord }> {
  const hint = params.timingHint || 'tomorrow morning';
  const planned = planContextualReminder(
    hint,
    'Revisit this draft reply',
    params.action.groupFolder,
    params.action.presentationChatJid || params.deps.chatJid,
    params.now,
  );
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
  updateMessageAction(params.action.messageActionId, {
    sendStatus: 'deferred',
    followupAt: planned.task.next_run || null,
    linkedRefsJson: JSON.stringify(linkedRefs),
    lastUpdatedAt: params.now.toISOString(),
  });
  const updatedAction = getMessageAction(params.action.messageActionId) || params.action;
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
  return {
    replyText: params.reminderOnly
      ? `Andrea: I’ll remind you about that ${hint}.`
      : `Andrea: I saved that to send later and I’ll bring it back ${hint}.`,
    updatedAction,
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
    updateMessageAction(action.messageActionId, {
      draftText: rewriteDraft(action.draftText, operation.style),
      sendStatus: action.sendStatus === 'failed' ? 'drafted' : action.sendStatus,
      lastUpdatedAt: now.toISOString(),
    });
    const updatedAction = getMessageAction(action.messageActionId) || action;
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    return {
      handled: true,
      action: updatedAction,
      presentation: buildMessageActionPresentation(
        updatedAction,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
      replyText:
        operation.style === 'shorter'
          ? 'Andrea: I tightened it up.'
          : operation.style === 'warmer'
            ? 'Andrea: I made it warmer.'
            : 'Andrea: I made it more direct.',
    };
  }

  if (operation.kind === 'skip') {
    if (action.delegationRuleId) {
      recordDelegationRuleOverride(action.delegationRuleId, now);
    }
    updateMessageAction(action.messageActionId, {
      sendStatus: 'skipped',
      lastUpdatedAt: now.toISOString(),
    });
    const updatedAction = getMessageAction(action.messageActionId) || action;
    syncOutcomeFromMessageActionRecord(updatedAction, now);
    return {
      handled: true,
      action: updatedAction,
      replyText: 'Andrea: Okay — I left that unsent.',
      presentation: buildMessageActionPresentation(
        updatedAction,
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
    return {
      handled: Boolean(result.handled),
      action,
      replyText:
        result.responseText || 'Andrea: I saved that under the thread.',
      presentation: buildMessageActionPresentation(
        action,
        deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
      ),
    };
  }

  if (operation.kind === 'defer' || operation.kind === 'remind_instead') {
    const deferred = await persistDeferredReminder({
      action,
      timingHint: operation.timingHint || null,
      deps,
      now,
      reminderOnly: operation.kind === 'remind_instead',
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
    const target = parseTarget(action);
    try {
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
      const receipt = await deps.sendToTarget(
        action.targetChannel,
        target.chatJid,
        action.draftText,
        sendOptions,
      );
      updateMessageAction(action.messageActionId, {
        sendStatus: 'sent',
        requiresApproval: false,
        platformMessageId:
          receipt.platformMessageId ||
          receipt.platformMessageIds?.[0] ||
          null,
        sentAt: now.toISOString(),
        lastUpdatedAt: now.toISOString(),
      });
      const updatedAction = getMessageAction(action.messageActionId) || action;
      if (updatedAction.delegationRuleId) {
        recordDelegationRuleUsage({
          ruleId: updatedAction.delegationRuleId,
          autoApplied:
            updatedAction.delegationMode === 'auto_apply_when_safe' &&
            action.trustLevel === 'delegated_safe_send',
          outcomeStatus: 'completed',
          now,
        });
      }
      syncOutcomeFromMessageActionRecord(updatedAction, now);
      return {
        handled: true,
        action: updatedAction,
        replyText: describeSendSuccess(updatedAction, target),
        presentation: buildMessageActionPresentation(
          updatedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    } catch {
      updateMessageAction(action.messageActionId, {
        sendStatus: 'failed',
        lastUpdatedAt: now.toISOString(),
      });
      const updatedAction = getMessageAction(action.messageActionId) || action;
      if (updatedAction.delegationRuleId) {
        recordDelegationRuleUsage({
          ruleId: updatedAction.delegationRuleId,
          autoApplied:
            updatedAction.delegationMode === 'auto_apply_when_safe' &&
            action.trustLevel === 'delegated_safe_send',
          outcomeStatus: 'failed',
          now,
        });
      }
      syncOutcomeFromMessageActionRecord(updatedAction, now);
      return {
        handled: true,
        action: updatedAction,
        replyText: humanSendFailure(),
        presentation: buildMessageActionPresentation(
          updatedAction,
          deps.channel === 'bluebubbles' ? 'bluebubbles' : 'telegram',
        ),
      };
    }
  }

  return { handled: false };
}

export function findLatestChatMessageAction(params: {
  groupFolder: string;
  chatJid: string;
}): MessageActionRecord | undefined {
  return findLatestOpenMessageActionForChat({
    groupFolder: params.groupFolder,
    chatJid: params.chatJid,
  });
}

export function listOpenMessageActionsForGroup(groupFolder: string): MessageActionRecord[] {
  return listMessageActionsForGroup({
    groupFolder,
    includeSent: false,
    limit: 100,
  });
}
