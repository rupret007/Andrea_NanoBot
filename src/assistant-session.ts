import type { AssistantRequestRoute } from './assistant-routing.js';

export function getAssistantSessionStorageKey(
  groupFolder: string,
  route?: AssistantRequestRoute,
): string {
  return route === 'direct_assistant' || route === 'protected_assistant'
    ? `${groupFolder}::${route}`
    : groupFolder;
}
