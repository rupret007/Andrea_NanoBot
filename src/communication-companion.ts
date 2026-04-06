import { randomUUID } from 'crypto';

import { resolveCompanionToneProfileFromFacts } from './companion-personality.js';
import {
  createTask,
  deleteCommunicationThread,
  getCommunicationThread,
  getProfileSubjectByKey,
  listCommunicationThreadsForGroup,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  listProfileSubjectsForGroup,
  listRecentMessagesForChat,
  updateCommunicationThread,
  upsertCommunicationSignal,
  upsertCommunicationThread,
  upsertProfileSubject,
} from './db.js';
import { findLifeThreadForExplicitLookup, handleLifeThreadCommand } from './life-threads.js';
import { planContextualReminder } from './local-reminder.js';
import {
  buildSignatureFlowText,
  buildSignaturePostActionConfirmation,
} from './signature-flows.js';
import type {
  CommunicationFollowupState,
  CommunicationInferenceState,
  CommunicationSignalRecord,
  CommunicationSuggestedAction,
  CommunicationThreadRecord,
  CommunicationTrackingMode,
  CommunicationUrgency,
  LifeThread,
  ProfileFactWithSubject,
  ProfileSubject,
} from './types.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';

export interface CommunicationPriorContext {
  personName?: string;
  threadTitle?: string;
  lastAnswerSummary?: string;
  conversationFocus?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
}

export interface CommunicationContextInput {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder: string;
  chatJid?: string;
  text?: string;
  replyText?: string;
  conversationSummary?: string;
  priorContext?: CommunicationPriorContext;
  now?: Date;
}

export interface CommunicationAnalysisResult {
  ok: boolean;
  clarificationQuestion?: string;
  messageText?: string;
  summaryText?: string;
  followupState?: CommunicationFollowupState;
  urgency?: CommunicationUrgency;
  threadOpen?: boolean;
  suggestedActions: CommunicationSuggestedAction[];
  explanation?: string;
  thread?: CommunicationThreadRecord;
  linkedLifeThreads: LifeThread[];
  linkedSubjects: ProfileSubject[];
}

export interface CommunicationDraftResult {
  ok: boolean;
  clarificationQuestion?: string;
  draftText?: string;
  summaryText?: string;
  thread?: CommunicationThreadRecord;
  linkedLifeThreads: LifeThread[];
  linkedSubjects: ProfileSubject[];
  style: 'balanced' | 'warmer' | 'direct' | 'short';
}

export interface CommunicationOpenLoopItem {
  threadId: string;
  title: string;
  personName?: string;
  summaryText: string;
  followupState: CommunicationFollowupState;
  urgency: CommunicationUrgency;
  suggestedNextAction?: CommunicationSuggestedAction | null;
}

export interface CommunicationOpenLoopsResult {
  ok: boolean;
  summaryText: string;
  bestNextStep?: string;
  items: CommunicationOpenLoopItem[];
}

export interface CommunicationManageTrackingResult {
  ok: boolean;
  replyText: string;
  thread?: CommunicationThreadRecord;
  reminderTaskId?: string;
}

