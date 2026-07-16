import type { SendMessageResult } from './types.js';

export interface ChannelDeliveryClassification {
  outcome: 'confirmed' | 'partial' | 'unknown' | 'rejected';
  confirmedReceiptIds: string[];
  confirmedReceiptCount: number;
  nextUnconfirmedChunkIndex?: number;
}

export interface ChannelDeliveryUnverifiedEvidence {
  outcome: 'partial' | 'unknown';
  confirmedReceiptIds: string[];
  confirmedReceiptCount: number;
  nextUnconfirmedChunkIndex?: number;
}

export interface ChannelDeliveryRejectedBeforeDispatchEvidence {
  outcome: 'rejected';
  stage: 'local_preflight' | 'provider_pre_effect';
}

/**
 * A machine-readable signal that the channel can prove no provider messaging
 * effect occurred. Unlike an unverified delivery, callers may report this as
 * an execution failure and may offer a deliberate retry after the cause is
 * corrected.
 */
export class ChannelDeliveryRejectedBeforeDispatchError extends Error {
  readonly code = 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH';
  readonly evidence: ChannelDeliveryRejectedBeforeDispatchEvidence;

  constructor(
    message: string,
    options: {
      stage?: ChannelDeliveryRejectedBeforeDispatchEvidence['stage'];
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ChannelDeliveryRejectedBeforeDispatchError';
    this.evidence = {
      outcome: 'rejected',
      stage: options.stage || 'local_preflight',
    };
  }
}

export function isChannelDeliveryRejectedBeforeDispatchError(
  error: unknown,
): error is ChannelDeliveryRejectedBeforeDispatchError {
  return error instanceof ChannelDeliveryRejectedBeforeDispatchError;
}

/**
 * A bounded, machine-readable signal that delivery may have happened in whole
 * or in part. Callers must preserve the evidence and block replay until a
 * person or provider-specific reconciliation verifies what landed.
 */
export class ChannelDeliveryUnverifiedError extends Error {
  readonly code = 'CHANNEL_DELIVERY_UNVERIFIED';
  readonly evidence: ChannelDeliveryUnverifiedEvidence;

  constructor(evidence: ChannelDeliveryUnverifiedEvidence) {
    super(
      'Channel message delivery is unverified; automatic retry is blocked.',
    );
    this.name = 'ChannelDeliveryUnverifiedError';
    this.evidence = evidence;
  }
}

export function isChannelDeliveryUnverifiedError(
  error: unknown,
): error is ChannelDeliveryUnverifiedError {
  return error instanceof ChannelDeliveryUnverifiedError;
}

export function classifyChannelDelivery(
  result: SendMessageResult,
): ChannelDeliveryClassification {
  const confirmedReceiptIds = Array.from(
    new Set(
      [result.platformMessageId, ...(result.platformMessageIds || [])].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
  const confirmedReceiptCount = confirmedReceiptIds.length;
  if (result.deliveryState === 'partial') {
    return {
      outcome: confirmedReceiptCount > 0 ? 'partial' : 'rejected',
      confirmedReceiptIds,
      confirmedReceiptCount,
      nextUnconfirmedChunkIndex: result.nextUnconfirmedChunkIndex,
    };
  }
  if (result.deliveryState === 'unknown') {
    return {
      outcome: 'unknown',
      confirmedReceiptIds,
      confirmedReceiptCount,
      nextUnconfirmedChunkIndex: result.nextUnconfirmedChunkIndex,
    };
  }
  return {
    outcome: confirmedReceiptCount > 0 ? 'confirmed' : 'rejected',
    confirmedReceiptIds,
    confirmedReceiptCount,
  };
}

/**
 * Durable workflows may advance state only after a complete channel receipt.
 * Partial and transport-unknown sends raise typed evidence so callers can
 * persist an explicit unverified/blocked state without logging message text
 * or replaying an uncertain delivery automatically.
 */
export function requireCompleteChannelDelivery<T extends SendMessageResult>(
  result: T,
): T {
  const classification = classifyChannelDelivery(result);
  if (
    classification.outcome === 'partial' ||
    classification.outcome === 'unknown'
  ) {
    throw new ChannelDeliveryUnverifiedError({
      outcome: classification.outcome,
      confirmedReceiptIds: classification.confirmedReceiptIds,
      confirmedReceiptCount: classification.confirmedReceiptCount,
      nextUnconfirmedChunkIndex: classification.nextUnconfirmedChunkIndex,
    });
  }
  if (classification.outcome === 'rejected') {
    throw new Error('Channel message delivery returned no confirmed receipt.');
  }
  return result;
}
