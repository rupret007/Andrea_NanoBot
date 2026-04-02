/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../src/env.js';
import {
  buildWindowsCompatibilityShim,
  buildWindowsHostControlCommand,
  buildWindowsStartupFolderScript,
} from '../src/host-control.js';
import { logger } from '../src/logger.js';
import {
  getPlatform,
  getNodePath,
  getServiceManager,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const ephemeralNodePath = isEphemeralNodePath(nodePath);
  const channelAuthConfigured = hasConfiguredChannelAuth(projectRoot);

  logger.info(
    {
      platform,
      nodePath,
      projectRoot,
      ephemeralNodePath,
      channelAuthConfigured,
    },
    'Setting up service',
  );

  if (ephemeralNodePath && platform !== 'windows') {
    logger.error(
      { nodePath },
      'Refusing to install service with an ephemeral Node path',
    );
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'ephemeral_node_path',
      LOG: 'stdout/stderr (no dedicated setup.log file)',
    });
    process.exit(1);
  }
  if (ephemeralNodePath && platform === 'windows') {
    logger.warn(
      { nodePath },
      'Windows service setup will use the repo-pinned Node 22 launcher instead of the host node path',
    );
  }

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'stdout/stderr (no dedicated setup.log file)',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir);
  } else if (platform === 'windows') {
    setupWindowsTask(projectRoot, nodePath, channelAuthConfigured);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'stdout/stderr (no dedicated setup.log file)',
    });
    process.exit(1);
  }
}

function isEphemeralNodePath(nodePath: string): boolean {
  const normalized = nodePath.replace(/\\/g, '/').toLowerCase();
  return (
    normalized.includes('/.npm/_npx/') ||
    normalized.includes('/npm-cache/_npx/') ||
    normalized.includes('/appdata/local/npm-cache/_npx/')
  );
}

function getNodeMajorForBinary(nodePath: string): number | null {
  try {
    const output = execFileSync(nodePath, ['--version'], {
      encoding: 'utf-8',
    }).trim();
    const normalized = output.replace(/^v/i, '');
    const major = parseInt(normalized.split('.')[0], 10);
    return Number.isInteger(major) ? major : null;
  } catch {
    return null;
  }
}

function hasConfiguredChannelAuth(projectRoot: string): boolean {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);

  const telegram = process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN;
  const slackBot = process.env.SLACK_BOT_TOKEN || envVars.SLACK_BOT_TOKEN;
  const slackApp = process.env.SLACK_APP_TOKEN || envVars.SLACK_APP_TOKEN;
  const discord = process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN;
  const hasTokenChannel = Boolean(
    telegram || discord || (slackBot && slackApp),
  );

  const authDir = path.join(projectRoot, 'store', 'auth');
  const hasWhatsAppAuth =
    fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;

  return hasTokenChannel || hasWhatsAppAuth;
}

function readPidFromFile(pidFile: string): number | null {
  if (!fs.existsSync(pidFile)) return null;
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const pid = Number(raw);
    if (raw && Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  } catch {
    // pid file unreadable
  }
  return null;
}

function isWindowsNanoclawProcessRunning(
  pid: number,
  projectRoot: string,
): boolean {
  const rootLiteral = projectRoot.replace(/'/g, "''");
  const script = [
    `$root = '${rootLiteral}'`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 1 }',
    '$cmd = [string]$p.CommandLine',
    'if ($cmd -like "*$root*" -and $cmd -match \'dist[\\\\/]index\\.js\') { exit 0 }',
    'exit 2',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function waitForWindowsNanoclawStart(
  pidFile: string,
  projectRoot: string,
  attempts = 8,
  delayMs = 250,
): boolean {
  for (let i = 0; i < attempts; i++) {
    const pid = readPidFromFile(pidFile);
    if (pid && isWindowsNanoclawProcessRunning(pid, projectRoot)) {
      return true;
    }
    try {
      execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `Start-Sleep -Milliseconds ${delayMs}`],
        { stdio: 'ignore' },
      );
    } catch {
      // ignore sleep failures
    }
  }
  return false;
}

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  logger.info({ plistPath }, 'Wrote launchd plist');

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    logger.info('launchctl load succeeded');
  } catch {
    logger.warn('launchctl load failed (may already be loaded)');
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.nanoclaw');
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, nodePath, homeDir);
  }
}

function invokeWindowsHostControl(
  projectRoot: string,
  action: 'start' | 'stop' | 'restart' | 'status',
  installMode?: 'manual_host_control' | 'scheduled_task' | 'startup_folder',
): void {
  const hostScriptPath = path.join(projectRoot, 'scripts', 'nanoclaw-host.ps1');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    hostScriptPath,
    action,
  ];
  if (installMode) {
    args.push('-InstallMode', installMode);
  }
  execFileSync('powershell.exe', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function repairExistingWindowsStartupFallback(projectRoot: string): string | null {
  const appData = process.env.APPDATA;
  if (!appData) return null;

  const startupScriptPath = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    'nanoclaw-start.cmd',
  );
  if (!fs.existsSync(startupScriptPath)) return null;

  fs.writeFileSync(startupScriptPath, buildWindowsStartupFolderScript(projectRoot));
  logger.info(
    { startupScriptPath },
    'Repaired existing Windows startup-folder script to the canonical host launcher',
  );
  return startupScriptPath;
}

