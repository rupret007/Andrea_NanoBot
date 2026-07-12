import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectMacServiceReadiness,
  waitForMacServiceReadiness,
} from './mac-service-readiness.js';

const roots: string[] = [];

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-ready-'));
  roots.push(value);
  fs.mkdirSync(path.join(value, 'data', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(value, 'data', 'run'), { recursive: true });
  return value;
}

function writeReadyState(
  projectRoot: string,
  commit: string,
  bootId = 'boot-new',
) {
  fs.writeFileSync(
    path.join(projectRoot, 'data', 'runtime', 'nanoclaw-ready.json'),
    JSON.stringify({ bootId, pid: 4242, readyAt: new Date().toISOString() }),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'data', 'runtime', 'assistant-health.json'),
    JSON.stringify({ bootId, pid: 4242, updatedAt: new Date().toISOString() }),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'data', 'runtime', 'runtime-audit.json'),
    JSON.stringify({
      activeGitCommit: commit,
      activeBuildGitCommit: commit,
      activeBuildProvenanceState: 'verified',
      activeBuildArtifactVerified: true,
      activeBuildGitDirtyPathCount: 0,
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, 'data', 'run', 'mac-mini-service.pid'),
    '4242\n',
  );
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe('mac service readiness', () => {
  it('requires one new live boot with matching runtime and build identity', () => {
    const projectRoot = root();
    writeReadyState(projectRoot, 'commit-new');

    expect(
      inspectMacServiceReadiness({
        projectRoot,
        previousBootId: 'boot-old',
        expectedCommit: 'commit-new',
        processExists: () => true,
      }),
    ).toMatchObject({
      ready: true,
      reasons: [],
      bootId: 'boot-new',
      pid: 4242,
      activeCommit: 'commit-new',
      buildCommit: 'commit-new',
    });
  });

  it('rejects stale boot markers and mismatched serving/build identity', () => {
    const projectRoot = root();
    writeReadyState(projectRoot, 'commit-old', 'boot-old');

    const result = inspectMacServiceReadiness({
      projectRoot,
      previousBootId: 'boot-old',
      expectedCommit: 'commit-new',
      processExists: () => true,
    });
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'new_boot_not_observed',
        'serving_commit_mismatch',
        'build_commit_mismatch',
      ]),
    );
  });

  it('waits for delayed authoritative readiness instead of accepting stale state', async () => {
    const projectRoot = root();
    writeReadyState(projectRoot, 'commit-old', 'boot-old');
    setTimeout(() => writeReadyState(projectRoot, 'commit-new'), 20);

    const result = await waitForMacServiceReadiness({
      projectRoot,
      previousBootId: 'boot-old',
      expectedCommit: 'commit-new',
      processExists: () => true,
      timeoutMs: 250,
      pollMs: 5,
    });
    expect(result.ready).toBe(true);
    expect(result.bootId).toBe('boot-new');
  });

  it('times out with bounded metadata-only diagnostics', async () => {
    const projectRoot = root();
    await expect(
      waitForMacServiceReadiness({
        projectRoot,
        previousBootId: 'boot-old',
        expectedCommit: 'commit-new',
        processExists: () => false,
        timeoutMs: 20,
        pollMs: 5,
      }),
    ).rejects.toThrow(/mac_service_readiness_timeout/);
  });
});
