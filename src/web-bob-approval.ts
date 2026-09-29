import type { MessageActionRecord } from './types.js';

/** Host-only capability. Serialized input and a caller-selected chat ID cannot
 * satisfy this boundary. Only the authenticated bridge mints it after its
 * durable, recipient/body/session-bound challenge has been consumed. */
export interface WebBobDispatchApproval {
  readonly surface: 'web-bob';
}

const approvals = new WeakMap<
  WebBobDispatchApproval,
  {
    actionId: string;
    target: string;
    body: string;
    chat: string;
    until: number;
  }
>();

export function mintWebBobDispatchApproval(
  action: MessageActionRecord,
  now = Date.now(),
): WebBobDispatchApproval {
  if (!action.presentationChatJid?.startsWith('webbob:')) {
    throw new Error('Web Bob approval requires its own presentation surface.');
  }
  const approval = Object.freeze({ surface: 'web-bob' as const });
  approvals.set(approval, {
    actionId: action.messageActionId,
    target: action.targetConversationJson,
    body: action.draftText,
    chat: action.presentationChatJid,
    until: now + 30_000,
  });
  return approval;
}

export function isWebBobDispatchApproval(
  approval: WebBobDispatchApproval | undefined,
  action: MessageActionRecord,
  chat: string,
): boolean {
  const bound = approval && approvals.get(approval);
  return Boolean(
    bound &&
    Date.now() < bound.until &&
    bound.actionId === action.messageActionId &&
    bound.target === action.targetConversationJson &&
    bound.body === action.draftText &&
    bound.chat === action.presentationChatJid &&
    bound.chat === chat &&
    action.targetChannel === 'bluebubbles',
  );
}
