import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from 'node:fs/promises';

/**
 * A malformed lock can be the brief result of a process dying between the
 * exclusive create and the record write. Keep it fail-closed long enough that
 * a slow or suspended writer cannot be mistaken for a stale owner.
 */
export const DEFAULT_MALFORMED_RUNTIME_LOCK_STALE_AFTER_MS = 30 * 60 * 1_000;

const MAX_ACQUIRE_ATTEMPTS = 8;

export interface RuntimeProcessLockRecord {
  pid: number;
  token: string;
  acquiredAt: string;
}

export type RuntimeProcessLockBusyReason =
  | 'live_process'
  | 'process_status_unknown'
  | 'recent_malformed_lock'
  | 'acquisition_contended';

export class RuntimeProcessLockBusyError extends Error {
  readonly code = 'RUNTIME_PROCESS_LOCK_BUSY';
  readonly lockPath: string;
  readonly reason: RuntimeProcessLockBusyReason;
  readonly ownerPid?: number;

  constructor(params: {
    lockPath: string;
    reason: RuntimeProcessLockBusyReason;
    ownerPid?: number;
    cause?: unknown;
  }) {
    const ownerDetail =
      params.ownerPid === undefined ? '' : ` (PID ${params.ownerPid})`;
    super(
      `Runtime process lock is unavailable${ownerDetail}: ${params.lockPath}`,
      params.cause === undefined ? undefined : { cause: params.cause },
    );
    this.name = 'RuntimeProcessLockBusyError';
    this.lockPath = params.lockPath;
    this.reason = params.reason;
    this.ownerPid = params.ownerPid;
  }
}

export interface RuntimeProcessLockOptions {
  /** PID written into the lock record. Defaults to the current process. */
  pid?: number;
  /**
   * How old an unreadable or structurally invalid lock must be before it may
   * be reclaimed. Defaults to 30 minutes.
   */
  malformedLockStaleAfterMs?: number;
  /** Test seam for deterministic timestamps. */
  now?: () => Date;
  /** Test seam for deterministic ownership tokens. */
  randomToken?: () => string;
  /** Test seam for process-liveness checks. */
  isProcessAlive?: (pid: number) => boolean;
}

export interface RuntimeProcessLock {
  readonly lockPath: string;
  readonly record: Readonly<RuntimeProcessLockRecord>;
  /**
   * Releases this lock once. The file is removed only if it still contains
   * this handle's unguessable ownership token.
   */
  release(): Promise<boolean>;
  /**
   * Synchronous exit-handler variant. Like `release`, it refuses to remove a
   * lock whose token no longer belongs to this handle.
   */
  releaseSync(): boolean;
}

interface LockSnapshot {
  raw: string | null;
  stats: Stats;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function parseLockRecord(raw: string | null): RuntimeProcessLockRecord | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Partial<RuntimeProcessLockRecord>;
    if (
      !Number.isInteger(candidate.pid) ||
      (candidate.pid as number) <= 0 ||
      typeof candidate.token !== 'string' ||
      !candidate.token.trim() ||
      typeof candidate.acquiredAt !== 'string' ||
      !Number.isFinite(Date.parse(candidate.acquiredAt))
    ) {
      return null;
    }
    return {
      pid: candidate.pid as number,
      token: candidate.token,
      acquiredAt: candidate.acquiredAt,
    };
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return false;
    // EPERM means the PID exists but this process cannot signal it.
    if (isErrno(error, 'EPERM')) return true;
    throw error;
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return (
    sameFileIdentity(left.stats, right.stats) &&
    left.stats.mode === right.stats.mode &&
    left.stats.size === right.stats.size &&
    left.stats.mtimeMs === right.stats.mtimeMs &&
    left.stats.ctimeMs === right.stats.ctimeMs &&
    left.raw === right.raw
  );
}

