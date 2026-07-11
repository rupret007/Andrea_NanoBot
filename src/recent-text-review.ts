import { createHash } from 'crypto';

import {
  getCommunicationThread,
  getAllChats,
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
import {
  buildPersonalContextGraph,
  type PersonalContextGraphReport,
} from './personal-context-graph.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import { recordOpenAiUsageState } from './openai-usage-state.js';
import type {
  CommunicationFollowupState,
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
  latestMessageAt?: string | null;
  latestInboundAt?: string | null;
  latestOutboundAt?: string | null;
  snapshotHash?: string | null;
}

export type RecentTextReviewFreshnessBlockReason =
  | 'seed_too_old'
  | 'thread_binding_missing'
  | 'thread_binding_changed'
  | 'thread_history_unavailable'
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
  contextGraph: PersonalContextGraphReport;
}

interface CandidateAnalysis {
  item: RecentTextReviewItem;
  persist: boolean;
  followupState: CommunicationFollowupState;
  suggestedAction: CommunicationSuggestedAction | null;
  urgency: CommunicationUrgency;
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

export function redactRecentTextReviewText(value: string): string {
  return normalizeText(value)
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
}

function sanitizeSnippet(
  value: string | null | undefined,
  maxLength = 180,
): string {
  return clipText(redactRecentTextReviewText(value || ''), maxLength);
}

function safeChatLabel(chat: ChatInfo): string {
  const name = normalizeText(chat.name);
  if (name && name !== chat.jid && !/\+?\d[\d\s().-]{6,}\d/.test(name)) {
    return clipText(redactRecentTextReviewText(name), 72);
  }
  return chat.is_group ? 'Messages group' : 'Messages chat';
}

export function resolveRecentTextReviewWindow(params: {
  now: Date;
  kind?: CompanionRouteTimeWindowKind | null;
  value?: number | null;
}): { startTimestamp: string; endTimestamp: string | null; label: string } {
  const start = new Date(params.now);
  let end: Date | null = null;
  switch (params.kind) {
    case 'last_hours':
      start.setHours(start.getHours() - Math.max(1, params.value || 1));
      break;
    case 'last_days':
      start.setDate(start.getDate() - Math.max(1, params.value || 1));
      break;
    case 'today':
      start.setHours(0, 0, 0, 0);
      break;
    case 'yesterday':
      end = new Date(start);
      end.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      break;
    case 'this_week': {
      const day = start.getDay();
      const offset = day === 0 ? 6 : day - 1;
      start.setDate(start.getDate() - offset);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case 'default_24h':
    default:
      start.setHours(start.getHours() - 24);
      break;
  }
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
    startTimestamp: start.toISOString(),
    endTimestamp: end ? end.toISOString() : null,
    label,
  };
}

function messageContent(message: NewMessage | undefined): string {
  return sanitizeSnippet(message?.content || '', 180);
}

function isAssistantControlMessage(message: NewMessage): boolean {
  const text = normalizeText(message.content || '');
  if (!text) return false;
  return /^\s*(?:hey\s+)?@(?:andrea|openclaw)\b/i.test(text);
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

function compareIsoTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  if (!left && !right) return 0;
  if (left && !right) return 1;
  if (!left && right) return -1;
  return left!.localeCompare(right!);
}

function buildFreshnessSnapshot(input: {
  chatJid: string;
  messages: NewMessage[];
}): RecentTextReviewFreshnessSnapshot {
  const messages = input.messages.filter(
    (message) => !message.is_bot_message && normalizeText(message.content),
  );
  const latest = latestMessage(messages);
  const latestInbound = findLatestInbound(messages);
  const latestOutbound = findLatestOutbound(messages);
  if (!latest) {
    return {
      latestMessageAt: null,
      latestInboundAt: null,
      latestOutboundAt: null,
      snapshotHash: null,
    };
  }
  const latestContentHash = hashText(normalizeText(latest.content || ''));
  const latestSpeaker = latest.is_from_me ? 'self' : 'other';
  const latestSenderKind = latest.sender_name ? 'named' : 'unknown';
  return {
    latestMessageAt: latest.timestamp || null,
    latestInboundAt: latestInbound?.timestamp || null,
    latestOutboundAt: latestOutbound?.timestamp || null,
    snapshotHash: hashText(
      [
        input.chatJid,
        latest.timestamp || '',
        latestSpeaker,
        latestSenderKind,
        latestContentHash,
        latestInbound?.timestamp || '',
        latestOutbound?.timestamp || '',
      ].join('|'),
    ),
  };
}

function hasDirectQuestion(text: string): boolean {
  const lower = normalizeText(text).toLowerCase();
  return (
    /\?/.test(lower) ||
    /\b(?:can you|could you|would you|will you|do you|did you|are you|were you|is this|does this|what|when|where|who|how|why|should we|should i|let me know|lmk|need you to|please send|please call|can we)\b/.test(
      lower,
    )
  );
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
  return normalized.length >= 8;
}

function extractReplyTopic(text: string): string | null {
  const normalized = normalizeText(text)
    .replace(/^can you\b/i, '')
    .replace(/^could you\b/i, '')
    .replace(/^would you\b/i, '')
    .replace(/^will you\b/i, '')
    .replace(/^please\b/i, '')
    .replace(/\?+$/g, '')
    .trim();
  const patterns = [
    /\bconfirm\s+(?:if|whether)?\s*(.+?)\s+still works\b/i,
    /\bconfirm\s+(?:the\s+)?(.+?)(?:\s+before|\s+by|\s+tonight|\s+today|$)/i,
    /\bsend(?: me)?\s+(?:the\s+)?(.+?)(?:\s+tonight|\s+today|\s+soon|$)/i,
    /\bcheck\s+(?:the\s+)?(.+?)(?:\s+before|\s+by|\s+tonight|\s+today|$)/i,
    /\babout\s+(.+?)(?:\s+tonight|\s+today|$)/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    const candidate = sanitizeSnippet(match?.[1] || '', 56)
      .replace(/\b(?:for me|for us|please)\b/gi, '')
      .trim();
    if (candidate && candidate.length >= 3) return candidate;
  }
  const fallback = sanitizeSnippet(
    normalized
      .replace(
        /\b(?:let me know|lmk|do you want|should we|are we|what|when|where|who|how|why)\b/gi,
        '',
      )
      .trim(),
    56,
  );
  return fallback.length >= 8 ? fallback : null;
}

function buildConversationRecap(input: {
  chatLabel: string;
  messages: NewMessage[];
  latestInbound: NewMessage | undefined;
  latestOutbound: NewMessage | undefined;
  section: RecentTextReviewSection;
  reasons: string[];
}): string {
  const turns = input.messages
    .filter((message) => substantiveMessage(message.content || ''))
    .slice(-4)
    .map((message) => {
      const speaker = message.is_from_me ? 'You' : 'They';
      return `${speaker}: "${sanitizeSnippet(message.content, 120)}"`;
    });
  const flow =
    turns.length > 0
      ? turns.join(' ')
      : input.latestInbound
        ? `They: "${messageContent(input.latestInbound)}"`
        : 'There was recent synced Messages activity.';
  const state =
    input.section === 'needs_reply'
      ? input.latestInbound
        ? `Current state: their latest open turn is "${messageContent(input.latestInbound)}".`
        : 'Current state: there may be an open reply owed.'
      : input.section === 'worth_watching'
        ? `Current state: worth watching because ${input.reasons[0] || 'there was recent activity'}.`
        : input.latestOutbound
          ? `Current state: your latest reply appears to have closed this for now.`
          : 'Current state: no obvious reply is needed from the recent exchange.';
  return `${input.chatLabel}: ${flow} ${state}`;
}

function includesName(value: string, name: string): boolean {
  const normalizedName = normalizeText(name).toLowerCase();
  if (!normalizedName || normalizedName.length < 3) return false;
  return normalizeText(value).toLowerCase().includes(normalizedName);
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
  messages: NewMessage[];
  context: LocalReviewContext;
}): {
  subjectIds: string[];
  lifeThreadIds: string[];
  whyHints: string[];
  providerContext: string[];
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
  const senderNames = Array.from(
    new Set(
      input.messages
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
  const combined = [
    input.chatLabel,
    ...senderNames,
    existingThread?.title || '',
    existingThread?.lastInboundSummary || '',
    existingThread?.lastOutboundSummary || '',
    ...(existingThread?.toneStyleHints || []),
    ...input.messages.slice(-6).map((message) => message.content),
  ].join(' ');
  const linkedSubjectIds = new Set(existingThread?.linkedSubjectIds || []);
  const matchedSubjects = input.context.subjects
    .filter(
      (subject) =>
        linkedSubjectIds.has(subject.id) ||
        includesName(combined, subject.displayName) ||
        includesName(combined, subject.canonicalName),
    )
    .slice(0, 4);
  const subjectIds = matchedSubjects.map((subject) => subject.id);
  const subjectNames = matchedSubjects.map((subject) => subject.displayName);
  const linkedLifeThreadIds = new Set(
    existingThread?.linkedLifeThreadIds || [],
  );
  const matchedLifeThreads = input.context.lifeThreads
    .filter((thread) => {
      if (thread.status === 'closed') return false;
      if (linkedLifeThreadIds.has(thread.id)) return true;
      if (thread.relatedSubjectIds.some((id) => subjectIds.includes(id))) {
        return true;
      }
      return includesName(combined, thread.title);
    })
    .slice(0, 4);
  const matchedGraphInsights = input.context.contextGraph.rankedInsights
    .filter((insight) => {
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
      return (
        includesName(text, input.chatLabel) ||
        senderNames.some((name) => includesName(text, name)) ||
        matchedLifeThreads.some((thread) => includesName(text, thread.title))
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
      ...(existingThread?.toneStyleHints || []),
      ...extractToneHintsFromFacts(facts),
      ...extractToneHintsFromFacts(globalStyleFacts),
    ]),
  ).slice(0, 6);
  const confidence: RecentTextReviewContextConfidence = existingThread
    ? 'high'
    : matchedSubjects.length > 0 || matchedLifeThreads.length > 0
      ? 'medium'
      : input.chatLabel &&
          input.chatLabel !== 'Messages chat' &&
          input.chatLabel !== 'Messages group'
        ? 'medium'
        : 'low';
  const confidenceReason = existingThread
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
    relationshipWeight += 12;
    relationshipReasons.push('existing communication thread');
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
  if (
    input.context.contextGraph.coverage.linkedCommunicationThreads > 0 ||
    input.context.contextGraph.coverage.linkedLifeThreads > 0
  ) {
    relationshipWeight += 4;
    relationshipReasons.push('personal context graph link');
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
  const ambiguousIdentity = matchedSubjects.length > 1 && !existingThread;
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
      ...subjectNames.map(
        (name) => `known person: ${sanitizeSnippet(name, 48)}`,
      ),
      ...matchedLifeThreads.map(
        (thread) => `linked thread: ${sanitizeSnippet(thread.title, 64)}`,
      ),
      existingThread ? 'existing communication thread' : null,
      ...matchedGraphInsights.map(
        (insight) => `graph insight: ${sanitizeSnippet(insight.title, 64)}`,
      ),
    ].filter(Boolean) as string[],
    providerContext: [
      ...subjectNames.map(
        (name) => `Known person: ${sanitizeSnippet(name, 48)}`,
      ),
      ...matchedLifeThreads.map(
        (thread) =>
          `Life thread: ${sanitizeSnippet(thread.title, 64)} - ${sanitizeSnippet(thread.summary, 120)}`,
      ),
      ...facts.map(
        (fact) =>
          `Profile fact about ${sanitizeSnippet(fact.subjectDisplayName, 48)}: ${sanitizeSnippet(fact.sourceSummary || fact.factKey, 120)}`,
      ),
      existingThread?.lastInboundSummary
        ? `Previous communication note: ${sanitizeSnippet(existingThread.lastInboundSummary, 120)}`
        : null,
      input.context.contextGraph.coverage.memoryFacts > 0
        ? `Context graph coverage: ${input.context.contextGraph.coverage.memoryFacts} memory facts, ${input.context.contextGraph.coverage.lifeThreads} life threads`
        : null,
      ...matchedGraphInsights.map(
        (insight) =>
          `Daily graph insight: ${sanitizeSnippet(insight.title, 64)} - ${sanitizeSnippet(insight.nextAction, 100)}`,
      ),
    ].filter(Boolean) as string[],
  };
}

function buildSuggestedReplyOptions(input: {
  latestInbound: NewMessage | undefined;
  directQuestion: boolean;
  sensitive: boolean;
  deadline: boolean;
  chatLabel: string;
  isGroup: boolean;
  contextConfidence: RecentTextReviewContextConfidence;
  riskFlags: string[];
  toneStyleHints: string[];
}): RecentTextReviewSuggestedReply[] {
  if (!input.latestInbound) return [];
  const text = normalizeText(input.latestInbound.content);
  if (!substantiveMessage(text)) return [];
  const topic = extractReplyTopic(text);
  const topicTail = topic ? ` about ${topic}` : '';
  if (input.isGroup) {
    return [
      {
        label: 'careful',
        text: `I saw this${topicTail}. Let me check the details before I answer the group.`,
      },
      {
        label: 'direct',
        text: `I am checking${topicTail} and will send the group a clear answer once I confirm.`,
      },
      {
        label: 'brief',
        text: `Checking${topicTail} now. I will confirm shortly.`,
      },
    ];
  }
  if (
    input.contextConfidence === 'low' ||
    input.riskFlags.includes('ambiguous_identity')
  ) {
    return [
      {
        label: 'careful',
        text: `I saw this${topicTail}. Let me make sure I have the right context before I answer.`,
      },
      {
        label: 'direct',
        text: `I am checking the context${topicTail} before I give you an answer.`,
      },
    ];
  }
  if (input.sensitive) {
    return [
      {
        label: 'warm',
        text: `I hear you. I do not want to answer too quickly, but I do want to understand this and respond thoughtfully.`,
      },
      {
        label: 'direct',
        text: `I saw this and I am thinking it through before I answer.`,
      },
      {
        label: 'brief',
        text: `I hear you. Let me think this through and answer carefully.`,
      },
    ];
  }
  const tone = input.toneStyleHints.join(' ').toLowerCase();
  if (/\bwarm|careful|avoid_overcommitment/.test(tone)) {
    return [
      {
        label: 'warm',
        text: `I saw this${topicTail}, and I want to be thoughtful. I am checking the details before I answer.`,
      },
      {
        label: 'direct',
        text: `I am checking the details${topicTail} and will confirm shortly.`,
      },
      {
        label: 'brief',
        text: `I saw this${topicTail}. Checking the details now.`,
      },
    ];
  }
  if (/\bconcise|direct/.test(tone)) {
    return [
      {
        label: 'direct',
        text: `I saw this${topicTail}. I am checking before I answer.`,
      },
      {
        label: 'brief',
        text: `Checking${topicTail} now. I will confirm shortly.`,
      },
    ];
  }
  if (input.deadline) {
    return [
      {
        label: 'warm',
        text: `I saw this${topicTail}. Let me check what I can commit to and I will confirm shortly.`,
      },
      {
        label: 'direct',
        text: `I am checking${topicTail} now and will confirm shortly.`,
      },
      {
        label: 'brief',
        text: `Checking${topicTail} now. I will confirm soon.`,
      },
    ];
  }
  if (input.directQuestion) {
    return [
      {
        label: 'warm',
        text: `I saw this${topicTail}. Let me check and I will get back to you shortly.`,
      },
      {
        label: 'direct',
        text: `I am checking${topicTail} and will confirm shortly.`,
      },
      {
        label: 'brief',
        text: `Checking${topicTail} now. I will get back to you shortly.`,
      },
    ];
  }
  return [
    {
      label: 'warm',
      text: `Thanks for the heads-up${topicTail}. I saw this and will take a look.`,
    },
    {
      label: 'brief',
      text: `Got it${topicTail}. I will take a look.`,
    },
  ];
}

function classifyThread(input: {
  groupFolder: string;
  chat: ChatInfo;
  messages: NewMessage[];
  context: LocalReviewContext;
}): CandidateAnalysis | null {
  const messages = input.messages.filter(
    (message) =>
      !message.is_bot_message &&
      !isAssistantControlMessage(message) &&
      normalizeText(message.content),
  );
  if (messages.length === 0) return null;
  const latest = latestMessage(messages);
  const latestInbound = findLatestInbound(messages);
  const latestOutbound = findLatestOutbound(messages);
  const chatLabel = safeChatLabel(input.chat);
  const latestInboundText = normalizeText(latestInbound?.content || '');
  const latestText = normalizeText(latest?.content || '');
  const directQuestion = hasDirectQuestion(latestInboundText);
  const deadline = hasDeadline(latestInboundText);
  const sensitive = hasSensitiveSignal(
    [latestInboundText, latestText].join(' '),
  );
  const inboundAfterOutbound =
    Boolean(latestInbound) &&
    (!latestOutbound || latestInbound!.timestamp > latestOutbound.timestamp);
  const selfAnsweredLatest = Boolean(
    latestOutbound &&
    (!latestInbound || latestOutbound.timestamp >= latestInbound.timestamp),
  );
  const learned = buildLearnedContextHints({
    groupFolder: input.groupFolder,
    chatLabel,
    messages,
    context: input.context,
  });
  const riskFlags = [
    input.chat.is_group ? 'group_chat_confirm_audience' : null,
    sensitive ? 'sensitive_tone' : null,
    learned.confidence === 'low' ? 'low_context_confidence' : null,
    learned.ambiguousIdentity ? 'ambiguous_identity' : null,
    selfAnsweredLatest ? 'self_authored_latest' : null,
  ].filter(Boolean) as string[];
  let score = 0;
  const reasons: string[] = [];
  if (inboundAfterOutbound) {
    score += 42;
    reasons.push('latest message from them after your last reply');
  }
  if (directQuestion) {
    score += 28;
    reasons.push('asks for an answer');
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
  if (selfAnsweredLatest) {
    score -= 38;
    reasons.push('your latest reply appears to have answered it');
  }
  if (
    inboundAfterOutbound &&
    !directQuestion &&
    !deadline &&
    !sensitive &&
    /\b(?:lol|haha|fun|nice|cool|awesome|thanks|thx|ok|okay)\b/i.test(
      latestInboundText,
    )
  ) {
    score -= 28;
  }
  if (!substantiveMessage(latestInboundText)) {
    score -= 36;
  }
  if (input.chat.is_group && learned.confidence !== 'high') {
    score -= 8;
  }

  const section: RecentTextReviewSection =
    score >= 52
      ? 'needs_reply'
      : score >= 26
        ? 'worth_watching'
        : 'no_reply_needed';
  const summaryText = buildConversationRecap({
    chatLabel,
    messages,
    latestInbound,
    latestOutbound,
    section,
    reasons,
  });
  const recommendedAction =
    section === 'needs_reply'
      ? input.chat.is_group
        ? 'Say `draft #` only if you want a group-chat draft to review first.'
        : 'Review the suggested reply or say `draft #` to make an approval-gated draft.'
      : section === 'worth_watching'
        ? 'Keep it visible; draft only if you want to close the loop.'
        : 'No action unless you want to add context.';
  const itemId = `text-review:${hashText(`${input.chat.jid}:${latest?.id || latest?.timestamp || ''}`)}`;
  const freshnessSnapshot = buildFreshnessSnapshot({
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
          chatLabel,
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
        const speaker = message.is_from_me ? 'You' : 'Them';
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
    persist: section !== 'no_reply_needed',
    followupState: section === 'needs_reply' ? 'reply_needed' : 'unknown',
    suggestedAction:
      section === 'needs_reply' ? 'draft_reply' : 'save_for_later',
    urgency: deadline ? 'tonight' : section === 'needs_reply' ? 'soon' : 'none',
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
  const threadId =
    existing?.id ||
    `communication_thread:recent_text:${hashText(item.chatJid)}`;
  upsertCommunicationThread({
    id: threadId,
    groupFolder: input.groupFolder,
    title: item.chatLabel,
    linkedSubjectIds: item.linkedSubjectIds,
    linkedLifeThreadIds: item.linkedLifeThreadIds,
    channel: 'bluebubbles',
    channelChatJid: item.chatJid,
    lastInboundSummary: item.summaryText,
    lastOutboundSummary: existing?.lastOutboundSummary || null,
    followupState: input.analysis.followupState,
    urgency: input.analysis.urgency,
    followupDueAt: existing?.followupDueAt || null,
    suggestedNextAction: input.analysis.suggestedAction,
    toneStyleHints: existing?.toneStyleHints || [],
    lastContactAt: item.latestMessageAt || input.nowIso,
    lastMessageId: item.latestMessageId || null,
    linkedTaskId: existing?.linkedTaskId || null,
    inferenceState: 'assistant_inferred',
    trackingMode: existing?.trackingMode || 'default',
    createdAt: existing?.createdAt || input.nowIso,
    updatedAt: input.nowIso,
    disabledAt: existing?.disabledAt || null,
  });
  upsertCommunicationSignal({
    id: `communication_signal:recent_text:${hashText(item.itemId)}`,
    communicationThreadId: threadId,
    groupFolder: input.groupFolder,
    sourceChannel: 'bluebubbles',
    chatJid: item.chatJid,
    messageId: item.latestMessageId || null,
    direction: 'inbound',
    summaryText: item.summaryText,
    followupState: input.analysis.followupState,
    suggestedAction: input.analysis.suggestedAction,
    urgency: input.analysis.urgency,
    createdAt: input.nowIso,
  });
  return {
    ...item,
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

function normalizeSuggestedReplies(
  value: unknown,
): RecentTextReviewSuggestedReply[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === 'string') {
        const text = sanitizeSnippet(item, 220);
        return text
          ? {
              label: index === 0 ? 'suggested' : `option ${index + 1}`,
              text,
            }
          : null;
      }
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const text = sanitizeSnippet(String(record.text || ''), 220);
      if (!text) return null;
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

export function buildRecentTextReviewProviderPrompt(input: {
  windowLabel: string;
  items: RecentTextReviewItem[];
  learnedContext: string[];
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
      suggestedReply: sanitizeSnippet(item.suggestedReply || '', 180),
      suggestedReplies: (item.suggestedReplies || []).map((reply) => ({
        label: sanitizeSnippet(reply.label, 32),
        text: sanitizeSnippet(reply.text, 180),
      })),
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
    'Stay grounded in the provided snippets and learned context summaries; do not invent commitments or availability.',
    'Each item may include summaryText, whyText, recommendedAction, suggestedReply, suggestedReplies, and section.',
    'summaryText should be a fuller recap of the recent exchange and current state, not just one activity stat.',
    'suggestedReplies should contain 2-3 grounded options with labels like warm, direct, brief, or careful.',
    'Suggested replies must be safe suggestions only, not sendable actions, and must not imply the user approved sending.',
    `Window: ${sanitizeSnippet(input.windowLabel, 80)}`,
    `Learned context summaries: ${JSON.stringify(input.learnedContext.map((line) => sanitizeSnippet(line, 180)).slice(0, 10))}`,
    `Review items: ${JSON.stringify(sanitizedItems)}`,
  ].join('\n');
}

async function enhanceWithProvider(input: {
  result: RecentTextReviewResult;
  learnedContext: string[];
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
    learnedContext: input.learnedContext,
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
      if (
        patch.section &&
        ['needs_reply', 'worth_watching', 'no_reply_needed'].includes(
          patch.section,
        )
      ) {
        existing.section = patch.section;
      }
      if (patch.summaryText) {
        existing.summaryText = sanitizeSnippet(patch.summaryText, 260);
      }
      if (patch.whyText) {
        existing.whyText = sanitizeSnippet(patch.whyText, 220);
      }
      if (patch.recommendedAction) {
        existing.recommendedAction = sanitizeSnippet(
          patch.recommendedAction,
          200,
        );
      }
      if (patch.suggestedReply) {
        existing.suggestedReply = sanitizeSnippet(patch.suggestedReply, 220);
      }
      const suggestedReplies = normalizeSuggestedReplies(
        patch.suggestedReplies,
      );
      if (suggestedReplies.length > 0) {
        existing.suggestedReplies = suggestedReplies;
        existing.suggestedReply = suggestedReplies[0]?.text || null;
      } else if (
        patch.suggestedReply &&
        (!existing.suggestedReplies || existing.suggestedReplies.length === 0)
      ) {
        existing.suggestedReplies = [
          {
            label: 'suggested',
            text: sanitizeSnippet(patch.suggestedReply, 220),
          },
        ];
      }
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
  const summaryText =
    input.items.length === 0
      ? `No synced Messages activity needing review over ${input.window.label}.`
      : `${needsReply.length} need${needsReply.length === 1 ? 's' : ''} reply, ${worthWatching.length} worth watching, ${noReplyNeeded.length} no reply needed over ${input.window.label}.`;
  return {
    ok: true,
    reviewedAt: input.reviewedAt || new Date().toISOString(),
    window: input.window,
    summaryText,
    items: input.items,
    needsReply,
    worthWatching,
    noReplyNeeded,
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
    facts: listProfileFactsForGroup(input.groupFolder, [
      'accepted',
      'proposed',
    ]),
    lifeThreads: listLifeThreadsForGroup(input.groupFolder, [
      'active',
      'paused',
    ]),
    communicationThreads: listCommunicationThreadsForGroup({
      groupFolder: input.groupFolder,
      includeDisabled: false,
      limit: 200,
    }),
    contextGraph: buildPersonalContextGraph({
      groupFolder: input.groupFolder,
      now,
    }),
  };
  const analyses = getAllChats()
    .filter(
      (chat) => chat.jid.startsWith('bb:') || chat.channel === 'bluebubbles',
    )
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
  const items = sortItems(persistedItems)
    .filter(
      (item, index) =>
        item.section !== 'no_reply_needed' || index < MAX_REVIEW_ITEMS,
    )
    .slice(0, MAX_REVIEW_ITEMS);
  const learnedContext = [
    ...context.lifeThreads
      .slice(0, 8)
      .map(
        (thread) =>
          `Life thread: ${sanitizeSnippet(thread.title, 64)} - ${sanitizeSnippet(thread.summary, 120)}`,
      ),
    ...context.facts
      .slice(0, 8)
      .map(
        (fact) =>
          `Profile fact about ${sanitizeSnippet(fact.subjectDisplayName, 48)}: ${sanitizeSnippet(fact.sourceSummary || fact.factKey, 120)}`,
      ),
  ];
  const local = buildResultFromItems({
    window,
    items,
    providerUsed: 'local',
    reviewedAt: nowIso,
  });
  return enhanceWithProvider({
    result: local,
    learnedContext,
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
  const reply =
    replyOptions.length > 0
      ? [
          '\n   Suggested replies:',
          ...replyOptions
            .slice(0, channel === 'bluebubbles' ? 3 : 2)
            .map(
              (option) =>
                `   - ${sanitizeSnippet(option.label, 32)}: "${sanitizeSnippet(option.text, 220)}"`,
            ),
        ].join('\n')
      : '';
  const caution = item.riskFlags.includes('group_chat_confirm_audience')
    ? '\n   Caution: group chat - draft only until you review it.'
    : item.riskFlags.includes('low_context_confidence')
      ? '\n   Caution: low context confidence - confirm before drafting.'
      : '';
  const summaryLimit = channel === 'bluebubbles' ? 360 : 260;
  return `${item.rank}. ${item.chatLabel}: ${sanitizeSnippet(item.summaryText, summaryLimit)}\n   Why: ${sanitizeSnippet(item.whyText, 180)}\n   Next: ${sanitizeSnippet(item.recommendedAction, 180)}${caution}${reply}`;
}

export function formatRecentTextReviewReply(input: {
  result: RecentTextReviewResult;
  channel: 'telegram' | 'bluebubbles';
}): string {
  const { result } = input;
  if (result.items.length === 0) {
    return `I checked synced Messages for ${result.window.label} and didn't find any conversations that need attention.\n\nSource: Messages sync checked at ${result.reviewedAt}.`;
  }
  const topLimit = input.channel === 'bluebubbles' ? 3 : 6;
  const needs = result.needsReply
    .slice(0, topLimit)
    .map((item) => formatItemLine(item, input.channel));
  const watching = result.worthWatching
    .slice(0, Math.max(0, topLimit - needs.length))
    .map((item) => formatItemLine(item, input.channel));
  const noReply =
    input.channel === 'telegram'
      ? result.noReplyNeeded
          .slice(0, 3)
          .map((item) => formatItemLine(item, input.channel))
      : [];
  const sections = [
    result.summaryText,
    `Source: Messages sync checked for ${result.window.label}; ${result.items.length} ${result.items.length === 1 ? 'conversation' : 'conversations'} reviewed.`,
    result.providerNote,
    needs.length > 0 ? ['Needs reply', ...needs].join('\n') : null,
    watching.length > 0 ? ['Worth watching', ...watching].join('\n') : null,
    noReply.length > 0 ? ['No reply needed', ...noReply].join('\n') : null,
    result.needsReply.length > 0
      ? 'Say `draft #1`, `make #2 warmer`, or `remind me about that` to continue.'
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
      chatLabel: item.chatLabel,
      isGroup: item.isGroup,
      communicationThreadId: item.communicationThreadId || null,
      linkedSubjectIds: item.linkedSubjectIds,
      linkedLifeThreadIds: item.linkedLifeThreadIds,
      contextLink: item.contextLink,
      riskFlags: item.riskFlags,
      freshnessSnapshot: item.freshnessSnapshot
        ? {
            latestMessageAt: item.freshnessSnapshot.latestMessageAt || null,
            latestInboundAt: item.freshnessSnapshot.latestInboundAt || null,
            latestOutboundAt: item.freshnessSnapshot.latestOutboundAt || null,
            snapshotHash: item.freshnessSnapshot.snapshotHash || null,
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
    suggestedReplies?: RecentTextReviewSuggestedReply[];
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
                  snapshotHash:
                    typeof raw.snapshotHash === 'string'
                      ? sanitizeSnippet(raw.snapshotHash, 32)
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
  | 'handled';

export interface RecentTextReviewItemFollowup {
  kind: RecentTextReviewItemFollowupKind;
  item: ParsedRecentTextReviewSeed['items'][number];
  style?: 'shorter' | 'warmer' | 'more_direct' | null;
  timingHint?: string | null;
  suggestedReply?: RecentTextReviewSuggestedReply | null;
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
): RecentTextReviewItemFollowup['style'] {
  if (/\bwarmer|less stiff\b/.test(normalized)) return 'warmer';
  if (/\bmore direct|blunt\b/.test(normalized)) return 'more_direct';
  if (/\bshorter\b/.test(normalized)) return 'shorter';
  return null;
}

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

  const draftMatch =
    normalized.match(
      /(?:draft|reply to|respond to|make|rewrite|warm(?:er)?|more direct|shorter)\s*(?:item\s*)?(?:#|number\s*)?(\d+)/i,
    ) ||
    (/\b(?:draft|reply|respond|make|rewrite|warm(?:er)?|direct|shorter|option)\b/i.test(
      normalized,
    )
      ? normalized.match(/(?:#|number\s*)(\d+)\b/i)
      : null) ||
    normalized.match(/^(?:#|number\s*)?(\d+)\b/i);
  if (draftMatch) {
    const item = findReviewSeedItemByRank(seed, draftMatch[1]);
    if (!item) return null;
    return {
      kind: 'draft',
      item,
      style: inferReviewDraftStyle(normalized),
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
    thread?.channel === 'bluebubbles' &&
    thread.channelChatJid &&
    thread.disabledAt == null
  ) {
    return {
      ok: true,
      reason: 'resolved through stored communication thread',
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
  const messages = listMessagesForChatWindow({
    chatJid: target.chatJid,
    startTimestamp: freshnessHistoryStartTimestamp({ seed, item: input.item }),
    endTimestamp: null,
    limit: 200,
  }).filter(
    (message) => !message.is_bot_message && normalizeText(message.content),
  );
  if (messages.length === 0) {
    return {
      ok: false,
      reason: 'thread_history_unavailable',
      outcome: 'blocked_stale',
      detail:
        'the synced thread history needed to validate the item is missing',
      target,
    };
  }
  const currentSnapshot = buildFreshnessSnapshot({
    chatJid: target.chatJid,
    messages,
  });
  const latestChanged =
    compareIsoTimestamp(
      currentSnapshot.latestMessageAt,
      snapshot.latestMessageAt,
    ) > 0 ||
    compareIsoTimestamp(
      currentSnapshot.latestInboundAt,
      snapshot.latestInboundAt,
    ) > 0 ||
    compareIsoTimestamp(
      currentSnapshot.latestOutboundAt,
      snapshot.latestOutboundAt,
    ) > 0;
  if (latestChanged) {
    return {
      ok: false,
      reason: 'newer_thread_activity',
      outcome: 'blocked_stale',
      detail: 'the thread has newer activity than the review item',
      target,
    };
  }
  if (
    currentSnapshot.snapshotHash &&
    snapshot.snapshotHash &&
    currentSnapshot.snapshotHash !== snapshot.snapshotHash
  ) {
    return {
      ok: false,
      reason: 'thread_snapshot_changed',
      outcome: 'blocked_stale',
      detail: 'the latest message state no longer matches the review item',
      target,
    };
  }
  return { ok: true, reason: 'fresh', target };
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
        : input.outcome === 'blocked_stale' ||
            input.outcome === 'blocked_unbound'
          ? {
              followupState: 'reply_needed',
              urgency: 'soon',
              suggestedAction: 'draft_reply',
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

  updateCommunicationThread(communicationThreadId, {
    followupState: nextState.followupState,
    urgency: nextState.urgency,
    suggestedNextAction: nextState.suggestedAction,
    lastInboundSummary: input.item.summaryText,
    updatedAt: nowIso,
  });
  upsertCommunicationSignal({
    id: `communication_signal:recent_text_outcome:${hashText(`${input.item.itemId}:${input.outcome}:${nowIso}`)}`,
    communicationThreadId,
    groupFolder: input.groupFolder,
    sourceChannel: 'bluebubbles',
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
