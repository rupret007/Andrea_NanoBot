import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listReliabilityObservations,
  listToolReliabilityRollups,
  upsertReliabilityObservation,
} from './db.js';
import type { IntegrationDoctorReport } from './integration-doctor.js';
import {
  refreshToolReliabilityFromCurrentTruth,
  resolveToolReliabilityRefreshIntervalMs,
} from './tool-reliability.js';
import type { ReliabilityObservation } from './types.js';

const PRIVACY = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

function reliabilityObservation(
  overrides: Partial<ReliabilityObservation>,
): ReliabilityObservation {
  return {
    observationId: 'observation-default',
    subjectId: 'integration:bluebubbles',
    observedAt: '2026-07-12T09:30:00.000Z',
    sourceKind: 'integration_doctor',
    outcome: 'success',
    failureClass: 'healthy',
    confidence: 0.95,
    fallbackUsed: false,
    latencyMs: null,
    summary: 'BlueBubbles: healthy.',
    nextAction: '',
    evidenceIdsJson: '[]',
    privacyJson: PRIVACY,
    ...overrides,
  };
}

function healthyIntegrationReport(
  generatedAt: string,
): IntegrationDoctorReport {
  const healthyStatus = {
    state: 'healthy' as const,
    credentialState: 'configured' as const,
    transportState: 'healthy' as const,
    proofState: 'healthy' as const,
    lastHealthyAt: generatedAt,
    lastFailure: '',
    blockerOwner: 'none' as const,
    nextAction: '',
    repairability: 'status_only' as const,
    safeActions: [] as string[],
  };
  return {
    generatedAt,
    summary: {
      total: 2,
      healthy: 2,
      actionNeeded: 0,
      needsProof: 0,
      manualOrExternal: 0,
    },
    statuses: [
      {
        integrationId: 'bluebubbles',
        label: 'BlueBubbles',
        detail: 'Transport and same-thread proof are healthy.',
        ...healthyStatus,
      },
      {
        integrationId: 'google_calendar',
        label: 'Google Calendar',
        detail: 'Read/write proof is healthy.',
        ...healthyStatus,
      },
    ],
    secretsRedacted: true,
  };
}

describe('tool reliability truth refresh', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('uses insertion order to resolve equal-timestamp observations deterministically', () => {
    const observedAt = '2026-07-12T09:30:00.000Z';
    upsertReliabilityObservation(
      reliabilityObservation({
        observationId: 'repair-first',
        observedAt,
        sourceKind: 'repair',
        outcome: 'degraded',
        failureClass: 'proof_stale',
      }),
    );
    upsertReliabilityObservation(
      reliabilityObservation({
        observationId: 'current-truth-second',
        observedAt,
      }),
    );

    expect(
      listReliabilityObservations({
        subjectId: 'integration:bluebubbles',
        limit: 2,
      }).map((observation) => observation.observationId),
    ).toEqual(['current-truth-second', 'repair-first']);
  });

  it('recovers proven tools and bounds unchanged status heartbeats', async () => {
    const firstAt = new Date('2026-07-12T09:30:00.000Z');
    await refreshToolReliabilityFromCurrentTruth({
      now: firstAt,
      providers: [],
      integrationReport: healthyIntegrationReport(firstAt.toISOString()),
    });

    const rollups = listToolReliabilityRollups({ limit: 100 });
    expect(
      rollups.find((rollup) => rollup.subjectId === 'tool:message_actions'),
    ).toMatchObject({
      currentHealth: 'healthy',
      confidenceCap: 0.95,
      nextAction: '',
    });
    expect(
      rollups.find((rollup) => rollup.subjectId === 'tool:calendar'),
    ).toMatchObject({ currentHealth: 'healthy', confidenceCap: 0.95 });
    expect(
      listReliabilityObservations({
        subjectId: 'integration:bluebubbles',
        limit: 20,
      }),
    ).toHaveLength(1);

    const fiveMinutesLater = new Date(firstAt.getTime() + 5 * 60_000);
    await refreshToolReliabilityFromCurrentTruth({
      now: fiveMinutesLater,
      providers: [],
      integrationReport: healthyIntegrationReport(
        fiveMinutesLater.toISOString(),
      ),
    });
    expect(
      listReliabilityObservations({
        subjectId: 'integration:bluebubbles',
        limit: 20,
      }),
    ).toHaveLength(1);

    const sevenHoursLater = new Date(firstAt.getTime() + 7 * 60 * 60_000);
    await refreshToolReliabilityFromCurrentTruth({
      now: sevenHoursLater,
      providers: [],
      integrationReport: healthyIntegrationReport(
        sevenHoursLater.toISOString(),
      ),
    });
    expect(
      listReliabilityObservations({
        subjectId: 'integration:bluebubbles',
        limit: 20,
      }),
    ).toHaveLength(2);
  });

  it('uses a bounded periodic refresh interval', () => {
    expect(resolveToolReliabilityRefreshIntervalMs(1)).toBe(5 * 60_000);
    expect(resolveToolReliabilityRefreshIntervalMs(30)).toBe(30 * 60_000);
    expect(resolveToolReliabilityRefreshIntervalMs(Number.NaN)).toBe(
      30 * 60_000,
    );
  });
});
