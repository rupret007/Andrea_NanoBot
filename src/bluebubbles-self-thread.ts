import { readEnvFile } from './env.js';

const SELF_THREAD_ENV_KEYS = [
  'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
  'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
];

const FALLBACK_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
  'bb:iMessage;-;+14695405551';

const FALLBACK_BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = [
  FALLBACK_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  'bb:iMessage;-;jeffstory007@gmail.com',
] as const;

function normalizeBlueBubblesSelfThreadJid(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('bb:') ? trimmed : `bb:${trimmed}`;
}

function splitAliasList(value: string | null | undefined): string[] {
  return (value || '')
    .split(/[,\n|]/)
    .map((item) => normalizeBlueBubblesSelfThreadJid(item))
    .filter((item): item is string => Boolean(item));
}

export interface BlueBubblesSelfThreadConfig {
  canonicalJid: string;
  aliasJids: string[];
}

export function resolveBlueBubblesSelfThreadConfig(
  env = readEnvFile(SELF_THREAD_ENV_KEYS),
): BlueBubblesSelfThreadConfig {
  const canonical =
    normalizeBlueBubblesSelfThreadJid(
      process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID ||
        env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    ) || FALLBACK_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const configuredAliases = splitAliasList(
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS ||
      env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS,
  );
  const aliases = new Set<string>([
    canonical,
    ...(configuredAliases.length > 0
      ? configuredAliases
      : FALLBACK_BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS),
  ]);
  return {
    canonicalJid: canonical,
    aliasJids: [...aliases],
  };
}

export function getBlueBubblesCanonicalSelfThreadJid(): string {
  return resolveBlueBubblesSelfThreadConfig().canonicalJid;
}

export function getBlueBubblesSelfThreadAliasJids(): string[] {
  return resolveBlueBubblesSelfThreadConfig().aliasJids;
}

export const BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
  getBlueBubblesCanonicalSelfThreadJid();

export const BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS =
  getBlueBubblesSelfThreadAliasJids();

export function isBlueBubblesSelfThreadAliasJid(
  chatJid: string | null | undefined,
): boolean {
  const normalized = normalizeBlueBubblesSelfThreadJid(chatJid);
  if (!normalized) return false;
  return getBlueBubblesSelfThreadAliasJids().includes(normalized);
}

export function canonicalizeBlueBubblesSelfThreadJid(
  chatJid: string | null | undefined,
): string | null {
  if (!chatJid) return null;
  return isBlueBubblesSelfThreadAliasJid(chatJid)
    ? getBlueBubblesCanonicalSelfThreadJid()
    : chatJid;
}

export function expandBlueBubblesLogicalSelfThreadJids(
  chatJid: string | null | undefined,
): string[] {
  if (!chatJid) return [];
  if (!isBlueBubblesSelfThreadAliasJid(chatJid)) {
    return [chatJid];
  }
  return getBlueBubblesSelfThreadAliasJids();
}
