import assert from 'node:assert/strict';

import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import { buildWorldModelReport } from '../src/world-model.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

_initTestDatabase();

const checkedAt = '2026-06-06T23:20:00.000Z';
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
      integrationId: 'research',
      label: 'Research',
      state: 'degraded_but_usable',
      credentialState: 'configured',
      transportState: 'degraded',
      proofState: 'degraded_but_usable',
      lastHealthyAt: checkedAt,
      lastFailure: 'Recent proof is stale.',
      blockerOwner: 'repo_side',
      nextAction: 'Run npm run debug:research-mode and provider diagnostics.',
      repairability: 'guided_manual',
      safeActions: ['npm run debug:research-mode'],
      detail: 'Safe read-only proof can refresh research status.',
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
      detail: 'Manual same-thread proof is required.',
    },
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
      nextAction: 'Use fresh read windows for calendar certainty.',
      repairability: 'status_only',
      safeActions: ['npm run debug:google-calendar'],
      detail: 'Calendar is healthy.',
    },
  ],
  secretsRedacted: true,
};

const report = buildWorldModelReport({
  generatedAt: checkedAt,
  providers,
  integrationReport,
  verifySafe: true,
});

assert.equal(report.safeVerificationRan, true);
assert.ok(
  report.verificationNeeds.some(
    (need) =>
      need.domain === 'research' &&
      need.status === 'runnable_read_only' &&
      need.safeToRunAutomatically,
  ),
  'research degradation should have a safe read-only verification path',
);
assert.ok(
  report.verificationNeeds.some(
    (need) =>
      need.domain === 'bluebubbles' &&
      need.status === 'manual_proof' &&
      !need.safeToRunAutomatically,
  ),
  'BlueBubbles same-thread proof should not become automatic',
);
assert.equal(
  report.verificationNeeds.some(
    (need) => need.actionKind === 'approval_stage' && need.safeToRunAutomatically,
  ),
  false,
  'approval-staged work must never be automatically runnable',
);
assert.ok(report.proofDebt.runnableReadOnly >= 1);
assert.ok(report.proofDebt.manualProof >= 1);

const serialized = JSON.stringify(report);
assert.doesNotMatch(
  serialized,
  SECRET_RE,
);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      safeVerificationRan: report.safeVerificationRan,
      runnableReadOnly: report.proofDebt.runnableReadOnly,
      manualProof: report.proofDebt.manualProof,
      nextAction: report.nextAction,
      privacy: report.privacy,
    },
    null,
    2,
  ),
);

_closeDatabase();
