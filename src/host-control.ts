import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import type { ChannelHealthSnapshot } from './types.js';

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

export interface AssistantHealthState {
  bootId: string;
  pid: number;
  appVersion: string;
  updatedAt: string;
  channels: ChannelHealthSnapshot[];
}

export type AssistantHealthStatus = 'healthy' | 'missing' | 'stale' | 'degraded';

export type TelegramRoundtripSource =
  | 'organic'
  | 'scheduled_probe'
  | 'live_smoke'
  | 'startup';

export type TelegramRoundtripStateStatus =
  | 'healthy'
  | 'failed'
  | 'unconfigured'
  | 'pending';

export interface TelegramRoundtripState {
  bootId: string;
  pid: number | null;
  status: TelegramRoundtripStateStatus;
  source: TelegramRoundtripSource;
  detail: string;
  chatTarget: string | null;
  expectedReply: string | null;
  updatedAt: string;
  lastSuccessAt: string | null;
  lastProbeAt: string | null;
  nextDueAt: string | null;
  consecutiveFailures: number;
}

export type TelegramRoundtripHealthStatus =
  | 'healthy'
  | 'missing'
  | 'degraded'
  | 'unconfigured'
  | 'pending';

export type TelegramTransportMode = 'long_polling';

export type TelegramTransportStatus =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'unconfigured'
  | 'stopped';

export type TelegramTransportErrorClass =
  | 'none'
  | 'webhook_active'
  | 'setwebhook_conflict'
  | 'getupdates_conflict'
  | 'shared_token_suspected'
  | 'token_rotation_required'
  | 'local_start_failure';

export interface TelegramTransportState {
  bootId: string;
  pid: number | null;
  mode: TelegramTransportMode;
  status: TelegramTransportStatus;
  detail: string;
  updatedAt: string;
  lastError: string | null;
  lastErrorClass: TelegramTransportErrorClass;
  webhookPresent: boolean;
  webhookUrl: string | null;
  lastWebhookCheckAt: string | null;
  lastPollConflictAt: string | null;
  externalConsumerSuspected: boolean;
  tokenRotationRequired: boolean;
  consecutiveExternalConflicts: number;
}

export interface RuntimeAuditState {
  updatedAt: string;
  activeRepoRoot: string;
  activeGitBranch: string;
  activeGitCommit: string;
  activeEntryPath: string;
  activeEnvPath: string;
  activeStoreDbPath: string;
  activeRuntimeStateDir: string;
  assistantName: string;
  assistantNameSource: 'env' | 'default';
  registeredMainChatJid: string | null;
  registeredMainChatName: string | null;
  registeredMainChatFolder: string | null;
  registeredMainChatPresentInChats: boolean;
  latestTelegramChatJid: string | null;
  latestTelegramChatName: string | null;
  mainChatAuditWarning: string | null;
}

export interface AssistantHealthAssessment {
  status: AssistantHealthStatus;
  detail: string;
  updatedAt: string | null;
  degradedChannels: string[];
  staleAfterMs: number;
}

export interface TelegramRoundtripAssessment {
  status: TelegramRoundtripHealthStatus;
  detail: string;
  updatedAt: string | null;
  lastOkAt: string | null;
  lastProbeAt: string | null;
  nextDueAt: string | null;
  due: boolean;
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
  assistantHealthStatePath: string;
  telegramRoundtripStatePath: string;
  telegramTransportStatePath: string;
  runtimeAuditStatePath: string;
  hostLockPath: string;
  nodeRuntimeMetadataPath: string;
  startupFolderScriptPath: string | null;
}

