import assert from 'node:assert/strict';

import {
  beginCognitiveKernelRun,
  buildCognitiveTraceReport,
  finalizeCognitiveKernelOutcome,
} from '../src/cognitive-kernel.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listCognitiveProviderCooldowns,
  listCognitiveToolSimulations,
  listCognitiveTraceSpans,
} from '../src/db.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-05T12:00:00.000Z';
const turnId = `cognition-trace-${Date.now().toString(36)}`;

function provider(
  providerId: string,
  state: ProviderHealthSnapshot['state'],
  failureClass: ProviderHealthSnapshot['failureClass'],
  blocker: string,
): ProviderHealthSnapshot {
  return {
    providerId,
    kind: 'llm',
    state,
    lastHealthyAt: state === 'healthy' ? checkedAt : null,
    lastCheckedAt: checkedAt,
    failureClass,
    quotaState: failureClass === 'quota_or_rate_limit' ? 'blocked' : 'unknown',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker,
    nextAction:
      state === 'healthy'
        ? ''
        : `Use available providers and retry ${providerId} after cooldown.`,
    metadata: {},
  };
}

const kernel = beginCognitiveKernelRun({
  turnId,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'operator',
  goal: 'Handle operator turn from telegram via direct_assistant. Safe user intent: ultrathink a read-only diagnosis while known providers are degraded.',
  requestRoute: 'direct_assistant',
  selectedSkillId: 'operator.diagnostics',
  selectedSkillPurpose: 'Diagnose services without mutating state.',
  selectedSkillApprovalNeed: 'explicit',
  selectedSkillSideEffectRisk: 'high',
  selectedSkillEvidenceLevel: 'partial',
  thinkingPreference: 'deep',
  thinkingTrigger: 'ultrathink',
  providerHealthSnapshots: [
    provider('openai_cloud', 'healthy', 'none', ''),
    provider(
      'gemini_cloud',
      'externally_blocked',
      'quota_or_rate_limit',
      'quota temporarily blocked',
    ),
    provider(
      'anthropic_cloud',
      'externally_blocked',
      'auth_failure',
      'provider auth check failed',
    ),
  ],
});

finalizeCognitiveKernelOutcome({
  cognitiveRun: kernel,
  evaluationStatus: 'warn',
  evidenceGap: 'minor',
  evaluatorFlags: ['provider_cooldown_recorded', 'degraded_provider_route'],
  routeUsed: 'operator.diagnostics',
  answerClass: 'degraded',
});

const spans = listCognitiveTraceSpans({ runId: kernel.run.runId, limit: 50 });
const simulations = listCognitiveToolSimulations({
  runId: kernel.run.runId,
  limit: 50,
});
const cooldowns = listCognitiveProviderCooldowns({
  status: 'active',
  activeAt: checkedAt,
});
const trace = buildCognitiveTraceReport({
  runId: kernel.run.runId,
  generatedAt: checkedAt,
});
const serialized = JSON.stringify(trace);

assert.ok(spans.length >= 6, 'run should emit a replayable trace timeline');
assert.ok(
  spans.some((span) => span.spanKind === 'provider_health'),
  'trace should include provider-health span',
);
assert.ok(
  spans.some((span) => span.spanKind === 'tool_simulation'),
  'trace should include tool simulation span',
);
assert.ok(
  simulations.length > 0,
  'run should persist deterministic tool simulations',
);
assert.ok(
  cooldowns.some((cooldown) => cooldown.providerId === 'gemini_cloud'),
  'Gemini cooldown should be persisted when provider is blocked',
);
assert.ok(
  cooldowns.some((cooldown) => cooldown.providerId === 'anthropic_cloud'),
  'Anthropic cooldown should be persisted when provider is blocked',
);
assert.ok(
  trace.activeCooldownProviderIds.includes('gemini_cloud'),
  'trace report should surface active cooldown providers',
);
assert.equal(trace.replayPacket.privacy.rawPromptsStored, false);
assert.equal(trace.replayPacket.privacy.rawPrivateBodiesStored, false);
assert.equal(trace.replayPacket.privacy.hiddenReasoningStored, false);
assert.doesNotMatch(
  serialized,
  /sk-|AIza|Bearer\s+|raw private body|chain-of-thought/i,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      runId: kernel.run.runId,
      spans: spans.length,
      simulations: simulations.length,
      activeCooldownProviderIds: trace.activeCooldownProviderIds,
      simulationStatus: trace.simulationStatus,
      nextAction: trace.nextAction,
      privacy: trace.replayPacket.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
