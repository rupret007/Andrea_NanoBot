import { describe, expect, it, vi } from 'vitest';

import { ChannelDeliveryUnverifiedError } from './channel-delivery.js';
import {
  isCommittedIncompleteDeliveryError,
  type CommittedIncompleteDeliveryError,
} from './interaction-delivery-metrics.js';
import { deliverQueuedResponseWithIngressCommit } from './queued-response-delivery.js';

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to reject.');
    },
    (error: unknown) => error,
  );
}

describe('deliverQueuedResponseWithIngressCommit', () => {
  it('does not commit when the channel rejects before returning delivery evidence', async () => {
    const onPrimaryDeliveryCommitted = vi.fn();

    await expect(
      deliverQueuedResponseWithIngressCommit({
        send: async () => {
          throw new Error('provider rejected before dispatch');
        },
        onPrimaryDeliveryCommitted,
      }),
    ).rejects.toThrow('provider rejected before dispatch');

    expect(onPrimaryDeliveryCommitted).not.toHaveBeenCalled();
  });

  it('does not commit a resolved response that has no confirmed receipt', async () => {
    const onPrimaryDeliveryCommitted = vi.fn();

    await expect(
      deliverQueuedResponseWithIngressCommit({
        send: async () => ({ deliveryState: 'complete' }),
        onPrimaryDeliveryCommitted,
      }),
    ).rejects.toThrow('no confirmed receipt');

    expect(onPrimaryDeliveryCommitted).not.toHaveBeenCalled();
  });

  it('commits a confirmed response exactly once', async () => {
    const onPrimaryDeliveryCommitted = vi.fn();

    await expect(
      deliverQueuedResponseWithIngressCommit({
        send: async () => ({
          platformMessageId: 'provider-message-1',
          deliveryState: 'complete',
        }),
        onPrimaryDeliveryCommitted,
      }),
    ).resolves.toMatchObject({ platformMessageId: 'provider-message-1' });

    expect(onPrimaryDeliveryCommitted).toHaveBeenCalledOnce();
  });

  it('durably quarantines a BlueBubbles ingress before crossing the provider boundary', async () => {
    const order: string[] = [];
    const onPrimaryDeliveryCommitted = vi.fn(() => {
      order.push('ingress_quarantined');
    });

    await expect(
      deliverQueuedResponseWithIngressCommit({
        quarantineBeforeDispatch: true,
        onPrimaryDeliveryCommitted,
        send: async () => {
          order.push('provider_accepted_then_process_died');
          throw new Error('simulated hard kill after provider acceptance');
        },
      }),
    ).rejects.toThrow('simulated hard kill');

    expect(order).toEqual([
      'ingress_quarantined',
      'provider_accepted_then_process_died',
    ]);
    expect(onPrimaryDeliveryCommitted).toHaveBeenCalledOnce();
  });

  it('does not cross the provider boundary when durable quarantine fails', async () => {
    const send = vi.fn(async () => ({ platformMessageId: 'should-not-send' }));

    await expect(
      deliverQueuedResponseWithIngressCommit({
        quarantineBeforeDispatch: true,
        onPrimaryDeliveryCommitted: () => {
          throw new Error('durable ingress commit failed');
        },
        send,
      }),
    ).rejects.toThrow('durable ingress commit failed');

    expect(send).not.toHaveBeenCalled();
  });

  it('commits and fences a resolved transport-unknown response from replay', async () => {
    const onPrimaryDeliveryCommitted = vi.fn();
    const captured = await captureRejection(
      deliverQueuedResponseWithIngressCommit({
        send: async () => ({
          deliveryState: 'unknown',
          nextUnconfirmedChunkIndex: 0,
        }),
        onPrimaryDeliveryCommitted,
      }),
    );

    expect(isCommittedIncompleteDeliveryError(captured)).toBe(true);
    expect((captured as CommittedIncompleteDeliveryError).deliveryOutcome).toBe(
      'unknown',
    );
    expect(onPrimaryDeliveryCommitted).toHaveBeenCalledOnce();
  });

  it('commits and fences a thrown unverified-delivery signal from replay', async () => {
    const onPrimaryDeliveryCommitted = vi.fn();
    const captured = await captureRejection(
      deliverQueuedResponseWithIngressCommit({
        send: async () => {
          throw new ChannelDeliveryUnverifiedError({
            outcome: 'partial',
            confirmedReceiptIds: ['provider-message-1'],
            confirmedReceiptCount: 1,
            nextUnconfirmedChunkIndex: 1,
          });
        },
        onPrimaryDeliveryCommitted,
      }),
    );

    expect(isCommittedIncompleteDeliveryError(captured)).toBe(true);
    expect(captured).toMatchObject({
      deliveryOutcome: 'partial',
      confirmedReceiptCount: 1,
      nextUnconfirmedChunkIndex: 1,
    });
    expect(onPrimaryDeliveryCommitted).toHaveBeenCalledOnce();
  });
});