export interface HostControlSnapshot {
  paths: HostControlPaths;
  nodeRuntime: NodeRuntimeMetadata | null;
  hostState: NanoclawHostState | null;
  readyState: NanoclawReadyState | null;
  assistantHealthState: AssistantHealthState | null;
  telegramRoundtripState: TelegramRoundtripState | null;
  telegramTransportState: TelegramTransportState | null;
  runtimeAuditState: RuntimeAuditState | null;
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
export const DEFAULT_ASSISTANT_HEALTH_STALE_AFTER_MS = 3 * 60 * 1000;
export const DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS = 30 * 60 * 1000;
export const DEFAULT_TELEGRAM_ROUNDTRIP_STARTUP_GRACE_MS = 5 * 60 * 1000;

const TELEGRAM_ROUNDTRIP_SOURCES = new Set<TelegramRoundtripSource>([
  'organic',
  'scheduled_probe',
  'live_smoke',
  'startup',
]);

const TELEGRAM_ROUNDTRIP_STATUSES = new Set<TelegramRoundtripStateStatus>([
  'healthy',
  'failed',
  'unconfigured',
  'pending',
]);

const TELEGRAM_TRANSPORT_MODES = new Set<TelegramTransportMode>([
  'long_polling',
]);

const TELEGRAM_TRANSPORT_STATUSES = new Set<TelegramTransportStatus>([
  'starting',
  'ready',
  'degraded',
  'blocked',
  'unconfigured',
  'stopped',
]);

const TELEGRAM_TRANSPORT_ERROR_CLASSES = new Set<TelegramTransportErrorClass>([
  'none',
  'webhook_active',
  'setwebhook_conflict',
  'getupdates_conflict',
  'shared_token_suspected',
  'token_rotation_required',
  'local_start_failure',
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
    assistantHealthStatePath: path.join(
      runtimeStateDir,
      'assistant-health.json',
    ),
    telegramRoundtripStatePath: path.join(
      runtimeStateDir,
      'telegram-roundtrip-health.json',
    ),
    telegramTransportStatePath: path.join(
      runtimeStateDir,
      'telegram-transport-health.json',
    ),
    runtimeAuditStatePath: path.join(runtimeStateDir, 'runtime-audit.json'),
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

export function getAssistantHealthStatePath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).assistantHealthStatePath;
}

export function getTelegramRoundtripStatePath(
  projectRoot = process.cwd(),
): string {
  return resolveHostControlPaths(projectRoot).telegramRoundtripStatePath;
}

export function getTelegramTransportStatePath(
  projectRoot = process.cwd(),
): string {
  return resolveHostControlPaths(projectRoot).telegramTransportStatePath;
}

export function getRuntimeAuditStatePath(projectRoot = process.cwd()): string {
  return resolveHostControlPaths(projectRoot).runtimeAuditStatePath;
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

function normalizeChannelHealthSnapshot(
  value: unknown,
): ChannelHealthSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Partial<ChannelHealthSnapshot>;
  const state = snapshot.state;
  if (
    !isNonEmptyString(snapshot.name) ||
    typeof snapshot.configured !== 'boolean' ||
    !['starting', 'ready', 'degraded', 'stopped'].includes(String(state)) ||
    !isNonEmptyString(snapshot.updatedAt)
  ) {
    return null;
  }
  return {
    name: snapshot.name,
    configured: snapshot.configured,
    state: state as ChannelHealthSnapshot['state'],
    updatedAt: snapshot.updatedAt,
    lastReadyAt: isNonEmptyString(snapshot.lastReadyAt)
      ? snapshot.lastReadyAt
      : null,
    lastError: isNonEmptyString(snapshot.lastError) ? snapshot.lastError : null,
    detail: isNonEmptyString(snapshot.detail) ? snapshot.detail : null,
  };
}

function normalizeAssistantHealthState(
  value: unknown,
): AssistantHealthState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<AssistantHealthState> & {
    channels?: unknown[];
  };
  const pid = normalizePid(input.pid);
  if (
    !isNonEmptyString(input.bootId) ||
    pid == null ||
    !isNonEmptyString(input.appVersion) ||
    !isNonEmptyString(input.updatedAt)
  ) {
    return null;
  }
  const channels = Array.isArray(input.channels)
    ? input.channels
        .map((channel) => normalizeChannelHealthSnapshot(channel))
        .filter((channel): channel is ChannelHealthSnapshot => channel != null)
    : [];
  return {
    bootId: input.bootId,
    pid,
    appVersion: input.appVersion,
    updatedAt: input.updatedAt,
    channels,
  };
}

