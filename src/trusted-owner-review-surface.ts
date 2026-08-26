import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  getChatName,
  getRegisteredMainChat,
  isDatabaseInitialized,
} from './db.js';
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
 * Telegram JIDs may carry canary names (`tg:qa`). Production Telegram chats
 * use numeric IDs, so stored titles are consulted separately. BlueBubbles
 * JIDs often embed owner emails or phone handles, so those addresses are
 * never parsed as canary labels.
 */
export function neverAuthorizeChatJidLabel(
  chatJid: string | null | undefined,
): string | null {
  const raw = (chatJid ?? '').trim();
  if (!raw) return null;
  return raw.startsWith('tg:') ? raw : null;
}

/**
 * Production Telegram chats use long numeric IDs. Short or named JIDs such
 * as `tg:main` / `tg:100` are unit-test fixtures and must not become a
 * production trust grant. Empty, sentinel, or control-character JIDs are
 * never a front-door.
 */
const PRODUCTION_TELEGRAM_NUMERIC_JID = /^tg:\d{6,}$/;
const TEST_TELEGRAM_CALLER_JID = /^tg:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TEST_BLUEBUBBLES_CALLER_JID = /^bb:[a-z0-9][a-z0-9._-]{0,127}$/i;
const TELEGRAM_SENTINEL_CALLER_BODY = /^(undefined|null|nan)$/i;

function isTelegramSentinelCallerJid(chatJid: string): boolean {
  return TELEGRAM_SENTINEL_CALLER_BODY.test(chatJid.slice('tg:'.length));
}

function isCanonicalTelegramCallerJid(chatJid: string): boolean {
  return (
    chatJid.startsWith('tg:') &&
    chatJid !== 'tg:' &&
    !chatJid.startsWith('tg:-') &&
    TEST_TELEGRAM_CALLER_JID.test(chatJid) &&
    !isTelegramSentinelCallerJid(chatJid)
  );
}

function isHermeticTestSendFenceBoundary(): boolean {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.ANDREA_TEST_DISABLE_OWNER_ENV_FILE === '1'
  );
}

/**
 * Bob's registered Telegram front-door JID, when one is recorded. Missing
 * database or a non-Telegram main registration never invents a front-door
 * and therefore never grants authority. Empty, sentinel, or control-character
 * JIDs also never become a front-door.
 */
export function resolveRegisteredTelegramFrontDoorJid(): string | null {
  if (!isDatabaseInitialized()) return null;
  const jid = (getRegisteredMainChat()?.jid ?? '').trim();
  if (!isCanonicalTelegramCallerJid(jid)) return null;
  return jid;
}

export function isRegisteredTelegramFrontDoorJid(
  chatJid: string | null | undefined,
): boolean {
  const frontDoorJid = resolveRegisteredTelegramFrontDoorJid();
  const normalized = (chatJid ?? '').trim();
  return Boolean(frontDoorJid && normalized && frontDoorJid === normalized);
}

/**
 * Telegram send-auth allow-list. A recorded front-door JID is required in
 * production. When none is recorded, production-shaped numeric JIDs cannot
 * borrow isMain, and empty, sentinel, control-character, or named/short
 * fixture JIDs authorize only inside the hermetic test boundary.
 */
export function isAuthorizedTelegramSendCallerJid(
  chatJid: string | null | undefined,
): boolean {
  const normalized = (chatJid ?? '').trim();
  if (!isCanonicalTelegramCallerJid(normalized)) return false;
  const frontDoorJid = resolveRegisteredTelegramFrontDoorJid();
  if (frontDoorJid) return normalized === frontDoorJid;
  return (
    isHermeticTestSendFenceBoundary() &&
    !PRODUCTION_TELEGRAM_NUMERIC_JID.test(normalized)
  );
}

function resolveStoredNeverAuthorizeChatTitle(
  extras?: NeverAuthorizeSendSurfaceExtras,
): string | null {
  // Canary names live in the stored title, not in provider addresses.
  // Telegram JIDs are numeric (`tg:847392018`). BlueBubbles JIDs embed
  // emails or phone handles and must never be parsed as labels. A provided
  // chatTitle is checked separately and must never hide a stored QA/Karen
  // title on Telegram or BlueBubbles.
  const chatJid = (extras?.chatJid ?? '').trim();
  if (!chatJid) return null;
  return getChatName(chatJid);
}

