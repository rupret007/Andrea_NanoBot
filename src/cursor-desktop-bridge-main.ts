import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  resolveCursorDesktopBridgeRuntimeConfig,
  startCursorDesktopBridge,
} from './cursor-desktop-bridge.js';
import { inspectCursorDesktopEntrypoints } from './cursor-desktop-entrypoints.js';

function argumentValue(prefix: string): string | null {
  const argument = process.argv
    .slice(2)
    .find((entry) => entry.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function validateConfig(): ReturnType<
  typeof resolveCursorDesktopBridgeRuntimeConfig
> {
  const config = resolveCursorDesktopBridgeRuntimeConfig();
  if (!config.token.trim()) {
    throw new Error('CURSOR_DESKTOP_BRIDGE_TOKEN is required.');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    throw new Error('CURSOR_DESKTOP_BRIDGE_HOST must be loopback-only.');
  }
  if (config.defaultCwd) {
    const root = path.resolve(config.defaultCwd);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error(
        'CURSOR_DESKTOP_DEFAULT_CWD must be an existing directory.',
      );
    }
  }
  return config;
}

function checkConfig(): void {
  const config = validateConfig();
  const entrypoints = inspectCursorDesktopEntrypoints();
  process.stdout.write(
    [
      'config=valid',
      `listener=${config.host}:${config.port}`,
      `token_configured=${Boolean(config.token)}`,
      `desktop_cli=${entrypoints.desktopCliPath ? 'detected' : 'not_detected'}`,
      `standalone_agent_cli=${entrypoints.agentCliPath ? 'detected_needs_proof' : 'not_detected'}`,
      `agent_execution=${config.agentExecutionAvailable ? 'candidate_needs_live_proof' : 'disabled'}`,
      `terminal_control=available_when_bridge_healthy`,
      `force_mode=${config.force ? 'enabled_by_operator' : 'disabled'}`,
    ].join('\n') + '\n',
  );
}

function prepareStorage(): void {
  const config = validateConfig();
  const directory = path.dirname(config.stateFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  process.stdout.write('storage=prepared_private\n');
}

async function checkHealth(): Promise<void> {
  const config = validateConfig();
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
          path: '/health',
          timeout: 5_000,
          headers: { authorization: `Bearer ${config.token}` },
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
  const pid = typeof payload.processId === 'number' ? payload.processId : null;
  if (expectedPid !== null && pid !== expectedPid) {
    throw new Error(
      `health PID mismatch (expected ${expectedPid}, received ${pid ?? 'none'})`,
    );
  }
  if (payload.ok !== true || payload.terminalAvailable !== true) {
    throw new Error(
      'bridge is reachable but terminal/session health is not ready',
    );
  }
  process.stdout.write(
    `health=ready pid=${pid ?? 'unknown'} agent_compatibility=${String(payload.agentJobCompatibility || 'unknown')}\n`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes('--check-config')) {
    checkConfig();
    return;
  }
  if (process.argv.includes('--prepare-storage')) {
    prepareStorage();
    return;
  }
  if (process.argv.includes('--check-health')) {
    await checkHealth();
    return;
  }
  validateConfig();
  prepareStorage();
  const server = startCursorDesktopBridge();
  const shutdown = (signal: string) => {
    process.stdout.write(`cursor_desktop_bridge=stopping signal=${signal}\n`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  process.stderr.write(
    `cursor_desktop_bridge=fatal error=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
