/**
 * Step: container - Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execFileSync } from 'child_process';
import path from 'path';

import {
  ContainerRuntimeName,
  getContainerBuildCommand,
  getContainerRuntimeSpec,
  getContainerRuntimeStatus,
  getContainerSmokeTestCommand,
  isContainerRuntimeName,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { runtime?: ContainerRuntimeName } {
  let runtime: ContainerRuntimeName | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      const value = args[i + 1];
      if (!isContainerRuntimeName(value)) {
        throw new Error(`Unknown runtime: ${value}`);
      }
      runtime = value;
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime: requestedRuntime } = parseArgs(args);
  const runtime = requestedRuntime || resolveContainerRuntimeName();
  const runtimeSpec = getContainerRuntimeSpec(runtime);
  const image = 'nanoclaw-agent:latest';
  const runtimeStatus = getContainerRuntimeStatus(runtime);

  if (
    runtimeStatus === 'not_found' ||
    runtimeStatus === 'installed_not_running'
  ) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      RUNTIME_STATUS: runtimeStatus,
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  // Build
  let buildOk = false;
  logger.info({ runtime }, 'Building container');
  try {
    const buildCommand = getContainerBuildCommand(image, '.', runtimeSpec);
    execFileSync(buildCommand.command, buildCommand.args, {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Container build succeeded');
  } catch (err) {
    logger.error({ err }, 'Container build failed');
  }

  // Test
  let testOk = false;
  if (buildOk) {
    logger.info('Testing container');
    try {
      const smokeCommand = getContainerSmokeTestCommand(image, runtimeSpec);
      const output = execFileSync(smokeCommand.command, smokeCommand.args, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        input: '{}',
      });
      testOk = output.includes('Container OK');
      logger.info({ testOk }, 'Container test result');
    } catch {
      logger.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    RUNTIME_STATUS: runtimeStatus,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
