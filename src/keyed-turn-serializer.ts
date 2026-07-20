/**
 * Serializes asynchronous work that shares one logical state owner while still
 * allowing unrelated owners to proceed concurrently.
 */
export class KeyedTurnSerializer {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

/**
 * One process-wide lock registry for every surface that can mutate a logical
 * assistant workspace. Sharing the instance is what prevents Telegram,
 * BlueBubbles, and Alexa turns targeting the same folder from overlapping.
 */
export const logicalTurnSerializer = new KeyedTurnSerializer();
