/* eslint-disable no-catch-all/no-catch-all -- Isolated crash-worker failures are returned over bounded IPC. */
import fs from 'node:fs';

import Database from 'better-sqlite3';

import { BlueBubblesReceiptInboxHttpService } from '../../src/bluebubbles-receipt-inbox-service.js';
import { BlueBubblesReceiptInboxStore } from '../../src/bluebubbles-receipt-inbox-store.js';

interface WorkerCommand {
  kind: 'serve_pause_after_persist' | 'drain' | 'claim' | 'open_migration';
  databasePath: string;
  webhookSecret?: string;
  barrierPath?: string;
  consumerId?: string;
  canonicalScope?: string;
  body?: string;
  ownerAuthored?: boolean;
  providerTimestamp?: string;
  readyPath?: string;
}

async function sendToParent(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error('Receipt inbox fixture requires an IPC parent.'));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

async function waitForBarrier(barrierPath: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(barrierPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Receipt inbox claim barrier timed out.');
}

function waitForBarrierSync(barrierPath: string): void {
  const deadline = Date.now() + 20_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (fs.existsSync(barrierPath)) return;
    Atomics.wait(signal, 0, 0, 5);
  }
  throw new Error('Receipt inbox migration barrier timed out.');
}

async function handleCommand(command: WorkerCommand): Promise<boolean> {
  if (command.kind === 'open_migration') {
    if (!command.barrierPath || !command.readyPath) {
      throw new Error('Migration fixture requires barrier and ready paths.');
    }
    const prototype = Database.prototype as unknown as {
      transaction: (...args: unknown[]) => unknown;
    };
    const originalTransaction = prototype.transaction;
    let intercepted = false;
    prototype.transaction = function (
      this: unknown,
      ...args: unknown[]
    ): unknown {
      if (!intercepted) {
        intercepted = true;
        fs.writeFileSync(command.readyPath!, 'ready\n', 'utf8');
        waitForBarrierSync(command.barrierPath!);
      }
      return originalTransaction.apply(this, args);
    };
    let store: BlueBubblesReceiptInboxStore | null = null;
    try {
      store = new BlueBubblesReceiptInboxStore(command.databasePath);
      await sendToParent({ type: 'opened', health: store.getHealth() });
      return false;
    } finally {
      prototype.transaction = originalTransaction;
      store?.close();
    }
  }
  const store = new BlueBubblesReceiptInboxStore(command.databasePath);
  if (command.kind === 'serve_pause_after_persist') {
    const service = new BlueBubblesReceiptInboxHttpService({
      store,
      webhookSecret: command.webhookSecret || 'fixture-hook-secret',
      host: '127.0.0.1',
      port: 0,
      onPersistedBeforeResponse: async (result) => {
        await sendToParent({
          type: 'persisted_before_response',
          receiptId: result.receipt.receiptId,
        });
        await new Promise<void>(() => undefined);
      },
    });
    const address = await service.start();
    await sendToParent({ type: 'ready', url: address.url });
    return true;
  }
  try {
    if (command.kind === 'drain') {
      const batch = store.drainPendingReceipts({
        consumerId: command.consumerId || 'fixture-consumer',
        leaseMs: 60_000,
      });
      await sendToParent({
        type: 'drained',
        leaseToken: batch.leaseToken,
        receipts: batch.receipts,
      });
      return false;
    }
    if (!command.barrierPath) {
      throw new Error('Claim fixture requires a barrier path.');
    }
    await sendToParent({ type: 'ready_for_claim' });
    await waitForBarrier(command.barrierPath);
    const claim = store.claimCanonicalSelfThreadIngress({
      canonicalScope:
        command.canonicalScope || 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: command.ownerAuthored ?? true,
      body: command.body || '@Andrea check status',
      providerTimestamp:
        command.providerTimestamp || '2026-07-16T12:00:00.000Z',
    });
    await sendToParent({ type: 'claimed', claim });
    return false;
  } finally {
    if (command.kind !== 'serve_pause_after_persist') store.close();
  }
}

process.once('message', (value: unknown) => {
  void (async () => {
    try {
      const staysRunning = await handleCommand(value as WorkerCommand);
      if (!staysRunning) process.disconnect();
    } catch (error) {
      await sendToParent({
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown worker error',
      }).catch(() => undefined);
      process.exitCode = 1;
      process.disconnect();
    }
  })();
});
