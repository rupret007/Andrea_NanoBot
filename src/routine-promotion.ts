import { randomUUID } from 'node:crypto';

import {
  getDelegationRule,
  insertRoutineEvidence,
  listRoutineEvidence,
  updateDelegationRule,
} from './db.js';
import type {
  ActionBundleActionType,
  DelegationRuleAction,
  RoutineEvidenceKind,
  RoutineEvidenceRecord,
  RoutinePromotionAssessment,
} from './types.js';
import { recordAssistantMetric } from './personal-assistant-metrics.js';

const DELEGATABLE_REVERSIBLE_ACTIONS = new Set<ActionBundleActionType>([
  'save_to_thread',
  'save_to_library',
  'pin_to_ritual',
  'reference_current_work',
  'draft_follow_up',
  'create_reminder',
]);

export function isDelegatableRoutineAction(
  actionType: ActionBundleActionType,
): boolean {
  return DELEGATABLE_REVERSIBLE_ACTIONS.has(actionType);
}

export function runDeterministicRoutineFixture(
  ruleId: string,
  now = new Date(),
): RoutinePromotionAssessment {
  const rule = getDelegationRule(ruleId);
  if (!rule) return assessRoutinePromotion(ruleId, now);
  const actions = actionsForRule(ruleId);
  if (
    rule.userConfirmed &&
    actions.length > 0 &&
    actions.every((action) => isDelegatableRoutineAction(action.actionType)) &&
    !listRoutineEvidence({ ruleId, limit: 1000 }).some(
      (event) => event.kind === 'deterministic_fixture_passed',
    )
  ) {
    recordRoutineEvidence({
      ruleId,
      kind: 'deterministic_fixture_passed',
      summary:
        'Deterministic routine fixture passed reversible-action and approval-boundary checks.',
      now,
    });
  }
  return assessRoutinePromotion(ruleId, now);
}

function actionsForRule(ruleId: string): DelegationRuleAction[] {
  const rule = getDelegationRule(ruleId);
  if (!rule) return [];
  try {
    return JSON.parse(rule.delegatedActionsJson) as DelegationRuleAction[];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

export function assessRoutinePromotion(
  ruleId: string,
  now = new Date(),
): RoutinePromotionAssessment {
  const rule = getDelegationRule(ruleId);
  const allEvidence = listRoutineEvidence({ ruleId, limit: 1000 });
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const recentEvidence = allEvidence.filter(
    (event) => event.createdAt >= cutoff,
  );
  const deterministicFixturePassed = allEvidence.some(
    (event) => event.kind === 'deterministic_fixture_passed',
  );
  const approvedCanaryCompleted = allEvidence.some(
    (event) =>
      event.kind === 'canary_verified' ||
      event.kind === 'canary_honestly_blocked',
  );
  const negativeEventsIn30Days = recentEvidence.filter(
    (event) => event.kind === 'override' || event.kind === 'failure',
  ).length;
  const actions = actionsForRule(ruleId);
  const safeActions =
    actions.length > 0 &&
    actions.every((action) => isDelegatableRoutineAction(action.actionType));
  const eligible = Boolean(
    rule?.userConfirmed &&
    rule.status === 'active' &&
    safeActions &&
    deterministicFixturePassed &&
    approvedCanaryCompleted &&
    negativeEventsIn30Days < 2,
  );
  const reason = !rule
    ? 'rule_not_found'
    : !rule.userConfirmed
      ? 'user_confirmation_required'
      : !safeActions
        ? 'fresh_approval_action_not_delegatable'
        : !deterministicFixturePassed
          ? 'deterministic_fixture_required'
          : !approvedCanaryCompleted
            ? 'approved_canary_required'
            : negativeEventsIn30Days >= 2
              ? 'paused_after_two_recent_overrides_or_failures'
              : rule.status !== 'active'
                ? `rule_${rule.status}`
                : 'promotion_ready';
  return {
    ruleId,
    eligible,
    deterministicFixturePassed,
    approvedCanaryCompleted,
    negativeEventsIn30Days,
    reason,
  };
}

export function recordRoutineEvidence(params: {
  ruleId: string;
  kind: RoutineEvidenceKind;
  summary: string;
  now?: Date;
}): RoutineEvidenceRecord {
  if (!getDelegationRule(params.ruleId)) {
    throw new Error(`Delegation rule ${params.ruleId} does not exist.`);
  }
  const now = params.now || new Date();
  const record: RoutineEvidenceRecord = {
    evidenceId: randomUUID(),
    ruleId: params.ruleId,
    kind: params.kind,
    summary: params.summary
      .replace(/\s+/g, ' ')
      .replace(/\b(?:sk|xox|ghp|gho|AIza)[A-Za-z0-9_-]{16,}\b/g, '[secret]')
      .trim()
      .slice(0, 240),
    createdAt: now.toISOString(),
  };
  insertRoutineEvidence(record);
  const rule = getDelegationRule(params.ruleId);
  if (rule && params.kind === 'canary_verified') {
    recordAssistantMetric({
      groupFolder: rule.groupFolder,
      kind: 'completion_verified',
      now,
    });
  }
  const assessment = assessRoutinePromotion(params.ruleId, now);
  if (assessment.negativeEventsIn30Days >= 2) {
    updateDelegationRule(params.ruleId, {
      status: 'paused',
      approvalMode: 'always_ask',
    });
  }
  return record;
}
