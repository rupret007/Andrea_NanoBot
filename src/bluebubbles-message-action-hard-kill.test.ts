import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo, Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHermeticTestEnv } from './hermetic-test-env.js';

interface FixturePaths {
  root: string;
  databasePath: string;
  barrierPath: string;
}

interface ManagedWorker {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitForExit: (timeoutMs?: number) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

interface ProviderPost {
  endpoint: '/api/v1/chat/new' | '/api/v1/message/text';
  receiptId: string;
  chatJid: string;
  addresses: string[];
  message: string;
  method: string;
  service: string | null;
  tempGuid: string;
  observedAt: string;
}

interface FakeProvider {
  baseUrl: string;
  posts: ProviderPost[];
  holdResponses: boolean;
  waitForPostCount(count: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const WORKER_LOADER = fileURLToPath(
  new URL(
    '../scripts/fixtures/bluebubbles-message-action-worker.mjs',
    import.meta.url,
  ),
);
const fixtures = new Set<FixturePaths>();
const workers = new Set<ManagedWorker>();
const providers = new Set<FakeProvider>();

function createFixture(label: string): FixturePaths {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-bb-action-${label}-`),
  );
  const fixture = {
    root,
    databasePath: path.join(root, 'messages.db'),
    barrierPath: path.join(root, 'race.release'),
  };
  fixtures.add(fixture);
  return fixture;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-128 * 1024);
}

function spawnWorker(
  fixture: FixturePaths,
  command: Record<string, unknown>,
): ManagedWorker {
  let stdout = '';
  let stderr = '';
  const queued: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const child = fork(WORKER_LOADER, [], {
    cwd: fixture.root,
    env: {
      ...buildHermeticTestEnv(process.env, { isolateStorage: false }),
      ANDREA_TEST_DISABLE_OWNER_ENV_FILE: '1',
      BLUEBUBBLES_CANONICAL_SELF_THREAD_JID: 'iMessage;-;owner@example.invalid',
    },
    execArgv: [],
    serialization: 'advanced',
    silent: true,
  });
  child.stdout?.on('data', (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk);
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
    stdout: () => stdout,
    stderr: () => stderr,
    nextMessage(timeoutMs = 30_000) {
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
          reject(
            new Error(`BlueBubbles worker message timed out. stderr=${stderr}`),
          );
        }, timeoutMs);
        waiters.push(wrapped);
      });
    },
    waitForExit(timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => {
          reject(
            new Error(`BlueBubbles worker exit timed out. stderr=${stderr}`),
          );
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

async function completeWorker(
  worker: ManagedWorker,
): Promise<Record<string, unknown>> {
  const message = await worker.nextMessage();
  const exit = await worker.waitForExit();
  workers.delete(worker);
  if (exit.code !== 0 || message.type === 'error') {
    throw new Error(
      `BlueBubbles fixture failed (${String(message.error || exit.signal || exit.code)}). stderr=${worker.stderr()}`,
    );
  }
  return message;
}

async function runWorker(
  fixture: FixturePaths,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return completeWorker(spawnWorker(fixture, command));
}

async function stageInitialTextRequest(
  fixture: FixturePaths,
  provider: FakeProvider,
): Promise<Record<string, unknown>> {
  const staged = await runWorker(fixture, {
    kind: 'stage_request',
    providerBaseUrl: provider.baseUrl,
  });
  const action = asRecord(staged.action);
  expect(staged.state).toBe('staged');
  expect(action).toMatchObject({
    sendStatus: 'drafted',
    approvedAt: null,
    draftText: 'Hi from Andrea.',
  });
  expect(String(action.presentationMessageId)).toContain('tg:draft-card:');
  expect(provider.posts).toHaveLength(0);
  return action;
}

async function hardKill(worker: ManagedWorker): Promise<void> {
  if (!worker.child.kill('SIGKILL')) {
    throw new Error('Failed to terminate BlueBubbles fixture worker.');
  }
  const exit = await worker.waitForExit();
  workers.delete(worker);
  if (process.platform !== 'win32') expect(exit.signal).toBe('SIGKILL');
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}

function assertDatabaseHealthy(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(database.pragma('foreign_key_check')).toEqual([]);
  } finally {
    database.close();
  }
}

async function startFakeProvider(options?: {
  holdResponses?: boolean;
}): Promise<FakeProvider> {
  const posts: ProviderPost[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  const sockets = new Set<Socket>();
  let holdResponses = Boolean(options?.holdResponses);
  const server = http.createServer(async (request, response) => {
    const endpoint = request.url?.split('?')[0];
    if (
      request.method !== 'POST' ||
      (endpoint !== '/api/v1/chat/new' && endpoint !== '/api/v1/message/text')
    ) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >;
    const sequence = posts.length + 1;
    const addresses = Array.isArray(body.addresses)
      ? body.addresses.map(String)
      : [];
    const approvedAddress = addresses[0] || '';
    const approvedDigits = approvedAddress.replace(/\D/g, '');
    const providerDirectAddress = approvedAddress.includes('@')
      ? approvedAddress.toLowerCase()
      : approvedDigits.length === 11 && approvedDigits.startsWith('1')
        ? approvedDigits.slice(1)
        : approvedDigits;
    const post: ProviderPost = {
      endpoint,
      receiptId: `bb:fake-provider-message-${sequence}`,
      chatJid:
        endpoint === '/api/v1/chat/new'
          ? `bb:SMS;-;${providerDirectAddress}`
          : `bb:${String(body.chatGuid || '')}`,
      addresses,
      message: String(body.message || ''),
      method: String(body.method || ''),
      service: typeof body.service === 'string' ? body.service : null,
      tempGuid: String(body.tempGuid || ''),
      observedAt: `2026-07-16T12:00:0${Math.min(sequence, 9)}.000Z`,
    };
    posts.push(post);
    for (const waiter of [...waiters]) {
      if (posts.length >= waiter.count) waiter.resolve();
    }
    if (holdResponses) return;
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        receiptId: post.receiptId,
        threadId: post.chatJid,
      }),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const provider: FakeProvider = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    posts,
    get holdResponses() {
      return holdResponses;
    },
    set holdResponses(value: boolean) {
      holdResponses = value;
    },
    waitForPostCount(count, timeoutMs = 30_000) {
      if (posts.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = {
          count,
          resolve: () => {
            clearTimeout(timeout);
            const index = waiters.indexOf(entry);
            if (index >= 0) waiters.splice(index, 1);
            resolve();
          },
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(entry);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Fake provider did not observe ${count} POST(s).`));
        }, timeoutMs);
        waiters.push(entry);
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  providers.add(provider);
  return provider;
}

