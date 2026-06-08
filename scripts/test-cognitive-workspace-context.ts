import assert from 'node:assert/strict';

import { buildCognitiveWorkspaceReport } from '../src/cognitive-workspace.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveWorkspaceContextBlocks,
} from '../src/db.js';

_initTestDatabase();

const report = await buildCognitiveWorkspaceReport({
  generatedAt: '2026-06-07T08:11:00.000Z',
  persist: true,
  intentText:
    'workspace status with sk-proj-THISSHOULDNOTLEAK1234567890 and raw private body text',
});
const packetId = report.packet?.packetId || '';
const storedBlocks = listCognitiveWorkspaceContextBlocks({ packetId, limit: 50 });

assert.ok(packetId, 'packet id should exist');
assert.ok(storedBlocks.length >= 6, 'context blocks should be persisted');
assert.ok(storedBlocks.some((block) => block.blockKind === 'session_continuity'));
assert.ok(storedBlocks.some((block) => block.blockKind === 'world_model'));
assert.ok(storedBlocks.every((block) => block.included || block.withheldReason));
assert.ok(storedBlocks.every((block) => block.sourceIdsJson.startsWith('[')));
assert.ok(storedBlocks.every((block) => block.evidenceIdsJson.startsWith('[')));
assert.ok(
  storedBlocks.every((block) => block.sensitivity !== 'secret_excluded' || !block.included),
);

const serialized = JSON.stringify({ report, storedBlocks });
assert.doesNotMatch(
  serialized,
  /THISSHOULDNOTLEAK|raw private body text|raw message body|provider debate|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      packet: packetId,
      blocks: storedBlocks.length,
      included: storedBlocks.filter((block) => block.included).length,
      withheld: storedBlocks.filter((block) => !block.included).length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
