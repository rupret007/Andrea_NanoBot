import { getRouterState, setRouterState } from './db.js';
import type {
  OpenAiModelTier,
  OpenAiProviderMode,
} from './openai-model-routing.js';
import { logger } from './logger.js';
import { recordVerifiedUsageReliability } from './tool-reliability.js';

export const OPENAI_USAGE_STATE_KEY = 'openai_usage_last';

export interface OpenAiUsageState {
  at: string;
  surface:
    | 'research'
    | 'messages_fluidity'
    | 'everyday_capture'
    | 'recent_text_review';
  selectedModelTier?: OpenAiModelTier | null;
  selectedModel?: string | null;
  providerMode?: OpenAiProviderMode | null;
  outcome: 'success' | 'blocked' | 'failed';
  detail?: string | null;
}

export function recordOpenAiUsageState(state: OpenAiUsageState): void {
  try {
    setRouterState(OPENAI_USAGE_STATE_KEY, JSON.stringify(state));
  } catch {
    // Some focused tests exercise routing helpers without the shared DB bootstrapped.
    // Usage-state observability should never break the user-facing path.
  }
  try {
    recordVerifiedUsageReliability({
      subjectIds: ['provider:openai_cloud'],
      observedAt: state.at,
      outcome: state.outcome,
      failureClass:
        state.outcome === 'success'
          ? 'none'
          : state.outcome === 'blocked'
            ? 'provider_blocked'
            : 'provider_request_failed',
      summary:
        state.outcome === 'success'
          ? `OpenAI completed a verified ${state.surface} request.`
          : `OpenAI ${state.surface} request ${state.outcome}.`,
      nextAction:
        state.outcome === 'success'
          ? ''
          : 'Use a healthy fallback and retry only after provider status changes.',
      evidenceRef: `openai_usage:${state.surface}`,
    });
  } catch (err) {
    logger.warn(
      {
        component: 'tool_reliability',
        surface: state.surface,
        outcome: state.outcome,
        errorClass: err instanceof Error ? err.name : typeof err,
      },
      'OpenAI usage completed, but reliability evidence could not be recorded.',
    );
  }
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
