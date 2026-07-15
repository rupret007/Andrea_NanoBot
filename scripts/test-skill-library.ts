import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listSkillPlaybooks,
  listSkillPlaybookRuns,
  upsertLearningDistillation,
  upsertSkillPlaybook,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  applySkillControl,
  buildSkillLibraryReport,
  matchSkillPlaybook,
  runSkillPlaybook,
} from '../src/skill-library.js';
import { capabilityBindingImplementationDigest } from '../src/capability-execution-guard.js';
import type {
  CapabilityResourceDescriptor,
  LearningDistillationRecord,
} from '../src/types.js';
import {
  compileCapabilityCandidate,
  observeCapabilityGap,
  recordCapabilityResourceDiscovery,
  scopeCapabilityAcquisition,
} from '../src/verified-capability-acquisition.js';

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

for (const subjectId of [
  'cognitive_tool:cognitive_executive',
  'cognitive_tool:tool_reliability',
]) {
  upsertToolReliabilityRollup({
    subjectId,
    updatedAt: now,
    sampleCount: 3,
    successRate: 1,
    degradedRate: 0,
    blockedRate: 0,
    fallbackRate: 0,
    reliabilityScore: 0.96,
    currentHealth: 'healthy',
    confidenceCap: 0.95,
    cooldownUntil: null,
    nextAction: 'Continue using the verified local tool.',
    privacyJson: '{}',
  });
}

const run = runSkillPlaybook({
  text: 'save that for later',
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date(now),
});
assert.equal(run.action, 'safe_step_ready');
assert.equal(run.run?.outcome, 'proposed');
assert.equal(run.matched?.requiredContextReady, true);
assert.ok(run.matched?.skill.skillId.includes('save_for_later'));
assert.ok(
  listSkillPlaybookRuns({ skillId: active?.skillId, limit: 5 }).length >= 1,
);
assert.equal(
  listSkillPlaybooks({ groupFolder: 'main', limit: 100 }).find(
    (skill) => skill.skillId === active?.skillId,
  )?.reliabilityScore,
  active?.reliabilityScore,
  'matching a playbook must not increase reliability without an executed, verified outcome',
);
assert.equal(
  listSkillPlaybooks({ groupFolder: 'main', limit: 100 }).find(
    (skill) => skill.skillId === active?.skillId,
  )?.usageCount,
  active?.usageCount,
  'previewing a playbook must not count as executed usage',
);
assert.doesNotMatch(
  JSON.stringify(run),
  /sk-|AIza|raw private body|hidden reasoning/i,
);

const malformed = {
  ...active!,
  skillId: 'skill:test-malformed-metadata',
  title: 'Malformed metadata preview',
  triggerPattern: 'malformed metadata preview',
  taskFamily: 'malformed_metadata',
  requiredContextJson: '{not-json',
  expectedToolsJson: '[]',
  sourceDistillationId: null,
  reliabilityScore: 0.9,
};
upsertSkillPlaybook(malformed);
const malformedRun = runSkillPlaybook({
  text: 'malformed metadata preview',
  taskFamily: 'malformed_metadata',
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date('2026-06-07T18:06:00.000Z'),
});
assert.equal(malformedRun.action, 'blocked');
assert.equal(malformedRun.run?.outcome, 'blocked');
assert.equal(malformedRun.matched?.requiredContextReady, false);
assert.match(malformedRun.matched?.reasons.join(' ') || '', /malformed JSON/i);

const unavailableTool = {
  ...active!,
  skillId: 'skill:test-unavailable-tool',
  title: 'Unavailable tool preview',
  triggerPattern: 'unavailable tool preview',
  taskFamily: 'unavailable_tool',
  requiredContextJson: JSON.stringify(['current request']),
  expectedToolsJson: JSON.stringify(['missing_tool']),
  sourceDistillationId: null,
  reliabilityScore: 0.9,
};
upsertSkillPlaybook(unavailableTool);
const unavailableRun = runSkillPlaybook({
  text: 'unavailable tool preview',
  taskFamily: 'unavailable_tool',
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date('2026-06-07T18:07:00.000Z'),
});
assert.equal(unavailableRun.action, 'blocked');
assert.match(
  unavailableRun.matched?.reasons.join(' ') || '',
  /required tool missing_tool is unavailable/i,
);

const missingContext = {
  ...active!,
  skillId: 'skill:test-missing-context',
  title: 'Repository context preview',
  triggerPattern: 'repository context preview',
  taskFamily: 'repository_context',
  requiredContextJson: JSON.stringify(['current request', 'repository state']),
  expectedToolsJson: '[]',
  sourceDistillationId: null,
  reliabilityScore: 0.9,
};
upsertSkillPlaybook(missingContext);
const missingContextRun = runSkillPlaybook({
  text: 'repository context preview',
  taskFamily: 'repository_context',
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date('2026-06-07T18:08:00.000Z'),
});
assert.equal(missingContextRun.action, 'blocked');
assert.match(
  missingContextRun.matched?.reasons.join(' ') || '',
  /missing context repository state/i,
);
const suppliedContextRun = runSkillPlaybook({
  text: 'repository context preview',
  taskFamily: 'repository_context',
  availableContext: ['repository state'],
  channel: 'telegram',
  groupFolder: 'main',
  now: new Date('2026-06-07T18:09:00.000Z'),
});
assert.equal(suppliedContextRun.action, 'safe_step_ready');
assert.equal(suppliedContextRun.run?.outcome, 'proposed');

