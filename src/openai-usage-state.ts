import { getRouterState, setRouterState } from './db.js';
import type {
  OpenAiModelTier,
  OpenAiProviderMode,
} from './openai-model-routing.js';

export const OPENAI_USAGE_STATE_KEY = 'openai_usage_last';

export interface OpenAiUsageState {
  at: string;
  surface: 'research' | 'messages_fluidity' | 'everyday_capture';
  selectedModelTier?: OpenAiModelTier | null;
  selectedModel?: string | null;
  providerMode?: OpenAiProviderMode | null;
  outcome: 'success' | 'blocked' | 'failed';
  detail?: string | null;
}

export function recordOpenAiUsageState(state: OpenAiUsageState): void {
  setRouterState(OPENAI_USAGE_STATE_KEY, JSON.stringify(state));
}

export function readOpenAiUsageState(): OpenAiUsageState | null {
  const raw = getRouterState(OPENAI_USAGE_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpenAiUsageState;
  } catch {
    return null;
  }
}
