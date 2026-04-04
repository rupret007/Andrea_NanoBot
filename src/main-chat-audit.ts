import type { ChatInfo } from './db.js';
import type { RegisteredGroup } from './types.js';

export interface RegisteredMainChatRecord extends RegisteredGroup {
  jid: string;
}

export interface MainChatAuditResult {
  registeredMainChat: RegisteredMainChatRecord | null;
  registeredMainChatPresentInChats: boolean;
  latestTelegramChat: ChatInfo | null;
  warning: string | null;
  repairTargetChat: ChatInfo | null;
}

function parseIsoTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isNumericTelegramChatJid(jid: string): boolean {
  return /^tg:-?\d+$/.test(jid);
}

export function isRealTelegramDirectMessage(chat: ChatInfo): boolean {
  return (
    chat.channel === 'telegram' &&
    chat.is_group === 0 &&
    isNumericTelegramChatJid(chat.jid)
  );
}

export function isSyntheticTelegramChatJid(jid: string): boolean {
  return jid.startsWith('tg:') && !isNumericTelegramChatJid(jid);
}

function sortChatsByLastMessageDesc(chats: ChatInfo[]): ChatInfo[] {
  return [...chats].sort(
    (left, right) =>
      parseIsoTime(right.last_message_time) - parseIsoTime(left.last_message_time),
  );
}

export function auditRegisteredMainChat(params: {
  registeredMainChat: RegisteredMainChatRecord | null;
  chats: ChatInfo[];
}): MainChatAuditResult {
  const { registeredMainChat } = params;
  const chats = sortChatsByLastMessageDesc(params.chats);
  const realTelegramDirectMessages = chats.filter(isRealTelegramDirectMessage);
  const latestTelegramChat = realTelegramDirectMessages[0] || null;
  const registeredMainChatPresentInChats = registeredMainChat
    ? chats.some((chat) => chat.jid === registeredMainChat.jid)
    : false;

  if (!registeredMainChat) {
    return {
      registeredMainChat: null,
      registeredMainChatPresentInChats: false,
      latestTelegramChat,
      warning: latestTelegramChat
        ? 'No registered main chat was found.'
        : null,
      repairTargetChat: null,
    };
  }

  const registeredMainLooksStale =
    isSyntheticTelegramChatJid(registeredMainChat.jid) ||
    !registeredMainChatPresentInChats;

  if (registeredMainLooksStale) {
    if (realTelegramDirectMessages.length === 1) {
      return {
        registeredMainChat,
        registeredMainChatPresentInChats,
        latestTelegramChat,
        warning: `Registered main chat ${registeredMainChat.jid} looks stale; a single live Telegram DM candidate exists.`,
        repairTargetChat: latestTelegramChat,
      };
    }

    return {
      registeredMainChat,
      registeredMainChatPresentInChats,
      latestTelegramChat,
      warning:
        realTelegramDirectMessages.length === 0
          ? `Registered main chat ${registeredMainChat.jid} looks stale, but no live Telegram DM candidate was found.`
          : `Registered main chat ${registeredMainChat.jid} looks stale, but multiple Telegram DM candidates exist.`,
      repairTargetChat: null,
    };
  }

  if (latestTelegramChat && latestTelegramChat.jid !== registeredMainChat.jid) {
    return {
      registeredMainChat,
      registeredMainChatPresentInChats,
      latestTelegramChat,
      warning: `Latest Telegram DM ${latestTelegramChat.jid} is newer than the registered main chat ${registeredMainChat.jid}.`,
      repairTargetChat: null,
    };
  }

  return {
    registeredMainChat,
    registeredMainChatPresentInChats,
    latestTelegramChat,
    warning: null,
    repairTargetChat: null,
  };
}
