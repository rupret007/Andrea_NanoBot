import { getRouterState, setRouterState } from './db.js';

export const OPENAI_GUIDED_ROUTING_STATE_KEY = 'openai_guided_routing_last';

export interface OpenAiGuidedRoutingState {
  at: string;
  channel: 'telegram' | 'bluebubbles';
  source: 'local_fast_path' | 'openai_router' | 'deterministic_fallback';
  routeKind?: string | null;
  capabilityId?: string | null;
  confidence?: string | null;
  fallbackReason?: string | null;
}

export function recordOpenAiGuidedRoutingState(
  state: OpenAiGuidedRoutingState,
): void {
  setRouterState(OPENAI_GUIDED_ROUTING_STATE_KEY, JSON.stringify(state));
}

export function readOpenAiGuidedRoutingState(): OpenAiGuidedRoutingState | null {
  const raw = getRouterState(OPENAI_GUIDED_ROUTING_STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpenAiGuidedRoutingState;
  } catch {
    return null;
  }
}
