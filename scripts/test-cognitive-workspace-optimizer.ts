import assert from 'node:assert/strict';

import { buildCognitiveWorkspaceReport } from '../src/cognitive-workspace.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveImprovementProposals,
  listCognitiveOptimizationScorecards,
  listCognitivePolicyVariants,
} from '../src/db.js';

_initTestDatabase();

const report = await buildCognitiveWorkspaceReport({
  generatedAt: '2026-06-07T08:13:00.000Z',
  optimize: true,
  persist: true,
});
const packet = report.packet;
assert.ok(packet, 'optimizer should still produce a workspace packet');

const variants = listCognitivePolicyVariants({ limit: 20 });
const proposals = listCognitiveImprovementProposals({ limit: 20 });
const scorecards = listCognitiveOptimizationScorecards({
  packetId: packet.packetId,
  limit: 20,
});

assert.ok(variants.length >= 1, 'optimizer should persist a policy variant');
assert.ok(proposals.length >= 1, 'optimizer should persist candidate proposals');
assert.ok(scorecards.length >= 1, 'optimizer should persist a scorecard');
assert.ok(
  proposals.every((proposal) => proposal.status === 'candidate'),
  'workspace optimizer proposals must remain candidate-only',
);
assert.ok(
  proposals.every((proposal) => proposal.safetyRegression === false),
  'optimizer must not propose safety regression',
);
assert.ok(
  proposals.every((proposal) =>
    /no_code_mutation|candidate_only|approval_policy_unchanged/.test(
      proposal.changedArtifactsJson,
    ),
  ),
  'optimizer proposals should explicitly avoid code/live mutation',
);
assert.ok(scorecards.every((scorecard) => scorecard.privacyScore === 1));

const serialized = JSON.stringify({ report, variants, proposals, scorecards });
assert.doesNotMatch(
  serialized,
  /commit\s+applied|push\s+completed|raw private body|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      packet: packet.packetId,
      variants: variants.length,
      proposals: proposals.length,
      score: scorecards[0]?.totalScore,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
