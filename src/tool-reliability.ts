import crypto from 'crypto';

import {
  getAllTasks,
  isDatabaseInitialized,
  listCognitiveExecutiveToolChoices,
  listCognitiveReflectionSignals,
  listReliabilityObservations,
  listRouteConfidenceRollups,
  listToolDependencyLinks,
  listToolReliabilityRollups,
  listToolReliabilitySubjects,
  upsertReliabilityObservation,
  upsertRouteConfidenceRollup,
  upsertToolDependencyLink,
  upsertToolReliabilityRollup,
  upsertToolReliabilitySubject,
} from './db.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import type {
  CognitiveExecutiveChannel,
  ReliabilityObservation,
  RouteConfidenceRollup,
  ToolDependencyLink,
  ToolReliabilityDoctorReport,
  ToolReliabilityRollup,
  ToolReliabilitySubject,
  ScheduledTask,
} from './types.js';

const PRIVACY = {
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
} as const;

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function clamp(value: number, min = 0, max = 1): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function privacyJson(): string {
  return json(PRIVACY);
}

const STATIC_SUBJECTS: ToolReliabilitySubject[] = [
  subject(
    'route:cognitive_executive.daily_companion',
    'route',
    'Daily companion route',
    ['what should I do next'],
    'low',
    'none',
    ['telegram', 'alexa'],
  ),
  subject(
    'route:cognitive_executive.communication_companion',
    'route',
    'Communication companion route',
    ['what should I say back'],
    'medium',
    'confirmation',
    ['telegram', 'bluebubbles'],
  ),
  subject(
    'route:cognitive_executive.everyday_capture',
    'route',
    'Everyday capture route',
    ['save that for later'],
    'low',
    'none',
    ['telegram', 'alexa', 'bluebubbles'],
  ),
  subject(
    'route:cognitive_executive.research',
    'route',
    'Research route',
    ['research', 'look up'],
    'low',
    'none',
    ['telegram'],
  ),
  subject(
    'tool:calendar',
    'cognitive_tool',
    'Calendar',
    ['google calendar'],
    'high',
    'confirmation',
    ['telegram', 'alexa'],
  ),
  subject(
    'tool:message_actions',
    'cognitive_tool',
    'Message send actions',
    ['send later', 'reply draft'],
    'critical',
    'confirmation',
    ['telegram', 'bluebubbles'],
  ),
  subject(
    'tool:reminders',
    'cognitive_tool',
    'Internal reminders',
    ['reminder', 'follow-up'],
    'medium',
    'none',
    ['telegram', 'alexa', 'bluebubbles', 'operator', 'internal'],
  ),
  subject(
    'tool:work_cockpit',
    'cognitive_tool',
    'Work cockpit',
    ['cursor', 'current work'],
    'high',
    'main_control',
    ['telegram'],
  ),
  subject(
    'tool:research',
    'cognitive_tool',
    'Research',
    ['brave search'],
    'low',
    'none',
    ['telegram'],
  ),
  subject(
    'integration:google_calendar',
    'integration',
    'Google Calendar integration',
    ['calendar'],
    'high',
    'confirmation',
    ['telegram', 'alexa'],
  ),
  subject(
    'integration:bluebubbles',
    'integration',
    'BlueBubbles integration',
    ['messages'],
    'critical',
    'confirmation',
    ['bluebubbles', 'telegram'],
  ),
  subject(
    'integration:alexa',
    'integration',
    'Alexa integration',
    ['voice'],
    'medium',
    'manual_external',
    ['alexa'],
  ),
  subject(
    'integration:telegram',
    'integration',
    'Telegram integration',
    ['main chat'],
    'medium',
    'main_control',
    ['telegram'],
  ),
  subject(
    'provider:openai_cloud',
    'provider',
    'OpenAI provider',
    ['openai'],
    'low',
    'none',
    ['cross_channel'],
  ),
  subject(
    'provider:anthropic_cloud',
    'provider',
    'Anthropic provider',
    ['claude'],
    'low',
    'none',
    ['cross_channel'],
  ),
  subject(
    'provider:gemini_cloud',
    'provider',
    'Gemini provider',
    ['gemini'],
    'low',
    'none',
    ['cross_channel'],
  ),
  subject(
    'provider:minimax_cloud',
    'provider',
    'MiniMax provider',
    ['minimax'],
    'low',
    'none',
    ['cross_channel'],
  ),
  subject(
    'provider:brave_search',
    'provider',
    'Brave Search provider',
    ['brave'],
    'low',
    'none',
    ['cross_channel'],
  ),
];

