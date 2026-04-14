import { isBlueBubblesSelfThreadAliasJid } from './bluebubbles-self-thread.js';
import { buildGracefulDegradedReply } from './conversational-core.js';
import {
  describeOpenAiProviderFailure,
  resolveOpenAiProviderConfig,
} from './openai-provider.js';
import type {
  BlueBubblesReplyGateMode,
  MessagesDirectRouteFamily,
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

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
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

function isAllowedRouteFamily(value: unknown): value is MessagesDirectRouteFamily {
  return (
    value === 'chat' ||
    value === 'communication_reply' ||
    value === 'message_action_followup' ||
    value === 'capture' ||
    value === 'calendar' ||
    value === 'reminder' ||
    value === 'household_view' ||
    value === 'help'
  );
}

function buildMessagesOpenAiFallback(text: string): MessagesDirectTurnEnvelope {
  return {
    normalizedUserIntent: normalizeText(text),
    routeFamily: 'chat',
    assistantPrompt: normalizeText(text),
    confidence: 0,
    fallbackText: buildGracefulDegradedReply({
      kind: 'assistant_runtime_unavailable',
      channel: 'bluebubbles',
      text,
    }),
    source: 'fallback',
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
  const normalizedText = normalizeText(input.text);
  if (!normalizedText) {
    return {
      normalizedUserIntent: '',
      routeFamily: 'chat',
      assistantPrompt: '',
      confidence: 0,
      clarificationQuestion: 'What do you want me to help with here?',
      source: 'fallback',
    };
  }

  const openAi = resolveOpenAiProviderConfig();
  if (!openAi) {
    return buildMessagesOpenAiFallback(normalizedText);
  }

  const prompt = [
    'You are Andrea\'s 1:1 Messages front-door interpreter.',
    'Return JSON only.',
    'Valid routeFamily values: chat, communication_reply, message_action_followup, capture, calendar, reminder, household_view, help.',
    'Use assistantPrompt to rewrite the user turn into the short command Andrea\'s existing deterministic handlers should receive.',
    'For communication_reply, prefer assistantPrompt values like "what should I say back", "make it warmer", "make it more direct", "send it", or "send it later tonight".',
    'For capture, household_view, calendar, and reminder, rewrite into a concise natural command Andrea can route directly.',
    'For help, use an assistantPrompt like "what can you do".',
    'For chat, provide a short natural replyText Andrea can send as-is in Messages.',
    'Ask one short clarificationQuestion only if the intent is too ambiguous to act on cleanly.',
    'Keep Messages tone human, concise, and non-bureaucratic.',
    `Context JSON: ${JSON.stringify({
      groupFolder: input.groupFolder,
      chatJid: input.chatJid,
      text: normalizedText,
      conversationSummary: input.conversationSummary || null,
      replyText: input.replyText || null,
      priorPersonName: input.priorPersonName || null,
      priorThreadTitle: input.priorThreadTitle || null,
      priorLastAnswerSummary: input.priorLastAnswerSummary || null,
      now: (input.now || new Date()).toISOString(),
    })}`,
    'Return JSON with keys: normalizedUserIntent, routeFamily, assistantPrompt, draftGoal, toneHints, confidence, clarificationQuestion, replyText.',
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
      return buildMessagesOpenAiFallback(normalizedText);
    }
    const payload = (await response.json()) as unknown;
    const rawOutput = stripJsonFences(extractResponseOutputText(payload));
    if (!rawOutput) {
      return buildMessagesOpenAiFallback(normalizedText);
    }
    const parsed = safeJsonParse<Partial<MessagesDirectTurnEnvelope>>(rawOutput, {});
    const routeFamily = isAllowedRouteFamily(parsed.routeFamily)
      ? parsed.routeFamily
      : 'chat';
    const assistantPrompt = normalizeText(parsed.assistantPrompt) || normalizedText;
    const clarificationQuestion = normalizeText(parsed.clarificationQuestion || undefined);
    const replyText = normalizeText(parsed.replyText || undefined);
    const toneHints = Array.isArray(parsed.toneHints)
      ? parsed.toneHints
          .map((hint) => normalizeText(typeof hint === 'string' ? hint : ''))
          .filter(Boolean)
      : [];
    return {
      normalizedUserIntent:
        normalizeText(parsed.normalizedUserIntent || undefined) || normalizedText,
      routeFamily,
      assistantPrompt,
      draftGoal: normalizeText(parsed.draftGoal || undefined) || null,
      toneHints,
      confidence: clampConfidence(parsed.confidence),
      clarificationQuestion: clarificationQuestion || null,
      replyText: replyText || null,
      source: 'openai',
    };
  } catch {
    return buildMessagesOpenAiFallback(normalizedText);
  }
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
