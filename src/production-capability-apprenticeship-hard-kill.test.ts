/* eslint-disable no-catch-all/no-catch-all -- Boundary polling retries absent or partially written isolated fixture markers. */
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { buildHermeticTestEnv } from './hermetic-test-env.js';

type WorkerKind =
  | 'crash_canary_stage'
  | 'inspect_and_retry_canary'
  | 'crash_activation_stage'
  | 'inspect_and_retry_activation'
  | 'crash_active_reuse_stage'
  | 'inspect_and_retry_active_reuse'
  | 'crash_after_receipts'
  | 'recover_after_receipts';

interface FixturePaths {
  root: string;
  databasePath: string;
  markerPath: string;
  statePath: string;
  effectCounterPath: string;
}

interface ManagedWorker {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

const WORKER_LOADER = fileURLToPath(
  new URL(
    '../scripts/fixtures/production-capability-hard-kill-worker.mjs',
    import.meta.url,
  ),
);
const fixtures = new Set<FixturePaths>();
const workers = new Set<ManagedWorker>();

function createFixture(label: string): FixturePaths {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-capability-kill-${label}-`),
  );
  const fixture = {
    root,
    databasePath: path.join(root, 'capability.db'),
    markerPath: path.join(root, 'boundary.json'),
    statePath: path.join(root, 'state.json'),
    effectCounterPath: path.join(root, 'effect-count.txt'),
  };
  fixtures.add(fixture);
  return fixture;
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-128 * 1024);
}

function spawnWorker(fixture: FixturePaths, kind: WorkerKind): ManagedWorker {
  let stdout = '';
  let stderr = '';
  const child = fork(WORKER_LOADER, [], {
    cwd: process.cwd(),
    env: {
      ...buildHermeticTestEnv(process.env, { isolateStorage: false }),
      ANDREA_NOVEL_CAPABILITY_CERT_HERMETIC_PARENT: '1',
      ANDREA_TEST_NETWORK_GUARD_ACTIVE: '1',
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
  const worker = { child, stdout: () => stdout, stderr: () => stderr };
  workers.add(worker);
  child.send({ kind, ...fixture });
  return worker;
}

function waitForMessage(
  worker: ManagedWorker,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Capability hard-kill worker timed out. stderr=${worker.stderr()}`,
        ),
      );
    }, timeoutMs);
    worker.child.once('message', (value) => {
      clearTimeout(timeout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(new Error('Capability hard-kill worker returned invalid IPC.'));
        return;
      }
      resolve(value as Record<string, unknown>);
    });
    worker.child.once('exit', (code, signal) => {
      if (code === 0) return;
      clearTimeout(timeout);
      reject(
        new Error(
          `Capability hard-kill worker exited before evidence (${signal || code}). stderr=${worker.stderr()}`,
        ),
      );
    });
  });
}

async function waitForBoundary(
  fixture: FixturePaths,
  expected: string,
  worker: ManagedWorker,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(
        fs.readFileSync(fixture.markerPath, 'utf8'),
      ) as {
        boundary?: string;
      };
      if (marker.boundary === expected) return;
    } catch {
      // The child creates the marker only after entering the exact boundary.
    }
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      throw new Error(
        `Capability worker exited before ${expected}. stderr=${worker.stderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Capability boundary ${expected} was not reached.`);
}

async function hardKill(worker: ManagedWorker): Promise<void> {
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    worker.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (!worker.child.kill('SIGKILL')) {
    throw new Error('Failed to terminate capability hard-kill worker.');
  }
  const result = await exit;
  if (process.platform !== 'win32') expect(result.signal).toBe('SIGKILL');
  workers.delete(worker);
}

async function runWorker(
  fixture: FixturePaths,
  kind: WorkerKind,
): Promise<Record<string, unknown>> {
  const worker = spawnWorker(fixture, kind);
  const message = await waitForMessage(worker);
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      resolve({ code: worker.child.exitCode, signal: worker.child.signalCode });
      return;
    }
    worker.child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  workers.delete(worker);
  if (exit.code !== 0 || message.type === 'error') {
    throw new Error(
      `Capability hard-kill fixture failed (${String(message.failureClass || exit.signal || exit.code)}). stderr=${worker.stderr()}`,
    );
  }
  return message;
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

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}

