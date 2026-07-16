import assert from 'node:assert/strict';

import '../src/channels/index.js';

import {
  _closeDatabase,
  _initTestDatabase,
  createTask,
  listCapabilityStates,
  listRealitySnapshots,
  upsertActivePerceptionPlan,
  upsertProofClosureStep,
  upsertToolReliabilityRollup,
} from '../src/db.js';
import { buildLiveProofGauntletReport } from '../src/live-proof-gauntlet.js';
import { buildRealityGroundingReport } from '../src/reality-grounding.js';
import {
  buildCapabilitySelfModel,
  formatCapabilityNaturalResponse,
  formatCapabilityReport,
  getDailyCoreAttentionStates,
  isCapabilityNaturalRequest,
} from '../src/capability-self-model.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import { registerProductionRuntimeCapabilitySurfaces } from '../src/runtime-capability-production-surfaces.js';
import { runtimeCapabilityRegistry } from '../src/runtime-capability-registry.js';

registerProductionRuntimeCapabilitySurfaces(runtimeCapabilityRegistry);
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

const latestSnapshot = listRealitySnapshots({ limit: 1 })[0];
assert.ok(latestSnapshot, 'expected a reality snapshot for proof step fixture');
upsertActivePerceptionPlan({
  planId: 'test-plan',
  snapshotId: latestSnapshot.snapshotId,
  createdAt: '2026-06-09T16:00:00.000Z',
  requestSummary: 'test stale proof fixture',
  channel: 'internal',
  status: 'manual_proof_required',
  riskSummary: 'test only',
  probeIdsJson: '[]',
  skippedProbeIdsJson: '[]',
  manualStepIdsJson: '["stale-telegram-proof"]',
  nextAction: 'Send hi in Telegram.',
  privacyJson: '{}',
});
upsertProofClosureStep({
  stepId: 'stale-telegram-proof',
  planId: 'test-plan',
  proofId: 'telegram-bot',
  createdAt: '2026-06-09T16:00:00.000Z',
  proofName: 'Telegram bot proof',
  status: 'manual_action',
  blockerClass: 'manual_live_proof_needed',
  exactNextStep: 'Send hi in Telegram.',
  requestedAt: '2026-06-09T16:00:00.000Z',
  evidenceIdsJson: '[]',
  privacyJson: '{}',
});
const healthyTelegramIntegration: IntegrationDoctorReport = {
  generatedAt: '2026-06-09T16:00:32.000Z',
  summary: {
    total: 1,
    healthy: 1,
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
      lastHealthyAt: '2026-06-09T16:00:32.000Z',
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: '',
      repairability: 'status_only',
      safeActions: [],
      detail: 'Telegram is healthy.',
    },
  ],
  secretsRedacted: true,
};
const staleProofHealthyTelegramReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:00:33.000Z',
  persist: false,
  env: {},
  envFileValues: {
    TELEGRAM_BOT_TOKEN: 'set',
  },
  integrationReport: healthyTelegramIntegration,
});
const staleProofTelegramSend = staleProofHealthyTelegramReport.states.find(
  (state) => state.capabilityId === 'messages.send.telegram',
);
assert.ok(staleProofTelegramSend);
assert.equal(staleProofTelegramSend.proofStatus, 'live_proven');
assert.equal(staleProofTelegramSend.currentBlocker, null);

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

