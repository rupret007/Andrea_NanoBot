import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ANDREA_OPENCLAW_AGENT_DELEGATION,
  ANDREA_OPENCLAW_ENABLED,
  OPENCLAW_AGENT_ID,
  OPENCLAW_CLI,
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_STATUS_TIMEOUT_MS,
} from './config.js';

export type OpenClawGatewayState = 'disabled' | 'live' | 'degraded' | 'offline';

export interface OpenClawConnectorConfig {
  enabled: boolean;
  delegationEnabled: boolean;
  gatewayUrl: string;
  cli: string;
  agentId: string;
  statusTimeoutMs: number;
}

export interface OpenClawStatusSummary {
  enabled: boolean;
  gatewayUrl: string;
  cli: string;
  gatewayState: OpenClawGatewayState;
  gatewayReachable: boolean | null;
  cliAvailable: boolean;
  detail: string;
  version: string | null;
  pid: number | null;
  serviceState: string | null;
  defaultModel: string | null;
  authUsable: boolean | null;
  authProviders: string[];
  errors: string[];
}

export interface OpenClawDelegationResult {
  ok: boolean;
  reply: string;
  detail: string;
  agentId: string;
}

export type OpenClawDelegationCommand = 'slash' | 'natural' | 'mention';

export type OpenClawDelegationResponseStyle = 'mention' | 'operator';

export type OpenClawDelegationRoute =
  | { action: 'none' }
  | {
      action: 'fallthrough';
      request: { prompt: string; command: OpenClawDelegationCommand };
    }
  | {
      action: 'restrict';
      request: { prompt: string; command: OpenClawDelegationCommand };
    }
  | {
      action: 'delegate';
      request: { prompt: string; command: OpenClawDelegationCommand };
    };

export function buildOpenClawMediaGroundedPrompt(params: {
  prompt: string;
  mediaSummary?: string | null;
  mediaBlocker?: string | null;
}): string {
  const prompt = params.prompt.trim();
  const summary = String(params.mediaSummary || '').trim();
  const blocker = String(params.mediaBlocker || '').trim();
  if (!summary && !blocker) return prompt;
  const evidence = summary
    ? [
        'Verified attachment context prepared by Andrea:',
        summary,
        'Use this bounded visual summary as evidence. Do not claim direct access to image bytes.',
      ]
    : [
        'Attachment inspection status:',
        blocker,
        'Be explicit that the attachment could not be inspected; do not infer its contents.',
      ];
  return [prompt, '', ...evidence].join('\n');
}

export type OpenClawSyncRunner = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
) => string;

export type OpenClawAsyncRunner = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number },
) => Promise<string>;

interface OpenClawJsonCommandResult {
  ok: boolean;
  value: unknown | null;
  detail: string;
  cliMissing: boolean;
}

const OPENCLAW_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

function buildOpenClawChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENCLAW_GATEWAY_URL;
  return env;
}

const defaultSyncRunner: OpenClawSyncRunner = (file, args, options) =>
  execFileSync(file, args, {
    ...options,
    env: buildOpenClawChildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const defaultAsyncRunner: OpenClawAsyncRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { ...options, env: buildOpenClawChildEnv() },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });

export function resolveOpenClawConfig(
  overrides: Partial<OpenClawConnectorConfig> = {},
): OpenClawConnectorConfig {
  return {
    enabled: overrides.enabled ?? ANDREA_OPENCLAW_ENABLED,
    delegationEnabled:
      overrides.delegationEnabled ?? ANDREA_OPENCLAW_AGENT_DELEGATION,
    gatewayUrl: overrides.gatewayUrl || OPENCLAW_GATEWAY_URL,
    cli: overrides.cli || OPENCLAW_CLI,
    agentId: overrides.agentId || OPENCLAW_AGENT_ID,
    statusTimeoutMs:
      overrides.statusTimeoutMs || OPENCLAW_STATUS_TIMEOUT_MS || 5000,
  };
}

export function isOpenClawDelegationEnabled(
  overrides: Partial<OpenClawConnectorConfig> = {},
): boolean {
  const config = resolveOpenClawConfig(overrides);
  return config.enabled && config.delegationEnabled;
}

