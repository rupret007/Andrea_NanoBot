import { resolveAlexaConversationFollowup } from './alexa-conversation.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
  expandBlueBubblesLogicalSelfThreadJids,
  isBlueBubblesSelfThreadAliasJid,
  canonicalizeBlueBubblesSelfThreadJid,
} from './bluebubbles-self-thread.js';
import {
  getAllChats,
  listMessageActionsForGroup,
  listRecentMessagesForChat,
  listRecentPilotJourneyEvents,
} from './db.js';
import {
  listBlueBubblesMessageActionContinuitySnapshots,
  reconcileBlueBubblesSelfThreadContinuity,
} from './message-actions.js';
import { resolveOrdinaryChatPilotJourney } from './pilot-mode.js';

const BLUEBUBBLES_FOLLOWUP_STATE = {
  flowKey: 'bluebubbles_companion',
  subjectKind: 'general' as const,
  subjectData: {
    lastAnswerSummary: 'Recent BlueBubbles companion context is available.',
    pendingActionText: 'Recent BlueBubbles companion context is available.',
  },
  summaryText: 'Recent BlueBubbles companion context is available.',
  supportedFollowups: [
    'anything_else',
    'shorter',
    'say_more',
    'after_that',
    'before_that',
    'remind_before_that',
    'send_details',
    'save_for_later',
    'save_to_library',
    'save_that',
    'track_thread',
    'create_reminder',
    'action_guidance',
    'risk_check',
    'draft_follow_up',
    'memory_control',
  ] as Array<
    | 'anything_else'
    | 'shorter'
    | 'say_more'
    | 'after_that'
    | 'before_that'
    | 'remind_before_that'
    | 'send_details'
    | 'save_for_later'
    | 'save_to_library'
    | 'save_that'
    | 'track_thread'
    | 'create_reminder'
    | 'action_guidance'
    | 'risk_check'
    | 'draft_follow_up'
    | 'memory_control'
  >,
  styleHints: {},
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function hasAndreaMention(normalized: string): boolean {
  return /(?:^|[\s([{\-])@andrea\b/.test(normalized);
}

function resolveBlueBubblesCompanionConversationKind(
  chatJid: string | null | undefined,
): 'self_thread' | 'direct_1to1' | 'group' {
  if (isBlueBubblesSelfThreadAliasJid(chatJid)) {
    return 'self_thread';
  }
  const normalizedChatJid =
    canonicalizeBlueBubblesSelfThreadJid(chatJid) || chatJid || null;
  const knownChat = normalizedChatJid
    ? getAllChats().find((chat) => chat.jid === normalizedChatJid)
    : null;
  return knownChat?.is_group ? 'group' : 'direct_1to1';
}

export function hasBlueBubblesAndreaMention(text: string): boolean {
  return hasAndreaMention(normalizeText(text));
}

export function stripBlueBubblesAndreaMention(text: string): string {
  return text
    .replace(/(^|[\s([{\-])@andrea\b[,:;!?-]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeBlueBubblesCompanionPrompt(text: string): string {
  const stripped = stripBlueBubblesAndreaMention(text);
  return stripped || 'hi';
}

export function isBlueBubblesProofDrillStartRequest(text: string): boolean {
  const normalized = normalizeText(stripBlueBubblesAndreaMention(text));
  return (
    normalized === 'start bluebubbles proof' ||
    normalized === 'start blue bubbles proof' ||
    normalized === 'start proof drill'
  );
}

export function isBlueBubblesExplicitAsk(
  text: string,
  options: {
    hasRecentCompanionContext?: boolean;
    chatJid?: string | null;
  } = {},
): boolean {
  const conversationKind = resolveBlueBubblesCompanionConversationKind(
    options.chatJid,
  );
  const directSelfThread = conversationKind === 'self_thread';
  const recentConversationalDirectChat =
    conversationKind === 'direct_1to1' &&
    Boolean(options.hasRecentCompanionContext);
  const hasMention = hasBlueBubblesAndreaMention(text);
  if (!hasMention && !directSelfThread && !recentConversationalDirectChat) {
    return false;
  }
  if (matchAssistantCapabilityRequest(text)) return true;
  if (resolveOrdinaryChatPilotJourney(text)) return true;
  if (
    options.hasRecentCompanionContext &&
    resolveAlexaConversationFollowup(text, BLUEBUBBLES_FOLLOWUP_STATE).ok
  ) {
    return true;
  }
  return hasMention;
}

export type BlueBubblesPendingLocalContinuationKind =
  | 'google_calendar_create'
  | 'google_calendar_reminder'
  | 'google_calendar_event_action'
  | 'calendar_automation'
  | 'action_reminder'
  | 'action_draft';

export type BlueBubblesCompanionIngressDecision =
  | { kind: 'explicit_ask' }
  | {
      kind: 'pending_local_continuation';
      continuationKind: BlueBubblesPendingLocalContinuationKind;
    }
  | { kind: 'ignored_chatter' };

function resolveBlueBubblesContinuationChatJids(chatJid: string): string[] {
  const candidates = expandBlueBubblesLogicalSelfThreadJids(chatJid);
  if (candidates.length === 0) {
    return [chatJid];
  }
  return [...new Set(candidates)];
}

export function resolveBlueBubblesPendingLocalContinuationKind(input: {
  chatJid: string;
  hasGoogleCalendarCreate(chatJid: string): boolean;
  hasGoogleCalendarReminder(chatJid: string): boolean;
  hasGoogleCalendarEventAction(chatJid: string): boolean;
  hasCalendarAutomation(chatJid: string): boolean;
  hasActionReminder(chatJid: string): boolean;
  hasActionDraft(chatJid: string): boolean;
}): BlueBubblesPendingLocalContinuationKind | null {
  const candidateChatJids = resolveBlueBubblesContinuationChatJids(
    input.chatJid,
  );

  if (
    candidateChatJids.some((chatJid) => input.hasGoogleCalendarCreate(chatJid))
  ) {
    return 'google_calendar_create';
  }
  if (
    candidateChatJids.some((chatJid) =>
      input.hasGoogleCalendarReminder(chatJid),
    )
  ) {
    return 'google_calendar_reminder';
  }
  if (
    candidateChatJids.some((chatJid) =>
      input.hasGoogleCalendarEventAction(chatJid),
    )
  ) {
    return 'google_calendar_event_action';
  }
  if (
    candidateChatJids.some((chatJid) => input.hasCalendarAutomation(chatJid))
  ) {
    return 'calendar_automation';
  }
  if (candidateChatJids.some((chatJid) => input.hasActionReminder(chatJid))) {
    return 'action_reminder';
  }
  if (candidateChatJids.some((chatJid) => input.hasActionDraft(chatJid))) {
    return 'action_draft';
  }
  return null;
}

function parseJsonSafe<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function resolveBlueBubblesActionPresentationChat(action: {
  presentationChatJid?: string | null;
  targetConversationJson: string;
}): string | null {
  const presentationChatJid = canonicalizeBlueBubblesSelfThreadJid(
    action.presentationChatJid,
  );
  if (
    presentationChatJid &&
    isBlueBubblesSelfThreadAliasJid(presentationChatJid)
  ) {
    return presentationChatJid;
  }
  const target = parseJsonSafe<{ chatJid?: string | null }>(
    action.targetConversationJson,
    {},
  );
  const targetChatJid = canonicalizeBlueBubblesSelfThreadJid(target.chatJid);
  if (targetChatJid && isBlueBubblesSelfThreadAliasJid(targetChatJid)) {
    return targetChatJid;
  }
  return presentationChatJid || targetChatJid;
}

export function decideBlueBubblesCompanionIngress(
  text: string,
  options: {
    hasRecentCompanionContext?: boolean;
    hasOpenMessageActionFollowup?: boolean;
    pendingLocalContinuationKind?: BlueBubblesPendingLocalContinuationKind | null;
    chatJid?: string | null;
  } = {},
): BlueBubblesCompanionIngressDecision {
  if (
    isBlueBubblesExplicitAsk(text, {
      hasRecentCompanionContext: options.hasRecentCompanionContext,
      chatJid: options.chatJid,
    })
  ) {
    return { kind: 'explicit_ask' };
  }
  if (options.hasOpenMessageActionFollowup) {
    return {
      kind: 'pending_local_continuation',
      continuationKind: 'action_draft',
    };
  }
  if (options.pendingLocalContinuationKind) {
    return {
      kind: 'pending_local_continuation',
      continuationKind: options.pendingLocalContinuationKind,
    };
  }
  return { kind: 'ignored_chatter' };
}

export function resolveMostRecentBlueBubblesCompanionChat(params: {
  groupFolder: string;
  maxAgeHours?: number;
  now?: Date;
}): { chatJid: string; engagedAt: string } | null {
  const now = params.now || new Date();
  const cutoff =
    now.getTime() - Math.max(1, params.maxAgeHours || 12) * 60 * 60 * 1000;
  const continuitySnapshots = listBlueBubblesMessageActionContinuitySnapshots({
    groupFolder: params.groupFolder,
    now,
    allowRehydrate: true,
  });
  const prioritizedContinuity = continuitySnapshots.find((snapshot) => {
    const recentTargetAt = Date.parse(snapshot.recentTargetAt || '');
    return (
      snapshot.recentTargetChatJid !== 'none' &&
      Number.isFinite(recentTargetAt) &&
      recentTargetAt >= cutoff
    );
  });
  if (prioritizedContinuity) {
    return {
      chatJid: prioritizedContinuity.recentTargetChatJid,
      engagedAt: prioritizedContinuity.recentTargetAt,
    };
  }
  const continuity = reconcileBlueBubblesSelfThreadContinuity({
    groupFolder: params.groupFolder,
    chatJid: BLUEBUBBLES_CANONICAL_SELF_THREAD_JID,
    now,
    allowRehydrate: true,
  });
  const continuityEngagedAt = Date.parse(continuity.recentTargetAt || '');
  if (
    continuity.recentTargetChatJid !== 'none' &&
    Number.isFinite(continuityEngagedAt) &&
    continuityEngagedAt >= cutoff
  ) {
    return {
      chatJid: continuity.recentTargetChatJid,
      engagedAt: continuity.recentTargetAt,
    };
  }

  const recentOpenAction = listMessageActionsForGroup({
    groupFolder: params.groupFolder,
    includeSent: false,
    limit: 80,
  })
    .filter((action) => action.targetChannel === 'bluebubbles')
    .map((action) => {
      const engagedAt =
        action.lastActionAt || action.lastUpdatedAt || action.createdAt;
      const engagedAtMs = Date.parse(engagedAt || '');
      const chatJid = resolveBlueBubblesActionPresentationChat(action);
      return chatJid &&
        engagedAt &&
        Number.isFinite(engagedAtMs) &&
        engagedAtMs >= cutoff
        ? { chatJid, engagedAt }
        : null;
    })
    .filter((entry): entry is { chatJid: string; engagedAt: string } =>
      Boolean(entry),
    )
    .sort(
      (left, right) =>
        Date.parse(right.engagedAt || '') - Date.parse(left.engagedAt || ''),
    )[0];

  if (recentOpenAction) {
    return recentOpenAction;
  }

  const recentProofAction = listMessageActionsForGroup({
    groupFolder: params.groupFolder,
    includeSent: true,
    limit: 80,
  })
    .filter(
      (action) =>
        ['sent', 'deferred'].includes(action.sendStatus) ||
        ['sent', 'scheduled_send', 'remind_instead', 'save_to_thread'].includes(
          action.lastActionKind || '',
        ),
    )
    .filter((action) => action.targetChannel === 'bluebubbles')
    .map((action) => {
      const engagedAt =
        action.lastActionAt ||
        action.sentAt ||
        action.lastUpdatedAt ||
        action.createdAt;
      const engagedAtMs = Date.parse(engagedAt || '');
      const chatJid = resolveBlueBubblesActionPresentationChat(action);
      return chatJid &&
        engagedAt &&
        Number.isFinite(engagedAtMs) &&
        engagedAtMs >= cutoff
        ? { chatJid, engagedAt }
        : null;
    })
    .filter((entry): entry is { chatJid: string; engagedAt: string } =>
      Boolean(entry),
    )
    .sort(
      (left, right) =>
        Date.parse(right.engagedAt || '') - Date.parse(left.engagedAt || ''),
    )[0];

  if (recentProofAction) {
    return recentProofAction;
  }

  const candidate = listRecentPilotJourneyEvents({
    channel: 'bluebubbles',
    limit: 200,
  }).find((event) => {
    const engagedAt = Date.parse(event.completedAt || event.startedAt);
    return (
      event.groupFolder === params.groupFolder &&
      event.chatJid?.startsWith('bb:') === true &&
      (event.outcome === 'success' || event.outcome === 'degraded_usable') &&
      Number.isFinite(engagedAt) &&
      engagedAt >= cutoff
    );
  });

  if (candidate?.chatJid) {
    return {
      chatJid:
        canonicalizeBlueBubblesSelfThreadJid(candidate.chatJid) ||
        candidate.chatJid,
      engagedAt: candidate.completedAt || candidate.startedAt,
    };
  }

  const recentSelfThreadActivity = expandBlueBubblesLogicalSelfThreadJids(
    'bb:iMessage;-;+14695405551',
  )
    .flatMap((chatJid) => listRecentMessagesForChat(chatJid, 8))
    .map((message) => ({
      chatJid:
        canonicalizeBlueBubblesSelfThreadJid(message.chat_jid) ||
        message.chat_jid,
      engagedAt: message.timestamp,
    }))
    .filter((entry) => {
      const engagedAt = Date.parse(entry.engagedAt || '');
      return Number.isFinite(engagedAt) && engagedAt >= cutoff;
    })
    .sort(
      (left, right) =>
        Date.parse(right.engagedAt || '') - Date.parse(left.engagedAt || ''),
    )[0];

  return recentSelfThreadActivity || null;
}
