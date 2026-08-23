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

const NEVER_AUTHORIZE_SEND_SURFACE_NAMES = new Set([
  'qa',
  'karen',
  'andrea qa',
  'qa bot',
  'karen bot',
]);

export function normalizeOwnerReviewSurfaceName(
  name: string | null | undefined,
): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * QA and Karen are operator canary / non-owner surfaces. A yes, send it, or
 * accidental isMain registration there must never authorize a contact send.
 * Bob's registered Telegram front-door stays the yes-fence.
 */
export function isNeverAuthorizeSendSurface(
  group: RegisteredGroup | null | undefined,
): boolean {
  if (!group) return false;
  const labels = [group.name, group.folder].map(
    normalizeOwnerReviewSurfaceName,
  );
  return labels.some((label) => {
    if (!label) return false;
    if (NEVER_AUTHORIZE_SEND_SURFACE_NAMES.has(label)) return true;
    return label
      .split(' ')
      .some((token) => token === 'qa' || token === 'karen');
  });
}

/**
 * Protected owner judgments may originate only from Andrea's registered main
 * Telegram chat or the explicitly configured BlueBubbles self-thread. Group
 * membership by itself and BlueBubbles' deterministic fallback aliases do not
 * grant owner-review authority. QA/Karen canaries stay fail-closed even if
 * they are marked isMain by mistake.
 */
export function isTrustedOwnerReviewSurface(
  input: TrustedOwnerReviewSurfaceInput,
): boolean {
  if (!input.group || !input.chatJid) return false;
  if (isNeverAuthorizeSendSurface(input.group)) return false;
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
