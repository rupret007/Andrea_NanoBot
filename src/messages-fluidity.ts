import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import { interpretBlueBubblesDirectTurnWithBackend } from './openai-guided-routing.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import type {
  BlueBubblesReplyGateMode,
  MessagesDirectTurnEnvelope,
  NewMessage,
} from './types.js';

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
      item && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const chunk of content) {
      const chunkRecord =
        chunk && typeof chunk === 'object'
          ? (chunk as Record<string, unknown>)
          : {};
      if (chunkRecord.type === 'output_text' && typeof chunkRecord.text === 'string') {
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

export function isBlueBubblesAndreaBotEcho(text: string | null | undefined): boolean {
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

  try {
    const response = await fetch(`${openAi.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAi.apiKey}`,
      },
      body: JSON.stringify({
        model: openAi.researchModel,
        input: prompt,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      describeOpenAiProviderFailure(response.status, body, 'research');
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
      return {
        draftText: null,
        source: 'fallback',
        fallbackNote:
          "I kept this one simple because the richer Messages draft lane isn't available right now.",
      };
    }
    const parsed = safeJsonParse<{ draftText?: string }>(rawOutput, {});
    const draftText = normalizeText(parsed.draftText);
    if (!draftText) {
      return {
        draftText: null,
        source: 'fallback',
        fallbackNote:
          "I kept this one simple because the richer Messages draft lane isn't available right now.",
      };
    }
    return {
      draftText,
      source: 'openai',
    };
  } catch {
    return {
      draftText: null,
      source: 'fallback',
      fallbackNote:
        "I kept this one simple because the richer Messages draft lane isn't available right now.",
    };
  }
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

  try {
    const response = await fetch(`${openAi.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAi.apiKey}`,
      },
      body: JSON.stringify({
        model: openAi.researchModel,
        input: prompt,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      describeOpenAiProviderFailure(response.status, body, 'research');
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
      return {
        draftText: null,
        source: 'fallback',
        fallbackNote:
          "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
      };
    }
    const parsed = safeJsonParse<{ draftText?: string }>(rawOutput, {});
    const draftText = normalizeText(parsed.draftText);
    if (!draftText) {
      return {
        draftText: null,
        source: 'fallback',
        fallbackNote:
          "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
      };
    }
    return {
      draftText,
      source: 'openai',
    };
  } catch {
    return {
      draftText: null,
      source: 'fallback',
      fallbackNote:
        "I kept the rewrite simple because the richer Messages rewrite lane isn't available right now.",
    };
  }
}
