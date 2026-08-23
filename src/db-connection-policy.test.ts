import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _getDatabaseConnectionPolicy,
  _initTestDatabaseAtPath,
  isDatabaseInitialized,
} from './db.js';

let tempDir: string | null = null;

afterEach(() => {
  if (isDatabaseInitialized()) _closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('file database connection policy', () => {
  it('uses WAL with bounded retained capacity on a disposable database', () => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-db-connection-policy-'),
    );
    _initTestDatabaseAtPath(path.join(tempDir, 'messages.db'));

    expect(_getDatabaseConnectionPolicy()).toEqual({
      busyTimeoutMs: 15_000,
      journalMode: 'wal',
      synchronous: 1,
      walAutoCheckpointPages: 1_000,
      journalSizeLimitBytes: 64 * 1024 * 1024,
    });
  });

  it('checkpoints WAL on close so disposable file DBs can be deleted immediately', () => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-db-connection-close-'),
    );
    const databasePath = path.join(tempDir, 'messages.db');
    _initTestDatabaseAtPath(databasePath);
    expect(isDatabaseInitialized()).toBe(true);

    _closeDatabase();
    expect(isDatabaseInitialized()).toBe(false);
    _closeDatabase();

    expect(() =>
      fs.rmSync(tempDir, { recursive: true, force: true }),
    ).not.toThrow();
    expect(fs.existsSync(tempDir)).toBe(false);
    tempDir = null;
  });
});
