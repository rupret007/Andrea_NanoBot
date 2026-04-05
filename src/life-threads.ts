import crypto from 'crypto';

import {
  deleteLifeThread,
  deleteRouterState,
  getLifeThread,
  getProfileSubjectByKey,
  getRouterState,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  listProfileSubjectsForGroup,
  listRecentMessagesForChat,
  reassignLifeThreadSignals,
  setRouterState,
  updateLifeThread,
  upsertLifeThread,
  upsertLifeThreadSignal,
  upsertProfileSubject,
} from './db.js';
import type {
  LastReferencedLifeThreadState,
  LifeThread,
  LifeThreadCategory,
  LifeThreadCommandChannel,
  LifeThreadScope,
  LifeThreadSensitivity,
  LifeThreadSnapshot,
  PendingLifeThreadSuggestionState,
  ProfileSubject,
} from './types.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';

export interface LifeThreadContextReference {
  summaryText?: string;
  usedThreadIds?: string[];
  usedThreadTitles?: string[];
  usedThreadReasons?: string[];
  threadSummaryLines?: string[];
}

export interface LifeThreadCommandInput {
  groupFolder: string;
  channel: LifeThreadCommandChannel;
  text: string;
  chatJid?: string;
  replyText?: string;
  conversationSummary?: string;
  priorContext?: LifeThreadContextReference | null;
  now?: Date;
}

export interface LifeThreadCommandResult {
  handled: boolean;
  responseText?: string;
  referencedThread?: LifeThread | null;
}

const PENDING_THREAD_SUGGESTION_TTL_MS = 12 * 60 * 60 * 1000;
const LAST_REFERENCED_THREAD_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeText(value: string): string {
  return normalizeVoicePrompt(value).trim();
}

function normalizeTitleKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\bthread\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugifyName(value: string): string {
  return (
    normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

function clipSummary(value: string, max = 160): string {
  const normalized = normalizeText(value).replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}...`;
}

function safeJsonParse<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getPendingSuggestionKey(chatJid: string): string {
  return `life_thread_pending_suggestion:${chatJid}`;
}

function getLastReferencedThreadKey(chatJid: string): string {
  return `life_thread_last_referenced:${chatJid}`;
}

export function getPendingLifeThreadSuggestion(
  chatJid: string,
  now = new Date(),
): PendingLifeThreadSuggestionState | null {
  const raw = getRouterState(getPendingSuggestionKey(chatJid));
  const parsed = safeJsonParse<PendingLifeThreadSuggestionState | null>(raw, null);
  if (!parsed || parsed.version !== 1 || !parsed.expiresAt) {
    if (raw) deleteRouterState(getPendingSuggestionKey(chatJid));
    return null;
  }
  const expiresAtMs = Date.parse(parsed.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < now.getTime()) {
    deleteRouterState(getPendingSuggestionKey(chatJid));
    return null;
  }
  return parsed;
}

export function setPendingLifeThreadSuggestion(
  chatJid: string,
  state: PendingLifeThreadSuggestionState,
): void {
  setRouterState(getPendingSuggestionKey(chatJid), JSON.stringify(state));
}

export function clearPendingLifeThreadSuggestion(chatJid: string): void {
  deleteRouterState(getPendingSuggestionKey(chatJid));
}

export function getLastReferencedLifeThread(
  chatJid: string,
  now = new Date(),
): LastReferencedLifeThreadState | null {
  const raw = getRouterState(getLastReferencedThreadKey(chatJid));
  const parsed = safeJsonParse<LastReferencedLifeThreadState | null>(raw, null);
  if (!parsed || parsed.version !== 1 || !parsed.createdAt || !parsed.threadId) {
    if (raw) deleteRouterState(getLastReferencedThreadKey(chatJid));
    return null;
  }
  const createdAtMs = Date.parse(parsed.createdAt);
  if (
    !Number.isFinite(createdAtMs) ||
    createdAtMs + LAST_REFERENCED_THREAD_TTL_MS < now.getTime()
  ) {
    deleteRouterState(getLastReferencedThreadKey(chatJid));
    return null;
  }
  return parsed;
}

export function setLastReferencedLifeThread(
  chatJid: string,
  thread: LifeThread,
  now = new Date(),
): void {
  setRouterState(
    getLastReferencedThreadKey(chatJid),
    JSON.stringify({
      version: 1,
      threadId: thread.id,
      title: thread.title,
      createdAt: now.toISOString(),
    } satisfies LastReferencedLifeThreadState),
  );
}

export function clearLastReferencedLifeThread(chatJid: string): void {
  deleteRouterState(getLastReferencedThreadKey(chatJid));
}

function buildProfileSubjectId(
  groupFolder: string,
  kind: ProfileSubject['kind'],
  canonicalName: string,
): string {
  return `${groupFolder}:${kind}:${canonicalName}`;
}

function humanizeThreadTitle(rawTitle: string): string {
  return rawTitle
    .trim()
    .replace(/\s+/g, ' ')
    .split(/(\s+|\/|-)/)
    .map((part) => {
      if (!part.trim() || /^[\/-]$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

function ensureProfileSubject(
  groupFolder: string,
  kind: ProfileSubject['kind'],
  displayName: string,
  now = new Date(),
): ProfileSubject {
  const canonicalName =
    kind === 'self'
      ? 'self'
      : kind === 'household'
        ? 'household'
        : slugifyName(displayName);
  const existing = getProfileSubjectByKey(groupFolder, kind, canonicalName);
  if (existing) {
    if (existing.displayName !== displayName) {
      const updated: ProfileSubject = {
        ...existing,
        displayName,
        updatedAt: now.toISOString(),
      };
      upsertProfileSubject(updated);
      return updated;
    }
    return existing;
  }

  const subject: ProfileSubject = {
    id: buildProfileSubjectId(groupFolder, kind, canonicalName),
    groupFolder,
    kind,
    canonicalName,
    displayName,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function inferCategoryScope(params: {
  title: string;
  summary: string;
}): {
  category: LifeThreadCategory;
  scope: LifeThreadScope;
  sensitivity: LifeThreadSensitivity;
  contextTags: string[];
} {
  const haystack = `${params.title} ${params.summary}`.toLowerCase();
  const tags = new Set<string>();
  const add = (...values: string[]) => values.forEach((value) => tags.add(value));

  if (/\b(candace|wife|partner|spouse|relationship)\b/.test(haystack)) {
    add('candace', 'relationship');
    return {
      category: 'relationship',
      scope: /\b(family|house|home|kids|school)\b/.test(haystack)
        ? 'mixed'
        : 'personal',
      sensitivity: 'sensitive',
      contextTags: [...tags],
    };
  }
  if (/\b(travis|school|pickup|dropoff|practice|game|kids?)\b/.test(haystack)) {
    add('family', 'school');
    return {
      category: 'school',
      scope: 'family',
      sensitivity: 'sensitive',
      contextTags: [...tags],
    };
  }
  if (/\b(house|home|errand|chores?|logistics|dinner|grocer|household)\b/.test(haystack)) {
    add('household');
    return {
      category: 'household',
      scope: 'household',
      sensitivity: 'normal',
      contextTags: [...tags],
    };
  }
  if (/\b(band|music|rehearsal|show|setlist)\b/.test(haystack)) {
    add('band', 'community');
    return {
      category: 'community',
      scope: 'personal',
      sensitivity: 'normal',
      contextTags: [...tags],
    };
  }
  if (/\b(health|doctor|workout|exercise|routine|sleep)\b/.test(haystack)) {
    add('health');
    return {
      category: /\broutine\b/.test(haystack) ? 'routine' : 'health',
      scope: 'personal',
      sensitivity: 'sensitive',
      contextTags: [...tags],
    };
  }
  if (/\b(work|project|client|repo|deploy|docs|cursor|codex)\b/.test(haystack)) {
    add('work');
    return {
      category: /\bproject\b/.test(haystack) ? 'project' : 'work',
      scope: 'work',
      sensitivity: 'normal',
      contextTags: [...tags],
    };
  }
  if (/\bfamily\b/.test(haystack)) {
    add('family');
    return {
      category: 'family',
      scope: 'family',
      sensitivity: 'normal',
      contextTags: [...tags],
    };
  }
  return {
    category: 'personal',
    scope: 'personal',
    sensitivity: 'normal',
    contextTags: [...tags],
  };
}

function extractRelatedSubjectIds(
  groupFolder: string,
  title: string,
  summary: string,
  now: Date,
): string[] {
  const haystack = `${title} ${summary}`.toLowerCase();
  const subjects = listProfileSubjectsForGroup(groupFolder);
  const matches = subjects
    .filter((subject) => {
      if (subject.kind !== 'person' && subject.kind !== 'household') return false;
      return haystack.includes(subject.displayName.toLowerCase());
    })
    .map((subject) => subject.id);

  if (matches.length > 0) return matches;

  const personMatch = haystack.match(/\b(candace|travis)\b/i);
  if (personMatch) {
    return [
      ensureProfileSubject(groupFolder, 'person', personMatch[1], now).id,
    ];
  }
  if (/\bfamily|household|home\b/i.test(haystack)) {
    return [ensureProfileSubject(groupFolder, 'household', 'household', now).id];
  }
  return [];
}

function formatThreadSummaryLine(thread: LifeThread): string {
  const main = thread.nextAction || thread.summary;
  return `${thread.title}: ${main}`;
}

function formatThreadReference(thread: LifeThread): string {
  const detail = thread.nextAction || thread.summary;
  return `${thread.title} is ${thread.status}, and the main thing in it is ${detail}.`;
}

function formatThreadListTelegram(threads: LifeThread[]): string {
  if (threads.length === 0) {
    return 'You do not have any active life threads right now.';
  }
  const lines = threads.slice(0, 6).map((thread) => {
    const followup = thread.nextFollowupAt
      ? ` · follow up ${new Date(thread.nextFollowupAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}`
      : '';
    return `- ${formatThreadSummaryLine(thread)} (${thread.scope}, ${thread.status})${followup}`;
  });
  return ['Active life threads:', ...lines].join('\n');
}

function formatThreadListAlexa(threads: LifeThread[]): string {
  if (threads.length === 0) {
    return 'You do not have any active life threads right now.';
  }
  const first = threads[0]!;
  return buildVoiceReply({
    summary: `You have ${threads.length} active life ${threads.length === 1 ? 'thread' : 'threads'}.`,
    details: [
      formatThreadSummaryLine(first),
      threads[1] ? formatThreadSummaryLine(threads[1]) : null,
    ],
    maxDetails: 2,
  });
}

function findThreadByTitle(
  groupFolder: string,
  title: string,
  statuses: LifeThread['status'][] = ['active', 'paused', 'closed', 'archived'],
): LifeThread | undefined {
  const titleKey = normalizeTitleKey(title);
  return listLifeThreadsForGroup(groupFolder, statuses).find(
    (thread) => normalizeTitleKey(thread.title) === titleKey,
  );
}

function findThreadByPersonName(
  groupFolder: string,
  personName: string,
): LifeThread | undefined {
  const titleKey = normalizeTitleKey(personName);
  return listLifeThreadsForGroup(groupFolder).find((thread) => {
    if (normalizeTitleKey(thread.title) === titleKey) return true;
    return thread.contextTags.some((tag) => normalizeTitleKey(tag) === titleKey);
  });
}

function resolveContextThread(params: {
  groupFolder: string;
  chatJid?: string;
  priorContext?: LifeThreadContextReference | null;
  explicitTitle?: string | null;
  now: Date;
}): LifeThread | undefined {
  if (params.explicitTitle) {
    const explicit = findThreadByTitle(params.groupFolder, params.explicitTitle);
    if (explicit) return explicit;
  }
  if (params.priorContext?.usedThreadIds?.length === 1) {
    const fromContext = getLifeThread(params.priorContext.usedThreadIds[0]!);
    if (fromContext && fromContext.groupFolder === params.groupFolder) {
      return fromContext;
    }
  }
  if (params.chatJid) {
    const lastRef = getLastReferencedLifeThread(params.chatJid, params.now);
    if (lastRef) {
      const referenced = getLifeThread(lastRef.threadId);
      if (referenced && referenced.groupFolder === params.groupFolder) {
        return referenced;
      }
      clearLastReferencedLifeThread(params.chatJid);
    }
  }
  return undefined;
}

function upsertExplicitLifeThread(params: {
  groupFolder: string;
  title: string;
  summary: string;
  channel: LifeThreadCommandChannel;
  sourceKind?: LifeThread['sourceKind'];
  nextAction?: string | null;
  nextFollowupAt?: string | null;
  chatJid?: string;
  now: Date;
}): LifeThread {
  const title = humanizeThreadTitle(params.title);
  const summary = clipSummary(params.summary);
  const defaultNextAction = summary || null;
  const inferred = inferCategoryScope({
    title,
    summary,
  });
  const relatedSubjectIds = extractRelatedSubjectIds(
    params.groupFolder,
    title,
    summary,
    params.now,
  );
  const existing = findThreadByTitle(params.groupFolder, title);
  const record: LifeThread = existing
    ? {
        ...existing,
        title,
        summary,
        nextAction:
          params.nextAction !== undefined
            ? params.nextAction
            : existing.nextAction || defaultNextAction,
        nextFollowupAt:
          params.nextFollowupAt !== undefined
            ? params.nextFollowupAt
            : existing.nextFollowupAt || null,
        category: inferred.category,
        scope: inferred.scope,
        relatedSubjectIds:
          relatedSubjectIds.length > 0
            ? relatedSubjectIds
            : existing.relatedSubjectIds,
        contextTags: [...new Set([...existing.contextTags, ...inferred.contextTags])],
        sourceKind: params.sourceKind || 'explicit',
        confidenceKind: 'explicit',
        userConfirmed: true,
        sensitivity: inferred.sensitivity,
        surfaceMode: existing.surfaceMode || 'default',
        status: 'active',
        mergedIntoThreadId: null,
        lastUpdatedAt: params.now.toISOString(),
        lastUsedAt: params.now.toISOString(),
      }
    : {
        id: crypto.randomUUID(),
        groupFolder: params.groupFolder,
        title,
        category: inferred.category,
        status: 'active',
        scope: inferred.scope,
        relatedSubjectIds,
        contextTags: inferred.contextTags,
        summary,
        nextAction: params.nextAction !== undefined ? params.nextAction : defaultNextAction,
        nextFollowupAt: params.nextFollowupAt || null,
        sourceKind: params.sourceKind || 'explicit',
        confidenceKind: 'explicit',
        userConfirmed: true,
        sensitivity: inferred.sensitivity,
        surfaceMode: 'default',
        mergedIntoThreadId: null,
        createdAt: params.now.toISOString(),
        lastUpdatedAt: params.now.toISOString(),
        lastUsedAt: params.now.toISOString(),
      };

  upsertLifeThread(record);
  upsertLifeThreadSignal({
    id: crypto.randomUUID(),
    threadId: record.id,
    groupFolder: params.groupFolder,
    sourceKind: params.sourceKind || 'explicit',
    summaryText: summary,
    chatJid: params.chatJid || null,
    confidenceKind: 'explicit',
    createdAt: params.now.toISOString(),
  });
  return record;
}

function deriveTitleFromSummary(summary: string): string {
  const lower = summary.toLowerCase();
  if (/\bcandace\b/.test(lower)) return 'Candace';
  if (/\btravis\b/.test(lower)) return 'Travis / School';
  if (/\bband\b/.test(lower)) return 'Band';
  if (/\bhouse|home|errand|chores?\b/.test(lower)) return 'Household';
  if (/\bwork|project|repo|docs|client|cursor|codex\b/.test(lower)) {
    return 'Work';
  }
  if (/\bhealth|doctor|workout|sleep|routine\b/.test(lower)) {
    return 'Health / Routines';
  }
  return 'Follow-up';
}

export function maybeCreatePendingLifeThreadSuggestion(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  replyText?: string;
  conversationSummary?: string;
  now?: Date;
}): PendingLifeThreadSuggestionState | null {
  const now = input.now || new Date();
  if (getPendingLifeThreadSuggestion(input.chatJid, now)) {
    return null;
  }

  const summary = clipSummary(
    input.replyText || input.conversationSummary || input.text,
  );
  if (!summary || summary.length < 8) {
    return null;
  }

  const inferredTitle = deriveTitleFromSummary(summary);
  const inferred = inferCategoryScope({
    title: inferredTitle,
    summary,
  });
  if (inferred.sensitivity === 'sensitive') {
    return null;
  }
  if (findThreadByTitle(input.groupFolder, inferredTitle, ['active', 'paused'])) {
    return null;
  }

  const topicMatcher = new RegExp(
    `\\b${inferredTitle
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')}\\b`,
    'i',
  );
  const messages = listRecentMessagesForChat(input.chatJid, 20).filter((message) =>
    topicMatcher.test(message.content),
  );
  const distinctDays = new Set(
    messages.map((message) => {
      const date = new Date(message.timestamp);
      return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }),
  );
  if (messages.length < 3 || distinctDays.size < 2) {
    return null;
  }

  const suggestion: PendingLifeThreadSuggestionState = {
    version: 1,
    title: inferredTitle,
    category: inferred.category,
    scope: inferred.scope,
    summary,
    nextAction: summary,
    sourceKind: 'inferred',
    confidenceKind: 'high',
    sensitivity: inferred.sensitivity,
    relatedSubjectIds: extractRelatedSubjectIds(
      input.groupFolder,
      inferredTitle,
      summary,
      now,
    ),
    contextTags: inferred.contextTags,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_THREAD_SUGGESTION_TTL_MS).toISOString(),
  };
  setPendingLifeThreadSuggestion(input.chatJid, suggestion);
  return suggestion;
}

export function buildLifeThreadSnapshot(params: {
  groupFolder: string;
  now?: Date;
  selectedWorkTitle?: string | null;
}): LifeThreadSnapshot {
  const now = params.now || new Date();
  const activeThreads = listLifeThreadsForGroup(params.groupFolder, ['active'])
    .filter((thread) => thread.surfaceMode !== 'manual_only')
    .sort((left, right) => {
      const leftDue = left.nextFollowupAt
        ? Date.parse(left.nextFollowupAt)
        : Number.MAX_SAFE_INTEGER;
      const rightDue = right.nextFollowupAt
        ? Date.parse(right.nextFollowupAt)
        : Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
    });

  const dueFollowups = activeThreads.filter((thread) => {
    if (!thread.nextFollowupAt) return false;
    const followupMs = Date.parse(thread.nextFollowupAt);
    return Number.isFinite(followupMs) && followupMs <= now.getTime() + 24 * 60 * 60 * 1000;
  });

  const householdCarryover =
    activeThreads.find((thread) =>
      ['household', 'family', 'mixed'].includes(thread.scope) ||
      thread.category === 'relationship' ||
      thread.contextTags.some((tag) =>
        ['candace', 'family', 'household', 'home'].includes(normalizeTitleKey(tag)),
      ),
    ) || null;

  const recommendedNextThread =
    dueFollowups.find((thread) => {
      if (!params.selectedWorkTitle) return true;
      return normalizeTitleKey(thread.title) !== normalizeTitleKey(params.selectedWorkTitle);
    }) ||
    activeThreads.find((thread) => {
      if (!thread.nextAction && !thread.summary) return false;
      if (!params.selectedWorkTitle) return true;
      return normalizeTitleKey(thread.title) !== normalizeTitleKey(params.selectedWorkTitle);
    }) ||
    null;

  return {
    activeThreads,
    dueFollowups,
    householdCarryover,
    recommendedNextThread,
  };
}

function buildThreadDetailReply(
  channel: LifeThreadCommandChannel,
  thread: LifeThread,
): string {
  const signals = listLifeThreadSignals(thread.id, 3);
  const detailLines = [
    `Summary: ${thread.summary}`,
    thread.nextAction ? `Next action: ${thread.nextAction}` : null,
    thread.nextFollowupAt
      ? `Next follow-up: ${new Date(thread.nextFollowupAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}`
      : null,
    signals[0] ? `Latest signal: ${signals[0].summaryText}` : null,
  ].filter((line): line is string => Boolean(line));

  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: formatThreadReference(thread),
      details: [detailLines[1] || null, detailLines[2] || null],
      maxDetails: 2,
    });
  }
  return [
    `${thread.title} (${thread.status})`,
    ...detailLines.map((line) => `- ${line}`),
  ].join('\n');
}

