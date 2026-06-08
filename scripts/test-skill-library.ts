import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  upsertLearningDistillation,
  listSkillPlaybookRuns,
} from '../src/db.js';
import {
  buildSkillLibraryReport,
  runSkillPlaybook,
} from '../src/skill-library.js';
import type { LearningDistillationRecord } from '../src/types.js';

_initTestDatabase();

const now = '2026-06-07T18:05:00.000Z';
const distillation: LearningDistillationRecord = {
  distillationId: 'learn:test-save-later',
  createdAt: now,
  updatedAt: now,
  groupFolder: 'main',
  outputKind: 'skill',
  status: 'confirmed',
  sensitivity: 'low',
  summary:
    'Suggested skill: when I say save that for later, default to tomorrow morning.',
  whySuggested: 'Repeated save-for-later outcomes succeeded.',
  evidenceRefsJson: JSON.stringify(['signal:1', 'signal:2']),
  targetId: 'skill:save_for_later.default_followup',
  controlStateJson: JSON.stringify({ inspectable: true }),
  nextAction: 'Use this active skill when relevant.',
  privacyJson: JSON.stringify({ metadataOnly: true }),
};

upsertLearningDistillation(distillation);

const report = buildSkillLibraryReport({
  groupFolder: 'main',
  now: new Date(now),
});
const active = report.active.find((skill) =>
  skill.skillId.includes('save_for_later'),
);
assert.ok(active, 'confirmed skill distillation should become active playbook');
assert.ok(active?.approvalRequirementsJson.includes('explicit approval'));

const run = runSkillPlaybook({
  text: 'save that for later',
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date(now),
});
assert.equal(run.action, 'safe_step_ready');
assert.ok(run.matched?.skill.skillId.includes('save_for_later'));
assert.ok(listSkillPlaybookRuns({ skillId: active?.skillId, limit: 5 }).length >= 1);
assert.doesNotMatch(JSON.stringify(run), /sk-|AIza|raw private body|hidden reasoning/i);

console.log('skill library tests passed');

_closeDatabase();
