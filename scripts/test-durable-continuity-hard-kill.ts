import assert from 'node:assert/strict';
import fs from 'node:fs';

import Database from 'better-sqlite3';

import './test-network-guard.mjs';

import type { DurableContinuityBoundary } from '../src/durable-work-continuity.js';
import {
  assertNoSensitiveOutput,
  createContinuityFixture,
  hardKill,
  removeContinuityFixture,
  runWorkerCommand,
  spawnContinuityWorker,
  waitForBoundaryMarker,
  type ContinuityFixture,
  type ManagedContinuityWorker,
} from './fixtures/durable-continuity-process-harness.js';

const boundaries: DurableContinuityBoundary[] = [
  'before_checkpoint_commit',
  'after_checkpoint_commit',
  'after_lease_acquisition',
  'before_tool_invocation',
  'after_tool_start',
  'after_effect_before_receipt',
  'after_receipt_before_checkpoint',
  'after_final_write_before_verification',
  'after_verification_before_completion',
  'after_completion_before_reply',
  'after_reply_before_learning',
  'during_replan',
];

function numeric(message: Record<string, unknown>, key: string): number {
  const value = message[key];
  if (typeof value !== 'number') {
    throw new Error(`${key} must be numeric`);
  }
  return value;
}

function databaseHealth(databasePath: string): void {
  const database = new Database(databasePath, { readonly: true });
  try {
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.close();
  }
}

function assertNoTokenOnDisk(fixture: ContinuityFixture, token: string): void {
  for (const candidate of [
    fixture.databasePath,
    `${fixture.databasePath}-wal`,
    `${fixture.databasePath}-shm`,
  ]) {
    if (!fs.existsSync(candidate)) continue;
    assert.equal(
      fs.readFileSync(candidate).includes(Buffer.from(token)),
      false,
      'resume token plaintext reached SQLite storage',
    );
  }
}

async function crashAtBoundary(boundary: DurableContinuityBoundary) {
  const fixture = createContinuityFixture(boundary);
  let crashingWorker: ManagedContinuityWorker | null = null;
  try {
    crashingWorker = spawnContinuityWorker(fixture);
    crashingWorker.send({
      kind: 'run_boundary',
      boundary,
      databasePath: fixture.databasePath,
      workspacePath: fixture.workspacePath,
      markerPath: fixture.markerPath,
    });
    await Promise.race([
      waitForBoundaryMarker(fixture, boundary),
      crashingWorker.nextMessage().then((message) => {
        throw new Error(
          `Continuity worker exited before ${boundary} during ${String(message.phase || message.type || 'unknown')} (${String(message.failureClass || 'unclassified')}).`,
        );
      }),
    ]);
    await hardKill(crashingWorker);
    assertNoSensitiveOutput(crashingWorker, [fixture.root]);

    fs.rmSync(fixture.markerPath, { force: true });
    const recovery = await runWorkerCommand(fixture, {
      kind: 'recover_boundary',
      boundary,
    }).catch((error: unknown) => {
      const diagnostic =
        error instanceof Error
          ? error.message
          : 'continuity worker returned an unknown failure';
      throw new Error(`Recovery failed for ${boundary}: ${diagnostic}`);
    });
    assertNoSensitiveOutput(recovery.worker, [fixture.root]);
    assert.equal(recovery.message.type, 'recovered');
    assert.equal(recovery.message.status, 'completed');
    assert.equal(recovery.message.deliveryState, 'delivered');
    assert.equal(recovery.message.verified, true);
    assert.equal(recovery.message.productionStateTouched, false);
    assert.equal(
      numeric(recovery.message, 'repositoryEditAttempts'),
      1,
      `${boundary} repeated the repository effect`,
    );
    assert.equal(
      numeric(recovery.message, 'replyAttempts'),
      1,
      `${boundary} repeated delivery`,
    );
    assert.equal(
      numeric(recovery.message, 'learningAttempts'),
      1,
      `${boundary} repeated post-delivery learning`,
    );
    databaseHealth(fixture.databasePath);
    return {
      boundary,
      recovered: true,
      checkpointCount: numeric(recovery.message, 'checkpointCount'),
      receiptCount: numeric(recovery.message, 'receiptCount'),
      duplicateEffects: 0,
      killMode: process.platform === 'win32' ? 'force_terminate' : 'SIGKILL',
    };
  } finally {
    if (
      crashingWorker?.child.exitCode === null &&
      crashingWorker.child.signalCode === null
    ) {
      crashingWorker.child.kill('SIGKILL');
    }
    removeContinuityFixture(fixture);
  }
}

