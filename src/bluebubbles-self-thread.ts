import { readEnvFile } from './env.js';

const SELF_THREAD_ENV_KEYS = [
  'BLUEBUBBLES_CANONICAL_SELF_THREAD_JID',
  'BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS',
];

// NANPA reserves +1 202-555-0100 through -0199 for fictional use, and
// example.com is reserved. These are non-personal unconfigured placeholders.
const UNCONFIGURED_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID =
  'bb:iMessage;-;+12025550101';

const UNCONFIGURED_BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS = [
  UNCONFIGURED_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  'bb:iMessage;-;owner@example.com',
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
  env = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE === '1'
    ? {}
    : readEnvFile(SELF_THREAD_ENV_KEYS),
): BlueBubblesSelfThreadConfig {
  const configuredCanonical = normalizeBlueBubblesSelfThreadJid(
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID ||
      env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  );
  const canonical =
    configuredCanonical || UNCONFIGURED_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID;
  const configuredAliases = splitAliasList(
    process.env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS ||
      env.BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS,
  );
  const aliases = new Set<string>([
    canonical,
    ...(configuredAliases.length > 0
      ? configuredAliases
      : configuredCanonical
        ? []
        : UNCONFIGURED_BLUEBUBBLES_SELF_THREAD_ALIAS_JIDS),
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

/**
 * Owner-review authority requires an explicitly configured self-thread. The
 * reserved fallback aliases are useful deterministic fixtures, but they must
 * never become a production trust grant merely because an inbound JID happens
 * to equal one of them.
 */
export function isConfiguredBlueBubblesSelfThreadAliasJid(
  chatJid: string | null | undefined,
  env = process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE === '1'
    ? {}
    : readEnvFile(SELF_THREAD_ENV_KEYS),
): boolean {
  const configuredCanonical = normalizeBlueBubblesSelfThreadJid(
    process.env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID ||
      env.BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  );
  const normalized = normalizeBlueBubblesSelfThreadJid(chatJid);
  if (
    !configuredCanonical ||
    configuredCanonical ===
      UNCONFIGURED_BLUEBUBBLES_CANONICAL_SELF_THREAD_JID ||
    !normalized
  ) {
    return false;
  }
  return resolveBlueBubblesSelfThreadConfig(env).aliasJids.includes(normalized);
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
