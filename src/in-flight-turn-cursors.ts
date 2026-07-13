/**
 * Tracks message cursors that may be rewound during shutdown. A successful
 * delivery commits the cursor immediately, before optional metrics or
 * enrichment, so a restart cannot resend an already delivered primary reply.
 */
export class InFlightTurnCursorRegistry {
  private readonly previousByChat = new Map<string, string>();

  begin(chatJid: string, previousCursor: string): void {
    this.previousByChat.set(chatJid, previousCursor);
  }

  markDelivered(chatJid: string): boolean {
    return this.previousByChat.delete(chatJid);
  }

  finish(chatJid: string): void {
    this.previousByChat.delete(chatJid);
  }

  rollback(
    chatJid: string,
    rollback: (chatJid: string, previousCursor: string) => void,
  ): boolean {
    const previousCursor = this.previousByChat.get(chatJid);
    if (previousCursor === undefined) return false;
    rollback(chatJid, previousCursor);
    this.previousByChat.delete(chatJid);
    return true;
  }

  rollbackAll(
    rollback: (chatJid: string, previousCursor: string) => void,
  ): number {
    const pending = [...this.previousByChat.entries()];
    this.previousByChat.clear();
    for (const [chatJid, previousCursor] of pending) {
      rollback(chatJid, previousCursor);
    }
    return pending.length;
  }

  get size(): number {
    return this.previousByChat.size;
  }
}

/**
 * Reconciles the optimistic message cursor with the queue's retry decision.
 * A successful, already-delivered turn has removed itself from the registry;
 * a safely handled turn is simply finished. Failed or thrown turns are rewound
 * before GroupQueue schedules their retry.
 */
export async function runQueuedTurnWithCursorRecovery(params: {
  chatJid: string;
  registry: InFlightTurnCursorRegistry;
  run: () => Promise<boolean>;
  rollback: (chatJid: string, previousCursor: string) => void;
}): Promise<boolean> {
  try {
    const handled = await params.run();
    if (handled) {
      params.registry.finish(params.chatJid);
    } else {
      params.registry.rollback(params.chatJid, params.rollback);
    }
    return handled;
  } catch (error) {
    params.registry.rollback(params.chatJid, params.rollback);
    throw error;
  }
}
