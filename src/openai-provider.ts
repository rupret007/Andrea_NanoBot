import {
  OPENAI_MODEL_COMPLEX,
  OPENAI_MODEL_FALLBACK,
  OPENAI_MODEL_SIMPLE,
  OPENAI_MODEL_STANDARD,
} from './config.js';
import { readEnvFile } from './env.js';
import {
  describeProviderTransportFailure,
  providerRequestSignal,
} from './provider-http.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';

export interface OpenAiProviderConfig {
  apiKey: string;
  baseUrl: string;
  simpleModel: string;
  standardModel: string;
  complexModel: string;
  researchModel: string;
  imageModel: string;
}

export interface OpenAiProviderStatus {
  configured: boolean;
  missing: string[];
  baseUrl: string;
  simpleModel: string;
  standardModel: string;
  complexModel: string;
  researchModel: string;
  imageModel: string;
}

export interface OpenAiTextRequest {
  system?: string;
  prompt: string;
  modelTier?: 'simple' | 'standard' | 'complex';
  maxTokens?: number;
  temperature?: number;
}

export interface OpenAiTextResult {
  text: string;
  model: string;
  requestId?: string;
}

export interface OpenAiProviderFailure {
  providerFailure: string;
  status?: number;
  requestId?: string;
}

function readOpenAiEnv(): Record<string, string> {
  return readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL_SIMPLE',
    'OPENAI_MODEL_STANDARD',
    'OPENAI_MODEL_COMPLEX',
    'OPENAI_MODEL_FALLBACK',
    'OPENAI_IMAGE_MODEL',
  ]);
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/g, '');
}

export function getOpenAiProviderStatus(): OpenAiProviderStatus {
  const env = readOpenAiEnv();
  const apiKey = (
    process.env.OPENAI_API_KEY ||
    env.OPENAI_API_KEY ||
    ''
  ).trim();
  const baseUrl = normalizeBaseUrl(
    process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL,
  );
  const fallbackModel =
    (
      process.env.OPENAI_MODEL_FALLBACK ||
      env.OPENAI_MODEL_FALLBACK ||
      OPENAI_MODEL_FALLBACK
    ).trim() || OPENAI_MODEL_FALLBACK;
  const simpleModel =
    (
      process.env.OPENAI_MODEL_SIMPLE ||
      env.OPENAI_MODEL_SIMPLE ||
      OPENAI_MODEL_SIMPLE ||
      fallbackModel
    ).trim() || fallbackModel;
  const standardModel =
    (
      process.env.OPENAI_MODEL_STANDARD ||
      env.OPENAI_MODEL_STANDARD ||
      OPENAI_MODEL_STANDARD ||
      fallbackModel
    ).trim() || fallbackModel;
  const complexModel =
    (
      process.env.OPENAI_MODEL_COMPLEX ||
      env.OPENAI_MODEL_COMPLEX ||
      OPENAI_MODEL_COMPLEX ||
      fallbackModel
    ).trim() || fallbackModel;
  const imageModel =
    (
      process.env.OPENAI_IMAGE_MODEL ||
      env.OPENAI_IMAGE_MODEL ||
      DEFAULT_OPENAI_IMAGE_MODEL
    ).trim() || DEFAULT_OPENAI_IMAGE_MODEL;

  return {
    configured: Boolean(apiKey),
    missing: apiKey ? [] : ['OPENAI_API_KEY'],
    baseUrl,
    simpleModel,
    standardModel,
    complexModel,
    researchModel: standardModel,
    imageModel,
  };
}

export function resolveOpenAiProviderConfig(): OpenAiProviderConfig | null {
  const status = getOpenAiProviderStatus();
  if (!status.configured) {
    return null;
  }

  const env = readOpenAiEnv();
  return {
    apiKey: (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim(),
    baseUrl: status.baseUrl,
    simpleModel: status.simpleModel,
    standardModel: status.standardModel,
    complexModel: status.complexModel,
    researchModel: status.researchModel,
    imageModel: status.imageModel,
  };
}

export function describeOpenAiConfigBlocker(missing: string[]): string {
  if (missing.length === 0) {
    return '';
  }
  if (missing.length === 1) {
    return `${missing[0]} is not configured.`;
  }
  return `${missing.join(', ')} are not configured.`;
}

export function describeOpenAiProviderFailure(
  status: number,
  body: string,
  surface: 'research' | 'image',
): string {
  const normalized = body.toLowerCase();
  const subject =
    surface === 'image'
      ? 'the OpenAI image account on this machine'
      : "Andrea's OpenAI research path on this machine";

  if (
    normalized.includes('insufficient_quota') ||
    normalized.includes('billing_hard_limit_reached') ||
    normalized.includes('billing_limit_user_error') ||
    normalized.includes('quota') ||
    normalized.includes('billing hard limit')
  ) {
    return `${subject} has hit a quota or billing limit.`;
  }

  if (
    status === 401 ||
    normalized.includes('invalid_api_key') ||
    normalized.includes('incorrect api key')
  ) {
    return `${subject} rejected the configured API key.`;
  }

  if (status === 403) {
    return `${subject} was denied by the provider.`;
  }

  return surface === 'image'
    ? 'The image provider rejected the live generation request.'
    : 'The live OpenAI research request failed at the provider.';
}

function normalizeTemperature(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.25;
  return Math.min(1, Math.max(0.01, value));
}

function extractOpenAiText(payload: unknown): string {
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

export async function runOpenAiChatText(
  request: OpenAiTextRequest,
): Promise<OpenAiTextResult | OpenAiProviderFailure | null> {
  const config = resolveOpenAiProviderConfig();
  if (!config) return null;
  const model =
    request.modelTier === 'complex'
      ? config.complexModel
      : request.modelTier === 'simple'
        ? config.simpleModel
        : config.standardModel;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: Math.max(64, request.maxTokens || 900),
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
      providerFailure: describeProviderTransportFailure('OpenAI', err),
    };
  }
  const requestId = response.headers.get('x-request-id') || undefined;
  if (!response.ok) {
    const body = await response.text();
    return {
      providerFailure: describeOpenAiProviderFailure(
        response.status,
        body,
        'research',
      ),
      status: response.status,
      requestId,
    };
  }
  const payload = (await response.json()) as unknown;
  const text = extractOpenAiText(payload);
  if (!text) {
    return {
      providerFailure: 'OpenAI returned an empty text payload.',
      requestId,
    };
  }
  return { text, model, requestId };
}
