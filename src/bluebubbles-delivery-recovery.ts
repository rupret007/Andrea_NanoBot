import {
  getCompanionHandoff,
  getCompanionHandoffByProviderIdempotencyKey,
  storeChatMetadata,
  storeMessageDirect,
  updateCompanionHandoff,
} from './db.js';
import { syncOutcomeFromHandoffRecord } from './outcome-reviews.js';
import {
  reconcileBlueBubblesUnverifiedMessageActions,
  type BlueBubblesDeliveryReconciliationResult,
} from './message-actions.js';
import type { NewMessage } from './types.js';

export interface BlueBubblesOutboundEvidenceRecoveryResult {
  accepted: boolean;
  groupResults: Array<
    BlueBubblesDeliveryReconciliationResult & { groupFolder: string }
  >;
  inspected: number;
  reconciled: number;
  stillUnverified: number;
}

/**
 * Persists a BlueBubbles matched-message webhook and immediately reconciles
 * durable dispatch fences. Uncorrelated or non-outbound rows are ignored, and
 * reconciliation itself never sends.
 */
export function recordBlueBubblesOutboundDeliveryEvidence(params: {
  chatJid: string;
  message: NewMessage;
  groupFolders: readonly string[];
  now?: Date;
}): BlueBubblesOutboundEvidenceRecoveryResult {
  if (
    !params.message.is_from_me ||
    !params.message.provider_idempotency_key?.trim()
  ) {
    return {
      accepted: false,
      groupResults: [],
      inspected: 0,
      reconciled: 0,
      stillUnverified: 0,
    };
  }

  storeChatMetadata(
    params.chatJid,
    params.message.timestamp,
    // A matched outbound webhook describes the local sender (usually "You"),
    // not the remote recipient. Preserve any exact contact/conversation name
    // already attached to this chat instead of replacing it with sender data.
    undefined,
    'bluebubbles',
    false,
  );
  storeMessageDirect({
    ...params.message,
    is_from_me: true,
    message_ingress_origin: 'assistant_outbound',
  });

  const providerIdempotencyKey = params.message.provider_idempotency_key.trim();
  const handoff = getCompanionHandoffByProviderIdempotencyKey(
    providerIdempotencyKey,
  );
  const handoffInspected = handoff?.targetChannel === 'bluebubbles' ? 1 : 0;
  let handoffReconciled = 0;
  if (
    handoff?.targetChannel === 'bluebubbles' &&
    handoff.status === 'delivery_unverified'
  ) {
    updateCompanionHandoff(handoff.handoffId, {
      status: 'delivered',
      deliveredMessageId: params.message.id,
      errorText: null,
      updatedAt: (params.now || new Date()).toISOString(),
    });
    const reconciledHandoff = getCompanionHandoff(handoff.handoffId);
    if (reconciledHandoff) {
      syncOutcomeFromHandoffRecord(reconciledHandoff, params.now);
    }
    handoffReconciled = 1;
  }

  const groupResults = [...new Set(params.groupFolders.filter(Boolean))].map(
    (groupFolder) => ({
      groupFolder,
      ...reconcileBlueBubblesUnverifiedMessageActions({
        groupFolder,
        now: params.now,
      }),
    }),
  );
  return {
    accepted: true,
    groupResults,
    inspected:
      handoffInspected +
      groupResults.reduce((sum, result) => sum + result.inspected, 0),
    reconciled: groupResults.reduce(
      (sum, result) => sum + result.reconciled,
      handoffReconciled,
    ),
    stillUnverified: groupResults.reduce(
      (sum, result) => sum + result.stillUnverified,
      handoffInspected - handoffReconciled,
    ),
  };
}
