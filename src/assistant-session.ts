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
