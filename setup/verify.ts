/**
 * Step: verify - End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_URL, RUNTIME_STATE_DIR, STORE_DIR } from '../src/config.js';
import { runContainerAgent } from '../src/container-runner.js';
import {
  getContainerRuntimeStatus,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { setAssistantExecutionProbeState } from '../src/debug-control.js';
import { initDatabase } from '../src/db.js';
import { readEnvFile } from '../src/env.js';
import { resolveGroupIpcPath } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import type { RegisteredGroup } from '../src/types.js';
import {
  getNodeMajorVersion,
  getNodeVersion,
  getPlatform,
  getServiceManager,
  isRoot,
} from './platform.js';
import { emitStatus } from './status.js';

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const ONECLI_CREDENTIAL_ENV_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
] as const;
const MODEL_OVERRIDE_ENV_KEYS = [
  'NANOCLAW_AGENT_MODEL',
  'CLAUDE_CODE_MODEL',
  'CLAUDE_MODEL',
] as const;

interface CredentialRuntimeProbeResult {
  status: 'ok' | 'skipped' | 'failed';
  reason: string;
  detail?: string;
}

export interface AssistantExecutionProbeResult {
  status: 'ok' | 'skipped' | 'failed';
  reason: string;
  detail?: string;
}

interface LocalOpenAiGatewayState {
  runtime?: string;
  network?: string;
  endpoint?: string;
  host_health?: string;
}

const LOCAL_GATEWAY_STATE_PATH = path.join(
  RUNTIME_STATE_DIR,
  'openai-gateway-state.json',
);
const LOCAL_ENDPOINT_HOST_ALIASES = new Set([
  'host.containers.internal',
  'host.docker.internal',
  'litellm-gateway',
  'nanoclaw-litellm',
  '127.0.0.1',
  'localhost',
]);

function normalizeProbeEndpoint(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeHostProbeEndpointFromHealth(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;

  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    // Host health endpoints typically end in /health; strip to base origin.
    if (parsed.pathname.toLowerCase().endsWith('/health')) {
      parsed.pathname = parsed.pathname.slice(0, -'/health'.length) || '/';
      parsed.search = '';
      parsed.hash = '';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function readLocalOpenAiGatewayState(): LocalOpenAiGatewayState | null {
  if (!fs.existsSync(LOCAL_GATEWAY_STATE_PATH)) {
    return null;
  }

  try {
    const raw = fs
      .readFileSync(LOCAL_GATEWAY_STATE_PATH, 'utf-8')
      .replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as LocalOpenAiGatewayState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveCredentialProbeEndpoints(input: {
  configuredEndpoint: string;
  gatewayState?: LocalOpenAiGatewayState | null;
}): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string | null): void => {
    if (!value) return;
    const normalized = normalizeProbeEndpoint(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  pushCandidate(input.configuredEndpoint);

  const normalizedConfigured = normalizeProbeEndpoint(input.configuredEndpoint);
  if (normalizedConfigured) {
    try {
      const parsed = new URL(normalizedConfigured);
      const host = parsed.hostname.toLowerCase();
      if (LOCAL_ENDPOINT_HOST_ALIASES.has(host)) {
        parsed.hostname = '127.0.0.1';
        pushCandidate(parsed.toString());
      }
    } catch {
      // Invalid configured endpoint is handled by normalizeProbeEndpoint.
    }
  }

  const gatewayState = input.gatewayState;
  if (gatewayState) {
    pushCandidate(gatewayState.endpoint || null);
    pushCandidate(
      gatewayState.host_health
        ? normalizeHostProbeEndpointFromHealth(gatewayState.host_health)
        : null,
    );
  }

  return candidates;
}

export function buildCredentialProbeMessagesUrl(
  endpoint: string,
): string | null {
  const normalized = normalizeProbeEndpoint(endpoint);
  if (!normalized) return null;

  try {
    const parsed = new URL(normalized);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = basePath.endsWith('/v1')
      ? `${basePath}/messages`
      : `${basePath}/v1/messages`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function truncateDetail(value: string, max = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 3)}...`;
}

function appendProbeDetail(base: string | undefined, next: string): string {
  const left = (base || '').trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} | ${right}`;
}

function hasLocalGatewayCandidate(endpoints: string[]): boolean {
  for (const endpoint of endpoints) {
    try {
      const parsed = new URL(endpoint);
      if (LOCAL_ENDPOINT_HOST_ALIASES.has(parsed.hostname.toLowerCase())) {
        return true;
      }
    } catch {
      // Ignore invalid endpoint entries.
    }
  }
  return false;
}

function isHostLocalRetryCandidate(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function classifyCredentialProbeFailure(input: {
  statusCode?: number;
  body?: string;
  errorMessage?: string;
}): {
  reason: string;
  detail: string;
} {
  const body = (input.body || '').toLowerCase();
  const errorMessage = (input.errorMessage || '').toLowerCase();
  const hasInvalidModelSignal =
    body.includes('invalid model name') ||
    body.includes('invalid model') ||
    body.includes('model_not_found') ||
    body.includes('unknown model');

  if (body.includes('insufficient_quota')) {
    return {
      reason: 'insufficient_quota',
      detail:
        'OpenAI key is reachable but out of quota/billing. Top up or replace OPENAI_API_KEY.',
    };
  }
  if (hasInvalidModelSignal) {
    return {
      reason: 'invalid_model_alias',
      detail:
        'Gateway rejected the requested model alias. Set NANOCLAW_AGENT_MODEL to a supported alias.',
    };
  }
  if (
    input.statusCode === 401 ||
    input.statusCode === 403 ||
    body.includes('invalid_api_key') ||
    body.includes('authentication') ||
    body.includes('unauthorized')
  ) {
    return {
      reason: 'auth_failed',
      detail:
        'Gateway authentication failed. Check OPENAI_API_KEY / ANTHROPIC_AUTH_TOKEN.',
    };
  }
  if (input.statusCode === 404) {
    return {
      reason: 'unsupported_endpoint',
      detail:
        'Gateway does not expose /v1/messages. Use an Anthropic-compatible endpoint.',
    };
  }
  if (
    errorMessage.includes('fetch failed') ||
    errorMessage.includes('timed out') ||
    errorMessage.includes('econnrefused') ||
    errorMessage.includes('enotfound')
  ) {
    return {
      reason: 'network_error',
      detail: `Runtime probe network failure: ${truncateDetail(input.errorMessage || '')}`,
    };
  }

  if (input.statusCode) {
    return {
      reason: `http_${input.statusCode}`,
      detail: truncateDetail(input.body || `HTTP ${input.statusCode}`),
    };
  }
  if (input.errorMessage) {
    return {
      reason: 'runtime_error',
      detail: truncateDetail(input.errorMessage),
    };
  }
  return {
    reason: 'runtime_error',
    detail: 'Credential runtime probe failed for an unknown reason.',
  };
}

export async function probeCredentialRuntime(input: {
  endpoints: string[];
  authToken: string | undefined;
  model: string;
  maxHostLocalAttempts?: number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
}): Promise<CredentialRuntimeProbeResult> {
  if (input.endpoints.length === 0) {
    return {
      status: 'skipped',
      reason: 'invalid_endpoint',
      detail: 'Configured endpoint is not a valid URL.',
    };
  }
  if (!input.authToken) {
    return {
      status: 'skipped',
      reason: 'missing_auth_token',
    };
  }

  let firstNonNetworkFailure: CredentialRuntimeProbeResult | null = null;
  let lastFailure: CredentialRuntimeProbeResult | null = null;

  try {
    for (const endpoint of input.endpoints) {
      const probeUrl = buildCredentialProbeMessagesUrl(endpoint);
      if (!probeUrl) continue;

      const maxAttempts = isHostLocalRetryCandidate(endpoint)
        ? (input.maxHostLocalAttempts ?? 10)
        : 1;
      const requestTimeoutMs = input.requestTimeoutMs ?? 4_000;
      const retryDelayMs = input.retryDelayMs ?? 1_000;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(
            () => controller.abort(),
            requestTimeoutMs,
          );
          const response = await fetch(probeUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              'x-api-key': input.authToken,
            },
            body: JSON.stringify({
              model: input.model,
              max_tokens: 16,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.ok) {
            return {
              status: 'ok',
              reason: 'ok',
            };
          }

          const body = await response.text();
          const classified = classifyCredentialProbeFailure({
            statusCode: response.status,
            body,
          });
          const failedResult: CredentialRuntimeProbeResult = {
            status: 'failed',
            reason: classified.reason,
            detail: classified.detail,
          };

          if (
            classified.reason === 'network_error' &&
            attempt + 1 < maxAttempts
          ) {
            lastFailure = failedResult;
            await delay(retryDelayMs);
            continue;
          }

          if (
            classified.reason !== 'network_error' &&
            !firstNonNetworkFailure
          ) {
            firstNonNetworkFailure = failedResult;
          }
          lastFailure = failedResult;
          break;
        } catch (err) {
          const classified = classifyCredentialProbeFailure({
            errorMessage: err instanceof Error ? err.message : String(err),
          });
          const failedResult: CredentialRuntimeProbeResult = {
            status: 'failed',
            reason: classified.reason,
            detail: classified.detail,
          };

          if (
            classified.reason === 'network_error' &&
            attempt + 1 < maxAttempts
          ) {
            lastFailure = failedResult;
            await delay(retryDelayMs);
            continue;
          }

          if (
            classified.reason !== 'network_error' &&
            !firstNonNetworkFailure
          ) {
            firstNonNetworkFailure = failedResult;
          }
          lastFailure = failedResult;
          break;
        }
      }
    }

    if (firstNonNetworkFailure) {
      return firstNonNetworkFailure;
    }
    if (lastFailure) {
      return lastFailure;
    }

    return {
      status: 'skipped',
      reason: 'invalid_endpoint',
      detail: 'Configured endpoint is not a valid URL.',
    };
  } catch (err) {
    const classified = classifyCredentialProbeFailure({
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return {
      status: 'failed',
      reason: classified.reason,
      detail: classified.detail,
    };
  }
}

function requestContainerProbeClose(groupFolder: string): void {
  const inputDir = path.join(resolveGroupIpcPath(groupFolder), 'input');
  fs.mkdirSync(inputDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, '_close'), '');
}

export async function probeAssistantExecution(
  input: {
    requestTimeoutMs?: number;
    runProbe?: typeof runContainerAgent;
    requestClose?: (groupFolder: string) => void;
  } = {},
): Promise<AssistantExecutionProbeResult> {
  const probeGroup: RegisteredGroup = {
    name: 'Verify Runtime Probe',
    folder: 'verify_runtime_probe',
    trigger: '@andrea',
    added_at: new Date().toISOString(),
    containerConfig: {
      timeout: input.requestTimeoutMs ?? 20_000,
    },
  };

  const runProbe = input.runProbe || runContainerAgent;
  let sawStructuredOutput = false;
  let sawAssistantText = false;
  let sawLifecycleOnlyOutput = false;
  let sawRecoveryAttempt = false;
  let closeRequested = false;

  try {
    const output = await runProbe(
      probeGroup,
      {
        prompt: 'Reply with exactly: assistant execution probe ok.',
        groupFolder: probeGroup.folder,
        chatJid: 'verify:assistant-execution',
        isMain: false,
        assistantName: 'Andrea',
        idleTimeoutMs: 5_000,
        requestPolicy: {
          route: 'direct_assistant',
          reason: 'verify assistant execution probe',
          builtinTools: ['Read'],
          mcpTools: [],
          guidance: 'Reply with exactly: assistant execution probe ok.',
        },
      },
      () => {},
      async (streamedOutput) => {
        sawStructuredOutput = true;
        if (streamedOutput.recoveryAttempted) {
          sawRecoveryAttempt = true;
        }
        if (
          streamedOutput.status === 'success' &&
          typeof streamedOutput.result === 'string' &&
          streamedOutput.result.trim()
        ) {
          sawAssistantText = true;
        } else if (
          streamedOutput.status === 'success' &&
          !streamedOutput.result?.trim()
        ) {
          sawLifecycleOnlyOutput =
            streamedOutput.sawLifecycleOnlyOutput !== false;
        }
        if (closeRequested) return;
        if (
          sawAssistantText ||
          streamedOutput.status === 'error' ||
          sawLifecycleOnlyOutput
        ) {
          closeRequested = true;
          (input.requestClose || requestContainerProbeClose)(probeGroup.folder);
        }
      },
    );

    if (output.status === 'error') {
      return {
        status: 'failed',
        reason: output.failureKind || 'runtime_bootstrap_failed',
        detail: truncateDetail(
          [
            output.diagnosticHint || output.error || 'Assistant execution failed.',
            output.recoveryAttempted
              ? 'probe exhausted one recovery retry before failing'
              : '',
          ]
            .filter(Boolean)
            .join(' | '),
        ),
      };
    }

    if (!sawStructuredOutput) {
      return {
        status: 'failed',
        reason: 'initial_output_timeout',
        detail:
          'Execution probe completed without any structured assistant output.',
      };
    }

    if (!sawAssistantText) {
      return {
        status: 'failed',
        reason: 'runtime_bootstrap_failed',
        detail: truncateDetail(
          [
            sawLifecycleOnlyOutput
              ? 'Execution probe only produced lifecycle output, not a real assistant answer.'
              : 'Execution probe completed without a usable assistant answer.',
            sawRecoveryAttempt || output.recoveryAttempted
              ? 'probe exhausted one recovery retry before failing'
              : '',
          ]
            .filter(Boolean)
            .join(' | '),
        ),
      };
    }

    return {
      status: 'ok',
      reason: 'ok',
      detail: truncateDetail(
        [
          output.newSessionId ? `session=${output.newSessionId}` : '',
          sawRecoveryAttempt || output.recoveryAttempted
            ? 'assistant execution recovered after one retry'
            : 'assistant execution produced a real assistant answer',
        ]
          .filter(Boolean)
          .join(' | '),
      ),
    };
  } catch (err) {
    const detail = truncateDetail(
      err instanceof Error ? err.message : String(err),
    );
    return {
      status: 'failed',
      reason: 'runtime_bootstrap_failed',
      detail,
    };
  }
}

async function tryStartLocalGatewayForVerify(projectRoot: string): Promise<{
  ok: boolean;
  detail?: string;
}> {
  const scriptPath = path.join(
    projectRoot,
    'scripts',
    'start-openai-gateway.ps1',
  );
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      detail: `Gateway bootstrap script not found: ${scriptPath}`,
    };
  }

  try {
    const { execFileSync } = await import('child_process');
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      },
    );
    return {
      ok: true,
      detail: truncateDetail(output || ''),
    };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : JSON.stringify(err);
    return {
      ok: false,
      detail: truncateDetail(message),
    };
  }
}

export function isLikelyNativeOpenAiEndpoint(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;

  try {
    const parsed = new URL(
      /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`,
    );
    return parsed.hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function buildVerifyNextSteps(input: {
  missingRequirements: string[];
  hasNativeOpenAiEndpointMisconfig: boolean;
  credentialRuntimeProbeReason?: string;
  assistantExecutionProbeReason?: string;
  configuredChannels?: string[];
}): string {
  const steps: string[] = [];

  if (input.missingRequirements.includes('credentials')) {
    if (input.hasNativeOpenAiEndpointMisconfig) {
      steps.push(
        'Update OPENAI_BASE_URL/ANTHROPIC_BASE_URL to an Anthropic-compatible gateway (not api.openai.com) and keep OPENAI_API_KEY, or configure ANTHROPIC_* credentials.',
      );
    } else {
      steps.push(
        'Configure credentials with /init-onecli or set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN).',
      );
    }
  }

  if (input.missingRequirements.includes('channel_auth')) {
    steps.push(
      'Configure at least one channel token (TELEGRAM_BOT_TOKEN, DISCORD_BOT_TOKEN, SLACK_BOT_TOKEN+SLACK_APP_TOKEN, or WhatsApp auth).',
    );
  }

  if (input.missingRequirements.includes('registered_groups')) {
    if (input.configuredChannels?.includes('telegram')) {
      steps.push(
        'No groups are registered yet. In Telegram DM, send /registermain (or /chatid and then register manually).',
      );
    } else {
      steps.push(
        'From your main chat, register at least one group so NanoClaw has a routed destination.',
      );
    }
  }

  if (input.missingRequirements.includes('service_running')) {
    steps.push(
      'Start or repair the service with: npm run setup -- --step service',
    );
  }
  if (input.missingRequirements.includes('credential_runtime_unusable')) {
    if (input.credentialRuntimeProbeReason === 'insufficient_quota') {
      steps.push(
        'Runtime credential check failed: OpenAI key has insufficient quota. Top up billing, replace OPENAI_API_KEY, or switch to direct ANTHROPIC_* credentials.',
      );
    } else if (input.credentialRuntimeProbeReason === 'invalid_model_alias') {
      steps.push(
        'Runtime credential check failed: model alias mismatch. Set NANOCLAW_AGENT_MODEL=claude-3-5-sonnet-latest (or another gateway-supported alias).',
      );
    } else {
      steps.push(
        'Runtime credential check failed against the configured endpoint. Verify endpoint reachability and auth.',
      );
    }
  }

  if (input.missingRequirements.includes('assistant_execution_unusable')) {
    steps.push(
      input.assistantExecutionProbeReason === 'initial_output_timeout'
        ? 'Assistant execution probe failed before first output. Check /debug-status, /debug-logs current, and the container runtime path.'
        : 'Assistant execution probe failed inside the container runtime. Check /debug-status, /debug-logs current, and the latest group container log.',
    );
  }

  if (steps.length === 0) {
    return 'No missing requirements detected.';
  }

  return steps.join(' | ');
}

export interface CredentialStatusInput {
  hasAnthropicDirectCredential: boolean;
  hasOpenAiCompatibleCredential: boolean;
  onecliReachable: boolean;
  onecliCredentialKeys: string[];
}

export interface CredentialStatusResult {
  credentials: 'configured' | 'missing';
  credentialMode:
    | 'anthropic'
    | 'openai_compat'
    | 'anthropic_and_openai_compat'
    | 'onecli'
    | 'missing';
  credentialSources: string;
  onecliCredentialStatus:
    | 'configured'
    | 'reachable_credentials_unverified'
    | 'unreachable';
}

export function determineCredentialStatus(
  input: CredentialStatusInput,
): CredentialStatusResult {
  const hasOneCliCredential = input.onecliCredentialKeys.length > 0;
  const credentials =
    input.hasAnthropicDirectCredential ||
    input.hasOpenAiCompatibleCredential ||
    hasOneCliCredential
      ? 'configured'
      : 'missing';

  const credentialMode = input.hasAnthropicDirectCredential
    ? input.hasOpenAiCompatibleCredential
      ? 'anthropic_and_openai_compat'
      : 'anthropic'
    : input.hasOpenAiCompatibleCredential
      ? 'openai_compat'
      : hasOneCliCredential
        ? 'onecli'
        : 'missing';

  const credentialSources = [
    ...(input.hasAnthropicDirectCredential ||
    input.hasOpenAiCompatibleCredential
      ? ['env']
      : []),
    ...(hasOneCliCredential ? ['onecli'] : []),
  ].join(',');

  const onecliCredentialStatus = input.onecliReachable
    ? hasOneCliCredential
      ? 'configured'
      : 'reachable_credentials_unverified'
    : 'unreachable';

  return {
    credentials,
    credentialMode,
    credentialSources,
    onecliCredentialStatus,
  };
}

async function detectOneCliCredentialKeys(): Promise<{
  reachable: boolean;
  credentialKeys: string[];
}> {
  try {
    const onecli = new OneCLI({
      url: ONECLI_URL,
      timeout: 1500,
    });
    const config = await onecli.getContainerConfig();
    const env = config.env || {};
    const credentialKeys = ONECLI_CREDENTIAL_ENV_KEYS.filter((key) =>
      Boolean(env[key]),
    );
    return {
      reachable: true,
      credentialKeys,
    };
  } catch {
    return {
      reachable: false,
      credentialKeys: [],
    };
  }
}

async function isWindowsNanoclawPidRunning(
  pid: number,
  projectRoot: string,
): Promise<boolean> {
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
    const { execFileSync } = await import('child_process');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodeVersion = getNodeVersion() || process.version.replace(/^v/, '');
  const nodeMajor = getNodeMajorVersion();
  let nodeOk = nodeMajor === 22;
  const homeDir = os.homedir();

  initDatabase();
  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  const mgr = getServiceManager();

  // Windows fallback: allow service wrapper to pin Node 22 via npx launcher
  if (!nodeOk && platform === 'windows') {
    const wrapperPath = path.join(projectRoot, 'start-nanoclaw.ps1');
    if (fs.existsSync(wrapperPath)) {
      try {
        const wrapper = fs.readFileSync(wrapperPath, 'utf-8');
        if (wrapper.includes("'node@22'")) {
          nodeOk = true;
        }
      } catch {
        // wrapper unreadable
      }
    }
  }

  if (mgr === 'launchd') {
    try {
      const { execFileSync } = await import('child_process');
      const output = execFileSync('launchctl', ['list'], { encoding: 'utf-8' });
      if (output.includes('com.nanoclaw')) {
        // Check if it has a PID (actually running)
        const line = output.split('\n').find((l) => l.includes('com.nanoclaw'));
        if (line) {
          const pidField = line.trim().split(/\s+/)[0];
          service = pidField !== '-' && pidField ? 'running' : 'stopped';
        }
      }
    } catch {
      // launchctl not available
    }
  } else if (mgr === 'systemd') {
    const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
    try {
      const { execSync } = await import('child_process');
      execSync(`${prefix} is-active nanoclaw`, { stdio: 'ignore' });
      service = 'running';
    } catch {
      try {
        const { execSync } = await import('child_process');
        const output = execSync(`${prefix} list-unit-files`, {
          encoding: 'utf-8',
        });
        if (output.includes('nanoclaw')) {
          service = 'stopped';
        }
      } catch {
        // systemctl not available
      }
    }
  } else {
    if (platform === 'windows') {
      try {
        const { execFileSync } = await import('child_process');
        execFileSync('schtasks.exe', ['/Query', '/TN', 'NanoClaw'], {
          stdio: 'ignore',
        });
        service = 'stopped';
      } catch {
        // task not found
      }

      if (service === 'not_found') {
        const appData = process.env.APPDATA;
        if (appData) {
          const startupScript = path.join(
            appData,
            'Microsoft',
            'Windows',
            'Start Menu',
            'Programs',
            'Startup',
            'nanoclaw-start.cmd',
          );
          if (fs.existsSync(startupScript)) {
            service = 'stopped';
          }
        }
      }
    }

    // Check for nohup PID file
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8').trim();
        const pid = Number(raw);
        if (raw && Number.isInteger(pid) && pid > 0) {
          const running =
            platform === 'windows'
              ? await isWindowsNanoclawPidRunning(pid, projectRoot)
              : isPidRunning(pid);
          service = running ? 'running' : 'stopped';
        }
      } catch {
        service = 'stopped';
      }
    }
  }
  logger.info({ service }, 'Service status');

  // 2. Check container runtime
  const containerRuntime = resolveContainerRuntimeName();
  const containerRuntimeStatus = getContainerRuntimeStatus(containerRuntime);

  // 3. Check credentials
  const modelEnvVars = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    ...MODEL_OVERRIDE_ENV_KEYS,
  ]);

  const claudeCodeOauthToken =
    process.env.CLAUDE_CODE_OAUTH_TOKEN || modelEnvVars.CLAUDE_CODE_OAUTH_TOKEN;
  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY || modelEnvVars.ANTHROPIC_API_KEY;
  const anthropicAuthToken =
    process.env.ANTHROPIC_AUTH_TOKEN || modelEnvVars.ANTHROPIC_AUTH_TOKEN;
  const anthropicBaseUrl =
    process.env.ANTHROPIC_BASE_URL || modelEnvVars.ANTHROPIC_BASE_URL;
  const openAiBaseUrl =
    process.env.OPENAI_BASE_URL || modelEnvVars.OPENAI_BASE_URL;
  const openAiApiKey =
    process.env.OPENAI_API_KEY || modelEnvVars.OPENAI_API_KEY;

  const openAiCompatibleEndpoint = anthropicBaseUrl || openAiBaseUrl || '';
  const nativeOpenAiEndpointMisconfig =
    Boolean(openAiApiKey) &&
    Boolean(openAiCompatibleEndpoint) &&
    isLikelyNativeOpenAiEndpoint(openAiCompatibleEndpoint);

  const hasAnthropicDirectCredential = Boolean(
    claudeCodeOauthToken || anthropicApiKey || anthropicAuthToken,
  );
  const hasOpenAiCompatibleCredential = Boolean(
    openAiCompatibleEndpoint && openAiApiKey && !nativeOpenAiEndpointMisconfig,
  );
  const onecliCredentialState = await detectOneCliCredentialKeys();
  const credentialStatus = determineCredentialStatus({
    hasAnthropicDirectCredential,
    hasOpenAiCompatibleCredential,
    onecliReachable: onecliCredentialState.reachable,
    onecliCredentialKeys: onecliCredentialState.credentialKeys,
  });
  const credentials = credentialStatus.credentials;
  const credentialMode = credentialStatus.credentialMode;
  const credentialSources = credentialStatus.credentialSources;
  const onecliCredentialStatus = credentialStatus.onecliCredentialStatus;
  const configuredModelOverride =
    process.env.NANOCLAW_AGENT_MODEL ||
    process.env.CLAUDE_CODE_MODEL ||
    process.env.CLAUDE_MODEL ||
    modelEnvVars.NANOCLAW_AGENT_MODEL ||
    modelEnvVars.CLAUDE_CODE_MODEL ||
    modelEnvVars.CLAUDE_MODEL ||
    'claude-3-5-sonnet-latest';
  const localGatewayState = readLocalOpenAiGatewayState();
  const probeEndpoints = resolveCredentialProbeEndpoints({
    configuredEndpoint: openAiCompatibleEndpoint,
    gatewayState: localGatewayState,
  });

  const credentialRuntimeProbe =
    probeEndpoints.length > 0 && credentials !== 'missing'
      ? await probeCredentialRuntime({
          endpoints: probeEndpoints,
          authToken: anthropicAuthToken || openAiApiKey || anthropicApiKey,
          model: configuredModelOverride,
        })
      : ({
          status: 'skipped',
          reason: 'not_applicable',
        } as CredentialRuntimeProbeResult);

  if (
    credentialRuntimeProbe.status === 'failed' &&
    credentialRuntimeProbe.reason === 'network_error' &&
    platform === 'windows' &&
    hasOpenAiCompatibleCredential &&
    hasLocalGatewayCandidate(probeEndpoints)
  ) {
    const bootstrap = await tryStartLocalGatewayForVerify(projectRoot);
    if (!bootstrap.ok) {
      credentialRuntimeProbe.detail = appendProbeDetail(
        credentialRuntimeProbe.detail,
        `Gateway bootstrap failed: ${bootstrap.detail || 'unknown error'}`,
      );
    } else {
      logger.info(
        'Credential probe network failure detected, retried after gateway bootstrap',
      );
      const retryProbe = await probeCredentialRuntime({
        endpoints: probeEndpoints,
        authToken: anthropicAuthToken || openAiApiKey || anthropicApiKey,
        model: configuredModelOverride,
      });
      if (
        retryProbe.status === 'failed' &&
        retryProbe.reason === 'network_error'
      ) {
        retryProbe.detail = appendProbeDetail(
          retryProbe.detail,
          'Gateway bootstrap was attempted but endpoint remained unreachable.',
        );
      }
      Object.assign(credentialRuntimeProbe, retryProbe);
      if (retryProbe.status === 'ok') {
        credentialRuntimeProbe.detail = '';
      }
    }
  }

  const assistantExecutionProbe =
    credentials !== 'missing'
      ? await probeAssistantExecution()
      : ({
          status: 'skipped',
          reason: 'missing_credentials',
          detail: 'Skipped because no usable credentials are configured.',
        } as AssistantExecutionProbeResult);

  setAssistantExecutionProbeState({
    status:
      assistantExecutionProbe.status === 'ok'
        ? 'ok'
        : assistantExecutionProbe.status === 'failed'
          ? 'failed'
          : 'skipped',
    reason: assistantExecutionProbe.reason,
    detail: assistantExecutionProbe.detail || '',
    checkedAt: new Date().toISOString(),
  });

  // 4. Check channel auth (detect configured channels by credentials)
  const channelEnvVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'DISCORD_BOT_TOKEN',
  ]);

  const channelAuth: Record<string, string> = {};

  // WhatsApp: check for auth credentials on disk
  const authDir = path.join(projectRoot, 'store', 'auth');
  if (fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0) {
    channelAuth.whatsapp = 'authenticated';
  }

  // Token-based channels: check .env
  if (process.env.TELEGRAM_BOT_TOKEN || channelEnvVars.TELEGRAM_BOT_TOKEN) {
    channelAuth.telegram = 'configured';
  }
  if (
    (process.env.SLACK_BOT_TOKEN || channelEnvVars.SLACK_BOT_TOKEN) &&
    (process.env.SLACK_APP_TOKEN || channelEnvVars.SLACK_APP_TOKEN)
  ) {
    channelAuth.slack = 'configured';
  }
  if (process.env.DISCORD_BOT_TOKEN || channelEnvVars.DISCORD_BOT_TOKEN) {
    channelAuth.discord = 'configured';
  }

  const configuredChannels = Object.keys(channelAuth);
  const anyChannelConfigured = configuredChannels.length > 0;

  // 5. Check registered groups (using better-sqlite3, not sqlite3 CLI)
  let registeredGroups = 0;
  const dbPath = path.join(STORE_DIR, 'messages.db');
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare('SELECT COUNT(*) as count FROM registered_groups')
        .get() as { count: number };
      registeredGroups = row.count;
      db.close();
    } catch {
      // Table might not exist
    }
  }

  // 6. Check mount allowlist
  let mountAllowlist = 'missing';
  if (
    fs.existsSync(
      path.join(homeDir, '.config', 'nanoclaw', 'mount-allowlist.json'),
    )
  ) {
    mountAllowlist = 'configured';
  }

  const serviceExpectedStopped =
    service !== 'running' &&
    credentials === 'missing' &&
    !anyChannelConfigured &&
    registeredGroups === 0;

  const missingRequirements: string[] = [];
  if (!nodeOk) missingRequirements.push('node_22');
  if (credentials === 'missing') missingRequirements.push('credentials');
  if (!anyChannelConfigured) missingRequirements.push('channel_auth');
  if (registeredGroups === 0) missingRequirements.push('registered_groups');
  if (service !== 'running' && !serviceExpectedStopped) {
    missingRequirements.push('service_running');
  }
  if (credentialRuntimeProbe.status === 'failed') {
    missingRequirements.push('credential_runtime_unusable');
  }
  if (assistantExecutionProbe.status === 'failed') {
    missingRequirements.push('assistant_execution_unusable');
  }

  const nextSteps = buildVerifyNextSteps({
    missingRequirements,
    hasNativeOpenAiEndpointMisconfig: nativeOpenAiEndpointMisconfig,
    credentialRuntimeProbeReason: credentialRuntimeProbe.reason,
    assistantExecutionProbeReason: assistantExecutionProbe.reason,
    configuredChannels,
  });

  // Determine overall status
  const status =
    nodeOk &&
    service === 'running' &&
    credentials !== 'missing' &&
    anyChannelConfigured &&
    registeredGroups > 0 &&
    credentialRuntimeProbe.status !== 'failed' &&
    assistantExecutionProbe.status !== 'failed'
      ? 'success'
      : 'failed';

  logger.info({ status, channelAuth }, 'Verification complete');

  emitStatus('VERIFY', {
    PLATFORM: platform,
    NODE_VERSION: nodeVersion,
    NODE_MAJOR: nodeMajor ?? 'unknown',
    NODE_OK: nodeOk,
    SERVICE: service,
    CONTAINER_RUNTIME: containerRuntime,
    CONTAINER_RUNTIME_STATUS: containerRuntimeStatus,
    CREDENTIALS: credentials,
    CREDENTIAL_MODE: credentialMode,
    CREDENTIAL_SOURCES: credentialSources,
    OPENAI_ENDPOINT_MODE: nativeOpenAiEndpointMisconfig
      ? 'native_openai_unsupported_for_core_runtime'
      : openAiCompatibleEndpoint
        ? 'anthropic_compatible_or_custom'
        : 'not_configured',
    ONECLI_STATUS: onecliCredentialStatus,
    ONECLI_CREDENTIAL_KEYS: onecliCredentialState.credentialKeys.join(','),
    CREDENTIAL_RUNTIME_PROBE: credentialRuntimeProbe.status,
    CREDENTIAL_RUNTIME_PROBE_ENDPOINTS: probeEndpoints.join(','),
    CREDENTIAL_RUNTIME_PROBE_REASON: credentialRuntimeProbe.reason,
    CREDENTIAL_RUNTIME_PROBE_DETAIL: credentialRuntimeProbe.detail || '',
    ASSISTANT_EXECUTION_PROBE: assistantExecutionProbe.status,
    ASSISTANT_EXECUTION_PROBE_REASON: assistantExecutionProbe.reason,
    ASSISTANT_EXECUTION_PROBE_DETAIL: assistantExecutionProbe.detail || '',
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    SERVICE_EXPECTED_STOPPED: serviceExpectedStopped,
    MISSING_REQUIREMENTS: missingRequirements.join(','),
    NEXT_STEPS: nextSteps,
    STATUS: status,
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });

  if (status === 'failed') process.exit(1);
}
