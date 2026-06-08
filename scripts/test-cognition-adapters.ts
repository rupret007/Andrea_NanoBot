import assert from 'node:assert/strict';

import { beginCognitiveKernelRun } from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveApprovalPackets,
  listCognitiveEvidenceArtifacts,
  listCognitiveStepVerifications,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T12:30:00.000Z';
const suffix = Date.now().toString(36);

const healthyProvider: ProviderHealthSnapshot = {
  providerId: 'openai_cloud',
  kind: 'llm',
  state: 'healthy',
  lastHealthyAt: checkedAt,
  lastCheckedAt: checkedAt,
  failureClass: 'none',
  quotaState: 'ok',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: '',
  nextAction: '',
  metadata: {},
};

function runDrill(input: {
  name: string;
  taskFamily: 'calendar' | 'research' | 'communication' | 'operator';
  selectedSkillId: string;
  approvalNeed: string;
  risk: string;
  goal: string;
  channel?: 'telegram' | 'bluebubbles' | 'system';
}) {
  return beginCognitiveKernelRun({
    turnId: `cognition-adapter-${input.name}-${suffix}`,
    channel: input.channel || 'telegram',
    groupFolder: 'main',
    taskFamily: input.taskFamily,
    goal: input.goal,
    requestRoute: `test:cognition:adapters:${input.name}`,
    selectedSkillId: input.selectedSkillId,
    selectedSkillPurpose: `Exercise ${input.name} adapter without storing raw content.`,
    selectedSkillApprovalNeed: input.approvalNeed,
    selectedSkillSideEffectRisk: input.risk,
    selectedSkillEvidenceLevel: 'partial',
    providerHealthSnapshots: [healthyProvider],
  });
}

const calendar = runDrill({
  name: 'calendar',
  taskFamily: 'calendar',
  selectedSkillId: 'calendar.read',
  approvalNeed: 'none',
  risk: 'low',
  goal: 'Read calendar metadata for tomorrow without creating or changing events.',
});
const research = runDrill({
  name: 'research',
  taskFamily: 'research',
  selectedSkillId: 'research.live_or_saved',
  approvalNeed: 'none',
  risk: 'low',
  goal: 'Gather public research metadata only; do not store raw web output.',
});
const bluebubbles = runDrill({
  name: 'bluebubbles',
  taskFamily: 'communication',
  selectedSkillId: 'communication.reply_help',
  approvalNeed: 'explicit',
  risk: 'high',
  channel: 'bluebubbles',
  goal: 'Use sanitized BlueBubbles thread metadata to draft help; do not send any message.',
});
const operator = runDrill({
  name: 'operator',
  taskFamily: 'operator',
  selectedSkillId: 'operator.diagnostics',
  approvalNeed: 'explicit',
  risk: 'high',
  channel: 'system',
  goal: 'Inspect operator diagnostics metadata and stage any repair instead of mutating services.',
});

function artifactKinds(runId: string): string[] {
  return listCognitiveEvidenceArtifacts({ runId, limit: 50 }).map(
    (artifact) => artifact.artifactKind,
  );
}

assert.ok(artifactKinds(calendar.run.runId).includes('calendar_read'));
assert.ok(artifactKinds(research.run.runId).includes('research_evidence'));
assert.ok(artifactKinds(bluebubbles.run.runId).includes('bluebubbles_digest'));
assert.ok(artifactKinds(operator.run.runId).includes('operator_diagnostics'));

const blueApproval = listCognitiveApprovalPackets({
  runId: bluebubbles.run.runId,
  status: 'staged',
  limit: 20,
});
const operatorApproval = listCognitiveApprovalPackets({
  runId: operator.run.runId,
  status: 'staged',
  limit: 20,
});
assert.ok(
  blueApproval.length >= 1,
  'BlueBubbles send-adjacent work must stage approval',
);
assert.ok(operatorApproval.length >= 1, 'operator work must stage approval');
assert.equal(bluebubbles.run.status, 'awaiting_approval');
assert.equal(operator.run.status, 'awaiting_approval');

for (const run of [calendar, research, bluebubbles, operator]) {
  const verifications = listCognitiveStepVerifications({
    runId: run.run.runId,
    limit: 50,
  });
  assert.ok(verifications.length > 0, 'every adapter run should verify steps');
  assert.doesNotMatch(
    JSON.stringify({ run, verifications }),
    /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
  );
}

console.log(
  JSON.stringify(
    {
      status: 'pass',
      calendarKinds: artifactKinds(calendar.run.runId),
      researchKinds: artifactKinds(research.run.runId),
      bluebubblesKinds: artifactKinds(bluebubbles.run.runId),
      operatorKinds: artifactKinds(operator.run.runId),
      blueApprovalPackets: blueApproval.length,
      operatorApprovalPackets: operatorApproval.length,
    },
    null,
    2,
  ),
);

_closeDatabase();