assert.equal(
  listSkillPlaybookRuns({ limit: 100 }).some(
    (item) => item.outcome === 'executed_safe_step',
  ),
  false,
  'matching and previewing must never claim a safe step executed',
);

const acquisitionNow = new Date('2026-06-07T18:10:00.000Z');
const acquisitionResource: CapabilityResourceDescriptor = {
  resourceId: 'fixture.projection-control.lookup',
  kind: 'local_script',
  displayName: 'Projection control fixture lookup',
  taskFamilies: ['projection_control'],
  capabilityIds: ['fixture.projection-control.lookup'],
  supportedPostconditions: ['the fixture lookup is verified'],
  requiredInputs: ['key'],
  available: true,
  healthState: 'healthy',
  verificationStrength: 1,
  reliabilityScore: 0.98,
  authorityRequirement: 'none',
  riskLevel: 'low',
  dataEgressClass: 'local_only',
  reversible: true,
  expectedCostBand: 'zero',
  expectedLatencyBand: 'instant',
  version: 'sha256:projection-control-v1',
  sourceRefs: ['fixture:projection-control'],
  maintenanceBurden: 'low',
  bindingRefs: [
    {
      bindingId: 'binding.fixture.projection-control.lookup',
      operationId: 'lookup',
      evaluatorId: 'verify.fixture.projection-control.lookup',
      executorImplementationDigest: capabilityBindingImplementationDigest({
        kind: 'executor',
        implementationId: 'binding.fixture.projection-control.lookup',
        version: 'sha256:projection-control-v1',
      }),
      evaluatorImplementationDigest: capabilityBindingImplementationDigest({
        kind: 'evaluator',
        implementationId: 'verify.fixture.projection-control.lookup',
        version: 'sha256:projection-control-v1',
      }),
      actionClass: 'local_lookup',
      version: 'sha256:projection-control-v1',
      readOnly: true,
    },
  ],
};
const acquisition = observeCapabilityGap({
  metadataClassification: 'derived_metadata',
  groupFolder: 'projection-controls',
  targetOutcome: 'Use the projection control fixture lookup',
  postconditions: ['the fixture lookup is verified'],
  taskFamily: 'projection_control',
  gapKind: 'tool_usage_gap',
  provenanceRefs: ['fixture:projection-control'],
  evidenceOrigin: 'synthetic',
  environmentFingerprint: 'sha256:projection-control-environment-v1',
  now: acquisitionNow,
});
scopeCapabilityAcquisition({
  acquisitionId: acquisition.acquisitionId,
  knownPrerequisites: ['fixture key'],
  missingPrerequisites: [],
  confidence: 0.8,
  now: acquisitionNow,
});
recordCapabilityResourceDiscovery({
  acquisitionId: acquisition.acquisitionId,
  candidates: [acquisitionResource],
  selected: [acquisitionResource],
  rejectedReasons: {},
  now: acquisitionNow,
});
const acquisitionCandidate = compileCapabilityCandidate({
  acquisitionId: acquisition.acquisitionId,
  selectedResources: [acquisitionResource],
  triggerSemantics: ['projection control fixture lookup'],
  requiredInputs: ['key'],
  expectedOutput: 'A verified fixture lookup.',
  deterministicScenarioIds: ['projection-control-primary'],
  heldOutScenarioIds: ['projection-control-heldout'],
  now: acquisitionNow,
});
const projectedSkill = listSkillPlaybooks({
  groupFolder: 'projection-controls',
  limit: 20,
}).find((item) => item.skillId === acquisitionCandidate.record.compiledSkillId);
assert.ok(projectedSkill, 'candidate compilation should create a projection');
upsertSkillPlaybook({
  ...projectedSkill!,
  status: 'active',
  nextAction: 'Simulated stale active projection.',
});
for (const control of ['pause', 'retire', 'reset'] as const) {
  const result = applySkillControl({
    skillId: projectedSkill!.skillId,
    control,
    groupFolder: 'projection-controls',
    now: acquisitionNow,
  });
  assert.equal(result.ok, false);
  assert.match(
    result.message,
    /projection of a canonical capability acquisition/i,
  );
  assert.equal(
    listSkillPlaybooks({
      groupFolder: 'projection-controls',
      limit: 20,
    }).find((item) => item.skillId === projectedSkill!.skillId)?.status,
    'active',
    `${control} must not mutate only the acquisition projection`,
  );
}
assert.equal(
  matchSkillPlaybook({
    text: 'projection control fixture lookup',
    taskFamily: 'projection_control',
    groupFolder: 'projection-controls',
    availableContext: ['key'],
    now: acquisitionNow,
  }),
  null,
  'matcher must reject an active-looking projection whose canonical acquisition is not active',
);

console.log('skill library tests passed');

_closeDatabase();
