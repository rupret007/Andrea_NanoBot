import { OPENAI_MODEL_FALLBACK, TIMEZONE } from './config.js';
import { getAllTasks, listProfileFactsForGroup } from './db.js';
import { readEnvFile } from './env.js';
import { buildLifeThreadSnapshot } from './life-threads.js';
import {
  listGoogleCalendarEvents,
  resolveGoogleCalendarConfig,
} from './google-calendar.js';
import { logger } from './logger.js';
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
}

interface LocalResearchContext {
  threadLines: string[];
  taskLines: string[];
  calendarLines: string[];
  memoryLines: string[];
}

const EXTERNAL_FACT_RE =
  /\b(compare|best|which|option|options|versus|vs\.?|tradeoffs?|research|look into|report back|summarize|summarise|explain)\b/i;
const PERSONAL_CONTEXT_RE =
  /\b(my|me|for me|using my context|candace|family|household|calendar|reminder|thread|tonight|today|tomorrow|home)\b/i;
const CODE_HEAVY_RE =
  /\b(repo|repository|code|branch|commit|runtime|shell|container|logs?|cursor|operator|work cockpit)\b/i;

function normalizeQuery(value: string): string {
  return normalizeVoicePrompt(value).replace(/\s+/g, ' ').trim();
}

function getOpenAiEnv(): {
  apiKey: string;
  baseUrl: string;
  model: string;
} | null {
  const envFile = readEnvFile([
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL_FALLBACK',
  ]);
  const apiKey = (process.env.OPENAI_API_KEY || envFile.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl:
      (process.env.OPENAI_BASE_URL || envFile.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
        /\/+$/,
        '',
      ),
    model:
      (process.env.OPENAI_MODEL_FALLBACK ||
        envFile.OPENAI_MODEL_FALLBACK ||
        OPENAI_MODEL_FALLBACK).trim() || OPENAI_MODEL_FALLBACK,
  };
}

export function isResearchPrompt(text: string): boolean {
  const normalized = normalizeQuery(text).toLowerCase();
  if (!normalized) return false;
  return (
    /^(research|look into|compare|summarize|summarise|explain the tradeoffs|what'?s the best choice|what is the best choice)\b/.test(
      normalized,
    ) ||
    /\b(report back|tradeoffs?|compare options|summarize findings|summarise findings)\b/.test(
      normalized,
    )
  );
}

