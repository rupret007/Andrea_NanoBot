import {
  OPENAI_MODEL_COMPLEX,
  OPENAI_MODEL_FALLBACK,
  OPENAI_MODEL_SIMPLE,
  OPENAI_MODEL_STANDARD,
} from './config.js';

export type OpenAiModelTier = 'simple' | 'standard' | 'complex';
export type OpenAiProviderMode = 'direct_openai' | 'compatible_gateway';

export interface OpenAiTextModelConfig {
  simpleModel?: string | null;
  standardModel?: string | null;
  complexModel?: string | null;
  fallbackModel?: string | null;
}

export interface OpenAiTextModelSet {
  simpleModel: string;
  standardModel: string;
  complexModel: string;
  fallbackModel: string;
}

export interface OpenAiModelCandidate {
  tier: OpenAiModelTier;
  model: string;
}

const TIER_ORDER: Record<OpenAiModelTier, OpenAiModelTier[]> = {
  simple: ['simple', 'standard', 'complex'],
  standard: ['standard', 'complex'],
  complex: ['complex'],
};

function normalizeModel(value: string | null | undefined): string {
  return (value || '').trim();
}

export function buildOpenAiTextModelSet(
  config: OpenAiTextModelConfig = {},
): OpenAiTextModelSet {
  const fallbackModel =
    normalizeModel(config.fallbackModel) || OPENAI_MODEL_FALLBACK;
  return {
    simpleModel:
      normalizeModel(config.simpleModel) ||
      OPENAI_MODEL_SIMPLE ||
      fallbackModel,
    standardModel:
      normalizeModel(config.standardModel) ||
      OPENAI_MODEL_STANDARD ||
      fallbackModel,
    complexModel:
      normalizeModel(config.complexModel) ||
      OPENAI_MODEL_COMPLEX ||
      fallbackModel,
    fallbackModel,
  };
}

export function buildOpenAiModelCandidates(
  preferredTier: OpenAiModelTier,
  config: OpenAiTextModelConfig = {},
): OpenAiModelCandidate[] {
  const models = buildOpenAiTextModelSet(config);
  const ordered = TIER_ORDER[preferredTier].map((tier) => ({
    tier,
    model:
      tier === 'simple'
        ? models.simpleModel
        : tier === 'standard'
          ? models.standardModel
          : models.complexModel,
  }));
  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    if (!candidate.model || seen.has(candidate.model)) {
      return false;
    }
    seen.add(candidate.model);
    return true;
  });
}

export function detectOpenAiProviderMode(baseUrl: string): OpenAiProviderMode {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname.toLowerCase() === 'api.openai.com'
      ? 'direct_openai'
      : 'compatible_gateway';
  } catch {
    return /api\.openai\.com/i.test(baseUrl)
      ? 'direct_openai'
      : 'compatible_gateway';
  }
}

export function isOpenAiModelRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) {
    return false;
  }
  const normalized = body.toLowerCase();
  if (!normalized.includes('model')) {
    return false;
  }
  return (
    normalized.includes('not found') ||
    normalized.includes('does not exist') ||
    normalized.includes('unknown model') ||
    normalized.includes('unsupported') ||
    normalized.includes('invalid model') ||
    normalized.includes('model_not_found')
  );
}
