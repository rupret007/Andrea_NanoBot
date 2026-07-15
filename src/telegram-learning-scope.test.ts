import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTelegramLearningText } from './channels/telegram.js';
import {
  _closeDatabase,
  _initTestDatabase,
  upsertSkillPlaybook,
} from './db.js';
import type { SkillPlaybookRecord } from './types.js';

function skill(groupFolder: string, suffix: string): SkillPlaybookRecord {
  return {
    skillId: `skill:${suffix}`,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
    groupFolder,
    title: `${suffix} private skill`,
    triggerPattern: suffix,
    taskFamily: 'assistant',
    requiredContextJson: '{}',
    allowedActionsJson: '[]',
    disallowedActionsJson: '[]',
    approvalRequirementsJson: '{}',
    expectedToolsJson: '[]',
    fallbackPlan: 'Stop safely.',
    successCriteriaJson: '[]',
    evalScenariosJson: '[]',
    usageCount: 0,
    lastOutcome: null,
    reliabilityScore: 0.8,
    status: 'suggested',
    sourceDistillationId: null,
    nextAction: `Review ${suffix}.`,
    privacyJson: '{"metadataOnly":true}',
  };
}

describe('Telegram learning scope', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertSkillPlaybook(skill('main', 'main-only'));
    upsertSkillPlaybook(skill('other', 'other-only'));
  });

  afterEach(() => _closeDatabase());

  it('shows only skill metadata from the resolved registered group', () => {
    const text = buildTelegramLearningText('Andrea', 'main');

    expect(text).toContain('main-only private skill');
    expect(text).not.toContain('other-only private skill');
  });

  it('does not load skill metadata without a registered group scope', () => {
    const text = buildTelegramLearningText('Andrea', null);

    expect(text).toContain('no registered group scope');
    expect(text).not.toContain('main-only private skill');
    expect(text).not.toContain('other-only private skill');
  });
});
