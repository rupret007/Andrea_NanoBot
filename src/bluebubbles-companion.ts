import { resolveAlexaConversationFollowup } from './alexa-conversation.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  expandBlueBubblesLogicalSelfThreadJids,
  isBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
import { listRecentPilotJourneyEvents } from './db.js';
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

export function isBlueBubblesExplicitAsk(
  text: string,
  options: {
    hasRecentCompanionContext?: boolean;
    chatJid?: string | null;
  } = {},
): boolean {
  const directSelfThread = isBlueBubblesSelfThreadAliasJid(options.chatJid);
  const hasMention = hasBlueBubblesAndreaMention(text);
  if (!hasMention && !directSelfThread) return false;
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

  if (candidateChatJids.some((chatJid) => input.hasGoogleCalendarCreate(chatJid))) {
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
  if (candidateChatJids.some((chatJid) => input.hasCalendarAutomation(chatJid))) {
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
  const cutoff = now.getTime() - Math.max(1, params.maxAgeHours || 12) * 60 * 60 * 1000;

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

  if (!candidate?.chatJid) return null;
  return {
    chatJid: candidate.chatJid,
    engagedAt: candidate.completedAt || candidate.startedAt,
  };
}
