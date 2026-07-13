import type { AssistantRequestRoute } from './assistant-routing.js';

const DEAD_ASSISTANT_SESSION_PATTERN =
  /no conversation found with session id(?::|\s)\s*[a-z0-9-]+/i;

export function getAssistantSessionStorageKey(
  groupFolder: string,
  route?: AssistantRequestRoute,
): string {
  return route === 'direct_assistant' || route === 'protected_assistant'
    ? `${groupFolder}::${route}`
    : groupFolder;
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
