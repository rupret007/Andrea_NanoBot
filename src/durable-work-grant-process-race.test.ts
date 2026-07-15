import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildHermeticTestEnv } from './hermetic-test-env.js';

interface RaceFixture {
  root: string;
  databasePath: string;
  workspacePath: string;
  markerPath: string;
}

const WORKER_LOADER = fileURLToPath(
  new URL('../scripts/fixtures/durable-continuity-worker.mjs', import.meta.url),
);
const fixtures = new Set<RaceFixture>();
const workers = new Set<ChildProcess>();

function createFixture(): RaceFixture {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'andrea-grant-race-'),
  );
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(workspacePath, { recursive: true });
  const fixture = {
    root,
    databasePath: path.join(root, 'continuity.db'),
    workspacePath,
    markerPath: path.join(root, 'marker.json'),
  };
  fixtures.add(fixture);
  return fixture;
}

function spawnWorker(fixture: RaceFixture): ChildProcess {
  const child = fork(WORKER_LOADER, [], {
    cwd: fixture.workspacePath,
    env: buildHermeticTestEnv(process.env, { isolateStorage: false }),
    execArgv: [],
    serialization: 'advanced',
    silent: true,
  });
  workers.add(child);
  return child;
}

function waitForMessage(
  child: ChildProcess,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Grant-race worker message timed out.')),
      timeoutMs,
    );
    child.once('message', (value) => {
      clearTimeout(timeout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(new Error('Grant-race worker returned invalid IPC.'));
        return;
      }
      resolve(value as Record<string, unknown>);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.exitCode === 0) resolve();
      else reject(new Error('Grant-race worker exited unsuccessfully.'));
      return;
    }
    const timeout = setTimeout(
      () => reject(new Error('Grant-race worker exit timed out.')),
      timeoutMs,
    );
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error('Grant-race worker exited unsuccessfully.'));
    });
  });
}

async function runWorker(
  fixture: RaceFixture,
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const child = spawnWorker(fixture);
  const message = waitForMessage(child);
  child.send({
    ...command,
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    markerPath: fixture.markerPath,
  });
  const result = await message;
  await waitForExit(child);
  return result;
}

afterEach(async () => {
  for (const child of workers) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  workers.clear();
  for (const fixture of fixtures) {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe('durable approval grant process race', () => {
  it('allows exactly one process to issue a grant for one approval version', async () => {
    const fixture = createFixture();
    expect(
      await runWorker(fixture, { kind: 'setup_grant_race' }),
    ).toMatchObject({
      type: 'grant_race_setup',
      approvalVersion: 2,
    });

    const contenders = [spawnWorker(fixture), spawnWorker(fixture)];
    const readyMessages = contenders.map((child) => waitForMessage(child));
    for (const child of contenders) {
      child.send({
        kind: 'prepare_grant_issue',
        databasePath: fixture.databasePath,
        workspacePath: fixture.workspacePath,
        markerPath: fixture.markerPath,
      });
    }
    expect(await Promise.all(readyMessages)).toEqual([
      { type: 'ready' },
      { type: 'ready' },
    ]);

    const resultMessages = contenders.map((child) => waitForMessage(child));
    for (const child of contenders) child.send({ kind: 'go' });
    const results = await Promise.all(resultMessages);
    await Promise.all(contenders.map((child) => waitForExit(child)));
    expect(results.map((result) => result.status).sort()).toEqual([
      'duplicate_rejected',
      'issued',
    ]);
    expect(await runWorker(fixture, { kind: 'inspect' })).toMatchObject({
      type: 'inspection',
      grantCount: 1,
    });
  });
});
