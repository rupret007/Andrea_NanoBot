import {
  clearAlexaConversationContext as clearAlexaConversationContextRecord,
  getAlexaConversationContext,
  purgeExpiredAlexaConversationContexts,
  upsertAlexaConversationContext,
} from './db.js';
import {
  type AlexaCompanionGuidanceGoal,
  type AlexaConversationContext,
  type AlexaConversationFollowupAction,
  type AlexaConversationSubjectKind,
  type CompanionToneProfile,
  type PersonalityCooldownState,
} from './types.js';
import type { AssistantCapabilityId } from './assistant-capabilities.js';

export interface AlexaConversationSubjectData {
  lastIntentFamily?: string;
  lastRouteOutcome?: string;
  lastUserUtterance?: string;
  clarifierHints?: string[];
  activeSubjectLabel?: string;
  personName?: string;
  activePeople?: string[];
  householdFocus?: boolean;
  meetingReference?: string;
  profileFactId?: string;
  savedText?: string;
  threadId?: string;
  threadTitle?: string;
  threadSummaryLines?: string[];
  dailyCompanionContextJson?: string;
  fallbackCount?: number;
  lastAnswerSummary?: string;
  lastRecommendation?: string;
  pendingActionText?: string;
  conversationFocus?: string;
  activeCapabilityId?: AssistantCapabilityId;
  researchHandoffEligible?: boolean;
  researchRouteExplanation?: string;
  researchProviderUsed?: import('./research-orchestrator.js').ResearchProviderUsed;
  saveForLaterCandidate?: string;
  knowledgeSourceIds?: string[];
  knowledgeSourceTitles?: string[];
  knowledgeSourceMatches?: string[];
  knowledgeLastQuery?: string;
  communicationThreadId?: string;
  communicationSubjectIds?: string[];
  communicationLifeThreadIds?: string[];
  lastCommunicationSummary?: string;
  chiefOfStaffContextJson?: string;
  missionId?: string;
  missionSummary?: string;
  missionSuggestedActionsJson?: string;
  missionBlockersJson?: string;
  missionStepFocusJson?: string;
  companionContinuationJson?: string;
  actionBundleId?: string;
  actionBundleTitle?: string;
  actionBundleSummary?: string;
  outcomeReviewPromptJson?: string;
  outcomeReviewFocusOutcomeIds?: string[];
  outcomeReviewPrimaryOutcomeId?: string;
  outcomeReviewSummary?: string;
  delegationRulePreviewJson?: string;
  delegationRuleFocusRuleId?: string;
  delegationRuleExplanation?: string;
}

export interface AlexaConversationState {
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  subjectData: AlexaConversationSubjectData;
  summaryText: string;
  supportedFollowups: AlexaConversationFollowupAction[];
  styleHints: {
    responseStyle?: 'default' | 'short_direct' | 'expanded';
    channelMode?: 'alexa_companion';
    guidanceGoal?: AlexaCompanionGuidanceGoal;
    initiativeLevel?: 'measured';
    prioritizationLens?:
      | 'general'
      | 'calendar'
      | 'family'
      | 'meeting'
      | 'work'
      | 'evening';
    hasActionItem?: boolean;
    hasRiskSignal?: boolean;
    reminderCandidate?: boolean;
    responseSource?: 'assistant_bridge' | 'local_companion';
    toneProfile?: CompanionToneProfile;
    personalityCooldown?: PersonalityCooldownState;
  };
}

export interface AlexaConversationFollowupResolution {
  ok: boolean;
  action?: AlexaConversationFollowupAction;
  text?: string;
  speech?: string;
}

const DEFAULT_ALEXA_CONVERSATION_TTL_MS = 10 * 60 * 1000;
const COMPANION_COMPLETION_ACTIONS: AlexaConversationFollowupAction[] = [
  'send_details',
  'save_to_library',
  'track_thread',
  'create_reminder',
  'save_for_later',
  'draft_follow_up',
  'approve_bundle',
  'show_bundle',
  'delegation_control',
  'show_rules',
];

