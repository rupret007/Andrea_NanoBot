import { TIMEZONE } from './config.js';
import { getAllTasks, listProfileFactsForGroup } from './db.js';
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
import { normalizeVoicePrompt } from './voice-ready.js';

export type ResearchRequestKind =
  | 'summary'
  | 'compare'
  | 'recommend'
  | 'deep_research';

export type ResearchSourceName =
  | 'local_context'
  | 'openai_responses'
  | 'runtime_delegate';

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
}

export interface ResearchSourceSet {
  localContext: boolean;
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

export interface ResearchResult {
  handled: boolean;
  kind: ResearchRequestKind;
  plan: ResearchPlan;
  spokenText?: string;
  summaryText?: string;
  fullText?: string;
  sourceNotes: string[];
  handoffOption?: ResearchHandoffOption;
  providerUsed?: 'local_context' | 'openai_responses' | 'hybrid';
  routeExplanation: string;
  structuredFindings: ResearchFindingSection[];
  followupSuggestions: string[];
  saveForLaterCandidate?: string;
  debugPath: string[];
  recommendationText?: string;
}

interface LocalResearchContext {
  threadLines: string[];
  taskLines: string[];
  calendarLines: string[];
  memoryLines: string[];
}

const EXTERNAL_FACT_RE =
  /\b(compare|best|which|option|options|versus|vs\.?|tradeoffs?|pros and cons|pros|cons|research|look into|report back|summarize|summarise|explain|deciding|before deciding)\b/i;
const PERSONAL_CONTEXT_RE =
  /\b(my|me|for me|using my context|my context|candace|family|household|calendar|reminder|thread|tonight|today|tomorrow|home)\b/i;
const CODE_HEAVY_RE =
  /\b(repo|repository|code|branch|commit|runtime|shell|container|logs?|cursor|operator|work cockpit)\b/i;

function normalizeQuery(value: string): string {
  return normalizeVoicePrompt(value).replace(/\s+/g, ' ').trim();
}

function buildDefaultFollowups(kind: ResearchRequestKind): string[] {
  switch (kind) {
    case 'compare':
      return ['Want the tradeoffs in one line?', 'Want me to save this for later?'];
    case 'recommend':
      return ['Want the tradeoffs behind that?', 'Want a shorter version?'];
    case 'deep_research':
      return ['Want the short version?', 'Want me to save this for later?'];
    default:
      return ['Want the short version?', 'Want me to save this for later?'];
  }
}

function buildRouteExplanation(
  plan: ResearchPlan,
  options: {
    providerUsed?: ResearchResult['providerUsed'];
    openAiBlocked?: string;
    openAiFailed?: boolean;
    usedLocalFallback?: boolean;
  } = {},
): string {
  if (options.openAiBlocked) {
    return options.usedLocalFallback
      ? `This looked like a web-backed research question, but Andrea's OpenAI research path is blocked because ${options.openAiBlocked.toLowerCase()} I fell back to grounded local context where I could.`
      : `This looked like a web-backed research question, but Andrea's OpenAI research path is blocked because ${options.openAiBlocked.toLowerCase()}`;
  }
  if (options.openAiFailed) {
    return options.usedLocalFallback
      ? 'This looked like a web-backed research question, but the live model call failed, so I fell back to grounded local context where possible.'
      : 'This looked like a web-backed research question, but the live model call failed before Andrea could produce a trustworthy answer.';
  }
  if (plan.primarySource === 'runtime_delegate') {
    return 'This request belongs on the runtime or operator lane because it is execution-heavy.';
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
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const stripLeadIn = (value: string) =>
    value
      .replace(/^start with\s+/i, '')
      .replace(/^the best next move is\s+/i, '')
      .trim();
  if (
    options.recommendationText &&
    !normalize(summaryText).includes(normalize(options.recommendationText)) &&
    !normalize(summaryText).includes(normalize(stripLeadIn(options.recommendationText)))
  ) {
    parts.push(options.recommendationText.trim());
  } else if (options.firstFinding) {
    parts.push(options.firstFinding.trim());
  }
  return parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildResearchBlockerResult(
  request: ResearchRequest,
  plan: ResearchPlan,
  blocker: string,
  debugPath: string[],
): ResearchResult {
  const summaryText =
    request.channel === 'alexa'
      ? 'I cannot do that live right now because my web-backed research path is unavailable here.'
      : `I cannot do that live yet because ${blocker}`;
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
    followupSuggestions: request.channel === 'alexa' ? [] : buildDefaultFollowups(plan.kind),
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
    )
  );
}

export function planResearchRequest(request: ResearchRequest): ResearchPlan {
  const query = normalizeQuery(request.query);
  const lower = query.toLowerCase();
  const kind: ResearchRequestKind = /\b(compare|versus|vs\.?|tradeoffs?|pros and cons|pros|cons)\b/i.test(
    lower,
  )
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
  const personalContextLikely = PERSONAL_CONTEXT_RE.test(lower);
  const externalLikely = EXTERNAL_FACT_RE.test(lower) && !personalContextLikely;
  const synthesisHeavy =
    kind !== 'summary' ||
    /\b(report back|research|look into|what matters|before deciding)\b/i.test(lower);
  const mixedContextLikely =
    personalContextLikely &&
    /\b(compare|best choice|recommend|tradeoffs?|before deciding|pros and cons)\b/i.test(
      lower,
    ) &&
    /\b(option|options|service|tool|product|delivery|subscription|plan|plans)\b/i.test(
      lower,
    );
  const shouldUseOpenAi =
    externalLikely || mixedContextLikely || (!personalContextLikely && synthesisHeavy);
  const shouldUseLocalContext =
    Boolean(request.groupFolder) &&
    (personalContextLikely ||
      mixedContextLikely ||
      /\b(using my context|my context|for me)\b/i.test(lower) ||
      !shouldUseOpenAi);

  const sources: ResearchSourceSet = {
    localContext: shouldUseLocalContext,
    openAiResponses: shouldUseOpenAi,
    runtimeDelegate: needsRuntimeDelegate,
    webSearch: Boolean(
      request.allowWebSearch ??
        (shouldUseOpenAi &&
          (externalLikely || /\b(current|latest|today|this week)\b/i.test(lower))),
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
        request.channel === 'alexa' && (kind !== 'summary' || sources.webSearch),
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
    ...snapshot.activeThreads.filter((thread) => thread.surfaceMode !== 'manual_only'),
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
    .map((task) => task.prompt.trim())
    .filter(Boolean);

  const memoryLines = listProfileFactsForGroup(request.groupFolder, ['accepted'])
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
    .map((content) => (content.type === 'output_text' ? content.text || '' : ''))
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
      recommendationText = [recommendationText, line].filter(Boolean).join(' ').trim();
      continue;
    }
    if (section === 'summary') {
      summaryText = [summaryText, line].filter(Boolean).join(' ').trim();
      continue;
    }
  }

  if (!summaryText) {
    summaryText = output.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim() || output;
  }
  if (findings.length === 0) {
    findings.push(...output.split(/(?<=[.!?])\s+/).slice(1, 4).filter(Boolean));
  }
  if (!recommendationText || /^none$/i.test(recommendationText)) {
    recommendationText = '';
  }

  return {
    summaryText,
    findings: findings.slice(0, 4),
    recommendationText: recommendationText || undefined,
    followupSuggestions: followups.length ? followups.slice(0, 3) : buildDefaultFollowups(kind),
  };
}

async function runOpenAiResearch(
  request: ResearchRequest,
  plan: ResearchPlan,
  context: LocalResearchContext,
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
        plan.sources.localContext && localContextBlock ? 'hybrid' : 'openai_responses',
    });
    return {
      handled: true,
      kind: plan.kind,
      plan,
      providerUsed:
        plan.sources.localContext && localContextBlock
          ? 'hybrid'
          : 'openai_responses',
      summaryText: parsed.summaryText,
      spokenText: buildSpokenResearchText(parsed.summaryText, {
        recommendationText:
          request.channel === 'alexa' ? parsed.recommendationText : undefined,
        firstFinding: request.channel === 'alexa' ? parsed.findings[0] : undefined,
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
        plan.sources.webSearch ? 'OpenAI web search' : 'OpenAI Responses synthesis',
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
        `provider=${plan.sources.localContext && localContextBlock ? 'hybrid' : 'openai_responses'}`,
        plan.sources.webSearch ? 'tool=web_search' : 'tool=none',
        requestId ? `request_id=${requestId}` : 'request_id=missing',
      ],
    };
  } catch (err) {
    logger.warn({ err }, 'Research orchestrator OpenAI request errored');
    return {
      providerFailure: 'The live OpenAI research request errored before Andrea could produce a trustworthy answer.',
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
  const plan = planResearchRequest({ ...request, query: normalized });

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

  const context = await collectLocalResearchContext(request);

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

    const openAiResult = await runOpenAiResearch(request, plan, context);
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

    return buildResearchBlockerResult(request, plan, providerFailure, providerDebugPath);
  }

  return summarizeLocalResearch(request, context, plan, {
    routeExplanation: buildRouteExplanation(plan, { providerUsed: 'local_context' }),
    debugPath: ['plan.primary=local_context'],
  });
}
