import { randomUUID } from 'crypto';
import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';

import {
  type BlueBubblesDetectionState,
  type BlueBubblesEvidenceKind,
  readBlueBubblesMonitorState,
  type BlueBubblesMonitorState,
  writeBlueBubblesMonitorState,
} from '../bluebubbles-monitor-state.js';
import {
  getAllChats,
  getMessageMediaAttachment,
  hasStoredMessage,
  listRecentMessagesForChat,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { buildBlueBubblesChatJid } from '../companion-conversation-binding.js';
import { hasBlueBubblesAndreaMention } from '../bluebubbles-companion.js';
import {
  expandBlueBubblesLogicalSelfThreadJids,
  getBlueBubblesCanonicalSelfThreadJid,
  isBlueBubblesSelfThreadAliasJid,
} from '../bluebubbles-self-thread.js';
import {
  buildBlueBubblesIngressFingerprint,
  isBlueBubblesAndreaBotEcho,
  resolveBlueBubblesReplyGateMode,
} from '../messages-fluidity.js';
import {
  buildMediaAttachmentId,
  cacheInboundMediaBytes,
  getMediaCachePolicy,
  getUsableCachedMediaFile,
  inferMediaKindFromMime,
  MediaCacheLimitError,
  readMediaResponseBytes,
} from '../media-cache.js';
import { ChannelDeliveryUnverifiedError } from '../channel-delivery.js';
import type {
  BlueBubblesChannelControlSnapshot,
  BlueBubblesReplyGateMode,
  BlueBubblesChatScope,
  BlueBubblesChatRef,
  BlueBubblesConfig,
  BlueBubblesContactRef,
  BlueBubblesWebhookEvent,
  ChannelArtifact,
  Channel,
  ChannelHealthSnapshot,
  MessageReactionKind,
  MessageMediaAttachment,
  NewMessage,
  SendArtifactOptions,
  SendMessageOptions,
  SendMessageResult,
} from '../types.js';
import type {
  AppleMessagesProvider,
  AppleMessagesProbeResult,
  AppleMessagesReadinessResult,
} from './apple-messages-provider.js';
import { ChannelOpts, registerChannel } from './registry.js';

const DEFAULT_BLUEBUBBLES_HOST = '127.0.0.1';
const DEFAULT_BLUEBUBBLES_PORT = 4305;
const DEFAULT_BLUEBUBBLES_CHAT_SCOPE: BlueBubblesChatScope = 'allowlist';
const BLUEBUBBLES_OUTBOUND_SENDER_LABEL = 'Andrea:';
const BLUEBUBBLES_STARTUP_FETCH_TIMEOUT_MS = 5_000;
const BLUEBUBBLES_CREATE_CHAT_TIMEOUT_MS = 40_000;
const BLUEBUBBLES_SHADOW_POLL_INTERVAL_MS = 75_000;
const BLUEBUBBLES_MISSED_INBOUND_GRACE_MS = 2 * 60 * 1_000;
const BLUEBUBBLES_DIRECT_CONTEXT_WINDOW_MS =
  BLUEBUBBLES_MISSED_INBOUND_GRACE_MS * 15;
const BLUEBUBBLES_EVIDENCE_WINDOW_MS = 10 * 60 * 1_000;
const BLUEBUBBLES_FALLBACK_COOLDOWN_MS = 6 * 60 * 60 * 1_000;
const BLUEBUBBLES_FALLBACK_EVIDENCE_THRESHOLD = 2;
const BLUEBUBBLES_INGRESS_FINGERPRINT_WINDOW_MS = 2 * 60 * 1_000;
const BLUEBUBBLES_MIRRORED_MESSAGE_TIMESTAMP_TOLERANCE_MS = 2_000;

interface BlueBubblesIngressFingerprintObservation {
  observedAtMs: number;
  messageTimestampMs: number;
}

function parseBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value.trim().toLowerCase() === 'true';
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeBaseUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

function normalizeBaseUrlCandidates(
  primaryValue: string | undefined,
  candidatesValue: string | undefined,
): string[] {
  const normalized = new Set<string>();
  const push = (value: string | null): void => {
    if (value) {
      normalized.add(value);
    }
  };

  push(normalizeBaseUrl(primaryValue));
  for (const candidate of (candidatesValue || '').split(',')) {
    push(normalizeBaseUrl(candidate));
  }

  return [...normalized];
}

function getBlueBubblesBaseUrlCandidates(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'baseUrlCandidates'>,
): string[] {
  const candidates = Array.isArray(config.baseUrlCandidates)
    ? config.baseUrlCandidates
    : [];
  return candidates.length > 0
    ? candidates
    : config.baseUrl
      ? [config.baseUrl]
      : [];
}

function normalizeChatScope(value: string | undefined): BlueBubblesChatScope {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'all_synced') return 'all_synced';
  if (normalized === 'contacts_only') return 'contacts_only';
  return DEFAULT_BLUEBUBBLES_CHAT_SCOPE;
}

function normalizeAllowedChatGuids(
  value: string | undefined,
  legacyValue: string | undefined,
): string[] {
  const normalized = new Set<string>();
  for (const item of (value || '').split(',')) {
    const trimmed = item.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  const legacy = legacyValue?.trim();
  if (legacy) {
    normalized.add(legacy);
  }
  return [...normalized];
}

function normalizeText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeWebhookPath(value: string | undefined): string {
  const trimmed = value?.trim() || '/bluebubbles/webhook';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeBlueBubblesReplyId(value: string | null): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.startsWith('bb:') ? normalized : `bb:${normalized}`;
}

const BLUEBUBBLES_REACTION_BY_NUMBER: Record<number, string> = {
  2000: 'love',
  2001: 'like',
  2002: 'dislike',
  2003: 'laugh',
  2004: 'emphasize',
  2005: 'question',
  3000: '-love',
  3001: '-like',
  3002: '-dislike',
  3003: '-laugh',
  3004: '-emphasize',
  3005: '-question',
};

function normalizeBlueBubblesReactionKind(value: unknown): {
  kind: MessageReactionKind;
  removed: boolean;
} | null {
  const raw =
    typeof value === 'number'
      ? BLUEBUBBLES_REACTION_BY_NUMBER[value]
      : typeof value === 'string'
        ? BLUEBUBBLES_REACTION_BY_NUMBER[Number(value)] || value
        : '';
  const normalized = raw.trim().toLowerCase();
  const removed = normalized.startsWith('-');
  const kind = (
    removed ? normalized.slice(1) : normalized
  ) as MessageReactionKind;
  if (
    !['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'].includes(
      kind,
    )
  ) {
    return null;
  }
  return { kind, removed };
}

function normalizeBlueBubblesAssociatedMessageId(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^bp:/i, '').replace(/^p:/i, '');
  const guid = normalized.split('/').at(-1)?.trim();
  if (!guid) return undefined;
  return guid.startsWith('bb:') ? guid : `bb:${guid}`;
}

function formatBlueBubblesOutboundText(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.startsWith(BLUEBUBBLES_OUTBOUND_SENDER_LABEL)) {
    return normalized;
  }

  const newlineIndex = normalized.indexOf('\n');
  if (newlineIndex === -1) {
    return `${BLUEBUBBLES_OUTBOUND_SENDER_LABEL} ${normalized}`;
  }

  const firstLine = normalized.slice(0, newlineIndex);
  const remaining = normalized.slice(newlineIndex);
  return `${BLUEBUBBLES_OUTBOUND_SENDER_LABEL} ${firstLine}${remaining}`;
}

function formatBlueBubblesDirectContextWindow(): string {
  const minutes = Math.round(BLUEBUBBLES_DIRECT_CONTEXT_WINDOW_MS / 60_000);
  return `${minutes} minutes`;
}

export function buildBlueBubblesLinkedChatJid(
  config: Pick<BlueBubblesConfig, 'allowedChatGuid' | 'allowedChatGuids'>,
): string | null {
  return buildBlueBubblesChatJid(
    config.allowedChatGuid || config.allowedChatGuids[0] || null,
  );
}

export function resolveConfiguredBlueBubblesReplyGateMode(
  config: Pick<
    BlueBubblesConfig,
    'allowedChatGuid' | 'allowedChatGuids' | 'chatScope'
  >,
): BlueBubblesReplyGateMode {
  const linkedChatJid = buildBlueBubblesLinkedChatJid(config);
  const linkedChat = linkedChatJid
    ? getAllChats().find((chat) => chat.jid === linkedChatJid)
    : null;
  if (!linkedChatJid) {
    return config.chatScope === 'contacts_only'
      ? 'direct_1to1'
      : 'mention_required';
  }
  return resolveBlueBubblesReplyGateMode({
    chatJid: linkedChatJid,
    isGroup:
      linkedChat && typeof linkedChat.is_group === 'number'
        ? linkedChat.is_group !== 0
        : null,
  });
}

export function buildBlueBubblesListenerWebhookUrl(
  config: Pick<
    BlueBubblesConfig,
    'host' | 'port' | 'webhookPath' | 'webhookSecret'
  >,
): string {
  const url = new URL(
    `http://${config.host}:${config.port}${config.webhookPath}`,
  );
  if (config.webhookSecret) {
    url.searchParams.set('secret', config.webhookSecret);
  }
  return url.toString();
}

export function buildBlueBubblesWebhookUrl(
  config: Pick<
    BlueBubblesConfig,
    'host' | 'port' | 'webhookPath' | 'webhookSecret' | 'webhookPublicBaseUrl'
  >,
): string {
  const baseUrl =
    normalizeBaseUrl(config.webhookPublicBaseUrl || undefined) ||
    `http://${config.host}:${config.port}`;
  const url = new URL(config.webhookPath, `${baseUrl}/`);
  if (config.webhookSecret) {
    url.searchParams.set('secret', config.webhookSecret);
  }
  return url.toString();
}

export function redactBlueBubblesWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('secret')) {
      parsed.searchParams.set('secret', '***');
    }
    return parsed.toString();
  } catch {
    return url.replace(/([?&]secret=)[^&]+/i, '$1***');
  }
}

function isBlueBubblesRoutingConfigured(config: BlueBubblesConfig): boolean {
  if (!config.baseUrl || !config.password || !config.groupFolder) {
    return false;
  }
  if (config.chatScope === 'allowlist') {
    return config.allowedChatGuids.length > 0;
  }
  return true;
}

export function extractBlueBubblesChatGuid(jid: string): string | null {
  if (!jid.startsWith('bb:')) return null;
  const chatGuid = jid.slice(3).trim();
  return chatGuid || null;
}

export function isBlueBubblesChatEligible(
  config: Pick<BlueBubblesConfig, 'chatScope' | 'allowedChatGuids'>,
  chatGuid: string | null | undefined,
  isGroup?: boolean,
): boolean {
  const normalized = chatGuid?.trim();
  if (!normalized) return false;
  if (config.chatScope === 'all_synced') {
    return true;
  }
  if (config.chatScope === 'contacts_only') {
    return isGroup === false;
  }
  return config.allowedChatGuids.includes(normalized);
}

interface BlueBubblesDirectChatMetadata {
  chatJid: string;
  chatGuid: string;
  isGroup: boolean;
  chatIdentifier: string | null;
  lastAddressedHandle: string | null;
  handleAddress: string | null;
  service: string | null;
  lastObservedAt: string | null;
  lastObservedWasSelfAuthored: boolean;
}

interface BlueBubblesOutboundTargetCandidate {
  kind:
    | 'chat_guid'
    | 'last_addressed_handle'
    | 'service_specific_last_addressed_handle'
    | 'chat_identifier'
    | 'handle_address'
    | 'service_specific_direct';
  chatGuid: string;
}

type BlueBubblesSendMethod = 'private-api' | 'apple-script';

function extractBlueBubblesServiceFromChatGuid(
  chatGuid: string | null | undefined,
): string | null {
  const normalized = chatGuid?.trim();
  if (!normalized) return null;
  const [service] = normalized.split(';', 1);
  return service?.trim() || null;
}

function inferBlueBubblesGroupChat(
  chatGuid: string | null | undefined,
  explicitIsGroup?: boolean | null,
): boolean {
  const normalized = chatGuid?.trim() || '';
  const match = normalized.match(/^[^;]+;([+-]);/);
  if (explicitIsGroup === true) return true;
  if (match?.[1] === '+') return true;
  if (explicitIsGroup === false) return false;
  if (match?.[1] === '-') return false;
  return /;\+;chat/i.test(normalized);
}

