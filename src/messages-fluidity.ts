import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import { clipCouncilText } from './council-safety.js';
import {
  interpretBlueBubblesDirectTurnWithBackend,
  type CompanionBackendRoutingResult,
} from './openai-guided-routing.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import { runObservableProviderCouncil } from './provider-council-runner.js';
import {
  buildOpenAiModelCandidates,
  detectOpenAiProviderMode,
  isOpenAiModelRejection,
} from './openai-model-routing.js';
import { recordOpenAiUsageState } from './openai-usage-state.js';
import type {
  BlueBubblesReplyGateMode,
  MessagesDirectTurnEnvelope,
  NewMessage,
} from './types.js';

const THREAD_SUMMARY_FALLBACK_NOTE =
  "I kept this one grounded locally because the richer Messages summary lane isn't available right now.";
const THREAD_SUMMARY_OPENAI_TIMEOUT_MS = 12_000;
const BLUEBUBBLES_COUNCIL_SNIPPET_LIMIT = 900;

export interface BlueBubblesSuggestedReply {
  label: string;
  text: string;
}

function normalizeText(value: string | undefined): string {
  return (value || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function clipCouncilSnippet(
  value: string,
  max = BLUEBUBBLES_COUNCIL_SNIPPET_LIMIT,
): string {
  return clipCouncilText(normalizeText(value), max);
}

function shouldRunBlueBubblesMessagesCouncil(input: {
  text: string;
  transcript?: string;
  style?: string;
}): boolean {
  const combined = normalizeText(
    [input.text, input.transcript, input.style].filter(Boolean).join(' '),
  ).toLowerCase();
  if (
    /\b(?:ultra[- ]?think|think harder|use all models|max iq|deep dive|think deeply)\b/.test(
      combined,
    )
  ) {
    return true;
  }
  if (
    /\b(?:what should i say back|draft|reply|summari[sz]e)\b/.test(combined)
  ) {
    return (
      combined.length > 500 ||
      /\b(?:sensitive|awkward|conflict|upset|angry|apologize|sorry|deadline|money|family|relationship|risk)\b/.test(
        combined,
      )
    );
  }
  return false;
}

async function runBlueBubblesMessagesCouncil(input: {
  kind: 'thread_summary' | 'draft_reply';
  goal: string;
  snippet: string;
  threadTitle?: string | null;
  style?: string | null;
}): Promise<string | null> {
  const council = await runObservableProviderCouncil({
    goal: input.goal,
    taskFamily: 'communication',
    channel: 'bluebubbles',
    groupFolder: 'main',
    requestedMode: 'dual_review',
    riskLevel: 'medium',
    requiredEvidence: 'weak',
    allowedSideEffects: 'none',
    rawContentPolicy: 'sanitized_snippets',
    metadata: {
      surface: 'bluebubbles_messages_fluidity',
      kind: input.kind,
      thread_title: clipCouncilSnippet(input.threadTitle || 'unknown', 120),
      style: input.style || '',
      sanitized_snippet: clipCouncilSnippet(input.snippet),
      private_bodies_persisted: 'false',
    },
  });
  return council?.answerGuidance?.visibleVerdict || null;
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function extractResponseOutputText(payload: unknown): string {
  const record =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>)
      : {};
  const directOutput = record.output_text;
  if (typeof directOutput === 'string' && directOutput.trim()) {
    return directOutput.trim();
  }
  const output = Array.isArray(record.output) ? record.output : [];
  const parts: string[] = [];
  for (const item of output) {
    const itemRecord =
      item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const chunk of content) {
      const chunkRecord =
        chunk && typeof chunk === 'object'
          ? (chunk as Record<string, unknown>)
          : {};
      if (
        chunkRecord.type === 'output_text' &&
        typeof chunkRecord.text === 'string'
      ) {
        parts.push(chunkRecord.text);
      }
    }
  }
  return parts.join('\n').trim();
}

function stripJsonFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildThreadSummaryFallbackResult(): {
  lead: null;
  digest: null;
  bullets: [];
  suggestedReplies: [];
  source: 'fallback';
  fallbackNote: string;
} {
  return {
    lead: null,
    digest: null,
    bullets: [],
    suggestedReplies: [],
    source: 'fallback',
    fallbackNote: THREAD_SUMMARY_FALLBACK_NOTE,
  };
}

export function resolveBlueBubblesReplyGateMode(params: {
  chatJid: string | null | undefined;
  isGroup?: boolean | null;
}): BlueBubblesReplyGateMode {
  if (params.isGroup) {
    return 'mention_required';
  }
  return isBlueBubblesSelfThreadAliasJid(params.chatJid)
    ? 'direct_1to1'
    : 'mention_required';
}

export function isBlueBubblesAndreaBotEcho(
  text: string | null | undefined,
): boolean {
  return /^\s*Andrea:/i.test(text || '');
}

export function buildBlueBubblesIngressFingerprint(input: {
  chatJid: string;
  message: Pick<NewMessage, 'content' | 'timestamp' | 'sender' | 'is_from_me'>;
}): string {
  return [
    input.chatJid,
    input.message.timestamp,
    input.message.is_from_me ? 'self' : 'other',
    normalizeText(input.message.sender),
    normalizeText(input.message.content).toLowerCase(),
  ].join('|');
}

export async function interpretBlueBubblesDirectTurn(input: {
  groupFolder: string;
  chatJid: string;
  text: string;
  conversationSummary?: string;
  replyText?: string;
  priorPersonName?: string;
  priorThreadTitle?: string;
  priorLastAnswerSummary?: string;
  routingResult?: CompanionBackendRoutingResult | null;
  now?: Date;
}): Promise<MessagesDirectTurnEnvelope> {
  return interpretBlueBubblesDirectTurnWithBackend(input);
}

function normalizeStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeText(typeof item === 'string' ? item : ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeSuggestedReplies(
  value: unknown,
  maxItems = 3,
): BlueBubblesSuggestedReply[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      if (typeof item === 'string') {
        const text = normalizeText(item);
        return text
          ? {
              label: index === 0 ? 'suggested' : `option ${index + 1}`,
              text,
            }
          : null;
      }
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const text = normalizeText(String(record.text || ''));
      if (!text) return null;
      return {
        label:
          normalizeText(String(record.label || '')) || `option ${index + 1}`,
        text,
      };
    })
    .filter((item): item is BlueBubblesSuggestedReply => Boolean(item))
    .slice(0, maxItems);
}

