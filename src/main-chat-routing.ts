import type { NewMessage } from './types.js';

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
