import crypto from 'crypto';

import {
  getActionIntent,
  getActionIntentBySource,
  isDatabaseInitialized,
  listActionAttempts,
  listActionIntents,
  listActionReviews,
  listActionBundlesForGroup,
  listGoalPlanSteps,
  listHierarchicalGoals,
  listMessageActionsForGroup,
  upsertActionAttempt,
  upsertActionIntent,
  upsertActionReview,
} from './db.js';
import {
  approvalRequirementForLevel,
  classifyOperationAutonomy,
} from './autonomy-governor.js';
import type {
  ActionAttemptRecord,
  ActionIntentRecord,
  ActionIntentStatus,
  ActionIntentType,
  ActionReviewRecord,
  ControlPlaneChannel,
} from './types.js';

// ---------------------------------------------------------------------------
// v32 Unified Action Lifecycle
//
// First-class action intents that connect goals, plans, message actions,
// calendar drafts, reminders, repairs, patch work, and outcome reviews into
// one inspectable lifecycle. This orchestrates existing systems — it never
// replaces their own approval gates, and never executes anything itself.
// ---------------------------------------------------------------------------

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

const LEGAL_TRANSITIONS: Record<ActionIntentStatus, ActionIntentStatus[]> = {
  proposed: [
    'needs_clarification',
    'needs_verification',
    'needs_approval',
    'approved',
    'deferred',
    'cancelled',
  ],
  needs_clarification: ['proposed', 'needs_approval', 'cancelled', 'deferred'],
  needs_verification: [
    'proposed',
    'needs_approval',
    'approved',
    'cancelled',
    'deferred',
  ],
  needs_approval: ['approved', 'cancelled', 'deferred'],
  approved: ['scheduled', 'attempted', 'cancelled', 'deferred'],
  scheduled: ['attempted', 'cancelled', 'deferred'],
  attempted: ['succeeded', 'failed', 'deferred'],
  succeeded: ['archived'],
  failed: ['repaired', 'deferred', 'cancelled', 'archived'],
  repaired: ['attempted', 'succeeded', 'archived'],
  deferred: ['proposed', 'needs_approval', 'cancelled', 'archived'],
  cancelled: ['archived'],
  archived: [],
};

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

export interface CreateActionIntentInput {
  title: string;
  sourceRequestSummary: string;
  sourceChannel: ControlPlaneChannel;
  actionType: ActionIntentType;
  sourceSystem?: ActionIntentRecord['sourceSystem'];
  sourceKey?: string;
  relatedGoalId?: string | null;
  relatedPlanStepId?: string | null;
  relatedThreadId?: string | null;
  relatedCalendarEventId?: string | null;
  relatedSkillId?: string | null;
  relatedProofNeedId?: string | null;
  initialStatus?: ActionIntentStatus;
  statusReason?: string;
  now?: string;
  persist?: boolean;
}