async function readStableSnapshot(
  lockPath: string,
): Promise<LockSnapshot | null> {
  let before: Stats;
  try {
    before = await lstat(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }

  let raw: string | null = null;
  if (before.isFile()) {
    try {
      raw = await readFile(lockPath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  let after: Stats;
  try {
    after = await lstat(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }

  const beforeSnapshot: LockSnapshot = { raw, stats: before };
  const afterSnapshot: LockSnapshot = { raw, stats: after };
  return sameSnapshot(beforeSnapshot, afterSnapshot) ? afterSnapshot : null;
}

function readStableSnapshotSync(lockPath: string): LockSnapshot | null {
  let before: Stats;
  try {
    before = lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }

  let raw: string | null = null;
  if (before.isFile()) {
    try {
      raw = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    }
  }

  let after: Stats;
  try {
    after = lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }

  const beforeSnapshot: LockSnapshot = { raw, stats: before };
  const afterSnapshot: LockSnapshot = { raw, stats: after };
  return sameSnapshot(beforeSnapshot, afterSnapshot) ? afterSnapshot : null;
}

async function unlinkSnapshotIfUnchanged(
  lockPath: string,
  expected: LockSnapshot,
): Promise<boolean> {
  const current = await readStableSnapshot(lockPath);
  if (!current || !sameSnapshot(expected, current)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

function unlinkSnapshotIfUnchangedSync(
  lockPath: string,
  expected: LockSnapshot,
): boolean {
  const current = readStableSnapshotSync(lockPath);
  if (!current || !sameSnapshot(expected, current)) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function unlinkIfTokenMatches(
  lockPath: string,
  expectedToken: string,
): Promise<boolean> {
  const snapshot = await readStableSnapshot(lockPath);
  const record = snapshot ? parseLockRecord(snapshot.raw) : null;
  if (!snapshot || record?.token !== expectedToken) return false;
  return unlinkSnapshotIfUnchanged(lockPath, snapshot);
}

function unlinkIfTokenMatchesSync(
  lockPath: string,
  expectedToken: string,
): boolean {
  const snapshot = readStableSnapshotSync(lockPath);
  const record = snapshot ? parseLockRecord(snapshot.raw) : null;
  if (!snapshot || record?.token !== expectedToken) return false;
  return unlinkSnapshotIfUnchangedSync(lockPath, snapshot);
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
    // Closing is best effort here because a create/write error is already in
    // flight and must remain the reported failure.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return;
  }
}

async function cleanupFailedCreate(
  lockPath: string,
  createdStats: Stats | null,
): Promise<void> {
  if (!createdStats) return;
  try {
    const current = await lstat(lockPath);
    if (!sameFileIdentity(createdStats, current)) return;
    await unlink(lockPath);
    // Cleanup cannot safely replace the original create/write error.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    return;
  }
}

async function createLockFile(
  lockPath: string,
  record: RuntimeProcessLockRecord,
): Promise<'created' | 'exists'> {
  let handle: FileHandle;
  try {
    // O_EXCL via `wx` is the lock's atomic ownership boundary.
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return 'exists';
    throw error;
  }

  let createdStats: Stats | null = null;
  try {
    createdStats = await handle.stat();
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    return 'created';
  } catch (error) {
    await closeQuietly(handle);
    await cleanupFailedCreate(lockPath, createdStats);
    throw error;
  }
}

function validateOptions(options: RuntimeProcessLockOptions): {
  pid: number;
  now: Date;
  token: string;
  malformedLockStaleAfterMs: number;
  isProcessAlive: (pid: number) => boolean;
} {
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError('Runtime process lock PID must be a positive integer.');
  }

  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('Runtime process lock timestamp must be valid.');
  }

  const token = options.randomToken?.() ?? randomUUID();
  if (!token.trim()) {
    throw new TypeError('Runtime process lock token must be non-empty.');
  }

  const malformedLockStaleAfterMs =
    options.malformedLockStaleAfterMs ??
    DEFAULT_MALFORMED_RUNTIME_LOCK_STALE_AFTER_MS;
  if (
    !Number.isFinite(malformedLockStaleAfterMs) ||
    malformedLockStaleAfterMs < 0
  ) {
    throw new TypeError(
      'Runtime process lock malformed-file timeout must be a non-negative finite number.',
    );
  }

  return {
    pid,
    now,
    token,
    malformedLockStaleAfterMs,
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
  };
}

/**
 * Acquires a host-local, single-process runtime lock.
 *
 * Valid records are governed by PID liveness: a live PID always blocks and a
 * dead PID is reclaimed. Malformed records fail closed until their filesystem
 * modification time passes the conservative stale timeout.
 */
export async function acquireRuntimeProcessLock(
  requestedLockPath: string,
  options: RuntimeProcessLockOptions = {},
): Promise<RuntimeProcessLock> {
  if (!requestedLockPath.trim()) {
    throw new TypeError('Runtime process lock path must be non-empty.');
  }

  const lockPath = resolve(requestedLockPath);
  const validated = validateOptions(options);
  const record: RuntimeProcessLockRecord = Object.freeze({
    pid: validated.pid,
    token: validated.token,
    acquiredAt: validated.now.toISOString(),
  });

  await mkdir(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if ((await createLockFile(lockPath, record)) === 'created') {
      let releasePromise: Promise<boolean> | null = null;
      let released = false;
      return Object.freeze({
        lockPath,
        record,
        release: () => {
          if (released) return Promise.resolve(true);
          releasePromise ??= unlinkIfTokenMatches(lockPath, record.token)
            .then((result) => {
              released = released || result;
              return released;
            })
            .finally(() => {
              releasePromise = null;
            });
          return releasePromise;
        },
        releaseSync: () => {
          if (released) return true;
          released = unlinkIfTokenMatchesSync(lockPath, record.token);
          return released;
        },
      });
    }

    const snapshot = await readStableSnapshot(lockPath);
    if (!snapshot) continue;

    const existingRecord = parseLockRecord(snapshot.raw);
    if (existingRecord) {
      let alive: boolean;
      try {
        alive = validated.isProcessAlive(existingRecord.pid);
      } catch (error) {
        throw new RuntimeProcessLockBusyError({
          lockPath,
          reason: 'process_status_unknown',
          ownerPid: existingRecord.pid,
          cause: error,
        });
      }

      if (alive) {
        throw new RuntimeProcessLockBusyError({
          lockPath,
          reason: 'live_process',
          ownerPid: existingRecord.pid,
        });
      }

      await unlinkSnapshotIfUnchanged(lockPath, snapshot);
      continue;
    }

    const malformedAgeMs = Math.max(
      0,
      validated.now.getTime() - snapshot.stats.mtimeMs,
    );
    if (malformedAgeMs < validated.malformedLockStaleAfterMs) {
      throw new RuntimeProcessLockBusyError({
        lockPath,
        reason: 'recent_malformed_lock',
      });
    }

    await unlinkSnapshotIfUnchanged(lockPath, snapshot);
  }

  throw new RuntimeProcessLockBusyError({
    lockPath,
    reason: 'acquisition_contended',
  });
}
