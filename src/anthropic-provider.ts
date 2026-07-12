import { readEnvFile } from './env.js';
import {
  describeProviderTransportFailure,
  providerRequestSignal,
} from './provider-http.js';
import type { CouncilUltrathinkTrace } from './council-contracts.js';

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-3-5-sonnet-latest';
export const DEFAULT_ANTHROPIC_FAST_MODEL = 'claude-3-5-haiku-latest';

const envConfig = readEnvFile([
  'ANTHROPIC_ENABLED',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_MODEL_COMPLEX',
  'ANTHROPIC_MODEL_FAST',
  'CLAUDE_MODEL',
  'NANOCLAW_AGENT_MODEL',
  'ANTHROPIC_QUOTA_STATE',
]);

export interface AnthropicProviderConfig {
  enabled: boolean;
  apiKey: string;
  authMode: 'x-api-key' | 'bearer';
  baseUrl: string;
  complexModel: string;
  fastModel: string;
}

export interface AnthropicProviderStatus {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  quotaState: 'ok' | 'blocked' | 'unknown';
  baseUrl: string;
  complexModel: string;
  fastModel: string;
  authMode: 'x-api-key' | 'bearer' | 'none';
}

export interface AnthropicTextRequest {
  system?: string;
  prompt: string;
  modelTier?: 'fast' | 'complex';
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  adaptiveThinking?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface AnthropicTextResult {
  text: string;
  model: string;
  requestId?: string;
  inputTokens?: number;
  outputTokens?: number;
  thinkingTrace?: CouncilUltrathinkTrace;
}

export interface AnthropicProviderFailure {
  providerFailure: string;
  status?: number;
  requestId?: string;
}

const ANTHROPIC_BLOCKED_QUOTA_STATES = new Set([
  'blocked',
  'quota_blocked',
  'rate_limited',
  'insufficient_balance',
  'externally_blocked',
]);

function readConfigValue(key: keyof typeof envConfig | string): string {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    return process.env[key] || '';
  }
  return envConfig[key] || '';
}

function normalizeBaseUrl(value: string, fallback: string): string {
  return (value || fallback).replace(/\/+$/g, '');
}

function normalizeTemperature(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.25;
  return Math.min(1, Math.max(0.01, value));
}

function supportsAnthropicAdaptiveThinking(model: string): boolean {
  const normalized = model.toLowerCase().replace(/\./g, '-');
  return (
    normalized.includes('claude-mythos') ||
    /\bclaude-(?:opus|sonnet)-4-(?:6|7|8)\b/.test(normalized) ||
    /\b(?:opus|sonnet)-4-(?:6|7|8)\b/.test(normalized)
  );
}

function supportsXHighEffort(model: string): boolean {
  const normalized = model.toLowerCase().replace(/\./g, '-');
  return (
    normalized.includes('claude-mythos') ||
    /\bclaude-opus-4-(?:7|8)\b/.test(normalized) ||
    /\bopus-4-(?:7|8)\b/.test(normalized)
  );
}

function normalizeReasoningEffort(
  value: AnthropicTextRequest['reasoningEffort'],
  model: string,
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  if (value === 'max') return 'max';
  if (value === 'xhigh') return supportsXHighEffort(model) ? 'xhigh' : 'high';
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value;
  }
  return 'high';
}

