import { classifyAssistantRequest } from './assistant-routing.js';
import type { AlexaConversationState } from './alexa-conversation.js';
import type { NewMessage } from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

type AlexaDialogueRoute = 'assistant_bridge' | 'blocked' | 'clarify';

export interface AlexaDialoguePlan {
  normalizedText: string;
  route: AlexaDialogueRoute;
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
    return `I am not totally sure what you mean yet. Was that still about ${personName}, or something else?`;
  }
  if (state?.subjectKind === 'household') {
    return 'I am not totally sure which part you mean. Was that about home stuff or what to remember tonight?';
  }
  return 'I need one quick anchor first. Ask about today, Candace, or what to remember tonight.';
}

function buildBlockedRouteSpeech(normalized: string): string {
  if (/\b(cursor|runtime|job|agent|repo|repository|code|branch|commit)\b/i.test(normalized)) {
    return 'I can help with personal planning, reminders, messages, and home stuff here. For code or work-cockpit controls, use Telegram.';
  }
  return 'I can help with personal planning, reminders, messages, and household follow-through here. For heavier system controls, use Telegram.';
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

