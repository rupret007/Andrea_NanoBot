import { describe, expect, it, vi } from 'vitest';

import { deliverRuntimeCardNotification } from './runtime-card-delivery.js';

describe('runtime card delivery', () => {
  it('returns all confirmed receipts for a complete card', async () => {
    await expect(
      deliverRuntimeCardNotification({
        send: async () => ({
          platformMessageId: 'message-1',
          platformMessageIds: ['message-1', 'message-2'],
          deliveryState: 'complete',
        }),
      }),
    ).resolves.toEqual({
      status: 'confirmed',
      deliveryOutcome: 'confirmed',
      platformMessageIds: ['message-1', 'message-2'],
    });
  });

  it.each(['partial', 'unknown'] as const)(
    'keeps a %s notification tied to its receipts without claiming success',
    async (deliveryState) => {
      const send = vi.fn(async () => ({
        platformMessageId: 'prefix-1',
        deliveryState,
        nextUnconfirmedChunkIndex: 1,
      }));

      await expect(deliverRuntimeCardNotification({ send })).resolves.toEqual({
        status: 'notification_blocked',
        deliveryOutcome: deliveryState,
        platformMessageIds: ['prefix-1'],
        nextUnconfirmedChunkIndex: 1,
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it('converts a definite notification error into bounded blocked evidence', async () => {
    await expect(
      deliverRuntimeCardNotification({
        send: async () => {
          throw new TypeError('raw transport detail must not escape');
        },
      }),
    ).resolves.toEqual({
      status: 'notification_blocked',
      deliveryOutcome: 'rejected',
      platformMessageIds: [],
      errorClass: 'TypeError',
    });
  });
});
