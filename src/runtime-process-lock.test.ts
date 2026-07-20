import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRuntimeProcessLock,
  DEFAULT_MALFORMED_RUNTIME_LOCK_STALE_AFTER_MS,
  RuntimeProcessLockBusyError,
  type RuntimeProcessLock,
} from './runtime-process-lock.js';

const NOW = new Date('2026-07-16T18:00:00.000Z');

const tempDirectories: string[] = [];

async function makeLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'andrea-runtime-lock-'));
  tempDirectories.push(directory);
  return join(directory, 'runtime.lock');
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('runtime process lock', () => {
  it('is acquired by main before database initialization or recovery', async () => {
    const indexSource = await readFile(
      new URL('./index.ts', import.meta.url),
      'utf8',
    );
    const mainSource = indexSource.slice(
      indexSource.indexOf('async function main(): Promise<void>'),
    );
    const acquisitionIndex = mainSource.indexOf(
      'await acquireRuntimeProcessLock(',
    );
    const databaseInitializationIndex = mainSource.indexOf('initDatabase();');
    const recoveryIndex = mainSource.indexOf(
      'reconcileDurableContinuityBeforeAcceptingWork()',
    );

    expect(acquisitionIndex).toBeGreaterThanOrEqual(0);
    expect(databaseInitializationIndex).toBeGreaterThan(acquisitionIndex);
    expect(recoveryIndex).toBeGreaterThan(acquisitionIndex);
    expect(mainSource).toContain("process.once('exit'");
    expect(mainSource).toContain('runtimeProcessLock.releaseSync()');
  });

  it('atomically creates one exclusive JSON lock and blocks a live owner', async () => {
    const lockPath = await makeLockPath();
    const first = await acquireRuntimeProcessLock(lockPath, {
      pid: 111,
      now: () => NOW,
      randomToken: () => 'owner-token-111',
      isProcessAlive: () => true,
    });

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: 111,
      token: 'owner-token-111',
      acquiredAt: NOW.toISOString(),
    });

    await expect(
      acquireRuntimeProcessLock(lockPath, {
        pid: 222,
        now: () => NOW,
        randomToken: () => 'owner-token-222',
        isProcessAlive: (pid) => pid === 111,
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeProcessLockBusyError',
      code: 'RUNTIME_PROCESS_LOCK_BUSY',
      reason: 'live_process',
      ownerPid: 111,
    });

    expect(await first.release()).toBe(true);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows exactly one winner when two processes contend for a missing file', async () => {
    const lockPath = await makeLockPath();
    const contenders = await Promise.allSettled([
      acquireRuntimeProcessLock(lockPath, {
        pid: 301,
        now: () => NOW,
        randomToken: () => 'contender-token-301',
        isProcessAlive: () => true,
      }),
      acquireRuntimeProcessLock(lockPath, {
        pid: 302,
        now: () => NOW,
        randomToken: () => 'contender-token-302',
        isProcessAlive: () => true,
      }),
    ]);

    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<RuntimeProcessLock> =>
        result.status === 'fulfilled',
    );
    const blocked = contenders.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(winners).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.reason).toBeInstanceOf(RuntimeProcessLockBusyError);

    await winners[0]?.value.release();
  });

  it('reclaims a valid lock whose PID is dead, even when the file is recent', async () => {
    const lockPath = await makeLockPath();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 404,
        token: 'dead-owner-token',
        acquiredAt: NOW.toISOString(),
      })}\n`,
      'utf8',
    );
    const isProcessAlive = vi.fn((pid: number) => pid !== 404);

    const lock = await acquireRuntimeProcessLock(lockPath, {
      pid: 405,
      now: () => NOW,
      randomToken: () => 'replacement-owner-token',
      isProcessAlive,
    });

    expect(isProcessAlive).toHaveBeenCalledWith(404);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: 405,
      token: 'replacement-owner-token',
      acquiredAt: NOW.toISOString(),
    });
    await lock.release();
  });

  it('fails closed on a malformed lock that is still recent', async () => {
    const lockPath = await makeLockPath();
    await writeFile(lockPath, '{"pid":', 'utf8');
    await utimes(lockPath, NOW, NOW);

    await expect(
      acquireRuntimeProcessLock(lockPath, {
        pid: 501,
        now: () => NOW,
        randomToken: () => 'new-owner-token',
        isProcessAlive: () => false,
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeProcessLockBusyError',
      reason: 'recent_malformed_lock',
    });
    expect(await readFile(lockPath, 'utf8')).toBe('{"pid":');
  });

  it('reclaims a malformed lock only after the conservative stale timeout', async () => {
    const lockPath = await makeLockPath();
    // Valid JSON with the wrong shape is still a malformed lock record.
    await writeFile(lockPath, 'null\n', 'utf8');
    const staleTime = new Date(
      NOW.getTime() - DEFAULT_MALFORMED_RUNTIME_LOCK_STALE_AFTER_MS - 1,
    );
    await utimes(lockPath, staleTime, staleTime);

    const lock = await acquireRuntimeProcessLock(lockPath, {
      pid: 601,
      now: () => NOW,
      randomToken: () => 'stale-replacement-token',
      isProcessAlive: () => false,
    });

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual({
      pid: 601,
      token: 'stale-replacement-token',
      acquiredAt: NOW.toISOString(),
    });
    await lock.release();
  });

  it('does not unlink a replacement lock when the release token no longer matches', async () => {
    const lockPath = await makeLockPath();
    const original = await acquireRuntimeProcessLock(lockPath, {
      pid: 701,
      now: () => NOW,
      randomToken: () => 'original-owner-token',
      isProcessAlive: () => true,
    });
    const replacement = {
      pid: 702,
      token: 'replacement-owner-token',
      acquiredAt: new Date(NOW.getTime() + 1_000).toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');

    expect(await original.release()).toBe(false);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('synchronously releases an owned lock for process-exit handlers', async () => {
    const lockPath = await makeLockPath();
    const lock = await acquireRuntimeProcessLock(lockPath, {
      pid: 751,
      now: () => NOW,
      randomToken: () => 'synchronous-owner-token',
      isProcessAlive: () => true,
    });

    expect(lock.releaseSync()).toBe(true);
    expect(lock.releaseSync()).toBe(true);
    expect(await lock.release()).toBe(true);
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('synchronous release preserves a replacement with a different token', async () => {
    const lockPath = await makeLockPath();
    const original = await acquireRuntimeProcessLock(lockPath, {
      pid: 761,
      now: () => NOW,
      randomToken: () => 'synchronous-original-token',
      isProcessAlive: () => true,
    });
    const replacement = {
      pid: 762,
      token: 'synchronous-replacement-token',
      acquiredAt: new Date(NOW.getTime() + 1_000).toISOString(),
    };
    await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, 'utf8');

    expect(original.releaseSync()).toBe(false);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('fails closed when PID liveness cannot be determined', async () => {
    const lockPath = await makeLockPath();
    await writeFile(
      lockPath,
      `${JSON.stringify({
        pid: 801,
        token: 'unverifiable-owner-token',
        acquiredAt: NOW.toISOString(),
      })}\n`,
      'utf8',
    );

    await expect(
      acquireRuntimeProcessLock(lockPath, {
        pid: 802,
        now: () => NOW,
        randomToken: () => 'unused-owner-token',
        isProcessAlive: () => {
          throw new Error('probe denied');
        },
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeProcessLockBusyError',
      reason: 'process_status_unknown',
      ownerPid: 801,
    });
  });
});
