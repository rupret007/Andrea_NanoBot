/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, spawn, spawnSync } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  AGENT_RUNTIME_DEFAULT,
  CONTAINER_IMAGE,
  CONTAINER_INITIAL_OUTPUT_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  RUNTIME_STATE_DIR,
  TIMEZONE,
} from './config.js';
import {
  getAssistantCapabilityLane,
  getAssistantSessionHomeFlavor,
} from './assistant-session.js';
import type { ContainerIpcContext } from './container-ipc-auth.js';
import { listEnabledCommunitySkillsForGroup } from './db.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { isLogLevelEnabled, logger, sanitizeLogString } from './logger.js';
import {
  CONTAINER_RUNTIME_BIN,
  CONTAINER_RUNTIME_NAME,
  getContainerRuntimeHostAlias,
  hostGatewayArgs,
  normalizeRuntimeArgs,
  readonlyMountArgs,
  stopContainer,
  writableMountArgs,
} from './container-runtime.js';
import { OneCLI } from '@onecli-sh/sdk';
import { validateAdditionalMounts } from './mount-security.js';
import { AgentRuntimeName, RegisteredGroup, RuntimeRoute } from './types.js';
import {
  normalizeAssistantRequestPolicy,
  type AssistantRequestPolicy,
} from './assistant-routing.js';
import {
  DEFAULT_MINIMAX_ANTHROPIC_BASE_URL,
  DEFAULT_MINIMAX_MODEL_COMPLEX,
  DEFAULT_MINIMAX_OPENAI_BASE_URL,
} from './minimax-provider.js';
import {
  CONTAINER_CLOSE_GRACE_PERIOD_MS,
  resolveEffectiveIdleTimeout,
} from './runtime-timeout.js';
import {
  collapseRuntimeToolEvidenceV1,
  mergeRuntimeToolEvidenceV1,
  normalizeRuntimeToolEvidenceV1,
} from './runtime-tool-evidence.js';
import type { RuntimeToolEvidenceV1 } from './runtime-tool-evidence.js';

const onecli = new OneCLI({ url: ONECLI_URL });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  freshSessionHome?: boolean;
  preferredRuntime?: AgentRuntimeName;
  fallbackRuntime?: AgentRuntimeName;
  runtimeRoute?: RuntimeRoute;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  requestPolicy?: AssistantRequestPolicy;
  idleTimeoutMs?: number;
  ipcRunId?: string;
  ipcAuthToken?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  runtime?: AgentRuntimeName;
  error?: string;
  logFile?: string;
  failureKind?:
    | 'auth_failed'
    | 'invalid_model_alias'
    | 'unsupported_endpoint'
    | 'insufficient_quota'
    | 'initial_output_timeout'
    | 'runtime_bootstrap_failed'
    | 'container_runtime_unavailable'
    | 'credentials_missing_or_unusable'
    | 'transient_or_unknown';
  failureStage?: 'startup' | 'runtime' | 'shutdown' | 'parse' | 'spawn';
  diagnosticHint?: string;
  stderrTail?: string;
  selectedModel?: string | null;
  endpointMode?: string | null;
  recoveryAttempted?: boolean;
  sawLifecycleOnlyOutput?: boolean;
  firstResultSubtype?: string | null;
  runtimeToolEvidence?: RuntimeToolEvidenceV1;
}

export function assertContainerRuntimeTrustBoundary(runtimeName: string): void {
  // Docker and Podman are covered by the isolated nested-overlay canary. The
  // Apple `container` CLI has not yet supplied equivalent proof; accepting it
  // would make host-owned controls writable through their session parent.
  if (runtimeName === 'apple-container') {
    throw new Error(
      'Selected container runtime cannot enforce the verified nested read-only mount boundary.',
    );
  }
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function excludeProtectedAdditionalMounts(
  mounts: VolumeMount[],
  protectedRoots: string[],
): VolumeMount[] {
  const resolvedRoots = protectedRoots
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  return mounts.filter((mount) => {
    const candidate = fs.realpathSync(mount.hostPath);
    return !resolvedRoots.some((root) => {
      const candidateWithinRoot = path.relative(root, candidate);
      const rootWithinCandidate = path.relative(candidate, root);
      return (
        (!candidateWithinRoot.startsWith('..') &&
          !path.isAbsolute(candidateWithinRoot)) ||
        (!rootWithinCandidate.startsWith('..') &&
          !path.isAbsolute(rootWithinCandidate))
      );
    });
  });
}

interface ContainerLaunchMetadata {
  selectedModel: string | null;
  endpointMode: string | null;
}

const FALLBACK_CREDENTIAL_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;

const RUNTIME_ENDPOINT_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;
const MINIMAX_RUNTIME_ENV_KEYS = [
  'MINIMAX_ENABLED',
  'MINIMAX_API_KEY',
  'MINIMAX_ANTHROPIC_BASE_URL',
  'MINIMAX_OPENAI_BASE_URL',
  'MINIMAX_MODEL_COMPLEX',
] as const;
const MODEL_OVERRIDE_ENV_KEYS = [
  'CURSOR_GATEWAY_HINT',
  'NANOCLAW_AGENT_MODEL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_MODEL',
] as const;

const PROJECT_VIEW_EXCLUDED_ROOTS = new Set([
  '.claude',
  '.git',
  'data',
  'groups',
  'node_modules',
  'store',
]);
const MAX_PROJECT_VIEW_FILES = 10_000;
const MAX_PROJECT_VIEW_FILE_BYTES = 25 * 1024 * 1024;
const MAX_PROJECT_VIEW_TOTAL_BYTES = 512 * 1024 * 1024;

interface LocalOpenAiGatewayState {
  runtime?: string;
  network?: string;
  endpoint?: string;
  container_name?: string;
}

const ONECLI_AUTH_PLACEHOLDER = 'onecli-placeholder';
const LOCAL_OPENAI_GATEWAY_STATE_PATH = path.join(
  RUNTIME_STATE_DIR,
  'openai-gateway-state.json',
);
const LOCAL_ENDPOINT_REWRITE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.containers.internal',
  'host.docker.internal',
  'api.openai.com',
]);
const LOOPBACK_ENDPOINT_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const CONTAINER_HOST_ALIAS_HOSTS = new Set([
  'host.containers.internal',
  'host.docker.internal',
]);
const NINE_ROUTER_DEFAULT_PORT = '20128';
const LOG_SAFE_ENV_KEYS = new Set([
  'TZ',
  'HOME',
  'NANOCLAW_RUNTIME_PROVIDER',
  'NANOCLAW_CONTAINER_RUNTIME',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
  'ONECLI_URL',
]);

function shouldRedactEnvKey(key: string): boolean {
  if (LOG_SAFE_ENV_KEYS.has(key)) return false;
  return (
    /TOKEN/i.test(key) ||
    /API_KEY/i.test(key) ||
    /SECRET/i.test(key) ||
    /PASSWORD/i.test(key) ||
    /AUTH/i.test(key)
  );
}

function appendContainerEnv(
  args: string[],
  launchEnv: Record<string, string>,
  key: string,
  value: string,
): void {
  if (shouldRedactEnvKey(key)) {
    // Docker/Podman inherit a bare `-e KEY` from their own process
    // environment. This keeps the value out of argv, process listings, and
    // command diagnostics while preserving the existing container contract.
    launchEnv[key] = value;
    args.push('-e', key);
    return;
  }
  args.push('-e', `${key}=${value}`);
}

function normalizeSensitiveContainerEnvArgs(
  args: string[],
  launchEnv: Record<string, string>,
): void {
  const observedValues = new Map<string, string>();
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== '-e') continue;
    const envArg = args[index + 1] || '';
    const separator = envArg.indexOf('=');
    const key = separator >= 0 ? envArg.slice(0, separator) : envArg;
    const value = separator >= 0 ? envArg.slice(separator + 1) : undefined;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error('Container environment contains an unsafe key.');
    }
    if (value !== undefined) {
      const previousValue = observedValues.get(key) ?? launchEnv[key];
      if (previousValue !== undefined && previousValue !== value) {
        throw new Error(
          `Container environment contains conflicting values for ${key}.`,
        );
      }
      observedValues.set(key, value);
      if (shouldRedactEnvKey(key) || ONECLI_ALLOWED_ENV_KEYS.has(key)) {
        launchEnv[key] = value;
        args[index + 1] = key;
      }
    }
  }
}

const ONECLI_ALLOWED_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
]);
const ONECLI_CA_TARGETS = [
  '/tmp/onecli-proxy-ca.pem',
  '/tmp/onecli-combined-ca.pem',
] as const;

function validateOneCliProxyUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new Error('OneCLI returned an invalid proxy URL.', { cause });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    (parsed.pathname && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('OneCLI returned an unsafe proxy URL.');
  }
}

function validateRuntimeEndpointUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new Error('Runtime endpoint URL is invalid.', { cause });
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    value.length > 4096 ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error('Runtime endpoint URL is unsafe.');
  }
}

function validateOneCliCaMount(spec: string): void {
  const target = ONECLI_CA_TARGETS.find((candidate) =>
    spec.endsWith(`:${candidate}:ro`),
  );
  if (!target) {
    throw new Error('OneCLI attempted an unsupported container mount.');
  }
  const hostPath = spec.slice(0, -`:${target}:ro`.length);
  const resolvedHostPath = path.resolve(hostPath);
  const resolvedTempRoot = path.resolve(os.tmpdir());
  const relative = path.relative(resolvedTempRoot, resolvedHostPath);
  if (
    !hostPath ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    !['onecli-proxy-ca.pem', 'onecli-combined-ca.pem'].includes(
      path.basename(resolvedHostPath),
    )
  ) {
    throw new Error('OneCLI CA mount is outside the trusted temporary path.');
  }
  const stat = fs.lstatSync(resolvedHostPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 5 * 1024 * 1024) {
    throw new Error('OneCLI CA mount is not a bounded regular file.');
  }
  const pem = fs.readFileSync(resolvedHostPath, 'utf8');
  if (!pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('OneCLI CA mount does not contain a certificate.');
  }
}

