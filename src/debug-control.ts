import fs from 'fs';
import path from 'path';

import { getRouterState, setRouterState } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import {
  buildRuntimeCommitTruth,
  detectWindowsInstallArtifacts,
  detectWindowsInstallMode,
  determineWindowsHostServiceState,
  formatInstallModeLabel,
  readAlexaLastSignedRequestState,
  readHostControlSnapshot,
  reconcileWindowsHostState,
} from './host-control.js';
import { buildFieldTrialOperatorTruth } from './field-trial-readiness.js';
import {
  getLogControlConfig,
  type LogControlConfig,
  type OperatorLogLevel,
  sanitizeLogString,
  setLogControlConfig,
  type RuntimeLogLevel,
} from './logger.js';
import type { SendMessageOptions } from './types.js';

export const LOG_CONTROL_ROUTER_STATE_KEY = 'log_control_config';
export const ASSISTANT_EXECUTION_PROBE_ROUTER_STATE_KEY =
  'assistant_execution_probe_status';
export const DEFAULT_TELEGRAM_DEBUG_DURATION_MS = 60 * 60 * 1000;
export const MAX_DEBUG_LOG_LINES = 200;

function getLogsDir(): string {
  return path.join(process.cwd(), 'logs');
}

export interface AssistantExecutionProbeState {
  status: 'ok' | 'failed' | 'skipped' | 'unknown';
  reason: string;
  detail?: string;
  checkedAt: string;
}

export interface ParsedDebugScope {
  scopeKey: string;
  label: string;
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;
let lastPersistedLogControlRaw = '';

function cloneLogControlConfig(config: LogControlConfig): LogControlConfig {
  return {
    globalLevel: config.globalLevel,
    scopedOverrides: Object.fromEntries(
      Object.entries(config.scopedOverrides || {}).map(([scope, override]) => [
        scope,
        {
          level: override.level,
          expiresAt: override.expiresAt || null,
          updatedAt: override.updatedAt,
          updatedBy: override.updatedBy,
        },
      ]),
    ),
    updatedAt: config.updatedAt,
    updatedBy: config.updatedBy,
  };
}

function buildDefaultProbeState(): AssistantExecutionProbeState {
  return {
    status: 'unknown',
    reason: 'unknown',
    detail: '',
    checkedAt: '',
  };
}

function normalizeLogLevel(level: OperatorLogLevel | string): RuntimeLogLevel {
  const normalized = String(level || '')
    .trim()
    .toLowerCase();
  if (normalized === 'verbose' || normalized === 'trace') return 'trace';
  if (normalized === 'debug') return 'debug';
  return 'info';
}

export function parseDebugDurationMs(
  value: string | undefined,
  defaultMs = DEFAULT_TELEGRAM_DEBUG_DURATION_MS,
): number {
  const trimmed = (value || '').trim().toLowerCase();
  if (!trimmed) return defaultMs;

  const match = trimmed.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(
      'Duration must look like 30m, 2h, 1d, or a plain minute count.',
    );
  }

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Duration must be a positive number.');
  }

  const unit = match[2] || 'm';
  switch (unit) {
    case 'ms':
      return amount;
    case 's':
      return amount * 1000;
    case 'm':
      return amount * 60 * 1000;
    case 'h':
      return amount * 60 * 60 * 1000;
    case 'd':
      return amount * 24 * 60 * 60 * 1000;
    default:
      return defaultMs;
  }
}

