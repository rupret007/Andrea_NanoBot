import {
  buildAndreaPulseReply,
  getDefaultPulsePreference,
} from './andrea-pulse.js';
import {
  buildDailyCompanionResponse,
  type DailyCompanionContext,
  type DailyCompanionResponse,
} from './daily-companion.js';
import { getAllTasks, listProfileFactsForGroup } from './db.js';
import {
  buildLifeThreadSnapshot,
  handleLifeThreadCommand,
  type LifeThreadCommandResult,
} from './life-threads.js';
import {
  handlePersonalizationCommand,
  type PersonalizationCommandResult,
} from './assistant-personalization.js';
import { resolveCompanionToneProfileFromFacts } from './companion-personality.js';
import {
  isResearchPrompt,
  runResearchOrchestrator,
  type ResearchSupportingSource,
  type ResearchResult,
} from './research-orchestrator.js';
import { runImageGeneration } from './media-generation.js';
import {
  deleteKnowledgeSourceById,
  extractKnowledgeTopicQuery,
  disableKnowledgeSourceById,
  importKnowledgeFile,
  reindexKnowledgeSourceById,
  resolveKnowledgeSourceSelection,
  saveKnowledgeSource,
  searchKnowledgeLibrary,
} from './knowledge-library.js';
import { handleRitualCommand } from './rituals.js';
import type {
  AlexaCompanionGuidanceGoal,
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  CompanionContinuationCandidate,
  CompanionHandoffPayload,
  CompanionToneProfile,
  KnowledgeSourceRecord,
  MediaGenerationResult,
} from './types.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export type AssistantCapabilityId =
  | 'daily.morning_brief'
  | 'daily.whats_next'
  | 'daily.loose_ends'
  | 'daily.evening_reset'
  | 'household.candace_upcoming'
  | 'household.family_open_loops'
  | 'followthrough.remind_before_anchor'
  | 'followthrough.save_for_later'
  | 'followthrough.draft_follow_up'
  | 'threads.list_open'
  | 'threads.explicit_lookup'
  | 'memory.explain'
  | 'memory.remember'
  | 'memory.forget'
  | 'memory.manual_only'
  | 'pulse.interesting_thing'
  | 'pulse.surprise_me'
  | 'rituals.status'
  | 'rituals.configure'
  | 'rituals.followthrough'
  | 'knowledge.save_source'
  | 'knowledge.list_sources'
  | 'knowledge.summarize_saved'
  | 'knowledge.compare_saved'
  | 'knowledge.explain_sources'
  | 'knowledge.disable_source'
  | 'knowledge.delete_source'
  | 'knowledge.reindex_source'
  | 'research.topic'
  | 'research.compare'
  | 'research.summarize'
  | 'research.recommend'
  | 'work.current_summary'
  | 'work.current_output'
  | 'work.current_logs'
  | 'media.image_generate'
  | 'media.image_edit'
  | 'media.video_generate';

export type AssistantCapabilityCategory =
  | 'daily'
  | 'household'
  | 'followthrough'
  | 'threads'
  | 'memory'
  | 'pulse'
  | 'rituals'
  | 'knowledge'
  | 'research'
  | 'work'
  | 'media';

export type AssistantCapabilityOutputShape =
  | 'voice_brief'
  | 'chat_brief'
  | 'chat_rich'
  | 'handoff_offer'
  | 'artifact_only';

export type AssistantCapabilityHandlerKind =
  | 'local'
  | 'research'
  | 'backend_lane'
  | 'edge_only';

export interface AssistantCapabilityContext {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  groupFolder?: string;
  chatJid?: string;
  now?: Date;
  conversationSummary?: string;
  priorCompanionContext?: DailyCompanionContext | null;
  replyText?: string;
  factIdHint?: string;
  threadHint?: string;
  priorSubjectData?: {
    lastAnswerSummary?: string;
    lastRecommendation?: string;
    conversationFocus?: string;
    threadTitle?: string;
    personName?: string;
    researchRouteExplanation?: string;
    researchProviderUsed?: ResearchResult['providerUsed'];
    saveForLaterCandidate?: string;
    knowledgeSourceIds?: string[];
    knowledgeSourceTitles?: string[];
    knowledgeSourceMatches?: string[];
    knowledgeLastQuery?: string;
    activeCapabilityId?: AssistantCapabilityId;
    companionContinuationJson?: string;
  };
}

export interface AssistantCapabilityInput {
  text?: string;
  canonicalText?: string;
  personName?: string;
  followupAction?: AlexaConversationFollowupAction;
  reason?: string;
}

export interface AssistantCapabilityTrace {
  capabilityId: AssistantCapabilityId;
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  handlerKind: AssistantCapabilityHandlerKind;
  responseSource:
    | 'local_companion'
    | 'life_thread_local'
    | 'memory_local'
    | 'pulse_local'
    | 'knowledge_library'
    | 'research_local'
    | 'research_openai'
    | 'research_handoff'
    | 'media_openai'
    | 'media_handoff'
    | 'edge_only'
    | 'unavailable';
  reason: string;
  notes: string[];
}

export interface AssistantCapabilityConversationSeed {
  flowKey: string;
  subjectKind: AlexaConversationSubjectKind;
  summaryText: string;
  guidanceGoal: AlexaCompanionGuidanceGoal;
  subjectData?: {
    personName?: string;
    activePeople?: string[];
    householdFocus?: boolean;
    threadId?: string;
    threadTitle?: string;
    threadSummaryLines?: string[];
    lastAnswerSummary?: string;
    lastRecommendation?: string;
    pendingActionText?: string;
    conversationFocus?: string;
    fallbackCount?: number;
    dailyCompanionContextJson?: string;
    profileFactId?: string;
    activeCapabilityId?: AssistantCapabilityId;
    researchHandoffEligible?: boolean;
    researchRouteExplanation?: string;
    researchProviderUsed?: ResearchResult['providerUsed'];
    saveForLaterCandidate?: string;
    knowledgeSourceIds?: string[];
    knowledgeSourceTitles?: string[];
    knowledgeSourceMatches?: string[];
    knowledgeLastQuery?: string;
    toneProfile?: CompanionToneProfile;
    companionContinuationJson?: string;
  };
  supportedFollowups?: AlexaConversationFollowupAction[];
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
  responseStyle?: 'default' | 'short_direct' | 'expanded';
  responseSource?: 'assistant_bridge' | 'local_companion';
}

export interface AssistantCapabilityResult {
  handled: boolean;
  capabilityId?: AssistantCapabilityId;
  replyText?: string;
  outputShape?: AssistantCapabilityOutputShape;
  trace?: AssistantCapabilityTrace;
  dailyResponse?: DailyCompanionResponse;
  lifeThreadResult?: LifeThreadCommandResult;
  personalizationResult?: PersonalizationCommandResult;
  researchResult?: ResearchResult;
  mediaResult?: MediaGenerationResult;
  conversationSeed?: AssistantCapabilityConversationSeed;
  handoffOffer?: string;
  followupActions?: AlexaConversationFollowupAction[];
  handoffPayload?: CompanionHandoffPayload;
  continuationCandidate?: CompanionContinuationCandidate;
}

