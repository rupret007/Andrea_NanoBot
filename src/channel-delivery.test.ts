import { describe, expect, it } from 'vitest';

import {
  ChannelDeliveryRejectedBeforeDispatchError,
  ChannelDeliveryUnverifiedError,
  classifyChannelDelivery,
  isChannelDeliveryRejectedBeforeDispatchError,
  requireCompleteChannelDelivery,
} from './channel-delivery.js';

describe('complete channel delivery guard', () => {
  it('keeps definite pre-effect rejection distinct from uncertain delivery', () => {
    const error = new ChannelDeliveryRejectedBeforeDispatchError(
      'Provider rejected the authenticated request before invoking Messages.',
      { stage: 'provider_pre_effect' },
    );

    expect(isChannelDeliveryRejectedBeforeDispatchError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'CHANNEL_DELIVERY_REJECTED_BEFORE_DISPATCH',
      evidence: {
        outcome: 'rejected',
        stage: 'provider_pre_effect',
      },
    });
    expect(error).not.toBeInstanceOf(ChannelDeliveryUnverifiedError);
  });

  it('accepts complete and legacy receipts', () => {
    expect(
      requireCompleteChannelDelivery({
        platformMessageId: 'message-1',
        deliveryState: 'complete',
      }),
    ).toMatchObject({ platformMessageId: 'message-1' });
    expect(
      requireCompleteChannelDelivery({
        platformMessageIds: ['message-2'],
      }),
    ).toMatchObject({ platformMessageIds: ['message-2'] });
  });

  it.each(['partial', 'unknown'] as const)(
    'returns bounded evidence for a %s send even when a prefix receipt exists',
    (deliveryState) => {
      let captured: unknown;
      try {
        requireCompleteChannelDelivery({
          platformMessageId: 'prefix-only',
          platformMessageIds: ['prefix-only', 'second-prefix'],
          deliveryState,
          nextUnconfirmedChunkIndex: 2,
        });
      } catch (error) {
        captured = error;
      }
      expect(captured).toBeInstanceOf(ChannelDeliveryUnverifiedError);
      expect((captured as ChannelDeliveryUnverifiedError).evidence).toEqual({
        outcome: deliveryState,
        confirmedReceiptIds: ['prefix-only', 'second-prefix'],
        confirmedReceiptCount: 2,
        nextUnconfirmedChunkIndex: 2,
      });
      expect((captured as ChannelDeliveryUnverifiedError).message).toContain(
        'automatic retry is blocked',
      );
    },
  );

  it('rejects an empty resolved result', () => {
    expect(() => requireCompleteChannelDelivery({})).toThrow(
      'no confirmed receipt',
    );
  });

  it('rejects a malformed partial result without a confirmed prefix', () => {
    expect(
      classifyChannelDelivery({
        deliveryState: 'partial',
        platformMessageIds: [],
        nextUnconfirmedChunkIndex: 0,
      }),
    ).toEqual({
      outcome: 'rejected',
      confirmedReceiptIds: [],
      confirmedReceiptCount: 0,
      nextUnconfirmedChunkIndex: 0,
    });
  });

  it('keeps an unknown transport result distinct even without a receipt', () => {
    expect(
      classifyChannelDelivery({
        deliveryState: 'unknown',
        nextUnconfirmedChunkIndex: 0,
      }),
    ).toEqual({
      outcome: 'unknown',
      confirmedReceiptIds: [],
      confirmedReceiptCount: 0,
      nextUnconfirmedChunkIndex: 0,
    });
  });
});
