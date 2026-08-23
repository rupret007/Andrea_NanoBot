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
  /** Optional stored chat title when the registered group name is not enough. */
  readonly chatTitle?: string | null;
  /** Optional inbound sender display name. Never used to grant authority. */
  readonly senderName?: string | null;
  /** Extra labels such as stored contact names. Fail-closed only. */
  readonly surfaceLabels?: readonly (string | null | undefined)[];
}

export interface NeverAuthorizeSendSurfaceExtras {
  readonly chatJid?: string | null;
  readonly chatTitle?: string | null;
  readonly senderName?: string | null;
  readonly surfaceLabels?: readonly (string | null | undefined)[];
}

const NEVER_AUTHORIZE_SEND_SURFACE_NAMES = new Set([
  'qa',
  'karen',
  'andrea qa',
  'qa bot',
  'karen bot',
]);

const NEVER_AUTHORIZE_SEND_SURFACE_TOKENS = new Set(['qa', 'karen']);

export function normalizeOwnerReviewSurfaceName(
  name: string | null | undefined,
): string {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function tokenizeOwnerReviewSurfaceLabel(
  value: string | null | undefined,
): string[] {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isNeverAuthorizeSendSurfaceLabel(
  value: string | null | undefined,
): boolean {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  const normalized = normalizeOwnerReviewSurfaceName(raw);
  if (NEVER_AUTHORIZE_SEND_SURFACE_NAMES.has(normalized)) return true;
  return tokenizeOwnerReviewSurfaceLabel(raw).some((token) =>
    NEVER_AUTHORIZE_SEND_SURFACE_TOKENS.has(token),
  );
}

/**
 * Telegram JIDs may carry canary names (`tg:qa`). BlueBubbles JIDs often
 * embed owner emails or phone handles, so those addresses are never parsed
 * as canary labels.
 */
export function neverAuthorizeChatJidLabel(
  chatJid: string | null | undefined,
): string | null {
  const raw = (chatJid ?? '').trim();
  if (!raw) return null;
  return raw.startsWith('tg:') ? raw : null;
}

/**
 * QA and Karen are operator canary / non-owner surfaces. A yes, send it, or
 * accidental isMain registration there must never authorize a contact send.
 * Chat JIDs and stored titles are part of the same fail-closed set so a
 * `tg:qa` / `tg:karen` thread cannot borrow Bob's main-group registration.
 * Bob's registered Telegram front-door stays the yes-fence.
 */
export function isNeverAuthorizeSendSurface(
  group: RegisteredGroup | null | undefined,
  extras?: NeverAuthorizeSendSurfaceExtras,
): boolean {
  const labels = [
    group?.name,
    group?.folder,
    neverAuthorizeChatJidLabel(extras?.chatJid),
    extras?.chatTitle,
    extras?.senderName,
    ...(extras?.surfaceLabels ?? []),
  ];
  return labels.some((label) => isNeverAuthorizeSendSurfaceLabel(label));
}

/**
 * Protected owner judgments may originate only from Andrea's registered main
 * Telegram chat or the explicitly configured BlueBubbles self-thread. Group
 * membership by itself and BlueBubbles' deterministic fallback aliases do not
 * grant owner-review authority. QA/Karen canaries stay fail-closed even if
 * they are marked isMain by mistake or reuse a main-looking group record.
 */
export function isTrustedOwnerReviewSurface(
  input: TrustedOwnerReviewSurfaceInput,
): boolean {
  if (!input.group || !input.chatJid) return false;
  if (
    isNeverAuthorizeSendSurface(input.group, {
      chatJid: input.chatJid,
      chatTitle: input.chatTitle,
      senderName: input.senderName,
      surfaceLabels: input.surfaceLabels,
    })
  ) {
    return false;
  }
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
