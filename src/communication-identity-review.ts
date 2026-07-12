import { createHash } from 'node:crypto';

import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import {
  decideCommunicationThreadIdentity,
  getAllChats,
  getRegisteredMainChat,
  listCommunicationIdentityReviewsForGroup,
  listCommunicationThreadsForGroup,
  listProfileSubjectsForGroup,
} from './db.js';
import type {
  ChannelInlineAction,
  CommunicationIdentityReviewRecord,
  CommunicationThreadRecord,
  ProfileSubject,
} from './types.js';

export type CommunicationIdentityReviewCommand =
  | { kind: 'list' }
  | { kind: 'confirm'; threadTitle: string; personName: string }
  | { kind: 'dismiss'; threadTitle: string }
  | { kind: 'clear'; threadTitle: string };

export interface CommunicationIdentityCandidate {
  subjectId: string;
  displayName: string;
  reason: 'exact_profile_name_match';
}

export interface CommunicationIdentityReviewItem {
  threadId: string;
  reviewKey: string;
  threadTitle: string;
  isGroup: boolean;
  review: CommunicationIdentityReviewRecord | null;
  candidate: CommunicationIdentityCandidate | null;
  linkedSubjectIds: string[];
}

export interface CommunicationIdentityReviewSnapshot {
  totalThreads: number;
  resolvedThreads: number;
  unreviewedThreads: number;
  availablePeopleNames: string[];
  items: CommunicationIdentityReviewItem[];
}

export interface CommunicationIdentityReviewResponse {
  handled: boolean;
  changed: boolean;
  replyText: string;
  snapshot?: CommunicationIdentityReviewSnapshot;
  inlineActionRows?: ChannelInlineAction[][];
}

