import { createTask } from './db.js';
import {
  executeAssistantCapability,
  type AssistantCapabilityContext,
  type AssistantCapabilityResult,
} from './assistant-capabilities.js';
import {
  deliverCompanionHandoff,
  type CompanionHandoffDeps,
  type DeliverCompanionHandoffResult,
} from './cross-channel-handoffs.js';
import {
  handleLifeThreadCommand,
  type LifeThreadCommandResult,
} from './life-threads.js';
import { planContextualReminder } from './local-reminder.js';
import { handleRitualCommand, type RitualCommandResult } from './rituals.js';
import { buildSignaturePostActionConfirmation } from './signature-flows.js';
import type {
  AlexaConversationFollowupAction,
  CompanionContinuationCandidate,
} from './types.js';

export interface AssistantActionCompletionParams {
  groupFolder: string;
  action: AlexaConversationFollowupAction;
  utterance: string;
  conversationSummary?: string;
  priorSubjectData?: AssistantCapabilityContext['priorSubjectData'];
  replyText?: string;
  now?: Date;
}

export interface AssistantActionCompletionResult {
  handled: boolean;
  replyText?: string;
  capabilityResult?: AssistantCapabilityResult;
  lifeThreadResult?: LifeThreadCommandResult;
  ritualResult?: RitualCommandResult;
  reminderTaskId?: string;
  handoffResult?: DeliverCompanionHandoffResult;
  bridgeSaveForLaterText?: string;
  bridgeDraftReference?: string;
}

function resolveRequestedHandoffTarget(
  utterance: string,
): 'telegram' | 'bluebubbles' {
  return /\b(?:my )?messages\b|\bbluebubbles\b/i.test(utterance)
    ? 'bluebubbles'
    : 'telegram';
}

function hasHandoffRuntime(
  deps: Partial<CompanionHandoffDeps>,
  targetChannel: 'telegram' | 'bluebubbles',
): boolean {
  if (deps.resolveHandoffTarget && deps.sendHandoffMessage) {
    return true;
  }
  if (targetChannel === 'bluebubbles') {
    return Boolean(
      deps.resolveBlueBubblesCompanionChat && deps.sendBlueBubblesMessage,
    );
  }
  return Boolean(deps.resolveTelegramMainChat && deps.sendTelegramMessage);
}

function parseContinuationCandidate(
  priorSubjectData: AssistantActionCompletionParams['priorSubjectData'],
): CompanionContinuationCandidate | undefined {
  const raw = priorSubjectData?.companionContinuationJson?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as CompanionContinuationCandidate;
  } catch {
    return undefined;
  }
}

function resolveCompletionText(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
): string {
  return (
    candidate?.completionText?.trim() ||
    params.replyText?.trim() ||
    params.priorSubjectData?.saveForLaterCandidate?.trim() ||
    params.priorSubjectData?.lastAnswerSummary?.trim() ||
    params.conversationSummary?.trim() ||
    ''
  );
}

function extractTrackThreadTitle(
  utterance: string,
  candidate: CompanionContinuationCandidate | undefined,
): string | undefined {
  const explicit = utterance.match(
    /\bunder (?:the )?(.+?)(?: thread)?[.!?]*$/i,
  )?.[1];
  if (explicit?.trim()) return explicit.trim();
  return candidate?.threadTitle?.trim() || undefined;
}

function extractReminderTiming(utterance: string): string | undefined {
  const match =
    utterance.match(
      /\b(today at \d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow(?: morning| afternoon| evening)?|tonight|before i leave)\b/i,
    )?.[1] ||
    utterance.match(
      /\b(today morning|today afternoon|today evening|tomorrow morning|tomorrow afternoon|tomorrow evening)\b/i,
    )?.[1];
  const normalized = match?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'tonight') return 'today evening';
  return normalized;
}

function clipReference(value: string, max = 80): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

function hasTonightCarryoverIntent(utterance: string): boolean {
  return /\b(for tonight|tonight|this evening)\b/i.test(utterance);
}

function resolveThreadHint(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
): string | undefined {
  return (
    extractTrackThreadTitle(params.utterance, candidate) ||
    candidate?.threadTitle?.trim() ||
    params.priorSubjectData?.threadTitle?.trim() ||
    params.priorSubjectData?.personName?.trim() ||
    undefined
  );
}

function resolveOpenLoopText(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
  completionText: string,
): string | undefined {
  return (
    candidate?.missionSummary?.trim() ||
    params.priorSubjectData?.missionSummary?.trim() ||
    candidate?.lastCommunicationSummary?.trim() ||
    params.priorSubjectData?.lastCommunicationSummary?.trim() ||
    resolveThreadHint(params, candidate)?.trim() ||
    (completionText ? clipReference(completionText, 120) : undefined)
  );
}

