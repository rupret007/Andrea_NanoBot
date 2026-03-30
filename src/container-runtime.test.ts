import { describe, expect, it } from 'vitest';

import {
  getContainerRuntimeHostAlias,
  getContainerRuntimeSpec,
  getDefaultContainerRuntimeCandidates,
  hostGatewayArgs,
  normalizeRuntimeArgs,
} from './container-runtime.js';

describe('getDefaultContainerRuntimeCandidates', () => {
  it('prefers podman first on Windows', () => {
    expect(getDefaultContainerRuntimeCandidates('win32')).toEqual([
      'podman',
      'docker',
    ]);
  });

  it('prefers podman first on macOS', () => {
    expect(getDefaultContainerRuntimeCandidates('darwin')).toEqual([
      'podman',
      'apple-container',
      'docker',
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
