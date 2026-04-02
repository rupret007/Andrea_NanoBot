import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const runtimeModulePath = '../scripts/run-with-pinned-node.mjs';

describe('run-with-pinned-node', () => {
  let previousCwd = '';
  let tempDir = '';

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pinned-node-'));
    fs.mkdirSync(path.join(tempDir, 'data', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.nvmrc'), '22.22.2\n');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads the exact pinned version from .nvmrc', async () => {
    const runtime = await import(runtimeModulePath);
    expect(runtime.readPinnedNodeVersion(tempDir)).toBe('22.22.2');
  });

  it('repairs missing runtime metadata by invoking the installer hook', async () => {
    const runtime = await import(runtimeModulePath);
    const calls: string[] = [];
    const result = await runtime.ensurePinnedNodeRuntime({
      projectRoot: tempDir,
      platform: 'win32',
      arch: 'x64',
      now: () => '2026-04-02T06:00:00.000Z',
      validateNodeBinary: () => true,
      downloadAndInstall: async (paths: {
        nodePath: string;
        installDir: string;
      }) => {
        calls.push(paths.nodePath);
        fs.mkdirSync(paths.installDir, { recursive: true });
        fs.writeFileSync(paths.nodePath, 'fake-node');
      },
    });

    expect(result.nodePath).toContain('node-v22.22.2-win-x64');
    expect(calls).toHaveLength(1);
    const metadata = runtime.readNodeRuntimeMetadata(result.metadataPath);
    expect(metadata).toMatchObject({
      version: '22.22.2',
      nodePath: result.nodePath,
      validatedAt: '2026-04-02T06:00:00.000Z',
    });
  });

  it('re-installs when metadata exists but the runtime validation fails', async () => {
    const runtime = await import(runtimeModulePath);
    const paths = runtime.resolvePinnedNodePaths({
      projectRoot: tempDir,
      version: '22.22.2',
      platform: 'win32',
      arch: 'x64',
    });
    fs.mkdirSync(paths.installDir, { recursive: true });
    fs.writeFileSync(paths.nodePath, 'stale-node');
    runtime.writeNodeRuntimeMetadata(paths.metadataPath, {
      version: '22.22.2',
      nodePath: paths.nodePath,
      platform: 'win32-x64',
      sourceUrl: paths.archiveUrl,
      validatedAt: '2026-04-01T00:00:00.000Z',
    });

    let installCount = 0;
    await runtime.ensurePinnedNodeRuntime({
      projectRoot: tempDir,
      platform: 'win32',
      arch: 'x64',
      validateNodeBinary: () => false,
      downloadAndInstall: async (installPaths: {
        installDir: string;
        nodePath: string;
      }) => {
        installCount += 1;
        fs.mkdirSync(installPaths.installDir, { recursive: true });
        fs.writeFileSync(installPaths.nodePath, 'fresh-node');
      },
    });

    expect(installCount).toBe(1);
  });
});
