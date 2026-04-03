import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  normalizePinnedNodeVersion,
  resolvePinnedNodePaths,
} from '../scripts/run-with-pinned-node.mjs';

describe('normalizePinnedNodeVersion', () => {
  it('accepts an exact pinned version', () => {
    expect(normalizePinnedNodeVersion('22.22.2')).toBe('22.22.2');
    expect(normalizePinnedNodeVersion('v22.22.2')).toBe('22.22.2');
  });

  it('rejects broad major-only versions', () => {
    expect(() => normalizePinnedNodeVersion('22')).toThrow(
      /must pin an exact Node version/i,
    );
  });
});

describe('resolvePinnedNodePaths', () => {
  it('uses a repo-local Windows runtime directory for the pinned node binary', () => {
    const paths = resolvePinnedNodePaths({
      projectRoot: 'C:\\NanoClaw',
      version: '22.22.2',
      platform: 'win32',
      arch: 'x64',
    });

    expect(paths.installDir).toBe(
      path.join('C:\\NanoClaw', 'data', 'runtime', 'node-v22.22.2-win-x64'),
    );
    expect(paths.nodePath).toBe(
      path.join(
        'C:\\NanoClaw',
        'data',
        'runtime',
        'node-v22.22.2-win-x64',
        'node.exe',
      ),
    );
    expect(paths.archiveUrl).toContain('/v22.22.2/node-v22.22.2-win-x64.zip');
  });
});