/** OneCLI is a credential proxy, not an executable-control authority. Validate
 * every SDK-added argument against its documented proxy/CA contract. */
function validateOneCliAddedArgs(
  argsBefore: string[],
  argsAfter: string[],
): void {
  if (
    argsAfter.length < argsBefore.length ||
    argsBefore.some((value, index) => argsAfter[index] !== value)
  ) {
    throw new Error('OneCLI modified existing container controls.');
  }
  const additions = argsAfter.slice(argsBefore.length);
  for (let index = 0; index < additions.length; index += 2) {
    const flag = additions[index];
    const value = additions[index + 1];
    if (!value || (flag !== '-e' && flag !== '-v')) {
      throw new Error('OneCLI returned an unsupported container argument.');
    }
    if (flag === '-v') {
      validateOneCliCaMount(value);
      continue;
    }
    const separator = value.indexOf('=');
    if (separator <= 0) {
      throw new Error('OneCLI returned an invalid environment argument.');
    }
    const key = value.slice(0, separator);
    const envValue = value.slice(separator + 1);
    if (!ONECLI_ALLOWED_ENV_KEYS.has(key)) {
      throw new Error(
        `OneCLI returned an unsupported environment key: ${key}.`,
      );
    }
    if (key === 'HTTP_PROXY' || key === 'HTTPS_PROXY') {
      validateOneCliProxyUrl(envValue);
    } else if (key === 'NO_PROXY') {
      if (envValue.length > 4096 || /[\r\n\0]/.test(envValue)) {
        throw new Error('OneCLI returned an unsafe NO_PROXY value.');
      }
    } else {
      const expectedTarget =
        key === 'NODE_EXTRA_CA_CERTS'
          ? '/tmp/onecli-proxy-ca.pem'
          : '/tmp/onecli-combined-ca.pem';
      if (envValue !== expectedTarget) {
        throw new Error(`OneCLI returned an unsafe ${key} path.`);
      }
    }
  }
}

export function sanitizeContainerArgsForLogs(args: string[]): string[] {
  const sanitized = [...args];
  for (let i = 0; i < sanitized.length - 1; i++) {
    if (sanitized[i] !== '-e') continue;
    const envArg = sanitized[i + 1];
    const separator = envArg.indexOf('=');
    if (separator <= 0) continue;
    const key = envArg.slice(0, separator);
    if (shouldRedactEnvKey(key)) {
      sanitized[i + 1] = `${key}=***`;
    }
  }
  return sanitized;
}

export function sanitizeContainerRuntimeText(
  value: string,
  injectedEnv: Record<string, string>,
): string {
  let sanitized = sanitizeLogString(value || '');
  for (const [key, secretValue] of Object.entries(injectedEnv)) {
    if (
      shouldRedactEnvKey(key) &&
      secretValue.length >= 4 &&
      sanitized.includes(secretValue)
    ) {
      sanitized = sanitized.split(secretValue).join('[REDACTED]');
    }
  }
  return sanitizeLogString(sanitized);
}

function hasContainerEnvArg(args: string[], key: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-e') continue;
    if (args[i + 1] === key || args[i + 1]?.startsWith(`${key}=`)) {
      return true;
    }
  }
  return false;
}

export function buildContainerChildEnv(
  launchEnv: Record<string, string>,
  containerArgs: string[],
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const processLaunchKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY',
    'DOCKER_API_VERSION',
    'DOCKER_DEFAULT_PLATFORM',
    'CONTAINER_HOST',
    'PODMAN_HOST',
    'CONTAINER_SSHKEY',
    'SSH_AUTH_SOCK',
    'XDG_RUNTIME_DIR',
    'XDG_CONFIG_HOME',
    'DBUS_SESSION_BUS_ADDRESS',
    'SYSTEMROOT',
    'COMSPEC',
    'PATHEXT',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'APPDATA',
    'LOCALAPPDATA',
  ] as const;
  const explicitlyInheritedKeys = new Set<string>();
  for (let index = 0; index < containerArgs.length - 1; index += 1) {
    if (containerArgs[index] !== '-e') continue;
    const value = containerArgs[index + 1] || '';
    if (value && !value.includes('=')) explicitlyInheritedKeys.add(value);
  }
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of processLaunchKeys) {
    if (inheritedEnv[key] !== undefined) childEnv[key] = inheritedEnv[key];
  }
  for (const key of explicitlyInheritedKeys) {
    if (inheritedEnv[key] !== undefined) childEnv[key] = inheritedEnv[key];
  }
  Object.assign(childEnv, launchEnv);
  return childEnv;
}

function hasAnthropicAuthEnvArg(args: string[]): boolean {
  return (
    hasContainerEnvArg(args, 'CLAUDE_CODE_OAUTH_TOKEN') ||
    hasContainerEnvArg(args, 'ANTHROPIC_API_KEY') ||
    hasContainerEnvArg(args, 'ANTHROPIC_AUTH_TOKEN')
  );
}

function collectRuntimeEndpointEnv(): Record<string, string> {
  const fromEnvFile = readEnvFile([...RUNTIME_ENDPOINT_ENV_KEYS]);
  const env: Record<string, string> = {};

  for (const key of RUNTIME_ENDPOINT_ENV_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) env[key] = value;
  }

  // Claude SDK expects ANTHROPIC_BASE_URL for endpoint overrides. If users
  // provide OPENAI_BASE_URL only, mirror it so OpenAI-compatible gateways work
  // without requiring duplicate environment keys.
  if (!env.ANTHROPIC_BASE_URL && env.OPENAI_BASE_URL) {
    env.ANTHROPIC_BASE_URL = env.OPENAI_BASE_URL;
  }

  return env;
}

interface MiniMaxRuntimeEnv {
  enabled: boolean;
  configured: boolean;
  apiKey: string;
  anthropicBaseUrl: string;
  openAiBaseUrl: string;
  model: string;
}

function normalizeBaseUrl(value: string, fallback: string): string {
  return (value || fallback).replace(/\/+$/g, '');
}

function collectMiniMaxRuntimeEnv(): MiniMaxRuntimeEnv {
  const fromEnvFile = readEnvFile([...MINIMAX_RUNTIME_ENV_KEYS]);
  const read = (key: (typeof MINIMAX_RUNTIME_ENV_KEYS)[number]) =>
    process.env[key] || fromEnvFile[key] || '';
  const apiKey = read('MINIMAX_API_KEY').trim();
  const enabledValue = read('MINIMAX_ENABLED').trim().toLowerCase();
  const enabled =
    enabledValue === '' ? Boolean(apiKey) : enabledValue !== 'false';

  return {
    enabled,
    configured: enabled && Boolean(apiKey),
    apiKey,
    anthropicBaseUrl: normalizeBaseUrl(
      read('MINIMAX_ANTHROPIC_BASE_URL'),
      DEFAULT_MINIMAX_ANTHROPIC_BASE_URL,
    ),
    openAiBaseUrl: normalizeBaseUrl(
      read('MINIMAX_OPENAI_BASE_URL'),
      DEFAULT_MINIMAX_OPENAI_BASE_URL,
    ),
    model: read('MINIMAX_MODEL_COMPLEX') || DEFAULT_MINIMAX_MODEL_COMPLEX,
  };
}

function wantsMiniMaxRuntime(runtime?: AgentRuntimeName | null): boolean {
  return runtime === 'minimax_cloud';
}

function collectFallbackCredentialEnv(
  endpointEnv: Record<string, string>,
  runtimePreference?: AgentRuntimeName | null,
): Record<string, string> {
  if (wantsMiniMaxRuntime(runtimePreference)) {
    const miniMax = collectMiniMaxRuntimeEnv();
    return miniMax.configured
      ? {
          ANTHROPIC_AUTH_TOKEN: miniMax.apiKey,
        }
      : {};
  }

  const fromEnvFile = readEnvFile([...FALLBACK_CREDENTIAL_KEYS]);
  const read = (key: (typeof FALLBACK_CREDENTIAL_KEYS)[number]) =>
    (process.env[key] || fromEnvFile[key] || '').trim();
  const oauthToken = read('CLAUDE_CODE_OAUTH_TOKEN');
  if (oauthToken) return { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };
  const anthropicApiKey = read('ANTHROPIC_API_KEY');
  if (anthropicApiKey) return { ANTHROPIC_API_KEY: anthropicApiKey };
  const anthropicAuthToken = read('ANTHROPIC_AUTH_TOKEN');
  if (anthropicAuthToken) {
    return { ANTHROPIC_AUTH_TOKEN: anthropicAuthToken };
  }
  const openAiApiKey = read('OPENAI_API_KEY');

  // OpenAI-compatible bridge:
  // If the user configured an Anthropic-compatible base URL and only has an
  // OpenAI key, use that key as the auth token expected by the Claude SDK.
  if (endpointEnv.ANTHROPIC_BASE_URL && openAiApiKey) {
    return { ANTHROPIC_AUTH_TOKEN: openAiApiKey };
  }
  return openAiApiKey ? { OPENAI_API_KEY: openAiApiKey } : {};
}

function collectModelOverrideEnv(): Record<string, string> {
  const fromEnvFile = readEnvFile([...MODEL_OVERRIDE_ENV_KEYS]);
  const env: Record<string, string> = {};
  for (const key of MODEL_OVERRIDE_ENV_KEYS) {
    const value = process.env[key] || fromEnvFile[key];
    if (value) env[key] = value;
  }
  return env;
}

function hasContainerFlagValue(
  args: string[],
  flag: string,
  value: string,
): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) {
      return true;
    }
  }
  return false;
}

