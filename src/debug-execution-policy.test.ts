import { describe, expect, it } from 'vitest';

import { assertDebugExecutionPolicy } from './debug-execution-policy.js';

describe('debug execution policy', () => {
  it('accepts isolated synthetic writes', () => {
    expect(
      assertDebugExecutionPolicy({
        command: 'debug:missions',
        mode: 'isolated_write',
        storage: 'isolated',
        externalEffects: false,
      }).mode,
    ).toBe('isolated_write');
  });

  it('rejects a read-only command that can mutate live state', () => {
    expect(() =>
      assertDebugExecutionPolicy({
        command: 'unsafe-debug',
        mode: 'read_only',
        storage: 'live',
        externalEffects: false,
      }),
    ).toThrow('declares read_only');
  });
});
