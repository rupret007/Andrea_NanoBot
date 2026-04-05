import { OPENAI_MODEL_FALLBACK } from './config.js';
import { readEnvFile } from './env.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';

export interface OpenAiProviderConfig {
  apiKey: string;
  baseUrl: string;
  researchModel: string;
  imageModel: string;
}

export interface OpenAiProviderStatus {
  configured: boolean;
  missing: string[];
  baseUrl: string;
  researchModel: string;
  imageModel: string;
}

function readOpenAiEnv(): Record<string, string> {
  return readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL_FALLBACK',
    'OPENAI_IMAGE_MODEL',
  ]);
}

function normalizeBaseUrl(value: string | undefined): string {
  return (value || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/g, '');
}

export function getOpenAiProviderStatus(): OpenAiProviderStatus {
  const env = readOpenAiEnv();
  const apiKey = (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim();
  const baseUrl = normalizeBaseUrl(
    process.env.OPENAI_BASE_URL || env.OPENAI_BASE_URL,
  );
  const researchModel =
    (
      process.env.OPENAI_MODEL_FALLBACK ||
      env.OPENAI_MODEL_FALLBACK ||
      OPENAI_MODEL_FALLBACK
    ).trim() || OPENAI_MODEL_FALLBACK;
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
    researchModel,
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
