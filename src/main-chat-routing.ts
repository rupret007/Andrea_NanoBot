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

  if (sessionState === 'inactive') {
    return { kind: 'process_fresh_turn_now' };
  }

  if (messages.length === 1 && localQuickReply) {
    return {
      kind: 'reply_locally',
      replyText: localQuickReply,
    };
  }

  if (sessionState === 'idle_assistant') {
    return { kind: 'process_fresh_turn_now' };
  }

  return { kind: 'queue_fresh_turn_after_work' };
}