export async function summarizeBlueBubblesThreadDigest(input: {
  chatName: string;
  windowLabel: string;
  transcript: string;
  channel: 'telegram' | 'bluebubbles';
  timeoutMs?: number;
  thinkingMode?: 'auto' | 'deep' | 'quick';
}): Promise<{
  lead: string | null;
  digest: string | null;
  bullets: string[];
  suggestedReplies: BlueBubblesSuggestedReply[];
  source: 'openai' | 'fallback';
  fallbackNote?: string;
}> {
  const shouldUseCouncil =
    input.thinkingMode === 'deep' ||
    (input.thinkingMode !== 'quick' &&
      shouldRunBlueBubblesMessagesCouncil({
        text: `${input.chatName} ${input.windowLabel}`,
        transcript: input.transcript,
      }));
  if (shouldUseCouncil) {
    await runBlueBubblesMessagesCouncil({
      kind: 'thread_summary',
      goal: 'Review a private BlueBubbles thread-summary request and return concise guidance for a safe, grounded digest.',
      snippet: input.transcript,
      threadTitle: input.chatName,
    }).catch(() => null);
  }

  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) {
    return buildThreadSummaryFallbackResult();
  }

  const prompt = [
    'You are Andrea summarizing a synced Messages thread.',
    'Return JSON only with keys lead, digest, bullets, suggestedReplies.',
    'Stay strictly grounded in the provided transcript.',
    'Do not invent details, relationships, or decisions that are not in the transcript.',
    'Never include raw phone numbers, raw identifiers, or JIDs.',
    'Use the participant labels already present in the transcript when helpful.',
    'This should read like an almost-full digest of the conversation, not activity stats.',
    'lead: 1-2 sentences that orient what the conversation was mostly about.',
    'digest: a detailed paragraph or two as one string covering the substantive flow, disagreements, decisions, and ending state.',
    'bullets: 3 to 6 concise bullets for notable points, shifts, decisions, or clear follow-up needs.',
    'suggestedReplies: 2-3 safe reply options when the user likely owes a reply, each with label and text. Use an empty array if no reply is likely owed.',
    `Context JSON: ${JSON.stringify(input)}`,
  ].join('\n');
  const providerMode = detectOpenAiProviderMode(openAi.baseUrl);
  const modelCandidates = buildOpenAiModelCandidates('standard', {
    simpleModel: openAi.simpleModel,
    standardModel: openAi.standardModel,
    complexModel: openAi.complexModel,
    fallbackModel: openAi.researchModel,
  });
  const timeoutMs = Math.max(
    100,
    input.timeoutMs ?? THREAD_SUMMARY_OPENAI_TIMEOUT_MS,
  );

  try {
    for (const candidate of modelCandidates) {
      let response: Response;
      try {
        response = await fetch(`${openAi.baseUrl}/responses`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAi.apiKey}`,
          },
          body: JSON.stringify({
            model: candidate.model,
            input: prompt,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        recordOpenAiUsageState({
          at: new Date().toISOString(),
          surface: 'messages_fluidity',
          selectedModelTier: candidate.tier,
          selectedModel: candidate.model,
          providerMode,
          outcome: 'failed',
          detail:
            error instanceof Error && error.name === 'TimeoutError'
              ? `thread_summary timed out after ${timeoutMs}ms`
              : 'thread_summary request failed before a response arrived',
        });
        return buildThreadSummaryFallbackResult();
      }
      if (!response.ok) {
        const body = await response.text();
        if (isOpenAiModelRejection(response.status, body)) {
          continue;
        }
        recordOpenAiUsageState({
          at: new Date().toISOString(),
          surface: 'messages_fluidity',
          selectedModelTier: candidate.tier,
          selectedModel: candidate.model,
          providerMode,
          outcome:
            /quota|billing|rejected the configured api key|denied by the provider/i.test(
              body,
            )
              ? 'blocked'
              : 'failed',
          detail: describeOpenAiProviderFailure(
            response.status,
            body,
            'research',
          ),
        });
        return buildThreadSummaryFallbackResult();
      }
      const payload = (await response.json()) as unknown;
      const rawOutput = stripJsonFences(extractResponseOutputText(payload));
      if (!rawOutput) {
        continue;
      }
      const parsed = safeJsonParse<{
        lead?: string;
        digest?: string;
        bullets?: unknown;
        suggestedReplies?: unknown;
      }>(rawOutput, {});
      const lead = normalizeText(parsed.lead);
      const digest = normalizeText(parsed.digest);
      const bullets = normalizeStringArray(parsed.bullets, 6);
      const suggestedReplies = normalizeSuggestedReplies(
        parsed.suggestedReplies,
      );
      if (!lead && !digest && bullets.length === 0) {
        continue;
      }
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'messages_fluidity',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: 'success',
        detail: 'thread_summary',
      });
      return {
        lead: lead || null,
        digest: digest || null,
        bullets,
        suggestedReplies,
        source: 'openai',
      };
    }
  } catch {
    // Fall through to the honest local fallback.
  }
  return buildThreadSummaryFallbackResult();
}

export async function draftBlueBubblesCommunicationReply(input: {
  messageText: string;
  summaryText: string;
  style: 'balanced' | 'warmer' | 'direct' | 'short';
  personName?: string;
  threadTitle?: string;
  toneHints?: string[];
  linkedLifeThreadSummary?: string | null;
  thinkingMode?: 'auto' | 'deep' | 'quick';
}): Promise<{
  draftText: string | null;
  source: 'openai' | 'fallback';
  fallbackNote?: string;
}> {
  const shouldUseCouncil =
    input.thinkingMode === 'deep' ||
    (input.thinkingMode !== 'quick' &&
      shouldRunBlueBubblesMessagesCouncil({
        text: `${input.messageText} ${input.summaryText}`,
        style: input.style,
      }));
  if (shouldUseCouncil) {
    await runBlueBubblesMessagesCouncil({
      kind: 'draft_reply',
      goal: 'Review a private BlueBubbles reply-drafting request and return concise guidance for a safe, human, approval-first draft.',
      snippet: `${input.summaryText}\n${input.messageText}`,
      threadTitle: input.threadTitle || input.personName || null,
      style: input.style,
    }).catch(() => null);
  }

  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) {
    return {
      draftText: null,
      source: 'fallback',
      fallbackNote:
        "I kept this one simple because the richer Messages draft lane isn't available right now.",
    };
  }

  const prompt = [
    'You are Andrea drafting a short human text-message reply.',
    'Return JSON only with key draftText.',
    'Stay grounded in the provided context.',
    'Do not invent commitments, dates, facts, or emotional backstory that were not given.',
    'Keep it human, concise, and non-bureaucratic.',
    'Unless the style is short, keep it to 1-3 short sentences.',
    `Context JSON: ${JSON.stringify(input)}`,
  ].join('\n');
  const providerMode = detectOpenAiProviderMode(openAi.baseUrl);
  const modelCandidates = buildOpenAiModelCandidates('standard', {
    simpleModel: openAi.simpleModel,
    standardModel: openAi.standardModel,
    complexModel: openAi.complexModel,
    fallbackModel: openAi.researchModel,
  });

  try {
    for (const candidate of modelCandidates) {
      const response = await fetch(`${openAi.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAi.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          input: prompt,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        if (isOpenAiModelRejection(response.status, body)) {
          continue;
        }
        recordOpenAiUsageState({
          at: new Date().toISOString(),
          surface: 'messages_fluidity',
          selectedModelTier: candidate.tier,
          selectedModel: candidate.model,
          providerMode,
          outcome:
            /quota|billing|rejected the configured api key|denied by the provider/i.test(
              body,
            )
              ? 'blocked'
              : 'failed',
          detail: describeOpenAiProviderFailure(
            response.status,
            body,
            'research',
          ),
        });
        return {
          draftText: null,
          source: 'fallback',
          fallbackNote:
            "I kept this one simple because the richer Messages draft lane isn't available right now.",
        };
      }
      const payload = (await response.json()) as unknown;
      const rawOutput = stripJsonFences(extractResponseOutputText(payload));
      if (!rawOutput) {
        continue;
      }
      const parsed = safeJsonParse<{ draftText?: string }>(rawOutput, {});
      const draftText = normalizeText(parsed.draftText);
      if (!draftText) {
        continue;
      }
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'messages_fluidity',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: 'success',
        detail: 'draft_reply',
      });
      return {
        draftText,
        source: 'openai',
      };
    }
  } catch {
    // Fall through to the honest local fallback.
  }
  return {
    draftText: null,
    source: 'fallback',
    fallbackNote:
      "I kept this one simple because the richer Messages draft lane isn't available right now.",
  };
}

