import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export type NanoclawInstallMode =
  | 'manual_host_control'
  | 'scheduled_task'
  | 'startup_folder';

export type NanoclawHostPhase =
  | 'starting'
  | 'running_ready'
  | 'stopped'
  | 'launcher_failed'
  | 'config_failed';

export type NanoclawDependencyState = 'ok' | 'degraded' | 'unknown';

export type WindowsHostServiceState =
  | 'running_ready'
  | 'starting'
  | 'stopped'
  | 'launcher_failed'
  | 'config_failed'
  | 'process_stale';

export interface NodeRuntimeMetadata {
  version: string;
  nodePath: string;
  platform: string;
  sourceUrl: string;
  validatedAt: string;
}

export interface NanoclawHostState {
  bootId: string;
  phase: NanoclawHostPhase;
  pid: number | null;
  installMode: NanoclawInstallMode;
  nodePath: string;
  nodeVersion: string;
  startedAt: string;
  readyAt: string | null;
  lastError: string;
  dependencyState: NanoclawDependencyState;
  dependencyError: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  hostLogPath: string;
}

export interface NanoclawReadyState {
  bootId: string;
  pid: number;
  readyAt: string;
  appVersion: string;
}

export interface HostControlPaths {
  projectRoot: string;
  logsDir: string;
  runtimeStateDir: string;
  pidFilePath: string;
  hostLogPath: string;
  assistantLogPath: string;
  assistantErrorLogPath: string;
  hostStatePath: string;
  readyStatePath: string;
  hostLockPath: string;
  nodeRuntimeMetadataPath: string;
  startupFolderScriptPath: string | null;
}

export interface HostControlSnapshot {
  paths: HostControlPaths;
  nodeRuntime: NodeRuntimeMetadata | null;
  hostState: NanoclawHostState | null;
  readyState: NanoclawReadyState | null;
}

export interface WindowsInstallArtifacts {
  hasScheduledTask: boolean;
  hasStartupFolder: boolean;
  startupFolderScriptPath: string | null;
  startupFolderScriptIsLegacy: boolean;
}

export interface WindowsHostReconciliation {
  snapshot: HostControlSnapshot;
  runtimePid: number | null;
  processRunning: boolean;
  readyMatchesHost: boolean;
  serviceState: WindowsHostServiceState;
  activeLaunchMode: NanoclawInstallMode | null;
  launcherError: string;
  dependencyState: NanoclawDependencyState;
  dependencyError: string;
}

const HOST_PHASES = new Set<NanoclawHostPhase>([
  'starting',
  'running_ready',
  'stopped',
  'launcher_failed',
  'config_failed',
]);
const INSTALL_MODES = new Set<NanoclawInstallMode>([
  'manual_host_control',
  'scheduled_task',
  'startup_folder',
]);
const DEPENDENCY_STATES = new Set<NanoclawDependencyState>([
  'ok',
  'degraded',
  'unknown',
]);

function resolveProjectRoot(projectRoot = process.cwd()): string {
  return path.resolve(projectRoot);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizePid(value: unknown): number | null {
  const candidate =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isInteger(candidate) && candidate > 0 ? candidate : null;
}

function normalizeDependencyState(
  value: unknown,
): NanoclawDependencyState | null {
  return DEPENDENCY_STATES.has(value as NanoclawDependencyState)
    ? (value as NanoclawDependencyState)
    : null;
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as T;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveHostControlPaths(
  projectRoot = process.cwd(),
  appData = process.env.APPDATA,
): HostControlPaths {
  const root = resolveProjectRoot(projectRoot);
  const logsDir = path.join(root, 'logs');
  const runtimeStateDir = path.join(root, 'data', 'runtime');
  return {
    projectRoot: root,
    logsDir,
    runtimeStateDir,
    pidFilePath: path.join(root, 'nanoclaw.pid'),
    hostLogPath: path.join(logsDir, 'nanoclaw.host.log'),
    assistantLogPath: path.join(logsDir, 'nanoclaw.log'),
    assistantErrorLogPath: path.join(logsDir, 'nanoclaw.error.log'),
    hostStatePath: path.join(runtimeStateDir, 'nanoclaw-host-state.json'),
    readyStatePath: path.join(runtimeStateDir, 'nanoclaw-ready.json'),
    hostLockPath: path.join(runtimeStateDir, 'nanoclaw-host.lock'),
    nodeRuntimeMetadataPath: path.join(runtimeStateDir, 'node-runtime.json'),
    startupFolderScriptPath: appData
      ? path.join(
          appData,
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
          'Startup',
          'nanoclaw-start.cmd',
        )
      : null,
  };
}

export function getHostLogPath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).hostLogPath;
}

