import crypto from 'crypto';

import {
  countPilotIssues,
  findRecentPilotJourneyEvent,
  getPilotJourneyEvent,
  finalizePilotJourneyEvent,
  insertPilotIssue,
  insertPilotJourneyEvent,
  listPilotIssues,
  listRecentPilotJourneyEvents,
} from './db.js';
import type {
  PilotBlockerOwner,
  PilotIssueKind,
  PilotIssueLinkedRefs,
  PilotIssueRecord,
  PilotJourneyEventRecord,
  PilotJourneyId,
  PilotJourneyOutcome,
} from './types.js';

const PILOT_LOGGING_DISABLED_VALUES = new Set(['0', 'false', 'off', 'no']);
const PILOT_EVENT_RETENTION_DAYS = 30;
const PILOT_LIVE_PROOF_DAYS = 7;

export const FLAGSHIP_PILOT_JOURNEYS: PilotJourneyId[] = [
  'ordinary_chat',
  'daily_guidance',
  'candace_followthrough',
  'mission_planning',
  'work_cockpit',
  'cross_channel_handoff',
  'alexa_orientation',
];

export interface PilotJourneySeed {
  journeyId: PilotJourneyId;
  systemsInvolved: string[];
  summaryText: string;
  routeKey?: string | null;
}

export interface PilotJourneyStartParams extends PilotJourneySeed {
  channel: PilotJourneyEventRecord['channel'];
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  startedAt?: string;
}

export interface PilotJourneyCompleteParams {
  eventId: string;
  outcome: PilotJourneyOutcome;
  blockerClass?: string | null;
  blockerOwner?: PilotBlockerOwner;
  degradedPath?: string | null;
  handoffCreated?: boolean;
  missionCreated?: boolean;
  threadSaved?: boolean;
  reminderCreated?: boolean;
  librarySaved?: boolean;
  currentWorkRef?: string | null;
  summaryText?: string | null;
  systemsInvolved?: string[];
  completedAt?: string;
}

export interface PilotIssueCaptureParams {
  channel: PilotIssueRecord['channel'];
  groupFolder: string;
  chatJid?: string | null;
  threadId?: string | null;
  utterance: string;
  routeKey?: string | null;
  assistantContextSummary?: string | null;
  linkedRefs?: PilotIssueLinkedRefs;
}

export interface PilotReviewSnapshot {
  loggingEnabled: boolean;
  recentEvents: PilotJourneyEventRecord[];
  openIssues: PilotIssueRecord[];
  openIssueCount: number;
  latestOpenIssue: PilotIssueRecord | null;
  liveProofCutoffIso: string;
}

