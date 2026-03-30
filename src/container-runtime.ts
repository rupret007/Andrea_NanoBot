/**
 * Container runtime abstraction for Andrea.
 * Runtime-specific CLI behavior lives here so local execution stays provider-neutral.
 */
import { execFileSync } from 'child_process';
import os from 'os';

import { CONTAINER_RUNTIME as CONFIGURED_CONTAINER_RUNTIME } from './config.js';
import { logger } from './logger.js';

export type ContainerRuntimeName = 'podman' | 'docker' | 'apple-container';
export type ContainerRuntimeStatus =
  | 'running'
  | 'installed'
  | 'installed_not_running'
  | 'not_found';

export interface ContainerRuntimeSpec {
  name: ContainerRuntimeName;
  command: string;
  hostAlias: string;
  supportsInfoProbe: boolean;
  supportsOrphanCleanup: boolean;
}

const RUNTIME_SPECS: Record<ContainerRuntimeName, ContainerRuntimeSpec> = {
  podman: {
    name: 'podman',
    command: 'podman',
    hostAlias: 'host.containers.internal',
    supportsInfoProbe: true,
    supportsOrphanCleanup: true,
  },
  docker: {
    name: 'docker',
    command: 'docker',
    hostAlias: 'host.docker.internal',
    supportsInfoProbe: true,
    supportsOrphanCleanup: true,
  },
  'apple-container': {
    name: 'apple-container',
    command: 'container',
    hostAlias: 'host.docker.internal',
    supportsInfoProbe: false,
    supportsOrphanCleanup: false,
  },
};

const ALL_CONTAINER_RUNTIMES: ContainerRuntimeName[] = [
  'podman',
  'docker',
  'apple-container',
];

export function isContainerRuntimeName(
  value: string,
): value is ContainerRuntimeName {
  return ALL_CONTAINER_RUNTIMES.includes(value as ContainerRuntimeName);
}