export interface AssistantCapabilityDescriptor {
  id: AssistantCapabilityId;
  label: string;
  category: AssistantCapabilityCategory;
  requiredInputs: string[];
  optionalInputs: string[];
  requiresLinkedAccount: boolean;
  requiresConfirmation: boolean;
  safeForAlexa: boolean;
  safeForTelegram: boolean;
  safeForBlueBubbles: boolean;
  operatorOnly: boolean;
  preferredOutputShape: {
    alexa: AssistantCapabilityOutputShape;
    telegram: AssistantCapabilityOutputShape;
    bluebubbles: AssistantCapabilityOutputShape;
  };
  followupActions: AlexaConversationFollowupAction[];
  handlerKind: AssistantCapabilityHandlerKind;
  availabilityNote?: string;
  execute?: (
    context: AssistantCapabilityContext,
    input: AssistantCapabilityInput,
  ) => Promise<AssistantCapabilityResult>;
}

function normalizeText(value: string | undefined): string {
  return normalizeVoicePrompt(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildCapabilityTrace(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  responseSource: AssistantCapabilityTrace['responseSource'],
  reason: string,
  notes: string[] = [],
): AssistantCapabilityTrace {
  return {
    capabilityId: descriptor.id,
    channel: context.channel,
    handlerKind: descriptor.handlerKind,
    responseSource,
    reason,
    notes,
  };
}

function buildCompanionMessagePayload(
  title: string,
  text: string,
  followupSuggestions: string[] = [],
  sourceSummary?: string,
): CompanionHandoffPayload {
  return {
    kind: 'message',
    title: normalizeText(title) || 'Andrea follow-up',
    text: text.trim(),
    sourceSummary: sourceSummary?.trim() || undefined,
    followupSuggestions: followupSuggestions.filter(Boolean).slice(0, 3),
  };
}

function serializeCompanionContinuation(
  candidate: CompanionContinuationCandidate | undefined,
): string | undefined {
  return candidate ? JSON.stringify(candidate) : undefined;
}

function buildDailyContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  response: DailyCompanionResponse,
): CompanionContinuationCandidate {
  const title =
    response.context.usedThreadTitles?.[0] ||
    response.context.subjectData.personName ||
    descriptor.label;
  return {
    capabilityId: descriptor.id,
    voiceSummary: response.context.summaryText,
    handoffPayload: buildCompanionMessagePayload(
      title,
      response.context.extendedText || response.reply,
      [],
      `Using ${response.context.signalsUsed.join(', ')}`,
    ),
    completionText:
      response.context.recommendationText ||
      response.context.extendedText ||
      response.context.summaryText,
    threadId: response.context.usedThreadIds?.[0],
    threadTitle: response.context.usedThreadTitles?.[0],
    followupSuggestions: [],
  };
}

function extendCompanionFollowups(
  followups: AlexaConversationFollowupAction[] | undefined,
  candidate: CompanionContinuationCandidate | undefined,
): AlexaConversationFollowupAction[] {
  const next = new Set<AlexaConversationFollowupAction>(followups || []);
  if (candidate?.handoffPayload) {
    next.add('send_details');
  }
  if (candidate?.completionText?.trim()) {
    next.add('save_to_library');
    next.add('track_thread');
    next.add('create_reminder');
    next.add('save_for_later');
    next.add('draft_follow_up');
  }
  return [...next];
}

function getToneProfileForContext(
  context: AssistantCapabilityContext,
): CompanionToneProfile {
  if (!context.groupFolder) return 'balanced';
  return resolveCompanionToneProfileFromFacts(
    listProfileFactsForGroup(context.groupFolder, ['accepted']),
  );
}

function cloneContext(
  context: AssistantCapabilityContext,
): AssistantCapabilityContext {
  return {
    ...context,
    priorCompanionContext: context.priorCompanionContext || null,
  };
}

function buildDailySeed(
  id: AssistantCapabilityId,
  flowKey: string,
  summaryText: string,
  guidanceGoal: AlexaCompanionGuidanceGoal,
  defaults: Partial<AssistantCapabilityConversationSeed> = {},
): AssistantCapabilityConversationSeed {
  return {
    flowKey,
    subjectKind: defaults.subjectKind || 'day_brief',
    summaryText,
    guidanceGoal,
    subjectData: {
      activeCapabilityId: id,
      fallbackCount: 0,
      ...(defaults.subjectData || {}),
    },
    supportedFollowups: defaults.supportedFollowups,
    prioritizationLens: defaults.prioritizationLens || 'general',
    hasActionItem: defaults.hasActionItem,
    hasRiskSignal: defaults.hasRiskSignal,
    reminderCandidate: defaults.reminderCandidate,
    responseSource: defaults.responseSource || 'local_companion',
  };
}

async function runDailyCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
  canonicalPrompt: string,
  seed: AssistantCapabilityConversationSeed,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const response = await buildDailyCompanionResponse(
    input.canonicalText || canonicalPrompt,
    {
      channel: context.channel,
      groupFolder: context.groupFolder,
      tasks: getAllTasks().filter(
        (task) => task.group_folder === context.groupFolder,
      ),
      priorContext: context.priorCompanionContext || null,
      now: context.now,
    },
  );
  if (!response) return { handled: false };
  const continuationCandidate = buildDailyContinuationCandidate(
    descriptor,
    response,
  );
  const supportedFollowups = extendCompanionFollowups(
    response.context.supportedFollowups,
    continuationCandidate,
  );
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: response.reply,
    outputShape: descriptor.preferredOutputShape[context.channel],
    dailyResponse: response,
    conversationSeed: {
      ...seed,
      subjectKind: response.context.subjectKind,
      summaryText: response.context.summaryText,
      supportedFollowups,
      subjectData: {
        ...seed.subjectData,
        ...response.context.subjectData,
        activeCapabilityId: descriptor.id,
        threadId: response.context.usedThreadIds?.[0],
        threadTitle: response.context.usedThreadTitles?.[0],
        threadSummaryLines: response.context.threadSummaryLines || [],
        lastAnswerSummary: response.context.summaryText,
        lastRecommendation: response.context.recommendationText || undefined,
        pendingActionText: response.context.recommendationText || undefined,
        conversationFocus:
          response.context.usedThreadTitles?.[0] ||
          response.context.subjectData.personName ||
          response.context.subjectKind,
        dailyCompanionContextJson: JSON.stringify(response.context),
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      `handled by daily companion using "${input.canonicalText || canonicalPrompt}"`,
      response.context.usedThreadTitles?.length
        ? [`threads: ${response.context.usedThreadTitles.join(', ')}`]
        : [],
    ),
    followupActions: supportedFollowups,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
  };
}

async function runLifeThreadCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = handleLifeThreadCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    text: input.canonicalText || input.text || '',
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorContext: context.priorCompanionContext || null,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    lifeThreadResult: result,
    conversationSeed: result.referencedThread
      ? {
          flowKey: descriptor.id.replace(/\./g, '_'),
          subjectKind: 'life_thread',
          summaryText: result.responseText || result.referencedThread.title,
          guidanceGoal: 'life_thread_guidance',
          subjectData: {
            activeCapabilityId: descriptor.id,
            fallbackCount: 0,
            threadId: result.referencedThread.id,
            threadTitle: result.referencedThread.title,
            threadSummaryLines: [
              result.referencedThread.nextAction ||
                result.referencedThread.summary,
            ],
            conversationFocus: result.referencedThread.title,
          },
          supportedFollowups: descriptor.followupActions,
          prioritizationLens:
            result.referencedThread.scope === 'household' ||
            result.referencedThread.scope === 'family'
              ? 'family'
              : 'general',
          responseSource: 'local_companion',
        }
      : undefined,
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'life_thread_local',
      'handled by life-thread command layer',
    ),
    followupActions: descriptor.followupActions,
  };
}

