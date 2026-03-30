import type { AssistantRequestRoute } from './assistant-routing.js';
import { maybeBuildDirectRescueReply } from './direct-quick-reply.js';
import type { NewMessage } from './types.js';

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function buildSilentSuccessFallback(
  route: AssistantRequestRoute,
  messages: Pick<NewMessage, 'content'>[],
): string {
  const lastContent = messages.at(-1)?.content?.trim() ?? '';
  const normalized = normalize(lastContent);

  if (route === 'direct_assistant') {
    return (
      maybeBuildDirectRescueReply(messages) ??
      "I'm here, but that answer came back blank on my side. Ask it again in one short sentence and I'll keep it crisp."
    );
  }

  if (route === 'protected_assistant') {
    if (
      /\b(remind|reminder|schedule|appointment|calendar)\b/.test(normalized)
    ) {
      return "I couldn't confirm that reminder was saved, so I haven't assumed it went through. Please try it again and I'll keep the confirmation explicit.";
    }

    return "I couldn't confirm that request completed, so I haven't assumed it succeeded. Please try it again and I'll keep the confirmation explicit.";
  }

  if (route === 'control_plane') {
    return "I couldn't confirm that control action completed. Please check status and try again.";
  }

  return "I didn't get a usable final response back in time. Please try again.";
}