export function createActionIntent(
  input: CreateActionIntentInput,
): ActionIntentRecord {
  const createdAt = nowIso(input.now);
  const autonomy = classifyOperationAutonomy({
    operationSummary: `${input.title} ${input.sourceRequestSummary}`,
    actionType: input.actionType,
    channel: input.sourceChannel,
  });
  const riskLevel =
    autonomy.level >= 6
      ? 'critical'
      : autonomy.level >= 5
        ? 'high'
        : autonomy.level >= 3
          ? 'medium'
          : 'low';
  const approvalRequirement = approvalRequirementForLevel(autonomy.level);
  let status: ActionIntentStatus = input.initialStatus ?? 'proposed';
  let statusReason =
    input.statusReason ??
    `Created via ${input.sourceSystem ?? 'control_plane'}.`;
  if (!autonomy.allowed) {
    status = 'cancelled';
    statusReason =
      'Autonomy governor classified this operation as never allowed.';
  } else if (
    approvalRequirement !== 'none' &&
    (status === 'proposed' || status === 'approved')
  ) {
    // Approval-gated intents can never be born approved.
    status = 'needs_approval';
    statusReason = `Autonomy level ${autonomy.level} requires ${approvalRequirement}.`;
  }
  const sourceSystem = input.sourceSystem ?? 'control_plane';
  const sourceKey =
    input.sourceKey ?? hashId('src', `${input.title}|${createdAt}`);
  const record: ActionIntentRecord = {
    actionId: hashId('action', `${sourceSystem}|${sourceKey}`),
    createdAt,
    updatedAt: createdAt,
    title: input.title.slice(0, 240),
    sourceRequestSummary: input.sourceRequestSummary.slice(0, 320),
    sourceChannel: input.sourceChannel,
    relatedGoalId: input.relatedGoalId ?? null,
    relatedPlanStepId: input.relatedPlanStepId ?? null,
    relatedThreadId: input.relatedThreadId ?? null,
    relatedCalendarEventId: input.relatedCalendarEventId ?? null,
    relatedSkillId: input.relatedSkillId ?? null,
    relatedProofNeedId: input.relatedProofNeedId ?? null,
    actionType: input.actionType,
    riskLevel,
    autonomyLevel: autonomy.level,
    approvalRequirement,
    status,
    statusReason,
    sourceSystem,
    sourceKey,
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertActionIntent(record);
  }
  return record;
}

export interface TransitionActionIntentInput {
  actionId: string;
  to: ActionIntentStatus;
  reason: string;
  hasExplicitUserApproval?: boolean;
  now?: string;
  persist?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  record: ActionIntentRecord | null;
  error?: string;
}

export function transitionActionIntent(
  input: TransitionActionIntentInput,
): TransitionResult {
  const existing = getActionIntent(input.actionId);
  if (!existing) {
    return { ok: false, record: null, error: 'action_not_found' };
  }
  const legal = LEGAL_TRANSITIONS[existing.status] ?? [];
  if (!legal.includes(input.to)) {
    return {
      ok: false,
      record: existing,
      error: `illegal_transition:${existing.status}->${input.to}`,
    };
  }
  if (
    input.to === 'approved' &&
    existing.approvalRequirement !== 'none' &&
    !input.hasExplicitUserApproval
  ) {
    return {
      ok: false,
      record: existing,
      error: 'approval_required_but_not_provided',
    };
  }
  const updated: ActionIntentRecord = {
    ...existing,
    status: input.to,
    statusReason: input.reason.slice(0, 400),
    updatedAt: nowIso(input.now),
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertActionIntent(updated);
  }
  return { ok: true, record: updated };
}

export interface RecordActionAttemptInput {
  actionId: string;
  toolUsed: string;
  preflightId?: string | null;
  preflightVerdict: string;
  result: ActionAttemptRecord['result'];
  failureReason?: string | null;
  repairSuggestion?: string | null;
  evidenceRefs?: string[];
  now?: string;
  persist?: boolean;
}

export function recordActionAttempt(
  input: RecordActionAttemptInput,
): ActionAttemptRecord {
  const attemptedAt = nowIso(input.now);
  const record: ActionAttemptRecord = {
    attemptId: hashId('attempt', `${input.actionId}|${attemptedAt}`),
    actionId: input.actionId,
    attemptedAt,
    toolUsed: input.toolUsed,
    preflightId: input.preflightId ?? null,
    preflightVerdict: input.preflightVerdict,
    result: input.result,
    failureReason: input.failureReason ?? null,
    repairSuggestion: input.repairSuggestion ?? null,
    evidenceRefsJson: JSON.stringify(input.evidenceRefs ?? []),
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertActionAttempt(record);
  }
  return record;
}

export interface RecordActionReviewInput {
  actionId: string;
  outcome: ActionReviewRecord['outcome'];
  userSatisfaction?: ActionReviewRecord['userSatisfaction'];
  whatChanged: string;
  lessons: string;
  followUpActionId?: string | null;
  now?: string;
  persist?: boolean;
}

