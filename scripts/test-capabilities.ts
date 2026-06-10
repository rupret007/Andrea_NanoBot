import assert from 'node:assert/strict';

import {
  _closeDatabase,
  _initTestDatabase,
  listCapabilityStates,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import { buildRealityGroundingReport } from '../src/reality-grounding.js';
import {
  buildCapabilitySelfModel,
  formatCapabilityNaturalResponse,
  formatCapabilityReport,
  isCapabilityNaturalRequest,
} from '../src/capability-self-model.js';

_initTestDatabase();

const report = buildCapabilitySelfModel({
  now: '2026-06-09T16:00:00.000Z',
  env: {},
  envFileValues: {},
});
assert.ok(report.states.length >= 8);

// Internal capabilities are proven by construction.
const draft = report.states.find(
  (state) => state.capabilityId === 'messages.draft',
);
assert.ok(draft);
assert.equal(draft.proofStatus, 'live_proven');
assert.equal(draft.approvalRequirement, 'none');

// Missing config is classified as external/config debt — never repo failure.
const userSession = report.states.find(
  (state) => state.capabilityId === 'telegram.user_session',
);
assert.ok(userSession);
if (!process.env.TELEGRAM_USER_API_ID || !process.env.TELEGRAM_USER_API_HASH) {
  assert.equal(userSession.proofStatus, 'missing_config');
  assert.match(userSession.currentBlocker ?? '', /external\/config debt/);
  assert.equal(userSession.enabled, false);
}

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

buildRealityGroundingReport({
  generatedAt: '2026-06-09T16:00:30.000Z',
  persist: true,
  proofReport: buildLiveProofGauntletReport({
    now: new Date('2026-06-09T16:00:30.000Z'),
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
});
const liveTelegramCapabilityReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:00:31.000Z',
  persist: false,
  env: {},
  envFileValues: {
    TELEGRAM_BOT_TOKEN: 'set',
  },
});
const telegramSend = liveTelegramCapabilityReport.states.find(
  (state) => state.capabilityId === 'messages.send.telegram',
);
const telegramUserSession = liveTelegramCapabilityReport.states.find(
  (state) => state.capabilityId === 'telegram.user_session',
);
assert.ok(telegramSend);
assert.equal(telegramSend.proofStatus, 'live_proven');
assert.equal(telegramSend.currentBlocker, null);
assert.ok(telegramSend.reliabilityScore >= 0.9);
assert.ok(telegramUserSession);
assert.equal(telegramUserSession.proofStatus, 'missing_config');

const fileBackedConfigReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:01:00.000Z',
  persist: false,
  env: {},
  envFileValues: {
    BLUEBUBBLES_BASE_URL: 'set',
    GOOGLE_CALENDAR_CLIENT_ID: 'set',
    BRAVE_SEARCH_API_KEY: 'set',
  },
});
for (const id of [
  'messages.send.bluebubbles',
  'calendar.read',
  'calendar.write',
  'research.web',
]) {
  const state = fileBackedConfigReport.states.find(
    (item) => item.capabilityId === id,
  );
  assert.ok(state, `missing capability ${id}`);
  assert.notEqual(state.proofStatus, 'missing_config');
  assert.doesNotMatch(state.currentBlocker ?? '', /Missing config/);
}

upsertToolReliabilityRollup({
  subjectId: 'provider:brave_search',
  updatedAt: '2026-06-09T15:00:00.000Z',
  sampleCount: 3,
  successRate: 0,
  degradedRate: 0,
  blockedRate: 1,
  fallbackRate: 0,
  reliabilityScore: 0.17,
  currentHealth: 'blocked',
  confidenceCap: 0.22,
  cooldownUntil: null,
  nextAction: 'Wait for Brave quota recovery.',
  privacyJson: '{}',
});
const freshProviderReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:02:00.000Z',
  persist: false,
  env: {},
  envFileValues: {
    BRAVE_SEARCH_API_KEY: 'set',
  },
  providerHealthSnapshots: [
    {
      providerId: 'brave_search',
      kind: 'search',
      state: 'healthy',
      lastHealthyAt: '2026-06-09T16:02:00.000Z',
      lastCheckedAt: '2026-06-09T16:02:00.000Z',
      failureClass: 'none',
      quotaState: 'unknown',
      credentialState: 'configured',
      knownExpiresAt: null,
      rotationDueAt: null,
      blocker: '',
      nextAction: '',
      metadata: {},
    },
  ],
});
const research = freshProviderReport.states.find(
  (item) => item.capabilityId === 'research.web',
);
assert.ok(research);
assert.equal(research.proofStatus, 'live_proven');
assert.equal(research.currentBlocker, null);
assert.ok(research.reliabilityScore >= 0.9);

// External sends always require explicit approval regardless of proof.
for (const id of [
  'messages.send.telegram',
  'messages.send.bluebubbles',
  'calendar.write',
]) {
  const state = report.states.find((item) => item.capabilityId === id);
  assert.ok(state, `missing capability ${id}`);
  assert.notEqual(state.approvalRequirement, 'none');
  assert.ok(state.autonomyLevel >= 5);
}

// Config is stored by name only — no values.
for (const state of report.states) {
  assert.ok(!/=/.test(state.requiredConfig));
}

// States persist and round-trip.
const stored = listCapabilityStates({ limit: 50 });
assert.ok(stored.length >= 8);

assert.match(formatCapabilityReport(report), /Capability Self-Model/);
assert.equal(
  isCapabilityNaturalRequest('what can you actually do today?'),
  true,
);
assert.equal(isCapabilityNaturalRequest('can you send texts?'), true);
assert.equal(isCapabilityNaturalRequest("why didn't you send it?"), true);

const sendAnswer = formatCapabilityNaturalResponse('can you send texts?');
assert.match(sendAnswer, /approval/i);

const brokenAnswer = formatCapabilityNaturalResponse("what's broken?");
assert.ok(brokenAnswer.length > 0);

_closeDatabase();
console.log('capability self-model tests passed');
