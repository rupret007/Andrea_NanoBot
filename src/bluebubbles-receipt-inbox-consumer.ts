import type {
  DurableBlueBubblesReceipt,
  BlueBubblesReceiptInboxStore,
} from './bluebubbles-receipt-inbox-store.js';
import type { NewMessage } from './types.js';

const DEFAULT_DRAIN_INTERVAL_MS = 5_000;

export interface BlueBubblesReceiptAcceptance {
  accepted: boolean;
}

export interface BlueBubblesReceiptInboxDrainResult {
  leased: number;
  accepted: number;
  acknowledged: number;
  pendingRetry: number;
}

export interface BlueBubblesReceiptInboxConsumerOptions {
  store: BlueBubblesReceiptInboxStore;
  consumerId: string;
  acceptReceipt: (
    message: NewMessage,
    receipt: DurableBlueBubblesReceipt,
  ) => BlueBubblesReceiptAcceptance | Promise<BlueBubblesReceiptAcceptance>;
  leaseMs?: number;
  batchSize?: number;
  intervalMs?: number;
  onDrainError?: (error: unknown) => void;
}

function canonicalBlueBubblesJid(value: string): string {
  return value.startsWith('bb:') ? value : `bb:${value}`;
}

/** Convert durable provider evidence without normalizing or rewriting bytes. */
export function blueBubblesReceiptToNewMessage(
  receipt: DurableBlueBubblesReceipt,
): NewMessage {
  const chatJid = canonicalBlueBubblesJid(receipt.chatGuid);
  return {
    id: canonicalBlueBubblesJid(receipt.messageGuid),
    chat_jid: chatJid,
    sender: 'bb:self',
    sender_name: 'You',
    content: receipt.content,
    timestamp: receipt.timestamp,
    is_from_me: true,
    is_bot_message: false,
    provider_idempotency_key: receipt.tempGuid,
  };
}

export class BlueBubblesReceiptInboxConsumer {
  private readonly store: BlueBubblesReceiptInboxStore;

  private readonly consumerId: string;

  private readonly acceptReceipt: BlueBubblesReceiptInboxConsumerOptions['acceptReceipt'];

  private readonly leaseMs: number;

  private readonly batchSize: number;

  private readonly intervalMs: number;

  private readonly onDrainError?: (error: unknown) => void;

  private timer: ReturnType<typeof setInterval> | null = null;

  private drainInFlight: Promise<BlueBubblesReceiptInboxDrainResult> | null =
    null;

  constructor(options: BlueBubblesReceiptInboxConsumerOptions) {
    this.store = options.store;
    this.consumerId = options.consumerId;
    this.acceptReceipt = options.acceptReceipt;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.batchSize = options.batchSize ?? 100;
    this.intervalMs = options.intervalMs ?? DEFAULT_DRAIN_INTERVAL_MS;
    this.onDrainError = options.onDrainError;
    if (
      !Number.isInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 3_600_000
    ) {
      throw new Error(
        'Receipt inbox intervalMs must be between 100 and 3600000.',
      );
    }
  }

  drainOnce(now = new Date()): Promise<BlueBubblesReceiptInboxDrainResult> {
    if (this.drainInFlight) return this.drainInFlight;
    this.drainInFlight = this.performDrain(now).finally(() => {
      this.drainInFlight = null;
    });
    return this.drainInFlight;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainOnce().catch((error: unknown) => {
        this.onDrainError?.(error);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.drainInFlight) {
      await this.drainInFlight;
    }
  }

  private async performDrain(
    now: Date,
  ): Promise<BlueBubblesReceiptInboxDrainResult> {
    const batch = this.store.drainPendingReceipts({
      consumerId: this.consumerId,
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      now,
    });
    let accepted = 0;
    let acknowledged = 0;
    if (!batch.leaseToken) {
      return { leased: 0, accepted: 0, acknowledged: 0, pendingRetry: 0 };
    }

    for (const receipt of batch.receipts) {
      try {
        const result = await this.acceptReceipt(
          blueBubblesReceiptToNewMessage(receipt),
          receipt,
        );
        if (!result.accepted) continue;
        accepted += 1;
        this.store.ackPendingReceipts({
          leaseToken: batch.leaseToken,
          receiptIds: [receipt.receiptId],
        });
        acknowledged += 1;
      } catch (error) {
        this.onDrainError?.(error);
      }
    }
    return {
      leased: batch.receipts.length,
      accepted,
      acknowledged,
      pendingRetry: batch.receipts.length - acknowledged,
    };
  }
}