export function getAssistantLogPath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).assistantLogPath;
}

export function getAssistantErrorLogPath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).assistantErrorLogPath;
}

export function getHostStatePath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).hostStatePath;
}

export function getReadyStatePath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).readyStatePath;
}

export function getHostLockPath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).hostLockPath;
}

export function getNodeRuntimeMetadataPath(
  projectRoot = process.cwd(),
): string {
  return resolveHostControlPaths(projectRoot).nodeRuntimeMetadataPath;
}

export function readPidFromFile(projectRoot = process.cwd()): number | null {
  const pidFilePath = resolveHostControlPaths(projectRoot).pidFilePath;
  if (!fs.existsSync(pidFilePath)) return null;
  try {
    return normalizePid(fs.readFileSync(pidFilePath, 'utf-8').trim());
  } catch {
    return null;
  }
}

function normalizeNodeRuntimeMetadata(
  value: unknown,
): NodeRuntimeMetadata | null {
  if (!value || typeof value !== 'object') return null;
  const metadata = value as Partial<NodeRuntimeMetadata>;
  if (
    !isNonEmptyString(metadata.version) ||
    !isNonEmptyString(metadata.nodePath) ||
    !isNonEmptyString(metadata.platform) ||
    !isNonEmptyString(metadata.sourceUrl) ||
    !isNonEmptyString(metadata.validatedAt)
  ) {
    return null;
  }
  return {
    version: metadata.version,
    nodePath: metadata.nodePath,
    platform: metadata.platform,
    sourceUrl: metadata.sourceUrl,
    validatedAt: metadata.validatedAt,
  };
}

function normalizeReadyState(value: unknown): NanoclawReadyState | null {
  if (!value || typeof value !== 'object') return null;
  const readyState = value as Partial<NanoclawReadyState>;
  const pid = normalizePid(readyState.pid);
  if (
    !isNonEmptyString(readyState.bootId) ||
    pid == null ||
    !isNonEmptyString(readyState.readyAt) ||
    !isNonEmptyString(readyState.appVersion)
  ) {
    return null;
  }
  return {
    bootId: readyState.bootId,
    pid,
    readyAt: readyState.readyAt,
    appVersion: readyState.appVersion,
  };
}

function normalizeHostState(
  value: unknown,
  projectRoot = process.cwd(),
): NanoclawHostState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<NanoclawHostState>;
  const paths = resolveHostControlPaths(projectRoot);
  const phase = HOST_PHASES.has(input.phase as NanoclawHostPhase)
    ? (input.phase as NanoclawHostPhase)
    : 'stopped';
  const legacyDependencyError =
    phase === 'config_failed' &&
    isNonEmptyString(input.readyAt) &&
    isNonEmptyString(input.lastError)
      ? input.lastError
      : '';
  const dependencyState =
    normalizeDependencyState(input.dependencyState) ||
    (legacyDependencyError ? 'degraded' : 'unknown');
  const dependencyError =
    isNonEmptyString(input.dependencyError) && dependencyState === 'degraded'
      ? input.dependencyError
      : legacyDependencyError;

  return {
    bootId: isNonEmptyString(input.bootId) ? input.bootId : '',
    phase,
    pid: normalizePid(input.pid),
    installMode: INSTALL_MODES.has(input.installMode as NanoclawInstallMode)
      ? (input.installMode as NanoclawInstallMode)
      : 'manual_host_control',
    nodePath: isNonEmptyString(input.nodePath) ? input.nodePath : '',
    nodeVersion: isNonEmptyString(input.nodeVersion) ? input.nodeVersion : '',
    startedAt: isNonEmptyString(input.startedAt) ? input.startedAt : '',
    readyAt: isNonEmptyString(input.readyAt) ? input.readyAt : null,
    lastError: isNonEmptyString(input.lastError) ? input.lastError : '',
    dependencyState,
    dependencyError,
    stdoutLogPath: isNonEmptyString(input.stdoutLogPath)
      ? input.stdoutLogPath
      : paths.assistantLogPath,
    stderrLogPath: isNonEmptyString(input.stderrLogPath)
      ? input.stderrLogPath
      : paths.assistantErrorLogPath,
    hostLogPath: isNonEmptyString(input.hostLogPath)
      ? input.hostLogPath
      : paths.hostLogPath,
  };
}

