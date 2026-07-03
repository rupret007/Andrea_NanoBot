import crypto from 'crypto';

import {
  getActiveOperatingProfile,
  listLifeThreadsForGroup,
  listProfileFactsForGroup,
  upsertOperatingProfile,
} from './db.js';
import type {
  LifeThread,
  OperatingProfile,
  OperatingProfileIntake,
  OperatingProfilePlan,
  ProfileFactWithSubject,
} from './types.js';

export interface OnboardingProfilePackFact {
  category: string;
  factKey: string;
  subjectKind: string;
  summary: string;
  confidence?: number | null;
  freshness?: string | null;
  source?: string | null;
}

export interface OnboardingProfilePackThread {
  title: string;
  category: string;
  scope: string;
  summary: string;
  followthroughMode: string;
}

export interface OnboardingProfilePack {
  version: 1;
  exportedAt: string;
  setupCompleteness: {
    hasActiveProfile: boolean;
    memoryFacts: number;
    lifeThreads: number;
    answeredSetupAreas: string[];
  };
  operatingProfile?: {
    summary: string;
    trackedAreas: string[];
    defaultGroups: string[];
    routines: string[];
    richerSurface: string;
    learningPolicy: string;
  } | null;
  memoryQuality: {
    acceptedFacts: number;
    factsWithConfidence: number;
    factsWithFreshness: number;
    factsWithSource: number;
  };
  facts: OnboardingProfilePackFact[];
  lifeThreads: OnboardingProfilePackThread[];
  privacy: {
    redacted: true;
    rawIdentifiersIncluded: false;
    rawTranscriptsIncluded: false;
    secretValuesIncluded: false;
  };
}