export function resolveDebugScope(
  scopeToken: string | undefined,
  chatJid?: string,
): ParsedDebugScope {
  const normalized = (scopeToken || 'global').trim().toLowerCase();
  if (!normalized || normalized === 'global') {
    return { scopeKey: 'global', label: 'global' };
  }
  if (normalized === 'chat' || normalized === 'current') {
    if (!chatJid) {
      throw new Error(
        'The current/chat scope needs an active control chat to resolve.',
      );
    }
    return {
      scopeKey: `chat:${chatJid}`,
      label: `chat:${chatJid}`,
    };
  }
  if (normalized === 'lane:runtime') {
    return {
      scopeKey: 'lane:andrea_runtime',
      label: 'lane:andrea_runtime',
    };
  }
  if (
    normalized === 'lane:cursor' ||
    normalized === 'lane:andrea_runtime' ||
    normalized === 'component:assistant' ||
    normalized === 'component:container' ||
    normalized === 'component:telegram'
  ) {
    return { scopeKey: normalized, label: normalized };
  }
  if (/^chat:[^\s]+$/i.test(normalized)) {
    return { scopeKey: normalized, label: normalized };
  }
  throw new Error(
    'Scope must be global, chat, current, lane:cursor, lane:andrea_runtime, component:assistant, component:container, or component:telegram.',
  );
}

function cleanLogControlConfig(config: LogControlConfig): LogControlConfig {
  const cleaned = cloneLogControlConfig(config);
  const now = Date.now();

  for (const [scope, override] of Object.entries(cleaned.scopedOverrides)) {
    if (!override.expiresAt) continue;
    const expiresAtMs = Date.parse(override.expiresAt);
    if (Number.isNaN(expiresAtMs) || expiresAtMs <= now) {
      delete cleaned.scopedOverrides[scope];
    }
  }

  return cleaned;
}

export function readPersistedLogControlConfig(): LogControlConfig {
  const stored = getRouterState(LOG_CONTROL_ROUTER_STATE_KEY);
  if (!stored) {
    return cleanLogControlConfig(getLogControlConfig());
  }

  try {
    const parsed = JSON.parse(stored) as LogControlConfig;
    return cleanLogControlConfig(parsed);
  } catch {
    return cleanLogControlConfig(getLogControlConfig());
  }
}

export function persistLogControlConfig(config: LogControlConfig): void {
  const cleaned = cleanLogControlConfig(config);
  const serialized = JSON.stringify(cleaned);
  setRouterState(LOG_CONTROL_ROUTER_STATE_KEY, serialized);
  lastPersistedLogControlRaw = serialized;
}

export function loadLogControlFromPersistence(): LogControlConfig {
  const config = readPersistedLogControlConfig();
  setLogControlConfig(config);
  lastPersistedLogControlRaw = JSON.stringify(config);
  return config;
}

export function refreshLogControlFromPersistence(): LogControlConfig {
  const stored = getRouterState(LOG_CONTROL_ROUTER_STATE_KEY);
  if (!stored) return getLogControlConfig();
  if (stored === lastPersistedLogControlRaw) {
    return getLogControlConfig();
  }
  try {
    const parsed = JSON.parse(stored) as LogControlConfig;
    const cleaned = cleanLogControlConfig(parsed);
    setLogControlConfig(cleaned);
    lastPersistedLogControlRaw = JSON.stringify(cleaned);
    return cleaned;
  } catch {
    return getLogControlConfig();
  }
}

export function startLogControlAutoRefresh(intervalMs = 5_000): void {
  if (refreshInterval) return;
  refreshInterval = setInterval(() => {
    try {
      refreshLogControlFromPersistence();
    } catch {
      // Ignore refresh failures; operators can still use the current in-memory config.
    }
  }, intervalMs);
  refreshInterval.unref?.();
}

export function stopLogControlAutoRefresh(): void {
  if (!refreshInterval) return;
  clearInterval(refreshInterval);
  refreshInterval = null;
}