function subject(
  subjectId: string,
  subjectKind: ToolReliabilitySubject['subjectKind'],
  displayName: string,
  aliases: string[],
  riskLevel: ToolReliabilitySubject['riskLevel'],
  approvalRequirement: ToolReliabilitySubject['approvalRequirement'],
  channels: string[],
): ToolReliabilitySubject {
  return {
    subjectId,
    subjectKind,
    displayName,
    aliasesJson: json(aliases),
    riskLevel,
    approvalRequirement,
    channelsJson: json(channels),
    sourceRefsJson: json(['cognitive_executive', 'integration_doctor']),
    privacyJson: privacyJson(),
  };
}

const STATIC_LINKS: ToolDependencyLink[] = [
  link(
    'route:cognitive_executive.daily_companion',
    'integration:google_calendar',
    'integration',
    'Daily guidance is better with current calendar proof.',
  ),
  link(
    'route:cognitive_executive.communication_companion',
    'integration:bluebubbles',
    'integration',
    'Reply help in Messages depends on BlueBubbles proof/readiness.',
  ),
  link(
    'route:cognitive_executive.everyday_capture',
    'integration:telegram',
    'integration',
    'Capture is most reliable through Telegram/main control.',
  ),
  link(
    'route:cognitive_executive.research',
    'provider:brave_search',
    'provider',
    'Live research depends on Brave Search.',
  ),
  link(
    'tool:calendar',
    'integration:google_calendar',
    'integration',
    'Calendar tool depends on Google Calendar health.',
  ),
  link(
    'tool:message_actions',
    'integration:bluebubbles',
    'integration',
    'Message send actions depend on bounded Messages proof.',
  ),
  link(
    'tool:research',
    'provider:brave_search',
    'provider',
    'Research tool depends on Brave Search.',
  ),
  link(
    'tool:work_cockpit',
    'integration:telegram',
    'integration',
    'Operator work cockpit controls require main Telegram control.',
  ),
];

function link(
  subjectId: string,
  dependencySubjectId: string,
  dependencyKind: ToolDependencyLink['dependencyKind'],
  reason: string,
  fallbackSubjectId?: string,
): ToolDependencyLink {
  return {
    linkId: hashId(
      'dep',
      `${subjectId}|${dependencySubjectId}|${dependencyKind}`,
    ),
    subjectId,
    dependencySubjectId,
    dependencyKind,
    reason,
    fallbackSubjectId: fallbackSubjectId || null,
    privacyJson: privacyJson(),
  };
}

function providerOutcome(
  provider: ProviderHealthSnapshot,
): ReliabilityObservation['outcome'] {
  if (provider.state === 'healthy') return 'success';
  if (
    provider.state === 'externally_blocked' ||
    provider.state === 'not_configured'
  ) {
    return 'blocked';
  }
  if (provider.state === 'degraded') return 'degraded';
  return 'unknown';
}

function integrationOutcome(
  status: IntegrationStatus,
): ReliabilityObservation['outcome'] {
  if (status.state === 'healthy') return 'success';
  if (
    status.state === 'externally_blocked' ||
    status.state === 'needs_auth' ||
    status.state === 'manual_action_required'
  ) {
    return 'blocked';
  }
  if (
    status.state === 'degraded_but_usable' ||
    status.state === 'needs_proof' ||
    status.state === 'near_live_only' ||
    status.state === 'repo_fix_available'
  ) {
    return 'degraded';
  }
  return 'unknown';
}

function confidenceForOutcome(
  outcome: ReliabilityObservation['outcome'],
): number {
  if (outcome === 'success') return 0.95;
  if (outcome === 'degraded') return 0.55;
  if (outcome === 'blocked' || outcome === 'failed') return 0.15;
  if (outcome === 'fallback') return 0.45;
  return 0.35;
}

