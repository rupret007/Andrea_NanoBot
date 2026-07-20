import {
  classifyChannelDelivery,
  isChannelDeliveryUnverifiedError,
} from './channel-delivery.js';
import { CommittedIncompleteDeliveryError } from './interaction-delivery-metrics.js';
import type { SendMessageResult } from './types.js';

/**
 * Delivers a response produced from durable actionable ingress and crosses the
 * claim boundary only when the provider returned delivery evidence. A proven
 * pre-effect failure is allowed to bubble so the caller can release the claim;
 * partial or transport-ambiguous evidence is committed and fenced from replay.
 */
export async function deliverQueuedResponseWithIngressCommit(params: {
  send: () => Promise<SendMessageResult>;
  onPrimaryDeliveryCommitted: () => void;
  /**
   * BlueBubbles self-thread replies cannot atomically commit provider
   * acceptance with the local ingress claim. Quarantine the ingress before
   * dispatch so a hard kill can lose delivery certainty, but never replay it.
   */
  quarantineBeforeDispatch?: boolean;
}): Promise<SendMessageResult> {
  let committed = false;
  const commit = () => {
    if (committed) return;
    params.onPrimaryDeliveryCommitted();
    committed = true;
  };
  if (params.quarantineBeforeDispatch) {
    commit();
  }
  let result: SendMessageResult;
  try {
    result = await params.send();
  } catch (error) {
    if (!isChannelDeliveryUnverifiedError(error)) {
      throw error;
    }
    commit();
    throw new CommittedIncompleteDeliveryError({
      deliveryOutcome: error.evidence.outcome,
      confirmedReceiptCount: error.evidence.confirmedReceiptCount,
      nextUnconfirmedChunkIndex: error.evidence.nextUnconfirmedChunkIndex,
    });
  }

  const delivery = classifyChannelDelivery(result);
  if (delivery.outcome === 'rejected') {
    throw new Error('Queued response delivery returned no confirmed receipt.');
  }

  commit();
  if (delivery.outcome !== 'confirmed') {
    throw new CommittedIncompleteDeliveryError({
      deliveryOutcome: delivery.outcome,
      confirmedReceiptCount: delivery.confirmedReceiptCount,
      nextUnconfirmedChunkIndex: delivery.nextUnconfirmedChunkIndex,
    });
  }

  return result;
}
