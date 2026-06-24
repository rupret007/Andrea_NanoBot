import crypto from 'crypto';

import {
  getAllTasks,
  isDatabaseInitialized,
  listActionReviews,
  listActionIntents,
  listCognitiveEpisodes,
  listHierarchicalGoals,
  listGoalPlanSteps,
  listRealitySnapshots,
  listRealityVerificationNeeds,
  listRecentResponseFeedback,
  listStrategyLearningSignals,
  listToolReliabilityRollups,
  listWorkingMemoryFrames,
  listBlackboardSnapshots,
  upsertBlackboardSnapshot,
} from './db.js';
import {
  collectProviderHealthSnapshots,
  type ProviderHealthSnapshot,
} from './provider-health.js';
import {
  buildIntegrationDoctorReport,
  type IntegrationDoctorReport,
  type IntegrationStatus,
} from './integration-doctor.js';
import { buildRealityGroundingReport } from './reality-grounding.js';
import type {
  BlackboardSnapshotRecord,
  ControlPlaneChannel,
  RealitySnapshot,
  RealityVerificationNeed,
  ScheduledTask,
  ToolReliabilityRollup,
} from './types.js';

// ---------------------------------------------------------------------------
// v32 Cognitive Blackboard
//
// A bounded, metadata-first shared state summary. Subsystems do not write
// freely here; the blackboard is assembled on demand from their own ledgers,
// so it can never drift from the systems of record. No raw private content,
// no hidden chain-of-thought — structured summaries only.
// ---------------------------------------------------------------------------

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function isRealitySnapshotStale(
  snapshot: RealitySnapshot,
  now: string,
): boolean {
  const createdMs = Date.parse(snapshot.updatedAt || snapshot.createdAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(createdMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - createdMs > 2 * 60 * 1000;
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export interface BuildBlackboardInput {
  requestText?: string;
  channel?: ControlPlaneChannel;
  now?: string;
  persist?: boolean;
  providerHealthSnapshots?: ProviderHealthSnapshot[];
  integrationReport?: IntegrationDoctorReport;
}

function providerHealthAsRollupHealth(
  provider: ProviderHealthSnapshot,
): ToolReliabilityRollup['currentHealth'] {
  if (provider.state === 'healthy') return 'healthy';
  if (provider.state === 'degraded') return 'degraded';
  if (
    provider.state === 'externally_blocked' ||
    provider.state === 'not_configured'
  ) {
    return 'blocked';
  }
  return 'unknown';
}

function effectiveRollupHealth(
  rollup: ToolReliabilityRollup,
  providers: ProviderHealthSnapshot[],
  integrations: IntegrationStatus[],
  tasks: ScheduledTask[],
): ToolReliabilityRollup['currentHealth'] {
  if (rollup.subjectId.startsWith('integration:')) {
    const integrationId = rollup.subjectId.replace(/^integration:/, '');
    const integration = integrations.find(
      (item) => item.integrationId === integrationId,
    );
    if (!integration) return rollup.currentHealth;
    if (integration.state === 'healthy') return 'healthy';
    if (
      integration.state === 'externally_blocked' ||
      integration.state === 'needs_auth' ||
      integration.state === 'manual_action_required'
    ) {
      return 'blocked';
    }
    if (
      integration.state === 'degraded_but_usable' ||
      integration.state === 'near_live_only' ||
      integration.state === 'needs_proof' ||
      integration.state === 'repo_fix_available'
    ) {
      return 'degraded';
    }
    return rollup.currentHealth;
  }
  if (rollup.subjectId.startsWith('tool:')) {
    return effectiveToolHealth(rollup, providers, integrations, tasks);
  }
  if (rollup.subjectId.startsWith('route:')) {
    return effectiveRouteHealth(rollup, providers, integrations);
  }
  if (!rollup.subjectId.startsWith('provider:')) return rollup.currentHealth;
  const providerId = rollup.subjectId.replace(/^provider:/, '');
  const provider = providers.find((item) => item.providerId === providerId);
  return provider
    ? providerHealthAsRollupHealth(provider)
    : rollup.currentHealth;
}

function integrationHealth(
  integrationId: string,
  integrations: IntegrationStatus[],
): ToolReliabilityRollup['currentHealth'] | null {
  const integration = integrations.find(
    (item) => item.integrationId === integrationId,
  );
  if (!integration) return null;
  if (integration.state === 'healthy') return 'healthy';
  if (
    integration.state === 'externally_blocked' ||
    integration.state === 'needs_auth' ||
    integration.state === 'manual_action_required'
  ) {
    return 'blocked';
  }
  if (
    integration.state === 'degraded_but_usable' ||
    integration.state === 'near_live_only' ||
    integration.state === 'needs_proof' ||
    integration.state === 'repo_fix_available'
  ) {
    return 'degraded';
  }
  return null;
}

function providerHealth(
  providerId: string,
  providers: ProviderHealthSnapshot[],
): ToolReliabilityRollup['currentHealth'] | null {
  const provider = providers.find((item) => item.providerId === providerId);
  return provider ? providerHealthAsRollupHealth(provider) : null;
}

function hasReminderTaskEvidence(tasks: ScheduledTask[]): boolean {
  return tasks.some(
    (task) => task.status === 'active' && /\breminder\b/i.test(task.prompt),
  );
}

function effectiveToolHealth(
  rollup: ToolReliabilityRollup,
  providers: ProviderHealthSnapshot[],
  integrations: IntegrationStatus[],
  tasks: ScheduledTask[],
): ToolReliabilityRollup['currentHealth'] {
  if (rollup.subjectId === 'tool:calendar') {
    return (
      integrationHealth('google_calendar', integrations) ?? rollup.currentHealth
    );
  }
  if (rollup.subjectId === 'tool:research') {
    return providerHealth('brave_search', providers) ?? rollup.currentHealth;
  }
  if (rollup.subjectId === 'tool:message_actions') {
    const bluebubbles = integrationHealth('bluebubbles', integrations);
    if (bluebubbles === 'healthy' || hasReminderTaskEvidence(tasks)) {
      return 'healthy';
    }
    return bluebubbles ?? rollup.currentHealth;
  }
  return rollup.currentHealth;
}

function effectiveRouteHealth(
  rollup: ToolReliabilityRollup,
  providers: ProviderHealthSnapshot[],
  integrations: IntegrationStatus[],
): ToolReliabilityRollup['currentHealth'] {
  if (rollup.subjectId === 'route:cognitive_executive.daily_companion') {
    return (
      integrationHealth('google_calendar', integrations) ?? rollup.currentHealth
    );
  }
  if (
    rollup.subjectId === 'route:cognitive_executive.communication_companion'
  ) {
    return (
      integrationHealth('bluebubbles', integrations) ?? rollup.currentHealth
    );
  }
  if (rollup.subjectId === 'route:cognitive_executive.everyday_capture') {
    return integrationHealth('telegram', integrations) ?? rollup.currentHealth;
  }
  if (rollup.subjectId === 'route:cognitive_executive.research') {
    return providerHealth('brave_search', providers) ?? rollup.currentHealth;
  }
  return rollup.currentHealth;
}

function uniqueNeeds(
  needs: RealityVerificationNeed[],
): RealityVerificationNeed[] {
  const byId = new Map<string, RealityVerificationNeed>();
  for (const need of needs) byId.set(need.needId, need);
  return Array.from(byId.values());
}

function summarizeVerificationNeeds(needs: RealityVerificationNeed[]): {
  total: number;
  summary: string;
  nextAction: string | null;
} {
  if (!needs.length) {
    return { total: 0, summary: 'none', nextAction: null };
  }
  const manual = needs.filter((need) => need.status === 'manual_proof').length;
  const approval = needs.filter(
    (need) => need.status === 'approval_required',
  ).length;
  const readOnly = needs.filter(
    (need) => need.status === 'runnable_read_only',
  ).length;
  const open = needs.filter((need) => need.status === 'open').length;
  const highUrgency = needs.filter(
    (need) =>
      need.urgency === 'high' ||
      need.riskIfSkipped === 'high' ||
      need.riskIfSkipped === 'critical',
  ).length;
  const parts = [
    manual ? `manual=${manual}` : '',
    approval ? `approval=${approval}` : '',
    readOnly ? `read_only=${readOnly}` : '',
    open ? `open=${open}` : '',
    highUrgency ? `high_urgency=${highUrgency}` : '',
  ].filter(Boolean);
  const next =
    needs.find((need) => need.status === 'manual_proof') ||
    needs.find((need) => need.status === 'approval_required') ||
    needs.find((need) => need.urgency === 'high') ||
    needs.find((need) => need.status === 'runnable_read_only') ||
    needs[0];
  return {
    total: needs.length,
    summary: parts.join(', ') || `${needs.length} open`,
    nextAction: next?.nextAction || null,
  };
}

function summarizeToolReliability(rollups: ToolReliabilityRollup[]): {
  summary: string;
  unhealthy: ToolReliabilityRollup[];
  stale: ToolReliabilityRollup[];
  optionalManual: ToolReliabilityRollup[];
} {
  const optionalManual = rollups.filter((rollup) =>
    isOptionalManualReliabilitySubject(rollup.subjectId),
  );
  const coreRollups = rollups.filter(
    (rollup) => !isOptionalManualReliabilitySubject(rollup.subjectId),
  );
  const unhealthy = coreRollups.filter(
    (rollup) =>
      rollup.currentHealth === 'blocked' || rollup.currentHealth === 'degraded',
  );
  const stale = coreRollups.filter(
    (rollup) =>
      rollup.currentHealth !== 'healthy' &&
      (rollup.currentHealth === 'unknown' ||
        rollup.sampleCount === 0 ||
        rollup.reliabilityScore < 0.5),
  );
  const optionalNeedsAttention = optionalManual.filter(
    (rollup) =>
      rollup.currentHealth !== 'healthy' ||
      rollup.sampleCount === 0 ||
      rollup.reliabilityScore < 0.5,
  );
  const parts: string[] = [];
  if (unhealthy.length) {
    parts.push(
      `${unhealthy.length} unhealthy: ${unhealthy
        .slice(0, 3)
        .map((rollup) => `${rollup.subjectId} (${rollup.currentHealth})`)
        .join(', ')}`,
    );
  }
  if (stale.length) {
    parts.push(
      `${stale.length} stale/unknown: ${stale
        .slice(0, 3)
        .map((rollup) => rollup.subjectId)
        .join(', ')}`,
    );
  }
  if (optionalNeedsAttention.length) {
    parts.push(
      `${optionalNeedsAttention.length} optional/manual: ${optionalNeedsAttention
        .slice(0, 3)
        .map((rollup) => `${rollup.subjectId} (${rollup.currentHealth})`)
        .join(', ')}`,
    );
  }
  return {
    summary:
      parts.join('; ') ||
      `${rollups.length} reliability subjects tracked, none blocked, degraded, or stale.`,
    unhealthy,
    stale,
    optionalManual,
  };
}

function isOptionalManualReliabilitySubject(subjectId: string): boolean {
  return subjectId === 'integration:alexa';
}

function summarizeChanges(
  previous: BlackboardSnapshotRecord | null,
  current: {
    proofDebtOpen: number;
    toolReliabilitySummary: string;
    activeGoalSummary: string | null;
    approvalNeedsCount: number;
  },
): string {
  if (!previous) return 'first snapshot for this workspace run';
  const changes: string[] = [];
  if (previous.proofDebtOpen !== current.proofDebtOpen) {
    const direction =
      current.proofDebtOpen > previous.proofDebtOpen
        ? 'increased'
        : 'decreased';
    changes.push(
      `verification needs ${direction} ${previous.proofDebtOpen}->${current.proofDebtOpen}`,
    );
  }
  if (previous.approvalNeedsCount !== current.approvalNeedsCount) {
    changes.push(
      `approvals ${previous.approvalNeedsCount}->${current.approvalNeedsCount}`,
    );
  }
  if (
    (previous.activeGoalSummary || 'none') !==
    (current.activeGoalSummary || 'none')
  ) {
    changes.push(
      `objective ${(previous.activeGoalSummary || 'none').slice(0, 60)} -> ${(current.activeGoalSummary || 'none').slice(0, 60)}`,
    );
  }
  if (previous.toolReliabilitySummary !== current.toolReliabilitySummary) {
    changes.push('tool/reliability truth changed');
  }
  return changes.length ? changes.slice(0, 3).join('; ') : 'no major change';
}

function dailySnapshotLine(record: BlackboardSnapshotRecord): string {
  const objective =
    record.activePlanStepSummary ||
    record.activeGoalSummary ||
    record.workingMemoryFocus ||
    record.likelyIntent;
  return `objective=${objective}; approvals=${record.approvalNeedsCount}; verification=${record.proofDebtOpen}; tools=${record.toolReliabilitySummary}`;
}

export function buildCognitiveBlackboard(
  input: BuildBlackboardInput = {},
): BlackboardSnapshotRecord {
  const createdAt = nowIso(input.now);
  const dbReady = isDatabaseInitialized();
  const requestSummary = (input.requestText || 'ambient status')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  const goals = dbReady ? listHierarchicalGoals({ limit: 10 }) : [];
  const activeGoal = goals.find((goal) => goal.status === 'active') ?? null;
  const steps = dbReady ? listGoalPlanSteps({ limit: 30 }) : [];
  const activeStep = activeGoal
    ? (steps.find(
        (step) =>
          step.goalId === activeGoal.goalId &&
          (step.status === 'ready' || step.status === 'approval_required'),
      ) ?? null)
    : null;

  const intents = dbReady
    ? listActionIntents({
        statuses: [
          'proposed',
          'needs_approval',
          'needs_clarification',
          'approved',
          'scheduled',
        ],
        limit: 50,
      })
    : [];
  const approvalNeeds = intents.filter(
    (intent) => intent.status === 'needs_approval',
  );
  const activeAction =
    intents.find((intent) => intent.status === 'approved') ??
    approvalNeeds[0] ??
    intents[0] ??
    null;

  const frames = dbReady ? listWorkingMemoryFrames({ limit: 1 }) : [];
  const focus = frames[0]
    ? `${frames[0].currentAskSummary} (mode ${frames[0].recommendedReasoningMode})`
    : null;

  const snapshots = dbReady ? listRealitySnapshots({ limit: 1 }) : [];
  let reality = snapshots[0] ?? null;
  if (dbReady && reality && isRealitySnapshotStale(reality, createdAt)) {
    reality = buildRealityGroundingReport({
      generatedAt: createdAt,
      requestText: requestSummary,
      channel: input.channel || 'internal',
      persist: input.persist !== false,
    }).snapshot;
  }
  const verificationNeedParams = reality
    ? { snapshotId: reality.snapshotId }
    : {};
  const verificationNeeds = dbReady
    ? uniqueNeeds([
        ...listRealityVerificationNeeds({
          ...verificationNeedParams,
          status: 'manual_proof',
          limit: 60,
        }),
        ...listRealityVerificationNeeds({
          ...verificationNeedParams,
          status: 'approval_required',
          limit: 60,
        }),
        ...listRealityVerificationNeeds({
          ...verificationNeedParams,
          status: 'runnable_read_only',
          limit: 60,
        }),
        ...listRealityVerificationNeeds({
          ...verificationNeedParams,
          status: 'open',
          limit: 60,
        }),
      ])
    : [];
  const verificationSummary = summarizeVerificationNeeds(verificationNeeds);
  const openNeeds = verificationSummary.total;
  const realityBase = reality
    ? `${reality.status}: ${reality.trueNowSummary}`
    : 'No reality snapshot recorded yet.';
  const realitySummary =
    `${realityBase} Verification: ${verificationSummary.summary}.`.slice(
      0,
      460,
    );

  const rollups = dbReady ? listToolReliabilityRollups({ limit: 100 }) : [];
  const providerHealth =
    input.providerHealthSnapshots ?? collectProviderHealthSnapshots(createdAt);
  const integrationReport =
    input.integrationReport ||
    buildIntegrationDoctorReport({ now: new Date(createdAt) });
  const tasks = dbReady ? getAllTasks() : [];
  const effectiveRollups = rollups.map((rollup) => ({
    ...rollup,
    currentHealth: effectiveRollupHealth(
      rollup,
      providerHealth,
      integrationReport.statuses,
      tasks,
    ),
  }));
  const toolReliability = summarizeToolReliability(effectiveRollups);
  const toolReliabilitySummary = toolReliability.summary;

  const corrections = dbReady
    ? listCognitiveEpisodes({ withCorrectionsOnly: true, limit: 3 })
    : [];
  const recentCorrectionsSummary = corrections.length
    ? corrections
        .map((episode) => episode.userCorrection ?? '')
        .filter(Boolean)
        .join('; ')
        .slice(0, 400)
    : 'No recent user corrections.';

  const episodes = dbReady ? listCognitiveEpisodes({ limit: 10 }) : [];
  const reviews = dbReady ? listActionReviews({ limit: 10 }) : [];
  const feedback = dbReady ? listRecentResponseFeedback({ limit: 10 }) : [];
  const failedEpisodes = episodes.filter(
    (episode) => episode.result === 'failed',
  );
  const unresolvedFeedback = feedback.filter(
    (item) => item.status !== 'landed',
  );
  const completedReviews = reviews.filter(
    (review) => review.outcome === 'completed',
  ).length;
  const blockedReviews = reviews.filter((review) =>
    ['failed', 'deferred', 'partial', 'unknown'].includes(review.outcome),
  ).length;
  const outcomeSignalSummary =
    episodes.length || reviews.length || unresolvedFeedback.length
      ? `${episodes.length} recent episodes (${failedEpisodes.length} failed); ${reviews.length} action review(s) (${completedReviews} completed, ${blockedReviews} unresolved); ${unresolvedFeedback.length} feedback item(s) still open.`
      : 'No episodes, action reviews, or response feedback recorded yet.';

  const signals = dbReady ? listStrategyLearningSignals({ limit: 5 }) : [];
  const previousSnapshot = dbReady
    ? (listBlackboardSnapshots({ limit: 1 })[0] ?? null)
    : null;
  const activeGoalSummary = activeGoal ? activeGoal.title : null;
  const changeSummary = summarizeChanges(previousSnapshot, {
    proofDebtOpen: openNeeds,
    toolReliabilitySummary,
    activeGoalSummary,
    approvalNeedsCount: approvalNeeds.length,
  });
  const improvementSignalSummary = `${
    signals.length
      ? `${signals.length} strategy signal(s); latest: ${signals[0].strategyAdjustment}`.slice(
          0,
          400,
        )
      : 'No strategy learning signals yet.'
  } Since last run: ${changeSummary}.`;

  const likelyIntent =
    requestSummary === 'ambient status'
      ? 'maintain situational awareness'
      : /\b(send|text|message)\b/i.test(requestSummary)
        ? 'communication action'
        : /\b(calendar|schedule|event)\b/i.test(requestSummary)
          ? 'calendar action'
          : /\b(plan|ready|prepare|weekend)\b/i.test(requestSummary)
            ? 'planning'
            : /\b(status|what|how|why)\b/i.test(requestSummary)
              ? 'status inquiry'
              : 'general assistance';

  // Single recommended next step — strictest need first, exactly one.
  let recommendedNextStep: string;
  if (approvalNeeds.length) {
    recommendedNextStep = `Review and approve or dismiss: ${approvalNeeds[0].title}`;
  } else if (verificationSummary.nextAction) {
    recommendedNextStep = verificationSummary.nextAction;
  } else if (toolReliability.unhealthy.length) {
    recommendedNextStep = `Check ${toolReliability.unhealthy[0].subjectId} (${toolReliability.unhealthy[0].currentHealth}).`;
  } else if (openNeeds > 0) {
    recommendedNextStep = `Close the freshest verification need (${openNeeds} open).`;
  } else if (activeStep) {
    recommendedNextStep = `Next plan step: ${activeStep.actionSummary}`;
  } else if (activeGoal) {
    recommendedNextStep =
      activeGoal.nextAction || `Advance goal: ${activeGoal.title}`;
  } else {
    recommendedNextStep = 'Nothing urgent. No action needed right now.';
  }

  const record: BlackboardSnapshotRecord = {
    snapshotId: hashId('blackboard', `${requestSummary}|${createdAt}`),
    createdAt,
    currentRequestSummary: requestSummary,
    activeGoalSummary,
    activePlanStepSummary: activeStep ? activeStep.actionSummary : null,
    activeActionId: activeAction ? activeAction.actionId : null,
    workingMemoryFocus: focus,
    realitySummary,
    proofDebtOpen: openNeeds,
    toolReliabilitySummary,
    approvalNeedsCount: approvalNeeds.length,
    likelyIntent,
    recentCorrectionsSummary,
    outcomeSignalSummary,
    improvementSignalSummary,
    recommendedNextStep,
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && dbReady) {
    upsertBlackboardSnapshot(record);
  }
  return record;
}

export function formatBlackboardReport(
  record: BlackboardSnapshotRecord = buildCognitiveBlackboard({
    persist: false,
  }),
  options: { channel?: ControlPlaneChannel } = {},
): string {
  if (options.channel === 'alexa') {
    return `${record.recommendedNextStep} ${record.approvalNeedsCount ? `${record.approvalNeedsCount} item(s) are waiting on you.` : ''}`.trim();
  }
  return [
    '*Cognitive Blackboard*',
    `Request: ${record.currentRequestSummary}`,
    `Likely intent: ${record.likelyIntent}`,
    `Daily snapshot: ${dailySnapshotLine(record)}`,
    `Active goal: ${record.activeGoalSummary ?? 'none'}`,
    `Active plan step: ${record.activePlanStepSummary ?? 'none'}`,
    `Working memory focus: ${record.workingMemoryFocus ?? 'none'}`,
    `Reality: ${record.realitySummary}`,
    `Verification needs: ${record.proofDebtOpen}`,
    `Tools: ${record.toolReliabilitySummary}`,
    `Waiting on approval: ${record.approvalNeedsCount}`,
    `Recent corrections: ${record.recentCorrectionsSummary}`,
    `Outcomes: ${record.outcomeSignalSummary}`,
    `Improvement: ${record.improvementSignalSummary}`,
    `Recommended next step: ${record.recommendedNextStep}`,
  ].join('\n');
}

export function getLatestBlackboardSnapshot(): BlackboardSnapshotRecord | null {
  if (!isDatabaseInitialized()) return null;
  const snapshots = listBlackboardSnapshots({ limit: 1 });
  return snapshots[0] ?? null;
}

export function isBlackboardNaturalRequest(text: string): boolean {
  return /\b(what are you doing right now|what matters (most )?right now|what('?| i)s on your (plate|mind)|current state|situational awareness|show (me )?(the )?(blackboard|current state)|blackboard status)\b/i.test(
    text || '',
  );
}

export function formatBlackboardNaturalResponse(
  text: string,
  options: { channel?: ControlPlaneChannel } = {},
): string {
  const record = buildCognitiveBlackboard({ requestText: text });
  if (options.channel === 'alexa') {
    return formatBlackboardReport(record, options);
  }
  const lines: string[] = [];
  lines.push(`Right now: ${record.likelyIntent}.`);
  if (record.activeGoalSummary) {
    lines.push(`Active goal: ${record.activeGoalSummary}.`);
  }
  if (record.approvalNeedsCount) {
    lines.push(
      `${record.approvalNeedsCount} action(s) are waiting on your approval.`,
    );
  }
  if (record.proofDebtOpen) {
    lines.push(
      `${record.proofDebtOpen} verification need(s) are grouped on the blackboard.`,
    );
  }
  lines.push(`Daily snapshot: ${dailySnapshotLine(record)}`);
  lines.push(`Recommended next step: ${record.recommendedNextStep}`);
  return lines.join('\n');
}
