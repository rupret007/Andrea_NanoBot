import type { AssistantRequestRoute } from './assistant-routing.js';
import {
  buildGracefulDegradedReply,
  type ConversationalChannel,
  isLiveLookupConversationalPrompt,
} from './conversational-core.js';
import { buildDirectAssistantRuntimeFailureReply } from './direct-quick-reply.js';
import type { NewMessage } from './types.js';

function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim();
}

const PROTECTED_ASSISTANT_RUNTIME_LEAK_RE =
  /\b(temporary execution issue|processing that request|runtime failed|failed before first output|failed during startup or execution|container runtime|setup verify|execution readiness logs?|operator should|gateway authentication failed|invalid model name|api error|no conversation found with session id)\b/i;

export function buildSilentSuccessFallback(
  route: AssistantRequestRoute,
  messages: Pick<NewMessage, 'content'>[],
  channel: ConversationalChannel = 'telegram',
): string {
  const lastContent = messages.at(-1)?.content?.trim() ?? '';
  const normalized = normalize(lastContent);

  if (route === 'direct_assistant') {
    return buildDirectAssistantRuntimeFailureReply(
      messages,
      null,
      new Date(),
      channel,
    );
  }

  if (route === 'protected_assistant') {
    if (isLiveLookupConversationalPrompt(lastContent)) {
      return buildGracefulDegradedReply({
        kind: 'research_unavailable',
        channel,
        text: lastContent,
      });
    }

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

export function maybeShieldProtectedAssistantOutput(
  messages: Pick<NewMessage, 'content'>[],
  outputText: string | null | undefined,
  channel: ConversationalChannel = 'telegram',
  options: { forceLiveLookupFallback?: boolean } = {},
): string | null {
  const lastContent = messages.at(-1)?.content?.trim() ?? '';
  const liveLookupPrompt = isLiveLookupConversationalPrompt(lastContent);
  const normalizedOutput = normalize(outputText || '');
  const looksRuntimeish =
    normalizedOutput.length > 0 &&
    PROTECTED_ASSISTANT_RUNTIME_LEAK_RE.test(normalizedOutput);

  if (
    (liveLookupPrompt &&
      (options.forceLiveLookupFallback || normalizedOutput.length > 0)) ||
    looksRuntimeish
  ) {
    return buildSilentSuccessFallback('protected_assistant', messages, channel);
  }

  return null;
}
