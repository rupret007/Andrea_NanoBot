import type {
  CompanionToneProfile,
  PersonalityCooldownState,
  PersonalityTexturePolicy,
  ProfileFactWithSubject,
} from './types.js';

export const COMPANION_TONE_FACT_KEY = 'companion_tone';

export type CompanionTextureContext =
  | 'launch'
  | 'help'
  | 'fallback'
  | 'daily'
  | 'household'
  | 'evening'
  | 'pulse';

interface TextureInput {
  channel: PersonalityTexturePolicy['channel'];
  context: CompanionTextureContext;
  toneProfile: CompanionToneProfile;
  directMode?: boolean;
  lowStakes?: boolean;
  cooldownState?: PersonalityCooldownState | null;
}

export function resolveCompanionToneProfileFromFacts(
  facts: Pick<ProfileFactWithSubject, 'factKey' | 'valueJson'>[],
): CompanionToneProfile {
  for (const fact of facts) {
    if (fact.factKey !== COMPANION_TONE_FACT_KEY) continue;
    try {
      const parsed = JSON.parse(fact.valueJson) as { mode?: unknown };
      if (
        parsed.mode === 'plain' ||
        parsed.mode === 'balanced' ||
        parsed.mode === 'warmer'
      ) {
        return parsed.mode;
      }
    } catch {
      return 'balanced';
    }
  }
  return 'balanced';
}

export function buildPersonalityTexturePolicy(
  input: TextureInput,
): PersonalityTexturePolicy {
  const allowTexture =
    input.directMode !== true &&
    input.lowStakes !== false &&
    input.toneProfile !== 'plain' &&
    (input.cooldownState?.cooldownTurnsRemaining || 0) <= 0;

  return {
    channel: input.channel,
    toneProfile: input.toneProfile,
    allowWarmth: input.toneProfile !== 'plain',
    allowHumor:
      allowTexture &&
      input.toneProfile === 'warmer' &&
      (input.context === 'pulse' || input.context === 'launch'),
    allowTexture,
    maxTextureLines:
      input.channel === 'alexa'
        ? allowTexture
          ? 1
          : 0
        : allowTexture
          ? 2
          : 0,
  };
}

export function buildCompanionTextureLine(
  input: TextureInput & {
    leadReason?: string;
  },
): string | null {
  const policy = buildPersonalityTexturePolicy(input);
  if (!policy.allowTexture || policy.maxTextureLines === 0) {
    return null;
  }

  if (input.context === 'pulse') {
    return policy.allowHumor
      ? 'A small oddball one, just because.'
      : 'A small interesting one for today.';
  }

  switch (input.context) {
    case 'launch':
      return input.toneProfile === 'warmer'
        ? 'We can keep it simple.'
        : 'We can keep this simple.';
    case 'help':
      return 'I can keep it practical.';
    case 'fallback':
      return 'We can keep going from there.';
    case 'household':
      return 'This feels more like a quick check-in than a big knot.';
    case 'evening':
      return input.leadReason === 'unfinished_today'
        ? 'So this is mostly about closing one clean loop.'
        : 'So tonight is more about a clean handoff than urgency.';
    case 'daily':
      if (input.leadReason === 'nothing_urgent') {
        return 'So you have a little breathing room.';
      }
      if (input.leadReason === 'weak_signal') {
        return 'So this is more about staying ahead than catching up.';
      }
      return 'So the main thing is fairly clear.';
    default:
      return null;
  }
}

export function consumePersonalityCooldown(
  usedTextureKind?: PersonalityCooldownState['lastTextureKind'],
): PersonalityCooldownState {
  return usedTextureKind
    ? {
        lastTextureKind: usedTextureKind,
        lastTexturedAt: new Date().toISOString(),
        cooldownTurnsRemaining: 2,
      }
    : {
        lastTextureKind: null,
        lastTexturedAt: null,
        cooldownTurnsRemaining: 0,
      };
}