async function runMemoryCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = handlePersonalizationCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    text: input.canonicalText || input.text || '',
    conversationSummary: context.conversationSummary,
    replyText: context.replyText,
    factIdHint: context.factIdHint,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    personalizationResult: result,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'memory_fact',
      summaryText: result.responseText || descriptor.label,
      guidanceGoal: 'explainability',
      subjectData: {
        activeCapabilityId: descriptor.id,
        profileFactId: result.referencedFactId,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'memory_local',
      'handled by personalization layer',
    ),
  };
}

async function runRitualControlCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const result = handleRitualCommand({
    groupFolder: context.groupFolder,
    channel: context.channel,
    chatJid: context.chatJid,
    text: input.canonicalText || input.text || '',
    replyText: context.replyText,
    conversationSummary: context.conversationSummary,
    priorCompanionMode: context.priorCompanionContext?.mode,
    priorContext: context.priorCompanionContext
      ? {
          usedThreadIds: context.priorCompanionContext.usedThreadIds,
        }
      : null,
    now: context.now,
  });
  if (!result.handled) return { handled: false };
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.responseText || 'Okay.',
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'local_companion',
      'handled by ritual control layer',
    ),
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.responseText || descriptor.label,
      guidanceGoal: 'explainability',
      subjectData: {
        activeCapabilityId: descriptor.id,
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
  };
}

async function runRitualFollowthroughCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const canonicalText =
    input.canonicalText || input.text || 'what should I follow up on';
  const dailyResponse = await buildDailyCompanionResponse(canonicalText, {
    channel: context.channel,
    groupFolder: context.groupFolder,
    tasks: getAllTasks().filter(
      (task) => task.group_folder === context.groupFolder,
    ),
    priorContext: context.priorCompanionContext || null,
    now: context.now,
  });
  const threadSnapshot = buildLifeThreadSnapshot({
    groupFolder: context.groupFolder,
    now: context.now,
  });
  const followthroughLines = (
    threadSnapshot.dueFollowups.length
      ? threadSnapshot.dueFollowups
      : threadSnapshot.activeThreads
  )
    .slice(0, context.channel === 'telegram' ? 3 : 2)
    .map((thread) => thread.nextAction || thread.summary || thread.title)
    .filter((line): line is string => Boolean(line));

  if (dailyResponse) {
    const continuationCandidate = buildDailyContinuationCandidate(
      descriptor,
      dailyResponse,
    );
    const supportedFollowups = extendCompanionFollowups(
      dailyResponse.context.supportedFollowups,
      continuationCandidate,
    );
    const replyText =
      context.channel === 'alexa'
        ? dailyResponse.reply
        : [
            dailyResponse.reply,
            followthroughLines.length > 1
              ? '\nStill open right now:'
              : followthroughLines.length === 1
                ? '\nStill open right now:'
                : null,
            ...followthroughLines.map((line) => `- ${line}`),
          ]
            .filter(Boolean)
            .join('\n');
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      dailyResponse,
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: dailyResponse.context.subjectKind,
        summaryText: dailyResponse.context.summaryText,
        guidanceGoal: 'action_follow_through',
        subjectData: {
          ...dailyResponse.context.subjectData,
          activeCapabilityId: descriptor.id,
          threadId: dailyResponse.context.usedThreadIds?.[0],
          threadTitle: dailyResponse.context.usedThreadTitles?.[0],
          threadSummaryLines: dailyResponse.context.threadSummaryLines || [],
          lastAnswerSummary: dailyResponse.context.summaryText,
          lastRecommendation: dailyResponse.context.recommendationText || undefined,
          conversationFocus:
            dailyResponse.context.usedThreadTitles?.[0] ||
            dailyResponse.context.subjectKind,
          dailyCompanionContextJson: JSON.stringify(dailyResponse.context),
          companionContinuationJson: serializeCompanionContinuation(
            continuationCandidate,
          ),
        },
        supportedFollowups,
        responseSource: 'local_companion',
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'local_companion',
        'handled by ritual follow-through layer',
        followthroughLines.length
          ? [`follow-through: ${followthroughLines.join(' | ')}`]
          : [],
      ),
      followupActions: supportedFollowups,
      handoffPayload: continuationCandidate.handoffPayload,
      continuationCandidate,
    };
  }

  const fallbackText =
    followthroughLines.length === 0
      ? 'Nothing is standing out as an active follow-through risk right now.'
      : context.channel === 'alexa'
        ? followthroughLines[0]!
        : [
            'Follow-through right now:',
            ...followthroughLines.map((line) => `- ${line}`),
          ].join('\n');
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: fallbackText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'life_thread_local',
      'used life-thread follow-through snapshot',
    ),
  };
}

function isResearchExplainabilityTurn(query: string): boolean {
  return /^(why\b|why did you choose that route\b|why research mode\b|why did you use research mode\b|what path did you use\b|what capability are you using\b)/i.test(
    normalizeText(query),
  );
}