async function concurrentConsumptionProof() {
  const fixture = createContinuityFixture('concurrency');
  const workers: ManagedContinuityWorker[] = [];
  try {
    const setup = await runWorkerCommand(fixture, {
      kind: 'setup_concurrency',
    });
    assert.equal(setup.message.type, 'concurrency_setup');
    const token = setup.message.token;
    if (typeof token !== 'string') {
      throw new Error('Concurrency setup did not return a token over IPC.');
    }
    assert.ok(token.length >= 32);
    assertNoSensitiveOutput(setup.worker, [token, fixture.root]);
    assertNoTokenOnDisk(fixture, token);

    for (let index = 0; index < 8; index++) {
      const worker = spawnContinuityWorker(fixture);
      workers.push(worker);
      worker.send({
        kind: 'prepare_consume',
        databasePath: fixture.databasePath,
        workspacePath: fixture.workspacePath,
        markerPath: fixture.markerPath,
        token,
        workerId: `concurrent-worker-${index}`,
      });
    }
    const ready = await Promise.all(
      workers.map((worker) => worker.nextMessage()),
    );
    assert.ok(ready.every((message) => message.type === 'ready'));
    for (const worker of workers) worker.send({ kind: 'go' });
    const results = await Promise.all(
      workers.map(async (worker) => {
        const message = await worker.nextMessage();
        const exit = await worker.waitForExit();
        assert.equal(exit.code, 0);
        assertNoSensitiveOutput(worker, [token, fixture.root]);
        return message.status;
      }),
    );
    assert.equal(results.filter((status) => status === 'consumed').length, 1);
    assert.equal(
      results.filter((status) => status === 'already_consumed').length,
      7,
    );

    const inspection = await runWorkerCommand(fixture, { kind: 'inspect' });
    assert.equal(inspection.message.type, 'inspection');
    assert.deepEqual(inspection.message.tokenHashLengths, [64]);
    assert.equal(numeric(inspection.message, 'concurrentEffectAttempts'), 1);
    assertNoTokenOnDisk(fixture, token);
    databaseHealth(fixture.databasePath);
    return {
      workers: workers.length,
      winners: 1,
      safeRejections: 7,
      duplicateEffects: 0,
      tokenStoredAsHashOnly: true,
    };
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
      }
    }
    removeContinuityFixture(fixture);
  }
}

async function initializationAndLegacyProof() {
  const killedFixture = createContinuityFixture('initialization-kill');
  let worker: ManagedContinuityWorker | null = null;
  try {
    worker = spawnContinuityWorker(killedFixture);
    worker.send({
      kind: 'initialize_then_block',
      databasePath: killedFixture.databasePath,
      workspacePath: killedFixture.workspacePath,
      markerPath: killedFixture.markerPath,
    });
    await waitForBoundaryMarker(killedFixture, 'after_database_initialization');
    await hardKill(worker);
    const reopened = await runWorkerCommand(killedFixture, { kind: 'inspect' });
    assert.equal(reopened.message.type, 'inspection');
    databaseHealth(killedFixture.databasePath);
  } finally {
    if (worker?.child.exitCode === null && worker.child.signalCode === null) {
      worker.child.kill('SIGKILL');
    }
    removeContinuityFixture(killedFixture);
  }

  const legacyFixture = createContinuityFixture('legacy-schema');
  try {
    const legacy = new Database(legacyFixture.databasePath);
    legacy.exec(
      `CREATE TABLE legacy_continuity_marker (id TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    legacy
      .prepare(`INSERT INTO legacy_continuity_marker (id, value) VALUES (?, ?)`)
      .run('legacy-row', 'preserve-me');
    legacy.close();
    const migrated = await runWorkerCommand(legacyFixture, { kind: 'inspect' });
    assert.equal(migrated.message.type, 'inspection');
    const reopened = new Database(legacyFixture.databasePath, {
      readonly: true,
    });
    try {
      assert.deepEqual(
        reopened
          .prepare(`SELECT id, value FROM legacy_continuity_marker`)
          .get(),
        { id: 'legacy-row', value: 'preserve-me' },
      );
    } finally {
      reopened.close();
    }
    databaseHealth(legacyFixture.databasePath);
  } finally {
    removeContinuityFixture(legacyFixture);
  }

  const malformedFixture = createContinuityFixture('malformed-schema');
  try {
    const malformed = new Database(malformedFixture.databasePath);
    malformed.exec(
      `CREATE TABLE durable_work_units (work_id TEXT PRIMARY KEY)`,
    );
    malformed.close();
    const malformedWorker = spawnContinuityWorker(malformedFixture);
    malformedWorker.send({
      kind: 'inspect',
      databasePath: malformedFixture.databasePath,
      workspacePath: malformedFixture.workspacePath,
      markerPath: malformedFixture.markerPath,
    });
    const response = await malformedWorker.nextMessage();
    const exit = await malformedWorker.waitForExit();
    assert.deepEqual(
      { type: response.type, code: response.code },
      {
        type: 'error',
        code: 'continuity_worker_failed',
      },
    );
    assert.notEqual(exit.code, 0);
    assertNoSensitiveOutput(malformedWorker, [malformedFixture.root]);
  } finally {
    removeContinuityFixture(malformedFixture);
  }

  return {
    killPosition: 'after_schema_initialization',
    reopenedAfterKill: true,
    legacyRowPreserved: true,
    malformedPartialSchema: 'failed_closed',
    inDdlKillClaimed: false,
  };
}

async function main(): Promise<void> {
  await assert.rejects(
    fetch('https://continuity-network-deny.invalid'),
    (error: unknown) =>
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code ===
        'ANDREA_DETERMINISTIC_NETWORK_DENIED',
  );
  const boundaryResults = [];
  for (const boundary of boundaries) {
    boundaryResults.push(await crashAtBoundary(boundary));
  }
  const concurrency = await concurrentConsumptionProof();
  const initialization = await initializationAndLegacyProof();
  const report = {
    evaluation: 'durable-continuity-hard-kill-v1',
    processTermination:
      process.platform === 'win32' ? 'force_terminate' : 'SIGKILL',
    boundaryCount: boundaryResults.length,
    recoveredBoundaryCount: boundaryResults.filter((result) => result.recovered)
      .length,
    duplicateEffectCount: boundaryResults.reduce(
      (sum, result) => sum + result.duplicateEffects,
      concurrency.duplicateEffects,
    ),
    boundaries: boundaryResults,
    concurrency,
    initialization,
    externalNetwork: 'denied_and_asserted_by_deterministic_guard',
    productionStateTouched: false,
    status: 'pass',
  };
  assert.equal(report.boundaryCount, 12);
  assert.equal(report.recoveredBoundaryCount, 12);
  assert.equal(report.duplicateEffectCount, 0);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
