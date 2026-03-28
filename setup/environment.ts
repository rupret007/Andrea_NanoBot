/**
 * Step: environment — Detect OS, Node, container runtimes, existing config.
 * Replaces 01-check-environment.sh
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
import {
  getContainerRuntimeStatus,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { logger } from '../src/logger.js';
import {
  getNodeMajorVersion,
  getNodeVersion,
  getPlatform,
  isHeadless,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();

  logger.info('Starting environment check');

  const platform = getPlatform();
  const wsl = isWSL();
  const headless = isHeadless();
  const nodeVersion = getNodeVersion() || process.version.replace(/^v/, '');
  const nodeMajor = getNodeMajorVersion();
  const nodeOk = nodeMajor === 22;

  const appleContainer = getContainerRuntimeStatus('apple-container');
  const docker = getContainerRuntimeStatus('docker');
  const podman = getContainerRuntimeStatus('podman');
  const resolvedRuntime = resolveContainerRuntimeName();

  // Check existing config
  const hasEnv = fs.existsSync(path.join(projectRoot, '.env'));

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

  logger.info(
    {
      platform,
      wsl,
      nodeVersion,
      nodeMajor,
      nodeOk,
      appleContainer,
      docker,
      podman,
      resolvedRuntime,
      hasEnv,
      hasAuth,
      hasRegisteredGroups,
    },
    'Environment check complete',
  );

  emitStatus('CHECK_ENVIRONMENT', {
    PLATFORM: platform,
    IS_WSL: wsl,
    IS_HEADLESS: headless,
    NODE_VERSION: nodeVersion,
    NODE_MAJOR: nodeMajor ?? 'unknown',
    NODE_OK: nodeOk,
    APPLE_CONTAINER: appleContainer,
    DOCKER: docker,
    PODMAN: podman,
    CONTAINER_RUNTIME_RESOLVED: resolvedRuntime,
    HAS_ENV: hasEnv,
    HAS_AUTH: hasAuth,
    HAS_REGISTERED_GROUPS: hasRegisteredGroups,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
