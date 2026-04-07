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

import { createDirectAssistantRequestPolicy } from '../src/assistant-routing.js';
import { getAndreaOpenAiBackendStatus } from '../src/andrea-openai-runtime.js';
import { ONECLI_URL, RUNTIME_STATE_DIR, STORE_DIR } from '../src/config.js';
import { runContainerAgent } from '../src/container-runner.js';
import {
  getContainerRuntimeStatus,
  resolveContainerRuntimeName,
} from '../src/container-runtime.js';
import { setAssistantExecutionProbeState } from '../src/debug-control.js';
import { initDatabase } from '../src/db.js';
import { buildDirectAssistantContinuationPrompt } from '../src/direct-assistant-continuation.js';
import { readEnvFile } from '../src/env.js';
import { buildFieldTrialOperatorTruth } from '../src/field-trial-readiness.js';
import {
  buildRuntimeCommitTruth,
  detectWindowsInstallArtifacts,
  detectWindowsInstallMode,
  formatInstallModeLabel,
  readAlexaLastSignedRequestState,
  reconcileWindowsHostState,
} from '../src/host-control.js';
import { logger } from '../src/logger.js';
import { readProviderProofState } from '../src/provider-proof-state.js';
import { formatMessages } from '../src/router.js';
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

interface LocalGatewayHealthPayload {
  healthy_count?: number;
  unhealthy_count?: number;
  healthy_endpoints?: Array<unknown>;
  unhealthy_endpoints?: Array<{
    error?: string;
    model?: string;
  }>;
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

