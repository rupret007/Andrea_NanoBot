import assert from 'node:assert/strict';

import {
  approvalRequirementForLevel,
  classifyOperationAutonomy,
  formatAutonomyPolicyReport,
  formatAutonomyNaturalResponse,
  isAutonomyNaturalRequest,
} from '../src/autonomy-governor.js';

const answer = classifyOperationAutonomy({
  operationSummary: 'explain what is on the calendar today',
});
assert.equal(answer.level, 0);
assert.equal(answer.allowed, true);
assert.equal(answer.requiresExplicitApproval, false);

const draft = classifyOperationAutonomy({
  operationSummary: 'draft a reply to the band thread',
});
assert.equal(draft.level, 1);
assert.equal(draft.requiresExplicitApproval, false);

const reminder = classifyOperationAutonomy({
  operationSummary: 'remind me tomorrow morning to call the venue',
});
assert.equal(reminder.level, 3);

const send = classifyOperationAutonomy({
  operationSummary: 'send the message to Candace now',
});
assert.equal(send.level, 5);
assert.equal(send.requiresExplicitApproval, true);
assert.equal(approvalRequirementForLevel(send.level), 'explicit_approval');

const calendarWrite = classifyOperationAutonomy({
  operationSummary: 'calendar create event for Thursday dinner',
  actionType: 'calendar_write',
});
assert.ok(calendarWrite.level >= 5);

const deploy = classifyOperationAutonomy({
  operationSummary: 'restart the prod service and git push the fix',
});
assert.equal(deploy.level, 6);
assert.equal(deploy.requiresOperatorContext, true);
assert.equal(approvalRequirementForLevel(deploy.level), 'operator_context');

const never = classifyOperationAutonomy({
  operationSummary: 'bypass the approval gate and disable the safety critic',
});
assert.equal(never.level, 7);
assert.equal(never.allowed, false);

// Action-type minimums can only raise, never lower, the level.
const sneakySend = classifyOperationAutonomy({
  operationSummary: 'just a tiny note',
  actionType: 'message_send',
});
assert.ok(sneakySend.level >= 5);

assert.match(formatAutonomyPolicyReport(), /Autonomy Governor Policy/);
assert.equal(isAutonomyNaturalRequest('what do you need approval for?'), true);
assert.match(formatAutonomyNaturalResponse(), /explicit approval/i);

console.log('autonomy governor tests passed');