function normalizeName(value: string | null | undefined): string {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

function stripQuotedTarget(value: string): string {
  const trimmed = value
    .trim()
    .replace(/[.!?]+$/g, '')
    .trim();
  const paired = trimmed.match(
    /^(?:"([\s\S]+)"|'([\s\S]+)'|“([\s\S]+)”|‘([\s\S]+)’)$/,
  );
  return (paired?.[1] || paired?.[2] || paired?.[3] || paired?.[4] || trimmed)
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseCommunicationIdentityReviewCommand(
  text: string,
): CommunicationIdentityReviewCommand | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (
    /^(?:review|show|list|manage) (?:my )?(?:communication |conversation |message |chat )?identit(?:y|ies|y links)$/i.test(
      normalized,
    ) ||
    /^(?:who are my recent (?:message|chat|conversation) threads|which conversations need identity review)$/i.test(
      normalized,
    )
  ) {
    return { kind: 'list' };
  }

  const confirm = normalized.match(
    /^(?:confirm|link) (?:the )?(?:identity|conversation|thread|chat)(?: for)? (.+?) (?:is|to) (.+)$/i,
  );
  if (confirm) {
    const threadTitle = stripQuotedTarget(confirm[1] || '');
    const personName = stripQuotedTarget(confirm[2] || '');
    if (threadTitle && personName) {
      return { kind: 'confirm', threadTitle, personName };
    }
  }

  const dismiss = normalized.match(
    /^(?:dismiss|skip) (?:the )?(?:identity|conversation identity|thread identity|chat identity)(?: for)? (.+)$/i,
  );
  if (dismiss) {
    const threadTitle = stripQuotedTarget(dismiss[1] || '');
    if (threadTitle) return { kind: 'dismiss', threadTitle };
  }

  const clear = normalized.match(
    /^(?:clear|reset|forget) (?:the )?(?:identity review|identity link|conversation identity|thread identity)(?: for)? (.+)$/i,
  );
  if (clear) {
    const threadTitle = stripQuotedTarget(clear[1] || '');
    if (threadTitle) return { kind: 'clear', threadTitle };
  }
  return null;
}

function hasIdentifierShape(value: string): boolean {
  const normalized = value.trim();
  return (
    /@/.test(normalized) ||
    /^(?:bb:)?(?:iMessage|SMS|RCS);/i.test(normalized) ||
    /^\+?[\d ().-]{7,}$/.test(normalized)
  );
}

function isGenericSelfName(value: string): boolean {
  return /^(?:i|me|myself|self|you|owner|user)$/i.test(normalizeName(value));
}

function hasCollectiveIdentityShape(value: string): boolean {
  return /\b(?:family|contacts?|friends?|coworkers?|colleagues?|team|group|band|household|school|parents?|children|kids|neighbors?)\b/i.test(
    normalizeName(value),
  );
}

function eligibleProfilePeople(people: ProfileSubject[]): ProfileSubject[] {
  return people.filter(
    (subject) =>
      subject.kind === 'person' &&
      !isGenericSelfName(subject.displayName) &&
      !isGenericSelfName(subject.canonicalName) &&
      !hasCollectiveIdentityShape(subject.displayName) &&
      !hasCollectiveIdentityShape(subject.canonicalName) &&
      !hasIdentifierShape(subject.displayName),
  );
}

function reviewKeyFor(groupFolder: string, threadId: string): string {
  return `R-${createHash('sha256')
    .update(`${groupFolder}\u0000${threadId}`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase()}`;
}

function uniquelyResolvablePeopleNames(people: ProfileSubject[]): string[] {
  const seen = new Set<string>();
  return people
    .map((person) => person.displayName)
    .filter((displayName) => {
      const normalized = normalizeName(displayName);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return resolvePerson(people, displayName).state === 'found';
    });
}

function exactPersonCandidate(
  thread: CommunicationThreadRecord,
  people: ProfileSubject[],
  isGroup: boolean,
): CommunicationIdentityCandidate | null {
  if (isGroup || hasIdentifierShape(thread.title)) return null;
  const title = normalizeName(thread.title);
  if (!title) return null;
  const matches = people.filter(
    (person) =>
      normalizeName(person.displayName) === title ||
      normalizeName(person.canonicalName) === title,
  );
  if (matches.length !== 1) return null;
  return {
    subjectId: matches[0]!.id,
    displayName: matches[0]!.displayName,
    reason: 'exact_profile_name_match',
  };
}

export function buildCommunicationIdentityReviewSnapshot(params: {
  groupFolder: string;
}): CommunicationIdentityReviewSnapshot {
  const threads = listCommunicationThreadsForGroup({
    groupFolder: params.groupFolder,
    limit: 80,
  });
  const people = eligibleProfilePeople(
    listProfileSubjectsForGroup(params.groupFolder),
  );
  const reviews = new Map(
    listCommunicationIdentityReviewsForGroup(params.groupFolder).map(
      (review) => [review.threadId, review],
    ),
  );
  const chats = new Map(getAllChats().map((chat) => [chat.jid, chat]));
  const items = threads.map((thread): CommunicationIdentityReviewItem => {
    const isGroup = Boolean(
      thread.channelChatJid && chats.get(thread.channelChatJid)?.is_group === 1,
    );
    return {
      threadId: thread.id,
      reviewKey: reviewKeyFor(params.groupFolder, thread.id),
      threadTitle: thread.title,
      isGroup,
      review: reviews.get(thread.id) || null,
      candidate: exactPersonCandidate(thread, people, isGroup),
      linkedSubjectIds: [...thread.linkedSubjectIds],
    };
  });
  const resolvedThreads = items.filter(
    (item) => item.linkedSubjectIds.length > 0 || item.review,
  ).length;
  return {
    totalThreads: items.length,
    resolvedThreads,
    unreviewedThreads: Math.max(0, items.length - resolvedThreads),
    availablePeopleNames: uniquelyResolvablePeopleNames(people),
    items,
  };
}

function resolveThread(
  snapshot: CommunicationIdentityReviewSnapshot,
  title: string,
):
  | { state: 'found'; item: CommunicationIdentityReviewItem }
  | { state: 'missing' }
  | { state: 'ambiguous'; titles: string[] } {
  const target = normalizeName(title);
  const reviewReference = target
    .replace(/^#/, '')
    .replace(/^\[|\]$/g, '')
    .toUpperCase();
  const matches = snapshot.items.filter(
    (item) =>
      normalizeName(item.threadTitle) === target ||
      item.reviewKey.toUpperCase() === reviewReference,
  );
  if (matches.length === 1) return { state: 'found', item: matches[0]! };
  if (matches.length > 1) {
    return {
      state: 'ambiguous',
      titles: matches.map((item) => item.threadTitle),
    };
  }
  return { state: 'missing' };
}

function resolvePerson(
  people: ProfileSubject[],
  name: string,
):
  | { state: 'found'; person: ProfileSubject }
  | { state: 'missing' }
  | { state: 'ambiguous'; names: string[] } {
  const target = normalizeName(name);
  const matches = people.filter(
    (person) =>
      normalizeName(person.displayName) === target ||
      normalizeName(person.canonicalName) === target,
  );
  if (matches.length === 1) return { state: 'found', person: matches[0]! };
  if (matches.length > 1) {
    return {
      state: 'ambiguous',
      names: matches.map((person) => person.displayName),
    };
  }
  return { state: 'missing' };
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '')}"`;
}

