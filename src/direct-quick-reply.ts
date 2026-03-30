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
    .replace(/,/g, '')
    .replace(/\u00d7/g, '*')
    .replace(/\u00f7/g, '/')
    .replace(/\bmultiplied by\b/g, ' * ')
    .replace(/\bdivided by\b/g, ' / ')
    .replace(/\bplus\b/g, ' + ')
    .replace(/\bminus\b/g, ' - ')
    .replace(/\btimes\b/g, ' * ');

  const stripped = normalized
    .replace(
      /^(what is|what's|whats|calculate|compute|solve|math|quick math|can you do)\s+/,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();

  if (!/[+\-*/]/.test(stripped)) return null;
  if (!/[0-9]/.test(stripped)) return null;
  if (!/^[0-9+\-*/().\s]+$/.test(stripped)) return null;
  return stripped;
}

export function buildQuickMathReply(message: string): string | null {
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

function isStandalonePrompt(
  normalized: string,
  pattern: RegExp,
  maxWords = 4,
): boolean {
  return pattern.test(normalized) && countWords(normalized) <= maxWords;
}

export function maybeBuildDirectQuickReply(
  messages: Pick<NewMessage, 'content'>[],
): string | null {
  const lastContent = messages.at(-1)?.content?.trim();
  if (!lastContent) return null;
  const normalized = normalizeText(lastContent);

  if (
    isStandalonePrompt(
      normalized,
      /^(?:(?:what('?s| is) )?the meaning of life(?: then)?|meaning of life)[?.! ]*$/,
      7,
    )
  ) {
    return '42. Final answer. The rest is universe patch notes.';
  }

  if (
    isStandalonePrompt(normalized, /^what are you (?:best|good) at[?.! ]*$/, 6)
  ) {
    return "Keeping tasks, reminders, research, and operator status checks clean and calm. Give me one concrete ask and I'll keep it moving.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^are you funny or just pretending[?.! ]*$/,
      6,
    )
  ) {
    return 'A little of both. Useful first, funny second, and chaos never.';
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:do you have a personality|are you (?:funny|witty))[?.! ]*$/,
      5,
    )
  ) {
    return "I do. I'm Andrea: helpful, a little quippy, and occasionally dramatic about clean checklists.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(hi|hello|hey|good morning|good afternoon|good evening)(?:[!., ]+| there| andrea)*$/,
      5,
    )
  ) {
    return "Hi. I'm Andrea. Give me one thing to tackle and I'll keep it crisp.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:how are you|how're you)(?: today)?[?.! ]*$/,
      5,
    )
  ) {
    return 'Doing well and fully caffeinated in spirit. What do you want to tackle?';
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:you there|are you there|still there|you)\??[!. ]*$/,
      3,
    )
  ) {
    return "I'm here and ready.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(thanks|thank you|thx)(?:[!., ]+| andrea)*$/,
      4,
    )
  ) {
    return "Anytime. What's next?";
  }

  if (/^ping[!. ]*$/.test(normalized)) {
    return 'Andrea is online.';
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(ok|okay|kk|yes|yep|yup|sure|sounds good|that works|go ahead|please do)[!. ]*$/,
      3,
    )
  ) {
    return 'Sounds good.';
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:(?:ahh+[!., ]+)?(?:that'?s funny|thats funny)|haha|lol|lmao|ahh+)[!. ]*$/,
      5,
    )
  ) {
    return "I'll take that as a win.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:who are you|what can you do)[?.! ]*$/,
      5,
    )
  ) {
    return "I'm Andrea. I'm strongest on tasks, reminders, research, status checks, and careful approvals without turning the chat into a control panel.";
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:what commands do you have|what are your commands)[?.! ]*$/,
      6,
    )
  ) {
    return 'Use /commands for the short list and /help for the fuller guide.';
  }

  if (
    /\b(help me|can you help me|help with)\b.*\bproject work\b/.test(
      normalized,
    ) ||
    /\bproject work\b.*\b(help me|can you help me|help with)\b/.test(normalized)
  ) {
    return 'Yes. Tell me the repo, file, or task and I will help you work through it.';
  }

  if (
    /^can you check https?:\/\/\S+/.test(normalized) ||
    /^check https?:\/\/\S+/.test(normalized)
  ) {
    return 'Yes. Tell me what you want checked on that link and I will focus on that.';
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:do you know what('?s| is) what|what('?s| is) what)[?.! ]*$/,
      7,
    )
  ) {
    return "I know what's what. If chaos appears, I bring clarity and snacks.";
  }

  return buildQuickMathReply(lastContent);
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
