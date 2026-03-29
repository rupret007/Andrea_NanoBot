import type { NewMessage } from './types.js';

const MAX_ABS_MATH_RESULT = 1_000_000_000_000;

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return value.toString();
  return Number(value.toFixed(6)).toString();
}

function extractMathExpression(message: string): string | null {
  const normalized = normalizeText(message)
    .replace(/[?=]/g, ' ')
    .replace(/\u00d7/g, '*')
    .replace(/\u00f7/g, '/');

  const stripped = normalized
    .replace(
      /^(what is|what's|whats|calculate|compute|solve|math|quick math|can you do)\s+/,
      '',
    )
    .trim();

  if (!/[+\-*/]/.test(stripped)) return null;
  if (!/[0-9]/.test(stripped)) return null;
  if (!/^[0-9+\-*/().\s]+$/.test(stripped)) return null;
  return stripped;
}

function trySolveMath(message: string): string | null {
  const expression = extractMathExpression(message);
  if (!expression) return null;

  try {
    const result = Function(`"use strict"; return (${expression});`)();
    if (typeof result !== 'number' || !Number.isFinite(result)) return null;
    if (Math.abs(result) > MAX_ABS_MATH_RESULT) return null;

    const rendered = formatNumber(result);
    return `Quick math: ${expression} = ${rendered}.`;
  } catch {
    return null;
  }
}

export function maybeBuildDirectQuickReply(
  messages: Pick<NewMessage, 'content'>[],
): string | null {
  const lastContent = messages.at(-1)?.content?.trim();
  if (!lastContent) return null;
  const normalized = normalizeText(lastContent);

  if (
    /\b(what('?s| is) )?the meaning of life\b/.test(normalized) ||
    /\bmeaning of life\b/.test(normalized)
  ) {
    return '42. Final answer. The rest is universe patch notes.';
  }

  if (
    /\bdo you have a personality\b/.test(normalized) ||
    /\bare you (funny|witty)\b/.test(normalized)
  ) {
    return "I do. I'm Andrea: helpful, a little quippy, and occasionally dramatic about clean checklists.";
  }

  if (
    /\bdo you know what('?s| is) what\b/.test(normalized) ||
    /\bwhat('?s| is) what\b/.test(normalized)
  ) {
    return "I know what's what. If chaos appears, I bring clarity and snacks.";
  }

  return trySolveMath(lastContent);
}
