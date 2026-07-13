import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { buildHermeticTestEnv } from '../../src/hermetic-test-env.js';

const FIXTURE_LOADER = fileURLToPath(
  new URL('./durable-continuity-worker.mjs', import.meta.url),
);

export interface ContinuityFixture {
  root: string;
  databasePath: string;
  workspacePath: string;
  repositoryPath: string;
  markerPath: string;
}

export interface ManagedContinuityWorker {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  send: (message: Record<string, unknown>) => void;
  nextMessage: (timeoutMs?: number) => Promise<Record<string, unknown>>;
  waitForExit: (timeoutMs?: number) => Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
}

function gitObject(
  root: string,
  kind: 'blob' | 'tree' | 'commit',
  body: Buffer,
): string {
  const object = Buffer.concat([
    Buffer.from(`${kind} ${body.length}\0`, 'utf8'),
    body,
  ]);
  const digest = createHash('sha1').update(object).digest('hex');
  const objectPath = path.join(
    root,
    '.git',
    'objects',
    digest.slice(0, 2),
    digest.slice(2),
  );
  fs.mkdirSync(path.dirname(objectPath), { recursive: true });
  fs.writeFileSync(objectPath, deflateSync(object), { mode: 0o600 });
  return digest;
}

function createLocalGitRepository(repositoryPath: string): void {
  fs.mkdirSync(path.join(repositoryPath, '.git', 'objects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(repositoryPath, '.git', 'refs', 'heads'), {
    recursive: true,
  });
  const contents = Buffer.from('value=1\n', 'utf8');
  fs.writeFileSync(path.join(repositoryPath, 'fixture.txt'), contents);
  const blob = gitObject(repositoryPath, 'blob', contents);
  const treeBody = Buffer.concat([
    Buffer.from('100644 fixture.txt\0', 'utf8'),
    Buffer.from(blob, 'hex'),
  ]);
  const tree = gitObject(repositoryPath, 'tree', treeBody);
  const commitBody = Buffer.from(
    [
      `tree ${tree}`,
      'author Andrea Test <andrea-test@example.invalid> 0 +0000',
      'committer Andrea Test <andrea-test@example.invalid> 0 +0000',
      '',
      'initial fixture',
      '',
    ].join('\n'),
    'utf8',
  );
  const commit = gitObject(repositoryPath, 'commit', commitBody);
  fs.writeFileSync(
    path.join(repositoryPath, '.git', 'HEAD'),
    'ref: refs/heads/main\n',
  );
  fs.writeFileSync(
    path.join(repositoryPath, '.git', 'refs', 'heads', 'main'),
    `${commit}\n`,
  );
  fs.writeFileSync(
    path.join(repositoryPath, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n\tbare = false\n',
  );
}

export function createContinuityFixture(label: string): ContinuityFixture {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-continuity-${label}-`),
  );
  const workspacePath = path.join(root, 'workspace');
  const repositoryPath = path.join(workspacePath, 'repository');
  fs.mkdirSync(workspacePath, { recursive: true });
  createLocalGitRepository(repositoryPath);
  return {
    root,
    databasePath: path.join(root, 'continuity.db'),
    workspacePath,
    repositoryPath,
    markerPath: path.join(root, 'boundary.marker'),
  };
}

export function removeContinuityFixture(fixture: ContinuityFixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function appendBounded(current: string, chunk: Buffer | string): string {
  return `${current}${String(chunk)}`.slice(-128 * 1024);
}

export function spawnContinuityWorker(
  fixture: ContinuityFixture,
): ManagedContinuityWorker {
  let stdout = '';
  let stderr = '';
  const messages: Record<string, unknown>[] = [];
  const waiters: Array<(message: Record<string, unknown>) => void> = [];
  const child = fork(FIXTURE_LOADER, [], {
    cwd: fixture.workspacePath,
    env: buildHermeticTestEnv(process.env, { isolateStorage: false }),
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
    else messages.push(message);
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    send(message: Record<string, unknown>) {
      if (!child.connected) throw new Error('Continuity worker IPC is closed.');
      child.send(message);
    },
    nextMessage(timeoutMs = 15_000) {
      const queued = messages.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        let wrapped: (message: Record<string, unknown>) => void;
        const timeout = setTimeout(() => {
          const index = waiters.indexOf(wrapped);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Continuity worker message timed out.'));
        }, timeoutMs);
        wrapped = (message: Record<string, unknown>) => {
          clearTimeout(timeout);
          resolve(message);
        };
        waiters.push(wrapped);
      });
    },
    waitForExit(timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve({ code: child.exitCode, signal: child.signalCode });
          return;
        }
        const timeout = setTimeout(() => {
          reject(new Error('Continuity worker exit timed out.'));
        }, timeoutMs);
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal });
        });
      });
    },
  };
}

export async function waitForBoundaryMarker(
  fixture: ContinuityFixture,
  expectedBoundary: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const marker = JSON.parse(
        fs.readFileSync(fixture.markerPath, 'utf8'),
      ) as { boundary?: string };
      if (marker.boundary === expectedBoundary) return;
    } catch {
      // The marker is created atomically enough for this bounded polling loop;
      // incomplete or absent content is retried.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Continuity boundary ${expectedBoundary} was not reached.`);
}

export async function hardKill(worker: ManagedContinuityWorker): Promise<void> {
  const killed = worker.child.kill('SIGKILL');
  if (!killed) throw new Error('Failed to terminate continuity worker.');
  const exit = await worker.waitForExit();
  if (process.platform !== 'win32' && exit.signal !== 'SIGKILL') {
    throw new Error(`Expected SIGKILL, observed ${exit.signal || exit.code}.`);
  }
}

export function assertNoSensitiveOutput(
  worker: ManagedContinuityWorker,
  sentinels: readonly string[],
): void {
  const output = `${worker.stdout()}\n${worker.stderr()}`;
  for (const sentinel of sentinels) {
    if (sentinel && output.includes(sentinel)) {
      throw new Error('A continuity worker exposed a private sentinel.');
    }
  }
}

export async function runWorkerCommand(
  fixture: ContinuityFixture,
  command: Record<string, unknown>,
): Promise<{
  message: Record<string, unknown>;
  worker: ManagedContinuityWorker;
}> {
  const worker = spawnContinuityWorker(fixture);
  worker.send({
    ...command,
    databasePath: fixture.databasePath,
    workspacePath: fixture.workspacePath,
    markerPath: fixture.markerPath,
  });
  const message = await worker.nextMessage();
  const exit = await worker.waitForExit();
  if (exit.code !== 0) {
    throw new Error(
      `Continuity worker failed with exit ${exit.code} after ${String(message.type || 'unknown')} during ${String(message.phase || 'unknown')} (${String(message.failureClass || 'unclassified')}).`,
    );
  }
  return { message, worker };
}