function parseEndpointHostname(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function parseEndpoint(value: string): URL | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function parseExplicitEndpointPort(value: string): string | null {
  const endpoint = parseEndpoint(value);
  if (!endpoint) return null;
  return endpoint.port || null;
}

function rewriteEndpointForContainer(endpointValue: string): string {
  const endpoint = parseEndpoint(endpointValue);
  if (!endpoint) return endpointValue;

  const host = endpoint.hostname.toLowerCase();
  if (
    !LOOPBACK_ENDPOINT_HOSTS.has(host) &&
    !CONTAINER_HOST_ALIAS_HOSTS.has(host)
  ) {
    return endpointValue;
  }

  const runtimeHostAlias = getContainerRuntimeHostAlias();
  endpoint.hostname = runtimeHostAlias;
  return endpoint.toString();
}

function rewriteRuntimeEndpointEnvForContainer(
  runtimeEndpointEnv: Record<string, string>,
): Record<string, string> {
  const rewritten: Record<string, string> = {};
  for (const [key, value] of Object.entries(runtimeEndpointEnv)) {
    rewritten[key] = rewriteEndpointForContainer(value);
  }
  return rewritten;
}

function endpointLooksLike9Router(endpointValue: string): boolean {
  const endpoint = parseEndpoint(endpointValue);
  if (!endpoint) return false;
  if (endpoint.port === NINE_ROUTER_DEFAULT_PORT) return true;
  return endpoint.hostname.toLowerCase().includes('9router');
}

function hasCursorGatewayHint(configured: Record<string, string>): boolean {
  const hint = (configured.CURSOR_GATEWAY_HINT || '').trim().toLowerCase();
  return hint === '9router' || hint === 'cursor';
}

function resolveModelOverridesForRuntime(
  runtimeEndpointEnv: Record<string, string>,
  runtimePreference?: AgentRuntimeName | null,
  miniMax?: MiniMaxRuntimeEnv | null,
): Record<string, string> {
  const configured = collectModelOverrideEnv();
  if (
    configured.NANOCLAW_AGENT_MODEL ||
    configured.CLAUDE_CODE_MODEL ||
    configured.CLAUDE_MODEL
  ) {
    return configured;
  }

  if (wantsMiniMaxRuntime(runtimePreference)) {
    return {
      ...configured,
      NANOCLAW_RUNTIME_PROVIDER: 'minimax',
      NANOCLAW_AGENT_MODEL: miniMax?.model || DEFAULT_MINIMAX_MODEL_COMPLEX,
    };
  }

  const endpoint =
    runtimeEndpointEnv.ANTHROPIC_BASE_URL || runtimeEndpointEnv.OPENAI_BASE_URL;
  if (
    !endpoint ||
    (!endpointLooksLike9Router(endpoint) && !hasCursorGatewayHint(configured))
  ) {
    return configured;
  }

  return {
    ...configured,
    NANOCLAW_AGENT_MODEL: 'cu/default',
  };
}

function readLocalOpenAiGatewayState(): LocalOpenAiGatewayState | null {
  if (!fs.existsSync(LOCAL_OPENAI_GATEWAY_STATE_PATH)) {
    return null;
  }
  try {
    const raw = fs
      .readFileSync(LOCAL_OPENAI_GATEWAY_STATE_PATH, 'utf-8')
      .replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as LocalOpenAiGatewayState;
    if (
      !parsed ||
      typeof parsed.network !== 'string' ||
      !parsed.network ||
      typeof parsed.endpoint !== 'string' ||
      !parsed.endpoint
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveLocalOpenAiGatewayBinding(
  runtimeEndpointEnv: Record<string, string>,
): { endpoint: string; network: string } | null {
  const state = readLocalOpenAiGatewayState();
  if (!state) return null;
  if (state.runtime && state.runtime !== CONTAINER_RUNTIME_NAME) return null;

  const envFileCreds = readEnvFile([...FALLBACK_CREDENTIAL_KEYS]);
  const hasOpenAiApiKey = Boolean(
    process.env.OPENAI_API_KEY || envFileCreds.OPENAI_API_KEY,
  );
  if (!hasOpenAiApiKey) return null;

  const hasAnthropicDirectCreds = Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    envFileCreds.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.ANTHROPIC_API_KEY ||
    envFileCreds.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    envFileCreds.ANTHROPIC_AUTH_TOKEN,
  );

  const configuredEndpoint =
    runtimeEndpointEnv.ANTHROPIC_BASE_URL || runtimeEndpointEnv.OPENAI_BASE_URL;

  if (configuredEndpoint) {
    const host = parseEndpointHostname(configuredEndpoint);
    if (!host || !LOCAL_ENDPOINT_REWRITE_HOSTS.has(host)) {
      return null;
    }

    // If users explicitly point to a local endpoint on a different port
    // (for example 9router on :20128), preserve that endpoint instead of
    // rewriting to the local OpenAI gateway container binding.
    if (
      LOOPBACK_ENDPOINT_HOSTS.has(host) ||
      CONTAINER_HOST_ALIAS_HOSTS.has(host)
    ) {
      const configuredPort = parseExplicitEndpointPort(configuredEndpoint);
      const statePort = parseExplicitEndpointPort(state.endpoint ?? '');
      if (configuredPort && statePort && configuredPort !== statePort) {
        return null;
      }
    }
  } else if (hasAnthropicDirectCreds) {
    return null;
  }

  return {
    endpoint: state.endpoint!,
    network: state.network!,
  };
}

const MAX_TRUSTED_SKILL_DEPTH = 20;
const MAX_TRUSTED_SKILL_ENTRIES = 2_000;
const MAX_TRUSTED_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TRUSTED_SKILL_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TRUSTED_GUIDANCE_BYTES = 128 * 1024;
const CONTROL_GENERATION_RETENTION_MS = Math.max(
  24 * 60 * 60 * 1_000,
  CONTAINER_TIMEOUT * 2,
);
const activeControlGenerations = new Map<string, number>();

interface TrustedCopyBudget {
  entries: number;
  bytes: number;
}

function assertSafePathSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    path.basename(segment) !== segment ||
    segment.includes('/') ||
    segment.includes('\\')
  ) {
    throw new Error(`Unsafe ${label} path segment: ${segment || '<empty>'}`);
  }
}

function assertSafeControlIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value || '<empty>'}`);
  }
}

/** Register a destination using the conservative equivalence rules of the
 * production macOS filesystem. Exported so collision behavior is directly
 * testable without constructing live marketplace state. */
export function registerTrustedControlDestination(
  destinations: Map<string, string>,
  destinationName: string,
): void {
  const key = destinationName.normalize('NFC').toLocaleLowerCase('en-US');
  const existing = destinations.get(key);
  if (existing !== undefined) {
    throw new Error(
      `Trusted skill destination collides with ${existing}: ${destinationName}`,
    );
  }
  destinations.set(key, destinationName);
}

function readBoundedHostGuidance(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Group guidance must be a regular file: ${filePath}`);
  }
  if (stat.size > MAX_TRUSTED_GUIDANCE_BYTES) {
    throw new Error(`Group guidance is too large: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (Buffer.byteLength(content, 'utf8') > MAX_TRUSTED_GUIDANCE_BYTES) {
    throw new Error(`Group guidance is too large: ${filePath}`);
  }
  return content;
}

export function resolveTrustedGroupGuidance(
  route: AssistantRequestPolicy['route'],
  groupWorkspaceDir: string,
): string {
  // Only execution lanes may consume the shell-writable group instructions.
  // Every less-capable or host-action lane receives a host constant so an
  // earlier execution turn cannot persistently prompt-poison a later turn.
  if (route === 'advanced_helper' || route === 'code_plane') {
    return (
      readBoundedHostGuidance(path.join(groupWorkspaceDir, 'CLAUDE.md')) ||
      '# Andrea execution guidance\n'
    );
  }
  if (route === 'control_plane') return '# Andrea control guidance\n';
  if (route === 'protected_assistant') {
    return '# Andrea protected assistant guidance\n';
  }
  return '# Andrea direct assistant guidance\n';
}

function assertPathWithinRoot(candidatePath: string, rootPath: string): void {
  const resolvedRoot = fs.realpathSync(rootPath);
  const resolvedCandidate = fs.realpathSync(candidatePath);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `Community skill cache is outside its trusted root: ${candidatePath}`,
    );
  }
}

function hashTrustedControlTree(rootDir: string): string {
  const hash = createHash('sha256');
  const walk = (currentDir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(currentDir).sort()) {
      const fullPath = path.join(currentDir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `Trusted control view contains a symbolic link: ${fullPath}`,
        );
      }
      if (stat.isDirectory()) {
        hash.update(`d:${relativePath}\n`);
        walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `Trusted control view contains a special file: ${fullPath}`,
        );
      }
      hash.update(`f:${relativePath}:${stat.size}\n`);
      hash.update(fs.readFileSync(fullPath));
      hash.update('\n');
    }
  };
  walk(rootDir, '');
  return hash.digest('hex');
}

function retainControlGeneration(generationDir: string): void {
  activeControlGenerations.set(
    generationDir,
    (activeControlGenerations.get(generationDir) || 0) + 1,
  );
}

function releaseControlGeneration(generationDir: string): void {
  const count = activeControlGenerations.get(generationDir) || 0;
  if (count <= 1) {
    activeControlGenerations.delete(generationDir);
  } else {
    activeControlGenerations.set(generationDir, count - 1);
  }
}

function pruneExpiredControlGenerations(controlsRoot: string): void {
  const cutoff = Date.now() - CONTROL_GENERATION_RETENTION_MS;
  for (const entry of fs.readdirSync(controlsRoot)) {
    if (!/^generation-[a-f0-9]{64}$/.test(entry)) continue;
    const candidate = path.join(controlsRoot, entry);
    const stat = fs.lstatSync(candidate);
    if (
      activeControlGenerations.has(candidate) ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.mtimeMs >= cutoff
    ) {
      continue;
    }
    fs.rmSync(candidate, { recursive: true, force: true });
  }
}

/**
 * Copy a skill tree without following links or accepting special files.
 * Exported only so the trust boundary can be tested against real filesystem
 * entries; callers should normally use the generated control view below.
 */
export function copyTrustedSkillDirectory(
  sourceDir: string,
  destinationDir: string,
  budget: TrustedCopyBudget = { entries: 0, bytes: 0 },
  depth = 0,
): void {
  if (depth > MAX_TRUSTED_SKILL_DEPTH) {
    throw new Error(`Trusted skill tree exceeds maximum depth: ${sourceDir}`);
  }

  const sourceStat = fs.lstatSync(sourceDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(
      `Trusted skill source is not a regular directory: ${sourceDir}`,
    );
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir).sort()) {
    assertSafePathSegment(entry, 'skill entry');
    budget.entries += 1;
    if (budget.entries > MAX_TRUSTED_SKILL_ENTRIES) {
      throw new Error(`Trusted skill tree has too many entries: ${sourceDir}`);
    }

    const sourcePath = path.join(sourceDir, entry);
    const destinationPath = path.join(destinationDir, entry);
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Trusted skill tree contains a symbolic link: ${sourcePath}`,
      );
    }
    if (stat.isDirectory()) {
      copyTrustedSkillDirectory(sourcePath, destinationPath, budget, depth + 1);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Trusted skill tree contains a special file: ${sourcePath}`,
      );
    }
    if (stat.size > MAX_TRUSTED_SKILL_FILE_BYTES) {
      throw new Error(`Trusted skill file is too large: ${sourcePath}`);
    }
    budget.bytes += stat.size;
    if (budget.bytes > MAX_TRUSTED_SKILL_TOTAL_BYTES) {
      throw new Error(`Trusted skill tree is too large: ${sourceDir}`);
    }
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function isTrustedProjectPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false;
  }
  if (PROJECT_VIEW_EXCLUDED_ROOTS.has(segments[0]!)) return false;
  if (normalized === '.mcp.json') return false;
  return !segments.some((segment) => segment.toLowerCase().startsWith('.env'));
}

export function buildTrustedProjectViewFromTrackedPaths(
  projectRoot: string,
  trackedPaths: string[],
  viewsRoot = path.join(RUNTIME_STATE_DIR, 'container-project-views'),
): string {
  const relativePaths = [...new Set(trackedPaths)]
    .filter(isTrustedProjectPath)
    .sort();
  if (relativePaths.length > MAX_PROJECT_VIEW_FILES) {
    throw new Error('Trusted project snapshot contains too many files.');
  }

  fs.mkdirSync(viewsRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(viewsRoot, '.staging-'));
  let committed = false;
  let totalBytes = 0;
  try {
    for (const relativePath of relativePaths) {
      const sourcePath = path.join(projectRoot, ...relativePath.split('/'));
      const sourceStat = fs.lstatSync(sourcePath);
      if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
        throw new Error(
          `Trusted project source is not a regular file: ${relativePath}`,
        );
      }
      if (sourceStat.size > MAX_PROJECT_VIEW_FILE_BYTES) {
        throw new Error(`Trusted project file is too large: ${relativePath}`);
      }
      totalBytes += sourceStat.size;
      if (totalBytes > MAX_PROJECT_VIEW_TOTAL_BYTES) {
        throw new Error('Trusted project snapshot is too large.');
      }
      const destinationPath = path.join(stagingDir, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
    }

    const generationHash = hashTrustedControlTree(stagingDir);
    const generationDir = path.join(viewsRoot, `generation-${generationHash}`);
    if (fs.existsSync(generationDir)) {
      if (hashTrustedControlTree(generationDir) !== generationHash) {
        throw new Error(
          'Existing trusted project generation failed integrity check.',
        );
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } else {
      try {
        fs.renameSync(stagingDir, generationDir);
      } catch (err) {
        if (
          !fs.existsSync(generationDir) ||
          hashTrustedControlTree(generationDir) !== generationHash
        ) {
          throw err;
        }
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    }
    committed = true;
    return generationDir;
  } finally {
    if (!committed) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

/**
 * Build an atomic, content-addressed snapshot containing only Git-tracked
 * regular files. Ignored/untracked owner data, project MCP/settings files,
 * group state, and every .env* file are absent rather than merely shadowed.
 */
export function buildTrustedProjectView(
  projectRoot: string,
  viewsRoot = path.join(RUNTIME_STATE_DIR, 'container-project-views'),
): string {
  const listResult = spawnSync('git', ['ls-files', '--cached', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (listResult.error) throw listResult.error;
  if (listResult.status !== 0) {
    throw new Error('Unable to enumerate the trusted project snapshot.');
  }
  return buildTrustedProjectViewFromTrackedPaths(
    projectRoot,
    String(listResult.stdout || '')
      .split('\0')
      .filter(Boolean),
    viewsRoot,
  );
}

const TRUSTED_CLAUDE_SETTINGS = {
  env: {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  },
} as const;

const TRUSTED_USER_GUIDANCE = `# Andrea managed runtime

Runtime settings, skills, plugins, and tool availability are managed by the host.
Treat these controls as read-only. Never attempt to replace or bypass them.
`;

interface TrustedControlView {
  generationDir: string;
  settingsFile: string;
  userGuidanceFile: string;
  groupGuidanceFile: string;
  skillsDir: string;
  pluginsDir: string;
  agentsDir: string;
  commandsDir: string;
  rulesDir: string;
}

export function shouldIncludeSkillControlsForRoute(
  route?: AssistantRequestPolicy['route'],
  builtinTools: readonly string[] = [],
): boolean {
  return (
    (route === 'advanced_helper' || route === 'code_plane') &&
    builtinTools.includes('Skill')
  );
}

export type TrustedSkillControlMode = 'none' | 'catalog' | 'full';

export function resolveTrustedSkillControlMode(
  route: AssistantRequestPolicy['route'] | undefined,
  builtinTools: readonly string[] = [],
  mcpTools: readonly string[] = [],
): TrustedSkillControlMode {
  if (shouldIncludeSkillControlsForRoute(route, builtinTools)) return 'full';
  return mcpTools.some((tool) =>
    [
      'mcp__nanoclaw__search_openclaw_skills',
      'mcp__nanoclaw__enable_openclaw_skill',
      'mcp__nanoclaw__install_openclaw_skill',
      'mcp__nanoclaw__disable_openclaw_skill',
      'mcp__nanoclaw__list_enabled_openclaw_skills',
    ].includes(tool),
  )
    ? 'catalog'
    : 'none';
}

export function copyTrustedOpenClawCatalog(
  sourceFile: string,
  destinationFile: string,
): void {
  const stat = fs.lstatSync(sourceFile);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.size > MAX_TRUSTED_SKILL_FILE_BYTES
  ) {
    throw new Error('OpenClaw catalog must be a bounded regular file.');
  }
  const content = fs.readFileSync(sourceFile, 'utf8');
  const parsed = JSON.parse(content) as { skills?: unknown };
  if (!parsed || !Array.isArray(parsed.skills)) {
    throw new Error('OpenClaw catalog has an invalid structure.');
  }
  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  fs.writeFileSync(destinationFile, content, 'utf8');
}

function buildTrustedControlView(
  groupFolder: string,
  route: AssistantRequestPolicy['route'],
  groupWorkspaceDir: string,
  skillControlMode: TrustedSkillControlMode,
): TrustedControlView {
  assertSafeControlIdentifier(groupFolder, 'group folder');
  const claudeHomeFlavor = route.replace(/_/g, '-');
  assertSafeControlIdentifier(claudeHomeFlavor, 'Claude home flavor');
  const controlsRoot = path.join(
    RUNTIME_STATE_DIR,
    'container-controls',
    groupFolder,
    claudeHomeFlavor,
  );
  fs.mkdirSync(controlsRoot, { recursive: true });
  const stagingDir = fs.mkdtempSync(path.join(controlsRoot, '.staging-'));
  let committed = false;

  try {
    const settingsFile = path.join(stagingDir, 'settings.json');
    const userGuidanceFile = path.join(stagingDir, 'CLAUDE.md');
    const groupGuidanceFile = path.join(stagingDir, 'group-CLAUDE.md');
    const skillsDir = path.join(stagingDir, 'skills');
    const pluginsDir = path.join(stagingDir, 'plugins');
    const agentsDir = path.join(stagingDir, 'agents');
    const commandsDir = path.join(stagingDir, 'commands');
    const rulesDir = path.join(stagingDir, 'rules');
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(pluginsDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      settingsFile,
      `${JSON.stringify(TRUSTED_CLAUDE_SETTINGS, null, 2)}\n`,
      'utf8',
    );
    fs.writeFileSync(userGuidanceFile, TRUSTED_USER_GUIDANCE, 'utf8');
    const groupGuidance = resolveTrustedGroupGuidance(route, groupWorkspaceDir);
    fs.writeFileSync(groupGuidanceFile, groupGuidance, 'utf8');

    // Skills are executable/prompt-bearing controls. Keep them entirely out of
    // direct, protected, and control profiles; only the explicitly capable
    // advanced/code lanes receive the canonical + enabled set.
    if (skillControlMode === 'catalog') {
      copyTrustedOpenClawCatalog(
        path.join(
          process.cwd(),
          'container',
          'skills',
          'openclaw-market',
          'catalog.json',
        ),
        path.join(skillsDir, 'openclaw-market', 'catalog.json'),
      );
    } else if (skillControlMode === 'full') {
      const destinationNames = new Map<string, string>();
      const skillBudget: TrustedCopyBudget = { entries: 0, bytes: 0 };
      const canonicalSkillsDir = path.join(
        process.cwd(),
        'container',
        'skills',
      );
      if (fs.existsSync(canonicalSkillsDir)) {
        for (const skillName of fs.readdirSync(canonicalSkillsDir).sort()) {
          assertSafePathSegment(skillName, 'canonical skill');
          const sourceDir = path.join(canonicalSkillsDir, skillName);
          const sourceStat = fs.lstatSync(sourceDir);
          if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
            throw new Error(
              `Canonical skill is not a regular directory: ${sourceDir}`,
            );
          }
          registerTrustedControlDestination(destinationNames, skillName);
          copyTrustedSkillDirectory(
            sourceDir,
            path.join(skillsDir, skillName),
            skillBudget,
          );
        }
      }

      let enabledCommunitySkills: ReturnType<
        typeof listEnabledCommunitySkillsForGroup
      > = [];
      try {
        enabledCommunitySkills =
          listEnabledCommunitySkillsForGroup(groupFolder);
      } catch (err) {
        logger.debug(
          { groupFolder, err },
          'Using canonical skills only because the marketplace DB is unavailable',
        );
      }

      for (const skill of enabledCommunitySkills) {
        assertSafePathSegment(skill.cache_dir_name, 'community skill');
        registerTrustedControlDestination(
          destinationNames,
          skill.cache_dir_name,
        );
        if (!fs.existsSync(skill.cache_path)) {
          logger.warn(
            { groupFolder, skillId: skill.skill_id },
            'Enabled community skill cache is missing; excluding it from the control view',
          );
          continue;
        }
        const marketplaceCacheRoot = path.resolve(
          DATA_DIR,
          'marketplace',
          'skills',
        );
        if (!fs.existsSync(marketplaceCacheRoot)) {
          throw new Error(
            `Marketplace cache root is missing for enabled skill: ${skill.skill_id}`,
          );
        }
        assertPathWithinRoot(skill.cache_path, marketplaceCacheRoot);
        copyTrustedSkillDirectory(
          skill.cache_path,
          path.join(skillsDir, skill.cache_dir_name),
          skillBudget,
        );
      }
    }

    const generationHash = hashTrustedControlTree(stagingDir);
    const generationDir = path.join(
      controlsRoot,
      `generation-${generationHash}`,
    );
    if (fs.existsSync(generationDir)) {
      const existingHash = hashTrustedControlTree(generationDir);
      if (existingHash !== generationHash) {
        throw new Error(
          `Existing trusted control generation failed integrity check`,
        );
      }
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } else {
      try {
        fs.renameSync(stagingDir, generationDir);
      } catch (err) {
        // Concurrent launches can resolve the same content-addressed view.
        // Reuse it only after verifying the complete tree.
        if (
          !fs.existsSync(generationDir) ||
          hashTrustedControlTree(generationDir) !== generationHash
        ) {
          throw err;
        }
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    }
    committed = true;
    return {
      generationDir,
      settingsFile: path.join(generationDir, 'settings.json'),
      userGuidanceFile: path.join(generationDir, 'CLAUDE.md'),
      groupGuidanceFile: path.join(generationDir, 'group-CLAUDE.md'),
      skillsDir: path.join(generationDir, 'skills'),
      pluginsDir: path.join(generationDir, 'plugins'),
      agentsDir: path.join(generationDir, 'agents'),
      commandsDir: path.join(generationDir, 'commands'),
      rulesDir: path.join(generationDir, 'rules'),
    };
  } finally {
    if (!committed) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

const DIRECT_ASSISTANT_WORKSPACE_CLAUDE = `# Andrea

You are Andrea, a personal assistant.

Andrea is the only public assistant identity. Keep replies direct, natural, and grounded in the user's visible message context.

## Direct Assistant Mode

- This lane is for stable plain-language replies.
- Answer directly from the visible prompt and chat context when you can.
- Do not inspect workspace files, run commands, browse the web, or claim that you did unless the user explicitly asks for that kind of help.
- Do not invent hidden context or say you checked files you did not read.
- If the user gives a vague refinement like "make it shorter" or "fix that", apply a safe general rewrite of the latest visible answer instead of asking unnecessary clarification.

## Communication

- Keep normal conversation plain and natural.
- Do not mention internal lanes, runtimes, or orchestration unless the user asks.
- Do not present helper layers as separate assistants.
`;

export function writeTrustedWorkspaceGuidance(
  workspaceDir: string,
  content: string,
): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const guidanceFile = path.join(workspaceDir, 'CLAUDE.md');
  if (fs.existsSync(guidanceFile)) {
    const stat = fs.lstatSync(guidanceFile);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `Managed workspace guidance must be a regular file: ${guidanceFile}`,
      );
    }
    if (fs.readFileSync(guidanceFile, 'utf8') === content) return;
  }
  const temporaryFile = path.join(
    workspaceDir,
    `.CLAUDE.md.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    fs.writeFileSync(temporaryFile, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryFile, guidanceFile);
  } finally {
    fs.rmSync(temporaryFile, { force: true });
  }
}