export interface CommunicationCarryoverSignal {
  summaryText: string;
  sourceLabel: string;
  urgency: CommunicationUrgency;
  threadId: string;
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipText(value: string, max = 180): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function normalizeDraftTopicSummary(value: string): string {
  return value
    .replace(/^[A-Z][a-z]+ wants a follow-up about\s+/i, '')
    .replace(/^[A-Z][a-z]+ said\s+/i, '')
    .replace(/\bplease reply about\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

function slugifyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripCommandPrefix(raw: string): string {
  return raw
    .replace(
      /^(?:summarize this message|what did they mean|what still needs a reply here|what should i say back|draft a reply(?: to [a-z][a-z' -]+)?|give me a short reply|make it warmer|make it more direct|make it sound like me|save this conversation under [^:]+|remind me to reply later|don't surface this automatically|dont surface this automatically|stop tracking that|forget this conversation thread|mark that handled)[:,-]?\s*/i,
      '',
    )
    .trim();
}

function cleanMessageBody(value: string): string {
  return stripCommandPrefix(
    value
      .replace(/^\s*(?:from|message from|text from)\s+[A-Z][^:]{0,40}:\s*/i, '')
      .replace(/^\s*>+\s*/gm, '')
      .trim(),
  );
}

function extractLatestInboundMessage(chatJid: string | undefined): {
  text?: string;
  messageId?: string;
  timestamp?: string;
} {
  if (!chatJid) return {};
  const message = listRecentMessagesForChat(chatJid, 8).find(
    (item) => !item.is_from_me && !item.is_bot_message && item.content?.trim(),
  );
  if (!message) return {};
  return {
    text: message.content,
    messageId: message.id,
    timestamp: message.timestamp,
  };
}

function extractMessageText(input: CommunicationContextInput): {
  text?: string;
  messageId?: string;
  timestamp?: string;
  source: 'direct' | 'reply' | 'prior' | 'chat';
} {
  const direct = cleanMessageBody(input.text || '');
  if (direct) {
    return { text: direct, source: 'direct' };
  }
  const reply = cleanMessageBody(input.replyText || '');
  if (reply) {
    return { text: reply, source: 'reply' };
  }
  const prior = cleanMessageBody(
    input.priorContext?.lastCommunicationSummary ||
      input.priorContext?.lastAnswerSummary ||
      input.conversationSummary ||
      '',
  );
  if (prior) {
    return { text: prior, source: 'prior' };
  }
  return { ...extractLatestInboundMessage(input.chatJid), source: 'chat' };
}

function ensureProfileSubject(
  groupFolder: string,
  displayName: string,
  now: Date,
): ProfileSubject | undefined {
  const cleaned = displayName.trim();
  if (!cleaned) return undefined;
  const canonicalName = slugifyName(cleaned);
  if (!canonicalName) return undefined;
  const existing = getProfileSubjectByKey(groupFolder, 'person', canonicalName);
  if (existing) return existing;
  const subject: ProfileSubject = {
    id: randomUUID(),
    groupFolder,
    kind: 'person',
    canonicalName,
    displayName: cleaned,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    disabledAt: null,
  };
  upsertProfileSubject(subject);
  return subject;
}

function detectExplicitPersonName(
  rawText: string,
  subjects: ProfileSubject[],
): string | undefined {
  const normalized = rawText.toLowerCase();
  for (const subject of subjects) {
    if (
      subject.kind === 'person' &&
      (normalized.includes(subject.displayName.toLowerCase()) ||
        normalized.includes(subject.canonicalName.replace(/-/g, ' ')))
    ) {
      return subject.displayName;
    }
  }
  const matched =
    rawText.match(/\b(?:to|with|from|about|reply to)\s+([A-Z][a-z]+)\b/)?.[1] ||
    rawText.match(/^([A-Z][a-z]+)\s*:/)?.[1];
  return matched?.trim() || undefined;
}

function resolveSubjectIds(
  input: CommunicationContextInput,
  messageText: string,
  subjects: ProfileSubject[],
  now: Date,
): ProfileSubject[] {
  const matched = new Map<string, ProfileSubject>();
  for (const subjectId of input.priorContext?.communicationSubjectIds || []) {
    const subject = subjects.find((item) => item.id === subjectId);
    if (subject) {
      matched.set(subject.id, subject);
    }
  }

  const explicitName =
    input.priorContext?.personName ||
    detectExplicitPersonName(input.text || messageText, subjects) ||
    detectExplicitPersonName(messageText, subjects);
  if (explicitName) {
    const canonical = slugifyName(explicitName);
    const existing =
      subjects.find(
        (subject) =>
          subject.kind === 'person' &&
          (subject.canonicalName === canonical ||
            subject.displayName.toLowerCase() === explicitName.toLowerCase()),
      ) || ensureProfileSubject(input.groupFolder, explicitName, now);
    if (existing) {
      matched.set(existing.id, existing);
    }
  }

  return [...matched.values()];
}

function resolveLifeThreads(
  input: CommunicationContextInput,
  linkedSubjects: ProfileSubject[],
): LifeThread[] {
  const threads = listLifeThreadsForGroup(input.groupFolder, ['active', 'paused']);
  const subjectIds = new Set(linkedSubjects.map((subject) => subject.id));
  const matched = new Map<string, LifeThread>();

  for (const threadId of input.priorContext?.communicationLifeThreadIds || []) {
    const thread = threads.find((item) => item.id === threadId);
    if (thread) {
      matched.set(thread.id, thread);
    }
  }

  for (const thread of threads) {
    if (thread.relatedSubjectIds.some((subjectId) => subjectIds.has(subjectId))) {
      matched.set(thread.id, thread);
    }
  }

  const threadHint = input.priorContext?.threadTitle?.trim();
  if (threadHint) {
    const explicit = findLifeThreadForExplicitLookup({
      groupFolder: input.groupFolder,
      query: threadHint,
      statuses: ['active', 'paused'],
    });
    if (explicit) {
      matched.set(explicit.id, explicit);
    }
  }

  return [...matched.values()];
}

function inferUrgency(
  text: string,
  now: Date,
  timestamp?: string,
): CommunicationUrgency {
  const normalized = text.toLowerCase();
  if (/\btonight|this evening|before tonight\b/.test(normalized)) {
    return 'tonight';
  }
  if (/\btomorrow|tomorrow morning|tomorrow afternoon|tomorrow evening\b/.test(normalized)) {
    return 'tomorrow';
  }
  if (/\basap|soon|later today|by end of day|before i leave|when you can\b/.test(normalized)) {
    return 'soon';
  }
  if (timestamp) {
    const then = new Date(timestamp);
    if (!Number.isNaN(then.getTime()) && now.getTime() - then.getTime() > 36 * 60 * 60 * 1000) {
      return 'overdue';
    }
  }
  return 'none';
}

function inferFollowupState(
  text: string,
  urgency: CommunicationUrgency,
): CommunicationFollowupState {
  const normalized = text.toLowerCase();
  const waitingPatterns = [
    /\bi(?:'| wi)?ll let you know\b/,
    /\bi(?:'| wi)?ll check\b/,
    /\bi(?:'| wi)?ll get back to you\b/,
    /\bwaiting to hear back\b/,
  ];
  if (waitingPatterns.some((pattern) => pattern.test(normalized))) {
    return 'waiting_on_them';
  }

  const resolvedPatterns = [
    /\bthanks\b/,
    /\bthank you\b/,
    /\bsounds good\b/,
    /\bperfect\b/,
    /\bworks for me\b/,
    /\bsee you then\b/,
    /\ball set\b/,
  ];
  if (
    resolvedPatterns.some((pattern) => pattern.test(normalized)) &&
    !/[?]/.test(normalized)
  ) {
    return 'resolved';
  }

  const askPatterns = [
    /[?]/,
    /\blet me know\b/,
    /\bcan you\b/,
    /\bcould you\b/,
    /\bwould you\b/,
    /\bare you free\b/,
    /\bdoes that work\b/,
    /\bwhat do you think\b/,
    /\bshould we\b/,
    /\bcan we\b/,
    /\bneed you to\b/,
  ];
  if (askPatterns.some((pattern) => pattern.test(normalized))) {
    return urgency === 'tonight' || urgency === 'tomorrow' ? 'scheduled' : 'reply_needed';
  }

  if (/\bfyi\b|\bjust wanted to let you know\b/.test(normalized)) {
    return 'ignored';
  }
  return 'unknown';
}

function pickSuggestedActions(
  followupState: CommunicationFollowupState,
  linkedLifeThreads: LifeThread[],
): CommunicationSuggestedAction[] {
  switch (followupState) {
    case 'reply_needed':
      return linkedLifeThreads.length > 0
        ? ['draft_reply', 'create_reminder']
        : ['draft_reply', 'link_thread'];
    case 'scheduled':
      return ['save_for_later', 'create_reminder'];
    case 'waiting_on_them':
      return linkedLifeThreads.length > 0 ? ['link_thread', 'ignore'] : ['ignore'];
    case 'resolved':
    case 'ignored':
      return ['ignore'];
    default:
      return linkedLifeThreads.length > 0 ? ['draft_reply', 'link_thread'] : ['link_thread'];
  }
}

function buildSummaryText(
  messageText: string,
  linkedSubjects: ProfileSubject[],
  followupState: CommunicationFollowupState,
): string {
  const lead = linkedSubjects[0]?.displayName || 'They';
  const questionTopic =
    messageText.match(/\blet me know if (.+?)[.!?]*$/i)?.[1] ||
    messageText.match(/\bcan you (.+?)[.!?]*$/i)?.[1] ||
    messageText.match(/\bcould you (.+?)[.!?]*$/i)?.[1] ||
    messageText.match(/\bwould you (.+?)[.!?]*$/i)?.[1];
  const snippet = clipText(
    messageText
      .replace(/^[A-Z][a-z]+:\s*/, '')
      .replace(
        /\b(?:can you|could you|would you|let me know if|let me know|please|what do you think about)\b/gi,
        '',
      )
      .replace(/[?]/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
    110,
  );
  const focus = clipText((questionTopic || snippet).trim(), 90).toLowerCase();
  if (followupState === 'reply_needed') {
    return `${lead} wants an answer about ${focus}.`;
  }
  if (followupState === 'scheduled') {
    return `${lead} wants a follow-up about ${focus}.`;
  }
  if (followupState === 'waiting_on_them') {
    return `${lead} said they would get back to you about ${focus}.`;
  }
  if (followupState === 'resolved') {
    return `${lead} sounds settled on ${focus}.`;
  }
  return `${lead} said ${snippet}.`;
}

function buildExplanation(
  followupState: CommunicationFollowupState,
  urgency: CommunicationUrgency,
): string {
  if (followupState === 'reply_needed') {
    return 'It reads like a direct ask that still wants your answer.';
  }
  if (followupState === 'scheduled') {
    return urgency === 'tonight'
      ? 'It includes a timing cue for tonight, so it feels like something to keep in view.'
      : 'It points to a later timing, so a reminder or save-for-later makes more sense than replying immediately.';
  }
  if (followupState === 'waiting_on_them') {
    return 'They sounded like they were taking the next step, so you may just want to keep light track of it.';
  }
  if (followupState === 'resolved') {
    return 'The wording sounds closed-loop rather than like an open ask.';
  }
  return 'There is no strong explicit ask, so this looks more like context than an urgent reply.';
}

function buildThreadTitle(
  linkedSubjects: ProfileSubject[],
  linkedLifeThreads: LifeThread[],
): string {
  if (linkedSubjects[0]) {
    return `${linkedSubjects[0].displayName} conversation`;
  }
  if (linkedLifeThreads[0]) {
    return `${linkedLifeThreads[0].title} conversation`;
  }
  return 'Communication follow-up';
}

function buildToneHints(
  facts: ProfileFactWithSubject[],
  linkedSubjects: ProfileSubject[],
): string[] {
  const hints = new Set<string>();
  const linkedIds = new Set(linkedSubjects.map((subject) => subject.id));
  for (const fact of facts) {
    if (fact.state !== 'accepted') continue;
    if (!linkedIds.has(fact.subjectId) && fact.subjectKind !== 'self') continue;
    const value = normalizeText(fact.sourceSummary);
    if (!value) continue;
    if (
      fact.category === 'conversational_style' ||
      fact.category === 'relationships' ||
      fact.category === 'people'
    ) {
      hints.add(clipText(value, 80));
    }
  }
  return [...hints].slice(0, 3);
}

function resolveExistingThread(
  input: CommunicationContextInput,
  linkedSubjects: ProfileSubject[],
): CommunicationThreadRecord | undefined {
  if (input.priorContext?.communicationThreadId) {
    return getCommunicationThread(input.priorContext.communicationThreadId);
  }
  const subjectId = linkedSubjects[0]?.id;
  if (!subjectId) return undefined;
  return listCommunicationThreadsForGroup({
    groupFolder: input.groupFolder,
    subjectId,
    includeDisabled: false,
    limit: 1,
  })[0];
}

function upsertThreadFromAnalysis(input: {
  existing?: CommunicationThreadRecord;
  sourceChannel: CommunicationThreadRecord['channel'];
  groupFolder: string;
  chatJid?: string;
  messageId?: string;
  linkedSubjects: ProfileSubject[];
  linkedLifeThreads: LifeThread[];
  summaryText: string;
  followupState: CommunicationFollowupState;
  urgency: CommunicationUrgency;
  suggestedAction?: CommunicationSuggestedAction;
  toneHints: string[];
  lastContactAt: string;
  now: string;
  inferenceState: CommunicationInferenceState;
}): CommunicationThreadRecord {
  const next: CommunicationThreadRecord = {
    id: input.existing?.id || randomUUID(),
    groupFolder: input.groupFolder,
    title:
      input.existing?.title || buildThreadTitle(input.linkedSubjects, input.linkedLifeThreads),
    linkedSubjectIds: input.linkedSubjects.map((subject) => subject.id),
    linkedLifeThreadIds: input.linkedLifeThreads.map((thread) => thread.id),
    channel: input.sourceChannel,
    channelChatJid: input.chatJid || input.existing?.channelChatJid || null,
    lastInboundSummary: input.summaryText,
    lastOutboundSummary: input.existing?.lastOutboundSummary || null,
    followupState: input.followupState,
    urgency: input.urgency,
    followupDueAt:
      input.urgency === 'tonight'
        ? input.now
        : input.existing?.followupDueAt || null,
    suggestedNextAction: input.suggestedAction || null,
    toneStyleHints: input.toneHints,
    lastContactAt: input.lastContactAt,
    lastMessageId: input.messageId || input.existing?.lastMessageId || null,
    linkedTaskId: input.existing?.linkedTaskId || null,
    inferenceState: input.existing
      ? input.existing.inferenceState === input.inferenceState
        ? input.existing.inferenceState
        : 'mixed'
      : input.inferenceState,
    trackingMode: input.existing?.trackingMode || 'default',
    createdAt: input.existing?.createdAt || input.now,
    updatedAt: input.now,
    disabledAt: input.existing?.disabledAt || null,
  };
  upsertCommunicationThread(next);
  return next;
}

function buildSignalRecord(input: {
  thread: CommunicationThreadRecord;
  sourceChannel: CommunicationSignalRecord['sourceChannel'];
  chatJid?: string;
  messageId?: string;
  summaryText: string;
  followupState: CommunicationFollowupState;
  urgency: CommunicationUrgency;
  direction: CommunicationSignalRecord['direction'];
  suggestedAction?: CommunicationSuggestedAction;
  createdAt: string;
}): CommunicationSignalRecord {
  return {
    id: randomUUID(),
    communicationThreadId: input.thread.id,
    groupFolder: input.thread.groupFolder,
    sourceChannel: input.sourceChannel,
    chatJid: input.chatJid || null,
    messageId: input.messageId || null,
    direction: input.direction,
    summaryText: input.summaryText,
    followupState: input.followupState,
    suggestedAction: input.suggestedAction || null,
    urgency: input.urgency,
    createdAt: input.createdAt,
  };
}

function buildRelationshipAwareDraft(input: {
  linkedSubjects: ProfileSubject[];
  linkedLifeThreads: LifeThread[];
  toneHints: string[];
  profileFacts: ProfileFactWithSubject[];
  summaryText: string;
  style: CommunicationDraftResult['style'];
}): string {
  const personName = input.linkedSubjects[0]?.displayName;
  const opener =
    input.style === 'direct'
      ? personName
        ? `${personName},`
        : ''
      : personName
        ? `Hey ${personName},`
        : 'Hey,';
  const companionTone = resolveCompanionToneProfileFromFacts(input.profileFacts);
  const draftTopic =
    normalizeDraftTopicSummary(input.summaryText) || input.summaryText.replace(/\.$/, '');
  const baseBody =
    input.style === 'direct'
      ? `On my side, ${draftTopic}.`
      : `I wanted to follow up about ${draftTopic}.`;
  const supportLine =
    input.linkedLifeThreads[0]?.nextAction ||
    input.linkedLifeThreads[0]?.summary ||
    input.toneHints[0] ||
    (companionTone === 'plain'
      ? 'Here is the main thing from my side.'
      : 'I wanted to keep it simple.');
  const closer =
    input.style === 'short'
      ? 'Let me know what works.'
      : input.style === 'warmer'
        ? 'No rush, but let me know what feels best.'
        : 'Let me know what works best.';

  return [opener, baseBody, clipText(supportLine, 120), closer]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferStyle(text: string): CommunicationDraftResult['style'] {
  const normalized = text.toLowerCase();
  if (/\bshort\b/.test(normalized)) return 'short';
  if (/\bwarmer\b/.test(normalized)) return 'warmer';
  if (/\bmore direct\b|\bdirect\b/.test(normalized)) return 'direct';
  return 'balanced';
}

function inferPersonScopeFromText(
  text: string,
  subjects: ProfileSubject[],
): ProfileSubject | undefined {
  const detected = detectExplicitPersonName(text, subjects);
  if (!detected) return undefined;
  const normalized = slugifyName(detected);
  return subjects.find(
    (subject) =>
      subject.kind === 'person' &&
      (subject.canonicalName === normalized ||
        subject.displayName.toLowerCase() === detected.toLowerCase()),
  );
}

function formatOpenLoopLine(item: CommunicationOpenLoopItem): string {
  const prefix = item.personName || item.title;
  return `${prefix}: ${item.summaryText}`;
}

function toSignalChannel(
  channel: CommunicationContextInput['channel'],
): CommunicationSignalRecord['sourceChannel'] {
  return channel === 'alexa' ? 'alexa-originated handoff' : channel;
}

export function analyzeCommunicationMessage(
  input: CommunicationContextInput,
): CommunicationAnalysisResult {
  const now = input.now || new Date();
  const extracted = extractMessageText(input);
  const messageText = normalizeText(extracted.text);
  if (!messageText) {
    return {
      ok: false,
      clarificationQuestion:
        'Paste the message or quote the part you want me to read first.',
      suggestedActions: [],
      linkedLifeThreads: [],
      linkedSubjects: [],
    };
  }

  const subjects = listProfileSubjectsForGroup(input.groupFolder);
  const linkedSubjects = resolveSubjectIds(input, messageText, subjects, now);
  const linkedLifeThreads = resolveLifeThreads(input, linkedSubjects);
  const profileFacts = listProfileFactsForGroup(input.groupFolder, ['accepted']);
  const toneHints = buildToneHints(profileFacts, linkedSubjects);
  const existing = resolveExistingThread(input, linkedSubjects);
  const urgency =
    extracted.source === 'prior' && existing
      ? existing.urgency
      : inferUrgency(messageText, now, extracted.timestamp);
  const followupState =
    extracted.source === 'prior' && existing
      ? existing.followupState
      : inferFollowupState(messageText, urgency);
  const suggestedActions = pickSuggestedActions(followupState, linkedLifeThreads);
  const summaryText =
    extracted.source === 'prior' && existing?.lastInboundSummary
      ? existing.lastInboundSummary
      : buildSummaryText(messageText, linkedSubjects, followupState);
  const thread = upsertThreadFromAnalysis({
    existing,
    sourceChannel: toSignalChannel(input.channel),
    groupFolder: input.groupFolder,
    chatJid: input.chatJid,
    messageId: extracted.messageId,
    linkedSubjects,
    linkedLifeThreads,
    summaryText,
    followupState,
    urgency,
    suggestedAction: suggestedActions[0],
    toneHints,
    lastContactAt: extracted.timestamp || now.toISOString(),
    now: now.toISOString(),
    inferenceState:
      linkedSubjects.length > 0 || linkedLifeThreads.length > 0
        ? 'assistant_inferred'
        : 'assistant_inferred',
  });

  upsertCommunicationSignal(
    buildSignalRecord({
      thread,
      sourceChannel: toSignalChannel(input.channel),
      chatJid: input.chatJid,
      messageId: extracted.messageId,
      summaryText,
      followupState,
      urgency,
      direction: 'inbound',
      suggestedAction: suggestedActions[0],
      createdAt: now.toISOString(),
    }),
  );

  return {
    ok: true,
    messageText,
    summaryText,
    followupState,
    urgency,
    threadOpen:
      followupState === 'reply_needed' ||
      followupState === 'scheduled' ||
      followupState === 'waiting_on_them',
    suggestedActions,
    explanation: buildExplanation(followupState, urgency),
    thread,
    linkedLifeThreads,
    linkedSubjects,
  };
}

export function draftCommunicationReply(
  input: CommunicationContextInput,
): CommunicationDraftResult {
  const analysis = analyzeCommunicationMessage(input);
  if (!analysis.ok || !analysis.summaryText) {
    return {
      ok: false,
      clarificationQuestion:
        analysis.clarificationQuestion ||
        'Show me the message first so I can draft from the right context.',
      linkedLifeThreads: analysis.linkedLifeThreads,
      linkedSubjects: analysis.linkedSubjects,
      style: inferStyle(input.text || ''),
    };
  }

  const style = inferStyle(input.text || '');
  const profileFacts = listProfileFactsForGroup(input.groupFolder, ['accepted']);
  const draftText = buildRelationshipAwareDraft({
    linkedSubjects: analysis.linkedSubjects,
    linkedLifeThreads: analysis.linkedLifeThreads,
    toneHints: analysis.thread?.toneStyleHints || [],
    profileFacts,
    summaryText: analysis.summaryText,
    style,
  });

  if (analysis.thread) {
    updateCommunicationThread(analysis.thread.id, {
      lastOutboundSummary: clipText(draftText, 140),
      suggestedNextAction: 'reply_now',
    });
    upsertCommunicationSignal(
      buildSignalRecord({
        thread: analysis.thread,
        sourceChannel: toSignalChannel(input.channel),
        chatJid: input.chatJid,
        summaryText: clipText(draftText, 140),
        followupState: analysis.followupState || 'reply_needed',
        urgency: analysis.urgency || 'none',
        direction: 'draft',
        suggestedAction: 'reply_now',
        createdAt: (input.now || new Date()).toISOString(),
      }),
    );
  }

  return {
    ok: true,
    draftText,
    summaryText: analysis.summaryText,
    thread: analysis.thread,
    linkedLifeThreads: analysis.linkedLifeThreads,
    linkedSubjects: analysis.linkedSubjects,
    style,
  };
}

export function buildCommunicationOpenLoops(
  input: CommunicationContextInput,
): CommunicationOpenLoopsResult {
  const subjects = listProfileSubjectsForGroup(input.groupFolder);
  const personScope =
    (input.priorContext?.communicationSubjectIds || [])
      .map((subjectId) => subjects.find((subject) => subject.id === subjectId))
      .find(Boolean) ||
    inferPersonScopeFromText(input.text || '', subjects);
  const threads = listCommunicationThreadsForGroup({
    groupFolder: input.groupFolder,
    includeDisabled: false,
    followupStates: ['reply_needed', 'scheduled', 'waiting_on_them'],
    subjectId: personScope?.id,
    limit: 6,
  });

  const items = threads
    .filter((thread) => thread.followupState !== 'resolved' && thread.trackingMode !== 'disabled')
    .map<CommunicationOpenLoopItem>((thread) => {
      const personName =
        personScope?.displayName ||
        subjects.find((subject) => thread.linkedSubjectIds.includes(subject.id))?.displayName;
      return {
        threadId: thread.id,
        title: thread.title,
        personName,
        summaryText:
          thread.lastInboundSummary ||
          thread.lastOutboundSummary ||
          'This conversation still looks open.',
        followupState: thread.followupState,
        urgency: thread.urgency,
        suggestedNextAction: thread.suggestedNextAction,
      };
    });

  const summaryText = personScope
    ? items.length === 0
      ? `Nothing important looks open with ${personScope.displayName} right now.`
      : `${personScope.displayName} has ${items.length === 1 ? 'one conversation' : `${items.length} conversations`} still open.`
    : items.length === 0
      ? 'Nothing important is standing out as an owed reply right now.'
      : `You have ${items.length === 1 ? 'one open conversation that still looks active' : `${items.length} open conversations that still look active`}.`;

  return {
    ok: true,
    summaryText,
    bestNextStep:
      items[0]?.suggestedNextAction === 'draft_reply'
        ? `Draft the reply for ${items[0].personName || items[0].title} next.`
        : items[0]
          ? `Keep ${items[0].personName || items[0].title} in view next.`
          : undefined,
    items: items.slice(0, 3),
  };
}

export function manageCommunicationTracking(
  input: CommunicationContextInput,
): CommunicationManageTrackingResult {
  const now = input.now || new Date();
  const analysis = analyzeCommunicationMessage(input);
  const thread = analysis.thread;
  const utterance = normalizeText(input.text || '');
  if (!thread || !analysis.ok) {
    return {
      ok: false,
      replyText:
        analysis.clarificationQuestion ||
        'Show me the conversation you want me to track first.',
    };
  }

  if (/don't surface this automatically|dont surface this automatically/i.test(utterance)) {
    updateCommunicationThread(thread.id, { trackingMode: 'manual_only' });
    return {
      ok: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: input.channel,
        didWhat:
          'Okay. I will keep it available, but I will stop surfacing it automatically.',
        stillOpen: thread.lastInboundSummary || thread.lastOutboundSummary || null,
        nextSuggestion: 'Ask what is still open here whenever you want it back.',
      }),
      thread: getCommunicationThread(thread.id),
    };
  }
  if (/stop tracking that|forget this conversation thread/i.test(utterance)) {
    updateCommunicationThread(thread.id, {
      trackingMode: 'disabled',
      disabledAt: now.toISOString(),
    });
    return {
      ok: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: input.channel,
        didWhat: 'Okay. I will stop tracking that conversation thread.',
        nextSuggestion: 'Bring the message back if you want me to pick it up again.',
      }),
      thread: getCommunicationThread(thread.id),
    };
  }
  if (/mark that handled/i.test(utterance)) {
    updateCommunicationThread(thread.id, {
      followupState: 'resolved',
      suggestedNextAction: 'ignore',
    });
    return {
      ok: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: input.channel,
        didWhat: 'Okay. I marked that conversation as handled.',
        nextSuggestion: 'If anything changes, ask what is still open here.',
      }),
      thread: getCommunicationThread(thread.id),
    };
  }
  if (/forget this conversation thread completely/i.test(utterance)) {
    deleteCommunicationThread(thread.id);
    return { ok: true, replyText: 'Okay. I removed that conversation thread entirely.' };
  }
  if (/save this conversation under .+ thread/i.test(utterance)) {
    const threadTitle =
      utterance.match(/save this conversation under (?:the )?(.+?)(?: thread)?$/i)?.[1]?.trim() ||
      input.priorContext?.threadTitle;
    if (!threadTitle) {
      return { ok: false, replyText: 'Tell me which thread you want me to attach it to.' };
    }
    const result = handleLifeThreadCommand({
      groupFolder: input.groupFolder,
      channel: input.channel,
      chatJid: input.chatJid,
      text: `track this under ${threadTitle} thread`,
      replyText: analysis.summaryText,
      conversationSummary: input.conversationSummary,
      now,
    });
    if (result.handled && result.referencedThread) {
      updateCommunicationThread(thread.id, {
        linkedLifeThreadIds: Array.from(
          new Set([...thread.linkedLifeThreadIds, result.referencedThread.id]),
        ),
        inferenceState: 'mixed',
      });
      return {
        ok: true,
        replyText: buildSignaturePostActionConfirmation({
          channel: input.channel,
          didWhat:
            result.responseText ||
            `Okay. I linked that under ${result.referencedThread.title}.`,
          stillOpen: analysis.summaryText || thread.lastInboundSummary || null,
          nextSuggestion: 'I can also remind you later or draft the reply.',
        }),
        thread: getCommunicationThread(thread.id),
      };
    }
  }
  if (/remind me to reply later|remind me to answer later/i.test(utterance)) {
    const timing =
      utterance.match(/\b(tonight|tomorrow(?: morning| afternoon| evening)?|today(?: morning| afternoon| evening)?|before i leave)\b/i)?.[1] ||
      '';
    if (!timing) {
      return {
        ok: false,
        replyText: 'Tell me when you want that reply reminder.',
        thread,
      };
    }
    const planned = planContextualReminder(
      timing.toLowerCase() === 'tonight' ? 'today evening' : timing,
      analysis.linkedSubjects[0]?.displayName
        ? `reply to ${analysis.linkedSubjects[0].displayName} about ${clipText(
            analysis.messageText || thread.lastInboundSummary || 'this conversation',
            60,
          )}`
        : analysis.summaryText ||
            thread.lastInboundSummary ||
            'reply to this conversation',
      input.groupFolder,
      input.chatJid || thread.channelChatJid || 'companion:communication',
      now,
    );
    if (!planned) {
      return { ok: false, replyText: 'I could not pin down a reminder time from that yet.', thread };
    }
    createTask(planned.task);
    updateCommunicationThread(thread.id, {
      linkedTaskId: planned.task.id,
      followupState: 'scheduled',
      suggestedNextAction: 'create_reminder',
      urgency: timing.toLowerCase().includes('tomorrow') ? 'tomorrow' : 'tonight',
    });
    return {
      ok: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: input.channel,
        didWhat: planned.confirmation,
        stillOpen:
          analysis.summaryText || thread.lastInboundSummary || thread.title,
        nextSuggestion: 'I can also draft the reply when you are ready.',
      }),
      reminderTaskId: planned.task.id,
      thread: getCommunicationThread(thread.id),
    };
  }

  return {
    ok: true,
    replyText: 'I can link it to a thread, remind you later, stop surfacing it, or mark it handled.',
    thread,
  };
}

export function getCommunicationCarryoverSignal(input: {
  groupFolder: string;
  now?: Date;
}): CommunicationCarryoverSignal | null {
  const thread = listCommunicationThreadsForGroup({
    groupFolder: input.groupFolder,
    includeDisabled: false,
    followupStates: ['reply_needed', 'scheduled'],
    limit: 4,
  }).find((item) => item.trackingMode === 'default');
  if (!thread) return null;
  return {
    summaryText: thread.lastInboundSummary || thread.title,
    sourceLabel: thread.title,
    urgency: thread.urgency,
    threadId: thread.id,
  };
}

export function formatCommunicationAnalysisReply(
  channel: CommunicationContextInput['channel'],
  result: CommunicationAnalysisResult,
): string {
  if (!result.ok) {
    return result.clarificationQuestion || 'Show me the message first.';
  }
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: result.summaryText || 'I looked at the message.',
      details: [
        result.followupState === 'reply_needed'
          ? 'It still sounds like it wants a reply.'
          : result.followupState === 'scheduled'
            ? 'It feels like a later follow-up rather than something urgent right now.'
            : result.followupState === 'waiting_on_them'
              ? 'It sounds like they are carrying the next step.'
              : result.explanation,
      ],
      offerMore: false,
    });
  }
  return buildSignatureFlowText({
    lead: result.summaryText || 'I looked at the conversation.',
    detailLines: [
      `Follow-up: ${result.followupState?.replace(/_/g, ' ') || 'unknown'}`,
      result.urgency && result.urgency !== 'none'
        ? `Urgency: ${result.urgency}`
        : null,
    ],
    nextAction: result.suggestedActions.length
      ? result.suggestedActions
          .slice(0, 2)
          .map((action) => action.replace(/_/g, ' '))
          .join(', ')
      : null,
    whyLine: result.explanation,
  });
}

