import type { NewMessage } from './types.js';
import {
  buildGracefulDegradedReply,
  type ConversationalChannel,
} from './conversational-core.js';
import { buildAndreaPingPresenceReply } from './ping-presence.js';

const MAX_ABS_MATH_RESULT = 1_000_000_000_000;

function stripAndreaAddressing(normalized: string): string {
  return normalized
    .replace(/(^|[\s([{\-])@andrea\b[,:;!?-]*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(input: string): string {
  return stripAndreaAddressing(
    input
    .toLowerCase()
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim(),
  );
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

function pickDeterministicVariant(
  normalized: string,
  variants: readonly string[],
): string {
  const seed = [...normalized].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return variants[seed % variants.length] || variants[0] || '';
}

function isStandalonePrompt(
  normalized: string,
  pattern: RegExp,
  maxWords = 4,
): boolean {
  return pattern.test(normalized) && countWords(normalized) <= maxWords;
}

function formatClockInZone(date: Date, timeZone: string): string {
  return date.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatLocalClock(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function formatLocalDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function buildQuickTimeReply(message: string, now: Date): string | null {
  const normalized = normalizeText(message);
  const isPlainLocalTimeAsk =
    /^(?:what time is it|what's the time|whats the time|time)(?: right now)?[?.! ]*$/.test(
      normalized,
    );
  const isLocationTimeAsk =
    /^(?:what time is it|what's the time|whats the time)(?: right now)? in\b/.test(
      normalized,
    ) || /\btime in\b/.test(normalized);

  if (!isPlainLocalTimeAsk && !isLocationTimeAsk) {
    return null;
  }

  if (isPlainLocalTimeAsk) {
    return `Right now it's ${formatLocalClock(now)}.`;
  }

  if (/\baustralia\b/.test(normalized)) {
    const sydney = formatClockInZone(now, 'Australia/Sydney');
    const perth = formatClockInZone(now, 'Australia/Perth');
    return `Australia spans a few time zones. Right now it's ${sydney} in Sydney and ${perth} in Perth.`;
  }

  const cityTargets = [
    { label: 'Sydney', pattern: /\bsydney\b/, timeZone: 'Australia/Sydney' },
    {
      label: 'Melbourne',
      pattern: /\bmelbourne\b/,
      timeZone: 'Australia/Melbourne',
    },
    {
      label: 'Brisbane',
      pattern: /\bbrisbane\b/,
      timeZone: 'Australia/Brisbane',
    },
    {
      label: 'Adelaide',
      pattern: /\badelaide\b/,
      timeZone: 'Australia/Adelaide',
    },
    { label: 'Darwin', pattern: /\bdarwin\b/, timeZone: 'Australia/Darwin' },
    { label: 'Perth', pattern: /\bperth\b/, timeZone: 'Australia/Perth' },
    { label: 'Tokyo', pattern: /\btokyo\b/, timeZone: 'Asia/Tokyo' },
    { label: 'London', pattern: /\blondon\b/, timeZone: 'Europe/London' },
    {
      label: 'New York',
      pattern: /\bnew york\b/,
      timeZone: 'America/New_York',
    },
    { label: 'Chicago', pattern: /\bchicago\b/, timeZone: 'America/Chicago' },
    {
      label: 'Los Angeles',
      pattern: /\blos angeles\b/,
      timeZone: 'America/Los_Angeles',
    },
  ];

  const match = cityTargets.find((target) => target.pattern.test(normalized));
  if (!match) return null;

  return `Right now it's ${formatClockInZone(now, match.timeZone)} in ${match.label}.`;
}

function buildQuickDateReply(message: string, now: Date): string | null {
  const normalized = normalizeText(message);

  if (
    !/^(?:what day is it|what day is today|what day is it today|what's the date|whats the date|what is the date|what is today's date|what's today's date|what day is it right now|date)(?: today| right now)?[?.! ]*$/.test(
      normalized,
    )
  ) {
    return null;
  }

  return `Today is ${formatLocalDate(now)}.`;
}

export function maybeBuildDirectQuickReply(
  messages: Pick<NewMessage, 'content'>[],
  now = new Date(),
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
    return "Keeping tasks, reminders, research, and messy decisions clean and calm. Give me one concrete ask and I'll keep it moving.";
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
    return pickDeterministicVariant(normalized, [
      "Hi. I'm here. What do you want to tackle?",
      "Hey. I'm here and ready.",
      "Hi. Give me one thing and I'll keep it simple.",
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:(?:hi|hello|hey|good morning|good afternoon|good evening)[!., ]+)?(?:(?:how(?:'s|s| is) it going)|(?:how are you))(?: (?:this|your)? ?(?:morning|afternoon|evening|today))?[?.! ]*$/,
      9,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Doing well and ready. What do you want to tackle?',
      "Doing well over here. What's the move?",
      'Doing well and ready to help. What are we working on?',
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:how are you|how're you)(?: today)?[?.! ]*$/,
      5,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Doing well and ready. What do you want to tackle?',
      "Doing well over here. What's the move?",
      'Doing well and ready to help. What are we working on?',
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:(?:hi|hello|hey)[!., ]+)?(?:what('?s| is) up|sup)[?.! ]*$/,
      6,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Not much. I am here if you need anything.',
      "Keeping an eye on things. What's up on your side?",
      'Pretty calm over here. What do you need from me?',
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:what are you doing|what'?re you doing)[?.! ]*$/,
      5,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Keeping an eye on things and ready to help.',
      "Hanging out quietly until you throw me something useful.",
      'Staying ready and trying not to make your chat weird.',
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:can you help me|help me)\??[!. ]*$/,
      5,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Yes. Tell me what you want to get done and I will help you work through it.',
      'Yes. Give me the task or question and we will take it from there.',
      'Absolutely. Give me one concrete thing and I will help you move it forward.',
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(?:you there|are you there|still there|you)\??[!. ]*$/,
      3,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      "I'm here.",
      "I'm here and ready.",
      "Still here.",
    ]);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(thanks|thank you|thx)(?:[!., ]+| andrea)*$/,
      4,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Anytime.',
      'Of course.',
      'Happy to help.',
    ]);
  }

  if (/^ping[!. ]*$/.test(normalized)) {
    return buildAndreaPingPresenceReply(undefined, now);
  }

  if (
    isStandalonePrompt(
      normalized,
      /^(ok|okay|kk|yes|yep|yup|sure|sounds good|that works|go ahead|please do)[!. ]*$/,
      3,
    )
  ) {
    return pickDeterministicVariant(normalized, [
      'Sounds good.',
      'Okay.',
      'All right.',
    ]);
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
      /^(?:can|do) you use (?:(?:cursor(?: and codex)?|codex(?: and cursor)?))(?: right now)?[?.! ]*$/,
      8,
    )
  ) {
    return 'Yes. I can help with coding and repo work through Andrea when that lane is available.';
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

  const quickTimeReply = buildQuickTimeReply(lastContent, now);
  if (quickTimeReply) return quickTimeReply;

  const quickDateReply = buildQuickDateReply(lastContent, now);
  if (quickDateReply) return quickDateReply;

  return buildQuickMathReply(lastContent);
}

export function maybeBuildDirectRescueReply(
  messages: Pick<NewMessage, 'content'>[],
  now = new Date(),
  channel: ConversationalChannel = 'telegram',
): string | null {
  const lastContent = messages.at(-1)?.content?.trim();
  if (!lastContent) return null;

  const normalized = normalizeText(lastContent);
  const quickReply = maybeBuildDirectQuickReply(messages, now);
  if (quickReply) return quickReply;

  const shortTurn =
    normalized.length <= 120 &&
    countWords(normalized) <= 12 &&
    !normalized.startsWith('/') &&
    !normalized.includes('http://') &&
    !normalized.includes('https://');

  if (!shortTurn) return null;

  return buildGracefulDegradedReply({
    kind: 'assistant_runtime_unavailable',
    channel,
    text: lastContent,
  });
}

export function buildDirectAssistantRuntimeFailureReply(
  messages: Pick<NewMessage, 'content'>[],
  runtimeMessage: string | null = null,
  now = new Date(),
  channel: ConversationalChannel = 'telegram',
): string {
  return (
    maybeBuildDirectRescueReply(messages, now, channel) ??
    buildGracefulDegradedReply({
      kind: 'assistant_runtime_unavailable',
      channel,
      text: messages.at(-1)?.content || runtimeMessage || '',
    })
  );
}
