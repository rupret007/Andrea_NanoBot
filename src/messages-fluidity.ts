import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import { interpretBlueBubblesDirectTurnWithBackend } from './openai-guided-routing.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
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

function normalizeText(value: string | undefined): string {
  return (value || '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
  source: 'fallback';
  fallbackNote: string;
} {
  return {
    lead: null,
    digest: null,
    bullets: [],
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

export async function summarizeBlueBubblesThreadDigest(input: {
  chatName: string;
  windowLabel: string;
  transcript: string;
  channel: 'telegram' | 'bluebubbles';
  timeoutMs?: number;
}): Promise<{
  lead: string | null;
  digest: string | null;
  bullets: string[];
  source: 'openai' | 'fallback';
  fallbackNote?: string;
}> {
  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) {
    return buildThreadSummaryFallbackResult();
  }

  const prompt = [
    'You are Andrea summarizing a synced Messages thread.',
    'Return JSON only with keys lead, digest, bullets.',
    'Stay strictly grounded in the provided transcript.',
    'Do not invent details, relationships, or decisions that are not in the transcript.',
    'Never include raw phone numbers, raw identifiers, or JIDs.',
    'Use the participant labels already present in the transcript when helpful.',
    'This should read like an almost-full digest of the conversation, not activity stats.',
    'lead: 1-2 sentences that orient what the conversation was mostly about.',
    'digest: a detailed paragraph or two as one string covering the substantive flow, disagreements, decisions, and ending state.',
    'bullets: 3 to 6 concise bullets for notable points, shifts, decisions, or clear follow-up needs.',
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
      }>(rawOutput, {});
      const lead = normalizeText(parsed.lead);
      const digest = normalizeText(parsed.digest);
      const bullets = normalizeStringArray(parsed.bullets, 6);
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
