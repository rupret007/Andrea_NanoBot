import { resolveAlexaConversationFollowup } from './alexa-conversation.js';
import { matchAssistantCapabilityRequest } from './assistant-capability-router.js';
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
  } = {},
): boolean {
  if (!hasBlueBubblesAndreaMention(text)) return false;
  if (matchAssistantCapabilityRequest(text)) return true;
  if (resolveOrdinaryChatPilotJourney(text)) return true;
  if (
    options.hasRecentCompanionContext &&
    resolveAlexaConversationFollowup(text, BLUEBUBBLES_FOLLOWUP_STATE).ok
  ) {
    return true;
  }
  return true;
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
