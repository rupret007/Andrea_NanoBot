import { classifyAssistantRequest } from './assistant-routing.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import type { AlexaConversationState } from './alexa-conversation.js';
import type { NewMessage } from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

type AlexaDialogueRoute =
  | 'assistant_bridge'
  | 'shared_capability'
  | 'blocked'
  | 'clarify';

export interface AlexaDialoguePlan {
  normalizedText: string;
  route: AlexaDialogueRoute;
  capabilityId?: import('./assistant-capabilities.js').AssistantCapabilityId;
  capabilityText?: string;
  blockedSpeech?: string;
  clarificationSpeech?: string;
}

function buildSyntheticMessage(content: string): NewMessage {
  return {
    id: 'alexa-dialogue-plan',
    chat_jid: 'alexa:planning',
    sender: 'Alexa User',
    sender_name: 'Alexa User',
    content,
    timestamp: new Date(0).toISOString(),
  };
}

function isWeakReference(normalized: string): boolean {
  return /^(that|this|it|there|what about it|what about that|why)\b/.test(
    normalized,
  );
}

function buildClarificationSpeech(
  state: AlexaConversationState | undefined,
): string {
  const personName = state?.subjectData.personName?.trim();
  if (personName) {
    return `I am not totally sure what you mean yet. Is that still about ${personName}, or something else?`;
  }
  if (state?.subjectKind === 'household') {
    return 'I am not totally sure which part you mean yet. Is that about home stuff, or what to remember tonight?';
  }
  return "Give me one quick anchor first. Ask what you're forgetting, what's still open with Candace, or what to remember tonight.";
}

function buildBlockedRouteSpeech(normalized: string): string {
  if (/\b(cursor|runtime|job|agent|repo|repository|code|branch|commit)\b/i.test(normalized)) {
    return 'I can help here with planning, reminders, messages, and home stuff. For code or system controls, Telegram is the better place.';
  }
  return 'I can help here with planning, reminders, messages, and household follow-through. For bigger system controls, Telegram is the better place.';
}

export function planAlexaDialogueTurn(
  text: string,
  state?: AlexaConversationState,
): AlexaDialoguePlan {
  const normalizedText = normalizeVoicePrompt(text).trim();
  if (!normalizedText) {
    return {
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
    };
  }

  if (isWeakReference(normalizedText.toLowerCase()) && !state) {
    return {
      normalizedText,
      route: 'clarify',
      clarificationSpeech: buildClarificationSpeech(state),
    };
  }

  const capabilityMatch = matchAssistantCapabilityRequest(normalizedText);
  if (capabilityMatch) {
    return {
      normalizedText,
      route: 'shared_capability',
      capabilityId: capabilityMatch.capabilityId,
      capabilityText: capabilityMatch.canonicalText || normalizedText,
    };
  }

  const policy = classifyAssistantRequest([buildSyntheticMessage(normalizedText)]);
  if (
    policy.route === 'control_plane' ||
    policy.route === 'code_plane' ||
    policy.route === 'advanced_helper'
  ) {
    return {
      normalizedText,
      route: 'blocked',
      blockedSpeech: buildBlockedRouteSpeech(normalizedText),
    };
  }

  return {
    normalizedText,
    route: 'assistant_bridge',
  };
}
