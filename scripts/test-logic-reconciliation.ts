import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import {
  beginLogicKernelRun,
  buildLogicReconciliationReport,
} from '../src/logic-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listLogicClaims,
  listLogicClaimTransitions,
  upsertLogicClaim,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T20:00:00.000Z';
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

const episode = beginAgentOSEpisode({
  turnId: `logic-reconcile-${suffix}`,
  channel: 'system',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Run a task drill that later becomes stale and should not block current belief.',
  requestRoute: 'test:logic:reconciliation',
  selectedSkillId: 'logic.reconciliation',
  selectedSkillPurpose: 'Create claims that can be reconciled.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const subject = 'logic reconciliation stale episode proof';
const logic = beginLogicKernelRun({
  subject,
  agentOSReport: buildAgentOSReport({ episodeId: episode.episode.episodeId }),
  generatedAt: checkedAt,
});

const episodeClaim = listLogicClaims({
  subject: logic.report.subject,
  claimKind: 'episode_state',
  limit: 20,
})[0];
assert.ok(episodeClaim, 'test should create an episode-state claim');
upsertLogicClaim({
  ...episodeClaim,
  updatedAt: '2026-04-01T00:00:00.000Z',
  status: 'active',
});

const reconciled = buildLogicReconciliationReport({
  subject: logic.report.subject,
  generatedAt: checkedAt,
});
const transitions = listLogicClaimTransitions({
  subject: logic.report.subject,
  limit: 20,
});

assert.ok(
  reconciled.staleClaims.some((claim) => claim.claimId === episodeClaim.claimId),
  'stale episode-state claim should be retired from active confidence',
);
assert.ok(
  transitions.some(
    (transition) =>
      transition.claimId === episodeClaim.claimId &&
      transition.fromStatus === 'active' &&
      transition.toStatus === 'stale',
  ),
  'reconciliation should persist claim lifecycle transition',
);
assert.equal(reconciled.privacy.rawPromptsStored, false);
assert.equal(reconciled.privacy.rawPrivateBodiesStored, false);
assert.equal(reconciled.privacy.hiddenReasoningStored, false);

const markedCurrent = buildLogicReconciliationReport({
  subject: logic.report.subject,
  generatedAt: checkedAt,
  userControl: 'mark_current',
});
assert.ok(
  markedCurrent.activeClaims.some((claim) => claim.claimId === episodeClaim.claimId),
  'user control should allow marking a claim current again',
);

const serialized = JSON.stringify({ reconciled, markedCurrent });
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      subject: logic.report.subject,
      staleClaims: reconciled.staleClaims.length,
      transitions: reconciled.transitions.length,
      markedCurrentActiveClaims: markedCurrent.activeClaims.length,
      nextAction: reconciled.nextAction,
      privacy: reconciled.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
