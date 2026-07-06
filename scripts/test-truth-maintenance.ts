import assert from 'node:assert/strict';

import { initDatabase } from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  evaluateGoalDirectedRealityCheck,
  evaluateUserCorrectionAgainstReality,
} from '../src/reality-grounding.js';
import type { ToolReliabilityDoctorReport } from '../src/types.js';

initDatabase();

function surface(
  proofState:
    | 'live_proven'
    | 'near_live_only'
    | 'externally_blocked'
    | 'degraded_but_usable',
  blockerOwner: 'none' | 'repo_side' | 'external',
  nextAction: string,
  detail = `${proofState} detail`,
) {
  return { proofState, blocker: '', blockerOwner, nextAction, detail };
}

const proofReport = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:00:00.000Z'),
  env: {
    TELEGRAM_USER_API_ID: 'configured',
    TELEGRAM_USER_API_HASH: 'configured',
  },
  truth: {
    telegram: surface('live_proven', 'none', 'No action needed.'),
    journeys: {
      ordinary_chat: surface('live_proven', 'none', 'No action needed.'),
    },
    alexa: {
      ...surface(
        'near_live_only',
        'external',
        'Use Alexa simulator/device.',
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
        'Transport ready; same-thread proof stale.',
      ),
      messageActionProofState: 'stale',
      messageActionProofAt: '2026-06-01T00:00:00.000Z',
      messageActionProofChatJid: 'bb:iMessage;-;+14695405551',
    },
    googleCalendar: surface('live_proven', 'none', 'No action needed.'),
    research: surface('live_proven', 'none', 'No action needed.'),
    imageGeneration: surface('live_proven', 'none', 'No action needed.'),
  } as any,
});

const reliability: ToolReliabilityDoctorReport = {
  generatedAt: '2026-06-09T13:00:00.000Z',
  subjects: [],
  routeRollups: [],
  rollups: [
    {
      subjectId: 'provider:brave_search',
      updatedAt: '2026-06-09T13:00:00.000Z',
      sampleCount: 8,
      successRate: 0.25,
      degradedRate: 0,
      blockedRate: 0.75,
      fallbackRate: 0,
      reliabilityScore: 0.2,
      currentHealth: 'blocked',
      confidenceCap: 0.22,
      cooldownUntil: null,
      nextAction: 'Wait for Brave quota recovery.',
      privacyJson: '{}',
    },
  ],
  topDegraded: [],
  nextAction: 'Use local fallback.',
  privacy: {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    secretsRedacted: true,
  },
};

const report = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:00:00.000Z',
  proofReport,
  reliabilityReport: reliability,
  providerHealthSnapshots: [],
  persist: false,
});

assert.ok(
  !report.contradictions.some(
    (item) => item.contradictionKind === 'transport_vs_proof',
  ),
  'ready BlueBubbles transport plus stale same-thread proof should stay proof debt, not contradiction',
);
assert.ok(
  report.verificationNeeds.some(
    (need) =>
      /BlueBubbles/.test(need.question) &&
      /same-thread message-action proof/i.test(need.nextAction),
  ),
  'stale BlueBubbles same-thread proof should remain a verification need',
);
assert.ok(
  report.contradictions.some(
    (item) => item.contradictionKind === 'provider_vs_route',
  ),
);
assert.ok(
  report.beliefs.some(
    (belief) => /BlueBubbles/.test(belief.subject) && belief.status === 'stale',
  ),
  'stale proof should downgrade belief instead of confirming it',
);

const repairCheck = evaluateGoalDirectedRealityCheck({
  actionKind: 'repair',
  requestText: 'please repair bluebubbles',
  report,
});
assert.equal(repairCheck.allowed, false);
assert.equal(repairCheck.decision, 'block_until_verified');

const correction = evaluateUserCorrectionAgainstReality({
  subject: 'save-for-later timing preference',
  previousSummary: 'User prefers tomorrow morning.',
  correctionText: 'not mornings anymore',
});
assert.equal(correction.status, 'contradicted');
assert.match(correction.nextAction, /Downgrade/);

console.log('truth maintenance tests passed');
