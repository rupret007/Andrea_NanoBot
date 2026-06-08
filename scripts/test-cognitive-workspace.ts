import assert from 'node:assert/strict';

import {
  buildCognitiveWorkspaceReport,
  formatCognitiveWorkspaceReport,
} from '../src/cognitive-workspace.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveWorkspacePackets,
} from '../src/db.js';

_initTestDatabase();

const report = await buildCognitiveWorkspaceReport({
  generatedAt: '2026-06-07T08:10:00.000Z',
  persist: true,
});
const formatted = formatCognitiveWorkspaceReport(report);
const storedPackets = listCognitiveWorkspacePackets({ limit: 10 });

assert.ok(report.packet, 'workspace should create a packet');
assert.ok(storedPackets.some((packet) => packet.packetId === report.packet?.packetId));
assert.ok(report.contextBlocks.length >= 6, 'workspace should compile cross-layer context');
assert.ok(report.programManifests.length >= 1, 'workspace should create/select a program');
assert.ok(report.optimizationScorecards.length >= 1, 'workspace should score the packet');
assert.ok(report.packet?.sessionSnapshotId, 'packet should link Session Graph');
assert.ok(report.packet?.worldSnapshotId, 'packet should link World Model');
assert.ok(report.packet?.logicBeliefStateId, 'packet should link Logic Kernel');
assert.ok(report.packet?.truthAuditId, 'packet should link Truth Engine');
assert.equal(report.privacy.metadataOnly, true);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.match(formatted, /Cognitive Workspace/);

const serialized = JSON.stringify({ report, formatted });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|provider debate text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      packet: report.packet?.packetId,
      blocks: report.contextBlocks.length,
      program: report.packet?.selectedProgramId,
      score: report.optimizationScorecards[0]?.totalScore,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