function setupWindowsTask(
  projectRoot: string,
  nodePath: string,
  channelAuthConfigured: boolean,
): void {
  const taskName = 'NanoClaw';
  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.ps1');
  fs.writeFileSync(
    wrapperPath,
    buildWindowsCompatibilityShim() + '\n',
  );
  logger.info({ wrapperPath }, 'Wrote Windows startup wrapper');
  repairExistingWindowsStartupFallback(projectRoot);

  const taskCommand = buildWindowsHostControlCommand(
    projectRoot,
    'start',
    'scheduled_task',
  );
  try {
    execFileSync(
      'schtasks.exe',
      ['/Create', '/F', '/SC', 'ONLOGON', '/TN', taskName, '/TR', taskCommand],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    );
    logger.info({ taskName }, 'Scheduled task created');
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    if (/access is denied/i.test(errMessage)) {
      logger.warn(
        { taskName },
        'Scheduled task creation denied by OS policy, trying startup-folder fallback',
      );
    } else {
      logger.warn(
        { err, taskName },
        'Scheduled task creation failed, trying startup-folder fallback',
      );
    }
    const fallback = setupWindowsStartupFallback(
      projectRoot,
      channelAuthConfigured,
    );
    if (!fallback.ok) {
      logger.error({ taskName }, 'Windows startup fallback also failed');
      emitStatus('SETUP_SERVICE', {
        SERVICE_TYPE: 'windows-task',
        NODE_PATH: nodePath,
        PROJECT_PATH: projectRoot,
        TASK_NAME: taskName,
        WRAPPER_PATH: wrapperPath,
        SERVICE_LOADED: false,
        STATUS: 'failed',
        ERROR: 'task_create_failed',
        LOG: 'stdout/stderr (no dedicated setup.log file)',
      });
      process.exit(1);
    }

    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'windows-startup',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      WRAPPER_PATH: wrapperPath,
      STARTUP_SCRIPT_PATH: fallback.startupScriptPath,
      SERVICE_LOADED: fallback.initialRunOk,
      INITIAL_RUN_OK: fallback.initialRunOk,
      INITIAL_RUN_SKIPPED: fallback.initialRunSkipped,
      FALLBACK: 'startup_folder',
      NODE_LAUNCHER: 'pinned-node22',
      STATUS: 'success',
      LOG: 'stdout/stderr (no dedicated setup.log file)',
    });
    return;
  }

  let taskRegistered = false;
  try {
    execFileSync('schtasks.exe', ['/Query', '/TN', taskName], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    });
    taskRegistered = true;
  } catch {
    // Query failed
  }

  const initialRunSkipped = !channelAuthConfigured;
  let initialRunOk = false;
  if (!initialRunSkipped) {
    try {
      invokeWindowsHostControl(projectRoot, 'start', 'scheduled_task');
      initialRunOk = true;
    } catch (err) {
      logger.warn({ err, taskName }, 'Task created but initial run failed');
    }
  } else {
    logger.info(
      { taskName },
      'Skipping initial Windows task run because no channel credentials are configured yet',
    );
  }

  const serviceLoaded = taskRegistered && initialRunOk;

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'windows-task',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    TASK_NAME: taskName,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: serviceLoaded,
    TASK_REGISTERED: taskRegistered,
    INITIAL_RUN_OK: initialRunOk,
    INITIAL_RUN_SKIPPED: initialRunSkipped,
    NODE_LAUNCHER: 'pinned-node22',
    STATUS: 'success',
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });
}

function setupWindowsStartupFallback(
  projectRoot: string,
  runInitial: boolean,
): {
  ok: boolean;
  startupScriptPath: string;
  initialRunOk: boolean;
  initialRunSkipped: boolean;
} {
  const appData = process.env.APPDATA;
  if (!appData) {
    return {
      ok: false,
      startupScriptPath: '',
      initialRunOk: false,
      initialRunSkipped: false,
    };
  }

  const startupDir = path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  fs.mkdirSync(startupDir, { recursive: true });
  const startupScriptPath = path.join(startupDir, 'nanoclaw-start.cmd');

  fs.writeFileSync(startupScriptPath, buildWindowsStartupFolderScript(projectRoot));
  logger.info({ startupScriptPath }, 'Wrote startup-folder fallback script');

  const initialRunSkipped = !runInitial;
  let initialRunOk = false;
  if (!initialRunSkipped) {
    try {
      invokeWindowsHostControl(projectRoot, 'start', 'startup_folder');
      initialRunOk = true;
    } catch (err) {
      logger.warn(
        { err },
        'Startup fallback configured, but initial run failed',
      );
    }
  } else {
    logger.info(
      'Skipping initial startup-folder run because no channel credentials are configured yet',
    );
  }

  return { ok: true, startupScriptPath, initialRunOk, initialRunSkipped };
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned nanoclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  const runningAsRoot = isRoot();

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/nanoclaw.service';
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, homeDir);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'nanoclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  logger.info({ unitPath }, 'Wrote systemd unit');

  // Detect stale docker group before starting (user systemd only)
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable lingering so the user service survives SSH logout.
  // Without linger, systemd terminates all user processes when the last session closes.
  if (!runningAsRoot) {
    try {
      execSync('loginctl enable-linger', { stdio: 'ignore' });
      logger.info('Enabled loginctl linger for current user');
    } catch (err) {
      logger.warn(
        { err },
        'loginctl enable-linger failed — service may stop on SSH logout',
      );
    }
  }

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  try {
    execSync(`${systemctlPrefix} start nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl start failed');
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    LINGER_ENABLED: !runningAsRoot,
    STATUS: 'success',
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');

  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh — Start NanoClaw without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting NanoClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/nanoclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "NanoClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/nanoclaw.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });
}
