import { describe, expect, it } from 'vitest';

import {
  getContainerRuntimeHostAlias,
  getContainerRuntimeSpec,
  getDefaultContainerRuntimeCandidates,
  hostGatewayArgs,
  normalizeRuntimeArgs,
  readonlyMountArgs,
  writableMountArgs,
} from './container-runtime.js';

describe('getDefaultContainerRuntimeCandidates', () => {
  it('prefers podman first on Windows', () => {
    expect(getDefaultContainerRuntimeCandidates('win32')).toEqual([
      'podman',
      'docker',
    ]);
  });

  it('prefers verified runtimes before unverified Apple Container on macOS', () => {
    expect(getDefaultContainerRuntimeCandidates('darwin')).toEqual([
      'podman',
      'docker',
      'apple-container',
    ]);
  });

  it('prefers podman first on Linux', () => {
    expect(getDefaultContainerRuntimeCandidates('linux')).toEqual([
      'podman',
      'docker',
    ]);
  });
});

describe('hostGatewayArgs', () => {
  it('adds Docker host-gateway mapping on Linux', () => {
    expect(hostGatewayArgs(getContainerRuntimeSpec('docker'), 'linux')).toEqual(
      ['--add-host', 'host.docker.internal:host-gateway'],
    );
  });

  it('does not add host-gateway mapping for podman', () => {
    expect(hostGatewayArgs(getContainerRuntimeSpec('podman'), 'linux')).toEqual(
      [],
    );
  });
});

describe('getContainerRuntimeHostAlias', () => {
  it('uses host.containers.internal for podman', () => {
    expect(
      getContainerRuntimeHostAlias(getContainerRuntimeSpec('podman')),
    ).toBe('host.containers.internal');
  });
});

describe('normalizeRuntimeArgs', () => {
  it('converts legacy -v mounts to --mount for podman and docker', () => {
    expect(
      normalizeRuntimeArgs(
        ['run', '-v', 'C:\\Temp\\demo:/workspace/demo:ro', 'image:latest'],
        getContainerRuntimeSpec('podman'),
      ),
    ).toEqual([
      'run',
      '--mount',
      'type=bind,source=C:\\Temp\\demo,target=/workspace/demo,readonly',
      'image:latest',
    ]);
  });

  it('leaves apple-container args unchanged', () => {
    expect(
      normalizeRuntimeArgs(
        ['run', '-v', '/tmp/demo:/workspace/demo:ro', 'image:latest'],
        getContainerRuntimeSpec('apple-container'),
      ),
    ).toEqual(['run', '-v', '/tmp/demo:/workspace/demo:ro', 'image:latest']);
  });
});

describe('Docker-like bind mount arguments', () => {
  it('rejects comma-delimited source and target option injection', () => {
    const docker = getContainerRuntimeSpec('docker');
    expect(() =>
      writableMountArgs(
        '/allowed,source=/Users/owner/.codex',
        '/workspace/extra/safe',
        docker,
      ),
    ).toThrow(/Unsafe host bind-mount path/);
    expect(() =>
      readonlyMountArgs(
        '/allowed',
        '/workspace/extra/safe,source=/Users,target=/tmp/override',
        docker,
      ),
    ).toThrow(/Unsafe container bind-mount path/);
  });

  it('retains one exact source and target for a valid mount', () => {
    expect(
      readonlyMountArgs(
        '/Users/owner/My Project',
        '/workspace/extra/project_docs',
        getContainerRuntimeSpec('podman'),
      ),
    ).toEqual([
      '--mount',
      'type=bind,source=/Users/owner/My Project,target=/workspace/extra/project_docs,readonly',
    ]);
  });
});
