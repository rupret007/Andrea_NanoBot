import { readEnvFile } from './env.js';
import {
  describeProviderTransportFailure,
  providerRequestSignal,
} from './provider-http.js';

const envConfig = readEnvFile([
  'GEMINI_ENABLED',
  'GEMINI_API_KEY',
  'GEMINI_OPENAI_BASE_URL',
  'GEMINI_MODEL_CRITIC',
  'GEMINI_MODEL_FAST',
  'GEMINI_QUOTA_STATE',
]);

export interface GeminiProviderConfig {
  enabled: boolean;
  apiKey: string;
  openAiBaseUrl: string;
  criticModel: string;
  fastModel: string;
}

export interface GeminiProviderStatus {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  quotaState: 'ok' | 'blocked' | 'unknown';
  openAiBaseUrl: string;
  criticModel: string;
  fastModel: string;
}

export interface GeminiTextRequest {
  system?: string;
  prompt: string;
  modelTier?: 'fast' | 'critic';
  maxTokens?: number;
  temperature?: number;
}

export interface GeminiTextResult {
  text: string;
  model: string;
  requestId?: string;
}

export interface GeminiProviderFailure {
  providerFailure: string;
  status?: number;
  requestId?: string;
}

const GEMINI_BLOCKED_QUOTA_STATES = new Set([
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
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.3;
  return Math.min(1, Math.max(0.01, value));
}

function resolveCompletionBudget(request: GeminiTextRequest): number {
  // Gemini 2.5 Pro may spend part of this OpenAI-compatible budget on
  // internal reasoning before emitting visible text, so verifier calls need
  // a larger floor than the requested visible answer size.
  const requested = Math.max(64, request.maxTokens || 900);
  const floor = request.modelTier === 'critic' ? 2048 : 1024;
  return Math.max(requested, floor);
}

export function getGeminiQuotaState(): GeminiProviderStatus['quotaState'] {
  const value = readConfigValue('GEMINI_QUOTA_STATE').trim().toLowerCase();
  if (!value) return 'unknown';
  return GEMINI_BLOCKED_QUOTA_STATES.has(value) ? 'blocked' : 'ok';
}

export function resolveGeminiProviderConfig(): GeminiProviderConfig | null {
  const enabledValue = readConfigValue('GEMINI_ENABLED');
  const enabled =
    enabledValue === ''
      ? Boolean(readConfigValue('GEMINI_API_KEY'))
      : enabledValue !== 'false';
  const apiKey = readConfigValue('GEMINI_API_KEY');
  if (!enabled || !apiKey) return null;

  return {
    enabled,
    apiKey,
    openAiBaseUrl: normalizeBaseUrl(
      readConfigValue('GEMINI_OPENAI_BASE_URL'),
      'https://generativelanguage.googleapis.com/v1beta/openai',
    ),
    criticModel: readConfigValue('GEMINI_MODEL_CRITIC') || 'gemini-2.5-pro',
    fastModel: readConfigValue('GEMINI_MODEL_FAST') || 'gemini-2.5-flash',
  };
}

export function getGeminiProviderStatus(): GeminiProviderStatus {
  const enabledValue = readConfigValue('GEMINI_ENABLED');
  const enabled =
    enabledValue === ''
      ? Boolean(readConfigValue('GEMINI_API_KEY'))
      : enabledValue !== 'false';
  const missing: string[] = [];
  if (enabled && !readConfigValue('GEMINI_API_KEY')) {
    missing.push('GEMINI_API_KEY');
  }
  return {
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    quotaState: getGeminiQuotaState(),
    openAiBaseUrl: normalizeBaseUrl(
      readConfigValue('GEMINI_OPENAI_BASE_URL'),
      'https://generativelanguage.googleapis.com/v1beta/openai',
    ),
    criticModel: readConfigValue('GEMINI_MODEL_CRITIC') || 'gemini-2.5-pro',
    fastModel: readConfigValue('GEMINI_MODEL_FAST') || 'gemini-2.5-flash',
  };
}

export function describeGeminiConfigBlocker(missing: string[]): string {
  if (missing.includes('GEMINI_API_KEY')) {
    return 'Gemini is enabled but its API key is not configured.';
  }
  return 'Gemini is not configured for this host.';
}

export function describeGeminiProviderFailure(
  status: number,
  body: string,
): string {
  const normalized = body.toLowerCase();
  if (
    status === 401 ||
    normalized.includes('api key not valid') ||
    normalized.includes('invalid api key') ||
    normalized.includes('unauthorized')
  ) {
    return 'Gemini rejected the configured API key. Regenerate or replace the Gemini key, then rerun provider health checks.';
  }
  if (status === 403) {
    return 'Gemini denied the request for this account or model. Check Google AI Studio permissions and model access.';
  }
  if (
    status === 429 ||
    normalized.includes('quota') ||
    normalized.includes('rate') ||
    normalized.includes('resource_exhausted') ||
    normalized.includes('billing')
  ) {
    return 'Gemini rate limit or quota blocked this request. Wait for quota recovery or adjust the Gemini plan.';
  }
  if (status >= 500) {
    return 'Gemini returned a server-side error before Andrea could produce a trustworthy answer.';
  }
  return 'Gemini returned an unexpected provider error before Andrea could produce a trustworthy answer.';
}

function extractGeminiText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices)) return '';
  return choices
    .map((choice) => {
      if (!choice || typeof choice !== 'object') return '';
      const message = (choice as Record<string, unknown>).message;
      if (!message || typeof message !== 'object') return '';
      const content = (message as Record<string, unknown>).content;
      return typeof content === 'string' ? content : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function runGeminiOpenAiText(
  request: GeminiTextRequest,
): Promise<GeminiTextResult | GeminiProviderFailure | null> {
  const config = resolveGeminiProviderConfig();
  if (!config) return null;
  if (getGeminiQuotaState() === 'blocked') {
    return {
      providerFailure:
        'Gemini rate limit or quota blocked this request. Wait for quota recovery or adjust the Gemini plan.',
      status: 429,
    };
  }
  const model =
    request.modelTier === 'fast' ? config.fastModel : config.criticModel;
  let response: Response;
  try {
    response = await fetch(`${config.openAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: resolveCompletionBudget(request),
        temperature: normalizeTemperature(request.temperature),
        messages: [
          ...(request.system
            ? [{ role: 'system', content: request.system }]
            : []),
          { role: 'user', content: request.prompt },
        ],
      }),
      signal: providerRequestSignal(),
    });
  } catch (err) {
    return {
      providerFailure: describeProviderTransportFailure('Gemini', err),
    };
  }
  const requestId =
    response.headers.get('x-request-id') ||
    response.headers.get('x-goog-request-id') ||
    undefined;
  if (!response.ok) {
    const body = await response.text();
    return {
      providerFailure: describeGeminiProviderFailure(response.status, body),
      status: response.status,
      requestId,
    };
  }
  const payload = (await response.json()) as unknown;
  const text = extractGeminiText(payload);
  if (!text) {
    return {
      providerFailure: 'Gemini returned an empty text payload.',
      requestId,
    };
  }
  return {
    text,
    model,
    requestId,
  };
}
