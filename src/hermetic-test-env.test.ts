import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  buildHermeticTestEnv,
  withTestNetworkGuard,
} from './hermetic-test-env.js';

describe('hermetic deterministic test environment', () => {
  it('suppresses provider env fallback and preloads the network guard once', () => {
    const first = buildHermeticTestEnv({ NODE_OPTIONS: '--trace-warnings' });
    const second = withTestNetworkGuard(first.NODE_OPTIONS);

    expect(first.ANDREA_TEST_DISABLE_PROVIDER_ENV_FILE).toBe('1');
    expect(first.NODE_OPTIONS).toContain('--trace-warnings');
    expect(first.NODE_OPTIONS).toContain('test-network-guard.mjs');
    expect(second.match(/test-network-guard\.mjs/g)).toHaveLength(1);
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
});
