import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildHermeticTestEnv,
  withTestNetworkGuard,
} from './hermetic-test-env.js';

const originalDeterministicStorageMode =
  process.env.ANDREA_DETERMINISTIC_STORAGE_MODE;

describe('hermetic deterministic test environment', () => {
  afterEach(() => {
    if (originalDeterministicStorageMode === undefined) {
      delete process.env.ANDREA_DETERMINISTIC_STORAGE_MODE;
    } else {
      process.env.ANDREA_DETERMINISTIC_STORAGE_MODE =
        originalDeterministicStorageMode;
    }
    vi.resetModules();
  });

  it('suppresses provider env fallback, isolates storage, and preloads the network guard once', () => {
    const first = buildHermeticTestEnv({
      NODE_OPTIONS: '--trace-warnings',
      ANDREA_DETERMINISTIC_STORAGE_MODE: 'unsafe-inherited-value',
    });
    const second = withTestNetworkGuard(first.NODE_OPTIONS);

    expect(first.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE).toBe('1');
    expect(first.ANDREA_DETERMINISTIC_STORAGE_MODE).toBe('memory');
    expect(first.NODE_OPTIONS).toContain('--trace-warnings');
    expect(first.NODE_OPTIONS).toContain('test-network-guard.mjs');
    expect(second.match(/test-network-guard\.mjs/g)).toHaveLength(1);

    const liveStorage = buildHermeticTestEnv(first, {
      isolateStorage: false,
    });
    expect(liveStorage.ANDREA_DETERMINISTIC_STORAGE_MODE).toBeUndefined();
    expect(liveStorage.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE).toBe('1');
    expect(liveStorage.NODE_OPTIONS).toContain('test-network-guard.mjs');
  });

  it('denies a non-loopback request in a spawned deterministic process', () => {
    const output = execFileSync(
      process.execPath,
      [
        '-e',
        "fetch('https://example.com').then(() => process.exit(2)).catch((error) => process.stdout.write(error.message))",
      ],
      {
        encoding: 'utf8',
        env: buildHermeticTestEnv({ PATH: process.env.PATH }),
      },
    );

    expect(output).toContain(
      'External network access is disabled for deterministic tests',
    );
  });

  it('forces the production initializer into isolated memory and rejects unknown modes', async () => {
    process.env.ANDREA_DETERMINISTIC_STORAGE_MODE = 'memory';
    let database = await import('./db.js');
    database.initDatabase();
    expect(database.isIsolatedTestDatabase()).toBe(true);
    database._closeDatabase();

    vi.resetModules();
    process.env.ANDREA_DETERMINISTIC_STORAGE_MODE =
      'sk-example-invalid-storage-mode';
    database = await import('./db.js');
    let invalidModeError: unknown;
    try {
      database.initDatabase();
    } catch (error) {
      invalidModeError = error;
    }
    expect(invalidModeError).toEqual(
      new Error('Unsupported deterministic storage mode.'),
    );
    expect(String(invalidModeError)).not.toContain('sk-example');
    expect(database.isDatabaseInitialized()).toBe(false);
  });

  it('forbids production database initialization in TypeScript test entrypoints', () => {
    const scriptsDir = path.join(process.cwd(), 'scripts');
    const violations = fs
      .readdirSync(scriptsDir)
      .filter((name) => /^test-.*\.ts$/.test(name))
      .filter((name) =>
        /\binitDatabase\b/.test(
          fs.readFileSync(path.join(scriptsDir, name), 'utf8'),
        ),
      );

    expect(violations).toEqual([]);
  });
});
