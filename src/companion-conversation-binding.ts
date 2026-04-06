import type { RegisteredGroup } from './types.js';

export interface BlueBubblesConversationBindingConfig {
  enabled: boolean;
  allowedChatGuid?: string | null;
  groupFolder?: string | null;
}

export interface CompanionConversationBinding {
  chatJid: string;
  group: RegisteredGroup;
  synthetic: boolean;
  channel: 'telegram' | 'bluebubbles';
}

export interface CompanionConversationBindingOptions {
  bluebubbles?: BlueBubblesConversationBindingConfig;
}

export function buildBlueBubblesChatJid(
  chatGuid: string | null | undefined,
): string | null {
  const normalized = chatGuid?.trim();
  if (!normalized) return null;
  return `bb:${normalized}`;
}

export function resolveCompanionConversationBinding(
  chatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
  options: CompanionConversationBindingOptions = {},
): CompanionConversationBinding | undefined {
  const direct = registeredGroups[chatJid];
  if (direct) {
    return {
      chatJid,
      group: direct,
      synthetic: false,
      channel: chatJid.startsWith('bb:') ? 'bluebubbles' : 'telegram',
    };
  }

  const bluebubbles = options.bluebubbles;
  const linkedChatJid =
    bluebubbles?.enabled === true
      ? buildBlueBubblesChatJid(bluebubbles.allowedChatGuid)
      : null;
  const groupFolder = bluebubbles?.groupFolder?.trim() || 'main';
  if (!linkedChatJid || chatJid !== linkedChatJid) {
    return undefined;
  }

  const sharedGroup = Object.values(registeredGroups).find(
    (group) => group.folder === groupFolder,
  );
  if (!sharedGroup) {
    return undefined;
  }

  return {
    chatJid,
    synthetic: true,
    channel: 'bluebubbles',
    group: {
      ...sharedGroup,
      name: `BlueBubbles (${sharedGroup.name})`,
      requiresTrigger: false,
      isMain: false,
    },
  };
}

export function listCompanionConversationChatJids(
  registeredGroups: Record<string, RegisteredGroup>,
  options: CompanionConversationBindingOptions = {},
): string[] {
  const jids = new Set(Object.keys(registeredGroups));
  const bluebubbles = options.bluebubbles;
  if (bluebubbles?.enabled === true) {
    const linkedChatJid = buildBlueBubblesChatJid(bluebubbles.allowedChatGuid);
    const groupFolder = bluebubbles.groupFolder?.trim() || 'main';
    if (
      linkedChatJid &&
      Object.values(registeredGroups).some((group) => group.folder === groupFolder)
    ) {
      jids.add(linkedChatJid);
    }
  }
  return [...jids];
}
