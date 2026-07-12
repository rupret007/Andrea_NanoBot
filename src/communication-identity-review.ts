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
  items: CommunicationIdentityReviewItem[];
}

export interface CommunicationIdentityReviewResponse {
  handled: boolean;
  changed: boolean;
  replyText: string;
  snapshot?: CommunicationIdentityReviewSnapshot;
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
  const people = listProfileSubjectsForGroup(params.groupFolder).filter(
    (subject) => subject.kind === 'person',
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
  const matches = snapshot.items.filter(
    (item) => normalizeName(item.threadTitle) === target,
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
    if (item.isGroup) {
      return `${index + 1}. ${item.threadTitle} — group conversation; no single-person link proposed. Use \`dismiss identity ${quote(item.threadTitle)}\` if that is correct.`;
    }
    if (item.candidate) {
      return `${index + 1}. ${item.threadTitle} — exact match to existing profile person ${item.candidate.displayName}. Use \`confirm identity ${quote(item.threadTitle)} is ${quote(item.candidate.displayName)}\` or \`dismiss identity ${quote(item.threadTitle)}\`.`;
    }
    return `${index + 1}. ${item.threadTitle} — no safe candidate. Use \`link identity ${quote(item.threadTitle)} to ${quote('existing person name')}\` or \`dismiss identity ${quote(item.threadTitle)}\`.`;
  });
  const remaining = Math.max(0, snapshot.unreviewedThreads - unreviewed.length);
  return [
    `Communication identity review: ${snapshot.unreviewedThreads} unreviewed of ${snapshot.totalThreads}.`,
    ...lines,
    remaining > 0
      ? `${remaining} more will appear after these are reviewed.`
      : '',
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
    };
  }

  const resolvedThread = resolveThread(snapshot, command.threadTitle);
  if (resolvedThread.state === 'missing') {
    return {
      handled: true,
      changed: false,
      replyText: `I could not find an active communication thread named ${quote(command.threadTitle)}. Ask me to \`review communication identities\` for the exact metadata-only labels.`,
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
  const sourceChannel = params.channel;
  const now = (params.now || new Date()).toISOString();

  if (command.kind === 'confirm') {
    if (item.isGroup) {
      return {
        handled: true,
        changed: false,
        replyText: `${item.threadTitle} is a group conversation, so I will not treat it as one person. Use \`dismiss identity ${quote(item.threadTitle)}\` to mark the single-person link not applicable.`,
      };
    }
    const people = listProfileSubjectsForGroup(params.groupFolder).filter(
      (subject) => subject.kind === 'person',
    );
    const resolvedPerson = resolvePerson(people, command.personName);
    if (resolvedPerson.state === 'missing') {
      return {
        handled: true,
        changed: false,
        replyText: `I do not have exactly one existing profile person named ${quote(command.personName)}, so I did not create or guess an identity. Add the person through profile setup first.`,
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
    return {
      handled: true,
      changed: true,
      replyText: `Confirmed: ${item.threadTitle} is linked to ${resolvedPerson.person.displayName}. I can now use that reviewed relationship context, and you can reverse it with \`clear identity review ${quote(item.threadTitle)}\`.`,
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
    return {
      handled: true,
      changed: true,
      replyText: `Dismissed: ${item.threadTitle} will not be treated as a single known person. The conversation remains available without relationship inference.`,
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
      replyText: `There is no explicit identity review to clear for ${item.threadTitle}.`,
    };
  }
  return {
    handled: true,
    changed: true,
    replyText: `Cleared the identity review for ${item.threadTitle}. I will treat it as unresolved again and will not guess.`,
  };
}
