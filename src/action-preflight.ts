import crypto from 'crypto';

import { reviewAgentAction } from './critic-agent.js';
import {
  isDatabaseInitialized,
  listActionIntents,
  listRealityContradictions,
  listRealityVerificationNeeds,
  listToolReliabilityRollups,
  upsertActionPreflight,
} from './db.js';
import {
  approvalRequirementForLevel,
  classifyOperationAutonomy,
} from './autonomy-governor.js';
import type {
  ActionIntentType,
  ActionPreflightCheck,
  ActionPreflightRecord,
  ActionPreflightVerdict,
  ControlPlaneChannel,
} from './types.js';

// ---------------------------------------------------------------------------
// v32 General Action Preflight
//
// One consistent gate that runs before any durable or external action.
// It composes the critic agent, autonomy governor, reality grounding,
// truth maintenance, and tool reliability into a single verdict. It never
// executes anything and never weakens an existing gate: the strictest
// signal always wins.
// ---------------------------------------------------------------------------

const PRIVACY_JSON = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

const UNRESOLVED_REFERENT_RE = /\b(that|this|it|them|those|there)\b/i;
const SPECIFIC_OBJECT_RE =
  /\b(at \d|on (mon|tue|wed|thu|fri|sat|sun)|tomorrow|tonight|today|named?|titled|with [A-Z][a-z]+|to [A-Z][a-z]+|"[^"]+")\b/;

const TOOL_SUBJECT_BY_ACTION_TYPE: Partial<Record<ActionIntentType, string>> = {
  calendar_write: 'integration:google_calendar',
  reminder: 'tool:reminders',
  research: 'provider:brave_search',
};

const SEND_CAPABLE_CHANNELS: ControlPlaneChannel[] = [
  'telegram',
  'bluebubbles',
];

export interface ActionPreflightInput {
  actionSummary: string;
  actionType: ActionIntentType;
  channel: ControlPlaneChannel;
  actionId?: string | null;
  actor?: string;
  hasExplicitUserApproval?: boolean;
  approvedCapability?: string | null;
  mainControlVerified?: boolean;
  evidenceIds?: string[];
  objectClear?: boolean;
  requiredInfo?: Array<{ name: string; present: boolean }>;
  toolSubjectId?: string;
  now?: string;
  persist?: boolean;
}

export interface ActionPreflightResult {
  record: ActionPreflightRecord;
  checks: ActionPreflightCheck[];
  verdict: ActionPreflightVerdict;
}

/**
 * Live-proof entries describe readiness evidence, not a second approval gate.
 * An explicitly approved message send is itself the bounded proof operation:
 * transport health, recipient binding, delivery verification, and the fresh
 * send approval still apply.  A stale Alexa/BlueBubbles/Telegram proof marker
 * must not turn an otherwise valid message into an unrelated global blocker.
 * Action-specific authentication and contradiction records continue through
 * the normal high-risk path below.
 */
