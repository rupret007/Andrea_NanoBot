import { randomUUID } from 'crypto';

import {
  getCompanionHandoff,
  purgeExpiredCompanionHandoffs,
  updateCompanionHandoff,
  upsertCompanionHandoff,
} from './db.js';
import type {
  ChannelArtifact,
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
  resolveTelegramMainChat(
    groupFolder: string,
  ): CompanionHandoffTarget | undefined | null;
  sendTelegramMessage(
    chatJid: string,
    text: string,
    options?: SendMessageOptions,
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
  capabilityId?: string;
  voiceSummary: string;
  payload: CompanionHandoffPayload;
  requiresConfirmation?: boolean;
  expiresInMs?: number;
  threadId?: string;
  taskId?: string;
  knowledgeSourceIds?: string[];
  workRef?: string;
  followupSuggestions?: string[];
}

export interface DeliverCompanionHandoffResult {
  ok: boolean;
  handoffId: string;
  status: CompanionHandoffRecord['status'];
  speech: string;
  targetChatJid?: string;
  platformMessageId?: string;
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
  const leadingWindow = normalizedText.slice(0, title.length + 12).toLowerCase();
  if (leadingWindow.includes(normalizedTitle)) {
    return normalizedText;
  }
  return [`*${title}*`, normalizedText].filter(Boolean).join('\n\n');
}

function buildCompanionHandoffRecord(
  params: QueueCompanionHandoffParams,
  now: Date,
): CompanionHandoffRecord {
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (params.expiresInMs || 6 * 60 * 60 * 1000),
  ).toISOString();
  return {
    handoffId: randomUUID(),
    groupFolder: params.groupFolder,
    originChannel: params.originChannel,
    targetChannel: 'telegram',
    targetChatJid: null,
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
    knowledgeSourceIdsJson:
      params.knowledgeSourceIds && params.knowledgeSourceIds.length > 0
        ? JSON.stringify(params.knowledgeSourceIds)
        : null,
    workRef: params.workRef || null,
    followupSuggestionsJson:
      params.followupSuggestions && params.followupSuggestions.length > 0
        ? JSON.stringify(params.followupSuggestions)
        : null,
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
  return record;
}

export async function deliverCompanionHandoff(
  params: QueueCompanionHandoffParams,
  deps: CompanionHandoffDeps,
): Promise<DeliverCompanionHandoffResult> {
  const now = deps.now ? deps.now() : new Date();
  purgeExpiredCompanionHandoffs(now.toISOString());
  const record = queueCompanionHandoff(params, now);
  const target = deps.resolveTelegramMainChat(params.groupFolder);
  if (!target?.chatJid) {
    const errorText =
      'No registered main Telegram chat is available for this linked account.';
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: now.toISOString(),
    });
    return {
      ok: false,
      handoffId: record.handoffId,
      status: 'failed',
      speech: 'I do not have a main Telegram chat set up for this account yet.',
      errorText,
    };
  }

  updateCompanionHandoff(record.handoffId, {
    targetChatJid: target.chatJid,
    updatedAt: now.toISOString(),
  });

  const payload = params.payload;
  try {
    const delivery =
      payload.kind === 'artifact' && payload.artifact && deps.sendTelegramArtifact
        ? await deps.sendTelegramArtifact(target.chatJid, payload.artifact, {
            caption:
              payload.caption?.trim() ||
              payload.text.trim() ||
              payload.title.trim() ||
              undefined,
          })
        : await deps.sendTelegramMessage(
            target.chatJid,
            renderTelegramHandoffText(payload),
          );
    if (!delivery.platformMessageId && !delivery.platformMessageIds?.length) {
      const errorText = 'Telegram did not return a delivery receipt.';
      updateCompanionHandoff(record.handoffId, {
        status: 'failed',
        errorText,
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'failed',
        speech: 'I could not send that to Telegram just now.',
        errorText,
        targetChatJid: target.chatJid,
      };
    }
    const platformMessageId =
      delivery.platformMessageId || delivery.platformMessageIds?.[0];
    updateCompanionHandoff(record.handoffId, {
      status: 'delivered',
      deliveredMessageId: platformMessageId,
      errorText: null,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      handoffId: record.handoffId,
      status: 'delivered',
      speech:
        payload.kind === 'artifact'
          ? 'Okay. I sent it to Telegram.'
          : 'Okay. I sent the details to Telegram.',
      targetChatJid: target.chatJid,
      platformMessageId,
    };
  } catch (error) {
    const errorText =
      error instanceof Error ? error.message : 'Unknown Telegram delivery error';
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: new Date().toISOString(),
    });
    return {
      ok: false,
      handoffId: record.handoffId,
      status: 'failed',
      speech: 'I could not send that to Telegram just now.',
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
  updateCompanionHandoff(handoffId, {
    status: 'cancelled',
    errorText: reason || record.errorText || null,
    updatedAt: new Date().toISOString(),
  });
  return getCompanionHandoff(handoffId);
}
