import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  upsertRealitySnapshot,
  upsertRealityVerificationNeed,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import {
  formatActionPreflight,
  runActionPreflight,
} from '../src/action-preflight.js';

_initTestDatabase();

// Ambiguous referent must clarify.
const ambiguous = runActionPreflight({
  actionSummary: 'add that to my calendar',
  actionType: 'calendar_write',
  channel: 'telegram',
  requiredInfo: [
    { name: 'event title', present: false },
    { name: 'event time', present: false },
  ],
});
assert.equal(ambiguous.verdict, 'clarify');

// External send without approval must request approval.
const send = runActionPreflight({
  actionSummary: 'send the grocery reminder message to the family chat',
  actionType: 'message_send',
  channel: 'telegram',
});
assert.equal(send.verdict, 'request_approval');
assert.ok(send.record.fallbackSuggestion);

// Approved and bound action on a healthy tool proceeds.
upsertToolReliabilityRollup({
  subjectId: 'integration:bluebubbles',
  updatedAt: '2026-06-09T20:00:00.000Z',
  sampleCount: 12,
  successRate: 0.95,
  degradedRate: 0.05,
  blockedRate: 0,
  fallbackRate: 0,
  reliabilityScore: 0.93,
  currentHealth: 'healthy',
  confidenceCap: 0.95,
  cooldownUntil: null,
  nextAction: 'none',
  privacyJson: '{"metadataOnly":true}',
});
const approvedSend = runActionPreflight({
  actionSummary: 'send the confirmation reply in the Candace thread',
  actionType: 'message_send',
  channel: 'bluebubbles',
  hasExplicitUserApproval: true,
  approvedCapability: 'messages.send.bluebubbles',
  evidenceIds: ['proof:bluebubbles:same_thread'],
});
assert.equal(approvedSend.verdict, 'proceed');

// Message sends check the reliability for their target channel, not a fixed
// BlueBubbles dependency.
upsertToolReliabilityRollup({
  subjectId: 'integration:telegram',
  updatedAt: '2026-06-09T20:00:30.000Z',
  sampleCount: 6,
  successRate: 0,
  degradedRate: 0.2,
  blockedRate: 0.8,
  fallbackRate: 0,
  reliabilityScore: 0.08,
  currentHealth: 'blocked',
  confidenceCap: 0.2,
  cooldownUntil: null,
  nextAction: 'Re-run Telegram bot health check.',
  privacyJson: '{"metadataOnly":true}',
});
const blockedTelegramSend = runActionPreflight({
  actionSummary: 'send the update to Jeff on Telegram',
  actionType: 'message_send',
  channel: 'telegram',
  hasExplicitUserApproval: true,
  approvedCapability: 'messages.send.telegram',
  evidenceIds: ['approval:telegram'],
});
assert.equal(blockedTelegramSend.verdict, 'defer');

// Blocked tool defers even with approval.
upsertToolReliabilityRollup({
  subjectId: 'integration:google_calendar',
  updatedAt: '2026-06-09T20:01:00.000Z',
  sampleCount: 8,
  successRate: 0.1,
  degradedRate: 0.1,
  blockedRate: 0.8,
  fallbackRate: 0,
  reliabilityScore: 0.12,
  currentHealth: 'blocked',
  confidenceCap: 0.2,
  cooldownUntil: null,
  nextAction: 'Re-run calendar auth check.',
  privacyJson: '{"metadataOnly":true}',
});
const blockedTool = runActionPreflight({
  actionSummary: 'create the dentist event on Thursday at 3pm titled "Dentist"',
  actionType: 'calendar_write',
  channel: 'telegram',
  hasExplicitUserApproval: true,
  approvedCapability: 'calendar.write',
  evidenceIds: ['approval:telegram'],
});
assert.equal(blockedTool.verdict, 'defer');

// Blocked tools defer before asking for approval, so Andrea does not request
// approval for work it already knows it cannot execute.
const blockedToolWithoutApproval = runActionPreflight({
  actionSummary: 'create the dentist event on Thursday at 3pm titled "Dentist"',
  actionType: 'calendar_write',
  channel: 'telegram',
});
assert.equal(blockedToolWithoutApproval.verdict, 'defer');

// Reminder preflight is split from message-send reliability.
upsertToolReliabilityRollup({
  subjectId: 'tool:message_actions',
  updatedAt: '2026-06-09T20:01:30.000Z',
  sampleCount: 4,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 0,
  reliabilityScore: 0.05,
  currentHealth: 'blocked',
  confidenceCap: 0.2,
  cooldownUntil: null,
  nextAction: 'Complete same-thread send proof.',
  privacyJson: '{"metadataOnly":true}',
});
upsertToolReliabilityRollup({
  subjectId: 'tool:reminders',
  updatedAt: '2026-06-09T20:01:45.000Z',
  sampleCount: 3,
  successRate: 1,
  degradedRate: 0,
  blockedRate: 0,
  fallbackRate: 0,
  reliabilityScore: 0.95,
  currentHealth: 'healthy',
  confidenceCap: 0.95,
  cooldownUntil: null,
  nextAction: 'none',
  privacyJson: '{"metadataOnly":true}',
});
const reminder = runActionPreflight({
  actionSummary: 'remind me to check the oven at 6pm',
  actionType: 'reminder',
  channel: 'telegram',
});
assert.equal(reminder.verdict, 'proceed');