export interface ImportOnboardingProfilePackResult {
  profile: OperatingProfile;
  importedAreas: string[];
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function redactPackText(value: string | null | undefined, max = 220): string {
  const normalized = normalizeText(value);
  const clipped =
    normalized.length <= max
      ? normalized
      : `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
  return clipped
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[phone]')
    .replace(/\bbb:[^\s"']+/gi, '[chat]')
    .replace(/\b(?:iMessage|SMS);[^\s"']+/gi, '[chat]')
    .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]');
}

function summarizeFact(
  fact: ProfileFactWithSubject,
): OnboardingProfilePackFact {
  const value = safeJsonParse<Record<string, unknown>>(fact.valueJson, {});
  const nested =
    value && typeof value === 'object' && 'value' in value
      ? (value as {
          value?: unknown;
          confidence?: unknown;
          freshness?: unknown;
          source?: unknown;
        })
      : null;
  const summaryValue =
    nested && nested.value !== undefined ? nested.value : value;
  return {
    category: fact.category,
    factKey: fact.factKey,
    subjectKind: fact.subjectKind,
    summary: redactPackText(JSON.stringify(summaryValue), 260),
    confidence:
      typeof nested?.confidence === 'number' ? nested.confidence : null,
    freshness: typeof nested?.freshness === 'string' ? nested.freshness : null,
    source: typeof nested?.source === 'string' ? nested.source : null,
  };
}

function summarizeThread(thread: LifeThread): OnboardingProfilePackThread {
  return {
    title: redactPackText(thread.title, 80),
    category: thread.category,
    scope: thread.scope,
    summary: redactPackText(thread.summary, 260),
    followthroughMode: thread.followthroughMode,
  };
}

function setupAreaFromFactKey(factKey: string): string {
  const raw = factKey.replace(/^setup\./, '');
  const aliases: Record<string, string> = {
    known_person: 'people',
    tracking_priorities: 'tracking',
    daily_rhythm: 'rhythm',
    communication_style: 'style',
    integration_priorities: 'integrations',
    privacy_comfort: 'privacy',
    first_outcomes: 'outcomes',
  };
  return aliases[raw] || raw;
}

function parseActivePlan(
  profile: OperatingProfile | null,
): OperatingProfilePlan {
  if (!profile) {
    return {
      summary: 'Andrea has no active setup yet.',
      trackedAreas: [],
      defaultGroups: [],
      routines: [],
      reminderSuggestions: [],
      richerSurface: 'telegram',
      desiredIntegrations: [],
      learningPolicy: 'suggest_then_confirm',
    };
  }
  return safeJsonParse<OperatingProfilePlan>(profile.planJson, {
    summary: 'Andrea is tracking everyday follow-through.',
    trackedAreas: [],
    defaultGroups: [],
    routines: [],
    reminderSuggestions: [],
    richerSurface: 'telegram',
    desiredIntegrations: [],
    learningPolicy: 'suggest_then_confirm',
  });
}

export function exportRedactedOnboardingProfilePack(params: {
  groupFolder: string;
  now?: Date;
}): OnboardingProfilePack {
  const exportedAt = (params.now || new Date()).toISOString();
  const activeProfile = getActiveOperatingProfile(params.groupFolder) || null;
  const plan = parseActivePlan(activeProfile);
  const facts = listProfileFactsForGroup(params.groupFolder, ['accepted']);
  const lifeThreads = listLifeThreadsForGroup(params.groupFolder, [
    'active',
    'paused',
  ]);
  const factSummaries = facts.map(summarizeFact);
  const answeredSetupAreas = [
    ...new Set(
      facts
        .filter((fact) => fact.factKey.startsWith('setup.'))
        .map((fact) => setupAreaFromFactKey(fact.factKey)),
    ),
  ].sort();

  return {
    version: 1,
    exportedAt,
    setupCompleteness: {
      hasActiveProfile: Boolean(activeProfile),
      memoryFacts: facts.length,
      lifeThreads: lifeThreads.length,
      answeredSetupAreas,
    },
    operatingProfile: activeProfile
      ? {
          summary: redactPackText(plan.summary, 260),
          trackedAreas: plan.trackedAreas.map((area) =>
            redactPackText(area, 80),
          ),
          defaultGroups: plan.defaultGroups.map((group) =>
            redactPackText(group.title, 80),
          ),
          routines: plan.routines.map((routine) => redactPackText(routine, 80)),
          richerSurface: plan.richerSurface,
          learningPolicy: plan.learningPolicy,
        }
      : null,
    memoryQuality: {
      acceptedFacts: facts.length,
      factsWithConfidence: factSummaries.filter(
        (fact) => typeof fact.confidence === 'number',
      ).length,
      factsWithFreshness: factSummaries
        .filter(Boolean)
        .filter((fact) => Boolean(fact.freshness)).length,
      factsWithSource: factSummaries.filter((fact) => Boolean(fact.source))
        .length,
    },
    facts: factSummaries.slice(0, 40),
    lifeThreads: lifeThreads.map(summarizeThread).slice(0, 30),
    privacy: {
      redacted: true,
      rawIdentifiersIncluded: false,
      rawTranscriptsIncluded: false,
      secretValuesIncluded: false,
    },
  };
}

export function importRedactedOnboardingProfilePack(params: {
  groupFolder: string;
  pack: OnboardingProfilePack;
  now?: Date;
}): ImportOnboardingProfilePackResult {
  const nowIso = (params.now || new Date()).toISOString();
  const profile = params.pack.operatingProfile;
  const plan: OperatingProfilePlan = {
    summary:
      profile?.summary ||
      'Andrea should start with a privacy-safe imported setup shape.',
    trackedAreas: profile?.trackedAreas || [],
    defaultGroups: (profile?.defaultGroups || []).map((title) => ({
      title,
      kind: 'general',
      scope: 'personal',
      purpose: 'Imported redacted starter group.',
    })),
    routines: profile?.routines || [],
    reminderSuggestions: [],
    richerSurface:
      profile?.richerSurface === 'alexa' ||
      profile?.richerSurface === 'bluebubbles'
        ? profile.richerSurface
        : 'telegram',
    desiredIntegrations: [],
    learningPolicy: 'suggest_then_confirm',
  };
  const intake: OperatingProfileIntake = {
    rawText: 'Imported redacted onboarding profile pack.',
    routines: plan.routines,
    trackingPriorities: plan.trackedAreas,
    defaultGroups: plan.defaultGroups.map((group) => group.title),
    integrationsWanted: [],
    richerSurface: plan.richerSurface,
    scope: 'personal',
    notes: [
      'Imported from a redacted profile pack. Private facts require user confirmation.',
    ],
  };
  const record: OperatingProfile = {
    profileId: crypto.randomUUID(),
    groupFolder: params.groupFolder,
    status: 'draft',
    version: 1,
    basedOnProfileId: null,
    intakeJson: JSON.stringify(intake),
    planJson: JSON.stringify(plan),
    sourceChannel: 'system',
    createdAt: nowIso,
    updatedAt: nowIso,
    approvedAt: null,
    supersededAt: null,
  };
  upsertOperatingProfile(record);
  return {
    profile: record,
    importedAreas: params.pack.setupCompleteness.answeredSetupAreas,
  };
}
