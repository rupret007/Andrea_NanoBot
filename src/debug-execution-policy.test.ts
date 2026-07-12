import { describe, expect, it } from 'vitest';

import {
  assertDebugExecutionPolicy,
  resolveDebugExecutionPolicy,
  resolveDebugLiveExecutionPolicy,
} from './debug-execution-policy.js';

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

  it('keeps ordinary diagnostic modes read-only', () => {
    for (const args of [[], ['--shadow'], ['--workbench'], ['--json']]) {
      expect(resolveDebugExecutionPolicy(args).persist).toBe(false);
    }
  });

  it('requires an explicit persistence request', () => {
    expect(resolveDebugExecutionPolicy(['--persist'])).toEqual({
      persist: true,
      persistenceRequested: true,
      dryRun: false,
    });
  });

  it('lets every read-only override defeat persistence', () => {
    expect(
      resolveDebugExecutionPolicy(['--persist', '--dry-run']).persist,
    ).toBe(false);
    expect(
      resolveDebugExecutionPolicy(['--persist', '--no-persist']).persist,
    ).toBe(false);
  });

  it('requires an explicit live flag before external debug effects', () => {
    expect(resolveDebugLiveExecutionPolicy([], 'debug:research-mode')).toEqual({
      command: 'debug:research-mode',
      mode: 'read_only',
      storage: 'none',
      externalEffects: false,
    });
    expect(
      resolveDebugLiveExecutionPolicy(['--live'], 'debug:research-mode'),
    ).toEqual({
      command: 'debug:research-mode',
      mode: 'live_write',
      storage: 'live',
      externalEffects: true,
    });
  });
});
