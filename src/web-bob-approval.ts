import { createHash } from 'node:crypto';

import { secureEqual } from './secure-equal.js';
import type { MessageActionRecord } from './types.js';

/** Host-only capability. Serialized input and a caller-selected chat ID cannot
 * satisfy this boundary. The bridge mints it only after consuming an owner
 * token delivered out of band and bound to its stored draft/revision/content. */
export interface WebBobDispatchApproval {
  readonly surface: 'web-bob';
}

const APPROVAL_TTL_MS = 30_000;

const approvals = new WeakMap<
  WebBobDispatchApproval,
  {
    contentHash: string;
    until: number;
  }
>();

function hashWebBobApprovalBinding(action: MessageActionRecord): string {
  // Fixed field order binds exact action, target, body, and chat bytes.
  return createHash('sha256')
    .update(
      JSON.stringify({
        actionId: action.messageActionId,
        target: action.targetConversationJson,
        body: action.draftText,
        chat: action.presentationChatJid,
      }),
    )
    .digest('hex');
}

export function mintWebBobDispatchApproval(
  action: MessageActionRecord,
  now = Date.now(),
): WebBobDispatchApproval {
  if (!action.presentationChatJid?.startsWith('webbob:')) {
    throw new Error('Web Bob approval requires its own presentation surface.');
  }
  const approval = Object.freeze({ surface: 'web-bob' as const });
  approvals.set(approval, {
    contentHash: hashWebBobApprovalBinding(action),
    until: now + APPROVAL_TTL_MS,
  });
  return approval;
}

export function isWebBobDispatchApproval(
  approval: WebBobDispatchApproval | undefined,
  action: MessageActionRecord,
  chat: string,
  now = Date.now(),
): boolean {
  const bound = approval && approvals.get(approval);
  if (!bound) return false;
  const ok = Boolean(
    now < bound.until &&
    secureEqual(bound.contentHash, hashWebBobApprovalBinding(action)) &&
    bound.contentHash.length === 64 &&
    action.presentationChatJid === chat &&
    action.targetChannel === 'bluebubbles',
  );
  if (ok) approvals.delete(approval);
  return ok;
}
