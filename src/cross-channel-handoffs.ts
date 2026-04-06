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
): Promise<SendMessageResult> {
  if (deps.sendHandoffMessage) {
    return deps.sendHandoffMessage(targetChannel, chatJid, text);
  }
  if (targetChannel === 'bluebubbles') {
    if (!deps.sendBlueBubblesMessage) {
      throw new Error('BlueBubbles handoff delivery is unavailable.');
    }
    return deps.sendBlueBubblesMessage(chatJid, text);
  }
  return deps.sendTelegramMessage(chatJid, text);
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
): CompanionHandoffRecord {
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + (params.expiresInMs || 6 * 60 * 60 * 1000),
  ).toISOString();
  return {
    handoffId: randomUUID(),
    groupFolder: params.groupFolder,
    originChannel: params.originChannel,
    targetChannel: params.targetChannel || 'telegram',
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
  const targetChannel = params.targetChannel || 'telegram';
  const target = resolveHandoffTarget(deps, params.groupFolder, targetChannel);
  if (!target?.chatJid) {
    const errorText =
      targetChannel === 'bluebubbles'
        ? 'No linked BlueBubbles companion chat is available for this account.'
        : 'No registered main Telegram chat is available for this linked account.';
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
        targetChannel === 'bluebubbles'
          ? 'I do not have a linked BlueBubbles messages thread set up for this account yet.'
          : 'I do not have a main Telegram chat set up for this account yet.',
      errorText,
    };
  }

  updateCompanionHandoff(record.handoffId, {
    targetChatJid: target.chatJid,
    updatedAt: now.toISOString(),
  });

  const payload = params.payload;
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
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'failed',
        speech: 'I can only send that artifact on Telegram right now.',
        errorText,
        targetChatJid: target.chatJid,
      };
    }
    const delivery =
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
          );
    if (!delivery.platformMessageId && !delivery.platformMessageIds?.length) {
      const errorText = `${getTargetLabel(targetChannel)} did not return a delivery receipt.`;
      updateCompanionHandoff(record.handoffId, {
        status: 'failed',
        errorText,
        updatedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        handoffId: record.handoffId,
        status: 'failed',
        speech: `I could not send that to ${getTargetLabel(targetChannel)} just now.`,
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
          ? `Okay. I sent it to ${getTargetLabel(targetChannel)}.`
          : `Okay. I sent the details to ${getTargetLabel(targetChannel)}.`,
      targetChatJid: target.chatJid,
      platformMessageId,
    };
  } catch (error) {
    const errorText =
      error instanceof Error
        ? error.message
        : `Unknown ${getTargetLabel(targetChannel)} delivery error`;
    updateCompanionHandoff(record.handoffId, {
      status: 'failed',
      errorText,
      updatedAt: new Date().toISOString(),
    });
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
  updateCompanionHandoff(handoffId, {
    status: 'cancelled',
    errorText: reason || record.errorText || null,
    updatedAt: new Date().toISOString(),
  });
  return getCompanionHandoff(handoffId);
}