function normalizeTelegramRoundtripState(
  value: unknown,
): TelegramRoundtripState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<TelegramRoundtripState>;
  const pid = normalizePid(input.pid);
  const status = TELEGRAM_ROUNDTRIP_STATUSES.has(
    input.status as TelegramRoundtripStateStatus,
  )
    ? (input.status as TelegramRoundtripStateStatus)
    : null;
  const source = TELEGRAM_ROUNDTRIP_SOURCES.has(
    input.source as TelegramRoundtripSource,
  )
    ? (input.source as TelegramRoundtripSource)
    : null;
  if (
    !status ||
    !source ||
    !isNonEmptyString(input.updatedAt) ||
    typeof input.consecutiveFailures !== 'number' ||
    input.consecutiveFailures < 0
  ) {
    return null;
  }
  return {
    bootId: isNonEmptyString(input.bootId) ? input.bootId : '',
    pid,
    status,
    source,
    detail: isNonEmptyString(input.detail) ? input.detail : '',
    chatTarget: isNonEmptyString(input.chatTarget) ? input.chatTarget : null,
    expectedReply: isNonEmptyString(input.expectedReply)
      ? input.expectedReply
      : null,
    updatedAt: input.updatedAt,
    lastSuccessAt: isNonEmptyString(input.lastSuccessAt)
      ? input.lastSuccessAt
      : null,
    lastProbeAt: isNonEmptyString(input.lastProbeAt) ? input.lastProbeAt : null,
    nextDueAt: isNonEmptyString(input.nextDueAt) ? input.nextDueAt : null,
    consecutiveFailures: Math.trunc(input.consecutiveFailures),
  };
}

function normalizeTelegramTransportState(
  value: unknown,
): TelegramTransportState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<TelegramTransportState>;
  const pid = normalizePid(input.pid);
  const mode = TELEGRAM_TRANSPORT_MODES.has(input.mode as TelegramTransportMode)
    ? (input.mode as TelegramTransportMode)
    : null;
  const status = TELEGRAM_TRANSPORT_STATUSES.has(
    input.status as TelegramTransportStatus,
  )
    ? (input.status as TelegramTransportStatus)
    : null;
  const lastErrorClass = TELEGRAM_TRANSPORT_ERROR_CLASSES.has(
    input.lastErrorClass as TelegramTransportErrorClass,
  )
    ? (input.lastErrorClass as TelegramTransportErrorClass)
    : null;
  if (
    !mode ||
    !status ||
    !lastErrorClass ||
    !isNonEmptyString(input.updatedAt) ||
    typeof input.webhookPresent !== 'boolean' ||
    typeof input.externalConsumerSuspected !== 'boolean' ||
    typeof input.tokenRotationRequired !== 'boolean' ||
    typeof input.consecutiveExternalConflicts !== 'number' ||
    input.consecutiveExternalConflicts < 0
  ) {
    return null;
  }
  return {
    bootId: isNonEmptyString(input.bootId) ? input.bootId : '',
    pid,
    mode,
    status,
    detail: isNonEmptyString(input.detail) ? input.detail : '',
    updatedAt: input.updatedAt,
    lastError: isNonEmptyString(input.lastError) ? input.lastError : null,
    lastErrorClass,
    webhookPresent: input.webhookPresent,
    webhookUrl: isNonEmptyString(input.webhookUrl) ? input.webhookUrl : null,
    lastWebhookCheckAt: isNonEmptyString(input.lastWebhookCheckAt)
      ? input.lastWebhookCheckAt
      : null,
    lastPollConflictAt: isNonEmptyString(input.lastPollConflictAt)
      ? input.lastPollConflictAt
      : null,
    externalConsumerSuspected: input.externalConsumerSuspected,
    tokenRotationRequired: input.tokenRotationRequired,
    consecutiveExternalConflicts: Math.trunc(input.consecutiveExternalConflicts),
  };
}

