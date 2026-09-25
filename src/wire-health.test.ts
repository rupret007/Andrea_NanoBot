import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildWireHealthSnapshot,
  checkWireFreshness,
  formatWireHealthStatus,
  type WireHealthSnapshot,
} from './wire-health.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-health-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePackageJson(version: string): void {
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ version }),
  );
}

function writeBuildProvenance(manifest: {
  gitCommit: string;
  gitBranch: string;
  gitDirtyPathCount: number;
  builtAt: string;
  artifactSha256: string;
  artifactFileCount: number;
}): void {
  const distDir = path.join(tmpDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'build-provenance.json'),
    JSON.stringify({
      version: 1,
      ...manifest,
    }),
  );
}

describe('buildWireHealthSnapshot', () => {
  it('returns unknown values when no provenance exists', () => {
    writePackageJson('1.2.42');
    const snapshot = buildWireHealthSnapshot(tmpDir);

    expect(snapshot.packageVersion).toBe('1.2.42');
    expect(snapshot.gitCommit).toBe('unknown');
    expect(snapshot.gitBranch).toBe('unknown');
    expect(snapshot.gitDirtyPathCount).toBeNull();
    expect(snapshot.buildAt).toBeNull();
    expect(snapshot.buildArtifactSha256).toBeNull();
    expect(snapshot.distMtime).toBeNull();
    expect(snapshot.snapshotAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads build provenance when present', () => {
    writePackageJson('1.2.42');
    writeBuildProvenance({
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 0,
      builtAt: '2026-08-23T12:00:00.000Z',
      artifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      artifactFileCount: 42,
    });

    const snapshot = buildWireHealthSnapshot(tmpDir);

    expect(snapshot.packageVersion).toBe('1.2.42');
    expect(snapshot.gitCommit).toBe('abc123def456abc123def456abc123def456abc1');
    expect(snapshot.gitBranch).toBe('main');
    expect(snapshot.gitDirtyPathCount).toBe(0);
    expect(snapshot.buildAt).toBe('2026-08-23T12:00:00.000Z');
    expect(snapshot.buildArtifactSha256).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    expect(snapshot.buildArtifactFileCount).toBe(42);
    expect(snapshot.distMtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports dirty path count from provenance', () => {
    writePackageJson('1.2.42');
    writeBuildProvenance({
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'feature-branch',
      gitDirtyPathCount: 3,
      builtAt: '2026-08-23T12:00:00.000Z',
      artifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      artifactFileCount: 42,
    });

    const snapshot = buildWireHealthSnapshot(tmpDir);

    expect(snapshot.gitDirtyPathCount).toBe(3);
    expect(snapshot.gitBranch).toBe('feature-branch');
  });
});

describe('formatWireHealthStatus', () => {
  it('formats snapshot as human-readable status', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 0,
      buildAt: '2026-08-23T12:00:00.000Z',
      buildArtifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      buildArtifactFileCount: 42,
      distMtime: '2026-08-23T12:00:05.000Z',
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const status = formatWireHealthStatus(snapshot);

    expect(status).toContain('*Wire Health*');
    expect(status).toContain('Package version: 1.2.42');
    expect(status).toContain(
      'Git commit: abc123def456abc123def456abc123def456abc1',
    );
    expect(status).toContain('Git branch: main');
    expect(status).toContain('Git dirty paths: 0');
    expect(status).toContain('Build time: 2026-08-23T12:00:00.000Z');
    expect(status).toContain('Artifact SHA256: deadbeefdeadbeef…');
    expect(status).toContain('Artifact file count: 42');
  });
});

describe('checkWireFreshness', () => {
  it('reports fresh when commit matches and build is clean', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 0,
      buildAt: '2026-08-23T12:00:00.000Z',
      buildArtifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      buildArtifactFileCount: 42,
      distMtime: '2026-08-23T12:00:05.000Z',
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const check = checkWireFreshness(
      snapshot,
      'abc123def456abc123def456abc123def456abc1',
    );

    expect(check.fresh).toBe(true);
    expect(check.commitMatch).toBe(true);
    expect(check.buildProvenancePresent).toBe(true);
    expect(check.buildClean).toBe(true);
    expect(check.reason).toContain('fresh and aligned');
  });

  it('reports stale when commit does not match expected', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 0,
      buildAt: '2026-08-23T12:00:00.000Z',
      buildArtifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      buildArtifactFileCount: 42,
      distMtime: '2026-08-23T12:00:05.000Z',
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const check = checkWireFreshness(
      snapshot,
      'different123def456abc123def456abc123def456',
    );

    expect(check.fresh).toBe(false);
    expect(check.commitMatch).toBe(false);
    expect(check.reason).toContain('does not match expected');
    expect(check.actualCommit).toBe('abc123def456abc123def456abc123def456abc1');
    expect(check.expectedCommit).toBe(
      'different123def456abc123def456abc123def456',
    );
  });

  it('reports stale when build was created with dirty paths', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 2,
      buildAt: '2026-08-23T12:00:00.000Z',
      buildArtifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      buildArtifactFileCount: 42,
      distMtime: '2026-08-23T12:00:05.000Z',
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const check = checkWireFreshness(snapshot);

    expect(check.fresh).toBe(false);
    expect(check.buildClean).toBe(false);
    expect(check.reason).toContain('2 uncommitted path(s)');
  });

  it('reports stale when build provenance is missing', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'unknown',
      gitBranch: 'unknown',
      gitDirtyPathCount: null,
      buildAt: null,
      buildArtifactSha256: null,
      buildArtifactFileCount: null,
      distMtime: null,
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const check = checkWireFreshness(snapshot);

    expect(check.fresh).toBe(false);
    expect(check.buildProvenancePresent).toBe(false);
    expect(check.reason).toContain('provenance missing');
  });

  it('is fresh without expected commit when provenance is clean', () => {
    const snapshot: WireHealthSnapshot = {
      packageVersion: '1.2.42',
      gitCommit: 'abc123def456abc123def456abc123def456abc1',
      gitBranch: 'main',
      gitDirtyPathCount: 0,
      buildAt: '2026-08-23T12:00:00.000Z',
      buildArtifactSha256:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      buildArtifactFileCount: 42,
      distMtime: '2026-08-23T12:00:05.000Z',
      snapshotAt: '2026-08-23T14:00:00.000Z',
    };

    const check = checkWireFreshness(snapshot);

    expect(check.fresh).toBe(true);
    expect(check.expectedCommit).toBeNull();
  });
});
