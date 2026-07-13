import { describe, expect, it, vi } from 'vitest';

import {
  InFlightTurnCursorRegistry,
  runQueuedTurnWithCursorRecovery,
} from './in-flight-turn-cursors.js';

describe('queued turn cursor recovery', () => {
  it('finishes a safely handled turn that did not send a primary reply', async () => {
    const registry = new InFlightTurnCursorRegistry();
    registry.begin('tg:handled', 'cursor-before');
    const rollback = vi.fn();

    await expect(
      runQueuedTurnWithCursorRecovery({
        chatJid: 'tg:handled',
        registry,
        run: async () => true,
        rollback,
      }),
    ).resolves.toBe(true);

    expect(registry.size).toBe(0);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('preserves an already committed delivery without rewinding it', async () => {
    const registry = new InFlightTurnCursorRegistry();
    registry.begin('tg:delivered', 'cursor-before');
    const rollback = vi.fn();

    await expect(
      runQueuedTurnWithCursorRecovery({
        chatJid: 'tg:delivered',
        registry,
        run: async () => {
          registry.markDelivered('tg:delivered');
          return true;
        },
        rollback,
      }),
    ).resolves.toBe(true);

    expect(registry.size).toBe(0);
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rewinds a failed turn before returning the retry signal', async () => {
    const registry = new InFlightTurnCursorRegistry();
    registry.begin('tg:failed', 'cursor-before');
    const rolledBack: Array<[string, string]> = [];

    await expect(
      runQueuedTurnWithCursorRecovery({
        chatJid: 'tg:failed',
        registry,
        run: async () => false,
        rollback: (...entry) => rolledBack.push(entry),
      }),
    ).resolves.toBe(false);

    expect(rolledBack).toEqual([['tg:failed', 'cursor-before']]);
    expect(registry.size).toBe(0);
  });

  it('rewinds a thrown turn and preserves the original queue failure', async () => {
    const registry = new InFlightTurnCursorRegistry();
    registry.begin('tg:thrown', 'cursor-before');
    const rolledBack: Array<[string, string]> = [];

    await expect(
      runQueuedTurnWithCursorRecovery({
        chatJid: 'tg:thrown',
        registry,
        run: async () => {
          throw new Error('bounded turn failure');
        },
        rollback: (...entry) => rolledBack.push(entry),
      }),
    ).rejects.toThrow('bounded turn failure');

    expect(rolledBack).toEqual([['tg:thrown', 'cursor-before']]);
    expect(registry.size).toBe(0);
  });

  it('retains recovery evidence when cursor persistence itself fails', async () => {
    const registry = new InFlightTurnCursorRegistry();
    registry.begin('tg:persist-failed', 'cursor-before');

    await expect(
      runQueuedTurnWithCursorRecovery({
        chatJid: 'tg:persist-failed',
        registry,
        run: async () => false,
        rollback: () => {
          throw new Error('cursor persistence failed');
        },
      }),
    ).rejects.toThrow('cursor persistence failed');

    expect(registry.size).toBe(1);
  });
});
