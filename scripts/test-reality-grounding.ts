import assert from 'node:assert/strict';

import { initDatabase } from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  evaluateGoalDirectedRealityCheck,
  formatRealityNaturalResponse,
} from '../src/reality-grounding.js';
import type { ToolReliabilityDoctorReport } from '../src/types.js';

initDatabase();

function surface(
  proofState:
    | 'live_proven'
    | 'near_live_only'
    | 'externally_blocked'
    | 'degraded_but_usable'
    | 'not_intended_for_trial',
  blockerOwner: 'none' | 'repo_side' | 'external',
  nextAction: string,
  blocker = '',
  detail = `${proofState} detail`,
) {
  return { proofState, blocker, blockerOwner, nextAction, detail };
}

const fakeTruth: any = {
  telegram: surface(
    'externally_blocked',
    'external',
    'Configure Telegram user-session credentials.',
    'Telegram user-session credentials are missing.',
  ),
  journeys: {
    ordinary_chat: surface('near_live_only', 'none', 'Send hi in Telegram.'),
  },
  alexa: {
    ...surface(
      'near_live_only',
      'external',
      'Use Alexa app/device for a signed IntentRequest.',
      'No handled signed Alexa IntentRequest is recorded.',
    ),
    lastHandledProofAt: 'none',
    lastSignedRequestAt: 'none',
    proofFreshness: 'none',
  },
  bluebubbles: {
    ...surface(
      'degraded_but_usable',
      'external',
      'Complete same-thread message-action proof.',
      'Same-thread message-action proof missing.',
      'BlueBubbles transport is ready but same-thread message-action proof is missing.',
    ),
    messageActionProofState: 'none',
    messageActionProofAt: 'none',
    messageActionProofChatJid: 'none',
  },
  googleCalendar: surface('live_proven', 'none', 'No action needed.'),
  research: surface('live_proven', 'none', 'No action needed.'),
  imageGeneration: surface('live_proven', 'none', 'No action needed.'),
};

const fakeReliability: ToolReliabilityDoctorReport = {
  generatedAt: '2026-06-09T13:00:00.000Z',
  subjects: [],
  routeRollups: [],
  rollups: [
    {
      subjectId: 'provider:brave_search',
      updatedAt: '2026-06-09T13:00:00.000Z',
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
    },
  ],
  topDegraded: [],
  nextAction: 'Use local knowledge while Brave is blocked.',
  privacy: {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  },
};

const proofReport = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: { TELEGRAM_USER_API_ID: '', TELEGRAM_USER_API_HASH: '' },
  truth: fakeTruth,
});
const report = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:00:00.000Z',
  proofReport,
  reliabilityReport: fakeReliability,
  requestText: 'what is true right now?',
  persist: false,
});

assert.ok(
  report.beliefs.some(
    (belief) =>
      /Telegram user-session/.test(belief.subject) &&
      belief.status === 'externally_blocked',
  ),
  'missing Telegram user-session config should be externally blocked reality',
);
assert.ok(
  report.contradictions.some(
    (item) => item.contradictionKind === 'transport_vs_proof',
  ),
  'ready BlueBubbles transport plus stale proof should create contradiction',
);
assert.ok(
  report.contradictions.some(
    (item) => item.contradictionKind === 'provider_vs_route',
  ),
  'blocked Brave should prevent fake provider participation',
);
assert.equal(report.proofDebt.repoWorkRequired, 0);
assert.doesNotMatch(JSON.stringify(report), /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output/i);

const calendarCheck = evaluateGoalDirectedRealityCheck({
  actionKind: 'calendar_write',
  requestText: 'add that to my calendar tomorrow',
  report,
});
assert.equal(calendarCheck.allowed, false);
assert.equal(calendarCheck.decision, 'ask_clarification');

const messageCheck = evaluateGoalDirectedRealityCheck({
  actionKind: 'message_action',
  requestText: 'send it',
  report,
});
assert.equal(messageCheck.allowed, false);
assert.equal(messageCheck.decision, 'offer_safe_alternative');

const natural = formatRealityNaturalResponse('is text messaging working?');
assert.match(natural, /partly ready|not fully proven|Messages/i);
assert.doesNotMatch(natural, /hidden reasoning|raw tool output|provider debate/i);

console.log('reality grounding tests passed');
