import { resolveAlexaConversationFollowup } from './alexa-conversation.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
import {
  expandBlueBubblesLogicalSelfThreadJids,
  getBlueBubblesCanonicalSelfThreadJid,
  isConfiguredBlueBubblesSelfThreadAliasJid,
} from './bluebubbles-self-thread.js';
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
  return /(?:^|[\s([{-])@(andrea|openclaw)\b/.test(normalized);
}

function resolveBlueBubblesCompanionConversationKind(
  chatJid: string | null | undefined,
): 'self_thread' | 'data_only' {
  if (isConfiguredBlueBubblesSelfThreadAliasJid(chatJid)) {
    return 'self_thread';
  }
  return 'data_only';
}

export function hasBlueBubblesAndreaMention(text: string): boolean {
  return hasAndreaMention(normalizeText(text));
}

export function stripBlueBubblesAndreaMention(text: string): string {
  return text
    .replace(/(^|[\s([{-])@(andrea|openclaw)\b[,:;!?-]*/gi, '$1')
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
  // Ordinary contact and group conversations are passive Messages data. This
  // helper is a second fence behind the runtime ingress policy: neither an
  // @Andrea token nor stale companion context may turn a real person's thread
  // into an assistant command surface.
  if (conversationKind !== 'self_thread') return false;
  const hasMention = hasBlueBubblesAndreaMention(text);
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

export function shouldPreferBlueBubblesLocalMessageActionFollowup(input: {
  conversationChannel: string;
  requestRoute: string;
  operationRecognized: boolean;
  actionResolved: boolean;
  policyAllows: boolean;
}): boolean {
  return (
    input.conversationChannel === 'bluebubbles' &&
    (input.requestRoute === 'direct_assistant' ||
      input.requestRoute === 'protected_assistant') &&
    input.operationRecognized &&
    input.actionResolved &&
    input.policyAllows
  );
}

export function shouldHandleBlueBubblesProofDrillLocally(input: {
  conversationChannel: string;
  requestRoute: string;
  text: string;
}): boolean {
  return (
    input.conversationChannel === 'bluebubbles' &&
    (input.requestRoute === 'direct_assistant' ||
      input.requestRoute === 'protected_assistant') &&
    isBlueBubblesProofDrillStartRequest(input.text)
  );
}

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
  if (!isConfiguredBlueBubblesSelfThreadAliasJid(input.chatJid)) {
    return null;
  }
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

export function decideBlueBubblesCompanionIngress(
  text: string,
  options: {
    hasRecentCompanionContext?: boolean;
    hasOpenMessageActionFollowup?: boolean;
    pendingLocalContinuationKind?: BlueBubblesPendingLocalContinuationKind | null;
    chatJid?: string | null;
  } = {},
): BlueBubblesCompanionIngressDecision {
  if (!isConfiguredBlueBubblesSelfThreadAliasJid(options.chatJid)) {
    return { kind: 'ignored_chatter' };
  }
  if (options.hasOpenMessageActionFollowup) {
    return {
      kind: 'pending_local_continuation',
      continuationKind: 'action_draft',
    };
  }
  if (
    isBlueBubblesExplicitAsk(text, {
      hasRecentCompanionContext: options.hasRecentCompanionContext,
      chatJid: options.chatJid,
    })
  ) {
    return { kind: 'explicit_ask' };
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
  const canonicalSelfThreadJid = getBlueBubblesCanonicalSelfThreadJid();
  if (!isConfiguredBlueBubblesSelfThreadAliasJid(canonicalSelfThreadJid)) {
    return null;
  }

  // A handoff is assistant content, not a recipient-approved message action.
  // Never inherit its destination from contact/group continuity, pilot history,
  // or whichever external Messages conversation was active most recently.
  return {
    chatJid: canonicalSelfThreadJid,
    engagedAt: now.toISOString(),
  };
}
