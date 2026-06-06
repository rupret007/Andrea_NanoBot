import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveDoctorReport,
  buildCognitiveTraceReport,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitivePlanRevisions,
  listCognitiveProviderCooldowns,
  listCognitiveRunEvents,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-05T14:00:00.000Z';
const turnId = `cognition-meta-${Date.now().toString(36)}`;

function provider(
  providerId: string,
  state: ProviderHealthSnapshot['state'],
  failureClass: ProviderHealthSnapshot['failureClass'],
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: 'llm',
    state,
    lastHealthyAt: state === 'healthy' ? checkedAt : null,
    lastCheckedAt: checkedAt,
    failureClass,
    quotaState: failureClass === 'quota_or_rate_limit' ? 'blocked' : 'ok',
    credentialState:
      failureClass === 'auth_failure' ? 'invalid' : 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker:
      state === 'healthy'
        ? ''
        : `${providerId} is temporarily unavailable for this run.`,
    nextAction:
      state === 'healthy'
        ? ''
        : `Skip optional ${providerId} roles and rerun provider diagnostics later.`,
    metadata: {},
  };
}

const kernel = beginCognitiveKernelRun({
  turnId,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal:
    'Ultrathink a live research route, but skip blocked providers honestly and explain the next safe repair step.',
  requestRoute: 'direct_assistant',
  selectedSkillId: 'research.live',
  selectedSkillPurpose: 'Use local-first evidence, public search only when available, and verifier-safe synthesis.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'partial',
  thinkingPreference: 'deep',
  thinkingTrigger: 'ultrathink',
  providerHealthSnapshots: [
    provider('openai_cloud', 'healthy', 'none'),
    provider('gemini_cloud', 'externally_blocked', 'quota_or_rate_limit'),
    provider('anthropic_cloud', 'externally_blocked', 'auth_failure'),
  ],
});

const cooldowns = listCognitiveProviderCooldowns({
  status: 'active',
  activeAt: checkedAt,
  limit: 20,
});
const revisions = listCognitivePlanRevisions({
  runId: kernel.run.runId,
  limit: 50,
});
const events = listCognitiveRunEvents({ runId: kernel.run.runId, limit: 50 });
const trace = buildCognitiveTraceReport({
  runId: kernel.run.runId,
  generatedAt: checkedAt,
});
const doctor = buildCognitiveDoctorReport(checkedAt, [
  provider('openai_cloud', 'healthy', 'none'),
  provider('gemini_cloud', 'externally_blocked', 'quota_or_rate_limit'),
  provider('anthropic_cloud', 'externally_blocked', 'auth_failure'),
]);
const serialized = JSON.stringify({ kernel, cooldowns, revisions, events, trace, doctor });

assert.ok(
  cooldowns.some((cooldown) => cooldown.providerId === 'gemini_cloud'),
  'Gemini cooldown should be active',
);
assert.ok(
  cooldowns.some((cooldown) => cooldown.providerId === 'anthropic_cloud'),
  'Anthropic cooldown should be active',
);
assert.ok(
  revisions.some(
    (revision) =>
      revision.revisionKind === 'provider_cooldown' &&
      /gemini_cloud/.test(revision.reason),
  ),
  'provider cooldown should become a replayable plan revision',
);
assert.ok(
  events.some((event) => event.eventKind === 'revise'),
  'provider cooldown should emit a revision event',
);
assert.ok(trace.planRevisionCount >= 2);
assert.ok(
  trace.activeCooldownProviderIds.includes('gemini_cloud') &&
    trace.activeCooldownProviderIds.includes('anthropic_cloud'),
);
assert.ok(doctor.execution.planRevisions >= 2);
assert.equal(trace.replayPacket.privacy.rawPromptsStored, false);
assert.equal(trace.replayPacket.privacy.rawPrivateBodiesStored, false);
assert.equal(trace.replayPacket.privacy.hiddenReasoningStored, false);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body text|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runId: kernel.run.runId,
      cooldownProviderIds: cooldowns.map((cooldown) => cooldown.providerId),
      revisionKinds: revisions.map((revision) => revision.revisionKind),
      events: events.length,
      executionStatus: trace.executionStatus,
      planRevisionCount: trace.planRevisionCount,
      nextAction: trace.nextAction,
      privacy: trace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