function buildAnthropicThinkingRequest(
  request: AnthropicTextRequest,
  model: string,
): { controls: Record<string, unknown>; trace: CouncilUltrathinkTrace } {
  const requested = Boolean(request.adaptiveThinking);
  const effort = normalizeReasoningEffort(request.reasoningEffort, model);
  const supported =
    request.adaptiveThinking && supportsAnthropicAdaptiveThinking(model);
  const trace: CouncilUltrathinkTrace = {
    requested,
    trigger:
      request.reasoningEffort === 'max'
        ? 'ultrathink'
        : requested
          ? 'deep'
          : 'none',
    mode: requested ? 'max_iq_council' : 'standard',
    providerId: 'anthropic_cloud',
    model,
    adaptiveThinkingRequested: requested,
    adaptiveThinkingSupported: Boolean(supported),
    effortRequested: request.reasoningEffort || null,
    effortSent: supported ? effort : null,
    display: supported
      ? 'omitted'
      : requested
        ? 'unsupported'
        : 'not_requested',
    rawThinkingStored: false,
    hiddenReasoningExposed: false,
  };
  if (!request.adaptiveThinking || !supportsAnthropicAdaptiveThinking(model)) {
    return { controls: {}, trace };
  }
  return {
    controls: {
      thinking: {
        type: 'adaptive',
        display: 'omitted',
      },
      output_config: {
        effort,
      },
    },
    trace,
  };
}

function resolveAnthropicQuotaState(): AnthropicProviderStatus['quotaState'] {
  const value = readConfigValue('ANTHROPIC_QUOTA_STATE').trim().toLowerCase();
  if (!value) return 'unknown';
  return ANTHROPIC_BLOCKED_QUOTA_STATES.has(value) ? 'blocked' : 'ok';
}

function resolveConfiguredModel(fast = false): string {
  if (fast) {
    return (
      readConfigValue('ANTHROPIC_MODEL_FAST') ||
      readConfigValue('ANTHROPIC_MODEL') ||
      readConfigValue('CLAUDE_MODEL') ||
      readConfigValue('NANOCLAW_AGENT_MODEL') ||
      DEFAULT_ANTHROPIC_FAST_MODEL
    );
  }
  return (
    readConfigValue('ANTHROPIC_MODEL_COMPLEX') ||
    readConfigValue('ANTHROPIC_MODEL') ||
    readConfigValue('CLAUDE_MODEL') ||
    readConfigValue('NANOCLAW_AGENT_MODEL') ||
    DEFAULT_ANTHROPIC_MODEL
  );
}

function resolveAuth(): {
  apiKey: string;
  authMode: AnthropicProviderConfig['authMode'] | 'none';
} {
  const apiKey = readConfigValue('ANTHROPIC_API_KEY').trim();
  if (apiKey) return { apiKey, authMode: 'x-api-key' };
  const authToken = readConfigValue('ANTHROPIC_AUTH_TOKEN').trim();
  if (authToken) return { apiKey: authToken, authMode: 'bearer' };
  return { apiKey: '', authMode: 'none' };
}

