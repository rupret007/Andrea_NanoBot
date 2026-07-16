import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BlueBubblesReceiptInboxHttpService,
  parseBlueBubblesReceiptPayload,
} from './bluebubbles-receipt-inbox-service.js';
import { BlueBubblesReceiptInboxConsumer } from './bluebubbles-receipt-inbox-consumer.js';
import {
  buildBlueBubblesReceiptInboxConfigIdentity,
  BlueBubblesReceiptInboxStore,
  normalizeCanonicalSelfThreadIngressBody,
} from './bluebubbles-receipt-inbox-store.js';

const roots = new Set<string>();
const stores = new Set<BlueBubblesReceiptInboxStore>();
const services = new Set<BlueBubblesReceiptInboxHttpService>();

function createDatabasePath(label: string): string {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-bb-inbox-${label}-`),
  );
  roots.add(root);
  return path.join(root, 'bluebubbles-receipts.db');
}

function openStore(databasePath: string): BlueBubblesReceiptInboxStore {
  const store = new BlueBubblesReceiptInboxStore(databasePath);
  stores.add(store);
  return store;
}

function closeStore(store: BlueBubblesReceiptInboxStore): void {
  store.close();
  stores.delete(store);
}

function receiptPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const data = {
    guid: 'provider-message-guid-1',
    tempGuid: 'message-action:receipt-inbox-1',
    text: 'Andrea: Exact content\nwith spacing  preserved.',
    dateCreated: '2026-07-16T12:00:00.000Z',
    isFromMe: true,
    chats: [{ guid: 'iMessage;-;+12025550123' }],
    ...((overrides.data as Record<string, unknown> | undefined) || {}),
  };
  return {
    type: 'new-message',
    ...overrides,
    data,
  };
}

async function startService(
  store: BlueBubblesReceiptInboxStore,
  options: { secret?: string; maxPayloadBytes?: number } = {},
): Promise<{
  service: BlueBubblesReceiptInboxHttpService;
  url: string;
  healthUrl: string;
}> {
  const service = new BlueBubblesReceiptInboxHttpService({
    store,
    webhookSecret: options.secret || 'deterministic-hook-secret',
    host: '127.0.0.1',
    port: 0,
    maxPayloadBytes: options.maxPayloadBytes,
  });
  services.add(service);
  const address = await service.start();
  return { service, url: address.url, healthUrl: address.healthUrl };
}

async function stopService(
  service: BlueBubblesReceiptInboxHttpService,
): Promise<void> {
  await service.stop();
  services.delete(service);
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const service of [...services]) {
    await service.stop();
  }
  services.clear();
  for (const store of stores) store.close();
  stores.clear();
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  roots.clear();
});

describe('BlueBubbles durable receipt inbox', () => {
  it('requires authentication and fails closed on unmatched or invalid events', async () => {
    const databasePath = createDatabasePath('closed');
    const store = openStore(databasePath);
    expect(
      () =>
        new BlueBubblesReceiptInboxHttpService({
          store,
          webhookSecret: '',
        }),
    ).toThrow(/requires a configured webhook secret/i);
    const { service, url, healthUrl } = await startService(store);
    vi.stubEnv('ANDREA_BUILD_ID', 'test-build-set-after-module-import');

    const unauthenticatedHealth = await fetch(healthUrl);
    expect(unauthenticatedHealth.status).toBe(401);
    const health = await fetch(healthUrl, {
      headers: { Authorization: 'Bearer deterministic-hook-secret' },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: 'ok',
      schemaVersion: 2,
      serviceKind: 'bluebubbles-receipt-inbox',
      protocolVersion: 2,
      pid: process.pid,
      startedAt: expect.any(String),
      buildId: expect.any(String),
      webhookPath: '/bluebubbles/receipt-inbox',
      configIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const expectedConfigIdentity = buildBlueBubblesReceiptInboxConfigIdentity({
      databasePath,
      webhookPath: '/bluebubbles/receipt-inbox',
    });
    expect(
      (await (
        await fetch(healthUrl, {
          headers: { Authorization: 'Bearer deterministic-hook-secret' },
        })
      ).json()) as Record<string, unknown>,
    ).toMatchObject({ configIdentity: expectedConfigIdentity });
    expect(
      buildBlueBubblesReceiptInboxConfigIdentity({
        databasePath: `${databasePath}.different`,
        webhookPath: '/bluebubbles/receipt-inbox',
      }),
    ).not.toBe(expectedConfigIdentity);
    expect(
      buildBlueBubblesReceiptInboxConfigIdentity({
        databasePath,
        webhookPath: '/bluebubbles/other-receipt-inbox',
      }),
    ).not.toBe(expectedConfigIdentity);
    expect(
      (await (
        await fetch(healthUrl, {
          headers: { Authorization: 'Bearer deterministic-hook-secret' },
        })
      ).json()) as Record<string, unknown>,
    ).toMatchObject({ buildId: 'test-build-set-after-module-import' });
    expect(store.listPendingReceipts()).toEqual([]);

    const unauthenticated = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptPayload()),
    });
    expect(unauthenticated.status).toBe(401);

    const incoming = await fetch(`${url}?secret=deterministic-hook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(receiptPayload({ data: { isFromMe: false } })),
    });
    expect(incoming.status).toBe(422);

    const group = await fetch(`${url}?secret=deterministic-hook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        receiptPayload({
          data: { chats: [{ guid: 'iMessage;+;family-group' }] },
        }),
      ),
    });
    expect(group.status).toBe(422);

    const irrelevant = await fetch(`${url}?secret=deterministic-hook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...receiptPayload(), type: 'updated-message' }),
    });
    expect(irrelevant.status).toBe(422);
    expect(store.listPendingReceipts()).toEqual([]);
    await stopService(service);
  });

  it('commits exact evidence once and treats an identical webhook retry as idempotent', async () => {
    const databasePath = createDatabasePath('duplicate');
    const store = openStore(databasePath);
    const { service, url } = await startService(store);
    const webhookUrl = `${url}?secret=deterministic-hook-secret`;
    const exactContent = 'Andrea:  two spaces\ncurly “quote”\tand tab';
    const payload = receiptPayload({ data: { text: exactContent } });

    const first = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(first.status).toBe(201);
    expect(firstBody.status).toBe('persisted');

    const duplicate = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const duplicateBody = (await duplicate.json()) as Record<string, unknown>;
    expect(duplicate.status).toBe(200);
    expect(duplicateBody).toMatchObject({
      status: 'duplicate',
      receiptId: firstBody.receiptId,
      duplicate: true,
    });

    const rows = store.listPendingReceipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tempGuid: 'message-action:receipt-inbox-1',
      messageGuid: 'provider-message-guid-1',
      chatGuid: 'iMessage;-;+12025550123',
      content: exactContent,
      timestamp: '2026-07-16T12:00:00.000Z',
      isFromMe: true,
    });

    const conflict = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        receiptPayload({ data: { text: 'Different evidence' } }),
      ),
    });
    expect(conflict.status).toBe(409);
    expect(store.listPendingReceipts()[0]?.content).toBe(exactContent);
    await stopService(service);
  });

  it('rejects payloads above the configured byte bound without persistence', async () => {
    const databasePath = createDatabasePath('bounded');
    const store = openStore(databasePath);
    const { service, url } = await startService(store, {
      maxPayloadBytes: 1_024,
    });
    const oversized = receiptPayload({
      data: { text: 'x'.repeat(2_000) },
    });
    const response = await fetch(`${url}?secret=deterministic-hook-secret`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(oversized),
    });
    expect(response.status).toBe(413);
    expect(store.listPendingReceipts()).toEqual([]);
    await stopService(service);
  });

  it('lists, drains by durable lease after restart, and retains rows after explicit ACK', () => {
    const databasePath = createDatabasePath('restart');
    let store = openStore(databasePath);
    const parsed = parseBlueBubblesReceiptPayload(receiptPayload());
    const persisted = store.persistReceipt(
      parsed,
      new Date('2026-07-16T12:00:01.000Z'),
    );
    closeStore(store);

    store = openStore(databasePath);
    expect(store.listPendingReceipts()).toEqual([
      expect.objectContaining({ receiptId: persisted.receipt.receiptId }),
    ]);
    const drained = store.drainPendingReceipts({
      consumerId: 'main-reconciler',
      leaseMs: 60_000,
      now: new Date('2026-07-16T12:00:02.000Z'),
    });
    expect(drained.receipts).toEqual([
      expect.objectContaining({
        receiptId: persisted.receipt.receiptId,
        leaseToken: drained.leaseToken,
      }),
    ]);
    closeStore(store);

    store = openStore(databasePath);
    expect(store.listPendingReceipts()).toHaveLength(1);
    expect(
      store.ackPendingReceipts({
        leaseToken: drained.leaseToken!,
        receiptIds: [persisted.receipt.receiptId],
        acknowledgedAt: new Date('2026-07-16T12:00:03.000Z'),
      }),
    ).toBe(1);
    expect(store.listPendingReceipts()).toEqual([]);
    closeStore(store);

    const inspection = new Database(databasePath, { readonly: true });
    try {
      const row = inspection
        .prepare(
          'SELECT COUNT(*) AS count, MAX(acknowledged_at) AS acknowledged_at FROM bluebubbles_receipt_inbox',
        )
        .get() as { count: number; acknowledged_at: string };
      expect(row).toEqual({
        count: 1,
        acknowledged_at: '2026-07-16T12:00:03.000Z',
      });
    } finally {
      inspection.close();
    }
  });

  it('converts exact durable evidence to NewMessage and ACKs only after acceptance', async () => {
    const store = openStore(createDatabasePath('consumer-accept'));
    store.persistReceipt({
      tempGuid: 'message-action:consumer-accept',
      messageGuid: 'provider-consumer-accept',
      chatGuid: 'SMS;-;+12025550123',
      content: 'Exact  bytes\nremain “curly”.',
      timestamp: '2026-07-16T12:00:00.000Z',
      isFromMe: true,
    });
    const seen: unknown[] = [];
    const consumer = new BlueBubblesReceiptInboxConsumer({
      store,
      consumerId: 'consumer-accept',
      acceptReceipt: (message) => {
        seen.push(message);
        return { accepted: true };
      },
    });

    expect(
      await consumer.drainOnce(new Date('2026-07-16T12:00:01.000Z')),
    ).toEqual({
      leased: 1,
      accepted: 1,
      acknowledged: 1,
      pendingRetry: 0,
    });
    expect(seen).toEqual([
      expect.objectContaining({
        id: 'bb:provider-consumer-accept',
        chat_jid: 'bb:SMS;-;+12025550123',
        content: 'Exact  bytes\nremain “curly”.',
        timestamp: '2026-07-16T12:00:00.000Z',
        is_from_me: true,
        provider_idempotency_key: 'message-action:consumer-accept',
      }),
    ]);
    expect(store.listPendingReceipts()).toEqual([]);
  });

  it('keeps rejected and failed receipts pending until lease expiry, then retries and ACKs them', async () => {
    const store = openStore(createDatabasePath('consumer-retry'));
    for (const [suffix, timestamp] of [
      ['rejected', '2026-07-16T12:00:00.000Z'],
      ['throws', '2026-07-16T12:00:01.000Z'],
    ]) {
      store.persistReceipt({
        tempGuid: `message-action:${suffix}`,
        messageGuid: `provider-${suffix}`,
        chatGuid: 'iMessage;-;+12025550123',
        content: `Exact ${suffix}`,
        timestamp,
        isFromMe: true,
      });
    }
    let accept = false;
    const errors: unknown[] = [];
    const consumer = new BlueBubblesReceiptInboxConsumer({
      store,
      consumerId: 'consumer-retry',
      leaseMs: 1_000,
      acceptReceipt: (message) => {
        if (accept) return { accepted: true };
        if (message.id === 'bb:provider-throws') {
          throw new Error('simulated main-store failure');
        }
        return { accepted: false };
      },
      onDrainError: (error) => errors.push(error),
    });

    expect(
      await consumer.drainOnce(new Date('2026-07-16T12:00:02.000Z')),
    ).toMatchObject({ leased: 2, acknowledged: 0, pendingRetry: 2 });
    expect(errors).toHaveLength(1);
    expect(
      await consumer.drainOnce(new Date('2026-07-16T12:00:02.500Z')),
    ).toMatchObject({ leased: 0 });
    expect(store.listPendingReceipts()).toHaveLength(2);

    accept = true;
    expect(
      await consumer.drainOnce(new Date('2026-07-16T12:00:03.001Z')),
    ).toEqual({
      leased: 2,
      accepted: 2,
      acknowledged: 2,
      pendingRetry: 0,
    });
    expect(store.listPendingReceipts()).toEqual([]);
  });

  it('waits for an in-flight acceptance before shutdown returns', async () => {
    const store = openStore(createDatabasePath('consumer-shutdown'));
    store.persistReceipt({
      tempGuid: 'message-action:shutdown',
      messageGuid: 'provider-shutdown',
      chatGuid: 'iMessage;-;+12025550123',
      content: 'Wait for durable acceptance.',
      timestamp: '2026-07-16T12:00:00.000Z',
      isFromMe: true,
    });
    let resolveAcceptance!: () => void;
    const acceptance = new Promise<void>((resolve) => {
      resolveAcceptance = resolve;
    });
    const consumer = new BlueBubblesReceiptInboxConsumer({
      store,
      consumerId: 'consumer-shutdown',
      acceptReceipt: async () => {
        await acceptance;
        return { accepted: true };
      },
    });
    const drain = consumer.drainOnce(new Date('2026-07-16T12:00:01.000Z'));
    let shutdownSettled = false;
    const shutdown = consumer.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    resolveAcceptance();
    await Promise.all([drain, shutdown]);
    expect(shutdownSettled).toBe(true);
    expect(store.listPendingReceipts()).toEqual([]);
  });

  it('reports whether the main receipt consumer is actively polling', () => {
    const store = openStore(createDatabasePath('consumer-running'));
    const consumer = new BlueBubblesReceiptInboxConsumer({
      store,
      consumerId: 'consumer-running',
      acceptReceipt: async () => ({ accepted: true }),
    });

    expect(consumer.isRunning()).toBe(false);
    consumer.start();
    expect(consumer.isRunning()).toBe(true);
    consumer.stop();
    expect(consumer.isRunning()).toBe(false);
  });

  it('history recovery cannot create a canonical ingress claim', () => {
    const store = openStore(createDatabasePath('resume-existing-only'));
    const input = {
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea do not replay old history',
      providerTimestamp: '2026-07-16T12:00:00.000Z',
      now: new Date('2026-07-16T12:10:00.000Z'),
    };

    expect(store.resumeCanonicalSelfThreadIngressIfExists(input)).toBeNull();
    expect(store.claimCanonicalSelfThreadIngress(input)).toMatchObject({
      disposition: 'claimed',
      isNew: true,
    });
  });

  it('atomically reuses the first canonical ingress claim within ±2s and distinguishes +3s', () => {
    const store = openStore(createDatabasePath('claims'));
    const first = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '  “Check   Status”\r\nnow ',
      providerTimestamp: '2026-07-16T12:00:00.000Z',
      now: new Date('2026-07-16T12:00:10.000Z'),
    });
    const boundaryMirror = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '"check status" now',
      providerTimestamp: '2026-07-16T12:00:02.000Z',
      now: new Date('2026-07-16T12:00:11.000Z'),
    });
    const deliberateRepeat = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '"check status" now',
      providerTimestamp: '2026-07-16T12:00:03.000Z',
      now: new Date('2026-07-16T12:00:12.000Z'),
    });
    const otherAuthor = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: false,
      body: '"check status" now',
      providerTimestamp: '2026-07-16T12:00:00.500Z',
    });

    expect(first).toMatchObject({
      disposition: 'claimed',
      isNew: true,
      shouldProcess: true,
      normalizedBody: '"check status" now',
    });
    expect(boundaryMirror).toMatchObject({
      claimId: first.claimId,
      disposition: 'mirror',
      isNew: false,
      shouldProcess: false,
    });
    expect(deliberateRepeat.claimId).not.toBe(first.claimId);
    expect(deliberateRepeat.disposition).toBe('claimed');
    expect(otherAuthor.claimId).not.toBe(first.claimId);
    expect(normalizeCanonicalSelfThreadIngressBody(' A\n B ')).toBe('a b');
  });

  it('releases an unaccepted claim for same-ID processing after lease expiry and permanently suppresses it after acceptance', () => {
    const databasePath = createDatabasePath('claim-resume');
    let store = openStore(databasePath);
    const first = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover this exact turn',
      providerTimestamp: '2026-07-16T12:00:00.000Z',
      now: new Date('2026-07-16T12:10:00.000Z'),
      processingLeaseMs: 1_000,
    });
    closeStore(store);

    store = openStore(databasePath);
    const activeMirror = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover this exact turn',
      providerTimestamp: '2026-07-16T12:00:00.500Z',
      now: new Date('2026-07-16T12:10:00.500Z'),
      processingLeaseMs: 1_000,
    });
    expect(activeMirror).toMatchObject({
      claimId: first.claimId,
      disposition: 'mirror',
      shouldProcess: false,
    });

    const resumed = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover this exact turn',
      providerTimestamp: '2026-07-16T12:00:00.500Z',
      now: new Date('2026-07-16T12:10:01.001Z'),
      processingLeaseMs: 1_000,
    });
    expect(resumed).toMatchObject({
      claimId: first.claimId,
      disposition: 'resumed',
      isNew: false,
      shouldProcess: true,
    });
    expect(resumed.processingLeaseToken).not.toBe(first.processingLeaseToken);
    expect(
      store.acceptCanonicalSelfThreadIngressClaim({
        claimId: resumed.claimId,
        processingLeaseToken: resumed.processingLeaseToken!,
        acceptedAt: new Date('2026-07-16T12:10:01.100Z'),
      }),
    ).toBe(true);

    const muchLaterMirror = store.claimCanonicalSelfThreadIngress({
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea recover this exact turn',
      providerTimestamp: '2026-07-16T12:00:00.250Z',
      now: new Date('2026-07-16T15:10:00.000Z'),
    });
    expect(muchLaterMirror).toMatchObject({
      claimId: first.claimId,
      disposition: 'mirror',
      shouldProcess: false,
      acceptedAt: '2026-07-16T12:10:01.100Z',
    });
  });
});
