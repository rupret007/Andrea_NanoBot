import assert from 'node:assert/strict';

import {
  beginAgentOSEpisode,
  buildAgentOSReport,
  discoverAgentOSToolCards,
} from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentOSToolCards,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = new Date().toISOString();
const suffix = Date.now().toString(36);

const blockedProvider: ProviderHealthSnapshot = {
  providerId: 'anthropic_cloud',
  kind: 'llm',
  state: 'externally_blocked',
  lastHealthyAt: null,
  lastCheckedAt: checkedAt,
  failureClass: 'quota_or_rate_limit',
  quotaState: 'limited',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: 'quota_or_rate_limit',
  nextAction: 'Wait for quota reset or rotate billing.',
  metadata: {},
};

beginAgentOSEpisode({
  turnId: `agent-os-discovery-${suffix}`,
  channel: 'system',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Discover available Agent OS tools and avoid blocked providers before optional role assignment.',
  requestRoute: 'test:agent-os:tool-discovery',
  selectedSkillId: 'operator.agent_os_discovery',
  selectedSkillPurpose: 'Classify tools and provider cooldowns.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [blockedProvider],
});

const cards = discoverAgentOSToolCards(checkedAt);
const stored = listAgentOSToolCards({ limit: 200 });
const report = buildAgentOSReport();
const serialized = JSON.stringify({ cards, stored, report });

assert.ok(cards.length >= 4);
assert.ok(stored.some((card) => card.policyClass === 'read_only'));
assert.ok(stored.some((card) => card.policyClass === 'approval_staged'));
assert.ok(
  stored
    .filter((card) => card.sourceToolId === 'bluebubbles:send')
    .every((card) => card.approvalPolicy === 'explicit_approval'),
  'send-adjacent tools must stay approval-staged',
);
assert.ok(
  stored.some((card) => card.cooldownJson.includes('anthropic_cloud')),
  'tool cards should carry provider cooldown metadata',
);
assert.equal(report.privacy.rawPromptsStored, false);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      toolCards: stored.length,
      readOnly: report.capabilityDiscovery.readOnly,
      approvalStaged: report.capabilityDiscovery.approvalStaged,
      blocked: report.capabilityDiscovery.blocked,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
