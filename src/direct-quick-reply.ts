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

function countWords(input: string): number {
  return input.trim().split(/\s+/).filter(Boolean).length;
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
    /^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(
      normalized,
    )
  ) {
    return "Hi. I'm Andrea. Give me one thing to tackle and I'll keep it crisp.";
  }

  if (/\b(how are you|how're you)\b/.test(normalized)) {
    return 'Doing well and fully caffeinated in spirit. What do you want to tackle?';
  }

  if (
    /\b(you there|are you there|still there)\b/.test(normalized) ||
    /^you\?$/.test(normalized)
  ) {
    return "I'm here and ready.";
  }

  if (/^(thanks|thank you|thx)\b/.test(normalized)) {
    return "Anytime. What's next?";
  }

  if (
    /\b(that'?s funny|thats funny|haha|lol|lmao)\b/.test(normalized) ||
    /\bahh+\b/.test(normalized)
  ) {
    return "I'll take that as a win.";
  }

  if (
    /\bwho are you\b/.test(normalized) ||
    /\bwhat can you do\b/.test(normalized)
  ) {
    return "I'm Andrea. I'm strongest on tasks, reminders, research, status checks, and careful approvals without turning the chat into a control panel.";
  }

  if (
    /\bdo you know what('?s| is) what\b/.test(normalized) ||
    /\bwhat('?s| is) what\b/.test(normalized)
  ) {
    return "I know what's what. If chaos appears, I bring clarity and snacks.";
  }

  return trySolveMath(lastContent);
}

export function maybeBuildDirectRescueReply(
  messages: Pick<NewMessage, 'content'>[],
): string | null {
  const lastContent = messages.at(-1)?.content?.trim();
  if (!lastContent) return null;

  const normalized = normalizeText(lastContent);
  const quickReply = maybeBuildDirectQuickReply(messages);
  if (quickReply) return quickReply;

  const shortTurn =
    normalized.length <= 120 &&
    countWords(normalized) <= 12 &&
    !normalized.startsWith('/') &&
    !normalized.includes('http://') &&
    !normalized.includes('https://');

  if (!shortTurn) return null;

  return "I'm here. That one went sideways on my end. Ask it again in one short sentence and I'll keep it simple.";
}
