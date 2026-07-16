import path from 'node:path';

import {
  prepareBlueBubblesReceiptInboxDatabasePath,
  resolveBlueBubblesReceiptInboxCliConfig,
  runBlueBubblesReceiptInboxCli,
} from './bluebubbles-receipt-inbox-cli.js';
import {
  readCurrentGitCommit,
  requireVerifiedRuntimeBuild,
  resolveRuntimeArtifactContext,
} from './build-provenance.js';
import {
  BLUEBUBBLES_RECEIPT_INBOX_PROTOCOL_VERSION,
  BLUEBUBBLES_RECEIPT_INBOX_SERVICE_KIND,
} from './bluebubbles-receipt-inbox-service.js';
import { buildBlueBubblesReceiptInboxConfigIdentity } from './bluebubbles-receipt-inbox-store.js';

const RECEIPT_INBOX_RUNTIME_ARTIFACT = resolveRuntimeArtifactContext(
  import.meta.url,
  'bluebubbles-receipt-inbox-main.js',
);

export function resolveReceiptInboxBuildId(): string {
  if (!RECEIPT_INBOX_RUNTIME_ARTIFACT.isCompiledArtifact) {
    return 'development-source';
  }
  const projectRoot = RECEIPT_INBOX_RUNTIME_ARTIFACT.projectRoot;
  return requireVerifiedRuntimeBuild({
    projectRoot,
    expectedGitCommit: readCurrentGitCommit(projectRoot),
    runnerBuildId: process.env.ANDREA_BUILD_ID,
    runtimeName: 'Compiled BlueBubbles receipt inbox',
  });
}

async function checkHealth(
  expectedBuildId: string,
  expectedPid?: number,
): Promise<void> {
  const config = resolveBlueBubblesReceiptInboxCliConfig();
  const expectedConfigIdentity = buildBlueBubblesReceiptInboxConfigIdentity({
    databasePath: config.databasePath,
    webhookPath: config.webhookPath,
  });
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  const healthUrl = `http://${host}:${config.port}${config.healthPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(healthUrl, {
      headers: { Authorization: `Bearer ${config.webhookSecret}` },
      signal: controller.signal,
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (
      !response.ok ||
      body.status !== 'ok' ||
      body.serviceKind !== BLUEBUBBLES_RECEIPT_INBOX_SERVICE_KIND ||
      body.protocolVersion !== BLUEBUBBLES_RECEIPT_INBOX_PROTOCOL_VERSION
    ) {
      throw new Error(`health endpoint returned HTTP ${response.status}`);
    }
    if (!Number.isInteger(body.pid) || Number(body.pid) < 1) {
      throw new Error('health endpoint returned an invalid process identity');
    }
    if (expectedPid !== undefined && body.pid !== expectedPid) {
      throw new Error(
        `health PID ${String(body.pid)} does not match launchd PID ${expectedPid}`,
      );
    }
    if (
      typeof body.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(body.startedAt))
    ) {
      throw new Error('health endpoint returned an invalid start time');
    }
    if (
      typeof body.buildId !== 'string' ||
      !body.buildId.trim() ||
      body.buildId.length > 512 ||
      body.buildId !== expectedBuildId
    ) {
      throw new Error(
        'health endpoint build identity does not match the current compiled artifact',
      );
    }
    if (
      body.webhookPath !== config.webhookPath ||
      body.configIdentity !== expectedConfigIdentity
    ) {
      throw new Error(
        'health endpoint queue configuration does not match the current receipt inbox configuration',
      );
    }
    process.stdout.write(
      `${JSON.stringify({
        status: 'healthy',
        serviceKind: body.serviceKind,
        protocolVersion: body.protocolVersion,
        pid: body.pid,
        startedAt: body.startedAt,
        buildId: body.buildId,
        webhookPath: body.webhookPath,
        configIdentity: body.configIdentity,
        healthUrl,
        schemaVersion: body.schemaVersion,
      })}\n`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function runBlueBubblesReceiptInboxMain(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  // Compiled production execution validates the exact clean build before
  // config reads, storage mutation, health checks, or listener startup.
  const buildId = resolveReceiptInboxBuildId();
  if (args.length === 1 && args[0] === '--check-config') {
    const config = resolveBlueBubblesReceiptInboxCliConfig();
    process.stdout.write(
      `${JSON.stringify({
        status: 'config-valid',
        host: config.host,
        port: config.port,
        webhookPath: config.webhookPath,
        healthPath: config.healthPath,
        databasePath: config.databasePath,
        buildId,
        webhookSecretConfigured: true,
      })}\n`,
    );
    return;
  }
  if (args.length === 1 && args[0] === '--prepare-storage') {
    process.umask(0o077);
    const config = resolveBlueBubblesReceiptInboxCliConfig();
    prepareBlueBubblesReceiptInboxDatabasePath(config.databasePath);
    process.stdout.write(
      `${JSON.stringify({
        status: 'storage-prepared',
        databasePath: config.databasePath,
      })}\n`,
    );
    return;
  }
  if (args[0] === '--check-health' && args.length >= 1 && args.length <= 2) {
    const expectedPidArgument = args[1];
    let expectedPid: number | undefined;
    if (expectedPidArgument !== undefined) {
      const match = expectedPidArgument.match(/^--expected-pid=(\d+)$/u);
      expectedPid = Number(match?.[1]);
      if (!match || !Number.isInteger(expectedPid) || expectedPid < 1) {
        throw new Error('--expected-pid must be a positive integer');
      }
    }
    await checkHealth(buildId, expectedPid);
    return;
  }
  if (args.length > 0) {
    throw new Error(
      'Usage: bluebubbles-receipt-inbox-main [--check-config|--prepare-storage|--check-health [--expected-pid=<pid>]]',
    );
  }

  process.umask(0o077);
  process.env.ANDREA_BUILD_ID = buildId;
  await runBlueBubblesReceiptInboxCli();
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === RECEIPT_INBOX_RUNTIME_ARTIFACT.modulePath;

if (isDirectExecution) {
  runBlueBubblesReceiptInboxMain().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unknown startup error';
    process.stderr.write(`BlueBubbles receipt inbox failed: ${message}\n`);
    process.exitCode = 1;
  });
}