function inlineCode(value: string): string {
  return '`' + value.replace(/`/g, '') + '`';
}

function safeThreadLabel(item: CommunicationIdentityReviewItem): string {
  if (!hasIdentifierShape(item.threadTitle)) return item.threadTitle;
  return item.isGroup
    ? 'Unlabeled group conversation'
    : 'Unlabeled direct conversation';
}

function firstUnreviewedItem(
  snapshot: CommunicationIdentityReviewSnapshot,
): CommunicationIdentityReviewItem | null {
  return (
    snapshot.items.find(
      (item) => item.linkedSubjectIds.length === 0 && !item.review,
    ) || null
  );
}

function actionFitsTelegram(actionId: string): boolean {
  return Buffer.byteLength(actionId, 'utf8') <= 64;
}

export function buildCommunicationIdentityReviewActionRows(
  snapshot: CommunicationIdentityReviewSnapshot,
): ChannelInlineAction[][] {
  const item = firstUnreviewedItem(snapshot);
  if (!item) return [];

  const rows: ChannelInlineAction[][] = [];
  if (!item.isGroup) {
    const candidateNames = [
      ...(item.candidate ? [item.candidate.displayName] : []),
      ...snapshot.availablePeopleNames,
    ].filter(
      (name, index, all) =>
        all.findIndex(
          (candidate) => normalizeName(candidate) === normalizeName(name),
        ) === index,
    );
    for (const personName of candidateNames.slice(0, 5)) {
      const actionId = `link identity ${item.reviewKey} to ${quote(personName)}`;
      if (!actionFitsTelegram(actionId)) continue;
      rows.push([
        {
          label: `${item.candidate?.displayName === personName ? 'Confirm' : 'Link'} ${personName}`,
          actionId,
        },
      ]);
    }
  }
  rows.push([
    {
      label: item.isGroup ? 'Mark as group' : 'Leave unlinked',
      actionId: `dismiss identity ${item.reviewKey}`,
    },
  ]);
  return rows;
}

export function formatNextCommunicationIdentityReview(
  snapshot: CommunicationIdentityReviewSnapshot,
  options: { inlineControls?: boolean } = {},
): string {
  const item = firstUnreviewedItem(snapshot);
  if (!item) {
    return `Identity review is complete for all ${snapshot.totalThreads} active thread${snapshot.totalThreads === 1 ? '' : 's'}.`;
  }
  const label = safeThreadLabel(item);
  const inlineControls = options.inlineControls !== false;
  if (!inlineControls) {
    if (item.isGroup) {
      return `Next: [${item.reviewKey}] ${label} is a group conversation. Reply with ${inlineCode(`dismiss identity ${item.reviewKey}`)} to mark the single-person link not applicable, or leave it unresolved.`;
    }
    const candidateNames = [
      ...(item.candidate ? [item.candidate.displayName] : []),
      ...snapshot.availablePeopleNames,
    ]
      .filter(
        (name, index, all) =>
          all.findIndex(
            (candidate) => normalizeName(candidate) === normalizeName(name),
          ) === index,
      )
      .slice(0, 5);
    const choices = candidateNames.map((personName) =>
      inlineCode(`link identity ${item.reviewKey} to ${quote(personName)}`),
    );
    const choiceText = choices.length
      ? `Reply with ${choices.join(', ')}, or ${inlineCode(`dismiss identity ${item.reviewKey}`)} to leave it unlinked.`
      : `No eligible profile person is configured for this thread. Add the person through profile setup, or reply with ${inlineCode(`dismiss identity ${item.reviewKey}`)} to leave it unlinked.`;
    return `Next: [${item.reviewKey}] ${label}${item.candidate ? ` exactly matches ${item.candidate.displayName}` : ' has no safe automatic match'}. ${choiceText}`;
  }
  if (item.isGroup) {
    return `Next: [${item.reviewKey}] ${label} is a group conversation. Mark it as a group below, or leave it unresolved.`;
  }
  if (item.candidate) {
    return `Next: [${item.reviewKey}] ${label} exactly matches ${item.candidate.displayName}. Confirm that person below, choose another listed person, or leave it unresolved.`;
  }
  return `Next: [${item.reviewKey}] ${label} has no safe automatic match. Choose an existing person below, leave it unresolved, or type the opaque-key command for another eligible profile person.`;
}

function buildReviewContinuation(params: {
  groupFolder: string;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
}): Pick<CommunicationIdentityReviewResponse, 'snapshot' | 'inlineActionRows'> {
  const snapshot = buildCommunicationIdentityReviewSnapshot({
    groupFolder: params.groupFolder,
  });
  return {
    snapshot,
    inlineActionRows:
      params.channel === 'telegram'
        ? buildCommunicationIdentityReviewActionRows(snapshot)
        : undefined,
  };
}

export function formatCommunicationIdentityReviewSnapshot(
  snapshot: CommunicationIdentityReviewSnapshot,
): string {
  const unreviewed = snapshot.items
    .filter((item) => item.linkedSubjectIds.length === 0 && !item.review)
    .slice(0, 5);
  if (unreviewed.length === 0) {
    return `Communication identity review is complete for all ${snapshot.totalThreads} active thread${snapshot.totalThreads === 1 ? '' : 's'}. I only use confirmed person links for relationship-aware guidance.`;
  }
  const lines = unreviewed.map((item, index) => {
    const reference = item.reviewKey;
    const label = safeThreadLabel(item);
    if (item.isGroup) {
      return `${index + 1}. [${reference}] ${label} — group conversation; no single-person link proposed. Use \`dismiss identity ${reference}\` if that is correct.`;
    }
    if (item.candidate) {
      return `${index + 1}. [${reference}] ${label} — exact match to existing profile person ${item.candidate.displayName}. Use \`confirm identity ${reference} is ${quote(item.candidate.displayName)}\` or \`dismiss identity ${reference}\`.`;
    }
    return `${index + 1}. [${reference}] ${label} — no safe candidate. Choose explicitly with \`link identity ${reference} to ${quote('existing person name')}\` or use \`dismiss identity ${reference}\`.`;
  });
  const remaining = Math.max(0, snapshot.unreviewedThreads - unreviewed.length);
  const visiblePeople = snapshot.availablePeopleNames.slice(0, 8);
  const peopleLine = visiblePeople.length
    ? `Existing profile people you may choose: ${visiblePeople.join(', ')}${snapshot.availablePeopleNames.length > visiblePeople.length ? `, plus ${snapshot.availablePeopleNames.length - visiblePeople.length} more` : ''}.`
    : 'No eligible profile people are configured yet; add a person through profile setup before linking.';
  return [
    `Communication identity review: ${snapshot.unreviewedThreads} unreviewed of ${snapshot.totalThreads}.`,
    ...lines,
    remaining > 0
      ? `${remaining} more will appear after these are reviewed.`
      : '',
    peopleLine,
    'Candidates use only exact existing profile names and chat metadata—never message bodies, phone numbers, or generic language.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function handleCommunicationIdentityReview(params: {
  groupFolder: string;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  chatJid?: string | null;
  text: string;
  now?: Date;
}): CommunicationIdentityReviewResponse {
  const command = parseCommunicationIdentityReviewCommand(params.text);
  if (!command) return { handled: false, changed: false, replyText: '' };
  if (params.channel === 'alexa') {
    return {
      handled: true,
      changed: false,
      replyText:
        'Identity review is available in Telegram or your configured Messages self-thread, where the exact names can be reviewed safely.',
    };
  }
  if (
    params.channel === 'bluebubbles' &&
    !isBlueBubblesSelfThreadAliasJid(params.chatJid)
  ) {
    return {
      handled: true,
      changed: false,
      replyText:
        'Identity review is private to your configured Messages self-thread or Telegram.',
    };
  }
  if (params.channel === 'telegram' && params.chatJid) {
    const mainChat = getRegisteredMainChat();
    if (!mainChat || mainChat.jid !== params.chatJid) {
      return {
        handled: true,
        changed: false,
        replyText:
          'Identity review is private to your registered main Telegram chat or configured Messages self-thread.',
      };
    }
  }

  const snapshot = buildCommunicationIdentityReviewSnapshot({
    groupFolder: params.groupFolder,
  });
  if (command.kind === 'list') {
    return {
      handled: true,
      changed: false,
      replyText: formatCommunicationIdentityReviewSnapshot(snapshot),
      snapshot,
      inlineActionRows:
        params.channel === 'telegram'
          ? buildCommunicationIdentityReviewActionRows(snapshot)
          : undefined,
    };
  }

  const resolvedThread = resolveThread(snapshot, command.threadTitle);
  if (resolvedThread.state === 'missing') {
    return {
      handled: true,
      changed: false,
      replyText:
        'I could not find that active communication review reference. Ask me to `review communication identities` for the current opaque review keys.',
    };
  }
  if (resolvedThread.state === 'ambiguous') {
    return {
      handled: true,
      changed: false,
      replyText: `More than one active thread has that label, so I did not change anything. Rename or disambiguate the thread before linking it.`,
    };
  }
  const item = resolvedThread.item;
  const itemLabel = safeThreadLabel(item);
  const sourceChannel = params.channel;
  const now = (params.now || new Date()).toISOString();

  if (command.kind === 'confirm') {
    if (item.isGroup) {
      return {
        handled: true,
        changed: false,
        replyText: `${itemLabel} is a group conversation, so I will not treat it as one person. Use \`dismiss identity ${item.reviewKey}\` to mark the single-person link not applicable.`,
      };
    }
    const people = eligibleProfilePeople(
      listProfileSubjectsForGroup(params.groupFolder),
    );
    const resolvedPerson = resolvePerson(people, command.personName);
    if (resolvedPerson.state === 'missing') {
      return {
        handled: true,
        changed: false,
        replyText:
          'I do not have exactly one eligible existing profile person with that name, so I did not create or guess an identity. Add the person through profile setup first.',
      };
    }
    if (resolvedPerson.state === 'ambiguous') {
      return {
        handled: true,
        changed: false,
        replyText: `That person name is ambiguous in the profile, so I did not change anything. Use a unique profile name first.`,
      };
    }
    const decision = decideCommunicationThreadIdentity({
      groupFolder: params.groupFolder,
      threadId: item.threadId,
      decision: 'confirmed',
      subjectId: resolvedPerson.person.id,
      sourceChannel,
      now,
    });
    if (!decision.ok) {
      return {
        handled: true,
        changed: false,
        replyText:
          'The identity decision could not be applied safely, so nothing changed.',
      };
    }
    const continuation = buildReviewContinuation(params);
    return {
      handled: true,
      changed: true,
      replyText: `Confirmed: ${itemLabel} is linked to ${resolvedPerson.person.displayName}. I can now use that reviewed relationship context, and you can reverse it with \`clear identity review ${item.reviewKey}\`.\n\n${formatNextCommunicationIdentityReview(continuation.snapshot!, { inlineControls: params.channel === 'telegram' })}`,
      ...continuation,
    };
  }

  if (command.kind === 'dismiss') {
    const decision = decideCommunicationThreadIdentity({
      groupFolder: params.groupFolder,
      threadId: item.threadId,
      decision: 'dismissed',
      sourceChannel,
      now,
    });
    if (!decision.ok) {
      return {
        handled: true,
        changed: false,
        replyText:
          decision.reason === 'existing_link_conflict'
            ? 'This thread already has a non-assistant identity link. I will not erase it through dismissal; clear or correct that reviewed relationship explicitly first.'
            : 'The identity decision could not be applied safely, so nothing changed.',
      };
    }
    const continuation = buildReviewContinuation(params);
    return {
      handled: true,
      changed: true,
      replyText: `Dismissed: ${itemLabel} will not be treated as a single known person. The conversation remains available without relationship inference.\n\n${formatNextCommunicationIdentityReview(continuation.snapshot!, { inlineControls: params.channel === 'telegram' })}`,
      ...continuation,
    };
  }

  const decision = decideCommunicationThreadIdentity({
    groupFolder: params.groupFolder,
    threadId: item.threadId,
    decision: 'clear',
    sourceChannel,
    now,
  });
  if (!decision.ok) {
    return {
      handled: true,
      changed: false,
      replyText: `There is no explicit identity review to clear for ${itemLabel}.`,
    };
  }
  const continuation = buildReviewContinuation(params);
  return {
    handled: true,
    changed: true,
    replyText: `Cleared the identity review for ${itemLabel}. I will treat it as unresolved again and will not guess.\n\n${formatNextCommunicationIdentityReview(continuation.snapshot!, { inlineControls: params.channel === 'telegram' })}`,
    ...continuation,
  };
}