function commandExists(command: string): boolean {
  const lookupCommand = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    execFileSync(lookupCommand, [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function execRuntime(
  runtime: ContainerRuntimeSpec,
  args: string[],
  options: Parameters<typeof execFileSync>[2] = {},
): string {
  const output = execFileSync(runtime.command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...options,
  });
  if (typeof output === 'string') return output;
  if (Buffer.isBuffer(output)) return output.toString('utf-8');
  return '';
}

function parseVolumeSpec(spec: string): {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
} | null {
  const match = spec.match(/^(.*):(\/[^:]*)(?::(ro|rw))?$/);
  if (!match) return null;

  const [, hostPath, containerPath, mode] = match;
  return {
    hostPath,
    containerPath,
    readonly: mode === 'ro',
  };
}

function formatDockerLikeMount(
  hostPath: string,
  containerPath: string,
  readonly: boolean,
): string {
  return `type=bind,source=${hostPath},target=${containerPath}${readonly ? ',readonly' : ''}`;
}

export function getDefaultContainerRuntimeCandidates(
  platform = process.platform,
): ContainerRuntimeName[] {
  if (platform === 'win32') return ['podman', 'docker'];
  if (platform === 'darwin') return ['podman', 'apple-container', 'docker'];
  if (platform === 'linux') return ['podman', 'docker'];
  return ['podman', 'docker', 'apple-container'];
}

export function getAvailableContainerRuntimes(): ContainerRuntimeName[] {
  return ALL_CONTAINER_RUNTIMES.filter((runtime) =>
    commandExists(RUNTIME_SPECS[runtime].command),
  );
}

export function getContainerRuntimeSpec(
  runtime: ContainerRuntimeName,
): ContainerRuntimeSpec {
  return RUNTIME_SPECS[runtime];
}

export function resolveContainerRuntimeName(
  configured = CONFIGURED_CONTAINER_RUNTIME,
  platform = process.platform,
): ContainerRuntimeName {
  if (configured) return configured;

  const defaults = getDefaultContainerRuntimeCandidates(platform);
  for (const runtime of defaults) {
    if (commandExists(RUNTIME_SPECS[runtime].command)) {
      return runtime;
    }
  }

  return defaults[0] || 'docker';
}

export function getResolvedContainerRuntime(): ContainerRuntimeSpec {
  return getContainerRuntimeSpec(resolveContainerRuntimeName());
}

export function getContainerRuntimeStatus(
  runtime: ContainerRuntimeName,
): ContainerRuntimeStatus {
  const spec = getContainerRuntimeSpec(runtime);
  if (!commandExists(spec.command)) return 'not_found';

  if (!spec.supportsInfoProbe) {
    return 'installed';
  }

  try {
    execRuntime(spec, ['info'], { timeout: 10000, stdio: 'ignore' });
    return 'running';
  } catch {
    return 'installed_not_running';
  }
}

export function getContainerRuntimeHostAlias(
  runtime = getResolvedContainerRuntime(),
): string {
  return runtime.hostAlias;
}

export function getContainerBuildCommand(
  image: string,
  contextDir = '.',
  runtime = getResolvedContainerRuntime(),
): { command: string; args: string[] } {
  return {
    command: runtime.command,
    args: ['build', '-t', image, contextDir],
  };
}

export function getContainerSmokeTestCommand(
  image: string,
  runtime = getResolvedContainerRuntime(),
): { command: string; args: string[] } {
  return {
    command: runtime.command,
    args: [
      'run',
      '-i',
      '--rm',
      '--entrypoint',
      '/bin/echo',
      image,
      'Container OK',
    ],
  };
}

export function hostGatewayArgs(
  runtime = getResolvedContainerRuntime(),
  platform = os.platform(),
): string[] {
  if (runtime.name === 'docker' && platform === 'linux') {
    return ['--add-host', 'host.docker.internal:host-gateway'];
  }
  return [];
}

export function writableMountArgs(
  hostPath: string,
  containerPath: string,
  runtime = getResolvedContainerRuntime(),
): string[] {
  if (runtime.name === 'apple-container') {
    return ['-v', `${hostPath}:${containerPath}`];
  }
  return ['--mount', formatDockerLikeMount(hostPath, containerPath, false)];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
  runtime = getResolvedContainerRuntime(),
): string[] {
  if (runtime.name === 'apple-container') {
    return ['-v', `${hostPath}:${containerPath}:ro`];
  }
  return ['--mount', formatDockerLikeMount(hostPath, containerPath, true)];
}

export function normalizeRuntimeArgs(
  args: string[],
  runtime = getResolvedContainerRuntime(),
): string[] {
  if (runtime.name === 'apple-container') return [...args];

  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-v' && args[i + 1]) {
      const parsed = parseVolumeSpec(args[i + 1]);
      if (parsed) {
        normalized.push(
          ...(parsed.readonly
            ? readonlyMountArgs(parsed.hostPath, parsed.containerPath, runtime)
            : writableMountArgs(
                parsed.hostPath,
                parsed.containerPath,
                runtime,
              )),
        );
      } else {
        normalized.push(arg, args[i + 1]);
      }
      i++;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function printRuntimeStartupHelp(runtime: ContainerRuntimeSpec): void {
  console.error('\nFATAL: Container runtime failed to start.\n');
  console.error(`Selected runtime: ${runtime.name}`);

  if (runtime.name === 'podman') {
    console.error(
      '1. Ensure Podman is installed and the Podman machine is running.',
    );
    console.error('2. Run: podman info');
    console.error('3. Restart Andrea_OpenAI_Bot');
    return;
  }

  if (runtime.name === 'docker') {
    console.error('1. Ensure Docker is installed and running.');
    console.error('2. Run: docker info');
    console.error('3. Restart Andrea_OpenAI_Bot');
    return;
  }

  console.error(
    '1. Ensure Apple Container is installed and available as `container`.',
  );
  console.error('2. Run: container --help');
  console.error('3. Restart Andrea_OpenAI_Bot');
}

export const CONTAINER_RUNTIME_NAME = resolveContainerRuntimeName();
/** The selected container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = getContainerRuntimeSpec(
  CONTAINER_RUNTIME_NAME,
).command;

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  const runtime = getResolvedContainerRuntime();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execRuntime(runtime, ['stop', '-t', '1', name]);
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  const runtime = getResolvedContainerRuntime();

  if (!commandExists(runtime.command)) {
    printRuntimeStartupHelp(runtime);
    throw new Error(`Container runtime "${runtime.name}" is not installed`);
  }

  if (!runtime.supportsInfoProbe) {
    logger.debug({ runtime: runtime.name }, 'Container runtime available');
    return;
  }

  try {
    execRuntime(runtime, ['info'], {
      timeout: 10000,
      stdio: 'ignore',
    });
    logger.debug(
      { runtime: runtime.name },
      'Container runtime already running',
    );
  } catch (err) {
    logger.error(
      { err, runtime: runtime.name },
      'Failed to reach container runtime',
    );
    printRuntimeStartupHelp(runtime);
    throw new Error(
      `Container runtime "${runtime.name}" is required but failed to start`,
      {
        cause: err,
      },
    );
  }
}

/** Kill orphaned Andrea runtime containers from previous runs. */
export function cleanupOrphans(): void {
  const runtime = getResolvedContainerRuntime();
  if (!runtime.supportsOrphanCleanup) return;

  try {
    const output = execRuntime(runtime, [
      'ps',
      '--filter',
      'name=andrea-runtime-',
      '--format',
      '{{.Names}}',
    ]);
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { runtime: runtime.name, count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn(
      { err, runtime: runtime.name },
      'Failed to clean up orphaned containers',
    );
  }
}
