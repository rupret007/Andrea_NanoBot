import { redactCouncilText } from './council-safety.js';

export type ThinkingControlPreference = 'deep' | 'quick' | 'default';
export type ThinkingControlTrigger =
  | 'ultrathink'
  | 'ultracode'
  | 'deep'
  | 'quick'
  | 'default';

export function detectThinkingControlPreference(
  text: string,
): ThinkingControlPreference {
  const trigger = detectThinkingControlTrigger(text);
  if (trigger === 'quick') return 'quick';
  if (
    trigger === 'ultrathink' ||
    trigger === 'ultracode' ||
    trigger === 'deep'
  ) {
    return 'deep';
  }
  return 'default';
}

export function detectThinkingControlTrigger(
  text: string,
): ThinkingControlTrigger {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (
    /\b(quick answer|fast answer|keep it simple|short answer|no deep dive|don'?t overthink)\b/.test(
      normalized,
    )
  ) {
    return 'quick';
  }
  if (/\bultracode\b/.test(normalized)) return 'ultracode';
  if (/\bultra[- ]?think\b/.test(normalized)) return 'ultrathink';
  if (
    /\b(think harder|think deeply|use all (?:the )?models|use every model|max[- ]?iq|deep dive|be really smart|reason this through|second opinion)\b/.test(
      normalized,
    )
  ) {
    return 'deep';
  }
  return 'default';
}

export function sanitizeCouncilIntentSnippet(
  text: string,
  limit = 220,
): string {
  return redactCouncilText(text, limit);
}

export function buildThinkingStatusText(assistantName = 'Andrea'): string {
  return [
    `*${assistantName} Thinking Mode*`,
    '',
    'Smart auto is on. I keep simple chats fast, then escalate complex planning, research, calendar, drafting, troubleshooting, and higher-risk decisions to the multi-model council.',
    '',
    '*Controls*',
    '- Say `ultrathink`, `think harder`, `use all models`, `max IQ`, or `deep dive` to force the council.',
    '- Say `ultracode` for the same protected deep route on operator/code tasks.',
    '- Say `quick answer`, `fast answer`, or `keep it simple` to prefer the fast path.',
    '- I show a concise council verdict when deeper checking materially shapes the answer.',
  ].join('\n');
}

export function buildLearningStatusText(assistantName = 'Andrea'): string {
  return [
    `*${assistantName} Learning*`,
    '',
    'Aggressive learning is on with safety rails. I keep sanitized facts, preferences, procedures, and outcome lessons until you correct or forget them.',
    '',
    '*Controls*',
    '- Say `what did you learn?` to ask for a plain summary.',
    '- Say `forget that` or use `/forget` when you want a remembered detail disabled.',
    '- Say `do not learn from this` when the current exchange should stay temporary.',
    '',
    'I never store raw hidden reasoning, full private message bodies, provider prompts, secrets, or raw tool output as durable memory.',
  ].join('\n');
}

export function buildMemoryStatusText(assistantName = 'Andrea'): string {
  return [
    `*${assistantName} Memory*`,
    '',
    'Memory is split between recent working context, durable profile/preferences, and procedural lessons from successful or corrected turns.',
    '',
    'Useful phrases: `what do you remember about me?`, `what did you learn?`, `remember this`, `forget that`, and `do not learn from this`.',
  ].join('\n');
}

export function buildForgetHelpText(): string {
  return [
    '*Forget Controls*',
    '',
    'Use `forget that` while discussing a remembered detail, or reply to a memory-related answer with `forget that`.',
    '',
    'For broad cleanup, ask `what do you remember about me?` first, then tell me which detail to stop using.',
  ].join('\n');
}