function formatResearchTelegramReply(result: ResearchResult): string {
  const lines = [
    '*Research Summary*',
    result.summaryText || result.fullText || '',
  ];
  for (const section of result.structuredFindings) {
    if (!section.items.length) continue;
    lines.push('', `*${section.title}*`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }
  if (result.recommendationText) {
    lines.push('', '*Recommendation*', result.recommendationText);
  }
  if (result.supportingSources?.length) {
    lines.push('', '*Supporting Sources*');
    for (const source of result.supportingSources.slice(0, 4)) {
      lines.push(
        `- ${source.title}${source.matchReason ? ` (${source.matchReason})` : ''}`,
      );
    }
  }
  lines.push('', '*Why this route*', result.routeExplanation);
  if (result.followupSuggestions.length) {
    lines.push('', '*Next if useful*');
    for (const suggestion of result.followupSuggestions.slice(0, 2)) {
      lines.push(`- ${suggestion}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

function formatResearchBlueBubblesReply(result: ResearchResult): string {
  const lines = [result.summaryText || result.fullText || ''];
  const firstSection = result.structuredFindings[0];
  if (firstSection?.items.length) {
    lines.push(...firstSection.items.slice(0, 2).map((item) => `- ${item}`));
  }
  if (result.supportingSources?.length) {
    lines.push(
      `Sources: ${result.supportingSources
        .slice(0, 2)
        .map((source) => source.title)
        .join(', ')}`,
    );
  }
  lines.push(`Route: ${result.routeExplanation}`);
  return lines.filter(Boolean).join('\n');
}

function formatResearchAlexaReply(result: ResearchResult): {
  replyText: string;
  handoffOffer?: string;
} {
  const lead =
    result.spokenText || result.summaryText || result.fullText || 'Okay.';
  const followupPrompt =
    result.handoffOption && result.plan.kind === 'compare'
      ? ' Want the tradeoffs, or should I send the fuller version to Telegram?'
      : result.handoffOption
        ? ' I can send the fuller version to Telegram if you want.'
        : result.followupSuggestions[0]
          ? ` ${result.followupSuggestions[0]}`
          : '';
  return {
    replyText: `${lead}${followupPrompt}`.trim(),
    handoffOffer: result.handoffOption
      ? 'I can send the fuller version to Telegram if you want.'
      : undefined,
  };
}

function buildResearchContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  query: string,
  result: ResearchResult,
  voice: ReturnType<typeof formatResearchAlexaReply>,
  telegramReply: string,
): CompanionContinuationCandidate {
  return {
    capabilityId: descriptor.id,
    voiceSummary:
      result.spokenText || result.summaryText || voice.replyText || query,
    handoffPayload: buildCompanionMessagePayload(
      descriptor.label,
      telegramReply,
      result.followupSuggestions,
      result.routeExplanation,
    ),
    completionText:
      result.saveForLaterCandidate ||
      result.recommendationText ||
      result.summaryText ||
      query,
    knowledgeSourceIds: (result.supportingSources || [])
      .map((source) => source.sourceId)
      .filter((sourceId): sourceId is string => Boolean(sourceId)),
    knowledgeSourceTitles: (result.supportingSources || []).map(
      (source) => source.title,
    ),
    followupSuggestions: result.followupSuggestions,
  };
}

function buildMediaContinuationCandidate(
  descriptor: AssistantCapabilityDescriptor,
  prompt: string,
  mediaResult: MediaGenerationResult,
): CompanionContinuationCandidate {
  const normalizedPrompt = normalizeText(prompt);
  const summary = mediaResult.summaryText || mediaResult.replyText || normalizedPrompt;
  return {
    capabilityId: descriptor.id,
    voiceSummary: summary,
    handoffPayload: {
      kind: mediaResult.artifact ? 'artifact' : 'message',
      title: descriptor.label,
      text: mediaResult.replyText || summary,
      artifact: mediaResult.artifact,
      caption: mediaResult.replyText || summary,
      followupSuggestions: [],
    },
    completionText: normalizedPrompt,
    followupSuggestions: [],
  };
}

function dedupeSupportingSources(
  supportingSources: ResearchSupportingSource[] | undefined,
): ResearchSupportingSource[] {
  const unique = new Map<string, ResearchSupportingSource>();
  for (const source of supportingSources || []) {
    const key =
      source.sourceId ||
      `${source.title.toLowerCase()}:${(source.excerpt || '').toLowerCase()}`;
    if (!unique.has(key)) {
      unique.set(key, source);
    }
  }
  return [...unique.values()];
}

function describeKnowledgeMatches(
  supportingSources: ResearchSupportingSource[] | undefined,
): string[] {
  return dedupeSupportingSources(supportingSources)
    .slice(0, 4)
    .map((source) =>
      source.matchReason
        ? `${source.title}: ${source.matchReason}`
        : source.title,
    );
}

function summarizeKnowledgeSourceList(
  sources: KnowledgeSourceRecord[],
  hits?: ResearchSupportingSource[],
): {
  telegram: string;
  alexa: string;
  bluebubbles: string;
} {
  if (sources.length === 0) {
    return {
      telegram: 'I do not have any matching saved sources yet.',
      alexa: 'I do not have any matching saved sources yet.',
      bluebubbles: 'I do not have any matching saved sources yet.',
    };
  }

  const matchById = new Map(
    (hits || []).map((hit) => [
      hit.sourceId || `${hit.title}:${hit.excerpt}`,
      hit,
    ]),
  );
  const telegramLines = ['*Saved Sources*'];
  for (const source of sources.slice(0, 5)) {
    const hit = matchById.get(source.sourceId);
    telegramLines.push(
      `- *${source.title}*${hit?.matchReason ? ` (${hit.matchReason})` : ''}`,
    );
    telegramLines.push(
      `  ${source.shortSummary}${source.tags.length ? ` [tags: ${source.tags.join(', ')}]` : ''}`,
    );
  }

  const alexaLead =
    sources.length === 1
      ? `I found one saved source: ${sources[0]!.title}.`
      : `I found ${sources.length} saved sources. The strongest match is ${sources[0]!.title}.`;

  return {
    telegram: telegramLines.join('\n'),
    alexa: alexaLead,
    bluebubbles: [
      'Saved sources:',
      ...sources.slice(0, 3).map((source) => `- ${source.title}`),
    ].join('\n'),
  };
}

function extractKnowledgeExplainTopic(query: string): string {
  return normalizeText(query)
    .replace(
      /^(?:what sources are you using(?: about| for)?|explain why this source was chosen(?: about| for)?|show me the relevant saved items(?: about| for)?)\s*/i,
      '',
    )
    .trim();
}

function buildKnowledgeSourceExplainReply(
  channel: AssistantCapabilityContext['channel'],
  query: string,
  supportingSources: ResearchSupportingSource[],
): string {
  if (supportingSources.length === 0) {
    return 'I do not have any saved sources to ground that yet.';
  }

  const topic = extractKnowledgeExplainTopic(query);
  const reason =
    topic.length > 0
      ? `They were the strongest saved matches for "${topic}".`
      : 'They were the strongest saved matches in your library.';

  if (channel === 'alexa') {
    const names = supportingSources.slice(0, 3).map((source) => source.title);
    const joinedNames =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names[0]}, ${names[1]}, and ${names[2]}`;
    return `I would use ${joinedNames} because ${reason.toLowerCase()}`;
  }

  if (channel === 'bluebubbles') {
    return [
      'Sources I would use:',
      ...supportingSources
        .slice(0, 3)
        .map(
          (source) =>
            `- ${source.title}${source.matchReason ? ` (${source.matchReason})` : ''}`,
        ),
      `Why these sources: ${reason}`,
    ].join('\n');
  }

  return [
    '*Sources I would use*',
    ...supportingSources.slice(0, 4).map((source) => {
      const lines = [
        `- *${source.title}*${source.matchReason ? ` (${source.matchReason})` : ''}`,
      ];
      if (source.excerpt) {
        lines.push(`  ${source.excerpt}`);
      }
      return lines.join('\n');
    }),
    '',
    '*Why these sources*',
    reason,
  ].join('\n');
}

function inferKnowledgeRequestedSourceIds(
  query: string,
  context: AssistantCapabilityContext,
): string[] | undefined {
  const normalized = normalizeText(query).toLowerCase();
  if (
    context.priorSubjectData?.knowledgeSourceIds?.length &&
    (/^(this|that|these) source/.test(normalized) ||
      /\bthese saved sources\b/.test(normalized) ||
      /\bthat source\b/.test(normalized))
  ) {
    return context.priorSubjectData.knowledgeSourceIds;
  }
  return undefined;
}

async function runResearchCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const query = input.canonicalText || input.text || '';
  if (!query.trim()) return { handled: false };
  if (
    isResearchExplainabilityTurn(query) &&
    context.priorSubjectData?.researchRouteExplanation
  ) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        context.channel === 'alexa'
          ? context.priorSubjectData.researchRouteExplanation
          : [
              '*Why this route*',
              context.priorSubjectData.researchRouteExplanation,
              context.priorSubjectData.researchProviderUsed
                ? `Provider: ${context.priorSubjectData.researchProviderUsed}`
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: {
        flowKey: descriptor.id.replace(/\./g, '_'),
        subjectKind: 'general',
        summaryText: context.priorSubjectData.researchRouteExplanation,
        guidanceGoal: 'explainability',
        subjectData: {
          ...context.priorSubjectData,
          activeCapabilityId: descriptor.id,
        },
        supportedFollowups: descriptor.followupActions,
        responseSource: 'local_companion',
      },
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'research_local',
        'explained the active research route',
      ),
    };
  }
  const result = await runResearchOrchestrator({
    query,
    channel: context.channel === 'bluebubbles' ? 'telegram' : context.channel,
    groupFolder: context.groupFolder,
    now: context.now,
    conversationSummary: context.conversationSummary,
    preferBrief: context.channel === 'alexa',
  });
  if (!result.handled) return { handled: false };
  const voice = formatResearchAlexaReply(result);
  const telegramReply = formatResearchTelegramReply(result);
  const bluebubblesReply = formatResearchBlueBubblesReply(result);
  const continuationCandidate = buildResearchContinuationCandidate(
    descriptor,
    query,
    result,
    voice,
    telegramReply,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? voice.replyText
        : context.channel === 'bluebubbles'
          ? bluebubblesReply
          : telegramReply,
    outputShape:
      result.handoffOption && context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    researchResult: result,
    handoffOffer: voice.handoffOffer,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.summaryText || query,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary: result.summaryText || query,
        lastRecommendation: result.recommendationText,
        conversationFocus: query,
        researchHandoffEligible: Boolean(result.handoffOption),
        researchRouteExplanation: result.routeExplanation,
        researchProviderUsed: result.providerUsed,
        saveForLaterCandidate: result.saveForLaterCandidate,
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
      supportedFollowups,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      result.providerUsed === 'openai_responses' ||
        result.providerUsed === 'hybrid'
        ? result.handoffOption && context.channel === 'alexa'
          ? 'research_handoff'
          : 'research_openai'
        : 'research_local',
      result.plan.reason,
      result.sourceNotes,
    ),
    followupActions: supportedFollowups,
  };
}

