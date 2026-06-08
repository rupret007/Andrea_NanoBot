import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listAgentOSInterrupts,
  listAgentOSResumeTokens,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T18:10:00.000Z';
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
  turnId: `agent-os-interrupt-${suffix}`,
  channel: 'bluebubbles',
  groupFolder: 'main',
  taskFamily: 'communication',
  goal: 'Draft a Messages reply from sanitized metadata and send it later tonight only after explicit approval.',
  requestRoute: 'test:agent-os:interrupts',
  selectedSkillId: 'communication.reply_help',
  selectedSkillPurpose:
    'Stage send-adjacent work as an approval interrupt without sending.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  providerHealthSnapshots: [healthyProvider],
});

const interrupts = listAgentOSInterrupts({
  episodeId: result.episode.episodeId,
  limit: 20,
});
const tokens = listAgentOSResumeTokens({
  episodeId: result.episode.episodeId,
  status: 'active',
  limit: 20,
});
const report = buildAgentOSReport({ episodeId: result.episode.episodeId });
const serialized = JSON.stringify({ result, interrupts, tokens, report });

assert.equal(result.episode.status, 'awaiting_approval');
assert.ok(
  interrupts.some(
    (interrupt) =>
      interrupt.interruptKind === 'approval_required' &&
      interrupt.status === 'open',
  ),
  'approval-required episode should persist an open interrupt',
);
assert.ok(tokens.length >= 1, 'approval interrupt should expose a resume token');
assert.match(tokens[0].safeStateJson, /resume_from_checkpoint/);
assert.ok(report.nextAction.toLowerCase().includes('approval'));
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      episodeId: result.episode.episodeId,
      episodeStatus: result.episode.status,
      interruptCount: interrupts.length,
      activeResumeTokens: tokens.length,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
