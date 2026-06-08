import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentOSSkillProposals,
  listAgentOSTrajectoryEvals,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T18:30:00.000Z';
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

const safe = beginAgentOSEpisode({
  turnId: `agent-os-trajectory-safe-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Use healthy read-only evidence and produce an auditable answer with cited evidence IDs.',
  requestRoute: 'test:agent-os:trajectory:safe',
  selectedSkillId: 'research.live_or_saved',
  selectedSkillPurpose: 'Exercise a high-scoring read-only Agent OS path.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'strong',
  providerHealthSnapshots: [healthyProvider],
  thinkingPreference: 'deep',
  thinkingTrigger: 'ultrathink',
});

const approval = beginAgentOSEpisode({
  turnId: `agent-os-trajectory-approval-${suffix}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Draft a reply and hold the send behind explicit approval.',
  requestRoute: 'test:agent-os:trajectory:approval',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose: 'Prove trajectory scoring does not promote approval-waiting sends.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const safeEvals = listAgentOSTrajectoryEvals({
  episodeId: safe.episode.episodeId,
  limit: 10,
});
const approvalEvals = listAgentOSTrajectoryEvals({
  episodeId: approval.episode.episodeId,
  limit: 10,
});
const proposals = listAgentOSSkillProposals({ limit: 20 });
const safeReport = buildAgentOSReport({ episodeId: safe.episode.episodeId });
const approvalReport = buildAgentOSReport({
  episodeId: approval.episode.episodeId,
});
const serialized = JSON.stringify({
  safe,
  approval,
  safeEvals,
  approvalEvals,
  proposals,
  safeReport,
  approvalReport,
});

assert.ok(safeEvals[0], 'safe episode should have trajectory eval');
assert.ok(approvalEvals[0], 'approval episode should have trajectory eval');
assert.equal(safeEvals[0].privacySafety, 1);
assert.equal(approvalEvals[0].privacySafety, 1);
assert.equal(
  approvalEvals[0].promotionEligible,
  false,
  'approval-waiting episode must not become a skill automatically',
);
assert.ok(
  proposals.every((proposal) => proposal.status === 'candidate'),
  'skill proposals should remain candidates only',
);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      safeEpisodeId: safe.episode.episodeId,
      safeScore: safeEvals[0].overallScore,
      approvalEpisodeId: approval.episode.episodeId,
      approvalScore: approvalEvals[0].overallScore,
      proposals: proposals.length,
      nextAction: approvalReport.nextAction,
      privacy: safeReport.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