function observation(params: {
  subjectId: string;
  observedAt: string;
  sourceKind: ReliabilityObservation['sourceKind'];
  outcome: ReliabilityObservation['outcome'];
  failureClass?: string;
  fallbackUsed?: boolean;
  summary: string;
  nextAction?: string;
  evidenceIds?: string[];
}): ReliabilityObservation {
  return {
    observationId: hashId(
      'relobs',
      `${params.subjectId}|${params.sourceKind}|${params.outcome}|${params.observedAt}`,
    ),
    subjectId: params.subjectId,
    observedAt: params.observedAt,
    sourceKind: params.sourceKind,
    outcome: params.outcome,
    failureClass: params.failureClass || 'none',
    confidence: confidenceForOutcome(params.outcome),
    fallbackUsed: Boolean(params.fallbackUsed),
    latencyMs: null,
    summary: params.summary,
    nextAction: params.nextAction || '',
    evidenceIdsJson: json(params.evidenceIds || []),
    privacyJson: privacyJson(),
  };
}

function isReminderTask(task: ScheduledTask): boolean {
  return /\breminder\b/i.test(task.prompt || '');
}

function summarizeReminderTaskEvidence(
  tasks: ScheduledTask[],
  generatedAt: string,
): {
  hasEvidence: boolean;
  lastEvidenceAt: string | null;
  evidenceIds: string[];
} {
  const nowMs = Date.parse(generatedAt);
  const recentWindowMs = 30 * 24 * 60 * 60 * 1000;
  const reminderTasks = tasks.filter(isReminderTask);
  const active = reminderTasks.find((task) => task.status === 'active');
  if (active) {
    return {
      hasEvidence: true,
      lastEvidenceAt: active.created_at || active.next_run || null,
      evidenceIds: [`scheduled_task:${active.id}`],
    };
  }
  const recentCompleted = reminderTasks.find((task) => {
    if (task.status !== 'completed') return false;
    const evidenceAt = Date.parse(task.last_run || task.created_at || '');
    return Number.isFinite(evidenceAt) && nowMs - evidenceAt <= recentWindowMs;
  });
  return {
    hasEvidence: Boolean(recentCompleted),
    lastEvidenceAt:
      recentCompleted?.last_run || recentCompleted?.created_at || null,
    evidenceIds: recentCompleted
      ? [`scheduled_task:${recentCompleted.id}`]
      : [],
  };
}

export function seedToolReliabilityRegistry(): void {
  if (!isDatabaseInitialized()) return;
  for (const item of STATIC_SUBJECTS) upsertToolReliabilitySubject(item);
  for (const item of STATIC_LINKS) upsertToolDependencyLink(item);
}

function buildRollup(
  subjectId: string,
  observations: ReliabilityObservation[],
  updatedAt: string,
): ToolReliabilityRollup {
  const sample = observations.slice(0, 30);
  const sampleCount = sample.length;
  const count = (outcomes: ReliabilityObservation['outcome'][]): number =>
    sample.filter((item) => outcomes.includes(item.outcome)).length;
  const denom = Math.max(1, sampleCount);
  const successRate = count(['success']) / denom;
  const degradedRate = count(['degraded', 'fallback']) / denom;
  const blockedRate = count(['blocked', 'failed']) / denom;
  const fallbackRate = count(['fallback']) / denom;
  const latest = sample[0];
  const currentHealth: ToolReliabilityRollup['currentHealth'] = !latest
    ? 'unknown'
    : latest.outcome === 'success'
      ? 'healthy'
      : latest.outcome === 'degraded' || latest.outcome === 'fallback'
        ? 'degraded'
        : latest.outcome === 'blocked' || latest.outcome === 'failed'
          ? 'blocked'
          : 'unknown';
  const reliabilityScore = clamp(
    successRate + degradedRate * 0.45 - blockedRate * 0.55,
  );
  const confidenceCap =
    currentHealth === 'healthy'
      ? 0.95
      : currentHealth === 'degraded'
        ? 0.58
        : currentHealth === 'blocked'
          ? 0.22
          : 0.5;
  return {
    subjectId,
    updatedAt,
    sampleCount,
    successRate,
    degradedRate,
    blockedRate,
    fallbackRate,
    reliabilityScore,
    currentHealth,
    confidenceCap,
    cooldownUntil: null,
    nextAction: latest?.nextAction || 'Collect one fresh status observation.',
    privacyJson: privacyJson(),
  };
}

