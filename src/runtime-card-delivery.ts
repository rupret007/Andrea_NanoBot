import { classifyChannelDelivery } from './channel-delivery.js';
import type { SendMessageResult } from './types.js';

export interface RuntimeCardDeliveryResult {
  status: 'confirmed' | 'notification_blocked';
  deliveryOutcome: 'confirmed' | 'partial' | 'unknown' | 'rejected';
  platformMessageIds: string[];
  nextUnconfirmedChunkIndex?: number;
  errorClass?: string;
}

function boundedErrorClass(error: unknown): string {
  const raw = error instanceof Error ? error.name : typeof error;
  return raw.replace(/[^a-z0-9_.-]/gi, '').slice(0, 80) || 'unknown_error';
}

/**
 * Delivers a runtime card after the backend operation has already happened.
 * Notification failure must therefore never be reported as backend failure or
 * invite the user to repeat a create/follow-up/stop operation.
 */
export async function deliverRuntimeCardNotification(params: {
  send: () => Promise<SendMessageResult>;
}): Promise<RuntimeCardDeliveryResult> {
  let result: SendMessageResult;
  try {
    result = await params.send();
  } catch (error) {
    return {
      status: 'notification_blocked',
      deliveryOutcome: 'rejected',
      platformMessageIds: [],
      errorClass: boundedErrorClass(error),
    };
  }

  const classification = classifyChannelDelivery(result);
  const platformMessageIds = Array.from(
    new Set(
      [result.platformMessageId, ...(result.platformMessageIds || [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
  if (classification.outcome !== 'confirmed') {
    return {
      status: 'notification_blocked',
      deliveryOutcome: classification.outcome,
      platformMessageIds,
      nextUnconfirmedChunkIndex: classification.nextUnconfirmedChunkIndex,
    };
  }
  return {
    status: 'confirmed',
    deliveryOutcome: 'confirmed',
    platformMessageIds,
  };
}
