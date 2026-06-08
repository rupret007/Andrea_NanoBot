import assert from 'node:assert/strict';

import {
  beginAgentOSEpisode,
  buildAgentOSReport,
  discoverAgentOSToolCards,
} from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentOSEpisodeSteps,
  listAgentOSEpisodes,
  listAgentOSTrajectoryEvals,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T18:00:00.000Z';
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

const result = beginAgentOSEpisode({
  turnId: `agent-os-core-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Use Agent OS to gather read-only research evidence, cite evidence IDs, and explain the next safe step.',
  requestRoute: 'test:agent-os:core',
  selectedSkillId: 'agent_os.research_episode',
  selectedSkillPurpose:
    'Create a durable episode around a safe read-only research task.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
  thinkingPreference: 'deep',
  thinkingTrigger: 'agent-os-test',
});

const episodes = listAgentOSEpisodes({ limit: 10 });
const steps = listAgentOSEpisodeSteps({
  episodeId: result.episode.episodeId,
  limit: 100,
});
const evals = listAgentOSTrajectoryEvals({
  episodeId: result.episode.episodeId,
  limit: 10,
});
const report = buildAgentOSReport({ episodeId: result.episode.episodeId });
const cards = discoverAgentOSToolCards(checkedAt);
const serialized = JSON.stringify({ result, report, cards });

assert.ok(episodes.some((episode) => episode.episodeId === result.episode.episodeId));
assert.ok(steps.some((step) => step.stepKind === 'frame'));
assert.ok(steps.some((step) => step.stepKind === 'tool_discovery'));
assert.ok(steps.some((step) => step.stepKind === 'memory_compile'));
assert.ok(steps.some((step) => step.stepKind === 'outcome'));
assert.ok(evals.length >= 1, 'episode should record a trajectory eval');
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.ok(report.capabilityDiscovery.toolCards.length >= 4);
assert.ok(report.capabilityDiscovery.sourceCoverage.length >= 4);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      episodeId: result.episode.episodeId,
      runId: result.kernel.run.runId,
      episodeStatus: result.episode.status,
      stepCount: steps.length,
      trajectoryScore: evals[0]?.overallScore,
      toolCards: report.capabilityDiscovery.toolCards.length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
