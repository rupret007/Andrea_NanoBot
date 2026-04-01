export interface DirectAssistantContinuationResult {
  normalizedPromptText: string;
  fallbackPromptText?: string;
  usedVisibleContext: boolean;
  shouldStartFreshSession: boolean;
}

const TIGHTEN_PATTERNS = new Set([
  'make it shorter',
  'shorter',
  'tighten this',
]);
const EXPAND_PATTERNS = new Set([
  'add more detail',
  'expand this',
  'make it more detailed',
]);
const FIX_PATTERNS = new Set([
  'fix that',
  'fix it',
  'correct that',
  'improve that',
  'improve it',
  'clean that up',
  'make this better',
]);
const RETRY_PATTERNS = new Set(['try again', 'retry', 'do it again']);
const CONTINUE_PATTERNS = new Set(['continue', 'go ahead', 'use that']);

function normalizeLoosePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[,.\s]+|[,.!?\s]+$/g, '')
    .replace(/^please\s+/, '')
    .replace(/\s+/g, ' ');
}

function extractAdaptationTarget(normalized: string): string | null {
  const patterns = [
    /^do that but for\s+(.+)$/i,
    /^same thing for\s+(.+)$/i,
    /^make a version for\s+(.+)$/i,
    /^adapt (?:it|that) for\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function isSubstantialInstruction(rawPrompt: string): boolean {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return false;
  if (trimmed.length >= 90) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= 9;
}

function compactVisibleContext(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildSentenceRewritePrompt(
  instruction: string,
  visibleContext: string,
): string {
  return `${instruction} Reply with one sentence only: ${visibleContext}`;
}

function buildSentenceRewriteFallbackPrompt(
  instruction: string,
  visibleContext: string,
): string {
  return `${instruction} ${visibleContext}`;
}

export function buildDirectAssistantContinuationPrompt(params: {
  rawPrompt: string;
  previousAssistantText?: string | null;
}): DirectAssistantContinuationResult {
  const trimmedPrompt = params.rawPrompt.trim();
  const visibleContext = params.previousAssistantText
    ? compactVisibleContext(params.previousAssistantText)
    : null;
  if (!trimmedPrompt || !visibleContext) {
    return {
      normalizedPromptText: trimmedPrompt,
      usedVisibleContext: false,
      shouldStartFreshSession: false,
    };
  }

  if (isSubstantialInstruction(trimmedPrompt)) {
    return {
      normalizedPromptText: trimmedPrompt,
      usedVisibleContext: false,
      shouldStartFreshSession: false,
    };
  }

  const normalized = normalizeLoosePhrase(trimmedPrompt);
  const adaptTarget = extractAdaptationTarget(normalized);

  let normalizedPromptText: string | null = null;
  let fallbackPromptText: string | undefined;
  if (TIGHTEN_PATTERNS.has(normalized)) {
    normalizedPromptText = buildSentenceRewritePrompt(
      'Rewrite this sentence in a shorter way while preserving the meaning.',
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      'Return a shorter version of this sentence:',
      visibleContext,
    );
  } else if (EXPAND_PATTERNS.has(normalized)) {
    normalizedPromptText = buildSentenceRewritePrompt(
      'Rewrite this sentence with a little more detail while preserving the meaning and scope.',
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      'Add a little more detail to this sentence while keeping the same scope. Return only the revised sentence:',
      visibleContext,
    );
  } else if (FIX_PATTERNS.has(normalized)) {
    normalizedPromptText = buildSentenceRewritePrompt(
      'Rewrite this sentence more clearly and smoothly while preserving the meaning.',
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      'Improve the wording of this sentence and return only the revised sentence:',
      visibleContext,
    );
  } else if (RETRY_PATTERNS.has(normalized)) {
    normalizedPromptText = buildSentenceRewritePrompt(
      'Rewrite this sentence in a slightly better way while preserving the meaning.',
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      'Return a slightly better version of this sentence while keeping the same meaning:',
      visibleContext,
    );
  } else if (CONTINUE_PATTERNS.has(normalized)) {
    normalizedPromptText = buildSentenceRewritePrompt(
      'Continue this response naturally from the same point of view.',
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      'Continue naturally from this sentence and return one sentence only:',
      visibleContext,
    );
  } else if (adaptTarget) {
    normalizedPromptText = buildSentenceRewritePrompt(
      `Rewrite this sentence for ${adaptTarget} while preserving the meaning.`,
      visibleContext,
    );
    fallbackPromptText = buildSentenceRewriteFallbackPrompt(
      `Rewrite this sentence for ${adaptTarget} and return only the revised sentence:`,
      visibleContext,
    );
  }

  if (!normalizedPromptText) {
    return {
      normalizedPromptText: trimmedPrompt,
      usedVisibleContext: false,
      shouldStartFreshSession: false,
    };
  }

  return {
    normalizedPromptText,
    fallbackPromptText,
    usedVisibleContext: true,
    shouldStartFreshSession: true,
  };
}
