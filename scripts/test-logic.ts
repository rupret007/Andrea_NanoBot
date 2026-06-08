import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import {
  beginLogicKernelRun,
  buildLogicKernelReport,
  evaluateLogicAnswerSupport,
} from '../src/logic-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listLogicBeliefStates,
  listLogicClaims,
  listLogicContradictions,
  listLogicEvidenceLinks,
  listLogicMissingPremises,
  listLogicUsefulnessScores,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T19:00:00.000Z';
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

const safeEpisode = beginAgentOSEpisode({
  turnId: `logic-safe-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Use cited read-only evidence to answer a planning question and choose the most useful next action.',
  requestRoute: 'test:logic:safe',
  selectedSkillId: 'logic.research_planning',
  selectedSkillPurpose:
    'Exercise belief claims, evidence links, and usefulness scoring.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'strong',
  providerHealthSnapshots: [healthyProvider],
  thinkingPreference: 'deep',
  thinkingTrigger: 'logic-test',
});

const safeReport = buildAgentOSReport({
  episodeId: safeEpisode.episode.episodeId,
});
const logic = beginLogicKernelRun({
  subject: 'logic kernel safe research episode',
  agentOSReport: safeReport,
  generatedAt: checkedAt,
});
const claims = listLogicClaims({ subject: logic.report.subject, limit: 50 });
const links = claims.flatMap((claim) =>
  listLogicEvidenceLinks({ claimId: claim.claimId, limit: 50 }),
);
const scores = listLogicUsefulnessScores({
  subject: logic.report.subject,
  limit: 20,
});
const beliefs = listLogicBeliefStates({
  subject: logic.report.subject,
  limit: 5,
});

assert.ok(claims.length >= 4, 'logic kernel should persist multiple claims');
assert.ok(links.length >= claims.length, 'claims should cite evidence links');
assert.ok(scores.length >= 3, 'logic kernel should score useful actions');
assert.ok(beliefs[0], 'logic kernel should persist a belief state');
assert.ok(
  scores[0].totalScore >= scores[scores.length - 1].totalScore,
  'usefulness scores should sort by total score',
);
assert.equal(logic.report.privacy.rawPromptsStored, false);
assert.equal(logic.report.privacy.rawPrivateBodiesStored, false);
assert.equal(logic.report.privacy.hiddenReasoningStored, false);

const conflictedReport = {
  ...safeReport,
  latestEpisode: safeReport.latestEpisode
    ? {
        ...safeReport.latestEpisode,
        sourceCoverageJson: JSON.stringify({
          score: 0.9,
          conflictCount: 1,
          sourceIds: ['test:source:a', 'test:source:b'],
        }),
      }
    : null,
};
const conflicted = beginLogicKernelRun({
  subject: 'logic kernel conflicted episode',
  agentOSReport: conflictedReport,
  generatedAt: checkedAt,
});
const contradictions = listLogicContradictions({
  subject: conflicted.report.subject,
  limit: 20,
});
const premises = listLogicMissingPremises({
  subject: conflicted.report.subject,
  limit: 20,
});

assert.ok(
  contradictions.some((item) => item.status === 'open'),
  'source conflicts should create visible contradictions',
);
assert.ok(
  premises.some((premise) => premise.blockerClass === 'belief_conflict'),
  'conflicts should create a missing-premise repair path',
);

const approvalEpisode = beginAgentOSEpisode({
  turnId: `logic-approval-${suffix}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Draft a text and hold the send behind explicit same-thread approval.',
  requestRoute: 'test:logic:approval',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Verify logic cannot bypass approval-gated actions.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});
const approvalLogic = beginLogicKernelRun({
  subject: 'logic kernel approval episode',
  agentOSReport: buildAgentOSReport({
    episodeId: approvalEpisode.episode.episodeId,
  }),
  generatedAt: checkedAt,
});
assert.equal(
  approvalLogic.decision.status,
  'stage_approval',
  'approval-required episode should select stage_approval',
);

const unsafeAnswer = evaluateLogicAnswerSupport({
  report: approvalLogic.report,
  text: 'Done, I sent it.',
});
assert.equal(unsafeAnswer.status, 'block');
assert.ok(unsafeAnswer.flags.includes('approval_gate_overreach'));

const rebuilt = buildLogicKernelReport({
  subject: logic.report.subject,
  generatedAt: checkedAt,
});
const serialized = JSON.stringify({
  logic,
  conflicted,
  approvalLogic,
  rebuilt,
  unsafeAnswer,
});
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      subject: logic.report.subject,
      claims: claims.length,
      evidenceLinks: links.length,
      contradictions: contradictions.length,
      usefulnessScores: scores.length,
      approvalDecision: approvalLogic.decision.status,
      nextAction: logic.report.selectedNextAction,
      privacy: logic.report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