function normalizeRuntimeAuditState(value: unknown): RuntimeAuditState | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<RuntimeAuditState>;
  const assistantNameSource =
    input.assistantNameSource === 'env' || input.assistantNameSource === 'default'
      ? input.assistantNameSource
      : null;
  if (
    !isNonEmptyString(input.updatedAt) ||
    !isNonEmptyString(input.activeRepoRoot) ||
    !isNonEmptyString(input.activeGitBranch) ||
    !isNonEmptyString(input.activeGitCommit) ||
    !isNonEmptyString(input.activeEntryPath) ||
    !isNonEmptyString(input.activeEnvPath) ||
    !isNonEmptyString(input.activeStoreDbPath) ||
    !isNonEmptyString(input.activeRuntimeStateDir) ||
    !isNonEmptyString(input.assistantName) ||
    !assistantNameSource ||
    typeof input.registeredMainChatPresentInChats !== 'boolean'
  ) {
    return null;
  }

  return {
    updatedAt: input.updatedAt,
    activeRepoRoot: input.activeRepoRoot,
    activeGitBranch: input.activeGitBranch,
    activeGitCommit: input.activeGitCommit,
    activeEntryPath: input.activeEntryPath,
    activeEnvPath: input.activeEnvPath,
    activeStoreDbPath: input.activeStoreDbPath,
    activeRuntimeStateDir: input.activeRuntimeStateDir,
    assistantName: input.assistantName,
    assistantNameSource,
    registeredMainChatJid: isNonEmptyString(input.registeredMainChatJid)
      ? input.registeredMainChatJid
      : null,
    registeredMainChatName: isNonEmptyString(input.registeredMainChatName)
      ? input.registeredMainChatName
      : null,
    registeredMainChatFolder: isNonEmptyString(input.registeredMainChatFolder)
      ? input.registeredMainChatFolder
      : null,
    registeredMainChatPresentInChats: input.registeredMainChatPresentInChats,
    latestTelegramChatJid: isNonEmptyString(input.latestTelegramChatJid)
      ? input.latestTelegramChatJid
      : null,
    latestTelegramChatName: isNonEmptyString(input.latestTelegramChatName)
      ? input.latestTelegramChatName
      : null,
    mainChatAuditWarning: isNonEmptyString(input.mainChatAuditWarning)
      ? input.mainChatAuditWarning
      : null,
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

export function readRuntimeAuditState(
  projectRoot = process.cwd(),
): RuntimeAuditState | null {
  return normalizeRuntimeAuditState(
    readJsonFile<unknown>(getRuntimeAuditStatePath(projectRoot)),
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

export function readAssistantHealthState(
  projectRoot = process.cwd(),
): AssistantHealthState | null {
  return normalizeAssistantHealthState(
    readJsonFile<unknown>(getAssistantHealthStatePath(projectRoot)),
  );
}

export function readTelegramRoundtripState(
  projectRoot = process.cwd(),
): TelegramRoundtripState | null {
  return normalizeTelegramRoundtripState(
    readJsonFile<unknown>(getTelegramRoundtripStatePath(projectRoot)),
  );
}

export function readTelegramTransportState(
  projectRoot = process.cwd(),
): TelegramTransportState | null {
  return normalizeTelegramTransportState(
    readJsonFile<unknown>(getTelegramTransportStatePath(projectRoot)),
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
    assistantHealthState: readAssistantHealthState(projectRoot),
    telegramRoundtripState: readTelegramRoundtripState(projectRoot),
    telegramTransportState: readTelegramTransportState(projectRoot),
    runtimeAuditState: readRuntimeAuditState(projectRoot),
  };
}

export function clearAssistantReadyState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getReadyStatePath(projectRoot), { force: true });
  } catch {
    // Ignore best-effort cleanup failures during shutdown.
  }
}

export function clearAssistantHealthState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getAssistantHealthStatePath(projectRoot), { force: true });
  } catch {
    // Ignore best-effort cleanup failures during shutdown.
  }
}

export function clearTelegramRoundtripState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getTelegramRoundtripStatePath(projectRoot), { force: true });
  } catch {
    // Ignore best-effort cleanup failures during shutdown.
  }
}

export function clearTelegramTransportState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getTelegramTransportStatePath(projectRoot), { force: true });
  } catch {
    // Ignore best-effort cleanup failures during shutdown.
  }
}

