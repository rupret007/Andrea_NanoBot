import { routeAndreaOpenAiCompanionPrompt } from './andrea-openai-runtime.js';
import { buildGracefulDegradedReply } from './conversational-core.js';
import type {
  CompanionRouteDecision,
  MessagesDirectTurnEnvelope,
} from './types.js';

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function mapCapabilityDecisionToRouteFamily(
  capabilityId: string | null | undefined,
): MessagesDirectTurnEnvelope['routeFamily'] {
  if (!capabilityId) return 'help';
  if (capabilityId === 'communication.draft_reply') {
    return 'communication_reply';
  }
  if (capabilityId === 'communication.manage_tracking') {
    return 'message_action_followup';
  }
  if (capabilityId.startsWith('communication.')) {
    return 'communication_reply';
  }
  if (capabilityId.startsWith('capture.')) {
    return 'capture';
  }
  if (capabilityId.startsWith('research.')) {
    return 'help';
  }
  return 'help';
}

export async function routeCompanionTurnWithOpenAiBackend(input: {
  channel: 'telegram' | 'bluebubbles';
  text: string;
  requestRoute: 'direct_assistant' | 'protected_assistant';
  conversationSummary?: string | null;
  replyText?: string | null;
  priorPersonName?: string | null;
  priorThreadTitle?: string | null;
  priorLastAnswerSummary?: string | null;
}): Promise<{
  decision: CompanionRouteDecision | null;
  source: 'openai_router' | 'deterministic_fallback';
  fallbackReason?: string | null;
}> {
  try {
    const decision = await routeAndreaOpenAiCompanionPrompt(input);
    return {
      decision: {
        ...decision,
        canonicalText:
          normalizeText(decision.canonicalText) || normalizeText(input.text),
      },
      source: 'openai_router',
    };
  } catch (err) {
    return {
      decision: null,
      source: 'deterministic_fallback',
      fallbackReason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function interpretBlueBubblesDirectTurnWithBackend(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  conversationSummary?: string;
  replyText?: string;
  priorPersonName?: string;
  priorThreadTitle?: string;
  priorLastAnswerSummary?: string;
}): Promise<MessagesDirectTurnEnvelope> {
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) {
    return {
      normalizedUserIntent: '',
      routeFamily: 'chat',
      assistantPrompt: '',
      confidence: 0,
      clarificationQuestion: 'What do you want me to help with here?',
      source: 'fallback',
    };
  }

  const routed = await routeCompanionTurnWithOpenAiBackend({
    channel: 'bluebubbles',
    text: normalizedText,
    requestRoute: 'direct_assistant',
    conversationSummary: input.conversationSummary || null,
    replyText: input.replyText || null,
    priorPersonName: input.priorPersonName || null,
    priorThreadTitle: input.priorThreadTitle || null,
    priorLastAnswerSummary: input.priorLastAnswerSummary || null,
  });

  if (!routed.decision) {
    return {
      normalizedUserIntent: normalizedText,
      routeFamily: 'chat',
      assistantPrompt: normalizedText,
      confidence: 0,
      fallbackText: buildGracefulDegradedReply({
        kind: 'assistant_runtime_unavailable',
        channel: 'bluebubbles',
        text: normalizedText,
      }),
      source: 'fallback',
    };
  }

  const decision = routed.decision;
  if (decision.routeKind === 'clarify') {
    return {
      normalizedUserIntent: normalizedText,
      routeFamily: 'help',
      assistantPrompt: decision.canonicalText || normalizedText,
      confidence:
        decision.confidence === 'high'
          ? 0.9
          : decision.confidence === 'medium'
            ? 0.65
            : 0.35,
      clarificationQuestion:
        normalizeText(decision.clarificationPrompt) ||
        'What do you want me to help with here?',
      source: 'openai',
    };
  }
  if (decision.routeKind === 'direct_quick_reply') {
    return {
      normalizedUserIntent: normalizedText,
      routeFamily: 'chat',
      assistantPrompt: decision.canonicalText || normalizedText,
      confidence:
        decision.confidence === 'high'
          ? 0.9
          : decision.confidence === 'medium'
            ? 0.65
            : 0.35,
      source: 'openai',
    };
  }
  if (decision.routeKind === 'assistant_capability') {
    return {
      normalizedUserIntent: normalizedText,
      routeFamily: mapCapabilityDecisionToRouteFamily(decision.capabilityId),
      assistantPrompt: decision.canonicalText || normalizedText,
      confidence:
        decision.confidence === 'high'
          ? 0.9
          : decision.confidence === 'medium'
            ? 0.65
            : 0.35,
      source: 'openai',
    };
  }

  return {
    normalizedUserIntent: normalizedText,
    routeFamily: 'help',
    assistantPrompt: decision.canonicalText || normalizedText,
    confidence:
      decision.confidence === 'high'
        ? 0.9
        : decision.confidence === 'medium'
          ? 0.65
          : 0.35,
    source: 'openai',
  };
}