export function setDebugLevel(params: {
  level: OperatorLogLevel | string;
  scopeToken?: string;
  durationToken?: string;
  updatedBy: string;
  chatJid?: string;
  defaultDurationMs?: number;
}): {
  config: LogControlConfig;
  resolvedScope: ParsedDebugScope;
  level: RuntimeLogLevel;
  expiresAt: string | null;
} {
  const resolvedScope = resolveDebugScope(params.scopeToken, params.chatJid);
  const level = normalizeLogLevel(params.level);
  const current = readPersistedLogControlConfig();
  const next = cloneLogControlConfig(current);
  const now = new Date().toISOString();

  if (resolvedScope.scopeKey === 'global') {
    next.globalLevel = level;
    next.updatedAt = now;
    next.updatedBy = params.updatedBy;
    persistLogControlConfig(next);
    setLogControlConfig(next);
    return {
      config: next,
      resolvedScope,
      level,
      expiresAt: null,
    };
  }

  const durationMs = parseDebugDurationMs(
    params.durationToken,
    params.defaultDurationMs ?? DEFAULT_TELEGRAM_DEBUG_DURATION_MS,
  );
  const expiresAt = new Date(Date.now() + durationMs).toISOString();
  next.scopedOverrides[resolvedScope.scopeKey] = {
    level,
    expiresAt,
    updatedAt: now,
    updatedBy: params.updatedBy,
  };
  next.updatedAt = now;
  next.updatedBy = params.updatedBy;

  persistLogControlConfig(next);
  setLogControlConfig(next);

  return {
    config: next,
    resolvedScope,
    level,
    expiresAt,
  };
}

export function resetDebugLevel(params: {
  scopeToken?: string;
  updatedBy: string;
  chatJid?: string;
}): {
  config: LogControlConfig;
  resetScope: string;
} {
  const normalized = (params.scopeToken || '').trim().toLowerCase();
  const current = readPersistedLogControlConfig();
  const next = cloneLogControlConfig(current);
  const now = new Date().toISOString();

  if (!normalized || normalized === 'all') {
    next.globalLevel = 'info';
    next.scopedOverrides = {};
    next.updatedAt = now;
    next.updatedBy = params.updatedBy;
    persistLogControlConfig(next);
    setLogControlConfig(next);
    return {
      config: next,
      resetScope: 'all',
    };
  }

  const resolvedScope = resolveDebugScope(normalized, params.chatJid);
  if (resolvedScope.scopeKey === 'global') {
    next.globalLevel = 'info';
  } else {
    delete next.scopedOverrides[resolvedScope.scopeKey];
  }
  next.updatedAt = now;
  next.updatedBy = params.updatedBy;
  persistLogControlConfig(next);
  setLogControlConfig(next);

  return {
    config: next,
    resetScope: resolvedScope.label,
  };
}

export function getAssistantExecutionProbeState(): AssistantExecutionProbeState {
  const stored = getRouterState(ASSISTANT_EXECUTION_PROBE_ROUTER_STATE_KEY);
  if (!stored) return buildDefaultProbeState();
  try {
    const parsed = JSON.parse(stored) as Partial<AssistantExecutionProbeState>;
    return {
      status:
        parsed.status === 'ok' ||
        parsed.status === 'failed' ||
        parsed.status === 'skipped' ||
        parsed.status === 'unknown'
          ? parsed.status
          : 'unknown',
      reason:
        typeof parsed.reason === 'string' && parsed.reason
          ? parsed.reason
          : 'unknown',
      detail: typeof parsed.detail === 'string' ? parsed.detail : '',
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
    };
  } catch {
    return buildDefaultProbeState();
  }
}

export function setAssistantExecutionProbeState(
  state: AssistantExecutionProbeState,
): void {
  setRouterState(
    ASSISTANT_EXECUTION_PROBE_ROUTER_STATE_KEY,
    JSON.stringify(state),
  );
}

function formatOverrideLine(scope: string, config: LogControlConfig): string {
  const override = config.scopedOverrides[scope];
  if (!override) return '';
  return `- ${scope}: ${override.level} (expires ${override.expiresAt || 'never'}, set by ${override.updatedBy})`;
}

