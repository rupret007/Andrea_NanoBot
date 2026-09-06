import type { AssistantCapabilityMatch } from './assistant-capability-router.js';
import type {
  AssistantCapabilityContext,
  AssistantCapabilityInput,
  AssistantCapabilityResult,
} from './assistant-capabilities.js';
import { mentionsCompleteCommunicationForget } from './communication-forget.js';

export function hasCompleteCommunicationForgetInput(
  input: Pick<AssistantCapabilityInput, 'rawText' | 'text' | 'canonicalText'>,
): boolean {
  return [input.rawText, input.text, input.canonicalText].some(
    (text) =>
      typeof text === 'string' && mentionsCompleteCommunicationForget(text),
  );
}

export function shouldRetireCommunicationForgetContext(params: {
  input: Pick<AssistantCapabilityInput, 'rawText' | 'text' | 'canonicalText'>;
  handled: boolean;
  capabilityId?: string;
}): boolean {
  return (
    params.handled &&
    params.capabilityId === 'communication.manage_tracking' &&
    hasCompleteCommunicationForgetInput(params.input)
  );
}

/** Only these local, typed tracking records opt into exact status presentation. */
export function resolveCommunicationTrackingPresentation(
  result: Pick<
    AssistantCapabilityResult,
    | 'handled'
    | 'capabilityId'
    | 'replyText'
    | 'conversationSeed'
    | 'communicationTrackingPresentation'
  >,
):
  | {
      kind: 'review' | 'forget_status';
      text: string;
      replyKind: 'progress';
      preserveStructuredText: true;
    }
  | undefined {
  const marker = result.communicationTrackingPresentation;
  if (
    !result.handled ||
    !marker?.text ||
    marker.text !== result.replyText ||
    marker.text.trim() !== marker.text
  )
    return undefined;
  const isForgetStatus =
    marker.kind === 'forget_status' &&
    result.capabilityId === 'communication.manage_tracking';
  const isBoundReview =
    marker.kind === 'review' &&
    (result.capabilityId === 'communication.understand_message' ||
      result.capabilityId === 'communication.open_loops') &&
    Boolean(
      result.conversationSeed?.subjectData?.communicationForgetReviewJson,
    );
  return isForgetStatus || isBoundReview
    ? { ...marker, replyKind: 'progress', preserveStructuredText: true }
    : undefined;
}

export function isExactConfirmedCommunicationTrackingPresentation(params: {
  authorizationAllowed: boolean;
  requestedText: string;
  deliveredText: string;
  deliveryOutcome: 'confirmed' | 'partial' | 'unknown' | 'rejected';
}): boolean {
  return (
    params.authorizationAllowed &&
    params.deliveryOutcome === 'confirmed' &&
    params.requestedText.length > 0 &&
    params.deliveredText === params.requestedText
  );
}

export function buildAssistantCapabilityExecutionInput(params: {
  lastContent: string;
  rawLastContent?: string;
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
    ![
      'communication.summarize_thread',
      'communication.review_recent_texts',
      'communication.open_loops',
    ].includes(params.capabilityMatch.capabilityId) || hasExplicitThreadTarget;

  return {
    rawText: params.rawLastContent ?? params.lastContent,
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