export function planResearchRequest(request: ResearchRequest): ResearchPlan {
  const query = normalizeQuery(request.query);
  const lower = query.toLowerCase();
  const kind: ResearchRequestKind = /\b(compare|versus|vs\.?|tradeoffs?)\b/i.test(
    lower,
  )
    ? 'compare'
    : /\b(best choice|recommend|which should i|what should i pick|why)\b/i.test(
          lower,
        )
      ? 'recommend'
      : /\b(research|look into|report back|deep dive)\b/i.test(lower)
        ? 'deep_research'
        : 'summary';

  const needsRuntimeDelegate = CODE_HEAVY_RE.test(lower);
  const personalContextLikely = PERSONAL_CONTEXT_RE.test(lower);
  const externalLikely = EXTERNAL_FACT_RE.test(lower) && !personalContextLikely;
  const openAiConfigured = Boolean(getOpenAiEnv());

  const sources: ResearchSourceSet = {
    localContext: Boolean(request.groupFolder),
    openAiResponses: openAiConfigured && (externalLikely || personalContextLikely),
    runtimeDelegate: needsRuntimeDelegate,
    webSearch: openAiConfigured && externalLikely,
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

  if (sources.openAiResponses && sources.localContext) {
    return {
      kind,
      primarySource: 'openai_responses',
      reason: 'the request benefits from both personal context and model synthesis',
      sources,
      needsTelegramHandoff:
        request.channel === 'alexa' && (kind === 'compare' || kind === 'deep_research'),
    };
  }

  if (sources.openAiResponses) {
    return {
      kind,
      primarySource: 'openai_responses',
      reason: sources.webSearch
        ? 'the request is comparative or outward-facing and benefits from a web-backed model answer'
        : 'the request benefits from model synthesis',
      sources,
      needsTelegramHandoff:
        request.channel === 'alexa' && (kind === 'compare' || kind === 'deep_research'),
    };
  }

  return {
    kind,
    primarySource: 'local_context',
    reason: request.groupFolder
      ? 'the request can be answered from Andrea local context'
      : 'there is no configured provider beyond local context',
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
): ResearchResult {
  const lines = [
    ...context.threadLines,
    ...context.taskLines,
    ...context.calendarLines,
    ...context.memoryLines,
  ].filter(Boolean);

  if (lines.length === 0) {
    return {
      handled: false,
      kind: plan.kind,
      plan,
      sourceNotes: ['no local context signals were available'],
    };
  }

  const lead =
    plan.kind === 'compare'
      ? 'Here is the grounded comparison Andrea can make from your current context.'
      : plan.kind === 'recommend'
        ? `The strongest answer from your current context is ${lines[0]}.`
        : `A couple grounded things stand out. ${lines[0]}.`;
  const remaining = lines.slice(1, 3);
  const fullText = [lead, ...remaining.map((line) => `- ${line}`)].join('\n');
  const spokenTail =
    remaining.length > 0
      ? ` ${remaining.map((line) => line.replace(/: /, ': ')).join(' ')}`
      : '';

  return {
    handled: true,
    kind: plan.kind,
    plan,
    providerUsed: 'local_context',
    summaryText: lead,
    spokenText: `${lead}${spokenTail}`.trim(),
    fullText,
    sourceNotes: [
      context.threadLines.length ? 'life threads' : '',
      context.taskLines.length ? 'scheduled tasks' : '',
      context.calendarLines.length ? 'calendar' : '',
      context.memoryLines.length ? 'personalization memory' : '',
    ].filter(Boolean),
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

async function runOpenAiResearch(
  request: ResearchRequest,
  plan: ResearchPlan,
  context: LocalResearchContext,
): Promise<ResearchResult | null> {
  const openai = getOpenAiEnv();
  if (!openai) return null;

  const localContextBlock = [
    context.threadLines.length
      ? `Life threads:\n- ${context.threadLines.join('\n- ')}`
      : '',
    context.taskLines.length
      ? `Active tasks:\n- ${context.taskLines.join('\n- ')}`
      : '',
    context.calendarLines.length
      ? `Upcoming calendar:\n- ${context.calendarLines.join('\n- ')}`
      : '',
    context.memoryLines.length
      ? `Relevant preferences:\n- ${context.memoryLines.join('\n- ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const synthesisPrompt = [
    'You are Andrea, a calm capable personal assistant.',
    `Answer this ${request.channel === 'alexa' ? 'for voice' : 'for chat'}.`,
    request.channel === 'alexa'
      ? 'Use one strong lead sentence and at most two short supporting sentences.'
      : 'Be concise but complete, and use bullets if comparison helps.',
    'Do not mention internal tools or implementation details.',
    localContextBlock
      ? `Use this personal context when it genuinely helps:\n${localContextBlock}`
      : '',
    `User request: ${normalizeQuery(request.query)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const body: Record<string, unknown> = {
    model: openai.model,
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
    const response = await fetch(`${openai.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      logger.warn(
        { status: response.status, body: text.slice(0, 400) },
        'Research orchestrator OpenAI call failed',
      );
      return null;
    }
    const payload = (await response.json()) as unknown;
    const output = extractResponseOutputText(payload);
    if (!output) {
      return null;
    }
    const spokenText =
      request.channel === 'alexa'
        ? output.split(/(?<=[.!?])\s+/).slice(0, 3).join(' ').trim()
        : undefined;
    return {
      handled: true,
      kind: plan.kind,
      plan,
      providerUsed:
        plan.sources.localContext && localContextBlock
          ? 'hybrid'
          : 'openai_responses',
      summaryText: spokenText || output,
      spokenText,
      fullText: output,
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
    };
  } catch (err) {
    logger.warn({ err }, 'Research orchestrator OpenAI request errored');
    return null;
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
    };
  }

  if (plan.primarySource === 'runtime_delegate') {
    return {
      handled: false,
      kind: plan.kind,
      plan,
      sourceNotes: ['request should stay on the runtime or operator lane'],
    };
  }

  const context = await collectLocalResearchContext(request);

  if (plan.sources.openAiResponses) {
    const openAiResult = await runOpenAiResearch(request, plan, context);
    if (openAiResult) {
      return openAiResult;
    }
  }

  return summarizeLocalResearch(request, context, plan);
}
