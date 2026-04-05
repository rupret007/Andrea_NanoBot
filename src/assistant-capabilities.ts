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
  type ResearchResult,
} from './research-orchestrator.js';
import type {
  AlexaCompanionGuidanceGoal,
  AlexaConversationFollowupAction,
  AlexaConversationSubjectKind,
  CompanionToneProfile,
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
    | 'research_local'
    | 'research_openai'
    | 'research_handoff'
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
    toneProfile?: CompanionToneProfile;
  };
  supportedFollowups?: AlexaConversationFollowupAction[];
  prioritizationLens?: 'general' | 'calendar' | 'family' | 'meeting' | 'work' | 'evening';
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
  conversationSeed?: AssistantCapabilityConversationSeed;
  handoffOffer?: string;
  followupActions?: AlexaConversationFollowupAction[];
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
  return normalizeVoicePrompt(value || '').replace(/\s+/g, ' ').trim();
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
      supportedFollowups: response.context.supportedFollowups,
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
    followupActions: response.context.supportedFollowups,
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
              result.referencedThread.nextAction || result.referencedThread.summary,
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

async function runResearchCapability(
  descriptor: AssistantCapabilityDescriptor,
  context: AssistantCapabilityContext,
  input: AssistantCapabilityInput,
): Promise<AssistantCapabilityResult> {
  const query = input.canonicalText || input.text || '';
  if (!query.trim()) return { handled: false };
  const result = await runResearchOrchestrator({
    query,
    channel: context.channel === 'bluebubbles' ? 'telegram' : context.channel,
    groupFolder: context.groupFolder,
    now: context.now,
    conversationSummary: context.conversationSummary,
    preferBrief: context.channel === 'alexa',
  });
  if (!result.handled) return { handled: false };
  const voiceReply = result.spokenText || result.summaryText || result.fullText || '';
  const telegramReply = result.fullText || result.summaryText || voiceReply;
  const handoffOffer =
    context.channel === 'alexa' && result.handoffOption
      ? ' I can send the fuller version to Telegram if you want.'
      : undefined;
  return {
    handled: true,
    capabilityId: descriptor.id,
    replyText:
      context.channel === 'alexa'
        ? `${voiceReply}${handoffOffer || ''}`.trim()
        : telegramReply,
    outputShape:
      result.handoffOption && context.channel === 'alexa'
        ? 'handoff_offer'
        : descriptor.preferredOutputShape[context.channel],
    researchResult: result,
    handoffOffer,
    conversationSeed: {
      flowKey: descriptor.id.replace(/\./g, '_'),
      subjectKind: 'general',
      summaryText: result.summaryText || query,
      guidanceGoal: 'open_conversation',
      subjectData: {
        activeCapabilityId: descriptor.id,
        lastAnswerSummary: result.summaryText || query,
        conversationFocus: query,
        researchHandoffEligible: Boolean(result.handoffOption),
      },
      supportedFollowups: descriptor.followupActions,
      responseSource: 'local_companion',
    },
    trace: buildCapabilityTrace(
      descriptor,
      context,
      result.providerUsed === 'openai_responses' || result.providerUsed === 'hybrid'
        ? result.handoffOption && context.channel === 'alexa'
          ? 'research_handoff'
          : 'research_openai'
        : 'research_local',
      result.plan.reason,
      result.sourceNotes,
    ),
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
    followupActions: ['anything_else', 'shorter', 'say_more', 'action_guidance', 'memory_control'],
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
    followupActions: ['anything_else', 'shorter', 'say_more', 'action_guidance', 'memory_control'],
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
    followupActions: ['anything_else', 'shorter', 'say_more', 'save_that', 'memory_control'],
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
    followupActions: ['anything_else', 'shorter', 'say_more', 'switch_person', 'action_guidance', 'memory_control'],
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
    followupActions: ['anything_else', 'shorter', 'say_more', 'action_guidance', 'memory_control'],
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
    availabilityNote: 'implemented at the channel edge for shorter drafting workflows',
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
      runLifeThreadCapability(CAPABILITY_DESCRIPTORS[9]!, cloneContext(context), {
        ...input,
        canonicalText:
          input.canonicalText || input.text || 'what threads do I have open',
      }),
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
      runLifeThreadCapability(CAPABILITY_DESCRIPTORS[10]!, cloneContext(context), input),
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
      runMemoryCapability(CAPABILITY_DESCRIPTORS[11]!, cloneContext(context), input),
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
      runMemoryCapability(CAPABILITY_DESCRIPTORS[12]!, cloneContext(context), input),
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
      runMemoryCapability(CAPABILITY_DESCRIPTORS[13]!, cloneContext(context), input),
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
      runMemoryCapability(CAPABILITY_DESCRIPTORS[14]!, cloneContext(context), input),
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
      runPulseCapability(CAPABILITY_DESCRIPTORS[15]!, cloneContext(context), input),
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
      runPulseCapability(CAPABILITY_DESCRIPTORS[16]!, cloneContext(context), input),
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
      runResearchCapability(CAPABILITY_DESCRIPTORS[17]!, cloneContext(context), input),
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
      runResearchCapability(CAPABILITY_DESCRIPTORS[18]!, cloneContext(context), input),
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
      runResearchCapability(CAPABILITY_DESCRIPTORS[19]!, cloneContext(context), input),
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
      runResearchCapability(CAPABILITY_DESCRIPTORS[20]!, cloneContext(context), input),
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
    availabilityNote: 'capability prepared; no media provider is wired yet',
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
    availabilityNote: 'capability prepared; no media provider is wired yet',
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
  if (/\b(compare|versus|vs\.?|tradeoffs?)\b/.test(normalized)) {
    return 'research.compare';
  }
  if (/\b(best choice|which should i|recommend|why)\b/.test(normalized)) {
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