export function formatCommunicationDraftReply(
  channel: CommunicationContextInput['channel'],
  result: CommunicationDraftResult,
): string {
  if (!result.ok) {
    return result.clarificationQuestion || 'Show me the message first.';
  }
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: 'I drafted a reply.',
      details: [clipText(result.draftText || '', 180)],
      offerMore: false,
      maxDetails: 1,
    });
  }
  return buildSignatureFlowText({
    lead: result.summaryText || 'I drafted a reply.',
    bodyText: [`Draft:`, result.draftText].filter(Boolean).join('\n'),
    nextAction: 'Save it, send the fuller version, or remind yourself later.',
    whyLine:
      result.linkedSubjects[0]?.displayName
        ? `This is shaped around ${result.linkedSubjects[0].displayName} and the current conversation.`
        : 'This stays grounded in the conversation you brought in here.',
  });
}

export function formatCommunicationOpenLoopsReply(
  channel: CommunicationContextInput['channel'],
  result: CommunicationOpenLoopsResult,
): string {
  if (channel === 'alexa') {
    return buildVoiceReply({
      summary: result.summaryText,
      details: result.items.slice(0, 2).map((item) => formatOpenLoopLine(item)),
      offerMore: false,
    });
  }
  return buildSignatureFlowText({
    lead: result.summaryText,
    detailLines: result.items.slice(0, 3).map((item) => formatOpenLoopLine(item)),
    nextAction: result.bestNextStep,
    whyLine:
      result.items[0]?.personName
        ? `The lead open loop is with ${result.items[0].personName}.`
        : undefined,
  });
}
