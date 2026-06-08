import assert from 'assert/strict';

import { initDatabase } from '../src/db.js';
import { reviewAgentAction } from '../src/critic-agent.js';

function main(): void {
  initDatabase();
  const readOnly = reviewAgentAction({
    actor: 'test',
    action: 'read calendar pressure',
    channel: 'internal',
    evidenceIds: ['evidence:test'],
  });
  assert.equal(readOnly.decision, 'proceed');

  const send = reviewAgentAction({
    actor: 'repair_agent',
    action: 'bluebubbles_send a message',
    channel: 'internal',
    evidenceIds: ['evidence:test'],
  });
  assert.equal(send.decision, 'stage_approval');
  assert.equal(send.approvalRequired, true);

  const operator = reviewAgentAction({
    actor: 'repair_agent',
    action: 'git commit and push repair',
    channel: 'telegram',
    evidenceIds: ['evidence:test'],
    hasExplicitUserApproval: true,
    approvedCapability: 'repair_land',
    mainControlVerified: false,
  });
  assert.equal(operator.decision, 'block');
  assert.ok(operator.riskFlagsJson.includes('main_control_not_verified'));
  console.log('critic agent tests passed');
}

main();
