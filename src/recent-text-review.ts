import { createHash } from 'crypto';

import { TIMEZONE } from './config.js';
import { resolveOwnerCalendarWindow } from './timezone.js';

import {
  getCommunicationThread,
  getAllChats,
  listCommunicationIdentityReviewsForGroup,
  listCommunicationThreadsForGroup,
  listLifeThreadsForGroup,
  listMessagesForChatWindow,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
  updateCommunicationThread,
  upsertCommunicationSignal,
  upsertCommunicationThread,
  type ChatInfo,
} from './db.js';
import {
  buildOpenAiModelCandidates,
  detectOpenAiProviderMode,
  isOpenAiModelRejection,
} from './openai-model-routing.js';
import { isConfiguredBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  buildPersonalContextGraph,
  type PersonalContextGraphReport,
} from './personal-context-graph.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import { recordOpenAiUsageState } from './openai-usage-state.js';
import {
  extractGroundedMessagesPlanFacts,
  formatGroundedMessagesPlanFact,
} from './messages-commitment-summary.js';
import { hasMessagesGroundingPolarityConflict } from './messages-grounding-polarity.js';
import { buildThreadGroundedSuggestedReplies } from './thread-grounded-wording.js';
import type {
  CommunicationFollowupState,
  CommunicationIdentityReviewRecord,
  CommunicationSuggestedAction,
  CommunicationThreadRecord,
  CommunicationUrgency,
  CompanionRouteTimeWindowKind,
  LifeThread,
  NewMessage,
  ProfileFactWithSubject,
  ProfileSubject,
} from './types.js';

const REVIEW_OPENAI_TIMEOUT_MS = 12_000;
const MAX_PROVIDER_ITEMS = 6;
const MAX_REVIEW_ITEMS = 12;
const MAX_REVIEW_SEED_AGE_MS = 36 * 60 * 60 * 1000;
const TELEGRAM_REVIEW_DISPLAY_LIMIT = 4;
const BLUEBUBBLES_REVIEW_DISPLAY_LIMIT = 3;

export type RecentTextReviewSection =
  | 'needs_reply'
  | 'worth_watching'
  | 'no_reply_needed';

export type RecentTextReviewContextConfidence = 'high' | 'medium' | 'low';

export interface RecentTextReviewSuggestedReply {
  label: string;
  text: string;
}

export type RecentTextReviewOutcome =
  | 'reviewed'
  | 'suggested'
  | 'drafted'
  | 'saved'
  | 'reminded'
  | 'skipped'
  | 'handled'
  | 'blocked_stale'
  | 'blocked_unbound';

export interface RecentTextReviewFreshnessSnapshot {
  latestMessageIdentityHash?: string | null;
  latestMessageAt?: string | null;
  latestInboundAt?: string | null;
  latestOutboundAt?: string | null;
  messageCount?: number | null;
  snapshotHash?: string | null;
  transcriptHash?: string | null;
}

export interface MessagesTargetedHistoryRefreshReceipt {
  chatJid: string;
  storedCount: number;
  totalCount: number;
}

export type RecentTextReviewFreshnessBlockReason =
  | 'seed_too_old'
  | 'thread_binding_missing'
  | 'thread_binding_changed'
  | 'thread_history_unavailable'
  | 'targeted_refresh_failed'
  | 'snapshot_binding_missing'
  | 'newer_thread_activity'
  | 'thread_snapshot_changed';

export type RecentTextReviewFreshnessResult =
  | {
      ok: true;
      reason: 'fresh' | 'legacy_no_snapshot';
      target: RecentTextReviewFollowupTarget;
    }
  | {
      ok: false;
      reason: RecentTextReviewFreshnessBlockReason;
      outcome: Extract<
        RecentTextReviewOutcome,
        'blocked_stale' | 'blocked_unbound'
      >;
      detail: string;
      target?: RecentTextReviewFollowupTarget;
    };

export interface RecentTextReviewContextLink {
  participantKind: 'direct' | 'group' | 'unknown';
  confidence: RecentTextReviewContextConfidence;
  reason: string;
  riskFlags: string[];
  communicationThreadId?: string | null;
}

export interface RecentTextReviewFollowupTarget {
  ok: boolean;
  reason: string;
  targetChannel?: 'telegram' | 'bluebubbles';
  chatJid?: string;
  isGroup?: boolean;
  personName?: string;
  communicationThreadId?: string | null;
}

export interface RecentTextReviewItem {
  itemId: string;
  rank: number;
  section: RecentTextReviewSection;
  priorityScore: number;
  sourceChannel?: 'telegram' | 'bluebubbles';
  chatJid: string;
  chatLabel: string;
  isGroup: boolean;
  latestMessageId?: string | null;
  latestMessageAt?: string | null;
  latestInboundAt?: string | null;
  latestOutboundAt?: string | null;
  freshnessSnapshot?: RecentTextReviewFreshnessSnapshot | null;
  summaryText: string;
  whyText: string;
  recommendedAction: string;
  suggestedReply?: string | null;
  suggestedReplies?: RecentTextReviewSuggestedReply[] | null;
  evidenceSnippets: string[];
  linkedSubjectIds: string[];
  linkedLifeThreadIds: string[];
  communicationThreadId?: string | null;
  contextLink: RecentTextReviewContextLink;
  riskFlags: string[];
}

export interface RecentTextReviewResult {
  ok: boolean;
  reviewedAt: string;
  window: {
    startTimestamp: string;
    endTimestamp: string | null;
    label: string;
  };
  summaryText: string;
  items: RecentTextReviewItem[];
  needsReply: RecentTextReviewItem[];
  worthWatching: RecentTextReviewItem[];
  noReplyNeeded: RecentTextReviewItem[];
  reviewedConversationCount: number;
  sectionTotals: Record<RecentTextReviewSection, number>;
  providerUsed: 'local' | 'openai';
  providerNote?: string | null;
}

export interface RecentTextReviewInput {
  groupFolder: string;
  now?: Date;
  channel?: 'telegram' | 'bluebubbles';
  timeWindowKind?: CompanionRouteTimeWindowKind | null;
  timeWindowValue?: number | null;
  cloudAnalysisMode?: 'auto' | 'disabled';
}

interface LocalReviewContext {
  subjects: ProfileSubject[];
  facts: ProfileFactWithSubject[];
  lifeThreads: LifeThread[];
  communicationThreads: CommunicationThreadRecord[];
  identityReviews: CommunicationIdentityReviewRecord[];
  contextGraph: PersonalContextGraphReport;
}

interface CandidateAnalysis {
  item: RecentTextReviewItem;
  persist: boolean;
  sourceChannel: 'telegram' | 'bluebubbles';
  followupState: CommunicationFollowupState;
  suggestedAction: CommunicationSuggestedAction | null;
  urgency: CommunicationUrgency;
  latestDirection: 'inbound' | 'outbound';
  latestInboundSummary: string | null;
  latestOutboundSummary: string | null;
}

type AutomatedMessageKind = 'marketing_or_survey' | 'transactional_notice';

interface AutomatedMessageSignal {
  kind: AutomatedMessageKind;
  expectsConfirmation: boolean;
  requiresOwnerAction: boolean;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value: string | null | undefined, maxLength: number): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

export function isBlueBubblesReactionPlaceholder(
  value: string | null | undefined,
): boolean {
  return /^(?:\[BlueBubbles reaction: (?:removed )?(?:love|like|dislike|laugh|emphasize|question)\]|\[(?:Reacted with (?:love|like|dislike|laugh|emphasize|question)|Removed (?:love|like|dislike|laugh|emphasize|question) reaction)\])$/i.test(
    normalizeText(value),
  );
}

function describeReactionPlaceholder(value: string): string {
  const match = /^\[BlueBubbles reaction: (removed )?([^\]]+)\]$/i.exec(
    normalizeText(value),
  );
  if (!match) return normalizeText(value);
  return match[1]
    ? `[Removed ${match[2]} reaction]`
    : `[Reacted with ${match[2]}]`;
}

/**
 * Build the one text projection used by every Messages summary lane. It
 * carries attachment presence forward without exposing filenames or claiming
 * that binary contents were analyzed as part of a text-only digest.
 */
