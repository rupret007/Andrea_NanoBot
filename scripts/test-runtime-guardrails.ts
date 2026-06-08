import assert from 'node:assert/strict';

import {
  RuntimeToolGuardrailOutputFactory,
  adaptiveReturnDecision,
  citationCoverageFor,
  effectiveRuntimeConfidence,
  makeRuntimeGuardrailResult,
  makeRuntimeSkillManifest,
  transformedRuntimeValueOr,
} from '../src/agent-runtime-glue.js';
import { beginAgentRuntimeSpineRun } from '../src/agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentRuntimeGuardrailResults,
  listAgentRuntimeSkillManifests,
} from '../src/db.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:55:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i;

const allow = makeRuntimeGuardrailResult({
  runtimeRunId: 'runtime:guardrail:test',
  generatedAt,
  interventionPoint: 'pre_tool',
  guardrailName: 'read_only',
  behavior: RuntimeToolGuardrailOutputFactory.allow(),
  reason: 'Read-only tool is safe.',
});
const reject = makeRuntimeGuardrailResult({
  runtimeRunId: 'runtime:guardrail:test',
  generatedAt,
  interventionPoint: 'pre_tool',
  guardrailName: 'unsafe_write',
  behavior: RuntimeToolGuardrailOutputFactory.rejectContent('Write blocked.'),
  reason: 'Unsafe side effect.',
  riskFlags: ['unauthorized_write'],
});
const staged = makeRuntimeGuardrailResult({
  runtimeRunId: 'runtime:guardrail:test',
  generatedAt,
  interventionPoint: 'pre_tool',
  guardrailName: 'approval',
  behavior: RuntimeToolGuardrailOutputFactory.stageApproval('Approval needed.'),
  reason: 'Side effect needs approval.',
});

assert.equal(allow.status, 'pass');
assert.equal(allow.allowed, true);
assert.equal(reject.status, 'block');
assert.equal(reject.allowed, false);
assert.equal(staged.status, 'approval_required');
assert.equal(staged.decision, 'suspend');

const original = { draft: 'unchanged' };
const transformed = { draft: 'changed' };
assert.deepEqual(transformedRuntimeValueOr('allow', transformed, original), original);
assert.deepEqual(transformedRuntimeValueOr('transform', transformed, original), transformed);

assert.ok(
  effectiveRuntimeConfidence({
    confidence: 0.9,
    kind: 'proof',
    validFrom: '2026-06-01T00:00:00.000Z',
    now: generatedAt,
  }) < 0.9,
);
assert.ok(
  citationCoverageFor({
    text: 'The runtime spine stores metadata only. runtime:evidence:abc',
    evidenceIds: ['runtime:evidence:abc'],
  }) > 0,
);
assert.equal(adaptiveReturnDecision({ intent: 'entity', total: 9 }).kept, 2);

const runtime = beginAgentRuntimeSpineRun({
  turnId: 'runtime-spine-guardrails',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Restart the service and then report the status.',
  generatedAt,
  mode: 'assistive',
});
assert.ok(runtime);
const guardrails = listAgentRuntimeGuardrailResults({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 20,
});
assert.ok(guardrails.some((guardrail) => guardrail.status === 'approval_required'));

const manifest = makeRuntimeSkillManifest({
  generatedAt,
  skillId: 'runtime-spine.guardrail',
  sourceKind: 'user',
  frontmatter: { description: 'User-level guardrail skill.' },
  trigger: { phrase: 'restart service' },
  toolRefs: ['services:status'],
  approvalRules: ['service_changes_require_approval'],
  evidenceNeeds: ['runtime_checkpoint'],
  summary: 'Guardrail skill candidate.',
});
assert.equal(manifest.precedence, 100);
assert.equal(manifest.status, 'candidate');
const manifests = listAgentRuntimeSkillManifests({ limit: 20 });
assert.ok(manifests.some((item) => item.skillId.includes('runtime-spine.operator')));

const serialized = JSON.stringify({ allow, reject, staged, runtime, manifest, manifests });
assert.doesNotMatch(serialized, SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      approvalGuardrails: guardrails.filter((guardrail) => guardrail.status === 'approval_required').length,
      transformOnlyMutation: true,
      skillPrecedence: manifest.precedence,
      runtimeRunId: runtime.run.runtimeRunId,
    },
    null,
    2,
  ),
);

_closeDatabase();
