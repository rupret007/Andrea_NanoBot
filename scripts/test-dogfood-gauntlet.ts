import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import {
  formatDogfoodGauntletReport,
  runDogfoodGauntlet,
} from '../src/dogfood-gauntlet.js';
import type { LiveProofGauntletReport, RealityDoctorReport } from '../src/types.js';

_initTestDatabase();

const generatedAt = '2026-06-10T15:30:00.000Z';
const proofReport: LiveProofGauntletReport = {
  generatedAt,
  entries: [
    {
      proofId: 'proof:telegram_user_session',
      proofName: 'Telegram user-session proof',
      status: 'missing_config',
      lastProofAt: 'none',
      nextStep:
        'Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH, then run npm run telegram:user:smoke.',
      repoWorkRequired: false,
      blockerOwner: 'external',
      evidenceIdsJson: JSON.stringify(['proof:telegram_user_session']),
      detail: 'Missing config by key name only.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:telegram_bot',
      proofName: 'Telegram bot proof',
      status: 'near_live_only',
      lastProofAt: 'none',
      nextStep: "Send `hi` or `what's up` in Telegram on this host.",
      repoWorkRequired: false,
      blockerOwner: 'none',
      evidenceIdsJson: JSON.stringify(['journey:ordinary_chat']),
      detail: 'Needs a fresh Telegram turn.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:alexa_signed_intentrequest',
      proofName: 'Alexa signed IntentRequest proof',
      status: 'externally_blocked',
      lastProofAt: 'none',
      nextStep:
        'Use a real device or authenticated Alexa Developer Console simulator.',
      repoWorkRequired: false,
      blockerOwner: 'external',
      evidenceIdsJson: JSON.stringify(['proof:alexa']),
      detail: 'Manual live proof needed.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:bluebubbles_same_thread',
      proofName: 'BlueBubbles same-thread message-action proof',
      status: 'near_live_only',
      lastProofAt: 'none',
      nextStep:
        'Ask reply-help in the canonical self-thread, then use send it later tonight.',
      repoWorkRequired: false,
      blockerOwner: 'repo_side',
      evidenceIdsJson: JSON.stringify(['proof:bluebubbles_same_thread']),
      detail: 'Transport ready; message-action proof missing.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:google_calendar',
      proofName: 'Google Calendar live write proof',
      status: 'live_proven',
      lastProofAt: generatedAt,
      nextStep: 'No action needed.',
      repoWorkRequired: false,
      blockerOwner: 'none',
      evidenceIdsJson: JSON.stringify(['proof:google_calendar']),
      detail: 'Live proven.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:research',
      proofName: 'Research/provider proof',
      status: 'live_proven',
      lastProofAt: generatedAt,
      nextStep: 'No action needed.',
      repoWorkRequired: false,
      blockerOwner: 'none',
      evidenceIdsJson: JSON.stringify(['proof:research']),
      detail: 'Live proven.',
      privacyJson: '{}',
    },
    {
      proofId: 'proof:image_generation',
      proofName: 'Image generation proof',
      status: 'live_proven',
      lastProofAt: generatedAt,
      nextStep: 'No action needed.',
      repoWorkRequired: false,
      blockerOwner: 'none',
      evidenceIdsJson: JSON.stringify(['proof:image_generation']),
      detail: 'Live proven.',
      privacyJson: '{}',
    },
  ],
  liveProvenCount: 3,
  proofDebtCount: 4,
  repoWorkRequiredCount: 0,
  nextAction:
    'Telegram user-session proof: Set TELEGRAM_USER_API_ID and TELEGRAM_USER_API_HASH, then run npm run telegram:user:smoke.',
  privacyJson: '{}',
};