function normalizeBlueBubblesDirectTargetValue(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function buildBlueBubblesDirectTargetGuid(
  service: string,
  value: string | null | undefined,
): string | null {
  const normalizedValue = normalizeBlueBubblesDirectTargetValue(value);
  if (!normalizedValue) return null;
  if (/^[^;]+;[+-];/.test(normalizedValue)) {
    return normalizedValue;
  }
  return `${service};-;${normalizedValue}`;
}

export function resolveBlueBubblesConfig(
  env = readEnvFile([
    'BLUEBUBBLES_ENABLED',
    'BLUEBUBBLES_BASE_URL',
    'BLUEBUBBLES_BASE_URL_CANDIDATES',
    'BLUEBUBBLES_PASSWORD',
    'BLUEBUBBLES_HOST',
    'BLUEBUBBLES_PORT',
    'BLUEBUBBLES_GROUP_FOLDER',
    'BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL',
    'BLUEBUBBLES_SERVER_PUBLIC_URL',
    'BLUEBUBBLES_LOCAL_PORT',
    'BLUEBUBBLES_IMESSAGE_ACCOUNT_LABEL',
    'BLUEBUBBLES_COMPUTER_ID',
    'BLUEBUBBLES_CHAT_SCOPE',
    'BLUEBUBBLES_ALLOWED_CHAT_GUIDS',
    'BLUEBUBBLES_ALLOWED_CHAT_GUID',
    'BLUEBUBBLES_WEBHOOK_PATH',
    'BLUEBUBBLES_WEBHOOK_SECRET',
    'BLUEBUBBLES_SEND_ENABLED',
  ]),
): BlueBubblesConfig {
  const enabled = parseBool(
    process.env.BLUEBUBBLES_ENABLED || env.BLUEBUBBLES_ENABLED,
    false,
  );
  const baseUrlCandidates = normalizeBaseUrlCandidates(
    process.env.BLUEBUBBLES_BASE_URL || env.BLUEBUBBLES_BASE_URL,
    process.env.BLUEBUBBLES_BASE_URL_CANDIDATES ||
      env.BLUEBUBBLES_BASE_URL_CANDIDATES,
  );
  return {
    enabled,
    baseUrl: baseUrlCandidates[0] || null,
    baseUrlCandidates,
    password:
      process.env.BLUEBUBBLES_PASSWORD || env.BLUEBUBBLES_PASSWORD || null,
    host:
      process.env.BLUEBUBBLES_HOST ||
      env.BLUEBUBBLES_HOST ||
      DEFAULT_BLUEBUBBLES_HOST,
    port: parsePort(
      process.env.BLUEBUBBLES_PORT || env.BLUEBUBBLES_PORT,
      DEFAULT_BLUEBUBBLES_PORT,
    ),
    groupFolder:
      process.env.BLUEBUBBLES_GROUP_FOLDER ||
      env.BLUEBUBBLES_GROUP_FOLDER ||
      'main',
    webhookPublicBaseUrl: normalizeBaseUrl(
      process.env.BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL ||
        env.BLUEBUBBLES_WEBHOOK_PUBLIC_BASE_URL,
    ),
    serverPublicUrl: normalizeBaseUrl(
      process.env.BLUEBUBBLES_SERVER_PUBLIC_URL ||
        env.BLUEBUBBLES_SERVER_PUBLIC_URL,
    ),
    localPort: normalizeText(
      process.env.BLUEBUBBLES_LOCAL_PORT || env.BLUEBUBBLES_LOCAL_PORT,
    ),
    imessageAccountLabel: normalizeText(
      process.env.BLUEBUBBLES_IMESSAGE_ACCOUNT_LABEL ||
        env.BLUEBUBBLES_IMESSAGE_ACCOUNT_LABEL,
    ),
    computerId: normalizeText(
      process.env.BLUEBUBBLES_COMPUTER_ID || env.BLUEBUBBLES_COMPUTER_ID,
    ),
    chatScope: normalizeChatScope(
      process.env.BLUEBUBBLES_CHAT_SCOPE || env.BLUEBUBBLES_CHAT_SCOPE,
    ),
    allowedChatGuids: normalizeAllowedChatGuids(
      process.env.BLUEBUBBLES_ALLOWED_CHAT_GUIDS ||
        env.BLUEBUBBLES_ALLOWED_CHAT_GUIDS,
      process.env.BLUEBUBBLES_ALLOWED_CHAT_GUID ||
        env.BLUEBUBBLES_ALLOWED_CHAT_GUID,
    ),
    allowedChatGuid:
      process.env.BLUEBUBBLES_ALLOWED_CHAT_GUID ||
      env.BLUEBUBBLES_ALLOWED_CHAT_GUID ||
      null,
    webhookPath: normalizeWebhookPath(
      process.env.BLUEBUBBLES_WEBHOOK_PATH || env.BLUEBUBBLES_WEBHOOK_PATH,
    ),
    webhookSecret:
      process.env.BLUEBUBBLES_WEBHOOK_SECRET ||
      env.BLUEBUBBLES_WEBHOOK_SECRET ||
      null,
    sendEnabled: parseBool(
      process.env.BLUEBUBBLES_SEND_ENABLED || env.BLUEBUBBLES_SEND_ENABLED,
      false,
    ),
  };
}

export function buildBlueBubblesHealthSnapshot(
  config: BlueBubblesConfig,
  overrides: Partial<ChannelHealthSnapshot> = {},
): ChannelHealthSnapshot {
  const configured = isBlueBubblesRoutingConfigured(config);
  const defaultState = !config.enabled
    ? 'stopped'
    : !configured
      ? 'degraded'
      : config.sendEnabled
        ? 'ready'
        : 'degraded';
  const defaultDetail = !config.enabled
    ? 'BlueBubbles disabled'
    : !configured
      ? config.chatScope === 'allowlist'
        ? 'BlueBubbles enabled but missing base URL, password, or allowlist chat link'
        : 'BlueBubbles enabled but missing base URL, password, or shared group binding'
      : config.sendEnabled
        ? `BlueBubbles listener ready for ${config.chatScope}`
        : 'BlueBubbles listener is configured, but outbound reply-back is disabled';
  return {
    name: 'bluebubbles',
    configured,
    state: defaultState,
    updatedAt: new Date().toISOString(),
    detail: defaultDetail,
    ...overrides,
  };
}

function summarizeBlueBubblesCandidateProbeResults(
  results: Record<string, string>,
): string {
  const entries = Object.entries(results);
  if (entries.length === 0) {
    return 'none';
  }
  return entries
    .map(([baseUrl, detail]) => `${baseUrl} => ${detail}`)
    .join(' || ');
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value !== 0;
    }
    if (typeof value === 'string' && value.trim()) {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeTimestamp(value: unknown, fallback = new Date()): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallback.toISOString();
}

function parseBlueBubblesJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function fetchBlueBubblesWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs = BLUEBUBBLES_STARTUP_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`BlueBubbles request timed out after ${timeoutMs} ms`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function hydrateBlueBubblesAttachmentCache(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  attachments: MessageMediaAttachment[],
): Promise<MessageMediaAttachment[]> {
  if (!config.baseUrl || !config.password || attachments.length === 0) {
    return attachments;
  }

  const hydrated: MessageMediaAttachment[] = [];
  for (const attachment of attachments) {
    const maxFileBytes = getMediaCachePolicy().maxFileBytes;
    if ((attachment.sizeBytes || 0) > maxFileBytes) {
      hydrated.push({
        ...attachment,
        fetchStatus: 'skipped_too_large',
        metadataJson: JSON.stringify({
          ...(attachment.metadataJson ? { raw: attachment.metadataJson } : {}),
          cacheError: `Attachment exceeds the ${maxFileBytes}-byte cache limit.`,
        }).slice(0, 4000),
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    const existing = getMessageMediaAttachment(attachment.attachmentId);
    const reusable = getUsableCachedMediaFile(existing?.localPath);
    if (existing && reusable) {
      hydrated.push({
        ...attachment,
        mimeType: existing.mimeType || attachment.mimeType,
        sizeBytes: reusable.sizeBytes,
        localPath: reusable.localPath,
        contentHash: existing.contentHash,
        durationMs: existing.durationMs || attachment.durationMs,
        fetchStatus: 'cached',
        analysisStatus: existing.analysisStatus || attachment.analysisStatus,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    if (!attachment.sourceId) {
      hydrated.push(attachment);
      continue;
    }

    const buildUrl = (force: boolean): URL => {
      const url = new URL(
        `/api/v1/attachment/${encodeURIComponent(attachment.sourceId!)}/download`,
        config.baseUrl!,
      );
      for (const [key, value] of buildAuthSearchParams(
        config.password!,
      ).entries()) {
        url.searchParams.set(key, value);
      }
      if (force) {
        url.searchParams.set('force', 'true');
      }
      return url;
    };

    try {
      let response = await fetchBlueBubblesWithTimeout(buildUrl(false));
      if (!response.ok) {
        response = await fetchBlueBubblesWithTimeout(buildUrl(true));
      }
      if (!response.ok) {
        throw new Error(
          extractBlueBubblesErrorText(response.status, await response.text()),
        );
      }
      const bytes = await readMediaResponseBytes(response, maxFileBytes);
      const mimeType =
        response.headers.get('content-type') ||
        attachment.mimeType ||
        'application/octet-stream';
      const cached = cacheInboundMediaBytes({
        bytes,
        mimeType,
        filename: attachment.filename,
      });
      hydrated.push({
        ...attachment,
        mimeType,
        sizeBytes: cached.sizeBytes,
        localPath: cached.localPath,
        contentHash: cached.contentHash,
        fetchStatus: 'cached',
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'BlueBubbles media fetch failed';
      hydrated.push({
        ...attachment,
        fetchStatus:
          error instanceof MediaCacheLimitError
            ? 'skipped_too_large'
            : 'download_failed',
        metadataJson: JSON.stringify({
          ...(attachment.metadataJson ? { raw: attachment.metadataJson } : {}),
          downloadError: detail,
        }).slice(0, 4000),
        updatedAt: new Date().toISOString(),
      });
    }
  }
  return hydrated;
}

function extractBlueBubblesErrorText(status: number, body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return `BlueBubbles request failed with status ${status}`;
  }
  const parsed = parseBlueBubblesJson(trimmed);
  const record = asRecord(parsed);
  const nested = asRecord(record.data);
  return (
    firstString(
      record.error,
      record.message,
      nested.error,
      nested.message,
      trimmed,
    ) || `BlueBubbles request failed with status ${status}`
  );
}

function extractBlueBubblesReceiptId(payload: unknown): string | null {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(root.message);
  const nestedMessage = asRecord(data.message);
  const messages = Array.isArray(data.messages)
    ? data.messages.map((item) => asRecord(item))
    : [];
  return (
    firstString(
      root.guid,
      root.messageGuid,
      root.id,
      data.guid,
      data.messageGuid,
      data.id,
      message.guid,
      nestedMessage.guid,
      messages[0]?.guid,
      messages[0]?.messageGuid,
      messages[0]?.id,
    ) || null
  );
}

function extractBlueBubblesCreatedChatReceipt(payload: unknown): {
  chatGuid: string;
  messageGuid: string;
} | null {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const chat = asRecord(data.chat);
  const messages = [
    ...(Array.isArray(data.messages) ? data.messages : []),
    ...(Array.isArray(chat.messages) ? chat.messages : []),
    ...(Array.isArray(root.messages) ? root.messages : []),
  ].map((item) => asRecord(item));
  const chatGuid = firstString(data.guid, data.chatGuid, chat.guid);
  const messageGuid = firstString(
    messages[0]?.guid,
    messages[0]?.messageGuid,
    messages[0]?.id,
  );
  return chatGuid && messageGuid ? { chatGuid, messageGuid } : null;
}

function blueBubblesDeliveryUnverified(): ChannelDeliveryUnverifiedError {
  return new ChannelDeliveryUnverifiedError({
    outcome: 'unknown',
    confirmedReceiptIds: [],
    confirmedReceiptCount: 0,
  });
}

function normalizeBlueBubblesAttachmentRecords(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const candidates = [
    message.attachments,
    message.files,
    data.attachments,
    data.files,
    root.attachments,
    root.files,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function describeBlueBubblesAttachments(
  attachments: MessageMediaAttachment[],
): string {
  if (attachments.length === 0) return '';
  const counts = attachments.reduce<Record<string, number>>(
    (acc, attachment) => {
      acc[attachment.kind] = (acc[attachment.kind] || 0) + 1;
      return acc;
    },
    {},
  );
  const parts = Object.entries(counts).map(([kind, count]) =>
    count === 1 ? kind : `${count} ${kind}s`,
  );
  return `[${parts.join(', ')}]`;
}

function normalizeBlueBubblesAttachments(input: {
  payload: unknown;
  chatJid: string;
  messageId: string;
  now: Date;
}): MessageMediaAttachment[] {
  return normalizeBlueBubblesAttachmentRecords(input.payload).map(
    (entry, index) => {
      const record = asRecord(entry);
      const mimeType = firstString(
        record.mimeType,
        record.mime_type,
        record.type,
        record.contentType,
      );
      const filename = firstString(
        record.transferName,
        record.filename,
        record.fileName,
        record.name,
        record.originalFilename,
      );
      const sourceId = firstString(
        record.guid,
        record.attachmentGuid,
        record.id,
        record.rowid,
        record.ROWID,
        record.originalROWID,
      );
      const kind = inferMediaKindFromMime(mimeType, filename);
      const createdAt = input.now.toISOString();
      return {
        attachmentId: buildMediaAttachmentId({
          sourceChannel: 'bluebubbles',
          chatJid: input.chatJid,
          messageId: input.messageId,
          sourceId,
          filename,
          index,
        }),
        chatJid: input.chatJid,
        messageId: input.messageId,
        sourceChannel: 'bluebubbles',
        kind,
        mimeType,
        filename,
        sizeBytes: firstNumber(
          record.totalBytes,
          record.bytes,
          record.size,
          record.fileSize,
        ),
        sourceId,
        fetchStatus: sourceId ? 'metadata_only' : 'metadata_missing',
        analysisStatus: 'not_requested',
        createdAt,
        updatedAt: createdAt,
        metadataJson: JSON.stringify(record).slice(0, 4000),
      } satisfies MessageMediaAttachment;
    },
  );
}

function extractBlueBubblesPrivateApiState(payload: unknown): boolean | null {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  return firstBoolean(
    data.private_api,
    data.privateApi,
    root.private_api,
    root.privateApi,
  );
}

function buildAuthSearchParams(password: string): URLSearchParams {
  const params = new URLSearchParams();
  params.set('guid', password);
  params.set('password', password);
  params.set('token', password);
  return params;
}

function blueBubblesContactAddressKeys(
  value: string | null | undefined,
): string[] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return [];
  if (normalized.includes('@')) return [`email:${normalized}`];
  const digits = normalized.replace(/\D/g, '');
  if (digits.length >= 7) {
    const values = new Set([`phone:${digits}`]);
    if (digits.length === 11 && digits.startsWith('1')) {
      values.add(`phone:${digits.slice(1)}`);
    }
    return [...values];
  }
  return [`raw:${normalized}`];
}

function normalizeBlueBubblesContactTargetAddress(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 254) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return normalized.toLowerCase();
  }
  if (!/^\+?[\d\s().-]+$/.test(normalized)) return null;
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return normalized.startsWith('+') ? `+${digits}` : digits;
}

function normalizeBlueBubblesContactName(
  value: string | null | undefined,
): string {
  return value?.replace(/\s+/g, ' ').trim().toLowerCase() || '';
}

function blueBubblesDirectChatAddress(jid: string): string | null {
  const chatGuid = extractBlueBubblesChatGuid(jid);
  const match = chatGuid?.match(/^[^;]+;-;(.+)$/);
  return match?.[1]?.trim() || null;
}

function isSafeBlueBubblesContactDisplayName(
  value: string | null | undefined,
): value is string {
  const normalized = value?.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > 120) return false;
  if (
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return false;
  }
  if (/^[^\s@]+@[^\s@]+$/.test(normalized)) return false;
  if (/^\+?[\d\s().-]{7,}$/.test(normalized)) return false;
  return true;
}

function blueBubblesStoredChatNameIsDerivedAddress(params: {
  jid: string;
  name: string | null | undefined;
}): boolean {
  const normalized = params.name?.trim();
  if (!normalized || normalized === params.jid) return true;
  const guid = extractBlueBubblesChatGuid(params.jid);
  return Boolean(guid && normalized === guid);
}

function blueBubblesContactDisplayName(
  contact: Record<string, unknown>,
): string | null {
  const explicit = firstString(contact.displayName, contact.nickname);
  if (isSafeBlueBubblesContactDisplayName(explicit)) return explicit.trim();
  const composed = [
    firstString(contact.firstName),
    firstString(contact.lastName),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
  return isSafeBlueBubblesContactDisplayName(composed) ? composed : null;
}

function blueBubblesContactAddresses(
  contact: Record<string, unknown>,
): string[] {
  return [
    ...(Array.isArray(contact.phoneNumbers) ? contact.phoneNumbers : []),
    ...(Array.isArray(contact.emails) ? contact.emails : []),
  ]
    .map((item) => firstString(asRecord(item).address, item))
    .map(normalizeBlueBubblesContactTargetAddress)
    .filter((address): address is string => Boolean(address));
}

async function queryBlueBubblesContacts(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  addresses: string[],
): Promise<Record<string, unknown>[]> {
  const baseUrl = config.baseUrl;
  const password = config.password;
  if (!baseUrl || !password) {
    throw new Error('BlueBubbles contact lookup is not configured.');
  }
  const url = new URL('/api/v1/contact/query', baseUrl);
  for (const [key, value] of buildAuthSearchParams(password).entries()) {
    url.searchParams.set(key, value);
  }
  let response: Response;
  try {
    response = await fetchBlueBubblesWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addresses }),
    });
  } catch (error) {
    // Do not propagate a fetch error that might include the authenticated URL.
    const failureKind =
      error instanceof Error && error.name === 'AbortError'
        ? 'timed out'
        : 'transport failed';
    // eslint-disable-next-line preserve-caught-error -- the original may contain the authenticated URL
    throw new Error(`BlueBubbles contact lookup ${failureKind}.`);
  }
  if (!response.ok) {
    throw new Error(
      `BlueBubbles contact lookup failed with status ${response.status}.`,
    );
  }
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('BlueBubbles contact lookup response was too large.');
  }
  const payload = asRecord(parseBlueBubblesJson(responseText));
  return Array.isArray(payload.data)
    ? payload.data.slice(0, 2_000).map((item) => asRecord(item))
    : [];
}

export type BlueBubblesContactRecipientResolution =
  | {
      state: 'resolved';
      target: {
        chatJid: string;
        displayName: string;
        isGroup: false;
        blueBubblesCreateChatAddress: string;
      };
    }
  | {
      state: 'ambiguous';
      matches: Array<{
        chatJid: string;
        displayName: string;
        isGroup: false;
        blueBubblesCreateChatAddress: string;
      }>;
    }
  | { state: 'missing' };

/**
 * Resolve an explicit address, or an exact contact name, into a new direct
 * Messages target. The full contact response exists only for this lookup; the
 * selected name/address pair is the only value returned to the action ledger.
 */
export async function resolveBlueBubblesContactRecipient(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  query: string,
): Promise<BlueBubblesContactRecipientResolution> {
  const explicitAddress = normalizeBlueBubblesContactTargetAddress(query);
  if (explicitAddress) {
    return {
      state: 'resolved',
      target: {
        chatJid: `bb:iMessage;-;${explicitAddress}`,
        displayName: explicitAddress,
        isGroup: false,
        blueBubblesCreateChatAddress: explicitAddress,
      },
    };
  }
  if (!config.baseUrl || !config.password) return { state: 'missing' };
  const normalizedQuery = normalizeBlueBubblesContactName(query);
  if (!normalizedQuery) return { state: 'missing' };

  const contacts = await queryBlueBubblesContacts(config, []);
  const phoneMatchesByAddress = new Map<
    string,
    {
      chatJid: string;
      displayName: string;
      isGroup: false;
      blueBubblesCreateChatAddress: string;
    }
  >();
  const emailMatchesByAddress = new Map<
    string,
    {
      chatJid: string;
      displayName: string;
      isGroup: false;
      blueBubblesCreateChatAddress: string;
    }
  >();
  for (const contact of contacts) {
    const contactName = blueBubblesContactDisplayName(contact);
    if (
      !contactName ||
      normalizeBlueBubblesContactName(contactName) !== normalizedQuery
    ) {
      continue;
    }
    for (const address of blueBubblesContactAddresses(contact)) {
      const addressKeys = blueBubblesContactAddressKeys(address);
      const addressKey = addressKeys.at(-1) || address;
      const destination = address.includes('@')
        ? emailMatchesByAddress
        : phoneMatchesByAddress;
      if (destination.has(addressKey)) continue;
      destination.set(addressKey, {
        chatJid: `bb:iMessage;-;${address}`,
        displayName: `${contactName} at ${address}`,
        isGroup: false,
        blueBubblesCreateChatAddress: address,
      });
    }
  }
  // "Text" prefers the contact's phone lane. Email handles remain a fallback
  // only when the exact contact has no valid phone number.
  const matchesByAddress =
    phoneMatchesByAddress.size > 0
      ? phoneMatchesByAddress
      : emailMatchesByAddress;
  const matches = [...matchesByAddress.values()].slice(0, 8);
  if (matches.length === 0) return { state: 'missing' };
  if (matches.length === 1) return { state: 'resolved', target: matches[0]! };
  return { state: 'ambiguous', matches };
}

export interface BlueBubblesRecipientDirectoryHydration {
  queriedChatCount: number;
  matchedChatCount: number;
  updatedChatCount: number;
}

/**
 * Resolve existing direct-chat addresses through BlueBubbles' contacts API and
 * retain only the derived display-name mapping already supported by `chats`.
 * Contact cards, avatars, and address-book payloads are never persisted.
 */
export async function hydrateBlueBubblesRecipientDirectory(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
): Promise<BlueBubblesRecipientDirectoryHydration> {
  if (!config.baseUrl || !config.password) {
    return { queriedChatCount: 0, matchedChatCount: 0, updatedChatCount: 0 };
  }
  const chats = getAllChats().filter(
    (chat) =>
      (chat.channel === 'bluebubbles' || chat.jid.startsWith('bb:')) &&
      chat.is_group === 0 &&
      Boolean(blueBubblesDirectChatAddress(chat.jid)),
  );
  const addresses = [
    ...new Set(
      chats
        .map((chat) => blueBubblesDirectChatAddress(chat.jid))
        .filter((address): address is string => Boolean(address)),
    ),
  ].slice(0, 500);
  if (addresses.length === 0) {
    return { queriedChatCount: 0, matchedChatCount: 0, updatedChatCount: 0 };
  }

  const contacts = await queryBlueBubblesContacts(config, addresses);
  const namesByAddressKey = new Map<string, Set<string>>();
  for (const contact of contacts) {
    const displayName = blueBubblesContactDisplayName(contact);
    if (!displayName) continue;
    const contactAddresses = blueBubblesContactAddresses(contact);
    for (const key of contactAddresses.flatMap(blueBubblesContactAddressKeys)) {
      const names = namesByAddressKey.get(key) || new Set<string>();
      names.add(displayName);
      namesByAddressKey.set(key, names);
    }
  }

  let matchedChatCount = 0;
  let updatedChatCount = 0;
  for (const chat of chats) {
    const address = blueBubblesDirectChatAddress(chat.jid);
    const names = new Set(
      blueBubblesContactAddressKeys(address).flatMap((key) => [
        ...(namesByAddressKey.get(key) || []),
      ]),
    );
    if (names.size !== 1) continue;
    matchedChatCount += 1;
    const [displayName] = [...names];
    if (
      displayName &&
      blueBubblesStoredChatNameIsDerivedAddress({
        jid: chat.jid,
        name: chat.name,
      })
    ) {
      updateChatName(chat.jid, displayName);
      updatedChatCount += 1;
    }
  }

  return {
    queriedChatCount: addresses.length,
    matchedChatCount,
    updatedChatCount,
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeResponse(
  res: ServerResponse,
  statusCode: number,
  body: string,
): void {
  if (res.writableEnded) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(body);
}

export function normalizeBlueBubblesWebhookEvent(
  payload: unknown,
): BlueBubblesWebhookEvent {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const chats = Array.isArray(data.chats)
    ? data.chats.map((item) => asRecord(item))
    : Array.isArray(root.chats)
      ? root.chats.map((item) => asRecord(item))
      : [];
  const chat = chats[0] || asRecord(data.chat || root.chat);

  return {
    type:
      firstString(root.type, root.event, data.type, data.event, 'unknown') ||
      'unknown',
    messageGuid: firstString(
      root.messageGuid,
      root.guid,
      data.guid,
      message.guid,
      message.messageGuid,
    ),
    chatGuid: firstString(
      root.chatGuid,
      data.chatGuid,
      chat.guid,
      chat.chatGuid,
    ),
    data,
  };
}

export function normalizeBlueBubblesContactRef(
  payload: unknown,
): BlueBubblesContactRef {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const sender = asRecord(
    message.handle ||
      message.sender ||
      data.handle ||
      data.sender ||
      root.handle ||
      root.sender,
  );

  return {
    handle:
      firstString(
        sender.address,
        sender.handle,
        sender.id,
        data.address,
        root.address,
        message.handle,
        message.address,
        'unknown',
      ) || 'unknown',
    displayName: firstString(
      sender.displayName,
      sender.name,
      data.senderName,
      data.displayName,
      message.senderName,
      message.contactName,
    ),
    address: firstString(
      sender.address,
      data.address,
      message.address,
      root.address,
    ),
    service: firstString(
      sender.service,
      message.service,
      data.service,
      root.service,
    ),
  };
}

export function normalizeBlueBubblesChatRef(
  payload: unknown,
): BlueBubblesChatRef {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const chats = Array.isArray(data.chats)
    ? data.chats.map((item) => asRecord(item))
    : Array.isArray(root.chats)
      ? root.chats.map((item) => asRecord(item))
      : [];
  const chat = chats[0] || asRecord(data.chat || root.chat);
  const participants = Array.isArray(chat.participants)
    ? chat.participants
        .map((participant) => {
          const record = asRecord(participant);
          return firstString(record.address, record.handle, record.id);
        })
        .filter((value): value is string => Boolean(value))
    : [];
  const chatGuid =
    firstString(root.chatGuid, data.chatGuid, chat.guid, chat.chatGuid) ||
    'unknown';
  const explicitIsGroup = firstBoolean(
    chat.isGroup,
    data.isGroup,
    root.isGroup,
  );

  return {
    chatGuid,
    displayName: firstString(chat.displayName, chat.name),
    isGroup: inferBlueBubblesGroupChat(
      chatGuid,
      participants.length > 1 ? true : explicitIsGroup,
    ),
    participants,
    chatIdentifier: firstString(
      chat.chatIdentifier,
      chat.identifier,
      data.chatIdentifier,
      root.chatIdentifier,
    ),
    lastAddressedHandle: firstString(
      chat.lastAddressedHandle,
      data.lastAddressedHandle,
      root.lastAddressedHandle,
    ),
    service:
      firstString(chat.service, data.service, root.service) ||
      extractBlueBubblesServiceFromChatGuid(chatGuid),
  };
}

export function normalizeBlueBubblesIncomingMessage(
  payload: unknown,
  now = new Date(),
): {
  chatJid: string;
  message: NewMessage;
  chat: BlueBubblesChatRef;
  contact: BlueBubblesContactRef;
} | null {
  const event = normalizeBlueBubblesWebhookEvent(payload);
  if (!/new.?message/i.test(event.type) && event.type !== 'message.new') {
    return null;
  }

  const root = asRecord(payload);
  const data = asRecord(root.data);
  const message = asRecord(data.message);
  const text = firstString(
    message.text,
    message.body,
    data.text,
    data.message,
    root.body,
    root.text,
  );
  const chat = normalizeBlueBubblesChatRef(payload);
  const contact = normalizeBlueBubblesContactRef(payload);
  const messageGuid =
    event.messageGuid ||
    `${chat.chatGuid}:${normalizeTimestamp(message.date, now)}`;
  const messageId = `bb:${messageGuid}`;
  const chatJid = `bb:${chat.chatGuid}`;
  const attachments = normalizeBlueBubblesAttachments({
    payload,
    chatJid,
    messageId,
    now,
  });
  const associatedMessageGuid =
    message.associatedMessageGuid ??
    data.associatedMessageGuid ??
    root.associatedMessageGuid;
  const reactionKind = normalizeBlueBubblesReactionKind(
    message.associatedMessageType ??
      data.associatedMessageType ??
      root.associatedMessageType,
  );
  const reactionTargetMessageId = normalizeBlueBubblesAssociatedMessageId(
    associatedMessageGuid,
  );
  const reaction =
    reactionKind && reactionTargetMessageId
      ? {
          ...reactionKind,
          targetMessageId: reactionTargetMessageId,
        }
      : undefined;
  if (!text && attachments.length === 0 && !reaction) return null;

  return {
    chatJid,
    chat,
    contact,
    message: {
      id: messageId,
      chat_jid: chatJid,
      sender: `bb:${contact.handle}`,
      sender_name: contact.displayName || contact.handle,
      content:
        text ||
        (reaction
          ? `[BlueBubbles reaction: ${reaction.removed ? 'removed ' : ''}${reaction.kind}]`
          : describeBlueBubblesAttachments(attachments)),
      timestamp: normalizeTimestamp(
        message.dateCreated ||
          message.date ||
          data.dateCreated ||
          data.date ||
          root.dateCreated ||
          root.date,
        now,
      ),
      is_from_me:
        firstBoolean(message.isFromMe, data.isFromMe, root.isFromMe) || false,
      is_bot_message: false,
      reply_to_id: normalizeBlueBubblesReplyId(
        firstString(
          message.replyToGuid,
          data.replyToGuid,
          root.replyToGuid,
          message.associatedMessageGuid,
          data.associatedMessageGuid,
          root.associatedMessageGuid,
        ),
      ),
      reaction,
      attachments,
    },
  };
}

type BlueBubblesWebhookRegistrationState =
  | 'not_configured'
  | 'registered'
  | 'missing'
  | 'auth_failed'
  | 'unreachable';

export interface BlueBubblesWebhookInspection {
  state: BlueBubblesWebhookRegistrationState;
  detail: string;
  webhookId?: number | null;
}

function normalizeBlueBubblesWebhookList(payload: unknown): Array<{
  id: number | null;
  url: string;
  events: string[];
}> {
  const root = asRecord(payload);
  const entries = Array.isArray(root.data)
    ? root.data
    : Array.isArray(root.webhooks)
      ? root.webhooks
      : [];
  return entries
    .map((entry) => {
      const record = asRecord(entry);
      const url = firstString(record.url, record.endpoint);
      if (!url) return null;
      return {
        id:
          typeof record.id === 'number' && Number.isFinite(record.id)
            ? record.id
            : null,
        url,
        events: Array.isArray(record.events)
          ? record.events
              .map((event) => (typeof event === 'string' ? event : ''))
              .filter((event): event is string => Boolean(event))
          : [],
      };
    })
    .filter(
      (entry): entry is { id: number | null; url: string; events: string[] } =>
        entry !== null,
    );
}

export async function inspectBlueBubblesWebhookRegistration(
  config: Pick<
    BlueBubblesConfig,
    | 'enabled'
    | 'baseUrl'
    | 'password'
    | 'host'
    | 'port'
    | 'webhookPath'
    | 'webhookSecret'
    | 'webhookPublicBaseUrl'
  >,
): Promise<BlueBubblesWebhookInspection> {
  if (!config.enabled || !config.baseUrl || !config.password) {
    return {
      state: 'not_configured',
      detail:
        'webhook registration cannot be checked until BlueBubbles is enabled with a base URL and password',
    };
  }

  const expectedUrl = buildBlueBubblesWebhookUrl(config);
  const url = new URL('/api/v1/webhook', config.baseUrl);
  for (const [key, value] of buildAuthSearchParams(config.password).entries()) {
    url.searchParams.set(key, value);
  }

  try {
    const response = await fetchBlueBubblesWithTimeout(url);
    const responseText = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        state: 'auth_failed',
        detail: extractBlueBubblesErrorText(response.status, responseText),
      };
    }
    if (!response.ok) {
      return {
        state: 'unreachable',
        detail: extractBlueBubblesErrorText(response.status, responseText),
      };
    }
    const webhooks = normalizeBlueBubblesWebhookList(
      parseBlueBubblesJson(responseText),
    );
    const matched = webhooks.find((entry) => entry.url === expectedUrl);
    if (!matched) {
      return {
        state: 'missing',
        detail:
          'no matching Andrea webhook is registered on the BlueBubbles server',
      };
    }
    return {
      state: 'registered',
      detail:
        matched.id != null
          ? `registered on the BlueBubbles server as webhook ${matched.id}`
          : 'registered on the BlueBubbles server',
      webhookId: matched.id,
    };
  } catch (error) {
    return {
      state: 'unreachable',
      detail:
        error instanceof Error
          ? error.message
          : 'BlueBubbles webhook registration check failed',
    };
  }
}

function normalizeBlueBubblesHistoryPayload(
  chatGuid: string,
  rawMessage: unknown,
): unknown {
  const message = asRecord(rawMessage);
  const chats = Array.isArray(message.chats)
    ? message.chats.map((item) => asRecord(item))
    : [];
  const chat = chats[0] || {};
  const handle = asRecord(message.handle);
  const participants = Array.isArray(chat.participants)
    ? chat.participants
    : handle.address
      ? [{ address: handle.address, displayName: handle.displayName }]
      : [];

  return {
    type: 'new-message',
    data: {
      guid: firstString(message.guid, message.messageGuid, message.id),
      chatGuid,
      chat: {
        guid: firstString(chat.guid, chat.chatGuid, chatGuid) || chatGuid,
        displayName: firstString(chat.displayName, chat.name),
        isGroup: inferBlueBubblesGroupChat(
          chatGuid,
          Array.isArray(participants) && participants.length > 1
            ? true
            : typeof chat.isGroup === 'boolean'
              ? chat.isGroup
              : null,
        ),
        chatIdentifier: firstString(
          chat.chatIdentifier,
          chat.identifier,
          message.chatIdentifier,
        ),
        lastAddressedHandle: firstString(
          chat.lastAddressedHandle,
          message.lastAddressedHandle,
        ),
        service:
          firstString(chat.service, handle.service, message.service) ||
          extractBlueBubblesServiceFromChatGuid(chatGuid),
        participants,
      },
      message: {
        guid: firstString(message.guid, message.messageGuid, message.id),
        text: firstString(message.text, message.body, message.message),
        attachments: Array.isArray(message.attachments)
          ? message.attachments
          : Array.isArray(message.files)
            ? message.files
            : [],
        senderName: firstString(
          message.senderName,
          handle.displayName,
          handle.address,
        ),
        handle: {
          address: firstString(handle.address, handle.handle, handle.id),
          displayName: firstString(handle.displayName, message.senderName),
          service:
            firstString(handle.service, message.service, chat.service) ||
            extractBlueBubblesServiceFromChatGuid(chatGuid),
        },
        replyToGuid: firstString(
          message.replyToGuid,
          message.associatedMessageGuid,
        ),
        dateCreated:
          message.dateCreated || message.date || message.dateCreatedEpoch,
        isFromMe: Boolean(message.isFromMe),
      },
    },
  };
}

function normalizeBlueBubblesHistoryRows(payload: unknown): unknown[] {
  const root = asRecord(payload);
  if (Array.isArray(root.data)) return root.data;
  if (Array.isArray(root.messages)) return root.messages;
  return [];
}

type NormalizedBlueBubblesHistoryRow = {
  chatJid: string;
  message: NewMessage;
  chat: BlueBubblesChatRef;
  contact: BlueBubblesContactRef;
};

class BlueBubblesMessagesProvider implements AppleMessagesProvider {
  readonly name = 'bluebubbles' as const;

  async probe(config: BlueBubblesConfig): Promise<AppleMessagesProbeResult> {
    const candidates = getBlueBubblesBaseUrlCandidates(config);
    if (candidates.length === 0 || !config.password) {
      return {
        provider: this.name,
        status: 'not_configured',
        detail: 'not configured',
        activeEndpoint: null,
        candidateResults: {},
      };
    }

    const candidateResults: Record<string, string> = {};
    let firstAuthFailed: {
      baseUrl: string;
      detail: string;
    } | null = null;

    for (const candidate of candidates) {
      const url = new URL('/api/v1/ping', candidate);
      for (const [key, value] of buildAuthSearchParams(
        config.password,
      ).entries()) {
        url.searchParams.set(key, value);
      }

      try {
        const response = await fetchBlueBubblesWithTimeout(url);
        const responseText = await response.text();
        if (response.ok) {
          candidateResults[candidate] =
            `reachable/auth ok (${response.status})`;
          return {
            provider: this.name,
            status: 'reachable',
            detail: `reachable/auth ok (${response.status}) via ${candidate}`,
            activeEndpoint: candidate,
            candidateResults,
          };
        }
        if (response.status === 401 || response.status === 403) {
          const detail = extractBlueBubblesErrorText(
            response.status,
            responseText,
          );
          candidateResults[candidate] = `auth failed (${detail})`;
          if (!firstAuthFailed) {
            firstAuthFailed = {
              baseUrl: candidate,
              detail,
            };
          }
          continue;
        }
        candidateResults[candidate] =
          `unreachable (${extractBlueBubblesErrorText(
            response.status,
            responseText,
          )})`;
      } catch (error) {
        candidateResults[candidate] = `unreachable (${
          error instanceof Error ? error.message : 'transport probe failed'
        })`;
      }
    }

    if (firstAuthFailed) {
      return {
        provider: this.name,
        status: 'auth_failed',
        detail: `${firstAuthFailed.detail} via ${firstAuthFailed.baseUrl}`,
        activeEndpoint: firstAuthFailed.baseUrl,
        candidateResults,
      };
    }

    return {
      provider: this.name,
      status: 'unreachable',
      detail:
        candidates.length === 1
          ? candidateResults[candidates[0]] || 'transport probe failed'
          : `no reachable BlueBubbles endpoint (${summarizeBlueBubblesCandidateProbeResults(
              candidateResults,
            )})`,
      activeEndpoint: null,
      candidateResults,
    };
  }

  async inspectRecentActivity(
    config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
    options?: {
      limit?: number;
      candidateChatJids?: string[];
    },
  ): Promise<NormalizedBlueBubblesHistoryRow[]> {
    return fetchNormalizedBlueBubblesRecentMessages(
      config,
      options?.limit ?? 12,
      options?.candidateChatJids || [],
    );
  }

  async sendText(
    config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
    request: {
      chatGuid: string;
      text: string;
      replyToGuid?: string;
      sendMethod: string;
    },
  ): Promise<SendMessageResult> {
    if (!config.baseUrl || !config.password || !request.chatGuid) {
      throw new Error(
        'BlueBubbles transport is missing a reachable endpoint, password, or chat target',
      );
    }

    const url = new URL('/api/v1/message/text', config.baseUrl);
    for (const [key, value] of buildAuthSearchParams(
      config.password,
    ).entries()) {
      url.searchParams.set(key, value);
    }

    const body: Record<string, unknown> = {
      chatGuid: request.chatGuid,
      message: request.text,
      tempGuid: randomUUID(),
      method: request.sendMethod,
    };
    if (request.replyToGuid) {
      body.selectedMessageGuid = request.replyToGuid;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        extractBlueBubblesErrorText(response.status, responseText),
      );
    }
    const parsed = parseBlueBubblesJson(responseText);
    const receiptId = extractBlueBubblesReceiptId(parsed);
    if (!receiptId) {
      throw new Error('BlueBubbles did not return a delivery receipt.');
    }
    return {
      platformMessageId: `bb:${receiptId}`,
    };
  }

  async createDirectChat(
    config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
    request: {
      address: string;
      text: string;
      sendMethod: string;
      service: 'iMessage' | 'SMS';
    },
  ): Promise<SendMessageResult> {
    if (!config.baseUrl || !config.password || !request.address) {
      throw new Error(
        'BlueBubbles transport is missing a reachable endpoint, password, or recipient address',
      );
    }

    const url = new URL('/api/v1/chat/new', config.baseUrl);
    for (const [key, value] of buildAuthSearchParams(
      config.password,
    ).entries()) {
      url.searchParams.set(key, value);
    }
    const body = {
      addresses: [request.address],
      message: request.text,
      method: request.sendMethod,
      service: request.service,
      tempGuid: randomUUID(),
    };

    let response: Response;
    try {
      response = await fetchBlueBubblesWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        BLUEBUBBLES_CREATE_CHAT_TIMEOUT_MS,
      );
    } catch {
      // The request may have reached Messages even when its HTTP result did
      // not return. First-contact sends must never retry that uncertainty.
      throw blueBubblesDeliveryUnverified();
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw blueBubblesDeliveryUnverified();
    }
    if (
      !response.ok ||
      Buffer.byteLength(responseText, 'utf8') > 2 * 1024 * 1024
    ) {
      // BlueBubbles can send before completing its chat-verification wait, so
      // even a non-success response is not evidence that delivery was absent.
      throw blueBubblesDeliveryUnverified();
    }
    const receipt = extractBlueBubblesCreatedChatReceipt(
      parseBlueBubblesJson(responseText),
    );
    if (!receipt) {
      throw blueBubblesDeliveryUnverified();
    }
    return {
      platformMessageId: `bb:${receipt.messageGuid}`,
      threadId: buildBlueBubblesChatJid(receipt.chatGuid),
    };
  }

  async describeReadiness(
    config: Pick<
      BlueBubblesConfig,
      | 'enabled'
      | 'baseUrl'
      | 'password'
      | 'host'
      | 'port'
      | 'webhookPath'
      | 'webhookSecret'
      | 'webhookPublicBaseUrl'
    >,
  ): Promise<AppleMessagesReadinessResult> {
    if (!config.baseUrl || !config.password) {
      return {
        provider: this.name,
        webhookRegistrationState: 'unreachable',
        webhookRegistrationDetail:
          'skipped because no reachable BlueBubbles endpoint is available yet',
        privateApiAvailable: null,
        sendMethod: 'private-api',
      };
    }

    const webhookInspection =
      await inspectBlueBubblesWebhookRegistration(config);
    let privateApiAvailable: boolean | null = null;
    let sendMethod: BlueBubblesSendMethod = 'private-api';

    const url = new URL('/api/v1/server/info', config.baseUrl);
    for (const [key, value] of buildAuthSearchParams(
      config.password,
    ).entries()) {
      url.searchParams.set(key, value);
    }

    try {
      const response = await fetchBlueBubblesWithTimeout(url);
      const responseText = await response.text();
      if (response.ok) {
        privateApiAvailable = extractBlueBubblesPrivateApiState(
          parseBlueBubblesJson(responseText),
        );
        sendMethod =
          privateApiAvailable === false ? 'apple-script' : 'private-api';
      } else {
        logger.info(
          {
            status: response.status,
            detail: extractBlueBubblesErrorText(response.status, responseText),
          },
          'BlueBubbles server info probe failed; keeping private-api send mode',
        );
      }
    } catch (error) {
      logger.info(
        { err: error },
        'BlueBubbles server info probe failed; keeping private-api send mode',
      );
    }

    return {
      provider: this.name,
      webhookRegistrationState: webhookInspection.state,
      webhookRegistrationDetail: webhookInspection.detail,
      privateApiAvailable,
      sendMethod,
    };
  }
}