function parseKnowledgeTitle(text: string): string | undefined {
  const quoted =
    text.match(/\b(?:as|titled|called)\s+["“]([^"”]+)["”]/i)?.[1] ||
    text.match(/\b(?:as|titled|called)\s+([a-z0-9][a-z0-9'&: _-]{2,})$/i)?.[1];
  return quoted?.trim();
}

function parseKnowledgeExplicitTitle(text: string): string | undefined {
  return text
    .match(/\b(?:as|titled|called)\s+([^:\n]+):/i)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim();
}

function parseKnowledgeTags(text: string): string[] {
  const raw =
    text.match(/\btags?\s*[:=]\s*([a-z0-9, _-]+)/i)?.[1] ||
    text.match(/\btagged\s+([a-z0-9, _-]+)/i)?.[1];
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function parseKnowledgeFilePath(text: string): string | undefined {
  const quoted =
    text.match(
      /(?:save|add|import|index)\s+(?:the\s+)?(?:file|document)\s+["“]([^"”]+)["”]/i,
    )?.[1] ||
    text.match(
      /(?:save|add|import|index)\s+(?:the\s+)?(?:file|document)\s+([A-Za-z]:\\[^\n]+?)(?:\s+to my library|\s*$)/i,
    )?.[1];
  return quoted?.trim();
}

function resolveKnowledgeSourceType(
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): 'saved_research_result' | 'generated_note' | 'manual_reference' {
  const text = normalizeText(input.text || input.canonicalText);
  if (
    context.priorSubjectData?.activeCapabilityId?.startsWith('research.') ||
    /\bresearch\b/.test(text) ||
    context.priorSubjectData?.researchRouteExplanation
  ) {
    return 'saved_research_result';
  }
  if (context.replyText || context.priorSubjectData?.lastAnswerSummary) {
    return 'generated_note';
  }
  return 'manual_reference';
}

function pickKnowledgeSaveContent(
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): string {
  const text = input.text || input.canonicalText || '';
  const colonContent = text.includes(':')
    ? text.split(':').slice(1).join(':').trim()
    : '';
  if (colonContent) return colonContent;
  if (context.replyText?.trim()) return context.replyText.trim();
  if (context.priorSubjectData?.saveForLaterCandidate?.trim()) {
    return context.priorSubjectData.saveForLaterCandidate.trim();
  }
  if (context.priorSubjectData?.lastAnswerSummary?.trim()) {
    return context.priorSubjectData.lastAnswerSummary.trim();
  }
  return '';
}

function buildKnowledgeConversationSeed(
  descriptor: AssistantCapabilityDescriptor,
  summaryText: string,
  query: string,
  sourceIds: string[] = [],
  sourceTitles: string[] = [],
  sourceMatches: string[] = [],
): AssistantCapabilityConversationSeed {
  return {
    flowKey: descriptor.id.replace(/\./g, '_'),
    subjectKind: 'saved_item',
    summaryText,
    guidanceGoal: 'explainability',
    subjectData: {
      activeCapabilityId: descriptor.id,
      lastAnswerSummary: summaryText,
      conversationFocus: query,
      knowledgeSourceIds: sourceIds,
      knowledgeSourceTitles: sourceTitles,
      knowledgeSourceMatches: sourceMatches,
      knowledgeLastQuery: query,
    },
    supportedFollowups: descriptor.followupActions,
    responseSource: 'local_companion',
  };
}

async function runKnowledgeSaveCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };

  const raw = input.canonicalText || input.text || '';
  const filePath = parseKnowledgeFilePath(raw);
  const title = parseKnowledgeExplicitTitle(raw) || parseKnowledgeTitle(raw);
  const tags = parseKnowledgeTags(raw);
  const result = filePath
    ? importKnowledgeFile({
        groupFolder: context.groupFolder,
        filePath,
        title,
        tags,
        sourceChannel: context.channel === 'alexa' ? 'alexa' : context.channel,
      })
    : saveKnowledgeSource({
        groupFolder: context.groupFolder,
        title,
        content: pickKnowledgeSaveContent(context, input),
        sourceType: resolveKnowledgeSourceType(context, input),
        tags,
        sourceChannel: context.channel === 'alexa' ? 'alexa' : context.channel,
      });

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.message,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      result.message,
      raw || result.message,
      result.source ? [result.source.sourceId] : [],
      result.source ? [result.source.title] : [],
      result.source ? [result.source.title] : [],
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      result.ok
        ? 'saved an explicit library source'
        : 'library save failed cleanly',
      result.debugPath,
    ),
  };
}

function buildKnowledgeSourcesReply(
  channel: AssistantCapabilityContext['channel'],
  sources: KnowledgeSourceRecord[],
  supportingSources?: ResearchSupportingSource[],
): string {
  const formatted = summarizeKnowledgeSourceList(sources, supportingSources);
  if (channel === 'alexa') return formatted.alexa;
  if (channel === 'bluebubbles') return formatted.bluebubbles;
  return formatted.telegram;
}

async function runKnowledgeListCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const query = input.canonicalText || input.text || '';
  const search = searchKnowledgeLibrary({
    groupFolder: context.groupFolder,
    query,
    requestedSourceIds: inferKnowledgeRequestedSourceIds(query, context),
    limit: context.channel === 'alexa' ? 3 : 5,
  });
  const replyText = buildKnowledgeSourcesReply(
    context.channel,
    search.sources,
    search.hits.map((hit) => ({
      origin: 'knowledge_library',
      title: hit.sourceTitle,
      sourceId: hit.sourceId,
      sourceType: hit.sourceType,
      scope: hit.scope,
      excerpt: hit.excerpt,
      retrievalScore: hit.retrievalScore,
      matchReason: hit.matchReason,
    })),
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      search.sources.length
        ? `Found ${search.sources.length} saved sources.`
        : 'No matching saved sources yet.',
      query,
      search.sources.map((source) => source.sourceId),
      search.sources.map((source) => source.title),
      search.hits.map((hit) => `${hit.sourceTitle}: ${hit.matchReason}`),
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      'listed relevant saved sources from the knowledge library',
      search.debugPath,
    ),
  };
}

