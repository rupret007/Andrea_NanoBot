import type { AssistantCapabilityMatch } from './assistant-capability-router.js';
import type {
  AssistantCapabilityContext,
  AssistantCapabilityInput,
} from './assistant-capabilities.js';

export function buildAssistantCapabilityExecutionInput(params: {
  lastContent: string;
  capabilityMatch: Pick<
    AssistantCapabilityMatch,
    'capabilityId' | 'canonicalText' | 'arguments'
  >;
  priorSubjectData?: AssistantCapabilityContext['priorSubjectData'];
}): AssistantCapabilityInput {
  const args = params.capabilityMatch.arguments;
  const hasExplicitThreadTarget = Boolean(
    args?.targetChatName ||
    args?.targetChatJid ||
    args?.threadTitle ||
    args?.personName,
  );
  const allowPriorThreadTarget =
    params.capabilityMatch.capabilityId !== 'communication.summarize_thread' ||
    hasExplicitThreadTarget;

  return {
    text: params.lastContent,
    canonicalText: params.capabilityMatch.canonicalText,
    personName:
      args?.personName ||
      (allowPriorThreadTarget ? params.priorSubjectData?.personName : null) ||
      undefined,
    targetChatName: args?.targetChatName || null,
    targetChatJid: args?.targetChatJid || null,
    threadTitle:
      args?.threadTitle ||
      (allowPriorThreadTarget ? params.priorSubjectData?.threadTitle : null) ||
      null,
    timeWindowKind: args?.timeWindowKind || null,
    timeWindowValue: args?.timeWindowValue || null,
    savedMaterialOnly: args?.savedMaterialOnly || null,
    replyStyle: args?.replyStyle || null,
  };
}
