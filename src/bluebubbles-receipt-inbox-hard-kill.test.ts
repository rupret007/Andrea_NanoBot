import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { BlueBubblesReceiptInboxStore } from './bluebubbles-receipt-inbox-store.js';
import { buildHermeticTestEnv } from './hermetic-test-env.js';

interface Fixture {
  root: string;
  databasePath: string;
  barrierPath: string;
}

interface ManagedWorker {
  child: ChildProcess;
  stderr: () => string;
  nextMessage(timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForExit(timeoutMs?: number): Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

const WORKER_LOADER = fileURLToPath(
  new URL(
    '../scripts/fixtures/bluebubbles-receipt-inbox-worker.mjs',
    import.meta.url,
  ),
);
const fixtures = new Set<Fixture>();
const workers = new Set<ManagedWorker>();

function createFixture(label: string): Fixture {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-bb-inbox-kill-${label}-`),
  );
  const fixture = {
    root,
    databasePath: path.join(root, 'bluebubbles-receipts.db'),
    barrierPath: path.join(root, 'claim.release'),
  };
  fixtures.add(fixture);
  return fixture;
}

function spawnWorker(
  fixture: Fixture,
  command: Record<string, unknown>,
): ManagedWorker {
  let stderr = '';
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const child = fork(WORKER_LOADER, [], {
    cwd: fixture.root,
    env: buildHermeticTestEnv(process.env, { isolateStorage: false }),
    execArgv: [],
    serialization: 'advanced',
    silent: true,
  });
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-128 * 1_024);
  });
  child.on('message', (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });
  const worker: ManagedWorker = {
    child,
    stderr: () => stderr,
    nextMessage(timeoutMs = 20_000) {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => {
        const wrapped = (next: Record<string, unknown>) => {
          clearTimeout(timeout);
          resolve(next);
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(wrapped);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Worker IPC timed out. stderr=${stderr}`));
        }, timeoutMs);
        waiters.push(wrapped);
      });
    },
    waitForExit(timeoutMs = 20_000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => {
          reject(new Error(`Worker exit timed out. stderr=${stderr}`));
        }, timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
    },
  };
  workers.add(worker);
  child.send({ ...command, databasePath: fixture.databasePath });
  return worker;
}

async function finishWorker(
  worker: ManagedWorker,
  expectedType: string,
): Promise<Record<string, unknown>> {
  const message = await worker.nextMessage();
  const exit = await worker.waitForExit();
  workers.delete(worker);
  if (message.type === 'error' || exit.code !== 0) {
    throw new Error(
      `Receipt worker failed: ${String(message.error || exit.signal || exit.code)}. stderr=${worker.stderr()}`,
    );
  }
  expect(message.type).toBe(expectedType);
  return message;
}

async function killWorker(worker: ManagedWorker): Promise<void> {
  if (!worker.child.kill('SIGKILL')) {
    throw new Error('Failed to hard-kill receipt inbox worker.');
  }
  const exit = await worker.waitForExit();
  workers.delete(worker);
  if (process.platform !== 'win32') expect(exit.signal).toBe('SIGKILL');
}

function assertHealthyDatabase(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally {
    database.close();
  }
}