const realityReport = {
  generatedAt,
  ok: false,
  snapshot: {
    snapshotId: 'snapshot:test',
    createdAt: generatedAt,
    updatedAt: generatedAt,
    status: 'conflicted',
    confidence: 0.46,
    observationIdsJson: '[]',
    beliefIdsJson: '[]',
    contradictionIdsJson: '[]',
    verificationNeedIdsJson: '[]',
    recommendedProbeIdsJson: '[]',
    trueNowSummary:
      'Google Calendar, Research/provider, Image generation, and provider:brave_search are healthy.',
    staleSummary: '4 proof item(s) need closure; repo work required=0.',
    contradictionSummary:
      'BlueBubbles transport appears available, but same-thread message-action proof is not fresh.',
    missingProofSummary: 'proof debt=4',
    degradedToolsSummary: 'integration:alexa externally blocked',
    confidenceSummary: 'medium-low confidence because proof debt remains.',
    nextAction: proofReport.nextAction,
    privacyJson: '{}',
  },
  observations: [],
  beliefs: [
    {
      beliefId: 'belief:brave',
      snapshotId: 'snapshot:test',
      createdAt: generatedAt,
      updatedAt: generatedAt,
      subject: 'provider:brave_search',
      status: 'confirmed',
      beliefType: 'tool_health',
      confidence: 0.95,
      beliefSummary:
        'provider:brave_search reliability is healthy; route confidence cap is 0.95.',
      supportingObservationIdsJson: '[]',
      contradictingObservationIdsJson: '[]',
      lastVerifiedAt: generatedAt,
      staleAfterAt: generatedAt,
      nextAction: 'No action needed.',
      privacyJson: '{}',
    },
  ],
  contradictions: [
    {
      contradictionId: 'contradiction:bluebubbles',
      snapshotId: 'snapshot:test',
      createdAt: generatedAt,
      subject: 'integration:bluebubbles',
      contradictionKind: 'transport_vs_proof',
      severity: 'medium',
      status: 'open',
      observationIdsJson: '[]',
      beliefIdsJson: '[]',
      summary:
        'BlueBubbles transport appears available, but same-thread message-action proof is not fresh.',
      nextAction: proofReport.entries[3].nextStep,
      privacyJson: '{}',
    },
  ],
  verificationNeeds: [],
  perceptionPlan: {
    planId: 'perception:test',
    snapshotId: 'snapshot:test',
    createdAt: generatedAt,
    requestSummary: 'dogfood live gauntlet',
    channel: 'operator',
    status: 'manual_proof_required',
    riskSummary: 'manual proof needed',
    probeIdsJson: '[]',
    skippedProbeIdsJson: '[]',
    manualStepIdsJson: '[]',
    nextAction: proofReport.nextAction,
    privacyJson: '{}',
  },
  perceptionProbes: [],
  proofClosureSteps: [],
  proofDebt: {
    total: 4,
    missingConfig: 1,
    manualProof: 2,
    externallyBlocked: 1,
    repoWorkRequired: 0,
  },
  nextAction: proofReport.nextAction,
  privacy: {
    metadataOnly: true,
    rawPromptsStored: false,
    rawPrivateBodiesStored: false,
    hiddenReasoningStored: false,
    rawToolOutputStored: false,
    providerDebatesStored: false,
    secretsRedacted: true,
  },
} satisfies RealityDoctorReport;

const report = runDogfoodGauntlet({
  now: generatedAt,
  persist: false,
  proofReport,
  realityReport,
});

assert.equal(report.scenarioCount, 10);
assert.equal(report.scenarios.length, 10);
assert.equal(report.consistency.braveSearchHealthy, true);
assert.equal(report.consistency.telegramUserSessionMissingConfig, true);
assert.equal(report.consistency.alexaSignedProofPending, true);
assert.equal(
  report.consistency.blueBubblesTransportReadyButSameThreadProofIncomplete,
  true,
);
assert.equal(report.consistency.repoWorkRequiredZero, true);
assert.equal(report.repoBug, 0);
assert.ok(report.averageScore > 0.7);

const texting = report.scenarios.find(
  (scenario) => scenario.scenarioId === 'texting_status',
);
assert.equal(texting?.status, 'missing_config');
assert.match(texting?.nextAction || '', /TELEGRAM_USER_API_ID/);

const sayBack = report.scenarios.find(
  (scenario) => scenario.scenarioId === 'say_back',
);
assert.equal(sayBack?.status, 'manual_proof_needed');
assert.match(sayBack?.summary || '', /Draft\/reply-help is safe/);

const calendar = report.scenarios.find(
  (scenario) => scenario.scenarioId === 'calendar_missing_time',
);
assert.match(calendar?.nextAction || '', /event time|referent|clarification/i);

const formatted = formatDogfoodGauntletReport(report);
assert.match(formatted, /Live Dogfood Gauntlet/);
const formattedWithoutPrivacyLine = formatted.replace(/^Privacy:.*$/m, '');
assert.doesNotMatch(
  formattedWithoutPrivacyLine,
  /sk-[A-Za-z0-9_-]{12,}|raw private body|hidden reasoning|provider debate|raw tool output/i,
);

_closeDatabase();
console.log('dogfood gauntlet tests passed');
