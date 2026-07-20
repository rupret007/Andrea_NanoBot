import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import type { RegisteredGroup } from './types.js';

export interface TrustedOwnerReviewSurfaceInput {
  channelName: string | null | undefined;
  chatJid: string | null | undefined;
  group: RegisteredGroup | null | undefined;
  /**
   * Immutable fact from the current inbound platform message. BlueBubbles
   * self-thread membership identifies the conversation, not who authored the
   * current instruction, so missing provenance must never grant authority.
   */
  readonly ownerAuthored?: boolean | null;
}

/**
 * Protected owner judgments may originate only from Andrea's registered main
 * Telegram chat or the explicitly configured BlueBubbles self-thread. Group
 * membership by itself and BlueBubbles' deterministic fallback aliases do not
 * grant owner-review authority.
 */
export function isTrustedOwnerReviewSurface(
  input: TrustedOwnerReviewSurfaceInput,
): boolean {
  if (!input.group || !input.chatJid) return false;
  if (input.channelName === 'telegram') {
    return (
      input.chatJid.startsWith('tg:') &&
      !input.chatJid.startsWith('tg:-') &&
      input.group.isMain === true
    );
  }
  return (
    input.channelName === 'bluebubbles' &&
    input.ownerAuthored === true &&
    input.chatJid.startsWith('bb:') &&
    isConfiguredBlueBubblesSelfThreadAliasJid(input.chatJid)
  );
}
