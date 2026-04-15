import { TIMEZONE } from './config.js';
import { getAllTasks, listProfileFactsForGroup } from './db.js';
import {
  searchKnowledgeLibrary,
  type KnowledgeSearchResult,
} from './knowledge-library.js';
import { buildLifeThreadSnapshot } from './life-threads.js';
import {
  listGoogleCalendarEvents,
  resolveGoogleCalendarConfig,
} from './google-calendar.js';
import { logger } from './logger.js';
import {
  describeOpenAiConfigBlocker,
  describeOpenAiProviderFailure,
  getOpenAiProviderStatus,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import {
  buildGracefulDegradedReply,
  isLiveLookupConversationalPrompt,
  isResearchEligibleConversationalPrompt,
} from './conversational-core.js';
import { normalizeVoicePrompt } from './voice-ready.js';

export type ResearchRequestKind =
  | 'summary'
  | 'compare'
  | 'recommend'
  | 'deep_research';

export type ResearchSourceName =
  | 'local_context'
  | 'knowledge_library'
  | 'openai_responses'
  | 'runtime_delegate';

export type ResearchProviderUsed =
  | 'local_context'
  | 'knowledge_library'
  | 'openai_responses'
  | 'hybrid';

export interface ResearchRequest {
  query: string;
  channel: 'alexa' | 'telegram';
  groupFolder?: string;
  now?: Date;
  conversationSummary?: string;
  preferBrief?: boolean;
  requestedDepth?: 'brief' | 'standard' | 'deep';
  comparisonTargets?: string[];
  allowWebSearch?: boolean;
  savedMaterialMode?: 'auto' | 'only' | 'prefer' | 'combine';
  requestedSourceIds?: string[];
}

export interface ResearchSourceSet {
  localContext: boolean;
  knowledgeLibrary: boolean;
  openAiResponses: boolean;
  runtimeDelegate: boolean;
  webSearch: boolean;
}

export interface ResearchPlan {
  kind: ResearchRequestKind;
  primarySource: ResearchSourceName;
  reason: string;
  sources: ResearchSourceSet;
  needsTelegramHandoff: boolean;
}

export interface ResearchHandoffOption {
  channel: 'telegram';
  reason: string;
  prompt: string;
}

export interface ResearchFindingSection {
  title: string;
  items: string[];
}

export interface ResearchSupportingSource {
  origin: 'knowledge_library' | 'local_context' | 'outside_research';
  title: string;
  sourceId?: string;
  sourceType?: string;
  scope?: string;
  excerpt?: string;
  retrievalScore?: number;
  matchReason?: string;
}

export interface ResearchResult {
  handled: boolean;
  kind: ResearchRequestKind;
  plan: ResearchPlan;
  spokenText?: string;
  summaryText?: string;
  fullText?: string;
  sourceNotes: string[];
  handoffOption?: ResearchHandoffOption;
  providerUsed?: ResearchProviderUsed;
  routeExplanation: string;
  structuredFindings: ResearchFindingSection[];
  followupSuggestions: string[];
  saveForLaterCandidate?: string;
  debugPath: string[];
  recommendationText?: string;
  supportingSources?: ResearchSupportingSource[];
}

interface LocalResearchContext {
  threadLines: string[];
  taskLines: string[];
  calendarLines: string[];
  memoryLines: string[];
}

interface KnowledgeResearchContext {
  search: KnowledgeSearchResult;
  contextBlock: string;
  supportingSources: ResearchSupportingSource[];
}

const EXTERNAL_FACT_RE =
  /\b(compare|best|which|option|options|versus|vs\.?|tradeoffs?|pros and cons|pros|cons|research|look into|report back|summarize|summarise|explain|deciding|before deciding)\b/i;
const PERSONAL_CONTEXT_RE =
  /\b(my|me|for me|using my context|my context|candace|family|household|calendar|reminder|thread|tonight|today|tomorrow|home)\b/i;
const CODE_HEAVY_RE =
  /\b(repo|repository|code|branch|commit|runtime|shell|container|logs?|cursor|operator|work cockpit)\b/i;
const SAVED_MATERIAL_RE =
  /\b(saved notes?|saved material|saved sources?|my docs|my documents|my files|my library|my notes|what did i save|already know about|what have i saved|use only my saved material|combine my notes with outside research)\b/i;
const SAVED_ONLY_RE =
  /\b(use only my saved material|only my saved material|what do my saved notes say|what did i save about|summari[sz]e what i saved|what do i already know about|what have i saved)\b/i;
const SAVED_COMBINE_RE =
  /\b(combine my notes with outside research|combine my saved material with general knowledge|use my saved material with outside research)\b/i;

function normalizeQuery(value: string): string {
  return normalizeVoicePrompt(value).replace(/\s+/g, ' ').trim();
}

function normalizeResearchTaskPrompt(prompt: string): string {
  const normalized = prompt.trim();
  const scheduledMatch = normalized.match(
    /^Send a concise reminder that "(.+?)" is scheduled for /i,
  );
  if (scheduledMatch) {
    return scheduledMatch[1]!.trim();
  }

  const reminderMatch = normalized.match(
    /^Send a concise reminder telling the user to (.+?)\.?$/i,
  );
  if (reminderMatch) {
    return reminderMatch[1]!.replace(/[.!?]+$/g, '').trim();
  }

  return normalized;
}

function buildDefaultFollowups(kind: ResearchRequestKind): string[] {
  switch (kind) {
    case 'compare':
      return [
        'Want the tradeoffs in one line?',
        'Want me to save this for later?',
      ];
    case 'recommend':
      return ['Want the tradeoffs behind that?', 'Want a shorter version?'];
    case 'deep_research':
      return ['Want the short version?', 'Want me to save this for later?'];
    default:
      return ['Want the short version?', 'Want me to save this for later?'];
  }
}

function resolveSavedMaterialMode(
  request: ResearchRequest,
  normalizedQuery: string,
): NonNullable<ResearchRequest['savedMaterialMode']> {
  if (request.savedMaterialMode) {
    return request.savedMaterialMode;
  }
  if (SAVED_COMBINE_RE.test(normalizedQuery)) {
    return 'combine';
  }
  if (SAVED_ONLY_RE.test(normalizedQuery)) {
    return 'only';
  }
  if (SAVED_MATERIAL_RE.test(normalizedQuery)) {
    return 'prefer';
  }
  return 'auto';
}

function buildKnowledgeSourceNotes(
  supportingSources: ResearchSupportingSource[],
): string[] {
  return supportingSources
    .map((source) => source.title)
    .filter(Boolean)
    .slice(0, 4);
}

function buildRouteExplanation(
  plan: ResearchPlan,
  options: {
    providerUsed?: ResearchResult['providerUsed'];
    openAiBlocked?: string;
    openAiFailed?: boolean;
    usedLocalFallback?: boolean;
    knowledgeSummary?: string;
    knowledgeCount?: number;
  } = {},
): string {
  if (options.openAiBlocked) {
    if (plan.primarySource === 'knowledge_library') {
      return options.knowledgeCount
        ? 'I started from your saved material, but the live lookup was unavailable just then, so I stayed with your saved material only.'
        : 'You asked for saved material plus live research, but the live lookup was unavailable just then.';
    }
    return options.usedLocalFallback
      ? 'This needed a live lookup, but that live lookup was unavailable just then, so I fell back to the grounded context I had.'
      : 'This needed a live lookup, but that live lookup was unavailable just then.';
  }
  if (options.openAiFailed) {
    if (plan.primarySource === 'knowledge_library') {
      return options.knowledgeCount
        ? 'I started from your saved material, but the live lookup failed, so I stayed with your saved sources only.'
        : 'I tried to combine your saved material with a live lookup, but that live lookup failed before I could add a broader answer.';
    }
    return options.usedLocalFallback
      ? 'This needed a live lookup, but the live lookup failed, so I fell back to the grounded context I had.'
      : 'This needed a live lookup, but the live lookup failed before I could produce a trustworthy answer.';
  }
  if (plan.primarySource === 'runtime_delegate') {
    return 'This request belongs on the runtime or operator lane because it is execution-heavy.';
  }
  if (plan.primarySource === 'knowledge_library') {
    if (options.providerUsed === 'hybrid') {
      return 'I started from your saved material and combined it with broader outside research because you asked for both.';
    }
    if (options.providerUsed === 'openai_responses') {
      return options.knowledgeCount
        ? 'I started from your saved material and then added outside research where it helped clarify the answer.'
        : 'I checked your saved material first, did not find a strong match, and then used outside research for the broader answer.';
    }
    return options.knowledgeCount
      ? 'I used your saved material because you asked for source-grounded guidance from your library.'
      : 'I stayed with your saved material request, but I did not find a strong match in the current library.';
  }
  if (options.providerUsed === 'hybrid') {
    return 'I used Andrea local context plus OpenAI-backed synthesis because the question mixed personal context with a broader comparison.';
  }
  if (options.providerUsed === 'openai_responses') {
    return plan.sources.webSearch
      ? 'I used OpenAI-backed research with web search because this was outward-facing or comparison-heavy.'
      : 'I used OpenAI-backed synthesis because this needed broader reasoning than local context alone.';
  }
  return plan.sources.localContext
    ? 'I used Andrea local context because this sounded personal and grounded in your existing threads, tasks, reminders, or calendar.'
    : 'I stayed with the shared research layer without bringing in external tools.';
}

interface OpenAiResearchProviderFailure {
  providerFailure: string;
  debugPath: string[];
}

function buildResearchText(
  summaryText: string,
  sections: ResearchFindingSection[],
  recommendationText?: string,
  routeExplanation?: string,
): string {
  const lines = [summaryText.trim()];
  for (const section of sections) {
    if (!section.items.length) continue;
    lines.push('', `${section.title}:`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }
  if (recommendationText) {
    lines.push('', `Recommendation: ${recommendationText}`);
  }
  if (routeExplanation) {
    lines.push('', `Why this route: ${routeExplanation}`);
  }
  return lines.join('\n').trim();
}

function buildSpokenResearchText(
  summaryText: string,
  options: {
    recommendationText?: string;
    firstFinding?: string;
  } = {},
): string {
  const parts = [summaryText.trim()];
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const stripLeadIn = (value: string) =>
    value
      .replace(/^start with\s+/i, '')
      .replace(/^the best next move is\s+/i, '')
      .trim();
  if (
    options.recommendationText &&
    !normalize(summaryText).includes(normalize(options.recommendationText)) &&
    !normalize(summaryText).includes(
      normalize(stripLeadIn(options.recommendationText)),
    )
  ) {
    parts.push(options.recommendationText.trim());
  } else if (options.firstFinding) {
    parts.push(options.firstFinding.trim());
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function buildResearchBlockerResult(
  request: ResearchRequest,
  plan: ResearchPlan,
  blocker: string,
  debugPath: string[],
): ResearchResult {
  const summaryText = buildGracefulDegradedReply({
    kind: 'research_unavailable',
    channel: request.channel,
    text: request.query,
    hasGroundedAlternative:
      plan.primarySource === 'knowledge_library' || plan.sources.localContext,
  });
  return {
    handled: true,
    kind: plan.kind,
    plan,
    summaryText,
    spokenText: summaryText,
    fullText: `${summaryText}\n\nWhy this route: ${buildRouteExplanation(plan, {
      openAiBlocked: blocker,
    })}`,
    sourceNotes: [`blocked: ${blocker}`],
    routeExplanation: buildRouteExplanation(plan, {
      openAiBlocked: blocker,
    }),
    structuredFindings: [],
    followupSuggestions:
      request.channel === 'alexa' ? [] : buildDefaultFollowups(plan.kind),
    debugPath,
  };
}

export function isResearchPrompt(text: string): boolean {
  const normalized = normalizeQuery(text).toLowerCase();
  if (!normalized) return false;
  return (
    /^(research|look into|compare|summarize|summarise|explain the tradeoffs|what'?s the best choice|what is the best choice|what should i know before deciding|what are the pros and cons)\b/.test(
      normalized,
    ) ||
    /\b(report back|tradeoffs?|compare options|summarize findings|summarise findings|pros and cons|before deciding)\b/.test(
      normalized,
    ) ||
    isResearchEligibleConversationalPrompt(normalized)
  );
}

export function planResearchRequest(request: ResearchRequest): ResearchPlan {
  const query = normalizeQuery(request.query);
  const lower = query.toLowerCase();
  const savedMaterialMode = resolveSavedMaterialMode(request, lower);
  const kind: ResearchRequestKind =
    /\b(compare|versus|vs\.?|tradeoffs?|pros and cons|pros|cons)\b/i.test(lower)
      ? 'compare'
      : /\b(best choice|recommend|which should i|what should i pick|what should i know before deciding|before deciding|why)\b/i.test(
            lower,
          )
        ? 'recommend'
        : /\b(research|look into|report back|deep dive|explain the tradeoffs)\b/i.test(
              lower,
            )
          ? 'deep_research'
          : 'summary';

  const needsRuntimeDelegate = CODE_HEAVY_RE.test(lower);
  const savedMaterialRequested =
    savedMaterialMode !== 'auto' ||
    SAVED_MATERIAL_RE.test(lower) ||
    Boolean(request.requestedSourceIds?.length);
  const currentNewsLikely =
    /\b(news|headlines|latest news|news today|today'?s news)\b/i.test(lower);
  const liveLookupLikely = isLiveLookupConversationalPrompt(lower);
  const personalContextLikely =
    PERSONAL_CONTEXT_RE.test(lower) && !currentNewsLikely && !liveLookupLikely;
  const externalLikely =
    (currentNewsLikely ||
      liveLookupLikely ||
      EXTERNAL_FACT_RE.test(lower) ||
      isResearchEligibleConversationalPrompt(lower)) &&
    !personalContextLikely;
  const synthesisHeavy =
    kind !== 'summary' ||
    /\b(report back|research|look into|what matters|before deciding)\b/i.test(
      lower,
    );
  const mixedContextLikely =
    personalContextLikely &&
    /\b(compare|best choice|recommend|tradeoffs?|before deciding|pros and cons)\b/i.test(
      lower,
    ) &&
    /\b(option|options|service|tool|product|delivery|subscription|plan|plans)\b/i.test(
      lower,
    );
  const shouldUseOpenAi =
    savedMaterialMode === 'combine' ||
    externalLikely ||
    mixedContextLikely ||
    (!personalContextLikely && synthesisHeavy);
  const shouldUseLocalContext =
    Boolean(request.groupFolder) &&
    (personalContextLikely ||
      mixedContextLikely ||
      /\b(using my context|my context|for me)\b/i.test(lower) ||
      !shouldUseOpenAi);
  const shouldUseKnowledgeLibrary = savedMaterialRequested;

  const sources: ResearchSourceSet = {
    localContext: shouldUseKnowledgeLibrary ? false : shouldUseLocalContext,
    knowledgeLibrary: shouldUseKnowledgeLibrary,
    openAiResponses: shouldUseKnowledgeLibrary
      ? savedMaterialMode === 'combine'
      : shouldUseOpenAi,
    runtimeDelegate: needsRuntimeDelegate,
    webSearch: Boolean(
      request.allowWebSearch ??
      ((shouldUseKnowledgeLibrary
        ? savedMaterialMode === 'combine'
        : shouldUseOpenAi) &&
        (externalLikely ||
          /\b(current|latest|today|this week)\b/i.test(lower))),
    ),
  };

  if (needsRuntimeDelegate) {
    return {
      kind,
      primarySource: 'runtime_delegate',
      reason: 'the request looks execution-heavy or operator-oriented',
      sources,
      needsTelegramHandoff: request.channel === 'alexa',
    };
  }

  if (shouldUseKnowledgeLibrary) {
    return {
      kind,
      primarySource: 'knowledge_library',
      reason:
        savedMaterialMode === 'combine'
          ? 'the request explicitly asked to combine saved material with outside research'
          : 'the request explicitly asked about saved notes or library material',
      sources,
      needsTelegramHandoff:
        request.channel === 'alexa' &&
        (kind !== 'summary' || savedMaterialMode === 'combine'),
    };
  }

  if (shouldUseOpenAi) {
    return {
      kind,
      primarySource: 'openai_responses',
      reason: shouldUseLocalContext
        ? 'the request is broader than local context alone, but your context may still matter'
        : sources.webSearch
          ? 'the request is outward-facing or comparison-heavy and benefits from a web-backed model answer'
          : 'the request benefits from model synthesis beyond local context alone',
      sources,
      needsTelegramHandoff:
        request.channel === 'alexa' &&
        (kind !== 'summary' || sources.webSearch),
    };
  }

  return {
    kind,
    primarySource: 'local_context',
    reason: request.groupFolder
      ? 'the request sounds personal and can be answered from Andrea local context'
      : 'the request can stay in the shared local research path',
    sources,
    needsTelegramHandoff: false,
  };
}

async function collectLocalResearchContext(
  request: ResearchRequest,
): Promise<LocalResearchContext> {
  if (!request.groupFolder) {
    return {
      threadLines: [],
      taskLines: [],
      calendarLines: [],
      memoryLines: [],
    };
  }

  const now = request.now ?? new Date();
  const snapshot = buildLifeThreadSnapshot({
    groupFolder: request.groupFolder,
    now,
  });
  const threadCandidates = [
    ...snapshot.dueFollowups,
    ...snapshot.activeThreads.filter(
      (thread) => thread.surfaceMode !== 'manual_only',
    ),
  ];
  const threadLines = threadCandidates.slice(0, 3).map((thread) => {
    const focus = thread.nextAction || thread.summary;
    return `${thread.title}: ${focus}`;
  });

  const taskLines = getAllTasks()
    .filter(
      (task) =>
        task.group_folder === request.groupFolder && task.status === 'active',
    )
    .slice(0, 3)
    .map((task) => normalizeResearchTaskPrompt(task.prompt))
    .filter(Boolean);

  const memoryLines = listProfileFactsForGroup(request.groupFolder, [
    'accepted',
  ])
    .slice(0, 3)
    .map((fact) => fact.sourceSummary.trim())
    .filter(Boolean);

  const calendarConfig = resolveGoogleCalendarConfig();
  let calendarLines: string[] = [];
  if (
    calendarConfig.accessToken &&
    (calendarConfig.refreshToken ||
      (calendarConfig.clientId && calendarConfig.clientSecret))
  ) {
    try {
      const end = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
      const calendar = await listGoogleCalendarEvents(
        { start: now, end, calendarIds: calendarConfig.calendarIds },
        calendarConfig,
      );
      calendarLines = calendar.events.slice(0, 3).map((event) => {
        const start = event.allDay
          ? 'all day'
          : new Date(event.startIso).toLocaleString('en-US', {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: TIMEZONE,
            });
        return `${event.title} at ${start}`;
      });
    } catch (err) {
      logger.debug({ err }, 'Research orchestrator skipped calendar context');
    }
  }

  return {
    threadLines,
    taskLines,
    calendarLines,
    memoryLines,
  };
}

function buildKnowledgeContextBlock(
  search: KnowledgeSearchResult,
): KnowledgeResearchContext {
  const seen = new Set<string>();
  const supportingSources: ResearchSupportingSource[] = [];
  for (const hit of search.hits) {
    const key = hit.sourceId || `${hit.sourceTitle}:${hit.excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    supportingSources.push({
      origin: 'knowledge_library',
      title: hit.sourceTitle,
      sourceId: hit.sourceId,
      sourceType: hit.sourceType,
      scope: hit.scope,
      excerpt: hit.excerpt,
      retrievalScore: hit.retrievalScore,
      matchReason: hit.matchReason,
    });
    if (supportingSources.length >= 5) {
      break;
    }
  }

  const sourceLines = supportingSources.map((source, index) => {
    const label = source.sourceType
      ? `${source.title} (${source.sourceType.replace(/_/g, ' ')})`
      : source.title;
    return `${index + 1}. ${label}: ${source.excerpt || ''}`.trim();
  });

  return {
    search,
    contextBlock: sourceLines.join('\n'),
    supportingSources,
  };
}

function summarizeKnowledgeResearch(
  request: ResearchRequest,
  plan: ResearchPlan,
  knowledge: KnowledgeResearchContext,
  options: {
    routeExplanation?: string;
    note?: string;
  } = {},
): ResearchResult {
  const supportingSources = knowledge.supportingSources;
  if (supportingSources.length === 0) {
    const summaryText =
      request.channel === 'alexa'
        ? 'I do not have saved material on that yet.'
        : 'I do not have saved material on that yet.';
    return {
      handled: true,
      kind: plan.kind,
      plan,
      summaryText,
      spokenText: summaryText,
      fullText: `${summaryText}\n\nWhy this route: ${
        options.routeExplanation ||
        buildRouteExplanation(plan, { knowledgeCount: 0 })
      }`,
      sourceNotes: ['no matching saved sources'],
      providerUsed: 'knowledge_library',
      routeExplanation:
        options.routeExplanation ||
        buildRouteExplanation(plan, { knowledgeCount: 0 }),
      structuredFindings: [],
      followupSuggestions:
        request.channel === 'alexa'
          ? ['Want me to save something on this topic first?']
          : ['Want me to save a note or research result on this topic?'],
      debugPath: [...knowledge.search.debugPath, 'knowledge.summary:no_hits'],
      supportingSources: [],
    };
  }

  const top = supportingSources[0]!;
  const summaryLead =
    plan.kind === 'compare'
      ? `From your saved material, the clearest contrast starts with ${top.title}.`
      : plan.kind === 'recommend'
        ? `From your saved material, the strongest signal points to ${top.title}.`
        : `From your saved material, the main takeaway starts with ${top.title}.`;
  const summaryTail = top.excerpt ? ` ${top.excerpt}` : '';
  const summaryText = `${summaryLead}${summaryTail}`.trim();
  const spokenExcerpt = top.excerpt
    ? top.excerpt
        .replace(/\s+/g, ' ')
        .replace(/^#+\s*/g, '')
        .trim()
        .slice(0, 140)
        .trimEnd()
    : '';
  const spokenSummaryText = [summaryLead, spokenExcerpt]
    .filter(Boolean)
    .join(' ');
  const structuredFindings: ResearchFindingSection[] = [
    {
      title:
        plan.kind === 'compare' ? 'Saved sources compared' : 'Saved material',
      items: supportingSources
        .slice(0, 4)
        .map((source) =>
          source.excerpt ? `${source.title}: ${source.excerpt}` : source.title,
        ),
    },
  ];
  const recommendationText =
    plan.kind === 'recommend'
      ? `Start with ${top.title}. That source carries the strongest saved signal here.`
      : undefined;
  const routeExplanation =
    options.routeExplanation ||
    buildRouteExplanation(plan, {
      providerUsed: 'knowledge_library',
      knowledgeCount: supportingSources.length,
    });

  return {
    handled: true,
    kind: plan.kind,
    plan,
    providerUsed: 'knowledge_library',
    summaryText,
    spokenText:
      request.channel === 'alexa'
        ? buildSpokenResearchText(spokenSummaryText, {
            recommendationText:
              plan.kind === 'recommend' ? recommendationText : undefined,
          })
        : undefined,
    fullText: buildResearchText(
      summaryText,
      structuredFindings,
      recommendationText,
      routeExplanation,
    ),
    sourceNotes: [
      'knowledge library',
      ...buildKnowledgeSourceNotes(supportingSources),
      options.note || '',
    ].filter(Boolean),
    routeExplanation,
    structuredFindings,
    followupSuggestions: [
      'Want the saved sources I used?',
      ...(request.channel === 'telegram'
        ? ['Want me to combine that with outside research?']
        : ['I can send the fuller source list to Telegram if you want.']),
    ],
    saveForLaterCandidate: summaryText,
    debugPath: [...knowledge.search.debugPath, 'knowledge.summary:grounded'],
    recommendationText,
    supportingSources,
    handoffOption:
      request.channel === 'alexa' &&
      (plan.kind !== 'summary' || supportingSources.length > 2)
        ? {
            channel: 'telegram',
            reason:
              'the saved source detail is richer than a spoken answer should be',
            prompt: request.query,
          }
        : undefined,
  };
}

function summarizeLocalResearch(
  request: ResearchRequest,
  context: LocalResearchContext,
  plan: ResearchPlan,
  options: {
    routeExplanation?: string;
    debugPath?: string[];
    sourceNotes?: string[];
  } = {},
): ResearchResult {
  const structuredFindings: ResearchFindingSection[] = [
    { title: 'Open loops', items: context.threadLines.slice(0, 2) },
    { title: 'Active tasks', items: context.taskLines.slice(0, 2) },
    { title: 'Upcoming', items: context.calendarLines.slice(0, 2) },
    { title: 'Context', items: context.memoryLines.slice(0, 2) },
  ].filter((section) => section.items.length > 0);

  const lines = structuredFindings.flatMap((section) => section.items);
  if (lines.length === 0) {
    return {
      handled: false,
      kind: plan.kind,
      plan,
      sourceNotes: ['no local context signals were available'],
      routeExplanation:
        options.routeExplanation ||
        'Andrea did not have enough grounded local context to answer that well.',
      structuredFindings: [],
      followupSuggestions: [],
      debugPath: options.debugPath || ['research.local_context:empty'],
    };
  }

  const leadItem = lines[0]!;
  const summaryText =
    plan.kind === 'compare'
      ? `From your current context, the clearest tradeoff starts with ${leadItem}.`
      : plan.kind === 'recommend'
        ? `From your current context, the strongest next move is ${leadItem}.`
        : `From your current context, the main thing is ${leadItem}.`;
  const recommendationText =
    plan.kind === 'compare'
      ? `Start with ${leadItem}.`
      : plan.kind === 'recommend'
        ? `Start with ${leadItem}.`
        : undefined;
  const routeExplanation =
    options.routeExplanation ||
    buildRouteExplanation(plan, { providerUsed: 'local_context' });

  return {
    handled: true,
    kind: plan.kind,
    plan,
    providerUsed: 'local_context',
    summaryText,
    spokenText: buildSpokenResearchText(summaryText, {
      recommendationText,
      firstFinding: plan.kind === 'compare' ? undefined : lines[1],
    }),
    fullText: buildResearchText(
      summaryText,
      structuredFindings,
      recommendationText,
      routeExplanation,
    ),
    recommendationText,
    routeExplanation,
    structuredFindings,
    followupSuggestions: buildDefaultFollowups(plan.kind),
    saveForLaterCandidate: summaryText,
    sourceNotes: [
      context.threadLines.length ? 'life threads' : '',
      context.taskLines.length ? 'scheduled tasks' : '',
      context.calendarLines.length ? 'calendar' : '',
      context.memoryLines.length ? 'personalization memory' : '',
      ...(options.sourceNotes || []),
    ].filter(Boolean),
    debugPath: options.debugPath || ['research.local_context:grounded'],
  };
}

function collectKnowledgeLibraryContext(
  request: ResearchRequest,
): KnowledgeResearchContext | null {
  if (!request.groupFolder) {
    return null;
  }
  const search = searchKnowledgeLibrary({
    groupFolder: request.groupFolder,
    query: request.query,
    requestedSourceIds: request.requestedSourceIds,
    limit:
      request.requestedDepth === 'deep'
        ? 8
        : request.channel === 'alexa'
          ? 4
          : 6,
  });
  return buildKnowledgeContextBlock(search);
}

function extractResponseOutputText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };
  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    return record.output_text.trim();
  }
  const text = record.output
    ?.flatMap((item) => item.content || [])
    .map((content) =>
      content.type === 'output_text' ? content.text || '' : '',
    )
    .join('\n')
    .trim();
  return text || '';
}

function parseOpenAiResearchOutput(
  output: string,
  kind: ResearchRequestKind,
): {
  summaryText: string;
  findings: string[];
  recommendationText?: string;
  followupSuggestions: string[];
} {
  const lines = output.split(/\r?\n/);
  const findings: string[] = [];
  const followups: string[] = [];
  let summaryText = '';
  let recommendationText = '';
  let section: 'summary' | 'findings' | 'recommendation' | 'followups' | null =
    null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^summary:/i.test(line)) {
      section = 'summary';
      summaryText = line.replace(/^summary:\s*/i, '').trim();
      continue;
    }
    if (/^findings:/i.test(line)) {
      section = 'findings';
      continue;
    }
    if (/^recommendation:/i.test(line)) {
      section = 'recommendation';
      recommendationText = line.replace(/^recommendation:\s*/i, '').trim();
      continue;
    }
    if (/^follow-?ups?:/i.test(line)) {
      section = 'followups';
      continue;
    }

    const bullet = line.replace(/^[-*]\s+/, '').trim();
    if (section === 'findings') {
      findings.push(bullet);
      continue;
    }
    if (section === 'followups') {
      followups.push(bullet);
      continue;
    }
    if (section === 'recommendation') {
      recommendationText = [recommendationText, line]
        .filter(Boolean)
        .join(' ')
        .trim();
      continue;
    }
    if (section === 'summary') {
      summaryText = [summaryText, line].filter(Boolean).join(' ').trim();
      continue;
    }
  }

  if (!summaryText) {
    summaryText =
      output
        .split(/(?<=[.!?])\s+/)
        .slice(0, 2)
        .join(' ')
        .trim() || output;
  }
  if (findings.length === 0) {
    findings.push(
      ...output
        .split(/(?<=[.!?])\s+/)
        .slice(1, 4)
        .filter(Boolean),
    );
  }
  if (!recommendationText || /^none$/i.test(recommendationText)) {
    recommendationText = '';
  }

  return {
    summaryText,
    findings: findings.slice(0, 4),
    recommendationText: recommendationText || undefined,
    followupSuggestions: followups.length
      ? followups.slice(0, 3)
      : buildDefaultFollowups(kind),
  };
}

async function runOpenAiResearch(
  request: ResearchRequest,
  plan: ResearchPlan,
  context: LocalResearchContext,
  knowledge?: KnowledgeResearchContext | null,
): Promise<ResearchResult | OpenAiResearchProviderFailure | null> {
  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) return null;

  const localContextBlock = [
    plan.sources.localContext && context.threadLines.length
      ? `Life threads:\n- ${context.threadLines.join('\n- ')}`
      : '',
    plan.sources.localContext && context.taskLines.length
      ? `Active tasks:\n- ${context.taskLines.join('\n- ')}`
      : '',
    plan.sources.localContext && context.calendarLines.length
      ? `Upcoming calendar:\n- ${context.calendarLines.join('\n- ')}`
      : '',
    plan.sources.localContext && context.memoryLines.length
      ? `Relevant preferences:\n- ${context.memoryLines.join('\n- ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const synthesisPrompt = [
    'You are Andrea, a calm capable personal assistant doing bounded research.',
    `Answer this for ${request.channel === 'alexa' ? 'voice-first delivery' : 'Telegram chat delivery'}.`,
    request.channel === 'alexa'
      ? 'Keep the summary concise and spoken-style.'
      : 'Keep the answer structured, readable, and useful.',
    'Do not mention internal tools or implementation details.',
    'Return plain text in exactly this shape:',
    'Summary: <one or two sentences>',
    'Findings:',
    '- <2 to 4 short findings>',
    'Recommendation: <one sentence or None>',
    'Follow-ups:',
    '- <1 to 3 short next questions or handoffs>',
    localContextBlock
      ? `Use this personal context only when it genuinely helps:\n${localContextBlock}`
      : '',
    knowledge?.contextBlock
      ? `Use this saved source material when it genuinely helps, and keep it distinct from outside knowledge:\n${knowledge.contextBlock}`
      : '',
    `User request: ${normalizeQuery(request.query)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const body: Record<string, unknown> = {
    model: openAi.researchModel,
    input: synthesisPrompt,
  };
  if (plan.sources.webSearch) {
    body.tools = [
      {
        type: 'web_search',
      },
    ];
  }

  try {
    const response = await fetch(`${openAi.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAi.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const requestId = response.headers.get('x-request-id') || undefined;
    if (!response.ok) {
      const text = await response.text();
      const providerFailure = describeOpenAiProviderFailure(
        response.status,
        text,
        'research',
      );
      logger.warn(
        {
          status: response.status,
          requestId,
          body: text.slice(0, 400),
        },
        'Research orchestrator OpenAI call failed',
      );
      return {
        providerFailure,
        debugPath: [
          `plan.primary=${plan.primarySource}`,
          'openai.failed=true',
          `provider_failure=${providerFailure}`,
          response.status ? `status=${response.status}` : 'status=unknown',
          requestId ? `request_id=${requestId}` : 'request_id=missing',
        ],
      };
    }
    const payload = (await response.json()) as unknown;
    const output = extractResponseOutputText(payload);
    if (!output) {
      return null;
    }

    const parsed = parseOpenAiResearchOutput(output, plan.kind);
    const routeExplanation = buildRouteExplanation(plan, {
      providerUsed:
        (plan.sources.localContext && localContextBlock) ||
        knowledge?.supportingSources.length
          ? 'hybrid'
          : 'openai_responses',
      knowledgeCount: knowledge?.supportingSources.length || 0,
    });
    return {
      handled: true,
      kind: plan.kind,
      plan,
      providerUsed:
        (plan.sources.localContext && localContextBlock) ||
        knowledge?.supportingSources.length
          ? 'hybrid'
          : 'openai_responses',
      summaryText: parsed.summaryText,
      spokenText: buildSpokenResearchText(parsed.summaryText, {
        recommendationText:
          request.channel === 'alexa' ? parsed.recommendationText : undefined,
        firstFinding:
          request.channel === 'alexa' ? parsed.findings[0] : undefined,
      }),
      fullText: buildResearchText(
        parsed.summaryText,
        parsed.findings.length
          ? [
              {
                title: plan.kind === 'compare' ? 'Tradeoffs' : 'Findings',
                items: parsed.findings,
              },
            ]
          : [],
        parsed.recommendationText,
        routeExplanation,
      ),
      recommendationText: parsed.recommendationText,
      routeExplanation,
      structuredFindings: parsed.findings.length
        ? [
            {
              title: plan.kind === 'compare' ? 'Tradeoffs' : 'Findings',
              items: parsed.findings,
            },
          ]
        : [],
      followupSuggestions: parsed.followupSuggestions,
      saveForLaterCandidate: parsed.summaryText,
      sourceNotes: [
        plan.sources.localContext && localContextBlock ? 'local context' : '',
        knowledge?.supportingSources.length ? 'knowledge library' : '',
        plan.sources.webSearch
          ? 'OpenAI web search'
          : 'OpenAI Responses synthesis',
      ].filter(Boolean),
      handoffOption:
        plan.needsTelegramHandoff && request.channel === 'alexa'
          ? {
              channel: 'telegram',
              reason: 'the result is richer than a spoken answer should be',
              prompt: normalizeQuery(request.query),
            }
          : undefined,
      debugPath: [
        `plan.primary=${plan.primarySource}`,
        `provider=${
          (plan.sources.localContext && localContextBlock) ||
          knowledge?.supportingSources.length
            ? 'hybrid'
            : 'openai_responses'
        }`,
        ...(knowledge?.search.debugPath || []),
        plan.sources.webSearch ? 'tool=web_search' : 'tool=none',
        requestId ? `request_id=${requestId}` : 'request_id=missing',
      ],
      supportingSources: knowledge?.supportingSources || [],
    };
  } catch (err) {
    logger.warn({ err }, 'Research orchestrator OpenAI request errored');
    return {
      providerFailure:
        'The live OpenAI research request errored before Andrea could produce a trustworthy answer.',
      debugPath: [
        `plan.primary=${plan.primarySource}`,
        'openai.failed=true',
        'request_exception=true',
      ],
    };
  }
}

export async function runResearchOrchestrator(
  request: ResearchRequest,
): Promise<ResearchResult> {
  const normalized = normalizeQuery(request.query);
  const normalizedRequest = { ...request, query: normalized };
  const plan = planResearchRequest(normalizedRequest);

  if (!normalized) {
    return {
      handled: false,
      kind: plan.kind,
      plan,
      sourceNotes: ['empty query'],
      routeExplanation: 'There was no research question to route.',
      structuredFindings: [],
      followupSuggestions: [],
      debugPath: ['research.empty_query'],
    };
  }

  if (plan.primarySource === 'runtime_delegate') {
    return {
      handled: false,
      kind: plan.kind,
      plan,
      sourceNotes: ['request should stay on the runtime or operator lane'],
      routeExplanation: buildRouteExplanation(plan),
      structuredFindings: [],
      followupSuggestions: [],
      debugPath: ['research.runtime_delegate'],
    };
  }

  const context =
    plan.sources.localContext || plan.primarySource === 'openai_responses'
      ? await collectLocalResearchContext(normalizedRequest)
      : {
          threadLines: [],
          taskLines: [],
          calendarLines: [],
          memoryLines: [],
        };
  const knowledgeContext =
    plan.sources.knowledgeLibrary || plan.primarySource === 'knowledge_library'
      ? collectKnowledgeLibraryContext(normalizedRequest)
      : null;

  if (plan.primarySource === 'knowledge_library') {
    if (!normalizedRequest.groupFolder) {
      return {
        handled: true,
        kind: plan.kind,
        plan,
        summaryText:
          normalizedRequest.channel === 'alexa'
            ? 'I can only use saved material when I have your linked library context.'
            : 'I can only use saved library material when this conversation is tied to one of your Andrea group folders.',
        spokenText:
          normalizedRequest.channel === 'alexa'
            ? 'I can only use saved material when I have your linked library context.'
            : undefined,
        fullText:
          'I can only use saved library material when this conversation is tied to one of your Andrea group folders.',
        sourceNotes: ['knowledge library unavailable without group context'],
        routeExplanation:
          'You asked for saved material, but this request did not have a linked Andrea library scope.',
        structuredFindings: [],
        followupSuggestions: [],
        debugPath: [
          'plan.primary=knowledge_library',
          'knowledge.blocked=no_group_folder',
        ],
        providerUsed: 'knowledge_library',
      };
    }

    const groundedKnowledge =
      knowledgeContext ||
      buildKnowledgeContextBlock(
        searchKnowledgeLibrary({
          groupFolder: normalizedRequest.groupFolder,
          query: normalizedRequest.query,
          requestedSourceIds: normalizedRequest.requestedSourceIds,
        }),
      );

    if (!plan.sources.openAiResponses) {
      return summarizeKnowledgeResearch(
        normalizedRequest,
        plan,
        groundedKnowledge,
      );
    }

    const openAiStatus = getOpenAiProviderStatus();
    if (!openAiStatus.configured) {
      const blocker = describeOpenAiConfigBlocker(openAiStatus.missing);
      if (groundedKnowledge.supportingSources.length > 0) {
        return summarizeKnowledgeResearch(
          normalizedRequest,
          plan,
          groundedKnowledge,
          {
            routeExplanation: buildRouteExplanation(plan, {
              openAiBlocked: blocker,
              knowledgeCount: groundedKnowledge.supportingSources.length,
            }),
            note: `OpenAI unavailable: ${blocker}`,
          },
        );
      }
      return buildResearchBlockerResult(normalizedRequest, plan, blocker, [
        'plan.primary=knowledge_library',
        `openai.blocked=${openAiStatus.missing.join(',') || 'unknown'}`,
      ]);
    }

    const openAiKnowledgeResult = await runOpenAiResearch(
      normalizedRequest,
      plan,
      context,
      groundedKnowledge,
    );
    if (
      openAiKnowledgeResult &&
      !('providerFailure' in openAiKnowledgeResult)
    ) {
      return openAiKnowledgeResult;
    }

    const providerFailure =
      openAiKnowledgeResult && 'providerFailure' in openAiKnowledgeResult
        ? openAiKnowledgeResult.providerFailure
        : 'the outside research step failed before Andrea could combine it with your saved material';
    const providerDebugPath =
      openAiKnowledgeResult && 'providerFailure' in openAiKnowledgeResult
        ? openAiKnowledgeResult.debugPath
        : ['plan.primary=knowledge_library', 'openai.failed=true'];

    if (groundedKnowledge.supportingSources.length > 0) {
      return summarizeKnowledgeResearch(
        normalizedRequest,
        plan,
        groundedKnowledge,
        {
          routeExplanation: buildRouteExplanation(plan, {
            openAiFailed: true,
            knowledgeCount: groundedKnowledge.supportingSources.length,
          }),
          note: `OpenAI request failed: ${providerFailure}`,
        },
      );
    }

    return buildResearchBlockerResult(
      normalizedRequest,
      plan,
      providerFailure,
      providerDebugPath,
    );
  }

  if (plan.primarySource === 'openai_responses') {
    const openAiStatus = getOpenAiProviderStatus();
    if (!openAiStatus.configured) {
      const blocker = describeOpenAiConfigBlocker(openAiStatus.missing);
      if (plan.sources.localContext) {
        const localFallback = summarizeLocalResearch(request, context, plan, {
          routeExplanation: buildRouteExplanation(plan, {
            openAiBlocked: blocker,
            usedLocalFallback: true,
          }),
          debugPath: [
            `plan.primary=${plan.primarySource}`,
            `openai.blocked=${openAiStatus.missing.join(',') || 'unknown'}`,
            'fallback=local_context',
          ],
          sourceNotes: [`OpenAI unavailable: ${blocker}`],
        });
        if (localFallback.handled) {
          return localFallback;
        }
      }

      return buildResearchBlockerResult(request, plan, blocker, [
        `plan.primary=${plan.primarySource}`,
        `openai.blocked=${openAiStatus.missing.join(',') || 'unknown'}`,
      ]);
    }

    const openAiResult = await runOpenAiResearch(
      normalizedRequest,
      plan,
      context,
    );
    if (openAiResult && !('providerFailure' in openAiResult)) {
      return openAiResult;
    }

    const providerFailure =
      openAiResult && 'providerFailure' in openAiResult
        ? openAiResult.providerFailure
        : 'the live OpenAI research request failed and there was no strong local fallback';
    const providerDebugPath =
      openAiResult && 'providerFailure' in openAiResult
        ? openAiResult.debugPath
        : [`plan.primary=${plan.primarySource}`, 'openai.failed=true'];

    if (plan.sources.localContext) {
      const localFallback = summarizeLocalResearch(request, context, plan, {
        routeExplanation: buildRouteExplanation(plan, {
          openAiFailed: true,
          usedLocalFallback: true,
        }),
        debugPath: [...providerDebugPath, 'fallback=local_context'],
        sourceNotes: [`OpenAI request failed: ${providerFailure}`],
      });
      if (localFallback.handled) {
        return localFallback;
      }
    }

    return buildResearchBlockerResult(
      normalizedRequest,
      plan,
      providerFailure,
      providerDebugPath,
    );
  }

  return summarizeLocalResearch(normalizedRequest, context, plan, {
    routeExplanation: buildRouteExplanation(plan, {
      providerUsed: 'local_context',
    }),
    debugPath: ['plan.primary=local_context'],
  });
}