export function clearRuntimeAuditState(projectRoot = process.cwd()): void {
  try {
    fs.rmSync(getRuntimeAuditStatePath(projectRoot), { force: true });
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

export function writeAssistantHealthState(
  params: {
    appVersion: string;
    channelHealth: ChannelHealthSnapshot[];
    updatedAt?: string;
  },
  projectRoot = process.cwd(),
): AssistantHealthState {
  const hostState = readNanoclawHostState(projectRoot);
  const healthState: AssistantHealthState = {
    bootId: hostState?.bootId || '',
    pid: process.pid,
    appVersion: params.appVersion,
    updatedAt: params.updatedAt || new Date().toISOString(),
    channels: [...params.channelHealth]
      .map((channel) => ({ ...channel }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
  writeJsonFile(getAssistantHealthStatePath(projectRoot), healthState);
  return healthState;
}

export function writeTelegramRoundtripState(
  state: TelegramRoundtripState,
  projectRoot = process.cwd(),
): TelegramRoundtripState {
  const normalized = normalizeTelegramRoundtripState(state);
  if (!normalized) {
    throw new Error('Cannot persist an invalid Telegram roundtrip state.');
  }
  writeJsonFile(getTelegramRoundtripStatePath(projectRoot), normalized);
  return normalized;
}

export function writeTelegramTransportState(
  state: TelegramTransportState,
  projectRoot = process.cwd(),
): TelegramTransportState {
  const normalized = normalizeTelegramTransportState(state);
  if (!normalized) {
    throw new Error('Cannot persist an invalid Telegram transport state.');
  }
  writeJsonFile(getTelegramTransportStatePath(projectRoot), normalized);
  return normalized;
}

export function writeRuntimeAuditState(
  state: RuntimeAuditState,
  projectRoot = process.cwd(),
): RuntimeAuditState {
  const normalized = normalizeRuntimeAuditState(state);
  if (!normalized) {
    throw new Error('Cannot persist an invalid runtime audit state.');
  }
  writeJsonFile(getRuntimeAuditStatePath(projectRoot), normalized);
  return normalized;
}

export function assessAssistantHealthState(input: {
  assistantHealthState: AssistantHealthState | null;
  hostState?: NanoclawHostState | null;
  readyState?: NanoclawReadyState | null;
  processRunning?: boolean;
  runtimePid?: number | null;
  now?: Date;
  staleAfterMs?: number;
}): AssistantHealthAssessment {
  const assistantHealthState = input.assistantHealthState;
  const staleAfterMs =
    input.staleAfterMs ?? DEFAULT_ASSISTANT_HEALTH_STALE_AFTER_MS;
  if (!assistantHealthState) {
    return {
      status: 'missing',
      detail: 'Assistant health marker is missing.',
      updatedAt: null,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  const hostState = input.hostState || null;
  const readyState = input.readyState || null;
  const runtimePid = input.runtimePid ?? null;
  const now = input.now ?? new Date();
  const updatedAtMs = Date.parse(assistantHealthState.updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return {
      status: 'stale',
      detail: 'Assistant health marker has an invalid timestamp.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  if (input.processRunning === false) {
    return {
      status: 'stale',
      detail: 'Assistant process is not running.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  if (
    runtimePid != null &&
    assistantHealthState.pid > 0 &&
    assistantHealthState.pid !== runtimePid
  ) {
    return {
      status: 'degraded',
      detail: 'Assistant health marker is reporting a different process id.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  if (
    hostState?.bootId &&
    assistantHealthState.bootId &&
    assistantHealthState.bootId !== hostState.bootId
  ) {
    return {
      status: 'degraded',
      detail: 'Assistant health marker boot id does not match host state.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  if (
    readyState?.bootId &&
    assistantHealthState.bootId &&
    assistantHealthState.bootId !== readyState.bootId
  ) {
    return {
      status: 'degraded',
      detail: 'Assistant health marker boot id does not match ready state.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  if (now.getTime() - updatedAtMs > staleAfterMs) {
    return {
      status: 'stale',
      detail: 'Assistant health marker is stale.',
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels: [],
      staleAfterMs,
    };
  }

  const degradedChannels = assistantHealthState.channels
    .filter((channel) => channel.configured && channel.state !== 'ready')
    .map((channel) => channel.name);
  if (degradedChannels.length > 0) {
    const details = assistantHealthState.channels
      .filter((channel) => degradedChannels.includes(channel.name))
      .map((channel) => {
        const reason = channel.lastError || channel.detail || channel.state;
        return `${channel.name}: ${reason}`;
      });
    return {
      status: 'degraded',
      detail: details.join('; '),
      updatedAt: assistantHealthState.updatedAt,
      degradedChannels,
      staleAfterMs,
    };
  }

  return {
    status: 'healthy',
    detail: 'Assistant health marker is current.',
    updatedAt: assistantHealthState.updatedAt,
    degradedChannels: [],
    staleAfterMs,
  };
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function assessTelegramRoundtripState(input: {
  assistantHealthState: AssistantHealthState | null;
  telegramRoundtripState: TelegramRoundtripState | null;
  hostState?: NanoclawHostState | null;
  readyState?: NanoclawReadyState | null;
  now?: Date;
  probeIntervalMs?: number;
  startupGraceMs?: number;
}): TelegramRoundtripAssessment {
  const now = input.now ?? new Date();
  const probeIntervalMs =
    input.probeIntervalMs ?? DEFAULT_TELEGRAM_ROUNDTRIP_PROBE_INTERVAL_MS;
  const startupGraceMs =
    input.startupGraceMs ?? DEFAULT_TELEGRAM_ROUNDTRIP_STARTUP_GRACE_MS;
  const assistantHealthState = input.assistantHealthState;
  const roundtrip = input.telegramRoundtripState;
  const readyState = input.readyState || null;
  const hostState = input.hostState || null;
  const telegramChannel = assistantHealthState?.channels.find(
    (channel) => channel.name === 'telegram' && channel.configured,
  );

  if (!telegramChannel) {
    return {
      status: 'unconfigured',
      detail: 'Telegram roundtrip checks are not configured for this runtime.',
      updatedAt: roundtrip?.updatedAt || null,
      lastOkAt: roundtrip?.lastSuccessAt || null,
      lastProbeAt: roundtrip?.lastProbeAt || null,
      nextDueAt: roundtrip?.nextDueAt || null,
      due: false,
    };
  }

  const readyAtMs = parseTime(readyState?.readyAt || hostState?.readyAt || null);
  const inStartupGrace =
    readyAtMs != null && now.getTime() - readyAtMs < startupGraceMs;

  if (!roundtrip) {
    return {
      status: inStartupGrace ? 'pending' : 'missing',
      detail: inStartupGrace
        ? 'Waiting for the first Telegram roundtrip confirmation after startup.'
        : 'Telegram roundtrip health marker is missing.',
      updatedAt: null,
      lastOkAt: null,
      lastProbeAt: null,
      nextDueAt: null,
      due: !inStartupGrace,
    };
  }

  if (roundtrip.status === 'unconfigured') {
    return {
      status: 'unconfigured',
      detail:
        roundtrip.detail ||
        'Telegram user-session probe is not configured on this machine.',
      updatedAt: roundtrip.updatedAt,
      lastOkAt: roundtrip.lastSuccessAt,
      lastProbeAt: roundtrip.lastProbeAt,
      nextDueAt: roundtrip.nextDueAt,
      due: false,
    };
  }

  const bootIdMismatch =
    Boolean(hostState?.bootId) &&
    Boolean(roundtrip.bootId) &&
    roundtrip.bootId !== hostState?.bootId;
  if (bootIdMismatch) {
    return {
      status: inStartupGrace ? 'pending' : 'degraded',
      detail: inStartupGrace
        ? 'Telegram roundtrip is waiting for post-restart confirmation.'
        : 'Telegram roundtrip health is from an older assistant boot.',
      updatedAt: roundtrip.updatedAt,
      lastOkAt: roundtrip.lastSuccessAt,
      lastProbeAt: roundtrip.lastProbeAt,
      nextDueAt: roundtrip.nextDueAt,
      due: !inStartupGrace,
    };
  }

  const nextDueAtMs = parseTime(roundtrip.nextDueAt);
  const lastSuccessAtMs = parseTime(roundtrip.lastSuccessAt);
  const computedNextDueAt =
    nextDueAtMs != null
      ? nextDueAtMs
      : lastSuccessAtMs != null
        ? lastSuccessAtMs + probeIntervalMs
        : null;
  const due =
    computedNextDueAt == null ? roundtrip.status !== 'healthy' : now.getTime() >= computedNextDueAt;

  if (roundtrip.status === 'healthy' && !due) {
    return {
      status: 'healthy',
      detail:
        roundtrip.detail || 'Telegram roundtrip is healthy and within cadence.',
      updatedAt: roundtrip.updatedAt,
      lastOkAt: roundtrip.lastSuccessAt,
      lastProbeAt: roundtrip.lastProbeAt,
      nextDueAt:
        computedNextDueAt != null
          ? new Date(computedNextDueAt).toISOString()
          : roundtrip.nextDueAt,
      due: false,
    };
  }

  if (roundtrip.status === 'pending' && inStartupGrace) {
    return {
      status: 'pending',
      detail:
        roundtrip.detail ||
        'Telegram roundtrip is pending during the startup grace window.',
      updatedAt: roundtrip.updatedAt,
      lastOkAt: roundtrip.lastSuccessAt,
      lastProbeAt: roundtrip.lastProbeAt,
      nextDueAt:
        computedNextDueAt != null
          ? new Date(computedNextDueAt).toISOString()
          : roundtrip.nextDueAt,
      due: false,
    };
  }

  return {
    status: 'degraded',
    detail:
      roundtrip.detail ||
      'Telegram roundtrip has not succeeded recently enough to trust Telegram responsiveness.',
    updatedAt: roundtrip.updatedAt,
    lastOkAt: roundtrip.lastSuccessAt,
    lastProbeAt: roundtrip.lastProbeAt,
    nextDueAt:
      computedNextDueAt != null
        ? new Date(computedNextDueAt).toISOString()
        : roundtrip.nextDueAt,
    due,
  };
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
