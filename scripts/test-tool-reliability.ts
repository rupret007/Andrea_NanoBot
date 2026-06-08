import assert from 'assert/strict';

import { initDatabase } from '../src/db.js';
import {
  buildToolReliabilityDoctorReport,
  refreshToolReliabilityFromCurrentTruth,
  scoreRouteCandidate,
} from '../src/tool-reliability.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

const now = new Date(Date.now() + 60_000);

const provider: ProviderHealthSnapshot = {
  providerId: 'brave_search',
  kind: 'search',
  state: 'externally_blocked',
  lastHealthyAt: null,
  lastCheckedAt: now.toISOString(),
  failureClass: 'quota_or_rate_limit',
  quotaState: 'blocked',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: 'quota blocked',
  nextAction: 'Wait for Brave quota recovery.',
  metadata: {},
};

const integrationReport: IntegrationDoctorReport = {
  generatedAt: now.toISOString(),
  summary: {
    total: 1,
    healthy: 0,
    actionNeeded: 1,
    needsProof: 0,
    manualOrExternal: 1,
  },
  statuses: [
    {
      integrationId: 'bluebubbles',
      label: 'BlueBubbles',
      state: 'needs_proof',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'needs_proof',
      lastHealthyAt: null,
      lastFailure: 'same-thread proof missing',
      blockerOwner: 'manual',
      nextAction: 'Complete same-thread proof.',
      repairability: 'proof_drill',
      safeActions: ['Run debug:bluebubbles'],
      detail: 'Transport works; proof is stale.',
    },
  ],
  secretsRedacted: true,
};

async function main(): Promise<void> {
  initDatabase();
  const report = await refreshToolReliabilityFromCurrentTruth({
    now,
    providers: [provider],
    integrationReport,
  });
  assert.equal(report.privacy.metadataOnly, true);
  const doctor = buildToolReliabilityDoctorReport(now);
  assert.ok(doctor.subjects.some((item) => item.subjectId === 'provider:brave_search'));
  const braveRollup = doctor.rollups.find(
    (item) => item.subjectId === 'provider:brave_search',
  );
  assert.equal(braveRollup?.currentHealth, 'blocked');
  const scored = scoreRouteCandidate({
    routeKey: 'cognitive_executive.research',
    baseConfidence: 0.9,
  });
  assert.ok(scored.confidence <= 0.58, `expected capped confidence, got ${scored.confidence}`);
  assert.ok(scored.reasons.join(' ').includes('provider:brave_search'));
  console.log('tool reliability tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