buildRealityGroundingReport({
  generatedAt: '2026-06-09T16:01:30.000Z',
  persist: true,
  proofReport: buildLiveProofGauntletReport({
    now: new Date('2026-06-09T16:01:30.000Z'),
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
      googleCalendar: surface(
        'externally_blocked',
        'external',
        'Re-run Google Calendar auth.',
      ),
      research: surface('live_proven', 'none', 'No action needed.'),
      imageGeneration: surface('live_proven', 'none', 'No action needed.'),
    } as any,
  }),
});
const blockedCalendarCapabilityReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:01:31.000Z',
  persist: false,
  env: {},
  envFileValues: {
    GOOGLE_CALENDAR_CLIENT_ID: 'set',
  },
  integrationReport: {
    generatedAt: '2026-06-09T16:01:31.000Z',
    summary: {
      total: 1,
      healthy: 0,
      actionNeeded: 1,
      needsProof: 0,
      manualOrExternal: 1,
    },
    statuses: [
      {
        integrationId: 'google_calendar',
        label: 'Google Calendar',
        state: 'externally_blocked',
        credentialState: 'invalid',
        transportState: 'blocked',
        proofState: 'externally_blocked',
        lastHealthyAt: null,
        lastFailure: 'Google Calendar auth failed.',
        blockerOwner: 'external',
        nextAction: 'Re-run Google Calendar auth.',
        repairability: 'guided_manual',
        safeActions: ['Run Google Calendar auth setup.'],
        detail: 'Google Calendar auth failed.',
      },
    ],
    secretsRedacted: true,
  },
});
for (const id of ['calendar.read', 'calendar.write']) {
  const state = blockedCalendarCapabilityReport.states.find(
    (item) => item.capabilityId === id,
  );
  assert.ok(state, `missing capability ${id}`);
  assert.equal(state.proofStatus, 'externally_blocked');
  assert.equal(state.enabled, false);
  assert.ok(
    state.reliabilityScore <= 0.22,
    'externally blocked calendar capabilities must not report high reliability',
  );
  assert.match(state.currentBlocker ?? '', /Google Calendar auth/i);
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

upsertToolReliabilityRollup({
  subjectId: 'tool:message_actions',
  updatedAt: '2026-06-09T15:30:00.000Z',
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
createTask({
  id: 'task-reminder-proof',
  group_folder: 'main',
  chat_jid: 'tg:main',
  prompt: 'Send a concise reminder telling the user to check the oven.',
  script: null,
  schedule_type: 'once',
  schedule_value: '2026-06-09T18:00:00.000Z',
  context_mode: 'isolated',
  next_run: '2026-06-09T18:00:00.000Z',
  status: 'active',
  created_at: '2026-06-09T16:02:30.000Z',
});
const reminderEvidenceReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:02:45.000Z',
  persist: false,
  env: {},
  envFileValues: {},
});
const reminders = reminderEvidenceReport.states.find(
  (item) => item.capabilityId === 'reminders.internal',
);
assert.ok(reminders);
assert.equal(reminders.proofStatus, 'live_proven');
assert.equal(reminders.currentBlocker, null);

const coreReadyOptionalVoiceReport = buildCapabilitySelfModel({
  now: '2026-06-09T16:03:00.000Z',
  persist: false,
  env: {},
  envFileValues: {
    TELEGRAM_BOT_TOKEN: 'set',
    BLUEBUBBLES_BASE_URL: 'set',
    GOOGLE_CALENDAR_CLIENT_ID: 'set',
    BRAVE_SEARCH_API_KEY: 'set',
    ALEXA_SKILL_ID: 'set',
  },
  providerHealthSnapshots: [
    {
      providerId: 'brave_search',
      kind: 'search',
      state: 'healthy',
      lastHealthyAt: '2026-06-09T16:03:00.000Z',
      lastCheckedAt: '2026-06-09T16:03:00.000Z',
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
  integrationReport: {
    generatedAt: '2026-06-09T16:03:00.000Z',
    summary: {
      total: 4,
      healthy: 3,
      actionNeeded: 1,
      needsProof: 0,
      manualOrExternal: 1,
    },
    statuses: [
      {
        integrationId: 'telegram',
        label: 'Telegram',
        state: 'healthy',
        credentialState: 'configured',
        transportState: 'healthy',
        proofState: 'healthy',
        lastHealthyAt: '2026-06-09T16:03:00.000Z',
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
        lastHealthyAt: '2026-06-09T16:03:00.000Z',
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
        lastHealthyAt: '2026-06-09T16:03:00.000Z',
        lastFailure: '',
        blockerOwner: 'none',
        nextAction: '',
        repairability: 'status_only',
        safeActions: [],
        detail: 'Google Calendar is healthy.',
      },
      {
        integrationId: 'alexa',
        label: 'Alexa',
        state: 'manual_action_required',
        credentialState: 'configured',
        transportState: 'healthy',
        proofState: 'near_live_only',
        lastHealthyAt: null,
        lastFailure: '',
        blockerOwner: 'external',
        nextAction: 'Use a real device or authenticated simulator.',
        repairability: 'guided_manual',
        safeActions: [],
        detail: 'Alexa needs a fresh signed IntentRequest.',
      },
    ],
    secretsRedacted: true,
  },
});
assert.equal(
  getDailyCoreAttentionStates(coreReadyOptionalVoiceReport).length,
  0,
);
assert.equal(coreReadyOptionalVoiceReport.dailyCore.needsAttention, 0);
assert.equal(coreReadyOptionalVoiceReport.optionalSurfaces.needsAttention, 1);
assert.match(
  formatCapabilityReport(coreReadyOptionalVoiceReport),
  /Daily core: \d+\/\d+ ready \(0 need attention\)/,
);
assert.match(formatCapabilityReport(coreReadyOptionalVoiceReport), /OPTIONAL/);

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