export function rebuildToolReliabilityRollups(
  now = new Date(),
): ToolReliabilityRollup[] {
  if (!isDatabaseInitialized()) return [];
  const updatedAt = nowIso(now);
  const subjects = listToolReliabilitySubjects({ limit: 500 });
  const rollups = subjects.map((subjectItem) => {
    const observations = listReliabilityObservations({
      subjectId: subjectItem.subjectId,
      limit: 30,
    });
    const rollup = buildRollup(subjectItem.subjectId, observations, updatedAt);
    upsertToolReliabilityRollup(rollup);
    return rollup;
  });
  rebuildRouteConfidenceRollups(updatedAt);
  return rollups;
}

function rebuildRouteConfidenceRollups(
  updatedAt: string,
): RouteConfidenceRollup[] {
  const reflections = listCognitiveReflectionSignals({ limit: 200 });
  const groups = new Map<string, typeof reflections>();
  for (const signal of reflections) {
    const key = `${signal.routeKey}|cross_channel`;
    groups.set(key, [...(groups.get(key) || []), signal]);
  }
  const rollups: RouteConfidenceRollup[] = [];
  for (const [key, signals] of groups.entries()) {
    const [routeKey, channel] = key.split('|') as [
      string,
      RouteConfidenceRollup['channel'],
    ];
    const attempts = signals.length;
    const success =
      signals.filter((signal) => signal.outcome === 'success').length /
      Math.max(1, attempts);
    const corrected =
      signals.filter((signal) => signal.userResponse === 'corrected').length /
      Math.max(1, attempts);
    const avg =
      signals.reduce((sum, signal) => sum + clamp(signal.routeConfidence), 0) /
      Math.max(1, attempts);
    const cap = clamp(success - corrected * 0.25 + 0.2, 0.2, 0.95);
    const rollup: RouteConfidenceRollup = {
      routeKey,
      channel,
      updatedAt,
      attempts,
      averagePredictedConfidence: avg,
      empiricalSuccessRate: success,
      calibrationGap: clamp(Math.abs(avg - success), 0, 1),
      correctionRate: corrected,
      recommendedConfidenceCap: cap,
      recommendedFallback: success < 0.5 ? 'clarify' : null,
      privacyJson: privacyJson(),
    };
    upsertRouteConfidenceRollup(rollup);
    rollups.push(rollup);
  }
  return rollups;
}

