import crypto from 'crypto';

import {
  applyLifeThreadCommitmentTransition,
  createLifeThreadWithInitialCommitment,
  deleteLifeThread,
  deleteRouterState,
  getLifeThread,
  getProfileSubjectByKey,
  getRouterState,
  listLifeThreadSignals,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
  listRecentMessagesForChat,
  mergeLifeThreadsAtomically,
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
import {
  formatLifeThreadTemporalTruth,
  isLifeThreadTemporalCorrection,
  normalizeLifeThreadTimeZone,
  parseLifeThreadTemporalState,
} from './life-thread-temporal.js';
import {
  buildMatureDeferredCommitment,
  buildOpaqueLifeThreadCommitmentSourceRef,
  buildLifeThreadCommitmentReactivationPatch,
  buildStructuredLifeThreadCommitmentTransition,
  compareLifeThreadCommitmentPriority,
  describeLifeThreadCommitment,
  getLifeThreadCommitment,
  interpretLifeThreadCommitment,
  isLifeThreadCommitmentLanguage,
  projectEffectiveLifeThread,
  redactLifeThreadCommitmentText,
  resumableLifeThreadCommitmentState,
  shouldProactivelySurfaceCommitment,
  type CommitmentInterpretation,
} from './life-thread-commitment.js';
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
  sourceKind?: LifeThread['sourceKind'];
  /** Stable inbound event identity, such as a channel message ID. */
  sourceRef?: string | null;
  messageId?: string | null;
  userConfirmed?: boolean;
  replyText?: string;
  conversationSummary?: string;
  priorContext?: LifeThreadContextReference | null;
  now?: Date;
}

