/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  getContainerRuntimeStatus,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { hasHostCodexAuthMaterial } from '../src/codex-home.js';
import { STORE_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';
import { logger } from '../src/logger.js';
import { getPlatform, isHeadless, isWSL } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const preferredRuntime = resolveContainerRuntimeName();
  const podman = getContainerRuntimeStatus('podman');
  const appleContainer = getContainerRuntimeStatus('apple-container');
  const docker = getContainerRuntimeStatus('docker');

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));
  const envFileVars = readEnvFile(['OPENAI_API_KEY', 'OPENAI_BASE_URL']);

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasAuth = fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  let hasRegisteredGroups = false;
  // Check JSON file first (pre-migration)
  if (fs.existsSync(path.join(projectRoot, 'data', 'registered_groups.json'))) {
    hasRegisteredGroups = true;
  } else {
    // Check SQLite directly using better-sqlite3 (no sqlite3 CLI needed)
    const dbPath = path.join(STORE_DIR, 'messages.db');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const row = db
          .prepare('SELECT COUNT(*) as count FROM registered_groups')
          .get() as { count: number };
        if (row.count > 0) hasRegisteredGroups = true;
        db.close();
      } catch {
        // Table might not exist yet
      }
    }
  }

  const hasHostCodexAuth = hasHostCodexAuthMaterial();
  const hasOpenAiCloudCredentials = Boolean(
    process.env.OPENAI_API_KEY || envFileVars.OPENAI_API_KEY,
  );
  const hasCodexLocalCredentials = hasOpenAiCloudCredentials || hasHostCodexAuth;

  logger.info(
    {
      platform,
      wsl,
      preferredRuntime,
      podman,
      appleContainer,
      docker,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
      hasHostCodexAuth,
      hasOpenAiCloudCredentials,
      hasCodexLocalCredentials,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    PREFERRED_CONTAINER_RUNTIME: preferredRuntime,
    PODMAN: podman,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    HAS_HOST_CODEX_AUTH: hasHostCodexAuth,
    HAS_OPENAI_CLOUD_CREDENTIALS: hasOpenAiCloudCredentials,
    HAS_CODEX_LOCAL_CREDENTIALS: hasCodexLocalCredentials,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