export function recordActionReview(
  input: RecordActionReviewInput,
): ActionReviewRecord {
  const createdAt = nowIso(input.now);
  const record: ActionReviewRecord = {
    actionReviewId: hashId('areview', `${input.actionId}|${createdAt}`),
    actionId: input.actionId,
    createdAt,
    outcome: input.outcome,
    userSatisfaction: input.userSatisfaction ?? 'unknown',
    whatChanged: input.whatChanged.slice(0, 400),
    lessons: input.lessons.slice(0, 600),
    followUpActionId: input.followUpActionId ?? null,
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertActionReview(record);
  }
  return record;
}

// --- Orchestration: mirror existing systems into the unified lifecycle ----

const MESSAGE_STATUS_MAP: Record<string, ActionIntentStatus> = {
  drafted: 'needs_approval',
  approved: 'approved',
  sent: 'succeeded',
  deferred: 'deferred',
  failed: 'failed',
  skipped: 'cancelled',
};

const PLAN_STEP_STATUS_MAP: Record<string, ActionIntentStatus> = {
  proposed: 'proposed',
  ready: 'proposed',
  blocked: 'needs_verification',
  approval_required: 'needs_approval',
  done: 'succeeded',
  skipped: 'cancelled',
};

const BUNDLE_ACTION_STATUS_MAP: Record<string, ActionIntentStatus> = {
  proposed: 'proposed',
  approved: 'approved',
  executed: 'succeeded',
  skipped: 'cancelled',
  failed: 'failed',
  deferred: 'deferred',
};

export interface SyncActionIntentsResult {
  synced: number;
  bySource: Record<string, number>;
}

export function syncActionIntentsFromSources(
  params: { groupFolder?: string; now?: string; persist?: boolean } = {},
): SyncActionIntentsResult {
  const groupFolder = params.groupFolder ?? 'main';
  const now = nowIso(params.now);
  const persist = params.persist !== false;
  const bySource: Record<string, number> = {
    message_actions: 0,
    action_bundles: 0,
    goal_planner: 0,
  };
  if (!isDatabaseInitialized()) return { synced: 0, bySource };

  const upsertMirror = (record: ActionIntentRecord): void => {
    const existing = getActionIntentBySource(
      record.sourceSystem,
      record.sourceKey,
    );
    if (
      existing &&
      existing.status === record.status &&
      existing.title === record.title
    ) {
      return;
    }
    if (persist) {
      upsertActionIntent({
        ...record,
        actionId: existing?.actionId ?? record.actionId,
        createdAt: existing?.createdAt ?? record.createdAt,
      });
    }
    bySource[record.sourceSystem] = (bySource[record.sourceSystem] ?? 0) + 1;
  };

  try {
    const messageActions = listMessageActionsForGroup({
      groupFolder,
      includeSent: true,
      limit: 50,
    });
    for (const action of messageActions) {
      const status = MESSAGE_STATUS_MAP[action.sendStatus] ?? 'proposed';
      upsertMirror(
        buildMirrorIntent({
          title: `Message: ${(action.sourceSummary || action.targetKind).slice(0, 160)}`,
          sourceRequestSummary: action.sourceSummary || 'message follow-up',
          sourceChannel: action.targetChannel,
          actionType: 'message_send',
          sourceSystem: 'message_actions',
          sourceKey: action.messageActionId,
          status,
          statusReason: `Mirrors message action sendStatus=${action.sendStatus}.`,
          relatedThreadId: action.presentationThreadId ?? null,
          createdAt: action.createdAt,
          now,
        }),
      );
    }
  } catch {
    // Group may not exist in this workspace; mirroring is best-effort.
  }

  try {
    const bundles = listActionBundlesForGroup({
      groupFolder,
      statuses: ['open', 'partially_done'],
      limit: 20,
    });
    for (const snapshot of bundles) {
      for (const bundleAction of snapshot.actions) {
        const status =
          BUNDLE_ACTION_STATUS_MAP[bundleAction.status] ?? 'proposed';
        upsertMirror(
          buildMirrorIntent({
            title: `Bundle: ${bundleAction.summary.slice(0, 160)}`,
            sourceRequestSummary: snapshot.bundle.title,
            sourceChannel: 'telegram',
            actionType:
              bundleAction.actionType === 'create_reminder'
                ? 'reminder'
                : bundleAction.actionType === 'send_message'
                  ? 'message_send'
                  : 'other',
            sourceSystem: 'action_bundles',
            sourceKey: bundleAction.actionId,
            status,
            statusReason: `Mirrors bundle action status=${bundleAction.status}.`,
            createdAt: bundleAction.createdAt,
            now,
          }),
        );
      }
    }
  } catch {
    // best-effort
  }

  const goals = listHierarchicalGoals({ limit: 10 });
  const activeGoalIds = new Set(
    goals.filter((goal) => goal.status === 'active').map((goal) => goal.goalId),
  );
  const steps = listGoalPlanSteps({ limit: 50 });
  for (const step of steps) {
    if (step.goalId && activeGoalIds.size && !activeGoalIds.has(step.goalId)) {
      continue;
    }
    const status = PLAN_STEP_STATUS_MAP[step.status] ?? 'proposed';
    upsertMirror(
      buildMirrorIntent({
        title: `Plan step: ${step.actionSummary.slice(0, 160)}`,
        sourceRequestSummary: step.actionSummary,
        sourceChannel: 'internal',
        actionType: 'other',
        sourceSystem: 'goal_planner',
        sourceKey: step.stepId,
        status,
        statusReason: `Mirrors goal plan step status=${step.status}.`,
        relatedGoalId: step.goalId,
        relatedPlanStepId: step.stepId,
        createdAt: step.createdAt,
        now,
      }),
    );
  }

  const synced = Object.values(bySource).reduce((sum, n) => sum + n, 0);
  return { synced, bySource };
}