function resolveNextSuggestion(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
): string | undefined {
  if (candidate?.missionId || params.priorSubjectData?.missionId) {
    return 'ask what happens next or have me turn the next step into a reminder';
  }
  if (
    candidate?.communicationThreadId ||
    candidate?.lastCommunicationSummary ||
    params.priorSubjectData?.communicationThreadId ||
    params.priorSubjectData?.lastCommunicationSummary
  ) {
    return 'draft the reply or remind yourself later';
  }
  if (candidate?.handoffPayload) {
    return 'send the fuller version in text';
  }
  return 'save it for later or turn it into a reminder';
}

function resolveDraftReference(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
  completionText: string,
): string | undefined {
  const aboutMatch = params.utterance.match(
    /\bdraft (?:a message|that|it|this) about (.+?)[.!?]*$/i,
  )?.[1];
  if (aboutMatch?.trim()) return clipReference(aboutMatch);

  const forMatch = params.utterance.match(
    /\bdraft (?:that|it|this|a follow up) for (.+?)[.!?]*$/i,
  )?.[1];
  if (forMatch?.trim() && !/^me$/i.test(forMatch.trim())) {
    return clipReference(forMatch);
  }

  return (
    candidate?.threadTitle?.trim() ||
    params.priorSubjectData?.threadTitle?.trim() ||
    params.priorSubjectData?.personName?.trim() ||
    params.conversationSummary?.trim() ||
    candidate?.voiceSummary?.trim() ||
    (completionText ? clipReference(completionText) : undefined)
  );
}

function completeEveningCarryover(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
  completionText: string,
): AssistantActionCompletionResult {
  const now = params.now;
  const threadTitle = resolveThreadHint(params, candidate);
  if (threadTitle) {
    const lifeThreadResult = handleLifeThreadCommand({
      groupFolder: params.groupFolder,
      channel: 'alexa',
      text: `track this under ${threadTitle} thread`,
      replyText: completionText,
      conversationSummary: params.conversationSummary,
      now,
    });
    if (lifeThreadResult.handled && lifeThreadResult.referencedThread) {
      const ritualResult = handleRitualCommand({
        groupFolder: params.groupFolder,
        channel: 'alexa',
        text: 'make this part of my evening reset',
        replyText: completionText,
        conversationSummary: params.conversationSummary,
        priorContext: {
          usedThreadIds: [lifeThreadResult.referencedThread.id],
        },
        now,
      });
      if (ritualResult.handled) {
        return {
          handled: true,
          replyText: buildSignaturePostActionConfirmation({
            channel: 'alexa',
            didWhat:
              ritualResult.responseText ||
              lifeThreadResult.responseText ||
              'Okay.',
            stillOpen: resolveOpenLoopText(params, candidate, completionText),
            nextSuggestion: 'check your evening reset when you want the fuller list',
          }),
          lifeThreadResult,
          ritualResult,
        };
      }
      return {
        handled: true,
        replyText: buildSignaturePostActionConfirmation({
          channel: 'alexa',
          didWhat: lifeThreadResult.responseText || 'Okay.',
          stillOpen: resolveOpenLoopText(params, candidate, completionText),
          nextSuggestion: 'check your evening reset when you want the fuller list',
        }),
        lifeThreadResult,
      };
    }
  }

  const savedThread = handleLifeThreadCommand({
    groupFolder: params.groupFolder,
    channel: 'alexa',
    text: "don't let me forget this tonight",
    replyText: completionText,
    conversationSummary: params.conversationSummary,
    now,
  });
  if (savedThread.handled) {
    return {
      handled: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: 'alexa',
        didWhat: savedThread.responseText || 'Okay.',
        stillOpen: resolveOpenLoopText(params, candidate, completionText),
        nextSuggestion: 'turn it into a reminder if you want a time anchor',
      }),
      lifeThreadResult: savedThread,
    };
  }

  return {
    handled: true,
    replyText: 'Tell me what you want me to keep in view tonight first.',
  };
}

