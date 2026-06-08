import assert from 'node:assert/strict';

import { buildCognitiveWorldSnapshot } from '../src/cognitive-executive.js';
import { _closeDatabase, _initTestDatabase } from '../src/db.js';
import type { IntegrationDoctorReport } from '../src/integration-doctor.js';

_initTestDatabase();

const now = new Date('2026-06-07T11:20:00.000Z');
const integrationReport: IntegrationDoctorReport = {
  generatedAt: now.toISOString(),
  summary: {
    total: 2,
    healthy: 1,
    actionNeeded: 0,
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
      lastHealthyAt: now.toISOString(),
      lastFailure: '',
      blockerOwner: 'none',
      nextAction: 'Use fresh read proof.',
      repairability: 'status_only',
      safeActions: [],
      detail: 'Healthy.',
    },
    {
      integrationId: 'bluebubbles',
      label: 'BlueBubbles',
      state: 'needs_proof',
      credentialState: 'configured',
      transportState: 'healthy',
      proofState: 'needs_proof',
      lastHealthyAt: null,
      lastFailure: 'Message-action proof missing.',
      blockerOwner: 'manual',
      nextAction: 'Complete same-thread proof.',
      repairability: 'proof_drill',
      safeActions: [],
      detail: 'Proof debt.',
    },
  ],
  secretsRedacted: true,
};

const { snapshot, items } = buildCognitiveWorldSnapshot({
  groupFolder: 'main',
  intentFamily: 'next_action',
  selectedWork: {
    title: 'Andrea Cognitive Executive',
    statusLabel: 'active',
    reason: 'current work',
  },
  integrationReport,
  now,
});

assert.equal(snapshot.status, 'needs_verification');
assert.ok(snapshot.currentFocus.includes('Andrea Cognitive Executive'));
assert.ok(items.some((item) => item.itemKind === 'selected_work'));
assert.ok(items.some((item) => item.itemKind === 'integration'));
assert.ok(JSON.parse(snapshot.usedItemIdsJson).length >= 1);
assert.equal(JSON.parse(snapshot.privacyJson).metadataOnly, true);

const serialized = JSON.stringify({ snapshot, items });
assert.doesNotMatch(serialized, /raw private body|hidden reasoning|sk-|AIza/i);

console.log(
  JSON.stringify(
    {
      status: 'pass',
      snapshotId: snapshot.snapshotId,
      snapshotStatus: snapshot.status,
      itemKinds: items.map((item) => item.itemKind),
      nextAction: snapshot.nextAction,
    },
    null,
    2,
  ),
);

_closeDatabase();