export function parseOpenClawJsonOutput(rawOutput: string): unknown {
  const raw = String(rawOutput || '');
  const start = raw.indexOf('{');
  if (start < 0) {
    throw new Error('OpenClaw output did not include a JSON object.');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(raw.slice(start, i + 1));
      }
    }
  }

  throw new Error('OpenClaw JSON output was incomplete.');
}

export function redactOpenClawText(value: string, maxLength = 500): string {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(
      /\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|AUTHORIZATION|AUTH)[A-Z0-9_]*)\s*=\s*(?!<)[^\s,;]+/g,
      '$1=[redacted]',
    )
    .replace(/\bsk-[A-Za-z0-9._-]{8,}/g, '[redacted]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{12,}/g, '[redacted]')
    .replace(
      /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
      '[redacted]',
    )
    .replace(
      /\b[A-Za-z0-9_-]+:(?:manual|profile)=[^\s,;)"']+/gi,
      '[redacted-profile]',
    )
    .replace(/\b(profile|label)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(
      /\b(api[_-]?key|auth(?:orization)?|bearer|secret|token)\s*[:=]\s*(?!<)[^\s,;]+/gi,
      '$1=[redacted]',
    )
    .slice(0, maxLength);
}

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

function firstString(value: unknown, paths: string[][]): string | null {
  for (const pathParts of paths) {
    const found = readPath(value, pathParts);
    if (typeof found === 'string' && found.trim()) return found.trim();
  }
  return null;
}

function firstBoolean(value: unknown, paths: string[][]): boolean | null {
  for (const pathParts of paths) {
    const found = readPath(value, pathParts);
    if (typeof found === 'boolean') return found;
  }
  return null;
}

function firstNumber(value: unknown, paths: string[][]): number | null {
  for (const pathParts of paths) {
    const found = readPath(value, pathParts);
    if (typeof found === 'number' && Number.isFinite(found)) return found;
  }
  return null;
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
        : 'OpenClaw command failed.';
  const detail = redactOpenClawText(stderr || stdout || message);
  return {
    detail,
    cliMissing: code === 'ENOENT' || /enoent/i.test(message),
  };
}

function runOpenClawJsonCommand(
  config: OpenClawConnectorConfig,
  args: string[],
  runner: OpenClawSyncRunner,
): OpenClawJsonCommandResult {
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

function providerNamesFromAuth(auth: unknown): string[] {
  const providers = new Set<string>();
  const runtimeRoutes = readPath(auth, ['runtimeAuthRoutes']);
  if (Array.isArray(runtimeRoutes)) {
    for (const route of runtimeRoutes) {
      const provider = isRecord(route) ? route.provider : null;
      if (typeof provider === 'string' && provider.trim()) {
        providers.add(provider.trim());
      }
    }
  }
  const providerList = readPath(auth, ['providers']);
  if (Array.isArray(providerList)) {
    for (const route of providerList) {
      const provider = isRecord(route) ? route.provider : null;
      if (typeof provider === 'string' && provider.trim()) {
        providers.add(provider.trim());
      }
    }
  }
  return [...providers].sort();
}

function authUsableFromModels(models: unknown): boolean | null {
  const runtimeRoutes = readPath(models, ['auth', 'runtimeAuthRoutes']);
  if (!Array.isArray(runtimeRoutes) || runtimeRoutes.length === 0) return null;
  return runtimeRoutes.some((route) => {
    if (!isRecord(route)) return false;
    if (route.usable === true) return true;
    return route.status === 'usable';
  });
}

function emptyOpenClawSummary(
  config: OpenClawConnectorConfig,
  state: OpenClawGatewayState,
  detail: string,
): OpenClawStatusSummary {
  return {
    enabled: config.enabled,
    gatewayUrl: config.gatewayUrl,
    cli: config.cli,
    gatewayState: state,
    gatewayReachable: null,
    cliAvailable: true,
    detail: redactOpenClawText(detail),
    version: null,
    pid: null,
    serviceState: null,
    defaultModel: null,
    authUsable: null,
    authProviders: [],
    errors: detail ? [redactOpenClawText(detail)] : [],
  };
}

export function getOpenClawStatusSummary(
  overrides: Partial<OpenClawConnectorConfig> = {},
  runner: OpenClawSyncRunner = defaultSyncRunner,
): OpenClawStatusSummary {
  const config = resolveOpenClawConfig(overrides);
  if (!config.enabled) {
    return emptyOpenClawSummary(config, 'disabled', 'disabled');
  }

  const errors: string[] = [];
  const healthResult = runOpenClawJsonCommand(
    config,
    ['health', '--json'],
    runner,
  );
  if (!healthResult.ok) {
    const detail = healthResult.cliMissing
      ? `OpenClaw CLI not found: ${config.cli}`
      : healthResult.detail || 'OpenClaw gateway health check failed.';
    return {
      ...emptyOpenClawSummary(config, 'offline', detail),
      cliAvailable: !healthResult.cliMissing,
      gatewayReachable: false,
    };
  }

  const healthOk = firstBoolean(healthResult.value, [['ok']]);
  let gatewayState: OpenClawGatewayState =
    healthOk === true ? 'live' : 'degraded';
  let gatewayReachable: boolean | null = healthOk === true;
  let detail =
    healthOk === true
      ? 'OpenClaw health check is ok.'
      : firstString(healthResult.value, [['status'], ['error']]) ||
        'OpenClaw health check is degraded.';

  const statusResult = runOpenClawJsonCommand(
    config,
    ['status', '--json', '--timeout', String(config.statusTimeoutMs)],
    runner,
  );
  if (!statusResult.ok) {
    errors.push(statusResult.detail || 'OpenClaw status command failed.');
    if (gatewayState === 'live') gatewayState = 'degraded';
  }

  const modelsResult = runOpenClawJsonCommand(
    config,
    ['models', 'status', '--json'],
    runner,
  );
  if (!modelsResult.ok) {
    errors.push(modelsResult.detail || 'OpenClaw models status failed.');
    if (gatewayState === 'live') gatewayState = 'degraded';
  }

  const statusJson = statusResult.value;
  const modelsJson = modelsResult.value;
  const statusReachable = firstBoolean(statusJson, [['gateway', 'reachable']]);
  if (statusReachable !== null) {
    gatewayReachable = statusReachable;
    if (!statusReachable) gatewayState = 'offline';
  }

  const serviceState = firstString(statusJson, [
    ['gatewayService', 'runtime', 'status'],
    ['gatewayService', 'runtime', 'state'],
    ['gatewayService', 'loadedText'],
    ['service', 'state'],
  ]);
  const version =
    firstString(statusJson, [
      ['gateway', 'self', 'version'],
      ['runtimeVersion'],
      ['version'],
    ]) || null;
  const pid = firstNumber(statusJson, [
    ['gatewayService', 'runtime', 'pid'],
    ['gatewayService', 'pid'],
    ['service', 'pid'],
    ['pid'],
  ]);
  const defaultModel = firstString(modelsJson, [
    ['defaultModel'],
    ['resolvedDefault'],
  ]);
  const authUsable = authUsableFromModels(modelsJson);
  const authProviders = providerNamesFromAuth(readPath(modelsJson, ['auth']));

  if (gatewayReachable === false) {
    detail =
      firstString(statusJson, [['gateway', 'error']]) ||
      'OpenClaw gateway is unreachable.';
  } else if (errors.length > 0) {
    detail = errors[0];
  }

  return {
    enabled: true,
    gatewayUrl:
      firstString(statusJson, [['gateway', 'url']]) || config.gatewayUrl,
    cli: config.cli,
    gatewayState,
    gatewayReachable,
    cliAvailable: true,
    detail: redactOpenClawText(detail),
    version,
    pid,
    serviceState,
    defaultModel,
    authUsable,
    authProviders,
    errors: errors.map(redactOpenClawText),
  };
}

export function formatOpenClawDebugStatusLines(
  summary: OpenClawStatusSummary,
): string[] {
  if (!summary.enabled) {
    return ['- OpenClaw integration: disabled'];
  }

  const serviceBits = [
    summary.gatewayReachable === true
      ? 'reachable'
      : summary.gatewayReachable === false
        ? 'unreachable'
        : 'reachability unknown',
    summary.serviceState ? `service ${summary.serviceState}` : '',
    summary.pid ? `pid ${summary.pid}` : '',
    summary.version ? `version ${summary.version}` : '',
  ].filter(Boolean);
  const authStatus =
    summary.authUsable === true
      ? 'usable'
      : summary.authUsable === false
        ? 'not usable'
        : 'unknown';
  const authProviders =
    summary.authProviders.length > 0
      ? ` (${summary.authProviders.join(', ')})`
      : '';

  return [
    `- OpenClaw integration: enabled at ${summary.gatewayUrl}`,
    `- OpenClaw gateway: ${summary.gatewayState}${serviceBits.length > 0 ? ` (${serviceBits.join(', ')})` : ''}`,
    ...(summary.defaultModel
      ? [`- OpenClaw default model: ${summary.defaultModel}`]
      : []),
    `- OpenClaw provider auth: ${authStatus}${authProviders}`,
    ...(summary.detail && summary.gatewayState !== 'live'
      ? [`- OpenClaw detail: ${redactOpenClawText(summary.detail)}`]
      : []),
  ];
}

const OPENCLAW_PRESENCE_QUERY_PATTERN =
  /^(?:are you there(?: too)?|you there|are you online|online|status|hi|hello|hey|what'?s up|who are you|what are you)\b/;

const OPENCLAW_SKILL_CATALOG_PATTERN =
  /\b(clawhub|clawskills|community skill|skill catalog|enable skill|disable skill|install skill|search skills|list (?:my |the )?(?:enabled )?skills)\b/i;

export function parseOpenClawDelegationRequest(
  rawMessage: string,
): { prompt: string; command: 'slash' | 'natural' | 'mention' } | null {
  const trimmed = String(rawMessage || '').trim();
  if (!trimmed) return null;

  const slash = trimmed.match(/^\/openclaw(?:@\S+)?(?:\s+([\s\S]+))?$/i);
  if (slash) {
    return { prompt: (slash[1] || '').trim(), command: 'slash' };
  }

  const natural = trimmed.match(
    /^(?:ask|have|tell)\s+openclaw(?:\s+to)?(?:\s*[:,])?\s+([\s\S]+)$/i,
  );
  if (natural) {
    return { prompt: natural[1].trim(), command: 'natural' };
  }

  const mention = trimmed.match(/^@openclaw\b[,:;!?-]*\s*([\s\S]*)$/i);
  if (mention) {
    const prompt = mention[1].trim();
    // Presence pings keep their local canned reply, and skill-catalog work
    // stays in Andrea's advanced-helper container lane; everything else
    // addressed to @openclaw delegates to the OpenClaw gateway.
    if (!prompt || OPENCLAW_PRESENCE_QUERY_PATTERN.test(prompt.toLowerCase())) {
      return null;
    }
    if (OPENCLAW_SKILL_CATALOG_PATTERN.test(prompt)) {
      return null;
    }
    return { prompt, command: 'mention' };
  }

  return null;
}

export function resolveOpenClawDelegationRoute(params: {
  rawMessage: string;
  mainControlChat: boolean;
  delegationEnabled: boolean;
}): OpenClawDelegationRoute {
  const request = parseOpenClawDelegationRequest(params.rawMessage);
  if (!request) {
    return { action: 'none' };
  }

  const mentionFallsThrough =
    request.command === 'mention' &&
    (!params.mainControlChat || !params.delegationEnabled);

  if (mentionFallsThrough) {
    return { action: 'fallthrough', request };
  }

  if (!params.mainControlChat) {
    return { action: 'restrict', request };
  }

  return { action: 'delegate', request };
}

export function buildOpenClawChatSessionKey(
  chatJid: string,
  agentId?: string,
): string {
  const resolvedAgentId = agentId || resolveOpenClawConfig({}).agentId;
  const sanitizedChat =
    String(chatJid || '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default';
  return `agent:${resolvedAgentId}:andrea-chat:${sanitizedChat}`;
}

function extractOpenClawAgentReply(value: unknown): string {
  const direct = firstString(value, [
    ['reply'],
    ['message'],
    ['text'],
    ['output'],
    ['content'],
    ['response', 'reply'],
    ['response', 'text'],
    ['result', 'reply'],
    ['result', 'text'],
    ['result', 'message'],
    ['result', 'meta', 'finalAssistantVisibleText'],
    ['result', 'meta', 'finalAssistantRawText'],
  ]);
  if (direct) return direct;

  const payloads = readPath(value, ['result', 'payloads']);
  if (Array.isArray(payloads)) {
    const parts = payloads
      .map((payload) =>
        isRecord(payload) && typeof payload.text === 'string'
          ? payload.text
          : '',
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  const content = readPath(value, ['result', 'content']);
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        isRecord(part) && typeof part.text === 'string' ? part.text : '',
      )
      .filter(Boolean);
    if (parts.length > 0) return parts.join('\n');
  }

  return '';
}

function formatOpenClawDelegationErrorDetail(detail: string): string {
  const redacted = redactOpenClawText(detail);
  if (/CLI not found/i.test(detail)) {
    return `${redacted} Set OPENCLAW_CLI to your openclaw binary path (try \`which openclaw\`).`;
  }
  if (
    /gateway is not reachable|gateway health check failed|ECONNREFUSED/i.test(
      detail,
    )
  ) {
    return `${redacted} Run \`openclaw health\` to diagnose the gateway.`;
  }
  if (/timed out|ETIMEDOUT|timeout/i.test(detail)) {
    return 'OpenClaw took too long; try a shorter question or retry.';
  }
  return redacted;
}

export async function delegateToOpenClawAgent(params: {
  message: string;
  config?: Partial<OpenClawConnectorConfig>;
  runner?: OpenClawAsyncRunner;
  statusRunner?: OpenClawSyncRunner;
  timeoutMs?: number;
  sessionKey?: string;
  skipPreflight?: boolean;
}): Promise<OpenClawDelegationResult> {
  const config = resolveOpenClawConfig(params.config || {});
  const runner = params.runner || defaultAsyncRunner;
  const prompt = String(params.message || '').trim();

  if (!config.enabled) {
    return {
      ok: false,
      reply: '',
      detail: 'OpenClaw integration is disabled.',
      agentId: config.agentId,
    };
  }
  if (!config.delegationEnabled) {
    return {
      ok: false,
      reply: '',
      detail: 'OpenClaw agent delegation is disabled.',
      agentId: config.agentId,
    };
  }
  if (!prompt) {
    return {
      ok: false,
      reply: '',
      detail: 'OpenClaw needs a message to delegate.',
      agentId: config.agentId,
    };
  }

  if (!params.skipPreflight) {
    const summary = getOpenClawStatusSummary(
      config,
      params.statusRunner || defaultSyncRunner,
    );
    if (summary.gatewayState !== 'live') {
      const detail =
        summary.gatewayState === 'offline'
          ? 'OpenClaw gateway is not reachable; run openclaw health.'
          : summary.detail ||
            `OpenClaw gateway is not ready (${summary.gatewayState}).`;
      return {
        ok: false,
        reply: '',
        detail,
        agentId: config.agentId,
      };
    }
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'andrea-openclaw-'));
  const messageFile = path.join(tempDir, 'message.txt');
  try {
    await fs.writeFile(messageFile, prompt, 'utf8');
    const stdout = await runner(
      config.cli,
      [
        'agent',
        '--json',
        '--agent',
        config.agentId,
        '--session-key',
        params.sessionKey?.trim() || `agent:${config.agentId}:andrea-bridge`,
        '--message-file',
        messageFile,
      ],
      {
        encoding: 'utf8',
        timeout: params.timeoutMs || OPENCLAW_AGENT_TIMEOUT_MS,
      },
    );
    const parsed = parseOpenClawJsonOutput(stdout);
    const reply = extractOpenClawAgentReply(parsed);
    if (!reply) {
      return {
        ok: false,
        reply: '',
        detail: 'OpenClaw agent response did not include reply text.',
        agentId: config.agentId,
      };
    }
    return {
      ok: true,
      reply,
      detail: 'OpenClaw agent replied.',
      agentId: config.agentId,
    };
  } catch (err) {
    const { detail, cliMissing } = readCommandErrorDetail(err);
    return {
      ok: false,
      reply: '',
      detail: cliMissing
        ? `OpenClaw CLI not found: ${config.cli}`
        : detail || 'OpenClaw agent delegation failed.',
      agentId: config.agentId,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function formatOpenClawDelegationResponse(
  result: OpenClawDelegationResult,
  style: OpenClawDelegationResponseStyle = 'operator',
): string {
  if (!result.ok) {
    return `OpenClaw delegation is unavailable: ${formatOpenClawDelegationErrorDetail(result.detail)}`;
  }
  if (style === 'mention') {
    return result.reply.trim();
  }
  return ['OpenClaw answered through Andrea:', '', result.reply.trim()].join(
    '\n',
  );
}
