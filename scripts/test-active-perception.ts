import assert from 'node:assert/strict';

import { _initTestDatabase } from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  formatActivePerceptionReport,
} from '../src/reality-grounding.js';

_initTestDatabase();

function surface(
  proofState: 'live_proven' | 'near_live_only' | 'externally_blocked',
  blockerOwner: 'none' | 'repo_side' | 'external',
  nextAction: string,
  blocker = '',
) {
  return {
    proofState,
    blocker,
    blockerOwner,
    nextAction,
    detail: `${proofState} detail`,
  };
}

const proofReport = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: { TELEGRAM_USER_API_ID: '', TELEGRAM_USER_API_HASH: '' },
  truth: {
    telegram: surface(
      'externally_blocked',
      'external',
      'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH.',
      'Missing Telegram user-session credentials.',
    ),
    journeys: {
      ordinary_chat: surface('near_live_only', 'none', 'Send hi in Telegram.'),
    },
    alexa: {
      ...surface(
        'near_live_only',
        'external',
        'Use Alexa simulator/device for a signed IntentRequest.',
      ),
      lastHandledProofAt: 'none',
      lastSignedRequestAt: 'none',
      proofFreshness: 'none',
    },
    bluebubbles: {
      ...surface(
        'near_live_only',
        'external',
        'Complete the same-thread proof.',
      ),
      messageActionProofState: 'none',
      messageActionProofAt: 'none',
      messageActionProofChatJid: 'none',
    },
    googleCalendar: surface('live_proven', 'none', 'No action needed.'),
    research: surface('live_proven', 'none', 'No action needed.'),
    imageGeneration: surface('live_proven', 'none', 'No action needed.'),
  } as any,
});

const report = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:00:00.000Z',
  requestText: 'what should you verify next?',
  proofReport,
  persist: false,
});

assert.equal(report.perceptionPlan.status, 'manual_proof_required');
assert.ok(
  report.proofClosureSteps.some((step) => step.status === 'missing_config'),
  'Telegram missing config should become proof closure setup step',
);
assert.ok(
  report.proofClosureSteps.some(
    (step) =>
      step.proofName === 'Google Calendar live write proof' &&
      step.status === 'complete',
  ),
  'live-proven proofs should persist complete closure steps to clear stale debt',
);
assert.ok(
  report.proofClosureSteps.some((step) => step.status === 'manual_action'),
  'near-live proof should become manual proof step',
);
assert.ok(
  report.perceptionProbes.every(
    (probe) =>
      probe.status !== 'completed' &&
      !/send|calendar write|restart|push/i.test(probe.command),
  ),
  'planner should not execute or propose mutating probes',
);
assert.match(formatActivePerceptionReport(report), /Manual Proof Steps/);

const liveTelegramBotReport = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:05:00.000Z',
  proofReport: buildLiveProofGauntletReport({
    now: new Date('2026-06-09T13:05:00.000Z'),
    env: { TELEGRAM_USER_API_ID: '', TELEGRAM_USER_API_HASH: '' },
    truth: {
      telegram: surface('live_proven', 'none', 'No action needed.'),
      journeys: {
        ordinary_chat: surface(
          'near_live_only',
          'none',
          'Send hi in Telegram.',
        ),
      },
      alexa: {
        ...surface(
          'near_live_only',
          'external',
          'Use Alexa simulator/device for a signed IntentRequest.',
        ),
        lastHandledProofAt: 'none',
        lastSignedRequestAt: 'none',
        proofFreshness: 'none',
      },
      bluebubbles: {
        ...surface(
          'near_live_only',
          'external',
          'Complete the same-thread proof.',
        ),
        messageActionProofState: 'none',
        messageActionProofAt: 'none',
        messageActionProofChatJid: 'none',
      },
      googleCalendar: surface('live_proven', 'none', 'No action needed.'),
      research: surface('live_proven', 'none', 'No action needed.'),
      imageGeneration: surface('live_proven', 'none', 'No action needed.'),
    } as any,
  }),
  persist: false,
});
assert.ok(
  liveTelegramBotReport.proofClosureSteps.some(
    (step) =>
      step.proofName === 'Telegram bot proof' && step.status === 'complete',
  ),
  'Telegram bot proof should close when truth.telegram is live-proven',
);
assert.ok(
  liveTelegramBotReport.proofClosureSteps.some(
    (step) =>
      step.proofName === 'Telegram user-session proof' &&
      step.status === 'missing_config',
  ),
  'Telegram user-session setup remains separate from live bot proof',
);

console.log('active perception tests passed');