function buildMirrorIntent(input: {
  title: string;
  sourceRequestSummary: string;
  sourceChannel: ControlPlaneChannel;
  actionType: ActionIntentType;
  sourceSystem: ActionIntentRecord['sourceSystem'];
  sourceKey: string;
  status: ActionIntentStatus;
  statusReason: string;
  relatedGoalId?: string | null;
  relatedPlanStepId?: string | null;
  relatedThreadId?: string | null;
  createdAt: string;
  now: string;
}): ActionIntentRecord {
  const autonomy = classifyOperationAutonomy({
    operationSummary: `${input.title} ${input.sourceRequestSummary}`,
    actionType: input.actionType,
    channel: input.sourceChannel,
  });
  return {
    actionId: hashId('action', `${input.sourceSystem}|${input.sourceKey}`),
    createdAt: input.createdAt,
    updatedAt: input.now,
    title: input.title,
    sourceRequestSummary: input.sourceRequestSummary.slice(0, 320),
    sourceChannel: input.sourceChannel,
    relatedGoalId: input.relatedGoalId ?? null,
    relatedPlanStepId: input.relatedPlanStepId ?? null,
    relatedThreadId: input.relatedThreadId ?? null,
    relatedCalendarEventId: null,
    relatedSkillId: null,
    relatedProofNeedId: null,
    actionType: input.actionType,
    riskLevel:
      autonomy.level >= 6
        ? 'critical'
        : autonomy.level >= 5
          ? 'high'
          : autonomy.level >= 3
            ? 'medium'
            : 'low',
    autonomyLevel: autonomy.level,
    approvalRequirement: approvalRequirementForLevel(autonomy.level),
    status: input.status,
    statusReason: input.statusReason,
    sourceSystem: input.sourceSystem,
    sourceKey: input.sourceKey,
    privacyJson: PRIVACY_JSON,
  };
}

// --- Reporting -------------------------------------------------------------

