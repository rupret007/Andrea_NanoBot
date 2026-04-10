export const BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
  'bb:iMessage;-;+14695405551';

export const BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = [
  BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  'bb:iMessage;-;jeffstory007@gmail.com',
] as const;

const BLUEBUBBLES_SELF_THREAD_ALIAS_SET = new Set<string>(
  BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS,
);

export function isBlueBubblesSelfThreadAliasJid(
  chatJid: string | null | undefined,
): boolean {
  return Boolean(chatJid && BLUEBUBBLES_SELF_THREAD_ALIAS_SET.has(chatJid));
}

export function canonicalizeBlueBubblesSelfThreadJid(
  chatJid: string | null | undefined,
): string | null {
  if (!chatJid) return null;
  return isBlueBubblesSelfThreadAliasJid(chatJid)
    ? BLUEBUBBLES_CANONICAL_SELF_THREAD_JID
    : chatJid;
}

export function expandBlueBubblesLogicalSelfThreadJids(
  chatJid: string | null | undefined,
): string[] {
  if (!chatJid) return [];
  if (!isBlueBubblesSelfThreadAliasJid(chatJid)) {
    return [chatJid];
  }
  return [...BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS];
}
