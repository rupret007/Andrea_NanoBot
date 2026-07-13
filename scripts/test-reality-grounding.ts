import assert from 'node:assert/strict';

import { _initTestDatabase } from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import {
  buildRealityGroundingReport,
  evaluateGoalDirectedRealityCheck,
  formatRealityNaturalResponse,
} from '../src/reality-grounding.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';
import type { ToolReliabilityDoctorReport } from '../src/types.js';

_initTestDatabase();

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
      subjectId: 'integration:google_calendar',
      updatedAt: '2026-06-09T13:00:00.000Z',
      sampleCount: 6,
      successRate: 1,
      degradedRate: 0,
      blockedRate: 0,
      fallbackRate: 0,
      reliabilityScore: 0.95,
      currentHealth: 'healthy',
      confidenceCap: 0.95,
      cooldownUntil: null,
      nextAction: 'No action needed.',
      privacyJson: '{}',
    },
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
  degradedSubjectCount: 1,
  healthCounts: { healthy: 1, degraded: 0, blocked: 1, unknown: 0 },
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
  providerHealthSnapshots: [],
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
  !report.contradictions.some(
    (item) => item.contradictionKind === 'transport_vs_proof',
  ),
  'ready BlueBubbles transport plus stale proof should be proof debt, not a contradiction',
);
assert.ok(
  report.verificationNeeds.some(
    (need) =>
      /BlueBubbles/.test(need.question) &&
      /same-thread message-action proof/i.test(need.nextAction),
  ),
  'BlueBubbles same-thread proof gap should remain visible as a verification need',
);
assert.ok(
  report.contradictions.some(
    (item) => item.contradictionKind === 'provider_vs_route',
  ),
  'blocked Brave should prevent fake provider participation',
);
assert.equal(report.proofDebt.repoWorkRequired, 0);
assert.doesNotMatch(
  JSON.stringify(report),
  /sk-proj-|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

const healthyBraveProvider: ProviderHealthSnapshot = {
  providerId: 'brave_search',
  kind: 'search',
  state: 'healthy',
  lastHealthyAt: '2026-06-09T13:02:00.000Z',
  lastCheckedAt: '2026-06-09T13:02:00.000Z',
  failureClass: 'none',
  quotaState: 'unknown',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: '',
  nextAction: '',
  metadata: {},
};
const freshProviderReport = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:02:00.000Z',
  proofReport,
  reliabilityReport: fakeReliability,
  providerHealthSnapshots: [healthyBraveProvider],
  requestText: 'what is true right now?',
  persist: false,
});
assert.ok(
  freshProviderReport.beliefs.some(
    (belief) =>
      belief.subject === 'provider:brave_search' &&
      belief.status === 'confirmed',
  ),
  'fresh healthy provider truth should override stale blocked rollup',
);
assert.ok(
  !freshProviderReport.contradictions.some(
    (item) =>
      item.subject === 'provider:brave_search' &&
      item.contradictionKind === 'provider_vs_route',
  ),
  'fresh healthy Brave provider truth should not report stale provider contradiction',
);

const optionalAlexaOnlyTruth = {
  ...fakeTruth,
  telegram: surface('live_proven', 'none', 'No action needed.'),
  journeys: {
    ordinary_chat: surface('live_proven', 'none', 'No action needed.'),
  },
  bluebubbles: {
    ...surface('live_proven', 'none', 'No action needed.'),
    messageActionProofState: 'fresh',
    messageActionProofAt: '2026-06-09T13:01:00.000Z',
    messageActionProofChatJid: 'proof:bluebubbles',
  },
};
const optionalAlexaOnlyProof = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:03:00.000Z'),
  env: {
    TELEGRAM_USER_API_ID: 'configured',
    TELEGRAM_USER_API_HASH: 'configured',
  },
  truth: optionalAlexaOnlyTruth,
});
const optionalAlexaOnlyReport = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:03:00.000Z',
  proofReport: optionalAlexaOnlyProof,
  reliabilityReport: {
    ...fakeReliability,
    rollups: [],
    nextAction: 'No action needed.',
  },
  providerHealthSnapshots: [],
  requestText: 'what is true right now?',
  persist: false,
});
assert.notEqual(
  optionalAlexaOnlyReport.snapshot.status,
  'externally_blocked',
  'optional Alexa proof debt should not make daily-core reality externally blocked',
);
assert.ok(
  optionalAlexaOnlyReport.verificationNeeds.some((need) =>
    /Alexa signed IntentRequest proof/.test(need.question),
  ),
  'optional Alexa proof debt should remain visible as a verification need',
);

const blockedCalendarTruth = {
  ...fakeTruth,
  googleCalendar: surface(
    'externally_blocked',
    'external',
    'Re-run the Google Calendar auth setup.',
    'Google Calendar token refresh failed.',
    'Google token refresh 400: invalid_grant',
  ),
};
const blockedCalendarProof = buildLiveProofGauntletReport({
  now: new Date('2026-06-09T13:04:00.000Z'),
  env: { TELEGRAM_USER_API_ID: '', TELEGRAM_USER_API_HASH: '' },
  truth: blockedCalendarTruth,
});
const blockedCalendarReport = buildRealityGroundingReport({
  generatedAt: '2026-06-09T13:04:00.000Z',
  proofReport: blockedCalendarProof,
  reliabilityReport: fakeReliability,
  providerHealthSnapshots: [],
  requestText: 'what is true right now?',
  persist: false,
});
assert.ok(
  blockedCalendarReport.beliefs.some(
    (belief) =>
      belief.subject === 'integration:google_calendar' &&
      belief.status === 'externally_blocked' &&
      /proof is blocked/.test(belief.beliefSummary),
  ),
  'fresh proof gauntlet calendar blocker should override stale healthy reliability',
);
assert.ok(
  !blockedCalendarReport.beliefs.some(
    (belief) =>
      belief.subject === 'integration:google_calendar' &&
      belief.status === 'confirmed',
  ),
  'blocked calendar proof must not leave a confirmed calendar reliability belief',
);

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
assert.doesNotMatch(
  natural,
  /hidden reasoning|raw tool output|provider debate/i,
);

console.log('reality grounding tests passed');
