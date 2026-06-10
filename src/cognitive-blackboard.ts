import crypto from 'crypto';

import {
  isDatabaseInitialized,
  listActionIntents,
  listCognitiveEpisodes,
  listHierarchicalGoals,
  listGoalPlanSteps,
  listRealitySnapshots,
  listRealityVerificationNeeds,
  listStrategyLearningSignals,
  listToolReliabilityRollups,
  listWorkingMemoryFrames,
  listBlackboardSnapshots,
  upsertBlackboardSnapshot,
} from './db.js';
import type { BlackboardSnapshotRecord, ControlPlaneChannel } from './types.js';

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

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export interface BuildBlackboardInput {
  requestText?: string;
  channel?: ControlPlaneChannel;
  now?: string;
  persist?: boolean;
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
  const reality = snapshots[0] ?? null;
  const openNeeds = dbReady
    ? listRealityVerificationNeeds({ status: 'open', limit: 50 }).length +
      listRealityVerificationNeeds({ status: 'manual_proof', limit: 50 }).length
    : 0;
  const realitySummary = reality
    ? `${reality.status}: ${reality.trueNowSummary}`.slice(0, 400)
    : 'No reality snapshot recorded yet.';

  const rollups = dbReady ? listToolReliabilityRollups({ limit: 100 }) : [];
  const unhealthy = rollups.filter(
    (rollup) =>
      rollup.currentHealth === 'blocked' || rollup.currentHealth === 'degraded',
  );
  const toolReliabilitySummary = unhealthy.length
    ? `${unhealthy.length} subject(s) unhealthy: ${unhealthy
        .slice(0, 3)
        .map((rollup) => `${rollup.subjectId} (${rollup.currentHealth})`)
        .join(', ')}`
    : `${rollups.length} reliability subjects tracked, none blocked or degraded.`;

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
  const failedEpisodes = episodes.filter(
    (episode) => episode.result === 'failed',
  );
  const outcomeSignalSummary = episodes.length
    ? `${episodes.length} recent episodes, ${failedEpisodes.length} failed.`
    : 'No episodes recorded yet.';

  const signals = dbReady ? listStrategyLearningSignals({ limit: 5 }) : [];
  const improvementSignalSummary = signals.length
    ? `${signals.length} strategy signal(s); latest: ${signals[0].strategyAdjustment}`.slice(
        0,
        400,
      )
    : 'No strategy learning signals yet.';

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
  } else if (openNeeds > 0) {
    recommendedNextStep = `Close the freshest verification need (${openNeeds} open).`;
  } else if (unhealthy.length) {
    recommendedNextStep = `Check ${unhealthy[0].subjectId} (${unhealthy[0].currentHealth}).`;
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
    activeGoalSummary: activeGoal ? activeGoal.title : null,
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
    `Active goal: ${record.activeGoalSummary ?? 'none'}`,
    `Active plan step: ${record.activePlanStepSummary ?? 'none'}`,
    `Working memory focus: ${record.workingMemoryFocus ?? 'none'}`,
    `Reality: ${record.realitySummary}`,
    `Open proof/verification needs: ${record.proofDebtOpen}`,
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
  return /\b(what are you doing right now|what matters (most )?right now|what('?| i)s on your (plate|mind)|current state|situational awareness|what should (we|i) do next)\b/i.test(
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
    lines.push(`${record.proofDebtOpen} verification need(s) are open.`);
  }
  lines.push(`Recommended next step: ${record.recommendedNextStep}`);
  return lines.join('\n');
}