export interface LifeThreadCommandResult {
  handled: boolean;
  responseText?: string;
  referencedThread?: LifeThread | null;
  temporalResolution?: 'applied' | 'duplicate' | 'stale' | 'ambiguous';
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
  const parsed = safeJsonParse<PendingLifeThreadSuggestionState | null>(
    raw,
    null,
  );
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
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.createdAt ||
    !parsed.threadId
  ) {
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
  const safeTitle = redactLifeThreadCommitmentText(parsed.title);
  if (safeTitle !== parsed.title) {
    const safeState = { ...parsed, title: safeTitle };
    setRouterState(
      getLastReferencedThreadKey(chatJid),
      JSON.stringify(safeState),
    );
    return safeState;
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
      title: redactLifeThreadCommitmentText(thread.title),
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
      if (!part.trim() || /^[/ -]$/.test(part)) return part;
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

function inferCategoryScope(params: { title: string; summary: string }): {
  category: LifeThreadCategory;
  scope: LifeThreadScope;
  sensitivity: LifeThreadSensitivity;
  contextTags: string[];
} {
  const haystack = `${params.title} ${params.summary}`.toLowerCase();
  const tags = new Set<string>();
  const add = (...values: string[]) =>
    values.forEach((value) => tags.add(value));

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
  if (
    /\b(house|home|errand|chores?|logistics|dinner|grocer|household)\b/.test(
      haystack,
    )
  ) {
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
  if (
    /\b(work|project|client|repo|deploy|docs|cursor|codex)\b/.test(haystack)
  ) {
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
      if (subject.kind !== 'person' && subject.kind !== 'household')
        return false;
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
    return [
      ensureProfileSubject(groupFolder, 'household', 'household', now).id,
    ];
  }
  return [];
}

function formatThreadSummaryLine(thread: LifeThread, now: Date): string {
  return `${thread.title}: ${describeLifeThreadCommitment(
    thread,
    now,
    lifeThreadTimeZone(thread.groupFolder),
  )}`;
}

function inferFollowupAnchor(rawText: string, now: Date): string | null {
  const normalized = rawText.toLowerCase();
  if (/\btonight\b/.test(normalized)) {
    const target = new Date(now);
    target.setHours(19, 0, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.toISOString();
  }
  if (/\btomorrow\b/.test(normalized)) {
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.toISOString();
  }
  if (/\bbefore i leave\b/.test(normalized)) {
    const target = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    return target.toISOString();
  }
  return null;
}

function formatThreadReference(thread: LifeThread, now: Date): string {
  return `${thread.title} is ${thread.status}. ${describeLifeThreadCommitment(
    thread,
    now,
    lifeThreadTimeZone(thread.groupFolder),
  )}`;
}

function formatThreadListTelegram(threads: LifeThread[], now: Date): string {
  if (threads.length === 0) {
    return 'You do not have any active life threads right now.';
  }
  const lines = threads.slice(0, 6).map((thread) => {
    const followup = thread.nextFollowupAt
      ? ` · follow up ${new Date(thread.nextFollowupAt).toLocaleString(
          'en-US',
          {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          },
        )}`
      : '';
    return `- ${formatThreadSummaryLine(thread, now)} (${thread.scope}, ${thread.status})${followup}`;
  });
  return ['Active life threads:', ...lines].join('\n');
}

function formatThreadListAlexa(threads: LifeThread[], now: Date): string {
  if (threads.length === 0) {
    return 'You do not have any active life threads right now.';
  }
  const first = threads[0]!;
  return buildVoiceReply({
    summary: `You have ${threads.length} active life ${threads.length === 1 ? 'thread' : 'threads'}.`,
    details: [
      formatThreadSummaryLine(first, now),
      threads[1] ? formatThreadSummaryLine(threads[1], now) : null,
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

function findSemanticallyEquivalentThread(
  groupFolder: string,
  title: string,
  summary: string,
  statuses: LifeThread['status'][] = ['active', 'paused', 'closed', 'archived'],
): LifeThread | undefined {
  const titleKey = normalizeTitleKey(title);
  const summaryKey = normalizeText(summary).toLowerCase();
  return listLifeThreadsForGroup(groupFolder, statuses).find((thread) => {
    if (normalizeTitleKey(thread.title) !== titleKey) return false;
    const current = getLifeThreadCommitment(thread);
    return (
      normalizeText(thread.summary).toLowerCase() === summaryKey ||
      normalizeText(current.objective).toLowerCase() === summaryKey
    );
  });
}

function findThreadByPersonName(
  groupFolder: string,
  personName: string,
): LifeThread | undefined {
  const titleKey = normalizeTitleKey(personName);
  return listLifeThreadsForGroup(groupFolder).find((thread) => {
    if (normalizeTitleKey(thread.title) === titleKey) return true;
    return thread.contextTags.some(
      (tag) => normalizeTitleKey(tag) === titleKey,
    );
  });
}

function isGenericAutomaticThreadText(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeText(value || '').toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('the next grounded thing is your schedule') ||
    normalized.includes('i do not have a better signal than that yet') ||
    normalized.includes('nothing else feels especially pressing') ||
    normalized.includes('keep this on deck so it does not slip past today')
  );
}

export function isAutomaticSurfaceWorthyLifeThread(
  thread: LifeThread,
): boolean {
  const summary = thread.summary || '';
  const nextAction = thread.nextAction || '';
  if (!summary.trim() && !nextAction.trim()) {
    return false;
  }
  if (
    isGenericAutomaticThreadText(summary) &&
    (!nextAction.trim() || isGenericAutomaticThreadText(nextAction))
  ) {
    return false;
  }
  return true;
}

export function findLifeThreadForExplicitLookup(params: {
  groupFolder: string;
  query: string;
  statuses?: LifeThread['status'][];
}): LifeThread | null {
  const queryKey = normalizeTitleKey(params.query);
  if (!queryKey) return null;
  const threads = listLifeThreadsForGroup(
    params.groupFolder,
    params.statuses || ['active', 'paused'],
  );
  return (
    threads.find((thread) => normalizeTitleKey(thread.title) === queryKey) ||
    threads.find((thread) =>
      normalizeTitleKey(thread.title).includes(queryKey),
    ) ||
    threads.find((thread) =>
      queryKey.includes(normalizeTitleKey(thread.title)),
    ) ||
    threads.find((thread) =>
      thread.contextTags.some((tag) => normalizeTitleKey(tag) === queryKey),
    ) ||
    threads.find((thread) =>
      thread.contextTags.some(
        (tag) =>
          normalizeTitleKey(tag).includes(queryKey) ||
          queryKey.includes(normalizeTitleKey(tag)),
      ),
    ) ||
    findThreadByPersonName(params.groupFolder, params.query) ||
    null
  );
}

function resolveContextThread(params: {
  groupFolder: string;
  chatJid?: string;
  priorContext?: LifeThreadContextReference | null;
  explicitTitle?: string | null;
  now: Date;
}): LifeThread | undefined {
  if (params.explicitTitle) {
    const explicit = findThreadByTitle(
      params.groupFolder,
      params.explicitTitle,
    );
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

type LifeThreadTerminalOutcome = 'completed' | 'cancelled';

const TERMINAL_TARGET_STOP_WORDS = new Set([
  'ahead',
  'are',
  'about',
  'again',
  'andrea',
  'anymore',
  'cancel',
  'canceled',
  'cancelled',
  'care',
  'check',
  'complete',
  'completed',
  'doing',
  'done',
  'finished',
  'going',
  'into',
  'not',
  'later',
  'lifethread',
  'mark',
  'need',
  'needs',
  'now',
  'save',
  'saved',
  'submitted',
  'synthetic',
  'taken',
  'task',
  'that',
  'the',
  'this',
  'thread',
  'with',
  'was',
  'were',
]);

function inferLifeThreadTerminalOutcome(
  value: string,
): LifeThreadTerminalOutcome | null {
  const normalized = normalizeText(value).toLowerCase();
  if (
    !normalized ||
    /\bnot (?:cancelled|canceled|done|complete)\b/.test(normalized)
  ) {
    return null;
  }
  if (
    /\b(?:cancelled|canceled|called off)\b/.test(normalized) ||
    /\b(?:we|i) (?:are|am) not (?:doing|going ahead with)\b.*\banymore\b/.test(
      normalized,
    )
  ) {
    return 'cancelled';
  }
  if (
    /\b(?:mark|check) (?:that|this|it) (?:done|off)\b/.test(normalized) ||
    /\b(?:task|item|thing) (?:is |was )?(?:taken care of|done|complete|completed)\b/.test(
      normalized,
    ) ||
    /\b(?:i|we) (?:submitted|sent|finished|completed|handled|resolved|paid|bought|booked)\b/.test(
      normalized,
    )
  ) {
    return 'completed';
  }
  return null;
}

function terminalTargetTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(
          (token) =>
            token.length >= 3 &&
            !/\d/.test(token) &&
            !TERMINAL_TARGET_STOP_WORDS.has(token),
        ),
    ),
  ];
}

function resolveTerminalLifeThread(params: {
  groupFolder: string;
  text: string;
  contextThread?: LifeThread;
}): LifeThread | undefined {
  const activeThreads = listLifeThreadsForGroup(params.groupFolder, ['active']);
  const tokens = terminalTargetTokens(params.text);
  const scored = activeThreads
    .map((candidate) => {
      const titleTokens = new Set(terminalTargetTokens(candidate.title));
      const detailTokens = new Set(
        terminalTargetTokens(
          `${candidate.summary} ${candidate.nextAction || ''} ${candidate.contextTags.join(' ')}`,
        ),
      );
      const titleMatches = tokens.filter((token) => titleTokens.has(token));
      const detailMatches = tokens.filter(
        (token) => detailTokens.has(token) && !titleTokens.has(token),
      );
      return {
        candidate,
        score: titleMatches.length * 4 + detailMatches.length,
        titleMatches: titleMatches.length,
        distinctMatches: new Set([...titleMatches, ...detailMatches]).size,
      };
    })
    .filter(
      (entry) =>
        entry.score >= 4 &&
        (entry.titleMatches > 0 || entry.distinctMatches >= 2),
    )
    .sort((left, right) => right.score - left.score);

  if (scored[0] && (!scored[1] || scored[0].score > scored[1].score)) {
    return scored[0].candidate;
  }
  if (
    params.contextThread &&
    params.contextThread.status === 'active' &&
    params.contextThread.groupFolder === params.groupFolder &&
    (scored.length === 0 ||
      scored.some(
        (entry) =>
          entry.score === scored[0]?.score &&
          entry.candidate.id === params.contextThread?.id,
      ))
  ) {
    return params.contextThread;
  }
  return undefined;
}

const TEMPORAL_TARGET_STOP_WORDS = new Set([
  'actually',
  'another',
  'changed',
  'client',
  'correction',
  'date',
  'deadline',
  'does',
  'due',
  'earlier',
  'gave',
  'later',
  'moved',
  'needs',
  'noon',
  'longer',
  'morning',
  'night',
  'push',
  'scheduled',
  'stayed',
  'that',
  'they',
  'this',
  'time',
  'today',
  'tomorrow',
  'week',
]);

function temporalTargetTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(
          (token) =>
            token.length >= 3 &&
            !/\d/.test(token) &&
            !WEEKDAY_WORDS.has(token) &&
            !TEMPORAL_TARGET_STOP_WORDS.has(token),
        ),
    ),
  ];
}

function temporalTargetClause(value: string): string {
  const clauses = value.split(/\bbut\b|[;.]/i).map((part) => part.trim());
  return (
    clauses.find((part) =>
      /\b(?:deadline|due|moved?|push|reschedul|correction|another week|now)\b/i.test(
        part,
      ),
    ) || value
  );
}

const WEEKDAY_WORDS = new Set([
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]);

function resolveTemporalLifeThread(params: {
  groupFolder: string;
  text: string;
  contextThread?: LifeThread;
}): LifeThread | undefined {
  const activeThreads = listLifeThreadsForGroup(params.groupFolder, ['active']);
  const tokens = temporalTargetTokens(temporalTargetClause(params.text));
  const scored = activeThreads
    .map((candidate) => {
      const titleTokens = new Set(temporalTargetTokens(candidate.title));
      const detailTokens = new Set(
        temporalTargetTokens(
          `${candidate.summary} ${candidate.nextAction || ''} ${candidate.contextTags.join(' ')}`,
        ),
      );
      const titleMatches = tokens.filter((token) => titleTokens.has(token));
      const detailMatches = tokens.filter(
        (token) => detailTokens.has(token) && !titleTokens.has(token),
      );
      return {
        candidate,
        score: titleMatches.length * 5 + detailMatches.length,
        titleMatches: titleMatches.length,
      };
    })
    .filter((entry) => entry.titleMatches > 0 || entry.score >= 2)
    .sort((left, right) => right.score - left.score);

  if (scored[0] && (!scored[1] || scored[0].score > scored[1].score)) {
    return scored[0].candidate;
  }
  if (
    params.contextThread?.status === 'active' &&
    params.contextThread.groupFolder === params.groupFolder &&
    (scored.length === 0 ||
      scored.some(
        (entry) =>
          entry.score === scored[0]?.score &&
          entry.candidate.id === params.contextThread?.id,
      ))
  ) {
    return params.contextThread;
  }
  if (activeThreads.length === 1 && scored.length === 0) {
    return activeThreads[0];
  }
  return undefined;
}

export function resolveLifeThreadTimeZone(groupFolder: string): string {
  const fact = listProfileFactsForGroup(groupFolder, ['accepted']).find(
    (candidate) => candidate.factKey.toLowerCase() === 'timezone',
  );
  if (fact) {
    try {
      const parsed = JSON.parse(fact.valueJson) as unknown;
      if (typeof parsed === 'string')
        return normalizeLifeThreadTimeZone(parsed);
      if (parsed && typeof parsed === 'object') {
        const value = parsed as Record<string, unknown>;
        const configured = value.timezone || value.timeZone || value.value;
        if (typeof configured === 'string') {
          return normalizeLifeThreadTimeZone(configured);
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Invalid profile facts fail safely to the configured host timezone.
    }
  }
  return normalizeLifeThreadTimeZone(process.env.TZ);
}

const lifeThreadTimeZone = resolveLifeThreadTimeZone;

function hashLifeThreadCommandSourceRef(durableIdentity: string): string {
  return `life-thread-source:${crypto
    .createHash('sha256')
    .update(durableIdentity)
    .digest('hex')}`;
}

function stableLifeThreadCommandSourceRef(
  input: LifeThreadCommandInput,
): string | null {
  const durableIdentity =
    input.sourceRef?.trim() ||
    (input.messageId?.trim() ? `message:${input.messageId.trim()}` : null);
  return durableIdentity
    ? hashLifeThreadCommandSourceRef(durableIdentity)
    : null;
}

function lifeThreadCommandSourceRef(
  input: LifeThreadCommandInput,
  now: Date,
): string {
  return (
    stableLifeThreadCommandSourceRef(input) ||
    hashLifeThreadCommandSourceRef(
      `${input.chatJid || input.channel}:${now.toISOString()}:${normalizeText(input.text)}`,
    )
  );
}

function temporalCorrectionSignalId(
  threadId: string,
  text: string,
  activeAt: string,
  priorActiveAt: string,
  sourceRef?: string | null,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(
      sourceRef
        ? `${threadId}\nsource:${sourceRef}`
        : `${threadId}\ntext:${normalizeText(text).toLowerCase()}\ntarget:${activeAt}\nprior:${priorActiveAt}`,
    )
    .digest('hex');
  return `life-thread-temporal:${digest}`;
}

function applyTemporalCorrection(params: {
  thread: LifeThread;
  text: string;
  groupFolder: string;
  chatJid?: string;
  sourceRef?: string | null;
  messageId?: string | null;
  now: Date;
}): {
  status: 'applied' | 'duplicate' | 'stale' | 'not_temporal';
  thread: LifeThread;
} {
  const timeZone = lifeThreadTimeZone(params.groupFolder);
  const inferredCurrent =
    params.thread.nextFollowupAt ||
    parseLifeThreadTemporalState({
      text: params.thread.nextAction || params.thread.summary,
      now: new Date(params.thread.createdAt),
      timeZone,
    })?.activeAt ||
    null;
  const temporal = parseLifeThreadTemporalState({
    text: params.text,
    now: params.now,
    timeZone,
    currentTemporalAt: inferredCurrent,
    requireCorrection: true,
  });
  if (!temporal) return { status: 'not_temporal', thread: params.thread };

  const activeTruth = formatLifeThreadTemporalTruth({
    thread: params.thread,
    temporal,
    timeZone,
  });
  const oldTruth =
    params.thread.nextFollowupAt || inferredCurrent || 'unparsed';
  if (!params.sourceRef && oldTruth === temporal.activeAt) {
    return { status: 'duplicate', thread: params.thread };
  }
  const signalId = temporalCorrectionSignalId(
    params.thread.id,
    params.text,
    temporal.activeAt,
    oldTruth,
    params.sourceRef,
  );
  const current = getLifeThreadCommitment(params.thread);
  const interpretation = buildStructuredLifeThreadCommitmentTransition({
    thread: params.thread,
    text: params.text,
    now: params.now,
    timeZone,
    sourceKind: 'explicit',
    sourceRef: params.sourceRef || params.chatJid || null,
    eventId: signalId,
    kind: 'strengthened',
    reason: `The user corrected the active temporal truth from ${oldTruth} to ${temporal.activeAt}.`,
    evidenceKinds: [
      'direct_language',
      'temporal',
      'correction',
      'state_transition',
    ],
    patch: {
      strength:
        current.strength === 'speculative' || current.strength === 'tentative'
          ? 'intended'
          : current.strength,
      operationalState: 'active',
      readiness:
        temporal.kind === 'scheduled' ? 'actionable_at_time' : 'actionable_now',
      currentAction: activeTruth,
      downstreamAction: null,
      dueAt: temporal.activeAt,
      reactivateAt: null,
      reactivateCondition: null,
    },
  });
  const result = applyLifeThreadCommitmentTransition({
    threadId: params.thread.id,
    groupFolder: params.groupFolder,
    state: interpretation.state,
    transition: interpretation.transition,
    summary: activeTruth,
    signal: {
      id: signalId,
      threadId: params.thread.id,
      groupFolder: params.groupFolder,
      sourceKind: 'explicit',
      summaryText: clipSummary(
        `temporal_supersession: active=${temporal.activeAt}; superseded=${oldTruth}; correction=${normalizeText(params.text)}`,
        600,
      ),
      chatJid: params.chatJid || null,
      messageId: params.messageId || null,
      confidenceKind: 'explicit',
      commitmentTransition: interpretation.transition,
      createdAt: params.now.toISOString(),
    },
  });
  if (result === 'missing') {
    throw new Error('Temporal correction target disappeared before commit.');
  }
  return {
    status: result,
    thread: getLifeThread(params.thread.id) || params.thread,
  };
}

function persistCommitmentInterpretation(params: {
  thread: LifeThread;
  interpretation: CommitmentInterpretation;
  groupFolder: string;
  text: string;
  signalText?: string;
  chatJid?: string;
  sourceKind?: LifeThread['sourceKind'];
  userConfirmed?: boolean;
  messageId?: string | null;
}): {
  status: 'applied' | 'duplicate' | 'stale';
  thread: LifeThread;
} {
  const result = applyLifeThreadCommitmentTransition({
    threadId: params.thread.id,
    groupFolder: params.groupFolder,
    state: params.interpretation.state,
    transition: params.interpretation.transition,
    summary: clipSummary(params.text),
    sourceKind: params.sourceKind || 'explicit',
    confidenceKind: params.interpretation.state.confidenceKind,
    userConfirmed: params.userConfirmed,
    signal: {
      id: params.interpretation.eventId,
      threadId: params.thread.id,
      groupFolder: params.groupFolder,
      sourceKind: params.sourceKind || 'explicit',
      summaryText: clipSummary(params.signalText || params.text, 600),
      chatJid: params.chatJid || null,
      messageId: params.messageId || null,
      confidenceKind: params.interpretation.state.confidenceKind,
      commitmentTransition: params.interpretation.transition,
      createdAt: params.interpretation.state.updatedAt,
    },
  });
  if (result === 'missing') {
    throw new Error('Commitment target disappeared before commit.');
  }
  return {
    status: result,
    thread: getLifeThread(params.thread.id) || params.thread,
  };
}

export function scheduleLifeThreadCommitment(params: {
  threadId: string;
  groupFolder: string;
  dueAt: string;
  now?: Date;
  sourceKind?: LifeThread['sourceKind'];
  reason?: string;
}): LifeThread | null {
  const thread = getLifeThread(params.threadId);
  if (!thread || thread.groupFolder !== params.groupFolder) return null;
  const now = params.now || new Date();
  const current = getLifeThreadCommitment(thread);
  if (
    ['completed', 'cancelled', 'superseded'].includes(current.operationalState)
  ) {
    return thread;
  }
  if (!Number.isFinite(Date.parse(params.dueAt))) {
    throw new Error('Commitment schedule requires a valid timestamp.');
  }
  const sourceKind = params.sourceKind || 'action_layer';
  const interpretation = buildStructuredLifeThreadCommitmentTransition({
    thread,
    text: params.reason || `Schedule follow-through for ${params.dueAt}`,
    now,
    timeZone: lifeThreadTimeZone(thread.groupFolder),
    sourceKind,
    sourceRef: `schedule:${params.dueAt}`,
    kind: 'strengthened',
    reason: params.reason || 'A bounded workflow scheduled follow-through.',
    evidenceKinds: ['temporal', 'state_transition'],
    confidenceKind: current.confidenceKind,
    patch:
      current.operationalState === 'waiting' ||
      current.operationalState === 'blocked' ||
      current.operationalState === 'delegated'
        ? {
            followUp: {
              action:
                current.followUp?.action || `Follow up on ${thread.title}`,
              condition:
                current.followUp?.condition ||
                'the dependency remains unresolved',
              dependencyIds: current.dependencies.map(
                (dependency) => dependency.id,
              ),
              dueAt: params.dueAt,
            },
          }
        : {
            dueAt: params.dueAt,
            readiness: 'actionable_at_time',
          },
  });
  return persistCommitmentInterpretation({
    thread,
    interpretation,
    groupFolder: thread.groupFolder,
    text: params.reason || `Scheduled for ${params.dueAt}`,
    sourceKind,
    userConfirmed: thread.userConfirmed,
  }).thread;
}

export function deferLifeThreadCommitment(params: {
  threadId: string;
  groupFolder: string;
  until?: string | null;
  now?: Date;
  sourceKind?: LifeThread['sourceKind'];
  reason?: string;
}): LifeThread | null {
  const thread = getLifeThread(params.threadId);
  if (!thread || thread.groupFolder !== params.groupFolder) return null;
  const now = params.now || new Date();
  const current = getLifeThreadCommitment(thread);
  if (
    ['completed', 'cancelled', 'superseded'].includes(current.operationalState)
  ) {
    return thread;
  }
  if (params.until && !Number.isFinite(Date.parse(params.until))) {
    throw new Error('Commitment deferral requires a valid timestamp.');
  }
  const sourceKind = params.sourceKind || 'action_layer';
  const interpretation = buildStructuredLifeThreadCommitmentTransition({
    thread,
    text: params.reason || 'Defer this commitment.',
    now,
    timeZone: lifeThreadTimeZone(thread.groupFolder),
    sourceKind,
    sourceRef: `defer:${params.until || now.toISOString()}`,
    kind: 'deferred',
    reason: params.reason || 'A bounded workflow deferred this commitment.',
    evidenceKinds: ['temporal', 'state_transition'],
    confidenceKind: current.confidenceKind,
    patch: {
      operationalState: 'deferred',
      readiness: params.until ? 'actionable_at_time' : 'non_actionable',
      currentAction: null,
      downstreamAction:
        current.downstreamAction || current.currentAction || current.objective,
      reactivateAt: params.until || null,
      reactivateCondition: params.until
        ? 'the deferral time arrives'
        : 'the user explicitly resumes it',
      deferredFrom:
        current.operationalState === 'deferred'
          ? current.deferredFrom || null
          : resumableLifeThreadCommitmentState(current.operationalState),
    },
  });
  return persistCommitmentInterpretation({
    thread,
    interpretation,
    groupFolder: thread.groupFolder,
    text: params.reason || 'Deferred commitment.',
    sourceKind,
    userConfirmed: thread.userConfirmed,
  }).thread;
}

export function completeLifeThreadCommitment(params: {
  threadId: string;
  groupFolder: string;
  now?: Date;
  sourceKind?: LifeThread['sourceKind'];
  reason?: string;
}): LifeThread | null {
  const thread = getLifeThread(params.threadId);
  if (!thread || thread.groupFolder !== params.groupFolder) return null;
  const now = params.now || new Date();
  const current = getLifeThreadCommitment(thread);
  if (
    ['completed', 'cancelled', 'superseded'].includes(current.operationalState)
  ) {
    return thread;
  }
  const sourceKind = params.sourceKind || 'action_layer';
  const interpretation = buildStructuredLifeThreadCommitmentTransition({
    thread,
    text: params.reason || 'Mark this commitment handled.',
    now,
    timeZone: lifeThreadTimeZone(thread.groupFolder),
    sourceKind,
    sourceRef: `complete:${now.toISOString()}`,
    kind: 'completed',
    reason: params.reason || 'A user-confirmed workflow marked this handled.',
    patch: {
      operationalState: 'completed',
      readiness: 'non_actionable',
      currentAction: null,
      downstreamAction: null,
      dueAt: null,
      reactivateAt: null,
      reactivateCondition: null,
      deferredFrom: null,
      dependencies: [],
      dependencyResolution: null,
      followUp: null,
    },
  });
  return persistCommitmentInterpretation({
    thread,
    interpretation,
    groupFolder: thread.groupFolder,
    text: params.reason || 'Commitment handled.',
    sourceKind,
    userConfirmed: true,
  }).thread;
}

export function reactivateLifeThreadCommitment(params: {
  threadId: string;
  groupFolder: string;
  now?: Date;
  reason?: string;
}): LifeThread | null {
  const thread = getLifeThread(params.threadId);
  if (!thread || thread.groupFolder !== params.groupFolder) return null;
  const now = params.now || new Date();
  const current = getLifeThreadCommitment(thread);
  if (current.operationalState !== 'deferred') return null;
  const interpretation = buildStructuredLifeThreadCommitmentTransition({
    thread,
    text: params.reason || 'Resume this commitment.',
    now,
    timeZone: lifeThreadTimeZone(thread.groupFolder),
    sourceKind: 'action_layer',
    sourceRef: `resume:${now.toISOString()}`,
    kind: 'reactivated',
    reason: params.reason || 'The user explicitly resumed this commitment.',
    patch: buildLifeThreadCommitmentReactivationPatch(current),
  });
  return persistCommitmentInterpretation({
    thread,
    interpretation,
    groupFolder: thread.groupFolder,
    text: params.reason || 'Commitment resumed.',
    sourceKind: 'action_layer',
    userConfirmed: true,
  }).thread;
}

function resolveCommitmentMutationTarget(params: {
  groupFolder: string;
  text: string;
  contextThread?: LifeThread;
}): { thread: LifeThread | null; ambiguous: boolean } {
  const candidates = listLifeThreadsForGroup(params.groupFolder, [
    'active',
    'paused',
  ]);
  const tokens = terminalTargetTokens(params.text);
  const scored = candidates
    .map((candidate) => {
      const titleTokens = new Set(terminalTargetTokens(candidate.title));
      const detailTokens = new Set(
        terminalTargetTokens(
          `${candidate.summary} ${candidate.nextAction || ''} ${getLifeThreadCommitment(candidate).objective}`,
        ),
      );
      const titleMatches = tokens.filter((token) => titleTokens.has(token));
      const detailMatches = tokens.filter(
        (token) => detailTokens.has(token) && !titleTokens.has(token),
      );
      return {
        candidate,
        score: titleMatches.length * 5 + detailMatches.length,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.id.localeCompare(right.candidate.id),
    );
  if (scored[0] && (!scored[1] || scored[0].score > scored[1].score)) {
    return { thread: scored[0].candidate, ambiguous: false };
  }
  if (
    params.contextThread &&
    params.contextThread.groupFolder === params.groupFolder &&
    ['active', 'paused'].includes(params.contextThread.status) &&
    (scored.length === 0 ||
      scored.some(
        (entry) =>
          entry.score === scored[0]?.score &&
          entry.candidate.id === params.contextThread?.id,
      ))
  ) {
    return { thread: params.contextThread, ambiguous: false };
  }
  if (scored.length > 1 && scored[0]?.score === scored[1]?.score) {
    return { thread: null, ambiguous: true };
  }
  if (
    candidates.length === 1 &&
    /\b(?:it|that|this|they|them)\b/i.test(params.text)
  ) {
    return { thread: candidates[0]!, ambiguous: false };
  }
  return { thread: null, ambiguous: false };
}

function deriveCommitmentTitle(text: string): string {
  const personAction = text.match(
    /\b(call|email|send|submit|finish|book|schedule|pay|review|contact)\s+([A-Z][a-z'-]+|the\s+[a-z][a-z -]{2,30})/,
  );
  if (personAction) {
    return humanizeThreadTitle(`${personAction[1]} ${personAction[2]}`);
  }
  const derived = deriveTitleFromSummary(text);
  if (derived !== 'Follow-up') return derived;
  return humanizeThreadTitle(
    text
      .replace(
        /^(?:actually,?\s*)?(?:i|we)\s+(?:might|may|will|'ll|am|are|need to|plan to|intend to|was going to)\s+/i,
        '',
      )
      .split(/\b(?:by|on|at|tomorrow|today|this|next)\b/i)[0]
      .split(/\s+/)
      .slice(0, 6)
      .join(' '),
  );
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
  sourceRef?: string;
  messageId?: string | null;
  reuseMode?: 'title' | 'semantic' | 'source';
  now: Date;
}): LifeThread {
  const title = redactLifeThreadCommitmentText(
    humanizeThreadTitle(redactLifeThreadCommitmentText(params.title)),
  );
  const summary = clipSummary(redactLifeThreadCommitmentText(params.summary));
  const nextAction = params.nextAction
    ? clipSummary(redactLifeThreadCommitmentText(params.nextAction), 360)
    : null;
  const sourceKind = params.sourceKind || 'explicit';
  const nowIso = params.now.toISOString();
  const timeZone = lifeThreadTimeZone(params.groupFolder);
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
  const titleMatches = listLifeThreadsForGroup(params.groupFolder).filter(
    (thread) => normalizeTitleKey(thread.title) === normalizeTitleKey(title),
  );
  const reminderTaskId = params.sourceRef?.startsWith('reminder:')
    ? params.sourceRef.slice('reminder:'.length)
    : null;
  const sourceMatch = params.sourceRef
    ? listLifeThreadsForGroup(params.groupFolder).find((thread) =>
        reminderTaskId && thread.linkedTaskId === reminderTaskId
          ? true
          : getLifeThreadCommitment(thread).evidence.some(
              (item) =>
                item.sourceRef ===
                buildOpaqueLifeThreadCommitmentSourceRef(params.sourceRef!),
            ),
      )
    : undefined;
  const reuseMode = params.reuseMode || 'title';
  const existing =
    sourceMatch ||
    (reuseMode === 'title'
      ? titleMatches[0]
      : reuseMode === 'semantic'
        ? findSemanticallyEquivalentThread(params.groupFolder, title, summary)
        : undefined);
  if (existing && isLifeThreadTemporalCorrection(summary)) {
    const correction = applyTemporalCorrection({
      thread: existing,
      text: summary,
      groupFolder: params.groupFolder,
      chatJid: params.chatJid,
      sourceRef: params.sourceRef,
      messageId: params.messageId,
      now: params.now,
    });
    if (correction.status !== 'not_temporal') return correction.thread;
  }
  const threadId = existing?.id || crypto.randomUUID();
  const sourceRef =
    params.sourceRef || `${params.chatJid || params.channel}:${nowIso}`;
  let interpretation = interpretLifeThreadCommitment({
    threadId,
    title,
    text: summary,
    now: params.now,
    timeZone,
    sourceKind,
    sourceRef,
    current: existing ? getLifeThreadCommitment(existing) : null,
    knownSubjects: listProfileSubjectsForGroup(params.groupFolder),
    explicitRequest: sourceKind === 'reminder',
    fallbackStrength: !existing ? 'intended' : undefined,
  });

  if (
    existing &&
    ['completed', 'cancelled', 'superseded'].includes(
      getLifeThreadCommitment(existing).operationalState,
    ) &&
    interpretation &&
    !/\b(?:reopen|restart|take (?:it|this|that) back|do (?:it|this|that) after all)\b/i.test(
      summary,
    )
  ) {
    interpretation = null;
  }

  if (!existing) {
    if (!interpretation) {
      throw new Error('New life thread lacks a canonical commitment origin.');
    }
    const record: LifeThread & {
      commitment: NonNullable<LifeThread['commitment']>;
    } = {
      id: threadId,
      groupFolder: params.groupFolder,
      title,
      category: inferred.category,
      status: 'active',
      scope: inferred.scope,
      relatedSubjectIds,
      contextTags: inferred.contextTags,
      summary,
      nextAction,
      nextFollowupAt: params.nextFollowupAt ?? null,
      sourceKind,
      confidenceKind: interpretation.state.confidenceKind,
      commitment: interpretation.state,
      userConfirmed: true,
      sensitivity: inferred.sensitivity,
      surfaceMode: 'default',
      followthroughMode: 'important_only',
      lastSurfacedAt: null,
      snoozedUntil: null,
      linkedTaskId: null,
      mergedIntoThreadId: null,
      createdAt: nowIso,
      lastUpdatedAt: nowIso,
      lastUsedAt: nowIso,
    };
    createLifeThreadWithInitialCommitment({
      thread: record,
      signal: {
        id: interpretation.eventId,
        threadId,
        groupFolder: params.groupFolder,
        sourceKind,
        summaryText: summary,
        chatJid: params.chatJid || null,
        messageId: params.messageId || null,
        confidenceKind: interpretation.state.confidenceKind,
        commitmentTransition: interpretation.transition,
        createdAt: nowIso,
      },
    });
    return getLifeThread(threadId) || record;
  }

  if (interpretation) {
    const result = applyLifeThreadCommitmentTransition({
      threadId,
      groupFolder: params.groupFolder,
      state: interpretation.state,
      transition: interpretation.transition,
      summary,
      sourceKind,
      confidenceKind: interpretation.state.confidenceKind,
      userConfirmed: true,
      signal: {
        id: interpretation.eventId,
        threadId,
        groupFolder: params.groupFolder,
        sourceKind,
        summaryText: summary,
        chatJid: params.chatJid || null,
        messageId: params.messageId || null,
        confidenceKind: interpretation.state.confidenceKind,
        commitmentTransition: interpretation.transition,
        createdAt: nowIso,
      },
    });
    if (result === 'missing') {
      throw new Error('Commitment target disappeared before commit.');
    }
    if (result === 'duplicate' || result === 'stale') {
      return getLifeThread(threadId) || existing;
    }
  } else {
    upsertLifeThreadSignal({
      id: crypto.randomUUID(),
      threadId,
      groupFolder: params.groupFolder,
      sourceKind,
      summaryText: summary,
      chatJid: params.chatJid || null,
      messageId: params.messageId || null,
      confidenceKind: 'explicit',
      createdAt: nowIso,
    });
  }

  const current = getLifeThread(threadId) || existing;
  upsertLifeThread({
    ...current,
    title,
    // Existing rows can predate commitment-safe ingestion. Preserve their
    // meaning while removing any credential-like value before they are ever
    // returned by a current command again.
    summary: clipSummary(redactLifeThreadCommitmentText(current.summary)),
    category: inferred.category,
    scope: inferred.scope,
    relatedSubjectIds:
      relatedSubjectIds.length > 0
        ? relatedSubjectIds
        : current.relatedSubjectIds,
    contextTags: [
      ...new Set([...current.contextTags, ...inferred.contextTags]),
    ],
    sensitivity: inferred.sensitivity,
    lastUpdatedAt: nowIso,
    lastUsedAt: nowIso,
  });
  return getLifeThread(threadId) || current;
}

export function syncLifeThreadFromReminderTask(params: {
  taskId: string;
  groupFolder: string;
  chatJid?: string | null;
  prompt: string;
  nextRun?: string | null;
  now?: Date;
}): LifeThread {
  const now = params.now || new Date();
  const prompt = clipSummary(params.prompt, 280);
  const thread = upsertExplicitLifeThread({
    groupFolder: params.groupFolder,
    title: deriveCommitmentTitle(prompt),
    summary: `Remind me to ${prompt}`,
    channel: 'telegram',
    sourceKind: 'reminder',
    chatJid: params.chatJid || undefined,
    sourceRef: `reminder:${params.taskId}`,
    reuseMode: 'source',
    now,
  });
  const scheduled = params.nextRun
    ? scheduleLifeThreadCommitment({
        threadId: thread.id,
        groupFolder: params.groupFolder,
        dueAt: params.nextRun,
        now,
        sourceKind: 'reminder',
        reason: `Reminder ${params.taskId} is scheduled.`,
      }) || thread
    : thread;
  updateLifeThread(scheduled.id, {
    linkedTaskId: params.taskId,
    lastUpdatedAt: scheduled.lastUpdatedAt,
  });
  return getLifeThread(scheduled.id) || scheduled;
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
  if (
    findThreadByTitle(input.groupFolder, inferredTitle, ['active', 'paused'])
  ) {
    return null;
  }

  const topicMatcher = new RegExp(
    `\\b${inferredTitle
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')}\\b`,
    'i',
  );
  const messages = listRecentMessagesForChat(input.chatJid, 20).filter(
    (message) => topicMatcher.test(message.content),
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
    expiresAt: new Date(
      now.getTime() + PENDING_THREAD_SUGGESTION_TTL_MS,
    ).toISOString(),
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
  const nowMs = now.getTime();
  for (const deferred of listLifeThreadsForGroup(params.groupFolder, [
    'paused',
  ])) {
    const matured = buildMatureDeferredCommitment({
      thread: deferred,
      now,
      sourceKind: 'daily_companion',
    });
    if (matured) {
      persistCommitmentInterpretation({
        thread: deferred,
        interpretation: matured,
        groupFolder: params.groupFolder,
        text: 'The saved deferral horizon elapsed.',
        sourceKind: 'daily_companion',
        userConfirmed: deferred.userConfirmed,
      });
    }
  }
  const activeThreads = listLifeThreadsForGroup(params.groupFolder, ['active'])
    .map((thread) => projectEffectiveLifeThread(thread, now))
    .filter((thread) => {
      if (thread.surfaceMode === 'manual_only') return false;
      if (
        thread.followthroughMode === 'off' ||
        thread.followthroughMode === 'manual_only'
      ) {
        return false;
      }
      if (thread.snoozedUntil) {
        const snoozedMs = Date.parse(thread.snoozedUntil);
        if (Number.isFinite(snoozedMs) && snoozedMs > nowMs) {
          return false;
        }
      }
      return true;
    })
    .sort((left, right) =>
      compareLifeThreadCommitmentPriority(left, right, now),
    );

  const automaticThreads = activeThreads.filter(
    (thread) =>
      isAutomaticSurfaceWorthyLifeThread(thread) &&
      shouldProactivelySurfaceCommitment(thread, now),
  );

  const dueFollowups = automaticThreads.filter((thread) => {
    if (!thread.nextFollowupAt) return false;
    const followupMs = Date.parse(thread.nextFollowupAt);
    return (
      Number.isFinite(followupMs) &&
      followupMs <= now.getTime() + 24 * 60 * 60 * 1000
    );
  });

  const slippingThreads = automaticThreads.filter((thread) => {
    if (!thread.nextFollowupAt) return false;
    const followupMs = Date.parse(thread.nextFollowupAt);
    return Number.isFinite(followupMs) && followupMs < nowMs;
  });

  const householdCarryover =
    automaticThreads.find(
      (thread) =>
        ['household', 'family', 'mixed'].includes(thread.scope) ||
        thread.category === 'relationship' ||
        thread.contextTags.some((tag) =>
          ['candace', 'family', 'household', 'home'].includes(
            normalizeTitleKey(tag),
          ),
        ),
    ) || null;

  const recommendedNextThread =
    dueFollowups.find((thread) => {
      if (!params.selectedWorkTitle) return true;
      return (
        normalizeTitleKey(thread.title) !==
        normalizeTitleKey(params.selectedWorkTitle)
      );
    }) ||
    automaticThreads.find((thread) => {
      if (!thread.nextAction && !thread.summary) return false;
      if (!params.selectedWorkTitle) return true;
      return (
        normalizeTitleKey(thread.title) !==
        normalizeTitleKey(params.selectedWorkTitle)
      );
    }) ||
    null;

  return {
    activeThreads,
    dueFollowups,
    slippingThreads,
    householdCarryover,
    recommendedNextThread,
  };
}

function buildThreadDetailReply(
  channel: LifeThreadCommandChannel,
  thread: LifeThread,
  now: Date,
): string {
  const signals = listLifeThreadSignals(thread.id, 3);
  const detailLines = [
    `Summary: ${thread.summary}`,
    `Commitment: ${describeLifeThreadCommitment(
      thread,
      now,
      lifeThreadTimeZone(thread.groupFolder),
    )}`,
    thread.nextFollowupAt
      ? `Next follow-up: ${new Date(thread.nextFollowupAt).toLocaleString(
          'en-US',
          {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          },
        )}`
      : null,
    signals[0] ? `Latest signal: ${signals[0].summaryText}` : null,
  ].filter((line): line is string => Boolean(line));

  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: formatThreadReference(thread, now),
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
  now: Date,
): string {
  const latestSignals = listLifeThreadSignals(thread.id, 2);
  const reason = describeLifeThreadCommitment(
    thread,
    now,
    lifeThreadTimeZone(thread.groupFolder),
  );
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
  return [
    'Thread context in play:',
    ...details.map((detail) => `- ${detail}`),
  ].join('\n');
}

function buildSaveConfirmation(
  channel: LifeThreadCommandChannel,
  thread: LifeThread,
  summary: string,
): string {
  const safeSummary = redactLifeThreadCommitmentText(summary);
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: `Okay. I saved that under ${thread.title}.`,
      details: [safeSummary],
      maxDetails: 1,
    });
  }
  return `Okay. I saved that under the ${thread.title} thread.\n- ${safeSummary}`;
}

function normalizeLifeThreadSummaryLine(value: string): string {
  return normalizeText(value)
    .replace(/^[*-]\s*/, '')
    .replace(/^(?:still open|still in view):\s*/i, '')
    .replace(/^summary:\s*/i, '')
    .replace(/^save (?:that|it|this)(?: for later)?[:,-]?\s*/i, '')
    .replace(
      /^keep track of (?:that|it|this)(?: for (?:later|tonight))?[:,-]?\s*/i,
      '',
    )
    .trim();
}

function extractLifeThreadSummaryCandidate(value: string | undefined): string {
  if (!value) return '';
  const lines = value
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  for (const line of lines) {
    if (/^draft:/i.test(line)) {
      break;
    }
    if (
      /^(?:next|why this came up|keep in mind|follow-up|urgency):/i.test(line)
    ) {
      continue;
    }
    const normalized = normalizeLifeThreadSummaryLine(line);
    if (normalized) {
      return clipSummary(normalized);
    }
  }
  return '';
}

function getSummarySource(input: LifeThreadCommandInput): string {
  return (
    extractLifeThreadSummaryCandidate(input.replyText) ||
    extractLifeThreadSummaryCandidate(input.conversationSummary) ||
    extractLifeThreadSummaryCandidate(input.priorContext?.summaryText) ||
    extractLifeThreadSummaryCandidate(input.text)
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
    sourceRef: lifeThreadCommandSourceRef(input, input.now || new Date()),
    messageId: input.messageId,
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

  if (
    /^(what threads do i have open|what('?s| is) active right now)\b/i.test(
      normalized,
    )
  ) {
    const threads = listLifeThreadsForGroup(input.groupFolder, ['active']);
    return {
      handled: true,
      responseText:
        input.channel === 'alexa'
          ? formatThreadListAlexa(threads, now)
          : formatThreadListTelegram(threads, now),
      referencedThread: threads[0] || null,
    };
  }

  const stillOpenMatch = raw.match(
    /^what('?s| is) still open with ([a-z][a-z' /-]+)\??$/i,
  );
  if (stillOpenMatch) {
    const thread = findThreadByPersonName(input.groupFolder, stillOpenMatch[2]);
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread, now)
        : `I do not have an active ${stillOpenMatch[2]} thread yet.`,
      referencedThread: thread || null,
    };
  }

  if (
    /^is there anything i still need to handle for (the )?(house|home)\??$/i.test(
      normalized,
    )
  ) {
    const thread =
      findThreadByTitle(input.groupFolder, 'Household', ['active']) ||
      listLifeThreadsForGroup(input.groupFolder, ['active']).find(
        (candidate) =>
          candidate.scope === 'household' || candidate.category === 'household',
      );
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread, now)
        : 'I do not have an active house thread right now.',
      referencedThread: thread || null,
    };
  }

  const mergeMatch = raw.match(
    /^merge (?:the )?(.+?) thread into (?:the )?(.+?) thread$/i,
  );
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
    const supersession = buildStructuredLifeThreadCommitmentTransition({
      thread: fromThread,
      text: raw,
      now,
      timeZone: lifeThreadTimeZone(input.groupFolder),
      sourceKind: 'explicit',
      sourceRef: lifeThreadCommandSourceRef(input, now),
      kind: 'superseded',
      reason: `The user merged this commitment into ${toThread.title}.`,
      patch: {
        operationalState: 'superseded',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
    const mergeResult = mergeLifeThreadsAtomically({
      fromThreadId: fromThread.id,
      toThreadId: toThread.id,
      groupFolder: input.groupFolder,
      state: supersession.state,
      transition: supersession.transition,
      summary: raw,
      now: now.toISOString(),
      signal: {
        id: supersession.eventId,
        threadId: fromThread.id,
        groupFolder: input.groupFolder,
        sourceKind: 'explicit',
        summaryText: raw,
        chatJid: input.chatJid || null,
        messageId: input.messageId || null,
        confidenceKind: supersession.state.confidenceKind,
        commitmentTransition: supersession.transition,
        createdAt: supersession.state.updatedAt,
      },
    });
    if (mergeResult === 'missing') {
      throw new Error('Life-thread merge target disappeared before commit.');
    }
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

  if (isLifeThreadCommitmentLanguage(raw)) {
    const standalone = interpretLifeThreadCommitment({
      threadId: 'unpersisted-classification',
      title: deriveCommitmentTitle(raw),
      text: raw,
      now,
      timeZone: lifeThreadTimeZone(input.groupFolder),
      sourceKind: 'explicit',
      sourceRef: 'classification-only',
      knownSubjects: listProfileSubjectsForGroup(input.groupFolder),
    });
    const referential =
      /\b(?:it|that|this|they|them)\b/i.test(raw) &&
      !/^this is (?:critical|important|high priority)\b/i.test(raw);
    const initialExact =
      standalone?.kind === 'initial'
        ? findSemanticallyEquivalentThread(
            input.groupFolder,
            deriveCommitmentTitle(raw),
            raw,
            ['active', 'paused'],
          ) || null
        : null;
    const target =
      standalone?.kind === 'initial'
        ? {
            thread: initialExact || (referential ? thread || null : null),
            ambiguous: false,
          }
        : resolveCommitmentMutationTarget({
            groupFolder: input.groupFolder,
            text: raw,
            contextThread: thread,
          });
    if (target.ambiguous) {
      return {
        handled: true,
        responseText:
          'I found more than one open commitment that could match that. Which one do you mean?',
        referencedThread: null,
      };
    }
    if (target.thread) {
      const interpretation = interpretLifeThreadCommitment({
        threadId: target.thread.id,
        title: target.thread.title,
        text: raw,
        now,
        timeZone: lifeThreadTimeZone(input.groupFolder),
        sourceKind: 'explicit',
        sourceRef: lifeThreadCommandSourceRef(input, now),
        current: getLifeThreadCommitment(target.thread),
        knownSubjects: listProfileSubjectsForGroup(input.groupFolder),
      });
      if (interpretation) {
        const persisted = persistCommitmentInterpretation({
          thread: target.thread,
          interpretation,
          groupFolder: input.groupFolder,
          text: raw,
          signalText:
            interpretation.kind === 'completed' ||
            interpretation.kind === 'cancelled'
              ? `${interpretation.kind}: ${raw}`
              : raw,
          chatJid: input.chatJid,
          messageId: input.messageId,
        });
        if (input.chatJid) {
          setLastReferencedLifeThread(input.chatJid, persisted.thread, now);
        }
        return {
          handled: true,
          responseText:
            persisted.status === 'duplicate'
              ? `That commitment update is already recorded for ${persisted.thread.title}.`
              : persisted.status === 'stale'
                ? `I kept the newer state for ${persisted.thread.title}; that older update was retained only as history.`
                : `${persisted.thread.title}: ${describeLifeThreadCommitment(
                    persisted.thread,
                    now,
                    lifeThreadTimeZone(input.groupFolder),
                  )}`,
          referencedThread: persisted.thread,
        };
      }
    } else if (
      !inferLifeThreadTerminalOutcome(raw) ||
      /\b(?:waiting|hear back|response|reply|follow up|check back|ball is in)\b/i.test(
        raw,
      )
    ) {
      if (
        /\b(?:it|that|this|they|them)\b/i.test(raw) &&
        !/^this is (?:critical|important|high priority)\b/i.test(raw) &&
        listLifeThreadsForGroup(input.groupFolder, ['active', 'paused'])
          .length > 1
      ) {
        return {
          handled: true,
          responseText:
            'I cannot safely tell which commitment that refers to. Which one do you mean?',
          referencedThread: null,
        };
      }
      const saved = upsertExplicitLifeThread({
        groupFolder: input.groupFolder,
        title: deriveCommitmentTitle(raw),
        summary: raw,
        channel: input.channel,
        sourceKind: 'explicit',
        reuseMode: 'semantic',
        chatJid: input.chatJid,
        sourceRef: lifeThreadCommandSourceRef(input, now),
        messageId: input.messageId,
        now,
      });
      if (input.chatJid) {
        setLastReferencedLifeThread(input.chatJid, saved, now);
      }
      return {
        handled: true,
        responseText: `Okay. I saved the ${saved.title} thread. ${describeLifeThreadCommitment(
          saved,
          now,
          lifeThreadTimeZone(input.groupFolder),
        )}`,
        referencedThread: saved,
      };
    }
  }

  const terminalOutcome = inferLifeThreadTerminalOutcome(raw);
  if (terminalOutcome) {
    const terminalThread = resolveTerminalLifeThread({
      groupFolder: input.groupFolder,
      text: raw,
      contextThread: thread,
    });
    if (!terminalThread) return { handled: false };
    const interpretation = buildStructuredLifeThreadCommitmentTransition({
      thread: terminalThread,
      text: raw,
      now,
      timeZone: lifeThreadTimeZone(input.groupFolder),
      sourceKind: 'explicit',
      sourceRef: lifeThreadCommandSourceRef(input, now),
      kind: terminalOutcome,
      reason: `The user explicitly marked this commitment ${terminalOutcome}.`,
      evidenceKinds: [
        'direct_language',
        ...(terminalOutcome === 'cancelled' ? (['negation'] as const) : []),
        'state_transition',
      ],
      patch: {
        operationalState: terminalOutcome,
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
    const updated = persistCommitmentInterpretation({
      thread: terminalThread,
      interpretation,
      groupFolder: input.groupFolder,
      text: `${terminalOutcome}: ${clipSummary(raw)}`,
      chatJid: input.chatJid,
      messageId: input.messageId,
    }).thread;
    return {
      handled: true,
      responseText:
        terminalOutcome === 'completed'
          ? `Okay. I marked ${terminalThread.title} done and removed it from active follow-through.`
          : `Okay. I marked ${terminalThread.title} cancelled and removed it from active follow-through.`,
      referencedThread: updated,
    };
  }

  if (isLifeThreadTemporalCorrection(raw)) {
    const target = resolveTemporalLifeThread({
      groupFolder: input.groupFolder,
      text: raw,
      contextThread: thread,
    });
    if (!target) {
      const activeThreads = listLifeThreadsForGroup(input.groupFolder, [
        'active',
      ]);
      if (activeThreads.length > 1) {
        return {
          handled: true,
          responseText:
            'I found more than one active obligation that could match that correction. Which one should I update?',
          referencedThread: null,
          temporalResolution: 'ambiguous',
        };
      }
      return { handled: false };
    }
    const correction = applyTemporalCorrection({
      thread: target,
      text: raw,
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      messageId: input.messageId,
      sourceRef: stableLifeThreadCommandSourceRef(input),
      now,
    });
    if (correction.status !== 'not_temporal') {
      if (input.chatJid) {
        setLastReferencedLifeThread(input.chatJid, correction.thread, now);
      }
      return {
        handled: true,
        responseText:
          correction.status === 'duplicate'
            ? `That correction is already recorded for ${target.title}.`
            : `Okay. I updated ${target.title}: ${correction.thread.nextAction}`,
        referencedThread: correction.thread,
        temporalResolution: correction.status,
      };
    }
  }

  const renameMatch = raw.match(/^rename (?:that|this|the)? ?thread to (.+)$/i);
  if (renameMatch) {
    if (!thread) {
      return {
        handled: true,
        responseText: 'I need the thread first before I can rename it.',
      };
    }
    const nextTitle = clipSummary(
      redactLifeThreadCommitmentText(renameMatch[1]),
      60,
    );
    updateLifeThread(thread.id, {
      title: nextTitle,
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I renamed that thread to ${nextTitle}.`,
      referencedThread: getLifeThread(thread.id) || {
        ...thread,
        title: nextTitle,
      },
    };
  }

  if (
    /^(close that thread|close that|archive that thread|archive that)\b/i.test(
      normalized,
    )
  ) {
    if (!thread) {
      return {
        handled: true,
        responseText: 'I need the thread first before I can close it.',
      };
    }
    const nextStatus = normalized.includes('archive') ? 'archived' : 'closed';
    const lifecycle = buildStructuredLifeThreadCommitmentTransition({
      thread,
      text: raw,
      now,
      timeZone: lifeThreadTimeZone(input.groupFolder),
      sourceKind: 'explicit',
      sourceRef: lifeThreadCommandSourceRef(input, now),
      kind: nextStatus === 'archived' ? 'superseded' : 'completed',
      reason:
        nextStatus === 'archived'
          ? 'The user archived this commitment.'
          : 'The user closed this commitment.',
      patch: {
        operationalState:
          nextStatus === 'archived' ? 'superseded' : 'completed',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction: null,
        dueAt: null,
        reactivateAt: null,
        reactivateCondition: null,
        deferredFrom: null,
        dependencies: [],
        dependencyResolution: null,
        followUp: null,
      },
    });
    const closed = persistCommitmentInterpretation({
      thread,
      interpretation: lifecycle,
      groupFolder: input.groupFolder,
      text: raw,
      chatJid: input.chatJid,
      messageId: input.messageId,
    }).thread;
    return {
      handled: true,
      responseText: `Okay. ${thread.title} is ${nextStatus}.`,
      referencedThread: closed,
    };
  }

  if (/^(pause that thread|pause that)\b/i.test(normalized)) {
    if (!thread) {
      return {
        handled: true,
        responseText: 'I need the thread first before I can pause it.',
      };
    }
    const currentCommitment = getLifeThreadCommitment(thread);
    const pause = buildStructuredLifeThreadCommitmentTransition({
      thread,
      text: raw,
      now,
      timeZone: lifeThreadTimeZone(input.groupFolder),
      sourceKind: 'explicit',
      sourceRef: lifeThreadCommandSourceRef(input, now),
      kind: 'deferred',
      reason: 'The user paused this commitment until an explicit resume.',
      patch: {
        operationalState: 'deferred',
        readiness: 'non_actionable',
        currentAction: null,
        downstreamAction:
          currentCommitment.downstreamAction ||
          currentCommitment.currentAction ||
          null,
        reactivateAt: null,
        reactivateCondition: 'the user resumes this commitment',
        deferredFrom:
          currentCommitment.operationalState === 'deferred'
            ? currentCommitment.deferredFrom || null
            : resumableLifeThreadCommitmentState(
                currentCommitment.operationalState,
              ),
      },
    });
    const paused = persistCommitmentInterpretation({
      thread,
      interpretation: pause,
      groupFolder: input.groupFolder,
      text: raw,
      chatJid: input.chatJid,
    }).thread;
    return {
      handled: true,
      responseText: `Okay. I paused ${thread.title}.`,
      referencedThread: paused,
    };
  }

  if (
    /^(forget that thread|forget that|delete that thread)\b/i.test(normalized)
  ) {
    if (!thread) {
      return {
        handled: true,
        responseText: 'I need the thread first before I can delete it.',
      };
    }
    deleteLifeThread(thread.id);
    return {
      handled: true,
      responseText: `Okay. I forgot the ${thread.title} thread and its saved signals.`,
      referencedThread: null,
    };
  }

  if (
    /^(what thread are you using here|what thread are you using there)\b/i.test(
      normalized,
    )
  ) {
    return {
      handled: true,
      responseText: buildThreadExplainabilityReply(
        input.channel,
        input.priorContext,
      ),
      referencedThread: thread || null,
    };
  }

  if (
    /^(what('?s| is) in that thread|what do you know about this thread)\b/i.test(
      normalized,
    )
  ) {
    return {
      handled: true,
      responseText: thread
        ? buildThreadDetailReply(input.channel, thread, now)
        : 'I do not have a single thread in context for that yet.',
      referencedThread: thread || null,
    };
  }

  if (/^(why do you think this is still open)\b/i.test(normalized)) {
    return {
      handled: true,
      responseText: thread
        ? buildWhyStillOpenReply(input.channel, thread, now)
        : 'I am not holding onto a specific thread strongly enough for that.',
      referencedThread: thread || null,
    };
  }

  if (
    /^(stop using thread context for this|don'?t bring this up automatically)\b/i.test(
      normalized,
    )
  ) {
    if (!thread) {
      return {
        handled: true,
        responseText: 'I need the thread first before I can quiet it down.',
      };
    }
    updateLifeThread(thread.id, {
      surfaceMode: 'manual_only',
      followthroughMode: 'manual_only',
      lastUpdatedAt: now.toISOString(),
      lastUsedAt: now.toISOString(),
    });
    return {
      handled: true,
      responseText: `Okay. I will stop bringing up ${thread.title} automatically.`,
      referencedThread: getLifeThread(thread.id) || thread,
    };
  }

  if (
    /^(what follow-?ups am i carrying right now|show me my carryover threads|what('?s| is) still open right now)\b/i.test(
      normalized,
    )
  ) {
    const snapshot = buildLifeThreadSnapshot({
      groupFolder: input.groupFolder,
      now,
    });
    const threads = snapshot.dueFollowups.length
      ? snapshot.dueFollowups
      : snapshot.activeThreads;
    return {
      handled: true,
      responseText:
        input.channel === 'alexa'
          ? formatThreadListAlexa(threads.slice(0, 3), now)
          : [
              'Follow-through right now:',
              ...threads
                .slice(0, 5)
                .map(
                  (candidate) => `- ${formatThreadSummaryLine(candidate, now)}`,
                ),
            ].join('\n'),
      referencedThread: threads[0] || null,
    };
  }

  if (/^what have i been putting off\b/i.test(normalized)) {
    const snapshot = buildLifeThreadSnapshot({
      groupFolder: input.groupFolder,
      now,
    });
    const threads = snapshot.slippingThreads.length
      ? snapshot.slippingThreads
      : snapshot.dueFollowups;
    return {
      handled: true,
      responseText:
        threads.length === 0
          ? 'Nothing is standing out as a neglected follow-up right now.'
          : input.channel === 'alexa'
            ? buildVoiceReply({
                summary: `The thing most likely to be slipping is ${threads[0]!.title}.`,
                details: [threads[0]!.nextAction || threads[0]!.summary],
                maxDetails: 1,
              })
            : [
                'The follow-through items most likely to be slipping:',
                ...threads
                  .slice(0, 4)
                  .map(
                    (candidate) =>
                      `- ${formatThreadSummaryLine(candidate, now)}`,
                  ),
              ].join('\n'),
      referencedThread: threads[0] || null,
    };
  }

  const saveUnderMatch = raw.match(
    /^(?:save|track|keep track of)(?: this| that)? (?:under|to|in) (?:the )?(.+?) thread\b/i,
  );
  if (saveUnderMatch) {
    const title = clipSummary(saveUnderMatch[1], 60);
    const summary = getSummarySource(input);
    if (!summary) {
      return {
        handled: true,
        responseText: 'Tell me what you want saved first.',
      };
    }
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title,
      summary,
      channel: input.channel,
      sourceKind: 'explicit',
      chatJid: input.chatJid,
      sourceRef: lifeThreadCommandSourceRef(input, now),
      messageId: input.messageId,
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
    const summaryBase = /^this$/i.test(capturedSummary)
      ? getSummarySource(input)
      : clipSummary(capturedSummary);
    if (!summaryBase) {
      return {
        handled: true,
        responseText: 'Tell me what you want saved first.',
      };
    }
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title: personName,
      summary: summaryBase,
      channel: input.channel,
      sourceKind: 'explicit',
      nextAction: `Talk to ${personName} about ${summaryBase}`,
      chatJid: input.chatJid,
      sourceRef: lifeThreadCommandSourceRef(input, now),
      messageId: input.messageId,
      now,
    });
    return {
      handled: true,
      responseText: `Okay. I will keep that in the ${savedThread.title} thread.`,
      referencedThread: savedThread,
    };
  }

  if (
    /^(keep track of this for later|save this for later|keep track of this|save this)\b/i.test(
      normalized,
    )
  ) {
    const summary = getSummarySource(input);
    if (!summary) {
      return {
        handled: true,
        responseText: 'Tell me what you want saved first.',
      };
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
      sourceRef: lifeThreadCommandSourceRef(input, now),
      messageId: input.messageId,
      now,
    });
    return {
      handled: true,
      responseText: buildSaveConfirmation(input.channel, savedThread, summary),
      referencedThread: savedThread,
    };
  }

  const remindTalkMatch = raw.match(
    /^remind me to talk to ([a-z][a-z' -]+) about (this|.+?)(?: (tonight|tomorrow|before i leave))?[.!?]*$/i,
  );
  if (remindTalkMatch) {
    const personName = clipSummary(remindTalkMatch[1], 40);
    const summaryBase = /^this$/i.test(remindTalkMatch[2] || '')
      ? getSummarySource(input)
      : clipSummary(remindTalkMatch[2] || '');
    if (!summaryBase) {
      return {
        handled: true,
        responseText: 'Tell me what you want carried first.',
      };
    }
    const followupAt = inferFollowupAnchor(remindTalkMatch[3] || raw, now);
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title: personName,
      summary: summaryBase,
      channel: input.channel,
      sourceKind: 'reminder',
      nextAction: `Talk to ${personName} about ${summaryBase}`,
      nextFollowupAt: followupAt,
      chatJid: input.chatJid,
      sourceRef: lifeThreadCommandSourceRef(input, now),
      messageId: input.messageId,
      now,
    });
    const scheduledThread = followupAt
      ? scheduleLifeThreadCommitment({
          threadId: savedThread.id,
          groupFolder: input.groupFolder,
          dueAt: followupAt,
          now,
          sourceKind: 'reminder',
          reason: `The user requested follow-through for ${savedThread.title}.`,
        }) || savedThread
      : savedThread;
    return {
      handled: true,
      responseText: `Okay. I will keep that in the ${savedThread.title} thread${followupAt ? ' and keep it in view for later.' : '.'}`,
      referencedThread: getLifeThread(scheduledThread.id) || scheduledThread,
    };
  }

  const dontForgetMatch = raw.match(
    /^don'?t let me forget (this|that|.+?)(?: (tonight|tomorrow|before i leave))?[.!?]*$/i,
  );
  if (dontForgetMatch) {
    const summaryBase = /^(this|that)$/i.test(dontForgetMatch[1] || '')
      ? getSummarySource(input)
      : clipSummary(dontForgetMatch[1] || '');
    if (!summaryBase) {
      return {
        handled: true,
        responseText: 'Tell me what you do not want to lose first.',
      };
    }
    const followupAt = inferFollowupAnchor(dontForgetMatch[2] || raw, now);
    const title = deriveTitleFromSummary(summaryBase);
    const savedThread = upsertExplicitLifeThread({
      groupFolder: input.groupFolder,
      title,
      summary: summaryBase,
      channel: input.channel,
      sourceKind: 'reminder',
      nextAction: summaryBase,
      nextFollowupAt: followupAt,
      chatJid: input.chatJid,
      sourceRef: lifeThreadCommandSourceRef(input, now),
      messageId: input.messageId,
      now,
    });
    const scheduledThread = followupAt
      ? scheduleLifeThreadCommitment({
          threadId: savedThread.id,
          groupFolder: input.groupFolder,
          dueAt: followupAt,
          now,
          sourceKind: 'reminder',
          reason: `The user requested follow-through for ${savedThread.title}.`,
        }) || savedThread
      : savedThread;
    return {
      handled: true,
      responseText: `Okay. I will keep ${savedThread.title} in view so it does not slip.`,
      referencedThread: getLifeThread(scheduledThread.id) || scheduledThread,
    };
  }

  return { handled: false };
}