export function formatDebugStatus(): string {
  const config = readPersistedLogControlConfig();
  const probe = getAssistantExecutionProbeState();
  const scopes = Object.keys(config.scopedOverrides).sort();
  const hostSnapshot = readHostControlSnapshot();
  const commitTruth = buildRuntimeCommitTruth({
    runtimeAuditState: hostSnapshot.runtimeAuditState,
  });
  const alexaLastSignedRequest = readAlexaLastSignedRequestState();
  const windowsHost =
    process.platform === 'win32' ? reconcileWindowsHostState() : null;
  const fieldTrialTruth = buildFieldTrialOperatorTruth({
    hostSnapshot,
    windowsHost,
  });
  const installedMode =
    process.platform === 'win32'
      ? formatInstallModeLabel(
          detectWindowsInstallMode(detectWindowsInstallArtifacts()),
        )
      : formatInstallModeLabel(hostSnapshot.hostState?.installMode);
  const hostServiceState =
    windowsHost?.serviceState ||
    determineWindowsHostServiceState({
      hostState: hostSnapshot.hostState,
      readyState: hostSnapshot.readyState,
      processRunning: false,
    });

  return [
    '*Debug Status*',
    `- Global log level: ${config.globalLevel}`,
    `- Assistant execution probe: ${probe.status}${probe.reason ? ` (${probe.reason})` : ''}`,
    ...(probe.checkedAt ? [`- Last execution probe: ${probe.checkedAt}`] : []),
    ...(probe.detail ? [`- Probe detail: ${probe.detail}`] : []),
    `- Host state: ${hostServiceState}`,
    `- Installed artifact mode: ${installedMode}`,
    `- Current launch mode: ${formatInstallModeLabel(
      windowsHost?.activeLaunchMode || hostSnapshot.hostState?.installMode,
    )}`,
    `- Host dependency: ${windowsHost?.dependencyState || hostSnapshot.hostState?.dependencyState || 'unknown'}`,
    ...(windowsHost?.dependencyError
      ? [`- Host dependency detail: ${windowsHost.dependencyError}`]
      : []),
    `- Active repo root: ${commitTruth.activeRepoRoot}`,
    `- Workspace repo root: ${commitTruth.workspaceRepoRoot}`,
    `- Serving git branch: ${commitTruth.activeGitBranch}`,
    `- Serving git commit: ${commitTruth.activeGitCommit}`,
    `- Workspace branch: ${commitTruth.workspaceGitBranch}`,
    `- Workspace HEAD: ${commitTruth.workspaceGitCommit}`,
    `- Serving commit aligned: ${commitTruth.servingCommitMatchesWorkspaceHead ? 'yes' : 'no'}`,
    `- Telegram proof: ${fieldTrialTruth.telegram.proofState}`,
    `- Telegram proof detail: ${fieldTrialTruth.telegram.detail}`,
    ...(fieldTrialTruth.telegram.blocker
      ? [`- Telegram blocker: ${fieldTrialTruth.telegram.blocker}`]
      : []),
    ...(fieldTrialTruth.telegram.nextAction
      ? [`- Telegram next step: ${fieldTrialTruth.telegram.nextAction}`]
      : []),
    `- Alexa proof: ${fieldTrialTruth.alexa.proofState}`,
    `- Alexa last signed request: ${alexaLastSignedRequest?.requestType || 'none'}`,
    ...(alexaLastSignedRequest?.updatedAt
      ? [`- Alexa last signed at: ${alexaLastSignedRequest.updatedAt}`]
      : []),
    ...(fieldTrialTruth.alexa.blocker
      ? [`- Alexa blocker: ${fieldTrialTruth.alexa.blocker}`]
      : []),
    ...(fieldTrialTruth.alexa.nextAction
      ? [`- Alexa next step: ${fieldTrialTruth.alexa.nextAction}`]
      : []),
    `- BlueBubbles proof: ${fieldTrialTruth.bluebubbles.proofState}`,
    `- BlueBubbles proof detail: ${fieldTrialTruth.bluebubbles.detail}`,
    ...(fieldTrialTruth.bluebubbles.blocker
      ? [`- BlueBubbles blocker: ${fieldTrialTruth.bluebubbles.blocker}`]
      : []),
    ...(fieldTrialTruth.bluebubbles.nextAction
      ? [`- BlueBubbles next step: ${fieldTrialTruth.bluebubbles.nextAction}`]
      : []),
    `- Outward research proof: ${fieldTrialTruth.research.proofState}`,
    `- Outward research detail: ${fieldTrialTruth.research.detail}`,
    ...(fieldTrialTruth.research.blocker
      ? [`- Outward research blocker: ${fieldTrialTruth.research.blocker}`]
      : []),
    ...(fieldTrialTruth.research.nextAction
      ? [`- Outward research next step: ${fieldTrialTruth.research.nextAction}`]
      : []),
    `- Image generation proof: ${fieldTrialTruth.imageGeneration.proofState}`,
    `- Image generation detail: ${fieldTrialTruth.imageGeneration.detail}`,
    ...(fieldTrialTruth.imageGeneration.blocker
      ? [`- Image generation blocker: ${fieldTrialTruth.imageGeneration.blocker}`]
      : []),
    ...(fieldTrialTruth.imageGeneration.nextAction
      ? [`- Image generation next step: ${fieldTrialTruth.imageGeneration.nextAction}`]
      : []),
    ...(hostSnapshot.nodeRuntime
      ? [
          `- Pinned Node: ${hostSnapshot.nodeRuntime.version}`,
          `- Pinned Node path: ${hostSnapshot.nodeRuntime.nodePath}`,
        ]
      : []),
    ...(windowsHost?.launcherError
      ? [`- Host failure: ${windowsHost.launcherError}`]
      : []),
    `- Host log path: ${hostSnapshot.paths.hostLogPath}`,
    scopes.length > 0
      ? '- Active scoped overrides:'
      : '- Active scoped overrides: none',
    ...scopes.map((scope) => formatOverrideLine(scope, config)).filter(Boolean),
  ].join('\n');
}