async function runKnowledgeResearchCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const query =
    input.canonicalText ||
    input.text ||
    context.priorSubjectData?.knowledgeLastQuery ||
    '';
  if (!query.trim()) return { handled: false };

  if (
    descriptor.id === 'knowledge.explain_sources' &&
    context.priorSubjectData?.knowledgeSourceMatches?.length
  ) {
    const replyText =
      context.channel === 'alexa'
        ? `I used ${context.priorSubjectData.knowledgeSourceTitles?.slice(0, 2).join(' and ')} because they were the strongest saved matches.`
        : [
            '*Sources used*',
            ...context.priorSubjectData.knowledgeSourceMatches.map(
              (match) => `- ${match}`,
            ),
          ].join('\n');
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText,
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildKnowledgeConversationSeed(
        descriptor,
        context.priorSubjectData.lastAnswerSummary ||
          'Saved source explanation',
        query,
        context.priorSubjectData.knowledgeSourceIds || [],
        context.priorSubjectData.knowledgeSourceTitles || [],
        context.priorSubjectData.knowledgeSourceMatches || [],
      ),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        'explained the saved sources used in the active answer',
      ),
    };
  }

  if (descriptor.id === 'knowledge.explain_sources') {
    if (!context.groupFolder) return { handled: false };
    const topicQuery = extractKnowledgeTopicQuery(query);
    if (!topicQuery.trim()) {
      return {
        handled: true,
        capabilityId: descriptor.id,
        replyText:
          'Ask that about a saved topic, or right after a saved-material answer.',
        outputShape: descriptor.preferredOutputShape[context.channel],
        trace: buildCapabilityTrace(
          descriptor,
          context,
          'knowledge_library',
          'source explanation requested without a specific saved topic',
        ),
      };
    }

    const search = searchKnowledgeLibrary({
      groupFolder: context.groupFolder,
      query: topicQuery,
      requestedSourceIds: inferKnowledgeRequestedSourceIds(query, context),
      limit: context.channel === 'alexa' ? 2 : 4,
    });
    const supportingSources = dedupeSupportingSources(
      search.hits.map((hit) => ({
        origin: 'knowledge_library' as const,
        title: hit.sourceTitle,
        sourceId: hit.sourceId,
        sourceType: hit.sourceType,
        scope: hit.scope,
        excerpt: hit.excerpt,
        retrievalScore: hit.retrievalScore,
        matchReason: hit.matchReason,
      })),
    );

    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: buildKnowledgeSourceExplainReply(
        context.channel,
        query,
        supportingSources,
      ),
      outputShape: descriptor.preferredOutputShape[context.channel],
      conversationSeed: buildKnowledgeConversationSeed(
        descriptor,
        supportingSources.length
          ? `Explained the saved sources for ${topicQuery}.`
          : 'No saved sources matched that topic yet.',
        topicQuery,
        supportingSources
          .map((source) => source.sourceId)
          .filter((sourceId): sourceId is string => Boolean(sourceId)),
        supportingSources.map((source) => source.title),
        describeKnowledgeMatches(supportingSources),
      ),
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        supportingSources.length
          ? 'explained which saved sources matched the requested topic'
          : 'no saved sources matched the requested topic',
        search.debugPath,
      ),
    };
  }

  const savedMaterialMode = /\bcombine my notes with outside research\b/i.test(
    query,
  )
    ? 'combine'
    : 'only';
  const requestedSourceIds = inferKnowledgeRequestedSourceIds(query, context);
  const researchResult = await runResearchOrchestrator({
    query,
    channel: context.channel === 'bluebubbles' ? 'telegram' : context.channel,
    groupFolder: context.groupFolder,
    now: context.now,
    conversationSummary: context.conversationSummary,
    preferBrief: context.channel === 'alexa',
    savedMaterialMode,
    requestedSourceIds,
  });
  if (!researchResult.handled) return { handled: false };

  const voice = formatResearchAlexaReply(researchResult);
  const supportingSourceIds = (researchResult.supportingSources || [])
    .map((source) => source.sourceId)
    .filter((sourceId): sourceId is string => Boolean(sourceId));
  const supportingSourceTitles = (researchResult.supportingSources || []).map(
    (source) => source.title,
  );
  const knowledgeMatches = describeKnowledgeMatches(
    researchResult.supportingSources,
  );
  const telegramReply = formatResearchTelegramReply(researchResult);
  const continuationCandidate = buildResearchContinuationCandidate(
    descriptor,
    query,
    researchResult,
    voice,
    telegramReply,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );
  const conversationSeed = buildKnowledgeConversationSeed(
    descriptor,
    researchResult.summaryText || query,
    query,
    supportingSourceIds,
    supportingSourceTitles,
    knowledgeMatches,
  );
  conversationSeed.subjectData = {
    ...(conversationSeed.subjectData || {}),
    companionContinuationJson: serializeCompanionContinuation(
      continuationCandidate,
    ),
  };
  conversationSeed.supportedFollowups = supportedFollowups;

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? voice.replyText
        : context.channel === 'bluebubbles'
          ? formatResearchBlueBubblesReply(researchResult)
          : telegramReply,
    outputShape:
      researchResult.handoffOption && context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    researchResult,
    handoffOffer: voice.handoffOffer,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed,
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      researchResult.routeExplanation,
      researchResult.debugPath,
    ),
    followupActions: supportedFollowups,
  };
}

async function runKnowledgeMutationCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  if (!context.groupFolder) return { handled: false };
  const query = input.canonicalText || input.text || '';
  const selection = resolveKnowledgeSourceSelection({
    groupFolder: context.groupFolder,
    text: query,
    priorSourceIds: context.priorSubjectData?.knowledgeSourceIds,
  });
  const target = selection.sources[0];
  if (!target) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText: 'I could not find a matching saved source for that.',
      outputShape: descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'knowledge_library',
        'no matching saved source was available for the requested mutation',
        selection.debugPath,
      ),
    };
  }

  const mutationResult =
    descriptor.id === 'knowledge.disable_source'
      ? disableKnowledgeSourceById(target.sourceId)
      : descriptor.id === 'knowledge.delete_source'
        ? deleteKnowledgeSourceById(target.sourceId)
        : reindexKnowledgeSourceById(target.sourceId);
  const mutationDebugPath: string[] =
    descriptor.id === 'knowledge.reindex_source' &&
    'debugPath' in mutationResult
      ? (mutationResult.debugPath as string[])
      : selection.debugPath;

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: mutationResult.message,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: buildKnowledgeConversationSeed(
      descriptor,
      mutationResult.message,
      query,
      [target.sourceId],
      [target.title],
      [target.title],
    ),
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'knowledge_library',
      descriptor.id === 'knowledge.reindex_source'
        ? 'reindexed a saved knowledge source'
        : descriptor.id === 'knowledge.delete_source'
          ? 'deleted a saved knowledge source'
          : 'disabled a saved knowledge source',
      mutationDebugPath,
    ),
  };
}