async function waitForPaths(paths: string[]): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (paths.every((target) => fs.existsSync(target))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for fixture paths: ${paths.join(', ')}`);
}

afterEach(async () => {
  for (const worker of [...workers]) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL');
    }
    await worker.waitForExit().catch(() => undefined);
  }
  workers.clear();
  for (const fixture of fixtures) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe('BlueBubbles receipt inbox process durability', () => {
  it('serializes a concurrent v1-to-v2 migration before reading schema state', async () => {
    const fixture = createFixture('migration-race');
    const legacy = new Database(fixture.databasePath);
    legacy.exec(`
      CREATE TABLE bluebubbles_canonical_ingress_claim (
        claim_id TEXT PRIMARY KEY,
        canonical_scope TEXT NOT NULL,
        owner_authored INTEGER NOT NULL,
        normalized_body_hash TEXT NOT NULL,
        normalized_exact_body TEXT NOT NULL,
        provider_timestamp TEXT NOT NULL,
        provider_timestamp_ms INTEGER NOT NULL,
        claimed_at TEXT NOT NULL,
        claimed_at_ms INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const firstReady = path.join(fixture.root, 'migration-first.ready');
    const secondReady = path.join(fixture.root, 'migration-second.ready');
    const first = spawnWorker(fixture, {
      kind: 'open_migration',
      barrierPath: fixture.barrierPath,
      readyPath: firstReady,
    });
    const second = spawnWorker(fixture, {
      kind: 'open_migration',
      barrierPath: fixture.barrierPath,
      readyPath: secondReady,
    });

    await waitForPaths([firstReady, secondReady]);
    fs.writeFileSync(fixture.barrierPath, 'release\n', 'utf8');
    const [firstOpened, secondOpened] = await Promise.all([
      finishWorker(first, 'opened'),
      finishWorker(second, 'opened'),
    ]);

    expect(firstOpened.health).toMatchObject({
      status: 'ok',
      schemaVersion: 2,
    });
    expect(secondOpened.health).toMatchObject({
      status: 'ok',
      schemaVersion: 2,
    });
    const inspection = new Database(fixture.databasePath, { readonly: true });
    try {
      const columns = (
        inspection
          .prepare('PRAGMA table_info(bluebubbles_canonical_ingress_claim)')
          .all() as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'processing_lease_token',
          'processing_lease_expires_at',
          'processing_lease_expires_at_ms',
          'accepted_at',
        ]),
      );
      expect(inspection.pragma('user_version', { simple: true })).toBe(2);
    } finally {
      inspection.close();
    }
    assertHealthyDatabase(fixture.databasePath);
  });

  it('commits before HTTP ACK and drains the row after a hard-kill restart', async () => {
    const fixture = createFixture('persist-before-ack');
    const server = spawnWorker(fixture, {
      kind: 'serve_pause_after_persist',
      webhookSecret: 'fixture-hook-secret',
    });
    const ready = await server.nextMessage();
    expect(ready.type).toBe('ready');
    const requestOutcome = fetch(
      `${String(ready.url)}?secret=fixture-hook-secret`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'new-message',
          data: {
            guid: 'hard-kill-provider-guid-1',
            tempGuid: 'message-action:hard-kill-receipt-1',
            text: 'Andrea: durable before ACK',
            dateCreated: '2026-07-16T12:00:00.000Z',
            isFromMe: true,
            chats: [{ guid: 'iMessage;-;+12025550123' }],
          },
        }),
      },
    ).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );

    const persisted = await server.nextMessage();
    expect(persisted.type).toBe('persisted_before_response');
    await killWorker(server);
    const outcome = await requestOutcome;
    expect('error' in outcome).toBe(true);

    const restart = spawnWorker(fixture, {
      kind: 'drain',
      consumerId: 'restart-reconciler',
    });
    const drained = await finishWorker(restart, 'drained');
    expect(drained.receipts).toEqual([
      expect.objectContaining({
        receiptId: persisted.receiptId,
        tempGuid: 'message-action:hard-kill-receipt-1',
        messageGuid: 'hard-kill-provider-guid-1',
        content: 'Andrea: durable before ACK',
      }),
    ]);
    assertHealthyDatabase(fixture.databasePath);
  });

  it('returns one durable claim ID to concurrent mirrored processes and a new ID at +3s', async () => {
    const fixture = createFixture('claim-race');
    const initializer = new BlueBubblesReceiptInboxStore(fixture.databasePath);
    initializer.close();
    const baseCommand = {
      kind: 'claim',
      barrierPath: fixture.barrierPath,
      canonicalScope: 'bb:iMessage;-;owner@example.invalid',
      ownerAuthored: true,
      body: '@Andrea   Check Status',
    };
    const first = spawnWorker(fixture, {
      ...baseCommand,
      providerTimestamp: '2026-07-16T12:00:00.000Z',
    });
    const mirror = spawnWorker(fixture, {
      ...baseCommand,
      body: '@andrea check status',
      providerTimestamp: '2026-07-16T12:00:00.500Z',
    });
    expect((await first.nextMessage()).type).toBe('ready_for_claim');
    expect((await mirror.nextMessage()).type).toBe('ready_for_claim');
    fs.writeFileSync(fixture.barrierPath, 'release\n', 'utf8');

    const [firstResult, mirrorResult] = await Promise.all([
      finishWorker(first, 'claimed'),
      finishWorker(mirror, 'claimed'),
    ]);
    const firstClaim = firstResult.claim as Record<string, unknown>;
    const mirrorClaim = mirrorResult.claim as Record<string, unknown>;
    expect(firstClaim.claimId).toBe(mirrorClaim.claimId);
    expect([firstClaim.isNew, mirrorClaim.isNew].sort()).toEqual([false, true]);

    const deliberate = spawnWorker(fixture, {
      ...baseCommand,
      providerTimestamp: '2026-07-16T12:00:03.000Z',
    });
    expect((await deliberate.nextMessage()).type).toBe('ready_for_claim');
    const deliberateResult = await finishWorker(deliberate, 'claimed');
    const deliberateClaim = deliberateResult.claim as Record<string, unknown>;
    expect(deliberateClaim.claimId).not.toBe(firstClaim.claimId);
    expect(deliberateClaim.isNew).toBe(true);

    const database = new Database(fixture.databasePath, { readonly: true });
    try {
      const row = database
        .prepare(
          'SELECT COUNT(*) AS count FROM bluebubbles_canonical_ingress_claim',
        )
        .get() as { count: number };
      expect(row.count).toBe(2);
    } finally {
      database.close();
    }
    assertHealthyDatabase(fixture.databasePath);
  });
});
