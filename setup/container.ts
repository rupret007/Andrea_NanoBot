/**
 * Step: container â€” Build the agent image and run a smoke test.
 */
import { execFileSync } from 'child_process';
import path from 'path';

import {
  getContainerBuildCommand,
  getContainerRuntimeSpec,
  getContainerRuntimeStatus,
  getContainerSmokeTestCommand,
  isContainerRuntimeName,
} from '../src/container-runtime.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { runtime: string } {
  let runtime = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = 'andrea-openai-agent:latest';

  if (!runtime || !isContainerRuntimeName(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime || 'unknown',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const runtimeStatus = getContainerRuntimeStatus(runtime);
  if (runtimeStatus === 'not_found' || runtimeStatus === 'installed_not_running') {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  const runtimeSpec = getContainerRuntimeSpec(runtime);
  const build = getContainerBuildCommand(image, '.', runtimeSpec);
  const smoke = getContainerSmokeTestCommand(image, runtimeSpec);

  let buildOk = false;
  logger.info({ runtime }, 'Building Andrea runtime container image');
  try {
    execFileSync(build.command, build.args, {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    buildOk = true;
    logger.info({ runtime }, 'Container image build succeeded');
  } catch (err) {
    logger.error({ err, runtime }, 'Container image build failed');
  }

  let testOk = false;
  if (buildOk) {
    logger.info({ runtime }, 'Running container smoke test');
    try {
      const output = execFileSync(smoke.command, smoke.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      testOk = output.includes('Container OK');
      logger.info({ runtime, testOk }, 'Container smoke test finished');
    } catch (err) {
      logger.error({ err, runtime }, 'Container smoke test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';
  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