async function runMediaCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const prompt = input.canonicalText || input.text || '';
  if (!prompt.trim()) return { handled: false };

  if (descriptor.id !== 'media.image_generate') {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        context.channel === 'alexa'
          ? 'That media workflow is still a future hook.'
          : 'That media workflow is still prepared, but not implemented yet.',
      outputShape:
        context.channel === 'alexa'
          ? 'voice_brief'
          : descriptor.preferredOutputShape[context.channel],
      trace: buildCapabilityTrace(
        descriptor,
        context,
        'unavailable',
        'media workflow is still a future hook',
      ),
    };
  }

  const mediaResult = await runImageGeneration({
    prompt,
    channel: context.channel,
    groupFolder: context.groupFolder,
  });
  const continuationCandidate = buildMediaContinuationCandidate(
    descriptor,
    prompt,
    mediaResult,
  );
  const supportedFollowups = extendCompanionFollowups(
    descriptor.followupActions,
    continuationCandidate,
  );

  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: mediaResult.replyText || mediaResult.summaryText || 'Okay.',
    outputShape:
      context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    mediaResult,
    handoffOffer:
      context.channel === 'alexa'
        ? 'I can generate that and send it to Telegram.'
        : undefined,
    handoffPayload: continuationCandidate.handoffPayload,
    continuationCandidate,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'saved_item',
      summaryText:
        mediaResult.summaryText || mediaResult.replyText || normalizeText(prompt),
      guidanceGoal: 'action_follow_through',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary:
          mediaResult.summaryText ||
          mediaResult.replyText ||
          normalizeText(prompt),
        conversationFocus: normalizeText(prompt),
        companionContinuationJson: serializeCompanionContinuation(
          continuationCandidate,
        ),
      },
      supportedFollowups,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      context.channel === 'alexa'
        ? 'media_handoff'
        : mediaResult.providerUsed === 'openai_images'
          ? 'media_openai'
          : 'unavailable',
      mediaResult.routeExplanation,
      mediaResult.debugPath,
    ),
    followupActions: supportedFollowups,
  };
}

async function runPulseCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const preference = getDefaultPulsePreference();
  const toneProfile = getToneProfileForContext(context);
  const result = buildAndreaPulseReply({
    channel: context.channel,
    query: input.canonicalText || input.text || descriptor.label,
    toneProfile,
    now: context.now,
    previousSummary: context.conversationSummary,
  });
  const notes = [`mode: ${preference.mode}`, `item: ${result.item.id}`];
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText: result.replyText,
    outputShape: descriptor.preferredOutputShape[context.channel],
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.summaryText,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary: result.summaryText,
        conversationFocus: result.item.title,
        toneProfile,
      },
      supportedFollowups: descriptor.followupActions,
      responseStyle: 'default',
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      'pulse_local',
      'handled by local Andrea Pulse catalog',
      notes,
    ),
    followupActions: descriptor.followupActions,
  };
}

