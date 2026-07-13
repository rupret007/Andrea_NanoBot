import type { AssistantRequestRoute } from './assistant-routing.js';

const DEAD_ASSISTANT_SESSION_PATTERN =
  /no conversation found with session id(?::|\s)\s*[a-z0-9-]+/i;

export type AssistantCapabilityLane =
  | 'direct-assistant'
  | 'protected'
  | 'control'
  | 'execution';

export function getAssistantCapabilityLane(
  route?: AssistantRequestRoute,
): AssistantCapabilityLane {
  if (route === 'protected_assistant') return 'protected';
  if (route === 'control_plane') return 'control';
  if (route === 'advanced_helper' || route === 'code_plane') {
    return 'execution';
  }
  return 'direct-assistant';
}

export function getAssistantSessionStorageKey(
  groupFolder: string,
  route?: AssistantRequestRoute,
): string {
  const lane = getAssistantCapabilityLane(route);
  return `${groupFolder}::${lane.replace(/-/g, '_')}`;
}

export function getAssistantSessionHomeFlavor(
  route?: AssistantRequestRoute,
): AssistantCapabilityLane {
  return getAssistantCapabilityLane(route);
}

export function isDeadAssistantSessionErrorText(
  value: string | null | undefined,
): boolean {
  return DEAD_ASSISTANT_SESSION_PATTERN.test((value || '').trim());
}

/**
 * A stale-session answer is suppressed from the user, but any receipt emitted
 * with it must survive the fresh-session retry. Otherwise a failed or
 * uncertain side effect can disappear from the final turn reconciliation.
 */
export function getSuppressedDeadSessionRuntimeEvidence<T>(
  output: {
    result: string | null;
    error?: string | null;
    runtimeToolEvidence?: T;
  },
  options: { streamedEvidenceForwarded?: boolean } = {},
): T | null {
  // The terminal fallback can be a composite of receipts already streamed
  // individually. Forwarding both would double-count the same calls.
  if (options.streamedEvidenceForwarded) return null;
  if (
    !isDeadAssistantSessionErrorText(output.result) &&
    !isDeadAssistantSessionErrorText(output.error)
  ) {
    return null;
  }
  return output.runtimeToolEvidence ?? null;
}
