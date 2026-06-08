import assert from 'node:assert/strict';

import {
  beginAgentRuntimeSpineRun,
  buildAgentRuntimeSpineReport,
  formatAgentRuntimeSpineReport,
  recordAgentRuntimeTruthAudit,
} from '../src/agent-runtime-spine.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentRuntimeEvidencePackets,
  listAgentRuntimeRuns,
  listAgentRuntimeSteps,
} from '../src/db.js';
import { runTruthEngine } from '../src/truth-engine.js';

_initTestDatabase();

const generatedAt = '2026-06-06T23:45:00.000Z';
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i;

const runtime = beginAgentRuntimeSpineRun({
  turnId: 'runtime-spine-core',
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Research current Andrea proof debt and choose safe read-only checks.',
  generatedAt,
  mode: 'assistive',
});

assert.ok(runtime, 'runtime spine should start in assistive mode');
assert.equal(runtime.run.mode, 'assistive');
assert.equal(runtime.run.status, 'active');
assert.ok(runtime.run.worldSnapshotId, 'runtime run should link a world snapshot');
assert.ok(runtime.run.agentOSEpisodeId, 'runtime run should link an Agent OS episode');
assert.ok(runtime.report.steps.some((step) => step.stepKind === 'world_snapshot'));
assert.ok(runtime.report.evidencePackets.some((packet) => packet.sourceLayer === 'world_model'));

const truth = runTruthEngine({
  text: `Runtime spine linked world evidence ${runtime.run.worldSnapshotId}.`,
  subject: runtime.run.goalSummary,
  generatedAt,
});
recordAgentRuntimeTruthAudit({ runtime, truthVerdict: truth, generatedAt });

const report = buildAgentRuntimeSpineReport({
  runtimeRunId: runtime.run.runtimeRunId,
  generatedAt,
});
const formatted = formatAgentRuntimeSpineReport(report);
const storedRuns = listAgentRuntimeRuns({ limit: 10 });
const storedSteps = listAgentRuntimeSteps({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 50,
});
const storedEvidence = listAgentRuntimeEvidencePackets({
  runtimeRunId: runtime.run.runtimeRunId,
  limit: 50,
});

assert.ok(storedRuns.some((run) => run.runtimeRunId === runtime.run.runtimeRunId));
assert.ok(storedSteps.some((step) => step.stepKind === 'truth'));
assert.ok(storedEvidence.some((packet) => packet.sourceLayer === 'truth'));
assert.match(formatted, /Agent Runtime Spine/);
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);

const serialized = JSON.stringify({ report, formatted });
assert.doesNotMatch(serialized, SECRET_RE);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runtimeRunId: runtime.run.runtimeRunId,
      mode: report.mode,
      steps: report.steps.length,
      evidencePackets: report.evidencePackets.length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