  if (
    body.includes('insufficient_quota') ||
    body.includes('exceeded your current quota') ||
    body.includes('out of quota')
  ) {
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
    errorMessage.includes('aborted') ||
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

function countGatewayEndpoints(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  return 0;
}

function classifyGatewayHealthErrorDetail(detail: string): {
  reason: string;
  detail: string;
} {
  return classifyCredentialProbeFailure({
    statusCode: 502,
    body: detail,
  });
}

export function classifyLocalGatewayHealthPayload(
  payload: LocalGatewayHealthPayload | null | undefined,
): CredentialRuntimeProbeResult {
  if (!payload || typeof payload !== 'object') {
    return {
      status: 'failed',
      reason: 'runtime_error',
      detail: 'Local gateway health response was missing or invalid.',
    };
  }

  const healthyCount = Math.max(
    countGatewayEndpoints(payload.healthy_count),
    countGatewayEndpoints(payload.healthy_endpoints),
  );
  if (healthyCount > 0) {
    return {
      status: 'ok',
      reason: 'ok',
    };
  }

  const unhealthyEntries = Array.isArray(payload.unhealthy_endpoints)
    ? payload.unhealthy_endpoints
    : [];
  const unhealthyCount = Math.max(
    countGatewayEndpoints(payload.unhealthy_count),
    unhealthyEntries.length,
  );

  const firstError = unhealthyEntries
    .map((entry) => (entry?.error || '').trim())
    .find(Boolean);

  if (firstError) {
    const classified = classifyGatewayHealthErrorDetail(firstError);
    return {
      status: 'failed',
      reason: classified.reason,
      detail: classified.detail,
    };
  }

  if (unhealthyCount > 0) {
    return {
      status: 'failed',
      reason: 'runtime_error',
      detail:
        'Local gateway is running but reported zero healthy upstream endpoints.',
    };
  }

  return {
    status: 'failed',
    reason: 'runtime_error',
    detail:
      'Local gateway health did not report any healthy upstream endpoints.',
  };
}

export async function probeLocalGatewayHealth(input: {
  hostHealthUrl: string;
  requestTimeoutMs?: number;
}): Promise<CredentialRuntimeProbeResult> {
  const normalized = normalizeProbeEndpoint(input.hostHealthUrl);
  if (!normalized) {
    return {
      status: 'skipped',
      reason: 'invalid_endpoint',
      detail: 'Local gateway health URL is not a valid URL.',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.requestTimeoutMs ?? 4_000,
    );
    const response = await fetch(normalized, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text();
      const classified = classifyCredentialProbeFailure({
        statusCode: response.status,
        body,
      });
      return {
        status: 'failed',
        reason: classified.reason,
        detail: classified.detail,
      };
    }

    const raw = await response.text();
    try {
      const payload = JSON.parse(raw) as LocalGatewayHealthPayload;
      return classifyLocalGatewayHealthPayload(payload);
    } catch {
      return {
        status: 'failed',
        reason: 'runtime_error',
        detail: 'Local gateway health returned invalid JSON.',
      };
    }
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

type AssistantExecutionProbeKind = 'exact' | 'summary' | 'refinement';

interface AssistantExecutionSubprobeResult {
  status: 'ok' | 'failed';
  reason: string;
  detail: string;
  assistantText?: string;
  sessionId?: string;
  recoveryAttempted: boolean;
}

function formatAssistantExecutionSubprobeLabel(
  promptKind: AssistantExecutionProbeKind,
): string {
  switch (promptKind) {
    case 'exact':
      return 'exact probe';
    case 'summary':
      return 'summary probe';
    case 'refinement':
      return 'refinement probe';
  }
}

function buildDirectAssistantProbePrompt(input: {
  promptText: string;
  promptKind: AssistantExecutionProbeKind;
}): string {
  return formatMessages(
    [
      {
        id: `verify-${input.promptKind}`,
        chat_jid: `verify:assistant-execution:${input.promptKind}`,
        sender: 'Jeff',
        sender_name: 'Jeff',
        content: input.promptText,
        timestamp: new Date('2026-03-31T20:00:00.000Z').toISOString(),
        is_from_me: false,
      },
    ],
    'America/Chicago',
  );
}

async function runAssistantExecutionSubprobe(input: {
  probeGroup: RegisteredGroup;
  promptText: string;
  promptKind: AssistantExecutionProbeKind;
  requestTimeoutMs?: number;
  runProbe: typeof runContainerAgent;
  sessionId?: string;
}): Promise<AssistantExecutionSubprobeResult> {
  const requestPolicy = createDirectAssistantRequestPolicy(
    `verify assistant execution probe (${input.promptKind})`,
  );
  let sawStructuredOutput = false;
  let sawLifecycleOnlyOutput = false;
  let sawRecoveryAttempt = false;
  let assistantText: string | undefined;
  const liveStylePrompt = buildDirectAssistantProbePrompt({
    promptText: input.promptText,
    promptKind: input.promptKind,
  });

  try {
    const output = await input.runProbe(
      input.probeGroup,
      {
        prompt: liveStylePrompt,
        sessionId: input.sessionId,
        freshSessionHome: true,
        groupFolder: input.probeGroup.folder,
        chatJid: `verify:assistant-execution:${input.promptKind}`,
        isMain: false,
        assistantName: 'Andrea',
        idleTimeoutMs: 5_000,
        requestPolicy,
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
          assistantText = streamedOutput.result.trim();
        } else if (
          streamedOutput.status === 'success' &&
          !streamedOutput.result?.trim()
        ) {
          sawLifecycleOnlyOutput =
            streamedOutput.sawLifecycleOnlyOutput !== false;
        }
      },
    );

    if (output.status === 'error') {
      return {
        status: 'failed',
        reason: output.failureKind || 'runtime_bootstrap_failed',
        detail: truncateDetail(
          [
            output.diagnosticHint ||
              output.error ||
              'Assistant execution failed.',
            output.recoveryAttempted
              ? 'probe exhausted one recovery retry before failing'
              : '',
          ]
            .filter(Boolean)
            .join(' | '),
        ),
        recoveryAttempted:
          sawRecoveryAttempt || output.recoveryAttempted === true,
      };
    }

    if (!sawStructuredOutput) {
      return {
        status: 'failed',
        reason: 'initial_output_timeout',
        detail:
          'Execution probe completed without any structured assistant output.',
        recoveryAttempted:
          sawRecoveryAttempt || output.recoveryAttempted === true,
      };
    }

    if (!assistantText) {
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
        recoveryAttempted:
          sawRecoveryAttempt || output.recoveryAttempted === true,
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
      assistantText,
      sessionId: output.newSessionId,
      recoveryAttempted:
        sawRecoveryAttempt || output.recoveryAttempted === true,
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: 'runtime_bootstrap_failed',
      detail: truncateDetail(err instanceof Error ? err.message : String(err)),
      recoveryAttempted: sawRecoveryAttempt,
    };
  }
}

function shouldRetryAssistantExecutionSubprobe(
  result: AssistantExecutionSubprobeResult,
): boolean {
  return (
    result.status === 'failed' &&
    (result.reason === 'runtime_bootstrap_failed' ||
      result.reason === 'initial_output_timeout')
  );
}

async function runAssistantExecutionSubprobeWithRetry(input: {
  probeGroup: RegisteredGroup;
  promptText: string;
  promptKind: AssistantExecutionProbeKind;
  requestTimeoutMs?: number;
  runProbe: typeof runContainerAgent;
  sessionId?: string;
}): Promise<AssistantExecutionSubprobeResult> {
  const firstAttempt = await runAssistantExecutionSubprobe(input);
  if (!shouldRetryAssistantExecutionSubprobe(firstAttempt)) {
    return firstAttempt;
  }

  const secondAttempt = await runAssistantExecutionSubprobe({
    ...input,
    sessionId: undefined,
  });
  const retryNote = 'verify retried the subprobe once in a fresh container';

  return {
    ...secondAttempt,
    detail: truncateDetail(
      secondAttempt.status === 'ok'
        ? [secondAttempt.detail, retryNote].filter(Boolean).join(' | ')
        : [firstAttempt.detail, retryNote, secondAttempt.detail]
            .filter(Boolean)
            .join(' | '),
    ),
  };
}

export async function probeAssistantExecution(
  input: {
    requestTimeoutMs?: number;
    runProbe?: typeof runContainerAgent;
  } = {},
): Promise<AssistantExecutionProbeResult> {
  const buildProbeGroup = (
    promptKind: AssistantExecutionProbeKind,
  ): RegisteredGroup => ({
    name: 'Verify Runtime Probe',
    folder: `verify_runtime_probe_${promptKind}`,
    trigger: '@andrea',
    added_at: new Date().toISOString(),
    containerConfig: {
      timeout: input.requestTimeoutMs ?? 20_000,
    },
  });

  const runProbe = input.runProbe || runContainerAgent;

  try {
    const exactProbe = await runAssistantExecutionSubprobeWithRetry({
      probeGroup: buildProbeGroup('exact'),
      promptText: 'Reply with exactly: assistant execution probe ok.',
      promptKind: 'exact',
      requestTimeoutMs: input.requestTimeoutMs,
      runProbe,
    });
    if (exactProbe.status === 'failed') {
      return {
        status: 'failed',
        reason: exactProbe.reason,
        detail: truncateDetail(
          `${formatAssistantExecutionSubprobeLabel('exact')} failed: ${exactProbe.detail}`,
        ),
      };
    }

    const summaryProbe = await runAssistantExecutionSubprobeWithRetry({
      probeGroup: buildProbeGroup('summary'),
      promptText:
        "Summarize Andrea_NanoBot's role in one sentence. Do not modify files, branches, or PRs.",
      promptKind: 'summary',
      requestTimeoutMs: input.requestTimeoutMs,
      runProbe,
    });
    if (summaryProbe.status === 'failed') {
      return {
        status: 'failed',
        reason: summaryProbe.reason,
        detail: truncateDetail(
          `${formatAssistantExecutionSubprobeLabel('summary')} failed: ${summaryProbe.detail}`,
        ),
      };
    }

    const refinementRewrite = buildDirectAssistantContinuationPrompt({
      rawPrompt: 'make it shorter',
      previousAssistantText: summaryProbe.assistantText || null,
    });
    let refinementProbe = await runAssistantExecutionSubprobeWithRetry({
      probeGroup: buildProbeGroup('refinement'),
      promptText: refinementRewrite.normalizedPromptText,
      promptKind: 'refinement',
      requestTimeoutMs: input.requestTimeoutMs,
      runProbe,
      sessionId: refinementRewrite.shouldStartFreshSession
        ? undefined
        : summaryProbe.sessionId,
    });
    if (
      refinementProbe.status === 'failed' &&
      refinementRewrite.fallbackPromptText
    ) {
      refinementProbe = await runAssistantExecutionSubprobeWithRetry({
        probeGroup: buildProbeGroup('refinement'),
        promptText: refinementRewrite.fallbackPromptText,
        promptKind: 'refinement',
        requestTimeoutMs: input.requestTimeoutMs,
        runProbe,
      });
    }
    if (refinementProbe.status === 'failed') {
      return {
        status: 'failed',
        reason: refinementProbe.reason,
        detail: truncateDetail(
          `${formatAssistantExecutionSubprobeLabel('refinement')} failed: ${refinementProbe.detail}`,
        ),
      };
    }

    return {
      status: 'ok',
      reason: 'ok',
      detail: truncateDetail(
        [
          `exact ${exactProbe.detail}`,
          `summary ${summaryProbe.detail}`,
          `refinement ${refinementProbe.detail}`,
          'assistant execution produced real assistant answers for exact, summary, and refinement turns',
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
    const gatewayState = readLocalOpenAiGatewayState();
    const healthUrl = gatewayState?.host_health || '';
    if (healthUrl) {
      const health = await probeLocalGatewayHealth({
        hostHealthUrl: healthUrl,
      });
      if (health.status === 'failed') {
        return {
          ok: false,
          detail: health.detail || 'Local gateway health probe failed.',
        };
      }
    }
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

export function buildVerifyNextSteps(input: {
  missingRequirements: string[];
  hasNativeOpenAiEndpointMisconfig: boolean;
  credentialRuntimeProbeReason?: string;
  assistantExecutionProbeReason?: string;
  configuredChannels?: string[];
  hostLastError?: string;
  runtimeBackendLocalExecutionState?: string;
  runtimeBackendAuthState?: string;
  alexaConfigured?: boolean;
  alexaLastSignedRequestType?: string;
  outwardResearchStatus?:
    | 'not_configured'
    | 'misconfigured_native_openai_endpoint'
    | 'missing_direct_provider_credentials'
    | 'quota_blocked'
    | 'degraded'
    | 'available';
}): string {
  const steps: string[] = [];

  if (input.missingRequirements.includes('credentials')) {
    if (input.outwardResearchStatus === 'quota_blocked') {
      steps.push(
        input.runtimeBackendLocalExecutionState === 'available_authenticated'
          ? 'Outward research is blocked because the direct provider account on this host is out of quota or billing. The local runtime backend is healthy, so work-cockpit flows can still run on this host.'
          : 'Outward research is blocked because the direct provider account on this host is out of quota or billing. Restore provider quota or billing, then rerun npm run debug:research-mode.',
      );
    } else if (input.outwardResearchStatus === 'degraded') {
      steps.push(
        'Outward research is configured, but the live provider path is currently degraded on this host. Repair the provider path, then rerun npm run debug:research-mode.',
      );
    } else if (
      input.runtimeBackendLocalExecutionState === 'available_authenticated' &&
      !input.hasNativeOpenAiEndpointMisconfig
    ) {
      steps.push(
        'Outward research is blocked because direct provider credentials are missing. The local runtime backend is healthy, so work-cockpit flows can still run on this host.',
      );
    } else if (
      input.runtimeBackendLocalExecutionState === 'available_auth_required' &&
      !input.hasNativeOpenAiEndpointMisconfig
    ) {
      steps.push(
        'Outward research is blocked because direct provider credentials are missing, and the local runtime backend still needs operator auth before local execution is available.',
      );
    } else if (input.hasNativeOpenAiEndpointMisconfig) {
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
  if (input.missingRequirements.includes('service_config_failed')) {
    steps.push(
      input.hostLastError
        ? `NanoClaw is running with an unhealthy runtime configuration: ${truncateDetail(input.hostLastError)}`
        : 'NanoClaw is running with an unhealthy runtime configuration. Check /debug-status and nanoclaw.host.log.',
    );
  }
  if (input.missingRequirements.includes('credential_runtime_unusable')) {
    if (input.credentialRuntimeProbeReason === 'insufficient_quota') {
      steps.push(
        'Outward research is blocked because the OpenAI-compatible provider key is out of quota or billing. Top up billing, replace OPENAI_API_KEY, or switch to direct ANTHROPIC_* credentials.',
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

  if (
    input.alexaConfigured &&
    (input.alexaLastSignedRequestType || 'none') === 'none'
  ) {
    steps.push(
      'Alexa live proof still needs one signed turn. Import docs/alexa/interaction-model.en-US.json if needed, run Build Model, then do one real voice or authenticated simulator request and confirm services:status records an IntentRequest.',
    );
  }

  if (steps.length === 0) {
    return 'No missing requirements detected.';
  }

  return steps.join(' | ');
}

export function buildReportedMissingRequirements(input: {
  missingRequirements: string[];
  outwardResearchStatus:
    | 'not_configured'
    | 'misconfigured_native_openai_endpoint'
    | 'missing_direct_provider_credentials'
    | 'quota_blocked'
    | 'degraded'
    | 'available';
  alexaConfigured?: boolean;
  alexaLastSignedRequestType?: string;
}): string[] {
  const reported = new Set<string>();

  const outwardResearchRequirement =
    input.outwardResearchStatus === 'missing_direct_provider_credentials'
      ? 'outward_research_direct_provider_credentials_missing'
      : input.outwardResearchStatus === 'quota_blocked'
        ? 'outward_research_quota_blocked'
        : input.outwardResearchStatus === 'degraded'
          ? 'outward_research_runtime_probe_failed'
          : input.outwardResearchStatus === 'misconfigured_native_openai_endpoint'
            ? 'outward_research_endpoint_misconfigured'
            : null;

  for (const requirement of input.missingRequirements) {
    if (
      (requirement === 'credentials' ||
        requirement === 'credential_runtime_unusable') &&
      outwardResearchRequirement
    ) {
      reported.add(outwardResearchRequirement);
      continue;
    }
    reported.add(requirement);
  }

  if (input.alexaConfigured && input.alexaLastSignedRequestType === 'none') {
    reported.add('alexa_live_signed_turn_missing');
  }

  return [...reported];
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

export function buildBlockedAssistantExecutionProbeResult(input: {
  credentialRuntimeProbe: CredentialRuntimeProbeResult;
}): AssistantExecutionProbeResult {
  const detail = input.credentialRuntimeProbe.detail
    ? `Skipped because the credential runtime probe already failed (${input.credentialRuntimeProbe.reason}): ${input.credentialRuntimeProbe.detail}`
    : `Skipped because the credential runtime probe already failed (${input.credentialRuntimeProbe.reason}).`;
  return {
    status: 'skipped',
    reason: 'blocked_by_credential_runtime_failure',
    detail,
  };
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodeVersion = getNodeVersion() || process.version.replace(/^v/, '');
  const nodeMajor = getNodeMajorVersion();
  const windowsHost =
    platform === 'windows' ? reconcileWindowsHostState({ projectRoot }) : null;
  const hostSnapshot = windowsHost?.snapshot || null;
  let nodeOk = nodeMajor === 22;
  const homeDir = os.homedir();

  initDatabase();
  logger.info('Starting verification');

  // 1. Check service status
  let service = 'not_found';
  let hostInstallMode = 'unknown';
  let hostActiveLaunchMode = 'unknown';
  let hostPinnedNodePath = '';
  let hostPinnedNodeVersion = '';
  let hostLastError = '';
  let hostDependencyState = 'unknown';
  let hostDependencyError = '';
  let runtimeBackendState = 'unknown';
  let runtimeBackendAuthState = 'unknown';
  let runtimeBackendLocalExecutionState = 'unknown';
  let runtimeBackendDetail = '';
  const mgr = getServiceManager();
  const commitTruth = buildRuntimeCommitTruth({
    projectRoot,
    runtimeAuditState: hostSnapshot?.runtimeAuditState,
  });
  const alexaSignedRequest = readAlexaLastSignedRequestState(projectRoot);
  const alexaLastSignedRequestType = alexaSignedRequest?.requestType || 'none';
  const alexaLastSignedRequestAt = alexaSignedRequest?.updatedAt || 'none';

  if (!nodeOk && platform === 'windows' && hostSnapshot?.nodeRuntime) {
    nodeOk = hostSnapshot.nodeRuntime.version.startsWith('22.');
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
      const installArtifacts = detectWindowsInstallArtifacts({ projectRoot });
      const installMode = detectWindowsInstallMode({
        hasScheduledTask: installArtifacts.hasScheduledTask,
        hasStartupFolder: installArtifacts.hasStartupFolder,
      });
      hostInstallMode = formatInstallModeLabel(installMode);
      hostActiveLaunchMode = formatInstallModeLabel(
        windowsHost?.activeLaunchMode,
      );
      hostPinnedNodePath = hostSnapshot?.nodeRuntime?.nodePath || '';
      hostPinnedNodeVersion = hostSnapshot?.nodeRuntime?.version || '';
      hostLastError = windowsHost?.launcherError || '';
      hostDependencyState = windowsHost?.dependencyState || 'unknown';
      hostDependencyError = windowsHost?.dependencyError || '';
      service = windowsHost?.serviceState || 'stopped';
    } else {
      // Check for nohup PID file
      const pidFile = path.join(projectRoot, 'nanoclaw.pid');
      if (fs.existsSync(pidFile)) {
        try {
          const raw = fs.readFileSync(pidFile, 'utf-8').trim();
          const pid = Number(raw);
          if (raw && Number.isInteger(pid) && pid > 0) {
            const running = isPidRunning(pid);
            service = running ? 'running' : 'stopped';
          }
        } catch {
          service = 'stopped';
        }
      }
    }
  }
  logger.info(
    {
      service,
      hostInstallMode,
      hostActiveLaunchMode,
      hostPinnedNodeVersion,
      hostPinnedNodePath,
      hostDependencyState,
    },
    'Service status',
  );

  try {
    const runtimeBackendStatus = await getAndreaOpenAiBackendStatus();
    runtimeBackendState = runtimeBackendStatus.state;
    runtimeBackendAuthState = runtimeBackendStatus.meta?.authState || 'unknown';
    runtimeBackendLocalExecutionState =
      runtimeBackendStatus.meta?.localExecutionState || 'unknown';
    runtimeBackendDetail =
      runtimeBackendStatus.meta?.localExecutionDetail ||
      runtimeBackendStatus.detail ||
      '';
  } catch (err) {
    runtimeBackendState = 'unavailable';
    runtimeBackendAuthState = 'unknown';
    runtimeBackendLocalExecutionState = 'unavailable';
    runtimeBackendDetail = err instanceof Error ? err.message : String(err);
  }

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
  const alexaEnvVars = readEnvFile(['ALEXA_SKILL_ID']);
  const alexaConfigured = Boolean(
    process.env.ALEXA_SKILL_ID || alexaEnvVars.ALEXA_SKILL_ID,
  );

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
  const localGatewayHealth =
    localGatewayState?.host_health && hasOpenAiCompatibleCredential
      ? await probeLocalGatewayHealth({
          hostHealthUrl: localGatewayState.host_health,
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
  if (
    credentialRuntimeProbe.status === 'failed' &&
    localGatewayHealth.status === 'failed'
  ) {
    if (
      credentialRuntimeProbe.reason === 'network_error' ||
      credentialRuntimeProbe.reason === 'runtime_error'
    ) {
      credentialRuntimeProbe.reason = localGatewayHealth.reason;
      credentialRuntimeProbe.detail = localGatewayHealth.detail;
    } else if (localGatewayHealth.detail) {
      credentialRuntimeProbe.detail = appendProbeDetail(
        credentialRuntimeProbe.detail,
        `Local gateway health: ${localGatewayHealth.detail}`,
      );
    }
  }

  const assistantExecutionProbe =
    credentials !== 'missing'
      ? credentialRuntimeProbe.status === 'failed'
        ? buildBlockedAssistantExecutionProbeResult({
            credentialRuntimeProbe,
          })
        : await probeAssistantExecution()
      : ({
          status: 'skipped',
          reason: 'missing_credentials',
          detail: 'Skipped because no usable credentials are configured.',
        } as AssistantExecutionProbeResult);
  if (
    assistantExecutionProbe.status === 'failed' &&
    localGatewayHealth.status === 'failed'
  ) {
    assistantExecutionProbe.detail = truncateDetail(
      appendProbeDetail(
        assistantExecutionProbe.detail,
        `Local gateway health: ${localGatewayHealth.detail}`,
      ),
    );
  }

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

  const serviceHealthy = service === 'running' || service === 'running_ready';
  const serviceExpectedStopped =
    !serviceHealthy &&
    credentials === 'missing' &&
    !anyChannelConfigured &&
    registeredGroups === 0;

  const missingRequirements: string[] = [];
  if (!nodeOk) missingRequirements.push('node_22');
  if (credentials === 'missing') missingRequirements.push('credentials');
  if (!anyChannelConfigured) missingRequirements.push('channel_auth');
  if (registeredGroups === 0) missingRequirements.push('registered_groups');
  if (service === 'config_failed') {
    missingRequirements.push('service_config_failed');
  } else if (!serviceHealthy && !serviceExpectedStopped) {
    missingRequirements.push('service_running');
  }
  if (credentialRuntimeProbe.status === 'failed') {
    missingRequirements.push('credential_runtime_unusable');
  }
  if (assistantExecutionProbe.status === 'failed') {
    missingRequirements.push('assistant_execution_unusable');
  }

  let outwardResearchStatus = 'not_configured';
  if (nativeOpenAiEndpointMisconfig) {
    outwardResearchStatus = 'misconfigured_native_openai_endpoint';
  } else if (credentials === 'missing') {
    outwardResearchStatus = 'missing_direct_provider_credentials';
  } else if (credentialRuntimeProbe.status === 'failed') {
    outwardResearchStatus =
      credentialRuntimeProbe.reason === 'insufficient_quota'
        ? 'quota_blocked'
        : 'degraded';
  } else if (credentialRuntimeProbe.status === 'ok') {
    outwardResearchStatus = 'available';
  }
  const providerProofState = readProviderProofState(projectRoot);
  if (providerProofState?.research.proofState === 'live_proven') {
    outwardResearchStatus = 'available';
  } else if (providerProofState?.research.proofState === 'externally_blocked') {
    outwardResearchStatus = /quota|billing/i.test(
      providerProofState.research.blocker,
    )
      ? 'quota_blocked'
      : 'degraded';
  }

  const externalBlockers: string[] = [];
  if (outwardResearchStatus === 'missing_direct_provider_credentials') {
    externalBlockers.push('outward_research_direct_provider_credentials_missing');
  } else if (outwardResearchStatus === 'quota_blocked') {
    externalBlockers.push('outward_research_quota_blocked');
  } else if (outwardResearchStatus === 'degraded') {
    externalBlockers.push('outward_research_runtime_probe_failed');
  } else if (outwardResearchStatus === 'misconfigured_native_openai_endpoint') {
    externalBlockers.push('outward_research_endpoint_misconfigured');
  }
  if (alexaConfigured && alexaLastSignedRequestType === 'none') {
    externalBlockers.push('alexa_live_signed_turn_missing');
  }

  const nextSteps = buildVerifyNextSteps({
    missingRequirements,
    hasNativeOpenAiEndpointMisconfig: nativeOpenAiEndpointMisconfig,
    credentialRuntimeProbeReason: credentialRuntimeProbe.reason,
    assistantExecutionProbeReason: assistantExecutionProbe.reason,
    configuredChannels,
    hostLastError,
    runtimeBackendLocalExecutionState,
    runtimeBackendAuthState,
    alexaConfigured,
    alexaLastSignedRequestType,
    outwardResearchStatus: outwardResearchStatus as
      | 'not_configured'
      | 'misconfigured_native_openai_endpoint'
      | 'missing_direct_provider_credentials'
      | 'quota_blocked'
      | 'degraded'
      | 'available',
  });

  const fieldTrialTruth = buildFieldTrialOperatorTruth({
    projectRoot,
    hostSnapshot,
    windowsHost: platform === 'windows' ? windowsHost : null,
    outwardResearchStatus: outwardResearchStatus as
      | 'not_configured'
      | 'misconfigured_native_openai_endpoint'
      | 'missing_direct_provider_credentials'
      | 'quota_blocked'
      | 'degraded'
      | 'available',
  });

  const reportedMissingRequirements = buildReportedMissingRequirements({
    missingRequirements,
    outwardResearchStatus,
    alexaConfigured,
    alexaLastSignedRequestType,
  });

  // Determine overall status
  const status =
    nodeOk &&
    serviceHealthy &&
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
    HOST_INSTALL_MODE: hostInstallMode,
    HOST_ACTIVE_LAUNCH_MODE: hostActiveLaunchMode,
    HOST_NODE_PATH: hostPinnedNodePath,
    HOST_NODE_VERSION: hostPinnedNodeVersion,
    HOST_LAST_ERROR: hostLastError,
    HOST_DEPENDENCY_STATE: hostDependencyState,
    HOST_DEPENDENCY_ERROR: hostDependencyError,
    HOST_LOG_PATHS: hostSnapshot?.hostState
      ? [
          hostSnapshot.hostState.hostLogPath,
          hostSnapshot.hostState.stdoutLogPath,
          hostSnapshot.hostState.stderrLogPath,
        ].join(',')
      : '',
    CONTAINER_RUNTIME: containerRuntime,
    CONTAINER_RUNTIME_STATUS: containerRuntimeStatus,
    ACTIVE_REPO_ROOT: commitTruth.activeRepoRoot,
    WORKSPACE_REPO_ROOT: commitTruth.workspaceRepoRoot,
    ACTIVE_GIT_BRANCH: commitTruth.activeGitBranch,
    ACTIVE_GIT_COMMIT: commitTruth.activeGitCommit,
    WORKSPACE_GIT_BRANCH: commitTruth.workspaceGitBranch,
    WORKSPACE_GIT_COMMIT: commitTruth.workspaceGitCommit,
    SERVING_COMMIT_MATCHES_WORKSPACE_HEAD:
      commitTruth.servingCommitMatchesWorkspaceHead,
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
    OUTWARD_RESEARCH_STATUS: outwardResearchStatus,
    OUTWARD_RESEARCH_PROOF: fieldTrialTruth.research.proofState,
    OUTWARD_RESEARCH_BLOCKER: fieldTrialTruth.research.blocker,
    OUTWARD_RESEARCH_NEXT_ACTION: fieldTrialTruth.research.nextAction,
    LOCAL_GATEWAY_HEALTH: localGatewayHealth.status,
    LOCAL_GATEWAY_HEALTH_REASON: localGatewayHealth.reason,
    LOCAL_GATEWAY_HEALTH_DETAIL: localGatewayHealth.detail || '',
    RUNTIME_BACKEND_STATE: runtimeBackendState,
    RUNTIME_BACKEND_AUTH_STATE: runtimeBackendAuthState,
    RUNTIME_BACKEND_LOCAL_EXECUTION_STATE: runtimeBackendLocalExecutionState,
    RUNTIME_BACKEND_DETAIL: runtimeBackendDetail,
    ALEXA_LAST_SIGNED_REQUEST_TYPE: alexaLastSignedRequestType,
    ALEXA_LAST_SIGNED_REQUEST_AT: alexaLastSignedRequestAt,
    ALEXA_LIVE_PROOF: alexaConfigured
      ? alexaLastSignedRequestType === 'none'
        ? 'near_live_signed_turn_missing'
        : 'live_signed_turn_recorded'
      : 'not_configured',
    ALEXA_LIVE_PROOF_BLOCKER: fieldTrialTruth.alexa.blocker,
    ALEXA_LIVE_PROOF_NEXT_ACTION: fieldTrialTruth.alexa.nextAction,
    TELEGRAM_LIVE_PROOF: fieldTrialTruth.telegram.proofState,
    TELEGRAM_LIVE_PROOF_DETAIL: fieldTrialTruth.telegram.detail,
    TELEGRAM_LIVE_PROOF_BLOCKER: fieldTrialTruth.telegram.blocker,
    TELEGRAM_LIVE_PROOF_NEXT_ACTION: fieldTrialTruth.telegram.nextAction,
    BLUEBUBBLES_PROOF: fieldTrialTruth.bluebubbles.proofState,
    BLUEBUBBLES_PROOF_DETAIL: fieldTrialTruth.bluebubbles.detail,
    BLUEBUBBLES_PROOF_BLOCKER: fieldTrialTruth.bluebubbles.blocker,
    BLUEBUBBLES_PROOF_NEXT_ACTION: fieldTrialTruth.bluebubbles.nextAction,
    IMAGE_GENERATION_PROOF: fieldTrialTruth.imageGeneration.proofState,
    IMAGE_GENERATION_PROOF_DETAIL: fieldTrialTruth.imageGeneration.detail,
    IMAGE_GENERATION_PROOF_BLOCKER: fieldTrialTruth.imageGeneration.blocker,
    IMAGE_GENERATION_PROOF_NEXT_ACTION: fieldTrialTruth.imageGeneration.nextAction,
    ASSISTANT_EXECUTION_PROBE: assistantExecutionProbe.status,
    ASSISTANT_EXECUTION_PROBE_REASON: assistantExecutionProbe.reason,
    ASSISTANT_EXECUTION_PROBE_DETAIL: assistantExecutionProbe.detail || '',
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    MOUNT_ALLOWLIST: mountAllowlist,
    SERVICE_EXPECTED_STOPPED: serviceExpectedStopped,
    EXTERNAL_BLOCKERS: externalBlockers.join(','),
    MISSING_REQUIREMENTS: reportedMissingRequirements.join(','),
    NEXT_STEPS: nextSteps,
    STATUS: status,
    LOG: 'stdout/stderr (no dedicated setup.log file)',
  });

  if (status === 'failed') process.exit(1);
}