export async function refreshToolReliabilityFromCurrentTruth(
  params: {
    now?: Date;
    providers?: ProviderHealthSnapshot[];
    integrationReport?: IntegrationDoctorReport;
  } = {},
): Promise<ToolReliabilityDoctorReport> {
  if (!isDatabaseInitialized()) {
    return buildToolReliabilityDoctorReport();
  }
  seedToolReliabilityRegistry();
  const observedAt = nowIso(params.now);
  const providers =
    params.providers || collectProviderHealthSnapshots(observedAt);
  const integrationReport =
    params.integrationReport ||
    buildIntegrationDoctorReport({ now: params.now });
  for (const provider of providers) {
    upsertReliabilityObservation(
      observation({
        subjectId: `provider:${provider.providerId}`,
        observedAt,
        sourceKind: 'provider_health',
        outcome: providerOutcome(provider),
        failureClass: provider.failureClass,
        summary:
          provider.state === 'healthy'
            ? `${provider.providerId} provider is currently healthy.`
            : `${provider.providerId} provider is ${provider.state}: ${provider.failureClass}.`,
        nextAction: provider.nextAction,
        evidenceIds: [`provider:${provider.providerId}:${observedAt}`],
      }),
    );
  }
  for (const status of integrationReport.statuses) {
    upsertReliabilityObservation(
      observation({
        subjectId: `integration:${status.integrationId}`,
        observedAt,
        sourceKind: 'integration_doctor',
        outcome: integrationOutcome(status),
        failureClass: status.state,
        summary: `${status.label}: ${status.state}.`,
        nextAction: status.nextAction,
        evidenceIds: [`integration:${status.integrationId}:${observedAt}`],
      }),
    );
  }
  const reminderEvidence = summarizeReminderTaskEvidence(
    getAllTasks(),
    observedAt,
  );
  upsertReliabilityObservation(
    observation({
      subjectId: 'tool:reminders',
      observedAt: reminderEvidence.lastEvidenceAt || observedAt,
      sourceKind: 'message_action',
      outcome: reminderEvidence.hasEvidence ? 'success' : 'unknown',
      failureClass: reminderEvidence.hasEvidence
        ? 'none'
        : 'no_recent_reminder_task',
      summary: reminderEvidence.hasEvidence
        ? 'Internal reminder scheduler has active or recent reminder task evidence.'
        : 'No active or recent internal reminder task evidence is recorded.',
      nextAction: reminderEvidence.hasEvidence
        ? ''
        : 'Create or observe one reminder task for end-to-end proof.',
      evidenceIds: reminderEvidence.evidenceIds,
    }),
  );
  const choices = listCognitiveExecutiveToolChoices({ limit: 80 });
  for (const choice of choices) {
    upsertReliabilityObservation(
      observation({
        subjectId: `tool:${choice.toolId}`,
        observedAt: choice.createdAt,
        sourceKind: 'executive_reflection',
        outcome:
          choice.status === 'available'
            ? 'success'
            : choice.status === 'blocked'
              ? 'blocked'
              : choice.status === 'not_relevant'
                ? 'unknown'
                : 'degraded',
        failureClass: choice.status,
        fallbackUsed: Boolean(choice.fallbackToolId),
        summary: `Executive tool choice ${choice.toolId}: ${choice.status}.`,
        nextAction: choice.reason,
        evidenceIds: [choice.choiceId],
      }),
    );
  }
  rebuildToolReliabilityRollups(params.now);
  return buildToolReliabilityDoctorReport(params.now);
}

export function scoreRouteCandidate(params: {
  routeKey: string;
  channel?: CognitiveExecutiveChannel | 'operator' | 'cross_channel';
  baseConfidence: number;
}): {
  confidence: number;
  cap: number;
  reasons: string[];
  fallbackRoute?: string | null;
} {
  if (!isDatabaseInitialized()) {
    return {
      confidence: clamp(params.baseConfidence),
      cap: 1,
      reasons: ['Database is not initialized; using base confidence.'],
      fallbackRoute: null,
    };
  }
  const subjectId = params.routeKey.startsWith('route:')
    ? params.routeKey
    : `route:${params.routeKey}`;
  const links = listToolDependencyLinks({ subjectId, limit: 20 });
  const rollups = new Map(
    listToolReliabilityRollups({ limit: 500 }).map((rollup) => [
      rollup.subjectId,
      rollup,
    ]),
  );
  const routeRollup = listRouteConfidenceRollups({
    routeKey: params.routeKey.replace(/^route:/, ''),
    limit: 1,
  })[0];
  let cap = routeRollup?.recommendedConfidenceCap ?? 0.95;
  const reasons: string[] = [];
  for (const dep of links) {
    const rollup = rollups.get(dep.dependencySubjectId);
    if (!rollup) continue;
    cap = Math.min(cap, rollup.confidenceCap);
    if (rollup.currentHealth !== 'healthy') {
      reasons.push(
        `${dep.dependencySubjectId} is ${rollup.currentHealth}: ${rollup.nextAction}`,
      );
    }
  }
  if (routeRollup?.recommendedFallback) {
    reasons.push(
      `Route history recommends fallback ${routeRollup.recommendedFallback}.`,
    );
  }
  return {
    confidence: clamp(Math.min(params.baseConfidence, cap)),
    cap,
    reasons,
    fallbackRoute: routeRollup?.recommendedFallback || null,
  };
}