export function buildDebugStatusInlineActions(): NonNullable<
  SendMessageOptions['inlineActions']
> {
  return [
    { label: 'Refresh', actionId: '/debug-status' },
    { label: 'Current Logs', actionId: '/debug-logs current 120' },
    { label: 'Host Logs', actionId: '/debug-logs host 120' },
    { label: 'Debug Chat 10m', actionId: '/debug-level debug chat 10m' },
    { label: 'Reset All', actionId: '/debug-reset all' },
  ];
}

export function buildDebugMutationInlineActions(): NonNullable<
  SendMessageOptions['inlineActions']
> {
  return [
    { label: 'Debug Status', actionId: '/debug-status' },
    { label: 'Current Logs', actionId: '/debug-logs current 120' },
    { label: 'Host Logs', actionId: '/debug-logs host 120' },
    { label: 'Reset All', actionId: '/debug-reset all' },
  ];
}

export function buildDebugLogsInlineActions(
  target = 'current',
  lines = 120,
): NonNullable<SendMessageOptions['inlineActions']> {
  const safeTarget = (target || 'current').trim() || 'current';
  const safeLines = Math.max(1, Math.min(MAX_DEBUG_LOG_LINES, lines));
  return [
    {
      label: 'Refresh Logs',
      actionId: `/debug-logs ${safeTarget} ${safeLines}`,
    },
    { label: 'Debug Status', actionId: '/debug-status' },
    { label: 'Reset All', actionId: '/debug-reset all' },
  ];
}

function tailLines(lines: string[], maxLines: number): string[] {
  return lines.slice(Math.max(0, lines.length - maxLines));
}

function findLatestContainerLog(groupFolder: string): string | null {
  const logsDir = path.join(resolveGroupFolderPath(groupFolder), 'logs');
  if (!fs.existsSync(logsDir)) return null;

  const candidates = fs
    .readdirSync(logsDir)
    .filter((entry) => entry.startsWith('container-') && entry.endsWith('.log'))
    .sort();
  if (candidates.length === 0) return null;
  return path.join(logsDir, candidates[candidates.length - 1]);
}

function readLogLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split(/\r?\n/)
    .map((line) => sanitizeLogString(line))
    .filter(Boolean);
}

function splitLogEntries(lines: string[]): string[] {
  const entries: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(line) && current.length > 0) {
      entries.push(current.join('\n'));
      current = [line];
      continue;
    }
    current.push(line);
  }

  if (current.length > 0) {
    entries.push(current.join('\n'));
  }

  return entries;
}