async function fetchNormalizedBlueBubblesHistoryRows(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  chatGuid: string,
  limit = 12,
): Promise<NormalizedBlueBubblesHistoryRow[]> {
  if (!chatGuid || !config.baseUrl || !config.password) {
    return [];
  }

  const url = new URL(
    `/api/v1/chat/${encodeURIComponent(chatGuid)}/message`,
    config.baseUrl,
  );
  for (const [key, value] of buildAuthSearchParams(config.password).entries()) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('limit', String(Math.max(1, limit)));
  url.searchParams.set('offset', '0');
  url.searchParams.set('sort', 'DESC');

  const response = await fetch(url);
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(extractBlueBubblesErrorText(response.status, responseText));
  }

  const rows = normalizeBlueBubblesHistoryRows(
    parseBlueBubblesJson(responseText),
  )
    .map((row) =>
      normalizeBlueBubblesIncomingMessage(
        normalizeBlueBubblesHistoryPayload(chatGuid, row),
      ),
    )
    .filter(
      (
        row,
      ): row is {
        chatJid: string;
        message: NewMessage;
        chat: BlueBubblesChatRef;
        contact: BlueBubblesContactRef;
      } => row !== null,
    );
  for (const row of rows) {
    row.message.attachments = await hydrateBlueBubblesAttachmentCache(
      config,
      row.message.attachments || [],
    );
  }
  return rows.sort((left, right) =>
    left.message.timestamp.localeCompare(right.message.timestamp),
  );
}