function parseJsonSafe<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseAlexaConversationState(
  record: AlexaConversationContext | undefined,
): AlexaConversationState | undefined {
  if (!record) return undefined;
  return {
    flowKey: record.flowKey,
    subjectKind: record.subjectKind,
    subjectData: parseJsonSafe<AlexaConversationSubjectData>(
      record.subjectJson,
      {},
    ),
    summaryText: record.summaryText,
    supportedFollowups: parseJsonSafe<AlexaConversationFollowupAction[]>(
      record.supportedFollowupsJson,
      [],
    ),
    styleHints: parseJsonSafe<AlexaConversationState['styleHints']>(
      record.styleJson,
      {},
    ),
  };
}

export function loadAlexaConversationState(
  principalKey: string,
  accessTokenHash: string,
  now = new Date().toISOString(),
): AlexaConversationState | undefined {
  purgeExpiredAlexaConversationContexts(now);
  return parseAlexaConversationState(
    getAlexaConversationContext(principalKey, accessTokenHash, now),
  );
}

export function saveAlexaConversationState(
  principalKey: string,
  accessTokenHash: string,
  groupFolder: string,
  state: AlexaConversationState,
  ttlMs = DEFAULT_ALEXA_CONVERSATION_TTL_MS,
  now = new Date(),
): AlexaConversationContext {
  const record: AlexaConversationContext = {
    principalKey,
    accessTokenHash,
    groupFolder,
    flowKey: state.flowKey,
    subjectKind: state.subjectKind,
    subjectJson: JSON.stringify(state.subjectData || {}),
    summaryText: state.summaryText,
    supportedFollowupsJson: JSON.stringify(state.supportedFollowups || []),
    styleJson: JSON.stringify(state.styleHints || {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    updatedAt: now.toISOString(),
  };
  upsertAlexaConversationContext(record);
  return record;
}

export function clearAlexaConversationState(principalKey: string): void {
  clearAlexaConversationContextRecord(principalKey);
}

export function getAlexaConversationReferencedFactId(
  state: AlexaConversationState | undefined,
): string | undefined {
  return state?.subjectData.profileFactId?.trim() || undefined;
}

export function resolveAlexaConversationFollowup(
  rawText: string,
  state: AlexaConversationState | undefined,
): AlexaConversationFollowupResolution {
  const text = rawText.trim();
  const normalized = text.toLowerCase();
  if (!state) {
    return {
      ok: false,
      speech:
        "I am not fully sure what you mean yet. I can help with your plans, open loops, or a reminder. Say it again a little more simply and I'll keep the thread.",
    };
  }

  const supported = new Set(state.supportedFollowups);
  const hasCompanionCompletionContext = Boolean(
    state.subjectData.companionContinuationJson?.trim() ||
    state.subjectData.pendingActionText?.trim() ||
    state.subjectData.lastAnswerSummary?.trim() ||
    state.summaryText?.trim(),
  );
  const resolveSupported = (
    action: AlexaConversationFollowupAction,
    nextText = text,
  ): AlexaConversationFollowupResolution =>
    supported.has(action) ||
    (COMPANION_COMPLETION_ACTIONS.includes(action) &&
      hasCompanionCompletionContext)
      ? { ok: true, action, text: nextText }
      : {
          ok: false,
          speech: state.subjectData.personName
            ? `I am not quite sure which part you mean yet. Is that still about ${state.subjectData.personName}, or something else?`
            : 'I am not quite sure which part you mean yet. Say a little more, or ask it a different way.',
        };

  if (/^(anything else|anything more|what else)\b/i.test(normalized)) {
    return resolveSupported('anything_else');
  }
  if (
    /^(make that shorter|shorter|say that shorter|keep it shorter|make it tighter)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('shorter');
  }
  if (
    /^(say more|tell me more|give me a little more detail|go a little deeper|give me more detail)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('say_more');
  }
  if (
    /^(what('?s| is)? next after that|what next after that|what comes after that|what happens next|after that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('after_that');
  }
  if (
    /^(what should i handle before that|before that|what about before that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('before_that');
  }
  if (/^(remind me before that)\b/i.test(normalized)) {
    return resolveSupported('remind_before_that');
  }
  if (
    /^(send (?:me )?(?:the )?(?:details|fuller version|full version|full comparison|fuller plan|plan)(?: to telegram)?|send (?:that|it) to telegram|also send (?:that|it) to telegram|give me the deeper comparison in telegram|send (?:that|it|this|the details|the plan) to (?:my )?messages|save (?:that|it|this) to (?:my )?messages|send me the details in messages|send me the plan|send me the fuller plan)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('send_details');
  }
  if (/^(send me the full version|send me the fuller version)\b/i.test(normalized)) {
    return resolveSupported('send_details');
  }
  if (/^(do that|do all that|approve all)\b/i.test(normalized)) {
    return resolveSupported('approve_bundle');
  }
  if (
    /^(show me the actions again|show again|what are the actions)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('show_bundle');
  }
  if (
    /^(save (?:that|it|this) for later|remember (?:that|it|this) for later|keep track of (?:that|it|this) for tonight|save the draft)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('save_for_later');
  }
  if (
    /^(save (?:that|it|this) (?:in|to) my library|save (?:that|it|this) to the library)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('save_to_library');
  }
  if (
    /^(save that for later|save that|help me remember that tonight|remember that|remember this)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('save_that');
  }
  if (
    /^(track (?:that|it|this)(?: under .+)?|keep track of (?:that|it|this)(?: under .+)?|save (?:that|it|this) under .+ thread)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('track_thread');
  }
  if (
    /^(turn (?:that|it|this) into a reminder|remind me about (?:that|it|this)(?: tonight)?|save (?:that|it|this) for later tonight|just the reminder|only the reminder|do the reminder)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('create_reminder');
  }
  if (/^(remind me later|remind me about that later)\b/i.test(normalized)) {
    return resolveSupported('create_reminder');
  }
  if (
    /^(what should i do about that|what should i handle about that|what do i do about that|what should i do with that)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('action_guidance');
  }
  if (
    /^(should i be worried about anything|is there anything i should worry about)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('risk_check');
  }
  if (
    /^(draft that for me|draft a message about (?:that|it|this)|draft a follow up for this meeting|draft a follow up)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('draft_follow_up');
  }
  if (
    /^(what should i message someone about|what should i follow up about)\b/i.test(
      normalized,
    )
  ) {
    return supported.has('draft_follow_up') || supported.has('draft_followup')
      ? resolveSupported('draft_follow_up')
      : resolveSupported('action_guidance');
  }
  if (
    /^(what about [a-z][a-z' -]+)\b/i.test(normalized) ||
    /^what about candace\b/i.test(normalized)
  ) {
    return resolveSupported('switch_person');
  }
  if (
    /^(do this automatically next time|remember this as my default|don't ask me every time about that|always ask before doing that|stop doing that automatically|why did that fire)\b/i.test(
      normalized,
    )
  ) {
    return resolveSupported('delegation_control');
  }
  if (/^(yes|save it|remember that default|use that default)\b/i.test(normalized)) {
    return resolveSupported('delegation_control');
  }
  if (/^(show my rules)\b/i.test(normalized)) {
    return resolveSupported('show_rules');
  }
  if (
    /^(forget that|stop using that|what do you remember\b|why\b|why did you say that|what are you using to personalize this|reset that preference|be more direct|be a little more direct|be a bit more direct|don'?t bring that up automatically|stop bringing that up)/i.test(
      normalized,
    )
  ) {
    return resolveSupported('memory_control');
  }

  return {
    ok: false,
    speech: state.subjectData.personName
      ? `I am not fully sure which part you mean yet. You can ask what's still open with ${state.subjectData.personName}, say more, or ask it a different way.`
      : 'I am not fully sure which part you mean yet. You can say anything else, say more, or ask it a different way.',
  };
}
