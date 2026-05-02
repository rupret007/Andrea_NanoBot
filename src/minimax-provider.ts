import { readEnvFile } from './env.js';

const envConfig = readEnvFile([
  'MINIMAX_ENABLED',
  'MINIMAX_API_KEY',
  'MINIMAX_ANTHROPIC_BASE_URL',
  'MINIMAX_OPENAI_BASE_URL',
  'MINIMAX_MODEL_COMPLEX',
  'MINIMAX_MODEL_FAST',
]);

export interface MiniMaxProviderConfig {
  enabled: boolean;
  apiKey: string;
  anthropicBaseUrl: string;
  openAiBaseUrl: string;
  complexModel: string;
  fastModel: string;
}

export interface MiniMaxProviderStatus {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  anthropicBaseUrl: string;
  openAiBaseUrl: string;
  complexModel: string;
  fastModel: string;
}

export interface MiniMaxTextRequest {
  system?: string;
  prompt: string;
  modelTier?: 'fast' | 'complex';
  maxTokens?: number;
  temperature?: number;
}

export interface MiniMaxTextResult {
  text: string;
  model: string;
  requestId?: string;
}

export interface MiniMaxProviderFailure {
  providerFailure: string;
  status?: number;
  requestId?: string;
}

function readConfigValue(key: keyof typeof envConfig | string): string {
  return process.env[key] || envConfig[key] || '';
}

function normalizeBaseUrl(value: string, fallback: string): string {
  return (value || fallback).replace(/\/+$/g, '');
}

export function resolveMiniMaxProviderConfig(): MiniMaxProviderConfig | null {
  const enabledValue = readConfigValue('MINIMAX_ENABLED');
  const enabled =
    enabledValue === ''
      ? Boolean(readConfigValue('MINIMAX_API_KEY'))
      : enabledValue !== 'false';
  const apiKey = readConfigValue('MINIMAX_API_KEY');
  if (!enabled || !apiKey) return null;

  return {
    enabled,
    apiKey,
    anthropicBaseUrl: normalizeBaseUrl(
      readConfigValue('MINIMAX_ANTHROPIC_BASE_URL'),
      'https://api.minimax.io/anthropic',
    ),
    openAiBaseUrl: normalizeBaseUrl(
      readConfigValue('MINIMAX_OPENAI_BASE_URL'),
      'https://api.minimax.io/v1',
    ),
    complexModel: readConfigValue('MINIMAX_MODEL_COMPLEX') || 'MiniMax-M2.7',
    fastModel:
      readConfigValue('MINIMAX_MODEL_FAST') || 'MiniMax-M2.7-highspeed',
  };
}

export function getMiniMaxProviderStatus(): MiniMaxProviderStatus {
  const enabledValue = readConfigValue('MINIMAX_ENABLED');
  const enabled =
    enabledValue === ''
      ? Boolean(readConfigValue('MINIMAX_API_KEY'))
      : enabledValue !== 'false';
  const missing: string[] = [];
  if (enabled && !readConfigValue('MINIMAX_API_KEY')) {
    missing.push('MINIMAX_API_KEY');
  }
  return {
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    anthropicBaseUrl: normalizeBaseUrl(
      readConfigValue('MINIMAX_ANTHROPIC_BASE_URL'),
      'https://api.minimax.io/anthropic',
    ),
    openAiBaseUrl: normalizeBaseUrl(
      readConfigValue('MINIMAX_OPENAI_BASE_URL'),
      'https://api.minimax.io/v1',
    ),
    complexModel: readConfigValue('MINIMAX_MODEL_COMPLEX') || 'MiniMax-M2.7',
    fastModel:
      readConfigValue('MINIMAX_MODEL_FAST') || 'MiniMax-M2.7-highspeed',
  };
}

export function describeMiniMaxConfigBlocker(missing: string[]): string {
  if (missing.includes('MINIMAX_API_KEY')) {
    return 'MiniMax is enabled but its API key is not configured.';
  }
  return 'MiniMax is not configured for this host.';
}

export function describeMiniMaxProviderFailure(
  status: number,
  body: string,
): string {
  const normalized = body.toLowerCase();
  if (status === 401 || normalized.includes('invalid api key')) {
    return 'MiniMax rejected the configured API key. Regenerate or replace the MiniMax key, then rerun provider health checks.';
  }
  if (status === 403) {
    return 'MiniMax denied the request for this account or model. Check MiniMax account permissions and model access.';
  }
  if (
    status === 429 ||
    normalized.includes('quota') ||
    normalized.includes('rate')
  ) {
    return 'MiniMax rate limit or quota blocked this request. Wait for quota recovery or adjust the MiniMax plan.';
  }
  if (status >= 500) {
    return 'MiniMax returned a server-side error before Andrea could produce a trustworthy answer.';
  }
  return 'MiniMax returned an unexpected provider error before Andrea could produce a trustworthy answer.';
}

function extractMiniMaxText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
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
  return '';
}

export async function runMiniMaxAnthropicText(
  request: MiniMaxTextRequest,
): Promise<MiniMaxTextResult | MiniMaxProviderFailure | null> {
  const config = resolveMiniMaxProviderConfig();
  if (!config) return null;
  const model =
    request.modelTier === 'fast' ? config.fastModel : config.complexModel;
  const response = await fetch(`${config.anthropicBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.max(64, request.maxTokens || 900),
      temperature: request.temperature ?? 0.4,
      ...(request.system ? { system: request.system } : {}),
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: request.prompt }],
        },
      ],
    }),
  });
  const requestId = response.headers.get('x-request-id') || undefined;
  if (!response.ok) {
    const body = await response.text();
    return {
      providerFailure: describeMiniMaxProviderFailure(response.status, body),
      status: response.status,
      requestId,
    };
  }
  const payload = (await response.json()) as unknown;
  const text = extractMiniMaxText(payload);
  if (!text) {
    return {
      providerFailure: 'MiniMax returned an empty text payload.',
      requestId,
    };
  }
  return {
    text,
    model,
    requestId,
  };
}
