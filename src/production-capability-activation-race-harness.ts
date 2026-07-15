import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { buildHermeticTestEnv } from './hermetic-test-env.js';

const WORKER_LOADER = fileURLToPath(
  new URL(
    '../scripts/fixtures/production-capability-hard-kill-worker.mjs',
    import.meta.url,
  ),
);

interface WorkerMessage {
  type?: string;
  workerId?: string;
  success?: boolean;
  receiptId?: string;
  failureClass?: string;
  acquisitionId?: string;
  runId?: string;
  expectedAcquisitionVersion?: number;
  expectedRunRevision?: number;
}

interface WorkerCommand {
  kind: 'prepare_activation_race' | 'race_activation';
  databasePath: string;
  markerPath: string;
  statePath: string;
  effectCounterPath: string;
  barrierPath: string;
  workerId?: string;
}

interface ManagedWorker {
  child: ChildProcess;
  waitFor(type: string, timeoutMs?: number): Promise<WorkerMessage>;
  waitForExit(timeoutMs?: number): Promise<void>;
  stderr(): string;
  stop(): void;
}

export interface ProductionCapabilityActivationRaceEvidence {
  readyConsumers: number;
  attemptedConsumers: number;
  successfulConsumers: number;
  staleOrConsumedFailures: number;
  activationReceiptCount: number;
  activeProjectionCount: number;
  runId: string;
  evidenceIds: string[];
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-128 * 1024);
}

function spawnWorker(command: WorkerCommand): ManagedWorker {
  let stderr = '';
  const messages: WorkerMessage[] = [];
  const waiters: Array<{
    type: string;
    resolve: (message: WorkerMessage) => void;
    reject: (error: Error) => void;
  }> = [];
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
  child.stderr?.on('data', (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.on('message', (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const message = value as WorkerMessage;
    if (message.type === 'error') {
      const error = new Error(
        `Activation-race worker failed: ${message.failureClass || 'unknown'}. stderr=${stderr}`,
      );
      for (const waiter of waiters.splice(0)) waiter.reject(error);
      messages.push(message);
      return;
    }
    const waiterIndex = waiters.findIndex(
      (waiter) => waiter.type === message.type,
    );
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter?.resolve(message);
      return;
    }
    messages.push(message);
  });
  child.send(command);

  return {
    child,
    stderr: () => stderr,
    waitFor(type, timeoutMs = 45_000) {
      const bufferedErrorIndex = messages.findIndex(
        (message) => message.type === 'error',
      );
      if (bufferedErrorIndex >= 0) {
        const [message] = messages.splice(bufferedErrorIndex, 1);
        return Promise.reject(
          new Error(
            `Activation-race worker failed: ${message?.failureClass || 'unknown'}. stderr=${stderr}`,
          ),
        );
      }
      const bufferedIndex = messages.findIndex(
        (message) => message.type === type,
      );
      if (bufferedIndex >= 0) {
        const [message] = messages.splice(bufferedIndex, 1);
        return Promise.resolve(message as WorkerMessage);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve(message: WorkerMessage) {
            clearTimeout(timeout);
            resolve(message);
          },
          reject(error: Error) {
            clearTimeout(timeout);
            reject(error);
          },
        };
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `Activation-race worker timed out waiting for ${type}. stderr=${stderr}`,
            ),
          );
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    waitForExit(timeoutMs = 45_000) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return child.exitCode === 0
          ? Promise.resolve()
          : Promise.reject(
              new Error(
                `Activation-race worker exited ${child.signalCode || child.exitCode}. stderr=${stderr}`,
              ),
            );
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(`Activation-race worker did not exit. stderr=${stderr}`),
          );
        }, timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          if (code === 0) resolve();
          else
            reject(
              new Error(
                `Activation-race worker exited ${signal || code}. stderr=${stderr}`,
              ),
            );
        });
      });
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

