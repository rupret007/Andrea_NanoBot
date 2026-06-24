import assert from 'assert/strict';

import { _closeDatabase, _initTestDatabase, createTask } from '../src/db.js';
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
  _initTestDatabase();
  const report = await refreshToolReliabilityFromCurrentTruth({
    now,
    providers: [provider],
    integrationReport,
  });
  assert.equal(report.privacy.metadataOnly, true);
  const doctor = buildToolReliabilityDoctorReport(now);
  assert.ok(
    doctor.subjects.some((item) => item.subjectId === 'provider:brave_search'),
  );
  const braveRollup = doctor.rollups.find(
    (item) => item.subjectId === 'provider:brave_search',
  );
  assert.equal(braveRollup?.currentHealth, 'blocked');
  const scored = scoreRouteCandidate({
    routeKey: 'cognitive_executive.research',
    baseConfidence: 0.9,
  });
  assert.ok(
    scored.confidence <= 0.58,
    `expected capped confidence, got ${scored.confidence}`,
  );
  assert.ok(scored.reasons.join(' ').includes('provider:brave_search'));

  createTask({
    id: 'task-tool-reliability-reminder-proof',
    group_folder: 'main',
    chat_jid: 'tg:main',
    prompt: 'Reminder: check the oven before leaving.',
    script: null,
    schedule_type: 'once',
    schedule_value: now.toISOString(),
    context_mode: 'isolated',
    next_run: now.toISOString(),
    status: 'active',
    created_at: now.toISOString(),
  });
  const reminderNow = new Date(now.getTime() + 30_000);
  await refreshToolReliabilityFromCurrentTruth({
    now: reminderNow,
    providers: [provider],
    integrationReport,
  });
  const splitDoctor = buildToolReliabilityDoctorReport(reminderNow);
  assert.ok(
    splitDoctor.subjects.some((item) => item.subjectId === 'tool:reminders'),
  );
  const messageActions = splitDoctor.rollups.find(
    (item) => item.subjectId === 'tool:message_actions',
  );
  const reminders = splitDoctor.rollups.find(
    (item) => item.subjectId === 'tool:reminders',
  );
  assert.equal(messageActions?.currentHealth, 'degraded');
  assert.equal(reminders?.currentHealth, 'healthy');

  const healthyNow = new Date(now.getTime() + 60_000);
  await refreshToolReliabilityFromCurrentTruth({
    now: healthyNow,
    providers: [
      {
        ...provider,
        state: 'healthy',
        lastHealthyAt: healthyNow.toISOString(),
        lastCheckedAt: healthyNow.toISOString(),
        failureClass: 'none',
        quotaState: 'unknown',
        blocker: '',
        nextAction: '',
      },
    ],
    integrationReport: {
      generatedAt: healthyNow.toISOString(),
      summary: {
        total: 3,
        healthy: 3,
        actionNeeded: 0,
        needsProof: 0,
        manualOrExternal: 0,
      },
      statuses: [
        {
          ...integrationReport.statuses[0],
          state: 'healthy',
          proofState: 'healthy',
          lastHealthyAt: healthyNow.toISOString(),
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
          lastHealthyAt: healthyNow.toISOString(),
          lastFailure: '',
          blockerOwner: 'none',
          nextAction: '',
          repairability: 'status_only',
          safeActions: [],
          detail: 'Google Calendar is healthy.',
        },
        {
          integrationId: 'telegram',
          label: 'Telegram',
          state: 'healthy',
          credentialState: 'configured',
          transportState: 'healthy',
          proofState: 'healthy',
          lastHealthyAt: healthyNow.toISOString(),
          lastFailure: '',
          blockerOwner: 'none',
          nextAction: '',
          repairability: 'status_only',
          safeActions: [],
          detail: 'Telegram is healthy.',
        },
      ],
      secretsRedacted: true,
    },
  });
  const healthyDoctor = buildToolReliabilityDoctorReport(healthyNow);
  const degradedIds = healthyDoctor.topDegraded.map((item) => item.subjectId);
  for (const subjectId of [
    'tool:calendar',
    'tool:message_actions',
    'tool:research',
    'route:cognitive_executive.daily_companion',
    'route:cognitive_executive.communication_companion',
    'route:cognitive_executive.everyday_capture',
    'route:cognitive_executive.research',
  ]) {
    assert.ok(
      !degradedIds.includes(subjectId),
      `${subjectId} should not stay degraded when its live dependency is healthy`,
    );
  }
  _closeDatabase();
  console.log('tool reliability tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