afterEach(async () => {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL');
    }
  }
  workers.clear();
  for (const provider of providers) await provider.close();
  providers.clear();
  for (const fixture of fixtures) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe('BlueBubbles first-contact durable subprocess recovery', () => {
  it('stages the initial Text turn, then keeps the separately approved /chat/new dispatch fence durable after SIGKILL', async () => {
    const fixture = createFixture('fence');
    const provider = await startFakeProvider({ holdResponses: true });
    await runWorker(fixture, { kind: 'initialize' });
    const stagedAction = await stageInitialTextRequest(fixture, provider);

    const crashing = spawnWorker(fixture, {
      kind: 'approve',
      approvalText: 'Send now',
      providerBaseUrl: provider.baseUrl,
    });
    await provider.waitForPostCount(1);
    await hardKill(crashing);

    const inspection = await runWorker(fixture, { kind: 'inspect' });
    const action = asRecord(inspection.action);
    const dispatchAttempt = asRecord(action.dispatchAttempt);
    expect(action.messageActionId).toBe(stagedAction.messageActionId);
    expect(action.sendStatus).toBe('delivery_unverified');
    expect(action.approvedAt).toBe('2026-07-16T12:00:01.000Z');
    expect(dispatchAttempt.state).toBe('dispatching');
    expect(dispatchAttempt.idempotencyKey).toBe(action.messageActionId);
    expect(provider.posts).toHaveLength(1);
    expect(provider.posts[0]?.endpoint).toBe('/api/v1/chat/new');
    expect(provider.posts[0]?.addresses).toEqual(['+12025550123']);
    expect(provider.posts[0]?.method).toBe('private-api');
    expect(provider.posts[0]?.service).toBe('iMessage');
    expect(provider.posts[0]?.tempGuid).toBe(action.messageActionId);
    expect(provider.posts[0]?.message).toBe(action.draftText);
    expect(JSON.parse(String(action.targetConversationJson))).toMatchObject({
      chatJid: 'bb:iMessage;-;+12025550123',
      blueBubblesCreateChatAddress: '+12025550123',
    });
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('reconciles delayed /chat/new evidence from a separate approval under the real chat GUID and replays without redispatch', async () => {
    const fixture = createFixture('recovery');
    const provider = await startFakeProvider({ holdResponses: true });
    await runWorker(fixture, { kind: 'initialize' });
    const stagedAction = await stageInitialTextRequest(fixture, provider);

    const crashing = spawnWorker(fixture, {
      kind: 'approve',
      approvalText: 'send it',
      providerBaseUrl: provider.baseUrl,
    });
    await provider.waitForPostCount(1);
    await hardKill(crashing);
    provider.holdResponses = false;

    const effect = provider.posts[0]!;
    const recovered = await runWorker(fixture, {
      kind: 'recover_and_replay',
      providerBaseUrl: provider.baseUrl,
      providerEffect: effect,
    });
    expect(recovered.uncorrelated).toEqual({
      inspected: 1,
      reconciled: 0,
      stillUnverified: 1,
    });
    expect(recovered.correlated).toEqual({
      inspected: 1,
      reconciled: 1,
      stillUnverified: 0,
    });
    expect(recovered.replayState).toBe('sent');
    expect(provider.posts).toHaveLength(1);
    expect(effect.endpoint).toBe('/api/v1/chat/new');
    expect(effect.chatJid).toBe('bb:SMS;-;2025550123');
    expect(effect.tempGuid).toBe(stagedAction.messageActionId);

    const action = asRecord(recovered.action);
    const receipt = asRecord(action.executionReceipt);
    expect(action.sendStatus).toBe('sent');
    expect(action.platformMessageId).toBe(effect.receiptId);
    expect(receipt.providerReceiptId).toBe(effect.receiptId);
    expect(receipt.idempotencyKey).toBe(effect.tempGuid);
    expect(receipt.exactContent).toBe(effect.message);
    expect(receipt.recipient).toBe('Travis Story');
    expect(receipt.threadId).toBe(effect.chatJid);
    expect(JSON.parse(String(action.targetConversationJson))).toMatchObject({
      chatJid: effect.chatJid,
      blueBubblesCreateChatAddress: null,
    });
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('rejects a stale cross-process explicit approval claim after a newer draft-state CAS wins', async () => {
    const fixture = createFixture('stale-explicit-claim');
    await runWorker(fixture, { kind: 'initialize' });
    const staged = await runWorker(fixture, { kind: 'stage' });
    const stagedAction = asRecord(staged.action);
    expect(stagedAction).toMatchObject({
      sendStatus: 'drafted',
      approvedAt: null,
      draftText: 'Original bytes approved by the stale process.',
    });

    const staleClaim = spawnWorker(fixture, {
      kind: 'stale_explicit_claim',
      barrierPath: fixture.barrierPath,
    });
    const ready = await staleClaim.nextMessage();
    expect(ready.type).toBe('ready_for_stale_claim');
    expect(asRecord(ready.action).lastUpdatedAt).toBe(
      stagedAction.lastUpdatedAt,
    );

    const mutation = await runWorker(fixture, {
      kind: 'mutate_staged_action',
    });
    expect(mutation.mutated).toBe(true);
    expect(asRecord(mutation.action)).toMatchObject({
      sendStatus: 'skipped',
      approvedAt: null,
      draftText: 'Newer authoritative bytes that must remain unsent.',
      lastUpdatedAt: '2026-07-16T12:00:01.000Z',
    });

    fs.writeFileSync(fixture.barrierPath, 'release\n', { mode: 0o600 });
    const rejected = await completeWorker(staleClaim);
    expect(rejected.claimed).toBe(false);
    const finalAction = asRecord(rejected.action);
    expect(finalAction).toMatchObject({
      messageActionId: stagedAction.messageActionId,
      sendStatus: 'skipped',
      approvedAt: null,
      draftText: 'Newer authoritative bytes that must remain unsent.',
      lastUpdatedAt: '2026-07-16T12:00:01.000Z',
    });
    expect(asRecord(finalAction.dispatchAttempt)).toEqual({});
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('lets two fresh approvals race one staged first-contact action with one /chat/new POST and tempGuid', async () => {
    const fixture = createFixture('race');
    const provider = await startFakeProvider();
    await runWorker(fixture, { kind: 'initialize' });
    const stagedAction = await stageInitialTextRequest(fixture, provider);

    const first = spawnWorker(fixture, {
      kind: 'race_approve',
      workerId: 'one',
      approvalText: 'Send now',
      providerBaseUrl: provider.baseUrl,
      barrierPath: fixture.barrierPath,
    });
    const second = spawnWorker(fixture, {
      kind: 'race_approve',
      workerId: 'two',
      approvalText: 'send it',
      providerBaseUrl: provider.baseUrl,
      barrierPath: fixture.barrierPath,
    });
    const firstReady = await first.nextMessage();
    const secondReady = await second.nextMessage();
    expect(firstReady).toMatchObject({
      type: 'ready_for_barrier',
      messageActionId: stagedAction.messageActionId,
    });
    expect(secondReady).toMatchObject({
      type: 'ready_for_barrier',
      messageActionId: stagedAction.messageActionId,
    });
    fs.writeFileSync(fixture.barrierPath, 'release\n', { mode: 0o600 });

    const [firstResult, secondResult] = await Promise.all([
      completeWorker(first),
      completeWorker(second),
    ]);
    const firstAction = asRecord(firstResult.action);
    const secondAction = asRecord(secondResult.action);
    expect([firstResult.state, secondResult.state]).toContain('sent');
    expect(['delivery_unverified', 'sent']).toContain(firstResult.state);
    expect(['delivery_unverified', 'sent']).toContain(secondResult.state);
    expect(firstAction.messageActionId).toBe(secondAction.messageActionId);
    expect(firstAction.messageActionId).toBe(stagedAction.messageActionId);
    expect(provider.posts).toHaveLength(1);
    expect(provider.posts[0]?.endpoint).toBe('/api/v1/chat/new');
    expect(provider.posts[0]?.addresses).toEqual(['+12025550123']);
    expect(provider.posts[0]?.method).toBe('private-api');
    expect(provider.posts[0]?.service).toBe('iMessage');
    expect(provider.posts[0]?.tempGuid).toBe(firstAction.messageActionId);

    const inspection = await runWorker(fixture, { kind: 'inspect' });
    const finalAction = asRecord(inspection.action);
    expect(finalAction.messageActionId).toBe(firstAction.messageActionId);
    expect(finalAction.sendStatus).toBe('sent');
    expect(finalAction.platformMessageId).toBe(provider.posts[0]?.receiptId);
    expect(
      JSON.parse(String(finalAction.targetConversationJson)),
    ).toMatchObject({
      chatJid: provider.posts[0]?.chatJid,
      blueBubblesCreateChatAddress: null,
    });
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);
});
