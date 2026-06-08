import assert from 'node:assert/strict';

import { beginAgentOSEpisode, buildAgentOSReport } from '../src/agent-os.js';
import {
  _closeDatabase,
  _initTestDatabase,
  listWorldModelClaims,
  listWorldModelEvidenceRefs,
  listWorldModelSnapshots,
  listWorldModelVerificationNeeds,
} from '../src/db.js';
import { beginLogicKernelRun } from '../src/logic-kernel.js';
import { runTruthEngine } from '../src/truth-engine.js';
import { buildWorldModelReport } from '../src/world-model.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T23:10:00.000Z';
const suffix = Date.now().toString(36);
const SECRET_RE =
  /\bsk-(?:proj-|api-|ant-api03-)?[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{20,}|Bearer\s+|raw private body text|raw message body text|chain-of-thought/i;

const providers: ProviderHealthSnapshot[] = [
  {
    providerId: 'openai_cloud',
    kind: 'llm',
    state: 'healthy',
    lastHealthyAt: checkedAt,
    lastCheckedAt: checkedAt,
    failureClass: 'none',
    quotaState: 'ok',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: '',
    nextAction: '',
    metadata: {},
  },
  {
    providerId: 'gemini_cloud',
    kind: 'llm',
    state: 'externally_blocked',
    lastHealthyAt: null,
    lastCheckedAt: checkedAt,
    failureClass: 'quota_or_rate_limit',
    quotaState: 'blocked',
    credentialState: 'configured',
    knownExpiresAt: null,
    rotationDueAt: null,
    blocker: 'Quota is blocked.',
    nextAction: 'Wait for quota recovery, then rerun provider checks.',
    metadata: {},
  },
];

const integrationReport: IntegrationDoctorReport = {
  generatedAt: checkedAt,
  summary: {
    total: 3,
    healthy: 1,
    actionNeeded: 1,
    needsProof: 1,
    manualOrExternal: 0,
  },
  statuses: [
    {
      integrationId: 'google_calendar',
      label: 'Google Calendar',
      state: 'healthy',
      credentialState: 'healthy',
      transportState: 'healthy',
      proofState: 'healthy',
      lastHealthyAt: checkedAt,
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: 'Use fresh calendar read windows before high-certainty answers.',
      repairability: 'status_only',
      safeActions: ['npm run debug:google-calendar'],
      detail: 'Validated calendar read proof.',
    },
    {
      integrationId: 'bluebubbles',
      label: 'BlueBubbles',
      state: 'needs_proof',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'needs_proof',
      lastHealthyAt: null,
      lastFailure: 'Same-thread proof is missing.',
      blockerOwner: 'manual',
      nextAction: 'Complete the same-thread Messages proof.',
      repairability: 'proof_drill',
      safeActions: ['npm run debug:bluebubbles -- --live'],
      detail: 'Transport is ready, proof debt remains.',
    },
    {
      integrationId: 'alexa',
      label: 'Alexa',
      state: 'needs_proof',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'needs_proof',
      lastHealthyAt: null,
      lastFailure: 'Signed IntentRequest proof is missing.',
      blockerOwner: 'manual',
      nextAction: 'Run one signed Alexa invocation.',
      repairability: 'proof_drill',
      safeActions: ['npm run debug:alexa-conversation -- --review'],
      detail: 'Public endpoint is reachable, live invocation proof is missing.',
    },
  ],
  secretsRedacted: true,
};

const episode = beginAgentOSEpisode({
  turnId: `world-core-${suffix}`,
  channel: 'telegram',
  groupFolder: 'main',
  taskFamily: 'research',
  goal: 'Compose world model evidence from current safe metadata.',
  requestRoute: 'test:world',
  selectedSkillId: 'world.compose',
  selectedSkillPurpose: 'Exercise world model snapshot composition.',
  selectedSkillApprovalNeed: 'none',
  selectedSkillSideEffectRisk: 'low',
  selectedSkillEvidenceLevel: 'strong',
  providerHealthSnapshots: providers,
});
const agentOSReport = buildAgentOSReport({ episodeId: episode.episode.episodeId });
const logic = beginLogicKernelRun({
  subject: 'world model test subject',
  agentOSReport,
  generatedAt: checkedAt,
});
const truth = runTruthEngine({
  text: `${logic.report.claims[0].predicate}: ${logic.report.claims[0].objectSummary}.`,
  subject: logic.report.subject,
  logicReport: logic.report,
  agentOSReport,
  generatedAt: checkedAt,
});

const report = buildWorldModelReport({
  generatedAt: checkedAt,
  providers,
  integrationReport,
  agentOSReport,
  logicReport: logic.report,
  truthReport: {
    generatedAt: checkedAt,
    ok: truth.calibration.status !== 'block',
    latestAudit: truth.audit,
    claims: truth.claims,
    evidenceSupports: truth.evidenceSupports,
    contradictionChecks: truth.contradictionChecks,
    rewriteDirectives: truth.rewriteDirectives,
    sourceCoverage: [truth.sourceCoverage],
    nextAction: truth.bestNextAction,
    privacy: truth.privacy,
  },
});

const storedSnapshots = listWorldModelSnapshots({ limit: 5 });
const storedClaims = listWorldModelClaims({
  snapshotId: report.snapshot.snapshotId,
  limit: 200,
});
const storedEvidence = listWorldModelEvidenceRefs({
  snapshotId: report.snapshot.snapshotId,
  limit: 200,
});
const storedNeeds = listWorldModelVerificationNeeds({
  snapshotId: report.snapshot.snapshotId,
  limit: 200,
});

assert.ok(storedSnapshots.some((item) => item.snapshotId === report.snapshot.snapshotId));
assert.ok(report.evidenceRefs.length >= 6, 'world model should compose multiple evidence classes');
assert.ok(report.claims.some((claim) => claim.domain === 'providers'));
assert.ok(report.claims.some((claim) => claim.domain === 'bluebubbles'));
assert.ok(report.claims.some((claim) => claim.domain === 'logic'));
assert.ok(
  report.verificationNeeds.some(
    (need) => need.domain === 'bluebubbles' && need.status === 'manual_proof',
  ),
  'BlueBubbles proof debt should be manual proof',
);
assert.ok(
  report.verificationNeeds.some(
    (need) => need.domain === 'providers' && need.status === 'manual_proof',
  ),
  'quota-blocked provider should stay manual/external',
);
assert.equal(report.privacy.rawPromptsStored, false);
assert.equal(report.privacy.rawPrivateBodiesStored, false);
assert.equal(report.privacy.hiddenReasoningStored, false);
assert.ok(storedClaims.length >= report.claims.length);
assert.ok(storedEvidence.length >= report.evidenceRefs.length);
assert.ok(storedNeeds.length >= report.verificationNeeds.length);

const serialized = JSON.stringify({ report, storedSnapshots, storedClaims, storedEvidence, storedNeeds });
assert.doesNotMatch(
  serialized,
  SECRET_RE,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      snapshotId: report.snapshot.snapshotId,
      worldStatus: report.snapshot.status,
      confidence: report.snapshot.confidence,
      claims: report.claims.length,
      evidenceRefs: report.evidenceRefs.length,
      verificationNeeds: report.verificationNeeds.length,
      proofDebt: report.proofDebt,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