/**
 * BlueBubbles send-auth allow-list. The configured Messages self-thread is
 * the only production yes-fence. Provider-shaped GUIDs (`bb:iMessage;-;…`)
 * cannot authorize when that self-thread is missing or when they are an
 * ordinary contact/group thread. Short fixtures such as `bb:chat-1` are
 * accepted only while the explicit hermetic-test switch is enabled.
 */
export function isAuthorizedBlueBubblesSendCallerJid(
  chatJid: string | null | undefined,
): boolean {
  const normalized = (chatJid ?? '').trim();
  if (!normalized.startsWith('bb:') || normalized === 'bb:') return false;
  if (isConfiguredBlueBubblesSelfThreadAliasJid(normalized)) return true;
  return (
    isHermeticTestSendFenceBoundary() &&
    TEST_BLUEBUBBLES_CALLER_JID.test(normalized)
  );
}

/**
 * QA and Karen are operator canary / non-owner surfaces. A yes, send it, or
 * accidental isMain registration there must never authorize a contact send.
 * Chat JIDs and stored titles are part of the same fail-closed set so a
 * `tg:qa` / `tg:karen` thread cannot borrow Bob's main-group registration,
 * including a numeric Telegram JID whose stored title is QA or Karen.
 * A provided title cannot hide that stored canary. A numeric JID cannot
 * borrow isMain when no front-door is recorded. Empty `tg:`, sentinel
 * (`tg:undefined` / `tg:null` / `tg:NaN`), and control-character Telegram
 * JIDs cannot authorize, including when stored as the main chat. Named or
 * short Telegram fixtures authorize only inside the hermetic test boundary.
 * A BlueBubbles contact or group GUID cannot authorize when it is not the
 * configured self-thread, including when no self-thread is recorded yet.
 * Stored QA/Karen titles on BlueBubbles chats fail closed without parsing
 * the JID. Bob's registered Telegram front-door stays the yes-fence.
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
    resolveStoredNeverAuthorizeChatTitle(extras),
    ...(extras?.surfaceLabels ?? []),
  ];
  return labels.some((label) => isNeverAuthorizeSendSurfaceLabel(label));
}

/**
 * Execution-time alias so send dispatch can refuse a caller without granting
 * authority from a missing group record. Group-only checks stay available
 * through {@link isNeverAuthorizeSendSurface}.
 */
export function isNeverAuthorizeSendCaller(
  extras: NeverAuthorizeSendSurfaceExtras & {
    readonly group?: RegisteredGroup | null;
  },
): boolean {
  if (isNeverAuthorizeSendSurface(extras.group, extras)) return true;
  const chatJid = (extras.chatJid ?? '').trim();
  // Missing caller identity cannot authorize a send.
  if (!chatJid) return true;
  // A Telegram JID that is not Bob's registered front-door cannot borrow
  // isMain, including empty, sentinel, control-character, and production
  // numeric callers when no front-door is recorded yet.
  if (chatJid.startsWith('tg:')) {
    return !isAuthorizedTelegramSendCallerJid(chatJid);
  }
  // A production-shaped BlueBubbles GUID that is not the configured
  // self-thread cannot authorize a send, including when no self-thread is
  // recorded yet. Unknown channel prefixes also fail closed.
  if (chatJid.startsWith('bb:')) {
    return !isAuthorizedBlueBubblesSendCallerJid(chatJid);
  }
  return true;
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
  const chatJid = (input.chatJid ?? '').trim();
  if (!input.group || !chatJid) return false;
  if (
    isNeverAuthorizeSendSurface(input.group, {
      chatJid,
      chatTitle: input.chatTitle,
      senderName: input.senderName,
      surfaceLabels: input.surfaceLabels,
    })
  ) {
    return false;
  }
  if (input.channelName === 'telegram') {
    if (
      !chatJid.startsWith('tg:') ||
      chatJid.startsWith('tg:-') ||
      input.group.isMain !== true
    ) {
      return false;
    }
    return isAuthorizedTelegramSendCallerJid(chatJid);
  }
  return (
    input.channelName === 'bluebubbles' &&
    input.ownerAuthored === true &&
    chatJid.startsWith('bb:') &&
    isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)
  );
}
