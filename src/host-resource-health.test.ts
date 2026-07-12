import { describe, expect, it } from 'vitest';

import {
  classifyHostDiskHealth,
  formatHostBytes,
  probeHostDiskHealth,
} from './host-resource-health.js';

const GiB = 1024 ** 3;

describe('host resource health', () => {
  it('classifies healthy, warning, and critical byte pressure', () => {
    expect(
      classifyHostDiskHealth({
        totalBytes: 200 * GiB,
        availableBytes: 40 * GiB,
      }).state,
    ).toBe('healthy');
    expect(
      classifyHostDiskHealth({
        totalBytes: 200 * GiB,
        availableBytes: 4 * GiB,
      }).state,
    ).toBe('warning');
    expect(
      classifyHostDiskHealth({
        totalBytes: 200 * GiB,
        availableBytes: 800 * 1024 ** 2,
      }).state,
    ).toBe('critical');
  });

  it('treats low percentage and inode exhaustion as critical', () => {
    expect(
      classifyHostDiskHealth({
        totalBytes: 2 * 1024 ** 4,
        availableBytes: 10 * GiB,
      }).state,
    ).toBe('critical');
    expect(
      classifyHostDiskHealth({
        totalBytes: 200 * GiB,
        availableBytes: 40 * GiB,
        totalInodes: 1_000_000,
        availableInodes: 5_000,
      }).state,
    ).toBe('critical');
  });

  it('never authorizes automatic cleanup', () => {
    const report = classifyHostDiskHealth({
      totalBytes: 200 * GiB,
      availableBytes: 500 * 1024 ** 2,
    });
    expect(report.automaticCleanupAllowed).toBe(false);
    expect(report.nextAction).toContain('do not delete Docker');
    expect(report.nextAction).toContain('owner-controlled');
  });

  it('probes injected filesystem statistics deterministically', () => {
    const report = probeHostDiskHealth({
      targetPath: '/synthetic',
      now: new Date('2026-07-12T04:00:00.000Z'),
      statfs: () => ({
        bsize: 4096n,
        blocks: 52_428_800n,
        bavail: 1_048_576n,
        files: 1_000_000n,
        ffree: 800_000n,
      }),
    });
    expect(report).toMatchObject({
      state: 'warning',
      checkedAt: '2026-07-12T04:00:00.000Z',
      availableBytes: 4 * GiB,
      probeErrorCode: null,
    });
  });

  it('fails closed to unknown without exposing error text or paths', () => {
    const report = probeHostDiskHealth({
      targetPath: '/private/user/path',
      statfs: () => {
        throw Object.assign(new Error('secret path detail'), {
          code: 'ENOENT',
        });
      },
    });
    expect(report).toMatchObject({
      state: 'unknown',
      probeErrorCode: 'ENOENT',
      automaticCleanupAllowed: false,
    });
    expect(JSON.stringify(report)).not.toContain('/private/user/path');
    expect(JSON.stringify(report)).not.toContain('secret path detail');
  });

  it('formats bounded human-readable byte values', () => {
    expect(formatHostBytes(742 * 1024 ** 2)).toBe('742 MiB');
    expect(formatHostBytes(null)).toBe('unknown');
  });
});
