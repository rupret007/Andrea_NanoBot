import {
  OPENAI_MODEL_COMPLEX,
  OPENAI_MODEL_FALLBACK,
  OPENAI_MODEL_SIMPLE,
  OPENAI_MODEL_STANDARD,
} from './config.js';
import { readEnvFile } from './env.js';

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
  const apiKey = (process.env.OPENAI_API_KEY || env.OPENAI_API_KEY || '').trim();
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