async function fetchNormalizedBlueBubblesRecentMessages(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  limit = 12,
  candidateChatJids: string[] = [],
): Promise<NormalizedBlueBubblesHistoryRow[]> {
  if (!config.baseUrl || !config.password) {
    return [];
  }

  const url = new URL('/api/v1/message', config.baseUrl);
  for (const [key, value] of buildAuthSearchParams(config.password).entries()) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('limit', String(Math.max(1, limit)));
  url.searchParams.set('offset', '0');
  url.searchParams.set('sort', 'DESC');

  const response = await fetchBlueBubblesWithTimeout(url);
  const responseText = await response.text();
  if (!response.ok) {
    const errorText = extractBlueBubblesErrorText(
      response.status,
      responseText,
    );
    if (response.status !== 404 || candidateChatJids.length === 0) {
      throw new Error(errorText);
    }
    return fetchNormalizedBlueBubblesRecentMessagesFromRecentChats(
      config,
      candidateChatJids,
      limit,
      errorText,
    );
  }

  const rows = normalizeBlueBubblesHistoryRows(
    parseBlueBubblesJson(responseText),
  ).map((row) => {
    const rowRecord = asRecord(row);
    const chats = Array.isArray(rowRecord.chats)
      ? rowRecord.chats.map((item) => asRecord(item))
      : [];
    const chat = chats[0] || {};
    const chatGuid =
      firstString(
        rowRecord.chatGuid,
        chat.guid,
        chat.chatGuid,
        rowRecord.guid,
      ) || null;
    if (!chatGuid) return null;
    return normalizeBlueBubblesIncomingMessage(
      normalizeBlueBubblesHistoryPayload(chatGuid, rowRecord),
    );
  });
  const filtered = rows.filter(
    (row): row is NormalizedBlueBubblesHistoryRow => row !== null,
  );
  for (const row of filtered) {
    row.message.attachments = await hydrateBlueBubblesAttachmentCache(
      config,
      row.message.attachments || [],
    );
  }
  return filtered.sort((left, right) =>
    left.message.timestamp.localeCompare(right.message.timestamp),
  );
}

async function fetchNormalizedBlueBubblesRecentMessagesFromRecentChats(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  candidateChatJids: string[],
  limit: number,
  originalErrorText: string,
): Promise<NormalizedBlueBubblesHistoryRow[]> {
  const uniqueChatJids = [
    ...new Set(
      candidateChatJids.filter((chatJid) => chatJid.startsWith('bb:')),
    ),
  ];
  const mergedRows = new Map<string, NormalizedBlueBubblesHistoryRow>();
  const errors: string[] = [];

  for (const chatJid of uniqueChatJids) {
    const chatGuid = extractBlueBubblesChatGuid(chatJid);
    if (!chatGuid) {
      continue;
    }
    try {
      const rows = await fetchNormalizedBlueBubblesHistoryRows(
        config,
        chatGuid,
        Math.min(Math.max(2, limit), 4),
      );
      for (const row of rows) {
        mergedRows.set(row.message.id, row);
      }
    } catch (error) {
      errors.push(
        `${chatJid}: ${
          error instanceof Error
            ? error.message
            : 'recent chat history probe failed'
        }`,
      );
    }
  }

  if (mergedRows.size === 0) {
    throw new Error(
      errors.length > 0
        ? `BlueBubbles recent activity probe failed (${originalErrorText}; ${errors.join(' | ')})`
        : originalErrorText,
    );
  }

  return [...mergedRows.values()]
    .sort((left, right) =>
      left.message.timestamp.localeCompare(right.message.timestamp),
    )
    .slice(-Math.max(1, limit));
}

export async function primeBlueBubblesChatHistory(
  config: Pick<BlueBubblesConfig, 'baseUrl' | 'password'>,
  chatJid: string,
  limit = 12,
): Promise<{ storedCount: number; totalCount: number }> {
  const chatGuid = extractBlueBubblesChatGuid(chatJid);
  if (!chatGuid || !config.baseUrl || !config.password) {
    return { storedCount: 0, totalCount: 0 };
  }

  const normalizedRows = await fetchNormalizedBlueBubblesHistoryRows(
    config,
    chatGuid,
    limit,
  );

  let storedCount = 0;
  for (const row of normalizedRows) {
    storeChatMetadata(
      row.chatJid,
      row.message.timestamp,
      row.chat.displayName ||
        (!row.chat.isGroup ? row.contact.displayName : null) ||
        row.chat.chatGuid,
      'bluebubbles',
      row.chat.isGroup,
    );
    if (hasStoredMessage(row.chatJid, row.message.id)) {
      continue;
    }
    storeMessageDirect({
      id: row.message.id,
      chat_jid: row.chatJid,
      sender: row.message.sender,
      sender_name: row.message.sender_name,
      content: row.message.content,
      timestamp: row.message.timestamp,
      is_from_me: Boolean(row.message.is_from_me),
      is_bot_message: row.message.is_bot_message,
      reply_to_id: row.message.reply_to_id || undefined,
      attachments: row.message.attachments || [],
    });
    storedCount += 1;
  }

  return {
    storedCount,
    totalCount: normalizedRows.length,
  };
}

export function createBlueBubblesWebhookAdapter(opts: {
  onMessage: ChannelOpts['onMessage'];
  onChatMetadata: ChannelOpts['onChatMetadata'];
}) {
  return async (payload: unknown): Promise<NewMessage | null> => {
    const normalized = normalizeBlueBubblesIncomingMessage(payload);
    if (!normalized) return null;

    const timestamp = normalized.message.timestamp;
    await opts.onChatMetadata(
      normalized.chatJid,
      timestamp,
      normalized.chat.displayName ||
        (!normalized.chat.isGroup ? normalized.contact.displayName : null) ||
        normalized.chat.chatGuid,
      'bluebubbles',
      normalized.chat.isGroup,
    );
    await opts.onMessage(normalized.chatJid, normalized.message);
    return normalized.message;
  };
}

export class BlueBubblesChannel implements Channel {
  readonly name = 'bluebubbles';

  readonly appleMessagesProvider = 'bluebubbles' as const;

  private connected = false;

  private server?: Server;

  private activePort: number;

  private lastReadyAt: string | null = null;

  private lastInboundObservedAt: string | null = null;

  private lastOutboundResult: string | null = null;

  private lastErrorText: string | null = null;

  private transportProbeStatus:
    | 'not_checked'
    | 'reachable'
    | 'auth_failed'
    | 'unreachable' = 'not_checked';

  private transportProbeDetail: string | null = null;

  private webhookRegistrationStatus: BlueBubblesWebhookRegistrationState =
    'not_configured';

  private webhookRegistrationDetail: string | null = null;

  private readonly inflightMessageIds = new Set<string>();

  private readonly recentIngressFingerprints = new Map<
    string,
    BlueBubblesIngressFingerprintObservation[]
  >();

  private readonly directChatMetadataByJid = new Map<
    string,
    BlueBubblesDirectChatMetadata
  >();

  private readonly successfulOutboundTargetByJid = new Map<
    string,
    BlueBubblesOutboundTargetCandidate
  >();

  private lastInboundChatJid: string | null = null;

  private lastInboundWasSelfAuthored = false;

  private lastOutboundTargetKind: string | null = null;

  private lastOutboundTargetValue: string | null = null;

  private lastSendErrorDetail: string | null = null;

  private lastMetadataHydrationSource: 'none' | 'history' = 'none';

  private lastAttemptedTargetSequence: string[] = [];

  private sendMethod: BlueBubblesSendMethod = 'private-api';

  private privateApiAvailable: boolean | null = null;

  private shadowPollTimer: ReturnType<typeof setInterval> | null = null;

  private monitorState: BlueBubblesMonitorState = readBlueBubblesMonitorState();

  private readonly bridgeProvider: AppleMessagesProvider =
    new BlueBubblesMessagesProvider();

  constructor(
    private readonly config: BlueBubblesConfig,
    private readonly opts: ChannelOpts,
  ) {
    this.activePort = config.port;
    this.rehydrateRuntimeStateFromMonitor();
  }

  private rehydrateRuntimeStateFromMonitor(): void {
    this.lastInboundObservedAt = this.monitorState.lastInboundObservedAt;
    this.lastInboundChatJid = this.monitorState.lastInboundChatJid;
    this.lastInboundWasSelfAuthored = Boolean(
      this.monitorState.lastInboundWasSelfAuthored,
    );
    this.lastOutboundTargetKind = this.monitorState.lastOutboundTargetKind;
    this.lastOutboundTargetValue = this.monitorState.lastOutboundTargetValue;
    this.lastSendErrorDetail = this.monitorState.lastSendErrorDetail;
    this.lastMetadataHydrationSource =
      this.monitorState.lastMetadataHydrationSource === 'history'
        ? 'history'
        : 'none';
    this.lastAttemptedTargetSequence = [
      ...this.monitorState.lastAttemptedTargetSequence,
    ];
    if (
      this.monitorState.lastOutboundObservedAt &&
      this.monitorState.lastOutboundObservedChatJid
    ) {
      this.lastOutboundResult = `${this.monitorState.lastOutboundObservedAt} (${this.monitorState.lastOutboundObservedChatJid})`;
    }
  }

  private getConfiguredBaseUrlCandidates(): string[] {
    return getBlueBubblesBaseUrlCandidates(this.config);
  }

