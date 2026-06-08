import assert from 'node:assert/strict';

import { buildCognitiveWorkspaceReport } from '../src/cognitive-workspace.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveProgramManifests,
  listCognitiveProgramRuns,
} from '../src/db.js';

_initTestDatabase();

const report = await buildCognitiveWorkspaceReport({
  generatedAt: '2026-06-07T08:12:00.000Z',
  persist: true,
});
const packet = report.packet;
assert.ok(packet, 'packet should exist');

const manifests = listCognitiveProgramManifests({ limit: 20 });
const runs = listCognitiveProgramRuns({ packetId: packet.packetId, limit: 20 });
const selected = manifests.find((manifest) => manifest.programId === packet.selectedProgramId);

assert.ok(selected, 'selected program should persist as a manifest');
assert.ok(runs.some((run) => run.programId === selected?.programId && run.selected));
assert.ok(
  ['candidate', 'shadow', 'probation', 'quarantined', 'trusted'].includes(selected.status),
);
assert.notEqual(
  selected.status,
  'trusted',
  'new workspace programs should not become trusted without verified promotion',
);
assert.match(selected.approvalRulesJson, /approval_staged|no_auto_send/);
assert.match(selected.verifierChecksJson, /truth_support|provider_participation/);
assert.ok(selected.outcomeScore >= 0 && selected.outcomeScore <= 1);

const serialized = JSON.stringify({ report, manifests, runs });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body|provider debate|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      packet: packet.packetId,
      program: selected.programId,
      programStatus: selected.status,
      runs: runs.length,
      nextAction: selected.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
