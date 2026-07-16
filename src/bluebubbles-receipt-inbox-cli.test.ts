import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareBlueBubblesReceiptInboxDatabasePath,
  resolveBlueBubblesReceiptInboxCliConfig,
} from './bluebubbles-receipt-inbox-cli.js';

const temporaryDirectories = new Set<string>();

function temporaryDirectory(label: string): string {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `andrea-receipt-cli-${label}-`),
  );
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

describe('BlueBubbles receipt inbox CLI config', () => {
  it('uses receipt-specific loopback defaults and the private Andrea state root', () => {
    const stateDirectory = path.join(temporaryDirectory('defaults'), 'state');
    const config = resolveBlueBubblesReceiptInboxCliConfig(
      {
        BLUEBUBBLES_WEBHOOK_SECRET: 'test-secret',
        ANDREA_STATE_DIR: stateDirectory,
        BLUEBUBBLES_HOST: '0.0.0.0',
        BLUEBUBBLES_PORT: '9999',
        BLUEBUBBLES_WEBHOOK_PATH: '/main-webhook',
      },
      {},
    );

    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 4306,
      webhookPath: '/bluebubbles/receipt-inbox',
      healthPath: '/health',
      databasePath: path.join(
        stateDirectory,
        'bluebubbles',
        'receipt-inbox.sqlite3',
      ),
    });
  });

  it.each(['0.0.0.0', '::', 'localhost', '192.168.1.20'])(
    'rejects the non-specific or non-loopback host %s',
    (host) => {
      expect(() =>
        resolveBlueBubblesReceiptInboxCliConfig(
          {
            BLUEBUBBLES_WEBHOOK_SECRET: 'test-secret',
            BLUEBUBBLES_RECEIPT_INBOX_HOST: host,
          },
          {},
        ),
      ).toThrow(/must be 127\.0\.0\.1 or ::1/i);
    },
  );

  it('accepts the explicit IPv6 loopback address', () => {
    expect(
      resolveBlueBubblesReceiptInboxCliConfig(
        {
          BLUEBUBBLES_WEBHOOK_SECRET: 'test-secret',
          BLUEBUBBLES_RECEIPT_INBOX_HOST: '::1',
        },
        {},
      ).host,
    ).toBe('::1');
  });

  it('creates a 0700 database parent and hardens SQLite files to 0600', () => {
    const root = temporaryDirectory('permissions');
    const databasePath = path.join(root, 'private', 'receipt-inbox.sqlite3');

    prepareBlueBubblesReceiptInboxDatabasePath(databasePath);
    expect(fs.statSync(path.dirname(databasePath)).mode & 0o777).toBe(0o700);

    fs.writeFileSync(databasePath, 'fixture', { mode: 0o644 });
    prepareBlueBubblesReceiptInboxDatabasePath(databasePath);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('refuses an existing permissive custom database parent', () => {
    const parent = path.join(temporaryDirectory('unsafe-parent'), 'shared');
    fs.mkdirSync(parent, { mode: 0o755 });
    fs.chmodSync(parent, 0o755);

    expect(() =>
      prepareBlueBubblesReceiptInboxDatabasePath(
        path.join(parent, 'receipt-inbox.sqlite3'),
      ),
    ).toThrow(/must have mode 0700/i);
  });
});