export function readNodeRuntimeMetadata(
  projectRoot = process.cwd(),
): NodeRuntimeMetadata | null {
  return normalizeNodeRuntimeMetadata(
    readJsonFile<unknown>(getNodeRuntimeMetadataPath(projectRoot)),
  );
}

export function readNanoclawHostState(
  projectRoot = process.cwd(),
): NanoclawHostState | null {
  return normalizeHostState(
    readJsonFile<unknown>(getHostStatePath(projectRoot)),
    projectRoot,
  );
}

export function readNanoclawReadyState(
  projectRoot = process.cwd(),
): NanoclawReadyState | null {
  return normalizeReadyState(
    readJsonFile<unknown>(getReadyStatePath(projectRoot)),
  );
}

export function readHostControlSnapshot(
  projectRoot = process.cwd(),
): HostControlSnapshot {
  const paths = resolveHostControlPaths(projectRoot);
  return {
    paths,
    nodeRuntime: readNodeRuntimeMetadata(projectRoot),
    hostState: readNanoclawHostState(projectRoot),
    readyState: readNanoclawReadyState(projectRoot),
  };
}

export function clearAssistantReadyState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getReadyStatePath(projectRoot), { force: true });
  } catch {
    // Ignore best-effort cleanup failures during shutdown.
  }
}

export function writeAssistantReadyState(
  appVersion: string,
  projectRoot = process.cwd(),
): NanoclawReadyState {
  const hostState = readNanoclawHostState(projectRoot);
  const readyState: NanoclawReadyState = {
    bootId: hostState?.bootId || '',
    pid: process.pid,
    readyAt: new Date().toISOString(),
    appVersion,
  };
  writeJsonFile(getReadyStatePath(projectRoot), readyState);
  return readyState;
}

export function determineWindowsHostServiceState(input: {
  hostState: NanoclawHostState | null;
  readyState: NanoclawReadyState | null;
  processRunning: boolean;
}): WindowsHostServiceState {
  const { hostState, readyState, processRunning } = input;
  const readyMatchesHost = Boolean(
    processRunning &&
    hostState &&
    readyState &&
    readyState.bootId === hostState.bootId &&
    readyState.pid === hostState.pid,
  );

  if (readyMatchesHost) {
    return 'running_ready';
  }
  if (hostState?.phase === 'starting' && processRunning) {
    return 'starting';
  }
  if (!processRunning && readyState != null) {
    return 'process_stale';
  }
  if (
    !processRunning &&
    (hostState?.phase === 'starting' || hostState?.phase === 'running_ready')
  ) {
    return 'process_stale';
  }
  if (hostState?.phase === 'launcher_failed') {
    return 'launcher_failed';
  }
  if (hostState?.phase === 'config_failed') {
    return 'config_failed';
  }
  if (processRunning) {
    return 'process_stale';
  }
  return 'stopped';
}

export function formatInstallModeLabel(
  installMode: NanoclawInstallMode | null | undefined,
): string {
  switch (installMode) {
    case 'scheduled_task':
      return 'scheduled_task';
    case 'startup_folder':
      return 'startup_folder';
    case 'manual_host_control':
      return 'manual_host_control';
    default:
      return 'unknown';
  }
}

export function detectWindowsInstallMode(input: {
  hasScheduledTask: boolean;
  hasStartupFolder: boolean;
}): NanoclawInstallMode {
  if (input.hasScheduledTask) return 'scheduled_task';
  if (input.hasStartupFolder) return 'startup_folder';
  return 'manual_host_control';
}

export function buildWindowsHostControlCommand(
  projectRoot: string,
  action: 'start' | 'stop' | 'restart' | 'status',
  installMode?: NanoclawInstallMode,
): string {
  const hostScriptPath = path.join(
    resolveProjectRoot(projectRoot),
    'scripts',
    'nanoclaw-host.ps1',
  );
  const args = [
    'powershell.exe',
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
  return args.map((value) => JSON.stringify(value)).join(' ');
}

export function buildWindowsCompatibilityShim(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path',
    "$hostScriptPath = Join-Path $projectRoot 'scripts\\nanoclaw-host.ps1'",
    '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $hostScriptPath start',
    'exit $LASTEXITCODE',
  ].join('\n');
}

export function buildWindowsStartupFolderScript(projectRoot: string): string {
  return (
    [
      '@echo off',
      buildWindowsHostControlCommand(projectRoot, 'start', 'startup_folder'),
    ].join('\r\n') + '\r\n'
  );
}

export function isLegacyStartupFolderScriptContent(content: string): boolean {
  return /start-nanoclaw\.ps1/i.test(content);
}