const CAPABILITY_DESCRIPTORS: AssistantCapabilityDescriptor[] = [
  {
    id: 'daily.morning_brief',
    label: 'Morning Brief',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[0]!,
        cloneContext(context),
        input,
        'what should I know about today',
        buildDailySeed(
          'daily.morning_brief',
          'daily_morning_brief',
          'today and what matters most',
          'daily_brief',
          {
            subjectKind: 'day_brief',
            prioritizationLens: 'calendar',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.whats_next',
    label: "What's Next",
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[1]!,
        cloneContext(context),
        input,
        'what should I do next',
        buildDailySeed(
          'daily.whats_next',
          'daily_whats_next',
          'what should you do next',
          'next_action',
          {
            subjectKind: 'event',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.loose_ends',
    label: 'Loose Ends',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[2]!,
        cloneContext(context),
        input,
        'what am I forgetting',
        buildDailySeed(
          'daily.loose_ends',
          'daily_loose_ends',
          'likely loose ends and what you may be forgetting',
          'what_am_i_forgetting',
          {
            subjectKind: 'day_brief',
            hasActionItem: true,
            hasRiskSignal: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'daily.evening_reset',
    label: 'Evening Reset',
    category: 'daily',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'save_that',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[3]!,
        cloneContext(context),
        input,
        'what should I remember tonight',
        buildDailySeed(
          'daily.evening_reset',
          'daily_evening_reset',
          'what to wrap up today and remember tonight',
          'evening_reset',
          {
            subjectKind: 'day_brief',
            prioritizationLens: 'evening',
            hasActionItem: true,
            reminderCandidate: true,
          },
        ),
      ),
  },
  {
    id: 'household.candace_upcoming',
    label: 'Candace Upcoming',
    category: 'household',
    requiredInputs: [],
    optionalInputs: ['text', 'personName'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'switch_person',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[4]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText ||
            input.text ||
            (input.personName
              ? `what about ${input.personName}`
              : 'what do Candace and I have coming up'),
        },
        'what do Candace and I have coming up',
        buildDailySeed(
          'household.candace_upcoming',
          'candace_upcoming',
          'shared plans and open loops with Candace',
          'shared_plans',
          {
            subjectKind: 'person',
            subjectData: { personName: 'Candace', activePeople: ['Candace'] },
            prioritizationLens: 'family',
            hasActionItem: true,
          },
        ),
      ),
  },
  {
    id: 'household.family_open_loops',
    label: 'Family Open Loops',
    category: 'household',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: [
      'anything_else',
      'shorter',
      'say_more',
      'action_guidance',
      'memory_control',
    ],
    handlerKind: 'local',
    execute: (context, input) =>
      runDailyCapability(
        CAPABILITY_DESCRIPTORS[5]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText ||
            input.text ||
            'anything for the family I am forgetting',
        },
        'what do I need to follow up on at home',
        buildDailySeed(
          'household.family_open_loops',
          'family_open_loops',
          'family plans, home follow-through, and household carryover',
          'family_guidance',
          {
            subjectKind: 'household',
            subjectData: {
              activePeople: ['Candace', 'Travis'],
              householdFocus: true,
            },
            prioritizationLens: 'family',
            hasActionItem: true,
          },
        ),
      ),
  },
  {
    id: 'followthrough.remind_before_anchor',
    label: 'Remind Before Anchor',
    category: 'followthrough',
    requiredInputs: ['anchor'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote: 'implemented at the channel edge for confirmation safety',
  },
  {
    id: 'followthrough.save_for_later',
    label: 'Save For Later',
    category: 'followthrough',
    requiredInputs: ['content'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote: 'implemented at the channel edge for confirmation safety',
  },
  {
    id: 'followthrough.draft_follow_up',
    label: 'Draft Follow-up',
    category: 'followthrough',
    requiredInputs: ['reference'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'edge_only',
    availabilityNote:
      'implemented at the channel edge for shorter drafting workflows',
  },
  {
    id: 'threads.list_open',
    label: 'List Open Threads',
    category: 'threads',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runLifeThreadCapability(
        CAPABILITY_DESCRIPTORS[9]!,
        cloneContext(context),
        {
          ...input,
          canonicalText:
            input.canonicalText || input.text || 'what threads do I have open',
        },
      ),
  },
  {
    id: 'threads.explicit_lookup',
    label: 'Explicit Thread Lookup',
    category: 'threads',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runLifeThreadCapability(
        CAPABILITY_DESCRIPTORS[10]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.explain',
    label: 'Explain Memory Use',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[11]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.remember',
    label: 'Remember',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[12]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.forget',
    label: 'Forget Memory',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[13]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'memory.manual_only',
    label: 'Manual-only Memory Use',
    category: 'memory',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: true,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runMemoryCapability(
        CAPABILITY_DESCRIPTORS[14]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'pulse.interesting_thing',
    label: 'Interesting Thing',
    category: 'pulse',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runPulseCapability(
        CAPABILITY_DESCRIPTORS[15]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'pulse.surprise_me',
    label: 'Andrea Pulse',
    category: 'pulse',
    requiredInputs: [],
    optionalInputs: ['text'],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runPulseCapability(
        CAPABILITY_DESCRIPTORS[16]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.topic',
    label: 'Research Topic',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[17]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.compare',
    label: 'Compare Options',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[18]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.summarize',
    label: 'Summarize Findings',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[19]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'research.recommend',
    label: 'Recommend Best Choice',
    category: 'research',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runResearchCapability(
        CAPABILITY_DESCRIPTORS[20]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'work.current_summary',
    label: 'Current Work Summary',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'work.current_output',
    label: 'Current Work Output',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'work.current_logs',
    label: 'Current Work Logs',
    category: 'work',
    requiredInputs: [],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: true,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'backend_lane',
    availabilityNote: 'kept on the operator/runtime lane',
  },
  {
    id: 'media.image_generate',
    label: 'Generate Image',
    category: 'media',
    requiredInputs: ['prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote:
      'Telegram image generation is wired when OpenAI credentials are configured; Alexa stays handoff-only',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[24]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'media.image_edit',
    label: 'Edit Image',
    category: 'media',
    requiredInputs: ['image', 'prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'artifact_only',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote: 'prepared only; image editing provider is not wired yet',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[25]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'media.video_generate',
    label: 'Generate Video',
    category: 'media',
    requiredInputs: ['prompt'],
    optionalInputs: [],
    requiresLinkedAccount: false,
    requiresConfirmation: false,
    safeForAlexa: false,
    safeForTelegram: true,
    safeForBlueBubbles: false,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'artifact_only',
      telegram: 'artifact_only',
      bluebubbles: 'artifact_only',
    },
    followupActions: [],
    handlerKind: 'edge_only',
    availabilityNote: 'future hook only; no video provider is wired yet',
    execute: (context, input) =>
      runMediaCapability(
        CAPABILITY_DESCRIPTORS[26]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.save_source',
    label: 'Save To Library',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeSaveCapability(
        CAPABILITY_DESCRIPTORS[27]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.list_sources',
    label: 'List Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['say_more', 'shorter', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeListCapability(
        CAPABILITY_DESCRIPTORS[28]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.summarize_saved',
    label: 'Summarize Saved Material',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[29]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.compare_saved',
    label: 'Compare Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'handoff_offer',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'research',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[30]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.explain_sources',
    label: 'Explain Saved Sources',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeResearchCapability(
        CAPABILITY_DESCRIPTORS[31]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.disable_source',
    label: 'Disable Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[32]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.delete_source',
    label: 'Delete Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[33]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'knowledge.reindex_source',
    label: 'Reindex Saved Source',
    category: 'knowledge',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: [],
    handlerKind: 'local',
    execute: (context, input) =>
      runKnowledgeMutationCapability(
        CAPABILITY_DESCRIPTORS[34]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.status',
    label: 'Ritual Status',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['shorter', 'say_more'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualControlCapability(
        CAPABILITY_DESCRIPTORS[35]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.configure',
    label: 'Configure Rituals',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_brief',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualControlCapability(
        CAPABILITY_DESCRIPTORS[36]!,
        cloneContext(context),
        input,
      ),
  },
  {
    id: 'rituals.followthrough',
    label: 'Follow-through View',
    category: 'rituals',
    requiredInputs: ['text'],
    optionalInputs: [],
    requiresLinkedAccount: true,
    requiresConfirmation: false,
    safeForAlexa: true,
    safeForTelegram: true,
    safeForBlueBubbles: true,
    operatorOnly: false,
    preferredOutputShape: {
      alexa: 'voice_brief',
      telegram: 'chat_rich',
      bluebubbles: 'chat_brief',
    },
    followupActions: ['anything_else', 'shorter', 'say_more', 'memory_control'],
    handlerKind: 'local',
    execute: (context, input) =>
      runRitualFollowthroughCapability(
        CAPABILITY_DESCRIPTORS[37]!,
        cloneContext(context),
        input,
      ),
  },
];

export function getAssistantCapabilityRegistry(): AssistantCapabilityDescriptor[] {
  return [...CAPABILITY_DESCRIPTORS];
}

export function getAssistantCapability(
  id: AssistantCapabilityId,
): AssistantCapabilityDescriptor | undefined {
  return CAPABILITY_DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

export function isAssistantCapabilityAllowed(
  descriptor: AssistantCapabilityDescriptor,
  channel: AssistantCapabilityContext['channel'],
): boolean {
  if (descriptor.operatorOnly) {
    return channel === 'telegram' && descriptor.safeForTelegram;
  }
  if (channel === 'alexa') {
    return descriptor.safeForAlexa;
  }
  if (channel === 'bluebubbles') {
    return descriptor.safeForBlueBubbles;
  }
  return descriptor.safeForTelegram;
}

export async function executeAssistantCapability(params: {
  capabilityId: AssistantCapabilityId;
  context: AssistantCapabilityContext;
  input?: AssistantCapabilityInput;
}): Promise<AssistantCapabilityResult> {
  const descriptor = getAssistantCapability(params.capabilityId);
  if (!descriptor) {
    return { handled: false };
  }
  if (!isAssistantCapabilityAllowed(descriptor, params.context.channel)) {
    return {
      handled: true,
      capabilityId: descriptor.id,
      replyText:
        params.context.channel === 'alexa'
          ? 'I can help with that in Telegram, but not safely by voice here.'
          : params.context.channel === 'bluebubbles'
            ? 'That one stays on the Telegram or operator side for safety.'
            : 'That action stays on the operator or Telegram side for safety.',
      outputShape:
        params.context.channel === 'alexa' ? 'voice_brief' : 'chat_brief',
      trace: buildCapabilityTrace(
        descriptor,
        params.context,
        'unavailable',
        'blocked by channel safety gate',
      ),
    };
  }
  if (!descriptor.execute) {
    return { handled: false };
  }
  return descriptor.execute(params.context, params.input || {});
}

export function capabilitySupportsResearch(id: AssistantCapabilityId): boolean {
  return id.startsWith('research.');
}

export function inferResearchCapabilityId(text: string): AssistantCapabilityId {
  const normalized = normalizeText(text).toLowerCase();
  if (
    /\b(compare|versus|vs\.?|tradeoffs?|pros and cons|pros|cons)\b/.test(
      normalized,
    )
  ) {
    return 'research.compare';
  }
  if (
    /\b(best choice|which should i|recommend|what should i know before deciding|before deciding|why)\b/.test(
      normalized,
    )
  ) {
    return 'research.recommend';
  }
  if (/\b(summarize|summarise)\b/.test(normalized)) {
    return 'research.summarize';
  }
  return 'research.topic';
}

export function isSharedResearchRequest(text: string): boolean {
  return isResearchPrompt(text);
}