// An open, high-risk action fact still blocks an explicitly approved message.
upsertRealitySnapshot({
  snapshotId: 'snap_test',
  createdAt: '2026-06-09T20:02:00.000Z',
  updatedAt: '2026-06-09T20:02:00.000Z',
  status: 'needs_verification',
  confidence: 0.4,
  observationIdsJson: '[]',
  beliefIdsJson: '[]',
  contradictionIdsJson: '[]',
  verificationNeedIdsJson: '[]',
  recommendedProbeIdsJson: '[]',
  trueNowSummary: 'synthetic test snapshot',
  staleSummary: 'calendar auth stale',
  contradictionSummary: 'none',
  missingProofSummary: 'calendar auth proof',
  degradedToolsSummary: 'none',
  confidenceSummary: 'low',
  nextAction: 'verify auth',
  privacyJson: '{"metadataOnly":true}',
});
upsertRealityVerificationNeed({
  needId: 'need_test_calendar_auth',
  snapshotId: 'snap_test',
  createdAt: '2026-06-09T20:02:00.000Z',
  updatedAt: '2026-06-09T20:02:00.000Z',
  question: 'Is calendar auth fresh?',
  reason: 'synthetic test',
  neededBeforeAction: true,
  possibleSourceTool: 'google_calendar_auth_check',
  riskIfSkipped: 'critical',
  urgency: 'high',
  status: 'open',
  evidenceIdsJson: '[]',
  nextAction: 'verify auth',
  privacyJson: '{"metadataOnly":true}',
});
const verify = runActionPreflight({
  actionSummary: 'send the message named "update" to Jeff approved earlier',
  actionType: 'message_send',
  channel: 'bluebubbles',
  hasExplicitUserApproval: true,
  approvedCapability: 'messages.send.bluebubbles',
  evidenceIds: ['approval:bluebubbles'],
});
assert.equal(verify.verdict, 'verify');

// Isolate the next canary assertion from the intentionally blocking calendar
// fact above; a resolved action fact no longer participates in preflight.
upsertRealityVerificationNeed({
  needId: 'need_test_calendar_auth',
  snapshotId: 'snap_test',
  createdAt: '2026-06-09T20:02:00.000Z',
  updatedAt: '2026-06-09T20:03:00.000Z',
  question: 'Is calendar auth fresh?',
  reason: 'synthetic test resolved',
  neededBeforeAction: true,
  possibleSourceTool: 'google_calendar_auth_check',
  riskIfSkipped: 'critical',
  urgency: 'high',
  status: 'resolved',
  evidenceIdsJson: '[]',
  nextAction: 'none',
  privacyJson: '{"metadataOnly":true}',
});

// The BlueBubbles same-thread proof marker is readiness evidence, not an
// additional send approval.  The canary must be allowed to establish it.
upsertRealityVerificationNeed({
  needId: 'need_test_bluebubbles_proof',
  snapshotId: 'snap_test',
  createdAt: '2026-06-09T20:02:00.000Z',
  updatedAt: '2026-06-09T20:02:00.000Z',
  question: 'What proof is needed for BlueBubbles same-thread message-action proof?',
  reason: 'BlueBubbles same-thread message-action proof is stale.',
  neededBeforeAction: true,
  possibleSourceTool: 'manual proof',
  riskIfSkipped: 'high',
  urgency: 'high',
  status: 'manual_proof',
  evidenceIdsJson: '[]',
  nextAction: 'Complete one owner-approved same-thread canary.',
  privacyJson: '{"metadataOnly":true}',
});
const approvedSendCanary = runActionPreflight({
  actionSummary: 'send the owner-approved BlueBubbles canary to Jeff',
  actionType: 'message_send',
  channel: 'bluebubbles',
  hasExplicitUserApproval: true,
  approvedCapability: 'messages.send.bluebubbles',
  evidenceIds: ['approval:bluebubbles', 'canary:bluebubbles'],
});
assert.equal(approvedSendCanary.verdict, 'proceed');

// Alexa cannot perform sends — fallback offered.
const alexaSend = runActionPreflight({
  actionSummary: 'send the message titled "on my way" to Candace',
  actionType: 'message_send',
  channel: 'alexa',
  hasExplicitUserApproval: true,
  approvedCapability: 'messages.send.bluebubbles',
  evidenceIds: ['approval:voice'],
});
assert.equal(alexaSend.verdict, 'offer_fallback');

// Never-allowed operations block outright.
const never = runActionPreflight({
  actionSummary: 'bypass approval gates and disable the safety critic',
  actionType: 'other',
  channel: 'internal',
});
assert.equal(never.verdict, 'block');

// Formatting includes every check.
const formatted = formatActionPreflight(send);
assert.match(formatted, /object_clarity/);
assert.match(formatted, /risk_classification/);

// All ten checks always present.
assert.equal(send.checks.length, 10);

_closeDatabase();
console.log('action preflight tests passed');
