import {
  isRecentTextReviewSeedWithinRetentionWindow,
  parseRecentTextReviewSeedJson,
} from './recent-text-review.js';
import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import type { RegisteredGroup } from './types.js';

export const SHARED_ASSISTANT_CONTEXT_TTL_MS = 10 * 60 * 1000;

export interface SharedAssistantOwnerContextScope {
  groupFolder: string;
  storageKeySuffix: string;
  surface: 'telegram' | 'bluebubbles';
}

export function resolveSharedAssistantOwnerContextScope(input: {
  chatJid: string;
  registeredGroups: Record<string, RegisteredGroup>;
  blueBubblesEnabled?: boolean;
  blueBubblesGroupFolder?: string | null;
}): SharedAssistantOwnerContextScope | null {
  const registered = input.registeredGroups[input.chatJid];
  if (input.chatJid.startsWith('tg:')) {
    // Telegram group/supergroup ids are negative. A legacy or imported
    // `isMain` row must not turn a multi-user chat into an owner-private
    // continuation surface.
    if (
      input.chatJid.startsWith('tg:-') ||
      !registered?.isMain ||
      !registered.folder
    ) {
      return null;
    }
    return {
      groupFolder: registered.folder,
      storageKeySuffix: `owner_group:${encodeURIComponent(registered.folder)}`,
      surface: 'telegram',
    };
  }

  if (
    input.blueBubblesEnabled !== true ||
    !isConfiguredBlueBubblesSelfThreadAliasJid(input.chatJid)
  ) {
    return null;
  }
  const groupFolder = input.blueBubblesGroupFolder?.trim() || 'main';
  const hasMatchingTelegramOwner = Object.entries(input.registeredGroups).some(
    ([chatJid, group]) =>
      chatJid.startsWith('tg:') &&
      !chatJid.startsWith('tg:-') &&
      group.isMain === true &&
      group.folder === groupFolder,
  );
  if (!hasMatchingTelegramOwner) return null;
  return {
    groupFolder,
    storageKeySuffix: `owner_group:${encodeURIComponent(groupFolder)}`,
    surface: 'bluebubbles',
  };
}

export function shouldRetainSharedAssistantCapabilitySeed(input: {
  createdAt?: unknown;
  recentTextReviewJson?: unknown;
  now?: Date;
}): boolean {
  const createdAtMs =
    typeof input.createdAt === 'string' ? Date.parse(input.createdAt) : NaN;
  const now = input.now || new Date();
  const nowMs = now.getTime();
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(nowMs) ||
    createdAtMs > nowMs
  ) {
    return false;
  }

  if (
    input.recentTextReviewJson !== undefined &&
    input.recentTextReviewJson !== null
  ) {
    if (typeof input.recentTextReviewJson !== 'string') return false;
    if (
      isRecentTextReviewSeedWithinRetentionWindow({
        seedJson: input.recentTextReviewJson,
        now,
      })
    ) {
      return true;
    }
    const seed = parseRecentTextReviewSeedJson(input.recentTextReviewJson);
    if (!seed?.reviewedAt || seed.items.length === 0) return false;
    const reviewedAtMs = Date.parse(seed.reviewedAt);
    if (!Number.isFinite(reviewedAtMs) || reviewedAtMs > nowMs) return false;
    const isLegacySeedWithoutFreshnessProof = seed.items.every(
      (item) => item.freshnessSnapshot == null,
    );
    return (
      isLegacySeedWithoutFreshnessProof &&
      createdAtMs + SHARED_ASSISTANT_CONTEXT_TTL_MS >= nowMs &&
      reviewedAtMs + SHARED_ASSISTANT_CONTEXT_TTL_MS >= nowMs
    );
  }

  return createdAtMs + SHARED_ASSISTANT_CONTEXT_TTL_MS >= nowMs;
}