async function deliverCandidateToChannel(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
  deps: Partial<CompanionHandoffDeps>,
): Promise<AssistantActionCompletionResult> {
  const targetChannel = resolveRequestedHandoffTarget(params.utterance);
  if (!hasHandoffRuntime(deps, targetChannel)) {
    return {
      handled: true,
      replyText:
        targetChannel === 'bluebubbles'
          ? 'I cannot send that to your messages from this runtime right now.'
          : 'I cannot hand that off to Telegram from this runtime right now.',
    };
  }
  const summary = resolveCompletionText(params, candidate);
  if (!candidate?.handoffPayload && !summary) {
    return {
      handled: true,
      replyText:
        'I do not have a fuller version of that ready to send yet. Ask me again after I answer something specific.',
    };
  }

  if (
    candidate?.capabilityId === 'media.image_generate' &&
    candidate.completionText?.trim() &&
    !candidate.handoffPayload?.artifact
  ) {
    if (targetChannel === 'bluebubbles') {
      return {
        handled: true,
        replyText: 'I can only deliver images on Telegram right now.',
      };
    }
    const rerun = await executeAssistantCapability({
      capabilityId: 'media.image_generate',
      context: {
        channel: 'telegram',
        groupFolder: params.groupFolder,
        conversationSummary: params.conversationSummary,
        priorSubjectData: params.priorSubjectData,
        now: params.now,
      },
      input: {
        text: candidate.completionText,
        canonicalText: candidate.completionText,
      },
    });
    if (!rerun.handled) {
      return {
        handled: true,
        replyText: 'I could not prepare that Telegram handoff just now.',
      };
    }
    const rerunCandidate =
      rerun.continuationCandidate ||
      (rerun.handoffPayload
        ? {
            capabilityId: rerun.capabilityId,
            voiceSummary:
              rerun.replyText ||
              candidate.voiceSummary ||
              candidate.completionText,
            handoffPayload: rerun.handoffPayload,
            completionText: candidate.completionText,
          }
        : undefined);
    const delivery = await deliverCompanionHandoff(
      {
        groupFolder: params.groupFolder,
        originChannel: 'alexa',
        targetChannel,
        capabilityId: rerun.capabilityId || candidate.capabilityId,
        voiceSummary:
          rerunCandidate?.voiceSummary ||
          rerun.replyText ||
          candidate.voiceSummary,
        payload: rerunCandidate?.handoffPayload || {
          kind: 'message',
          title: 'Andrea follow-up',
          text: rerun.replyText || candidate.voiceSummary,
          followupSuggestions: [],
        },
        threadId: candidate.threadId,
        communicationThreadId: candidate.communicationThreadId,
        communicationSubjectIds: candidate.communicationSubjectIds,
        communicationLifeThreadIds: candidate.communicationLifeThreadIds,
        lastCommunicationSummary: candidate.lastCommunicationSummary,
        missionId: candidate.missionId,
        missionSummary: candidate.missionSummary,
        missionSuggestedActionsJson: candidate.missionSuggestedActionsJson,
        missionBlockersJson: candidate.missionBlockersJson,
        missionStepFocusJson: candidate.missionStepFocusJson,
        knowledgeSourceIds: candidate.knowledgeSourceIds,
        followupSuggestions: rerunCandidate?.followupSuggestions,
      },
      deps as CompanionHandoffDeps,
    );
    return {
      handled: true,
      replyText: delivery.speech,
      capabilityResult: rerun,
      handoffResult: delivery,
    };
  }

  const delivery = await deliverCompanionHandoff(
    {
      groupFolder: params.groupFolder,
      originChannel: 'alexa',
      targetChannel,
      capabilityId: candidate?.capabilityId,
      voiceSummary: candidate?.voiceSummary || summary,
      payload: candidate?.handoffPayload || {
        kind: 'message',
        title: 'Andrea follow-up',
        text: summary,
        followupSuggestions: candidate?.followupSuggestions || [],
      },
      threadId: candidate?.threadId,
      communicationThreadId: candidate?.communicationThreadId,
      communicationSubjectIds: candidate?.communicationSubjectIds,
      communicationLifeThreadIds: candidate?.communicationLifeThreadIds,
      lastCommunicationSummary: candidate?.lastCommunicationSummary,
      missionId: candidate?.missionId,
      missionSummary: candidate?.missionSummary,
      missionSuggestedActionsJson: candidate?.missionSuggestedActionsJson,
      missionBlockersJson: candidate?.missionBlockersJson,
      missionStepFocusJson: candidate?.missionStepFocusJson,
      knowledgeSourceIds: candidate?.knowledgeSourceIds,
      followupSuggestions: candidate?.followupSuggestions,
    },
    deps as CompanionHandoffDeps,
  );
  return {
    handled: true,
    replyText: delivery.speech,
    handoffResult: delivery,
  };
}