  private getActiveBaseUrl(): string | null {
    return this.monitorState.activeBaseUrl;
  }

  private buildConfigForBaseUrl(baseUrl: string | null): BlueBubblesConfig {
    return {
      ...this.config,
      baseUrl,
    };
  }

  private async ensureActiveBaseUrl(options?: {
    recheck?: boolean;
    refreshReadiness?: boolean;
  }): Promise<string | null> {
    const previous = this.getActiveBaseUrl();
    if (previous && !options?.recheck) {
      return previous;
    }
    await this.probeBlueBubblesTransport();
    const activeBaseUrl = this.getActiveBaseUrl();
    if (
      options?.refreshReadiness &&
      (activeBaseUrl !== previous || this.webhookRegistrationDetail == null)
    ) {
      await this.refreshBridgeReadiness();
    }
    if (options?.recheck) {
      this.persistMonitorState();
    }
    return activeBaseUrl;
  }

  private async refreshBridgeReadiness(): Promise<void> {
    const readiness = await this.bridgeProvider.describeReadiness(
      this.buildConfigForBaseUrl(this.getActiveBaseUrl()),
    );
    this.webhookRegistrationStatus =
      readiness.webhookRegistrationState as BlueBubblesWebhookRegistrationState;
    this.webhookRegistrationDetail = readiness.webhookRegistrationDetail;
    this.privateApiAvailable = readiness.privateApiAvailable;
    this.sendMethod = readiness.sendMethod as BlueBubblesSendMethod;
  }

  private buildDirectChatMetadata(input: {
    chatJid: string;
    chat: BlueBubblesChatRef;
    contact: BlueBubblesContactRef;
    message?: Pick<NewMessage, 'is_from_me' | 'timestamp'>;
  }): BlueBubblesDirectChatMetadata {
    return {
      chatJid: input.chatJid,
      chatGuid: input.chat.chatGuid,
      isGroup: inferBlueBubblesGroupChat(
        input.chat.chatGuid,
        input.chat.isGroup,
      ),
      chatIdentifier:
        normalizeBlueBubblesDirectTargetValue(input.chat.chatIdentifier) ||
        normalizeBlueBubblesDirectTargetValue(
          input.chat.chatGuid.split(';').slice(2).join(';'),
        ),
      lastAddressedHandle: normalizeBlueBubblesDirectTargetValue(
        input.chat.lastAddressedHandle,
      ),
      handleAddress: normalizeBlueBubblesDirectTargetValue(
        input.contact.address,
      ),
      service:
        normalizeBlueBubblesDirectTargetValue(input.contact.service) ||
        normalizeBlueBubblesDirectTargetValue(input.chat.service) ||
        extractBlueBubblesServiceFromChatGuid(input.chat.chatGuid),
      lastObservedAt: input.message?.timestamp || null,
      lastObservedWasSelfAuthored: Boolean(input.message?.is_from_me),
    };
  }

  private getReplyGateModeForChat(params: {
    chatJid: string | null | undefined;
    isGroup?: boolean | null;
  }): BlueBubblesReplyGateMode {
    if (params.isGroup) {
      return 'mention_required';
    }
    if (isBlueBubblesSelfThreadAliasJid(params.chatJid)) {
      return 'direct_1to1';
    }
    if (this.hasRecentAndreaContextForChat(params.chatJid)) {
      return 'direct_1to1';
    }
    return resolveBlueBubblesReplyGateMode({
      chatJid: params.chatJid,
      isGroup: params.isGroup,
    });
  }

  private hasRecentAndreaContextForChat(
    chatJid: string | null | undefined,
  ): boolean {
    const normalizedChatJid = chatJid?.trim();
    if (!normalizedChatJid) {
      return false;
    }
    const freshnessCutoff = Date.now() - BLUEBUBBLES_DIRECT_CONTEXT_WINDOW_MS;
    return listRecentMessagesForChat(normalizedChatJid, 12).some((message) => {
      const timestamp = Date.parse(message.timestamp || '');
      if (!Number.isFinite(timestamp) || timestamp < freshnessCutoff) {
        return false;
      }
      return (
        Boolean(message.is_bot_message) ||
        (Boolean(message.is_from_me) &&
          isBlueBubblesAndreaBotEcho(message.content))
      );
    });
  }

  private getRepresentativeHealthChatJid(): string | null {
    return (
      this.monitorState.lastOutboundObservedChatJid ||
      this.lastInboundChatJid ||
      this.monitorState.lastInboundChatJid ||
      this.monitorState.mostRecentWebhookObservedChatJid ||
      this.monitorState.mostRecentServerSeenChatJid ||
      null
    );
  }

  private getHealthReplyGateMode(): BlueBubblesReplyGateMode {
    const chatJid = this.getRepresentativeHealthChatJid();
    const matchedChat = chatJid
      ? getAllChats().find((chat) => chat.jid === chatJid)
      : null;
    return this.getReplyGateModeForChat({
      chatJid,
      isGroup:
        matchedChat && typeof matchedChat.is_group === 'number'
          ? matchedChat.is_group !== 0
          : null,
    });
  }

  private rememberLastInboundObservation(
    chatJid: string,
    timestamp: string,
    isSelfAuthored: boolean,
  ): void {
    this.lastInboundObservedAt = timestamp;
    this.lastInboundChatJid = chatJid;
    this.lastInboundWasSelfAuthored = isSelfAuthored;
    this.monitorState.lastInboundObservedAt = timestamp;
    this.monitorState.lastInboundChatJid = chatJid;
    this.monitorState.lastInboundWasSelfAuthored = isSelfAuthored;
  }

  private rememberLastOutboundObservation(
    chatJid: string,
    timestamp: string,
  ): void {
    this.lastOutboundResult = `${timestamp} (${chatJid})`;
    this.monitorState.lastOutboundObservedAt = timestamp;
    this.monitorState.lastOutboundObservedChatJid = chatJid;
  }

  private syncRuntimeStateToMonitor(): void {
    this.monitorState.lastInboundObservedAt = this.lastInboundObservedAt;
    this.monitorState.lastInboundChatJid = this.lastInboundChatJid;
    this.monitorState.lastInboundWasSelfAuthored = this.lastInboundChatJid
      ? this.lastInboundWasSelfAuthored
      : null;
    this.monitorState.lastOutboundTargetKind = this.lastOutboundTargetKind;
    this.monitorState.lastOutboundTargetValue = this.lastOutboundTargetValue;
    this.monitorState.lastSendErrorDetail = this.lastSendErrorDetail;
    this.monitorState.lastMetadataHydrationSource =
      this.lastMetadataHydrationSource === 'none'
        ? null
        : this.lastMetadataHydrationSource;
    this.monitorState.lastAttemptedTargetSequence = [
      ...this.lastAttemptedTargetSequence,
    ];
  }

  private noteRecentEvidence(
    kind: BlueBubblesEvidenceKind,
    chatJid: string,
    signature: string,
    observedAt: string,
  ): void {
    const observedAtMs = Date.parse(observedAt);
    if (
      !Number.isFinite(observedAtMs) ||
      Date.now() - observedAtMs > BLUEBUBBLES_EVIDENCE_WINDOW_MS
    ) {
      return;
    }
    if (
      this.monitorState.recentEvidence.some(
        (entry) => entry.kind === kind && entry.signature === signature,
      )
    ) {
      return;
    }
    this.monitorState.recentEvidence.push({
      kind,
      chatJid,
      signature,
      observedAt,
    });
  }

  private getShadowPollCandidateChatJids(limit = 8): string[] {
    const candidates = new Set<string>();
    const push = (chatJid: string | null | undefined): void => {
      if (!chatJid || !chatJid.startsWith('bb:')) {
        return;
      }
      for (const expanded of expandBlueBubblesLogicalSelfThreadJids(chatJid)) {
        candidates.add(expanded);
      }
      if (!expandBlueBubblesLogicalSelfThreadJids(chatJid).length) {
        candidates.add(chatJid);
      }
    };

    push(getBlueBubblesCanonicalSelfThreadJid());
    push(this.lastInboundChatJid);
    push(this.monitorState.lastInboundChatJid);
    push(this.monitorState.lastOutboundObservedChatJid);
    push(this.monitorState.mostRecentWebhookObservedChatJid);
    push(this.monitorState.mostRecentServerSeenChatJid);
    push(this.monitorState.lastIgnoredChatJid);

    for (const chat of getAllChats()) {
      if (!chat.jid.startsWith('bb:')) continue;
      push(chat.jid);
      if (candidates.size >= limit) {
        break;
      }
    }

    return [...candidates].slice(0, limit);
  }

  private cacheDirectChatMetadata(
    metadata: BlueBubblesDirectChatMetadata,
  ): boolean {
    if (metadata.isGroup) {
      this.directChatMetadataByJid.delete(metadata.chatJid);
      return false;
    }

    const previous = this.directChatMetadataByJid.get(metadata.chatJid);
    const next: BlueBubblesDirectChatMetadata = {
      chatJid: metadata.chatJid,
      chatGuid: metadata.chatGuid || previous?.chatGuid || metadata.chatJid,
      isGroup: metadata.isGroup,
      chatIdentifier:
        metadata.chatIdentifier || previous?.chatIdentifier || null,
      lastAddressedHandle:
        metadata.lastAddressedHandle || previous?.lastAddressedHandle || null,
      handleAddress: metadata.handleAddress || previous?.handleAddress || null,
      service: metadata.service || previous?.service || null,
      lastObservedAt:
        metadata.lastObservedAt || previous?.lastObservedAt || null,
      lastObservedWasSelfAuthored:
        metadata.lastObservedAt != null
          ? metadata.lastObservedWasSelfAuthored
          : previous?.lastObservedWasSelfAuthored || false,
    };
    const changed =
      !previous ||
      previous.chatGuid !== next.chatGuid ||
      previous.chatIdentifier !== next.chatIdentifier ||
      previous.lastAddressedHandle !== next.lastAddressedHandle ||
      previous.handleAddress !== next.handleAddress ||
      previous.service !== next.service ||
      previous.lastObservedAt !== next.lastObservedAt ||
      previous.lastObservedWasSelfAuthored !== next.lastObservedWasSelfAuthored;
    this.directChatMetadataByJid.set(metadata.chatJid, next);
    return changed;
  }

  private rememberObservedChatMetadata(input: {
    chatJid: string;
    chat: BlueBubblesChatRef;
    contact: BlueBubblesContactRef;
    message: Pick<NewMessage, 'is_from_me' | 'timestamp'>;
  }): void {
    this.rememberLastInboundObservation(
      input.chatJid,
      input.message.timestamp,
      Boolean(input.message.is_from_me),
    );

    const isGroup = inferBlueBubblesGroupChat(
      input.chat.chatGuid,
      input.chat.isGroup,
    );
    if (isGroup) {
      this.directChatMetadataByJid.delete(input.chatJid);
      return;
    }

    this.cacheDirectChatMetadata(this.buildDirectChatMetadata(input));
  }

  private getDirectChatMetadata(
    chatJid: string,
    chatGuid: string,
  ): BlueBubblesDirectChatMetadata {
    const cached = this.directChatMetadataByJid.get(chatJid);
    if (cached) {
      return cached;
    }
    const inferredIdentifier =
      normalizeBlueBubblesDirectTargetValue(
        chatGuid.split(';').slice(2).join(';'),
      ) || null;
    return {
      chatJid,
      chatGuid,
      isGroup: inferBlueBubblesGroupChat(chatGuid),
      chatIdentifier: inferredIdentifier,
      lastAddressedHandle: null,
      handleAddress: inferredIdentifier,
      service: extractBlueBubblesServiceFromChatGuid(chatGuid),
      lastObservedAt: null,
      lastObservedWasSelfAuthored: false,
    };
  }

  private async hydrateDirectChatMetadataFromHistory(
    chatJid: string,
    chatGuid: string,
    limit = 3,
  ): Promise<boolean> {
    const current = this.getDirectChatMetadata(chatJid, chatGuid);
    if (current.isGroup) {
      return false;
    }

    const activeBaseUrl = await this.ensureActiveBaseUrl();
    if (!activeBaseUrl) {
      return false;
    }

    const rows = await fetchNormalizedBlueBubblesHistoryRows(
      this.buildConfigForBaseUrl(activeBaseUrl),
      chatGuid,
      limit,
    );
    if (rows.length === 0) {
      return false;
    }

    this.lastMetadataHydrationSource = 'history';
    let changed = false;
    for (const row of rows) {
      if (row.chatJid !== chatJid) continue;
      changed =
        this.cacheDirectChatMetadata(this.buildDirectChatMetadata(row)) ||
        changed;
    }
    return changed;
  }

  private buildOutboundTargetCandidates(
    chatJid: string,
    chatGuid: string,
  ): BlueBubblesOutboundTargetCandidate[] {
    const candidates: BlueBubblesOutboundTargetCandidate[] = [];
    const seen = new Set<string>();
    const push = (
      kind: BlueBubblesOutboundTargetCandidate['kind'],
      targetChatGuid: string | null | undefined,
    ): void => {
      const normalized = normalizeBlueBubblesDirectTargetValue(targetChatGuid);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      candidates.push({ kind, chatGuid: normalized });
    };

    const metadata = this.getDirectChatMetadata(chatJid, chatGuid);
    const preferActiveChatGuid = metadata.lastObservedWasSelfAuthored;
    const cached = this.successfulOutboundTargetByJid.get(chatJid);

    if (!preferActiveChatGuid && cached) {
      push(cached.kind, cached.chatGuid);
    }

    push('chat_guid', chatGuid);

    if (preferActiveChatGuid && cached) {
      push(cached.kind, cached.chatGuid);
    }

    if (metadata.isGroup) {
      return candidates;
    }

    push(
      'last_addressed_handle',
      buildBlueBubblesDirectTargetGuid('any', metadata.lastAddressedHandle),
    );
    push(
      'service_specific_last_addressed_handle',
      metadata.service
        ? buildBlueBubblesDirectTargetGuid(
            metadata.service,
            metadata.lastAddressedHandle,
          )
        : null,
    );
    push(
      'chat_identifier',
      buildBlueBubblesDirectTargetGuid('any', metadata.chatIdentifier),
    );
    push(
      'handle_address',
      buildBlueBubblesDirectTargetGuid('any', metadata.handleAddress),
    );
    push(
      'service_specific_direct',
      metadata.service
        ? buildBlueBubblesDirectTargetGuid(
            metadata.service,
            metadata.handleAddress || metadata.chatIdentifier,
          )
        : null,
    );

    return candidates;
  }

  private updateLastOutboundAttempt(
    candidate: BlueBubblesOutboundTargetCandidate,
  ): void {
    this.lastOutboundTargetKind = candidate.kind;
    this.lastOutboundTargetValue = candidate.chatGuid;
    this.monitorState.lastOutboundTargetKind = candidate.kind;
    this.monitorState.lastOutboundTargetValue = candidate.chatGuid;
  }

  private buildBlueBubblesSendFailureMessage(
    attemptedTargets: BlueBubblesOutboundTargetCandidate[],
    errorText: string,
  ): string {
    const attemptedKinds = attemptedTargets.map((candidate) => candidate.kind);
    if (attemptedKinds.length === 0) {
      return errorText;
    }
    return `BlueBubbles send failed after targets [${attemptedKinds.join(', ')}]: ${errorText}`;
  }

  private isRetryableDirectTargetError(errorText: string): boolean {
    return /message send error/i.test(errorText);
  }

  private persistMonitorState(): void {
    this.syncRuntimeStateToMonitor();
    this.monitorState.updatedAt = new Date().toISOString();
    writeBlueBubblesMonitorState(this.monitorState);
  }

  private pruneRecentEvidence(nowMs = Date.now()): void {
    this.monitorState.recentEvidence = this.monitorState.recentEvidence.filter(
      (entry) => {
        const parsed = Date.parse(entry.observedAt);
        return (
          Number.isFinite(parsed) &&
          nowMs - parsed <= BLUEBUBBLES_EVIDENCE_WINDOW_MS
        );
      },
    );
  }

  private setDetectionState(
    state: BlueBubblesDetectionState,
    detail: string | null,
    nextAction: string | null,
  ): void {
    this.monitorState.detectionState = state;
    this.monitorState.detectionDetail = detail;
    this.monitorState.detectionNextAction = nextAction;
  }