export async function rewriteBlueBubblesMessageDraft(input: {
  draftText: string;
  style: 'shorter' | 'warmer' | 'more_direct';
  personName?: string | null;
}): Promise<{
  draftText: string | null;
  source: 'openai' | 'fallback';
  fallbackNote?: string;
}> {
  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) {
    return {
      draftText: null,
      source: 'fallback',
      fallbackNote:
        "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
    };
  }

  const prompt = [
    'You are Andrea rewriting a text-message draft.',
    'Return JSON only with key draftText.',
    'Preserve the meaning while applying the requested style.',
    'Keep it human and concise.',
    `Context JSON: ${JSON.stringify(input)}`,
  ].join('\n');
  const providerMode = detectOpenAiProviderMode(openAi.baseUrl);
  const modelCandidates = buildOpenAiModelCandidates('standard', {
    simpleModel: openAi.simpleModel,
    standardModel: openAi.standardModel,
    complexModel: openAi.complexModel,
    fallbackModel: openAi.researchModel,
  });

  try {
    for (const candidate of modelCandidates) {
      const response = await fetch(`${openAi.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAi.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          input: prompt,
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        if (isOpenAiModelRejection(response.status, body)) {
          continue;
        }
        recordOpenAiUsageState({
          at: new Date().toISOString(),
          surface: 'messages_fluidity',
          selectedModelTier: candidate.tier,
          selectedModel: candidate.model,
          providerMode,
          outcome:
            /quota|billing|rejected the configured api key|denied by the provider/i.test(
              body,
            )
              ? 'blocked'
              : 'failed',
          detail: describeOpenAiProviderFailure(
            response.status,
            body,
            'research',
          ),
        });
        return {
          draftText: null,
          source: 'fallback',
          fallbackNote:
            "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
        };
      }
      const payload = (await response.json()) as unknown;
      const rawOutput = stripJsonFences(extractResponseOutputText(payload));
      if (!rawOutput) {
        continue;
      }
      const parsed = safeJsonParse<{ draftText?: string }>(rawOutput, {});
      const draftText = normalizeText(parsed.draftText);
      if (!draftText) {
        continue;
      }
      recordOpenAiUsageState({
        at: new Date().toISOString(),
        surface: 'messages_fluidity',
        selectedModelTier: candidate.tier,
        selectedModel: candidate.model,
        providerMode,
        outcome: 'success',
        detail: 'rewrite_reply',
      });
      return {
        draftText,
        source: 'openai',
      };
    }
  } catch {
    // Fall through to the honest local fallback.
  }
  return {
    draftText: null,
    source: 'fallback',
    fallbackNote:
      "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
  };
}