export async function completeAssistantActionFromAlexa(
  params: AssistantActionCompletionParams,
  deps: Partial<CompanionHandoffDeps> = {},
): Promise<AssistantActionCompletionResult> {
  const candidate = parseContinuationCandidate(params.priorSubjectData);
  const completionText = resolveCompletionText(params, candidate);

  if (params.action === 'send_details') {
    const targetChannel = resolveRequestedHandoffTarget(params.utterance);
    if (!hasHandoffRuntime(deps, targetChannel)) {
      return {
        handled: true,
        replyText:
          targetChannel === 'bluebubbles'
            ? 'I cannot send that to your messages from this runtime right now.'
            : 'I cannot hand that off to Telegram from this runtime right now.',
      };
    }
    return deliverCandidateToChannel(params, candidate, deps);
  }

  if (params.action === 'save_to_library') {
    if (!completionText) {
      return {
        handled: true,
        replyText: 'Tell me what you want saved first.',
      };
    }
    const result = await executeAssistantCapability({
      capabilityId: 'knowledge.save_source',
      context: {
        channel: 'alexa',
        groupFolder: params.groupFolder,
        conversationSummary: params.conversationSummary,
        priorSubjectData: params.priorSubjectData,
        replyText: completionText,
        now: params.now,
      },
      input: {
        text: params.utterance,
        canonicalText: params.utterance,
      },
    });
    return {
      handled: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: 'alexa',
        didWhat: result.replyText || 'Okay.',
        stillOpen: resolveOpenLoopText(params, candidate, completionText),
        nextSuggestion: resolveNextSuggestion(params, candidate),
      }),
      capabilityResult: result,
    };
  }

  if (params.action === 'save_for_later') {
    if (!completionText) {
      return {
        handled: true,
        replyText: 'Tell me what you want saved first.',
      };
    }
    if (hasTonightCarryoverIntent(params.utterance)) {
      return completeEveningCarryover(params, candidate, completionText);
    }
    return {
      handled: true,
      bridgeSaveForLaterText: completionText,
    };
  }

  if (params.action === 'track_thread') {
    if (!completionText) {
      return {
        handled: true,
        replyText: 'Tell me what you want tracked first.',
      };
    }
    const threadTitle = extractTrackThreadTitle(params.utterance, candidate);
    const text = threadTitle
      ? `track this under ${threadTitle} thread`
      : 'save this for later';
    const result = handleLifeThreadCommand({
      groupFolder: params.groupFolder,
      channel: 'alexa',
      text,
      replyText: completionText,
      conversationSummary: params.conversationSummary,
      now: params.now,
    });
    return {
      handled: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: 'alexa',
        didWhat: result.responseText || 'Okay.',
        stillOpen: resolveOpenLoopText(params, candidate, completionText),
        nextSuggestion: resolveNextSuggestion(params, candidate),
      }),
      lifeThreadResult: result,
    };
  }

  if (params.action === 'draft_follow_up') {
    const draftReference = resolveDraftReference(
      params,
      candidate,
      completionText,
    );
    if (!draftReference) {
      return {
        handled: true,
        replyText: 'Tell me what you want me to draft first.',
      };
    }
    return {
      handled: true,
      bridgeDraftReference: draftReference,
    };
  }

  if (params.action === 'create_reminder') {
    if (!completionText) {
      return {
        handled: true,
        replyText: 'Tell me what you want reminded about first.',
      };
    }
    const timing = extractReminderTiming(params.utterance);
    if (!timing) {
      return {
        handled: true,
        replyText:
          'Tell me when, like tonight or tomorrow morning, and I can turn that into a reminder.',
      };
    }
    if (!deps.resolveTelegramMainChat) {
      return {
        handled: true,
        replyText:
          'I cannot route reminders from this Alexa runtime right now.',
      };
    }
    const target = deps.resolveTelegramMainChat(params.groupFolder);
    if (!target?.chatJid) {
      return {
        handled: true,
        replyText:
          'I do not have a main Telegram chat set up for reminders on this account yet.',
      };
    }
    const plannedReminder = planContextualReminder(
      timing,
      completionText,
      params.groupFolder,
      target.chatJid,
      params.now,
    );
    if (!plannedReminder) {
      return {
        handled: true,
        replyText:
          'Tell me when, like tonight or tomorrow morning, and I can turn that into a reminder.',
      };
    }
    createTask(plannedReminder.task);
    return {
      handled: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: 'alexa',
        didWhat: plannedReminder.confirmation,
        stillOpen: resolveOpenLoopText(params, candidate, completionText),
        nextSuggestion: resolveNextSuggestion(params, candidate),
      }),
      reminderTaskId: plannedReminder.task.id,
    };
  }

  const ritualResult = handleRitualCommand({
    groupFolder: params.groupFolder,
    channel: 'alexa',
    text: params.utterance,
    replyText: completionText || params.replyText,
    conversationSummary: params.conversationSummary,
    now: params.now,
  });
  if (ritualResult.handled) {
    return {
      handled: true,
      replyText: buildSignaturePostActionConfirmation({
        channel: 'alexa',
        didWhat: ritualResult.responseText || 'Okay.',
        stillOpen: resolveOpenLoopText(
          params,
          candidate,
          completionText || params.replyText || '',
        ),
        nextSuggestion: resolveNextSuggestion(params, candidate),
      }),
      ritualResult,
    };
  }

  return { handled: false };
}
