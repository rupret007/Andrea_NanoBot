import crypto from 'crypto';

import { buildCompanionTextureLine } from './companion-personality.js';
import type {
  CompanionToneProfile,
  PersonalityCooldownState,
  PulseMode,
  PulsePreference,
} from './types.js';
import { buildVoiceReply, normalizeVoicePrompt } from './voice-ready.js';

export interface AndreaPulseItem {
  id: string;
  title: string;
  summary: string;
  detail: string;
  tags: string[];
}

export interface AndreaPulseResult {
  item: AndreaPulseItem;
  replyText: string;
  summaryText: string;
  cooldown: PersonalityCooldownState;
}

const DEFAULT_PULSE_PREFERENCE: PulsePreference = {
  mode: 'request_only',
  scheduledDeliveryEnabled: false,
  updatedAt: null,
};

const PULSE_CATALOG: AndreaPulseItem[] = [
  {
    id: 'pulse-octopus-hearts',
    title: 'Octopus hearts',
    summary: 'A small odd one: octopuses have three hearts.',
    detail: 'Two handle the gills, and the main one stops while they swim.',
    tags: ['weird', 'nature'],
  },
  {
    id: 'pulse-banana-berry',
    title: 'Banana berry',
    summary: 'A botanical oddity: bananas count as berries, but strawberries do not.',
    detail:
      'Botanists classify them by how the fruit develops, not by how the grocery store labels them.',
    tags: ['weird', 'food'],
  },
  {
    id: 'pulse-honey-never-spoils',
    title: 'Honey keeps',
    summary: 'Honey can stay edible for an absurdly long time.',
    detail:
      'Its low water content and acidity make it a rough place for microbes to settle in.',
    tags: ['interesting', 'food', 'history'],
  },
  {
    id: 'pulse-sharks-before-trees',
    title: 'Sharks before trees',
    summary: 'Sharks are older than trees.',
    detail:
      'Early sharks were already around hundreds of millions of years before the first trees showed up.',
    tags: ['weird', 'history', 'nature'],
  },
  {
    id: 'pulse-cleopatra-moon',
    title: 'Cleopatra and the moon',
    summary:
      'Cleopatra lived closer to the moon landing than to the building of the Great Pyramid.',
    detail:
      'Ancient history is longer than it feels when it all gets grouped into one mental bucket.',
    tags: ['interesting', 'history'],
  },
  {
    id: 'pulse-wombat-cubes',
    title: 'Wombat cubes',
    summary: 'Wombats really do make cube-shaped poop.',
    detail:
      'It helps keep the markers from rolling away, which is unexpectedly practical.',
    tags: ['weird', 'nature'],
  },
  {
    id: 'pulse-venus-day',
    title: 'Venus day',
    summary: 'A day on Venus is longer than a year on Venus.',
    detail:
      'It spins so slowly that one full rotation takes longer than one trip around the sun.',
    tags: ['interesting', 'space'],
  },
  {
    id: 'pulse-pigeons-navigation',
    title: 'Pigeon navigation',
    summary: "Pigeons can use Earth's magnetic field as part of how they navigate.",
    detail:
      'They also combine that with visual landmarks and smell, which is a pretty capable stack for a bird.',
    tags: ['interesting', 'nature'],
  },
];

function hashSeed(value: string): number {
  const digest = crypto.createHash('sha256').update(value).digest();
  return digest.readUInt32BE(0);
}

function choosePulseItem(
  query: string,
  now: Date,
  previousSummary?: string,
  options: {
    reusePrevious?: boolean;
  } = {},
): AndreaPulseItem {
  const normalized = normalizeVoicePrompt(query).toLowerCase();
  const priorItem = previousSummary
    ? PULSE_CATALOG.find(
        (item) =>
          item.summary.toLowerCase() === previousSummary.toLowerCase().trim(),
      )
    : null;
  const wantedTag = /\bweird\b/.test(normalized)
    ? 'weird'
    : /\b(history|ancient|older)\b/.test(normalized)
      ? 'history'
      : /\b(space|planet|moon|sun)\b/.test(normalized)
        ? 'space'
        : /\b(food|eat|kitchen|honey|banana)\b/.test(normalized)
          ? 'food'
          : null;
  const pool = wantedTag
    ? PULSE_CATALOG.filter((item) => item.tags.includes(wantedTag))
    : PULSE_CATALOG;
  if (options.reusePrevious && priorItem) {
    return priorItem;
  }
  const seed = `${normalized || 'pulse'}:${now.toISOString().slice(0, 10)}`;
  const startIndex = hashSeed(seed) % pool.length;

  for (let offset = 0; offset < pool.length; offset += 1) {
    const candidate = pool[(startIndex + offset) % pool.length]!;
    if (!priorItem || candidate.id !== priorItem.id || pool.length === 1) {
      return candidate;
    }
  }

  return pool[0]!;
}

export function getDefaultPulsePreference(): PulsePreference {
  return { ...DEFAULT_PULSE_PREFERENCE };
}

export function resolvePulseMode(
  preference: PulsePreference | undefined,
): PulseMode {
  return preference?.mode || DEFAULT_PULSE_PREFERENCE.mode;
}

export function buildAndreaPulseReply(params: {
  channel: 'alexa' | 'telegram' | 'bluebubbles';
  query: string;
  toneProfile?: CompanionToneProfile;
  now?: Date;
  previousSummary?: string;
}): AndreaPulseResult {
  const now = params.now || new Date();
  const toneProfile = params.toneProfile || 'balanced';
  const wantsMore = /^(say more|tell me more)\b/i.test(params.query.trim());
  const wantsShorter = /^(make that shorter|shorter|be (a little |a bit )?more direct)\b/i.test(
    params.query.trim(),
  );
  const item = choosePulseItem(params.query, now, params.previousSummary, {
    reusePrevious: wantsMore || wantsShorter,
  });
  const textureLine = wantsShorter
    ? null
    : buildCompanionTextureLine({
    channel: params.channel,
    context: 'pulse',
    toneProfile,
    lowStakes: true,
  });

  const replyText =
    params.channel === 'alexa'
      ? buildVoiceReply({
          summary: item.summary,
          details: [textureLine, wantsMore ? item.detail : null],
          maxDetails: wantsMore ? 2 : 1,
        })
      : [item.summary, textureLine, wantsMore ? item.detail : null]
          .filter((line): line is string => Boolean(line))
          .join('\n');

  return {
    item,
    replyText,
    summaryText: item.summary,
    cooldown: {
      lastTextureKind: 'pulse',
      lastTexturedAt: now.toISOString(),
      cooldownTurnsRemaining: 2,
    },
  };
}