function buildWhyStillOpenReply(
  channel: LifeThreadCommandChannel,
  thread: LifeThread,
): string {
  const latestSignals = listLifeThreadSignals(thread.id, 2);
  const reason =
    thread.nextAction ||
    thread.nextFollowupAt ||
    latestSignals[0]?.summaryText ||
    thread.summary;
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: `I still treat ${thread.title} as open because ${reason}.`,
      details: [
        thread.nextFollowupAt ? 'It still has a follow-up attached.' : null,
      ],
      maxDetails: 1,
    });
  }
  return [
    `I still treat ${thread.title} as open because ${reason}.`,
    latestSignals[0] ? `Latest signal: ${latestSignals[0].summaryText}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildThreadExplainabilityReply(
  channel: LifeThreadCommandChannel,
  priorContext: LifeThreadContextReference | null | undefined,
): string {
  const titles = priorContext?.usedThreadTitles || [];
  if (titles.length === 0) {
    return channel === 'alexa'
      ? 'I am not leaning on a saved life thread for that answer.'
      : 'I was not leaning on a saved life thread for that answer.';
  }
  const reasons = priorContext?.usedThreadReasons || [];
  const details = titles.map((title, index) =>
    reasons[index] ? `${title} because ${reasons[index]}` : title,
  );
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: `I was using ${details[0]}.`,
      details: [details[1] || null],
      maxDetails: 1,
    });
  }
  return ['Thread context in play:', ...details.map((detail) => `- ${detail}`)].join(
    '\n',
  );
}

function buildSaveConfirmation(
  channel: LifeThreadCommandChannel,
  thread: LifeThread,
  summary: string,
): string {
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: `Okay. I saved that under ${thread.title}.`,
      details: [summary],
      maxDetails: 1,
    });
  }
  return `Okay. I saved that under the ${thread.title} thread.\n- ${summary}`;
}

function getSummarySource(input: LifeThreadCommandInput): string {
  return clipSummary(
    input.replyText ||
      input.conversationSummary ||
      input.priorContext?.summaryText ||
      input.text,
  );
}

function confirmPendingSuggestion(
  input: LifeThreadCommandInput,
  pending: PendingLifeThreadSuggestionState,
): LifeThreadCommandResult {
  const thread = upsertExplicitLifeThread({
    groupFolder: input.groupFolder,
    title: pending.title,
    summary: pending.summary,
    channel: input.channel,
    sourceKind: 'explicit',
    nextAction: pending.nextAction || null,
    chatJid: input.chatJid,
    now: input.now || new Date(),
  });
  if (input.chatJid) {
    clearPendingLifeThreadSuggestion(input.chatJid);
    setLastReferencedLifeThread(input.chatJid, thread, input.now || new Date());
  }
  return {
    handled: true,
    responseText:
      input.channel === 'alexa'
        ? `Okay. I will keep ${thread.title} as an active thread.`
        : `Okay. I will keep ${thread.title} as an active life thread.`,
    referencedThread: thread,
  };
}

function rejectPendingSuggestion(
  input: LifeThreadCommandInput,
): LifeThreadCommandResult {
  if (input.chatJid) {
    clearPendingLifeThreadSuggestion(input.chatJid);
  }
  return {
    handled: true,
    responseText:
      input.channel === 'alexa'
        ? 'Okay. I will leave that out of your saved threads.'
        : 'Okay. I will not turn that into a saved life thread.',
    referencedThread: null,
  };
}

export function buildLifeThreadSuggestionAskText(title: string): string {
  return `This has been coming up a few times. Want me to keep it as the ${title} thread?`;
}

export function handleLifeThreadCommand(
  input: LifeThreadCommandInput,
): LifeThreadCommandResult {
  const now = input.now || new Date();
  const raw = normalizeText(input.text);
  const normalized = raw.toLowerCase();
  if (!normalized) return { handled: false };

  if (input.chatJid) {
    const pending = getPendingLifeThreadSuggestion(input.chatJid, now);
    if (pending && /^(yes|yeah|sure|do it|okay)\b/i.test(normalized)) {
      return confirmPendingSuggestion(input, pending);
    }
    if (pending && /^(no|nope|not now|skip)\b/i.test(normalized)) {
      return rejectPendingSuggestion(input);
    }
  }

  if (/^(what threads do i have open|what('?s| is) active right now)\b/i.test(normalized)) {
    const threads = listLifeThreadsForGroup(input.groupFolder, ['active']);
    return {
      handled: true,
      responseText:
        input.channel === 'alexa'
          ? formatThreadListAlexa(threads)
          : formatThreadListTelegram(threads),
      referencedThread: threads[0] || null,
    };
  }

  const stillOpenMatch = raw.match(/^what('?s| is) still open with ([a-z][a-z' /-]+)\??$/i);
  if (stillOpenMatch) {
    const thread = findThreadByPersonName(input.groupFolder, stillOpenMatch[2]);
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread)
        : `I do not have an active ${stillOpenMatch[2]} thread yet.`,
      referencedThread: thread || null,
    };
  }

  if (/^is there anything i still need to handle for (the )?(house|home)\??$/i.test(normalized)) {
    const thread =
      findThreadByTitle(input.groupFolder, 'Household', ['active']) ||
      listLifeThreadsForGroup(input.groupFolder, ['active']).find(
        (candidate) =>
          candidate.scope === 'household' || candidate.category === 'household',
      );
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread)
        : 'I do not have an active house thread right now.',
      referencedThread: thread || null,
    };
  }

  const mergeMatch = raw.match(/^merge (?:the )?(.+?) thread into (?:the )?(.+?) thread$/i);
  if (mergeMatch) {
    const fromThread = findThreadByTitle(input.groupFolder, mergeMatch[1]);
    const toThread = findThreadByTitle(input.groupFolder, mergeMatch[2]);
    if (!fromThread || !toThread) {
      return {
        handled: true,
        responseText: 'I need both thread names to merge them cleanly.',
        referencedThread: null,
      };
    }
    reassignLifeThreadSignals(fromThread.id, toThread.id);
    updateLifeThread(fromThread.id, {
      status: 'archived',
      mergedIntoThreadId: toThread.id,
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    updateLifeThread(toThread.id, {
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I merged ${fromThread.title} into ${toThread.title}.`,
      referencedThread: getLifeThread(toThread.id) || toThread,
    };
  }

  const thread = resolveContextThread({
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    priorContext: input.priorContext,
    now,
  });

  const renameMatch = raw.match(/^rename (?:that|this|the)? ?thread to (.+)$/i);
  if (renameMatch) {
    if (!thread) {
      return { handled: true, responseText: 'I need the thread first before I can rename it.' };
    }
    const nextTitle = clipSummary(renameMatch[1], 60);
    updateLifeThread(thread.id, {
      title: nextTitle,
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I renamed that thread to ${nextTitle}.`,
      referencedThread: getLifeThread(thread.id) || { ...thread, title: nextTitle },
    };
  }

  if (/^(close that thread|close that|archive that thread|archive that)\b/i.test(normalized)) {
    if (!thread) {
      return { handled: true, responseText: 'I need the thread first before I can close it.' };
    }
    const nextStatus = normalized.includes('archive') ? 'archived' : 'closed';
    updateLifeThread(thread.id, {
      status: nextStatus,
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. ${thread.title} is ${nextStatus}.`,
      referencedThread: getLifeThread(thread.id) || thread,
    };
  }

  if (/^(pause that thread|pause that)\b/i.test(normalized)) {
    if (!thread) {
      return { handled: true, responseText: 'I need the thread first before I can pause it.' };
    }
    updateLifeThread(thread.id, {
      status: 'paused',
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I paused ${thread.title}.`,
      referencedThread: getLifeThread(thread.id) || thread,
    };
  }

  if (/^(forget that thread|forget that|delete that thread)\b/i.test(normalized)) {
    if (!thread) {
      return { handled: true, responseText: 'I need the thread first before I can delete it.' };
    }
    deleteLifeThread(thread.id);
    return {
      handled: true,
      responseText: `Okay. I forgot the ${thread.title} thread and its saved signals.`,
      referencedThread: null,
    };
  }

  if (/^(what thread are you using here|what thread are you using there)\b/i.test(normalized)) {
    return {
      handled: true,
      responseText: buildThreadExplainabilityReply(input.channel, input.priorContext),
      referencedThread: thread || null,
    };
  }

  if (/^(what('?s| is) in that thread|what do you know about this thread)\b/i.test(normalized)) {
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread)
        : 'I do not have a single thread in context for that yet.',
      referencedThread: thread || null,
    };
  }

  if (/^(why do you think this is still open)\b/i.test(normalized)) {
    return {
      handled: true,
      responseText: thread
        ? buildWhyStillOpenReply(input.channel, thread)
        : 'I am not holding onto a specific thread strongly enough for that.',
      referencedThread: thread || null,
    };
  }

  if (/^(stop using thread context for this|don'?t bring this up automatically)\b/i.test(normalized)) {
    if (!thread) {
      return { handled: true, responseText: 'I need the thread first before I can quiet it down.' };
    }
    updateLifeThread(thread.id, {
      surfaceMode: 'manual_only',
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I will stop bringing up ${thread.title} automatically.`,
      referencedThread: getLifeThread(thread.id) || thread,
    };
  }

  const saveUnderMatch = raw.match(/^(?:save|track|keep track of)(?: this| that)? (?:under|to|in) (?:the )?(.+?) thread\b/i);
  if (saveUnderMatch) {
    const title = clipSummary(saveUnderMatch[1], 60);
    const summary = getSummarySource(input);
    if (!summary) {
      return { handled: true, responseText: 'Tell me what you want saved first.' };
    }
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title,
      summary,
      channel: input.channel,
      sourceKind: 'explicit',
      chatJid: input.chatJid,
      now,
    });
    return {
      handled: true,
      responseText: buildSaveConfirmation(input.channel, savedThread, summary),
      referencedThread: savedThread,
    };
  }

  const rememberTalkMatch = raw.match(
    /^remember(?: that)? i need to talk to ([a-z][a-z' -]+) about (this|.+?)[.!?]*$/i,
  );
  if (rememberTalkMatch) {
    const personName = clipSummary(rememberTalkMatch[1], 40);
    const capturedSummary = rememberTalkMatch[2]?.trim() || '';
    const summaryBase =
      /^this$/i.test(capturedSummary)
        ? getSummarySource(input)
        : clipSummary(capturedSummary);
    if (!summaryBase) {
      return { handled: true, responseText: 'Tell me what you want saved first.' };
    }
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title: personName,
      summary: summaryBase,
      channel: input.channel,
      sourceKind: 'explicit',
      nextAction: `Talk to ${personName} about ${summaryBase}`,
      chatJid: input.chatJid,
      now,
    });
    return {
      handled: true,
      responseText: `Okay. I will keep that in the ${savedThread.title} thread.`,
      referencedThread: savedThread,
    };
  }

  if (/^(keep track of this for later|save this for later|keep track of this|save this)\b/i.test(normalized)) {
    const summary = getSummarySource(input);
    if (!summary) {
      return { handled: true, responseText: 'Tell me what you want saved first.' };
    }
    const title = deriveTitleFromSummary(summary);
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title,
      summary,
      channel: input.channel,
      sourceKind: 'explicit',
      nextAction: summary,
      chatJid: input.chatJid,
      now,
    });
    return {
      handled: true,
      responseText: buildSaveConfirmation(input.channel, savedThread, summary),
      referencedThread: savedThread,
    };
  }

  return { handled: false };
}
