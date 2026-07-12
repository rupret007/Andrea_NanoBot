import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _closeDatabase,
  _initTestDatabase,
  listReliabilityObservations,
  listToolReliabilityRollups,
  upsertReliabilityObservation,
} from './db.js';
import type { IntegrationDoctorReport } from './integration-doctor.js';
import type { ProviderHealthSnapshot } from './provider-health.js';
import { writeProviderLiveHealthState } from './provider-live-health-state.js';
import {
  rebuildToolReliabilityRollups,
  recordVerifiedUsageReliability,
  refreshToolReliabilityFromCurrentTruth,
  resolveToolReliabilityRefreshIntervalMs,
  scoreRouteCandidate,
} from './tool-reliability.js';
import type { ReliabilityObservation } from './types.js';

const PRIVACY = JSON.stringify({
  metadataOnly: true,
  rawPromptsStored: false,
  rawPrivateBodiesStored: false,
  hiddenReasoningStored: false,
  secretsRedacted: true,
});

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tool-reliability-provider-'));
  tempRoots.push(root);
  return root;
}

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
  afterEach(() => {
    _closeDatabase();
    vi.unstubAllEnvs();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('preserves fresh verified provider use across configuration-only refreshes and expires it conservatively', async () => {
    const usedAt = new Date('2026-07-12T09:30:00.000Z');
    recordVerifiedUsageReliability({
      subjectIds: ['provider:openai_cloud'],
      observedAt: usedAt.toISOString(),
      outcome: 'success',
      summary: 'OpenAI completed a verified research request.',
      evidenceRef: 'openai_usage:research',
    });
    const unknownProvider = {
      providerId: 'openai_cloud',
      kind: 'llm' as const,
      state: 'unknown' as const,
      lastHealthyAt: null,
      lastCheckedAt: usedAt.toISOString(),
      failureClass: 'none' as const,
      quotaState: 'unknown' as const,
      credentialState: 'configured' as const,
      knownExpiresAt: null,
      rotationDueAt: null,
      blocker: '',
      nextAction: '',
      metadata: { healthEvidence: 'configuration_only' },
    };

    const fiveMinutesLater = new Date(usedAt.getTime() + 5 * 60_000);
    await refreshToolReliabilityFromCurrentTruth({
      now: fiveMinutesLater,
      providers: [unknownProvider],
      integrationReport: healthyIntegrationReport(
        fiveMinutesLater.toISOString(),
      ),
    });
    expect(
      listReliabilityObservations({
        subjectId: 'provider:openai_cloud',
        limit: 1,
      })[0],
    ).toMatchObject({ sourceKind: 'verified_usage', outcome: 'success' });
    expect(
      listToolReliabilityRollups({ limit: 100 }).find(
        (rollup) => rollup.subjectId === 'provider:openai_cloud',
      ),
    ).toMatchObject({ currentHealth: 'healthy', confidenceCap: 0.95 });

    const sevenHoursLater = new Date(usedAt.getTime() + 7 * 60 * 60_000);
    await refreshToolReliabilityFromCurrentTruth({
      now: sevenHoursLater,
      providers: [unknownProvider],
      integrationReport: healthyIntegrationReport(
        sevenHoursLater.toISOString(),
      ),
    });
    expect(
      listToolReliabilityRollups({ limit: 100 }).find(
        (rollup) => rollup.subjectId === 'provider:openai_cloud',
      ),
    ).toMatchObject({ currentHealth: 'unknown', confidenceCap: 0.5 });
  });

  it('reconciles a recent redacted live probe into the default provider reliability refresh', async () => {
    const root = tempRoot();
    const probedAt = '2026-07-12T09:30:00.000Z';
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    writeProviderLiveHealthState(
      [
        {
          providerId: 'openai_cloud',
          kind: 'llm',
          state: 'healthy',
          lastHealthyAt: probedAt,
          lastCheckedAt: probedAt,
          failureClass: 'none',
          quotaState: 'unknown',
          credentialState: 'configured',
          knownExpiresAt: null,
          rotationDueAt: null,
          blocker: '',
          nextAction: '',
          metadata: {
            healthEvidence: 'live_probe',
            liveProbe: 'ok',
            liveModel: 'gpt-test',
          },
        } satisfies ProviderHealthSnapshot,
      ],
      probedAt,
      root,
    );

    await refreshToolReliabilityFromCurrentTruth({
      now: new Date('2026-07-12T09:35:00.000Z'),
      integrationReport: healthyIntegrationReport('2026-07-12T09:35:00.000Z'),
      projectRoot: root,
    });

    expect(
      listReliabilityObservations({
        subjectId: 'provider:openai_cloud',
        limit: 1,
      })[0],
    ).toMatchObject({
      sourceKind: 'provider_health',
      outcome: 'success',
      failureClass: 'none',
    });
    expect(
      listToolReliabilityRollups({ limit: 100 }).find(
        (rollup) => rollup.subjectId === 'provider:openai_cloud',
      ),
    ).toMatchObject({ currentHealth: 'healthy', confidenceCap: 0.95 });
  });

  it('does not let an older cached healthy probe overwrite newer verified failure evidence', async () => {
    const root = tempRoot();
    const probedAt = '2026-07-12T09:30:00.000Z';
    vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
    writeProviderLiveHealthState(
      [
        {
          providerId: 'openai_cloud',
          kind: 'llm',
          state: 'healthy',
          lastHealthyAt: probedAt,
          lastCheckedAt: probedAt,
          failureClass: 'none',
          quotaState: 'unknown',
          credentialState: 'configured',
          knownExpiresAt: null,
          rotationDueAt: null,
          blocker: '',
          nextAction: '',
          metadata: {
            healthEvidence: 'live_probe',
            liveProbe: 'ok',
            liveModel: 'gpt-test',
          },
        } satisfies ProviderHealthSnapshot,
      ],
      probedAt,
      root,
    );
    recordVerifiedUsageReliability({
      subjectIds: ['provider:openai_cloud'],
      observedAt: '2026-07-12T09:32:00.000Z',
      outcome: 'failed',
      failureClass: 'provider_request_failed',
      summary: 'A newer real provider request failed.',
      nextAction: 'Use a healthy fallback and re-probe before recovery.',
      evidenceRef: 'openai_usage:newer_failure',
    });

    await refreshToolReliabilityFromCurrentTruth({
      now: new Date('2026-07-12T09:35:00.000Z'),
      integrationReport: healthyIntegrationReport('2026-07-12T09:35:00.000Z'),
      projectRoot: root,
    });

    expect(
      listReliabilityObservations({
        subjectId: 'provider:openai_cloud',
        limit: 1,
      })[0],
    ).toMatchObject({
      sourceKind: 'verified_usage',
      outcome: 'failed',
      observedAt: '2026-07-12T09:32:00.000Z',
    });
    expect(
      listToolReliabilityRollups({ limit: 100 }).find(
        (rollup) => rollup.subjectId === 'provider:openai_cloud',
      ),
    ).toMatchObject({ currentHealth: 'blocked', confidenceCap: 0.22 });
  });

  it('lets fresh cited research evidence prove the route without pretending it lasts forever', () => {
    const usedAt = new Date('2026-07-12T09:30:00.000Z');
    upsertReliabilityObservation(
      reliabilityObservation({
        observationId: 'brave-blocked',
        subjectId: 'provider:brave_search',
        observedAt: new Date(usedAt.getTime() - 60_000).toISOString(),
        outcome: 'blocked',
        failureClass: 'quota_or_rate_limit',
      }),
    );
    recordVerifiedUsageReliability({
      subjectIds: ['tool:research', 'route:cognitive_executive.research'],
      observedAt: usedAt.toISOString(),
      outcome: 'success',
      summary: 'Research completed with reviewable source provenance.',
      evidenceRef: 'research_result:openai_responses',
    });

    expect(
      scoreRouteCandidate({
        routeKey: 'cognitive_executive.research',
        baseConfidence: 0.9,
      }),
    ).toMatchObject({ confidence: 0.9, cap: 0.95 });

    rebuildToolReliabilityRollups(new Date(usedAt.getTime() + 7 * 60 * 60_000));
    const expired = scoreRouteCandidate({
      routeKey: 'cognitive_executive.research',
      baseConfidence: 0.9,
    });
    expect(expired.cap).toBeLessThanOrEqual(0.22);
    expect(expired.reasons.join(' ')).toContain('provider:brave_search');
  });

  it('lets an explicit current provider failure supersede recent success immediately', async () => {
    const usedAt = new Date('2026-07-12T09:30:00.000Z');
    recordVerifiedUsageReliability({
      subjectIds: ['provider:openai_cloud'],
      observedAt: usedAt.toISOString(),
      outcome: 'success',
      summary: 'OpenAI completed a verified research request.',
      evidenceRef: 'openai_usage:research',
    });
    const blockedAt = new Date(usedAt.getTime() + 60_000);
    await refreshToolReliabilityFromCurrentTruth({
      now: blockedAt,
      providers: [
        {
          providerId: 'openai_cloud',
          kind: 'llm',
          state: 'externally_blocked',
          lastHealthyAt: usedAt.toISOString(),
          lastCheckedAt: blockedAt.toISOString(),
          failureClass: 'quota_or_rate_limit',
          quotaState: 'blocked',
          credentialState: 'configured',
          knownExpiresAt: null,
          rotationDueAt: null,
          blocker: 'Provider quota is blocked.',
          nextAction: 'Wait for provider quota recovery.',
          metadata: {},
        },
      ],
      integrationReport: healthyIntegrationReport(blockedAt.toISOString()),
    });

    expect(
      listReliabilityObservations({
        subjectId: 'provider:openai_cloud',
        limit: 1,
      })[0],
    ).toMatchObject({
      sourceKind: 'provider_health',
      outcome: 'blocked',
      failureClass: 'quota_or_rate_limit',
    });
    expect(
      listToolReliabilityRollups({ limit: 100 }).find(
        (rollup) => rollup.subjectId === 'provider:openai_cloud',
      ),
    ).toMatchObject({ currentHealth: 'blocked', confidenceCap: 0.22 });
  });
});