function verificationNeedAppliesToAction(
  need: {
    question: string;
    reason: string;
    possibleSourceTool: string;
    status: string;
  },
  input: Pick<ActionPreflightInput, 'actionType'>,
): boolean {
  // Manual-proof rows are readiness markers produced by the live-proof
  // gauntlet.  An explicitly approved message send remains a bounded,
  // receipt-verified way to refresh that evidence; it must not deadlock on
  // stale Alexa, Telegram, or BlueBubbles proof.  Open/critical action facts
  // still pass through and can block the send.
  return !(
    input.actionType === 'message_send' && need.status === 'manual_proof'
  );
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function messageSendToolSubject(
  input: Pick<ActionPreflightInput, 'approvedCapability' | 'channel'>,
): string | undefined {
  if (input.channel === 'telegram') return 'integration:telegram';
  if (input.channel === 'bluebubbles') return 'integration:bluebubbles';
  if (input.approvedCapability === 'messages.send.telegram') {
    return 'integration:telegram';
  }
  if (input.approvedCapability === 'messages.send.bluebubbles') {
    return 'integration:bluebubbles';
  }
  return undefined;
}

function toolSubjectForAction(
  input: Pick<
    ActionPreflightInput,
    'actionType' | 'approvedCapability' | 'channel' | 'toolSubjectId'
  >,
): string | undefined {
  if (input.toolSubjectId) return input.toolSubjectId;
  if (input.actionType === 'message_send') {
    return messageSendToolSubject(input);
  }
  return TOOL_SUBJECT_BY_ACTION_TYPE[input.actionType];
}

export function runActionPreflight(
  input: ActionPreflightInput,
): ActionPreflightResult {
  const createdAt = nowIso(input.now);
  const summary = (input.actionSummary || 'unknown action')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 320);
  const checks: ActionPreflightCheck[] = [];
  const dbReady = isDatabaseInitialized();

  // 1. Object clarity
  const objectClear =
    input.objectClear ??
    (!UNRESOLVED_REFERENT_RE.test(summary) || SPECIFIC_OBJECT_RE.test(summary));
  checks.push({
    checkId: 'object_clarity',
    status: objectClear ? 'pass' : 'fail',
    detail: objectClear
      ? 'The object of the action is identifiable.'
      : 'The action refers to "that/this/it" without a resolvable referent.',
  });

  // 2. Required information
  const missingInfo = (input.requiredInfo ?? []).filter(
    (item) => !item.present,
  );
  checks.push({
    checkId: 'required_info',
    status: missingInfo.length ? 'fail' : 'pass',
    detail: missingInfo.length
      ? `Missing: ${missingInfo.map((item) => item.name).join(', ')}`
      : 'All declared required information is present.',
  });

  // 3. Reality / proof freshness
  let realityStatus: ActionPreflightCheck['status'] = 'pass';
  let realityDetail = 'No open verification needs block this action.';
  if (dbReady) {
    const openNeeds = listRealityVerificationNeeds({
      status: 'open',
      limit: 20,
    }).filter((need) => need.neededBeforeAction);
    const manualNeeds = listRealityVerificationNeeds({
      status: 'manual_proof',
      limit: 20,
    }).filter((need) => need.neededBeforeAction);
    const actionRelevantNeeds = [...openNeeds, ...manualNeeds].filter((need) =>
      verificationNeedAppliesToAction(need, input),
    );
    const blockingNeeds = actionRelevantNeeds.filter(
      (need) =>
        need.riskIfSkipped === 'high' || need.riskIfSkipped === 'critical',
    );
    if (blockingNeeds.length) {
      realityStatus = 'fail';
      realityDetail = `Verification needed before acting: ${blockingNeeds[0].question}`;
    } else if (actionRelevantNeeds.length > 0) {
      realityStatus = 'warn';
      realityDetail = `${actionRelevantNeeds.length} open verification need(s), none classified high-risk for this action.`;
    }
  } else {
    realityStatus = 'skipped';
    realityDetail = 'Database not initialized; reality check skipped.';
  }
  checks.push({
    checkId: 'reality_freshness',
    status: realityStatus,
    detail: realityDetail,
  });

  // 4. Tool reliability
  const subjectId = toolSubjectForAction(input);
  let toolStatus: ActionPreflightCheck['status'] = 'pass';
  let toolDetail = 'No tool reliability concern recorded.';
  if (dbReady && subjectId) {
    const rollup = listToolReliabilityRollups({ limit: 100 }).find(
      (entry) => entry.subjectId === subjectId,
    );
    if (rollup) {
      if (rollup.currentHealth === 'blocked') {
        toolStatus = 'fail';
        toolDetail = `${subjectId} is currently blocked (reliability ${rollup.reliabilityScore.toFixed(2)}).`;
      } else if (
        rollup.currentHealth === 'degraded' ||
        rollup.reliabilityScore < 0.5
      ) {
        toolStatus = 'warn';
        toolDetail = `${subjectId} is degraded (reliability ${rollup.reliabilityScore.toFixed(2)}).`;
      } else {
        toolDetail = `${subjectId} healthy (reliability ${rollup.reliabilityScore.toFixed(2)}).`;
      }
    } else {
      toolStatus = 'warn';
      toolDetail = `${subjectId} has no reliability rollup yet; treating as unproven.`;
    }
  } else if (!subjectId) {
    toolStatus = 'skipped';
    toolDetail = 'No external tool dependency declared for this action type.';
  } else {
    toolStatus = 'skipped';
    toolDetail = 'Database not initialized; reliability check skipped.';
  }
  checks.push({
    checkId: 'tool_reliability',
    status: toolStatus,
    detail: toolDetail,
  });

  // 5. Autonomy + approval
  const autonomy = classifyOperationAutonomy({
    operationSummary: summary,
    actionType: input.actionType,
    channel: input.channel,
  });
  const approvalRequirement = approvalRequirementForLevel(autonomy.level);
  let approvalStatus: ActionPreflightCheck['status'] = 'pass';
  let approvalDetail = `Autonomy L${autonomy.level} (${autonomy.levelLabel}); no approval required.`;
  if (!autonomy.allowed) {
    approvalStatus = 'fail';
    approvalDetail = 'Operation is classified never-allowed (L7).';
  } else if (approvalRequirement !== 'none') {
    if (!input.hasExplicitUserApproval) {
      approvalStatus = 'fail';
      approvalDetail = `Autonomy L${autonomy.level} requires ${approvalRequirement}, and no explicit approval is present.`;
    } else if (
      approvalRequirement === 'operator_context' &&
      !input.mainControlVerified
    ) {
      approvalStatus = 'fail';
      approvalDetail =
        'High-risk operation approved but operator/main-control context is not verified.';
    } else if (!input.approvedCapability) {
      approvalStatus = 'fail';
      approvalDetail =
        'Approval present but not bound to an exact capability; binding required.';
    } else {
      approvalDetail = `Approval present and bound to ${input.approvedCapability}.`;
    }
  }
  checks.push({
    checkId: 'approval',
    status: approvalStatus,
    detail: approvalDetail,
  });

  // 6. Channel allowed
  const isExternalSend =
    input.actionType === 'message_send' || input.actionType === 'household';
  const channelAllowed =
    !isExternalSend ||
    SEND_CAPABLE_CHANNELS.includes(input.channel) ||
    input.channel === 'operator' ||
    input.channel === 'internal';
  checks.push({
    checkId: 'channel_allowed',
    status: channelAllowed ? 'pass' : 'fail',
    detail: channelAllowed
      ? 'Channel is allowed for this action type.'
      : `Channel ${input.channel} cannot perform ${input.actionType}; hand off to Telegram.`,
  });

  // 7. Safer fallback
  const fallbackSuggestion =
    autonomy.level >= 5
      ? input.actionType === 'message_send'
        ? 'Draft the message and queue it for approval instead of sending.'
        : input.actionType === 'calendar_write'
          ? 'Prepare the event draft and confirm details before writing.'
          : 'Stage the action as pending and request approval.'
      : null;
  checks.push({
    checkId: 'safer_fallback',
    status: fallbackSuggestion ? 'warn' : 'pass',
    detail: fallbackSuggestion ?? 'Action is already at a safe autonomy level.',
  });

  // 8. Duplicate detection
  let duplicateStatus: ActionPreflightCheck['status'] = 'pass';
  let duplicateDetail = 'No similar open action found.';
  if (dbReady) {
    const open = listActionIntents({
      statuses: ['proposed', 'needs_approval', 'approved', 'scheduled'],
      actionType: input.actionType,
      limit: 30,
    });
    const normalized = summary.toLowerCase();
    const duplicate = open.find(
      (intent) =>
        intent.actionId !== input.actionId &&
        (intent.title.toLowerCase().includes(normalized.slice(0, 60)) ||
          normalized.includes(intent.title.toLowerCase().slice(0, 60))),
    );
    if (duplicate) {
      duplicateStatus = 'warn';
      duplicateDetail = `Similar open action exists: ${duplicate.title} [${duplicate.status}].`;
    }
  } else {
    duplicateStatus = 'skipped';
    duplicateDetail = 'Database not initialized; duplicate check skipped.';
  }
  checks.push({
    checkId: 'duplicate',
    status: duplicateStatus,
    detail: duplicateDetail,
  });

  // 9. Contradictions
  let contradictionStatus: ActionPreflightCheck['status'] = 'pass';
  let contradictionDetail = 'No open contradictions touch this action.';
  if (dbReady) {
    const contradictions = listRealityContradictions({
      status: 'open',
      limit: 10,
    });
    if (contradictions.length) {
      const severe = contradictions.find(
        (item) => item.severity === 'high' || item.severity === 'critical',
      );
      if (severe) {
        contradictionStatus = 'fail';
        contradictionDetail = `Open ${severe.severity} contradiction (${severe.contradictionKind}) must be resolved or acknowledged first.`;
      } else {
        contradictionStatus = 'warn';
        contradictionDetail = `${contradictions.length} open low/medium contradiction(s).`;
      }
    }
  } else {
    contradictionStatus = 'skipped';
    contradictionDetail =
      'Database not initialized; contradiction check skipped.';
  }
  checks.push({
    checkId: 'contradiction',
    status: contradictionStatus,
    detail: contradictionDetail,
  });

  // 10. Risk classification
  const riskLevel =
    autonomy.level >= 6
      ? 'critical'
      : autonomy.level >= 5
        ? 'high'
        : autonomy.level >= 3
          ? 'medium'
          : 'low';
  checks.push({
    checkId: 'risk_classification',
    status: 'pass',
    detail: `Classified ${riskLevel} risk at autonomy L${autonomy.level}.`,
  });

  // Critic agent runs for any externally visible or operator-scoped action.
  const critic =
    autonomy.level >= 4
      ? reviewAgentAction({
          actor: input.actor ?? 'control_plane_preflight',
          action: summary,
          channel:
            input.channel === 'operator' || input.channel === 'internal'
              ? input.channel
              : input.channel,
          hasExplicitUserApproval: input.hasExplicitUserApproval,
          approvedCapability: input.approvedCapability ?? null,
          mainControlVerified: input.mainControlVerified,
          evidenceIds: input.evidenceIds,
          persist: input.persist,
        })
      : null;

  // Verdict: strictest signal wins.
  let verdict: ActionPreflightVerdict = 'proceed';
  const blockers: string[] = [];
  if (!autonomy.allowed || critic?.decision === 'block') {
    verdict = 'block';
    blockers.push(
      !autonomy.allowed
        ? 'Autonomy governor: never allowed.'
        : 'Critic agent blocked the action.',
    );
  } else if (!channelAllowed) {
    verdict = 'offer_fallback';
    blockers.push('Channel cannot perform this action; handoff suggested.');
  } else if (!objectClear || missingInfo.length) {
    verdict = 'clarify';
    if (!objectClear) blockers.push('Unresolved referent.');
    if (missingInfo.length)
      blockers.push(
        `Missing info: ${missingInfo.map((m) => m.name).join(', ')}`,
      );
  } else if (realityStatus === 'fail' || contradictionStatus === 'fail') {
    verdict = 'verify';
    blockers.push(
      realityStatus === 'fail' ? realityDetail : contradictionDetail,
    );
  } else if (toolStatus === 'fail') {
    verdict = 'defer';
    blockers.push(toolDetail);
  } else if (
    approvalStatus === 'fail' ||
    critic?.decision === 'stage_approval'
  ) {
    verdict = 'request_approval';
    blockers.push(approvalDetail);
  } else if (critic?.decision === 'clarify') {
    verdict = 'clarify';
    blockers.push('Critic agent requested clarification.');
  } else if (duplicateStatus === 'warn') {
    verdict = 'clarify';
    blockers.push(duplicateDetail);
  }

  const record: ActionPreflightRecord = {
    preflightId: hashId(
      'preflight',
      `${summary}|${input.channel}|${createdAt}`,
    ),
    actionId: input.actionId ?? null,
    createdAt,
    actionSummary: summary,
    actionType: input.actionType,
    channel: input.channel,
    riskLevel,
    autonomyLevel: autonomy.level,
    verdict,
    checksJson: JSON.stringify(checks),
    criticDecision: critic?.decision ?? 'not_run',
    fallbackSuggestion,
    blockerSummary: blockers.join(' ') || 'No blockers.',
    privacyJson: PRIVACY_JSON,
  };
  if (input.persist !== false && isDatabaseInitialized()) {
    upsertActionPreflight(record);
  }
  return { record, checks, verdict };
}

export function formatActionPreflight(result: ActionPreflightResult): string {
  const lines: string[] = ['*Action Preflight*'];
  lines.push(`Action: ${result.record.actionSummary}`);
  lines.push(
    `Verdict: ${result.verdict} (risk ${result.record.riskLevel}, autonomy L${result.record.autonomyLevel}, critic ${result.record.criticDecision})`,
  );
  for (const check of result.checks) {
    lines.push(`- ${check.checkId}: ${check.status} — ${check.detail}`);
  }
  if (result.record.fallbackSuggestion) {
    lines.push(`Fallback: ${result.record.fallbackSuggestion}`);
  }
  return lines.join('\n');
}
