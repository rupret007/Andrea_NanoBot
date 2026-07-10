import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getDelegationRule,
  upsertDelegationRule,
} from './db.js';
import {
  classifyDelegationSafety,
  findMatchingDelegationRule,
  recordDelegationRuleOverride,
} from './delegation-rules.js';
import {
  assessRoutinePromotion,
  recordRoutineEvidence,
} from './routine-promotion.js';
import type { DelegationRuleRecord } from './types.js';

function rule(
  actionType: 'create_reminder' | 'send_message',
): DelegationRuleRecord {
  return {
    ruleId: `rule-${actionType}`,
    groupFolder: 'main',
    title: `Test ${actionType}`,
    triggerType: 'capability_result',
    triggerScope: 'personal',
    conditionsJson: JSON.stringify({ actionType }),
    delegatedActionsJson: JSON.stringify([{ actionType }]),
    approvalMode: 'auto_apply_when_safe',
    status: 'active',
    createdAt: '2026-07-10T12:00:00.000Z',
    lastUsedAt: null,
    timesUsed: 0,
    timesAutoApplied: 0,
    timesOverridden: 0,
    lastOutcomeStatus: null,
    userConfirmed: true,
    channelApplicabilityJson: JSON.stringify(['telegram']),
    safetyLevel:
      actionType === 'create_reminder'
        ? 'safe_to_auto_after_delegation'
        : 'always_requires_fresh_approval',
  };
}

describe('routine promotion', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('requires deterministic proof and an approved canary before auto-apply', () => {
    upsertDelegationRule(rule('create_reminder'));
    expect(
      findMatchingDelegationRule({
        groupFolder: 'main',
        channel: 'telegram',
        actionType: 'create_reminder',
      }).effectiveApprovalMode,
    ).toBe('always_ask');

    recordRoutineEvidence({
      ruleId: 'rule-create_reminder',
      kind: 'deterministic_fixture_passed',
      summary: 'Fixture passed with no side effects.',
    });
    recordRoutineEvidence({
      ruleId: 'rule-create_reminder',
      kind: 'canary_verified',
      summary: 'User-approved reminder canary was verified.',
    });

    expect(assessRoutinePromotion('rule-create_reminder').eligible).toBe(true);
    expect(
      findMatchingDelegationRule({
        groupFolder: 'main',
        channel: 'telegram',
        actionType: 'create_reminder',
      }).autoApplied,
    ).toBe(true);
  });

  it('pauses after two overrides in 30 days and never delegates sends', () => {
    upsertDelegationRule(rule('create_reminder'));
    recordDelegationRuleOverride(
      'rule-create_reminder',
      new Date('2026-07-10'),
    );
    recordDelegationRuleOverride(
      'rule-create_reminder',
      new Date('2026-07-11'),
    );
    expect(getDelegationRule('rule-create_reminder')).toMatchObject({
      status: 'paused',
      approvalMode: 'always_ask',
    });

    upsertDelegationRule(rule('send_message'));
    recordRoutineEvidence({
      ruleId: 'rule-send_message',
      kind: 'deterministic_fixture_passed',
      summary: 'Fixture passed.',
    });
    recordRoutineEvidence({
      ruleId: 'rule-send_message',
      kind: 'canary_verified',
      summary: 'Canary passed.',
    });
    expect(assessRoutinePromotion('rule-send_message')).toMatchObject({
      eligible: false,
      reason: 'fresh_approval_action_not_delegatable',
    });
    expect(classifyDelegationSafety('send_message')).toBe(
      'always_requires_fresh_approval',
    );
  });
});