export function describeMessageForSummary(message: NewMessage): string {
  const rawText = normalizeText(message.content || '');
  const isReaction = isBlueBubblesReactionPlaceholder(rawText);
  const reactionTarget = isReaction
    ? sanitizeSnippet(message.reply_to?.content || '', 100)
    : '';
  const reactionText = isReaction
    ? `${describeReactionPlaceholder(rawText)}${reactionTarget ? ` to: "${reactionTarget}"` : ''}`
    : rawText;
  const attachments = message.attachments || [];
  if (attachments.length === 0) return reactionText;

  const counts = new Map<string, number>();
  for (const attachment of attachments) {
    const label =
      attachment.kind === 'image'
        ? 'photo'
        : attachment.kind === 'audio'
          ? 'audio clip'
          : attachment.kind;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const attachmentLabel = [...counts.entries()]
    .map(([label, count]) =>
      count === 1
        ? label
        : `${count} ${label === 'photo' ? 'photos' : label === 'audio clip' ? 'audio clips' : `${label}s`}`,
    )
    .join(', ');
  const descriptor = `[Attached: ${attachmentLabel}; contents not included in this text summary]`;
  const generatedAttachmentPlaceholder =
    /^\[(?:(?:\d+\s+)?(?:image|video|audio|file)s?)(?:,\s*(?:\d+\s+)?(?:image|video|audio|file)s?)*\]$/i.test(
      rawText,
    );
  return generatedAttachmentPlaceholder || !reactionText
    ? descriptor
    : `${reactionText} ${descriptor}`;
}

export function redactRecentTextReviewText(value: string): string {
  const redactCodeToken = (token: string): string => {
    const compact = token.replace(/-/g, '');
    return compact.length >= 4 &&
      compact.length <= 12 &&
      /\d/.test(compact) &&
      /^[a-z0-9]+$/i.test(compact)
      ? '[redacted code]'
      : token;
  };
  let redacted = normalizeText(value);
  redacted = redacted
    .replace(
      /\b((?:(?:your|this|the)\s+)?(?:one[ -]?time(?:\s+(?:verification|security|authentication))?\s+(?:code|pin|passcode)|(?:verification|security|authentication|auth|login|sign[ -]?in)\s+(?:code|pin|passcode)|(?:otp|passcode))|(?:your|this|the)\s+(?:code|pin|passcode|otp))\s*(?:is|:|=|-)?\s*([a-z0-9][a-z0-9-]{2,15})\b/gi,
      (_match, prefix: string, token: string) =>
        `${prefix}: ${redactCodeToken(token)}`,
    )
    .replace(
      /\b([a-z0-9][a-z0-9-]{2,15})(\s+is\s+(?:your\s+|the\s+)?(?:(?:verification|security|authentication|auth|login|sign[ -]?in|one[ -]?time)\s+)?(?:code|pin|passcode|otp))\b/gi,
      (_match, token: string, suffix: string) =>
        `${redactCodeToken(token)}${suffix}`,
    )
    .replace(
      /\b(use\s+)([a-z0-9][a-z0-9-]{2,15})(\s+to\s+(?:sign[ -]?in|log[ -]?in|verify|authenticate|confirm))\b/gi,
      (_match, prefix: string, token: string, suffix: string) =>
        `${prefix}${redactCodeToken(token)}${suffix}`,
    );
  redacted = redacted
    .replace(
      /\b[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*[^\s"',;]+/gi,
      (match) => {
        const key = match.split('=')[0]?.trim() || 'SECRET';
        return `${key}=***`;
      },
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted email]')
    .replace(/\bbb:[^\s"']+/gi, '[redacted jid]')
    .replace(/\b(?:iMessage|SMS);[^\s"']+/gi, '[redacted jid]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[redacted number]')
    .replace(
      /\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g,
      '[redacted secret]',
    );
  return redacted;
}

function sanitizeSnippet(
  value: string | null | undefined,
  maxLength = 180,
): string {
  return clipText(redactRecentTextReviewText(value || ''), maxLength);
}

function safeChatLabel(chat: ChatInfo): string {
  const name = normalizeText(chat.name);
  const compactDialString = name.replace(/[\s()+.-]/g, '');
  const unsafeIdentifierLabel =
    /^\d{3,}$/.test(compactDialString) ||
    /\+?\d[\d\s().-]{6,}\d/.test(name) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(name) ||
    /^(?:bb:|iMessage;-;|SMS;)/i.test(name);
  if (name && name !== chat.jid && !unsafeIdentifierLabel) {
    return clipText(redactRecentTextReviewText(name), 72);
  }
  return chat.is_group ? 'Messages group' : 'Messages chat';
}

export function resolveRecentTextReviewWindow(params: {
  now: Date;
  kind?: CompanionRouteTimeWindowKind | null;
  value?: number | null;
  timeZone?: string;
}): { startTimestamp: string; endTimestamp: string | null; label: string } {
  const window = resolveOwnerCalendarWindow({
    now: params.now,
    kind: params.kind,
    value: params.value,
    timeZone: params.timeZone ?? TIMEZONE,
  });
  const label =
    params.kind === 'today'
      ? 'today'
      : params.kind === 'yesterday'
        ? 'yesterday'
        : params.kind === 'this_week'
          ? 'this week'
          : params.kind === 'last_hours'
            ? `the last ${Math.max(1, params.value || 1)} hour${Math.max(1, params.value || 1) === 1 ? '' : 's'}`
            : params.kind === 'last_days'
              ? `the last ${Math.max(1, params.value || 1)} day${Math.max(1, params.value || 1) === 1 ? '' : 's'}`
              : 'the last 24 hours';
  return {
    ...window,
    label,
  };
}

function messageContent(message: NewMessage | undefined): string {
  return sanitizeSnippet(message?.content || '', 180);
}

function latestMessage(messages: NewMessage[]): NewMessage | undefined {
  return messages[messages.length - 1];
}

function findLatestInbound(messages: NewMessage[]): NewMessage | undefined {
  return [...messages].reverse().find((message) => !message.is_from_me);
}

function findLatestOutbound(messages: NewMessage[]): NewMessage | undefined {
  return [...messages].reverse().find((message) => message.is_from_me);
}

export function findLatestUnresolvedInboundAsk(
  messages: NewMessage[],
): NewMessage | undefined {
  return findUnresolvedInboundAsks(messages).at(-1);
}

function findUnresolvedInboundAsks(messages: NewMessage[]): NewMessage[] {
  let unresolvedAsks: NewMessage[] = [];
  for (const message of messages) {
    if (message.is_from_me) {
      if (hasExplicitClosureSignal(message.content || '')) {
        unresolvedAsks = [];
        continue;
      }
      const multipleOpenAsks = unresolvedAsks.length > 1;
      unresolvedAsks = unresolvedAsks.filter(
        (inbound) =>
          !outboundLikelyAddressesInbound({
            inbound,
            outbound: message,
            multipleOpenAsks,
          }),
      );
      continue;
    }
    const text = normalizeText(message.content);
    if (
      hasExplicitClosureSignal(text) &&
      !hasOpenQuestionAfterExplicitClosure(text)
    ) {
      unresolvedAsks = [];
      continue;
    }
    if (hasDirectQuestion(text)) {
      if (hasExplicitClosureSignal(text)) {
        unresolvedAsks = [];
      }
      unresolvedAsks.push(message);
    }
  }
  return unresolvedAsks;
}

function compareIsoTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (!left && !right) return 0;
  if (left && !right) return 1;
  if (!left && right) return -1;
  return left!.localeCompare(right!);
}

export function buildMessagesThreadFreshnessSnapshot(input: {
  chatJid: string;
  messages: NewMessage[];
}): RecentTextReviewFreshnessSnapshot {
  const messages = input.messages.filter(
    (message) => !message.is_bot_message && describeMessageForSummary(message),
  );
  const latest = latestMessage(messages);
  const latestInbound = findLatestInbound(messages);
  const latestOutbound = findLatestOutbound(messages);
  if (!latest) {
    return {
      latestMessageIdentityHash: null,
      latestMessageAt: null,
      latestInboundAt: null,
      latestOutboundAt: null,
      messageCount: 0,
      snapshotHash: null,
      transcriptHash: null,
    };
  }
  const latestContentHash = hashText(describeMessageForSummary(latest));
  const reactionTargetId =
    latest.reaction?.targetMessageId ||
    latest.reply_to_id ||
    latest.reply_to?.message_id ||
    '';
  const reactionTargetContentHash = latest.reply_to?.content
    ? hashText(latest.reply_to.content)
    : '';
  const latestSpeaker = latest.is_from_me ? 'self' : 'other';
  const latestSenderKind = latest.sender_name ? 'named' : 'unknown';
  const transcriptHash = hashText(
    [...messages]
      .sort((left, right) => {
        const timestampOrder = (left.timestamp || '').localeCompare(
          right.timestamp || '',
        );
        return timestampOrder || (left.id || '').localeCompare(right.id || '');
      })
      .map((message) => {
        const reactionTargetId =
          message.reaction?.targetMessageId ||
          message.reply_to_id ||
          message.reply_to?.message_id ||
          '';
        return [
          message.id || '',
          message.timestamp || '',
          message.is_from_me ? 'self' : 'other',
          message.sender || '',
          message.sender_name || '',
          hashText(describeMessageForSummary(message)),
          message.reply_to_id || '',
          message.reply_to?.message_id || '',
          reactionTargetId,
          message.reply_to?.content ? hashText(message.reply_to.content) : '',
          message.reaction?.kind || '',
          message.reaction?.removed ? 'reaction_removed' : '',
        ].join('\u0000');
      })
      .join('\u0001'),
  );
  return {
    latestMessageIdentityHash: latest.id ? hashText(latest.id) : null,
    latestMessageAt: latest.timestamp || null,
    latestInboundAt: latestInbound?.timestamp || null,
    latestOutboundAt: latestOutbound?.timestamp || null,
    messageCount: messages.length,
    snapshotHash: hashText(
      [
        input.chatJid,
        latest.id || '',
        latest.timestamp || '',
        latestSpeaker,
        latestSenderKind,
        latestContentHash,
        latest.reply_to_id || '',
        latest.reply_to?.message_id || '',
        reactionTargetId,
        reactionTargetContentHash,
        latest.reaction?.kind || '',
        latest.reaction?.removed ? 'reaction_removed' : '',
        latestInbound?.timestamp || '',
        latestOutbound?.timestamp || '',
      ].join('|'),
    ),
    transcriptHash,
  };
}

const IMPERATIVE_NARRATIVE_PREDICATE =
  /\b(?:are|became|becomes?|described|describes?|helped|helps|is|looked|looks|made|makes|meant|means?|read|reads|referred|refers?|said|says|seemed|seems|sounded?|was|were)\b/i;
const IMPERATIVE_DEPENDENT_CLAUSE =
  /\b(?:after|before|because|if|once|that|what|when|where|which|while|who)\b/i;

function isDirectImperativeActionClause(text: string): boolean {
  const clause = normalizeText(text)
    .toLowerCase()
    .replace(/^[\s,;:!?\-\u2013\u2014]+/, '')
    .replace(
      /^(?:hey|hi|hello)(?:\s+(?:there|[a-z][a-z.'-]{0,30}))?[,!:]\s*/,
      '',
    )
    .replace(/^please\s+/, '')
    .replace(/(?:,?\s+)(?:please|thanks|thank you)[.!]*$/, '')
    .replace(/[.!]+$/, '')
    .trim();
  if (!clause || clause.length > 140 || clause.startsWith('"')) {
    return false;
  }

  const callMatch = /^call\s+(?:me|us)\b(.*)$/.exec(clause);
  if (callMatch) {
    const qualifier = normalizeText(callMatch[1]);
    return (
      !qualifier ||
      /^(?:about|after|asap|at|back|before|by|in|later|now|on|once|soon|this|today|tomorrow|tonight|when|whenever)\b/.test(
        qualifier,
      )
    );
  }

  const actionMatch = /^(?:bring|send)\s+(.+)$/.exec(clause);
  if (!actionMatch) return false;
  const requestedThing = normalizeText(actionMatch[1]);
  const words = requestedThing.match(/[a-z0-9']+/g) || [];
  if (words.length === 0 || words.length > 18) return false;

  // Keep the new match intentionally conservative. A finite narrative
  // predicate in "Send notifications are disabled" should not turn an
  // ordinary statement into an owner action item. Dependent clauses such as
  // "Bring milk when you are coming" remain valid requests.
  const narrativePredicate =
    IMPERATIVE_NARRATIVE_PREDICATE.exec(requestedThing);
  if (
    narrativePredicate &&
    !IMPERATIVE_DEPENDENT_CLAUSE.test(
      requestedThing.slice(0, narrativePredicate.index),
    )
  ) {
    return false;
  }
  return true;
}

function hasDirectImperativeActionRequest(text: string): boolean {
  return normalizeText(text)
    .split(/[.;]\s*/)
    .some((clause) => isDirectImperativeActionClause(clause));
}

function stripQuotedMaterial(text: string): string {
  return normalizeText(text)
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/(^|\s)'[^'\n]{2,}'(?=\s|[.!?,;]|$)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitQuestionClauses(text: string): string[] {
  return stripQuotedMaterial(text).match(/[^.!?;]+[.!?;]?/g) || [];
}

function isSecurityCredentialQuestion(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (
    !/\b(?:(?:verification|security|authentication|auth|login|sign[ -]?in|one[ -]?time)\s+(?:code|pin|passcode)|otp|passcode)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    /\?/.test(normalized) ||
    /^(?:what|which|where|who|how|can you|could you|would you|will you|did you|do you|please (?:send|share|tell))\b/.test(
      normalized,
    )
  );
}

function normalizeDirectAskClause(text: string): string {
  return normalizeText(text)
    .toLowerCase()
    .replace(/^[\s,;:!?\-\u2013\u2014]+/, '')
    .replace(
      /^(?:hey|hi|hello)(?:\s+(?:there|[a-z][a-z.'-]{0,30}))?[,!:]\s*/,
      '',
    )
    .replace(/^(?:quick|one) question[,!:]\s*/, '')
    .replace(/^i (?:just )?(?:wanted|meant) to ask[,!:]\s*/, '')
    .replace(/^i was (?:just )?wondering[,!:]\s*/, '')
    .trim();
}

function isDirectQuestionClause(text: string): boolean {
  let clause = normalizeDirectAskClause(text);
  if (!clause || isSecurityCredentialQuestion(clause)) return false;

  // A quoted or reported request is conversation context, not an instruction
  // for the owner. Remove an initial negated command while still allowing a
  // separate request that follows it ("Don't send that; can you call?").
  if (
    /^(?:i|we|he|she|they|someone|the (?:note|message|list))\s+(?:already\s+)?(?:know|knew|understand|remember|forgot|said|says|asked|asks|told|wrote|read|mean|meant)\b/.test(
      clause,
    )
  ) {
    return false;
  }
  const negatedPrefix =
    /^(?:(?:please\s+)?(?:do not|don't|never)\s+|(?:there is|there's|you have|you've)\s+no need to\s+)[^,;?]*(?:[,;]\s*|$)/.exec(
      clause,
    );
  if (negatedPrefix) {
    clause = clause.slice(negatedPrefix[0].length).trim();
    if (!clause) return false;
  }

  if (isDirectImperativeActionClause(clause)) return true;
  if (
    /^(?:(?:can|could|would|will|do|did|are|were|is|does|have|has|should|may|might)\s+(?:you|we|i|this|that|it|there)\b|(?:what|when|where|who|whom|whose|how|why)\b|can we\b|(?:i|we)\s+(?:really\s+)?need you to\b|let me know\b|lmk\b|need you to\b|please\s+(?:send|share|confirm|call|bring|reply|tell|fill|complete)\b|send me\b|share with me\b|tell me\b|confirm\s+(?:for me|whether|if)\b)/.test(
      clause,
    )
  ) {
    return true;
  }

  // Short fragments such as "Dinner tonight?" are still genuine open
  // questions. Narrative clauses were rejected above, and quoted material was
  // removed before reaching this point.
  return clause.includes('?') && clause.split(/\s+/).length <= 10;
}

function hasDirectQuestion(text: string): boolean {
  return splitQuestionClauses(text).some((clause) =>
    isDirectQuestionClause(clause),
  );
}

function actionableAskUnitCount(text: string): number {
  const clauses = splitQuestionClauses(text).filter((clause) =>
    isDirectQuestionClause(clause),
  );
  if (clauses.length === 0) return 0;
  const normalized = stripQuotedMaterial(text).toLowerCase();
  const coordinatedActionCount = (
    normalized.match(
      /\b(?:and|also|plus|then)\s+(?:please\s+)?(?:bring|call|complete|confirm|fill|pay|reply|schedule|send|share|tell)\b/g,
    ) || []
  ).length;
  return Math.max(clauses.length, coordinatedActionCount + 1);
}

function hasDeadline(text: string): boolean {
  return /\b(?:today|tonight|tomorrow|by \d|before|after|asap|soon|deadline|due|this week|later tonight|morning|afternoon|evening)\b/i.test(
    text,
  );
}

function hasSensitiveSignal(text: string): boolean {
  return /\b(?:upset|angry|mad|hurt|sorry|apologize|awkward|fight|conflict|divorce|money|bill|health|family|relationship|worried|scared|emergency|urgent|missed)\b/i.test(
    text,
  );
}

function hasConfusionReply(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  return /^(?:huh+|what+|what\?|who is this\??|why\??|i (?:do not|don't) understand|that (?:does not|doesn't) make sense|\?{1,4})[.!?\s]*$/i.test(
    normalized,
  );
}

function detectAutomatedMessageSignal(
  text: string,
): AutomatedMessageSignal | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  const hasLink = /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|org)\b)/i.test(
    normalized,
  );
  const hasBrandPrefix = /^[A-Z][A-Za-z0-9&'. -]{1,48}:\s/.test(normalized);
  const hasOptOut =
    /\b(?:text|reply)\s+(?:STOP|END|UNSUBSCRIBE)\b|\bopt[ -]?out\b|\bunsubscribe\b/i.test(
      normalized,
    );
  const hasStrongSurveyRequest =
    /\b(?:survey|share (?:your )?feedback|leave (?:us )?(?:a )?review|rate (?:us|your)|how did we do|your recent experience)\b/i.test(
      normalized,
    );
  const hasConversationalSurveyRequest =
    /\b(?:can|could|would|will) you\b[^.!?]{0,96}\b(?:survey|feedback|review)\b/i.test(
      normalized,
    ) ||
    /^(?:please\s+)?(?:fill|complete)\b[^.!?]{0,64}\bsurvey\b/i.test(
      normalized,
    );
  const hasGenericTellUsRequest = /\btell us (?:about|how)\b/i.test(normalized);
  const hasPromotion =
    /\b(?:promo(?:tion)?|coupon|discount|limited[ -]?time|special offer|shop now|flash sale|clearance|deal|save \$?\d+|\d+% off|free [^.!?]{0,32}(?:purchase|order))\b/i.test(
      normalized,
    );
  const hasFinancialNotice =
    /\b(?:invoice|statement|bill(?:ing)?|balance|amount due|payment (?:plan|due|scheduled)|past due|overdue|due date|auto[ -]?pay|pay your|pay this|make a payment|financial assistance)\b/i.test(
      normalized,
    );
  const hasFinancialAction =
    /\b(?:action needed|action required|amount due|balance (?:that )?is not|payment due|past due|overdue|due (?:today|tomorrow|on|by)|pay (?:your|this|online|now)|make a payment|apply for financial assistance|(?:bill|invoice|statement) for your review|review your (?:bill|invoice|statement)|view (?:the )?details)\b/i.test(
      normalized,
    );
  const hasFinancialTemplateCue =
    /\b(?:your (?:account|statement|balance|invoice)|your bill (?:is|has|of)|statement balance|invoice\s*#|financial assistance|payment plan|billing portal|view (?:the )?details|auto[ -]?pay|thank you for choosing|attached invoice)\b/i.test(
      normalized,
    );
  const hasFinancialAutomationCue =
    hasBrandPrefix ||
    hasOptOut ||
    hasFinancialTemplateCue ||
    (hasLink &&
      /\b(?:amount due|payment due|past due|overdue|pay online|invoice for your review|make a payment)\b/i.test(
        normalized,
      ));
  if (
    !hasFinancialNotice &&
    (hasOptOut ||
      (hasStrongSurveyRequest &&
        !hasConversationalSurveyRequest &&
        (hasLink || hasBrandPrefix)) ||
      (hasGenericTellUsRequest && (hasLink || hasBrandPrefix)) ||
      (hasPromotion && (hasLink || hasBrandPrefix)))
  ) {
    return {
      kind: 'marketing_or_survey',
      expectsConfirmation: false,
      requiresOwnerAction: false,
    };
  }

  const expectsConfirmation =
    /\b(?:reply|text)\s+(?:with\s+)?(?:YES|Y|OK|C|CONFIRM)\b|\b(?:please\s+)?confirm(?:\s+(?:your|this|the|by))?\b/i.test(
      normalized,
    );
  if (hasFinancialNotice && hasFinancialAutomationCue) {
    return {
      kind: 'transactional_notice',
      expectsConfirmation: false,
      requiresOwnerAction: hasFinancialAction,
    };
  }
  const hasSecurityCodeDelivery =
    !isSecurityCredentialQuestion(normalized) &&
    (/\b(?:(?:your|the|this)\s+)?(?:(?:verification|security|authentication|auth|login|sign[ -]?in|one[ -]?time)\s+)?(?:code|pin|passcode|otp)\s*(?:is|:|=)\s*[a-z0-9][a-z0-9-]{2,15}\b/i.test(
      normalized,
    ) ||
      /\buse\s+[a-z0-9][a-z0-9-]{2,15}\s+to\s+(?:sign[ -]?in|log[ -]?in|verify|authenticate)\b/i.test(
        normalized,
      ));
  const isSystemNotice =
    /\b(?:do not reply|no[ -]?reply|automated (?:message|notification))\b/i.test(
      normalized,
    ) || hasSecurityCodeDelivery;
  const hasTransactionalStatus =
    /\b(?:order|delivery|package|appointment|reservation|service|technician|specialist|agent|driver)\b.{0,100}\b(?:confirm(?:ed)?|scheduled|ready|arriv(?:e|al|ing)|on (?:the|its) way|status|update|delayed|completed)\b/i.test(
      normalized,
    ) ||
    /\b(?:confirm(?:ed)?|scheduled|ready|arriv(?:e|al|ing)|on (?:the|its) way|status|update|delayed|completed)\b.{0,100}\b(?:order|delivery|package|appointment|reservation|service|technician|specialist|agent|driver)\b/i.test(
      normalized,
    );
  const hasConversationalDirectAsk = hasDirectQuestion(normalized);
  if (
    isSystemNotice ||
    (hasTransactionalStatus && !hasConversationalDirectAsk) ||
    (expectsConfirmation &&
      !hasConversationalDirectAsk &&
      (hasBrandPrefix ||
        hasLink ||
        /\b(?:appointment|reservation|order|delivery|service)\b/i.test(
          normalized,
        )))
  ) {
    return {
      kind: 'transactional_notice',
      expectsConfirmation,
      requiresOwnerAction: expectsConfirmation,
    };
  }
  return null;
}

/**
 * Shared read-only guard for summary surfaces. Automated notices may still be
 * important, but they must not receive generic conversational reply drafts.
 */
export function isAutomatedRecentTextNotice(text: string): boolean {
  return Boolean(detectAutomatedMessageSignal(text));
}

function substantiveMessage(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;
  if (
    /^(?:ok|okay|k|thanks|thx|lol|haha|yep|yes|no|cool|nice|👍)$/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return normalized.length >= 8 || hasDirectImperativeActionRequest(normalized);
}

function acknowledgementOnlyMessage(text: string): boolean {
  return /^(?:ok(?:ay)?|thanks(?: so much)?|thank you|thx|got it|sounds good|perfect|great|cool|nice|no worries|you(?:'re| are) welcome|lol|haha)[!. ]*$/i.test(
    normalizeText(text),
  );
}

const EXPLICIT_CLOSURE_PATTERN_SOURCES = [
  String.raw`\bnever\s*mind\b`,
  String.raw`\b(?:i|we)(?:'ve| have)? (?:already )?(?:handled|fixed|resolved|sorted|took care of) (?:it|that|this)\b`,
  String.raw`\b(?:it|that|this)(?:'s| is) (?:already )?(?:handled|fixed|resolved|sorted|taken care of)\b`,
  String.raw`\b(?:no need|don't worry about (?:it|that|this)|all set|we(?:'re| are) good)\b`,
];

function lastExplicitClosureEnd(text: string): number {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return -1;
  let latestEnd = -1;
  for (const source of EXPLICIT_CLOSURE_PATTERN_SOURCES) {
    const pattern = new RegExp(source, 'gi');
    for (const match of normalized.matchAll(pattern)) {
      latestEnd = Math.max(latestEnd, (match.index || 0) + match[0].length);
    }
  }
  return latestEnd;
}

function hasExplicitClosureSignal(text: string): boolean {
  return lastExplicitClosureEnd(text) >= 0;
}

function hasOpenQuestionAfterExplicitClosure(text: string): boolean {
  const normalized = normalizeText(text);
  const closureEnd = lastExplicitClosureEnd(normalized);
  return closureEnd >= 0 && hasDirectQuestion(normalized.slice(closureEnd));
}

const REPLY_MATCH_STOP_WORDS = new Set([
  'about',
  'after',
  'before',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'have',
  'just',
  'please',
  'still',
  'that',
  'the',
  'this',
  'today',
  'tomorrow',
  'tonight',
  'want',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function meaningfulReplyTerms(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .toLowerCase()
      .match(/[a-z0-9']+/g)
      ?.filter(
        (term) => term.length >= 3 && !REPLY_MATCH_STOP_WORDS.has(term),
      ) || [],
  );
}

function outboundLikelyAddressesInbound(input: {
  inbound: NewMessage | undefined;
  outbound: NewMessage | undefined;
  multipleOpenAsks?: boolean;
}): boolean {
  if (!input.inbound || !input.outbound) return false;
  const outboundText = normalizeText(input.outbound.content);
  const askUnitCount = actionableAskUnitCount(input.inbound.content);
  if (
    /^(?:yes|yeah|yep|no|nope|sure|confirmed|done|sent|absolutely|correct|i can|i can't|we can|we can't)[!. ]*$/i.test(
      outboundText,
    )
  ) {
    return !input.multipleOpenAsks && askUnitCount <= 1;
  }
  if (
    input.outbound.reply_to_id &&
    input.outbound.reply_to_id === input.inbound.id &&
    askUnitCount <= 1
  ) {
    return true;
  }
  const inboundTerms = meaningfulReplyTerms(input.inbound.content);
  const outboundTerms = meaningfulReplyTerms(outboundText);
  const sharedTerms = [...inboundTerms].filter((term) =>
    outboundTerms.has(term),
  );
  return (
    sharedTerms.length >= 2 ||
    (sharedTerms.length === 1 && inboundTerms.size <= 2)
  );
}

function safeGroupParticipantLabel(message: NewMessage): string {
  if (message.is_from_me) return 'You';
  const name = normalizeText(message.sender_name || '');
  const compactDialString = name.replace(/[\s()+.-]/g, '');
  const unsafeIdentifier =
    !name ||
    /^\d{3,}$/.test(compactDialString) ||
    /\+?\d[\d\s().-]{6,}\d/.test(name) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(name) ||
    /^(?:bb:|iMessage;-;|SMS;)/i.test(name);
  return unsafeIdentifier ? 'A group participant' : sanitizeSnippet(name, 48);
}

function isGroupAskExplicitlyAddressedToOwner(input: {
  ask: NewMessage;
  messages: NewMessage[];
}): boolean {
  if (input.ask.reply_to?.is_from_me) return true;
  if (
    input.ask.reply_to_id &&
    input.messages.some(
      (message) => message.is_from_me && message.id === input.ask.reply_to_id,
    )
  ) {
    return true;
  }

  const text = stripQuotedMaterial(input.ask.content).toLowerCase();
  const ownerNames = Array.from(
    new Set(
      input.messages
        .filter((message) => message.is_from_me)
        .map((message) => normalizeText(message.sender_name).toLowerCase())
        .filter(
          (name) =>
            name &&
            !/^(?:me|you|owner|unknown)$/.test(name) &&
            !/\+?\d[\d\s().-]{6,}\d/.test(name),
        ),
    ),
  );
  return ownerNames.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `(?:^\\s*(?:hey\\s+)?@?${escaped}(?:\\b|[,!:])|@${escaped}\\b)`,
      'i',
    ).test(text);
  });
}

function recapOtherPossessive(chatLabel: string, isGroup: boolean): string {
  if (isGroup) return 'their';
  const label = normalizeText(chatLabel);
  if (
    !label ||
    /^(?:messages? chat|messages? group|they|their)$/i.test(label)
  ) {
    return 'their';
  }
  if (/^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}$/.test(label)) {
    return `${label}'s`;
  }
  return 'their';
}

function buildConversationRecap(input: {
  chatLabel: string;
  isGroup: boolean;
  messages: NewMessage[];
  latestInbound: NewMessage | undefined;
  unresolvedInboundAsk: NewMessage | undefined;
  unresolvedInboundAsks: NewMessage[];
  latestOutbound: NewMessage | undefined;
  section: RecentTextReviewSection;
  reasons: string[];
  ownerTurnResolved: boolean;
  ownerWaitingOnThem: boolean;
  inboundExplicitClosure: boolean;
  groupQuestionAudienceUnclear: boolean;
}): string {
  const groundedPlans = extractGroundedMessagesPlanFacts({
    messages: input.messages,
    getSpeakerLabel: (message) =>
      input.isGroup
        ? safeGroupParticipantLabel(message)
        : message.is_from_me
          ? 'You'
          : input.chatLabel,
    getSecondPersonLabel: input.isGroup
      ? undefined
      : (message) => (message.is_from_me ? input.chatLabel : 'You'),
  });
  const groundedPlan = groundedPlans.at(-1);
  const groundedPlanText = groundedPlan
    ? `Grounded plan: ${sanitizeSnippet(
        formatGroundedMessagesPlanFact(groundedPlan),
        170,
      )} Recent exchange: `
    : '';
  const otherLabel = input.isGroup ? null : input.chatLabel;
  const otherPossessive = recapOtherPossessive(input.chatLabel, input.isGroup);
  const turns = input.messages
    .filter((message) => substantiveMessage(message.content || ''))
    .slice(-4)
    .map((message) => {
      const speaker = input.isGroup
        ? safeGroupParticipantLabel(message)
        : message.is_from_me
          ? 'You'
          : otherLabel || 'They';
      return `${speaker}: "${sanitizeSnippet(message.content, 120)}"`;
    });
  const flow =
    turns.length > 0
      ? turns.join(' ')
      : input.latestInbound
        ? `${input.isGroup ? safeGroupParticipantLabel(input.latestInbound) : otherLabel || 'They'}: "${messageContent(input.latestInbound)}"`
        : 'There was recent synced Messages activity.';
  const boundedOpenAsks = input.unresolvedInboundAsks.slice(-3);
  const openAskState =
    boundedOpenAsks.length > 1
      ? input.isGroup
        ? `Current state: open group asks remain: ${boundedOpenAsks
            .map(
              (message) =>
                `${safeGroupParticipantLabel(message)}: "${messageContent(message)}"`,
            )
            .join('; ')}.`
        : `Current state: ${otherPossessive} open asks remain: ${boundedOpenAsks
            .map((message) => `"${messageContent(message)}"`)
            .join('; ')}.`
      : input.unresolvedInboundAsk
        ? input.isGroup
          ? `Current state: ${safeGroupParticipantLabel(input.unresolvedInboundAsk)}'s open ask is "${messageContent(input.unresolvedInboundAsk)}".`
          : input.unresolvedInboundAsk === input.latestInbound
            ? `Current state: ${otherPossessive} latest open ask is "${messageContent(input.unresolvedInboundAsk)}".`
            : `Current state: ${otherPossessive} earlier ask "${messageContent(input.unresolvedInboundAsk)}" is still open; ${otherPossessive} latest message adds "${messageContent(input.latestInbound)}".`
        : null;
  const state =
    input.section === 'needs_reply'
      ? openAskState
        ? openAskState
        : input.latestInbound
          ? `Current state: ${otherPossessive} latest open turn is "${messageContent(input.latestInbound)}".`
          : 'Current state: there may be an open reply owed.'
      : input.section === 'worth_watching'
        ? input.groupQuestionAudienceUnclear && boundedOpenAsks.length > 0
          ? `Current state: ${safeGroupParticipantLabel(boundedOpenAsks.at(-1)!)} asked "${messageContent(boundedOpenAsks.at(-1))}", but the intended responder is unclear.`
          : `Current state: worth watching because ${input.reasons[0] || 'there was recent activity'}.`
        : input.ownerWaitingOnThem
          ? input.isGroup
            ? 'Current state: your latest message asks for a group response, so the thread is waiting on the group.'
            : 'Current state: your latest message asks for their response, so the thread is waiting on them.'
          : input.ownerTurnResolved
            ? `Current state: your latest reply appears to have closed this for now.`
            : input.inboundExplicitClosure
              ? 'Current state: they explicitly said the request is closed or already handled.'
              : 'Current state: no obvious reply is needed from the recent exchange.';
  return `${input.chatLabel}: ${groundedPlanText}${flow} ${state}`;
}

function includesName(value: string, name: string): boolean {
  const normalizedName = normalizeText(name).toLowerCase();
  if (!normalizedName || normalizedName.length < 3) return false;
  const escapedName = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escapedName}(?=$|[^a-z0-9])`, 'i').test(
    normalizeText(value),
  );
}

function profileFactText(fact: ProfileFactWithSubject): string {
  const parsed = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
  const value =
    parsed && typeof parsed === 'object' && 'value' in parsed
      ? (parsed as { value?: unknown }).value
      : parsed;
  return [fact.sourceSummary, JSON.stringify(value)].filter(Boolean).join(' ');
}

function extractToneHintsFromFacts(facts: ProfileFactWithSubject[]): string[] {
  const hints = new Set<string>();
  for (const fact of facts) {
    const text = profileFactText(fact).toLowerCase();
    if (/\bwarm|kind|gentle|friendly\b/.test(text)) hints.add('warm');
    if (/\bconcise|brief|short\b/.test(text)) hints.add('concise');
    if (/\bdirect|plain|straight\b/.test(text)) hints.add('direct');
    if (/\bcareful|sensitive|thoughtful\b/.test(text)) hints.add('careful');
    if (/\bno promises|do not overcommit|without overcommitting\b/.test(text)) {
      hints.add('avoid_overcommitment');
    }
  }
  return [...hints].slice(0, 5);
}

function buildLearnedContextHints(input: {
  groupFolder: string;
  chatLabel: string;
  isGroup: boolean;
  messages: NewMessage[];
  context: LocalReviewContext;
}): {
  subjectIds: string[];
  lifeThreadIds: string[];
  whyHints: string[];
  existingThreadId?: string | null;
  confidence: RecentTextReviewContextConfidence;
  confidenceReason: string;
  relationshipWeight: number;
  relationshipReasons: string[];
  ambiguousIdentity: boolean;
  toneStyleHints: string[];
} {
  const existingThread = input.context.communicationThreads.find(
    (thread) => thread.channelChatJid === input.messages[0]?.chat_jid,
  );
  const identityReview = existingThread
    ? input.context.identityReviews.find(
        (review) => review.threadId === existingThread.id,
      )
    : undefined;
  const identityDismissed = identityReview?.decision === 'dismissed';
  const senderNames = Array.from(
    new Set(
      input.messages
        .filter((message) => !message.is_from_me)
        .map((message) => sanitizeSnippet(message.sender_name || '', 64))
        .filter(
          (name) =>
            name &&
            name !== 'Me' &&
            name !== input.chatLabel &&
            !/\+?\d[\d\s().-]{6,}\d/.test(name),
        ),
    ),
  );
  // Provider-owned chat metadata may identify a candidate for owner review,
  // but only an explicit owner decision activates relationship context.
  // Conversation bodies and generated summaries are content, not identity
  // evidence: "Bob said..." in Alice's thread must not turn Alice's chat into
  // Bob's relationship record.
  const identityEvidence = [input.chatLabel, ...senderNames].join(' ');
  const personSubjects = input.context.subjects.filter(
    (subject) => subject.kind === 'person',
  );
  const explicitlyConfirmedSubjectIds = new Set(
    input.isGroup
      ? []
      : identityReview?.decision === 'confirmed' &&
          identityReview.linkedSubjectId
        ? [identityReview.linkedSubjectId]
        : !identityReview && existingThread?.inferenceState === 'user_confirmed'
          ? existingThread.linkedSubjectIds
          : [],
  );
  const hasConfirmedIdentity =
    !input.isGroup &&
    !identityDismissed &&
    explicitlyConfirmedSubjectIds.size > 0;
  // Exact provider metadata remains useful for detecting an ambiguous review
  // candidate, but it is not an identity decision. Never activate or persist
  // person context until the owner confirms the link.
  const metadataMatchedSubjects =
    input.isGroup || identityDismissed || hasConfirmedIdentity
      ? []
      : personSubjects.filter(
          (subject) =>
            includesName(identityEvidence, subject.displayName) ||
            includesName(identityEvidence, subject.canonicalName),
        );
  const matchedSubjects = hasConfirmedIdentity
    ? personSubjects
        .filter((subject) => explicitlyConfirmedSubjectIds.has(subject.id))
        .slice(0, 4)
    : [];
  const subjectIds = matchedSubjects.map((subject) => subject.id);
  const subjectNames = matchedSubjects.map((subject) => subject.displayName);
  const canTrustExistingLifeThreadLinks =
    hasConfirmedIdentity && existingThread?.inferenceState === 'user_confirmed';
  const linkedLifeThreadIds = new Set(
    canTrustExistingLifeThreadLinks
      ? existingThread?.linkedLifeThreadIds || []
      : [],
  );
  const matchedLifeThreads = input.context.lifeThreads
    .filter((thread) => {
      if (thread.status === 'closed') return false;
      if (!hasConfirmedIdentity) return false;
      if (linkedLifeThreadIds.has(thread.id)) return true;
      return thread.relatedSubjectIds.some((id) => subjectIds.includes(id));
    })
    .slice(0, 4);
  const matchedGraphInsights = input.context.contextGraph.rankedInsights
    .filter((insight) => {
      if (!hasConfirmedIdentity) return false;
      const text = [
        insight.title,
        insight.reason,
        insight.nextAction,
        ...insight.relatedNodeIds,
      ].join(' ');
      if (
        existingThread &&
        insight.relatedNodeIds.some((id) => id.includes('communication_thread'))
      ) {
        return (
          includesName(text, existingThread.title) ||
          includesName(text, existingThread.lastInboundSummary || '') ||
          includesName(text, existingThread.id)
        );
      }
      return Boolean(
        includesName(text, input.chatLabel) ||
        senderNames.some((name) => includesName(text, name)) ||
        matchedLifeThreads.some((thread) => includesName(text, thread.title)),
      );
    })
    .slice(0, 3);
  const facts = input.context.facts
    .filter((fact) => subjectIds.includes(fact.subjectId))
    .slice(0, 5);
  const globalStyleFacts = input.context.facts
    .filter(
      (fact) =>
        fact.category === 'conversational_style' && fact.subjectKind === 'self',
    )
    .slice(0, 4);
  const toneStyleHints = Array.from(
    new Set([
      ...(hasConfirmedIdentity ? existingThread?.toneStyleHints || [] : []),
      ...extractToneHintsFromFacts(facts),
      ...extractToneHintsFromFacts(globalStyleFacts),
    ]),
  ).slice(0, 6);
  const confidence: RecentTextReviewContextConfidence =
    existingThread && hasConfirmedIdentity
      ? 'high'
      : matchedSubjects.length > 0 || matchedLifeThreads.length > 0
        ? 'medium'
        : input.chatLabel &&
            input.chatLabel !== 'Messages chat' &&
            input.chatLabel !== 'Messages group'
          ? 'medium'
          : 'low';
  const confidenceReason =
    existingThread && hasConfirmedIdentity
      ? 'matched an existing communication thread'
      : matchedSubjects.length > 0
        ? 'personal context graph matched learned person context'
        : matchedLifeThreads.length > 0
          ? 'personal context graph matched active life context'
          : confidence === 'medium'
            ? 'matched a safe synced chat label'
            : 'no learned person or thread match yet';
  const relationshipReasons: string[] = [];
  let relationshipWeight = 0;
  if (existingThread) {
    if (hasConfirmedIdentity) {
      relationshipWeight += 12;
      relationshipReasons.push('confirmed existing communication thread');
    }
    if (existingThread.followupState === 'reply_needed') {
      relationshipWeight += 18;
      relationshipReasons.push('thread already marked reply needed');
    } else if (existingThread.followupState === 'scheduled') {
      relationshipWeight += 6;
      relationshipReasons.push('thread already has a planned follow-up');
    } else if (existingThread.followupState === 'waiting_on_them') {
      relationshipWeight -= 6;
      relationshipReasons.push('thread is waiting on them');
    } else if (
      existingThread.followupState === 'resolved' ||
      existingThread.followupState === 'ignored'
    ) {
      relationshipWeight -= 18;
      relationshipReasons.push('thread was previously closed');
    }
    if (
      existingThread.urgency === 'tonight' ||
      existingThread.urgency === 'overdue'
    ) {
      relationshipWeight += 14;
      relationshipReasons.push('thread is time-sensitive');
    } else if (
      existingThread.urgency === 'soon' ||
      existingThread.urgency === 'tomorrow'
    ) {
      relationshipWeight += 7;
    }
    if (existingThread.suggestedNextAction === 'draft_reply') {
      relationshipWeight += 5;
    } else if (existingThread.suggestedNextAction === 'create_reminder') {
      relationshipWeight += 4;
    }
  }
  if (matchedSubjects.length > 0) {
    relationshipWeight += 10;
    relationshipReasons.push('known person');
  }
  if (matchedLifeThreads.length > 0) {
    relationshipWeight += 8;
    relationshipReasons.push('active life context');
  }
  if (matchedGraphInsights.length > 0) {
    const topInsight = matchedGraphInsights[0]!;
    relationshipWeight +=
      topInsight.kind === 'needs_reply'
        ? 14
        : topInsight.kind === 'slipping'
          ? 9
          : topInsight.kind === 'can_wait'
            ? -10
            : 5;
    relationshipReasons.push(
      `graph insight: ${topInsight.kind.replace(/_/g, ' ')}`,
    );
  }
  if (
    matchedLifeThreads.some(
      (thread) =>
        thread.sensitivity === 'sensitive' ||
        thread.followthroughMode === 'important_only',
    )
  ) {
    relationshipWeight += 8;
    relationshipReasons.push('sensitive or important life thread');
  }
  if (confidence === 'low') {
    relationshipWeight -= 8;
  }
  const ambiguousIdentity = metadataMatchedSubjects.length > 1;
  if (ambiguousIdentity) {
    relationshipWeight -= 12;
    relationshipReasons.push('ambiguous person match');
  }
  relationshipWeight = Math.max(-24, Math.min(44, relationshipWeight));
  return {
    subjectIds,
    lifeThreadIds: matchedLifeThreads.map((thread) => thread.id),
    existingThreadId: existingThread?.id || null,
    confidence,
    confidenceReason,
    relationshipWeight,
    relationshipReasons,
    ambiguousIdentity,
    toneStyleHints,
    whyHints: [
      ...subjectNames.map(() => 'known person'),
      ...matchedLifeThreads.map(() => 'linked thread: active life context'),
      existingThread ? 'existing communication thread' : null,
      ...matchedGraphInsights.map(
        (insight) => `graph insight: ${insight.kind.replace(/_/g, ' ')}`,
      ),
    ].filter(Boolean) as string[],
  };
}

function buildSuggestedReplyOptions(input: {
  latestInbound: NewMessage | undefined;
  directQuestion: boolean;
  sensitive: boolean;
  deadline: boolean;
  isGroup: boolean;
  contextConfidence: RecentTextReviewContextConfidence;
  riskFlags: string[];
  toneStyleHints: string[];
}): RecentTextReviewSuggestedReply[] {
  if (!input.latestInbound) return [];
  const text = normalizeText(input.latestInbound.content);
  if (
    !substantiveMessage(text) ||
    acknowledgementOnlyMessage(text) ||
    input.directQuestion
  ) {
    // The local review does not know the owner's answer. An acknowledgement
    // masquerading as an answer is not a safe draft option.
    return [];
  }
  return buildThreadGroundedSuggestedReplies({
    inboundText: text,
    isGroup: input.isGroup,
    sensitive: input.sensitive,
    deadline: input.deadline,
    toneStyleHints: input.toneStyleHints,
    contextConfidence: input.riskFlags.includes('ambiguous_identity')
      ? 'low'
      : input.contextConfidence,
  });
}

function withAvailableReplyContext(
  message: NewMessage,
  messagesById: Map<string, NewMessage>,
): NewMessage {
  if (message.reply_to?.content || !message.reply_to_id) return message;
  const target = messagesById.get(message.reply_to_id);
  if (!target) return message;
  return {
    ...message,
    reply_to: {
      message_id: target.id,
      content: target.content,
      sender: target.sender,
      sender_name: target.sender_name,
      is_from_me: target.is_from_me,
      is_bot_message: target.is_bot_message,
      timestamp: target.timestamp,
    },
  };
}

function classifyThread(input: {
  groupFolder: string;
  chat: ChatInfo;
  messages: NewMessage[];
  context: LocalReviewContext;
}): CandidateAnalysis | null {
  const sourceChannel =
    input.chat.channel === 'telegram'
      ? 'telegram'
      : input.chat.channel === 'bluebubbles' || input.chat.jid.startsWith('bb:')
        ? 'bluebubbles'
        : input.chat.jid.startsWith('tg:')
          ? 'telegram'
          : 'bluebubbles';
  const messagesById = new Map(
    input.messages.map((message) => [message.id, message]),
  );
  const messages = input.messages
    .filter(
      (message) =>
        !message.is_bot_message && describeMessageForSummary(message),
    )
    .map((message) => withAvailableReplyContext(message, messagesById))
    .map((message) => ({
      ...message,
      content: describeMessageForSummary(message),
    }));
  if (messages.length === 0) return null;
  const latest = latestMessage(messages);
  const latestInbound = findLatestInbound(messages);
  const latestOutbound = findLatestOutbound(messages);
  const unresolvedInboundAsks = findUnresolvedInboundAsks(messages);
  const ownerDirectedGroupAsks = input.chat.is_group
    ? unresolvedInboundAsks.filter((ask) =>
        isGroupAskExplicitlyAddressedToOwner({ ask, messages }),
      )
    : unresolvedInboundAsks;
  const unresolvedInboundAsk = ownerDirectedGroupAsks.at(-1);
  const groupQuestionAudienceUnclear = Boolean(
    input.chat.is_group &&
    unresolvedInboundAsks.length > 0 &&
    ownerDirectedGroupAsks.length === 0,
  );
  const chatLabel = safeChatLabel(input.chat);
  const latestInboundText = normalizeText(latestInbound?.content || '');
  const unresolvedInboundAskText = normalizeText(
    unresolvedInboundAsk?.content || '',
  );
  const latestOutboundText = normalizeText(latestOutbound?.content || '');
  const latestText = normalizeText(latest?.content || '');
  const reactionOnlyLatest = isBlueBubblesReactionPlaceholder(
    input.messages.find((message) => message.id === latest?.id)?.content,
  );
  const directQuestion = Boolean(unresolvedInboundAsk);
  const directActionRequest = Boolean(
    unresolvedInboundAsk &&
    hasDirectImperativeActionRequest(unresolvedInboundAskText),
  );
  const deadline = hasDeadline(
    [unresolvedInboundAskText, latestInboundText].filter(Boolean).join(' '),
  );
  const sensitive = hasSensitiveSignal(
    [unresolvedInboundAskText, latestInboundText, latestText].join(' '),
  );
  const automatedSignal = detectAutomatedMessageSignal(latestInboundText);
  const securityCredentialQuestion =
    isSecurityCredentialQuestion(latestInboundText);
  const ownerMessageLatest = Boolean(latest?.is_from_me);
  const latestInboundOpenTurn = Boolean(latestInbound && !latest?.is_from_me);
  const confusionReply = Boolean(
    latestInboundOpenTurn && hasConfusionReply(latestInboundText),
  );
  const latestInboundAfterOutbound = Boolean(
    latestInboundOpenTurn && latestOutbound,
  );
  const inboundHasClosure = hasExplicitClosureSignal(latestInboundText);
  const inboundExplicitClosure = Boolean(
    latestInboundOpenTurn &&
    inboundHasClosure &&
    !hasOpenQuestionAfterExplicitClosure(latestInboundText),
  );
  const outboundHasClosure = hasExplicitClosureSignal(latestOutboundText);
  const ownerWaitingOnThem = Boolean(
    ownerMessageLatest &&
    hasDirectQuestion(latestOutboundText) &&
    (!outboundHasClosure ||
      hasOpenQuestionAfterExplicitClosure(latestOutboundText)),
  );
  const ownerTurnResolved = Boolean(
    ownerMessageLatest &&
    unresolvedInboundAsks.length === 0 &&
    !ownerWaitingOnThem &&
    (outboundHasClosure ||
      outboundLikelyAddressesInbound({
        inbound: latestInbound,
        outbound: latestOutbound,
      })),
  );
  const learned = buildLearnedContextHints({
    groupFolder: input.groupFolder,
    chatLabel,
    isGroup: Boolean(input.chat.is_group),
    messages,
    context: input.context,
  });
  const riskFlags = [
    input.chat.is_group ? 'group_chat_confirm_audience' : null,
    sensitive ? 'sensitive_tone' : null,
    learned.confidence === 'low' ? 'low_context_confidence' : null,
    learned.ambiguousIdentity ? 'ambiguous_identity' : null,
    directQuestion && !automatedSignal ? 'needs_owner_answer' : null,
    directActionRequest && !automatedSignal ? 'needs_owner_action' : null,
    groupQuestionAudienceUnclear ? 'group_question_audience_unclear' : null,
    securityCredentialQuestion ? 'security_credential_question' : null,
    confusionReply ? 'needs_owner_context' : null,
    ownerMessageLatest ? 'self_authored_latest' : null,
    automatedSignal?.kind === 'marketing_or_survey'
      ? 'automated_marketing_or_survey'
      : null,
    automatedSignal?.kind === 'transactional_notice'
      ? 'automated_transactional_notice'
      : null,
    reactionOnlyLatest ? 'reaction_only' : null,
  ].filter(Boolean) as string[];
  let score = 0;
  const reasons: string[] = [];
  if (latestInboundOpenTurn) {
    score += 42;
    reasons.push(
      input.chat.is_group
        ? groupQuestionAudienceUnclear
          ? 'latest group question has an unclear intended responder'
          : directQuestion
            ? 'latest group question is explicitly directed to you'
            : 'latest group message may need attention'
        : latestInboundAfterOutbound
          ? 'latest message from them after your last reply'
          : 'latest message from them is awaiting your reply',
    );
  }
  if (directQuestion) {
    score += 28;
    reasons.push(
      directActionRequest
        ? 'asks for an answer or asks you to take an action'
        : 'asks for an answer',
    );
  }
  if (
    ownerMessageLatest &&
    !input.chat.is_group &&
    unresolvedInboundAsks.length > 0
  ) {
    score += 30;
    reasons.push(
      unresolvedInboundAsks.length > 1
        ? 'multiple earlier asks remain open after your latest message'
        : 'an earlier ask remains open after your latest message',
    );
  }
  if (confusionReply) {
    score += 40;
    reasons.push(
      'their latest reply signals confusion about the prior message',
    );
  }
  if (learned.subjectIds.length > 0) {
    score += 8;
    reasons.push(learned.whyHints[0] || 'ties to learned context');
  }
  if (learned.lifeThreadIds.length > 0) {
    score += 8;
    if (!reasons.some((line) => /^linked thread:/.test(line))) {
      reasons.push(
        learned.whyHints.find((line) => /^linked thread:/.test(line)) ||
          'ties to an active life thread',
      );
    }
  }
  if (deadline) {
    score += 16;
    reasons.push('has timing pressure');
  }
  if (sensitive) {
    score += 14;
    reasons.push('could use careful tone');
  }
  if (learned.relationshipWeight !== 0) {
    score += learned.relationshipWeight;
    reasons.push(
      ...(learned.relationshipReasons.length > 0
        ? learned.relationshipReasons.slice(0, 2)
        : learned.relationshipWeight > 0
          ? ['relationship context raises priority']
          : ['relationship context lowers priority']),
    );
  }
  if (ownerTurnResolved) {
    score -= 38;
    reasons.push('your latest reply appears to have answered it');
  }
  if (
    latestInboundOpenTurn &&
    !directQuestion &&
    !deadline &&
    !sensitive &&
    /\b(?:lol|haha|fun|nice|cool|awesome|thanks|thx|ok|okay)\b/i.test(
      latestInboundText,
    )
  ) {
    score -= 28;
  }
  if (
    !substantiveMessage(latestInboundText) &&
    !substantiveMessage(unresolvedInboundAskText)
  ) {
    score -= 36;
  }
  if (input.chat.is_group && learned.confidence !== 'high') {
    score -= 8;
  }

  if (groupQuestionAudienceUnclear) {
    score = Math.min(score, 45);
  }

  if (securityCredentialQuestion) {
    score = Math.min(score, 0);
    reasons.splice(
      0,
      reasons.length,
      'message asks about a security credential',
      'not treated as an actionable reply request',
    );
  }

  if (reactionOnlyLatest && !unresolvedInboundAsk) {
    score = Math.min(score, 0);
    reasons.splice(
      0,
      reasons.length,
      'their latest activity is a message reaction',
      'no conversational reply is currently owed',
    );
  }

  if (inboundExplicitClosure) {
    score = Math.min(score, 0);
    reasons.splice(
      0,
      reasons.length,
      'they explicitly said the request is closed or already handled',
      'no reply is currently owed',
    );
  }

  if (
    !inboundExplicitClosure &&
    automatedSignal?.kind === 'marketing_or_survey'
  ) {
    score = Math.min(score, 8);
    reasons.splice(
      0,
      reasons.length,
      'automated survey or promotion',
      'no personal reply appears necessary',
    );
  } else if (
    !inboundExplicitClosure &&
    automatedSignal?.kind === 'transactional_notice'
  ) {
    score = Math.min(score, automatedSignal.requiresOwnerAction ? 34 : 12);
    reasons.splice(
      0,
      reasons.length,
      automatedSignal.requiresOwnerAction
        ? automatedSignal.expectsConfirmation
          ? 'automated confirmation request'
          : 'automated account, invoice, or payment action'
        : 'automated service or transactional notice',
      automatedSignal.requiresOwnerAction
        ? automatedSignal.expectsConfirmation
          ? 'may require a short confirmation through the stated channel'
          : 'may require review or action outside the conversation'
        : 'appears informational rather than conversational',
    );
  }

  const section: RecentTextReviewSection =
    (reactionOnlyLatest && !unresolvedInboundAsk) ||
    inboundExplicitClosure ||
    ownerTurnResolved ||
    ownerWaitingOnThem ||
    securityCredentialQuestion
      ? 'no_reply_needed'
      : confusionReply
        ? 'needs_reply'
        : groupQuestionAudienceUnclear
          ? 'worth_watching'
          : automatedSignal
            ? automatedSignal.kind === 'transactional_notice' &&
              automatedSignal.requiresOwnerAction
              ? 'worth_watching'
              : 'no_reply_needed'
            : score >= 52
              ? 'needs_reply'
              : score >= 26
                ? 'worth_watching'
                : 'no_reply_needed';
  const summaryText = buildConversationRecap({
    chatLabel,
    isGroup: Boolean(input.chat.is_group),
    messages,
    latestInbound,
    unresolvedInboundAsk,
    unresolvedInboundAsks,
    latestOutbound,
    section,
    reasons,
    ownerTurnResolved,
    ownerWaitingOnThem,
    inboundExplicitClosure,
    groupQuestionAudienceUnclear,
  });
  const recommendedAction =
    reactionOnlyLatest && !unresolvedInboundAsk
      ? 'No reply needed; the latest activity is only a message reaction.'
      : inboundExplicitClosure
        ? 'No reply needed; they explicitly said the request is closed or already handled.'
        : ownerWaitingOnThem
          ? 'Wait for their response; your latest message asks them for the next turn.'
          : ownerTurnResolved
            ? 'No reply needed; your latest message appears to directly answer the open turn.'
            : confusionReply
              ? 'Review the preceding exchange and decide what clarification you want to give. No automatic draft or send is appropriate without that context.'
              : securityCredentialQuestion
                ? 'Do not share a verification or security code. This message was not treated as an actionable reply request.'
                : groupQuestionAudienceUnclear
                  ? 'Check who the group question is addressed to before taking action; it is not assumed to be assigned to you.'
                  : automatedSignal
                    ? automatedSignal.kind === 'marketing_or_survey'
                      ? 'No reply needed; ignore unless you personally want to use the offer or survey.'
                      : automatedSignal.requiresOwnerAction
                        ? automatedSignal.expectsConfirmation
                          ? 'Verify the appointment or order details, then confirm only if they are correct.'
                          : 'Review the account, invoice, or payment details through a trusted channel; no conversational reply is needed.'
                        : 'Treat as informational; no conversational reply is needed.'
                    : section === 'needs_reply'
                      ? directQuestion
                        ? directActionRequest
                          ? 'Review the request and decide how you want to handle it. No draft suggested. No automatic action or conversational reply draft will be generated.'
                          : 'No draft suggested; provide the answer you want to send before asking me to word it.'
                        : input.chat.is_group
                          ? 'Say `draft #` only if you want a group-chat acknowledgement to review first.'
                          : 'Review the suggested acknowledgement or say `draft #` to make an approval-gated draft.'
                      : section === 'worth_watching'
                        ? 'Keep it visible; draft only if you want to close the loop.'
                        : 'No action unless you want to add context.';
  const itemId = `text-review:${hashText(`${input.chat.jid}:${latest?.id || latest?.timestamp || ''}`)}`;
  const freshnessSnapshot = buildMessagesThreadFreshnessSnapshot({
    chatJid: input.chat.jid,
    messages,
  });
  const suggestedReplies =
    section === 'needs_reply'
      ? buildSuggestedReplyOptions({
          latestInbound,
          directQuestion,
          sensitive,
          deadline,
          isGroup: Boolean(input.chat.is_group),
          contextConfidence: learned.confidence,
          riskFlags,
          toneStyleHints: learned.toneStyleHints,
        })
      : [];
  const item: RecentTextReviewItem = {
    itemId,
    rank: 0,
    section,
    priorityScore: score,
    sourceChannel,
    chatJid: input.chat.jid,
    chatLabel,
    isGroup: Boolean(input.chat.is_group),
    latestMessageId: latest?.id,
    latestMessageAt: latest?.timestamp,
    latestInboundAt: latestInbound?.timestamp,
    latestOutboundAt: latestOutbound?.timestamp,
    freshnessSnapshot,
    summaryText,
    whyText:
      reasons.length > 0
        ? reasons.slice(0, 3).join('; ')
        : 'recent synced Messages activity',
    recommendedAction,
    suggestedReply: suggestedReplies[0]?.text || null,
    suggestedReplies,
    evidenceSnippets: messages
      .slice(-3)
      .map((message) => {
        const speaker = input.chat.is_group
          ? safeGroupParticipantLabel(message)
          : message.is_from_me
            ? 'You'
            : 'Them';
        return `${speaker}: ${sanitizeSnippet(message.content, 160)}`;
      })
      .filter(Boolean),
    linkedSubjectIds: learned.subjectIds,
    linkedLifeThreadIds: learned.lifeThreadIds,
    communicationThreadId: learned.existingThreadId || null,
    contextLink: {
      participantKind: input.chat.is_group ? 'group' : 'direct',
      confidence: learned.confidence,
      reason: learned.confidenceReason,
      riskFlags,
      communicationThreadId: learned.existingThreadId || null,
    },
    riskFlags,
  };
  return {
    item,
    sourceChannel,
    persist:
      section !== 'no_reply_needed' ||
      ownerWaitingOnThem ||
      Boolean(learned.existingThreadId),
    followupState: ownerWaitingOnThem
      ? 'waiting_on_them'
      : section === 'needs_reply'
        ? 'reply_needed'
        : section === 'no_reply_needed'
          ? 'resolved'
          : 'unknown',
    suggestedAction:
      section === 'needs_reply'
        ? directActionRequest
          ? null
          : 'draft_reply'
        : section === 'worth_watching'
          ? 'save_for_later'
          : null,
    urgency:
      section === 'needs_reply' && deadline
        ? 'tonight'
        : section === 'needs_reply'
          ? 'soon'
          : 'none',
    latestDirection: latest?.is_from_me ? 'outbound' : 'inbound',
    latestInboundSummary: latestInbound
      ? `${chatLabel}: "${messageContent(latestInbound)}"`
      : null,
    latestOutboundSummary: latestOutbound
      ? `${chatLabel}: "${messageContent(latestOutbound)}"`
      : null,
  };
}

function persistReviewItem(input: {
  groupFolder: string;
  analysis: CandidateAnalysis;
  existingThreads: CommunicationThreadRecord[];
  nowIso: string;
}): RecentTextReviewItem {
  const { item } = input.analysis;
  const existing = input.existingThreads.find(
    (thread) => thread.channelChatJid === item.chatJid,
  );
  const hasGenuinelyNewerActivity = existing
    ? !existing.lastMessageId ||
      (existing.lastMessageId !== item.latestMessageId &&
        compareIsoTimestamp(item.latestMessageAt, existing.lastContactAt) > 0)
    : true;
  const preserveCanonicalState = Boolean(
    existing && !hasGenuinelyNewerActivity,
  );
  const followupState = preserveCanonicalState
    ? existing!.followupState
    : input.analysis.followupState;
  const urgency = preserveCanonicalState
    ? existing!.urgency
    : input.analysis.urgency;
  const suggestedAction = preserveCanonicalState
    ? existing!.suggestedNextAction || null
    : input.analysis.suggestedAction;
  const followupDueAt = preserveCanonicalState
    ? existing!.followupDueAt || null
    : followupState === 'resolved'
      ? null
      : existing?.followupDueAt || null;
  const lastContactAt =
    compareIsoTimestamp(item.latestMessageAt, existing?.lastContactAt) > 0
      ? item.latestMessageAt || input.nowIso
      : existing?.lastContactAt || item.latestMessageAt || input.nowIso;
  const lastMessageId =
    hasGenuinelyNewerActivity || !existing?.lastMessageId
      ? item.latestMessageId || existing?.lastMessageId || null
      : existing.lastMessageId;
  const threadId =
    existing?.id ||
    `communication_thread:recent_text:${hashText(item.chatJid)}`;
  upsertCommunicationThread({
    id: threadId,
    groupFolder: input.groupFolder,
    title: item.chatLabel,
    linkedSubjectIds: item.linkedSubjectIds,
    linkedLifeThreadIds: item.linkedLifeThreadIds,
    channel: input.analysis.sourceChannel,
    channelChatJid: item.chatJid,
    lastInboundSummary:
      input.analysis.latestInboundSummary ||
      existing?.lastInboundSummary ||
      null,
    lastOutboundSummary:
      input.analysis.latestOutboundSummary ||
      existing?.lastOutboundSummary ||
      null,
    followupState,
    urgency,
    followupDueAt,
    suggestedNextAction: suggestedAction,
    toneStyleHints: existing?.toneStyleHints || [],
    lastContactAt,
    lastMessageId,
    linkedTaskId: existing?.linkedTaskId || null,
    inferenceState: existing?.inferenceState || 'assistant_inferred',
    trackingMode: existing?.trackingMode || 'default',
    createdAt: existing?.createdAt || input.nowIso,
    updatedAt: input.nowIso,
    disabledAt: existing?.disabledAt || null,
  });
  upsertCommunicationSignal({
    id: `communication_signal:recent_text:${hashText(item.itemId)}`,
    communicationThreadId: threadId,
    groupFolder: input.groupFolder,
    sourceChannel: input.analysis.sourceChannel,
    chatJid: item.chatJid,
    messageId: lastMessageId,
    direction: input.analysis.latestDirection,
    summaryText:
      input.analysis.latestDirection === 'outbound'
        ? input.analysis.latestOutboundSummary || item.summaryText
        : input.analysis.latestInboundSummary || item.summaryText,
    followupState,
    suggestedAction,
    urgency,
    createdAt: input.nowIso,
  });
  const preservedSection: RecentTextReviewSection =
    followupState === 'reply_needed'
      ? 'needs_reply'
      : followupState === 'scheduled'
        ? 'worth_watching'
        : followupState === 'waiting_on_them' ||
            followupState === 'resolved' ||
            followupState === 'ignored'
          ? 'no_reply_needed'
          : item.section;
  const preservedRecommendedAction =
    preserveCanonicalState && followupState === 'resolved'
      ? 'Already marked handled; it will reopen only if newer Messages activity arrives.'
      : preserveCanonicalState && followupState === 'ignored'
        ? 'Already skipped; it will reopen only if newer Messages activity arrives.'
        : preserveCanonicalState && followupState === 'scheduled'
          ? 'A follow-up is already scheduled; do not create a duplicate from the same Messages activity.'
          : preserveCanonicalState && followupState === 'waiting_on_them'
            ? 'Wait for their response; no newer Messages activity requires another reply.'
            : item.recommendedAction;
  const preservedStateSummary =
    preserveCanonicalState && followupState === 'resolved'
      ? 'Current state: you marked this handled, and no newer Messages activity has arrived.'
      : preserveCanonicalState && followupState === 'ignored'
        ? 'Current state: you skipped this, and no newer Messages activity has arrived.'
        : preserveCanonicalState && followupState === 'scheduled'
          ? 'Current state: follow-up is already scheduled from this activity, and no newer Messages activity has arrived.'
          : preserveCanonicalState && followupState === 'waiting_on_them'
            ? 'Current state: the thread is still waiting on them; no newer Messages activity requires another reply.'
            : null;
  const preservedWhyText =
    preserveCanonicalState && followupState === 'resolved'
      ? 'no newer Messages activity since you marked it handled'
      : preserveCanonicalState && followupState === 'ignored'
        ? 'no newer Messages activity since you skipped it'
        : preserveCanonicalState && followupState === 'scheduled'
          ? 'no newer Messages activity since follow-up was scheduled'
          : preserveCanonicalState && followupState === 'waiting_on_them'
            ? 'no newer Messages activity while the thread is waiting on them'
            : item.whyText;
  const preservedSummaryText = preservedStateSummary
    ? `${item.summaryText.replace(/\s+Current state:.*$/i, '').trim()} ${preservedStateSummary}`
    : item.summaryText;
  return {
    ...item,
    section: preserveCanonicalState ? preservedSection : item.section,
    summaryText: preservedSummaryText,
    whyText: preservedWhyText,
    recommendedAction: preservedRecommendedAction,
    suggestedReply:
      preserveCanonicalState && preservedSection !== 'needs_reply'
        ? null
        : item.suggestedReply,
    suggestedReplies:
      preserveCanonicalState && preservedSection !== 'needs_reply'
        ? []
        : item.suggestedReplies,
    communicationThreadId: threadId,
    contextLink: {
      ...item.contextLink,
      communicationThreadId: threadId,
      confidence:
        item.contextLink.confidence === 'low'
          ? 'medium'
          : item.contextLink.confidence,
      reason:
        item.contextLink.reason === 'no learned person or thread match yet'
          ? 'stored a summary-level communication thread for follow-up'
          : item.contextLink.reason,
    },
  };
}

function extractResponseOutputText(payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const chunk of content) {
      const chunkRecord =
        chunk && typeof chunk === 'object'
          ? (chunk as Record<string, unknown>)
          : {};
      if (
        chunkRecord.type === 'output_text' &&
        typeof chunkRecord.text === 'string'
      ) {
        parts.push(chunkRecord.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function stripJsonFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function containsUnsupportedFuturePromise(text: string): boolean {
  const normalized = normalizeText(text);
  return (
    /\b(?:i am|i'm)\s+(?:checking|confirming|looking(?: into)?|working on|following up)\b/i.test(
      normalized,
    ) ||
    /\b(?:will|i'll|we'll|i will|we will)\s+(?:check|confirm|get back|send|let you know|follow up|look into|take a look|review|verify|circle back)\b/i.test(
      normalized,
    ) ||
    /\blet me\s+(?:check|confirm|look into|take a look|review|verify|follow up)\b/i.test(
      normalized,
    ) ||
    /\b(?:checking|looking into|working on)\b[^.!?]{0,80}\b(?:now|soon|shortly)\b/i.test(
      normalized,
    )
  );
}

function normalizeSuggestedReplies(
  value: unknown,
  options: { rejectUnsupportedPromises?: boolean } = {},
): RecentTextReviewSuggestedReply[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === 'string') {
        const text = sanitizeSnippet(item, 220);
        return text &&
          !(
            options.rejectUnsupportedPromises &&
            containsUnsupportedFuturePromise(text)
          )
          ? {
              label: index === 0 ? 'suggested' : `option ${index + 1}`,
              text,
            }
          : null;
      }
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const text = sanitizeSnippet(String(record.text || ''), 220);
      if (
        !text ||
        (options.rejectUnsupportedPromises &&
          containsUnsupportedFuturePromise(text))
      ) {
        return null;
      }
      return {
        label:
          sanitizeSnippet(String(record.label || ''), 32) ||
          `option ${index + 1}`,
        text,
      };
    })
    .filter((item): item is RecentTextReviewSuggestedReply => Boolean(item))
    .slice(0, 3);
}

function automatedMessageKindForItem(
  item: RecentTextReviewItem,
): AutomatedMessageKind | null {
  if (item.riskFlags.includes('automated_marketing_or_survey')) {
    return 'marketing_or_survey';
  }
  if (item.riskFlags.includes('automated_transactional_notice')) {
    return 'transactional_notice';
  }
  return null;
}

const REVIEW_PROVIDER_GROUNDING_STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'before',
  'from',
  'have',
  'message',
  'reply',
  'should',
  'that',
  'their',
  'them',
  'there',
  'these',
  'they',
  'this',
  'with',
  'would',
  'your',
]);

const REVIEW_PROVIDER_HIGH_IMPACT_FACTS = [
  'no',
  'not',
  'never',
  'without',
  "can't",
  'cannot',
  "won't",
  "didn't",
  "doesn't",
  "isn't",
  "aren't",
  "wasn't",
  "weren't",
  "hasn't",
  "haven't",
  "hadn't",
  'agreed',
  'accepted',
  'approved',
  'booked',
  'cancelled',
  'canceled',
  'closed',
  'committed',
  'completed',
  'confirmed',
  'decided',
  'declined',
  'delayed',
  'due',
  'handled',
  'overdue',
  'paid',
  'promised',
  'rejected',
  'resolved',
  'scheduled',
  'sent',
  'unavailable',
  'available',
  'yesterday',
  'today',
  'tonight',
  'tomorrow',
  'morning',
  'afternoon',
  'evening',
  'weekend',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const REVIEW_PROVIDER_ALLOWED_CAPITALIZED_WORDS = new Set([
  'a',
  'an',
  'another',
  'by',
  'conversation',
  'current',
  'finally',
  'here',
  'i',
  'in',
  'it',
  'later',
  'latest',
  'messages',
  'needs',
  'no',
  'one',
  'open',
  'pending',
  'reply',
  'someone',
  'the',
  'their',
  'they',
  'this',
  'we',
  'why',
  'you',
]);

const REVIEW_PROVIDER_NEGATION_PATTERN =
  /\b(?:no|not|never|without|cannot|can['’]t|won['’]t|didn['’]t|doesn['’]t|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t)\b/i;

const REVIEW_PROVIDER_NEGATION_SCOPE_STOPWORDS = new Set([
  'about',
  'also',
  'and',
  'are',
  'because',
  'been',
  'being',
  'but',
  'can',
  'could',
  'does',
  'from',
  'had',
  'has',
  'have',
  'into',
  'its',
  'not',
  'that',
  'the',
  'their',
  'them',
  'they',
  'this',
  'was',
  'were',
  'with',
  'would',
]);

function reviewProviderGroundingTokens(value: string): string[] {
  return normalizeText(value)
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(
      (token) =>
        token.length >= 4 &&
        !REVIEW_PROVIDER_GROUNDING_STOPWORDS.has(token) &&
        !/^\d+$/.test(token),
    );
}

function canonicalReviewProviderWord(value: string): string {
  return value.toLowerCase().replace(/['’-]/g, '');
}

function hasUnsupportedReviewProviderProperNoun(
  value: string,
  evidenceText: string,
): boolean {
  const evidenceWords = new Set(
    normalizeText(evidenceText)
      .split(/[^A-Za-z0-9'’-]+/)
      .map(canonicalReviewProviderWord)
      .filter(Boolean),
  );
  return [...value.matchAll(/\b[A-Z][A-Za-z0-9'’-]{2,}\b/g)].some((match) => {
    const token = canonicalReviewProviderWord(match[0] || '');
    return (
      !REVIEW_PROVIDER_ALLOWED_CAPITALIZED_WORDS.has(token) &&
      !evidenceWords.has(token)
    );
  });
}

function hasUnsupportedReviewProviderFact(
  value: string,
  evidenceText: string,
): boolean {
  const normalizedValue = normalizeText(value).toLowerCase();
  const normalizedEvidence = normalizeText(evidenceText).toLowerCase();
  return REVIEW_PROVIDER_HIGH_IMPACT_FACTS.some((fact) => {
    const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
    return pattern.test(normalizedValue) && !pattern.test(normalizedEvidence);
  });
}

function reviewProviderNegationScopes(value: string): string[][] {
  return normalizeText(value)
    .split(/[.!?;]|\b(?:although|however|instead|whereas)\b/i)
    .filter((clause) => REVIEW_PROVIDER_NEGATION_PATTERN.test(clause))
    .map((clause) =>
      clause
        .toLowerCase()
        .replace(/[’]/g, "'")
        .replace(REVIEW_PROVIDER_NEGATION_PATTERN, ' ')
        .split(/[^a-z0-9]+/)
        .filter(
          (token) =>
            token.length >= 3 &&
            !REVIEW_PROVIDER_NEGATION_SCOPE_STOPWORDS.has(token),
        ),
    )
    .filter((tokens) => tokens.length > 0);
}

function hasUnsupportedReviewProviderNegation(
  value: string,
  evidenceText: string,
): boolean {
  const claimScopes = reviewProviderNegationScopes(value);
  if (claimScopes.length === 0) return false;
  const evidenceScopes = reviewProviderNegationScopes(evidenceText);
  if (evidenceScopes.length === 0) return true;
  return claimScopes.some((claimTokens) => {
    const minimumAnchors = Math.min(2, claimTokens.length);
    return !evidenceScopes.some((evidenceTokens) => {
      const evidenceSet = new Set(evidenceTokens);
      const anchors = new Set(
        claimTokens.filter((token) => evidenceSet.has(token)),
      );
      return (
        anchors.size >= minimumAnchors &&
        anchors.size / claimTokens.length >= 0.5
      );
    });
  });
}

function isRecentTextProviderPatchGrounded(
  item: RecentTextReviewItem,
  value: string,
): boolean {
  const sanitized = sanitizeSnippet(value, 300);
  if (!sanitized || /\b(?:https?:\/\/|www\.)/i.test(sanitized)) return false;
  const evidenceText = [
    item.chatLabel,
    item.summaryText,
    item.whyText,
    ...item.evidenceSnippets,
  ].join(' ');
  const evidenceNumbers = new Set(evidenceText.match(/\b\d+\b/g) || []);
  const unsupportedNumber = (sanitized.match(/\b\d+\b/g) || []).some(
    (number) => !evidenceNumbers.has(number),
  );
  if (
    unsupportedNumber ||
    hasUnsupportedReviewProviderFact(sanitized, evidenceText) ||
    hasUnsupportedReviewProviderNegation(sanitized, evidenceText) ||
    hasMessagesGroundingPolarityConflict({
      claimText: sanitized,
      evidenceText,
    }) ||
    hasUnsupportedReviewProviderProperNoun(sanitized, evidenceText)
  ) {
    return false;
  }
  const evidenceTokens = new Set(reviewProviderGroundingTokens(evidenceText));
  const claimTokens = reviewProviderGroundingTokens(sanitized);
  if (claimTokens.length === 0 || evidenceTokens.size === 0) return false;
  const anchors = new Set(
    claimTokens.filter((token) => evidenceTokens.has(token)),
  );
  const minimumAnchors = claimTokens.length <= 5 ? 1 : 2;
  return (
    anchors.size >= minimumAnchors && anchors.size / claimTokens.length >= 0.25
  );
}

export function buildRecentTextReviewProviderPrompt(input: {
  windowLabel: string;
  items: RecentTextReviewItem[];
}): string {
  const sanitizedItems = input.items
    .slice(0, MAX_PROVIDER_ITEMS)
    .map((item) => ({
      itemId: item.itemId,
      section: item.section,
      priorityScore: item.priorityScore,
      chatLabel: sanitizeSnippet(item.chatLabel, 72),
      summaryText: sanitizeSnippet(item.summaryText, 220),
      whyText: sanitizeSnippet(item.whyText, 180),
      recommendedAction: sanitizeSnippet(item.recommendedAction, 160),
      contextConfidence: item.contextLink.confidence,
      riskFlags: item.riskFlags.map((flag) => sanitizeSnippet(flag, 64)),
      evidenceSnippets: item.evidenceSnippets
        .slice(0, 3)
        .map((snippet) => sanitizeSnippet(snippet, 160)),
    }));
  return [
    'You are Andrea reviewing recent synced Messages interactions for the user.',
    'Return JSON only with key items.',
    'Do not include phone numbers, JIDs, raw identifiers, secrets, or private transcript bodies beyond the sanitized snippets provided.',
    'Stay grounded in the provided review items and snippets; do not invent commitments or availability.',
    'Each item may include summaryText and whyText.',
    'summaryText should be a fuller recap of the recent exchange and current state, not just one activity stat.',
    'Do not add or rewrite recommendedAction, suggestedReply, or suggestedReplies; all action and outbound wording stays on the deterministic local lane.',
    `Window: ${sanitizeSnippet(input.windowLabel, 80)}`,
    `Review items: ${JSON.stringify(sanitizedItems)}`,
  ].join('\n');
}

async function enhanceWithProvider(input: {
  result: RecentTextReviewResult;
  cloudAnalysisMode: 'auto' | 'disabled';
}): Promise<RecentTextReviewResult> {
  if (
    input.cloudAnalysisMode === 'disabled' ||
    input.result.items.length === 0 ||
    process.env.NODE_ENV === 'test'
  ) {
    return input.result;
  }
  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) return input.result;
  const providerMode = detectOpenAiProviderMode(openAi.baseUrl);
  const prompt = buildRecentTextReviewProviderPrompt({
    windowLabel: input.result.window.label,
    items: input.result.items,
  });
  const modelCandidates = buildOpenAiModelCandidates('standard', {
    simpleModel: openAi.simpleModel,
    standardModel: openAi.standardModel,
    complexModel: openAi.complexModel,
    fallbackModel: openAi.researchModel,
  });

  for (const candidate of modelCandidates) {
    let response: Response;
    try {
      response = await fetch(`${openAi.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAi.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          input: prompt,
        }),
        signal: AbortSignal.timeout(REVIEW_OPENAI_TIMEOUT_MS),
      });
    } catch {
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'recent_text_review',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: 'failed',
        detail: 'recent_text_review request failed before a response arrived',
      });
      return {
        ...input.result,
        providerNote:
          'Optional cloud refinement was unavailable, so I used the local review.',
      };
    }
    if (!response.ok) {
      const body = await response.text();
      if (isOpenAiModelRejection(response.status, body)) continue;
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'recent_text_review',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: /quota|billing|rejected|denied/i.test(body)
          ? 'blocked'
          : 'failed',
        detail: describeOpenAiProviderFailure(
          response.status,
          body,
          'research',
        ),
      });
      return {
        ...input.result,
        providerNote:
          'Optional cloud refinement was unavailable, so I used the local review.',
      };
    }
    const rawOutput = stripJsonFences(
      extractResponseOutputText((await response.json()) as unknown),
    );
    const parsed = safeJsonParse<{
      items?: Array<{
        itemId?: string;
        section?: RecentTextReviewSection;
        summaryText?: string;
        whyText?: string;
        recommendedAction?: string;
        suggestedReply?: string;
        suggestedReplies?: unknown;
      }>;
    }>(rawOutput, {});
    if (!Array.isArray(parsed.items)) continue;
    const byId = new Map(input.result.items.map((item) => [item.itemId, item]));
    for (const patch of parsed.items) {
      if (!patch.itemId || !byId.has(patch.itemId)) continue;
      const existing = byId.get(patch.itemId)!;
      if (automatedMessageKindForItem(existing)) {
        existing.suggestedReply = null;
        existing.suggestedReplies = [];
        continue;
      }
      // Deterministic group recaps carry speaker identity and conservative
      // audience attribution. Cloud prose must not collapse those speakers
      // back into a generic "they" or turn an unaddressed group question into
      // an owner obligation. Credential questions likewise stay on the local
      // no-share lane.
      if (
        existing.isGroup ||
        existing.riskFlags.includes('security_credential_question')
      ) {
        continue;
      }
      if (
        patch.summaryText &&
        !existing.summaryText.includes('Grounded plan:') &&
        isRecentTextProviderPatchGrounded(existing, patch.summaryText)
      ) {
        existing.summaryText = sanitizeSnippet(patch.summaryText, 260);
      }
      if (
        patch.whyText &&
        isRecentTextProviderPatchGrounded(existing, patch.whyText)
      ) {
        existing.whyText = sanitizeSnippet(patch.whyText, 220);
      }
      // Keep guidance and reply wording on the deterministic local lane. A
      // cloud model can enrich grounded recap prose, but it cannot introduce a
      // new action, commitment, or outbound suggestion the user may later
      // select by number.
    }
    recordOpenAiUsageState({
      at: new Date().toISOString(),
      surface: 'recent_text_review',
      selectedModelTier: candidate.tier,
      selectedModel: candidate.model,
      providerMode,
      outcome: 'success',
      detail: 'recent_text_review',
    });
    const sorted = sortItems(input.result.items);
    return buildResultFromItems({
      window: input.result.window,
      items: sorted,
      providerUsed: 'openai',
      providerNote: null,
      reviewedAt: input.result.reviewedAt,
      reviewedConversationCount: input.result.reviewedConversationCount,
      sectionTotals: input.result.sectionTotals,
    });
  }
  return input.result;
}

function sortItems(items: RecentTextReviewItem[]): RecentTextReviewItem[] {
  const sectionWeight: Record<RecentTextReviewSection, number> = {
    needs_reply: 0,
    worth_watching: 1,
    no_reply_needed: 2,
  };
  return [...items]
    .sort((left, right) => {
      const sectionDelta =
        sectionWeight[left.section] - sectionWeight[right.section];
      if (sectionDelta !== 0) return sectionDelta;
      if (right.priorityScore !== left.priorityScore) {
        return right.priorityScore - left.priorityScore;
      }
      return (right.latestMessageAt || '').localeCompare(
        left.latestMessageAt || '',
      );
    })
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

function buildResultFromItems(input: {
  window: RecentTextReviewResult['window'];
  items: RecentTextReviewItem[];
  providerUsed: RecentTextReviewResult['providerUsed'];
  providerNote?: string | null;
  reviewedAt?: string;
  reviewedConversationCount?: number;
  sectionTotals?: Record<RecentTextReviewSection, number>;
}): RecentTextReviewResult {
  const needsReply = input.items.filter(
    (item) => item.section === 'needs_reply',
  );
  const worthWatching = input.items.filter(
    (item) => item.section === 'worth_watching',
  );
  const noReplyNeeded = input.items.filter(
    (item) => item.section === 'no_reply_needed',
  );
  const sectionTotals = input.sectionTotals || {
    needs_reply: needsReply.length,
    worth_watching: worthWatching.length,
    no_reply_needed: noReplyNeeded.length,
  };
  const reviewedConversationCount =
    input.reviewedConversationCount ?? input.items.length;
  const summaryText =
    reviewedConversationCount === 0
      ? `No activity needing review appeared in the available local Messages snapshot over ${input.window.label}.`
      : `${sectionTotals.needs_reply} need${sectionTotals.needs_reply === 1 ? 's' : ''} reply, ${sectionTotals.worth_watching} worth watching, ${sectionTotals.no_reply_needed} no reply needed in the available local Messages snapshot over ${input.window.label}.`;
  return {
    ok: true,
    reviewedAt: input.reviewedAt || new Date().toISOString(),
    window: input.window,
    summaryText,
    items: input.items,
    needsReply,
    worthWatching,
    noReplyNeeded,
    reviewedConversationCount,
    sectionTotals,
    providerUsed: input.providerUsed,
    providerNote: input.providerNote || null,
  };
}

export async function reviewRecentTexts(
  input: RecentTextReviewInput,
): Promise<RecentTextReviewResult> {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const window = resolveRecentTextReviewWindow({
    now,
    kind: input.timeWindowKind || 'default_24h',
    value: input.timeWindowValue || 24,
  });
  const context: LocalReviewContext = {
    subjects: listProfileSubjectsForGroup(input.groupFolder),
    facts: listProfileFactsForGroup(input.groupFolder, ['accepted']),
    lifeThreads: listLifeThreadsForGroup(input.groupFolder, [
      'active',
      'paused',
    ]),
    communicationThreads: listCommunicationThreadsForGroup({
      groupFolder: input.groupFolder,
      includeDisabled: false,
      limit: 200,
    }),
    identityReviews: listCommunicationIdentityReviewsForGroup(
      input.groupFolder,
    ),
    contextGraph: buildPersonalContextGraph({
      groupFolder: input.groupFolder,
      now,
    }),
  };
  const analyses = getAllChats()
    .filter(
      (chat) =>
        chat.channel === 'bluebubbles' ||
        chat.channel === 'telegram' ||
        chat.jid.startsWith('bb:') ||
        chat.jid.startsWith('tg:'),
    )
    .filter((chat) => !isConfiguredBlueBubblesSelfThreadAliasJid(chat.jid))
    .map((chat) => {
      const messages = listMessagesForChatWindow({
        chatJid: chat.jid,
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        limit: 120,
      }).filter((message) => !message.is_bot_message);
      return classifyThread({
        groupFolder: input.groupFolder,
        chat,
        messages,
        context,
      });
    })
    .filter(Boolean) as CandidateAnalysis[];
  const persistedItems = analyses.map((analysis) =>
    analysis.persist
      ? persistReviewItem({
          groupFolder: input.groupFolder,
          analysis,
          existingThreads: context.communicationThreads,
          nowIso,
        })
      : analysis.item,
  );
  const sortedItems = sortItems(persistedItems);
  const sectionTotals: Record<RecentTextReviewSection, number> = {
    needs_reply: sortedItems.filter((item) => item.section === 'needs_reply')
      .length,
    worth_watching: sortedItems.filter(
      (item) => item.section === 'worth_watching',
    ).length,
    no_reply_needed: sortedItems.filter(
      (item) => item.section === 'no_reply_needed',
    ).length,
  };
  const items = sortedItems.slice(0, MAX_REVIEW_ITEMS);
  const local = buildResultFromItems({
    window,
    items,
    providerUsed: 'local',
    reviewedAt: nowIso,
    reviewedConversationCount: sortedItems.length,
    sectionTotals,
  });
  return enhanceWithProvider({
    result: local,
    cloudAnalysisMode: input.cloudAnalysisMode || 'disabled',
  });
}

function formatItemLine(
  item: RecentTextReviewItem,
  channel: 'telegram' | 'bluebubbles',
): string {
  const replyOptions =
    item.suggestedReplies && item.suggestedReplies.length > 0
      ? item.suggestedReplies
      : item.suggestedReply
        ? [{ label: 'suggested', text: item.suggestedReply }]
        : [];
  const safeReplyOptions = replyOptions.filter(
    (option) => !containsUnsupportedFuturePromise(option.text),
  );
  const reply =
    safeReplyOptions.length > 0
      ? [
          channel === 'telegram'
            ? '\n   Unsent draft options:'
            : '\n   Unsent suggested replies:',
          ...safeReplyOptions
            .slice(0, 3)
            .map(
              (option, index) =>
                `   ${index + 1}) ${sanitizeSnippet(option.label, 32)}: "${sanitizeSnippet(option.text, 220)}"`,
            ),
        ].join('\n')
      : '';
  const caution = item.riskFlags.includes('group_chat_confirm_audience')
    ? '\n   Caution: group chat - draft only until you review it.'
    : item.riskFlags.includes('low_context_confidence')
      ? '\n   Caution: low context confidence - confirm before drafting.'
      : '';
  const summaryLimit = channel === 'bluebubbles' ? 160 : 180;
  const summary = sanitizeSnippet(item.summaryText, summaryLimit);
  const duplicatedPrefix = `${item.chatLabel}:`;
  const compactSummary = summary
    .toLowerCase()
    .startsWith(duplicatedPrefix.toLowerCase())
    ? summary.slice(duplicatedPrefix.length).trimStart()
    : summary;
  const whyLimit = channel === 'bluebubbles' ? 100 : 120;
  const actionLimit = channel === 'bluebubbles' ? 120 : 140;
  const latestActivity = formatRecentTextReviewLocalTimestamp(
    item.latestMessageAt,
  );
  return `${item.rank}. ${item.chatLabel}: ${compactSummary}\n   Latest activity: ${latestActivity || 'time unavailable'}\n   Why: ${sanitizeSnippet(item.whyText, whyLimit)}\n   Next: ${sanitizeSnippet(item.recommendedAction, actionLimit)}${caution}${reply}`;
}

export function formatRecentTextReviewLocalTimestamp(
  value: string | null | undefined,
  timeZone = TIMEZONE,
): string | null {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return null;
  }
}

function formatRecentTextReviewSynthesisDisclosure(
  result: RecentTextReviewResult,
): string {
  return result.providerUsed === 'openai'
    ? 'Synthesis: OpenAI refined bounded recap wording; classifications, grounded commitment/decision facts, next steps, and reply status remain deterministic and grounded in the local synced snapshot.'
    : 'Synthesis: Local-only; all recap claims, grounded commitment/decision facts, and classifications come from the available local synced snapshot.';
}

export function formatRecentTextReviewReply(input: {
  result: RecentTextReviewResult;
  channel: 'telegram' | 'bluebubbles';
}): string {
  const { result } = input;
  if (result.items.length === 0) {
    return `In the available local Messages snapshot for ${result.window.label}, I didn't find any conversations that need attention.\n\n${formatRecentTextReviewSynthesisDisclosure(result)}\n\nSource: Local synced snapshot reviewed at ${result.reviewedAt}; sync completeness was not independently verified, and each conversation is bounded to its newest 120 in-window messages. This is an activity/actionability review, not device unread status.`;
  }
  const topLimit =
    input.channel === 'bluebubbles'
      ? BLUEBUBBLES_REVIEW_DISPLAY_LIMIT
      : TELEGRAM_REVIEW_DISPLAY_LIMIT;
  const displayedItems =
    input.channel === 'bluebubbles'
      ? [...result.needsReply, ...result.worthWatching].slice(0, topLimit)
      : result.items.slice(0, topLimit);
  const displayedNeeds = displayedItems.filter(
    (item) => item.section === 'needs_reply',
  );
  const displayedWatching = displayedItems.filter(
    (item) => item.section === 'worth_watching',
  );
  const displayedNoReply = displayedItems.filter(
    (item) => item.section === 'no_reply_needed',
  );
  const needs = displayedNeeds.map((item) =>
    formatItemLine(item, input.channel),
  );
  const watching = displayedWatching.map((item) =>
    formatItemLine(item, input.channel),
  );
  const noReply = displayedNoReply.map((item) =>
    formatItemLine(item, input.channel),
  );
  const hiddenCounts = [
    {
      count: result.sectionTotals.needs_reply - displayedNeeds.length,
      label: 'needing reply',
    },
    {
      count: result.sectionTotals.worth_watching - displayedWatching.length,
      label: 'worth watching',
    },
    {
      count: result.sectionTotals.no_reply_needed - displayedNoReply.length,
      label: 'no reply needed',
    },
  ].filter((entry) => entry.count > 0);
  const overview = `${result.sectionTotals.needs_reply} need${result.sectionTotals.needs_reply === 1 ? 's' : ''} reply, ${result.sectionTotals.worth_watching} worth watching, ${result.sectionTotals.no_reply_needed} no reply needed over ${result.window.label}. Showing ${displayedItems.length} highest-priority of ${result.reviewedConversationCount}.`;
  const firstDisplayedNeed = displayedNeeds[0];
  const sections = [
    overview,
    `Source: Available local synced snapshot for ${result.window.label}; ${result.reviewedConversationCount} ${result.reviewedConversationCount === 1 ? 'conversation' : 'conversations'} with in-window activity classified. Sync completeness was not independently verified; each conversation is bounded to its newest 120 in-window messages. “Needs reply” is inferred from conversation turns, not device unread/read status.`,
    formatRecentTextReviewSynthesisDisclosure(result),
    result.providerNote,
    hiddenCounts.length > 0
      ? `Not expanded below: ${hiddenCounts.map((entry) => `${entry.count} ${entry.label}`).join(', ')}.`
      : null,
    needs.length > 0 ? ['Needs reply', ...needs].join('\n') : null,
    watching.length > 0 ? ['Worth watching', ...watching].join('\n') : null,
    noReply.length > 0 ? ['No reply needed', ...noReply].join('\n') : null,
    firstDisplayedNeed?.riskFlags.includes('needs_owner_context')
      ? `Review the context for #${firstDisplayedNeed.rank} before drafting anything; I will not guess or send a clarification automatically.`
      : firstDisplayedNeed?.riskFlags.includes('needs_owner_action')
        ? `#${firstDisplayedNeed.rank} asks you to take an action. I will not perform it or invent a reply automatically; tell me how you want to handle it.`
        : firstDisplayedNeed?.riskFlags.includes('needs_owner_answer')
          ? `Tell me the answer you want to send for #${firstDisplayedNeed.rank}, and I can help word it without guessing.`
          : firstDisplayedNeed
            ? `Say \`draft #${firstDisplayedNeed.rank}\`, \`make #${firstDisplayedNeed.rank} warmer\`, or \`remind me about that\` to continue.`
            : null,
  ].filter(Boolean);
  return sections.join('\n\n');
}

export function buildRecentTextReviewSeedJson(
  result: RecentTextReviewResult,
): string {
  return JSON.stringify({
    version: 1,
    reviewedAt: result.reviewedAt,
    windowLabel: result.window.label,
    windowStartTimestamp: result.window.startTimestamp,
    windowEndTimestamp: result.window.endTimestamp,
    items: result.items.slice(0, 8).map((item) => ({
      itemId: item.itemId,
      rank: item.rank,
      section: item.section,
      sourceChannel: item.sourceChannel,
      chatLabel: item.chatLabel,
      isGroup: item.isGroup,
      communicationThreadId: item.communicationThreadId || null,
      linkedSubjectIds: item.linkedSubjectIds,
      linkedLifeThreadIds: item.linkedLifeThreadIds,
      contextLink: item.contextLink,
      riskFlags: item.riskFlags,
      freshnessSnapshot: item.freshnessSnapshot
        ? {
            latestMessageIdentityHash:
              item.freshnessSnapshot.latestMessageIdentityHash || null,
            latestMessageAt: item.freshnessSnapshot.latestMessageAt || null,
            latestInboundAt: item.freshnessSnapshot.latestInboundAt || null,
            latestOutboundAt: item.freshnessSnapshot.latestOutboundAt || null,
            messageCount: item.freshnessSnapshot.messageCount || 0,
            snapshotHash: item.freshnessSnapshot.snapshotHash || null,
            transcriptHash: item.freshnessSnapshot.transcriptHash || null,
          }
        : null,
      summaryText: item.summaryText,
      whyText: item.whyText,
      suggestedReply: item.suggestedReply || null,
      suggestedReplies: (item.suggestedReplies || [])
        .slice(0, 3)
        .map((reply) => ({
          label: reply.label,
          text: reply.text,
        })),
      recommendedAction: item.recommendedAction,
      outcomeState: 'reviewed' satisfies RecentTextReviewOutcome,
    })),
  });
}

export function parseRecentTextReviewSeedJson(
  value: string | null | undefined,
): {
  version: 1;
  reviewedAt?: string | null;
  windowLabel?: string;
  windowStartTimestamp?: string | null;
  windowEndTimestamp?: string | null;
  items: Array<{
    itemId: string;
    rank: number;
    section: RecentTextReviewSection;
    sourceChannel?: 'telegram' | 'bluebubbles';
    chatJid?: string;
    chatLabel: string;
    isGroup?: boolean;
    communicationThreadId?: string | null;
    linkedSubjectIds?: string[];
    linkedLifeThreadIds?: string[];
    contextLink?: RecentTextReviewContextLink | null;
    riskFlags?: string[];
    freshnessSnapshot?: RecentTextReviewFreshnessSnapshot | null;
    outcomeState?: RecentTextReviewOutcome;
    summaryText: string;
    whyText?: string;
    suggestedReply?: string | null;
    suggestedReplies?: RecentTextReviewSuggestedReply[] | null;
    recommendedAction?: string;
  }>;
} | null {
  if (!value) return null;
  const parsed = safeJsonParse<{
    version?: number;
    reviewedAt?: string;
    windowLabel?: string;
    windowStartTimestamp?: string;
    windowEndTimestamp?: string | null;
    items?: unknown;
  }>(value, {});
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
  return {
    version: 1,
    reviewedAt:
      typeof parsed.reviewedAt === 'string'
        ? normalizeText(parsed.reviewedAt)
        : null,
    windowLabel: parsed.windowLabel,
    windowStartTimestamp:
      typeof parsed.windowStartTimestamp === 'string'
        ? normalizeText(parsed.windowStartTimestamp)
        : null,
    windowEndTimestamp:
      typeof parsed.windowEndTimestamp === 'string'
        ? normalizeText(parsed.windowEndTimestamp)
        : null,
    items: parsed.items
      .map((item) =>
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : null,
      )
      .filter(Boolean)
      .map((item) => ({
        itemId: normalizeText(String(item!.itemId || '')),
        rank: Number(item!.rank || 0),
        section:
          item!.section === 'worth_watching' ||
          item!.section === 'no_reply_needed'
            ? (item!.section as RecentTextReviewSection)
            : 'needs_reply',
        sourceChannel:
          item!.sourceChannel === 'telegram'
            ? ('telegram' as const)
            : item!.sourceChannel === 'bluebubbles'
              ? ('bluebubbles' as const)
              : undefined,
        chatJid:
          typeof item!.chatJid === 'string'
            ? normalizeText(item!.chatJid)
            : undefined,
        chatLabel: sanitizeSnippet(
          String(item!.chatLabel || 'Messages chat'),
          72,
        ),
        isGroup: Boolean(item!.isGroup),
        communicationThreadId:
          typeof item!.communicationThreadId === 'string'
            ? item!.communicationThreadId
            : null,
        linkedSubjectIds: Array.isArray(item!.linkedSubjectIds)
          ? item!.linkedSubjectIds.map(String)
          : [],
        linkedLifeThreadIds: Array.isArray(item!.linkedLifeThreadIds)
          ? item!.linkedLifeThreadIds.map(String)
          : [],
        contextLink:
          item!.contextLink && typeof item!.contextLink === 'object'
            ? (() => {
                const raw = item!.contextLink as Record<string, unknown>;
                const participantKind: RecentTextReviewContextLink['participantKind'] =
                  raw.participantKind === 'group'
                    ? 'group'
                    : raw.participantKind === 'direct'
                      ? 'direct'
                      : 'unknown';
                const confidence: RecentTextReviewContextLink['confidence'] =
                  raw.confidence === 'high'
                    ? 'high'
                    : raw.confidence === 'medium'
                      ? 'medium'
                      : 'low';
                return {
                  participantKind,
                  confidence,
                  reason: sanitizeSnippet(String(raw.reason || ''), 160),
                  riskFlags: Array.isArray(raw.riskFlags)
                    ? raw.riskFlags
                        .map(String)
                        .map((flag) => sanitizeSnippet(flag, 64))
                        .filter(Boolean)
                    : [],
                  communicationThreadId:
                    typeof raw.communicationThreadId === 'string'
                      ? raw.communicationThreadId
                      : null,
                };
              })()
            : null,
        riskFlags: Array.isArray(item!.riskFlags)
          ? item!.riskFlags
              .map(String)
              .map((flag) => sanitizeSnippet(flag, 64))
              .filter(Boolean)
          : [],
        freshnessSnapshot:
          item!.freshnessSnapshot && typeof item!.freshnessSnapshot === 'object'
            ? (() => {
                const raw = item!.freshnessSnapshot as Record<string, unknown>;
                return {
                  latestMessageIdentityHash:
                    typeof raw.latestMessageIdentityHash === 'string'
                      ? normalizeText(raw.latestMessageIdentityHash)
                      : null,
                  latestMessageAt:
                    typeof raw.latestMessageAt === 'string'
                      ? normalizeText(raw.latestMessageAt)
                      : null,
                  latestInboundAt:
                    typeof raw.latestInboundAt === 'string'
                      ? normalizeText(raw.latestInboundAt)
                      : null,
                  latestOutboundAt:
                    typeof raw.latestOutboundAt === 'string'
                      ? normalizeText(raw.latestOutboundAt)
                      : null,
                  messageCount:
                    typeof raw.messageCount === 'number' &&
                    Number.isInteger(raw.messageCount) &&
                    raw.messageCount >= 0
                      ? raw.messageCount
                      : null,
                  snapshotHash:
                    typeof raw.snapshotHash === 'string'
                      ? normalizeText(raw.snapshotHash)
                      : null,
                  transcriptHash:
                    typeof raw.transcriptHash === 'string'
                      ? normalizeText(raw.transcriptHash)
                      : null,
                };
              })()
            : null,
        outcomeState: (() => {
          const rawOutcome = item!.outcomeState;
          const outcome: RecentTextReviewOutcome =
            rawOutcome === 'suggested' ||
            rawOutcome === 'drafted' ||
            rawOutcome === 'saved' ||
            rawOutcome === 'reminded' ||
            rawOutcome === 'skipped' ||
            rawOutcome === 'handled' ||
            rawOutcome === 'blocked_stale' ||
            rawOutcome === 'blocked_unbound'
              ? rawOutcome
              : 'reviewed';
          return outcome;
        })(),
        summaryText: sanitizeSnippet(String(item!.summaryText || ''), 260),
        whyText: sanitizeSnippet(String(item!.whyText || ''), 220),
        suggestedReply:
          typeof item!.suggestedReply === 'string'
            ? sanitizeSnippet(item!.suggestedReply, 220)
            : normalizeSuggestedReplies(item!.suggestedReplies)[0]?.text ||
              null,
        suggestedReplies: normalizeSuggestedReplies(item!.suggestedReplies),
        recommendedAction: sanitizeSnippet(
          String(item!.recommendedAction || ''),
          200,
        ),
      }))
      .filter((item) => item.itemId && item.rank > 0),
  };
}

type ParsedRecentTextReviewSeed = NonNullable<
  ReturnType<typeof parseRecentTextReviewSeedJson>
>;

export type RecentTextReviewItemFollowupKind =
  | 'draft'
  | 'remind'
  | 'save'
  | 'skip'
  | 'why'
  | 'handled'
  | 'ambiguous_name';

type RecentTextReviewSeedItem = ParsedRecentTextReviewSeed['items'][number];

export type BoundRecentTextReviewItemFollowup = {
  kind: Exclude<RecentTextReviewItemFollowupKind, 'ambiguous_name'>;
  item: RecentTextReviewSeedItem;
  style?: 'shorter' | 'warmer' | 'more_direct' | null;
  timingHint?: string | null;
  suggestedReply?: RecentTextReviewSuggestedReply | null;
};

export type RecentTextReviewItemFollowup =
  | BoundRecentTextReviewItemFollowup
  | {
      kind: 'ambiguous_name';
      query: string;
      candidates: Array<Pick<RecentTextReviewSeedItem, 'rank' | 'chatLabel'>>;
    };

export function isBoundRecentTextReviewItemFollowup(
  followup: RecentTextReviewItemFollowup | null | undefined,
): followup is BoundRecentTextReviewItemFollowup {
  return Boolean(followup && followup.kind !== 'ambiguous_name');
}

function findReviewSeedItemByRank(
  seed: ParsedRecentTextReviewSeed,
  rankText: string | undefined,
): ParsedRecentTextReviewSeed['items'][number] | null {
  const rank = Number.parseInt(rankText || '', 10);
  if (!Number.isFinite(rank) || rank < 1) return null;
  return seed.items.find((candidate) => candidate.rank === rank) || null;
}

function findCurrentReviewSeedItem(
  seed: ParsedRecentTextReviewSeed,
): ParsedRecentTextReviewSeed['items'][number] | null {
  return (
    seed.items.find((candidate) => candidate.section === 'needs_reply') ||
    seed.items.find((candidate) => candidate.section === 'worth_watching') ||
    seed.items[0] ||
    null
  );
}

function inferReviewDraftStyle(
  normalized: string,
): 'shorter' | 'warmer' | 'more_direct' | null {
  if (/\bwarmer|less stiff\b/.test(normalized)) return 'warmer';
  if (/\bmore direct|blunt\b/.test(normalized)) return 'more_direct';
  if (/\bshorter\b/.test(normalized)) return 'shorter';
  return null;
}

const REVIEW_FOLLOWUP_NAME_REJECT = new Set([
  'a',
  'about',
  'an',
  'as',
  'done',
  'first',
  'for',
  'handled',
  'it',
  'item',
  'later',
  'me',
  'my',
  'now',
  'number',
  'one',
  'option',
  'reply',
  'resolved',
  'response',
  'send',
  'that',
  'the',
  'this',
  'to',
]);

function normalizeReviewFollowupName(value: string): string {
  return normalizeText(
    value
      .replace(/^(?:the|my|our)\s+/i, '')
      .replace(/\b(?:thread|chat|conversation|texts?|messages?)\b/gi, ' ')
      .replace(
        /\b(?:warmer|shorter|more direct|less stiff|more blunt|for me)\b/gi,
        ' ',
      )
      .replace(/[.,!?]+$/g, ''),
  );
}

function isUsableReviewFollowupName(value: string): boolean {
  const normalized = normalizeReviewFollowupName(value).toLowerCase();
  if (!normalized || normalized.length < 2 || /^\d+$/.test(normalized)) {
    return false;
  }
  if (/^(?:#|number\s*)\d+$/i.test(normalized)) {
    return false;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) {
    return false;
  }
  if (tokens.every((token) => REVIEW_FOLLOWUP_NAME_REJECT.has(token))) {
    return false;
  }
  return !/\bsend it(?: now)?\b|\bsend now\b/i.test(normalized);
}

type ReviewSeedNameMatch =
  | { state: 'unique'; item: RecentTextReviewSeedItem }
  | {
      state: 'ambiguous';
      query: string;
      candidates: Array<Pick<RecentTextReviewSeedItem, 'rank' | 'chatLabel'>>;
    }
  | { state: 'missing' };

function findReviewSeedItemByName(
  seed: ParsedRecentTextReviewSeed,
  rawName: string,
): ReviewSeedNameMatch {
  const query = normalizeReviewFollowupName(rawName).toLowerCase();
  if (!isUsableReviewFollowupName(query)) {
    return { state: 'missing' };
  }
  const exact = seed.items.filter(
    (candidate) => normalizeText(candidate.chatLabel).toLowerCase() === query,
  );
  if (exact.length === 1 && exact[0]) {
    return { state: 'unique', item: exact[0] };
  }
  if (exact.length > 1) {
    return {
      state: 'ambiguous',
      query: normalizeReviewFollowupName(rawName),
      candidates: exact.map((candidate) => ({
        rank: candidate.rank,
        chatLabel: candidate.chatLabel,
      })),
    };
  }
  const tokenBoundary = seed.items.filter((candidate) => {
    const label = normalizeText(candidate.chatLabel).toLowerCase();
    return label === query || label.startsWith(`${query} `);
  });
  if (tokenBoundary.length === 1 && tokenBoundary[0]) {
    return { state: 'unique', item: tokenBoundary[0] };
  }
  if (tokenBoundary.length > 1) {
    return {
      state: 'ambiguous',
      query: normalizeReviewFollowupName(rawName),
      candidates: tokenBoundary.map((candidate) => ({
        rank: candidate.rank,
        chatLabel: candidate.chatLabel,
      })),
    };
  }
  return { state: 'missing' };
}

function followupFromNameMatch(
  match: ReviewSeedNameMatch,
  bound: Omit<BoundRecentTextReviewItemFollowup, 'item'>,
): RecentTextReviewItemFollowup | null {
  if (match.state === 'missing') {
    return null;
  }
  if (match.state === 'ambiguous') {
    return {
      kind: 'ambiguous_name',
      query: match.query,
      candidates: match.candidates,
    };
  }
  return { ...bound, item: match.item };
}

const REVIEW_FOLLOWUP_TIMING_RE =
  /\s+(tonight|tomorrow|later|this evening|this afternoon|this morning|in the morning)$/i;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inferSuggestedReplySelection(
  normalized: string,
  item: ParsedRecentTextReviewSeed['items'][number],
): RecentTextReviewSuggestedReply | null {
  const options = item.suggestedReplies || [];
  if (options.length === 0) {
    return item.suggestedReply
      ? { label: 'suggested', text: item.suggestedReply }
      : null;
  }
  const optionNumber = normalized.match(/\b(?:option|reply)\s*(\d+)\b/i);
  if (optionNumber) {
    const index = Number.parseInt(optionNumber[1] || '', 10) - 1;
    return options[index] || null;
  }
  const labelMatch = options.find((option) => {
    const label = normalizeText(option.label).toLowerCase();
    return (
      label && new RegExp(`\\b${escapeRegex(label)}\\b`, 'i').test(normalized)
    );
  });
  return labelMatch || options[0] || null;
}

export function parseRecentTextReviewItemFollowup(input: {
  seedJson?: string | null;
  userText: string;
}): RecentTextReviewItemFollowup | null {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  if (!seed || seed.items.length === 0) return null;
  const normalized = normalizeText(input.userText).toLowerCase();
  if (!normalized) return null;
  const currentItem = findCurrentReviewSeedItem(seed);
  const pronounTarget =
    '(?:it|this|this one|that|that one|the first one|first one)';

  const draftPronoun =
    new RegExp(
      `^(?:draft|reply to|respond to|rewrite)\\s+${pronounTarget}(?:\\s+for me)?\\b`,
      'i',
    ).test(normalized) ||
    new RegExp(
      `^(?:make|rewrite)\\s+${pronounTarget}\\s+(?:warmer|shorter|more direct|less stiff|more blunt)\\b`,
      'i',
    ).test(normalized) ||
    /^(?:warmer|shorter|more direct|less stiff|more blunt)$/i.test(normalized);
  if (draftPronoun && currentItem) {
    return {
      kind: 'draft',
      item: currentItem,
      style: inferReviewDraftStyle(normalized),
      suggestedReply: inferSuggestedReplySelection(normalized, currentItem),
    };
  }

  const explicitDraftMatch =
    normalized.match(
      /(?:draft|reply to|respond to|make|rewrite|warm(?:er)?|more direct|shorter)\s*(?:item\s*)?(?:#|number\s*)?(\d+)/i,
    ) ||
    (/\b(?:draft|reply|respond|make|rewrite|warm(?:er)?|direct|shorter|option)\b/i.test(
      normalized,
    )
      ? normalized.match(/(?:#|number\s*)(\d+)\b/i)
      : null);
  if (explicitDraftMatch) {
    const item = findReviewSeedItemByRank(seed, explicitDraftMatch[1]);
    if (!item) return null;
    return {
      kind: 'draft',
      item,
      style: inferReviewDraftStyle(normalized),
      suggestedReply: inferSuggestedReplySelection(normalized, item),
    };
  }

  const bareRankMatch = normalized.match(/^(?:#|number\s*)?(\d+)$/i);
  if (bareRankMatch) {
    const item = findReviewSeedItemByRank(seed, bareRankMatch[1]);
    if (
      !item ||
      item.section === 'no_reply_needed' ||
      (item.riskFlags || []).length > 0
    ) {
      return null;
    }
    return {
      kind: 'draft',
      item,
      style: null,
      suggestedReply: inferSuggestedReplySelection(normalized, item),
    };
  }

  const reminderPronoun = normalized.match(
    new RegExp(
      `^remind me(?:\\s+(?:about|to review|to reply to|on|for))?\\s+${pronounTarget}(?:\\s+(.+))?$`,
      'i',
    ),
  );
  if (reminderPronoun && currentItem) {
    return {
      kind: 'remind',
      item: currentItem,
      timingHint: normalizeText(reminderPronoun[1] || '') || null,
    };
  }

  const reminderMatch = normalized.match(
    /^remind me(?:\s+(?:about|to review|to reply to|on|for))?\s*(?:item\s*)?(?:#|number\s*)?(\d+)(?:\s+(.+))?$/i,
  );
  if (reminderMatch) {
    const item = findReviewSeedItemByRank(seed, reminderMatch[1]);
    if (!item) return null;
    return {
      kind: 'remind',
      item,
      timingHint: normalizeText(reminderMatch[2] || '') || null,
    };
  }

  const savePronoun = new RegExp(
    `^(?:save|remember|track|keep track of)\\s+${pronounTarget}\\b`,
    'i',
  ).test(normalized);
  if (savePronoun && currentItem) return { kind: 'save', item: currentItem };

  const saveMatch = normalized.match(
    /^(?:save|remember|track|keep track of)\s*(?:item\s*)?(?:#|number\s*)?(\d+)\b/i,
  );
  if (saveMatch) {
    const item = findReviewSeedItemByRank(seed, saveMatch[1]);
    if (!item) return null;
    return { kind: 'save', item };
  }

  const skipPronoun = new RegExp(
    `^(?:skip|dismiss|ignore)\\s+${pronounTarget}\\b`,
    'i',
  ).test(normalized);
  if (skipPronoun && currentItem) return { kind: 'skip', item: currentItem };

  const skipMatch = normalized.match(
    /^(?:skip|dismiss|ignore)\s*(?:item\s*)?(?:#|number\s*)?(\d+)\b/i,
  );
  if (skipMatch) {
    const item = findReviewSeedItemByRank(seed, skipMatch[1]);
    if (!item) return null;
    return { kind: 'skip', item };
  }

  const handledPronoun =
    new RegExp(
      `^mark\\s+${pronounTarget}\\s+(?:as\\s*)?(?:handled|done|resolved)\\b`,
      'i',
    ).test(normalized) ||
    /^(?:mark\s*)?(?:handled|done|resolved)$/i.test(normalized);
  if (handledPronoun && currentItem) {
    return { kind: 'handled', item: currentItem };
  }

  const handledMatch =
    normalized.match(
      /^(?:mark\s*)?(?:item\s*)?(?:#|number\s*)?(\d+)\s*(?:as\s*)?(?:handled|done|resolved)\b/i,
    ) ||
    normalized.match(
      /^(?:handled|done|resolved)\s*(?:item\s*)?(?:#|number\s*)?(\d+)\b/i,
    );
  if (handledMatch) {
    const item = findReviewSeedItemByRank(seed, handledMatch[1]);
    if (!item) return null;
    return { kind: 'handled', item };
  }

  const whyPronoun =
    new RegExp(`^(?:why|explain)\\s+${pronounTarget}\\b`, 'i').test(
      normalized,
    ) || /^(?:why|explain)$/i.test(normalized);
  if (whyPronoun && currentItem) return { kind: 'why', item: currentItem };

  const whyMatch = normalized.match(
    /^(?:why|explain)\s*(?:item\s*)?(?:#|number\s*)?(\d+)\b/i,
  );
  if (whyMatch) {
    const item = findReviewSeedItemByRank(seed, whyMatch[1]);
    if (!item) return null;
    return { kind: 'why', item };
  }

  const namedDraftMatch =
    normalized.match(
      /^(?:draft|reply to|respond to|rewrite)(?:\s+(?:a\s+)?(?:reply|response)(?:\s+to)?)?(?:\s+for)?\s+(.+)$/i,
    ) ||
    normalized.match(
      /^(?:make|rewrite)\s+(.+?)\s+(?:warmer|shorter|more direct|less stiff|more blunt)$/i,
    );
  if (namedDraftMatch) {
    const named = followupFromNameMatch(
      findReviewSeedItemByName(
        seed,
        (namedDraftMatch[1] || '').replace(/\s+about\b.*$/i, ''),
      ),
      {
        kind: 'draft',
        style: inferReviewDraftStyle(normalized),
        suggestedReply: null,
      },
    );
    if (named?.kind === 'draft') {
      named.suggestedReply = inferSuggestedReplySelection(
        normalized,
        named.item,
      );
    }
    if (named) return named;
  }

  const namedRemindMatch = normalized.match(
    /^remind me(?:\s+(?:about|to review|to reply to|on|for))?\s+(.+)$/i,
  );
  if (namedRemindMatch) {
    const remainder = normalizeText(namedRemindMatch[1] || '');
    const timingMatch = remainder.match(REVIEW_FOLLOWUP_TIMING_RE);
    const nameText = timingMatch
      ? remainder.replace(REVIEW_FOLLOWUP_TIMING_RE, '')
      : remainder.replace(/\s+about\b.*$/i, '');
    const named = followupFromNameMatch(
      findReviewSeedItemByName(seed, nameText),
      {
        kind: 'remind',
        timingHint: timingMatch ? normalizeText(timingMatch[1] || '') : null,
      },
    );
    if (named) return named;
  }

  const namedSaveMatch = normalized.match(
    /^(?:save|remember|track|keep track of)\s+(.+)$/i,
  );
  if (namedSaveMatch) {
    const named = followupFromNameMatch(
      findReviewSeedItemByName(seed, namedSaveMatch[1] || ''),
      { kind: 'save' },
    );
    if (named) return named;
  }

  const namedSkipMatch = normalized.match(/^(?:skip|dismiss|ignore)\s+(.+)$/i);
  if (namedSkipMatch) {
    const named = followupFromNameMatch(
      findReviewSeedItemByName(seed, namedSkipMatch[1] || ''),
      { kind: 'skip' },
    );
    if (named) return named;
  }

  const namedHandledMatch = normalized.match(
    /^(?:mark\s+)?(.+?)\s+(?:as\s*)?(?:handled|done|resolved)$/i,
  );
  if (namedHandledMatch) {
    const named = followupFromNameMatch(
      findReviewSeedItemByName(seed, namedHandledMatch[1] || ''),
      { kind: 'handled' },
    );
    if (named) return named;
  }

  const namedWhyMatch = normalized.match(/^(?:why|explain)\s+(.+)$/i);
  if (namedWhyMatch) {
    const named = followupFromNameMatch(
      findReviewSeedItemByName(seed, namedWhyMatch[1] || ''),
      { kind: 'why' },
    );
    if (named) return named;
  }

  return null;
}

export function isRecentTextReviewSeedStale(input: {
  seedJson?: string | null;
  now?: Date;
}): boolean {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  if (!seed?.reviewedAt) return false;
  const reviewedAtMs = Date.parse(seed.reviewedAt);
  if (!Number.isFinite(reviewedAtMs)) return true;
  const nowMs = (input.now || new Date()).getTime();
  return nowMs - reviewedAtMs > MAX_REVIEW_SEED_AGE_MS;
}

/**
 * Strict retention check for conversation state that carries a recent-text
 * review. Unlike the legacy stale check above, missing, malformed, or
 * future-dated review timestamps are not safe enough to retain as a numbered
 * follow-up binding.
 */
export function isRecentTextReviewSeedWithinRetentionWindow(input: {
  seedJson?: string | null;
  now?: Date;
}): boolean {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  if (!seed?.reviewedAt || seed.items.length === 0) return false;
  const reviewedAtMs = Date.parse(seed.reviewedAt);
  const nowMs = (input.now || new Date()).getTime();
  if (!Number.isFinite(reviewedAtMs) || !Number.isFinite(nowMs)) return false;
  if (reviewedAtMs > nowMs || nowMs - reviewedAtMs > MAX_REVIEW_SEED_AGE_MS) {
    return false;
  }
  return seed.items.every((item) => {
    const snapshot = item.freshnessSnapshot;
    if (!snapshot?.snapshotHash || !snapshot.latestMessageAt) return false;
    const timestamps = [
      snapshot.latestMessageAt,
      snapshot.latestInboundAt,
      snapshot.latestOutboundAt,
    ].filter((value): value is string => Boolean(value));
    return timestamps.every((value) => {
      const timestampMs = Date.parse(value);
      return Number.isFinite(timestampMs) && timestampMs <= reviewedAtMs;
    });
  });
}

export function formatRecentTextReviewStaleReply(): string {
  return [
    'That text review is stale enough that I do not want to bind the wrong conversation.',
    'Ask me to review recent texts again, then pick the item from the fresh list.',
  ].join('\n');
}

export function resolveRecentTextReviewFollowupTarget(
  item: ParsedRecentTextReviewSeed['items'][number],
): RecentTextReviewFollowupTarget {
  const thread = item.communicationThreadId
    ? getCommunicationThread(item.communicationThreadId)
    : undefined;
  if (
    (thread?.channel === 'bluebubbles' || thread?.channel === 'telegram') &&
    thread.channelChatJid &&
    thread.disabledAt == null
  ) {
    if (item.chatJid && thread.channelChatJid !== item.chatJid) {
      return {
        ok: false,
        reason:
          'the selected review item is now bound to a different Messages chat',
      };
    }
    return {
      ok: true,
      reason: 'resolved through stored communication thread',
      targetChannel: thread.channel,
      chatJid: thread.channelChatJid,
      isGroup:
        item.isGroup ||
        item.contextLink?.participantKind === 'group' ||
        thread.title.includes(',') ||
        thread.title.includes('&'),
      personName: item.chatLabel || thread.title,
      communicationThreadId: thread.id,
    };
  }
  if (item.chatJid?.startsWith('bb:')) {
    return {
      ok: true,
      reason: 'resolved through legacy review seed target',
      targetChannel: 'bluebubbles',
      chatJid: item.chatJid,
      isGroup: Boolean(
        item.isGroup || item.contextLink?.participantKind === 'group',
      ),
      personName: item.chatLabel,
      communicationThreadId: item.communicationThreadId || null,
    };
  }
  if (item.chatJid?.startsWith('tg:')) {
    return {
      ok: true,
      reason: 'resolved through legacy telegram review seed target',
      targetChannel: 'telegram',
      chatJid: item.chatJid,
      isGroup: Boolean(
        item.isGroup || item.contextLink?.participantKind === 'group',
      ),
      personName: item.chatLabel,
      communicationThreadId: item.communicationThreadId || null,
    };
  }
  return {
    ok: false,
    reason:
      'the selected review item is missing a current Messages thread binding',
  };
}

function freshnessHistoryStartTimestamp(input: {
  seed: ParsedRecentTextReviewSeed | null;
  item: ParsedRecentTextReviewSeed['items'][number];
}): string {
  return (
    input.seed?.windowStartTimestamp ||
    input.item.freshnessSnapshot?.latestMessageAt ||
    input.item.freshnessSnapshot?.latestInboundAt ||
    input.item.freshnessSnapshot?.latestOutboundAt ||
    '1970-01-01T00:00:00.000Z'
  );
}

export function isExactNonEmptyMessagesHistoryRefreshReceipt(input: {
  receipt: unknown;
  expectedChatJid: string;
}): boolean {
  if (!input.receipt || typeof input.receipt !== 'object') return false;
  const receipt = input.receipt as Record<string, unknown>;
  return (
    typeof receipt.chatJid === 'string' &&
    receipt.chatJid.trim() === input.expectedChatJid.trim() &&
    typeof receipt.storedCount === 'number' &&
    Number.isInteger(receipt.storedCount) &&
    receipt.storedCount > 0 &&
    typeof receipt.totalCount === 'number' &&
    Number.isInteger(receipt.totalCount) &&
    receipt.totalCount > 0 &&
    receipt.storedCount <= receipt.totalCount
  );
}

export type MessagesThreadSnapshotBindingValidation =
  | {
      ok: true;
      snapshot: RecentTextReviewFreshnessSnapshot;
    }
  | {
      ok: false;
      reason:
        | 'snapshot_binding_missing'
        | 'thread_history_unavailable'
        | 'newer_thread_activity'
        | 'thread_snapshot_changed';
      detail: string;
    };

/**
 * Compares an immutable transcript snapshot with the same newest-N local
 * window that produced it. The exact targeted provider refresh must be proven
 * separately before callers trust this local comparison.
 */
export function validateMessagesThreadSnapshotBinding(input: {
  chatJid: string;
  historyStartTimestamp: string;
  freshnessSnapshot: RecentTextReviewFreshnessSnapshot;
}): MessagesThreadSnapshotBindingValidation {
  const expected = input.freshnessSnapshot;
  const messageCount = expected.messageCount;
  if (
    !input.chatJid.trim() ||
    !Number.isFinite(Date.parse(input.historyStartTimestamp)) ||
    !/^[a-f0-9]{16}$/i.test(expected.latestMessageIdentityHash || '') ||
    !expected.latestMessageAt ||
    !Number.isInteger(messageCount) ||
    !messageCount ||
    messageCount < 1 ||
    !/^[a-f0-9]{16}$/i.test(expected.snapshotHash || '') ||
    !/^[a-f0-9]{16}$/i.test(expected.transcriptHash || '')
  ) {
    return {
      ok: false,
      reason: 'snapshot_binding_missing',
      detail: 'the immutable Messages transcript snapshot is incomplete',
    };
  }
  const messages = listMessagesForChatWindow({
    chatJid: input.chatJid,
    startTimestamp: input.historyStartTimestamp,
    endTimestamp: null,
    limit: messageCount,
  })
    .filter(
      (message) =>
        !message.is_bot_message && describeMessageForSummary(message),
    )
    .map((message) => ({
      ...message,
      content: describeMessageForSummary(message),
    }));
  if (messages.length !== messageCount) {
    return {
      ok: false,
      reason: 'thread_history_unavailable',
      detail:
        'the exact local Messages transcript window could not be reconstructed',
    };
  }
  const current = buildMessagesThreadFreshnessSnapshot({
    chatJid: input.chatJid,
    messages,
  });
  const latestChanged =
    compareIsoTimestamp(current.latestMessageAt, expected.latestMessageAt) >
      0 ||
    compareIsoTimestamp(current.latestInboundAt, expected.latestInboundAt) >
      0 ||
    compareIsoTimestamp(current.latestOutboundAt, expected.latestOutboundAt) >
      0;
  if (latestChanged) {
    return {
      ok: false,
      reason: 'newer_thread_activity',
      detail: 'the Messages thread has newer activity than the bound draft',
    };
  }
  if (
    current.latestMessageIdentityHash !== expected.latestMessageIdentityHash ||
    current.latestMessageAt !== expected.latestMessageAt ||
    current.latestInboundAt !== (expected.latestInboundAt || null) ||
    current.latestOutboundAt !== (expected.latestOutboundAt || null) ||
    current.messageCount !== expected.messageCount ||
    current.snapshotHash !== expected.snapshotHash ||
    current.transcriptHash !== expected.transcriptHash
  ) {
    return {
      ok: false,
      reason: 'thread_snapshot_changed',
      detail: 'the exact Messages transcript snapshot no longer matches',
    };
  }
  return { ok: true, snapshot: current };
}

export function validateRecentTextReviewFollowupFreshness(input: {
  seedJson?: string | null;
  item: ParsedRecentTextReviewSeed['items'][number];
  now?: Date;
}): RecentTextReviewFreshnessResult {
  const seed = parseRecentTextReviewSeedJson(input.seedJson);
  if (
    isRecentTextReviewSeedStale({
      seedJson: input.seedJson,
      now: input.now,
    })
  ) {
    return {
      ok: false,
      reason: 'seed_too_old',
      outcome: 'blocked_stale',
      detail: 'the review seed is older than the safe follow-up window',
    };
  }
  const target = resolveRecentTextReviewFollowupTarget(input.item);
  if (!target.ok || !target.chatJid) {
    return {
      ok: false,
      reason: 'thread_binding_missing',
      outcome: 'blocked_unbound',
      detail: target.reason,
      target,
    };
  }
  if (
    input.item.communicationThreadId &&
    target.communicationThreadId &&
    input.item.communicationThreadId !== target.communicationThreadId
  ) {
    return {
      ok: false,
      reason: 'thread_binding_changed',
      outcome: 'blocked_unbound',
      detail: 'the selected review item no longer maps to the same thread',
      target,
    };
  }
  const snapshot = input.item.freshnessSnapshot;
  if (!snapshot?.snapshotHash) {
    return { ok: true, reason: 'legacy_no_snapshot', target };
  }
  const snapshotValidation = validateMessagesThreadSnapshotBinding({
    chatJid: target.chatJid,
    historyStartTimestamp: freshnessHistoryStartTimestamp({
      seed,
      item: input.item,
    }),
    freshnessSnapshot: snapshot,
  });
  if (!snapshotValidation.ok) {
    return {
      ok: false,
      reason: snapshotValidation.reason,
      outcome: 'blocked_stale',
      detail: snapshotValidation.detail,
      target,
    };
  }
  return { ok: true, reason: 'fresh', target };
}

/**
 * Action-grade validation for a selected Messages review item. The exact
 * thread named by the immutable review seed is refreshed before its local
 * freshness snapshot is trusted. A global newest-N history read is not a
 * substitute because a quiet selected thread can fall outside that slice.
 */
export async function validateRecentTextReviewFollowupFreshnessAfterTargetedRefresh(input: {
  seedJson?: string | null;
  item: ParsedRecentTextReviewSeed['items'][number];
  now?: Date;
  primeChatHistory: (chatJid: string) => Promise<unknown>;
}): Promise<RecentTextReviewFreshnessResult> {
  const preflight = validateRecentTextReviewFollowupFreshness(input);
  if (!preflight.ok && preflight.reason !== 'thread_history_unavailable') {
    return preflight;
  }

  const target =
    preflight.target || resolveRecentTextReviewFollowupTarget(input.item);
  if (!target.ok || !target.chatJid) {
    return {
      ok: false,
      reason: 'thread_binding_missing',
      outcome: 'blocked_unbound',
      detail: target.reason,
      target,
    };
  }

  try {
    const receipt = await input.primeChatHistory(target.chatJid);
    if (
      !isExactNonEmptyMessagesHistoryRefreshReceipt({
        receipt,
        expectedChatJid: target.chatJid,
      })
    ) {
      return {
        ok: false,
        reason: 'targeted_refresh_failed',
        outcome: 'blocked_stale',
        detail:
          'the exact selected Messages thread refresh returned no verifiable rows',
        target,
      };
    }
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch {
    return {
      ok: false,
      reason: 'targeted_refresh_failed',
      outcome: 'blocked_stale',
      detail: 'the exact selected Messages thread could not be refreshed',
      target,
    };
  }

  const refreshed = validateRecentTextReviewFollowupFreshness(input);
  if (refreshed.ok && refreshed.reason === 'legacy_no_snapshot') {
    return {
      ok: false,
      reason: 'snapshot_binding_missing',
      outcome: 'blocked_stale',
      detail: 'the old review item has no immutable Messages history snapshot',
      target: refreshed.target,
    };
  }
  return refreshed;
}

export function formatRecentTextReviewUnboundReply(
  item: ParsedRecentTextReviewSeed['items'][number],
): string {
  return [
    `I can explain #${item.rank}, but I cannot safely draft or update it because the current Messages thread binding is missing.`,
    'Ask me to review recent texts again so I can re-link it from the synced history.',
  ].join('\n');
}

export function formatRecentTextReviewFreshnessBlockedReply(
  item: ParsedRecentTextReviewSeed['items'][number],
  result: Extract<RecentTextReviewFreshnessResult, { ok: false }>,
): string {
  if (result.outcome === 'blocked_unbound') {
    return formatRecentTextReviewUnboundReply(item);
  }
  if (result.reason === 'seed_too_old') {
    return formatRecentTextReviewStaleReply();
  }
  if (result.reason === 'targeted_refresh_failed') {
    return [
      `I could not refresh the exact Messages thread for #${item.rank}, so I did not create, update, or send anything.`,
      'Ask me to review recent texts again before choosing an action.',
    ].join('\n');
  }
  if (result.reason === 'snapshot_binding_missing') {
    return [
      `The old review data for #${item.rank} has no immutable thread snapshot, so I did not create, update, or send anything.`,
      'Ask me to review recent texts again, then choose from the fresh list.',
    ].join('\n');
  }
  return [
    `I do not want to act on #${item.rank} from the old text review because the Messages thread changed after I reviewed it.`,
    'Ask me to review recent texts again, then choose from the fresh list.',
  ].join('\n');
}

export function recordRecentTextReviewOutcome(input: {
  groupFolder: string;
  item: ParsedRecentTextReviewSeed['items'][number];
  outcome: RecentTextReviewOutcome;
  now?: Date;
  timingHint?: string | null;
}): boolean {
  const now = input.now || new Date();
  const nowIso = now.toISOString();
  const target = resolveRecentTextReviewFollowupTarget(input.item);
  const communicationThreadId =
    target.communicationThreadId || input.item.communicationThreadId || null;
  if (!communicationThreadId) return false;
  const existingThread = getCommunicationThread(communicationThreadId);
  if (!existingThread || existingThread.groupFolder !== input.groupFolder) {
    return false;
  }
  const auditOnly =
    input.outcome === 'blocked_stale' || input.outcome === 'blocked_unbound';

  const nextState: {
    followupState: CommunicationFollowupState;
    urgency: CommunicationUrgency;
    suggestedAction: CommunicationSuggestedAction | null;
  } =
    input.outcome === 'handled'
      ? {
          followupState: 'resolved',
          urgency: 'none',
          suggestedAction: 'ignore',
        }
      : input.outcome === 'skipped'
        ? {
            followupState: 'ignored',
            urgency: 'none',
            suggestedAction: 'ignore',
          }
        : auditOnly
          ? {
              followupState: existingThread.followupState,
              urgency: existingThread.urgency,
              suggestedAction: existingThread.suggestedNextAction || null,
            }
          : input.outcome === 'reminded'
            ? {
                followupState: 'scheduled',
                urgency: input.timingHint?.includes('tonight')
                  ? 'tonight'
                  : 'soon',
                suggestedAction: 'create_reminder',
              }
            : input.outcome === 'saved'
              ? {
                  followupState: 'reply_needed',
                  urgency: 'soon',
                  suggestedAction: 'save_for_later',
                }
              : {
                  followupState: 'reply_needed',
                  urgency: 'soon',
                  suggestedAction:
                    input.outcome === 'drafted' ? 'draft_reply' : 'draft_reply',
                };

  if (!auditOnly) {
    updateCommunicationThread(communicationThreadId, {
      followupState: nextState.followupState,
      urgency: nextState.urgency,
      suggestedNextAction: nextState.suggestedAction,
      updatedAt: nowIso,
    });
  }
  upsertCommunicationSignal({
    id: buildRecentTextReviewOutcomeSignalId({
      itemId: input.item.itemId,
      outcome: input.outcome,
      occurredAt: nowIso,
    }),
    communicationThreadId,
    groupFolder: input.groupFolder,
    sourceChannel:
      existingThread.channel === 'telegram' ? 'telegram' : 'bluebubbles',
    chatJid: target.chatJid || null,
    messageId: null,
    direction: 'handoff',
    summaryText: sanitizeSnippet(
      `Recent text review ${input.outcome}: #${input.item.rank} ${input.item.summaryText}`,
      260,
    ),
    followupState: nextState.followupState,
    suggestedAction: nextState.suggestedAction,
    urgency: nextState.urgency,
    createdAt: nowIso,
  });
  return true;
}

export function buildRecentTextReviewOutcomeSignalId(input: {
  itemId: string;
  outcome: RecentTextReviewOutcome;
  occurredAt: string;
}): string {
  return `communication_signal:recent_text_outcome:${hashText(`${input.itemId}:${input.outcome}:${input.occurredAt}`)}`;
}

export function formatRecentTextReviewItemWhyReply(
  item: ParsedRecentTextReviewSeed['items'][number],
): string {
  return [
    `#${item.rank} ${item.chatLabel}: ${item.whyText || 'recent synced Messages activity'}.`,
    item.summaryText ? `Context: ${item.summaryText}` : null,
    item.recommendedAction ? `Next: ${item.recommendedAction}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildReviewDraftPrompt(input: {
  seedJson?: string | null;
  userText: string;
}): {
  text: string;
  item?: ParsedRecentTextReviewSeed['items'][number];
} | null {
  const followup = parseRecentTextReviewItemFollowup(input);
  if (!followup || followup.kind !== 'draft') return null;
  const style =
    followup.style === 'warmer'
      ? 'Make it warmer.'
      : followup.style === 'more_direct'
        ? 'Make it more direct.'
        : followup.style === 'shorter'
          ? 'Make it shorter.'
          : 'Draft a reply.';
  const selectedSuggestion =
    followup.suggestedReply ||
    (followup.item.suggestedReply
      ? { label: 'suggested', text: followup.item.suggestedReply }
      : null);
  const suggested = selectedSuggestion
    ? ` Starting ${
        normalizeText(selectedSuggestion.label).toLowerCase() === 'suggested'
          ? 'suggestion'
          : `${selectedSuggestion.label} suggestion`
      }: "${selectedSuggestion.text}".`
    : '';
  return {
    item: followup.item,
    text: `${style} Thread: ${followup.item.chatLabel}. Context: ${followup.item.summaryText}. Why it matters: ${followup.item.whyText || followup.item.recommendedAction || 'recent synced Messages review'}.${suggested}`,
  };
}
