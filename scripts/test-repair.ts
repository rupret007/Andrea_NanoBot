import assert from 'assert/strict';

import { initDatabase } from '../src/db.js';
import {
  buildRepairDoctorReport,
  runIntegrationRepair,
} from '../src/integration-healer.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';
import type { ProviderHealthSnapshot } from '../src/provider-health.js';

const now = new Date('2026-06-07T12:30:00.000Z');

const report: IntegrationDoctorReport = {
  generatedAt: now.toISOString(),
  summary: {
    total: 2,
    healthy: 0,
    actionNeeded: 1,
    needsProof: 1,
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
      detail: 'Transport ready; proof stale.',
    },
  ],
  secretsRedacted: true,
};

const provider: ProviderHealthSnapshot = {
  providerId: 'anthropic_cloud',
  kind: 'llm',
  state: 'externally_blocked',
  lastHealthyAt: null,
  lastCheckedAt: now.toISOString(),
  failureClass: 'quota_or_rate_limit',
  quotaState: 'blocked',
  credentialState: 'configured',
  knownExpiresAt: null,
  rotationDueAt: null,
  blocker: 'quota blocked',
  nextAction: 'Wait for provider quota recovery.',
  metadata: {},
};

async function main(): Promise<void> {
  initDatabase();
  const blue = await runIntegrationRepair({
    id: 'bluebubbles',
    dryRun: true,
    apply: false,
    now,
    report,
    providers: [provider],
  });
  assert.equal(blue.playbookId, 'bluebubbles_refresh_all');
  assert.equal(blue.status, 'planned');
  assert.equal(blue.dryRun, true);

  const quota = await runIntegrationRepair({
    id: 'provider:anthropic_cloud',
    dryRun: false,
    apply: true,
    now,
    report,
    providers: [provider],
  });
  assert.equal(quota.playbookId, 'provider_quota_cooldown_record');
  assert.equal(quota.status, 'cooldown');
  assert.ok(quota.cooldownUntil);

  const doctor = buildRepairDoctorReport(now);
  assert.ok(doctor.attempts.length >= 2);
  assert.ok(doctor.cooldowns.some((item) => item.targetId === 'provider:anthropic_cloud'));
  console.log('repair tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
