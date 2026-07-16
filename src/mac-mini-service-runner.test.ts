import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('mac mini service runner', () => {
  it('execs the verified pinned Node binary so launchd owns the real service', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'mac-mini-service-runner.sh'),
      'utf8',
    );

    expect(script).toContain(
      'PINNED_NODE_PATH="$(node scripts/run-with-pinned-node.mjs --print-node-path)"',
    );
    expect(script).toContain('exec "$PINNED_NODE_PATH" dist/index.js');
    expect(script).toContain(
      'BUILD_PROVENANCE_PATH="$PROJECT_ROOT/dist/build-provenance.json"',
    );
    expect(script).toContain('git -C "$PROJECT_ROOT" rev-parse HEAD');
    expect(script).toContain('scripts/verify-build-manifest-id.mjs');
    expect(script).toContain('export ANDREA_BUILD_ID');
    expect(script).not.toContain(
      'exec node scripts/run-with-pinned-node.mjs dist/index.js',
    );
  });

  it('waits for a new boot and matching serving/build commit before reporting start success', () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'mac-mini-service.sh'),
      'utf8',
    );

    expect(script).toContain('wait_for_service_ready "$previous_boot_id"');
    expect(script).toContain('dist/mac-service-readiness.js');
    expect(script).toContain('ANDREA_MAC_READY_TIMEOUT_SECONDS');
    expect(script).toContain('git -C "$PROJECT_ROOT" rev-parse HEAD');
    expect(script).toContain('restart_previous_boot_id="$(current_boot_id)"');
    expect(script).toContain('start_service "$restart_previous_boot_id"');
  });

  it('rejects dirty and stale manifest identities before service exec', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'andrea-build-manifest-guard-'),
    );
    const manifestPath = path.join(root, 'build-provenance.json');
    const helperPath = path.join(
      process.cwd(),
      'scripts',
      'verify-build-manifest-id.mjs',
    );
    const commit = 'a'.repeat(40);
    const artifactSha256 = 'b'.repeat(64);
    const writeManifest = (overrides: Record<string, unknown> = {}) => {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          gitCommit: commit,
          gitDirtyPathCount: 0,
          artifactSha256,
          ...overrides,
        }),
      );
    };

    try {
      writeManifest();
      expect(
        execFileSync(process.execPath, [helperPath, manifestPath, commit], {
          encoding: 'utf8',
        }),
      ).toBe(`${commit}:${artifactSha256}`);

      writeManifest({ gitDirtyPathCount: 1 });
      expect(
        spawnSync(process.execPath, [helperPath, manifestPath, commit]).status,
      ).toBe(1);

      writeManifest({ gitCommit: 'c'.repeat(40) });
      expect(
        spawnSync(process.execPath, [helperPath, manifestPath, commit]).status,
      ).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects compiled main execution from its module path instead of cwd', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'index.ts'),
      'utf8',
    );

    expect(source).toContain('resolveRuntimeArtifactContext(');
    expect(source).toContain("'index.js'");
    expect(source).toContain('if (ACTIVE_RUNTIME_ARTIFACT.isCompiledArtifact)');
    expect(source).toContain('requireVerifiedRuntimeBuild({');
    expect(source).not.toContain('const ACTIVE_REPO_ROOT = process.cwd()');
  });
});