export function isPilotLoggingEnabled(): boolean {
  const raw = (process.env.ANDREA_PILOT_LOGGING_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return !PILOT_LOGGING_DISABLED_VALUES.has(raw);
}

export function sanitizePilotSummary(
  value: string | null | undefined,
  fallback = 'pilot event',
): string {
  const normalized = (value || '')
    .replace(/\s+/g, ' ')
    .replace(/[`*_#]+/g, '')
    .trim();
  if (!normalized) return fallback;
  if (normalized.length <= 160) return normalized;
  return `${normalized.slice(0, 157).trimEnd()}...`;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function containsCandace(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => /\bcandace\b/i.test(value || ''));
}

export function classifyPilotIssueKind(text: string): PilotIssueKind | null {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (/^this felt weird\b/.test(normalized)) return 'felt_weird';
  if (/^that answer was off\b/.test(normalized)) return 'answer_off';
  if (/^this shouldn'?t have happened\b/.test(normalized)) {
    return 'should_not_happen';
  }
  if (/^mark this flow as awkward\b/.test(normalized)) return 'awkward_flow';
  if (/^save this as a pilot issue\b/.test(normalized)) {
    return 'manual_pilot_issue';
  }
  return null;
}

export function isPilotIssueCaptureRequest(text: string): boolean {
  return classifyPilotIssueKind(text) !== null;
}

export function resolvePilotJourneyFromCapability(params: {
  capabilityId: string;
  channel: PilotJourneyEventRecord['channel'];
  text?: string | null;
  canonicalText?: string | null;
  personName?: string | null;
  threadTitle?: string | null;
  summaryText?: string | null;
}): PilotJourneySeed | null {
  const lowerText = normalizeText(params.canonicalText || params.text);
  const systemSeed = {
    routeKey: params.capabilityId,
  };

  if (
    params.channel === 'alexa' &&
    (params.capabilityId.startsWith('daily.') ||
      params.capabilityId === 'household.candace_upcoming' ||
      lowerText === 'anything else')
  ) {
    return {
      journeyId: 'alexa_orientation',
      systemsInvolved: ['alexa', 'daily_companion'],
      summaryText: 'Alexa orientation turn',
      ...systemSeed,
    };
  }

  if (
    params.capabilityId === 'daily.loose_ends' ||
    params.capabilityId === 'daily.evening_reset'
  ) {
    return {
      journeyId: 'daily_guidance',
      systemsInvolved: ['daily_companion'],
      summaryText:
        params.capabilityId === 'daily.loose_ends'
          ? 'Daily loose-ends guidance'
          : 'Evening guidance',
      ...systemSeed,
    };
  }

  if (
    params.capabilityId.startsWith('communication.') &&
    containsCandace(
      params.personName,
      params.threadTitle,
      params.summaryText,
      params.canonicalText,
      params.text,
    )
  ) {
    return {
      journeyId: 'candace_followthrough',
      systemsInvolved: ['communication_companion'],
      summaryText: 'Candace follow-through',
      ...systemSeed,
    };
  }

  if (params.capabilityId.startsWith('missions.')) {
    return {
      journeyId: 'mission_planning',
      systemsInvolved: ['missions', 'chief_of_staff'],
      summaryText: 'Mission planning flow',
      ...systemSeed,
    };
  }

  if (params.capabilityId.startsWith('knowledge.') && /^save /.test(lowerText)) {
    return {
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['knowledge_library', 'cross_channel_handoffs'],
      summaryText: 'Knowledge save or handoff',
      ...systemSeed,
    };
  }

  if (
    params.capabilityId.startsWith('research.') ||
    params.capabilityId.startsWith('media.')
  ) {
    return {
      journeyId: 'cross_channel_handoff',
      systemsInvolved: [
        params.capabilityId.startsWith('media.') ? 'image_generation' : 'research',
        'cross_channel_handoffs',
      ],
      summaryText: 'Richer handoff or saved follow-through',
      ...systemSeed,
    };
  }

  return null;
}

export function resolveOrdinaryChatPilotJourney(text: string): PilotJourneySeed | null {
  const normalized = normalizeText(text);
  if (normalized === 'hi' || normalized === "what's up" || normalized === 'whats up') {
    return {
      journeyId: 'ordinary_chat',
      systemsInvolved: ['assistant_shell'],
      summaryText: 'Ordinary chat greeting',
      routeKey: 'direct_quick_reply',
    };
  }
  return null;
}

export function resolveCrossChannelPilotJourney(text: string): PilotJourneySeed | null {
  const normalized = normalizeText(text);
  if (
    /^send me the full version\b/.test(normalized) ||
    /^send me the fuller version\b/.test(normalized) ||
    /^save that for later\b/.test(normalized)
  ) {
    return {
      journeyId: 'cross_channel_handoff',
      systemsInvolved: ['cross_channel_handoffs'],
      summaryText: 'Cross-channel handoff or save',
      routeKey: 'assistant_completion',
    };
  }
  return null;
}

export function resolveWorkCockpitPilotJourney(params: {
  source: 'dashboard_open' | 'current_work' | 'reply_followup';
  laneId?: string | null;
}): PilotJourneySeed {
  const systems = ['work_cockpit'];
  if (params.laneId === 'cursor') {
    systems.push('cursor_lane');
  } else if (params.laneId === 'andrea_runtime') {
    systems.push('andrea_runtime');
  }
  return {
    journeyId: 'work_cockpit',
    systemsInvolved: systems,
    summaryText:
      params.source === 'reply_followup'
        ? 'Work cockpit continuation'
        : params.source === 'current_work'
          ? 'Current work quick-open'
          : 'Work cockpit dashboard',
    routeKey: params.source,
  };
}

export function startPilotJourney(
  params: PilotJourneyStartParams,
): PilotJourneyEventRecord | null {
  if (!isPilotLoggingEnabled()) return null;
  const startedAt = params.startedAt || new Date().toISOString();
  const record: PilotJourneyEventRecord = {
    eventId: crypto.randomUUID(),
    journeyId: params.journeyId,
    channel: params.channel,
    groupFolder: params.groupFolder,
    chatJid: params.chatJid || null,
    threadId: params.threadId || null,
    routeKey: params.routeKey || null,
    systemsInvolved: [...new Set(params.systemsInvolved || [])],
    outcome: 'abandoned',
    blockerClass: null,
    blockerOwner: 'none',
    degradedPath: null,
    handoffCreated: false,
    missionCreated: false,
    threadSaved: false,
    reminderCreated: false,
    librarySaved: false,
    currentWorkRef: null,
    summaryText: sanitizePilotSummary(params.summaryText, 'pilot journey'),
    startedAt,
    completedAt: null,
    durationMs: null,
  };
  insertPilotJourneyEvent(record);
  return record;
}

export function completePilotJourney(
  params: PilotJourneyCompleteParams,
): boolean {
  if (!isPilotLoggingEnabled()) return false;
  const completedAt = params.completedAt || new Date().toISOString();
  const existing = getPilotJourneyEvent(params.eventId);
  if (!existing) return false;
  const durationMs = Math.max(
    0,
    Date.parse(completedAt) - Date.parse(existing.startedAt),
  );
  return finalizePilotJourneyEvent(existing.eventId, {
    outcome: params.outcome,
    blockerClass: params.blockerClass || existing.blockerClass || null,
    blockerOwner: params.blockerOwner || existing.blockerOwner || 'none',
    degradedPath: params.degradedPath || existing.degradedPath || null,
    handoffCreated: params.handoffCreated ?? existing.handoffCreated,
    missionCreated: params.missionCreated ?? existing.missionCreated,
    threadSaved: params.threadSaved ?? existing.threadSaved,
    reminderCreated: params.reminderCreated ?? existing.reminderCreated,
    librarySaved: params.librarySaved ?? existing.librarySaved,
    currentWorkRef: params.currentWorkRef ?? existing.currentWorkRef ?? null,
    summaryText: sanitizePilotSummary(
      params.summaryText || existing.summaryText,
      'pilot journey',
    ),
    completedAt,
    durationMs,
    systemsInvolved: [
      ...new Set([...(existing.systemsInvolved || []), ...(params.systemsInvolved || [])]),
    ],
  });
}

function buildIssueReply(kind: PilotIssueKind): string {
  switch (kind) {
    case 'felt_weird':
      return 'Okay. I saved that as a private pilot issue.';
    case 'answer_off':
      return 'Okay. I saved that answer as a private pilot issue for review.';
    case 'should_not_happen':
      return "Okay. I saved that as a private pilot issue.";
    case 'awkward_flow':
      return 'Okay. I marked this flow as awkward for review.';
    case 'manual_pilot_issue':
    default:
      return 'Okay. I saved that as a private pilot issue.';
  }
}

export function capturePilotIssue(params: PilotIssueCaptureParams): {
  handled: boolean;
  replyText: string;
  record?: PilotIssueRecord;
} {
  const issueKind = classifyPilotIssueKind(params.utterance);
  if (!issueKind) {
    return { handled: false, replyText: '' };
  }
  if (!isPilotLoggingEnabled()) {
    return {
      handled: true,
      replyText: 'Pilot issue capture is disabled on this host.',
    };
  }

  const linkedJourney = findRecentPilotJourneyEvent({
    chatJid: params.chatJid,
    threadId: params.threadId,
    maxAgeMinutes: 30,
  });
  const contextSummary = sanitizePilotSummary(
    params.assistantContextSummary ||
      linkedJourney?.summaryText ||
      'assistant context',
    'assistant context',
  );
  const summaryText = sanitizePilotSummary(
    linkedJourney
      ? `User marked ${linkedJourney.summaryText.toLowerCase()} as ${issueKind.replace(/_/g, ' ')}.`
      : `User captured a ${issueKind.replace(/_/g, ' ')} pilot issue.`,
    'pilot issue',
  );
  const record: PilotIssueRecord = {
    issueId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'open',
    issueKind,
    channel: params.channel,
    groupFolder: params.groupFolder,
    chatJid: params.chatJid || null,
    threadId: params.threadId || null,
    journeyEventId: linkedJourney?.eventId || null,
    routeKey: params.routeKey || linkedJourney?.routeKey || null,
    blockerClass: linkedJourney?.blockerClass || null,
    blockerOwner: linkedJourney?.blockerOwner || 'none',
    summaryText,
    assistantContextSummary: contextSummary,
    linkedRefs: params.linkedRefs || {},
  };
  insertPilotIssue(record);
  return {
    handled: true,
    replyText: buildIssueReply(issueKind),
    record,
  };
}

export function buildPilotReviewSnapshot(
  now = new Date(),
): PilotReviewSnapshot {
  const retentionCutoffIso = new Date(
    now.getTime() - PILOT_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const liveProofCutoffIso = new Date(
    now.getTime() - PILOT_LIVE_PROOF_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const recentEvents = listRecentPilotJourneyEvents({ limit: 100 }).filter(
    (event) => event.startedAt >= retentionCutoffIso,
  );
  const openIssues = listPilotIssues({ status: 'open', limit: 50 });
  return {
    loggingEnabled: isPilotLoggingEnabled(),
    recentEvents,
    openIssues,
    openIssueCount: countPilotIssues('open'),
    latestOpenIssue: openIssues[0] || null,
    liveProofCutoffIso,
  };
}