export interface ActionLifecycleReport {
  generatedAt: string;
  totalTracked: number;
  byStatus: Record<string, number>;
  waitingOnUser: ActionIntentRecord[];
  recentAttempts: ActionAttemptRecord[];
  recentReviews: ActionReviewRecord[];
}

export function buildActionLifecycleReport(
  params: { now?: string } = {},
): ActionLifecycleReport {
  const generatedAt = nowIso(params.now);
  const intents = isDatabaseInitialized()
    ? listActionIntents({ limit: 200 })
    : [];
  const byStatus: Record<string, number> = {};
  for (const intent of intents) {
    byStatus[intent.status] = (byStatus[intent.status] ?? 0) + 1;
  }
  const waitingOnUser = intents.filter(
    (intent) =>
      intent.status === 'needs_approval' ||
      intent.status === 'needs_clarification',
  );
  return {
    generatedAt,
    totalTracked: intents.length,
    byStatus,
    waitingOnUser: waitingOnUser.slice(0, 10),
    recentAttempts: isDatabaseInitialized()
      ? listActionAttempts({ limit: 10 })
      : [],
    recentReviews: isDatabaseInitialized()
      ? listActionReviews({ limit: 10 })
      : [],
  };
}

export function formatActionLifecycleReport(
  report: ActionLifecycleReport = buildActionLifecycleReport(),
  options: { channel?: ControlPlaneChannel } = {},
): string {
  const concise = options.channel === 'alexa';
  const waiting = report.waitingOnUser;
  if (concise) {
    if (!waiting.length) {
      return 'Nothing is waiting on you right now.';
    }
    return `${waiting.length} action${waiting.length === 1 ? ' is' : 's are'} waiting on you. The top one: ${waiting[0].title}.`;
  }
  const lines: string[] = ['*Action Lifecycle*'];
  lines.push(`Tracked actions: ${report.totalTracked}`);
  const statuses = Object.entries(report.byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}=${count}`)
    .join(', ');
  lines.push(`By status: ${statuses || 'none yet'}`);
  if (waiting.length) {
    lines.push('');
    lines.push('Waiting on you:');
    for (const intent of waiting) {
      lines.push(
        `- [${intent.status}] ${intent.title} (risk ${intent.riskLevel}, L${intent.autonomyLevel})`,
      );
    }
  } else {
    lines.push('Nothing is waiting on you.');
  }
  if (report.recentAttempts.length) {
    lines.push('');
    lines.push('Recent attempts:');
    for (const attempt of report.recentAttempts.slice(0, 5)) {
      lines.push(
        `- ${attempt.result} via ${attempt.toolUsed}${attempt.failureReason ? ` (${attempt.failureReason})` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

export function isActionLifecycleNaturalRequest(text: string): boolean {
  return /\b(what('?| i)s waiting on me|pending actions?|action queue|what are you working on|what did you try|what failed|open actions?)\b/i.test(
    text || '',
  );
}

export function formatActionLifecycleNaturalResponse(
  text: string,
  options: { channel?: ControlPlaneChannel } = {},
): string {
  const report = buildActionLifecycleReport();
  if (/\b(what did you try|what failed)\b/i.test(text || '')) {
    const attempts = report.recentAttempts;
    if (!attempts.length) {
      return 'I have not attempted any tracked actions recently.';
    }
    const failed = attempts.filter((a) => a.result === 'failed');
    const lines = [
      `Recent attempts: ${attempts.length} (${failed.length} failed).`,
    ];
    for (const attempt of attempts.slice(0, 5)) {
      lines.push(
        `- ${attempt.result}: ${attempt.toolUsed}${attempt.failureReason ? ` — ${attempt.failureReason}` : ''}${attempt.repairSuggestion ? ` — suggested fix: ${attempt.repairSuggestion}` : ''}`,
      );
    }
    return lines.join('\n');
  }
  return formatActionLifecycleReport(report, options);
}