afterEach(() => {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL');
    }
  }
  workers.clear();
  for (const fixture of fixtures) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe('production capability apprenticeship hard-kill recovery', () => {
  it('rolls back canary staging atomically when the process dies before the canonical run insert', async () => {
    const fixture = createFixture('canary-stage');
    const crashing = spawnWorker(fixture, 'crash_canary_stage');
    await waitForBoundary(fixture, 'after_canary_stage_before_run', crashing);
    await hardKill(crashing);

    const proof = await runWorker(fixture, 'inspect_and_retry_canary');
    expect(proof.type).toBe('canary_rollback_verified');
    expect(record(proof.beforeRetry)).toEqual(record(proof.baseline));
    const before = record(proof.beforeRetry);
    const after = record(proof.afterRetry);
    // Candidate certification owns one sandbox work identity. The staging
    // crash must add nothing beyond that exact pre-stage baseline.
    expect(before.productionRuns).toBe(0);
    expect(before.approvals).toBe(0);
    expect(before.cognitiveRuns).toBe(0);
    expect(proof.runStatus).toBe('awaiting_canary_approval');
    expect(proof.approvalStatus).toBe('staged');
    expect(after.productionRuns).toBe(1);
    expect(after.durableWorks).toBe(Number(before.durableWorks) + 1);
    expect(after.approvals).toBe(1);
    expect(after.cognitiveRuns).toBe(1);
    expect(Number(after.durableLinks)).toBeGreaterThan(
      Number(before.durableLinks),
    );
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('rolls back activation staging atomically and permits one clean restage', async () => {
    const fixture = createFixture('activation-stage');
    const crashing = spawnWorker(fixture, 'crash_activation_stage');
    await waitForBoundary(
      fixture,
      'after_activation_stage_before_run',
      crashing,
    );
    await hardKill(crashing);

    const proof = await runWorker(fixture, 'inspect_and_retry_activation');
    expect(proof.type).toBe('activation_rollback_verified');
    expect(record(proof.beforeRetry)).toEqual(record(proof.baseline));
    expect(proof.runStatusBeforeRetry).toBe('owner_reviewed');
    expect(proof.activationWorkBeforeRetry).toBeNull();
    expect(proof.runStatusAfterRetry).toBe('awaiting_activation_approval');
    expect(proof.activationWorkAfterRetry).toEqual(expect.any(String));
    expect(proof.approvalStatus).toBe('staged');
    const before = record(proof.beforeRetry);
    const after = record(proof.afterRetry);
    expect(after.productionRuns).toBe(before.productionRuns);
    expect(after.durableWorks).toBe(Number(before.durableWorks) + 1);
    expect(after.approvals).toBe(Number(before.approvals) + 1);
    expect(after.cognitiveRuns).toBe(Number(before.cognitiveRuns) + 1);
    expect(Number(after.durableLinks)).toBeGreaterThan(
      Number(before.durableLinks),
    );
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('rolls back active-reuse work, grant, and lease rows after a real process death', async () => {
    const fixture = createFixture('active-reuse-stage');
    const crashing = spawnWorker(fixture, 'crash_active_reuse_stage');
    await waitForBoundary(
      fixture,
      'after_active_reuse_lease_before_run',
      crashing,
    );
    await hardKill(crashing);

    const proof = await runWorker(fixture, 'inspect_and_retry_active_reuse');
    expect(proof.type).toBe('active_reuse_rollback_verified');
    expect(record(proof.beforeRetry)).toEqual(record(proof.baseline));
    expect(proof.runStatus).toBe('monitoring');
    expect(proof.runKind).toBe('active_reuse');
    expect(proof.runWorkId).toEqual(expect.any(String));
    expect(proof.runLeaseId).toEqual(expect.any(String));
    const before = record(proof.beforeRetry);
    const after = record(proof.afterRetry);
    expect(after.productionRuns).toBe(Number(before.productionRuns) + 1);
    expect(after.durableWorks).toBe(Number(before.durableWorks) + 1);
    expect(after.durableLinks).toBe(Number(before.durableLinks) + 2);
    expect(after.durableCheckpoints).toBe(
      Number(before.durableCheckpoints) + 1,
    );
    expect(after.resumeGrants).toBe(Number(before.resumeGrants) + 1);
    expect(after.activeWorkLeases).toBe(Number(before.activeWorkLeases) + 1);
    expect(after.approvals).toBe(before.approvals);
    expect(after.cognitiveRuns).toBe(before.cognitiveRuns);
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);

  it('recovers persisted verified receipts without replay and remains idempotent', async () => {
    const fixture = createFixture('receipt-checkpoint');
    const crashing = spawnWorker(fixture, 'crash_after_receipts');
    await waitForBoundary(
      fixture,
      'after_receipts_before_checkpoint',
      crashing,
    );
    await hardKill(crashing);

    const proof = await runWorker(fixture, 'recover_after_receipts');
    expect(proof.type).toBe('receipt_recovery_verified');
    expect(proof.firstStatus).toBe('verified');
    expect(proof.secondStatus).toBe('verified');
    expect(proof.workStatus).toBe('completed');
    expect(proof.checkpointStatus).toBe('completed');
    expect(proof.outcomeLinked).toBe(true);
    expect(proof.executionCalls).toBe(1);
    expect(proof.countsAfterFirst).toEqual({
      effects: 1,
      outcomes: 1,
      steps: 1,
      receipts: 1,
      completionTransitions: 1,
    });
    expect(proof.countsAfterSecond).toEqual(proof.countsAfterFirst);
    expect(proof.secondRevision).toBe(proof.firstRevision);
    assertDatabaseHealthy(fixture.databasePath);
  }, 60_000);
});