function readCanonicalCounts(
  databasePath: string,
  runId: string,
): {
  activationReceiptCount: number;
  activeProjectionCount: number;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const receipt = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM capability_production_transition_receipts
         WHERE run_id = ? AND transition_kind = 'activated'`,
      )
      .get(runId) as { count: number };
    const projection = database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM skill_playbooks
         WHERE status = 'active'
           AND skill_id = (
             SELECT compiled_skill_id
             FROM capability_acquisitions
             WHERE acquisition_id = (
               SELECT acquisition_id FROM capability_production_runs
               WHERE run_id = ?
             )
           )`,
      )
      .get(runId) as { count: number };
    return {
      activationReceiptCount: Number(receipt.count),
      activeProjectionCount: Number(projection.count),
    };
  } finally {
    database.close();
  }
}

/**
 * Runs two independent Node processes against one isolated SQLite file. Both
 * consumers snapshot the same activation head before a parent-owned barrier
 * is released, so this proves database/CAS behavior rather than event-loop
 * serialization.
 */
export async function runProductionCapabilityActivationRace(params: {
  fixtureRoot: string;
}): Promise<ProductionCapabilityActivationRaceEvidence> {
  const root = fs.mkdtempSync(
    path.join(params.fixtureRoot, 'activation-race-'),
  );
  const databasePath = path.join(root, 'capability.db');
  const statePath = path.join(root, 'state.json');
  const markerPath = path.join(root, 'marker.json');
  const effectCounterPath = path.join(root, 'effect-count.txt');
  const barrierPath = path.join(root, 'release.barrier');
  const workers = new Set<ManagedWorker>();
  try {
    const seed = spawnWorker({
      kind: 'prepare_activation_race',
      databasePath,
      statePath,
      markerPath,
      effectCounterPath,
      barrierPath,
    });
    workers.add(seed);
    const prepared = await seed.waitFor('activation_race_prepared');
    await seed.waitForExit();
    workers.delete(seed);
    if (!prepared.runId || !prepared.acquisitionId) {
      throw new Error('Activation-race seed returned incomplete identity.');
    }

    const racers = ['certification-racer-a', 'certification-racer-b'].map(
      (workerId) => {
        const worker = spawnWorker({
          kind: 'race_activation',
          databasePath,
          statePath,
          markerPath,
          effectCounterPath,
          barrierPath,
          workerId,
        });
        workers.add(worker);
        return worker;
      },
    );
    const ready = await Promise.all(
      racers.map((worker) => worker.waitFor('activation_race_ready')),
    );
    const sameHead =
      new Set(ready.map((item) => item.expectedAcquisitionVersion)).size ===
        1 && new Set(ready.map((item) => item.expectedRunRevision)).size === 1;
    if (!sameHead) {
      throw new Error('Activation racers did not snapshot the same head.');
    }
    const resultPromises = racers.map((worker) =>
      worker.waitFor('activation_race_result'),
    );
    const temporaryBarrier = `${barrierPath}.tmp`;
    fs.writeFileSync(temporaryBarrier, 'release\n', { mode: 0o600 });
    fs.renameSync(temporaryBarrier, barrierPath);
    const results = await Promise.all(resultPromises);
    await Promise.all(racers.map((worker) => worker.waitForExit()));
    for (const worker of racers) workers.delete(worker);

    const canonical = readCanonicalCounts(databasePath, prepared.runId);
    const successful = results.filter((item) => item.success === true);
    return {
      readyConsumers: ready.length,
      attemptedConsumers: results.length,
      successfulConsumers: successful.length,
      staleOrConsumedFailures: results.filter(
        (item) =>
          item.success === false &&
          item.failureClass === 'stale_or_consumed_authority',
      ).length,
      activationReceiptCount: canonical.activationReceiptCount,
      activeProjectionCount: canonical.activeProjectionCount,
      runId: prepared.runId,
      evidenceIds: [
        prepared.runId,
        ...successful
          .map((item) => item.receiptId)
          .filter((value): value is string => Boolean(value)),
      ],
    };
  } finally {
    for (const worker of workers) worker.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