export function buildToolReliabilityDoctorReport(
  now = new Date(),
): ToolReliabilityDoctorReport {
  const generatedAt = nowIso(now);
  if (!isDatabaseInitialized()) {
    return {
      generatedAt,
      subjects: [],
      rollups: [],
      routeRollups: [],
      topDegraded: [],
      nextAction: 'Initialize the database before reading tool reliability.',
      privacy: PRIVACY,
    };
  }
  seedToolReliabilityRegistry();
  const subjects = listToolReliabilitySubjects({ limit: 500 });
  const storedRollups = listToolReliabilityRollups({ limit: 500 });
  const rollupBySubject = new Map(
    storedRollups.map((rollup) => [rollup.subjectId, rollup]),
  );
  const tasks = getAllTasks();
  const rollups = storedRollups.map((rollup) => ({
    ...rollup,
    currentHealth: effectiveDoctorRollupHealth(rollup, rollupBySubject, tasks),
  }));
  const routeRollups = listRouteConfidenceRollups({ limit: 100 });
  const topDegraded = rollups
    .filter((rollup) => rollup.currentHealth !== 'healthy')
    .sort(
      (a, b) =>
        degradedSubjectRank(a.subjectId) - degradedSubjectRank(b.subjectId),
    )
    .slice(0, 8);
  return {
    generatedAt,
    subjects,
    rollups,
    routeRollups,
    topDegraded,
    nextAction:
      topDegraded[0]?.nextAction ||
      'Run one executive turn and one integrations status refresh to improve route calibration.',
    privacy: PRIVACY,
  };
}

function degradedSubjectRank(subjectId: string): number {
  if (subjectId === 'integration:alexa') return 80;
  if (subjectId === 'tool:work_cockpit') return 60;
  if (subjectId.startsWith('provider:')) return 20;
  if (subjectId.startsWith('integration:')) return 10;
  if (subjectId.startsWith('tool:')) return 5;
  return 30;
}

function dependencyRollupHealth(
  subjectId: string,
  rollups: Map<string, ToolReliabilityRollup>,
): ToolReliabilityRollup['currentHealth'] | null {
  return rollups.get(subjectId)?.currentHealth ?? null;
}

function effectiveDoctorRollupHealth(
  rollup: ToolReliabilityRollup,
  rollups: Map<string, ToolReliabilityRollup>,
  tasks: ScheduledTask[],
): ToolReliabilityRollup['currentHealth'] {
  switch (rollup.subjectId) {
    case 'tool:calendar':
    case 'route:cognitive_executive.daily_companion':
      return (
        dependencyRollupHealth('integration:google_calendar', rollups) ??
        rollup.currentHealth
      );
    case 'tool:research':
    case 'route:cognitive_executive.research':
      return (
        dependencyRollupHealth('provider:brave_search', rollups) ??
        rollup.currentHealth
      );
    case 'tool:message_actions': {
      const bluebubbles = dependencyRollupHealth(
        'integration:bluebubbles',
        rollups,
      );
      return bluebubbles ?? rollup.currentHealth;
    }
    case 'tool:reminders':
      if (summarizeReminderTaskEvidence(tasks, rollup.updatedAt).hasEvidence) {
        return 'healthy';
      }
      return rollup.currentHealth;
    case 'route:cognitive_executive.communication_companion':
      return (
        dependencyRollupHealth('integration:bluebubbles', rollups) ??
        rollup.currentHealth
      );
    case 'route:cognitive_executive.everyday_capture':
      return (
        dependencyRollupHealth('integration:telegram', rollups) ??
        rollup.currentHealth
      );
    default:
      return rollup.currentHealth;
  }
}

export function formatToolReliabilityReport(
  report: ToolReliabilityDoctorReport,
): string {
  const lines = [
    '*Tool Reliability*',
    `Subjects: ${report.subjects.length}`,
    `Rollups: ${report.rollups.length}`,
  ];
  if (report.topDegraded.length) {
    lines.push('*Top degraded or blocked*');
    for (const rollup of report.topDegraded.slice(0, 6)) {
      lines.push(
        `- ${rollup.subjectId}: ${rollup.currentHealth} score=${rollup.reliabilityScore.toFixed(2)} cap=${rollup.confidenceCap.toFixed(2)} next=${rollup.nextAction || 'collect proof'}`,
      );
    }
  } else {
    lines.push('- no degraded subjects recorded yet');
  }
  lines.push(`Next: ${report.nextAction}`);
  lines.push(
    'Privacy: metadata-only; no raw prompts, private bodies, hidden reasoning, raw tool output, or secrets are stored.',
  );
  return lines.join('\n');
}
