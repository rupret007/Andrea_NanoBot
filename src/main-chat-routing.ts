import type { NewMessage } from './types.js';
import {
  assistantCapabilityKey,
  type AssistantRequestPolicy,
} from './assistant-routing.js';

export type MainChatSessionState =
  | 'inactive'
  | 'idle_assistant'
  | 'busy_assistant'
  | 'task_container';

export type MainChatRoutingDecision =
  | { kind: 'reply_locally'; replyText: string }
  | { kind: 'process_fresh_turn_now' }
  | { kind: 'queue_fresh_turn_after_work' }
  | { kind: 'pipe_active_session' };

type RoutingMessage = Pick<NewMessage, 'content' | 'reply_to_id'>;

const EXACT_CAPABILITY_CONTINUATIONS = new Set([
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'sounds good',
  'please do',
  'do it',
  'go ahead',
  'continue',
  'retry',
  'again',
  'next',
  'go on',
  'keep going',
  'carry on',
  'resume',
  'enable it',
  'disable it',
  'install it',
  'stop it',
  'pause it',
  'resume it',
  'sync it',
  'that one',
  'this one',
  'the first one',
  'the second one',
  'use that',
  'use this',
]);

function isExactCapabilityContinuation(content: string): boolean {
  const normalized = content
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, '')
    .trim();
  return EXACT_CAPABILITY_CONTINUATIONS.has(normalized);
}

export function shouldPipeToActiveAssistant(params: {
  messages: RoutingMessage[];
  incomingPolicy: AssistantRequestPolicy;
  activeCapabilityKey: string | null;
}): boolean {
  if (!params.activeCapabilityKey || params.messages.length === 0) return false;
  if (
    assistantCapabilityKey(params.incomingPolicy) === params.activeCapabilityKey
  ) {
    return true;
  }

  // Only bounded acknowledgements and direct-route reply context may finish
  // inside the already-classified active boundary. A prefix such as "okay" on
  // a new ask is not enough to inherit execution tools.
  return (
    params.incomingPolicy.route === 'direct_assistant' &&
    params.messages.every(
      (message) =>
        Boolean(message.reply_to_id) ||
        isExactCapabilityContinuation(message.content),
    )
  );
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function isLikelyFreshCompanionAsk(message: RoutingMessage): boolean {
  const trimmed = message.content.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || trimmed.startsWith('/')) return false;
  if (message.reply_to_id) return false;

  if (
    /^(continue|go on|keep going|carry on|resume|retry|again|next|wait|hold on)[!. ]*$/.test(
      lower,
    )
  ) {
    return false;
  }

  if (/[?]/.test(trimmed)) return true;
  if (countWords(trimmed) >= 5 || trimmed.length >= 32) return true;

  return /^(what|what's|whats|how|can|could|would|will|when|where|why|who|summari[sz]e|summerize|sumarize|remind|add|put|move|cancel|delete|save|show|tell|help|draft|reply|use)\b/.test(
    lower,
  );
}

export function isStandalonePlainTextMessage(message: RoutingMessage): boolean {
  const trimmed = message.content.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/') && !message.reply_to_id;
}

export function shouldAvoidCombinedContextForMainChat(
  messages: RoutingMessage[],
): boolean {
  return messages.length === 1 && isStandalonePlainTextMessage(messages[0]);
}

export function decideMainChatRouting(params: {
  isMainGroup: boolean;
  messages: RoutingMessage[];
  sessionState: MainChatSessionState;
  localQuickReply: string | null;
}): MainChatRoutingDecision {
  const { isMainGroup, messages, sessionState, localQuickReply } = params;
  if (!isMainGroup || messages.length === 0) {
    return { kind: 'pipe_active_session' };
  }

  if (!messages.every(isStandalonePlainTextMessage)) {
    return { kind: 'pipe_active_session' };
  }

  if (messages.length === 1 && localQuickReply) {
    return {
      kind: 'reply_locally',
      replyText: localQuickReply,
    };
  }

  if (sessionState === 'inactive') {
    return { kind: 'process_fresh_turn_now' };
  }

  if (sessionState === 'idle_assistant') {
    return { kind: 'process_fresh_turn_now' };
  }

  if (messages.length === 1 && isLikelyFreshCompanionAsk(messages[0])) {
    return { kind: 'process_fresh_turn_now' };
  }

  return { kind: 'queue_fresh_turn_after_work' };
}
