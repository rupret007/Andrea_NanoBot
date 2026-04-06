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

async function deliverCandidateToTelegram(
  params: AssistantActionCompletionParams,
  candidate: CompanionContinuationCandidate | undefined,
  deps: Partial<CompanionHandoffDeps>,
): Promise<AssistantActionCompletionResult> {
  if (!deps.resolveTelegramMainChat || !deps.sendTelegramMessage) {
    return {
      handled: true,
      replyText:
        'I cannot hand that off to Telegram from this runtime right now.',
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
              rerun.replyText || candidate.voiceSummary || candidate.completionText,
            handoffPayload: rerun.handoffPayload,
            completionText: candidate.completionText,
          }
        : undefined);
    const delivery = await deliverCompanionHandoff(
      {
        groupFolder: params.groupFolder,
        originChannel: 'alexa',
        capabilityId: rerun.capabilityId || candidate.capabilityId,
        voiceSummary:
          rerunCandidate?.voiceSummary ||
          rerun.replyText ||
          candidate.voiceSummary,
        payload:
          rerunCandidate?.handoffPayload || {
            kind: 'message',
            title: 'Andrea follow-up',
            text: rerun.replyText || candidate.voiceSummary,
            followupSuggestions: [],
          },
        threadId: candidate.threadId,
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
      capabilityId: candidate?.capabilityId,
      voiceSummary: candidate?.voiceSummary || summary,
      payload:
        candidate?.handoffPayload || {
          kind: 'message',
          title: 'Andrea follow-up',
          text: summary,
          followupSuggestions: candidate?.followupSuggestions || [],
        },
      threadId: candidate?.threadId,
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
    if (!deps.resolveTelegramMainChat || !deps.sendTelegramMessage) {
      return {
        handled: true,
        replyText:
          'I cannot hand that off to Telegram from this runtime right now.',
      };
    }
    return deliverCandidateToTelegram(params, candidate, deps);
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
      replyText: result.replyText || 'Okay.',
      capabilityResult: result,
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
      replyText: result.responseText || 'Okay.',
      lifeThreadResult: result,
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
      replyText: plannedReminder.confirmation,
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
      replyText: ritualResult.responseText || 'Okay.',
      ritualResult,
    };
  }

  return { handled: false };
}
