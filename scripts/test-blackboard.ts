import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listBlackboardSnapshots,
  upsertRealitySnapshot,
  upsertRealityVerificationNeed,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  buildCognitiveBlackboard,
  formatBlackboardNaturalResponse,
  formatBlackboardReport,
  isBlackboardNaturalRequest,
} from '../src/cognitive-blackboard.js';
import {
  createActionIntent,
  recordActionReview,
} from '../src/action-lifecycle.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';

_initTestDatabase();

// Empty workspace: bounded, single recommended step, no crash.
const empty = buildCognitiveBlackboard({
  requestText: 'morning check-in',
  now: '2026-06-09T13:00:00.000Z',
});
assert.ok(empty.recommendedNextStep.length > 0);
assert.ok(!empty.recommendedNextStep.includes('\n'));
assert.equal(empty.approvalNeedsCount, 0);

upsertToolReliabilityRollup({
  subjectId: 'integration:alexa',
  updatedAt: '2026-06-09T13:01:00.000Z',
  sampleCount: 1,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 0,
  reliabilityScore: 0.12,
  currentHealth: 'blocked',
  confidenceCap: 0.22,
  cooldownUntil: null,
  nextAction: 'Use a real device or authenticated simulator.',
  privacyJson: '{}',
});
const optionalVoiceDebt = buildCognitiveBlackboard({
  requestText: 'blackboard status',
  now: '2026-06-09T13:02:00.000Z',
});
assert.match(optionalVoiceDebt.toolReliabilitySummary, /optional\/manual/);
assert.doesNotMatch(optionalVoiceDebt.recommendedNextStep, /alexa/i);
assert.match(optionalVoiceDebt.recommendedNextStep, /Nothing urgent/i);

// Pending approval surfaces on the blackboard and wins the next step.
const approvalIntent = createActionIntent({
  title: 'Send practice confirmation to Rad Dad',
  sourceRequestSummary: 'send the band the practice confirmation',
  sourceChannel: 'telegram',
  actionType: 'message_send',
  now: '2026-06-09T13:05:00.000Z',
});
recordActionReview({
  actionId: approvalIntent.actionId,
  outcome: 'deferred',
  whatChanged: 'Practice confirmation stayed staged for approval.',
  lessons: 'Keep message sends visible as staged outcomes until approved.',
  now: '2026-06-09T13:05:30.000Z',
});
upsertRealitySnapshot({
  snapshotId: 'blackboard-test-snapshot',
  createdAt: '2026-06-09T13:05:40.000Z',
  updatedAt: '2026-06-09T13:05:40.000Z',
  status: 'needs_verification',
  confidence: 0.62,
  observationIdsJson: '[]',
  beliefIdsJson: '[]',
  contradictionIdsJson: '[]',
  verificationNeedIdsJson: '["need-telegram-proof","need-calendar-observe"]',
  recommendedProbeIdsJson: '[]',
  trueNowSummary: 'Daily-agent proof freshness needs attention.',
  staleSummary: 'Telegram proof needs a refresh.',
  contradictionSummary: 'none',
  missingProofSummary: 'telegram proof',
  degradedToolsSummary: 'none',
  confidenceSummary: 'medium until proof refresh lands',
  nextAction: 'Refresh Telegram proof.',
  privacyJson: '{}',
});
upsertRealityVerificationNeed({
  needId: 'need-telegram-proof',
  snapshotId: 'blackboard-test-snapshot',
  createdAt: '2026-06-09T13:05:40.000Z',
  updatedAt: '2026-06-09T13:05:40.000Z',
  question: 'Is Telegram proof fresh?',
  reason: 'Telegram proof is stale in this fixture.',
  neededBeforeAction: true,
  possibleSourceTool: 'telegram_user_smoke',
  riskIfSkipped: 'medium',
  urgency: 'high',
  status: 'manual_proof',
  evidenceIdsJson: '[]',
  nextAction: 'Rerun npm run telegram:user:smoke.',
  privacyJson: '{}',
});
upsertRealityVerificationNeed({
  needId: 'need-calendar-observe',
  snapshotId: 'blackboard-test-snapshot',
  createdAt: '2026-06-09T13:05:41.000Z',
  updatedAt: '2026-06-09T13:05:41.000Z',
  question: 'Can calendar reads be trusted?',
  reason: 'Collect one low-risk status observation.',
  neededBeforeAction: false,
  possibleSourceTool: 'calendar_status',
  riskIfSkipped: 'low',
  urgency: 'normal',
  status: 'runnable_read_only',
  evidenceIdsJson: '[]',
  nextAction: 'Collect one calendar status observation.',
  privacyJson: '{}',
});
const withApproval = buildCognitiveBlackboard({
  requestText: 'what should we do next?',
  now: '2026-06-09T13:06:00.000Z',
});
assert.equal(withApproval.approvalNeedsCount, 1);
assert.equal(withApproval.proofDebtOpen, 2);
assert.match(withApproval.realitySummary, /manual=1/);
assert.match(withApproval.realitySummary, /read_only=1/);
assert.match(withApproval.outcomeSignalSummary, /action review/);
assert.match(withApproval.improvementSignalSummary, /Since last run/);
assert.match(withApproval.recommendedNextStep, /approve|review/i);

