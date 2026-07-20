import { hasStoredMessage, storeMessageDirect } from './db.js';
import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import type { NewMessage } from './types.js';

export type BlueBubblesIngressPolicyResult =
  | { kind: 'continue_control_routing' }
  | { kind: 'stored_contact_data_only'; stored: boolean };

export function isBlueBubblesDataOnlyContactThread(params: {
  channelName: string | null | undefined;
  chatJid: string;
}): boolean {
  return (
    params.channelName === 'bluebubbles' &&
    !isConfiguredBlueBubblesSelfThreadAliasJid(params.chatJid)
  );
}

/**
 * Apply the hard surface boundary between Andrea's owner self-thread and
 * ordinary Messages conversations. Contact-thread activity is durable data for
 * summaries and explicit owner-authorized actions, never a command or prompt.
 */
export function applyBlueBubblesIngressPolicy(params: {
  channelName: string | null | undefined;
  chatJid: string;
  message: NewMessage;
}): BlueBubblesIngressPolicyResult {
  if (!isBlueBubblesDataOnlyContactThread(params)) {
    return { kind: 'continue_control_routing' };
  }

  storeMessageDirect({
    id: params.message.id,
    chat_jid: params.message.chat_jid,
    sender: params.message.sender,
    sender_name: params.message.sender_name,
    content: params.message.content,
    timestamp: params.message.timestamp,
    is_from_me: params.message.is_from_me === true,
    is_bot_message: params.message.is_bot_message,
    thread_id: params.message.thread_id,
    reply_to_id:
      params.message.reply_to_id &&
      hasStoredMessage(params.message.chat_jid, params.message.reply_to_id)
        ? params.message.reply_to_id
        : undefined,
    provider_idempotency_key: params.message.provider_idempotency_key,
    message_ingress_origin: 'passive_contact_sync',
    attachments: params.message.attachments,
  });
  return { kind: 'stored_contact_data_only', stored: true };
}
