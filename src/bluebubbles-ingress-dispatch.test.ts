import { describe, expect, it } from 'vitest';

import {
  buildBlueBubblesIngressDispatchIdempotencyKey,
  buildIngressBoundCompanionHandoffId,
} from './bluebubbles-ingress-dispatch.js';

const identity = {
  sourceChatJid: 'tg:owner',
  sourceMessageId: 'telegram-update-44',
  sourceReceivedAt: '2026-07-16T20:00:00.000Z',
  targetChatJid: 'bb:iMessage;-;+13125550101',
};

describe('ingress-bound BlueBubbles dispatch identity', () => {
  it('is stable across process retry and pause-generation changes', () => {
    const first = buildBlueBubblesIngressDispatchIdempotencyKey({
      ...identity,
      slot: 'assistant_reply:1',
    });
    const afterRestart = buildBlueBubblesIngressDispatchIdempotencyKey({
      ...identity,
      slot: 'assistant_reply:1',
    });

    expect(afterRestart).toBe(first);
    expect(first).toMatch(/^andrea-bb-ingress-v1-[a-f0-9]{64}$/);
  });

  it('binds the source ingress, exact target, and logical outbound slot', () => {
    const baseline = buildBlueBubblesIngressDispatchIdempotencyKey({
      ...identity,
      slot: 'assistant_reply:1',
    });

    expect(
      buildBlueBubblesIngressDispatchIdempotencyKey({
        ...identity,
        sourceMessageId: 'telegram-update-45',
        slot: 'assistant_reply:1',
      }),
    ).not.toBe(baseline);
    expect(
      buildBlueBubblesIngressDispatchIdempotencyKey({
        ...identity,
        targetChatJid: 'bb:iMessage;-;+13125550102',
        slot: 'assistant_reply:1',
      }),
    ).not.toBe(baseline);
    expect(
      buildBlueBubblesIngressDispatchIdempotencyKey({
        ...identity,
        slot: 'assistant_reply:2',
      }),
    ).not.toBe(baseline);
  });

  it('uses the same deterministic identity for a retried companion handoff', () => {
    expect(buildIngressBoundCompanionHandoffId(identity)).toBe(
      buildIngressBoundCompanionHandoffId(identity),
    );
  });

  it('fails closed when immutable ingress coordinates are absent or invalid', () => {
    expect(() =>
      buildBlueBubblesIngressDispatchIdempotencyKey({
        ...identity,
        sourceReceivedAt: '',
        slot: 'assistant_reply:1',
      }),
    ).toThrow('sourceReceivedAt');
    expect(() =>
      buildBlueBubblesIngressDispatchIdempotencyKey({
        ...identity,
        sourceReceivedAt: 'not-a-time',
        slot: 'assistant_reply:1',
      }),
    ).toThrow('valid immutable receipt timestamp');
  });
});
