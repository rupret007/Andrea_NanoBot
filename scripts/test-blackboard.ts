import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listBlackboardSnapshots,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  buildCognitiveBlackboard,
  formatBlackboardNaturalResponse,
  formatBlackboardReport,
  isBlackboardNaturalRequest,
} from '../src/cognitive-blackboard.js';
import { createActionIntent } from '../src/action-lifecycle.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

// Empty workspace: bounded, single recommended step, no crash.
const empty = buildCognitiveBlackboard({
  requestText: 'morning check-in',
  now: '2026-06-09T13:00:00.000Z',
});
assert.ok(empty.recommendedNextStep.length > 0);
assert.ok(!empty.recommendedNextStep.includes('\n'));
assert.equal(empty.approvalNeedsCount, 0);

// Pending approval surfaces on the blackboard and wins the next step.
createActionIntent({
  title: 'Send practice confirmation to Rad Dad',
  sourceRequestSummary: 'send the band the practice confirmation',
  sourceChannel: 'telegram',
  actionType: 'message_send',
  now: '2026-06-09T13:05:00.000Z',
});
const withApproval = buildCognitiveBlackboard({
  requestText: 'what should we do next?',
  now: '2026-06-09T13:06:00.000Z',
});
assert.equal(withApproval.approvalNeedsCount, 1);
assert.match(withApproval.recommendedNextStep, /approve|review/i);

// Snapshot persisted, metadata-only.
const snapshots = listBlackboardSnapshots({ limit: 5 });
assert.ok(snapshots.length >= 2);
assert.match(snapshots[0].privacyJson, /metadataOnly/);

// Report is bounded (no context dump).
const report = formatBlackboardReport(withApproval);
assert.ok(report.split('\n').length <= 20);
assert.match(report, /Recommended next step/);

// Alexa formatting is a single concise utterance.
const voice = formatBlackboardReport(withApproval, { channel: 'alexa' });
assert.ok(!voice.includes('\n'));
assert.ok(voice.length < 240);

assert.equal(isBlackboardNaturalRequest('what are you doing right now?'), true);
assert.equal(isBlackboardNaturalRequest('what matters right now?'), true);
assert.equal(isBlackboardNaturalRequest('what should we do next?'), false);
assert.equal(isBlackboardNaturalRequest('blackboard status'), true);
const natural = formatBlackboardNaturalResponse('blackboard status');
assert.match(natural, /next step/i);

upsertToolReliabilityRollup({
  subjectId: 'provider:brave_search',
  updatedAt: '2026-06-09T13:10:00.000Z',
  sampleCount: 4,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 0,
  reliabilityScore: 0.1,
  currentHealth: 'blocked',
  confidenceCap: 0.22,
  cooldownUntil: null,
  nextAction: 'Wait for Brave quota recovery.',
  privacyJson: '{}',
});
const healthyBraveProvider: ProviderHealthSnapshot = {
  providerId: 'brave_search',
  kind: 'search',
  state: 'healthy',
  lastHealthyAt: '2026-06-09T13:11:00.000Z',
  lastCheckedAt: '2026-06-09T13:11:00.000Z',
  failureClass: 'none',
  quotaState: 'unknown',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: '',
  nextAction: '',
  metadata: {},
};
const freshProviderBlackboard = buildCognitiveBlackboard({
  requestText: 'blackboard status',
  now: '2026-06-09T13:12:00.000Z',
  persist: false,
  providerHealthSnapshots: [healthyBraveProvider],
});
assert.doesNotMatch(
  freshProviderBlackboard.toolReliabilitySummary,
  /provider:brave_search \(blocked\)/,
  'fresh provider health should prevent stale blocked provider rollups from leaking into blackboard',
);

_closeDatabase();
console.log('cognitive blackboard tests passed');