  private noteWebhookObserved(chatJid: string, timestamp: string): void {
    const previous = this.monitorState.perChatWebhookObserved[chatJid];
    if (!previous || previous < timestamp) {
      this.monitorState.perChatWebhookObserved[chatJid] = timestamp;
    }
    this.monitorState.recentEvidence = this.monitorState.recentEvidence.filter(
      (entry) =>
        !(
          entry.kind === 'missed_inbound' &&
          entry.chatJid === chatJid &&
          entry.observedAt <= timestamp
        ),
    );
    if (
      !this.monitorState.mostRecentWebhookObservedAt ||
      this.monitorState.mostRecentWebhookObservedAt < timestamp
    ) {
      this.monitorState.mostRecentWebhookObservedAt = timestamp;
      this.monitorState.mostRecentWebhookObservedChatJid = chatJid;
    }
    if (this.monitorState.lastIgnoredChatJid === chatJid) {
      this.monitorState.lastIgnoredAt = null;
      this.monitorState.lastIgnoredChatJid = null;
      this.monitorState.lastIgnoredReason = null;
    }
    if (
      (this.monitorState.detectionState === 'suspected_missed_inbound' ||
        this.monitorState.detectionState === 'mixed_degraded') &&
      this.monitorState.mostRecentServerSeenChatJid === chatJid &&
      (!this.monitorState.mostRecentServerSeenAt ||
        this.monitorState.mostRecentServerSeenAt <= timestamp) &&
      !this.monitorState.recentEvidence.some(
        (entry) => entry.kind === 'missed_inbound',
      )
    ) {
      const hasReplyFailure = this.monitorState.recentEvidence.some(
        (entry) => entry.kind === 'reply_delivery_failed',
      );
      this.setDetectionState(
        hasReplyFailure ? 'reply_delivery_broken' : 'healthy',
        hasReplyFailure
          ? 'Webhook freshness caught up, but a recent reply-back attempt still failed from Andrea.'
          : null,
        hasReplyFailure
          ? 'Inspect the BlueBubbles reply target and send method on this host, then retry the same thread.'
          : null,
      );
    }
    this.persistMonitorState();
  }

  private pruneRecentIngressFingerprints(nowMs = Date.now()): void {
    for (const [
      fingerprint,
      observations,
    ] of this.recentIngressFingerprints.entries()) {
      const current = observations.filter(
        (observation) =>
          nowMs - observation.observedAtMs <=
          BLUEBUBBLES_INGRESS_FINGERPRINT_WINDOW_MS,
      );
      if (current.length === 0) {
        this.recentIngressFingerprints.delete(fingerprint);
      } else if (current.length !== observations.length) {
        this.recentIngressFingerprints.set(fingerprint, current);
      }
    }
  }

  private hasRecentIngressFingerprint(
    chatJid: string,
    message: Pick<
      NewMessage,
      'content' | 'timestamp' | 'sender' | 'is_from_me'
    >,
  ): boolean {
    this.pruneRecentIngressFingerprints();
    const observations = this.recentIngressFingerprints.get(
      buildBlueBubblesIngressFingerprint({ chatJid, message }),
    );
    if (!observations) return false;
    const messageTimestampMs = Date.parse(message.timestamp);
    return (
      Number.isFinite(messageTimestampMs) &&
      observations.some(
        (observation) =>
          Math.abs(observation.messageTimestampMs - messageTimestampMs) <=
          BLUEBUBBLES_MIRRORED_MESSAGE_TIMESTAMP_TOLERANCE_MS,
      )
    );
  }

  private noteIngressFingerprint(
    chatJid: string,
    message: Pick<
      NewMessage,
      'content' | 'timestamp' | 'sender' | 'is_from_me'
    >,
  ): void {
    this.pruneRecentIngressFingerprints();
    const messageTimestampMs = Date.parse(message.timestamp);
    if (!Number.isFinite(messageTimestampMs)) return;
    const fingerprint = buildBlueBubblesIngressFingerprint({
      chatJid,
      message,
    });
    this.recentIngressFingerprints.set(fingerprint, [
      ...(this.recentIngressFingerprints.get(fingerprint) || []),
      {
        observedAtMs: Date.now(),
        messageTimestampMs,
      },
    ]);
  }

  private noteIgnoredWebhook(
    chatJid: string,
    at: string,
    reason: 'mention_required' | 'chat_scope',
    isGroup?: boolean | null,
  ): void {
    this.monitorState.lastIgnoredAt = at;
    this.monitorState.lastIgnoredChatJid = chatJid;
    this.monitorState.lastIgnoredReason = reason;
    const ignoredDirectChat = reason === 'mention_required' && !isGroup;
    this.setDetectionState(
      'ignored_by_gate_or_scope',
      reason === 'mention_required'
        ? ignoredDirectChat
          ? `Andrea saw a Messages turn in ${chatJid}, but it was intentionally ignored because that direct 1:1 chat does not have fresh Andrea context yet and still needs @Andrea.`
          : `Andrea saw a Messages turn in ${chatJid}, but it was intentionally ignored because that group thread still needs @Andrea for a fresh Andrea-directed turn.`
        : `Andrea saw a Messages turn in ${chatJid}, but it was intentionally ignored because that chat is outside the configured scope.`,
      reason === 'mention_required'
        ? ignoredDirectChat
          ? `Use @Andrea once in that direct 1:1 chat to re-establish Andrea context. After Andrea replies there, bare follow-ups stay available in that same thread for about ${formatBlueBubblesDirectContextWindow()}.`
          : 'Use @Andrea in that group thread to open the next action, then keep follow-ups in the same thread.'
        : 'Use a chat that is inside the configured Messages scope, or widen the BlueBubbles scope on this host.',
    );
    this.persistMonitorState();
  }

  private noteReplySendFailure(chatJid: string, errorText: string): void {
    const observedAt = new Date().toISOString();
    this.monitorState.lastReplySendFailureAt = observedAt;
    this.monitorState.lastReplySendFailureChatJid = chatJid;
    this.monitorState.lastReplySendFailureStage =
      this.lastOutboundTargetKind || 'reply_send';
    const signature = [
      'reply',
      chatJid,
      this.lastOutboundTargetKind || 'none',
      errorText,
    ].join(':');
    if (
      !this.monitorState.recentEvidence.some(
        (entry) =>
          entry.kind === 'reply_delivery_failed' &&
          entry.signature === signature,
      )
    ) {
      this.monitorState.recentEvidence.push({
        kind: 'reply_delivery_failed',
        chatJid,
        signature,
        observedAt,
      });
    }
    this.pruneRecentEvidence(Date.parse(observedAt));
    this.persistMonitorState();
  }

  private async maybeEscalateCrossSurfaceFallback(): Promise<void> {
    const recentQualifyingEvidence = this.monitorState.recentEvidence.filter(
      (entry) =>
        entry.kind === 'missed_inbound' ||
        entry.kind === 'reply_delivery_failed' ||
        entry.kind === 'transport_unreachable' ||
        entry.kind === 'shadow_poll_unstable',
    );
    const nowMs = Date.now();
    const lastSentMs = this.monitorState.crossSurfaceFallbackLastSentAt
      ? Date.parse(this.monitorState.crossSurfaceFallbackLastSentAt)
      : NaN;
    const inCooldown =
      Number.isFinite(lastSentMs) &&
      nowMs - lastSentMs < BLUEBUBBLES_FALLBACK_COOLDOWN_MS;

    if (recentQualifyingEvidence.length === 0) {
      this.monitorState.crossSurfaceFallbackState = 'idle';
      this.persistMonitorState();
      return;
    }

    if (inCooldown) {
      this.monitorState.crossSurfaceFallbackState = 'cooldown';
      this.persistMonitorState();
      return;
    }

    if (
      recentQualifyingEvidence.length <
        BLUEBUBBLES_FALLBACK_EVIDENCE_THRESHOLD ||
      !this.opts.onCrossSurfaceFallback
    ) {
      this.monitorState.crossSurfaceFallbackState = 'armed';
      this.persistMonitorState();
      return;
    }

    const detail =
      this.monitorState.detectionDetail ||
      'Messages looks unreliable right now, so use Telegram for the moment.';
    const result = await this.opts.onCrossSurfaceFallback({
      sourceChannel: 'bluebubbles',
      detail,
      chatJid:
        this.monitorState.mostRecentServerSeenChatJid ||
        this.monitorState.lastReplySendFailureChatJid ||
        null,
    });
    if (result.sent) {
      this.monitorState.crossSurfaceFallbackState = 'sent';
      this.monitorState.crossSurfaceFallbackLastSentAt =
        new Date().toISOString();
      this.monitorState.crossSurfaceFallbackLastDetail = result.detail;
    } else {
      this.monitorState.crossSurfaceFallbackState = 'armed';
      this.monitorState.crossSurfaceFallbackLastDetail = result.detail;
    }
    this.persistMonitorState();
  }