function ensureDirectAssistantWorkspace(groupFolder: string): string {
  const workspaceDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    'direct-assistant-workspace',
  );
  writeTrustedWorkspaceGuidance(
    workspaceDir,
    DIRECT_ASSISTANT_WORKSPACE_CLAUDE,
  );
  return workspaceDir;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  route?: AssistantRequestPolicy['route'],
  freshSessionHome = false,
  allowHostActionIpc = false,
  mountProjectView = false,
  skillControlMode: TrustedSkillControlMode = 'none',
  ipcInputDir?: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir =
    route === 'direct_assistant'
      ? ensureDirectAssistantWorkspace(group.folder)
      : resolveGroupFolderPath(group.folder);
  const shouldMountMainProject =
    isMain && route !== 'direct_assistant' && mountProjectView;

  if (shouldMountMainProject) {
    // Main gets an atomic snapshot of Git-tracked regular files only. Ignored
    // owner data and mutable project controls are absent from this view.
    const trustedProjectView = buildTrustedProjectView(projectRoot);
    mounts.push({
      hostPath: trustedProjectView,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Direct assistant uses the lighter non-project mount profile even in the
    // main group so normal chat does not inherit the heavier repo work mount.
    // Other groups also only get their own folder.
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main style mounts)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (route !== 'direct_assistant' && fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Direct assistant gets its own session home so casual chat continuity does not
  // share persisted Claude state with heavier operator/work lanes in the same group.
  const routeLane = route || 'direct_assistant';
  const sessionHomeFlavor = getAssistantSessionHomeFlavor(routeLane);
  const claudeHomeDirName = `.claude-${sessionHomeFlavor}`;
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    claudeHomeDirName,
  );
  if (freshSessionHome) {
    fs.rmSync(groupSessionsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const trustedControls = buildTrustedControlView(
    group.folder,
    routeLane,
    groupDir,
    skillControlMode,
  );
  // The parent session home stays writable for Claude's resumable transcripts
  // and auto-memory. Host-generated controls are mounted afterwards as
  // read-only child overlays, so a container cannot persistently alter them.
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });
  for (const [hostPath, containerPath] of [
    [trustedControls.groupGuidanceFile, '/workspace/group/CLAUDE.md'],
    [trustedControls.settingsFile, '/home/node/.claude/settings.json'],
    [trustedControls.userGuidanceFile, '/home/node/.claude/CLAUDE.md'],
    [trustedControls.skillsDir, '/home/node/.claude/skills'],
    [trustedControls.pluginsDir, '/home/node/.claude/plugins'],
    [trustedControls.agentsDir, '/home/node/.claude/agents'],
    [trustedControls.commandsDir, '/home/node/.claude/commands'],
    [trustedControls.rulesDir, '/home/node/.claude/rules'],
  ] as const) {
    mounts.push({ hostPath, containerPath, readonly: true });
  }

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'rpc_requests'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'rpc_responses'), { recursive: true });
  if (!ipcInputDir) {
    throw new Error('Container run is missing its isolated IPC inbox.');
  }
  fs.mkdirSync(ipcInputDir, { recursive: true });
  if (allowHostActionIpc) {
    mounts.push({
      hostPath: groupIpcDir,
      containerPath: '/workspace/ipc',
      readonly: false,
    });
  }
  // Every run receives one fresh host-written inbox. The nested read-only
  // overlay also applies inside the broader host-action IPC mount, so no
  // container can forge or retain input for a later, more capable run.
  mounts.push({
    hostPath: ipcInputDir,
    containerPath: '/workspace/ipc/input',
    readonly: true,
  });

  // The canonical runner is recompiled into /tmp/dist at container startup.
  // Its source is an executable control surface and must never be writable by
  // a running assistant or persisted per group.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (route !== 'direct_assistant' && group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    const safeAdditionalMounts = excludeProtectedAdditionalMounts(
      validatedMounts,
      [
        projectRoot,
        DATA_DIR,
        GROUPS_DIR,
        RUNTIME_STATE_DIR,
        process.env.CODEX_HOME || '',
        path.join(os.homedir(), '.codex'),
        path.join(os.homedir(), '.claude'),
      ].filter(Boolean),
    );
    if (safeAdditionalMounts.length !== validatedMounts.length) {
      logger.warn(
        { group: group.name },
        'Rejected additional mount overlapping repository or runtime state',
      );
    }
    mounts.push(...safeAdditionalMounts);
  }

  // Keep every selected immutable generation live before pruning stale
  // siblings. The running container releases these references on close.
  // Retaining first prevents a reused generation older than the TTL from being
  // deleted between selection and the runtime mount.
  const selectedGenerations = new Set(
    mounts
      .map((mount) => {
        const match = mount.hostPath.match(
          /^(.*[\\/](?:container-controls[\\/].*?|container-project-views)[\\/]generation-[a-f0-9]{64})(?:[\\/]|$)/,
        );
        return match?.[1] || null;
      })
      .filter((entry): entry is string => Boolean(entry)),
  );
  const retainedGenerations: string[] = [];
  try {
    for (const generationDir of selectedGenerations) {
      retainControlGeneration(generationDir);
      retainedGenerations.push(generationDir);
      pruneExpiredControlGenerations(path.dirname(generationDir));
    }
  } catch (error) {
    for (const generationDir of retainedGenerations) {
      releaseControlGeneration(generationDir);
    }
    throw error;
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentIdentifier?: string,
  runtimePreference?: AgentRuntimeName | null,
): Promise<{
  args: string[];
  metadata: ContainerLaunchMetadata;
  launchEnv: Record<string, string>;
}> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];
  const launchEnv: Record<string, string> = {};
  const runtimeEndpointEnv = collectRuntimeEndpointEnv();
  const effectiveRuntimePreference = runtimePreference || AGENT_RUNTIME_DEFAULT;
  const useMiniMaxRuntime = wantsMiniMaxRuntime(effectiveRuntimePreference);
  const miniMaxRuntime = useMiniMaxRuntime ? collectMiniMaxRuntimeEnv() : null;
  let endpointMode: string | null = null;

  if (miniMaxRuntime) {
    runtimeEndpointEnv.ANTHROPIC_BASE_URL = miniMaxRuntime.anthropicBaseUrl;
    runtimeEndpointEnv.OPENAI_BASE_URL = miniMaxRuntime.openAiBaseUrl;
    endpointMode = miniMaxRuntime.configured
      ? 'minimax_direct'
      : 'minimax_missing_credentials';
  }

  const localOpenAiGatewayBinding = useMiniMaxRuntime
    ? null
    : resolveLocalOpenAiGatewayBinding(runtimeEndpointEnv);

  if (localOpenAiGatewayBinding) {
    runtimeEndpointEnv.ANTHROPIC_BASE_URL = localOpenAiGatewayBinding.endpoint;
    runtimeEndpointEnv.OPENAI_BASE_URL = localOpenAiGatewayBinding.endpoint;
    endpointMode = 'local_openai_gateway';
    if (
      !hasContainerFlagValue(
        args,
        '--network',
        localOpenAiGatewayBinding.network,
      )
    ) {
      args.push('--network', localOpenAiGatewayBinding.network);
    }
    logger.info(
      {
        component: 'container',
        containerName,
        network: localOpenAiGatewayBinding.network,
      },
      'Using local OpenAI gateway container binding',
    );
  }

  const runtimeEndpointEnvForContainer =
    rewriteRuntimeEndpointEnvForContainer(runtimeEndpointEnv);
  for (const value of Object.values(runtimeEndpointEnvForContainer)) {
    validateRuntimeEndpointUrl(value);
  }
  const modelOverrides = resolveModelOverridesForRuntime(
    runtimeEndpointEnvForContainer,
    effectiveRuntimePreference,
    miniMaxRuntime,
  );
  const selectedModel =
    modelOverrides.NANOCLAW_AGENT_MODEL ||
    modelOverrides.CLAUDE_CODE_MODEL ||
    modelOverrides.CLAUDE_MODEL ||
    null;

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `NANOCLAW_CONTAINER_RUNTIME=${CONTAINER_RUNTIME_NAME}`);

  // OneCLI gateway handles credential injection — containers never see real secrets.
  // The gateway intercepts HTTPS traffic and injects API keys or OAuth tokens.
  const argsBeforeOneCli = [...args];
  const onecliApplied = await onecli.applyContainerConfig(args, {
    addHostMapping: false, // Nanoclaw already handles host gateway
    agent: agentIdentifier,
  });
  if (onecliApplied) {
    validateOneCliAddedArgs(argsBeforeOneCli, args);
    endpointMode = endpointMode ? `${endpointMode}+onecli` : 'onecli_gateway';
    for (const [key, value] of Object.entries(runtimeEndpointEnvForContainer)) {
      appendContainerEnv(args, launchEnv, key, value);
    }
    for (const [key, value] of Object.entries(modelOverrides)) {
      appendContainerEnv(args, launchEnv, key, value);
    }
    if (
      runtimeEndpointEnvForContainer.ANTHROPIC_BASE_URL &&
      !hasAnthropicAuthEnvArg(args)
    ) {
      // Claude SDK expects an auth token env var to be present. When OneCLI
      // handles real credential injection, this placeholder is replaced at the
      // gateway layer and the real secret never enters the container.
      appendContainerEnv(
        args,
        launchEnv,
        'ANTHROPIC_AUTH_TOKEN',
        ONECLI_AUTH_PLACEHOLDER,
      );
    }
    if (modelOverrides.NANOCLAW_AGENT_MODEL === 'cu/default') {
      logger.info(
        { component: 'container', containerName },
        'Detected 9router endpoint; defaulting model override to cu/default',
      );
    }
    logger.info(
      { component: 'container', containerName, endpointMode, selectedModel },
      'OneCLI gateway config applied',
    );
  } else {
    const fallbackCredentials = collectFallbackCredentialEnv(
      runtimeEndpointEnvForContainer,
      effectiveRuntimePreference,
    );
    const passthroughEnv = {
      ...runtimeEndpointEnvForContainer,
      ...fallbackCredentials,
      ...modelOverrides,
    };
    endpointMode =
      Object.keys(passthroughEnv).length > 0
        ? 'degraded_env_fallback'
        : 'no_runtime_env';

    for (const [key, value] of Object.entries(passthroughEnv)) {
      appendContainerEnv(args, launchEnv, key, value);
    }

    if (Object.keys(passthroughEnv).length > 0) {
      logger.warn(
        {
          component: 'container',
          containerName,
          fallbackKeys: Object.keys(passthroughEnv),
          endpointMode,
          selectedModel,
        },
        'OneCLI gateway not reachable — using .env credential passthrough fallback',
      );
    } else {
      logger.warn(
        { component: 'container', containerName, endpointMode },
        'OneCLI gateway not reachable and no fallback credentials found',
      );
    }
  }

  // OneCLI may return `-e KEY=value`. Normalize sensitive values back into the
  // child environment so no credential ever appears in container argv.
  normalizeSensitiveContainerEnvArgs(args, launchEnv);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push(...writableMountArgs(mount.hostPath, mount.containerPath));
    }
  }

  args.push(CONTAINER_IMAGE);

  return {
    args: normalizeRuntimeArgs(args),
    launchEnv,
    metadata: {
      selectedModel,
      endpointMode,
    },
  };
}