export function getAnthropicProviderStatus(): AnthropicProviderStatus {
  const auth = resolveAuth();
  const enabledValue = readConfigValue('ANTHROPIC_ENABLED');
  const enabled =
    enabledValue === '' ? Boolean(auth.apiKey) : enabledValue !== 'false';
  const missing: string[] = [];
  if (enabled && !auth.apiKey) {
    missing.push('ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
  }
  return {
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    quotaState: resolveAnthropicQuotaState(),
    baseUrl: normalizeBaseUrl(
      readConfigValue('ANTHROPIC_BASE_URL'),
      DEFAULT_ANTHROPIC_BASE_URL,
    ),
    complexModel: resolveConfiguredModel(false),
    fastModel: resolveConfiguredModel(true),
    authMode: auth.authMode,
  };
}

export function resolveAnthropicProviderConfig(): AnthropicProviderConfig | null {
  const status = getAnthropicProviderStatus();
  if (!status.configured || status.authMode === 'none') return null;
  const auth = resolveAuth();
  if (auth.authMode === 'none') return null;
  return {
    enabled: true,
    apiKey: auth.apiKey,
    authMode: auth.authMode,
    baseUrl: status.baseUrl,
    complexModel: status.complexModel,
    fastModel: status.fastModel,
  };
}

export function describeAnthropicConfigBlocker(missing: string[]): string {
  if (missing.length > 0) {
    return `${missing.join(', ')} is not configured.`;
  }
  return 'Anthropic is not configured for this host.';
}

export function describeAnthropicProviderFailure(
  status: number,
  body: string,
): string {
  const normalized = body.toLowerCase();
  if (
    status === 401 ||
    normalized.includes('invalid api key') ||
    normalized.includes('authentication') ||
    normalized.includes('unauthorized')
  ) {
    return 'Anthropic rejected the configured API key or auth token. Regenerate or replace it, then rerun provider health checks.';
  }
  if (status === 403) {
    return 'Anthropic denied the request for this account or model. Check account permissions and model access.';
  }
  if (
    status === 429 ||
    normalized.includes('quota') ||
    normalized.includes('rate') ||
    normalized.includes('overloaded') ||
    normalized.includes('billing')
  ) {
    return 'Anthropic rate limit or quota blocked this request. Wait for recovery or adjust the Anthropic plan.';
  }
  if (status >= 500) {
    return 'Anthropic returned a server-side error before Andrea could produce a trustworthy answer.';
  }
  return 'Anthropic returned an unexpected provider error before Andrea could produce a trustworthy answer.';
}

function resolveCompletionBudget(request: AnthropicTextRequest): number {
  const requested = Math.max(64, request.maxTokens || 900);
  return request.modelTier === 'complex'
    ? Math.max(requested, 1536)
    : Math.max(requested, 768);
}

function buildAuthHeaders(
  config: AnthropicProviderConfig,
): Record<string, string> {
  if (config.authMode === 'bearer') {
    return { Authorization: `Bearer ${config.apiKey}` };
  }
  return { 'x-api-key': config.apiKey };
}

function extractAnthropicText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const block = item as Record<string, unknown>;
      return block.type === 'text' && typeof block.text === 'string'
        ? block.text
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function runAnthropicText(
  request: AnthropicTextRequest,
): Promise<AnthropicTextResult | AnthropicProviderFailure | null> {
  const config = resolveAnthropicProviderConfig();
  if (!config) return null;
  if (getAnthropicProviderStatus().quotaState === 'blocked') {
    return {
      providerFailure:
        'Anthropic rate limit or quota blocked this request. Wait for recovery or adjust the Anthropic plan.',
      status: 429,
    };
  }
  const model =
    request.modelTier === 'fast' ? config.fastModel : config.complexModel;
  const thinkingRequest = buildAnthropicThinkingRequest(request, model);
  const thinkingControls = thinkingRequest.controls;
  const thinkingEnabled = Object.keys(thinkingControls).length > 0;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...buildAuthHeaders(config),
      },
      body: JSON.stringify({
        model,
        max_tokens: resolveCompletionBudget(request),
        ...(thinkingEnabled
          ? {}
          : { temperature: normalizeTemperature(request.temperature) }),
        ...thinkingControls,
        ...(request.system ? { system: request.system } : {}),
        messages: [
          {
            role: 'user',
            content: request.prompt,
          },
        ],
      }),
      signal: providerRequestSignal(request.timeoutMs),
    });
  } catch (err) {
    return {
      providerFailure: describeProviderTransportFailure('Anthropic', err),
    };
  }
  const requestId =
    response.headers.get('request-id') ||
    response.headers.get('x-request-id') ||
    response.headers.get('anthropic-request-id') ||
    undefined;
  if (!response.ok) {
    const body = await response.text();
    return {
      providerFailure: describeAnthropicProviderFailure(response.status, body),
      status: response.status,
      requestId,
    };
  }
  const payload = (await response.json()) as unknown;
  const text = extractAnthropicText(payload);
  if (!text) {
    return {
      providerFailure: 'Anthropic returned an empty text payload.',
      requestId,
    };
  }
  const usage =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).usage
      : null;
  const usageRecord =
    usage && typeof usage === 'object'
      ? (usage as Record<string, unknown>)
      : null;
  return {
    text,
    model,
    requestId,
    inputTokens:
      typeof usageRecord?.input_tokens === 'number'
        ? usageRecord.input_tokens
        : undefined,
    outputTokens:
      typeof usageRecord?.output_tokens === 'number'
        ? usageRecord.output_tokens
        : undefined,
    thinkingTrace: thinkingRequest.trace,
  };
}
