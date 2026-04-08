import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  getDelegationRule,
  listDelegationRulesForGroup,
  upsertDelegationRule,
} from './db.js';
import {
  applyDelegationRulesToActionPlans,
  buildDelegationRuleListPresentation,
  buildDelegationRulePreview,
  buildDelegationRuleWhyText,
  findMatchingDelegationRule,
  recordDelegationRuleUsage,
  saveDelegationRuleFromPreview,
} from './delegation-rules.js';
import type { DelegationRuleRecord } from './types.js';

function seedRule(
  overrides: Partial<DelegationRuleRecord> = {},
): DelegationRuleRecord {
  const record: DelegationRuleRecord = {
    ruleId: overrides.ruleId || 'rule-1',
    groupFolder: overrides.groupFolder || 'main',
    title: overrides.title || 'Default reminder rule',
    triggerType: overrides.triggerType || 'bundle_type',
    triggerScope: overrides.triggerScope || 'mixed',
    conditionsJson:
      overrides.conditionsJson ||
      JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'communication',
      }),
    delegatedActionsJson:
      overrides.delegatedActionsJson ||
      JSON.stringify([
        {
          actionType: 'create_reminder',
          timingHint: 'tomorrow morning',
        },
      ]),
    approvalMode: overrides.approvalMode || 'auto_apply_when_safe',
    status: overrides.status || 'active',
    createdAt: overrides.createdAt || '2026-04-08T10:00:00.000Z',
    lastUsedAt: overrides.lastUsedAt ?? null,
    timesUsed: overrides.timesUsed ?? 0,
    timesAutoApplied: overrides.timesAutoApplied ?? 0,
    timesOverridden: overrides.timesOverridden ?? 0,
    lastOutcomeStatus: overrides.lastOutcomeStatus ?? null,
    userConfirmed: overrides.userConfirmed ?? true,
    channelApplicabilityJson:
      overrides.channelApplicabilityJson ||
      JSON.stringify(['telegram', 'alexa', 'bluebubbles']),
    safetyLevel:
      overrides.safetyLevel || 'safe_to_auto_after_delegation',
  };
  upsertDelegationRule(record);
  return record;
}

describe('delegation rules', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  afterEach(() => {
    _closeDatabase();
  });

  it('builds, saves, and presents a reminder-default rule from natural language', () => {
    const previewResult = buildDelegationRulePreview({
      utterance: 'when I say save that, use tomorrow morning by default',
      context: {
        groupFolder: 'main',
        channel: 'telegram',
      },
    });

    expect(previewResult.handled).toBe(true);
    expect(previewResult.preview?.delegatedActions[0]?.actionType).toBe(
      'create_reminder',
    );
    expect(previewResult.preview?.delegatedActions[0]?.timingHint).toBe(
      'tomorrow morning',
    );

    const saved = saveDelegationRuleFromPreview(
      'main',
      previewResult.preview!,
      new Date('2026-04-08T11:00:00.000Z'),
    );
    const list = listDelegationRulesForGroup({ groupFolder: 'main' });
    const presentation = buildDelegationRuleListPresentation({
      groupFolder: 'main',
      channel: 'telegram',
    });

    expect(list).toHaveLength(1);
    expect(saved.title).toContain('reminder');
    expect(presentation.text).toContain('*Delegation rules*');
    expect(presentation.inlineActionRows[0]?.[0]?.label).toContain('Pause');
    expect(buildDelegationRuleWhyText(saved)).toContain(saved.title);
  });

  it('prefers the more specific rule over a broader match', () => {
    seedRule({
      ruleId: 'rule-broad',
      title: 'Broad communication reminder',
      conditionsJson: JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'communication',
      }),
    });
    seedRule({
      ruleId: 'rule-specific',
      title: 'Candace reminder',
      conditionsJson: JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'communication',
        personName: 'Candace',
      }),
    });

    const match = findMatchingDelegationRule({
      groupFolder: 'main',
      channel: 'telegram',
      actionType: 'create_reminder',
      originKind: 'communication',
      personName: 'Candace',
      threadTitle: 'Candace',
    });

    expect(match.rule?.ruleId).toBe('rule-specific');
  });

  it('resolves ties toward the safer approval mode', () => {
    seedRule({
      ruleId: 'rule-auto',
      title: 'Auto reminder',
      approvalMode: 'auto_apply_when_safe',
    });
    seedRule({
      ruleId: 'rule-ask',
      title: 'Ask reminder',
      approvalMode: 'always_ask',
    });

    const match = findMatchingDelegationRule({
      groupFolder: 'main',
      channel: 'telegram',
      actionType: 'create_reminder',
      originKind: 'communication',
    });

    expect(match.rule?.ruleId).toBe('rule-ask');
    expect(match.effectiveApprovalMode).toBe('always_ask');
  });

  it('treats ask-once rules as remembered only after a confirmed use', () => {
    seedRule({
      ruleId: 'rule-remember',
      title: 'Remembered thread save',
      conditionsJson: JSON.stringify({
        actionType: 'save_to_thread',
        originKind: 'communication',
      }),
      delegatedActionsJson: JSON.stringify([
        {
          actionType: 'save_to_thread',
          threadTitle: 'Candace',
        },
      ]),
      approvalMode: 'ask_once_then_remember',
    });

    const beforeUse = findMatchingDelegationRule({
      groupFolder: 'main',
      channel: 'telegram',
      actionType: 'save_to_thread',
      originKind: 'communication',
    });
    expect(beforeUse.effectiveApprovalMode).toBe('always_ask');

    recordDelegationRuleUsage({
      ruleId: 'rule-remember',
      outcomeStatus: 'completed',
      now: new Date('2026-04-08T12:00:00.000Z'),
    });

    const afterUse = findMatchingDelegationRule({
      groupFolder: 'main',
      channel: 'telegram',
      actionType: 'save_to_thread',
      originKind: 'communication',
    });

    expect(getDelegationRule('rule-remember')?.timesUsed).toBe(1);
    expect(afterUse.effectiveApprovalMode).toBe('auto_apply_when_safe');
    expect(afterUse.autoApplied).toBe(true);
  });

  it('applies safe rules to action plans with delegated defaults and metadata', () => {
    seedRule({
      ruleId: 'rule-plan',
      title: 'Tomorrow reminder default',
      conditionsJson: JSON.stringify({
        actionType: 'create_reminder',
        originKind: 'daily_guidance',
      }),
      delegatedActionsJson: JSON.stringify([
        {
          actionType: 'create_reminder',
          timingHint: 'tomorrow morning',
        },
      ]),
    });

    const [action] = applyDelegationRulesToActionPlans({
      groupFolder: 'main',
      channel: 'telegram',
      originKind: 'daily_guidance',
      actions: [
        {
          actionType: 'create_reminder',
          targetSystem: 'reminders',
          summary: 'Remind me about this tomorrow',
          requiresConfirmation: true,
          payload: {
            type: 'create_reminder',
            timingHint: null,
          },
        },
      ],
    });

    expect(action?.initialStatus).toBe('approved');
    expect(action?.requiresConfirmation).toBe(false);
    expect(action?.delegationRuleId).toBe('rule-plan');
    expect(action?.delegationMode).toBe('auto_apply_when_safe');
    expect(action?.delegationExplanation).toContain('saved reminder rule');
    expect(action?.payload.timingHint).toBe('tomorrow morning');
  });
});