export function detectWindowsInstallArtifacts(options?: {
  projectRoot?: string;
  appData?: string;
  hasScheduledTask?: boolean;
}): WindowsInstallArtifacts {
  const paths = resolveHostControlPaths(options?.projectRoot, options?.appData);
  let hasScheduledTask = options?.hasScheduledTask ?? false;
  if (options?.hasScheduledTask == null) {
    try {
      execFileSync('schtasks.exe', ['/Query', '/TN', 'NanoClaw'], {
        stdio: 'ignore',
      });
      hasScheduledTask = true;
    } catch {
      hasScheduledTask = false;
    }
  }

  const startupFolderScriptPath = paths.startupFolderScriptPath;
  const hasStartupFolder = Boolean(
    startupFolderScriptPath && fs.existsSync(startupFolderScriptPath),
  );
  let startupFolderScriptIsLegacy = false;
  if (hasStartupFolder && startupFolderScriptPath) {
    try {
      const content = fs.readFileSync(startupFolderScriptPath, 'utf-8');
      startupFolderScriptIsLegacy = isLegacyStartupFolderScriptContent(content);
    } catch {
      startupFolderScriptIsLegacy = false;
    }
  }

  return {
    hasScheduledTask,
    hasStartupFolder,
    startupFolderScriptPath,
    startupFolderScriptIsLegacy,
  };
}

export function buildDefaultHostState(params?: {
  projectRoot?: string;
  installMode?: NanoclawInstallMode;
}): NanoclawHostState {
  const paths = resolveHostControlPaths(params?.projectRoot);
  return {
    bootId: '',
    phase: 'stopped',
    pid: null,
    installMode: params?.installMode || 'manual_host_control',
    nodePath: '',
    nodeVersion: '',
    startedAt: '',
    readyAt: null,
    lastError: '',
    dependencyState: 'unknown',
    dependencyError: '',
    stdoutLogPath: paths.assistantLogPath,
    stderrLogPath: paths.assistantErrorLogPath,
    hostLogPath: paths.hostLogPath,
  };
}

export function persistNanoclawHostState(
  state: NanoclawHostState,
  projectRoot = process.cwd(),
): void {
  const normalized = normalizeHostState(state, projectRoot);
  if (!normalized) {
    throw new Error('Cannot persist an invalid NanoClaw host state.');
  }
  writeJsonFile(getHostStatePath(projectRoot), normalized);
}

export function isRepoOwnedWindowsProcessRunning(
  pid: number | null | undefined,
  projectRoot = process.cwd(),
): boolean {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid == null) return false;

  const rootLiteral = resolveProjectRoot(projectRoot).replace(/'/g, "''");
  const script = [
    `$root = '${rootLiteral}'`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${normalizedPid}" -ErrorAction SilentlyContinue`,
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

export function isRepoOwnedNanoclawProcessRunning(
  pid: number | null | undefined,
  projectRoot = process.cwd(),
): boolean {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid == null) return false;
  if (process.platform === 'win32') {
    return isRepoOwnedWindowsProcessRunning(normalizedPid, projectRoot);
  }
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileWindowsHostState(options?: {
  projectRoot?: string;
  processValidator?: (pid: number, projectRoot: string) => boolean;
}): WindowsHostReconciliation {
  const projectRoot = resolveProjectRoot(options?.projectRoot);
  const snapshot = readHostControlSnapshot(projectRoot);
  const runtimePid = snapshot.hostState?.pid ?? readPidFromFile(projectRoot);
  const processValidator =
    options?.processValidator || isRepoOwnedWindowsProcessRunning;
  const processRunning =
    runtimePid != null ? processValidator(runtimePid, projectRoot) : false;
  const readyMatchesHost = Boolean(
    processRunning &&
    snapshot.hostState &&
    snapshot.readyState &&
    snapshot.readyState.bootId === snapshot.hostState.bootId &&
    snapshot.readyState.pid === runtimePid,
  );
  const serviceState = determineWindowsHostServiceState({
    hostState: snapshot.hostState,
    readyState: snapshot.readyState,
    processRunning,
  });
  const dependencyState = snapshot.hostState?.dependencyState || 'unknown';
  const dependencyError =
    dependencyState === 'degraded'
      ? snapshot.hostState?.dependencyError || ''
      : '';

  return {
    snapshot,
    runtimePid,
    processRunning,
    readyMatchesHost,
    serviceState,
    activeLaunchMode: snapshot.hostState?.installMode || null,
    launcherError:
      serviceState === 'running_ready'
        ? ''
        : snapshot.hostState?.lastError || '',
    dependencyState,
    dependencyError,
  };
}
