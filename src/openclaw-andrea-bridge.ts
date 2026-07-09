import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

import { readEnvFile } from './env.js';
import {
  getOpenClawStatusSummary,
  parseOpenClawJsonOutput,
  redactOpenClawText,
  resolveOpenClawConfig,
  type OpenClawConnectorConfig,
  type OpenClawStatusSummary,
  type OpenClawSyncRunner,
} from './openclaw-connector.js';

export const ANDREA_BLUEBUBBLES_MCP_SERVER_NAME = 'andrea-bluebubbles';

export const ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS = [
  'bluebubbles_status',
  'bluebubbles_proof',
  'bluebubbles_doctor',
  'bluebubbles_list_chats',
  'bluebubbles_get_messages',
  'bluebubbles_get_media_metadata',
  'bluebubbles_analyze_media',
  'bluebubbles_open_message_actions',
  'bluebubbles_refresh',
  'bluebubbles_start_proof_drill',
  'bluebubbles_execute_message_action',
] as const;

export const ANDREA_BLUEBUBBLES_MCP_EXCLUDED_TOOLS = [
  'bluebubbles_send',
] as const;

const BLUEBUBBLES_BRIDGE_ENV_KEYS = [
  'BLUEBUBBLES_CONTROL_API_ENABLED',
  'BLUEBUBBLES_CONTROL_HOST',
  'BLUEBUBBLES_CONTROL_PORT',
  'BLUEBUBBLES_CONTROL_BASE_URL',
  'BLUEBUBBLES_CONTROL_TOKEN',
] as const;

export const ANDREA_BLUEBUBBLES_REQUIRED_ENV_VALUES = [
  'BLUEBUBBLES_CONTROL_API_ENABLED=true',
  'BLUEBUBBLES_CONTROL_HOST=127.0.0.1',
  'BLUEBUBBLES_CONTROL_PORT=4315',
  'BLUEBUBBLES_CONTROL_BASE_URL=http://127.0.0.1:4315',
  'BLUEBUBBLES_CONTROL_TOKEN=<local random token>',
] as const;

export type OpenClawAndreaBridgeState =
  | 'disabled'
  | 'offline'
  | 'configured'
  | 'degraded'
  | 'live';

export type OpenClawAndreaBridgeRegistrationState =
  | 'registered'
  | 'missing'
  | 'unknown';

export interface AndreaBlueBubblesMcpConfig {
  command: 'node';
  args: string[];
  cwd: string;
  include: string[];
  exclude: string[];
}

export interface BlueBubblesBridgeEnvStatus {
  configured: boolean;
  apiEnabled: boolean;
  localOnly: boolean;
  host: string | null;
  port: number | null;
  baseUrl: string | null;
  tokenPresent: boolean;
  missingValues: string[];
  detail: string;
  requiredValues: string[];
}

export interface BlueBubblesControlHealthSummary {
  checked: boolean;
  reachable: boolean | null;
  ok: boolean | null;
  statusCode: number | null;
  connected: boolean | null;
  proofState: string | null;
  detail: string;
}

export interface OpenClawAndreaBridgeStatusSummary {
  enabled: boolean;
  serverName: string;
  state: OpenClawAndreaBridgeState;
  registrationState: OpenClawAndreaBridgeRegistrationState;
  registrationMatchesExpected: boolean | null;
  openClawGatewayState: OpenClawStatusSummary['gatewayState'];
  openClawGatewayReachable: boolean | null;
  openClawCliAvailable: boolean;
  mcpToolCount: number;
  requiredToolCount: number;
  requiredToolsAvailable: boolean;
  missingTools: string[];
  directSendExposed: boolean;
  probeOk: boolean | null;
  blocker: string | null;
  detail: string;
  controlEnv: BlueBubblesBridgeEnvStatus;
  controlHealth: BlueBubblesControlHealthSummary;
}

interface ResolvedBlueBubblesBridgeEnv {
  status: BlueBubblesBridgeEnvStatus;
  token: string;
}

interface OpenClawBridgeCommandResult {
  ok: boolean;
  value: unknown | null;
  detail: string;
  cliMissing: boolean;
}

type BlueBubblesControlHealthProbe = (
  env: ResolvedBlueBubblesBridgeEnv,
  timeoutMs: number,
) => Promise<BlueBubblesControlHealthSummary>;

function buildOpenClawChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_GATEWAY_URL;
  return env;
}

const defaultOpenClawRunner: OpenClawSyncRunner = (file, args, options) =>
  execFileSync(file, args, {
    ...options,
    env: buildOpenClawChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readPath(value: unknown, pathParts: string[]): unknown {
  let current = value;
  for (const part of pathParts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseBoolean(value: string): boolean {
  return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

function parsePort(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function isLocalBaseUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

function readCommandErrorDetail(err: unknown): {
  detail: string;
  cliMissing: boolean;
} {
  const record = isRecord(err) ? err : {};
  const code = typeof record.code === 'string' ? record.code : '';
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'OpenClaw bridge command failed.';
  return {
    detail: redactOpenClawText(stderr || stdout || message),
    cliMissing: code === 'ENOENT' || /enoent/i.test(message),
  };
}

function runOpenClawBridgeJsonCommand(
  config: OpenClawConnectorConfig,
  args: string[],
  runner: OpenClawSyncRunner,
): OpenClawBridgeCommandResult {
  try {
    const stdout = runner(config.cli, args, {
      encoding: 'utf8',
      timeout: Math.max(config.statusTimeoutMs + 5000, 10000),
    });
    return {
      ok: true,
      value: parseOpenClawJsonOutput(stdout),
      detail: '',
      cliMissing: false,
    };
  } catch (err) {
    const { detail, cliMissing } = readCommandErrorDetail(err);
    return {
      ok: false,
      value: null,
      detail,
      cliMissing,
    };
  }
}

export function buildAndreaBlueBubblesMcpConfig(
  repoRoot = process.cwd(),
): AndreaBlueBubblesMcpConfig {
  return {
    command: 'node',
    args: [
      'scripts/run-with-pinned-node.mjs',
      './node_modules/tsx/dist/cli.mjs',
      'src/bluebubbles-control-mcp.ts',
    ],
    cwd: repoRoot,
    include: [...ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS],
    exclude: [...ANDREA_BLUEBUBBLES_MCP_EXCLUDED_TOOLS],
  };
}

export function buildAndreaBlueBubblesMcpSetConfig(
  config: AndreaBlueBubblesMcpConfig,
): Pick<AndreaBlueBubblesMcpConfig, 'args' | 'command' | 'cwd'> {
  return {
    command: config.command,
    args: [...config.args],
    cwd: config.cwd,
  };
}

function resolveBlueBubblesBridgeEnv(
  envOverrides?: Record<string, string | undefined>,
): ResolvedBlueBubblesBridgeEnv {
  const fileEnv =
    envOverrides === undefined
      ? readEnvFile([...BLUEBUBBLES_BRIDGE_ENV_KEYS])
      : {};
  const valueFor = (key: (typeof BLUEBUBBLES_BRIDGE_ENV_KEYS)[number]) =>
    toTrimmedString(
      envOverrides === undefined
        ? process.env[key] || fileEnv[key]
        : envOverrides[key],
    );
  const apiEnabled = parseBoolean(valueFor('BLUEBUBBLES_CONTROL_API_ENABLED'));
  const host = valueFor('BLUEBUBBLES_CONTROL_HOST') || null;
  const port = parsePort(valueFor('BLUEBUBBLES_CONTROL_PORT'));
  const baseUrl = normalizeBaseUrl(valueFor('BLUEBUBBLES_CONTROL_BASE_URL'));
  const token = valueFor('BLUEBUBBLES_CONTROL_TOKEN');
  const tokenPresent = token.length > 0;
  const missingValues: string[] = [];

  if (!apiEnabled) {
    missingValues.push('BLUEBUBBLES_CONTROL_API_ENABLED=true');
  }
  if (host !== '127.0.0.1') {
    missingValues.push('BLUEBUBBLES_CONTROL_HOST=127.0.0.1');
  }
  if (!port) {
    missingValues.push('BLUEBUBBLES_CONTROL_PORT=4315');
  }
  if (!baseUrl || !isLocalBaseUrl(baseUrl)) {
    missingValues.push('BLUEBUBBLES_CONTROL_BASE_URL=http://127.0.0.1:4315');
  }
  if (!tokenPresent) {
    missingValues.push('BLUEBUBBLES_CONTROL_TOKEN=<local random token>');
  }

  const configured = missingValues.length === 0;
  return {
    token,
    status: {
      configured,
      apiEnabled,
      localOnly: host === '127.0.0.1' && isLocalBaseUrl(baseUrl),
      host,
      port,
      baseUrl,
      tokenPresent,
      missingValues,
      detail: configured
        ? 'BlueBubbles control API env is configured for local bridge use.'
        : `BlueBubbles external config missing: ${missingValues.join(', ')}`,
      requiredValues: [...ANDREA_BLUEBUBBLES_REQUIRED_ENV_VALUES],
    },
  };
}

export function resolveBlueBubblesBridgeEnvStatus(
  envOverrides?: Record<string, string | undefined>,
): BlueBubblesBridgeEnvStatus {
  return resolveBlueBubblesBridgeEnv(envOverrides).status;
}

function extractMcpServerConfig(value: unknown, serverName: string): unknown {
  if (!isRecord(value)) return null;
  if (value[serverName]) return value[serverName];
  const servers = readPath(value, ['servers']);
  if (isRecord(servers) && servers[serverName]) return servers[serverName];
  const mcpServers = readPath(value, ['mcp', 'servers']);
  if (isRecord(mcpServers) && mcpServers[serverName]) {
    return mcpServers[serverName];
  }
  return null;
}

function sameStringArray(left: unknown, right: string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((item, index) => item === right[index]);
}

function mcpServerMatchesExpected(
  value: unknown,
  expected: AndreaBlueBubblesMcpConfig,
): boolean {
  if (!isRecord(value)) return false;
  return (
    value.command === expected.command &&
    value.cwd === expected.cwd &&
    sameStringArray(value.args, expected.args)
  );
}

function collectToolNames(value: unknown): string[] {
  const names = new Set<string>();
  const recordToolName = (rawName: string): void => {
    const name = rawName.includes('__')
      ? rawName.slice(rawName.lastIndexOf('__') + 2)
      : rawName;
    if (name.startsWith('bluebubbles_')) names.add(name);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) {
      if (typeof node === 'string') {
        recordToolName(node);
      }
      return;
    }
    if (typeof node.name === 'string') {
      recordToolName(node.name);
    }
    const tools = node.tools;
    if (Array.isArray(tools)) {
      for (const tool of tools) visit(tool);
    } else if (isRecord(tools)) {
      for (const [toolName, toolValue] of Object.entries(tools)) {
        recordToolName(toolName);
        visit(toolValue);
      }
    }
    for (const value of Object.values(node)) {
      if (value !== tools) visit(value);
    }
  };
  visit(value);
  return [...names].sort();
}

function buildDefaultHealthSummary(
  detail: string,
): BlueBubblesControlHealthSummary {
  return {
    checked: false,
    reachable: null,
    ok: null,
    statusCode: null,
    connected: null,
    proofState: null,
    detail: redactOpenClawText(detail),
  };
}

export function getOpenClawAndreaBridgeStatusSummary(
  params: {
    repoRoot?: string;
    config?: Partial<OpenClawConnectorConfig>;
    runner?: OpenClawSyncRunner;
    openClawSummary?: OpenClawStatusSummary;
    env?: Record<string, string | undefined>;
  } = {},
): OpenClawAndreaBridgeStatusSummary {
  const runner = params.runner || defaultOpenClawRunner;
  const openClawConfig = resolveOpenClawConfig(params.config || {});
  const expectedConfig = buildAndreaBlueBubblesMcpConfig(
    params.repoRoot || process.cwd(),
  );
  const controlEnv = resolveBlueBubblesBridgeEnv(params.env);
  const openClawSummary =
    params.openClawSummary ||
    getOpenClawStatusSummary(params.config || {}, runner);
  const base = {
    enabled: openClawSummary.enabled,
    serverName: ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
    registrationState: 'unknown' as OpenClawAndreaBridgeRegistrationState,
    registrationMatchesExpected: null as boolean | null,
    openClawGatewayState: openClawSummary.gatewayState,
    openClawGatewayReachable: openClawSummary.gatewayReachable,
    openClawCliAvailable: openClawSummary.cliAvailable,
    mcpToolCount: 0,
    requiredToolCount: ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.length,
    requiredToolsAvailable: false,
    missingTools: [...ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS],
    directSendExposed: false,
    probeOk: null as boolean | null,
    controlEnv: controlEnv.status,
    controlHealth: buildDefaultHealthSummary('not checked'),
  };

  if (!openClawSummary.enabled) {
    return {
      ...base,
      state: 'disabled',
      blocker: 'OpenClaw integration is disabled.',
      detail: 'OpenClaw integration is disabled.',
    };
  }
  if (
    !openClawSummary.cliAvailable ||
    openClawSummary.gatewayState === 'offline'
  ) {
    const detail = openClawSummary.detail || 'OpenClaw gateway is unavailable.';
    return {
      ...base,
      state: 'offline',
      blocker: redactOpenClawText(detail),
      detail: redactOpenClawText(detail),
    };
  }

  const listResult = runOpenClawBridgeJsonCommand(
    openClawConfig,
    ['mcp', 'list', '--json'],
    runner,
  );
  if (!listResult.ok) {
    const detail = listResult.cliMissing
      ? `OpenClaw CLI not found: ${openClawConfig.cli}`
      : listResult.detail || 'OpenClaw MCP list failed.';
    return {
      ...base,
      state: 'offline',
      blocker: redactOpenClawText(detail),
      detail: redactOpenClawText(detail),
    };
  }

  const registeredConfig = extractMcpServerConfig(
    listResult.value,
    ANDREA_BLUEBUBBLES_MCP_SERVER_NAME,
  );
  if (!registeredConfig) {
    return {
      ...base,
      registrationState: 'missing',
      state: 'offline',
      blocker: 'OpenClaw MCP server andrea-bluebubbles is not registered.',
      detail: 'OpenClaw MCP server andrea-bluebubbles is not registered.',
    };
  }

  const registrationMatchesExpected = mcpServerMatchesExpected(
    registeredConfig,
    expectedConfig,
  );
  if (!controlEnv.status.configured) {
    return {
      ...base,
      registrationState: 'registered',
      registrationMatchesExpected,
      state: 'degraded',
      blocker: controlEnv.status.detail,
      detail: controlEnv.status.detail,
    };
  }
  if (!registrationMatchesExpected) {
    return {
      ...base,
      registrationState: 'registered',
      registrationMatchesExpected,
      state: 'degraded',
      blocker:
        'OpenClaw MCP server andrea-bluebubbles is registered with unexpected command, args, or cwd.',
      detail:
        'OpenClaw MCP server andrea-bluebubbles is registered with unexpected command, args, or cwd.',
    };
  }

  const probeResult = runOpenClawBridgeJsonCommand(
    openClawConfig,
    ['mcp', 'probe', ANDREA_BLUEBUBBLES_MCP_SERVER_NAME, '--json'],
    runner,
  );
  if (!probeResult.ok) {
    const detail = probeResult.detail || 'OpenClaw MCP probe failed.';
    return {
      ...base,
      registrationState: 'registered',
      registrationMatchesExpected,
      state: 'degraded',
      probeOk: false,
      blocker: redactOpenClawText(detail),
      detail: redactOpenClawText(detail),
    };
  }

  const toolNames = collectToolNames(probeResult.value);
  const missingTools = ANDREA_BLUEBUBBLES_MCP_INCLUDED_TOOLS.filter(
    (toolName) => !toolNames.includes(toolName),
  );
  const directSendExposed = toolNames.includes('bluebubbles_send');
  const requiredToolsAvailable =
    missingTools.length === 0 && !directSendExposed;

  if (!requiredToolsAvailable) {
    const detail = directSendExposed
      ? 'OpenClaw MCP probe exposed bluebubbles_send, which is intentionally excluded.'
      : `OpenClaw MCP probe is missing required tools: ${missingTools.join(', ')}`;
    return {
      ...base,
      registrationState: 'registered',
      registrationMatchesExpected,
      mcpToolCount: toolNames.length,
      requiredToolsAvailable,
      missingTools,
      directSendExposed,
      state: 'degraded',
      probeOk: true,
      blocker: detail,
      detail,
    };
  }

  return {
    ...base,
    registrationState: 'registered',
    registrationMatchesExpected,
    mcpToolCount: toolNames.length,
    requiredToolsAvailable: true,
    missingTools: [],
    directSendExposed: false,
    state: 'configured',
    probeOk: true,
    blocker: null,
    detail:
      'OpenClaw MCP server is registered, filtered, and exposes Andrea BlueBubbles tools.',
  };
}

function parseHealthPayload(payload: unknown): {
  ok: boolean | null;
  connected: boolean | null;
  proofState: string | null;
} {
  const ok = readPath(payload, ['ok']);
  const connected = readPath(payload, ['connected']);
  const proofState =
    readPath(payload, ['bluebubbles', 'proofState']) ||
    readPath(payload, ['status', 'proofState']);
  return {
    ok: typeof ok === 'boolean' ? ok : null,
    connected: typeof connected === 'boolean' ? connected : null,
    proofState: typeof proofState === 'string' ? proofState : null,
  };
}

async function defaultBlueBubblesControlHealthProbe(
  env: ResolvedBlueBubblesBridgeEnv,
  timeoutMs: number,
): Promise<BlueBubblesControlHealthSummary> {
  if (!env.status.configured || !env.status.baseUrl) {
    return {
      ...buildDefaultHealthSummary(env.status.detail),
      detail: env.status.detail,
    };
  }

  const url = new URL('/health', env.status.baseUrl);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.token}`,
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const payload = text ? (JSON.parse(text) as unknown) : {};
            const parsed = parseHealthPayload(payload);
            const ok =
              response.statusCode != null &&
              response.statusCode >= 200 &&
              response.statusCode < 300 &&
              parsed.ok !== false;
            resolve({
              checked: true,
              reachable: true,
              ok,
              statusCode: response.statusCode || null,
              connected: parsed.connected,
              proofState: parsed.proofState,
              detail: ok
                ? 'BlueBubbles control API health is reachable.'
                : `BlueBubbles control API health returned ${response.statusCode || 'unknown status'}.`,
            });
          } catch (err) {
            resolve({
              checked: true,
              reachable: true,
              ok: false,
              statusCode: response.statusCode || null,
              connected: null,
              proofState: null,
              detail: redactOpenClawText(
                err instanceof Error ? err.message : String(err),
              ),
            });
          }
        });
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error('BlueBubbles control API health timed out.'));
    });
    request.on('error', (err) => {
      resolve({
        checked: true,
        reachable: false,
        ok: false,
        statusCode: null,
        connected: null,
        proofState: null,
        detail: redactOpenClawText(err.message),
      });
    });
    request.end();
  });
}

export async function getOpenClawAndreaBridgeStatusSummaryWithHealth(
  params: {
    repoRoot?: string;
    config?: Partial<OpenClawConnectorConfig>;
    runner?: OpenClawSyncRunner;
    openClawSummary?: OpenClawStatusSummary;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
    controlHealthProbe?: BlueBubblesControlHealthProbe;
  } = {},
): Promise<OpenClawAndreaBridgeStatusSummary> {
  const status = getOpenClawAndreaBridgeStatusSummary(params);
  if (status.state !== 'configured') {
    return status;
  }

  const env = resolveBlueBubblesBridgeEnv(params.env);
  const probe =
    params.controlHealthProbe || defaultBlueBubblesControlHealthProbe;
  const controlHealth = await probe(env, params.timeoutMs || 5000);
  if (controlHealth.ok === true && controlHealth.reachable === true) {
    return {
      ...status,
      state: 'live',
      controlHealth,
      detail:
        'OpenClaw MCP bridge is live and BlueBubbles control API health is reachable.',
    };
  }
  return {
    ...status,
    state: 'degraded',
    controlHealth,
    blocker: controlHealth.detail,
    detail: controlHealth.detail,
  };
}

export function formatOpenClawAndreaBridgeDebugStatusLines(
  summary: OpenClawAndreaBridgeStatusSummary,
): string[] {
  if (!summary.enabled || summary.state === 'disabled') {
    return ['- OpenClaw Andrea bridge: disabled'];
  }

  const lines = [
    `- OpenClaw Andrea bridge: ${summary.state} (${summary.serverName})`,
    `- OpenClaw Andrea bridge MCP tools: ${summary.mcpToolCount}/${summary.requiredToolCount} required available`,
  ];
  if (summary.controlHealth.checked) {
    lines.push(
      `- OpenClaw Andrea bridge control API: ${
        summary.controlHealth.ok === true
          ? 'healthy'
          : summary.controlHealth.reachable === false
            ? 'unreachable'
            : 'degraded'
      }`,
    );
  }
  if (summary.blocker) {
    lines.push(
      `- OpenClaw Andrea bridge blocker: ${redactOpenClawText(
        summary.blocker,
      )}`,
    );
  }
  return lines;
}