// Snapshot persisted, metadata-only.
const snapshots = listBlackboardSnapshots({ limit: 5 });
assert.ok(snapshots.length >= 2);
assert.match(snapshots[0].privacyJson, /metadataOnly/);

// Report is bounded (no context dump).
const report = formatBlackboardReport(withApproval);
assert.ok(report.split('\n').length <= 20);
assert.match(report, /Daily snapshot/);
assert.match(report, /Verification needs: 2/);
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

upsertToolReliabilityRollup({
  subjectId: 'integration:bluebubbles',
  updatedAt: '2026-06-09T13:10:00.000Z',
  sampleCount: 4,
  successRate: 0,
  degradedRate: 1,
  blockedRate: 0,
  fallbackRate: 0,
  reliabilityScore: 0.35,
  currentHealth: 'degraded',
  confidenceCap: 0.58,
  cooldownUntil: null,
  nextAction: 'Complete same-thread proof.',
  privacyJson: '{}',
});
const healthyBlueBubblesIntegration: IntegrationDoctorReport = {
  generatedAt: '2026-06-09T13:12:00.000Z',
  summary: {
    total: 1,
    healthy: 1,
    actionNeeded: 0,
    needsProof: 0,
    manualOrExternal: 0,
  },
  statuses: [
    {
      integrationId: 'bluebubbles',
      label: 'BlueBubbles',
      state: 'healthy',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'healthy',
      lastHealthyAt: '2026-06-09T13:12:00.000Z',
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: '',
      repairability: 'status_only',
      safeActions: [],
      detail: 'BlueBubbles is healthy.',
    },
  ],
  secretsRedacted: true,
};
const freshIntegrationBlackboard = buildCognitiveBlackboard({
  requestText: 'blackboard status',
  now: '2026-06-09T13:13:00.000Z',
  persist: false,
  integrationReport: healthyBlueBubblesIntegration,
});
assert.doesNotMatch(
  freshIntegrationBlackboard.toolReliabilitySummary,
  /integration:bluebubbles \(degraded\)/,
  'fresh integration truth should prevent stale degraded BlueBubbles rollups from leaking into blackboard',
);

for (const subjectId of [
  'tool:calendar',
  'tool:research',
  'tool:message_actions',
  'route:cognitive_executive.daily_companion',
  'route:cognitive_executive.communication_companion',
  'route:cognitive_executive.everyday_capture',
  'route:cognitive_executive.research',
]) {
  upsertToolReliabilityRollup({
    subjectId,
    updatedAt: '2026-06-09T13:14:00.000Z',
    sampleCount: 0,
    successRate: 0,
    degradedRate: 0,
    blockedRate: 0,
    fallbackRate: 0,
    reliabilityScore: 0,
    currentHealth: 'unknown',
    confidenceCap: 0.5,
    cooldownUntil: null,
    nextAction: 'Collect one fresh status observation.',
    privacyJson: '{}',
  });
}
const healthyToolDependenciesBlackboard = buildCognitiveBlackboard({
  requestText: 'blackboard status',
  now: '2026-06-09T13:15:00.000Z',
  persist: false,
  providerHealthSnapshots: [healthyBraveProvider],
  integrationReport: {
    generatedAt: '2026-06-09T13:15:00.000Z',
    summary: {
      total: 3,
      healthy: 3,
      actionNeeded: 0,
      needsProof: 0,
      manualOrExternal: 0,
    },
    statuses: [
      {
        integrationId: 'telegram',
        label: 'Telegram',
        state: 'healthy',
        credentialState: 'configured',
        transportState: 'healthy',
        proofState: 'healthy',
        lastHealthyAt: '2026-06-09T13:15:00.000Z',
        lastFailure: '',
        blockerOwner: 'none',
        nextAction: '',
        repairability: 'status_only',
        safeActions: [],
        detail: 'Telegram is healthy.',
      },
      {
        integrationId: 'bluebubbles',
        label: 'BlueBubbles',
        state: 'healthy',
        credentialState: 'configured',
        transportState: 'healthy',
        proofState: 'healthy',
        lastHealthyAt: '2026-06-09T13:15:00.000Z',
        lastFailure: '',
        blockerOwner: 'none',
        nextAction: '',
        repairability: 'status_only',
        safeActions: [],
        detail: 'BlueBubbles is healthy.',
      },
      {
        integrationId: 'google_calendar',
        label: 'Google Calendar',
        state: 'healthy',
        credentialState: 'configured',
        transportState: 'healthy',
        proofState: 'healthy',
        lastHealthyAt: '2026-06-09T13:15:00.000Z',
        lastFailure: '',
        blockerOwner: 'none',
        nextAction: '',
        repairability: 'status_only',
        safeActions: [],
        detail: 'Google Calendar is healthy.',
      },
    ],
    secretsRedacted: true,
  },
});
assert.doesNotMatch(
  healthyToolDependenciesBlackboard.toolReliabilitySummary,
  /(tool:(calendar|research|message_actions)|route:cognitive_executive\.(daily_companion|communication_companion|everyday_capture|research))/,
  'healthy dependencies should prevent stale cognitive-tool and route rollups from becoming blackboard work',
);

_closeDatabase();
console.log('cognitive blackboard tests passed');
