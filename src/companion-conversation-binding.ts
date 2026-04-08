import { getAllChats } from './db.js';
import type { BlueBubblesChatScope, RegisteredGroup } from './types.js';

export interface BlueBubblesConversationBindingConfig {
  enabled: boolean;
  chatScope?: BlueBubblesChatScope | null;
  allowedChatGuids?: string[] | null;
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

function normalizeBlueBubblesAllowedChatJids(
  config: BlueBubblesConversationBindingConfig | undefined,
): string[] {
  const configured = new Set<string>();
  for (const guid of config?.allowedChatGuids || []) {
    const jid = buildBlueBubblesChatJid(guid);
    if (jid) configured.add(jid);
  }
  const legacy = buildBlueBubblesChatJid(config?.allowedChatGuid);
  if (legacy) configured.add(legacy);
  return [...configured];
}

function resolveBlueBubblesChatScope(
  config: BlueBubblesConversationBindingConfig | undefined,
): BlueBubblesChatScope {
  return config?.chatScope || 'allowlist';
}

function isEligibleBlueBubblesChatJid(
  chatJid: string,
  config: BlueBubblesConversationBindingConfig | undefined,
): boolean {
  if (!chatJid.startsWith('bb:') || config?.enabled !== true) {
    return false;
  }

  const scope = resolveBlueBubblesChatScope(config);
  if (scope === 'all_synced') {
    return true;
  }

  if (scope === 'allowlist') {
    return normalizeBlueBubblesAllowedChatJids(config).includes(chatJid);
  }

  const chat = getAllChats().find((entry) => entry.jid === chatJid);
  return chat?.is_group === 0;
}

function listScopedBlueBubblesChatJids(
  config: BlueBubblesConversationBindingConfig | undefined,
): string[] {
  if (config?.enabled !== true) return [];

  const scope = resolveBlueBubblesChatScope(config);
  if (scope === 'allowlist') {
    return normalizeBlueBubblesAllowedChatJids(config);
  }

  return getAllChats()
    .filter((chat) => chat.jid.startsWith('bb:'))
    .filter((chat) => (scope === 'contacts_only' ? chat.is_group === 0 : true))
    .map((chat) => chat.jid);
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
  const groupFolder = bluebubbles?.groupFolder?.trim() || 'main';
  if (!isEligibleBlueBubblesChatJid(chatJid, bluebubbles)) {
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
  const groupFolder = bluebubbles?.groupFolder?.trim() || 'main';
  if (
    bluebubbles?.enabled === true &&
    Object.values(registeredGroups).some((group) => group.folder === groupFolder)
  ) {
    for (const chatJid of listScopedBlueBubblesChatJids(bluebubbles)) {
      jids.add(chatJid);
    }
  }
  return [...jids];
}
