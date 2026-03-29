import { describe, expect, it } from 'vitest';

import {
  CONTAINER_CLOSE_GRACE_PERIOD_MS,
  resolveEffectiveIdleTimeout,
} from './runtime-timeout.js';

describe('resolveEffectiveIdleTimeout', () => {
  it('returns idle timeout when already below safe cutoff', () => {
    expect(resolveEffectiveIdleTimeout(300_000, 1_800_000)).toBe(300_000);
  });

  it('clamps idle timeout to preserve graceful close window', () => {
    expect(resolveEffectiveIdleTimeout(1_800_000, 1_800_000)).toBe(
      1_800_000 - CONTAINER_CLOSE_GRACE_PERIOD_MS,
    );
  });

  it('falls back to minimum timeout when idle timeout is invalid', () => {
    expect(resolveEffectiveIdleTimeout(0, 1_800_000)).toBe(1_000);
    expect(resolveEffectiveIdleTimeout(Number.NaN, 1_800_000)).toBe(1_000);
  });

  it('handles very small container timeouts safely', () => {
    expect(resolveEffectiveIdleTimeout(10_000, 20_000)).toBe(1_000);
  });
});
