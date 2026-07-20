import { describe, expect, it } from 'vitest';

import { KeyedTurnSerializer } from './keyed-turn-serializer.js';

describe('KeyedTurnSerializer', () => {
  it('serializes Telegram and BlueBubbles work sharing one group folder', async () => {
    const serializer = new KeyedTurnSerializer();
    let concurrent = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = serializer.run('main', async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push('telegram:start');
      await firstGate;
      order.push('telegram:end');
      concurrent -= 1;
    });
    const second = serializer.run('main', async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push('bluebubbles:start');
      concurrent -= 1;
    });

    await Promise.resolve();
    releaseFirst();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([
      'telegram:start',
      'telegram:end',
      'bluebubbles:start',
    ]);
  });

  it('allows unrelated group folders to proceed independently', async () => {
    const serializer = new KeyedTurnSerializer();
    let concurrent = 0;
    let maxConcurrent = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = (key: string) =>
      serializer.run(key, async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await gate;
        concurrent -= 1;
      });

    const first = run('main');
    const second = run('family');
    await Promise.resolve();
    release();
    await Promise.all([first, second]);

    expect(maxConcurrent).toBe(2);
  });
});
