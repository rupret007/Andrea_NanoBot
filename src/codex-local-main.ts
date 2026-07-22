import http from 'node:http';
import path from 'node:path';

import {
  CodexLocalJobService,
  createCodexLocalHttpServer,
  resolveCodexLocalServiceConfig,
} from './codex-local-service.js';
import { acquireRuntimeProcessLock } from './runtime-process-lock.js';

function argumentValue(prefix: string): string | null {
  const argument = process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function checkConfig(): void {
  const config = resolveCodexLocalServiceConfig();
  process.stdout.write(
    [
      'config=valid',
      `listener=${config.host}:${config.port}`,
      `allowed_repository_roots=${config.allowedRepositoryRoots.length}`,
      `group_repository_mappings=${Object.keys(config.repositoryByGroup).length}`,
      `default_repository=${config.defaultRepositoryRoot ? 'configured' : 'not_configured'}`,
      `max_concurrent_jobs=${config.maxConcurrentJobs}`,
      `job_timeout_ms=${config.jobTimeoutMs}`,
      `verification_commands=${config.verificationCommands.length}`,
      'auth_handling=host_in_place_not_copied',
    ].join('\n') + '\n',
  );
}

async function checkHealth(): Promise<void> {
  const config = resolveCodexLocalServiceConfig();
  const expectedPidRaw = argumentValue('--expected-pid=');
  const expectedPid = expectedPidRaw
    ? Number.parseInt(expectedPidRaw, 10)
    : null;
  const payload = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const request = http.get(
        {
          hostname: config.host === 'localhost' ? '127.0.0.1' : config.host,
          port: config.port,
          path: '/status',
          timeout: 5_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            if (response.statusCode !== 200) {
              reject(
                new Error(`health status ${response.statusCode || 'unknown'}`),
              );
              return;
            }
            try {
              resolve(
                JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
                  string,
                  unknown
                >,
              );
            } catch {
              reject(new Error('health response was not valid JSON'));
            }
          });
        },
      );
      request.on('timeout', () =>
        request.destroy(new Error('health request timed out')),
      );
      request.on('error', reject);
    },
  );
  const serviceIdentity = payload.serviceIdentity as
    | Record<string, unknown>
    | undefined;
  const pid =
    typeof serviceIdentity?.pid === 'number' ? serviceIdentity.pid : null;
  if (expectedPid !== null && pid !== expectedPid) {
    throw new Error(
      `health PID mismatch (expected ${expectedPid}, received ${pid ?? 'none'})`,
    );
  }
  if (payload.ready !== true) {
    throw new Error('service is reachable but Codex execution is not ready');
  }
  process.stdout.write(
    `health=ready pid=${pid ?? 'unknown'} version=${String(payload.version || 'unknown')}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--check-config')) {
    checkConfig();
    return;
  }
  if (process.argv.includes('--check-health')) {
    await checkHealth();
    return;
  }
  const config = resolveCodexLocalServiceConfig();
  const processLock = await acquireRuntimeProcessLock(
    path.join(config.stateDir, 'service.lock'),
  );
  process.once('exit', () => processLock.releaseSync());
  const service = new CodexLocalJobService(config);
  service.prepareStorage();
  if (process.argv.includes('--prepare-storage')) {
    process.stdout.write('storage=prepared_private\n');
    return;
  }
  const server = createCodexLocalHttpServer(service);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.stdout.write(
    `codex_local_service=started listener=${config.host}:${config.port} pid=${process.pid} version=${service.getStatus().meta.version}\n`,
  );
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`codex_local_service=stopping signal=${signal}\n`);
    const serverClosed = new Promise<void>((resolve) =>
      server.close(() => resolve()),
    );
    const forcedExit = setTimeout(() => process.exit(1), 10_000);
    forcedExit.unref();
    void Promise.all([serverClosed, service.shutdown()])
      .then(() => processLock.release())
      .then(() => {
        clearTimeout(forcedExit);
        process.exit(0);
      })
      .catch((error) => {
        process.stderr.write(
          `codex_local_service=shutdown_failed error=${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  process.stderr.write(
    `codex_local_service=fatal error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
