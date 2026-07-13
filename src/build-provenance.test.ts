import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessBuildProvenance,
  BUILD_PROVENANCE_FILENAME,
  readBuildProvenance,
  writeBuildProvenance,
} from './build-provenance.js';

describe('build provenance', () => {
  let projectRoot = '';
  const cleanGitState = {
    branch: 'main',
    commit: 'a'.repeat(40),
    dirtyPathCount: 0,
  };

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build-proof-'));
    fs.mkdirSync(path.join(projectRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'dist/\n');
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'proof fixture\n');
    fs.writeFileSync(
      path.join(projectRoot, 'dist', 'index.js'),
      'export {};\n',
    );
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('verifies an unchanged artifact built from a clean commit', () => {
    const manifest = writeBuildProvenance({
      projectRoot,
      now: new Date('2026-07-12T10:00:00.000Z'),
      gitState: cleanGitState,
    });

    expect(readBuildProvenance(projectRoot)).toEqual(manifest);
    expect(
      assessBuildProvenance({
        projectRoot,
        expectedGitCommit: manifest.gitCommit,
      }),
    ).toMatchObject({ state: 'verified', artifactVerified: true });
  });

  it('rejects dirty-source, stale-commit, and changed-artifact claims', () => {
    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'dirty source\n');
    const dirty = writeBuildProvenance({
      projectRoot,
      gitState: { ...cleanGitState, dirtyPathCount: 1 },
    });
    expect(dirty.gitDirtyPathCount).toBe(1);
    expect(
      assessBuildProvenance({
        projectRoot,
        expectedGitCommit: dirty.gitCommit,
      }).state,
    ).toBe('dirty_source');

    fs.writeFileSync(path.join(projectRoot, 'README.md'), 'proof fixture\n');
    const clean = writeBuildProvenance({
      projectRoot,
      gitState: cleanGitState,
    });
    expect(
      assessBuildProvenance({
        projectRoot,
        expectedGitCommit: 'different-commit',
      }).state,
    ).toBe('commit_mismatch');

    fs.writeFileSync(
      path.join(projectRoot, 'dist', 'index.js'),
      'changed();\n',
    );
    expect(
      assessBuildProvenance({
        projectRoot,
        expectedGitCommit: clean.gitCommit,
      }).state,
    ).toBe('artifact_mismatch');
  });

  it('fails closed for missing and invalid manifests', () => {
    expect(assessBuildProvenance({ projectRoot }).state).toBe('missing');
    fs.writeFileSync(
      path.join(projectRoot, 'dist', BUILD_PROVENANCE_FILENAME),
      '{not-json',
    );
    expect(assessBuildProvenance({ projectRoot }).state).toBe('invalid');
  });
});