  private async runShadowMonitorOnce(): Promise<void> {
    const nowMs = Date.now();
    this.pruneRecentEvidence(nowMs);
    try {
      const activeBaseUrl = await this.ensureActiveBaseUrl({
        recheck: true,
        refreshReadiness: true,
      });
      if (!activeBaseUrl) {
        throw new Error(
          this.transportProbeDetail ||
            'Andrea could not reach any configured BlueBubbles endpoint.',
        );
      }
      const recentMessages = await this.bridgeProvider.inspectRecentActivity(
        this.buildConfigForBaseUrl(activeBaseUrl),
        {
          limit: 8,
          candidateChatJids: this.getShadowPollCandidateChatJids(),
        },
      );
      this.monitorState.shadowPollLastOkAt = new Date(nowMs).toISOString();
      this.monitorState.shadowPollLastError = null;
      this.monitorState.activeBaseUrl = activeBaseUrl;
      const newest = recentMessages[recentMessages.length - 1] || null;
      if (newest) {
        this.monitorState.shadowPollMostRecentChat = newest.chatJid;
        this.monitorState.mostRecentServerSeenChatJid = newest.chatJid;
        this.monitorState.mostRecentServerSeenAt = newest.message.timestamp;
        this.monitorState.mostRecentServerSeenMessageId = newest.message.id;
      }

      let latestIgnored: {
        chatJid: string;
        at: string;
        reason: 'mention_required' | 'chat_scope';
        isGroup: boolean;
      } | null = null;
      let latestMissed: {
        chatJid: string;
        at: string;
        id: string;
        reason: string;
        nextAction: string;
      } | null = null;

      for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
        const row = recentMessages[index]!;
        const previous = this.monitorState.perChatServerSeen[row.chatJid];
        if (!previous || previous < row.message.timestamp) {
          this.monitorState.perChatServerSeen[row.chatJid] =
            row.message.timestamp;
        }

        const eligible = isBlueBubblesChatEligible(
          this.config,
          row.chat.chatGuid,
          row.chat.isGroup,
        );
        const mentionsAndrea = hasBlueBubblesAndreaMention(row.message.content);
        if (row.message.is_from_me && !mentionsAndrea) {
          continue;
        }
        const ignoredReason = !eligible ? 'chat_scope' : null;
        if (ignoredReason) {
          if (!latestIgnored || latestIgnored.at < row.message.timestamp) {
            latestIgnored = {
              chatJid: row.chatJid,
              at: row.message.timestamp,
              reason: ignoredReason,
              isGroup: Boolean(row.chat.isGroup),
            };
          }
          continue;
        }

        const observedAt =
          this.monitorState.perChatWebhookObserved[row.chatJid];
        const observed =
          (observedAt && observedAt >= row.message.timestamp) ||
          hasStoredMessage(row.chatJid, row.message.id);
        const ageMs = nowMs - Date.parse(row.message.timestamp);
        const inEvidenceWindow = ageMs <= BLUEBUBBLES_EVIDENCE_WINDOW_MS;
        if (
          !observed &&
          Number.isFinite(ageMs) &&
          ageMs >= BLUEBUBBLES_MISSED_INBOUND_GRACE_MS &&
          inEvidenceWindow
        ) {
          if (!latestMissed) {
            latestMissed = {
              chatJid: row.chatJid,
              at: row.message.timestamp,
              id: row.message.id,
              reason: row.chat.isGroup
                ? `BlueBubbles server saw newer group-chat activity in ${row.chatJid}, but Andrea has not observed that inbound on the webhook side yet.`
                : `BlueBubbles server saw newer 1:1 chat activity in ${row.chatJid}, but Andrea has not observed that inbound on the webhook side yet.`,
              nextAction:
                'Check the Mac-side BlueBubbles webhook target and whether this Windows listener is reachable from the Mac, then repro the same text thread.',
            };
          }
          this.noteRecentEvidence(
            'missed_inbound',
            row.chatJid,
            row.message.id,
            row.message.timestamp,
          );
        }
      }

      const hasRecentReplyFailure = this.monitorState.recentEvidence.some(
        (entry) => entry.kind === 'reply_delivery_failed',
      );

      if (latestMissed && hasRecentReplyFailure) {
        this.setDetectionState(
          'mixed_degraded',
          `${latestMissed.reason} A recent reply-back attempt also failed from Andrea.`,
          latestMissed.nextAction,
        );
      } else if (latestMissed) {
        this.setDetectionState(
          'suspected_missed_inbound',
          latestMissed.reason,
          latestMissed.nextAction,
        );
      } else if (hasRecentReplyFailure) {
        const chatLabel =
          this.monitorState.lastReplySendFailureChatJid || 'that same chat';
        this.setDetectionState(
          'reply_delivery_broken',
          `Andrea observed a Messages turn in ${chatLabel}, but reply delivery failed before anything came back to the thread.`,
          'Inspect the BlueBubbles reply target and send method on this host, then retry the same thread.',
        );
      } else if (latestIgnored) {
        const ignoredDirectChat =
          latestIgnored.reason === 'mention_required' && !latestIgnored.isGroup;
        this.setDetectionState(
          'ignored_by_gate_or_scope',
          latestIgnored.reason === 'mention_required'
            ? ignoredDirectChat
              ? `The newest Messages turn in ${latestIgnored.chatJid} would still be ignored until that direct 1:1 chat gets a fresh Andrea-directed turn or recent Andrea context.`
              : `The newest Messages turn in ${latestIgnored.chatJid} would still be ignored until it includes @Andrea.`
            : `The newest Messages turn in ${latestIgnored.chatJid} is outside Andrea's configured BlueBubbles scope.`,
          latestIgnored.reason === 'mention_required'
            ? ignoredDirectChat
              ? `Use @Andrea once in that direct 1:1 chat. After Andrea replies there, bare follow-ups stay available in that same thread for about ${formatBlueBubblesDirectContextWindow()}.`
              : 'Use @Andrea in that group thread to open the next action, then keep follow-ups in the same thread.'
            : 'Use a chat inside the configured scope, or widen the BlueBubbles scope on this host.',
        );
      } else {
        this.setDetectionState('healthy', null, null);
      }

      await this.maybeEscalateCrossSurfaceFallback();
      this.persistMonitorState();
    } catch (error) {
      const errorText =
        error instanceof Error
          ? error.message
          : 'BlueBubbles shadow poll failed';
      const nowIso = new Date(nowMs).toISOString();
      try {
        await this.probeBlueBubblesTransport();
        await this.refreshBridgeReadiness();
      } catch (probeError) {
        logger.warn(
          { err: probeError },
          'BlueBubbles transport reprobe failed after shadow poll error',
        );
      }

      this.monitorState.shadowPollLastError = errorText;
      const transportReachable = this.transportProbeStatus === 'reachable';
      const webhookReady = this.webhookRegistrationStatus === 'registered';
      if (transportReachable && webhookReady) {
        this.noteRecentEvidence(
          'shadow_poll_unstable',
          'bluebubbles:shadow-poll',
          `${this.getActiveBaseUrl() || 'none'}:${errorText}`,
          nowIso,
        );
        this.setDetectionState(
          'mixed_degraded',
          `Andrea can reach the BlueBubbles bridge from this PC, but the recent-activity shadow poll failed (${errorText}), so the same-thread health check is not trustworthy yet.`,
          'Check the BlueBubbles recent-message shadow poll for this Windows host, then retry the same 1:1 Messages thread.',
        );
      } else {
        const detail =
          this.transportProbeDetail ||
          `Andrea could not read recent BlueBubbles server activity because the shadow poll failed (${errorText}).`;
        this.noteRecentEvidence(
          'transport_unreachable',
          'bluebubbles:transport',
          `${this.getActiveBaseUrl() || 'none'}:${nowIso}`,
          nowIso,
        );
        this.setDetectionState(
          'transport_unreachable',
          `Andrea could not reach the BlueBubbles server from this host, so Messages may be missing inbound texts before Andrea ever sees them. ${detail}`,
          'Check the BlueBubbles server endpoint for this Windows host, prefer a stable IP or explicit candidate list over a .local hostname, then retry the same 1:1 Messages thread.',
        );
      }
      await this.maybeEscalateCrossSurfaceFallback();
      if (this.monitorState.crossSurfaceFallbackState === 'idle') {
        this.monitorState.crossSurfaceFallbackState = 'armed';
      }
      this.persistMonitorState();
    }
    this.emitHealth();
  }

  private startShadowMonitor(): void {
    this.stopShadowMonitor();
    this.shadowPollTimer = setInterval(() => {
      this.runShadowMonitorOnce().catch((error) => {
        logger.warn(
          { err: error },
          'BlueBubbles shadow monitor iteration failed',
        );
      });
    }, BLUEBUBBLES_SHADOW_POLL_INTERVAL_MS);
  }

  private stopShadowMonitor(): void {
    if (this.shadowPollTimer) {
      clearInterval(this.shadowPollTimer);
      this.shadowPollTimer = null;
    }
  }

  private emitHealth(overrides: Partial<ChannelHealthSnapshot> = {}): void {
    const configured = isBlueBubblesRoutingConfigured(this.config);
    const readyForTraffic =
      configured &&
      this.config.sendEnabled &&
      this.transportProbeStatus === 'reachable' &&
      this.webhookRegistrationStatus === 'registered';
    const healthChatJid = this.getRepresentativeHealthChatJid();
    const matchedHealthChat = healthChatJid
      ? getAllChats().find((chat) => chat.jid === healthChatJid)
      : null;
    const healthReplyGateMode = this.getHealthReplyGateMode();
    const healthConversationModeDetail =
      healthReplyGateMode === 'direct_1to1'
        ? 'conversation mode 1:1 conversational now'
        : matchedHealthChat && typeof matchedHealthChat.is_group === 'number'
          ? matchedHealthChat.is_group !== 0
            ? 'conversation mode group explicit @Andrea'
            : 'conversation mode direct 1:1 needs fresh @Andrea context'
          : 'conversation mode explicit-only until fresh Andrea context exists';
    const lastInboundObservedAt =
      this.lastInboundObservedAt || this.monitorState.lastInboundObservedAt;
    const lastInboundChatJid =
      this.lastInboundChatJid || this.monitorState.lastInboundChatJid;
    const lastInboundWasSelfAuthored =
      lastInboundChatJid != null
        ? this.lastInboundChatJid
          ? this.lastInboundWasSelfAuthored
          : Boolean(this.monitorState.lastInboundWasSelfAuthored)
        : false;
    const lastOutboundResult =
      this.lastOutboundResult ||
      (this.monitorState.lastOutboundObservedAt &&
      this.monitorState.lastOutboundObservedChatJid
        ? `${this.monitorState.lastOutboundObservedAt} (${this.monitorState.lastOutboundObservedChatJid})`
        : null);
    const lastOutboundTargetKind =
      this.lastOutboundTargetKind || this.monitorState.lastOutboundTargetKind;
    const lastOutboundTargetValue =
      this.lastOutboundTargetValue || this.monitorState.lastOutboundTargetValue;
    const lastSendErrorDetail =
      this.lastSendErrorDetail || this.monitorState.lastSendErrorDetail;
    const lastMetadataHydrationSource =
      this.lastMetadataHydrationSource !== 'none'
        ? this.lastMetadataHydrationSource
        : this.monitorState.lastMetadataHydrationSource || 'none';
    const attemptedTargetSequence =
      this.lastAttemptedTargetSequence.length > 0
        ? this.lastAttemptedTargetSequence
        : this.monitorState.lastAttemptedTargetSequence;
    const detailParts = [
      this.connected
        ? `listener ${this.config.host}:${this.activePort}${this.config.webhookPath}`
        : 'listener stopped',
      `provider ${this.appleMessagesProvider}`,
      `configured base url ${this.config.baseUrl || 'none'}`,
      `active endpoint ${this.monitorState.activeBaseUrl || 'none'}`,
      `candidate endpoints ${
        this.getConfiguredBaseUrlCandidates().length > 0
          ? this.getConfiguredBaseUrlCandidates().join(', ')
          : 'none'
      }`,
      `candidate probe results ${summarizeBlueBubblesCandidateProbeResults(
        this.monitorState.candidateProbeResults,
      )}`,
      `scope ${this.config.chatScope}`,
      `reply gate ${healthReplyGateMode}`,
      healthConversationModeDetail,
      `webhook ${this.getPublicWebhookDisplayUrl()}`,
      this.webhookRegistrationDetail
        ? `webhook registration ${this.webhookRegistrationDetail}`
        : 'webhook registration not checked yet',
      `webhook registration state ${this.webhookRegistrationStatus}`,
      `transport probe state ${this.transportProbeStatus}`,
      this.transportProbeDetail
        ? `transport ${this.transportProbeDetail}`
        : 'transport not checked yet',
      lastInboundObservedAt
        ? `last inbound ${lastInboundObservedAt}`
        : 'no inbound observed yet',
      `last inbound chat ${lastInboundChatJid || 'none'}`,
      `last inbound self_authored ${lastInboundWasSelfAuthored ? 'yes' : 'no'}`,
      lastOutboundResult
        ? `last outbound ${lastOutboundResult}`
        : this.config.sendEnabled
          ? 'no outbound sent yet'
          : 'outbound disabled',
      `last outbound target kind ${lastOutboundTargetKind || 'none'}`,
      `last outbound target value ${lastOutboundTargetValue || 'none'}`,
      `last send error ${lastSendErrorDetail || 'none'}`,
      `send method ${this.sendMethod}`,
      `private api available ${
        this.privateApiAvailable == null
          ? 'unknown'
          : this.privateApiAvailable
            ? 'yes'
            : 'no'
      }`,
      `last metadata hydration ${lastMetadataHydrationSource}`,
      `attempted target sequence ${
        attemptedTargetSequence.length > 0
          ? attemptedTargetSequence.join(' -> ')
          : 'none'
      }`,
      `detection ${this.monitorState.detectionState}`,
      `detection detail ${this.monitorState.detectionDetail || 'none'}`,
      `detection next action ${this.monitorState.detectionNextAction || 'none'}`,
      `shadow poll last ok ${this.monitorState.shadowPollLastOkAt || 'none'}`,
      `shadow poll error ${this.monitorState.shadowPollLastError || 'none'}`,
      `server seen chat ${this.monitorState.mostRecentServerSeenChatJid || 'none'}`,
      `server seen at ${this.monitorState.mostRecentServerSeenAt || 'none'}`,
      `fallback ${this.monitorState.crossSurfaceFallbackState}`,
      `fallback last sent ${this.monitorState.crossSurfaceFallbackLastSentAt || 'none'}`,
    ];
    this.opts.onHealthUpdate?.(
      buildBlueBubblesHealthSnapshot(this.config, {
        state: !this.config.enabled
          ? 'stopped'
          : this.connected && readyForTraffic
            ? 'ready'
            : this.connected
              ? 'degraded'
              : 'starting',
        updatedAt: new Date().toISOString(),
        lastReadyAt: this.lastReadyAt,
        lastError: this.lastErrorText,
        detail: detailParts.join(' | '),
        ...overrides,
      }),
    );
  }

  private isReadyForTraffic(): boolean {
    return Boolean(
      this.connected &&
      this.config.enabled &&
      isBlueBubblesRoutingConfigured(this.config) &&
      this.config.sendEnabled,
    );
  }

  private async probeBlueBubblesTransport(): Promise<void> {
    const probe = await this.bridgeProvider.probe(this.config);
    this.monitorState.candidateProbeResults = probe.candidateResults;

    if (probe.status === 'not_configured') {
      this.transportProbeStatus = 'not_checked';
      this.transportProbeDetail = probe.detail;
      this.monitorState.activeBaseUrl = null;
      return;
    }

    if (probe.status === 'reachable') {
      this.transportProbeStatus = 'reachable';
      this.transportProbeDetail = probe.detail;
      this.monitorState.activeBaseUrl = probe.activeEndpoint;
      return;
    }

    if (probe.status === 'auth_failed') {
      this.transportProbeStatus = 'auth_failed';
      this.transportProbeDetail = probe.detail;
      this.monitorState.activeBaseUrl = probe.activeEndpoint;
      return;
    }

    this.transportProbeStatus = 'unreachable';
    this.transportProbeDetail = probe.detail;
    this.monitorState.activeBaseUrl = null;
  }

  private verifyWebhookSecret(reqUrl: URL): boolean {
    if (!this.config.webhookSecret) {
      return true;
    }
    const incoming =
      reqUrl.searchParams.get('secret') ||
      reqUrl.searchParams.get('token') ||
      reqUrl.searchParams.get('guid');
    return incoming === this.config.webhookSecret;
  }

  private async handleWebhookRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const reqUrl = new URL(
      req.url || this.config.webhookPath,
      `http://${req.headers.host || `${this.config.host}:${this.activePort}`}`,
    );
    if (req.method !== 'POST') {
      writeResponse(res, 405, 'Method Not Allowed');
      return;
    }
    if (reqUrl.pathname !== this.config.webhookPath) {
      writeResponse(res, 404, 'Not Found');
      return;
    }
    if (!this.verifyWebhookSecret(reqUrl)) {
      this.lastErrorText = 'BlueBubbles webhook secret mismatch';
      this.emitHealth({ state: 'degraded' });
      writeResponse(res, 401, 'Unauthorized');
      return;
    }
    if (!this.isReadyForTraffic()) {
      writeResponse(res, 503, 'BlueBubbles channel is not ready');
      return;
    }
    if (
      !String(req.headers['content-type'] || '').includes('application/json')
    ) {
      writeResponse(res, 400, 'BlueBubbles webhook requires application/json');
      return;
    }

    const rawBody = await readRequestBody(req);
    const payload = parseBlueBubblesJson(rawBody);
    if (!payload) {
      writeResponse(res, 400, 'Invalid JSON');
      return;
    }

    const event = normalizeBlueBubblesWebhookEvent(payload);
    if (!/new.?message/i.test(event.type) && event.type !== 'message.new') {
      writeResponse(res, 202, 'Ignored event');
      return;
    }

    const normalized = normalizeBlueBubblesIncomingMessage(payload);
    if (!normalized) {
      writeResponse(res, 400, 'Malformed BlueBubbles message payload');
      return;
    }
    if (
      !isBlueBubblesChatEligible(
        this.config,
        normalized.chat.chatGuid,
        normalized.chat.isGroup,
      )
    ) {
      logger.info(
        {
          chatScope: this.config.chatScope,
          receivedChatGuid: normalized.chat.chatGuid,
        },
        'Ignoring BlueBubbles message outside the configured chat scope',
      );
      this.noteIgnoredWebhook(
        normalized.chatJid,
        normalized.message.timestamp,
        'chat_scope',
      );
      writeResponse(res, 202, 'Ignored chat outside configured scope');
      return;
    }
    const replyGateMode = this.getReplyGateModeForChat({
      chatJid: normalized.chatJid,
      isGroup: normalized.chat.isGroup,
    });
    if (
      normalized.message.is_from_me &&
      isBlueBubblesAndreaBotEcho(normalized.message.content)
    ) {
      writeResponse(res, 202, 'Ignored Andrea outbound echo');
      return;
    }
    if (
      normalized.message.is_from_me &&
      replyGateMode === 'mention_required' &&
      !hasBlueBubblesAndreaMention(normalized.message.content)
    ) {
      this.noteIgnoredWebhook(
        normalized.chatJid,
        normalized.message.timestamp,
        'mention_required',
        normalized.chat.isGroup,
      );
      writeResponse(
        res,
        202,
        `Ignored outgoing message without @Andrea mention. Use @Andrea once in this direct chat; after Andrea replies, bare follow-ups are accepted here for about ${formatBlueBubblesDirectContextWindow()}.`,
      );
      return;
    }
    if (
      this.inflightMessageIds.has(normalized.message.id) ||
      hasStoredMessage(normalized.chatJid, normalized.message.id) ||
      this.hasRecentIngressFingerprint(normalized.chatJid, normalized.message)
    ) {
      writeResponse(res, 202, 'Ignored duplicate delivery');
      return;
    }

    normalized.message.attachments = await hydrateBlueBubblesAttachmentCache(
      this.buildConfigForBaseUrl(
        this.getActiveBaseUrl() || this.config.baseUrl,
      ),
      normalized.message.attachments || [],
    );

    this.rememberObservedChatMetadata({
      chatJid: normalized.chatJid,
      chat: normalized.chat,
      contact: normalized.contact,
      message: normalized.message,
    });
    this.noteWebhookObserved(normalized.chatJid, normalized.message.timestamp);
    this.noteIngressFingerprint(normalized.chatJid, normalized.message);

    this.inflightMessageIds.add(normalized.message.id);
    try {
      await this.opts.onChatMetadata(
        normalized.chatJid,
        normalized.message.timestamp,
        normalized.chat.displayName ||
          (!normalized.chat.isGroup ? normalized.contact.displayName : null) ||
          normalized.chat.chatGuid,
        'bluebubbles',
        normalized.chat.isGroup,
      );
      await this.opts.onMessage(normalized.chatJid, normalized.message);
      this.lastErrorText = null;
      if (!this.lastReadyAt) {
        this.lastReadyAt = new Date().toISOString();
      }
      this.emitHealth();
      writeResponse(res, 200, 'OK');
    } catch (error) {
      this.lastErrorText =
        error instanceof Error
          ? error.message
          : 'Unknown BlueBubbles ingress error';
      this.emitHealth({ state: 'degraded' });
      writeResponse(res, 500, this.lastErrorText);
    } finally {
      this.inflightMessageIds.delete(normalized.message.id);
    }
  }

  private async postBlueBubblesText(
    chatGuid: string,
    text: string,
    replyToGuid?: string,
  ): Promise<SendMessageResult> {
    const activeBaseUrl = await this.ensureActiveBaseUrl({
      recheck: true,
      refreshReadiness: true,
    });
    if (!activeBaseUrl || !this.config.password || !chatGuid) {
      throw new Error(
        this.transportProbeDetail ||
          'BlueBubbles transport is missing a reachable endpoint, password, or chat target',
      );
    }
    return this.bridgeProvider.sendText(
      this.buildConfigForBaseUrl(activeBaseUrl),
      {
        chatGuid,
        text,
        replyToGuid,
        sendMethod: this.sendMethod,
      },
    );
  }

  private async postBlueBubblesNewDirectChat(
    address: string,
    text: string,
  ): Promise<SendMessageResult> {
    const activeBaseUrl = await this.ensureActiveBaseUrl({
      recheck: true,
      refreshReadiness: true,
    });
    if (!activeBaseUrl || !this.config.password) {
      throw new Error(
        this.transportProbeDetail ||
          'BlueBubbles transport is missing a reachable endpoint or password',
      );
    }
    this.lastOutboundTargetKind = 'new_direct_chat_address';
    this.lastOutboundTargetValue = address;
    this.lastAttemptedTargetSequence = ['new_direct_chat_address'];
    this.monitorState.lastOutboundTargetKind = this.lastOutboundTargetKind;
    this.monitorState.lastOutboundTargetValue = address;
    return this.bridgeProvider.createDirectChat(
      this.buildConfigForBaseUrl(activeBaseUrl),
      {
        address,
        text,
        sendMethod: this.sendMethod,
        service: 'iMessage',
      },
    );
  }

  private async postBlueBubblesAttachment(
    chatGuid: string,
    artifact: ChannelArtifact,
    options?: SendMessageOptions & { caption?: string },
  ): Promise<SendMessageResult> {
    const activeBaseUrl = await this.ensureActiveBaseUrl({
      recheck: true,
      refreshReadiness: true,
    });
    if (!activeBaseUrl || !this.config.password || !chatGuid) {
      throw new Error(
        this.transportProbeDetail ||
          'BlueBubbles transport is missing a reachable endpoint, password, or chat target',
      );
    }

    const url = new URL('/api/v1/message/attachment', activeBaseUrl);
    for (const [key, value] of buildAuthSearchParams(
      this.config.password,
    ).entries()) {
      url.searchParams.set(key, value);
    }

    const replyToGuid = options?.replyToMessageId?.startsWith('bb:')
      ? options.replyToMessageId.slice(3)
      : undefined;
    const form = new FormData();
    form.set('chatGuid', chatGuid);
    form.set('tempGuid', randomUUID());
    form.set('method', this.sendMethod);
    if (replyToGuid) {
      form.set('selectedMessageGuid', replyToGuid);
    }
    if (options?.caption) {
      form.set('caption', options.caption);
      form.set('message', options.caption);
    }
    form.set(
      'file',
      new Blob([Buffer.from(artifact.bytesBase64, 'base64')], {
        type: artifact.mimeType || 'application/octet-stream',
      }),
      artifact.filename,
    );

    const response = await fetch(url, {
      method: 'POST',
      body: form,
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        extractBlueBubblesErrorText(response.status, responseText),
      );
    }
    const receiptId = extractBlueBubblesReceiptId(
      parseBlueBubblesJson(responseText),
    );
    if (!receiptId) {
      throw new Error('BlueBubbles did not return an attachment receipt.');
    }
    return {
      platformMessageId: `bb:${receiptId}`,
    };
  }

  private async sendBlueBubblesReply(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    const chatGuid = extractBlueBubblesChatGuid(jid);
    if (!chatGuid) {
      throw new Error('BlueBubbles target chat is invalid.');
    }
    const replyToGuid = options?.replyToMessageId?.startsWith('bb:')
      ? options.replyToMessageId.slice(3)
      : undefined;
    this.lastMetadataHydrationSource = 'none';
    this.lastAttemptedTargetSequence = [];

    if (replyToGuid) {
      try {
        this.updateLastOutboundAttempt({ kind: 'chat_guid', chatGuid });
        const result = await this.postBlueBubblesText(
          chatGuid,
          text,
          replyToGuid,
        );
        this.successfulOutboundTargetByJid.set(jid, {
          kind: 'chat_guid',
          chatGuid,
        });
        this.lastSendErrorDetail = null;
        return result;
      } catch (error) {
        logger.info(
          { err: error, replyToGuid },
          'BlueBubbles reply threading was rejected, retrying without reply metadata',
        );
      }
    }

    let candidates = this.buildOutboundTargetCandidates(jid, chatGuid);
    const attemptedTargets: BlueBubblesOutboundTargetCandidate[] = [];
    let lastErrorText = 'BlueBubbles send failed.';
    let nextCandidateIndex = 0;
    let hydrationAttempted = false;

    while (nextCandidateIndex < candidates.length) {
      const candidate = candidates[nextCandidateIndex];
      nextCandidateIndex += 1;
      this.updateLastOutboundAttempt(candidate);
      attemptedTargets.push(candidate);
      this.lastAttemptedTargetSequence.push(candidate.kind);
      try {
        const result = await this.postBlueBubblesText(candidate.chatGuid, text);
        this.successfulOutboundTargetByJid.set(jid, candidate);
        this.lastSendErrorDetail = null;
        return result;
      } catch (error) {
        const errorText =
          error instanceof Error
            ? error.message
            : 'Unknown BlueBubbles send error';
        this.lastSendErrorDetail = errorText;
        lastErrorText = errorText;
        const directMetadata = this.getDirectChatMetadata(jid, chatGuid);
        const shouldHydrateFromHistory =
          !directMetadata.isGroup &&
          !hydrationAttempted &&
          !directMetadata.lastAddressedHandle &&
          this.isRetryableDirectTargetError(errorText);
        if (shouldHydrateFromHistory) {
          try {
            await this.hydrateDirectChatMetadataFromHistory(jid, chatGuid, 3);
            candidates = this.buildOutboundTargetCandidates(jid, chatGuid);
          } catch (hydrationError) {
            logger.warn(
              {
                err: hydrationError,
                chatJid: jid,
                chatGuid,
              },
              'BlueBubbles direct-chat metadata hydration failed',
            );
          } finally {
            hydrationAttempted = true;
          }
        }

        const canRetry =
          !this.getDirectChatMetadata(jid, chatGuid).isGroup &&
          this.isRetryableDirectTargetError(errorText) &&
          nextCandidateIndex < candidates.length;
        if (!canRetry) {
          break;
        }

        logger.info(
          {
            err: error,
            chatJid: jid,
            targetKind: candidate.kind,
            targetChatGuid: candidate.chatGuid,
          },
          'BlueBubbles direct-chat send failed, retrying with another target hint',
        );
      }
    }

    throw new Error(
      this.buildBlueBubblesSendFailureMessage(attemptedTargets, lastErrorText),
    );
  }

  async connect(): Promise<void> {
    if (!this.config.enabled) {
      this.connected = false;
      this.emitHealth({ state: 'stopped' });
      return;
    }
    this.server = http.createServer((req, res) => {
      this.handleWebhookRequest(req, res).catch((error) => {
        this.lastErrorText =
          error instanceof Error
            ? error.message
            : 'Unknown BlueBubbles listener error';
        this.emitHealth({ state: 'degraded' });
        writeResponse(res, 500, this.lastErrorText);
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server?.off('error', onError);
        reject(error);
      };
      this.server?.once('error', onError);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off('error', onError);
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.activePort = address.port;
        }
        this.connected = true;
        this.lastReadyAt = new Date().toISOString();
        this.lastErrorText = null;
        this.emitHealth();
        resolve();
      });
    });
    await this.probeBlueBubblesTransport();
    await this.refreshBridgeReadiness();
    this.lastErrorText =
      this.transportProbeStatus === 'reachable' &&
      this.webhookRegistrationStatus === 'registered'
        ? null
        : this.webhookRegistrationDetail || this.transportProbeDetail;
    await this.runShadowMonitorOnce().catch((error) => {
      logger.warn(
        { err: error },
        'Initial BlueBubbles shadow monitor run failed',
      );
    });
    this.startShadowMonitor();
    this.emitHealth();
  }

  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<SendMessageResult> {
    if (!this.connected) {
      throw new Error('BlueBubbles channel is not connected.');
    }
    if (!this.config.sendEnabled) {
      throw new Error('BlueBubbles outbound send is disabled.');
    }
    const chatGuid = extractBlueBubblesChatGuid(jid);
    if (!chatGuid) {
      throw new Error('BlueBubbles target chat is not valid.');
    }
    const requestedFirstContactAddress = options?.blueBubblesCreateChatAddress;
    const firstContactAddress = requestedFirstContactAddress
      ? normalizeBlueBubblesContactTargetAddress(requestedFirstContactAddress)
      : null;
    if (requestedFirstContactAddress && !firstContactAddress) {
      throw new Error('BlueBubbles first-contact address is not valid.');
    }
    if (
      firstContactAddress &&
      chatGuid !== `iMessage;-;${firstContactAddress}`
    ) {
      throw new Error(
        'BlueBubbles first-contact address does not match the approved target.',
      );
    }
    if (
      firstContactAddress &&
      (options?.threadId || options?.replyToMessageId)
    ) {
      throw new Error(
        'BlueBubbles first-contact delivery cannot include existing-thread metadata.',
      );
    }
    if (
      !isBlueBubblesChatEligible(
        this.config,
        chatGuid,
        firstContactAddress ? false : undefined,
      )
    ) {
      throw new Error(
        'BlueBubbles can only reply inside the configured chat scope.',
      );
    }

    const renderedText = options?.suppressSenderLabel
      ? text.replace(/\r\n/g, '\n')
      : formatBlueBubblesOutboundText(text);
    const isCompanionLabeled = !options?.suppressSenderLabel;

    try {
      const result = firstContactAddress
        ? await this.postBlueBubblesNewDirectChat(
            firstContactAddress,
            renderedText,
          )
        : await this.sendBlueBubblesReply(jid, renderedText, options);
      const sentAt = new Date().toISOString();
      const deliveredJid = result.threadId?.startsWith('bb:')
        ? result.threadId
        : jid;
      this.rememberLastOutboundObservation(deliveredJid, sentAt);
      this.lastErrorText = null;
      this.lastSendErrorDetail = null;
      this.monitorState.lastSendErrorDetail = null;
      if (this.monitorState.lastReplySendFailureChatJid === jid) {
        this.monitorState.lastReplySendFailureAt = null;
        this.monitorState.lastReplySendFailureChatJid = null;
        this.monitorState.lastReplySendFailureStage = null;
        this.monitorState.recentEvidence =
          this.monitorState.recentEvidence.filter(
            (entry) =>
              !(
                entry.kind === 'reply_delivery_failed' && entry.chatJid === jid
              ),
          );
        this.persistMonitorState();
      }
      storeChatMetadata(deliveredJid, sentAt, undefined, 'bluebubbles');
      storeMessageDirect({
        id: result.platformMessageId || `bb:outbound:${chatGuid}:${sentAt}`,
        chat_jid: deliveredJid,
        sender: isCompanionLabeled ? 'Andrea' : 'Me',
        sender_name: isCompanionLabeled ? 'Andrea' : 'You',
        content: renderedText,
        timestamp: sentAt,
        is_from_me: true,
        is_bot_message: isCompanionLabeled,
        reply_to_id: options?.replyToMessageId || undefined,
      });
      this.persistMonitorState();
      this.emitHealth();
      return result;
    } catch (error) {
      this.lastErrorText =
        error instanceof Error
          ? error.message
          : 'Unknown BlueBubbles send error';
      this.noteReplySendFailure(jid, this.lastErrorText);
      await this.maybeEscalateCrossSurfaceFallback();
      this.emitHealth({ state: 'degraded' });
      throw error;
    }
  }

  async sendArtifact(
    jid: string,
    artifact: ChannelArtifact,
    options: SendArtifactOptions = {},
  ): Promise<SendMessageResult> {
    if (!this.connected) {
      throw new Error('BlueBubbles channel is not connected.');
    }
    if (!this.config.sendEnabled) {
      throw new Error('BlueBubbles outbound send is disabled.');
    }
    const chatGuid = extractBlueBubblesChatGuid(jid);
    if (!chatGuid) {
      throw new Error('BlueBubbles target chat is not valid.');
    }
    if (!isBlueBubblesChatEligible(this.config, chatGuid)) {
      throw new Error(
        'BlueBubbles can only send media inside the configured chat scope.',
      );
    }

    const result = await this.postBlueBubblesAttachment(chatGuid, artifact, {
      ...options,
      caption: options.caption,
    });
    const sentAt = new Date().toISOString();
    this.rememberLastOutboundObservation(jid, sentAt);
    storeChatMetadata(jid, sentAt, undefined, 'bluebubbles');
    storeMessageDirect({
      id: result.platformMessageId || `bb:outbound-media:${chatGuid}:${sentAt}`,
      chat_jid: jid,
      sender: 'Andrea',
      sender_name: 'Andrea',
      content: options.caption || `[${artifact.kind}: ${artifact.filename}]`,
      timestamp: sentAt,
      is_from_me: true,
      is_bot_message: true,
      reply_to_id: options.replyToMessageId || undefined,
    });
    this.persistMonitorState();
    this.emitHealth();
    return result;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async primeRecentHistory(
    options: { limit?: number } = {},
  ): Promise<{ storedCount: number; totalCount: number }> {
    if (!this.connected) {
      throw new Error('BlueBubbles channel is not connected.');
    }
    const activeBaseUrl = await this.ensureActiveBaseUrl({
      recheck: true,
      refreshReadiness: true,
    });
    if (!activeBaseUrl) {
      throw new Error(
        this.transportProbeDetail ||
          'Andrea could not reach the configured BlueBubbles endpoint.',
      );
    }
    const limit = Math.min(Math.max(1, options.limit || 200), 500);
    const rows = await this.bridgeProvider.inspectRecentActivity(
      this.buildConfigForBaseUrl(activeBaseUrl),
      {
        limit,
        candidateChatJids: getAllChats()
          .map((chat) => chat.jid)
          .filter((jid) => jid.startsWith('bb:')),
      },
    );
    const eligibleRows = rows.filter((row) =>
      isBlueBubblesChatEligible(
        this.config,
        row.chat.chatGuid,
        row.chat.isGroup,
      ),
    );
    let storedCount = 0;
    for (const row of eligibleRows) {
      storeChatMetadata(
        row.chatJid,
        row.message.timestamp,
        row.chat.displayName ||
          (!row.chat.isGroup ? row.contact.displayName : null) ||
          row.chat.chatGuid,
        'bluebubbles',
        row.chat.isGroup,
      );
      if (hasStoredMessage(row.chatJid, row.message.id)) continue;
      storeMessageDirect({
        id: row.message.id,
        chat_jid: row.chatJid,
        sender: row.message.sender,
        sender_name: row.message.sender_name,
        content: row.message.content,
        timestamp: row.message.timestamp,
        is_from_me: Boolean(row.message.is_from_me),
        is_bot_message: row.message.is_bot_message,
        reply_to_id: row.message.reply_to_id || undefined,
        attachments: row.message.attachments || [],
      });
      storedCount += 1;
    }
    this.lastMetadataHydrationSource = 'history';
    this.monitorState.lastMetadataHydrationSource = 'history';
    this.persistMonitorState();
    return { storedCount, totalCount: eligibleRows.length };
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('bb:');
  }

  getWebhookUrl(): string {
    return buildBlueBubblesListenerWebhookUrl({
      host: this.config.host,
      port: this.activePort,
      webhookPath: this.config.webhookPath,
      webhookSecret: this.config.webhookSecret,
    });
  }

  getPublicWebhookUrl(): string {
    return buildBlueBubblesWebhookUrl({
      host: this.config.host,
      port: this.activePort,
      webhookPath: this.config.webhookPath,
      webhookSecret: this.config.webhookSecret,
      webhookPublicBaseUrl: this.config.webhookPublicBaseUrl,
    });
  }

  getPublicWebhookDisplayUrl(): string {
    return redactBlueBubblesWebhookUrl(this.getPublicWebhookUrl());
  }

  getLinkedChatJid(): string | null {
    return buildBlueBubblesLinkedChatJid(this.config);
  }

  getConfiguredReplyGateMode(): BlueBubblesReplyGateMode {
    return resolveConfiguredBlueBubblesReplyGateMode(this.config);
  }

  getEffectiveReplyGateMode(): BlueBubblesReplyGateMode {
    return this.getHealthReplyGateMode();
  }

  getControlSnapshot(): BlueBubblesChannelControlSnapshot {
    return {
      connected: this.connected,
      enabled: this.config.enabled,
      groupFolder: this.config.groupFolder,
      chatScope: this.config.chatScope,
      sendEnabled: this.config.sendEnabled,
      listenerHost: this.config.host,
      listenerPort: this.activePort,
      configuredBaseUrl: this.config.baseUrl,
      activeBaseUrl: this.getActiveBaseUrl(),
      candidateBaseUrls: this.getConfiguredBaseUrlCandidates(),
      publicWebhookUrl: this.getPublicWebhookDisplayUrl(),
      serverPublicUrl: this.config.serverPublicUrl,
      localPort: this.config.localPort,
      imessageAccountLabel: this.config.imessageAccountLabel,
      computerId: this.config.computerId,
      webhookRegistrationState: this.webhookRegistrationStatus,
      webhookRegistrationDetail: this.webhookRegistrationDetail || 'none',
      transportState: this.transportProbeStatus,
      transportDetail: this.transportProbeDetail || 'none',
      shadowPollLastOkAt: this.monitorState.shadowPollLastOkAt || 'none',
      shadowPollLastError: this.monitorState.shadowPollLastError || 'none',
      shadowPollMostRecentChat:
        this.monitorState.shadowPollMostRecentChat || 'none',
      configuredReplyGateMode: this.getConfiguredReplyGateMode(),
      effectiveReplyGateMode: this.getEffectiveReplyGateMode(),
      lastInboundObservedAt: this.lastInboundObservedAt || 'none',
      lastInboundChatJid: this.lastInboundChatJid || 'none',
      lastInboundWasSelfAuthored: this.lastInboundChatJid
        ? this.lastInboundWasSelfAuthored
        : null,
      lastOutboundResult: this.lastOutboundResult || 'none',
      lastOutboundTargetKind: this.lastOutboundTargetKind || 'none',
      lastOutboundTarget: this.lastOutboundTargetValue || 'none',
      lastSendErrorDetail: this.lastSendErrorDetail || 'none',
      detectionState: this.monitorState.detectionState,
      detectionDetail: this.monitorState.detectionDetail || 'none',
      detectionNextAction: this.monitorState.detectionNextAction || 'none',
    };
  }

  async refreshControlState(
    mode: 'transport' | 'webhook' | 'shadow' | 'all',
  ): Promise<BlueBubblesChannelControlSnapshot> {
    if (!this.connected) {
      throw new Error('BlueBubbles channel is not connected.');
    }
    if (mode === 'transport' || mode === 'all') {
      await this.probeBlueBubblesTransport();
    }
    if (mode === 'webhook' || mode === 'all') {
      await this.probeBlueBubblesTransport();
      await this.refreshBridgeReadiness();
    }
    if (mode === 'shadow' || mode === 'all') {
      await this.runShadowMonitorOnce();
    }
    this.persistMonitorState();
    this.emitHealth();
    return this.getControlSnapshot();
  }

  async disconnect(): Promise<void> {
    this.stopShadowMonitor();
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch((error) => {
        logger.warn(
          { err: error },
          'Failed to close BlueBubbles listener cleanly',
        );
      });
      this.server = undefined;
    }
    this.connected = false;
    this.emitHealth({
      state: 'stopped',
      detail: 'BlueBubbles channel disconnected',
    });
  }
}

registerChannel('bluebubbles', (opts: ChannelOpts) => {
  const config = resolveBlueBubblesConfig();
  if (!config.enabled) {
    logger.debug('BlueBubbles channel not registered because it is disabled');
    return null;
  }
  return new BlueBubblesChannel(config, opts);
});