function filterLogEntriesByTokens(lines: string[], tokens: string[]): string[] {
  if (tokens.length === 0) return lines;
  const normalizedTokens = tokens
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  if (normalizedTokens.length === 0) return lines;

  return splitLogEntries(lines)
    .filter((entry) => {
      const normalizedEntry = entry.toLowerCase();
      return normalizedTokens.some((token) => normalizedEntry.includes(token));
    })
    .flatMap((entry) => entry.split('\n'));
}

function truncateForTelegram(value: string, maxChars = 3500): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(value.length - maxChars)}\n[trimmed to last ${maxChars} chars]`;
}

export function readDebugLogs(params: {
  target?: string;
  lines?: number;
  chatJid?: string;
  groupFolder?: string;
  containerName?: string | null;
}): { title: string; body: string } {
  const target = (params.target || 'service').trim().toLowerCase();
  const lineCount = Math.max(
    1,
    Math.min(MAX_DEBUG_LOG_LINES, params.lines || 80),
  );

  if (target === 'service') {
    const lines = tailLines(
      readLogLines(path.join(getLogsDir(), 'nanoclaw.log')),
      lineCount,
    );
    return {
      title: 'service',
      body:
        lines.length > 0
          ? truncateForTelegram(lines.join('\n'))
          : 'No service log lines found.',
    };
  }

  if (target === 'stderr') {
    const preferredPath = path.join(getLogsDir(), 'nanoclaw.error.log');
    const legacyPath = path.join(getLogsDir(), 'nanoclaw.stderr.log');
    const stderrLines = readLogLines(preferredPath);
    const lines = tailLines(
      stderrLines.length > 0 ? stderrLines : readLogLines(legacyPath),
      lineCount,
    );
    return {
      title: 'stderr',
      body:
        lines.length > 0
          ? truncateForTelegram(lines.join('\n'))
          : 'No stderr log lines found.',
    };
  }

  if (target === 'host') {
    const lines = tailLines(
      readLogLines(path.join(getLogsDir(), 'nanoclaw.host.log')),
      lineCount,
    );
    return {
      title: 'host',
      body:
        lines.length > 0
          ? truncateForTelegram(lines.join('\n'))
          : 'No host-control log lines found.',
    };
  }

  if (target === 'current') {
    const serviceLines = tailLines(
      filterLogEntriesByTokens(
        readLogLines(path.join(getLogsDir(), 'nanoclaw.log')),
        [
          params.chatJid || '',
          params.groupFolder || '',
          params.containerName || '',
        ],
      ),
      lineCount,
    );
    if (serviceLines.length > 0) {
      return {
        title: 'current',
        body: truncateForTelegram(serviceLines.join('\n')),
      };
    }

    if (params.groupFolder) {
      const latestContainerLog = findLatestContainerLog(params.groupFolder);
      if (latestContainerLog) {
        const lines = tailLines(readLogLines(latestContainerLog), lineCount);
        return {
          title: `current (${path.basename(latestContainerLog)})`,
          body:
            lines.length > 0
              ? truncateForTelegram(lines.join('\n'))
              : 'No current container log lines found.',
        };
      }
    }

    return {
      title: 'current',
      body: 'No current chat log lines were found.',
    };
  }

  if (target === 'cursor' || target === 'runtime') {
    const keywords =
      target === 'cursor'
        ? ['cursor', 'lane:cursor', '"laneId":"cursor"']
        : ['runtime', 'andrea_runtime', 'codex/openai', 'lane:andrea_runtime'];
    const lines = tailLines(
      filterLogEntriesByTokens(
        readLogLines(path.join(getLogsDir(), 'nanoclaw.log')),
        keywords,
      ),
      lineCount,
    );
    return {
      title: target,
      body:
        lines.length > 0
          ? truncateForTelegram(lines.join('\n'))
          : `No ${target} log lines were found.`,
    };
  }

  throw new Error(
    'Log target must be service, stderr, host, current, cursor, or runtime.',
  );
}
