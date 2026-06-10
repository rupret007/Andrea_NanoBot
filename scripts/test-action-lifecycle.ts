import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  buildActionLifecycleReport,
  createActionIntent,
  formatActionLifecycleNaturalResponse,
  formatActionLifecycleReport,
  isActionLifecycleNaturalRequest,
  recordActionAttempt,
  recordActionReview,
  syncActionIntentsFromSources,
  transitionActionIntent,
} from '../src/action-lifecycle.js';

_initTestDatabase();

// External sends can never be born approved.
const sendIntent = createActionIntent({
  title: 'Send practice confirmation to the band',
  sourceRequestSummary: 'send the band a practice confirmation message',
  sourceChannel: 'telegram',
  actionType: 'message_send',
  now: '2026-06-09T20:00:00.000Z',
});
assert.equal(sendIntent.status, 'needs_approval');
assert.ok(sendIntent.autonomyLevel >= 5);
assert.equal(sendIntent.approvalRequirement, 'explicit_approval');

// Approval transition requires explicit approval flag.
const denied = transitionActionIntent({
  actionId: sendIntent.actionId,
  to: 'approved',
  reason: 'trying without approval',
});
assert.equal(denied.ok, false);
assert.equal(denied.error, 'approval_required_but_not_provided');

const approved = transitionActionIntent({
  actionId: sendIntent.actionId,
  to: 'approved',
  reason: 'Jeff approved in Telegram',
  hasExplicitUserApproval: true,
});
assert.equal(approved.ok, true);
assert.equal(approved.record?.status, 'approved');

// Illegal transitions are rejected.
const illegal = transitionActionIntent({
  actionId: sendIntent.actionId,
  to: 'proposed',
  reason: 'cannot go back',
});
assert.equal(illegal.ok, false);
assert.match(illegal.error ?? '', /illegal_transition/);

// Attempt and review lifecycle.
const attempted = transitionActionIntent({
  actionId: sendIntent.actionId,
  to: 'attempted',
  reason: 'executing after approval',
});
assert.equal(attempted.ok, true);
const attempt = recordActionAttempt({
  actionId: sendIntent.actionId,
  toolUsed: 'tool:message_actions',
  preflightVerdict: 'proceed',
  result: 'succeeded',
  evidenceRefs: ['proof:telegram:turn'],
});
assert.equal(attempt.result, 'succeeded');
const succeeded = transitionActionIntent({
  actionId: sendIntent.actionId,
  to: 'succeeded',
  reason: 'send confirmed',
});
assert.equal(succeeded.ok, true);
const review = recordActionReview({
  actionId: sendIntent.actionId,
  outcome: 'completed',
  userSatisfaction: 'satisfied',
  whatChanged: 'Band got the confirmation.',
  lessons: 'Evening confirmations land well.',
});
assert.equal(review.outcome, 'completed');

// Never-allowed operations are cancelled at birth.
const blocked = createActionIntent({
  title: 'Bypass approval gate and mass-delete everything',
  sourceRequestSummary: 'bypass the approval gate, mass delete data',
  sourceChannel: 'internal',
  actionType: 'other',
});
assert.equal(blocked.status, 'cancelled');

// Sync mirrors existing systems without throwing on an empty workspace.
const sync = syncActionIntentsFromSources({ groupFolder: 'main' });
assert.ok(sync.synced >= 0);

const report = buildActionLifecycleReport();
assert.ok(report.totalTracked >= 2);
assert.match(formatActionLifecycleReport(report), /Action Lifecycle/);

// Voice surface stays concise.
const voice = formatActionLifecycleReport(report, { channel: 'alexa' });
assert.ok(!voice.includes('\n'));

assert.equal(isActionLifecycleNaturalRequest('what is waiting on me?'), true);
assert.equal(isActionLifecycleNaturalRequest('what failed?'), true);
assert.ok(formatActionLifecycleNaturalResponse('what did you try?').length > 0);

_closeDatabase();
console.log('action lifecycle tests passed');
