import { randomUUID } from 'crypto';

import {
  beginIngressBoundCompanionHandoffDispatch,
  getCompanionHandoff,
  purgeExpiredCompanionHandoffs,
  updateCompanionHandoff,
  upsertCompanionHandoff,
} from './db.js';
import { syncOutcomeFromHandoffRecord } from './outcome-reviews.js';
import {
  isChannelDeliveryRejectedBeforeDispatchError,
  isChannelDeliveryUnverifiedError,
  requireCompleteChannelDelivery,
} from './channel-delivery.js';
import { buildIngressBoundCompanionHandoffId } from './bluebubbles-ingress-dispatch.js';
import { canonicalizeBlueBubblesSelfThreadJid } from './bluebubbles-self-thread.js';
import type {
  ChannelArtifact,
  CompanionHandoffIngressAuthorization,
  CompanionHandoffPayload,
  CompanionHandoffRecord,
  SendArtifactOptions,
  SendMessageOptions,
  SendMessageResult,
} from './types.js';

export interface CompanionHandoffTarget {
  chatJid: string;
}

export interface CompanionHandoffDeps {
  resolveHandoffTarget?(
    groupFolder: string,
    targetChannel: CompanionHandoffRecord['targetChannel'],
  ): CompanionHandoffTarget | undefined | null;
  resolveTelegramMainChat(
    groupFolder: string,
  ): CompanionHandoffTarget | undefined | null;
  resolveBlueBubblesCompanionChat?(
    groupFolder: string,
  ): CompanionHandoffTarget | undefined | null;
  sendHandoffMessage?(
    targetChannel: CompanionHandoffRecord['targetChannel'],
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  sendTelegramMessage(
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  sendBlueBubblesMessage?(
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult>;
  sendHandoffArtifact?(
    targetChannel: CompanionHandoffRecord['targetChannel'],
    chatJid: string,
    artifact: ChannelArtifact,
    options?: SendArtifactOptions,
  ): Promise<SendMessageResult>;
  sendTelegramArtifact?(
    chatJid: string,
    artifact: ChannelArtifact,
    options?: SendArtifactOptions,
  ): Promise<SendMessageResult>;
  now?: () => Date;
}

export interface QueueCompanionHandoffParams {
  groupFolder: string;
  originChannel: CompanionHandoffRecord['originChannel'];
  targetChannel?: CompanionHandoffRecord['targetChannel'];
  capabilityId?: string;
  voiceSummary: string;
  payload: CompanionHandoffPayload;
  requiresConfirmation?: boolean;
  expiresInMs?: number;
  threadId?: string;
  taskId?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  missionId?: string;
  missionSummary?: string;
  missionSuggestedActionsJson?: string;
  missionBlockersJson?: string;
  missionStepFocusJson?: string;
  knowledgeSourceIds?: string[];
  workRef?: string;
  followupSuggestions?: string[];
  /** Required for an automatic Telegram-to-BlueBubbles self-thread handoff. */
  ingressAuthorization?: CompanionHandoffIngressAuthorization;
}

export interface CompanionHandoffDeliveryControl {
  /**
   * Called only after the durable delivery-unverified tombstone is committed
   * and before the provider boundary is crossed.
   */
  onDispatchQuarantined?: () => void;
}

export interface DeliverCompanionHandoffResult {
  ok: boolean;
  handoffId: string;
  status: CompanionHandoffRecord['status'];
  speech: string;
  targetChatJid?: string;
  platformMessageId?: string;
  confirmedReceiptCount?: number;
  nextUnconfirmedChunkIndex?: number;
  deliveryOutcome?: 'partial' | 'unknown';
  errorText?: string;
}

function renderTelegramHandoffText(payload: CompanionHandoffPayload): string {
  const normalizedText = payload.text.trim();
  if (!normalizedText && payload.title.trim()) {
    return payload.title.trim();
  }
  const title = payload.title.trim();
  if (!title) return normalizedText;
  const normalizedTitle = title.toLowerCase();
  const leadingWindow = normalizedText
    .slice(0, title.length + 12)
    .toLowerCase();
  if (leadingWindow.includes(normalizedTitle)) {
    return normalizedText;
  }
  return [`*${title}*`, normalizedText].filter(Boolean).join('\n\n');
}

function renderBlueBubblesHandoffText(
  payload: CompanionHandoffPayload,
): string {
  const title = payload.title.trim();
  const text = payload.text.replace(/[*_`]/g, '').trim();
  if (!text) return title;
  const normalizedTitle = title.toLowerCase();
  const leadingWindow = text.slice(0, title.length + 12).toLowerCase();
  if (!title || leadingWindow.includes(normalizedTitle)) {
    return text;
  }
  return [title, text].filter(Boolean).join('\n\n');
}

function renderCompanionHandoffText(
  targetChannel: CompanionHandoffRecord['targetChannel'],
  payload: CompanionHandoffPayload,
): string {
  if (targetChannel === 'bluebubbles') {
    return renderBlueBubblesHandoffText(payload);
  }
  return renderTelegramHandoffText(payload);
}

function getTargetLabel(
  targetChannel: CompanionHandoffRecord['targetChannel'],
): string {
  return targetChannel === 'bluebubbles' ? 'your messages' : 'Telegram';
}

function resolveHandoffTarget(
  deps: CompanionHandoffDeps,
  groupFolder: string,
  targetChannel: CompanionHandoffRecord['targetChannel'],
): CompanionHandoffTarget | undefined | null {
  if (deps.resolveHandoffTarget) {
    return deps.resolveHandoffTarget(groupFolder, targetChannel);
  }
  if (targetChannel === 'bluebubbles') {
    return deps.resolveBlueBubblesCompanionChat?.(groupFolder);
  }
  return deps.resolveTelegramMainChat(groupFolder);
}

function sendHandoffMessage(
  deps: CompanionHandoffDeps,
  targetChannel: CompanionHandoffRecord['targetChannel'],
  chatJid: string,
  text: string,
  options?: SendMessageOptions,
): Promise<SendMessageResult> {
  if (deps.sendHandoffMessage) {
    return options
      ? deps.sendHandoffMessage(targetChannel, chatJid, text, options)
      : deps.sendHandoffMessage(targetChannel, chatJid, text);
  }
  if (targetChannel === 'bluebubbles') {
    if (!deps.sendBlueBubblesMessage) {
      throw new Error('BlueBubbles handoff delivery is unavailable.');
    }
    return options
      ? deps.sendBlueBubblesMessage(chatJid, text, options)
      : deps.sendBlueBubblesMessage(chatJid, text);
  }
  return options
    ? deps.sendTelegramMessage(chatJid, text, options)
    : deps.sendTelegramMessage(chatJid, text);
}

function sendHandoffArtifact(
  deps: CompanionHandoffDeps,
  targetChannel: CompanionHandoffRecord['targetChannel'],
  chatJid: string,
  artifact: ChannelArtifact,
  options?: SendArtifactOptions,
): Promise<SendMessageResult> {
  if (deps.sendHandoffArtifact) {
    return deps.sendHandoffArtifact(targetChannel, chatJid, artifact, options);
  }
  if (targetChannel === 'bluebubbles') {
    throw new Error('BlueBubbles artifact delivery is unavailable.');
  }
  if (!deps.sendTelegramArtifact) {
    throw new Error('Telegram artifact delivery is unavailable.');
  }
  return deps.sendTelegramArtifact(chatJid, artifact, options);
}

function buildCompanionHandoffRecord(
  params: QueueCompanionHandoffParams,
  now: Date,
  resolvedTargetChatJid?: string | null,
): CompanionHandoffRecord {
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (params.expiresInMs || 6 * 60 * 60 * 1000),
  ).toISOString();
  const ingressBoundBlueBubblesHandoff =
    params.originChannel === 'telegram' &&
    (params.targetChannel || 'telegram') === 'bluebubbles' &&
    params.ingressAuthorization &&
    resolvedTargetChatJid
      ? {
          ingress: params.ingressAuthorization,
          handoffId: buildIngressBoundCompanionHandoffId({
            sourceChatJid: params.ingressAuthorization.sourceChatJid,
            sourceMessageId: params.ingressAuthorization.sourceMessageId,
            sourceReceivedAt: params.ingressAuthorization.sourceReceivedAt,
            targetChatJid:
              canonicalizeBlueBubblesSelfThreadJid(resolvedTargetChatJid) ||
              resolvedTargetChatJid,
          }),
        }
      : null;
  return {
    handoffId: ingressBoundBlueBubblesHandoff?.handoffId || randomUUID(),
    groupFolder: params.groupFolder,
    originChannel: params.originChannel,
    targetChannel: params.targetChannel || 'telegram',
    targetChatJid: resolvedTargetChatJid || null,
    capabilityId: params.capabilityId || null,
    voiceSummary: params.voiceSummary,
    richPayloadJson: JSON.stringify(params.payload),
    status: 'queued',
    createdAt,
    expiresAt,
    updatedAt: createdAt,
    requiresConfirmation: params.requiresConfirmation === true,
    threadId: params.threadId || null,
    taskId: params.taskId || null,
    communicationThreadId: params.communicationThreadId || null,
    communicationSubjectIdsJson:
      params.communicationSubjectIds &&
      params.communicationSubjectIds.length > 0
        ? JSON.stringify(params.communicationSubjectIds)
        : null,
    communicationLifeThreadIdsJson:
      params.communicationLifeThreadIds &&
      params.communicationLifeThreadIds.length > 0
        ? JSON.stringify(params.communicationLifeThreadIds)
        : null,
    lastCommunicationSummary: params.lastCommunicationSummary || null,
    missionId: params.missionId || null,
    missionSummary: params.missionSummary || null,
    missionSuggestedActionsJson: params.missionSuggestedActionsJson || null,
    missionBlockersJson: params.missionBlockersJson || null,
    missionStepFocusJson: params.missionStepFocusJson || null,
    knowledgeSourceIdsJson:
      params.knowledgeSourceIds && params.knowledgeSourceIds.length > 0
        ? JSON.stringify(params.knowledgeSourceIds)
        : null,
    workRef: params.workRef || null,
    followupSuggestionsJson:
      params.followupSuggestions && params.followupSuggestions.length > 0
        ? JSON.stringify(params.followupSuggestions)
        : null,
    sourceChatJid:
      ingressBoundBlueBubblesHandoff?.ingress.sourceChatJid || null,
    sourceMessageId:
      ingressBoundBlueBubblesHandoff?.ingress.sourceMessageId || null,
    sourceIngressReceivedAt:
      ingressBoundBlueBubblesHandoff?.ingress.sourceReceivedAt || null,
    outboundAuthorizationAt:
      ingressBoundBlueBubblesHandoff?.ingress.authorizationAt || null,
    outboundPauseGeneration:
      ingressBoundBlueBubblesHandoff?.ingress.pauseGeneration ?? null,
    providerIdempotencyKey: ingressBoundBlueBubblesHandoff?.handoffId || null,
    dispatchStartedAt: null,
    deliveredMessageId: null,
    errorText: null,
  };
}

export function queueCompanionHandoff(
  params: QueueCompanionHandoffParams,
  now = new Date(),
): CompanionHandoffRecord {
  const record = buildCompanionHandoffRecord(params, now);
  upsertCompanionHandoff(record);
  syncOutcomeFromHandoffRecord(record, now);
  return record;
}

function isValidIngressBoundBlueBubblesHandoff(
  params: QueueCompanionHandoffParams,
): params is QueueCompanionHandoffParams & {
  ingressAuthorization: CompanionHandoffIngressAuthorization;
} {
  const ingress = params.ingressAuthorization;
  return Boolean(
    ingress &&
    ingress.sourceChatJid.trim().startsWith('tg:') &&
    ingress.sourceMessageId.trim() &&
    Number.isFinite(Date.parse(ingress.sourceReceivedAt)) &&
    Number.isFinite(Date.parse(ingress.authorizationAt)) &&
    Number.isSafeInteger(ingress.pauseGeneration) &&
    ingress.pauseGeneration >= 0,
  );
}

function sameIngressBoundHandoff(
  existing: CompanionHandoffRecord,
  expected: CompanionHandoffRecord,
): boolean {
  return (
    existing.handoffId === expected.handoffId &&
    existing.groupFolder === expected.groupFolder &&
    existing.originChannel === expected.originChannel &&
    existing.targetChannel === expected.targetChannel &&
    existing.targetChatJid === expected.targetChatJid &&
    existing.richPayloadJson === expected.richPayloadJson &&
    existing.sourceChatJid === expected.sourceChatJid &&
    existing.sourceMessageId === expected.sourceMessageId &&
    existing.sourceIngressReceivedAt === expected.sourceIngressReceivedAt &&
    existing.outboundAuthorizationAt === expected.outboundAuthorizationAt &&
    existing.outboundPauseGeneration === expected.outboundPauseGeneration &&
    existing.providerIdempotencyKey === expected.providerIdempotencyKey
  );
}

function existingHandoffResult(
  record: CompanionHandoffRecord,
): DeliverCompanionHandoffResult {
  if (record.status === 'delivered') {
    return {
      ok: true,
      handoffId: record.handoffId,
      status: record.status,
      speech: `Okay. The fuller version is already in ${getTargetLabel(record.targetChannel)}.`,
      targetChatJid: record.targetChatJid || undefined,
      platformMessageId: record.deliveredMessageId || undefined,
    };
  }
  return {
    ok: false,
    handoffId: record.handoffId,
    status: record.status,
    speech:
      record.status === 'delivery_unverified'
        ? `I could not verify whether that ${getTargetLabel(record.targetChannel)} handoff arrived. I will not retry it automatically.`
        : `That ${getTargetLabel(record.targetChannel)} handoff is already terminal and will not be retried automatically.`,
    targetChatJid: record.targetChatJid || undefined,
    platformMessageId: record.deliveredMessageId || undefined,
    errorText: record.errorText || undefined,
  };
}

export async function deliverCompanionHandoff(
  params: QueueCompanionHandoffParams,
  deps: CompanionHandoffDeps,
  control: CompanionHandoffDeliveryControl = {},
): Promise<DeliverCompanionHandoffResult> {
  const now = deps.now ? deps.now() : new Date();
  purgeExpiredCompanionHandoffs(now.toISOString());
  const targetChannel = params.targetChannel || 'telegram';
  const target = resolveHandoffTarget(deps, params.groupFolder, targetChannel);
  const requiresIngressBoundBlueBubblesDispatch =
    params.originChannel === 'telegram' && targetChannel === 'bluebubbles';
  if (
    requiresIngressBoundBlueBubblesDispatch &&
    !isValidIngressBoundBlueBubblesHandoff(params)
  ) {
    const record = queueCompanionHandoff(params, now);
    const errorText =
      'Telegram-to-BlueBubbles handoff is missing an immutable owner-ingress authorization fence.';
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: now.toISOString(),
    });
    return {
      ok: false,
      handoffId: record.handoffId,
      status: 'failed',
      speech:
        'I did not hand that off to Messages because the original Telegram turn was not durably bound.',
      errorText,
    };
  }
  const proposedRecord = buildCompanionHandoffRecord(
    params,
    now,
    target?.chatJid,
  );
  let record = getCompanionHandoff(proposedRecord.handoffId);
  if (!record) {
    const inserted = upsertCompanionHandoff(proposedRecord, {
      insertOnly: true,
    });
    record = inserted
      ? proposedRecord
      : getCompanionHandoff(proposedRecord.handoffId);
  }
  if (!record) {
    throw new Error('Companion handoff could not be durably inserted.');
  }
  if (record === proposedRecord) {
    syncOutcomeFromHandoffRecord(proposedRecord, now);
  }
  if (!sameIngressBoundHandoff(record, proposedRecord)) {
    return {
      ok: false,
      handoffId: record.handoffId,
      status: record.status,
      speech:
        'I did not retry that Messages handoff because its durable ingress binding no longer matches.',
      targetChatJid: record.targetChatJid || undefined,
      errorText:
        'Ingress-bound handoff replay did not match its durable record.',
    };
  }
  if (record.status !== 'queued') {
    return existingHandoffResult(record);
  }
  if (!target?.chatJid) {
    const errorText =
      targetChannel === 'bluebubbles'
        ? 'No configured BlueBubbles owner self-thread is available for this account.'
        : 'No registered main Telegram chat is available for this linked account.';
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: now.toISOString(),
    });
    const updated = getCompanionHandoff(record.handoffId);
    if (updated) syncOutcomeFromHandoffRecord(updated, now);
    return {
      ok: false,
      handoffId: record.handoffId,
      status: 'failed',
      speech:
        targetChannel === 'bluebubbles'
          ? 'I do not have a configured Messages self-thread for your account yet.'
          : 'I do not have a main Telegram chat set up for this account yet.',
      errorText,
    };
  }

  updateCompanionHandoff(record.handoffId, {
    targetChatJid: target.chatJid,
    updatedAt: now.toISOString(),
  });
  const targetedRecord = getCompanionHandoff(record.handoffId);
  if (targetedRecord) syncOutcomeFromHandoffRecord(targetedRecord, now);

  const payload = params.payload;
  let crashSafeBlueBubblesDispatchStarted = false;
  try {
    if (
      payload.kind === 'artifact' &&
      payload.artifact &&
      targetChannel === 'bluebubbles'
    ) {
      const errorText =
        'BlueBubbles V1 only supports text handoffs. Use Telegram for artifacts.';
      updateCompanionHandoff(record.handoffId, {
        status: 'failed',
        errorText,
        updatedAt: new Date().toISOString(),
      });
      const updated = getCompanionHandoff(record.handoffId);
      if (updated) syncOutcomeFromHandoffRecord(updated);
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'failed',
        speech: 'I can only send that artifact on Telegram right now.',
        errorText,
        targetChatJid: target.chatJid,
      };
    }
    if (requiresIngressBoundBlueBubblesDispatch) {
      const dispatchStartedAt = new Date().toISOString();
      const errorText =
        'BlueBubbles dispatch crossed its durable write-ahead fence; delivery is unverified until an exact provider receipt is recorded. Automatic retry is blocked.';
      if (
        !beginIngressBoundCompanionHandoffDispatch({
          handoffId: record.handoffId,
          targetChatJid: target.chatJid,
          dispatchStartedAt,
          errorText,
        })
      ) {
        const concurrent = getCompanionHandoff(record.handoffId);
        if (concurrent) return existingHandoffResult(concurrent);
        throw new Error('Companion handoff dispatch claim disappeared.');
      }
      const quarantined = getCompanionHandoff(record.handoffId);
      if (quarantined) syncOutcomeFromHandoffRecord(quarantined);
      crashSafeBlueBubblesDispatchStarted = true;
      control.onDispatchQuarantined?.();
    }
    const ingressAuthorization = params.ingressAuthorization;
    const messageOptions = requiresIngressBoundBlueBubblesDispatch
      ? {
          idempotencyKey: record.providerIdempotencyKey || undefined,
          blueBubblesAuthorizationAt:
            ingressAuthorization?.authorizationAt || '',
          blueBubblesPauseGeneration:
            ingressAuthorization?.pauseGeneration ?? -1,
        }
      : undefined;
    const delivery = requireCompleteChannelDelivery(
      payload.kind === 'artifact' && payload.artifact
        ? await sendHandoffArtifact(
            deps,
            targetChannel,
            target.chatJid,
            payload.artifact,
            {
              caption:
                payload.caption?.trim() ||
                payload.text.trim() ||
                payload.title.trim() ||
                undefined,
            },
          )
        : await sendHandoffMessage(
            deps,
            targetChannel,
            target.chatJid,
            renderCompanionHandoffText(targetChannel, payload),
            messageOptions,
          ),
    );
    const platformMessageId =
      delivery.platformMessageId || delivery.platformMessageIds?.[0];
    updateCompanionHandoff(record.handoffId, {
      status: 'delivered',
      deliveredMessageId: platformMessageId,
      errorText: null,
      updatedAt: new Date().toISOString(),
    });
    const updated = getCompanionHandoff(record.handoffId);
    if (updated) syncOutcomeFromHandoffRecord(updated);
    return {
      ok: true,
      handoffId: record.handoffId,
      status: 'delivered',
      speech:
        payload.kind === 'artifact'
          ? `Okay. I sent the image to ${getTargetLabel(targetChannel)}.`
          : `Okay. I sent the fuller version to ${getTargetLabel(targetChannel)}.`,
      targetChatJid: target.chatJid,
      platformMessageId,
    };
  } catch (error) {
    if (isChannelDeliveryUnverifiedError(error)) {
      const evidence = error.evidence;
      const platformMessageId = evidence.confirmedReceiptIds[0];
      const nextChunkEvidence = Number.isInteger(
        evidence.nextUnconfirmedChunkIndex,
      )
        ? `; next_unconfirmed_chunk_index=${evidence.nextUnconfirmedChunkIndex}`
        : '';
      const errorText =
        `Delivery unverified (${evidence.outcome}; ` +
        `confirmed_receipts=${evidence.confirmedReceiptCount}${nextChunkEvidence}). ` +
        'Automatic retry is blocked; verify the target conversation before any new send.';
      updateCompanionHandoff(record.handoffId, {
        status: 'delivery_unverified',
        deliveredMessageId: platformMessageId || null,
        errorText,
        updatedAt: new Date().toISOString(),
      });
      const updated = getCompanionHandoff(record.handoffId);
      if (updated) syncOutcomeFromHandoffRecord(updated);
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'delivery_unverified',
        speech: `I could not verify whether the ${getTargetLabel(targetChannel)} handoff arrived in whole or in part. I will not retry it because that could create a duplicate.`,
        errorText,
        targetChatJid: target.chatJid,
        platformMessageId,
        confirmedReceiptCount: evidence.confirmedReceiptCount,
        nextUnconfirmedChunkIndex: evidence.nextUnconfirmedChunkIndex,
        deliveryOutcome: evidence.outcome,
      };
    }
    if (
      crashSafeBlueBubblesDispatchStarted &&
      !isChannelDeliveryRejectedBeforeDispatchError(error)
    ) {
      const errorText =
        'BlueBubbles delivery may have crossed the provider boundary. Automatic retry is blocked pending an exact receipt.';
      updateCompanionHandoff(record.handoffId, {
        status: 'delivery_unverified',
        errorText,
        updatedAt: new Date().toISOString(),
      });
      const updated = getCompanionHandoff(record.handoffId);
      if (updated) syncOutcomeFromHandoffRecord(updated);
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'delivery_unverified',
        speech: `I could not verify whether the ${getTargetLabel(targetChannel)} handoff arrived. I will not retry it because that could create a duplicate.`,
        errorText,
        targetChatJid: target.chatJid,
      };
    }
    const errorText =
      error instanceof Error
        ? error.message
        : `Unknown ${getTargetLabel(targetChannel)} delivery error`;
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: new Date().toISOString(),
    });
    const updated = getCompanionHandoff(record.handoffId);
    if (updated) syncOutcomeFromHandoffRecord(updated);
    return {
      ok: false,
      handoffId: record.handoffId,
      status: 'failed',
      speech: `I could not send that to ${getTargetLabel(targetChannel)} just now.`,
      errorText,
      targetChatJid: target.chatJid,
    };
  }
}

export function cancelCompanionHandoff(
  handoffId: string,
  reason?: string,
): CompanionHandoffRecord | undefined {
  const record = getCompanionHandoff(handoffId);
  if (!record) return undefined;
  if (record.status === 'delivery_unverified') {
    return record;
  }
  updateCompanionHandoff(handoffId, {
    status: 'cancelled',
    errorText: reason || record.errorText || null,
    updatedAt: new Date().toISOString(),
  });
  const updated = getCompanionHandoff(handoffId);
  if (updated) syncOutcomeFromHandoffRecord(updated);
  return updated;
}