function buildSanitizedStderrTail(
  stderr: string,
  maxChars = 800,
): string | null {
  const sanitized = sanitizeLogString(stderr || '').trim();
  if (!sanitized) return null;
  if (sanitized.length <= maxChars) return sanitized;
  return sanitized.slice(sanitized.length - maxChars);
}

function buildFailureOutput(params: {
  error: string;
  failureKind: NonNullable<ContainerOutput['failureKind']>;
  failureStage: NonNullable<ContainerOutput['failureStage']>;
  diagnosticHint: string;
  logFile?: string;
  stderr?: string;
  selectedModel?: string | null;
  endpointMode?: string | null;
  recoveryAttempted?: boolean;
  sawLifecycleOnlyOutput?: boolean;
  firstResultSubtype?: string | null;
  runtimeToolEvidence?: RuntimeToolEvidenceV1;
}): ContainerOutput {
  return {
    status: 'error',
    result: null,
    error: params.error,
    logFile: params.logFile,
    failureKind: params.failureKind,
    failureStage: params.failureStage,
    diagnosticHint: params.diagnosticHint,
    stderrTail: buildSanitizedStderrTail(params.stderr || '') || undefined,
    selectedModel: params.selectedModel || null,
    endpointMode: params.endpointMode || null,
    recoveryAttempted: params.recoveryAttempted || undefined,
    sawLifecycleOnlyOutput: params.sawLifecycleOnlyOutput || undefined,
    firstResultSubtype: params.firstResultSubtype || null,
    runtimeToolEvidence: params.runtimeToolEvidence,
  };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (
    proc: ChildProcess,
    containerName: string,
    ipcContext: ContainerIpcContext,
  ) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  assertContainerRuntimeTrustBoundary(CONTAINER_RUNTIME_NAME);
  const startTime = Date.now();

  // The host mount/session/IPC boundary must use the same fail-closed policy
  // that is serialized to the independently validating container runner.
  input = {
    ...input,
    requestPolicy: normalizeAssistantRequestPolicy(input.requestPolicy),
  };

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const knownRoutes = new Set<AssistantRequestPolicy['route']>([
    'direct_assistant',
    'protected_assistant',
    'control_plane',
    'advanced_helper',
    'code_plane',
  ]);
  const requestedRoute = input.requestPolicy?.route;
  const mountRoute =
    requestedRoute && knownRoutes.has(requestedRoute)
      ? requestedRoute
      : 'direct_assistant';
  const ipcContext: ContainerIpcContext = {
    runId: randomUUID(),
    authToken: randomBytes(32).toString('base64url'),
    inputDir: '',
  };
  ipcContext.inputDir = path.join(
    resolveGroupIpcPath(group.folder),
    'input',
    getAssistantCapabilityLane(mountRoute),
    ipcContext.runId,
  );
  fs.mkdirSync(ipcContext.inputDir, { recursive: true });
  input = {
    ...input,
    ipcRunId: ipcContext.runId,
    ipcAuthToken: ipcContext.authToken,
  };
  const hostActionSafeBuiltins = new Set([
    'Read',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
  ]);
  const allowHostActionIpc = Boolean(
    input.requestPolicy &&
    input.requestPolicy.mcpTools.length > 0 &&
    input.requestPolicy.builtinTools.every((tool) =>
      hostActionSafeBuiltins.has(tool),
    ),
  );
  const projectViewBuiltins = new Set([
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'NotebookEdit',
  ]);
  const mountProjectView = Boolean(
    input.requestPolicy?.builtinTools.some((tool) =>
      projectViewBuiltins.has(tool),
    ),
  );
  const skillControlMode = resolveTrustedSkillControlMode(
    input.requestPolicy?.route,
    input.requestPolicy?.builtinTools || [],
    input.requestPolicy?.mcpTools || [],
  );
  let mounts: VolumeMount[];
  try {
    mounts = buildVolumeMounts(
      group,
      input.isMain,
      mountRoute,
      input.freshSessionHome === true,
      allowHostActionIpc,
      mountProjectView,
      skillControlMode,
      ipcContext.inputDir,
    );
  } catch (error) {
    fs.rmSync(ipcContext.inputDir, { recursive: true, force: true });
    throw error;
  }
  const controlGenerationDirs = new Set(
    mounts
      .map((mount) => {
        const match = mount.hostPath.match(
          /^(.*[\\/](?:container-controls[\\/].*?|container-project-views)[\\/]generation-[a-f0-9]{64})(?:[\\/]|$)/,
        );
        return match?.[1] || null;
      })
      .filter((entry): entry is string => Boolean(entry)),
  );
  let controlsReleased = false;
  const releaseControls = (): void => {
    if (controlsReleased) return;
    controlsReleased = true;
    for (const generationDir of controlGenerationDirs) {
      releaseControlGeneration(generationDir);
    }
    fs.rmSync(ipcContext.inputDir, { recursive: true, force: true });
  };
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  // Main group uses the default OneCLI agent; others use their own agent.
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  let launchConfig: Awaited<ReturnType<typeof buildContainerArgs>>;
  try {
    launchConfig = await buildContainerArgs(
      mounts,
      containerName,
      agentIdentifier,
      input.preferredRuntime,
    );
  } catch (err) {
    releaseControls();
    throw err;
  }
  const {
    args: containerArgs,
    metadata: launchMetadata,
    launchEnv,
  } = launchConfig;
  const containerArgsForLogs = sanitizeContainerArgsForLogs(containerArgs);
  const sanitizeRuntimeText = (value: string): string =>
    sanitizeContainerRuntimeText(value, {
      ...launchEnv,
      NANOCLAW_IPC_AUTH_TOKEN: ipcContext.authToken,
    });

  logger.debug(
    {
      component: 'container',
      chatJid: input.chatJid,
      groupFolder: group.folder,
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgsForLogs.join(' '),
      selectedModel: launchMetadata.selectedModel,
      endpointMode: launchMetadata.endpointMode,
      route: input.requestPolicy?.route || null,
    },
    'Container mount configuration',
  );

  logger.info(
    {
      component: 'container',
      chatJid: input.chatJid,
      groupFolder: group.folder,
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
      selectedModel: launchMetadata.selectedModel,
      endpointMode: launchMetadata.endpointMode,
      route: input.requestPolicy?.route || null,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const logContext = {
    component: 'container' as const,
    chatJid: input.chatJid,
    groupFolder: group.folder,
    containerName,
  };

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildContainerChildEnv(launchEnv, containerArgs),
    });

    onProcess(container, containerName, ipcContext);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let timedOut = false;
    let timeoutReason: 'hard' | 'no_output' | null = null;
    let hadStreamingOutput = false;
    let hadStructuredOutput = false;
    let hadUserVisibleAssistantResult = false;
    let hadLifecycleOnlyOutput = false;
    let recoveryAttempted = false;
    let firstResultSubtype: string | null = null;
    let terminalDirectAssistantErrorOutput: ContainerOutput | null = null;
    const runtimeToolEvidenceById = new Map<string, RuntimeToolEvidenceV1>();
    let latestRuntimeToolEvidence: RuntimeToolEvidenceV1 | null = null;

    const normalizeOutputRuntimeToolEvidence = (
      output: ContainerOutput,
    ): ContainerOutput => {
      const rawOutput = output as ContainerOutput & Record<string, unknown>;
      let streamedRuntimeToolEvidence: RuntimeToolEvidenceV1 | null = null;
      if (
        Object.prototype.hasOwnProperty.call(rawOutput, 'runtimeToolEvidence')
      ) {
        const candidate = normalizeRuntimeToolEvidenceV1(
          rawOutput.runtimeToolEvidence,
        );
        if (candidate) {
          const current = runtimeToolEvidenceById.get(candidate.evidenceId);
          const merged = current
            ? mergeRuntimeToolEvidenceV1(current, candidate)
            : candidate;
          if (merged) {
            runtimeToolEvidenceById.set(candidate.evidenceId, merged);
            streamedRuntimeToolEvidence = merged;
          }
          latestRuntimeToolEvidence = collapseRuntimeToolEvidenceV1([
            ...runtimeToolEvidenceById.values(),
          ]);
        } else {
          logger.warn(
            { ...logContext, group: group.name },
            'Discarded invalid runtime tool evidence from container output',
          );
        }
      }

      const normalized = { ...output };
      if (typeof normalized.result === 'string') {
        normalized.result = sanitizeRuntimeText(normalized.result);
      }
      if (typeof normalized.error === 'string') {
        normalized.error = sanitizeRuntimeText(normalized.error);
      }
      if (typeof normalized.diagnosticHint === 'string') {
        normalized.diagnosticHint = sanitizeRuntimeText(
          normalized.diagnosticHint,
        );
      }
      if (typeof normalized.stderrTail === 'string') {
        normalized.stderrTail = sanitizeRuntimeText(normalized.stderrTail);
      }
      if (streamedRuntimeToolEvidence) {
        // A marker belongs to exactly one logical SDK query. Never attach the
        // all-query aggregate here: the persistent container may later serve
        // another IPC query, and streaming a composite would let callers
        // double-count or attribute that later query to the wrong turn.
        normalized.runtimeToolEvidence = streamedRuntimeToolEvidence;
      } else {
        delete normalized.runtimeToolEvidence;
      }
      return normalized;
    };

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const effectiveIdleTimeout = resolveEffectiveIdleTimeout(
      input.idleTimeoutMs ?? IDLE_TIMEOUT,
      configTimeout,
    );
    // Grace period: hard timeout must be at least idle timeout + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(
      configTimeout,
      effectiveIdleTimeout + CONTAINER_CLOSE_GRACE_PERIOD_MS,
    );
    const initialOutputTimeoutMs = Math.max(
      1_000,
      Math.min(timeoutMs, CONTAINER_INITIAL_OUTPUT_TIMEOUT),
    );

    const stopContainerGracefully = (reason: string) => {
      try {
        stopContainer(containerName);
      } catch (err) {
        logger.warn(
          { ...logContext, group: group.name, err, reason },
          'Graceful stop failed, force killing',
        );
        container.kill('SIGKILL');
      }
    };

    const killOnTimeout = () => {
      timedOut = true;
      timeoutReason = 'hard';
      logger.error(
        { ...logContext, group: group.name, timeoutMs },
        'Container timeout, stopping gracefully',
      );
      stopContainerGracefully('hard_timeout');
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the hard timeout whenever there's structured output activity
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    const killOnInitialOutputTimeout = () => {
      if (hadStructuredOutput) return;
      timedOut = true;
      timeoutReason = 'no_output';
      logger.error(
        {
          ...logContext,
          group: group.name,
          initialOutputTimeoutMs,
          selectedModel: launchMetadata.selectedModel,
          endpointMode: launchMetadata.endpointMode,
          route: input.requestPolicy?.route || null,
          recoveryAttempted,
          sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
          firstResultSubtype,
        },
        'Container produced no structured output before initial timeout',
      );
      stopContainerGracefully('initial_output_timeout');
    };

    const initialOutputTimeout = setTimeout(
      killOnInitialOutputTimeout,
      initialOutputTimeoutMs,
    );

    const clearInitialOutputTimeout = () => {
      clearTimeout(initialOutputTimeout);
    };

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { ...logContext, group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (
        chunk.includes(OUTPUT_START_MARKER) ||
        chunk.includes(OUTPUT_END_MARKER)
      ) {
        hadStructuredOutput = true;
        clearInitialOutputTimeout();
        logger.debug(
          {
            ...logContext,
            group: group.name,
            selectedModel: launchMetadata.selectedModel,
            endpointMode: launchMetadata.endpointMode,
          },
          'Received first structured output marker from container',
        );
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed = normalizeOutputRuntimeToolEvidence(
              JSON.parse(jsonStr) as ContainerOutput,
            );
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            if (parsed.recoveryAttempted) {
              recoveryAttempted = true;
            }
            if (!firstResultSubtype && parsed.firstResultSubtype) {
              firstResultSubtype = parsed.firstResultSubtype;
            }
            const normalizedResult =
              typeof parsed.result === 'string' ? parsed.result.trim() : '';
            if (parsed.status === 'success' && normalizedResult) {
              hadUserVisibleAssistantResult = true;
            } else if (parsed.status === 'success' && !normalizedResult) {
              hadLifecycleOnlyOutput = true;
            } else if (
              parsed.status === 'error' &&
              input.requestPolicy?.route === 'direct_assistant'
            ) {
              terminalDirectAssistantErrorOutput = {
                ...parsed,
                recoveryAttempted:
                  parsed.recoveryAttempted || recoveryAttempted || undefined,
                sawLifecycleOnlyOutput:
                  parsed.sawLifecycleOnlyOutput ||
                  hadLifecycleOnlyOutput ||
                  undefined,
                firstResultSubtype:
                  parsed.firstResultSubtype || firstResultSubtype || null,
              };
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { ...logContext, group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        logger.trace(
          {
            ...logContext,
            group: group.name,
          },
          sanitizeRuntimeText(line),
        );
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { ...logContext, group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      releaseControls();
      clearTimeout(timeout);
      clearInitialOutputTimeout();
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Timeout Reason: ${timeoutReason || 'unknown'}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
            `Had User Visible Assistant Result: ${hadUserVisibleAssistantResult}`,
            `Had Lifecycle Only Output: ${hadLifecycleOnlyOutput}`,
            `Recovery Attempted: ${recoveryAttempted}`,
            `First Result Subtype: ${firstResultSubtype || 'none'}`,
            ``,
            `=== Container Args ===`,
            containerArgsForLogs.join(' '),
            ``,
            `=== Stderr Tail ===`,
            buildSanitizedStderrTail(sanitizeRuntimeText(stderr)) || '(empty)',
            ``,
            `=== Stdout Tail ===`,
            sanitizeRuntimeText(stdout.slice(-800) || '(empty)'),
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            {
              ...logContext,
              group: group.name,
              duration,
              code,
              route: input.requestPolicy?.route || null,
              recoveryAttempted,
              sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
              firstResultSubtype,
            },
            hadUserVisibleAssistantResult
              ? 'Container timed out after output (idle cleanup)'
              : 'Container timed out after lifecycle-only output',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              recoveryAttempted: recoveryAttempted || undefined,
              sawLifecycleOnlyOutput: hadLifecycleOnlyOutput || undefined,
              firstResultSubtype,
              runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
            });
          });
          return;
        }

        if (timeoutReason === 'no_output') {
          logger.error(
            {
              ...logContext,
              group: group.name,
              duration,
              code,
              initialOutputTimeoutMs,
              selectedModel: launchMetadata.selectedModel,
              endpointMode: launchMetadata.endpointMode,
              route: input.requestPolicy?.route || null,
              recoveryAttempted,
              sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
              firstResultSubtype,
              stderrTail: buildSanitizedStderrTail(sanitizeRuntimeText(stderr)),
            },
            'Container timed out waiting for initial structured output',
          );
          resolve(
            buildFailureOutput({
              error: `Container produced no structured output within ${initialOutputTimeoutMs}ms.`,
              failureKind: 'initial_output_timeout',
              failureStage: 'startup',
              diagnosticHint:
                'container did not emit first structured result before timeout',
              logFile: timeoutLog,
              stderr: sanitizeRuntimeText(stderr),
              selectedModel: launchMetadata.selectedModel,
              endpointMode: launchMetadata.endpointMode,
              recoveryAttempted,
              sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
              firstResultSubtype,
              runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
            }),
          );
          return;
        }

        logger.error(
          {
            ...logContext,
            group: group.name,
            duration,
            code,
            configTimeout,
            route: input.requestPolicy?.route || null,
            recoveryAttempted,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
            firstResultSubtype,
            stderrTail: buildSanitizedStderrTail(sanitizeRuntimeText(stderr)),
          },
          'Container timed out with no output',
        );
        resolve(
          buildFailureOutput({
            error: `Container timed out after ${configTimeout}ms`,
            failureKind: 'runtime_bootstrap_failed',
            failureStage: 'runtime',
            diagnosticHint: hadLifecycleOnlyOutput
              ? 'container produced lifecycle-only output but never reached a real assistant answer before the hard timeout'
              : 'container exceeded the configured hard timeout',
            logFile: timeoutLog,
            stderr: sanitizeRuntimeText(stderr),
            selectedModel: launchMetadata.selectedModel,
            endpointMode: launchMetadata.endpointMode,
            recoveryAttempted,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
            firstResultSubtype,
            runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
          }),
        );
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = isLogLevelEnabled('trace', logContext);

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;
      const shouldPersistFullLog =
        isVerbose || isError || Boolean(terminalDirectAssistantErrorOutput);

      if (shouldPersistFullLog) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(
            `=== Input ===`,
            sanitizeRuntimeText(JSON.stringify(input, null, 2)),
            ``,
          );
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgsForLogs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          sanitizeRuntimeText(stderr),
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          sanitizeRuntimeText(stdout),
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug(
        { ...logContext, logFile, verbose: isVerbose },
        'Container log written',
      );

      if (
        code !== 0 &&
        onOutput &&
        hadUserVisibleAssistantResult &&
        !terminalDirectAssistantErrorOutput
      ) {
        logger.info(
          {
            ...logContext,
            group: group.name,
            code,
            duration,
            logFile,
            route: input.requestPolicy?.route || null,
            recoveryAttempted,
            firstResultSubtype,
          },
          'Container exited non-zero after user-visible output (post-output cleanup)',
        );
        outputChain.then(() => {
          resolve({
            status: 'success',
            result: null,
            newSessionId,
            recoveryAttempted: recoveryAttempted || undefined,
            firstResultSubtype,
            runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
          });
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          {
            ...logContext,
            group: group.name,
            code,
            duration,
            stderrTail: buildSanitizedStderrTail(sanitizeRuntimeText(stderr)),
            stdoutTail: sanitizeRuntimeText(stdout.slice(-400)),
            logFile,
            selectedModel: launchMetadata.selectedModel,
            endpointMode: launchMetadata.endpointMode,
            route: input.requestPolicy?.route || null,
            recoveryAttempted,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
            firstResultSubtype,
          },
          'Container exited with error',
        );

        resolve(
          buildFailureOutput({
            error: `Container exited with code ${code}: ${sanitizeRuntimeText(stderr.slice(-200))}`,
            failureKind: 'runtime_bootstrap_failed',
            failureStage: 'runtime',
            diagnosticHint:
              'container exited non-zero before producing a stable result',
            logFile,
            stderr: sanitizeRuntimeText(stderr),
            selectedModel: launchMetadata.selectedModel,
            endpointMode: launchMetadata.endpointMode,
            recoveryAttempted,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
            firstResultSubtype,
            runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
          }),
        );
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          if (
            input.requestPolicy?.route === 'direct_assistant' &&
            terminalDirectAssistantErrorOutput &&
            !hadUserVisibleAssistantResult
          ) {
            logger.warn(
              {
                ...logContext,
                group: group.name,
                duration,
                logFile,
                route: input.requestPolicy?.route,
                error: terminalDirectAssistantErrorOutput.error,
                diagnosticHint:
                  terminalDirectAssistantErrorOutput.diagnosticHint,
                recoveryAttempted,
                sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
                firstResultSubtype,
              },
              'Container completed after terminal direct assistant error',
            );
            resolve({
              ...terminalDirectAssistantErrorOutput,
              logFile,
              recoveryAttempted:
                terminalDirectAssistantErrorOutput.recoveryAttempted ||
                recoveryAttempted ||
                undefined,
              sawLifecycleOnlyOutput:
                terminalDirectAssistantErrorOutput.sawLifecycleOnlyOutput ||
                hadLifecycleOnlyOutput ||
                undefined,
              firstResultSubtype:
                terminalDirectAssistantErrorOutput.firstResultSubtype ||
                firstResultSubtype,
              runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
            });
            return;
          }
          logger.info(
            {
              ...logContext,
              group: group.name,
              duration,
              newSessionId,
              route: input.requestPolicy?.route || null,
              recoveryAttempted,
              sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
              firstResultSubtype,
            },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
            recoveryAttempted: recoveryAttempted || undefined,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput || undefined,
            firstResultSubtype,
            runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output = normalizeOutputRuntimeToolEvidence(
          JSON.parse(jsonLine) as ContainerOutput,
        );

        logger.info(
          {
            ...logContext,
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            ...logContext,
            group: group.name,
            stdoutTail: sanitizeRuntimeText(stdout.slice(-400)),
            stderrTail: buildSanitizedStderrTail(sanitizeRuntimeText(stderr)),
            error: err,
          },
          'Failed to parse container output',
        );

        resolve(
          buildFailureOutput({
            error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
            failureKind: 'runtime_bootstrap_failed',
            failureStage: 'parse',
            diagnosticHint:
              'container returned output that could not be parsed cleanly',
            logFile,
            stderr: sanitizeRuntimeText(stderr),
            selectedModel: launchMetadata.selectedModel,
            endpointMode: launchMetadata.endpointMode,
            recoveryAttempted,
            sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
            firstResultSubtype,
            runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
          }),
        );
      }
    });

    container.on('error', (err) => {
      releaseControls();
      clearTimeout(timeout);
      clearInitialOutputTimeout();
      logger.error(
        {
          ...logContext,
          group: group.name,
          error: err,
          selectedModel: launchMetadata.selectedModel,
          endpointMode: launchMetadata.endpointMode,
        },
        'Container spawn error',
      );
      resolve(
        buildFailureOutput({
          error: `Container spawn error: ${err.message}`,
          failureKind: 'container_runtime_unavailable',
          failureStage: 'spawn',
          diagnosticHint: 'container runtime could not start the agent process',
          stderr: sanitizeRuntimeText(stderr),
          selectedModel: launchMetadata.selectedModel,
          endpointMode: launchMetadata.endpointMode,
          recoveryAttempted,
          sawLifecycleOnlyOutput: hadLifecycleOnlyOutput,
          firstResultSubtype,
          runtimeToolEvidence: latestRuntimeToolEvidence || undefined,
        }),
      );
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const visibleTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);
  // Serialize an explicit public shape. Legacy task rows may still contain
  // inert script text, but executable content and secrets never belong in a
  // container-readable snapshot even if an untyped caller supplies it.
  const filteredTasks = visibleTasks.map((task) => ({
    id: task.id,
    groupFolder: task.groupFolder,
    prompt: task.prompt,
    schedule_type: task.schedule_type,
    schedule_value: task.schedule_value,
    status: task.status,
    next_run: task.next_run,
  }));

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableOpenClawSkill {
  chatJid: string;
  groupFolder: string;
  groupName: string;
  skillId: string;
  displayName: string;
  sourceUrl: string;
  canonicalClawHubUrl: string | null;
  githubTreeUrl: string;
  installDirName: string;
  enabledAt: string;
  security: {
    virusTotalStatus: string | null;
    openClawStatus: string | null;
    openClawSummary: string | null;
  };
}

export function writeOpenClawSkillsSnapshot(
  groupFolder: string,
  isMain: boolean,
  skills: AvailableOpenClawSkill[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleSkills = isMain
    ? skills
    : skills.filter((skill) => skill.groupFolder === groupFolder);

  const skillsFile = path.join(groupIpcDir, 'current_openclaw_skills.json');
  fs.writeFileSync(
    skillsFile,
    JSON.stringify(
      {
        skills: visibleSkills,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export interface AvailableCursorArtifact {
  absolutePath: string;
  sizeBytes: number | null;
  updatedAt: string | null;
  downloadUrl: string | null;
  downloadUrlExpiresAt: string | null;
  syncedAt: string;
}

export interface AvailableCursorAgent {
  id: string;
  chatJid: string;
  groupFolder: string;
  groupName: string;
  status: string;
  model: string | null;
  promptText: string;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourcePrUrl: string | null;
  targetUrl: string | null;
  targetPrUrl: string | null;
  targetBranchName: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string | null;
  artifacts: AvailableCursorArtifact[];
}

export function writeCursorAgentsSnapshot(
  groupFolder: string,
  isMain: boolean,
  agents: AvailableCursorAgent[],
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleAgents = isMain
    ? agents
    : agents.filter((agent) => agent.groupFolder === groupFolder);

  const cursorFile = path.join(groupIpcDir, 'current_cursor_agents.json');
  fs.writeFileSync(
    cursorFile,
    JSON.stringify(
      {
        agents: visibleAgents,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
